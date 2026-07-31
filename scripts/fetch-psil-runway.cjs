#!/usr/bin/env node
// Cash runway per PSIL holding from SEC XBRL company-concept facts.
// runwayQ = (cash + short-term investments, latest common balance date)
//           ÷ (trailing annual operating burn ÷ 4)
// Replaces the hand-keyed RUNWAY_Q constants (the last curated factor input).
//
// Honesty rules: entityName asserted per CIK (a wrong CIK can never supply
// another company's cash); burn uses the latest ANNUAL operating-cash-flow
// duration (10-Q values are YTD frames — differencing them is tag-fragile,
// annual is robust at the cost of lag, and the lag is stamped); positive
// operating cash flow → runwayQ 99 ("self-funding", capped); stale balance
// dates flagged, consumers use fresh entries only. Zero-fetch keeps last-good.

const fs = require("node:fs");
const path = require("node:path");

const OUT = path.join(__dirname, "..", "src", "data", "psil-runway.json");
const UA = "Mozilla/5.0 (compatible; osprey-cache/2.0)";
const TIMEOUT_MS = 10000;

// Keep in sync with fetch-psil-shares-outstanding.cjs CIKS.
const CIKS = {
  CMPS: { cik: "0001816590", name: "compass" },
  ATAI: { cik: "0002081043", name: "atai" },
  GHRS: { cik: "0001855129", name: "gh research" },
  DFTX: { cik: "0001813814", name: "definium" },
  HELP: { cik: "0001833141", name: "cybin" },
  ALKS: { cik: "0001520262", name: "alkermes" },
  NBIX: { cik: "0000914475", name: "neurocrine" },
  NRXP: { cik: "0001719406", name: "nrx" },
  RLMD: { cik: "0001553643", name: "relmada" },
};

const CASH_TAGS = [
  "CashAndCashEquivalentsAtCarryingValue",
  "ShortTermInvestments",
  "AvailableForSaleSecuritiesDebtSecuritiesCurrent",
  "MarketableSecuritiesCurrent",
];
const BURN_TAG = "NetCashProvidedByUsedInOperatingActivities";

// Curated cash overrides where XBRL tag coverage is PROVEN incomplete against
// the company's own stated liquidity (dated + sourced; remove when the tag
// mapping is fixed). ATAI: 10-Q line "securities carried at fair value"
// $166.8M lands in no standard us-gaap current-securities tag; company PR
// 2026-05-12 states $209.9M cash + short-term securities at 2026-03-31.
const CASH_OVERRIDES = {
  ATAI: { cash: 209.9e6, asOf: "2026-03-31", source: "company-stated (Q1 2026 PR + 10-Q); XBRL misses the securities line" },
};

async function fetchConcept(cik, tag) {
  const url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${tag}.json`;
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

// Latest instant value per tag: dedupe by end date, keep most recently filed.
function latestInstant(data) {
  const facts = data?.units?.USD || [];
  const byEnd = new Map();
  for (const f of facts) {
    if (!f.end || typeof f.val !== "number") continue;
    const prev = byEnd.get(f.end);
    if (!prev || (f.filed || "") > (prev.filed || "")) byEnd.set(f.end, f);
  }
  const ends = [...byEnd.keys()].sort();
  return ends.length ? { end: ends[ends.length - 1], byEnd } : null;
}

async function main() {
  const tickers = {};
  const gaps = [];
  for (const [ticker, { cik, name }] of Object.entries(CIKS)) {
    const cashDatas = [];
    let entityName = "";
    for (const tag of CASH_TAGS) {
      const d = await fetchConcept(cik, tag);
      if (d) { entityName = d.entityName || entityName; cashDatas.push(d); }
      await new Promise(r => setTimeout(r, 120));
    }
    const burnData = await fetchConcept(cik, BURN_TAG);
    if (burnData) entityName = burnData.entityName || entityName;
    await new Promise(r => setTimeout(r, 120));

    if (entityName && !entityName.toLowerCase().includes(name)) {
      console.warn(`psil-runway: ${ticker} CIK${cik} resolved to "${entityName}" — rejected.`);
      gaps.push(ticker);
      continue;
    }

    // Cash: sum all cash tags that report at the primary tag's latest end date.
    const primary = cashDatas.length ? latestInstant(cashDatas[0]) : null;
    if (!primary) { gaps.push(ticker); continue; }
    const balDate = primary.end;
    let cash = 0;
    for (const d of cashDatas) {
      const li = latestInstant(d);
      const f = li?.byEnd.get(balDate);
      if (f) cash += f.val;
    }

    // Burn: latest annual (330-400 day duration) operating cash flow.
    const burnFacts = (burnData?.units?.USD || []).filter(f => {
      if (!f.start || !f.end || typeof f.val !== "number") return false;
      const days = (Date.parse(f.end) - Date.parse(f.start)) / 86400000;
      return days >= 330 && days <= 400;
    });
    burnFacts.sort((a, b) => (a.end + (a.filed || "")).localeCompare(b.end + (b.filed || "")));
    const annual = burnFacts[burnFacts.length - 1];
    if (!annual) { gaps.push(ticker); continue; }

    const ov = CASH_OVERRIDES[ticker];
    const effCash = ov ? ov.cash : cash;
    const effDate = ov ? ov.asOf : balDate;
    const ageDays = Math.round((Date.now() - Date.parse(effDate)) / 86400000);
    const selfFunding = annual.val >= 0;
    const burnQ = selfFunding ? 0 : -annual.val / 4;
    const runwayQ = selfFunding ? 99 : Math.round((effCash / burnQ) * 10) / 10;
    tickers[ticker] = {
      runwayQ,
      selfFunding,
      cashM: Math.round(effCash / 1e5) / 10,
      burnQM: Math.round(burnQ / 1e5) / 10,
      cashAsOf: effDate,
      burnPeriodEnd: annual.end,
      ageDays,
      stale: ageDays > 200,
      ...(ov ? { override: true, overrideSource: ov.source } : {}),
      // The ATAI lesson generalized: a very low XBRL-summed runway is as
      // likely a missing-tag artifact as a real cash crunch. Sub-3Q readings
      // without a verified override are flagged; consumers must not score
      // them until checked against the company's stated liquidity.
      verifyLow: !ov && !selfFunding && runwayQ < 3,
    };
  }

  if (Object.keys(tickers).length === 0) {
    console.error("psil-runway: fetched nothing — keeping last-good file.");
    process.exit(fs.existsSync(OUT) ? 0 : 1);
  }

  const payload = {
    updated: new Date().toISOString(),
    source: "SEC XBRL: (cash + ST investments at latest balance date) / (trailing ANNUAL operating burn / 4); burn lags up to ~15mo by construction",
    covered: Object.keys(tickers).sort(),
    gaps: gaps.sort(),
    tickers,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 1) + "\n");
  for (const [t, v] of Object.entries(tickers)) {
    console.log(`  ${t}: ${v.selfFunding ? "self-funding" : v.runwayQ + "Q"} (cash $${v.cashM}M asof ${v.cashAsOf}${v.stale ? " STALE" : ""}${v.selfFunding ? "" : `, burn $${v.burnQM}M/Q thru ${v.burnPeriodEnd}`})`);
  }
  console.log(`psil-runway: ${Object.keys(tickers).length}/${Object.keys(CIKS).length} covered${gaps.length ? "; gaps: " + gaps.join(",") : ""}`);
}

main().catch(e => {
  console.error("psil-runway fetch FAILED (keeping last-good):", e.message);
  process.exit(fs.existsSync(OUT) ? 0 : 1);
});
