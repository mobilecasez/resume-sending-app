// Resume Word layout — Modern Minimal. Mirrors the PDF `minimal` template:
//   • White header BAND with an accent vertical stripe on the left edge, holding the
//     name (last name in accent) + uppercase spaced role + contacts row, and a
//     CIRCULAR accent-bordered photo on the right.
//   • Two-column body: a wider MAIN column (Profile, Experience with accent date
//     "pills", Key Projects) and a light-tinted SIDE column with a left divider
//     (Expertise + Tools chips, Strengths, Education year/grade pills, plus
//     Languages / Certifications / Achievements so no data is lost).
//   • Accent is used for the stripe, name highlight, section headings, diamond
//     bullets, date pills, chips and the photo ring.
//
// Contract: module.exports = function build(d, opts, accent) -> { children, margin }
'use strict';

const H = require('../../docxHelpers');
const {
  Paragraph, TextRun, Table, TableRow, TableCell, ImageRun,
  AlignmentType, TabStopType, BorderStyle, WidthType, VerticalAlign, ShadingType, HeightRule,
  PAGE_W, MUTED, INK, has, arr, run, sectionHeading, inlineRuns, dataUriToImage,
  NO_BORDERS, textOn, lighten, darken, hex,
} = H;

module.exports = function build(d, opts, accent) {
  const A = hex(accent);
  const A_DARK = darken(A, 0.22);          // teal-d for headings
  const A_SOFT = lighten(A, 0.86);         // soft teal chip fill / photo bg
  const A_LINE = lighten(A, 0.7);          // faint chip border / pill bg
  const ON_A = textOn(A);                  // contrast text on the accent fill
  const INKM = '222B30', MUTE = '707B84', SUB = '49545D', LINE = 'E8ECEF', SIDEBG = 'F6F8F9';

  const pi = d.personal_info || {};
  const fullName = has(pi.full_name) ? String(pi.full_name).trim() : 'Your Name';
  const parts = fullName.split(/\s+/);
  const first = parts.shift() || fullName;
  const rest = parts.join(' ');
  const role = has(pi.title) ? pi.title : ((arr(d.experience)[0] || {}).role || 'Professional');

  const prettyUrl = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');

  // Page geometry: full-bleed sides so the side column tint + stripe reach the edges.
  const M = 0;                               // page margin (we inset via cell margins)
  const INSET_L = 620, INSET_R = 620;        // content inset inside the page
  const CONTENT_W = PAGE_W;                  // tables span the full page
  const STRIPE_W = 110;                      // accent vertical stripe width
  const PHOTO_W = 1700;                      // header photo cell

  // ── HEADER BAND ──────────────────────────────────────────────────────────────
  const img = opts.photo ? dataUriToImage(opts.photo) : (opts.photoRect ? dataUriToImage(opts.photoRect) : null);

  const nameRuns = [run(first + (rest ? ' ' : ''), { bold: true, size: 40, color: INKM })];
  if (rest) nameRuns.push(run(rest, { bold: true, size: 40, color: A }));
  const headTextChildren = [
    new Paragraph({ spacing: { after: 70 }, children: nameRuns }),
    new Paragraph({ spacing: { after: has(role) ? 130 : 0 }, children: [run(String(role).toUpperCase(), { size: 18, color: MUTE, characterSpacing: 40 })] }),
  ];
  const contacts = [
    has(pi.phone) && pi.phone,
    has(pi.email) && pi.email,
    has(pi.location) && pi.location,
    has(pi.linkedin_url) && prettyUrl(pi.linkedin_url),
    has(pi.portfolio_url) && prettyUrl(pi.portfolio_url),
  ].filter(Boolean).map(String);
  if (contacts.length) {
    headTextChildren.push(new Paragraph({ spacing: { after: 0, line: 252 }, children: [run(contacts.join('     •     '), { size: 18, color: '4B565F' })] }));
  }

  // Circular-ish photo: ImageRun (square) in an accent-ringed, soft-bg cell.
  const photoRing = {
    top: { style: BorderStyle.SINGLE, size: 12, color: A },
    bottom: { style: BorderStyle.SINGLE, size: 12, color: A },
    left: { style: BorderStyle.SINGLE, size: 12, color: A },
    right: { style: BorderStyle.SINGLE, size: 12, color: A },
  };
  const photoChildren = img
    ? [new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ data: img.data, type: img.type, transformation: { width: 96, height: 96 } })] })]
    : [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 360, after: 360 }, children: [run((first[0] || '') + (rest[0] || ''), { bold: true, size: 44, color: A })] })];

  const headerTable = new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: [STRIPE_W, CONTENT_W - STRIPE_W - PHOTO_W, PHOTO_W],
    borders: NO_BORDERS,
    rows: [new TableRow({ children: [
      new TableCell({ width: { size: STRIPE_W, type: WidthType.DXA }, shading: { type: ShadingType.CLEAR, fill: A }, margins: { top: 0, bottom: 0, left: 0, right: 0 }, children: [new Paragraph({ spacing: { after: 0 }, children: [run('', { size: 2 })] })] }),
      new TableCell({ width: { size: CONTENT_W - STRIPE_W - PHOTO_W, type: WidthType.DXA }, borders: NO_BORDERS, verticalAlign: VerticalAlign.CENTER, margins: { top: 360, bottom: 300, left: INSET_L, right: 200 }, children: headTextChildren }),
      new TableCell({ width: { size: PHOTO_W, type: WidthType.DXA }, borders: photoRing, shading: { type: ShadingType.CLEAR, fill: A_SOFT }, verticalAlign: VerticalAlign.CENTER, margins: { top: 70, bottom: 70, left: 70, right: 70 }, children: photoChildren }),
    ] })],
  });

  // ── SHARED SECTION BUILDERS ──────────────────────────────────────────────────
  // Section heading: uppercase, spaced, accent-dark, thin bottom rule (like h3::after).
  const head = (title) => sectionHeading(title, accent, { color: A_DARK, size: 19, tracking: 30, before: 0, after: 110, ruleColor: LINE, ruleSize: 4 });

  // Diamond-ish accent bullet line (PDF uses a rotated square marker).
  const dia = (text, o = {}) => new Paragraph({
    spacing: { after: 36, line: 264 }, indent: { left: 200, hanging: 200 },
    children: [run('▪  ', { color: A, size: o.size || 19 }), ...inlineRuns(text, { size: o.size || 19, color: SUB })],
  });

  // Chip grid: rounded pills as a borderless table of shaded cells, wrapping per row.
  const chipGrid = (items, opts2 = {}) => {
    const perRow = opts2.perRow || 3, colW = Math.floor((opts2.width || 3600) / perRow);
    const fill = opts2.fill || 'FFFFFF', brdColor = opts2.border, txtColor = opts2.color || A_DARK;
    const rows = [];
    for (let i = 0; i < items.length; i += perRow) {
      const slice = items.slice(i, i + perRow);
      const cells = [];
      for (let j = 0; j < perRow; j++) {
        const txt = slice[j];
        const has2 = txt != null;
        const brd = (has2 && brdColor) ? {
          top: { style: BorderStyle.SINGLE, size: 4, color: brdColor }, bottom: { style: BorderStyle.SINGLE, size: 4, color: brdColor },
          left: { style: BorderStyle.SINGLE, size: 4, color: brdColor }, right: { style: BorderStyle.SINGLE, size: 4, color: brdColor },
        } : NO_BORDERS;
        cells.push(new TableCell({
          width: { size: colW, type: WidthType.DXA }, borders: brd,
          shading: has2 ? { type: ShadingType.CLEAR, fill } : undefined,
          margins: { top: 36, bottom: 36, left: 90, right: 90 },
          children: [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 0 }, children: [run(has2 ? String(txt) : '', { size: 16, bold: true, color: has2 ? txtColor : 'FFFFFF' })] })],
        }));
      }
      rows.push(new TableRow({ children: cells }));
    }
    // Wrap each chip-row inside a spacer so adjacent rows have a small gap.
    return new Table({ width: { size: opts2.width || 3600, type: WidthType.DXA }, columnWidths: Array(perRow).fill(colW), borders: NO_BORDERS, rows });
  };

  // Small rounded year/grade pill paragraph (Education).
  const yearPill = (label) => new TableCell({
    width: { size: 1100, type: WidthType.DXA }, shading: { type: ShadingType.CLEAR, fill: A_SOFT }, borders: NO_BORDERS,
    margins: { top: 24, bottom: 24, left: 70, right: 70 },
    children: [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 0 }, children: [run(String(label), { size: 15, bold: true, color: A_DARK })] })],
  });

  // ── MAIN COLUMN ──────────────────────────────────────────────────────────────
  const MAIN_W = 6600, SIDE_W = CONTENT_W - MAIN_W;     // ~ 1fr + 70mm
  const MAIN_INNER = MAIN_W - INSET_L - 200;            // usable text width for tab stops
  const MAIN_TAB = MAIN_INNER;
  const main = [];

  const sumLines = String(d.summary || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const sumParas = sumLines.filter((l) => !l.startsWith('•'));
  const sumBullets = sumLines.filter((l) => l.startsWith('•')).map((l) => l.replace(/^•\s*/, ''));
  if (sumParas.length || sumBullets.length) {
    main.push(head('Profile'));
    sumParas.forEach((p) => main.push(new Paragraph({ spacing: { after: 60, line: 272 }, children: inlineRuns(p, { size: 19, color: SUB }) })));
    sumBullets.forEach((b) => main.push(dia(b)));
  }

  const exp = arr(d.experience);
  if (exp.length) {
    main.push(head('Experience'));
    exp.forEach((e) => {
      const dates = [e.start_date, e.end_date].filter(has).map(String).join(' – ').toUpperCase();
      // Role + accent date "pill" right-aligned in a borderless row.
      main.push(new Table({
        width: { size: MAIN_INNER, type: WidthType.DXA }, columnWidths: [MAIN_INNER - 1700, 1700], borders: NO_BORDERS,
        rows: [new TableRow({ children: [
          new TableCell({ width: { size: MAIN_INNER - 1700, type: WidthType.DXA }, borders: NO_BORDERS, verticalAlign: VerticalAlign.CENTER, margins: { top: 110, bottom: 0, left: 0, right: 60 }, children: [new Paragraph({ spacing: { after: 0 }, children: [run(e.role || 'Role', { bold: true, size: 21, color: INKM })] })] }),
          dates
            ? new TableCell({ width: { size: 1700, type: WidthType.DXA }, borders: NO_BORDERS, verticalAlign: VerticalAlign.CENTER, margins: { top: 110, bottom: 0, left: 0, right: 0 }, children: [new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { after: 0 }, children: [new TextRun({ text: ' ' + dates + ' ', bold: true, size: 15, color: ON_A, font: 'Calibri', shading: { type: ShadingType.CLEAR, fill: A } })] })] })
            : new TableCell({ width: { size: 1700, type: WidthType.DXA }, borders: NO_BORDERS, children: [new Paragraph({ children: [run('')] })] }),
        ] })],
      }));
      const co = [e.company, e.location].filter(has).map(String).join(' · ');
      if (co) main.push(new Paragraph({ spacing: { before: 24, after: 50 }, children: [run(co, { italics: true, size: 18, color: MUTE })] }));
      arr(e.highlights).forEach((h) => main.push(dia(h, { size: 18 })));
      main.push(new Paragraph({ spacing: { after: 60 }, children: [run('', { size: 2 })] }));
    });
  }

  const proj = arr(d.projects);
  if (proj.length) {
    main.push(head('Key Projects'));
    proj.forEach((p) => {
      if (has(p.role)) main.push(new Paragraph({ spacing: { before: 90, after: 0 }, children: [run(String(p.role).toUpperCase(), { bold: true, size: 15, color: A, characterSpacing: 20 })] }));
      const title = [has(p.title) && p.title, has(p.type) && p.type].filter(Boolean).map(String).join(' — ');
      if (title) main.push(new Paragraph({ spacing: { before: has(p.role) ? 16 : 90, after: 0 }, children: [run(title, { bold: true, size: 19, color: INKM })] }));
      const about = p.about || p.description;
      if (has(about)) main.push(new Paragraph({ spacing: { before: 24, after: 30, line: 256 }, children: inlineRuns(about, { size: 18, color: '56616C' }) }));
      arr(p.role_highlights).forEach((h) => main.push(dia(h, { size: 18 })));
    });
  }

  if (!main.length) main.push(new Paragraph({ children: [run('')] }));

  // ── SIDE COLUMN ──────────────────────────────────────────────────────────────
  const SIDE_INNER = SIDE_W - 520 - 480;     // usable width inside side-cell margins
  const side = [];
  const tech = arr(d.skills && d.skills.technical);
  const soft = arr(d.skills && d.skills.soft).slice(0, 7);
  const half = Math.ceil(tech.length / 2);
  const expertise = tech.slice(0, half), tools = tech.slice(half);

  if (expertise.length) {
    side.push(head('Expertise'));
    side.push(chipGrid(expertise.map(String), { perRow: 2, width: SIDE_INNER, fill: 'FFFFFF', border: A_LINE, color: A_DARK }));
    side.push(new Paragraph({ spacing: { after: 120 }, children: [run('', { size: 2 })] }));
  }
  if (tools.length) {
    side.push(head('Tools & Methods'));
    side.push(chipGrid(tools.map(String), { perRow: 2, width: SIDE_INNER, fill: A_SOFT, color: A_DARK }));
    side.push(new Paragraph({ spacing: { after: 120 }, children: [run('', { size: 2 })] }));
  }
  if (soft.length) {
    side.push(head('Strengths'));
    soft.forEach((s) => side.push(new Paragraph({ spacing: { after: 56, line: 252 }, indent: { left: 180, hanging: 180 }, children: [run('✓  ', { color: A, size: 18, bold: true }), run(String(s), { size: 18, color: '3F4A52' })] })));
    side.push(new Paragraph({ spacing: { after: 60 }, children: [run('', { size: 2 })] }));
  }

  const edu = arr(d.education);
  if (edu.length) {
    side.push(head('Education'));
    edu.forEach((e) => {
      const deg = [e.degree, e.field_of_study].filter(has).map(String).join(' — ');
      side.push(new Paragraph({ spacing: { before: 60, after: 0, line: 248 }, children: [run(deg || e.degree || 'Education', { bold: true, size: 17, color: INKM })] }));
      if (has(e.institution)) side.push(new Paragraph({ spacing: { after: 30 }, children: [run(String(e.institution), { size: 16, color: MUTE })] }));
      const pills = [has(e.end_date) && e.end_date, has(e.grade) && e.grade].filter(Boolean).map(String);
      if (pills.length) {
        const cells = pills.map(yearPill);
        cells.push(new TableCell({ width: { size: Math.max(200, SIDE_INNER - pills.length * 1100), type: WidthType.DXA }, borders: NO_BORDERS, children: [new Paragraph({ children: [run('')] })] }));
        side.push(new Table({ width: { size: SIDE_INNER, type: WidthType.DXA }, borders: NO_BORDERS, rows: [new TableRow({ children: cells })] }));
      }
      side.push(new Paragraph({ spacing: { after: 70 }, children: [run('', { size: 2 })] }));
    });
  }

  // Extra data the PDF model carries — kept in the side column's design language.
  const langs = arr(d.languages);
  if (langs.length) {
    side.push(head('Languages'));
    langs.forEach((l) => {
      const name = (l && typeof l === 'object') ? (l.name || l.language || '') : String(l);
      const lvl = (l && typeof l === 'object') ? (l.level || l.proficiency || '') : '';
      if (!String(name).trim()) return;
      side.push(new Paragraph({ spacing: { after: 30 }, tabStops: [{ type: TabStopType.RIGHT, position: SIDE_INNER }], children: [run(String(name), { size: 17, color: INKM }), run(has(lvl) ? '\t' + lvl : '', { size: 16, color: A_DARK, bold: true })] }));
    });
    side.push(new Paragraph({ spacing: { after: 60 }, children: [run('', { size: 2 })] }));
  }

  const certs = arr(d.certifications);
  if (certs.length) {
    side.push(head('Certifications'));
    certs.forEach((c) => {
      const name = (c && typeof c === 'object') ? (c.name || c.title || '') : String(c);
      const sub = (c && typeof c === 'object') ? [c.issuer || c.authority, c.year || c.date].filter(has).map(String).join(' · ') : '';
      if (!String(name).trim()) return;
      side.push(new Paragraph({ spacing: { after: 0, line: 248 }, indent: { left: 180, hanging: 180 }, children: [run('▪  ', { color: A, size: 17 }), run(String(name), { size: 17, color: INKM, bold: true })] }));
      if (sub) side.push(new Paragraph({ spacing: { after: 50 }, indent: { left: 180 }, children: [run(sub, { size: 15, color: MUTE })] }));
    });
    side.push(new Paragraph({ spacing: { after: 60 }, children: [run('', { size: 2 })] }));
  }

  const ach = arr(d.achievements);
  if (ach.length) {
    side.push(head('Achievements'));
    ach.forEach((a) => side.push(new Paragraph({ spacing: { after: 48, line: 248 }, indent: { left: 180, hanging: 180 }, children: [run('▪  ', { color: A, size: 17 }), run(String(a), { size: 16, color: '3F4A52' })] })));
  }

  if (!side.length) side.push(new Paragraph({ children: [run('')] }));

  // ── BODY: two-column table ───────────────────────────────────────────────────
  const sideBorder = {
    top: NO_BORDERS.top, bottom: NO_BORDERS.bottom, right: NO_BORDERS.right,
    left: { style: BorderStyle.SINGLE, size: 4, color: LINE },
  };
  const bodyTable = new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: [MAIN_W, SIDE_W],
    borders: NO_BORDERS,
    rows: [new TableRow({
      cantSplit: false,
      height: { value: 15600, rule: HeightRule.ATLEAST },
      children: [
        new TableCell({ width: { size: MAIN_W, type: WidthType.DXA }, borders: NO_BORDERS, verticalAlign: VerticalAlign.TOP, margins: { top: 300, bottom: 300, left: INSET_L, right: 260 }, children: main }),
        new TableCell({ width: { size: SIDE_W, type: WidthType.DXA }, borders: sideBorder, shading: { type: ShadingType.CLEAR, fill: SIDEBG }, verticalAlign: VerticalAlign.TOP, margins: { top: 300, bottom: 300, left: 360, right: INSET_R }, children: side }),
      ],
    })],
  });

  return {
    children: [headerTable, bodyTable],
    margin: { top: M, right: M, bottom: M, left: M },
  };
};
