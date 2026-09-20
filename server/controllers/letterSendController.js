// The letter's Send page (2026-09-19) — email ONE saved employer cover letter from the user's own Gmail or Outlook.
// Routes: server/routes/letterSendRoutes.js, mounted beside employerDocsRoutes at /api/employer-docs.
//   GET  /:id/email-draft   what the page opens with: subject, a template body, known contacts, the résumé choices and
//                           the connected mailbox. Read-only: no AI, no render, no charge, no write.
//   POST /:id/email-body    a short AI-written body derived from the letter. FREE: never a credit, never a unit.
//   POST /:id/send-files    one PDF / Word file from the phone, held for 30 minutes for the send below.
//   POST /:id/send          the message itself (asJob 'letter_email' — minimise-safe, deduped per clientBuildId).
//   POST /classic/…         the same four for a CLASSIC letter — one the preview holds without a saved document (the Job
//                           Hub's, the Review screen's, the old Home's): the letter travels in the body as `classic`
//                           (see loadClassicLetter), and every rule below holds for it unchanged.
//
// THE OWNER'S ASK: "On the cover letter preview pdf page … show a button Send … a well designed GUI page like our
// customisation page to send email, where we can show auto generated subject, auto generated body for that employer,
// Attachments of that cover letter, attach the resume of the user if generated for that employer … otherwise the
// normal one … with our smart file upload control box … use the connected gmail or microsoft account to send the
// email … and it should allow user to add email id and send that".
//
// ⚠️ MONEY — THE DOWNLOAD RULE, EXACTLY. An attachment WE render (the letter PDF, a tailored or a Builder résumé) is a
// downloaded file with extra steps, so it is gated by downloads.canDownload for the employer the document was BUILT
// for (the letter: doc.employer_name — the Download's passEmployer; a tailored résumé: its own employer_name — the
// Download's billingEmployerOf), and claimed with downloads.claimDownload only AFTER the provider accepted the message.
// A refusal comes back BEFORE anything is rendered; a render or send failure charges nothing and says so. Files the
// user brings (their uploaded CV, a file from the phone) are their own bytes and are not gated. The subscription-only
// rule of /send-single-application is deliberately NOT copied: the owner asked for parity with this page's Download.
// ⚠️ NOTHING HERE GENERATES A DOCUMENT OR CONSUMES A RÉSUMÉ / LETTER UNIT. No chargeCredits, no claimGeneration, no
// quota consume — the email body is aiText with a template fallback (services/letterEmail.draftBody).
// ⚠️ NEVER LOGGED: tokens, the subject, the body, the addresses. A log line carries the provider, counts, byte sizes
// and the recipients' DOMAINS. The route moves to / subject / body off req.body before asJob stores the body in
// async_jobs.input (see letterSendRoutes.holdMailFields).
// ⚠️ OWNER + ENVIRONMENT ARE IN THE SQL. The letter and a tailored résumé are read through employerDocs.getById (user,
// store environment, kind) — ids come from the client. A résumé docId for another employer is refused, never sent.
'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const dbConfig = require('../../db-config');
const docs = require('../services/employerDocs');
const downloads = require('../services/downloads');
const history = require('../services/downloadHistory');
const tempFiles = require('../services/tempFiles');
const mail = require('../services/letterEmail');

const ROOT = path.join(__dirname, '../..');
const GONE = { success: false, reason: 'gone', error: 'This cover letter is no longer saved. Go back to Home to see your current one.' };
const NOTHING = 'Nothing was sent and nothing was charged.';

// The controllers are required at call time: coverLetterController requires emailController at load, and a suite
// swaps these modules through require.cache — a load-time binding would walk past its stubs.
const cl = () => require('./coverLetterController');
const rb = () => require('./resumeBuilderController');
const em = () => require('./emailController');

/**
 * A saved letter of this user's, in this store environment, with text to send — brand laid over; else null.
 * ⚠️ REPAIRED, like every other read of a stored letter (2026-09-19, the Airbus letter stored with the model's JSON in it —
 * server/utils/letterText.js): the email-body draft quotes this letter to the model, the attachment renders it, and the
 * history row a send freezes copies it. A copy; the row is not written. A clean letter is the same doc object.
 */
async function loadLetter(userId, id, req) {
    const doc = await docs.getById(userId, id, req, { kind: 'cover_letter' });
    const html = doc && doc.payload && doc.payload.coverLetterHtml;
    if (!doc || typeof html !== 'string' || !html.trim()) return null;
    const { withSharedLetterBrand } = cl();
    const branded = (typeof withSharedLetterBrand === 'function' ? await withSharedLetterBrand(doc) : doc) || doc;
    const payload = require('../utils/letterText').repairedLetterPayload(branded.payload);
    return payload === branded.payload ? branded : { ...branded, payload };
}

/**
 * THE CLASSIC LANE (2026-09-20). The owner put Send "on the cover letter preview pdf page where the download button is" —
 * and that page is ALSO opened without a docId: the Job Hub's, the Review screen's and the old Home's letters show the
 * same preview with the same Download (templates.tsx, the classic picker). Those letters are no row we can read by id, so
 * the page sends the letter itself — what that page's Download already sends ({ coverLetterHtml, companyName,
 * companyAddress, employer }) plus the posting when the opener knew it (jobUrl, position: the Job Hub). It becomes a
 * pseudo-document (`classic: true`, id null) so every step after this reads ONE shape.
 * ⚠️ THE MONEY RULE OF THAT DOWNLOAD. Its employer is resolved exactly as generateCoverLetterTemplatePdf's classic lane
 * resolves it — downloads.resolveEmployer over [employer, companyName], so a pass already bought under either spelling is
 * the one gated and claimed — and the letter PDF is rendered by that Download's own function (renderClassicLetterPdf).
 * ⚠️ WHITELISTED, CAPPED FIELDS ONLY. The payload carries the letter's text and the company lines, never a sender, a
 * greeting or a subject the client could name (senderForLetter reads a payload's sender fields). The text is read
 * REPAIRED like every stored letter (letterText.repairedLetterPayload: a strong-signal repair; a clean letter is the same
 * string), so a model's JSON never reaches a recruiter.
 * ⚠️ The letter rides on the request as req.body.classic — and on the send route it is moved to req.letterMail with the
 * message (letterSendRoutes.holdMailFields), so async_jobs.input never stores a letter either.
 */
/**
 * ⚠️ CAPPED AT A LETTER'S SIZE, not a page's (review, 2026-09-20). This text comes from the client and every request runs it
 * through the repair (letterText) and the email draft (letterEmail.letterPlainText) on the ONE event loop — 60,000
 * characters of '<' held the server for 60 s before those were made linear. The longest letter in production is 7,373
 * characters (user_employer_documents / download_history; job_cover_letters 3,867, review_cover_letters 3,861 —
 * measured 2026-09-20), so 20,000 refuses no real letter. Mirrored in MobileApp/services/letterSend.ts.
 */
const CLASSIC_HTML_MAX = 20000;
const isClassic = (req) => !!req && req.letterLane === 'classic';
const oneLine = (v, n) => (typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, n) : '');
function classicInputOf(req) {
    if (isObj(req.letterMail) && isObj(req.letterMail.classic)) return req.letterMail.classic;
    return isObj(req.body) && isObj(req.body.classic) ? req.body.classic : null;
}
async function loadClassicLetter(userId, req) {
    const c = classicInputOf(req);
    const html = c && typeof c.coverLetterHtml === 'string' ? c.coverLetterHtml : '';
    if (!html.trim() || html.length > CLASSIC_HTML_MAX) return null;
    const companyName = oneLine(c.companyName, 160);
    // An address keeps its line breaks (a letterhead prints them); only the other control characters go.
    const companyAddress = typeof c.companyAddress === 'string' ? c.companyAddress.replace(/[\x00-\x09\x0b-\x1f\x7f]+/g, ' ').trim().slice(0, 400) : '';
    const position = oneLine(c.position, 160);
    const rawUrl = oneLine(c.jobUrl, 2000);
    const jobUrl = /^https?:\/\/\S+$/i.test(rawUrl) ? rawUrl : '';
    const employer = await downloads.resolveEmployer(userId, [oneLine(c.employer, 160), companyName], req)
        .catch(() => companyName || null);
    const payload = require('../utils/letterText').repairedLetterPayload({ coverLetterHtml: html, companyName, companyAddress, position });
    return {
        id: null, classic: true, kind: 'cover_letter',
        employer_name: employer || companyName || null, employer_id: null,
        job_url: jobUrl, job_title: position, updated_at: null,
        payload,
    };
}
/** The letter this request is about: a saved Home letter by :id, or the classic letter it carries. null = none. */
function loadLetterFor(userId, req) {
    return isClassic(req) ? loadClassicLetter(userId, req) : loadLetter(userId, req.params.id, req);
}
const NO_LETTER = { success: false, reason: 'no_letter', error: `There is no cover letter to send. Open your letter again and tap Send. ${NOTHING}` };
/** No letter: a saved one is GONE (404 — deleted or not theirs); a classic request simply carried none (400). */
const missingLetter = (req, res) => (isClassic(req) ? res.status(400).json(NO_LETTER) : res.status(404).json(GONE));
/** A log's name for the letter — never its text. */
const letterLabel = (doc) => (doc && doc.classic ? 'classic letter' : `doc ${doc && doc.id}`);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOf = (v) => (typeof v === 'string' && UUID_RE.test(v.trim()) ? v.trim() : null);

/** The address the connected account sends as: the address it was LINKED with (security_audit_log), else users.email. */
async function accountAddressOf(user, provider) {
    if (!user || !provider) return null;
    try {
        const row = await dbConfig.get(
            `SELECT details->>'linked_email' AS email FROM security_audit_log
              WHERE user_id = $1 AND event_type = 'OAUTH_ACCOUNT_LINKED' AND details->>'provider' = $2
              ORDER BY created_at DESC LIMIT 1`, [user.id, provider]);
        if (row && mail.isEmail(row.email)) return row.email.trim();
    } catch { /* the profile address below */ }
    return mail.isEmail(user.email) ? String(user.email).trim() : null;
}

/**
 * { provider, ready, canSend, reconnect, address } — what the page's account card shows.
 * ⚠️ `canSend` IS A SEPARATE ANSWER FROM `ready` (2026-09-20, the owner's build-210 report). The card used to say
 * "Gmail · you@gmail.com ✓ Connected" for any row holding a token, so an account that never granted the send
 * permission looked identical to one that did — and the refusal could only arrive after the user had written the
 * message and typed the recruiter's address. A grant we recorded as lacking send answers false; an account connected
 * before Migration 050 has no recorded grant and answers true, exactly as it behaves today.
 */
async function accountOf(user) {
    const a = em().mailAccountOf(user);
    return {
        provider: a.provider || null,
        ready: !!a.ready,
        canSend: a.canSend !== false,
        reconnect: !!a.reconnect,
        address: a.provider ? await accountAddressOf(user, a.provider) : null,
    };
}

const RECRUITER_RE = /recruit|talent|hr\b|human resources|hiring|people|career/i;

/**
 * The contacts the app already knows for this letter's job / employer (job_contacts ⋈ jobs, valid addresses only).
 * prefill: the best ONE — a contact on this exact posting, or, for a letter written for the employer itself, the
 * employer's best contact (recruiting roles first). Everything else is a suggestion the user may tap (≤ 10).
 * ⚠️ Never more than one address pre-filled: a To line the user did not look at is a message to the wrong person.
 */
async function contactsFor(doc) {
    const jobUrl = typeof doc.job_url === 'string' ? doc.job_url : '';
    const empId = uuidOf(doc.employer_id);
    if (!jobUrl && !empId) return { prefill: [], suggestions: [] };
    let rows = [];
    try {
        rows = await dbConfig.query(
            `SELECT jc.name, jc.role, jc.email, j.job_url
               FROM job_contacts jc JOIN jobs j ON j.id = jc.job_id
              WHERE jc.email IS NOT NULL AND jc.email <> ''
                AND (($1 <> '' AND j.job_url = $1) OR ($2::uuid IS NOT NULL AND j.employer_id = $2::uuid))
              ORDER BY jc.updated_at DESC NULLS LAST, jc.created_at DESC
              LIMIT 60`, [jobUrl, empId]) || [];
    } catch (e) {
        console.warn('[letterSend] contacts unreadable:', e.message);
        rows = [];
    }
    const seen = new Set();
    const list = [];
    for (const r of Array.isArray(rows) ? rows : []) {
        const email = typeof r.email === 'string' ? r.email.trim() : '';
        if (!mail.isEmail(email) || seen.has(email.toLowerCase())) continue;
        seen.add(email.toLowerCase());
        list.push({
            email,
            name: typeof r.name === 'string' ? r.name.trim().slice(0, 80) : '',
            role: typeof r.role === 'string' ? r.role.trim().slice(0, 80) : '',
            exact: !!jobUrl && r.job_url === jobUrl,
        });
    }
    list.sort((a, b) => (Number(b.exact) - Number(a.exact)) || (Number(RECRUITER_RE.test(b.role)) - Number(RECRUITER_RE.test(a.role))));
    const first = list[0];
    const prefillable = first && (first.exact || !jobUrl);
    const strip = ({ exact, ...c }) => c;   // eslint-disable-line no-unused-vars
    return {
        prefill: prefillable ? [strip(first)] : [],
        suggestions: list.slice(prefillable ? 1 : 0, (prefillable ? 1 : 0) + 10).map(strip),
    };
}

/** A stored file past this is not read to find out what it is (the upload's own ceiling — services/resumeText). */
const SNIFF_MAX_BYTES = 10 * 1024 * 1024;

/**
 * The user's uploaded CV file (users.resume_path), in any format the upload stores, when it still exists; else null.
 * → { path, ext, size, mime, label } — `ext` is the kind ('pdf', 'docx', 'odt', …), named and typed from ONE table.
 * ⚠️ EVERY FORMAT THE UPLOAD ACCEPTS (2026-09-20). This used letterEmail.FILE_KINDS — pdf / doc / docx, the table for a
 * file picked on the PHONE for one send — but the wizard's upload also stores .odt, .rtf and .txt CVs (and a photographed
 * one): services/resumeText.FORMATS. A user whose only résumé was one of those saw no résumé on this page and nothing
 * said why. The kind comes from the stored path's extension, the rule every other send path follows (utils/resumeFile:
 * the upload names each file by its REAL kind). A path with no known extension — multer's bare name from before
 * 2026-09-19 (one in production) — is read and SNIFFED, never assumed to be a PDF: this page declares a type to a
 * recruiter's mail client.
 */
async function uploadedResumeOf(user) {
    const rel = user && typeof user.resume_path === 'string' ? user.resume_path.trim() : '';
    if (!rel) return null;
    const abs = path.resolve(ROOT, rel);
    if (!abs.startsWith(ROOT + path.sep)) return null;          // never a path outside the app
    try {
        const st = await fsp.stat(abs);
        if (!st.isFile() || !st.size) return null;
        const rt = require('../../services/resumeText');
        let kind = rt.kindOfPath(abs);
        if (!kind && st.size <= SNIFF_MAX_BYTES) {
            const s = rt.sniff(await fsp.readFile(abs));
            kind = s && s.ok ? s.kind : null;
        }
        const f = kind ? rt.FORMATS[kind] : null;
        return f ? { path: abs, ext: kind, size: st.size, mime: f.mime, label: f.label } : null;
    } catch { return null; }
}

/** This user's tailored résumé for the letter's employer: the letter's own posting first, then the employer itself. */
async function tailoredResumeFor(userId, doc, req) {
    const q = { employer: doc.employer_name, employerId: doc.employer_id || null, jobUrl: doc.job_url || '' };
    let r = await docs.currentFor(userId, 'resume', q, req);
    if (!r && q.jobUrl) r = await docs.currentFor(userId, 'resume', { ...q, jobUrl: '' }, req);
    return r && isObj(r.payload) && isObj(r.payload.personal_info) ? r : null;
}

async function hasBuilderResume(userId) {
    try {
        const row = await dbConfig.get('SELECT 1 AS ok FROM user_resumes WHERE user_id = $1 AND resume_data IS NOT NULL LIMIT 1', [userId]);
        return !!row;
    } catch { return false; }
}

/**
 * The résumé choices, in the order "tailored for this employer > your Builder résumé > your uploaded CV" (the owner:
 * "attach the resume of the user if generated for that employer then use that otherwise use the normal one").
 */
async function resumeOptionsFor(userId, doc, user, req) {
    const options = [];
    const tailored = await tailoredResumeFor(userId, doc, req).catch(() => null);
    if (tailored) {
        const d = rb().resumeDocDefaultsOf(tailored);
        options.push({
            id: 'tailored', docId: Number(tailored.id),
            label: `Tailored for ${tailored.employer_name || doc.employer_name || 'this employer'}`,
            detail: `${d.templateName || 'Your design'} · PDF`, template: d.template, mode: d.mode || null, gated: true,
        });
    }
    if (await hasBuilderResume(userId)) {
        options.push({ id: 'builder', label: 'Your résumé', detail: 'From your résumé builder · PDF', gated: true });
    }
    const up = await uploadedResumeOf(user);
    if (up) {
        options.push({ id: 'uploaded', label: 'Your uploaded CV', detail: `${up.label || up.ext.toUpperCase()} · ${Math.max(1, Math.round(up.size / 1024))} KB`, gated: false, bytes: up.size });
    }
    return { options, default: options.length ? options[0].id : null };
}

/* ── GET /:id/email-draft ─────────────────────────────────────────────────────────────────────────── */

async function getEmailDraft(req, res) {
    const userId = req.user.id;
    try {
        const doc = await loadLetterFor(userId, req);
        if (!doc) return missingLetter(req, res);
        const p = doc.payload || {};
        const user = await dbConfig.get('SELECT * FROM users WHERE id = $1', [userId]);
        if (!user) return missingLetter(req, res);
        const [sender, contacts, resume, account] = await Promise.all([
            cl().senderForLetter(userId, p).catch(() => ({ name: user.full_name || '', email: user.email || '' })),
            contactsFor(doc),
            resumeOptionsFor(userId, doc, user, req),
            accountOf(user),
        ]);
        // Both variants of the standard note (letterEmail.templateBody): the page swaps them as the résumé comes and
        // goes, so the message never says a résumé is attached when none is. `body` is the one for the default choice.
        const bodies = {
            withResume: mail.templateBody({ payload: p, employer: doc.employer_name, sender, withResume: true }),
            letterOnly: mail.templateBody({ payload: p, employer: doc.employer_name, sender, withResume: false }),
        };
        return res.json({
            success: true,
            letter: {
                // A classic letter has no row: no id, and `employer` is the Download's resolved one (the padlock's key).
                docId: doc.classic ? null : Number(doc.id),
                classic: !!doc.classic,
                employer: doc.employer_name || '',
                companyName: typeof p.companyName === 'string' ? p.companyName : '',
                position: typeof p.position === 'string' ? p.position : (doc.job_title || ''),
                jobUrl: doc.job_url || '',
                updatedAt: doc.updated_at ? new Date(doc.updated_at).toISOString() : null,
            },
            subject: mail.subjectFor(p, sender && sender.name),
            body: resume.options.length ? bodies.withResume : bodies.letterOnly,
            bodies,
            sender: { name: (sender && sender.name) || '', email: (sender && sender.email) || '' },
            recipients: contacts,
            resume,
            account,
            limits: {
                maxRecipients: mail.MAX_RECIPIENTS,
                maxFileBytes: mail.MAX_DEVICE_FILE_BYTES,
                maxTotalBytes: mail.MAX_TOTAL_BYTES,
                subjectMax: mail.SUBJECT_MAX,
                bodyMax: mail.BODY_MAX,
            },
        });
    } catch (e) {
        console.error('[letterSend] draft failed:', e.message);
        return res.status(500).json({ success: false, reason: 'failed', error: 'Could not open the send page. Please try again.' });
    }
}

/* ── POST /:id/email-body ─────────────────────────────────────────────────────────────────────────── */

/** At most this many AI drafts per user per hour; past it the page gets the template (never an error). */
const BODY_PER_HOUR = 30;
const bodyCalls = new Map();   // userId → [timestamps]
function bodyAllowed(userId, now = Date.now()) {
    const kept = (bodyCalls.get(userId) || []).filter((t) => now - t < 60 * 60 * 1000);
    if (kept.length >= BODY_PER_HOUR) { bodyCalls.set(userId, kept); return false; }
    kept.push(now);
    bodyCalls.set(userId, kept);
    if (bodyCalls.size > 5000) bodyCalls.delete(bodyCalls.keys().next().value);
    return true;
}

async function draftEmailBody(req, res) {
    const userId = req.user.id;
    try {
        const doc = await loadLetterFor(userId, req);
        if (!doc) return missingLetter(req, res);
        const p = doc.payload || {};
        // What the message will carry: { resume: false } = the cover letter only. Absent = both (the first app build's call).
        const withResume = !(req.body && req.body.resume === false);
        const sender = await cl().senderForLetter(userId, p).catch(() => null);
        if (!bodyAllowed(userId)) {
            return res.json({ success: true, body: mail.templateBody({ payload: p, employer: doc.employer_name, sender, withResume }), source: 'template', limited: true, withResume });
        }
        const aiText = require('../services/aiText');
        const out = await mail.draftBody(
            { payload: p, employer: doc.employer_name, sender, withResume },
            { generateText: aiText.generateText, chain: aiText.writing() },
        );
        return res.json({ success: true, body: out.body, source: out.source, withResume });
    } catch (e) {
        console.error('[letterSend] body draft failed:', e.message);
        return res.status(500).json({ success: false, reason: 'failed', error: 'Could not write a message. You can type your own.' });
    }
}

/* ── POST /:id/send-files — a file from the phone ─────────────────────────────────────────────────── */

// ⚠️ OUTSIDE temp/. The /api/download-* routes serve any unregistered file in temp/ to a signed-in caller
// (services/tempFiles); a CV the user picked for ONE email must never become fetchable, so it lives in the OS temp
// dir, is held for 30 minutes and is deleted after the send that used it.
// ⚠️ IN MEMORY, like tempFiles' registry: one Railway instance, and a deploy empties both the map and the folder.
const SEND_DIR = path.join(os.tmpdir(), 'cvapplyr-send');
const UPLOAD_TTL_MS = 30 * 60 * 1000;
const UPLOAD_MAX_PER_USER = 6;
const uploads = new Map();   // fileId → { userId, path, name, ext, mime, size, at }

function sweepUploads(now = Date.now()) {
    for (const [id, u] of uploads) {
        if (now - u.at > UPLOAD_TTL_MS) { uploads.delete(id); fsp.unlink(u.path).catch(() => {}); }
    }
}
function dropUpload(id) {
    const u = uploads.get(id);
    if (!u) return;
    uploads.delete(id);
    fsp.unlink(u.path).catch(() => {});
}
function takeUpload(userId, fileId) {
    sweepUploads();
    const id = typeof fileId === 'string' ? fileId.trim() : '';
    const u = id ? uploads.get(id) : null;
    return u && u.userId === userId && fs.existsSync(u.path) ? { ...u, id } : null;
}

async function uploadSendFile(req, res) {
    const userId = req.user.id;
    try {
        // A saved letter must be theirs; a classic send has no row to check — the file is held for THIS user either way,
        // and only this user's send can take it (takeUpload).
        if (!isClassic(req)) {
            const row = await docs.slimById(userId, req.params.id, req).catch(() => null);
            if (!row || row.kind !== 'cover_letter') return res.status(404).json(GONE);
        }
        const f = req.file;
        if (!f || !f.buffer) return res.status(400).json({ success: false, reason: 'bad_file', error: 'No file arrived. Please pick it again.' });
        const check = mail.checkDeviceFile(f.originalname, f.buffer);
        if (!check.ok) {
            return res.status(check.reason === 'too_big' ? 413 : 400).json({
                success: false, reason: check.reason,
                error: check.reason === 'too_big'
                    ? `That file is larger than ${Math.round(mail.MAX_DEVICE_FILE_BYTES / (1024 * 1024))} MB.`
                    : 'Only PDF or Word files (.pdf, .doc, .docx) can be attached.',
            });
        }
        sweepUploads();
        const mine = [...uploads.entries()].filter(([, u]) => u.userId === userId);
        while (mine.length >= UPLOAD_MAX_PER_USER) dropUpload(mine.shift()[0]);
        await fsp.mkdir(SEND_DIR, { recursive: true });
        const fileId = crypto.randomBytes(16).toString('hex');
        const abs = path.join(SEND_DIR, `${fileId}.${check.ext}`);
        await fsp.writeFile(abs, f.buffer);
        const name = String(f.originalname || '').split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f"]+/g, '').trim().slice(0, 120) || `file.${check.ext}`;
        uploads.set(fileId, { userId, path: abs, name, ext: check.ext, mime: check.mime, size: f.buffer.length, at: Date.now() });
        return res.json({ success: true, fileId, name, size: f.buffer.length, mime: check.mime });
    } catch (e) {
        console.error('[letterSend] upload failed:', e.message);
        return res.status(500).json({ success: false, reason: 'failed', error: 'That upload did not go through. Please try again.' });
    }
}

/* ── POST /:id/send ───────────────────────────────────────────────────────────────────────────────── */

/**
 * At most SENDS_PER_HOUR messages per user per hour — the cap that keeps CVApplyr's Gmail / Outlook client from being a
 * bulk mailer. ⚠️ THE SLOT IS TAKEN AT THE CHECK, IN THE SAME TICK (review, 2026-09-20). The check used to only READ the
 * count, and the send was noted at step 8 — after the letter, the gate and the render had all awaited — so every request
 * that arrived before the first one got there passed: 25 parallel sends (asJob answers 202 and runs them detached; a
 * classic Send needs no saved letter) all went out against a cap of 20. Now reserveSend counts the send before the first
 * await, and a send refused before the provider is asked gives its slot back (releaseSend) — a failed attempt does not
 * use up the hour. Once the provider is asked, the slot stays taken whatever it answers.
 */
const SENDS_PER_HOUR = 20;
const sendCalls = new Map();   // userId → [timestamps] — every send reserved in the last hour
function reserveSend(userId, now = Date.now()) {
    const kept = (sendCalls.get(userId) || []).filter((t) => now - t < 60 * 60 * 1000);
    if (kept.length >= SENDS_PER_HOUR) { sendCalls.set(userId, kept); return null; }
    kept.push(now);
    sendCalls.set(userId, kept);
    if (sendCalls.size > 5000) sendCalls.delete(sendCalls.keys().next().value);
    return now;
}
function releaseSend(userId, slot) {
    const kept = sendCalls.get(userId);
    const i = kept ? kept.indexOf(slot) : -1;
    if (i >= 0) kept.splice(i, 1);
}

const PROVIDER_NAME = { google: 'Gmail', microsoft: 'Outlook' };

/** What a mail failure tells the user. Every one of these happened BEFORE any charge. */
function mailFailure(reason, provider) {
    const who = PROVIDER_NAME[provider] || 'Your mail account';
    switch (reason) {
        case 'reconnect': return { status: 409, error: `${who} needs you to sign in again. Tap Reconnect, then send. ${NOTHING}` };
        // ⚠️ NOT "Reconnect" (2026-09-20). The account IS signed in and only the send permission is missing, and this
        // string is the one the user actually reads: the page renders the SERVER's text for a 'scope' failure (send.tsx
        // `ours`), under a button that says "Allow sending". Telling them to reconnect here is the loop the owner
        // reported — re-consenting with Google's "Send email on your behalf" checkbox still unticked. Kept word for
        // word in step with reasonMessage('scope') in MobileApp/services/letterSend.ts.
        case 'scope': return {
            status: 409,
            error: provider === 'microsoft'
                ? `${who} is connected, but it did not allow CVApplyr to send mail. Tap Allow sending and accept the “Send mail as you” permission. ${NOTHING}`
                : `${who} is connected, but you did not allow CVApplyr to send mail. Tap Allow sending and tick “Send email on your behalf”. ${NOTHING}`,
        };
        case 'no_mail_account': return { status: 409, error: `Connect Gmail or Outlook first — your application is sent from your own mailbox. ${NOTHING}` };
        case 'bad_recipient': return { status: 400, error: `${who} refused one of the addresses. Check them and try again. ${NOTHING}` };
        case 'too_big': return { status: 413, error: `The attachments are too large for ${who}. Remove or replace a file and try again. ${NOTHING}` };
        case 'provider_busy': return { status: 503, error: `${who} is busy right now. Try again in a minute. ${NOTHING}` };
        // ⚠️ NOT "nothing was sent": the connection dropped AFTER the message was handed over (emailController
        // classifyMailError), so it may be in their Sent folder — and on the recruiter's side. Nothing was charged.
        case 'unknown_outcome': return { status: 502, error: `We could not confirm that ${who} sent your message — the connection dropped after it was handed over. Look in your ${PROVIDER_NAME[provider] || 'mailbox'} Sent folder before sending again. Nothing was charged.` };
        default: return { status: 502, error: `${who} did not accept the message. Try again in a moment. ${NOTHING}` };
    }
}

const redactEmails = (s) => String(s || '').replace(/[^\s@<>"',;:]+@[^\s@<>"',;:]+/g, '<email>').slice(0, 160);

/**
 * The page size on an attachment WE render — the two words every renderer takes, and nothing else. ⚠️ JUNK IS DROPPED,
 * NOT PASSED ON ('A4', 'legal', 42, null): undefined means "no choice", which each renderer answers with its own
 * default (the document's design.mode for a stored document), never with a string it does not know.
 */
const modeOf = (v) => (v === 'a4' || v === 'onepage' ? v : undefined);

/**
 * The choice objects the page sends, shape-checked. null = a shape we do not accept.
 * ⚠️ `mode` rides on the CHOICE (2026-09-20, the Send page's per-attachment page size): the letter and the résumé can
 * be sent in different layouts, and the phone's Send fingerprint hashes these same objects — see services/letterSend.
 * The old top-level `b.mode` is still honoured for the letter, for a client older than this (step 4).
 */
function letterChoiceOf(v) {
    if (v == null) return { source: 'doc' };
    if (!isObj(v)) return null;
    if (v.source === 'doc') return { source: 'doc', mode: modeOf(v.mode) };
    if (v.source === 'file' && typeof v.fileId === 'string' && v.fileId) return { source: 'file', fileId: v.fileId };
    return null;
}
function resumeChoiceOf(v) {
    if (v == null) return { source: 'none' };
    if (!isObj(v)) return null;
    if (v.source === 'none' || v.source === 'uploaded') return { source: v.source };
    if (v.source === 'builder') return { source: 'builder', mode: modeOf(v.mode) };
    if (v.source === 'tailored' && Number.isInteger(Number(v.docId)) && Number(v.docId) > 0) return { source: 'tailored', docId: Number(v.docId), mode: modeOf(v.mode) };
    if (v.source === 'file' && typeof v.fileId === 'string' && v.fileId) return { source: 'file', fileId: v.fileId };
    return null;
}

async function sendLetterEmail(req, res) {
    const userId = req.user.id;
    const started = Date.now();
    const cleanup = [];          // rendered temp files — deleted however this ends
    const usedUploads = [];      // phone files — deleted after a successful send
    let slot = null;             // this send's place under SENDS_PER_HOUR (reserveSend)
    let slotSpent = false;       // …spent once the provider is asked; given back on any earlier refusal
    try {
        const held = isObj(req.letterMail) ? req.letterMail : {};
        const b = isObj(req.body) ? req.body : {};

        // 1. What was asked — refused whole, before anything is read.
        const rcpt = mail.normaliseRecipients(held.to);
        if (!rcpt.ok) return res.status(400).json({ success: false, reason: 'bad_recipients', error: rcpt.error });
        const subject = mail.cleanSubject(held.subject);
        if (!subject) return res.status(400).json({ success: false, reason: 'bad_subject', error: `Add a subject (at most ${mail.SUBJECT_MAX} characters).` });
        const text = mail.cleanBody(held.body);
        if (!text) return res.status(400).json({ success: false, reason: 'bad_body', error: `Add a message (at most ${mail.BODY_MAX} characters).` });
        const letterChoice = letterChoiceOf(b.letter);
        const resumeChoice = resumeChoiceOf(b.resume);
        if (!letterChoice || !resumeChoice) return res.status(400).json({ success: false, reason: 'bad_request', error: 'The attachments could not be read. Please try again.' });
        // ⚠️ Reserved HERE, before the first await (see reserveSend) — and before the letter is even read.
        slot = reserveSend(userId);
        if (slot === null) {
            return res.status(429).json({ success: false, reason: 'too_many', error: `You have sent a lot of messages in the last hour. Please wait a little. ${NOTHING}` });
        }

        // 2. The letter — this user's, this environment's (or the classic letter the request carries).
        const doc = await loadLetterFor(userId, req);
        if (!doc) return missingLetter(req, res);
        const p = doc.payload || {};

        // 3. The mailbox.
        const user = await dbConfig.get('SELECT * FROM users WHERE id = $1', [userId]);
        if (!user) return missingLetter(req, res);
        const acct = em().mailAccountOf(user);
        // ⚠️ Refused BEFORE the letter is rendered, not after (2026-09-20). A mailbox we already know cannot send is a
        // decided answer: rendering two PDFs first and then reporting it is what made the owner's failed sends take the
        // whole pipeline (prod, user 618: both PDFs built, then "reconnect"). 'scope' names the fix; nothing charged.
        if (!acct.ready || acct.canSend === false) {
            const reason = !acct.ready ? (acct.provider ? 'reconnect' : 'no_mail_account') : 'scope';
            return res.status(409).json({ success: false, reason, provider: acct.provider || null, error: mailFailure(reason, acct.provider).error });
        }
        const sender = await cl().senderForLetter(userId, p).catch(() => ({ name: user.full_name || '' }));
        const senderName = (sender && sender.name) || user.full_name || '';

        // 4. The attachments: who renders, who is gated, and for which employer.
        const parts = [];
        if (letterChoice.source === 'doc') {
            const template = typeof b.template === 'string' ? b.template : undefined;
            // The size the user chose on the Send page; the top-level `mode` is the older client's way of saying it.
            const mode = letterChoice.mode || modeOf(b.mode);
            parts.push({
                which: 'letter', gated: true, employer: doc.employer_name || null, kind: 'letter_doc',
                // Each lane through ITS Download's own render: the saved letter's, or the classic picker's.
                render: () => (doc.classic
                    ? cl().renderClassicLetterPdf(userId, { template, mode, coverLetterHtml: p.coverLetterHtml, companyName: p.companyName, companyAddress: p.companyAddress })
                    : cl().renderSavedLetterPdf(userId, doc, { template, mode })),
            });
        } else {
            const u = takeUpload(userId, letterChoice.fileId);
            if (!u) return res.status(409).json({ success: false, reason: 'file_gone', error: `The letter file you picked has expired. Choose it again. ${NOTHING}` });
            usedUploads.push(u.id);
            parts.push({ which: 'letter', gated: false, kind: 'file', filePath: u.path, mime: u.mime, sendName: mail.ownFileName(u.name, 'letter', senderName) });
        }
        if (resumeChoice.source === 'tailored') {
            const rdoc = await rb().loadResumeDoc(userId, resumeChoice.docId, req);
            if (!rdoc || !downloads.sameEmployer(rdoc.employer_name, doc.employer_name)) {
                return res.status(409).json({ success: false, reason: 'resume_gone', error: `That résumé is no longer saved for this employer. Pick another one in Attachments. ${NOTHING}` });
            }
            parts.push({
                which: 'resume', gated: true, employer: rdoc.employer_name || null, kind: 'resume_doc', rdoc,
                // The size chosen on the Send page; undefined keeps what it always did — the document's own
                // design.mode (resumeBuilderController renderResumeDocPdf → docModeOf).
                render: () => rb().renderResumeDocPdf(userId, rdoc, { mode: resumeChoice.mode }),
            });
        } else if (resumeChoice.source === 'builder') {
            parts.push({
                which: 'resume', gated: true, employer: doc.employer_name || null, kind: 'resume_builder',
                // ⚠️ THE SEND PAGE NOW CHOOSES (owner, 2026-09-20: "In the attachment section there should be option of
                // selecting A4 selection and One page selection too"). 'onepage' — the rule executeSendWork set for the
                // same Builder résumé — stays as the fallback for a client that sends no choice at all.
                mode: resumeChoice.mode || 'onepage',
                render: () => rb().buildResumePdfForRegion(userId, 'generic', resumeChoice.mode || 'onepage'),
            });
        } else if (resumeChoice.source === 'uploaded') {
            const up = await uploadedResumeOf(user);
            if (!up) return res.status(409).json({ success: false, reason: 'resume_gone', error: `Your uploaded CV could not be found. Upload it again in Profile, or pick another résumé. ${NOTHING}` });
            parts.push({ which: 'resume', gated: false, kind: 'file', filePath: up.path, mime: up.mime, sendName: mail.attachmentName('resume', senderName, up.ext) });
        } else if (resumeChoice.source === 'file') {
            const u = takeUpload(userId, resumeChoice.fileId);
            if (!u) return res.status(409).json({ success: false, reason: 'file_gone', error: `The résumé file you picked has expired. Choose it again. ${NOTHING}` });
            usedUploads.push(u.id);
            parts.push({ which: 'resume', gated: false, kind: 'file', filePath: u.path, mime: u.mime, sendName: mail.ownFileName(u.name, 'resume', senderName) });
        }

        // 5. The gate — every attachment WE render, before anything is rendered (the Download's rule and order).
        const planUnits = [];
        for (const part of parts.filter((x) => x.gated)) {
            const gate = await downloads.canDownload(userId, { employer: part.employer }, req);
            if (!gate.allowed) {
                return res.status(403).json({
                    success: false, reason: gate.reason || 'paid_required', which: part.which,
                    error: `${part.which === 'letter' ? 'Attaching your cover letter as a PDF' : 'Attaching your résumé as a PDF'} is part of the paid plans, like downloading it. ${NOTHING}`,
                });
            }
            if (gate.via === 'plan') planUnits.push(part.which);
        }
        // Under a metered plan each file is one download, exactly as two separate Downloads would be. ⚠️ AND THOSE TWO
        // DOWNLOADS WOULD FALL THROUGH TO A PASS: the plan pays for what it still covers, and when it runs dry
        // canDownload / claimDownload take an unspent one-off pass — whose first claim binds it to this employer and
        // makes every later file for them free (downloads.boundPassFor). Every file here is for the letter's employer,
        // so "the plan covers them all, OR an unspent pass exists" is exactly what claiming them one by one will do.
        if (downloads.METERED && planUnits.length > 1) {
            const ent = require('../services/entitlements');
            const many = await ent.canConsumeMany(userId, 'download', planUnits.length, req).catch(() => ({ allowed: false }));
            if (!many || !many.allowed) {
                const passes = typeof downloads.unboundPassCount === 'function'
                    ? await downloads.unboundPassCount(userId, downloads.envOf(req)).catch(() => 0)
                    : 0;
                if (!(passes > 0)) {
                    return res.status(403).json({
                        success: false, reason: 'quota_exhausted', which: 'resume', units: planUnits.length,
                        remaining: many && typeof many.remaining === 'number' ? many.remaining : null,
                        error: `Your plan has fewer downloads left than this message attaches (${planUnits.length} files we make). Remove the résumé or attach a file of your own, or get a one-employer pass. ${NOTHING}`,
                    });
                }
            }
        }

        // 6. Render — the same functions the Download buttons call.
        try {
            for (const part of parts.filter((x) => x.render)) {
                const r = await part.render();
                if (!r || !r.filePath) {
                    if (part.kind === 'resume_builder') {
                        return res.status(409).json({ success: false, reason: 'resume_gone', error: `Your résumé could not be found. Pick another one in Attachments. ${NOTHING}` });
                    }
                    throw new Error('renderer returned no file');
                }
                cleanup.push(r.filePath);
                tempFiles.own(userId, r.fileName);
                part.filePath = r.filePath;
                part.fileName = r.fileName;
                part.result = r;
                part.mime = 'application/pdf';
                part.sendName = mail.attachmentName(part.which, senderName, 'pdf');
            }
        } catch (e) {
            console.error(`[letterSend] render failed for user ${userId} ${letterLabel(doc)}:`, String(e && e.message).slice(0, 160));
            return res.status(502).json({ success: false, reason: 'render_failed', error: `We could not make the PDF. Try again, or pick another design. ${NOTHING}` });
        }

        // 7. The bytes, and the provider's size ceiling — checked before the provider is asked.
        let total = 0;
        for (const part of parts) {
            part.content = await fsp.readFile(part.filePath);
            total += part.content.length;
        }
        const cap = mail.MAX_TOTAL_BYTES[acct.provider] || mail.MAX_TOTAL_BYTES.google;
        if (total > cap) {
            return res.status(413).json({
                success: false, reason: 'too_big', limitBytes: cap, totalBytes: total,
                error: `The attachments come to ${(total / (1024 * 1024)).toFixed(1)} MB; ${PROVIDER_NAME[acct.provider] || 'your mailbox'} takes ${(cap / (1024 * 1024)).toFixed(1)} MB here. Remove or replace a file. ${NOTHING}`,
            });
        }

        // 8. Send — from THEIR mailbox, or not at all.
        const from = await accountAddressOf(user, acct.provider);
        const msg = {
            to: rcpt.list,
            subject,
            text,
            from: from ? { name: senderName || undefined, address: from } : undefined,
            messageDomain: from ? from.split('@').pop() : undefined,
            attachments: parts.map((x) => ({ filename: x.sendName, contentType: x.mime, content: x.content })),
        };
        const domains = mail.recipientDomains(rcpt.list).join(', ');
        slotSpent = true;            // the provider is asked: this send counts, whatever it answers
        let sent;
        try {
            sent = await em().sendWithConnectedAccount(user, msg);
        } catch (e) {
            const reason = em().classifyMailError(e);
            const status = e && (e.status || (e.response && e.response.status));
            console.warn(`[letterSend] user ${userId} ${letterLabel(doc)} → ${acct.provider} refused (${reason}${status ? ` ${status}` : ''}): ${redactEmails(e && e.message)}`);
            const f = mailFailure(reason, acct.provider);
            return res.status(f.status).json({ success: false, reason, provider: acct.provider, error: f.error });
        }
        const sentAt = new Date().toISOString();

        // 9. Charged only now — the message is in their Sent folder. Then recorded like the Download records it.
        let charged = false;
        for (const part of parts.filter((x) => x.gated)) {
            try {
                const c = await downloads.claimDownload(userId, { employer: part.employer }, req);
                if (c && c.charged) charged = true;
            } catch (e) { console.warn('[letterSend] claim failed after a sent message:', e.message); }
            try {
                if (part.kind === 'letter_doc') {
                    const r = part.result;
                    await cl().recordLetter(userId, req, {
                        employer: part.employer, tplId: r.tplId, format: 'pdf', mode: r.mode, fileName: r.fileName,
                        coverLetterHtml: r.input.coverLetterHtml, companyName: r.input.companyName,
                        companyAddress: r.input.companyAddress, brandColor: r.input.brandColor, docId: doc.classic ? undefined : doc.id,
                    });
                } else if (part.kind === 'resume_doc' || part.kind === 'resume_builder') {
                    const r = part.result;
                    // The row records the layout that was actually RENDERED: the renderer's own answer, else the size
                    // this part was built with (the Builder lane's renderer does not report one back).
                    const rmode = r.mode || part.mode || '';
                    await history.record(userId, {
                        kind: 'resume', employer: part.employer, templateId: r.template, templateName: r.template,
                        format: 'pdf', mode: rmode, fileName: r.fileName,
                        payload: part.kind === 'resume_doc' ? { template: r.template, mode: r.mode, docId: Number(part.rdoc.id) } : { template: r.template, mode: rmode },
                    }, req);
                }
            } catch { /* a history row is a convenience; the message is sent */ }
        }

        // 10. The application, where the app already records emailed applications (replies, follow-ups, the journey).
        const company = (typeof p.companyName === 'string' && p.companyName) || doc.employer_name || '';
        const position = (typeof p.position === 'string' && p.position) || doc.job_title || '';
        for (const to of rcpt.list) {
            try {
                await dbConfig.run(
                    'INSERT INTO application_history (user_id, company_name, position, recipient_email, sent_date, reply_received, reply_date) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                    [userId, company, position, to, sentAt, 0, null]);
            } catch (e) { console.warn('[letterSend] application_history write failed:', e.message); }
        }
        try { await dbConfig.run('UPDATE users SET total_sent = COALESCE(total_sent, 0) + 1 WHERE id = $1', [userId]); } catch { /* a counter */ }
        try { await require('./notificationsController').notifyEmailSent(userId, company, rcpt.list.join(', '), position, subject); } catch { /* a notice */ }
        try { require('../services/track').emit(req, 'letter_emailed', { provider: acct.provider, recipients: rcpt.list.length, files: parts.length, charged }); } catch { /* analytics */ }

        for (const id of usedUploads) dropUpload(id);
        console.log(`[letterSend] user ${userId} ${letterLabel(doc)} → ${acct.provider}: ${rcpt.list.length} recipient(s) (${domains}), ${parts.length} file(s) ${Math.round(total / 1024)} KB, charged=${charged} in ${Date.now() - started}ms`);
        // ⚠️ A COUNT, NOT THE ADDRESSES: in the async lane this body is stored as the job's result (async_jobs), and the
        // phone already holds the list it sent. The sender's own address is theirs to see.
        return res.json({
            success: true, provider: acct.provider, from: from || null, recipients: rcpt.list.length, charged, sentAt,
            attachments: parts.map((x) => ({ which: x.which, name: x.sendName, bytes: x.content ? x.content.length : 0 })),
        });
    } catch (e) {
        console.error(`[letterSend] send failed for user ${userId}:`, String(e && e.message).slice(0, 160));
        return res.status(500).json({ success: false, reason: 'failed', error: `Something went wrong before the message left. ${NOTHING}` });
    } finally {
        if (slot !== null && !slotSpent) releaseSend(userId, slot);
        for (const f of cleanup) fsp.unlink(f).catch(() => {});
    }
}

module.exports = {
    getEmailDraft, draftEmailBody, uploadSendFile, sendLetterEmail,
    // exposed for tests only
    _internals: { contactsFor, resumeOptionsFor, accountOf, uploadedResumeOf, takeUpload, uploads, sendCalls, bodyCalls, mailFailure, letterChoiceOf, resumeChoiceOf, SEND_DIR },
};
