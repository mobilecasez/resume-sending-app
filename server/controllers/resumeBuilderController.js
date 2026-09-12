// Resume Builder — new feature. Safe to delete without affecting existing app.
'use strict';

const dbConfig     = require('../../db-config');
const axios        = require('axios');
const cheerio      = require('cheerio');
const path         = require('path');
const fs           = require('fs').promises;
const crypto       = require('crypto');
const { renderPdf, renderPreviews, warmPreviews } = require('../utils/resumeRenderer');
const { TEMPLATES, TEMPLATE_IDS, FAMILIES, REGIONS, templatesForRegion } = require('../utils/resumeTemplates');
const { getEventCost } = require('../services/eventCosts');
const entitlements = require('../services/entitlements');
const downloads = require('../services/downloads');
const history = require('../services/downloadHistory');
const jobService = require('../services/jobService');
const employerDocs = require('../services/employerDocs');

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

// ── Gemini call with 90-second hard timeout ───────────────────────────────────
// responseMimeType forces valid-JSON decoding (prompt already demands raw JSON, so
// the CONTENT is unchanged — this only guarantees the syntax). maxOutputTokens was
// 8192, which big resumes (esp. with "include uploaded resume") overflowed — Gemini
// then truncated mid-JSON and JSON.parse threw. 2.5-flash also spends "thinking"
// tokens from the same budget, so the cap must be generous; it does NOT change the
// output, only stops it being cut off.
async function callGemini(prompt) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
        model: RESUME_MODEL,
        generationConfig: { temperature: 0.4, maxOutputTokens: 32768, responseMimeType: 'application/json' },
    });

    const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('AI_TIMEOUT')), 90_000)
    );

    const result = await Promise.race([
        model.generateContent(prompt),
        timeoutPromise,
    ]);
    const finishReason = result.response.candidates?.[0]?.finishReason || '';
    return { text: result.response.text().trim(), finishReason };
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
 * Output = the resume JSON schema buildParsePrompt uses (so every template renders it) PLUS a `design`
 * object that generateEmployerDoc strips before storing: the payload is the resume and nothing else.
 */
function buildEmployerDocPrompt({ name, email, phone, location, rawText, uploadedResumeContext, job, research, familyBrief, country } = {}) {
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
${researchBlock ? `${researchBlock}\n` : ''}
=== WHAT YOU MAY CHANGE (this is a full rewrite for ${company}) ===
- Rewrite \`personal_info.title\` and \`summary\` for what ${company} needs from someone with THIS candidate's real background: its industry, its priorities, its vocabulary.
- Rewrite the wording of every experience highlight and project bullet in the vocabulary ${company} uses — only where it describes the SAME thing the candidate did. Re-wording is not a licence to claim.
- Reorder the highlights inside each experience entry, the projects, and \`skills.technical\` / \`skills.soft\`, so what matters most to ${company} comes first.
- Condense highlights that are clearly irrelevant to ${company}: shorten them, or merge two minor ones into one line. Condense — never drop an entry: every experience entry and every education entry must still appear.
- Choose one-page or A4 (\`design.mode\` below).

=== WHAT YOU MUST NEVER DO ===
- NEVER invent or add any employer, job title, date, degree, certification, skill, tool, technology, metric, number, percentage, client, award or achievement that the candidate's own material does not state. A skill ${company} wants that the candidate never mentioned stays out.
- NEVER imply more years of experience, seniority or scope than the material states.
- NEVER write a placeholder or a bracket: no [X%], [N], [$X], [Insert metric], [Company Name], XX%. When the material has no number for an achievement, write the sentence without a number.
- NEVER address ${company}: its name must not appear in the title, the summary or a bullet as the company this resume is for. Where the candidate's own material already contains the name — an employer or school they were actually at, or a product they used — keep it exactly as they wrote it.
- NEVER state or imply facts about ${company} (its products, customers, mission, values, size or news). The resume is about the candidate only; anything you know about ${company} only decides emphasis, wording and design.
- Keep every employer name, job title, institution, degree and date as the material gives them (a standard degree abbreviation may be expanded, e.g. "BCA" → "Bachelor of Computer Applications (BCA)").

=== ⚠️ ZERO-MISS RULE ===
Tailoring never loses information. Every job, internship, freelance role, project, education entry (including school level: Class X / Class XII), grade, certification, spoken language and achievement in the material must appear in the JSON. When unsure whether something belongs, INCLUDE IT.

=== WRITING RULES ===
- Summary: implied first person — never "I", "me", "my", the candidate's name, "he", "she" or "they". A tight paragraph of 3-4 sentences, then exactly 3 bullets; separate them with \\n and start each bullet with "• ". Wrap 3-6 genuinely important terms per sentence in **double asterisks** (technologies, domains, years of experience the material states). No clichés ("passionate", "go-getter", "team player", "proven track record").
- Experience highlights: one sentence each, at most 22 words, starting with a strong past-tense action verb, outcome first. Use a number ONLY when the material states that number.
- Projects: "about" is 1-2 sentences on what the project is, from the material only; "role" is the candidate's role; "role_highlights" are 2-3 action-verb bullets.
- Dates: "Month YYYY" or "Present"; a year alone is fine for education.
- Education "grade": exactly as written (e.g. "85.40%", "8.5 CGPA"), else "".
- personal_info.nationality and personal_info.date_of_birth: ONLY if the material states them, else "".
- Write in the same language as the candidate's material.

=== DESIGN — how well each layout family fits THIS candidate applying to ${company} ===
${familyBrief || localFamilyBrief()}
- Score EVERY family id above from 0 to 100. Weigh how strictly ${company} is likely to screen with ATS software (large employers; the US, the UK and India), photo conventions where the candidate is applying (expected in Germany, Austria and Switzerland; unusual in the US and the UK), the candidate's seniority, and ${company}'s industry and tone.
- Give each family a "reason" of at most 90 characters, written to the candidate, e.g. "Plain layout that large banks' screening software reads reliably".
- "mode": "onepage" for a concise early-career resume or where one page is the norm; "a4" when the candidate's real material needs the room.
- "tone": at most 40 characters naming the look that suits ${company}, e.g. "Conservative enterprise".
- "headline": at most 120 characters telling the candidate why your top-scored family suits ${company}. Say nothing about ${company} that the research above does not support.

=== REQUIRED OUTPUT SCHEMA (return ONLY this JSON) ===
{
  "personal_info": {
    "full_name": "",
    "email": "",
    "phone": "",
    "location": "",
    "linkedin_url": "",
    "portfolio_url": "",
    "title": "Professional headline aimed at the roles ${company} hires for, supported by the material — never the company's name",
    "nationality": "ONLY if the material states it, else empty string",
    "date_of_birth": "ONLY if the material states it, else empty string"
  },
  "summary": "3-4 sentence implied-first-person paragraph, then exactly 3 bullets using the bullet prefix and newline separator",
  "experience": [
    { "company": "", "role": "", "location": "", "start_date": "", "end_date": "", "highlights": ["Action-verb achievement, a number only when the material states it"] }
  ],
  "education": [
    { "institution": "", "degree": "", "field_of_study": "", "end_date": "", "grade": "" }
  ],
  "projects": [
    { "title": "", "type": "", "link": "", "about": "", "role": "", "role_highlights": [""] }
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
Certifications, languages and achievements: ONLY those the material mentions; otherwise return an empty array [].`;
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

// ══════════════════════════════════════════════════════════════════════════════
// ROUTE HANDLERS
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/resume-builder/generate-ai
async function generateAI(req, res) {
    // Home's employer documents are their own lane: stored per employer, never in user_resumes — see
    // generateEmployerDoc. Everything below this line is the builder lane, unchanged.
    if (req.body && req.body.saveTo === 'employer_doc') return generateEmployerDoc(req, res);
    const userId = req.user.id;
    const { name, email, phone, location, rawText, includeUploadedResume, isRegenerate, job } = req.body;
    // ⚠️ coveredOnly: Home sends true for a build it AUTO-started. Its gate answer is a snapshot taken
    // seconds before this request; without this flag, a build whose last plan unit was spent in between
    // (another device, another build) would silently fall through to the legacy-credits lane and take
    // 2 credits nobody agreed to. With it, only plan / free / pass / cache may pay, or this is a 402.
    // false is sent only after the user explicitly confirmed a credit charge.
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

        // ⚠️ NEVER CHARGE FOR AN ANSWER THE CLIENT CAN NO LONGER RECEIVE.
        // The app aborts at 120s; a run that retries a truncated Gemini response routinely passes
        // that, and then tells the user "tap Generate again — it usually succeeds on the next try".
        // Charging anyway meant the retry was refused for a resume they had already paid for.
        // The resume is still SAVED below, so nothing is lost — their retry regenerates and pays
        // exactly once. Only the synchronous lane is guarded: asJob's capturing res has no
        // writableEnded, and its request socket is deliberately closed after the 202.
        let clientGone = false;
        if (typeof res.writableEnded === 'boolean' && req && typeof req.on === 'function') {
            req.on('close', () => { if (!res.writableEnded) clientGone = true; });
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

        // Up to 3 attempts: a truncated or malformed AI response is retried silently
        // (identical prompt — exactly what a user's manual "try again" did) instead of
        // surfacing a raw JSON SyntaxError to the user.
        let resumeData = null;
        let lastErr = null;
        for (let attempt = 1; attempt <= 3 && !resumeData; attempt++) {
            // ⚠️ The retry loop used to be silent, which is exactly the case that overran the old
            // client timeout: attempts two and three looked identical to the first from outside.
            await report(
                attempt === 1 ? 'writing' : 'retry',
                attempt === 1 ? (passEmployer ? `Writing your ${passEmployer} resume` : 'Writing your resume') : 'Taking another pass at it',
                attempt === 1 ? 38 : 38 + attempt * 6,
            );
            try {
                const { text, finishReason } = await callGemini(prompt);
                if (finishReason === 'MAX_TOKENS') throw new Error('TRUNCATED_OUTPUT');
                const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
                resumeData = JSON.parse(cleaned);
            } catch (e) {
                lastErr = e;
                if (e.message === 'AI_TIMEOUT' || e.message === 'GEMINI_API_KEY not set') throw e;
                console.warn(`[resumeBuilder] generation attempt ${attempt}/3 failed: ${e.message}`);
            }
        }
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
        // bump — so the cache may only be written once that bump has landed.
        // ⚠️ AND THIS IS THE SYNCHRONOUS SCREEN: THE USER IS HOLDING THE RESULT. Unlike the doc lane, which
        // can only deliver by storing, this lane hands the resume back in the response — so a charge that
        // cannot be confirmed, or a cache that will not take the write, costs the CACHE and never the
        // answer: log it loudly, skip the store, still 200. Only the coveredOnly refusal is a non-answer
        // (nothing charged, nothing saved), exactly as it was before.
        let charged = false;   // did something actually pay for this run — the cache write depends on it
        const paid = { passId: null, credits: null, ledgerId: null };   // what a refusal has to give back
        let refusal = null;    // { status, body } — decided under the lock, answered after it
        let savedRow = false;

        /**
         * Settle what this run costs: the pass first, the plan/credits second, and `refusal` when nothing
         * that is allowed to pay still can. Leaves `charged` true only for a payment it watched land.
         * The free regeneration bypassed the gate, so it must not be counted against the quota either —
         * its ledger is the regen_count bump in persistResume.
         * ⚠️ Spend the PASS first when one covered this, and only fall back to the plan if the claim did
         * not land — two taps racing means the second must still be paid for by something, and silently
         * generating for free is the wrong way to lose that race.
         * ⚠️ coveredOnly is re-asked here, at the moment of payment. The gate above ran a minute ago (the
         * AI call sat in between) and canConsumeMany never reserves: the plan unit it saw may be gone, or
         * the pass claim may have lost a race. Then consumeOnSuccess would pick credits — the one lane
         * this build must never use. Refuse without charging or saving: handing it over free would make
         * racing builds a free-resume machine.
         */
        const settlePayment = async () => {
            let spentPass = false;
            if (clientGone) {
                console.warn('[resumeBuilder] client disconnected before delivery — resume saved, nothing charged');
            } else {
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
                            refusal = { status: 402, body: {
                                error: 'Your plan allowance was used up while this resume was being written. Open Plans & Usage to continue.',
                                reason: 'quota_exhausted',
                            } };
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
                        if (!charged) console.warn(`[resumeBuilder] credits lane for user ${userId} deducted nothing (short balance or a racing build) — resume delivered, not cached`);
                        if (coveredOnly) {
                            // The residual race between the re-check above and consumeOnSuccess: this
                            // build's own credits refunded and its ledger row deleted, then the same 402.
                            await giveBackDocCharges(userId, paid, 'a coveredOnly build slipped into credits');
                            refusal = { status: 402, body: {
                                error: 'Your plan allowance was used up while this resume was being written. Open Plans & Usage to continue.',
                                reason: 'quota_exhausted',
                            } };
                            return;
                        }
                    } else if (via === 'plan' || via === 'trial') {
                        charged = true;                  // plan / trial: the ledger row IS the charge
                    } else {
                        // 'error', or anything unrecognised: nothing was recorded, so nothing is cached.
                        console.error(`[resumeBuilder] the charge for user ${userId} could not be confirmed — resume delivered, not cached`);
                    }
                }
                if (spentPass) charged = true;
            }
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
            if (freeRegen && !clientGone && regenLanded) charged = true;
            return true;
        };

        await report('saving', 'Saving your resume', 95);
        try {
            await withUsageLock(userId, 'resume', async () => {
                await settlePayment();
                if (refusal) return;                     // nothing charged: nothing saved, nothing stored
                savedRow = await persistResume();
                // ⚠️ WRITE THE CACHE ONLY FOR A BUILD SOMEONE PAID FOR. A stored document is a free hit for
                // ever after; storing one the sync lane waived (clientGone) or whose charge did not record
                // would turn a single uncharged run into unlimited free copies for that employer.
                if (passEmployer && cacheFp && charged) {
                    const stored = await employerDocs.put({
                        userId, kind: 'resume', employer: passEmployer, jobUrl: (job && job.url) || '', jobTitle: (job && job.title) || '',
                        fingerprint: cacheFp, model: RESUME_MODEL, payload: resumeData, env,
                    });
                    // ⚠️ NOT A REASON TO REFUSE, unlike the doc lane: the resume is already in the response
                    // this user is waiting on. An unwritten cache only costs the identical rebuild its free
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
        // ⚠️ THE RESUME IS STILL DELIVERED WHEN THE LOCKED SAVE DID NOT LAND — a lock that could not be taken
        // (nothing was charged then: every charge sits under it) or a save that threw under it (the charge
        // may well stand). Either way this retry costs no money and is exactly what the user is waiting
        // for, while the CACHE stays unwritten: a store outside the lock is the very race the lock exists
        // to stop, and an uncached build only pays again. A save that fails even now is the one thing this
        // lane cannot paper over: it throws to the handler's catch — "tap Generate again".
        if (!savedRow) savedRow = await persistResume();

        return res.json({ success: true, resumeData, cached: false, tailoredFor: passEmployer });
    } catch (e) {
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
 */
const DOC_LANE_CORRECTION_BUDGET_MS = 3 * 60 * 1000;

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
 * them — which is how the last plan unit got spent twice.
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
 * call it: the doc lane on every path that cannot hand over a docId, the builder lane on its one refusal
 * (a coveredOnly build that slipped into credits) — a builder run that merely could not CACHE keeps its
 * charge, because the resume itself is in the response.
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

/** Up to three attempts at one prompt, exactly like the builder lane's loop. Throws AI_TIMEOUT / AI_BAD_OUTPUT. */
async function writeDocDraft(prompt, report) {
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
        if (attempt > 1) await report('retry', 'Taking another pass at it', 38 + attempt * 6);
        try {
            const { text, finishReason } = await callGemini(prompt);
            if (finishReason === 'MAX_TOKENS') throw new Error('TRUNCATED_OUTPUT');
            const parsed = parseDocJson(text);
            if (parsed) return parsed;
            throw new Error('NOT_A_RESUME');
        } catch (e) {
            lastErr = e;
            if (e.message === 'AI_TIMEOUT' || e.message === 'GEMINI_API_KEY not set') throw e;
            console.warn(`[resumeBuilder] employer doc attempt ${attempt}/3 failed: ${e.message}`);
        }
    }
    console.error('[resumeBuilder] all employer doc attempts failed:', lastErr && lastErr.message);
    throw new Error('AI_BAD_OUTPUT');
}

/** What the draft got wrong that one more pass may fix. The design block is not the resume, so it is not scanned. */
function docProblemsOf(draft, company, sourceText) {
    const resumeOnly = { ...draft, design: undefined };
    return { placeholders: findPlaceholders(resumeOnly), leaks: employerNameLeaks(resumeOnly, company, sourceText) };
}
const problemCount = (p) => p.placeholders.length + p.leaks.length;

/**
 * The ONE corrective pass: the same prompt, the draft that broke a rule, and exactly which rule. Returns
 * the corrected resume, or null. Never throws — the first draft is still deliverable after stripping.
 */
async function correctDocDraft(prompt, draft, problems, company) {
    const lines = [];
    if (problems.placeholders.length) {
        lines.push(`- It contains placeholder text, which is forbidden: ${problems.placeholders.slice(0, 12).map((p) => JSON.stringify(p)).join(', ')}. Rewrite every sentence that holds one so it reads naturally WITHOUT that number — never invent a number.`);
    }
    if (problems.leaks.length) {
        lines.push(`- It names ${company} in ${problems.leaks.join(' and ')}. Remove ${company} from them: the resume is about the candidate, not a message to ${company}.`);
    }
    const fixPrompt = `${prompt}

=== ⚠️ CORRECTION — YOUR PREVIOUS ANSWER BROKE A RULE ===
${lines.join('\n')}
Here is that previous answer. Return the COMPLETE corrected JSON in the same schema (including "design"), changing only what the rules above require and keeping every entry:
${JSON.stringify(draft)}`;
    try {
        const { text, finishReason } = await callGemini(fixPrompt);
        if (finishReason === 'MAX_TOKENS') return null;
        return parseDocJson(text);
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

/**
 * The document's Design (see designFit): the AI's family scores blended with the rules, every design
 * ranked. null when designFit is unavailable or throws — the row is then stored without one and the read
 * routes rank it rule-only. ⚠️ Runs BEFORE the charge, and can never fail the build.
 */
function rankDocDesign({ aiDesign, resumeData, research, country, website }) {
    try {
        const fit = require('../services/designFit');
        const r = research && typeof research === 'object' ? research : {};
        const d = aiDesign && typeof aiDesign === 'object' ? aiDesign : {};
        const text = (v) => (typeof v === 'string' ? stripPlaceholderText(v) : null);
        const ranked = fit.rankResumeDesigns({
            aiFamilyScores: familyScoresOf(d.families),
            region: fit.regionFor({ country, website }),
            brandColor: r.brandColor || null,
            companySize: r.companySize || null,
            industry: r.industry || null,
            seniorityYears: fit.seniorityYearsOf(resumeData),
            mode: d.mode, tone: text(d.tone), headline: text(d.headline),
        });
        return fit.normaliseDesign(ranked, 'resume');
    } catch (e) {
        console.warn('[resumeBuilder] design ranking failed — stored without one (the routes rank it on read):', e.message);
        return null;
    }
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
 * POST /api/resume-builder/generate-ai with saveTo:'employer_doc' — the resume Home shows for ONE
 * employer chip, fully rewritten for that employer and stored in employerDocs with its ranked designs.
 *   body { __async, clientBuildId, coveredOnly, saveTo, employerId?, country?, rawText, name, email,
 *          phone, location, includeUploadedResume, docJobUrl?, job: { company, title?, url?, description?, website? } }
 *   → { success, cached, docId, tailoredFor }
 *   400 { reason: 'no_resume' | 'no_employer' }   402 { reason: 'quota_exhausted' }   500/504 { reason: 'failed' }
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
 *   1. the fingerprint and the cache — a hit is FREE: no gate, no pass, no AI, no charge, nothing stored;
 *   2. the gates — plan/free quota, then the pass (reserving only when quota cannot pay); there is NO
 *      free-regeneration lane here, so generationGate answers this lane without one too;
 *   3. coveredOnly refuses BEFORE ANY PAID WORK — and research is paid work (a grounded AI call);
 *   4. research (of the VETTED website only) → the AI → the placeholder guard → the design ranking;
 *   5. under this user's usage lock (withUsageLock), so parallel builds decide one at a time: a racing
 *      identical document is served free; else the pass claim, else consumeOnSuccess — coveredOnly re-asked
 *      at the moment of payment, and "paid" read off THIS request's own answers (the claim, the via, its
 *      chargeCredits result), never inferred from tables another build also writes;
 *   6. store ONLY what was actually paid for — a stored document is a free hit for ever after — and when
 *      the store fails, or anything after a charge refuses, give back EVERY charge this request made
 *      (giveBackDocCharges): the credits, the pass's generation, the ledger row.
 *
 * ⚠️ NO clientGone WAIVER, UNLIKE THE SYNC BUILDER LANE. That waiver exists because a disconnected client
 * never receives its resume. Here the document is stored and Home finds it on the next lookup, so a
 * client that gave up still gets what it paid for — and its retry is a free cache hit, not a second charge.
 */
async function generateEmployerDoc(req, res) {
    const userId = req.user.id;
    const body = req.body || {};
    const { name, email, phone, location, rawText } = body;
    const coveredOnly = body.coveredOnly === true;
    const startedAt = Date.now();

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
        const hit = await employerDocs.get(userId, 'resume', company, cacheFp, env);
        if (hit && hit.id && hit.payload && hit.payload.personal_info) {
            await report('cached', `Found your ${company} resume`, 90);
            await promoteServedDoc(userId, hit, employerId, env);
            console.log(`[resumeBuilder] employer doc cache hit for "${company}" (doc ${hit.id}) — no AI call, nothing charged`);
            return res.json({ success: true, cached: true, docId: Number(hit.id), tailoredFor: company });
        }

        // ── 2. THE GATES — generateAI's order: plan/free first, the pass second ─────────────────────────
        const quota = await entitlements.canConsumeMany(userId, 'resume', 1, req);
        // Under coveredOnly the credits lane does not exist, so quota that only credits could pay is
        // exhausted for this build — and the pass is consulted in full, exactly as generationGate answers.
        const quotaCovers = !!quota.allowed && !(coveredOnly && quota.via === 'credits');
        const viaPass = await downloads.passCoversGeneration(userId, 'resume', company, req, { boundOnly: quota.allowed && quotaCovers }).catch(() => false);
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
        // ⚠️ Research goes to the VETTED site (docResearchSiteFor), never the raw field: a job board or an ATS
        // is not the employer. The fingerprint keeps job.website exactly as sent.
        const researchSite = docResearchSiteFor(company, job);
        const needPosting = !job.description && !!job.url;
        const [research, posting] = await Promise.all([
            researchSite ? researchForDoc(researchSite, company) : Promise.resolve(null),
            needPosting ? scrapePage(job.url).catch(() => null) : Promise.resolve(null),
        ]);
        // The prompt names the vetted site too: "Website: boards.greenhouse.io" would introduce the board to
        // the model as the employer.
        const promptJob = { ...job, website: researchSite };
        if (needPosting && posting) promptJob.description = [posting.title, posting.description].filter(Boolean).join('\n');

        await report('writing', `Rewriting your resume for ${company}`, 38);
        let familyBrief = '';
        try { familyBrief = require('../services/designFit').resumeFamilyBrief(); }
        catch (e) { console.warn('[resumeBuilder] designFit unavailable for the prompt:', e.message); familyBrief = localFamilyBrief(); }
        const prompt = buildEmployerDocPrompt({
            name, email, phone, location, rawText, uploadedResumeContext, job: promptJob, research, familyBrief, country,
        });
        let draft = await writeDocDraft(prompt, report);

        // The placeholder guard, and the employer's name kept out of the title and summary: ONE corrective
        // pass while there is time, then whatever placeholder is left is removed. A name that survives the
        // pass is delivered as written — cutting a name out of a sentence would garble it.
        const sourceText = [rawText, uploadedResumeContext].join('\n');
        let problems = docProblemsOf(draft, company, sourceText);
        if (problemCount(problems) && Date.now() - startedAt < DOC_LANE_CORRECTION_BUDGET_MS) {
            await report('polishing', 'Polishing the wording', 70);
            const fixed = await correctDocDraft(prompt, draft, problems, company);
            if (fixed) {
                const after = docProblemsOf(fixed, company, sourceText);
                if (problemCount(after) <= problemCount(problems)) {
                    if (!(fixed.design && typeof fixed.design === 'object')) fixed.design = draft.design;
                    draft = fixed;
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

        await report('designing', `Ranking designs for ${company}`, 86);
        const design = rankDocDesign({ aiDesign, resumeData, research, country, website: job.website });

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
        try {
            await withUsageLock(userId, 'resume', async () => {
                // ⚠️ A racing identical build (another device, same inputs) may have stored this exact document
                // during our AI minute. Then that document is what the user gets: served as the hit it now is,
                // nothing charged and nothing stored — paying twice for one document is the failure to avoid.
                const landed = await employerDocs.get(userId, 'resume', company, cacheFp, env);
                if (landed && landed.id && landed.payload && landed.payload.personal_info) { served = landed; return; }

                let charged = false;
                let spentPass = false;
                if (viaPass) {
                    const claimed = await downloads.claimGeneration(userId, 'resume', company, req);
                    spentPass = !!claimed.charged;
                    if (spentPass) paid.passId = claimed.passId || null;
                }
                if (!spentPass) {
                    // ⚠️ coveredOnly, re-asked at the moment of payment: the gate above ran before research and
                    // the AI, canConsumeMany never reserves, and a lost pass claim lands here too. Under the lock,
                    // a parallel build's unit is already in the ledger when this reads it.
                    if (coveredOnly) {
                        const now = await entitlements.canConsumeMany(userId, 'resume', 1, req);
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
                    fingerprint: cacheFp, model: RESUME_MODEL, payload: resumeData, research: research || null,
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
        await prerenderDocThumbs(userId, docId, resumeData, design, 3, 20000);
        return res.json({ success: true, cached: false, docId: Number(docId), tailoredFor: company });
    } catch (e) {
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
 * POST /api/resume-builder/generation-gate   body { employer, job?: { title?, url?, description?, website? } }
 *   200 { covered, via: 'plan'|'free'|'pass'|'cache'|'credits'|null, credits: number|null,
 *         reason: 'quota_exhausted'|'regen_limit'|null }
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
    const answer = (covered, via, credits, reason) => res.json({ covered, via, credits, reason });
    // ⚠️ The doc lane refuses a build with no employer (a '(none)' money key) before any work — so its gate
    // must not answer "covered" for one: an auto-start on that answer would only ever meet the build's 400.
    if (docLane && downloads.employerKeyOf(employer) === downloads.NONE) {
        return res.status(400).json({ covered: false, via: null, credits: null, reason: 'no_employer', error: 'Pick an employer to write this resume for.' });
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
                if (hit && hit.payload && hit.payload.personal_info) return answer(true, 'cache', null, null);
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
        // generateAI spends the pass first whenever it covered — so the pass is what pays.
        if (viaPass) return answer(true, 'pass', null, null);
        if (!quota.allowed) return answer(false, null, null, 'quota_exhausted');
        if (quotaCovers) return answer(true, quota.via, null, null);
        if (quota.via === 'credits') {
            const price = await getEventCost('resume_ai_generate');
            return answer(false, 'credits', Number(price) || 0, null);
        }
        // An allowance we cannot name is not one we may spend without asking.
        return answer(false, null, null, null);
    } catch (e) {
        console.warn('[resumeBuilder] generation-gate failed:', e.message);
        return res.status(500).json({ covered: false, via: null, credits: null, reason: null, error: 'Could not check your plan.' });
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
 */
async function loadResumeDoc(userId, id, reqOrEnv) {
    try {
        const doc = await employerDocs.getById(userId, id, reqOrEnv, { kind: 'resume' });
        const pi = doc && doc.payload && typeof doc.payload === 'object' ? doc.payload.personal_info : null;
        return pi && typeof pi === 'object' && !Array.isArray(pi) ? doc : null;
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
 * The design a stored document is shown with: its own (repaired against today's catalogue), else a
 * rule-only ranking computed now. ⚠️ Computed, never written back — see employerDocsRoutes' designFor.
 * The row carries no country, so the region comes from the researched domain. null if designFit is out.
 */
function docDesignOf(doc) {
    try {
        const fit = require('../services/designFit');
        const stored = fit.normaliseDesign(doc.design, 'resume');
        if (stored) return stored;
        const r = doc.research && typeof doc.research === 'object' ? doc.research : {};
        return fit.rankResumeDesigns({
            aiFamilyScores: null,
            region: fit.regionFor({ website: typeof r.domain === 'string' ? r.domain : '' }),
            brandColor: r.brandColor || null, companySize: r.companySize || null, industry: r.industry || null,
            seniorityYears: fit.seniorityYearsOf(doc.payload),
        });
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
            const pdfBuffer = await renderPdf(tplId, resume, { photo, photoRect, mode });
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

        // Vary the Word layout/accent by the selected template, like the PDF.
        const docxBuffer = await buildResumeDocx(resume, { photo: photoDataUri, photoRect: photoRectUri, template: tplId });

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
        let row;
        let docTag = '';
        if (hasDocId(req.body)) {
            // The gallery for ONE employer's stored document renders that document. Its previews share
            // this cache, namespaced by the document id (a document and the base row can carry the same
            // updated_at millisecond, and must never serve each other's pages).
            const doc = await loadResumeDoc(userId, req.body.docId, req);
            if (!doc) return res.status(404).json({ success: false, error: 'That version of your resume is no longer saved.', reason: 'doc_gone' });
            row = { resume_data: doc.payload, updated_at: doc.updated_at };
            docTag = `doc${Number(doc.id)}-`;
        } else {
            await ensureResumeTable();
            // ⚠️ updated_at IS HALF THE CACHE KEY (previewFile). It used to be missing from this SELECT, so
            // every key fell back to Date.now(): no gallery preview ever hit, and every batch wrote files
            // that only prunePreviews would ever touch again.
            row = await dbConfig.get('SELECT resume_data, updated_at FROM user_resumes WHERE user_id = $1', [userId]);
            if (!row || !row.resume_data) {
                return res.status(404).json({ error: 'No resume found. Please generate your resume first.' });
            }
        }
        // ── ids mode: the gallery asks for a small batch as the user scrolls/taps a swatch. ──
        // Rendering all 37 designs in one request is exactly the shape that used to break the
        // preview at NINE (multi-MB inline base64 + a serial chromium loop outliving the client
        // timeout) — so the batch is capped, and unknown ids are dropped rather than 500ing.
        const tpls = Array.isArray(ids) && ids.length
            ? [...new Set(ids)].slice(0, 6).map(id => TEMPLATES.find(t => t.id === id)).filter(Boolean)
            : templatesForRegion(region);                 // legacy region mode (older app builds)
        if (!tpls.length) return res.status(400).json({ error: 'No valid template ids.' });
        // Serve what we already have; render only what is genuinely missing, in ONE batch so the
        // warm browser is reused. A second visit to the gallery renders nothing at all.
        const pver = docTag + await photoVersion(userId);
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

// ── Employer-document thumbnails: a persistent, private, per-user LRU ───────────────────────────────
// Home switches between employers constantly, and each chip's carousel is THAT employer's resume in its
// best-ranked designs. temp/ is wiped by every deploy, so a doc thumb there would be a chromium render
// per card again after each release — these live on the uploads VOLUME instead.
//
// ⚠️ A DOT DIRECTORY, ON PURPOSE. server.js serves uploads/ publicly (express.static), and a thumb is
// someone's resume with their photo on it. serve-static's default `dotfiles: 'ignore'` answers 404 for
// any path with a segment starting with "." — verified against this repo's node_modules (serve-static
// 2.2.0 / send 1.2.0): /uploads/.thumb_cache/<id>/<file> is a 404, including %2E-encoded and ../ forms,
// and res.sendFile refuses it the same way. File names are sha256 hashes, so nothing in a name is
// guessable either. ⚠️ Do not rename this directory to one without the leading dot.
//
// The key is (user, document, its updated_at, the photo's version, the design): an edit, a rebuild or a
// new photo is a different file, never a stale image. Letter thumbs (cl_ prefix) share the directory;
// this LRU only ever counts and deletes its own 64-hex-char names.
const DOC_THUMB_ROOT = path.join(__dirname, '../../uploads/.thumb_cache');
const DOC_THUMB_KEEP = 240;
const DOC_THUMB_NAME = /^[0-9a-f]{64}\.jpg$/;
const docThumbDirOf = (userId) => path.join(DOC_THUMB_ROOT, String(parseInt(userId, 10) || 0));
const docThumbFlights = new Map();   // absolute path → Promise — one render per file, however many ask

function docThumbNameOf(userId, doc, pver, tplId) {
    const ms = new Date(doc.updated_at || 0).getTime() || 0;
    return crypto.createHash('sha256')
        .update(['resume-doc-thumb:v1', userId, doc.id, ms, pver, tplId].join('|'))
        .digest('hex') + '.jpg';
}

/** One design of one stored document → { image, name } (a downscaled JPEG data URI). Throws on a failed render. */
async function docThumb(userId, doc, tplId, pver) {
    const tpl = TEMPLATES.find((t) => t.id === tplId);
    if (!tpl) throw new Error(`unknown design ${tplId}`);
    const dir = docThumbDirOf(userId);
    const name = docThumbNameOf(userId, doc, pver, tplId);
    const abs = path.join(dir, name);
    try {
        const buf = await fs.readFile(abs);
        const now = new Date();
        fs.utimes(abs, now, now).catch(() => {});   // an LRU: a read is a use
        return { image: `data:image/jpeg;base64,${buf.toString('base64')}`, name };
    } catch { /* not rendered yet */ }
    if (docThumbFlights.has(abs)) return docThumbFlights.get(abs);
    const flight = (async () => {
        const { photo, photoRect } = await photosFor(userId);
        const [pv] = await renderPreviews(doc.payload, { photo, photoRect }, [tpl]);
        const full = Buffer.from(String(pv && pv.image || '').split(',')[1] || '', 'base64');
        if (!full.length) throw new Error('empty render');
        let thumb = full;
        try {
            const sharp = require('sharp');
            thumb = await sharp(full).resize({ width: THUMB_W }).jpeg({ quality: 80 }).toBuffer();
        } catch { /* sharp unavailable → serve full-size; heavier but correct */ }
        try {
            await fs.mkdir(dir, { recursive: true });
            // Written aside and renamed in, so a reader never gets half a JPEG.
            const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
            await fs.writeFile(tmp, thumb);
            await fs.rename(tmp, abs);
        } catch (e) { console.warn('[resumeBuilder] doc thumb not cached:', e.message); }
        return { image: `data:image/jpeg;base64,${thumb.toString('base64')}`, name };
    })().finally(() => docThumbFlights.delete(abs));
    docThumbFlights.set(abs, flight);
    return flight;
}

/** Keep the DOC_THUMB_KEEP most recently used doc thumbs for this user; `keep` (names) is never deleted. */
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
                const c = await docThumb(userId, doc, id, pver);
                const meta = TEMPLATES.find((t) => t.id === id) || {};
                const r = byId.get(id);
                cards.push({
                    id, name: meta.name || id, accent: meta.accent || '#4F8DFF', ats: meta.ats || null, image: c.image,
                    fit: r ? r.score : null, reason: r && r.reason ? r.reason : null,
                });
                names.push(c.name);
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
 * Right after a paid document is stored: render its top designs into the doc thumb cache, so the
 * carousel that opens on it shows pages rather than skeletons. Bounded (`budgetMs`) — a slow chromium
 * must not hold the build's answer; whatever is still rendering then finishes into the cache on its own.
 * Never throws: the document is already stored and paid for.
 */
async function prerenderDocThumbs(userId, docId, payload, design, count, budgetMs) {
    try {
        // The key needs the row's own updated_at — exactly what home-cards will read back.
        const row = await dbConfig.get('SELECT updated_at FROM user_employer_documents WHERE id = $1 AND user_id = $2', [docId, userId]);
        if (!row || !row.updated_at) return;
        const doc = { id: docId, updated_at: row.updated_at, payload };
        const ranked = design && Array.isArray(design.ranked) ? design.ranked.map((r) => r.id) : TEMPLATE_IDS;
        const ids = ranked.filter((id) => TEMPLATE_IDS.includes(id)).slice(0, count);
        const work = (async () => {
            const pver = await photoVersion(userId);
            const names = [];
            for (const id of ids) {
                try { names.push((await docThumb(userId, doc, id, pver)).name); }
                catch (e) { console.warn('[resumeBuilder] doc thumb pre-render failed for', id, e.message); }
            }
            pruneDocThumbs(userId, names);
        })().catch(() => {});
        let timer = null;
        await Promise.race([work, new Promise((resolve) => { timer = setTimeout(resolve, budgetMs); if (timer.unref) timer.unref(); })]);
        if (timer) clearTimeout(timer);
    } catch (e) { console.warn('[resumeBuilder] doc thumb pre-render skipped:', e.message); }
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
    // prompt + placeholder guard (exported for tests).
    currentResumeFingerprint, buildEmployerDocPrompt, findPlaceholders, stripPlaceholders,
};
