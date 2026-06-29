// Uninstall detection via Expo push receipts — ADDITIVE. A push to an uninstalled (or
// notifications-disabled) device comes back as DeviceNotRegistered; that's the industry-standard
// uninstall proxy. We harvest it two ways:
//   1) Passively — when the app already sends a push (job-search-complete), a 'stale' result clears
//      the token and logs an uninstall (handleStaleToken, called from the existing send path).
//   2) Actively — an admin-triggered sweep sends a SILENT (content-available, no banner/sound) push
//      to every stored token and reads receipts, logging an uninstall for each DeviceNotRegistered.
// Uninstalls are logged into app_events (event='uninstall') so installs/uninstalls/net all derive
// from one stream. Never throws. Honest caveat: 'DeviceNotRegistered' also fires if a user merely
// turned notifications off, so this is a close proxy, not an exact count.
'use strict';
const dbConfig = require('../../db-config');
const live = require('./liveAnalytics');

const EXPO_SEND = 'https://exp.host/--/api/v2/push/send';
const EXPO_RECEIPTS = 'https://exp.host/--/api/v2/push/getReceipts';
const VALID = /^Expo(nent)?PushToken\[/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function chunk(arr, n) { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; }

// Clear the stale token and record the uninstall (best-effort).
async function handleStaleToken(userId, platform) {
  if (!Number.isInteger(userId)) return;
  await dbConfig.run(`UPDATE users SET expo_push_token = NULL WHERE id = ?`, [userId]).catch(() => {});
  await live.recordUninstall({ userId, platform: platform || null });
}

async function sweepUninstalls({ limit = 5000 } = {}) {
  const rows = await dbConfig.query(
    `SELECT id, expo_push_token FROM users WHERE expo_push_token IS NOT NULL AND expo_push_token <> '' LIMIT ${parseInt(limit, 10) || 5000}`
  ).catch(() => []);
  const targets = (rows || []).filter((r) => VALID.test(r.expo_push_token || ''));
  let checked = 0, uninstalled = 0;
  const tickets = []; // { id, userId }

  for (const group of chunk(targets, 100)) {
    const messages = group.map((r) => ({ to: r.expo_push_token, _contentAvailable: true, priority: 'normal', data: { type: 'health_check' } }));
    let data = [];
    try {
      const resp = await fetch(EXPO_SEND, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(messages), signal: AbortSignal.timeout(15000),
      });
      const j = await resp.json().catch(() => ({}));
      data = Array.isArray(j.data) ? j.data : [];
    } catch (_) { data = []; }
    for (let i = 0; i < group.length; i++) {
      checked++;
      const t = data[i];
      if (t && t.status === 'error') {
        if (t.details && t.details.error === 'DeviceNotRegistered') { await handleStaleToken(group[i].id); uninstalled++; }
      } else if (t && t.status === 'ok' && t.id) {
        tickets.push({ id: t.id, userId: group[i].id });
      }
    }
  }

  // DeviceNotRegistered usually surfaces in the RECEIPT, not the send ticket — fetch them.
  if (tickets.length) {
    await sleep(8000);
    const byId = {}; tickets.forEach((x) => { byId[x.id] = x.userId; });
    for (const ids of chunk(tickets.map((x) => x.id), 1000)) {
      let receipts = {};
      try {
        const resp = await fetch(EXPO_RECEIPTS, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ ids }), signal: AbortSignal.timeout(15000),
        });
        const j = await resp.json().catch(() => ({}));
        receipts = (j && j.data) || {};
      } catch (_) { receipts = {}; }
      for (const id of Object.keys(receipts)) {
        const r = receipts[id];
        if (r && r.status === 'error' && r.details && r.details.error === 'DeviceNotRegistered') {
          await handleStaleToken(byId[id]); uninstalled++;
        }
      }
    }
  }
  return { checked, uninstalled, pendingReceipts: tickets.length };
}

module.exports = { handleStaleToken, sweepUninstalls };
