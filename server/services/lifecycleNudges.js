// Automatic lifecycle nudges — the scheduled half of the notification system. ADDITIVE.
//
// The copy, the deep links and the per-user relevance logic already existed in notifyTemplates.js,
// but nothing ever SENT them: they were reachable only from the admin's "notify this user" button.
// This file is the runner. Once every RUN_EVERY_HOURS it walks reachable users, works out which ONE
// nudge fits each person best, asks nudgeGate whether they may be interrupted at all, optionally
// attaches an incentive, and sends through the existing adminUserOps.sendToUser pipeline (which owns
// opt-out gating, the atomic 72h reservation, the in-app row and the push).
//
// THE RULES THAT MATTER
//
//  • ONE nudge per user per run, ever. The registry is ordered by where someone is stuck, earliest
//    blocker first, and the first applicable entry wins. Sending two in one sweep is the fastest way
//    to make an app feel like spam.
//  • The support check-in is LAST and needs REQUIRE_PRIOR_NUDGES earlier nudges behind it. "Are you
//    facing any issue?" is a reasonable question after we have tried to help and nothing moved; as a
//    first contact it is a non-sequitur.
//  • Every decision — sent, skipped, why — is returned, and `dryRun` runs the entire pipeline
//    including the gate without sending anything. Never ship a change to this file without looking
//    at a dry run first; the previous match-push shipped without one and pushed "7 new commercial
//    jobs in South Africa" to a plumber in Vancouver.
//
// INCENTIVES. Two shapes, chosen per nudge:
//   'promise'  — the body says what they get for finishing ("…and we'll add 3 free cover letters").
//                Nothing is granted yet. settleIncentives() grants it once they actually do it and
//                sends one short confirmation. This is the default: it rewards the behaviour we want
//                rather than paying everyone who owns a phone.
//   'immediate'— granted at send time, because the grant IS the message (extending a trial that is
//                about to close). The copy may then state it as done, because it is.
'use strict';

const dbConfig = require('../../db-config');
const templates = require('./notifyTemplates');
const nudgeGate = require('./nudgeGate');
const quotaGrants = require('./quotaGrants');
const notifSwitch = require('./notifSwitch');

const RUN_EVERY_HOURS = parseFloat(process.env.LIFECYCLE_NUDGE_HOURS || '6');
/** Ceiling on users examined per sweep — keeps one run bounded however big the base gets. */
const SCAN_LIMIT = parseInt(process.env.LIFECYCLE_SCAN_LIMIT || '2000', 10);
/** Ceiling on pushes actually sent per sweep. */
const SEND_LIMIT = parseInt(process.env.LIFECYCLE_SEND_LIMIT || '300', 10);
/** How many earlier nudges someone must have had before we ask "is something broken?". */
const REQUIRE_PRIOR_NUDGES = parseInt(process.env.LIFECYCLE_SUPPORT_AFTER || '2', 10);

const int = (v, d = 0) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// ── the registry ──────────────────────────────────────────────────────────────────────────────
// ORDER IS THE PRIORITY. `templateKey` points at notifyTemplates (which owns the copy, route and
// applicability). `minDaysSinceSignup` stops us nudging someone about a step they are, at this very
// moment, halfway through. `done` is the completion test the incentive settles against.
const NUDGES = [
  {
    key: 'nudge_upload_resume',
    templateKey: 'upload_resume',
    label: 'Upload your résumé',
    minDaysSinceSignup: 1,
    // The single highest-leverage step in the product: without a résumé there are no match scores,
    // no cover letters and no autofill. Worth the largest incentive we offer.
    incentive: { mode: 'promise', kind: 'cover_letter', amount: 3,
      offer: 'Do it now and we will add 3 extra free cover letters to your account.' },
    done: (s) => !!s.hasResume,
  },
  {
    key: 'nudge_resume_parse_failed',
    templateKey: 'resume_parse_failed',
    label: 'Résumé could not be read',
    minDaysSinceSignup: 0,
    done: (s) => String(s.parseStatus || '').toLowerCase() !== 'error',
  },
  {
    key: 'nudge_complete_profile',
    templateKey: 'complete_profile',
    label: 'Complete your profile',
    minDaysSinceSignup: 2,
    incentive: { mode: 'promise', kind: 'cover_letter', amount: 2,
      offer: 'Finish it and we will add 2 extra free cover letters.' },
    done: (s) => num((s.completeness || {}).percent) >= 100,
  },
  {
    key: 'nudge_add_photo',
    templateKey: 'add_photo',
    label: 'Add a profile photo',
    minDaysSinceSignup: 3,
    done: (s) => !!s.hasPhoto,
  },
  {
    key: 'nudge_add_signature',
    templateKey: 'add_signature',
    label: 'Add your signature',
    minDaysSinceSignup: 3,
    done: (s) => !!s.hasSignature,
  },
  {
    key: 'nudge_how_it_works',
    templateKey: 'how_it_works',
    label: 'How CVApplyr works',
    minDaysSinceSignup: 2,
    done: (s) => num(s.searches) > 0 || num(s.applications) > 0,
  },
  {
    key: 'nudge_generate_cover_letter',
    templateKey: 'generate_cover_letter',
    label: 'Generate a cover letter',
    minDaysSinceSignup: 1,
    done: (s) => num(s.coverLetters) > 0,
  },
  {
    key: 'nudge_saved_not_applied',
    templateKey: 'saved_not_applied',
    label: 'Saved but never applied',
    minDaysSinceSignup: 1,
    done: (s) => num(s.applications) > 0,
  },
  {
    key: 'nudge_finish_application',
    templateKey: 'finish_first_application',
    label: 'Cover letter ready — finish applying',
    minDaysSinceSignup: 1,
    done: (s) => num(s.applications) > 0,
  },
  {
    key: 'nudge_trial_ending',
    templateKey: 'trial_ending',
    label: 'Trial ending soon',
    minDaysSinceSignup: 0,
    // The one place an immediate grant is honest: the offer IS the extension. ⚠️ Days alone buy
    // nothing (the letter count is independent of ends_at), so letters come with them — see the
    // warning at the top of quotaGrants.js.
    incentive: { mode: 'immediate', kind: 'trial_days', amount: 5, alsoLetters: 2,
      offer: 'We have added 5 more days and 2 more free cover letters to your trial.' },
    done: () => true,
  },
  {
    key: 'nudge_best_matches',
    templateKey: 'best_matches',
    label: 'Your best matches are waiting',
    minDaysSinceSignup: 1,
    done: (s) => num(s.applications) > 0,
  },
  {
    key: 'nudge_welcome_back',
    templateKey: 'welcome_back_dormant',
    label: 'Welcome back (dormant)',
    minDaysSinceSignup: 7,
    done: (s) => s.daysSinceLastSeen != null && num(s.daysSinceLastSeen) < 7,
  },
  {
    key: 'nudge_support_checkin',
    templateKey: 'support_checkin',
    label: 'Are you facing any issue?',
    minDaysSinceSignup: 2,
    requiresPriorNudges: REQUIRE_PRIOR_NUDGES,
    done: () => true,
  },
];

const BY_KEY = new Map(NUDGES.map((n) => [n.key, n]));

// ── candidate selection ───────────────────────────────────────────────────────────────────────
// Reachable users only: no push token means no notification, and evaluating them would burn a
// per-user state build to reach nobody. Soft-deleted and the seeded ATS test accounts are excluded
// here; the founder/QA id list lives in nudgeGate so every job shares one definition.
async function candidates(limit) {
  const rows = await dbConfig.query(
    `SELECT u.id
       FROM users u
      WHERE u.deleted_at IS NULL
        AND u.expo_push_token IS NOT NULL AND u.expo_push_token <> ''
        AND u.email NOT LIKE 'ats%@example.com'
      ORDER BY u.id
      LIMIT $1`, [Math.max(1, int(limit, SCAN_LIMIT))]);
  return (rows || []).map((r) => int(r.id)).filter((id) => !nudgeGate.TEST_USER_IDS.has(id));
}

/** How many lifecycle nudges this user has already received (any key, ever). */
function priorNudgeCount(state) {
  return (state && state.recent) ? state.recent.length : 0;
}

// ── picking the nudge ─────────────────────────────────────────────────────────────────────────
/**
 * The best nudge for one user, or null. PURE given `userState` (the notifyTemplates state object)
 * and `gateState` — no database, so the whole priority ladder is unit-testable.
 *
 * Returns { nudge, template, reason } or { skipped: [...] } explaining every rejection.
 */
function pickNudge(userState, gateState, enabled) {
  const tried = [];
  for (const n of NUDGES) {
    if (enabled && enabled[n.key] === false) { tried.push({ key: n.key, why: 'switched_off' }); continue; }

    const days = num(userState.daysSinceSignup);
    if (n.minDaysSinceSignup && days < n.minDaysSinceSignup) {
      tried.push({ key: n.key, why: `signed up ${days}d ago (needs ${n.minDaysSinceSignup}d)` });
      continue;
    }
    if (n.requiresPriorNudges && priorNudgeCount(gateState) < n.requiresPriorNudges) {
      tried.push({ key: n.key, why: `only ${priorNudgeCount(gateState)} earlier nudges (needs ${n.requiresPriorNudges})` });
      continue;
    }
    const tpl = templates.get(n.templateKey);
    if (!tpl) { tried.push({ key: n.key, why: 'template missing' }); continue; }

    const rel = templates.relevanceFor(tpl, userState);
    if (rel.relevance !== 'suggested') { tried.push({ key: n.key, why: rel.reason || rel.relevance }); continue; }

    return { nudge: n, template: tpl, reason: rel.reason, tried };
  }
  return { nudge: null, tried };
}

// ── incentives ────────────────────────────────────────────────────────────────────────────────
/**
 * Apply an 'immediate' incentive. Idempotent on (userId, nudgeKey, attempt) so a retried run cannot
 * pay twice.
 *
 * Returns { log, sentence } describing WHAT WAS ACTUALLY GRANTED, or null if nothing was.
 *
 * ⚠️ The sentence is built from the grants that SUCCEEDED, never from the registry's wording. The
 * trial nudge grants two separate things (days, then letters) and the second can fail on its own —
 * a fixed "we added 5 days and 2 free cover letters" would then be a plain lie printed on someone's
 * lock screen. If only the days landed, the copy mentions only the days.
 */
async function applyImmediate(userId, nudge, attempt) {
  const inc = nudge.incentive;
  if (!inc || inc.mode !== 'immediate') return null;
  const idem = `${nudge.key}:a${attempt}`;
  const log = [];
  const said = [];
  const many = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;

  if (inc.kind === 'trial_days') {
    const r = await quotaGrants.extendTrial(userId, inc.amount, idem, { note: nudge.label });
    if (!r.extended) return null;                       // no trial, or already granted — say nothing
    log.push(`+${inc.amount}d trial`);
    said.push(many(inc.amount, 'more day'));
    if (inc.alsoLetters) {
      const g = await quotaGrants.grantQuota(userId, 'cover_letter', inc.alsoLetters, idem + ':letters', { note: nudge.label });
      if (g.granted) { log.push(`+${inc.alsoLetters} letters`); said.push(many(inc.alsoLetters, 'more free cover letter')); }
    }
  } else {
    const g = await quotaGrants.grantQuota(userId, inc.kind, inc.amount, idem, { note: nudge.label });
    if (!g.granted) return null;
    const noun = inc.kind === 'resume' ? 'free resume generation' : 'free cover letter';
    log.push(`+${inc.amount} ${inc.kind}`);
    said.push(many(inc.amount, noun));
  }
  return { log: log.join(', '), sentence: `We have added ${said.join(' and ')} to your trial.` };
}

/**
 * Pay out 'promise' incentives to people who actually did the thing.
 *
 * Runs before the send sweep so a settlement confirmation is the notification that user gets today,
 * rather than being queued behind a fresh nudge. The grant itself is idempotent and unconditional;
 * only the CONFIRMATION push is rate-limited, so a user at their weekly cap still gets the credit —
 * they just hear about it in the app rather than on the lock screen.
 */
async function settleIncentives({ dryRun = false } = {}) {
  // `granted` counts real payouts; `wouldGrant` is the dry-run figure. Two names, because a dry run
  // that reports "granted 12" is exactly the kind of report that gets believed.
  const out = { checked: 0, granted: 0, wouldGrant: 0, confirmed: 0, items: [] };
  let pending;
  try {
    pending = await dbConfig.query(
      `SELECT DISTINCT ON (l.user_id, l.nudge_key) l.id, l.user_id, l.nudge_key, l.attempt, l.sent_at
         FROM user_nudge_log l
        WHERE l.push_ok IS TRUE
          AND l.incentive LIKE 'promised:%'
          AND l.sent_at > NOW() - INTERVAL '45 days'
          AND NOT EXISTS (SELECT 1 FROM quota_grants q
                           WHERE q.user_id = l.user_id AND q.idem_key = l.nudge_key || ':a' || l.attempt)
        ORDER BY l.user_id, l.nudge_key, l.sent_at DESC
        LIMIT 500`);
  } catch (e) { console.warn('[lifecycle] settle query:', e.message); return out; }

  const adminOps = require('./adminUserOps');
  for (const row of pending || []) {
    const nudge = BY_KEY.get(String(row.nudge_key));
    if (!nudge || !nudge.incentive || nudge.incentive.mode !== 'promise') continue;
    out.checked += 1;
    let state;
    try { state = await adminOps.buildUserState(int(row.user_id)); } catch { state = null; }
    if (!state) continue;
    if (!nudge.done(state)) continue;                   // not finished yet — check again next run

    const inc = nudge.incentive;
    const idem = `${nudge.key}:a${int(row.attempt, 1)}`;
    if (dryRun) {
      out.items.push({ userId: int(row.user_id), nudgeKey: nudge.key, wouldGrant: `${inc.amount} ${inc.kind}` });
      out.wouldGrant += 1;
      continue;
    }
    const g = await quotaGrants.grantQuota(row.user_id, inc.kind, inc.amount, idem, { note: nudge.label });
    if (!g.granted) continue;
    out.granted += 1;

    // Tell them. Best-effort: the quota is already theirs whether or not this push lands.
    try {
      const noun = inc.kind === 'resume' ? (inc.amount === 1 ? 'resume generation' : 'resume generations')
        : (inc.amount === 1 ? 'cover letter' : 'cover letters');
      const { createNotification } = require('../controllers/notificationsController');
      await createNotification(
        int(row.user_id), 'credits',
        `${inc.amount} free ${noun} added ✅`,
        `Thanks for finishing that — your ${inc.amount} extra free ${noun} are on your account and ready to use.`,
        null,
        { route: 'usage', params: {}, action: 'incentive_settled', nudgeKey: nudge.key },
        { push: true, category: 'reminders' });
      await nudgeGate.record(row.user_id, nudge.key + '_paid', { attempt: 1, pushOk: true, incentive: `granted:${inc.amount} ${inc.kind}` });
      out.confirmed += 1;
    } catch (e) { console.warn('[lifecycle] settle confirm:', e.message); }
    out.items.push({ userId: int(row.user_id), nudgeKey: nudge.key, granted: `${inc.amount} ${inc.kind}` });
  }
  return out;
}

// ── the sweep ─────────────────────────────────────────────────────────────────────────────────
async function runLifecycleNudges({ force = false, dryRun = false, scanLimit, sendLimit } = {}) {
  if (!force && !dryRun) {
    const last = await getLastRun('lifecycle_nudges');
    const h = last ? (Date.now() - new Date(last).getTime()) / 3.6e6 : Infinity;
    if (h < RUN_EVERY_HOURS * 0.9) return { skipped: true, hoursSinceLastRun: Number(h.toFixed(1)) };
  }

  // `sent` only ever counts pushes that really went out. A dry run fills `wouldSend` and leaves
  // `sent` at 0, so a preview can never be mistaken for a send in a log or a screenshot.
  const summary = {
    dryRun: !!dryRun, scanned: 0, sent: 0, wouldSend: 0, skipped: {}, sends: [], settle: null,
    startedAt: new Date().toISOString(),
  };
  const bump = (why) => { summary.skipped[why] = (summary.skipped[why] || 0) + 1; };

  // Keep "did they come back?" current before the silence rule reads it.
  await nudgeGate.refreshResponses();
  summary.settle = await settleIncentives({ dryRun });

  // The master switch is checked AFTER settlement on purpose: pausing the campaign must not
  // withhold a bonus we already promised someone who went and did the thing.
  const masterOn = await notifSwitch.isOn('lifecycle_nudges_master');
  if (!masterOn) {
    summary.summary = 'master switch OFF — no nudges sent'
      + (summary.settle && summary.settle.granted ? `, but settled ${summary.settle.granted} promised bonus(es)` : '');
    summary.masterOff = true;
    if (!dryRun) await setLastRun('lifecycle_nudges', summary.summary);
    return summary;
  }

  const enabled = {};
  for (const n of NUDGES) enabled[n.key] = await notifSwitch.isOn(n.key);

  const ids = await candidates(scanLimit || SCAN_LIMIT);
  summary.scanned = ids.length;
  if (!ids.length) { if (!dryRun) await setLastRun('lifecycle_nudges', 'no candidates'); return summary; }

  const gateStates = await nudgeGate.loadState(ids);
  const adminOps = require('./adminUserOps');
  const batchId = 'auto:life:' + Date.now().toString(36);
  const shared = { newJobsByField: new Map() };
  const sendCap = Math.max(0, int(sendLimit, SEND_LIMIT));

  for (const userId of ids) {
    if ((dryRun ? summary.wouldSend : summary.sent) >= sendCap) { bump('send_cap_reached'); continue; }
    const gs = gateStates.get(userId) || { byKey: new Map(), activeHours: new Set() };

    // Cheap gate first — most users on most runs are inside a cooldown, and asking that costs
    // nothing, whereas building their state costs several queries.
    const early = nudgeGate.check(userId, '__any__', gs, Date.now());
    if (!early.ok && ['too_soon', 'weekly_cap', 'silent_user', 'quiet_hours', 'test_account'].includes(early.reason)) {
      bump(early.reason);
      continue;
    }

    let state;
    try { state = await adminOps.buildUserState(userId, { withMatches: true, shared }); } catch { state = null; }
    if (!state) { bump('state_unavailable'); continue; }

    const pick = pickNudge(state, gs, enabled);
    if (!pick.nudge) { bump('nothing_applicable'); continue; }

    const decision = nudgeGate.check(userId, pick.nudge.key, gs, Date.now());
    if (!decision.ok) { bump(decision.reason); continue; }

    // Build the copy, appending the offer sentence when this nudge carries one.
    const ctx = { firstName: state.firstName, fullName: state.fullName, state, job: state.topMatch || null };
    const base = templates.render(pick.template, ctx);
    const inc = pick.nudge.incentive;
    const overrides = inc && inc.offer ? { body: withOffer(base.body, inc.offer) } : {};

    if (dryRun) {
      summary.sends.push({
        userId, nudgeKey: pick.nudge.key, templateKey: pick.nudge.templateKey, attempt: decision.attempt,
        title: base.title, body: overrides.body || base.body, route: base.route, params: base.params,
        why: pick.reason, incentive: inc ? `${inc.mode}:${inc.amount} ${inc.kind}` : null,
      });
      summary.wouldSend += 1;
      continue;
    }

    // Immediate incentives are granted BEFORE the push, so the copy cannot promise something that
    // then failed to apply. A failed grant simply means the offer line is dropped.
    let incentiveNote = null;
    let finalOverrides = overrides;
    if (inc && inc.mode === 'immediate') {
      const applied = await applyImmediate(userId, pick.nudge, decision.attempt);
      if (!applied) {
        finalOverrides = {};                            // nothing granted → do not claim we did
      } else {
        incentiveNote = applied.log;
        // Say what actually landed, not what the registry hoped would land.
        finalOverrides = { body: withOffer(base.body, applied.sentence) };
      }
    } else if (inc && inc.mode === 'promise') {
      incentiveNote = `promised:${inc.amount} ${inc.kind}`;
    }

    let res;
    try {
      res = await adminOps.sendToUser({
        userId, templateKey: pick.nudge.templateKey, overrides: finalOverrides,
        adminId: null, batchId, state, shared,
      });
    } catch (e) { res = { ok: false, error: e.message }; }

    await nudgeGate.record(userId, pick.nudge.key, {
      attempt: decision.attempt,
      pushOk: !!res.ok,
      skipped: res.ok ? null : (res.skipped || 'send_failed'),
      incentive: incentiveNote,
    });

    if (res.ok) {
      summary.sent += 1;
      summary.sends.push({ userId, nudgeKey: pick.nudge.key, attempt: decision.attempt, title: res.title, incentive: incentiveNote });
    } else {
      bump('send_' + (res.skipped || 'failed'));
    }
  }

  const line = dryRun
    ? `would send ${summary.wouldSend}/${summary.scanned}, would settle ${summary.settle ? summary.settle.wouldGrant : 0} (dry run — nothing sent)`
    : `sent ${summary.sent}/${summary.scanned}` +
      (summary.settle && summary.settle.granted ? `, settled ${summary.settle.granted}` : '');
  summary.summary = line;
  if (!dryRun) await setLastRun('lifecycle_nudges', line);
  if (summary.sent) console.log(`[lifecycle] ${line}`);
  return summary;
}

function clipTo(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}

/**
 * Body + offer, within the 200-char push budget.
 *
 * ⚠️ Clipping the JOINED string is what you reach for first, and it is wrong: the offer is at the
 * end, so it is the part that gets cut — "…and we will add 3 extra free cove…". The offer is the
 * whole reason the nudge is worth sending, so it is reserved in full and the templated body is
 * shortened to fit around it.
 */
const PUSH_BODY_MAX = 200;
function withOffer(body, offer) {
  const o = String(offer || '').replace(/\s+/g, ' ').trim();
  if (!o) return clipTo(body, PUSH_BODY_MAX);
  const room = PUSH_BODY_MAX - o.length - 1;
  if (room < 40) return clipTo(o, PUSH_BODY_MAX);       // offer alone already fills the budget
  return (clipTo(body, room) + ' ' + o).trim();
}

async function getLastRun(key) {
  try { const r = await dbConfig.get('SELECT last_run_at FROM system_schedule WHERE job_key = ?', [key]); return r ? r.last_run_at : null; }
  catch { return null; }
}
async function setLastRun(key, summary) {
  try {
    await dbConfig.run(
      `INSERT INTO system_schedule (job_key, last_run_at, last_summary) VALUES (?, CURRENT_TIMESTAMP, ?)
       ON CONFLICT (job_key) DO UPDATE SET last_run_at = CURRENT_TIMESTAMP, last_summary = EXCLUDED.last_summary`,
      [key, summary || null]);
  } catch (_) { /* best-effort */ }
}

function startLifecycleNudges() {
  if (process.env.LIFECYCLE_NUDGES_DISABLED === '1') { console.log('🔔 Lifecycle nudges: DISABLED'); return; }
  const tick = () => runLifecycleNudges().catch((e) => console.error('[lifecycle] tick:', e.message));
  setTimeout(tick, 8 * 60 * 1000);                 // ~8 min after boot, behind the other schedulers
  setInterval(tick, 60 * 60 * 1000);               // hourly tick; the persisted gate decides
  console.log(`🔔 Lifecycle nudges: scheduled (every ${RUN_EVERY_HOURS}h, persisted)`);
}

module.exports = {
  NUDGES, RUN_EVERY_HOURS, REQUIRE_PRIOR_NUDGES,
  runLifecycleNudges, settleIncentives, startLifecycleNudges,
  // test seams
  pickNudge, candidates, _clipTo: clipTo, _withOffer: withOffer, PUSH_BODY_MAX,
};
