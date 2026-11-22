#!/usr/bin/env node
/**
 * Chip supply-chain feeds for the chip desk and the wire (keyless, official):
 *   bis   US export-control documents: Federal Register API, Bureau of
 *         Industry and Security (US government work).
 *   pla   Daily PLA activity around Taiwan: Taiwan Ministry of National
 *         Defense RSS. Counts sit in prose, so each item must match a strict
 *         pattern or it is skipped (never guessed).
 *   twse  Monthly revenue for TSMC, UMC and MediaTek: TWSE OpenAPI
 *         (Open Government Data License, Taiwan: reuse allowed WITH
 *         attribution, so every surface that prints these names TWSE).
 * Each source fails on its own (ok:false) and keeps the previous good copy,
 * so one broken upstream never blanks the others.
 * Writes public/data/chips.json. Runs in the daily workflow.
 */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'public', 'data', 'chips.json');
const UA = { 'User-Agent': 'osprey-cache/1.0' };
const prev = (() => { try { return JSON.parse(fs.readFileSync(OUT, 'utf-8')); } catch { return { sources: {} }; } })();

async function get(url, as = 'json', headers = UA) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return as === 'json' ? res.json() : res.text();
}

// ── 1. BIS documents ────────────────────────────────────────────────────────
const CHIP = /semiconductor|integrated circuit|advanced computing|entity list|supercomput|chip|wafer|lithograph|export administration regulations|\bEAR\b/i;
async function bis() {
  const q = 'https://www.federalregister.gov/api/v1/documents.json?conditions%5Bagencies%5D%5B%5D=industry-and-security-bureau&order=newest&per_page=40'
    + ['title', 'type', 'publication_date', 'html_url', 'document_number', 'abstract'].map((f) => '&fields%5B%5D=' + f).join('');
  const d = await get(q);
  const today = new Date().toISOString().slice(0, 10);
  const docs = (d.results || [])
    .filter((r) => r.publication_date && r.publication_date <= today && /^\d{4}-\d{2}-\d{2}$/.test(r.publication_date))   // scheduled, not-yet-published items are excluded
    .filter((r) => r.type === 'Rule' || r.type === 'Proposed Rule')                                                    // paperwork notices are noise
    .map((r) => ({ date: r.publication_date, type: r.type, title: String(r.title || '').trim(), url: r.html_url, number: r.document_number, chip: CHIP.test((r.title || '') + ' ' + (r.abstract || '')) }))
    .slice(0, 15);
  if (!docs.length) throw new Error('no rules in response');
  return { ok: true, latest: docs[0].date, docs };
}

// ── 2. PLA activity around Taiwan ───────────────────────────────────────────
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
async function pla() {
  const xml = await get('https://air.mnd.gov.tw/EN/WebInfo/RSS.aspx', 'text', { 'User-Agent': 'Mozilla/5.0 (compatible; osprey-cache/1.0)' });
  const rows = [];
  for (const it of xml.match(/<item>[\s\S]*?<\/item>/g) || []) {
    const title = (it.match(/<title><!\[CDATA\[([\s\S]*?)\]\]>/) || [])[1] || '';
    const body = ((it.match(/<description><!\[CDATA\[([\s\S]*?)\]\]>/) || [])[1] || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ');
    const t = title.match(/around Taiwan\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})\s+(\d{4})/);
    const m = body.match(/(\d+)\s+sorties? of PLA aircraft,\s*(\d+)\s+PLAN ships?(?:\s+and\s+(\d+)\s+official ships?)?/i);
    if (!t || !m || !MONTHS[t[1].toLowerCase()]) continue;                    // wording changed: skip, never guess
    const adiz = body.match(/(\d+)\s+out of\s+(\d+)\s+sorties?/i);
    const row = {
      date: `${t[3]}-${String(MONTHS[t[1].toLowerCase()]).padStart(2, '0')}-${String(t[2]).padStart(2, '0')}`,   // the report date: covers the 24h to 06:00 Taiwan time that day
      aircraft: +m[1], ships: +m[2], official_ships: m[3] != null ? +m[3] : 0,
      adiz: adiz && +adiz[2] === +m[1] ? +adiz[1] : null,
    };
    if (row.aircraft > 300 || row.ships > 100 || row.official_ships > 100) continue;   // sanity band
    rows.push(row);
  }
  if (rows.length < 5) throw new Error('only ' + rows.length + ' parseable reports');
  // keep history past the feed's rolling window
  const byDate = new Map(((prev.sources.pla && prev.sources.pla.series) || []).map((r) => [r.date, r]));
  for (const r of rows) byDate.set(r.date, r);
  const series = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-400);
  return { ok: true, latest: series[series.length - 1].date, series };
}

// ── 3. Taiwan foundry and design monthly revenue ────────────────────────────
const FIRMS = { 2330: 'TSMC', 2303: 'UMC', 2454: 'MediaTek' };
async function twse() {
  const d = await get('https://openapi.twse.com.tw/v1/opendata/t187ap05_L');
  const companies = [];
  let period = null;
  for (const r of d) {
    const name = FIRMS[r['公司代號']];
    if (!name) continue;
    const ym = String(r['資料年月'] || '');                                     // ROC calendar: 11510 = 2026-10
    const rev = Number(r['營業收入-當月營收']), last = Number(r['營業收入-上月營收']), yago = Number(r['營業收入-去年當月營收']);
    if (!/^\d{5}$/.test(ym) || !(rev > 0) || !(last > 0) || !(yago > 0)) continue;
    period = `${+ym.slice(0, 3) + 1911}-${ym.slice(3)}`;
    companies.push({
      code: String(r['公司代號']), name, period,
      revenue_twd_bn: +(rev / 1e6).toFixed(1),                                 // source unit is NT$ thousands
      mom_pct: +((rev / last - 1) * 100).toFixed(1), yoy_pct: +((rev / yago - 1) * 100).toFixed(1),   // recomputed from levels, not trusted from the feed
    });
  }
  if (companies.length < 2) throw new Error('firms missing from the table');
  return { ok: true, period, companies };
}

(async () => {
  const out = { updated: new Date().toISOString(), sources: {} };
  for (const [key, fn] of Object.entries({ bis, pla, twse })) {
    try { out.sources[key] = await fn(); console.log('  ok   ' + key); }
    catch (e) {
      const old = prev.sources[key];
      out.sources[key] = old && old.ok ? Object.assign({}, old, { ok: false, error: e.message, stale_since: old.stale_since || prev.updated }) : { ok: false, error: e.message };
      console.log('  FAIL ' + key + ': ' + e.message);
    }
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log('chips.json written');
})();
