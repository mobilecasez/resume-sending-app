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

/**
 * Mark the row as failed.
 */
async function saveError(userId, errMessage) {
    ensureDbConnection();
    await dbConfig.run(
        `INSERT INTO resume_metadata (user_id, parse_status, parse_error, created_at, updated_at)
         VALUES (?, 'error', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (user_id) DO UPDATE
             SET parse_status = 'error',
                 parse_error  = EXCLUDED.parse_error,
                 updated_at   = CURRENT_TIMESTAMP`,
        [userId, errMessage]
    );
}

// ─── pdf text extraction ──────────────────────────────────────────────────────

async function extractTextFromPDF(absolutePath) {
    const buffer = await fs.readFile(absolutePath);
    const data   = await pdf(buffer);
    return (data.text || '').trim();
}

// ─── ai parsing ──────────────────────────────────────────────────────────────

async function parseWithGemini(rawText) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

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

    const result   = await model.generateContent(prompt);
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
        console.log(`[resumeParser] Metadata saved for user ${userId} ✅`);

    } catch (err) {
        console.error(`[resumeParser] Failed for user ${userId}:`, err.message);
        try {
            await saveError(userId, err.message);
        } catch (dbErr) {
            console.error(`[resumeParser] Could not save error state for user ${userId}:`, dbErr.message);
        }
    }
}

module.exports = { triggerResumeParsingBackground };
