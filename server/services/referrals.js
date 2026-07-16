'use strict';
// Referrals — each user gets a share code; when a friend signs up with it AND activates (completes profile
// + applies to a job, going-forward), the referrer is paid the `reward_referral` credits (once per friend).
const dbConfig = require('../../db-config');
const creditRewards = require('./creditRewards');

let _ready = false;
async function ensureTables() {
  if (_ready) return;
  await dbConfig.run(`CREATE TABLE IF NOT EXISTS referral_codes (
    id SERIAL PRIMARY KEY,
    user_id INTEGER UNIQUE NOT NULL,
    code TEXT UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  // db-config.run auto-appends "RETURNING id" to INSERTs, so the table MUST have an id column. The v1
  // schema shipped without one (user_id was the PK) → every code insert threw → codes never persisted.
  // Add id to any already-created table (it's empty since all inserts failed, so this is safe).
  try { await dbConfig.run(`ALTER TABLE referral_codes ADD COLUMN IF NOT EXISTS id SERIAL`); } catch (_) {}
  await dbConfig.run(`CREATE TABLE IF NOT EXISTS referrals (
    id SERIAL PRIMARY KEY,
    code TEXT NOT NULL,
    referrer_user_id INTEGER NOT NULL,
    referred_user_id INTEGER UNIQUE,
    referred_email TEXT,
    status TEXT NOT NULL DEFAULT 'pending',   -- pending | qualified | rewarded
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    qualified_at TIMESTAMP,
    rewarded_at TIMESTAMP
  )`);
  try { await dbConfig.run(`CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_user_id)`); } catch (_) {}
  _ready = true;
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no ambiguous 0/O/1/I
function randCode(n = 6) { let s = ''; for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]; return s; }

async function getOrCreateCode(userId) {
  await ensureTables();
  const ex = await dbConfig.get('SELECT code FROM referral_codes WHERE user_id = ?', [userId]).catch(() => null);
  if (ex && ex.code) return ex.code;
  for (let i = 0; i < 6; i++) {
    const code = randCode(6);
    try { await dbConfig.run('INSERT INTO referral_codes (user_id, code) VALUES (?, ?)', [userId, code]); return code; }
    catch (_) { /* rare collision → retry */ }
  }
  const code = 'CV' + Number(userId).toString(36).toUpperCase();
  try { await dbConfig.run('INSERT INTO referral_codes (user_id, code) VALUES (?, ?)', [userId, code]); } catch (_) {}
  return code;
}

async function resolveCode(code) {
  await ensureTables();
  const r = await dbConfig.get('SELECT user_id FROM referral_codes WHERE code = ?', [String(code || '').trim().toUpperCase()]).catch(() => null);
  return r ? r.user_id : null;
}

// A new user claims a code (call once, post-signup). Guards self-referral + already-referred + bad code.
async function claimReferral(referredUserId, code, email) {
  await ensureTables();
  if (!referredUserId || !code) return { ok: false, reason: 'missing' };
  const already = await dbConfig.get('SELECT id FROM referrals WHERE referred_user_id = ?', [referredUserId]).catch(() => null);
  if (already) return { ok: false, reason: 'already_referred' };
  const referrerId = await resolveCode(code);
  if (!referrerId) return { ok: false, reason: 'invalid_code' };
  if (referrerId === referredUserId) return { ok: false, reason: 'self' };
  try {
    await dbConfig.run('INSERT INTO referrals (code, referrer_user_id, referred_user_id, referred_email, status) VALUES (?, ?, ?, ?, ?)',
      [String(code).trim().toUpperCase(), referrerId, referredUserId, email || null, 'pending']);
  } catch (_) { return { ok: false, reason: 'dup' }; }
  // Maybe they already qualify (edge case) — evaluate now.
  await evaluateReferralQualification(referredUserId).catch(() => {});
  return { ok: true, referrerId };
}

// When the REFERRED user's activation is evaluated: if they've completed profile + applied and their
// referral is still pending → mark qualified and pay the referrer (idempotent, once per referred user).
async function evaluateReferralQualification(referredUserId) {
  await ensureTables();
  const ref = await dbConfig.get("SELECT id, referrer_user_id FROM referrals WHERE referred_user_id = ? AND status = 'pending'", [referredUserId]).catch(() => null);
  if (!ref) return;
  const profile = await creditRewards.hasCompleteProfile(referredUserId);
  const applied = await creditRewards.hasAppliedOnce(referredUserId);
  if (!profile || !applied) return;
  await dbConfig.run("UPDATE referrals SET status = 'qualified', qualified_at = CURRENT_TIMESTAMP WHERE id = ?", [ref.id]).catch(() => {});
  const g = await creditRewards.grantReward(ref.referrer_user_id, 'reward_referral', { idempotencyKey: 'reward_referral:' + referredUserId, note: 'Referral of user ' + referredUserId });
  if (g.granted || g.already) await dbConfig.run("UPDATE referrals SET status = 'rewarded', rewarded_at = CURRENT_TIMESTAMP WHERE id = ?", [ref.id]).catch(() => {});
}

async function getReferralStatus(userId) {
  await ensureTables();
  const code = await getOrCreateCode(userId);
  const rows = await dbConfig.query('SELECT status FROM referrals WHERE referrer_user_id = ?', [userId]).catch(() => []);
  const invited = (rows || []).length;
  const qualified = (rows || []).filter((r) => r.status === 'qualified' || r.status === 'rewarded').length;
  return { code, invited, qualified };
}

module.exports = { ensureTables, getOrCreateCode, resolveCode, claimReferral, evaluateReferralQualification, getReferralStatus };
