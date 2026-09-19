const dbConfig = require('../../db-config');
const path = require('path');
const fs = require('fs').promises;
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
// The legacy letter's PROMPT (buildPrompt) — its model call is this file's writeLegacyLetter, through aiText.
const letterV2 = require('../../ai-cover-letter-v2');
const { researchEmployer } = require('../../ai-employer-researcher');
const { notifyCoverLetterGenerated, notifyError } = require('./notificationsController');
const jobService = require('../services/jobService');
const { generateCoverLetterPDF: generateRichCoverLetterPDF } = require('./emailController');
const clTemplates = require('../utils/coverLetterTemplates');
const clRenderer  = require('../utils/coverLetterRenderer');
const { getEventCost } = require('../services/eventCosts');
const entitlements = require('../services/entitlements');
const downloads = require('../services/downloads');
const history = require('../services/downloadHistory');
const { emit } = require('../services/track');   // first-party analytics

const CL_DOWNLOAD_CREDIT_COST = 2; // fallback; live cost via getEventCost('cover_letter_download')

// Helper function: Check user credits
async function checkUserCredits(userId, creditsRequired = 1) {
    try {
        // Get user's credit info
        const credits = await dbConfig.get(
            'SELECT credits_remaining, expiry_date FROM user_credits WHERE user_id = ?',
            [userId]
        );

        if (!credits) {
            return {
                hasCredits: false,
                remaining: 0,
                message: 'No credit account found. Please purchase credits.'
            };
        }

        const now = new Date();
        const expiryDate = credits.expiry_date ? new Date(credits.expiry_date) : null;
        const isExpired = expiryDate && expiryDate < now;

        if (isExpired) {
            return {
                hasCredits: false,
                remaining: 0,
                message: 'Your credits have expired. Please purchase new credits.'
            };
        }

        const remaining = credits.credits_remaining || 0;

        if (remaining < creditsRequired) {
            return {
                hasCredits: false,
                remaining: remaining,
                message: `Insufficient credits. You have ${remaining} credit(s) but need ${creditsRequired}.`
            };
        }

        return {
            hasCredits: true,
            remaining: remaining
        };
    } catch (error) {
        console.error('Error checking credits:', error);
        throw error;
    }
}

// Helper function: Deduct credits
async function deductCredits(userId, creditsToDeduct = 1, actionType = 'cover_letter_generation', metadata = {}) {
    try {
        // Get current credit balance
        const userCredits = await dbConfig.get(
            'SELECT credits_remaining FROM user_credits WHERE user_id = ?',
            [userId]
        );

        if (!userCredits || userCredits.credits_remaining < creditsToDeduct) {
            throw new Error('Insufficient credits');
        }

        const newBalance = userCredits.credits_remaining - creditsToDeduct;

        // Update user_credits table
        await dbConfig.run(
            'UPDATE user_credits SET credits_remaining = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?',
            [newBalance, userId]
        );

        // Record in credit_usage_history
        await dbConfig.run(
            `INSERT INTO credit_usage_history 
            (user_id, credits_used, action_type, company_name, position, recipient_email, created_at)
            VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            [
                userId,
                creditsToDeduct,
                actionType,
                metadata.companyName || null,
                metadata.position || null,
                metadata.recipientEmail || null
            ]
        );

        console.log(`✅ Deducted ${creditsToDeduct} credit(s). New balance: ${newBalance}`);
        
        return {
            success: true,
            newBalance: newBalance,
            creditsDeducted: creditsToDeduct
        };
    } catch (error) {
        console.error('Error deducting credits:', error);
        throw error;
    }
}

// Helper function: Format cover letter with HTML highlighting
function formatCoverLetterWithHTML(coverLetterText, metadata) {
    if (!coverLetterText) return '';

    // Normalise line endings and collapse 3+ newlines to 2
    const normalized = coverLetterText
        .replace(/\r\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n');

    // Split on double newlines (paragraph breaks)
    const paragraphs = normalized.split(/\n\n+/);

    let html = '';
    paragraphs.forEach(para => {
        const trimmed = para.trim();
        if (!trimmed) return;

        // Within a paragraph, replace single \n with <br> for soft line breaks
        let formatted = trimmed
            .replace(/\n/g, '<br>')
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

        html += `<p style="margin-bottom: 15px; line-height: 1.6;">${formatted}</p>`;
    });

    return html;
}

// Helper function: Generate cover letter PDF
async function generateCoverLetterPDF(user, coverLetterHtmlOrText, companyName, companyAddress = '') {
    // Determine if input is HTML or plain text
    const isHtml = coverLetterHtmlOrText.includes('<') && coverLetterHtmlOrText.includes('>');
    
    // Extract plain text from HTML if needed
    let coverLetterText = coverLetterHtmlOrText;
    if (isHtml) {
        coverLetterText = coverLetterHtmlOrText
            .replace(/<br\s*\/?>/gi, ' ')   // soft break → space (PDF word-wraps itself)
            .replace(/<\/p>/gi, '\n\n')     // paragraph end → blank line
            .replace(/<strong>(.*?)<\/strong>/gi, '$1')  // strip bold tags, keep text
            .replace(/<[^>]+>/g, '')        // strip any remaining tags
            .replace(/&nbsp;/g, ' ')
            .replace(/\n{3,}/g, '\n\n')    // collapse excess blank lines
            .trim();
    }
    
    // Create PDF
    const pdfDoc = await PDFDocument.create();
    let page = pdfDoc.addPage([595.28, 841.89]); // A4 size
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    
    const fontSize = 11;
    const lineHeight = 16;
    const margin = 50;
    let yPosition = page.getHeight() - margin;
    
    // Add header with user info
    page.drawText(user.full_name, {
        x: margin,
        y: yPosition,
        size: 14,
        font: boldFont,
        color: rgb(0, 0, 0)
    });
    yPosition -= 20;
    
    // Contact info
    const contactInfo = [user.email, user.phone_number, user.city && user.country ? `${user.city}, ${user.country}` : ''].filter(Boolean).join(' | ');
    page.drawText(contactInfo, {
        x: margin,
        y: yPosition,
        size: 9,
        font: font,
        color: rgb(0.3, 0.3, 0.3)
    });
    yPosition -= 30;
    
    // Date
    const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    page.drawText(date, {
        x: margin,
        y: yPosition,
        size: 10,
        font: font
    });
    yPosition -= 25;
    
    // Company address
    if (companyAddress) {
        page.drawText(companyName, {
            x: margin,
            y: yPosition,
            size: 10,
            font: boldFont
        });
        yPosition -= 15;
        
        page.drawText(companyAddress, {
            x: margin,
            y: yPosition,
            size: 10,
            font: font
        });
        yPosition -= 25;
    }
    
    // Salutation
    page.drawText('Dear Hiring Manager,', {
        x: margin,
        y: yPosition,
        size: 11,
        font: font
    });
    yPosition -= 25;
    
    // Body text with word wrapping (preserve paragraph breaks)
    const maxWidth = page.getWidth() - (margin * 2);
    const paragraphs = coverLetterText
        .split(/\n\s*\n/)
        .map(p => p.trim())
        .filter(Boolean);

    for (const paragraph of paragraphs) {
        const words = paragraph.split(/\s+/);
        let line = '';

        for (const word of words) {
            const testLine = line + (line ? ' ' : '') + word;
            const width = font.widthOfTextAtSize(testLine, fontSize);

            if (width > maxWidth && line) {
                page.drawText(line, {
                    x: margin,
                    y: yPosition,
                    size: fontSize,
                    font: font
                });
                yPosition -= lineHeight;
                line = word;

                // Add new page if needed
                if (yPosition < margin + 100) {
                    page = pdfDoc.addPage([595.28, 841.89]);
                    yPosition = page.getHeight() - margin;
                }
            } else {
                line = testLine;
            }
        }

        if (line) {
            page.drawText(line, {
                x: margin,
                y: yPosition,
                size: fontSize,
                font: font
            });
            yPosition -= lineHeight;
        }

        // Paragraph spacing
        yPosition -= 9;

        if (yPosition < margin + 100) {
            page = pdfDoc.addPage([595.28, 841.89]);
            yPosition = page.getHeight() - margin;
        }
    }
    
    // Closing
    if (yPosition < margin + 80) {
        const newPage = pdfDoc.addPage([595.28, 841.89]);
        yPosition = newPage.getHeight() - margin;
    }
    
    yPosition -= 10;
    page.drawText('Sincerely,', {
        x: margin,
        y: yPosition,
        size: 11,
        font: font
    });
    yPosition -= 20;
    
    page.drawText(user.full_name, {
        x: margin,
        y: yPosition,
        size: 11,
        font: boldFont
    });
    
    // Save PDF
    const pdfBytes = await pdfDoc.save();
    const fileName = `Cover_Letter_${companyName.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}.pdf`;
    const filePath = path.join(__dirname, '../../temp', fileName);
    
    // Ensure temp directory exists
    await fs.mkdir(path.join(__dirname, '../../temp'), { recursive: true });
    
    await fs.writeFile(filePath, pdfBytes);
    
    return { filePath, fileName };
}

// Persist all employer research data into DB tables (fire-and-forget safe)
async function saveEmployerResearch(data) {
    if (!data || !data.website_url) return;
    const url = data.website_url;
    try {
        // employer_profiles
        await dbConfig.run(
            `INSERT INTO employer_profiles (website_url, employer_name, founded_year, company_size, industry, mission, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT (website_url) DO UPDATE SET
               employer_name = EXCLUDED.employer_name,
               founded_year = EXCLUDED.founded_year,
               company_size = EXCLUDED.company_size,
               industry = EXCLUDED.industry,
               mission = EXCLUDED.mission,
               updated_at = CURRENT_TIMESTAMP`,
            [url, data.employer_name || null, data.founded_year || null,
             data.company_size || null, data.industry || null, data.mission || null]
        );
        // employer_brand_profiles
        await dbConfig.run(
            `INSERT INTO employer_brand_profiles (website_url, brand_color, font_name)
             VALUES (?, ?, ?)
             ON CONFLICT (website_url) DO UPDATE SET brand_color = EXCLUDED.brand_color, font_name = EXCLUDED.font_name`,
            [url, data.brand_color || '#262633', data.font_name || 'Lato']
        );
        // employer_technologies — clear old rows then insert fresh
        await dbConfig.run('DELETE FROM employer_technologies WHERE website_url = ?', [url]);
        for (const t of (data.technologies || [])) {
            if (t.name) await dbConfig.run(
                'INSERT INTO employer_technologies (website_url, name, category) VALUES (?, ?, ?)',
                [url, t.name, t.category || null]
            );
        }
        // employer_clients
        await dbConfig.run('DELETE FROM employer_clients WHERE website_url = ?', [url]);
        for (const c of (data.clients || [])) {
            if (c.client_name) await dbConfig.run(
                'INSERT INTO employer_clients (website_url, client_name, industry, notes) VALUES (?, ?, ?, ?)',
                [url, c.client_name, c.industry || null, c.notes || null]
            );
        }
        // employer_recent_activity
        await dbConfig.run('DELETE FROM employer_recent_activity WHERE website_url = ?', [url]);
        for (const a of (data.recent_activity || [])) {
            if (a.description) await dbConfig.run(
                'INSERT INTO employer_recent_activity (website_url, activity_type, description) VALUES (?, ?, ?)',
                [url, a.activity_type || null, a.description]
            );
        }
        // employer_contacts
        await dbConfig.run('DELETE FROM employer_contacts WHERE website_url = ?', [url]);
        for (const k of (data.key_contacts || [])) {
            if (k.name || k.role) await dbConfig.run(
                'INSERT INTO employer_contacts (website_url, name, role, source) VALUES (?, ?, ?, ?)',
                [url, k.name || null, k.role || null, k.source || null]
            );
        }
        // employer_locations (from research addresses if available)
        if ((data.locations || []).length > 0) {
            await dbConfig.run('DELETE FROM employer_locations WHERE website_url = ?', [url]);
            for (const loc of data.locations) {
                if (loc.address) await dbConfig.run(
                    'INSERT INTO employer_locations (website_url, address, is_headquarters) VALUES (?, ?, ?)',
                    [url, loc.address, loc.is_headquarters || false]
                );
            }
        }
        console.log(`💾 [employer-research] Saved all data for ${url}`);
    } catch (err) {
        console.error(`[employer-research] ❌ DB save failed for ${url}:`, err.message);
        console.error(err.stack);
    }
}

// ── ONE PAYMENT DECISION AT A TIME PER USER — the lock every generation lane takes ─────────────────────
/**
 * Run `fn` holding this user's usage lock for `kind`: ONE payment decision at a time per (user, kind).
 *
 * ⚠️ canConsumeMany CHECKS AND NEVER RESERVES, and consumeOnSuccess only asks "is a unit left right now". The
 * letter lanes in this file took no lock, so two letters finishing together (batch-process writes three at
 * once, two bulk requests, this screen next to Home's letter lane) both read "1 left" and both wrote a
 * usage row — a one-time allowance overspent, and every one of those letters delivered. Under this lock the
 * next letter asks only after the previous one's row exists, gets via 'none', and is refused.
 * ⚠️ THE KEY IS SHARED: hashtext('usage:' || kind) + the user id, spelled exactly as resumeBuilderController's
 * and employerLetterController's withUsageLock spell it. Both of those are local to their controllers, so
 * this is the same advisory lock in a third place, not a new one — a lane serialises against the others only
 * by taking that same key. Exported: aiHubController's Job Hub letter takes it through here.
 * ⚠️ THE LOCK IS ALL THE TRANSACTION HOLDS. The work inside runs on the pool (entitlements and downloads have
 * no transaction surface), so each write commits the moment it lands — which is exactly what the NEXT holder
 * has to see — and nothing is rolled back when this transaction fails. Callers decide by what their own
 * calls returned, never by whether the lock returned. Never hold it across an AI call: it is a pooled client.
 * The wait is bounded (lock_timeout): a holder stuck that long means the database is in trouble, and the
 * waiter fails closed — nothing charged. A db layer without withTransaction (a stub) runs `fn` unserialised,
 * and says so once.
 */
let warnedUnserialised = false;
async function withUsageLock(userId, kind, fn) {
    if (typeof dbConfig.withTransaction !== 'function') {
        if (!warnedUnserialised) {
            warnedUnserialised = true;
            console.warn('[coverLetter] dbConfig.withTransaction unavailable — letter payments are NOT serialised');
        }
        return fn();
    }
    return dbConfig.withTransaction(async (tx) => {
        await tx.get(`SET LOCAL lock_timeout = '15s'`);
        await tx.get(`SELECT pg_advisory_xact_lock(hashtext('usage:' || $1::text), $2::int)`, [kind, userId]);
        return fn();
    });
}

/** "Nothing is left that may pay for this letter" — the same words as Home's letter lane (LOST_COVER). */
const LETTER_ALLOWANCE_USED_UP = 'Your plan allowance was used up while this cover letter was being written. Open Plans & Usage to continue.';

/**
 * The refusal the letter worker throws when nothing will pay for a finished letter. Its callers turn it into
 * exactly what every other lane answers: a 402 { reason: 'quota_exhausted' } (sync), a job failed WITH that
 * reason (async), and one refused letter with that reason (batch-process). `userFacing` lets the message out.
 */
function letterQuotaRefusal() {
    const e = new Error(LETTER_ALLOWANCE_USED_UP);
    e.userFacing = true;
    e.reason = 'quota_exhausted';
    e.status = 402;
    return e;
}

/**
 * The worker's answer for a job the user cancelled (POST /job-cancel/:jobId) before its letter was paid for: the
 * letter is not charged and not delivered. Reason 'cancelled' — batch-process records it per letter, the async job's
 * failJobWithReason leaves the cancel's own row alone (it never overwrites 'cancelled').
 */
function letterCancelled() {
    const e = new Error('Cancelled — nothing was charged for this letter.');
    e.userFacing = true;
    e.reason = 'cancelled';
    return e;
}

/**
 * Has the job this letter belongs to been cancelled? No job id (the sync lane, a direct call) is never cancelled.
 * ⚠️ AN UNREADABLE FLAG IS "NOT CANCELLED": the letter exists and is delivered with its charge, exactly as before
 * cancelling existed — a database that cannot answer this read is not a reason to throw a finished letter away.
 */
async function letterJobCancelled(jobId) {
    if (!jobId) return false;
    try { return await jobService.isCancelled(jobId); }
    catch (e) { console.warn(`[coverLetter] could not read job ${jobId}'s cancel flag (${e.message}) — treated as not cancelled`); return false; }
}

/**
 * Fail an async job AND keep its machine-readable reason. The same single UPDATE as middleware/asyncJob.js
 * failJobWithReason, which is not exported: this worker creates its own job rows rather than running under
 * asJob. ⚠️ ONE statement, not updateJobPartialResult then failJob — between two writes a poller would read a
 * 'processing' row carrying { reason, error } as if it were progress. async_jobs has no reason column, so it
 * rides in `result`, which the job-status handlers return as `data`. `extra` rides with it (an AI refusal's
 * `retryable`, so a poller can tell "try again in a minute" from "nothing you can do").
 */
async function failJobWithReason(jobId, message, reason, extra = null) {
    // Never over a cancel (jobService.failJob keeps the same rule): the cancel's words are what the poller reads.
    await dbConfig.run(
        `UPDATE async_jobs SET status = 'failed', error = $1, result = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 AND status <> 'cancelled'`,
        [message, JSON.stringify({ reason, error: message, ...(extra || {}) }), jobId]
    );
}

/**
 * Give back the usage_ledger row THIS letter's own consumeOnSuccess inserted (by that id — deleting another
 * letter's row would hand out a free letter). usedSince counts rows, so this is what returns the unit.
 * Never throws; a failure is logged loudly for support, never retried blindly.
 */
async function giveBackLedgerRow(userId, ledgerId, why) {
    if (!ledgerId) return;
    try {
        await dbConfig.run('DELETE FROM usage_ledger WHERE id = $1 AND user_id = $2', [ledgerId, userId]);
        console.warn(`[coverLetter] usage_ledger ${ledgerId} given back to user ${userId} (${why})`);
    } catch (e) {
        console.error(`[coverLetter] ⚠️ USAGE ROW NOT GIVEN BACK — user ${userId}, usage_ledger ${ledgerId} (${why}) — support must make this good:`, e.message);
    }
}

// ── THE LEGACY LETTER'S AI CALL — through aiText, like every paid lane ──────────────────────────────────
//
// ⚠️ 2026-09-18. Home's letter lane asked gemini-2.5-flash twice, back to back, on a 503 "high demand" day and
// Amazon's letter "didn't finish". The lanes in THIS file did the same thing worse: ai-cover-letter-v2's
// callGemini asked the one hardcoded model three times with no pause and NO TIMEOUT AT ALL — a hung model held
// a Letters-screen request, a Job Hub letter job or a batch slot for as long as Google cared to take. The call
// now lives here and goes through aiText.generateText: a paused second try, the verified fallback models, a
// per-attempt cap that really aborts, one budget for the whole letter. ai-cover-letter-v2 still owns the PROMPT
// (buildPrompt, byte for byte what it sent) and this is its call and its parsing, kept as they were.
//
// ⚠️ THE ONE LETTER WRITER (2026-09-18, the owner's decision: "we have a prompt/api that is already written on the
// jobs section … and hence we finalized that … we need to use the same one … and not the new one"). Home's employer
// letter (employerLetterController.buildEmployerLetter) used to write with a prompt of its own, ungrounded; it is now
// written by exactly this lane's generation — the metadata loader (letterResumeMetadataFor), the research subject
// (letterResearchSubjectOf), the posting (letterListingOf), v2's prompt, Google Search grounding, v2's config, the
// letter chain, the parsing and the mapping of the answer into a letter (letterDetailsOf). Those pieces are exported
// from HERE and Home calls them: REUSED, never copied, so the two screens cannot drift apart. A change to any of them
// changes both screens' letters — which is the point.
//
// ⚠️ MONEY. Every AI call here runs BEFORE the charge (withUsageLock → claimGeneration / consumeOnSuccess, after
// the letter exists), so a letter no model could write charges NOTHING and hands nothing over. That is what makes
// "Nothing was charged" in the two refusals below true. These lanes store no document and no model id; the
// model that answered is logged. (Home stores its letter, and the model that wrote it — never in its fingerprint.)
// Lazily, per use: a suite that reloads aiText (or shrinks its timing knobs) must be what the next call sees.
const aiTextMod = () => require('../services/aiText');

/**
 * What ai-cover-letter-v2 always asked: the PRIMARY of the chain. This lane and Home's employer letter (written through
 * writeLegacyLetter below) walk [this, ...letterFallbacks()]; Job Hub's per-job letter (aiHubController, its own prompt and
 * its own gemini-2.5-flash) walks [it, ...aiText.fallbackModels()]. None of them walks aiText.writing().
 * ⚠️ REVERTED 2026-09-18, the same day it moved. The measured writing chain (gemini-3.1-flash-lite first) was evaluated on
 * Home's OLD prompt, which had no grounding; v2's prompt with Google Search grounding — the one every letter is written
 * with now — was never measured on it. Until it is, letters stay on the chain v2 was finalized on. The résumé lanes keep
 * aiText.writing(): that one WAS measured.
 * ⚠️ ≤ 48 chars — Home records it as the writer of a stored letter when an answer ever arrives without a model id.
 */
const LEGACY_LETTER_MODEL = 'gemini-2.5-flash';
/**
 * The letter lanes' BACKUPS, in order — MEASURED on v2's own prompt WITH Google Search grounding (2026-09-18, three
 * letters per model, judged blind): gemini-3.1-flash-lite gave 3/3 usable letters (it answers without searching);
 * gemini-2.5-flash-lite broke 2 of 3 once grounding was on (invalid JSON, a 79-word letter). So a busy 2.5-flash hands
 * the letter to 3.1-flash-lite first. The PRIMARY stays v2's finalized gemini-2.5-flash: it was judged best (3/3 top tier),
 * and none of the cheaper models was the same result — the flash-lites skip the live research and invented more.
 * The operator's AI_TEXT_FALLBACK_MODELS (including "none") still wins, exactly as it did through fallbackModels().
 */
const LETTER_FALLBACKS = Object.freeze(['gemini-3.1-flash-lite', 'gemini-2.5-flash-lite']);
// ⚠️ Read through aiText's own cleaner, and ONLY a usable list wins: "none"/"off" → [] (primary only); an unset, blank or
// all-junk value → the measured pair. Handing a junk value to fallbackModels() would have fallen back to aiText's DEFAULT
// order — 2.5-flash-lite first, the very order measured to break grounded letters.
const letterFallbacks = () => {
    const fromEnv = aiTextMod().envModelList(process.env.AI_TEXT_FALLBACK_MODELS);
    return fromEnv === null ? [...LETTER_FALLBACKS] : fromEnv;
};
/**
 * ai-cover-letter-v2's generationConfig, unchanged, given to EVERY model of the chain. No responseMimeType: the
 * letter is grounded (googleSearch), and the API refuses JSON mode and grounding together — the prompt asks for
 * JSON and parseLegacyLetterJson digs it out. 32768 because 2.5-flash thinks out of the same budget.
 */
const legacyLetterConfig = () => ({ temperature: 1, topP: 0.95, maxOutputTokens: 32768 });
/**
 * The whole letter's AI time, every try and every bad-output retry included. Job Hub's poller gives a letter job 5
 * minutes (the Letters screen polls with no deadline); the resume-metadata wait (≤ 20 s) comes first. A grounded letter
 * researches before it writes (30–90 s on the primary), so its first try gets 90 s; every later try 60 s.
 */
const LEGACY_LETTER_BUDGET_MS = 4 * 60 * 1000;
const LEGACY_LETTER_CAPS_MS = Object.freeze({ first: 90 * 1000, later: 60 * 1000 });
/** Bad output (empty, no JSON, no letter in it) is retried like v2 retried it: three answers at most … */
const LEGACY_LETTER_TRIES = 3;
/** … and never one started with less than this left of the budget. */
const LEGACY_LETTER_MIN_TRY_MS = 20 * 1000;

/** v2's user-safe failure, word for word: the letter lanes and the pollers already show exactly this. */
const LEGACY_LETTER_FAILED = 'We could not finish generating your cover letter. Please try again.';
/**
 * The two answers for "Google could not write this letter" — aiText's final AiUnavailableError, after it waited,
 * retried and walked every fallback model. The same words as Home's letter lane (employerLetterController AI_BUSY
 * / AI_DOWN), so a user sees one story whichever screen they wrote from.
 *   ai_busy  every model busy, hung or out of time: a provider overload. retryable — Try again in a minute.
 *   ai_down  quota or auth: the key itself is refused (aiHealth has paged the operator). Not retryable.
 */
const LEGACY_AI_BUSY = "Google's AI is overloaded right now, so your cover letter could not be written. Nothing was charged — please try again in a minute.";
const LEGACY_AI_DOWN = 'Our AI provider is unavailable right now. Nothing was charged.';

/**
 * aiText's final failure → the lanes' refusal (userFacing, reason ai_busy | ai_down, retryable, status 503), or
 * null for anything that is not an outage (kind 'other': every model truncated or refused the request — that keeps
 * today's "could not finish" answer). Read by name, like aiText.isAiBusy, so a second copy of aiText in the
 * require cache still answers.
 */
function legacyAiRefusal(e) {
    if (!e || e.name !== 'AiUnavailableError') return null;
    const busy = e.kind === 'busy';
    if (!busy && e.kind !== 'quota' && e.kind !== 'auth') return null;
    const refusal = new Error(busy ? LEGACY_AI_BUSY : LEGACY_AI_DOWN);
    refusal.userFacing = true;
    refusal.reason = busy ? 'ai_busy' : 'ai_down';
    refusal.retryable = busy;
    refusal.status = 503;
    refusal.cause = e;
    return refusal;
}
const isAiRefusal = (e) => !!e && (e.reason === 'ai_busy' || e.reason === 'ai_down');
/** The HTTP body every lane answers an AI refusal with (HTTP 503). */
const aiRefusalBody = (e) => ({ success: false, reason: e.reason, retryable: !!e.retryable, error: e.message });

/**
 * A retry, in the words the user reads: a model switch, an overload, or a second pass at a bad answer.
 * ⚠️ "FASTER" MUST BE TRUE FOR THE CHAIN THIS LANE WALKS. It is: after gemini-2.5-flash come the flash-lites
 * (letterFallbacks). A chain whose backups are not faster (aiText.writing(), 2.5-flash behind 3.1-flash-lite) says "a backup
 * model" instead — which is why the words changed for the one afternoon the letters walked that chain.
 */
const legacyRetryLabel = ({ model, kind, nextModel }) => (nextModel && nextModel !== model ? 'Switching to a faster model'
    : kind === 'transient' ? "Google's AI is busy — trying again" : 'Taking another pass at it');

/**
 * Walk a JSON string and escape the raw \n \r \t found INSIDE string literals — ai-cover-letter-v2's
 * sanitiseJsonString, unchanged (the model writes the letter's paragraph breaks as real newlines).
 */
function escapeRawControlChars(raw) {
    let out = '';
    let inString = false;
    let escaped = false;
    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (escaped) { out += ch; escaped = false; continue; }
        if (ch === '\\' && inString) { out += ch; escaped = true; continue; }
        if (ch === '"') { inString = !inString; out += ch; continue; }
        if (inString) {
            if (ch === '\n') { out += '\\n'; continue; }
            if (ch === '\r') { out += '\\r'; continue; }
            if (ch === '\t') { out += '\\t'; continue; }
        }
        out += ch;
    }
    return out;
}

/**
 * The last resort, ai-cover-letter-v2's extractJsonFields unchanged: each known field pulled out on its own, for
 * the answer whose string values hold literal double quotes no parser can repair. cover_letter is always the last
 * field, so it runs to the last `"` before the final `}`.
 */
function extractLetterFields(raw) {
    const str = (key) => {
        const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"([\\s\\S]*?)"(?:\\s*,\\s*"[a-z_]+"\\s*:|\\s*\\})`, 'i'));
        return m ? m[1].replace(/\\n/g, '\n').replace(/\\t/g, '\t') : '';
    };
    const arr = (key) => {
        const m = raw.match(new RegExp(`"${key}"\\s*:\\s*(\\[[\\s\\S]*?\\])`, 'i'));
        if (!m) return [];
        try { return JSON.parse(escapeRawControlChars(m[1])); } catch (_) {
            return [...m[1].matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)].map((x) => x[1]);
        }
    };
    const letter = () => {
        const start = raw.indexOf('"cover_letter"');
        if (start === -1) return '';
        const quote = raw.indexOf('"', raw.indexOf(':', start) + 1);
        if (quote === -1) return '';
        const close = raw.lastIndexOf('"', raw.lastIndexOf('}') - 1);
        return raw.slice(quote + 1, close).replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
    };
    return { to: str('to'), employer_name: str('employer_name'), position: str('position'), addresses: arr('addresses'), subject: str('subject'), cover_letter: letter() };
}

/**
 * The model's answer → { to, employer_name, position, addresses, subject, cover_letter }, or a throw (the retry).
 * ai-cover-letter-v2's parsing, stage for stage: fences off, the outermost {…}, JSON.parse, then the same parse
 * after escaping raw control characters, then the field extractor. ONE addition: an answer with no letter in it
 * (every stage "succeeded" on an object with no cover_letter) is a throw too — v2 handed it on, and the lane then
 * charged for an empty letter.
 */
function parseLegacyLetterJson(text) {
    if (!text || String(text).trim() === '') throw new Error('Gemini returned an empty response');
    const cleaned = String(text).replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('Gemini response did not contain a JSON object');
    const json = cleaned.slice(start, end + 1);
    let letter = null;
    try { letter = JSON.parse(json); } catch (_) {
        const sanitised = escapeRawControlChars(json);
        try { letter = JSON.parse(sanitised); } catch (__) {
            try { letter = extractLetterFields(sanitised); } catch (e3) {
                throw new Error(`JSON parse failed after all recovery attempts: ${e3.message}`);
            }
        }
    }
    if (!letter || typeof letter !== 'object' || !String(letter.cover_letter || '').trim()) {
        throw new Error('Gemini response carried no cover_letter');
    }
    return letter;
}

/**
 * The legacy letter → { letter, model }: ai-cover-letter-v2's inputs and output shape, its prompt, its config, its
 * parsing — with the model call on aiText (see the section header).
 *
 * TWO KINDS OF FAILURE, TWO RULES:
 *   - the PROVIDER could not answer (aiText's AiUnavailableError: busy, quota, auth) → the ai_busy / ai_down refusal,
 *     at once. aiText has already waited, retried and walked every model inside the budget; a second walk would only
 *     outlive the poller. Kind 'other' (every model truncated or refused the request) is final too, as "could not
 *     finish".
 *   - the ANSWER was unusable (empty, no JSON, no letter) → asked again, up to LEGACY_LETTER_TRIES answers, like v2.
 * `report(stage, label)` (optional) puts each retry on the job in plain words. It is awaited by aiText, and
 * anything it throws is ignored there — a progress write can never break a letter.
 * `deadline` (optional, epoch ms) is a caller's own window: the letter's budget ends at the EARLIER of it and
 * LEGACY_LETTER_BUDGET_MS from now. Home passes the AI window its build started at its first line (it may have waited
 * on another build first); the Jobs lanes pass none. It shortens the budget, never the prompt or the chain.
 *
 * A v2 without buildPrompt (an older copy, or a suite's stub of the whole module) keeps the old call through its
 * generateCoverLetter: the prompt is v2's to build, and there is nothing here to build it from.
 */
async function writeLegacyLetter(resumeMetadata, employerUrl, position, responsibilities = null, jobLocation = null, listing = null, { report = null, deadline = null } = {}) {
    if (typeof letterV2.buildPrompt !== 'function') {
        return { letter: await letterV2.generateCoverLetter(resumeMetadata, employerUrl, position, responsibilities, jobLocation, listing), model: null };
    }
    // v2's own argument checks, message for message: a batch row with no position fails exactly as it did.
    if (!resumeMetadata || typeof resumeMetadata !== 'object') throw new Error('userMetadata must be a non-null object');
    if (!employerUrl || typeof employerUrl !== 'string') throw new Error('employerUrl must be a non-empty string');
    if (!position || typeof position !== 'string') throw new Error('targetPosition must be a non-empty string');
    let url = employerUrl.trim();
    if (!url.startsWith('http')) url = 'https://' + url;
    // Pass the URL itself: the model researches the employer through Google Search grounding.
    const prompt = letterV2.buildPrompt(resumeMetadata, position, url, responsibilities, jobLocation, listing);

    const aiText = aiTextMod();
    const endsAt = Math.min(Date.now() + LEGACY_LETTER_BUDGET_MS, Number.isFinite(deadline) ? deadline : Infinity);
    let lastErr = null;
    for (let attempt = 1; attempt <= LEGACY_LETTER_TRIES; attempt++) {
        const left = endsAt - Date.now();
        if (left < LEGACY_LETTER_MIN_TRY_MS) break;
        if (attempt > 1 && report) {
            try { await report('retry', 'Taking another pass at it'); } catch (_) { /* a progress write never breaks a letter */ }
        }
        console.log(`[coverLetter] writing the letter for ${url} (answer ${attempt}/${LEGACY_LETTER_TRIES}, prompt ${prompt.length} chars)`);
        let out;
        try {
            out = await aiText.generateText({
                lane: 'letter_legacy',
                prompt: { contents: [{ role: 'user', parts: [{ text: prompt }] }], tools: [{ googleSearch: {} }] },
                config: legacyLetterConfig(),
                // The letter chain — v2's primary, then the verified fallbacks — with v2's config on every model and no
                // per-model config (see LEGACY_LETTER_MODEL: this prompt was never measured on aiText.writing()).
                models: [LEGACY_LETTER_MODEL, ...letterFallbacks()],
                budgetMs: left,
                attemptCapsMs: LEGACY_LETTER_CAPS_MS,
                onRetry: (info) => (report ? report('retry', legacyRetryLabel(info)) : undefined),
            });
        } catch (e) {
            const refusal = legacyAiRefusal(e);
            if (refusal) {
                console.error(`[coverLetter] no model could write the letter for ${url} (${refusal.reason}): ${e.message}`);
                throw refusal;
            }
            lastErr = e;
            console.warn(`[coverLetter] letter for ${url}: every model failed (${e.message}) — not asked again`);
            break;
        }
        try {
            const letter = parseLegacyLetterJson(out.text);
            console.log(`[coverLetter] letter for ${url} written by ${out.model}${out.fellBack ? ' (a fallback model)' : ''} ✅`);
            return { letter, model: out.model };
        } catch (e) {
            lastErr = e;
            console.warn(`[coverLetter] letter answer ${attempt}/${LEGACY_LETTER_TRIES} for ${url} unusable: ${e.message}`);
        }
    }
    // Every answer unusable (or the budget spent on them): v2's user-safe message; the detail stays in the log.
    console.error('[coverLetter] the letter could not be finished:', lastErr ? lastErr.message : 'the letter budget ran out');
    const err = new Error(LEGACY_LETTER_FAILED);
    err.userFacing = true;
    err.cause = lastErr;
    throw err;
}

/**
 * The async job's retry reporter: the same { stage, label } partial result Home's lanes write, so a poller that
 * reads labels shows "Google's AI is busy — trying again". Today's Letters and Job Hub pollers read only the bar
 * and the final status, and ignore it. Never throws.
 */
const legacyJobReporter = (jobId) => async (stage, label) => {
    try { await jobService.updateJobPartialResult(jobId, { stage, label }); } catch (_) { /* a progress write never breaks a letter */ }
};

// ── THE LETTER'S INPUTS AND ITS MAPPING — one definition, every screen that writes a letter ─────────────
// Lifted out of executeGenerationWork / generateCoverLetters / generateCoverLetterDetails UNCHANGED (their answers are
// byte for byte what they were) so Home's employer letter can be written from the same inputs in the same shapes and
// mapped the same way (see THE ONE LETTER WRITER above). Change one here and both screens change together.

/**
 * The résumé a letter is written FROM: the parsed upload (resume_metadata, parse_status 'done'), with the Builder
 * résumé merged in (mergeBuilderResume) — or null when no parsed upload landed.
 * `tries` reads, 5 s apart: the background parser may still be running a moment after an upload, so the Jobs lanes
 * wait for it (5 reads = up to 20 s). A caller that already knows whether a parse landed reads once (Home: tries 1).
 */
async function letterResumeMetadataFor(userId, { tries = 5 } = {}) {
    let resumeMetadata = null;
    for (let attempt = 0; attempt < tries; attempt++) {
        resumeMetadata = await dbConfig.get(
            'SELECT * FROM resume_metadata WHERE user_id = ? AND parse_status = ?',
            [userId, 'done'] // 'done' — the status the parser writes
        );
        if (resumeMetadata) break;
        if (attempt < tries - 1) await new Promise(r => setTimeout(r, 5000)); // wait 5s before the next read
    }
    // Point 6: add Builder-resume context (if present) for richer letters.
    return resumeMetadata ? mergeBuilderResume(userId, resumeMetadata) : null;
}

// Job BOARDS are not employers. A posting opened on instahyre/naukri/linkedin gives us the board's
// host, and researching THAT produced letters addressed to the job board instead of the company.
const AGGREGATOR_HOST = /(instahyre|naukri|linkedin|indeed|glassdoor|monster|shine|timesjobs|foundit|wellfound|ziprecruiter|simplyhired|jooble|careerjet|adzuna|talent\.com|jobs?\.[a-z]+\.com)\b/i;

/**
 * Who the letter researches → { normalizedWebsiteUrl, researchSubject }. The website, https:// added; but when the only
 * URL we have is a job board, the COMPANY NAME from the posting instead — otherwise the letter is written to the board.
 */
function letterResearchSubjectOf(websiteUrl, companyNameHint) {
    const normalizedWebsiteUrl = websiteUrl && websiteUrl.match(/^https?:\/\//) ? websiteUrl : `https://${websiteUrl}`;
    const researchSubject = (companyNameHint && AGGREGATOR_HOST.test(normalizedWebsiteUrl))
        ? String(companyNameHint).trim()
        : normalizedWebsiteUrl;
    return { normalizedWebsiteUrl, researchSubject };
}

/**
 * The real posting, when there is one → v2's `listing`, else null. It is context for the prompt only — it is never
 * treated as the employer URL (that slot expects a company site, and a raw description dropped into it would be turned
 * into "https://<text>").
 */
function letterListingOf({ jobUrl, jobText, position, companyNameHint }) {
    return (jobUrl || jobText)
        ? { url: jobUrl || '', text: jobText || '', title: position || '', company: companyNameHint || '' }
        : null;
}

/** What a location with no real address reads as — the one row the mobile picker needs when nothing was found. */
const ADDRESS_NOT_AVAILABLE = 'Address not available';

/**
 * v2's answer → the letter the Jobs section hands over: { companyName, hiringManager, subject, locations, coverLetterHtml }.
 * Every field v2 can leave out is derived here, once: the name falls back to the caller's hint, then the research
 * subject; the addressee to "Hiring Manager"; the subject to "Application for <position>".
 */
function letterDetailsOf(aiResult, { position, companyNameHint = null, researchSubject = '', jobLocation = null } = {}) {
    const companyName = aiResult.employer_name || companyNameHint || researchSubject;
    const hiringManager = aiResult.to || 'Hiring Manager';
    const subject = aiResult.subject || `Application for ${position}`;

    // Map addresses array → locations format expected by the mobile app
    const locations = (aiResult.addresses || []).map((addr, i) => ({
        address: addr,
        city: '',
        country: '',
        isHeadquarters: i === 0
    }));
    if (locations.length === 0) {
        locations.push({ address: ADDRESS_NOT_AVAILABLE, city: '', country: '', isHeadquarters: true });
    }

    // Job-aware selection: a cover letter generated FOR A JOB must use that job's office,
    // not the HQ. If jobLocation was provided, surface the matching office first (flagged
    // matchesJobLocation); if none of the scraped addresses match, synthesize an entry from
    // the job location so it is always present AND first. The mobile picker defaults to it.
    // A placeholder job location (extraction couldn't resolve it) must NEVER be surfaced — otherwise
    // the letter shows "Location TBD, Location TBD, Location TBD". Treat these as "no job location"
    // and fall back to the real researched offices (HQ first).
    const isPlaceholderLoc = (v) => !v || /^(location\s*tbd|tbd\s*location|tbd|n\.?\/?a\.?|none|null|unknown|not\s*(specified|available|provided)|various|multiple\s*locations?|remote|hybrid|on[\s-]?site|—|–|-)$/i.test(String(v).trim());
    if (jobLocation && jobLocation.trim() && !isPlaceholderLoc(jobLocation)) {
        const jl = jobLocation.toLowerCase().trim();
        const tokens = jl.split(/[,\s]+/).map(t => t.trim()).filter(t => t.length >= 3 && !isPlaceholderLoc(t));
        const matchIdx = locations.findIndex(l => {
            const hay = `${l.address} ${l.city} ${l.country}`.toLowerCase();
            return (jl.length >= 4 && hay.includes(jl)) || tokens.some(t => hay.includes(t));
        });
        if (matchIdx >= 0) {
            const [match] = locations.splice(matchIdx, 1);
            match.matchesJobLocation = true;
            locations.unshift(match);
        } else {
            const parts = jobLocation.split(',').map(s => s.trim()).filter(Boolean);
            locations.unshift({
                address: jobLocation.trim(),
                city: parts[0] || '',
                // Only set country from a distinct 2nd part — never duplicate the city as the country.
                country: parts.length > 1 ? parts[parts.length - 1] : '',
                isHeadquarters: false,
                matchesJobLocation: true,
            });
        }
    }
    // Drop any placeholder/junk locations that slipped through (e.g. a synthesized 'Location TBD').
    let cleaned = locations.filter((l) => !(isPlaceholderLoc(l.address) && isPlaceholderLoc(l.city) && isPlaceholderLoc(l.country)));
    if (cleaned.length === 0) cleaned = [{ address: ADDRESS_NOT_AVAILABLE, city: '', country: '', isHeadquarters: true }];

    // Format markdown cover letter body as HTML. This single region-neutral
    // letter is used for every region — the picker only changes PDF formatting.
    const coverLetterHtml = formatCoverLetterWithHTML(aiResult.cover_letter || '', {});

    return { companyName, hiringManager, subject, locations: cleaned, coverLetterHtml };
}

// Generate cover letter (bulk)
const generateCoverLetters = async (req, res) => {
    try {
        const userId = req.user.id;
        const { recipients } = req.body;

        console.log('\n📝 ============ GENERATE COVER LETTERS START ============');
        console.log('📝 [GENERATE] User ID:', userId);
        console.log('📝 [GENERATE] Recipients count:', recipients?.length || 0);

        if (!recipients || recipients.length === 0) {
            return res.status(400).json({ error: 'No recipients provided' });
        }

        // GATE — the plan, then the Free plan (entitlements decides; credits no longer pay for generation).
        // Check only: it refuses an oversized request up front, but it reserves nothing, so a parallel request
        // can pass it for the same last units. The real decision is per letter, AFTER each generation below,
        // under the usage lock — and a letter nothing will pay for is refused there, not delivered.
        const clCost = await getEventCost('cover_letter_generate');
        try {
            const gate = await entitlements.canConsumeMany(userId, 'cover_letter', recipients.length, req);
            if (!gate.allowed) {
                return res.status(402).json({
                    error: gate.message,
                    reason: 'quota_exhausted',
                    remainingCredits: 0,
                    creditsRequired: recipients.length * clCost
                });
            }
        } catch (error) {
            return res.status(500).json({ error: 'Failed to check your plan allowance' });
        }

        // Get user profile
        try {
            const user = await dbConfig.get('SELECT * FROM users WHERE id = ?', [userId]);
            
            if (!user) {
                return res.status(404).json({ error: 'User not found' });
            }
            
            if (!user.resume_path || user.resume_path.trim() === '') {
                // Create notification for missing resume
                await notifyError(
                    userId,
                    'Resume Required',
                    'Please upload your resume before generating cover letters. Go to Profile (top right) to upload your resume.',
                    'upload_resume'
                );
                
                return res.status(400).json({ 
                    error: 'Resume required',
                    message: 'Please upload your resume before generating cover letters. Go to Profile (top right) to upload your resume.',
                    action: 'upload_resume'
                });
            }

            const results = [];
            let creditsDeducted = 0;

            // Load resume metadata once for all recipients, with retries (+ the Builder résumé, letterResumeMetadataFor)
            const resumeMetadata = await letterResumeMetadataFor(userId);

            if (!resumeMetadata) {
                return res.status(400).json({
                    error: 'Resume not processed yet',
                    message: 'Your resume is still being analyzed. This can take up to a minute. Please wait a moment and try again.'
                });
            }

            // ⚠️ ONE AI REFUSAL ENDS THE RUN (2026-09-18). aiText only gives up after it has waited, retried and walked
            // every fallback model inside its budget, and quota / auth is the key itself: the next recipient, asked a
            // second later, would get the same answer — after up to four more minutes of a request someone is holding
            // open. The rest are recorded with the same reason, not asked, and not charged.
            let aiRefused = null;
            for (const recipient of recipients) {
                if (aiRefused) {
                    results.push({ email: recipient.email, status: 'failed', reason: aiRefused.reason, retryable: !!aiRefused.retryable, error: aiRefused.message });
                    continue;
                }
                let ledgerId = null;   // THIS letter's usage row — given back if the letter is not handed over
                try {
                    console.log(`\n📤 Processing: ${recipient.email}`);

                    const { letter: aiResult } = await writeLegacyLetter(
                        resumeMetadata,
                        recipient.website,
                        recipient.position || 'Position'
                    );

                    const companyName = aiResult.employer_name || recipient.website;
                    const coverLetterText = aiResult.cover_letter;

                    console.log(`✅ Generated personalized cover letter for ${companyName}`);

                    // DEDUCT — only after THIS letter succeeded, one payment decision at a time per user
                    // (withUsageLock). entitlements picks the pool (plan → the Free plan) and writes the usage row.
                    // ⚠️ A LETTER NOTHING WILL PAY FOR IS REFUSED, NOT DELIVERED (2026-09-14). This used to swallow the
                    // answer — a 'none' (the last unit went to a parallel request) was a free letter, rendered and
                    // returned. Now: 'plan' / 'trial' deliver; 'none' is this letter failed with reason
                    // quota_exhausted and never rendered; 'error' (or anything unrecognised) is not a payment either.
                    // The letters that WERE paid for are kept.
                    let used = null;
                    try {
                        await withUsageLock(userId, 'cover_letter', async () => {
                            used = await entitlements.consumeOnSuccess(userId, 'cover_letter', {
                                companyName: companyName,
                                position: recipient.position,
                                recipientEmail: recipient.email,
                                screen: 'letters'
                            }, req);
                        });
                    } catch (lockError) {
                        // The lock's transaction failed; what ran under it was on the pool, so `used` still decides.
                        console.error('Failed to record usage (usage lock):', lockError.message);
                    }
                    const via = used && used.via ? used.via : 'error';
                    if (used && used.ledgerId) ledgerId = used.ledgerId;
                    if (via !== 'plan' && via !== 'trial') {
                        await giveBackLedgerRow(userId, ledgerId, `bulk letter for ${recipient.email} not paid (${via})`);
                        ledgerId = null;
                        const refused = via === 'none';
                        console.warn(`⛔ ${recipient.email}: ${refused ? 'nothing left to pay for this letter' : `the charge could not be confirmed (${via})`} — not delivered`);
                        results.push({
                            email: recipient.email,
                            status: 'failed',
                            ...(refused ? { reason: 'quota_exhausted' } : {}),
                            error: refused ? LETTER_ALLOWANCE_USED_UP : 'We could not record this cover letter against your plan. Please try again.',
                        });
                        continue;
                    }
                    creditsDeducted++;

                    // Format and generate PDF
                    const coverLetterHtml = formatCoverLetterWithHTML(coverLetterText, {});
                    const { filePath, fileName } = await generateCoverLetterPDF(
                        user,
                        coverLetterHtml,
                        companyName,
                        ''
                    );

                    const downloadUrl = `/api/download-cover-letter/${encodeURIComponent(fileName)}`;

                    results.push({
                        email: recipient.email,
                        company: companyName,
                        position: recipient.position || 'Position',
                        website: recipient.website,
                        fileName: fileName,
                        downloadUrl: downloadUrl,
                        status: 'generated',
                        metadata: {}
                    });
                    ledgerId = null;   // delivered: the unit stays spent

                } catch (error) {
                    console.error(`❌ Failed to generate for ${recipient.email}:`, error.message);
                    // ⚠️ Paid for, then not produced (the PDF threw): the unit goes back — never a charge for a
                    // letter that does not exist.
                    if (ledgerId) {
                        await giveBackLedgerRow(userId, ledgerId, `bulk letter for ${recipient.email} was not produced`);
                        creditsDeducted--;
                    }
                    if (isAiRefusal(error)) aiRefused = error;
                    results.push({
                        email: recipient.email,
                        status: 'failed',
                        ...(isAiRefusal(error) ? { reason: error.reason, retryable: !!error.retryable } : {}),
                        error: error.message,
                    });
                }
            }

            const successCount = results.filter(r => r.status === 'generated').length;
            
            // Update total_generated counter
            if (successCount > 0) {
                await dbConfig.run(
                    'UPDATE users SET total_generated = total_generated + ? WHERE id = ?',
                    [successCount, userId]
                );
            }
            
            // Get updated credit balance
            const creditCheck = await checkUserCredits(userId, 0);
            
            // ⚠️ EVERY LETTER REFUSED FOR THE ALLOWANCE AND NONE DELIVERED → THE 402 EVERY OTHER LANE ANSWERS, so
            // the client opens Plans instead of reading a 200 with nothing in it. A partial run stays a 200 and
            // names its refusals per letter (reason quota_exhausted).
            const quotaRefused = results.filter(r => r.reason === 'quota_exhausted').length;
            if (successCount === 0 && quotaRefused > 0) {
                return res.status(402).json({
                    error: LETTER_ALLOWANCE_USED_UP,
                    reason: 'quota_exhausted',
                    results,
                    creditsUsed: 0,
                    creditsRemaining: creditCheck.remaining
                });
            }
            // ⚠️ NO LETTER, AND THE AI WAS WHY → the 503 every lane answers (ai_busy: try again in a minute; ai_down:
            // nothing the user can do). Nothing was paid for: every AI call runs before its letter's charge.
            if (successCount === 0 && aiRefused) {
                return res.status(503).json({
                    ...aiRefusalBody(aiRefused),
                    results,
                    creditsUsed: 0,
                    creditsRemaining: creditCheck.remaining
                });
            }

            res.json({
                success: true,
                message: `Generated ${successCount}/${recipients.length} cover letters`,
                results,
                quotaRefused,
                creditsUsed: creditsDeducted,
                creditsRemaining: creditCheck.remaining
            });

        } catch (error) {
            console.error('Database error:', error);
            return res.status(500).json({ error: 'Failed to load user profile' });
        }
    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({ error: error.message });
    }
};

// ── ONE TAP, ONE LETTER JOB — /generate-cover-letter-details is idempotent ──────────────────────────────────
//
// ⚠️ A LOST 202 WAS A SECOND CHARGE. The job starts the moment it is created; when the 202 never reached the phone
// (a tunnel, a dropped socket) the Letters page resent the POST by itself — up to twice — and the Job Hub's retry
// did the same by hand. Every copy was a new job that wrote a letter and consumed a unit: two units, one letter on
// screen. The rule is middleware/asyncJob.js's, which this route cannot wear (it runs its own worker):
//   • a body carrying `clientBuildId` (one per tap, reused by THAT tap's retries) is deduped per (user, id) for 15
//     minutes — in memory, claimed SYNCHRONOUSLY before the first await, then in async_jobs (input->>'clientBuildId'),
//     so a restart between the lost 202 and the retry still finds the job;
//   • a body WITHOUT one (the Letters page, in every build already installed) joins an IDENTICAL request's job while
//     that job is still running in this process — same recipient, site, position and posting. That is exactly the
//     automatic resend, and a second tap on the same letter while the first is being written: both mean "that
//     letter, once". The claim is released when the job ends, so the next deliberate tap is a new letter.
// A repeat is answered 202 { jobId, deduped: true } with the FIRST job's id; neither the gate nor the worker runs again.
// ⚠️ ONLY A LIVE OR FINISHED JOB IS JOINED. A failed or cancelled one is not — a Try again after "Google's AI is busy"
// must really try again — and neither is a job that cannot be found.
// ⚠️ BEFORE THE GATE, on purpose: the retry of a letter that spent the LAST unit would otherwise be refused 402 while
// the letter it paid for sits finished in the first job.
// Async lane only — the synchronous lane has no job id to hand back.
const LETTER_BUILD_TTL_MS = 15 * 60 * 1000;
const LETTER_INFLIGHT_TTL_MS = 10 * 60 * 1000;   // a safety net only: an in-flight claim is released when its job ends
const LETTER_CLAIMS_MAX = 5000;
const letterClaims = new Map();   // key → { at, ttlMs, jobIdPromise: Promise<string|null> }

function letterBuildIdOf(body) {
    const v = body && body.clientBuildId;
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return t && t.length <= 128 ? t : null;
}

/** What makes two requests WITHOUT a clientBuildId "the same letter": recipient, site, position and posting. */
function letterRequestKeyOf(userId, body) {
    const b = body || {};
    const s = (v) => String(v == null ? '' : v).trim().toLowerCase();
    const site = s(b.websiteUrl).replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
    return `${userId}|same|` + JSON.stringify([s(b.recipientEmail), site, s(b.position), s(b.jobId), s(b.companyName), s(b.jobUrl)]);
}

function pruneLetterClaims(now) {
    // No early break: two TTLs live in this map, so insertion order is not expiry order.
    for (const [k, v] of letterClaims) {
        if (now - v.at >= v.ttlMs || letterClaims.size > LETTER_CLAIMS_MAX) letterClaims.delete(k);
    }
}

/** May a repeat be handed this job? Only one still running, or finished. Unreadable → yes: joining cannot charge twice. */
async function letterJobJoinable(jobId, userId) {
    try {
        const row = await jobService.getJob(jobId, userId);
        return !!row && row.status !== 'failed' && row.status !== 'cancelled';
    } catch (e) {
        console.warn(`[coverLetter] could not read job ${jobId} for a repeat (${e.message}) — joining it`);
        return true;
    }
}

/**
 * Join the job an earlier copy of this request made, or take the claim to make it.
 * → { joinedJobId } | { settle(jobIdOrNull), release() }
 * ⚠️ CALL IT BEFORE THE HANDLER'S FIRST AWAIT: up to its own first await it runs synchronously, and that is what
 * lets exactly one of two racing copies create the job while the other waits for its id.
 */
async function joinOrClaimLetterJob(key, userId, ttlMs) {
    const now = Date.now();
    pruneLetterClaims(now);
    const prior = letterClaims.get(key);
    if (prior && now - prior.at < prior.ttlMs) {
        const priorId = await prior.jobIdPromise;
        if (priorId && await letterJobJoinable(priorId, userId)) return { joinedJobId: priorId };
        // Another waiter re-claimed while this one waited: wait for THAT claim instead of racing it.
        const current = letterClaims.get(key);
        if (current && current !== prior) return joinOrClaimLetterJob(key, userId, ttlMs);
    }
    let resolveClaim;
    const mine = { at: Date.now(), ttlMs, jobIdPromise: new Promise((r) => { resolveClaim = r; }) };
    letterClaims.delete(key);   // re-insert at the END
    letterClaims.set(key, mine);
    let settled = false;
    return {
        // The job this claim produced (null: none — the gate refused, the request failed): a waiter joins it or retries.
        settle: (jobId) => {
            if (settled) return;
            settled = true;
            resolveClaim(jobId || null);
            if (!jobId && letterClaims.get(key) === mine) letterClaims.delete(key);
        },
        release: () => { if (letterClaims.get(key) === mine) letterClaims.delete(key); },
    };
}

/** The durable half: this clientBuildId's live or finished job in async_jobs, within the 15 minutes. */
async function findLetterJobByBuildId(userId, clientBuildId) {
    const row = await dbConfig.get(
        `SELECT id FROM async_jobs
          WHERE user_id = $1 AND type = 'generate_cover_letter' AND input->>'clientBuildId' = $2
            AND created_at > NOW() - INTERVAL '15 minutes' AND status NOT IN ('failed', 'cancelled')
          ORDER BY created_at DESC LIMIT 1`,
        [userId, clientBuildId]
    );
    return row ? row.id : null;
}

// Generate cover letter details (for review page)
const generateCoverLetterDetails = async (req, res) => {
    const requestId = Date.now();
    const startTime = Date.now();
    const useAsync = process.env.USE_ASYNC_JOBS !== 'false';
    let claim = null;   // this request's claim on "one tap, one job" (async lane only)

    try {
        const userId = req.user.id;
        let { recipientEmail, websiteUrl, position, responsibilities, jobLocation, jobId: sourceJobId, companyName: companyNameHint, jobUrl, jobText } = req.body;

        // ONE TAP, ONE JOB (see letterClaims above) — before the first await, and before the gate.
        const clientBuildId = useAsync ? letterBuildIdOf(req.body) : null;
        if (useAsync) {
            const got = await joinOrClaimLetterJob(
                clientBuildId ? `${userId}|build|${clientBuildId}` : letterRequestKeyOf(userId, req.body),
                userId, clientBuildId ? LETTER_BUILD_TTL_MS : LETTER_INFLIGHT_TTL_MS,
            );
            if (got.joinedJobId) {
                console.log(`🔁 [${requestId}] repeat of a letter request for user ${userId} — the same job ${got.joinedJobId}, not re-run`);
                return res.status(202).json({ jobId: got.joinedJobId, status: 'pending', deduped: true });
            }
            claim = got;
            if (clientBuildId) {
                const durable = await findLetterJobByBuildId(userId, clientBuildId).catch((e) => {
                    console.warn(`[coverLetter] durable clientBuildId lookup failed (memory only this time): ${e.message}`);
                    return null;
                });
                if (durable) {
                    claim.settle(durable);
                    console.log(`🔁 [${requestId}] clientBuildId repeat for user ${userId} — job ${durable} found in async_jobs, not re-run`);
                    return res.status(202).json({ jobId: durable, status: 'pending', deduped: true });
                }
            }
        }
        // Which screen this letter is for, on its usage row: the Job Hub sends the job it is for, the Letters page does not.
        const lane = sourceJobId ? 'job_hub_letter' : 'letters_page';
        // The real posting, when the user pasted one (letterListingOf — context for the prompt only).
        const listing = letterListingOf({ jobUrl, jobText, position, companyNameHint });
        // The company a PASS attaches to, and whether one covers this generation. Resolved here and
        // threaded into the worker (see the gate below).
        //
        // ⚠️ THE MAIN LETTERS SCREEN SENDS NO COMPANY AT ALL — App.js posts exactly
        // { recipientEmail, websiteUrl, position }. Taking the employer from `employer ||
        // companyNameHint` therefore left it null on the app's primary letter flow, the pass was
        // never consulted, and a pass holder was told they were out of plan letters for the letter
        // their pass explicitly includes. So derive a spelling from the one identifier that request
        // does carry, the website, and let resolveEmployer prefer whichever candidate ALREADY owns a
        // pass — that is how a pass bound by the resume download under "Acme Corp" still covers
        // "acme.com" here.
        const passHost = (() => {
            try {
                const raw = String(websiteUrl || '').trim();
                if (!raw) return '';
                const u = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
                return new URL(u).hostname.replace(/^www\./i, '');
            } catch { return ''; }
        })();
        const passEmployer = await downloads.resolveEmployer(
            userId, [(req.body || {}).employer, companyNameHint, passHost], req,
        ).catch(() => ((req.body || {}).employer || companyNameHint || passHost || '').trim() || null);
        let passViaPass = false;
        let passEnv = null;

        // Job-aware augmentation: the dashboard LIST payload trims responsibilities to 3 for
        // speed — when the client says which job this is, prefer the FULL stored list so the
        // letter's tailoring never depends on what the client happened to hold.
        if (sourceJobId) {
            try {
                // Scoped to the caller's own matched jobs (same ownership rule as /jobs/:id/full).
                const row = await dbConfig.get(
                    'SELECT j.responsibilities FROM jobs j JOIN user_job_matches ujm ON ujm.job_id = j.id WHERE j.id = ? AND ujm.user_id = ?',
                    [sourceJobId, userId]
                );
                const full = row && row.responsibilities
                    ? (typeof row.responsibilities === 'string' ? JSON.parse(row.responsibilities) : row.responsibilities)
                    : [];
                if (Array.isArray(full) && full.length > (Array.isArray(responsibilities) ? responsibilities.length : 0)) {
                    responsibilities = full;
                }
            } catch { /* augmentation is best-effort — the client-sent list still works */ }
        }

        console.log(`\n📨 [${requestId}] Generate Cover Letter Details Request (${useAsync ? 'ASYNC' : 'SYNC'})`);
        console.log(`   User: ${userId}, Position: ${position}`);
        emit(req, 'cover_letter_generate', { forJob: !!sourceJobId });

        // GATE (always synchronous — fast DB check): plan/trial quota first, credits fallback.
        // Deduction is on SUCCESS only, further down.
        try {
            // A single-employer pass includes ONE AI cover letter for that company. The decision is
            // made HERE, where req exists, and carried into the worker: the charge happens after
            // the response has already gone.
            //
            // ⚠️ THE PLAN IS ASKED FIRST, AND THE PASS IS THE FALLBACK. Spending someone's one-off
            // while their plan or free allowance could have paid destroys what they bought for
            // nothing. `boundOnly` says exactly that: while quota remains, only a pass ALREADY
            // bound to THIS employer may pay (they bought it for precisely this letter); an unspent
            // pass is left alone. Once quota is gone the pass is consulted in full — and the gate
            // RESERVES it, so two letters for two companies inside one AI minute cannot both ride
            // the same pass.
            passEnv = downloads.envOf(req);
            const quota = await entitlements.canConsumeMany(userId, 'cover_letter', 1, req);
            passViaPass = await downloads
                .passCoversGeneration(userId, 'cover_letter', passEmployer, passEnv, { boundOnly: quota.allowed })
                .catch(() => false);
            const gate = passViaPass ? { allowed: true } : quota;
            if (!gate.allowed) {
                return res.status(402).json({
                    error: gate.message,
                    reason: 'quota_exhausted',
                    remainingCredits: 0,
                    creditsRequired: 1
                });
            }
        } catch (error) {
            return res.status(500).json({ error: 'Failed to check your plan allowance' });
        }

        // Get user profile (always synchronous — fast DB check)
        const user = await dbConfig.get('SELECT * FROM users WHERE id = ?', [userId]);
        
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        if (!user.resume_path || user.resume_path.trim() === '') {
            await notifyError(
                userId,
                'Resume Required',
                'Please upload your resume before generating cover letters. Go to Profile (top right) to upload your resume.',
                'upload_resume'
            );
            
            return res.status(400).json({ 
                error: 'Resume required',
                message: 'Please upload your resume before generating cover letters. Go to Profile (top right) to upload your resume.',
                action: 'upload_resume'
            });
        }

        if (useAsync) {
            // ASYNC MODE: Create job and return immediately
            // clientBuildId rides in the input: it is what the durable half of "one tap, one job" finds after a restart.
            // sourceJobId (the Job Hub's job) is where the finished letter is stored server-side (processGenerationJob).
            const jobId = await jobService.createJob(userId, 'generate_cover_letter', {
                recipientEmail, websiteUrl, position, responsibilities, jobLocation, companyNameHint, listing,
                passEmployer, passViaPass, passEnv, lane,
                ...(sourceJobId ? { sourceJobId: String(sourceJobId) } : {}),
                ...(clientBuildId ? { clientBuildId } : {}),
            });
            console.log(`🚀 [${requestId}] Async job created: ${jobId}`);
            if (claim) claim.settle(jobId);
            // A request with no clientBuildId is "the same letter" only while it is being written.
            const inFlightClaim = clientBuildId ? null : claim;

            // Respond immediately with 202
            res.status(202).json({ jobId, status: 'pending' });

            // Fire and forget — process in background
            processGenerationJob(jobId, userId, { recipientEmail, websiteUrl, position, responsibilities, jobLocation, companyNameHint, listing, passEmployer, passViaPass, passEnv, lane, sourceJobId: sourceJobId ? String(sourceJobId) : null }).catch(err => {
                console.error(`❌ [${requestId}] Async job ${jobId} failed:`, err.message);
                // The stored failure message is shown to the user by the poller —
                // only deliberately user-facing text may pass through.
                const safeMsg = (err.userFacing || /^Resume not processed yet/.test(err.message || ''))
                    ? err.message
                    : 'Failed to generate the cover letter. Please try again.';
                // ⚠️ A REFUSAL KEEPS ITS REASON. A letter nothing would pay for (quota_exhausted) must not read as
                // "something broke, try again" — trying again is the loop that ends at the same refusal. An AI
                // refusal (ai_busy / ai_down) carries whether trying again can help.
                if (err.reason) {
                    failJobWithReason(jobId, safeMsg, err.reason, isAiRefusal(err) ? { retryable: !!err.retryable } : null)
                        .catch(() => jobService.failJob(jobId, safeMsg).catch(console.error));
                } else {
                    jobService.failJob(jobId, safeMsg).catch(console.error);
                }
            }).finally(() => { if (inFlightClaim) inFlightClaim.release(); });

        } else {
            // SYNC MODE: Original behavior — hold connection until done
            // The pass decision travels into SYNC mode as well — without it a pass holder was gated
            // on the pass and then charged again by the plan when the letter landed.
            const result = await executeGenerationWork(userId, user, {
                recipientEmail, websiteUrl, position, responsibilities, jobLocation, companyNameHint, listing,
                passEmployer, passViaPass, passEnv, lane,
            });

            const duration = Date.now() - startTime;
            console.log(`✅ [${requestId}] Response sent in ${duration}ms`);

            res.json(result);
        }

    } catch (error) {
        const duration = Date.now() - startTime;
        console.error(`❌ [${requestId}] Error (${duration}ms):`, error.message);
        // No model could write it (aiText's final failure) → 503 ai_busy / ai_down, and it says nothing was charged.
        if (isAiRefusal(error)) return res.status(503).json(aiRefusalBody(error));
        // Only deliberately user-facing messages may reach the client; raw internal
        // errors (JSON SyntaxError, DB, API) are logged above and replaced.
        const safeMessage = (error.userFacing || /^Resume not processed yet/.test(error.message || ''))
            ? error.message
            : 'Failed to generate the cover letter. Please try again.';
        // The worker's refusal (nothing left to pay for the finished letter) keeps its 402 and its reason.
        res.status(error.reason === 'quota_exhausted' ? 402 : 500)
            .json({ error: safeMessage, ...(error.reason ? { reason: error.reason } : {}) });
    } finally {
        // Every way out that made no job (a 402, a 400, an error) lets a waiting copy retry instead of joining nothing.
        if (claim) claim.settle(null);
    }
};

// ── THE RESEARCH NEXT TO THE LETTER IS BOUNDED ─────────────────────────────────────────────────────────────
// ⚠️ researchEmployer is ONE model call with no timeout at all (ai-employer-researcher.js), and on a brand-cache miss
// the worker waited for it next to the letter (Promise.all). A research that hung kept a PAID letter from being
// delivered: the Job Hub gave up at five minutes, the user tapped again and paid again, and the first letter was
// charged the moment the research finally answered. It only picks a brand colour and a font — so after
// LETTER_RESEARCH_BUDGET_MS the letter goes out with the defaults, and a job can never outlive the metadata wait +
// LEGACY_LETTER_BUDGET_MS. The research itself is not cancelled (the SDK call cannot be); its late answer is dropped.
const LETTER_RESEARCH_BUDGET_MS = 60 * 1000;
const letterTiming = { researchBudgetMs: LETTER_RESEARCH_BUDGET_MS };   // exported through _internals: suites shrink it

function boundedLetterResearch(researchSubject) {
    let timer = null;
    const late = new Promise((resolve) => {
        timer = setTimeout(() => {
            console.warn(`[employer] research for ${researchSubject} took over ${Math.round(letterTiming.researchBudgetMs / 1000)}s — the letter goes out with the default brand`);
            resolve(null);
        }, letterTiming.researchBudgetMs);
        if (timer && typeof timer.unref === 'function') timer.unref();
    });
    const research = Promise.resolve()
        .then(() => researchEmployer(researchSubject))
        .catch((e) => { console.error('[employer] research failed:', e.message); return null; });
    return Promise.race([research, late]).finally(() => clearTimeout(timer));
}

/**
 * The actual heavy generation work — used by both sync and async modes
 */
// `report(stage, label)` — the async job's retry reporter (legacyJobReporter); absent in sync mode and batch-process.
// `jobId` — the async job this letter belongs to (the single-letter job, or batch-process's batch): a cancel of it is
//   read under the usage lock, before anything is charged. `onCharged()` — called under that lock the moment the
//   charge lands (processGenerationJob marks its job 'charged', which is what makes a later cancel refuse).
// `lane` — which screen asked ('letters_page', 'job_hub_letter', 'letters_batch'), written on the usage row.
async function executeGenerationWork(userId, user, { recipientEmail, websiteUrl, position, responsibilities = null, jobLocation = null, companyNameHint = null, listing = null, passEmployer = null, passViaPass = false, passEnv = null, report = null, jobId = null, onCharged = null, lane = null }) {
    console.log(`🚀 [executeGenerationWork] ENTERED — userId=${userId}, websiteUrl=${websiteUrl}, position=${position}, hasResponsibilities=${!!(responsibilities && responsibilities.length)}, jobLocation=${jobLocation || 'none'}, companyHint=${companyNameHint || 'none'}`);
    // Who do we actually research? The website — or the company name when the only URL is a job board.
    const { normalizedWebsiteUrl, researchSubject } = letterResearchSubjectOf(websiteUrl, companyNameHint);
    if (researchSubject !== normalizedWebsiteUrl) console.log(`🏢 [employer] job-board URL detected → researching "${researchSubject}" instead of ${normalizedWebsiteUrl}`);

    // Load pre-parsed resume metadata (generated by resumeParserService after upload), waiting in case the
    // background parser is still running — with the Builder résumé merged in.
    const resumeMetadata = await letterResumeMetadataFor(userId);

    if (!resumeMetadata) {
        throw new Error('Resume not processed yet. Please wait a moment after uploading and try again.');
    }

    // Cancelled while the résumé was being read (up to 20 s) — or, in a batch, before this letter's turn came: no AI
    // call for a letter nobody is waiting for. (The deciding read is the one under the usage lock below.)
    if (await letterJobCancelled(jobId)) {
        console.log(`🛑 [executeGenerationWork] job ${jobId} was cancelled before the letter to ${normalizedWebsiteUrl} was written — not written, not charged`);
        throw letterCancelled();
    }

    console.log(`[coverLetterController] Starting generation for user ${userId}, url=${normalizedWebsiteUrl}, position=${position}`);

    // Check employer brand cache first
    const cached = await dbConfig.get(
        'SELECT brand_color, font_name FROM employer_brand_profiles WHERE website_url = ?',
        [researchSubject]
    );

    let brandColor, fontName, aiResult;

    // ⚠️ A throw from writeLegacyLetter (an AI refusal, a letter that could not be finished) leaves BEFORE the charge
    // below: nothing is paid for and nothing is handed over.
    if (cached) {
        // Cache hit — run cover letter generation alone at full speed
        console.log(`🎨 [employer] Cache hit → color=${cached.brand_color}, font=${cached.font_name}`);
        ({ letter: aiResult } = await writeLegacyLetter(resumeMetadata, researchSubject, position, responsibilities, jobLocation, listing, { report }));
        brandColor = cached.brand_color;
        fontName = cached.font_name;
    } else {
        // Cache miss — run cover letter generation + full employer research IN PARALLEL
        // (the research bounded: boundedLetterResearch answers null after LETTER_RESEARCH_BUDGET_MS)
        console.log(`🔍 [employer] Cache miss — running cover letter + employer research in parallel`);
        const [clResult, researchData] = await Promise.all([
            writeLegacyLetter(resumeMetadata, researchSubject, position, responsibilities, jobLocation, listing, { report }),
            boundedLetterResearch(researchSubject),
        ]);
        aiResult = clResult.letter;
        brandColor = researchData?.brand_color || '#262633';
        fontName   = researchData?.font_name   || 'Lato';
        // Persist all employer research tables (non-blocking)
        console.log(`🔬 [employer] researchData received:`, researchData ? `name=${researchData.employer_name}, color=${researchData.brand_color}, font=${researchData.font_name}` : 'NULL');
        if (researchData) {
            saveEmployerResearch(researchData).catch(err => {
                console.error('[employer] saveEmployerResearch FAILED:', err.message, err.stack);
            });
        } else {
            console.warn('[employer] researchData was null — skipping DB save');
        }
    }

    // The answer → the letter (letterDetailsOf: the one mapping, which Home's employer letter goes through too).
    const { companyName, hiringManager, subject, locations, coverLetterHtml } = letterDetailsOf(aiResult, {
        position, companyNameHint, researchSubject, jobLocation,
    });

    // DEDUCT — only now, after the letter was actually produced. entitlements picks the pool (plan → the
    // Free plan) and writes the usage-ledger row for the Usage screen.
    // ⚠️ ONE PAYMENT DECISION AT A TIME PER USER (withUsageLock). This worker took no lock, and its gate ran a
    // minute ago and reserves nothing: two letters finishing together (batch-process runs three at once, a
    // second device, Home's letter lane) both read "1 left" and both wrote a row — past a one-time allowance.
    // ⚠️ AND A LETTER NOTHING WILL PAY FOR IS NOT DELIVERED (2026-09-14). consumeOnSuccess answering 'none' (the
    // last unit went to an overlapping request) was logged as "Usage recorded via none" and the letter handed
    // over anyway — a free letter per parallel tap. It now throws the quota_exhausted refusal: sync → 402, the
    // async job → failed WITH its reason, batch-process → that one letter refused. 'error' (or anything
    // unrecognised) is not a payment either, and whatever it wrote goes back.
    // ⚠️ AND A CANCELLED LETTER IS NOT CHARGED (2026-09-19). The Letters page's Cancel and the Job Hub's deadline used
    // to stop only the phone; this worker carried on and charged a letter nobody would ever see. The cancel is read
    // HERE, under the same lock POST /job-cancel takes, before the pass or the allowance is touched — and the moment
    // a charge lands, onCharged marks the job 'charged' (still under the lock), which is what makes a later cancel
    // refuse. So a letter is either cancelled and free, or paid for and delivered: never paid for and thrown away.
    let used = null;
    let cancelled = false;
    try {
        await withUsageLock(userId, 'cover_letter', async () => {
            if (await letterJobCancelled(jobId)) { cancelled = true; return; }
            // ⚠️ Spend the PASS first when one covered this. Falls back to the plan if the claim did
            // not land (another tap won the same pass) — losing that race must not mean a free letter.
            let spentPass = false;
            if (passViaPass) {
                // The AI has now read the real employer name off the posting, which is a better spelling
                // than anything the gate had — bind on it, so the download screens (which send that same
                // name) match this pass exactly instead of asking for a second payment.
                const claimed = await downloads.claimGeneration(userId, 'cover_letter', passEmployer || companyName, passEnv);
                spentPass = !!claimed.charged;
                if (spentPass) console.log(`✅ Cover letter covered by a download pass for ${passEmployer || companyName}`);
            }
            // ⚠️ THE FALLBACK CHARGE NEEDS THE GATE'S ENVIRONMENT. This runs in the worker, with no req,
            // so requestEnvironment({}) would answer Production while the gate resolved Sandbox — and a
            // TestFlight subscriber's letter would be charged to the wrong allowance, or refused outright.
            used = spentPass ? { via: 'pass' } : await entitlements.consumeOnSuccess(userId, 'cover_letter', {
                companyName,
                position,
                recipientEmail,
                // Which screen wrote it, so the Usage screen (and support) can tell the letters apart: every lane in
                // this file used to write the same screen below. `screen` keeps its old value — reports group on it.
                ...(lane ? { lane } : {}),
                screen: 'job_cover_letter'
            }, { storeEnv: passEnv || undefined });
            if (onCharged && used && (used.via === 'pass' || used.via === 'plan' || used.via === 'trial')) {
                // ⚠️ RETRIED. The mark is what makes a later cancel refuse a PAID letter (cancelJob's 'charged' guard); left
                // unwritten, a cancel after this point would say "nothing was charged" about a unit already spent.
                let marked = false;
                for (let tryNo = 1; tryNo <= 3 && !marked; tryNo++) {
                    try { await onCharged(); marked = true; } catch (markError) {
                        console.warn(`[executeGenerationWork] could not mark job ${jobId} charged (try ${tryNo}/3): ${markError.message}`);
                        if (tryNo < 3) await new Promise((r) => setTimeout(r, 150 * tryNo));
                    }
                }
                if (!marked) console.error(`❌ [executeGenerationWork] job ${jobId} is CHARGED but not marked — a cancel now would wrongly succeed against a paid letter; support: user ${userId}`);
            }
        });
    } catch (lockError) {
        // The lock's transaction failed (lock_timeout, a dead connection, its COMMIT). What ran under it was on
        // the pool and is not rolled back, so `used` — this letter's own answer — decides, never the lock.
        console.error(`❌ [executeGenerationWork] usage lock failed for user ${userId}:`, lockError.message);
    }
    if (cancelled) {
        console.log(`🛑 [executeGenerationWork] job ${jobId} was cancelled — user ${userId}'s letter to ${companyName} is not charged and not delivered`);
        throw letterCancelled();
    }
    const via = used && used.via ? used.via : 'error';
    if (via === 'none') {
        console.warn(`⛔ Nothing left to pay for user ${userId}'s letter to ${companyName} (the last unit went to an overlapping request) — refused, not delivered`);
        throw letterQuotaRefusal();
    }
    if (via !== 'pass' && via !== 'plan' && via !== 'trial') {
        await giveBackLedgerRow(userId, used && used.ledgerId, `the charge could not be confirmed (${via})`);
        console.error(`❌ The charge for user ${userId}'s letter to ${companyName} could not be confirmed (${via}) — not delivered`);
        const unconfirmed = new Error('We could not record this cover letter against your plan. Please try again.');
        unconfirmed.userFacing = true;
        throw unconfirmed;
    }
    console.log(`✅ Usage recorded via ${via}`);

    // Best-effort: a counter that did not move is no reason to withhold a letter that was paid for.
    await dbConfig.run(
        'UPDATE users SET total_generated = total_generated + 1 WHERE id = ?',
        [userId]
    ).catch((counterError) => console.error('❌ total_generated not updated:', counterError.message));

    // Get updated credits — DISPLAY ONLY (creditsRemaining below; credits pay for no letter since 2026-09-13).
    // ⚠️ NEVER A REASON TO LOSE A PAID LETTER. checkUserCredits rethrows a database error, and this runs AFTER the
    // charge: the worker used to throw here, the job failed with "Failed to generate the cover letter", and the unit
    // stayed spent on a letter nobody received. A failed read is now shown as 0.
    let creditsRemaining = 0;
    try {
        const creditCheck = await checkUserCredits(userId, 0);
        creditsRemaining = creditCheck.remaining;
        console.log(`💰 User ${userId} now has ${creditsRemaining} credits remaining`);
    } catch (creditError) {
        console.warn(`[executeGenerationWork] credit balance unreadable for user ${userId} (${creditError.message}) — the paid letter is delivered anyway`);
    }

    // Create notification
    try {
        await notifyCoverLetterGenerated(userId, companyName, position, normalizedWebsiteUrl);
    } catch (notifError) {
        console.error('Failed to create notification:', notifError);
    }

    return {
        success: true,
        companyName,
        hiringManager,
        subject,
        locations,
        coverLetterHtml,
        brandColor,
        fontName,
        metadata: {},
        creditsUsed: 1,
        creditsRemaining
    };
}

/**
 * The address line the Job Hub shows for a letter: the office the server put first (the job's own office when it
 * matched, else the HQ), its parts joined once each. '' when nothing real was found.
 */
function jobHubAddressOf(locations) {
    const list = Array.isArray(locations) ? locations : [];
    const best = list.find((l) => l && l.matchesJobLocation) || list.find((l) => l && l.isHeadquarters) || list[0];
    if (!best) return '';
    const parts = [];
    for (const p of [best.address, best.city, best.country]) {
        const t = String(p || '').trim();
        if (!t || t === ADDRESS_NOT_AVAILABLE) continue;
        if (parts.some((q) => q.toLowerCase().includes(t.toLowerCase()))) continue;
        parts.push(t);
    }
    return parts.join(', ');
}

/**
 * ⚠️ A PAID JOB HUB LETTER IS STORED BY THE SERVER, NOT ONLY BY THE PHONE. The job-detail screen saved the letter
 * (saveJobCoverLetter) only in its own success path — so a user who left the screen, or whose app gave up waiting,
 * had paid for a letter that existed nowhere but async_jobs.result, deleted a day later; reopening the job showed
 * nothing and invited a second paid generation. The letter now lands on the job's job_cover_letters row as soon as it
 * is paid for, through aiHubController's own save handler (the canonical job id, the never-erase-a-letter and
 * never-demote-applied rules are its, reused rather than copied). The phone's own save, which follows, still writes
 * the office the user picked. Never throws: the letter is delivered through the job either way.
 */
async function storeJobHubLetter(userId, sourceJobId, input, result) {
    try {
        const hub = require('./aiHubController');
        const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
        await hub.saveJobCoverLetter({
            user: { id: userId },
            params: { jobId: String(sourceJobId) },
            body: {
                coverLetterHtml: result.coverLetterHtml,
                companyName: result.companyName,
                websiteUrl: input.websiteUrl,
                position: input.position,
                companyAddress: jobHubAddressOf(result.locations),
                companyLocations: result.locations || [],
            },
        }, res);
        if (res.statusCode >= 400) console.error(`[coverLetter] ⚠️ the Job Hub letter for job ${sourceJobId} (user ${userId}) was not stored (${res.statusCode}) — the phone's own save is the fallback`);
        else console.log(`💾 [coverLetter] Job Hub letter stored on job ${sourceJobId} for user ${userId}`);
    } catch (e) {
        console.error(`[coverLetter] ⚠️ the Job Hub letter for job ${sourceJobId} (user ${userId}) was not stored:`, e.message);
    }
}

/**
 * Process a generation job asynchronously (called fire-and-forget)
 */
async function processGenerationJob(jobId, userId, input) {
    await jobService.startJob(jobId);
    // Cancelled before its worker got to it: nothing ran, nothing is charged, and the cancel's row stays as it is.
    if (await letterJobCancelled(jobId)) {
        console.log(`🛑 Async job ${jobId} was cancelled before it started — nothing written, nothing charged`);
        return;
    }
    await jobService.updateJobProgress(jobId, 10);

    const user = await dbConfig.get('SELECT * FROM users WHERE id = ?', [userId]);
    await jobService.updateJobProgress(jobId, 20);

    // The retry reporter rides only here: the job row is where a poller would read "Google's AI is busy".
    // The cancel is read under the usage lock (jobId), and the charge marks the job 'charged' under it (onCharged).
    const result = await executeGenerationWork(userId, user, {
        ...input,
        jobId,
        report: legacyJobReporter(jobId),
        onCharged: () => jobService.updateJobPartialResult(jobId, { stage: 'charged', label: 'Finishing your letter' }),
    });
    // The Job Hub's letter is stored BEFORE the job reads completed: a poller that sees "completed" (and then saves
    // the office its user picked) always writes after this, never under it.
    if (input && input.sourceJobId) await storeJobHubLetter(userId, input.sourceJobId, input, result);
    // ⚠️ A PAID LETTER IS NOT FAILED OVER ONE WRITE. A completeJob that threw left the job to the catch, which failed
    // it — the unit spent, the letter gone. Asked once more; only a second failure fails the job.
    try {
        await jobService.completeJob(jobId, result);
    } catch (completeError) {
        console.warn(`[coverLetter] completeJob failed for job ${jobId} (${completeError.message}) — asking once more`);
        await jobService.completeJob(jobId, result);
    }
    console.log(`✅ Async job ${jobId} completed successfully`);
}

// Generate cover letter PDF for download
//
// ⚠️ THIS IS A PAID DOWNLOAD, AND FOR A LONG TIME IT WAS THE ONE THAT FORGOT TO ASK.
// generateRichCoverLetterPDF here is byte-for-byte the generator the gated 'generic' template path
// uses, so any signed-in account could POST its own HTML and get the paid file for nothing — one tap
// away from the 403 the template route returns. Same gate, same claim, same employer resolution.
const generateCoverLetterPdf = async (req, res) => {
    const useAsync = process.env.USE_ASYNC_JOBS === 'true';
    
    try {
        const userId = req.user.id;
        const { coverLetterHtml, companyName, companyAddress, websiteUrl } = req.body;
        let { brandColor, fontName } = req.body;

        // Get user profile
        const user = await dbConfig.get('SELECT * FROM users WHERE id = ?', [userId]);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Both spellings plus the site, so a pass bought on the resume side covers this letter.
        const passEmployer = await downloads.resolveEmployer(
            userId, [(req.body || {}).employer, companyName, websiteUrl], req,
        ).catch(() => companyName || null);
        if (!(await requirePaidForDownload(userId, res, passEmployer, req))) return;

        // If brand data not passed by client, look it up from employer_brand_profiles cache
        if (!brandColor || !fontName) {
            // Step 1: Try direct URL lookup
            let lookupUrl = websiteUrl;
            if (lookupUrl && !lookupUrl.startsWith('http')) lookupUrl = 'https://' + lookupUrl;
            if (lookupUrl) {
                const cached = await dbConfig.get(
                    'SELECT brand_color, font_name FROM employer_brand_profiles WHERE website_url = ?',
                    [lookupUrl]
                );
                if (cached) {
                    brandColor = brandColor || cached.brand_color;
                    fontName   = fontName   || cached.font_name;
                    console.log(`🎨 [PDF DOWNLOAD] Brand from URL cache: color=${brandColor}, font=${fontName}`);
                }
            }

            // Step 2: Look up stored_recipient_website from this user's cover letter rows, match by company name first word
            if (!brandColor && companyName) {
                const firstWord = companyName.split(/\s+/)[0];
                const rclRow = await dbConfig.get(
                    `SELECT stored_recipient_website FROM review_cover_letters
                     WHERE user_id = ? AND stored_recipient_website IS NOT NULL AND stored_recipient_website <> ''
                     AND company_name ILIKE ?
                     LIMIT 1`,
                    [userId, `%${firstWord}%`]
                );
                if (rclRow?.stored_recipient_website) {
                    let rclUrl = rclRow.stored_recipient_website;
                    if (!rclUrl.startsWith('http')) rclUrl = 'https://' + rclUrl;
                    const cached = await dbConfig.get(
                        'SELECT brand_color, font_name FROM employer_brand_profiles WHERE website_url = ?',
                        [rclUrl]
                    );
                    if (cached) {
                        brandColor = brandColor || cached.brand_color;
                        fontName   = fontName   || cached.font_name;
                        console.log(`🎨 [PDF DOWNLOAD] Brand from cover letter URL (${rclUrl}): color=${brandColor}, font=${fontName}`);
                    }
                }
            }

            // Step 3: Fuzzy match on employer_profiles.employer_name
            if (!brandColor && companyName) {
                const firstWord = companyName.split(/\s+/)[0];
                const byName = await dbConfig.get(
                    `SELECT ebp.brand_color, ebp.font_name
                     FROM employer_brand_profiles ebp
                     JOIN employer_profiles ep ON ep.website_url = ebp.website_url
                     WHERE ep.employer_name ILIKE ?
                     LIMIT 1`,
                    [`%${firstWord}%`]
                );
                if (byName) {
                    brandColor = brandColor || byName.brand_color;
                    fontName   = fontName   || byName.font_name;
                    console.log(`🎨 [PDF DOWNLOAD] Brand by name fuzzy match: color=${brandColor}, font=${fontName}`);
                }
            }

            if (!brandColor) console.log(`🎨 [PDF DOWNLOAD] No brand found — using default dark grey`);
        }

        // Use the EXACT same PDF generator as the email attachment flow
        console.log('🖨️ [PDF DOWNLOAD] companyName:', companyName, '| companyAddress:', companyAddress);
        console.log('🖨️ [PDF DOWNLOAD] brandColor:', brandColor, '| fontName:', fontName);
        console.log('🖨️ [PDF DOWNLOAD] html length:', coverLetterHtml?.length, '| preview:', coverLetterHtml?.slice(0, 80));
        const generateRichPDF = () => generateRichCoverLetterPDF(user, coverLetterHtml, companyName, companyAddress || '', brandColor || null, fontName || null);

        if (useAsync) {
            const jobId = await jobService.createJob(userId, 'generate_pdf', {
                coverLetterHtml, companyName, companyAddress
            });

            res.status(202).json({ jobId, status: 'pending' });

            // Fire and forget
            (async () => {
                try {
                    await jobService.startJob(jobId);
                    const { filePath, fileName } = await generateRichPDF();
                    await downloads.claimDownload(userId, { employer: passEmployer }, req);
                    await recordLetter(userId, req, {
                        employer: passEmployer, tplId: 'standard', format: 'pdf', mode: '', fileName,
                        coverLetterHtml, companyName, companyAddress, brandColor,
                    });
                    const downloadUrl = `/api/download-cover-letter/${encodeURIComponent(fileName)}`;
                    await jobService.completeJob(jobId, { success: true, downloadUrl, fileName });
                } catch (err) {
                    await jobService.failJob(jobId, err.message).catch(console.error);
                }
            })();
        } else {
            const { filePath, fileName } = await generateRichPDF();
            // Charged only now — the file exists on the line above.
            await downloads.claimDownload(userId, { employer: passEmployer }, req);
            await recordLetter(userId, req, {
                employer: passEmployer, tplId: 'standard', format: 'pdf', mode: '', fileName,
                coverLetterHtml, companyName, companyAddress, brandColor,
            });
            const downloadUrl = `/api/download-cover-letter/${encodeURIComponent(fileName)}`;
            res.json({ success: true, downloadUrl, fileName });
        }

    } catch (error) {
        console.error('Error generating PDF:', error);
        res.status(500).json({ error: error.message || 'Failed to generate PDF' });
    }
};

// ══════════════════════════════════════════════════════════════════════════════
// COUNTRY-FORMAT COVER LETTER TEMPLATES (preview + credited download)
// ══════════════════════════════════════════════════════════════════════════════

// Sender block from the user record (+ a title from their saved resume if present).
async function buildCLSender(userId) {
    let u = {};
    try { u = await dbConfig.get('SELECT full_name, email, phone_number, city, country FROM users WHERE id = ?', [userId]) || {}; } catch {}
    let title = '';
    try {
        const r = await dbConfig.get('SELECT resume_data FROM user_resumes WHERE user_id = ?', [userId]);
        const rd = r && r.resume_data;
        title = (rd && ((rd.personal_info && rd.personal_info.title) || (rd.experience && rd.experience[0] && rd.experience[0].role))) || '';
    } catch {}
    const location = u.city && u.country ? `${u.city}, ${u.country}` : (u.city || u.country || '');
    return { name: u.full_name || '', email: u.email || '', phone: u.phone_number || '', location, title };
}

// ── A saved letter's own printed lines (the customization page, 2026-09-19) ──────────────────────────────────────────
// The owner: "whatever details are on the PDF should come in an editable page". A Home employer letter's payload may
// carry, beside its body, the lines every design prints around it:
//   sender      { name, title, email, phone, location } — each key laid over the profile (buildCLSender) for THIS letter
//   salutation  the greeting over the design's own ("Dear Hiring Manager," / "Dear Sir or Madam,")
//   closing     the sign-off word over the design's own (Sincerely, / Best regards, / Respectfully, …)
// PUT /employer-docs/:id validates and stores them (employerDocsRoutes payloadProblem / normaliseLetterFields); every
// render of a SAVED letter — the Home cards, the gallery pages, the PDF, the Word file, a re-download — reads them
// through the three helpers below and nothing else, so the card is the file. A letter without them renders exactly as
// before (the classic lanes never pass them at all).
const LETTER_SENDER_KEYS = ['name', 'title', 'email', 'phone', 'location'];
/** One printed line: control characters and line breaks become spaces, runs collapse, cut at `max`. '' for a non-string. */
function letterLineOf(v, max = 200) {
    if (typeof v !== 'string') return '';
    return v.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}
/** The overrides a payload's `sender` really holds: string keys we print, each one line. {} for anything else. */
function letterSenderOverrideOf(v) {
    const out = {};
    if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
    for (const k of LETTER_SENDER_KEYS) if (typeof v[k] === 'string') out[k] = letterLineOf(v[k]);
    return out;
}
/**
 * mergeLetterSender(profile, override) → the sender block a letter PRINTS. Pure. A key the override holds (a string)
 * wins — '' means "print nothing" — except the name, which falls back to the profile when blank (a letter is always
 * signed). ⚠️ The profile's key ORDER is kept (the Home card cache hashes JSON.stringify of this object): a letter with
 * no override hashes exactly as it did before overrides existed, so no stored card is thrown away by this change.
 */
function mergeLetterSender(profile, override) {
    const out = { ...(profile && typeof profile === 'object' ? profile : {}) };
    const o = letterSenderOverrideOf(override);
    for (const k of LETTER_SENDER_KEYS) {
        if (!(k in o)) continue;
        if (k === 'name' && !o[k]) continue;
        out[k] = o[k];
    }
    return out;
}
/** senderForLetter(userId, payload) → buildCLSender(userId) with the letter's own sender laid over it. */
async function senderForLetter(userId, payload) {
    return mergeLetterSender(await buildCLSender(userId), payload && payload.sender);
}
/** A saved letter's greeting / closing, only when it set one: {} or { salutation?, closing? } — spread into render data. */
function letterLinesOf(payload) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const out = {};
    const salutation = letterLineOf(p.salutation);
    const closing = letterLineOf(p.closing);
    if (salutation) out.salutation = salutation;
    if (closing) out.closing = closing;
    return out;
}
/**
 * The Original (Branded) design's PDFKit generator reads the users ROW, not a sender block: a copy of the row with the
 * letter's name / email / phone laid over it, plus the title and location it prints (designation / location) and the
 * greeting / closing — only the keys the letter overrides, so an untouched letter hands the generator the row itself.
 */
function richLetterArgsOf(user, payload) {
    const o = letterSenderOverrideOf(payload && payload.sender);
    const u = { ...(user || {}) };
    if (o.name) u.full_name = o.name;
    if ('email' in o) u.email = o.email;
    if ('phone' in o) u.phone_number = o.phone;
    const opts = { ...letterLinesOf(payload) };
    if ('title' in o) opts.designation = o.title;
    if ('location' in o) opts.location = o.location;
    return { user: u, opts };
}

// Profile photo → compact JPEG data URI (flatten transparency to white).
async function loadCLPhotoDataUri(userId) {
    try {
        const u = await dbConfig.get('SELECT photo_path FROM users WHERE id = ?', [userId]);
        if (!u || !u.photo_path) return null;
        const p = path.join(__dirname, '../../', u.photo_path);
        await fs.access(p);
        const sharp = require('sharp');
        const out = await sharp(p).rotate().flatten({ background: '#ffffff' }).resize(300, 300, { fit: 'cover', position: 'attention' }).jpeg({ quality: 84 }).toBuffer();
        return `data:image/jpeg;base64,${out.toString('base64')}`;
    } catch { return null; }
}

// Look up the employer's brand colour for the Generic/branded letter.
async function lookupBrandColor(companyName, websiteUrl) {
    try {
        let url = websiteUrl;
        if (url && !url.startsWith('http')) url = 'https://' + url;
        if (url) {
            const c = await dbConfig.get('SELECT brand_color FROM employer_brand_profiles WHERE website_url = ?', [url]);
            if (c && c.brand_color) return c.brand_color;
        }
        if (companyName) {
            const fw = companyName.split(/\s+/)[0];
            const byName = await dbConfig.get(
                `SELECT ebp.brand_color FROM employer_brand_profiles ebp
                 JOIN employer_profiles ep ON ep.website_url = ebp.website_url
                 WHERE ep.employer_name ILIKE ? LIMIT 1`, [`%${fw}%`]);
            if (byName && byName.brand_color) return byName.brand_color;
        }
    } catch {}
    return null;
}

// ── The employer's brand, as a letter renders it ─────────────────────────────────────────────────
// A Home employer letter (employerLetterController) is written FOR one employer, and since 2026-09-15 it
// LOOKS like it too: every letter design's accent is recoloured to the employer's own colour and, when
// the employer's font is a Google font, set in that font (coverLetterRenderer / coverLetterTemplates
// opts.brandColor + opts.brandFont, docxBuilder opts.brand). The brand comes from employerResearch
// (brandExtract's deterministic read of the website first, the researcher's guess second) and is STORED
// on the document as design.brand so every render of that letter — the Home cards, the picker's cards,
// the PDF, the Word file — draws the same thing without asking the research again.
// ⚠️ ONE ANSWER FOR ONE LETTER. The thumbnail must be the file they would download, so the cards and the
// docId downloads read the brand through letterBrandOf and nothing else.
const BRAND_HEX_RE = /^#[0-9a-f]{6}$/i;
const brandHexOf = (v) => (typeof v === 'string' && BRAND_HEX_RE.test(v.trim()) ? v.trim().toLowerCase() : null);
/**
 * A font as the renderer will LOAD it (2026-09-15): a face Google does not host becomes its static-table alternative
 * (employerResearch.effectiveFont — "DB Neo Screen Sans Regular" → Barlow), reduced to { family, google }. A letter
 * whose design.brand stored the raw face at build time (google:false) is read straight off the row, never through
 * brandOf, so the table is applied here — the one place every stored letter font passes. Deterministic; a face the
 * table does not know, or a research module without effectiveFont, leaves the font as stored.
 */
function letterFontAsLoaded(font) {
    try {
        const er = require('../services/employerResearch');
        const eff = typeof er.effectiveFont === 'function' ? er.effectiveFont(font) : null;
        if (eff && typeof eff.family === 'string' && eff.family.trim()) return { family: eff.family.replace(/\s+/g, ' ').trim().slice(0, 80), google: eff.google === true };
    } catch { /* the face as stored */ }
    return font;
}
/** { family, google } from any font spelling, as loaded (letterFontAsLoaded): the Brand's { family, google }, or a bare family name (not google unless the table knows it). */
function brandFontOf(v) {
    if (!v) return null;
    if (typeof v === 'string') { const f = v.replace(/\s+/g, ' ').trim().slice(0, 80); return f ? letterFontAsLoaded({ family: f, google: false }) : null; }
    if (typeof v !== 'object') return null;
    const f = typeof v.family === 'string' ? v.family.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
    return f ? letterFontAsLoaded({ family: f, google: v.google === true }) : null;
}
/** A { accent, font } pair, or null when it says nothing — never an object with two nulls. */
function brandPairOf(accent, font) {
    const a = brandHexOf(accent);
    const f = brandFontOf(font);
    return a || f ? { accent: a, font: f } : null;
}

/**
 * researchBrandOf(research) → { accent: '#hex'|null, font: { family, google }|null } | null
 * The effective brand of a research result: employerResearch.brandOf when the module exports it (contract 2:
 * brand.primary over the researcher's brandColor, brand.font over its fontName), else the same precedence
 * computed here — so a research module from before the brand slice, or a cached row without `brand`, still
 * yields the researcher's colour and font. Never throws; null when nothing is known.
 */
function researchBrandOf(research) {
    if (!research || typeof research !== 'object') return null;
    try {
        const mod = require('../services/employerResearch');
        if (typeof mod.brandOf === 'function') {
            const b = mod.brandOf(research);
            const pair = b && typeof b === 'object' ? brandPairOf(b.accent, b.font) : null;
            if (pair) return pair;
        }
    } catch (e) { console.warn('[coverLetter] employerResearch.brandOf unavailable:', e.message); }
    const b = research.brand && typeof research.brand === 'object' ? research.brand : null;
    return brandPairOf(
        (b && b.primary) || research.brandColor,
        (b && b.font) || research.fontName,
    );
}

/**
 * letterBrandOf(doc) → the brand a saved letter renders with, or null.
 * The stored design.brand first (what the build decided — designFit.normaliseDesign drops keys it does not
 * know, so it is read off the RAW stored design, never a repaired copy); else the stored research, for a
 * letter saved before brands were stored on the design; else the payload's own brandColor / fontName
 * (the researcher's values the build copied there). Same precedence on every render of that letter.
 */
function letterBrandOf(doc) {
    if (!doc || typeof doc !== 'object') return null;
    let design = doc.design;
    if (typeof design === 'string') { try { design = JSON.parse(design); } catch { design = null; } }
    if (design && typeof design === 'object' && design.brand && typeof design.brand === 'object') {
        const pair = brandPairOf(design.brand.accent, design.brand.font);
        if (pair) return pair;
    }
    let research = doc.research;
    if (typeof research === 'string') { try { research = JSON.parse(research); } catch { research = null; } }
    const fromResearch = researchBrandOf(research);
    if (fromResearch) return fromResearch;
    const p = doc.payload && typeof doc.payload === 'object' ? doc.payload : {};
    return brandPairOf(p.brandColor, p.fontName);
}

/**
 * withSharedLetterBrand(doc) → the same doc, with the shared employer row's brand laid over its research
 * when the letter has NO brand of its own (2026-09-15). A build whose website read missed its deadline
 * stored design.brand = null over a research snapshot without a brand, and that letter stayed unbranded
 * for good — even after patchBrand had written the employer's colour and font to employer_research_cache
 * for everyone. When letterBrandOf answers null (no design.brand, nothing on the research, nothing in the
 * payload) and the snapshot names its domain, employerResearch.cachedBrandFor reads the row — ONE
 * read-only SELECT: never the researcher, never the website, never a write, so a render can bill nobody —
 * and its brand becomes research.brand, exactly where researchBrandOf → brandOf reads a brand the build
 * had. Every later letterBrandOf on this object (the cards' hash, the PDF, the Word file) sees it; the row
 * is never written back. Only a letter WITH a research snapshot (the one with a domain of record). Never
 * throws; any failure leaves the letter as it was. The resume lane's withSharedBrand is the same rule.
 */
async function withSharedLetterBrand(doc) {
    try {
        if (!doc || typeof doc !== 'object' || letterBrandOf(doc)) return doc;
        let research = doc.research;
        if (typeof research === 'string') { try { research = JSON.parse(research); } catch { research = null; } }
        research = research && typeof research === 'object' && !Array.isArray(research) ? research : null;
        const domain = research && typeof research.domain === 'string' ? research.domain.trim() : '';
        if (!domain) return doc;
        const mod = require('../services/employerResearch');
        if (typeof mod.cachedBrandFor !== 'function') return doc;
        const brand = await mod.cachedBrandFor(domain);
        if (!brand || !researchBrandOf({ ...research, brand })) return doc;
        doc.research = { ...research, brand };
    } catch (e) { console.warn('[coverLetter] shared brand unreadable — the letter renders unbranded:', e.message); }
    return doc;
}

// POST /api/cover-letter/preview-templates  — free previews; FORMATTING ONLY (no AI).
// All regions render the same content in their visual template; Generic = branded original.
async function previewCoverLetterTemplates(req, res) {
    const userId = req.user.id;
    const { region, coverLetterHtml, companyName, companyAddress, brandColor, websiteUrl } = req.body || {};
    try {
        if (!coverLetterHtml || !String(coverLetterHtml).trim()) {
            return res.status(400).json({ error: 'No cover letter content to preview. Generate a cover letter first.' });
        }
        const rgn = region || 'generic';
        const sender = await buildCLSender(userId);

        // The Generic/branded letter needs the photo + brand colour; other templates are plain.
        let renderOpts = {};
        if (rgn === 'generic') {
            renderOpts = { photo: await loadCLPhotoDataUri(userId), brandColor: brandColor || await lookupBrandColor(companyName, websiteUrl) };
        }

        const data = { sender, company: { name: companyName || '', address: companyAddress || '' }, bodyHtml: coverLetterHtml };
        const tpls = clTemplates.templatesForRegion(rgn);
        const previews = await clRenderer.renderPreviews(data, renderOpts, tpls);
        return res.json({ success: true, region: rgn, previews });
    } catch (e) {
        console.error('[coverLetter] previewCoverLetterTemplates error:', e.message);
        return res.status(500).json({ error: 'Failed to render cover-letter previews. Please try again.' });
    }
}

// POST /api/cover-letter/generate-template-pdf  — PDF only (no rewriting), charge credits.
// Generic = the byte-exact original letter (original PDFKit generator); others = HTML templates.
// Downloads (PDF + Word) are paid-plan features, matching the resume rule (2026-08-26):
// previews stay free, the FILE needs an active subscription. Replaces the per-download credit.
// ⚠️ A pass bought for an employer covers their LETTER as well as their resume — one payment, one
// company, everything for it. That is why the employer travels in here rather than the gate asking
// only "is this a subscriber".
async function requirePaidForDownload(userId, res, employer, req) {
    const gate = await downloads.canDownload(userId, { employer: employer || null }, req);
    if (!gate.allowed) {
        res.status(403).json({
            error: gate.message || 'Previewing every design is free — downloading the file is part of the paid plans.',
            reason: gate.reason || 'paid_required',
        });
        return false;
    }
    return true;
}

/**
 * Remember a downloaded letter so Home can offer it again.
 *
 * ⚠️ THE LETTER TEXT IS COPIED INTO THE ROW, not referenced. A cover letter can be regenerated or
 * its job deleted afterwards; re-rendering from live data would then hand back a different document
 * than the one they paid for.
 */
function recordLetter(userId, req, { employer, tplId, format, mode, fileName, coverLetterHtml, companyName, companyAddress, brandColor, docId }) {
    const tpl = (clTemplates.TEMPLATES || []).find((t) => t.id === tplId);
    return history.record(userId, {
        kind: 'cover_letter', employer, templateId: tplId || '', templateName: (tpl && tpl.name) || String(tplId || ''),
        format, mode: mode || '', fileName,
        // docId (a Home employer letter) rides along so "get it again" re-renders that saved letter; the
        // frozen text stays too, exactly as for every other letter.
        payload: { template: tplId || '', mode: mode || '', coverLetterHtml, companyName, companyAddress, brandColor, ...(docId ? { docId } : {}) },
    }, req).catch(() => {});
}

/**
 * The saved Home employer letter a download names by `docId`.
 *   no docId in the body     → null   (the classic lane: the letter's html travels in the body)
 *   docId, this user's letter → the doc (employerDocs shape: payload, employer_name, design, …)
 *   docId, anything else      → LETTER_DOC_GONE (not theirs, pruned, another kind, or empty)
 *
 * ⚠️ OWNER + KIND + ENVIRONMENT ARE SCOPED IN THE SQL (employerDocs.getById). The id comes from the
 * client; a letter fetched by id and checked afterwards is one forgotten `if` from another user's letter.
 * ⚠️ THE BODY'S HTML IS IGNORED WHEN docId IS SENT. What is rendered, billed and recorded is the saved
 * letter itself — a client cannot pay for one employer's letter and download different text under it.
 */
const LETTER_DOC_GONE = Symbol('letter_doc_gone');
async function employerLetterDocFor(userId, req) {
    const raw = req.body && req.body.docId;
    if (raw == null || raw === '' || raw === false) return null;
    try {
        const doc = await require('../services/employerDocs').getById(userId, raw, req, { kind: 'cover_letter' });
        const html = doc && doc.payload && doc.payload.coverLetterHtml;
        // A brand-less letter meets the shared row's brand here (withSharedLetterBrand), before savedLetterInput reads it.
        return typeof html === 'string' && html.trim() ? withSharedLetterBrand(doc) : LETTER_DOC_GONE;
    } catch (e) {
        console.warn('[coverLetter] saved letter lookup failed:', e.message);
        return LETTER_DOC_GONE;
    }
}

/**
 * What to render from a saved letter. `mode` is the caller's when it sent one, else the design's
 * (the resume doc lane's rule), else the renderer's own default.
 * brandColor / brandFont are the letter's brand (letterBrandOf — the stored design.brand, then the research,
 * then the payload's own colour): the same pair the employer-cards thumbnails were rendered with, so the
 * file matches the card. `brand` is the pair itself, for the Word builder.
 * The letter's own lines are read at the call sites, from the doc only (senderForLetter / letterLinesOf /
 * richLetterArgsOf): the classic lane destructures this same shape from the client's BODY, which must not be able to
 * name a greeting or a sender for a letter it merely sent.
 */
function savedLetterInput(doc, body) {
    const p = doc.payload || {};
    const asked = body && typeof body.mode === 'string' ? body.mode.trim() : '';
    const designMode = doc.design && (doc.design.mode === 'a4' || doc.design.mode === 'onepage') ? doc.design.mode : '';
    const brand = letterBrandOf(doc);
    return {
        mode: asked || designMode || undefined,
        coverLetterHtml: p.coverLetterHtml,
        companyName: p.companyName || doc.employer_name || '',
        companyAddress: p.companyAddress || '',
        brandColor: (brand && brand.accent) || null,
        brandFont: (brand && brand.font) || null,
        brand,
        websiteUrl: undefined,
    };
}

const LETTER_GONE_BODY = {
    error: 'We no longer have that cover letter. Open the employer on Home and write it again.',
    reason: 'payload_gone',
};

async function generateCoverLetterTemplatePdf(req, res) {
    const userId = req.user.id;
    // A Home employer letter names itself by docId: render THAT saved letter, bill ITS employer.
    const doc = await employerLetterDocFor(userId, req);
    if (doc === LETTER_DOC_GONE) return res.status(410).json(LETTER_GONE_BODY);
    const { template } = req.body || {};
    const { mode, coverLetterHtml, companyName, companyAddress, brandColor, brandFont, websiteUrl } = doc ? savedLetterInput(doc, req.body) : (req.body || {});
    // The employer a PASS attaches to is not necessarily the name printed on the letter. The
    // resume screen knows the company as the Home target's `target.company`; this screen knows it
    // as the AI's `employer_name` (or the recipient's website when the AI found no name at all).
    // Send both spellings and let downloads.resolveEmployer pick the one already paid for, so a
    // pass bought via the resume covers this letter instead of demanding a second payment for the
    // same company.
    // ⚠️ A saved letter's employer is its stored employer_name — the key its generation was billed and
    // cached under — never a spelling the client sends (canDownload is alias-aware on its own).
    const passEmployer = doc ? (doc.employer_name || null) : await downloads.resolveEmployer(
        userId, [(req.body || {}).employer, companyName], req,
    ).catch(() => companyName || null);
    try {
        const CL_DOWNLOAD_CREDIT_COST = await getEventCost('cover_letter_download');   // admin-configurable
        if (!coverLetterHtml || !String(coverLetterHtml).trim()) {
            return res.status(400).json({ error: 'No cover letter content. Generate a cover letter first.' });
        }
        if (!(await requirePaidForDownload(userId, res, passEmployer, req))) return;
        const tplId = clTemplates.TEMPLATE_IDS.includes(template) ? template : clTemplates.TEMPLATE_IDS[0];
        const tplMeta = clTemplates.TEMPLATES.find(t => t.id === tplId);

        let fileName;
        if (tplMeta && tplMeta.generic) {
            // Exact original branded letter — produced by the original PDFKit generator.
            const user  = await dbConfig.get('SELECT * FROM users WHERE id = ?', [userId]);
            const brand = brandColor || await lookupBrandColor(companyName, websiteUrl);
            // A saved letter's Google font is set by the PDFKit generator too (resolveFontPaths downloads it, and
            // falls back to Lato on its own); a font that is not on Google Fonts stays null, as before.
            const richFont = doc && brandFont && brandFont.google ? brandFont.family : null;
            // A saved letter's own sender / greeting / closing (richLetterArgsOf); the classic lane calls it as it always did.
            const rich = doc ? richLetterArgsOf(user, doc.payload) : null;
            const result = rich
                ? await generateRichCoverLetterPDF(rich.user, coverLetterHtml, companyName || '', companyAddress || '', brand, richFont, rich.opts)
                : await generateRichCoverLetterPDF(user, coverLetterHtml, companyName || '', companyAddress || '', brand, richFont);
            fileName = result.fileName;
        } else {
            // A saved letter prints its own sender block, greeting and closing (the same data its Home cards rendered).
            const sender = doc ? await senderForLetter(userId, doc.payload) : await buildCLSender(userId);
            const data = { sender, company: { name: companyName || '', address: companyAddress || '' }, bodyHtml: coverLetterHtml, ...(doc ? letterLinesOf(doc.payload) : {}) };
            // Doc mode renders the saved letter in its employer's brand (the same opts the cards used); the
            // classic lane's body carries no brand and renders exactly as it always has.
            const pdf = await clRenderer.renderPdf(tplId, data, doc ? { mode, brandColor, brandFont } : { mode });
            const safeCo = (companyName || 'Company').replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').slice(0, 40);
            fileName = `Cover_Letter_${safeCo}_${Date.now()}.pdf`;
            const tempDir = path.join(__dirname, '../../temp');
            await fs.mkdir(tempDir, { recursive: true });
            await fs.writeFile(path.join(tempDir, fileName), pdf);
        }

        // Charged only now — the file exists on this line.
        await downloads.claimDownload(userId, { employer: passEmployer }, req);
        await recordLetter(userId, req, {
            employer: passEmployer, tplId, format: 'pdf', mode, fileName,
            coverLetterHtml, companyName, companyAddress, brandColor, docId: doc ? doc.id : undefined,
        });
        return res.json({ success: true, downloadUrl: `/api/download-cover-letter/${encodeURIComponent(fileName)}`, template: tplId });
    } catch (e) {
        console.error('[coverLetter] generateCoverLetterTemplatePdf error:', e.message);
        return res.status(500).json({ error: 'Failed to generate cover letter PDF. Please try again.' });
    }
}

// POST /api/cover-letter/generate-template-docx — Word (.docx) export of a cover
// letter. Reuses the SAME template HTML as the PDF path (renderCoverLetterHtml,
// which falls back to a clean letter for the generic template), then converts via
// html-to-docx. Additive — the PDF path is untouched. Same credit cost.
async function generateCoverLetterTemplateDocx(req, res) {
    const userId = req.user.id;
    // A Home employer letter names itself by docId: render THAT saved letter, bill ITS employer.
    const doc = await employerLetterDocFor(userId, req);
    if (doc === LETTER_DOC_GONE) return res.status(410).json(LETTER_GONE_BODY);
    const { template } = req.body || {};
    const { mode, coverLetterHtml, companyName, companyAddress, brand } = doc ? savedLetterInput(doc, req.body) : (req.body || {});
    // The employer a PASS attaches to is not necessarily the name printed on the letter. The
    // resume screen knows the company as the Home target's `target.company`; this screen knows it
    // as the AI's `employer_name` (or the recipient's website when the AI found no name at all).
    // Send both spellings and let downloads.resolveEmployer pick the one already paid for, so a
    // pass bought via the resume covers this letter instead of demanding a second payment for the
    // same company.
    // ⚠️ A saved letter's employer is its stored employer_name (see generateCoverLetterTemplatePdf).
    const passEmployer = doc ? (doc.employer_name || null) : await downloads.resolveEmployer(
        userId, [(req.body || {}).employer, companyName], req,
    ).catch(() => companyName || null);
    try {
        const CL_DOWNLOAD_CREDIT_COST = await getEventCost('cover_letter_download');   // admin-configurable
        if (!coverLetterHtml || !String(coverLetterHtml).trim()) {
            return res.status(400).json({ error: 'No cover letter content. Generate a cover letter first.' });
        }
        if (!(await requirePaidForDownload(userId, res, passEmployer, req))) return;
        const tplId = clTemplates.TEMPLATE_IDS.includes(template) ? template : clTemplates.TEMPLATE_IDS[0];
        // A saved letter prints its own sender block, greeting and closing — in Word exactly as in its PDF.
        const sender = doc ? await senderForLetter(userId, doc.payload) : await buildCLSender(userId);
        const data = { sender, company: { name: companyName || '', address: companyAddress || '' }, bodyHtml: coverLetterHtml, ...(doc ? letterLinesOf(doc.payload) : {}) };
        const photo = await loadCLPhotoDataUri(userId).catch(() => null);

        const { buildCoverLetterDocx } = require('../utils/docxBuilder');
        // Doc mode: the employer's brand ({ accent, font }) for the layout accent and the document font —
        // the same pair the PDF and the cards render with. The classic lane sends none, as before.
        const docxBuffer = await buildCoverLetterDocx(data, doc && brand ? { template: tplId, photo, brand } : { template: tplId, photo });

        const safeCo = (companyName || 'Company').replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').slice(0, 40);
        const fileName = `Cover_Letter_${safeCo}_${Date.now()}.docx`;
        const tempDir = path.join(__dirname, '../../temp');
        await fs.mkdir(tempDir, { recursive: true });
        await fs.writeFile(path.join(tempDir, fileName), docxBuffer);

        // Charged only now — the file exists on this line.
        await downloads.claimDownload(userId, { employer: passEmployer }, req);
        await recordLetter(userId, req, {
            employer: passEmployer, tplId, format: 'docx', mode, fileName,
            coverLetterHtml, companyName, companyAddress,
            brandColor: doc ? savedLetterInput(doc, req.body).brandColor : null, docId: doc ? doc.id : undefined,
        });
        return res.json({ success: true, downloadUrl: `/api/download-cover-letter-docx/${encodeURIComponent(fileName)}`, template: tplId });
    } catch (e) {
        console.error('[coverLetter] generateCoverLetterTemplateDocx error:', e.message);
        return res.status(500).json({ error: 'Failed to generate cover letter Word document. Please try again.' });
    }
}

// Point 6: enrich the cover-letter context with the user's Resume-Builder resume (if any),
// so letters have richer, more specific detail than the uploaded resume alone. Additive —
// returns the same metadata object untouched when no builder resume exists.
async function mergeBuilderResume(userId, resumeMetadata) {
    try {
        const row = await dbConfig.get('SELECT resume_data FROM user_resumes WHERE user_id = ?', [userId]);
        if (row && row.resume_data) {
            const rd = typeof row.resume_data === 'string' ? JSON.parse(row.resume_data) : row.resume_data;
            if (rd && typeof rd === 'object') {
                console.log(`[coverLetter] enriching context with Builder resume for user ${userId}`);
                return { ...resumeMetadata, builder_resume: rd };
            }
        }
    } catch (e) {
        console.warn('[coverLetter] mergeBuilderResume failed:', e.message);
    }
    return resumeMetadata;
}

// Reusable: build a cover-letter PDF for a given REGION and return { filePath, fileName }.
// Used by the email-send flow (point 3). Generic → the exact original branded letter;
// any other region → the recommended visual template for that region. No credits here.
async function buildCoverLetterPdfForRegion(userId, { region, coverLetterHtml, companyName, companyAddress, brandColor, websiteUrl, mode } = {}) {
    const rgn = region || 'generic';
    const tpls = clTemplates.templatesForRegion(rgn);
    const tplId = (tpls && tpls[0] && tpls[0].id) || clTemplates.TEMPLATE_IDS[0];
    const tplMeta = clTemplates.TEMPLATES.find(t => t.id === tplId);
    const tempDir = path.join(__dirname, '../../temp');
    await fs.mkdir(tempDir, { recursive: true });

    if (tplMeta && tplMeta.generic) {
        // Exact original branded letter (original PDFKit generator) — byte-for-byte the old file.
        const user  = await dbConfig.get('SELECT * FROM users WHERE id = ?', [userId]);
        const brand = brandColor || await lookupBrandColor(companyName, websiteUrl);
        const result = await generateRichCoverLetterPDF(user, coverLetterHtml, companyName || '', companyAddress || '', brand, null);
        return { filePath: result.filePath, fileName: result.fileName, template: tplId, generic: true };
    }

    const sender = await buildCLSender(userId);
    const data = { sender, company: { name: companyName || '', address: companyAddress || '' }, bodyHtml: coverLetterHtml };
    const pdf = await clRenderer.renderPdf(tplId, data, { mode: mode || 'a4' });
    const safeCo = (companyName || 'Company').replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').slice(0, 40);
    const fileName = `Cover_Letter_${safeCo}_${Date.now()}.pdf`;
    const filePath = path.join(tempDir, fileName);
    await fs.writeFile(filePath, pdf);
    return { filePath, fileName, template: tplId, generic: false };
}

module.exports = {
    generateCoverLetters,
    generateCoverLetterDetails,
    generateCoverLetterPdf,
    executeGenerationWork,
    previewCoverLetterTemplates,
    generateCoverLetterTemplatePdf,
    generateCoverLetterTemplateDocx,
    buildCoverLetterPdfForRegion,
    // Exported for reuse ONLY (behaviour unchanged): employerLetterController writes Home's per-employer
    // letters with the same body formatter and renders their thumbnails from the same sender block,
    // photo and brand colour the downloads above use — so a card is the file they would download.
    formatCoverLetterWithHTML,
    buildCLSender,
    // A saved letter's own printed lines (the customization page): its sender over the profile, its greeting / closing,
    // and the PDFKit generator's arguments for them — employerLetterController's cards read them through these too.
    senderForLetter,
    mergeLetterSender,
    letterLinesOf,
    richLetterArgsOf,
    loadCLPhotoDataUri,
    lookupBrandColor,
    // The one reading of an employer letter's brand (see letterBrandOf): the build stores what
    // researchBrandOf says on design.brand, and every render of that letter reads it back through
    // letterBrandOf — cards and downloads cannot disagree.
    researchBrandOf,
    letterBrandOf,
    // The row's brand for a letter that has none (read-only) — employerLetterController's cards load through it too.
    withSharedLetterBrand,
    // The shared per-(user, kind) usage lock, for a lane that has none of its own (aiHubController's Job Hub
    // letter) — so it serialises against every other lane's key instead of inventing a second spelling.
    withUsageLock,
    // ⚠️ THE ONE LETTER WRITER (2026-09-18, the owner's decision — see the section above writeLegacyLetter). Home's
    // employer letter (employerLetterController) is written by exactly this lane's generation: its résumé metadata,
    // research subject, posting, v2 prompt + Google Search grounding + config + chain + parsing, and the mapping of the
    // answer into a letter. Called from there, never copied, so the two screens cannot drift. LEGACY_LETTER_MODEL is
    // what Home records as a stored letter's writer if an answer ever arrives without a model id.
    writeLegacyLetter,
    letterResumeMetadataFor,
    mergeBuilderResume,
    letterResearchSubjectOf,
    letterListingOf,
    letterDetailsOf,
    ADDRESS_NOT_AVAILABLE,
    LEGACY_LETTER_MODEL,
    // exposed for tests / diagnostics only: the legacy letter's AI call and its parsing
    _internals: { LETTER_FALLBACKS, letterFallbacks, writeLegacyLetter, parseLegacyLetterJson, legacyAiRefusal, LEGACY_LETTER_MODEL, legacyLetterConfig, LEGACY_LETTER_BUDGET_MS,
        // the research bound (letterTiming.researchBudgetMs is the knob a suite shrinks) and "one tap, one job"'s claims
        LETTER_RESEARCH_BUDGET_MS, letterTiming, boundedLetterResearch, letterClaims, LETTER_BUILD_TTL_MS, jobHubAddressOf },
};
