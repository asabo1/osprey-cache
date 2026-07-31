#!/usr/bin/env node
// Daily mention-count baseline for the PSIL news-velocity factor. The factor
// stays PENDING until this series is deep enough to z-score against (~30
// stamps); counting starts now so the wait starts now. One line per day,
// never rewritten. Counts only — no polarity (no honest free NLP).
const fs = require("node:fs");
const path = require("node:path");
const INTEL = path.join(__dirname, "..", "public", "data", "psil-intel.json");
const OUT = path.join(__dirname, "..", "src", "data", "psil-mentions.jsonl");
const today = new Date().toISOString().slice(0, 10);
const lines = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8").trim().split("\n").filter(Boolean) : [];
if (lines.some(l => JSON.parse(l).date === today)) { console.log("psil-mentions: " + today + " already stamped."); process.exit(0); }
const intel = JSON.parse(fs.readFileSync(INTEL, "utf8"));
const items = intel.items || [];
const byCat = {};
for (const it of items) byCat[it.category || "other"] = (byCat[it.category || "other"] || 0) + 1;
fs.appendFileSync(OUT, JSON.stringify({ date: today, total: items.length, byCat }) + "\n");
console.log(`psil-mentions: stamped ${today} — ${items.length} items. Baseline: ${lines.length + 1} days.`);
