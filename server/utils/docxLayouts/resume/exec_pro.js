// Resume Word layout — Executive Professional (exec_pro). Mirrors the PDF:
// a CENTERED header band (uppercase name + tracked title in accent + inline
// contacts) with a single accent rule beneath it, then a SINGLE COLUMN of
// sections — Executive Summary, Leadership Highlights, Professional Experience,
// Strategic Achievements, Certifications, Education. No sidebar, no photo.
// Dark-slate section headings (no per-heading rule), gold dash bullets, dates
// right-aligned in accent. Extra data (technical skills, languages, projects)
// is appended in the same executive style so nothing is dropped.
//
// Contract: module.exports = function build(d, opts, accent) -> { children, margin }
//   d      : resume_data { personal_info, summary, experience[], education[],
//            projects[], skills{technical[],soft[]}, languages[], certifications[], achievements[] }
//   opts   : { photo?: dataURI(square), photoRect?: dataURI(portrait) }  (unused — PDF has no photo)
//   accent : hex string (no '#')
'use strict';

const H = require('../../docxHelpers');
const {
  Paragraph, TextRun, AlignmentType, TabStopType, BorderStyle,
  PAGE_W, has, arr, hex, run, inlineRuns, lighten, prettyUrl,
} = H;

// prettyUrl is not exported by docxHelpers; provide a local fallback.
const tidyUrl = (typeof prettyUrl === 'function')
  ? prettyUrl
  : (u) => String(u == null ? '' : u).replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '').trim();

module.exports = function build(d, opts, accent) {
  d = d || {};
  const pi = d.personal_info || {};
  const ACC = hex(accent);              // darker bronze used for title + dates (#7C6A45)
  const GOLD = lighten(ACC, 0.32);      // lighter gold for the header rule + bullet dashes (~#C9A96A)
  const SLATE = '1E293B';               // dark slate for name + section headings
  const SUB = '5B6473';                 // muted slate for contact + company lines
  const BODY = '3C4654';                // body text

  const M = 1080;                       // ~18mm side margins, ~20mm top/bottom (single column)
  const TOPM = 1134;
  const RIGHT_TAB = PAGE_W - M - M;     // right edge of the content column for date tab stops

  const name = (has(pi.full_name) ? String(pi.full_name) : 'Your Name').toUpperCase();
  const titleRaw = has(pi.title)
    ? pi.title
    : (arr(d.experience)[0] || {}).role || '';

  const out = [];

  // ── Centered header band ────────────────────────────────────────────────────
  out.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: has(titleRaw) ? 70 : 90 },
    children: [run(name, { bold: true, size: 50, color: SLATE, characterSpacing: 60 })],
  }));
  if (has(titleRaw)) {
    out.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 90 },
      children: [run(String(titleRaw).toUpperCase(), { size: 21, color: ACC, characterSpacing: 60 })],
    }));
  }

  const contactBits = [
    has(pi.email) && String(pi.email).trim(),
    has(pi.phone) && String(pi.phone).trim(),
    has(pi.location) && String(pi.location).trim(),
    has(pi.linkedin_url) && tidyUrl(pi.linkedin_url),
    has(pi.portfolio_url) && tidyUrl(pi.portfolio_url),
  ].filter((x) => x && String(x).trim() !== '');
  if (contactBits.length) {
    out.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 0 },
      children: [run(contactBits.join('   •   '), { size: 18, color: SUB })],
    }));
  }

  // Accent rule directly under the centered header (gold tint, like the PDF's 2px border).
  out.push(new Paragraph({
    spacing: { before: 120, after: 60 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: GOLD, space: 2 } },
    children: [run('', { size: 2 })],
  }));

  // ── Section heading helper: dark-slate, uppercase, tracked, NO rule (matches PDF). ──
  const heading = (title) => new Paragraph({
    spacing: { before: 260, after: 110 },
    children: [run(String(title).toUpperCase(), { bold: true, size: 23, color: SLATE, characterSpacing: 30 })],
  });

  // Gold-dash bullet (the PDF uses a short horizontal bar, not a round dot).
  const dash = (text, o = {}) => new Paragraph({
    spacing: { after: 50, line: 270 },
    indent: { left: 260, hanging: 200 },
    tabStops: [{ type: TabStopType.LEFT, position: 260 }],
    children: [
      run('–', { bold: true, color: GOLD, size: 21 }),
      run('\t', { size: 21 }),
      ...inlineRuns(text, { size: 21, color: BODY }),
    ],
  });

  // ── Executive Summary ───────────────────────────────────────────────────────
  if (has(d.summary)) {
    out.push(heading('Executive Summary'));
    // summary may be "paragraph\n• bullet\n• bullet"
    const lines = String(d.summary).split('\n').map((l) => l.trim()).filter(Boolean);
    const paras = lines.filter((l) => !l.startsWith('•'));
    const bullets = lines.filter((l) => l.startsWith('•')).map((l) => l.replace(/^•\s*/, ''));
    paras.forEach((p) => out.push(new Paragraph({
      spacing: { after: 40, line: 290 },
      alignment: AlignmentType.JUSTIFIED,
      children: inlineRuns(p, { size: 21, color: BODY }),
    })));
    bullets.forEach((b) => out.push(dash(b)));
  }

  // ── Leadership Highlights (soft skills) ─────────────────────────────────────
  const soft = arr(d.skills && d.skills.soft);
  if (soft.length) {
    out.push(heading('Leadership Highlights'));
    soft.forEach((s) => out.push(dash(s)));
  }

  // ── Professional Experience ─────────────────────────────────────────────────
  const exp = arr(d.experience);
  if (exp.length) {
    out.push(heading('Professional Experience'));
    exp.forEach((e) => {
      e = e || {};
      const dates = [e.start_date, e.end_date].filter(has).map(String).join(' – ');
      out.push(new Paragraph({
        spacing: { before: 130, after: 0 },
        tabStops: [{ type: TabStopType.RIGHT, position: RIGHT_TAB }],
        children: [
          run(has(e.role) ? e.role : 'Role', { bold: true, size: 23, color: SLATE }),
          run(dates ? '\t' + dates : '', { bold: true, color: ACC, size: 19 }),
        ],
      }));
      const co = [e.company, e.location].filter(has).map(String).join(', ');
      if (co) {
        out.push(new Paragraph({
          spacing: { after: 60 },
          children: [run(co, { italics: true, color: SUB, size: 20 })],
        }));
      }
      arr(e.highlights).forEach((h) => out.push(dash(h, { tight: true })));
    });
  }

  // ── Strategic Achievements ──────────────────────────────────────────────────
  const ach = arr(d.achievements);
  if (ach.length) {
    out.push(heading('Strategic Achievements'));
    ach.forEach((a) => out.push(dash(a)));
  }

  // ── Certifications ──────────────────────────────────────────────────────────
  const certs = arr(d.certifications);
  if (certs.length) {
    out.push(heading('Certifications'));
    certs.forEach((c) => {
      let nm, sub;
      if (c && typeof c === 'object') {
        nm = c.name || c.title || '';
        sub = [c.issuer || c.authority, c.year || c.date].filter(has).map(String).join(' · ');
      } else {
        nm = String(c); sub = '';
      }
      if (!has(nm)) return;
      out.push(new Paragraph({
        spacing: { after: 40, line: 264 },
        indent: { left: 260, hanging: 200 },
        tabStops: [{ type: TabStopType.LEFT, position: 260 }],
        children: [
          run('–', { bold: true, color: GOLD, size: 21 }),
          run('\t', { size: 21 }),
          run(String(nm), { size: 21, color: BODY }),
          run(has(sub) ? '  — ' + sub : '', { size: 20, color: SUB }),
        ],
      }));
    });
  }

  // ── Education ───────────────────────────────────────────────────────────────
  const edu = arr(d.education);
  if (edu.length) {
    out.push(heading('Education'));
    edu.forEach((e) => {
      e = e || {};
      const deg = [e.degree, e.field_of_study].filter(has).map(String).join(', ');
      out.push(new Paragraph({
        spacing: { before: 110, after: 0 },
        tabStops: [{ type: TabStopType.RIGHT, position: RIGHT_TAB }],
        children: [
          run(has(deg) ? deg : (has(e.degree) ? String(e.degree) : 'Education'), { bold: true, size: 22, color: SLATE }),
          run(has(e.end_date) ? '\t' + String(e.end_date) : '', { bold: true, color: ACC, size: 19 }),
        ],
      }));
      const sub = [e.institution, has(e.grade) ? 'Grade: ' + String(e.grade) : ''].filter(has).map(String).join('  ·  ');
      if (has(sub)) {
        out.push(new Paragraph({
          spacing: { after: 30 },
          children: [run(sub, { italics: true, color: SUB, size: 20 })],
        }));
      }
    });
  }

  // ── Projects (data present beyond the PDF's stock sections — keep nothing dropped) ──
  const proj = arr(d.projects);
  if (proj.length) {
    out.push(heading('Projects'));
    proj.forEach((p) => {
      p = p || {};
      const titleLine = [has(p.title) ? String(p.title) : '', has(p.type) ? String(p.type) : '']
        .filter(Boolean).join(' — ');
      out.push(new Paragraph({
        spacing: { before: 110, after: 0 },
        tabStops: [{ type: TabStopType.RIGHT, position: RIGHT_TAB }],
        children: [
          run(has(titleLine) ? titleLine : 'Project', { bold: true, size: 22, color: SLATE }),
          run(has(p.role) ? '\t' + String(p.role) : '', { bold: true, color: ACC, size: 19 }),
        ],
      }));
      if (has(p.about || p.description)) {
        out.push(new Paragraph({
          spacing: { after: 40, line: 270 },
          children: inlineRuns(p.about || p.description, { size: 20, color: BODY }),
        }));
      }
      arr(p.role_highlights).forEach((h) => out.push(dash(h)));
    });
  }

  // ── Technical Skills (present in data; rendered as a clean inline list) ──────
  const tech = arr(d.skills && d.skills.technical);
  if (tech.length) {
    out.push(heading('Technical Skills'));
    out.push(new Paragraph({
      spacing: { after: 20, line: 290 },
      children: [run(tech.map(String).join('   ·   '), { size: 21, color: BODY })],
    }));
  }

  // ── Languages (present in data; right-aligned level like the PDF's dates) ────
  const langs = arr(d.languages);
  if (langs.length) {
    out.push(heading('Languages'));
    langs.forEach((l) => {
      const nm = (l && typeof l === 'object') ? (l.name || l.language || '') : String(l);
      const lv = (l && typeof l === 'object') ? (l.level || l.proficiency || '') : '';
      if (!has(nm)) return;
      out.push(new Paragraph({
        spacing: { after: 16 },
        tabStops: [{ type: TabStopType.RIGHT, position: RIGHT_TAB }],
        children: [
          run(String(nm), { size: 21, color: BODY }),
          run(has(lv) ? '\t' + String(lv) : '', { color: ACC, size: 19 }),
        ],
      }));
    });
  }

  // Never return an empty children array (docx requires ≥1 child).
  if (!out.length) out.push(new Paragraph({ children: [run('', { size: 2 })] }));

  return { children: out, margin: { top: TOPM, right: M, bottom: TOPM, left: M } };
};
