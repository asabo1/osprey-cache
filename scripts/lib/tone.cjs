/* Shared mood scorer: headline tone, fear gauge, tone/market correlation.
 * Pure functions, no network, no LLM, deterministic.
 *
 * TWIN FILES: the osprey-cache copy (scripts/lib/tone.cjs + tone-lexicon.json)
 * and the crude-signal copy (scripts/lib/ in the site repo) must stay
 * byte-identical. The cron writes the hourly history with this scorer and the
 * site scores live requests with the same code, so the two can never drift.
 * Spec: outputs-local/2026-11-25-v2-fear-sentiment.md (druP3).
 *
 * moveOf() and deskOf() are ports of src/lib/wire-view.ts on the site (the
 * cron has no TypeScript). Keep them in step with that file.
 */
var LEX = require('./tone-lexicon.json');

var C = LEX.constants;

// ---- lexicon index --------------------------------------------------------
var PACKS = {};
Object.keys(LEX.packs).forEach(function (name) {
  var map = {};
  var words = LEX.packs[name].words;
  Object.keys(words).forEach(function (k) {
    k.split(/\s+/).forEach(function (w) { if (w) map[w] = words[k]; });
  });
  PACKS[name] = { map: map, desks: LEX.packs[name].desks };
});
function packOf(desk) {
  for (var n in PACKS) if (PACKS[n].desks.indexOf(desk) >= 0) return n;
  return 'war';
}
function set(a) { var o = {}; a.forEach(function (w) { o[w] = 1; }); return o; }
var NEG = set(LEX.negations), RELIEF = set(LEX.relief_verbs), BREAK = set(LEX.breakers),
  HEDGE = set(LEX.hedges), INTENS = set(LEX.intensifiers);

// ---- port of wire-view.ts: price move + desk ------------------------------
var SUBJ = '(oil|crude|brent|wti|prices?|futures|gold|copper|natural gas|gas|lng|diesel|gasoline|chips?|sox|dram|memory|ddr\\d|hbm)';
var UPV = '(rise[sn]?|rising|rose|gain(s|ed)?|jump(s|ed)?|climb(s|ed)?|surge[sd]?|soar(s|ed)?|rall(y|ies|ied)|spike[sd]?|higher|up \\$?\\d|rebound(s|ed)?|extends? gains|hits? (a )?[\\w-]*(month|year|week) high|record high)';
var DNV = '(fall(s|en)?|fell|drop(s|ped)?|slides?|slid|slip(s|ped)?|sink(s)?|sank|tumble[sd]?|plunge[sd]?|lower|down \\$?\\d|dip(s|ped)?|decline[sd]?|ease[sd]?|retreat(s|ed)?|extends? losses|hits? (a )?[\\w-]*(month|year|week) low|(three|six|nine|\\d+)-month lows?)';
var NEAR = "(\\s+[\\w$%.'’-]+){0,3}?\\s+";
var UPRX = new RegExp('\\b' + SUBJ + NEAR + UPV + '\\b', 'i');
var DOWNRX = new RegExp('\\b' + SUBJ + NEAR + DNV, 'i');
var DOUBLE = /\bprices?\s+(to\s+)?(more than\s+)?(double|triple)[sd]?\b/i;
var AIM = /\b(curb|cap|limit|tame|fight|ease|stem)\w*\s+(\w+\s+)?price (rises|gains|falls|declines)\b/i;
function moveOf(text) {
  if (AIM.test(text)) return null;
  var u = UPRX.test(text) || DOUBLE.test(text), d = DOWNRX.test(text);
  if (u === d) return null;
  return u ? 'up' : 'down';
}

var DESK_RX = [
  ['ai', /\b(data cent(er|re)s?|datacenters?|hyperscal\w*|neoclouds?|coreweave|nebius|crusoe|lambda labs|stargate|openai|edgeconne?x|equinix|digital realty|ai (capex|spending|infrastructure|factory|factories|campus(es)?|cluster|compute)|gigawatts?|power purchase|ppa|small modular reactors?|smrs?|gas turbines?|ge vernova|vertiv|liquid cooling)\b|\b\d[\d.,]*\s?-?\s?(gw|mw)\b/i],
  ['chips', /\b(chips?|semiconductors?|tsmc|nvidia|amd|intel|hbm|dram|ddr\d|nand|memory chips?|gpus?|wafers?|foundr(y|ies)|export controls?|sox|sk hynix|samsung electronics|micron|asml|gallium|germanium|taiwan strait|pla)\b/i],
  ['hormuz', /\b(hormuz|strait|iran|iranian|irgc|tankers?|blockade|houthis?|red sea|bab el|gulf of oman|persian gulf|bahrain|ukmto|centcom|mines?)\b/i],
  ['gas', /\b(natural gas|lng|henry hub|gas prices?|ttf|gas storage)\b/i],
  ['metals', /\b(gold|silver|copper|aluminium|aluminum|steel|nickel|lithium|platinum|iron ore|metals?)\b/i],
  ['oil', /\b(oil|crude|brent|wti|opec\+?|refiner(y|ies)|diesel|gasoline|jet fuel|fuel|barrels?|eia|inventor(y|ies)|petroleum)\b/i]
];
function deskOf(text, kind, source) {
  if (kind === 'data' && /chip|tsmc|taiwan|export|bis\b|semiconductor/i.test(text)) return 'chips';
  if (/\bhormuz\b/i.test(text)) return 'hormuz';
  for (var i = 0; i < DESK_RX.length; i++) if (DESK_RX[i][1].test(text)) return DESK_RX[i][0];
  return source === 'AI infra' ? 'ai' : source === 'Chips' ? 'chips' : source === 'Hormuz' ? 'hormuz' : 'oil';
}

// ---- headline tone ---------------------------------------------------------
function tokenize(text) {
  var t = String(text || '').toLowerCase().replace(/[‘’]/g, "'");
  var out = [], clause = 0, re = /[a-z0-9+$%'-]+|[,;:]/g, m;
  while ((m = re.exec(t))) {
    if (/^[,;:]$/.test(m[0])) { clause++; continue; }
    var w = m[0].replace(/^[-'+]+|[-'+]+$/g, '');
    if (w) out.push({ w: w, c: clause });
  }
  return out;
}

function within(toks, i, before, after, table) {
  for (var k = Math.max(0, i - before); k <= Math.min(toks.length - 1, i + after); k++) {
    if (k !== i && table[toks[k].w]) return true;
  }
  return false;
}

/* tone(text, desk, opts) -> integer -100 (alarming) .. +100 (calming).
   opts.move: 'up' | 'down' | null overrides the built-in moveOf(text). */
function toneDetail(text, desk, opts) {
  opts = opts || {};
  var pack = PACKS[packOf(desk)], war = packOf(desk) === 'war';
  var toks = tokenize(text), hits = [], sum = 0, reliefSeen = false;
  for (var i = 0; i < toks.length; i++) {
    var w = toks[i].w;
    if (RELIEF[w]) reliefSeen = true;
    var v = pack.map[w];
    if (v === undefined) continue;
    var ex = LEX.exclude_next[w];
    if (ex && toks[i + 1] && ex.indexOf(toks[i + 1].w) >= 0) continue;
    var why = [];
    var broke = v > 0 && within(toks, i, 0, 3, BREAK) && !within(toks, i, 3, 0, NEG);
    if (broke) { v = -Math.abs(v) * C.break_flip; why.push('break'); }
    else if (within(toks, i, 3, 0, NEG)) { v = -v * C.negation_flip; why.push('negation'); }
    else if (v < 0 && (within(toks, i, 3, 0, RELIEF) || within(toks, i, 0, 2, RELIEF))) { v = -v * C.relief_flip; why.push('relief'); }
    for (var k = i - 1; k >= 0 && toks[k].c === toks[i].c; k--) { if (HEDGE[toks[k].w]) { v *= C.hedge; why.push('hedge'); break; } }
    if (within(toks, i, 3, 0, INTENS)) { v *= C.intensifier; why.push('intensifier'); }
    hits.push({ w: w, v: v, why: why });
    sum += v;
  }
  if (!hits.length && reliefSeen) { sum += C.relief_alone; hits.push({ w: '(relief)', v: C.relief_alone, why: [] }); }
  if (/\?/.test(text)) sum *= C.question;
  var move = opts.move !== undefined ? opts.move : moveOf(text);
  var pm = move === 'up' ? 1 : move === 'down' ? -1 : 0;
  sum += pm * (war ? C.price_mod_war : C.price_mod_tech);
  var tone = Math.round(100 * Math.tanh(sum / C.tanh_div));
  if (tone === 0) tone = 0; // normalise -0
  return { tone: tone, raw: sum, hits: hits, move: move };
}
function tone(text, desk, opts) { return toneDetail(text, desk, opts).tone; }
function toneLabel(score) { return score == null ? null : score <= -34 ? 'alarming' : score >= 34 ? 'calming' : 'mixed'; }

// ---- aggregation -------------------------------------------------------------
var SEV = { CRIT: 1.5, WARN: 1.2 };
function itemWeight(it) { return Math.min(3, it.cluster_size || 1) * (SEV[it.severity] || 1); }
function wmean(list) {
  var s = 0, w = 0;
  list.forEach(function (it) { var x = itemWeight(it); s += x * it.tone; w += x; });
  return w ? s / w : null;
}
/* items: [{ id, seen (ISO), desk, tone, severity, cluster_size, filler }].
   Returns per desk { score, n, pos, neg, h, hn }:
   score = weighted mean over the last `hours` (default 6) hours, null with fewer than 2 items;
   h = same for items first seen in the current clock hour only (hn = how many). */
function aggregate(items, now, opts) {
  opts = opts || {};
  var hours = opts.hours || 6, t = now ? new Date(now).getTime() : Date.now();
  var hourStart = Math.floor(t / 3600e3) * 3600e3;
  var out = {};
  ['hormuz', 'oil', 'chips', 'ai'].forEach(function (d) {
    var win = items.filter(function (it) {
      var s = new Date(it.seen).getTime();
      return it.desk === d && !it.filler && s <= t && s > t - hours * 3600e3;
    });
    var hr = win.filter(function (it) { return new Date(it.seen).getTime() >= hourStart; });
    var sc = win.length >= 2 ? wmean(win) : null, h = hr.length >= 2 ? wmean(hr) : null;
    out[d] = {
      score: sc == null ? null : Math.round(sc), n: win.length,
      pos: win.filter(function (i) { return i.tone >= 15; }).length,
      neg: win.filter(function (i) { return i.tone <= -15; }).length,
      h: h == null ? null : Math.round(h), hn: hr.length
    };
  });
  return out;
}

// ---- fear gauge ---------------------------------------------------------------
var WEIGHTS = {
  oil: { hormuz: 0.30, ovx: 0.25, pm: 0.15, brent_prem: 0.15, vix: 0.10, gvz: 0.05 },
  ai: { vxn: 0.25, sox_dd: 0.25, sox_mom: 0.15, credit: 0.15, move: 0.10, vix: 0.10 }
};
var BANDS = [25, 50, 75], HYST = 3, LABELS = ['calm', 'uneasy', 'fearful', 'panic'];
// Plain labels and move phrases (never source names).
var PHRASE = {
  hormuz: ['Hormuz crisis level', 'higher', 'lower'], ovx: ['Oil volatility', 'higher', 'lower'],
  pm: ["Traders' odds Hormuz stays shut", 'higher', 'lower'], brent_prem: ['Brent premium', 'higher', 'lower'],
  vix: ['Stock-market volatility', 'higher', 'lower'], gvz: ['Gold volatility', 'higher', 'lower'],
  vxn: ['Tech-stock volatility', 'higher', 'lower'], sox_dd: ['Chip drawdown', 'deeper', 'shallower'],
  sox_mom: ['Chip momentum', 'weaker', 'stronger'], credit: ['Credit stress', 'higher', 'lower'],
  move: ['Bond-market volatility', 'higher', 'lower']
};

// Empirical percentile rank of x in series (0-100); null if the series is too short.
function pctRank(series, x, minObs) {
  var xs = (series || []).filter(function (v) { return v != null && isFinite(v); });
  if (xs.length < (minObs == null ? 200 : minObs) || x == null || !isFinite(x)) return null;
  var lt = 0, eq = 0;
  xs.forEach(function (v) { if (v < x) lt++; else if (v === x) eq++; });
  return 100 * (lt + 0.5 * eq) / xs.length;
}

/* components(inputs, baselines) -> comp { key: [sub, weight] } (sub null when unavailable).
   inputs: { vix, ovx, vxn, gvz, move, hyg, ief, sox, brent, hormuz, pm } (latest values).
   baselines: fear-baselines.json { series, ref:{sox_hi, sox_20d, brent_med120} }. */
function components(inp, base) {
  var S = (base && base.series) || {}, R = (base && base.ref) || {};
  var sub = {};
  sub.vix = pctRank(S.vix, inp.vix); sub.ovx = pctRank(S.ovx, inp.ovx); sub.vxn = pctRank(S.vxn, inp.vxn);
  sub.gvz = pctRank(S.gvz, inp.gvz); sub.move = pctRank(S.move, inp.move);
  var cr = inp.hyg && inp.ief ? inp.hyg / inp.ief : null;
  var p = pctRank(S.credit, cr); sub.credit = p == null ? null : 100 - p;
  var hi = R.sox_hi && inp.sox ? Math.max(R.sox_hi, inp.sox) : null;
  sub.sox_dd = hi ? pctRank(S.sox_dd, 1 - inp.sox / hi) : null;
  p = R.sox_20d && inp.sox ? pctRank(S.sox_mom, inp.sox / R.sox_20d - 1) : null; sub.sox_mom = p == null ? null : 100 - p;
  sub.brent_prem = R.brent_med120 && inp.brent ? pctRank(S.brent_prem, inp.brent / R.brent_med120, 100) : null;
  sub.hormuz = inp.hormuz != null ? inp.hormuz : null; sub.pm = inp.pm != null ? inp.pm : null;
  var comp = {}, seen = {};
  ['oil', 'ai'].forEach(function (d) {
    Object.keys(WEIGHTS[d]).forEach(function (k) {
      if (seen[k]) return; seen[k] = 1;
      comp[k] = [sub[k] == null ? null : Math.round(sub[k] * 10) / 10, WEIGHTS[d][k]];
    });
  });
  return comp;
}

function deskScore(comp, desk) {
  var s = 0, w = 0, tot = 0, ks = Object.keys(WEIGHTS[desk]);
  ks.forEach(function (k) {
    tot += WEIGHTS[desk][k];
    var c = comp[k];
    if (c && c[0] != null) { s += c[0] * WEIGHTS[desk][k]; w += WEIGHTS[desk][k]; }
  });
  return { score: w ? s / w : null, avail: tot ? w / tot : 0 };
}

/* label with hysteresis: prev is the previous label; it changes only once the score
   is HYST points past the band edge. */
function fearLabel(score, prev) {
  if (score == null) return null;
  var idx = LABELS.indexOf(prev);
  if (idx < 0) { idx = 0; while (idx < 3 && score >= BANDS[idx]) idx++; return LABELS[idx]; }
  while (idx < 3 && score >= BANDS[idx] + HYST) idx++;
  while (idx > 0 && score < BANDS[idx - 1] - HYST) idx--;
  return LABELS[idx];
}

/* fear(comp, prevLabels) -> { oil, ai, composite, lab:{...}, partial:{...}, comp }.
   Scores are integers; a desk with under 60% of its weight available is partial: no score label. */
function fear(comp, prevLabels) {
  prevLabels = prevLabels || {};
  var o = deskScore(comp, 'oil'), a = deskScore(comp, 'ai');
  var oOk = o.score != null && o.avail >= 0.6, aOk = a.score != null && a.avail >= 0.6;
  var oil = oOk ? o.score : null, ai = aOk ? a.score : null, composite = null;
  if (oOk && aOk) composite = 0.5 * (oil + ai) / 2 + 0.5 * Math.max(oil, ai);
  else if (oOk || aOk) composite = oOk ? oil : ai;
  var r = function (x) { return x == null ? null : Math.round(x); };
  var res = { oil: r(oil), ai: r(ai), composite: r(composite), comp: comp, partial: { oil: !oOk, ai: !aOk } };
  res.lab = {
    oil: oOk ? fearLabel(oil, prevLabels.oil) : null,
    ai: aOk ? fearLabel(ai, prevLabels.ai) : null,
    composite: composite == null ? null : fearLabel(composite, prevLabels.composite)
  };
  return res;
}

/* drivers(compNow, compRef, desk): top 2 components by |contribution| to the 24h change.
   desk: 'oil' | 'ai' | 'composite' (composite pools both desks at half weight). */
function drivers(now, ref, desk) {
  if (!now || !ref) return [];
  var acc = {};
  (desk === 'composite' ? ['oil', 'ai'] : [desk]).forEach(function (d) {
    var tot = 0, ks = Object.keys(WEIGHTS[d]);
    ks.forEach(function (k) { if (now[k] && now[k][0] != null && ref[k] && ref[k][0] != null) tot += WEIGHTS[d][k]; });
    if (!tot) return;
    ks.forEach(function (k) {
      if (!(now[k] && now[k][0] != null && ref[k] && ref[k][0] != null)) return;
      var c = WEIGHTS[d][k] * (now[k][0] - ref[k][0]) / tot * (desk === 'composite' ? 0.5 : 1);
      acc[k] = (acc[k] || 0) + c;
    });
  });
  return Object.keys(acc).map(function (k) { return { key: k, contrib: Math.round(acc[k] * 10) / 10 }; })
    .filter(function (x) { return Math.abs(x.contrib) >= 0.1; })
    .sort(function (a, b) { return Math.abs(b.contrib) - Math.abs(a.contrib); }).slice(0, 2)
    .map(function (x) {
      var p = PHRASE[x.key];
      return { key: x.key, label: p[0] + ' ' + (x.contrib > 0 ? p[1] : p[2]), contrib: x.contrib };
    });
}

/* Polymarket stress from odds.json: volume-weighted mean of 100*(1-yes) over open
   "hormuz ... normal" markets ending at least 14 days out. null if none. */
function pmStress(odds, nowMs) {
  var now = nowMs || Date.now(), s = 0, w = 0;
  ((odds && odds.markets) || []).forEach(function (m) {
    var t = m.title || m.question || '';
    if (!/hormuz.*normal/i.test(t)) return;
    var end = m.end ? new Date(m.end).getTime() : null;
    if (end && end < now + 14 * 86400e3) return;
    if (m.yes_pct == null) return;
    var vol = Number(m.volume) || 1;
    s += vol * 100 * (1 - m.yes_pct / 100); w += vol;
  });
  return w ? s / w : null;
}

// ---- tone vs market correlation --------------------------------------------
var CORR_MKT = { hormuz: 'brent', oil: 'brent', chips: 'sox', ai: 'sox' };
function pearson(x, y) {
  var n = x.length; if (n < 3) return null;
  var mx = x.reduce(function (a, b) { return a + b; }, 0) / n, my = y.reduce(function (a, b) { return a + b; }, 0) / n;
  var sxy = 0, sxx = 0, syy = 0;
  for (var i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) * (x[i] - mx); syy += (y[i] - my) * (y[i] - my); }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}
function ranks(a) {
  var idx = a.map(function (v, i) { return [v, i]; }).sort(function (p, q) { return p[0] - q[0]; });
  var r = new Array(a.length), i = 0;
  while (i < idx.length) {
    var j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (var k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}
function winsor(a) {
  if (a.length < 10) return a.slice();
  var s = a.slice().sort(function (p, q) { return p - q; });
  var lo = s[Math.floor(0.01 * (s.length - 1))], hi = s[Math.ceil(0.99 * (s.length - 1))];
  return a.map(function (v) { return Math.min(hi, Math.max(lo, v)); });
}
function lag1(a) {
  var n = a.length; if (n < 4) return 0;
  var m = a.reduce(function (x, y) { return x + y; }, 0) / n, num = 0, den = 0;
  for (var i = 0; i < n; i++) { den += (a[i] - m) * (a[i] - m); if (i) num += (a[i] - m) * (a[i - 1] - m); }
  return den ? num / den : 0;
}
function pairStats(T, R) {
  var n = T.length, o = { n: n, n_eff: n, r: null, rho: null, t: null };
  if (n < 5) return o;
  var tw = winsor(T), rw = winsor(R);
  var r = pearson(tw, rw), rho = pearson(ranks(T), ranks(R));
  var a = Math.max(0, lag1(T) * lag1(R)); a = Math.min(a, 0.95);
  var neff = n * (1 - a) / (1 + a);
  o.r = r; o.rho = rho; o.n_eff = neff;
  if (r != null && neff > 2 && Math.abs(r) < 1) o.t = r * Math.sqrt((neff - 2) / (1 - r * r));
  return o;
}
/* corr(rows) -> { hormuz, oil, chips, ai }, each { mkt, n, n_eff, r, rho, t, lag, state }.
   rows: hourly rows [{ t, tone:{desk:{wire:{h}}}, mkt:{brent,sox} }], oldest first. State is
   collecting (n_eff < 20), none, or link. A link needs |r| >= 0.3, same sign for Spearman, |t| >= 2. */
function corr(rows) {
  var out = {};
  Object.keys(CORR_MKT).forEach(function (d) {
    var mk = CORR_MKT[d], same = { T: [], R: [] }, next = { T: [], R: [] };
    var ret = rows.map(function (row, i) {
      var prev = rows[i - 1];
      if (!prev || new Date(row.t) - new Date(prev.t) !== 3600e3) return null;
      var p1 = row.mkt && row.mkt[mk], p0 = prev.mkt && prev.mkt[mk];
      if (!p1 || !p0 || p1 === p0) return null;   // market closed: price did not move
      return Math.log(p1 / p0);
    });
    rows.forEach(function (row, i) {
      var tw = row.tone && row.tone[d] && row.tone[d].wire, T = tw ? tw.h : null;
      if (T == null) return;
      if (ret[i] != null) { same.T.push(T); same.R.push(ret[i]); }
      if (ret[i + 1] != null) { next.T.push(T); next.R.push(ret[i + 1]); }
    });
    var a = pairStats(same.T, same.R), b = pairStats(next.T, next.R);
    var pick = (b.r != null && (a.r == null || Math.abs(b.r) > Math.abs(a.r))) ? b : a, lag = pick === b ? 'next' : 'same';
    var res = { mkt: mk, n: pick.n, n_eff: Math.round(pick.n_eff * 10) / 10, r: pick.r == null ? null : Math.round(pick.r * 100) / 100,
      rho: pick.rho == null ? null : Math.round(pick.rho * 100) / 100, t: pick.t == null ? null : Math.round(pick.t * 100) / 100, lag: lag, state: 'collecting' };
    if (pick.n_eff >= 20 && pick.r != null) {
      var linked = Math.abs(pick.r) >= 0.3 && Math.sign(pick.r) === Math.sign(pick.rho || 0) && pick.t != null && Math.abs(pick.t) >= 2;
      res.state = linked ? 'link' : 'none';
    }
    out[d] = res;
  });
  return out;
}

// The sentence shown on the page. Never claims a link below the thresholds.
var MKT_NAME = { brent: 'Brent', sox: 'chips' };
function corrText(c, desk) {
  if (!c) return 'Collecting data (n = 0). No read yet.';
  var n = Math.round(c.n_eff != null ? c.n_eff : c.n);
  if (c.state === 'collecting') return 'Collecting data (n = ' + c.n + '). No read yet.';
  var r = c.r.toFixed(2).replace('-0.', '-0.');
  if (c.state === 'none') return 'No clear link (r = ' + r + ', n = ' + c.n + ').';
  var lag = c.lag === 'next' ? 'next hour' : 'same hour', tail = ' (r = ' + r + ', n = ' + c.n + ', ' + lag + ').';
  var m = MKT_NAME[c.mkt] || c.mkt;
  if (desk === 'chips' || desk === 'ai') {
    return c.r > 0 ? 'When headlines turn more upbeat, ' + m + ' tend to move ↑ UP' + tail
      : 'When headlines turn more upbeat, ' + m + ' tend to move ↓ DN' + tail;
  }
  return c.r < 0 ? 'When headlines turn more alarming, ' + m + ' tends to move ↑ UP' + tail
    : m + ' moves with calming headlines, the opposite of what we would expect' + tail;
}

module.exports = {
  tone: tone, toneDetail: toneDetail, toneLabel: toneLabel, moveOf: moveOf, deskOf: deskOf, tokenize: tokenize,
  aggregate: aggregate, itemWeight: itemWeight, pctRank: pctRank, components: components, fear: fear, fearLabel: fearLabel,
  drivers: drivers, pmStress: pmStress, corr: corr, corrText: corrText, WEIGHTS: WEIGHTS, LABELS: LABELS, BANDS: BANDS,
  VERSION: 'fear-v1'
};
