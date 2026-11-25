#!/usr/bin/env node
/* Re-runnable scorer test: node scripts/test/tone.test.cjs
 * 1. tone-cases.json headlines must land within tol of the expected tone.
 * 2. fear() reproduces the 2026-11-25 spec numbers from saved sub-scores (oil 67, AI 96, composite 89).
 * 3. corr() never claims a link on small or noisy data.
 * Exit 1 on any failure. */
const path = require('path');
const t = require('../lib/tone.cjs');
const spec = require('./tone-cases.json');

let fails = 0, ok = 0;
for (const c of spec.cases) {
  const got = t.tone(c.text, c.desk), d = got - c.expect, pass = Math.abs(d) <= spec.tol;
  if (pass) ok++; else fails++;
  console.log((pass ? 'ok   ' : 'FAIL ') + String(c.n).padStart(2) + '  got ' + String(got).padStart(4) + '  want ' + String(c.expect).padStart(4) + '  ' + c.text);
}
console.log('tone: ' + ok + '/' + spec.cases.length + ' within +/-' + spec.tol);

// fear: spec section 3.2 sub-scores (integer-rounded there, so oil lands on 66 or 67)
const comp = {
  hormuz: [78, 0.30], ovx: [33, 0.25], pm: [97, 0.15], brent_prem: [41, 0.15], vix: [97, 0.10], gvz: [87, 0.05],
  vxn: [99, 0.25], sox_dd: [99, 0.25], sox_mom: [98, 0.15], credit: [92, 0.15], move: [84, 0.10]
};
const f = t.fear(comp);
const fok = Math.abs(f.oil - 67) <= 1 && f.ai === 96 && f.composite === 89 && f.lab.oil === 'fearful' && f.lab.ai === 'panic';
console.log((fok ? 'ok   ' : 'FAIL ') + 'fear oil ' + f.oil + ' ai ' + f.ai + ' composite ' + f.composite);
if (!fok) fails++;
// hysteresis: 75 does not flip a fearful label, 78 does
const h1 = t.fearLabel(76, 'fearful') === 'fearful', h2 = t.fearLabel(78, 'fearful') === 'panic';
console.log((h1 && h2 ? 'ok   ' : 'FAIL ') + 'hysteresis'); if (!(h1 && h2)) fails++;

// corr: tiny data collects, pure noise says no link
const rows = [];
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
for (let i = 0; i < 300; i++) {
  rows.push({ t: new Date(Date.UTC(2026, 10, 1) + i * 3600e3).toISOString(), tone: { hormuz: { wire: { h: Math.round((rnd() - 0.5) * 100) } } }, mkt: { brent: 90 + rnd() * 5 } });
}
const cn = t.corr(rows).hormuz, cs = t.corr(rows.slice(0, 12)).hormuz;
const cok = cs.state === 'collecting' && cn.state !== 'link';
console.log((cok ? 'ok   ' : 'FAIL ') + 'corr small=' + cs.state + ' noise=' + cn.state + ' (r ' + cn.r + ', n ' + cn.n + ')'); if (!cok) fails++;
console.log(t.corrText(cn, 'hormuz'));

process.exit(fails ? 1 : 0);
