// Resume Word layout — Startup Modern. Mirrors the PDF (startupModern):
// single column, no sidebar, no photo. Hero with big name + accent title + a row
// of rounded contact "chips"; muted-gray uppercase tracked section headings (About,
// Impact, Experience, Projects, Skills, Education); summary paragraphs as About;
// summary bullets as lavender "Impact" cards in a row; experience/projects with the
// role left + date right and accent company line + accent-dot bullets; skills as
// chips. Languages/certifications added in the same chip/list spirit when present.
//
// Contract: module.exports = function build(d, opts, accent) -> { children, margin }
'use strict';

const H = require('../../docxHelpers');
const {
  Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, TabStopType, BorderStyle, WidthType, VerticalAlign, ShadingType,
  PAGE_W, has, arr, run, sectionHeading, inlineRuns, lighten, darken, NO_BORDERS,
} = H;

// Split a summary string the same way the PDF does: lines starting with - or •
// become "Impact" bullet cards; the rest is "About" prose.
function splitSummary(summary) {
  const paras = [];
  const bullets = [];
  String(summary == null ? '' : summary)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .forEach((l) => {
      const m = /^([-*•]|\d+[.)])\s+(.*)$/.exec(l);
      if (m) bullets.push(m[2]);
      else paras.push(l);
    });
  return { paras, bullets };
}

function prettyUrl(u) {
  return String(u == null ? '' : u).replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '');
}

module.exports = function build(d, opts, accent) {
  const pi = d.personal_info || {};
  const M = 1080;                         // ~0.75in side margins (PDF uses 16mm)
  const MT = 1180;                        // ~0.82in top/bottom (PDF uses 18mm)
  const CONTENT_W = PAGE_W - M - M;        // usable column width
  const RIGHT_TAB = CONTENT_W;             // right edge for date tab stops

  const ink = '16161D';                    // near-black headings
  const body = '33334A';                   // body text
  const meta = '8888A0';                   // muted gray (dates, sec headings)
  const sub = '44445A';                    // secondary text inside chips/about-links
  const chipBg = lighten(accent, 0.92);    // ~ #f4f4fb pale lavender
  const chipBorder = lighten(accent, 0.84);// ~ #e5e5f3 chip border
  const cardBg = lighten(accent, 0.94);    // ~ #f7f7fd impact card fill
  const cardBorder = lighten(accent, 0.88);// ~ #ececf6 impact card border

  const name = has(pi.full_name) ? pi.full_name : 'Your Name';
  const title = has(pi.title)
    ? pi.title
    : ((arr(d.experience)[0] || {}).role || '');

  const out = [];

  // ── HERO: name + accent title ───────────────────────────────────────────────
  out.push(new Paragraph({
    spacing: { after: has(title) ? 20 : 60 },
    children: [run(name, { bold: true, size: 56, color: ink, characterSpacing: -6 })],
  }));
  if (has(title)) {
    out.push(new Paragraph({
      spacing: { after: 120 },
      children: [run(title, { bold: true, size: 23, color: accent })],
    }));
  }

  // ── Contact "chips" row (portfolio / linkedin / email / phone) ──────────────
  const chips = [
    has(pi.portfolio_url) && '↗ ' + prettyUrl(pi.portfolio_url),
    has(pi.linkedin_url) && 'in ' + prettyUrl(pi.linkedin_url),
    has(pi.email) && '✉ ' + pi.email,
    has(pi.phone) && '☏ ' + pi.phone,
    has(pi.location) && '⚲ ' + pi.location,
  ].filter(Boolean).map(String);

  if (chips.length) out.push(chipRow(chips, { fill: chipBg, border: chipBorder, color: sub, size: 18, w: CONTENT_W }));

  // ── ABOUT (summary prose) + IMPACT (summary bullets as cards) ───────────────
  const { paras, bullets } = splitSummary(d.summary);
  if (paras.length) {
    out.push(secHeading('About', meta));
    out.push(new Paragraph({
      spacing: { after: 40, line: 300 },
      children: inlineRuns(paras.join(' '), { size: 22, color: body }),
    }));
  }
  if (bullets.length) {
    out.push(secHeading('Impact', meta));
    out.push(cardGrid(bullets, { fill: cardBg, border: cardBorder, color: body, accent, w: CONTENT_W }));
  }

  // ── EXPERIENCE ──────────────────────────────────────────────────────────────
  const exp = arr(d.experience);
  if (exp.length) {
    out.push(secHeading('Experience', meta));
    exp.forEach((e) => {
      const dates = [e.start_date, e.end_date].filter(has).map(String).join(' – ');
      out.push(new Paragraph({
        spacing: { before: 130, after: 0 },
        tabStops: [{ type: TabStopType.RIGHT, position: RIGHT_TAB }],
        children: [
          run(e.role || 'Role', { bold: true, size: 23, color: ink }),
          run(dates ? '\t' + dates : '', { size: 18, color: meta }),
        ],
      }));
      const co = [e.company, e.location].filter(has).map(String).join(', ');
      if (co) out.push(new Paragraph({ spacing: { after: 40 }, children: [run(co, { size: 20, color: accent })] }));
      arr(e.highlights).forEach((h) => out.push(accentBullet(h, { accent, color: body })));
    });
  }

  // ── PROJECTS ──────────────────────────────────────────────────────────────
  const proj = arr(d.projects);
  if (proj.length) {
    out.push(secHeading('Projects', meta));
    proj.forEach((p) => {
      const head = (p.title || 'Project') + (has(p.type) ? ' — ' + p.type : '');
      out.push(new Paragraph({
        spacing: { before: 130, after: 0 },
        tabStops: [{ type: TabStopType.RIGHT, position: RIGHT_TAB }],
        children: [
          run(head, { bold: true, size: 23, color: ink }),
          run(has(p.role) ? '\t' + p.role : '', { size: 18, color: meta }),
        ],
      }));
      const about = p.about || p.description;
      if (has(about)) out.push(new Paragraph({ spacing: { after: 30 }, children: inlineRuns(about, { size: 20, color: sub }) }));
      arr(p.role_highlights).forEach((h) => out.push(accentBullet(h, { accent, color: body })));
      if (has(p.link)) out.push(new Paragraph({ spacing: { after: 20 }, children: [run(prettyUrl(p.link), { size: 18, color: accent })] }));
    });
  }

  // ── SKILLS (chips) ──────────────────────────────────────────────────────────
  const tech = arr(d.skills && d.skills.technical);
  const soft = arr(d.skills && d.skills.soft);
  const allSkills = [...tech, ...soft].map(String);
  if (allSkills.length) {
    out.push(secHeading('Skills', meta));
    out.push(chipRow(allSkills, { fill: chipBg, border: chipBorder, color: sub, size: 19, bold: true, w: CONTENT_W }));
  }

  // ── EDUCATION ──────────────────────────────────────────────────────────────
  const edu = arr(d.education);
  if (edu.length) {
    out.push(secHeading('Education', meta));
    edu.forEach((e) => {
      const deg = [e.degree, e.field_of_study].filter(has).map(String).join(', ');
      out.push(new Paragraph({
        spacing: { before: 120, after: 0 },
        tabStops: [{ type: TabStopType.RIGHT, position: RIGHT_TAB }],
        children: [
          run(deg || e.degree || 'Education', { bold: true, size: 22, color: ink }),
          run(has(e.end_date) ? '\t' + e.end_date : '', { size: 18, color: meta }),
        ],
      }));
      const s = [e.institution, has(e.grade) ? 'Grade: ' + e.grade : ''].filter(has).map(String).join('  ·  ');
      if (s) out.push(new Paragraph({ spacing: { after: 20 }, children: [run(s, { size: 20, color: accent })] }));
    });
  }

  // ── LANGUAGES (in the design's chip spirit) ─────────────────────────────────
  const langs = arr(d.languages);
  if (langs.length) {
    out.push(secHeading('Languages', meta));
    const lchips = langs.map((l) => {
      const n = (l && typeof l === 'object') ? (l.name || l.language || '') : String(l);
      const lv = (l && typeof l === 'object') ? (l.level || l.proficiency || '') : '';
      return has(lv) ? `${n} · ${lv}` : String(n);
    }).filter((t) => t && t.trim());
    if (lchips.length) out.push(chipRow(lchips, { fill: chipBg, border: chipBorder, color: sub, size: 19, bold: true, w: CONTENT_W }));
  }

  // ── CERTIFICATIONS ──────────────────────────────────────────────────────────
  const certs = arr(d.certifications);
  if (certs.length) {
    out.push(secHeading('Certifications', meta));
    certs.forEach((c) => {
      const cn = (c && typeof c === 'object') ? (c.name || c.title || '') : String(c);
      const issuer = (c && typeof c === 'object') ? (c.issuer || c.authority || '') : '';
      const year = (c && typeof c === 'object') ? (c.year || c.date || '') : '';
      const tail = [issuer, year].filter(has).map(String).join(', ');
      if (has(cn)) out.push(accentBullet(has(tail) ? `**${cn}** — ${tail}` : `**${cn}**`, { accent, color: body }));
    });
  }

  // ── ACHIEVEMENTS ──────────────────────────────────────────────────────────
  const ach = arr(d.achievements);
  if (ach.length) {
    out.push(secHeading('Achievements', meta));
    ach.forEach((a) => out.push(accentBullet(a, { accent, color: body })));
  }

  return { children: out, margin: { top: MT, right: M, bottom: MT, left: M } };
};

// ── helpers ──────────────────────────────────────────────────────────────────

// Muted-gray, uppercase, tracked section heading (no rule) — matches .sec-h.
function secHeading(title, color) {
  return sectionHeading(title, color, {
    color, noRule: true, before: 280, after: 110, size: 19, tracking: 18,
  });
}

// Accent-dot bullet — uses the accent colour for the bullet dot via a leading glyph.
function accentBullet(text, o) {
  return new Paragraph({
    spacing: { after: 36, line: 282 },
    indent: { left: 230, hanging: 170 },
    children: [
      run('●  ', { color: o.accent, size: 13 }),
      ...inlineRuns(text, { size: 21, color: o.color }),
    ],
  });
}

// A flowing row of rounded "chips" built as a borderless wrapping table of single
// shaded cells. Word has no flex-wrap, so we lay chips into rows of fixed columns.
function chipRow(items, o) {
  const perRow = 3;
  const colW = Math.floor((o.w - 1) / perRow);
  const rows = [];
  for (let i = 0; i < items.length; i += perRow) {
    const slice = items.slice(i, i + perRow);
    const cells = [];
    for (let j = 0; j < perRow; j++) {
      const txt = slice[j];
      cells.push(new TableCell({
        width: { size: colW, type: WidthType.DXA },
        margins: { top: 28, bottom: 28, left: 70, right: 70 },
        verticalAlign: VerticalAlign.CENTER,
        borders: txt != null ? cellBox(o.border) : NO_BORDERS,
        shading: txt != null ? { type: ShadingType.CLEAR, fill: o.fill, color: 'auto' } : undefined,
        children: [new Paragraph({
          alignment: AlignmentType.LEFT,
          children: txt != null ? [run(String(txt), { size: o.size || 18, color: o.color, bold: !!o.bold })] : [run('')],
        })],
      }));
    }
    rows.push(new TableRow({ children: cells }));
  }
  return new Table({
    width: { size: o.w, type: WidthType.DXA },
    columnWidths: Array(perRow).fill(colW),
    borders: NO_BORDERS,
    layout: 'fixed',
    rows,
  });
}

// "Impact" cards — same wrapping-grid idea, taller padded cells, bold runs in accent.
function cardGrid(items, o) {
  const perRow = items.length >= 3 ? 3 : items.length;
  const colW = Math.floor((o.w - 1) / perRow);
  const rows = [];
  for (let i = 0; i < items.length; i += perRow) {
    const slice = items.slice(i, i + perRow);
    const cells = [];
    for (let j = 0; j < perRow; j++) {
      const txt = slice[j];
      cells.push(new TableCell({
        width: { size: colW, type: WidthType.DXA },
        margins: { top: 90, bottom: 90, left: 130, right: 130 },
        verticalAlign: VerticalAlign.TOP,
        borders: txt != null ? cellBox(o.border) : NO_BORDERS,
        shading: txt != null ? { type: ShadingType.CLEAR, fill: o.fill, color: 'auto' } : undefined,
        children: [new Paragraph({
          spacing: { line: 264 },
          children: txt != null ? inlineRuns(txt, { size: 19, color: o.color }) : [run('')],
        })],
      }));
    }
    rows.push(new TableRow({ children: cells }));
  }
  return new Table({
    width: { size: o.w, type: WidthType.DXA },
    columnWidths: Array(perRow).fill(colW),
    borders: NO_BORDERS,
    layout: 'fixed',
    rows,
  });
}

// Thin uniform box border for a chip/card cell.
function cellBox(color) {
  const b = { style: BorderStyle.SINGLE, size: 4, color, space: 0 };
  return { top: b, bottom: b, left: b, right: b };
}
