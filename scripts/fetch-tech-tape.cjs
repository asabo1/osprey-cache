#!/usr/bin/env node
/**
 * "Nasdaq through the AI lens" data -> public/data/tech-tape.json (keyless, model-free).
 *   weights    QQQ top-25 holdings (third-party HTML table, top 25 only). Kept from the
 *              last good run when a parse returns fewer than 20 rows.
 *   windows    buy-and-hold contribution to QQQ's move over 1M / 6M / 1Y, bucketed
 *              into semis, AI spenders and the rest. Start weight is today's weight
 *              rolled back: w0 = w_now x (1 + R_qqq) / (1 + r_i).
 *   rebased    QQQ, ^SOX, QQQE six months rebased to 100.
 *   drawdown   QQQ and ^SOX against their one-year highs. rates: 10y level, 1M change.
 *   news       AI and Nasdaq headlines through the spec's allow/deny filter.
 * Live prices for the tape itself are NOT here; the page reads /api/quotes every 60s.
 * Every percentage comes from Yahoo only; the weights table is used for weights alone.
 * Runs in .github/workflows/ai-kpis.yml; the file MUST stay in its explicit git-add list.
 */
const fs = require('fs');
const path = require('path');
const wireCore = require('./lib/wire-core.cjs');

const OUT = path.join(__dirname, '..', 'public', 'data', 'tech-tape.json');
const UA = { 'User-Agent': 'osprey-cache/1.0' };
const BR = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' };
const prev = (() => { try { return JSON.parse(fs.readFileSync(OUT, 'utf-8')); } catch { return {}; } })();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (n) => Math.round(n * 100) / 100;
const r1 = (n) => Math.round(n * 10) / 10;

async function get(url, as = 'json', headers = UA) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url.slice(0, 70));
  return as === 'json' ? res.json() : res.text();
}
async function series(sym, range) {
  const d = await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=1d`);
  const r = d.chart.result[0], ts = r.timestamp, q = r.indicators.quote[0].close;
  const adj = (r.indicators.adjclose && r.indicators.adjclose[0] && r.indicators.adjclose[0].adjclose) || q;
  return ts.map((t, i) => ({ t: new Date(t * 1000).toISOString().slice(0, 10), c: adj[i] != null ? adj[i] : q[i] })).filter((x) => x.c != null);
}

const SEMIS = new Set(['NVDA', 'AVGO', 'MU', 'AMD', 'AMAT', 'LRCX', 'KLAC', 'INTC', 'QCOM', 'TXN', 'ASML', 'ARM', 'MRVL']);
const SPENDERS = new Set(['MSFT', 'AMZN', 'GOOGL', 'GOOG', 'META']);
const bucket = (s) => (SEMIS.has(s) ? 'semis' : SPENDERS.has(s) ? 'spenders' : 'rest');

async function weights() {
  const html = await get('https://stockanalysis.com/etf/qqq/holdings/', 'text', BR);
  const rows = [];
  for (const tr of html.match(/<tr[\s\S]*?<\/tr>/g) || []) {
    const sym = (tr.match(/href="\/stocks\/[^"]+\/">([A-Z.]{1,6})</) || [])[1];
    const name = (tr.match(/class="slw[^"]*">([^<]+)</) || [])[1];
    const w = (tr.match(/<td class="svelte-[^"]+">([\d.]+)%<\/td>/) || [])[1];
    if (sym && w) rows.push({ sym, name: (name || sym).replace(/&amp;/g, '&'), w: +w });
  }
  if (rows.length < 20) throw new Error('only ' + rows.length + ' rows parsed');
  return { asof: new Date().toISOString().slice(0, 10), rows: rows.slice(0, 25) };
}

const DENY = /\b(should you buy|is it (a )?(good|smart) (time|buy)|inside the index|key levels|price prediction|stock forecast|best (\w+ ){0,3}stocks?|top \d+ |stocks? to buy|buy now|dividend|case for|here'?s what history|motley|zacks|sponsored|press release|rings the (opening|closing) bell|prime day|horoscope)\b/i;
const AI = /\b(AI|artificial intelligence|nvidia|nvda|broadcom|avgo|micron|hbm|dram|tsmc|taiwan semi|sk ?hynix|asml|amd|semiconductor|chips?|chipmaker|gpu|hyperscal\w*|capex|data ?cent(er|re)s?|openai|anthropic|megacap|big tech|magnificent seven|mag ?7|power (demand|grid)|export controls?)\b/i;
const MEGA = /\b(apple|microsoft|alphabet|google|amazon|meta|tesla)\b.*\b(earnings|guidance|capex|revenue|results)\b/i;
const RATES = /\b(fed|treasury|yields?|rate (cut|hike)s?|fomc|inflation|cpi)\b/i;
const TECHCTX = /\b(tech|nasdaq|growth stocks|valuations?|semis|chips?|AI)\b/i;
const keep = (t) => !DENY.test(t) && (AI.test(t) || MEGA.test(t) || (RATES.test(t) && TECHCTX.test(t)));

function parseRss(xml) {
  const dec = (s) => String(s || '').replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;|&#8217;/g, "'").replace(/&quot;/g, '"').replace(/<[^>]+>/g, '').trim();
  const items = [];
  for (const b of (xml.match(/<item[\s>][\s\S]*?<\/item>/g) || []).slice(0, 25)) {
    const title = dec((b.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1]);
    const link = dec((b.match(/<link[^>]*>([\s\S]*?)<\/link>/) || [])[1]);
    const d = new Date((b.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || NaN);
    if (!title || isNaN(d) || Date.now() - d.getTime() > 3 * 864e5) continue;
    const { text, outlet } = wireCore.splitOutlet(title);
    items.push({ text, outlet, link, date: d.toISOString() });
  }
  return items;
}
async function news() {
  const feeds = [
    'https://news.google.com/rss/search?q=nvidia+OR+semiconductor+OR+%22hyperscaler+capex%22+OR+%22nasdaq+100%22&hl=en-US&gl=US&ceid=US:en',
    'https://news.google.com/rss/search?q=nasdaq+100+OR+QQQ&hl=en-US&gl=US&ceid=US:en',
  ];
  const all = [];
  for (const u of feeds) { try { all.push(...parseRss(await get(u, 'text', BR))); } catch (e) { console.log('  feed failed: ' + e.message); } }
  all.sort((a, b) => new Date(b.date) - new Date(a.date));
  return wireCore.cluster(all.filter((x) => keep(x.text))).slice(0, 6);
}

function drawdown(s) {
  let hi = -Infinity, hiT = null, maxDd = 0;
  for (const p of s) { if (p.c > hi) { hi = p.c; hiT = p.t; } maxDd = Math.min(maxDd, p.c / hi - 1); }
  const last = s[s.length - 1];
  return { now_pct: r1((last.c / hi - 1) * 100), max_pct: r1(maxDd * 100), days_since_high: Math.round((new Date(last.t) - new Date(hiT)) / 864e5) };
}

(async () => {
  const out = { updated: new Date().toISOString() };
  let w;
  try { w = await weights(); console.log('  ok   weights ' + w.rows.length); } catch (e) { console.log('  FAIL weights: ' + e.message); w = prev.weights; }
  if (!w) { console.error('no weights and no last-good copy'); process.exit(1); }
  out.weights = w;

  const hold = {};
  for (const r of w.rows) {
    try { hold[r.sym] = await series(r.sym.replace('.', '-'), '1y'); } catch (e) { console.log('  FAIL ' + r.sym + ': ' + e.message); }
    await sleep(350);
  }
  const qqq = await series('QQQ', '1y'); await sleep(350);
  const sox = await series('^SOX', '1y'); await sleep(350);
  const qqqe = await series('QQQE', '1y'); await sleep(350);
  let tnx = null; try { tnx = await series('^TNX', '1mo'); } catch { /* rates note is optional */ }

  out.windows = {};
  for (const [key, bars] of [['1M', 21], ['6M', 126], ['1Y', 400]]) {
    const q = qqq.slice(-(bars + 1)), R = q[q.length - 1].c / q[0].c - 1;
    const rows = [];
    for (const r of w.rows) {
      const s = hold[r.sym]; if (!s || s.length < 2) continue;
      const ss = s.slice(-(bars + 1)), ri = ss[ss.length - 1].c / ss[0].c - 1;
      const w0 = (r.w / 100) * (1 + R) / (1 + ri);
      rows.push({ sym: r.sym, bucket: bucket(r.sym), ret_pct: r1(ri * 100), c: r2(w0 * ri * 100) });
    }
    rows.sort((a, b) => Math.abs(b.c) - Math.abs(a.c));
    const sum = (b) => rows.filter((x) => x.bucket === b).reduce((a, x) => a + x.c, 0);
    const total = R * 100, listed = rows.reduce((a, x) => a + x.c, 0);
    out.windows[key] = {
      qqq_pct: r1(total), rows, other: r2(total - listed),
      buckets: { semis: r2(sum('semis')), spenders: r2(sum('spenders')), rest: r2(sum('rest') + (total - listed)) },
      share_pct: Math.abs(total) >= 1 ? Math.round(((sum('semis') + sum('spenders')) / total) * 100) : null,
      from: q[0].t,
    };
  }
  const six = (s) => s.slice(-127);
  const rb = (s) => { const x = six(s); return Array.from({ length: 40 }, (_, i) => { const p = x[Math.round(i * (x.length - 1) / 39)]; return { t: p.t, v: r1((p.c / x[0].c) * 100) }; }); };
  out.rebased = { qqq: rb(qqq), sox: rb(sox), qqqe: rb(qqqe) };
  const g = (s) => (s[s.length - 1].c / s[0].c - 1) * 100;
  out.gap_pts = r1(g(six(qqq)) - g(six(qqqe)));
  out.drawdown = { qqq: drawdown(qqq), sox: drawdown(sox) };
  const top = w.rows.slice();
  out.stats = {
    semis_weight_pct: r1(w.rows.filter((r) => SEMIS.has(r.sym)).reduce((a, r) => a + r.w, 0)),
    nvda_weight_pct: (w.rows.find((r) => r.sym === 'NVDA') || {}).w || null,
    top10_weight_pct: r1(top.slice(0, 10).reduce((a, r) => a + r.w, 0)),
    top25_weight_pct: r1(top.reduce((a, r) => a + r.w, 0)),
  };
  if (tnx && tnx.length > 1) out.rates = { level: r2(tnx[tnx.length - 1].c), change_bp_1m: Math.round((tnx[tnx.length - 1].c - tnx[0].c) * 100) };
  try { out.news = await news(); } catch (e) { out.news = prev.news || []; console.log('  FAIL news: ' + e.message); }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  const w6 = out.windows['6M'];
  console.log(`tech-tape.json: QQQ 6M ${w6.qqq_pct}%, AI share ${w6.share_pct}%, ${out.news.length} headlines`);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
