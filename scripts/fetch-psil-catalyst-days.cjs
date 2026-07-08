#!/usr/bin/env node
// Recomputes the `days` field on each catalyst in src/data/psil-catalysts.ts
// based on today's date. Keeps event dates fixed; drops past events automatically.
//
// Run daily via GitHub Actions (5am UTC).

const fs = require("node:fs");
const path = require("node:path");

const FILE = path.join(__dirname, "..", "src", "data", "psil-catalysts.ts");

function daysBetween(from, to) {
  const ms = new Date(to).getTime() - new Date(from).getTime();
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

function main() {
  let src = fs.readFileSync(FILE, "utf8");
  const today = new Date().toISOString().slice(0, 10);

  // Match each catalyst entry: { date: "YYYY-MM-DD", days: N, ticker: ...
  const entryRe = /{\s*date:\s*"(\d{4}-\d{2}-\d{2})",\s*days:\s*(-?\d+)/g;

  let updated = 0;
  let dropped = 0;
  let kept = 0;
  src = src.replace(entryRe, (match, date, oldDays) => {
    const d = daysBetween(today, date);
    if (d !== Number(oldDays)) updated++;
    kept++;
    return match.replace(`days: ${oldDays}`, `days: ${d}`);
  });

  // Update the top-of-file comment to reflect new baseline date
  src = src.replace(
    /next ~?\d+ days from \d{4}-\d{2}-\d{2}/,
    `next ~90 days from ${today}`
  );

  fs.writeFileSync(FILE, src);
  console.log(`Catalyst days refresh: ${updated} entries changed, ${kept} total (baseline ${today}).`);
}

main();
