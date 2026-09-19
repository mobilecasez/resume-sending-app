'use strict';

/**
 * WHAT AN ATTACHED RÉSUMÉ IS CALLED, AND WHAT TYPE IT DECLARES (2026-09-19).
 *
 * ⚠️ WHY: the upload now takes Word, OpenDocument, RTF and plain text as well as PDF (services/resumeText.js), and
 * every older send path named the stored résumé "<Name>_Resume.pdf" with Content-Type application/pdf whatever it
 * was — a .docx attached that way opens as a broken PDF in the recruiter's inbox. The upload stores each file under
 * its REAL extension (profileController.uploadResume renames a ".bin" to ".docx"), so the stored path is the truth:
 * the attachment takes its extension and its type from there. A path this does not recognise stays the PDF it was
 * always assumed to be (the Builder's region PDF, and every upload from before 2026-09-19, is a PDF).
 */

const fsp = require('fs').promises;
const path = require('path');
const { FORMATS, kindOfPath, inspectResumeFile, MESSAGES } = require('../../services/resumeText');

/** { filename: `${baseName}_Resume.<ext>`, contentType } for the résumé stored at `storedPath`. */
function resumeAttachmentOf(storedPath, baseName) {
    const kind = kindOfPath(storedPath);
    const f = (kind && FORMATS[kind]) || FORMATS.pdf;
    const name = String(baseName || 'Resume').trim() || 'Resume';
    return { filename: `${name}_Resume${f.ext}`, contentType: f.mime, ext: f.ext };
}

/** The extension alone ('.pdf' when unknown) — for a caller that builds its own name. */
const resumeExtOf = (storedPath) => resumeAttachmentOf(storedPath, 'x').ext;

/**
 * THE ONE GATE EVERY RÉSUMÉ UPLOAD PASSES, before anything is committed (2026-09-20).
 *
 * ⚠️ WHY IT IS SHARED. /users/profile/resume (the app's wizard) checked the bytes before committing; the website's
 * /api/upload-profile did not — it saved whatever arrived, pointed users.resume_path at it and left the background
 * parser to discover hours later that the file could not be read. Same product promise, two answers. Both call this.
 *
 * `filePath` is what multer just wrote. On a file the server can read: the file is RENAMED to the real extension
 * (the email paths name the attachment from the stored path — a Word CV sent as "_Resume.pdf" opens broken) and
 * { ok: true, fmt, path } comes back. Otherwise the file is DELETED and { ok: false, status, body } is the answer to
 * send — so the CV already on file stays exactly as it was.
 */
async function vetUploadedResume(filePath) {
    let fmt;
    try {
        fmt = inspectResumeFile(await fsp.readFile(filePath));
    } catch (e) {
        fmt = { ok: false, reason: 'damaged', message: MESSAGES.damaged };
    }
    if (!fmt.ok) {
        await fsp.unlink(filePath).catch(() => {});
        return {
            ok: false,
            fmt,
            status: 415,
            body: { error: fmt.message, reason: fmt.reason === 'damaged' || fmt.reason === 'unsupported' ? 'unsupported_format' : fmt.reason },
        };
    }
    let stored = filePath;
    const ext = path.extname(stored);
    if (ext.toLowerCase() !== fmt.ext) {
        const fixed = stored.slice(0, stored.length - ext.length) + fmt.ext;
        await fsp.rename(stored, fixed);
        stored = fixed;
    }
    return { ok: true, fmt, path: stored };
}

module.exports = { resumeAttachmentOf, resumeExtOf, vetUploadedResume };
