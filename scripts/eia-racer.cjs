// eia-racer.cjs — speed-plan Tier 2, phase 2: race the Wednesday 10:30 ET
// WPSR release and PUBLISH the print fast.
//
// Source: ir.eia.gov/wpsr/table1.csv — the release server, live at 10:30
// sharp. The v2 API was phase 1's source and measured ~3 HOURS slow on both
// logged weeks (2026-06-24, 2026-07-01: new period surfaced ~13:30 ET), so
// it is no longer polled here. On detection this script runs fetch-wpsr.cjs
// (full: history + take) so public/data/wpsr.json — and with it the
// /crude-oil-inventory-report page on the next deploy — carries the print
// minutes after release. Latency measurements keep appending to
// data-archive/alert-log.jsonl (kind eia-wpsr-race, source ir.eia.gov).
const fs = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');

const TABLE1 = 'https://ir.eia.gov/wpsr/table1.csv';
const WPSR_JSON = path.join(__dirname, '..', 'public', 'data', 'wpsr.json');
const POLL_MS = 15000;          // release-server CSV; be polite, 15s is plenty
const MAX_MS = 25 * 60 * 1000;

async function currentPeriod() {
  const res = await fetch(TABLE1, { headers: { 'User-Agent': 'CrudeSignal/1.0 (+https://crudesignal.io)' } });
  if (!res.ok) return null;
  const text = await res.text();
  const m = text.slice(0, 200).match(/"STUB_1","(\d{1,2}\/\d{1,2}\/\d{2})"/);
  if (!m) return null;
  const p = m[1].split('/');
  return '20' + p[2] + '-' + p[0].padStart(2, '0') + '-' + p[1].padStart(2, '0');
}

function log(entry) {
  fs.mkdirSync('data-archive', { recursive: true });
  fs.appendFileSync('data-archive/alert-log.jsonl', JSON.stringify(entry) + '\n');
  console.log(JSON.stringify(entry));
}

// Thursday runs exist only for holiday-shifted releases (the workflow crons
// fire Wed AND Thu); on a normal Thursday, exit immediately instead of
// polling 25 minutes for a release that already happened yesterday.
const RELEASE_SHIFT_DATES = ['2026-09-10', '2026-11-12']; // keep in sync with fetch-wpsr RELEASE_SHIFTS

(async () => {
  const tStart = new Date();
  if (tStart.getUTCDay() === 4 && !RELEASE_SHIFT_DATES.includes(tStart.toISOString().split('T')[0])) {
    log({ kind: 'eia-wpsr-race', source: 'ir.eia.gov', at: tStart.toISOString(), skipped: 'thursday-no-shift' });
    return;
  }
  let baseline = null;
  try { baseline = JSON.parse(fs.readFileSync(WPSR_JSON, 'utf8')).period || null; } catch {}
  if (!baseline) baseline = await currentPeriod().catch(() => null);
  if (!baseline) { log({ kind: 'eia-wpsr-race', source: 'ir.eia.gov', at: tStart.toISOString(), error: 'no baseline' }); return; }

  // If this week's data is already out (e.g. the DST-shadow cron run an hour
  // after the real release), don't burn 25 minutes polling.
  const ageDays = (Date.now() - new Date(baseline + 'T00:00:00Z').getTime()) / 86400000;
  if (ageDays < 6) {
    log({ kind: 'eia-wpsr-race', source: 'ir.eia.gov', at: tStart.toISOString(), baseline, skipped: 'already-published' });
    return;
  }

  console.log('baseline period ' + baseline + ', polling table1.csv every ' + POLL_MS / 1000 + 's');
  let hit = null;
  const t0 = Date.now();
  while (Date.now() - t0 < MAX_MS) {
    const cur = await currentPeriod().catch(() => null);
    if (cur && cur !== baseline) { hit = cur; break; }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  const entry = {
    kind: 'eia-wpsr-race',
    source: 'ir.eia.gov',
    at: tStart.toISOString(),
    baseline,
    fired: !!hit,
  };
  if (hit) {
    entry.new_period = hit;
    entry.seen_at = new Date().toISOString();
    entry.poll_seconds = Math.round((Date.now() - t0) / 1000);
    // Publish: full wpsr.json refresh (table1 + history + take). Non-fatal —
    // the measurement log still lands even if the write fails.
    try {
      execFileSync('node', [path.join(__dirname, 'fetch-wpsr.cjs')], { stdio: 'inherit', timeout: 120000 });
      entry.published = true;
    } catch (e) {
      entry.published = false;
      entry.publish_error = String(e.message || e).slice(0, 200);
    }
  }
  log(entry);
})();
