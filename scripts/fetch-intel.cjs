const Parser = require('rss-parser');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Browser UA: Hellenic/FreightWaves 403 the default node UA; 15s timeout:
// eia.gov's RSS is slow but valid.
const parser = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' },
});
const OUTPUT = path.join(__dirname, '..', 'public', 'data', 'daily.json');

// Yahoo Finance live price + 6-month chart data
function getYahooChart(symbol) {
  return new Promise(function(resolve) {
    https.get({
      hostname: 'query1.finance.yahoo.com',
      path: '/v8/finance/chart/' + symbol + '?interval=1d&range=1y',
      headers: { 'User-Agent': 'osprey-cache/1.0' }
    }, function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() {
        try { resolve(JSON.parse(d).chart.result[0]); }
        catch(e) { console.error('Yahoo ' + symbol + ' parse error'); resolve(null); }
      });
    }).on('error', function() { resolve(null); });
  });
}

var AIS_KEY = process.env.PUBLIC_AISSTREAM_KEY || '';

// Build vessel cache from aisstream.io (75 seconds per run)
// Also persists live vessel POSITIONS to public/data/vessels.json for our own tracker.
var VESSELS_FILE = path.join(__dirname, '..', 'public', 'data', 'vessels.json');
function loadVesselPositions() {
  try { return JSON.parse(fs.readFileSync(VESSELS_FILE, 'utf8')); } catch (e) { return { updated: null, vessels: {} }; }
}
function buildVesselCache(existing) {
  if (!AIS_KEY) { console.log('No AIS key — skipping vessel cache'); return Promise.resolve({}); }
  var cache = existing.vesselCache || {};
  var pos = loadVesselPositions();
  return new Promise(function(resolve) {
    var WebSocket;
    try { WebSocket = require('ws'); } catch(e) { console.log('ws not installed — skipping vessel cache'); resolve(cache); return; }
    var ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
    var added = 0;
    var timeout = setTimeout(function() { ws.close(); resolve(cache); }, 75000);
    ws.on('open', function() {
      ws.send(JSON.stringify({
        APIKey: AIS_KEY,
        BoundingBoxes: [[[20, 50], [30, 62]]],
        FilterMessageTypes: ['PositionReport', 'ShipStaticData']
      }));
    });
    ws.on('message', function(data) {
      try {
        var msg = JSON.parse(data);
        var meta = msg.MetaData;
        if (!meta || !meta.ShipName) return;
        // Persist position (our own tracker's data layer)
        if (meta.MMSI && meta.latitude != null && meta.longitude != null) {
          var pr = (msg.Message && msg.Message.PositionReport) || {};
          pos.vessels[String(meta.MMSI)] = {
            name: meta.ShipName.trim().toUpperCase(),
            lat: +(+meta.latitude).toFixed(4),
            lon: +(+meta.longitude).toFixed(4),
            cog: pr.Cog != null ? Math.round(pr.Cog) : null,
            sog: pr.Sog != null ? +(+pr.Sog).toFixed(1) : null,
            type: meta.ShipType || null,
            ts: new Date().toISOString()
          };
        }
        var name = meta.ShipName.trim().toUpperCase();
        if (!name || name.length < 2) return;
        // Get ship type from static data or position report
        var shipType = null;
        if (msg.Message && msg.Message.ShipStaticData) {
          var t = msg.Message.ShipStaticData.Type;
          var dim = msg.Message.ShipStaticData.Dimension;
          var dwt = 0;
          if (dim) { var len = (dim.A || 0) + (dim.B || 0); dwt = Math.round(len * len * 0.15); } // rough DWT estimate from length
          if (t >= 60 && t <= 69) shipType = { type: 'Passenger', commodity: null, confidence: 'high', sizeClass: 'Passenger', dwt: dwt };
          else if (t >= 70 && t <= 79) shipType = { type: 'Cargo', commodity: 'General Cargo', confidence: 'medium', sizeClass: 'Cargo', dwt: dwt };
          else if (t >= 80 && t <= 89) {
            var commodity = 'Crude Oil';
            var sc = 'Tanker';
            var bbl = Math.round(dwt * 7.3);
            if (t === 83) { commodity = 'Chemical'; sc = 'Chemical Tanker'; }
            else if (t === 84) { commodity = 'LNG/LPG'; sc = 'Gas Carrier'; }
            else if (dwt < 25000) { commodity = 'Refined Products'; sc = 'Small Tanker'; }
            else if (dwt < 55000) { commodity = 'Refined Products'; sc = 'MR Tanker'; }
            else if (dwt < 120000) { commodity = 'Crude Oil'; sc = 'Aframax'; }
            else if (dwt < 200000) { commodity = 'Crude Oil'; sc = 'Suezmax'; }
            else { commodity = 'Crude Oil'; sc = 'VLCC'; }
            shipType = { type: 'Tanker', commodity: commodity, confidence: 'medium', sizeClass: sc, dwt: dwt, capacityBbl: bbl };
          }
        }
        // Also infer from position report ship type if available
        if (!shipType && meta.ShipType) {
          var st = meta.ShipType;
          if (st >= 80 && st <= 89) shipType = { type: 'Tanker', commodity: 'Petroleum Products', confidence: 'low', sizeClass: 'Tanker', dwt: 0 };
          else if (st >= 70 && st <= 79) shipType = { type: 'Cargo', commodity: 'General Cargo', confidence: 'low', sizeClass: 'Cargo', dwt: 0 };
        }
        if (shipType && !cache[name]) {
          cache[name] = shipType;
          added++;
        }
      } catch(e) {}
    });
    ws.on('error', function() { clearTimeout(timeout); resolve(cache); });
    ws.on('close', function() {
      clearTimeout(timeout);
      // Expire stale positions (>6h) and write the tracker file
      var cutoff = Date.now() - 6 * 3600 * 1000;
      var kept = {};
      var live = 0;
      Object.keys(pos.vessels).forEach(function(mmsi) {
        var v = pos.vessels[mmsi];
        if (v.ts && new Date(v.ts).getTime() > cutoff) { kept[mmsi] = v; live++; }
      });
      try {
        fs.writeFileSync(VESSELS_FILE, JSON.stringify({ updated: new Date().toISOString(), count: live, vessels: kept }));
        console.log('Tracker: ' + live + ' live vessel positions persisted');
      } catch (e) { console.log('Tracker write failed: ' + e.message); }
      console.log('Vessel cache: +' + added + ' new vessels (total: ' + Object.keys(cache).length + ')');
      resolve(cache);
    });
  });
}

// Shared classification/outlet logic — also imported by the live route
// src/pages/api/wire.json.ts so the two wire paths cannot drift.
var wireCore = require('./lib/wire-core.cjs');

// Feeds to fetch
// gate:'oil' = shipping feed, must hit an energy token (wire-core OIL_STRICT).
// cap = per-feed item limit. Keep in sync with src/pages/api/wire.json.ts.
var FEEDS = [
  { url: 'https://feeds.bloomberg.com/markets/news.rss', name: 'Bloomberg' },
  { url: 'https://news.google.com/rss/search?q=site:reuters.com+oil+OR+hormuz&hl=en-US&gl=US&ceid=US:en', name: 'Reuters' },
  { url: 'https://feeds.finance.yahoo.com/rss/2.0/headline?s=CL=F', name: 'Yahoo Oil' },
  { url: 'https://feeds.finance.yahoo.com/rss/2.0/headline?s=BZ=F', name: 'Yahoo Brent' },
  { url: 'https://news.google.com/rss/search?q=strait+of+hormuz&hl=en-US&gl=US&ceid=US:en', name: 'Google Hormuz' },
  { url: 'https://news.google.com/rss/search?q=oil+prices+2026&hl=en-US&gl=US&ceid=US:en', name: 'Google Oil' },
  { url: 'https://www.rigzone.com/news/rss/rigzone_latest.aspx', name: 'Rigzone' },
  { url: 'https://gcaptain.com/feed/', name: 'Maritime', gate: 'oil', cap: 8 },
  { url: 'https://splash247.com/feed/', name: 'Maritime', gate: 'oil', cap: 8 },
  { url: 'https://www.hellenicshippingnews.com/feed/', name: 'Maritime', gate: 'oil', cap: 8 },
  { url: 'https://www.freightwaves.com/feed', name: 'Freight', gate: 'oil', cap: 6 },
  // plain RSS despite the /api/ path (verified 2026-07-02)
  { url: 'https://services.tradewindsnews.com/api/feed/rss', name: 'Maritime', gate: 'oil', cap: 8 }
  // EIA press RSS: 406s under the browser UA this parser needs for Hellenic/
  // FreightWaves, and it's low-cadence anyway — served by the live route only.
];

async function main() {
  console.log('Fetching intel from', FEEDS.length, 'feeds...');

  var allItems = [];

  for (var i = 0; i < FEEDS.length; i++) {
    var feed = FEEDS[i];
    try {
      var result = await parser.parseURL(feed.url);
      console.log(feed.name + ':', result.items.length, 'items');

      var feedCap = feed.cap || result.items.length;
      for (var j = 0; j < Math.min(result.items.length, feedCap); j++) {
        var item = result.items[j];
        var text = (item.title || '') + ' ' + (item.contentSnippet || '');

        // Relevance + severity + direction via the shared word-boundary
        // classifiers (bare /war/ used to tag "WARSH" headlines CRIT).
        if (!wireCore.feedRelevant(text, feed.gate)) continue;
        var cls = wireCore.classify(text);
        var severity = cls.severity;
        var direction = cls.direction;

        // Extract time
        var pubDate = item.pubDate ? new Date(item.pubDate) : new Date();
        var timeStr = String(pubDate.getUTCHours()).padStart(2, '0') + ':' + String(pubDate.getUTCMinutes()).padStart(2, '0');

        // Pull the real publisher out of the aggregator suffix instead of
        // discarding it; feed name stays as the topic.
        var split = wireCore.splitOutlet(item.title || '');
        var title = split.text;
        if (title.length > 120) title = title.substring(0, 117) + '...';

        // Items older than 5 days fall off (the audit found 5-week-old
        // backfill seeding the homepage tape at equal weight to live items).
        if (Date.now() - pubDate.getTime() > 5 * 24 * 3600 * 1000) continue;

        allItems.push({
          time: timeStr,
          severity: severity,
          direction: direction,
          text: title,
          outlet: split.outlet,
          source: feed.name.replace('Google ', '').replace('Yahoo ', ''),
          date: pubDate.toISOString(),
          link: item.link || ''
        });
      }
    } catch (e) {
      console.error(feed.name, 'failed:', e.message);
    }
  }

  // Story clustering (wire-core): one slot per story, latest retelling leads,
  // break credit + other outlets in first/also. Also fixes sentiment counts:
  // five outlets covering one bearish story used to count as five BEARs.
  allItems.sort(function(a, b) { return new Date(b.date) - new Date(a.date); });
  var unique = wireCore.cluster(allItems);

  // Keep top 15
  var intel = unique.slice(0, 15);
  console.log('Filtered:', allItems.length, '→', unique.length, '→ keeping', intel.length);

  // Load existing daily.json and update intel field
  var existing = {};
  if (fs.existsSync(OUTPUT)) {
    try { existing = JSON.parse(fs.readFileSync(OUTPUT, 'utf8')); } catch(e) {}
  }

  // Calculate sentiment summary
  var bullCount = 0, bearCount = 0, neutralCount = 0;
  for (var s = 0; s < intel.length; s++) {
    if (intel[s].direction === 'BULL') bullCount++;
    else if (intel[s].direction === 'BEAR') bearCount++;
    else neutralCount++;
  }
  var netSignal = 'NEUTRAL';
  if (bullCount > bearCount + 2) netSignal = 'BULLISH';
  else if (bearCount > bullCount + 2) netSignal = 'BEARISH';
  else if (bullCount > bearCount) netSignal = 'LEAN BULL';
  else if (bearCount > bullCount) netSignal = 'LEAN BEAR';

  existing.intel = intel;
  existing.intel_updated = new Date().toISOString();
  existing.updated = new Date().toISOString();
  existing.sentiment = {
    bull: bullCount,
    bear: bearCount,
    neutral: neutralCount,
    net: netSignal
  };
  console.log('Sentiment:', bullCount, 'bull /', bearCount, 'bear /', neutralCount, 'neutral → ' + netSignal);

  // AUTO EVENT LOG — only truly significant events make it here
  // This is NOT a news feed — it's a historical record of game-changing moments
  var eventLog = existing.event_log || [];
  var months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

  // Only these keywords qualify as event-log-worthy (war, physical attacks, major policy shifts)
  var EVENT_TRIGGERS = /attack|strike|bomb|missile|explosion|killed|destroy|sunk|fire.*vessel|fire.*tanker|blockade.*extend|blockade.*lifted|hormuz.*closed|hormuz.*open|hormuz.*reopen|ceasefire|peace.*deal|war.*end|war.*over|invasion|ground.*force|troops.*deploy|nuclear|sanctions.*lifted|sanctions.*imposed|reserves.*exhaust|reserves.*release|opec.*emergency|oil.*embargo|pipeline.*attack|refinery.*attack|smelter.*attack|naval.*engag/i;

  // Build lookup of existing events
  var existingTexts = {};
  for (var e = 0; e < eventLog.length; e++) {
    existingTexts[eventLog[e].text.substring(0, 40).toLowerCase()] = true;
  }

  var added = 0;
  for (var c = 0; c < unique.length; c++) {
    var ci = unique[c];
    // Must match event triggers — not just any CRIT headline
    if (!EVENT_TRIGGERS.test(ci.text)) continue;

    var eventKey = ci.text.substring(0, 40).toLowerCase();
    if (existingTexts[eventKey]) continue;

    var eventDate = new Date(ci.date);
    var dateStr = months[eventDate.getUTCMonth()] + ' ' + String(eventDate.getUTCDate()).padStart(2, '0');

    // Determine severity based on content
    var evSev = 'CRIT';
    if (/ceasefire|peace|open|lifted|end|over/i.test(ci.text)) evSev = 'WARN';

    eventLog.unshift({
      date: dateStr,
      date_iso: ci.date,
      severity: evSev,
      text: ci.text,
      source: ci.source,
      link: ci.link || '',
      auto: true
    });
    existingTexts[eventKey] = true;
    added++;
  }

  // Sort by date (newest first)
  eventLog.sort(function(a, b) { return new Date(b.date_iso || 0) - new Date(a.date_iso || 0); });

  // Keep last 60 days of events, max 50 entries
  var cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 60);
  eventLog = eventLog.filter(function(ev) {
    if (!ev.date_iso) return true; // keep manually added events without ISO date
    return new Date(ev.date_iso) >= cutoff;
  }).slice(0, 50);

  existing.event_log = eventLog;
  if (added > 0) console.log('Event log: +' + added + ' new events promoted');

  // Attacked-vessel count: PINNED to the open-source floor (2026-06-11 audit).
  // The old auto-increment regex counted any war headline (incl. strikes on
  // land bases) as a vessel attack and drifted 25 -> 96 vs a sourced 22-43
  // range (Lloyd's List / Al Jazeera / UKMTO tallies through May 14).
  // Update manually with the weekly issue; never auto-increment from headlines.
  existing.vessels_attacked = { count: 43, floor: true, tankers: 11, basis: 'open-source floor through 2026-05-14', last_updated: '2026-05-14' };

  // Live oil prices from Yahoo Finance (runs every 10 min)
  try {
    var charts = await Promise.all([getYahooChart('BZ=F'), getYahooChart('CL=F'), getYahooChart('^GSPC')]);
    var brentChart = charts[0];
    var wtiChart = charts[1];
    var sp500Chart = charts[2];
    if (brentChart && wtiChart) {
      var brentLive = brentChart.meta.regularMarketPrice;
      var wtiLive = wtiChart.meta.regularMarketPrice;
      // Prev = the prior trading-day close, derived from the actual daily-close
      // series. meta.chartPreviousClose is unreliable for the front-month
      // futures: on a contract roll it returns a stale/other-contract value
      // (seen ~65 against a real prior close of ~72, which flipped the delta to
      // +5 while prices were easing), and otherwise it can point several
      // sessions back rather than to yesterday. Second-to-last daily close is
      // roll-proof and weekend-proof.
      var priorClose = function (ch) {
        var q = ch.indicators && ch.indicators.quote && ch.indicators.quote[0];
        var cl = ((q && q.close) || []).filter(function (c) { return c != null && !isNaN(c); });
        return cl.length >= 2 ? +(+cl[cl.length - 2]).toFixed(2) : null;
      };
      var brentPrev = priorClose(brentChart);
      if (brentPrev == null) brentPrev = existing.latest ? existing.latest.brent_prev : null;
      var wtiPrev = priorClose(wtiChart);
      if (wtiPrev == null) wtiPrev = existing.latest ? existing.latest.wti_prev : null;
      // Update latest prices
      if (existing.latest) {
        existing.latest.brent = brentLive;
        existing.latest.wti = wtiLive;
        if (brentPrev != null) {
          existing.latest.brent_prev = +(+brentPrev).toFixed(2);
          existing.latest.brent_delta = +(brentLive - brentPrev).toFixed(2);
        }
        if (wtiPrev != null) {
          existing.latest.wti_prev = +(+wtiPrev).toFixed(2);
          existing.latest.wti_delta = +(wtiLive - wtiPrev).toFixed(2);
        }
        existing.latest.spread = +(brentLive - wtiLive).toFixed(2);
      }
      // Build chart data for custom SVG charts (6 months daily)
      var brentTs = brentChart.timestamp || [];
      var brentClose = brentChart.indicators.quote[0].close || [];
      var wtiTs = wtiChart.timestamp || [];
      var wtiClose = wtiChart.indicators.quote[0].close || [];
      existing.chart_brent = [];
      existing.chart_wti = [];
      for (var ci = 0; ci < brentTs.length; ci++) {
        if (brentClose[ci] != null) existing.chart_brent.push({ t: brentTs[ci] * 1000, p: +brentClose[ci].toFixed(2) });
      }
      for (var wi = 0; wi < wtiTs.length; wi++) {
        if (wtiClose[wi] != null) existing.chart_wti.push({ t: wtiTs[wi] * 1000, p: +wtiClose[wi].toFixed(2) });
      }
      // Compute spread chart (Brent - WTI)
      existing.chart_spread = [];
      var spreadLen = Math.min(existing.chart_brent.length, existing.chart_wti.length);
      for (var si = 0; si < spreadLen; si++) {
        existing.chart_spread.push({
          t: existing.chart_brent[si].t,
          p: +(existing.chart_brent[si].p - existing.chart_wti[si].p).toFixed(2)
        });
      }
      // S&P 500
      if (sp500Chart) {
        var spTs = sp500Chart.timestamp || [];
        var spClose = sp500Chart.indicators.quote[0].close || [];
        existing.chart_sp500 = [];
        for (var spi = 0; spi < spTs.length; spi++) {
          if (spClose[spi] != null) existing.chart_sp500.push({ t: spTs[spi] * 1000, p: +spClose[spi].toFixed(2) });
        }
        existing.latest_sp500 = sp500Chart.meta.regularMarketPrice;
        console.log('S&P 500: ' + sp500Chart.meta.regularMarketPrice.toFixed(2) + ' | Points: ' + existing.chart_sp500.length);
      }
      console.log('Live prices: Brent $' + brentLive.toFixed(2) + ' | WTI $' + wtiLive.toFixed(2) + ' | Chart points: ' + existing.chart_brent.length);
    }
  } catch(priceErr) {
    console.error('Yahoo Finance fetch failed:', priceErr.message);
  }

  // Dynamic Signal Outlook — scan recent intel for keyword clusters
  var outlook = [
    { name: 'Reserve Runway', severity: 'CRIT', val: null, re: /reserve|spr|strategic petroleum|stockpile|supply cliff/i },
    { name: 'War Risk Premium', severity: 'CRIT', val: null, re: /war risk|insurance|hull value|premium surge|lloyd/i },
    { name: 'IRGC Activity', severity: 'CRIT', val: null, re: /irgc|revolutionary guard|naval exercise|smelter|iran military/i },
    { name: 'Iran Sanctions', severity: 'WARN', val: null, re: /sanction|waiver|designation|iran nuclear|jcpoa/i },
    { name: 'Diplomacy', severity: 'WARN', val: null, re: /ceasefire|peace|talk|negotiat|diplomat|de-escalat|deal/i }
  ];
  // Scan the latest 15 intel items for matches
  for (var oi = 0; oi < outlook.length; oi++) {
    var matches = [];
    for (var oj = 0; oj < intel.length; oj++) {
      if (outlook[oi].re.test(intel[oj].text)) matches.push(intel[oj].text);
    }
    if (matches.length > 0) {
      // Truncate the most recent match to 60 chars for the outlook value
      outlook[oi].val = matches[0].substring(0, 60) + (matches[0].length > 60 ? '...' : '');
    }
  }
  existing.signal_outlook = outlook.map(function(o) {
    return { name: o.name, severity: o.severity, val: o.val };
  });

  // Build vessel cache from aisstream.io (30s connection per run)
  var vesselCache = await buildVesselCache(existing);
  existing.vesselCache = vesselCache;

  // Also update vessel-ref.json with the cache for client-side lookup
  var refPath = path.join(__dirname, '..', 'public', 'data', 'vessel-ref.json');
  try {
    var refData = JSON.parse(fs.readFileSync(refPath, 'utf8'));
    refData.vesselCache = vesselCache;
    fs.writeFileSync(refPath, JSON.stringify(refData, null, 2));
    console.log('Vessel cache written to vessel-ref.json (' + Object.keys(vesselCache).length + ' vessels)');
  } catch(e) { console.error('Failed to update vessel-ref.json:', e.message); }

  fs.writeFileSync(OUTPUT, JSON.stringify(existing, null, 2));
  console.log('Intel feed updated with', intel.length, ' items | Event log has', eventLog.length, 'entries');

  // Print top 5
  for (var m = 0; m < Math.min(5, intel.length); m++) {
    console.log('[' + intel[m].severity + '] ' + intel[m].time + ' ' + intel[m].text);
  }
}

main().catch(function(e) { console.error(e); process.exit(1); });
