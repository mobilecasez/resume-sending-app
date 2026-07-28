'use strict';

/**
 * Resume Parser Service
 *
 * Runs as a background (fire-and-forget) process when a user uploads a resume.
 * Extracts text from the PDF, then uses Gemini AI to pull structured metadata
 * (skills, experience, education, etc.) and persists it in the resume_metadata table.
 *
 * This module is intentionally async / non-blocking – callers should NOT await it.
 */

const path = require('path');
const fs   = require('fs').promises;
const pdf  = require('pdf-parse');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const dbConfig = require('../db-config');
const jobService = require('../server/services/jobService');

function ensureDbConnection() {
    if (!dbConfig.rawDb()) {
        dbConfig.initializeConnection();
    }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Upsert a "pending" row so that even if parsing fails later we have a record.
 */
async function upsertPending(userId) {
    ensureDbConnection();
    await dbConfig.run(
        `INSERT INTO resume_metadata (user_id, parse_status, created_at, updated_at)
         VALUES (?, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (user_id) DO UPDATE
             SET parse_status = 'pending',
                 parse_error  = NULL,
                 updated_at   = CURRENT_TIMESTAMP`,
        [userId]
    );
}

/**
 * Persist successfully parsed metadata.
 */
async function saveParsed(userId, rawText, parsed) {
    ensureDbConnection();
    await dbConfig.run(
        `INSERT INTO resume_metadata (
             user_id, raw_text, summary,
             skills, technical_skills, soft_skills,
             experience_years, experience_summary,
             education, certifications,
             languages, job_titles, industries,
             parse_status, parse_error, parsed_at,
             created_at, updated_at
         ) VALUES (
             ?, ?, ?,
             ?, ?, ?,
             ?, ?,
             ?, ?,
             ?, ?, ?,
             'done', NULL, CURRENT_TIMESTAMP,
             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
         )
         ON CONFLICT (user_id) DO UPDATE SET
             raw_text           = EXCLUDED.raw_text,
             summary            = EXCLUDED.summary,
             skills             = EXCLUDED.skills,
             technical_skills   = EXCLUDED.technical_skills,
             soft_skills        = EXCLUDED.soft_skills,
             experience_years   = EXCLUDED.experience_years,
             experience_summary = EXCLUDED.experience_summary,
             education          = EXCLUDED.education,
             certifications     = EXCLUDED.certifications,
             languages          = EXCLUDED.languages,
             job_titles         = EXCLUDED.job_titles,
             industries         = EXCLUDED.industries,
             parse_status       = 'done',
             parse_error        = NULL,
             parsed_at          = CURRENT_TIMESTAMP,
             updated_at         = CURRENT_TIMESTAMP`,
        [
            userId,
            rawText,
            parsed.summary || null,
            Array.isArray(parsed.skills) ? parsed.skills : null,
            parsed.technical_skills   ? JSON.stringify(parsed.technical_skills) : null,
            Array.isArray(parsed.soft_skills) ? parsed.soft_skills : null,
            parsed.experience_years != null ? parsed.experience_years : null,
            parsed.experience_summary || null,
            parsed.education          ? JSON.stringify(parsed.education)        : null,
            parsed.certifications     ? JSON.stringify(parsed.certifications)   : null,
            Array.isArray(parsed.languages) ? parsed.languages : null,
            Array.isArray(parsed.job_titles) ? parsed.job_titles : null,
            Array.isArray(parsed.industries) ? parsed.industries : null,
        ]
    );
}

// ─── transient vs permanent failure ──────────────────────────────────────────
//
// This distinction is the whole bug. Every failure used to be written as parse_status='error',
// which nothing ever retries — so ONE 503 from Gemini ("This model is currently experiencing high
// demand. Spikes in demand are usually temporary") permanently bricked that user's résumé. The app
// then told them "Resume not processed yet. Please wait and try again", which could never become
// true no matter how long they waited. On production this had already happened to 3 users, out of
// 10 who have a résumé on file with no usable parse.
//
// A model being busy is not the same fact as a PDF being unreadable. They now get different states.
const TRANSIENT = /\b(429|500|502|503|504)\b|high demand|overload|unavailable|rate.?limit|quota|deadline exceeded|timeout|timed out|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed/i;

/** True when trying the exact same thing later could plausibly succeed. */
function isTransientError(message) {
    const m = String(message || '');
    // "prepayment credits are depleted" arrives as a 429 but is NOT transient — retrying burns
    // attempts against a wall until somebody tops the account up. Treat it as needing a human.
    if (/credits are depleted|billing|payment required|API key not valid|API_KEY_INVALID|PERMISSION_DENIED/i.test(m)) return false;
    return TRANSIENT.test(m);
}

/**
 * Mark the row as failed.
 *
 * `retryable` rows keep parse_status='pending' so the sweeper picks them up and the user is not
 * told anything false; only genuinely hopeless input becomes 'error'. parse_error is recorded
 * either way so an admin can see what happened.
 */
async function saveError(userId, errMessage, retryable = false) {
    ensureDbConnection();
    const status = retryable ? 'pending' : 'error';
    await dbConfig.run(
        `INSERT INTO resume_metadata (user_id, parse_status, parse_error, created_at, updated_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (user_id) DO UPDATE
             SET parse_status = EXCLUDED.parse_status,
                 parse_error  = EXCLUDED.parse_error,
                 updated_at   = CURRENT_TIMESTAMP`,
        [userId, status, errMessage]
    );
}

// ─── pdf text extraction ──────────────────────────────────────────────────────

async function extractTextFromPDF(absolutePath) {
    const buffer = await fs.readFile(absolutePath);
    const data   = await pdf(buffer);
    return (data.text || '').trim();
}

// ─── ai parsing ──────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Call the model, retrying transient failures with exponential backoff.
 *
 * There was no retry at all before: a single 503 ended the parse and the user's résumé was written
 * off. "Spikes in demand are usually temporary" is Google telling us to try again — so we do, four
 * times over roughly half a minute, which costs nothing on the happy path and rescues the overwhelming
 * majority of these. A failure that survives all four attempts is re-thrown for the caller to
 * classify; a permanent one (bad key, depleted billing) is thrown immediately rather than retried.
 */
async function generateWithRetry(model, prompt, attempts = 4) {
    let last;
    for (let i = 0; i < attempts; i++) {
        try {
            return await model.generateContent(prompt);
        } catch (err) {
            last = err;
            const msg = err && err.message;
            if (!isTransientError(msg) || i === attempts - 1) throw err;
            const wait = 1500 * Math.pow(2, i) + Math.floor(Math.random() * 400);   // 1.5s, 3s, 6s (+jitter)
            console.warn(`[resumeParser] transient AI failure (attempt ${i + 1}/${attempts}), retrying in ${wait}ms: ${String(msg).slice(0, 120)}`);
            await sleep(wait);
        }
    }
    throw last;
}

async function parseWithGemini(rawText) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: process.env.GEMINI_FLASH_MODEL || 'gemini-2.5-flash' });

    const prompt = `You are a resume parsing assistant. Analyse the resume text below and return ONLY a valid JSON object (no markdown, no explanation) with exactly these fields:

{
  "summary": "<2-3 sentence professional summary of the candidate>",
  "skills": ["<all skills as flat array>"],
  "technical_skills": {
    "<category>": ["<skill>", ...]
  },
  "soft_skills": ["<soft skill>"],
  "experience_years": <total years as a number, e.g. 4.5>,
  "experience_summary": "<brief summary of work history>",
  "education": [
    {
      "degree": "<degree name>",
      "field": "<field of study>",
      "institution": "<institution name>",
      "year": "<graduation year or range>"
    }
  ],
  "certifications": [
    {
      "name": "<certification name>",
      "issuer": "<issuer>",
      "year": "<year if available>"
    }
  ],
  "languages": ["<spoken language>"],
  "job_titles": ["<job title held or targeted>"],
  "industries": ["<industry>"]
}

If a field cannot be determined from the resume, use null (for scalar fields) or [] (for array fields).

Resume text:
"""
${rawText.slice(0, 12000)}
"""`;

    const result   = await generateWithRetry(model, prompt);
    const response = result.response;
    let   text     = response.text().trim();

    // Strip potential markdown code fences
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    return JSON.parse(text);
}

// ─── main export ─────────────────────────────────────────────────────────────

/**
 * Trigger background resume parsing.
 * Call this WITHOUT await so it does not block the HTTP response.
 *
 * @param {number} userId         – authenticated user id
 * @param {string} relativeResumePath – path relative to project root (as stored in DB)
 */
function triggerResumeParsingBackground(userId, relativeResumePath) {
    // Fire-and-forget: do not await
    _parseResume(userId, relativeResumePath).catch(err => {
        console.error(`[resumeParser] Unexpected top-level error for user ${userId}:`, err.message);
    });
}

async function _parseResume(userId, relativeResumePath) {
    console.log(`[resumeParser] Starting background parse for user ${userId}`);

    try {
        // 1. Mark as pending immediately
        await upsertPending(userId);

        // 2. Build absolute path
        const absolutePath = path.join(__dirname, '..', relativeResumePath);

        // 3. Extract text from PDF
        const rawText = await extractTextFromPDF(absolutePath);
        if (!rawText || rawText.length < 50) {
            throw new Error('PDF appears to be empty or non-readable');
        }
        console.log(`[resumeParser] Extracted ${rawText.length} chars from resume for user ${userId}`);

        // 4. Parse with Gemini AI
        const parsed = await parseWithGemini(rawText);
        console.log(`[resumeParser] AI parsing complete for user ${userId}`);

        // 5. Persist
        await saveParsed(userId, rawText, parsed);

        // 6. Update user_skills normalized table
        if (parsed.skills && Array.isArray(parsed.skills)) {
            for (const skill of parsed.skills) {
                if (!skill) continue;
                const skillId = await jobService.upsertSkill(skill);
                await jobService.linkUserSkill(userId, skillId);
            }
        }

        // Also add technical and soft skills to the unified user_skills table
        if (parsed.soft_skills && Array.isArray(parsed.soft_skills)) {
            for (const skill of parsed.soft_skills) {
                if (!skill) continue;
                const skillId = await jobService.upsertSkill(skill);
                await jobService.linkUserSkill(userId, skillId);
            }
        }

        if (parsed.technical_skills) {
            for (const category in parsed.technical_skills) {
                const skillsList = parsed.technical_skills[category];
                if (Array.isArray(skillsList)) {
                    for (const skill of skillsList) {
                        if (!skill) continue;
                        const skillId = await jobService.upsertSkill(skill);
                        await jobService.linkUserSkill(userId, skillId);
                    }
                }
            }
        }

        console.log(`[resumeParser] Metadata and normalized skills saved for user ${userId} ✅`);

    } catch (err) {
        const retryable = isTransientError(err && err.message);
        console.error(`[resumeParser] Failed for user ${userId} (${retryable ? 'TRANSIENT — will retry' : 'permanent'}):`, err.message);
        try {
            await saveError(userId, err.message, retryable);
        } catch (dbErr) {
            console.error(`[resumeParser] Could not save error state for user ${userId}:`, dbErr.message);
        }
    }
}

// ─── sweeper ─────────────────────────────────────────────────────────────────
//
// Retries résumés left in a retryable state. Two populations:
//   • rows this run marked 'pending' after exhausting the in-process backoff;
//   • rows written as 'error' by the OLD code, whose parse_error is plainly a transient model
//     failure. Those users uploaded a perfectly good CV and have been sitting unusable ever since —
//     invisible to matching and unable to generate a cover letter — so they are worth reclaiming.
//
// Deliberately small and slow: this competes with live traffic for the same model quota, and a
// thundering retry during an outage is what turns a blip into an incident.
async function retryStuckResumes({ limit = 5, includeOldErrors = true, log = console } = {}) {
    ensureDbConnection();
    const rows = await dbConfig.query(
        `SELECT m.user_id, m.parse_status, m.parse_error, u.resume_path
           FROM resume_metadata m
           JOIN users u ON u.id = m.user_id
          WHERE u.deleted_at IS NULL
            AND COALESCE(u.resume_path, '') <> ''
            AND (
                  m.parse_status = 'pending'
                  OR ($1 AND m.parse_status = 'error' AND COALESCE(m.parse_error, '') <> '')
                )
            AND m.updated_at < NOW() - INTERVAL '10 minutes'
          ORDER BY m.updated_at ASC
          LIMIT ${Math.max(1, Math.min(50, parseInt(limit, 10) || 5))}`,
        [!!includeOldErrors]
    ).catch(() => []);

    const targets = (rows || []).filter((r) =>
        r.parse_status === 'pending' || isTransientError(r.parse_error));
    if (!targets.length) return { considered: (rows || []).length, retried: 0, users: [] };

    log.log(`[resumeParser] sweeper: retrying ${targets.length} résumé(s)`);
    for (const r of targets) {
        try { await _parseResume(r.user_id, r.resume_path); }
        catch (e) { log.error(`[resumeParser] sweeper failed for user ${r.user_id}:`, e.message); }
    }
    return { considered: (rows || []).length, retried: targets.length, users: targets.map((t) => t.user_id) };
}

module.exports = { triggerResumeParsingBackground, retryStuckResumes, isTransientError, _parseResume };
