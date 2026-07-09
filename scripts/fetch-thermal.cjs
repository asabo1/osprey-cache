/**
 * fetch-thermal.cjs
 * Satellite thermal-anomaly detection for the Hormuz crisis dashboard.
 * Pulls NASA FIRMS active-fire detections in the Gulf bbox, keeps only the
 * hits that fall OVER WATER (a heat source at sea = fire / attack / flaring
 * vessel = news), dedupes against a persistent known-source state, and writes
 * the NEW over-water anomalies to public/data/thermal.json.
 *
 * Most days NOTHING should alert. An empty events array is the correct, normal
 * result — not a failure.
 *
 * Source:
 *   NASA FIRMS area CSV API, two VIIRS NRT products for more passes/day:
 *     VIIRS_NOAA20_NRT  and  VIIRS_SNPP_NRT
 *   bbox 54,22,60,28 (W,S,E,N) — Persian Gulf + Strait of Hormuz + Gulf of Oman
 *   Key from env FIRMS_KEY. Quiet no-op (exit 0) when unset.
 *
 * CSV columns:
 *   latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,
 *   instrument,confidence,version,bright_ti5,frp,daynight
 *
 * Output (public/data/thermal.json):
 *   { updated, events:[{lat,lon,ts,frp,sat,cell}], known_sources, raw_in_box,
 *     water_hits }
 */

var https = require('https');
var fs    = require('fs');
var path  = require('path');

var OUTPUT     = path.join(__dirname, '..', 'public', 'data', 'thermal.json');
var STATE_FILE = path.join(__dirname, '..', 'public', 'data', 'thermal-state.json');
var TIMEOUT_MS = 12000;

var KEY = process.env.FIRMS_KEY;
var BBOX = '54,22,60,28'; // W,S,E,N — matches the dashboard's Gulf box
var PRODUCTS = ['VIIRS_NOAA20_NRT', 'VIIRS_SNPP_NRT'];

// ─── Tunables ────────────────────────────────────────────────────────────────
// TUNABLE: minimum fire radiative power (MW). Below this is too weak to be a
// meaningful fire/attack — filters out faint sub-pixel warm spots. Raise to cut
// noise, lower to catch smaller events.
var MIN_FRP = 5;
// TUNABLE: drop FIRMS confidence 'l' (low). VIIRS confidence is l/n/h
// (low/nominal/high); we keep n + h. Tighten to ['h'] to alert on high only.
var DROP_CONFIDENCE = ['l'];
// TUNABLE: a cell seen within this many days is a "known source" (e.g. a
// permanent offshore platform flare) and must NOT re-alert.
var KNOWN_DAYS = 14;
// Cell size for dedupe: round lat/lon to 0.05° (~5.5 km) so the same flare
// jittering pass-to-pass collapses to one cell key.
var CELL = 0.05;

// ─── Over-water polygons ──────────────────────────────────────────────────────
// Hand-drawn water polygons covering the three basins inside the bbox. Built
// from real coastline knowledge and biased ~10 km OFF every coast (inland-
// excluding): we would rather miss a near-shore event than alert on a coastal
// oil-field flare. Each vertex is [lat, lon]; each polygon <=20 vertices.
// A point passes the filter if it falls inside ANY of these polygons.

// (a) Persian Gulf basin — the open water NW of the Strait. Vertices hug,
// clockwise from the NW: Kuwait/N-Saudi shelf, down the Saudi/Qatar/UAE Arabian
// coast (kept offshore), across to the Iranian coast, back up the Iran shore.
var POLY_GULF = [
  [28.00, 54.00], // NW bbox edge, open water S of Iran's Bushehr coast
  [27.20, 54.00], // offshore Iran (Asaluyeh kept inland of here)
  [26.20, 54.40], // ~10 km off UAE coast near Sir Bani Yas
  [25.20, 54.60], // offshore Abu Dhabi (city + islands excluded)
  [25.10, 55.40], // offshore Dubai
  [25.60, 56.00], // approach to the Strait, off UAE Sharjah/RAK coast
  [26.40, 56.00], // mid-channel toward Iran's Qeshm side
  [26.90, 55.40], // ~10 km off Iran's Bandar Lengeh coast
  [27.30, 54.60], // offshore Iran, Kish island area kept inland
  [28.00, 54.30]  // back to N bbox edge off Iranian shore
];

// (b) Strait of Hormuz — the narrow channel. Vertices: Iranian (Qeshm/Bandar
// Abbas) shore on the N kept offshore, UAE (Musandam) shore on the S kept
// offshore. Deliberately narrow to exclude both coastlines.
var POLY_STRAIT = [
  [26.30, 56.00], // W mouth, mid-channel
  [26.70, 56.30], // off Iran's Qeshm SE tip
  [27.00, 56.80], // off Bandar Abbas approaches (city excluded, ~10 km out)
  [26.90, 57.10], // E side, still off Iranian shore
  [26.20, 56.90], // S channel, ~10 km off UAE Musandam (Khasab excluded)
  [25.90, 56.40]  // SW, off Musandam peninsula W coast
];

// (c) Gulf of Oman portion of the bbox — open water SE of the Strait. Vertices:
// Iran's Makran coast on the N kept offshore, Oman's coast on the SW kept
// offshore, open ocean on the SE/E bbox edges.
// The Oman coast runs NW->SE (Musandam ~25.8N/56.9E, Muscat ~23.6N/58.6E,
// Sur ~22.6N/59.5E). Water lies NE of that line; the SW edge below stays ~10 km
// offshore of it so coastal Muscat/Sur flares are excluded.
var POLY_OMAN = [
  [26.50, 57.20], // NW, just SE of the Strait mouth, off Iran Makran
  [26.60, 58.50], // off Iran's Jask/Makran coast
  [26.40, 60.00], // E bbox edge, off Iran SE coast
  [22.40, 60.00], // SE bbox edge, open Arabian Sea off Oman's Sur
  [22.70, 59.70], // ~10 km NE of Sur (22.57N,59.53E coast excluded)
  [23.80, 58.80], // ~10 km NE of Muscat (23.6N,58.6E coast excluded)
  [25.00, 57.40], // ~10 km off Oman's NE coast (Sohar side)
  [25.60, 57.00]  // off Oman's NE coast toward Musandam
];

var WATER_POLYS = [POLY_GULF, POLY_STRAIT, POLY_OMAN];

// Ray-casting point-in-polygon. poly = array of [lat, lon]. Returns true if the
// point [lat, lon] is inside. Standard crossing-number test (no deps).
function pointInPoly(lat, lon, poly) {
  var inside = false;
  for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    var yi = poly[i][0], xi = poly[i][1];
    var yj = poly[j][0], xj = poly[j][1];
    var intersect = ((yi > lat) !== (yj > lat)) &&
      (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function isOverWater(lat, lon) {
  for (var i = 0; i < WATER_POLYS.length; i++) {
    if (pointInPoly(lat, lon, WATER_POLYS[i])) return true;
  }
  return false;
}

// ─── HTTP helper ─────────────────────────────────────────────────────────────
// Fetch a URL and return the body as a string. Socket timeout, per-call.
function fetchText(rawUrl) {
  return new Promise(function(resolve, reject) {
    var done = false;
    var parsedUrl = new URL(rawUrl);
    var opts = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: { 'User-Agent': 'osprey-cache/1.0', 'Accept': 'text/csv' },
      timeout: TIMEOUT_MS
    };
    var req = https.request(opts, function(res) {
      if (res.statusCode !== 200) {
        res.resume();
        if (!done) { done = true; reject(new Error('HTTP ' + res.statusCode)); }
        return;
      }
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() { if (!done) { done = true; resolve(chunks.join('')); } });
      res.on('error', function(e) { if (!done) { done = true; reject(e); } });
    });
    req.on('timeout', function() { req.destroy(new Error('Request timed out after ' + TIMEOUT_MS + 'ms')); });
    req.on('error', function(e) { if (!done) { done = true; reject(e); } });
    req.end();
  });
}

// ─── CSV parse ───────────────────────────────────────────────────────────────
// Parse a FIRMS area CSV into row objects keyed by header. Returns [] on a
// header-only or empty body (no detections is normal).
function parseCsv(body) {
  var lines = body.trim().split('\n');
  if (lines.length < 2) return [];
  var header = lines[0].split(',');
  var rows = [];
  for (var i = 1; i < lines.length; i++) {
    var cols = lines[i].split(',');
    if (cols.length < header.length) continue;
    var row = {};
    for (var c = 0; c < header.length; c++) row[header[c]] = cols[c];
    rows.push(row);
  }
  return rows;
}

// ─── State ───────────────────────────────────────────────────────────────────
// State shape: { cells: { "<cell>": "<ISO last-seen>" } }
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (e) { return { cells: {} }; }
}
function saveState(st) {
  // Prune cells not seen within KNOWN_DAYS so old sources can re-alert later.
  var cutoff = Date.now() - KNOWN_DAYS * 864e5;
  var keep = {};
  Object.keys(st.cells).forEach(function(k) {
    var t = new Date(st.cells[k]).getTime();
    if (!isNaN(t) && t >= cutoff) keep[k] = st.cells[k];
  });
  st.cells = keep;
  fs.writeFileSync(STATE_FILE, JSON.stringify(st));
}

// Round a coordinate to the CELL grid and build a stable cell key.
function cellKey(lat, lon) {
  var rl = Math.round(lat / CELL) * CELL;
  var ro = Math.round(lon / CELL) * CELL;
  return rl.toFixed(2) + ',' + ro.toFixed(2);
}

// FIRMS acq_date (YYYY-MM-DD) + acq_time (HHMM, may be 1-4 digits) -> ISO UTC.
function toIso(acqDate, acqTime) {
  var t = String(acqTime || '0');
  while (t.length < 4) t = '0' + t;
  var hh = t.slice(0, 2);
  var mm = t.slice(2, 4);
  return acqDate + 'T' + hh + ':' + mm + ':00Z';
}

// ─── Fetch one product ───────────────────────────────────────────────────────
function fetchProduct(product) {
  var url = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv/' + KEY + '/' +
    product + '/' + BBOX + '/1';
  console.log('FIRMS: fetching ' + product + ' (last 1 day)...');
  return fetchText(url).then(function(body) {
    var rows = parseCsv(body);
    console.log('FIRMS: ' + product + ' -> ' + rows.length + ' raw detections');
    return rows;
  }).catch(function(e) {
    console.error('FIRMS ' + product + ' FAILED:', e.message);
    return [];
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('fetch-thermal: starting Gulf thermal-anomaly pull...');
  console.log('Timestamp: ' + new Date().toISOString());

  if (!KEY) {
    console.log('FIRMS_KEY unset — quiet no-op, not writing output.');
    process.exit(0);
  }

  // Fetch both products in parallel; per-product failures yield [].
  var batches = await Promise.all(PRODUCTS.map(fetchProduct));
  var rawRows = [].concat.apply([], batches);

  var st = loadState();
  var nowIso = new Date().toISOString();

  var rawInBox = rawRows.length;
  var waterHits = 0;
  var knownSources = 0;
  var events = [];

  rawRows.forEach(function(r) {
    var lat = parseFloat(r.latitude);
    var lon = parseFloat(r.longitude);
    if (isNaN(lat) || isNaN(lon)) return;

    // Confidence + FRP gates.
    var conf = (r.confidence || '').toLowerCase();
    if (DROP_CONFIDENCE.indexOf(conf) !== -1) return;
    var frp = parseFloat(r.frp);
    if (isNaN(frp) || frp < MIN_FRP) return;

    // Over-water gate.
    if (!isOverWater(lat, lon)) return;
    waterHits++;

    var cell = cellKey(lat, lon);

    // Dedupe: a cell already in state within KNOWN_DAYS is a known source.
    var seen = st.cells[cell];
    var isKnown = false;
    if (seen) {
      var seenMs = new Date(seen).getTime();
      if (!isNaN(seenMs) && (Date.now() - seenMs) <= KNOWN_DAYS * 864e5) isKnown = true;
    }

    // Mark/refresh this cell as seen now (so it stays a known source).
    st.cells[cell] = nowIso;

    if (isKnown) { knownSources++; return; }

    events.push({
      lat: Math.round(lat * 1e4) / 1e4,
      lon: Math.round(lon * 1e4) / 1e4,
      ts:  toIso(r.acq_date, r.acq_time),
      frp: frp,
      sat: r.satellite || r.instrument || null,
      cell: cell
    });
  });

  // Newest first, cap 20.
  events.sort(function(a, b) {
    return new Date(b.ts).getTime() - new Date(a.ts).getTime();
  });
  events = events.slice(0, 20);

  var out = {
    updated:       nowIso,
    events:        events,
    known_sources: knownSources,
    raw_in_box:    rawInBox,
    water_hits:    waterHits
  };

  var outDir = path.dirname(OUTPUT);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // Always write output — empty events is the normal, correct case.
  fs.writeFileSync(OUTPUT, JSON.stringify(out, null, 2));
  saveState(st);

  console.log('\n=== Summary ===');
  console.log('raw_in_box=' + rawInBox + ' water_hits=' + waterHits +
    ' known_sources=' + knownSources + ' new_events=' + events.length);
  console.log('Written: ' + OUTPUT);
  console.log('State cells: ' + Object.keys(st.cells).length);
}

main().catch(function(e) { console.error('fetch-thermal fatal:', e.message); process.exit(1); });
