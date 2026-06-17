// Resume Word layout — Europass Premium. Mirrors the PDF:
// a full-width accent BANNER at top (rectangular photo + name + title + inline
// contact, all on the accent fill), then a single-column body with sections:
// Profile, Languages (with level bars), Digital Skills, Work Experience,
// Education & Training, Certificates. Accent #2557a7.
//
// Contract: module.exports = function build(d, opts, accent) -> { children, margin }
//   d      : resume_data { personal_info, summary, experience[], education[],
//            projects[], skills{technical[],soft[]}, languages[], certifications[], achievements[] }
//   opts   : { photo?: dataURI(square), photoRect?: dataURI(portrait) }
//   accent : hex string (no '#')
'use strict';

const H = require('../../docxHelpers');
const {
  Paragraph, TextRun, Table, TableRow, TableCell, ImageRun, ShadingType,
  AlignmentType, TabStopType, BorderStyle, WidthType, VerticalAlign,
  PAGE_W, MUTED, INK, has, arr, run, bullet, inlineRuns, dataUriToImage,
  textOn, lighten, darken, NO_BORDERS,
} = H;

// CEFR / common level → fill fraction (matches resumeTemplates levelPct).
function levelPct(level) {
  const m = { a1: 18, a2: 33, b1: 50, b2: 66, c1: 83, c2: 100, native: 100, fluent: 92, professional: 75, intermediate: 55, basic: 30 };
  const k = String(level || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return m[k] || (/(nativ|mother)/.test(k) ? 100 : /(fluen|profic)/.test(k) ? 92 : 60);
}

module.exports = function build(d, opts, accent) {
  opts = opts || {};
  const pi = (d && d.personal_info) || {};
  const M = 0;                                  // full-bleed; banner + body manage their own insets
  const SIDE = 1080;                            // body left/right inset (~15mm-ish in twips, generous)
  const HEAD_PAD = 1080;                        // banner horizontal inset
  const CONTENT_W = PAGE_W - SIDE - SIDE;       // usable body width
  const RIGHT_TAB = CONTENT_W;                  // right edge for date tab stops within body

  const slate = '64748B', dark = '0F172A', body = '374151', trackBg = 'E2E8F0';
  const onAccent = textOn(accent);              // text colour over the accent fill
  const subOnAccent = lighten(accent, 0.78);    // soft light-blue for title/contact on accent

  const name = has(pi.full_name) ? pi.full_name : 'Your Name';
  const role = has(pi.title) ? pi.title : ((arr(d && d.experience)[0] || {}).role || '');

  // Pretty URL for links (strip protocol + trailing slash).
  const prettyUrl = (u) => has(u) ? String(u).replace(/^https?:\/\//i, '').replace(/\/$/, '') : '';
  const contactBits = [
    has(pi.email) && pi.email,
    has(pi.phone) && pi.phone,
    has(pi.location) && pi.location,
    prettyUrl(pi.linkedin_url),
    prettyUrl(pi.portfolio_url),
  ].filter(Boolean).map(String);

  // ── Banner (accent fill): photo on the left, name + title + contact on the right ──
  const img = opts.photoRect ? dataUriToImage(opts.photoRect) : (opts.photo ? dataUriToImage(opts.photo) : null);
  const photoBorder = { style: BorderStyle.SINGLE, size: 8, color: lighten(accent, 0.55) };
  const photoBorders = { top: photoBorder, bottom: photoBorder, left: photoBorder, right: photoBorder };
  const photoChildren = img
    ? [new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ data: img.data, type: img.type, transformation: { width: 106, height: 128 } })] })]
    : [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 620, after: 620 }, children: [run('PHOTO', { color: subOnAccent, size: 15 })] })];

  const headRight = [
    new Paragraph({ spacing: { after: has(role) ? 18 : (contactBits.length ? 60 : 0) }, children: [run(name, { bold: true, size: 44, color: onAccent })] }),
  ];
  if (has(role)) headRight.push(new Paragraph({ spacing: { after: contactBits.length ? 80 : 0 }, children: [run(String(role).toUpperCase(), { size: 21, color: subOnAccent, characterSpacing: 6 })] }));
  if (contactBits.length) headRight.push(new Paragraph({ spacing: { after: 0, line: 252 }, children: [run(contactBits.join('   ·   '), { size: 18, color: subOnAccent })] }));

  const PHOTO_W = 1760;
  const banner = new Table({
    width: { size: PAGE_W, type: WidthType.DXA },
    columnWidths: [PHOTO_W, PAGE_W - PHOTO_W],
    borders: NO_BORDERS,
    rows: [new TableRow({ children: [
      new TableCell({
        width: { size: PHOTO_W, type: WidthType.DXA }, verticalAlign: VerticalAlign.CENTER,
        shading: { type: ShadingType.CLEAR, fill: accent, color: 'auto' },
        margins: { top: 540, bottom: 540, left: HEAD_PAD, right: 0 },
        borders: NO_BORDERS,
        children: [new Table({
          width: { size: 1140, type: WidthType.DXA }, columnWidths: [1140], borders: img ? photoBorders : NO_BORDERS,
          rows: [new TableRow({ children: [new TableCell({
            width: { size: 1140, type: WidthType.DXA }, verticalAlign: VerticalAlign.CENTER, borders: img ? photoBorders : NO_BORDERS,
            shading: { type: ShadingType.CLEAR, fill: img ? 'auto' : lighten(accent, 0.18), color: 'auto' },
            margins: { top: 24, bottom: 24, left: 24, right: 24 }, children: photoChildren,
          })] })],
        })],
      }),
      new TableCell({
        width: { size: PAGE_W - PHOTO_W, type: WidthType.DXA }, verticalAlign: VerticalAlign.CENTER,
        shading: { type: ShadingType.CLEAR, fill: accent, color: 'auto' },
        margins: { top: 540, bottom: 540, left: 320, right: HEAD_PAD },
        borders: NO_BORDERS, children: headRight,
      }),
    ] })],
  });

  // ── Body ──────────────────────────────────────────────────────────────────────
  const out = [];

  // Section heading: uppercase accent text with an accent bottom rule (matches .sec-h).
  const heading = (title) => new Paragraph({
    spacing: { before: 280, after: 110 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 14, color: accent, space: 3 } },
    children: [run(String(title).toUpperCase(), { bold: true, color: accent, size: 21, characterSpacing: 12 })],
  });

  // Profile
  if (has(d && d.summary)) {
    out.push(heading('Profile'));
    out.push(new Paragraph({ spacing: { after: 40, line: 288 }, alignment: AlignmentType.JUSTIFIED, children: inlineRuns(d.summary, { size: 21, color: body }) }));
  }

  // Languages — name (left) + level (right) + a progress bar (track + accent fill).
  const langs = arr(d && d.languages);
  if (langs.length) {
    out.push(heading('Languages'));
    langs.forEach((l) => {
      const nm = (l && typeof l === 'object') ? (l.name || l.language || '') : String(l);
      const lv = (l && typeof l === 'object') ? (l.level || l.proficiency || '') : '';
      if (!has(nm)) return;
      out.push(new Paragraph({
        spacing: { before: 90, after: 36 }, tabStops: [{ type: TabStopType.RIGHT, position: RIGHT_TAB }],
        children: [run(nm, { size: 20, color: dark }), run(has(lv) ? '\t' + lv : '', { size: 19, color: slate })],
      }));
      const pct = Math.max(6, Math.min(100, levelPct(lv)));
      const fillW = Math.round((CONTENT_W * pct) / 100);
      const restW = Math.max(1, CONTENT_W - fillW);
      const barCell = (w, fill) => new TableCell({
        width: { size: w, type: WidthType.DXA }, borders: NO_BORDERS,
        shading: { type: ShadingType.CLEAR, fill, color: 'auto' },
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        children: [new Paragraph({ spacing: { before: 0, after: 0 }, children: [run('', { size: 4 })] })],
      });
      const barRow = restW > 1
        ? [barCell(fillW, accent), barCell(restW, trackBg)]
        : [barCell(CONTENT_W, accent)];
      out.push(new Paragraph({ spacing: { after: 90 }, children: [run('', { size: 2 })] }));
      out.push(new Table({
        width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: restW > 1 ? [fillW, restW] : [CONTENT_W],
        borders: NO_BORDERS, rows: [new TableRow({ height: { value: 70, rule: H.HeightRule.EXACT }, children: barRow })],
      }));
    });
  }

  // Digital Skills — dot-separated technical skills.
  const tech = arr(d && d.skills && d.skills.technical), soft = arr(d && d.skills && d.skills.soft);
  if (tech.length || soft.length) {
    out.push(heading('Digital Skills'));
    if (tech.length) out.push(new Paragraph({ spacing: { after: soft.length ? 30 : 20, line: 300 }, children: [run(tech.map(String).join('   ·   '), { size: 20, color: body })] }));
    if (soft.length) out.push(new Paragraph({ spacing: { after: 20, line: 300 }, children: [run(soft.map(String).join('   ·   '), { size: 20, color: body })] }));
  }

  // Work Experience — role (bold) + dates (accent) right; company/location italic; accent bullets.
  const exp = arr(d && d.experience);
  if (exp.length) {
    out.push(heading('Work Experience'));
    exp.forEach((e) => {
      const dates = [e.start_date, e.end_date].filter(has).map(String).join(' – ');
      out.push(new Paragraph({
        spacing: { before: 130, after: 0 }, tabStops: [{ type: TabStopType.RIGHT, position: RIGHT_TAB }],
        children: [run(has(e.role) ? e.role : 'Role', { bold: true, size: 22, color: dark }), run(dates ? '\t' + dates : '', { bold: true, size: 18, color: accent })],
      }));
      const co = [e.company, e.location].filter(has).map(String).join(', ');
      if (co) out.push(new Paragraph({ spacing: { after: 36 }, children: [run(co, { italics: true, size: 19, color: slate })] }));
      arr(e.highlights).forEach((h) => out.push(bullet(h, undefined, { color: body })));
    });
  }

  // Education & Training — degree+field (bold) + end_date (accent); institution · grade sub.
  const edu = arr(d && d.education);
  if (edu.length) {
    out.push(heading('Education & Training'));
    edu.forEach((e) => {
      const deg = [e.degree, e.field_of_study].filter(has).map(String).join(', ');
      out.push(new Paragraph({
        spacing: { before: 110, after: 0 }, tabStops: [{ type: TabStopType.RIGHT, position: RIGHT_TAB }],
        children: [run(has(deg) ? deg : (has(e.degree) ? e.degree : 'Education'), { bold: true, size: 21, color: dark }), run(has(e.end_date) ? '\t' + e.end_date : '', { bold: true, size: 18, color: accent })],
      }));
      const sub = [e.institution, has(e.grade) ? 'Grade: ' + e.grade : ''].filter(has).map(String).join('  ·  ');
      if (sub) out.push(new Paragraph({ spacing: { after: 24 }, children: [run(sub, { italics: true, size: 19, color: slate })] }));
    });
  }

  // Certificates — bulleted "name — issuer/year".
  const certs = arr(d && d.certifications);
  if (certs.length) {
    out.push(heading('Certificates'));
    certs.forEach((c) => {
      let txt;
      if (c && typeof c === 'object') {
        const nm = c.name || c.title || '';
        const sub = [c.issuer || c.authority, c.year || c.date].filter(has).map(String).join(', ');
        txt = has(nm) ? (has(sub) ? `${nm} — ${sub}` : String(nm)) : sub;
      } else { txt = String(c); }
      if (has(txt)) out.push(bullet(txt, undefined, { color: body }));
    });
  }

  // Achievements — only if present (the PDF body would surface these under the summary;
  // keep them as a clean bulleted section so no field is dropped).
  const ach = arr(d && d.achievements);
  if (ach.length) {
    out.push(heading('Achievements'));
    ach.forEach((a) => out.push(bullet(a, undefined, { color: body })));
  }

  // Projects — only if present (guarded; PDF omits in body but the data may carry them).
  const proj = arr(d && d.projects);
  if (proj.length) {
    out.push(heading('Projects'));
    proj.forEach((p) => {
      const title = [has(p.title) ? p.title : '', has(p.type) ? p.type : ''].filter(Boolean).map(String).join(' — ');
      out.push(new Paragraph({
        spacing: { before: 120, after: 0 }, tabStops: [{ type: TabStopType.RIGHT, position: RIGHT_TAB }],
        children: [run(has(title) ? title : 'Project', { bold: true, size: 21, color: dark }), run(has(p.role) ? '\t' + p.role : '', { bold: true, size: 18, color: accent })],
      }));
      const about = p.about || p.description;
      if (has(about)) out.push(new Paragraph({ spacing: { after: 24, line: 276 }, children: inlineRuns(about, { size: 20, color: body }) }));
      arr(p.role_highlights).forEach((h) => out.push(bullet(h, undefined, { color: body })));
    });
  }

  // Wrap the body content in a single full-width cell so we get clean left/right insets
  // (the banner is full-bleed; the body sits inside SIDE margins like the PDF .body padding).
  const bodyWrap = new Table({
    width: { size: PAGE_W, type: WidthType.DXA }, columnWidths: [PAGE_W], borders: NO_BORDERS,
    rows: [new TableRow({ children: [new TableCell({
      width: { size: PAGE_W, type: WidthType.DXA }, borders: NO_BORDERS,
      margins: { top: 360, bottom: 360, left: SIDE, right: SIDE },
      children: out.length ? out : [new Paragraph({ children: [run('')] })],
    })] })],
  });

  return {
    children: [banner, bodyWrap],
    margin: { top: M, right: M, bottom: M, left: M },
  };
};
