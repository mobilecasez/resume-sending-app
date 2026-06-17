// Cover-letter Word layout — Executive Leadership. Mirrors the PDF (STYLES.exec_leader
// in ../../coverLetterTemplates.js): a premium, CENTERED letterhead with an uppercase
// letter-spaced serif name, an uppercase gold sub-title, a muted contact line, and a
// thick gold accent rule underneath. Body is justified with generous line-height, and
// the letter closes "Respectfully," — refined, formal, executive.
//
// Contract: module.exports = function build(data, opts) -> { children, margin }
//   data = { sender:{name,title,email,phone,location}, company:{name,address}, bodyHtml }
//   opts = { accent }   accent: hex (with/without '#'); falls back to #b8995a
'use strict';

const H = require('../../docxHelpers');
const {
  Paragraph, AlignmentType, BorderStyle,
  MUTED, has, hex, run, htmlToParagraphs,
} = H;

const DEFAULT_ACCENT = 'B8995A';
const SALUTATION = 'Dear Hiring Manager,';
const CLOSING = 'Respectfully,';
const DARK = '1E293B';   // slate name
const GOLD_TITLE = '7C6A45';
const CONTACT = '5B6473';

function todayLong() {
  try { return new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }); }
  catch (e) { return ''; }
}

// Does the body text already open with a salutation?
function hasSalutation(html) {
  const t = H.stripTags(String(html || '')).trim().toLowerCase();
  return /^(dear\b|to whom|hello\b|hi\b|greetings\b)/.test(t);
}

module.exports = function build(data, opts) {
  data = data || {};
  opts = opts || {};
  const s = data.sender || {};
  const c = data.company || {};
  const accent = has(opts.accent) ? hex(opts.accent) : DEFAULT_ACCENT;

  const M = 1440; // ~1in margins
  const out = [];
  const CENTER = AlignmentType.CENTER;

  // ── Letterhead (centered, premium) ──────────────────────────────────────────
  if (has(s.name)) {
    out.push(new Paragraph({
      alignment: CENTER,
      spacing: { after: has(s.title) ? 30 : 70 },
      children: [run(String(s.name), { bold: true, color: DARK, size: 40, characterSpacing: 30, allCaps: true })],
    }));
  }

  if (has(s.title)) {
    out.push(new Paragraph({
      alignment: CENTER,
      spacing: { after: 60 },
      children: [run(String(s.title), { color: GOLD_TITLE, size: 19, characterSpacing: 20, allCaps: true })],
    }));
  }

  const contactLine = [s.email, s.phone, s.location].filter(has).map(String).join('   •   ');
  if (contactLine) {
    out.push(new Paragraph({
      alignment: CENTER,
      spacing: { after: 70 },
      children: [run(contactLine, { color: CONTACT, size: 19 })],
    }));
  }

  // Thick gold accent rule under the header (mirrors the 2px #b8995a border).
  out.push(new Paragraph({
    alignment: CENTER,
    spacing: { after: 0 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: accent, space: 4 } },
    children: [run('', { size: 2 })],
  }));

  // ── Date ─────────────────────────────────────────────────────────────────────
  const date = todayLong();
  if (date) {
    out.push(new Paragraph({
      spacing: { before: 280, after: 200 },
      children: [run(date, { color: '374151', size: 20 })],
    }));
  }

  // ── Recipient block ──────────────────────────────────────────────────────────
  if (has(c.name) || has(c.address)) {
    if (has(c.name)) {
      out.push(new Paragraph({
        spacing: { after: has(c.address) ? 10 : 60 },
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

  // ── Salutation (only if the body doesn't already carry one) ──────────────────
  const bodyHtml = has(data.bodyHtml) ? String(data.bodyHtml) : '';
  if (!hasSalutation(bodyHtml)) {
    out.push(new Paragraph({
      spacing: { before: 80, after: 160 },
      children: [run(SALUTATION, { color: '1F2937', size: 21 })],
    }));
  }

  // ── Body (justified, generous line-height to echo the serif PDF feel) ────────
  if (bodyHtml) {
    htmlToParagraphs(bodyHtml, { size: 21, alignment: AlignmentType.JUSTIFIED, line: 300, after: 180 })
      .forEach((p) => out.push(p));
  }

  // ── Closing + signature — always appended (the AI body never signs off; the PDF
  //    appends it unconditionally) ─────────────────────────────────────────────
  out.push(new Paragraph({
    spacing: { before: 160, after: has(s.name) ? 220 : 0 },
    children: [run(CLOSING, { color: '27313F', size: 21 })],
  }));
  if (has(s.name)) {
    out.push(new Paragraph({
      children: [run(String(s.name), { bold: true, color: '111827', size: 21 })],
    }));
  }

  return { children: out, margin: { top: M, right: M, bottom: M, left: M } };
};
