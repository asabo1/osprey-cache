#!/usr/bin/env node
/**
 * EIA Weekly Petroleum Status Report -> public/data/wpsr.json.
 *
 * Sources, fastest first:
 *  - ir.eia.gov/wpsr/table1.csv — the RELEASE SERVER, live at 10:30 ET
 *    Wednesday sharp (302s to a CloudFront-signed URL; plain redirect-follow
 *    works). This is the fast path the racer polls.
 *  - api.eia.gov v2 — 52-week history backfill only. Our racer measured the
 *    v2 API surfacing the weekly print ~3 HOURS after release (both weeks
 *    logged), so it is never used for the headline number.
 *
 * The interpretive take is generated keylessly via GitHub Models (same
 * pattern as wire-synthesis) ONLY when a new period lands. HONESTY RULE: we
 * carry no consensus/forecast data, so the take never claims "vs expectations"
 * — it reads the print against the prior weeks we actually have.
 *
 * Usage: node scripts/fetch-wpsr.cjs            full refresh (table1 + history + take)
 *        node scripts/fetch-wpsr.cjs --fast     table1 only (racer fast path)
 */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'public', 'data', 'wpsr.json');
const TABLE1 = 'https://ir.eia.gov/wpsr/table1.csv';
const MODEL = process.env.SYNTH_MODEL || 'openai/gpt-4.1';

// Federal holidays that shift the Wednesday 10:30 ET release to Thursday
// (EIA shifts when a holiday falls Mon-Wed of the release week). Refresh
// annually from eia.gov/petroleum/supply/weekly/schedule.php.
const RELEASE_SHIFTS = { '2026-09-09': '2026-09-10', '2026-11-11': '2026-11-12' };

function parseCsvLine(line) {
  return (line.match(/"([^"]*)"/g) || []).map((c) => c.slice(1, -1));
}

function num(s) {
  const n = parseFloat(String(s).replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

function mdyToIso(mdy) {
  const m = String(mdy).match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (!m) return null;
  return '20' + m[3] + '-' + String(m[1]).padStart(2, '0') + '-' + String(m[2]).padStart(2, '0');
}

async function fetchTable1() {
  const res = await fetch(TABLE1, { headers: { 'User-Agent': 'CrudeSignal/1.0 (+https://crudesignal.io)' } });
  if (!res.ok) throw new Error('table1.csv HTTP ' + res.status);
  const text = await res.text();
  const lines = text.trim().split('\n');
  const head = parseCsvLine(lines[0]);
  const period = mdyToIso(head[1]);
  const prior = mdyToIso(head[2]);
  if (!period) throw new Error('table1.csv: could not parse period from header: ' + lines[0].slice(0, 80));

  const wanted = {
    'Commercial (Excluding SPR)': 'crude',
    'Strategic Petroleum Reserve (SPR)': 'spr',
    'Total Motor Gasoline': 'gasoline',
    'Distillate Fuel Oil': 'distillate',
    'Kerosene-Type Jet Fuel': 'jet',
    'Total Stocks (Excluding SPR)': 'total_ex_spr',
  };
  const out = { period, prior };
  for (const line of lines.slice(1)) {
    const c = parseCsvLine(line);
    const key = wanted[c[0]];
    if (!key) continue;
    out[key] = {
      level: num(c[1]),          // million barrels
      prior: num(c[2]),
      delta: num(c[3]),
      pct: num(c[4]),
      yoy_delta: num(c[6]),
    };
  }
  if (!out.crude || out.crude.level == null) throw new Error('table1.csv: crude ex-SPR row missing');
  return out;
}

async function fetchHistory() {
  const key = process.env.EIA_API_KEY;
  if (!key) return null;
  const url = 'https://api.eia.gov/v2/petroleum/stoc/wstk/data/?api_key=' + key +
    '&frequency=weekly&data%5B0%5D=value&facets%5Bseries%5D%5B%5D=WCESTUS1' +
    '&sort%5B0%5D%5Bcolumn%5D=period&sort%5B0%5D%5Bdirection%5D=desc&length=56';
  const res = await fetch(url);
  if (!res.ok) return null;
  const j = await res.json();
  const rows = (j.response && j.response.data) || [];
  const hist = rows.map((r) => ({ period: r.period, level: +(Number(r.value) / 1000).toFixed(3) })); // kb -> Mb
  for (let i = 0; i < hist.length - 1; i++) hist[i].delta = +(hist[i].level - hist[i + 1].level).toFixed(3);
  return hist.slice(0, 52);
}

function nextRelease(fromMs) {
  // Next release Wednesday (10:30 ET), honoring the static holiday-shift map.
  // d=0 handles release-day-morning runs (daily-fetch fires 05:00 UTC
  // Wednesday, hours BEFORE the 10:30 ET/14:30 UTC print — "next report" is
  // today, not next week); after ~15:00 UTC the release is out and next week
  // is correct.
  for (let d = 0; d <= 14; d++) {
    const cand = new Date(fromMs + d * 86400000);
    const iso = cand.toISOString().split('T')[0];
    if (cand.getUTCDay() !== 3) continue;
    const release = RELEASE_SHIFTS[iso] || iso;
    // 16:00 UTC cutoff covers both EDT (14:30 release) and EST (15:30):
    // before it, release day still shows as "today"; after, roll to next week.
    if (d === 0 && new Date(fromMs).toISOString().slice(11, 16) >= '16:00' && release === iso) continue;
    return release;
  }
  return null;
}

async function generateTake(t1, history, prevTake) {
  if (!process.env.GITHUB_TOKEN) return null;
  const recent = (history || []).filter((h) => h.delta != null && h.period !== t1.period).slice(0, 8)
    .map((h) => h.period + ': ' + (h.delta > 0 ? '+' : '') + h.delta + 'M');
  // Fabrication guard: an early test run invented "second consecutive draw"
  // and a distillate streak with NO history provided. Streak language is only
  // allowed for crude and only from the PRIOR WEEKS lines actually given.
  const sys = 'You write one interpretive note (max 55 words, 2 sentences) on the weekly EIA petroleum inventory print for an oil-market wire. Plain language, terse, no hype, no double-dashes. NEVER compare to "expectations" or "forecasts" (you have none). Streak/"consecutive"/trend claims are allowed ONLY for crude and ONLY when supported by the PRIOR WEEKS lines; with no prior weeks provided, describe this week only. Gasoline/distillates/SPR: this week\'s direction and size only, never their history. Return JSON: {"take":"..."}';
  const user = 'PRINT week ending ' + t1.period + ': crude ex-SPR ' + (t1.crude.delta > 0 ? 'build +' : 'draw ') + t1.crude.delta + 'M to ' + t1.crude.level + 'M (vs a year ago: ' + t1.crude.yoy_delta + 'M); gasoline ' + t1.gasoline.delta + 'M; distillates ' + t1.distillate.delta + 'M; SPR ' + t1.spr.delta + 'M.\n' +
    (recent.length ? 'PRIOR WEEKS (crude delta, newest first): ' + recent.join(', ') : 'PRIOR WEEKS: none provided.');
  try {
    const res = await fetch('https://models.github.ai/inference/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.GITHUB_TOKEN },
      body: JSON.stringify({ model: MODEL, max_tokens: 200, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const take = JSON.parse(j.choices[0].message.content).take;
    return typeof take === 'string' && take.length > 20 ? take.replace(/\s*[—–]\s*/g, ', ') : null;
  } catch (e) {
    console.error('take generation failed (non-fatal): ' + e.message);
    return prevTake || null;
  }
}

async function main() {
  const fast = process.argv.includes('--fast');
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch {}

  const t1 = await fetchTable1();
  const isNewPeriod = existing.period !== t1.period;

  let history = existing.history || null;
  let take = existing.take || null;
  if (!fast) {
    history = (await fetchHistory().catch(() => null)) || history;
    if (isNewPeriod || !take) take = await generateTake(t1, history, take);
  }

  const out = {
    updated: new Date().toISOString(),
    ...t1,
    take: take,
    take_period: take ? (isNewPeriod && !fast ? t1.period : existing.take_period || t1.period) : null,
    history: history,
    next_release: nextRelease(Date.now()),
    source: 'EIA Weekly Petroleum Status Report',
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log('wpsr.json: week ending ' + t1.period + ', crude ' + (t1.crude.delta > 0 ? '+' : '') + t1.crude.delta + 'M' + (isNewPeriod ? ' (NEW PERIOD)' : '') + (fast ? ' [fast]' : ''));
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
