#!/usr/bin/env node
/**
 * QQQ tracker data -> public/data/qqq.json. Second personal tracker after
 * PSIL (gated, Markets menu). Lean by design: QQQ is a mega-liquid index
 * ETF, so the job is price + trend + the tech tape — not PSIL's
 * catalyst/short-interest machinery.
 *
 * Sources: Yahoo v8 chart (same server-side pattern as the oil fetchers;
 * CORS-blocked client-side, fine in cron) + Google News/Yahoo RSS headlines.
 * Runs in intel-fetch; qqq.json MUST stay in that workflow's git-add list
 * (the odds.json lesson: an explicit add-list silently discards new files).
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const wireCore = require('./lib/wire-core.cjs');

const OUT = path.join(__dirname, '..', 'public', 'data', 'qqq.json');

function get(host, p) {
  return new Promise((resolve, reject) => {
    https.get({ hostname: host, path: p, headers: { 'User-Agent': 'CrudeSignal/1.0' } }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

async function chart() {
  const raw = await get('query1.finance.yahoo.com', '/v8/finance/chart/QQQ?interval=1d&range=6mo');
  const r = JSON.parse(raw).chart.result[0];
  const meta = r.meta || {};
  const ts = r.timestamp || [];
  const closes = (r.indicators.quote[0].close || []).map((v, i) => ({ t: ts[i] * 1000, p: v })).filter((x) => x.p != null);
  const last = closes[closes.length - 1];
  // NOT meta.chartPreviousClose: on a ranged chart that is the close before
  // the RANGE START (6 months ago) — the same _prev-basis bug this repo fixed
  // for oil in PR #4. Yesterday = second-to-last series close.
  const prev = meta.regularMarketPreviousClose != null ? meta.regularMarketPreviousClose : (closes[closes.length - 2] || {}).p;
  const price = meta.regularMarketPrice != null ? meta.regularMarketPrice : last.p;
  const first = closes[0];
  const mo1 = closes[closes.length - 22] || first;
  const yrHi = Math.max(...closes.map((c) => c.p));
  const yrLo = Math.min(...closes.map((c) => c.p));
  return {
    price: +price.toFixed(2),
    prev_close: prev != null ? +prev.toFixed(2) : null,
    day_delta_pct: prev ? +(((price - prev) / prev) * 100).toFixed(2) : null,
    mo1_pct: mo1 ? +(((price - mo1.p) / mo1.p) * 100).toFixed(1) : null,
    mo6_pct: first ? +(((price - first.p) / first.p) * 100).toFixed(1) : null,
    range6mo: { hi: +yrHi.toFixed(2), lo: +yrLo.toFixed(2) },
    series: closes.map((c) => ({ t: c.t, p: +c.p.toFixed(2) })),
    market_time: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
  };
}

const EXCLUDE = /\b(cartoon|opinion|quiz|podcast|recipe|horoscope|crossword|listicle|gallery)\b/i;
// exchange-PR and promo noise the Google feeds carry
const NOISE = /rings the (opening|closing) bell|press release|sponsored|promoted|prime day|deal(s)? of the day/i;

function parseRss(xml, capN) {
  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/g) || [];
  const decode = (s) => String(s || '')
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/<[^>]+>/g, '').trim();
  for (const b of blocks.slice(0, capN)) {
    const title = decode((b.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1]);
    const pub = (b.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
    const link = decode((b.match(/<link[^>]*>([\s\S]*?)<\/link>/) || [])[1]);
    if (!title || EXCLUDE.test(title) || NOISE.test(title)) continue;
    const d = pub ? new Date(pub) : new Date();
    if (isNaN(d.getTime()) || Date.now() - d.getTime() > 3 * 24 * 3600 * 1000) continue;
    const { text, outlet } = wireCore.splitOutlet(title);
    items.push({ text, outlet, link, date: d.toISOString() });
  }
  return items;
}

async function news() {
  const feeds = [
    'https://news.google.com/rss/search?q=nasdaq+100+OR+QQQ&hl=en-US&gl=US&ceid=US:en',
    'https://news.google.com/rss/search?q=%22big+tech%22+earnings+OR+guidance&hl=en-US&gl=US&ceid=US:en',
  ];
  const all = [];
  for (const url of feeds) {
    try {
      const u = new URL(url);
      all.push(...parseRss(await get(u.hostname, u.pathname + u.search), 12));
    } catch (e) {
      console.error('feed failed: ' + e.message);
    }
  }
  all.sort((a, b) => new Date(b.date) - new Date(a.date));
  return wireCore.cluster(all).slice(0, 14);
}

(async () => {
  const [c, n] = await Promise.all([chart(), news()]);
  const out = { updated: new Date().toISOString(), ticker: 'QQQ', name: 'Invesco QQQ Trust (Nasdaq-100)', ...c, news: n };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log('qqq.json: $' + c.price + ' (' + (c.day_delta_pct > 0 ? '+' : '') + c.day_delta_pct + '%), ' + n.length + ' headlines');
})().catch((e) => { console.error(e.message || e); process.exit(1); });
