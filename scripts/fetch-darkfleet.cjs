/**
 * fetch-darkfleet.cjs — Dark Fleet Census from Global Fishing Watch SAR detections.
 *
 * Sentinel-1 radar sees every vessel; GFW matches detections against AIS.
 * matched='false' detections = vessels not broadcasting ("dark").
 * Census = radar saw N, M matched AIS, N-M ran dark.
 *
 * Needs GFW_TOKEN (free, non-commercial — attribution required:
 * "Detections (c) Global Fishing Watch / contains modified Copernicus Sentinel data").
 * Quiet no-op when unset (repo pattern). Window: last 14 days (~2 Sentinel-1 passes).
 *
 * Output: public/data/darkfleet.json
 *   { updated, window, window_start, window_end, bbox,
 *     sar_detections, dark_count, ais_matched, dark_share,
 *     cells: [{lat, lon, dark, matched}], source, lag_note }
 */

var fs = require('fs');
var path = require('path');

var TOKEN = process.env.GFW_TOKEN || '';
var OUTPUT = path.join(__dirname, '..', 'public', 'data', 'darkfleet.json');

if (!TOKEN) {
  console.log('No GFW_TOKEN — skipping dark fleet census (quiet no-op)');
  process.exit(0);
}

var DAYS = 14;
var end = new Date();
var start = new Date(end.getTime() - DAYS * 24 * 3600 * 1000);
function ymd(d) { return d.toISOString().slice(0, 10); }
function label(d) { return d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }); }

// Persian Gulf + Gulf of Oman. GeoJSON order is [lon, lat].
var REGION = { type: 'Polygon', coordinates: [[[54, 22], [60, 22], [60, 28], [54, 28], [54, 22]]] };
var BASE = 'https://gateway.api.globalfishingwatch.org/v3/4wings/report';

function query(filter) {
  var params = new URLSearchParams({
    'spatial-resolution': 'LOW',
    'temporal-resolution': 'ENTIRE',
    'format': 'JSON',
    'date-range': ymd(start) + ',' + ymd(end)
  });
  params.append('datasets[0]', 'public-global-sar-presence:latest');
  if (filter) params.append('filters[0]', filter);

  var ctl = new AbortController();
  var t = setTimeout(function () { ctl.abort(); }, 30000);
  return fetch(BASE + '?' + params.toString(), {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ geojson: REGION }),
    signal: ctl.signal
  }).then(function (res) {
    clearTimeout(t);
    if (res.status !== 200) {
      return res.text().then(function (body) {
        throw new Error('GFW HTTP ' + res.status + ': ' + body.slice(0, 200));
      });
    }
    return res.json();
  });
}

// Response rows are keyed by resolved dataset version (e.g. ":v4.0"), not ":latest".
function rows(json) {
  var entries = json.entries || [];
  if (entries.length && typeof entries[0] === 'object') {
    var key = Object.keys(entries[0]).find(function (k) { return k.indexOf('sar-presence') !== -1; });
    if (key) return entries.map(function (e) { return e[key]; }).flat().filter(Boolean);
  }
  return entries;
}

function tally(list) {
  var total = 0;
  var cells = {};
  list.forEach(function (r) {
    var v = r.detections != null ? Number(r.detections) : 0;
    total += v;
    if (r.lat != null && r.lon != null) {
      var k = r.lat + ',' + r.lon;
      cells[k] = (cells[k] || 0) + v;
    }
  });
  return { total: total, cells: cells };
}

async function main() {
  console.log('Dark fleet census: GFW SAR ' + ymd(start) + ' to ' + ymd(end) + '...');

  var all = tally(rows(await query(null)));
  var dark = tally(rows(await query("matched='false'")));

  if (all.total === 0) {
    console.log('Zero SAR detections in window — leaving existing darkfleet.json untouched');
    process.exit(0); // no acquisitions in window; do not overwrite a good census with an empty one
  }

  var matched = all.total - dark.total;
  var share = dark.total / all.total;

  // Merge per-cell: dark + matched counts
  var cellKeys = Object.keys(all.cells);
  var cells = cellKeys.map(function (k) {
    var p = k.split(',');
    var d = dark.cells[k] || 0;
    return { lat: +p[0], lon: +p[1], dark: d, matched: (all.cells[k] || 0) - d };
  }).sort(function (a, b) { return (b.dark + b.matched) - (a.dark + a.matched); });

  var out = {
    updated: new Date().toISOString(),
    window: label(start) + ' – ' + label(end),
    window_start: ymd(start),
    window_end: ymd(end),
    bbox: [54, 22, 60, 28],
    sar_detections: all.total,
    dark_count: dark.total,
    ais_matched: matched,
    dark_share: +share.toFixed(3),
    cells: cells,
    source: 'Global Fishing Watch / Sentinel-1 SAR',
    lag_note: 'Detections reflect satellite acquisitions up to ~5 days before window end'
  };

  fs.writeFileSync(OUTPUT, JSON.stringify(out));
  console.log('Census: ' + all.total + ' SAR detections, ' + dark.total + ' dark (' + Math.round(share * 100) + '%), ' + cells.length + ' cells');
  console.log('Written: ' + OUTPUT);
}

main().catch(function (e) { console.error('fetch-darkfleet failed:', e.message); process.exit(1); });
