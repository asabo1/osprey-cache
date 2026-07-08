#!/usr/bin/env node
// Refreshes 8-week sparkline shapes for each PSIL holding from Yahoo Finance.
// Rewrites the `spark` arrays inline in src/data/psil-holdings.ts.
// Does NOT touch weights, short interest, or catalyst dates (those have
// their own refresh scripts / are manually curated).
//
// Run daily via GitHub Actions.

const fs = require("node:fs");
const path = require("node:path");

const HOLDINGS_FILE = path.join(__dirname, "..", "src", "data", "psil-holdings.ts");

async function fetchWeeklyCloses(symbol) {
  // 8 weeks back via weekly interval from Yahoo
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2mo&interval=1wk`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; CrudeSignal/1.0; +https://crudesignal.io)",
        "Accept": "application/json",
      },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result?.timestamp) return null;
    const closes = result.indicators?.quote?.[0]?.close ?? [];
    // Filter nulls, take last 8
    const valid = closes.filter(c => c !== null && !isNaN(c));
    return valid.slice(-8);
  } catch (err) {
    console.warn(`[${symbol}] fetch failed: ${err.message}`);
    return null;
  }
}

function normalize(closes) {
  if (!closes || closes.length < 2) return null;
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = max - min || 1;
  return closes.map(c => +((c - min) / range).toFixed(2));
}

async function main() {
  let src = fs.readFileSync(HOLDINGS_FILE, "utf8");
  // Parse the ticker list from the file
  const tickerRe = /{\s*ticker:\s*"([^"]+)"/g;
  const tickers = [];
  let m;
  while ((m = tickerRe.exec(src))) tickers.push(m[1]);

  console.log(`Refreshing sparklines for ${tickers.length} tickers...`);

  let updated = 0;
  for (const ticker of tickers) {
    // Skip cash sleeve
    if (ticker === "BTRT") continue;
    const closes = await fetchWeeklyCloses(ticker);
    const spark = normalize(closes);
    if (!spark || spark.length < 8) {
      console.log(`  [${ticker}] insufficient data (${closes?.length || 0} points); skipping`);
      continue;
    }
    // Pad if we have fewer than 8 points
    while (spark.length < 8) spark.unshift(spark[0] ?? 0.5);

    // Replace the `spark: [...]` array for this ticker in the source.
    // Anchored to the ticker string so we don't clobber others.
    const pattern = new RegExp(
      `(ticker:\\s*"${ticker}"[\\s\\S]*?spark:\\s*)\\[[^\\]]*\\]`,
      "m"
    );
    const replacement = `$1[${spark.map(v => v.toFixed(2)).join(", ")}]`;
    const next = src.replace(pattern, replacement);
    if (next !== src) {
      src = next;
      updated++;
      console.log(`  [${ticker}] updated spark`);
    } else {
      console.log(`  [${ticker}] pattern not matched`);
    }
  }

  // Update the "Last manual update" comment with today's date
  const today = new Date().toISOString().slice(0, 10);
  src = src.replace(
    /\/\/ Last manual update:[^\n]*/,
    `// Last manual update: ${today} (sparklines auto-refreshed daily)`
  );

  fs.writeFileSync(HOLDINGS_FILE, src);
  console.log(`\nUpdated ${updated}/${tickers.length} sparklines. Wrote ${HOLDINGS_FILE}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
