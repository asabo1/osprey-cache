#!/usr/bin/env node
/**
 * Phase 0 of MARKETS-PLAN.md: the shared segment data layer.
 *
 * Writes src/data/markets-data.json — every oil-transmission segment and the
 * resources tier in one shape: { price, prev, delta, delta_pct, as_of,
 * contract, series (~3mo daily closes), corr30 (Pearson corr of daily
 * returns vs Brent over the last 30 aligned sessions — COUPLING, labeled
 * correlation not causation), ok }. Plus the computed 3-2-1 crack spread
 * (methodology contract in MARKETS-PLAN.md) and FRED T5YIE breakevens
 * (keyless fredgraph.csv, ~1 day lag).
 *
 * Honesty rules: deltas come from the SERIES, never meta.chartPreviousClose
 * (ranged-chart gotcha, 3rd instance) — and never meta.regularMarketPrice
 * alone. contract carries Yahoo's shortName so every futures figure names
 * its contract month. A failed symbol CARRIES FORWARD its prior entry with
 * stale:true (same preserve pattern as fetch-intel/synthesis) — never a
 * silently-broken card. Soak log appends to data-archive/markets-soak.jsonl
 * (2-week reliability soak gates public binding, MARKETS-PLAN Phase 0).
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'src', 'data', 'markets-data.json');
const SOAK = path.join(ROOT, 'data-archive', 'markets-soak.jsonl');

// tier: transmission = the oil spine; resources = the second row.
const SYMBOLS = [
  { key: 'brent', sym: 'BZ=F', tier: 'transmission', label: 'Brent crude' },
  { key: 'wti', sym: 'CL=F', tier: 'transmission', label: 'WTI crude' },
  { key: 'gasoline', sym: 'RB=F', tier: 'transmission', label: 'RBOB gasoline' },
  { key: 'diesel', sym: 'HO=F', tier: 'transmission', label: 'ULSD diesel' },
  { key: 'natgas', sym: 'NG=F', tier: 'transmission', label: 'Henry Hub natgas' },
  { key: 'gold', sym: 'GC=F', tier: 'transmission', label: 'Gold' },
  { key: 'copper', sym: 'HG=F', tier: 'transmission', label: 'Copper' },
  { key: 'dxy', sym: 'DX-Y.NYB', tier: 'transmission', label: 'US dollar index' },
  { key: 'cad', sym: 'CAD=X', tier: 'transmission', label: 'USD/CAD' },
  { key: 'nok', sym: 'NOK=X', tier: 'transmission', label: 'USD/NOK' },
  { key: 'sp500', sym: '^GSPC', tier: 'transmission', label: 'S&P 500' },
  { key: 'xle', sym: 'XLE', tier: 'transmission', label: 'Energy equities (XLE)' },
  { key: 'jets', sym: 'JETS', tier: 'transmission', label: 'Airlines (JETS)' },
  { key: 'vix', sym: '^VIX', tier: 'transmission', label: 'VIX' },
  { key: 'lumber', sym: 'LBR=F', tier: 'resources', label: 'Lumber' },
  { key: 'steel_hrc', sym: 'HRC=F', tier: 'resources', label: 'Steel (US HRC)' },
  { key: 'aluminum', sym: 'ALI=F', tier: 'resources', label: 'Aluminum' },
  { key: 'wheat', sym: 'ZW=F', tier: 'resources', label: 'Wheat (SRW)' },
  { key: 'corn', sym: 'ZC=F', tier: 'resources', label: 'Corn' },
  { key: 'soybeans', sym: 'ZS=F', tier: 'resources', label: 'Soybeans' },
  { key: 'cotton', sym: 'CT=F', tier: 'resources', label: 'Cotton' },
  { key: 'coffee', sym: 'KC=F', tier: 'resources', label: 'Coffee' },
  { key: 'sugar', sym: 'SB=F', tier: 'resources', label: 'Sugar #11' },
  { key: 'uranium', sym: 'URA', tier: 'resources', label: 'Uranium (URA ETF)' },
  { key: 'chips', sym: 'SOXX', tier: 'resources', label: 'Semiconductors (SOXX proxy)' },
  { key: 'memory', sym: 'MU', tier: 'resources', label: 'Memory/DRAM (Micron proxy)' },
  { key: 'dop', sym: 'DOP=X', tier: 'regional', label: 'Dominican peso (USD/DOP)' },
  // Food & materials expansion (2026-07-09): dairy, cocoa, livestock, rice,
  // juice — same chart source, widens which product recipes can be priced.
  { key: 'butter', sym: 'CB=F', tier: 'resources', label: 'Butter (CME)' },
  { key: 'cheese', sym: 'CSC=F', tier: 'resources', label: 'Cheese (CME)' },
  { key: 'milk', sym: 'DC=F', tier: 'resources', label: 'Milk (Class III)' },
  { key: 'cocoa', sym: 'CC=F', tier: 'resources', label: 'Cocoa' },
  { key: 'hogs', sym: 'HE=F', tier: 'resources', label: 'Lean hogs' },
  { key: 'cattle', sym: 'LE=F', tier: 'resources', label: 'Live cattle' },
  { key: 'rice', sym: 'ZR=F', tier: 'resources', label: 'Rough rice' },
  { key: 'oj', sym: 'OJ=F', tier: 'resources', label: 'Orange juice (FCOJ)' },
  { key: 'soyoil', sym: 'ZL=F', tier: 'resources', label: 'Soybean oil' },
];

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 25000 }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(d));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout 10s')); });
    req.on('error', reject);
  });
}

async function fetchChart(sym) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?range=1y&interval=1d';
  const body = await get(url);
  const r = JSON.parse(body).chart.result[0];
  const ts = r.timestamp || [];
  const closes = (r.indicators.quote[0] || {}).close || [];
  const series = [];
  for (let i = 0; i < ts.length; i++) {
    if (closes[i] != null) series.push({ d: new Date(ts[i] * 1000).toISOString().slice(0, 10), c: +closes[i].toFixed(4) });
  }
  if (series.length < 2) throw new Error('series too short: ' + series.length);
  const last = series[series.length - 1];
  const prev = series[series.length - 2];
  return {
    price: last.c,
    prev: prev.c,
    delta: +(last.c - prev.c).toFixed(4),
    delta_pct: +(((last.c - prev.c) / prev.c) * 100).toFixed(2),
    as_of: last.d,
    contract: r.meta.shortName || sym,
    series,
    ok: true,
  };
}


async function fetchLmrCutout() {
  // USDA LMR national boxed beef choice cutout (keyless datamart): daily PM
  // print, $/cwt. One range query backfills the full year. Dedupe by date
  // (corrections re-print a date; keep the latest row for it).
  const end = new Date(), start = new Date(end.getTime() - 370 * 864e5);
  const f = (d) => String(d.getUTCMonth() + 1).padStart(2, '0') + '/' + String(d.getUTCDate()).padStart(2, '0') + '/' + d.getUTCFullYear();
  const url = 'https://mpr.datamart.ams.usda.gov/services/v1.1/reports/2453/Current%20Cutout%20Values?q=report_date=' + f(start) + ':' + f(end);
  const body = await get(url);
  const rows = JSON.parse(body).results || [];
  const byDate = new Map();
  for (const r of rows) {
    if (!r.report_date || r.choice_600_900_current == null) continue;
    const [mm, dd, yy] = r.report_date.split('/');
    byDate.set(yy + '-' + mm + '-' + dd, +r.choice_600_900_current);
  }
  const series = [...byDate.entries()].map(([d, c]) => ({ d, c })).sort((a, b) => (a.d < b.d ? -1 : 1));
  if (series.length < 20) throw new Error('lmr cutout series too short: ' + series.length);
  const last = series[series.length - 1], prev = series[series.length - 2];
  return {
    price: last.c, prev: prev.c,
    delta: +(last.c - prev.c).toFixed(2),
    delta_pct: +(((last.c - prev.c) / prev.c) * 100).toFixed(2),
    as_of: last.d, contract: 'USDA LMR national boxed beef choice cutout, 600-900 lb, PM',
    series, ok: true,
  };
}

async function fetchTreasuryBreakeven() {
  const base = 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/';
  const years = [new Date().getUTCFullYear() - 1, new Date().getUTCFullYear()];
  const nominal = new Map(), real = new Map();
  for (const y of years) {
    for (const [type, map, col] of [["daily_treasury_yield_curve", nominal, '5 Yr'], ["daily_treasury_real_yield_curve", real, '5 YR']]) {
      const csv = await get(base + y + '/all?type=' + type + '&_format=csv');
      const lines = csv.trim().split('\n');
      const cols = lines[0].split(',').map((c) => c.replace(/"/g, '').trim());
      const di = cols.indexOf('Date'), vi = cols.indexOf(col);
      if (di < 0 || vi < 0) throw new Error('treasury layout drift: ' + type);
      for (const l of lines.slice(1)) {
        const parts = l.split(',');
        const [mm, dd, yy] = parts[di].split('/');
        const v = parseFloat(parts[vi]);
        if (isFinite(v)) map.set(yy + '-' + mm + '-' + dd, v);
      }
    }
  }
  const series = [...nominal.keys()].filter((d) => real.has(d)).sort()
    .map((d) => ({ d, c: +(nominal.get(d) - real.get(d)).toFixed(2) }));
  if (series.length < 20) throw new Error('breakeven series too short');
  const last = series[series.length - 1], prev = series[series.length - 2];
  return {
    price: last.c, prev: prev.c,
    delta: +(last.c - prev.c).toFixed(2),
    delta_pct: +(((last.c - prev.c) / prev.c) * 100).toFixed(2),
    as_of: last.d, contract: '5Y nominal minus 5Y real Treasury par yields (~1 day lag)',
    series, ok: true,
  };
}

async function fetchFredCsv(id) {
  // fredgraph.csv blocks cloud-runner IPs (observed 2026-07-06: timeouts
  // from Actions at 25s while local works). Fall back to the official API
  // when FRED_API_KEY is set (user-pasted secret).
  if (process.env.FRED_API_KEY) {
    const j = JSON.parse(await get('https://api.stlouisfed.org/fred/series/observations?series_id=' + id +
      '&api_key=' + process.env.FRED_API_KEY + '&file_type=json&sort_order=asc&observation_start=2025-07-01'));
    const rows = (j.observations || []).filter((o) => o.value !== '.').map((o) => [o.date, o.value]);
    if (rows.length < 2) throw new Error('FRED API ' + id + ' empty');
    const last = rows[rows.length - 1], prev = rows[rows.length - 2];
    return {
      price: +last[1], prev: +prev[1],
      delta: +((+last[1]) - (+prev[1])).toFixed(2),
      delta_pct: +((((+last[1]) - (+prev[1])) / (+prev[1])) * 100).toFixed(2),
      as_of: last[0], contract: 'FRED ' + id + ' (~1 day lag)',
      series: rows.map((r) => ({ d: r[0], c: +r[1] })), ok: true,
    };
  }
  const body = await get('https://fred.stlouisfed.org/graph/fredgraph.csv?id=' + id);
  const rows = body.trim().split('\n').slice(1).map((l) => l.split(','))
    .filter((r) => r[1] && r[1] !== '.').slice(-66);
  if (rows.length < 2) throw new Error('FRED ' + id + ' empty');
  const last = rows[rows.length - 1], prev = rows[rows.length - 2];
  return {
    price: +last[1], prev: +prev[1],
    delta: +(+last[1] - +prev[1]).toFixed(2),
    delta_pct: +(((+last[1] - +prev[1]) / +prev[1]) * 100).toFixed(2),
    as_of: last[0], contract: 'FRED ' + id + ' (~1 day lag)',
    series: rows.map((r) => ({ d: r[0], c: +r[1] })), ok: true,
  };
}

// Pearson correlation of daily returns vs the base series over the last N
// aligned sessions (matched by date). Correlation, not causation — the hub
// labels it as coupling.
function corrVs(base, series, n) {
  const bm = new Map(base.map((p) => [p.d, p.c]));
  const pairs = [];
  for (let i = 1; i < series.length; i++) {
    const d0 = series[i - 1].d, d1 = series[i].d;
    if (bm.has(d0) && bm.has(d1)) {
      pairs.push([series[i].c / series[i - 1].c - 1, bm.get(d1) / bm.get(d0) - 1]);
    }
  }
  const tail = pairs.slice(-n);
  if (tail.length < 20) return null;
  const mx = tail.reduce((s, p) => s + p[0], 0) / tail.length;
  const my = tail.reduce((s, p) => s + p[1], 0) / tail.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of tail) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  if (!sxx || !syy) return null;
  return +(sxy / Math.sqrt(sxx * syy)).toFixed(2);
}

async function main() {
  let prior = {};
  try { prior = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch {}
  const out = { updated: new Date().toISOString(), segments: {}, crack321: null, breakevens: null };
  const failures = [];

  for (const s of SYMBOLS) {
    try {
      const r = await fetchChart(s.sym);
      out.segments[s.key] = Object.assign({ sym: s.sym, tier: s.tier, label: s.label }, r);
    } catch (e) {
      failures.push(s.sym + ': ' + e.message);
      const carried = prior.segments && prior.segments[s.key];
      out.segments[s.key] = carried
        ? Object.assign({}, carried, { ok: false, stale: true })
        : { sym: s.sym, tier: s.tier, label: s.label, ok: false, stale: true };
      console.error('FAIL ' + s.sym + ': ' + e.message);
    }
  }

  try {
    out.retail_gasoline = await fetchFredCsv('GASREGW');
    out.retail_gasoline.tier = 'reference';
    out.retail_gasoline.label = 'US retail gasoline, weekly average';
  } catch (e) {
    failures.push('GASREGW: ' + e.message);
    out.retail_gasoline = prior.retail_gasoline ? Object.assign({}, prior.retail_gasoline, { ok: false, stale: true }) : null;
  }

  try {
    const bc = await fetchLmrCutout();
    out.segments.beef_cutout = Object.assign({ sym: 'LMR-2453', tier: 'resources', label: 'Beef cutout (choice)' }, bc);
  } catch (e) {
    failures.push('LMR cutout: ' + e.message);
    const carriedBc = prior.segments && prior.segments.beef_cutout;
    if (carriedBc) out.segments.beef_cutout = Object.assign({}, carriedBc, { ok: false, stale: true });
    console.error('FAIL LMR cutout: ' + e.message);
  }

  // Breakevens from TREASURY directly (keyless, cloud-friendly): 5Y nominal
  // minus 5Y real (TIPS) par yields = the T5YIE definition. Validated
  // against FRED's print (2.24 on 2026-07-02, exact match). FRED itself
  // blocks runner IPs; treasury.gov does not.
  try {
    out.breakevens = await fetchTreasuryBreakeven();
    out.breakevens.tier = 'transmission';
    out.breakevens.label = '5Y inflation breakeven';
  } catch (e) {
    failures.push('T5YIE: ' + e.message);
    out.breakevens = prior.breakevens ? Object.assign({}, prior.breakevens, { ok: false, stale: true }) : null;
  }

  // corr30 vs Brent for every non-oil segment (coupling readout).
  const brent = out.segments.brent;
  if (brent && brent.ok) {
    for (const k of Object.keys(out.segments)) {
      if (k === 'brent' || k === 'wti') continue;
      const seg = out.segments[k];
      if (seg.series) seg.corr30 = corrVs(brent.series, seg.series, 30);
    }
    if (out.breakevens && out.breakevens.series) out.breakevens.corr30 = corrVs(brent.series, out.breakevens.series, 30);
  }

  // 3-2-1 crack spread per the MARKETS-PLAN methodology contract: front-month
  // CME futures, $/gal x42 to $/bbl, WTI basis, futures-implied benchmark not
  // any refiner's realized margin.
  const rb = out.segments.gasoline, ho = out.segments.diesel, cl = out.segments.wti;
  if (rb && rb.ok && ho && ho.ok && cl && cl.ok) {
    out.crack321 = {
      value: +(((2 * rb.price * 42 + ho.price * 42 - 3 * cl.price) / 3).toFixed(2)),
      unit: 'USD/bbl',
      formula: '(2 x RBOB + 1 x ULSD - 3 x WTI) / 3, $/gal x 42',
      contracts: { wti: cl.contract, rbob: rb.contract, ulsd: ho.contract },
      basis: 'front-month CME futures; futures-implied benchmark, not any refiner\'s realized margin',
      as_of: cl.as_of,
    };
  } else if (prior.crack321) {
    out.crack321 = Object.assign({}, prior.crack321, { stale: true });
  }

  // STORM WATCH (Miami desk): NOAA NHC active storms, keyless public JSON.
  // Non-fatal; carries prior on failure. Empty basin is a normal state.
  try {
    const nhc = JSON.parse(await get('https://www.nhc.noaa.gov/CurrentStorms.json'));
    out.storms = {
      as_of: new Date().toISOString(),
      active: (nhc.activeStorms || []).map((st) => ({
        name: st.name, cls: st.classification, intensity: st.intensity,
        moving: st.movementDir != null ? st.movementDir + ' at ' + st.movementSpeed + ' kt' : null,
        updated: st.lastUpdate,
      })),
    };
  } catch (e) {
    failures.push('NHC: ' + e.message);
    out.storms = prior.storms || null;
  }

  const okCount = Object.values(out.segments).filter((s) => s.ok).length;
  if (okCount < SYMBOLS.length / 2) {
    // Catastrophic run (Yahoo outage / block): keep the prior file intact.
    console.error('markets: only ' + okCount + '/' + SYMBOLS.length + ' ok — refusing to write');
    process.exit(1);
  }

  fs.writeFileSync(OUT, JSON.stringify(out));
  fs.mkdirSync(path.dirname(SOAK), { recursive: true });
  fs.appendFileSync(SOAK, JSON.stringify({ date: out.updated, ok: okCount, total: SYMBOLS.length, failures }) + '\n');
  console.log('markets: ' + okCount + '/' + SYMBOLS.length + ' segments ok' +
    (out.crack321 ? ', crack321 ' + out.crack321.value : '') +
    (out.breakevens && out.breakevens.ok ? ', T5YIE ' + out.breakevens.price : '') +
    (failures.length ? ' — FAILURES: ' + failures.join('; ') : ''));
}

main().catch((e) => { console.error(e); process.exit(1); });
