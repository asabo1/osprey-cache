// PSIL holdings reference data. Replaced by GH Action fetch in production.
// Last manual update: 2026-07-15 (sparklines auto-refreshed daily)

export type Holding = {
  ticker: string;
  company: string;
  weight: number; // % of fund
  price: number; // USD
  dayPct: number; // 1D % change
  spark: number[]; // 8 normalized 0-1 datapoints, 8-week shape
  shortInterestPct: number | null; // null = unknown / N/A
  nextCatalyst: { label: string; days: number } | null;
  category: "Pure-Play" | "Adjacent" | "Big Pharma" | "Cash";
};

export const HOLDINGS: Holding[] = [
  { ticker: "ATAI", company: "AtaiBeckley", weight: 10.58, price: 2.85, dayPct: 28.4, spark: [0.02, 0.00, 0.08, 0.78, 0.73, 0.71, 1.00, 1.00], shortInterestPct: 12.1, nextCatalyst: { label: "VLS-01 (DMT) Ph2 topline", days: 120 }, category: "Pure-Play" },
  { ticker: "RLMD", company: "Relmada Therapeutics", weight: 9.44, price: 3.12, dayPct: 9.8, spark: [0.00, 0.90, 1.00, 0.95, 0.42, 0.59, 0.33, 0.33], shortInterestPct: 8.7, nextCatalyst: { label: "RESCUE Ph3 init", days: 70 }, category: "Adjacent" },
  { ticker: "DFTX", company: "Definium Therapeutics", weight: 9.35, price: 1.84, dayPct: 18.2, spark: [0.00, 0.05, 0.04, 0.91, 0.88, 1.00, 0.95, 0.95], shortInterestPct: null, nextCatalyst: { label: "Pipeline update", days: 45 }, category: "Pure-Play" },
  { ticker: "CMPS", company: "COMPASS Pathways", weight: 7.49, price: 10.00, dayPct: 50.2, spark: [0.01, 0.00, 0.16, 1.00, 0.56, 0.57, 0.48, 0.48], shortInterestPct: 9.6, nextCatalyst: { label: "COMP006 Part B 26-wk", days: 72 }, category: "Pure-Play" },
  { ticker: "DRUG", company: "Bright Minds Biosciences", weight: 5.46, price: 24.10, dayPct: 14.5, spark: [0.49, 0.02, 0.00, 0.30, 0.40, 1.00, 0.78, 0.78], shortInterestPct: 6.4, nextCatalyst: { label: "Prader-Willi Ph2 init", days: 35 }, category: "Pure-Play" },
  { ticker: "GHRS", company: "GH Research", weight: 5.42, price: 17.85, dayPct: 22.7, spark: [0.04, 0.00, 0.16, 1.00, 0.83, 0.76, 0.80, 0.80], shortInterestPct: 11.3, nextCatalyst: { label: "GH001 Global Ph3 init", days: 90 }, category: "Pure-Play" },
  { ticker: "ANRO", company: "Alto Neuroscience", weight: 5.23, price: 6.42, dayPct: 8.1, spark: [0.00, 0.34, 0.47, 0.92, 0.68, 0.86, 1.00, 1.00], shortInterestPct: 14.8, nextCatalyst: { label: "ALTO-100 MDD biomarker readout", days: 110 }, category: "Pure-Play" },
  { ticker: "NRXP", company: "NRx Pharmaceuticals", weight: 5.04, price: 1.45, dayPct: 16.8, spark: [0.68, 0.18, 0.40, 0.00, 0.23, 0.77, 1.00, 1.00], shortInterestPct: 22.1, nextCatalyst: { label: "NRX-100 NDA progress", days: 60 }, category: "Adjacent" },
  { ticker: "HELP", company: "Helus Pharma (fka Cybin)", weight: 4.03, price: 5.02, dayPct: 0.0, spark: [0.00, 0.06, 0.19, 0.86, 0.77, 1.00, 0.93, 0.93], shortInterestPct: 15.2, nextCatalyst: { label: "HLP-003 Ph3 enrollment update", days: 250 }, category: "Pure-Play" },
  { ticker: "ABBV", company: "AbbVie", weight: 4.44, price: 198.40, dayPct: 1.2, spark: [0.24, 0.25, 0.00, 0.83, 1.00, 0.71, 0.63, 0.63], shortInterestPct: 1.4, nextCatalyst: { label: "Q1 2026 earnings", days: 8 }, category: "Big Pharma" },
  { ticker: "JNJ", company: "Johnson & Johnson", weight: 4.25, price: 165.80, dayPct: 0.8, spark: [0.13, 0.36, 0.00, 0.76, 1.00, 0.83, 0.85, 0.73], shortInterestPct: 0.9, nextCatalyst: { label: "Q1 2026 earnings", days: 2 }, category: "Big Pharma" },
  { ticker: "ALKS", company: "Alkermes", weight: 4.24, price: 32.15, dayPct: 3.4, spark: [0.00, 0.12, 0.18, 1.00, 0.96, 0.74, 0.74, 0.72], shortInterestPct: 4.2, nextCatalyst: { label: "Q1 earnings + ALKS 2680 readout", days: 22 }, category: "Adjacent" },
  { ticker: "NBIX", company: "Neurocrine Biosciences", weight: 4.20, price: 142.50, dayPct: 2.1, spark: [0.30, 0.08, 0.00, 0.54, 0.85, 1.00, 0.84, 0.73], shortInterestPct: 3.1, nextCatalyst: { label: "Q1 earnings", days: 18 }, category: "Adjacent" },
  { ticker: "STIM", company: "Neuronetics", weight: 4.10, price: 1.92, dayPct: 6.7, spark: [0.11, 0.19, 0.00, 0.20, 0.33, 0.98, 1.00, 1.00], shortInterestPct: 7.5, nextCatalyst: { label: "Q1 earnings", days: 14 }, category: "Adjacent" },
  { ticker: "SUPN", company: "Supernus Pharmaceuticals", weight: 3.91, price: 35.20, dayPct: 1.8, spark: [0.09, 0.01, 0.00, 0.60, 0.90, 1.00, 0.56, 0.56], shortInterestPct: 4.8, nextCatalyst: { label: "Q1 earnings", days: 16 }, category: "Adjacent" },
  { ticker: "NEUP", company: "Neuphoria Therapeutics", weight: 3.34, price: 4.65, dayPct: 11.2, spark: [0.93, 0.83, 0.78, 1.00, 0.00, 0.13, 0.16, 0.16], shortInterestPct: 9.8, nextCatalyst: { label: "BNC210 anxiety readout", days: 65 }, category: "Pure-Play" },
  { ticker: "KTTA", company: "Pasithea Therapeutics", weight: 1.87, price: 0.62, dayPct: 13.4, spark: [0.95, 1.00, 0.17, 0.56, 0.62, 0.09, 0.00, 0.00], shortInterestPct: 18.5, nextCatalyst: { label: "PAS-004 Ph1 update", days: 95 }, category: "Pure-Play" },
  { ticker: "QNTM", company: "Quantum BioPharma", weight: 1.86, price: 1.10, dayPct: 9.5, spark: [1.00, 0.55, 0.52, 0.52, 0.21, 0.00, 0.19, 0.19], shortInterestPct: null, nextCatalyst: { label: "unbuzzd Lucid trial update", days: 80 }, category: "Pure-Play" },
  { ticker: "BTRT", company: "BlackRock Treasury Trust", weight: 1.65, price: 1.00, dayPct: 0.0, spark: [0.50, 0.50, 0.50, 0.50, 0.50, 0.50, 0.50, 0.50], shortInterestPct: null, nextCatalyst: null, category: "Cash" },
  { ticker: "SILO", company: "Silo Pharma", weight: 1.61, price: 1.84, dayPct: 14.8, spark: [0.51, 1.00, 0.66, 0.61, 0.70, 0.38, 0.00, 0.00], shortInterestPct: 12.4, nextCatalyst: { label: "SPC-15 PTSD Ph1", days: 120 }, category: "Pure-Play" },
  { ticker: "VTGN", company: "Vistagen Therapeutics", weight: 0.76, price: 1.35, dayPct: 7.9, spark: [0.65, 0.74, 0.93, 1.00, 0.01, 0.03, 0.01, 0.00], shortInterestPct: 13.2, nextCatalyst: { label: "Fasedienol PALISADE-3 readout", days: 55 }, category: "Adjacent" },
  { ticker: "IXHL", company: "Incannex Healthcare", weight: 0.40, price: 0.34, dayPct: 6.2, spark: [0.00, 0.87, 0.61, 0.48, 1.00, 0.45, 0.24, 0.24], shortInterestPct: null, nextCatalyst: { label: "PSX-001 GAD Ph2 readout", days: 100 }, category: "Pure-Play" },
  { ticker: "NUMI", company: "Numinus Wellness", weight: 0.24, price: 0.18, dayPct: 8.5, spark: [0.38, 0.00, 0.83, 1.00, 0.57, 0.21, 0.33, 0.33], shortInterestPct: null, nextCatalyst: { label: "Ketamine clinic Q4 update", days: 75 }, category: "Pure-Play" },
  { ticker: "ENVB", company: "Enveric Biosciences", weight: 0.18, price: 1.62, dayPct: 11.7, spark: [1.00, 0.48, 0.00, 0.26, 0.33, 0.13, 0.08, 0.08], shortInterestPct: 16.8, nextCatalyst: { label: "EB-003 Ph1 init", days: 130 }, category: "Pure-Play" },
  { ticker: "CMND", company: "Clearmind Medicine", weight: 0.03, price: 0.52, dayPct: 5.4, spark: [1.00, 0.69, 0.56, 0.22, 0.21, 0.05, 0.00, 0.00], shortInterestPct: null, nextCatalyst: { label: "CMND-100 Ph1/2a update", days: 110 }, category: "Pure-Play" },
];
