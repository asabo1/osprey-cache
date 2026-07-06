#!/usr/bin/env node
/**
 * Reconstruct the FULL crisis event history from git.
 *
 * The live daily.json event_log holds a rolling 50 entries (~2-3 days), but
 * every intel cron committed a snapshot — the whole 2026 Hormuz-crisis event
 * record lives across ~1,100 daily.json revisions. This walks main's history,
 * harvests every event_log entry, dedupes (exact key, then wire-core
 * same-story clustering within a day), and writes
 * data-archive/event-archive.json — the data spine for the crisis timeline
 * page and a durable asset regardless (scorecards, retrospectives).
 *
 * APPEND-ONLY (2026-07-03 fix): archived events pass through verbatim and are
 * never re-clustered. The original design re-clustered the whole archive every
 * run; clustering is not idempotent, so each nightly CI pass merged more
 * representatives and the count silently shrank (3,817 -> 3,677 on Jul 3) —
 * and shrank differently by environment, since the CI checkout is shallow
 * (fetch-depth 1: rev-list sees ~1 revision there, so CI only appends the
 * current rolling event_log; that is sufficient to keep it current). New
 * events are gated instead: one is appended only if it does not same-story
 * cluster with that day's already-archived events (so retellings still stay
 * out, but the record never rewrites itself). A tripwire refuses to write a
 * smaller archive. Cost of durability: an archived story keeps its
 * first-archived text/severity; later retellings no longer replace it.
 * Usage: node scripts/build-event-archive.cjs [--since 2026-02-01]
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const wireCore = require('./lib/wire-core.cjs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data-archive', 'event-archive.json');

function sh(args) {
  return execFileSync('git', args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString();
}

function main() {
  const sinceArg = process.argv.indexOf('--since');
  const since = sinceArg >= 0 ? process.argv[sinceArg + 1] : '2026-02-01';

  let existing = { events: [] };
  try { existing = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch {}
  const archived = (existing.events || []).slice(); // verbatim; never re-clustered
  const byKey = new Map();
  const keyOf = (e) => (e.date_iso || '').slice(0, 10) + '|' + String(e.text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60);
  for (const e of archived) byKey.set(keyOf(e), e);
  const before = archived.length;

  // Every commit that touched daily.json on main, oldest first. event_log
  // holds ~50 entries (~2-3 days) per snapshot, so sampling every 10th commit
  // (~30 commits/day) still overlaps heavily; full walk is only worth it on
  // the first mine.
  const revs = sh(['rev-list', '--reverse', '--since=' + since, 'main', '--', 'public/data/daily.json'])
    .trim().split('\n').filter(Boolean);
  const step = revs.length > 400 ? Math.ceil(revs.length / 400) : 1;
  console.log(revs.length + ' revisions, sampling every ' + step);

  const fresh = [];
  for (let i = 0; i < revs.length; i += step) {
    let doc;
    try { doc = JSON.parse(sh(['show', revs[i] + ':public/data/daily.json'])); } catch { continue; }
    for (const e of doc.event_log || doc.events || []) {
      if (!e || !e.text || !e.date_iso) continue;
      const k = keyOf(e);
      if (byKey.has(k)) continue;
      const norm = { date_iso: e.date_iso, severity: e.severity || e.sev || 'INFO', text: String(e.text).trim(), link: e.link || '' };
      byKey.set(k, norm);
      fresh.push(norm);
    }
  }

  // Same-story gate: a fresh event enters the archive only if it does NOT
  // cluster with that day's already-archived (or already-accepted) stories.
  // cluster() places an item into the first matching cluster and can never
  // merge two clusters, so the day's cluster count moves by exactly 0
  // (absorbed = retelling, drop) or +1 (new story, append). Archived events
  // themselves are never touched.
  const DAY_MS = 24 * 3600 * 1000;
  const toItem = (e) => ({ text: e.text, date: e.date_iso, severity: e.severity, link: e.link });
  const dayItems = new Map();
  for (const e of archived) {
    const d = e.date_iso.slice(0, 10);
    if (!dayItems.has(d)) dayItems.set(d, []);
    dayItems.get(d).push(toItem(e));
  }
  fresh.sort((a, b) => new Date(a.date_iso) - new Date(b.date_iso)); // earliest keeps break credit
  const dayBase = new Map();
  const added = [];
  let dropped = 0;
  for (const e of fresh) {
    const d = e.date_iso.slice(0, 10);
    if (!dayItems.has(d)) dayItems.set(d, []);
    const items = dayItems.get(d);
    if (!dayBase.has(d)) dayBase.set(d, items.length ? wireCore.cluster(items, DAY_MS).length : 0);
    const test = wireCore.cluster(items.concat([toItem(e)]), DAY_MS).length;
    if (test <= dayBase.get(d)) { dropped++; continue; }
    items.push(toItem(e));
    dayBase.set(d, test);
    added.push(e);
  }

  const events = archived.concat(added).sort((a, b) => new Date(a.date_iso) - new Date(b.date_iso));

  // Monotonicity tripwire: this is a durable public record — refuse to write
  // a smaller one (throw-before-write, same pattern as fetch-wpsr). The
  // workflow step is || guarded, so throwing surfaces in the log without
  // killing the run; the stale-but-intact archive stays in place.
  if (events.length < before) {
    throw new Error('archive would shrink: ' + before + ' -> ' + events.length + '; refusing to write');
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ generated: new Date().toISOString(), since, count: events.length, events }, null, 1));
  const days = new Set(events.map((e) => e.date_iso.slice(0, 10)));
  console.log('archive: ' + events.length + ' events across ' + days.size + ' days (' + before + ' archived kept, ' + added.length + ' appended, ' + dropped + ' same-story retellings gated out)');
  if (events.length) console.log('span: ' + events[0].date_iso.slice(0, 10) + ' -> ' + events[events.length - 1].date_iso.slice(0, 10));
}

main();
