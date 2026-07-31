#!/usr/bin/env node
// Auto-updating forward catalyst calendar for the PSIL dashboard.
//
// Root-cause fix: the old psil-catalysts.ts was a manual file that only ever
// LOST entries (fetch-psil-catalyst-days.cjs recomputed `days` and dropped past
// events, but nothing ever ADDED forward ones), so it decayed to near-empty.
//
// This pulls real forward trial readouts from clinicaltrials.gov (v2 API, no
// key) for each holding's registered Phase 2/3 studies, using the trial's
// primary completion date as the readout proxy, and writes them to
// src/data/psil-catalysts-live.json with a generated timestamp. The page merges
// that file live and the daily GitHub Action reruns this, so the calendar keeps
// itself current. Runs alongside fetch-psil-catalyst-days.cjs (kept for the
// manual seed's day recompute; this file is the auto path). The serverless
// route src/pages/api/psil-catalysts.json.ts is the between-deploy live refresh.
//
// Honest by construction: primary completion date != topline announcement (the
// readout usually lands weeks to months later), so every item is labelled with
// its source and its date precision. We do not invent dates.

const fs = require("node:fs");
const path = require("node:path");

// Written to src/data (not public/) so the SSR page can import it into its
// module bundle — public/ files aren't in Vite's module graph. The daily cron
// commits this file; a commit redeploys, so the calendar refreshes daily.
const OUT = path.join(__dirname, "..", "src", "data", "psil-catalysts-live.json");
const API = "https://clinicaltrials.gov/api/v2/studies";
const FORWARD_WINDOW_DAYS = 300; // how far ahead to surface a readout
const TIMEOUT_MS = 8000;

// ticker -> clinicaltrials.gov lead-sponsor query. Curated (fund company names
// don't always match the CT.gov sponsor of record). Big Pharma / Cash omitted:
// no psychedelic readouts to track. Add a ticker here to bring it into scope.
const SPONSORS = {
  CMPS: "COMPASS Pathways",
  GHRS: "GH Research",
  ATAI: "atai Therapeutics",
  ANRO: "Alto Neuroscience",
  HELP: "Cybin",
  DRUG: "Bright Minds Biosciences",
  RLMD: "Relmada Therapeutics",
  NRXP: "NRx Pharmaceuticals",
  NEUP: "Neuphoria Therapeutics",
  KTTA: "Pasithea Therapeutics",
  SILO: "Silo Pharma",
  VTGN: "VistaGen Therapeutics",
  IXHL: "Incannex Healthcare",
  ENVB: "Enveric Biosciences",
  CMND: "Clearmind Medicine",
  DFTX: "Definium Therapeutics",
  QNTM: "Quantum BioPharma",
  NUMI: "Numinus Wellness",
};

function daysBetween(fromISO, toISO) {
  return Math.round((Date.parse(toISO) - Date.parse(fromISO)) / 86400000);
}

// Normalise a CT.gov date ("YYYY-MM" or "YYYY-MM-DD") to a full ISO date and a
// precision flag. Month-only dates are pinned to the 15th (mid-month estimate).
function normDate(raw) {
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { date: raw, precision: "day" };
  if (/^\d{4}-\d{2}$/.test(raw)) return { date: `${raw}-15`, precision: "month" };
  return null;
}

function tokens(name) {
  return name.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter(w => w.length > 2);
}

// Guard against a broad sponsor query pulling in an unrelated sponsor: require
// the returned lead-sponsor to share a meaningful token with our query.
function sponsorMatches(query, actual) {
  if (!actual) return false;
  const q = tokens(query), a = actual.toLowerCase();
  return q.some(t => a.includes(t));
}

async function fetchJson(url) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "osprey-cache/1.0" } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(to);
  }
}

function classify(phases) {
  const p = (phases || []).join("/");
  if (p.includes("PHASE3")) return { type: "PH3", importance: "CRITICAL" };
  if (p.includes("PHASE2")) return { type: "PH2", importance: "HIGH" };
  return null; // Ph1 / N/A — not a market-moving binary for this desk
}

async function fetchTicker(ticker, sponsor, todayISO) {
  const url = `${API}?query.spons=${encodeURIComponent(sponsor)}`
    + `&filter.overallStatus=RECRUITING,ACTIVE_NOT_RECRUITING`
    + `&pageSize=40`
    + `&fields=NCTId,BriefTitle,Phase,OverallStatus,PrimaryCompletionDate,LeadSponsorName,Condition`;
  const data = await fetchJson(url);
  if (!data || !Array.isArray(data.studies)) return [];
  const out = [];
  for (const s of data.studies) {
    const p = s.protocolSection || {};
    const nctId = p.identificationModule?.nctId;
    const brief = p.identificationModule?.briefTitle || "";
    const phases = p.designModule?.phases || [];
    const leadSponsor = p.sponsorCollaboratorsModule?.leadSponsor?.name || "";
    const rawPcd = p.statusModule?.primaryCompletionDateStruct?.date || "";
    const conditions = p.conditionsModule?.conditions || [];

    const cls = classify(phases);
    if (!cls) continue;
    if (!sponsorMatches(sponsor, leadSponsor)) continue;
    const nd = normDate(rawPcd);
    if (!nd) continue;
    const days = daysBetween(todayISO, nd.date);
    if (days < 0 || days > FORWARD_WINDOW_DAYS) continue;

    const cond = conditions[0] ? conditions[0].replace(/\s*\(.*\)\s*/g, "").trim() : "trial";
    const phaseLabel = cls.type === "PH3" ? "Ph3" : "Ph2";
    const trialStatus = p.statusModule?.overallStatus || "";
    const dateType = p.statusModule?.primaryCompletionDateStruct?.type === "ACTUAL" ? "ACTUAL" : "ESTIMATED";
    out.push({
      date: nd.date,
      datePrecision: nd.precision,
      ticker,
      type: cls.type,
      importance: cls.importance,
      title: `${ticker} ${cond} ${phaseLabel} primary completion`,
      detail: brief.slice(0, 160),
      source: "clinicaltrials.gov",
      nctId,
      dateType,
      trialStatus,
      // Still enrolling within ~6 weeks of its estimated completion = the
      // sponsor hasn't refreshed the record; the date is near-certain to move.
      slipRisk: dateType === "ESTIMATED" && trialStatus === "RECRUITING" && days <= 45,
    });
  }
  return out;
}

// Collapse duplicate readouts for the same ticker+date (multiple trials, same
// completion window) into the single most-advanced-phase entry.
function dedupe(items) {
  const byKey = new Map();
  for (const it of items) {
    const key = `${it.ticker}|${it.date}`;
    const prev = byKey.get(key);
    if (!prev || (it.type === "PH3" && prev.type !== "PH3")) byKey.set(key, it);
  }
  return [...byKey.values()];
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const entries = Object.entries(SPONSORS);
  const results = [];
  // Sequential with a tiny gap to stay polite to the public API.
  for (const [ticker, sponsor] of entries) {
    const got = await fetchTicker(ticker, sponsor, today);
    results.push(...got);
    await new Promise(r => setTimeout(r, 150));
  }
  const items = dedupe(results).sort((a, b) => Date.parse(a.date) - Date.parse(b.date));

  // A CT.gov outage or filter regression must not clobber a good baseline
  // with an empty calendar — keep the previous file and say so.
  if (items.length === 0 && fs.existsSync(OUT)) {
    console.warn("psil-catalysts: 0 items fetched — keeping the previous baseline.");
    return;
  }

  const payload = {
    generated: new Date().toISOString(),
    source: "clinicaltrials.gov v2 (primary completion date as readout proxy)",
    window_days: FORWARD_WINDOW_DAYS,
    count: items.length,
    items,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n");
  console.log(`psil-catalysts: wrote ${items.length} upcoming readouts from ${entries.length} sponsors (baseline ${today}).`);
  for (const it of items.slice(0, 12)) console.log(`  ${it.date} ${it.ticker} ${it.type} — ${it.title}`);
}

main().catch(e => { console.error("psil-catalysts fetch failed:", e); process.exit(1); });
