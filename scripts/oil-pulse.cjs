#!/usr/bin/env node
/**
 * Crude Signal Oil Pulse: posts terse market alerts (First Squawk register).
 * Style contract: ALL CAPS, terse, no hashtags, no editorializing.
 *
 * Channels (each arms independently via its secrets; zero-cost first):
 *   Telegram (FREE)  TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID  (@BotFather bot, add as channel admin)
 *   Bluesky  (FREE)  BSKY_HANDLE + BSKY_APP_PASSWORD        (Settings -> App Passwords)
 *   X        (PAID)  X_CONSUMER_KEY/X_CONSUMER_SECRET/X_ACCESS_TOKEN/X_ACCESS_TOKEN_SECRET
 *                    ($0.015/plain post pay-per-use; pulses carry no URLs to avoid the $0.20 URL rate;
 *                    account needs the "Automated" label)
 *
 * Modes:
 *   node scripts/oil-pulse.cjs                  -> pulse fresh CRIT intel items
 *   node scripts/oil-pulse.cjs --issue <md>     -> announce a published weekly issue (includes link)
 *
 * Exits 0 quietly when no channel is armed.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const STATE_FILE = path.join(ROOT, 'public', 'data', 'pulse-state.json');
const DAILY_CAP = parseInt(process.env.PULSE_DAILY_CAP || '10', 10);
const PER_RUN_CAP = 2;
const MAX_AGE_MS = 2 * 60 * 60 * 1000; // only pulse items <2h old

function pct(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

async function postTweet(text) {
  var oauth = {
    oauth_consumer_key: process.env.X_CONSUMER_KEY,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: process.env.X_ACCESS_TOKEN,
    oauth_version: '1.0',
  };
  var url = 'https://api.twitter.com/2/tweets';
  var paramStr = Object.keys(oauth).sort().map(k => pct(k) + '=' + pct(oauth[k])).join('&');
  var base = 'POST&' + pct(url) + '&' + pct(paramStr);
  var signingKey = pct(process.env.X_CONSUMER_SECRET) + '&' + pct(process.env.X_ACCESS_TOKEN_SECRET);
  oauth.oauth_signature = crypto.createHmac('sha1', signingKey).update(base).digest('base64');
  var header = 'OAuth ' + Object.keys(oauth).sort().map(k => pct(k) + '="' + pct(oauth[k]) + '"').join(', ');

  var res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': header, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text }),
  });
  var body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('X API ' + res.status + ': ' + JSON.stringify(body).slice(0, 300));
  return body.data && body.data.id;
}

async function postTelegram(text, withLink) {
  var res = await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: text, disable_web_page_preview: !withLink }),
  });
  var body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) throw new Error('Telegram ' + res.status + ': ' + JSON.stringify(body).slice(0, 200));
  return 'tg:' + (body.result && body.result.message_id);
}

async function postBluesky(text) {
  var sess = await fetch('https://bsky.social/xrpc/com.atproto.server.createSession', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: process.env.BSKY_HANDLE, password: process.env.BSKY_APP_PASSWORD }),
  });
  var auth = await sess.json();
  if (!sess.ok) throw new Error('Bluesky auth ' + sess.status);
  var res = await fetch('https://bsky.social/xrpc/com.atproto.repo.createRecord', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + auth.accessJwt },
    body: JSON.stringify({
      repo: auth.did,
      collection: 'app.bsky.feed.post',
      record: { '$type': 'app.bsky.feed.post', text: text.slice(0, 300), createdAt: new Date().toISOString() },
    }),
  });
  var body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Bluesky post ' + res.status + ': ' + JSON.stringify(body).slice(0, 200));
  return 'bsky:' + (body.uri || '').split('/').pop();
}

function channels() {
  var ch = [];
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID)
    ch.push({ name: 'telegram', send: (t, link) => postTelegram(link ? t + '\n\n' + link : t, !!link) });
  if (process.env.BSKY_HANDLE && process.env.BSKY_APP_PASSWORD)
    ch.push({ name: 'bluesky', send: (t, link) => postBluesky(link ? t + '\n\n' + link : t) });
  if (process.env.X_CONSUMER_KEY && process.env.X_CONSUMER_SECRET && process.env.X_ACCESS_TOKEN && process.env.X_ACCESS_TOKEN_SECRET)
    ch.push({ name: 'x', send: (t, link) => postTweet(link ? t + '\n\n' + link : t) });
  return ch;
}

var DRY = process.argv.includes('--dry-run');

async function broadcast(text, link) {
  if (DRY) { console.log('[dry-run] ' + text + (link ? ' | ' + link : '')); return ['dry']; }
  var sent = [];
  for (var c of channels()) {
    try { sent.push(await c.send(text, link)); }
    catch (e) { console.error(c.name + ' failed: ' + e.message); }
  }
  return sent;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return { posted: {}, counts: {} }; }
}
function saveState(st) {
  // prune: keep last 300 hashes
  var keys = Object.keys(st.posted);
  if (keys.length > 300) {
    keys.sort((a, b) => (st.posted[a] < st.posted[b] ? -1 : 1));
    keys.slice(0, keys.length - 300).forEach(k => delete st.posted[k]);
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(st));
}

function fmtSquawk(text) {
  // First Squawk register: all caps, no trailing punctuation, no links.
  var t = text.toUpperCase().replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
  t = t.replace(/[.!]+$/, '');
  return t.length > 275 ? t.slice(0, 272) + '...' : t;
}

function hash(s) {
  return crypto.createHash('sha256').update(s.toLowerCase().replace(/[^a-z0-9]/g, '')).digest('hex').slice(0, 16);
}

async function main() {
  if (DRY && channels().length === 0) {
    // dry-run works unarmed
  } else if (channels().length === 0) {
    console.log('Oil Pulse NOT ARMED (no channel secrets). Free channels: TELEGRAM_BOT_TOKEN+TELEGRAM_CHAT_ID, or BSKY_HANDLE+BSKY_APP_PASSWORD. Paid: the four X_* secrets.');
    process.exit(0);
  }

  var args = process.argv.slice(2);
  var issueIdx = args.indexOf('--issue');

  if (issueIdx >= 0) {
    // Weekly issue announcement: one URL post per week is worth the $0.20 rate.
    var file = args[issueIdx + 1];
    var md = fs.readFileSync(file, 'utf8');
    var title = (md.match(/^title:\s*"(.+)"/m) || [])[1] || path.basename(file, '.md');
    var slug = path.basename(file, '.md');
    var text = fmtSquawk('CRUDE SIGNAL ' + title).slice(0, 200);
    var link = 'https://crudesignal.io/posts/' + slug;
    var ids = await broadcast(text, link);
    console.log('Issue announced: ' + (ids.join(', ') || 'no channel succeeded'));
    return;
  }

  // Alert mode: instrument alerts first (unique to us), wire CRIT items as filler.
  var daily = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'daily.json'), 'utf8'));
  var st = loadState();
  st.last = st.last || {};
  var today = new Date().toISOString().slice(0, 10);
  var usedToday = st.counts[today] || 0;
  if (usedToday >= DAILY_CAP) { console.log('Daily pulse cap reached (' + DAILY_CAP + ').'); return; }

  var L = daily.latest || {};
  var day = Math.floor((Date.now() - new Date('2026-02-28').getTime()) / 864e5);
  var instrument = [];

  // 1. Crisis score moved >=5 pts since last alerted
  if (L.crisis_score != null) {
    var prevScore = st.last.score;
    if (prevScore == null) { st.last.score = L.crisis_score; }
    else if (Math.abs(L.crisis_score - prevScore) >= 5) {
      var dir = L.crisis_score > prevScore ? 'UP' : 'DOWN';
      instrument.push({ key: 'score:' + L.crisis_score, text:
        'HORMUZ CRISIS SCORE ' + L.crisis_score + '/100, ' + dir + ' ' + Math.abs(L.crisis_score - prevScore) +
        ' FROM ' + prevScore + '; BRENT $' + (+L.brent).toFixed(2) + '; BLOCKADE DAY ' + day,
        commit: function () { st.last.score = L.crisis_score; } });
    }
  }
  // 2. Brent crossed a $5 level since last alerted
  if (L.brent != null) {
    var lvl = Math.floor(L.brent / 5) * 5;
    var prevLvl = st.last.brent_lvl;
    if (prevLvl == null) { st.last.brent_lvl = lvl; }
    else if (lvl !== prevLvl) {
      var dirB = lvl > prevLvl ? 'UP THROUGH' : 'DOWN THROUGH';
      var crossed = lvl > prevLvl ? lvl : prevLvl;
      instrument.push({ key: 'brent:' + lvl + ':' + (lvl > prevLvl), text:
        'BRENT TRADES ' + dirB + ' $' + crossed + '; NOW $' + (+L.brent).toFixed(2) +
        '; WTI $' + (+L.wti).toFixed(2) + '; SPREAD $' + (+L.spread).toFixed(2) + '; HORMUZ DAY ' + day,
        commit: function () { st.last.brent_lvl = lvl; } });
    }
  }
  // 3. Attacked-vessel count rose
  var atk = daily.vessels_attacked && daily.vessels_attacked.count;
  if (atk != null) {
    var prevAtk = st.last.attacked;
    if (prevAtk == null) { st.last.attacked = atk; }
    else if (atk > prevAtk) {
      instrument.push({ key: 'atk:' + atk, text:
        'HORMUZ: VESSELS ATTACKED SINCE FEB 28 RISES TO ' + atk + ' FROM ' + prevAtk +
        '; BLOCKADE DAY ' + day + '; BRENT $' + (+L.brent).toFixed(2),
        commit: function () { st.last.attacked = atk; } });
    }
  }
  // 4. Crisis day milestone (every 10 days) — de-escalation-era framing:
  // "blockade day" is stale copy now that the strait is open-but-contested.
  var sdDay = Math.max(1, Math.floor((Date.now() - new Date('2026-06-28').getTime()) / 864e5) + 1);
  if (day > 0 && day % 10 === 0 && st.last.milestone !== day) {
    instrument.push({ key: 'day:' + day, text:
      'HORMUZ CRISIS DAY ' + day + '; STAND-DOWN HOLDING DAY ' + sdDay + '; ' +
      'BRENT $' + (+L.brent).toFixed(2) + '; CRISIS SCORE ' + (L.crisis_score != null ? L.crisis_score + '/100' : 'N/A'),
      commit: function () { st.last.milestone = day; } });
  }

  // 5. Synthesis driver changed — our best content, already written hourly by
  // the desk LLM: one sentence connecting the top story to the price. Post it
  // when it changes (dedupe on text hash).
  var drv = daily.synthesis && daily.synthesis.driver;
  if (drv && drv.length > 30) {
    var dh = hash(drv);
    if (st.last.driver !== dh) {
      if (st.last.driver == null) { st.last.driver = dh; }
      else {
        instrument.push({ key: 'drv:' + dh, text:
          drv.toUpperCase() + (L.brent != null ? ' BRENT $' + (+L.brent).toFixed(2) : ''),
          commit: function () { st.last.driver = dh; } });
      }
    }
  }

  // 6. WPSR print landed (the racer publishes minutes after 10:30 ET Wed) —
  // the weekly speed moment.
  try {
    var w = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'wpsr.json'), 'utf8'));
    if (w && w.period && w.crude && st.last.wpsr !== w.period) {
      if (st.last.wpsr == null) { st.last.wpsr = w.period; }
      else {
        var dverb = w.crude.delta < 0 ? 'DRAW ' : 'BUILD +';
        instrument.push({ key: 'wpsr:' + w.period, text:
          'EIA: US CRUDE STOCKS ' + dverb + Math.abs(w.crude.delta).toFixed(1) + 'M BBL TO ' + w.crude.level.toFixed(1) + 'M (WK ' + w.period + '); ' +
          'GASOLINE ' + (w.gasoline ? (w.gasoline.delta > 0 ? '+' : '') + w.gasoline.delta.toFixed(1) + 'M' : 'N/A') + '; DISTILLATES ' +
          (w.distillate ? (w.distillate.delta > 0 ? '+' : '') + w.distillate.delta.toFixed(1) + 'M' : 'N/A'),
          commit: function () { st.last.wpsr = w.period; } });
      }
    }
  } catch (e) {}

  // 7. The Hormuz reopening odds moved >=5 pts (Polymarket top market).
  try {
    var od = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'odds.json'), 'utf8'));
    var m0 = od && od.markets && od.markets[0];
    if (m0 && /hormuz|strait/i.test(m0.question) && m0.yes_pct != null) {
      var prevOdds = st.last.odds;
      if (prevOdds == null) { st.last.odds = m0.yes_pct; }
      else if (Math.abs(m0.yes_pct - prevOdds) >= 5) {
        instrument.push({ key: 'odds:' + m0.yes_pct, text:
          'POLYMARKET: "' + m0.question.toUpperCase().replace(/\?$/, '') + '" NOW ' + m0.yes_pct + '%, ' +
          (m0.yes_pct > prevOdds ? 'UP' : 'DOWN') + ' FROM ' + prevOdds + '%; BRENT $' + (L.brent != null ? (+L.brent).toFixed(2) : 'N/A'),
          commit: function () { st.last.odds = m0.yes_pct; } });
      }
    }
  } catch (e) {}

  var now = Date.now();
  var wire = (daily.intel || [])
    .filter(i => i.severity === 'CRIT' && i.text && i.date)
    .filter(i => now - new Date(i.date).getTime() < MAX_AGE_MS)
    .filter(i => !st.posted[hash(i.text)])
    .map(i => ({ key: i.text, text: null, raw: i.text }));

  var candidates = instrument.concat(wire);

  var sent = 0;
  var stateDirty = instrument.length === 0 && Object.keys(st.last).length > 0 ? false : true;
  for (var i = 0; i < candidates.length && sent < PER_RUN_CAP && usedToday + sent < DAILY_CAP; i++) {
    var c = candidates[i];
    var text = fmtSquawk(c.raw || c.text);
    if (text.length < 20) continue;
    if (st.posted[hash(c.key)]) continue;
    var ids = await broadcast(text, null);
    if (ids.length === 0) { console.error('All channels failed; stopping this run.'); break; }
    st.posted[hash(c.key)] = new Date().toISOString();
    if (c.commit) c.commit();
    sent++;
    console.log('Alert [' + ids.join(', ') + ']: ' + text.slice(0, 80));
  }
  st.counts = {};
  st.counts[today] = usedToday + sent;
  saveState(st); // always persist: baselines (st.last) seed on first run
  console.log('Done: ' + sent + ' alert(s) (' + instrument.length + ' instrument, ' + wire.length + ' wire candidates), ' + (usedToday + sent) + '/' + DAILY_CAP + ' today.');
}

main().catch(function (e) { console.error(e.message || e); process.exit(1); });
