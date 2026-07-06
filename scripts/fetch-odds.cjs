#!/usr/bin/env node
/**
 * Prediction-market odds for the Hormuz desk, from Polymarket's public Gamma
 * API (keyless, documented rate limits; display with attribution is the
 * sanctioned use — Polymarket ships an embed product for exactly this).
 * Kalshi was evaluated and REJECTED: its Data Terms prohibit public display
 * without written consent (verified 2026-07-01).
 *
 * Turnover-proof by design (advisor-mandated): no hardcoded market slugs —
 * markets resolve and die within weeks. We query by TAG, filter to live +
 * relevant + liquid, and take the top by volume. When nothing qualifies,
 * odds.json carries an empty list and the desk strip renders nothing.
 *
 * Writes public/data/odds.json. Runs in the intel-fetch workflow.
 */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'public', 'data', 'odds.json');
const TAGS = ['iran', 'oil', 'middle-east'];
const RELEVANT = /\b(hormuz|strait|iran|iranian|oil|crude|brent|wti|opec|tanker)\b/i;
const MIN_VOLUME = 500000; // USD lifetime; below this the "market says" framing overstates it
const MAX_SHOWN = 4;

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'CrudeSignal/1.0 (+https://crudesignal.io)' } });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  return res.json();
}

function bestMarket(event) {
  // An event can hold several binary submarkets (date ladders); cite the most
  // traded one that is still open.
  const now = Date.now();
  let best = null;
  for (const m of event.markets || []) {
    if (m.closed) continue;
    const end = m.endDate ? new Date(m.endDate).getTime() : null;
    if (end && end < now) continue;
    let outcomes, prices;
    try {
      outcomes = JSON.parse(m.outcomes || '[]');
      prices = JSON.parse(m.outcomePrices || '[]');
    } catch { continue; }
    const yesIdx = outcomes.findIndex((o) => String(o).toLowerCase() === 'yes');
    if (yesIdx < 0 || prices[yesIdx] == null) continue;
    const vol = Number(m.volume || m.volumeNum || 0);
    if (!best || vol > best.vol) {
      best = { question: m.question || event.title, yes: Number(prices[yesIdx]), vol, end: m.endDate || event.endDate || null };
    }
  }
  return best;
}

async function main() {
  const now = Date.now();
  const seen = new Set();
  const candidates = [];

  for (const tag of TAGS) {
    let events = [];
    try {
      events = await getJson('https://gamma-api.polymarket.com/events?tag_slug=' + tag + '&closed=false&order=volume&ascending=false&limit=25');
    } catch (e) {
      console.error('tag ' + tag + ' failed: ' + e.message);
      continue;
    }
    for (const ev of events) {
      if (!ev || !ev.slug || seen.has(ev.slug)) continue;
      seen.add(ev.slug);
      // the API's closed=false still returns resolved-but-unsettled events;
      // enforce liveness and relevance ourselves
      const end = ev.endDate ? new Date(ev.endDate).getTime() : null;
      if (end && end < now) continue;
      if (!RELEVANT.test(ev.title || '')) continue;
      const vol = Number(ev.volume || 0);
      if (vol < MIN_VOLUME) continue;
      const m = bestMarket(ev);
      if (!m || m.yes <= 0 || m.yes >= 1) continue;
      candidates.push({
        title: ev.title,
        question: m.question,
        yes_pct: +(m.yes * 100).toFixed(1),
        volume: Math.round(vol),
        end: m.end,
        url: 'https://polymarket.com/event/' + ev.slug,
        slug: ev.slug,
      });
    }
  }

  // Relevance-tiered, volume-sorted within tier: this is a strait desk, so a
  // $11M Hormuz market outranks a $39M regime-politics market.
  const tierOf = (t) => (/\b(hormuz|strait)\b/i.test(t) ? 0 : /\b(oil|crude|brent|wti|opec|tanker)\b/i.test(t) ? 1 : 2);
  candidates.sort((a, b) => (tierOf(a.title) - tierOf(b.title)) || (b.volume - a.volume));

  // Date-ladder families ("...by July 15?" / "by July 31?" / "by December 31?")
  // collapse to ONE entry carrying the term structure — the ladder of odds
  // over horizons is the story, and three slots of one question is not.
  const famKey = (t) => String(t).toLowerCase().replace(/\b(by|before|until)\b.*$/, '').replace(/[^a-z ]/g, '').trim();
  const families = new Map();
  for (const c of candidates) {
    const k = famKey(c.title);
    if (!families.has(k)) {
      families.set(k, c);
    } else {
      const f = families.get(k);
      f.ladder = f.ladder || [{ end: f.end, yes_pct: f.yes_pct }];
      f.ladder.push({ end: c.end, yes_pct: c.yes_pct });
      f.volume += c.volume;
    }
  }
  const markets = Array.from(families.values()).slice(0, MAX_SHOWN);
  for (const m of markets) {
    if (m.ladder) m.ladder.sort((a, b) => new Date(a.end) - new Date(b.end));
  }

  // carry the previous poll's odds so the desk can show drift
  let prev = {};
  try {
    const old = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    for (const m of old.markets || []) prev[m.slug] = m.yes_pct;
  } catch {}
  for (const m of markets) {
    if (prev[m.slug] != null && prev[m.slug] !== m.yes_pct) m.prev_pct = prev[m.slug];
  }

  fs.writeFileSync(OUT, JSON.stringify({ updated: new Date().toISOString(), source: 'Polymarket', markets }, null, 1));
  console.log('odds.json: ' + markets.length + ' markets' + (markets.length ? ' — top: ' + markets[0].title + ' @ ' + markets[0].yes_pct + '%' : ' (strip will hide)'));
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
