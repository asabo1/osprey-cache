#!/usr/bin/env node
// Federal lobbying filings by PSIL-holding companies, from the Senate LDA
// REST API (keyless, verified live 2026-07-31). Psychedelics is a policy-
// driven sector — lobbying spend is one of the few forward policy signals
// available free. The lda.senate.gov host migrates to lda.gov around
// 2026-07-31; both hosts are tried in order.
//
// Fail-closed: per-client failures skip that client; zero-fetch keeps the
// last-good file.

const fs = require("node:fs");
const path = require("node:path");

const OUT = path.join(__dirname, "..", "src", "data", "psil-lobbying.json");
const UA = "Mozilla/5.0 (compatible; osprey-cache/2.0)";
const TIMEOUT_MS = 12000;
const HOSTS = ["https://lda.senate.gov", "https://lda.gov"];

// Client-name queries per ticker (LDA registers by company name, not ticker).
// Lykos included ticker-less: MAPS's for-profit arm, sector-relevant.
const CLIENTS = [
  { ticker: "CMPS", q: "compass pathways" },
  { ticker: "ATAI", q: "atai" },
  { ticker: "DFTX", q: "definium" },
  { ticker: "DFTX", q: "mind medicine" },
  { ticker: "HELP", q: "cybin" },
  { ticker: null, q: "lykos therapeutics" },
];

async function ldaFetch(pathq) {
  for (const host of HOSTS) {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const res = await fetch(host + pathq, { signal: ctrl.signal, headers: { "User-Agent": UA, "Accept": "application/json" } });
      clearTimeout(to);
      if (res.ok) return await res.json();
    } catch { /* try next host */ }
  }
  return null;
}

async function main() {
  const filings = [];
  for (const c of CLIENTS) {
    const data = await ldaFetch(`/api/v1/filings/?client_name=${encodeURIComponent(c.q)}&ordering=-dt_posted&page_size=6`);
    const results = data?.results || [];
    for (const f of results) {
      // Guard the broad name query the same way the CIK feeds guard entityName.
      const clientName = f.client?.name || "";
      if (!clientName.toLowerCase().includes(c.q.split(" ")[0])) continue;
      filings.push({
        ticker: c.ticker,
        client: clientName,
        registrant: f.registrant?.name || "",
        income: f.income ? Math.round(parseFloat(f.income)) : null,
        expenses: f.expenses ? Math.round(parseFloat(f.expenses)) : null,
        period: `${f.filing_year} ${f.filing_period_display || f.filing_period || ""}`.trim(),
        type: f.filing_type_display || f.filing_type || "",
        posted: (f.dt_posted || "").slice(0, 10),
        url: f.filing_document_url || null,
      });
    }
    await new Promise(r => setTimeout(r, 200));
  }
  filings.sort((a, b) => (b.posted || "").localeCompare(a.posted || ""));

  if (filings.length === 0) {
    console.error("psil-lobbying: fetched nothing (API migration?) — keeping last-good file.");
    process.exit(fs.existsSync(OUT) ? 0 : 1);
  }

  const payload = {
    updated: new Date().toISOString(),
    source: "Senate LDA filings API (keyless); client-name matched, most recent first",
    count: filings.length,
    filings: filings.slice(0, 24),
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 1) + "\n");
  console.log(`psil-lobbying: ${filings.length} filings; latest ${filings[0].client} · ${filings[0].period} · posted ${filings[0].posted}`);
}

main().catch(e => {
  console.error("psil-lobbying FAILED (keeping last-good):", e.message);
  process.exit(fs.existsSync(OUT) ? 0 : 1);
});
