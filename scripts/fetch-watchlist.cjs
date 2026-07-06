/**
 * fetch-watchlist.cjs
 * Downloads the OFAC SDN list and extracts vessel entries.
 *
 * Source: sanctionslistservice.ofac.treas.gov (public domain, no key required)
 * The /api/publicationpreview/exports/sdn.csv endpoint issues a redirect chain
 * ending at a signed S3 URL. We follow redirects up to 5 hops.
 *
 * Output: public/data/watchlist.json
 * Shape:  { updated, source, count, vessels: [{name, imo, mmsi, callsign, flag, type, programs}] }
 * Sorted: by name ascending.
 */

var https = require('https');
var http  = require('http');
var fs    = require('fs');
var path  = require('path');
var url   = require('url');

var OUTPUT  = path.join(__dirname, '..', 'public', 'data', 'watchlist.json');
var SDN_URL = 'https://sanctionslistservice.ofac.treas.gov/api/publicationpreview/exports/sdn.csv';

// Follow redirects, stream response into buffer. maxRedirects safety valve.
function fetchUrl(startUrl, maxRedirects) {
  return new Promise(function(resolve, reject) {
    var remaining = maxRedirects || 5;
    function follow(currentUrl) {
      var parsed = url.parse(currentUrl);
      var lib = parsed.protocol === 'https:' ? https : http;
      var opts = {
        hostname: parsed.hostname,
        path: parsed.path,
        headers: { 'User-Agent': 'CrudeSignal/1.0' }
      };
      lib.get(opts, function(res) {
        if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) && res.headers.location) {
          res.resume();
          if (remaining-- <= 0) { reject(new Error('Too many redirects')); return; }
          var next = res.headers.location;
          // Relative redirects
          if (next.startsWith('/')) next = parsed.protocol + '//' + parsed.hostname + next;
          console.log('Redirect -> ' + next.substring(0, 80) + '...');
          follow(next);
          return;
        }
        if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode + ' from ' + currentUrl)); return; }
        var chunks = [];
        res.on('data', function(c) { chunks.push(c); });
        res.on('end', function() { resolve(Buffer.concat(chunks)); });
        res.on('error', reject);
      }).on('error', reject);
    }
    follow(startUrl);
  });
}

// Minimal CSV parser. OFAC SDN CSV uses standard comma-delimiter with double-quoted fields.
// Handles embedded commas inside quotes. Does NOT handle embedded newlines (not present in SDN).
function parseCsvLine(line) {
  var fields = [];
  var inQuote = false;
  var current = '';
  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { current += '"'; i++; } // escaped quote
      else { inQuote = !inQuote; }
    } else if (ch === ',' && !inQuote) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

// SDN CSV column layout (0-indexed, no header row):
//   0  = SDN UID (numeric)
//   1  = Name
//   2  = SDN Type ("vessel", "individual", "entity", etc.)
//   3  = Program(s) — may contain "[" delimiters like "IRAN] [NPWMD] [IFSR"
//   4  = Title / unused for vessels
//   5  = Call Sign
//   6  = Vessel Type
//   7  = Tonnage (gross registered tons, may be -0-)
//   8  = GRT
//   9  = Vessel Flag / Country
//  10  = Vessel Owner
//  11  = Remarks (contains IMO, MMSI, former flags, linked entities, etc.)

var IMO_RE  = /\bIMO\s*[#:]*\s*(\d{7})\b/i;
var MMSI_RE = /\bMMSI\s*[#:]*\s*(\d{9})\b/i;

function parsePrograms(raw) {
  if (!raw || raw === '-0-') return [];
  // Programs are formatted as "PROG1] [PROG2] [PROG3" or just "PROG1"
  return raw.split(/\]\s*\[/).map(function(p) { return p.replace(/[\[\]]/g, '').trim(); }).filter(Boolean);
}

function processBuffer(buf) {
  var text = buf.toString('utf8');
  var lines = text.split('\n');
  console.log('SDN CSV: ' + lines.length + ' lines, ' + (buf.length / 1024 / 1024).toFixed(2) + ' MB');

  var vessels = [];
  var skipped = 0;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    var cols = parseCsvLine(line);
    if (cols.length < 3) continue;
    // Only vessel rows
    if (cols[2].toLowerCase() !== 'vessel') continue;

    var name     = cols[1] || '';
    var programs = parsePrograms(cols[3]);
    var callsign = (cols[5] && cols[5] !== '-0-') ? cols[5] : null;
    var type     = (cols[6] && cols[6] !== '-0-') ? cols[6] : null;
    var flag     = (cols[9] && cols[9] !== '-0-') ? cols[9] : null;
    var remarks  = cols[11] || '';

    var imoMatch  = IMO_RE.exec(remarks);
    var mmsiMatch = MMSI_RE.exec(remarks);
    var imo  = imoMatch  ? imoMatch[1]  : null;
    var mmsi = mmsiMatch ? mmsiMatch[1] : null;

    if (!name) { skipped++; continue; }

    vessels.push({
      name:     name,
      imo:      imo,
      mmsi:     mmsi,
      callsign: callsign,
      flag:     flag,
      type:     type,
      programs: programs
    });
  }

  // Sort by name
  vessels.sort(function(a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });

  console.log('Vessels found: ' + vessels.length + ' (skipped blank-name: ' + skipped + ')');

  // Sanity check
  if (vessels.length < 100) {
    console.error('ERROR: only ' + vessels.length + ' vessels — filter may be wrong. Check SDN format.');
    process.exit(1);
  }

  // IMO coverage stats
  var withImo  = vessels.filter(function(v) { return v.imo; }).length;
  var withMmsi = vessels.filter(function(v) { return v.mmsi; }).length;
  console.log('IMO coverage: ' + withImo + '/' + vessels.length + ' (' + Math.round(100 * withImo / vessels.length) + '%)');
  console.log('MMSI coverage: ' + withMmsi + '/' + vessels.length + ' (' + Math.round(100 * withMmsi / vessels.length) + '%)');

  return vessels;
}

async function main() {
  console.log('fetch-watchlist: downloading OFAC SDN CSV...');
  console.log('Source: ' + SDN_URL);

  var buf = await fetchUrl(SDN_URL, 5);
  var vessels = processBuffer(buf);

  var out = {
    updated:  new Date().toISOString(),
    source:   'OFAC SDN',
    source_url: SDN_URL,
    count:    vessels.length,
    vessels:  vessels
  };

  // Ensure output directory exists
  var outDir = path.dirname(OUTPUT);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  fs.writeFileSync(OUTPUT, JSON.stringify(out, null, 2));
  var outSize = fs.statSync(OUTPUT).size;
  console.log('Written: ' + OUTPUT + ' (' + (outSize / 1024).toFixed(1) + ' KB)');

  // Print 5 sample entries
  console.log('\nSample entries:');
  for (var i = 0; i < Math.min(5, vessels.length); i++) {
    var v = vessels[i];
    console.log('  ' + v.name + ' | IMO:' + (v.imo || 'none') + ' | flag:' + (v.flag || 'none') + ' | type:' + (v.type || 'none') + ' | programs:' + v.programs.join(','));
  }
}

main().catch(function(e) { console.error('fetch-watchlist failed:', e.message); process.exit(1); });
