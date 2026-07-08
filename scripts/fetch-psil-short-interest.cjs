#!/usr/bin/env node
// Fetches short-interest history (days-to-cover + shares short) for the
// squeeze-candidate PSIL holdings from the Nasdaq public API and writes
// src/data/psil-short-interest.json.
//
// PSIL itself has no free short-interest data (it is not Nasdaq-listed, and
// FINRA's consolidated set does not carry it), so we chart the individual
// small-cap holdings — which are the actual squeeze candidates anyway.
//
// FINRA short interest settles bi-monthly, so a daily cron is plenty. The
// Nasdaq endpoint needs only a browser User-Agent (no key, no cookie).
// If every ticker fails, the existing file is kept (we never write an empty set).

const fs = require("node:fs");
const path = require("node:path");

const OUT = path.join(__dirname, "..", "src", "data", "psil-short-interest.json");
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// Squeeze-relevant pure-play / adjacent holdings (individual stocks). Tickers
// without Nasdaq short-interest data are skipped gracefully.
const CANDIDATES = [
  { ticker: "ATAI", company: "atai Life Sciences" },
  { ticker: "CMPS", company: "COMPASS Pathways" },
  { ticker: "GHRS", company: "GH Research" },
  { ticker: "HELP", company: "Cybin" },
  { ticker: "NRXP", company: "NRx Pharmaceuticals" },
  { ticker: "RLMD", company: "Relmada" },
  { ticker: "DRUG", company: "Bright Minds" },
  { ticker: "ANRO", company: "Alto Neuroscience" },
  { ticker: "DFTX", company: "Definium" },
];

const SERIES_LEN = 12; // ~6 months of bi-monthly settlements

async function fetchTicker(ticker) {
  const url = `https://api.nasdaq.com/api/quote/${ticker}/short-interest?assetClass=stocks`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const rows = json && json.data && json.data.shortInterestTable && json.data.shortInterestTable.rows;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const parseShares = s => parseInt(String(s).replace(/,/g, ""), 10);
  // Nasdaq returns rows newest-first; reverse to chronological, keep the tail.
  const series = rows
    .slice()
    .reverse()
    .slice(-SERIES_LEN)
    .map(r => ({
      date: r.settlementDate,
      dtc: typeof r.daysToCover === "number" ? r.daysToCover : parseFloat(r.daysToCover),
      shares: parseShares(r.interest),
    }))
    .filter(p => isFinite(p.dtc) && isFinite(p.shares));
  return series.length >= 2 ? series : null;
}

(async () => {
  const out = [];
  for (const c of CANDIDATES) {
    try {
      const series = await fetchTicker(c.ticker);
      if (series) {
        out.push({ ticker: c.ticker, company: c.company, series });
        console.log(`[short-interest] ${c.ticker}: ${series.length} settlements, latest dtc ${series[series.length - 1].dtc.toFixed(1)}`);
      } else {
        console.warn(`[short-interest] ${c.ticker}: no data`);
      }
    } catch (e) {
      console.warn(`[short-interest] ${c.ticker} failed: ${e.message}`);
    }
  }
  if (out.length === 0) {
    console.error("[short-interest] no tickers returned data; keeping existing file");
    process.exit(0);
  }
  // Most squeezable first (highest current days-to-cover).
  out.sort((a, b) => b.series[b.series.length - 1].dtc - a.series[a.series.length - 1].dtc);
  const settlementDate = out[0].series[out[0].series.length - 1].date;
  const payload = { updatedAt: new Date().toISOString(), settlementDate, tickers: out };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n");
  console.log(`[short-interest] wrote ${out.length} tickers (settlement ${settlementDate}) to ${OUT}`);
})();
