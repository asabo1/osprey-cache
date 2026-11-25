#!/usr/bin/env node
/**
 * Hourly mood snapshot (fear gauge + headline tone + correlation).
 * Runs in the intel workflow (3x/hour); one row per clock hour, upserted, so
 * extra runs in the same hour refine that row instead of adding one.
 *
 * Writes (all committed explicitly by data-intel.yml):
 *   public/data/mood-hourly.json   rolling 35 days of rows + corr
 *   public/data/mood-items.json    72h ledger of scored items (no double counting)
 *   data-archive/mood/YYYY-MM.jsonl  permanent history, one line per finished hour
 *
 * No LLM. Same scorer as the site (scripts/lib/tone.cjs). Spec: druP3
 * outputs-local/2026-11-25-v2-fear-sentiment.md. X posts join through
 * scripts/sources/x.cjs once X_BEARER_TOKEN exists (until then it returns nothing).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tone = require('./lib/tone.cjs');

const ROOT = path.join(__dirname, '..');
const D = (f) => path.join(ROOT, 'public', 'data', f);
const HOURLY = D('mood-hourly.json'), ITEMS = D('mood-items.json');
const ROLL_MS = 35 * 86400e3, LEDGER_MS = 72 * 3600e3;
const UA = 'Mozilla/5.0 (compatible; osprey-cache/1.0)';

const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } };

async function quote(sym) {
  try {
    const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?range=1d&interval=1d', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const m = (await r.json()).chart.result[0].meta;
    return { price: m.regularMarketPrice, t: m.regularMarketTime };
  } catch { return null; }
}

const decode = (s) => s.replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/<[^>]+>/g, '').trim();
const CHIPS_RX = /\b(semiconductors?|chips?|chipmakers?|hbm|dram|ddr\d|nand|memory|tsmc|nvidia|amd|sk hynix|samsung|micron|gpus?|wafers?|foundr(y|ies)|export controls?|asml|gallium|germanium|cowos|packaging)\b/i;
const AI_RX = /\b(data cent(er|re)s?|hyperscalers?|neoclouds?|stargate|coreweave|nebius|crusoe|ai (capex|spending|infrastructure)|gigawatts?|gw)\b/i;
const FEEDS = [
  { url: 'https://news.google.com/rss/search?q=(semiconductor+OR+chip+OR+HBM+OR+DRAM+OR+TSMC+OR+Nvidia)+(supply+OR+shortage+OR+prices+OR+export+OR+capacity)+when:3d&hl=en-US&gl=US&ceid=US:en', rx: CHIPS_RX, source: 'Chips' },
  { url: 'https://news.google.com/rss/search?q=(%22data+center%22+OR+hyperscaler+OR+neocloud+OR+Stargate)+(power+OR+gigawatt+OR+nuclear+OR+%22gas+turbine%22+OR+capex+OR+financing+OR+funding)+when:3d&hl=en-US&gl=US&ceid=US:en', rx: AI_RX, source: 'AI infra' }
];
async function feedItems(f) {
  try {
    const r = await fetch(f.url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return [];
    const xml = await r.text(), out = [];
    for (const b of (xml.match(/<item[\s>][\s\S]*?<\/item>/g) || []).slice(0, 12)) {
      const title = decode((b.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '');
      const pub = (b.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
      const link = decode((b.match(/<link[^>]*>([\s\S]*?)<\/link>/) || [])[1] || '');
      const d = pub ? new Date(pub) : new Date();
      if (!title || isNaN(d) || !f.rx.test(title) || Date.now() - d > 3 * 86400e3) continue;
      out.push({ text: title.replace(/\s[-–—]\s[^-–—]{2,40}$/, ''), link, date: d.toISOString(), severity: 'MKT', source: f.source, cluster_size: 1 });
    }
    return out;
  } catch { return []; }
}

const OFF_BEAT = /\b(soy(bean)?s?( oil| meal)?|palm oil|olive oil|vegetable oil|cooking oil|edible oils?|rapeseed|canola|sunflower oil|ammonia|urea|potash|fertili[sz]ers?|wheat|corn|sugar|coffee|cocoa)\b/i;
const HUMAN = /\b(swim(mer|mers|s|ming)?|marathon|triathlon|festival|concert|wedding|celebrity|football|soccer|cricket|nba|nfl|olympic\w*|world cup|tournament|golf|tennis|chef|recipe|obituary|dies at|charity|film|movie|novel)\b/i;
const idOf = (it) => crypto.createHash('sha1').update(it.link || it.text).digest('hex').slice(0, 16);

async function main() {
  const now = Date.now(), nowIso = new Date(now).toISOString();
  const hourIso = new Date(Math.floor(now / 3600e3) * 3600e3).toISOString().replace('.000Z', 'Z');
  const daily = readJson(D('daily.json'), {}), odds = readJson(D('odds.json'), {}), base = readJson(D('fear-baselines.json'), null);
  const hourly = readJson(HOURLY, { version: 'mood-v1', rows: [] });
  const prevLedger = readJson(ITEMS, { items: [] });

  // ---- items: cron wire (hormuz/oil) + chips and AI feeds, plus X when keyed ----
  let raw = (daily.intel || []).map((i) => ({ text: i.text, link: i.link, date: i.date, severity: i.severity || 'MKT', source: i.source, cluster_size: i.cluster_size || 1 }));
  const extra = await Promise.all(FEEDS.map(feedItems));
  raw = raw.concat(extra.flat());
  try {
    const x = require('./sources/x.cjs');
    const got = await x.fetchSince({ now });
    if (got && got.posts) raw = raw.concat(got.posts.map((p) => ({ text: p.text, link: 'x:' + p.id, date: p.ts, severity: 'MKT', source: 'x', cluster_size: p.cluster_size || 1 })));
  } catch (e) { console.error('x source skipped: ' + e.message); }

  const known = new Map(prevLedger.items.map((i) => [i.id, i]));
  const cold = !prevLedger.items.length;
  for (const it of raw) {
    if (!it.text || OFF_BEAT.test(it.text) || HUMAN.test(it.text)) continue;
    const id = idOf(it);
    if (known.has(id)) continue;
    const desk = tone.deskOf(it.text, undefined, it.source);
    known.set(id, {
      id, seen: cold ? it.date : nowIso, date: it.date, desk, tone: tone.tone(it.text, desk), severity: it.severity,
      cluster_size: it.cluster_size, filler: false, source: it.source === 'x' ? 'x' : 'wire'
    });
  }
  const ledger = [...known.values()].filter((i) => now - new Date(i.seen).getTime() < LEDGER_MS)
    .sort((a, b) => new Date(b.seen) - new Date(a.seen));

  // ---- market + fear ---------------------------------------------------------
  const syms = { vix: '^VIX', ovx: '^OVX', vxn: '^VXN', gvz: '^GVZ', move: '^MOVE', sox: '^SOX', brent: 'BZ=F', hyg: 'HYG', ief: 'IEF', qqq: 'QQQ' };
  const q = {};
  await Promise.all(Object.keys(syms).map(async (k) => { q[k] = await quote(syms[k]); }));
  const v = (k) => (q[k] ? q[k].price : null);
  const inputs = {
    vix: v('vix'), ovx: v('ovx'), vxn: v('vxn'), gvz: v('gvz'), move: v('move'), hyg: v('hyg'), ief: v('ief'), sox: v('sox'), brent: v('brent'),
    hormuz: daily.latest && typeof daily.latest.crisis_score === 'number' ? daily.latest.crisis_score : null,
    pm: tone.pmStress(odds, now)
  };
  const comp = tone.components(inputs, base);
  const lastRow = hourly.rows[hourly.rows.length - 1];
  const prevForLabel = lastRow && lastRow.t !== hourIso ? lastRow : hourly.rows[hourly.rows.length - 2];
  const fr = tone.fear(comp, prevForLabel && prevForLabel.fear && prevForLabel.fear.lab);
  const asof = {};
  ['ovx', 'vxn', 'gvz'].forEach((k) => { if (q[k]) asof[k] = new Date(q[k].t * 1000).toISOString().slice(0, 10); });

  const agg = tone.aggregate(ledger, now);
  const toneRow = {};
  Object.keys(agg).forEach((d) => { toneRow[d] = { wire: agg[d], x: null }; });
  const rnd = (x) => (x == null ? null : Math.round(x * 100) / 100);
  const row = {
    t: hourIso,
    fear: { oil: fr.oil, ai: fr.ai, composite: fr.composite, partial: fr.partial.oil || fr.partial.ai, lab: fr.lab, comp: fr.comp, asof },
    tone: toneRow,
    x_volume: null,
    mkt: { brent: rnd(v('brent')), sox: rnd(v('sox')), qqq: rnd(v('qqq')), vix: rnd(v('vix')) }
  };

  // ---- upsert the hour, archive the finished one, roll 35 days ----------------
  const archiveDir = path.join(ROOT, 'data-archive', 'mood');
  if (lastRow && lastRow.t !== hourIso) {
    fs.mkdirSync(archiveDir, { recursive: true });
    const f = path.join(archiveDir, lastRow.t.slice(0, 7) + '.jsonl');
    const tail = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').pop() : '';
    if (!tail.includes('"t":"' + lastRow.t + '"')) fs.appendFileSync(f, JSON.stringify(lastRow) + '\n');
  }
  hourly.rows = hourly.rows.filter((r) => r.t !== hourIso && now - new Date(r.t).getTime() < ROLL_MS);
  hourly.rows.push(row);
  hourly.version = 'mood-v1';
  hourly.updated = nowIso;
  hourly.corr = tone.corr(hourly.rows);
  fs.writeFileSync(HOURLY, JSON.stringify(hourly));
  fs.writeFileSync(ITEMS, JSON.stringify({ version: 'mood-v1', updated: nowIso, items: ledger }));

  const L = fr.lab;
  console.log('fear oil ' + fr.oil + ' (' + L.oil + '), ai ' + fr.ai + ' (' + L.ai + '), composite ' + fr.composite + ' (' + L.composite + ')');
  console.log('inputs ' + JSON.stringify(inputs));
  Object.keys(agg).forEach((d) => console.log('tone ' + d + ': ' + JSON.stringify(agg[d])));
  console.log('rows ' + hourly.rows.length + ', ledger ' + ledger.length + (cold ? ' (cold start)' : ''));
}

main().catch((e) => { console.error('mood snapshot failed: ' + e.message); process.exit(1); });
