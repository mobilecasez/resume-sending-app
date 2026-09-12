// What a download costs this user right now — read by the download button and by the
// purchase sheet after a pass is bought — and what they have already downloaded.
//
// Lives on its own path because BOTH the resume gallery and the cover-letter screen ask it; hanging
// it off /resume-builder would have made the letter screen call a resume endpoint.
const express = require('express');
const router  = express.Router();
const { authenticateToken } = require('../middleware/auth');
const downloads = require('../services/downloads');
const history = require('../services/downloadHistory');

// GET /api/downloads/state?employer=Airbus
router.get('/state', authenticateToken, async (req, res) => {
  try {
    const employer = String(req.query.employer || '').trim() || null;
    const state = await downloads.downloadState(req.user.id, employer, req);
    return res.json({ success: true, ...state, productId: downloads.PASS_PRODUCT_ID });
  } catch (e) {
    console.error('[downloads] state failed:', e.message);
    // ⚠️ Fail CLOSED in the shape the button understands: an unreadable state must render the
    // locked button, never an unlocked one.
    return res.json({
      success: false, metered: downloads.METERED, paid: false, unlimited: false,
      remaining: 0, passes: 0, ownsEmployer: false, productId: downloads.PASS_PRODUCT_ID,
    });
  }
});

// GET /api/downloads/history?kind=resume|cover_letter
//
// ⚠️ NO FILENAMES IN THIS RESPONSE, EVER. The four /api/download-*/:filename routes authenticate the
// caller and then serve any name that exists in temp/ (services/tempFiles.js closes that for files
// we minted, but the narrow rule there still allows anything unregistered). A list endpoint that
// handed out filenames would turn a hard-to-guess name into a published one. The client re-requests
// by history id and the server mints a fresh file.
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const kind = String(req.query.kind || 'resume');
    const out = await history.list(req.user.id, kind, req);
    return res.json({ success: true, ...out });
  } catch (e) {
    console.error('[downloads] history failed:', e.message);
    // An empty list is the safe answer: the section simply shows its empty state.
    return res.json({ success: false, items: [], unlimited: false });
  }
});

/**
 * POST /api/downloads/history/:id/again — produce this document again.
 *
 * ⚠️ IT DELEGATES TO THE ORIGINAL HANDLER RATHER THAN RE-IMPLEMENTING THE RENDER.
 * A second copy of "render, then gate, then claim, then record" is a second chance for the money
 * rules to drift — and the last audit found five copies of exactly that shape. So this rebuilds the
 * request body the first download used and hands it to the very same controller: the paid gate, the
 * pass claim, the history upsert and the temp-file ownership registration all happen once, in one
 * place. A lapsed plan therefore locks these rows exactly as it locks a fresh download, and a bought
 * pass keeps its employer open forever.
 *
 * ⚠️ IT RE-RENDERS; IT NEVER RE-SERVES. temp/ is in .railwayignore with no volume, so every deploy
 * wipes it — the stored file_name is a dangling pointer within hours and is deliberately not used.
 * For a resume that means the CURRENT resume in the original design (there is no version history,
 * user_resumes being UNIQUE(user_id)); for a letter it means the exact text that was downloaded,
 * because the payload froze it.
 */
router.post('/history/:id/again', authenticateToken, async (req, res) => {
  let row;
  try {
    row = await history.get(req.user.id, req.params.id, req);
  } catch (e) {
    console.error('[downloads] history/again lookup failed:', e.message);
    return res.status(500).json({ error: 'Could not open that download. Please try again.' });
  }
  if (!row) return res.status(404).json({ error: 'That download is no longer in your history.' });

  const p = row.payload || {};
  const isDocx = row.format === 'docx';

  if (row.kind === 'cover_letter') {
    // A letter downloaded from an employer DOCUMENT re-renders from that document (the handler loads
    // it by id, owner- and environment-scoped, and 410s payload_gone itself). ⚠️ Only when the row
    // still exists: a document pruned since, with the downloaded text frozen here, falls through to
    // the frozen-html path below — that text IS the letter they paid for, so it is the honest answer.
    if (p.docId) {
      const doc = await require('../services/employerDocs')
        .getById(req.user.id, p.docId, req, { kind: 'cover_letter' })
        .catch(() => null);
      if (doc || !p.coverLetterHtml) {
        req.body = {
          template: p.template || row.template_id || 'standard',
          mode: p.mode || row.mode || '',
          employer: row.employer_name || null,
          docId: p.docId,
        };
        const cl = require('../controllers/coverLetterController');
        return isDocx
          ? cl.generateCoverLetterTemplateDocx(req, res)
          : cl.generateCoverLetterTemplatePdf(req, res);
      }
    }
    if (!p.coverLetterHtml) {
      // Frozen text is what makes a letter reproducible. Without it there is nothing honest to
      // hand back — the renderer would 400 anyway, and guessing a different letter would be worse.
      return res.status(410).json({
        error: 'We no longer have the text of that letter. Open the job and generate it again.',
        reason: 'payload_gone',
      });
    }
    req.body = {
      template: p.template || row.template_id || 'standard',
      mode: p.mode || row.mode || '',
      coverLetterHtml: p.coverLetterHtml,
      companyName: p.companyName || row.employer_name || '',
      companyAddress: p.companyAddress || '',
      brandColor: p.brandColor || null,
      employer: row.employer_name || null,
    };
    const cl = require('../controllers/coverLetterController');
    return isDocx
      ? cl.generateCoverLetterTemplateDocx(req, res)
      : cl.generateCoverLetterTemplatePdf(req, res);
  }

  // docId: this download was rendered from an employer's tailored document, so the again-render must
  // be THAT document, not whatever user_resumes holds today (the handler 410s payload_gone when the
  // document is gone — ⚠️ never a silent fall back to the base resume under the tailored entry's name).
  req.body = {
    template: p.template || row.template_id || '',
    mode: p.mode || row.mode || 'a4',
    employer: row.employer_name || null,
    docId: p.docId || undefined,
  };
  const rb = require('../controllers/resumeBuilderController');
  return isDocx ? rb.generateDocx(req, res) : rb.generatePDF(req, res);
});

module.exports = router;
