// The 2026-09-13 money model, run against the REAL entitlements.js / quotaGrants.js / adminUserOps.js /
// lifecycleNudges.js with an in-memory stand-in for db-config that understands exactly the SQL they send.
//   DATABASE_URL=postgresql://t@localhost:5432/t node server/scripts/test-free-plan-entitlements.js
//
// Why this exists: every other money test STUBS entitlements, so nothing ever checked the rules themselves.
// The product owner's decisions this file pins:
//   1. NO CREDITS FOR GENERATION — canConsumeMany/consumeOnSuccess never answer 'credits' for a resume or
//      a letter, never touch user_credits, and an exhausted allowance is quota_exhausted (→ Plans).
//   2. FREE = 3 resumes + 3 letters ONE TIME, counted from max(started_at, 2026-09-13) — it never refills,
//      pre-cutover usage/bonuses do not count, and ONE free allowance per DEVICE (device_trial_used).
//   3. PLANS: starter 6/10, plus 15/25, pro 25/50, power 40/100, max 100/500; prices and downloads unchanged.
//   A. getStatus's free block: { active, startedAt, oneTime, windowStart, endsAt:null, renewsAt:null, used }.
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
};
const norm = (s) => String(s).replace(/--[^\n]*\n/g, ' ').replace(/\s+/g, ' ').trim();
const ts = (v) => new Date(v).getTime();

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
  console.log('── constants: the one-time Free plan, the new PLANS ──');
  ok('FREE = 3 resumes + 3 letters, oneTime', ent.FREE.resumes === 3 && ent.FREE.letters === 3 && ent.FREE.oneTime === true, ent.FREE);
  ok('TRIAL is still the same object (quotaGrants/adminUserOps read it)', ent.TRIAL === ent.FREE);
  ok('FREE_CUTOVER is 2026-09-13T00:00:00Z', ent.FREE_CUTOVER === CUTOVER_ISO, ent.FREE_CUTOVER);
  const want = { starter: [4.99, 6, 10], plus: [9.99, 15, 25], pro: [14.99, 25, 50], power: [24.99, 40, 100], max: [49.99, 100, 500] };
  for (const [k, [price, r, l]] of Object.entries(want)) {
    const p = ent.planByKey(k);
    ok(`${k}: $${price} → ${r} resumes / ${l} letters`, p && p.priceUsd === price && p.resumes === r && p.letters === l, p);
  }
  ok('downloads unchanged (20/40/60/100/200)', ent.PLANS.map((p) => p.downloads).join() === '20,40,60,100,200');
  ok('freeWindowEnd is null (no refill)', ent.freeWindowEnd('2026-08-01T00:00:00Z') === null && ent.freeWindowEnd() === null);
  ok('freeWindowStart: a pre-cutover signup counts from the cutover', ent.freeWindowStart('2026-08-01T00:00:00Z').toISOString() === CUTOVER_ISO);
  ok('freeWindowStart: a post-cutover signup counts from signup', ent.freeWindowStart('2026-09-14T08:00:00Z').toISOString() === '2026-09-14T08:00:00.000Z');
  ok('freeWindowStart: never rolls (same answer 90 days later)', (() => { const real = Date.now; Date.now = () => real() + 90 * DAY; try { return ent.freeWindowStart('2026-08-01T00:00:00Z').toISOString() === CUTOVER_ISO; } finally { Date.now = real; } })());
  ok('freeWindowStart fails CLOSED on garbage (the cutover, not "now")', ent.freeWindowStart('nope').toISOString() === CUTOVER_ISO && ent.freeWindowStart(null).toISOString() === CUTOVER_ISO);
  ok('FREE_WINDOW_MS is gone', ent.FREE_WINDOW_MS === undefined);

  console.log('── free user, 0 used → allowed via free, both kinds ──');
  {
    const r1 = await ent.canConsumeMany(1, 'resume', 1, req('dev-AAAAAAAA'));
    const r2 = await ent.canConsumeMany(1, 'cover_letter', 1, req('dev-AAAAAAAA'));
    ok('resume: allowed via free, 3 left', r1.allowed === true && r1.via === 'free' && r1.remaining === 3, r1);
    ok('cover letter: allowed via free, 3 left', r2.allowed === true && r2.via === 'free' && r2.remaining === 3, r2);
    ok('a free row was created and the device claimed by user 1', db.trials.has(1) && db.trialDevices.get('dev-AAAAAAAA').first_user_id === 1);
  }

  console.log('── usage before the cutover does not count ──');
  {
    seedTrial(20, '2026-08-01T00:00:00Z');
    seedUse(20, 'resume', 'trial', '2026-09-01T10:00:00Z', 5);
    seedUse(20, 'cover_letter', 'trial', '2026-09-12T23:59:59Z', 5);
    const r = await ent.canConsumeMany(20, 'resume', 1, req());
    const l = await ent.canConsumeMany(20, 'cover_letter', 3, req());
    ok('5 pre-cutover resumes → still 3 left', r.allowed && r.via === 'free' && r.remaining === 3, r);
    ok('5 letters one second before the cutover → a batch of 3 still fits', l.allowed && l.via === 'free' && l.remaining === 3, l);
    const st = await ent.getStatus(20, req());
    ok('getStatus: via free, used 0/0, remaining 3/3', st.via === 'free' && st.used.letters === 0 && st.used.resumes === 0 && st.remaining.letters === 3 && st.remaining.resumes === 3, { via: st.via, used: st.used, remaining: st.remaining });
    ok('getStatus: trialState is the contract shape (oneTime, windowStart=cutover, endsAt/renewsAt null)',
      st.trialState && st.trialState.active === true && st.trialState.oneTime === true && st.trialState.windowStart === CUTOVER_ISO
      && st.trialState.endsAt === null && st.trialState.renewsAt === null && st.trialState.used.letters === 0 && !!st.trialState.startedAt, st.trialState);
    ok('getStatus: trial exposes letters 3, resumes 3, oneTime', st.trial.letters === 3 && st.trial.resumes === 3 && st.trial.oneTime === true, st.trial);
    const bonusOld = { id: db.nextId++, user_id: 20, kind: 'resume', amount: 5, idem_key: 'old', created_at: new Date('2026-09-02T00:00:00Z') };
    db.grants.push(bonusOld);
    const r2 = await ent.canConsumeMany(20, 'resume', 1, req());
    ok('a bonus granted before the cutover is not counted either', r2.remaining === 3, r2);
  }

  console.log('── free user with 3 used → quota_exhausted, never credits (1000 credits on file) ──');
  {
    seedTrial(30, '2026-07-01T00:00:00Z');
    db.credits.set(30, 1000);
    seedUse(30, 'resume', 'trial', '2026-09-13T09:00:00Z', 3);
    seedUse(30, 'cover_letter', 'trial', '2026-09-14T09:00:00Z', 3);
    const r = await ent.canConsumeMany(30, 'resume', 1, req());
    const l = await ent.canConsumeMany(30, 'cover_letter', 1, req());
    ok('resume refused: quota_exhausted, via null (not credits)', r.allowed === false && r.via === null && r.reason === 'quota_exhausted', r);
    ok('resume message is the contract text', r.message === "You've used your 3 free resume generations. Start a plan in Plans & Usage to keep going.", r.message);
    ok('letter refused: quota_exhausted, via null (not credits)', l.allowed === false && l.via === null && l.reason === 'quota_exhausted', l);
    ok('letter message is the contract text', l.message === "You've used your 3 free cover letters. Start a plan in Plans & Usage to keep going.", l.message);
    const before = db.ledger.length;
    const c = await ent.consumeOnSuccess(30, 'resume', { screen: 'harness' }, req());
    ok("consumeOnSuccess → via 'none', charge null, ledgerId null", c.via === 'none' && c.charge === null && c.ledgerId === null, c);
    ok('…and it wrote no ledger row', db.ledger.length === before);
    ok('no statement ever wrote to user_credits, chargeCredits never called', db.creditWrites.length === 0 && chargeCalls === 0, { creditWrites: db.creditWrites, chargeCalls });
    ok('the 1000 credits are untouched', db.credits.get(30) === 1000);
    const st = await ent.getStatus(30, req());
    ok('getStatus: remaining 0/0, used 3/3, legacyCredits still reported (display)', st.remaining.letters === 0 && st.remaining.resumes === 0 && st.used.letters === 3 && st.used.resumes === 3 && st.legacyCredits === 1000, { remaining: st.remaining, used: st.used, legacyCredits: st.legacyCredits });
    // partial: 2 letters used, a batch of 3 asks for more than is left
    seedTrial(31, '2026-09-14T00:00:00Z'); seedUse(31, 'cover_letter', 'trial', '2026-09-14T01:00:00Z', 2);
    const b = await ent.canConsumeMany(31, 'cover_letter', 3, req());
    ok('a batch bigger than what is left says what is left (singular)', !b.allowed && b.message === 'You have 1 free cover letter left, not enough for 3. Start a plan in Plans & Usage to keep going.', b.message);
    // bonus after the cutover adds on top
    await quotaGrants.grantQuota(30, 'resume', 1, 'harness-bonus', { source: 'harness' });
    const r3 = await ent.canConsumeMany(30, 'resume', 1, req());
    ok('a bonus granted after the cutover adds on top (1 left)', r3.allowed && r3.via === 'free' && r3.remaining === 1, r3);
    const c2 = await ent.consumeOnSuccess(30, 'resume', { screen: 'harness' }, req());
    ok("consuming it → via 'trial' with a ledger row", c2.via === 'trial' && typeof c2.ledgerId === 'number' && db.ledger.some((x) => x.id === c2.ledgerId && x.source === 'trial'), c2);
    const r4 = await ent.canConsumeMany(30, 'resume', 1, req());
    ok('…and then it is exhausted again', !r4.allowed && r4.via === null, r4);
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
    ok('starter with 6 resumes used → refused, via null despite 5000 credits', !r.allowed && r.via === null && r.reason === 'quota_exhausted', r);
    ok('plan resume message is the contract text', r.message === "You've used all the resume generations in your plan this month. Upgrade in Plans & Usage to continue.", r.message);
    ok('plan letter message is the contract text (usage over the new allowance clamps, no crash)', !l.allowed && l.message === "You've used all the cover letters in your plan this month. Upgrade in Plans & Usage to continue.", l.message);
    const c = await ent.consumeOnSuccess(uid, 'cover_letter', {}, req());
    ok("plan exhausted: consumeOnSuccess → 'none', no credits", c.via === 'none' && chargeCalls === 0 && db.creditWrites.length === 0 && db.credits.get(uid) === 5000, c);
    const st = await ent.getStatus(uid, req());
    ok('getStatus: via plan, remaining clamps at 0', st.via === 'plan' && st.remaining.letters === 0 && st.remaining.resumes === 0, { via: st.via, remaining: st.remaining });
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
    ok('an EXISTING second account on the claimed device keeps its fresh 3 (only row creation is gated)', g.allowed && g.via === 'free' && g.remaining === 3, g);
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
    seedUse(61, 'cover_letter', 'trial', '2026-09-13T05:00:00Z', 1);
    const e = await quotaGrants.extendTrial(61, 5, 'harness-extend', {});
    ok('extendTrial (bookkeeping) counts letters in the one-time window: 3 − 1 = 2', e.extended && e.lettersStillAvailable === 2 && e.resumesStillAvailable === 3, e);
  }

  console.log('── adminUserOps: read-only free state ──');
  let adminOps = null;
  try { adminOps = require(path.join(ROOT, 'server/services/adminUserOps.js')); } catch (e) { console.log('  (adminUserOps not loadable here: ' + e.message + ')'); }
  if (adminOps && typeof adminOps.planStateOf === 'function') {
    const p = await adminOps.planStateOf(30);
    ok('planStateOf(free): window_start = cutover, window_end + window_days_left null', p.status === 'free' && p.window_start === CUTOVER_ISO && p.window_end === null && p.window_days_left === null, { status: p.status, ws: p.window_start, we: p.window_end, wd: p.window_days_left });
    ok('planStateOf(free): base 3 per kind', p.quotas.every((q) => q.base === 3), p.quotas.map((q) => q.base));
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
    ok('quotaStateOf(free): trialDaysLeft null, 3/3 left', q.trialDaysLeft === null && q.lettersLeft === 3 && q.resumesLeft === 3 && q.via === 'trial', q);
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
      (u) => u.pool === 'free' && u.allowance === 3 && u.used === 0 && u.oneTime === true && u.planLabel === null);
    ok('…the Free row usageFor opened is the one the gate counts (one row, device claimed once)', db.trials.has(70) && db.trialDevices.get('dev-CCCCCCCC').first_user_id === 70, u70);
    seedUse(70, 'resume', 'trial', '2026-09-14T12:30:00Z', 1);   // after the row usageFor opened (db.now)
    await same('free user, 1 used', 70, 'resume', req('dev-CCCCCCCC'), (u) => u.remaining === 2 && u.used === 1 && u.allowance === 3);
    await same('pre-cutover usage does not count', 20, 'cover_letter', req(), (u) => u.used === 0 && u.remaining === 3);
    await same('free, exhausted after a post-cutover bonus (3 + 1, 4 used)', 30, 'resume', req(), (u) => u.pool === 'free' && u.remaining === 0 && u.allowance === 4 && u.used === 4);
    // plans: the plan's count and label, environment-scoped exactly like the gate
    seedSub(71, 'plus', '2026-09-10T00:00:00Z');
    seedUse(71, 'resume', 'plan', '2026-09-11T00:00:00Z', 3);
    await same('Plus, 3 of 15 used', 71, 'resume', req(), (u) => u.pool === 'plan' && u.planLabel === 'Plus' && u.allowance === 15 && u.used === 3 && u.remaining === 12 && u.oneTime === false);
    await same('Plus letters untouched', 71, 'cover_letter', req(), (u) => u.remaining === 25 && u.allowance === 25);
    await same('Starter over a cut allowance clamps at 0 (never negative)', 40, 'cover_letter', req(), (u) => u.pool === 'plan' && u.remaining === 0 && u.used === 20 && u.allowance === 10);
    const beforeRows = db.trials.size;
    await same('⚠️ a subscriber is never shown the Free allowance', 71, 'resume', req('dev-DDDDDDDD'), (u) => u.pool === 'plan');
    ok('…and asking for one opened no Free row', db.trials.size === beforeRows);
    // the device another account holds: not "0 of 3" — that account never had them
    const b = await same('device already used by another account', 50, 'resume', req('dev-AAAAAAAA'),
      (u, g) => u.pool === null && u.allowance === 0 && u.blocked === 'device_trial_used' && g.blocked === 'device_trial_used' && u.oneTime === true);
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
    ok('a subscriber: only this period\'s plan rows are counted', pl.filter((i) => i.counted).length === 1 && pl.find((i) => i.counted).source === 'plan'
      && ts(pl.find((i) => i.counted).createdAt) === ts('2026-09-14T06:00:00Z'), pl.map((i) => [i.source, i.createdAt, i.counted]));

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

  ok('the fake database saw no SQL it did not understand', db.unhandled.length === 0, db.unhandled);
  console.log(`\nfree-plan entitlements: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('free-plan entitlements: CRASH', e); process.exit(2); });
