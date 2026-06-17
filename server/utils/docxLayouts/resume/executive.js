// Resume Word layout — Executive Dark. Mirrors the PDF `executive()`:
// a full-height DARK slate sidebar (gold accents) on the left + white main column.
//   Sidebar : circular photo, name (first white / last GOLD), role, divider,
//             Contact (gold icons → plain rows), Tech Skills as ★ rating rows,
//             Core Strengths as gold-diamond bullets, Languages, Certifications.
//   Main    : gold-bordered intro paragraph + summary bullets, then sections
//             (Work History, Key Projects, Education, Achievements) with a
//             two-column "date | content" grid and a gold-underlined heading.
//
// Contract: module.exports = function build(d, opts, accent) -> { children, margin }
//   d      : resume_data { personal_info, summary, experience[], education[],
//            projects[], skills{technical[],soft[]}, languages[], certifications[], achievements[] }
//   opts   : { photo?: dataURI(square), photoRect?: dataURI(portrait) }
//   accent : hex string (no '#') — the gold accent (#e0a64b)
'use strict';

const H = require('../../docxHelpers');
const {
  Paragraph, TextRun, Table, TableRow, TableCell, ImageRun,
  AlignmentType, TabStopType, BorderStyle, WidthType, VerticalAlign, ShadingType, HeightRule,
  PAGE_W, MUTED, INK, has, arr, run, inlineRuns, dataUriToImage, NO_BORDERS, textOn,
} = H;

module.exports = function build(d, opts, accent) {
  opts = opts || {};
  const pi = d.personal_info || {};
  const gold = String(accent || 'e0a64b').replace(/^#/, '').toUpperCase();

  // PDF signature: a DARK slate sidebar (--bg-1:#2c3742) with GOLD accents.
  const SIDE_BG = '2C3742';
  const SIDE_TEXT = 'CFD6DD';   // body text on the dark sidebar
  const SIDE_NAME = 'FFFFFF';   // first name / strong text
  const SIDE_ROLE = 'AAB3BC';   // role caption
  const STAR_OFF = '566370';    // empty star colour
  const DARK = SIDE_BG;         // section headings in the main column
  const SLATE = '6F7A85';       // muted / italic meta

  // Geometry: full-bleed page (margin 0), insets supplied via cell margins.
  const SIDE_W = 4150, MAIN_W = PAGE_W - SIDE_W;       // ~74mm sidebar
  const SPAD_L = 360, SPAD_R = 320;                    // sidebar text inset
  const MPAD_L = 420, MPAD_R = 380;                    // main column inset
  const RIGHT_TAB = MAIN_W - MPAD_L - MPAD_R;          // dates right edge in main
  const DATE_COL = 1180;                               // left "when" column width in main

  const name = has(pi.full_name) ? String(pi.full_name).trim() : 'Your Name';
  const nparts = name.split(/\s+/);
  const first = nparts.shift() || '';
  const rest = nparts.join(' ');
  const role = has(pi.title) ? pi.title : ((arr(d.experience)[0] || {}).role || 'Professional');

  const img = opts.photo ? dataUriToImage(opts.photo)
            : (opts.photoRect ? dataUriToImage(opts.photoRect) : null);

  // ── Sidebar helpers ────────────────────────────────────────────────────────
  // Heading: "Con" white + "tact" gold, uppercase, letter-spaced (mirrors h2 b{gold}).
  const sHead = (lead, tail) => new Paragraph({
    spacing: { before: 300, after: 120 },
    children: [
      run(String(lead).toUpperCase(), { bold: true, color: SIDE_NAME, size: 19, characterSpacing: 30 }),
      run(String(tail || '').toUpperCase(), { bold: true, color: gold, size: 19, characterSpacing: 30 }),
    ],
  });
  // Plain sidebar line.
  const sLine = (text, o = {}) => new Paragraph({
    spacing: { after: o.after != null ? o.after : 60, line: 240 },
    children: [run(String(text), { color: SIDE_TEXT, size: 18, ...o })],
  });

  const sideOut = [];

  // Avatar — circular photo, gold ring (a bordered cell standing in for the circle).
  if (img) {
    sideOut.push(new Table({
      width: { size: SIDE_W - SPAD_L - SPAD_R, type: WidthType.DXA }, borders: NO_BORDERS,
      rows: [new TableRow({ children: [new TableCell({
        width: { size: SIDE_W - SPAD_L - SPAD_R, type: WidthType.DXA }, borders: NO_BORDERS,
        children: [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 0 }, children: [
          new ImageRun({ data: img.data, type: img.type, transformation: { width: 132, height: 132 } }),
        ] })],
      })] })],
    }));
  } else if (first || rest) {
    // Initials disc fallback (gold initials), centered.
    const initials = (first[0] || '').toUpperCase() + (rest ? (rest.split(/\s+/).pop()[0] || '').toUpperCase() : '');
    sideOut.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 80 }, children: [
      run(initials || '•', { bold: true, color: gold, size: 64 }),
    ] }));
  }

  // Name block — first (white) / last (gold), centered; role caption below.
  const nameRuns = [run(first, { bold: true, color: SIDE_NAME, size: 40 })];
  if (rest) { nameRuns.push(new TextRun({ break: 1 })); nameRuns.push(run(rest, { color: gold, size: 40 })); }
  sideOut.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: img ? 160 : 0, after: has(role) ? 60 : 0, line: 240 }, children: nameRuns }));
  if (has(role)) sideOut.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 0 }, children: [
    run(String(role).toUpperCase(), { color: SIDE_ROLE, size: 16, characterSpacing: 40 }),
  ] }));

  // Divider under the identity block.
  sideOut.push(new Paragraph({ spacing: { before: 200, after: 60 }, border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: '4A5560', space: 2 } }, children: [run('', { size: 2 })] }));

  // Contact.
  const prettyUrl = (u) => String(u).replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '');
  const contacts = [];
  if (has(pi.phone)) contacts.push(pi.phone);
  if (has(pi.email)) contacts.push(pi.email);
  if (has(pi.location)) contacts.push(pi.location);
  if (has(pi.linkedin_url)) contacts.push(prettyUrl(pi.linkedin_url));
  if (has(pi.portfolio_url)) contacts.push(prettyUrl(pi.portfolio_url));
  if (contacts.length) {
    sideOut.push(sHead('Con', 'tact'));
    contacts.forEach((c) => sideOut.push(new Paragraph({
      spacing: { after: 70, line: 232 }, tabStops: [{ type: TabStopType.LEFT, position: 200 }],
      children: [run('▸', { color: gold, size: 16 }), run('\t' + c, { color: SIDE_TEXT, size: 18 })],
    })));
  }

  // Tech Skills — star-rating rows (5/4 like the PDF), names left, stars right.
  const tech = arr(d.skills && d.skills.technical).slice(0, 9);
  if (tech.length) {
    sideOut.push(sHead('Tech ', 'Skills'));
    const SROW_TAB = SIDE_W - SPAD_L - SPAD_R;
    tech.forEach((sk, i) => {
      const n = i < Math.ceil(tech.length / 2) ? 5 : 4;
      const stars = '★★★★★'.slice(0, n);
      const empty = '★★★★★'.slice(0, 5 - n);
      sideOut.push(new Paragraph({
        spacing: { after: 56, line: 220 }, tabStops: [{ type: TabStopType.RIGHT, position: SROW_TAB }],
        children: [
          run(String(sk), { color: SIDE_TEXT, size: 18 }),
          run('\t', {}),
          run(stars, { color: gold, size: 18 }),
          run(empty, { color: STAR_OFF, size: 18 }),
        ],
      }));
    });
  }

  // Core Strengths (soft skills) — gold diamond bullets.
  const soft = arr(d.skills && d.skills.soft).slice(0, 6);
  if (soft.length) {
    sideOut.push(sHead('Core ', 'Strengths'));
    soft.forEach((s) => sideOut.push(new Paragraph({
      spacing: { after: 50, line: 228 }, tabStops: [{ type: TabStopType.LEFT, position: 190 }],
      children: [run('◆', { color: gold, size: 13 }), run('\t' + String(s), { color: SIDE_TEXT, size: 18 })],
    })));
  }

  // Languages — name + level on the right.
  const langs = arr(d.languages);
  if (langs.length) {
    sideOut.push(sHead('Lang', 'uages'));
    const LROW_TAB = SIDE_W - SPAD_L - SPAD_R;
    langs.forEach((l) => {
      const nm = (l && typeof l === 'object') ? (l.name || l.language || '') : String(l);
      const lv = (l && typeof l === 'object') ? (l.level || l.proficiency || '') : '';
      if (!has(nm)) return;
      sideOut.push(new Paragraph({
        spacing: { after: 52, line: 220 }, tabStops: [{ type: TabStopType.RIGHT, position: LROW_TAB }],
        children: [run(String(nm), { color: SIDE_TEXT, size: 18 }), run(has(lv) ? '\t' + lv : '', { color: gold, size: 17 })],
      }));
    });
  }

  // Certifications — in the sidebar (compact).
  const certs = arr(d.certifications);
  if (certs.length) {
    sideOut.push(sHead('Certifi', 'cations'));
    certs.forEach((c) => {
      const nm = (c && typeof c === 'object') ? (c.name || c.title || '') : String(c);
      const sub = (c && typeof c === 'object') ? [c.issuer || c.authority, c.year || c.date].filter(has).map(String).join(' · ') : '';
      if (!has(nm)) return;
      sideOut.push(new Paragraph({ spacing: { after: has(sub) ? 6 : 56, line: 224 }, tabStops: [{ type: TabStopType.LEFT, position: 190 }], children: [run('◆', { color: gold, size: 12 }), run('\t' + String(nm), { color: SIDE_TEXT, size: 18, bold: true })] }));
      if (has(sub)) sideOut.push(new Paragraph({ spacing: { after: 56, line: 220 }, indent: { left: 190 }, children: [run(sub, { color: SIDE_TEXT, size: 16 })] }));
    });
  }

  if (!sideOut.length) sideOut.push(sLine(''));

  // ── Main column ─────────────────────────────────────────────────────────────
  const mainOut = [];

  // Main section heading: uppercase dark, grey bottom rule + (approximated) gold underline.
  const mHead = (title, first) => new Paragraph({
    spacing: { before: first ? 0 : 280, after: 140 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: gold, space: 3 } },
    children: [run(String(title).toUpperCase(), { bold: true, color: DARK, size: 24, characterSpacing: 20 })],
  });

  // Intro paragraph — gold left border (mirrors .intro{border-left:3px gold}).
  const { paras, bullets } = (function split(summary) {
    const lines = String(summary || '').split('\n').map((l) => l.trim()).filter(Boolean);
    return { paras: lines.filter((l) => !l.startsWith('•')), bullets: lines.filter((l) => l.startsWith('•')).map((l) => l.replace(/^•\s*/, '')) };
  })(d.summary);

  let firstMain = true;
  if (paras.length) {
    mainOut.push(new Paragraph({
      spacing: { after: bullets.length ? 80 : 40, line: 288 },
      border: { left: { style: BorderStyle.SINGLE, size: 18, color: gold, space: 12 } },
      indent: { left: 60 },
      children: inlineRuns(paras.join(' '), { size: 22, color: '4A555F' }),
    }));
    firstMain = false;
  }
  if (bullets.length) {
    bullets.forEach((b) => mainOut.push(new Paragraph({
      spacing: { after: 40, line: 264 }, indent: { left: 260, hanging: 200 },
      children: [run('●  ', { color: DARK, size: 14 }), ...inlineRuns(b, { size: 21, color: '4A555F' })],
    })));
    firstMain = false;
  }

  // Two-column entry: left date/tag (gold, right-aligned) | right content.
  const entryRow = (when, whenSub, contentChildren) => {
    const whenChildren = [new Paragraph({
      alignment: AlignmentType.RIGHT, spacing: { after: 0, line: 232 },
      children: [run(String(when || ''), { bold: true, color: gold, size: 18 })],
    })];
    if (has(whenSub)) whenChildren.push(new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { before: 24, after: 0 }, children: [run('– ' + whenSub, { color: SLATE, size: 17 })] }));
    return new Table({
      width: { size: RIGHT_TAB, type: WidthType.DXA }, columnWidths: [DATE_COL, RIGHT_TAB - DATE_COL], borders: NO_BORDERS,
      rows: [new TableRow({ children: [
        new TableCell({ width: { size: DATE_COL, type: WidthType.DXA }, borders: NO_BORDERS, margins: { top: 30, right: 200, bottom: 0, left: 0 }, verticalAlign: VerticalAlign.TOP, children: whenChildren }),
        new TableCell({ width: { size: RIGHT_TAB - DATE_COL, type: WidthType.DXA }, borders: NO_BORDERS, margins: { top: 30, right: 0, bottom: 0, left: 0 }, verticalAlign: VerticalAlign.TOP, children: contentChildren.length ? contentChildren : [new Paragraph({ children: [run('')] })] }),
      ] })],
    });
  };
  const entrySpacer = () => new Paragraph({ spacing: { after: 0, line: 120 }, children: [run('', { size: 2 })] });

  // Work History.
  const exp = arr(d.experience);
  if (exp.length) {
    mainOut.push(mHead('Work History', firstMain)); firstMain = false;
    exp.forEach((e) => {
      const dr = [e.start_date, e.end_date].filter(has).map(String);
      const start = dr[0] || '';
      const end = dr[1] || '';
      const co = [e.company, e.location].filter(has).map(String).join(' · ');
      const content = [new Paragraph({ spacing: { after: co ? 16 : 40, line: 240 }, children: [run(e.role || 'Role', { bold: true, color: INK, size: 23 })] })];
      if (co) content.push(new Paragraph({ spacing: { after: 60 }, children: [run(co, { italics: true, color: SLATE, size: 20 })] }));
      arr(e.highlights).forEach((h) => content.push(new Paragraph({ spacing: { after: 40, line: 256 }, indent: { left: 200, hanging: 200 }, children: [run('•  ', { color: DARK, size: 18 }), ...inlineRuns(h, { size: 21, color: '4A555F' })] })));
      mainOut.push(entryRow(start, end, content));
      mainOut.push(entrySpacer());
    });
  }

  // Key Projects.
  const proj = arr(d.projects);
  if (proj.length) {
    mainOut.push(mHead('Key Projects', firstMain)); firstMain = false;
    proj.forEach((p) => {
      const content = [];
      if (has(p.role)) content.push(new Paragraph({ spacing: { after: 20 }, children: [run(String(p.role).toUpperCase(), { bold: true, color: gold, size: 16, characterSpacing: 20 })] }));
      content.push(new Paragraph({ spacing: { after: (has(p.about) || has(p.description)) ? 16 : 40, line: 240 }, children: [run(p.title || 'Project', { bold: true, color: INK, size: 23 })] }));
      if (has(p.about) || has(p.description)) content.push(new Paragraph({ spacing: { after: 50, line: 252 }, children: inlineRuns(p.about || p.description, { size: 20, color: '56616C' }) }));
      arr(p.role_highlights).forEach((h) => content.push(new Paragraph({ spacing: { after: 40, line: 256 }, indent: { left: 200, hanging: 200 }, children: [run('•  ', { color: DARK, size: 18 }), ...inlineRuns(h, { size: 21, color: '4A555F' })] })));
      mainOut.push(entryRow(has(p.type) ? p.type : 'Project', '', content));
      mainOut.push(entrySpacer());
    });
  }

  // Education.
  const edu = arr(d.education);
  if (edu.length) {
    mainOut.push(mHead('Education', firstMain)); firstMain = false;
    edu.forEach((e) => {
      const deg = [e.degree, e.field_of_study].filter(has).map(String).join(' — ');
      const sub = [e.institution, e.grade].filter(has).map(String).join(' · ');
      const content = [new Paragraph({ spacing: { after: sub ? 16 : 40, line: 240 }, children: [run(deg || e.degree || 'Education', { bold: true, color: INK, size: 23 })] })];
      if (sub) content.push(new Paragraph({ spacing: { after: 60 }, children: [run(sub, { italics: true, color: SLATE, size: 20 })] }));
      mainOut.push(entryRow(has(e.end_date) ? e.end_date : '', '', content));
      mainOut.push(entrySpacer());
    });
  }

  // Achievements (PDF shows them via the data; render as a clean list).
  const achievements = arr(d.achievements);
  if (achievements.length) {
    mainOut.push(mHead('Achievements', firstMain)); firstMain = false;
    achievements.forEach((a) => mainOut.push(new Paragraph({ spacing: { after: 40, line: 256 }, indent: { left: 260, hanging: 200 }, children: [run('●  ', { color: gold, size: 14 }), ...inlineRuns(a, { size: 21, color: '4A555F' })] })));
  }

  if (!mainOut.length) mainOut.push(new Paragraph({ children: [run(name, { bold: true, color: DARK, size: 30 })] }));

  // ── Assemble: single full-page two-column row ───────────────────────────────
  const table = new Table({
    width: { size: PAGE_W, type: WidthType.DXA }, columnWidths: [SIDE_W, MAIN_W], borders: NO_BORDERS,
    rows: [new TableRow({
      height: { value: 16700, rule: HeightRule.ATLEAST },
      children: [
        new TableCell({
          width: { size: SIDE_W, type: WidthType.DXA },
          shading: { type: ShadingType.CLEAR, fill: SIDE_BG, color: 'auto' },
          margins: { top: 620, bottom: 460, left: SPAD_L, right: SPAD_R }, borders: NO_BORDERS,
          verticalAlign: VerticalAlign.TOP, children: sideOut,
        }),
        new TableCell({
          width: { size: MAIN_W, type: WidthType.DXA },
          margins: { top: 660, bottom: 440, left: MPAD_L, right: MPAD_R }, borders: NO_BORDERS,
          verticalAlign: VerticalAlign.TOP, children: mainOut,
        }),
      ],
    })],
  });

  return {
    children: [table, new Paragraph({ spacing: { after: 0, line: 20 }, children: [new TextRun({ text: '', size: 1 })] })],
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
  };
};
