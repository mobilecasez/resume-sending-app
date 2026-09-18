// Resume Builder — new feature. Safe to delete without affecting existing app.
'use strict';

const dbConfig     = require('../../db-config');
const axios        = require('axios');
const cheerio      = require('cheerio');
const path         = require('path');
const fs           = require('fs').promises;
const crypto       = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { renderPdf, renderPreviews, warmPreviews } = require('../utils/resumeRenderer');
const { TEMPLATES, TEMPLATE_IDS, FAMILIES, REGIONS, templatesForRegion, brandedTemplate } = require('../utils/resumeTemplates');
const { getEventCost } = require('../services/eventCosts');
const entitlements = require('../services/entitlements');
const downloads = require('../services/downloads');
const history = require('../services/downloadHistory');
const jobService = require('../services/jobService');
const employerDocs = require('../services/employerDocs');
// ⚠️ Called as aiText.generateText on every use (never destructured), so a suite can wrap it and see what a build asked for.
const aiText       = require('../services/aiText');

/**
 * Tell the client where a long generation has actually got to.
 *
 * ⚠️ THE STAGE NAME IS THE TRUTH; THE PERCENTAGE IS A COURTESY. Around 85-95% of a run's wall-clock
 * is one non-streaming Gemini call that reports nothing, so a bar driven only by real server ticks
 * would sit still for a minute and read as hung. The honest split is: the SERVER says which stage
 * it is in and what that stage's ceiling is, and the client is free to creep toward that ceiling —
 * so the bar always moves, and it never claims a stage that has not started.
 *
 * ⚠️ RIDES ON updateJobPartialResult, NOT A NEW COLUMN. async_jobs has no place for a label
 * (db-init.js:301-315) and updateJobProgress takes a number only. `result` is already surfaced as
 * `data` by both pollers while status is still 'processing', and completeJob overwrites it wholesale
 * with the real payload — so the envelope is self-cleaning. The client tells them apart by looking
 * for `resumeData`; anything with a `stage` is a progress tick.
 *
 * Every write also bumps updated_at, which is what keeps requeueStuckJobs (it fails any 'processing'
 * row untouched for five minutes) from killing a run that is merely slow.
 *
 * A no-op in synchronous mode, where there is no job to report against.
 *
 * `report.at()` is where the bar stands — the one thing a tick that only RE-LABELS the stage it happens in (an
 * AI provider retry, resumeAiRetryNotice) needs, so it can report there and never behind it.
 */
function makeReporter(req) {
    const jobId = req && req.__jobId;
    let last = 0;
    const report = !jobId ? async () => {} : async (stage, label, pct) => {
        if (pct < last) return;                       // a bar must never walk backwards
        last = pct;
        try {
            await jobService.updateJobProgress(jobId, Math.round(pct));
            await jobService.updateJobPartialResult(jobId, { stage, label, pct: Math.round(pct) });
        } catch { /* progress is never worth failing the work for */ }
    };
    report.at = () => last;
    return report;
}

/** The design's human name, for the history card. Falls back to the id so a card is never blank. */
const templateNameOf = (id) => {
    const t = TEMPLATES.find((x) => x.id === id);
    return (t && t.name) || String(id || '');
};

// Fallback defaults; the live per-request cost is resolved via getEventCost() (admin-editable).
const RESUME_CREDIT_COST   = 2; // credits charged per AI generation / regeneration
const DOWNLOAD_CREDIT_COST = 2; // credits charged per resume PDF download

// ── Shared credit helpers (mirrors coverLetterController) ───────────────────
async function checkUserCredits(userId, creditsRequired) {
    try {
        const credits = await dbConfig.get('SELECT credits_remaining FROM user_credits WHERE user_id = $1', [userId]);
        if (!credits) return { hasCredits: false, remaining: 0, message: 'No credit account found. Please purchase credits.' };
        const remaining = credits.credits_remaining || 0;
        if (remaining < creditsRequired) return { hasCredits: false, remaining, message: `Insufficient credits. You have ${remaining} credit(s) but need ${creditsRequired}.` };
        return { hasCredits: true, remaining };
    } catch (e) { throw e; }
}

async function deductCredits(userId, amount, actionType, metadata) {
    await dbConfig.run(
        `UPDATE user_credits SET credits_remaining = credits_remaining - $1 WHERE user_id = $2`,
        [amount, userId]
    );
    await dbConfig.run(
        `INSERT INTO credit_transactions (user_id, credits_used, action_type, metadata, created_at)
         VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`,
        [userId, amount, actionType, JSON.stringify(metadata || {})]
    );
}

// ── DB init ──────────────────────────────────────────────────────────────────
async function ensureResumeTable() {
    await dbConfig.run(`
        CREATE TABLE IF NOT EXISTS user_resumes (
            id         SERIAL PRIMARY KEY,
            user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            resume_data JSONB   NOT NULL DEFAULT '{}',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (user_id)
        )
    `);
    // Free-plan rule: one regeneration per built resume. Counted here, reset on a fresh build.
    await dbConfig.run(`ALTER TABLE user_resumes ADD COLUMN IF NOT EXISTS regen_count INTEGER NOT NULL DEFAULT 0`).catch(() => {});
    // The design the user picked in the gallery — every downstream file (Auto Fill attach, email
    // attachment, home thumbnail) renders THIS template, so what gets sent is what they chose.
    await dbConfig.run(`ALTER TABLE user_resumes ADD COLUMN IF NOT EXISTS preferred_template TEXT`).catch(() => {});
    // The employer key (downloads.employerKeyOf) this row was tailored for, or NULL when the row IS
    // the user's base resume. ⚠️ It is what tells source-text?base=1 that the row in front of it is
    // one company's version and the real base is the snapshot — see snapshotBaseBeforeTailoring.
    await dbConfig.run(`ALTER TABLE user_resumes ADD COLUMN IF NOT EXISTS tailored_for TEXT`).catch(() => {});
}

/**
 * Keep the user's BASE resume safe before a tailored build overwrites the only row they have.
 *
 * ⚠️ user_resumes is UNIQUE(user_id). Without this, tailoring for employer A destroys the base, the
 * next build for employer B is written from A's version, and every company inherits the last one's
 * emphasis. So: if the row about to be overwritten is still the base (tailored_for IS NULL), it is
 * copied into employerDocs under the '(none)' scope with a fixed marker fingerprint first.
 *
 * If the row is already tailored the base was saved earlier; it is re-put unchanged, which only bumps
 * its updated_at. That bump used to be what kept the base alive, when prune kept the newest 40 rows and
 * a base written once aged out behind forty companies. employerDocs.prune now keeps KEEP_PER_KIND (120)
 * and never counts or deletes the '(none)' scope at all, so the re-put is no longer load-bearing — it
 * is harmless, and nothing may start relying on it again.
 *
 * Call it immediately before the overwrite, not at the start of the build: a /save the user makes
 * during the minute the AI runs is part of their base, and an early snapshot would miss it.
 * Never throws — a lost snapshot degrades source-text?base=1 to the upload, it must not fail a build.
 */
async function snapshotBaseBeforeTailoring(userId, env) {
    try {
        const { BASE_SNAPSHOT_FP } = require('../services/resumeScorer');
        const cur = await dbConfig.get('SELECT resume_data, tailored_for FROM user_resumes WHERE user_id = $1', [userId]);
        if (!cur || !cur.resume_data) return;
        let payload = cur.resume_data;
        if (cur.tailored_for) {
            const prev = await employerDocs.get(userId, 'resume', downloads.NONE, BASE_SNAPSHOT_FP, env);
            if (!prev || !prev.payload || !Object.keys(prev.payload).length) return;   // nothing to keep alive
            payload = prev.payload;
        } else if (typeof payload === 'string') {
            try { payload = JSON.parse(payload); } catch { return; }
        }
        if (!payload || typeof payload !== 'object' || !Object.keys(payload).length) return;
        await employerDocs.put({
            userId, kind: 'resume', employer: downloads.NONE, jobUrl: '', jobTitle: '',
            fingerprint: BASE_SNAPSHOT_FP, model: 'base-snapshot', payload, env,
        });
    } catch (e) { console.warn('[resumeBuilder] base snapshot failed:', e.message); }
}

/**
 * Overwrite the stored base snapshot with `payload` (a user's save that is now their base — see
 * saveResume). Never throws: the row it follows already carries tailored_for NULL, which makes the row
 * itself the base, so a lost snapshot write cannot resurrect the old base.
 */
async function refreshBaseSnapshot(userId, payload, env) {
    try {
        const { BASE_SNAPSHOT_FP } = require('../services/resumeScorer');
        let p = payload;
        if (typeof p === 'string') { try { p = JSON.parse(p); } catch { return; } }
        if (!p || typeof p !== 'object' || !Object.keys(p).length) return;
        await employerDocs.put({
            userId, kind: 'resume', employer: downloads.NONE, jobUrl: '', jobTitle: '',
            fingerprint: BASE_SNAPSHOT_FP, model: 'base-snapshot', payload: p, env,
        });
    } catch (e) { console.warn('[resumeBuilder] base snapshot refresh failed:', e.message); }
}

/**
 * The generation upsert: the resume, and which employer (key) it was tailored for — NULL = the base.
 *
 * ⚠️ BY THE TIME THIS RUNS THE USER HAS ALREADY BEEN CHARGED. ensureResumeTable swallows a failed
 * ALTER, so if tailored_for could not be added this INSERT would throw and turn a paid-for resume into
 * "we could not finish generating" with nothing saved. The old column list is the fallback: the resume
 * is kept, only the tailoring marker is lost (source-text?base=1 then serves this row, as it always did).
 */
async function saveResumeRow(userId, resumeData, tailoredFor) {
    const json = JSON.stringify(resumeData);
    try {
        await dbConfig.run(
            `INSERT INTO user_resumes (user_id, resume_data, tailored_for, updated_at)
             VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
             ON CONFLICT (user_id) DO UPDATE
             SET resume_data  = EXCLUDED.resume_data,
                 tailored_for = EXCLUDED.tailored_for,
                 updated_at   = CURRENT_TIMESTAMP`,
            [userId, json, tailoredFor]
        );
    } catch (e) {
        console.warn('[resumeBuilder] tailored_for save failed, saving without it:', e.message);
        await dbConfig.run(
            `INSERT INTO user_resumes (user_id, resume_data, updated_at)
             VALUES ($1, $2, CURRENT_TIMESTAMP)
             ON CONFLICT (user_id) DO UPDATE
             SET resume_data = EXCLUDED.resume_data,
                 updated_at  = CURRENT_TIMESTAMP`,
            [userId, json]
        );
    }
}

// Bump when the employer block's instructions change shape — folded into the cache fingerprint so a
// resume written to the old instructions is not served as if it answered the new ones. 'none' says no
// web research feeds the BUILDER lane's prompt. ⚠️ The employer-doc lane (Home) is researched and has
// its own prompt, so it folds employerResearch.RESEARCH_REV in instead — see docResearchRev. The two
// lanes therefore never share a fingerprint, and a builder-lane document is never a doc-lane free hit.
const RESEARCH_REV = 'none';
// The résumé lanes' FIRST choice. Since 2026-09-18 it is not always the model that writes the document: aiText falls back
// when it is busy, and the stored row names whoever actually answered (callGemini's `model`). ⚠️ Never hashed — see
// generationFingerprint: a document a fallback wrote is the same free cache hit as one this model wrote.
const RESUME_MODEL = 'gemini-2.5-flash';

/**
 * resume_metadata columns that describe the PARSE, not the résumé.
 * ⚠️ THESE MUST NEVER REACH THE FINGERPRINT. parsed_at and parse_error used to be hashed, so re-parsing
 * an unchanged upload (a retry, a re-queue, a parser deploy) moved the fingerprint and the next build
 * for an employer the user already paid for missed the cache and charged again. The same list as
 * resumeScorer.uploadContentFor, plus two narrow patterns so a future `last_parsed_at` / `parse_attempts`
 * column cannot quietly re-open it. The model never needed any of them either, so the prompt drops them too.
 * ⚠️ Deliberately NOT a broad `_status` / `_error` rule: a column like `visa_status` is a résumé FACT, and
 * stripping it would silently take it out of the prompt.
 */
const UPLOAD_BOOKKEEPING = new Set(['id', 'user_id', 'parse_status', 'parse_error', 'parsed_at', 'created_at', 'updated_at']);
const isUploadBookkeeping = (k) => UPLOAD_BOOKKEEPING.has(k) || /_at$/.test(k) || /^pars(e|ed|ing)_/.test(k);

/**
 * The parsed uploaded resume as the prompt sees it, or '' — ONE definition for the prompt and the cache fingerprint.
 * `quiet` only silences the two info lines, for currentResumeFingerprint: /api/employer-docs/current asks
 * on every chip switch, and a log line per switch buries the ones that matter. The content is identical.
 */
async function uploadedResumeContextFor(userId, { quiet = false } = {}) {
    try {
        const meta = await dbConfig.get('SELECT * FROM resume_metadata WHERE user_id = ? AND parse_status = ?', [userId, 'done']);
        if (meta) {
            const rest = {};
            for (const [k, v] of Object.entries(meta)) if (!isUploadBookkeeping(k)) rest[k] = v;
            if (!quiet) console.log(`[resumeBuilder] including uploaded resume content for user ${userId}`);
            return JSON.stringify(rest, null, 2);
        }
        if (!quiet) console.log(`[resumeBuilder] includeUploadedResume set but no parsed resume found for user ${userId}`);
    } catch (e) { console.warn('[resumeBuilder] uploaded resume merge failed:', e.message); }
    return '';
}

/**
 * The per-employer cache fingerprint of a build — ONE function, called by generateAI AND the gate.
 *
 * ⚠️ IF THESE TWO EVER COMPUTE DIFFERENT FINGERPRINTS, THE GATE LIES ABOUT MONEY: it would send a user
 * with no quota to Plans (or ask them for credits) for a build that is a free cache hit, or promise a
 * free hit that then charges. So every input lives here and nowhere else:
 *   base text  — `rawText` when the caller has it (the build: it is literally what the prompt reads, so
 *                a stored document is labelled with the text it was written from), otherwise the
 *                server-side BASE narrative (the gate). Home sends source-text?base=1 verbatim as
 *                rawText, and fingerprint() collapses whitespace, so for Home's build the two are the
 *                same string. A user who hand-edits the text box gets a fingerprint the gate cannot
 *                foresee — the gate then under-promises (a miss), never over-promises.
 *   upload     — uploadedResumeContextFor (bookkeeping columns stripped — see UPLOAD_BOOKKEEPING).
 *   job fields — title, description, url, website, as sent.
 *   research   — RESEARCH_REV for the builder lane; docResearchRev() for the employer-doc lane, passed
 *                in by every doc-lane caller (generateEmployerDoc, the gate with saveTo, and
 *                currentResumeFingerprint) — never by one of them alone.
 * Returns null when the base text cannot be read (a strict read failed) — a caller must then skip the
 * cache, never hash a guess.
 */
async function generationFingerprint(userId, { rawText, includeUploadedResume, job, env, readUploaded, researchRev = RESEARCH_REV }) {
    let baseText = rawText;
    if (baseText == null) {
        try {
            const scorer = require('../services/resumeScorer');
            const n = await scorer.narrativeFor(userId, { base: true, env, strict: true });
            if (!n || !n.text) return null;
            baseText = n.text;
        } catch (e) {
            console.warn('[resumeBuilder] fingerprint base read failed:', e.message);
            return null;
        }
    }
    const uploaded = readUploaded ? await readUploaded()
        : (includeUploadedResume ? await uploadedResumeContextFor(userId) : '');
    const j = job || {};
    return employerDocs.fingerprint({
        baseText: [baseText, uploaded].join('\n'),
        jobText: [j.title, j.description, j.url, j.website].map((v) => String(v || '')).join('\n'),
        researchRev,
    });
}

/**
 * The research revision the EMPLOYER-DOC lane folds into its fingerprint.
 *
 * ⚠️ ONE READ FOR THE BUILD, THE GATE AND /api/employer-docs/current. Any two of them disagreeing is
 * the gate lying about money (see generationFingerprint) or every document reading "stale" for ever.
 * The 'r1' fallback exists only for a server where employerResearch.js failed to load: the build then
 * runs without research, and all three still agree because all three come through here.
 */
function docResearchRev() {
    try {
        const rev = require('../services/employerResearch').RESEARCH_REV;
        if (typeof rev === 'string' && rev) return rev;
    } catch (e) { console.warn('[resumeBuilder] employerResearch unavailable for the fingerprint:', e.message); }
    return 'r1';
}

/**
 * The fingerprint an employer document built RIGHT NOW would carry — what /api/employer-docs/current
 * compares a stored document's input_fingerprint against to label it stale, and what the gate asks the
 * cache with when the build is Home's (saveTo 'employer_doc').
 *
 * ⚠️ IT EQUALS generateEmployerDoc's FINGERPRINT FOR HOME'S BUILD BY CONSTRUCTION, not by coincidence:
 * the same generationFingerprint, the upload always included (the doc lane forces it), the server-side
 * BASE narrative (which Home sends verbatim as rawText — source-text?base=1), the same four job fields
 * mapped the same way (String(v || '')), and docResearchRev(). The company is NOT an input: it is the
 * employer_key half of the cache key, beside the fingerprint, exactly as in the build.
 * ⚠️ `job` IS THE BUILD'S INPUT, NOT THE DOCUMENT'S IDENTITY. The two parted company when the build
 * gained docJobUrl: an employer chip's document is stored under job_url '' while it may have been
 * written from a posting link pasted on the Add sheet (job.url). Re-hashing such a row from its job_url
 * would drop that link and call a fresh document stale for ever, so /api/employer-docs/current feeds
 * this the row's stored job_input (Migration 046) — the exact object the build hashed — and only a
 * pre-046 row falls back to the client's fields.
 * `env` may be a request or an environment string. Returns null when the base résumé cannot be read —
 * the caller must then answer "not stale" / "cannot tell", never guess.
 */
async function currentResumeFingerprint(userId, { job, env } = {}) {
    const j = job && typeof job === 'object' ? job : {};
    return generationFingerprint(userId, {
        includeUploadedResume: true,
        readUploaded: () => uploadedResumeContextFor(userId, { quiet: true }),
        job: { title: j.title, url: j.url, description: j.description, website: j.website },
        env,
        researchRev: docResearchRev(),
    });
}

/**
 * Stable deep equality for two resume payloads.
 * ⚠️ NOT JSON.stringify(a) === JSON.stringify(b): resume_data is JSONB, and Postgres hands its keys back
 * in its own order, so the SAME resume re-saved would compare as an edit.
 */
function sameResumePayload(a, b) {
    const parse = (v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };
    const canon = (v) => {
        if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
        if (v && typeof v === 'object') {
            return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
        }
        return JSON.stringify(v === undefined ? null : v);
    };
    return canon(parse(a)) === canon(parse(b));
}

/**
 * THE LEGACY CREDIT-LANE INFERENCE — did consumeOnSuccess ACTUALLY deduct credits? Read it as history:
 * ⚠️ NO LANE DECIDES ON THIS ANY MORE. consumeOnSuccess returns its own chargeCredits result (`charge`),
 * and all three lanes (builder, employer-doc, letter) decide on that. This is the FALLBACK for an
 * entitlements build that predates `charge` — the one case where the marks really are all there is.
 *
 * ⚠️ { via: 'credits' } IS NOT PROOF OF PAYMENT. consumeOnSuccess calls eventCosts.chargeCredits, which
 * on a short balance returns { charged:false, insufficient:true } WITHOUT throwing, writes the ledger row
 * anyway and reports 'credits'. canConsumeMany does not reserve, so two overlapping builds both pass the
 * gate on one build's worth of credits: the second is "charged" nothing, and if it then wrote the cache
 * that document would be a PERMANENT FREE HIT. This reads what the charge leaves behind: chargeCredits
 * writes a credit_usage_history row ONLY after a real deduction, consumeOnSuccess writes a usage_ledger
 * row every time. Marked just before the call, "every credits ledger row since has a paid history row" is
 * the answer. It is CONSERVATIVE: two builds consuming in the same instant with one charge between them
 * both read unpaid, and a lost history insert reads unpaid. It can only under-report a payment, never
 * invent one — a balance before/after diff could, since an overlapping build's deduction would look like
 * ours, which is exactly the GE1 race.
 * ⚠️ AND WHY IT STOPPED BEING THE ANSWER: a window read cannot tell OUR deduction from an overlapping
 * build's. The employer-doc lane can deliver only by storing, so a false "unpaid" there threw away a
 * document the user HAD paid for, unrefunded; in the builder lane it skipped the cache write, so the
 * user paid then, and paid AGAIN for the identical build later. Under-reporting is never free.
 */
async function creditMarksFor(userId) {
    try {
        const h = await dbConfig.get('SELECT COALESCE(MAX(id), 0) AS id FROM credit_usage_history WHERE user_id = $1', [userId]);
        const l = await dbConfig.get('SELECT COALESCE(MAX(id), 0) AS id FROM usage_ledger WHERE user_id = $1', [userId]);
        return { h: Number(h && h.id) || 0, l: Number(l && l.id) || 0 };
    } catch (e) { console.warn('[resumeBuilder] credit marks unreadable:', e.message); return null; }
}
async function creditsDeductedSince(userId, marks) {
    if (!marks) return { paid: false, cost: 0 };
    try {
        const h = await dbConfig.get(
            `SELECT COUNT(*)::int AS n, COALESCE(MAX(credits_used), 0)::int AS cost FROM credit_usage_history
              WHERE user_id = $1 AND id > $2 AND action_type = 'resume_ai_generate' AND credits_used > 0`, [userId, marks.h]);
        const l = await dbConfig.get(
            `SELECT COUNT(*)::int AS n FROM usage_ledger
              WHERE user_id = $1 AND id > $2 AND kind = 'resume' AND source = 'credits'`, [userId, marks.l]);
        const paidRows = Number(h && h.n) || 0, owedRows = Number(l && l.n) || 0;
        return { paid: owedRows >= 1 && paidRows >= owedRows, cost: Number(h && h.cost) || 0 };
    } catch (e) { console.warn('[resumeBuilder] credit verification unreadable:', e.message); return { paid: false, cost: 0 }; }
}

// ── URL extraction from free-form text ───────────────────────────────────────
function extractUrls(text) {
    const pattern = /https?:\/\/[^\s"'<>()]+|(?:www\.|github\.com|linkedin\.com)[^\s"'<>()]+/gi;
    const raw = text.match(pattern) || [];
    return [...new Set(raw.map(u => u.startsWith('http') ? u : `https://${u}`))].slice(0, 5);
}

// ── Light page scrape: title + meta description + og:description ─────────────
async function scrapePage(url) {
    try {
        const { data } = await axios.get(url, {
            timeout: 6000,
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CVApplyr/1.0)' },
            maxContentLength: 500_000,
        });
        const $ = cheerio.load(data);
        const title       = $('title').first().text().trim().substring(0, 200);
        const metaDesc    = $('meta[name="description"]').attr('content') || '';
        const ogDesc      = $('meta[property="og:description"]').attr('content') || '';
        const ogTitle     = $('meta[property="og:title"]').attr('content') || '';
        $('script, style, nav, footer, header').remove();
        const bodyText    = $('body').text().replace(/\s+/g, ' ').trim().substring(0, 600);
        return {
            url,
            title:       ogTitle || title,
            description: ogDesc  || metaDesc || bodyText,
        };
    } catch {
        return { url, title: '', description: '' };
    }
}

// ── The Gemini call: one per answer, through aiText (a busy model is waited for, then fallen back from) ────────
//
// ⚠️ 2026-09-18 — WHY THIS NO LONGER CALLS THE SDK ITSELF. Amazon's cover letter failed on a 503 "This model is
// currently experiencing high demand": the letter lane asked the same model twice, back to back, and lost both times.
// Both résumé lanes had the same shape, one worse — three tries on gemini-2.5-flash with no pause, and a 90 s race
// that only stopped WAITING (the request ran on, the timer was never cleared), after which AI_TIMEOUT failed the
// build outright. aiText.generateText is the house's one answer to a busy provider: it waits ~2 s and asks the
// primary once more, then walks the verified fallbacks (gemini-2.5-flash-lite, gemini-3.1-flash-lite), skips a model
// that is gone, fails fast on quota / a bad key (and pages the operator), and caps every attempt with a REAL abort.
// It throws aiText.AiUnavailableError when no model could answer — see resumeAiUnavailableAnswer for what the lanes
// say then. A MAX_TOKENS finish is its TRUNCATED_OUTPUT, retried there, so no caller reads finishReason any more.

/**
 * ONE CLOCK FOR A RÉSUMÉ BUILD'S AI. The app polls a build for six minutes (DEADLINE_MS in homeAddEmployer.ts and
 * profileSetupService.ts). Before its first AI call a build spends up to ~30 s (research is capped at 25 s, a posting
 * or link read at 6 s); after its last, up to ~40 s (the usage lock waits ≤ 15 s, the pre-render ≤ 20 s). So EVERY AI
 * call of one build — the draft, the lane's own output retries, the corrective pass, and every provider retry and
 * fallback inside them — must be over by the build's start + this, and generateText never starts an attempt that
 * could not finish inside what is left. Per-attempt caps must never simply add up: this is the budget they share.
 */
const RESUME_AI_DEADLINE_MS = 4.5 * 60 * 1000;
/**
 * Per-attempt caps, by attempt number within one generateText call. The PRIMARY's two tries keep the 90 s callGemini
 * always had (a full résumé takes about a minute on a good day — a shorter cap would abort answers that were on their
 * way); every later attempt is a fallback (flash-lite wrote a whole letter in 2–9 s) and gets 45 s. Worst case, every
 * model hanging: 90 + ~3 + 90 + 45 + the rest of the budget — which the deadline above, not the caps, bounds.
 */
const RESUME_AI_CAPS_MS = Object.freeze([90 * 1000, 90 * 1000, 45 * 1000]);

/**
 * THE BUILD EVERY callGemini BELONGS TO: its lane (for the logs), its progress reporter and its AI deadline.
 * ⚠️ A CONTEXT, NOT A MODULE VARIABLE: Home runs several builds at once in this process, and a variable would hand one
 * build's deadline and progress bar to another. AsyncLocalStorage follows each build's own async chain. It is also why
 * callGemini keeps the one signature every caller (and the temperature pins in test-employer-docs) knows: what differs
 * per BUILD rides here, what differs per CALL (the temperature) stays an argument. A call outside any build gets a
 * fresh RESUME_AI_DEADLINE_MS and reports nothing.
 */
const resumeAiBuild = new AsyncLocalStorage();

/** Run `fn` as one build's AI work: its lane, its `report`, and a deadline RESUME_AI_DEADLINE_MS after `startedAt`. */
function withResumeAi({ lane, report, startedAt }, fn) {
    return resumeAiBuild.run({ lane, report, deadline: startedAt + RESUME_AI_DEADLINE_MS }, fn);
}

/** Did the AI PROVIDER end this (aiText gave up), as opposed to an answer the lane rejected? By name, as aiText.isAiBusy reads it. */
const isAiUnavailable = (e) => !!e && (e instanceof aiText.AiUnavailableError || e.name === 'AiUnavailableError');

/**
 * What a provider retry is shown as — aiText's onRetry, told through this build's own reporter, in plain words:
 *   the primary was busy and is asked again after a pause → "Google's AI is busy — trying again"
 *   the next model in the chain                            → "Switching to a faster model"
 *   a cut-off answer asked for again (TRUNCATED_OUTPUT)    → "Taking another pass at it" (the lanes' own words for it)
 * ⚠️ AT THE BAR'S CURRENT POSITION, NUDGED: a retry re-labels the stage it happens in, it is not a stage of its own. A pct
 * behind the last tick is dropped (a bar never walks backwards), and one past 84 would claim the designing (86) or
 * shaping (88) stage before it began.
 */
function resumeAiRetryNotice(report) {
    return ({ model, nextModel, kind }) => {
        const label = nextModel && nextModel !== model ? 'Switching to a faster model'
            : kind === 'transient' ? 'Google\'s AI is busy — trying again' : 'Taking another pass at it';
        const at = typeof report.at === 'function' ? report.at() : 0;
        return report('retry', label, Math.max(at, Math.min(at + 2, 84)));
    };
}

/**
 * The answer a résumé build gives when Google's AI could not write it, or null for any other failure (today's shape).
 *   busy          every model overloaded, hung or out of time → 503 ai_busy, retryable: "try again in a minute"
 *   quota / auth  the key is out of credit, wrong or missing  → 503 ai_down, NOT retryable (aiText already paged the
 *                 operator; a Try again cannot work until they act)
 *   other         every model truncated or refused the request → null: the lane's 500 'failed' / 504, as before
 * ⚠️ "NOTHING WAS CHARGED" IS A PROMISE, AND IT HOLDS BECAUSE EVERY AI CALL IN BOTH LANES RUNS BEFORE THE USAGE LOCK
 * AND THE CHARGE UNDER IT — nothing is claimed, consumed or stored until the model has answered. (A pass the gate
 * bound to this employer stays bound, unstamped, exactly as for any failed build: a reservation, never a charge.)
 * An AI call added after the charge would make this sentence a lie: it must give back first (giveBackDocCharges).
 * `log` is the support line: what failed and which models were asked.
 */
function resumeAiUnavailableAnswer(e) {
    if (!isAiUnavailable(e)) return null;
    const asked = Array.isArray(e.attempts) ? e.attempts.map((a) => `${a.model} ${a.kind}`).join(', ') : '';
    // No attempt at all = it never reached Google (a missing key, a spent clock): the message says which.
    const log = `Google's AI could not write it (${e.kind}: ${asked || e.message})`;
    if (e.kind === 'busy') {
        return { status: 503, log, body: {
            success: false, reason: 'ai_busy', retryable: true,
            error: 'Google\'s AI is overloaded right now, so your resume could not be written. Nothing was charged — please try again in a minute.',
        } };
    }
    if (e.kind === 'quota' || e.kind === 'auth') {
        return { status: 503, log, body: {
            success: false, reason: 'ai_down', retryable: false,
            error: 'Our AI provider is unavailable right now. Nothing was charged.',
        } };
    }
    return null;
}

// responseMimeType forces valid-JSON decoding (prompt already demands raw JSON, so
// the CONTENT is unchanged — this only guarantees the syntax). maxOutputTokens was
// 8192, which big resumes (esp. with "include uploaded resume") overflowed — Gemini
// then truncated mid-JSON and JSON.parse threw. 2.5-flash also spends "thinking"
// tokens from the same budget, so the cap must be generous; it does NOT change the
// output, only stops it being cut off. ⚠️ The SAME config goes to every fallback, so a lane's temperature holds whoever answers.
// `temperature` is the builder lane's 0.4 unless the caller says otherwise — the employer-doc lane asks
// for DOC_LANE_TEMPERATURE (see there); nothing else about the call differs between the lanes.
// → { text, model }: `model` is the one that ANSWERED. The lanes store it on the document and nowhere else.
// Throws aiText.AiUnavailableError when no model could answer; a lane never retries that (aiText already did).
async function callGemini(prompt, { temperature = 0.4 } = {}) {
    const build = resumeAiBuild.getStore() || {};
    const deadline = build.deadline || (Date.now() + RESUME_AI_DEADLINE_MS);
    const out = await aiText.generateText({
        lane: build.lane || 'resume',
        prompt,
        config: { temperature, maxOutputTokens: 32768, responseMimeType: 'application/json' },
        // The lane's own first choice, then the operator's fallbacks (AI_TEXT_FALLBACK_MODELS, else the verified two).
        models: [RESUME_MODEL, ...aiText.fallbackModels()],
        budgetMs: deadline - Date.now(),
        attemptCapsMs: RESUME_AI_CAPS_MS,
        onRetry: build.report ? resumeAiRetryNotice(build.report) : undefined,
    });
    return { text: out.text, model: out.model };
}

// ── Build the structured Gemini prompt ───────────────────────────────────────
function buildParsePrompt(name, email, phone, location, rawText, scrapedProjects, uploadedResumeContext = '', job = null) {
    const projectContext = scrapedProjects.length
        ? scrapedProjects.map(p =>
            `URL: ${p.url}\nTitle: ${p.title}\nDescription: ${p.description}`
          ).join('\n\n')
        : 'None found.';

    const uploadedBlock = uploadedResumeContext
        ? `\n=== EXISTING UPLOADED RESUME (already on file — MERGE this with the career text above. Capture every job, project, skill, certification and education from BOTH sources; never drop anything, never invent anything) ===\n${uploadedResumeContext}\n`
        : '';

    // ── The posting this resume is FOR ───────────────────────────────────────────────────────────
    // ⚠️ TAILORING IS ORDER AND EMPHASIS, NEVER FACTS. A resume that claims something the candidate
    // did not say is worse than a generic one: it fails at the interview and it is our name on it.
    // So this block may reorder, re-word and re-frame what the candidate already told us, and may
    // adopt the posting's vocabulary where it describes the same thing — and nothing else.
    const jobBlock = (job && (job.title || job.description))
        ? `
=== THE ROLE THIS RESUME IS BEING WRITTEN FOR ===
Title:   ${job.title || '(not given)'}
Company: ${job.company || '(not given)'}
${job.url ? `Link:    ${job.url}\n` : ''}${job.description ? `Posting text:\n---\n${String(job.description).slice(0, 12000)}\n---\n` : ''}
=== HOW TO USE IT (emphasis and ordering ONLY) ===
- The ZERO-MISS rule above still applies in full. Tailoring never drops anything.
- NEVER add a skill, tool, employer, qualification, certification or achievement the candidate did
  not state. Never imply more years of experience than they wrote. If this posting asks for
  something they do not have, simply do not mention it — do not soften it, do not imply it.
- WITHIN each experience entry, order the highlights so the ones this posting actually asks about
  come first. Do not delete the others.
- Order \`skills.technical\` and \`skills.soft\` so the ones this posting names — AND the candidate
  genuinely has — come first.
- Where the candidate and the posting describe the SAME thing in different words, prefer the
  posting's wording: an ATS matches on its vocabulary, not on synonyms. Only when it is the same
  thing; this is a re-wording rule, not a licence to claim.
- Write \`personal_info.title\` and \`summary\` for THIS role, using only what the candidate has
  actually done.
`
        : '';

    // ── The employer this resume is FOR, when there is no posting ─────────────────────────────────
    // ⚠️ SEPARATE FROM THE ROLE BLOCK ON PURPOSE. Without it a build that names only a company (the
    // Home "add an employer" flow) was not tailored at all — the role block needs a title or posting
    // text. Stuffing the company website into job.url to trigger that block would scrape a homepage in
    // as "Posting text" and tailor the resume to careers-page chrome, so the website is identifying
    // context here and nothing else: it is never fetched.
    // ⚠️ THE MODEL KNOWS LESS ABOUT A GIVEN EMPLOYER THAN IT WILL CLAIM. No research runs in this round,
    // so every sentence it writes "about" the employer is a guess with our name on it. Hence the rule
    // against claiming anything about the company that it cannot support.
    const empCompany = job && String(job.company || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    const empWebsite = job && String(job.website || '').replace(/\s+/g, '').trim().slice(0, 300);
    const employerBlock = (job && empCompany && !(job.title || job.description))
        ? `
=== THE EMPLOYER THIS RESUME IS BEING WRITTEN FOR (no job posting was given) ===
Company: ${empCompany}
${empWebsite ? `Website: ${empWebsite}   (given only to identify the company — it has NOT been opened; do not describe it)\n` : ''}
=== HOW TO USE IT (emphasis and ordering ONLY) ===
- The ZERO-MISS rule below still applies in full. Writing for an employer never drops anything.
- NEVER add a skill, tool, employer, qualification, certification, claim or fact that is not in the
  candidate's own text above. Never imply more experience than they wrote.
- Order the candidate's EXISTING experience highlights, projects and skills so the ones most relevant
  to what this employer does come first. Do not delete the others.
- Write \`personal_info.title\` and \`summary\` with this employer in mind, using only what the
  candidate has actually done.
- Do NOT state or imply knowledge of this employer you cannot support: no products, projects,
  customers, figures, values, culture or news. If you are not sure what this employer does, keep
  the emphasis to the industry it is plainly in, or leave the resume general.
- Do NOT write this employer's name into the title, the summary or any entry — unless the
  candidate's own text already names it (for example they worked there), in which case keep it
  exactly as they wrote it. The resume stays the candidate's own record; only its emphasis changes.
`
        : '';

    return `You are an expert executive resume writer AND veteran corporate recruiter. Your task is to parse the candidate information below and return a single, clean JSON object — NO markdown, NO code fences, NO conversational text, ONLY the raw JSON.

=== CANDIDATE DETAILS ===
Full Name: ${name}
Email:     ${email}
Phone:     ${phone}
Location:  ${location}

=== RAW CAREER TEXT (the candidate's own words) ===
${rawText}
${uploadedBlock}
=== SCRAPED PROJECT PAGES (enrichment context) ===
${projectContext}
${jobBlock}${employerBlock}

=== ⚠️ ZERO-MISS RULE (most important rule — read first) ===
You MUST capture EVERY single piece of information the candidate has written.
- Every job, internship, freelance gig, or work mention → goes into experience
- Every educational qualification mentioned — including Class X (10th), Class XII (12th), schooling, college, university — MUST appear in education. Do NOT skip school-level education.
- Every percentage, grade, GPA, or score mentioned (e.g. "85%", "8.5 CGPA") → goes into the grade field of that education entry
- Every project, side project, freelance project, or client work → goes into projects
- Every skill, tool, technology, or soft skill mentioned → goes into skills
- If you are unsure whether something is worth including — INCLUDE IT. Missing information is the only unacceptable outcome.

=== GENERAL PARSING INSTRUCTIONS ===
1. Extract and structure ALL work experience, education, projects, and skills — nothing skipped.
2. Write every experience highlight as a strong, metric-driven achievement starting with a past-tense action verb.
   BAD:  "worked at a bank fixing code bugs"
   GOOD: "Diagnosed and resolved critical software defects in a high-volume banking environment, reducing bug recurrence by [X%]"
3. Dates: use "Month YYYY" format or "Present" for current roles. For education end dates, year alone is fine (e.g. "2021").
4. If a LinkedIn or portfolio URL is mentioned, place it in personal_info.
5. Infer technical and soft skills from the full context — do not duplicate obvious ones.
6. If a metric is unknown, write [X%] or [Insert Key Metric] — NEVER fabricate numbers.

=== EDUCATION — CRITICAL RULES ===
- Capture ALL levels: Class X / SSC / 10th standard, Class XII / HSC / 12th standard, Diploma, Bachelor's, Master's, PhD — every single one.
- For school qualifications use degree = "Class X" or "Class XII" and field_of_study = the board name (e.g. "CBSE", "Maharashtra State Board", "ICSE") if mentioned.
- ALWAYS capture percentage, CGPA, grade, or score in the "grade" field exactly as the candidate wrote it (e.g. "85.40%", "8.5 CGPA", "A Grade").
- If no grade is mentioned, use grade = "".

DEGREE EXPANSION RULE — Never copy short forms or abbreviations as-is. Always expand to the full official degree name and put the abbreviation in brackets.
  Examples:
  BCA      → "Bachelor of Computer Applications (BCA)"
  MCA      → "Master of Computer Applications (MCA)"
  B.Tech / BTech → "Bachelor of Technology (B.Tech)"
  M.Tech / MTech → "Master of Technology (M.Tech)"
  BCS / B.Sc CS  → "Bachelor of Science in Computer Science (B.Sc. CS)"
  MBA      → "Master of Business Administration (MBA)"
  BBA      → "Bachelor of Business Administration (BBA)"
  B.Com    → "Bachelor of Commerce (B.Com)"
  M.Com    → "Master of Commerce (M.Com)"
  BSc      → "Bachelor of Science (B.Sc.)"
  MSc      → "Master of Science (M.Sc.)"
  BE       → "Bachelor of Engineering (B.E.)"
  ME       → "Master of Engineering (M.E.)"
  PhD      → "Doctor of Philosophy (Ph.D.)"
  SSC / 10th → "Secondary School Certificate (SSC) — Class X"
  HSC / 12th → "Higher Secondary Certificate (HSC) — Class XII"
  If you encounter an abbreviation not listed above, use your knowledge to expand it correctly.

INSTITUTION NAME EXPANSION RULE — Never copy abbreviated or casually written institute names as-is. Use your training knowledge to look up and write the full official name of the institution.
  Examples:
  "ACTS Pune" or "ACTS"    → "C-DAC ACTS (Advanced Computing Training School), Pune, Maharashtra"
  "IIT Bombay"             → "Indian Institute of Technology Bombay (IIT Bombay), Mumbai, Maharashtra"
  "BITS Pilani"            → "Birla Institute of Technology and Science (BITS), Pilani, Rajasthan"
  "DU"                     → "University of Delhi (DU), New Delhi"
  "Pune University"        → "Savitribai Phule Pune University (SPPU), Pune, Maharashtra"
  "Mumbai University"      → "University of Mumbai (MU), Mumbai, Maharashtra"
  "NIT Nagpur"             → "Visvesvaraya National Institute of Technology (VNIT), Nagpur, Maharashtra"
  "COEP"                   → "College of Engineering Pune (COEP), Pune, Maharashtra"
  "VIT"                    → "Vellore Institute of Technology (VIT), Vellore, Tamil Nadu"
  Apply the same logic to ALL institutions — schools, colleges, universities, training institutes.
  If you are not certain of the full name, write the best-known official name you are aware of.
  Always include the city and state/country if known or inferable.

=== PROFESSIONAL SUMMARY — CRITICAL RULES ===
RULE 1 — NO THIRD-PERSON: Never use the candidate's name, "He", "She", or "They".
RULE 2 — NO OBVIOUS FIRST-PERSON: Never use "I", "Me", "My", or "We".
RULE 3 — IMPLIED FIRST-PERSON ONLY: Begin with a strong professional adjective, title, or action verb.
  GOOD: "Results-driven Software Engineer with 8+ years..."
  BAD:  "I am a software engineer..." / "John is a software engineer..."
RULE 4 — STRUCTURE (hybrid paragraph + bullets):
  Write a tight paragraph of 3-4 sentences MAX, then exactly 3 metric-driven bullet points.
  Separate with \\n. Each bullet starts with "• ".
RULE 5 — NO CLICHES: Banned — "passionate professional", "proven track record of success", "dynamic", "go-getter", "team player", "results-oriented" (alone).
RULE 6 — BUSINESS VALUE: Every sentence = concrete business outcome (revenue, cost, time, scale).
RULE 7 — NO BIOGRAPHY TONE: Punchy, corporate. No "Throughout his career..." / "Over the years...".
RULE 8 — SUBTLE KEYWORD EMPHASIS: Wrap important terms in **double asterisks** — this includes:
  technologies/tools (e.g. **React Native**, **Node.js**), years of experience (e.g. **6+ years**),
  domain areas (e.g. **fintech**, **e-commerce**), key metrics (e.g. **[X%]**, **[$X]**),
  and core specialisations. Do NOT wrap every word — only genuinely significant terms (3-6 per sentence max).
  Example: "Results-driven **Full-Stack Engineer** with **6+ years** delivering scalable platforms across **fintech** and **e-commerce**."

=== EXPERIENCE BULLET RULES ===
Each highlight must:
- Start with a strong past-tense action verb (Spearheaded, Architected, Delivered, Scaled, Engineered, Launched, Optimised, Streamlined, Led, Reduced, Increased...)
- Include a positive, professional metric wherever possible — use [X%] / [$X] / [N users] / [N engineers] as placeholders if the actual value is unknown
- NEVER use negative framing like "reduced downtime" — instead write "improved system reliability by [X%]" or "achieved [X]% uptime"
- NEVER use vague placeholders like "[insert metric]" — keep placeholders short: [X%], [$X], [N]
- One concise sentence, max 20 words
- Focus on business outcome, not task description

=== PROJECT FORMAT RULES ===
Each project has TWO distinct parts:
PART 1 — ABOUT THE PROJECT: 2-3 sentences describing what the project/company IS.
  - Use the scraped page data (if available) to explain the product, platform, or business.
  - Mention the tech stack, domain, and scale/user base if known.
  - Write this from a third-party perspective (what the project is), NOT what the candidate did.
  - Wrap important keywords (tech stack names, domain terms, key metrics, product names) in **double asterisks** so the app can render them with subtle emphasis.
    Example: "**NeuCo** is a **utility construction** management platform built with **React Native**, **Node.js**, and **PostgreSQL**, serving over **500 field engineers** across the US."
PART 2 — CANDIDATE'S ROLE: The candidate's title/role in the project, then 2-3 bullet points of what they specifically built or contributed.
  - Each bullet starts with a strong action verb.
  - Include metrics or [X%] placeholders.

=== REQUIRED OUTPUT SCHEMA (return ONLY this JSON, nothing else) ===
{
  "personal_info": {
    "full_name": "",
    "email": "",
    "phone": "",
    "location": "",
    "linkedin_url": "",
    "portfolio_url": "",
    "title": "Professional title/headline, e.g. Senior Software Engineer — infer from experience if not stated",
    "nationality": "ONLY if explicitly mentioned (needed for some European CV formats), else empty string",
    "date_of_birth": "ONLY if explicitly mentioned, else empty string"
  },
  "summary": "3-4 sentence implied-first-person paragraph followed by exactly 3 metric-driven bullets using bullet prefix and newline separator",
  "experience": [
    {
      "company": "",
      "role": "",
      "location": "",
      "start_date": "",
      "end_date": "",
      "highlights": ["Action-verb achievement with metric or [X%] placeholder"]
    }
  ],
  "education": [
    {
      "institution": "",
      "degree": "e.g. Class X / Class XII / Bachelor of Engineering / Master of Science",
      "field_of_study": "e.g. Science / CBSE / Computer Engineering / Artificial Intelligence",
      "end_date": "e.g. 2018 or May 2022",
      "grade": "e.g. 85.40% / 8.5 CGPA / A Grade — use exactly what candidate wrote, or empty string"
    }
  ],
  "projects": [
    {
      "title": "Project or company name only, e.g. NeuCo",
      "type": "Short descriptor of what kind of project/company it is, e.g. Utility Construction Company / E-commerce Platform / SaaS Product",
      "link": "URL if mentioned, else empty string",
      "about": "2-3 sentences about what the project/company IS: its domain, tech stack, product, and scale. Written from a third-party perspective.",
      "role": "The candidate's role/title in this project, e.g. Full Stack Developer / Lead Engineer",
      "role_highlights": ["Action-verb bullet: what the candidate built or achieved", "Second bullet", "Third bullet if applicable"]
    }
  ],
  "skills": {
    "technical": [],
    "soft": []
  },
  "certifications": [
    { "name": "Certification name, e.g. PMP / AWS Solutions Architect", "issuer": "Issuing body, e.g. PMI / Amazon", "year": "Year if mentioned, else empty" }
  ],
  "languages": [
    { "name": "e.g. English", "level": "e.g. Native / Fluent / C2 / B2 — use CEFR if known" }
  ],
  "achievements": ["Award, recognition, hackathon win, or standout accomplishment — ONLY if mentioned, never fabricate"]
}

=== CERTIFICATIONS, LANGUAGES & ACHIEVEMENTS ===
- Extract any certifications, spoken languages (with proficiency), and awards/achievements mentioned in the text.
- These power country-specific resume formats (e.g. European CVs need languages). If none are mentioned, return an empty array [] — NEVER invent them.`;
}

// ══════════════════════════════════════════════════════════════════════════════
// THE EMPLOYER-DOC PROMPT (Home: one employer's own resume, stored in employerDocs)
// ══════════════════════════════════════════════════════════════════════════════

/** The family table for the prompt when designFit.js cannot be loaded — the build must not fail on it. */
function localFamilyBrief() {
    return ['id | name | photo slot | ats 1-5']
        .concat(FAMILIES.map((f) => `${f.id} | ${f.name} | ${f.photo ? 'yes' : 'no'} | ${f.ats || 3}`))
        .join('\n');
}

// ── The employer's hiring conventions (employerResearch `conventions`) ─────────────────────────────────
// ONE grounded research call reads how THIS employer hires and what CV conventions hold in its country and
// sector: { hqCountry, roleCountry, employerType, sector, atsVendor, cv: { photo, length, personalDetails,
// dateFormat, format, notes }, tone, sources } — every field null when unknown, and the whole object null on a
// cache row that predates it or a research call that failed. The doc lane turns it into three things: the
// prompt's HIRING CONVENTIONS facts (employerResearch.conventionsPromptBlock), its FORMATTING rules
// (docFormattingBlock), and the design ranking's employer-first inputs (rankDocDesign / rerankStoredResumeDesign).
// ⚠️ IT IS A MODEL'S READING OF PUBLIC PAGES — untrusted, possibly wrong. So it only ever shapes format and
// emphasis, every enum is checked against its closed list here, and free text is capped and flattened before it
// can reach a prompt or a headline.

const DOC_EMPLOYER_TYPES = ['public_sector', 'enterprise', 'sme', 'startup', 'agency', 'ngo', 'academia', 'other'];

/** research.conventions when it is a usable object, else null (an old cache row, an old research module). */
function conventionsOfResearch(research) {
    const c = research && typeof research === 'object' && !Array.isArray(research) ? research.conventions : null;
    return c && typeof c === 'object' && !Array.isArray(c) ? c : null;
}

/** A date pattern the prompt may quote ("MM/YYYY", "Month YYYY", "DD.MM.YYYY"), else null. */
function docDateFormatOf(v) {
    const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
    if (!s || s.length > 24 || !/^[A-Za-z0-9 .,/-]+$/.test(s)) return null;
    return /y{2,4}|year/i.test(s) ? s : null;
}

/**
 * Flattened, capped free text from the research, or null. "===" runs go, so a string cannot fake a prompt header,
 * and the cap falls at a word ("SuccessFactors Recruiting", never "SuccessFactors Recruiting Managem").
 */
function docConventionText(v, max) {
    if (typeof v !== 'string') return null;
    const s = v.replace(/\p{Cc}+/gu, ' ').replace(/={3,}/g, '—').replace(/\s+/g, ' ').trim();
    if (!s) return null;
    if (s.length <= max) return s;
    return s.slice(0, max + 1).replace(/\s+\S*$/, '').trim() || s.slice(0, max);
}

/**
 * A researcher that found nothing often says so in words — "Unknown", "N/A", "Global", "in-house" — and that word
 * must not become a fact: "Acme screens applications with Unknown", "Employers in Worldwide". Null instead.
 */
const DOC_NOT_A_COUNTRY_RE = /^(unknown|not (known|found|specified|available)|n\/?a|none|null|global|worldwide|international|multiple|various|remote|europe|asia|africa|emea|apac|latam|americas|middle east)$/i;
const DOC_NOT_AN_ATS_RE = /^(unknown|not (known|found|specified|available)|n\/?a|none|null|no|other|in-house|inhouse|internal|proprietary|email|e-mail|custom)$/i;
const docFactOr = (v, junk) => (v && !junk.test(v) ? v : null);

/**
 * The conventions as THIS lane reads them — enums checked against their closed lists, text capped — or null when
 * nothing actionable is left. Never throws. The RAW object is still what designFit / employerResearch receive
 * (they sanitise their own inputs); this view is only for the rules, the backstop and the headline below.
 */
function docConventionsOf(raw) {
    const c = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
    if (!c) return null;
    const one = (v, allowed) => (typeof v === 'string' && allowed.includes(v) ? v : null);
    const cv = c.cv && typeof c.cv === 'object' && !Array.isArray(c.cv) ? c.cv : {};
    const out = {
        hqCountry: docFactOr(docConventionText(c.hqCountry, 60), DOC_NOT_A_COUNTRY_RE),
        roleCountry: docFactOr(docConventionText(c.roleCountry, 60), DOC_NOT_A_COUNTRY_RE),
        employerType: one(c.employerType, DOC_EMPLOYER_TYPES),
        sector: docFactOr(docConventionText(c.sector, 80), DOC_NOT_A_COUNTRY_RE),
        atsVendor: docFactOr(docConventionText(c.atsVendor, 40), DOC_NOT_AN_ATS_RE),
        cv: {
            photo: one(cv.photo, ['expected', 'optional', 'avoid']),
            length: one(cv.length, ['one_page', 'two_pages', 'flexible']),
            personalDetails: one(cv.personalDetails, ['include', 'avoid']),
            dateFormat: docDateFormatOf(cv.dateFormat),
            format: one(cv.format, ['tabular', 'narrative', 'europass', 'ats_plain']),
        },
    };
    const any = out.hqCountry || out.roleCountry || out.employerType || out.sector || out.atsVendor
        || Object.values(out.cv).some((v) => v != null);
    return any ? out : null;
}

const DOC_TECH_SECTOR_RE = /\b(software|saas|tech\w*|internet|cloud|data|ai|artificial intelligence|developer\w*|digital|fintech|cyber\w*|telecom\w*|semiconductor\w*|it services|e-?commerce)\b/i;

/**
 * The FORMATTING section of the employer-doc prompt: what THIS employer's hiring conventions change about how the
 * resume is written — which details it carries, how long it runs, how dates read, how plain the bullets are, and
 * what leads inside each entry. '' when the research carried no conventions.
 *
 * ⚠️ FORMAT AND EMPHASIS ONLY. Every rule moves, condenses, blanks or re-words what the candidate's own material
 * already says; none may add a fact, and the ZERO-MISS rule still holds (condense, never drop an entry).
 * ⚠️ DETERMINISTIC: the enums map onto fixed instructions, so the same research always writes the same rules.
 * The personal-details rule is also enforced in code (applyPersonalDetailsConvention) — a prompt is advice.
 */
function docFormattingBlock(conventions, company) {
    const c = docConventionsOf(conventions);
    if (!c) return '';
    const cv = c.cv;
    const rules = [];
    if (cv.personalDetails === 'avoid') {
        rules.push('- Personal details: leave personal_info.date_of_birth and personal_info.nationality as "" even when the material states them — employers here do not expect them on a CV.');
    } else if (cv.personalDetails === 'include') {
        rules.push('- Personal details: employers here expect them — keep personal_info.date_of_birth and personal_info.nationality exactly as the material states them. When the material does not state one, leave it "" — never guess.');
    }
    if (cv.length === 'one_page') {
        rules.push(`- Length: ONE page of content. Keep every experience and education entry, but give each role at most 3 highlights (the ones that matter to ${company}) and older or less relevant roles one or two, keep the summary to 3 sentences before its bullets, and merge minor bullets. Never drop an entry.`);
    } else if (cv.length === 'two_pages') {
        rules.push('- Length: up to two pages is normal here — keep the detail the material has instead of cutting highlights to save space.');
    }
    if (cv.dateFormat) {
        rules.push(`- Dates: write every experience start_date and end_date as ${cv.dateFormat} ("Present" for an ongoing role); an education end_date may stay a year alone when the material gives only the year.`);
    }
    if (cv.format === 'ats_plain' || c.atsVendor) {
        rules.push(`- Plain text for screening software${c.atsVendor ? ` (${company} is known to screen applications with ${c.atsVendor})` : ''}: no tables, symbols, emoji or decorative separators inside a bullet, no ALL-CAPS phrases, and standard wording for job titles and skills.`);
    }
    if (cv.format === 'tabular') rules.push('- Tabular CV: keep each entry crisp and factual — dates, role, employer, then short highlights — because the page is read as a table.');
    if (cv.format === 'europass') rules.push('- Europass-style CV: give a language a CEFR level (A1-C2) ONLY where the material states that level; never estimate one.');
    if (cv.format === 'narrative') rules.push('- Narrative CV: the summary may use all four sentences, and highlights read as complete sentences.');
    switch (c.employerType) {
        case 'startup':
            rules.push('- Emphasis (a startup): inside each experience entry lead with what the candidate built, shipped and owned; the projects the material has come early, and skills.technical leads with the tools they built with.');
            break;
        case 'public_sector':
            rules.push('- Emphasis (the public sector): inside each entry lead with responsibilities, compliance and process work, and the stakeholders served, in the material\'s own terms; keep the wording formal, with no sales language.');
            break;
        case 'academia':
            rules.push('- Emphasis (academia): when the material has research, teaching or publications, lead the summary with them and put publications and research projects first among projects; keep every education detail (thesis, grade, honours).');
            break;
        case 'agency':
            rules.push('- Emphasis (an agency): make skills.technical keyword-dense — every tool, platform and method the material names, in the role\'s vocabulary where it is the same thing — and lead highlights with client-facing delivery.');
            break;
        case 'enterprise':
            rules.push('- Emphasis (a large employer): lead highlights with the scope and scale the material states (teams, systems, regions, budgets) and cross-functional work; use standard job titles.');
            break;
        case 'sme':
            rules.push('- Emphasis (a smaller employer): lead with breadth and hands-on ownership — the end-to-end work the candidate owned.');
            break;
        case 'ngo':
            rules.push('- Emphasis (a non-profit): lead with mission-related work, volunteering and community impact when the material has them.');
            break;
        default: break;
    }
    if (c.employerType !== 'startup' && c.sector && DOC_TECH_SECTOR_RE.test(c.sector)) {
        rules.push('- Emphasis (a technology employer): inside each entry, projects and shipped work come first.');
    }
    if (!rules.length) return '';
    return [
        `=== FORMATTING FOR ${company} (from its hiring conventions) ===`,
        ...rules,
        '- These rules change FORMAT and EMPHASIS only. They never add, infer or embellish a fact, and every entry in the material still appears.',
    ].join('\n');
}

/**
 * employerResearch.conventionsPromptBlock (the conventions as facts, with their own guard rails), defensively: ''
 * without conventions, or when the export is missing (a research module from before conventions) or throws.
 */
function conventionsBlockForDoc(conventions, company) {
    if (!conventions) return '';
    try {
        const er = require('../services/employerResearch');
        if (typeof er.conventionsPromptBlock !== 'function') return '';
        return String(er.conventionsPromptBlock(conventions, company, { forLetter: false }) || '');
    } catch (e) {
        console.warn('[resumeBuilder] conventions block unavailable:', e.message);
        return '';
    }
}

// ── How a CV is written WHERE THE APPLICATION IS GOING (server/services/cvPlaybook.js) ───────────────
// ⚠️ EVERY COUNTRY GOT THE SAME DOCUMENT (2026-09-16). The conventions above are what the research found about
// ONE employer, and for most employers it finds nothing at all: the prompt then fell back to habits it never
// names out loud — "Month YYYY" dates, an Anglo summary, "as the material has it" detail, and not one word
// about projects. So an Indian résumé, where screening stack-matches the PROJECT inventory before it reads the
// roles, came back with nine projects merged into three lines, and a German one came back without the gapless
// dated table a Lebenslauf IS. Meanwhile regionFromCountry already resolves EVERY country to a CV profile and
// designFit already reads it for the DESIGN — only the WRITING knew nothing about where it was going.
//
// cvPlaybook is that same resolution read for the writing, plus the columns the country table has no slot for
// (projects, experience depth, bullets per role, metrics, the summary, skills, the section order, the date
// pattern, a few country notes), merged in designFit.employerContext's order: profile row → country override →
// employer size/type → the researched conventions for THIS employer. ⚠️ THE LANE RESOLVES IT ONCE
// (generateEmployerDoc) and hands the SAME object to the prompt, the personal-details backstop and the design
// ranking: a document written for one country and designed for another is the one failure mode this must not
// have — and it is the shape the mode decision already had, twice, from the same raw conventions.
//
// ⚠️ IT IS NOT A FINGERPRINT INPUT, AND MUST NEVER BECOME ONE. employerDocs.fingerprint hashes the base text,
// the four job fields and researchRev — no prompt string, no country, no playbook value (see
// generationFingerprint). So this changes what a NEW document says and leaves every stored one a free cache
// hit, exactly as the conventions slice did. Making it retro-apply would mean bumping docResearchRev, which
// re-bills every stored employer résumé.

/**
 * The four readings of "how is a CV written here", resolved TOGETHER so they can never disagree:
 *   playbook   — cvPlaybook's merged answer: its own prompt block, and the content rules this lane reads
 *                (today `content.projects === 'all'`, which the schema and the ZERO-MISS rule must honour);
 *   conv       — the MERGED conventions in docConventionsOf's shape: the researched value wherever the research
 *                spoke for the country being written for, the country baseline in every gap. The page mode, the
 *                personal-details backstop, the date rule and the detail level all read THIS one;
 *   researched — the same shape carrying ONLY the researched values that survived that merge. It is what
 *                docFormattingBlock speaks for, so a country generalisation never reaches a block headed "from
 *                its hiring conventions", and the two blocks can never state one rule twice or two rules once:
 *                cvPlaybook stays quiet about a value the research supplied (its own `_from` check) and this
 *                stays quiet about one the research did not supply — or that cvPlaybook demoted because it was
 *                researched for ANOTHER country's hiring (designFit's W_FOREIGN_RESEARCH, in code here);
 *   facts      — the RAW conventions employerResearch's own block speaks from, with exactly those demoted cv
 *                values taken out. Everything else it prints — the HQ, where the employer hires, its type,
 *                sector, ATS, register and notes — is untouched: they are facts about the employer and stay
 *                true wherever the application is going.
 *
 * ⚠️ THE FACTS BLOCK IS THE ONE THAT GIVES ORDERS (2026-09-16). conventionsPromptBlock does not only list what
 * the research found; under "HOW TO USE THESE CONVENTIONS" it turns cv.personalDetails / length / dateFormat /
 * format into imperatives. Fed the raw conventions it issued them for the EMPLOYER'S HOME country while the
 * country block issued the opposite ones for the country being applied to — a US-headquartered employer hiring
 * in Germany got "leave date of birth and nationality out" and "keep the date of birth and nationality exactly
 * as the material states them" twenty lines apart, and "fit one page" against "up to two pages is normal here".
 * FORMATTING went quiet correctly (it reads `researched`); the unfiltered facts block was the hole. So the same
 * filter feeds both, and the prompt can never hold two answers to one question.
 *
 * ⚠️ AND THE FILTER IS PROVENANCE, NOT VALUE EQUALITY. `spoken` used to keep a field whenever the researched
 * value happened to EQUAL the merged one, so a research answer the country baseline agreed with (Germany's
 * MM/YYYY, researched as MM/YYYY) was credited to the research — FORMATTING stated the date rule and cvPlaybook,
 * whose own `_from` said 'country', stated it again. fromOf() is the very map playbookPromptBlock suppresses by,
 * so reading it here is what makes "said exactly once" true in both directions.
 *
 * Never throws and never fails a build: without cvPlaybook (a checkout from before it) it answers the researched
 * conventions in `conv` and `researched` and the raw ones in `facts` — exactly how this lane read before it existed.
 */
function docPlaybookOf({ country = null, website = null, conventions = null, research = null } = {}) {
    const raw = conventions !== undefined && conventions !== null ? conventions : conventionsOfResearch(research);
    const researched = docConventionsOf(raw);
    let playbook = null;
    try {
        const cvp = require('../services/cvPlaybook');
        if (typeof cvp.playbookFor === 'function') {
            playbook = cvp.playbookFor({ country: country || null, website: website || null, conventions: raw || null, research: research || null });
        }
    } catch (e) { console.warn('[resumeBuilder] cvPlaybook unavailable — the country baseline is skipped:', e.message); }
    if (!playbook || !playbook.cv) return { playbook: null, conv: researched, researched, facts: raw || null };
    // Which layer cvPlaybook's merged answer came from, field by field ('research' | 'country' | 'region' |
    // 'size' | null) — the very map playbookPromptBlock suppresses by, read off the playbook it handed us.
    const from = docPlaybookFromOf(playbook);
    const hasFrom = Object.keys(from).length > 0;
    const conv = {
        hqCountry: researched ? researched.hqCountry : null,
        roleCountry: researched ? researched.roleCountry : null,
        employerType: researched ? researched.employerType : null,
        sector: researched ? researched.sector : null,
        atsVendor: researched ? researched.atsVendor : null,
        cv: { photo: null, personalDetails: null, length: null, dateFormat: null, format: null },
    };
    const spoken = { photo: null, personalDetails: null, length: null, dateFormat: null, format: null };
    for (const f of Object.keys(conv.cv)) {
        const found = researched ? researched.cv[f] : null;
        // cvPlaybook has already laid the research over the country baseline (and dropped it where it was
        // researched for somewhere else), so its answer IS the merge; `found` only fills a field the country
        // table has no opinion on at all.
        const merged = playbook.cv[f] || found || null;
        conv.cv[f] = merged;
        // ⚠️ Only what cvPlaybook itself credits to the research may be spoken AS the research's (see the header).
        // Where cvPlaybook has no opinion at all the research is the whole answer and nobody else will state it.
        // ⚠️ AND WITHOUT PROVENANCE, THE OLD VALUE TEST — never silence. A cvPlaybook that cannot say where its
        // answer came from would otherwise leave FORMATTING quiet about a rule its own block is ALSO quiet about
        // (it suppresses whatever it credits to the research), and the document would be written to nobody's
        // conventions at all. One rule stated twice is a blemish; a rule both blocks drop is the bug.
        spoken[f] = playbook.cv[f]
            ? (hasFrom ? (from[f] === 'research' ? merged : null) : (found && found === merged ? found : null))
            : (found || null);
    }
    return {
        playbook,
        conv: docConventionsOf(conv),
        researched: researched ? { ...researched, cv: spoken } : null,
        facts: docFactConventionsOf(raw, spoken),
    };
}

/**
 * cvPlaybook's own provenance for the five cv fields, off the playbook object it returned ('research' |
 * 'country' | 'region' | 'size' | null per field), or {} when it carries none — a cvPlaybook from before it
 * travelled. It rides on a non-enumerable `_from` (invisible to JSON, so a stored playbook and a fresh one still
 * compare equal); cvPlaybook's own fromOf() reads exactly this. {} means "cannot tell", and docPlaybookOf falls
 * back to the value test rather than letting both blocks fall silent.
 */
function docPlaybookFromOf(playbook) {
    const pb = playbook && typeof playbook === 'object' && !Array.isArray(playbook) ? playbook : null;
    const f = pb ? pb._from : null;
    return f && typeof f === 'object' && !Array.isArray(f) ? f : {};
}

/**
 * The RAW conventions object the FACTS block (employerResearch.conventionsPromptBlock) may speak from: every
 * fact about the employer as the research gave it, with only the cv values cvPlaybook demoted removed — see
 * docPlaybookOf's header for why a demoted one must not reach that block.
 *
 * ⚠️ THE `cv` OBJECT IS REPLACED, NEVER MERGED. sanitiseConventions reads camelCase first and snake_case second
 * (`personalDetails` then `personal_details`), so merging a camelCase null over a snake_case answer would leave
 * the snake_case one standing — the researcher's own shape is snake_case. The notes travel with it: they are
 * the employer's own lines, not a cv enum, and losing them would cost the block its only free-text facts.
 */
function docFactConventionsOf(raw, spoken) {
    const c = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
    if (!c) return null;
    const cv = c.cv && typeof c.cv === 'object' && !Array.isArray(c.cv) ? c.cv : {};
    const notes = Array.isArray(cv.notes) ? cv.notes : (Array.isArray(c.notes) ? c.notes : []);
    return { ...c, cv: { ...(spoken || {}), notes } };
}

/**
 * cvPlaybook.playbookPromptBlock (the country's own rules, with its own guard rails), defensively: '' without a
 * playbook, when the export is missing (a checkout from before cvPlaybook) or when it throws. Mirrors
 * conventionsBlockForDoc exactly — a block from another module can never fail a build.
 */
function docPlaybookBlock(playbook, company) {
    if (!playbook) return '';
    try {
        const cvp = require('../services/cvPlaybook');
        if (typeof cvp.playbookPromptBlock !== 'function') return '';
        return String(cvp.playbookPromptBlock(playbook, company, { forLetter: false }) || '');
    } catch (e) {
        console.warn('[resumeBuilder] cv playbook block unavailable:', e.message);
        return '';
    }
}

/**
 * The page mode the document is STORED under — which must be the page the prompt asked the model to WRITE.
 *
 * ⚠️ ONE PAGE IS A CONSTRAINT; TWO PAGES IS A PERMISSION. A one-page rule, whether it came from the employer's
 * research or from the country the application is going to, wrote the content to one page (at most 3 highlights
 * a role, a summary of at most 3 sentences) — so the stored mode follows it, or the download is a two-page
 * shell around one page of content. "Up to two pages is normal here" only ALLOWS the room: from the RESEARCH it
 * still decides (an employer that says so has said it about itself, and that is how this lane has always read
 * it), but from a COUNTRY baseline it leaves the model's own reading of how much material there is alone —
 * otherwise every Indian, German and British document would be stored 'a4' whatever the candidate's record holds.
 */
function docPageModeOf(plan, aiMode) {
    const conv = plan && plan.conv;
    const researched = plan && plan.researched;
    if (conv && conv.cv.length === 'one_page') return 'onepage';
    if (researched && researched.cv.length === 'two_pages') return 'a4';
    return aiMode;
}

// ── The country a stored document was WRITTEN for ────────────────────────────────────────────────────
// ⚠️ THE WRONG COUNTRY'S DOCUMENT WAS FREE FOR EVER (2026-09-16). Since docPlaybookOf the chip's country decides
// what the document SAYS — the section order, the date pattern, one entry per project, the page mode the row is
// stored under, and the date of birth and nationality applyPersonalDetailsConvention blanks in code. None of it
// is hashed (see generationFingerprint: the base text, the four job fields and the research revision — and it
// must STAY that way, or every stored document turns stale and every user is re-billed for a better prompt). So
// a user who built "Acme" while the chip said United States, then corrected the chip to Germany, re-posted the
// identical inputs, hit the identical fingerprint and was handed back the American document — one page, no date
// of birth, Anglo section order — labelled fresh, with no way to ever get the German one.
//
// The fix is not a new hash: it is that the document REMEMBERS which country it was written for (design
// .writtenFor) and is not served as a free hit for a different one. A mismatch is a cache MISS, and a miss is
// the path this lane already has: a build the app confirmed as 'cache' is refused with 409 cache_miss (nothing
// bound, nothing charged) and Home re-asks on its sheet, exactly as it does when a saved document is gone.
// ⚠️ NOBODY IS RE-BILLED FOR THIS. Not one stored row carries the marker, and a document without one is always
// served — so every document that exists today stays the free hit it is, and only a NEW build can ever disagree
// with a later country.
//
// ⚠️ IT READS THE CHIP AND THE VETTED SITE, NEVER THE RESEARCH. The research's own hqCountry / roleCountry also
// resolve a place (regionFromCountry.placeFor reads them), but the research is a 30-day cache that refreshes on
// its own: keyed on it, a document could stop matching itself with nobody having touched anything, and the user
// would be asked to pay for a rebuild they did not ask for. The chip's country and the employer's website are
// the user's own inputs, and they move only when the user moves them.

/**
 * The country this build is being written for, as a short stable key ('in', 'de', 'us', …), or '' when neither
 * the chip nor the website names one. Same resolution chain as the playbook and the design region, minus the
 * research — see the note above. Never throws: without the country table it answers '' (no opinion).
 */
function docPlaceKeyOf({ country = null, website = null } = {}) {
    try {
        const region = require('../utils/regionFromCountry');
        if (typeof region.placeFor !== 'function') return '';
        const place = region.placeFor({ country: country || null, website: website || null, conventions: null });
        const key = place && (place.iso2 || place.name);
        return typeof key === 'string' ? key.trim().toLowerCase().slice(0, 40) : '';
    } catch (e) {
        console.warn('[resumeBuilder] country resolution unavailable — the document records no country:', e.message);
        return '';
    }
}

/** The country a STORED document records having been written for, or '' (every row from before the marker). */
function docWrittenForOf(doc) {
    let design = doc && doc.design;
    if (typeof design === 'string') { try { design = JSON.parse(design); } catch { design = null; } }
    const v = design && typeof design === 'object' && !Array.isArray(design) ? design.writtenFor : null;
    return typeof v === 'string' ? v.trim().toLowerCase().slice(0, 40) : '';
}

/**
 * May this stored document be served as a FREE cache hit for `placeKey`?
 *
 * Yes unless BOTH sides name a country and they differ. A row with no marker is every document built before
 * this existed — served, or the slice would re-bill its owner. A build that resolves no country at all cannot
 * tell whether the document suits it, and "cannot tell" is never a reason to charge someone.
 */
function docServesPlace(doc, placeKey) {
    const was = docWrittenForOf(doc);
    if (!was || !placeKey) return true;
    return was === placeKey;
}

/**
 * Was this stored document written for a DIFFERENT country than the chip is asking about now? — the STALE
 * LABEL's half of the same question docServesPlace answers for the cache.
 *
 * ⚠️ WITHOUT IT THE MARKER ONLY EVER REFUSES. The wrong country's document is no longer handed over free —
 * but /api/employer-docs/current labels staleness by comparing fingerprints, and the country is deliberately
 * not hashed (see the header above, and it must stay that way or every stored document turns stale and every
 * user is re-billed), so the American document re-hashes to a PERFECT MATCH for a German chip and reports
 * fresh. The Refresh pill is drawn on `stale`, so nothing on the screen offers the rebuild the refusal makes
 * possible, and the Tailor button is drawn only when the chip has NO document at all. That is the 2026-09-16
 * bug with its harm halved: nobody is re-billed and nobody is served the wrong country's résumé — and nobody
 * can get the right one either. So the routes ask this, beside the fingerprint, and a true answer is stale.
 *
 * ⚠️ ONE IMPLEMENTATION, HERE, for the same reason rerankStoredDesign is: the label must give the answer the
 * BUILD gives. Same website vetting (docResearchSiteFor — a job board's ccTLD is not the employer's), same
 * placeFor chain, and the same two "cannot tell" cases that keep a document free (no marker on the row, no
 * country on the request). A second copy in the routes would drift, and the pill would nag on a document the
 * build then serves as a free hit — a paid rebuild the user did not need.
 *
 * It hashes nothing, reads no database and never throws: a LABEL, never a cache key. `country` and `job` are
 * the REQUEST's own fields — the chip's country and { website, url } as the build would send them — never the
 * row's: re-deriving the place from the document's own stored job can only ever answer the country it was
 * already written for, which reads fresh for ever, and the wrong country's résumé stays on the screen.
 */
function docWrittenElsewhere(doc, { employer = null, country = null, job = null } = {}) {
    const j = job && typeof job === 'object' ? job : {};
    const asked = { website: typeof j.website === 'string' ? j.website : '', url: typeof j.url === 'string' ? j.url : '' };
    const site = docResearchSiteFor(typeof employer === 'string' ? employer : '', asked) || asked.website;
    return !docServesPlace(doc, docPlaceKeyOf({ country: typeof country === 'string' ? country : null, website: site || null }));
}

/**
 * The one formatting convention enforced in CODE as well as in the prompt: an employer whose conventions say a CV
 * carries NO personal details gets none, whatever the draft says. A date of birth or a nationality on a CV sent
 * where they are not expected is noise at best and, where hiring guards against discrimination, a reason to set
 * it aside. It is the candidate's own fact, so blanking it on THIS employer's copy loses nothing: the base resume
 * keeps it. ('include' is prompt-only: the code cannot tell a fact the model dropped from one it never had.)
 *
 * ⚠️ IT TAKES THE MERGED VIEW (docPlaybookOf's `conv`), not the raw research — 2026-09-16. A US or UK posting
 * whose employer research came back empty says 'avoid' through the COUNTRY, and the prompt now tells the model
 * so; without the same answer here that rule would be advice with no backstop, which is the split the header
 * above warns about. A raw conventions object still works (docConventionsOf reads both shapes).
 * ⚠️ WHICH IS WHY THE DOCUMENT RECORDS ITS COUNTRY (docPlaceKeyOf). This is the one country decision that
 * DELETES the candidate's own facts from the stored payload, and it is irreversible for that row — served for
 * a country that expects a date of birth, it is a Lebenslauf permanently missing one. It is safe only because
 * a document is never handed back as a free hit for a country it was not written for.
 */
function applyPersonalDetailsConvention(resumeData, conventions) {
    const c = docConventionsOf(conventions);
    if (!c || c.cv.personalDetails !== 'avoid') return;
    const pi = resumeData && resumeData.personal_info;
    if (!pi || typeof pi !== 'object' || Array.isArray(pi)) return;
    pi.date_of_birth = '';
    pi.nationality = '';
}

// ── The employer's sector, and the top lines written for it ──────────────────────────────────────────
// ⚠️ EVERY EMPLOYER'S RESUME CAME BACK THE SAME (2026-09-15). The prompt said "rewrite the title and summary for
// what Amazon needs" and the model kept the candidate's own title and its generic opening for Amazon, Nordex and
// a Moroccan agency alike — a document the user paid for per employer that read like the base résumé. So the
// prompt now names the SECTOR in one place (docSectorOf — the same words the corrective pass and the sameness
// guard use), tells the model exactly which lines must read as written for it, and the lane measures the answer
// (docSamenessOf) instead of trusting it.

const DOC_EMPLOYER_TYPE_TEXT = {
    public_sector: 'a public-sector body', enterprise: 'a large enterprise', sme: 'a small or medium-sized company',
    startup: 'a startup', agency: 'an agency', ngo: 'a non-profit', academia: 'a university or research institute',
};

/**
 * The employer's sector in words — the conventions' `sector` first (the hiring research names it for the CV), else
 * the researcher's `industry` — capped and flattened, or null when nothing names one. ⚠️ ONE ANSWER for the prompt,
 * the corrective pass and the guard's "industry known": three readings of the research would disagree on the edge.
 */
function docSectorOf(research, conventions) {
    const conv = docConventionsOf(conventions !== undefined ? conventions : conventionsOfResearch(research));
    if (conv && conv.sector) return conv.sector;
    const r = research && typeof research === 'object' && !Array.isArray(research) ? research : null;
    return docFactOr(docConventionText(r ? r.industry : null, 80), DOC_NOT_A_COUNTRY_RE);
}

/** "Industrial automation" reads as "industrial automation" mid-sentence; "SaaS" and "IT services" stay as they are. */
function docSectorPhraseOf(sector) {
    const s = String(sector || '').trim();
    return s.length > 1 && /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}

/**
 * The WRITTEN FOR section of the employer-doc prompt: which lines a recruiter reads first and what each must say
 * for THIS sector — the title in the candidate's real roles, the summary's first sentence as their fit for the
 * sector, the bullets in the employer's vocabulary, and the detail level the conventions set — since 2026-09-16
 * the MERGED conventions (this employer's where the research found them, the country's where it did not), so a
 * one-page country and a one-page employer are told the same thing. Always present: even without research the
 * sector the employer hires in is something the model may bring to EMPHASIS (it is not a fact about the
 * candidate). ⚠️ Emphasis and wording only, same as every other block — the never-invent rules
 * stand, and this one restates them where the temptation is strongest.
 *
 * ⚠️ THE OPENING HAS A SHAPE AND A WORKED EXAMPLE (2026-09-15). "State the fit for the sector" got the base
 * summary's first sentence back with the sector list swapped (Deutsche Bahn, prod: "Accomplished Project Manager
 * with 14+ years … specializing in enterprise solutions for utility construction, waste management, and
 * logistics") — the likeliest rewrite of a sentence is that sentence. So the first sentence is given as a SHAPE,
 * "<real role> for <sector> — <the two or three real strengths that matter here>", with an example on a candidate
 * who is not this one (a data engineer at a hospital group): a shape to fill from the material, never words to
 * keep. docSamenessOf measures the opening on its own afterwards.
 */
function docTopLinesBlock({ company, sector, conventions } = {}) {
    const conv = docConventionsOf(conventions);
    const typeText = conv && conv.employerType ? DOC_EMPLOYER_TYPE_TEXT[conv.employerType] || null : null;
    const phrase = sector ? docSectorPhraseOf(sector) : `the field ${company} hires in`;
    const who = typeText ? `${phrase} (${company} is ${typeText})` : phrase;   // the type once, in the opening line
    const shapeFor = sector ? phrase : `<the sector ${company} hires in>`;   // the slot in the opening's shape
    const length = conv ? conv.cv.length : null;
    const detail = length === 'one_page'
        ? `one page: at most 3 highlights per role (the ones that matter to ${company}), a summary of at most 3 sentences before its 3 bullets, and minor bullets merged — never an entry dropped.`
        : length === 'two_pages' || length === 'flexible'
            ? `full: keep every highlight the material has, reworded and reordered for ${company}.`
            : `as the material has it: full where the material is detailed, tight where it is not.`;
    return [
        `=== WRITTEN FOR ${company}: THE TOP LINES ===`,
        `A recruiter at ${company} reads the title and the first sentence of the summary before anything else. Both must read as written for ${who} — from the candidate's real record, never from what ${company} would like to hear:`,
        `- personal_info.title: phrase it for ${phrase} using the candidate's REAL roles — the shape is "<their real role> — <the specialism of theirs that this sector needs>" (e.g. a backend engineer applying to a payments company: "Backend Engineer — Payment Systems & APIs"). Never a role the material does not support, never ${company}'s name.`,
        `- summary, first sentence: LEAD with the candidate's fit for ${phrase}, in the vocabulary ${company} uses. The shape is "<their real role> for ${shapeFor} — <the two or three real strengths of theirs that matter most here>", e.g. a data engineer applying to a hospital group: "Data Engineer for healthcare providers — clinical-data pipelines, HL7 integrations and audit-ready reporting" (an example of the SHAPE only, about someone else — never these words). Fill it from the skills, domains and work in the material that match this sector. The material's own opening sentence with a word or two swapped is not a rewrite, and a generic opening that would suit any employer is wrong here.`,
        `- Experience highlights and skills: where the material describes the SAME thing, say it in the vocabulary ${company} uses — the technologies, products and mission named in the research above, in that wording — and put those bullets first. A technology or product the candidate has not touched stays out, whatever the research names.`,
        `- Detail level, ${detail}`,
    ].join('\n');
}

/**
 * The prompt for Home's employer document: a FULL rewrite of the candidate's resume for one employer,
 * grounded by that employer's web research, plus a design score per layout family — in ONE call.
 *
 * ⚠️ THE CANDIDATE'S MATERIAL IS THE ONLY SOURCE OF FACTS, AND THE PROMPT SAYS SO BEFORE ANYTHING ELSE.
 * This prompt hands the model three things that are NOT evidence about the candidate — the employer's
 * research, the posting, and a design table — and a "rewrite it for Amazon" instruction. That is the
 * exact recipe for a resume that claims what Amazon wants instead of what the candidate did, and a
 * fabricated claim fails at the interview with our name on it. So: what may change (title, summary,
 * wording, order, condensing) and what may never happen (any invented fact, any placeholder, the
 * employer's name, facts about the employer) are separate, explicit lists.
 *
 * ⚠️ NO PLACEHOLDERS, UNLIKE buildParsePrompt. The builder asks for "[X%]" so a person fills it in the
 * editor; an employer document is rendered and downloaded as it is, so a bracket reaches a recruiter.
 * findPlaceholders is the server-side backstop — this prompt is the first line.
 *
 * ⚠️ THE EMPLOYER'S NAME STAYS OUT. "Excited to bring my skills to Amazon" in a summary reads as a form
 * letter and, sent to a second company, as a mistake. What the candidate's own material already names —
 * an employer they really worked at, a product they used ("Amazon Web Services") — is their record and
 * stays as written; a blanket ban would make the model drop a real skill, which breaks ZERO-MISS.
 *
 * ⚠️ THE EMPLOYER DECIDES THE FORMAT, NOT THE CANDIDATE'S SENIORITY (2026-09-14). Nexplore, a Moroccan public
 * agency and a Ghanaian job site all came back in prod with the exec_pro family first, because the design brief
 * weighed seniority and the region fell back to 'generic' for .ma/.com hosts. The research's `conventions` (photo,
 * length, personal details, date format, CV format, employer type, ATS) now feed three places: the HIRING
 * CONVENTIONS facts, the FORMATTING rules (docFormattingBlock) and the design brief's order of weight, where
 * seniority is a minor tie-breaker. `conventions` defaults to research.conventions; without any, the prompt reads
 * exactly as before apart from that brief.
 *
 * ⚠️ AND THE DOCUMENT IS WRITTEN FOR THE COUNTRY IT IS GOING TO (2026-09-16) — see docPlaybookOf. Where the
 * research found nothing, the prompt used to carry no formatting instruction at all and the model fell back to
 * Anglo habits for every country on earth: "Month YYYY", no rule about projects, "as the material has it"
 * detail. cvPlaybook's block now sits between FORMATTING and WRITTEN FOR — the country's projects, experience
 * depth, bullets per role, metrics, summary, skills, section order and dates — and the same merged answer
 * drives the page mode, the date rule, the personal-details slot and the detail level. FORMAT AND EMPHASIS
 * ONLY, like every block here: a convention the candidate's material cannot meet is simply not met.
 *
 * ⚠️ THE TOP LINES ARE WRITTEN FOR THE SECTOR (2026-09-15) — see docTopLinesBlock: the title in the candidate's
 * real roles phrased for the employer's sector, the summary opening in the shape "<real role> for <sector> — <the
 * two or three real strengths that matter here>" with a worked example that is never the candidate's own words,
 * the bullets in the employer's vocabulary, and the detail level from the conventions (one page → ≤3 highlights
 * per role and a ≤3-sentence summary). generateEmployerDoc MEASURES the answer against the base résumé
 * (docSamenessOf: the summary, its first sentence, the title, the experience bullets) and sends one corrective
 * pass when it came back generic — the prompt is the first line, not the only one.
 *
 * Output = the resume JSON schema buildParsePrompt uses (so every template renders it) PLUS a `design`
 * object that generateEmployerDoc strips before storing: the payload is the resume and nothing else.
 */
function buildEmployerDocPrompt({ name, email, phone, location, rawText, uploadedResumeContext, job, research, familyBrief, country, conventions, playbook } = {}) {
    const j = job && typeof job === 'object' ? job : {};
    const company = String(j.company || '').replace(/\s+/g, ' ').trim().slice(0, 160) || 'this employer';
    const website = String(j.website || '').replace(/\s+/g, '').trim().slice(0, 300);
    const place = String(country || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const title = String(j.title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const description = String(j.description || '').slice(0, 12000);
    const link = String(j.url || '').trim().slice(0, 500);

    let researchBlock = '';
    try {
        const { researchPromptBlock } = require('../services/employerResearch');
        researchBlock = research ? researchPromptBlock(research, company) : '';
    } catch (e) { console.warn('[resumeBuilder] research block unavailable:', e.message); }
    const rawConventions = conventions !== undefined ? conventions : conventionsOfResearch(research);
    // How a CV is written where this application is going, merged with what the research found about THIS
    // employer. generateEmployerDoc resolves it once and passes it in — the design ranking and the
    // personal-details backstop then read the very same object; a direct caller (a test) may leave it out and
    // this resolves the identical answer itself.
    const plan = playbook && playbook.conv !== undefined ? playbook : docPlaybookOf({ country, website: j.website, conventions: rawConventions, research });
    const conv = plan.conv;
    const book = plan.playbook;
    // The facts block is employerResearch's to judge (it may carry notes this lane's enums do not read); the rules are ours.
    // ⚠️ IT IS FED plan.facts, NOT THE RAW CONVENTIONS. That block gives ORDERS about personal details, length,
    // dates and CV format, and a value cvPlaybook demoted (researched for another country's hiring) would order
    // the opposite of the country block twenty lines below it — see docPlaybookOf. Everything else it prints is
    // untouched: the HQ, where the employer hires, its type, sector, ATS, register and notes are facts.
    const conventionsBlock = plan.facts ? conventionsBlockForDoc(plan.facts, company) : '';
    // ⚠️ FORMATTING speaks ONLY for what the research found about this employer — its header says so, and a
    // country generalisation printed under it would be a lie the model repeats. Everything the research did not
    // answer is the country block's to say (docPlaybookOf), so between them each rule is stated exactly once.
    const formattingBlock = plan.researched ? docFormattingBlock(plan.researched, company) : '';
    const playbookBlock = docPlaybookBlock(book, company);
    // ⚠️ India lists EVERY project (cvPlaybook content.projects === 'all'): the schema's project fields, the
    // writing rule and the ZERO-MISS rule below all widen for it, or the prompt would ask for nine entries in
    // one block and quietly allow them to be merged in the next.
    const everyProject = !!(book && book.content && book.content.projects === 'all');
    // The sector the top lines are written for, and the block that says how (docTopLinesBlock) — the same
    // docSectorOf reading the corrective pass and the sameness guard use. Its DETAIL LEVEL reads the merged
    // view, so a one-page country and a one-page employer are told the same thing.
    const sector = docSectorOf(research, rawConventions);
    const topLinesBlock = docTopLinesBlock({ company, sector, conventions: conv });
    const onePage = !!(conv && conv.cv.length === 'one_page');
    const avoidPersonal = !!(conv && conv.cv.personalDetails === 'avoid');
    const personalSlot = avoidPersonal ? 'always an empty string for this employer' : 'ONLY if the material states it, else empty string';
    // The mode INSTRUCTION is docPageModeOf's rule in words: what the model is asked to write is what the lane
    // stores (a country's "two pages are normal" is room, not an order — see docPageModeOf).
    const modeRule = conv && conv.cv.length === 'one_page'
        ? '"onepage" — one page is the norm where this application is going.'
        : plan.researched && plan.researched.cv.length === 'two_pages'
            ? '"a4" — two pages are normal for this employer.'
            : '"onepage" where one page is the norm or the real material is concise; "a4" when the candidate\'s real material needs the room.';

    const uploadedBlock = uploadedResumeContext
        ? `\n=== THE CANDIDATE'S UPLOADED RESUME (also their own material — MERGE it with the text above; capture every job, project, skill, certification and education entry from BOTH, never invent anything) ===\n${uploadedResumeContext}\n`
        : '';

    const roleBlock = (title || description || link)
        ? `
=== THE ROLE AT ${company} ===
${title ? `Title:   ${title}\n` : ''}${link ? `Link:    ${link}\n` : ''}${description ? `Posting text:\n---\n${description}\n---\n` : ''}Use the role to decide emphasis and vocabulary: what it asks for that the candidate genuinely has comes first, in its words where it is the same thing. What it asks for that the candidate does not have stays out — do not soften it, do not imply it.
`
        : `
No specific posting was given: write for the roles at ${company} that match the candidate's real experience.
`;

    return `You are an expert resume writer and a senior recruiter who hires for ${company}. Rewrite the candidate's resume so it reads as written for ${company}, and return ONE JSON object — NO markdown, NO code fences, NO commentary, ONLY the raw JSON.

=== CANDIDATE DETAILS ===
Full Name: ${name || ''}
Email:     ${email || ''}
Phone:     ${phone || ''}
Location:  ${location || ''}

=== THE CANDIDATE'S OWN MATERIAL — THE ONLY SOURCE OF TRUTH ===
Every fact in the resume you return must come from this material. Nothing else in this prompt is evidence about the candidate — not the employer research, not the role, not your own knowledge.
---
${rawText || ''}
---
${uploadedBlock}
=== THE EMPLOYER ===
Company: ${company}
${website ? `Website: ${website}   (identifies the company only — do not describe it)\n` : ''}${place ? `Applying in: ${place}\n` : ''}${roleBlock}
${researchBlock ? `${researchBlock}\n` : ''}${conventionsBlock ? `\n${conventionsBlock}\n` : ''}${formattingBlock ? `\n${formattingBlock}\n` : ''}${playbookBlock ? `\n${playbookBlock}\n` : ''}
${topLinesBlock}

=== WHAT YOU MAY CHANGE (this is a full rewrite for ${company}) ===
- Rewrite \`personal_info.title\` and \`summary\` for what ${company} needs from someone with THIS candidate's real background: its sector, its priorities, its vocabulary — exactly as WRITTEN FOR ${company} above says. A title or an opening sentence that would suit any employer is not a rewrite, and neither is the material's own opening with a word or two swapped.
- Rewrite the wording of every experience highlight and project bullet in the vocabulary ${company} uses — only where it describes the SAME thing the candidate did. Re-wording is not a licence to claim.
- Reorder the highlights inside each experience entry, the projects, and \`skills.technical\` / \`skills.soft\`, so what matters most to ${company} comes first.
- Condense highlights that are clearly irrelevant to ${company}: shorten them, or merge two minor ones into one line. Condense — never drop an entry: every experience entry and every education entry must still appear.${everyProject ? ' Two PROJECTS are never merged into one, however similar they look — see the country rules above.' : ''}
- Choose one-page or A4 (\`design.mode\` below).

=== WHAT YOU MUST NEVER DO ===
- NEVER invent or add any employer, job title, date, degree, certification, skill, tool, technology, metric, number, percentage, client, award or achievement that the candidate's own material does not state. A skill ${company} wants that the candidate never mentioned stays out.
- NEVER imply more years of experience, seniority or scope than the material states.
- NEVER write a placeholder or a bracket: no [X%], [N], [$X], [Insert metric], [Company Name], XX%. When the material has no number for an achievement, write the sentence without a number.
- NEVER address ${company}: its name must not appear in the title, the summary or a bullet as the company this resume is for. Where the candidate's own material already contains the name — an employer or school they were actually at, or a product they used — keep it exactly as they wrote it.
- NEVER state or imply facts about ${company} (its products, customers, mission, values, size or news). The resume is about the candidate only; anything you know about ${company} only decides emphasis, wording and design.
- Keep every employer name, job title, institution, degree and date as the material gives them (a standard degree abbreviation may be expanded, e.g. "BCA" → "Bachelor of Computer Applications (BCA)").

=== ⚠️ ZERO-MISS RULE ===
Tailoring never loses information. Every job, internship, freelance role, project, education entry (including school level: Class X / Class XII), grade, certification, spoken language and achievement in the material must appear in the JSON. When unsure whether something belongs, INCLUDE IT.${everyProject ? '\nAnd here every project is its OWN entry: nine projects in the material means nine entries in `projects`. Merging two of them is dropping one.' : ''}

=== WRITING RULES ===
- Summary: implied first person — never "I", "me", "my", the candidate's name, "he", "she" or "they". A tight paragraph of ${onePage ? 'at most 3 sentences (one page is the norm for this employer)' : '3-4 sentences'}, opening with the candidate's fit for ${company}'s sector (see WRITTEN FOR ${company}), then exactly 3 bullets; separate them with \\n and start each bullet with "• ". Wrap 3-6 genuinely important terms per sentence in **double asterisks** (technologies, domains, years of experience the material states). No clichés ("passionate", "go-getter", "team player", "proven track record").
- Experience highlights: one sentence each, at most 22 words, starting with a strong past-tense action verb, outcome first. Use a number ONLY when the material states that number.
- Projects: ${everyProject
        ? 'EVERY project the material contains gets its own entry — none merged, none summarised away, none left out. "title" is the project\'s own name; "type" is what kind of project it is, with the employer or client it ran for where the material names one; "about" is 1-2 sentences on what it is and the technology stack the material states for it; "role" is the candidate\'s role on it; "role_highlights" are 2-3 action-verb bullets on what they did. Never a project, client, technology or date the material does not contain.'
        : '"about" is 1-2 sentences on what the project is, from the material only; "role" is the candidate\'s role; "role_highlights" are 2-3 action-verb bullets.'}
- Dates: ${conv && conv.cv.dateFormat ? `${conv.cv.dateFormat}, as the rules above say,` : '"Month YYYY"'} or "Present"; a year alone is fine for education.
- Education "grade": exactly as written (e.g. "85.40%", "8.5 CGPA"), else "".
- personal_info.nationality and personal_info.date_of_birth: ${avoidPersonal ? 'always "" for this employer, even when the material states them (see the rules above).' : 'ONLY if the material states them, else "".'}
- Write in the same language as the candidate's material.

=== DESIGN — how well each layout family fits the way ${company} hires ===
${familyBrief || localFamilyBrief()}
- Score EVERY family id above from 0 to 100, EMPLOYER FIRST — in this order of weight:
  1. the CV conventions where the candidate is applying${formattingBlock && playbookBlock ? ' (the FORMATTING and the country rules above)' : formattingBlock ? ' (the conventions and FORMATTING above)' : playbookBlock ? ' (the country rules above)' : ''}: whether a photo is expected, optional or avoided (expected in Germany, Austria and Switzerland; common across much of continental Europe, the Middle East and Latin America; unusual in the US, the UK, Ireland, Canada and Australia), one page or two, personal details, and the CV format (tabular, Europass, plain for screening software). A family that breaks a convention scores low however good it looks;
  2. ${company}'s type and sector: public bodies, universities, banks and law firms read conservative layouts; startups and technology companies modern ones; agencies and media visual ones;
  3. its screening software: favour ATS-safe single-column families when ${company} is known to use an applicant tracking system, or is a large employer where they are near-universal (the US, the UK, India);
  4. only then the candidate's seniority — a minor tie-breaker, never the reason a family leads.
- Give each family a "reason" of at most 90 characters, written to the candidate, e.g. "Plain layout that large banks' screening software reads reliably".
- "mode": ${modeRule}
- "tone": at most 40 characters naming the look that suits ${company}, e.g. "Conservative enterprise".
- "headline": at most 120 characters, in plain words, telling the candidate WHY your top-scored family leads for ${company} — the convention or employer trait that decides it, e.g. "Swiss employers expect a tabular CV with a photo slot — this design leads" or "Large US banks screen with ATS software — this plain layout leads". Say nothing about ${company} that the research above does not support.

=== REQUIRED OUTPUT SCHEMA (return ONLY this JSON) ===
{
  "personal_info": {
    "full_name": "",
    "email": "",
    "phone": "",
    "location": "",
    "linkedin_url": "",
    "portfolio_url": "",
    "title": "The candidate's real role phrased for ${sector ? docSectorPhraseOf(sector) : `the field ${company} hires in`} (see WRITTEN FOR ${company}), supported by the material — never the company's name",
    "nationality": "${personalSlot}",
    "date_of_birth": "${personalSlot}"
  },
  "summary": "${onePage ? 'At most 3-sentence' : '3-4 sentence'} implied-first-person paragraph whose first sentence states the fit for ${company}'s sector, then exactly 3 bullets using the bullet prefix and newline separator",
  "experience": [
    { "company": "", "role": "", "location": "", "start_date": "", "end_date": "", "highlights": ["Action-verb achievement, a number only when the material states it"] }
  ],
  "education": [
    { "institution": "", "degree": "", "field_of_study": "", "end_date": "", "grade": "" }
  ],
  "projects": [
    ${everyProject
        ? '{ "title": "the project\'s own name", "type": "what kind of project it is — and the employer or client it ran for when the material names one", "link": "", "about": "1-2 sentences: what it is, and the technology stack the material states for it", "role": "the candidate\'s role on it", "role_highlights": ["2-3 bullets on what they did on it"] }'
        : '{ "title": "", "type": "", "link": "", "about": "", "role": "", "role_highlights": [""] }'}
  ],
  "skills": { "technical": [], "soft": [] },
  "certifications": [ { "name": "", "issuer": "", "year": "" } ],
  "languages": [ { "name": "", "level": "" } ],
  "achievements": [],
  "design": {
    "families": { "<familyId>": { "score": 0, "reason": "" } },
    "mode": "a4",
    "tone": "",
    "headline": ""
  }
}
Certifications, languages and achievements: ONLY those the material mentions; otherwise return an empty array [].${everyProject ? '\n`projects`: ONE entry per project in the material, in the order of importance the material gives them — never merged, never folded into another entry, never left out.' : ''}`;
}

// ── Placeholders: the backstop for the prompt's "no brackets" rule ──────────────────────────────────
// ⚠️ A PLACEHOLDER IN A STORED DOCUMENT IS A RECRUITER READING "[X%]". Employer documents are rendered
// and downloaded as they are — nobody fills a bracket in first — so the doc lane checks every string,
// asks the model once to rewrite without them, and removes whatever is still there. Never store brackets.
//
// ⚠️ CONSERVATIVE BY DESIGN, AND JUDGED ON THE WHOLE BRACKET. A placeholder is REMOVED, so a false positive
// silently deletes a real fact from a document the user paid for. The first version asked whether the
// inside CONTAINED a slot sign — any %, any X or N between non-letters, any slot word anywhere — so
// "reduced costs [by 30%]" lost its 30%, and "[company-wide]" or "[C++, N-Tier]" went the same way. A
// bracket counts now only when its inside IS a slot:
//   • a % with no digit anywhere in it: [X%], [% growth] — never [by 30%] or [100% remote];
//   • an X or an N standing in for the number — with a currency sign, a unit and the words after it:
//     [X], [$X], [XK], [$XX,XXX], [N+], [N users], [N engineers] (the last two are the BUILDER prompt's
//     own documented slots, so a base resume built there can carry them into this lane's source).
//     ⚠️ A LONE N TAKES AT MOST ONE WORD, AND NOT A ONE-LETTER ONE, because n is also a MATHEMATICIAN'S
//     variable: with two words allowed, "[n log n]" was a placeholder and the complexity note vanished
//     out of the bullet. One word of two letters or more keeps the prompt's own [N users] / [N engineers]
//     caught while [n log n], [n-1], [n^2] and [O(n log n)] stay the candidate's text. X keeps its two
//     words: no notation spells anything with a lone x, so there is nothing there to protect;
//   • a slot word that makes up the bracket, with at most one word in front: [Date], [Company Name],
//     [Key Metric], [Number] — or that opens it: [Number of users];
//   • an instruction, as a whole first word: [Insert Key Functionality], [Your Name], [Add metric]
//     ([Add-ons], [Enterprise], [Insertion sort] are text).
// "[C#]", "[2019]", "Python [advanced]", "[Remote]", "[React Native]" or a markdown link's "[GitHub]" are
// the candidate's text and are left alone. A long bracket (41-80 chars) counts only as an instruction.
const PLACEHOLDER_INSTRUCTION = /^(?:insert|add|enter|include|your|specify|describe|mention)(?=[\s:]|$)/i;
const PLACEHOLDER_LONE_XN = /^[$€£₹]?\s?(?:x{1,4}(?:[,.]x{1,3})*\s?[%kmb+]?(?:\s+[a-z]+){0,2}|n\s?[%+]?(?:\s+[a-z]{2,})?)$/i;
const PLACEHOLDER_SLOT_PHRASE = /^(?:[a-z]+\s+)?(?:company|name|date|number|metrics?|amount|percentage|placeholder)(?:\s+name)?$|^(?:number|amount|percentage|name|date)\s+of(?:\s|$)/i;

function isPlaceholderInside(inside) {
    const s = String(inside || '').trim();
    if (!s || s.length > 80) return false;
    if (s.length > 40) return PLACEHOLDER_INSTRUCTION.test(s);
    return (s.includes('%') && !/\d/.test(s))
        || PLACEHOLDER_LONE_XN.test(s)
        || PLACEHOLDER_SLOT_PHRASE.test(s)
        || PLACEHOLDER_INSTRUCTION.test(s);
}

// Each token optionally takes a dangling "by " before it, bold markers around it, a currency sign in
// front and a unit behind — so "by **[X%]**" or "$[X]M" goes as ONE piece and leaves no "$M" behind.
const bracketTokenRe = () => /(\bby\s+)?(\*\*)?([$€£₹]\s?)?\[([^\]\n]{1,80})\](\s?%|\+|[kKmMbB](?![A-Za-z0-9]))?(\*\*)?/g;
const barePercentRe = () => /(\bby\s+)?(\*\*)?(?<![A-Za-z0-9])[Xx]{1,3}\s?%(\*\*)?/g;
const bareMoneyRe = () => /(\bby\s+)?(\*\*)?\$\s?X{1,3}(?:[,.]X{1,3})*[KMB]?(?![A-Za-z0-9])(\*\*)?/g;

/** Every string in a value, with a path for logs. */
function eachString(value, fn, at = '') {
    if (typeof value === 'string') { fn(value, at); return; }
    if (Array.isArray(value)) { value.forEach((v, i) => eachString(v, fn, `${at}[${i}]`)); return; }
    if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) eachString(v, fn, at ? `${at}.${k}` : k);
    }
}

/**
 * Placeholder tokens left in a resume (bracket slots, bare XX% / X%, bare $X), de-duplicated, in the
 * order found. [] when clean. Never throws.
 */
function findPlaceholders(resumeData) {
    const found = [];
    try {
        eachString(resumeData, (s) => {
            for (const m of s.matchAll(bracketTokenRe())) if (isPlaceholderInside(m[4])) found.push(`[${m[4]}]`);
            for (const m of s.matchAll(barePercentRe())) found.push(m[0].replace(/^by\s+/i, '').replace(/\*\*/g, '').trim());
            for (const m of s.matchAll(bareMoneyRe())) found.push(m[0].replace(/^by\s+/i, '').replace(/\*\*/g, '').trim());
        });
    } catch { /* a check that crashes must not fail a build */ }
    return [...new Set(found)];
}

/** One string with its placeholder tokens removed and the sentence tidied around the hole. */
function stripPlaceholderText(s) {
    if (typeof s !== 'string' || !s) return s;
    // Bold markers go only as a PAIR — a token at the end of a bolded phrase must not take the phrase's
    // closing ** with it and leave an unbalanced one behind.
    const keepBold = (b1, b2) => (b1 && !b2 ? b1 : '') + (b2 && !b1 ? b2 : '');
    let out = s
        .replace(bracketTokenRe(), (m, by, b1, cur, inside, unit, b2) => (isPlaceholderInside(inside) ? keepBold(b1, b2) : m))
        .replace(barePercentRe(), (m, by, b1, b2) => keepBold(b1, b2))
        .replace(bareMoneyRe(), (m, by, b1, b2) => keepBold(b1, b2));
    if (out === s) return s;
    // ⚠️ Every tidy rule below is anchored on WHITESPACE, because resumes are full of technical text that
    // looks like litter: "**Node.js** **React**" (adjacent bold), "render()" (empty parens), "std::vector".
    // Only what a removed token can leave behind — a space-bounded hole — is cleaned.
    out = out
        .replace(/(^|[ \t(])\*\*[ \t]*\*\*(?=$|[\s,.;:!?)])/gm, '$1')   // an empty bold pair left in a hole
        .replace(/(^|[ \t])\([ \t]*\)/gm, '$1')                         // an empty "( )" left in a hole
        .replace(/[ \t]+\*\*(?=$|[\s,.;:!?)])/gm, '**')                 // a kept CLOSING marker hugs its phrase again
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/[ \t]+([,.;!?)])/g, '$1')
        .replace(/([,;])(?:[ \t]*[,;])+/g, '$1')
        .replace(/[,;]([.!?])/g, '$1')
        .replace(/^[ \t]*[,;][ \t]*/gm, '')
        .replace(/[ \t]+$/gm, '')
        .trim();
    return out;
}

/**
 * The resume with every placeholder removed (a new value; the input is not mutated). An array item that
 * is left empty — a highlight that WAS a placeholder — is dropped rather than rendered as a blank bullet.
 */
function stripPlaceholders(value) {
    if (typeof value === 'string') return stripPlaceholderText(value);
    if (Array.isArray(value)) {
        return value
            .map((v) => stripPlaceholders(v))
            .filter((v, i) => !(typeof v === 'string' && typeof value[i] === 'string' && v !== value[i] && !v.replace(/[•\-–—\s.,;:]/g, '')));
    }
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = stripPlaceholders(v);
        return out;
    }
    return value;
}

// ── The employer's name, where a rewrite for that employer must not put it ─────────────────────────
const LEGAL_SUFFIX_WORD = /^(?:inc|llc|llp|ltd|limited|gmbh|mbh|ag|sa|sas|sarl|bv|nv|plc|corp|corporation|co|company|pvt|private|pte|srl|spa|oy|oyj|ab|as|asa|aps|kg|kgaa|ug|se|group|holdings?)\.?$/i;

/** "Amazon.com, Inc." → "Amazon.com"; '' when what is left is too short to test safely. */
function employerCoreName(company) {
    const words = String(company || '').replace(/\([^)]*\)/g, ' ').split(/[\s,]+/).filter(Boolean);
    while (words.length > 1 && LEGAL_SUFFIX_WORD.test(words[words.length - 1])) words.pop();
    const core = words.join(' ').replace(/[.,;:]+$/, '').trim();
    return core.length >= 3 ? core : '';
}

/**
 * Where the rewrite put the target employer's name into the TITLE or the SUMMARY, when the candidate's
 * own material never names that employer (so it cannot be their record). [] when clean.
 *
 * ⚠️ DELIBERATELY NARROW, because a false alarm costs a second AI call: the match is case-sensitive (a
 * proper noun, so "target" is not Target), it skips a name followed by a capitalised word (a PRODUCT —
 * "Amazon Web Services", "Microsoft Excel", "Google Cloud" are skills, not a letter to the employer),
 * and the bullets are not searched at all. It only triggers the one corrective pass; it never edits.
 */
function employerNameLeaks(resumeData, company, sourceText) {
    const core = employerCoreName(company);
    if (!core) return [];
    const esc = core.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?:^|[^A-Za-z0-9])${esc}(?![A-Za-z0-9])`, 'i').test(String(sourceText || ''))) return [];
    const re = new RegExp(`(?:^|[^A-Za-z0-9])${esc}(?![A-Za-z0-9])(?!\\s+[A-Z0-9])`);
    const pi = resumeData && resumeData.personal_info && typeof resumeData.personal_info === 'object' ? resumeData.personal_info : {};
    const where = [];
    if (typeof pi.title === 'string' && re.test(pi.title)) where.push('personal_info.title');
    if (typeof resumeData.summary === 'string' && re.test(resumeData.summary)) where.push('summary');
    return where;
}

// ── Sameness: did the rewrite actually write for THIS employer? ─────────────────────────────────────
// ⚠️ THE MODEL SAYS "REWRITTEN FOR AMAZON" AND HANDS BACK THE BASE RÉSUMÉ. Every employer's document came
// back with the candidate's own title and the same generic opening (2026-09-15), and nothing checked. The lane
// now measures what a recruiter reads against the base material the prompt was given — the narrative Home sends
// as rawText (resumeScorer.flattenResume: "Current title: …", a SUMMARY section, EXPERIENCE bullets) and the
// parsed upload (resume_metadata: summary, job_titles) — and a generic answer costs ONE corrective pass, the
// same pass placeholders and name leaks already share. Wording is measured, never facts: a summary that keeps
// every fact and says them for the sector scores LOW here, which is exactly the answer wanted.
//
// ⚠️ FOUR READINGS, BECAUSE TWO WERE NOT ENOUGH (2026-09-15, later that day). The Deutsche Bahn document in prod
// passed the first guard — summary 0.73 against a 0.8 line, the title rewritten — and still read as the base
// résumé: the summary kept the base's opening word for word up to the sector list, and the bullets were "Led" →
// "Directed". So the summary line is 0.6; the FIRST SENTENCE is measured on its own (it is the line the recruiter
// reads — half its words the base's is the base's, 0.5); and the experience highlights are counted: when six in
// ten are a base bullet near-verbatim (> 0.9 each), the bullets were not rewritten whatever the summary says. The
// title rule is unchanged. Each measure is null where either side lacks the material, and null never counts.

const DOC_SUMMARY_SAME_MAX = 0.6;        // token-Jaccard above this = the base summary in different clothes
const DOC_OPENING_SAME_MAX = 0.5;        // …the base's first sentence, the line a recruiter reads
const DOC_HIGHLIGHT_SAME_MIN = 0.9;      // a highlight this similar to a base bullet IS that bullet
const DOC_HIGHLIGHTS_SAME_SHARE = 0.6;   // this share of unchanged highlights = the bullets were not rewritten
const DOC_STOPWORD_MAX_LEN = 3;          // "the", "and", "for", "with"… carry no sector; dropped before comparing

/** The comparable words of a text: lower-cased, punctuation and bold markers gone, short stopwords dropped. */
function docTokensOf(s) {
    const out = new Set();
    for (const m of String(s || '').toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) if (m[0].length > DOC_STOPWORD_MAX_LEN) out.add(m[0]);
    return out;
}

/**
 * Token-Jaccard similarity of two texts, 0..1: |A ∩ B| / |A ∪ B| over docTokensOf. Two empty texts are the same
 * text (1); one empty text shares nothing (0). A summary re-worded for a sector scores well under 0.6 against its
 * base (the guard's line); the base summary with a sentence moved scores above 0.9 — see scripts/test-employer-doc-lane.js.
 */
function tokenJaccard(a, b) {
    const A = docTokensOf(a);
    const B = docTokensOf(b);
    if (!A.size && !B.size) return 1;
    if (!A.size || !B.size) return 0;
    let both = 0;
    for (const t of A) if (B.has(t)) both++;
    return both / (A.size + B.size - both);
}

/** A title as compared: case, punctuation and spacing folded — "Backend Engineer" is "backend-engineer". */
const docTitleKeyOf = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * The paragraph of a summary — what stands before its "• " bullets, whether they sit on their own lines (a draft)
 * or inline (the narrative flattens the base summary to one line) — as compared. '' for none. The opening is read
 * from this; the summary reading takes the WHOLE summary, bullets included (docSummaryTextOf).
 */
function docSummaryParagraphOf(s) {
    return String(s || '').split('\n').filter((l) => !/^\s*•/.test(l)).join(' ').split('•')[0].replace(/\s+/g, ' ').trim();
}

/** The whole summary as compared — paragraph and bullets, on one line. '' for none. */
const docSummaryTextOf = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * The first sentence of a paragraph, as compared: bold markers off, cut at ". " / "! " / "? " before a capital, a digit
 * or an opening quote. A first "sentence" of fewer than five comparable words ("Project Manager." — a narrative that
 * opens with the title) takes the next one with it, so a stub never stands in for the opening. '' for no text.
 */
function docFirstSentenceOf(text) {
    const s = String(text || '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    const parts = s.split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}"“(])/u);
    let out = parts[0];
    for (let i = 1; i < parts.length && docTokensOf(out).size < 5; i++) out += ` ${parts[i]}`;
    return out;
}

/**
 * The base material's own lines: { title, titles, summary, highlights } — the narrative's "Current title:" line, its
 * SUMMARY section and the EXPERIENCE section's "- " bullets, the upload's job_titles and summary (experience_summary as
 * its fallback). Each null / [] when the material does not carry it, so a check with nothing to compare against is
 * skipped, never guessed. Never throws.
 */
function baseTopLinesOf(rawText, uploadedResumeContext) {
    const out = { title: null, titles: [], summary: null, highlights: [] };
    const text = String(rawText || '');
    const t = text.match(/^Current title:\s*(.+?)\s*$/m);
    if (t) out.title = t[1].replace(/\s+/g, ' ');
    const lines = text.split('\n');
    const isHeader = (l) => /^[A-Z][A-Z &/]+$/.test(l);
    const at = lines.findIndex((l) => l.trim() === 'SUMMARY');
    if (at >= 0) {
        const body = [];
        for (let i = at + 1; i < lines.length; i++) {
            const l = lines[i].trim();
            if (!l || isHeader(l)) break;              // a blank line or the next section header ends it
            body.push(l);
        }
        if (body.length) out.summary = body.join(' ');
    }
    // The experience bullets alone — a project's "- " lines describe the project, and the guard counts experience.
    const exp = lines.findIndex((l) => l.trim() === 'EXPERIENCE');
    if (exp >= 0) {
        for (let i = exp + 1; i < lines.length; i++) {
            const l = lines[i].trim();
            if (isHeader(l)) break;                     // the next section header ends it
            if (/^[-•]\s+\S/.test(l)) out.highlights.push(l.replace(/^[-•]\s+/, ''));
        }
    }
    try {
        const up = uploadedResumeContext ? JSON.parse(uploadedResumeContext) : null;
        if (up && typeof up === 'object' && !Array.isArray(up)) {
            if (Array.isArray(up.job_titles)) for (const jt of up.job_titles) if (typeof jt === 'string' && jt.trim()) out.titles.push(jt.trim());
            if (!out.summary) {
                const s = [up.summary, up.experience_summary].find((v) => typeof v === 'string' && v.trim());
                if (s) out.summary = s.replace(/\s+/g, ' ').trim();
            }
        }
    } catch { /* the upload context is JSON the prompt reads as text; unreadable here just means no upload lines */ }
    if (out.title) out.titles.unshift(out.title);
    return out;
}

/**
 * How generic a draft is against the base material:
 * { summarySim, openingSim, openings, titleUnchanged, sectorKnown, highlights, generic }.
 *   summarySim     — tokenJaccard of the draft's WHOLE summary and the base's (paragraph and bullets: the recruiter's
 *                    summary box; the prod pair measures 0.73 this way), or null when either side has none;
 *   openingSim     — tokenJaccard of the FIRST SENTENCE of each paragraph (docSummaryParagraphOf → docFirstSentenceOf),
 *                    or null; `openings` carries the two sentences ({ base, draft }) for the corrective pass to quote;
 *   titleUnchanged — the draft's title is, folded, one of the base titles (the narrative's current title, the
 *                    upload's job_titles); false with no title on either side;
 *   highlights     — { unchanged, total, share }: of the draft's experience highlights, how many are a base bullet
 *                    near-verbatim (tokenJaccard > DOC_HIGHLIGHT_SAME_MIN with any base bullet) — null when either
 *                    side has none;
 *   generic        — summarySim > DOC_SUMMARY_SAME_MAX, or openingSim > DOC_OPENING_SAME_MAX, or the sector is known
 *                    AND the title is unchanged, or highlights.share ≥ DOC_HIGHLIGHTS_SAME_SHARE. Without a known
 *                    sector an unchanged title is not evidence: there was nothing to phrase it for.
 */
function docSamenessOf(draft, base, sector) {
    const b = base && typeof base === 'object' ? base : { title: null, titles: [], summary: null, highlights: [] };
    const pi = draft && draft.personal_info && typeof draft.personal_info === 'object' ? draft.personal_info : {};
    const draftSummary = docSummaryTextOf(draft && draft.summary);
    const baseSummary = docSummaryTextOf(b.summary);
    const summarySim = draftSummary && baseSummary ? tokenJaccard(draftSummary, baseSummary) : null;
    const openings = {
        base: summarySim == null ? '' : docFirstSentenceOf(docSummaryParagraphOf(b.summary)),
        draft: summarySim == null ? '' : docFirstSentenceOf(docSummaryParagraphOf(draft && draft.summary)),
    };
    const openingSim = summarySim == null ? null : tokenJaccard(openings.draft, openings.base);
    const key = docTitleKeyOf(pi.title);
    const titleUnchanged = !!key && (b.titles || []).some((t) => docTitleKeyOf(t) === key);
    const sectorKnown = !!sector;
    const draftHighlights = [];
    for (const e of Array.isArray(draft && draft.experience) ? draft.experience : []) {
        for (const h of Array.isArray(e && e.highlights) ? e.highlights : []) if (typeof h === 'string' && h.trim()) draftHighlights.push(h);
    }
    const baseHighlights = Array.isArray(b.highlights) ? b.highlights : [];
    let highlights = null;
    if (draftHighlights.length && baseHighlights.length) {
        const unchanged = draftHighlights.filter((h) => baseHighlights.some((bh) => tokenJaccard(h, bh) > DOC_HIGHLIGHT_SAME_MIN)).length;
        highlights = { unchanged, total: draftHighlights.length, share: unchanged / draftHighlights.length };
    }
    const generic = (summarySim != null && summarySim > DOC_SUMMARY_SAME_MAX)
        || (openingSim != null && openingSim > DOC_OPENING_SAME_MAX)
        || (sectorKnown && titleUnchanged)
        || (highlights != null && highlights.share >= DOC_HIGHLIGHTS_SAME_SHARE);
    return { summarySim, openingSim, openings, titleUnchanged, sectorKnown, highlights, generic };
}

/**
 * "summary similarity 0.93, title unchanged" — one log phrase for before and after. The opening and the bullets are
 * named only when they are over their line, so the phrase says what made it generic and no more.
 */
function docSamenessText(s) {
    if (!s) return 'not measured';
    const parts = [`summary similarity ${s.summarySim == null ? 'n/a' : s.summarySim.toFixed(2)}`, `title ${s.titleUnchanged ? 'unchanged' : 'rewritten'}`];
    if (s.openingSim != null && s.openingSim > DOC_OPENING_SAME_MAX) parts.push(`opening similarity ${s.openingSim.toFixed(2)}`);
    if (s.highlights && s.highlights.share >= DOC_HIGHLIGHTS_SAME_SHARE) parts.push(`${s.highlights.unchanged}/${s.highlights.total} highlights unchanged`);
    return parts.join(', ');
}

// ══════════════════════════════════════════════════════════════════════════════
// ROUTE HANDLERS
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/resume-builder/generate-ai
async function generateAI(req, res) {
    // Home's employer documents are their own lane: stored per employer, never in user_resumes — see
    // generateEmployerDoc. Everything below this line is the builder lane, unchanged.
    if (req.body && req.body.saveTo === 'employer_doc') return generateEmployerDoc(req, res);
    const userId = req.user.id;
    const startedAt = Date.now();   // the build's AI clock starts here — see RESUME_AI_DEADLINE_MS
    // ⚠️ Set the moment the payment step BEGINS. The catch says "Nothing was charged" for an AI failure only while
    // this is false: that sentence is true today because every AI call runs before the charge, and this flag keeps
    // it true by CHECK rather than by convention — an AI call added after the charge falls to the plain 500.
    let paymentBegun = false;
    const { name, email, phone, location, rawText, includeUploadedResume, isRegenerate, job } = req.body;
    // ⚠️ coveredOnly: Home sends true for a build it AUTO-started. Its gate answer is a snapshot taken
    // seconds before this request; without this flag, a build whose last plan unit was spent in between
    // (another device, another build) would silently fall through to the legacy-credits lane and take
    // 2 credits nobody agreed to. With it, only plan / free / pass / cache may pay, or this is a 402.
    // false is sent only when the user chose to build although the plan could not be read (there is no credit dialog any more).
    const coveredOnly = !!(req.body && req.body.coveredOnly === true);

    if (!rawText || rawText.trim().length < 20) {
        return res.status(400).json({ error: 'Please provide more detail about your experience.', reason: 'no_resume' });
    }

    try {
        const report = makeReporter(req);
        const passEmployer = (job && (job.company || '').trim()) || null;
        const env = downloads.envOf(req);
        const readUploaded = (() => {
            let once = null;
            return () => (once = once || (includeUploadedResume ? uploadedResumeContextFor(userId) : Promise.resolve('')));
        })();

        // ── THE PER-EMPLOYER CACHE — read BEFORE every gate that consumes, reserves or binds ─────────
        // ⚠️ A HIT IS FREE OR THIS IS A BILLING BUG WITH A CACHE ATTACHED. It returns before the regen
        // lane, before canConsumeMany and before passCoversGeneration (which BINDS a pass when quota is
        // gone), so a hit spends nothing, reserves nothing, calls no AI and leaves regen_count alone.
        // ⚠️ A REGENERATE NEVER READS IT: "give me a different one" answered with the stored one is the
        // regenerate button not working — and it would skip the regen ledger the free lane relies on.
        // The fingerprint is every input the prompt sees, so an edit anywhere is a miss, never a stale hit.
        // ⚠️ generationFingerprint is shared with generationGate — see its header before changing inputs.
        let cacheFp = null;
        if (passEmployer) {
            cacheFp = await generationFingerprint(userId, { rawText, includeUploadedResume, job, env, readUploaded });
            if (cacheFp && !isRegenerate) {
                const hit = await employerDocs.get(userId, 'resume', passEmployer, cacheFp, env);
                const cachedResume = hit && hit.payload && hit.payload.personal_info ? hit.payload : null;
                if (cachedResume) {
                    await report('cached', `Found your ${passEmployer} resume`, 90);
                    if (name)     cachedResume.personal_info.full_name = name;
                    if (email)    cachedResume.personal_info.email     = email;
                    if (phone)    cachedResume.personal_info.phone     = phone;
                    if (location) cachedResume.personal_info.location  = location;
                    await ensureResumeTable();
                    await snapshotBaseBeforeTailoring(userId, env);
                    await saveResumeRow(userId, cachedResume, downloads.employerKeyOf(passEmployer));
                    console.log(`[resumeBuilder] cache hit for "${passEmployer}" — no AI call, nothing charged`);
                    return res.json({ success: true, resumeData: cachedResume, cached: true, tailoredFor: passEmployer });
                }
            }
        }

        // ── Regenerate is its OWN lane, because the free plan's quota is 1 resume/30 days: the
        // first build consumes it, so "regenerate once free" can only be true if that one
        // regeneration BYPASSES the quota gate. Paid plans regenerate through their quota as a
        // normal generation. The count lives on user_resumes and resets on every fresh build.
        const sub = await entitlements.activeSubscription(userId).catch(() => null);
        let freeRegen = false;
        if (isRegenerate && !sub) {
            await ensureResumeTable();
            const rrow = await dbConfig.get('SELECT regen_count FROM user_resumes WHERE user_id = $1', [userId]);
            if (!rrow) return res.status(404).json({ error: 'No resume to regenerate yet — generate one first.', reason: 'no_resume' });
            if ((rrow.regen_count || 0) >= 1) {
                return res.status(403).json({
                    error: 'Your free plan includes one regeneration, and you have used it. Upgrade to keep refining your resume.',
                    reason: 'regen_limit',
                });
            }
            freeRegen = true;
        }
        // GATE — plan/trial quota first, legacy credits fallback; deduct on success only (below).
        //
        // A single-employer pass includes ONE AI resume for that company.
        // ⚠️ THE PLAN IS ASKED FIRST AND THE PASS IS THE FALLBACK. Burning someone's one-off while
        // their plan or free allowance could have paid destroys what they bought and gives nothing
        // back. `boundOnly` says exactly that: while quota remains only a pass ALREADY bound to
        // this employer may pay (they bought it for precisely this); once quota is gone the pass is
        // consulted in full — and that call RESERVES it, so two generations for two companies
        // inside one AI minute cannot both ride the same pass.
        // (passEmployer — job.company — is read at the top: the cache must key on this same string.)
        const quota = freeRegen ? { allowed: true } : await entitlements.canConsumeMany(userId, 'resume', 1, req);
        // Under coveredOnly the credits lane does not exist, so a quota that is "allowed" only through
        // credits is exhausted as far as this build is concerned — and the pass is consulted in full,
        // exactly as it is for a user with no quota at all (generationGate answers the same way).
        const quotaCovers = !!quota.allowed && !(coveredOnly && quota.via === 'credits');
        const viaPass = (!freeRegen && passEmployer)
            ? await downloads.passCoversGeneration(userId, 'resume', passEmployer, req, { boundOnly: quota.allowed && quotaCovers }).catch(() => false)
            : false;
        const gate = (freeRegen || viaPass) ? { allowed: true } : quota;
        if (!gate.allowed) {
            return res.status(402).json({ error: gate.message, reason: 'quota_exhausted', creditsRequired: 1, remainingCredits: 0 });
        }
        if (coveredOnly && !freeRegen && !viaPass && !quotaCovers) {
            // Before ANY AI call: nothing is spent, reserved or generated.
            console.log(`[resumeBuilder] coveredOnly build for user ${userId} refused — only legacy credits could pay`);
            return res.status(402).json({
                error: 'Your plan does not cover this resume right now. Open Plans & Usage to continue.',
                reason: 'quota_exhausted',
            });
        }

        // ⚠️ A CLIENT THAT GAVE UP IS NOT A WAIVER (2026-09-14). This lane used to skip the charge when the app
        // disconnected before the answer ("never charge for an answer the client can no longer receive") while
        // STILL saving the resume into user_resumes. On a one-time allowance that is an endless one: the gate
        // only asks allow − used ≥ 1, a waived run spends nothing, so kill the app during the AI call, reopen
        // the builder, find the resume saved — and repeat. So a saved resume is a paid-for resume (settlePayment),
        // and a resume nothing will pay for is neither saved nor handed over. An employer build the user gave
        // up on is also cached once paid, so their retry is a free hit rather than a second charge.
        // The flag survives for the support log only. ⚠️ It listens on RES, not req: measured locally (Node 24,
        // this repo's Express 5), IncomingMessage 'close' has already fired by the time this line runs — it is
        // emitted once the body is consumed — so the old req listener never saw a real mid-AI abort. The waiver
        // was dead code; "fixing" its listener would have switched the endless allowance on.
        let clientGone = false;
        if (typeof res.writableEnded === 'boolean' && typeof res.on === 'function') {
            res.on('close', () => { if (!res.writableEnded) clientGone = true; });
        }
        const RESUME_CREDIT_COST = await getEventCost('resume_ai_generate');   // legacy display only
        const creditCheck = { hasCredits: true };   // gate above is authoritative now
        if (!creditCheck.hasCredits) {
            return res.status(402).json({ error: creditCheck.message, creditsRequired: RESUME_CREDIT_COST, creditsRemaining: creditCheck.remaining });
        }

        await report('reading', 'Reading what you gave us', 8);

        const urls = extractUrls(rawText);
        console.log(`[resumeBuilder] Found ${urls.length} URL(s):`, urls);

        if (urls.length) await report('links', `Opening ${urls.length === 1 ? 'the link' : `${urls.length} links`} you mentioned`, 14);
        const scrapedProjects = urls.length
            ? await Promise.all(urls.map(scrapePage))
            : [];

        // Point 5: optionally fold in the user's already-parsed uploaded resume.
        // ⚠️ The SAME read the cache fingerprint was taken over (readUploaded memoises it), so the
        // prompt and the stored document's signature cannot describe two different uploads.
        let uploadedResumeContext = '';
        if (includeUploadedResume) {
            await report('resume', 'Going through your experience', 22);
            uploadedResumeContext = await readUploaded();
        }

        // The posting the user is applying to, when they gave us one. A link with no text is
        // fetched here — ⚠️ deliberately NOT by putting it in rawText, where extractUrls would
        // treat it as one of the candidate's own project pages and describe it as their work.
        let jobTarget = null;
        if (job && (job.title || job.description || job.url)) {
            await report('posting', `Studying the ${job.company ? `${job.company} ` : ''}posting`, 30);
            jobTarget = {
                title: job.title || '',
                company: job.company || '',
                url: job.url || '',
                description: job.description || '',
            };
            if (!jobTarget.description && jobTarget.url) {
                try {
                    const page = await scrapePage(jobTarget.url);
                    jobTarget.description = [page?.title, page?.description].filter(Boolean).join('\n');
                } catch (e) { console.warn('[resumeBuilder] job page fetch failed:', e.message); }
            }
            console.log(`[resumeBuilder] tailoring for "${jobTarget.title || jobTarget.url}"`);
        }
        // A company with no posting still tailors, through the prompt's employer block. ⚠️ website
        // rides as its OWN field and is never copied into url — url is a posting, and is scraped.
        const promptJob = jobTarget
            ? { ...jobTarget, website: job.website || '' }
            : (passEmployer ? { company: passEmployer, website: job.website || '' } : null);
        if (!jobTarget && passEmployer) console.log(`[resumeBuilder] tailoring for employer "${passEmployer}" (no posting)`);

        const prompt = buildParsePrompt(name || '', email || '', phone || '', location || '', rawText, scrapedProjects, uploadedResumeContext, promptJob);

        // Up to 3 attempts: a malformed AI response is retried silently
        // (identical prompt — exactly what a user's manual "try again" did) instead of
        // surfacing a raw JSON SyntaxError to the user.
        // ⚠️ THESE ARE THE LANE'S OWN RETRIES — for an answer it could not parse. A busy, hung or truncating model is
        // aiText's business inside callGemini (a pause, the primary again, the fallbacks), and what it finally throws
        // (AiUnavailableError) is never retried here: a second chain on top of the first would overrun the build's
        // clock and ask a provider that just refused three models to do it all again.
        let resumeData = null;
        let lastErr = null;
        let writtenBy = null;   // the model that ACTUALLY answered — stored on the cached copy, never hashed
        await withResumeAi({ lane: 'resume_builder', report, startedAt }, async () => {
            for (let attempt = 1; attempt <= 3 && !resumeData; attempt++) {
                // ⚠️ The retry loop used to be silent, which is exactly the case that overran the old
                // client timeout: attempts two and three looked identical to the first from outside.
                await report(
                    attempt === 1 ? 'writing' : 'retry',
                    attempt === 1 ? (passEmployer ? `Writing your ${passEmployer} resume` : 'Writing your resume') : 'Taking another pass at it',
                    attempt === 1 ? 38 : 38 + attempt * 6,
                );
                try {
                    const { text, model } = await callGemini(prompt);
                    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
                    resumeData = JSON.parse(cleaned);
                    writtenBy = model;
                } catch (e) {
                    if (isAiUnavailable(e)) {
                        // Out of time before Google was even asked: what failed is the answer this loop rejected, not Google.
                        if (lastErr && Array.isArray(e.attempts) && !e.attempts.length) break;
                        throw e;
                    }
                    lastErr = e;
                    console.warn(`[resumeBuilder] generation attempt ${attempt}/3 failed: ${e.message}`);
                }
            }
        });
        if (!resumeData) {
            console.error('[resumeBuilder] all generation attempts failed:', lastErr?.message);
            throw new Error('AI_BAD_OUTPUT');
        }

        await report('shaping', 'Shaping the sections', 88);
        if (name)     resumeData.personal_info.full_name = name;
        if (email)    resumeData.personal_info.email     = email;
        if (phone)    resumeData.personal_info.phone     = phone;
        if (location) resumeData.personal_info.location  = location;

        resumeData._buildMethod = 'ai';

        // ── THE CHARGE, THE SAVE, THEN THE CACHE — one request at a time per user (withUsageLock) ─────
        // Deduct only now — the resume was actually generated. Pool + ledger via entitlements.
        // ⚠️ EVERY MONEY DECISION BELOW IS THIS REQUEST'S OWN ANSWER: claimGeneration's `charged`, and
        // consumeOnSuccess's `via`, its own chargeCredits result (`charge`) and the ledger row it wrote.
        // Credits used to be "verified" afterwards by counting history rows (creditsDeductedSince), which
        // cannot tell this deduction from an overlapping build's: a resume the user HAD paid for read as
        // unpaid, the cache write below was skipped, and the identical build was charged all over again
        // the next time. That window read survives only as the fallback for an entitlements that predates
        // `charge`, where the marks really are all there is.
        // ⚠️ THE LOCK IS WHAT MAKES canConsumeMany SAFE: it checks and never reserves, so a Generate here
        // and a Home doc build landing together both read "1 unit left" and both spent it. Under this key
        // — the same one the doc and letter lanes take — the second re-checks only after the first one's
        // ledger row exists, and loses cleanly. Taken AFTER the model returned: the lock IS a Postgres
        // transaction and must never be held across a 90-second AI call.
        // ⚠️ THE SAVE SITS UNDER IT TOO, because the free regeneration's only ledger is the regen_count
        // bump — so the cache may only be written once that bump has landed, and a second free regeneration
        // re-reads regen_count only after it has.
        // ⚠️ A SAVED RESUME IS A DELIVERED RESUME, SO NOTHING UNPAID IS SAVED OR HANDED OVER (2026-09-14). This
        // lane used to treat the response as the delivery and the charge as a cache concern: a charge that came
        // back 'none' (the last unit went to an overlapping build) or 'error' still saved the resume and
        // answered 200, uncached — so parallel Generates each got a resume for one unit, past a one-time
        // allowance. Now 'none' is a 402 quota_exhausted (the app opens Plans), 'error' or anything unrecognised
        // a 500, and in both nothing is saved, nothing is returned and whatever landed goes back
        // (giveBackDocCharges). Only a CACHE that will not take the write still costs just the cache.
        let charged = false;   // did something actually pay for this run — the save, the answer and the cache depend on it
        const paid = { passId: null, credits: null, ledgerId: null };   // what a refusal has to give back
        let refusal = null;    // { status, body } — decided under the lock, answered after it
        let savedRow = false;
        const allowanceUsedUp = () => ({ status: 402, body: {
            error: 'Your plan allowance was used up while this resume was being written. Open Plans & Usage to continue.',
            reason: 'quota_exhausted',
        } });

        /**
         * Settle what this run costs: the pass first, the plan/free unit second, and `refusal` when nothing
         * that is allowed to pay still can. Leaves `charged` true only for a payment it watched land.
         * The free regeneration bypassed the gate, so it must not be counted against the quota either —
         * its ledger is the regen_count bump in persistResume, re-read here under the lock.
         * ⚠️ Spend the PASS first when one covered this, and only fall back to the plan if the claim did
         * not land — two taps racing means the second must still be paid for by something, and silently
         * generating for free is the wrong way to lose that race.
         * ⚠️ coveredOnly is re-asked here, at the moment of payment. The gate above ran a minute ago (the
         * AI call sat in between) and canConsumeMany never reserves: the plan unit it saw may be gone, or
         * the pass claim may have lost a race. Then consumeOnSuccess would pick credits — the one lane
         * this build must never use. Refuse without charging or saving: handing it over free would make
         * racing builds a free-resume machine.
         * ⚠️ NO WAIVER FOR A CLIENT THAT DISCONNECTED — see clientGone.
         */
        const settlePayment = async () => {
            let spentPass = false;
            if (freeRegen) {
                // ⚠️ THE ONE FREE REGENERATION, RE-READ UNDER THE LOCK. The gate read regen_count before the AI
                // minute, so regenerations started together all read 0 and each landed its own bump: N taps, N
                // free resumes. Under this lock the next one reads the bump the previous one wrote.
                const rrow = await dbConfig.get('SELECT regen_count FROM user_resumes WHERE user_id = $1', [userId]);
                if (rrow && (rrow.regen_count || 0) >= 1) {
                    console.warn(`[resumeBuilder] a racing free regeneration for user ${userId} already used the one it had — refused, nothing saved`);
                    refusal = { status: 403, body: {
                        error: 'Your free plan includes one regeneration, and you have used it. Upgrade to keep refining your resume.',
                        reason: 'regen_limit',
                    } };
                    return;
                }
            }
            if (viaPass) {
                const claimed = await downloads.claimGeneration(userId, 'resume', passEmployer, req);
                spentPass = !!(claimed && claimed.charged);
                if (spentPass) paid.passId = claimed.passId || null;
            }
            if (!spentPass && !freeRegen) {
                if (coveredOnly) {
                    const now = await entitlements.canConsumeMany(userId, 'resume', 1, req);
                    if (!now.allowed || now.via === 'credits') {
                        console.warn(`[resumeBuilder] coveredOnly build for user ${userId} lost its cover during the run — refused, nothing charged`);
                        refusal = allowanceUsedUp();
                        return;
                    }
                }
                const marks = await creditMarksFor(userId);   // read only by the fallback below
                const used = await entitlements.consumeOnSuccess(userId, 'resume', { name: resumeData.personal_info?.full_name, screen: 'resume_builder' }, req);
                const via = used && used.via ? used.via : 'error';
                // Recorded before anything is decided: 'error' can still carry a deduction that landed first.
                if (used && used.ledgerId) paid.ledgerId = used.ledgerId;
                if (used && Object.prototype.hasOwnProperty.call(used, 'charge')) {
                    if (used.charge && used.charge.charged) paid.credits = { charged: true, cost: Number(used.charge.cost) || 0 };
                } else if (via === 'credits') {
                    // An entitlements that predates its own `charge` answer: the history marks are all
                    // there is. Conservative — it can under-report a payment, never invent one.
                    const d = await creditsDeductedSince(userId, marks);
                    if (d.paid) paid.credits = { charged: true, cost: d.cost };
                }
                if (via === 'credits') {
                    // ⚠️ 'credits' is what was ATTEMPTED, not what was paid: on a short balance
                    // chargeCredits answers { charged:false, insufficient:true } WITHOUT throwing and
                    // consumeOnSuccess still reports 'credits'. Its own result is the only proof.
                    charged = !!paid.credits;
                    if (coveredOnly) {
                        // The residual race between the re-check above and consumeOnSuccess: this
                        // build's own credits refunded and its ledger row deleted, then the same 402.
                        await giveBackDocCharges(userId, paid, 'a coveredOnly build slipped into credits');
                        refusal = allowanceUsedUp();
                        return;
                    }
                    if (!charged) {
                        console.warn(`[resumeBuilder] credits lane for user ${userId} deducted nothing (short balance or a racing build) — refused, nothing saved`);
                        await giveBackDocCharges(userId, paid, 'the credits lane deducted nothing');
                        refusal = { status: 402, body: {
                            error: 'You do not have enough credits left for this resume. Open Plans & Usage to continue.',
                            reason: 'quota_exhausted',
                        } };
                        return;
                    }
                } else if (via === 'plan' || via === 'trial') {
                    charged = true;                  // plan / trial: the ledger row IS the charge
                } else if (via === 'none') {
                    // ⚠️ NOTHING LEFT THAT MAY PAY: the gate saw a unit, an overlapping request spent it during the
                    // AI minute, and consumeOnSuccess wrote no row. A refusal — never a free resume per parallel tap.
                    console.warn(`[resumeBuilder] nothing left to pay for user ${userId}'s resume (the last unit went to an overlapping build) — refused, nothing saved`);
                    await giveBackDocCharges(userId, paid, 'nothing left that may pay');
                    refusal = allowanceUsedUp();
                    return;
                } else {
                    // 'error', or anything unrecognised: nothing confirmed, so nothing is saved or handed over.
                    console.error(`[resumeBuilder] the charge for user ${userId} could not be confirmed (${via}) — refused, nothing saved`);
                    await giveBackDocCharges(userId, paid, 'the charge could not be confirmed');
                    refusal = { status: 500, body: { error: 'We could not finish generating your resume. Please tap Generate again.', reason: 'failed' } };
                    return;
                }
            }
            if (spentPass) charged = true;
        };

        /** The build's row in user_resumes, plus the regeneration ledger the free lane counts on. */
        const persistResume = async () => {
            await ensureResumeTable();
            // A tailored build must not destroy the base it was built from — snapshot it first, right
            // before the overwrite. A build with no employer IS a new base, so it clears the marker.
            if (passEmployer) await snapshotBaseBeforeTailoring(userId, env);
            await saveResumeRow(userId, resumeData, passEmployer ? downloads.employerKeyOf(passEmployer) : null);
            // A regenerate spends the allowance; a fresh build restores it.
            // ⚠️ The free regeneration's only ledger IS this bump, so it counts as charged only once it lands.
            const regenLanded = await dbConfig.run(
                isRegenerate ? 'UPDATE user_resumes SET regen_count = regen_count + 1 WHERE user_id = $1'
                             : 'UPDATE user_resumes SET regen_count = 0 WHERE user_id = $1',
                [userId]).then(() => true, () => false);
            if (freeRegen && regenLanded) charged = true;
            return true;
        };

        await report('saving', 'Saving your resume', 95);
        paymentBegun = true;
        try {
            await withUsageLock(userId, 'resume', async () => {
                await settlePayment();
                if (refusal) return;                     // nothing paid for: nothing saved, nothing stored
                savedRow = await persistResume();
                // ⚠️ WRITE THE CACHE ONLY FOR A BUILD SOMEONE PAID FOR. A stored document is a free hit for ever
                // after; storing one whose charge did not record would turn a single uncharged run into
                // unlimited free copies for that employer.
                if (passEmployer && cacheFp && charged) {
                    const stored = await employerDocs.put({
                        userId, kind: 'resume', employer: passEmployer, jobUrl: (job && job.url) || '', jobTitle: (job && job.title) || '',
                        fingerprint: cacheFp, model: writtenBy || RESUME_MODEL, payload: resumeData, env,
                    });
                    // ⚠️ NOT A REASON TO REFUSE, unlike the doc lane: the resume is paid for, saved, and in the
                    // response this user is waiting on. An unwritten cache only costs the identical rebuild its free
                    // hit — loud here so it surfaces as a support line, never as a silent second charge.
                    if (!stored) console.error(`[resumeBuilder] ⚠️ PAID RESUME NOT CACHED — user ${userId}, "${passEmployer}", fp ${String(cacheFp).slice(0, 12)} — an identical rebuild will be charged again`);
                }
            });
        } catch (e) {
            // The lock's transaction failed: taking it (lock_timeout, a dead connection), a call under it
            // that threw, or its COMMIT. The work inside ran on the pool and is NOT rolled back, so what
            // landed stands — and what this request took is in `paid`, never inferred from the database.
            console.error(`[resumeBuilder] the charge/save for user ${userId} hit an error under the usage lock (${savedRow ? 'the resume was saved' : 'nothing saved yet'}):`, e.message);
        }
        if (refusal) return res.status(refusal.status).json(refusal.body);
        if (!savedRow) {
            if (!charged) {
                // ⚠️ NOTHING CONFIRMED PAID, SO NOTHING SAVED OR HANDED OVER. A lock that could not be taken (every
                // charge sits under it) or a call that threw before the charge landed used to fall through to a save
                // out here and a 200 — "this retry costs no money" — which made a lock failure a free resume.
                await giveBackDocCharges(userId, paid, 'the usage lock failed before the charge was confirmed');
                return res.status(500).json({ error: 'We could not finish generating your resume. Please tap Generate again.', reason: 'failed' });
            }
            // Paid, but the save under the lock threw: one retry out here. The charge is already in, so this races
            // nothing that pays — and the CACHE stays unwritten: a store outside the lock is the race the lock
            // exists to stop, and an uncached build only pays again.
            try {
                savedRow = await persistResume();
            } catch (saveErr) {
                // ⚠️ A PAID RESUME THAT CANNOT BE SAVED DOES NOT STAY PAID FOR: every charge this request made goes
                // back before the handler's catch answers "tap Generate again", so the retry is not a second charge.
                await giveBackDocCharges(userId, paid, 'the paid resume could not be saved');
                throw saveErr;
            }
        }
        if (clientGone) console.warn(`[resumeBuilder] user ${userId}'s client disconnected before delivery — the resume is saved and paid for, and the builder shows it on reopen`);

        return res.json({ success: true, resumeData, cached: false, tailoredFor: passEmployer });
    } catch (e) {
        // Google's AI, not the build, is what failed — and before the charge: say so, honestly (resumeAiUnavailableAnswer).
        // Only while no payment step has begun — past it, "Nothing was charged" is not ours to promise.
        const unavailable = paymentBegun ? null : resumeAiUnavailableAnswer(e);
        if (unavailable) {
            console.error(`[resumeBuilder] generateAI for user ${userId}: ${unavailable.log} — ${unavailable.status} ${unavailable.body.reason}, nothing charged, nothing saved`);
            return res.status(unavailable.status).json(unavailable.body);
        }
        // Never forward internal error text (JSON SyntaxErrors, DB errors, API errors)
        // to the user — log it here, send a friendly message out.
        console.error('[resumeBuilder] generateAI error:', e.message);
        const isTimeout = e.message === 'AI_TIMEOUT' || e.message?.includes('timeout') || e.message?.includes('ETIMEDOUT');
        const userMessage = isTimeout
            ? 'The AI took too long to respond. Please try again — it usually works on the second attempt.'
            : 'We could not finish generating your resume. Please tap Generate again.';
        return res.status(isTimeout ? 504 : 500).json({ error: userMessage, isTimeout });
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// THE EMPLOYER-DOC LANE — POST /generate-ai with saveTo:'employer_doc' (Home)
// ══════════════════════════════════════════════════════════════════════════════

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Past this much wall clock the one corrective pass is skipped and leftovers are stripped instead: the
 * app polls a build for six minutes, and three slow AI attempts plus research can already fill most of it.
 * (Whatever it starts still ends by RESUME_AI_DEADLINE_MS — this only decides whether a pass is worth starting.)
 */
const DOC_LANE_CORRECTION_BUDGET_MS = 3 * 60 * 1000;

/**
 * The doc lane's sampling temperature, above the builder lane's 0.4 (2026-09-15). At 0.4 the rewrite for Deutsche
 * Bahn kept the base summary's opening word for word and swapped one verb per bullet ("Led" → "Directed"): the
 * likeliest continuation of a résumé is that résumé. A little more room lets the model leave the base's phrasing;
 * the facts are held by the prompt's rules and the sameness guard, not by the temperature. The builder lane is
 * untouched (callGemini's default).
 */
const DOC_LANE_TEMPERATURE = 0.55;

/** The research for a build, or null. employerResearch never throws; a module that fails to load is null too. */
async function researchForDoc(website, company) {
    try {
        const { getEmployerResearch } = require('../services/employerResearch');
        return await getEmployerResearch({ website, name: company });
    } catch (e) {
        console.warn('[resumeBuilder] employer research unavailable:', e.message);
        return null;
    }
}

/**
 * The employer website this build may RESEARCH, or '' (= write it without research).
 *
 * ⚠️ A JOB BOARD IS NOT THE EMPLOYER. A chip's website can be the host of the page a job was captured from
 * (boards.greenhouse.io, de.indeed.com, a Workday tenant). Researched as it is, the SHARED research cache
 * files the board's industry, clients and brand colour under that domain for every user, and this lane
 * rewrites the resume for a recruiting platform — the letter lane's AGGREGATOR_HOST bug.
 * discoverController.websiteOf is the app's one answer to "is this host the employer's own site?", and a
 * posting's host counts only when the employer's name owns it (amazon.jobs for Amazon): the SAME vetting as
 * employerLetterController.researchSiteFor, so one chip's resume and letter research one site.
 * ⚠️ RESEARCH (AND PROMPT) INPUT ONLY. job.website stays in the fingerprint exactly as sent — the gate and
 * /api/employer-docs/current hash the raw field, and a vetted spelling there would make documents read
 * stale. Vetting that is unavailable (the module failed to load) is '' — no research — never the raw host.
 */
function docResearchSiteFor(company, job) {
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
    } catch (e) { console.warn('[resumeBuilder] website vetting unavailable — no research for this build:', e.message); }
    return '';
}

/**
 * Run `fn` holding this user's usage lock for `kind`: ONE payment decision at a time per (user, kind).
 *
 * ⚠️ canConsumeMany CHECKS AND NEVER RESERVES. Two covered builds landing together (Home runs several at
 * once) both read "1 unit left" at the coveredOnly re-check, and both consumeOnSuccess'd a plan row — the
 * allowance overspent by one. Under this lock the second re-checks AFTER the first one's ledger row
 * exists, and loses cleanly: 402, nothing charged, nothing stored.
 * ⚠️ THE BUILDER LANE'S SYNCHRONOUS Generate TAKES IT TOO (kind 'resume', after the model returns), or a
 * Generate and a Home doc build landing together are two lanes racing for one unit with no lock between
 * them — which is how the last plan unit got spent twice. The letter lanes take the same key for
 * 'cover_letter': employerLetterController's own copy, and coverLetterController's (the details worker, the
 * bulk screen, batch-process and the Job Hub letter).
 * ⚠️ THE LOCK IS ALL THE TRANSACTION HOLDS. The work inside runs on the pool (entitlements, downloads and
 * employerDocs have no transaction surface), so each write commits the moment it lands — which is exactly
 * what the NEXT holder has to see — and NOTHING is rolled back when this transaction fails. The caller
 * must record every charge the moment it happens and give it back itself (giveBackDocCharges).
 * ⚠️ The key is hashtext('usage:' || kind) + the user id: another lane serialises against this one only
 * by taking that same key.
 * The wait is bounded (lock_timeout): a holder stuck that long means the database is in trouble, and the
 * waiter fails closed — nothing charged — instead of hanging the build until the job reaper kills it.
 */
async function withUsageLock(userId, kind, fn) {
    return dbConfig.withTransaction(async (tx) => {
        await tx.get(`SET LOCAL lock_timeout = '15s'`);
        await tx.get(`SELECT pg_advisory_xact_lock(hashtext('usage:' || $1::text), $2::int)`, [kind, userId]);
        return fn();
    });
}

/**
 * Give back every charge ONE resume build made, because it will not deliver what it charged for (a
 * refusal after payment, an unconfirmed charge, a document that could not be stored). Both resume lanes
 * call it: the doc lane on every path that cannot hand over a docId, the builder lane on every path that
 * will not save and return its resume (nothing left to pay, an unconfirmed charge, a credits slip, a lock
 * that failed first, a paid resume whose save failed twice) — a builder run that merely could not CACHE
 * keeps its charge, because the resume itself is saved and in the response.
 * Never throws: each step runs on its own, and one that fails is logged loudly for support — never
 * retried blindly, since a refund applied twice is money handed out. `paid` is emptied as it goes, so a
 * second call is a no-op.
 *   • credits — refundCredits with this request's OWN chargeCredits result, never a re-read balance;
 *   • a pass  — the resume generation this request stamped (claimGeneration's passId) is un-stamped. The
 *               pass stays bound to this employer: that is the company being built for, and the gate's
 *               reservation bound it before the AI ran anyway;
 *   • the usage_ledger row this request inserted — deleted. usedSince counts rows, so on the plan / trial
 *               lanes this is what hands the unit back; on the credits lane it keeps Usage honest.
 */
async function giveBackDocCharges(userId, paid, why) {
    if (!paid) return;
    if (paid.credits && paid.credits.charged) {
        const cost = Number(paid.credits.cost) || 0;
        paid.credits = null;
        try {
            const { refundCredits } = require('../services/eventCosts');
            if (typeof refundCredits !== 'function') throw new Error('refundCredits unavailable');
            await refundCredits(userId, 'resume_ai_generate', { charged: true, cost });
            console.warn(`[resumeBuilder] give-back: ${cost} credit(s) returned to user ${userId} (${why})`);
        } catch (e) {
            console.error(`[resumeBuilder] ⚠️ CREDITS NOT GIVEN BACK — user ${userId}, ${cost} credit(s) (${why}) — support must make this good:`, e.message);
        }
    }
    if (paid.passId) {
        const passId = paid.passId;
        paid.passId = null;
        try {
            await dbConfig.run('UPDATE download_passes SET resume_generated_at = NULL WHERE id = $1 AND user_id = $2', [passId, userId]);
            console.warn(`[resumeBuilder] give-back: pass ${passId}'s resume generation returned to user ${userId} (${why})`);
        } catch (e) {
            console.error(`[resumeBuilder] ⚠️ PASS NOT GIVEN BACK — user ${userId}, pass ${passId} (${why}) — support must make this good:`, e.message);
        }
    }
    if (paid.ledgerId) {
        const ledgerId = paid.ledgerId;
        paid.ledgerId = null;
        try {
            await dbConfig.run('DELETE FROM usage_ledger WHERE id = $1 AND user_id = $2', [ledgerId, userId]);
        } catch (e) {
            console.error(`[resumeBuilder] ⚠️ USAGE ROW NOT GIVEN BACK — user ${userId}, usage_ledger ${ledgerId} (${why}) — support must make this good:`, e.message);
        }
    }
}

/** The AI's JSON as a resume, or null when it is not one (no object personal_info = nothing renders). */
function parseDocJson(text) {
    const cleaned = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const j = JSON.parse(cleaned);
    const pi = j && typeof j === 'object' && !Array.isArray(j) ? j.personal_info : null;
    return pi && typeof pi === 'object' && !Array.isArray(pi) ? j : null;
}

/**
 * Up to three attempts at one prompt, exactly like the builder lane's loop → { resume, model } (`model` is the one
 * that answered: stored on the document, never hashed). Throws AI_BAD_OUTPUT when three answers were not a résumé,
 * and aiText's AiUnavailableError, untouched and never retried here, when Google could not answer at all — see the
 * builder lane's loop for why. Run it inside withResumeAi so its provider retries report and share the build's clock.
 */
async function writeDocDraft(prompt, report) {
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
        if (attempt > 1) await report('retry', 'Taking another pass at it', 38 + attempt * 6);
        try {
            const { text, model } = await callGemini(prompt, { temperature: DOC_LANE_TEMPERATURE });
            const parsed = parseDocJson(text);
            if (parsed) return { resume: parsed, model };
            throw new Error('NOT_A_RESUME');
        } catch (e) {
            if (isAiUnavailable(e)) {
                // Out of time before Google was even asked: what failed is the answer this loop rejected, not Google.
                if (lastErr && Array.isArray(e.attempts) && !e.attempts.length) break;
                throw e;
            }
            lastErr = e;
            console.warn(`[resumeBuilder] employer doc attempt ${attempt}/3 failed: ${e.message}`);
        }
    }
    console.error('[resumeBuilder] all employer doc attempts failed:', lastErr && lastErr.message);
    throw new Error('AI_BAD_OUTPUT');
}

/**
 * What the draft got wrong that one more pass may fix: placeholders, the employer's name, and — when `base` is
 * given — a résumé that is still the base one (docSamenessOf: the summary, its opening, the title, the experience
 * bullets; `sameness` is always measured, `generic` is the problem). The design block is not the resume, so it is
 * not scanned.
 */
function docProblemsOf(draft, company, sourceText, { base = null, sector = null } = {}) {
    const resumeOnly = { ...draft, design: undefined };
    const sameness = base ? docSamenessOf(resumeOnly, base, sector) : null;
    return {
        placeholders: findPlaceholders(resumeOnly),
        leaks: employerNameLeaks(resumeOnly, company, sourceText),
        sameness,
        generic: !!(sameness && sameness.generic),
    };
}
const problemCount = (p) => p.placeholders.length + p.leaks.length + (p.generic ? 1 : 0);

/**
 * The ONE corrective pass: the same prompt, the draft that broke a rule, and exactly which rule — placeholders,
 * the employer's name, and a résumé that is still the base one (`sector` names what to rewrite it for). For that
 * last one the pass quotes the base opening and the draft's back to the model — the model cannot see its own
 * sameness — and demands the opening's shape ("<real role> for <sector> — <the two or three real strengths that
 * matter here>"), the bullets rephrased in the sector's language with the relevant ones first, and, again, no
 * fact added. Returns { resume, model } (the corrected resume and the model that wrote it), or null. Never throws —
 * the first draft is still deliverable after stripping. ⚠️ That includes Google being busy: aiText still waits and
 * falls back for this pass (inside the build's one clock), and when no model answers the first draft stands, as for
 * any other failed pass — a polish is never worth failing a paid build over.
 */
async function correctDocDraft(prompt, draft, problems, company, { sector = null } = {}) {
    const lines = [];
    if (problems.placeholders.length) {
        lines.push(`- It contains placeholder text, which is forbidden: ${problems.placeholders.slice(0, 12).map((p) => JSON.stringify(p)).join(', ')}. Rewrite every sentence that holds one so it reads naturally WITHOUT that number — never invent a number.`);
    }
    if (problems.leaks.length) {
        lines.push(`- It names ${company} in ${problems.leaks.join(' and ')}. Remove ${company} from them: the resume is about the candidate, not a message to ${company}.`);
    }
    if (problems.generic) {
        const s = problems.sameness || {};
        const pct = (v) => `${Math.round(v * 100)}%`;
        const why = [
            s.summarySim != null && s.summarySim > DOC_SUMMARY_SAME_MAX ? `the summary is ${pct(s.summarySim)} the same as the base resume's` : '',
            s.openingSim != null && s.openingSim > DOC_OPENING_SAME_MAX ? `its first sentence is ${pct(s.openingSim)} the base resume's opening` : '',
            s.titleUnchanged ? 'the title is the candidate\'s current title, unchanged' : '',
            s.highlights && s.highlights.share >= DOC_HIGHLIGHTS_SAME_SHARE ? `${s.highlights.unchanged} of its ${s.highlights.total} experience highlights are the base resume's bullets with a word swapped` : '',
        ].filter(Boolean).join(', ');
        const forWhat = sector ? docSectorPhraseOf(sector) : `the field ${company} hires in`;
        const op = s.openings || {};
        const cut = (v) => String(v || '').slice(0, 400);
        const quoted = op.base && op.draft ? ` The base resume opens: ${JSON.stringify(cut(op.base))} — your answer opens: ${JSON.stringify(cut(op.draft))}.` : '';
        lines.push(`- It reads like the candidate's general resume, not one written for ${company}${why ? ` (${why})` : ''}.${quoted} Rewrite the title and the summary opening for ${forWhat}: personal_info.title phrased for ${forWhat} using the candidate's REAL roles ("<real role> — <their specialism this sector needs>"); the summary's first sentence LEADING with their fit for ${forWhat} in ${company}'s vocabulary, in the shape "<real role> for ${forWhat} — <the two or three real strengths that matter here>", filled from the material and not from the base opening's wording. Then rephrase the experience highlights in the language of ${forWhat} where they describe the same work, the ones that matter to ${company} first — a bullet with one verb swapped is not rephrased. Wording, order and emphasis only: every fact stays exactly as the material states it, NO fact may be added (no skill, tool, number, client or achievement the material does not state), and ${company}'s name stays out.`);
    }
    const fixPrompt = `${prompt}

=== ⚠️ CORRECTION — YOUR PREVIOUS ANSWER BROKE A RULE ===
${lines.join('\n')}
Here is that previous answer. Return the COMPLETE corrected JSON in the same schema (including "design"), changing only what the rules above require and keeping every entry:
${JSON.stringify(draft)}`;
    try {
        const { text, model } = await callGemini(fixPrompt, { temperature: DOC_LANE_TEMPERATURE });
        const resume = parseDocJson(text);
        return resume ? { resume, model } : null;
    } catch (e) {
        console.warn('[resumeBuilder] employer doc correction failed — keeping the first draft:', e.message);
        return null;
    }
}

/** The AI's per-family scores as designFit expects them ({ [familyId]: { score, reason } }), or null. */
function familyScoresOf(raw) {
    const out = {};
    const put = (id, v) => {
        if (typeof id !== 'string' || !id) return;
        const score = v && typeof v === 'object' ? v.score : v;
        const reason = v && typeof v === 'object' && typeof v.reason === 'string' ? stripPlaceholderText(v.reason) : '';
        out[id] = { score, reason };
    };
    if (Array.isArray(raw)) { for (const e of raw) if (e && typeof e === 'object') put(e.id || e.family, e); }
    else if (raw && typeof raw === 'object') { for (const [k, v] of Object.entries(raw)) put(k, v); }
    return Object.keys(out).length ? out : null;
}

// ── The design: employer-first, a headline that says WHY, re-ranked on read for free ─────────────────────

/** The layout family a template id belongs to, or null. */
function familyOfTemplateId(id) {
    const t = typeof id === 'string' ? TEMPLATES.find((x) => x.id === id) : null;
    return t ? (t.family || t.id) : null;
}

/**
 * What a headline may claim about a family's layout: { family, photo, ats }, or null. `photo` = "has a photo slot":
 * designFit's FAMILY_META when it is loadable (azure, executive and minimal render an avatar the catalogue does not
 * flag), else the catalogue's own flag.
 */
function familyTraitsOf(fit, familyId) {
    const fam = familyId ? FAMILIES.find((f) => f.id === familyId) : null;
    if (!fam) return null;
    const meta = (fit && fit._internals && fit._internals.FAMILY_META && fit._internals.FAMILY_META[familyId]) || {};
    return { family: familyId, photo: typeof meta.photo === 'boolean' ? meta.photo : !!fam.photo, ats: Number(fam.ats) || Number(meta.ats) || 3 };
}

const DOC_TABULAR_FAMILIES = new Set(['germany', 'europass', 'timeline']);
const DOC_FORMAL_FAMILIES = new Set(['ats', 'exec_pro', 'elegant', 'minimal', 'germany', 'europass', 'compact']);
const DOC_MODERN_FAMILIES = new Set(['startup', 'mono', 'minimal', 'compact', 'rightrail']);
const DOC_VISUAL_FAMILIES = new Set(['banner', 'rightrail', 'timeline', 'startup', 'azure', 'executive']);
const DOC_HEADLINE_MAX = 120;

/** A headline cut at a word, never mid-word, to designFit's 120 characters. */
function capHeadline(s) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    if (t.length <= DOC_HEADLINE_MAX) return t;
    return `${t.slice(0, DOC_HEADLINE_MAX - 1).replace(/\s+\S*$/, '').trimEnd()}…`;
}

/** "Employers in Morocco" / "Employers in the United Kingdom" — null for a place a headline should not print (a code, junk). */
function employersInOf(place) {
    const p = typeof place === 'string' ? place.trim() : '';
    if (!p || p.length > 40 || /^[A-Z]{2,3}$/.test(p) || !/^\p{L}[\p{L} .'-]*$/u.test(p)) return null;
    const the = !/^the\s/i.test(p) && /\b(united|states|kingdom|emirates|republic|islands|netherlands|philippines|bahamas|gambia|maldives|comoros|seychelles)\b/i.test(p);
    return `Employers in ${the ? 'the ' : ''}${p}`;
}

/**
 * The plain-words WHY for the design that LEADS, from the employer's conventions — "Employers in Switzerland expect a
 * tabular CV with a photo slot — this design leads" — or null when no convention is a claim the leader satisfies.
 * ⚠️ EVERY CLAIM IS CHECKED AGAINST THE LEADER'S LAYOUT: a photo claim only over a family with a photo slot, "ATS-safe"
 * only over an ATS-5 family, "photo-free" only without a slot, "one-page" only in onepage mode, a look only over a
 * family that has it. A headline naming a convention the top card breaks is worse than no headline.
 */
function conventionsHeadlineOf(fit, design, conventions, company) {
    const c = docConventionsOf(conventions);
    const top = design && Array.isArray(design.ranked) ? design.ranked[0] : null;
    const tr = c && top ? familyTraitsOf(fit, familyOfTemplateId(top.id)) : null;
    if (!tr) return null;
    const cv = c.cv;
    const inPlace = employersInOf(c.roleCountry || c.hqCountry);
    const name = docConventionText(company, 160);
    const who = name && name.length <= 40 ? name : 'This employer';
    const lines = [];
    if (cv.photo === 'expected' && tr.photo && inPlace) {
        if (cv.format === 'europass' && tr.family === 'europass') lines.push(`${inPlace} often ask for a Europass CV with a photo — this design leads`);
        else if (cv.format === 'tabular' && DOC_TABULAR_FAMILIES.has(tr.family)) lines.push(`${inPlace} expect a tabular CV with a photo slot — this design leads`);
        else lines.push(`${inPlace} expect a CV with a photo — this design has the photo slot and leads`);
    }
    if (c.atsVendor && tr.ats >= 5) lines.push(`${who} screens applications with ${c.atsVendor} — this ATS-safe design leads`);
    if (cv.format === 'ats_plain' && tr.ats >= 5 && inPlace) lines.push(`${inPlace} screen CVs with software — this plain, ATS-safe design leads`);
    if (cv.photo === 'avoid' && !tr.photo && inPlace) lines.push(`${inPlace} expect no photo on a CV — this photo-free design leads`);
    if (cv.format === 'europass' && tr.family === 'europass' && inPlace) lines.push(`${inPlace} often ask for a Europass CV — this design leads`);
    if (cv.length === 'one_page' && design.mode === 'onepage' && inPlace) lines.push(`${inPlace} expect a one-page resume — this design leads`);
    if (c.employerType === 'public_sector' && DOC_FORMAL_FAMILIES.has(tr.family)) lines.push('Public-sector employers favour a formal, understated CV — this design leads');
    if (c.employerType === 'academia' && (DOC_FORMAL_FAMILIES.has(tr.family) || tr.family === 'timeline')) lines.push('Universities and research bodies favour a classic, well-structured CV — this design leads');
    if (c.employerType === 'enterprise' && tr.ats >= 4 && !DOC_VISUAL_FAMILIES.has(tr.family)) lines.push('Large employers screen CVs with software — this clean, ATS-friendly design leads');
    if (c.employerType === 'startup' && DOC_MODERN_FAMILIES.has(tr.family)) lines.push('Startups favour a modern, skimmable resume — this design leads');
    if (c.employerType === 'agency' && DOC_VISUAL_FAMILIES.has(tr.family)) lines.push('Agencies favour a bold, visual resume — this design leads');
    return lines.length ? capHeadline(lines[0]) : null;
}

/**
 * The headline a design is stored or shown with. ⚠️ IT MUST DESCRIBE THE DESIGN THAT LEADS, so, in order:
 *   1. the prior headline — the AI's at build time, the stored one on read — only while ITS family still leads
 *      (the AI wrote it about its own top family, and the rules can put another one first);
 *   2. the conventions' plain-words WHY for the leader (conventionsHeadlineOf);
 *   3. designFit's own ("<design> fits best — <reason>").
 */
function docHeadlineFor(fit, design, { priorFamily = null, priorHeadline = null, conventions = null, company = '' } = {}) {
    const top = design && Array.isArray(design.ranked) && design.ranked[0] ? familyOfTemplateId(design.ranked[0].id) : null;
    const prior = typeof priorHeadline === 'string' ? priorHeadline.replace(/\s+/g, ' ').trim() : '';
    if (prior && priorFamily && top && priorFamily === top) return capHeadline(prior);
    return conventionsHeadlineOf(fit, design, conventions, company) || (design && design.headline) || null;
}

/** The family the AI scored highest (a variant key counts for its family), or null. */
function aiTopFamilyOf(scores) {
    let best = null;
    for (const [id, v] of Object.entries(scores || {})) {
        const raw = v && typeof v === 'object' ? v.score : v;
        const n = typeof raw === 'number' ? raw : (typeof raw === 'string' ? parseFloat(raw) : NaN);
        const fam = FAMILIES.some((f) => f.id === id) ? id : familyOfTemplateId(id);
        if (!fam || !Number.isFinite(n)) continue;
        if (!best || n > best.n) best = { fam, n };
    }
    return best ? best.fam : null;
}

/**
 * The AI's own family scores as a stored design keeps them for a later re-rank: { [familyId]: { score, reason } }
 * with known families only (a variant key counts for its family, and an exact family key beats it — designFit's
 * rule), integer scores 0..100 and reasons ≤ 90 chars — or null when it scored none. Only used when designFit does
 * not return aiFamilies itself.
 */
function aiFamiliesOf(scores) {
    const out = {};
    for (const [id, v] of Object.entries(scores || {})) {
        const exact = FAMILIES.some((f) => f.id === id);
        const fam = exact ? id : familyOfTemplateId(id);
        if (!fam || (!exact && out[fam])) continue;
        const raw = v && typeof v === 'object' ? v.score : v;
        const n = typeof raw === 'number' ? raw : (typeof raw === 'string' ? parseFloat(raw) : NaN);
        if (!Number.isFinite(n)) continue;
        const reason = v && typeof v === 'object' && typeof v.reason === 'string' ? v.reason.replace(/\s+/g, ' ').trim().slice(0, 90) : '';
        out[fam] = { score: Math.min(100, Math.max(0, Math.round(n))), reason };
    }
    return Object.keys(out).length ? out : null;
}

/**
 * normaliseDesign keeps the fields it knows. One that predates contract 2 would drop aiFamilies and conventionsSummary —
 * the two fields that let a stored design be RE-RANKED later without AI — so they are carried over from the raw
 * ranking, only where the normalised design has no such key at all (never over a value normaliseDesign chose).
 */
function keepDesignExtras(normalised, raw) {
    if (!normalised || typeof normalised !== 'object' || !raw || typeof raw !== 'object') return normalised || null;
    const out = { ...normalised };
    const has = (k) => Object.prototype.hasOwnProperty.call(out, k);
    if (!has('aiFamilies') && Object.prototype.hasOwnProperty.call(raw, 'aiFamilies')) {
        out.aiFamilies = raw.aiFamilies && typeof raw.aiFamilies === 'object' && !Array.isArray(raw.aiFamilies) ? raw.aiFamilies : null;
    }
    if (!has('conventionsSummary') && Object.prototype.hasOwnProperty.call(raw, 'conventionsSummary')) {
        const s = typeof raw.conventionsSummary === 'string' ? raw.conventionsSummary.replace(/\s+/g, ' ').trim() : '';
        out.conventionsSummary = s ? s.slice(0, 120) : null;
    }
    return out;
}

/**
 * Every catalogue design exactly once, integer scores — the invariant every reader of `ranked` relies on. `ids` is
 * the catalogue of the design's kind (the resume catalogue by default).
 * ⚠️ THE ORDER IS THE PRODUCER'S, NOT CHECKED HERE (2026-09-15). This used to demand scores descending over the whole
 * list, and a resume `ranked` is FAMILY-FIRST now (designFit: one card per family, then the variants — the first
 * variant of the tail outscores the last family card by design), so that test read every re-ranked resume design
 * as broken and rerankStoredDesign answered null for all of them: the cards fell back to the stored order the
 * re-rank exists to replace. designFit.familyFirst is pure and idempotent and normaliseDesign applies it on read;
 * a letter's seven designs stay in plain score order. Neither needs this function to re-verify the sort.
 */
function isCompleteRanking(d, ids = TEMPLATE_IDS) {
    if (!d || typeof d !== 'object' || !Array.isArray(d.ranked) || d.ranked.length !== ids.length) return false;
    const seen = new Set();
    return d.ranked.every((r) => {
        if (!r || !ids.includes(r.id) || seen.has(r.id) || !Number.isInteger(r.score)) return false;
        seen.add(r.id);
        return true;
    });
}

/**
 * The convention region for a design: employerResearch.regionForConventions (the chip's country, the research's
 * conventions and the website — covering every country, so a .ma or .com host is no longer 'generic' by default),
 * else designFit.regionFor for a research module that predates it. Never throws.
 */
function docRegionFor(fit, conventions, { country = null, website = null } = {}) {
    try {
        const er = require('../services/employerResearch');
        if (typeof er.regionForConventions === 'function') {
            const region = er.regionForConventions(conventions || null, { country: country || null, website: website || null });
            if (typeof region === 'string' && region) return region;
        }
    } catch (e) { console.warn('[resumeBuilder] regionForConventions unavailable — region from the country and website alone:', e.message); }
    return fit.regionFor({ country: country || '', website: website || '' });
}

// ── The employer's brand: what every render of a document is recoloured with ─────────────────────────
// ⚠️ EVERY EMPLOYER'S RESUME LOOKED THE SAME (2026-09-15): the design was ranked per employer, but every page was
// drawn in the catalogue's own accents. The research now carries `brand` (employerResearch.brandOf: the colour
// and font read off the employer's website, else the researcher's brandColor / fontName), it is stored on the
// document's design as design.brand = { accent, font }, and EVERY doc-mode render passes it — the Home cards,
// the gallery, the PDF and the Word file — so the pages the phone tints for match the pages that arrive.
// ⚠️ THE BRAND IS PART OF THE PAGE, SO IT IS PART OF EVERY CACHE KEY (brandKeyOf): a document whose brand
// changed is re-rendered, never served in yesterday's colour.

const BRAND_HEX_RE = /^#[0-9a-f]{6}$/i;

/**
 * A stored font as the renderer will LOAD it (2026-09-15): a face Google does not host becomes its static-table
 * alternative (employerResearch.effectiveFont — "DB Neo Screen Sans Regular" → Barlow, Segoe UI → Open Sans), reduced
 * to { family, google } so from/original never reach the renderer or brandKeyOf. ⚠️ Prod doc 9 stored its raw face on
 * design.brand at build time (google:false) and rendered in Lato, while its research snapshot would have answered
 * Barlow through brandOf — two readings of one row. Every stored brand is read through docBrandShapeOf, so the table
 * is applied here and the two paths agree. Deterministic: a static table, no memory, no network. A research module
 * without effectiveFont, or a face the table does not know, leaves the font exactly as stored.
 */
function docFontAsLoaded(font) {
    try {
        const er = require('../services/employerResearch');
        const eff = typeof er.effectiveFont === 'function' ? er.effectiveFont(font) : null;
        if (eff && typeof eff.family === 'string' && eff.family.trim()) return { family: eff.family.replace(/\s+/g, ' ').trim().slice(0, 80), google: eff.google === true };
    } catch { /* the face as stored */ }
    return font;
}

/** A { accent, font } brand exactly as the renderer reads it (accent lower-cased, family ≤ 80 chars, google a boolean, the font as loaded — docFontAsLoaded), or null when neither half is usable. */
function docBrandShapeOf(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const accent = typeof raw.accent === 'string' && BRAND_HEX_RE.test(raw.accent.trim()) ? raw.accent.trim().toLowerCase() : null;
    const f = raw.font && typeof raw.font === 'object' && !Array.isArray(raw.font) ? raw.font : null;
    const family = f && typeof f.family === 'string' ? f.family.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
    const font = family ? docFontAsLoaded({ family, google: f.google === true }) : null;
    return accent || font ? { accent, font } : null;
}

/**
 * employerResearch.brandOf(research) → { accent, font } | null, defensively: a research module from before brandOf
 * (or one that fails to load) answers with the same precedence the contract names — the extracted brand's primary
 * colour and font, else the researcher's brandColor and fontName (a font the extractor did not verify is not a
 * Google font: the renderer leaves the design's own stack — the same deterministic answer brandOf itself gives
 * since 2026-09-15, so the two paths cannot disagree on a stored document). Never throws.
 */
function brandOfResearch(research) {
    const r = research && typeof research === 'object' && !Array.isArray(research) ? research : null;
    if (!r) return null;
    try {
        const er = require('../services/employerResearch');
        if (typeof er.brandOf === 'function') return docBrandShapeOf(er.brandOf(r));
    } catch (e) { console.warn('[resumeBuilder] brandOf unavailable — the researcher\'s colour and font stand in:', e.message); }
    const b = r.brand && typeof r.brand === 'object' && !Array.isArray(r.brand) ? r.brand : null;
    const fontName = typeof r.fontName === 'string' && r.fontName.trim() ? r.fontName.trim() : '';
    return docBrandShapeOf({
        accent: (b && b.primary) || r.brandColor || null,
        font: (b && b.font) || (fontName ? { family: fontName, google: false } : null),
    });
}

/**
 * The brand a STORED document renders in: its design's `brand` (what the build stored), else its research's
 * (a document stored before brands existed — its research may still carry the researcher's colour). ONE answer for
 * every read: /current and GET /:id (the phone's tint), home-cards ?doc=, the gallery, the PDF and the Word file.
 * ⚠️ DETERMINISTIC (2026-09-15): the answer is a function of the ROW alone. A researcher font on the research with no
 * verified Google answer (a pre-brand snapshot's bare fontName) is google:false on every process — employerResearch
 * .brandOf no longer consults brandExtract's per-process font memory, which made such a document's brand key (and so
 * every thumb and preview cache name) flip after a deploy, after any user's build checked that family, and back a
 * day later. Synchronous on purpose: rerankStoredDesign and docDesignOf are synchronous and shared with the routes.
 * The one asynchronous complement is withSharedBrand (the shared row's brand for a document that has none).
 */
function docBrandOf(doc) {
    let stored = doc && doc.design;
    if (typeof stored === 'string') { try { stored = JSON.parse(stored); } catch { stored = null; } }
    const own = stored && typeof stored === 'object' && !Array.isArray(stored) ? docBrandShapeOf(stored.brand) : null;
    return own || brandOfResearch(doc && doc.research);
}

/**
 * A stored document with NO brand of its own catches up with the shared employer row (2026-09-15): a build whose
 * website read missed its deadline stored design.brand = null over a research snapshot without a brand, and that
 * document stayed unbranded for good — even after patchBrand had written the employer's colour and font to
 * employer_research_cache for everyone. When docBrandOf answers null and the snapshot names its domain, the row's
 * brand (employerResearch.cachedBrandFor — ONE read-only SELECT: never the researcher, never the website, never a
 * write, so a render can bill nobody) is laid over the snapshot as research.brand, exactly where brandOf reads a
 * brand the build had — so every later docBrandOf (the design's accent, the cache key, the pages) sees it. The doc
 * OBJECT is changed, in memory, for this request; the row is never written back. Returns the same doc.
 * Only a document WITH a research snapshot: one without has no domain of record (job_input.website is the
 * requester's spelling), and a stub research would put it on rerankStoredDesign's re-rank path, which /current
 * does not take for it — two screens, two orders. Never throws; any failure leaves the document as it was.
 */
async function withSharedBrand(doc) {
    try {
        if (!doc || typeof doc !== 'object' || docBrandOf(doc)) return doc;
        const research = doc.research && typeof doc.research === 'object' && !Array.isArray(doc.research) ? doc.research : null;
        const domain = research && typeof research.domain === 'string' ? research.domain.trim() : '';
        if (!domain) return doc;
        const er = require('../services/employerResearch');
        if (typeof er.cachedBrandFor !== 'function') return doc;
        const brand = await er.cachedBrandFor(domain);
        if (!brand || !docBrandShapeOf(brandOfResearch({ ...research, brand }))) return doc;
        doc.research = { ...research, brand };
    } catch (e) { console.warn('[resumeBuilder] shared brand unreadable — the document renders unbranded:', e.message); }
    return doc;
}

/** A short stable key of a brand for cache names ('plain' without one): the accent and the font, nothing else. */
function brandKeyOf(brand) {
    const b = docBrandShapeOf(brand);
    if (!b) return 'plain';
    return crypto.createHash('sha256')
        .update(JSON.stringify([b.accent, b.font ? [b.font.family.toLowerCase(), b.font.google] : null]))
        .digest('hex').slice(0, 12);
}

/**
 * The document's Design (see designFit): the AI's family scores blended with the rules — EMPLOYER-FIRST since
 * 2026-09-14: the conventions, the employer type and its ATS lead, seniority is a minor factor — every design ranked,
 * with what a later read needs to RE-RANK it for free: aiFamilies (the AI's own scores) and conventionsSummary.
 * null when designFit is unavailable or throws — the row is then stored without one and the read routes rank it
 * rule-only. ⚠️ Runs BEFORE the charge, and can never fail the build.
 * ⚠️ A LENGTH CONVENTION DECIDES THE MODE (one_page → onepage, a researched two_pages → a4): the prompt wrote the
 * content to that length, and since 2026-09-16 it is the LANE'S ONE READING that decides — docPageModeOf on the
 * plan generateEmployerDoc resolved, never a second derivation from the raw conventions here. Otherwise the AI's
 * mode. The headline follows docHeadlineFor — never one about a design that does not lead.
 * `brand` (brandOfResearch) rides on the result as design.brand — what every render of the document is recoloured
 * with — and its accent is the colour the variants are ordered by (closest first), ahead of the researcher's.
 */
function rankDocDesign({ aiDesign, resumeData, research, country, website, conventions = null, company = '', brand = null, playbook = null }) {
    try {
        const fit = require('../services/designFit');
        const r = research && typeof research === 'object' ? research : {};
        const d = aiDesign && typeof aiDesign === 'object' ? aiDesign : {};
        const text = (v) => (typeof v === 'string' ? stripPlaceholderText(v) : null);
        // ⚠️ THE PROMPT'S ANSWER, NOT A SECOND READING OF THE RESEARCH (2026-09-16). The page mode used to be
        // derived here from the raw conventions all over again, so a length the PROMPT knew and this did not —
        // a one-page country with no research — wrote one page of content into a document stored as 'a4'.
        // generateEmployerDoc resolves the plan once and hands the same object to both; a caller with none gets
        // the same answer resolved here, from the same inputs.
        const plan = playbook && playbook.conv !== undefined ? playbook : docPlaybookOf({ country, website, conventions, research });
        const conv = plan.conv;
        const aiFamilyScores = familyScoresOf(d.families);
        const mode = docPageModeOf(plan, d.mode);
        const ranked = fit.rankResumeDesigns({
            aiFamilyScores,
            region: docRegionFor(fit, conventions, { country, website }),
            brandColor: (brand && brand.accent) || r.brandColor || null,
            companySize: r.companySize || null,
            industry: r.industry || null,
            seniorityYears: fit.seniorityYearsOf(resumeData),
            mode, tone: text(d.tone), headline: null,
            conventions: conventions || null,
            employerType: conv ? conv.employerType : null,
        });
        const design = keepDesignExtras(fit.normaliseDesign(ranked, 'resume'), ranked);
        if (!design) return null;
        if (!Object.prototype.hasOwnProperty.call(design, 'aiFamilies')) design.aiFamilies = aiFamiliesOf(aiFamilyScores);
        if (!Object.prototype.hasOwnProperty.call(design, 'conventionsSummary')) design.conventionsSummary = null;
        design.headline = docHeadlineFor(fit, design, {
            priorFamily: aiTopFamilyOf(aiFamilyScores), priorHeadline: text(d.headline), conventions, company,
        });
        design.brand = docBrandShapeOf(brand);       // null = rendered in the design's own colours (the phone reads it so)
        // The country this document was WRITTEN for, stored beside the region it was DESIGNED for — so the lane
        // can refuse to serve it free for another one (docServesPlace). '' is stored as null: no opinion, always
        // served. Not a ranking input, and never hashed — see the note above docPlaceKeyOf.
        design.writtenFor = docPlaceKeyOf({ country, website }) || null;
        return design;
    } catch (e) {
        console.warn('[resumeBuilder] design ranking failed — stored without one (the routes rank it on read):', e.message);
        return null;
    }
}

/**
 * A STORED employer document's design, RE-RANKED on read: its stored design put through today's rules again
 * (designFit.rerankDesign — its stored aiFamilies, no AI, no I/O, never written back), or for a row stored before
 * designs existed a rule-only ranking from the same inputs. null when the row carries no research, when designFit
 * cannot re-rank (an older module: the stored design then stands) or answers something incomplete — the caller
 * keeps its old path.
 *   opts.kind           — 'resume' (default) | 'cover_letter';
 *   opts.seniorityYears — a letter's, which its payload cannot say (employerDocsRoutes reads the employer's resume
 *                         document); a resume's comes from its own payload when not given;
 *   opts.isTechnicalRole — a letter's, from its job title and position.
 *
 * WHY: nearly every employer used to lead with the same exec_pro layout (the region fell back to 'generic' for
 * .ma/.com hosts, and seniority outweighed the employer). A document built before the employer-first rules must not
 * keep that order until its owner pays for a Refresh: the order is a VIEW of the document, not what they paid for.
 *
 * ⚠️ ONE ANSWER FOR EVERY READ OF A DOCUMENT: /api/employer-docs/current and GET /:id (DocMeta.design — the order and
 * fit % the phone's deck draws), home-cards ?doc= (preferred, fit, reason) and a download's default mode. So every
 * input comes from the ROW, never from what one screen sends — two screens showing one document in two orders is
 * the bug to avoid:
 *   region     — the one the design was BUILT with when it named one (the build knew the chip's country), else the
 *                research's conventions and domain (docRegionFor);
 *   brand colour (a letter's own first), size, industry, conventions — the stored research's.
 * ⚠️ NEVER MONEY, NEVER STALENESS: nothing is written, and `stale` is a separate label (employerDocsRoutes' staleFor).
 * ⚠️ THE MODE STAYS THE BUILD'S: the content was condensed for it, and a re-rank does not touch the content.
 * ⚠️ THE HEADLINE describes the leader: a resume's follows docHeadlineFor (the stored one while its family still
 * leads, else the conventions' WHY); a letter keeps its stored headline only while the same design leads.
 */
function rerankStoredDesign(doc, { kind = 'resume', seniorityYears = null, isTechnicalRole = false } = {}) {
    const research = doc && doc.research && typeof doc.research === 'object' && !Array.isArray(doc.research) ? doc.research : null;
    if (!research) return null;
    const k = kind === 'cover_letter' ? 'cover_letter' : 'resume';
    let fit;
    let ids;
    try {
        fit = require('../services/designFit');
        ids = k === 'resume' ? TEMPLATE_IDS : require('../utils/coverLetterTemplates').TEMPLATE_IDS;
    } catch (e) {
        console.warn('[resumeBuilder] designFit unavailable for the re-rank:', e.message);
        return null;
    }
    try {
        let stored = doc.design;
        if (typeof stored === 'string') { try { stored = JSON.parse(stored); } catch { stored = null; } }
        stored = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : null;
        if (stored && typeof fit.rerankDesign !== 'function') return null;
        const before = stored ? fit.normaliseDesign(stored, k) : null;
        const conventions = conventionsOfResearch(research);
        const conv = docConventionsOf(conventions);
        const payload = doc.payload && typeof doc.payload === 'object' ? doc.payload : {};
        const builtRegion = before && typeof before.region === 'string' && before.region !== 'generic' ? before.region : null;
        const years = seniorityYears != null && Number.isFinite(Number(seniorityYears)) ? Math.max(0, Number(seniorityYears))
            : (k === 'resume' ? fit.seniorityYearsOf(payload) : 0);
        const hex = (v) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v.trim()) ? v.trim() : null);
        // The brand this document renders in (its design's, else its research's — docBrandOf): what the phone tints
        // with, and the accent the variants are ordered by, so the order matches the colour the cards were drawn in.
        const brand = docBrandOf(doc);
        const inputs = {
            conventions: conventions || null,
            region: builtRegion || docRegionFor(fit, conventions, { website: typeof research.domain === 'string' ? research.domain : null }),
            brandColor: (k === 'cover_letter' ? hex(payload.brandColor) : null) || (brand && brand.accent) || research.brandColor || null,
            companySize: research.companySize || null,
            industry: research.industry || null,
            seniorityYears: years,
            employerType: conv ? conv.employerType : null,
            kind: k,
            ...(k === 'cover_letter' ? { isTechnicalRole: !!isTechnicalRole } : {}),
        };
        const raw = stored ? fit.rerankDesign(stored, inputs)
            : (k === 'resume' ? fit.rankResumeDesigns({ aiFamilyScores: null, ...inputs }) : fit.rankLetterDesigns(inputs));
        // Something that is not a ranking at all (null, a promise) is no answer — never "repaired" by normaliseDesign
        // into a catalogue of zero scores that would read as a real order.
        if (!raw || typeof raw !== 'object' || !Array.isArray(raw.ranked) || !raw.ranked.length) return null;
        let design = isCompleteRanking(raw, ids) ? { ...raw } : keepDesignExtras(fit.normaliseDesign(raw, k), raw);
        if (!isCompleteRanking(design, ids)) return null;
        design = { ...design };
        if (stored && (stored.mode === 'a4' || stored.mode === 'onepage')) design.mode = stored.mode;
        if (k === 'resume') {
            design.headline = docHeadlineFor(fit, design, {
                priorFamily: before && before.ranked[0] ? familyOfTemplateId(before.ranked[0].id) : null,
                priorHeadline: before ? before.headline : null,
                conventions, company: doc.employer_name || '',
            });
        } else if (before && before.headline && before.ranked[0] && before.ranked[0].id === design.ranked[0].id) {
            design.headline = before.headline;
        }
        design.brand = brand;                        // normaliseDesign keeps only the fields it knows — the brand rides on after
        return design;
    } catch (e) {
        console.warn(`[resumeBuilder] design re-rank (${k}) failed — the stored design stands:`, e.message);
        return null;
    }
}

/** The resume case of rerankStoredDesign — what docDesignOf (home-cards ?doc=, a download's default mode) shows. */
function rerankStoredResumeDesign(doc) {
    return rerankStoredDesign(doc, { kind: 'resume' });
}

/**
 * A document this request is being served instead of built: make sure it is the one Home shows.
 *
 * ⚠️ /api/employer-docs/current answers with the NEWEST row for a chip (same job URL, and the same
 * employer key or tracked employer id). A hit on an OLDER row — the user reverted an edit, so today's
 * inputs match a document from before it — would otherwise keep losing to the newer, now-stale row: the
 * chip says "Refresh", the refresh is this free hit, and the chip still says "Refresh". So the hit is
 * moved to the front by its updated_at.
 * ⚠️ ONLY WHEN SOMETHING NEWER WOULD WIN. updated_at is also the thumbnail cache key, so bumping a row
 * that is already the newest would throw away every rendered card of it for nothing. An unreadable check
 * (e.g. Migration 046 not landed) bumps anyway: a re-render is cheap next to a chip stuck on "Refresh".
 * updated_at only — no billing, no user_resumes, no payload.
 */
async function promoteServedDoc(userId, hit, employerId, env) {
    try {
        let newer = true;
        try {
            newer = !!(await dbConfig.get(
                `SELECT id FROM user_employer_documents
                  WHERE user_id = $1 AND kind = 'resume' AND environment = $2 AND job_url = $3
                    AND employer_key <> $4 AND id <> $5 AND updated_at > $6
                    AND (employer_key = $7 OR ($8::uuid IS NOT NULL AND employer_id = $8::uuid))
                  LIMIT 1`,
                [userId, env, hit.job_url || '', downloads.NONE, hit.id, hit.updated_at, hit.employer_key, employerId]));
        } catch (e) { console.warn('[resumeBuilder] newer-document check failed, promoting anyway:', e.message); }
        if (!newer) return;
        await dbConfig.run('UPDATE user_employer_documents SET updated_at = NOW() WHERE id = $1 AND user_id = $2', [hit.id, userId]);
    } catch (e) { console.warn('[resumeBuilder] served doc promotion failed:', e.message); }
}

/**
 * contract C2 — the one answer for "what would pay for this resume is not what you confirmed".
 *
 * Home asks before it spends: the sheet names the payer ("Covered by your one-time pass for Acme", "2 of 3
 * free resume generations left") and the build the user confirms sends that word back as `expectVia`. Between
 * the two, a plan can lapse, a parallel build can take the last unit, another tap can spend the pass. Charging
 * whatever is left is charging for something nobody agreed to — so the build is refused instead.
 * ⚠️ NOTHING BOUND, NOTHING CHARGED, NOTHING STORED on this path, ever. Whatever this request had already
 * taken when it found out goes back first (giveBackDocCharges).
 * ⚠️ 409, NOT 402: this is not "you are out of allowance", it is "ask again". The app re-reads the gate and
 * puts the sheet back up with what the resume would really cost now, instead of sending anyone to Plans.
 */
const PAYER_CHANGED = Object.freeze({
    status: 409,
    body: Object.freeze({
        success: false, reason: 'payer_changed',
        error: 'What pays for this resume changed after you confirmed it. Check it and confirm again.',
    }),
});

/**
 * contract C2 — the answer for a build confirmed as a FREE one ("it is already built") that no longer is: the
 * résumé or the posting moved between the gate and the build, so building it now would cost something the user
 * was never asked about. Refused before every gate — no reservation, no research, no AI, no charge.
 */
const CACHE_MISS = Object.freeze({
    status: 409,
    body: Object.freeze({
        success: false, reason: 'cache_miss',
        error: 'Your saved resume for this employer has changed. Check what building it again would use, then confirm.',
    }),
});

/**
 * POST /api/resume-builder/generate-ai with saveTo:'employer_doc' — the resume Home shows for ONE
 * employer chip, fully rewritten for that employer and stored in employerDocs with its ranked designs.
 *   body { __async, clientBuildId, coveredOnly, expectVia?, saveTo, employerId?, country?, rawText, name, email,
 *          phone, location, includeUploadedResume, docJobUrl?, job: { company, title?, url?, description?, website? } }
 *   → { success, cached, docId, tailoredFor }
 *   400 { reason: 'no_resume' | 'no_employer' }   402 { reason: 'quota_exhausted' }   500/504 { reason: 'failed' }
 *   409 { reason: 'payer_changed' | 'cache_miss' }   (contract C2 — only for a build that sent `expectVia`)
 *   503 { reason: 'ai_busy' | 'ai_down', retryable }   Google's AI could not write it — after aiText's pause, retry
 *        and fallbacks — and BEFORE the charge: nothing charged, nothing stored (resumeAiUnavailableAnswer)
 *
 * `job` is the build's INPUT (the fingerprint, the posting scrape); `docJobUrl` is the stored document's
 * IDENTITY — the job_url Home looks the chip's document up by ('' for an employer chip). Old clients that
 * do not send it are stored under job.url, as before.
 *
 * ⚠️ IT NEVER READS OR WRITES user_resumes. The builder lane overwrites the user's one resume row with
 * each tailored build (and snapshots the base first so tailoring does not compound). Home keeps one
 * document PER EMPLOYER instead, so there is nothing to overwrite: no saveResumeRow, no base snapshot,
 * no regen_count — and switching chips can show each employer's own resume straight from the DB.
 *
 * ⚠️ MONEY, IN THIS ORDER, CLAUSE FOR CLAUSE WITH generateAI:
 *   0. `expectVia` (contract C2), when the app sends it: the payer the user CONFIRMED on Home's sheet. At every
 *      point below where this lane is about to bind or charge, the payer it would really use is worked out
 *      first and compared with it — and a build that would now be paid for some other way is refused with 409
 *      payer_changed (PAYER_CHANGED), having bound, charged and stored nothing. A build that sends no
 *      expectVia behaves exactly as it always has;
 *   1. the fingerprint and the cache — a hit is FREE: no gate, no pass, no AI, no charge, nothing stored;
 *   2. the gates — plan/free quota, then the pass (reserving only when quota cannot pay); there is NO
 *      free-regeneration lane here, so generationGate answers this lane without one too;
 *   3. coveredOnly refuses BEFORE ANY PAID WORK — and research is paid work (a grounded AI call);
 *   4. research (of the VETTED website only, its hiring conventions and brand included) → the AI → ONE corrective
 *      pass at most, for placeholders, the employer's name and top lines that are still the base résumé's
 *      (docSamenessOf) → the personal-details convention → the design ranking, the brand stored on it;
 *   5. under this user's usage lock (withUsageLock), so parallel builds decide one at a time: a racing
 *      identical document is served free; else the pass claim, else consumeOnSuccess — coveredOnly re-asked
 *      at the moment of payment, and "paid" read off THIS request's own answers (the claim, the via, its
 *      chargeCredits result), never inferred from tables another build also writes. Nothing left that may
 *      pay (via 'none': the last unit went to an overlapping build) is a 402 quota_exhausted, not a 500 —
 *      the app opens Plans for it, and nothing is stored or charged;
 *   6. store ONLY what was actually paid for — a stored document is a free hit for ever after — and when
 *      the store fails, or anything after a charge refuses, give back EVERY charge this request made
 *      (giveBackDocCharges): the credits, the pass's generation, the ledger row.
 *
 * ⚠️ NO clientGone WAIVER — and since 2026-09-14 the sync builder lane has none either: waiving a run that
 * still saved its resume made a one-time allowance endless. Here the document is stored and Home finds it on
 * the next lookup, so a client that gave up still gets what it paid for — and its retry is a free cache hit,
 * not a second charge.
 */
async function generateEmployerDoc(req, res) {
    const userId = req.user.id;
    const body = req.body || {};
    const { name, email, phone, location, rawText } = body;
    const coveredOnly = body.coveredOnly === true;
    // ⚠️ contract C2 — WHAT THE USER CONFIRMED ON THE SHEET ('plan' | 'free' | 'pass' | 'cache'), or null when
    // the body carries none (an older app): then this lane decides what pays alone, exactly as it always has.
    // Every comparison against it happens BEFORE the thing it guards — see the gates and the charge below.
    const expectVia = downloads.expectedPayerOf(body);
    const startedAt = Date.now();
    // ⚠️ Set the moment the payment step BEGINS — see generateAI: the catch promises "Nothing was charged" only while false.
    let paymentBegun = false;

    if (typeof rawText !== 'string' || rawText.trim().length < 20) {
        return res.status(400).json({ error: 'Please provide more detail about your experience.', reason: 'no_resume' });
    }
    const rawJob = body.job && typeof body.job === 'object' ? body.job : {};
    // ⚠️ THE GATE'S SPELLING, EXACTLY (trim, 160 chars): the pass the gate answered for and the pass this
    // build reserves and claims must be one employer key.
    const company = String(rawJob.company || '').trim().slice(0, 160);
    // ⚠️ A NAME WHOSE MONEY KEY IS '(none)' IS NO EMPLOYER — "(None)" typed as a company included. That key is
    // the base snapshot's scope: a document stored under it is never listed, never returned by getById or
    // /current, so the user would pay for a resume nobody can ever open. The letter lane refuses the same key
    // (as reason 'invalid_employer').
    if (!company || downloads.employerKeyOf(company) === downloads.NONE) {
        return res.status(400).json({ error: 'Pick an employer to write this resume for.', reason: 'no_employer' });
    }
    // The FINGERPRINT job — hashed exactly as sent, and scraped when it is a posting link with no text.
    const job = {
        company,
        title: String(rawJob.title || ''), url: String(rawJob.url || ''),
        description: String(rawJob.description || ''), website: String(rawJob.website || ''),
    };
    // ⚠️ THE DOCUMENT'S IDENTITY IS NOT ITS POSTING LINK. job.url may be a link pasted on the Add sheet for an
    // EMPLOYER chip — build input, and part of the fingerprint — while the chip Home looks the document up by
    // is the employer itself (job_url ''). Stored under job.url, that build became a posting document no
    // chip ever asks for, and the chip went on offering a paid build. docJobUrl is the identity Home asks
    // with ('' for an employer chip, the posting URL for a posting chip); an old client that does not send
    // it gets the old behaviour, job.url.
    const docJobUrl = typeof body.docJobUrl === 'string' ? body.docJobUrl : job.url;
    const employerIdRaw = typeof body.employerId === 'string' ? body.employerId.trim() : '';
    const employerId = UUID_RE.test(employerIdRaw) ? employerIdRaw.toLowerCase() : null;
    const country = typeof body.country === 'string' ? body.country.replace(/\s+/g, ' ').trim().slice(0, 80) : '';

    try {
        const report = makeReporter(req);
        const env = downloads.envOf(req);
        // ⚠️ THE UPLOAD IS ALWAYS PART OF AN EMPLOYER DOCUMENT, whatever includeUploadedResume says. The
        // gate and /employer-docs/current fingerprint with it included; a build without it would store a
        // document the lookup could never call current, and the gate would never promise its cache.
        let uploadedOnce = null;
        const readUploaded = () => (uploadedOnce = uploadedOnce || uploadedResumeContextFor(userId));

        // ── 1. THE CACHE — before every gate that consumes, reserves or binds ──────────────────────────
        const cacheFp = await generationFingerprint(userId, {
            rawText, includeUploadedResume: true, job, env, readUploaded, researchRev: docResearchRev(),
        });
        if (!cacheFp) {
            // Unreachable with rawText present — but a document that cannot be keyed cannot be stored, so
            // it must never be paid for.
            return res.status(500).json({ error: 'We could not read your resume just now. Please try again.', reason: 'failed' });
        }
        // The website the design ranking and the playbook read (a job board's ccTLD is not the employer's) —
        // resolved here because the country a HIT must match is resolved from it. Pure and cheap: no I/O.
        const researchSite = docResearchSiteFor(company, job);
        // ⚠️ AND WHICH COUNTRY THIS BUILD IS FOR. A stored document written for another one is NOT a free hit:
        // the country decides what the document says and what the row stores, and none of it is hashed — see
        // docPlaceKeyOf. Documents from before the marker (and builds that resolve no country) always match.
        const placeKey = docPlaceKeyOf({ country, website: researchSite || job.website });
        const hit = await employerDocs.get(userId, 'resume', company, cacheFp, env);
        if (hit && hit.id && hit.payload && hit.payload.personal_info && docServesPlace(hit, placeKey)) {
            await report('cached', `Found your ${company} resume`, 90);
            await promoteServedDoc(userId, hit, employerId, env);
            console.log(`[resumeBuilder] employer doc cache hit for "${company}" (doc ${hit.id}) — no AI call, nothing charged`);
            return res.json({ success: true, cached: true, docId: Number(hit.id), tailoredFor: company });
        }
        if (hit && hit.id && !docServesPlace(hit, placeKey)) {
            // Not a failure and not yet a charge: the refusal below (or the gates) decides what happens next.
            console.log(`[resumeBuilder] employer doc ${hit.id} for "${company}" was written for '${docWrittenForOf(hit)}' and this build is for '${placeKey}' — not served as a hit`);
        }
        // ⚠️ CONFIRMED AS FREE, AND IT IS NOT (contract C2). The app starts a 'cache' build with no sheet at all,
        // because a stored document costs nothing — so a miss here would charge someone who was never asked.
        // Before every gate: nothing reserved, nothing researched, nothing spent.
        if (expectVia === 'cache') {
            console.log(`[resumeBuilder] employer doc for user ${userId} / "${company}" was confirmed as a saved document, but the cache misses now — refused, nothing charged`);
            return res.status(CACHE_MISS.status).json(CACHE_MISS.body);
        }

        // ── 2. THE GATES — generateAI's order: plan/free first, the pass second ─────────────────────────
        const quota = await entitlements.canConsumeMany(userId, 'resume', 1, req);
        // Under coveredOnly the credits lane does not exist, so quota that only credits could pay is
        // exhausted for this build — and the pass is consulted in full, exactly as generationGate answers.
        const quotaCovers = !!quota.allowed && !(coveredOnly && quota.via === 'credits');
        const boundOnly = quota.allowed && quotaCovers;
        // ⚠️ C2 IS ASKED BEFORE passCoversGeneration, BECAUSE THAT CALL BINDS. With boundOnly false it is a
        // RESERVATION — an UPDATE tying the oldest unspent pass to this employer. Refusing after it would leave
        // the one company a pass buys spent on a build nobody agreed to pay for that way. passWouldCoverResume
        // is its read-only twin, clause for clause, so the comparison happens while nothing has moved.
        if (expectVia !== null) {
            const would = await passWouldCoverResume(userId, company, req, { boundOnly });
            const payer = would ? 'pass' : downloads.quotaPayerOf(quota);
            if (payer !== expectVia) {
                console.warn(`[resumeBuilder] employer doc for user ${userId} / "${company}" was confirmed as '${expectVia}' but ${payer || 'nothing'} would pay now — refused, nothing bound or charged`);
                return res.status(PAYER_CHANGED.status).json(PAYER_CHANGED.body);
            }
        }
        const viaPass = await downloads.passCoversGeneration(userId, 'resume', company, req, { boundOnly }).catch(() => false);
        // The gate's OWN answer, compared again — a mismatch here is a race, and never a binding this refusal
        // would strand: the reservation lost one (then it bound nothing), or it found the employer's own pass
        // a read a moment ago did not. It cannot be a pass it has just bound, because the only build that
        // reaches that branch is one whose confirmed payer was already 'pass'.
        if (expectVia !== null) {
            const payer = viaPass ? 'pass' : downloads.quotaPayerOf(quota);
            if (payer !== expectVia) {
                console.warn(`[resumeBuilder] employer doc for user ${userId} / "${company}": '${expectVia}' was confirmed, ${payer || 'nothing'} would pay at the gate — refused, nothing charged`);
                return res.status(PAYER_CHANGED.status).json(PAYER_CHANGED.body);
            }
        }
        if (!viaPass && !quota.allowed) {
            return res.status(402).json({ error: quota.message, reason: 'quota_exhausted', creditsRequired: 1, remainingCredits: 0 });
        }
        // ── 3. coveredOnly: refused before research, before the AI — nothing spent, reserved or written ─
        if (coveredOnly && !viaPass && !quotaCovers) {
            console.log(`[resumeBuilder] coveredOnly employer doc for user ${userId} refused — only legacy credits could pay`);
            return res.status(402).json({
                error: 'Your plan does not cover this resume right now. Open Plans & Usage to continue.',
                reason: 'quota_exhausted',
            });
        }

        // ── 4. THE WORK ───────────────────────────────────────────────────────────────────────────────
        await report('reading', 'Reading your resume', 8);
        const uploadedResumeContext = await readUploaded();

        await report('researching', `Researching ${company}`, 16);
        // A posting link with no text is read here, as the builder lane does — in parallel with the
        // research, so the slower of the two is the only wait. ⚠️ website is never scraped (it is context).
        // ⚠️ Research goes to the VETTED site (researchSite, resolved at the cache step above — docResearchSiteFor),
        // never the raw field: a job board or an ATS is not the employer. The fingerprint keeps job.website as sent.
        const needPosting = !job.description && !!job.url;
        const [research, posting] = await Promise.all([
            researchSite ? researchForDoc(researchSite, company) : Promise.resolve(null),
            needPosting ? scrapePage(job.url).catch(() => null) : Promise.resolve(null),
        ]);
        // The prompt names the vetted site too: "Website: boards.greenhouse.io" would introduce the board to
        // the model as the employer.
        const promptJob = { ...job, website: researchSite };
        if (needPosting && posting) promptJob.description = [posting.title, posting.description].filter(Boolean).join('\n');
        // How THIS employer hires (photo, length, personal details, dates, CV format, employer type, ATS) — part of
        // the same research answer, null on a cache row or a research module from before it. It shapes the prompt's
        // formatting, the personal-details backstop and the design ranking; it is never a fact about the candidate.
        // ⚠️ Not in the fingerprint (RESEARCH_REV is): conventions arriving on an old cache row must not make
        // every saved document stale and paid to refresh.
        const conventions = conventionsOfResearch(research);
        // ⚠️ AND HOW A CV IS WRITTEN WHERE THIS APPLICATION IS GOING, RESOLVED ONCE (2026-09-16 — docPlaybookOf):
        // the country's own conventions with this employer's researched ones laid over them. The prompt, the
        // personal-details backstop and the design ranking are handed THIS object, so a document can never be
        // written for one country and designed for another. It reads the VETTED research site (a job board's
        // ccTLD says nothing about where the role is), which is the website the design ranking gets too.
        // ⚠️ Not in the fingerprint either — nothing here is hashed, so no stored document turns stale for it.
        const plan = docPlaybookOf({ country, website: researchSite || job.website, conventions, research });
        // The employer's look (its website's colour and font when the extractor found them, else the researcher's):
        // stored on the design and passed to EVERY render of this document — the cards, the gallery, the PDF, the Word file.
        const brand = brandOfResearch(research);
        // The sector the top lines are written for — the prompt's, the corrective pass's and the guard's one reading.
        const sector = docSectorOf(research, conventions);

        await report('writing', `Rewriting your resume for ${company}`, 38);
        let familyBrief = '';
        try { familyBrief = require('../services/designFit').resumeFamilyBrief(); }
        catch (e) { console.warn('[resumeBuilder] designFit unavailable for the prompt:', e.message); familyBrief = localFamilyBrief(); }
        const prompt = buildEmployerDocPrompt({
            name, email, phone, location, rawText, uploadedResumeContext, job: promptJob, research, familyBrief, country, conventions, playbook: plan,
        });
        // ⚠️ ONE AI CLOCK FOR THE DRAFT AND THE PASS (withResumeAi): a busy model is waited for and fallen back from
        // inside it, reported on the bar as it happens, and all of it ends by startedAt + RESUME_AI_DEADLINE_MS. When no
        // model can answer the draft, the catch below answers 503 ai_busy / ai_down — before the charge, so nothing is.
        // `writtenBy` follows the text that is delivered: the draft's model, or the pass's when its answer is taken.
        const docAi = { lane: 'resume_doc', report, startedAt };
        let { resume: draft, model: writtenBy } = await withResumeAi(docAi, () => writeDocDraft(prompt, report));

        // The placeholder guard, the employer's name kept out of the title and summary, and the résumé measured
        // against the base one (docSamenessOf — the summary, its opening, the title and the experience bullets; a
        // generic answer is a problem like the other two): ONE corrective pass for all of them while there is time,
        // then whatever placeholder is left is removed. A name or a generic opening that survives the pass is
        // delivered as written — cutting into a sentence would garble it.
        const sourceText = [rawText, uploadedResumeContext].join('\n');
        const base = baseTopLinesOf(rawText, uploadedResumeContext);
        let problems = docProblemsOf(draft, company, sourceText, { base, sector });
        if (problems.generic) console.log(`[resumeBuilder] employer doc for "${company}" came back generic (${docSamenessText(problems.sameness)}) — one corrective pass for ${sector || 'the field it hires in'}`);
        if (problemCount(problems) && Date.now() - startedAt < DOC_LANE_CORRECTION_BUDGET_MS) {
            const onlyGeneric = problems.generic && !problems.placeholders.length && !problems.leaks.length;
            await report('polishing', onlyGeneric ? `Sharpening it for ${company}` : 'Polishing the wording', 70);
            const fixed = await withResumeAi(docAi, () => correctDocDraft(prompt, draft, problems, company, { sector }));
            if (fixed) {
                const after = docProblemsOf(fixed.resume, company, sourceText, { base, sector });
                if (problems.generic) console.log(`[resumeBuilder] employer doc for "${company}" after the corrective pass: ${docSamenessText(after.sameness)}${after.generic ? ' — still generic, delivered as written' : ''}`);
                if (problemCount(after) <= problemCount(problems)) {
                    // ⚠️ THE FIRST DRAFT'S DESIGN STANDS. The pass corrects wording; the family scores are the model's
                    // reading of the EMPLOYER, and a second answer would re-roll them for nothing the fix asked for.
                    fixed.resume.design = draft.design && typeof draft.design === 'object' ? draft.design : fixed.resume.design;
                    draft = fixed.resume;
                    writtenBy = fixed.model;
                    problems = after;
                }
            }
        }
        const aiDesign = draft.design && typeof draft.design === 'object' ? draft.design : null;
        delete draft.design;                       // the payload is the resume JSON and nothing else
        if (problems.placeholders.length) {
            console.warn(`[resumeBuilder] employer doc for "${company}" still had ${problems.placeholders.length} placeholder(s) — removed: ${problems.placeholders.slice(0, 6).join(' ')}`);
            draft = stripPlaceholders(draft);
        }
        if (problems.leaks.length) console.warn(`[resumeBuilder] employer doc still names "${company}" in ${problems.leaks.join(', ')} — delivered as written`);

        const resumeData = draft;
        if (name)     resumeData.personal_info.full_name = name;
        if (email)    resumeData.personal_info.email     = email;
        if (phone)    resumeData.personal_info.phone     = phone;
        if (location) resumeData.personal_info.location  = location;
        resumeData._buildMethod = 'ai';
        // The prompt's personal-details rule, enforced: where the conventions — this employer's, or the country's
        // when the research found none — say a CV carries none, it carries none.
        applyPersonalDetailsConvention(resumeData, plan.conv);

        await report('designing', `Ranking designs for ${company}`, 86);
        // The region reads the VETTED employer site first (a job board's TLD says nothing about the employer) — the
        // same domain the stored research carries, so a later re-rank on read starts from the same place.
        const design = rankDocDesign({ aiDesign, resumeData, research, country, website: researchSite || job.website, conventions, company, brand, playbook: plan });

        // ── 5 + 6. THE CHARGE, THEN THE STORE — one request at a time per user (withUsageLock) ────────────
        // ⚠️ EVERY MONEY DECISION BELOW IS THIS REQUEST'S OWN ANSWER: the pass claim's charged + passId, and
        // consumeOnSuccess's via, its own chargeCredits result and the ledger row it wrote. Credits used to be
        // "verified" by reading the history table afterwards (creditsDeductedSince), which cannot tell our
        // deduction from an overlapping build's: a document the user HAD paid for read as unpaid and was
        // thrown away, unrefunded. `paid` records each charge the moment it lands, so whatever happens next —
        // a refusal, an unconfirmed charge, a store that fails — gives back exactly what this request took.
        // ⚠️ The store sits under the lock too: an identical build that paid a moment ago has already stored
        // when the next one looks, so the second is served that document free instead of paying again.
        const paid = { passId: null, credits: null, ledgerId: null };
        let served = null;       // a racing identical build's document, served free instead of ours
        let refusal = null;      // { status, body }, decided under the lock and answered after it
        let docId = null;
        paymentBegun = true;
        try {
            await withUsageLock(userId, 'resume', async () => {
                // ⚠️ A racing identical build (another device, same inputs) may have stored this exact document
                // during our AI minute. Then that document is what the user gets: served as the hit it now is,
                // nothing charged and nothing stored — paying twice for one document is the failure to avoid.
                // ⚠️ Same country test as the cache step (docServesPlace): a race that landed a document for
                // ANOTHER country is not this build's document, and serving it would hand back exactly the
                // wrong-country résumé the marker exists to prevent. This build then pays and stores its own.
                const landed = await employerDocs.get(userId, 'resume', company, cacheFp, env);
                if (landed && landed.id && landed.payload && landed.payload.personal_info && docServesPlace(landed, placeKey)) { served = landed; return; }

                let charged = false;
                let spentPass = false;
                if (viaPass) {
                    const claimed = await downloads.claimGeneration(userId, 'resume', company, req);
                    spentPass = !!claimed.charged;
                    if (spentPass) paid.passId = claimed.passId || null;
                }
                if (!spentPass) {
                    // ⚠️ C2 AT THE MOMENT OF PAYMENT: the confirmed pass did not land (a racing tap for this same
                    // employer won it), so what would pay now is the plan or the free allowance — a payer the user
                    // never agreed to. Losing that race must not mean a free resume, and it must not mean a silent
                    // charge either: refused here, nothing charged, and the app asks again.
                    if (expectVia === 'pass') {
                        console.warn(`[resumeBuilder] employer doc for user ${userId} / "${company}": the confirmed pass was spent elsewhere during the run — refused, nothing charged`);
                        refusal = PAYER_CHANGED;
                        return;
                    }
                    // ⚠️ coveredOnly, re-asked at the moment of payment: the gate above ran before research and
                    // the AI, canConsumeMany never reserves, and a lost pass claim lands here too. Under the lock,
                    // a parallel build's unit is already in the ledger when this reads it.
                    // ⚠️ And with a payer confirmed (C2), the answer must still BE that payer: a plan that ended
                    // mid-build leaves the free allowance paying for a resume the user confirmed against a plan.
                    if (coveredOnly || expectVia !== null) {
                        const now = await entitlements.canConsumeMany(userId, 'resume', 1, req);
                        if (expectVia !== null && downloads.quotaPayerOf(now) !== expectVia) {
                            console.warn(`[resumeBuilder] employer doc for user ${userId} / "${company}": '${expectVia}' no longer pays for it (${downloads.quotaPayerOf(now) || 'nothing'} would) — refused, nothing charged`);
                            refusal = PAYER_CHANGED;
                            return;
                        }
                        if (!now.allowed || now.via === 'credits') {
                            console.warn(`[resumeBuilder] coveredOnly employer doc for user ${userId} lost its cover during the run — refused, nothing charged or stored`);
                            refusal = { status: 402, body: {
                                error: 'Your plan allowance was used up while this resume was being written. Open Plans & Usage to continue.',
                                reason: 'quota_exhausted',
                            } };
                            return;
                        }
                    }
                    const used = await entitlements.consumeOnSuccess(userId, 'resume', { name: resumeData.personal_info.full_name, employer: company, screen: 'employer_home' }, req);
                    // Recorded before anything is decided: 'error' can still carry a deduction that landed first.
                    if (used && used.charge && used.charge.charged) paid.credits = used.charge;
                    if (used && used.ledgerId) paid.ledgerId = used.ledgerId;
                    const via = used ? used.via : 'error';
                    // ⚠️ C2, ON WHAT ACTUALLY PAID. consumeOnSuccess picks the pool itself, and in the sliver
                    // between the re-check above and this call it can pick another one (a plan that ended, the
                    // last unit taken by a lane that holds no lock). Recorded above, so whatever it took goes
                    // straight back — and the document is never stored for a payer the user did not confirm.
                    // 'error' and anything unrecognised are not a payer at all: they fall through to the
                    // "charge could not be confirmed" path below, which already gives everything back.
                    if (expectVia !== null && downloads.namesPayer(via) && downloads.payerWordOf(via) !== expectVia) {
                        console.warn(`[resumeBuilder] employer doc for user ${userId} / "${company}": ${via} paid where '${expectVia}' was confirmed — given back and refused`);
                        await giveBackDocCharges(userId, paid, 'a payer the user did not confirm');
                        refusal = PAYER_CHANGED;
                        return;
                    }
                    if (via === 'credits') {
                        if (coveredOnly) {
                            // The residual race between the re-check above and consumeOnSuccess: give it all back.
                            await giveBackDocCharges(userId, paid, 'a coveredOnly build slipped into credits');
                            refusal = { status: 402, body: {
                                error: 'Your plan allowance was used up while this resume was being written. Open Plans & Usage to continue.',
                                reason: 'quota_exhausted',
                            } };
                            return;
                        }
                        if (!paid.credits) {
                            // A short balance: chargeCredits took nothing, so nothing may be stored — and the ledger
                            // row consumeOnSuccess writes regardless is no consumption either.
                            console.warn(`[resumeBuilder] credits lane for user ${userId} deducted nothing for "${company}" — not stored`);
                            await giveBackDocCharges(userId, paid, 'the credits lane deducted nothing');
                            refusal = { status: 402, body: {
                                error: 'You do not have enough credits left for this resume. Open Plans & Usage to continue.',
                                reason: 'quota_exhausted',
                            } };
                            return;
                        }
                        charged = true;
                    } else if (via === 'plan' || via === 'trial') {
                        charged = true;            // plan / trial: the ledger row IS the charge
                    } else if (via === 'none') {
                        // ⚠️ NOTHING LEFT THAT MAY PAY — A REFUSAL, NOT A FAILURE. The gate saw a unit, an overlapping
                        // build spent it during the AI minute, and consumeOnSuccess wrote no row. This used to fall to
                        // the 500 below ("could not finish"), so Home offered Try again — straight back into the same
                        // wall. A 402 opens Plans; nothing is stored or charged either way.
                        console.warn(`[resumeBuilder] employer doc for user ${userId} / "${company}": nothing left to pay for it (the last unit went to an overlapping build) — refused, not stored`);
                        await giveBackDocCharges(userId, paid, 'nothing left that may pay');
                        refusal = { status: 402, body: {
                            error: 'Your plan allowance was used up while this resume was being written. Open Plans & Usage to continue.',
                            reason: 'quota_exhausted',
                        } };
                        return;
                    }
                    // 'error', or anything unrecognised: nothing confirmed, so `charged` stays false.
                }
                if (spentPass) charged = true;

                if (!charged) {
                    // ⚠️ NOTHING CONFIRMED PAID, SO NOTHING STORED — a stored document is a free hit for ever after.
                    // Whatever did land (a deduction before consumeOnSuccess failed) goes back.
                    console.error(`[resumeBuilder] employer doc for user ${userId} / "${company}": the charge could not be confirmed — not stored`);
                    await giveBackDocCharges(userId, paid, 'the charge could not be confirmed');
                    refusal = { status: 500, body: { error: 'We could not finish your resume. Please try again.', reason: 'failed' } };
                    return;
                }

                // ── 6. STORE — only what was paid for ──────────────────────────────────────────────────────
                await report('saving', `Saving your ${company} resume`, 92);
                const doc = {
                    userId, kind: 'resume', employer: company, jobUrl: docJobUrl, jobTitle: job.title,
                    fingerprint: cacheFp, model: writtenBy || RESUME_MODEL, payload: resumeData, research: research || null,
                    env, employerId, design,
                    // The exact job the fingerprint hashed — what /employer-docs/current re-hashes to call it stale.
                    jobInput: { title: job.title, url: job.url, description: job.description, website: job.website },
                };
                // put() never throws and answers null on a failed write; one retry covers a blip.
                docId = (await employerDocs.put(doc)) || (await employerDocs.put(doc));
                if (!docId) {
                    // ⚠️ A PAID DOCUMENT THAT CANNOT BE STORED CANNOT BE DELIVERED — this lane hands over a docId, not
                    // a resume. So every charge goes back: credits, the pass's generation, the plan/free unit. Only
                    // refunding credits left a plan or pass payer charged for nothing, and Try again charged twice.
                    console.error(`[resumeBuilder] ⚠️ PAID EMPLOYER DOC NOT STORED — user ${userId}, "${company}", fp ${cacheFp.slice(0, 12)} — giving back every charge`);
                    await giveBackDocCharges(userId, paid, 'the paid document could not be stored');
                    refusal = { status: 500, body: { error: 'Your resume was written but could not be saved. Please try again in a minute.', reason: 'failed' } };
                }
            });
        } catch (e) {
            // The lock's transaction failed: taking the lock (lock_timeout, a dead connection), a read under it that
            // threw, or its COMMIT. The writes under it were on the pool and are NOT rolled back, so: a document
            // that was stored has been paid for and is delivered; otherwise whatever this request took goes back.
            console.error(`[resumeBuilder] employer doc payment for user ${userId} / "${company}" hit an error under the usage lock (${docId ? `doc ${docId} was stored and paid — delivering it` : 'nothing stored'}):`, e.message);
            if (!docId && !served && !refusal) {
                await giveBackDocCharges(userId, paid, 'the usage lock failed');
                refusal = { status: 500, body: { error: 'We could not finish your resume. Please try again.', reason: 'failed' } };
            }
        }

        if (served) {
            await report('cached', `Found your ${company} resume`, 90);
            await promoteServedDoc(userId, served, employerId, env);
            console.log(`[resumeBuilder] employer doc for "${company}" landed from a racing build — served free, ours discarded`);
            return res.json({ success: true, cached: true, docId: Number(served.id), tailoredFor: company });
        }
        if (refusal) return res.status(refusal.status).json(refusal.body);
        if (!docId) {
            // Unreachable (every path under the lock serves, refuses or stores) — but never answer success without a document.
            return res.status(500).json({ error: 'We could not finish your resume. Please try again.', reason: 'failed' });
        }

        await report('pages', 'Laying out your top designs', 96);
        // The top designs' full-size pages, into the cache the gallery and Home's cards share (prerenderDocPages).
        await prerenderDocPages(userId, docId, resumeData, design, brand, 3, 20000);
        return res.json({ success: true, cached: false, docId: Number(docId), tailoredFor: company });
    } catch (e) {
        // Google's AI, not the build, is what failed — thrown only by the draft, before the usage lock and the charge.
        // Only while no payment step has begun — past it, "Nothing was charged" is not ours to promise.
        const unavailable = paymentBegun ? null : resumeAiUnavailableAnswer(e);
        if (unavailable) {
            console.error(`[resumeBuilder] employer doc for user ${userId} / "${company}": ${unavailable.log} — ${unavailable.status} ${unavailable.body.reason}, nothing charged, nothing stored`);
            return res.status(unavailable.status).json(unavailable.body);
        }
        console.error('[resumeBuilder] employer doc error:', e.message);
        const isTimeout = e.message === 'AI_TIMEOUT' || e.message?.includes('timeout') || e.message?.includes('ETIMEDOUT');
        const userMessage = isTimeout
            ? 'The AI took too long to respond. Please try again — it usually works on the second attempt.'
            : 'We could not finish writing your resume. Please try again.';
        return res.status(isTimeout ? 504 : 500).json({ error: userMessage, isTimeout, reason: 'failed' });
    }
}

/**
 * Would a pass pay for this employer's AI resume? The READ-ONLY twin of downloads.passCoversGeneration.
 *
 * ⚠️ passCoversGeneration with boundOnly=false is not a question, it is a RESERVATION: it binds the
 * user's oldest unspent pass to this employer with an UPDATE. Asking it from a dry run would spend the
 * one company a pass buys on a company the user merely looked at. downloads.js has no read-only
 * variant, so this answers the same two questions from reads alone, clause for clause:
 *   1. a pass ALREADY bound to this employer (boundPassFor — alias-aware, the same read the real gate
 *      makes) whose resume generation is still unused → covered;
 *   2. only when boundOnly is false: a TAKEABLE pass exists — the exact WHERE of the reservation's
 *      sub-select (this environment, resume column unused, unbound or parked on '(none)') → covered.
 * A nameless employer is never covered, and an unreadable pass is not a pass — both as downloads.js.
 * ⚠️ If downloads.passCoversGeneration's selection ever changes, this must change with it.
 */
async function passWouldCoverResume(userId, employer, req, { boundOnly }) {
    if (downloads.employerKeyOf(employer) === downloads.NONE) return false;
    const env = downloads.envOf(req);
    try {
        const owned = await downloads.boundPassFor(userId, employer, env);
        if (owned) {
            const free = await dbConfig.get(
                `SELECT id FROM download_passes WHERE id = $1 AND resume_generated_at IS NULL LIMIT 1`, [owned.id]);
            if (free) return true;
        }
        if (boundOnly) return false;
        const takeable = await dbConfig.get(
            `SELECT id FROM download_passes
              WHERE user_id = $1 AND environment = $2 AND resume_generated_at IS NULL
                AND (bound_at IS NULL OR employer_key = $3)
              LIMIT 1`, [userId, env, downloads.NONE]);
        return !!takeable;
    } catch { return false; }
}

/**
 * The doc-lane gate's two DISPLAY reads for Home's confirm sheet (contract 3) → { usage, pass }, each null when it
 * cannot be read. Never throws: a count the server could not read is a sheet that says less, never a failed gate.
 *   usage — entitlements.usageFor(userId, 'resume', req): the numbers canConsumeMany enforces, for the pool that
 *           would pay ("2 of 3 free resume generations left", "12 of 15 left this month on Plus").
 *   pass  — downloads.passStateFor(…, { kind: 'resume' }): READ-ONLY. Never passCoversGeneration from here — that
 *           one binds a pass, and a user who only looked at a company would have spent the one company it buys.
 */
async function docGateExtrasFor(userId, employer, req) {
    const [usage, pass] = await Promise.all([
        (async () => {
            try {
                if (typeof entitlements.usageFor !== 'function') return null;
                const u = await entitlements.usageFor(userId, 'resume', req);
                return u && typeof u === 'object' ? u : null;
            } catch (e) {
                console.warn('[resumeBuilder] gate usage unreadable — the sheet shows no count:', e.message);
                return null;
            }
        })(),
        (async () => {
            try {
                if (!employer || typeof downloads.passStateFor !== 'function') return null;
                const p = await downloads.passStateFor(userId, employer, req, { kind: 'resume' });
                return p && typeof p === 'object' ? { available: !!p.available, forThisEmployer: !!p.forThisEmployer } : null;
            } catch (e) {
                console.warn('[resumeBuilder] gate pass state unreadable — the sheet names no pass:', e.message);
                return null;
            }
        })(),
    ]);
    return { usage, pass };
}

/**
 * POST /api/resume-builder/generation-gate   body { employer, job?: { title?, url?, description?, website? } }
 *   200 { covered, via: 'plan'|'free'|'pass'|'cache'|'credits'|null, credits: number|null,
 *         reason: 'quota_exhausted'|'regen_limit'|null,
 *         usage: { kind, pool, planLabel, remaining, allowance, used, oneTime } | null,   (saveTo 'employer_doc' only)
 *         pass:  { available, forThisEmployer } | null }                                  (saveTo 'employer_doc' only)
 *
 * ⚠️ usage / pass ARE WHAT HOME'S CONFIRM SHEET SAYS BEFORE ANYTHING IS SPENT (contract 3): the count left in the
 * pool that would pay, and what a one-time pass means for this employer — or, with nothing left, the empty sheet
 * beside the $0.99 offer. Read-only and DISPLAY-ONLY (docGateExtrasFor): `covered` / `via` stay this dry run's own
 * answer, and the build asks every gate again under coveredOnly. They are null on a cache hit (it needs no sheet,
 * and a hit stays a path that reads no billing), on the no_employer refusal and on a failed gate. Only the doc lane
 * carries them: Home is their one reader, and the builder lane's free regeneration is no pool they describe.
 *
 * The question the app asks BEFORE it auto-starts a build: "would this be paid for by something the
 * user already has?" ⚠️ STANDING RULE (a real incident): never generate-and-charge silently. An explicit
 * Add is consent to use the plan, the free allowance or a pass — it is NOT consent to spend legacy
 * credits, so those come back covered:false via:'credits' and the app asks first.
 *
 * ⚠️ THE CACHE IS ASKED FIRST, because generateAI asks it first. A stored document for this employer
 * and these exact inputs is served before any quota is looked at and costs nothing — so a user with no
 * quota left must hear covered:true via:'cache', not be sent to Plans for a free document. The
 * fingerprint comes from generationFingerprint, the one function generateAI also uses, fed the build
 * Home sends: the server-side base narrative as rawText, the upload included, these job fields.
 * A regenerate never reads the cache (in either place), so it skips this step.
 * ⚠️ AND THE SAME COUNTRY TEST AS THE BUILD (docServesPlace): a document written for another country is not a
 * free hit there, so it must not be promised as one here. `country` is read from the body when the client sends
 * it (the letter gate always has; the resume gate's caller may not yet), and without it this answers exactly as
 * it always did — the build then refuses the promised 'cache' with 409 cache_miss, having bound and charged
 * nothing, and Home asks on its sheet. Over-promising a FREE document is the safe direction; under-promising a
 * paid one is not.
 *
 * ⚠️ THEN A TRUE DRY RUN, IN generateAI's ORDER: regen lane → canConsumeMany → pass. canConsumeMany
 * checks and never reserves (it may lazily create the free-plan anchor row, which every status read
 * does too). The pass is asked through passWouldCoverResume, never through passCoversGeneration.
 * Nothing here consumes, reserves or binds. The pass is consulted IN FULL when only credits could pay,
 * because Home builds with coveredOnly:true, under which generateAI does exactly that.
 *
 * ⚠️ saveTo:'employer_doc' ASKS ABOUT THE EMPLOYER-DOC LANE, and three things change with it: the cache is
 * asked with currentResumeFingerprint (the doc lane's research revision — the builder lane's fingerprint
 * would promise a 'cache' hit on a builder-lane document the doc build can never find), there is no
 * free regeneration, because generateEmployerDoc has none to give, and an employer whose money key is
 * '(none)' is a 400 { reason: 'no_employer' }, exactly as the build refuses it.
 */
async function generationGate(req, res) {
    const userId = req.user.id;
    const body = req.body || {};
    const employer = String(body.employer || '').trim().slice(0, 160) || null;
    const docLane = body.saveTo === 'employer_doc';
    const regenerate = !docLane && body.regenerate === true;
    const rawJob = body.job && typeof body.job === 'object' ? body.job : {};
    const job = {
        title: String(rawJob.title || ''), url: String(rawJob.url || ''),
        description: String(rawJob.description || ''), website: String(rawJob.website || ''),
    };
    // usage / pass ride on every doc-lane answer; `extras` stays null until the dry run below has read them.
    const answer = (covered, via, credits, reason, extras = null) => res.json(docLane
        ? { covered, via, credits, reason, usage: (extras && extras.usage) || null, pass: (extras && extras.pass) || null }
        : { covered, via, credits, reason });
    // ⚠️ The doc lane refuses a build with no employer (a '(none)' money key) before any work — so its gate
    // must not answer "covered" for one: an auto-start on that answer would only ever meet the build's 400.
    if (docLane && downloads.employerKeyOf(employer) === downloads.NONE) {
        return res.status(400).json({ covered: false, via: null, credits: null, reason: 'no_employer', usage: null, pass: null, error: 'Pick an employer to write this resume for.' });
    }
    try {
        if (employer && !regenerate) {
            const env = downloads.envOf(req);
            // A null fingerprint (base unreadable) is "cannot tell" — fall through to the dry run, which
            // can only under-promise: the build itself still reads the cache before charging anything.
            const fp = docLane
                ? await currentResumeFingerprint(userId, { job, env })
                : await generationFingerprint(userId, { includeUploadedResume: true, job, env });
            if (fp) {
                const hit = await employerDocs.get(userId, 'resume', employer, fp, env);
                // The country the BUILD would resolve, from what this request carries — '' when the client sends
                // none, and then every document matches, exactly as before (see the header).
                const placeKey = docLane
                    ? docPlaceKeyOf({
                        country: typeof body.country === 'string' ? body.country : null,
                        website: docResearchSiteFor(employer, job) || job.website,
                    })
                    : '';
                if (hit && hit.payload && hit.payload.personal_info && docServesPlace(hit, placeKey)) return answer(true, 'cache', null, null);
            }
        }
        // Same subscription read, same (Production-default) environment, as generateAI's regen lane.
        const sub = await entitlements.activeSubscription(userId).catch(() => null);
        if (regenerate && !sub) {
            await ensureResumeTable();
            const rrow = await dbConfig.get('SELECT regen_count FROM user_resumes WHERE user_id = $1', [userId]);
            if (!rrow) return answer(false, null, null, null);
            if ((rrow.regen_count || 0) >= 1) return answer(false, null, null, 'regen_limit');
            return answer(true, 'free', null, null);
        }
        const quota = await entitlements.canConsumeMany(userId, 'resume', 1, req);
        const quotaCovers = !!quota.allowed && (quota.via === 'plan' || quota.via === 'free');
        const viaPass = employer ? await passWouldCoverResume(userId, employer, req, { boundOnly: quotaCovers }) : false;
        // The confirm sheet's numbers — read AFTER the gates they describe, so a free-plan row canConsumeMany has
        // just created is the one usageFor counts. Display only: no branch below reads them.
        const extras = docLane ? await docGateExtrasFor(userId, employer, req) : null;
        // generateAI spends the pass first whenever it covered — so the pass is what pays.
        if (viaPass) return answer(true, 'pass', null, null, extras);
        if (!quota.allowed) return answer(false, null, null, 'quota_exhausted', extras);
        if (quotaCovers) return answer(true, quota.via, null, null, extras);
        if (quota.via === 'credits') {
            const price = await getEventCost('resume_ai_generate');
            return answer(false, 'credits', Number(price) || 0, null, extras);
        }
        // An allowance we cannot name is not one we may spend without asking.
        return answer(false, null, null, null, extras);
    } catch (e) {
        console.warn('[resumeBuilder] generation-gate failed:', e.message);
        return res.status(500).json({ covered: false, via: null, credits: null, reason: null, ...(docLane ? { usage: null, pass: null } : {}), error: 'Could not check your plan.' });
    }
}

// Mark the saved AI resume as the user's CURRENT résumé verdict: a perfect 100. Product rule
// (2026-08-27): the builder's output is our own best work — once the user saves it, the score
// card stops nagging them about a résumé they no longer use. acted_at is stamped so the popup
// never re-prompts over a 100; the Home card still shows it.
async function markBuilderPerfect(userId) {
    const scorer = require('../services/resumeScorer');
    const row = await dbConfig.get('SELECT resume_data FROM user_resumes WHERE user_id = $1', [userId]);
    if (!row || !row.resume_data) return;
    const fp = require('crypto').createHash('sha1').update('builder-final:' + JSON.stringify(row.resume_data)).digest('hex');
    await dbConfig.run(
        `INSERT INTO resume_scores (user_id, score, band, headline, summary, improvements, subscores, source, fingerprint, model, status, acted_at)
         VALUES ($1, 100, 'Excellent', $2, $3, '[]'::jsonb, $4, 'builder', $5, 'builder-final', 'ready', NOW())
         ON CONFLICT (user_id, fingerprint) DO UPDATE SET score = 100, status = 'ready', created_at = NOW()`,
        [userId,
         'Your AI resume is ready to impress',
         'Built and polished by AI from your own experience — structured, keyword-complete, and recruiter-friendly.',
         JSON.stringify({ impact: 100, clarity: 100, keywords: 100, completeness: 100 }),
         fp]).catch((e) => console.warn('[resumeBuilder] perfect-score upsert failed:', e.message));
    void scorer; // (scorer only re-scores organically on new uploads; the builder verdict is ours)
}

// POST /api/resume-builder/save
async function saveResume(req, res) {
    const userId = req.user.id;
    const { finalize, preferredTemplate } = req.body || {};
    const { resumeData } = req.body;
    // The gallery persists the chosen design without touching the resume itself.
    if (!resumeData && preferredTemplate) {
        try {
            await ensureResumeTable();
            if (TEMPLATE_IDS.includes(preferredTemplate)) {
                await dbConfig.run('UPDATE user_resumes SET preferred_template = $1 WHERE user_id = $2', [preferredTemplate, userId]);
            }
            return res.json({ success: true });
        } catch (e) { return res.status(500).json({ error: 'Failed to save template choice.' }); }
    }
    if (!resumeData) return res.status(400).json({ error: 'resumeData is required' });
    try {
        await ensureResumeTable();
        // ⚠️ AN EDIT TO A TAILORED RESUME BECOMES THE USER'S BASE. This upsert never touched tailored_for,
        // so after one tailored build every later editor save was invisible: source-text?base=1 kept
        // serving the pre-tailoring snapshot, and the next build's re-snapshot kept re-putting it. The
        // user's corrections were silently dropped from every future tailored resume.
        // The trade-off, chosen on purpose: a user editing their Nordex resume is editing their OWN FACTS
        // (a new job, a fixed date, a skill they forgot), which every future tailoring must start from.
        // What they lose is the untailored wording of the old base — acceptable, because the alternative
        // is building every company's resume from facts they have already corrected. It also moves the
        // cache fingerprint, so the next build for an employer pays once for the corrected resume.
        // Re-saving the tailored payload UNCHANGED (the builder saving what it was shown) is not an edit
        // and must not clear the marker — hence the order-insensitive comparison.
        let cur = null;
        try { cur = await dbConfig.get('SELECT resume_data, tailored_for FROM user_resumes WHERE user_id = $1', [userId]); }
        catch { cur = null; }   // no tailored_for column = nothing was ever tailored; the plain save below is right
        const editsTailored = !!(cur && cur.tailored_for) && !sameResumePayload(cur.resume_data, resumeData);
        if (editsTailored) {
            // Row first: if the snapshot write then fails, the untailored row IS the base, so nothing is lost.
            await saveResumeRow(userId, resumeData, null);
            await refreshBaseSnapshot(userId, resumeData, downloads.envOf(req));
            console.log(`[resumeBuilder] user ${userId} edited their resume tailored for "${cur.tailored_for}" — it is the base now`);
        } else {
            await dbConfig.run(
                `INSERT INTO user_resumes (user_id, resume_data, updated_at)
                 VALUES ($1, $2, CURRENT_TIMESTAMP)
                 ON CONFLICT (user_id) DO UPDATE
                 SET resume_data = EXCLUDED.resume_data,
                     updated_at  = CURRENT_TIMESTAMP`,
                [userId, JSON.stringify(resumeData)]
            );
        }
        if (preferredTemplate && TEMPLATE_IDS.includes(preferredTemplate)) {
            await dbConfig.run('UPDATE user_resumes SET preferred_template = $1 WHERE user_id = $2', [preferredTemplate, userId]).catch(() => {});
        }
        if (finalize) await markBuilderPerfect(userId);
        return res.json({ success: true });
    } catch (e) {
        return res.status(500).json({ error: 'Failed to save resume.' });
    }
}

// GET /api/resume-builder
async function getResume(req, res) {
    const userId = req.user.id;
    try {
        await ensureResumeTable();
        const row = await dbConfig.get(
            'SELECT resume_data, regen_count FROM user_resumes WHERE user_id = $1', [userId]
        );
        // isPaid/regen ride along so the builder can label its buttons truthfully without a
        // second round-trip; the server remains the authority when the buttons are pressed.
        const sub = await entitlements.activeSubscription(userId).catch(() => null);
        return res.json({
            resumeData: row ? row.resume_data : null,
            regen: { used: row ? (row.regen_count || 0) : 0, freeLimit: 1 },
            isPaid: !!sub,
        });
    } catch (e) {
        return res.status(500).json({ error: 'Failed to load resume.' });
    }
}


// Both photo shapes for one user, cached against the file's mtime — sharp was re-cropping and
// re-encoding the same photo TWICE on every preview batch, and the gallery sends several batches
// per visit. A re-upload changes the mtime, so staleness is impossible.
const photoCache = new Map();   // userId → { key, photo, photoRect }
async function photosFor(userId) {
    const ppath = await resolvePhotoPath(userId);
    if (!ppath) { photoCache.delete(userId); return { photo: null, photoRect: null }; }
    let key = ppath;
    try { key = ppath + ':' + (await fs.stat(ppath)).mtimeMs; } catch {}
    const hit = photoCache.get(userId);
    if (hit && hit.key === key) return hit;
    const photo = await loadPhotoDataUri(ppath);
    const photoRect = await loadPhotoDataUri(ppath, 'rect');
    const entry = { key, photo, photoRect };
    photoCache.set(userId, entry);
    return entry;
}

// Resolve a user's stored profile photo to an on-disk path (or null).
async function resolvePhotoPath(userId) {
    try {
        const uRow = await dbConfig.get('SELECT photo_path FROM users WHERE id = $1', [userId]);
        if (uRow && uRow.photo_path) {
            const p = path.join(__dirname, '../../', uRow.photo_path);
            await fs.access(p);
            return p;
        }
    } catch { /* no photo */ }
    return null;
}

// Read a resolved photo file into a compact, EXIF-corrected JPEG data URI (or null).
// Profile photos are often CIRCULAR PNGs (transparent corners) — converting those to
// JPEG would turn the corners BLACK, so we always flatten transparency to white.
//   shape 'circle' (default): full square, cover-cropped → circular avatars (the
//                             template clips it to a circle, so corners never show).
//   shape 'rect':             for rectangular photo boxes (German/Europass CVs). If the
//                             source is circular, crop the inscribed square (fully
//                             opaque) so the rectangle shows a clean headshot, no edges.
async function loadPhotoDataUri(photoPath, shape = 'circle') {
    if (!photoPath) return null;
    try {
        const sharp = require('sharp');
        const meta  = await sharp(photoPath).metadata();
        let pipe    = sharp(photoPath).rotate(); // honour EXIF orientation
        if (shape === 'rect' && meta.hasAlpha && meta.width && meta.height) {
            const D    = Math.min(meta.width, meta.height);
            const side = Math.round(D / Math.SQRT2);               // largest square inside the circle
            const left = Math.max(0, Math.round((meta.width  - side) / 2));
            const top  = Math.max(0, Math.round((meta.height - side) / 2));
            pipe = pipe.extract({ left, top, width: side, height: side });
        }
        const out = await pipe
            .flatten({ background: '#ffffff' })                        // transparent → white (never black)
            .resize(400, 400, { fit: 'cover', position: 'attention' }) // square crop toward the face
            .jpeg({ quality: 86 })
            .toBuffer();
        return `data:image/jpeg;base64,${out.toString('base64')}`;
    } catch (e) {
        // sharp failed (corrupt/unsupported) — fall back to embedding the raw file.
        try {
            const buf  = await fs.readFile(photoPath);
            const ext  = path.extname(photoPath).toLowerCase();
            const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
            return `data:${mime};base64,${buf.toString('base64')}`;
        } catch { return null; }
    }
}

// ── EMPLOYER DOCUMENTS, READ BACK (downloads, gallery previews, Home cards) ─────────────────────────
// A request that names a docId is asking for THAT stored document and nothing else.
// ⚠️ A docId that does not resolve is "gone", never a quiet fallback to user_resumes: the base resume is a
// different document, and a download would hand it over billed to an employer it was not written for.

/** The request carries a docId at all (a present-but-invalid one is still a doc request — and gone). */
const hasDocId = (body) => !!body && body.docId !== undefined && body.docId !== null && body.docId !== '';

/**
 * This user's resume document by id, or null. Owner-, environment- and kind-scoped in employerDocs'
 * SQL. A row whose payload has no object personal_info renders nothing, so it is null too. Never throws.
 * The document comes back with the shared row's brand laid over its research when it had none of its own.
 */
async function loadResumeDoc(userId, id, reqOrEnv) {
    try {
        const doc = await employerDocs.getById(userId, id, reqOrEnv, { kind: 'resume' });
        const pi = doc && doc.payload && typeof doc.payload === 'object' ? doc.payload.personal_info : null;
        // Every render path loads through here (home-cards ?doc=, the gallery, the PDF, the Word file), so this is
        // where a brand-less document meets the shared row's brand (withSharedBrand) — once, before any cache key.
        return pi && typeof pi === 'object' && !Array.isArray(pi) ? withSharedBrand(doc) : null;
    } catch (e) {
        console.warn('[resumeBuilder] employer doc read failed:', e.message);
        return null;
    }
}

/** { doc, gone } for a download body: no docId → { doc: null, gone: false } with no read at all. */
async function resumeDocFor(req) {
    if (!hasDocId(req.body)) return { doc: null, gone: false };
    const doc = await loadResumeDoc(req.user.id, req.body.docId, req);
    return { doc, gone: !doc };
}

const docGone = (res) => res.status(410).json({
    error: 'That version of your resume is no longer saved. Open the employer on Home to make it again.',
    reason: 'payload_gone',
});

/**
 * Who a download is billed to. ⚠️ A stored document is billed to the employer it was BUILT for, never to
 * body.employer: a client naming another company must not be able to spend (or borrow) that company's pass.
 */
const billingEmployerOf = (doc, body) => (doc ? doc.employer_name || null : (body && body.employer) || null);

/**
 * The design a stored document is shown with: re-ranked against today's employer-first rules when the row carries
 * research (rerankStoredResumeDesign — the SAME answer /api/employer-docs/current and GET /:id give, so the cards'
 * order, fit and reason match the DocMeta the phone pages them by); else its own (repaired against today's
 * catalogue); else a rule-only ranking computed now. ⚠️ Computed, never written back — see employerDocsRoutes'
 * designFor. The row carries no country, so the region comes from the researched domain. null if designFit is out.
 */
function docDesignOf(doc) {
    const reranked = rerankStoredResumeDesign(doc);
    if (reranked) return reranked;
    try {
        const fit = require('../services/designFit');
        const brand = docBrandOf(doc);               // every path answers with the brand the document renders in
        const stored = fit.normaliseDesign(doc.design, 'resume');
        if (stored) return { ...stored, brand };
        const r = doc.research && typeof doc.research === 'object' ? doc.research : {};
        return { ...fit.rankResumeDesigns({
            aiFamilyScores: null,
            region: fit.regionFor({ website: typeof r.domain === 'string' ? r.domain : '' }),
            brandColor: (brand && brand.accent) || r.brandColor || null, companySize: r.companySize || null, industry: r.industry || null,
            seniorityYears: fit.seniorityYearsOf(doc.payload),
        }), brand };
    } catch (e) {
        console.warn('[resumeBuilder] document design unavailable:', e.message);
        return null;
    }
}

/** The page mode a document downloads in when the request names none: its design's. */
function docModeOf(doc) {
    const d = docDesignOf(doc);
    return d && (d.mode === 'a4' || d.mode === 'onepage') ? d.mode : undefined;
}

// POST /api/resume-builder/generate-pdf  — renders the chosen HTML design template
// (Azure / Executive / Minimal) to PDF; falls back to the PDFKit layout if needed.
// body.docId → renders that stored employer document, billed to the employer it was built for.
async function generatePDF(req, res) {
    const userId = req.user.id;
    const { template } = req.body || {};
    let { mode } = req.body || {};
    try {
        const DOWNLOAD_CREDIT_COST = 0;   // downloads are part of the paid plans now, not a per-file charge
        const { doc, gone } = await resumeDocFor(req);
        if (gone) return docGone(res);
        let row;
        if (doc) {
            row = { resume_data: doc.payload };
            if (mode === undefined || mode === null || mode === '') mode = docModeOf(doc);
        } else {
            await ensureResumeTable();
            row = await dbConfig.get('SELECT resume_data FROM user_resumes WHERE user_id = $1', [userId]);
            if (!row || !row.resume_data) {
                return res.status(404).json({ error: 'No resume found. Please generate your resume first.' });
            }
        }

        // ── Previewing every design is free; DOWNLOADING the file is paid. ──
        // A plan covers it, and so does a single-employer pass bought outright. services/downloads
        // owns that decision — see the note there about why it is not repeated per controller.
        const employer = billingEmployerOf(doc, req.body);   // ⚠️ a document bills ITS employer — see billingEmployerOf
        const gate = await downloads.canDownload(userId, { employer }, req);
        if (!gate.allowed) {
            return res.status(403).json({
                error: gate.message || 'Previewing every design is free — downloading the PDF is part of the paid plans.',
                reason: gate.reason || 'paid_required',
            });
        }
        const creditCheck = { hasCredits: true, remaining: 0 };

        // Profile photo path
        let photoPath = null;
        try {
            const uRow = await dbConfig.get('SELECT photo_path FROM users WHERE id = $1', [userId]);
            if (uRow && uRow.photo_path) {
                photoPath = path.join(__dirname, '../../', uRow.photo_path);
                await fs.access(photoPath);
            }
        } catch { photoPath = null; }

        const resume = row.resume_data;
        const pi     = resume.personal_info || {};
        const strip  = (t) => String(t || '').replace(/<\/(p|div|li|h[1-6])>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#39;/gi, "'").replace(/&quot;/gi, '"').replace(/\*\*(.+?)\*\*/g, '$1').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();

        // ── Preferred path: render one of the 3 HTML design templates to PDF ──
        // (Falls back to the PDFKit layout below if Playwright/chromium is unavailable.)
        try {
            const tplId = TEMPLATE_IDS.includes(template) ? template : TEMPLATE_IDS[0];
            const needsRect = tplId === 'germany' || tplId === 'europass';
            const photo = await loadPhotoDataUri(photoPath);
            const photoRect = needsRect ? await loadPhotoDataUri(photoPath, 'rect') : null;
            // A stored document renders in ITS employer's brand (docBrandOf) — the accent and font its cards were drawn in.
            const pdfBuffer = await renderPdf(tplId, resume, { photo, photoRect, mode, brand: doc ? docBrandOf(doc) : null });
            const tSafe = strip(pi.full_name || 'Resume').replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '_');
            const tFile = `${tSafe}_Resume_${Date.now()}.pdf`;
            const tDir  = path.join(__dirname, '../../temp');
            await fs.mkdir(tDir, { recursive: true });
            await fs.writeFile(path.join(tDir, tFile), pdfBuffer);
            // ⚠️ CLAIM HERE TOO. This is the PREFERRED render path, so it is the one almost every
            // real download takes — and it used to return without claiming, while only the PDFKit
            // fallback below charged. A pass therefore stayed UNBOUND after the download it paid
            // for, and the NEXT download bound it instead: buy a pass for Acme, download the Acme
            // resume, then download anything for Beta, and the pass silently becomes Beta's while
            // Acme goes back to locked. The user pays twice for the company they already bought.
            // (Under DOWNLOADS_METERED it also meant plan downloads were never metered at all.)
            // Same rule as the fallback: the bytes exist by this line, so charging is safe.
            await downloads.claimDownload(userId, { employer }, req);
            // Home lists this back to them so the file can be fetched again later without paying
            // twice. Best-effort: the download has already succeeded and been charged.
            await history.record(userId, {
                kind: 'resume', employer, templateId: tplId, templateName: templateNameOf(tplId),
                format: 'pdf', mode, fileName: tFile,
                payload: doc ? { template: tplId, mode, docId: Number(doc.id) } : { template: tplId, mode },
            }, req).catch(() => {});
            return res.json({ success: true, downloadUrl: `/api/download-resume/${encodeURIComponent(tFile)}`, template: tplId, creditsRemaining: Math.max(0, creditCheck.remaining - DOWNLOAD_CREDIT_COST) });
        } catch (tplErr) {
            console.warn('[resumeBuilder] template render failed, falling back to PDFKit:', tplErr.message);
        }

        // ── Fonts (same as cover letter) ─────────────────────────────
        const PDFKit  = require('pdfkit');
        const fsSync  = require('fs');
        const fontsDir = path.join(__dirname, '../../fonts');
        const fontR   = path.join(fontsDir, 'Lato-Regular.ttf');
        const fontB   = path.join(fontsDir, 'Lato-Bold.ttf');

        // ── Page geometry (same as cover letter) ──────────────────────
        const PW        = 595;
        const PH        = 841;
        const SBW       = 180;  // sidebar width
        const CX        = SBW + 40;  // right content x
        const CW        = PW - CX - 35; // right content width
        const SP        = 20;   // sidebar padding

        // ── File output ───────────────────────────────────────────────
        const safeName = strip(pi.full_name || 'Resume').replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '_');
        const fileName = `${safeName}_Resume_${Date.now()}.pdf`;
        const tempDir  = path.join(__dirname, '../../temp');
        await fs.mkdir(tempDir, { recursive: true });
        const filePath = path.join(tempDir, fileName);

        await new Promise((resolve, reject) => {
            const doc = new PDFKit({
                size: [PW, PH],
                margins: { top: 0, bottom: 0, left: 0, right: 0 },
                autoFirstPage: false,
            });

            doc.registerFont('F',  fontR);
            doc.registerFont('FB', fontB);
            doc.font('F');

            const writeStream = fsSync.createWriteStream(filePath);
            doc.pipe(writeStream);
            writeStream.on('error', reject);
            writeStream.on('finish', resolve);

            // ── Sidebar gradient (same formula as cover letter) ─────────
            const drawSidebar = () => {
                const grad = doc.linearGradient(0, 0, 0, PH);
                grad.stop(0,   '#0d0d1a');
                grad.stop(0.5, '#141428');
                grad.stop(1,   '#1c1c2e');
                doc.rect(0, 0, SBW, PH).fill(grad);
            };

            // ── Add page with sidebar ─────────────────────────────────
            let contentY = 50;
            const addPage = () => {
                doc.addPage({ size: [PW, PH], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
                drawSidebar();
                contentY = 30;
            };
            addPage();

            // ── Check page break ──────────────────────────────────────
            const checkBreak = (needed = 40) => {
                if (contentY + needed > PH - 30) {
                    addPage();
                    return true;
                }
                return false;
            };

            // ── Right-column section heading ──────────────────────────
            const rSection = (title) => {
                checkBreak(50);
                contentY += 16;
                doc.font('FB').fontSize(11).fillColor('#1a1a2e');
                doc.text(title.toUpperCase(), CX, contentY, { lineBreak: false });
                contentY += 14;
                doc.moveTo(CX, contentY).lineTo(PW - 30, contentY).lineWidth(0.8).strokeColor('#cccccc').stroke();
                contentY += 10;
            };

            // ── Timeline entry: circle + role bold + date right ───────
            const rEntry = (titleTxt, date) => {
                checkBreak(30);
                // Circle marker
                doc.circle(CX + 5, contentY + 6, 4).fillColor('#1a1a2e').fill();
                doc.circle(CX + 5, contentY + 6, 2).fillColor('#ffffff').fill();
                // Role title
                doc.font('FB').fontSize(10.5).fillColor('#1a1a2e');
                const titleW = CW - (date ? doc.widthOfString(date, { fontSize: 8.5 }) + 12 : 0) - 18;
                doc.text(strip(titleTxt), CX + 16, contentY, { width: titleW, lineBreak: true });
                const titleH = doc.heightOfString(strip(titleTxt), { width: titleW });
                // Date right-aligned on first line
                if (date) {
                    doc.font('F').fontSize(8.5).fillColor('#888888');
                    doc.text(date, PW - 30 - doc.widthOfString(date, { fontSize: 8.5 }), contentY, { lineBreak: false });
                }
                contentY += Math.max(titleH, 14);
            };

            // ── Sub-label (company, institution) ─────────────────────
            const rSub = (txt) => {
                if (!strip(txt)) return;
                checkBreak(15);
                doc.font('F').fontSize(9.5).fillColor('#3a6cb5');
                doc.text(strip(txt), CX + 16, contentY, { width: CW - 16, lineBreak: true });
                contentY += doc.heightOfString(strip(txt), { width: CW - 16, fontSize: 9.5 });
                contentY += 2;
            };

            // ── Bullet line ───────────────────────────────────────────
            const rBullet = (txt) => {
                const clean = strip(txt);
                if (!clean) return;
                checkBreak(15);
                doc.font('F').fontSize(9.5).fillColor('#444444');
                const bw = CW - 28;
                const bh = doc.heightOfString(clean, { width: bw, fontSize: 9.5 });
                doc.rect(CX + 18, contentY + 4.5, 3, 3).fillColor('#3a6cb5').fill();
                doc.font('F').fontSize(9.5).fillColor('#444444');
                doc.text(clean, CX + 27, contentY, { width: bw, lineBreak: true });
                contentY += bh + 2;
            };

            // ── Right body text ───────────────────────────────────────
            const rText = (txt, sz = 9.5, color = '#444444') => {
                const clean = strip(txt);
                if (!clean) return;
                checkBreak(15);
                doc.font('F').fontSize(sz).fillColor(color);
                doc.text(clean, CX, contentY, { width: CW, lineBreak: true, align: 'justify' });
                contentY += doc.heightOfString(clean, { width: CW, fontSize: sz }) + 4;
            };

            // ────────────────────────────────────────────────────────────
            // SIDEBAR CONTENT (page 1)
            // ────────────────────────────────────────────────────────────
            const photoX = SBW / 2;
            const photoY = 72;
            const photoR = 42;

            // Photo circle border
            doc.circle(photoX, photoY, photoR + 3).lineWidth(2.5).strokeColor('#ffffff').stroke();

            if (photoPath) {
                try {
                    doc.save();
                    doc.circle(photoX, photoY, photoR).clip();
                    doc.image(photoPath, photoX - photoR, photoY - photoR, { width: photoR * 2, height: photoR * 2 });
                    doc.restore();
                } catch {
                    photoPath = null; // fall through to initials
                }
            }
            if (!photoPath) {
                doc.circle(photoX, photoY, photoR).fillColor('#1e2440').fill();
                const parts = strip(pi.full_name || '?').trim().split(/\s+/);
                const ini   = (parts.length >= 2 ? parts[0][0] + parts[parts.length - 1][0] : parts[0][0] || '?').toUpperCase();
                doc.font('FB').fontSize(22).fillColor('#ffffff');
                doc.text(ini, photoX - 18, photoY - 13, { width: 36, align: 'center' });
            }

            let sy = photoY + photoR + 28; // sidebar y cursor

            // Sidebar section helper
            const sSection = (title) => {
                doc.font('FB').fontSize(9).fillColor('#ffffff');
                doc.text(title, SP, sy, { lineBreak: false });
                sy += 14;
                doc.moveTo(SP, sy).lineTo(SBW - SP, sy).lineWidth(0.5).strokeColor('#555577').stroke();
                sy += 10;
            };

            // Sidebar label + value
            const sItem = (label, value) => {
                if (!value || !strip(value)) return;
                doc.font('FB').fontSize(8).fillColor('#9999bb');
                doc.text(label, SP, sy, { lineBreak: false });
                sy += 11;
                doc.font('F').fontSize(9).fillColor('#ddddee');
                const clean = strip(value);
                doc.text(clean, SP, sy, { width: SBW - SP * 2, lineBreak: true });
                sy += doc.heightOfString(clean, { width: SBW - SP * 2, fontSize: 9 }) + 5;
            };

            // Sidebar skill item
            const sSkill = (txt) => {
                const clean = strip(txt);
                if (!clean) return;
                doc.font('F').fontSize(9).fillColor('#ddddee');
                // Small dot
                doc.circle(SP + 3, sy + 4.5, 2).fillColor('#3a6cb5').fill();
                doc.text(clean, SP + 10, sy, { width: SBW - SP - 14, lineBreak: true });
                sy += doc.heightOfString(clean, { width: SBW - SP - 14, fontSize: 9 }) + 5;
            };

            // CONTACT
            sSection('CONTACT');
            sItem('Phone',    pi.phone);
            sItem('Email',    pi.email);
            sItem('Location', pi.location);
            if (pi.linkedin_url)  sItem('LinkedIn',  'linkedin.com/in/...');
            if (pi.portfolio_url) sItem('Portfolio', strip(pi.portfolio_url).substring(0, 22));

            sy += 8;

            // TECH SKILLS
            if (resume.skills?.technical?.length) {
                sSection('TECH SKILLS');
                for (const sk of resume.skills.technical.slice(0, 12)) sSkill(sk);
                sy += 4;
            }

            // SOFT SKILLS
            if (resume.skills?.soft?.length) {
                sSection('SOFT SKILLS');
                for (const sk of resume.skills.soft.slice(0, 8)) sSkill(sk);
            }

            // ────────────────────────────────────────────────────────────
            // RIGHT COLUMN HEADER (mirrors cover letter header exactly)
            // ────────────────────────────────────────────────────────────

            // Name — large bold (same as cover letter)
            doc.font('FB').fontSize(18).fillColor('#000000');
            doc.text(strip(pi.full_name || 'YOUR NAME').toUpperCase(), CX, contentY, { lineBreak: false });

            // Contact details right-aligned (same as cover letter)
            doc.font('F').fontSize(9).fillColor('#4d4d4d');
            const rightX = PW - 30;
            if (pi.phone) {
                doc.text(strip(pi.phone), rightX - doc.widthOfString(strip(pi.phone)), contentY, { lineBreak: false });
            }
            if (pi.email) {
                doc.text(strip(pi.email), rightX - doc.widthOfString(strip(pi.email)), contentY + 14, { lineBreak: false });
            }
            if (pi.location) {
                doc.text(strip(pi.location), rightX - doc.widthOfString(strip(pi.location)), contentY + 28, { lineBreak: false });
            }
            contentY += 22;

            // Job title subtitle (same as cover letter "Applicant")
            const jobTitle = strip(resume.experience?.[0]?.role || 'Professional');
            doc.font('F').fontSize(11).fillColor('#666666');
            doc.text(jobTitle, CX, contentY, { lineBreak: false });
            contentY += 22;

            // Separator line (same as cover letter)
            doc.moveTo(CX, contentY).lineTo(PW - 30, contentY).lineWidth(1).strokeColor('#cccccc').stroke();
            contentY += 18;

            // ────────────────────────────────────────────────────────────
            // SUMMARY
            // ────────────────────────────────────────────────────────────
            if (resume.summary) {
                rSection('Professional Summary');
                const sumLines = resume.summary.split('\n').filter(l => l.trim());
                for (const line of sumLines) {
                    const isBullet = line.trim().startsWith('•');
                    const text = strip(line.replace(/^•\s*/, ''));
                    if (!text) continue;
                    if (isBullet) rBullet(text);
                    else rText(text);
                }
                contentY += 4;
            }

            // ────────────────────────────────────────────────────────────
            // EXPERIENCE
            // ────────────────────────────────────────────────────────────
            if (resume.experience?.length) {
                rSection('Experience');
                for (let i = 0; i < resume.experience.length; i++) {
                    const e = resume.experience[i];
                    const dates = [e.start_date, e.end_date].filter(Boolean).join(' – ');
                    rEntry(strip(e.role || ''), dates);
                    rSub([strip(e.company || ''), strip(e.location || '')].filter(Boolean).join('  |  '));
                    for (const h of (e.highlights || [])) rBullet(h);
                    contentY += 6;
                    if (i < resume.experience.length - 1) {
                        doc.moveTo(CX + 14, contentY).lineTo(PW - 30, contentY).lineWidth(0.3).strokeColor('#dddddd').stroke();
                        contentY += 6;
                    }
                }
            }

            // ────────────────────────────────────────────────────────────
            // EDUCATION
            // ────────────────────────────────────────────────────────────
            if (resume.education?.length) {
                rSection('Education');
                for (const e of resume.education) {
                    const deg = [strip(e.degree || ''), strip(e.field_of_study || '')].filter(Boolean).join(' — ');
                    rEntry(deg, strip(e.end_date || ''));
                    rSub(strip(e.institution || ''));
                    if (e.grade) {
                        checkBreak(15);
                        doc.font('F').fontSize(9.5).fillColor('#555555');
                        doc.text(`Grade: ${strip(e.grade)}`, CX + 16, contentY, { lineBreak: false });
                        contentY += 13;
                    }
                    contentY += 6;
                }
            }

            // ────────────────────────────────────────────────────────────
            // PROJECTS
            // ────────────────────────────────────────────────────────────
            if (resume.projects?.length) {
                rSection('Projects');
                for (const p of resume.projects) {
                    const titleType = strip(p.title || '') + (p.type ? `  (${strip(p.type)})` : '');
                    rEntry(titleType, '');
                    const about = strip(p.about || p.description || '');
                    if (about) rText(about);
                    if (p.role) {
                        checkBreak(15);
                        doc.font('FB').fontSize(9.5).fillColor('#1a1a2e');
                        doc.text('Role: ', CX + 16, contentY, { lineBreak: false, continued: true });
                        doc.font('F').fillColor('#3a6cb5');
                        doc.text(strip(p.role), { lineBreak: false });
                        contentY += 13;
                    }
                    for (const h of (p.role_highlights || [])) rBullet(h);
                    contentY += 6;
                }
            }

            doc.end();
        });
        // ⚠️ Charged HERE, not at the gate: the bytes exist by this line. The render can still fall
        // through Playwright to PDFKit and either can throw, and "I paid and got an error" is the
        // one outcome a paid download must never produce.
        await downloads.claimDownload(userId, { employer }, req);
        await history.record(userId, {
            kind: 'resume', employer, templateId: String(template || ''), templateName: templateNameOf(template),
            format: 'pdf', mode, fileName,
            payload: doc ? { template: String(template || ''), mode, docId: Number(doc.id) } : { template: String(template || ''), mode },
        }, req).catch(() => {});
        return res.json({ success: true, downloadUrl: `/api/download-resume/${encodeURIComponent(fileName)}`, creditsRemaining: Math.max(0, creditCheck.remaining - DOWNLOAD_CREDIT_COST) });
    } catch (e) {
        console.error('[resumeBuilder] generatePDF error:', e.message);
        return res.status(500).json({ error: 'Failed to generate PDF. Please try again.' });
    }
}

// POST /api/resume-builder/generate-docx — Word (.docx) export of the saved resume.
// Built programmatically with the `docx` library (docxBuilder) for clean Word
// formatting — independent of the PDF design templates. Same credit cost.
async function generateDocx(req, res) {
    // Same rule as the PDF: the FILE is a paid-plan feature (see generatePDF).
    const { doc, gone } = await resumeDocFor(req);
    if (gone) return docGone(res);
    const employer = billingEmployerOf(doc, req.body);
    {
        const gate = await downloads.canDownload(req.user.id, { employer }, req);
        if (!gate.allowed) {
            return res.status(403).json({
                error: gate.message || 'Previewing every design is free — downloading the file is part of the paid plans.',
                reason: gate.reason || 'paid_required',
            });
        }
    }
    const userId = req.user.id;
    try {
        let row;
        if (doc) {
            row = { resume_data: doc.payload };      // a stored employer document, billed to its employer (see generatePDF)
        } else {
            await ensureResumeTable();
            row = await dbConfig.get('SELECT resume_data FROM user_resumes WHERE user_id = $1', [userId]);
            if (!row || !row.resume_data) {
                return res.status(404).json({ error: 'No resume found. Please generate your resume first.' });
            }
        }

        // Optional profile photo — square (sidebar/banner) + rectangular (German/Europass header).
        let photoDataUri = null, photoRectUri = null;
        try {
            const uRow = await dbConfig.get('SELECT photo_path FROM users WHERE id = $1', [userId]);
            if (uRow && uRow.photo_path) {
                const photoPath = path.join(__dirname, '../../', uRow.photo_path);
                await fs.access(photoPath);
                photoDataUri = await loadPhotoDataUri(photoPath);
                try { photoRectUri = await loadPhotoDataUri(photoPath, 'rect'); } catch { photoRectUri = null; }
            }
        } catch { photoDataUri = null; }

        const { buildResumeDocx } = require('../utils/docxBuilder');
        const { template } = req.body || {};
        const tplId = TEMPLATE_IDS.includes(template) ? template : TEMPLATE_IDS[0];
        const resume = row.resume_data;
        const pi = resume.personal_info || {};
        const strip = (t) => String(t || '').replace(/<\/(p|div|li|h[1-6])>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#39;/gi, "'").replace(/&quot;/gi, '"').replace(/\*\*(.+?)\*\*/g, '$1').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();

        // Vary the Word layout/accent by the selected template, like the PDF — and, for a stored document, in its
        // employer's brand (docBrandOf: the accent, and the font when it is a Google family Word can substitute for).
        const docxBuffer = await buildResumeDocx(resume, { photo: photoDataUri, photoRect: photoRectUri, template: tplId, brand: doc ? docBrandOf(doc) : null });

        const safeName = strip(pi.full_name || 'Resume').replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '_');
        const fileName = `${safeName}_Resume_${Date.now()}.docx`;
        const tempDir = path.join(__dirname, '../../temp');
        await fs.mkdir(tempDir, { recursive: true });
        await fs.writeFile(path.join(tempDir, fileName), docxBuffer);

        await downloads.claimDownload(req.user.id, { employer }, req);
        // A document's history row re-downloads THAT document (downloads.js /again) in its own page mode.
        const docxMode = String((req.body && req.body.mode) || '') || (doc ? String(docModeOf(doc) || '') : '');
        await history.record(req.user.id, {
            kind: 'resume', employer,
            templateId: String((req.body && req.body.template) || ''), templateName: templateNameOf(req.body && req.body.template),
            format: 'docx', mode: docxMode, fileName,
            payload: doc
                ? { template: String((req.body && req.body.template) || ''), mode: docxMode, docId: Number(doc.id) }
                : { template: String((req.body && req.body.template) || ''), mode: docxMode },
        }, req).catch(() => {});
        return res.json({ success: true, downloadUrl: `/api/download-resume-docx/${encodeURIComponent(fileName)}` });
    } catch (e) {
        console.error('[resumeBuilder] generateDocx error:', e.message);
        return res.status(500).json({ error: 'Failed to generate Word document. Please try again.' });
    }
}

// POST /api/resume-builder/preview-templates — renders the saved resume in the
// templates recommended for a region (free) so the user can pick before download.

/** The photo's identity, folded into every render cache key — a new photo must invalidate. */
async function photoVersion(userId) {
    try {
        const ppath = await resolvePhotoPath(userId);
        if (ppath) return String((await fs.stat(ppath)).mtimeMs);
    } catch { /* unreadable → 'none', which is itself a distinct version */ }
    return 'none';
}

// ── Full-size design previews, cached on disk ────────────────────────────────────────────────────
// The GALLERY used to render every design it showed, every single time it was opened and again on
// every swatch tap — so opening it cost a serial chromium render per design, and the FIRST family
// in the list also paid the browser cold start on top. That is why one particular design always
// looked slow: nothing was ever reused.
//
// Same key as the Home thumbnails (resume version + photo version + template), different prefix and
// no downscale, because the gallery wants the full 794px page. Stored as JSON so the page HEIGHT
// travels with the image — it varies per design, and the client lays out against it.
const PREVIEW_KEEP = 150;
function previewFile(userId, row, tplId, pver) {
    const ver = new Date(row.updated_at || Date.now()).getTime() + ':' + pver + ':' + tplId;
    return path.join(__dirname, '../../temp', `resume_prev_${userId}_${String(ver).replace(/[^a-zA-Z0-9_]/g, '-')}.json`);
}
async function readPreviewCache(userId, row, tplId, pver) {
    try {
        const j = JSON.parse(await fs.readFile(previewFile(userId, row, tplId, pver), 'utf8'));
        return (j && j.image) ? j : null;
    } catch { return null; }
}
async function writePreviewCache(userId, row, preview, pver) {
    try {
        const tDir = path.join(__dirname, '../../temp');
        await fs.mkdir(tDir, { recursive: true });
        await fs.writeFile(previewFile(userId, row, preview.id, pver), JSON.stringify(preview));
    } catch { /* a cache miss next time is the only cost */ }
}
/** Keep the most recent PREVIEW_KEEP previews per user; drop the oldest. */
async function prunePreviews(userId) {
    try {
        const tDir = path.join(__dirname, '../../temp');
        const names = (await fs.readdir(tDir)).filter((n) => n.startsWith(`resume_prev_${userId}_`));
        if (names.length <= PREVIEW_KEEP) return;
        const stamped = await Promise.all(names.map(async (nm) => {
            try { return { nm, at: (await fs.stat(path.join(tDir, nm))).mtimeMs }; } catch { return { nm, at: 0 }; }
        }));
        stamped.sort((a, b) => b.at - a.at);
        for (const { nm } of stamped.slice(PREVIEW_KEEP)) fs.unlink(path.join(tDir, nm)).catch(() => {});
    } catch {}
}

async function previewTemplates(req, res) {
    const userId = req.user.id;
    const { region, ids } = req.body || {};
    try {
        // ── ids mode: the gallery asks for a small batch as the user scrolls/taps a swatch. ──
        // Rendering all 37 designs in one request is exactly the shape that used to break the
        // preview at NINE (multi-MB inline base64 + a serial chromium loop outliving the client
        // timeout) — so the batch is capped, and unknown ids are dropped rather than 500ing.
        const tpls = Array.isArray(ids) && ids.length
            ? [...new Set(ids)].slice(0, 6).map(id => TEMPLATES.find(t => t.id === id)).filter(Boolean)
            : templatesForRegion(region);                 // legacy region mode (older app builds)
        if (hasDocId(req.body)) {
            // The gallery for ONE employer's stored document renders that document — through the SAME cache as
            // Home's cards (docPages: uploads/.thumb_cache/<user>/, keyed by the document, its version, the photo,
            // the design and the brand it renders in, which is drawn INTO the page), never temp/. So the build's
            // pre-render of the top designs is the gallery's first previews already rendered, and a design the
            // gallery renders is Home's next card. Misses are rendered in ONE batch (the warm browser is reused).
            const doc = await loadResumeDoc(userId, req.body.docId, req);
            if (!doc) return res.status(404).json({ success: false, error: 'That version of your resume is no longer saved.', reason: 'doc_gone' });
            if (!tpls.length) return res.status(400).json({ error: 'No valid template ids.' });
            const pages = await docPages(userId, doc, tpls.map((t) => t.id), await photoVersion(userId), docBrandOf(doc));
            const got = tpls.map((t) => pages.get(t.id)).filter(Boolean);   // in the order asked for
            if (!got.length) return res.status(500).json({ error: 'Failed to render design previews. Please try again.' });
            pruneDocThumbs(userId, got.map((p) => p.file));                  // fire and forget
            console.log(`[resumeBuilder] previews for doc ${Number(doc.id)}: ${got.filter((p) => p.cached).length} cached, ${got.filter((p) => !p.cached).length} rendered`);
            const previews = got.map(({ id, name, accent, ats, image, width, height }) => ({ id, name, accent, ats, image, width, height }));
            return res.json({ success: true, region: region || 'generic', previews });
        }
        await ensureResumeTable();
        // ⚠️ updated_at IS HALF THE CACHE KEY (previewFile). It used to be missing from this SELECT, so
        // every key fell back to Date.now(): no gallery preview ever hit, and every batch wrote files
        // that only prunePreviews would ever touch again.
        const row = await dbConfig.get('SELECT resume_data, updated_at FROM user_resumes WHERE user_id = $1', [userId]);
        if (!row || !row.resume_data) {
            return res.status(404).json({ error: 'No resume found. Please generate your resume first.' });
        }
        if (!tpls.length) return res.status(400).json({ error: 'No valid template ids.' });
        // Serve what we already have; render only what is genuinely missing, in ONE batch so the
        // warm browser is reused. A second visit to the gallery renders nothing at all. (The base résumé
        // has no employer and no brand: its previews stay in temp/, keyed by resume version + photo + design.)
        const pver = await photoVersion(userId);
        const hits = [];
        const missing = [];
        for (const tpl of tpls) {
            const c = await readPreviewCache(userId, row, tpl.id, pver);
            if (c) hits.push(c); else missing.push(tpl);
        }
        let fresh = [];
        if (missing.length) {
            const { photo, photoRect } = await photosFor(userId);
            fresh = await renderPreviews(row.resume_data, { photo, photoRect }, missing);
            for (const p of fresh) await writePreviewCache(userId, row, p, pver);
            prunePreviews(userId);                       // fire and forget
        }
        // Answer in the order asked for, whatever came from where.
        const byId = new Map([...hits, ...fresh].map((p) => [p.id, p]));
        const previews = tpls.map((t) => byId.get(t.id)).filter(Boolean);
        console.log(`[resumeBuilder] previews: ${hits.length} cached, ${fresh.length} rendered`);
        return res.json({ success: true, region: region || 'generic', previews });
    } catch (e) {
        console.error('[resumeBuilder] previewTemplates error:', e.message);
        return res.status(500).json({ error: 'Failed to render design previews. Please try again.' });
    }
}

// GET /api/resume-builder/templates — the design catalogue for the app's gallery.
// Static metadata only (no rendering): 9 layout families, each with its recolored variants as
// swatches. The gallery shows ONE preview per family and recolors via swatch taps — previewing
// all 37 as full images is the load pattern the ids-mode cap above exists to prevent.
async function listTemplates(req, res) {
    // The gallery is about to ask for previews — start chromium + the font download NOW, in
    // parallel with the app's round trip, so the first render doesn't pay the cold start.
    warmPreviews();
    return res.json({ success: true, families: FAMILIES, regions: REGIONS, count: TEMPLATES.length });
}

// GET /api/resume-builder/home-thumb — the Home card's real preview of the user's built
// resume. Rendered ONCE per resume version and cached on disk (keyed by updated_at), then
// downscaled: the Home screen loads on every app open, so this must never cost a chromium
// render per view. 404 when no resume is built — the card falls back to its native mock.
// One template → a downscaled JPEG data URI, cached on disk per (user, resume version,
// template). The Home carousel shows several of these, and Home loads on every app open —
// so a cache MISS must be the rare case, never the norm.
const THUMB_W = 480;
async function cachedThumb(userId, row, tplId, tag = '') {
    // ⚠️ The profile photo is rendered INTO the card but used to be absent from the key, so
    // replacing a photo never invalidated anything — Home kept serving the old face until the
    // resume itself was next saved. Its mtime is part of the version now.
    const pver = await photoVersion(userId);
    const ver = new Date(row.updated_at || Date.now()).getTime() + ':' + pver + ':' + tag + ':' + tplId;
    const tDir = path.join(__dirname, '../../temp');
    await fs.mkdir(tDir, { recursive: true });
    const file = path.join(tDir, `resume_thumb_${userId}_${String(ver).replace(/[^a-zA-Z0-9_]/g, '-')}.jpg`);
    try {
        const buf = await fs.readFile(file);
        return { id: tplId, image: `data:image/jpeg;base64,${buf.toString('base64')}`, cached: true, file: path.basename(file) };
    } catch {}
    const { photo, photoRect } = await photosFor(userId);
    const [pv] = await renderPreviews(row.resume_data, { photo, photoRect }, TEMPLATES.filter((t) => t.id === tplId));
    const full = Buffer.from(pv.image.split(',')[1], 'base64');
    let thumb = full;
    try {
        const sharp = require('sharp');
        thumb = await sharp(full).resize({ width: THUMB_W }).jpeg({ quality: 80 }).toBuffer();
    } catch { /* sharp unavailable → serve full-size; heavier but correct */ }
    await fs.writeFile(file, thumb).catch(() => {});
    return { id: tplId, image: `data:image/jpeg;base64,${thumb.toString('base64')}`,
             width: pv.width, height: pv.height, cached: false, file: path.basename(file) };
}

// Drop every cached thumb for this user that is not in `keep` — one file per template per
// resume version would otherwise accumulate in temp/ forever.
// ⚠️ THIS USED TO DELETE EVERY THUMB NOT IN THE CURRENT RESPONSE. That was fine while Home showed
// one fixed set of 5, but Home now pages a large catalogue through here a handful of ids at a time —
// and under the old rule each wave deleted the previous wave's work, so nothing ever stayed cached
// and every scroll paid a fresh chromium render. It is an LRU now: the caller's ids are protected,
// and beyond that we keep the most recently used ones per user and drop only the oldest.
const THUMB_KEEP = 90;
async function pruneThumbs(userId, keep) {
    try {
        const tDir = path.join(__dirname, '../../temp');
        const names = await fs.readdir(tDir);
        const prefix = `resume_thumb_${userId}_`;
        const alive = new Set((keep || []).map((f) => path.basename(f)));
        const mine = names.filter((nm) => nm.startsWith(prefix) && !alive.has(nm));
        if (mine.length + alive.size <= THUMB_KEEP) return;
        const stamped = await Promise.all(mine.map(async (nm) => {
            try { return { nm, at: (await fs.stat(path.join(tDir, nm))).mtimeMs }; }
            catch { return { nm, at: 0 }; }
        }));
        stamped.sort((a, b) => b.at - a.at);                     // newest first
        for (const { nm } of stamped.slice(Math.max(0, THUMB_KEEP - alive.size))) {
            fs.unlink(path.join(tDir, nm)).catch(() => {});
        }
    } catch {}
}

async function homeThumb(req, res) {
    const userId = req.user.id;
    try {
        await ensureResumeTable();
        const row = await dbConfig.get('SELECT resume_data, updated_at, preferred_template FROM user_resumes WHERE user_id = $1', [userId]);
        if (!row || !row.resume_data) return res.status(404).json({ error: 'No resume yet.' });
        const tplId = row.preferred_template && TEMPLATE_IDS.includes(row.preferred_template) ? row.preferred_template : 'banner';
        const card = await cachedThumb(userId, row, tplId);
        return res.json({ success: true, image: card.image });
    } catch (e) {
        console.error('[resumeBuilder] homeThumb error:', e.message);
        return res.status(500).json({ error: 'Could not render the preview.' });
    }
}


// ── A sample resume, for an account that has not uploaded one yet ────────────────────────────────
// Home would otherwise be an empty screen for exactly the people who have never seen the product do
// anything. This renders the SAME templates against a stand-in resume built from the only two facts
// registration already gave us — their name and their email — with the rest invented.
//
// ⚠️ IT IS NEVER WRITTEN ANYWHERE. It is not saved to user_resumes, it is not used for applying or
// attaching, and the response carries `sample: true` so the UI can label it. Nothing here may be
// mistaken for the user's own resume, and nothing here may overwrite one.
async function sampleResumeFor(userId) {
    let name = 'Your Name';
    let email = '';
    try {
        const u = await dbConfig.get('SELECT full_name, email FROM users WHERE id = $1', [userId]);
        if (u) {
            name = String(u.full_name || '').trim() || name;
            email = String(u.email || '').trim();
        }
    } catch { /* a sample is better than no screen — fall back to the neutral name */ }

    const data = {
        personal_info: {
            full_name: name,
            title: 'Software Engineer',
            email,
            phone: '+00 000 000 000',
            location: 'City, Country',
            linkedin_url: '',
        },
        summary: 'Engineer with five years building and shipping web products end to end. Comfortable owning a feature from problem statement through to production, and happiest where design and delivery meet.',
        experience: [
            {
                role: 'Senior Software Engineer', company: 'Northwind Technologies', location: 'Remote',
                start_date: '2023-01', end_date: '',
                highlights: [
                    'Led the rebuild of the checkout flow, cutting drop-off by 18%.',
                    'Introduced automated release checks that took deploys from weekly to daily.',
                    'Mentored three engineers through their first year on the team.',
                ],
            },
            {
                role: 'Software Engineer', company: 'Bright Harbour Ltd', location: 'London, UK',
                start_date: '2020-06', end_date: '2022-12',
                highlights: [
                    'Built the reporting service still used by every customer-facing dashboard.',
                    'Reduced median API response time from 800ms to 180ms.',
                ],
            },
        ],
        education: [
            { degree: 'BSc', field_of_study: 'Computer Science', institution: 'University of Somewhere', start_date: '2016-09', end_date: '2020-05' },
        ],
        projects: [
            { name: 'Open-source CLI', description: 'A small tool for diffing API schemas, used by a few hundred developers.' },
        ],
        skills: {
            technical: ['JavaScript', 'TypeScript', 'React', 'Node.js', 'PostgreSQL', 'Docker', 'AWS'],
            soft: ['Mentoring', 'Written communication', 'Product sense'],
        },
        certifications: [],
        languages: ['English'],
        achievements: [],
    };
    // Stable per (name, email) so the cache survives restarts but re-renders if they change either.
    let h = 0;
    const k = name + '|' + email;
    for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0;
    return { data, tag: 'sample' + h.toString(36) };
}

/**
 * home-cards' `hasResume`: does this user hold a résumé a build can be written FROM — a builder row with
 * content, or an upload the base narrative reads (narrativeFor base — the same read source-text?base=1
 * serves Home as rawText)?
 *
 * ⚠️ `sample` IS NOT THAT ANSWER. sample only says "no builder row", and a user who UPLOADED a résumé but
 * never opened the builder has no builder row — so Home keyed on sample replaced "Write my cover letter" and
 * "Tailor my resume" with "Build your resume first" for people whose résumé we hold and can build from.
 * ⚠️ A FAILED READ IS NOT "NO RÉSUMÉ": it degrades to the old answer (a builder row or not), never to false
 * for someone who has one. A résumé too thin to write from still reaches the build's own 400 no_resume.
 */
async function hasResumeToBuildFrom(userId, builderData, req) {
    let rd = builderData;
    if (typeof rd === 'string') { try { rd = JSON.parse(rd); } catch { rd = null; } }
    if (rd && typeof rd === 'object' && Object.keys(rd).length) return true;
    try {
        const n = await require('../services/resumeScorer').narrativeFor(userId, { base: true, env: req, strict: true });
        return !!(n && n.text);
    } catch (e) {
        console.warn('[resumeBuilder] home-cards résumé check failed — answering from the builder row alone:', e.message);
        return builderData != null;
    }
}

// GET /api/resume-builder/home-cards?ids=banner,rightrail,mono
// The employer-Home carousel: the user's REAL resume rendered in several designs. Every card is
// disk-cached per resume version, so the first open after a (re)generate pays the renders and
// every open after that is a file read.
//
// ⚠️ Capped at 5 — the renderer recycles its browser every 3 pages (single-process chromium dies
// after ~4-5 in a session), and Home must never be the screen that melts the preview pipeline.
async function homeCards(req, res) {
    // ?doc=<id> — one employer's stored document, ranked by its design: see docHomeCards.
    if (req.query && req.query.doc !== undefined) return docHomeCards(req, res);
    const userId = req.user.id;
    try {
        await ensureResumeTable();
        let row = await dbConfig.get('SELECT resume_data, updated_at, preferred_template FROM user_resumes WHERE user_id = $1', [userId]);
        // No resume yet → show the designs against a clearly-labelled sample rather than an empty
        // screen. `sample` rides the response all the way to the UI.
        let sample = false;
        let tag = '';
        if (!row || !row.resume_data) {
            const sm = await sampleResumeFor(userId);
            row = { resume_data: sm.data, updated_at: new Date(0), preferred_template: null };
            sample = true;
            tag = sm.tag;
        }
        const asked = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean);
        const pref = row.preferred_template && TEMPLATE_IDS.includes(row.preferred_template) ? row.preferred_template : null;
        // What the client ASKED for wins, then the user's own pick, then a default spread across
        // visually distinct families — de-duped and cut to 5.
        // ⚠️ Order is load-bearing: `pref` used to be prepended, so a full 5-id request silently
        // lost its 5th card to the slice, and the client marks any id missing from the response as
        // permanently dead — that slot stayed blank forever. Never push anything ahead of `asked`.
        // On the first load `asked` is empty (no ?ids), so `pref` still leads.
        const fallback = ['banner', 'rightrail', 'elegant', 'mono', 'timeline'];
        const ids = [...new Set([...asked, pref, ...fallback].filter((id) => id && TEMPLATE_IDS.includes(id)))].slice(0, 5);
        const cards = [];
        const files = [];
        for (const id of ids) {
            try {
                const c = await cachedThumb(userId, row, id, tag);
                const meta = TEMPLATES.find((t) => t.id === id) || {};
                cards.push({ id, name: meta.name || id, accent: meta.accent || '#4F8DFF', ats: meta.ats || null, image: c.image });
                files.push(c.file); // ⚠️ never recompute this key — pruneThumbs deletes anything not in the list
            } catch (e) { console.warn('[resumeBuilder] homeCards render failed for', id, e.message); }
        }
        if (!cards.length) return res.status(500).json({ error: 'Could not render previews.' });
        pruneThumbs(userId, files);
        // `preferred` names a card in THIS response, not the stored pick: an ids-scoped request may
        // legitimately not render the stored pick (and a render can fail), so fall back to the first
        // card actually returned rather than pointing at an id the payload does not contain.
        const preferred = pref && cards.some((c) => c.id === pref) ? pref : cards[0].id;
        const hasResume = await hasResumeToBuildFrom(userId, sample ? null : row.resume_data, req);
        return res.json({ success: true, preferred, hasResume, cards, sample });
    } catch (e) {
        console.error('[resumeBuilder] homeCards error:', e.message);
        return res.status(500).json({ error: 'Could not render previews.' });
    }
}

// ── Employer-document pages and cards: a persistent, private, per-user LRU ─────────────────────────
// Home switches between employers constantly, and each chip's carousel is THAT employer's resume in its
// best-ranked designs; the gallery shows the same document at full size. temp/ is wiped by every deploy,
// so a render there would be a chromium render per card again after each release — these live on the
// uploads VOLUME instead.
//
// ⚠️ ONE CACHE FOR THE GALLERY AND THE CARDS (2026-09-15). The gallery's doc-mode previews used to live in
// temp/ as JSON while Home's cards lived here as 480-px thumbs, so the build's pre-render warmed the cards
// and the gallery's first (visible) design still paid a cold chromium render, its neighbours arriving after
// a scroll. What is stored now is the FULL-SIZE 794-px page (docPages), per (user, document, its updated_at,
// the photo's version, the design, the brand it renders in — brandKeyOf); the 480-px card (docThumb) is
// DERIVED from it with sharp on first read and stored alongside under the page's name suffixed .w480. The
// build's pre-render of the top designs is therefore the gallery's first previews, and a design the gallery
// renders is Home's next card.
//
// ⚠️ A DOT DIRECTORY, ON PURPOSE. server.js serves uploads/ publicly (express.static), and a page is
// someone's resume with their photo on it. serve-static's default `dotfiles: 'ignore'` answers 404 for
// any path with a segment starting with "." — verified against this repo's node_modules (serve-static
// 2.2.0 / send 1.2.0): /uploads/.thumb_cache/<id>/<file> is a 404, including %2E-encoded and ../ forms,
// and res.sendFile refuses it the same way. File names are sha256 hashes, so nothing in a name is
// guessable either. ⚠️ Do not rename this directory to one without the leading dot.
//
// An edit, a rebuild, a new photo or a brand that changed is a different file, never a stale image. Letter
// thumbs (cl_ prefix) share the directory; this LRU only ever counts and deletes its own names (64 hex
// characters, with or without the card suffix).
const DOC_THUMB_ROOT = path.join(__dirname, '../../uploads/.thumb_cache');
const DOC_THUMB_KEEP = 240;
const DOC_CARD_SUFFIX = `.w${THUMB_W}`;                                            // "<page>.w480.jpg" is the card of "<page>.jpg"
const DOC_THUMB_NAME = new RegExp(`^[0-9a-f]{64}(?:\\${DOC_CARD_SUFFIX})?\\.jpg$`);
const DOC_PAGE_W = 794;                                                            // the renderer's A4 width, for a page whose header cannot be read
const DOC_PAGE_H = 1123;
const docThumbDirOf = (userId) => path.join(DOC_THUMB_ROOT, String(parseInt(userId, 10) || 0));
const docThumbFlights = new Map();   // absolute path of a page → Promise<page> — one render per file, however many ask

/** The page file of one design of one stored document. v3: the file IS the full-size page (v2 files were cards). */
function docPageNameOf(userId, doc, pver, tplId, brand) {
    const ms = new Date(doc.updated_at || 0).getTime() || 0;
    return crypto.createHash('sha256')
        .update(['resume-doc-page:v3', userId, doc.id, ms, pver, tplId, brandKeyOf(brand)].join('|'))
        .digest('hex') + '.jpg';
}
/** The card derived from a page: the page's name, suffixed. */
const docCardNameOf = (pageName) => pageName.replace(/\.jpg$/, `${DOC_CARD_SUFFIX}.jpg`);

/** The pixel size of a JPEG from its frame header, { width, height } — or null when the bytes are not one. */
function jpegSizeOf(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    let i = 2;
    while (i + 9 <= buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }                                         // fill bytes between segments
        const marker = buf[i + 1];
        if (marker === 0xff) { i++; continue; }
        if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }   // standalone markers
        if (marker === 0xd9 || marker === 0xda) return null;                            // the image ended, or the scan began, before a frame header
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }; // SOFn: length, precision, height, width
        }
        i += 2 + buf.readUInt16BE(i + 2);
    }
    return null;
}

/** A cached file's bytes — touching its mtime, because this is an LRU and a read is a use — or null. */
async function readDocFile(abs) {
    try {
        const buf = await fs.readFile(abs);
        const now = new Date();
        fs.utimes(abs, now, now).catch(() => {});
        return buf;
    } catch { return null; }
}

/** Written aside and renamed in, so a reader never gets half a JPEG. Never throws — a miss next time is the only cost. */
async function writeDocFile(dir, name, buf) {
    try {
        await fs.mkdir(dir, { recursive: true });
        const abs = path.join(dir, name);
        const tmp = `${abs}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
        await fs.writeFile(tmp, buf);
        await fs.rename(tmp, abs);
    } catch (e) { console.warn('[resumeBuilder] doc page not cached:', e.message); }
}

/**
 * A page answer from its bytes: the catalogue's name and ats, the accent the page shows (brandedTemplate — every
 * variant is re-hued to the brand, so the catalogue swatch would promise a colour that never arrives), the size from
 * the JPEG header (the renderer's A4 width and height when the bytes are not a JPEG the parser reads), and `file` —
 * the name the LRU keeps alive.
 */
function docPageOf(tpl, brand, name, buf, cached) {
    const size = jpegSizeOf(buf) || { width: DOC_PAGE_W, height: DOC_PAGE_H };
    let accent = (brand && brand.accent) || tpl.accent;
    try { accent = brandedTemplate(tpl, brand).accent || accent; } catch { /* an unreadable brand: the accent it names */ }
    return {
        id: tpl.id, name: tpl.name, accent, ats: tpl.ats || null,
        image: `data:image/jpeg;base64,${buf.toString('base64')}`, width: size.width, height: size.height, file: name, cached,
    };
}

/**
 * The full-size pages of one stored document in the designs asked for → Map id → { id, name, accent, ats, image,
 * width, height, file, cached }: from the cache where the page exists, else rendered in ONE renderPreviews batch (the
 * warm browser is reused) and stored. A design already rendering for another request (docThumbFlights) is awaited,
 * never rendered twice; a design whose render failed is absent from the answer (callers treat a missing id as
 * "could not render"). `brand` is the document's (docBrandOf), which every caller passes so the key and the page
 * agree. Never throws.
 */
async function docPages(userId, doc, tplIds, pver, brand = null) {
    const dir = docThumbDirOf(userId);
    const out = new Map();
    const misses = [];                 // { tpl, name, settle }
    const awaited = [];                // [id, another request's flight]
    for (const id of [...new Set(tplIds)]) {
        const tpl = TEMPLATES.find((t) => t.id === id);
        if (!tpl) continue;
        const name = docPageNameOf(userId, doc, pver, id, brand);
        const abs = path.join(dir, name);
        const buf = await readDocFile(abs);
        if (buf && buf.length) { out.set(id, docPageOf(tpl, brand, name, buf, true)); continue; }
        if (docThumbFlights.has(abs)) { awaited.push([id, docThumbFlights.get(abs)]); continue; }
        let settle = null;
        const flight = new Promise((resolve, reject) => { settle = { resolve, reject }; });
        flight.catch(() => {});                                                       // a failed render is reported by absence, never as an unhandled rejection
        docThumbFlights.set(abs, flight);
        flight.finally(() => { if (docThumbFlights.get(abs) === flight) docThumbFlights.delete(abs); }).catch(() => {});
        misses.push({ tpl, name, settle });
    }
    if (misses.length) {
        let rendered = [];
        try {
            const { photo, photoRect } = await photosFor(userId);
            rendered = await renderPreviews(doc.payload, { photo, photoRect, brand }, misses.map((m) => m.tpl));
        } catch (e) { console.warn('[resumeBuilder] doc page render failed:', e.message); }
        const byId = new Map((Array.isArray(rendered) ? rendered : []).map((p) => [p.id, p]));
        for (const m of misses) {
            const pv = byId.get(m.tpl.id);
            const full = Buffer.from(String((pv && pv.image) || '').split(',')[1] || '', 'base64');
            if (!full.length) { m.settle.reject(new Error(`could not render ${m.tpl.id}`)); continue; }
            await writeDocFile(dir, m.name, full);
            const page = docPageOf(m.tpl, brand, m.name, full, false);
            // A fresh render knows its own size and accent better than the header parser does.
            if (Number(pv.width) > 0 && Number(pv.height) > 0) { page.width = Number(pv.width); page.height = Number(pv.height); }
            if (typeof pv.accent === 'string' && pv.accent) page.accent = pv.accent;
            out.set(m.tpl.id, page);
            m.settle.resolve(page);
        }
    }
    for (const [id, flight] of awaited) {
        try { out.set(id, await flight); } catch { /* that request's render failed: absent here too */ }
    }
    return out;
}

/**
 * One design of one stored document → { image, name, names } for Home's card: a 480-px JPEG data URI. Read from the
 * card file, else derived with sharp from the page (docPages: the cache, or a render) and stored alongside it; without
 * sharp — or on bytes it cannot read — the page itself is served, heavier but correct, and no card is written.
 * `name` is the file served, `names` every file this answer keeps alive (the card and its page) for the LRU. Throws
 * on a failed render.
 */
async function docThumb(userId, doc, tplId, pver, brand = null) {
    const tpl = TEMPLATES.find((t) => t.id === tplId);
    if (!tpl) throw new Error(`unknown design ${tplId}`);
    const dir = docThumbDirOf(userId);
    const pageName = docPageNameOf(userId, doc, pver, tplId, brand);
    const cardName = docCardNameOf(pageName);
    const card = await readDocFile(path.join(dir, cardName));
    if (card && card.length) {
        const now = new Date();
        fs.utimes(path.join(dir, pageName), now, now).catch(() => {});                 // the pair ages together
        return { image: `data:image/jpeg;base64,${card.toString('base64')}`, name: cardName, names: [cardName, pageName] };
    }
    const page = (await docPages(userId, doc, [tplId], pver, brand)).get(tplId);
    if (!page) throw new Error(`could not render ${tplId}`);
    const full = Buffer.from(page.image.split(',')[1] || '', 'base64');
    let thumb = null;
    try { thumb = await require('sharp')(full).resize({ width: THUMB_W }).jpeg({ quality: 80 }).toBuffer(); }
    catch { /* sharp unavailable, or bytes it cannot read → the page is served as it is */ }
    if (thumb) await writeDocFile(dir, cardName, thumb);
    return thumb
        ? { image: `data:image/jpeg;base64,${thumb.toString('base64')}`, name: cardName, names: [cardName, pageName] }
        : { image: page.image, name: pageName, names: [pageName] };
}

/** Keep the DOC_THUMB_KEEP most recently used pages and cards for this user; `keep` (names) is never deleted. */
async function pruneDocThumbs(userId, keep) {
    try {
        const dir = docThumbDirOf(userId);
        const names = await fs.readdir(dir);
        const alive = new Set(keep || []);
        const now = Date.now();
        // A crash between write and rename leaves a .tmp behind; anything older than ten minutes is litter.
        for (const nm of names.filter((n) => n.endsWith('.tmp'))) {
            fs.stat(path.join(dir, nm)).then((st) => { if (now - st.mtimeMs > 10 * 60 * 1000) return fs.unlink(path.join(dir, nm)); }).catch(() => {});
        }
        const mine = names.filter((nm) => DOC_THUMB_NAME.test(nm) && !alive.has(nm));
        if (mine.length + alive.size <= DOC_THUMB_KEEP) return;
        const byUse = await Promise.all(mine.map(async (nm) => {
            try { return { nm, used: (await fs.stat(path.join(dir, nm))).mtimeMs }; }
            catch { return { nm, used: 0 }; }
        }));
        byUse.sort((x, y) => y.used - x.used);                        // most recently used first
        for (const { nm } of byUse.slice(Math.max(0, DOC_THUMB_KEEP - alive.size))) {
            fs.unlink(path.join(dir, nm)).catch(() => {});
        }
    } catch { /* no directory yet, or unreadable: nothing to prune */ }
}

/**
 * GET /api/resume-builder/home-cards?doc=<id>&ids=a,b — Home's carousel for ONE employer's document.
 *   → { success, preferred: <the design's top id>, cards: [{ id, name, accent, ats, image, fit, reason }], sample: false }
 *   → 404 { success: false, reason: 'doc_gone' }
 *
 * ids = the ids asked for that exist in the catalogue, or the design's top 5 when none are asked.
 * ⚠️ NO PADDING, unlike the base path: the client pages the design's ranked order through here and marks
 * an asked id missing from the reply as dead for that document version — a card it did not ask for would
 * be a card it has nowhere to put. Still capped at 5 (the chromium crash threshold — see homeCards).
 * A render failure is a 500, not an empty 200, so the client retries instead of burying those cards.
 */
async function docHomeCards(req, res) {
    const userId = req.user.id;
    try {
        const doc = await loadResumeDoc(userId, req.query.doc, req);
        if (!doc) return res.status(404).json({ success: false, reason: 'doc_gone', error: 'That version of your resume is no longer saved.' });
        const design = docDesignOf(doc);
        // The brand every card is drawn in — the design's (docDesignOf attaches docBrandOf's answer), else the
        // document's own reading when designFit is out. Also each card's `accent`: with a brand, every variant
        // is recoloured to that hue, so the catalogue swatch colour would promise a page that never arrives.
        const brand = (design && design.brand) || docBrandOf(doc);
        const ranked = design && Array.isArray(design.ranked) ? design.ranked : [];
        const byId = new Map(ranked.map((r) => [r.id, r]));
        const asked = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean);
        const order = asked.length ? asked.filter((id) => TEMPLATE_IDS.includes(id))
            : (ranked.length ? ranked.map((r) => r.id) : TEMPLATE_IDS);
        const ids = [...new Set(order)].slice(0, 5);
        const pver = await photoVersion(userId);
        const cards = [];
        const names = [];
        for (const id of ids) {
            try {
                const c = await docThumb(userId, doc, id, pver, brand);
                const meta = TEMPLATES.find((t) => t.id === id) || {};
                const r = byId.get(id);
                cards.push({
                    id, name: meta.name || id, accent: (brand && brand.accent) || meta.accent || '#4F8DFF', ats: meta.ats || null, image: c.image,
                    fit: r ? r.score : null, reason: r && r.reason ? r.reason : null,
                });
                names.push(...c.names);                                // the card and its page both stay
            } catch (e) { console.warn('[resumeBuilder] doc card render failed for', id, e.message); }
        }
        if (ids.length && !cards.length) return res.status(500).json({ success: false, error: 'Could not render previews.' });
        pruneDocThumbs(userId, names);                                 // fire and forget
        const preferred = (ranked[0] && ranked[0].id) || (cards[0] && cards[0].id) || null;
        return res.json({ success: true, preferred, cards, sample: false });
    } catch (e) {
        console.error('[resumeBuilder] doc homeCards error:', e.message);
        return res.status(500).json({ success: false, error: 'Could not render previews.' });
    }
}

/**
 * Right after a paid document is stored: render its top designs' pages into the shared cache, so the gallery's first
 * previews are already there and the carousel's cards (derived from them on first read — docThumb) show pages rather
 * than skeletons. Bounded (`budgetMs`) — a slow chromium must not hold the build's answer; whatever is still
 * rendering then finishes into the cache on its own. `brand` is the one the build stored on the design — the key
 * home-cards and the gallery will compute from the row. Never throws: the document is already stored and paid for.
 */
async function prerenderDocPages(userId, docId, payload, design, brand, count, budgetMs) {
    try {
        // The key needs the row's own updated_at — exactly what home-cards and the gallery will read back.
        const row = await dbConfig.get('SELECT updated_at FROM user_employer_documents WHERE id = $1 AND user_id = $2', [docId, userId]);
        if (!row || !row.updated_at) return;
        const doc = { id: docId, updated_at: row.updated_at, payload };
        const ranked = design && Array.isArray(design.ranked) ? design.ranked.map((r) => r.id) : TEMPLATE_IDS;
        const ids = ranked.filter((id) => TEMPLATE_IDS.includes(id)).slice(0, count);
        const work = (async () => {
            const pages = await docPages(userId, doc, ids, await photoVersion(userId), brand);
            for (const id of ids) if (!pages.has(id)) console.warn('[resumeBuilder] doc page pre-render failed for', id);
            pruneDocThumbs(userId, [...pages.values()].map((p) => p.file));
        })().catch((e) => console.warn('[resumeBuilder] doc page pre-render skipped:', e.message));
        let timer = null;
        await Promise.race([work, new Promise((resolve) => { timer = setTimeout(resolve, budgetMs); if (timer.unref) timer.unref(); })]);
        if (timer) clearTimeout(timer);
    } catch (e) { console.warn('[resumeBuilder] doc page pre-render skipped:', e.message); }
}

// Reusable: build a REGION-formatted resume PDF from the user's Resume-Builder resume.
// Returns { filePath, fileName } or null when no builder resume exists (caller then
// falls back to the uploaded profile resume). Used by the email-send flow (point 4).
async function buildResumePdfForRegion(userId, region, mode) {
    await ensureResumeTable();
    const row = await dbConfig.get('SELECT resume_data, preferred_template FROM user_resumes WHERE user_id = $1', [userId]);
    if (!row || !row.resume_data) return null; // no builder resume → caller uses uploaded PDF

    const resume = row.resume_data;
    // The user's gallery pick wins; the region's first template is only the fallback for users
    // who never opened the gallery.
    const pref = row.preferred_template && TEMPLATE_IDS.includes(row.preferred_template) ? row.preferred_template : null;
    const tpls = templatesForRegion(region);
    const tplId = pref || (tpls && tpls[0] && tpls[0].id) || TEMPLATE_IDS[0];
    const needsRect = tplId === 'germany' || tplId === 'europass';

    const ppath = await resolvePhotoPath(userId);
    const photo = await loadPhotoDataUri(ppath);
    const photoRect = needsRect ? await loadPhotoDataUri(ppath, 'rect') : null;
    const pdfBuffer = await renderPdf(tplId, resume, { photo, photoRect, mode: mode || 'a4' });

    const pi = resume.personal_info || {};
    const strip = (t) => String(t || '').replace(/<\/(p|div|li|h[1-6])>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#39;/gi, "'").replace(/&quot;/gi, '"').replace(/\*\*(.+?)\*\*/g, '$1').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
    const tSafe = strip(pi.full_name || 'Resume').replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '_');
    const fileName = `${tSafe}_Resume_${Date.now()}.pdf`;
    const tDir = path.join(__dirname, '../../temp');
    await fs.mkdir(tDir, { recursive: true });
    const filePath = path.join(tDir, fileName);
    await fs.writeFile(filePath, pdfBuffer);
    return { filePath, fileName, template: tplId };
}

module.exports = {
    previewFile, readPreviewCache, writePreviewCache, generateAI, generationGate, saveResume, getResume, generatePDF, generateDocx, previewTemplates, listTemplates, homeThumb, homeCards, buildResumePdfForRegion, buildParsePrompt,   // buildParsePrompt exported for tests only
    // The employer-doc lane: the fingerprint /api/employer-docs/current labels staleness with, and the
    // prompt + placeholder guard + the sameness measure (exported for tests).
    currentResumeFingerprint, buildEmployerDocPrompt, findPlaceholders, stripPlaceholders, tokenJaccard,
    // ⚠️ The other half of that label: the fingerprint cannot see the country (it is not hashed, and must not
    // be), so /api/employer-docs/current asks this whether the row was written for somewhere else — the same
    // answer the build's cache step gives, from the one implementation both use.
    docWrittenElsewhere,
    docSamenessOf, baseTopLinesOf, docSamenessText,   // the sameness guard and its log phrase, exported for tests only
    // The design every read of a stored employer document shows (/api/employer-docs/current and GET /:id use it too),
    // and the brand it renders in (employerDocsRoutes attaches it on the paths that do not re-rank).
    rerankStoredDesign, rerankStoredResumeDesign, docBrandOf, withSharedBrand, brandKeyOf,
};
