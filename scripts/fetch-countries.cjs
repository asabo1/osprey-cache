#!/usr/bin/env node
/**
 * Country oil registry for the /oil desk (MARKETS-PLAN reorg, EIA gate
 * cleared 2026-07-04): one EIA international pull — product 53 "Total
 * petroleum and other liquids", activities 1 (Production) + 2 (Consumption),
 * annual, kb/d — and NET POSITION = CONSUMPTION − PRODUCTION per country
 * (EIA's international route has no Exports facet; cons−prod is cleaner than
 * trade data anyway: no re-export noise).
 *
 * The ISO map below is BOTH the country whitelist and the aggregates filter:
 * EIA serves region aggregates (world, OECD...) on the same route, and only
 * ids present in this map enter the registry, so aggregates cannot leak in.
 *
 * Honesty + safety: EIA v2 needs URL-ENCODED brackets (raw brackets return
 * the route metadata silently — rehit 2026-07-04); world production
 * sum-check throws before write if outside 80,000-130,000 kb/d (unit or
 * product drift); fetch failure keeps the prior file (carry-forward).
 * Output: src/data/countries-data.json (bundled into pages at build; not a
 * public URL). Runs in daily-fetch; EIA quota cost: 1 call/day.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'src', 'data', 'countries-data.json');
const KEY = process.env.EIA_API_KEY;

// iso3 -> [iso2 (x-vercel-ip-country), display name, slug]
const COUNTRIES = {
  USA: ['US', 'United States', 'united-states'], CHN: ['CN', 'China', 'china'],
  IND: ['IN', 'India', 'india'], JPN: ['JP', 'Japan', 'japan'],
  KOR: ['KR', 'South Korea', 'south-korea'], DEU: ['DE', 'Germany', 'germany'],
  FRA: ['FR', 'France', 'france'], GBR: ['GB', 'United Kingdom', 'united-kingdom'],
  ITA: ['IT', 'Italy', 'italy'], ESP: ['ES', 'Spain', 'spain'],
  NLD: ['NL', 'Netherlands', 'netherlands'], POL: ['PL', 'Poland', 'poland'],
  TUR: ['TR', 'Turkey', 'turkey'], GRC: ['GR', 'Greece', 'greece'],
  PRT: ['PT', 'Portugal', 'portugal'], BEL: ['BE', 'Belgium', 'belgium'],
  AUT: ['AT', 'Austria', 'austria'], CHE: ['CH', 'Switzerland', 'switzerland'],
  SWE: ['SE', 'Sweden', 'sweden'], FIN: ['FI', 'Finland', 'finland'],
  IRL: ['IE', 'Ireland', 'ireland'], CZE: ['CZ', 'Czechia', 'czechia'],
  HUN: ['HU', 'Hungary', 'hungary'], ROU: ['RO', 'Romania', 'romania'],
  UKR: ['UA', 'Ukraine', 'ukraine'], NOR: ['NO', 'Norway', 'norway'],
  DNK: ['DK', 'Denmark', 'denmark'], RUS: ['RU', 'Russia', 'russia'],
  KAZ: ['KZ', 'Kazakhstan', 'kazakhstan'], AZE: ['AZ', 'Azerbaijan', 'azerbaijan'],
  SAU: ['SA', 'Saudi Arabia', 'saudi-arabia'], ARE: ['AE', 'United Arab Emirates', 'uae'],
  IRQ: ['IQ', 'Iraq', 'iraq'], IRN: ['IR', 'Iran', 'iran'],
  KWT: ['KW', 'Kuwait', 'kuwait'], QAT: ['QA', 'Qatar', 'qatar'],
  OMN: ['OM', 'Oman', 'oman'], BHR: ['BH', 'Bahrain', 'bahrain'],
  ISR: ['IL', 'Israel', 'israel'], EGY: ['EG', 'Egypt', 'egypt'],
  DZA: ['DZ', 'Algeria', 'algeria'], LBY: ['LY', 'Libya', 'libya'],
  MAR: ['MA', 'Morocco', 'morocco'], NGA: ['NG', 'Nigeria', 'nigeria'],
  AGO: ['AO', 'Angola', 'angola'], GHA: ['GH', 'Ghana', 'ghana'],
  ZAF: ['ZA', 'South Africa', 'south-africa'], KEN: ['KE', 'Kenya', 'kenya'],
  CAN: ['CA', 'Canada', 'canada'], MEX: ['MX', 'Mexico', 'mexico'],
  BRA: ['BR', 'Brazil', 'brazil'], ARG: ['AR', 'Argentina', 'argentina'],
  COL: ['CO', 'Colombia', 'colombia'], VEN: ['VE', 'Venezuela', 'venezuela'],
  ECU: ['EC', 'Ecuador', 'ecuador'], PER: ['PE', 'Peru', 'peru'],
  CHL: ['CL', 'Chile', 'chile'], GUY: ['GY', 'Guyana', 'guyana'],
  TTO: ['TT', 'Trinidad and Tobago', 'trinidad-and-tobago'],
  AUS: ['AU', 'Australia', 'australia'], NZL: ['NZ', 'New Zealand', 'new-zealand'],
  IDN: ['ID', 'Indonesia', 'indonesia'], MYS: ['MY', 'Malaysia', 'malaysia'],
  SGP: ['SG', 'Singapore', 'singapore'], THA: ['TH', 'Thailand', 'thailand'],
  VNM: ['VN', 'Vietnam', 'vietnam'], PHL: ['PH', 'Philippines', 'philippines'],
  PAK: ['PK', 'Pakistan', 'pakistan'], BGD: ['BD', 'Bangladesh', 'bangladesh'],
  TWN: ['TW', 'Taiwan', 'taiwan'], HKG: ['HK', 'Hong Kong', 'hong-kong'],
  LKA: ['LK', 'Sri Lanka', 'sri-lanka'],
  DOM: ['DO', 'Dominican Republic', 'dominican-republic'],
  JAM: ['JM', 'Jamaica', 'jamaica'],
  PAN: ['PA', 'Panama', 'panama'],
  CRI: ['CR', 'Costa Rica', 'costa-rica'],
};

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'the-site-fetch' }, timeout: 20000 }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(d));
    });
    req.on('timeout', () => req.destroy(new Error('timeout 20s')));
    req.on('error', reject);
  });
}

async function main() {
  if (!KEY) { console.error('EIA_API_KEY not set; keeping prior file'); process.exit(0); }
  // EIA splits the liquids family across products: 53 carries Production
  // ONLY, 5 carries Consumption ONLY (histograms observed 2026-07-04), and
  // its parser drops repeated facet values — so this must be TWO calls.
  const mkUrl = (productId) => 'https://api.eia.gov/v2/international/data/?api_key=' + KEY +
    '&frequency=annual&data%5B0%5D=value&facets%5BproductId%5D%5B%5D=' + productId +
    // No activityId facet: EIA's parser dropped the second repeated facet
    // value (observed 2026-07-04: only Production came back), so we pull all
    // activities for product 53 and filter client-side.
    '&start=2024&sort%5B0%5D%5Bcolumn%5D=period&sort%5B0%5D%5Bdirection%5D=desc&length=5000';

  let rows;
  try {
    const bodies = await Promise.all([get(mkUrl(53)), get(mkUrl(5))]);
    rows = bodies.flatMap((b) => {
      const d = JSON.parse(b).response;
      return (d && d.data) || [];
    });
    if (!rows.length) throw new Error('empty data array (bracket-encoding or facet drift?)');
  } catch (e) {
    console.error('EIA fetch failed, prior file kept: ' + e.message);
    process.exit(fs.existsSync(OUT) ? 0 : 1);
  }

  // Latest year per country that has BOTH activities.
  const byC = {};
  const seenActivities = {};
  for (const r of rows) {
    seenActivities[r.activityName || r.activityId] = (seenActivities[r.activityName || r.activityId] || 0) + 1;
    const act = String(r.activityId);
    if (act !== '1' && act !== '2') continue; // production + consumption only
    if (r.unit !== 'TBPD') continue; // product 5 serves 3 units; kb/d only
    const iso = r.countryRegionId;
    if (!COUNTRIES[iso]) continue; // whitelist doubles as aggregates filter
    const v = parseFloat(r.value);
    if (!isFinite(v)) continue;
    const y = String(r.period);
    byC[iso] = byC[iso] || {};
    byC[iso][y] = byC[iso][y] || {};
    byC[iso][y][act === '1' ? 'prod' : 'cons'] = v;
  }
  console.log('activities seen:', JSON.stringify(seenActivities));
  const countries = [];
  for (const [iso, years] of Object.entries(byC)) {
    const year = Object.keys(years).sort().reverse().find((y) => years[y].prod != null && years[y].cons != null);
    if (!year) continue;
    const { prod, cons } = years[year];
    const [iso2, name, slug] = COUNTRIES[iso];
    countries.push({
      iso3: iso, iso2, name, slug, year: +year,
      prod_kbd: +prod.toFixed(1), cons_kbd: +cons.toFixed(1),
      net_kbd: +(cons - prod).toFixed(1), // >0 net importer, <0 net exporter
    });
  }

  // Tripwires: coverage + unit sanity (world total liquids ~102,000 kb/d).
  if (countries.length < 40) {
    console.error('sample rows for diagnosis:', JSON.stringify((rows || []).slice(0, 3)));
    throw new Error('only ' + countries.length + ' countries resolved; refusing to write');
  }
  const worstNet = Math.max(...countries.map((c) => Math.abs(c.net_kbd)));
  if (worstNet > 25000) throw new Error('|net| ' + worstNet + ' kb/d exceeds any plausible country (unit mixing?); refusing to write');
  const prodSum = countries.reduce((s, c) => s + c.prod_kbd, 0);
  if (prodSum < 60000 || prodSum > 130000) {
    throw new Error('production sum ' + Math.round(prodSum) + ' kb/d outside sanity band (unit/product drift?); refusing to write');
  }

  countries.sort((a, b) => b.net_kbd - a.net_kbd);
  fs.writeFileSync(OUT, JSON.stringify({
    generated: new Date().toISOString(),
    source: 'Derived from U.S. EIA International Energy Statistics (total petroleum and other liquids, annual)',
    unit: 'kb/d', method: 'net = consumption - production',
    countries,
  }, null, 1));
  console.log('countries: ' + countries.length + ' resolved, prod sum ' + Math.round(prodSum) +
    ' kb/d, top importer ' + countries[0].name + ' +' + countries[0].net_kbd +
    ', top exporter ' + countries[countries.length - 1].name + ' ' + countries[countries.length - 1].net_kbd);
}

main().catch((e) => { console.error(e); process.exit(1); });
