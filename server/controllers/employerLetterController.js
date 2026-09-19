// Cover Letter Builder — employer lane (Home). New feature. Safe to delete without affecting existing app.
//
// The cover letter Home writes FOR ONE EMPLOYER CHIP, stored per employer in user_employer_documents
// (kind 'cover_letter') so switching chips shows that employer's own letter instantly and never pays
// twice for the same inputs. The resume twin is resumeBuilderController's doc lane (saveTo
// 'employer_doc'); the money rules below mirror it clause for clause.
//
//   POST /api/cover-letter/employer-gate   → employerLetterGate    (dry run: reserves, binds, charges nothing;
//                                                                     + usage/pass for the confirm sheet)
//   POST /api/cover-letter/employer-build  → buildEmployerLetter   (asJob('cover_letter_employer'))
//   GET  /api/cover-letter/employer-cards  → employerLetterCards   (thumbs of a stored letter, free)
//   currentLetterFingerprint(userId, …)    → the stale label on /api/employer-docs/current
//
// ⚠️⚠️ NEVER GENERATE OR CHARGE SILENTLY (a real incident drained users). A build runs only because the
// user tapped something, and only the SERVER decides what pays: the cache first (free, touches no
// billing), then the plan / free allowance, then a pass, then legacy credits — and under coveredOnly the
// credits lane does not exist at all, so anything only credits could pay is a 402 BEFORE any paid work
// (research counts as paid work). A document is stored only for a build that was actually charged.
//
// ⚠️ THE GATE, THE BUILD AND THE STALE LABEL MUST COMPUTE ONE FINGERPRINT. If they ever disagree the
// gate lies about money (sends a user to Plans for a free cache hit, or promises a free hit that then
// charges) and the stale pill nags on every letter. So there is exactly ONE function per input —
// candidateMaterialFor, jobFieldsOf, letterFingerprintOf — and all three call them. Read the header of
// letterFingerprintOf before handing the letter writer a new input.
//
// ⚠️ THE WORDS ARE THE JOBS SECTION'S (2026-09-18, the owner's decision). The letter is written by
// coverLetterController's own generation — ai-cover-letter-v2's prompt with Google Search grounding — from the
// same inputs in the same shapes; this file keeps everything around the words. See "The letter itself".
//
// ⚠️ EMPLOYER IDENTITY IS downloads.employerKeyOf / sameEmployer, via employerDocs — never a second
// normalisation here. The pass, the cache and the history rows must agree on who the employer is.
'use strict';

const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const dbConfig = require('../../db-config');
const downloads = require('../services/downloads');
const entitlements = require('../services/entitlements');
const jobService = require('../services/jobService');
const clTemplates = require('../utils/coverLetterTemplates');
const clRenderer = require('../utils/coverLetterRenderer');
const { emit } = require('../services/track');

// ⚠️ LAZY, ON PURPOSE. coverLetterRoutes.js requires this file at boot, and these modules belong to
// slices that can be mid-deploy; a top-level require that throws would take EVERY cover-letter route
// down with it (the legacy letters included). Resolved inside the handlers instead — and before any
// paid work, so a missing module fails a build while it still costs nothing.
const employerDocsMod = () => require('../services/employerDocs');
const designFitMod = () => require('../services/designFit');
const researchMod = () => require('../services/employerResearch');
const scorerMod = () => require('../services/resumeScorer');
// The letter's WRITER as well as its readers (the brand, the sender block, the photo): the Jobs section's generation
// lives there, and this lane calls it (writeLegacyLetter and its inputs) — through aiText, on the letter chain.
const clMod = () => require('./coverLetterController');

/**
 * Folded into the fingerprint next to employerResearch.RESEARCH_REV. Bump when the letter's instructions change
 * shape: the stored letters are still faithful to their inputs, but they answer different instructions.
 * (employerDocs.FP_VERSION would invalidate every resume too.)
 *
 * ⚠️ A BUMP RE-BILLS EVERY LETTER EVER STORED, so it is a money decision, not a version number. It moves
 * every fingerprint at once: every saved letter reads as stale, and the next build for an employer the user
 * already paid for is a full charge for a letter they have. It is worth that only when the stored letters
 * would be WRONG — not when a new one would merely be better.
 * ⚠️ WHICH IS WHY THE CONVENTIONS SLICE (2026-09-14) DID NOT BUMP IT. Hiring conventions set the register,
 * the length band and the paragraph emphasis (the old prompt's letterStyleFor) — the same facts, addressed to the same
 * employer, in a tone that suits them. A stored letter is still a true letter, so nobody is charged for
 * ours having improved. Telling the two apart later needs no marker in the fingerprint either: a letter
 * written with them has them in its stored `research.conventions`.
 * ⚠️ NOR DID THE EMPLOYER-SPECIFIC SLICE (2026-09-15): the sector-led opening paragraph and the employer's
 * register are the same rule (the same facts, said for this employer), and the brand (design.brand — the
 * employer's colour and font on every design) is RENDERING, not writing: a stored letter without one reads
 * its brand back from its research at render time (coverLetterController.letterBrandOf).
 * ⚠️ NOR DID THE SWITCH TO THE JOBS SECTION'S WRITER (2026-09-18) — the biggest change of instructions this lane has
 * had, and still not a reason to charge anyone again. Every stored letter is a true letter from the same résumé to the
 * same employer; a user who wants the new writer's version taps Refresh, sees what it costs, and confirms it. A bump
 * would have made every saved letter "stale" at once and billed the next open of each — the drain this file exists to
 * prevent. Telling the two apart needs no marker here: the stored row's `model` and its research say which it was.
 */
const LETTER_REV = 'letter-v1';

/**
 * ⚠️ ONE AI WINDOW FOR THE WHOLE BUILD, counted from the handler's first line. The app polls a build for 6 minutes
 * (homeAddEmployer DEADLINE_MS), and after the AI this lane still ranks designs, waits on the usage lock (≤ 15 s)
 * and lays out thumbnails (≤ 20 s). So the letter — every try, every pause, every fallback model, every answer it
 * asks again for — must END inside these 4 minutes, whatever it waited on before: the writer's own budget is cut to
 * what is left of this window (coverLetterController.writeLegacyLetter `deadline`). The research runs BESIDE the
 * letter (≤ 25 s), inside the same window. Worst case: 240 s of AI + 15 s lock + 20 s thumbs ≈ 275 s, with the rest
 * of the 6 minutes left for the queue.
 *   windowMs   the AI deadline, from the handler's first line. A joiner that waited on a leader has spent part of it
 *              waiting, so the letter it writes after that leader failed has less time on purpose.
 * Read at call time; the suite shrinks it. Nothing in production writes it.
 */
const LETTER_AI = {
    windowMs: 4 * 60 * 1000,
};

/** The parsed upload's share of the fingerprint, capped (the writer reads the row itself — see letterFingerprintOf). */
const UPLOAD_CONTEXT_MAX = 24000;

// ── Letter thumbnails ────────────────────────────────────────────────────────────────────────────
// ⚠️ ON THE PERSISTENT VOLUME, IN A DOT DIRECTORY. temp/ is wiped by every deploy, and a letter's
// thumbs would then be re-rendered (serial chromium) on the first Home open after each release.
// uploads/ is the Railway volume — but express.static('uploads') serves it publicly at /uploads, and a
// thumb carries the user's name, email and phone. serve-static's default dotfiles:'ignore' answers 404
// for any path with a dot segment, so /uploads/.thumb_cache/… is never served. The resume doc thumbs
// share the scheme (file prefix differs: cl_ here), and each lane prunes only its own prefix.
const THUMB_ROOT = process.env.DOC_THUMB_CACHE_DIR || path.join(__dirname, '../../uploads/.thumb_cache');
const THUMB_W = 480;
const LETTER_THUMB_KEEP = 240;   // per user, cl_ files only (a page and its card) — ~17 letters with every design rendered
const CARDS_MAX = 3;             // renderPreviews launches one browser per batch; 3 pages is the safe batch
const PRERENDER_TOP = 2;
const PRERENDER_BUDGET_MS = 20 * 1000;

const HEX_RE = /^#[0-9a-f]{6}$/i;
const hexOrNull = (v) => (typeof v === 'string' && HEX_RE.test(v.trim()) ? v.trim().toLowerCase() : null);
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/**
 * Tell the client where a long build has got to — the same envelope resumeBuilderController's
 * makeReporter writes, so the Home overlay and the chip read both lanes with one parser.
 *
 * ⚠️ THE STAGE NAME IS THE TRUTH; THE PERCENTAGE IS A COURTESY. Most of the wall clock is one
 * non-streaming AI call, so the server says which stage it is in and that stage's ceiling, and the
 * client creeps toward it. It rides on updateJobPartialResult (async_jobs has no label column);
 * completeJob overwrites `result` with the real payload, which the client tells apart by `docId`.
 * Every write also bumps updated_at, which keeps requeueStuckJobs off a run that is merely slow.
 * A no-op in synchronous mode, where there is no job to report against.
 */
function makeReporter(req) {
    const jobId = req && req.__jobId;
    if (!jobId) return async () => {};
    let last = 0;
    return async (stage, label, pct) => {
        if (pct < last) return;                       // a bar must never walk backwards
        last = pct;
        try {
            await jobService.updateJobProgress(jobId, Math.round(pct));
            await jobService.updateJobPartialResult(jobId, { stage, label, pct: Math.round(pct) });
        } catch { /* progress is never worth failing the work for */ }
    };
}

// ── Inputs, normalised ONCE for the gate, the build and the stale label ─────────────────────────────

/** The employer spelling the money path and the cache key on. Same trim/cap as the resume gate. */
const cleanEmployer = (v) => String(v == null ? '' : v).trim().slice(0, 160);

/**
 * The job fields a letter is written from. Absent, null and non-strings all read as '' — the client's
 * build body, the gate body and the /employer-docs lookup spell "no posting" three different ways.
 */
function jobFieldsOf(raw) {
    const j = raw && typeof raw === 'object' ? raw : {};
    const s = (v) => (typeof v === 'string' ? v : '');
    return { title: s(j.title), url: s(j.url), description: s(j.description), website: s(j.website) };
}

/**
 * resume_metadata columns that describe the PARSE, not the résumé.
 * ⚠️ THESE MUST NEVER REACH THE FINGERPRINT: re-parsing an unchanged upload (a retry, a parser deploy)
 * would move it and the next letter for an employer the user already paid for would charge again.
 * The same rule as resumeBuilderController's UPLOAD_BOOKKEEPING — keep the two in step.
 */
const UPLOAD_BOOKKEEPING = new Set(['id', 'user_id', 'parse_status', 'parse_error', 'parsed_at', 'created_at', 'updated_at']);
const isUploadBookkeeping = (k) => UPLOAD_BOOKKEEPING.has(k) || /_at$/.test(k) || /^pars(e|ed|ing)_/.test(k);

/** An absent table or column is "no upload", not an outage (a strict caller must not 5xx for ever). */
const isMissingSchema = (e) => !!e && (e.code === '42P01' || e.code === '42703');

/** The parsed upload row, strictly: a real DB failure THROWS (the caller must not hash a guess). */
async function uploadedMetaFor(userId) {
    try {
        return await dbConfig.get(`SELECT * FROM resume_metadata WHERE user_id = $1 AND parse_status = 'done'`, [userId]);
    } catch (e) {
        if (isMissingSchema(e)) return null;
        throw e;
    }
}

/** The upload as the FINGERPRINT sees it — keys sorted, bookkeeping stripped, empties dropped, capped. (It fed this lane's
 *  own prompt too until 2026-09-18; the writer reads the row itself now. Unchanged: a change here moves every fingerprint.) */
function uploadContextOf(meta) {
    if (!meta || typeof meta !== 'object') return '';
    const rest = {};
    for (const k of Object.keys(meta).sort()) {
        if (isUploadBookkeeping(k)) continue;
        const v = meta[k];
        if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
        rest[k] = v;
    }
    return Object.keys(rest).length ? JSON.stringify(rest, null, 1).slice(0, UPLOAD_CONTEXT_MAX) : '';
}

/**
 * The candidate's own material — what the fingerprint hashes, what decides no_resume, and where a letter with no posting
 * takes its position from. null = they have no résumé. (The letter's WORDS are written from the Jobs lane's résumé
 * metadata — see buildEmployerLetter — which is the same upload row, with the Builder résumé merged in.)
 *
 * base: resumeScorer.narrativeFor({ base: true, strict: true }) — the résumé the user OWNS, never the
 *   row a tailored build last overwrote (tailoring must not compound across employers). strict: a DB
 *   failure THROWS instead of reading as "no résumé" (telling someone who has one to upload one is how
 *   they end up overwriting it).
 * upload: the parsed upload, as the resume doc lane feeds its prompt (includeUploadedResume). Skipped
 *   when the narrative already IS the upload — the same facts twice. Kept exactly so: it is a fingerprint input.
 */
async function candidateMaterialFor(userId, env) {
    const n = await scorerMod().narrativeFor(userId, { base: true, env, strict: true });
    if (!n || typeof n.text !== 'string' || n.text.trim().length < 80) return null;
    const meta = await uploadedMetaFor(userId);
    return { baseText: n.text, source: n.source, uploadText: n.source === 'upload' ? '' : uploadContextOf(meta), meta };
}

/**
 * The per-employer cache fingerprint of a letter — THE one definition (gate, build, stale label).
 *
 * Every input that can change the letter's WORDS: the base narrative, the parsed upload, the posting's title / text /
 * link, the website, the research revision and this lane's letter revision. (Since 2026-09-18 the words are written by
 * the Jobs section's generation — see "The letter itself" — from the parsed upload row with the Builder résumé merged
 * in, the posting and a research subject derived from the website: the same facts this hashes.)
 *
 * ⚠️ DELIBERATELY NOT HASHED — each for a reason that is about money:
 *   • the upload row's bookkeeping (ids, parse stamps): the writer is handed the whole row, as the Jobs lane hands it,
 *     but re-parsing an unchanged upload must not re-bill a letter (uploadContextOf strips them from this side).
 *   • the Builder résumé the writer merges in (builder_resume — the user_resumes row as it is NOW). The base narrative
 *     above is the résumé the user owns; after a tailored build that row is a copy of it ordered for another employer,
 *     which adds no facts. Hashed, every letter would turn "stale" the moment any tailored resume landed.
 *   • the research itself (only RESEARCH_REV) — its `conventions` included: a 30-day cache refresh, or
 *     conventions fetched onto an old cache row, must not re-bill every letter. It writes no word of the letter now
 *     (it ranks the designs and paints the brand); the letter researches the employer live, through grounding.
 *   • `country`: the writer's JOB LOCATION (which office leads the addresses, and whether the closing speaks of
 *     relocating), and the design ranking's region. A chip that learns its country later must still not make a
 *     finished letter stale or bill a Refresh; the user who wants it rewritten for the new country taps Refresh.
 *   • the candidate's name and contact details: the template prints them live from the profile.
 */
function letterFingerprintOf(material, job) {
    return employerDocsMod().fingerprint({
        baseText: [material.baseText, material.uploadText].join('\n'),
        jobText: [job.title, job.description, job.url, job.website].map((v) => String(v || '')).join('\n'),
        researchRev: `${LETTER_REV}|${researchMod().RESEARCH_REV}`,
    });
}

/**
 * currentLetterFingerprint(userId, { job, country, env }) → string | null
 * The fingerprint a letter build for these job fields would store right now — what
 * /api/employer-docs/current compares a stored letter against to label it stale. `env` may be a request
 * or an environment string. null when it cannot be told (no résumé, an unreadable read, a missing
 * module) — never a guess, and never a throw: the label is a courtesy, the document is shown anyway.
 * `country` is accepted for the contract and intentionally not hashed (see letterFingerprintOf).
 */
async function currentLetterFingerprint(userId, { job, country, env } = {}) {
    void country;
    try {
        if (!userId) return null;
        const material = await candidateMaterialFor(userId, downloads.envOf(env));
        return material ? letterFingerprintOf(material, jobFieldsOf(job)) : null;
    } catch (e) {
        console.warn('[employerLetter] current fingerprint unreadable:', e.message);
        return null;
    }
}

/** A stored letter that can actually be shown and rendered. */
const usableLetter = (doc) => !!(doc && doc.payload && typeof doc.payload.coverLetterHtml === 'string'
    && doc.payload.coverLetterHtml.trim());

/**
 * The employer's website we may RESEARCH, or ''.
 * ⚠️ A JOB BOARD IS NOT AN EMPLOYER. Researching instahyre.com or a Workday tenant wrote letters about
 * the board (the legacy lane's AGGREGATOR_HOST bug). discoverController.websiteOf is the app's one
 * answer to "is this host the employer's own site?". A posting's host counts only when the employer's
 * name owns it (amazon.jobs for Amazon), never a recruiter's or a group portal's.
 */
function researchSiteFor(company, job) {
    try {
        const disc = require('./discoverController');
        const typed = typeof disc.websiteOf === 'function' ? disc.websiteOf(job.website, company) : null;
        if (typed) return typed;
        let host = '';
        try { host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(job.url) ? job.url : `https://${job.url}`).hostname; } catch { host = ''; }
        host = host.toLowerCase().replace(/^www\./, '');
        if (host && typeof disc.ownsHost === 'function' && disc.ownsHost(company, host)) {
            return disc.websiteOf(host, company) || '';
        }
    } catch (e) { console.warn('[employerLetter] website vetting unavailable:', e.message); }
    return '';
}

/** The builder resume JSON, for seniority only — tailoring never moves experience dates. */
async function builderResumeFor(userId) {
    try {
        const r = await dbConfig.get('SELECT resume_data FROM user_resumes WHERE user_id = $1', [userId]);
        const rd = r && r.resume_data;
        return typeof rd === 'string' ? JSON.parse(rd) : (rd && typeof rd === 'object' ? rd : null);
    } catch { return null; }
}

// ── Money ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Would a pass pay for this employer's AI cover letter? The READ-ONLY twin of
 * downloads.passCoversGeneration(…, 'cover_letter', …) — resumeBuilderController.passWouldCoverResume
 * for the letter column.
 * ⚠️ passCoversGeneration with boundOnly=false is a RESERVATION (it binds the oldest unspent pass to this
 * employer with an UPDATE). From a dry run that would spend the one company a pass buys on a company
 * the user merely looked at. So the same two questions, from reads alone, clause for clause:
 *   1. a pass ALREADY bound to this employer (alias-aware) whose letter is unused → covered;
 *   2. only when boundOnly is false: a TAKEABLE pass — the reservation's exact sub-select WHERE.
 * A nameless employer is never covered; an unreadable pass is not a pass.
 * ⚠️ If downloads.passCoversGeneration's selection ever changes, this must change with it.
 */
async function passWouldCoverLetter(userId, employer, req, { boundOnly }) {
    if (downloads.employerKeyOf(employer) === downloads.NONE) return false;
    const env = downloads.envOf(req);
    try {
        const owned = await downloads.boundPassFor(userId, employer, env);
        if (owned) {
            const free = await dbConfig.get(
                `SELECT id FROM download_passes WHERE id = $1 AND letter_generated_at IS NULL LIMIT 1`, [owned.id]);
            if (free) return true;
        }
        if (boundOnly) return false;
        const takeable = await dbConfig.get(
            `SELECT id FROM download_passes
              WHERE user_id = $1 AND environment = $2 AND letter_generated_at IS NULL
                AND (bound_at IS NULL OR employer_key = $3)
              LIMIT 1`, [userId, env, downloads.NONE]);
        return !!takeable;
    } catch { return false; }
}

/**
 * FALLBACK ONLY — credit-lane verification for an entitlements.consumeOnSuccess that predates its own
 * `charge` answer (contract: { via, charge, ledgerId }). The build decides on `used.charge` whenever it is
 * present; these marks are read before consuming only so an older entitlements still cannot store an
 * unpaid letter.
 * ⚠️ { via: 'credits' } IS WHAT WAS ATTEMPTED, NOT WHAT WAS PAID: chargeCredits answers insufficient
 * without throwing, and the ledger row is written either way. A credits ledger row with no paid history
 * row since the mark reads as unpaid — conservative (never invents a payment), but it CAN under-report
 * one: another credits charge overlapping the window made a letter the user had really paid for read as
 * unpaid, and it was thrown away unrefunded. That is why it is no longer what decides.
 */
async function creditMarksFor(userId) {
    try {
        const h = await dbConfig.get('SELECT COALESCE(MAX(id), 0) AS id FROM credit_usage_history WHERE user_id = $1', [userId]);
        const l = await dbConfig.get('SELECT COALESCE(MAX(id), 0) AS id FROM usage_ledger WHERE user_id = $1', [userId]);
        return { h: Number(h && h.id) || 0, l: Number(l && l.id) || 0 };
    } catch (e) { console.warn('[employerLetter] credit marks unreadable:', e.message); return null; }
}
async function creditsDeductedSince(userId, marks) {
    if (!marks) return { paid: false, cost: 0 };
    try {
        const h = await dbConfig.get(
            `SELECT COUNT(*)::int AS n, COALESCE(MAX(credits_used), 0)::int AS cost FROM credit_usage_history
              WHERE user_id = $1 AND id > $2 AND action_type = 'cover_letter_generate' AND credits_used > 0`, [userId, marks.h]);
        const l = await dbConfig.get(
            `SELECT COUNT(*)::int AS n FROM usage_ledger
              WHERE user_id = $1 AND id > $2 AND kind = 'cover_letter' AND source = 'credits'`, [userId, marks.l]);
        const paidRows = Number(h && h.n) || 0, owedRows = Number(l && l.n) || 0;
        return { paid: owedRows >= 1 && paidRows >= owedRows, cost: Number(h && h.cost) || 0 };
    } catch (e) { console.warn('[employerLetter] credit verification unreadable:', e.message); return { paid: false, cost: 0 }; }
}

/**
 * Run `fn` holding this user's usage lock for `kind`: ONE payment decision at a time per (user, kind).
 *
 * ⚠️ canConsumeMany CHECKS AND NEVER RESERVES. Two covered letters landing together (Home runs several
 * builds at once) both read "1 unit left" at the coveredOnly re-check, and both consumeOnSuccess'd a
 * plan row — the allowance overspent by one. Under this lock the second re-checks AFTER the first one's
 * ledger row exists, and loses cleanly: 402, nothing charged, nothing stored.
 * ⚠️ THE LOCK IS ALL THE TRANSACTION HOLDS. The work inside runs on the pool (entitlements, downloads and
 * employerDocs have no transaction surface), so each write commits the moment it lands — which is exactly
 * what the NEXT holder has to see — and NOTHING is rolled back when this transaction fails. The caller
 * records every charge the moment it happens and gives it back itself (giveBackLetterCharge).
 * ⚠️ THE KEY IS SHARED: hashtext('usage:' || kind) + the user id, spelled exactly as resumeBuilderController's
 * withUsageLock spells it. Another lane serialises against this one only by taking that same key.
 * The wait is bounded (lock_timeout): a holder stuck that long means the database is in trouble, and the
 * waiter fails closed — nothing charged — instead of hanging the build while holding a pooled client.
 * A db layer without withTransaction (a stub) runs `fn` unserialised, and says so once.
 */
let warnedUnserialised = false;
async function withUsageLock(userId, kind, fn) {
    if (typeof dbConfig.withTransaction !== 'function') {
        if (!warnedUnserialised) {
            warnedUnserialised = true;
            console.warn('[employerLetter] dbConfig.withTransaction unavailable — letter payments are NOT serialised');
        }
        return fn();
    }
    return dbConfig.withTransaction(async (tx) => {
        await tx.get(`SET LOCAL lock_timeout = '15s'`);
        await tx.get(`SELECT pg_advisory_xact_lock(hashtext('usage:' || $1::text), $2::int)`, [kind, userId]);
        return fn();
    });
}

/**
 * Give back every charge ONE letter build made, because it will not deliver the letter it charged for (a
 * refusal after payment, an unconfirmed charge, a letter that could not be stored). Never throws: each step
 * runs on its own, and one that fails is logged loudly for support — never retried blindly, since a refund
 * applied twice is money handed out. `took` is emptied as it goes, so a second call is a no-op.
 *   • credits — refundCredits with this build's OWN charge result, never a re-read balance;
 *   • a pass  — the letter generation this build stamped (claimGeneration's passId) is un-stamped. The pass
 *               stays bound to this employer: that is the company being written for, and the gate's
 *               reservation bound it before the AI ran anyway;
 *   • the usage_ledger row this build inserted — deleted. usedSince counts rows, so on the plan / trial
 *               lanes this is what hands the unit back; on the credits lane it keeps Usage honest.
 * ⚠️ ONLY WHAT THIS BUILD TOOK — by the ids its own claim and consume returned. Clearing a column another
 * letter spent, or deleting another build's row, would hand out a free letter.
 */
async function giveBackLetterCharge(userId, took, why) {
    if (!took) return;
    if (took.credits && took.credits.charged) {
        const cost = Number(took.credits.cost) || 0;
        took.credits = null;
        try {
            const { refundCredits } = require('../services/eventCosts');
            if (typeof refundCredits !== 'function') throw new Error('refundCredits unavailable');
            await refundCredits(userId, 'cover_letter_generate', { charged: true, cost });
            console.warn(`[employerLetter] ${cost} credit(s) given back to user ${userId} (${why})`);
        } catch (e) {
            console.error(`[employerLetter] ⚠️ CREDITS NOT GIVEN BACK — user ${userId}, ${cost} credit(s) (${why}) — support must make this good:`, e.message);
        }
    }
    if (took.passId) {
        const passId = took.passId;
        took.passId = null;
        try {
            await dbConfig.run('UPDATE download_passes SET letter_generated_at = NULL WHERE id = $1 AND user_id = $2', [passId, userId]);
            console.warn(`[employerLetter] pass ${passId}'s letter generation given back to user ${userId} (${why})`);
        } catch (e) {
            console.error(`[employerLetter] ⚠️ PASS NOT GIVEN BACK — user ${userId}, pass ${passId} (${why}) — support must make this good:`, e.message);
        }
    }
    if (took.ledgerId) {
        const ledgerId = took.ledgerId;
        took.ledgerId = null;
        try {
            await dbConfig.run('DELETE FROM usage_ledger WHERE id = $1 AND user_id = $2', [ledgerId, userId]);
        } catch (e) {
            console.error(`[employerLetter] ⚠️ USAGE ROW NOT GIVEN BACK — user ${userId}, usage_ledger ${ledgerId} (${why}) — support must make this good:`, e.message);
        }
    }
}

/**
 * contract C2 — the one answer for "what would pay for this letter is not what you confirmed".
 *
 * Home asks before it spends: the sheet names the payer ("Covered by your one-time pass for Acme", "2 of 3
 * free cover letters left") and the build the user confirms sends that word back as `expectVia`. Between the
 * two, a plan can lapse, a parallel build can take the last unit, another tap can spend the pass. Charging
 * the payer that is left is charging for something nobody agreed to — so the build is refused instead.
 * ⚠️ NOTHING BOUND, NOTHING CHARGED, NOTHING STORED on this path, ever. Whatever this build had already
 * taken when it found out goes back first (giveBackLetterCharge).
 * ⚠️ 409, NOT 402: this is not "you are out of allowance", it is "ask again". The app re-reads the gate and
 * puts the sheet back up with what the letter would really cost now, instead of sending anyone to Plans.
 */
const PAYER_CHANGED = Object.freeze({
    status: 409,
    body: Object.freeze({
        success: false, reason: 'payer_changed',
        error: 'What pays for this cover letter changed after you confirmed it. Check it and confirm again.',
    }),
});

/**
 * contract C2 — the answer for a build confirmed as a FREE one ("it is already written") that no longer is:
 * the résumé or the posting moved between the gate and the build, so writing it now would cost something the
 * user was never asked about. Refused before every gate — no reservation, no AI, no charge.
 */
const CACHE_MISS = Object.freeze({
    status: 409,
    body: Object.freeze({
        success: false, reason: 'cache_miss',
        error: 'Your saved cover letter for this employer has changed. Check what writing it again would use, then confirm.',
    }),
});

/** The one answer for "the plan stopped covering this letter while it was being written". */
const LOST_COVER = Object.freeze({
    status: 402,
    body: Object.freeze({
        success: false, reason: 'quota_exhausted',
        error: 'Your plan allowance was used up while this cover letter was being written. Open Plans & Usage to continue.',
    }),
});

/**
 * The two answers for "Google could not write this letter" — aiText's final AiUnavailableError, after it waited,
 * retried and walked every fallback model (2026-09-18: Amazon's letter answered "That cover letter didn't finish"
 * on a 503 "high demand" day, and said nothing about what it cost).
 *   AI_BUSY  every model busy, hung or out of time: a provider overload. Worth a Try again in a minute.
 *   AI_DOWN  quota or auth: the key itself is refused (the operator is paged by aiHealth). No Try again can fix it.
 * ⚠️ "NOTHING WAS CHARGED" IS A PROMISE, and it is true only because every AI call in this lane runs BEFORE
 * withUsageLock. The build's catch answers these only while chargedAt is still 0 — never after a charge.
 * ⚠️ 503, and a reason of its own: an older app maps an unknown reason to 'failed' and shows `error`, which says
 * the same thing; the current one reads the reason and offers Try again only for ai_busy (useHomeBuilds RETRYABLE).
 * Any OTHER failure — answers the writer could not use three times over, every model truncated — keeps the 500 /
 * 504 it always had. The words are the Jobs lane's own refusals (coverLetterController LEGACY_AI_BUSY / _DOWN), letter
 * for letter, so a user reads one story whichever screen they wrote from.
 */
const AI_BUSY = Object.freeze({
    status: 503,
    body: Object.freeze({
        success: false, reason: 'ai_busy', retryable: true,
        error: "Google's AI is overloaded right now, so your cover letter could not be written. Nothing was charged — please try again in a minute.",
    }),
});
const AI_DOWN = Object.freeze({
    status: 503,
    body: Object.freeze({
        success: false, reason: 'ai_down', retryable: false,
        error: 'Our AI provider is unavailable right now. Nothing was charged.',
    }),
});

/**
 * AI_BUSY / AI_DOWN for the letter writer's refusal, or null for anything else. The writer
 * (coverLetterController.writeLegacyLetter) has already turned aiText's final AiUnavailableError into its
 * reason — 'ai_busy' (every model busy, hung or out of time) or 'ai_down' (quota / auth: the key itself) — with the
 * cause attached; kind 'other' (every model truncated, or refused the request) stays its "could not finish", which is
 * not an outage.
 */
function aiEndingOf(e) {
    if (!e) return null;
    if (e.reason === 'ai_busy') return AI_BUSY;
    if (e.reason === 'ai_down') return AI_DOWN;
    return null;
}

// ── The letter itself ────────────────────────────────────────────────────────────────────────────
//
// ⚠️ WRITTEN BY THE JOBS SECTION'S GENERATION (2026-09-18, the owner's decision: "we have a prompt/api that is already
// written on the jobs section and that used to generate good cover letters with project details and clients and hence
// we finalized that… we need to use the same one… and not the new one"). This lane used to build a prompt of its own
// (buildEmployerLetterPrompt — a cached research block, the hiring conventions, the country's letter habits, a register
// and a length band) and ask it with NO live search. v2's finalized prompt researches the employer itself through Google
// Search grounding — that is where the named projects, products and clients come from — and a letter written from Home
// must read like the one the Jobs section writes for the same job. So the WORDS are now written by coverLetterController's
// own functions, called from here and never copied (see that file's THE ONE LETTER WRITER):
//   letterResumeMetadataFor  the résumé the Jobs lane writes from: the parsed upload + the Builder résumé
//   letterResearchSubjectOf  who is researched: the website — the company's name when the only URL is a job board
//   letterListingOf          the posting, when there is one (the pasted link and text)
//   writeLegacyLetter        v2's buildPrompt, the grounding, v2's config, the letter chain, the parsing, the retries
//   letterDetailsOf          the answer → the addressee, the subject, the offices and the letter's HTML
// Everything AROUND the words stays this lane's own: the gate, the cache, the flights, the money, the stored document,
// the design ranking, the brand and the thumbnails. The employer research below writes no word of the letter any more —
// it ranks the designs and paints the brand.
// ⚠️ THE PLACEHOLDER GUARD, ITS CORRECTIVE PASS AND THE SALUTATION STRIP WENT WITH THE OLD PROMPT. They answered that
// prompt's failure modes ("[X%]" from a model with no facts to cite; a "Dear …" it had been told not to write), and
// the corrective pass re-sent that prompt. The Jobs lane's parsing is the one both screens share now: a clean-up on one
// screen alone would be a letter that reads differently on the other.

/** research.conventions when it is a usable object, else null (an old cache row or an old research module). */
const conventionsOf = (facts) => (facts && facts.conventions && typeof facts.conventions === 'object'
    && !Array.isArray(facts.conventions) ? facts.conventions : null);

/**
 * The convention region: regionForConventions — the chip's own country first, then the research's role country,
 * the website's TLD, the research's HQ country, a region word, 'generic' (regionFromCountry.resolveRegion's one
 * chain) — designFit.regionFor for a research module that predates it. Never throws.
 */
function letterRegionFor(research, designFit, conventions, { country, website }) {
    try {
        if (research && typeof research.regionForConventions === 'function') {
            const r = research.regionForConventions(conventions, { country, website });
            if (typeof r === 'string' && r) return r;
        }
    } catch (e) { console.warn('[employerLetter] regionForConventions failed:', e.message); }
    try { return designFit.regionFor({ country, website }); } catch { return 'generic'; }
}

/**
 * Placeholder tokens: [X%], [Insert metric], [Company Name], {your name}, bare XX% / X% / $X / $XX,XXX, "N years".
 * Read by cleanPosition: a role title that IS a slot ("[Position]", "[Job Title]") is no title, so it never reaches the
 * letter's Target Position, the stored payload or the subject.
 * ⚠️ A BRACKET IS NOT A PLACEHOLDER FOR BEING A BRACKET. The old rule called any bracket a slot when a %, $ or # or a
 * lone X/N or a slot word appeared ANYWHERE inside: "[top 5%]", "[CGPA 8.4 / 85%]", "[Class X]", "[C#]", "[Team Lead]"
 * and "[Name Service]" were all cut out of finished letters. A bracket's inside (see isLetterSlot) is a slot only when
 * it is nothing but a slot. The resume doc lane's isPlaceholderInside answers the same question for resumes — keep the
 * two in step.
 */
// Opens like an instruction to whoever fills the template in: [Insert …], [Add …], [Your …], [Number of …].
// ⚠️ A space (or the end) must follow: "[Add-on]" and "[Insertion sort]" are the candidate's words.
const SLOT_INSTRUCTION_RE = /^(?:insert|add|enter|include|specify|describe|mention|your|number of|amount of|percentage of)(?:\s|$)/i;
// Nothing but an unknown-number marker: [X], [XX], [N], [$X], [€XX k], [X+], [$XX,XXX], [X years].
const SLOT_MARKER_RE = /^[$€£₹]?\s?(?:x{1,4}(?:,x{3})*|n)\s?(?:%|[kmb]|\+)?(?:\s+(?:years?|yrs|months?))?$/i;
// Nothing but a slot noun: [Company Name], [Hiring Manager's Name], [Position], [Job Title], [City].
const SLOT_NOUN_RE = /^(?:the\s+)?(?:company|employer|organi[sz]ation|hiring\s+manager|manager|recruiter|recipient|candidate|position|role|(?:job|role|position)\s+title|title|team|department|industry|product|client|field|city|location|address|date|number|metric|amount|percent(?:age)?|name|full\s+name)(?:['’]s)?(?:\s+name)?$/i;

function isLetterSlot(inside) {
    const s = String(inside || '').trim();
    if (!s || s.length > 80) return false;
    // A long bracket is a sentence the candidate wrote, unless it is an instruction to fill something in.
    if (s.length > 40) return SLOT_INSTRUCTION_RE.test(s);
    return (s.includes('%') && !/\d/.test(s))       // [X%], [XX %] — never [top 5%] or [CGPA 8.4 / 85%]
        || SLOT_MARKER_RE.test(s)
        || SLOT_INSTRUCTION_RE.test(s)
        || SLOT_NOUN_RE.test(s);
}

function findLetterPlaceholders(text) {
    const s = String(text || '');
    const out = new Set();
    const slots = [];   // [start, end) of each bracket token found — its inside is not a second token
    const bracketed = (re) => {
        for (const m of s.matchAll(re)) {
            if (!isLetterSlot(m[0].slice(1, -1))) continue;
            out.add(m[0]);
            slots.push([m.index, m.index + m[0].length]);
        }
    };
    bracketed(/\[[^\[\]\n]{1,80}\]/g);
    bracketed(/\{[^{}\n]{1,80}\}/g);
    // Bare markers are never real text, wherever they stand — even inside a bracket that is not itself a
    // slot ("[5 years, X%]"). Only the inside of a bracket token already found is skipped: "[X%]" is ONE token.
    for (const m of s.matchAll(/(?<![\w$])[Xx]{1,3}\s?%|\$\s?X{1,3}(?:,X{3})*\b|(?<!\w)[XN]\+?\s+(?:years|yrs)\b/g)) {
        if (!slots.some(([a, b]) => m.index >= a && m.index < b)) out.add(m[0]);
    }
    return [...out];
}

/**
 * A role title fit for the letter — v2's Target Position, the stored payload's position — or ''. Real parentheses
 * survive ("Software Engineer (m/w/d)" is how a German posting is titled); an "(open application)"-style artefact, a
 * placeholder or a stray bracket does not.
 */
function cleanPosition(raw) {
    let s = String(raw || '').replace(/\s+/g, ' ').trim();
    s = s.replace(/\([^)]*\b(open|general|speculative|unsolicited|spontaneous|initiative)\b[^)]*\)/gi, ' ');
    if (findLetterPlaceholders(s).length) return '';
    s = s.replace(/[\[\]{}<>]/g, ' ').replace(/\(\s*\)/g, ' ').replace(/\s+/g, ' ').trim();
    if (/\b(open|general|speculative|unsolicited|spontaneous)\s+application\b/i.test(s)) return '';
    if (/^(n\/?a|none|null|unknown|position|role|job|tbd|various|any|hiring manager)$/i.test(s)) return '';
    return s.slice(0, 120).trim();
}

const TECH_ROLE_RE = /\b(engineer|engineering|developer|software|devops|sre|data|machine learning|ml|ai|scientist|architect|programmer|technical|it|security|cloud|backend|frontend|full[- ]?stack|qa|firmware|embedded)\b/i;

// ── Thumbnails ───────────────────────────────────────────────────────────────────────────────────

/** The data-URI type of cached bytes, from the bytes: a WebP (RIFF…WEBP) or, as every card and every older page is, a JPEG. */
const imageMimeOf = (buf) => (Buffer.isBuffer(buf) && buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF'
    && buf.toString('latin1', 8, 12) === 'WEBP' ? 'image/webp' : 'image/jpeg');

const thumbDirOf = (userId) => path.join(THUMB_ROOT, String(Math.max(0, Math.floor(Number(userId) || 0))));

/** The profile photo's identity (path + mtime) — only the branded 'standard' letter draws it. */
async function photoVersionOf(userId) {
    try {
        const u = await dbConfig.get('SELECT photo_path FROM users WHERE id = $1', [userId]);
        if (!u || !u.photo_path) return 'none';
        return `${u.photo_path}:${(await fs.stat(path.join(__dirname, '../../', u.photo_path))).mtimeMs}`;
    } catch { return 'none'; }
}

/** Keep the most recently USED LETTER_THUMB_KEEP cl_ thumbs per user (reads touch mtime). Never throws. */
async function pruneLetterThumbs(userId) {
    try {
        const dir = thumbDirOf(userId);
        const names = (await fs.readdir(dir)).filter((n) => n.startsWith('cl_') && n.endsWith('.jpg'));
        if (names.length <= LETTER_THUMB_KEEP) return;
        const stamped = await Promise.all(names.map(async (nm) => {
            try { return { nm, at: (await fs.stat(path.join(dir, nm))).mtimeMs }; } catch { return { nm, at: 0 }; }
        }));
        stamped.sort((a, b) => b.at - a.at);
        for (const { nm } of stamped.slice(LETTER_THUMB_KEEP)) fs.unlink(path.join(dir, nm)).catch(() => {});
    } catch { /* an over-full cache is not worth an error */ }
}

/**
 * Cards — or full pages — for a stored letter: [{ id, name, accent, image, fit, reason }] in the order of `ids`.
 *
 * ⚠️ THE IMAGE MUST BE THE FILE THEY WOULD DOWNLOAD. Same data as generate-template-pdf: the payload's
 * html/company/address, the live sender block (buildCLSender), the employer's brand (its colour recolours
 * EVERY design's accent and its Google font sets the type — letterBrandOf, the same reading the downloads
 * use) and — for the branded design — the profile photo. So every one of those is in the cache key: the
 * doc version (id + updated_at, which a PUT edit moves), the sender block's hash (a renamed user must not
 * keep their old name on every card), a hash of the brand pair (a letter whose brand changed — a design
 * re-stored, a research row that learned its colour — must not keep the old tint), and for 'standard'
 * the photo version. Renders only what is missing, in ONE browser batch. Unrenderable ids are simply absent.
 *
 * ⚠️ A PAGE AND ITS CARD (2026-09-18: "the preview … looks very blurry on zoom … specially for cover letter"). Only the
 * 480-px card used to be stored, and it was ALSO what the letter gallery showed and let the user pinch-zoom to 3x — a
 * 480-px JPEG, blown up. The résumé lane has kept the full page since 2026-09-15; this lane now does too:
 *   size 'page'   the renderer's page, untouched — for a screen that shows the letter at full size (the gallery);
 *   size 'card'   the 480-px card derived from that page with sharp — Home's cards (the default, what they always got).
 * One render writes both (the card under the page's name suffixed .w480), so the build's pre-render is the gallery's
 * first page as well as Home's card. Without sharp, or on bytes it cannot read, the page itself is served as the card —
 * heavier but correct — and no card file is written.
 * ⚠️ coverLetterRenderer.PREVIEW_REV is in the key: the resolution and format a page was rendered at. A page (or a
 * card cut from it) rendered before a change of resolution is never served after it; old files keep their names and
 * leave through pruneLetterThumbs' LRU like any other unused file.
 * ⚠️ ".jpg" IS THIS CACHE'S NAMING SCHEME, NOT ITS FORMAT. A page is whatever the renderer produced (a WebP since
 * PREVIEW_REV hd1; its JPEG when sharp is unavailable there), so the data URI takes its type from the BYTES
 * (imageMimeOf), never from the name. A card is always a real 480-px JPEG.
 */
async function letterCardsFor(userId, doc, ids, design, { size = 'card' } = {}) {
    const cl = clMod();
    const p = doc.payload || {};
    const tpls = [...new Set(ids)].map((id) => clTemplates.TEMPLATES.find((t) => t.id === id)).filter(Boolean);
    if (!tpls.length) return [];
    const wantPage = size === 'page';
    // The sender block THIS letter prints: the profile with the letter's own overrides laid over it (its customization
    // page — coverLetterController.senderForLetter, the reading its PDF and Word file make), so a card is the file.
    // ⚠️ The hash is of that MERGED block: an override changes the key, and a letter with none hashes exactly as before
    // (mergeLetterSender keeps buildCLSender's key order) — no stored card is thrown away. Its greeting / closing ride in
    // `data`; a PUT that changes them moves updated_at, which is in the key already.
    const sender = await cl.senderForLetter(userId, p);
    const senderHash = sha(JSON.stringify(sender)).slice(0, 24);
    const branded = tpls.some((t) => t.generic);
    const companyName = p.companyName || doc.employer_name || '';
    const photoVer = branded ? await photoVersionOf(userId) : 'none';
    const brand = letterBrandOfDoc(cl, doc);
    // The generic design's colour, exactly as its PDF resolves it: the letter's brand, else the legacy
    // employer_brand_profiles lookup by name (a letter from before research carried a colour).
    const accent = (brand && brand.accent)
        || (branded ? hexOrNull(await cl.lookupBrandColor(companyName, '').catch(() => null)) : null);
    const brandFont = (brand && brand.font) || null;
    const brandHash = sha(JSON.stringify({ accent: accent || null, font: brandFont })).slice(0, 16);
    const updatedMs = new Date(doc.updated_at || 0).getTime() || 0;
    const previewRev = String(clRenderer.PREVIEW_REV || '');   // read per call: the renderer owns it
    const dir = thumbDirOf(userId);
    const pageOf = (t) => path.join(dir, `cl_${sha(['cl', userId, doc.id, updatedMs, t.id, senderHash, brandHash,
        t.generic ? photoVer : '-', previewRev].join('|'))}.jpg`);
    const cardOf = (page) => page.replace(/\.jpg$/, `.w${THUMB_W}.jpg`);
    const uriOf = (buf) => `data:${imageMimeOf(buf)};base64,${buf.toString('base64')}`;
    const read = (file) => fs.readFile(file).then((buf) => (buf && buf.length ? buf : null), () => null);
    // LRU: a card or page still being shown stays cached (reads touch mtime), and a card keeps its page alive.
    const touch = (...files) => { const now = new Date(); for (const f of files) fs.utimes(f, now, now).catch(() => {}); };
    // Written aside then renamed: a request racing this write never reads half a JPEG.
    const write = async (file, buf) => {
        const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
        await fs.writeFile(tmp, buf).then(() => fs.rename(tmp, file)).catch(() => fs.unlink(tmp).catch(() => {}));
    };
    /** The card of a page — written beside it — or the page itself when sharp cannot make one. */
    const cardFrom = async (page, full) => {
        let card = null;
        try { card = await require('sharp')(full).resize({ width: THUMB_W }).jpeg({ quality: 80 }).toBuffer(); }
        catch { /* sharp unavailable, or bytes it cannot read → the page; heavier but correct */ }
        if (card) await write(cardOf(page), card);
        return card || full;
    };

    const images = new Map();
    const missing = [];
    for (const t of tpls) {
        const page = pageOf(t);
        if (!wantPage) {
            const card = await read(cardOf(page));
            if (card) { images.set(t.id, uriOf(card)); touch(cardOf(page), page); continue; }
        }
        const full = await read(page);
        if (!full) { missing.push(t); continue; }
        touch(page);
        images.set(t.id, uriOf(wantPage ? full : await cardFrom(page, full)));
    }
    if (missing.length) {
        try {
            const photo = missing.some((t) => t.generic) ? await cl.loadCLPhotoDataUri(userId) : null;
            const data = { sender, company: { name: companyName, address: p.companyAddress || '' }, bodyHtml: p.coverLetterHtml, ...cl.letterLinesOf(p) };
            const rendered = await clRenderer.renderPreviews(data, { photo, brandColor: accent, brandFont }, missing);
            await fs.mkdir(dir, { recursive: true });
            for (const r of rendered || []) {
                const t = missing.find((m) => m.id === r.id);
                if (!t || !r.image) continue;
                const full = Buffer.from(String(r.image).split(',')[1] || '', 'base64');
                if (!full.length) continue;
                const page = pageOf(t);
                await write(page, full);
                const card = await cardFrom(page, full);   // both, whichever was asked: the next ask is a hit
                images.set(t.id, uriOf(wantPage ? full : card));
            }
            pruneLetterThumbs(userId);   // fire and forget
        } catch (e) {
            console.warn(`[employerLetter] letter thumbs failed for doc ${doc.id}:`, e.message);
        }
    }
    const rank = new Map(((design && design.ranked) || []).map((r) => [r.id, r]));
    return tpls.filter((t) => images.has(t.id)).map((t) => {
        const r = rank.get(t.id);
        return {
            id: t.id, name: t.name, accent: t.accent, image: images.get(t.id),
            fit: r && Number.isFinite(Number(r.score)) ? Math.round(Number(r.score)) : null,
            reason: (r && r.reason) || null,
        };
    });
}

/**
 * A stored letter's design: the stored one repaired, else a rule-only ranking computed (not stored).
 * Either way it carries `brand` (letterBrandOf): normaliseDesign keeps only the keys it knows, so the
 * stored design.brand is put back on the repaired copy — a card's tint must not depend on which path
 * produced its design.
 */
async function designOfLetterDoc(userId, doc) {
    const fit = designFitMod();
    const brand = letterBrandOfDoc(clMod(), doc);
    const repaired = fit.normaliseDesign(doc.design, 'cover_letter');
    if (repaired) return withDesignBrand(repaired, brand);
    const research = doc.research && typeof doc.research === 'object' ? doc.research : {};
    const p = doc.payload || {};
    const resume = await builderResumeFor(userId);
    const conventions = conventionsOf(research);
    return withDesignBrand(fit.rankLetterDesigns({
        region: letterRegionFor(researchMod(), fit, conventions, { country: null, website: research.domain || '' }),
        seniorityYears: resume ? fit.seniorityYearsOf(resume) : 0,
        industry: research.industry || null,
        companySize: research.companySize || null,
        isTechnicalRole: TECH_ROLE_RE.test([doc.job_title, p.position].filter(Boolean).join(' ')),
        brandColor: (brand && brand.accent) || hexOrNull(p.brandColor) || hexOrNull(research.brandColor),
        conventions,
        employerType: (conventions && conventions.employerType) || null,
    }), brand);
}

// ── The employer's brand on the letter ───────────────────────────────────────────────────────────
// { accent: '#hex'|null, font: { family, google }|null } | null. coverLetterController owns the reading
// (researchBrandOf for a research result, letterBrandOf for a saved letter) because the DOWNLOADS live
// there and the cards must render exactly what they download; this file only stores it (design.brand)
// and passes it on. Both calls are defensive: a coverLetterController from before the brand slice, or a
// throw, is "no brand" — the letter renders in the design's own colours, never fails.
function brandOfResearch(cl, research) {
    try { return cl && typeof cl.researchBrandOf === 'function' ? (cl.researchBrandOf(research) || null) : null; }
    catch (e) { console.warn('[employerLetter] research brand unreadable:', e.message); return null; }
}
function letterBrandOfDoc(cl, doc) {
    try { return cl && typeof cl.letterBrandOf === 'function' ? (cl.letterBrandOf(doc) || null) : null; }
    catch (e) { console.warn('[employerLetter] letter brand unreadable:', e.message); return null; }
}
/**
 * A loaded letter with the shared row's brand laid over its research when it has none of its own
 * (coverLetterController.withSharedLetterBrand — one read-only SELECT, never a write, never a call that
 * bills). Same defensive shape: an older coverLetterController, or a throw, hands the doc back untouched.
 */
async function withSharedLetterBrand(cl, doc) {
    try { return cl && typeof cl.withSharedLetterBrand === 'function' ? ((await cl.withSharedLetterBrand(doc)) || doc) : doc; }
    catch (e) { console.warn('[employerLetter] shared brand unreadable:', e.message); return doc; }
}
/** design.brand = the pair (or null) on a copy — a design that is not an object is left alone. */
function withDesignBrand(design, brand) {
    if (!design || typeof design !== 'object') return design;
    return { ...design, brand: brand && typeof brand === 'object' ? { accent: brand.accent || null, font: brand.font || null } : null };
}

/**
 * normaliseDesign keeps the fields it knows. A designFit whose normaliseDesign predates contract 2 would drop
 * aiFamilies / conventionsSummary — the two fields that let a stored design be RE-RANKED later for free —
 * so they are carried over from the raw ranking only when the normalised design has no such key at all
 * (never over a value normaliseDesign chose), shape-checked, summary ≤ 120 chars.
 */
function withConventionFields(normalised, raw) {
    if (!normalised || typeof normalised !== 'object' || !raw || typeof raw !== 'object') return normalised;
    const out = { ...normalised };
    const has = (k) => Object.prototype.hasOwnProperty.call(out, k);
    if (!has('aiFamilies')) {
        const a = raw.aiFamilies;
        out.aiFamilies = a && typeof a === 'object' && !Array.isArray(a) ? a : null;
    }
    if (!has('conventionsSummary')) {
        const c = typeof raw.conventionsSummary === 'string' ? raw.conventionsSummary.replace(/\s+/g, ' ').trim() : '';
        out.conventionsSummary = c ? c.slice(0, 120) : null;
    }
    return out;
}

/**
 * The confirm sheet's numbers (contract 3): { usage, pass } — both null-safe, both READ-ONLY.
 *   usage: entitlements.usageFor(userId, 'cover_letter', req) as it answers, or null (a missing export, a throw).
 *   pass:  downloads.passStateFor(userId, employer, req, { kind: 'cover_letter' }) → { available, forThisEmployer }. An entitlements /
 *          downloads that predates it falls back to passWouldCoverLetter — the letter column's read-only twin
 *          — for the same two questions. null when neither can answer.
 * ⚠️ NEVER passCoversGeneration or claimGeneration here: this is the dry run, and those reserve / bind.
 * ⚠️ These never decide `covered` or `via` — the sheet shows them; the build still asks every gate itself.
 */
async function usageAndPassFor(userId, employer, req) {
    let usage = null;
    let pass = null;
    try {
        if (typeof entitlements.usageFor === 'function') usage = (await entitlements.usageFor(userId, 'cover_letter', req)) || null;
    } catch (e) { console.warn('[employerLetter] usage unreadable for the gate:', e.message); }
    try {
        if (typeof downloads.passStateFor === 'function') {
            // { kind } makes `available` answer for THIS letter's generation — without it, a pass whose only unused
            // generation is the resume would read as one that can pay for a cover letter.
            const st = await downloads.passStateFor(userId, employer || '', req, { kind: 'cover_letter' });
            pass = st && typeof st === 'object' ? { available: !!st.available, forThisEmployer: !!st.forThisEmployer } : null;
        } else if (employer) {
            const forThisEmployer = await passWouldCoverLetter(userId, employer, req, { boundOnly: true });
            const available = forThisEmployer || await passWouldCoverLetter(userId, employer, req, { boundOnly: false });
            pass = { available, forThisEmployer };
        } else {
            pass = { available: false, forThisEmployer: false };
        }
    } catch (e) { console.warn('[employerLetter] pass state unreadable for the gate:', e.message); pass = null; }
    return { usage, pass };
}

/** Resolve within `ms`, else undefined. Never rejects, never keeps the process alive; the work runs on. */
function within(promise, ms) {
    let t = null;
    const timer = new Promise((resolve) => { t = setTimeout(resolve, ms); if (t && typeof t.unref === 'function') t.unref(); });
    return Promise.race([Promise.resolve(promise).catch(() => undefined), timer]).finally(() => { if (t) clearTimeout(t); });
}

// ── Routes ───────────────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/cover-letter/employer-gate   body { employer, employerId?, country?, job?: { title?, url?, description?, website? } }
 *   200 { covered, via: 'plan'|'free'|'pass'|'cache'|'credits'|null, credits: number|null, reason: 'quota_exhausted'|null,
 *         usage: { kind, pool, planLabel, remaining, allowance, used, oneTime } | null,
 *         pass: { available, forThisEmployer } | null }
 *
 * usage / pass (contract 3) feed Home's confirm sheet ("2 of 3 free cover letters left", "Covered by your
 * one-time pass for Acme", or the empty sheet's $0.99 offer) — see usageAndPassFor. A cache hit answers them
 * null: the app runs a hit at once with no sheet, and the hit path stays one that touches no billing read.
 *
 * The question Home asks BEFORE it auto-starts a letter: "would something the user already has pay?"
 * An explicit tap is consent to use the plan, the free allowance or a pass — NOT to spend legacy credits,
 * which come back covered:false via:'credits' so the app asks first.
 *
 * ⚠️ THE CACHE IS ASKED FIRST, because the build asks it first: a stored letter for these exact inputs
 * costs nothing, so a user with no quota left must hear covered:true via:'cache', not be sent to Plans.
 * ⚠️ THEN A TRUE DRY RUN, in the build's order: canConsumeMany (checks, never reserves) → the pass via
 * passWouldCoverLetter (never passCoversGeneration, which binds). The pass is consulted IN FULL when
 * only credits could pay, because Home builds with coveredOnly:true, under which the build does exactly
 * that. Nothing here consumes, reserves or binds.
 */
async function employerLetterGate(req, res) {
    const userId = req.user.id;
    const body = req.body || {};
    const employer = cleanEmployer(body.employer) || null;
    const job = jobFieldsOf(body.job);
    let extras = { usage: null, pass: null };
    const answer = (covered, via, credits, reason) => res.json({ covered, via, credits, reason, usage: extras.usage, pass: extras.pass });
    try {
        if (employer) {
            const env = downloads.envOf(req);
            // Unreadable = "cannot tell": fall through to the dry run, which can only under-promise — the
            // build still reads the cache itself before charging anything.
            let fp = null;
            try {
                const material = await candidateMaterialFor(userId, env);
                fp = material ? letterFingerprintOf(material, job) : null;
            } catch (e) { console.warn('[employerLetter] gate fingerprint unreadable:', e.message); }
            if (fp) {
                const hit = await employerDocsMod().get(userId, 'cover_letter', employer, fp, env);
                if (usableLetter(hit)) return answer(true, 'cache', null, null);
            }
        }
        const quota = await entitlements.canConsumeMany(userId, 'cover_letter', 1, req);
        const quotaCovers = !!quota.allowed && (quota.via === 'plan' || quota.via === 'free');
        const viaPass = employer ? await passWouldCoverLetter(userId, employer, req, { boundOnly: quotaCovers }) : false;
        // After canConsumeMany, so a usage read never runs ahead of the quota's own first-use bookkeeping.
        extras = await usageAndPassFor(userId, employer, req);
        // The build spends the pass first whenever it covered — so the pass is what pays.
        if (viaPass) return answer(true, 'pass', null, null);
        if (!quota.allowed) return answer(false, null, null, 'quota_exhausted');
        if (quotaCovers) return answer(true, quota.via, null, null);
        if (quota.via === 'credits') {
            const price = await require('../services/eventCosts').getEventCost('cover_letter_generate');
            return answer(false, 'credits', Number(price) || 0, null);
        }
        // An allowance we cannot name is not one we may spend without asking.
        return answer(false, null, null, null);
    } catch (e) {
        console.warn('[employerLetter] employer-gate failed:', e.message);
        return res.status(500).json({ covered: false, via: null, credits: null, reason: null, usage: null, pass: null, error: 'Could not check your plan.' });
    }
}

/**
 * Builds in flight in THIS process, by (user, environment, employer key, fingerprint) → Promise<docId|null>.
 * ⚠️ TWO REQUESTS FOR THE SAME LETTER MUST NOT BOTH PAY. asJob dedupes one clientBuildId, the phone
 * single-flights one key — but a second device, or a Refresh racing an Add, arrives with a new id, misses
 * the cache (the first has not stored yet) and would run the AI and charge a second time for the same
 * document. The second waits for the first instead and is handed its letter as the free cache hit it is
 * about to become. If the first fails, the second runs normally.
 */
const FLIGHTS = new Map();

/**
 * POST /api/cover-letter/employer-build   (asJob('cover_letter_employer'))
 *   body { __async, clientBuildId, coveredOnly, expectVia?, employer, employerId?, country?, docJobUrl?,
 *          job: { company, title?, url?, description?, website? } }
 *   200 { success:true, cached, docId, tailoredFor }
 *   400 { reason:'no_resume' | 'invalid_employer' }   402 { reason:'quota_exhausted' }   500/504 { reason:'failed' }
 *   503 { reason:'ai_busy', retryable:true | 'ai_down', retryable:false }   (Google could not write it: said only from
 *       before the charge, so nothing was charged or stored — see AI_BUSY / AI_DOWN)
 *   409 { reason:'payer_changed' | 'cache_miss' }   (contract C2 — only for a build that sent `expectVia`)
 *
 * `job` is what the letter is WRITTEN against (the fingerprint, the posting the writer reads, the research host);
 * `docJobUrl` is the stored letter's IDENTITY — see where it is read below.
 *
 * Order (each step is load-bearing): no résumé → fingerprint → CACHE (free, returns before any gate) →
 * gates → coveredOnly refusal (before research and the AI, which are paid work) → the letter (the Jobs section's
 * writer), with the research beside it → design ranking → CHARGE + STORE under the usage lock → thumbs.
 *
 * ⚠️ `expectVia` (contract C2), when the app sends it, is the payer the user CONFIRMED on Home's sheet. At
 * every point where this lane is about to bind or charge, the payer it would really use is worked out first
 * and compared with it — and a letter that would now be paid for some other way is refused with 409
 * payer_changed (PAYER_CHANGED), having bound, charged and stored nothing. A build that sends no expectVia
 * behaves exactly as it always has.
 */
async function buildEmployerLetter(req, res) {
    // ⚠️ THE AI DEADLINE STARTS HERE, not at the first AI call: research, a wait on another build's flight and every
    // AI attempt all spend the same 6 minutes the app is polling (LETTER_AI).
    const aiDeadline = Date.now() + LETTER_AI.windowMs;
    const userId = req.user.id;
    const body = req.body || {};
    // ⚠️ coveredOnly: Home sends true for a build it AUTO-started from a gate answer taken seconds ago.
    // Without it, a build whose last plan unit was spent in between would fall through to legacy credits
    // nobody agreed to. false is sent only after the user explicitly confirmed a credit charge.
    const coveredOnly = body.coveredOnly === true;
    // ⚠️ contract C2 — WHAT THE USER CONFIRMED ON THE SHEET ('plan' | 'free' | 'pass' | 'cache'), or null when
    // the body carries none (an older app): then this lane decides what pays alone, exactly as it always has.
    // Every comparison against it happens BEFORE the thing it guards — see the gates and the charge below.
    const expectVia = downloads.expectedPayerOf(body);
    const rawJob = body.job && typeof body.job === 'object' ? body.job : {};
    const company = cleanEmployer(rawJob.company) || cleanEmployer(body.employer);
    // '(none)' is the base résumé snapshot's scope, not an employer: a letter stored under it could never
    // be opened by id, and no pass may ever pay for it (downloads refuses a nameless generation).
    if (!company || downloads.employerKeyOf(company) === downloads.NONE) {
        return res.status(400).json({ success: false, error: 'Which employer is this cover letter for?', reason: 'invalid_employer' });
    }
    const job = jobFieldsOf(rawJob);
    // ⚠️ TWO URLS, TWO JOBS. job.url is INPUT: hashed into the fingerprint, shown to the model, a research
    // host — and on an employer-level chip it may be the posting link pasted in the Add sheet, so the letter
    // really is written against that posting. docJobUrl is IDENTITY: the job_url the letter is stored under
    // ('' = the employer's own letter, else the posting's), which is what /employer-docs/current and the
    // chip look it up by. Spelling the pasted link into the identity split one chip's letter from its own
    // lookup; leaving it out of the input wrote the letter as if no link had been given. An old client
    // sends no docJobUrl — for it the two were always the same url.
    const docJobUrl = typeof body.docJobUrl === 'string' ? body.docJobUrl : job.url;
    const employerId = typeof body.employerId === 'string' ? body.employerId.trim().slice(0, 64) : null;
    const country = typeof body.country === 'string' ? body.country.trim().slice(0, 80) : '';
    const env = downloads.envOf(req);
    const report = makeReporter(req);

    let settleFlight = null;   // set once this request is THE build for its key; called exactly once
    let chargedAt = 0;
    try {
        await report('reading', 'Reading your resume', 8);

        // Every module the paid half needs, resolved while failing still costs nothing.
        const employerDocs = employerDocsMod();
        const designFit = designFitMod();
        const research = researchMod();
        const cl = clMod();

        let material;
        try {
            material = await candidateMaterialFor(userId, env);
        } catch (e) {
            console.warn(`[employerLetter] resume unreadable for user ${userId}:`, e.message);
            return res.status(500).json({ success: false, error: "We couldn't read your resume just now. Please try again.", reason: 'failed' });
        }
        if (!material) {
            return res.status(400).json({ success: false, error: 'Upload your current resume first — the AI writes your cover letter from it.', reason: 'no_resume' });
        }
        const fp = letterFingerprintOf(material, job);

        // ── THE CACHE — before every gate that consumes, reserves or binds ─────────────────────────
        // ⚠️ A HIT IS FREE OR THIS IS A BILLING BUG WITH A CACHE ATTACHED: no canConsumeMany, no
        // passCoversGeneration (it BINDS a pass when quota is gone), no AI, no ledger, no new row.
        const hit = await employerDocs.get(userId, 'cover_letter', company, fp, env);
        if (usableLetter(hit)) {
            await report('cached', `Found your ${company} letter`, 90);
            console.log(`[employerLetter] cache hit for "${company}" (user ${userId}) — no AI call, nothing charged`);
            return res.json({ success: true, cached: true, docId: hit.id, tailoredFor: company });
        }
        // ⚠️ CONFIRMED AS FREE, AND IT IS NOT (contract C2). The app starts a 'cache' build with no sheet at all,
        // because a stored letter costs nothing — so a miss here would charge someone who was never asked.
        // Before the flight join and every gate: nothing reserved, nothing written, nothing spent.
        if (expectVia === 'cache') {
            console.log(`[employerLetter] build for user ${userId} / "${company}" was confirmed as a saved letter, but the cache misses now — refused, nothing charged`);
            return res.status(CACHE_MISS.status).json(CACHE_MISS.body);
        }

        const flightKey = `${userId}|${env}|${downloads.employerKeyOf(company)}|${fp}`;
        for (let waits = 0; waits < 3 && FLIGHTS.has(flightKey); waits++) {
            const running = FLIGHTS.get(flightKey);
            await report('writing', `Writing your ${company} cover letter`, 40);
            // A joiner has no stage of its own for a minute or more; the beat keeps its job row fresh.
            const beat = setInterval(() => { report('writing', `Writing your ${company} cover letter`, 40); }, 60 * 1000);
            if (typeof beat.unref === 'function') beat.unref();
            const leaderDocId = await running.catch(() => null).finally(() => clearInterval(beat));
            if (leaderDocId) {
                await report('cached', `Found your ${company} letter`, 90);
                console.log(`[employerLetter] joined a running build for "${company}" (user ${userId}) — nothing charged`);
                return res.json({ success: true, cached: true, docId: leaderDocId, tailoredFor: company });
            }
            // That build failed. If nobody else has taken over, this one runs on its own, through every gate.
        }
        {
            let resolveFlight;
            const mine = new Promise((resolve) => { resolveFlight = resolve; });
            FLIGHTS.set(flightKey, mine);
            settleFlight = (docId) => {
                resolveFlight(docId || null);
                if (FLIGHTS.get(flightKey) === mine) FLIGHTS.delete(flightKey);
            };
        }

        // ── THE RÉSUMÉ THE LETTER IS WRITTEN FROM — the Jobs lane's, loaded its way ──────────────────────
        // cl.letterResumeMetadataFor: the parsed upload row with the Builder résumé merged in. Read ONCE, never waited for:
        // `material.meta` has already answered whether a parse landed, by the same query. A Builder-only résumé (no upload
        // at all — the Jobs lane refuses one, Home never did) is the same merge over no upload row: { builder_resume }.
        // After the cache and the flight (a hit or a joiner needs no résumé read) and before every gate, so a failure
        // here has reserved and spent nothing.
        let resumeMetadata = null;
        try {
            resumeMetadata = (material.meta ? await cl.letterResumeMetadataFor(userId, { tries: 1 }) : null)
                || await cl.mergeBuilderResume(userId, {});
        } catch (e) { console.warn(`[employerLetter] résumé metadata unreadable for user ${userId}:`, e.message); }
        // ⚠️ THEY HAVE A RÉSUMÉ — the strict material read said so — but the writer's read of it came back empty or failed
        // (mergeBuilderResume swallows a DB error, as the Jobs lane always has). A "try again", never "upload one" (that
        // is how a user overwrites the résumé they have), and never a letter written from an empty object.
        if (!resumeMetadata || !Object.keys(resumeMetadata).length) {
            console.warn(`[employerLetter] no résumé metadata for user ${userId} although the material read found a résumé — not written`);
            return res.status(500).json({ success: false, error: "We couldn't read your resume just now. Please try again.", reason: 'failed' });
        }

        // ── GATES — plan/free quota first, the pass as the fallback, legacy credits last ────────────
        // ⚠️ THE PLAN IS ASKED FIRST. Burning someone's one-off while their plan could pay destroys what
        // they bought; `boundOnly` lets only a pass ALREADY bound to this employer jump in while quota
        // remains. Once quota is gone (or, under coveredOnly, only credits remain) the pass is consulted
        // in full — and that call RESERVES it, so two letters for two companies in one AI minute cannot
        // both ride one pass.
        const quota = await entitlements.canConsumeMany(userId, 'cover_letter', 1, req);
        const quotaCovers = !!quota.allowed && !(coveredOnly && quota.via === 'credits');
        const boundOnly = quota.allowed && quotaCovers;
        // ⚠️ C2 IS ASKED BEFORE passCoversGeneration, BECAUSE THAT CALL BINDS. With boundOnly false it is a
        // RESERVATION — an UPDATE tying the oldest unspent pass to this employer. Refusing after it would leave
        // the one company a pass buys spent on a build nobody agreed to pay for that way. passWouldCoverLetter
        // is its read-only twin, clause for clause, so the comparison happens while nothing has moved.
        if (expectVia !== null) {
            const would = await passWouldCoverLetter(userId, company, req, { boundOnly });
            const payer = would ? 'pass' : downloads.quotaPayerOf(quota);
            if (payer !== expectVia) {
                console.warn(`[employerLetter] build for user ${userId} / "${company}" was confirmed as '${expectVia}' but ${payer || 'nothing'} would pay now — refused, nothing bound or charged`);
                return res.status(PAYER_CHANGED.status).json(PAYER_CHANGED.body);
            }
        }
        const viaPass = await downloads
            .passCoversGeneration(userId, 'cover_letter', company, req, { boundOnly })
            .catch(() => false);
        // The gate's OWN answer, compared again — a mismatch here is a race, and never a binding this refusal
        // would strand: the reservation lost one (then it bound nothing), or it found the employer's own pass
        // a read a moment ago did not. It cannot be a pass it has just bound, because the only build that
        // reaches that branch is one whose confirmed payer was already 'pass'.
        if (expectVia !== null) {
            const payer = viaPass ? 'pass' : downloads.quotaPayerOf(quota);
            if (payer !== expectVia) {
                console.warn(`[employerLetter] build for user ${userId} / "${company}": '${expectVia}' was confirmed, ${payer || 'nothing'} would pay at the gate — refused, nothing charged`);
                return res.status(PAYER_CHANGED.status).json(PAYER_CHANGED.body);
            }
        }
        const gate = viaPass ? { allowed: true } : quota;
        if (!gate.allowed) {
            return res.status(402).json({ success: false, error: gate.message, reason: 'quota_exhausted', creditsRequired: 1, remainingCredits: 0 });
        }
        if (coveredOnly && !viaPass && !quotaCovers) {
            // Before ANY paid work — research included: nothing is spent, reserved or generated.
            console.log(`[employerLetter] coveredOnly build for user ${userId} refused — only legacy credits could pay`);
            return res.status(402).json({
                success: false, reason: 'quota_exhausted',
                error: 'Your plan does not cover this cover letter right now. Open Plans & Usage to continue.',
            });
        }
        emit(req, 'cover_letter_generate', { forJob: !!(job.title || job.url), lane: 'employer_home' });

        // ── RESEARCH — the designs and the brand, BESIDE the letter (optional, never a dependency, never throws) ───
        // It writes no word of the letter any more: the letter researches the employer itself, live, through Google
        // Search grounding. What this call still decides is how the letter LOOKS — the region and the hiring
        // conventions (how THIS employer hires) the designs are ranked by, and the employer's own colour and font — so
        // it runs while the letter is being written, not before it. `country` is only a hint for it: the chip's country
        // is the role's location more often than the employer's HQ.
        const site = researchSiteFor(company, job);
        if (site) await report('researching', `Researching ${company}`, 16);
        const researching = site
            ? research.getEmployerResearch({ website: site, name: company, country: country || null }).catch(() => null)
            : Promise.resolve(null);

        // ── THE LETTER — the Jobs section's generation, exactly (see "The letter itself") ───────────────────
        // The same inputs in the same shapes as POST /generate-cover-letter-details hands it:
        //   the résumé      resumeMetadata above (the Jobs lane's loader);
        //   the position    the posting's title when there is one, else the candidate's own current title (the
        //                   narrative's "Current title:" line, then the upload's first job title). v2 needs one: with
        //                   neither, it gets what the Jobs lane's bulk sender gives a recipient with no position;
        //   the subject     the employer's own website (researchSiteFor vetted it), through the Jobs lane's rule — or,
        //                   with no website of its own, the employer's NAME: exactly what the Jobs lane researches when
        //                   all it has is a job board;
        //   job location    the chip's country — where the user wants this job (see letterFingerprintOf: not hashed);
        //   the posting     the pasted link and text, when there are any (cl.letterListingOf).
        // No responsibilities: a Home chip carries none (a posting's duties arrive in its text).
        const narrativeTitle = (material.baseText.match(/^Current title:\s*(.+)$/m) || [])[1];
        const uploadTitle = material.meta && Array.isArray(material.meta.job_titles) ? material.meta.job_titles[0] : '';
        const position = cleanPosition(job.title) || cleanPosition(narrativeTitle) || cleanPosition(uploadTitle);
        const targetPosition = position || 'Position';
        const researchSubject = site ? cl.letterResearchSubjectOf(site, company).researchSubject : company;
        const jobLocation = country || null;
        const listing = cl.letterListingOf({ jobUrl: job.url, jobText: job.description, position: targetPosition, companyNameHint: company });
        await report('writing', `Writing your ${company} cover letter`, 40);
        // ⚠️ A THROW HERE ENDS THE BUILD BEFORE THE CHARGE. The writer has already waited, retried the primary, walked
        // the letter chain and asked again for answers it could not use — inside what is left of THIS build's window
        // (`deadline`) — so nothing here asks a second time: its ai_busy / ai_down refusal becomes AI_BUSY / AI_DOWN in
        // the catch, and anything else ("could not finish") the 500 it always was. Its retries reach the bar in its
        // own words ("Google's AI is busy — trying again", "Switching to a faster model", "Taking another pass at it").
        const written = await cl.writeLegacyLetter(resumeMetadata, researchSubject, targetPosition, null, jobLocation, listing, {
            report: (stage, label) => report(stage, label, 46),
            deadline: aiDeadline,
        });
        // Who WROTE it — a fallback on a busy day — recorded on the row, never hashed (a fallback's letter is the same
        // free cache hit next time as the primary's).
        const outModel = written.model || cl.LEGACY_LETTER_MODEL;
        const facts = await researching;
        const conventions = conventionsOf(facts);
        const region = letterRegionFor(research, designFit, conventions, { country, website: site });

        // ── THE DOCUMENT — assembled completely BEFORE the charge, so nothing after it can throw ──────
        // The answer mapped the way the Jobs lane maps it (cl.letterDetailsOf: its body as <p> HTML, its subject, its
        // addressee, its offices — each with the Jobs lane's fallback), into the payload Home has always stored, key for
        // key, for the editor, the cards and the downloads that read it:
        //   companyName     the employer as the user picked it — the name this letter is keyed, billed and shown under
        //                   on Home; the letter's own words name the employer as the research found it
        //   companyAddress  the first RESEARCHED office in the Jobs lane's order (the job location's own first); '' when
        //                   the research found none
        //   locations       the researched offices, in that order — only the ones v2 returned
        //   position        the role written for ('' when only the fallback above was known — never "Position")
        // ⚠️ letterDetailsOf also adds two rows nobody researched, both for the Jobs PICKER, where the user sees them and
        // chooses: "Address not available" when v2 found nothing, and — when no researched office names the job location —
        // the job location ITSELF, first, as the picker's default. Home has no picker: its companyAddress goes straight into
        // every rendered letter and PDF. So the chip's country ("Germany") became the address block whenever v2's offices
        // spelled it their own way — "…80333 München, Deutschland" (v2 returns addresses verbatim), "Schweiz", "Nederland",
        // "USA" — or found none, and replaced the Munich street address the research HAD found. A row is kept only when its
        // address is one v2 returned; the Jobs mapping itself is untouched.
        const details = cl.letterDetailsOf(written.letter, { position: targetPosition, companyNameHint: company, researchSubject, jobLocation });
        const researched = new Set(Array.isArray(written.letter.addresses) ? written.letter.addresses : []);
        const locations = details.locations.filter((l) => researched.has(l.address) && l.address !== cl.ADDRESS_NOT_AVAILABLE);
        // The employer's brand — the website's own colour and font (brandExtract) over the researcher's guess
        // (coverLetterController.researchBrandOf, contract 2's precedence). Stored on the design so every render
        // of this letter draws it; the payload's brandColor / fontName keep their keys and carry the same
        // effective values, for the generic (PDFKit) design and for a reader from before design.brand.
        const brand = brandOfResearch(cl, facts);
        const brandColor = (brand && brand.accent) || hexOrNull(facts && facts.brandColor);
        const payload = {
            coverLetterHtml: details.coverLetterHtml,
            subject: details.subject,
            companyName: company,
            companyAddress: locations.length ? locations[0].address : '',
            hiringManager: details.hiringManager,
            position,
            locations,
            brandColor,
            fontName: (brand && brand.font && brand.font.family) || (facts && facts.fontName) || null,
        };

        await report('designing', 'Ranking letter designs', 86);
        let design = null;
        try {
            const builder = await builderResumeFor(userId);
            let seniorityYears = builder ? designFit.seniorityYearsOf(builder) : 0;
            const parsedYears = Number(material.meta && material.meta.experience_years);
            if (!seniorityYears && Number.isFinite(parsedYears) && parsedYears > 0) seniorityYears = Math.min(60, parsedYears);
            // Employer-first (contract 2): the conventions and the employer type lead, seniority is a minor
            // factor inside designFit. aiFamilies / conventionsSummary ride along so the stored design can be
            // re-ranked later without AI.
            const ranked = designFit.rankLetterDesigns({
                region,
                seniorityYears,
                industry: (facts && facts.industry) || null,
                companySize: (facts && facts.companySize) || null,
                isTechnicalRole: TECH_ROLE_RE.test([position, job.title].join(' ')),
                brandColor,
                conventions,
                employerType: (conventions && conventions.employerType) || null,
            });
            design = withDesignBrand(withConventionFields(designFit.normaliseDesign(ranked, 'cover_letter'), ranked), brand);
        } catch (e) { console.warn('[employerLetter] design ranking failed (stored without one):', e.message); }

        // ── CHARGE, THEN STORE — one payment at a time per user (withUsageLock) ──────────────────────────
        // ⚠️ EVERY MONEY DECISION BELOW IS THIS BUILD'S OWN ANSWER: the pass claim's charged + passId, and
        // consumeOnSuccess's via, its own chargeCredits result and the ledger row it wrote. Credits used to be
        // "verified" by reading the history tables afterwards (creditsDeductedSince), which cannot tell this
        // deduction from an overlapping one's: a letter the user HAD paid for read as unpaid and was thrown
        // away, unrefunded. `took` records each charge the moment it lands, so whatever happens next — a
        // refusal, an unconfirmed charge, a store that fails — gives back exactly what this build took.
        // ⚠️ The store sits under the lock too. An identical build that paid a moment ago — another device,
        // another server instance: FLIGHTS only joins builds inside this process — has already stored when the
        // next one looks, so the second is served that letter free instead of paying for it again.
        // ⚠️ Spend the PASS first when one covered this; fall back to the plan only if the claim did not
        // land (a racing tap won it) — losing that race must not mean a free letter.
        // ⚠️ NO clientGone WAIVER (the resume sync lane dropped its own on 2026-09-14 — a waived run that still
        // saved its resume made a one-time allowance endless): this letter is stored and shown on Home by
        // docId, so a client that dropped the connection still receives what it paid for, and its retry
        // is a free cache hit.
        // ⚠️ NOTHING LEFT THAT MAY PAY IS A 402, NOT A 500: consumeOnSuccess answers via 'none' when the last unit
        // went to an overlapping build during the AI minute — the same "lost its cover" as the re-check, so the
        // same LOST_COVER, and Home opens Plans instead of offering a Try again that meets the same wall.
        const took = { passId: null, credits: null, ledgerId: null };
        let served = null;       // an identical build's letter that landed during ours — served free
        let refusal = null;      // { status, body }, decided under the lock and answered after it
        let docId = null;
        let paidWith = '';       // 'pass' | 'plan' | 'trial' | 'credits' — for the log line only
        try {
            await withUsageLock(userId, 'cover_letter', async () => {
                const landed = await employerDocs.get(userId, 'cover_letter', company, fp, env);
                if (usableLetter(landed)) { served = landed; return; }

                let charged = false;
                let spentPass = false;
                if (viaPass) {
                    const claimed = await downloads.claimGeneration(userId, 'cover_letter', company, req);
                    spentPass = !!(claimed && claimed.charged);
                    if (spentPass) took.passId = claimed.passId || null;
                }
                if (!spentPass) {
                    // ⚠️ C2 AT THE MOMENT OF PAYMENT: the confirmed pass did not land (a racing tap for this same
                    // employer won it), so what would pay now is the plan or the free allowance — a payer the user
                    // never agreed to. Losing that race must not mean a free letter, and it must not mean a silent
                    // one either: refused here, nothing charged, and the app asks again.
                    if (expectVia === 'pass') {
                        console.warn(`[employerLetter] build for user ${userId} / "${company}": the confirmed pass was spent elsewhere during the run — refused, nothing charged`);
                        refusal = PAYER_CHANGED;
                        return;
                    }
                    // ⚠️ coveredOnly, re-asked at the moment of payment. The gate ran a minute ago and never
                    // reserves: the plan unit it saw may be gone, or the pass claim above lost a race. Then
                    // consumeOnSuccess would pick credits — the one lane this build must never use. Under the
                    // lock, a parallel letter's unit is already in the ledger when this reads it.
                    // ⚠️ And with a payer confirmed (C2), the answer must still BE that payer: a plan that ended
                    // mid-build leaves the free allowance paying for a letter the user confirmed against a plan.
                    if (coveredOnly || expectVia !== null) {
                        const now = await entitlements.canConsumeMany(userId, 'cover_letter', 1, req);
                        if (expectVia !== null && downloads.quotaPayerOf(now) !== expectVia) {
                            console.warn(`[employerLetter] build for user ${userId} / "${company}": '${expectVia}' no longer pays for it (${downloads.quotaPayerOf(now) || 'nothing'} would) — refused, nothing charged`);
                            refusal = PAYER_CHANGED;
                            return;
                        }
                        if (!now.allowed || now.via === 'credits') {
                            console.warn(`[employerLetter] coveredOnly build for user ${userId} lost its cover during the run — refused, nothing charged`);
                            refusal = LOST_COVER;
                            return;
                        }
                    }
                    const marks = await creditMarksFor(userId);   // read only by the fallback below
                    const used = await entitlements.consumeOnSuccess(userId, 'cover_letter', {
                        companyName: company, position, screen: 'home_employer_letter',
                    }, req);
                    const via = used && used.via ? used.via : 'error';
                    // Recorded before anything is decided: 'error' can still carry a deduction that landed first.
                    if (used && used.ledgerId) took.ledgerId = used.ledgerId;
                    if (used && Object.prototype.hasOwnProperty.call(used, 'charge')) {
                        if (used.charge && used.charge.charged) took.credits = { charged: true, cost: Number(used.charge.cost) || 0 };
                    } else if (via === 'credits') {
                        // An entitlements that predates its own `charge` answer: the history marks are all there
                        // is. Conservative — it can under-report a payment, never invent one (see creditMarksFor).
                        const d = await creditsDeductedSince(userId, marks);
                        if (d.paid) took.credits = { charged: true, cost: d.cost };
                    }
                    // ⚠️ C2, ON WHAT ACTUALLY PAID. consumeOnSuccess picks the pool itself, and in the sliver
                    // between the re-check above and this call it can pick another one (a plan that ended, the
                    // last unit taken by a lane that holds no lock). Recorded above, so whatever it took goes
                    // straight back — and the letter is never stored for a payer the user did not confirm.
                    // 'error' and anything unrecognised are not a payer at all: they fall through to the
                    // "charge could not be confirmed" path below, which already gives everything back.
                    if (expectVia !== null && downloads.namesPayer(via) && downloads.payerWordOf(via) !== expectVia) {
                        console.warn(`[employerLetter] build for user ${userId} / "${company}": ${via} paid where '${expectVia}' was confirmed — given back and refused`);
                        await giveBackLetterCharge(userId, took, 'a payer the user did not confirm');
                        refusal = PAYER_CHANGED;
                        return;
                    }
                    if (via === 'credits') {
                        if (coveredOnly) {
                            // The residual race between the re-check above and consumeOnSuccess (a lane that takes
                            // no lock spent the unit in between): this build's own credits refunded and its ledger
                            // row deleted — then the same 402 as above.
                            await giveBackLetterCharge(userId, took, 'a coveredOnly build slipped into credits');
                            refusal = LOST_COVER;
                            return;
                        }
                        if (!took.credits) {
                            // A short balance: chargeCredits took nothing, so nothing may be stored — and the ledger
                            // row consumeOnSuccess writes regardless is no consumption either.
                            console.warn(`[employerLetter] credits lane for user ${userId} deducted nothing for "${company}" (short balance) — not stored`);
                            await giveBackLetterCharge(userId, took, 'the credits lane deducted nothing');
                            refusal = { status: 402, body: {
                                success: false, reason: 'quota_exhausted', creditsRequired: 1, remainingCredits: 0,
                                error: "You don't have enough credits for this cover letter. Open Plans & Usage to continue.",
                            } };
                            return;
                        }
                        charged = true;
                    } else if (via === 'plan' || via === 'trial') {
                        charged = true;                   // plan / trial: the ledger row IS the charge
                    } else if (via === 'none') {
                        // Nothing left that may pay (see above): refused, nothing stored, nothing charged.
                        console.warn(`[employerLetter] nothing left to pay for user ${userId}'s "${company}" letter (the last unit went to an overlapping build) — refused, not stored`);
                        await giveBackLetterCharge(userId, took, 'nothing left that may pay');
                        refusal = LOST_COVER;
                        return;
                    }
                    // 'error', or anything unrecognised: nothing confirmed, so `charged` stays false.
                    if (charged) paidWith = via;
                }
                if (spentPass) { charged = true; paidWith = 'pass'; }

                if (!charged) {
                    // ⚠️ NOTHING CONFIRMED PAID, SO NOTHING STORED — a stored letter is a free hit for ever after.
                    // Whatever did land (a deduction before consumeOnSuccess failed) goes back.
                    console.error(`[employerLetter] ❌ the charge for user ${userId} ("${company}") could not be confirmed — letter not stored`);
                    await giveBackLetterCharge(userId, took, 'the charge could not be confirmed');
                    refusal = { status: 500, body: { success: false, reason: 'failed', error: 'We could not finish your cover letter. Please try again.' } };
                    return;
                }
                chargedAt = Date.now();

                // ── STORE — a charged build, and only a charged build ───────────────────────────────────────
                await report('saving', 'Saving your letter', 92);
                const letterDoc = {
                    userId, kind: 'cover_letter', employer: company, jobUrl: docJobUrl, jobTitle: job.title,
                    // `model` is who WROTE it (a fallback on a busy day), in the non-key column — never in `fp`.
                    fingerprint: fp, model: outModel, payload, research: facts, env, employerId, design,
                    // The exact job letterFingerprintOf hashed — what /employer-docs/current re-hashes to call it stale.
                    jobInput: { title: job.title, url: job.url, description: job.description, website: job.website },
                };
                // put() never throws and answers null on a failed write; one retry covers a blip.
                docId = (await employerDocs.put(letterDoc)) || (await employerDocs.put(letterDoc));
                if (!docId) {
                    // ⚠️ A PAID LETTER THAT CANNOT BE STORED CANNOT BE DELIVERED — this lane hands over a docId, not
                    // a letter. So every charge goes back: credits, the pass's generation, the plan/free unit. Keeping
                    // them left the user charged for nothing, and Try again charged a second time.
                    console.error(`[employerLetter] ❌❌ PAID LETTER NOT STORED — user ${userId}, employer "${company}", fp ${fp.slice(0, 12)}, env ${env} — giving back every charge`);
                    await giveBackLetterCharge(userId, took, 'the paid letter could not be stored');
                    refusal = { status: 500, body: { success: false, reason: 'failed', error: 'Your cover letter was written but could not be saved. Please try again in a minute.' } };
                }
            });
        } catch (e) {
            // The lock's transaction failed: taking the lock (lock_timeout, a dead connection), a read under it
            // that threw, or its COMMIT. The writes under it were on the pool and are NOT rolled back, so: a
            // letter that was stored has been paid for and is delivered; otherwise whatever this build took goes back.
            console.error(`[employerLetter] payment for user ${userId} ("${company}") failed under the usage lock:`, e.message);
            if (!docId && !served && !refusal) {
                await giveBackLetterCharge(userId, took, 'the usage lock failed');
                refusal = { status: 500, body: { success: false, reason: 'failed', error: 'We could not finish your cover letter. Please try again.' } };
            }
        }

        if (served) {
            if (settleFlight) { settleFlight(served.id); settleFlight = null; }
            await report('cached', `Found your ${company} letter`, 90);
            console.log(`[employerLetter] an identical "${company}" letter landed during this build (user ${userId}) — served free, ours discarded`);
            return res.json({ success: true, cached: true, docId: served.id, tailoredFor: company });
        }
        if (refusal) return res.status(refusal.status).json(refusal.body);
        if (!docId) {
            // Unreachable (every path under the lock serves, refuses or stores) — but never answer success without a letter.
            return res.status(500).json({ success: false, reason: 'failed', error: 'We could not finish your cover letter. Please try again.' });
        }
        if (settleFlight) { settleFlight(docId); settleFlight = null; }
        dbConfig.run('UPDATE users SET total_generated = total_generated + 1 WHERE id = $1', [userId]).catch(() => {});

        // ── THUMBS — bounded, best-effort: the letter is already saved and paid for ───────────────────
        await report('pages', 'Laying out your letter', 96);
        const topIds = design && design.ranked.length ? design.ranked.slice(0, PRERENDER_TOP).map((r) => r.id) : ['standard', 'ats_pro'];
        await within((async () => {
            const saved = await withSharedLetterBrand(cl, await employerDocs.getById(userId, docId, req, { kind: 'cover_letter' }));
            if (usableLetter(saved)) await letterCardsFor(userId, saved, topIds, design);
        })(), PRERENDER_BUDGET_MS);

        console.log(`[employerLetter] ✅ "${company}" letter for user ${userId} → doc ${docId} (${paidWith}, written by ${outModel})`);
        return res.json({ success: true, cached: false, docId, tailoredFor: company });
    } catch (e) {
        if (chargedAt) console.error(`[employerLetter] ❌❌ failed AFTER charging user ${userId} for "${company}":`, e.message);
        else console.error('[employerLetter] build error:', e.message);
        // The AI provider could not write it — busy through every retry and model, or refusing the key. Only from
        // before the charge (every AI call is), because the answer promises that nothing was charged.
        const ending = chargedAt ? null : aiEndingOf(e);
        if (ending) {
            // aiText's own record of the walk rides on the writer's refusal as its cause.
            const attempts = (e.cause && Array.isArray(e.cause.attempts)) ? e.cause.attempts : [];
            console.warn(`[employerLetter] "${company}" letter for user ${userId} ended as ${ending.body.reason} after ${attempts.length} AI attempts (${attempts.map((a) => `${a.model} ${a.kind}`).join(', ') || 'none'}) — nothing charged, nothing stored`);
            return res.status(ending.status).json(ending.body);
        }
        const isTimeout = e && (e.message === 'AI_TIMEOUT' || /timeout|ETIMEDOUT/i.test(e.message || ''));
        return res.status(isTimeout ? 504 : 500).json({
            success: false, reason: 'failed', isTimeout,
            error: isTimeout
                ? 'The AI took too long to write your cover letter. Please try again — it usually works on the second attempt.'
                : 'We could not finish writing your cover letter. Please try again.',
        });
    } finally {
        // Every exit that did not store (a 402, a failure, a throw) releases its waiters with null, so
        // they run their own gates instead of waiting on a build that will never land.
        if (settleFlight) settleFlight(null);
    }
}

/**
 * GET /api/cover-letter/employer-cards?doc=<id>&ids=a,b,c[&size=page]
 *   200 { success:true, cards: [{ id, name, accent, image, fit, reason }] }   404 { success:false, reason:'doc_gone' }
 * ≤ 3 ids per request (asked ∩ catalogue; none asked → the top 3 of the letter's design). No padding:
 * an id the client asked for that could not be rendered is simply absent. Free — a preview of a letter
 * the user already owns; never generates, never charges.
 * `size=page` answers the full rendered page instead of the 480-px card — for a screen that shows the letter at full
 * size and lets it be zoomed (see letterCardsFor). Anything else, or nothing, is the card: what Home always got.
 */
async function employerLetterCards(req, res) {
    const userId = req.user.id;
    try {
        // The cards' brand hash and their pages read letterBrandOf off this object, so a brand-less letter meets
        // the shared row's brand HERE, before either — a thumb must be the file the download would produce.
        const doc = await withSharedLetterBrand(clMod(), await employerDocsMod().getById(userId, req.query && req.query.doc, req, { kind: 'cover_letter' }));
        if (!usableLetter(doc)) return res.status(404).json({ success: false, reason: 'doc_gone', error: 'That cover letter is no longer saved.' });
        const design = await designOfLetterDoc(userId, doc).catch((e) => {
            console.warn('[employerLetter] cards design unavailable:', e.message);
            return null;
        });
        const askedRaw = [].concat(req.query && req.query.ids != null ? req.query.ids : []).join(',');
        const asked = askedRaw.split(',').map((s) => s.trim()).filter(Boolean);
        const ids = asked.length
            ? [...new Set(asked)].filter((id) => clTemplates.TEMPLATE_IDS.includes(id)).slice(0, CARDS_MAX)
            : ((design && design.ranked) || clTemplates.TEMPLATE_IDS.map((id) => ({ id }))).slice(0, CARDS_MAX).map((r) => r.id);
        if (!ids.length) return res.json({ success: true, cards: [] });
        const size = req.query && req.query.size === 'page' ? 'page' : 'card';
        const cards = await letterCardsFor(userId, doc, ids, design, { size });
        if (!cards.length) return res.status(500).json({ success: false, error: 'Could not render previews.' });
        return res.json({ success: true, cards });
    } catch (e) {
        console.error('[employerLetter] employer-cards error:', e.message);
        return res.status(500).json({ success: false, error: 'Could not render previews.' });
    }
}

module.exports = {
    employerLetterGate,
    buildEmployerLetter,
    employerLetterCards,
    currentLetterFingerprint,
    // exported for tests only
    findLetterPlaceholders, cleanPosition,
    passWouldCoverLetter, letterFingerprintOf, jobFieldsOf, uploadContextOf, usageAndPassFor,
    LETTER_AI,
};
