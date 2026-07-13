// PSIL forward catalyst calendar — next ~90 days from 2026-07-13.
// Editable manual JSON; will be augmented by clinicaltrials.gov + BioPharmCatalyst scrape later.

export type CatalystType = "PH3" | "PH2" | "EARN" | "REG" | "CONF" | "FDA" | "MACRO";
export type Importance = "CRITICAL" | "HIGH" | "MEDIUM";

export type Catalyst = {
  date: string; // YYYY-MM-DD
  days: number; // days from today (2026-04-20)
  ticker: string | null; // null = sector/macro
  type: CatalystType;
  importance: Importance;
  title: string;
  detail: string;
};

export const CATALYSTS: Catalyst[] = [
  { date: "2026-04-21", days: -83, ticker: "JNJ", type: "EARN", importance: "MEDIUM", title: "JNJ Q1 2026 earnings", detail: "Spravato (esketamine) sales — read-through to ketamine clinic economics" },
  { date: "2026-04-22", days: -82, ticker: null, type: "MACRO", importance: "MEDIUM", title: "EIA crude inventories", detail: "Sector-neutral but biotech beta to risk-on tape" },
  { date: "2026-04-28", days: -76, ticker: "ABBV", type: "EARN", importance: "MEDIUM", title: "AbbVie Q1 2026 earnings", detail: "Vraylar / Cariprazine MDD positioning commentary" },
  { date: "2026-04-29", days: -75, ticker: null, type: "MACRO", importance: "HIGH", title: "FOMC rate decision", detail: "Sector beta — biotech is rate-sensitive duration" },
  { date: "2026-05-04", days: -70, ticker: "STIM", type: "EARN", importance: "MEDIUM", title: "Neuronetics Q1 earnings", detail: "TMS adoption + ketamine clinic Greenbrook integration" },
  { date: "2026-05-05", days: -69, ticker: "ALKS", type: "EARN", importance: "HIGH", title: "Alkermes Q1 + ALKS-2680 update", detail: "Orexin agonist — narcolepsy/IH read-through, may not be psychedelic but watched" },
  { date: "2026-05-06", days: -68, ticker: "SUPN", type: "EARN", importance: "MEDIUM", title: "Supernus Q1 earnings", detail: "ADHD franchise + SPN-820 update" },
  { date: "2026-05-07", days: -67, ticker: "NBIX", type: "EARN", importance: "MEDIUM", title: "Neurocrine Q1 earnings", detail: "Schizophrenia + MDD pipeline commentary" },
  { date: "2026-05-09", days: -65, ticker: "CMPS", type: "EARN", importance: "HIGH", title: "Compass Pathways Q1 earnings", detail: "Cash position update + COMP006 Part B prep + NDA timeline" },
  { date: "2026-05-13", days: -61, ticker: null, type: "MACRO", importance: "HIGH", title: "CPI April release", detail: "Risk-on tape gate. Biotech beta if 2.x print" },
  { date: "2026-05-15", days: -59, ticker: null, type: "CONF", importance: "CRITICAL", title: "APA Annual Meeting begins (Washington DC)", detail: "Major psychiatry conference. Compass + GHRS expected to present. Sector volume catalyst." },
  { date: "2026-05-19", days: -55, ticker: "GHRS", type: "REG", importance: "HIGH", title: "GH Research investor day", detail: "GH001 inhaled mebufotenin Ph3 design + global rollout cadence" },
  { date: "2026-05-21", days: -53, ticker: "ATAI", type: "REG", importance: "HIGH", title: "ATAI BPL-003 EOP2 outcome disclosure", detail: "FDA end-of-Phase-2 meeting result; Ph3 design + initiation timing" },
  { date: "2026-05-26", days: -48, ticker: "DRUG", type: "PH2", importance: "HIGH", title: "Bright Minds Prader-Willi Ph2 init", detail: "BMB-101 PWS expansion. Reads through to platform breadth" },
  { date: "2026-05-28", days: -46, ticker: "NEUP", type: "PH2", importance: "MEDIUM", title: "Neuphoria BNC210 anxiety topline", detail: "Acute SAD (social anxiety) Phase 2b" },
  { date: "2026-06-02", days: -41, ticker: null, type: "REG", importance: "HIGH", title: "FDA Adcomm: psychedelic REMS framework (rumored)", detail: "Per industry chatter. Would set the template for COMP360 commercial design." },
  { date: "2026-06-09", days: -34, ticker: null, type: "REG", importance: "MEDIUM", title: "DEA quarterly scheduling review (closed)", detail: "Watch for psilocybin / mebufotenin formal scheduling petitions filed in response to EO" },
  { date: "2026-06-15", days: -28, ticker: "DRUG", type: "PH2", importance: "MEDIUM", title: "Bright Minds DEE expansion data", detail: "Dravet / DEE epilepsy Ph2 expansion read" },
  { date: "2026-06-16", days: -27, ticker: null, type: "CONF", importance: "CRITICAL", title: "MAPS Psychedelic Science 2026 (Denver)", detail: "Largest psychedelic conference globally. Sector sentiment driver. Major company presentations + panel announcements." },
  { date: "2026-06-22", days: -21, ticker: "VTGN", type: "PH3", importance: "CRITICAL", title: "Vistagen PALISADE-3 (fasedienol) topline", detail: "Pivotal Phase 3 in social anxiety. Binary readout — could re-rate VTGN 100%+ either direction" },
  { date: "2026-06-25", days: -18, ticker: "KTTA", type: "PH2", importance: "MEDIUM", title: "Pasithea PAS-004 update", detail: "NF1 / autism program — small but tracked" },
  { date: "2026-07-01", days: -12, ticker: "CMPS", type: "PH3", importance: "CRITICAL", title: "COMP006 Part B 26-wk durability readout", detail: "THE marquee binary catalyst. Determines whether COMP360 has a single-dose effect or requires re-treatment. Stock could move ±50%." },
  { date: "2026-07-08", days: -5, ticker: null, type: "REG", importance: "HIGH", title: "FINRA short interest settle (Jun 30)", detail: "First post-EO SI snapshot. Watch CMPS / GHRS / ATAI — squeeze unwind or doubling down?" },
  { date: "2026-07-15", days: 2, ticker: "ANRO", type: "PH2", importance: "HIGH", title: "Alto Neuroscience ALTO-100 MDD readout", detail: "Biomarker-enriched MDD Phase 2b. Precision-psychiatry thesis test" },
];
