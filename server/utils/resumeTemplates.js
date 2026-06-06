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

// Escape, then turn **keyword** into <b>keyword</b>, dropping any stray asterisks.
function fmt(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '\x01$1\x02')
    .replace(/\*/g, '')
    .replace(/\x01(.+?)\x02/g, '<b>$1</b>');
}

// Plain escaped text with all ** markers stripped (no bold).
function plain(s) {
  return esc(String(s == null ? '' : s).replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*/g, ''));
}

// Raw (un-escaped) plain text — for splitting names, etc.
function raw(s) {
  return String(s == null ? '' : s).replace(/\*+/g, '').trim();
}

function nonEmpty(arr) {
  return Array.isArray(arr) ? arr.filter(x => x != null && String(x).trim() !== '') : [];
}

// Split the AI summary ("paragraph\n• bullet\n• bullet") into { paras, bullets }.
function splitSummary(summary) {
  const lines = String(summary || '').split('\n').map(l => l.trim()).filter(Boolean);
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
  return mode === 'a4'
    ? '@page{size:A4;margin:14mm 0}\n  .sheet{min-height:0}'
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

// ── Registry ──────────────────────────────────────────────────────────────────
const TEMPLATES = [
  { id: 'azure',     name: 'Azure Sidebar',  accent: '#0a7aa6', build: azure },
  { id: 'executive', name: 'Executive Dark', accent: '#e0a64b', build: executive },
  { id: 'minimal',   name: 'Modern Minimal', accent: '#0e9f8e', build: minimal },
];

const TEMPLATE_IDS = TEMPLATES.map(t => t.id);

function renderResumeHtml(templateId, resumeData, opts = {}) {
  const tpl = TEMPLATES.find(t => t.id === templateId) || TEMPLATES[0];
  return tpl.build(resumeData || {}, opts);
}

module.exports = { TEMPLATES, TEMPLATE_IDS, renderResumeHtml };
