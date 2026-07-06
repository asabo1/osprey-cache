const https = require('https');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.EIA_API_KEY;
const FRED_KEY = process.env.FRED_API_KEY;
// No EIA key = degrade gracefully (2026-07-06 free-pipeline move): prices
// and the crisis score are Yahoo-sourced and keyless; EIA feeds only the
// weekly spot cross-check, the (frozen-dead) futures curve, and the natgas
// fallback. Those return null without a key and carry-forward handles it.
if (!API_KEY) console.warn('EIA_API_KEY not set: EIA-sourced fields will be null/carried');

const OUTPUT = path.join(__dirname, '..', 'public', 'data', 'daily.json');

function get(reqPath) {
  return new Promise(function(resolve, reject) {
    console.log('Fetching:', reqPath.substring(0, 60));
    var req = https.request({
      hostname: 'api.eia.gov',
      port: 443,
      path: reqPath,
      method: 'GET',
      headers: { 'Accept': 'application/json', 'User-Agent': 'CrudeSignal/1.0' }
    }, function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() {
        console.log('Status:', res.statusCode, 'Length:', d.length);
        if (res.statusCode !== 200 || d.indexOf('humans.txt') >= 0 || d.charAt(0) === '<') {
          console.error('Bad response:', d.substring(0, 200));
          reject(new Error('Bad response'));
          return;
        }
        try { resolve(JSON.parse(d)); }
        catch(e) { console.error('Parse fail:', d.substring(0, 200)); reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function getPrice(series) {
  if (!API_KEY) return Promise.resolve(null);
  var reqPath = '/v2/petroleum/pri/spt/data/?api_key=' + API_KEY
    + '&frequency=weekly&data[0]=value&facets[series][]=' + series
    + '&sort[0][column]=period&sort[0][direction]=desc&length=30';
  return get(reqPath).then(function(r) {
    if (r.response && r.response.data) {
      console.log(series + ':', r.response.data.length, 'records');
      if (r.response.data[0]) console.log('Latest:', r.response.data[0].period, '$' + r.response.data[0].value);
      return r.response.data;
    }
    console.error('No data for', series);
    return [];
  });
}

function getFutures() {
  // NYMEX WTI futures contracts 1-6 months out
  var contracts = ['RCLC1','RCLC2','RCLC3','RCLC4','RCLC5','RCLC6'];
  var labels = ['M1','M2','M3','M4','M5','M6'];
  if (!API_KEY) return Promise.resolve(null);
  var promises = contracts.map(function(c) {
    var reqPath = '/v2/petroleum/pri/fut/data/?api_key=' + API_KEY
      + '&frequency=daily&data[0]=value&facets[series][]=' + c
      + '&sort[0][column]=period&sort[0][direction]=desc&length=1';
    return get(reqPath).then(function(r) {
      if (r.response && r.response.data && r.response.data[0]) {
        return { value: parseFloat(r.response.data[0].value), period: r.response.data[0].period || null };
      }
      return null;
    }).catch(function() { return null; });
  });
  return Promise.all(promises).then(function(prices) {
    console.log('Futures:', prices.map(function(q) { return q && q.value; }), 'periods:', prices.map(function(q) { return q && q.period; }));
    var result = [];
    var asOf = null;
    for (var i = 0; i < prices.length; i++) {
      if (prices[i] !== null && prices[i].value != null && !isNaN(prices[i].value)) {
        result.push({ month: labels[i], price: prices[i].value });
        if (prices[i].period && (!asOf || prices[i].period > asOf)) asOf = prices[i].period;
      }
    }
    // EIA's RCLC futures series is FROZEN AT 2024-04-05 (verified live
    // 2026-07-01; same frozen-at-2024 pattern as the NGA HYDROPAC API). Its
    // $86.91 M1 coincidentally matched 2026 wartime WTI levels, which is why
    // it passed as current for weeks. Stamp the quote date and flag staleness
    // so no consumer ever renders this (or any old) curve as live.
    var stale = !asOf || (Date.now() - new Date(asOf + 'T00:00:00Z').getTime()) > 7 * 86400000;
    // Determine curve shape
    var shape = 'FLAT';
    if (result.length >= 2) {
      if (result[0].price > result[result.length - 1].price) shape = 'BACKWARDATION';
      else if (result[0].price < result[result.length - 1].price) shape = 'CONTANGO';
    }
    return {
      label: shape,
      interpretation: shape === 'BACKWARDATION'
        ? 'Near-month premium. Market pricing a persistent supply squeeze.'
        : shape === 'CONTANGO'
        ? 'Far-month premium. Market expects supply recovery ahead.'
        : 'Flat curve. No clear directional signal.',
      contracts: result,
      as_of: asOf,
      stale: stale
    };
  });
}

function getFRED(seriesId) {
  if (!FRED_KEY) return Promise.resolve(null);
  return new Promise(function(resolve, reject) {
    var path = '/fred/series/observations?series_id=' + seriesId + '&api_key=' + FRED_KEY + '&file_type=json&sort_order=desc&limit=2';
    https.get('https://api.stlouisfed.org' + path, function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() {
        try {
          var json = JSON.parse(d);
          if (json.observations && json.observations.length > 0) {
            var latest = json.observations[0];
            var prev = json.observations[1] || null;
            var price = latest.value !== '.' ? parseFloat(latest.value) : null;
            var prevPrice = prev && prev.value !== '.' ? parseFloat(prev.value) : null;
            console.log(seriesId + ': $' + price + ' (' + latest.date + ')');
            resolve({ price: price, prev: prevPrice, delta: price && prevPrice ? +(price - prevPrice).toFixed(2) : null, date: latest.date });
          } else {
            resolve(null);
          }
        } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function getMetals() {
  return Promise.all([
    Promise.resolve(null),
    getFRED('PCOPPUSDM'),
    getFRED('DTWEXBGS')
  ]).then(function(results) {
    return {
      gold: results[0],
      copper: results[1],
      dxy: results[2]
    };
  });
}

function getCurrencies() {
  return new Promise(function(resolve, reject) {
    console.log('Fetching currencies...');
    https.get('https://api.exchangerate-api.com/v4/latest/USD', function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() {
        try {
          var json = JSON.parse(d);
          var rates = json.rates || {};
          var result = {
            mxn: rates.MXN ? +rates.MXN.toFixed(4) : null,
            gbp: rates.GBP ? +(1/rates.GBP).toFixed(4) : null,
            eur: rates.EUR ? +(1/rates.EUR).toFixed(4) : null
          };
          console.log('Currencies: MXN=' + result.mxn + ' GBP=$' + result.gbp + ' EUR=$' + result.eur);
          resolve(result);
        } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function getNatGas() {
  if (!API_KEY) return Promise.resolve(null);
  var reqPath = '/v2/natural-gas/pri/fut/data/?api_key=' + API_KEY
    + '&frequency=daily&data[0]=value&facets[series][]=RNGWHHD'
    + '&sort[0][column]=period&sort[0][direction]=desc&length=2';
  return get(reqPath).then(function(r) {
    if (r.response && r.response.data && r.response.data[0]) {
      var p = parseFloat(r.response.data[0].value);
      var prev = r.response.data[1] ? parseFloat(r.response.data[1].value) : null;
      console.log('Nat Gas: $' + p + '/MMBtu');
      return { price: p, prev: prev, delta: prev ? +(p - prev).toFixed(2) : null };
    }
    return null;
  }).catch(function(e) { console.error('NatGas failed:', e.message); return null; });
}

async function main() {
  var wti = [];
  var brent = [];
  try { wti = await getPrice('RWTC'); } catch(e) { console.error('WTI failed:', e.message); }
  try { brent = await getPrice('RBRTE'); } catch(e) { console.error('Brent failed:', e.message); }

  var futures = null;
  try { futures = await getFutures(); } catch(e) { console.error('Futures failed:', e.message); }

  var currencies = null;
  try { currencies = await getCurrencies(); } catch(e) { console.error('Currencies failed:', e.message); }

  var natgas = null;
  try { natgas = await getNatGas(); } catch(e) { console.error('NatGas failed:', e.message); }

  var metals = null;
  try { metals = await getMetals(); } catch(e) { console.error('Metals failed:', e.message); }

  var existing = {};
  if (fs.existsSync(OUTPUT)) {
    try { existing = JSON.parse(fs.readFileSync(OUTPUT, 'utf8')); } catch(e) {}
  }

  wti = wti || []; brent = brent || [];
  if (wti.length === 0 && brent.length === 0 && !(existing.latest && existing.latest.wti != null)) {
    console.log('No fresh EIA data and no carried prices (cold start). Keeping existing.');
    process.exit(0);
  }

  var today = new Date().toISOString().split('T')[0];
  var wtiP = wti[0] && wti[0].value ? parseFloat(wti[0].value) : (existing.latest ? existing.latest.wti : null);
  var brentP = brent[0] && brent[0].value ? parseFloat(brent[0].value) : (existing.latest ? existing.latest.brent : null);
  // Prev = prior day's stored value (one basis: previous close, not EIA weekly steps).
  // EIA weekly [1] only as a cold-start fallback when no prior latest exists.
  var wtiPrev = existing.latest && existing.latest.wti != null ? existing.latest.wti : (wti[1] && wti[1].value ? parseFloat(wti[1].value) : null);
  var brentPrev = existing.latest && existing.latest.brent != null ? existing.latest.brent : (brent[1] && brent[1].value ? parseFloat(brent[1].value) : null);
  var spread = brentP && wtiP ? +(brentP - wtiP).toFixed(2) : null;

  // Crisis Score v2 (methodology updated 2026-06-11). v1 was price-only
  // (base 50 + oil deviation + spread) and FELL the day Iran fully closed the
  // strait because prices eased — it measured oil stress, not the crisis.
  // v2 = price stress (0-35) + kinetic (0-45) + structural (0-20), with a
  // floor of 85 while a full closure is in effect. Inputs are fields that
  // intel-fetch already maintains in daily.json (intel severities, event_log).
  var oilDev = wtiP ? Math.min(((wtiP - 70) / 50) * 20, 20) : 0;          // $70 calm .. $120 maxed
  var spreadStress = spread ? Math.min((Math.abs(spread) / 15) * 15, 15) : 0;
  var priceStress = oilDev + spreadStress;                                  // 0-35

  var nowMs = Date.now();
  var intelArr = existing.intel || [];
  var critRecent = 0;
  for (var ci = 0; ci < intelArr.length; ci++) {
    var it = intelArr[ci];
    if (it && it.severity === 'CRIT' && it.date && (nowMs - new Date(it.date).getTime()) <= 48 * 3600e3) critRecent++;
  }
  var critDensity = Math.min(critRecent * 3.5, 25);                         // CRIT wire tempo, 48h

  var KINETIC_RE = /attack|strike|struck|missile|drone|torpedo|mine|shell|sunk|seiz/i;
  var evArr = existing.event_log || [];
  var latestKineticMs = 0;
  for (var ei = 0; ei < evArr.length; ei++) {
    var ev = evArr[ei];
    if (ev && ev.text && KINETIC_RE.test(ev.text)) {
      var ems = ev.date_iso ? new Date(ev.date_iso).getTime() : NaN;
      if (!isNaN(ems) && ems > latestKineticMs) latestKineticMs = ems;
    }
  }
  var kineticAgeH = latestKineticMs ? (nowMs - latestKineticMs) / 3600e3 : Infinity;
  var freshKinetic = kineticAgeH <= 72 ? 20 : kineticAgeH <= 168 ? 10 : 0;  // recency of last kinetic event
  var kinetic = critDensity + freshKinetic;                                  // 0-45

  // Structural: war regime + full-closure state. Deliberately NO calm-keyword
  // detection — headlines like "battle to keep Hormuz open" or "ceasefire
  // practically useless" defeat polarity regexes. War regime keys off kinetic
  // recency instead: when kinetic events stop for 14 days, it decays to 0 on
  // its own. Closure flag also ages out via its 14-day scan window.
  var warRegime = kineticAgeH <= 336 ? 10 : 0; // kinetic event within 14 days
  // Strait status is a CATEGORICAL EDITORIAL FACT, not a headline inference —
  // a regex over the rolling wire flickered the flag (observed 06-11: score
  // published 68 instead of 85). Set manually on categorical changes, same as
  // reopeningStart in StatusBar.astro.
  //   'full-closure'        2026-06-10..06-19: closed to all vessels (floor 85)
  //   'reopening-contested' 2026-06-19..06-24: toll-free MOU reopening, ships at
  //                         a ~20-55/day trickle vs ~94 norm, contested by the
  //                         suspended toll and Lebanon rhetoric (floor 65)
  //   'contested-ceasefire' 2026-06-26..07-01: the MOU broke into a kinetic
  //                         exchange (US-Iran strikes, two ships hit, IRGC
  //                         missiles at US bases in Kuwait/Bahrain 06-28, IRGC
  //                         gating the southern route), then a fragile 06-28
  //                         stand-down. Strait open at a trickle but armed and
  //                         reversible (floor 72)
  //   'standdown-talks'     2026-07-01+: the 06-28 stand-down holding with no
  //                         confirmed strikes since; indirect US-Iran talks via
  //                         Doha (working groups formed 07-01, no direct
  //                         negotiations); traffic recovering ~35-70/day vs ~94
  //                         norm; JMIC threat SUBSTANTIAL + mine warning; Brent
  //                         back at pre-crisis ~$71 (floor 65)
  //   'open'                sustained, uncontested pre-war throughput (no floor)
  var STRAIT_STATUS = 'standdown-talks';
  var fullClosure = STRAIT_STATUS === 'full-closure' ? 10 : STRAIT_STATUS === 'contested-ceasefire' ? 8 : STRAIT_STATUS === 'standdown-talks' ? 6 : STRAIT_STATUS === 'reopening-contested' ? 6 : 0;
  var structural = warRegime + fullClosure;                                  // 0-20

  var crisisScore = Math.round(Math.min(priceStress + kinetic + structural, 100));
  var scoreFloor = STRAIT_STATUS === 'full-closure' ? 85 : STRAIT_STATUS === 'contested-ceasefire' ? 72 : STRAIT_STATUS === 'standdown-talks' ? 65 : STRAIT_STATUS === 'reopening-contested' ? 65 : 0;
  if (scoreFloor > 0) crisisScore = Math.max(crisisScore, scoreFloor);
  console.log('Score v2: price ' + priceStress.toFixed(1) + ' + kinetic ' + kinetic.toFixed(1) + ' + structural ' + structural + (scoreFloor ? ' (' + STRAIT_STATUS + ' floor ' + scoreFloor + ')' : '') + ' = ' + crisisScore);

  var snapshot = {
    date: today, wti: wtiP, wti_prev: wtiPrev,
    wti_delta: wtiP && wtiPrev ? +(wtiP - wtiPrev).toFixed(2) : null,
    brent: brentP, brent_prev: brentPrev,
    brent_delta: brentP && brentPrev ? +(brentP - brentPrev).toFixed(2) : null,
    spread: spread, crisis_score: crisisScore, score_method: 'v2-2026-06-11'
  };

  var snapshots = existing.snapshots || [];
  var idx = -1;
  for (var i = 0; i < snapshots.length; i++) { if (snapshots[i].date === today) { idx = i; break; } }
  if (idx >= 0) snapshots[idx] = snapshot; else snapshots.unshift(snapshot);
  while (snapshots.length > 90) snapshots.pop();

  var scores = [];
  for (var j = 0; j < Math.min(snapshots.length, 30); j++) {
    scores.push({ date: snapshots[j].date, score: snapshots[j].crisis_score });
  }

  var output = Object.assign({}, existing, {
    updated: new Date().toISOString(),
    latest: snapshot,
    scores: scores,
    snapshots: snapshots,
    futures: futures || existing.futures || null,
    currencies: currencies || existing.currencies || null,
    natgas: natgas || existing.natgas || null,
    metals: metals || existing.metals || null
  });
  delete output.history_wti;
  delete output.history_brent;
  delete output.signal;
  delete output.signal_history;
  delete output.correlation;

  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2));
  console.log('Done: WTI $' + wtiP + ' | Brent $' + brentP + ' | Score ' + crisisScore);
  if (currencies) console.log('Currencies: MXN ' + currencies.mxn + ' | GBP $' + currencies.gbp);
  if (natgas) console.log('NatGas: $' + natgas.price);
  if (metals) {
    if (metals.gold) console.log('Gold: $' + metals.gold.price);
    if (metals.copper) console.log('Copper: $' + metals.copper.price);
    if (metals.dxy) console.log('DXY: ' + metals.dxy.price);
  }
}

main().catch(function(e) { console.error(e); process.exit(1); });
