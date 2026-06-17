// Cover-letter Word layout — Graduate / Entry Level. Mirrors the PDF STYLES.graduate:
// a soft indigo "card" letterhead (light #f4f4fb fill, indigo hairline border, rounded
// feel approximated by a shaded single-cell box), bold near-black name, indigo semibold
// title, muted contact line — then date, recipient block, salutation, justified body.
// Friendly, modern, approachable indigo. Accent #5b5bd6.
//
// Contract: module.exports = function build(data, opts) -> { children, margin }
//   data = { sender:{name,title,email,phone,location}, company:{name,address}, bodyHtml }
//   opts = { accent }   accent: hex (with/without '#'); falls back to #5b5bd6
'use strict';

const H = require('../../docxHelpers');
const {
  Paragraph, Table, TableRow, TableCell,
  AlignmentType, BorderStyle, WidthType, ShadingType,
  PAGE_W, MUTED, has, hex, run, htmlToParagraphs, NO_BORDERS,
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

  const accent = has(opts.accent) ? hex(opts.accent) : '5B5BD6';
  const ink = '16161D';                 // near-black name colour from the PDF
  const dark = '111827';
  const cardFill = H.lighten(accent, 0.92);   // ~#f4f4fb soft indigo tint
  const cardBorder = H.lighten(accent, 0.78); // ~#e5e5f3 hairline

  const M = 1440;                        // ~1in margins
  const CARD_W = PAGE_W - M - M;         // header card spans the text column
  const out = [];

  const contactParts = [s.email, s.phone, s.location].filter(has).map(String);
  const contactLine = contactParts.join('   •   ');

  // ── Letterhead "card": light-indigo shaded box with indigo hairline border. ──
  // Approximates the PDF's rounded f4f4fb card (Word has no border-radius).
  const cardChildren = [];
  if (has(s.name)) {
    cardChildren.push(new Paragraph({
      spacing: { after: has(s.title) ? 20 : (contactLine ? 40 : 0) },
      children: [run(String(s.name), { bold: true, size: 38, color: ink, characterSpacing: -2 })],
    }));
  }
  if (has(s.title)) {
    cardChildren.push(new Paragraph({
      spacing: { after: contactLine ? 40 : 0 },
      children: [run(String(s.title), { bold: true, color: accent, size: 21 })],
    }));
  }
  if (contactLine) {
    cardChildren.push(new Paragraph({
      spacing: { after: 0 },
      children: [run(contactLine, { color: '44445A', size: 19 })],
    }));
  }
  if (!cardChildren.length) {
    cardChildren.push(new Paragraph({ children: [run('', { size: 2 })] }));
  }

  const cardEdge = { style: BorderStyle.SINGLE, size: 4, color: cardBorder, space: 0 };
  out.push(new Table({
    width: { size: CARD_W, type: WidthType.DXA },
    columnWidths: [CARD_W],
    borders: { top: cardEdge, bottom: cardEdge, left: cardEdge, right: cardEdge, insideHorizontal: cardEdge, insideVertical: cardEdge },
    rows: [new TableRow({ children: [new TableCell({
      width: { size: CARD_W, type: WidthType.DXA },
      shading: { type: ShadingType.CLEAR, fill: cardFill, color: 'auto' },
      margins: { top: 230, bottom: 230, left: 270, right: 270 },
      children: cardChildren,
    })] })],
  }));

  // ── Date ────────────────────────────────────────────────────────────────────
  const date = todayLong();
  if (date) {
    out.push(new Paragraph({ spacing: { before: 280, after: 200 }, children: [run(date, { color: '374151', size: 20 })] }));
  }

  // ── Recipient block (company name bold + address split on newline/comma) ─────
  if (has(c.name) || has(c.address)) {
    if (has(c.name)) {
      out.push(new Paragraph({ spacing: { after: has(c.address) ? 10 : 60 }, children: [run(String(c.name), { bold: true, color: dark, size: 21 })] }));
    }
    if (has(c.address)) {
      const lines = [String(c.address).replace(/\s+/g, " ").trim()].filter(Boolean);
      lines.forEach((l, i) => out.push(new Paragraph({
        spacing: { after: i === lines.length - 1 ? 60 : 8, line: 264 },
        children: [run(l, { color: '4B5563', size: 20 })],
      })));
    }
  }

  // ── Salutation — added unless the body already opens with one (it never does;
  //    the AI prompt forbids it, mirroring the PDF's always-on salutation). ─────
  const bodyHtml = has(data.bodyHtml) ? String(data.bodyHtml) : '';
  const bodyPlain = bodyHtml.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').trim();
  if (bodyHtml && !/^(dear|hello|hi|to\s+whom|greetings)\b/i.test(bodyPlain)) {
    out.push(new Paragraph({ spacing: { before: 80, after: 160 }, children: [run('Dear Hiring Manager,', { color: dark, size: 21 })] }));
  }

  // ── Body — justified, friendly indigo letter. htmlToParagraphs handles <p>/<br>/<b>. ─
  if (bodyHtml) {
    htmlToParagraphs(bodyHtml, { size: 21, alignment: AlignmentType.JUSTIFIED })
      .forEach((p) => out.push(p));
  }

  // ── Closing + signature — always appended. The AI body never signs off; the PDF
  //    renders style.closing + name unconditionally, so we match it. ────────────
  out.push(new Paragraph({ spacing: { before: 200, after: has(s.name) ? 220 : 0 }, children: [run('Sincerely,', { color: '27313F', size: 21 })] }));
  if (has(s.name)) {
    out.push(new Paragraph({ children: [run(String(s.name), { bold: true, color: ink, size: 21 })] }));
  }

  return { children: out, margin: { top: M, right: M, bottom: M, left: M } };
};
