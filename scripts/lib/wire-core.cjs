/* Shared wire logic: relevance/severity/direction classification, outlet
 * extraction, and story clustering. Required by BOTH scripts/fetch-intel.cjs
 * (cron path) and src/pages/api/wire.json.ts (live serverless route) so the
 * two pipelines can never drift again (audit 2026-07-01 found they disagreed
 * on severity tiers and rendered different feeds).
 *
 * All keyword regexes use word boundaries: the audit caught bare /war/
 * tagging "WARSH" (Fed chair) equities headlines as CRIT war news.
 */

var KEYWORDS = /\b(hormuz|strait|crude|brent|wti|oil|opec|iran|iranian|sanction|sanctions|tanker|tankers|shipping|freight|blockade|barrel|barrels|petroleum|refinery|refiner|pipeline|geopolitical|lng|diesel|gasoline|vlcc|suezmax|aframax)\b/i;
var EXCLUDE = /\b(cartoon|opinion|quiz|podcast|recipe|horoscope|crossword|listicle|gallery)\b|book review|tv review|film review/i;
var CRIT = /\b(attack|attacks|attacked|strike|strikes|struck|blockade|blockaded|closed|closure|war|wars|killed|explosion|missile|missiles|drone|drones|seize|seized|seizure|mine|mined|mines|hijack|hijacked|boarded)\b/i;
var WARN = /\b(warning|warns|risk|risks|premium|surge|surges|spike|spikes|record|escalate|escalates|escalation|threaten|threatens|threatened|deadline|standoff|stand-off)\b/i;
var BULL = /\b(attack|attacks|strike|strikes|bomb|bombs|missile|missiles|explosion|troops|deploy|deployed|outage|reroute|rerouted)\b|blockade.{0,12}extend|hormuz.{0,12}closed|war.{0,12}escalat|sanction.{0,12}impose|reserve.{0,12}(exhaust|deplet)|talks.{0,12}(fail|stall|collapse)|\bno deal\b|\breject(s|ed)?\b|supply.{0,12}(disrupt|tight)|cut.{0,12}production|force majeure|premium.{0,12}surge|insurance.{0,12}surge|demand.{0,12}surge/i;
var BEAR = /\b(ceasefire|cease-fire|peace|reopen|reopens|reopened|surplus|oversupply|diplomacy|stand-down)\b|\b(deal|agreement)\b.{0,20}\b(reach|sign|near|close)\w*|hormuz.{0,12}open|de-escalat|\bwithdraw\w*\b|sanction.{0,12}(lift|ease)|reserve.{0,12}release|opec.{0,12}(increase|add|boost)|production.{0,12}increase|supply.{0,12}recover|talks.{0,12}(progress|advance|resume)|\bnegotiat\w+\b|demand.{0,12}(weak|slow)|inventory.{0,12}build|rig count.{0,12}(rise|up)/i;

function classify(text) {
  return {
    relevant: KEYWORDS.test(text) && !EXCLUDE.test(text),
    severity: CRIT.test(text) ? 'CRIT' : WARN.test(text) ? 'WARN' : 'MKT',
    direction: BULL.test(text) ? 'BULL' : BEAR.test(text) ? 'BEAR' : 'NEUTRAL',
  };
}

// Stricter gate for shipping-industry feeds (gCaptain, Splash247, Hellenic,
// FreightWaves): most of their volume is dry-bulk/containers/port-labor, which
// KEYWORDS admits via generic tanker/shipping/freight words and would swamp
// the oil signal. These feeds must hit an energy-specific token.
var OIL_STRICT = /\b(crude|brent|wti|oil|petroleum|opec|hormuz|vlcc|suezmax|aframax|lng|bunker|diesel|gasoline|sanction|sanctions|iran|iranian)\b/i;

function feedRelevant(text, gate) {
  var cls = classify(text);
  if (!cls.relevant) return false;
  if (gate === 'oil' && !OIL_STRICT.test(text)) return false;
  return true;
}

// Google News (and most aggregators) append " - Outlet Name" to titles. Pull
// the real publisher into its own field; the feed name is a topic, not a source.
function splitOutlet(title) {
  var t = String(title || '').trim();
  // charclass includes accented Latin: live feeds carry outlets like
  // "Anadolu Ajansı" and "Le Monde" that plain A-Za-z misses
  var m = t.match(/\s[-–—]\s([A-Za-zÀ-ɏ][A-Za-z0-9À-ɏ\s.&'’]{1,40})$/);
  if (m) return { text: t.slice(0, m.index).trim(), outlet: m[1].trim() };
  return { text: t, outlet: null };
}

// --- story clustering ---------------------------------------------------
// Same story from N outlets should occupy ONE wire slot (audit: 36% of the
// live wire was duplicate coverage of 4 events). Overlap on unigrams finds
// same-story pairs; a bigram check keeps directional mirrors apart
// ("US strikes Iran" vs "Iran strikes US" share every unigram but few bigrams).

var STOP = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'as', 'and', 'for', 'with', 'by', 'at', 'is', 'are', 'was', 'were', 'be', 'been', 'has', 'have', 'had', 'its', 'his', 'her', 'their', 'this', 'that', 'after', 'amid', 'over', 'from', 'into', 'says', 'say', 'said', 'live', 'update', 'updates', 'news', 'report', 'reports', 'breaking', 'insiders', 'for insiders']);

function tokensOf(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9\s$%]/g, ' ').split(/\s+/)
    .filter(function (w) { return w && !STOP.has(w) && (w.length >= 3 || w === 'us' || w === 'eu' || w === 'un'); });
}

function overlap(aSet, bSet) {
  var small = aSet.size <= bSet.size ? aSet : bSet;
  var big = aSet.size <= bSet.size ? bSet : aSet;
  if (!small.size) return 0;
  var n = 0;
  small.forEach(function (t) { if (big.has(t)) n++; });
  return n / small.size;
}

function bigramsOf(toks) {
  var out = new Set();
  for (var i = 0; i < toks.length - 1; i++) out.add(toks[i] + ' ' + toks[i + 1]);
  return out;
}

// Oil headlines share a narrow vocabulary, so two OPPOSITE stories can clear
// any token threshold ("Oil rises as tensions grow" / "Oil falls on ceasefire
// hopes"). A false merge deletes a real story and corrupts the bull/bear
// sentiment counts — worse than a duplicate. Two guards (advisor-mandated):
// never merge across opposing direction tags, and never merge a price-up
// headline with a price-down one.
var PRICE_UP = /\b(rise|rises|rising|rally|rallies|climb|climbs|gain|gains|jump|jumps|surge|surges|up)\b/i;
var PRICE_DOWN = /\b(fall|falls|falling|drop|drops|slide|slides|decline|declines|sink|sinks|slump|slumps|tumble|tumbles|down|lower)\b/i;

function opposed(aText, bText) {
  var aUp = PRICE_UP.test(aText), aDn = PRICE_DOWN.test(aText);
  var bUp = PRICE_UP.test(bText), bDn = PRICE_DOWN.test(bText);
  return (aUp && !aDn && bDn && !bUp) || (aDn && !aUp && bUp && !bDn);
}

function sameStory(a, b) {
  var da = a.it.direction, db = b.it.direction;
  if (da && db && da !== 'NEUTRAL' && db !== 'NEUTRAL' && da !== db) return false;
  if (opposed(a.it.text, b.it.text)) return false;
  var uni = overlap(a.uni, b.uni);
  if (uni < 0.6) return false;
  var bi = overlap(a.bi, b.bi);
  // Identical vocabulary but different word order is the signature of a
  // directional mirror ("US strikes Iran" / "Iran strikes US") — refuse
  // unless the phrasing itself also matches strongly.
  if (uni >= 0.999 && bi < 0.5) return false;
  return bi >= 0.28;
}

/* cluster(items): items need { text, date } (ISO). Collapses same-story items
 * into one slot. The LATEST member's text leads (a re-check wire must surface
 * what changed; a frozen day-old headline hides updates), the EARLIEST is
 * credited as first = { outlet, date } (break credit survives as metadata),
 * other members fold into also = [{ outlet, link, date }]. cluster_id is the
 * earliest member's normalized text head — stable across 60s polls so the UI
 * doesn't churn. Output is newest-activity-first. */
function cluster(items, windowMs) {
  windowMs = windowMs || 48 * 3600 * 1000;
  var wrapped = items.map(function (it) {
    var toks = tokensOf(it.text);
    return { it: it, uni: new Set(toks), bi: bigramsOf(toks), t: new Date(it.date).getTime() || 0 };
  });
  var clusters = [];
  for (var i = 0; i < wrapped.length; i++) {
    var w = wrapped[i], placed = false;
    for (var j = 0; j < clusters.length && !placed; j++) {
      var c = clusters[j];
      if (Math.abs(w.t - c.members[0].t) > windowMs) continue;
      if (sameStory(w, c.members[0]) || (c.members[1] && sameStory(w, c.members[1]))) {
        c.members.push(w);
        placed = true;
      }
    }
    if (!placed) clusters.push({ members: [w] });
  }
  var out = [];
  clusters.forEach(function (c) {
    c.members.sort(function (a, b) { return a.t - b.t; });
    var earliest = c.members[0], latest = c.members[c.members.length - 1];
    var lead = latest.it;
    if (c.members.length > 1) {
      lead = Object.assign({}, lead, {
        cluster_size: c.members.length,
        cluster_id: tokensOf(earliest.it.text).slice(0, 6).join('-'),
        first: { outlet: earliest.it.outlet || earliest.it.source || null, date: earliest.it.date },
        also: c.members.slice(0, -1).map(function (m) {
          return { outlet: m.it.outlet || m.it.source || null, link: m.it.link || '', date: m.it.date };
        }),
      });
    }
    out.push({ lead: lead, t: latest.t });
  });
  out.sort(function (a, b) { return b.t - a.t; });
  return out.map(function (o) { return o.lead; });
}

module.exports = { classify: classify, feedRelevant: feedRelevant, splitOutlet: splitOutlet, cluster: cluster, tokensOf: tokensOf, KEYWORDS: KEYWORDS, EXCLUDE: EXCLUDE, OIL_STRICT: OIL_STRICT };
