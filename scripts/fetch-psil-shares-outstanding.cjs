#!/usr/bin/env node
// Shares outstanding per PSIL holding from SEC XBRL company-concept
// (dei:EntityCommonStockSharesOutstanding). One official keyless source feeds
// three honest numbers downstream: SI as % of shares outstanding (replaces
// hand-keyed SI%), per-holding dilution drift ("they DID dilute"), and the
// FPI-coverage report the design requires (foreign private issuers file
// thin/late XBRL — coverage is stated, never assumed).
//
// Fail-closed: per-ticker failures are recorded as gaps, and a run that
// fetches nothing keeps the last-good file.

const fs = require("node:fs");
const path = require("node:path");

const OUT = path.join(__dirname, "..", "src", "data", "psil-shares.json");
const UA = "Mozilla/5.0 (compatible; osprey-cache/2.0)";
const TIMEOUT_MS = 10000;

// Same CIKs as fetch-psil-intel.cjs SEC_FILERS (verified against
// sec.gov/files/company_tickers.json). DRUG/DFTX etc. absent = not in EDGAR.
const CIKS = {
  CMPS: "0001816590",
  ATAI: "0002081043",
  GHRS: "0001855129",
  MNMD: "0001813814",
  HELP: "0001833141",
  ALKS: "0001520262",
  NBIX: "0000914475",
  NRXP: "0001719406",
  VTGN: "0001578523",
};

async function fetchJson(url) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": UA, "Accept": "application/json" } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(to);
  }
}

async function main() {
  const tickers = {};
  const gaps = [];
  for (const [ticker, cik] of Object.entries(CIKS)) {
    const url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/dei/EntityCommonStockSharesOutstanding.json`;
    const data = await fetchJson(url);
    const facts = data?.units?.shares || [];
    // One value per cover-page date (end), latest last; dedupe by end date
    // keeping the most recently filed figure.
    const byEnd = new Map();
    for (const f of facts) {
      if (!f.end || typeof f.val !== "number") continue;
      const prev = byEnd.get(f.end);
      if (!prev || (f.filed || "") > (prev.filed || "")) byEnd.set(f.end, f);
    }
    const series = [...byEnd.values()]
      .sort((a, b) => a.end.localeCompare(b.end))
      .slice(-8)
      .map(f => ({ asOf: f.end, sharesOut: f.val, filed: f.filed || null }));
    if (series.length === 0) {
      gaps.push(ticker);
    } else {
      const latest = series[series.length - 1];
      // Stale cover-page counts (FPIs on annual cadence, dead legacy series —
      // live examples: HELP 16mo old + pre-split, VTGN last filed 2018) must
      // never denominate an SI%. Consumers use only stale:false entries.
      const ageDays = Math.round((Date.now() - Date.parse(latest.asOf)) / 86400000);
      tickers[ticker] = { sharesOut: latest.sharesOut, asOf: latest.asOf, ageDays, stale: ageDays > 200, series };
    }
    await new Promise(r => setTimeout(r, 150));
  }

  if (Object.keys(tickers).length === 0) {
    console.error("psil-shares: fetched nothing — keeping last-good file.");
    process.exit(fs.existsSync(OUT) ? 0 : 1);
  }

  const payload = {
    updated: new Date().toISOString(),
    source: "SEC XBRL company-concept dei:EntityCommonStockSharesOutstanding (cover-page share counts; quarterly cadence, not float)",
    covered: Object.keys(tickers).sort(),
    gaps: gaps.sort(), // in CIK map but no XBRL data (often FPIs)
    not_in_edgar: ["DFTX", "DRUG", "ANRO", "RLMD", "NEUP", "KTTA", "SILO", "IXHL", "ENVB", "CMND", "QNTM", "NUMI"].filter(t => !(t in CIKS)),
    tickers,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 1) + "\n");
  const cov = Object.keys(tickers);
  console.log(`psil-shares: ${cov.length}/${Object.keys(CIKS).length} covered (${cov.join(",")})${gaps.length ? "; gaps: " + gaps.join(",") : ""}`);
  for (const [t, v] of Object.entries(tickers)) console.log(`  ${t}: ${(v.sharesOut / 1e6).toFixed(1)}M shares as of ${v.asOf}`);
}

main().catch(e => {
  console.error("psil-shares fetch FAILED (keeping last-good):", e.message);
  process.exit(fs.existsSync(OUT) ? 0 : 1);
});
