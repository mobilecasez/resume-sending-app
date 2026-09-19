'use strict';

/**
 * THE "MAKE YOURS" WIZARD'S PROGRESS, KEPT ON THE SERVER (Migration 047, 2026-09-19).
 *
 * ⚠️ WHY IT EXISTS. The owner signed up a fresh account (user 616), walked the wizard, and lost it three ways:
 *   1. the signature he drew was never saved — SignatureStudio only uploads on its own "Use this", and the
 *      footer's always-enabled "Next" walked straight past a drawn, unconfirmed signature;
 *   2. reopening the wizard asked for the CV again — the experience step's state lived only in the screen;
 *   3. after an app restart "Pick up where you left off" was GONE — Home derived it from the files on disk
 *      alone, and once all of them were there the profile read "complete" although the wizard's last step (a
 *      real résumé) had never succeeded. Both of his builds had come back EMPTY (the CV was still being read)
 *      and were charged.
 * Local state is exactly what vanished on restart, so the truth lives here: one row per user who has written
 * through the wizard, and one pure function (wizardStateOf) that says which step is the first unfinished one.
 *
 * ⚠️ "FINISHED" HAS TWO DOORS AND ONLY TWO — the owner's words: "till the time he either finish it using make
 * my resume or complete the profile by going to the account settings".
 *   finished_at — a WIZARD build that was charged and saved (resumeBuilderController.generateAI → finish).
 *                 Reaching a "ready" screen is not it: the empty builds reached one too.
 *   closed_at   — a profile write that is NOT the wizard's (Account Settings in App.js, the website) and that
 *                 COMPLETED the profile by the wizard's OWN fields — incomplete before it, complete after it
 *                 (noteProfileBefore / closeIfCompletedElsewhere / profileCompleteOf).
 * Wizard uploads that complete the profile do NOT end the wizard: that is precisely the state the owner was in when
 * the button vanished. (A résumé with content that already exists — built in the Builder or on Home — counts as the
 * build step done: see wizardStateOf.)
 *
 * ⚠️ WHO IS "THE WIZARD". App.js's Account Settings writes through the very same endpoints (/users/profile/update,
 * /image, /resume, /signature), so the endpoint cannot tell them apart. The wizard marks its own requests with
 * the header X-CV-Source: onboarding (MobileApp/services/profileSetupService.ts). App.js may not be edited, so it
 * never sends it — which is exactly what makes its writes "Account Settings".
 *
 * ⚠️ NOTHING HERE MAY FAIL A PROFILE WRITE. Every hook swallows its own errors: the upload the user is waiting on
 * matters more than the bookkeeping about it.
 */

const dbConfig = require('../../db-config');

const STEP_KEYS = ['you', 'sign', 'experience', 'build'];
/** The wizard's own "enough to work with" for typed notes — the same 40 its Next button asks for. */
const NOTES_MIN = 40;
const NOTES_MAX = 20000;
/** How long a wizard build is joined rather than started again — asJob's idempotency window. */
const BUILD_JOIN_MINUTES = 15;

// ⚠️ ONE DEFINITION, used by db-init's Migration 047 AND by ensureTable below (a migration that failed — col()
// swallows — must not leave every wizard write throwing). No '?' anywhere: dbConfig rewrites it into a placeholder.
const TABLE_SQL = `CREATE TABLE IF NOT EXISTS user_onboarding (
    user_id          INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    notes            TEXT,
    lane             TEXT,
    skipped          JSONB NOT NULL DEFAULT '{}'::jsonb,
    build_job_id     TEXT,
    build_started_at TIMESTAMPTZ,
    finished_at      TIMESTAMPTZ,
    closed_at        TIMESTAMPTZ,
    closed_by        TEXT
)`;

/**
 * Accounts that opened the wizard before this table existed and never got a résumé with anything in it.
 * Measured against production 2026-09-19 (read-only): selects user 616 and nobody else — user 1 opened the wizard
 * too, but holds a built résumé with 2 roles, 2 schools and 7 projects. app_events.created_at is UTC without a zone.
 *
 * ⚠️ IT RUNS ONCE, EVER — NOT ON EVERY BOOT (review, 2026-09-19). db-init runs every migration on every boot, and a
 * backfill that ran each time re-opened the wizard for anyone who had merely OPENED it since (onboarding_open fires on
 * open) and never written through it — including someone who then completed the profile in Account Settings, which
 * leaves no row to close. The live rule creates a row only on a wizard WRITE; this is only for the accounts from before
 * that rule existed. So the statement claims a marker in system_schedule (Migration 016's table, job_key
 * 'm047_onboarding_backfill') and inserts only when IT claimed it — the same statement, so a backfill that fails takes
 * its marker with it and runs again on the next boot, and one that succeeded never runs again.
 * ⚠️ It deliberately does NOT skip accounts whose profile columns are complete: 616's are (phone, address, date of
 * birth, photo, signature and a READ CV — all through the wizard), and before this table no write said whether it came
 * from the wizard or from Account Settings, so "complete" cannot tell the two doors apart for these accounts.
 */
const BACKFILL_MARKER = 'm047_onboarding_backfill';
const BACKFILL_SQL = `WITH claimed AS (
    INSERT INTO system_schedule (job_key, last_run_at, last_summary)
    VALUES ('${BACKFILL_MARKER}', NOW(), 'Migration 047: wizard progress backfilled once. Do not delete: deleting it re-runs the backfill.')
    ON CONFLICT (job_key) DO NOTHING
    RETURNING job_key
)
INSERT INTO user_onboarding (user_id, started_at, updated_at)
SELECT e.user_id, MIN(e.created_at) AT TIME ZONE 'UTC', NOW()
  FROM app_events e
  JOIN users u ON u.id = e.user_id AND u.deleted_at IS NULL
 WHERE e.event = 'onboarding_open'
   AND EXISTS (SELECT 1 FROM claimed)
   AND NOT EXISTS (
       SELECT 1 FROM user_resumes r
        WHERE r.user_id = e.user_id
          AND (   (jsonb_typeof(r.resume_data->'experience') = 'array' AND jsonb_array_length(r.resume_data->'experience') > 0)
               OR (jsonb_typeof(r.resume_data->'education') = 'array' AND jsonb_array_length(r.resume_data->'education') > 0)
               OR (jsonb_typeof(r.resume_data->'projects') = 'array' AND jsonb_array_length(r.resume_data->'projects') > 0)))
 GROUP BY e.user_id
ON CONFLICT (user_id) DO NOTHING`;

let ensured = null;
function ensureTable() {
    if (!ensured) ensured = dbConfig.run(TABLE_SQL).catch((e) => { ensured = null; throw e; });
    return ensured;
}

/** Is this request the wizard's own? (see the header above) */
function isWizardRequest(req) {
    if (!req) return false;
    const h = (req.headers && (req.headers['x-cv-source'] || req.headers['X-CV-Source']))
        || (typeof req.get === 'function' ? req.get('X-CV-Source') : '');
    return String(h || '').trim().toLowerCase() === 'onboarding';
}

const parseJson = (v, fallback) => {
    if (v == null) return fallback;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return fallback; }
};

/** The row, or null. Never throws. */
async function get(userId) {
    try {
        await ensureTable();
        const row = await dbConfig.get('SELECT * FROM user_onboarding WHERE user_id = $1', [userId]);
        return row ? { ...row, skipped: parseJson(row.skipped, {}) } : null;
    } catch (e) {
        console.warn('[onboarding] progress read failed:', e.message);
        return null;
    }
}

/**
 * Create the row on the first wizard write and fold in what this write says. A key left out keeps its value;
 * `skipped` MERGES ({ photo: true } does not forget a skipped signature). It never clears finished/closed.
 */
async function touch(userId, patch = {}) {
    await ensureTable();
    const notes = typeof patch.notes === 'string' ? patch.notes.slice(0, NOTES_MAX) : null;
    const lane = patch.lane === 'write' || patch.lane === 'upload' ? patch.lane : null;
    let skipped = null;
    if (patch.skipped && typeof patch.skipped === 'object') {
        const s = {};
        for (const k of ['photo', 'signature']) if (typeof patch.skipped[k] === 'boolean') s[k] = patch.skipped[k];
        if (Object.keys(s).length) skipped = JSON.stringify(s);
    }
    await dbConfig.run(
        `INSERT INTO user_onboarding (user_id, started_at, updated_at, notes, lane, skipped)
         VALUES ($1, NOW(), NOW(), $2, $3, COALESCE($4::jsonb, '{}'::jsonb))
         ON CONFLICT (user_id) DO UPDATE SET
             updated_at = NOW(),
             notes      = COALESCE($2, user_onboarding.notes),
             lane       = COALESCE($3, user_onboarding.lane),
             skipped    = CASE WHEN $4::jsonb IS NULL THEN user_onboarding.skipped ELSE user_onboarding.skipped || $4::jsonb END`,
        [userId, notes, lane, skipped]
    );
}

/** The wizard's build job, recorded the moment it starts — so a reopened wizard (any device) rejoins it. */
async function markBuild(userId, jobId) {
    if (!jobId) return;
    await ensureTable();
    await dbConfig.run(
        `INSERT INTO user_onboarding (user_id, started_at, updated_at, build_job_id, build_started_at)
         VALUES ($1, NOW(), NOW(), $2, NOW())
         ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW(), build_job_id = $2, build_started_at = NOW()`,
        [userId, String(jobId)]
    );
}

/** A wizard build was charged AND saved: the wizard is done. The only caller is generateAI, after both landed. */
async function finish(userId) {
    await ensureTable();
    await dbConfig.run(
        `INSERT INTO user_onboarding (user_id, started_at, updated_at, finished_at)
         VALUES ($1, NOW(), NOW(), NOW())
         ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW(), finished_at = COALESCE(user_onboarding.finished_at, NOW())`,
        [userId]
    );
}

/**
 * For a user whose wizard is OPEN: is the profile complete by the wizard's own fields right now? true / false —
 * or null when there is no open wizard (nothing could be closed) or the profile could not be read.
 */
async function openWizardProfileComplete(userId) {
    const row = await get(userId);
    if (!row || row.finished_at || row.closed_at) return null;
    const { wizardInputsForUser } = require('../controllers/profileController');   // lazy: that module requires this one
    const ctx = await wizardInputsForUser(userId);
    if (!ctx) return null;
    const st = await stateFor(userId, ctx);
    return st ? profileCompleteOf(st) : null;
}

/**
 * A profile write that is not the wizard's: when IT is the write that completed the profile BY THE WIZARD'S OWN
 * FIELDS (profileCompleteOf), an open wizard is closed as "account_settings".
 * ⚠️ NOT the checklist's setup.complete (review, 2026-09-19). That rule also wants a date of birth, a photo and a
 * signature, which the wizard itself calls optional and lets them skip (the skip is stored) — so someone who skipped
 * the photo and then filled in everything else in Account Settings was held on "Pick up where you left off" until they
 * added three things the wizard had told them they did not need, or paid for a wizard build.
 * ⚠️ ONLY THE WRITE THAT COMPLETED IT — `before` must be false (review round 2, 2026-09-19). Testing the state AFTER
 * the write alone closed the wizard of anyone whose profile was ALREADY complete, on any save at all: user 616 (every
 * field and file saved through the wizard, only the build missing) would have lost "Pick up where you left off" to a
 * phone number re-saved in Account Settings — the owner's issue 3 again — and so would every build-209 wizard write,
 * which carries no X-CV-Source header. Nothing was completed there: only the build finishes such a wizard.
 * `before` is noteProfileBefore's reading, taken before the write; anything but false (not taken, no open wizard then,
 * unreadable) closes nothing — a wizard left open is a button that still works, a wrong close is the button gone.
 */
async function closeIfCompletedElsewhere(userId, before) {
    if (before !== false) return false;
    if (await openWizardProfileComplete(userId) !== true) return false;
    await dbConfig.run(
        `UPDATE user_onboarding SET closed_at = NOW(), closed_by = 'account_settings', updated_at = NOW()
          WHERE user_id = $1 AND finished_at IS NULL AND closed_at IS NULL`,
        [userId]
    );
    console.log(`[onboarding] user ${userId} completed the profile outside the wizard — the wizard is closed`);
    return true;
}

/**
 * ROUTE MIDDLEWARE, before every profile write that can close the wizard (profileRoutes' four writes, server.js's
 * /api/upload-profile and /api/update-user-details) — BEFORE multer, so nothing of this write is on file yet.
 * Remembers on the request whether an open wizard's profile was already complete (see closeIfCompletedElsewhere).
 * The wizard's own writes are skipped (they never close it). Never fails the request.
 */
async function noteProfileBefore(req, res, next) {
    try {
        const userId = req.user && req.user.id;
        if (userId && !isWizardRequest(req)) req.__onboardingBefore = await openWizardProfileComplete(userId);
    } catch (e) {
        console.warn('[onboarding] could not read the profile before a write (the wizard stays as it is):', e.message);
    }
    next();
}

/** The end of every profile write (see the header). Never throws, never changes the response. */
async function afterProfileWrite(req, userId) {
    try {
        if (!userId) return;
        if (isWizardRequest(req)) await touch(userId, {});
        else await closeIfCompletedElsewhere(userId, req ? req.__onboardingBefore : undefined);
    } catch (e) {
        console.warn(`[onboarding] progress hook for user ${userId} failed (the write itself stands):`, e.message);
    }
}

/**
 * The async job a wizard build runs as: { id, status, fresh } or null. `fresh` = inside the join window.
 * ⚠️ The age is asked of Postgres, not computed here: async_jobs.created_at is a timestamp WITHOUT a zone.
 */
async function jobOf(jobId, userId) {
    if (!jobId) return null;
    try {
        const j = await dbConfig.get(
            `SELECT id, status, (created_at > NOW() - INTERVAL '${BUILD_JOIN_MINUTES} minutes') AS fresh
               FROM async_jobs WHERE id = $1 AND user_id = $2`,
            [jobId, userId]
        );
        return j ? { id: String(j.id), status: String(j.status || ''), fresh: j.fresh === true || j.fresh === 't' } : null;
    } catch (e) {
        console.warn('[onboarding] build job read failed:', e.message);
        return null;
    }
}

/**
 * The user-facing reading of resume_metadata. `status`:
 *   'done' | 'pending' (being read) | 'slow' (a transient failure the sweeper retries) | 'error' | 'unread' (no row).
 */
function cvParseOf(meta) {
    if (!meta || !meta.parse_status) return { status: 'unread', error: null };
    const st = String(meta.parse_status);
    if (st === 'done') return { status: 'done', error: null };
    if (st === 'pending') return { status: meta.parse_error ? 'slow' : 'pending', error: null };
    const m = String(meta.parse_error || '');
    let error = 'We could not read this CV. Please upload it again as a PDF or .docx.';
    if (/^unsupported document: /.test(m)) error = m.replace(/^unsupported document: /, '');
    else if (/no readable r|no vision reader/i.test(m)) error = 'We could not find the text of a CV in this file. Please upload it as a PDF or .docx.';
    else if (/too large to read/i.test(m)) error = 'This file is too large for us to read. Please upload a smaller PDF or .docx.';
    return { status: 'error', error };
}

/** A résumé row with at least one experience, education or project entry that says something. */
function resumeHasSubstance(r) {
    const data = parseJson(r, null);
    if (!data || typeof data !== 'object') return false;
    const says = (v) => {
        if (typeof v === 'string') return !!v.trim();
        if (Array.isArray(v)) return v.some(says);
        if (v && typeof v === 'object') return Object.values(v).some(says);
        return false;
    };
    return ['experience', 'education', 'projects'].some((k) => Array.isArray(data[k]) && data[k].some(says));
}

/**
 * THE ONE ANSWER TO "WHERE IS THIS USER IN THE WIZARD" — pure, so the suite can walk every combination.
 *
 * Step rules are what the wizard's OWN screens ask for, not the checklist's (they disagree, and the wizard's
 * promises are on screen): date of birth and gender are optional there, photo and signature can be skipped (the
 * skip is stored), and the experience step is a CV the server has READ or notes of 40 characters. A résumé with
 * content that already exists is the experience AND the build done. The checklist rule (setup.profile /
 * setup.complete) is left exactly as it is — HelpAssistant, journey.js and the coach read it.
 *
 * @param row      the user_onboarding row (or null)
 * @param profile  { fullName, phone, address }
 * @param files    { photo, signature, resume } — booleans, a FILE ON DISK (livePath), not a path in a column
 * @param cv       { ext, uploadedAt } of the résumé file, or null
 * @param parse    cvParseOf(resume_metadata)
 * @param job      jobOf(row.build_job_id)
 * @param builtResume  resumeHasSubstance(user_resumes.resume_data)
 */
function wizardStateOf({ row = null, profile = {}, files = {}, cv = null, parse = null, job = null, builtResume = false } = {}) {
    const skipped = (row && parseJson(row.skipped, {})) || {};
    const notes = (row && typeof row.notes === 'string') ? row.notes : '';
    const p = parse || { status: 'unread', error: null };
    const buildStatus = !job ? null
        : (job.status === 'pending' || job.status === 'processing') ? (job.fresh ? 'running' : 'stale')
        : job.status === 'completed' ? 'completed'
        : 'failed';
    const finished = !!(row && (row.finished_at || buildStatus === 'completed'));
    // ⚠️ A RÉSUMÉ WITH CONTENT ALREADY EXISTS (the Builder, Home, a build from an older app) → the experience it was
    // written from and the build are BOTH done (review, 2026-09-19). Counting only a wizard build kept such a user on
    // an unfinished wizard the moment they saved one missing piece through it (a signature, a skip): Home swapped its
    // Customize doors for "Pick up where you left off — building your resume", and the only way out was a paid
    // "Rebuild". The empty résumé 616 was charged for has no content, so it still leaves the build to do.
    const done = {
        you: String(profile.fullName || '').trim().length > 1 && !!String(profile.phone || '').trim() && !!String(profile.address || '').trim(),
        sign: (!!files.photo || skipped.photo === true) && (!!files.signature || skipped.signature === true),
        experience: (!!files.resume && p.status === 'done') || notes.trim().length >= NOTES_MIN || !!builtResume,
        build: finished || !!builtResume,
    };
    const allDone = STEP_KEYS.every((k) => done[k]);
    const idx = STEP_KEYS.findIndex((k) => !done[k]);
    const step = idx < 0 ? STEP_KEYS.length - 1 : idx;
    const left = [];
    if (!done.you) left.push('your details');
    if (!files.photo && skipped.photo !== true) left.push('a photo');
    if (!files.signature && skipped.signature !== true) left.push('your signature');
    if (!done.experience) left.push('your experience');
    if (!done.build) left.push('building your resume');
    // Every step done (a real résumé included) is finished whichever way it got there — an open wizard with nothing
    // left to do would be a "Pick up" button that leads to "Your resume is ready".
    const state = !row ? 'none' : (finished || allDone) ? 'finished' : row.closed_at ? 'closed' : 'open';
    return {
        state,
        step,
        stepKey: STEP_KEYS[step],
        done,
        left,
        lane: row && (row.lane === 'write' || row.lane === 'upload') ? row.lane : null,
        notes,
        skipped: { photo: skipped.photo === true, signature: skipped.signature === true },
        cv: files.resume ? { ext: (cv && cv.ext) || null, uploadedAt: (cv && cv.uploadedAt) || null, status: p.status, error: p.error } : null,
        build: job ? { jobId: job.id, status: buildStatus } : null,
        builtResume: !!builtResume,
        closedBy: row && row.closed_at ? (row.closed_by || 'account_settings') : null,
    };
}

/**
 * "…or complete the profile by going to the account settings" — the owner's second door, measured with the fields the
 * WIZARD collects (the required outcome's words), from a wizardStateOf answer: About you (name, phone, address — date
 * of birth and gender are optional on that screen), the photo and the signature or their stored skips, and the
 * experience. The build is not part of it: that is the first door.
 * ⚠️ A CV on file counts here while it is still being READ ('pending' / 'slow' / 'unread'). This check runs at the
 * end of the Account Settings upload itself, when the read has only just started and no later write will come to
 * re-check it; a CV whose read FAILED does not count.
 */
function profileCompleteOf(w) {
    if (!w || !w.done) return false;
    const cvOnFile = !!w.cv && w.cv.status !== 'error';
    return !!(w.done.you && w.done.sign && (w.done.experience || cvOnFile));
}

/**
 * Everything wizardStateOf needs, read for one user. `ctx` comes from getProfile, which already holds the
 * profile fields and the live file paths. Never throws: a failed read degrades to "no wizard" (today's Home).
 */
async function stateFor(userId, ctx) {
    try {
        const row = await get(userId);
        const [job, meta, built] = await Promise.all([
            row && row.build_job_id ? jobOf(row.build_job_id, userId) : Promise.resolve(null),
            ctx.files.resume
                ? dbConfig.get('SELECT parse_status, parse_error FROM resume_metadata WHERE user_id = $1', [userId]).catch(() => null)
                : Promise.resolve(null),
            dbConfig.get('SELECT resume_data FROM user_resumes WHERE user_id = $1', [userId]).catch(() => null),
        ]);
        return wizardStateOf({
            row, profile: ctx.profile, files: ctx.files, cv: ctx.cv,
            parse: cvParseOf(meta), job, builtResume: !!(built && resumeHasSubstance(built.resume_data)),
        });
    } catch (e) {
        console.warn(`[onboarding] state for user ${userId} unavailable:`, e.message);
        return null;
    }
}

/**
 * ROUTE MIDDLEWARE, before asJob on POST /resume-builder/generate-ai: a wizard build while the wizard's own last
 * build is still running JOINS that job instead of starting (and charging) another.
 * ⚠️ THIS IS NOT WHAT STOPS CHARGE #2 — do not weaken the guards below trusting it (corrected after review,
 * 2026-09-19, against production). User 616's first job (868edb78) was created 10:47:54.68 UTC and COMPLETED
 * 10:47:56.28: an EMPTY résumé in 1.6 s (the CV was still being read), charged, and "Ready" sent him Home. Home offered
 * "Pick up where you left off" (10:48:10) because the signature he had drawn was never uploaded (signature_uploaded
 * appears only at 10:48:18, from the reopened wizard); the old wizard reopened on the signature, asked for the CV again
 * (resume_uploaded 10:48:25) and offered Build again — the second POST (f2e23546, 10:48:28) with nothing running. What
 * prevents that sequence: the empty-résumé refusal before the charge (thin_input) and the wait for / refusal of an
 * unread CV in generateAI; the signature committed on every way off its step (the wizard, SignatureStudio.commit); and
 * finish() on a charged-and-saved build, after which the wizard opens on "Your resume is ready" with no Build button.
 * This middleware covers a DIFFERENT case: a wizard reopened (any device) while its build is still running — the build
 * step does say "You can leave this screen. We will keep going." clientBuildId only dedupes the same tap; this dedupes
 * the same WIZARD, from any tap on any device, for asJob's 15-minute window.
 */
async function joinRunningWizardBuild(req, res, next) {
    try {
        const b = req.body || {};
        const userId = req.user && req.user.id;
        if (b.source !== 'onboarding' || b.__async !== true || b.saveTo === 'employer_doc' || !userId) return next();
        const row = await get(userId);
        const job = row && row.build_job_id ? await jobOf(row.build_job_id, userId) : null;
        if (job && job.fresh && (job.status === 'pending' || job.status === 'processing')) {
            console.log(`[onboarding] user ${userId}'s wizard build ${job.id} is still running — joined, not started again`);
            return res.status(202).json({ jobId: job.id, status: job.status, deduped: true, joined: true });
        }
    } catch (e) {
        console.warn('[onboarding] build join check failed (building normally):', e.message);
    }
    return next();
}

module.exports = {
    TABLE_SQL, BACKFILL_SQL, BACKFILL_MARKER, STEP_KEYS, NOTES_MIN, NOTES_MAX, BUILD_JOIN_MINUTES,
    ensureTable, isWizardRequest, get, touch, markBuild, finish, closeIfCompletedElsewhere, noteProfileBefore, afterProfileWrite,
    jobOf, cvParseOf, resumeHasSubstance, wizardStateOf, profileCompleteOf, stateFor, joinRunningWizardBuild,
};
