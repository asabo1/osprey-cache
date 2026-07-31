#!/usr/bin/env node
// Deal + ownership filings watch per PSIL holding, from the SEC submissions
// index (one keyless JSON per CIK; 13D/G and merger proxies file under the
// SUBJECT company's index, so this single feed covers both the corporate-
// action detector and the big-holder sweep).
//
// Born from a real miss: Lilly's acquisition of AtaiBeckley sat in the feed
// as scroll-by items (DEFA14A flood Jul 16, PREM14A Jul 30) while the desk
// kept scoring ATAI on catalysts. corpAction=true must change desk STATE.
//
// Fail-closed: per-ticker failures keep that ticker's last-good entry absent;
// zero-fetch keeps the whole last-good file.

const fs = require("node:fs");
const path = require("node:path");

const OUT = path.join(__dirname, "..", "src", "data", "psil-filings-watch.json");
const UA = "Mozilla/5.0 (compatible; osprey-cache/2.0)";
const TIMEOUT_MS = 10000;
const WINDOW_DAYS = 120;

// Keep in sync with fetch-psil-shares-outstanding.cjs / fetch-psil-runway.cjs.
const CIKS = {
  CMPS: "0001816590",
  ATAI: "0002081043",
  GHRS: "0001855129",
  DFTX: "0001813814",
  HELP: "0001833141",
  ALKS: "0001520262",
  NBIX: "0000914475",
  NRXP: "0001719406",
  RLMD: "0001553643",
};

// Flag ONLY unambiguous being-acquired paperwork (merger proxy / target's
// tender response). DEFA14A also carries routine annual-meeting materials,
// and TO-T/425 often mark the company as the ACQUIRER — those stay visible
// as deal-adjacent but never flag (a flag that cries wolf trains the eye
// to ignore it).
const DEAL_FORMS = new Set(["PREM14A", "DEFM14A", "SC 14D9"]);
const ADJACENT_FORMS = new Set(["DEFA14A", "425", "SC TO-T", "SC TO-I"]);
const OWNERSHIP_FORMS = new Set(["SC 13D", "SC 13D/A", "SC 13G", "SC 13G/A", "SCHEDULE 13D", "SCHEDULE 13D/A", "SCHEDULE 13G", "SCHEDULE 13G/A"]);
const MATERIAL_8K_ITEMS = ["1.01", "2.01", "5.01"]; // material agreement / closed acquisition / control change

async function main() {
  const cutoff = Date.now() - WINDOW_DAYS * 86400000;
  const tickers = {};
  for (const [ticker, cik] of Object.entries(CIKS)) {
    let data;
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const res = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, { signal: ctrl.signal, headers: { "User-Agent": UA, "Accept": "application/json" } });
      clearTimeout(to);
      if (!res.ok) continue;
      data = await res.json();
    } catch { continue; }
    const r = data?.filings?.recent;
    if (!r?.form) continue;
    const filings = [];
    for (let i = 0; i < r.form.length; i++) {
      const form = r.form[i];
      const date = r.filingDate[i];
      if (Date.parse(date) < cutoff) continue;
      const items = (r.items?.[i] || "");
      const isDeal = DEAL_FORMS.has(form);
      const isAdjacent = ADJACENT_FORMS.has(form);
      const isOwnership = OWNERSHIP_FORMS.has(form);
      const isMaterial8K = form === "8-K" && MATERIAL_8K_ITEMS.some(it => items.includes(it));
      if (!isDeal && !isAdjacent && !isOwnership && !isMaterial8K) continue;
      filings.push({ form, date, items: items || undefined, kind: isDeal ? "deal" : isAdjacent ? "deal-adjacent" : isOwnership ? "ownership" : "8-K" });
    }
    filings.sort((a, b) => b.date.localeCompare(a.date));
    const dealFilings = filings.filter(f => f.kind === "deal");
    tickers[ticker] = {
      corpAction: dealFilings.length > 0,
      latestDeal: dealFilings[0] || null,
      count: filings.length,
      filings: filings.slice(0, 12),
    };
    await new Promise(res2 => setTimeout(res2, 150));
  }

  if (Object.keys(tickers).length === 0) {
    console.error("psil-filings-watch: fetched nothing — keeping last-good file.");
    process.exit(fs.existsSync(OUT) ? 0 : 1);
  }

  const payload = {
    updated: new Date().toISOString(),
    window_days: WINDOW_DAYS,
    source: "SEC submissions index per CIK: merger/tender proxies, 13D/G, material 8-K items (1.01/2.01/5.01)",
    tickers,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 1) + "\n");
  for (const [t, v] of Object.entries(tickers)) {
    if (v.count) console.log(`  ${t}: ${v.count} filings${v.corpAction ? ` · CORP ACTION (${v.latestDeal.form} ${v.latestDeal.date})` : ""}`);
  }
  console.log(`psil-filings-watch: ${Object.keys(tickers).length} tickers scanned, ${Object.values(tickers).filter(v => v.corpAction).length} corp-action flags.`);
}

main().catch(e => {
  console.error("psil-filings-watch FAILED (keeping last-good):", e.message);
  process.exit(fs.existsSync(OUT) ? 0 : 1);
});
