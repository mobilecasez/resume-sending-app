// HTML → Word (.docx) renderer. Additive: does NOT touch the PDF path.
// Converts an HTML string to a .docx Buffer via html-to-docx. Used by the new
// "Download as Word" endpoints for resumes and cover letters.
'use strict';

const HTMLtoDOCX = require('html-to-docx');

// twips: 1 inch = 1440. ~0.7" margins keep dense resume content on the page.
const DEFAULT_MARGINS = { top: 1008, right: 1008, bottom: 1008, left: 1008 };

/**
 * @param {string} html       Full HTML document (Word-friendly: simple CSS).
 * @param {object} [opts]
 * @param {string} [opts.font='Calibri']
 * @param {number} [opts.fontSize=22]   half-points (22 = 11pt)
 * @param {object} [opts.margins]
 * @returns {Promise<Buffer>}
 */
async function htmlToDocx(html, opts = {}) {
  const out = await HTMLtoDOCX(html, null, {
    margins: opts.margins || DEFAULT_MARGINS,
    font: opts.font || 'Calibri',
    fontSize: opts.fontSize || 22,
    table: { row: { cantSplit: true } },
    pageNumber: false,
  });
  // html-to-docx returns a Buffer in Node; normalise just in case.
  return Buffer.isBuffer(out) ? out : Buffer.from(out);
}

const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

module.exports = { htmlToDocx, DOCX_CONTENT_TYPE };
