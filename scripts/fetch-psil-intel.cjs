#!/usr/bin/env node
// Aggregates psychedelic-relevant feeds into public/data/psil-intel.json.
// Runs every 15min via GitHub Actions. Node 22+ (uses built-in fetch).
//
// Source tiers:
//   T1 (real-time material events): SEC EDGAR 8-K atom feeds per ticker
//   T2 (broad coverage):           Google News RSS — sector + per-ticker
//   T3 (analysis/commentary):      Publisher RSS (Endpoints, STAT, etc.)
//   T4 (regulatory):               FDA Drug Approvals RSS
//
// Trusted feeds (T1, T2, T4) skip the keyword filter because the source/query
// already guarantees relevance.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// SEC requires identifying User-Agent (company + email) per fair-access policy.
const SEC_UA = "CrudeSignal-PSIL Intel Bot asabo413@gmail.com";
const DEFAULT_UA =
  "Mozilla/5.0 (compatible; CrudeSignal-PSIL/2.0; +https://crudesignal.io)";

// Per-ticker SEC CIKs verified against https://www.sec.gov/files/company_tickers.json
// Form: 8-K for US filers, 6-K for foreign private issuers (Canadian).
const SEC_FILERS = {
  CMPS: { cik: "0001816590", form: "8-K" }, // Compass Pathways plc
  ATAI: { cik: "0002081043", form: "8-K" }, // AtaiBeckley Inc.
  GHRS: { cik: "0001855129", form: "8-K" }, // GH Research PLC
  MNMD: { cik: "0001813814", form: "8-K" }, // Mind Medicine Inc.
  HELP: { cik: "0001833141", form: "6-K" }, // Helus Pharma (fka Cybin), foreign private issuer, Nasdaq uplift Jan 5 2026
  ALKS: { cik: "0001520262", form: "8-K" }, // Alkermes plc
  NBIX: { cik: "0000914475", form: "8-K" }, // Neurocrine Biosciences
  NRXP: { cik: "0001719406", form: "8-K" }, // NRx Pharmaceuticals
  VTGN: { cik: "0001578523", form: "8-K" }, // VistaGen Therapeutics
};

// Tickers for Form 4 (insider transactions) — highest signal pre-readout.
// Same CIKs as SEC_FILERS where available; DRUG is Definium (not yet in EDGAR as public co).
const SEC_FORM4_FILERS = {
  CMPS: "0001816590",
  ATAI: "0002081043",
  MNMD: "0001813814",
  HELP: "0001833141",
  ALKS: "0001520262",
  NBIX: "0000914475",
  VTGN: "0001578523",
};

// Google News query helper. `when:7d` limits to last 7 days.
const gn = (q) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q)}+when:7d&hl=en-US&gl=US&ceid=US:en`;

const FEEDS = [
  // ===== T1: SEC EDGAR material-event filings (8-K / 6-K) =====
  ...Object.entries(SEC_FILERS).map(([ticker, { cik, form }]) => ({
    name: `SEC ${ticker}`,
    display: "SEC",
    url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=${form}&dateb=&owner=include&count=20&output=atom`,
    kind: "atom",
    trusted: true,
    forceTicker: ticker,
    forceSeverity: "CRIT",
    forceForm: form,
    ua: SEC_UA,
  })),

  // ===== T1: SEC EDGAR Form 4 insider transactions (pre-readout signal) =====
  ...Object.entries(SEC_FORM4_FILERS).map(([ticker, cik]) => ({
    name: `SEC Form4 ${ticker}`,
    display: "SEC",
    url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=4&dateb=&owner=include&count=10&output=atom`,
    kind: "atom",
    trusted: true,
    forceTicker: ticker,
    forceSeverity: "WARN",
    forceForm: "Form 4",
    ua: SEC_UA,
  })),

  // ===== T2: Google News — sector-wide =====
  {
    name: "Google News",
    display: "GNEWS",
    url: gn(
      '"psychedelic" OR "psilocybin" OR "MDMA therapy" OR "COMP360" OR "COMP005" OR "ibogaine" OR "5-MeO-DMT"'
    ),
    kind: "gnews",
    trusted: true,
  },
  {
    name: "Google News",
    display: "GNEWS",
    url: gn(
      '"FDA" ("psychedelic" OR "psilocybin" OR "MDMA" OR "ketamine") OR "DEA rescheduling" OR "RFK" psychedelic'
    ),
    kind: "gnews",
    trusted: true,
  },

  // ===== T2: Google News — per-ticker (top holdings) =====
  {
    name: "Google News",
    display: "GNEWS",
    url: gn('"Compass Pathways" OR "$CMPS" OR "COMP360"'),
    kind: "gnews",
    trusted: true,
    forceTicker: "CMPS",
  },
  {
    name: "Google News",
    display: "GNEWS",
    url: gn('"atai Life Sciences" OR "$ATAI"'),
    kind: "gnews",
    trusted: true,
    forceTicker: "ATAI",
  },
  {
    name: "Google News",
    display: "GNEWS",
    url: gn('"GH Research" OR "$GHRS" OR "GH001"'),
    kind: "gnews",
    trusted: true,
    forceTicker: "GHRS",
  },
  {
    name: "Google News",
    display: "GNEWS",
    url: gn('"MindMed" OR "Mind Medicine" OR "$MNMD" OR "MM120"'),
    kind: "gnews",
    trusted: true,
    forceTicker: "MNMD",
  },
  {
    name: "Google News",
    display: "GNEWS",
    url: gn('"Helus Pharma" OR "$HELP" OR "HLP-003" OR "HLP-004" OR "Cybin"'),
    kind: "gnews",
    trusted: true,
    forceTicker: "HELP",
  },
  {
    name: "Google News",
    display: "GNEWS",
    url: gn('"Alkermes" OR "$ALKS" OR "ALKS 2680"'),
    kind: "gnews",
    trusted: true,
    forceTicker: "ALKS",
  },
  {
    name: "Google News",
    display: "GNEWS",
    url: gn('"Neurocrine" OR "$NBIX" OR "Crenessity" OR "Ingrezza"'),
    kind: "gnews",
    trusted: true,
    forceTicker: "NBIX",
  },
  // Additional per-ticker feeds: DRUG (Definium), VTGN, NRXP
  {
    name: "Google News",
    display: "GNEWS",
    url: gn('"Definium" OR "$DRUG" OR "DT-120" OR "DT120"'),
    kind: "gnews",
    trusted: true,
    forceTicker: "DRUG",
  },
  {
    name: "Google News",
    display: "GNEWS",
    url: gn('"VistaGen" OR "$VTGN" OR "PH94B" OR "fasedienol"'),
    kind: "gnews",
    trusted: true,
    forceTicker: "VTGN",
  },
  {
    name: "Google News",
    display: "GNEWS",
    url: gn('"NRx Pharmaceuticals" OR "$NRXP" OR "NRX-101" OR "zyesami"'),
    kind: "gnews",
    trusted: true,
    forceTicker: "NRXP",
  },

  // ===== T2: Psychedelic Alpha — sector-native, highest signal publisher =====
  {
    name: "Psychedelic Alpha",
    display: "PSYΑ",
    url: "https://psychedelicalpha.com/feed/",
    kind: "rss",
    trusted: true, // psychedelic-only; skip keyword filter
  },

  // ===== T3: Publisher RSS (keyword filtered) =====
  { name: "Endpoints", display: "ENDPT", url: "https://endpoints.news/feed/", kind: "rss" },
  { name: "STAT News", display: "STAT", url: "https://www.statnews.com/feed/", kind: "rss" },
  { name: "Fierce Biotech", display: "FIERCE", url: "https://www.fiercebiotech.com/rss/xml", kind: "rss" },
  { name: "Lucid News", display: "LUCID", url: "https://www.lucid.news/feed/", kind: "rss", trusted: true }, // psychedelic-only publication
  { name: "Microdose", display: "MICRO", url: "https://microdose.buzz/feed/", kind: "rss", trusted: true }, // psychedelic-only publication
  { name: "BioPharma Dive", display: "BPDIVE", url: "https://www.biopharmadive.com/feeds/news/", kind: "rss" },
  // GlobeNewswire biotech RSS — keyword-filtered for psil tickers/terms
  { name: "GlobeNewswire", display: "GNW", url: "https://www.globenewswire.com/RssFeed/industry/9144/Biotechnology", kind: "rss" },

  // ===== T4: FDA Drug Approvals (regulatory ground truth) =====
  {
    name: "FDA",
    display: "FDA",
    url: "https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/press-releases/rss.xml",
    kind: "rss",
    trusted: false, // keyword filter — most FDA news isn't psychedelic
  },
];

// Keyword filter — case-insensitive match in title or description
const KEYWORDS = [
  "psychedelic", "psilocybin", "psilocin", "mdma", "ibogaine", "lsd", "dmt",
  "mebufotenin", "5-meo-dmt", "ketamine", "esketamine", "spravato",
  "compass pathways", "comp360", "comp005", "comp006", "atai life",
  "gh research", "gh001", "gh002",
  "cybin", "cyb003", "cyb004",
  "mindmed", "mind medicine", "mm120",
  "relmada", "alto neuroscience", "bright minds",
  "neurocrine", "ingrezza", "crenessity",
  "alkermes", "alks 2680",
  "supernus", "neuronetics", "neuphoria",
  "treatment-resistant depression", "trd", "ptsd",
  "fda national priority voucher", "rems", "schedule i", "rescheduling",
  "accelerating medical treatments",
];

const TICKERS = [
  "CMPS", "ATAI", "GHRS", "HELP", "MNMD", "RLMD", "DRUG", "ANRO", "NRXP",
  "ALKS", "NBIX", "STIM", "SUPN", "NEUP", "VTGN", "JNJ", "ABBV", "PSIL",
];

const CRIT_KEYWORDS = [
  "fda approval", "fda decision", "approved", "rejection",
  "complete response letter", "crl",
  "phase 3", "phase iii", "ph3", "primary endpoint", "topline", "readout",
  "executive order", "rescheduled", "rescheduling", "doj", "clinical hold",
  "8-k", "form 8-k", "acquired", "acquires", "merger", "tender offer",
];

const WARN_KEYWORDS = [
  "phase 2", "phase ii", "ph2", "investor day", "earnings",
  "13d", "13g", "stake", "short interest", "downgrade", "upgrade",
  "trump", "rfk jr", "kennedy", "dr oz",
  "private placement", "offering", "dilution",
];

const BULL_KEYWORDS = [
  "approval", "approved", "breakthrough", "expedite", "accelerate", "fast track",
  "met endpoint", "successful", "positive", "beats", "upgrade", "buy rating",
  "raised price target", "raised pt", "raises pt", "highest", "record",
  "executive order", "support", "supports", "passed", "advance", "advances",
  "reform", "legaliz", "decriminaliz", "milestone", "data positive", "expanded",
  "rally", "surge", "rocket", "spike", "soar", "jump", "gain",
  "partnership", "collaboration", "deal", "investment", "funding", "ipo",
  "designation", "voucher", "priority review",
];

const BEAR_KEYWORDS = [
  "rejection", "rejected", "complete response letter", "crl", "failed", "fails",
  "missed endpoint", "primary endpoint not met", "halt", "halted", "discontinue",
  "discontinued", "clinical hold", "warning letter", "lawsuit", "investigation",
  "downgrade", "sell rating", "lowered price target", "slashed", "cut pt",
  "death", "fatal", "valvulopathy", "cardiac", "safety signal", "side effect",
  "ban", "banned", "criminaliz", "delay", "delayed", "miss", "misses",
  "decline", "drop", "fall", "plunge", "tumble", "loss", "downturn",
  "subpoena", "fraud", "restated", "going concern", "bankruptcy", "delist",
  "dilution", "offering", "private placement",
];

const HIGH_IMPACT_KEYWORDS = [
  "executive order", "fda approval", "fda rejection", "phase 3", "primary endpoint",
  "topline", "rescheduling", "pdufa", "buyout", "acquired", "acquires", "merger",
];

function classify(title, desc, override) {
  if (override) return override;
  const text = (title + " " + (desc || "")).toLowerCase();
  if (CRIT_KEYWORDS.some((k) => text.includes(k))) return "CRIT";
  if (WARN_KEYWORDS.some((k) => text.includes(k))) return "WARN";
  return "INFO";
}

function direction(title, desc) {
  const text = (title + " " + (desc || "")).toLowerCase();
  let bull = 0, bear = 0;
  for (const k of BULL_KEYWORDS) if (text.includes(k)) bull++;
  for (const k of BEAR_KEYWORDS) if (text.includes(k)) bear++;
  if (bull > bear && bull > 0) return "BULL";
  if (bear > bull && bear > 0) return "BEAR";
  return "NEUTRAL";
}

function impact(title, desc, severity) {
  const text = (title + " " + (desc || "")).toLowerCase();
  if (HIGH_IMPACT_KEYWORDS.some((k) => text.includes(k))) return "HIGH";
  if (severity === "CRIT") return "HIGH";
  if (severity === "WARN") return "MED";
  return "LOW";
}

function detectTickers(title, desc, forced) {
  const text = (title + " " + (desc || "")).toUpperCase();
  const found = TICKERS.filter(
    (t) => text.includes(`$${t}`) || new RegExp(`\\b${t}\\b`).test(text)
  );
  if (forced && !found.includes(forced)) found.push(forced);
  return found;
}

function categorize(title, desc) {
  const text = (title + " " + (desc || "")).toLowerCase();
  if (/\b(8-k|form 8-k|10-q|10-k|s-1|13d|13g|sec filing)\b/.test(text)) return "regulatory";
  if (/\b(fda|dea|rems|schedule|rescheduling|congress|senate|hhs|cms|executive order|policy)\b/.test(text)) return "regulatory";
  if (/\b(phase 1|phase 2|phase 3|phase i|phase ii|phase iii|ph1|ph2|ph3|trial|topline|readout|endpoint)\b/.test(text)) return "trial";
  if (/\b(earnings|q[1-4] 20\d\d|guidance|revenue|cash|burn)\b/.test(text)) return "earnings";
  return "sector";
}

function matchesKeyword(title, desc) {
  const text = (title + " " + (desc || "")).toLowerCase();
  return KEYWORDS.some((k) => text.includes(k));
}

function hashId(input) {
  return crypto.createHash("sha1").update(input).digest("hex").slice(0, 12);
}

function decode(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .trim();
}

// RSS 2.0 parser — <item>...<title/link/pubDate/description></item>
function parseRss(xml) {
  const items = [];
  const itemRe = /<item[^>]*>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml))) {
    const block = m[1];
    const get = (tag) => {
      const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
      const r = re.exec(block);
      return r ? decode(r[1]) : "";
    };
    // <source url="...">Publisher</source> — Google News attribution
    const sourceMatch = /<source[^>]*>([\s\S]*?)<\/source>/i.exec(block);
    items.push({
      title: get("title"),
      link: get("link"),
      description: get("description"),
      pubDate: get("pubDate") || get("dc:date") || "",
      publisher: sourceMatch ? decode(sourceMatch[1]) : "",
    });
  }
  return items;
}

// Atom parser — <entry>...<title/link href/updated/summary></entry>
// SEC EDGAR atom embeds filing metadata in <content>: <filing-date>, <accession-number>, <form-name>.
function parseAtom(xml) {
  const items = [];
  const entryRe = /<entry[^>]*>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRe.exec(xml))) {
    const block = m[1];
    const get = (tag) => {
      const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
      const r = re.exec(block);
      return r ? decode(r[1]) : "";
    };
    const linkMatch = /<link[^>]*href=["']([^"']+)["']/i.exec(block);
    items.push({
      title: get("title"),
      link: linkMatch ? linkMatch[1] : "",
      description: get("summary") || get("content") || get("form-name") || "",
      pubDate: get("filing-date") || get("updated") || get("published") || "",
      publisher: "",
      // SEC-specific metadata
      filingDate: get("filing-date"),
      accession: get("accession-number"),
      formName: get("form-name"),
    });
  }
  return items;
}

// Strip "Headline - Publisher" suffix that Google News appends
function cleanGoogleNewsTitle(title, publisher) {
  if (!publisher) return title;
  const suffix = ` - ${publisher}`;
  if (title.endsWith(suffix)) return title.slice(0, -suffix.length).trim();
  return title;
}

// Build a unique, readable SEC headline from filing metadata
function buildSecTitle(ticker, form, filingDate, formName) {
  const date = filingDate || "";
  const detail = formName && formName !== form ? ` · ${formName}` : "";
  return `${ticker} ${form} filed ${date}${detail}`.trim();
}

async function fetchFeed(feed) {
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 4_000);
    const res = await fetch(feed.url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": feed.ua || DEFAULT_UA,
        Accept: "application/atom+xml, application/rss+xml, application/xml, text/xml, */*",
      },
    });
    clearTimeout(timeout);
    if (!res.ok) {
      console.warn(`  [${feed.name}] HTTP ${res.status}`);
      return [];
    }
    const xml = await res.text();
    const raw = feed.kind === "atom" ? parseAtom(xml) : parseRss(xml);

    const out = [];
    for (const it of raw) {
      let title = it.title;
      let publisher = it.publisher;

      // Google News: extract real publisher, clean suffix
      if (feed.kind === "gnews") {
        title = cleanGoogleNewsTitle(title, publisher);
      }

      // SEC: synthesize a unique, readable title from filing metadata
      if (feed.kind === "atom" && feed.forceTicker) {
        title = buildSecTitle(
          feed.forceTicker,
          feed.forceForm || "Filing",
          it.filingDate,
          it.formName
        );
      }

      // Apply keyword filter for non-trusted feeds
      if (!feed.trusted && !matchesKeyword(title, it.description)) continue;

      let time;
      try {
        time = it.pubDate ? new Date(it.pubDate).toISOString() : new Date().toISOString();
        if (time === "Invalid Date" || isNaN(new Date(time).getTime())) {
          time = new Date().toISOString();
        }
      } catch {
        time = new Date().toISOString();
      }

      const sev = classify(title, it.description, feed.forceSeverity);
      const dir = feed.kind === "atom" && feed.forceTicker
        ? direction(title, it.description) // SEC 8-Ks: direction TBD from headline
        : direction(title, it.description);

      const sourceLabel = publisher && feed.kind === "gnews" ? publisher : feed.name;

      out.push({
        id: hashId(feed.name + (it.link || title)),
        time,
        source: sourceLabel,
        sourceKind: feed.kind, // "rss" | "gnews" | "atom"
        sourceTier: feed.kind === "atom" ? 1 : feed.trusted ? 2 : 3,
        category: categorize(title, it.description),
        severity: sev,
        direction: dir,
        impact: impact(title, it.description, sev),
        title: title.slice(0, 220),
        link: it.link,
        tickers: detectTickers(title, it.description, feed.forceTicker),
      });
    }
    return out;
  } catch (err) {
    console.warn(`  [${feed.name}] fetch failed: ${err.message}`);
    return [];
  }
}

(async () => {
  console.log(`Fetching ${FEEDS.length} feeds...\n`);
  const all = [];

  // Fetch in parallel batches of 4 (avoid hammering single host)
  const batchSize = 4;
  for (let i = 0; i < FEEDS.length; i += batchSize) {
    const batch = FEEDS.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(fetchFeed));
    batch.forEach((feed, idx) => {
      const items = results[idx];
      console.log(
        `  [${feed.name}${feed.forceTicker ? ` · ${feed.forceTicker}` : ""}] ${items.length} items`
      );
      all.push(...items);
    });
  }

  // De-dupe by id (URL hash) for everything; also by title for non-SEC items
  // (SEC filings deserve to coexist even if titles look similar — each accession is a distinct event).
  const seenIds = new Set();
  const seenTitles = new Set();
  const deduped = all.filter((i) => {
    if (seenIds.has(i.id)) return false;
    seenIds.add(i.id);
    if (i.sourceKind === "atom") return true;
    const titleKey = i.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 60);
    if (seenTitles.has(titleKey)) return false;
    seenTitles.add(titleKey);
    return true;
  });

  // Drop items > 180 days old (RSS feeds occasionally return ancient items).
  const cutoff = Date.now() - 180 * 86400 * 1000;
  const fresh = deduped.filter((i) => new Date(i.time).getTime() > cutoff);

  // Tier-based budget so SEC material events are never crowded out by news volume.
  const byTier = { 1: [], 2: [], 3: [] };
  for (const it of fresh) (byTier[it.sourceTier] || byTier[3]).push(it);
  for (const t of [1, 2, 3]) byTier[t].sort((a, b) => (a.time < b.time ? 1 : -1));

  const TIER_BUDGET = { 1: 40, 2: 90, 3: 20 }; // 150 total
  const items = [
    ...byTier[1].slice(0, TIER_BUDGET[1]),
    ...byTier[2].slice(0, TIER_BUDGET[2]),
    ...byTier[3].slice(0, TIER_BUDGET[3]),
  ].sort((a, b) => (a.time < b.time ? 1 : -1));

  const counts = {
    total: items.length,
    crit: items.filter((i) => i.severity === "CRIT").length,
    warn: items.filter((i) => i.severity === "WARN").length,
    bySource: items.reduce((acc, i) => {
      acc[i.source] = (acc[i.source] || 0) + 1;
      return acc;
    }, {}),
    byTier: items.reduce((acc, i) => {
      const t = `T${i.sourceTier}`;
      acc[t] = (acc[t] || 0) + 1;
      return acc;
    }, {}),
  };

  const out = {
    updated: new Date().toISOString(),
    counts,
    items,
  };

  const outPath = path.join(__dirname, "..", "public", "data", "psil-intel.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${items.length} items (${counts.crit} CRIT · ${counts.warn} WARN)`);
  console.log(`Tier breakdown: ${JSON.stringify(counts.byTier)}`);
})();
