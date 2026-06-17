// Cover-letter Word layout — ATS Professional (US/CA). Mirrors the PDF STYLES.ats_pro:
// a clean, left-aligned letterhead (bold name + title + contact) closed by a thin dark
// bottom rule, then date, recipient block, salutation, justified body and "Sincerely,"
// closing. ATS-safe: no tables, no graphics — just text, a rule, and consistent spacing.
//
// Contract: module.exports = function build(data, opts) -> { children, margin }
//   data = { sender:{name,title,email,phone,location}, company:{name,address}, bodyHtml }
//   opts = { accent }   accent: hex (with/without '#'); falls back to #1f2937
'use strict';

const H = require('../../docxHelpers');
const {
  Paragraph, AlignmentType, BorderStyle,
  MUTED, has, hex, run, htmlToParagraphs,
} = H;

const SALUTATION = 'Dear Hiring Manager,';
const CLOSING = 'Sincerely,';
const DARK = '111827';   // PDF header ink + rule colour (#111827)

function todayLong() {
  try { return new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }); }
  catch (e) { return ''; }
}

// Does the (server-generated) body already carry a salutation? If so we don't re-add
// ours, to avoid a duplicate "Dear …" line.
function hasSalutation(html) {
  return /\b(dear|hello|hi|to whom it may concern|greetings)\b/i.test(H.stripTags(String(html || '')).slice(0, 160));
}

module.exports = function build(data, opts) {
  data = data || {};
  opts = opts || {};
  const s = data.sender || {};
  const c = data.company || {};
  const accent = has(opts.accent) ? hex(opts.accent) : '1F2937';

  const M = 1440;                  // ~1in business-letter margins
  const out = [];

  // ── Letterhead: left-aligned name / title / contact + thin dark bottom rule ──
  const contactParts = [s.email, s.phone, s.location].filter(has).map(String);
  const contactLine = contactParts.join('   •   ');

  if (has(s.name)) {
    out.push(new Paragraph({
      alignment: AlignmentType.LEFT,
      spacing: { after: has(s.title) ? 20 : (contactLine ? 30 : 60) },
      // Poppins bold 20pt → size 36 half-pts, dark ink, a touch of tracking.
      children: [run(String(s.name), { bold: true, color: DARK, size: 36, characterSpacing: 4 })],
    }));
  }

  if (has(s.title)) {
    out.push(new Paragraph({
      alignment: AlignmentType.LEFT,
      spacing: { after: contactLine ? 30 : 80 },
      children: [run(String(s.title), { color: '374151', size: 21 })],
    }));
  }

  if (contactLine) {
    out.push(new Paragraph({
      alignment: AlignmentType.LEFT,
      spacing: { after: 60 },
      children: [run(contactLine, { color: '4B5563', size: 19 })],
    }));
  }

  // Thin dark rule under the header (PDF: 1.5px solid #111827). Use DARK to match the
  // PDF exactly; the accent (default #1f2937) is its near-twin and used for emphasis.
  out.push(new Paragraph({
    alignment: AlignmentType.LEFT,
    spacing: { after: 0 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 10, color: DARK, space: 4 } },
    children: [run('', { size: 2 })],
  }));

  // ── Date ────────────────────────────────────────────────────────────────────
  const date = todayLong();
  if (date) {
    out.push(new Paragraph({
      alignment: AlignmentType.LEFT,
      spacing: { before: 240, after: 200 },
      children: [run(date, { color: '374151', size: 20 })],
    }));
  }

  // ── Recipient block (company name bold + address split on newline / comma) ────
  if (has(c.name) || has(c.address)) {
    if (has(c.name)) {
      out.push(new Paragraph({
        spacing: { after: has(c.address) ? 10 : 60 },
        children: [run(String(c.name), { bold: true, color: DARK, size: 21 })],
      }));
    }
    if (has(c.address)) {
      const lines = [String(c.address).replace(/\s+/g, " ").trim()].filter(Boolean);
      lines.forEach((l, i) => out.push(new Paragraph({
        spacing: { after: i === lines.length - 1 ? 60 : 8, line: 264 },
        children: [run(l, { color: '4B5563', size: 20 })],
      })));
    }
  }

  // ── Salutation (only if the body doesn't already open with one) ──────────────
  const bodyHtml = has(data.bodyHtml) ? String(data.bodyHtml) : '';
  if (!hasSalutation(bodyHtml)) {
    out.push(new Paragraph({
      spacing: { before: 80, after: 160 },
      children: [run(SALUTATION, { color: '1F2937', size: 21 })],
    }));
  }

  // ── Body — justified, ATS-clean ──────────────────────────────────────────────
  if (bodyHtml) {
    htmlToParagraphs(bodyHtml, { size: 21, alignment: AlignmentType.JUSTIFIED })
      .forEach((p) => out.push(p));
  }

  // ── Closing + signature — always appended (the AI body never signs off; the PDF
  //    appends it unconditionally) ─────────────────────────────────────────────
  out.push(new Paragraph({
    spacing: { before: 200, after: has(s.name) ? 220 : 0 },
    children: [run(CLOSING, { color: '27313F', size: 21 })],
  }));
  if (has(s.name)) {
    out.push(new Paragraph({
      children: [run(String(s.name), { bold: true, color: DARK, size: 21 })],
    }));
  }

  return { children: out, margin: { top: M, right: M, bottom: M, left: M } };
};
