#!/usr/bin/env node
/**
 * Fear-gauge baselines -> public/data/fear-baselines.json (daily).
 * One year of daily closes per input, plus the derived series, so a live
 * request needs only the latest quote to score a percentile.
 * Yahoo v8 chart (keyless, server-side). No LLM. Runs in data-daily.
 * Spec: druP3 outputs-local/2026-11-25-v2-fear-sentiment.md sections 3 and 7.2.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const tone = require('./lib/tone.cjs');

const OUT = path.join(__dirname, '..', 'public', 'data', 'fear-baselines.json');

function get(p) {
  return new Promise((resolve, reject) => {
    https.get({ hostname: 'query1.finance.yahoo.com', path: p, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => (res.statusCode === 200 ? resolve(d) : reject(new Error('HTTP ' + res.statusCode + ' ' + p))));
    }).on('error', reject);
  });
}

// returns [{ d: 'YYYY-MM-DD', c: close }] oldest first
async function daily(sym) {
  const raw = await get('/v8/finance/chart/' + encodeURIComponent(sym) + '?range=1y&interval=1d');
  const r = JSON.parse(raw).chart.result[0];
  const ts = r.timestamp || [], cl = r.indicators.quote[0].close || [];
  const out = [];
  ts.forEach((t, i) => { if (cl[i] != null && isFinite(cl[i])) out.push({ d: new Date(t * 1000).toISOString().slice(0, 10), c: cl[i] }); });
  return out;
}

const r3 = (x) => Math.round(x * 1e4) / 1e4;
const closes = (a) => a.map((x) => x.c);
function median(a) { const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

async function main() {
  const syms = ['^VIX', '^OVX', '^VXN', '^GVZ', '^MOVE', '^SOX', 'BZ=F', 'HYG', 'IEF'];
  const got = {};
  await Promise.all(syms.map(async (s) => { try { got[s] = await daily(s); } catch (e) { console.error(s + ' failed: ' + e.message); } }));

  const series = {}, ref = {}, counts = {};
  [['vix', '^VIX'], ['ovx', '^OVX'], ['vxn', '^VXN'], ['gvz', '^GVZ'], ['move', '^MOVE']].forEach(([k, s]) => {
    if (got[s]) series[k] = closes(got[s]).map(r3);
  });
  if (got.HYG && got.IEF) {
    const ief = new Map(got.IEF.map((x) => [x.d, x.c]));
    series.credit = got.HYG.filter((x) => ief.has(x.d)).map((x) => r3(x.c / ief.get(x.d)));
  }
  if (got['^SOX']) {
    const c = closes(got['^SOX']);
    let hi = -Infinity;
    series.sox_dd = c.map((v) => { hi = Math.max(hi, v); return r3(1 - v / hi); });
    series.sox_mom = c.slice(20).map((v, i) => r3(v / c[i] - 1));
    ref.sox_hi = Math.max(...c);
    ref.sox_20d = c[c.length - 21];   // close 20 trading days before the latest bar
  }
  if (got['BZ=F']) {
    const c = closes(got['BZ=F']);
    series.brent_prem = c.slice(120).map((v, i) => r3(v / median(c.slice(i, i + 120))));
    ref.brent_med120 = median(c.slice(-120));
  }
  Object.keys(series).forEach((k) => { counts[k] = series[k].length; });
  if (!Object.keys(series).length) throw new Error('no series fetched; keeping previous file');

  const out = {
    version: tone.VERSION,
    updated: new Date().toISOString(),
    window: 252,
    series, ref, counts,
    short_window: ['brent_prem'],
    weights: tone.WEIGHTS,
    label_bands: tone.BANDS,
    hysteresis: 3
  };
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log('fear-baselines: ' + Object.keys(series).map((k) => k + ' ' + counts[k]).join(', '));
}

main().catch((e) => { console.error('fear baselines failed: ' + e.message); process.exit(1); });
