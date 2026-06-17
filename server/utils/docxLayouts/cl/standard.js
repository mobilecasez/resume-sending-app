// Cover-letter Word layout — Original (Branded) "standard". Mirrors the PDF
// (standardLetter in ../../coverLetterTemplates.js): a two-column letter with a DARK
// gradient sidebar on the left (circular initials avatar, then accent-barred TO / FROM /
// DATE label blocks in uppercase Poppins, white-bold values, and a muted email/location
// footer) and a white main column on the right (uppercase Poppins-bold name + applicant
// title over a right-aligned location/email block closed by a thin rule, a "Cover Letter"
// title, salutation, justified body, and an uppercase-name "Best regards," sign-off).
//
// Word can't do CSS gradients/round avatars, so the sidebar is a solid dark table cell
// and the avatar is a dark rounded-feel square with centred initials — the closest the
// .docx model allows while preserving the branded blue accent and TO/FROM/DATE structure.
//
// Contract: module.exports = function build(data, opts) -> { children, margin }
//   data = { sender:{name,title,email,phone,location}, company:{name,address}, bodyHtml }
//   opts = { accent }   accent: hex (with/without '#'); falls back to #3a6cb5
'use strict';

const H = require('../../docxHelpers');
const {
  Paragraph, Table, TableRow, TableCell, ImageRun,
  AlignmentType, TabStopType, BorderStyle, WidthType, ShadingType, VerticalAlign,
  has, hex, run, htmlToParagraphs, textOn, dataUriToImage, NO_BORDERS,
} = H;

const DEFAULT_ACCENT = '3A6CB5';
const SALUTATION = 'Dear Hiring Manager,';
const CLOSING = 'Best regards,';
const SIDEBAR = '1C2431';   // PDF sidebar gradient top (#1c2431 → #0d1014)
const AVATAR_BG = '2B3442';
const SIDE_VALUE = 'C8D0DA'; // muted body text in the sidebar
const SIDE_FOOT = '8B95A3';
const INK = '1A2230';        // PDF main ink (#1a2230)
const APPLICANT = '8A94A3';  // muted applicant / right-column text

function todayShort() {
  try { return new Date().toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' }); }
  catch (e) { return ''; }
}

// Does the (server-generated) body already open with a salutation / close with a sign-off?
function hasSalutation(html) {
  const t = H.stripTags(String(html || '')).trim().toLowerCase();
  return /^(dear\b|to whom|hello\b|hi\b|greetings\b)/.test(t);
}
function initials(name) {
  return String(name || '').split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
}

module.exports = function build(data, opts) {
  data = data || {};
  opts = opts || {};
  const s = data.sender || {};
  const c = data.company || {};
  const accent = has(opts.accent) ? hex(opts.accent) : DEFAULT_ACCENT;
  const onAccent = textOn(accent);

  // Full-bleed (like the azure resume): page margins are 0, so the dark sidebar
  // runs to the very left/right/top/bottom edges and fills the full page height.
  // Text is inset only via the table cells' inner padding.
  const SIDE_W = 3900;                 // ~33% sidebar
  const MAIN_W = H.PAGE_W - SIDE_W;

  // ── A small accent-barred label block (TO / FROM / DATE) for the sidebar ───────
  const labelBlock = (label, valueChildren) => {
    const out = [];
    out.push(new Paragraph({
      spacing: { after: 30 },
      children: [run(label, { bold: true, color: 'FFFFFF', size: 18, characterSpacing: 16, allCaps: true })],
    }));
    // Short accent underline bar beneath the label (the PDF's 22px × 2px accent dash).
    out.push(new Paragraph({
      spacing: { after: 50 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 16, color: accent, space: 1 } },
      indent: { right: 2200 },   // keep the rule short, like the 22px dash
      children: [run('', { size: 2 })],
    }));
    valueChildren.forEach((p) => out.push(p));
    return out;
  };

  // ── Sidebar contents ──────────────────────────────────────────────────────────
  const sideChildren = [];

  // Avatar: the user's photo when available (Word can't mask it round, so it's a
  // centred square image), otherwise a dark square with centred initials.
  const avatarImg = has(opts.photo) ? dataUriToImage(opts.photo) : null;
  if (avatarImg) {
    sideChildren.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 260 },
      children: [new ImageRun({ data: avatarImg.data, type: avatarImg.type, transformation: { width: 116, height: 116 } })],
    }));
  } else {
    const ini = initials(s.name);
    sideChildren.push(new Table({
      alignment: AlignmentType.CENTER,
      width: { size: 1180, type: WidthType.DXA }, columnWidths: [1180], borders: NO_BORDERS,
      rows: [new TableRow({ children: [new TableCell({
        width: { size: 1180, type: WidthType.DXA },
        shading: { type: ShadingType.CLEAR, color: 'auto', fill: AVATAR_BG },
        verticalAlign: VerticalAlign.CENTER,
        margins: { top: 200, bottom: 200, left: 40, right: 40 },
        children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [run(ini || '•', { bold: true, color: 'FFFFFF', size: 44 })] })],
      })] })],
    }));
    sideChildren.push(new Paragraph({ spacing: { after: 260 }, children: [run('', { size: 2 })] }));
  }

  // TO block — Hiring Manager + (optional) company name & address.
  const toValue = [];
  toValue.push(new Paragraph({ spacing: { after: has(c.name) || has(c.address) ? 4 : 0, line: 264 }, children: [run('Hiring Manager,', { color: SIDE_VALUE, size: 19 })] }));
  if (has(c.name)) toValue.push(new Paragraph({ spacing: { after: has(c.address) ? 4 : 0, line: 264 }, children: [run(String(c.name), { bold: true, color: 'FFFFFF', size: 19 })] }));
  if (has(c.address)) {
    const lines = [String(c.address).replace(/\s+/g, " ").trim()].filter(Boolean);
    lines.forEach((l, i) => toValue.push(new Paragraph({ spacing: { after: i === lines.length - 1 ? 0 : 2, line: 256 }, children: [run(l, { color: SIDE_VALUE, size: 18 })] })));
  }
  labelBlock('To', toValue).forEach((p) => sideChildren.push(p));
  sideChildren.push(new Paragraph({ spacing: { after: 220 }, children: [run('', { size: 2 })] }));

  // FROM block — sender name (bold white).
  if (has(s.name)) {
    labelBlock('From', [new Paragraph({ spacing: { line: 264 }, children: [run(String(s.name), { bold: true, color: 'FFFFFF', size: 19 })] })])
      .forEach((p) => sideChildren.push(p));
    sideChildren.push(new Paragraph({ spacing: { after: 220 }, children: [run('', { size: 2 })] }));
  }

  // DATE block.
  const dateShort = todayShort();
  if (dateShort) {
    labelBlock('Date', [new Paragraph({ children: [run(dateShort, { color: SIDE_VALUE, size: 19 })] })])
      .forEach((p) => sideChildren.push(p));
  }

  // Footer (email / location), pushed toward the bottom with a spacer.
  const footRows = [s.email, s.location].filter(has).map(String);
  if (footRows.length) {
    sideChildren.push(new Paragraph({ spacing: { before: 460, after: 0 }, children: [run('', { size: 2 })] }));
    footRows.forEach((f) => sideChildren.push(new Paragraph({ spacing: { after: 4, line: 248 }, children: [run(f, { color: SIDE_FOOT, size: 17 })] })));
  }

  // ── Main column contents ──────────────────────────────────────────────────────
  const mainChildren = [];

  // Top row: name (left, uppercase Poppins-bold) + applicant title; right-aligned
  // location/email column. Modelled with an inner borderless 2-col table.
  const topRight = [s.location, s.email].filter(has).map(String);
  const nameCell = [];
  if (has(s.name)) nameCell.push(new Paragraph({ spacing: { after: 2 }, children: [run(String(s.name), { bold: true, color: INK, size: 32, characterSpacing: 6, allCaps: true })] }));
  nameCell.push(new Paragraph({ spacing: { after: 0 }, children: [run(has(s.title) ? String(s.title) : 'Applicant', { color: APPLICANT, size: 18 })] }));
  const rightCell = topRight.length
    ? topRight.map((t, i) => new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { after: i === topRight.length - 1 ? 0 : 2, line: 264 }, children: [run(t, { color: APPLICANT, size: 17 })] }))
    : [new Paragraph({ children: [run('', { size: 2 })] })];

  mainChildren.push(new Table({
    layout: H.docx.TableLayoutType.FIXED,
    width: { size: MAIN_W - 700, type: WidthType.DXA }, columnWidths: [Math.round((MAIN_W - 700) * 0.6), Math.round((MAIN_W - 700) * 0.4)], borders: NO_BORDERS,
    rows: [new TableRow({ children: [
      new TableCell({ width: { size: Math.round((MAIN_W - 700) * 0.6), type: WidthType.DXA }, borders: NO_BORDERS, verticalAlign: VerticalAlign.BOTTOM, margins: { top: 0, bottom: 0, left: 0, right: 60 }, children: nameCell }),
      new TableCell({ width: { size: Math.round((MAIN_W - 700) * 0.4), type: WidthType.DXA }, borders: NO_BORDERS, verticalAlign: VerticalAlign.BOTTOM, margins: { top: 0, bottom: 0, left: 60, right: 0 }, children: rightCell }),
    ] })],
  }));

  // Thin light rule under the top row (PDF: 1px solid #e2e8f0).
  mainChildren.push(new Paragraph({
    spacing: { before: 60, after: 200 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'E2E8F0', space: 4 } },
    children: [run('', { size: 2 })],
  }));

  // "Cover Letter" title (Poppins-bold 13pt).
  mainChildren.push(new Paragraph({ spacing: { after: 160 }, children: [run('Cover Letter', { bold: true, color: INK, size: 26 })] }));

  // Salutation (only if the body doesn't already carry one).
  const bodyHtml = has(data.bodyHtml) ? String(data.bodyHtml) : '';
  if (!hasSalutation(bodyHtml)) {
    mainChildren.push(new Paragraph({ spacing: { after: 160 }, children: [run(SALUTATION, { color: '2B333B', size: 21 })] }));
  }

  // Body.
  if (bodyHtml) {
    htmlToParagraphs(bodyHtml, { size: 21, alignment: AlignmentType.LEFT, line: 276, after: 150 })
      .forEach((p) => mainChildren.push(p));
  }

  // Closing + uppercase-name signature — always appended. The AI body never carries
  // a sign-off (the prompt forbids it) and the PDF appends it unconditionally.
  mainChildren.push(new Paragraph({ spacing: { before: 200, after: has(s.name) ? 220 : 0 }, children: [run(CLOSING, { color: '2B333B', size: 21 })] }));
  if (has(s.name)) {
    mainChildren.push(new Paragraph({ children: [run(String(s.name), { bold: true, color: INK, size: 21, allCaps: true })] }));
  }

  if (!mainChildren.length) mainChildren.push(new Paragraph({ children: [run('', { size: 2 })] }));

  // ── Outer two-column table: dark sidebar | white main ────────────────────────
  const shell = new Table({
    layout: H.docx.TableLayoutType.FIXED,
    width: { size: H.PAGE_W, type: WidthType.DXA }, columnWidths: [SIDE_W, MAIN_W], borders: NO_BORDERS,
    rows: [new TableRow({
      height: { value: 16700, rule: H.HeightRule.ATLEAST },   // sidebar fills the full page height
      children: [
        new TableCell({
          width: { size: SIDE_W, type: WidthType.DXA }, borders: NO_BORDERS,
          shading: { type: ShadingType.CLEAR, color: 'auto', fill: SIDEBAR },
          verticalAlign: VerticalAlign.TOP,
          margins: { top: 640, bottom: 560, left: 460, right: 380 },
          children: sideChildren,
        }),
        new TableCell({
          width: { size: MAIN_W, type: WidthType.DXA }, borders: NO_BORDERS,
          shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'FFFFFF' },
          verticalAlign: VerticalAlign.TOP,
          margins: { top: 640, bottom: 560, left: 560, right: 460 },
          children: mainChildren,
        }),
      ],
    })],
  });

  // Full bleed: page margins 0 so the dark sidebar touches every edge; the table
  // row height carries the sidebar fill to the bottom of the page.
  return { children: [shell], margin: { top: 0, right: 0, bottom: 0, left: 0 } };
};
