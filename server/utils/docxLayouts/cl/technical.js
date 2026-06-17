// Cover-letter Word layout — "Technical Specialist" (template id: technical).
// Mirrors the PDF style in ../coverLetterTemplates.js (STYLES.technical):
//   header with a TEAL ACCENT BAR down the left edge (border-left:5px solid #0e7490),
//   name in bold near-black, a BOLD TEAL job title, slate contact line, plain date,
//   bold company recipient block, and a BOLD TEAL salutation. Modern, technical feel.
//
// Contract: module.exports = function build(data, opts) -> { children, margin }
//   data = { sender:{name,title,email,phone,location}, company:{name,address}, bodyHtml }
//   opts = { accent }   accent: hex (with/without '#'); falls back to 0e7490
'use strict';

const H = require('../../docxHelpers');
const {
  Paragraph, Table, TableRow, TableCell,
  AlignmentType, BorderStyle, WidthType,
  PAGE_W, MUTED, has, hex, run, htmlToParagraphs, NO_BORDER,
} = H;

function todayLong() {
  try { return new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }); }
  catch (e) { return ''; }
}

module.exports = function build(data, opts) {
  data = data || {};
  opts = opts || {};
  const s = data.sender || {};
  const c = data.company || {};

  const accent = has(opts && opts.accent) ? hex(opts.accent) : '0E7490';
  const dark = '0F172A';          // near-black name colour (PDF .name #0f172a)
  const slate = '475569';         // contact line (PDF .contact #475569)

  const M = 1440;                 // ~1in business-letter margins
  const CONTENT_W = PAGE_W - M - M;
  const out = [];

  // ── Header: a single-cell table giving the teal LEFT ACCENT BAR ──────────────
  // The PDF uses `border-left:5px solid #0e7490; padding-left:14px`. In Word the
  // cleanest equivalent is a borderless cell with a coloured left border + left
  // inset, so the name/title/contact sit just right of a vertical teal rule.
  const headerLines = [];
  if (has(s.name)) {
    headerLines.push(new Paragraph({
      spacing: { after: has(s.title) ? 20 : (has(s.email) || has(s.phone) || has(s.location) ? 40 : 0) },
      children: [run(String(s.name), { bold: true, color: dark, size: 36 })],
    }));
  }
  if (has(s.title)) {
    headerLines.push(new Paragraph({
      spacing: { after: 40 },
      children: [run(String(s.title), { bold: true, color: accent, size: 21 })],
    }));
  }
  const contactLine = [s.email, s.phone, s.location].filter(has).map(String).join('   •   ');
  if (contactLine) {
    headerLines.push(new Paragraph({
      spacing: { after: 0 },
      children: [run(contactLine, { color: slate, size: 19 })],
    }));
  }
  if (!headerLines.length) headerLines.push(new Paragraph({ children: [run('', { size: 2 })] }));

  const accentBar = { style: BorderStyle.SINGLE, size: 30, color: accent, space: 0 };
  out.push(new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: [CONTENT_W],
    borders: { top: NO_BORDER, bottom: NO_BORDER, right: NO_BORDER, insideHorizontal: NO_BORDER, insideVertical: NO_BORDER, left: accentBar },
    rows: [new TableRow({ children: [new TableCell({
      width: { size: CONTENT_W, type: WidthType.DXA },
      borders: { top: NO_BORDER, bottom: NO_BORDER, right: NO_BORDER, left: accentBar },
      margins: { top: 20, bottom: 20, left: 200, right: 0 },
      children: headerLines,
    })] })],
  }));

  // ── Date ─────────────────────────────────────────────────────────────────────
  const date = todayLong();
  if (date) out.push(new Paragraph({ spacing: { before: 280, after: 200 }, children: [run(date, { color: '374151', size: 20 })] }));

  // ── Recipient block (company name bold + address split on newline / comma) ────
  if (has(c.name) || has(c.address)) {
    if (has(c.name)) {
      out.push(new Paragraph({ spacing: { after: has(c.address) ? 10 : 80 }, children: [run(String(c.name), { bold: true, color: dark, size: 21 })] }));
    }
    if (has(c.address)) {
      const lines = [String(c.address).replace(/\s+/g, " ").trim()].filter(Boolean);
      lines.forEach((l, i) => out.push(new Paragraph({
        spacing: { after: i === lines.length - 1 ? 80 : 8, line: 264 },
        children: [run(l, { color: '4B5563', size: 20 })],
      })));
    }
  }

  // ── Salutation (bold teal accent) — only if the body doesn't already open with one ─
  const bodyHtml = has(data.bodyHtml) ? String(data.bodyHtml) : '';
  const bodyPlain = bodyHtml.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').trim();
  const bodyHasSalutation = /^(dear|hello|hi|to\s+whom|greetings)\b/i.test(bodyPlain);
  if (!bodyHasSalutation) {
    out.push(new Paragraph({ spacing: { before: 80, after: 160 }, children: [run('Dear Hiring Manager,', { bold: true, color: accent, size: 21 })] }));
  }

  // ── Body ─────────────────────────────────────────────────────────────────────
  if (bodyHtml) {
    htmlToParagraphs(bodyHtml, { size: 21, alignment: AlignmentType.JUSTIFIED }).forEach((p) => out.push(p));
  }

  // ── Closing + signature — always appended. The AI body never signs off (the prompt
  //    forbids it); the PDF renders style.closing + name unconditionally, so we match it. ─
  out.push(new Paragraph({ spacing: { before: 200, after: has(s.name) ? 220 : 0 }, children: [run('Best regards,', { color: '27313F', size: 21 })] }));
  if (has(s.name)) {
    out.push(new Paragraph({ children: [run(String(s.name), { bold: true, color: dark, size: 21 })] }));
  }

  return { children: out, margin: { top: M, right: M, bottom: M, left: M } };
};
