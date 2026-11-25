#!/usr/bin/env node
/*
 * ai-weekly.cjs — "What changed this week in AI infrastructure" (2026-11-25).
 *
 * Collects the last seven days of headlines on the AI infrastructure value
 * chain (power for data centers, fabs and tools, packaging, memory, chips,
 * data-center builders, money) from Google News RSS searches, then asks a
 * GitHub Models LLM (keyless in Actions, same as wire-synthesis.cjs) to group
 * them into a few plain-language bullets. Writes public/data/ai-weekly.json,
 * which the site's AI infrastructure report renders.
 *
 * Guardrails, because the output is public:
 *   - each bullet must cite the headline numbers it rests on;
 *   - every figure in a bullet must appear verbatim in one of its cited
 *     headlines, or the bullet is dropped (the model cannot invent numbers);
 *   - banned language (investment advice, hype, desk process) drops a bullet;
 *   - fewer than 3 surviving bullets: the previous file is kept unchanged.
 * Non-fatal: any failure logs and exits 0.
 *
 * Usage: GITHUB_TOKEN=... node scripts/ai-weekly.cjs [--dry-run]
 */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'public', 'data', 'ai-weekly.json');
const API_URL = 'https://models.github.ai/inference/chat/completions';
const MODEL = process.env.AIW_MODEL || 'openai/gpt-4o';
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.MODELS_TOKEN;
const DRY = process.argv.includes('--dry-run');
const WEEK_MS = 7 * 24 * 3600 * 1000;

const LAYERS = {
  power: 'data center power OR "AI data center" electricity OR nuclear OR "gas turbine" deal',
  fabs: 'semiconductor fab OR foundry OR "2nm" OR ASML OR "chip plant"',
  memory: 'HBM OR DRAM OR "memory chip" OR DDR5 OR "SK hynix" OR Micron',
  chips: '"AI chip" OR accelerator OR Nvidia OR "custom chip" OR TPU OR Trainium',
  builders: '"data center" AI capacity OR neocloud OR CoreWeave OR Nebius OR Crusoe OR Stargate',
  money: 'AI infrastructure investment OR "data center" financing OR "AI capex" OR "AI chip startup" funding',
};
const RELEVANT = /\b(ai|data cent(er|re)s?|chips?|semiconductors?|hbm|dram|ddr\d|memory|nvidia|tsmc|asml|foundr(y|ies)|fab|gpus?|accelerators?|power|nuclear|turbines?|grid|electricity|capex|stargate|coreweave|nebius|crusoe|hyperscalers?)\b/i;
// Stock-tip listicles and advice headlines are not news on the value chain.
const TIP_HEADLINE = /\b(stocks? (to|that|for)|why you|should you|(top|best) \d+|\d+ (stocks|ways|reasons)|dividend|price target|buy (now|the dip)|here'?s why|vs\.? |is it time|millionaire|my (top|favorite))\b/i;
const TIP_OUTLETS = /^(the motley fool|motley fool|24\/7 wall st\.?|zacks|investorplace|seeking alpha|benzinga|yahoo finance|tikr|stocktwits|marketbeat|simply wall st\.?|finviz|gurufocus|the globe and mail \(stocks\))$/i;
const BANNED = /\b(buy|sell|invest(ors)? should|price target|to the moon|game[- ]changer|revolutionary|skyrocket|we (were|are) late|our (pipeline|desk|process))\b/i;

function log(m) { process.stdout.write('[ai-weekly] ' + m + '\n'); }
function decode(s) {
  return String(s || '').replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/<[^>]+>/g, '').trim();
}

async function fetchLayer(layer, q) {
  const url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(q + ' when:7d') + '&hl=en-US&gl=US&ceid=US:en';
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'CrudeSignal/1.0 (+https://crudesignal.io)' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return [];
    const xml = await r.text();
    return (xml.match(/<item[\s>][\s\S]*?<\/item>/g) || []).slice(0, 25).map(b => {
      const raw = decode((b.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1]);
      const m = raw.match(/\s[-–—]\s([^-–—]{2,40})$/);
      return {
        layer, title: m ? raw.slice(0, m.index).trim() : raw, outlet: m ? m[1].trim() : '',
        link: decode((b.match(/<link[^>]*>([\s\S]*?)<\/link>/) || [])[1]),
        date: new Date((b.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || 0).toISOString(),
      };
    }).filter(i => i.title && RELEVANT.test(i.title) && !TIP_HEADLINE.test(i.title) && !TIP_OUTLETS.test(i.outlet) && Date.now() - new Date(i.date).getTime() < WEEK_MS);
  } catch (e) { log(layer + ' fetch failed: ' + e.message); return []; }
}

async function callModel(system, user) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
    body: JSON.stringify({ model: MODEL, max_tokens: 900, temperature: 0.2, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error('Models API ' + res.status + ': ' + (await res.text()).slice(0, 300));
  const d = await res.json();
  const c = d.choices?.[0]?.message?.content || '';
  if (!c.includes('{')) throw new Error('model returned no JSON: ' + c.slice(0, 80));
  return c;
}

function parseJson(txt) {
  let s = txt.replace(/```json/gi, '').replace(/```/g, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  return JSON.parse(s.slice(a, b + 1));
}

// Every number in the bullet must appear in one of its cited headlines.
function numbersOk(text, cited) {
  const nums = String(text).match(/\$?\d[\d,.]*\s?(%|percent|billion|million|trillion|bn|gw|mw|nm|gb|tb|x)?/gi) || [];
  const hay = cited.map(c => c.title.toLowerCase()).join(' | ');
  return nums.every(n => hay.includes(n.toLowerCase().replace(/\s+/g, ' ').trim().replace(/^\$/, '').split(/\s/)[0]));
}

// Model-free digest: per layer, the stories most outlets covered this week,
// newest first. No generated sentences, so nothing to fact-check but the
// headlines themselves. (GitHub Models has answered every request with a bare
// "OK" since about July 2026, so the summary step is optional.)
function digest(all) {
  const groups = new Map();
  for (const h of all) {
    const k = h.title.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length > 3).slice(0, 5).sort().join(' ');
    const g = groups.get(k);
    if (g) { g.coverage++; if (new Date(h.date) > new Date(g.date)) Object.assign(g, { title: h.title, outlet: h.outlet, link: h.link, date: h.date }); }
    else groups.set(k, { ...h, coverage: 1 });
  }
  const byLayer = {};
  for (const g of groups.values()) (byLayer[g.layer] = byLayer[g.layer] || []).push(g);
  return Object.keys(LAYERS).map(layer => ({
    layer,
    items: (byLayer[layer] || []).sort((a, b) => b.coverage - a.coverage || new Date(b.date) - new Date(a.date)).slice(0, 4)
      .map(({ layer: _l, ...x }) => x),
  })).filter(l => l.items.length);
}

(async () => {
  try {
    const all = (await Promise.all(Object.entries(LAYERS).map(([k, q]) => fetchLayer(k, q)))).flat();
    log(all.length + ' raw headlines');
    if (all.length < 10) { log('too few headlines, keep previous file'); return; }
    const layers = digest(all);
    const doc = { updated: new Date().toISOString(), week_ending: new Date().toISOString().slice(0, 10), mode: 'headlines', layers, headline_count: all.length };
    // Optional summary bullets, only when a model answers with valid JSON and the guards pass.
    if (TOKEN) {
      try {
        const heads = layers.flatMap(l => l.items.map(it => ({ ...it, layer: l.layer })));
        const block = heads.map((h, i) => `${i + 1}. [${h.layer}] ${h.title}${h.outlet ? ' (' + h.outlet + ')' : ''}`).join('\n');
        const system = 'You are the editor of a plain-language briefing on AI infrastructure. Group these headlines into 4 to 6 bullets on what actually changed. One or two sentences each; name the companies; use only facts in the headlines you cite; copy any number exactly from a cited headline; no investment advice or hype. Return JSON only: {"bullets":[{"layer":"...","text":"...","cites":[headline numbers]}]}';
        const out = parseJson(await callModel(system, block));
        const bullets = (out.bullets || []).map(b => ({ layer: b.layer, text: String(b.text || '').trim(), cited: (b.cites || []).map(n => heads[n - 1]).filter(Boolean) }))
          .filter(b => b.text && b.cited.length && !BANNED.test(b.text) && numbersOk(b.text, b.cited))
          .map(b => ({ layer: b.layer, text: b.text, sources: b.cited.map(c => ({ title: c.title, outlet: c.outlet, link: c.link })) }));
        if (bullets.length >= 3) { doc.bullets = bullets; doc.mode = 'summary+headlines'; }
        log(bullets.length + ' summary bullets survived the guards');
      } catch (e) { log('summary step skipped: ' + (e.message || e).slice(0, 120)); }
    }
    if (DRY) { console.log(JSON.stringify(doc, null, 1).slice(0, 2500)); return; }
    fs.writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n');
    log('wrote ' + OUT + ' (' + doc.mode + ', ' + layers.length + ' layers)');
  } catch (e) { log('failed (non-fatal): ' + (e.message || e)); }
})();
