#!/usr/bin/env node
/*
 * wire-synthesis.cjs — the Hormuz Desk moat.
 *
 * Reads public/data/daily.json (the wire source), asks Claude to SYNTHESIZE
 * (not reblog) the top headlines into:
 *   1. a one-line "latest driver" connecting the top news to the Brent move, and
 *   2. a <=14-word "what it means" take on the top 3 wire items.
 * Writes the result back into daily.json under the `synthesis` key. The page
 * (DriverLine.astro + WireChronicle.astro) renders it client-side.
 *
 * Inference: GitHub Models (free, OpenAI-compatible), authenticated with the
 * GitHub Actions built-in GITHUB_TOKEN. No API key to provision. The cron runs
 * in Actions, so the token is already there; the workflow only needs a
 * `permissions: models: read` grant. Endpoint deprecation note: the old
 * models.inference.ai.azure.com host is dead (Oct 2025); use models.github.ai.
 *
 * Cost control: only calls the model when the top headline changes or Brent moves
 * >1.5% since the last synthesis (dedup signature stored in synthesis.based_on /
 * synthesis.brent). Quiet hours => zero calls. Non-fatal: any failure logs and
 * exits 0 so it never breaks the intel cron.
 *
 * Usage: GITHUB_TOKEN=... node scripts/wire-synthesis.cjs [--dry-run] [--force]
 */
const fs = require('fs');
const path = require('path');

const DAILY = path.join(__dirname, '..', 'public', 'data', 'daily.json');
const API_URL = 'https://models.github.ai/inference/chat/completions';
const MODEL = process.env.SYNTH_MODEL || 'openai/gpt-4o'; // GitHub Models free (high tier: 50 req/day); we use 1-4/day. Stronger than 4o-mini for sharp synthesis.
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.MODELS_TOKEN;
const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

// Editorial backdrop — keep in sync with src/lib/hormuz-status.ts.
const STATUS_PHRASE = 'open but contested under a fragile US-Iran ceasefire';
const BACKDROP =
  'Structural backdrop: a global supply glut and soft demand have kept Brent near multi-month lows (down from a ~$126 wartime peak), so even kinetic Hormuz headlines have produced only muted, fading price spikes. The war-risk premium is being capped by oversupply.';

// Mirror WireChronicle.astro's dedupe key so takes line up with rendered rows.
function rowKey(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 70);
}

function log(m) { process.stdout.write('[wire-synthesis] ' + m + '\n'); }

async function callModel(system, user) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + TOKEN,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 600,
      temperature: 0.4,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error('Models API ' + res.status + ': ' + (await res.text()).slice(0, 400));
  const data = await res.json();
  const c = data.choices && data.choices[0] && data.choices[0].message;
  return (c && c.content) ? c.content : '';
}

function parseJson(txt) {
  // Strip code fences and grab the first {...} block.
  let s = txt.replace(/```json/gi, '').replace(/```/g, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a !== -1 && b !== -1) s = s.slice(a, b + 1);
  return JSON.parse(s);
}

(async () => {
  try {
    if (!TOKEN) { log('no GITHUB_TOKEN — skip'); return; }
    if (!fs.existsSync(DAILY)) { log('no daily.json — skip'); return; }

    const d = JSON.parse(fs.readFileSync(DAILY, 'utf8'));
    const brent = d.latest && typeof d.latest.brent === 'number' ? d.latest.brent : null;
    const delta = d.latest && typeof d.latest.brent_delta === 'number' ? d.latest.brent_delta : null;
    const crisis = d.latest && d.latest.crisis_score != null ? d.latest.crisis_score : null;

    // Top real-news headlines (intel feed, newest first, drop empties).
    const intel = (d.intel || []).filter(it => it && it.text && it.date);
    if (!intel.length) { log('no intel headlines — skip'); return; }
    const top = intel.slice(0, 8);
    const topHeadline = top[0].text;

    // Dedup: skip unless the lead story changed or Brent moved >1.5%.
    const prev = d.synthesis || null;
    if (!FORCE && prev && prev.based_on === topHeadline && prev.brent && brent) {
      const movePct = Math.abs((brent - prev.brent) / prev.brent) * 100;
      if (movePct <= 1.5) { log('no change (same lead, Brent ' + movePct.toFixed(1) + '%) — skip'); return; }
    }

    const headlinesBlock = top.map((it, i) =>
      `${i + 1}. "${it.text}"${it.source ? ' (' + it.source + ')' : ''}${it.direction && it.direction !== 'NEUTRAL' ? ' [' + it.direction + ']' : ''}`
    ).join('\n');

    const priceLine = brent != null
      ? `Brent is $${brent.toFixed(2)}/bbl${delta != null ? ' (' + (delta >= 0 ? '+' : '') + delta.toFixed(2) + ' on the day)' : ''}. Crisis score ${crisis}/100.`
      : 'Live Brent unavailable.';

    const moveWord = delta == null ? 'roughly flat' : delta > 0.05 ? `up ${delta.toFixed(2)}` : delta < -0.05 ? `down ${Math.abs(delta).toFixed(2)}` : 'roughly flat';

    const system =
      'You are the desk editor for the desk, a real-time oil and Strait of Hormuz intelligence wire. ' +
      'Explain WHAT THE NEWS MEANS FOR OIL PRICES. Synthesize the implication; never restate the headline. ' +
      'Get the direction right: escalation, strikes, attacks, closures, and seizures push the war premium UP; ' +
      'de-escalation, ceasefires, talks, de-mining, and reopening let it bleed DOWN. ' +
      'If the actual price move seems to contradict the dominant story, reconcile it (a small risk bid still lingering from recent strikes, or the supply glut capping any spike). ' +
      'Write plain, confident, falsifiable sentences for traders and journalists. ' +
      'Banned: hedging filler ("amid ongoing", "could", "supply fears", "uncertainty remains", "navigating"), jargon, emojis, and double dashes. ' +
      'Be specific, not vague.';

    const user =
      `The Strait of Hormuz is ${STATUS_PHRASE}.\n` +
      `${priceLine}\n${BACKDROP}\n\n` +
      `TOP WIRE HEADLINES (newest first):\n${headlinesBlock}\n\n` +
      `Return ONLY this JSON (no prose around it):\n` +
      `{\n` +
      `  "driver": "ONE sentence, max 30 words: name the dominant force moving oil right now and reconcile it with the actual Brent move (${moveWord}). Lead with the cause, state the direction, and name what is driving or capping it. No filler.",\n` +
      `  "takes": [\n` +
      `    {"n": 1, "take": "<=14 words: the IMPLICATION of headline 1 for oil supply or price, with the correct direction. Not a restatement. Empty string if it is noise or not oil-relevant."},\n` +
      `    {"n": 2, "take": "<=14 words for headline 2, same rule."},\n` +
      `    {"n": 3, "take": "<=14 words for headline 3, same rule."},\n` +
      `    {"n": 4, "take": "<=14 words for headline 4, same rule."},\n` +
      `    {"n": 5, "take": "<=14 words for headline 5, same rule."}\n` +
      `  ]\n` +
      `}`;

    log('synthesizing (lead: "' + topHeadline.slice(0, 60) + '...")');
    const raw = await callModel(system, user);
    const out = parseJson(raw);
    if (!out.driver || typeof out.driver !== 'string') throw new Error('no driver in response');

    // Map takes onto the wire dedupe keys so rows can look them up.
    const takes = {};
    (out.takes || []).forEach(t => {
      const idx = (t.n || 0) - 1;
      if (idx < 0 || idx >= top.length) return;
      const take = String(t.take || '').trim();
      if (take) takes[rowKey(top[idx].text)] = take;
    });

    const synthesis = {
      updated: d.updated || d.intel_updated || null,
      driver: out.driver.trim(),
      based_on: topHeadline,
      brent: brent,
      brent_delta: delta,
      takes,
    };

    if (DRY) { log('DRY RUN — would write:\n' + JSON.stringify(synthesis, null, 2)); return; }

    d.synthesis = synthesis;
    fs.writeFileSync(DAILY, JSON.stringify(d, null, 2) + '\n');
    log('wrote synthesis (' + Object.keys(takes).length + ' takes). driver: ' + synthesis.driver);
  } catch (e) {
    log('FAILED (non-fatal): ' + (e && e.message ? e.message : e));
    // exit 0 — never break the intel cron
  }
})();
