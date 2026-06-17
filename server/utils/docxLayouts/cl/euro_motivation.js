// Cover-letter Word layout — European Motivation Letter (FR/ES/IT/EU).
// Mirrors the euro_motivation PDF (see ../../coverLetterTemplates.js STYLES.euro_motivation):
//   warm, elegant, serif-feel letter. Name LEFT in deep warm brown, title in the tan
//   accent with light letter-spacing, muted warm contact line, a thin tan hairline rule
//   under the header (the PDF's #c7b8a3 — a lightened accent), then date → recipient →
//   "Dear Hiring Manager," → justified body with generous leading → "Yours sincerely,".
//
// Contract: module.exports = function build(data, opts) -> { children, margin }
//   data = { sender:{name,title,email,phone,location}, company:{name,address}, bodyHtml }
//   opts = { accent }   accent: hex (with/without '#'); falls back to #8a7a5e
'use strict';

const H = require('../../docxHelpers');
const {
  Paragraph, AlignmentType, BorderStyle,
  has, hex, lighten, run, htmlToParagraphs,
} = H;

const SALUTATION = 'Dear Hiring Manager,';
const CLOSING = 'Yours sincerely,';

// Warm palette echoing the PDF: deep brown ink for the name, warm greys for body/meta.
const BROWN = '3B352C';   // .name colour in the PDF
const WARM_INK = '2E2A22';
const WARM_MUTED = '6B6354'; // .contact colour in the PDF
const ADDR = '5B5448';

function todayLong() {
  try { return new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }); }
  catch (e) { return ''; }
}

module.exports = function build(data, opts) {
  data = data || {};
  opts = opts || {};
  const s = data.sender || {};
  const c = data.company || {};
  const accent = has(opts.accent) ? hex(opts.accent) : '8A7A5E';

  // PDF rule colour #c7b8a3 is a lightened accent; reproduce generically from the accent.
  const ruleColor = lighten(accent, 0.45);

  const M = 1440;          // ~1in margins — clean one-page business letter
  const out = [];

  // ── Header — name LEFT, large, deep warm brown ──────────────────────────────
  if (has(s.name)) {
    out.push(new Paragraph({
      alignment: AlignmentType.LEFT,
      spacing: { after: has(s.title) ? 26 : 60 },
      children: [run(String(s.name), { bold: true, size: 40, color: BROWN, characterSpacing: 2 })],
    }));
  }

  // Title — in the tan accent with light tracking, evoking the elegant serif title.
  if (has(s.title)) {
    out.push(new Paragraph({
      alignment: AlignmentType.LEFT,
      spacing: { after: 60 },
      children: [run(String(s.title), { color: accent, size: 21, characterSpacing: 10 })],
    }));
  }

  // Contact line — muted warm grey, bullet-separated like the PDF.
  const contactParts = [s.email, s.phone, s.location].filter(has).map(String);
  if (contactParts.length) {
    out.push(new Paragraph({
      alignment: AlignmentType.LEFT,
      spacing: { after: 40 },
      children: [run(contactParts.join('   •   '), { color: WARM_MUTED, size: 19 })],
    }));
  }

  // Thin tan hairline rule under the header (the PDF's 1px #c7b8a3 border).
  out.push(new Paragraph({
    spacing: { after: 0 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: ruleColor, space: 4 } },
    children: [run('', { size: 2 })],
  }));

  // ── Date ────────────────────────────────────────────────────────────────────
  const date = todayLong();
  if (date) {
    out.push(new Paragraph({
      alignment: AlignmentType.LEFT,
      spacing: { before: 260, after: 200 },
      children: [run(date, { color: WARM_MUTED, size: 20 })],
    }));
  }

  // ── Recipient block — company name bold + address lines (split on \n / comma) ─
  if (has(c.name) || has(c.address)) {
    if (has(c.name)) {
      out.push(new Paragraph({
        spacing: { after: has(c.address) ? 10 : 60 },
        children: [run(String(c.name), { bold: true, color: BROWN, size: 21 })],
      }));
    }
    if (has(c.address)) {
      const lines = [String(c.address).replace(/\s+/g, " ").trim()].filter(Boolean);
      lines.forEach((l, i) => out.push(new Paragraph({
        spacing: { after: i === lines.length - 1 ? 60 : 8, line: 264 },
        children: [run(l, { color: ADDR, size: 20 })],
      })));
    }
  }

  // ── Body ────────────────────────────────────────────────────────────────────
  // The generated bodyHtml usually already carries its own salutation/closing.
  // Only synthesise our own when the body clearly lacks them.
  const bodyHtml = has(data.bodyHtml) ? String(data.bodyHtml) : '';
  const plain = bodyHtml.replace(/<[^>]+>/g, ' ');
  const hasSalutation = /\bdear\b|\bhello\b|\bhi\b|\bto whom\b/i.test(plain);

  if (!hasSalutation) {
    out.push(new Paragraph({
      spacing: { before: 80, after: 160 },
      children: [run(SALUTATION, { color: WARM_INK, size: 21 })],
    }));
  }

  if (bodyHtml) {
    const bodyParas = htmlToParagraphs(bodyHtml, { size: 21, alignment: AlignmentType.JUSTIFIED, line: 312, color: WARM_INK });
    bodyParas.forEach((p) => out.push(p));
  }

  // Closing + signature — always appended (the AI body never signs off; the PDF does too).
  out.push(new Paragraph({ spacing: { before: 200, after: 40 }, children: [run(CLOSING, { color: WARM_INK, size: 21 })] }));
  if (has(s.name)) {
    out.push(new Paragraph({ spacing: { before: 200 }, children: [run(String(s.name), { bold: true, color: BROWN, size: 21 })] }));
  }

  return { children: out, margin: { top: M, right: M, bottom: M, left: M } };
};
