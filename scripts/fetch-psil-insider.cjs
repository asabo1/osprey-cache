#!/usr/bin/env node
// Insider transactions per PSIL holding from SEC Form 4 XML, transaction
// codes parsed. HARD SCOPE (the honesty trap this factor invites): only
// code P (open-market purchase) counts as buying and only code S
// (open-market sale) as selling. Awards (A), option exercises (M), gifts
// (G), tax withholding (F), conversions (C) are ignored — counting those
// as "insider buying" calls compensation a conviction signal.
//
// Incremental: parsed filings are cached by accession number in the output
// file, so the hourly run fetches only new Form 4s (SEC fair-access).
// Fail-closed: zero-fetch keeps last-good; per-filing parse failures skip.

const fs = require("node:fs");
const path = require("node:path");

const OUT = path.join(__dirname, "..", "src", "data", "psil-insider.json");
const UA = "Mozilla/5.0 (compatible; osprey-cache/2.0)";
const TIMEOUT_MS = 10000;
const WINDOW_DAYS = 90;
const MAX_NEW_PER_TICKER = 8;

// Keep in sync with fetch-psil-shares-outstanding.cjs.
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

async function fetchAny(url, asJson) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": UA } });
    if (!res.ok) return null;
    return asJson ? await res.json() : await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(to);
  }
}
const pause = () => new Promise(r => setTimeout(r, 180));

// Minimal Form 4 XML extraction — the ownershipDocument schema is standard.
function parseForm4(xml) {
  const owner = (xml.match(/<rptOwnerName>([^<]+)<\/rptOwnerName>/) || [])[1] || "unknown";
  const txns = [];
  const blocks = xml.match(/<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/g) || [];
  for (const b of blocks) {
    const code = (b.match(/<transactionCode>([A-Z])<\/transactionCode>/) || [])[1];
    if (code !== "P" && code !== "S") continue;
    const shares = parseFloat((b.match(/<transactionShares>\s*<value>([\d.]+)<\/value>/) || [])[1] || "0");
    const price = parseFloat((b.match(/<transactionPricePerShare>\s*<value>([\d.]+)<\/value>/) || [])[1] || "0");
    const date = (b.match(/<transactionDate>\s*<value>([\d-]+)<\/value>/) || [])[1] || null;
    txns.push({ code, shares, price, date });
  }
  return { owner: owner.trim(), txns };
}

async function main() {
  const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : { parsed: {} };
  const parsed = prev.parsed || {}; // accession -> {ticker, owner, txns[], filingDate}
  const cutoff = Date.now() - WINDOW_DAYS * 86400000;
  let fetchedAny = false;

  for (const [ticker, cik] of Object.entries(CIKS)) {
    const sub = await fetchAny(`https://data.sec.gov/submissions/CIK${cik}.json`, true);
    await pause();
    const r = sub?.filings?.recent;
    if (!r?.form) continue;
    fetchedAny = true;
    let newCount = 0;
    for (let i = 0; i < r.form.length && newCount < MAX_NEW_PER_TICKER; i++) {
      if (r.form[i] !== "4") continue;
      if (Date.parse(r.filingDate[i]) < cutoff) continue;
      const acc = r.accessionNumber[i];
      if (parsed[acc]) continue;
      const dir = `https://www.sec.gov/Archives/edgar/data/${parseInt(cik, 10)}/${acc.replace(/-/g, "")}`;
      const idx = await fetchAny(`${dir}/index.json`, true);
      await pause();
      const xmlName = (idx?.directory?.item || []).map(it => it.name).find(n => n.endsWith(".xml") && !n.includes("index"));
      if (!xmlName) { parsed[acc] = { ticker, owner: "unparsed", txns: [], filingDate: r.filingDate[i] }; continue; }
      const xml = await fetchAny(`${dir}/${xmlName}`, false);
      await pause();
      if (!xml) continue; // transient — retry next run
      const p = parseForm4(xml);
      parsed[acc] = { ticker, owner: p.owner, txns: p.txns, filingDate: r.filingDate[i] };
      newCount++;
    }
  }

  if (!fetchedAny) {
    console.error("psil-insider: fetched nothing — keeping last-good file.");
    process.exit(fs.existsSync(OUT) ? 0 : 1);
  }

  // Prune cache beyond window, then aggregate.
  for (const [acc, v] of Object.entries(parsed)) {
    if (Date.parse(v.filingDate) < cutoff) delete parsed[acc];
  }
  const tickers = {};
  for (const t of Object.keys(CIKS)) tickers[t] = { buyFilings: 0, sellFilings: 0, clusterBuyers: 0, buyShares: 0, sellShares: 0, latest: [] };
  const buyersByTicker = {};
  for (const v of Object.values(parsed)) {
    const agg = tickers[v.ticker];
    if (!agg) continue;
    const buys = v.txns.filter(x => x.code === "P");
    const sells = v.txns.filter(x => x.code === "S");
    if (buys.length) {
      agg.buyFilings++;
      agg.buyShares += buys.reduce((s, x) => s + x.shares, 0);
      (buyersByTicker[v.ticker] ||= new Set()).add(v.owner);
    }
    if (sells.length) {
      agg.sellFilings++;
      agg.sellShares += sells.reduce((s, x) => s + x.shares, 0);
    }
    for (const x of [...buys, ...sells]) agg.latest.push({ date: x.date || v.filingDate, owner: v.owner, code: x.code, shares: x.shares, price: x.price });
  }
  for (const [t, set] of Object.entries(buyersByTicker)) tickers[t].clusterBuyers = set.size;
  for (const t of Object.keys(tickers)) tickers[t].latest = tickers[t].latest.sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 6);

  const totalClusterBuyers = Object.values(tickers).reduce((s, v) => s + v.clusterBuyers, 0);
  const payload = {
    updated: new Date().toISOString(),
    window_days: WINDOW_DAYS,
    source: "SEC Form 4 XML, transaction codes parsed; only open-market P counts as buying, only S as selling (awards/exercises/gifts/withholding ignored)",
    totalClusterBuyers,
    tickers,
    parsed,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 1) + "\n");
  for (const [t, v] of Object.entries(tickers)) {
    if (v.buyFilings || v.sellFilings) console.log(`  ${t}: ${v.buyFilings} buy filings (${v.clusterBuyers} distinct buyers, ${Math.round(v.buyShares).toLocaleString()} sh) · ${v.sellFilings} sell filings (${Math.round(v.sellShares).toLocaleString()} sh)`);
  }
  console.log(`psil-insider: ${Object.keys(parsed).length} Form 4s in window; ${totalClusterBuyers} distinct open-market buyers across holdings.`);
}

main().catch(e => {
  console.error("psil-insider FAILED (keeping last-good):", e.message);
  process.exit(fs.existsSync(OUT) ? 0 : 1);
});
