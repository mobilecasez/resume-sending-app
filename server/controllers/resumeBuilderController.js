// Resume Builder — new feature. Safe to delete without affecting existing app.
'use strict';

const dbConfig     = require('../../db-config');
const axios        = require('axios');
const cheerio      = require('cheerio');
const path         = require('path');
const fs           = require('fs').promises;
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
 * its updated_at — ⚠️ employerDocs.prune keeps the newest 40 resume rows per user, and a base written
 * once and then never touched is exactly the row that ages out behind forty companies.
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
// web research feeds the prompt yet; when research lands, its revision belongs here.
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

/** The parsed uploaded resume as the prompt sees it, or '' — ONE definition for the prompt and the cache fingerprint. */
async function uploadedResumeContextFor(userId) {
    try {
        const meta = await dbConfig.get('SELECT * FROM resume_metadata WHERE user_id = ? AND parse_status = ?', [userId, 'done']);
        if (meta) {
            const rest = {};
            for (const [k, v] of Object.entries(meta)) if (!isUploadBookkeeping(k)) rest[k] = v;
            console.log(`[resumeBuilder] including uploaded resume content for user ${userId}`);
            return JSON.stringify(rest, null, 2);
        }
        console.log(`[resumeBuilder] includeUploadedResume set but no parsed resume found for user ${userId}`);
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
 *   research   — RESEARCH_REV.
 * Returns null when the base text cannot be read (a strict read failed) — a caller must then skip the
 * cache, never hash a guess.
 */
async function generationFingerprint(userId, { rawText, includeUploadedResume, job, env, readUploaded }) {
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
        researchRev: RESEARCH_REV,
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
 * Credit-lane verification — did consumeOnSuccess ACTUALLY deduct credits?
 *
 * ⚠️ { via: 'credits' } IS NOT PROOF OF PAYMENT. consumeOnSuccess calls eventCosts.chargeCredits, which
 * on a short balance returns { charged:false, insufficient:true } WITHOUT throwing — and consumeOnSuccess
 * ignores that result, writes the ledger row anyway and reports 'credits'. canConsumeMany does not
 * reserve, so two overlapping builds both pass the gate on one build's worth of credits: the second is
 * "charged" nothing, and if it then wrote the cache that document would be a PERMANENT FREE HIT.
 * entitlements.js exposes nothing else, so we read what the charge leaves behind: chargeCredits writes a
 * credit_usage_history row ONLY after a real deduction, consumeOnSuccess writes a usage_ledger row every
 * time. Marked just before the call, "every credits ledger row since has a paid history row" is the
 * answer. It is CONSERVATIVE: two builds consuming in the same instant with one charge between them both
 * read unpaid (the paid one merely skips its cache write), and a lost history insert reads unpaid. It
 * can only under-report a payment, never invent one — a balance before/after diff could, since an
 * overlapping build's deduction would look like ours, which is exactly the GE1 race.
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
// ROUTE HANDLERS
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/resume-builder/generate-ai
async function generateAI(req, res) {
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

        let charged = false;   // did something actually pay for this run — the cache write depends on it
        try {
            // Deduct only now — the resume was actually generated. Pool + ledger via entitlements.
            // The free regeneration bypassed the gate, so it must not be counted against the quota
            // either — its ledger is the regen_count bump below.
            // ⚠️ Spend the PASS first when one covered this, and only fall back to the plan if the
            // claim did not land — two taps racing means the second must still be paid for by
            // something, and silently generating for free is the wrong way to lose that race.
            let spentPass = false;
            if (clientGone) {
                console.warn('[resumeBuilder] client disconnected before delivery — resume saved, nothing charged');
            } else {
                if (viaPass) {
                    const claimed = await downloads.claimGeneration(userId, 'resume', passEmployer, req);
                    spentPass = !!claimed.charged;
                }
                if (!spentPass && !freeRegen) {
                    // ⚠️ coveredOnly, re-asked at the moment of payment. The gate above ran a minute ago
                    // (the AI call sat in between), and canConsumeMany never reserves: the plan unit it
                    // saw may be gone, or the pass claim above lost a race. Then consumeOnSuccess would
                    // pick credits — the one lane this build must never use. Refuse without charging
                    // or saving: handing it over free would make racing builds a free-resume machine.
                    if (coveredOnly) {
                        const now = await entitlements.canConsumeMany(userId, 'resume', 1, req);
                        if (!now.allowed || now.via === 'credits') {
                            console.warn(`[resumeBuilder] coveredOnly build for user ${userId} lost its cover during the run — refused, nothing charged`);
                            return res.status(402).json({
                                error: 'Your plan allowance was used up while this resume was being written. Open Plans & Usage to continue.',
                                reason: 'quota_exhausted',
                            });
                        }
                    }
                    const marks = await creditMarksFor(userId);
                    const used = await entitlements.consumeOnSuccess(userId, 'resume', { name: resumeData.personal_info?.full_name, screen: 'resume_builder' }, req);
                    if (!used || used.via === 'error') {
                        charged = false;                 // consumeOnSuccess never throws; 'error' means nothing was recorded
                    } else if (used.via === 'credits') {
                        // ⚠️ GE1 — see creditMarksFor: 'credits' is what was ATTEMPTED, not what was paid.
                        const d = await creditsDeductedSince(userId, marks);
                        charged = d.paid;
                        if (!d.paid) console.warn(`[resumeBuilder] credits lane for user ${userId} deducted nothing (short balance or a racing build) — not cached`);
                        if (coveredOnly) {
                            // The residual race between the re-check above and consumeOnSuccess: give it back.
                            if (d.paid) {
                                const { refundCredits } = require('../services/eventCosts');
                                if (typeof refundCredits === 'function') await refundCredits(userId, 'resume_ai_generate', { charged: true, cost: d.cost });
                            }
                            return res.status(402).json({
                                error: 'Your plan allowance was used up while this resume was being written. Open Plans & Usage to continue.',
                                reason: 'quota_exhausted',
                            });
                        }
                    } else {
                        charged = true;                  // plan / trial: the ledger row IS the charge
                    }
                }
                if (spentPass) charged = true;
            }
        } catch (e) { console.warn('[resumeBuilder] usage record failed:', e.message); }

        await report('saving', 'Saving your resume', 95);
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

        // ⚠️ WRITE THE CACHE ONLY FOR A BUILD SOMEONE PAID FOR. A stored document is a free hit for
        // ever after; storing one the sync lane waived (clientGone) or whose charge did not record
        // would turn a single uncharged run into unlimited free copies for that employer.
        if (passEmployer && cacheFp && charged) {
            await employerDocs.put({
                userId, kind: 'resume', employer: passEmployer, jobUrl: (job && job.url) || '', jobTitle: (job && job.title) || '',
                fingerprint: cacheFp, model: RESUME_MODEL, payload: resumeData, env,
            });
        }

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
 */
async function generationGate(req, res) {
    const userId = req.user.id;
    const body = req.body || {};
    const employer = String(body.employer || '').trim().slice(0, 160) || null;
    const regenerate = body.regenerate === true;
    const rawJob = body.job && typeof body.job === 'object' ? body.job : {};
    const job = {
        title: String(rawJob.title || ''), url: String(rawJob.url || ''),
        description: String(rawJob.description || ''), website: String(rawJob.website || ''),
    };
    const answer = (covered, via, credits, reason) => res.json({ covered, via, credits, reason });
    try {
        if (employer && !regenerate) {
            const env = downloads.envOf(req);
            // A null fingerprint (base unreadable) is "cannot tell" — fall through to the dry run, which
            // can only under-promise: the build itself still reads the cache before charging anything.
            const fp = await generationFingerprint(userId, { includeUploadedResume: true, job, env });
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

// POST /api/resume-builder/generate-pdf  — renders the chosen HTML design template
// (Azure / Executive / Minimal) to PDF; falls back to the PDFKit layout if needed.
async function generatePDF(req, res) {
    const userId = req.user.id;
    const { template, mode } = req.body || {};
    try {
        const DOWNLOAD_CREDIT_COST = 0;   // downloads are part of the paid plans now, not a per-file charge
        await ensureResumeTable();
        const row = await dbConfig.get('SELECT resume_data FROM user_resumes WHERE user_id = $1', [userId]);
        if (!row || !row.resume_data) {
            return res.status(404).json({ error: 'No resume found. Please generate your resume first.' });
        }

        // ── Previewing every design is free; DOWNLOADING the file is paid. ──
        // A plan covers it, and so does a single-employer pass bought outright. services/downloads
        // owns that decision — see the note there about why it is not repeated per controller.
        const employer = (req.body && req.body.employer) || null;
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
                format: 'pdf', mode, fileName: tFile, payload: { template: tplId, mode },
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
            format: 'pdf', mode, fileName, payload: { template: String(template || ''), mode },
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
    {
        const employer = (req.body && req.body.employer) || null;
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
        await ensureResumeTable();
        const row = await dbConfig.get('SELECT resume_data FROM user_resumes WHERE user_id = $1', [userId]);
        if (!row || !row.resume_data) {
            return res.status(404).json({ error: 'No resume found. Please generate your resume first.' });
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

        await downloads.claimDownload(req.user.id, { employer: (req.body && req.body.employer) || null }, req);
        await history.record(req.user.id, {
            kind: 'resume', employer: (req.body && req.body.employer) || null,
            templateId: String((req.body && req.body.template) || ''), templateName: templateNameOf(req.body && req.body.template),
            format: 'docx', mode: String((req.body && req.body.mode) || ''), fileName,
            payload: { template: String((req.body && req.body.template) || ''), mode: String((req.body && req.body.mode) || '') },
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
        await ensureResumeTable();
        const row = await dbConfig.get('SELECT resume_data FROM user_resumes WHERE user_id = $1', [userId]);
        if (!row || !row.resume_data) {
            return res.status(404).json({ error: 'No resume found. Please generate your resume first.' });
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

// GET /api/resume-builder/home-cards?ids=banner,rightrail,mono
// The employer-Home carousel: the user's REAL resume rendered in several designs. Every card is
// disk-cached per resume version, so the first open after a (re)generate pays the renders and
// every open after that is a file read.
//
// ⚠️ Capped at 5 — the renderer recycles its browser every 3 pages (single-process chromium dies
// after ~4-5 in a session), and Home must never be the screen that melts the preview pipeline.
async function homeCards(req, res) {
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
        return res.json({ success: true, preferred, cards, sample });
    } catch (e) {
        console.error('[resumeBuilder] homeCards error:', e.message);
        return res.status(500).json({ error: 'Could not render previews.' });
    }
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

module.exports = { previewFile, readPreviewCache, writePreviewCache, generateAI, generationGate, saveResume, getResume, generatePDF, generateDocx, previewTemplates, listTemplates, homeThumb, homeCards, buildResumePdfForRegion, buildParsePrompt };   // buildParsePrompt exported for tests only
