// Resume Word layout — India Professional (IN/BD/NP/LK). Mirrors the PDF (`indiaPro`):
// single-column ATS-friendly sheet, NO sidebar, NO photo. Header has a thick accent
// vertical bar on the left, then name (dark) + title (accent) + inline contact (muted).
// Section headings are uppercase accent text trailed by a thin hairline rule. Skills
// render as cyan "chips". Experience/Projects/Education use a right-aligned accent date
// and diamond (rotated-square) accent bullet markers.
//
// Contract: module.exports = function build(d, opts, accent) -> { children, margin }
//   d      : resume_data { personal_info, summary, experience[], education[],
//            projects[], skills{technical[],soft[]}, languages[], certifications[], achievements[] }
//   opts   : { photo?, photoRect? }  (unused — this PDF design shows no photo)
//   accent : hex string (no '#'), e.g. '0e7490'
'use strict';

const H = require('../../docxHelpers');
const {
  Paragraph, TextRun, Table, TableRow, TableCell, ImageRun,
  AlignmentType, TabStopType, BorderStyle, WidthType, VerticalAlign, ShadingType,
  PAGE_W, MUTED, INK, has, arr, run, bullet, inlineRuns, lighten, darken, textOn, NO_BORDERS,
} = H;

module.exports = function build(d, opts, accent) {
  const pi = d.personal_info || {};
  const M = 1080;                       // ~0.75in side margins (single column)
  const RIGHT_TAB = PAGE_W - M - M;      // right edge of the content column
  const dark = '0F172A';                 // name ink (slate-900)
  const slate = '475569';                // contact muted (slate-600)
  const co = '64748B';                   // company/sub muted (slate-500)
  const body = '334155';                 // body text (slate-700)
  const hair = 'E2E8F0';                 // hairline after section headings
  const chipFill = lighten(accent, 0.9); // light cyan chip background (≈ #ecfeff)
  const chipText = darken(accent, 0.05); // chip / accent text

  const out = [];

  // ── HEADER : accent left-bar + name / title / inline contact ─────────────────
  const name = has(pi.full_name) ? String(pi.full_name) : 'Your Name';
  const title = has(pi.title)
    ? String(pi.title)
    : ((arr(d.experience)[0] || {}).role || '');
  const contactBits = [
    has(pi.email) && String(pi.email),
    has(pi.phone) && String(pi.phone),
    has(pi.location) && String(pi.location),
    has(pi.linkedin_url) && prettyUrl(pi.linkedin_url),
    has(pi.portfolio_url) && prettyUrl(pi.portfolio_url),
  ].filter(Boolean);

  const headChildren = [
    new Paragraph({ spacing: { after: 20 }, children: [run(name, { bold: true, size: 40, color: dark })] }),
  ];
  if (has(title)) headChildren.push(new Paragraph({ spacing: { after: contactBits.length ? 50 : 0 }, children: [run(String(title), { bold: true, color: chipText, size: 21 })] }));
  if (contactBits.length) headChildren.push(new Paragraph({ spacing: { after: 0, line: 250 }, children: [run(contactBits.join('   •   '), { color: slate, size: 18 })] }));

  // A 1-row, 2-col borderless table: a thin accent-filled bar cell, then the text.
  const accentBar = { left: { style: BorderStyle.SINGLE, size: 30, color: accent }, top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } };
  out.push(new Table({
    width: { size: RIGHT_TAB, type: WidthType.DXA }, columnWidths: [70, RIGHT_TAB - 70], borders: NO_BORDERS,
    rows: [new TableRow({ children: [
      new TableCell({ width: { size: 70, type: WidthType.DXA }, borders: accentBar, shading: { type: ShadingType.CLEAR, fill: accent, color: 'auto' }, children: [new Paragraph({ children: [run('', { size: 2 })] })] }),
      new TableCell({ width: { size: RIGHT_TAB - 70, type: WidthType.DXA }, borders: NO_BORDERS, margins: { left: 200, top: 0, bottom: 0, right: 0 }, verticalAlign: VerticalAlign.TOP, children: headChildren }),
    ] })],
  }));
  out.push(new Paragraph({ spacing: { before: 60, after: 0 }, children: [run('', { size: 2 })] }));

  // ── Section heading: uppercase accent text + trailing hairline rule ───────────
  const heading = (label) => new Paragraph({
    spacing: { before: 230, after: 90 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: hair, space: 3 } },
    children: [run(String(label).toUpperCase(), { bold: true, color: chipText, size: 21, characterSpacing: 10 })],
  });

  // Diamond (rotated-square) bullet, accent-coloured, to match the PDF markers.
  const diamond = (text, o = {}) => new Paragraph({
    spacing: { after: 36, line: 264 },
    indent: { left: 230, hanging: 170 },
    tabStops: [{ type: TabStopType.LEFT, position: 230 }],
    children: [run('◆ ', { color: chipText, size: 15 }), ...inlineRuns(text, { size: o.size || 20, color: body })],
  });

  // ── SUMMARY ──────────────────────────────────────────────────────────────────
  if (has(d.summary)) {
    out.push(heading('Summary'));
    // Split AI summary into paragraph(s) + leading-• bullets.
    const lines = String(d.summary).split('\n').map((l) => l.trim()).filter(Boolean);
    const paras = lines.filter((l) => !l.startsWith('•'));
    const bullets = lines.filter((l) => l.startsWith('•')).map((l) => l.replace(/^•\s*/, ''));
    if (!paras.length && !bullets.length) paras.push(String(d.summary));
    paras.forEach((p) => out.push(new Paragraph({ spacing: { after: 40, line: 276 }, alignment: AlignmentType.JUSTIFIED, children: inlineRuns(p, { size: 20, color: body }) })));
    bullets.forEach((b) => out.push(diamond(b)));
  }

  // ── TECHNICAL SKILLS — chips ─────────────────────────────────────────────────
  const tech = arr(d.skills && d.skills.technical);
  if (tech.length) {
    out.push(heading('Technical Skills'));
    out.push(chipRow(tech, { chipFill, chipText, accent }));
  }

  // ── PROFESSIONAL EXPERIENCE ──────────────────────────────────────────────────
  const exp = arr(d.experience);
  if (exp.length) {
    out.push(heading('Professional Experience'));
    exp.forEach((e) => {
      const dates = [e.start_date, e.end_date].filter(has).map(String).join(' – ');
      out.push(new Paragraph({
        spacing: { before: 120, after: 0 },
        tabStops: [{ type: TabStopType.RIGHT, position: RIGHT_TAB }],
        children: [run(e.role || 'Role', { bold: true, size: 21, color: dark }), run(dates ? '\t' + dates : '', { bold: true, color: chipText, size: 18 })],
      }));
      const meta = [e.company, e.location].filter(has).map(String).join(', ');
      if (meta) out.push(new Paragraph({ spacing: { after: 30 }, children: [run(meta, { color: co, italics: true, size: 19 })] }));
      arr(e.highlights).forEach((h) => out.push(diamond(h)));
    });
  }

  // ── PROJECTS ─────────────────────────────────────────────────────────────────
  const proj = arr(d.projects);
  if (proj.length) {
    out.push(heading('Projects'));
    proj.forEach((p) => {
      const t = [has(p.title) ? String(p.title) : '', has(p.type) ? '— ' + String(p.type) : ''].filter(Boolean).join(' ');
      out.push(new Paragraph({
        spacing: { before: 110, after: 0 },
        tabStops: [{ type: TabStopType.RIGHT, position: RIGHT_TAB }],
        children: [run(t || 'Project', { bold: true, size: 21, color: dark }), run(has(p.role) ? '\t' + String(p.role) : '', { bold: true, color: chipText, size: 18 })],
      }));
      const about = p.about || p.description;
      if (has(about)) out.push(new Paragraph({ spacing: { after: 30, line: 264 }, children: inlineRuns(String(about), { size: 19, color: slate }) }));
      arr(p.role_highlights).forEach((h) => out.push(diamond(h)));
    });
  }

  // ── CERTIFICATIONS ───────────────────────────────────────────────────────────
  const certs = arr(d.certifications);
  if (certs.length) {
    out.push(heading('Certifications'));
    certs.forEach((c) => {
      const cn = (c && typeof c === 'object') ? (c.name || c.title || '') : String(c);
      const sub = (c && typeof c === 'object') ? [c.issuer || c.authority, c.year || c.date].filter(has).map(String).join(' · ') : '';
      if (!has(cn)) return;
      out.push(new Paragraph({
        spacing: { after: 36, line: 264 }, indent: { left: 230, hanging: 170 },
        children: [run('◆ ', { color: chipText, size: 15 }), run(String(cn), { size: 20, color: body }), has(sub) ? run('  —  ' + sub, { size: 19, color: co }) : run('')],
      }));
    });
  }

  // ── EDUCATION ────────────────────────────────────────────────────────────────
  const edu = arr(d.education);
  if (edu.length) {
    out.push(heading('Education'));
    edu.forEach((e) => {
      const deg = [e.degree, e.field_of_study].filter(has).map(String).join(', ');
      out.push(new Paragraph({
        spacing: { before: 110, after: 0 },
        tabStops: [{ type: TabStopType.RIGHT, position: RIGHT_TAB }],
        children: [run(deg || e.degree || 'Education', { bold: true, size: 21, color: dark }), run(has(e.end_date) ? '\t' + String(e.end_date) : '', { bold: true, color: chipText, size: 18 })],
      }));
      const sub = [e.institution, has(e.grade) ? 'Grade: ' + String(e.grade) : ''].filter((x) => has(x)).join('  ·  ');
      if (sub) out.push(new Paragraph({ spacing: { after: 20 }, children: [run(sub, { color: co, size: 19 })] }));
    });
  }

  // ── ACHIEVEMENTS ─────────────────────────────────────────────────────────────
  const ach = arr(d.achievements);
  if (ach.length) {
    out.push(heading('Achievements'));
    ach.forEach((a) => out.push(diamond(a)));
  }

  // If nothing was emitted (empty data) keep at least the header so the doc is valid.
  return { children: out, margin: { top: M, right: M, bottom: M, left: M } };

  // ── helpers ────────────────────────────────────────────────────────────────
  function prettyUrl(u) {
    return String(u == null ? '' : u).replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '').trim();
  }

  // Skills as wrapping "chips": a borderless table whose cells are shaded pill-like
  // boxes. docx has no flex-wrap, so we lay chips into rows of N with a thin gap.
  function chipRow(items, c) {
    const PER_ROW = 4;
    const GAP = 90;
    const colW = Math.floor((RIGHT_TAB - GAP * (PER_ROW - 1)) / PER_ROW);
    const chipBorders = {
      top: { style: BorderStyle.SINGLE, size: 4, color: c.accent },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: c.accent },
      left: { style: BorderStyle.SINGLE, size: 4, color: c.accent },
      right: { style: BorderStyle.SINGLE, size: 4, color: c.accent },
    };
    const rows = [];
    for (let i = 0; i < items.length; i += PER_ROW) {
      const slice = items.slice(i, i + PER_ROW);
      const cells = [];
      for (let j = 0; j < PER_ROW; j++) {
        const txt = slice[j];
        if (txt != null) {
          cells.push(new TableCell({
            width: { size: colW, type: WidthType.DXA }, borders: chipBorders,
            shading: { type: ShadingType.CLEAR, fill: c.chipFill, color: 'auto' },
            margins: { top: 30, bottom: 30, left: 90, right: 90 }, verticalAlign: VerticalAlign.CENTER,
            children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [run(String(txt), { bold: true, color: c.chipText, size: 18 })] })],
          }));
        } else {
          cells.push(new TableCell({ width: { size: colW, type: WidthType.DXA }, borders: NO_BORDERS, children: [new Paragraph({ children: [run('', { size: 2 })] })] }));
        }
        if (j < PER_ROW - 1) cells.push(new TableCell({ width: { size: GAP, type: WidthType.DXA }, borders: NO_BORDERS, children: [new Paragraph({ children: [run('', { size: 2 })] })] }));
      }
      rows.push(new TableRow({ children: cells }));
      if (i + PER_ROW < items.length) {
        // spacer row for vertical gap between chip rows
        const spacer = [];
        for (let k = 0; k < PER_ROW * 2 - 1; k++) spacer.push(new TableCell({ borders: NO_BORDERS, children: [new Paragraph({ spacing: { after: 0 }, children: [run('', { size: 6 })] })] }));
        rows.push(new TableRow({ children: spacer }));
      }
    }
    const colWidths = [];
    for (let j = 0; j < PER_ROW; j++) { colWidths.push(colW); if (j < PER_ROW - 1) colWidths.push(GAP); }
    return new Table({ width: { size: RIGHT_TAB, type: WidthType.DXA }, columnWidths: colWidths, borders: NO_BORDERS, rows });
  }
};
