#!/usr/bin/env node
/**
 * Chips desk daily price collection (keyless, model-free). Writes:
 *   public/data/chip-retail.json            what the page reads (items, spot index, rental)
 *   public/data/chip-retail-backfill.json   WhereIsMyRam 12-month 32GB series, written once
 *   data-archive/chip-retail-log.jsonl      append-only history, one line per item per day
 *                                           (also holds RAW TrendForce prices; never public)
 * Each source fails alone; a failed item keeps its previous record with confidence "stale".
 * Robots: only page paths are requested (never /api/ on gpuprix or gpupoet; the one API path
 * used is Ornn's public daily index, which its robots.txt explicitly allows).
 * Runs in .github/workflows/chip-retail.yml; all three files must stay in its explicit add-list.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'data', 'chip-retail.json');
const BACKFILL = path.join(ROOT, 'public', 'data', 'chip-retail-backfill.json');
const LOG = path.join(ROOT, 'data-archive', 'chip-retail-log.jsonl');
const UA = { 'User-Agent': 'crude-signal research bot (+https://crudesignal.io)' };
const TODAY = new Date().toISOString().slice(0, 10);
const rd = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return d; } };
const prev = rd(OUT, { items: [] });
const r2 = (n) => (n == null || !isFinite(n) ? null : Math.round(n * 100) / 100);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const status = {};

async function get(url, as = 'text') {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(45000), redirect: 'follow' });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
  return as === 'json' ? res.json() : res.text();
}
const textOf = (h) => String(h).replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ');
const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };

// id, gpuprix slug, gpupoet slug (null = not tracked there)
const GPUS = [
  ['rtx-5090', 'geforce-rtx-5090', 'nvidia-geforce-rtx-5090'],
  ['rtx-5080', 'geforce-rtx-5080', 'nvidia-geforce-rtx-5080'],
  ['rtx-5070-ti', 'geforce-rtx-5070-ti', 'nvidia-geforce-rtx-5070-ti'],
  ['rtx-5070', 'geforce-rtx-5070', 'nvidia-geforce-rtx-5070'],
  ['rtx-5060-ti-16gb', 'geforce-rtx-5060-ti-16gb', 'nvidia-geforce-rtx-5060-ti'],
  ['rx-9070-xt', 'radeon-rx-9070-xt', 'amd-radeon-rx-9070-xt'],
  ['rx-9070', 'radeon-rx-9070', 'amd-radeon-rx-9070'],
  ['rx-9060-xt-16gb', 'radeon-rx-9060-xt-16gb', null],
  ['arc-b580', 'arc-b580', 'intel-arc-b580'],
];
const STORE = { 'amazon.com': 'Amazon', 'bestbuy.com': 'Best Buy', 'newegg.com': 'Newegg', 'bhphotovideo.com': 'B&H' };

async function gpuprix(id, slug) {
  const html = await get('https://gpuprix.com/us/gpus/' + slug);
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no __NEXT_DATA__');
  const g = JSON.parse(m[1]).props.pageProps.gpu;
  const launch = g.msrp;
  if (!launch) throw new Error('no msrp');
  const lo = launch * 0.5, hi = launch * 4.5;
  const rows = (g.prices || []).filter((p) => p.region === 'US' && p.currency === 'USD' && p.condition === 'new' && p.price >= lo && p.price <= hi);
  if (!rows.length) throw new Error('no valid US new rows');
  const stock = rows.filter((p) => p.inStock);
  const pool = stock.length ? stock : rows;
  return {
    launch, vram_gb: g.vram, perf_index: g.performanceScore,
    low_new: r2(Math.min(...pool.map((p) => p.price))),
    median_in_stock: r2(median(stock.map((p) => p.price))),
    listings: rows.length, in_stock: stock.length,
    stores: [...new Set(rows.map((p) => STORE[p.store] || p.store))].sort(),
  };
}
async function gpupoet(slug, launch) {
  const t = textOf(await get('https://gpupoet.com/gpu/learn/card/' + slug));
  const m = t.match(/lowest average price is \$\s?([\d,]+(?:\.\d+)?)/i);
  if (!m) throw new Error('no low3 average');
  const v = +m[1].replace(/,/g, '');
  if (v < launch * 0.5 || v > launch * 4.5) throw new Error('out of range ' + v);
  return v;
}

async function runGpus() {
  const items = [];
  for (const [id, slug, poet] of GPUS) {
    const old = (prev.items || []).find((i) => i.id === id);
    const src_ok = { gpuprix: false, gpupoet: false };
    let item = null;
    try { item = await gpuprix(id, slug); src_ok.gpuprix = true; } catch (e) { status['gpuprix:' + id] = 'FAIL ' + e.message; }
    await sleep(2000);
    let low3 = null;
    if (poet) {
      try { low3 = await gpupoet(poet, item ? item.launch : (old && old.launch) || 1000); src_ok.gpupoet = true; } catch (e) { status['gpupoet:' + id] = 'FAIL ' + e.message; }
      await sleep(2000);
    }
    if (!item) {
      if (!old) continue;
      items.push(Object.assign({}, old, { src_ok, confidence: 'stale' }));
      continue;
    }
    let confidence = 'ok';
    if (low3 != null && Math.abs(low3 / item.low_new - 1) > 0.25) confidence = 'conflict';
    items.push(Object.assign({ id, kind: 'gpu', date: TODAY }, item, { ebay_low3_avg: low3, src_ok, confidence }));
    status['gpuprix:' + id] = 'OK low_new ' + item.low_new + ' in_stock ' + item.in_stock;
  }
  return items;
}

async function runWimr() {
  const html = await get('https://www.whereismyram.com/us/price-chart');
  const m = html.match(/<script id="ng-state"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no ng-state');
  const st = JSON.parse(m[1]);
  const items = [], series = {};
  for (const v of Object.values(st)) {
    if (!v || typeof v !== 'object' || typeof v.u !== 'string' || !v.b) continue;
    const q = v.u.match(/capacity=(\d+)&frequency=(\d+)&latency=(\d+)/);
    if (!q || q[1] !== '32') continue;
    const data = v.b.data;
    if (!Array.isArray(data) || !data.length || !(v.b.stocks > 0)) continue;
    const id = `ddr5-32gb-${q[2]}-cl${q[3]}`;
    const last = data[data.length - 1];
    const ageDays = v.b.lastUpdate ? (Date.now() - new Date(v.b.lastUpdate)) / 864e5 : 999;
    series[id] = data.map((d) => ({ date: d.date.slice(0, 10), min: d.price.min, avg: d.price.average }));
    items.push({
      id, kind: 'kit', date: TODAY, capacity_gb: 32, min: last.price.min, avg: last.price.average, in_stock: v.b.stocks,
      chg_7d: v.b.percentWeek == null ? null : r2(v.b.percentWeek / 100), chg_30d: v.b.percentMonth == null ? null : r2(v.b.percentMonth / 100),
      src_ok: { wimr: true }, confidence: ageDays > 14 ? 'stale' : 'ok',
    });
  }
  if (!items.length) throw new Error('no tiers');
  if (!fs.existsSync(BACKFILL)) {
    fs.writeFileSync(BACKFILL, JSON.stringify({ generated_at: new Date().toISOString(), kind: 'kit', capacity_gb: 32, tiers: series }) + '\n');
    status.wimr_backfill = 'written ' + Object.values(series).reduce((a, s) => a + s.length, 0) + ' points, ' + Object.keys(series).length + ' tiers';
  }
  return items;
}

async function runTrendforce() {
  const html = await get('https://www.trendforce.com/price/dram/dram_spot');
  const row = (label) => {
    const i = html.indexOf('>' + label + '</span>');
    if (i < 0) throw new Error('row missing: ' + label);
    const nums = [...html.slice(i, i + 1600).matchAll(/class="lcd-num-l">([\d,.]+)</g)].map((x) => +x[1].replace(/,/g, ''));
    if (nums.length < 5) throw new Error('row short: ' + label);
    return nums[4];
  };
  const upd = html.match(/Last Update\s*([\d-]+ [\d:]+)/);
  return { d5: row('DDR5 16Gb (2Gx8) 4800/5600'), d4: row('DDR4 16Gb (2Gx8) 3200'), session: upd ? upd[1] : null };
}

async function runRental() {
  const out = { h100: {}, h200: {}, b200: {}, b300: {} };
  for (const k of Object.keys(out)) {
    try {
      const t = textOf(await get('https://www.silicondata.com/products/silicon-index/' + k));
      const m = t.match(/current \w+ rental price is \$([\d.]+)/);
      if (!m) throw new Error('no price');
      out[k].silicondata = +m[1]; status['silicondata:' + k] = 'OK ' + m[1];
    } catch (e) { status['silicondata:' + k] = 'FAIL ' + e.message; }
    await sleep(2000);
  }
  try {
    const j = await get('https://data.ornn.com/api/public-index/daily-index/all', 'json');
    const map = { 'H100 SXM': 'h100', H200: 'h200', B200: 'b200', B300: 'b300' };
    for (const r of j.data || []) if (map[r.gpu_type] && r.region === 'global') out[map[r.gpu_type]].ornn = r.index_value;
    status.ornn = 'OK ' + Object.values(out).filter((x) => x.ornn != null).length + ' series';
  } catch (e) { status.ornn = 'FAIL ' + e.message; }
  // keep last good value per field when a source failed today
  for (const k of Object.keys(out)) for (const s of ['silicondata', 'ornn']) {
    if (out[k][s] == null) out[k][s] = (prev.rental && prev.rental[k] && prev.rental[k][s]) ?? null;
  }
  return out;
}

(async () => {
  const items = [];
  try { items.push(...(await runGpus())); } catch (e) { status.gpus = 'FAIL ' + e.message; }
  let kits = [];
  try { kits = await runWimr(); status.wimr = 'OK ' + kits.length + ' tiers'; } catch (e) {
    status.wimr = 'FAIL ' + e.message;
    kits = (prev.items || []).filter((i) => i.kind === 'kit').map((i) => Object.assign({}, i, { src_ok: { wimr: false }, confidence: 'stale' }));
  }
  items.push(...kits);

  // history log (raw TrendForce lives here only)
  const logLines = [];
  const seen = new Set();
  let logText = '';
  try { logText = fs.readFileSync(LOG, 'utf-8'); } catch {}
  for (const l of logText.split('\n')) { try { const o = JSON.parse(l); seen.add(o.date + '|' + o.id); } catch {} }
  let tfBase = null;
  for (const l of logText.split('\n')) { try { const o = JSON.parse(l); if (o.id === 'tf-spot' && o.ddr5_16gb_raw != null) { tfBase = o; break; } } catch {} }

  let spot = prev.spot || { ddr5_16gb: null, ddr4_16gb: null, session: null };
  let tf = null;
  try { tf = await runTrendforce(); status.trendforce = 'OK ddr5 index computed'; } catch (e) { status.trendforce = 'FAIL ' + e.message; }
  if (tf) {
    const base = tfBase || { ddr5_16gb_raw: tf.d5, ddr4_16gb_raw: tf.d4, date: TODAY };
    const ix = (v, b) => (v != null && b ? r2((v / b) * 100) : null);
    const pct = (v, b) => (v != null && b ? r2((v / b - 1) * 100) : null);
    spot = {
      ddr5_16gb_index: ix(tf.d5, base.ddr5_16gb_raw), ddr4_16gb_index: ix(tf.d4, base.ddr4_16gb_raw),
      index_base_date: base.date, ddr5_chg_pct_since_base: pct(tf.d5, base.ddr5_16gb_raw),
      session: tf.session,
    };
    if (!seen.has(TODAY + '|tf-spot')) logLines.push({ date: TODAY, id: 'tf-spot', ddr5_16gb_raw: tf.d5, ddr4_16gb_raw: tf.d4, session: tf.session });
  } else if (spot.ddr5_16gb != null) spot = { ddr5_16gb_index: null, ddr4_16gb_index: null, session: null }; // never carry a raw value forward

  const rental = await runRental();

  for (const it of items) if (it.confidence !== 'stale' && !seen.has(TODAY + '|' + it.id)) logLines.push(it);
  if (!seen.has(TODAY + '|rental')) logLines.push({ date: TODAY, id: 'rental', rental });

  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  if (logLines.length) fs.appendFileSync(LOG, logLines.map((o) => JSON.stringify(o)).join('\n') + '\n');
  if (!items.length) { console.log('no items collected; leaving output untouched'); }
  else fs.writeFileSync(OUT, JSON.stringify({ generated_at: new Date().toISOString(), items, spot, rental }, null, 1) + '\n');
  for (const [k, v] of Object.entries(status)) console.log(k.padEnd(28), v);
})().catch((e) => { console.error('chip-retail failed (non-fatal):', e.message); });
