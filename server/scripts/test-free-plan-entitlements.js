// The money model (2026-09-13, Free made DAILY 2026-10-29), run against the REAL entitlements.js / quotaGrants.js / adminUserOps.js /
// lifecycleNudges.js with an in-memory stand-in for db-config that understands exactly the SQL they send.
//   DATABASE_URL=postgresql://t@localhost:5432/t node server/scripts/test-free-plan-entitlements.js
//
// Why this exists: every other money test STUBS entitlements, so nothing ever checked the rules themselves.
// The product owner's decisions this file pins:
//   1. NO CREDITS FOR GENERATION — canConsumeMany/consumeOnSuccess never answer 'credits' for a resume or
//      a letter, never touch user_credits, and an exhausted allowance is quota_exhausted (→ Plans).
//   2. FREE = 10 resumes + 10 letters in any ROLLING 24 HOURS (2026-10-29; it was 3 + 3 one time), counted from
//      max(started_at, 2026-09-13, now − 24 h) — older usage/bonuses do not count, the refusal says when the next
//      one opens, a spent PLAN falls through to the free day, and ONE free allowance per DEVICE (device_trial_used).
//      Time is frozen at db.now (Date.now is patched) so the window is exact.
//   3. PLANS: starter 6/10, plus 15/25, pro 25/50, power 40/100, max 100/500; prices and downloads unchanged.
//   A. getStatus's free block: { active, startedAt, oneTime:false, daily:true, windowStart, endsAt:null, renewsAt:null, used, remaining, nextAt }.
'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};

// ── the fake database ────────────────────────────────────────────────────────────────────────────
const DAY = 86400000;
const db = {
  now: new Date('2026-09-14T12:00:00Z'),
  trials: new Map(), trialDevices: new Map(), userDevices: [], subs: [], ledger: [], grants: [],
  credits: new Map(), sql: [], unhandled: [], creditWrites: [], nextId: 1,
  globalFree: null,   // when a number: what the breaker's global count reads (simulates an attack)
};
const norm = (s) => String(s).replace(/--[^\n]*\n/g, ' ').replace(/\s+/g, ' ').trim();
const ts = (v) => new Date(v).getTime();
// The free window is "the last 24 hours" — so the harness owns the clock.
const REAL_NOW = Date.now;
Date.now = () => ts(db.now);

function exec(sqlRaw, p = []) {
  const sql = norm(sqlRaw);
  db.sql.push(sql);
  if (/user_credits/.test(sql) && /^(UPDATE|INSERT|DELETE)/i.test(sql)) db.creditWrites.push(sql);
  let m;
  if (/^SELECT to_regclass\(\$1\) AS t$/.test(sql)) return [{ t: p[0] }];
  if (/^UPDATE user_trials SET ends_at = GREATEST\(ends_at, NOW\(\)\) \+ \(\$2 \|\| ' days'\)::interval WHERE user_id = \$1 RETURNING ends_at, started_at$/.test(sql)) {
    const r = db.trials.get(Number(p[0])); if (!r) return [];
    r.ends_at = new Date(Math.max(ts(r.ends_at), ts(db.now)) + Number(p[1]) * DAY);
    return [{ ends_at: r.ends_at, started_at: r.started_at }];
  }
  if (/^SELECT (\*|started_at|started_at, ends_at) FROM user_trials WHERE user_id = \$1$/.test(sql)) {
    const r = db.trials.get(Number(p[0])); return r ? [{ ...r }] : [];
  }
  if (/^SELECT device_id FROM user_devices WHERE user_id = \$1 ORDER BY last_seen DESC LIMIT 1$/.test(sql)) {
    return db.userDevices.filter((d) => d.user_id === Number(p[0])).sort((a, b) => ts(b.last_seen) - ts(a.last_seen)).slice(0, 1)
      .map((d) => ({ device_id: d.device_id }));
  }
  if (/^SELECT first_user_id FROM trial_devices WHERE device_id = \$1$/.test(sql)) {
    const r = db.trialDevices.get(p[0]); return r ? [{ first_user_id: r.first_user_id }] : [];
  }
  if (/^INSERT INTO user_trials /.test(sql)) {
    const uid = Number(p[0]);
    if (!db.trials.has(uid)) db.trials.set(uid, { user_id: uid, device_id: p[1], started_at: new Date(db.now), ends_at: new Date(ts(db.now) + 30 * DAY) });
    return [];
  }
  if (/^INSERT INTO trial_devices /.test(sql)) {
    if (!db.trialDevices.has(p[0])) db.trialDevices.set(p[0], { device_id: p[0], first_user_id: Number(p[1]) });
    return [];
  }
  if (/FROM user_subscriptions WHERE user_id = \$1 AND status = 'active' AND period_end > NOW\(\) AND \(store IS NULL OR environment = \$2\)/.test(sql)) {
    return db.subs.filter((s) => s.user_id === Number(p[0]) && s.status === 'active' && ts(s.period_end) > ts(db.now)
      && (s.store == null || s.environment === p[1])).slice(0, 1);
  }
  if (/^SELECT environment FROM user_subscriptions /.test(sql)) return [];
  if ((m = /^SELECT COUNT\(\*\)::int AS n FROM usage_ledger WHERE user_id = \$1 AND kind = \$2 AND source = \$3 AND created_at >= \$4$/.exec(sql))) {
    return [{ n: db.ledger.filter((r) => r.user_id === Number(p[0]) && r.kind === p[1] && r.source === p[2] && ts(r.created_at) >= ts(p[3])).length }];
  }
  if (/^SELECT MIN\(created_at\) AS first FROM usage_ledger WHERE user_id = \$1 AND kind = \$2 AND source = 'trial' AND created_at >= \$3$/.test(sql)) {
    const hit = db.ledger.filter((r) => r.user_id === Number(p[0]) && r.kind === p[1] && r.source === 'trial' && ts(r.created_at) >= ts(p[2]))
      .map((r) => ts(r.created_at));
    return [{ first: hit.length ? new Date(Math.min(...hit)) : null }];
  }
  if (/^SELECT COUNT\(\*\)::int AS n FROM usage_ledger WHERE kind = \$1 AND source = 'trial' AND created_at >= \$2$/.test(sql)) {
    if (db.globalFree != null) return [{ n: db.globalFree }];
    return [{ n: db.ledger.filter((r) => r.kind === p[0] && r.source === 'trial' && ts(r.created_at) >= ts(p[1])).length }];
  }
  if (/^SELECT COALESCE\(SUM\(amount\), 0\)::int AS n FROM quota_grants WHERE user_id = \$1 AND kind = \$2 AND created_at >= \$3$/.test(sql)) {
    return [{ n: db.grants.filter((g) => g.user_id === Number(p[0]) && g.kind === p[1] && ts(g.created_at) >= ts(p[2])).reduce((a, g) => a + g.amount, 0) }];
  }
  if (/^INSERT INTO usage_ledger /.test(sql)) {
    const id = db.nextId++;
    const detail = (() => { try { return JSON.parse(p[4]); } catch { return null; } })();
    db.ledger.push({ id, user_id: Number(p[0]), kind: p[1], source: p[2], plan_key: p[3], detail, created_at: new Date(db.now) });
    return [{ id }];
  }
  // getUsage — the Usage screen's list, newest first.
  if (/^SELECT id, kind, source, plan_key, detail, created_at FROM usage_ledger WHERE user_id = \$1 ORDER BY created_at DESC LIMIT \$2$/.test(sql)) {
    return db.ledger.filter((r) => r.user_id === Number(p[0])).sort((a, b) => ts(b.created_at) - ts(a.created_at)).slice(0, Number(p[1]))
      .map((r) => ({ id: r.id, kind: r.kind, source: r.source, plan_key: r.plan_key, detail: r.detail || {}, created_at: r.created_at }));
  }
  if (/^INSERT INTO quota_grants /.test(sql)) {
    if (db.grants.some((g) => g.user_id === Number(p[0]) && g.idem_key === p[4])) return [];
    const id = db.nextId++;
    db.grants.push({ id, user_id: Number(p[0]), kind: p[1], amount: Number(p[2]), idem_key: p[4], created_at: new Date(db.now) });
    return [{ id }];
  }
  if (/^SELECT credits_remaining FROM user_credits WHERE user_id = \?$/.test(sql)) {
    return db.credits.has(Number(p[0])) ? [{ credits_remaining: db.credits.get(Number(p[0])) }] : [];
  }
  if (/^SELECT credits_remaining, credits_total, expiry_date, last_purchase_date FROM user_credits WHERE user_id = \$1 ORDER BY id DESC LIMIT 1$/.test(sql)) {
    return db.credits.has(Number(p[0])) ? [{ credits_remaining: db.credits.get(Number(p[0])), credits_total: 0 }] : [];
  }
  if (/^SELECT kind, COUNT\(\*\) FILTER \(WHERE source = \$2 AND created_at >= \$3\)::int AS used_in_window/.test(sql)) {
    const rows = db.ledger.filter((r) => r.user_id === Number(p[0]) && (r.kind === 'cover_letter' || r.kind === 'resume'));
    return ['cover_letter', 'resume'].map((k) => {
      const ofKind = rows.filter((r) => r.kind === k);
      return ofKind.length ? {
        kind: k,
        used_in_window: ofKind.filter((r) => r.source === p[1] && ts(r.created_at) >= ts(p[2])).length,
        used_any_pool: ofKind.filter((r) => ts(r.created_at) >= ts(p[2])).length,
        used_lifetime: ofKind.length, last_used: null,
      } : null;
    }).filter(Boolean);
  }
  if (/^SELECT t\.first_user_id AS owner FROM user_devices d JOIN trial_devices t ON t\.device_id = d\.device_id WHERE d\.user_id = \$1 AND t\.first_user_id IS NOT NULL AND t\.first_user_id <> \$1 ORDER BY d\.last_seen DESC LIMIT 1$/.test(sql)) {
    const hit = db.userDevices.filter((d) => d.user_id === Number(p[0])).sort((a, b) => ts(b.last_seen) - ts(a.last_seen))
      .map((d) => db.trialDevices.get(d.device_id)).find((t) => t && t.first_user_id != null && t.first_user_id !== Number(p[0]));
    return hit ? [{ owner: hit.first_user_id }] : [];
  }
  db.unhandled.push(sql.slice(0, 160));
  throw new Error('fake db: unhandled SQL: ' + sql.slice(0, 120));
}
const fake = {
  query: async (sql, p) => exec(sql, p),
  get: async (sql, p) => { const r = exec(sql, p); return r && r.length ? r[0] : undefined; },
  run: async (sql, p) => { exec(sql, p); return { changes: 1 }; },
  withTransaction: async (fn) => fn({ query: async (sql, p) => exec(sql, p) }),
  getDbType: () => 'postgres',
};
const dbPath = require.resolve(path.join(ROOT, 'db-config.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fake };
// Any credit movement must be impossible — make the charge function a tripwire if anyone still calls it.
const ecPath = require.resolve(path.join(ROOT, 'server/services/eventCosts.js'));
let chargeCalls = 0;
require.cache[ecPath] = { id: ecPath, filename: ecPath, loaded: true, exports: {
  getEventCost: async () => 2, chargeCredits: async () => { chargeCalls++; return { charged: true, cost: 2 }; },
  refundCredits: async () => {}, CATALOG: [], DEFAULT: {}, DIRECTION: {}, getPublicCosts: async () => ({}), invalidate() {},
} };

const ent = require(path.join(ROOT, 'server/services/entitlements.js'));
const quotaGrants = require(path.join(ROOT, 'server/services/quotaGrants.js'));

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────
const req = (deviceId) => ({ headers: deviceId ? { 'x-device-id': deviceId } : {}, socket: { remoteAddress: '10.0.0.1' } });
const seedTrial = (uid, startedAt, deviceId = null) => db.trials.set(uid, { user_id: uid, device_id: deviceId, started_at: new Date(startedAt), ends_at: new Date(ts(startedAt) + 30 * DAY) });
const seedUse = (uid, kind, source, at, times = 1) => { for (let i = 0; i < times; i++) db.ledger.push({ id: db.nextId++, user_id: uid, kind, source, plan_key: null, created_at: new Date(at) }); };
const seedSub = (uid, planKey, periodStart) => {
  db.subs = db.subs.filter((s) => s.user_id !== uid);
  db.subs.push({ user_id: uid, plan_key: planKey, status: 'active', source: 'admin', store: null, environment: null,
    period_start: new Date(periodStart), period_end: new Date(ts(db.now) + 20 * DAY) });
};
const CUTOVER_ISO = '2026-09-13T00:00:00.000Z';

(async () => {
  const DAY_AGO_ISO = new Date(ts(db.now) - DAY).toISOString();   // '2026-09-13T12:00:00.000Z' — the window's floor
  console.log('── constants: the daily Free plan, the PLANS ──');
  ok('FREE = 10 resumes + 10 letters a day (daily, not one time, no downloads)',
    ent.FREE.resumes === 10 && ent.FREE.letters === 10 && ent.FREE.daily === true && ent.FREE.oneTime === false && ent.FREE.downloads === 0, ent.FREE);
  ok('TRIAL is still the same object (quotaGrants/adminUserOps read it)', ent.TRIAL === ent.FREE);
  ok('FREE_CUTOVER is 2026-09-13T00:00:00Z', ent.FREE_CUTOVER === CUTOVER_ISO, ent.FREE_CUTOVER);
  const want = { starter: [4.99, 6, 10], plus: [9.99, 15, 25], pro: [14.99, 25, 50], power: [24.99, 40, 100], max: [49.99, 100, 500] };
  for (const [k, [price, r, l]] of Object.entries(want)) {
    const p = ent.planByKey(k);
    ok(`${k}: $${price} → ${r} resumes / ${l} letters`, p && p.priceUsd === price && p.resumes === r && p.letters === l, p);
  }
  ok('downloads unchanged (20/40/60/100/200)', ent.PLANS.map((p) => p.downloads).join() === '20,40,60,100,200');
  ok('freeWindowEnd is null (the window rolls, it has no end)', ent.freeWindowEnd('2026-08-01T00:00:00Z') === null && ent.freeWindowEnd() === null);
  ok('freeWindowStart: an old account counts the last 24 hours', ent.freeWindowStart('2026-08-01T00:00:00Z').toISOString() === DAY_AGO_ISO);
  ok('freeWindowStart: an account younger than a day counts from signup', ent.freeWindowStart('2026-09-14T08:00:00Z').toISOString() === '2026-09-14T08:00:00.000Z');
  ok('freeWindowStart: ROLLS (90 days later it is 90 days later)', (() => { const real = Date.now; Date.now = () => ts(db.now) + 90 * DAY; try { return ent.freeWindowStart('2026-08-01T00:00:00Z').toISOString() === new Date(ts(db.now) + 89 * DAY).toISOString(); } finally { Date.now = real; } })());
  ok('freeWindowStart fails CLOSED on garbage (now − 24 h, the earliest the window can start — never "now")', ent.freeWindowStart('nope').toISOString() === DAY_AGO_ISO && ent.freeWindowStart(null).toISOString() === DAY_AGO_ISO);
  ok('the cutover still floors the window (a clock before it counts nothing older)', ent.freeWindowStart(null, ts('2026-09-13T06:00:00Z')).toISOString() === CUTOVER_ISO);
  ok('opensInText rounds up and never promises early', ent.opensInText(new Date(ts(db.now) + 61 * 60000)) === 'in about 2 hours'
    && ent.opensInText(new Date(ts(db.now) + 59 * 60000)) === 'in about 59 minutes' && ent.opensInText(null) === 'within 24 hours');
  ok('FREE_WINDOW_MS is gone', ent.FREE_WINDOW_MS === undefined);

  console.log('── free user, 0 used → allowed via free, both kinds ──');
  {
    const r1 = await ent.canConsumeMany(1, 'resume', 1, req('dev-AAAAAAAA'));
    const r2 = await ent.canConsumeMany(1, 'cover_letter', 1, req('dev-AAAAAAAA'));
    ok('resume: allowed via free, 10 left', r1.allowed === true && r1.via === 'free' && r1.remaining === 10, r1);
    ok('cover letter: allowed via free, 10 left', r2.allowed === true && r2.via === 'free' && r2.remaining === 10, r2);
    ok('a free row was created and the device claimed by user 1', db.trials.has(1) && db.trialDevices.get('dev-AAAAAAAA').first_user_id === 1);
  }

  console.log('── usage older than 24 hours does not count ──');
  {
    seedTrial(20, '2026-08-01T00:00:00Z');
    seedUse(20, 'resume', 'trial', '2026-09-01T10:00:00Z', 5);
    seedUse(20, 'cover_letter', 'trial', '2026-09-12T23:59:59Z', 5);
    const r = await ent.canConsumeMany(20, 'resume', 1, req());
    const l = await ent.canConsumeMany(20, 'cover_letter', 3, req());
    ok('5 resumes two weeks ago → 10 left', r.allowed && r.via === 'free' && r.remaining === 10, r);
    ok('5 letters 36 hours ago → a batch of 3 fits in 10', l.allowed && l.via === 'free' && l.remaining === 10, l);
    const st = await ent.getStatus(20, req());
    ok('getStatus: via free, used 0/0, remaining 10/10', st.via === 'free' && st.used.letters === 0 && st.used.resumes === 0 && st.remaining.letters === 10 && st.remaining.resumes === 10, { via: st.via, used: st.used, remaining: st.remaining });
    ok('getStatus: trialState is the contract shape (daily, not oneTime, windowStart = 24 h ago, endsAt/renewsAt null, nothing to wait for)',
      st.trialState && st.trialState.active === true && st.trialState.oneTime === false && st.trialState.daily === true && st.trialState.windowStart === DAY_AGO_ISO
      && st.trialState.endsAt === null && st.trialState.renewsAt === null && st.trialState.used.letters === 0 && !!st.trialState.startedAt
      && st.trialState.remaining.resumes === 10 && st.trialState.nextAt.resumes === null && st.trialState.nextAt.letters === null, st.trialState);
    ok('getStatus: trial exposes letters 10, resumes 10, daily (days 1 for builds that print "every N days")',
      st.trial.letters === 10 && st.trial.resumes === 10 && st.trial.daily === true && st.trial.oneTime === false && st.trial.days === 1, st.trial);
    const bonusOld = { id: db.nextId++, user_id: 20, kind: 'resume', amount: 5, idem_key: 'old', created_at: new Date('2026-09-02T00:00:00Z') };
    db.grants.push(bonusOld);
    const r2 = await ent.canConsumeMany(20, 'resume', 1, req());
    ok('a bonus granted two weeks ago is not counted either', r2.remaining === 10, r2);
  }

  console.log('── free user with today\'s 10 used → quota_exhausted with the time the next opens, never credits (1000 on file) ──');
  {
    seedTrial(30, '2026-07-01T00:00:00Z');
    db.credits.set(30, 1000);
    seedUse(30, 'resume', 'trial', '2026-09-13T09:00:00Z', 4);         // 27 h ago: outside the day
    seedUse(30, 'resume', 'trial', '2026-09-13T13:00:00Z', 10);        // 23 h ago: the oldest counted → opens in 1 h
    seedUse(30, 'cover_letter', 'trial', '2026-09-14T09:00:00Z', 10);  // 3 h ago → opens in 21 h
    const r = await ent.canConsumeMany(30, 'resume', 1, req());
    const l = await ent.canConsumeMany(30, 'cover_letter', 1, req());
    ok('resume refused: quota_exhausted, via null (not credits)', r.allowed === false && r.via === null && r.reason === 'quota_exhausted', r);
    ok('resume message is the contract text, with when the next opens', r.message === "You've used today's 10 free resume generations. The next one opens up in about 1 hour, or start a plan in Plans & Usage to keep going now.", r.message);
    ok('…and the refusal carries that instant (nextFreeAt)', r.nextFreeAt === '2026-09-14T13:00:00.000Z', r.nextFreeAt);
    ok('letter refused: quota_exhausted, via null (not credits)', l.allowed === false && l.via === null && l.reason === 'quota_exhausted', l);
    ok('letter message is the contract text', l.message === "You've used today's 10 free cover letters. The next one opens up in about 21 hours, or start a plan in Plans & Usage to keep going now.", l.message);
    const before = db.ledger.length;
    const c = await ent.consumeOnSuccess(30, 'resume', { screen: 'harness' }, req());
    ok("consumeOnSuccess → via 'none', charge null, ledgerId null", c.via === 'none' && c.charge === null && c.ledgerId === null, c);
    ok('…and it wrote no ledger row', db.ledger.length === before);
    ok('no statement ever wrote to user_credits, chargeCredits never called', db.creditWrites.length === 0 && chargeCalls === 0, { creditWrites: db.creditWrites, chargeCalls });
    ok('the 1000 credits are untouched', db.credits.get(30) === 1000);
    const st = await ent.getStatus(30, req());
    ok('getStatus: remaining 0/0, used 10/10, legacyCredits still reported (display)', st.remaining.letters === 0 && st.remaining.resumes === 0 && st.used.letters === 10 && st.used.resumes === 10 && st.legacyCredits === 1000, { remaining: st.remaining, used: st.used, legacyCredits: st.legacyCredits });
    ok('getStatus: trialState says when each opens', st.trialState.nextAt.resumes === '2026-09-14T13:00:00.000Z' && st.trialState.nextAt.letters === '2026-09-15T09:00:00.000Z', st.trialState.nextAt);
    // partial: 9 letters used, a batch of 3 asks for more than is left
    seedTrial(31, '2026-09-14T00:00:00Z'); seedUse(31, 'cover_letter', 'trial', '2026-09-14T01:00:00Z', 9);
    const b = await ent.canConsumeMany(31, 'cover_letter', 3, req());
    ok('a batch bigger than what is left says what is left (singular)', !b.allowed && b.message === 'You have 1 free cover letter left today, not enough for 3. More open up in about 13 hours, or start a plan in Plans & Usage.', b.message);
    // a bonus granted today adds on top
    await quotaGrants.grantQuota(30, 'resume', 1, 'harness-bonus', { source: 'harness' });
    const r3 = await ent.canConsumeMany(30, 'resume', 1, req());
    ok('a bonus granted today adds on top (1 left)', r3.allowed && r3.via === 'free' && r3.remaining === 1, r3);
    const c2 = await ent.consumeOnSuccess(30, 'resume', { screen: 'harness' }, req());
    ok("consuming it → via 'trial' with a ledger row", c2.via === 'trial' && typeof c2.ledgerId === 'number' && db.ledger.some((x) => x.id === c2.ledgerId && x.source === 'trial'), c2);
    const r4 = await ent.canConsumeMany(30, 'resume', 1, req());
    ok('…and then it is exhausted again', !r4.allowed && r4.via === null, r4);
    // ⚠️ THE POINT OF THE CHANGE: it comes back. 25 hours later every one of those has left the window.
    const saved = db.now;
    db.now = new Date(ts(saved) + 25 * 3600000);
    const back = await ent.canConsumeMany(30, 'resume', 1, req());
    const backL = await ent.canConsumeMany(30, 'cover_letter', 1, req());
    ok('⚠️ a day later the free ones are back: 10 resumes (yesterday\'s bonus gone with its day)', back.allowed && back.via === 'free' && back.remaining === 10, back);
    ok('…and 10 letters', backL.allowed && backL.remaining === 10, backL);
    db.now = new Date(ts(saved) + 2 * 3600000);   // two hours on: the 13:00 batch has left, the bonus-paid one has not
    const part = await ent.canConsumeMany(30, 'resume', 1, req());
    ok('…and it rolls unit by unit, not at midnight (2 h on: the ten from 23 h ago have left, today\'s one has not)', part.allowed && part.remaining === 10, part);
    db.now = saved;
  }

  console.log('── plan users: the new allowances, and no credits after them ──');
  {
    const uid = 40;
    db.credits.set(uid, 5000);
    for (const [k, [, r, l]] of Object.entries(want)) {
      seedSub(uid, k, '2026-09-10T00:00:00Z');
      const gr = await ent.canConsumeMany(uid, 'resume', 1, req());
      const gl = await ent.canConsumeMany(uid, 'cover_letter', 1, req());
      ok(`${k}: plan lane, ${r} resumes / ${l} letters left`, gr.via === 'plan' && gr.remaining === r && gl.via === 'plan' && gl.remaining === l, { gr, gl });
    }
    seedSub(uid, 'starter', '2026-09-10T00:00:00Z');
    seedUse(uid, 'resume', 'plan', '2026-09-11T00:00:00Z', 6);
    seedUse(uid, 'cover_letter', 'plan', '2026-09-11T00:00:00Z', 20);    // old allowance was 30: already over the new 10
    const r = await ent.canConsumeMany(uid, 'resume', 1, req());
    const l = await ent.canConsumeMany(uid, 'cover_letter', 1, req());
    // ⚠️ 2026-10-29: a spent plan is NOT a refusal any more — the free day is every subscriber's floor (a free user
    // gets 10 a day; refusing a Starter subscriber at 6 a month would make paying the worse deal).
    ok('⚠️ starter with 6 resumes used → the free day takes over (via free, 10 left), never credits', r.allowed && r.via === 'free' && r.remaining === 10, r);
    ok('…letters too, even over a cut allowance (clamps, no crash)', l.allowed && l.via === 'free' && l.remaining === 10, l);
    const c = await ent.consumeOnSuccess(uid, 'cover_letter', {}, req());
    ok("plan spent: consumeOnSuccess → 'trial' (the free day's row, plan_key null), no credits",
      c.via === 'trial' && db.ledger.some((x) => x.id === c.ledgerId && x.source === 'trial' && x.plan_key === null)
      && chargeCalls === 0 && db.creditWrites.length === 0 && db.credits.get(uid) === 5000, c);
    seedUse(uid, 'resume', 'trial', '2026-09-14T12:00:00Z', 10);   // the free row was opened at db.now: count from there
    const both = await ent.canConsumeMany(uid, 'resume', 1, req());
    ok('plan AND free day spent → refused with the subscriber\'s sentence, never "start a plan"', !both.allowed && both.via === null && both.reason === 'quota_exhausted'
      && both.message === "You've used this month's resume generations in your plan and today's 10 daily ones. The next daily one opens up in about 24 hours, or upgrade in Plans & Usage.", both.message);
    ok('⚠️ …and that sentence never says "free" (builds before 4.8 test /free/ first and would call a payer\'s allowance the free one)', !/\bfree\b/i.test(both.message));
    const stSpent = await ent.getStatus(uid, req());
    ok('getStatus for a spent subscriber: remaining stays the plan\'s 0, remainingNow is what Generate can still do',
      stSpent.remaining.resumes === 0 && stSpent.remainingNow && stSpent.remainingNow.resumes === 0 && stSpent.remainingNow.letters === 9 && stSpent.freeFloor === true,
      { remaining: stSpent.remaining, remainingNow: stSpent.remainingNow });
    const none = await ent.consumeOnSuccess(uid, 'resume', {}, req());
    ok("…and consumeOnSuccess → 'none', nothing written", none.via === 'none' && none.ledgerId === null, none);
    // A batch the plan starts and the free day finishes: allowed, and charged plan first, unit by unit.
    seedSub(41, 'starter', '2026-09-10T00:00:00Z');
    seedUse(41, 'resume', 'plan', '2026-09-11T00:00:00Z', 4);
    const batch = await ent.canConsumeMany(41, 'resume', 5, req());
    ok('a batch of 5 with 2 left on the plan → allowed (2 plan + 3 free), first unit the plan\'s', batch.allowed && batch.via === 'plan' && batch.remaining === 12, batch);
    const vias = [];
    for (let i = 0; i < 5; i++) vias.push((await ent.consumeOnSuccess(41, 'resume', {}, req())).via);
    ok('…charged plan, plan, then the free day', vias.join() === 'plan,plan,trial,trial,trial', vias);
    const tooBig = await ent.canConsumeMany(41, 'resume', 8, req());
    ok('…and a batch bigger than what is left is refused with what is left', !tooBig.allowed && /^You have 7 resume generations left right now, not enough for 8\./.test(tooBig.message), tooBig.message);
    // ⚠️ A subscriber's bonus is the PLAN's — never counted a second time in the free day.
    seedSub(42, 'starter', '2026-09-10T00:00:00Z');
    seedUse(42, 'resume', 'plan', '2026-09-11T00:00:00Z', 6);
    await quotaGrants.grantQuota(42, 'resume', 1, 'sub-bonus-42', { source: 'harness' });
    const sb = await ent.canConsumeMany(42, 'resume', 1, req());
    ok('a subscriber\'s grant raises the plan (1 left on it), not the plan AND the free day', sb.allowed && sb.via === 'plan' && sb.remaining === 1, sb);
    await ent.consumeOnSuccess(42, 'resume', {}, req());
    const sb2 = await ent.usageFor(42, 'resume', req());
    ok('…and once it is spent the free day is the plain 10, not 11', sb2 && sb2.pool === 'free' && sb2.allowance === 10 && sb2.remaining === 10, sb2);
    // A batch the free day can never hold is not told "more open up".
    seedTrial(43, '2026-07-01T00:00:00Z');
    const big = await ent.canConsumeMany(43, 'cover_letter', 12, req());
    ok('a batch of 12 on a 10-a-day plan → refused without promising more will open', !big.allowed
      && big.message === 'The free plan makes up to 10 cover letters a day, and you have 10 left today — not enough for 12 at once. Start a plan in Plans & Usage to do more.', big.message);
    // ⚠️ THE BREAKER: an attack across many throwaway accounts stops at the global cap; plans never notice.
    db.globalFree = 5000;
    const paused = await ent.canConsumeMany(43, 'resume', 1, req());
    ok('⚠️ global free volume over the cap → the free lane pauses (refused, paused:true, nothing promised)', !paused.allowed && paused.paused === true
      && paused.message === 'Free resume generations are paused for a few hours because of very high demand. A plan or a one-time pass still works now.', paused);
    seedSub(44, 'plus', '2026-09-10T00:00:00Z');
    const planStill = await ent.canConsumeMany(44, 'resume', 1, req());
    ok('…a subscriber with plan left is untouched by it', planStill.allowed && planStill.via === 'plan', planStill);
    db.globalFree = null;
    const back2 = await ent.canConsumeMany(43, 'resume', 1, req());
    ok('…and below the cap the free lane is back', back2.allowed && back2.via === 'free', back2);
    const st = await ent.getStatus(uid, req());
    ok('getStatus: via plan, the PLAN\'s remaining (clamped at 0) — the free floor never overwrites it', st.via === 'plan' && st.remaining.letters === 0 && st.remaining.resumes === 0, { via: st.via, remaining: st.remaining });
    const dl = await ent.canConsumeMany(uid, 'download', 1, req());
    ok('downloads still answered by the plan (20 left, no credit lane)', dl.allowed && dl.via === 'plan' && dl.remaining === 20, dl);
    const dFree = await ent.canConsumeMany(20, 'download', 1, req());
    ok('free user download: refused with the unchanged downloads message', !dFree.allowed && dFree.message === 'Downloads are on paid plans. You can buy a single download instead.', dFree);
  }

  console.log('── one free allowance per device ──');
  {
    // user 1 claimed dev-AAAAAAAA above
    const r = await ent.canConsumeMany(50, 'resume', 1, req('dev-AAAAAAAA'));
    ok('a second, NEW account on the claimed device is refused', !r.allowed && r.via === null && r.blocked === 'device_trial_used', r);
    ok('…with the device message, not "you used your 3"', r.message === 'The free plan on this device was already used by another account. Start a plan in Plans & Usage to keep going.', r.message);
    ok('…and no free row was created for it', !db.trials.has(50));
    const st = await ent.getStatus(50, req('dev-AAAAAAAA'));
    ok("getStatus: trialState is exactly { active:false, blocked:'device_trial_used' }", JSON.stringify(st.trialState) === JSON.stringify({ active: false, blocked: 'device_trial_used' }) && st.via === null && st.remaining.resumes === 0, st.trialState);
    const c = await ent.consumeOnSuccess(50, 'resume', {}, req('dev-AAAAAAAA'));
    ok("consumeOnSuccess on the blocked account → 'none', nothing written", c.via === 'none' && !db.ledger.some((x) => x.user_id === 50), c);
    const own = await ent.canConsumeMany(1, 'cover_letter', 1, req('dev-AAAAAAAA'));
    ok('the account that claimed the device keeps its allowance', own.allowed && own.via === 'free', own);
    // header-less call (Home's gate/build send no x-device-id): falls back to the last device this account reported
    db.userDevices.push({ user_id: 51, device_id: 'dev-OLDPHONE', last_seen: new Date('2026-09-01T00:00:00Z') });
    db.userDevices.push({ user_id: 51, device_id: 'dev-AAAAAAAA', last_seen: new Date('2026-09-14T11:00:00Z') });
    const h = await ent.canConsumeMany(51, 'resume', 1, req());
    ok('a header-less call from an account whose last-reported device is claimed is refused', !h.allowed && h.blocked === 'device_trial_used' && !db.trials.has(51), h);
    const hDev = await ent.canConsumeMany(52, 'resume', 1, req());
    ok('no device on record at all (old builds) → one allowance per user', hDev.allowed && hDev.via === 'free' && db.trials.has(52), hDev);
    ok('…and a header-less row claims no device', ![...db.trialDevices.values()].some((d) => d.first_user_id === 52));
    const d2 = await ent.canConsumeMany(53, 'resume', 1, req('dev-BBBBBBBB'));
    ok('a new account on an unclaimed device gets its own allowance and claims it', d2.allowed && db.trialDevices.get('dev-BBBBBBBB').first_user_id === 53, d2);
    // grandfathered: a second account that got its row while the rule was off keeps it
    seedTrial(54, '2026-08-20T00:00:00Z', 'dev-AAAAAAAA');
    const g = await ent.canConsumeMany(54, 'resume', 1, req('dev-AAAAAAAA'));
    ok('an EXISTING second account on the claimed device keeps its own (only row creation is gated)', g.allowed && g.via === 'free' && g.remaining === 10, g);
  }

  // ⚠️ A PLAN BEATS A CLAIMED DEVICE (2026-09-20, the owner's own report on build 210).
  // He tapped Build on his new account (user 618) on a phone whose free allowance belonged to his older account,
  // was refused with the device sentence, subscribed — and the app went on showing that refusal. The server was
  // never the problem and this block is what says so out loud: canConsumeMany reads the subscription FIRST, so the
  // device branch is unreachable for a subscriber, and no free row is created for them either. The clients must
  // therefore read the answer PLAN-FIRST, which is exactly what getStatus below makes easy to get wrong — it
  // reports the plan and the blocked free allowance side by side, both true.
  console.log('── a plan beats a claimed device ──');
  {
    // user 1 claimed dev-AAAAAAAA at the top of this file; 55 is a brand-new account on that same phone.
    seedSub(55, 'plus', '2026-09-14T00:00:00Z');
    const r = await ent.canConsumeMany(55, 'resume', 1, req('dev-AAAAAAAA'));
    const l = await ent.canConsumeMany(55, 'cover_letter', 1, req('dev-AAAAAAAA'));
    ok('a subscriber on a claimed device may build a resume (via plan, never device_trial_used)',
      r.allowed && r.via === 'plan' && r.remaining === 15 && r.blocked === undefined, r);
    ok('…and write a cover letter', l.allowed && l.via === 'plan' && l.remaining === 25 && l.blocked === undefined, l);
    ok('…and no free row was created for them (the free lane is never even asked)', !db.trials.has(55));
    const c = await ent.consumeOnSuccess(55, 'resume', {}, req('dev-AAAAAAAA'));
    ok("…and the charge is the PLAN's", c.via === 'plan' && db.ledger.some((x) => x.user_id === 55 && x.source === 'plan'), c);
    const st = await ent.getStatus(55, req('dev-AAAAAAAA'));
    // ⚠️ A KNOWN plan short-circuits getStatus before the free lane is read at all, so trialState is ABSENT rather
    // than blocked. The clients still have to be plan-first, because a subscription whose plan_key this build does
    // not know falls past that return and then reports both — and because `blocked` is a fact about the free
    // allowance, never about whether this user may generate.
    ok('getStatus for a subscriber reports the plan and no free-allowance state at all (the early return)',
      !!st.subscription && st.subscription.planKey === 'plus' && st.via === 'plan' && st.trialState === undefined,
      { sub: st.subscription, via: st.via, trialState: st.trialState });
    ok('…and the numbers on that answer are the plan\'s, not the free allowance\'s', st.remaining.resumes === 14 && st.remaining.letters === 25, st.remaining);
    // The same account once the plan is gone: the refusal it started with, unchanged.
    db.subs = db.subs.filter((s) => s.user_id !== 55);
    const gone = await ent.getStatus(55, req('dev-AAAAAAAA'));
    ok('…with no plan, THAT is when the device block is reported (and it is the only thing that changed)',
      !gone.subscription && gone.via === null
      && JSON.stringify(gone.trialState) === JSON.stringify({ active: false, blocked: 'device_trial_used' }), gone.trialState);
    const after = await ent.canConsumeMany(55, 'resume', 1, req('dev-AAAAAAAA'));
    ok('…and with the plan gone the device refusal is back, word for word (the message is still right for '
      + 'someone who genuinely has no plan)',
      !after.allowed && after.blocked === 'device_trial_used'
      && after.message === 'The free plan on this device was already used by another account. Start a plan in Plans & Usage to keep going.', after);
    // A subscriber whose PLAN is spent, on a device whose free day belongs to someone else: the plan's sentence,
    // and no `blocked` — the clients turn that into the device message, which is not what a payer ran out of.
    seedSub(56, 'starter', '2026-09-10T00:00:00Z');
    seedUse(56, 'resume', 'plan', '2026-09-11T00:00:00Z', 6);
    const spent = await ent.canConsumeMany(56, 'resume', 1, req('dev-AAAAAAAA'));
    ok('a spent plan on a claimed device → the plan\'s refusal, never device_trial_used',
      !spent.allowed && spent.blocked === undefined && spent.message === "You've used all the resume generations in your plan this month. Upgrade in Plans & Usage to continue.", spent);
    const su = await ent.usageFor(56, 'resume', req('dev-AAAAAAAA'));
    ok('…and usageFor shows the plan at 0, not a device block', su && su.pool === 'plan' && su.remaining === 0 && !su.blocked, su);
  }

  console.log('── quotaGrants.ensureCountableWindow ──');
  {
    ok('a free user with a row → trial (no "expired" case any more)', (await quotaGrants.ensureCountableWindow(20, 'k')).via === 'trial');
    const b = await quotaGrants.ensureCountableWindow(51, 'k');
    ok('no row + last-reported device claimed → no window, blocked, nothing created', b.via === null && b.blocked === 'device_trial_used' && !db.trials.has(51), b);
    const o = await quotaGrants.ensureCountableWindow(60, 'k');
    ok('no row + no device → the Free row is opened', o.via === 'trial' && o.opened === 'started_trial' && db.trials.has(60), o);
    ok('a plan user → plan', (await quotaGrants.ensureCountableWindow(40, 'k')).via === 'plan');
    seedTrial(61, '2026-08-01T00:00:00Z');
    seedUse(61, 'cover_letter', 'trial', '2026-09-05T00:00:00Z', 4);
    seedUse(61, 'cover_letter', 'trial', '2026-09-14T05:00:00Z', 1);
    const e = await quotaGrants.extendTrial(61, 5, 'harness-extend', {});
    ok('extendTrial (bookkeeping) counts letters in today\'s window: 10 − 1 = 9', e.extended && e.lettersStillAvailable === 9 && e.resumesStillAvailable === 10, e);
  }

  console.log('── adminUserOps: read-only free state ──');
  let adminOps = null;
  try { adminOps = require(path.join(ROOT, 'server/services/adminUserOps.js')); } catch (e) { console.log('  (adminUserOps not loadable here: ' + e.message + ')'); }
  if (adminOps && typeof adminOps.planStateOf === 'function') {
    const p = await adminOps.planStateOf(30);
    ok('planStateOf(free): window_start = 24 h ago, window_end + window_days_left null', p.status === 'free' && p.window_start === DAY_AGO_ISO && p.window_end === null && p.window_days_left === null, { status: p.status, ws: p.window_start, we: p.window_end, wd: p.window_days_left });
    ok('planStateOf(free): base 10 per kind', p.quotas.every((q) => q.base === 10), p.quotas.map((q) => q.base));
    const rowsBefore = db.trials.size;
    const blocked = await adminOps.planStateOf(51);
    ok('planStateOf(no row, device claimed): a device_trial_used caveat, and nothing created', blocked.status === 'never_started' && blocked.caveats.some((c) => /device_trial_used/.test(c)) && db.trials.size === rowsBefore, blocked.caveats);
  } else console.log('  (planStateOf not exported — skipped)');
  // quotaStateOf is not exported: compile the REAL file in memory with one extra export line (repo untouched).
  if (adminOps && typeof adminOps.quotaStateOf !== 'function') {
    const Module = require('module');
    const file = path.join(ROOT, 'server/services/adminUserOps.js');
    const m = new Module(file, module); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
    m._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports.quotaStateOf = quotaStateOf;', file);
    adminOps = m.exports;
  }
  if (adminOps && typeof adminOps.quotaStateOf === 'function') {
    const q = await adminOps.quotaStateOf(20);
    ok('quotaStateOf(free): trialDaysLeft null, 10/10 left', q.trialDaysLeft === null && q.lettersLeft === 10 && q.resumesLeft === 10 && q.via === 'trial', q);
  } else if (adminOps && typeof adminOps.buildUserState === 'function') {
    console.log('  (quotaStateOf not exported — checked through the source instead)');
    const src = fs.readFileSync(path.join(ROOT, 'server/services/adminUserOps.js'), 'utf8');
    const body = src.slice(src.indexOf('async function quotaStateOf'), src.indexOf('async function planStateOf'));
    ok('quotaStateOf reports trialDaysLeft: null for the Free plan and no longer reads ends_at', /trialDaysLeft: null,\n\s+lettersLeft/.test(body) && !/ends_at/.test(body.replace(/\/\/[^\n]*/g, '')));
  }

  console.log('── lifecycle nudges: no days, no trial copy ──');
  {
    const life = require(path.join(ROOT, 'server/services/lifecycleNudges.js'));
    const te = life.NUDGES.find((n) => n.key === 'nudge_trial_ending');
    ok('nudge_trial_ending kept (switch + log rows resolve) but carries no incentive', te && !te.incentive);
    ok('no nudge grants trial_days any more', life.NUDGES.every((n) => !n.incentive || n.incentive.kind !== 'trial_days'));
    const src = fs.readFileSync(path.join(ROOT, 'server/services/lifecycleNudges.js'), 'utf8').replace(/^\s*(\/\/|\*)[^\n]*$/gm, '');
    ok('no live copy promising days or "to your trial"', !/to your trial|more day|trial just got longer|5 free cover letters|every 30 days/.test(src));
  }

  console.log('── ⚠️ usageFor (Home\'s confirm sheet): THE SAME NUMBERS canConsumeMany ENFORCES, and never a write ──');
  {
    // A sheet that says "1 left" while the gate refuses (or "0 left" while it would allow) is the app quoting one
    // allowance and billing another. Every case asks both, with the same request, and compares.
    const same = async (label, uid, kind, r, extra) => {
      const ledgerBefore = db.ledger.length;
      const u = await ent.usageFor(uid, kind, r);
      const g = await ent.canConsumeMany(uid, kind, 1, r);
      const gRemaining = g.allowed ? g.remaining : 0;
      ok(`${label}: remaining ${u && u.remaining} === the gate's (${gRemaining}), pool matches via`,
        !!u && u.kind === kind && u.remaining === gRemaining && (g.allowed ? u.pool === g.via : true)
        && (g.allowed === (u.remaining >= 1)) && db.ledger.length === ledgerBefore && (!extra || extra(u, g)), { u, g });
      return u;
    };
    // a brand-new free user on an unclaimed device (usageFor first: it must not change what the gate then says)
    const u70 = await same('new free user', 70, 'resume', req('dev-CCCCCCCC'),
      (u) => u.pool === 'free' && u.allowance === 10 && u.used === 0 && u.oneTime === false && u.daily === true && u.nextAt === null && u.planLabel === null);
    ok('…the Free row usageFor opened is the one the gate counts (one row, device claimed once)', db.trials.has(70) && db.trialDevices.get('dev-CCCCCCCC').first_user_id === 70, u70);
    seedUse(70, 'resume', 'trial', '2026-09-14T12:30:00Z', 1);   // after the row usageFor opened (db.now)
    await same('free user, 1 used', 70, 'resume', req('dev-CCCCCCCC'), (u) => u.remaining === 9 && u.used === 1 && u.allowance === 10 && u.nextAt === '2026-09-15T12:30:00.000Z');
    await same('usage older than a day does not count', 20, 'cover_letter', req(), (u) => u.used === 0 && u.remaining === 10);
    await same('free, exhausted after today\'s bonus (10 + 1, 11 used)', 30, 'resume', req(), (u) => u.pool === 'free' && u.remaining === 0 && u.allowance === 11 && u.used === 11);
    // plans: the plan's count and label, environment-scoped exactly like the gate
    seedSub(71, 'plus', '2026-09-10T00:00:00Z');
    seedUse(71, 'resume', 'plan', '2026-09-11T00:00:00Z', 3);
    await same('Plus, 3 of 15 used', 71, 'resume', req(), (u) => u.pool === 'plan' && u.planLabel === 'Plus' && u.allowance === 15 && u.used === 3 && u.remaining === 12 && u.oneTime === false);
    await same('Plus letters untouched', 71, 'cover_letter', req(), (u) => u.remaining === 25 && u.allowance === 25);
    await same('⚠️ a SPENT plan shows the free day, the lane that pays next (Starter, letters over a cut allowance)', 40, 'cover_letter', req(),
      (u) => u.pool === 'free' && u.remaining === 9 && u.used === 1 && u.allowance === 10);
    const beforeRows = db.trials.size;
    await same('⚠️ a subscriber is never shown the Free allowance', 71, 'resume', req('dev-DDDDDDDD'), (u) => u.pool === 'plan');
    ok('…and asking for one opened no Free row', db.trials.size === beforeRows);
    // the device another account holds: not "0 of 3" — that account never had them
    const b = await same('device already used by another account', 50, 'resume', req('dev-AAAAAAAA'),
      (u, g) => u.pool === null && u.allowance === 0 && u.blocked === 'device_trial_used' && g.blocked === 'device_trial_used' && u.daily === true);
    ok('…and no Free row was created for it', !db.trials.has(50), b);
    ok('an unknown kind → null', (await ent.usageFor(70, 'poster', req())) === null);
    const src = fs.readFileSync(path.join(ROOT, 'server/services/entitlements.js'), 'utf8');
    const body = src.slice(src.indexOf('async function usageFor'), src.indexOf('// ── the deduction'));
    ok('⚠️ usageFor is read-only: no INSERT into the ledger, no consume, exported for the gates',
      body.length > 200 && !/INSERT INTO usage_ledger|consumeOnSuccess\(/.test(body) && typeof ent.usageFor === 'function');
  }

  // ── 2026-09-19: "it was 3 cover letters, I generated 2" — the Usage screen must be able to say WHICH rows count ──
  // The ledger listed every row ever written with nothing to tell them apart (pre-cutover history, an earlier plan's
  // period, the other build's letters), and every letter lane but Home wrote the same screen. Now each row carries the
  // environment that paid (detail.env) and getUsage marks the rows the paying pool counts right now (counted).
  console.log('── the Usage screen: which rows count, and which build paid ──');
  {
    const sandbox = { headers: { 'x-store-env': 'Sandbox' }, socket: { remoteAddress: '10.0.0.1' } };
    seedTrial(80, '2026-09-13T12:00:00Z');
    const c1 = await ent.consumeOnSuccess(80, 'cover_letter', { screen: 'job_cover_letter', lane: 'letters_page' }, sandbox);
    const c2 = await ent.consumeOnSuccess(80, 'cover_letter', { screen: 'home_employer_letter' }, req());
    const c3 = await ent.consumeOnSuccess(80, 'cover_letter', { screen: 'job_cover_letter', lane: 'job_hub_letter' }, { storeEnv: 'Sandbox' });
    const d = (c) => (db.ledger.find((r) => r.id === c.ledgerId) || {}).detail || {};
    ok('⚠️ consumeOnSuccess writes the environment that PAID on the row: Sandbox for a TestFlight request, the lane kept',
      d(c1).env === 'Sandbox' && d(c1).lane === 'letters_page' && d(c1).screen === 'job_cover_letter', d(c1));
    ok('…Production for every other request (the fail-closed default), and the worker\'s carried storeEnv is honoured',
      d(c2).env === 'Production' && d(c3).env === 'Sandbox', { c2: d(c2), c3: d(c3) });
    seedUse(80, 'cover_letter', 'trial', '2026-09-10T00:00:00Z');   // before the cutover: history
    seedUse(80, 'cover_letter', 'trial', '2026-09-13T06:00:00Z');   // after the cutover, before THIS user's start
    seedUse(80, 'cover_letter', 'credits', '2026-09-12T00:00:00Z'); // the old credits pool
    const items = await ent.getUsage(80, 50, req());
    const st = await ent.getStatus(80, req());
    const counted = items.filter((i) => i.kind === 'cover_letter' && i.counted === true);
    ok('⚠️ getUsage marks exactly the rows the Free allowance counts — as many as getStatus calls used, the same three',
      counted.length === 3 && st.used.letters === 3 && counted.every((i) => [c1.ledgerId, c2.ledgerId, c3.ledgerId].includes(i.id)), { counted: counted.map((i) => i.id), used: st.used });
    ok('…and every other row is counted:false (pre-cutover, before the start, credits) — never missing the flag',
      items.length === 6 && items.filter((i) => i.counted === false).length === 3 && items.every((i) => typeof i.counted === 'boolean'), items.map((i) => [i.source, i.counted]));

    // A plan: its own period's 'plan' rows count; the free rows before it and the previous period's do not.
    seedTrial(81, '2026-09-13T00:00:00Z');
    seedSub(81, 'starter', '2026-09-14T00:00:00Z');
    seedUse(81, 'cover_letter', 'plan', '2026-09-14T06:00:00Z');
    seedUse(81, 'cover_letter', 'plan', '2026-08-20T00:00:00Z');
    seedUse(81, 'cover_letter', 'trial', '2026-09-13T08:00:00Z');
    const pl = await ent.getUsage(81, 50, req());
    ok('a subscriber: this period\'s plan rows are counted, the old period and an old free row are not', pl.filter((i) => i.counted).length === 1 && pl.find((i) => i.counted).source === 'plan'
      && ts(pl.find((i) => i.counted).createdAt) === ts('2026-09-14T06:00:00Z'), pl.map((i) => [i.source, i.createdAt, i.counted]));
    seedUse(81, 'cover_letter', 'trial', '2026-09-14T11:00:00Z');   // the free day paid this one (plan spent)
    const pl2 = await ent.getUsage(81, 50, req());
    ok('…and a free-day row from the last 24 hours IS counted (it counts against today\'s free allowance)',
      pl2.filter((i) => i.counted).length === 2 && pl2.some((i) => i.counted && i.source === 'trial'), pl2.map((i) => [i.source, i.createdAt, i.counted]));

    // The environment decides WHICH pool is paying: a TestFlight plan is not the App Store's.
    seedTrial(82, '2026-09-13T00:00:00Z');
    db.subs.push({ user_id: 82, plan_key: 'plus', status: 'active', source: 'apple', store: 'apple', environment: 'Sandbox',
      period_start: new Date('2026-09-14T00:00:00Z'), period_end: new Date(ts(db.now) + 20 * DAY) });
    seedUse(82, 'cover_letter', 'plan', '2026-09-14T09:00:00Z');
    const inSandbox = await ent.getUsage(82, 50, sandbox);
    const inProd = await ent.getUsage(82, 50, req());
    ok('⚠️ the same row is counted in the environment whose plan paid (Sandbox) and not in the other — getUsage reads the request',
      inSandbox.length === 1 && inSandbox[0].counted === true && inProd.length === 1 && inProd[0].counted === false, { inSandbox, inProd });

    // …and the Usage screen shows it: the rows that count on top, the rest under their own heading (an older server's
    // rows, with no flag at all, stay on top as they always were).
    const usageSrc = fs.readFileSync(path.join(ROOT, 'MobileApp', 'app', '(subscription)', 'usage.tsx'), 'utf8');
    ok('usage.tsx: counted rows first, counted:false under "Before your current allowance" (absent/null → shown as before)',
      /items\.filter\(\(it\) => it\.counted !== false\)/.test(usageSrc) && /Before your current allowance/.test(usageSrc)
        && /items\.filter\(\(it\) => it\.counted === false\)\.map/.test(usageSrc));
    ok('usage.tsx: each row names where it was made (its lane) and a TestFlight row says so',
      /WHERE\[String\(it\.detail\?\.lane/.test(usageSrc) && /letters_page: 'Letters page'/.test(usageSrc) && /job_hub_letter: 'Job Hub'/.test(usageSrc)
        && /letters_batch: /.test(usageSrc) && /it\.detail\?\.env === 'Sandbox'/.test(usageSrc));
  }

  console.log('── source: the credit lane is really gone ──');
  {
    const src = fs.readFileSync(path.join(ROOT, 'server/services/entitlements.js'), 'utf8');
    const code = src.replace(/^\s*(\/\/|\*)[^\n]*$/gm, '');
    ok("entitlements no longer requires eventCosts / chargeCredits / KIND_LEGACY_EVENT", !/require\('\.\/eventCosts'\)/.test(code) && !/chargeCredits|getEventCost|KIND_LEGACY_EVENT/.test(code));
    ok("no code path returns via: 'credits'", !/via: 'credits'|via = 'credits'/.test(code));
  }

  console.log('── regeneration is a generation; the score bonus needs a real score ──');
  {
    const rb = fs.readFileSync(path.join(ROOT, 'server/controllers/resumeBuilderController.js'), 'utf8')
      .replace(/^\s*(\/\/|\*)[^\n]*$/gm, '');
    ok('⚠️ no free-regeneration lane is left (it doubled the daily cap and skipped the device rule)', !/freeRegen/.test(rb) && !/reason: 'regen_limit'/.test(rb));
    ok('getResume\'s freeLimit is used + what the free day has left (old builds gate Regenerate on it)', /regen: \{ used, freeLimit: used \+ left \}/.test(rb));
    const rs = fs.readFileSync(path.join(ROOT, 'server/routes/resumeScoreRoutes.js'), 'utf8');
    const ep = rs.slice(rs.indexOf("router.post('/resume-score/enhance-pass'"));
    ok('⚠️ enhance-pass grants only for a score that is this user\'s (made-up ids minted a resume each)',
      ep.indexOf("SELECT id FROM resume_scores WHERE id = ? AND user_id = ?") > -1
      && ep.indexOf("SELECT id FROM resume_scores WHERE id = ? AND user_id = ?") < ep.indexOf('grantQuota('));
  }

  ok('the fake database saw no SQL it did not understand', db.unhandled.length === 0, db.unhandled);
  Date.now = REAL_NOW;
  console.log(`\nfree-plan entitlements: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('free-plan entitlements: CRASH', e); process.exit(2); });
