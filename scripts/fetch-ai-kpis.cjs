#!/usr/bin/env node
/**
 * AI money-flow KPIs (keyless, model-free). Writes:
 *   public/data/ai-kpis.json          what the page reads (verdict + KPI records)
 *   data-archive/ai-kpis-state.json   self-built daily snapshots and prior readings.
 *                                     Kept OUT of public/data on purpose: it holds raw
 *                                     spot prices whose licence is unread, so only
 *                                     rebased indices and percent changes are published.
 * Each KPI fails alone and keeps its previous good record (ok:false in sources).
 * State (fresh / stale / hidden) is recomputed from age on every run, so a dead
 * source ages out by itself. The verdict is arithmetic over the KPI signals.
 * Runs in .github/workflows/ai-kpis.yml; both files MUST stay in that workflow's
 * explicit git-add list.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'data', 'ai-kpis.json');
const STATE = path.join(ROOT, 'data-archive', 'ai-kpis-state.json');
const SEC = { 'User-Agent': 'crude-signal research bot' };
const BR = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' };
const TODAY = new Date().toISOString().slice(0, 10);
const rd = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return d; } };
const prevOut = rd(OUT, { kpis: [], sources: {} });
const state = rd(STATE, { hist: {}, seeds: {} });
// One-time seeds from TrendForce's published quarterly forecasts (3Q26 about +40% on 2Q26), so the first
// run can compare the new forecast with the last quarter. Replaced by the script's own history as it grows.
state.seeds = state.seeds || {};
state.seeds.K8 = state.seeds.K8 || { '3Q26': 40 };
const r2 = (n) => (n == null || !isFinite(n) ? null : Math.round(n * 100) / 100);
const r1 = (n) => (n == null || !isFinite(n) ? null : Math.round(n * 10) / 10);
const dayDiff = (a, b) => Math.round((new Date(a) - new Date(b)) / 864e5);

const { execFileSync } = require('child_process');
// FRED resets node's HTTP/2 and https clients from some networks; curl is reliable.
function getH1(url) {
  return execFileSync('curl', ['-sS', '--fail', '--max-time', '40', '--retry', '2', url], { encoding: 'utf-8', maxBuffer: 8e6 });
}
async function get(url, as = 'json', headers = SEC, opt = {}) {
  if (/fred\.stlouisfed\.org/.test(url)) return getH1(url);
  const res = await fetch(url, { headers, method: opt.method || 'GET', body: opt.body, signal: AbortSignal.timeout(30000), redirect: 'follow' });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url.slice(0, 80));
  return as === 'json' ? res.json() : res.text();
}
const txt = (h) => String(h).replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&#8226;|&#160;|&nbsp;/g, ' ').replace(/\s+/g, ' ');

function mk(o) {
  return Object.assign({ unit: '', value: null, value_prev: null, change: null, signal: null, state: 'fresh', as_of: TODAY, note: '', spark: [], partial: false }, o);
}
const sig = (v, up, down) => (v >= up ? 1 : v <= down ? -1 : 0);
function pushHist(key, v, t = TODAY) {
  const h = (state.hist[key] = state.hist[key] || []);
  const hit = h.find((p) => p.t === t);
  if (hit) hit.v = v; else h.push({ t, v });
  h.sort((a, b) => (a.t < b.t ? -1 : 1));
  state.hist[key] = h.slice(-400);
}
function histAt(key, daysAgo) {
  const h = state.hist[key] || [];
  const target = new Date(Date.now() - daysAgo * 864e5).toISOString().slice(0, 10);
  let best = null;
  for (const p of h) if (p.t <= target) best = p;
  return best;
}
const sparkOf = (key, n = 24) => (state.hist[key] || []).slice(-n).map((p) => ({ t: p.t, v: r2(p.v) }));

// SEC XBRL quarterly series: a quarter is a direct 3-month fact, or a YTD fact minus the prior YTD.
async function quarters(cik, tags) {
  let facts = null;
  for (const tag of tags) {
    try {
      const d = await get(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${tag}.json`);
      const u = (d.units && d.units.USD) || [];
      if (u.length) { facts = u; break; }
    } catch { /* next tag */ }
  }
  if (!facts) throw new Error('no XBRL facts for ' + cik);
  const m = new Map();
  for (const f of facts) {
    if (!f.start || !f.end || !/^(10-Q|10-K)/.test(f.form || '')) continue;
    const k = f.start + '|' + f.end;
    if (!m.has(k) || (f.filed || '') >= (m.get(k).filed || '')) m.set(k, f);
  }
  const all = [...m.values()];
  const q = new Map();
  for (const f of all) { const dur = dayDiff(f.end, f.start); if (dur >= 80 && dur <= 100) q.set(f.end, f.val); }
  for (const f of all) {
    if (dayDiff(f.end, f.start) <= 100) continue;
    for (const g of all) {
      if (g.start !== f.start || g.end >= f.end) continue;
      const gap = dayDiff(f.end, g.end);
      if (gap >= 80 && gap <= 100 && !q.has(f.end)) q.set(f.end, f.val - g.val);
    }
  }
  return [...q.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([end, v]) => ({ end, v: v / 1e9 }));
}
const yago = (series, i) => series.find((x) => Math.abs(dayDiff(series[i].end, x.end) - 365) <= 20);

async function k1() {
  const cos = { MSFT: '0000789019', GOOGL: '0001652044', AMZN: '0001018724', META: '0001326801', ORCL: '0001341439' };
  const tags = ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets'];
  const ser = {};
  for (const [s, c] of Object.entries(cos)) ser[s] = await quarters(c, s === 'AMZN' ? ['PaymentsToAcquireProductiveAssets', ...tags] : tags);
  const sum = (back) => {
    let a = 0, b = 0, n = 0;
    for (const s of Object.keys(ser)) {
      const i = ser[s].length - 1 - back, y = i >= 0 && yago(ser[s], i);
      if (i < 0 || !y) continue;
      a += ser[s][i].v; b += y.v; n++;
    }
    return { a, b, n };
  };
  const now = sum(0), prv = sum(1);
  if (now.n < 4 || prv.n < 4) throw new Error('capex coverage thin');
  const yoy = (now.a / now.b - 1) * 100, yoyPrev = (prv.a / prv.b - 1) * 100;
  const asof = Object.values(ser).map((x) => x[x.length - 1].end).sort().slice(-1)[0];
  const spark = [];
  for (let back = 7; back >= 0; back--) {
    let t = 0, n = 0, e = null;
    for (const s of Object.keys(ser)) { const i = ser[s].length - 1 - back; if (i >= 0) { t += ser[s][i].v; n++; e = ser[s][i].end; } }
    if (n >= 4) spark.push({ t: e, v: r1(t) });
  }
  return mk({ id: 'K1', group: 'SPEND', label: 'Cloud capital spending', unit: 'USD B', value: r1(now.a), value_prev: r1(prv.a), as_of: asof,
    change: { kind: 'yoy', pct: r1(yoy), prev_pct: r1(yoyPrev), delta_pp: r1(yoy - yoyPrev) }, signal: sig(yoy - yoyPrev, 3, -3),
    note: 'Latest quarter, five biggest cloud companies combined.', spark });
}

async function earnings(cik10, n) {
  const sub = await get(`https://data.sec.gov/submissions/CIK${cik10}.json`);
  const r = sub.filings.recent, out = [];
  for (let i = 0; i < r.form.length && out.length < n; i++) {
    if (r.form[i] !== '8-K' || !/2\.02/.test(r.items[i] || '')) continue;
    const acc = r.accessionNumber[i].replace(/-/g, ''), cik = String(+cik10);
    try {
      const idx = await get(`https://www.sec.gov/Archives/edgar/data/${cik}/${acc}/index.json`);
      const names = (idx.directory.item || []).map((x) => x.name).filter((x) => /\.htm$/.test(x) && !/index/.test(x));
      const pick = names.find((x) => /pr|ex99|ex-99|release/i.test(x)) || names[1] || names[0];
      out.push({ date: r.filingDate[i], text: txt(await get(`https://www.sec.gov/Archives/edgar/data/${cik}/${acc}/${pick}`, 'text')) });
    } catch { /* skip this filing */ }
  }
  if (!out.length) throw new Error('no earnings releases found');
  return out;
}

async function k2() {
  const [e] = await earnings('0001045810', 1);
  const dc = e.text.match(/Data Center revenue of \$([\d.]+) billion, up (\d+)%/);
  const tot = e.text.match(/revenue (?:was|of) \$([\d.]+) billion[^.]{0,80}?up (\d+)% from the previous quarter/i);
  const guide = e.text.match(/Revenue is expected to be \$([\d.]+) billion/);
  if (!dc || !tot || !guide) throw new Error('Nvidia release wording changed');
  const lastQoq = +tot[2], guidedQoq = (+guide[1] / +tot[1] - 1) * 100;
  pushHist('K2', +dc[1], e.date);
  return mk({ id: 'K2', group: 'CHIPS', label: 'Nvidia data center revenue', unit: 'USD B', value: +dc[1], as_of: e.date,
    change: { kind: 'yoy', pct: +dc[2], prev_pct: null, delta_pp: null }, signal: guidedQoq >= lastQoq ? 1 : lastQoq - guidedQoq >= 5 ? -1 : 0,
    note: `Guided growth next quarter is ${r1(guidedQoq)}% against ${lastQoq}% last quarter.`, spark: sparkOf('K2') });
}

async function k3() {
  const d = await get('https://openapi.twse.com.tw/v1/opendata/t187ap05_L', 'json', { 'User-Agent': 'osprey-cache/1.0' });
  const r = d.find((x) => String(x['公司代號']) === '2330');
  const ym = String(r['資料年月']), rev = +r['營業收入-當月營收'], last = +r['營業收入-上月營收'], ya = +r['營業收入-去年當月營收'];
  if (!/^\d{5}$/.test(ym) || !(rev > 0) || !(last > 0) || !(ya > 0)) throw new Error('TWSE row malformed');
  const period = `${+ym.slice(0, 3) + 1911}-${ym.slice(3)}`;
  const yoy = (rev / ya - 1) * 100;
  pushHist('K3', r2(yoy), period + '-01');
  const h = state.hist.K3, prevY = h.length > 1 ? h[h.length - 2].v : null;
  return mk({ id: 'K3', group: 'CHIPS', label: 'TSMC monthly revenue', unit: 'NT$ B', value: r1(rev / 1e6), value_prev: r1(last / 1e6), as_of: period + '-28',
    change: { kind: 'yoy', pct: r1(yoy), prev_pct: prevY, delta_pp: prevY != null ? r1(yoy - prevY) : null },
    signal: prevY != null ? sig(yoy - prevY, 5, -5) : null, note: `Up ${r1((rev / last - 1) * 100)}% on the month.`, attribution: 'TWSE', spark: sparkOf('K3') });
}

async function k4() {
  const csv = await get('https://fred.stlouisfed.org/graph/fredgraph.csv?id=XTEXVA01KRM667S', 'text', BR);
  const rows = csv.trim().split('\n').slice(1).map((l) => l.split(',')).map(([t, v]) => ({ t, v: +v / 1e9 })).filter((x) => isFinite(x.v) && x.v > 0);
  const n = rows.length, cur = rows[n - 1], prv = rows[n - 2];
  const yoy = rows[n - 13] ? (cur.v / rows[n - 13].v - 1) * 100 : null, yoyPrev = rows[n - 14] ? (prv.v / rows[n - 14].v - 1) * 100 : null;
  let flag = null;
  try {
    const x = await get('https://news.google.com/rss/search?q=Korea+exports+semiconductor+first+20+days+when:30d&hl=en-US&gl=US&ceid=US:en', 'text', BR);
    const titles = (x.match(/<title>[\s\S]*?<\/title>/g) || []).map((t) => txt(t.replace(/<!\[CDATA\[|\]\]>/g, '')));
    flag = titles.find((t) => /semiconductor|chip/i.test(t) && /record|more than double|surg/i.test(t)) || null;
  } catch { /* partial is fine */ }
  return mk({ id: 'K4', group: 'CHIPS', label: 'Korea exports', unit: 'USD B', value: r1(cur.v), value_prev: r1(prv.v), as_of: cur.t,
    change: { kind: 'yoy', pct: r1(yoy), prev_pct: r1(yoyPrev), delta_pp: yoy != null && yoyPrev != null ? r1(yoy - yoyPrev) : null },
    signal: flag ? 1 : yoy != null && yoyPrev != null ? sig(yoy - yoyPrev, 10, -5) : null, partial: true,
    note: flag ? 'Chip shipments at a record in the latest customs headlines.' : 'All goods, a proxy for chip shipments.',
    spark: rows.slice(-24).map((x) => ({ t: x.t, v: r1(x.v) })) });
}

async function k5() {
  const list = await get('https://www.semiconductors.org/news-events/latest-news/', 'text', BR);
  const links = [...new Set((list.match(/href="(https:\/\/www\.semiconductors\.org\/[^"]*semiconductor-sales[^"]*)"/g) || []).map((s) => s.slice(6, -1)))].slice(0, 4);
  const parsed = [];
  for (const l of links) {
    try {
      const t = txt(await get(l, 'text', BR));
      const mm = t.match(/([\d.]+)% month-to-month/), yy = t.match(/([\d.]+)% year-to-year/);
      const lv = t.match(/(?:sales (?:were|totaled)|were) \$([\d.]+) billion (?:in|during) (?:the month of )?(?!the )([A-Z][a-z]+)/);
      const dt = t.match(/(?:Mon|Tues|Wednes|Thurs|Fri)day, ([A-Z][a-z]{2}) (\d{1,2}), (20\d\d)/);
      if (mm && yy && dt) parsed.push({ mom: +mm[1], yoy: +yy[1], lv: lv ? +lv[1] : null, date: new Date(`${dt[1]} ${dt[2]} ${dt[3]} UTC`).toISOString().slice(0, 10) });
    } catch { /* next */ }
  }
  if (!parsed.length) throw new Error('SIA release not parsed');
  const cur = parsed[0], prv = parsed[1];
  pushHist('K5', cur.yoy, cur.date);
  return mk({ id: 'K5', group: 'CHIPS', label: 'Global chip sales', unit: 'USD B', value: cur.lv, as_of: cur.date,
    change: { kind: 'yoy', pct: cur.yoy, prev_pct: prv ? prv.yoy : null, delta_pp: prv ? r1(cur.yoy - prv.yoy) : null },
    signal: prv ? sig(cur.mom - prv.mom, 2, -2) : null, note: `Up ${cur.mom}% on the month.`, spark: sparkOf('K5') });
}

async function trendforce() {
  const html = await get('https://www.trendforce.com/price', 'text', BR);
  const row = (label) => {
    const i = html.indexOf('>' + label + '</span>');
    if (i < 0) throw new Error('row missing: ' + label);
    const nums = [...html.slice(i, i + 1600).matchAll(/class="lcd-num-l">([\d,.]+)</g)].map((m) => +m[1].replace(/,/g, ''));
    if (nums.length < 5) throw new Error('row short: ' + label);
    return nums[4];
  };
  return { d5: row('DDR5 16Gb (2Gx8) 4800/5600'), rdimm: row('DDR5 RDIMM 32GB 4800/5600') };
}
function idxKpi(id, label, key, raw, note) {
  pushHist(key, raw);
  const h = state.hist[key], base = h[0].v, idx = (v) => r1((v / base) * 100);
  const now = h[h.length - 1], p4 = histAt(key, 28), p8 = histAt(key, 56);
  const have8 = dayDiff(TODAY, h[0].t) >= 56;
  let ch = null, sg = null;
  if (p4) {
    const c = (now.v / p4.v - 1) * 100, cp = p8 ? (p4.v / p8.v - 1) * 100 : null;
    ch = { kind: '4wk', pct: r1(c), prev_pct: r1(cp), delta_pp: cp != null ? r1(c - cp) : null };
    if (have8 && cp != null) sg = c <= -2 ? -1 : c > 0 && c - cp >= 2 ? 1 : c - cp <= -2 ? -1 : 0;
  }
  return mk({ id, group: 'MEMORY', label, unit: 'index', value: idx(now.v), state: have8 ? 'fresh' : 'building', change: ch, signal: sg, note,
    spark: h.slice(-24).map((p) => ({ t: p.t, v: idx(p.v) })) });
}

async function k8() {
  const list = await get('https://www.trendforce.com/presscenter/news', 'text', BR);
  const links = [...new Set(list.match(/\/presscenter\/news\/\d{8}-\d+\.html/g) || [])].slice(0, 15).concat('/presscenter/news/20260930-13258.html');   // last pinned: the 4Q26 forecast, until a newer one is published
  for (const l of links) {
    let t; try { t = txt(await get('https://www.trendforce.com' + l, 'text', BR)); } catch { continue; }
    const m = t.match(/DRAM contract prices[^.]{0,60}?(?:grow|rise|increase|decline|fall|decrease)[^.]{0,12}?(\d+)(?:[–-](\d+))?% QoQ in (\dQ\d\d)/i);
    if (!m) continue;
    const lo = +m[1], hi = m[2] ? +m[2] : lo, mid = (lo + hi) / 2, q = m[3];
    const dt = l.match(/(\d{4})(\d{2})(\d{2})/);
    state.hist.K8q = state.hist.K8q || {};
    state.hist.K8q[q] = mid;
    const all = Object.assign({}, state.seeds.K8, state.hist.K8q);
    const key = (k) => k.slice(2) + k[0];
    const order = Object.keys(all).sort((a, b) => (key(a) < key(b) ? -1 : 1));
    const prevQ = order[order.indexOf(q) - 1], prev = prevQ ? all[prevQ] : null;
    return mk({ id: 'K8', group: 'MEMORY', label: 'DRAM contract price outlook', unit: '%', value: mid, value_prev: prev, as_of: `${dt[1]}-${dt[2]}-${dt[3]}`,
      change: { kind: 'qoq', pct: mid, prev_pct: prev, delta_pp: prev != null ? r1(mid - prev) : null },
      signal: prev == null ? null : mid >= prev ? 1 : mid < prev * 0.5 ? -1 : 0,
      note: `Forecast ${lo}${m[2] ? ' to ' + hi : ''}% for ${q}.`, spark: order.slice(-8).map((k) => ({ t: k, v: all[k] })) });
  }
  throw new Error('no DRAM contract forecast found');
}

async function micron(id, tags, label, group, rule, note) {
  const s = await quarters('0000723125', tags);
  const n = s.length, cur = s[n - 1], prv = s[n - 2], pp = s[n - 3];
  if (!cur || !prv || !pp) throw new Error('micron quarters thin');
  const qoq = (cur.v / prv.v - 1) * 100, qoqPrev = (prv.v / pp.v - 1) * 100, y = yago(s, n - 1);
  return mk({ id, group, label, unit: 'USD B', value: r1(cur.v), value_prev: r1(prv.v), as_of: cur.end,
    change: { kind: 'qoq', pct: r1(qoq), prev_pct: r1(qoqPrev), delta_pp: r1(qoq - qoqPrev), yoy_pct: y ? r1((cur.v / y.v - 1) * 100) : null },
    signal: rule(qoq, qoqPrev), note, spark: s.slice(-8).map((x) => ({ t: x.end, v: r1(x.v) })) });
}

async function k11() {
  const bars = async (s) => {
    const d = await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?range=6mo&interval=1d`, 'json', { 'User-Agent': 'osprey-cache/1.0' });
    const r = d.chart.result[0], c = r.indicators.quote[0].close;
    return r.timestamp.map((t, i) => ({ t: new Date(t * 1000).toISOString().slice(0, 10), c: c[i] })).filter((x) => x.c != null).slice(-64);
  };
  const res = [];
  for (const s of ['MU', '000660.KS', '005930.KS', 'NVDA', '^SOX', 'QQQ']) { res.push(await bars(s)); await new Promise((r) => setTimeout(r, 500)); }
  const [mu, hy, ss, nv, sox, qqq] = res;
  const ret = (b) => (b[b.length - 1].c / b[0].c - 1) * 100;
  const rel = (ret(mu) + ret(hy) + ret(ss)) / 3 - ret(nv), soxRel = ret(sox) - ret(qqq);
  const at = (b, i) => b[Math.min(b.length - 1, Math.round(i * (b.length - 1) / 23))];
  const spark = (f) => Array.from({ length: 24 }, (_, i) => ({ t: at(nv, i).t, v: r1(f(i)) }));
  const cum = (b, i) => (at(b, i).c / b[0].c - 1) * 100;
  const asof = nv[nv.length - 1].t;
  return [
    mk({ id: 'K11', group: 'MEMORY', label: 'Memory stocks vs Nvidia', unit: 'pp', value: r1(rel), as_of: asof, change: { kind: '3mo', pct: r1(rel), prev_pct: null, delta_pp: null },
      confirm: rel >= 5 ? 1 : rel <= -5 ? -1 : 0, note: 'Three-month gap, memory basket minus Nvidia.', spark: spark((i) => (cum(mu, i) + cum(hy, i) + cum(ss, i)) / 3 - cum(nv, i)) }),
    mk({ id: 'K16', group: 'MARKET', label: 'Chip index vs Nasdaq-100', unit: 'pp', value: r1(soxRel), as_of: asof, change: { kind: '3mo', pct: r1(soxRel), prev_pct: null, delta_pp: null },
      confirm: soxRel >= 3 ? 1 : soxRel <= -3 ? -1 : 0, note: 'Three-month gap, chip index minus Nasdaq-100.', spark: spark((i) => cum(sox, i) - cum(qqq, i)) }),
  ];
}

async function k12() {
  const rp = await get('https://api.runpod.io/graphql', 'json', { 'User-Agent': 'osprey-cache/1.0', 'content-type': 'application/json' },
    { method: 'POST', body: JSON.stringify({ query: '{ gpuTypes { id displayName communityPrice securePrice } }' }) });
  const g = rp.data.gpuTypes;
  const price = (re) => { const x = g.find((t) => re.test(t.displayName) && t.securePrice > 0); return x ? x.securePrice : null; };
  const h100 = price(/^H100 SXM$/) || price(/^H100/), b200 = price(/^B200$/);
  let vast = null;
  try {
    const q = encodeURIComponent(JSON.stringify({ rentable: { eq: true }, gpu_name: { eq: 'H100 SXM' }, limit: 50 }));
    const v = await get(`https://console.vast.ai/api/v0/bundles?q=${q}`, 'json', { 'User-Agent': 'osprey-cache/1.0' });
    const per = (v.offers || []).filter((o) => o.num_gpus > 0 && o.dph_total > 0).map((o) => o.dph_total / o.num_gpus).sort((a, b) => a - b);
    if (per.length >= 3) vast = per[Math.floor(per.length / 2)];
  } catch { /* RunPod alone is fine */ }
  if (!h100) throw new Error('H100 price missing');
  const med = vast ? (h100 + vast) / 2 : h100;
  pushHist('K12', r2(med));
  const h = state.hist.K12, now = h[h.length - 1], p4 = histAt('K12', 28), p8 = histAt('K12', 56), have8 = dayDiff(TODAY, h[0].t) >= 56;
  let ch = null, sg = null;
  if (p4) {
    const c = (now.v / p4.v - 1) * 100, cp = p8 ? (p4.v / p8.v - 1) * 100 : null;
    ch = { kind: '4wk', pct: r1(c), prev_pct: r1(cp), delta_pp: cp != null ? r1(c - cp) : null };
    if (have8) sg = sig(c, 3, -3);
  }
  return mk({ id: 'K12', group: 'CHIPS', label: 'GPU rental price, H100', unit: 'USD/GPU-hr', value: r2(med), value_prev: b200 ? r2(b200) : null,
    state: have8 ? 'fresh' : 'building', change: ch, signal: sg, note: b200 ? `B200 at $${r2(b200)} per GPU-hour.` : '', spark: sparkOf('K12') });
}

async function k13() {
  const rel = await earnings('0001996810', 2);
  const re = /(?:grew|increased|rose) from (\d+) to (\d+) GW/;
  const a = rel[0].text.match(re), b = rel[1] && rel[1].text.match(re);
  if (!a) throw new Error('GE Vernova GW wording changed');
  if (+a[2] < +a[1] * 0.8) throw new Error('GW sanity guard');
  const g = (+a[2] / +a[1] - 1) * 100, gp = b ? (+b[2] / +b[1] - 1) * 100 : null;
  return mk({ id: 'K13', group: 'POWER', label: 'Gas turbine backlog', unit: 'GW', value: +a[2], value_prev: +a[1], as_of: rel[0].date,
    change: { kind: 'qoq', pct: r1(g), prev_pct: r1(gp), delta_pp: gp != null ? r1(g - gp) : null }, signal: gp != null ? sig(g - gp, 1, -2) : null,
    note: 'Backlog plus reserved slots, latest quarter.', spark: b ? [{ t: rel[1].date, v: +b[2] }, { t: rel[0].date, v: +a[2] }] : [{ t: rel[0].date, v: +a[2] }] });
}

// PJM capacity auctions are annual events. Static table, updated once a year after each auction
// (2026/27 and 2027/28 both cleared at the cap, per PJM's base residual auction reports).
function k14() {
  const results = [{ t: '2026-07-01', v: 329.17 }, { t: '2027-07-01', v: 333.44 }];
  const cur = results[1], prv = results[0];
  return mk({ id: 'K14', group: 'POWER', label: 'Grid capacity price', unit: 'USD/MW-day', value: cur.v, value_prev: prv.v, as_of: '2025-12-01',
    change: { kind: 'yoy', pct: r1((cur.v / prv.v - 1) * 100), prev_pct: null, delta_pp: null }, signal: cur.v >= prv.v ? 1 : -1,
    note: 'Latest auction cleared at the price cap.', spark: results });
}

async function k15() {
  const csv = await get('https://fred.stlouisfed.org/graph/fredgraph.csv?id=TLPWRCONS', 'text', BR);
  const rows = csv.trim().split('\n').slice(1).map((l) => l.split(',')).map(([t, v]) => ({ t, v: +v / 1000 })).filter((x) => isFinite(x.v) && x.v > 0);
  const n = rows.length, cur = rows[n - 1];
  const g3 = (a, b) => (rows[a].v / rows[b].v - 1) * 100, c3 = g3(n - 1, n - 4), p3 = g3(n - 4, n - 7);
  return mk({ id: 'K15', group: 'SPEND', label: 'US power plant construction', unit: 'USD B', value: r1(cur.v), value_prev: r1(rows[n - 2].v), as_of: cur.t,
    change: { kind: '3mo', pct: r1(c3), prev_pct: r1(p3), delta_pp: r1(c3 - p3) }, signal: sig(c3 - p3, 1, -1),
    note: 'Annualized rate, monthly.', partial: true, spark: rows.slice(-24).map((x) => ({ t: x.t, v: r1(x.v) })) });
}

const AGE = { K1: [120, 200], K2: [120, 200], K9: [120, 200], K10: [120, 200], K13: [120, 200], K8: [120, 200],
  K3: [50, 100], K4: [50, 100], K5: [50, 100], K15: [50, 100], K6: [3, 10], K7: [3, 10], K11: [3, 10], K12: [3, 10], K16: [3, 10] };
const GROUPS = { SPEND: ['K1', 'K10', 'K15'], CHIPS: ['K2', 'K3', 'K4', 'K5', 'K12'], MEMORY: ['K6', 'K7', 'K8', 'K9'], POWER: ['K13', 'K14'] };
const GW = { SPEND: 0.30, CHIPS: 0.30, MEMORY: 0.25, POWER: 0.15 };
const KW = { K1: 2, K2: 2, K9: 1.5 };
const NAME = { SPEND: 'Spending', CHIPS: 'Chips', MEMORY: 'Memory prices', POWER: 'Power' };

function verdict(kpis) {
  const by = Object.fromEntries(kpis.map((k) => [k.id, k]));
  const groups = {}, scored = [];
  for (const [g, ids] of Object.entries(GROUPS)) {
    let w = 0, s = 0, wTot = 0;
    for (const id of ids) {
      const wt = KW[id] || 1; wTot += wt;
      const k = by[id];
      if (k && k.state !== 'hidden' && k.signal != null) { w += wt; s += wt * k.signal; }
    }
    groups[g] = { score: w ? r2(s / w) : null, fresh_weight: r2(w / wTot) };
    if (w / wTot >= 0.6) scored.push(g);
  }
  const mk2 = ['K11', 'K16'].map((id) => by[id] && by[id].confirm).filter((x) => x != null);
  const sigs = kpis.filter((k) => k.state !== 'hidden' && k.signal != null);
  let out = { word: 'Not enough fresh data', score: null, leading: null, lagging: null, improved: sigs.filter((k) => k.signal > 0).length, total: sigs.length, markets: 'n/a', groups };
  if (scored.length >= 2) {
    const wsum = scored.reduce((a, g) => a + GW[g], 0);
    const score = scored.reduce((a, g) => a + GW[g] * groups[g].score, 0) / wsum;
    const pw = prevOut.verdict && prevOut.verdict.word;
    let word = score >= 0.35 ? 'Accelerating' : score <= -0.35 ? 'Slowing' : 'Holding steady';
    if (pw === 'Accelerating' && score >= 0.25) word = pw;
    else if (pw === 'Slowing' && score <= -0.25) word = pw;
    else if (pw === 'Holding steady' && Math.abs(score) < 0.45) word = pw;
    const rank = scored.slice().sort((a, b) => groups[b].score - groups[a].score);
    const gap = groups[rank[0]].score - groups[rank[rank.length - 1]].score;
    const dir = word === 'Accelerating' ? 1 : word === 'Slowing' ? -1 : 0;
    out = Object.assign(out, { word, score: r2(score), leading: gap >= 0.5 ? rank[0] : null, lagging: gap >= 0.5 ? rank[rank.length - 1] : null,
      markets: mk2.length ? (mk2.reduce((a, b) => a + b, 0) * dir > 0 || (dir === 0 && mk2.every((m) => m === 0)) ? 'agree' : 'disagree') : 'n/a' });
  }
  const parts = [`AI spending is ${out.word === 'Not enough fresh data' ? 'not readable yet' : out.word.toLowerCase()}.`];
  if (out.leading) parts.push(`Strongest: ${NAME[out.leading]}. Weakest: ${NAME[out.lagging]}.`);
  parts.push(`${out.improved} of ${out.total} readings improved.`);
  if (out.markets !== 'n/a') parts.push(out.markets === 'agree' ? 'Markets agree.' : 'Markets disagree.');
  out.headline = parts.join(' ');
  return out;
}

(async () => {
  const jobs = {
    K1: k1, K2: k2, K3: k3, K4: k4, K5: k5, K8: k8,
    K9: () => micron('K9', ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues'], 'Micron revenue', 'MEMORY', (q, p) => (q >= p ? 1 : q <= p * 0.6 ? -1 : 0), 'Latest quarter; growth rate against the quarter before.'),
    K10: () => micron('K10', ['PaymentsToAcquirePropertyPlantAndEquipment'], 'Memory maker capex', 'SPEND', (q) => sig(q, 10, -10), 'Micron capital spending: money in now, supply later.'),
    K12: k12, K13: k13, K14: async () => k14(), K15: k15,
  };
  const kpis = [], sources = {};
  const record = (k) => { kpis.push(k); sources[k.id] = { ok: true, error: null }; };
  const fail = (id, e) => {
    sources[id] = { ok: false, error: String(e.message || e) };
    const old = (prevOut.kpis || []).find((k) => k.id === id);
    if (old) kpis.push(old);
    console.log('  FAIL ' + id + ': ' + sources[id].error);
  };
  for (const [id, fn] of Object.entries(jobs)) { try { record(await fn()); console.log('  ok   ' + id); } catch (e) { fail(id, e); } }
  try {
    const tf = await trendforce();
    record(idxKpi('K6', 'DDR5 spot price index', 'K6', tf.d5, 'Change over the last four weeks.'));
    record(idxKpi('K7', 'Server memory price index', 'K7', tf.rdimm, 'Server module spot, four-week change.'));
    console.log('  ok   K6 K7');
  } catch (e) { fail('K6', e); fail('K7', e); }
  try { for (const k of await k11()) record(k); console.log('  ok   K11 K16'); } catch (e) { fail('K11', e); fail('K16', e); }

  const now = new Date().toISOString();
  for (const k of kpis) {
    k.age_days = dayDiff(TODAY, k.as_of);
    if (k.id === 'K14') k.state = 'fresh';
    else if (k.state !== 'building') { const [st, hd] = AGE[k.id] || [120, 200]; k.state = k.age_days > hd ? 'hidden' : k.age_days > st ? 'stale' : 'fresh'; }
    if (sources[k.id].ok) k.fetched_at = now;
  }
  kpis.sort((a, b) => +a.id.slice(1) - +b.id.slice(1));
  const out = { generated_at: now, verdict: verdict(kpis), kpis, sources };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  fs.writeFileSync(STATE, JSON.stringify(state));
  console.log('ai-kpis.json written: ' + out.verdict.headline);
})();
