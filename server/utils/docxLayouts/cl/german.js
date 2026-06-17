// Cover-letter Word layout — German Professional (DACH). Mirrors the PDF
// STYLES.german in coverLetterTemplates.js:
//   - letterhead: name (Poppins 600, ~19pt) + optional title on the LEFT,
//     contact lines RIGHT-aligned in their own column (DIN 5008 feel),
//     closed by a thin slate (#94A3B8) bottom rule
//   - a right-aligned "Place, Date" line above the recipient (German convention)
//   - recipient: company name bold + address split on newline/comma
//   - salutation "Dear Sir or Madam,", justified conservative body,
//     closing "Yours faithfully," + signature name
// Formal, structured, conservative — accent #334155.
//
// Contract: module.exports = function build(data, opts) -> { children, margin }
//   data = { sender:{name,title,email,phone,location}, company:{name,address}, bodyHtml }
//   opts = { accent }   accent: hex (with/without '#'); falls back to #334155
'use strict';

const H = require('../../docxHelpers');
const {
  Paragraph, Table, TableRow, TableCell,
  AlignmentType, BorderStyle, WidthType,
  MUTED, has, hex, run, htmlToParagraphs, NO_BORDERS, PAGE_W,
} = H;

const DEFAULT_ACCENT = '334155';
const SALUTATION = 'Dear Sir or Madam,';
const CLOSING = 'Yours faithfully,';

function todayLong() {
  try { return new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }); }
  catch (e) { return ''; }
}

// Does the body already contain a salutation? Then don't double it up.
function hasSalutation(html) {
  return /^\s*<p[^>]*>\s*(dear\b|to whom|sehr geehrte)/i.test(String(html || ''));
}

module.exports = function build(data, opts) {
  data = data || {};
  opts = opts || {};
  const s = data.sender || {};
  const c = data.company || {};
  const accent = has(opts.accent) ? hex(opts.accent) : DEFAULT_ACCENT;

  const M = 1440;                       // ~1in margins (conservative business letter)
  const CONTENT_W = PAGE_W - M - M;      // usable width in twips
  const ink = '1F2937', slate = '475569', rule = '94A3B8';
  const out = [];

  // ── Letterhead: name (left) + contact (right), thin rule under ──────────────
  const contactParts = [s.email, s.phone, s.location].filter(has).map(String);

  // Left column: name (Poppins-600 feel → bold, ~17pt) + optional title.
  const leftChildren = [];
  if (has(s.name)) {
    leftChildren.push(new Paragraph({
      spacing: { after: has(s.title) ? 20 : 0 },
      children: [run(String(s.name), { bold: true, color: ink, size: 34 })],
    }));
  }
  if (has(s.title)) {
    leftChildren.push(new Paragraph({ children: [run(String(s.title), { color: slate, size: 20 })] }));
  }
  if (!leftChildren.length) leftChildren.push(new Paragraph({ children: [run('', { size: 2 })] }));

  // Right column: each contact part on its own right-aligned line.
  const rightChildren = contactParts.length
    ? contactParts.map((p, i) => new Paragraph({
        alignment: AlignmentType.RIGHT,
        spacing: { after: i === contactParts.length - 1 ? 0 : 30 },
        children: [run(p, { color: slate, size: 18 })],
      }))
    : [new Paragraph({ alignment: AlignmentType.RIGHT, children: [run('', { size: 2 })] })];

  const leftW = Math.round(CONTENT_W * 0.55);
  const rightW = CONTENT_W - leftW;
  out.push(new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: [leftW, rightW],
    borders: NO_BORDERS,
    rows: [new TableRow({ children: [
      new TableCell({ width: { size: leftW, type: WidthType.DXA }, borders: NO_BORDERS, margins: { top: 0, bottom: 0, left: 0, right: 120 }, children: leftChildren }),
      new TableCell({ width: { size: rightW, type: WidthType.DXA }, borders: NO_BORDERS, margins: { top: 0, bottom: 0, left: 120, right: 0 }, children: rightChildren }),
    ] })],
  }));

  // Thin slate rule under the letterhead.
  out.push(new Paragraph({
    spacing: { before: 80, after: 0 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: rule, space: 4 } },
    children: [run('', { size: 2 })],
  }));

  // ── Place, Date — right-aligned (German letter convention) ──────────────────
  const date = todayLong();
  const place = has(s.location) ? String(s.location).split(',')[0].trim() : '';
  const placeDate = [place, date].filter(has).join(', ');
  if (placeDate) {
    out.push(new Paragraph({
      alignment: AlignmentType.RIGHT,
      spacing: { before: 260, after: 220 },
      children: [run(placeDate, { color: '374151', size: 20 })],
    }));
  }

  // ── Recipient block (company name bold + address lines) ─────────────────────
  if (has(c.name) || has(c.address)) {
    if (has(c.name)) {
      out.push(new Paragraph({
        spacing: { after: has(c.address) ? 10 : 60, line: 264 },
        children: [run(String(c.name), { bold: true, color: '111827', size: 21 })],
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

  // ── Salutation (only if the body doesn't already open with one) ─────────────
  const bodyHtml = String(data.bodyHtml || '');
  if (!hasSalutation(bodyHtml)) {
    out.push(new Paragraph({ spacing: { before: 80, after: 160 }, children: [run(SALUTATION, { color: ink, size: 21 })] }));
  }

  // ── Body — justified, conservative ──────────────────────────────────────────
  if (has(bodyHtml)) {
    htmlToParagraphs(bodyHtml, { size: 21, alignment: AlignmentType.JUSTIFIED }).forEach((p) => out.push(p));
  }

  // ── Closing + signature — always appended (the AI body never signs off; the PDF
  //    appends it unconditionally) ─────────────────────────────────────────────
  out.push(new Paragraph({ spacing: { before: 200, after: 0 }, children: [run(CLOSING, { color: '27313F', size: 21 })] }));
  if (has(s.name)) {
    out.push(new Paragraph({ spacing: { before: 300 }, children: [run(String(s.name), { bold: true, color: '111827', size: 21 })] }));
  }

  return { children: out, margin: { top: M, right: M, bottom: M, left: M } };
};
