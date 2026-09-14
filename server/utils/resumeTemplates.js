// Resume Builder — new feature. Safe to delete without affecting existing app.
'use strict';

/**
 * Dynamic resume templates.
 *
 * Each builder takes the saved `resume_data` object (see resumeBuilderController)
 * plus an options bag ({ photo: <dataURI|null> }) and returns a full, self-contained
 * HTML document. The HTML is rendered to PDF / preview image by resumeRenderer.js
 * using Playwright (same chromium the scraper already uses in production).
 *
 * Three designs, mirroring the user-supplied reference HTML:
 *   1. azure     — "Azure Sidebar"   (blue gradient sidebar + timeline)
 *   2. executive — "Executive Dark"  (dark slate + gold accents, star skills)
 *   3. minimal   — "Modern Minimal"  (top header + two-column body, chips)
 */

// ── Text helpers ──────────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// The Resume-Builder editor now stores rich HTML for prose fields. Collapse it to the **markdown**
// these templates already understand (bold preserved; heading→bold; italic/underline→plain) so the
// rendered resume shows the emphasis instead of literal tags. Legacy **markdown** passes through.
function demote(s) {
  return String(s == null ? '' : s)
    .replace(/<\/(strong|b)>/gi, '**').replace(/<(strong|b)\b[^>]*>/gi, '**')
    .replace(/<h[1-6][^>]*>/gi, '**').replace(/<\/h[1-6]>/gi, '**\n')
    .replace(/<(em|i|u)\b[^>]*>/gi, '').replace(/<\/(em|i|u)>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n').replace(/<(p|div|li)[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#39;/gi, "'").replace(/&quot;/gi, '"');
}

// Escape, then turn **keyword** into <b>keyword</b>, dropping any stray asterisks.
function fmt(s) {
  return esc(demote(s))
    .replace(/\*\*(.+?)\*\*/g, '\x01$1\x02')
    .replace(/\*/g, '')
    .replace(/\x01(.+?)\x02/g, '<b>$1</b>');
}

// Plain escaped text with all ** markers stripped (no bold).
function plain(s) {
  return esc(demote(s).replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*/g, ''));
}

// Raw (un-escaped) plain text — for splitting names, etc.
function raw(s) {
  return demote(s).replace(/\*+/g, '').trim();
}

function nonEmpty(arr) {
  return Array.isArray(arr) ? arr.filter(x => x != null && String(x).trim() !== '') : [];
}

// Split the AI summary ("paragraph\n• bullet\n• bullet") into { paras, bullets }.
function splitSummary(summary) {
  const lines = demote(summary).split('\n').map(l => l.trim()).filter(Boolean);
  return {
    paras:   lines.filter(l => !l.startsWith('•')),
    bullets: lines.filter(l => l.startsWith('•')).map(l => l.replace(/^•\s*/, '')),
  };
}

function dateRange(a, b) {
  return [a, b].map(raw).filter(Boolean).join(' – ');
}

// ── Shared SVG icons (inherit `fill` from CSS) ────────────────────────────────
const ICON = {
  phone:    '<svg viewBox="0 0 24 24"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.2.2 2.4.6 3.6.1.4 0 .8-.3 1l-2.2 2.2z"/></svg>',
  mail:     '<svg viewBox="0 0 24 24"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4-8 5-8-5V6l8 5 8-5v2z"/></svg>',
  pin:      '<svg viewBox="0 0 24 24"><path d="M12 2C8.1 2 5 5.1 5 9c0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>',
  link:     '<svg viewBox="0 0 24 24"><path d="M3.9 12c0-1.7 1.4-3.1 3.1-3.1h4V7H7c-2.8 0-5 2.2-5 5s2.2 5 5 5h4v-1.9H7c-1.7 0-3.1-1.4-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.7 0 3.1 1.4 3.1 3.1s-1.4 3.1-3.1 3.1h-4V17h4c2.8 0 5-2.2 5-5s-2.2-5-5-5z"/></svg>',
  user:     '<svg viewBox="0 0 24 24" fill="#fff"><path d="M12 12c2.7 0 4.9-2.2 4.9-4.9S14.7 2.2 12 2.2 7.1 4.4 7.1 7.1 9.3 12 12 12zm0 2.4c-3.3 0-9.8 1.6-9.8 4.9v2.5h19.6v-2.5c0-3.3-6.5-4.9-9.8-4.9z"/></svg>',
  doc:      '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>',
  bag:      '<svg viewBox="0 0 24 24"><path d="M20 6h-4V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zm-6 0h-4V4h4v2z"/></svg>',
  layers:   '<svg viewBox="0 0 24 24"><path d="M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>',
  check:    '<svg viewBox="0 0 24 24"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>',
  cap:      '<svg viewBox="0 0 24 24"><path d="M12 3 1 9l11 6 9-4.9V17h2V9L12 3zm0 13.5L4.5 12 12 7.9 19.5 12 12 16.5zM5 14.2v3.3l7 3.8 7-3.8v-3.3l-7 3.8-7-3.8z"/></svg>',
};

// Two initials from a full name (e.g. "Rishi Samadhiya" → "RS").
function initialsOf(name) {
  const parts = raw(name).split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  if (parts.length === 1) return (parts[0][0] || '').toUpperCase();
  return ((parts[0][0] || '') + (parts[parts.length - 1][0] || '')).toUpperCase();
}

// Avatar contents: the real photo if present, else the person's initials,
// else a neutral silhouette. `iniColor` tints the initials/silhouette.
function avatarMarkup(photo, fullName, iniColor, svgClass) {
  if (photo) return `<img src="${esc(photo)}" alt="">`;
  const ini = initialsOf(fullName);
  if (ini) return `<span class="ini" style="font-family:'Poppins',sans-serif;font-weight:700;font-size:46px;letter-spacing:1px;color:${iniColor}">${esc(ini)}</span>`;
  const cls = svgClass ? ` class="${svgClass}"` : '';
  return `<svg${cls} viewBox="0 0 24 24" fill="${iniColor}"><path d="M12 12c2.7 0 4.9-2.2 4.9-4.9S14.7 2.2 12 2.2 7.1 4.4 7.1 7.1 9.3 12 12 12zm0 2.4c-3.3 0-9.8 1.6-9.8 4.9v2.5h19.6v-2.5c0-3.3-6.5-4.9-9.8-4.9z"/></svg>`;
}

// Contact rows shared markup builder (rowClass + svg inherit styling from template)
function contactRows(pi, rowClass) {
  const rows = [];
  if (raw(pi.phone))    rows.push(`<div class="${rowClass}">${ICON.phone}<span>${plain(pi.phone)}</span></div>`);
  if (raw(pi.email))    rows.push(`<div class="${rowClass}">${ICON.mail}<span>${plain(pi.email)}</span></div>`);
  if (raw(pi.location)) rows.push(`<div class="${rowClass}">${ICON.pin}<span>${plain(pi.location)}</span></div>`);
  if (raw(pi.linkedin_url))  rows.push(`<div class="${rowClass}">${ICON.link}<span>${plain(prettyUrl(pi.linkedin_url))}</span></div>`);
  if (raw(pi.portfolio_url)) rows.push(`<div class="${rowClass}">${ICON.link}<span>${plain(prettyUrl(pi.portfolio_url))}</span></div>`);
  return rows.join('');
}

function prettyUrl(u) {
  return raw(u).replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
}

function nameSplit(fullName) {
  const parts = raw(fullName || 'Your Name').split(/\s+/);
  const first = parts.shift() || '';
  return { first, rest: parts.join(' ') };
}

// @page rule per output mode:
//   a4      → real A4 pages with 14mm top/bottom breathing room (sides full-bleed).
//             Drop the sheet's 297mm min-height (the fixed .page-bg fills the page),
//             otherwise a short resume would spill onto a near-empty 2nd page.
//   onepage → one continuous page (renderer sets the exact height; no breaks).
function pageRule(mode) {
  // A4: real pages with a 14mm top/bottom margin on the CONTENT. The sidebar band
  // is painted on the root element, which Chromium propagates to the full page
  // canvas — so it already bleeds past these margins to the page edges.
  // min-height:0 stops a short resume from spilling onto a near-empty 2nd page.
  // @page :first{margin-top:0} removes the breathing-room margin from the TOP of the
  // FIRST page only — content/header starts flush at the top. Pages 2+ keep the 14mm
  // top margin and every page keeps the 14mm bottom margin, so content is never cut at
  // a page break. Margins apply to CONTENT only; the sidebar band fills the full page.
  return mode === 'a4'
    ? '@page{size:A4;margin:14mm 0}@page :first{margin-top:0}\n  .sheet{min-height:0}'
    : '@page{margin:0}';
}

// Build the Google-Fonts <head> shared by every template.
function fontsHead(title) {
  return `<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&family=Lato:wght@300;400;700&display=swap" rel="stylesheet">`;
}

// ══════════════════════════════════════════════════════════════════════════════
// TEMPLATE 1 · AZURE SIDEBAR
// ══════════════════════════════════════════════════════════════════════════════
function azure(d, opts = {}) {
  const pi   = d.personal_info || {};
  const exp  = nonEmpty(d.experience).length ? d.experience : [];
  const edu  = nonEmpty(d.education).length ? d.education : [];
  const proj = nonEmpty(d.projects).length ? d.projects : [];
  const tech = nonEmpty(d.skills && d.skills.technical).slice(0, 9);
  const soft = nonEmpty(d.skills && d.skills.soft).slice(0, 6);
  const { first, rest } = nameSplit(pi.full_name);
  const role = plain(exp[0] && exp[0].role || 'Professional');
  const { paras, bullets } = splitSummary(d.summary);

  // Decorative bar widths — strong & gently tapered (no fabricated percentages shown).
  const bars = tech.map((sk, i) => {
    const w = Math.max(78, 95 - i * 3);
    return `<div class="bar"><div class="lbl"><span>${plain(sk)}</span></div><div class="track"><div class="fill" style="width:${w}%"></div></div></div>`;
  }).join('');

  const eduHtml = edu.map((e, i) => {
    const last = i === edu.length - 1 ? ' style="margin-bottom:0"' : '';
    const deg  = [raw(e.degree), raw(e.field_of_study)].filter(Boolean).join(' · ');
    return `<div class="edu-item"${last}>
      <div class="d">${plain(deg || e.degree)}</div>
      ${raw(e.institution) ? `<div class="s">${plain(e.institution)}</div>` : ''}
      ${raw(e.end_date) ? `<div class="y">${plain(e.end_date)}</div>` : ''}
      ${raw(e.grade) ? `<div class="s">${plain(e.grade)}</div>` : ''}
    </div>`;
  }).join('');

  const jobsHtml = exp.map((e, i) => {
    const last = i === exp.length - 1 ? ' style="margin-bottom:0"' : '';
    const co   = [raw(e.company), raw(e.location)].filter(Boolean).join(' · ');
    const lis  = nonEmpty(e.highlights).map(h => `<li>${fmt(h)}</li>`).join('');
    return `<div class="job"${last}>
      <div class="top"><span class="t">${plain(e.role)}</span><span class="when">${plain(dateRange(e.start_date, e.end_date))}</span></div>
      ${co ? `<div class="co">${plain(co)}</div>` : ''}
      ${lis ? `<ul>${lis}</ul>` : ''}
    </div>`;
  }).join('');

  const projHtml = proj.map((p, i) => {
    const last = i === proj.length - 1 ? ' style="margin-bottom:0"' : '';
    const title = `<b>${plain(p.title)}</b>${raw(p.type) ? ` — ${plain(p.type)}` : ''}`;
    const lis = nonEmpty(p.role_highlights).map(h => `<li>${fmt(h)}</li>`).join('');
    return `<div class="proj"${last}>
      ${raw(p.role) ? `<div class="role">${plain(p.role)}</div>` : ''}
      <div class="t">${title}</div>
      ${raw(p.about || p.description) ? `<p>${fmt(p.about || p.description)}</p>` : ''}
      ${lis ? `<ul class="proj-li">${lis}</ul>` : ''}
    </div>`;
  }).join('');

  return `<!DOCTYPE html><html lang="en"><head>${fontsHead('Resume — Azure Sidebar')}<style>
  :root{--blue-1:#0a7aa6;--blue-2:#0e6e93;--blue-3:#13567a;--accent:#3fb9e6;--ink:#26303a;--muted:#6b7785;--line:#e6ebef;--bar-track:rgba(255,255,255,.22);--sidebar-text:#dff1f8;}
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{background:#fff;font-family:'Lato',-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:var(--ink)}
  body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .sheet{width:210mm;min-height:297mm;background:#fff;display:flex;overflow:hidden}
  .side{width:75mm;flex:0 0 75mm;color:var(--sidebar-text);background:linear-gradient(160deg,var(--blue-1) 0%,var(--blue-2) 55%,var(--blue-3) 100%);padding:30px 24px 34px}
  .avatar{width:128px;height:128px;border-radius:50%;margin:2px auto 22px;overflow:hidden;background:rgba(255,255,255,.14);border:4px solid rgba(255,255,255,.55);display:flex;align-items:center;justify-content:center;box-shadow:0 8px 18px rgba(0,0,0,.18)}
  .avatar img{width:100%;height:100%;object-fit:cover;display:block}
  .avatar svg{width:74px;height:74px;opacity:.85}
  .side h2{font-family:'Poppins',sans-serif;font-weight:600;font-size:12.5px;letter-spacing:2px;text-transform:uppercase;color:#fff;margin-bottom:12px;display:flex;align-items:center;gap:9px}
  .side h2::before{content:"";width:16px;height:2px;background:var(--accent);display:inline-block}
  .side section{margin-bottom:24px}
  .contact-row{display:flex;align-items:flex-start;gap:10px;font-size:12px;line-height:1.45;margin-bottom:11px;word-break:break-word}
  .contact-row svg{width:15px;height:15px;flex:0 0 15px;margin-top:1px;fill:var(--accent)}
  .bar{margin-bottom:11px}
  .bar .lbl{display:flex;justify-content:space-between;font-size:11.5px;margin-bottom:4px;color:#fff;font-weight:700}
  .bar .track{height:6px;border-radius:6px;background:var(--bar-track);overflow:hidden}
  .bar .fill{height:100%;border-radius:6px;background:linear-gradient(90deg,var(--accent),#bfe9f8)}
  .soft li{list-style:none;font-size:12px;line-height:1.5;margin-bottom:7px;display:flex;gap:8px;align-items:flex-start}
  .soft li::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--accent);margin-top:6px;flex:0 0 6px}
  .edu-item{margin-bottom:13px}
  .edu-item .d{font-family:'Poppins',sans-serif;font-weight:600;font-size:12px;color:#fff;line-height:1.3}
  .edu-item .s{font-size:11px;color:var(--sidebar-text);opacity:.9}
  .edu-item .y{font-size:10.5px;color:var(--accent);font-weight:700;margin-top:1px}
  .main{flex:1;padding:34px 34px 30px 32px;min-width:0}
  .name{font-family:'Poppins',sans-serif;font-weight:700;font-size:34px;line-height:1.02;color:var(--blue-2);letter-spacing:.5px}
  .name span{color:var(--ink)}
  .role{font-family:'Poppins',sans-serif;font-weight:400;font-size:13.5px;letter-spacing:3px;text-transform:uppercase;color:var(--muted);margin-top:6px}
  .rule{height:3px;width:64px;background:var(--accent);border-radius:3px;margin:14px 0 4px}
  .sec{margin-top:22px}
  .sec h3{font-family:'Poppins',sans-serif;font-weight:600;font-size:14px;letter-spacing:1.5px;text-transform:uppercase;color:var(--blue-2);display:flex;align-items:center;gap:10px;margin-bottom:12px}
  .sec h3 .ic{width:26px;height:26px;border-radius:7px;background:rgba(10,122,166,.10);display:flex;align-items:center;justify-content:center;flex:0 0 26px}
  .sec h3 .ic svg{width:15px;height:15px;fill:var(--blue-1)}
  .summary{font-size:12.6px;line-height:1.62;color:#46525e;margin-bottom:8px}
  .sum-bullets{list-style:none;margin-top:4px}
  .sum-bullets li{position:relative;font-size:12.2px;line-height:1.5;color:#46525e;padding-left:14px;margin-bottom:4px}
  .sum-bullets li::before{content:"";position:absolute;left:0;top:7px;width:5px;height:5px;border-radius:50%;background:var(--accent)}
  .tl{position:relative;padding-left:24px}
  .tl::before{content:"";position:absolute;left:6px;top:5px;bottom:4px;width:2px;background:var(--line)}
  .job{position:relative;margin-bottom:16px}
  .job::before{content:"";position:absolute;left:-23px;top:4px;width:12px;height:12px;border-radius:50%;background:#fff;border:3px solid var(--blue-1)}
  .job .top{display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap}
  .job .t{font-family:'Poppins',sans-serif;font-weight:600;font-size:13.5px;color:var(--ink)}
  .job .when{font-size:11px;font-weight:700;color:var(--blue-1);white-space:nowrap}
  .job .co{font-size:11.8px;color:var(--muted);font-style:italic;margin:1px 0 7px}
  .job ul{margin:0;padding-left:0;list-style:none}
  .job li{position:relative;font-size:12px;line-height:1.5;color:#46525e;padding-left:14px;margin-bottom:4px}
  .job li::before{content:"";position:absolute;left:0;top:7px;width:5px;height:5px;border-radius:50%;background:var(--accent)}
  .proj{margin-bottom:11px}
  .proj .t{font-family:'Poppins',sans-serif;font-weight:600;font-size:12.6px;color:var(--ink)}
  .proj .t b{color:var(--blue-1);font-weight:600}
  .proj .role{font-size:10.5px;letter-spacing:1px;color:var(--accent);text-transform:uppercase;margin:0 0 2px;font-weight:700}
  .proj p{font-size:11.7px;line-height:1.5;color:#56616c}
  .proj-li{list-style:none;margin-top:4px}
  .proj-li li{position:relative;font-size:11.7px;line-height:1.5;color:#56616c;padding-left:14px;margin-bottom:3px}
  .proj-li li::before{content:"";position:absolute;left:0;top:6px;width:5px;height:5px;border-radius:50%;background:var(--accent)}
  /* One-page: paint the sidebar band on the root element (fills the single page).
     A4: render fully transparent — the band is composited behind every page by the
     renderer (pdf-lib), the only reliable way to fill multi-page sidebars. */
  ${opts.mode === 'a4'
    ? 'html,body{background:transparent;-webkit-print-color-adjust:exact;print-color-adjust:exact}'
    : 'html{background-color:#fff;background-image:linear-gradient(160deg,var(--blue-1) 0%,var(--blue-2) 55%,var(--blue-3) 100%);background-repeat:no-repeat;background-position:left top;background-size:75mm 100%;-webkit-print-color-adjust:exact;print-color-adjust:exact}body{background:transparent}'}
  .sheet{background:transparent;overflow:visible}
  .side{background:transparent}
  .sec h3{break-inside:avoid;break-after:avoid}
  .job,.proj,.edu-item,.bar,.contact-row,.soft li,.sum-bullets li,.job li,.proj p,.proj-li li{break-inside:avoid}
  ${pageRule(opts.mode)}
</style></head><body>
  <div class="sheet">
    <aside class="side">
      <div class="avatar">${avatarMarkup(opts.photo, pi.full_name, '#ffffff')}</div>
      ${contactRows(pi, 'contact-row') ? `<section><h2>Contact</h2>${contactRows(pi, 'contact-row')}</section>` : ''}
      ${bars ? `<section><h2>Tech Skills</h2>${bars}</section>` : ''}
      ${soft.length ? `<section><h2>Soft Skills</h2><ul class="soft">${soft.map(s => `<li>${plain(s)}</li>`).join('')}</ul></section>` : ''}
      ${eduHtml ? `<section style="margin-bottom:0"><h2>Education</h2>${eduHtml}</section>` : ''}
    </aside>
    <main class="main">
      <div class="name">${esc(first)} <span>${esc(rest)}</span></div>
      <div class="role">${role}</div>
      <div class="rule"></div>
      ${(paras.length || bullets.length) ? `<section class="sec"><h3><span class="ic">${ICON.doc}</span>Professional Summary</h3>
        ${paras.map(p => `<p class="summary">${fmt(p)}</p>`).join('')}
        ${bullets.length ? `<ul class="sum-bullets">${bullets.map(b => `<li>${fmt(b)}</li>`).join('')}</ul>` : ''}</section>` : ''}
      ${jobsHtml ? `<section class="sec"><h3><span class="ic">${ICON.bag}</span>Experience</h3><div class="tl">${jobsHtml}</div></section>` : ''}
      ${projHtml ? `<section class="sec"><h3><span class="ic">${ICON.layers}</span>Key Projects</h3>${projHtml}</section>` : ''}
    </main>
  </div>
</body></html>`;
}

// ══════════════════════════════════════════════════════════════════════════════
// TEMPLATE 2 · EXECUTIVE DARK
// ══════════════════════════════════════════════════════════════════════════════
function executive(d, opts = {}) {
  const pi   = d.personal_info || {};
  const exp  = nonEmpty(d.experience).length ? d.experience : [];
  const edu  = nonEmpty(d.education).length ? d.education : [];
  const proj = nonEmpty(d.projects).length ? d.projects : [];
  const tech = nonEmpty(d.skills && d.skills.technical).slice(0, 9);
  const soft = nonEmpty(d.skills && d.skills.soft).slice(0, 6);
  const { first, rest } = nameSplit(pi.full_name);
  const role = plain(exp[0] && exp[0].role || 'Professional');
  const { paras, bullets } = splitSummary(d.summary);

  const stars = (n) => {
    let h = '';
    for (let i = 1; i <= 5; i++) {
      h += `<svg viewBox="0 0 24 24" class="${i <= n ? 'on' : 'off'}"><path d="M12 2l2.9 6.3 6.9.7-5.1 4.6 1.4 6.8L12 17.8 5.9 20.4l1.4-6.8L2.2 9l6.9-.7L12 2z"/></svg>`;
    }
    return h;
  };
  // Strong, deterministic star levels (4–5) so nothing reads as "weak".
  const skillRows = tech.map((sk, i) => {
    const n = i < Math.ceil(tech.length / 2) ? 5 : 4;
    return `<div class="srow"><span class="s-name">${plain(sk)}</span><span class="stars">${stars(n)}</span></div>`;
  }).join('');

  const intro = paras.length
    ? `<p class="intro">${fmt(paras.join(' '))}</p>`
    : '';

  const workHtml = exp.map(e => {
    const dr = dateRange(e.start_date, e.end_date).split(' – ');
    const start = dr[0] || '';
    const end   = dr[1] || '';
    const co = [raw(e.company), raw(e.location)].filter(Boolean).join(' · ');
    const lis = nonEmpty(e.highlights).map(h => `<li>${fmt(h)}</li>`).join('');
    return `<div class="entry">
      <div class="when">${plain(start)}${end ? `<span class="sub">– ${plain(end)}</span>` : ''}</div>
      <div>
        <div class="t">${plain(e.role)}</div>
        ${co ? `<div class="co">${plain(co)}</div>` : ''}
        ${lis ? `<ul>${lis}</ul>` : ''}
      </div>
    </div>`;
  }).join('');

  const projHtml = proj.map(p => {
    const lis = nonEmpty(p.role_highlights).map(h => `<li>${fmt(h)}</li>`).join('');
    return `<div class="entry">
      <div class="when">${plain(p.type || 'Project')}</div>
      <div>
        ${raw(p.role) ? `<span class="role-tag">${plain(p.role)}</span>` : ''}
        <div class="t">${plain(p.title)}</div>
        ${raw(p.about || p.description) ? `<p>${fmt(p.about || p.description)}</p>` : ''}
        ${lis ? `<ul>${lis}</ul>` : ''}
      </div>
    </div>`;
  }).join('');

  const eduHtml = edu.map(e => {
    const deg = [raw(e.degree), raw(e.field_of_study)].filter(Boolean).join(' — ');
    const sub = [raw(e.institution), raw(e.grade)].filter(Boolean).join(' · ');
    return `<div class="entry">
      <div class="when">${plain(e.end_date)}</div>
      <div><div class="t">${plain(deg || e.degree)}</div>${sub ? `<div class="co">${plain(sub)}</div>` : ''}</div>
    </div>`;
  }).join('');

  return `<!DOCTYPE html><html lang="en"><head>${fontsHead('Resume — Executive Dark')}<style>
  :root{--bg-1:#2c3742;--bg-2:#222b34;--gold:#e0a64b;--gold-soft:#f0c987;--ink:#2b333b;--muted:#6f7a85;--line:#e7eaed;--star-off:#566370;}
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{background:#fff;font-family:'Lato',-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:var(--ink)}
  body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .sheet{width:210mm;min-height:297mm;background:#fff;display:flex;overflow:hidden}
  .side{width:74mm;flex:0 0 74mm;background:linear-gradient(180deg,var(--bg-1),var(--bg-2));color:#cfd6dd;padding:32px 24px 34px}
  .avatar{width:130px;height:130px;border-radius:50%;margin:0 auto 18px;overflow:hidden;display:flex;align-items:center;justify-content:center;background:#3a4651;border:3px solid var(--gold);box-shadow:0 8px 20px rgba(0,0,0,.28)}
  .avatar img{width:100%;height:100%;object-fit:cover;display:block}
  .avatar svg{width:72px;height:72px;opacity:.85}
  .id{text-align:center;margin-bottom:6px}
  .id .n1{font-family:'Poppins',sans-serif;font-weight:700;font-size:25px;color:#fff;line-height:1.05;letter-spacing:.5px}
  .id .n2{font-family:'Poppins',sans-serif;font-weight:300;font-size:25px;color:var(--gold);line-height:1.05;letter-spacing:.5px}
  .id .role{font-size:11px;letter-spacing:2.5px;text-transform:uppercase;color:#aab3bc;margin-top:7px}
  .divider{height:1px;background:rgba(255,255,255,.14);margin:22px 0}
  .side h2{font-family:'Poppins',sans-serif;font-weight:600;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#fff;margin-bottom:13px}
  .side h2 b{color:var(--gold);font-weight:600}
  .side section{margin-bottom:22px}
  .crow{display:flex;gap:10px;align-items:flex-start;font-size:11.6px;line-height:1.45;margin-bottom:10px;word-break:break-word}
  .crow svg{width:14px;height:14px;flex:0 0 14px;margin-top:2px;fill:var(--gold)}
  .srow{display:flex;justify-content:space-between;align-items:center;margin-bottom:9px;gap:8px}
  .srow .s-name{font-size:11.8px;color:#dfe4e9}
  .stars{display:flex;gap:3px;flex:0 0 auto}
  .stars svg{width:13px;height:13px}
  .stars .on{fill:var(--gold)}
  .stars .off{fill:var(--star-off)}
  .soft li{list-style:none;font-size:11.8px;line-height:1.5;margin-bottom:7px;display:flex;gap:8px;align-items:flex-start}
  .soft li::before{content:"";width:6px;height:6px;border-radius:1px;background:var(--gold);margin-top:5px;flex:0 0 6px;transform:rotate(45deg)}
  .main{flex:1;padding:34px 36px 30px 34px;min-width:0}
  .intro{font-size:12.6px;line-height:1.62;color:#4a555f;border-left:3px solid var(--gold);padding:2px 0 2px 16px;margin-bottom:6px}
  .sum-bullets{list-style:none;margin:8px 0 0 16px}
  .sum-bullets li{position:relative;font-size:12px;line-height:1.5;color:#4a555f;padding-left:15px;margin-bottom:4px}
  .sum-bullets li::before{content:"";position:absolute;left:0;top:7px;width:5px;height:5px;border-radius:50%;background:var(--bg-1)}
  .sec{margin-top:24px}
  .sec h3{font-family:'Poppins',sans-serif;font-weight:600;font-size:15px;letter-spacing:1px;color:var(--bg-1);text-transform:uppercase;padding-bottom:8px;border-bottom:2px solid var(--line);margin-bottom:14px;position:relative}
  .sec h3::after{content:"";position:absolute;left:0;bottom:-2px;width:54px;height:2px;background:var(--gold)}
  .entry{display:grid;grid-template-columns:84px 1fr;gap:14px;margin-bottom:16px}
  .entry .when{font-size:10.8px;font-weight:700;color:var(--gold);text-align:right;line-height:1.35;padding-top:2px}
  .entry .when .sub{display:block;color:var(--muted);font-weight:400;font-size:10px;margin-top:3px}
  .entry .t{font-family:'Poppins',sans-serif;font-weight:600;font-size:13.5px;color:var(--ink)}
  .entry .co{font-size:11.8px;font-style:italic;color:var(--muted);margin:1px 0 7px}
  .entry ul{list-style:none}
  .entry li{position:relative;font-size:12px;line-height:1.5;color:#4a555f;padding-left:15px;margin-bottom:4px}
  .entry li::before{content:"";position:absolute;left:0;top:7px;width:5px;height:5px;border-radius:50%;background:var(--bg-1)}
  .entry .role-tag{display:inline-block;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--gold);font-weight:700;margin-bottom:3px}
  .entry p{font-size:11.8px;line-height:1.5;color:#56616c}
  /* One-page: paint band on root. A4: transparent (band composited by renderer). */
  ${opts.mode === 'a4'
    ? 'html,body{background:transparent;-webkit-print-color-adjust:exact;print-color-adjust:exact}'
    : 'html{background-color:#fff;background-image:linear-gradient(180deg,var(--bg-1),var(--bg-2));background-repeat:no-repeat;background-position:left top;background-size:74mm 100%;-webkit-print-color-adjust:exact;print-color-adjust:exact}body{background:transparent}'}
  .sheet{background:transparent;overflow:visible}
  .side{background:transparent}
  .sec h3{break-inside:avoid;break-after:avoid}
  .entry,.crow,.srow,.soft li,.intro,.sum-bullets li,.entry li{break-inside:avoid}
  ${pageRule(opts.mode)}
</style></head><body>
  <div class="sheet">
    <aside class="side">
      <div class="avatar">${avatarMarkup(opts.photo, pi.full_name, '#e0a64b')}</div>
      <div class="id">
        <div class="n1">${esc(first)}</div>
        ${rest ? `<div class="n2">${esc(rest)}</div>` : ''}
        <div class="role">${role}</div>
      </div>
      <div class="divider"></div>
      ${contactRows(pi, 'crow') ? `<section><h2>Con<b>tact</b></h2>${contactRows(pi, 'crow')}</section>` : ''}
      ${skillRows ? `<section><h2>Tech <b>Skills</b></h2>${skillRows}</section>` : ''}
      ${soft.length ? `<section style="margin-bottom:0"><h2>Core <b>Strengths</b></h2><ul class="soft">${soft.map(s => `<li>${plain(s)}</li>`).join('')}</ul></section>` : ''}
    </aside>
    <main class="main">
      ${intro}
      ${bullets.length ? `<ul class="sum-bullets">${bullets.map(b => `<li>${fmt(b)}</li>`).join('')}</ul>` : ''}
      ${workHtml ? `<section class="sec"><h3>Work History</h3>${workHtml}</section>` : ''}
      ${projHtml ? `<section class="sec"><h3>Key Projects</h3>${projHtml}</section>` : ''}
      ${eduHtml ? `<section class="sec"><h3>Education</h3>${eduHtml}</section>` : ''}
    </main>
  </div>
</body></html>`;
}

// ══════════════════════════════════════════════════════════════════════════════
// TEMPLATE 3 · MODERN MINIMAL
// ══════════════════════════════════════════════════════════════════════════════
function minimal(d, opts = {}) {
  const pi   = d.personal_info || {};
  const exp  = nonEmpty(d.experience).length ? d.experience : [];
  const edu  = nonEmpty(d.education).length ? d.education : [];
  const proj = nonEmpty(d.projects).length ? d.projects : [];
  const tech = nonEmpty(d.skills && d.skills.technical);
  const soft = nonEmpty(d.skills && d.skills.soft).slice(0, 7);
  const { first, rest } = nameSplit(pi.full_name);
  const role = plain(exp[0] && exp[0].role || 'Professional');
  const { paras, bullets } = splitSummary(d.summary);

  // Split technical skills into two chip groups for visual rhythm.
  const half = Math.ceil(tech.length / 2);
  const expertise = tech.slice(0, half);
  const tools     = tech.slice(half);

  const contactsHead = [];
  if (raw(pi.phone))    contactsHead.push(`<span>${ICON.phone}${plain(pi.phone)}</span>`);
  if (raw(pi.email))    contactsHead.push(`<span>${ICON.mail}${plain(pi.email)}</span>`);
  if (raw(pi.location)) contactsHead.push(`<span>${ICON.pin}${plain(pi.location)}</span>`);
  if (raw(pi.linkedin_url))  contactsHead.push(`<span>${ICON.link}${plain(prettyUrl(pi.linkedin_url))}</span>`);
  if (raw(pi.portfolio_url)) contactsHead.push(`<span>${ICON.link}${plain(prettyUrl(pi.portfolio_url))}</span>`);

  const jobsHtml = exp.map(e => {
    const co = [raw(e.company), raw(e.location)].filter(Boolean).join(' · ');
    const lis = nonEmpty(e.highlights).map(h => `<li>${fmt(h)}</li>`).join('');
    return `<div class="job">
      <div class="top"><span class="t">${plain(e.role)}</span><span class="when">${plain(dateRange(e.start_date, e.end_date).toUpperCase())}</span></div>
      ${co ? `<div class="co">${plain(co)}</div>` : ''}
      ${lis ? `<ul>${lis}</ul>` : ''}
    </div>`;
  }).join('');

  const projHtml = proj.map((p, i) => {
    const last = i === proj.length - 1 ? ' style="margin-bottom:0"' : '';
    const lis = nonEmpty(p.role_highlights).map(h => `<li>${fmt(h)}</li>`).join('');
    return `<div class="proj"${last}>
      ${raw(p.role) ? `<div class="rl">${plain(p.role)}</div>` : ''}
      <div class="t">${plain(p.title)}${raw(p.type) ? ` — ${plain(p.type)}` : ''}</div>
      ${raw(p.about || p.description) ? `<p>${fmt(p.about || p.description)}</p>` : ''}
      ${lis ? `<ul class="proj-li">${lis}</ul>` : ''}
    </div>`;
  }).join('');

  const eduHtml = edu.map((e, i) => {
    const last = i === edu.length - 1 ? ' style="margin-bottom:0"' : '';
    const deg = [raw(e.degree), raw(e.field_of_study)].filter(Boolean).join(' — ');
    return `<div class="edu"${last}>
      <div class="d">${plain(deg || e.degree)}</div>
      ${raw(e.institution) ? `<div class="s">${plain(e.institution)}</div>` : ''}
      ${raw(e.end_date) ? `<span class="y">${plain(e.end_date)}</span>` : ''}
      ${raw(e.grade) ? `<span class="y">${plain(e.grade)}</span>` : ''}
    </div>`;
  }).join('');

  return `<!DOCTYPE html><html lang="en"><head>${fontsHead('Resume — Modern Minimal')}<style>
  :root{--teal:#0e9f8e;--teal-d:#0b7d70;--teal-soft:#e7f6f3;--ink:#222b30;--muted:#707b84;--line:#e8ecef;--soft-bg:#f6f8f9;}
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{background:#fff;font-family:'Lato',-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:var(--ink)}
  body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .sheet{width:210mm;min-height:297mm;background:#fff;overflow:hidden;padding:0 0 30px}
  header{display:flex;align-items:center;gap:26px;padding:38px 44px 26px;border-bottom:1px solid var(--line);position:relative}
  header::before{content:"";position:absolute;left:0;top:0;height:100%;width:8px;background:linear-gradient(180deg,var(--teal),var(--teal-d))}
  .head-text{flex:1;min-width:0}
  .name{font-family:'Poppins',sans-serif;font-weight:700;font-size:38px;line-height:1;letter-spacing:.5px;color:var(--ink)}
  .name b{color:var(--teal)}
  .role{font-family:'Poppins',sans-serif;font-weight:400;font-size:13px;letter-spacing:4px;text-transform:uppercase;color:var(--muted);margin-top:9px}
  .contacts{display:flex;flex-wrap:wrap;gap:9px 20px;margin-top:16px}
  .contacts span{display:flex;align-items:center;gap:7px;font-size:11.8px;color:#4b565f}
  .contacts svg{width:14px;height:14px;fill:var(--teal)}
  .photo{width:118px;height:118px;border-radius:50%;flex:0 0 118px;overflow:hidden;display:flex;align-items:center;justify-content:center;background:var(--teal-soft);border:3px solid var(--teal);box-shadow:0 6px 16px rgba(14,159,142,.25)}
  .photo img{width:100%;height:100%;object-fit:cover;display:block}
  .photo svg.ph{width:64px;height:64px;fill:var(--teal);opacity:.65}
  .body{display:grid;grid-template-columns:1fr 70mm;gap:0}
  .col-main{padding:24px 30px 0 44px}
  .col-side{padding:24px 36px 0 26px;border-left:1px solid var(--line);background:linear-gradient(180deg,var(--soft-bg),#fff 60%)}
  h3{font-family:'Poppins',sans-serif;font-weight:600;font-size:12.5px;letter-spacing:2px;text-transform:uppercase;color:var(--teal-d);display:flex;align-items:center;gap:10px;margin-bottom:13px}
  h3::after{content:"";flex:1;height:1px;background:var(--line)}
  .col-main section,.col-side section{margin-bottom:22px}
  .summary{font-size:12.6px;line-height:1.64;color:#49545d}
  .sum-bullets{list-style:none;margin-top:6px}
  .sum-bullets li{position:relative;font-size:12.2px;line-height:1.5;color:#49545d;padding-left:16px;margin-bottom:4px}
  .sum-bullets li::before{content:"";position:absolute;left:0;top:6px;width:7px;height:7px;border-radius:2px;background:var(--teal);transform:rotate(45deg)}
  .job{margin-bottom:15px}
  .job .top{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
  .job .t{font-family:'Poppins',sans-serif;font-weight:600;font-size:13.5px;color:var(--ink)}
  .job .when{font-size:10.5px;font-weight:700;letter-spacing:.5px;color:#fff;background:var(--teal);padding:3px 9px;border-radius:20px;white-space:nowrap}
  .job .co{font-size:11.8px;color:var(--muted);font-style:italic;margin:3px 0 7px}
  .job ul{list-style:none}
  .job li{position:relative;font-size:12px;line-height:1.5;color:#49545d;padding-left:16px;margin-bottom:4px}
  .job li::before{content:"";position:absolute;left:0;top:6px;width:7px;height:7px;border-radius:2px;background:var(--teal);transform:rotate(45deg)}
  .proj{margin-bottom:11px}
  .proj .t{font-family:'Poppins',sans-serif;font-weight:600;font-size:12.4px;color:var(--ink)}
  .proj .rl{font-size:9.8px;letter-spacing:1px;text-transform:uppercase;color:var(--teal);font-weight:700;margin-bottom:2px}
  .proj p{font-size:11.5px;line-height:1.48;color:#56616c}
  .proj-li{list-style:none;margin-top:4px}
  .proj-li li{position:relative;font-size:11.5px;line-height:1.48;color:#56616c;padding-left:14px;margin-bottom:3px}
  .proj-li li::before{content:"";position:absolute;left:0;top:6px;width:6px;height:6px;border-radius:2px;background:var(--teal);transform:rotate(45deg)}
  .chips{display:flex;flex-wrap:wrap;gap:7px}
  .chips span{font-size:11px;background:#fff;border:1px solid #d8e3e1;color:var(--teal-d);padding:5px 11px;border-radius:6px;font-weight:700}
  .chips.alt span{background:var(--teal-soft);border-color:transparent;color:var(--teal-d)}
  .strength li{list-style:none;font-size:11.8px;line-height:1.45;color:#3f4a52;margin-bottom:8px;display:flex;gap:9px;align-items:flex-start}
  .strength li svg{width:14px;height:14px;flex:0 0 14px;margin-top:2px;fill:var(--teal)}
  .edu{margin-bottom:13px}
  .edu .d{font-family:'Poppins',sans-serif;font-weight:600;font-size:12px;color:var(--ink);line-height:1.3}
  .edu .s{font-size:11px;color:var(--muted)}
  .edu .y{display:inline-block;font-size:10px;font-weight:700;color:var(--teal-d);background:var(--teal-soft);padding:1px 8px;border-radius:10px;margin-top:3px;margin-right:4px}
  /* Right column band on the root element → full-height on every page. Sheet is
     transparent so it shows through; the header stays white to sit above it. */
  html{background-color:#fff;background-image:linear-gradient(180deg,var(--soft-bg),#fff 60%);background-repeat:no-repeat;background-position:right top;background-size:70mm 100%;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  body{background:transparent}
  .sheet{background:transparent;overflow:visible}
  .col-side{background:transparent}
  header{background:#fff}
  h3{break-inside:avoid;break-after:avoid}
  .job,.proj,.edu,header,.strength li,.sum-bullets li,.job li,.proj p,.chips{break-inside:avoid}
  ${pageRule(opts.mode)}
</style></head><body>
  <div class="sheet">
    <header>
      <div class="head-text">
        <div class="name">${esc(first)} <b>${esc(rest)}</b></div>
        <div class="role">${role}</div>
        ${contactsHead.length ? `<div class="contacts">${contactsHead.join('')}</div>` : ''}
      </div>
      <div class="photo">${avatarMarkup(opts.photo, pi.full_name, '#0e9f8e', 'ph')}</div>
    </header>
    <div class="body">
      <div class="col-main">
        ${(paras.length || bullets.length) ? `<section><h3>Profile</h3>
          ${paras.map(p => `<p class="summary">${fmt(p)}</p>`).join('')}
          ${bullets.length ? `<ul class="sum-bullets">${bullets.map(b => `<li>${fmt(b)}</li>`).join('')}</ul>` : ''}</section>` : ''}
        ${jobsHtml ? `<section><h3>Experience</h3>${jobsHtml}</section>` : ''}
        ${projHtml ? `<section style="margin-bottom:0"><h3>Key Projects</h3>${projHtml}</section>` : ''}
      </div>
      <div class="col-side">
        ${expertise.length ? `<section><h3>Expertise</h3><div class="chips">${expertise.map(s => `<span>${plain(s)}</span>`).join('')}</div></section>` : ''}
        ${tools.length ? `<section><h3>Tools &amp; Methods</h3><div class="chips alt">${tools.map(s => `<span>${plain(s)}</span>`).join('')}</div></section>` : ''}
        ${soft.length ? `<section><h3>Strengths</h3><ul class="strength">${soft.map(s => `<li>${ICON.check}${plain(s)}</li>`).join('')}</ul></section>` : ''}
        ${eduHtml ? `<section style="margin-bottom:0"><h3>Education</h3>${eduHtml}</section>` : ''}
      </div>
    </div>
  </div>
</body></html>`;
}

// ══════════════════════════════════════════════════════════════════════════════
// COUNTRY-FORMAT TEMPLATES
// Single-column / header layouts (ATS-safe, no full-height sidebars → no multi-page
// compositing needed). They reuse the Poppins+Lato design language and the shared
// section helpers below, which emit standard class names each template styles.
// ══════════════════════════════════════════════════════════════════════════════

function certParts(c) {
  if (c && typeof c === 'object') return { name: raw(c.name || c.title || ''), sub: [raw(c.issuer || c.authority || ''), raw(c.year || c.date || '')].filter(Boolean).join(' · ') };
  return { name: raw(c), sub: '' };
}
function langParts(l) {
  if (l && typeof l === 'object') return { name: raw(l.name || l.language || ''), level: raw(l.level || l.proficiency || '') };
  return { name: raw(l), level: '' };
}
// CEFR / common level → fill fraction for Europass bars.
function levelPct(level) {
  const m = { a1: 18, a2: 33, b1: 50, b2: 66, c1: 83, c2: 100, native: 100, fluent: 92, professional: 75, intermediate: 55, basic: 30 };
  const k = String(level || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return m[k] || (/(nativ|mother)/.test(k) ? 100 : /(fluen|profic)/.test(k) ? 92 : 60);
}

function summaryHtml(d, paraCls = 'summary', bulletCls = 'sum-bullets') {
  const { paras, bullets } = splitSummary(d.summary);
  return `${paras.map(p => `<p class="${paraCls}">${fmt(p)}</p>`).join('')}` +
    `${bullets.length ? `<ul class="${bulletCls}">${bullets.map(b => `<li>${fmt(b)}</li>`).join('')}</ul>` : ''}`;
}
function expHtml(exp) {
  return exp.map(e => {
    const co = [raw(e.company), raw(e.location)].filter(Boolean).join(', ');
    const lis = nonEmpty(e.highlights).map(h => `<li>${fmt(h)}</li>`).join('');
    return `<div class="exp"><div class="exp-top"><span class="exp-role">${plain(e.role)}</span><span class="exp-date">${plain(dateRange(e.start_date, e.end_date))}</span></div>${co ? `<div class="exp-co">${plain(co)}</div>` : ''}${lis ? `<ul>${lis}</ul>` : ''}</div>`;
  }).join('');
}
function eduHtml(edu) {
  return edu.map(e => {
    const deg = [raw(e.degree), raw(e.field_of_study)].filter(Boolean).join(', ');
    const sub = [raw(e.institution), raw(e.grade) ? `Grade: ${raw(e.grade)}` : ''].filter(Boolean).join(' · ');
    return `<div class="edu"><div class="exp-top"><span class="exp-role">${plain(deg || e.degree)}</span><span class="exp-date">${plain(e.end_date)}</span></div>${sub ? `<div class="exp-co">${plain(sub)}</div>` : ''}</div>`;
  }).join('');
}
function projHtml(proj) {
  return proj.map(p => {
    const lis = nonEmpty(p.role_highlights).map(h => `<li>${fmt(h)}</li>`).join('');
    const link = raw(p.link) ? `<div class="proj-link">${plain(prettyUrl(p.link))}</div>` : '';
    return `<div class="proj"><div class="exp-top"><span class="exp-role">${plain(p.title)}${raw(p.type) ? ` — ${plain(p.type)}` : ''}</span>${raw(p.role) ? `<span class="exp-date">${plain(p.role)}</span>` : ''}</div>${raw(p.about || p.description) ? `<div class="proj-about">${fmt(p.about || p.description)}</div>` : ''}${lis ? `<ul>${lis}</ul>` : ''}${link}</div>`;
  }).join('');
}
function certsHtml(certs) {
  return `<ul class="certs">${certs.map(c => { const { name, sub } = certParts(c); return name ? `<li><span class="cert-name">${plain(name)}</span>${sub ? ` <span class="cert-sub">— ${plain(sub)}</span>` : ''}</li>` : ''; }).join('')}</ul>`;
}
const sec = (title, inner) => inner && inner.trim() ? `<section class="sec"><h2 class="sec-h">${esc(title)}</h2>${inner}</section>` : '';
const chipsHtml = (arr) => `<div class="chips">${arr.map(s => `<span class="chip">${plain(s)}</span>`).join('')}</div>`;

// Shared <head> + base reset for the country templates.
function countryHead(title, css) {
  return `<!DOCTYPE html><html lang="en"><head>${fontsHead(title)}<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{background:#fff;font-family:'Lato',-apple-system,'Segoe UI',Roboto,Arial,sans-serif}
  body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .sheet{width:210mm;min-height:297mm;background:#fff}
  .exp,.edu,.proj,.cert,.sec-h{break-inside:avoid}
  .sec-h{break-after:avoid}
  ul{list-style:none}
${css}
</style></head>`;
}

// ── Common data unpack for country builders ───────────────────────────────────
function unpack(d) {
  const pi = d.personal_info || {};
  return {
    pi,
    exp:  nonEmpty(d.experience),
    edu:  nonEmpty(d.education),
    proj: nonEmpty(d.projects),
    tech: nonEmpty(d.skills && d.skills.technical),
    soft: nonEmpty(d.skills && d.skills.soft),
    certs: nonEmpty(d.certifications),
    langs: nonEmpty(d.languages),
    ach:  nonEmpty(d.achievements),
    role: plain((d.experience && d.experience[0] && d.experience[0].role) || pi.title || 'Professional'),
    name: raw(pi.full_name || 'Your Name'),
  };
}
function contactInline(pi, sep = '  •  ') {
  return [raw(pi.email), raw(pi.phone), raw(pi.location), prettyUrl(pi.linkedin_url), prettyUrl(pi.portfolio_url)]
    .filter(Boolean).map(esc).join(sep);
}

// ── TEMPLATE · ATS MODERN (US/CA/UK/AU) ───────────────────────────────────────
function atsModern(d, opts = {}) {
  const { pi, exp, edu, proj, tech, soft, certs, ach, role, name } = unpack(d);
  const skills = [...tech, ...soft];
  const css = `
  .sheet{padding:18mm 16mm;color:#1f2937;font-size:11pt;line-height:1.45}
  .name{font-family:'Poppins',sans-serif;font-weight:700;font-size:23pt;letter-spacing:.5px;color:#111827;text-transform:uppercase}
  .title{font-size:11pt;color:#374151;margin-top:3px;letter-spacing:.5px}
  .contact{font-size:9.5pt;color:#374151;margin-top:7px}
  .sec{margin-top:15px}
  .sec-h{font-family:'Poppins',sans-serif;font-weight:700;font-size:11pt;text-transform:uppercase;letter-spacing:1px;color:#111827;border-bottom:1.5px solid #111827;padding-bottom:3px;margin-bottom:8px}
  .summary{font-size:10.5pt;line-height:1.5;color:#1f2937;margin-bottom:6px}
  .sum-bullets li,.exp ul li,.proj ul li{position:relative;padding-left:15px;font-size:10.5pt;line-height:1.45;margin-bottom:3px;color:#1f2937}
  .sum-bullets li::before,.exp ul li::before,.proj ul li::before{content:"";position:absolute;left:3px;top:7px;width:4px;height:4px;background:#374151;border-radius:50%}
  .skills-grid{font-size:10.5pt;line-height:1.7;color:#1f2937}
  .exp,.edu,.proj{margin-bottom:11px}
  .exp-top{display:flex;justify-content:space-between;gap:12px}
  .exp-role{font-weight:700;font-size:11pt;color:#111827}
  .exp-date{font-size:9.5pt;color:#4b5563;white-space:nowrap}
  .exp-co{font-size:10pt;color:#374151;font-style:italic;margin:1px 0 4px}
  .certs li{font-size:10.5pt;margin-bottom:3px}
  .cert-sub{color:#4b5563}
  ${pageRule(opts.mode)}`;
  return `${countryHead('Resume — ATS Modern', css)}<body><div class="sheet">
    <div class="name">${esc(name)}</div>
    <div class="title">${role}</div>
    ${contactInline(pi) ? `<div class="contact">${contactInline(pi)}</div>` : ''}
    ${sec('Professional Summary', summaryHtml(d))}
    ${skills.length ? sec('Core Skills', `<div class="skills-grid">${skills.map(esc => plain(esc)).join(' • ')}</div>`) : ''}
    ${exp.length ? sec('Professional Experience', expHtml(exp)) : ''}
    ${ach.length ? sec('Achievements', `<ul class="sum-bullets">${ach.map(a => `<li>${fmt(a)}</li>`).join('')}</ul>`) : ''}
    ${certs.length ? sec('Certifications', certsHtml(certs)) : ''}
    ${proj.length ? sec('Projects', projHtml(proj)) : ''}
    ${edu.length ? sec('Education', eduHtml(edu)) : ''}
  </div></body></html>`;
}

// ── TEMPLATE · EXECUTIVE PROFESSIONAL (US/UK/AU/SG) ───────────────────────────
function execPro(d, opts = {}) {
  const { pi, exp, edu, certs, ach, soft, role, name } = unpack(d);
  const css = `
  .sheet{padding:20mm 18mm;color:#27313f;font-size:11pt;line-height:1.5}
  .head{text-align:center;border-bottom:2px solid #c9a96a;padding-bottom:14px;margin-bottom:6px}
  .name{font-family:'Poppins',sans-serif;font-weight:600;font-size:27pt;letter-spacing:3px;color:#1e293b;text-transform:uppercase}
  .title{font-size:11pt;letter-spacing:3px;text-transform:uppercase;color:#7c6a45;margin-top:7px}
  .contact{font-size:9.5pt;color:#5b6473;margin-top:9px}
  .sec{margin-top:18px}
  .sec-h{font-family:'Poppins',sans-serif;font-weight:600;font-size:12.5pt;letter-spacing:1.5px;text-transform:uppercase;color:#1e293b;margin-bottom:9px}
  .summary{font-size:11pt;line-height:1.6;color:#3c4654;text-align:justify}
  .sum-bullets li,.exp ul li{position:relative;padding-left:18px;font-size:10.5pt;line-height:1.5;margin-bottom:4px;color:#3c4654}
  .sum-bullets li::before,.exp ul li::before{content:"";position:absolute;left:2px;top:7px;width:6px;height:2px;background:#c9a96a}
  .exp,.edu{margin-bottom:13px}
  .exp-top{display:flex;justify-content:space-between;gap:12px}
  .exp-role{font-family:'Poppins',sans-serif;font-weight:600;font-size:11.5pt;color:#1e293b}
  .exp-date{font-size:9.5pt;font-weight:700;color:#7c6a45;white-space:nowrap}
  .exp-co{font-size:10pt;color:#5b6473;font-style:italic;margin:1px 0 5px}
  .certs li{font-size:10.5pt;margin-bottom:3px}.cert-sub{color:#5b6473}
  ${pageRule(opts.mode)}`;
  return `${countryHead('Resume — Executive Professional', css)}<body><div class="sheet">
    <div class="head"><div class="name">${esc(name)}</div><div class="title">${role}</div>${contactInline(pi) ? `<div class="contact">${contactInline(pi)}</div>` : ''}</div>
    ${sec('Executive Summary', summaryHtml(d))}
    ${soft.length ? sec('Leadership Highlights', `<ul class="sum-bullets">${soft.map(s => `<li>${plain(s)}</li>`).join('')}</ul>`) : ''}
    ${exp.length ? sec('Professional Experience', expHtml(exp)) : ''}
    ${ach.length ? sec('Strategic Achievements', `<ul class="sum-bullets">${ach.map(a => `<li>${fmt(a)}</li>`).join('')}</ul>`) : ''}
    ${certs.length ? sec('Certifications', certsHtml(certs)) : ''}
    ${edu.length ? sec('Education', eduHtml(edu)) : ''}
  </div></body></html>`;
}

// ── TEMPLATE · INDIA PROFESSIONAL (IN/BD/NP/LK) ───────────────────────────────
function indiaPro(d, opts = {}) {
  const { pi, exp, edu, proj, tech, certs, ach, role, name } = unpack(d);
  const css = `
  .sheet{padding:16mm 15mm;color:#1f2a37;font-size:10.5pt;line-height:1.45}
  .head{border-left:5px solid #0e7490;padding-left:14px;margin-bottom:4px}
  .name{font-family:'Poppins',sans-serif;font-weight:700;font-size:22pt;color:#0f172a}
  .title{font-size:10.5pt;color:#0e7490;font-weight:700;letter-spacing:.5px;margin-top:2px}
  .contact{font-size:9.5pt;color:#475569;margin-top:6px}
  .sec{margin-top:14px}
  .sec-h{font-family:'Poppins',sans-serif;font-weight:600;font-size:11pt;text-transform:uppercase;letter-spacing:1px;color:#0e7490;margin-bottom:8px;display:flex;align-items:center;gap:8px}
  .sec-h::after{content:"";flex:1;height:1px;background:#e2e8f0}
  .summary{font-size:10.5pt;line-height:1.5;color:#334155;margin-bottom:5px}
  .sum-bullets li,.exp ul li,.proj ul li{position:relative;padding-left:15px;font-size:10pt;line-height:1.45;margin-bottom:3px;color:#334155}
  .sum-bullets li::before,.exp ul li::before,.proj ul li::before{content:"";position:absolute;left:2px;top:6px;width:6px;height:6px;background:#0e7490;border-radius:2px;transform:rotate(45deg)}
  .chips{display:flex;flex-wrap:wrap;gap:6px}
  .chip{font-size:9.5pt;background:#ecfeff;border:1px solid #a5f3fc;color:#0e7490;padding:3px 10px;border-radius:6px;font-weight:700}
  .exp,.edu,.proj{margin-bottom:10px}
  .exp-top{display:flex;justify-content:space-between;gap:12px}
  .exp-role{font-weight:700;font-size:10.5pt;color:#0f172a}
  .exp-date{font-size:9pt;color:#0e7490;font-weight:700;white-space:nowrap}
  .exp-co{font-size:9.5pt;color:#64748b;font-style:italic;margin:1px 0 4px}
  .proj-about{font-size:9.5pt;color:#475569;line-height:1.4;margin:2px 0 3px}
  .proj-link{font-size:9pt;color:#0e7490}
  .certs li{font-size:10pt;margin-bottom:3px}.cert-sub{color:#64748b}
  ${pageRule(opts.mode)}`;
  return `${countryHead('Resume — India Professional', css)}<body><div class="sheet">
    <div class="head"><div class="name">${esc(name)}</div><div class="title">${role}</div>${contactInline(pi) ? `<div class="contact">${contactInline(pi)}</div>` : ''}</div>
    ${sec('Summary', summaryHtml(d))}
    ${tech.length ? sec('Technical Skills', chipsHtml(tech)) : ''}
    ${exp.length ? sec('Professional Experience', expHtml(exp)) : ''}
    ${proj.length ? sec('Projects', projHtml(proj)) : ''}
    ${certs.length ? sec('Certifications', certsHtml(certs)) : ''}
    ${edu.length ? sec('Education', eduHtml(edu)) : ''}
    ${ach.length ? sec('Achievements', `<ul class="sum-bullets">${ach.map(a => `<li>${fmt(a)}</li>`).join('')}</ul>`) : ''}
  </div></body></html>`;
}

// ── TEMPLATE · GERMANY PROFESSIONAL (DE/AT/CH) ────────────────────────────────
function germanyPro(d, opts = {}) {
  const { pi, exp, edu, tech, langs, certs, role, name } = unpack(d);
  const details = [
    raw(pi.location) && ['City', plain(pi.location)],
    raw(pi.nationality) && ['Nationality', plain(pi.nationality)],
    raw(pi.date_of_birth || pi.dob) && ['Date of Birth', plain(pi.date_of_birth || pi.dob)],
    raw(pi.email) && ['Email', plain(pi.email)],
    raw(pi.phone) && ['Phone', plain(pi.phone)],
  ].filter(Boolean);
  const photoSrc = opts.photoRect || opts.photo;
  const photo = photoSrc ? `<img src="${esc(photoSrc)}" alt="">` : `<div class="ph">PHOTO</div>`;
  const css = `
  .sheet{padding:16mm 16mm;color:#1f2937;font-size:10.5pt;line-height:1.45}
  .head{display:flex;gap:18px;align-items:flex-start;border-bottom:1px solid #cbd5e1;padding-bottom:14px;margin-bottom:6px}
  .photo{width:32mm;height:40mm;flex:0 0 32mm;border:1px solid #94a3b8;overflow:hidden;background:#f1f5f9;display:flex;align-items:center;justify-content:center}
  .photo img{width:100%;height:100%;object-fit:cover}
  .ph{font-size:9pt;color:#94a3b8;letter-spacing:1px}
  .head-r{flex:1}
  .name{font-family:'Poppins',sans-serif;font-weight:600;font-size:21pt;color:#0f172a}
  .title{font-size:10.5pt;color:#475569;margin:2px 0 9px}
  .pd{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;font-size:9.5pt}
  .pd dt{color:#64748b;font-weight:700}.pd dd{color:#1f2937}
  .sec{margin-top:13px}
  .sec-h{font-family:'Poppins',sans-serif;font-weight:600;font-size:11pt;text-transform:uppercase;letter-spacing:.8px;color:#334155;border-bottom:1px solid #e2e8f0;padding-bottom:3px;margin-bottom:8px}
  .summary{font-size:10pt;line-height:1.5;color:#374151;text-align:justify}
  .exp ul li{position:relative;padding-left:14px;font-size:9.5pt;line-height:1.45;margin-bottom:3px;color:#374151}
  .exp ul li::before{content:"";position:absolute;left:2px;top:6px;width:4px;height:4px;background:#64748b;border-radius:50%}
  .exp,.edu{margin-bottom:10px}
  .exp-top{display:flex;justify-content:space-between;gap:12px}
  .exp-role{font-weight:700;font-size:10.5pt;color:#0f172a}
  .exp-date{font-size:9pt;color:#475569;white-space:nowrap}
  .exp-co{font-size:9.5pt;color:#64748b;font-style:italic;margin:1px 0 4px}
  .langs{display:grid;grid-template-columns:1fr 1fr;gap:4px 18px;font-size:9.5pt}
  .langs .l{display:flex;justify-content:space-between}.langs .lv{color:#64748b}
  .skills-grid{font-size:9.5pt;line-height:1.6}
  .certs li{font-size:9.5pt;margin-bottom:3px}.cert-sub{color:#64748b}
  .sign{margin-top:22px;display:flex;justify-content:space-between;font-size:9.5pt;color:#475569}
  .sign .line{border-top:1px solid #94a3b8;width:55mm;text-align:center;padding-top:4px}
  ${pageRule(opts.mode)}`;
  const langsInner = langs.length ? `<div class="langs">${langs.map(l => { const { name, level } = langParts(l); return `<div class="l"><span>${plain(name)}</span><span class="lv">${plain(level)}</span></div>`; }).join('')}</div>` : '';
  return `${countryHead('Lebenslauf — Germany Professional', css)}<body><div class="sheet">
    <div class="head">
      <div class="photo">${photo}</div>
      <div class="head-r"><div class="name">${esc(name)}</div><div class="title">${role}</div>
        <dl class="pd">${details.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>
      </div>
    </div>
    ${sec('Professional Profile', summaryHtml(d))}
    ${exp.length ? sec('Work Experience', expHtml(exp)) : ''}
    ${edu.length ? sec('Education', eduHtml(edu)) : ''}
    ${langsInner ? sec('Languages', langsInner) : ''}
    ${tech.length ? sec('Technical Skills', `<div class="skills-grid">${tech.map(s => plain(s)).join(' · ')}</div>`) : ''}
    ${certs.length ? sec('Certificates', certsHtml(certs)) : ''}
    <div class="sign"><div class="line">${plain(pi.location) || 'City'}, ${new Date().toLocaleDateString('en-GB')}</div><div class="line">${esc(name)}</div></div>
  </div></body></html>`;
}

// ── TEMPLATE · EUROPASS PREMIUM (EU) ──────────────────────────────────────────
function europass(d, opts = {}) {
  const { pi, exp, edu, tech, langs, certs, role, name } = unpack(d);
  const photoSrc = opts.photoRect || opts.photo;
  const photo = photoSrc ? `<img src="${esc(photoSrc)}" alt="">` : `<div class="ph">PHOTO</div>`;
  const css = `
  .sheet{padding:0;color:#1f2937;font-size:10.5pt;line-height:1.45}
  .eu-head{background:#2557a7;color:#fff;padding:16mm 15mm 12mm;display:flex;gap:18px;align-items:center}
  .photo{width:28mm;height:34mm;flex:0 0 28mm;border:2px solid rgba(255,255,255,.6);overflow:hidden;background:rgba(255,255,255,.12);display:flex;align-items:center;justify-content:center}
  .photo img{width:100%;height:100%;object-fit:cover}.ph{font-size:8.5pt;color:#dbe6f5}
  .name{font-family:'Poppins',sans-serif;font-weight:600;font-size:22pt}
  .title{font-size:10.5pt;color:#dbe6f5;margin:2px 0 8px;letter-spacing:.5px}
  .eu-contact{font-size:9pt;color:#eaf1fb}
  .body{padding:12mm 15mm}
  .sec{margin-top:14px}
  .sec-h{font-family:'Poppins',sans-serif;font-weight:600;font-size:10.5pt;text-transform:uppercase;letter-spacing:1px;color:#2557a7;border-bottom:2px solid #2557a7;padding-bottom:3px;margin-bottom:8px}
  .summary{font-size:10pt;line-height:1.5;color:#374151;text-align:justify}
  .exp ul li{position:relative;padding-left:14px;font-size:9.5pt;line-height:1.45;margin-bottom:3px;color:#374151}
  .exp ul li::before{content:"";position:absolute;left:2px;top:6px;width:4px;height:4px;background:#2557a7;border-radius:50%}
  .exp,.edu{margin-bottom:10px}
  .exp-top{display:flex;justify-content:space-between;gap:12px}
  .exp-role{font-weight:700;font-size:10.5pt;color:#0f172a}.exp-date{font-size:9pt;color:#2557a7;font-weight:700;white-space:nowrap}
  .exp-co{font-size:9.5pt;color:#64748b;font-style:italic;margin:1px 0 4px}
  .lang{margin-bottom:7px}.lang .lt{display:flex;justify-content:space-between;font-size:9.5pt;margin-bottom:2px}.lang .lv{color:#64748b}
  .lang .track{height:5px;background:#e2e8f0;border-radius:5px;overflow:hidden}.lang .fill{height:100%;background:#2557a7;border-radius:5px}
  .skills-grid{font-size:9.5pt;line-height:1.6}
  .certs li{font-size:9.5pt;margin-bottom:3px}.cert-sub{color:#64748b}
  ${pageRule(opts.mode)}`;
  const langInner = langs.length ? langs.map(l => { const { name, level } = langParts(l); const w = levelPct(level); return `<div class="lang"><div class="lt"><span>${plain(name)}</span><span class="lv">${plain(level)}</span></div><div class="track"><div class="fill" style="width:${w}%"></div></div></div>`; }).join('') : '';
  return `${countryHead('Europass — CV', css)}<body><div class="sheet">
    <div class="eu-head"><div class="photo">${photo}</div><div><div class="name">${esc(name)}</div><div class="title">${role}</div>${contactInline(pi, '  ·  ') ? `<div class="eu-contact">${contactInline(pi, '  ·  ')}</div>` : ''}</div></div>
    <div class="body">
      ${sec('Profile', summaryHtml(d))}
      ${langInner ? sec('Languages', langInner) : ''}
      ${tech.length ? sec('Digital Skills', `<div class="skills-grid">${tech.map(s => plain(s)).join(' · ')}</div>`) : ''}
      ${exp.length ? sec('Work Experience', expHtml(exp)) : ''}
      ${edu.length ? sec('Education & Training', eduHtml(edu)) : ''}
      ${certs.length ? sec('Certificates', certsHtml(certs)) : ''}
    </div>
  </div></body></html>`;
}

// ── TEMPLATE · STARTUP MODERN (US/CA/UK/SG, remote) ───────────────────────────
function startupModern(d, opts = {}) {
  const { pi, exp, edu, proj, tech, role, name } = unpack(d);
  const { paras, bullets } = splitSummary(d.summary);
  const links = [
    raw(pi.portfolio_url) && `<span class="lk">↗ ${plain(prettyUrl(pi.portfolio_url))}</span>`,
    raw(pi.linkedin_url) && `<span class="lk">in ${plain(prettyUrl(pi.linkedin_url))}</span>`,
    raw(pi.email) && `<span class="lk">✉ ${plain(pi.email)}</span>`,
    raw(pi.phone) && `<span class="lk">☏ ${plain(pi.phone)}</span>`,
  ].filter(Boolean).join('');
  const css = `
  .sheet{padding:18mm 16mm;color:#1e1e2e;font-size:10.5pt;line-height:1.5}
  .hero .name{font-family:'Poppins',sans-serif;font-weight:700;font-size:28pt;letter-spacing:-.5px;color:#16161d}
  .hero .title{font-size:11pt;color:#5b5bd6;font-weight:600;margin-top:2px}
  .links{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
  .lk{font-size:9pt;color:#44445a;background:#f4f4fb;border:1px solid #e5e5f3;border-radius:7px;padding:4px 9px}
  .sec{margin-top:16px}
  .sec-h{font-family:'Poppins',sans-serif;font-weight:600;font-size:10pt;text-transform:uppercase;letter-spacing:1.5px;color:#8888a0;margin-bottom:9px}
  .summary{font-size:11pt;line-height:1.6;color:#33334a}
  .impact{display:flex;flex-wrap:wrap;gap:10px}
  .impact .card{flex:1;min-width:30%;background:#f7f7fd;border:1px solid #ececf6;border-radius:10px;padding:11px 13px;font-size:9.7pt;line-height:1.4;color:#33334a}
  .impact .card b{color:#5b5bd6}
  .exp ul li,.proj ul li{position:relative;padding-left:16px;font-size:10pt;line-height:1.5;margin-bottom:3px;color:#33334a}
  .exp ul li::before,.proj ul li::before{content:"";position:absolute;left:3px;top:8px;width:5px;height:5px;background:#5b5bd6;border-radius:50%}
  .exp,.edu,.proj{margin-bottom:12px}
  .exp-top{display:flex;justify-content:space-between;gap:12px}
  .exp-role{font-family:'Poppins',sans-serif;font-weight:600;font-size:11pt;color:#16161d}
  .exp-date{font-size:9pt;color:#8888a0;white-space:nowrap}
  .exp-co{font-size:9.7pt;color:#5b5bd6;margin:1px 0 4px}
  .proj-about{font-size:9.7pt;color:#44445a;margin:2px 0 3px}.proj-link{font-size:9pt;color:#5b5bd6}
  .chips{display:flex;flex-wrap:wrap;gap:7px}.chip{font-size:9.5pt;background:#f4f4fb;border:1px solid #e5e5f3;color:#44445a;border-radius:7px;padding:4px 10px;font-weight:600}
  ${pageRule(opts.mode)}`;
  const impact = bullets.length ? `<div class="impact">${bullets.map(b => `<div class="card">${fmt(b)}</div>`).join('')}</div>` : '';
  const about = paras.length ? `<p class="summary">${fmt(paras.join(' '))}</p>` : '';
  return `${countryHead('Resume — Startup Modern', css)}<body><div class="sheet">
    <div class="hero"><div class="name">${esc(name)}</div><div class="title">${role}</div>${links ? `<div class="links">${links}</div>` : ''}</div>
    ${about ? sec('About', about) : ''}
    ${impact ? sec('Impact', impact) : ''}
    ${exp.length ? sec('Experience', expHtml(exp)) : ''}
    ${proj.length ? sec('Projects', projHtml(proj)) : ''}
    ${tech.length ? sec('Skills', chipsHtml(tech)) : ''}
    ${edu.length ? sec('Education', eduHtml(edu)) : ''}
  </div></body></html>`;
}

// ── TEMPLATE · BOLD BANNER (marketing-forward full-width accent header) ───────
function boldBanner(d, opts = {}) {
  const { pi, exp, edu, proj, tech, soft, certs, langs, ach, role, name } = unpack(d);
  const contact = contactInline(pi, '   ·   ');
  const langLine = langs.map(l => { const { name: ln, level } = langParts(l); return level ? `${plain(ln)} — ${plain(level)}` : plain(ln); }).filter(Boolean).join('   ·   ');
  const css = `
  .sheet{padding:0;color:#2b3344;font-size:10.5pt;line-height:1.5}
  .band{background:linear-gradient(120deg,#2563eb 0%,#1d4ed8 55%,#1e40af 100%);color:#fff;padding:16mm 16mm 14mm;display:flex;align-items:center;justify-content:space-between;gap:12mm;break-inside:avoid}
  .band-name{font-family:'Poppins',sans-serif;font-weight:700;font-size:26pt;letter-spacing:-.3px;line-height:1.15;color:#fff}
  .band-role{font-family:'Poppins',sans-serif;font-weight:600;font-size:11pt;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,.92);margin-top:5px}
  .band-contact{font-size:9pt;color:rgba(255,255,255,.88);margin-top:11px;letter-spacing:.2px}
  .avatar{width:33mm;height:33mm;flex:0 0 33mm;border-radius:50%;overflow:hidden;background:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 3px rgba(255,255,255,.35)}
  .avatar img{width:100%;height:100%;object-fit:cover}
  .avatar svg{width:60%;height:60%}
  .body{padding:11mm 16mm 15mm}
  .sec{margin-top:15px}
  .sec-h{font-family:'Poppins',sans-serif;font-weight:700;font-size:11pt;text-transform:uppercase;letter-spacing:1.6px;color:#1d4ed8;padding-bottom:5px;border-bottom:2px solid #dbe7fe;margin-bottom:9px;position:relative}
  .sec-h::after{content:"";position:absolute;left:0;bottom:-2px;width:36px;height:2px;background:#1d4ed8}
  .summary{font-size:10.5pt;line-height:1.55;color:#3a4354;margin-bottom:5px}
  .sum-bullets li,.exp ul li,.proj ul li{position:relative;padding-left:16px;font-size:10pt;line-height:1.5;margin-bottom:3px;color:#3a4354}
  .sum-bullets li::before,.exp ul li::before,.proj ul li::before{content:"";position:absolute;left:3px;top:8px;width:5px;height:5px;background:#2563eb;border-radius:50%}
  .chips{display:flex;flex-wrap:wrap;gap:7px}
  .chip{font-size:9.5pt;background:#eff4ff;border:1px solid #c7d7fb;color:#1d4ed8;border-radius:14px;padding:4px 11px;font-weight:600}
  .chips-soft .chip{background:#fff;color:#1e40af}
  .exp,.edu,.proj{margin-bottom:11px}
  .exp-top{display:flex;justify-content:space-between;gap:12px}
  .exp-role{font-family:'Poppins',sans-serif;font-weight:600;font-size:11pt;color:#1b1f27}
  .exp-date{font-size:9pt;font-weight:700;color:#1e40af;white-space:nowrap}
  .exp-co{font-size:9.7pt;font-weight:600;color:#2563eb;margin:1px 0 4px}
  .proj-about{font-size:9.7pt;color:#3a4354;margin:2px 0 3px}
  .proj-link{font-size:9pt;color:#2563eb}
  .certs li{font-size:10pt;margin-bottom:3px}
  .cert-name{font-weight:700;color:#1b1f27}
  .cert-sub{color:#6a7385}
  .langline{font-size:10pt;color:#3a4354}
  ${pageRule(opts.mode)}`;
  return `${countryHead('Resume — Bold Banner', css)}<body><div class="sheet">
    <div class="band">
      <div class="band-l">
        <div class="band-name">${esc(name)}</div>
        <div class="band-role">${role}</div>
        ${contact ? `<div class="band-contact">${contact}</div>` : ''}
      </div>
      <div class="avatar">${avatarMarkup(opts.photo, name, '#1d4ed8')}</div>
    </div>
    <div class="body">
      ${sec('Profile', summaryHtml(d))}
      ${tech.length ? sec('Core Skills', chipsHtml(tech)) : ''}
      ${exp.length ? sec('Experience', expHtml(exp)) : ''}
      ${proj.length ? sec('Projects', projHtml(proj)) : ''}
      ${ach.length ? sec('Achievements', `<ul class="sum-bullets">${ach.map(a => `<li>${fmt(a)}</li>`).join('')}</ul>`) : ''}
      ${certs.length ? sec('Certifications', certsHtml(certs)) : ''}
      ${soft.length ? sec('Strengths', `<div class="chips chips-soft">${soft.map(s => `<span class="chip">${plain(s)}</span>`).join('')}</div>`) : ''}
      ${edu.length ? sec('Education', eduHtml(edu)) : ''}
      ${langLine ? sec('Languages', `<div class="langline">${langLine}</div>`) : ''}
    </div>
  </div></body></html>`;
}

// ── TEMPLATE · RIGHT RAIL (main left, tinted sidebar right) ───────────────────
function rightRail(d, opts = {}) {
  const { pi, exp, edu, proj, tech, soft, certs, langs, ach, role, name } = unpack(d);
  const langsInner = langs.length ? langs.map(l => {
    const p = langParts(l);
    return p.name ? `<div class="lang"><div class="lt"><span>${plain(p.name)}</span>${p.level ? `<span class="lv">${plain(p.level)}</span>` : ''}</div><div class="track"><div class="fill" style="width:${levelPct(p.level)}%"></div></div></div>` : '';
  }).join('') : '';
  const css = `
  html{background-color:#ffffff;background-image:linear-gradient(180deg,#e6f7f4,#e6f7f4);background-repeat:repeat-y;background-position:right top;background-size:78mm 10mm;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  body{background:transparent}
  .sheet{background:transparent;color:#1f2937;font-size:10.5pt;line-height:1.5}
  .cols{display:grid;grid-template-columns:1fr 78mm}
  .main{padding:15mm 9mm 14mm 14mm;min-width:0}
  .side{padding:15mm 10mm 14mm 10mm;min-width:0}
  .head .name{font-family:'Poppins',sans-serif;font-weight:700;font-size:24pt;line-height:1.12;letter-spacing:-.3px;color:#0f172a}
  .head .role{font-family:'Poppins',sans-serif;font-weight:600;font-size:10.5pt;letter-spacing:2px;text-transform:uppercase;color:#0f766e;margin-top:5px}
  .head .rule{width:16mm;height:3px;border-radius:2px;background:#0f766e;margin-top:9px}
  .main .sec{margin-top:15px}
  .main .sec-h{font-family:'Poppins',sans-serif;font-weight:600;font-size:10pt;text-transform:uppercase;letter-spacing:1.8px;color:#0f766e;display:flex;align-items:center;gap:9px;margin-bottom:9px}
  .main .sec-h::after{content:"";flex:1;height:2px;border-radius:2px;background:#99f6e4}
  .summary{font-size:10.3pt;line-height:1.55;color:#334155;margin-bottom:5px}
  .sum-bullets li,.exp ul li,.proj ul li{position:relative;padding-left:15px;font-size:10pt;line-height:1.5;margin-bottom:3px;color:#334155}
  .sum-bullets li::before,.exp ul li::before,.proj ul li::before{content:"";position:absolute;left:2px;top:7px;width:5px;height:5px;border-radius:50%;background:#0f766e}
  .exp,.proj{margin-bottom:11px}
  .exp-top{display:flex;justify-content:space-between;align-items:baseline;gap:10px}
  .exp-role{font-family:'Poppins',sans-serif;font-weight:600;font-size:10.8pt;color:#0f172a}
  .exp-date{font-size:8.8pt;font-weight:700;color:#0f766e;white-space:nowrap}
  .exp-co{font-size:9.6pt;color:#64748b;font-style:italic;margin:1px 0 4px}
  .proj-about{font-size:9.6pt;color:#475569;margin:2px 0 3px}
  .proj-link{font-size:8.8pt;color:#0f766e}
  .avatar{width:33mm;height:33mm;margin:0 auto;border-radius:50%;overflow:hidden;background:#ccfbf1;border:3px solid #0f766e;display:flex;align-items:center;justify-content:center}
  .avatar img{width:100%;height:100%;object-fit:cover;display:block}
  .avatar svg{width:58%;height:58%}
  .side .sec{margin-top:14px}
  .side .sec-h{font-family:'Poppins',sans-serif;font-weight:600;font-size:9pt;text-transform:uppercase;letter-spacing:2px;color:#115e59;border-bottom:2px solid #99f6e4;padding-bottom:4px;margin-bottom:9px}
  .crow{display:flex;align-items:flex-start;gap:8px;font-size:8.8pt;line-height:1.4;color:#334155;margin-bottom:6px;word-break:break-word}
  .crow svg{width:11px;height:11px;flex:0 0 11px;margin-top:1px;fill:#0f766e}
  .chips{display:flex;flex-wrap:wrap;gap:5px}
  .chip{font-size:8.6pt;font-weight:700;color:#115e59;background:#ffffff;border:1px solid #99f6e4;border-radius:6px;padding:3px 8px}
  .chips.alt .chip{background:#ccfbf1;border-color:transparent}
  .side .edu{margin-bottom:9px}
  .side .exp-top{display:block}
  .side .exp-role{display:block;font-family:'Poppins',sans-serif;font-weight:600;font-size:9.3pt;line-height:1.35;color:#0f172a}
  .side .exp-date{display:inline-block;font-size:8pt;font-weight:700;color:#115e59;background:#ccfbf1;border-radius:8px;padding:1px 7px;margin-top:3px;white-space:normal}
  .side .exp-co{font-size:8.8pt;color:#475569;font-style:normal;margin:2px 0 0}
  .lang{margin-bottom:7px}
  .lt{display:flex;justify-content:space-between;align-items:baseline;gap:8px;font-size:9pt;font-weight:700;color:#0f172a;margin-bottom:3px}
  .lt .lv{font-weight:400;font-size:8.5pt;color:#475569}
  .track{height:4px;border-radius:4px;background:#ffffff;overflow:hidden}
  .fill{height:100%;border-radius:4px;background:#0f766e}
  .certs li{font-size:8.8pt;line-height:1.4;margin-bottom:5px;color:#334155}
  .cert-name{font-weight:700;color:#0f172a}
  .cert-sub{color:#64748b}
  .avatar,.crow,.lang,.chips{break-inside:avoid}
  ${pageRule(opts.mode)}`;
  return `${countryHead('Resume — Right Rail', css)}<body><div class="sheet"><div class="cols">
    <div class="main">
      <div class="head"><div class="name">${esc(name)}</div><div class="role">${role}</div><div class="rule"></div></div>
      ${sec('Profile', summaryHtml(d))}
      ${exp.length ? sec('Experience', expHtml(exp)) : ''}
      ${proj.length ? sec('Projects', projHtml(proj)) : ''}
      ${ach.length ? sec('Achievements', `<ul class="sum-bullets">${ach.map(a => `<li>${fmt(a)}</li>`).join('')}</ul>`) : ''}
    </div>
    <div class="side">
      <div class="avatar">${avatarMarkup(opts.photo, name, '#0f766e')}</div>
      ${sec('Contact', contactRows(pi, 'crow'))}
      ${tech.length ? sec('Skills', chipsHtml(tech)) : ''}
      ${soft.length ? sec('Strengths', `<div class="chips alt">${soft.map(s => `<span class="chip">${plain(s)}</span>`).join('')}</div>`) : ''}
      ${edu.length ? sec('Education', eduHtml(edu)) : ''}
      ${langsInner ? sec('Languages', langsInner) : ''}
      ${certs.length ? sec('Certifications', certsHtml(certs)) : ''}
    </div>
  </div></div></body></html>`;
}

// ── TEMPLATE · TECH MONO (engineering / terminal) ─────────────────────────────
// Single-column, ATS-clean. System monospace for headers/labels, Lato for prose.
// Section headers render as "## experience" (accent ##), bullets use accent ">"
// prompt glyphs, and each section block carries a thin accent left border.
function techMono(d, opts = {}) {
  const { pi, exp, edu, proj, tech, soft, certs, langs, ach, role, name } = unpack(d);
  const contact = contactInline(pi, ' <span class="sep">·</span> ');
  const skillsInner = [
    tech.length ? chipsHtml(tech) : '',
    soft.length ? `<div class="soft-line"><span class="cmt">//</span> ${soft.map(s => plain(s)).join(' · ')}</div>` : '',
  ].join('');
  const langLine = langs.map(l => {
    const { name: ln, level } = langParts(l);
    return ln ? `<span class="lang"><b>${plain(ln)}</b>${level ? ` <span class="lvl">(${plain(level)})</span>` : ''}</span>` : '';
  }).filter(Boolean).join(' <span class="sep">·</span> ');
  const css = `
  .sheet{padding:16mm;color:#1f2937;font-size:10.5pt;line-height:1.5}
  .prompt,.name,.role,.contact,.sec-h,.exp-role,.exp-date,.exp-co,.chip,.cert-name,.cert-sub,.soft-line,.lang,.lvl,.proj-link{font-family:ui-monospace,'SFMono-Regular',Menlo,Consolas,monospace}
  .prompt{font-size:9pt;color:#9ca3af;letter-spacing:.5px}
  .prompt .dollar{color:#16a34a;font-weight:700}
  .name{font-weight:700;font-size:21pt;letter-spacing:-.5px;color:#111827;margin-top:3px}
  .cursor{display:inline-block;width:9px;height:.72em;background:#16a34a;margin-left:8px;border-radius:1.5px}
  .role{font-size:11pt;color:#374151;margin-top:4px}
  .role .gt{color:#16a34a;font-weight:700}
  .contact{font-size:8.8pt;color:#4b5563;margin-top:9px;line-height:1.8}
  .sep{color:#16a34a;font-weight:700}
  .hd{padding-bottom:12px;border-bottom:1px solid #e5e7eb}
  .sec{margin-top:15px;border-left:2px solid #bbf7d0;padding-left:13px}
  .sec-h{font-weight:700;font-size:10.5pt;letter-spacing:.5px;color:#111827;text-transform:lowercase;margin-bottom:8px}
  .sec-h::before{content:"## ";color:#16a34a}
  .summary{font-size:10.3pt;line-height:1.6;color:#374151;margin-bottom:5px}
  .summary b,.exp ul li b,.proj ul li b,.sum-bullets li b{color:#15803d}
  .sum-bullets li,.exp ul li,.proj ul li{position:relative;padding-left:16px;font-size:10pt;line-height:1.5;margin-bottom:3px;color:#374151}
  .sum-bullets li::before,.exp ul li::before,.proj ul li::before{content:">";position:absolute;left:1px;top:0;color:#16a34a;font-family:ui-monospace,'SFMono-Regular',Menlo,Consolas,monospace;font-weight:700;font-size:9.5pt}
  .exp,.edu,.proj{margin-bottom:11px}
  .exp-top{display:flex;justify-content:space-between;gap:12px;align-items:baseline}
  .exp-role{font-weight:700;font-size:10.5pt;color:#111827}
  .exp-date{font-size:8.5pt;color:#6b7280;white-space:nowrap}
  .exp-co{font-size:9pt;color:#15803d;margin:1px 0 4px}
  .proj-about{font-size:10pt;color:#374151;margin:2px 0 3px}
  .proj-link{font-size:8.8pt;color:#16a34a;margin-top:1px}
  .chips{display:flex;flex-wrap:wrap;gap:6px}
  .chip{font-size:8.8pt;color:#15803d;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:4px;padding:3px 8px}
  .soft-line{font-size:8.8pt;color:#4b5563;margin-top:8px;line-height:1.7}
  .soft-line .cmt{color:#16a34a;font-weight:700}
  .certs li{font-size:10pt;margin-bottom:3px;color:#374151}
  .cert-name{font-weight:700;font-size:9.3pt;color:#111827}
  .cert-sub{color:#6b7280;font-size:9.3pt}
  .langs{font-size:9.3pt;color:#374151;line-height:1.8}
  .langs .sep{margin:0 4px}
  .lang b{color:#111827}
  .lvl{color:#6b7280}
  .cert-sub{margin-left:2px}
  ${pageRule(opts.mode)}`;
  return `${countryHead('Resume — Tech Mono', css)}<body><div class="sheet">
    <header class="hd">
      <div class="prompt"><span class="dollar">$</span> whoami</div>
      <h1 class="name">${esc(name)}<span class="cursor"></span></h1>
      <div class="role"><span class="gt">&gt;</span> ${role}</div>
      ${contact ? `<div class="contact">${contact}</div>` : ''}
    </header>
    ${sec('Summary', summaryHtml(d))}
    ${exp.length ? sec('Experience', expHtml(exp)) : ''}
    ${proj.length ? sec('Projects', projHtml(proj)) : ''}
    ${skillsInner ? sec('Skills', skillsInner) : ''}
    ${edu.length ? sec('Education', eduHtml(edu)) : ''}
    ${certs.length ? sec('Certifications', certsHtml(certs)) : ''}
    ${ach.length ? sec('Achievements', `<ul class="sum-bullets">${ach.map(a => `<li>${fmt(a)}</li>`).join('')}</ul>`) : ''}
    ${langLine ? sec('Languages', `<div class="langs">${langLine}</div>`) : ''}
  </div></body></html>`;
}

function elegantSerif(d, opts = {}) {
  const { pi, exp, edu, proj, tech, soft, certs, langs, ach, role, name } = unpack(d);
  const contact = contactInline(pi, '  ·  ');
  const skillLine = (label, arr) => arr.length ? `<div class="skl"><span class="skl-h">${esc(label)}</span>${arr.map(s => plain(s)).join('  ·  ')}</div>` : '';
  const skillsBlock = skillLine('Technical', tech) + skillLine('Soft Skills', soft);
  const langLine = langs.map(l => { const p = langParts(l); return p.name ? (p.level ? `${plain(p.name)} (${plain(p.level)})` : plain(p.name)) : ''; }).filter(Boolean).join('  ·  ');
  const css = `
  .sheet{padding:19mm 18mm;color:#262626;font-family:Georgia,'Times New Roman',serif;font-size:10.5pt;line-height:1.55}
  .masthead{text-align:center;padding-top:2mm}
  .name{font-family:Georgia,'Times New Roman',serif;font-size:26pt;font-weight:400;letter-spacing:4px;text-transform:uppercase;color:#1b1b1b}
  .role{font-size:11pt;font-style:italic;color:#4d4d4d;letter-spacing:.8px;margin-top:5px}
  .contact{font-size:9.5pt;color:#555555;letter-spacing:.4px;margin-top:8px}
  .orn{display:flex;align-items:center;gap:9px;margin-top:12px}
  .orn-l{flex:1;height:1px;background:#7f1d1d}
  .orn-d{width:5px;height:5px;background:#7f1d1d;transform:rotate(45deg);flex:none}
  .sec{margin-top:15px}
  .sec-h{display:flex;align-items:center;gap:12px;font-family:Georgia,'Times New Roman',serif;font-weight:400;font-variant:small-caps;font-size:12.5pt;letter-spacing:2.6px;color:#7f1d1d;margin-bottom:9px}
  .sec-h::before,.sec-h::after{content:"";flex:1;height:1px;background:#dcc3c3}
  .summary{text-align:justify;font-size:10.6pt;line-height:1.62;color:#2c2c2c;margin-bottom:5px}
  .sum-bullets li,.exp ul li,.proj ul li{position:relative;padding-left:15px;font-size:10.3pt;line-height:1.52;margin-bottom:3px;color:#2c2c2c}
  .sum-bullets li::before,.exp ul li::before,.proj ul li::before{content:"";position:absolute;left:2px;top:.52em;width:4px;height:4px;background:#8f8f8f;border-radius:50%}
  .exp,.edu,.proj{margin-bottom:11px}
  .exp-top{display:flex;justify-content:space-between;align-items:baseline;gap:14px}
  .exp-role{font-weight:700;font-size:10.8pt;color:#1b1b1b}
  .exp-date{font-size:9.3pt;font-style:italic;color:#6b6b6b;white-space:nowrap}
  .exp-co{font-size:10pt;font-style:italic;color:#4d4d4d;margin:1px 0 4px}
  .proj-about{font-size:10pt;color:#3a3a3a;margin:2px 0 3px}
  .proj-link{font-size:9.3pt;font-style:italic;color:#6b6b6b}
  .certs li{position:relative;padding-left:15px;font-size:10.2pt;line-height:1.52;margin-bottom:3px;color:#2c2c2c}
  .certs li::before{content:"";position:absolute;left:2px;top:.52em;width:4px;height:4px;background:#8f8f8f;border-radius:50%}
  .cert-name{font-weight:700}
  .cert-sub{color:#5b5b5b}
  .skl{text-align:center;font-size:10.2pt;color:#333333;line-height:1.7}
  .skl + .skl{margin-top:3px}
  .skl-h{font-variant:small-caps;letter-spacing:1.6px;color:#5f5f5f;margin-right:9px}
  .lang-line{text-align:center;font-size:10.2pt;color:#333333}
  ${pageRule(opts.mode)}`;
  return `${countryHead('Resume — Elegant Serif', css)}<body><div class="sheet">
    <header class="masthead">
      <div class="name">${esc(name)}</div>
      <div class="role">${role}</div>
      ${contact ? `<div class="contact">${contact}</div>` : ''}
      <div class="orn"><span class="orn-l"></span><span class="orn-d"></span><span class="orn-l"></span></div>
    </header>
    ${sec('Profile', summaryHtml(d))}
    ${exp.length ? sec('Professional Experience', expHtml(exp)) : ''}
    ${edu.length ? sec('Education', eduHtml(edu)) : ''}
    ${skillsBlock ? sec('Skills & Expertise', skillsBlock) : ''}
    ${proj.length ? sec('Selected Projects', projHtml(proj)) : ''}
    ${certs.length ? sec('Certifications', certsHtml(certs)) : ''}
    ${ach.length ? sec('Achievements', `<ul class="sum-bullets">${ach.map(a => `<li>${fmt(a)}</li>`).join('')}</ul>`) : ''}
    ${langLine ? sec('Languages', `<div class="lang-line">${langLine}</div>`) : ''}
  </div></body></html>`;
}

function compactPro(d, opts = {}) {
  const { pi, exp, edu, proj, tech, soft, certs, langs, ach, role, name } = unpack(d);
  const contactBits = [
    raw(pi.email) && plain(pi.email),
    raw(pi.phone) && plain(pi.phone),
    raw(pi.location) && plain(pi.location),
    raw(pi.linkedin_url) && plain(prettyUrl(pi.linkedin_url)),
    raw(pi.portfolio_url) && plain(prettyUrl(pi.portfolio_url)),
  ].filter(Boolean);
  const contact = contactBits.map(c => `<div class="c-row">${c}</div>`).join('');
  const langRows = langs.map(l => {
    const { name: ln, level } = langParts(l);
    return ln ? `<div class="lang"><span class="lang-n">${plain(ln)}</span>${level ? `<span class="lang-l">${plain(level)}</span>` : ''}</div>` : '';
  }).join('');
  const css = `
  .sheet{padding:12mm 13mm 13mm;color:#23262e;font-size:9.5pt;line-height:1.35}
  .head{display:flex;justify-content:space-between;align-items:flex-start;gap:10mm}
  .name{font-family:'Poppins',sans-serif;font-weight:700;font-size:19pt;letter-spacing:-.3px;color:#14161c;line-height:1.15}
  .title{font-family:'Poppins',sans-serif;font-weight:600;font-size:9.5pt;letter-spacing:1.2px;text-transform:uppercase;color:#4338ca;margin-top:3px}
  .h-contact{text-align:right;font-size:8.5pt;color:#4b5058;line-height:1.55;padding-top:2px;flex-shrink:0}
  .rule{height:2px;background:#4338ca;margin-top:8px}
  .cols{display:grid;grid-template-columns:64fr 36fr;column-gap:8mm;align-items:start}
  .sec{margin-top:11px}
  .sec-h{font-family:'Poppins',sans-serif;font-weight:600;font-size:8.5pt;text-transform:uppercase;letter-spacing:1.4px;color:#14161c;border-bottom:1px solid #e0e7ff;padding-bottom:3px;margin-bottom:7px}
  .summary{font-size:9.5pt;line-height:1.4;color:#2c303a;margin-bottom:4px}
  .sum-bullets li,.exp ul li,.proj ul li{position:relative;padding-left:12px;font-size:9.5pt;line-height:1.35;margin-bottom:2px;color:#2c303a}
  .sum-bullets li::before,.exp ul li::before,.proj ul li::before{content:"";position:absolute;left:1px;top:6px;width:4px;height:4px;background:#4338ca;border-radius:1px}
  .exp,.edu,.proj{margin-bottom:8px}
  .exp-top{display:flex;justify-content:space-between;gap:8px;align-items:baseline}
  .exp-role{font-weight:700;font-size:10pt;color:#14161c}
  .exp-date{font-size:8pt;color:#6a707c;white-space:nowrap}
  .exp-co{font-size:8.7pt;font-weight:600;color:#4338ca;margin:0 0 3px}
  .proj-about{font-size:9pt;color:#3a3f4a;margin:1px 0 2px}
  .proj-link{font-size:8pt;color:#4338ca;margin-top:1px}
  .chips{display:flex;flex-wrap:wrap;gap:4px}
  .chip{font-size:8.3pt;background:#eef2ff;border:1px solid #e0e7ff;color:#3730a3;border-radius:4px;padding:2px 7px;font-weight:600;line-height:1.3}
  .side .exp-top{display:block}
  .side .exp-date{white-space:normal;display:block;margin-top:1px}
  .side .exp-role{font-size:9.3pt}
  .side .exp-co{color:#3a3f4a;font-weight:400;font-size:8.7pt}
  .soft-list li{position:relative;padding-left:11px;font-size:9.3pt;line-height:1.35;margin-bottom:2px;color:#2c303a}
  .soft-list li::before{content:"";position:absolute;left:0;top:6px;width:4px;height:4px;background:#4338ca;border-radius:1px}
  .certs li{font-size:9pt;line-height:1.35;margin-bottom:3px}
  .cert-name{font-weight:700;color:#14161c}
  .cert-sub{color:#6a707c;font-size:8.5pt}
  .lang{display:flex;justify-content:space-between;gap:6px;font-size:9.3pt;margin-bottom:3px}
  .lang-n{color:#23262e;font-weight:600}
  .lang-l{color:#6a707c;font-size:8.5pt}
  ${pageRule(opts.mode)}`;
  return `${countryHead('Resume — Compact Pro', css)}<body><div class="sheet">
    <div class="head">
      <div><div class="name">${esc(name)}</div><div class="title">${role}</div></div>
      ${contact ? `<div class="h-contact">${contact}</div>` : ''}
    </div>
    <div class="rule"></div>
    <div class="cols">
      <div class="main">
        ${sec('Profile', summaryHtml(d))}
        ${exp.length ? sec('Experience', expHtml(exp)) : ''}
        ${proj.length ? sec('Projects', projHtml(proj)) : ''}
        ${ach.length ? sec('Achievements', `<ul class="sum-bullets">${ach.map(a => `<li>${fmt(a)}</li>`).join('')}</ul>`) : ''}
      </div>
      <div class="side">
        ${tech.length ? sec('Technical Skills', chipsHtml(tech)) : ''}
        ${soft.length ? sec('Strengths', `<ul class="soft-list">${soft.map(s => `<li>${plain(s)}</li>`).join('')}</ul>`) : ''}
        ${edu.length ? sec('Education', eduHtml(edu)) : ''}
        ${certs.length ? sec('Certifications', certsHtml(certs)) : ''}
        ${langRows ? sec('Languages', langRows) : ''}
      </div>
    </div>
  </div></body></html>`;
}

// ── TEMPLATE · CAREER TIMELINE (generic) ──────────────────────────────────────
function careerTimeline(d, opts = {}) {
  const { pi, exp, edu, proj, tech, soft, certs, langs, ach, role, name } = unpack(d);
  const lis = (arr) => (Array.isArray(arr) ? arr : []).filter(h => raw(h)).map(h => `<li>${fmt(h)}</li>`).join('');
  const tlExp = exp.map(e => {
    const co = [raw(e.company), raw(e.location)].filter(Boolean).join(' · ');
    const hls = lis(e.highlights);
    return `<div class="tl-item"><div class="tl-date">${plain(dateRange(e.start_date, e.end_date))}</div><div class="tl-body"><div class="tl-role">${plain(e.role)}</div>${co ? `<div class="tl-co">${plain(co)}</div>` : ''}${hls ? `<ul>${hls}</ul>` : ''}</div></div>`;
  }).join('');
  const tlEdu = edu.map(e => {
    const deg = [raw(e.degree), raw(e.field_of_study)].filter(Boolean).join(', ');
    const sub = [raw(e.institution), raw(e.grade) ? `Grade: ${raw(e.grade)}` : ''].filter(Boolean).join(' · ');
    return `<div class="tl-item"><div class="tl-date">${plain(e.end_date)}</div><div class="tl-body"><div class="tl-role">${plain(deg || e.degree)}</div>${sub ? `<div class="tl-co">${plain(sub)}</div>` : ''}</div></div>`;
  }).join('');
  const langLine = langs.map(l => {
    const p = langParts(l);
    return p.name ? `<span class="lang"><b>${plain(p.name)}</b>${p.level ? ` — ${plain(p.level)}` : ''}</span>` : '';
  }).filter(Boolean).join('<span class="lang-sep">·</span>');
  const skills = [...tech, ...soft];
  const contacts = contactRows(pi, 'crow');
  const css = `
  .sheet{padding:16mm 16mm 18mm;color:#2a3342;font-size:10.3pt;line-height:1.5}
  .head{display:flex;justify-content:space-between;align-items:center;gap:12mm;padding-bottom:16px;border-bottom:2px solid #ffedd5}
  .name{font-family:'Poppins',sans-serif;font-weight:700;font-size:25pt;letter-spacing:-.3px;color:#111827}
  .title{font-family:'Poppins',sans-serif;font-weight:600;font-size:11.5pt;color:#ea580c;margin-top:2px;letter-spacing:.3px}
  .contacts{display:flex;flex-wrap:wrap;gap:5px 16px;margin-top:10px}
  .crow{display:inline-flex;align-items:center;gap:6px;font-size:9pt;color:#4b5563}
  .crow svg{width:11px;height:11px;fill:#ea580c;flex:0 0 11px}
  .avatar{width:33mm;height:33mm;flex:0 0 33mm;border-radius:50%;overflow:hidden;background:#fff7ed;border:3px solid #fdba74;display:flex;align-items:center;justify-content:center}
  .avatar img{width:100%;height:100%;object-fit:cover}
  .avatar svg{width:50%;height:50%}
  .sec{margin-top:15px}
  .sec-h{font-family:'Poppins',sans-serif;font-weight:600;font-size:10.5pt;text-transform:uppercase;letter-spacing:1.6px;color:#111827;margin-bottom:10px;display:flex;align-items:center;gap:9px}
  .sec-h::before{content:"";width:9px;height:9px;border-radius:50%;background:#ea580c;box-shadow:0 0 0 3px #ffedd5}
  .sec-h::after{content:"";flex:1;height:2px;background:#ffedd5;border-radius:1px}
  .summary{font-size:10.3pt;line-height:1.55;color:#333c4a;margin-bottom:5px}
  .sum-bullets li{position:relative;padding-left:15px;font-size:10pt;line-height:1.5;margin-bottom:3px;color:#333c4a}
  .sum-bullets li::before{content:"";position:absolute;left:2px;top:7px;width:5px;height:5px;border-radius:50%;background:#ea580c}
  .tl-item{display:flex;gap:14px;break-inside:avoid}
  .tl-date{flex:0 0 27mm;width:27mm;text-align:right;font-size:8.8pt;font-weight:700;color:#ea580c;padding-top:2px;line-height:1.35}
  .tl-body{flex:1;position:relative;border-left:2px solid #fdba74;padding-left:16px;padding-bottom:14px}
  .tl-item:last-child .tl-body{padding-bottom:2px}
  .tl-body::before{content:"";position:absolute;left:-6px;top:3px;width:10px;height:10px;border-radius:50%;background:#ea580c;box-shadow:0 0 0 3px #ffedd5}
  .tl-role{font-family:'Poppins',sans-serif;font-weight:600;font-size:11pt;color:#111827}
  .tl-co{font-size:9.6pt;font-weight:600;color:#c2410c;margin:1px 0 4px}
  .tl-body ul{margin-top:3px}
  .tl-body ul li,.proj ul li{position:relative;padding-left:14px;font-size:9.9pt;line-height:1.5;margin-bottom:3px;color:#3b4453}
  .tl-body ul li::before,.proj ul li::before{content:"";position:absolute;left:2px;top:7px;width:4px;height:4px;border-radius:50%;background:#fdba74}
  .proj{margin-bottom:10px}
  .exp-top{display:flex;justify-content:space-between;gap:12px}
  .exp-role{font-family:'Poppins',sans-serif;font-weight:600;font-size:10.5pt;color:#111827}
  .exp-date{font-size:9pt;font-weight:700;color:#ea580c;white-space:nowrap}
  .exp-co{font-size:9.5pt;color:#6b7280;font-style:italic;margin:1px 0 4px}
  .proj-about{font-size:9.7pt;color:#414b5a;line-height:1.5;margin:2px 0 3px}
  .proj-link{font-size:9pt;color:#c2410c}
  .chips{display:flex;flex-wrap:wrap;gap:7px}
  .chip{font-size:9.3pt;background:#fff7ed;border:1px solid #fed7aa;color:#c2410c;border-radius:14px;padding:4px 11px;font-weight:600}
  .certs li{position:relative;padding-left:14px;font-size:9.9pt;margin-bottom:3px;color:#333c4a}
  .certs li::before{content:"";position:absolute;left:2px;top:7px;width:4px;height:4px;border-radius:50%;background:#fdba74}
  .cert-name{font-weight:700;color:#111827}
  .cert-sub{color:#6b7280}
  .langs{font-size:9.9pt;color:#333c4a;display:flex;flex-wrap:wrap;gap:5px 8px;align-items:center}
  .lang b{color:#111827}
  .lang-sep{color:#fdba74;font-weight:700}
  ${pageRule(opts.mode)}`;
  return `${countryHead('Resume — Career Timeline', css)}<body><div class="sheet">
    <div class="head">
      <div class="head-l">
        <div class="name">${esc(name)}</div>
        <div class="title">${role}</div>
        ${contacts ? `<div class="contacts">${contacts}</div>` : ''}
      </div>
      <div class="avatar">${avatarMarkup(opts.photo, name, '#ea580c')}</div>
    </div>
    ${sec('Profile', summaryHtml(d))}
    ${exp.length ? sec('Career Journey', `<div class="tl">${tlExp}</div>`) : ''}
    ${edu.length ? sec('Education', `<div class="tl">${tlEdu}</div>`) : ''}
    ${proj.length ? sec('Projects', projHtml(proj)) : ''}
    ${skills.length ? sec('Skills', chipsHtml(skills)) : ''}
    ${certs.length ? sec('Certifications', certsHtml(certs)) : ''}
    ${ach.length ? sec('Achievements', `<ul class="sum-bullets">${ach.map(a => `<li>${fmt(a)}</li>`).join('')}</ul>`) : ''}
    ${langLine ? sec('Languages', `<div class="langs">${langLine}</div>`) : ''}
  </div></body></html>`;
}

// ── Theme variants ────────────────────────────────────────────────────────────
//
// 37 designs from 9 layout families. Each family's CSS names its accent colors as literal
// hexes; a variant recolors exactly those hexes by hue-rotation in HSL space, leaving
// LIGHTNESS untouched — so every contrast relationship (text on band, chip on card) survives
// recoloring by construction. Neutral grays are deliberately NOT listed, so body text never
// shifts. This is how design tools theme templates; it gives real visual variety without a
// second copy of any layout's HTML.
function hexToHsl(hexstr) {
  const h6 = hexstr.length === 4 ? '#' + [...hexstr.slice(1)].map(c => c + c).join('') : hexstr;
  const r = parseInt(h6.slice(1, 3), 16) / 255, g = parseInt(h6.slice(3, 5), 16) / 255, b = parseInt(h6.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h: h * 360, s, l };
}
function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  const f = (p, q, t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    r = f(p, q, h + 1 / 3); g = f(p, q, h); b = f(p, q, h - 1 / 3);
  }
  const to = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
  return '#' + to(r) + to(g) + to(b);
}
// WCAG-style relative luminance of a #rrggbb (linearized sRGB) — how BRIGHT a color reads.
function relLum(hexstr) {
  const c = (i) => {
    const v = parseInt(hexstr.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * c(1) + 0.7152 * c(3) + 0.0722 * c(5);
}

// Re-hue one hex: hue → t.hue, saturation → max(s·satMul, satFloor).
//
// ⚠️ HSL lightness is NOT perceived brightness — green reads far brighter than blue at the same
// L, so a naive re-hue turns a readable violet heading into a washed-out mint. For mid-range
// accents (the ones used as text and fills) we therefore nudge L until the recolor's RELATIVE
// LUMINANCE matches the source's, which is what actually preserves contrast against the paper
// and against overlaid text. Near-white tints and near-black inks keep their L — matching those
// would visibly darken backgrounds for no contrast benefit.
function shiftHex(hexstr, t) {
  const src = hexToHsl(hexstr);
  const sat = Math.min(1, Math.max(src.s * (t.satMul != null ? t.satMul : 1), t.satFloor || 0));
  const hue = t.hue != null ? t.hue : src.h;
  let l = src.l;
  if (l > 0.15 && l < 0.8) {
    const target = relLum(hexstr);
    for (let i = 0; i < 6; i++) {
      const got = relLum(hslToHex(hue, sat, l));
      const diff = target - got;
      if (Math.abs(diff) < 0.004) break;
      l = Math.min(0.85, Math.max(0.05, l + diff * 0.9));
    }
  }
  return hslToHex(hue, sat, l);
}

// The hexes that ARE each family's accent scheme (from its own CSS — keep in sync when a
// family's CSS changes). Everything else in that family is neutral and never recolored.
const FAMILY_ACCENTS = {
  azure:     ['#0a7aa6', '#0e6e93', '#13567a', '#3fb9e6', '#bfe9f8', '#dff1f8'],
  executive: ['#e0a64b', '#f0c987'],
  minimal:   ['#0b7d70', '#0e9f8e', '#d8e3e1', '#e7f6f3'],
  ats:       ['#111827', '#1f2937'],
  exec_pro:  ['#7c6a45', '#c9a96a'],
  india:     ['#0e7490', '#a5f3fc', '#ecfeff'],
  germany:   ['#0f172a', '#1f2937', '#334155'],
  europass:  ['#2557a7', '#dbe6f5', '#eaf1fb'],
  startup:   ['#5b5bd6', '#e5e5f3', '#ececf6', '#f4f4fb', '#f7f7fd'],
  banner   : ['#2563eb', '#1d4ed8', '#1e40af', '#dbe7fe', '#eff4ff', '#c7d7fb'],
  rightrail: ['#0f766e', '#115e59', '#99f6e4', '#ccfbf1', '#e6f7f4'],
  mono     : ['#16a34a', '#15803d', '#bbf7d0', '#f0fdf4'],
  elegant  : ['#7f1d1d', '#dcc3c3'],
  compact  : ['#4338ca', '#3730a3', '#e0e7ff', '#eef2ff'],
  timeline : ['#ea580c', '#c2410c', '#fdba74', '#fed7aa', '#ffedd5', '#fff7ed'],
};

// Re-hue exactly `hexes` (lower- or upper-case spellings) wherever they occur in the HTML. Also the
// engine behind the letter templates' branding (coverLetterTemplates), which has its own hex lists.
// `rgba`: also re-hue the same accents spelled as translucent rgba(r,g,b,α) tints (Azure's section-icon
// tile, Minimal's chip shadow) at their own alpha. The BRAND path asks for it — a red-branded resume
// must not keep a faint blue tile — while the variants deliberately do not: their unbranded output is
// pinned byte-for-byte (preview caches, test-resume-templates), so that gap stays theirs.
const rgbOf = (hexstr) => [1, 3, 5].map((i) => parseInt(hexstr.slice(i, i + 2), 16));
function recolorHexes(html, hexes, theme, { rgba = false } = {}) {
  let out = html;
  for (const hx of hexes) {
    const next = shiftHex(hx, theme);
    out = out.split(hx).join(next).split(hx.toUpperCase()).join(next);
    if (rgba) out = out.split(`rgba(${rgbOf(hx).join(',')},`).join(`rgba(${rgbOf(next).join(',')},`);
  }
  return out;
}
function recolorHtml(html, familyId, theme, o) {
  return recolorHexes(html, FAMILY_ACCENTS[familyId] || [], theme, o);
}

// Per-family variants: curated hue targets with product-quality names. `sf`/`sm` tune
// saturation for near-neutral sources (ATS/Germany) and desaturated looks (Platinum).
const FAMILY_VARIANTS = {
  azure: [
    { suffix: 'emerald',  name: 'Emerald Sidebar',        theme: { hue: 152 } },
    { suffix: 'violet',   name: 'Violet Sidebar',         theme: { hue: 268 } },
    { suffix: 'burgundy', name: 'Burgundy Sidebar',       theme: { hue: 345 } },
    { suffix: 'amber',    name: 'Amber Sidebar',          theme: { hue: 28 } },
  ],
  executive: [
    { suffix: 'platinum', name: 'Executive Platinum',     theme: { hue: 215, satMul: 0.12 } },
    { suffix: 'emerald',  name: 'Executive Emerald',      theme: { hue: 150 } },
    { suffix: 'copper',   name: 'Executive Copper',       theme: { hue: 18 } },
  ],
  minimal: [
    { suffix: 'indigo',   name: 'Indigo Minimal',         theme: { hue: 243 } },
    { suffix: 'rose',     name: 'Rose Minimal',           theme: { hue: 338 } },
    { suffix: 'forest',   name: 'Forest Minimal',         theme: { hue: 140 } },
  ],
  ats: [
    { suffix: 'navy',     name: 'ATS Navy',               theme: { hue: 218, satFloor: 0.45 } },
    { suffix: 'green',    name: 'ATS Green',              theme: { hue: 155, satFloor: 0.40 } },
    { suffix: 'maroon',   name: 'ATS Maroon',             theme: { hue: 348, satFloor: 0.45 } },
  ],
  exec_pro: [
    { suffix: 'steel',    name: 'Steel Professional',     theme: { hue: 214 } },
    { suffix: 'royal',    name: 'Royal Professional',     theme: { hue: 262 } },
    { suffix: 'slate',    name: 'Slate Professional',     theme: { hue: 215, satMul: 0.15 } },
  ],
  india: [
    { suffix: 'saffron',  name: 'India Saffron',          theme: { hue: 30 } },
    { suffix: 'emerald',  name: 'India Emerald',          theme: { hue: 150 } },
    { suffix: 'navy',     name: 'India Navy',             theme: { hue: 222 } },
  ],
  germany: [
    { suffix: 'blue',     name: 'Germany Blue',           theme: { hue: 218, satFloor: 0.28 } },
    { suffix: 'warm',     name: 'Germany Warm',           theme: { hue: 28, satFloor: 0.14 } },
  ],
  europass: [
    { suffix: 'teal',     name: 'Europass Teal',          theme: { hue: 180 } },
    { suffix: 'violet',   name: 'Europass Violet',        theme: { hue: 262 } },
    { suffix: 'graphite', name: 'Europass Graphite',      theme: { hue: 215, satMul: 0.10 } },
  ],
  startup: [
    { suffix: 'coral',    name: 'Startup Coral',          theme: { hue: 8 } },
    { suffix: 'mint',     name: 'Startup Mint',           theme: { hue: 160 } },
    { suffix: 'amber',    name: 'Startup Amber',          theme: { hue: 38 } },
    { suffix: 'ocean',    name: 'Startup Ocean',          theme: { hue: 200 } },
  ],
  banner: [
    { suffix: 'crimson', name: "Banner Crimson", theme: { hue: 350 } },
    { suffix: 'teal', name: "Banner Teal", theme: { hue: 176 } },
    { suffix: 'plum', name: "Banner Plum", theme: { hue: 283 } },
    { suffix: 'ember', name: "Banner Ember", theme: { hue: 24 } },
    { suffix: 'pine', name: "Banner Pine", theme: { hue: 150 } },
  ],
  rightrail: [
    { suffix: 'sapphire', name: "Sapphire Rail", theme: { hue: 221 } },
    { suffix: 'plum', name: "Plum Rail", theme: { hue: 283 } },
    { suffix: 'crimson', name: "Crimson Rail", theme: { hue: 350 } },
    { suffix: 'honey', name: "Honey Rail", theme: { hue: 40 } },
    { suffix: 'stone', name: "Stone Rail", theme: { hue: 210, satMul: 0.14 } },
  ],
  mono: [
    { suffix: 'amber', name: "Mono Amber", theme: { hue: 40 } },
    { suffix: 'cobalt', name: "Mono Cobalt", theme: { hue: 220 } },
    { suffix: 'cyan', name: "Mono Cyan", theme: { hue: 190 } },
    { suffix: 'magenta', name: "Mono Magenta", theme: { hue: 320 } },
    { suffix: 'graphite', name: "Mono Graphite", theme: { hue: 215, satMul: 0.1 } },
  ],
  elegant: [
    { suffix: 'midnight', name: "Serif Midnight", theme: { hue: 226 } },
    { suffix: 'hunter', name: "Serif Hunter", theme: { hue: 152 } },
    { suffix: 'sepia', name: "Serif Sepia", theme: { hue: 26, satMul: 0.85 } },
    { suffix: 'aubergine', name: "Serif Aubergine", theme: { hue: 288 } },
    { suffix: 'charcoal', name: "Serif Charcoal", theme: { hue: 215, satMul: 0.12 } },
  ],
  compact: [
    { suffix: 'sapphire', name: "Compact Sapphire", theme: { hue: 213 } },
    { suffix: 'evergreen', name: "Compact Evergreen", theme: { hue: 152 } },
    { suffix: 'garnet', name: "Compact Garnet", theme: { hue: 350 } },
    { suffix: 'bronze', name: "Compact Bronze", theme: { hue: 30 } },
    { suffix: 'charcoal', name: "Compact Charcoal", theme: { hue: 220, satMul: 0.14 } },
  ],
  timeline: [
    { suffix: 'sky', name: "Timeline Sky", theme: { hue: 205 } },
    { suffix: 'jade', name: "Timeline Jade", theme: { hue: 165 } },
    { suffix: 'orchid', name: "Timeline Orchid", theme: { hue: 282 } },
    { suffix: 'crimson', name: "Timeline Crimson", theme: { hue: 348 } },
    { suffix: 'charcoal', name: "Timeline Charcoal", theme: { hue: 215, satMul: 0.12 } },
  ],};

// ── Registry ──────────────────────────────────────────────────────────────────
const TEMPLATES = [
  // Generic visual styles (region: any)
  { id: 'azure',     name: 'Azure Sidebar',          accent: '#0a7aa6', region: 'generic', build: azure },
  { id: 'executive', name: 'Executive Dark',         accent: '#e0a64b', region: 'generic', build: executive },
  { id: 'minimal',   name: 'Modern Minimal',         accent: '#0e9f8e', region: 'generic', build: minimal },
  // Country / region formats
  { id: 'ats',       name: 'ATS Modern',             accent: '#1f2937', ats: 5, build: atsModern },
  { id: 'exec_pro',  name: 'Executive Professional', accent: '#7c6a45', ats: 5, build: execPro },
  { id: 'india',     name: 'India Professional',     accent: '#0e7490', ats: 4, build: indiaPro },
  { id: 'germany',   name: 'Germany Professional',   accent: '#334155', ats: 4, photo: true, build: germanyPro },
  { id: 'europass',  name: 'Europass Premium',       accent: '#2557a7', ats: 4, photo: true, build: europass },
  { id: 'startup',   name: 'Startup Modern',         accent: '#5b5bd6', ats: 4, build: startupModern },
  // ── The 2026-08-25 expansion: six new layout families (authored + variant-themed) ──
  { id: 'banner',   name: "Bold Banner",             accent: '#1d4ed8', ats: 4, photo: true, build: boldBanner },
  { id: 'rightrail', name: "Right Rail",              accent: '#0f766e', ats: 3, photo: true, build: rightRail },
  { id: 'mono',     name: "Tech Mono",               accent: '#16a34a', ats: 5, build: techMono },
  { id: 'elegant',  name: "Elegant Serif",           accent: '#7f1d1d', ats: 4, build: elegantSerif },
  { id: 'compact',  name: "Compact Pro",             accent: '#4338ca', ats: 4, build: compactPro },
  { id: 'timeline', name: "Career Timeline",         accent: '#ea580c', ats: 4, photo: true, build: careerTimeline },
];

// A4 sidebar-band geometry per FAMILY (moved here from resumeRenderer so variants can carry
// their own recolored band — the renderer composites whatever the template entry declares).
const FAMILY_BANDS = {
  azure:     { side: 'left', widthMm: 75, top: '#0a7aa6', bottom: '#13567a' },
  executive: { side: 'left', widthMm: 74, top: '#2c3742', bottom: '#222b34' },
};
for (const t of TEMPLATES) { t.family = t.id; if (FAMILY_BANDS[t.id]) t.band = FAMILY_BANDS[t.id]; }

// Expand the registry with the recolored variants. Every variant is a full first-class
// template: same layout engine, its own id/name/accent/band, `family` pointing home.
for (const base of [...TEMPLATES]) {
  for (const v of FAMILY_VARIANTS[base.id] || []) {
    const build = (d, opts = {}) => recolorHtml(base.build(d, opts), base.id, v.theme);
    const band = base.band
      ? { ...base.band,
          top:    FAMILY_ACCENTS[base.id].includes(base.band.top)    ? shiftHex(base.band.top, v.theme)    : base.band.top,
          bottom: FAMILY_ACCENTS[base.id].includes(base.band.bottom) ? shiftHex(base.band.bottom, v.theme) : base.band.bottom }
      : undefined;
    TEMPLATES.push({
      id: `${base.id}_${v.suffix}`, name: v.name, family: base.id,
      accent: shiftHex(base.accent, v.theme),
      region: base.region, ats: base.ats, photo: base.photo,
      band, build,
    });
  }
}

// Family metadata for the app's template gallery: one preview per family, a swatch per
// variant — the honest UI for "same layout, different palette" (previewing all 37 as full
// images is what used to melt the preview endpoint).
const FAMILIES = TEMPLATES.filter(t => t.family === t.id).map(base => ({
  id: base.id, name: base.name, accent: base.accent,
  ats: base.ats || null, photo: !!base.photo,
  variants: TEMPLATES.filter(t => t.family === base.id).map(t => ({ id: t.id, name: t.name, accent: t.accent })),
}));

const TEMPLATE_IDS = TEMPLATES.map(t => t.id);

// Region → its LAYOUT FAMILIES (level one of the gallery: pick a region, page through its
// families, restyle via variant swatches). Family ids only — the app expands variants itself.
// ⚠️ Keep every list ≤4: app builds ≤194 still render a region's whole list in ONE request.
// ⚠️ Unknown ids are dropped by templatesForRegion, so a list may name a family shipping later.
const REGIONS = [
  { id: 'generic', label: 'Generic',        sub: 'Any country',          templates: ['azure', 'executive', 'minimal', 'startup'] },
  { id: 'us_ca',   label: 'USA / Canada',   sub: 'United States · Canada', templates: ['ats', 'exec_pro', 'rightrail', 'mono'] },
  { id: 'uk_au',   label: 'UK / Australia', sub: 'United Kingdom · Australia', templates: ['ats', 'exec_pro', 'elegant', 'banner'] },
  { id: 'india',   label: 'India / South Asia', sub: 'India · Bangladesh · Nepal · Sri Lanka', templates: ['india', 'compact', 'azure', 'ats'] },
  { id: 'dach',    label: 'Germany / DACH', sub: 'Germany · Austria · Switzerland', templates: ['germany', 'europass', 'elegant'] },
  { id: 'eu',      label: 'Europe / EU',    sub: 'France · Spain · Italy · EU', templates: ['europass', 'germany', 'timeline', 'banner'] },
  { id: 'sg',      label: 'Singapore',      sub: 'Singapore · APAC hubs', templates: ['exec_pro', 'startup', 'compact', 'timeline'] },
];

function templatesForRegion(regionId) {
  const r = REGIONS.find(x => x.id === regionId);
  return (r ? r.templates : REGIONS[0].templates).map(id => TEMPLATES.find(t => t.id === id)).filter(Boolean);
}

// ── Employer branding ─────────────────────────────────────────────────────────
//
// A Home employer document (the doc lane in resumeBuilderController) renders in the EMPLOYER'S colour
// and font: design.brand = { accent: '#rrggbb'|null, font: { family, google }|null } (employerResearch's
// brandOf — brandExtract's deterministic read of the website first, the researcher's guess second)
// arrives here as opts.brand. The colour is applied exactly the way a variant is: the FAMILY's accent
// scheme is re-hued by shiftHex with a theme DERIVED from the brand colour, so every accent keeps its
// own luminance and white-on-band / heading-on-paper contrast survives whatever colour the employer
// uses — a brand yellow does not become a yellow sidebar with white text on it, it becomes the
// sidebar's own darkness in yellow's hue. The font is added ONLY when it is a verified Google font
// (brandExtract checked fonts.googleapis.com answers for it): its <link> joins the head and the family
// goes FIRST in every body/heading stack, Lato/Poppins staying as the fallbacks. An unverified font
// would render as the fallback after a failed fetch, so it is not linked at all.
// ⚠️ No brand → tpl.build untouched: the unbranded HTML is byte-identical to before branding existed
// (the gallery previews, the classic downloads and their disk caches all key on that).
const HEX6_RE = /^#?([0-9a-f]{6})$/i;
const HEX3_RE = /^#?([0-9a-f]{3})$/i;
// '#rrggbb' (lower-case) from any hex spelling — #rgb, rrggbb, surrounding whitespace — else null.
function normHex(v) {
  const s = String(v == null ? '' : v).trim();
  let m = HEX6_RE.exec(s);
  if (m) return '#' + m[1].toLowerCase();
  m = HEX3_RE.exec(s);
  return m ? '#' + [...m[1].toLowerCase()].map((c) => c + c).join('') : null;
}
// { family, google } from opts.brand.font — the family reduced to what a CSS string and a Google Fonts
// URL can carry: surrounding quotes dropped, then everything from the first character that is not a
// letter, digit, space or hyphen cut off ("Roboto, sans-serif" is Roboto; ≤60 chars). A non-Google
// font is kept (the Word builder wants the name) but never linked.
function brandFontOf(v) {
  if (!v || typeof v !== 'object') return null;
  const family = String(v.family == null ? '' : v.family).replace(/^['"\s]+|['"\s]+$/g, '').split(/[^A-Za-z0-9 \-]/)[0].replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!family || !/[A-Za-z]/.test(family)) return null;
  return { family, google: v.google === true };
}
// opts.brand → { accent: '#hex'|null, font: {family,google}|null }, or null when it says nothing.
function normBrand(b) {
  if (!b || typeof b !== 'object') return null;
  const accent = normHex(b.accent);
  const font = brandFontOf(b.font);
  return accent || font ? { accent, font } : null;
}

// The recolour theme a brand colour makes: its hue; its saturation as the floor, and as a multiplier
// against the reference PRIMARY accent — so a muted brand mutes a vivid family (satMul < 1) and a vivid
// brand lifts a near-neutral one (Germany's slate, ATS's ink: satMul > 1, which shiftHex caps at 1.0).
// Lightness is deliberately NOT taken from the brand (see above). `ref` is a family id (its registry
// accent is the reference) or a '#hex' reference accent (the letter templates pass their own); with
// neither, the reference is a typical vivid accent.
const REF_SAT = 0.85;
function brandThemeOf(accent, ref) {
  const hx = normHex(accent);
  if (!hx) return null;
  const { h, s } = hexToHsl(hx);
  let refSat = REF_SAT;
  const refHex = typeof ref === 'string' && ref[0] === '#' ? normHex(ref) : null;
  if (refHex) refSat = hexToHsl(refHex).s;
  else if (ref) { const base = TEMPLATES.find((t) => t.id === ref); if (base) refSat = hexToHsl(base.accent).s; }
  return { hue: h, satFloor: s, satMul: refSat > 0.02 ? s / refSat : 1 };
}

// What a template becomes under a brand: { accent, band, theme, font } — the accent the gallery/cards
// show for it, the A4 sidebar band the PDF compositor must paint (recoloured like the HTML), the theme
// that did it and the font to set. A VARIANT brands from its FAMILY's palette: the brand colour replaces
// the variant's hue outright, so the family's hexes (the ones its CSS names) are the ones to shift.
// Without a brand colour the template's own accent/band come back unchanged.
function brandedTemplate(tpl, brand) {
  const b = normBrand(brand);
  const t = (typeof tpl === 'string' ? TEMPLATES.find((x) => x.id === tpl) : tpl) || TEMPLATES[0];
  const base = TEMPLATES.find((x) => x.id === t.family) || t;
  const theme = b && b.accent ? brandThemeOf(b.accent, base.id) : null;
  if (!theme) return { accent: t.accent, band: t.band, theme: null, font: b ? b.font : null };
  const accents = FAMILY_ACCENTS[base.id] || [];
  const shiftBand = (hx) => (accents.includes(hx) ? shiftHex(hx, theme) : hx);
  const band = base.band ? { ...base.band, top: shiftBand(base.band.top), bottom: shiftBand(base.band.bottom) } : undefined;
  return { accent: shiftHex(base.accent, theme), band, theme, font: b.font };
}

// The stacks the templates declare (resume and letter alike) — the brand family is put in front of
// exactly these. ui-monospace (Tech Mono's labels) is a deliberate code look, not a typeface choice,
// and is left alone.
const FONT_STACK_HEADS = ["'Lato',", "'Poppins',", "'Merriweather',", 'Georgia,'];
function googleFontHref(family) {
  return `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@400;600;700&display=swap`;
}
// Set a verified Google font as the document's typeface: link it and lead every declared stack with
// it. Anything but { family, google:true } leaves the HTML untouched.
function brandFontHtml(html, font) {
  const f = brandFontOf(font);
  if (!f || !f.google) return html;
  let out = html;
  for (const head of FONT_STACK_HEADS) out = out.split(`font-family:${head}`).join(`font-family:'${f.family}',${head}`);
  // The <link> goes in right before the first <style> — after the templates' own Google Fonts link. The
  // renderers' route allows exactly that host, and resumeRenderer's font cache keys on this URL.
  return out.replace('<style>', `<link href="${googleFontHref(f.family)}" rel="stylesheet"><style>`);
}

function renderResumeHtml(templateId, resumeData, opts = {}) {
  const tpl = TEMPLATES.find(t => t.id === templateId) || TEMPLATES[0];
  const brand = normBrand(opts.brand);
  if (!brand) return tpl.build(resumeData || {}, opts);
  const { theme, font } = brandedTemplate(tpl, brand);
  const base = TEMPLATES.find((t) => t.id === tpl.family) || tpl;
  // With a colour: the FAMILY's layout re-hued to the brand (a variant's own recolour is replaced, not
  // stacked — its hexes are gone from the family's HTML). Without one: the design exactly as picked.
  const html = theme ? recolorHtml(base.build(resumeData || {}, opts), base.id, theme, { rgba: true }) : tpl.build(resumeData || {}, opts);
  return brandFontHtml(html, font);
}

module.exports = {
  TEMPLATES, TEMPLATE_IDS, REGIONS, FAMILIES, templatesForRegion, renderResumeHtml,
  // Employer branding (also consumed by coverLetterTemplates / the renderers / docxBuilder).
  brandThemeOf, brandedTemplate, brandFontHtml, brandFontOf, normBrand, normHex, googleFontHref,
  recolorHexes, shiftHex, hexToHsl, hslToHex, relLum,
};
