#!/usr/bin/env node
// PSIL fund holdings/AUM from the sponsor's own daily holdings CSV.
// Replaces hand-keyed weights and the stale hardcoded AUM at the root.
//
// Fail-closed by design: the CSV is the single most damaging silent-death
// dependency (a frozen file keeps every derived number plausible and wrong),
// so every run asserts schema + sanity and keeps the last-good file on any
// failure. The site renders "holdings as of <date>" from asOf and can flag
// staleness itself.

const fs = require("node:fs");
const path = require("node:path");

const OUT = path.join(__dirname, "..", "src", "data", "psil-fund.json");
const URL = "https://advisorshares.com/wp-content/uploads/csv/holdings/AdvisorShares_PSIL_Holdings_File.csv";
const TIMEOUT_MS = 15000;

// Minimal CSV line parser (handles quoted fields with embedded commas).
function splitCsvLine(line) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === "," && !inQ) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

const num = s => {
  const n = parseFloat(String(s).replace(/[",%$]/g, ""));
  return Number.isFinite(n) ? n : null;
};

async function main() {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let text;
  try {
    const res = await fetch(URL, { signal: ctrl.signal, headers: { "User-Agent": "osprey-cache/1.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } finally {
    clearTimeout(to);
  }

  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const header = splitCsvLine(lines[0]);
  const need = ["Date", "Stock Ticker", "Security Description", "Portfolio Weight %", "Asset Group"];
  for (const h of need) {
    if (!header.some(c => c === h)) throw new Error(`missing header: ${h}`);
  }
  const col = name => header.findIndex(c => c === name);
  const iDate = col("Date"), iTic = col("Stock Ticker"), iDesc = col("Security Description");
  const iShares = header.findIndex(c => c.startsWith("Shares/Par"));
  const iPrice = header.findIndex(c => c.startsWith("Price"));
  const iVal = header.findIndex(c => c.startsWith("Traded Market Value"));
  const iW = col("Portfolio Weight %"), iG = col("Asset Group");

  // Date appears only on the first data row.
  let asOf = null;
  const holdings = [];
  for (const line of lines.slice(1)) {
    const f = splitCsvLine(line);
    if (f.length < header.length - 1) continue;
    if (!asOf && f[iDate]) {
      const m = f[iDate].match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (m) asOf = `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    }
    const ticker = (f[iTic] || "").toUpperCase();
    const weightPct = num(f[iW]);
    if (!ticker || weightPct === null) continue;
    holdings.push({
      ticker,
      desc: f[iDesc] || "",
      shares: num(f[iShares]),
      price: num(f[iPrice]),
      value: num(f[iVal]),
      weightPct,
      assetGroup: f[iG] || "",
    });
  }

  // Sanity gates — any failure keeps the last-good file.
  if (!asOf) throw new Error("no as-of date parsed");
  if (holdings.length < 12 || holdings.length > 30) throw new Error(`suspect row count ${holdings.length}`);
  const wSum = holdings.reduce((s, h) => s + h.weightPct, 0);
  if (wSum < 99 || wSum > 101) throw new Error(`weights sum ${wSum.toFixed(2)}`);
  const top = Math.max(...holdings.map(h => h.weightPct));
  if (top >= 40) throw new Error(`top weight ${top} implausible`);
  for (const h of holdings) {
    if (!/^[A-Z.]{1,6}$/.test(h.ticker) && h.assetGroup !== "C") throw new Error(`suspect ticker ${h.ticker}`);
  }

  const aum = holdings.reduce((s, h) => s + (h.value || 0), 0);
  const payload = {
    updated: new Date().toISOString(),
    asOf,
    source: "sponsor daily holdings file",
    aum: Math.round(aum),
    count: holdings.length,
    holdings: holdings.sort((a, b) => b.weightPct - a.weightPct),
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 1) + "\n");
  console.log(`psil-fund: ${holdings.length} holdings as of ${asOf}, AUM $${(aum / 1e6).toFixed(1)}M, top ${payload.holdings[0].ticker} ${payload.holdings[0].weightPct}%`);
}

main().catch(e => {
  // Fail closed: last-good stays; the failure is loud in the Actions log.
  console.error("psil-fund fetch FAILED (keeping last-good):", e.message);
  process.exit(fs.existsSync(OUT) ? 0 : 1);
});
