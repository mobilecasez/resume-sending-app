// Resume Word layout — Germany Professional (Lebenslauf). Mirrors the PDF:
// rectangular photo top-left + name & personal details right, divider, sections,
// and a signature line. Reference example for the other layout files.
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
  PAGE_W, MUTED, INK, has, arr, run, bullet, sectionHeading, inlineRuns, dataUriToImage, NO_BORDERS,
} = H;

module.exports = function build(d, opts, accent) {
  const pi = d.personal_info || {};
  const M = 1008;                       // ~0.7in margins, single column
  const RIGHT_TAB = PAGE_W - M - M;      // 9890
  const slate = '64748B', dark = '0F172A';
  const name = has(pi.full_name) ? pi.full_name : 'Your Name';
  const title = has(pi.title) ? pi.title : (arr(d.experience)[0] || {}).role || '';
  const img = opts.photoRect ? dataUriToImage(opts.photoRect) : (opts.photo ? dataUriToImage(opts.photo) : null);

  const details = [
    has(pi.location) && ['Location', pi.location],
    has(pi.nationality) && ['Nationality', pi.nationality],
    has(pi.date_of_birth || pi.dob) && ['Date of Birth', pi.date_of_birth || pi.dob],
    has(pi.email) && ['Email', pi.email],
    has(pi.phone) && ['Phone', pi.phone],
  ].filter(Boolean);

  const rightChildren = [new Paragraph({ spacing: { after: has(title) ? 0 : 60 }, children: [run(name, { bold: true, size: 42, color: dark })] })];
  if (has(title)) rightChildren.push(new Paragraph({ spacing: { after: 90 }, children: [run(title, { size: 22, color: MUTED })] }));
  details.forEach(([k, v]) => rightChildren.push(new Paragraph({ spacing: { after: 14 }, children: [run(k + ':', { bold: true, color: slate, size: 18 }), run('   ' + v, { color: INK, size: 18 })] })));

  const photoBorder = { top: { style: BorderStyle.SINGLE, size: 4, color: '94A3B8' }, bottom: { style: BorderStyle.SINGLE, size: 4, color: '94A3B8' }, left: { style: BorderStyle.SINGLE, size: 4, color: '94A3B8' }, right: { style: BorderStyle.SINGLE, size: 4, color: '94A3B8' } };
  const photoChildren = img
    ? [new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ data: img.data, type: img.type, transformation: { width: 116, height: 150 } })] })]
    : [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 700, after: 700 }, children: [run('PHOTO', { color: '94A3B8', size: 16 })] })];

  const headerTable = new Table({
    width: { size: RIGHT_TAB, type: WidthType.DXA }, columnWidths: [1980, RIGHT_TAB - 1980], borders: NO_BORDERS,
    rows: [new TableRow({ children: [
      new TableCell({ width: { size: 1980, type: WidthType.DXA }, borders: img ? photoBorder : NO_BORDERS, margins: { top: 20, bottom: 20, left: 20, right: 20 }, children: photoChildren }),
      new TableCell({ width: { size: RIGHT_TAB - 1980, type: WidthType.DXA }, borders: NO_BORDERS, margins: { top: 0, bottom: 0, left: 260, right: 0 }, verticalAlign: VerticalAlign.TOP, children: rightChildren }),
    ] })],
  });

  const out = [headerTable, new Paragraph({ spacing: { before: 70, after: 130 }, border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CBD5E1', space: 2 } }, children: [run('', { size: 2 })] })];

  if (has(d.summary)) { out.push(sectionHeading('Professional Profile', accent)); out.push(new Paragraph({ spacing: { after: 40, line: 282 }, alignment: AlignmentType.JUSTIFIED, children: inlineRuns(d.summary, { size: 21 }) })); }
  const exp = arr(d.experience);
  if (exp.length) {
    out.push(sectionHeading('Work Experience', accent));
    exp.forEach((e) => {
      const dates = [e.start_date, e.end_date].filter(has).map(String).join(' – ');
      out.push(new Paragraph({ spacing: { before: 120, after: 0 }, tabStops: [{ type: TabStopType.RIGHT, position: RIGHT_TAB }], children: [run(e.role || 'Role', { bold: true, size: 22, color: dark }), run(dates ? '\t' + dates : '', { color: MUTED, size: 19 })] }));
      const meta = [e.company, e.location].filter(has).map(String).join(', ');
      if (meta) out.push(new Paragraph({ spacing: { after: 30 }, children: [run(meta, { color: slate, italics: true, size: 20 })] }));
      arr(e.highlights).forEach((h) => out.push(bullet(h)));
    });
  }
  const edu = arr(d.education);
  if (edu.length) {
    out.push(sectionHeading('Education', accent));
    edu.forEach((e) => {
      const deg = [e.degree, e.field_of_study].filter(has).map(String).join('  •  ');
      out.push(new Paragraph({ spacing: { before: 100, after: 0 }, children: [run(deg || e.degree || 'Education', { bold: true, size: 21 })] }));
      const sub = [e.institution, e.end_date, e.grade].filter(has).map(String).join('  •  ');
      if (sub) out.push(new Paragraph({ spacing: { after: 20 }, children: [run(sub, { color: MUTED, size: 20 })] }));
    });
  }
  const langs = arr(d.languages);
  if (langs.length) {
    out.push(sectionHeading('Languages', accent));
    langs.forEach((l) => { const t = (l && typeof l === 'object') ? `${l.name || l.language || ''}` : String(l); const lv = (l && typeof l === 'object') ? (l.level || l.proficiency || '') : ''; if (t.trim()) out.push(new Paragraph({ spacing: { after: 12 }, tabStops: [{ type: TabStopType.RIGHT, position: RIGHT_TAB }], children: [run(t, { size: 20 }), run(has(lv) ? '\t' + lv : '', { color: slate, size: 19 })] })); });
  }
  const tech = arr(d.skills && d.skills.technical), soft = arr(d.skills && d.skills.soft);
  if (tech.length || soft.length) { out.push(sectionHeading('Technical Skills', accent)); out.push(new Paragraph({ spacing: { after: 20, line: 290 }, children: [run([...tech, ...soft].map(String).join('   ·   '), { size: 21 })] })); }
  const certs = arr(d.certifications);
  if (certs.length) { out.push(sectionHeading('Certificates', accent)); certs.forEach((c) => out.push(bullet((c && typeof c === 'object') ? `${c.name || c.title || ''}${has(c.issuer || c.authority) ? ` — ${c.issuer || c.authority}` : ''}` : String(c)))); }

  let dateStr = ''; try { dateStr = new Date().toLocaleDateString('en-GB'); } catch (e) { dateStr = ''; }
  const place = has(pi.location) ? String(pi.location).split(',')[0].trim() : 'City';
  const sigTop = { top: { style: BorderStyle.SINGLE, size: 4, color: '94A3B8' }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } };
  out.push(new Paragraph({ spacing: { before: 560 }, children: [run('', { size: 2 })] }));
  out.push(new Table({ width: { size: RIGHT_TAB, type: WidthType.DXA }, columnWidths: [3700, RIGHT_TAB - 7400, 3700], borders: NO_BORDERS, rows: [new TableRow({ children: [
    new TableCell({ width: { size: 3700, type: WidthType.DXA }, borders: sigTop, margins: { top: 80 }, children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [run(`${place}, ${dateStr}`, { size: 18, color: MUTED })] })] }),
    new TableCell({ width: { size: RIGHT_TAB - 7400, type: WidthType.DXA }, borders: NO_BORDERS, children: [new Paragraph({ children: [run('')] })] }),
    new TableCell({ width: { size: 3700, type: WidthType.DXA }, borders: sigTop, margins: { top: 80 }, children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [run(name, { size: 18, color: MUTED })] })] }),
  ] })] }));

  return { children: out, margin: { top: M, right: M, bottom: M, left: M } };
};
