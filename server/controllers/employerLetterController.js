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
// letterFingerprintOf before adding an input to the prompt.
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
const clMod = () => require('./coverLetterController');
// cvPlaybook is newer than this lane and answers for the RESUME first: a deploy where it is missing, or an
// older copy without the letter variant, must still write letters exactly as they were written before it
// existed — so it is resolved here, defensively, and never at load.
const playbookMod = () => require('../services/cvPlaybook');
// Every letter's AI call goes through aiText (2026-09-18: the Amazon letter that died on two back-to-back 503s).
// Lazy for the same reason as the rest: a half-deployed slice must fail a build, never the route table.
const aiTextMod = () => require('../services/aiText');

/**
 * The letter lane's FIRST choice — the head of the chain aiText walks, followed by aiText.fallbackModels().
 * ⚠️ NOT NECESSARILY THE MODEL THAT WROTE A STORED LETTER: since 2026-09-18 a busy primary hands the letter to a
 * fallback, and the stored row records whoever actually answered (writeLetterText's `model`).
 * ⚠️ ≤ 48 chars — user_employer_documents.model is VARCHAR(48) and Postgres refuses, not truncates.
 */
const LETTER_MODEL = 'gemini-2.5-flash';

/**
 * Folded into the fingerprint next to employerResearch.RESEARCH_REV. Bump when THIS prompt changes
 * shape: the stored letters are still faithful to their inputs, but they answer different instructions.
 * (employerDocs.FP_VERSION would invalidate every resume too.)
 *
 * ⚠️ A BUMP RE-BILLS EVERY LETTER EVER STORED, so it is a money decision, not a version number. It moves
 * every fingerprint at once: every saved letter reads as stale, and the next build for an employer the user
 * already paid for is a full charge for a letter they have. It is worth that only when the stored letters
 * would be WRONG — not when a new one would merely be better.
 * ⚠️ WHICH IS WHY THE CONVENTIONS SLICE (2026-09-14) DID NOT BUMP IT. Hiring conventions set the register,
 * the length band and the paragraph emphasis (letterStyleFor) — the same facts, addressed to the same
 * employer, in a tone that suits them. A stored letter is still a true letter, so nobody is charged for
 * ours having improved. Telling the two apart later needs no marker in the fingerprint either: a letter
 * written with them has them in its stored `research.conventions`.
 * ⚠️ NOR DID THE EMPLOYER-SPECIFIC SLICE (2026-09-15): the sector-led opening paragraph and the employer's
 * register are the same rule (the same facts, said for this employer), and the brand (design.brand — the
 * employer's colour and font on every design) is RENDERING, not writing: a stored letter without one reads
 * its brand back from its research at render time (coverLetterController.letterBrandOf).
 */
const LETTER_REV = 'letter-v1';

/**
 * ⚠️ ONE AI WINDOW FOR THE WHOLE BUILD, counted from the handler's first line. The app polls a build for 6 minutes
 * (homeAddEmployer DEADLINE_MS), and after the AI this lane still ranks designs, waits on the usage lock (≤ 15 s)
 * and lays out thumbnails (≤ 20 s). So research (≤ 25 s), every draft, every pause, every fallback model and the
 * corrective pass must all END inside these 4 minutes — not each inside a cap of its own. The old lane gave each
 * call 80 s and three calls could add up; a fallback chain that simply added its caps on top (60 + 40 + 40 + 40 s a
 * draft, twice, plus a corrective pass) would outlive the app that is waiting for it. Worst case now:
 * 240 s of research + AI, + 15 s lock + 20 s thumbs ≈ 275 s, with the rest of the 6 minutes left for the queue.
 *   windowMs            the AI deadline, from the handler's first line. A joiner that waited on a leader has spent
 *                       part of it waiting, so the chain it runs after that leader failed is short on purpose.
 *   draftBudgetMs       one draft's whole chain (aiText's own caps inside it: 60 s the first try, 40 s each later one)
 *   correctionBudgetMs  the placeholder pass. The first draft is already good enough to keep, so it gets less.
 *   minCallMs           never START the lane's bad-output retry or the corrective pass with less than this left:
 *                       a chain with no room would end as an "AI is busy" the provider never said.
 * Read at call time; the suite shrinks them. Nothing in production writes them.
 */
const LETTER_AI = {
    windowMs: 4 * 60 * 1000,
    draftBudgetMs: 3 * 60 * 1000,
    correctionBudgetMs: 90 * 1000,
    minCallMs: 20 * 1000,
};

/** The parsed upload rides into the prompt AND the fingerprint capped at the same length — one string. */
const UPLOAD_CONTEXT_MAX = 24000;
/** Posting text in the prompt. The fingerprint hashes the whole text (both sides see all of it). */
const POSTING_PROMPT_MAX = 12000;
const TAILORED_PROMPT_MAX = 20000;

// ── Letter thumbnails ────────────────────────────────────────────────────────────────────────────
// ⚠️ ON THE PERSISTENT VOLUME, IN A DOT DIRECTORY. temp/ is wiped by every deploy, and a letter's
// thumbs would then be re-rendered (serial chromium) on the first Home open after each release.
// uploads/ is the Railway volume — but express.static('uploads') serves it publicly at /uploads, and a
// thumb carries the user's name, email and phone. serve-static's default dotfiles:'ignore' answers 404
// for any path with a dot segment, so /uploads/.thumb_cache/… is never served. The resume doc thumbs
// share the scheme (file prefix differs: cl_ here), and each lane prunes only its own prefix.
const THUMB_ROOT = process.env.DOC_THUMB_CACHE_DIR || path.join(__dirname, '../../uploads/.thumb_cache');
const THUMB_W = 480;
const LETTER_THUMB_KEEP = 120;   // per user, cl_ files only — ~17 letters with every design rendered
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

/** The upload as the prompt sees it — keys sorted, bookkeeping stripped, empties dropped, capped. */
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
 * The candidate's own material — the ONLY source of truth about them. null = they have no résumé.
 *
 * base: resumeScorer.narrativeFor({ base: true, strict: true }) — the résumé the user OWNS, never the
 *   row a tailored build last overwrote (tailoring must not compound across employers). strict: a DB
 *   failure THROWS instead of reading as "no résumé" (telling someone who has one to upload one is how
 *   they end up overwriting it).
 * upload: the parsed upload, as the resume doc lane feeds its prompt (includeUploadedResume). Skipped
 *   when the narrative already IS the upload — the same facts twice only cost tokens.
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
 * Every input the prompt sees that can change the letter's WORDS: the base narrative, the parsed upload,
 * the posting's title / text / link, the website, the research revision and this prompt's revision.
 *
 * ⚠️ DELIBERATELY NOT HASHED — each for a reason that is about money:
 *   • the employer's tailored RESUME doc. It is derived from the same base (the doc lane adds no facts),
 *     so it moves nothing true; hashed, every letter would turn "stale" the moment its resume landed,
 *     and a letter and resume built side by side would race each other into a paid Refresh. The build
 *     only reads a tailored resume whose own fingerprint is CURRENT (see tailoredResumeFor), so a
 *     pre-edit resume can never feed old facts into a new letter.
 *   • the research itself (only RESEARCH_REV) — its `conventions` included: a 30-day cache refresh, or
 *     conventions fetched onto an old cache row, must not re-bill every letter.
 *   • `country`: since the conventions slice the country (through regionForConventions) and the conventions
 *     set the letter's REGISTER, length band and structure (letterStyleFor) — never its facts. A chip that
 *     learns its country later must still not make a finished letter stale or bill a Refresh for a change
 *     of tone; the design ranking it also reorders costs nothing.
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

/**
 * This employer's tailored resume, when one exists AND was written from the user's CURRENT résumé.
 * ⚠️ A stale tailored resume carries facts from before the user's last edit (an old title, a date they
 * corrected). Letting it into the prompt would write those back into a brand-new letter — so its own
 * fingerprint must equal the resume lane's current one, or it is ignored. If the resume lane cannot
 * say (export missing, unreadable), it is ignored too: the base résumé alone is always enough.
 * ⚠️ Found by the chip's IDENTITY (docJobUrl — the job_url the resume doc lane stores), compared by the
 * job it was WRITTEN against (job, incl. a pasted posting link): an employer-level chip's resume lives
 * under job_url '' even when both documents were written against a posting.
 */
async function tailoredResumeFor(userId, { company, employerId, job, docJobUrl }, req) {
    try {
        const rdoc = await employerDocsMod().currentFor(userId, 'resume', { employer: company, employerId, jobUrl: docJobUrl }, req);
        if (!rdoc || !rdoc.payload || typeof rdoc.payload !== 'object' || !rdoc.payload.personal_info) return null;
        const rb = require('./resumeBuilderController');
        if (typeof rb.currentResumeFingerprint !== 'function') return null;
        const fp = await rb.currentResumeFingerprint(userId, {
            job: { company, title: job.title, url: job.url, description: job.description, website: job.website }, env: req,
        });
        return fp && fp === rdoc.input_fingerprint ? rdoc.payload : null;
    } catch (e) {
        console.warn('[employerLetter] tailored resume unreadable (writing from the base alone):', e.message);
        return null;
    }
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
 * Any OTHER failure — bad output twice, every model truncated — keeps the 500 / 504 it always had.
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

/** AI_BUSY / AI_DOWN for aiText's final failure, or null for anything else (kind 'other' is not an outage). Read by
 *  name, like aiText.isAiBusy, so a second copy of that module in the require cache still answers. */
function aiEndingOf(e) {
    if (!e || e.name !== 'AiUnavailableError') return null;
    if (e.kind === 'busy') return AI_BUSY;
    if (e.kind === 'quota' || e.kind === 'auth') return AI_DOWN;
    return null;
}

// ── The letter itself ────────────────────────────────────────────────────────────────────────────

/** research.conventions when it is a usable object, else null (an old cache row or an old research module). */
const conventionsOf = (facts) => (facts && facts.conventions && typeof facts.conventions === 'object'
    && !Array.isArray(facts.conventions) ? facts.conventions : null);

/**
 * employerResearch.conventionsPromptBlock, defensively: '' when there are no conventions, the export is
 * missing (a research module from before the conventions slice) or it throws. The block carries its own
 * guard rails (conventions shape format and emphasis, never the candidate's facts); the prompt repeats them.
 */
function conventionsBlockFor(research, conventions, company) {
    if (!conventions || !research || typeof research.conventionsPromptBlock !== 'function') return '';
    try { return String(research.conventionsPromptBlock(conventions, company, { forLetter: true }) || ''); }
    catch (e) { console.warn('[employerLetter] conventions block unavailable:', e.message); return ''; }
}

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

const LETTER_REGISTER_DEFAULT = 'professional but human — someone who did their homework, not a template. Clear, direct, medium vocabulary; vary sentence length.';

// ── The country's own letter habits ───────────────────────────────────────────────────────────────
// ⚠️ A LETTER TAKES THE REGISTER AND STRUCTURE HALF OF THE PLAYBOOK, AND NOTHING ELSE. cvPlaybook answers
// "how is a CV written where this application is going" for every country regionFromCountry knows. A cover
// letter keeps only the half a letter can honour — how formal it reads, how long it runs, how it opens and
// how it closes — and must NEVER carry a CV habit: no photo, no date of birth, no personal details, no page
// count, no date pattern, no section order, no projects policy. Those belong to the résumé, and a letter that
// mentions one is a defect, not a convention. Two mechanisms, not one promise:
//   • countryLetterRowOf reads ONLY playbook.source and playbook.profile. The playbook's cv half is never
//     read in this file at all, so the CV habits cannot leak from the table — there is no path;
//   • letterPlaybookBlockFor puts cvPlaybook's own letter block through letterSafeBlock, so a CV line that
//     ever appears in it is dropped HERE, in the lane that must not carry it, rather than trusted away.
// ⚠️ THE SALUTATION, THE DATE LINE AND THE SIGNATURE BLOCK ARE THE TEMPLATE'S, NOT THE MODEL'S. Every design
// prints "Dear …", the date and the sign-off itself (parseLetterOutput strips them from the body precisely
// because a model that writes one has it printed twice), so no country rule here may ask for any of them.
// Who the letter is addressed TO is likewise decided after the call, from evidence: a name only where the
// posting or the research states one.

/**
 * How a letter READS where this application is going, per regionFromCountry CV profile — all 17, so every
 * country that table knows is answered. Three columns, and deliberately only three:
 *   register  — how formal (the prompt's TONE line);
 *   words     — how long, never below the ~230-word floor letterStyleFor documents;
 *   structure — ONE line about the arc or the closing, and only where that country departs from the
 *               four-paragraph shape the prompt already describes. Most countries close a letter the same
 *               way; seventeen slightly different sentences saying so would be prompt noise, paid for twice
 *               whenever the corrective pass re-sends the prompt.
 * ⚠️ WHAT IS NOT HERE, AND WHY: emphasis — what evidence leads, how it is presented — is cvPlaybook's own
 * letter block, printed beside this one (letterPlaybookBlockFor). The two are split by subject so they never
 * say the same thing twice: register, length and the closing here; the opening and the emphasis there.
 * ⚠️ NO COUNTRY OVERRIDE TABLE. regionFromCountry's profile IS the grouping of countries that read a letter
 * the same way, and a register that differed from a country's neighbours' would be a claim this file cannot
 * source. A country that really does depart belongs in that table, where the whole app reads it.
 */
const LETTER_PROFILES = {
    // US, Israel, Puerto Rico — the shortest, plainest letter in the table; it is scanned once.
    anglo1: {
        register: 'direct and specific — plain sentences, concrete nouns, no ceremony.',
        words: '250-350',
        structure: 'Four paragraphs and a one-sentence close: this letter gets one quick read.',
    },
    // UK, Ireland, Canada, Australia, NZ and the Commonwealth by proxy.
    anglo2: {
        register: 'professional and understated — evidence before adjectives, no superlatives, no hard sell.',
        words: '300-400',
        structure: null,
    },
    // Germany, Austria, Switzerland — the Anschreiben: formal, impersonal, and it closes on the meeting.
    dach: {
        register: 'formal and impersonal — complete sentences, no contractions, no exclamation marks, no casual asides.',
        words: '300-400',
        structure: 'Close by offering to discuss the role in person, rather than restating the letter.',
    },
    // France, Belgium, Luxembourg — the lettre de motivation, and its "vous-moi-nous" arc.
    franco: {
        register: 'formal and courteous throughout — complete sentences, no contractions, no familiarity.',
        words: '300-400',
        structure: 'The arc this market reads is: what the employer needs, then what the candidate brings, then what they would do together.',
    },
    // Maghreb, francophone and lusophone Africa.
    franco_ext: {
        register: 'ceremonious and correct — complete sentences, no contractions, no familiarity.',
        words: '300-400',
        structure: null,
    },
    // Italy, Portugal, Greece, Malta, Cyprus.
    south_eu: {
        register: 'formal and measured — complete sentences, courteous phrasing, no casual asides.',
        words: '300-400',
        structure: null,
    },
    // Spain, Andorra.
    iberia: {
        register: 'formal but warm — courteous complete sentences, no casual phrasing.',
        words: '300-400',
        structure: null,
    },
    // Netherlands and the Nordics — ceremony reads as padding here.
    north_eu: {
        register: 'matter-of-fact — concrete, unadorned sentences; no superlatives and no flattery.',
        words: '250-350',
        structure: 'Close in a single sentence — anything longer reads as padding here.',
    },
    // Central & Eastern Europe, the Baltics.
    cee: {
        register: 'professional and formal — complete sentences, no contractions.',
        words: '300-400',
        structure: null,
    },
    // Russia, the Caucasus, Central Asia, Turkey.
    cis: {
        register: 'formal and business-like — complete sentences, no casual asides.',
        words: '280-380',
        structure: null,
    },
    // The Gulf states, the Levant, Egypt.
    gulf: {
        register: 'formal and courteous — polished and respectful throughout.',
        words: '300-400',
        structure: null,
    },
    // Anglophone Africa.
    africa_en: {
        register: 'formal and respectful — complete sentences, courteous, no casual phrasing.',
        words: '300-400',
        structure: null,
    },
    // India, Pakistan, Bangladesh, Sri Lanka, Nepal — skills and projects are what is read first.
    south_asia: {
        register: 'respectful and professional — courteous complete sentences, no slang and no hard sell.',
        words: '300-400',
        structure: 'Paragraphs 2 and 3 stay with the skills, tools and projects the material names — that is what is read first here.',
    },
    // Singapore, Hong Kong, Macau.
    sg: {
        register: 'concise and corporate — precise sentences, no filler.',
        words: '250-350',
        structure: 'Stay at the lower end of the length band: a long letter is skimmed here.',
    },
    // Malaysia, Indonesia, the Philippines, Thailand, Vietnam.
    sea: {
        register: 'polite and professional — courteous complete sentences, warm but never familiar.',
        words: '300-400',
        structure: null,
    },
    // Japan, Korea, China, Taiwan — modesty is the register; self-promotion reads badly.
    east_asia: {
        register: 'formal and deferential — courteous, measured sentences that never boast.',
        words: '250-350',
        structure: null,
    },
    // Latin America.
    latam: {
        register: 'warm but professional — complete sentences, no slang and no familiarity.',
        words: '300-400',
        structure: null,
    },
};

/**
 * The row for the country this application is going to, or null.
 * ⚠️ ONLY A RESOLVED COUNTRY SPEAKS. A playbook built from a region WORD ("Europe", "APAC") knows less than
 * letterStyleFor's own region switch already does — its `profile` is a nearest proxy, not that region's
 * habit — so it is left to the region switch, exactly as cvPlaybook leaves its own region rows.
 * ⚠️ `source` and `profile` are the only two fields this lane reads from a playbook. Not `cv`, ever.
 */
function countryLetterRowOf(playbook) {
    const pb = playbook && typeof playbook === 'object' ? playbook : null;
    if (!pb || pb.source !== 'country') return null;
    return LETTER_PROFILES[pb.profile] || null;
}

/**
 * The country playbook for THIS application — cvPlaybook.playbookFor, defensively: null when the module is
 * absent (a deploy mid-slice), when it is older than the playbook slice, when it answers null, or when it
 * throws. A null playbook writes the letter exactly as this lane wrote it before any of this existed.
 * ⚠️ RESOLVED ONCE PER BUILD and handed to both the style and the block. Two resolutions could disagree, and
 * a letter written for one country while its designs are ranked for another is the one thing that must not
 * happen — the same rule the doc lane carries.
 */
function letterPlaybookFor({ country, website, conventions, research }) {
    try {
        const mod = playbookMod();
        if (!mod || typeof mod.playbookFor !== 'function') return null;
        return mod.playbookFor({ country: country || null, website: website || null, conventions, research }) || null;
    } catch (e) {
        console.warn('[employerLetter] country playbook unavailable:', e.message);
        return null;
    }
}

/**
 * A CV habit, in the letter lane. Any line naming one is DROPPED before the model ever sees it: a photo, a
 * date of birth or nationality, personal details, a page count, a date pattern, a section order, the CV's own
 * sections. They are all legitimate in a résumé prompt and all defects in a letter — the letter's ABSOLUTE
 * RULES tell the model so, and this makes sure it is never told the opposite three lines earlier.
 */
const CV_HABIT_RE = new RegExp([
    'photo|photograph|headshot',
    'date of birth|birth date|\\bdob\\b|marital|civil status|nationality|passport|personal details',
    '\\bpages?\\b|one[- ]page|two[- ]pages|page count',
    '\\bcvs?\\b|curriculum vitae|\\br[eé]sum[eé]s?\\b',
    'section order|\\bheadings?\\b|\\bbullets?\\b|skills block|skills section|projects section',
    'date format|\\bdates\\b|mm/yyyy|mmm yyyy',
].join('|'), 'i');

/** cvPlaybook's own closing guard rail — kept, but it is not a rule, so a block of nothing but it is empty. */
const PLAYBOOK_CLOSER_RE = /habits of the place|never mention this guidance/i;
const PLAYBOOK_RULES_MAX = 5;

/**
 * cvPlaybook's letter block, made letter-safe: the header, then the rules that carry no CV habit, capped.
 * '' when nothing actionable survives — a header with no rule under it is tokens, not guidance.
 * ⚠️ THIS FILTER IS THE POINT. cvPlaybook is a CV module: its letter variant is written to carry none of this
 * today, and this lane still refuses to depend on that staying true through somebody else's future edit.
 */
function letterSafeBlock(raw) {
    const lines = String(raw || '').split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return '';
    const head = /^===/.test(lines[0]) ? lines[0] : '';
    const rules = [];
    let closer = '';
    let dropped = 0;
    for (const line of lines) {
        if (!/^-\s/.test(line)) continue;
        if (CV_HABIT_RE.test(line)) { dropped++; continue; }
        // ⚠️ THE GUARD RAIL IS NOT A RULE AND NEVER COUNTS AGAINST THE CAP. "these are habits, not facts about
        // the candidate" is the line that keeps the whole block honest: a block long enough to be trimmed is
        // exactly the one that must keep it.
        if (PLAYBOOK_CLOSER_RE.test(line)) { closer = closer || line; continue; }
        if (rules.length >= PLAYBOOK_RULES_MAX) continue;
        if (!rules.includes(line)) rules.push(line);
    }
    if (dropped) console.warn(`[employerLetter] ${dropped} CV line(s) dropped from the country letter block — a letter never carries them`);
    if (!rules.length) return '';
    return [head, ...rules, closer].filter(Boolean).join('\n');
}

/** The block for the prompt, or '' — never throws, and never a second resolution of the country. */
function letterPlaybookBlockFor(playbook, company) {
    if (!playbook) return '';
    try {
        const mod = playbookMod();
        if (!mod || typeof mod.playbookPromptBlock !== 'function') return '';
        return letterSafeBlock(mod.playbookPromptBlock(playbook, company, { forLetter: true }));
    } catch (e) {
        console.warn('[employerLetter] country letter block unavailable:', e.message);
        return '';
    }
}

/**
 * How THIS employer reads a cover letter: { words, register, notes[] } for the prompt's HOW TO WRITE IT.
 *
 * ⚠️ DETERMINISTIC, NOT A SECOND AI GUESS. The facts come from one grounded research call (conventions), the
 * country playbook and the region; this maps them onto the three things a letter can honestly change —
 * register, length band, paragraph emphasis. The shape the templates depend on never moves: four paragraphs,
 * no salutation, no sign-off, English (see buildEmployerLetterPrompt). The band never goes below ~230 words:
 * parseLetterOutput refuses < 120 and the placeholder guard < 80, and a strip must not push a short letter
 * under either.
 *
 * THE ORDER, and it is the same one every other merge in this lane uses — the more specific answer wins:
 *   1. the EMPLOYER TYPE leads (contract 2: the employer, not the candidate's seniority, decides the format);
 *   2. the COUNTRY, when the playbook resolved one, fills the register and the band the type left at their
 *      defaults, and adds its one structure line either way (that line describes what the closing paragraph
 *      DOES, never how formal it is, so it cannot fight the type's register);
 *   3. the REGION switch — six broad habits — speaks only when no country did. ⚠️ NEVER BOTH: a Dutch letter
 *      hearing continental Europe's "formal, no contractions" and the Netherlands' "direct and plain" in one
 *      prompt is two instructions that disagree, which is worse than the one we had before the country knew.
 * `playbook` is optional: a caller without one (an older path, an unavailable cvPlaybook) gets exactly the
 * style this function returned before the country was known.
 */
function letterStyleFor(conventions, region, playbook) {
    const c = conventions && typeof conventions === 'object' ? conventions : null;
    let words = '300-450';
    let register = LETTER_REGISTER_DEFAULT;
    const notes = [];
    // Whether the EMPLOYER TYPE spoke — set inside each case, so a type the switch does not answer cannot
    // silently read as one that did, however the cases are edited later.
    let byType = false;
    switch (c && c.employerType) {
        case 'public_sector':
            byType = true;
            words = '350-450';
            register = 'formal and measured — complete sentences, no contractions, no casual phrasing, no sales language.';
            notes.push('Public-sector hiring is criteria-led: in paragraphs 2 and 3 answer the requirements the posting states, in its own terms, one at a time — only with experience the candidate really has.');
            break;
        case 'academia':
            byType = true;
            words = '350-450';
            register = 'formal and scholarly but readable — no contractions, no sales language.';
            notes.push('Where the candidate\'s material shows research, teaching, publications or grants, those lead paragraphs 2 and 3; never add any it does not contain.');
            break;
        case 'enterprise':
            byType = true;
            words = '300-400';
            register = 'professional and polished — confident and specific, no hyperbole.';
            notes.push('Large employers screen fast: the strongest real match to the role opens paragraph 2.');
            break;
        case 'sme':
            byType = true;
            words = '280-380';
            register = 'professional and personable — practical, showing breadth and hands-on ownership.';
            break;
        case 'startup':
            byType = true;
            words = '230-320';
            register = 'direct and plain-spoken — short sentences, no corporate filler.';
            notes.push('Lead with what the candidate shipped and owned; keep every paragraph short.');
            break;
        case 'agency':
            byType = true;
            words = '250-350';
            register = 'crisp and outcome-led — client-facing polish, no filler.';
            notes.push('Lead with delivered work and the results the candidate\'s material states.');
            break;
        case 'ngo':
            byType = true;
            words = '300-400';
            register = 'warm but professional — sincere and concrete, no sales language.';
            notes.push('Connect to the organisation\'s mission only through facts in the research above.');
            break;
        default: break;
    }
    // THE COUNTRY, when one resolved — register and length only where the employer type left them alone.
    const row = countryLetterRowOf(playbook);
    if (row) {
        if (!byType) { words = row.words; register = row.register; }
        if (row.structure) notes.push(row.structure);
    }
    // …and the region only where it did not: one voice about where this letter is going, never two.
    if (!row) switch (region) {
        case 'dach':
            notes.push('German-speaking employers expect a formal, structured letter: no contractions, no exclamation marks, no casual asides.');
            break;
        case 'eu':
            notes.push('European motivation-letter habit: paragraph 1 opens with why this employer and this role before the candidate\'s background; keep the register formal, with no contractions.');
            break;
        case 'uk_au':
            notes.push('Understated register: evidence over adjectives, no superlatives.');
            break;
        case 'us_ca':
            notes.push('Achievement-led: name concrete results the candidate\'s material states early in paragraph 2.');
            break;
        case 'india':
            notes.push('Respectful, professional register; skills and projects lead.');
            break;
        case 'sg':
            notes.push('Concise corporate register; stay at the lower end of the length band.');
            break;
        default: break;
    }
    // The register the conventions observed in this employer's OWN hiring communication ("direct",
    // "formal and institutional") — folded into the tone, never into the facts. Formality and length come
    // from the employer type above; this only tunes the voice inside that band.
    if (c && typeof c.tone === 'string' && c.tone.trim()) {
        notes.push(`Match the register of the employer's own hiring communication — "${c.tone.trim().slice(0, 120)}" — within the tone above.`);
    }
    return { words, register, notes };
}

/**
 * The prompt. ⚠️ WHY NOT ai-cover-letter-v2.generateCoverLetter: its proven prompt researches the
 * employer LIVE ("use Google Search aggressively… name specific clients"), and this lane's contract is the
 * opposite — the employer research is one cached, sanitised block, and the letter may NOT say anything
 * about the employer beyond it or the posting. Handing the model both instructions gives it two sources of
 * truth to disagree with. So v2's proven PARTS are reused where they fit — the four-paragraph structure,
 * the tone and banned-phrase list, the bold rules, the no-salutation/no-sign-off body contract the
 * templates depend on, the international-safety rule and the English-output rule — and the research,
 * the posting and the candidate's material are the only facts it gets. No live search tool is attached.
 * ⚠️ Every input here must be in letterFingerprintOf, or be one of the documented exclusions there.
 */
function buildEmployerLetterPrompt({ company, website, job, material, tailored, researchBlock, conventionsBlock, playbookBlock, style, sector, correction }) {
    const st = style && typeof style === 'object' ? style : letterStyleFor(null, 'generic');
    // The employer's sector (the conventions' sector, else the research's industry), so paragraph 1 opens
    // with the candidate's fit for THAT field in the employer's own vocabulary — the difference between a
    // letter written for this employer and one that could open a letter to anyone. '' = no sector known.
    const sec = typeof sector === 'string' ? sector.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    // ⚠️ SAID ONCE. The country block and these notes are split by subject (register, length and the closing
    // here; the opening and the emphasis there), so they do not collide today — but either table can gain a
    // line later, and a rule the prompt states twice is a rule the model weighs twice. A note the block
    // already carries word for word is therefore dropped rather than repeated.
    const blockPlain = plainOf(playbookBlock);
    const notes = (Array.isArray(st.notes) ? st.notes : []).filter((n) => !(blockPlain && blockPlain.includes(plainOf(n))));
    const styleNotes = notes.length ? `\nFOR THIS EMPLOYER:\n${notes.map((n) => `- ${n}`).join('\n')}\n` : '';
    const posting = !!(job.title.trim() || job.description.trim());
    const tailoredJson = tailored ? (() => {
        // Contact details are the template's business, not the model's.
        const { personal_info: pi, design: _d, _buildMethod: _b, ...rest } = tailored;
        return JSON.stringify({ title: (pi && pi.title) || '', ...rest }, null, 1).slice(0, TAILORED_PROMPT_MAX);
    })() : '';

    const roleBlock = posting
        ? [
            '=== THE ROLE (a job posting was given — it is authoritative for what the role involves) ===',
            `Title: ${job.title.trim() || '(not given)'}`,
            job.url.trim() ? `Link: ${job.url.trim()} (for reference only — it has NOT been opened; infer nothing from it)` : '',
            job.description.trim() ? `Posting text:\n---\n${job.description.slice(0, POSTING_PROMPT_MAX)}\n---` : '',
            'Use the posting for the role\'s real duties, requirements and seniority. Where it asks for something the candidate genuinely has, say so in the posting\'s own words. Where it asks for something they do not have, say nothing about it — never imply it.',
        ].filter(Boolean).join('\n')
        : [
            '=== THE ROLE (no job posting was given) ===',
            `This is an application to ${company} for a role that matches the candidate's experience. Write it for the role their material points to — their current or most recent job title.`,
            'Never call it an "open", "speculative", "unsolicited", "general" or "spontaneous" application, and never invent a vacancy, a team or a requisition.',
        ].join('\n');

    const noResearch = `(No research is available for ${company}. Do not describe its products, customers, figures, news, values or culture. If what ${company} does is not plain from its name or the posting, keep the "why ${company}" part to the kind of work the candidate wants to do there.)`;

    return `You are an expert cover letter writer. Write ONE cover letter from the candidate below to ${company}.
Return ONLY the JSON object described at the end.

=== THE CANDIDATE'S OWN MATERIAL (the ONLY source of truth about the candidate) ===
--- Resume ---
${material.baseText}
${material.uploadText ? `--- Details parsed from their uploaded resume ---\n${material.uploadText}\n` : ''}${tailoredJson ? `--- The same resume, already tailored for ${company} (the same facts, ordered for this employer — use it to decide which strengths lead) ---\n${tailoredJson}\n` : ''}
=== THE EMPLOYER ===
Company: ${company}
${website ? `Website: ${website} (identifies the company only — it has not been opened)\n` : ''}
${researchBlock || noResearch}
${conventionsBlock ? `\n${conventionsBlock}\n` : ''}${playbookBlock ? `\n${playbookBlock}\n` : ''}
${roleBlock}

=== HOW TO WRITE IT ===
Four paragraphs separated by one blank line, ${st.words || '300-450'} words in total:
1. Introduction and connection to ${company}. ${sec
        ? `The FIRST sentence states the candidate's fit for ${sec}: their current or most recent title, and the one or two real strengths from their material that matter most in ${sec}, said in the vocabulary ${company} uses (the technologies, products, mission or posting terms above — only ones the candidate genuinely has). Only when their material states or clearly dates it, their years of experience.`
        : `One factual opening sentence: the candidate's current or most recent title and, only when their material states or clearly dates it, their years of experience.`} Then two or three sentences on why ${company}: name something specific ONLY when the research above or the posting states it; otherwise speak to the field ${company} is plainly in, without specifics. The opening must read as written for ${company}: never a sentence that could open a letter to any employer.
2. Skills and domain match. Connect four to six of the candidate's real skills, tools or projects to what ${company} does or what the posting asks for — one concrete link each.
3. Value. Two or three concrete things from the candidate's material (roles held, projects delivered, results they stated) and how they answer ${company}'s needs.
4. Closing. Genuine interest in contributing to the team, then one direct thank-you sentence.

TONE: ${st.register || LETTER_REGISTER_DEFAULT}
${styleNotes}Never use: delve, testament, tapestry, leverage, synergy, spearhead, multifaceted, holistic, passion, passionate, thrilled, excited, eager, fascination, "deeply resonates", "drawn to", "proven track record", "I am writing to express", "I am confident that", "I believe I am", "ideal candidate", "innovative company", "leading firm", "dynamic environment".

BOLD with **double asterisks**: ${company}'s name, the candidate's role titles, their years of experience, and every named skill, tool, technology, product, project or client you mention (only ones that exist in the material, the research or the posting). About 10-20 bold items; never bold a whole sentence.

=== ABSOLUTE RULES ===
- About the candidate: NEVER add an employer, job title, date, degree, certification, skill, tool, metric, number, client, project or achievement their material does not contain, and never imply more experience than it supports. A number appears only when the material states it.
- About ${company}: NEVER state a product, customer, project, figure, award, office, value, person or piece of news that is not in the research block or the posting text above.
- NEVER claim willingness to relocate, visa or work-permit status, notice period, availability or salary expectations unless the candidate's material states it.
- NO placeholders of any kind: no square brackets, no [X%], [Insert ...], [Company Name], [Your Name], XX%, "X years". When a detail is unknown, write the sentence without it.
- NO salutation ("Dear ...") and NO sign-off ("Sincerely", "Best regards", the candidate's name) inside cover_letter — the letter template adds both.
- NO headings, bullet points or numbered lists inside cover_letter.
- Internationally safe: never mention age, date of birth, marital status, religion, nationality, gender, a photo, family details or salary figures.
- Hiring conventions and the country's letter conventions (above) shape register, length, structure and emphasis ONLY — they never add a fact about the candidate or ${company}. CV conventions about photos, date of birth, personal details or how many pages a resume runs to belong to the resume: never mention them in this letter, and never write a date line, an address block or a signature into it.

=== OUTPUT — only this JSON object ===
{
  "position": "${posting ? 'the posting title exactly as given' : "the candidate's current or most recent job title"} — never 'open application', never square brackets",
  "to": "the hiring contact's full name ONLY if the posting text names one, otherwise \\"Hiring Manager\\"",
  "addresses": ["an office address ONLY if it is written in the posting text or the research above; otherwise leave this array empty"],
  "cover_letter": "PARAGRAPH 1\\n\\nPARAGRAPH 2\\n\\nPARAGRAPH 3\\n\\nPARAGRAPH 4"
}

OUTPUT LANGUAGE — ABSOLUTE: write the whole letter in plain professional English, even when the material, the research or the posting is in another language, or the employer's country usually writes letters in one. Keep proper nouns (company, product, technology and place names) exactly as written.${correction ? `\n\n=== CORRECTION — YOUR PREVIOUS DRAFT WAS REJECTED ===\nIt contained placeholders: ${correction.join(', ')}. Write the whole letter again with NO placeholder, bracket or unknown-number marker anywhere. Where a number, name or detail is unknown, write the sentence without it.` : ''}`;
}

/**
 * Gemini's responseSchema is a SUBSET of JSON Schema (type/properties/required/items/description) —
 * it guarantees the SHAPE; lengths and content are enforced by parseLetterOutput. No search tool is
 * attached, which is also what makes responseMimeType JSON legal here (v2 cannot use it).
 */
const LETTER_SCHEMA = {
    type: 'object',
    properties: {
        position: { type: 'string', description: 'The role this letter applies for. Never "open application", never brackets.' },
        to: { type: 'string', description: 'A hiring contact named in the posting text, otherwise "Hiring Manager".' },
        addresses: { type: 'array', items: { type: 'string' }, description: 'Office addresses written in the posting or research; usually empty.' },
        cover_letter: { type: 'string', description: 'Four paragraphs separated by blank lines. No salutation, no sign-off, no lists.' },
    },
    required: ['position', 'to', 'addresses', 'cover_letter'],
};

// ⚠️ maxOutputTokens stays generous: gemini-2.5-flash spends "thinking" tokens from the SAME budget, and a
// tight cap truncates the JSON mid-object (the failure both existing lanes hit and documented). The same config
// goes to EVERY model in the chain — the fallbacks were measured with exactly this one (2026-09-18: valid JSON,
// 235-282 words, from gemini-2.5-flash-lite in 2.3 s).
const letterGenerationConfig = () => ({ temperature: 0.7, maxOutputTokens: 32768, responseMimeType: 'application/json', responseSchema: LETTER_SCHEMA });

/**
 * One piece of letter text → { text, model }, through aiText.generateText. The pause before the primary's second
 * try, the fallback chain, a per-attempt cap that really ABORTS a hung request, and one budget for the whole chain
 * all live there (its header has the incident and the measurements).
 *
 * ⚠️ WHAT THIS REPLACED — 2026-09-18. callLetterModel asked LETTER_MODEL once, and the build loop asked it again
 * the same millisecond: two 503 "high demand" answers 0 ms apart, and Amazon's letter "didn't finish".
 *
 * ⚠️ A THROW HERE IS FINAL FOR THE BUILD. aiText throws only AiUnavailableError, and only after it has waited,
 * retried and walked every model it may use inside `budgetMs` — so the lane never retries one (a second chain
 * would only outlive the app's deadline). busy / quota / auth become AI_BUSY / AI_DOWN in the build's catch; kind
 * 'other' (every model truncated, or refused the request) keeps today's 500 and its own message.
 * Output the LANE rejects (not JSON, too short, placeholders) is not a provider failure and never reaches aiText:
 * the build loop keeps its own bad-output retry for that.
 *
 * `model` is the model that ANSWERED — what the stored letter records, and NEVER a fingerprint input: a letter a
 * fallback wrote must be the same free cache hit next time as one the primary wrote (letterFingerprintOf).
 * `deadline` is the build's AI deadline (LETTER_AI.windowMs from its first line); the chain gets the smaller of
 * `budgetMs` and what is left of it. `report` / `pct` put each retry on the user's progress bar in plain words.
 */
async function writeLetterText(prompt, { deadline, budgetMs, report, pct }) {
    const aiText = aiTextMod();
    const { text, model } = await aiText.generateText({
        lane: 'letter',
        prompt,
        config: letterGenerationConfig(),
        models: [LETTER_MODEL, ...aiText.fallbackModels()],
        budgetMs: Math.max(0, Math.min(budgetMs, deadline - Date.now())),
        // Awaited by aiText, and anything it throws is ignored there — a progress write can never break a build.
        onRetry: ({ model: was, kind, nextModel }) => (typeof report === 'function' ? report('retry',
            nextModel !== was ? 'Switching to a faster model'
                : kind === 'transient' ? "Google's AI is busy — trying again" : 'Taking another pass at it',
            pct) : undefined),
    });
    return { text, model };
}

const SIGN_OFF_WORDS = 'sincerely|yours sincerely|yours faithfully|yours truly|best regards|kind regards|warm regards|warmest regards|regards|respectfully|best wishes';
/** A whole closing paragraph: "Sincerely,\nJane Doe\njane@x.com" (a bare "Best," / "Thank you," too). */
const SIGN_OFF_RE = new RegExp(`^(${SIGN_OFF_WORDS}|best|thank you|thanks)[,.!]?(\\s*\\n[^\\n]{0,80}){0,3}$`, 'i');
/** A closing glued onto the last paragraph with single newlines: "…your time.\nSincerely,\nJane Doe". */
const TRAILING_SIGN_OFF_RE = new RegExp(`\\n+[ \\t]*(${SIGN_OFF_WORDS})[,.!]?([ \\t]*\\n[^\\n]{0,80}){0,3}\\s*$`, 'i');

/**
 * The model's JSON → { position, to, addresses, body } or a throw (AI_BAD_OUTPUT → the retry).
 * ⚠️ The templates print "Dear Hiring Manager," and the closing themselves, so a salutation or sign-off
 * that slipped into the body would appear TWICE on every design — they are removed here, not trusted away.
 */
function parseLetterOutput(text, { candidateName = '' } = {}) {
    let o;
    try { o = JSON.parse(String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()); }
    catch { throw new Error('AI_BAD_OUTPUT: not JSON'); }
    if (!o || typeof o !== 'object') throw new Error('AI_BAD_OUTPUT: not an object');

    let body = String(o.cover_letter || '').replace(/\r\n?/g, '\n').replace(/\\n/g, '\n').trim();
    body = body.replace(/^[ \t]*#{1,6}[ \t]*/gm, '');
    const paras = body.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
    while (paras.length && /^(dear\b|to whom it may concern)[^\n]{0,80}[,:!]?$/i.test(paras[0])) paras.shift();
    if (paras.length) {
        paras[0] = paras[0]
            .replace(/^(dear\b|to whom it may concern)[^\n]{0,80}[,:]\s*\n+/i, '')   // "Dear X,\nWith eight years…"
            .replace(/^dear\s+[^,\n]{1,60},\s+(?=[A-Z*])/, '')                       // "Dear X, With eight years…"
            .trim();
    }
    const name = String(candidateName || '').trim().toLowerCase();
    while (paras.length && (SIGN_OFF_RE.test(paras[paras.length - 1])
        || (name && paras[paras.length - 1].replace(/\*\*/g, '').trim().toLowerCase() === name))) paras.pop();
    if (paras.length) paras[paras.length - 1] = paras[paras.length - 1].replace(TRAILING_SIGN_OFF_RE, '').trim();
    body = paras.join('\n\n');
    // An odd number of ** would leave literal asterisks on the page: drop the last unmatched marker.
    if (((body.match(/\*\*/g) || []).length) % 2) {
        const i = body.lastIndexOf('**');
        body = body.slice(0, i) + body.slice(i + 2);
    }
    body = body.replace(/\*\*\s*\*\*/g, '');
    const words = body.split(/\s+/).filter(Boolean).length;
    if (words < 120) throw new Error(`AI_BAD_OUTPUT: ${words} words`);

    return {
        position: String(o.position || ''),
        to: String(o.to || ''),
        addresses: Array.isArray(o.addresses) ? o.addresses : [],
        body,
    };
}

/**
 * Placeholder tokens in a letter: [X%], [Insert metric], [Company Name], {your name}, bare XX% / X% / $X /
 * $XX,XXX, "N years".
 * ⚠️ NEVER STORED. A letter reading "increased revenue by [X%]" is worse than a generic one — it is
 * visibly unfinished, with our name on it.
 * ⚠️ BUT A BRACKET IS NOT A PLACEHOLDER FOR BEING A BRACKET. Whatever is found here is DELETED from the
 * letter once the corrective pass has had its go, so a rule that matches real text removes a real fact
 * from a letter the user paid for. The old rule called any bracket a slot when a %, $ or # or a lone X/N
 * or a slot word appeared ANYWHERE inside: "[top 5%]", "[CGPA 8.4 / 85%]", "[Class X]", "[C#]",
 * "[Team Lead]" and "[Name Service]" all went. A bracket's inside (see isLetterSlot) is now a slot only
 * when it is nothing but a slot. The resume doc lane's isPlaceholderInside answers the same question for
 * resumes — keep the two in step.
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

/** Remove placeholder tokens conservatively (plus a dangling "by " before one), then tidy the spacing. */
function stripLetterPlaceholders(text, tokens) {
    let s = String(text || '');
    // ⚠️ LONGEST FIRST: removing "X%" before "XX%" leaves a stray "X" in the letter.
    for (const t of [...(tokens || [])].sort((a, b) => b.length - a.length)) {
        const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        s = s.replace(new RegExp(`[ \\t]*\\bby[ \\t]+(\\*\\*)?${esc}(\\*\\*)?`, 'g'), '');
        s = s.replace(new RegExp(`(\\*\\*)?${esc}(\\*\\*)?`, 'g'), '');
    }
    return s
        .replace(/\*\*\s*\*\*/g, '')
        .replace(/\(\s*\)/g, '')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/[ \t]+([,.;:!?])/g, '$1')
        .replace(/([,;:])(\s*[,;:])+/g, '$1')
        .replace(/,\s*\./g, '.')
        .replace(/^[ \t]+|[ \t]+$/gm, '')
        .trim();
}

/** Remove placeholders until none are left (a strip can expose a nested token). */
function withoutPlaceholders(text) {
    let s = text;
    for (let i = 0; i < 3; i++) {
        const t = findLetterPlaceholders(s);
        if (!t.length) break;
        s = stripLetterPlaceholders(s, t);
    }
    return s;
}

/**
 * A role title fit for the subject line, or ''. Real parentheses survive ("Software Engineer (m/w/d)" is
 * how a German posting is titled); an "(open application)"-style artefact, a placeholder or a stray
 * bracket does not.
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

/** Comparable text: lower case, punctuation to spaces, whitespace collapsed. */
const plainOf = (v) => String(v || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const TECH_ROLE_RE = /\b(engineer|engineering|developer|software|devops|sre|data|machine learning|ml|ai|scientist|architect|programmer|technical|it|security|cloud|backend|frontend|full[- ]?stack|qa|firmware|embedded)\b/i;

const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── Thumbnails ───────────────────────────────────────────────────────────────────────────────────

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
 * Cards for a stored letter: [{ id, name, accent, image, fit, reason }] in the order of `ids`.
 *
 * ⚠️ THE THUMB MUST BE THE FILE THEY WOULD DOWNLOAD. Same data as generate-template-pdf: the payload's
 * html/company/address, the live sender block (buildCLSender), the employer's brand (its colour recolours
 * EVERY design's accent and its Google font sets the type — letterBrandOf, the same reading the downloads
 * use) and — for the branded design — the profile photo. So every one of those is in the cache key: the
 * doc version (id + updated_at, which a PUT edit moves), the sender block's hash (a renamed user must not
 * keep their old name on every card), a hash of the brand pair (a letter whose brand changed — a design
 * re-stored, a research row that learned its colour — must not keep the old tint), and for 'standard'
 * the photo version. Renders only what is missing, in ONE browser batch. Unrenderable ids are simply absent.
 */
async function letterCardsFor(userId, doc, ids, design) {
    const cl = clMod();
    const p = doc.payload || {};
    const tpls = [...new Set(ids)].map((id) => clTemplates.TEMPLATES.find((t) => t.id === id)).filter(Boolean);
    if (!tpls.length) return [];
    const sender = await cl.buildCLSender(userId);
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
    const dir = thumbDirOf(userId);
    const fileOf = (t) => path.join(dir, `cl_${sha(['cl', userId, doc.id, updatedMs, t.id, senderHash, brandHash,
        t.generic ? photoVer : '-'].join('|'))}.jpg`);

    const images = new Map();
    const missing = [];
    for (const t of tpls) {
        const file = fileOf(t);
        try {
            const buf = await fs.readFile(file);
            images.set(t.id, `data:image/jpeg;base64,${buf.toString('base64')}`);
            const now = new Date();
            fs.utimes(file, now, now).catch(() => {});   // LRU: a card still being shown stays cached
        } catch { missing.push(t); }
    }
    if (missing.length) {
        try {
            const photo = missing.some((t) => t.generic) ? await cl.loadCLPhotoDataUri(userId) : null;
            const data = { sender, company: { name: companyName, address: p.companyAddress || '' }, bodyHtml: p.coverLetterHtml };
            const rendered = await clRenderer.renderPreviews(data, { photo, brandColor: accent, brandFont }, missing);
            await fs.mkdir(dir, { recursive: true });
            for (const r of rendered || []) {
                const t = missing.find((m) => m.id === r.id);
                if (!t || !r.image) continue;
                const full = Buffer.from(String(r.image).split(',')[1] || '', 'base64');
                let thumb = full;
                try { thumb = await require('sharp')(full).resize({ width: THUMB_W }).jpeg({ quality: 80 }).toBuffer(); }
                catch { /* sharp unavailable → full size; heavier but correct */ }
                images.set(t.id, `data:image/jpeg;base64,${thumb.toString('base64')}`);
                // Written aside then renamed: a card request racing this render never reads half a JPEG.
                const file = fileOf(t);
                const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
                await fs.writeFile(tmp, thumb).then(() => fs.rename(tmp, file)).catch(() => fs.unlink(tmp).catch(() => {}));
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
 * `job` is what the letter is WRITTEN against (the fingerprint, the prompt, the research host);
 * `docJobUrl` is the stored letter's IDENTITY — see where it is read below.
 *
 * Order (each step is load-bearing): no résumé → fingerprint → CACHE (free, returns before any gate) →
 * gates → coveredOnly refusal (before research, which is paid work) → research → AI letter →
 * placeholder guard → design ranking → CHARGE + STORE under the usage lock → thumbs.
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
        aiTextMod();

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

        // ── RESEARCH (optional grounding — never a dependency, never throws) ───────────────────────
        // It carries `conventions` (how THIS employer hires, what its country / sector expects of a letter):
        // one grounded call inside the same cached row. `country` is only a hint for that call — the chip's
        // country is the role's location more often than the employer's HQ.
        const site = researchSiteFor(company, job);
        let facts = null;
        if (site) {
            await report('researching', `Researching ${company}`, 16);
            facts = await research.getEmployerResearch({ website: site, name: company, country: country || null }).catch(() => null);
        }
        const conventions = conventionsOf(facts);
        const region = letterRegionFor(research, designFit, conventions, { country, website: site });
        // How a letter READS where this application is going — resolved ONCE, from the same three inputs the
        // region above is resolved from, and handed to the style and the block together (see letterPlaybookFor).
        // Deterministic and local: no AI call, no read, nothing billable, and nothing in the fingerprint.
        const playbook = letterPlaybookFor({ country, website: site, conventions, research: facts });

        const [tailored, sender] = await Promise.all([
            tailoredResumeFor(userId, { company, employerId, job, docJobUrl }, req),
            cl.buildCLSender(userId).catch(() => ({ name: '' })),
        ]);

        // ── THE LETTER ──────────────────────────────────────────────────────────────────────────────
        const writingLabel = `Writing your ${company} cover letter`;
        await report('writing', writingLabel, 40);
        const promptArgs = {
            company, website: site, job, material, tailored,
            researchBlock: research.researchPromptBlock(facts, company, { forLetter: true }),
            conventionsBlock: conventionsBlockFor(research, conventions, company),
            playbookBlock: letterPlaybookBlockFor(playbook, company),
            style: letterStyleFor(conventions, region, playbook),
            sector: (conventions && typeof conventions.sector === 'string' && conventions.sector)
                || (facts && typeof facts.industry === 'string' && facts.industry) || '',
        };
        const prompt = buildEmployerLetterPrompt(promptArgs);
        // ⚠️ TWO DIFFERENT RETRIES, ON PURPOSE (2026-09-18). A busy, hung or vanished MODEL is aiText's business:
        // it pauses, retries the primary once and walks the fallbacks inside ONE budget, and what it finally throws
        // ends this build (AI_BUSY / AI_DOWN in the catch) — this loop never runs a second chain after a first one
        // gave up. What stays here is the lane's own question, "is this a letter?": an answer that is not JSON, or
        // too short, earns one more draft — while the window still has room for one.
        let out = null;
        let outModel = LETTER_MODEL;   // the model that wrote `out` — what the stored letter records
        let lastErr = null;
        for (let attempt = 1; attempt <= 2 && !out; attempt++) {
            if (attempt > 1) {
                if (aiDeadline - Date.now() < LETTER_AI.minCallMs) {
                    console.warn(`[employerLetter] no time left for a second draft of the "${company}" letter — giving up on it`);
                    break;
                }
                await report('retry', 'Taking another pass at it', 46);
            }
            const written = await writeLetterText(prompt, { deadline: aiDeadline, budgetMs: LETTER_AI.draftBudgetMs, report, pct: 46 });
            try {
                out = parseLetterOutput(written.text, { candidateName: sender.name });
                outModel = written.model;
            } catch (e) {
                lastErr = e;
                console.warn(`[employerLetter] letter attempt ${attempt}/2 for "${company}" failed (${written.model}): ${e.message}`);
            }
        }
        if (!out) throw lastErr || new Error('AI_BAD_OUTPUT');

        // ── PLACEHOLDER GUARD — one corrective pass, then remove what is left ───────────────────────
        // ⚠️ THE FIRST DRAFT IS ALREADY A LETTER. The corrective pass only improves it, so NOTHING it meets may cost
        // the user that letter: a busy provider, a dead key, bad output, or no time left in the window all keep the
        // first draft (with its placeholders stripped). It runs through aiText like every draft, on a smaller budget.
        let tokens = findLetterPlaceholders(out.body);
        if (tokens.length) {
            console.warn(`[employerLetter] placeholders in the "${company}" letter (${tokens.join(', ')}) — one corrective pass`);
            await report('polishing', 'Polishing the wording', 70);
            const timeLeft = aiDeadline - Date.now();
            if (timeLeft < LETTER_AI.minCallMs) {
                console.warn(`[employerLetter] no time left for the corrective pass (${timeLeft}ms), keeping the first draft`);
            } else {
                try {
                    const fixed = await writeLetterText(buildEmployerLetterPrompt({ ...promptArgs, correction: tokens }),
                        { deadline: aiDeadline, budgetMs: LETTER_AI.correctionBudgetMs, report, pct: 72 });
                    const again = parseLetterOutput(fixed.text, { candidateName: sender.name });
                    const left = findLetterPlaceholders(again.body);
                    if (left.length <= tokens.length) { out = again; outModel = fixed.model; tokens = left; }
                } catch (e) { console.warn('[employerLetter] corrective pass failed, keeping the first draft:', e.message); }
            }
            if (tokens.length) out.body = withoutPlaceholders(out.body);
        }
        if (out.body.split(/\s+/).filter(Boolean).length < 80) throw new Error('AI_BAD_OUTPUT: too short after the placeholder guard');

        // ── THE DOCUMENT — assembled completely BEFORE the charge, so nothing after it can throw ──────
        // The posting's own title when there is one; otherwise the model's reading of the candidate's
        // current title, then the résumé's own words for it.
        const narrativeTitle = (material.baseText.match(/^Current title:\s*(.+)$/m) || [])[1];
        const uploadTitle = material.meta && Array.isArray(material.meta.job_titles) ? material.meta.job_titles[0] : '';
        const position = cleanPosition(job.title) || cleanPosition(out.position)
            || cleanPosition(tailored && tailored.personal_info && tailored.personal_info.title)
            || cleanPosition(narrativeTitle) || cleanPosition(uploadTitle);
        const name = String(sender.name || '').trim();
        // Built here, not by the model: a subject line gains nothing from creativity and is exactly where
        // "(open application)" and "[Your Name]" artefacts used to surface.
        const subject = position
            ? (name ? `Application for ${position} — ${name}` : `Application for ${position}`)
            : (name ? `Application — ${name}` : 'Job application');
        // A named contact or an address survives only when the posting (or research) actually says it.
        // ⚠️ Not the conventions: their notes describe the COUNTRY's hiring habits, and an address or a name
        // matched there would be one this employer never published.
        const { conventions: _conventions, ...employerFacts } = facts || {};
        const evidence = plainOf([job.description, JSON.stringify(employerFacts)].join(' '));
        const to = String(out.to || '').replace(/\s+/g, ' ').trim();
        const hiringManager = to && to.length <= 80 && !/hiring|recruit|talent|manager|team|human resources|\bhr\b/i.test(to)
            && plainOf(to) && evidence.includes(plainOf(to)) ? to : 'Hiring Manager';
        const addresses = out.addresses
            .map((a) => String(a || '').replace(/\s+/g, ' ').trim())
            .filter((a) => a && a.length <= 200 && plainOf(a).length >= 8 && evidence.includes(plainOf(a)))
            .slice(0, 5);
        // The employer's brand — the website's own colour and font (brandExtract) over the researcher's guess
        // (coverLetterController.researchBrandOf, contract 2's precedence). Stored on the design so every render
        // of this letter draws it; the payload's brandColor / fontName keep their keys and carry the same
        // effective values, for the generic (PDFKit) design and for a reader from before design.brand.
        const brand = brandOfResearch(cl, facts);
        const brandColor = (brand && brand.accent) || hexOrNull(facts && facts.brandColor);
        const payload = {
            coverLetterHtml: cl.formatCoverLetterWithHTML(escHtml(out.body), {}),
            subject,
            companyName: company,
            companyAddress: addresses[0] || '',
            hiringManager,
            position,
            locations: addresses.map((address, i) => ({ address, city: '', country: '', isHeadquarters: i === 0 })),
            brandColor,
            fontName: (brand && brand.font && brand.font.family) || (facts && facts.fontName) || null,
        };

        await report('designing', 'Ranking letter designs', 86);
        let design = null;
        try {
            const builder = tailored || await builderResumeFor(userId);
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
            console.warn(`[employerLetter] "${company}" letter for user ${userId} ended as ${ending.body.reason} after ${(e.attempts || []).length} AI attempts (${(e.attempts || []).map((a) => `${a.model} ${a.kind}`).join(', ') || 'none'}) — nothing charged, nothing stored`);
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
 * GET /api/cover-letter/employer-cards?doc=<id>&ids=a,b,c
 *   200 { success:true, cards: [{ id, name, accent, image, fit, reason }] }   404 { success:false, reason:'doc_gone' }
 * ≤ 3 ids per request (asked ∩ catalogue; none asked → the top 3 of the letter's design). No padding:
 * an id the client asked for that could not be rendered is simply absent. Free — a preview of a letter
 * the user already owns; never generates, never charges.
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
        const cards = await letterCardsFor(userId, doc, ids, design);
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
    buildEmployerLetterPrompt, parseLetterOutput, findLetterPlaceholders, stripLetterPlaceholders, cleanPosition,
    passWouldCoverLetter, letterFingerprintOf, jobFieldsOf, uploadContextOf, letterStyleFor, usageAndPassFor,
    letterPlaybookFor, letterPlaybookBlockFor, countryLetterRowOf, LETTER_PROFILES,
    LETTER_AI, LETTER_MODEL,
};
