// Resume Word layout — Azure Sidebar. Mirrors the PDF `azure` template:
// a full-height blue gradient SIDEBAR on the left (circular photo, Contact,
// Tech Skills as labelled bars, Soft Skills, Languages, Education, Certificates)
// and a white MAIN column on the right (name with accent first word, role,
// accent rule, Professional Summary, Experience as a timeline, Key Projects,
// Achievements). Word can't do gradients/SVG, so the sidebar is a flat accent
// fill and skill "bars" are drawn with shaded table cells.
//
// Contract: module.exports = function build(d, opts, accent) -> { children, margin }
//   d      : resume_data { personal_info, summary, experience[], education[],
//            projects[], skills{technical[],soft[]}, languages[], certifications[], achievements[] }
//   opts   : { photo?: dataURI(square), photoRect?: dataURI(portrait) }
//   accent : hex string (no '#')
'use strict';

const H = require('../../docxHelpers');
const {
  Paragraph, TextRun, Table, TableRow, TableCell, ImageRun,
  AlignmentType, TabStopType, BorderStyle, WidthType, VerticalAlign,
  ShadingType, HeightRule,
  PAGE_W, MUTED, INK, has, arr, run, inlineRuns, dataUriToImage,
  NO_BORDERS, textOn, lighten, darken,
} = H;

module.exports = function build(d, opts, accent) {
  opts = opts || {};
  const pi = d.personal_info || {};

  // ── Geometry (full-bleed: page margins 0, insets via cell margins) ──────────
  const SIDE_W = 4252;                 // ~75mm sidebar
  const MAIN_W = PAGE_W - SIDE_W;      // remaining white column
  const SIDE_PAD = 360;                // sidebar inner inset
  const MAIN_PAD_L = 420, MAIN_PAD_R = 540, MAIN_PAD_T = 480;
  const SIDE_TEXT_W = SIDE_W - SIDE_PAD * 2;          // usable sidebar text width
  const MAIN_TEXT_W = MAIN_W - MAIN_PAD_L - MAIN_PAD_R;
  const MAIN_RIGHT_TAB = MAIN_TEXT_W; // right-edge tab stop for main column dates

  // ── Colours ─────────────────────────────────────────────────────────────────
  const onAccent = textOn(accent);                   // text colour on the sidebar fill
  const sideHead = onAccent === 'FFFFFF' ? 'FFFFFF' : darken(accent, 0.55);
  const sideText = onAccent === 'FFFFFF' ? lighten(accent, 0.78) : darken(accent, 0.35);
  const sideAccent = onAccent === 'FFFFFF' ? lighten(accent, 0.45) : darken(accent, 0.2);
  const barTrack = onAccent === 'FFFFFF' ? lighten(accent, 0.28) : lighten(accent, 0.6);
  const barFill = onAccent === 'FFFFFF' ? lighten(accent, 0.62) : darken(accent, 0.1);
  const nameAccent = darken(accent, 0.12);
  const mainHead = darken(accent, 0.12);
  const bodyInk = '46525E';
  const subMuted = '6B7785';

  const name = has(pi.full_name) ? String(pi.full_name).trim() : 'Your Name';
  const nameParts = name.split(/\s+/);
  const first = nameParts.shift() || name;
  const rest = nameParts.join(' ');
  const role = has(pi.title)
    ? pi.title
    : ((arr(d.experience)[0] || {}).role || 'Professional');

  const img = opts.photo ? dataUriToImage(opts.photo)
    : (opts.photoRect ? dataUriToImage(opts.photoRect) : null);

  // ════════════════════════════════════════════════════════════════════════════
  // SIDEBAR CONTENT (text on accent fill)
  // ════════════════════════════════════════════════════════════════════════════
  const side = [];

  // Photo — square avatar (Word can't clip to a circle). Skip cleanly when null.
  if (img) {
    side.push(new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: 200 },
      children: [new ImageRun({ data: img.data, type: img.type, transformation: { width: 132, height: 132 } })],
    }));
  } else if (has(name) && name !== 'Your Name') {
    // Initials chip when no photo.
    const ini = first.charAt(0).toUpperCase() + (rest ? rest.split(' ').pop().charAt(0).toUpperCase() : '');
    side.push(new Table({
      width: { size: SIDE_TEXT_W, type: WidthType.DXA }, borders: NO_BORDERS,
      alignment: AlignmentType.CENTER,
      rows: [new TableRow({ children: [new TableCell({
        width: { size: SIDE_TEXT_W, type: WidthType.DXA }, borders: NO_BORDERS,
        shading: { type: ShadingType.CLEAR, fill: sideAccent, color: 'auto' },
        margins: { top: 280, bottom: 280 },
        children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [run(ini || 'CV', { bold: true, size: 56, color: onAccent })] })],
      })] })],
    }));
    side.push(new Paragraph({ spacing: { after: 160 }, children: [run('', { size: 4 })] }));
  }

  // Sidebar section heading: short accent bar + uppercase label.
  const sideHeading = (label, first2) => new Paragraph({
    spacing: { before: first2 ? 0 : 260, after: 120 },
    children: [
      run('▎ ', { color: sideAccent, size: 22, bold: true }),
      run(String(label).toUpperCase(), { bold: true, color: onAccent, size: 19, characterSpacing: 20 }),
    ],
  });

  // Contact rows: label-less single lines (phone, email, location, links).
  const prettyUrl = (u) => String(u || '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
  const contacts = [
    has(pi.phone) && pi.phone,
    has(pi.email) && pi.email,
    has(pi.location) && pi.location,
    has(pi.linkedin_url) && prettyUrl(pi.linkedin_url),
    has(pi.portfolio_url) && prettyUrl(pi.portfolio_url),
  ].filter(Boolean);
  if (contacts.length) {
    side.push(sideHeading('Contact', side.length === 0));
    contacts.forEach((c) => side.push(new Paragraph({
      spacing: { after: 80, line: 240 },
      children: [run('• ', { color: sideAccent, size: 18, bold: true }), run(c, { color: sideText, size: 18 })],
    })));
  }

  // Tech Skills — name above a shaded "bar" (track + tapered fill).
  const tech = arr(d.skills && d.skills.technical).slice(0, 9);
  if (tech.length) {
    side.push(sideHeading('Tech Skills', side.length === 0));
    tech.forEach((sk, i) => {
      const pct = Math.max(0.62, 0.95 - i * 0.05);
      const fillW = Math.round(SIDE_TEXT_W * pct);
      const trackW = SIDE_TEXT_W - fillW;
      side.push(new Paragraph({ spacing: { after: 40 }, children: [run(String(sk), { color: onAccent, size: 17, bold: true })] }));
      const cells = [new TableCell({
        width: { size: fillW, type: WidthType.DXA }, borders: NO_BORDERS,
        shading: { type: ShadingType.CLEAR, fill: barFill, color: 'auto' },
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        children: [new Paragraph({ spacing: { before: 0, after: 0 }, children: [run('', { size: 6, color: barFill })] })],
      })];
      if (trackW > 20) cells.push(new TableCell({
        width: { size: trackW, type: WidthType.DXA }, borders: NO_BORDERS,
        shading: { type: ShadingType.CLEAR, fill: barTrack, color: 'auto' },
        children: [new Paragraph({ spacing: { before: 0, after: 0 }, children: [run('', { size: 6, color: barTrack })] })],
      }));
      side.push(new Table({
        width: { size: SIDE_TEXT_W, type: WidthType.DXA }, borders: NO_BORDERS,
        columnWidths: trackW > 20 ? [fillW, trackW] : [SIDE_TEXT_W],
        rows: [new TableRow({ height: { value: 70, rule: HeightRule.EXACT }, children: cells })],
      }));
      side.push(new Paragraph({ spacing: { after: 90 }, children: [run('', { size: 2 })] }));
    });
  }

  // Soft Skills — accent-bulleted list.
  const soft = arr(d.skills && d.skills.soft).slice(0, 6);
  if (soft.length) {
    side.push(sideHeading('Soft Skills', side.length === 0));
    soft.forEach((s) => side.push(new Paragraph({
      spacing: { after: 70, line: 240 },
      children: [run('• ', { color: sideAccent, size: 18, bold: true }), run(String(s), { color: sideText, size: 18 })],
    })));
  }

  // Languages — name + level.
  const langs = arr(d.languages);
  if (langs.length) {
    side.push(sideHeading('Languages', side.length === 0));
    langs.forEach((l) => {
      const nm = (l && typeof l === 'object') ? (l.name || l.language || '') : String(l);
      const lv = (l && typeof l === 'object') ? (l.level || l.proficiency || '') : '';
      if (!has(nm)) return;
      side.push(new Paragraph({
        spacing: { after: 70, line: 240 },
        tabStops: [{ type: TabStopType.RIGHT, position: SIDE_TEXT_W }],
        children: [run(nm, { color: onAccent, size: 18, bold: true }), run(has(lv) ? '\t' + lv : '', { color: sideText, size: 17 })],
      }));
    });
  }

  // Education — degree·field, institution, end_date (accent), grade.
  const edu = arr(d.education);
  if (edu.length) {
    side.push(sideHeading('Education', side.length === 0));
    edu.forEach((e) => {
      const deg = [e.degree, e.field_of_study].filter(has).map(String).join(' · ');
      side.push(new Paragraph({ spacing: { after: 14, line: 232 }, children: [run(deg || e.degree || 'Education', { color: onAccent, size: 18, bold: true })] }));
      if (has(e.institution)) side.push(new Paragraph({ spacing: { after: 10 }, children: [run(String(e.institution), { color: sideText, size: 17 })] }));
      const tail = [];
      if (has(e.end_date)) tail.push(new Paragraph({ spacing: { after: 10 }, children: [run(String(e.end_date), { color: sideAccent, size: 16, bold: true })] }));
      if (has(e.grade)) tail.push(new Paragraph({ spacing: { after: 10 }, children: [run(String(e.grade), { color: sideText, size: 17 })] }));
      tail.forEach((p) => side.push(p));
      side.push(new Paragraph({ spacing: { after: 110 }, children: [run('', { size: 2 })] }));
    });
  }

  // Certifications — accent-bulleted name + issuer/year.
  const certs = arr(d.certifications);
  if (certs.length) {
    side.push(sideHeading('Certifications', side.length === 0));
    certs.forEach((c) => {
      let label;
      if (c && typeof c === 'object') {
        const sub = [c.issuer || c.authority, c.year || c.date].filter(has).map(String).join(', ');
        label = (c.name || c.title || '') + (sub ? ` — ${sub}` : '');
      } else { label = String(c); }
      if (!has(label)) return;
      side.push(new Paragraph({
        spacing: { after: 80, line: 240 },
        children: [run('• ', { color: sideAccent, size: 18, bold: true }), run(label, { color: sideText, size: 17 })],
      }));
    });
  }

  if (!side.length) side.push(new Paragraph({ children: [run('', { size: 2, color: onAccent })] }));

  // ════════════════════════════════════════════════════════════════════════════
  // MAIN COLUMN CONTENT (white)
  // ════════════════════════════════════════════════════════════════════════════
  const main = [];

  // Name — first word accent, remainder ink.
  main.push(new Paragraph({
    spacing: { after: 60 },
    children: [
      run(first, { bold: true, size: 48, color: nameAccent }),
      rest ? run(' ' + rest, { bold: true, size: 48, color: INK }) : run('', { size: 2 }),
    ],
  }));
  if (has(role)) main.push(new Paragraph({ spacing: { after: 60 }, children: [run(String(role).toUpperCase(), { size: 19, color: subMuted, characterSpacing: 50 })] }));
  // Short accent rule under the header.
  main.push(new Paragraph({
    spacing: { before: 40, after: 60 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 22, color: accent, space: 1 } },
    children: [run('', { size: 2 })],
  }));
  main.push(new Paragraph({ spacing: { after: 40 }, children: [run('', { size: 2 })] }));

  // Main section heading: uppercase accent label + accent underline rule.
  const mainHeading = (label) => new Paragraph({
    spacing: { before: 280, after: 120 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: lighten(accent, 0.55), space: 3 } },
    children: [run(String(label).toUpperCase(), { bold: true, color: mainHead, size: 23, characterSpacing: 24 })],
  });

  // Professional Summary — paragraphs + bullet lines (split on leading •).
  if (has(d.summary)) {
    const lines = String(d.summary).split('\n').map((l) => l.trim()).filter(Boolean);
    const paras = lines.filter((l) => !l.startsWith('•'));
    const bullets = lines.filter((l) => l.startsWith('•')).map((l) => l.replace(/^•\s*/, ''));
    if (!paras.length && !bullets.length) paras.push(String(d.summary));
    main.push(mainHeading('Professional Summary'));
    paras.forEach((p) => main.push(new Paragraph({ spacing: { after: 80, line: 286 }, alignment: AlignmentType.JUSTIFIED, children: inlineRuns(p, { size: 21, color: bodyInk }) })));
    bullets.forEach((b) => main.push(new Paragraph({
      spacing: { after: 40, line: 270 }, indent: { left: 200, hanging: 200 },
      children: [run('• ', { color: accent, bold: true, size: 21 }), ...inlineRuns(b, { size: 21, color: bodyInk })],
    })));
  }

  // Experience — timeline rows: role + dates (right), company·location italic, bullets.
  const exp = arr(d.experience);
  if (exp.length) {
    main.push(mainHeading('Experience'));
    exp.forEach((e) => {
      const dates = [e.start_date, e.end_date].filter(has).map(String).join(' – ');
      main.push(new Paragraph({
        spacing: { before: 120, after: 0 },
        tabStops: [{ type: TabStopType.RIGHT, position: MAIN_RIGHT_TAB }],
        children: [
          run('● ', { color: accent, size: 16 }),
          run(e.role || 'Role', { bold: true, size: 22, color: INK }),
          run(dates ? '\t' + dates : '', { color: accent, size: 18, bold: true }),
        ],
      }));
      const co = [e.company, e.location].filter(has).map(String).join(' · ');
      if (co) main.push(new Paragraph({ spacing: { after: 40 }, indent: { left: 200 }, children: [run(co, { italics: true, color: subMuted, size: 19 })] }));
      arr(e.highlights).forEach((h) => main.push(new Paragraph({
        spacing: { after: 40, line: 268 }, indent: { left: 400, hanging: 200 },
        children: [run('• ', { color: accent, bold: true, size: 20 }), ...inlineRuns(h, { size: 20, color: bodyInk })],
      })));
    });
  }

  // Key Projects — role tag, bold accent title + type, about, bullets.
  const proj = arr(d.projects);
  if (proj.length) {
    main.push(mainHeading('Key Projects'));
    proj.forEach((p) => {
      if (has(p.role)) main.push(new Paragraph({ spacing: { before: 100, after: 10 }, children: [run(String(p.role).toUpperCase(), { color: accent, bold: true, size: 16, characterSpacing: 20 })] }));
      const titleRuns = [run(has(p.title) ? p.title : 'Project', { bold: true, size: 21, color: nameAccent })];
      if (has(p.type)) titleRuns.push(run(' — ' + p.type, { size: 21, color: INK }));
      main.push(new Paragraph({ spacing: { before: has(p.role) ? 0 : 100, after: 20 }, children: titleRuns }));
      const about = p.about || p.description;
      if (has(about)) main.push(new Paragraph({ spacing: { after: 30, line: 270 }, children: inlineRuns(about, { size: 20, color: '56616C' }) }));
      arr(p.role_highlights).forEach((h) => main.push(new Paragraph({
        spacing: { after: 30, line: 264 }, indent: { left: 400, hanging: 200 },
        children: [run('• ', { color: accent, bold: true, size: 20 }), ...inlineRuns(h, { size: 20, color: '56616C' })],
      })));
    });
  }

  // Achievements — accent-bulleted list (PDF surfaces these in the main column flow).
  const ach = arr(d.achievements);
  if (ach.length) {
    main.push(mainHeading('Achievements'));
    ach.forEach((a) => main.push(new Paragraph({
      spacing: { after: 40, line: 268 }, indent: { left: 200, hanging: 200 },
      children: [run('• ', { color: accent, bold: true, size: 20 }), ...inlineRuns(a, { size: 20, color: bodyInk })],
    })));
  }

  if (main.length <= 3) main.push(new Paragraph({ children: [run('', { size: 2 })] }));

  // ════════════════════════════════════════════════════════════════════════════
  // FULL-BLEED TWO-COLUMN TABLE (sidebar fills the page height)
  // ════════════════════════════════════════════════════════════════════════════
  const shell = new Table({
    width: { size: PAGE_W, type: WidthType.DXA },
    columnWidths: [SIDE_W, MAIN_W],
    borders: NO_BORDERS,
    rows: [new TableRow({
      height: { value: 16700, rule: HeightRule.ATLEAST },
      children: [
        new TableCell({
          width: { size: SIDE_W, type: WidthType.DXA }, borders: NO_BORDERS,
          shading: { type: ShadingType.CLEAR, fill: accent, color: 'auto' },
          margins: { top: 540, bottom: 540, left: SIDE_PAD, right: SIDE_PAD },
          verticalAlign: VerticalAlign.TOP,
          children: side,
        }),
        new TableCell({
          width: { size: MAIN_W, type: WidthType.DXA }, borders: NO_BORDERS,
          shading: { type: ShadingType.CLEAR, fill: 'FFFFFF', color: 'auto' },
          margins: { top: MAIN_PAD_T, bottom: 540, left: MAIN_PAD_L, right: MAIN_PAD_R },
          verticalAlign: VerticalAlign.TOP,
          children: main,
        }),
      ],
    })],
  });

  return { children: [shell], margin: { top: 0, right: 0, bottom: 0, left: 0 } };
};
