// The letter's Send page (2026-09-19) — mounted at /api/employer-docs BESIDE employerDocsRoutes (server.js).
// See controllers/letterSendController.js for what each route does and the money rule it keeps.
//
// ⚠️ A SEPARATE ROUTER ON PURPOSE. employerDocsRoutes' header promises "THIS FILE NEVER GENERATES AND NEVER CHARGES",
// and every route there keeps that promise. Sending attaches rendered PDFs, which is a DOWNLOAD — gated and claimed
// exactly like one — so it lives here, where that is the point, and the promise over there stays true.
// ⚠️ OLDER APP BUILDS NEVER CALL THESE. A new app talking to a server without them gets Express's HTML 404 (no
// JSON reason); the app reads that as "this server is older" and offers the Download instead (services/letterSend).
'use strict';

const express = require('express');
const multer = require('multer');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { asJob } = require('../middleware/asyncJob');
const c = require('../controllers/letterSendController');
const { MAX_DEVICE_FILE_BYTES } = require('../services/letterEmail');

/**
 * ⚠️ THE MESSAGE NEVER REACHES async_jobs. asJob stores req.body (every string ≤ 2000 chars kept) as the job's
 * `input` for its idempotency lookup — the recipients, the subject and the email body would sit in the database for
 * as long as the job row does. So they move to req.letterMail (the SAME request object the detached handler runs
 * with) and leave req.body before asJob ever sees it. clientBuildId stays: it is what dedupes a retried Send.
 */
function holdMailFields(req, _res, next) {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    // A classic letter (2026-09-20) rides here too: the letter's text is no more the job row's business than the message.
    req.letterMail = { to: b.to, subject: b.subject, body: b.body, classic: b.classic };
    delete b.to;
    delete b.subject;
    delete b.body;
    delete b.classic;
    next();
}

/**
 * THE CLASSIC LANE (2026-09-20): the same four handlers for a letter the preview holds WITHOUT a saved document (the Job
 * Hub's, the Review screen's, the old Home's — templates.tsx's classic picker), which carries the letter in its body as
 * `classic` (letterSendController.loadClassicLetter). Every request here is a POST, because the letter travels with it.
 * ⚠️ REGISTERED BEFORE the /:id routes: POST /classic/send would otherwise match /:id/send with id 'classic'.
 */
function classicLane(req, _res, next) {
    req.letterLane = 'classic';
    next();
}

/**
 * ⚠️ THE CLASSIC READS ARE COUNTED (review, 2026-09-20). /classic/email-draft and /classic/email-body run a letter the
 * CLIENT sent through the repair and the email draft on the one event loop, and neither had any limit (apiLimiter is not
 * on /api/employer-docs; the body's own hourly cap counts only the model calls, after the letter is read). The text
 * processing is linear now and the letter capped (letterSendController CLASSIC_HTML_MAX) — this bounds how often a user
 * can ask. A page opens with one draft and one note, and asks again on Reconnect or Rewrite: no person comes near it.
 * The classic SEND is not counted here: its own cap (reserveSend) takes the slot before the letter is read, and a 429
 * in front of asJob would answer a retried Send — which must JOIN its job — with a refusal the phone reads as final.
 */
const CLASSIC_READS_MAX = 60;
const CLASSIC_READS_WINDOW_MS = 10 * 60 * 1000;
const classicReads = new Map();   // userId → [timestamps]
function classicReadLimit(req, res, next) {
    const id = req.user && req.user.id;
    const now = Date.now();
    const kept = (classicReads.get(id) || []).filter((t) => now - t < CLASSIC_READS_WINDOW_MS);
    if (kept.length >= CLASSIC_READS_MAX) {
        classicReads.set(id, kept);
        return res.status(429).json({ success: false, reason: 'too_many', error: 'Too many requests for this letter. Please wait a few minutes and try again.' });
    }
    kept.push(now);
    classicReads.set(id, kept);
    if (classicReads.size > 5000) classicReads.delete(classicReads.keys().next().value);
    return next();
}

/** One file, in memory, capped — multer's own refusal becomes the page's reasons (too_big / bad_file). */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_DEVICE_FILE_BYTES, files: 1, fields: 4 } });
function oneFile(req, res, next) {
    upload.single('file')(req, res, (err) => {
        if (!err) return next();
        const tooBig = err && err.code === 'LIMIT_FILE_SIZE';
        return res.status(tooBig ? 413 : 400).json({
            success: false,
            reason: tooBig ? 'too_big' : 'bad_file',
            error: tooBig
                ? `That file is larger than ${Math.round(MAX_DEVICE_FILE_BYTES / (1024 * 1024))} MB.`
                : 'That file could not be read. Pick one PDF or Word file.',
        });
    });
}

router.post('/classic/email-draft', authenticateToken, classicLane, classicReadLimit, c.getEmailDraft);
router.post('/classic/email-body', authenticateToken, classicLane, classicReadLimit, c.draftEmailBody);
router.post('/classic/send-files', authenticateToken, classicLane, oneFile, c.uploadSendFile);
router.post('/classic/send', authenticateToken, classicLane, holdMailFields, asJob('letter_email')(c.sendLetterEmail));

router.get('/:id/email-draft', authenticateToken, c.getEmailDraft);
router.post('/:id/email-body', authenticateToken, c.draftEmailBody);
router.post('/:id/send-files', authenticateToken, oneFile, c.uploadSendFile);
router.post('/:id/send', authenticateToken, holdMailFields, asJob('letter_email')(c.sendLetterEmail));

module.exports = router;
// For the route tests only — not middleware on any other router.
module.exports.holdMailFields = holdMailFields;
module.exports.classicLane = classicLane;
module.exports.classicReadLimit = classicReadLimit;
module.exports._classicReads = classicReads;
module.exports.CLASSIC_READS_MAX = CLASSIC_READS_MAX;
