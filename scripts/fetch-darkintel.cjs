/**
 * fetch-darkintel.cjs
 * Pulls three keyless public sources for the Dark Fleet Census and writes
 * public/data/darkintel.json. Each source is fetched independently — one
 * failure does not kill the others.
 *
 * Sources:
 *   1. IMF PortWatch (ArcGIS) — Hormuz visible transits (last 30 days)
 *   2. NGA MSI HYDROPAC broadcast warnings — Gulf navigational warnings
 *   3. adsb.lol v2/point — patrol aircraft presence near Hormuz (point-in-time)
 *
 * Output shape:
 *   { updated, sources: { portwatch, nga, adsb } }
 *   Each source: { ok: true, ...data } | { ok: false, error: string }
 */

var https = require('https');
var http  = require('http');
var fs    = require('fs');
var path  = require('path');

var OUTPUT = path.join(__dirname, '..', 'public', 'data', 'darkintel.json');
var TIMEOUT_MS = 10000;

// ─── HTTP helper ─────────────────────────────────────────────────────────────

// Fetch a URL and return the body as a string. One redirect hop, 10s timeout.
function fetchJson(rawUrl) {
  return new Promise(function(resolve, reject) {
    var controller = null; // AbortController not available in raw https; use socket timeout
    var done = false;

    function request(currentUrl) {
      var parsedUrl = new URL(currentUrl);
      var lib = parsedUrl.protocol === 'https:' ? https : http;
      var opts = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || undefined,
        path: parsedUrl.pathname + parsedUrl.search,
        headers: { 'User-Agent': 'CrudeSignal/1.0', 'Accept': 'application/json' },
        timeout: TIMEOUT_MS
      };
      var req = lib.request(opts, function(res) {
        // Follow one redirect
        if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && res.headers.location) {
          res.resume();
          var next = res.headers.location;
          if (next.startsWith('/')) next = parsedUrl.protocol + '//' + parsedUrl.hostname + next;
          request(next);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          if (!done) { done = true; reject(new Error('HTTP ' + res.statusCode)); }
          return;
        }
        var chunks = [];
        res.on('data', function(c) { chunks.push(c); });
        res.on('end', function() {
          if (!done) { done = true; resolve(chunks.join('')); }
        });
        res.on('error', function(e) {
          if (!done) { done = true; reject(e); }
        });
      });
      req.on('timeout', function() {
        req.destroy(new Error('Request timed out after ' + TIMEOUT_MS + 'ms'));
      });
      req.on('error', function(e) {
        if (!done) { done = true; reject(e); }
      });
      req.end();
    }

    request(rawUrl);
  });
}

// ─── Source 1: IMF PortWatch — Hormuz transits ───────────────────────────────

function epochToDate(ms) {
  var d = new Date(ms);
  return d.toISOString().slice(0, 10);
}

function fetchPortwatch() {
  // URL-encode query params for ArcGIS FeatureServer
  var base = 'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/Daily_Chokepoints_Data/FeatureServer/0/query';
  var params = new URLSearchParams({
    where:              "portid='chokepoint6'",
    outFields:          'date,n_total,n_tanker,n_cargo',
    orderByFields:      'date DESC',
    resultRecordCount:  '30',
    f:                  'json'
  });
  var fullUrl = base + '?' + params.toString();
  console.log('PortWatch: fetching Hormuz transits...');

  return fetchJson(fullUrl).then(function(body) {
    var data = JSON.parse(body);
    if (!data.features || !data.features.length) {
      throw new Error('No features in PortWatch response');
    }

    // Sort oldest-first for the series, newest-first entry is [0] since we ordered DESC
    var rows = data.features.map(function(f) {
      var a = f.attributes;
      return {
        date:   epochToDate(a.date),
        total:  a.n_total,
        tanker: a.n_tanker,
        cargo:  a.n_cargo
      };
    });

    // rows[0] is the latest (DESC order from API); reverse for series (oldest first)
    var latest = rows[0];
    var series = rows.slice().reverse();

    // Compute lag: how many days behind today is the latest data point
    var latestMs = new Date(latest.date + 'T00:00:00Z').getTime();
    var nowMs    = Date.now();
    var lag_days = Math.round((nowMs - latestMs) / (1000 * 60 * 60 * 24));

    console.log('PortWatch: latest ' + latest.date + ' total=' + latest.total + ' tanker=' + latest.tanker + ' lag=' + lag_days + 'd');

    return {
      ok:       true,
      latest:   latest,
      series:   series,
      lag_days: lag_days
    };
  }).catch(function(e) {
    console.error('PortWatch FAILED:', e.message);
    return { ok: false, error: e.message };
  });
}

// ─── Source 2: NGA MSI HYDROPAC broadcast warnings ───────────────────────────

var GULF_RE = /HORMUZ|PERSIAN GULF|GULF OF OMAN|STRAIT|IRAN/i;

function fetchNga() {
  var url = 'https://msi.nga.mil/api/publications/broadcast-warn?output=json';
  console.log('NGA MSI: fetching HYDROPAC warnings...');

  return fetchJson(url).then(function(body) {
    var data = JSON.parse(body);

    // Response shape: { "broadcast-warn": [...] }
    var warnings = Array.isArray(data) ? data
      : (data['broadcast-warn'] || data.broadcastWarn || data.warnings || data.items || data);

    if (!Array.isArray(warnings)) {
      throw new Error('Unexpected NGA response shape: ' + JSON.stringify(Object.keys(data)));
    }

    console.log('NGA MSI: total warnings received: ' + warnings.length);

    // Filter: navArea P + Gulf text match
    var filtered = warnings.filter(function(w) {
      var area = (w.navArea || w.nav_area || '').toUpperCase();
      var text = w.text || w.msgText || w.body || '';
      return area === 'P' && GULF_RE.test(text);
    });

    // Sort newest first by year desc, number desc
    filtered.sort(function(a, b) {
      var ay = Number(a.msgYear || a.year || 0);
      var by = Number(b.msgYear || b.year || 0);
      if (ay !== by) return by - ay;
      return Number(b.msgNumber || b.number || 0) - Number(a.msgNumber || a.number || 0);
    });

    // Cap at 25
    var top25 = filtered.slice(0, 25).map(function(w) {
      var year   = w.msgYear   || w.year   || null;
      var number = w.msgNumber || w.number || null;
      var area   = w.navArea   || w.nav_area || null;
      var text   = (w.text || w.msgText || w.body || '').slice(0, 280);
      // issued: use any date field present
      var issued = w.issueDate || w.msgDate || w.date || w.issued || null;
      return {
        id:         (area || 'P') + '-' + year + '-' + number,
        year:       year,
        number:     number,
        subregion:  w.subregion || w.subArea || null,
        text:       text,
        issued:     issued
      };
    });

    console.log('NGA MSI: ' + filtered.length + ' Gulf warnings found, returning top ' + top25.length);

    // Staleness gate: the public broadcast-warn API was found frozen at 2024
    // (zero 2025/2026 warnings during an active war — verified 2026-06-11).
    // Never present stale warnings as live; flag so the UI can skip the layer.
    var maxYear = 0;
    filtered.forEach(function(w) {
      var y = Number(w.msgYear || w.year || 0);
      if (y > maxYear) maxYear = y;
    });
    var currentYear = new Date().getUTCFullYear();
    var stale = maxYear < currentYear;
    if (stale) console.log('NGA MSI: STALE — newest warning is ' + maxYear + ' (feed frozen); flagging for UI skip');

    return {
      ok:    !stale,
      stale: stale,
      newest_year: maxYear || null,
      error: stale ? 'source stale: newest warning year ' + maxYear : undefined,
      count: filtered.length,
      warnings: top25
    };
  }).catch(function(e) {
    console.error('NGA MSI FAILED:', e.message);
    return { ok: false, error: e.message };
  });
}

// ─── Source 3: adsb.lol patrol aircraft near Hormuz ─────────────────────────

function fetchAdsb() {
  // Point: 26.5°N 56.25°E radius 250nm — Strait of Hormuz area
  var url = 'https://api.adsb.lol/v2/point/26.5/56.25/250';
  console.log('adsb.lol: fetching aircraft near Hormuz...');

  return fetchJson(url).then(function(body) {
    var data = JSON.parse(body);
    var ac = data.ac || [];

    var total = ac.length;

    // Military: dbFlags bit 1 (value & 1 === 1)
    // If result seems implausible (>50% or 0 when there are frames), fall back to dbFlags truthy.
    var milBitCount = ac.filter(function(f) {
      return (Number(f.dbFlags) & 1) === 1;
    }).length;

    var military = milBitCount;
    // NOTE: if milBitCount is 0 and total > 0, or milBitCount > total * 0.5, we use truthy fallback.
    var usedFallback = false;
    if (total > 0 && (milBitCount === 0 || milBitCount > total * 0.5)) {
      var milTruthyCount = ac.filter(function(f) { return f.dbFlags; }).length;
      military = milTruthyCount;
      usedFallback = true;
    }

    // Top 5 aircraft types by t field
    var typeCounts = {};
    ac.forEach(function(f) {
      var t = f.t || 'unknown';
      typeCounts[t] = (typeCounts[t] || 0) + 1;
    });
    var typesSorted = Object.keys(typeCounts).sort(function(a, b) {
      return typeCounts[b] - typeCounts[a];
    }).slice(0, 5);
    var types = {};
    typesSorted.forEach(function(t) { types[t] = typeCounts[t]; });

    console.log('adsb.lol: total=' + total + ' military=' + military + (usedFallback ? ' (truthy fallback)' : ' (bit1)'));

    return {
      ok:            true,
      sample: {
        total:    total,
        military: military,
        mil_method: usedFallback ? 'dbFlags_truthy' : 'dbFlags_bit1',
        types:    types,
        observed: new Date().toISOString()
      }
    };
  }).catch(function(e) {
    console.error('adsb.lol FAILED:', e.message);
    return { ok: false, error: e.message };
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('fetch-darkintel: starting Dark Fleet Census data pull...');
  console.log('Timestamp: ' + new Date().toISOString());

  // All three sources in parallel; failures are caught per-source
  var results = await Promise.all([fetchPortwatch(), fetchNga(), fetchAdsb()]);

  var portwatch = results[0];
  var nga       = results[1];
  var adsb      = results[2];

  var out = {
    updated: new Date().toISOString(),
    sources: {
      portwatch: portwatch,
      nga:       nga,
      adsb:      adsb
    }
  };

  // Ensure output directory exists
  var outDir = path.dirname(OUTPUT);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  fs.writeFileSync(OUTPUT, JSON.stringify(out, null, 2));
  var size = fs.statSync(OUTPUT).size;
  console.log('\nWritten: ' + OUTPUT + ' (' + (size / 1024).toFixed(1) + ' KB)');

  // Summary
  console.log('\n=== Summary ===');
  if (portwatch.ok) {
    console.log('PortWatch: latest=' + portwatch.latest.date + ' total=' + portwatch.latest.total + ' tanker=' + portwatch.latest.tanker + ' lag=' + portwatch.lag_days + 'd series=' + portwatch.series.length + ' pts');
  } else {
    console.log('PortWatch: FAILED — ' + portwatch.error);
  }
  if (nga.ok) {
    console.log('NGA MSI:   warnings=' + nga.count + ' returned=' + nga.warnings.length);
  } else {
    console.log('NGA MSI:   FAILED — ' + nga.error);
  }
  if (adsb.ok) {
    console.log('adsb.lol:  total=' + adsb.sample.total + ' military=' + adsb.sample.military + ' method=' + adsb.sample.mil_method);
  } else {
    console.log('adsb.lol:  FAILED — ' + adsb.error);
  }
}

main().catch(function(e) { console.error('fetch-darkintel fatal:', e.message); process.exit(1); });
