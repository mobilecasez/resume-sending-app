// Resume Word layout — ATS Modern. Mirrors the PDF (atsModern in resumeTemplates.js):
// single column, full width, NO sidebar / NO photo / NO header band. Left-aligned
// uppercase name + role + inline contact line, then sections each introduced by an
// UPPERCASE heading with a full-width accent bottom rule. Section order matches the
// PDF: Professional Summary, Core Skills, Professional Experience, Achievements,
// Certifications, Projects, Education. Dates are right-aligned via a RIGHT tab stop.
//
// Contract: module.exports = function build(d, opts, accent) -> { children, margin }
//   d      : resume_data { personal_info, summary, experience[], education[],
//            projects[], skills{technical[],soft[]}, languages[], certifications[], achievements[] }
//   opts   : { photo?: dataURI(square), photoRect?: dataURI(portrait) }  (unused — ATS = no photo)
//   accent : hex string (no '#'); ATS Modern accent is 1f2937
'use strict';

const H = require('../../docxHelpers');
const {
  Paragraph, AlignmentType, TabStopType, BorderStyle,
  PAGE_W, MUTED, INK, has, arr, run, bullet, inlineRuns,
} = H;

module.exports = function build(d, opts, accent) {
  const pi = d.personal_info || {};
  const M = 1000;                       // ~18mm side margins, single column
  const RIGHT_TAB = PAGE_W - M - M;     // right edge of the text column
  const ink = H.hex(accent);            // dark ink (1f2937) for name / headings / rules
  const headInk = H.darken(accent, 0.15);   // slightly deeper for name/heading ink (≈111827)
  const sub = H.lighten(accent, 0.25);  // muted body label tone (≈374151)
  const dateCol = H.lighten(accent, 0.4);    // date / italic meta (≈4b5563)

  const name = has(pi.full_name) ? String(pi.full_name).toUpperCase() : 'YOUR NAME';
  const role = has(pi.title) ? pi.title : ((arr(d.experience)[0] || {}).role || '');

  const out = [];

  // ── Header: name, role, inline contact ──────────────────────────────────────
  out.push(new Paragraph({
    spacing: { after: has(role) ? 30 : 70 },
    children: [run(name, { bold: true, size: 46, color: headInk, characterSpacing: 6 })],
  }));
  if (has(role)) out.push(new Paragraph({ spacing: { after: 70 }, children: [run(role, { size: 22, color: sub, characterSpacing: 4 })] }));

  const contact = [pi.email, pi.phone, pi.location, prettyLink(pi.linkedin_url), prettyLink(pi.portfolio_url)]
    .filter(has).map(String).join('   •   ');
  if (contact) out.push(new Paragraph({ spacing: { after: 40 }, children: [run(contact, { size: 19, color: sub })] }));

  // ── Section heading: UPPERCASE + full-width accent bottom rule ───────────────
  const heading = (title) => new Paragraph({
    spacing: { before: 230, after: 90 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: headInk, space: 3 } },
    children: [run(String(title).toUpperCase(), { bold: true, size: 22, color: headInk, characterSpacing: 12 })],
  });

  // ── Professional Summary ────────────────────────────────────────────────────
  if (has(d.summary)) {
    out.push(heading('Professional Summary'));
    out.push(new Paragraph({ spacing: { after: 40, line: 288 }, children: inlineRuns(d.summary, { size: 21, color: ink }) }));
  }

  // ── Core Skills (technical + soft, inline grid joined with • ) ───────────────
  const tech = arr(d.skills && d.skills.technical);
  const soft = arr(d.skills && d.skills.soft);
  const skills = [...tech, ...soft].map(String);
  if (skills.length) {
    out.push(heading('Core Skills'));
    out.push(new Paragraph({ spacing: { after: 30, line: 320 }, children: [run(skills.join('  •  '), { size: 21, color: ink })] }));
  }

  // ── Professional Experience ─────────────────────────────────────────────────
  const exp = arr(d.experience);
  if (exp.length) {
    out.push(heading('Professional Experience'));
    exp.forEach((e) => {
      const dates = [e.start_date, e.end_date].filter(has).map(String).join(' – ');
      out.push(new Paragraph({
        spacing: { before: 140, after: 0 },
        tabStops: [{ type: TabStopType.RIGHT, position: RIGHT_TAB }],
        children: [run(has(e.role) ? e.role : 'Role', { bold: true, size: 22, color: headInk }), run(dates ? '\t' + dates : '', { color: dateCol, size: 19 })],
      }));
      const meta = [e.company, e.location].filter(has).map(String).join(', ');
      if (meta) out.push(new Paragraph({ spacing: { after: 40 }, children: [run(meta, { italics: true, size: 20, color: sub })] }));
      arr(e.highlights).forEach((h) => out.push(bullet(h, undefined, { color: ink })));
    });
  }

  // ── Achievements ────────────────────────────────────────────────────────────
  const ach = arr(d.achievements);
  if (ach.length) {
    out.push(heading('Achievements'));
    ach.forEach((a) => out.push(bullet(a, undefined, { color: ink })));
  }

  // ── Certifications ──────────────────────────────────────────────────────────
  const certs = arr(d.certifications);
  if (certs.length) {
    out.push(heading('Certifications'));
    certs.forEach((c) => out.push(bullet(certLine(c), undefined, { color: ink })));
  }

  // ── Projects ────────────────────────────────────────────────────────────────
  const proj = arr(d.projects);
  if (proj.length) {
    out.push(heading('Projects'));
    proj.forEach((p) => {
      const title = (has(p.title) ? String(p.title) : 'Project') + (has(p.type) ? ' — ' + p.type : '');
      out.push(new Paragraph({
        spacing: { before: 140, after: 0 },
        tabStops: [{ type: TabStopType.RIGHT, position: RIGHT_TAB }],
        children: [run(title, { bold: true, size: 22, color: headInk }), run(has(p.role) ? '\t' + p.role : '', { color: dateCol, size: 19 })],
      }));
      const about = p.about || p.description;
      if (has(about)) out.push(new Paragraph({ spacing: { before: 20, after: 30, line: 282 }, children: inlineRuns(about, { size: 20, color: ink }) }));
      arr(p.role_highlights).forEach((h) => out.push(bullet(h, undefined, { color: ink })));
      if (has(p.link)) out.push(new Paragraph({ spacing: { after: 20 }, children: [run(prettyLink(p.link), { size: 19, color: dateCol })] }));
    });
  }

  // ── Education ───────────────────────────────────────────────────────────────
  const edu = arr(d.education);
  if (edu.length) {
    out.push(heading('Education'));
    edu.forEach((e) => {
      const deg = [e.degree, e.field_of_study].filter(has).map(String).join(', ');
      out.push(new Paragraph({
        spacing: { before: 120, after: 0 },
        tabStops: [{ type: TabStopType.RIGHT, position: RIGHT_TAB }],
        children: [run(deg || (has(e.degree) ? String(e.degree) : 'Education'), { bold: true, size: 21, color: headInk }), run(has(e.end_date) ? '\t' + e.end_date : '', { color: dateCol, size: 19 })],
      }));
      const line2 = [e.institution, has(e.grade) ? 'Grade: ' + e.grade : ''].filter(has).map(String).join('  ·  ');
      if (line2) out.push(new Paragraph({ spacing: { after: 30 }, children: [run(line2, { size: 20, color: sub })] }));
    });
  }

  return { children: out, margin: { top: 1080, right: M, bottom: 1080, left: M } };
};

// "linkedin.com/in/x" untouched; strips protocol + trailing slash like prettyUrl.
function prettyLink(u) {
  if (!has(u)) return '';
  return String(u).replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '');
}

// Certification → "Name — Issuer" (handles object or string).
function certLine(c) {
  if (c && typeof c === 'object') {
    const nm = c.name || c.title || '';
    const iss = c.issuer || c.authority || '';
    const yr = c.year || c.date || '';
    const tail = [iss, yr].filter(has).map(String).join(', ');
    return has(tail) ? `${nm} — ${tail}` : String(nm);
  }
  return String(c == null ? '' : c);
}
