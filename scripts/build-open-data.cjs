#!/usr/bin/env node
/**
 * Crude Signal Open Data -> public/data/open/*.{csv,json} + manifest.
 *
 * The citable artifact strategy (researched 2026-07-02): straits.live already
 * publishes a mature raw-transit dataset — duplicating it earns nothing. What
 * nobody publishes is a FORECASTING-PERFORMANCE record: graded calls with
 * pre-registered probabilities, alongside the crisis-score daily history and
 * the sourced event log. CC BY 4.0, stable URLs, cite block on /data.
 * Runs in daily-fetch; public/data/open/ must be in the workflow git-add list.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'data', 'open');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8')); } catch { return null; }
}

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function writeSet(name, rows, columns) {
  fs.mkdirSync(OUT, { recursive: true });
  const csv = [columns.join(',')].concat(
    rows.map((r) => columns.map((c) => csvCell(r[c])).join(','))
  ).join('\n') + '\n';
  fs.writeFileSync(path.join(OUT, name + '.csv'), csv);
  fs.writeFileSync(path.join(OUT, name + '.json'), JSON.stringify({ generated: new Date().toISOString(), license: 'CC BY 4.0', source: 'https://crudesignal.io/data', rows }, null, 1));
  return rows.length;
}

// DELAY-GATE (2026-07-04 reorg, advisor-designed): history stays public,
// CC BY, citable — the reputation asset. The trailing 30 days (the fresh,
// decision-relevant slice) is written to src/data/open-current.json and
// served ONLY through the subscriber-gated route /data/open/current.json.
// Public filenames are unchanged so no external link breaks; they now hold
// history-only. graded-calls is exempt: fully public, always.
const GATE_DAYS = 30;

function main() {
  const daily = readJson('public/data/daily.json') || {};
  const track = readJson('src/data/track-record.json') || [];
  const archive = readJson('data-archive/event-archive.json') || { events: [] };
  const cutoff = new Date(Date.now() - GATE_DAYS * 86400000).toISOString().slice(0, 10);

  // 1. Crisis score daily history (score_method column keeps version honesty:
  //    v2 dates from 2026-06-11; earlier rows used the v1 composite).
  const snaps = (daily.snapshots || []).slice().reverse();
  const crisisAll = snaps.map((s) => ({
    date: s.date, crisis_score: s.crisis_score, brent_usd: s.brent, wti_usd: s.wti,
    brent_wti_spread_usd: s.spread, score_method: s.score_method || 'v1',
  }));
  const n1 = writeSet('crisis-score-daily', crisisAll.filter((r) => r.date < cutoff),
    ['date', 'crisis_score', 'brent_usd', 'wti_usd', 'brent_wti_spread_usd', 'score_method']);

  // 2. Graded calls — the differentiator. Every published call with its
  //    condition, grade, and (W25+) pre-registered probability. Grades are
  //    never edited after publication.
  const calls = Array.isArray(track) ? track : track.calls || [];
  const n2 = writeSet('graded-calls', calls.map((c) => ({
    week: c.week, slug: c.slug, call: c.call, type: c.type, horizon: c.horizon,
    condition: c.condition, probability: c.probability != null ? c.probability : '',
    grade: c.grade, evidence: c.evidence,
  })), ['week', 'slug', 'call', 'type', 'horizon', 'condition', 'probability', 'grade', 'evidence']);

  // 3. Sourced event log (wire reports, de-duplicated, each with its outlet link).
  const eventsAll = (archive.events || []).map((e) => ({
    date_iso: e.date_iso, severity: e.severity, text: e.text, source_link: e.link || '',
  }));
  const n3 = writeSet('events-sourced', eventsAll.filter((r) => (r.date_iso || '').slice(0, 10) < cutoff),
    ['date_iso', 'severity', 'text', 'source_link']);

  // The gated current slice (bundled into the server build; served by the
  // subscriber-gated SSR route, never from public/).
  const current = {
    generated: new Date().toISOString(),
    gate_days: GATE_DAYS,
    license: 'CC BY 4.0 (subscriber early access)',
    crisis_score_daily: crisisAll.filter((r) => r.date >= cutoff),
    events_sourced: eventsAll.filter((r) => (r.date_iso || '').slice(0, 10) >= cutoff),
  };
  fs.writeFileSync(path.join(ROOT, 'src', 'data', 'open-current.json'), JSON.stringify(current, null, 1));

  const manifest = {
    generated: new Date().toISOString(),
    publisher: 'Crude Signal',
    site: 'https://crudesignal.io',
    license: 'CC BY 4.0',
    citation: 'Crude Signal (2026). Crude Signal Open Data: 2026 Strait of Hormuz crisis scores, graded forecasts, and sourced event log. https://crudesignal.io/data',
    datasets: [
      { name: 'crisis-score-daily', rows: n1, csv: '/data/open/crisis-score-daily.csv', json: '/data/open/crisis-score-daily.json', description: 'Daily Hormuz crisis score (0-100) with Brent, WTI, and spread. score_method column marks the composite version. Public file carries history older than 30 days; the trailing 30 days are subscriber early access.' },
      { name: 'graded-calls', rows: n2, csv: '/data/open/graded-calls.csv', json: '/data/open/graded-calls.json', description: 'Every published Crude Signal market call with its falsifiable condition, outcome grade, and (from W25) pre-registered probability. Grades are never edited after publication.' },
      { name: 'events-sourced', rows: n3, csv: '/data/open/events-sourced.csv', json: '/data/open/events-sourced.json', description: 'De-duplicated wire reports from the 2026 Hormuz crisis, each linked to its original outlet. Coverage from 2026-04-01. Public file carries history older than 30 days; the trailing 30 days are subscriber early access.' },
    ],
  };
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
  console.log('open data: crisis ' + n1 + ' public rows, calls ' + n2 + ', events ' + n3 + ' public; current slice ' + current.crisis_score_daily.length + '+' + current.events_sourced.length + ' rows gated');
}

main();
