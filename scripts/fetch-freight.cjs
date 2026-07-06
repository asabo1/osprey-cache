/**
 * fetch-freight.cjs — free freight-market signals for the Hormuz dashboard.
 *
 *   1. Bunker fuel (BunkerIndex homepage): VLSFO USD/MT for Fujairah,
 *      Singapore, Rotterdam. Table columns per row: IFO380, +/-, VLSFO, +/-,
 *      MGO, +/- (paywalled ports show "Subscribe"; our three are free).
 *   2. Container rates (Drewry WCI page): composite USD per 40ft, weekly.
 *   3. Suez transits (IMF PortWatch, chokepoint1): reroute-pressure gauge,
 *      same FeatureServer as our Hormuz transits.
 *
 * All sources verified free 2026-06-11. Per-source graceful failure.
 * Output: public/data/freight.json
 */

var fs = require('fs');
var path = require('path');

var OUTPUT = path.join(__dirname, '..', 'public', 'data', 'freight.json');
var UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function fetchText(url, timeoutMs, retries) {
  timeoutMs = timeoutMs || 15000;
  retries = retries == null ? 1 : retries;
  var ctl = new AbortController();
  var t = setTimeout(function () { ctl.abort(); }, timeoutMs);
  return fetch(url, { headers: { 'User-Agent': UA }, signal: ctl.signal })
    .then(function (r) {
      clearTimeout(t);
      if (r.status !== 200) throw new Error('HTTP ' + r.status);
      return r.text();
    })
    .catch(function (e) {
      clearTimeout(t);
      if (retries > 0) return fetchText(url, timeoutMs, retries - 1);
      throw e;
    });
}

// ─── 1. BunkerIndex VLSFO ─────────────────────────────────────────────────────
function getBunker() {
  return fetchText('https://www.bunkerindex.com').then(function (html) {
    var txt = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    var ports = { 'Fujairah': 'fujairah', 'Singapore': 'singapore', 'Rotterdam': 'rotterdam' };
    var out = { ok: true, unit: 'USD/MT', grade: 'VLSFO' };
    var missing = [];
    Object.keys(ports).forEach(function (name) {
      // Row shape: "<Port> <CC> <ifo380> <±> <vlsfo> <±> <mgo> <±> <date>"
      var re = new RegExp(name + '\\s+[A-Z]{2}\\s+([\\d.]+)\\s+(-?[\\d.]+)\\s+([\\d.]+)\\s+(-?[\\d.]+)\\s+([\\d.]+)');
      var m = re.exec(txt);
      if (m) {
        out[ports[name]] = { vlsfo: parseFloat(m[3]), delta: parseFloat(m[4]) };
      } else {
        missing.push(name);
      }
    });
    if (missing.length === 3) throw new Error('no port rows parsed — page layout changed?');
    if (missing.length) out.missing = missing;
    console.log('Bunker: FUJ ' + (out.fujairah ? out.fujairah.vlsfo : '?') + ' SIN ' + (out.singapore ? out.singapore.vlsfo : '?') + ' RTM ' + (out.rotterdam ? out.rotterdam.vlsfo : '?') + ' USD/MT VLSFO');
    return out;
  }).catch(function (e) {
    console.error('Bunker FAILED:', e.message);
    return { ok: false, error: e.message };
  });
}

// ─── 2. Drewry WCI composite ──────────────────────────────────────────────────
function getWci() {
  return fetchText('https://www.drewry.co.uk/trackers-and-indices/latest-trackers-and-indices/world-container-index-assessed-by-drewry', 30000, 2).then(function (html) {
    var m = /\$([\d,]+)\s*per 40ft/i.exec(html);
    if (!m) throw new Error('composite pattern not found — page layout changed?');
    var composite = parseInt(m[1].replace(/,/g, ''), 10);
    // Sanity: WCI composite has lived in $1k-$11k range historically.
    if (composite < 500 || composite > 25000) throw new Error('implausible composite ' + composite);
    console.log('Drewry WCI composite: $' + composite + ' per 40ft');
    return { ok: true, composite: composite, unit: 'USD per 40ft container', source: 'Drewry WCI' };
  }).catch(function (e) {
    console.error('WCI FAILED:', e.message);
    return { ok: false, error: e.message };
  });
}

// ─── 3. Suez transits (PortWatch chokepoint1) ─────────────────────────────────
function getSuez() {
  var url = 'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/Daily_Chokepoints_Data/FeatureServer/0/query' +
    '?where=' + encodeURIComponent("portid='chokepoint1'") +
    '&outFields=date,n_total&orderByFields=' + encodeURIComponent('date DESC') +
    '&resultRecordCount=30&f=json';
  return fetchText(url).then(function (body) {
    var j = JSON.parse(body);
    if (!j.features || !j.features.length) throw new Error('no features');
    var series = j.features.map(function (f) {
      return { date: new Date(f.attributes.date).toISOString().slice(0, 10), total: f.attributes.n_total };
    }).reverse();
    var latest = series[series.length - 1];
    console.log('Suez: ' + latest.total + ' transits on ' + latest.date);
    return { ok: true, latest: latest, series: series, source: 'IMF PortWatch' };
  }).catch(function (e) {
    console.error('Suez FAILED:', e.message);
    return { ok: false, error: e.message };
  });
}

async function main() {
  console.log('fetch-freight: pulling freight-market signals...');
  var results = await Promise.all([getBunker(), getWci(), getSuez()]);
  var out = {
    updated: new Date().toISOString(),
    sources: { bunker: results[0], wci: results[1], suez: results[2] }
  };
  fs.writeFileSync(OUTPUT, JSON.stringify(out));
  var okCount = results.filter(function (r) { return r.ok; }).length;
  console.log('Written: ' + OUTPUT + ' (' + okCount + '/3 sources ok)');
  if (okCount === 0) process.exit(1); // all dead = let the workflow surface it
}

main().catch(function (e) { console.error('fetch-freight failed:', e.message); process.exit(1); });
