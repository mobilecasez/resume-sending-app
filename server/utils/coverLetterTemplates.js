// Cover Letter Builder — new feature. Safe to delete without affecting existing app.
'use strict';

/**
 * Country-format cover-letter templates. Same idea as resumeTemplates.js but for a
 * letter: one shared layout (letterhead → date → recipient → salutation → body →
 * closing) rendered in 6 visual styles. The wording is tailored to the target
 * country at GENERATION time; these templates are the visual layer.
 *
 * data = { sender:{name,title,email,phone,location}, company:{name,address}, bodyHtml }
 * opts = { mode:'onepage'|'a4' }
 */

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function raw(s) { return String(s == null ? '' : s).trim(); }

// Keep only safe formatting tags from the (server-generated, client-round-tripped) body.
function sanitizeBody(html) {
  let h = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/javascript:/gi, '');
  return h;
}
// Body may arrive as HTML (our formatter) or plain text — normalise to <p> paragraphs.
function bodyToHtml(input) {
  const s = String(input || '');
  if (/<(p|br|div|strong|em|ul|li)\b/i.test(s)) return sanitizeBody(s);
  return s.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
    .map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
}

function fontsHead(title) {
  return `<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&family=Lato:wght@400;700&family=Merriweather:wght@400;700&display=swap" rel="stylesheet">`;
}

// onepage: padding on the sheet, single page sized to content.
// a4: real A4 pages with top/bottom margins; horizontal letter margins via padding.
function clPageRule(mode) {
  // @page :first{margin-top:0}: no top margin on the FIRST page (letter starts flush);
  // pages 2+ keep the 20mm top margin and all pages keep the bottom margin, so the body
  // text is never clipped at a page break. Margins are on CONTENT only.
  return mode === 'a4'
    ? '@page{size:A4;margin:20mm 0}@page :first{margin-top:0}\n  .sheet{padding:0 22mm;min-height:0}'
    : '@page{margin:0}\n  .sheet{padding:22mm;min-height:297mm}';
}

function prep(data) {
  const s = data.sender || {};
  const c = data.company || {};
  return {
    s, c,
    date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
    body: bodyToHtml(data.bodyHtml || data.body || data.coverLetterHtml || ''),
    contact: [raw(s.email), raw(s.phone), raw(s.location)].filter(Boolean).map(esc).join('&nbsp;&nbsp;•&nbsp;&nbsp;'),
  };
}

function recipientBlock(c) {
  if (!raw(c.name) && !raw(c.address)) return '';
  return `<div class="recipient">${raw(c.name) ? `<div class="rc-name">${esc(c.name)}</div>` : ''}${raw(c.address) ? `<div class="rc-addr">${esc(c.address)}</div>` : ''}</div>`;
}

// ── Shared letter assembler ───────────────────────────────────────────────────
function buildLetter(data, opts, style) {
  const { s, c, date, body, contact } = prep(data);
  const baseCss = `
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{background:#fff;color:#1f2937;font-family:'Lato',-apple-system,'Segoe UI',Roboto,Arial,sans-serif}
  body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .sheet{width:210mm;background:#fff}
  .date{font-size:10.5pt;color:#374151;margin:18px 0 14px}
  .recipient{margin-bottom:16px}
  .rc-name{font-weight:700;font-size:10.5pt;color:#111827}
  .rc-addr{font-size:10pt;color:#4b5563;line-height:1.4}
  .salutation{font-size:11pt;color:#1f2937;margin-bottom:12px}
  .body p{font-size:11pt;line-height:1.62;color:#27313f;margin-bottom:12px;text-align:justify}
  .body strong,.body b{font-weight:700;color:#1f2937}
  .closing{margin-top:18px}
  .cl-word{font-size:11pt;color:#27313f}
  .cl-name{font-weight:700;font-size:11pt;color:#111827;margin-top:18px}
  `;
  return `<!DOCTYPE html><html lang="en"><head>${fontsHead('Cover Letter')}<style>
${baseCss}${style.css}
  ${clPageRule(opts.mode)}
</style></head><body><div class="sheet">
  ${style.header(s, contact)}
  <div class="date">${esc(date)}</div>
  ${recipientBlock(c)}
  <div class="salutation">${esc(style.salutation || 'Dear Hiring Manager,')}</div>
  <div class="body">${body}</div>
  <div class="closing"><div class="cl-word">${esc(style.closing || 'Sincerely,')}</div><div class="cl-name">${esc(raw(s.name) || '')}</div></div>
</div></body></html>`;
}

// ── 6 master styles ───────────────────────────────────────────────────────────
const STYLES = {
  // 1 — ATS Professional (US/CA): clean, direct, ATS-safe
  ats_pro: {
    salutation: 'Dear Hiring Manager,', closing: 'Sincerely,',
    header: (s, contact) => `<header class="lh"><div class="name">${esc(raw(s.name))}</div>${raw(s.title) ? `<div class="title">${esc(s.title)}</div>` : ''}${contact ? `<div class="contact">${contact}</div>` : ''}</header>`,
    css: `
    .lh{border-bottom:1.5px solid #111827;padding-bottom:12px}
    .name{font-family:'Poppins',sans-serif;font-weight:700;font-size:20pt;color:#111827;letter-spacing:.3px}
    .title{font-size:10.5pt;color:#374151;margin-top:2px}
    .contact{font-size:9.5pt;color:#4b5563;margin-top:6px}`,
  },
  // 2 — Executive Leadership (US/UK/AU/SG): premium, centered, refined
  exec_leader: {
    salutation: 'Dear Hiring Manager,', closing: 'Respectfully,',
    header: (s, contact) => `<header class="lh"><div class="name">${esc(raw(s.name))}</div>${raw(s.title) ? `<div class="title">${esc(s.title)}</div>` : ''}${contact ? `<div class="contact">${contact}</div>` : ''}</header>`,
    css: `
    body{font-family:'Merriweather',Georgia,serif}
    .lh{text-align:center;border-bottom:2px solid #b8995a;padding-bottom:14px}
    .name{font-family:'Poppins',sans-serif;font-weight:600;font-size:23pt;color:#1e293b;letter-spacing:3px;text-transform:uppercase}
    .title{font-size:10pt;letter-spacing:2px;text-transform:uppercase;color:#7c6a45;margin-top:7px}
    .contact{font-size:9.5pt;color:#5b6473;margin-top:9px}
    .body p{font-size:11pt;line-height:1.7}`,
  },
  // 3 — Technical Specialist (IN/US/CA): modern, teal accent
  technical: {
    salutation: 'Dear Hiring Manager,', closing: 'Best regards,',
    header: (s, contact) => `<header class="lh"><div class="name">${esc(raw(s.name))}</div>${raw(s.title) ? `<div class="title">${esc(s.title)}</div>` : ''}${contact ? `<div class="contact">${contact}</div>` : ''}</header>`,
    css: `
    .lh{border-left:5px solid #0e7490;padding:2px 0 2px 14px;margin-bottom:4px}
    .name{font-family:'Poppins',sans-serif;font-weight:700;font-size:20pt;color:#0f172a}
    .title{font-size:10.5pt;color:#0e7490;font-weight:700;margin-top:2px}
    .contact{font-size:9.5pt;color:#475569;margin-top:6px}
    .salutation{color:#0f172a;font-weight:700}`,
  },
  // 4 — German Professional (DE/AT/CH): formal, structured, conservative
  german: {
    salutation: 'Dear Sir or Madam,', closing: 'Yours faithfully,',
    header: (s, contact) => `<header class="lh"><div class="hl"><div class="name">${esc(raw(s.name))}</div>${raw(s.title) ? `<div class="title">${esc(s.title)}</div>` : ''}</div><div class="hr">${contact ? contact.split('&nbsp;&nbsp;•&nbsp;&nbsp;').map(x => `<div>${x}</div>`).join('') : ''}</div></header>`,
    css: `
    .lh{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:1px solid #94a3b8;padding-bottom:12px}
    .name{font-family:'Poppins',sans-serif;font-weight:600;font-size:19pt;color:#1f2937}
    .title{font-size:10pt;color:#475569;margin-top:2px}
    .hr{text-align:right;font-size:9pt;color:#475569;line-height:1.5}
    .body p{text-align:justify;font-size:10.5pt;line-height:1.6}
    .cl-word{margin-bottom:4px}`,
  },
  // 5 — European Motivation Letter (FR/ES/IT/EU): elegant, warm
  euro_motivation: {
    salutation: 'Dear Hiring Manager,', closing: 'Yours sincerely,',
    header: (s, contact) => `<header class="lh"><div class="name">${esc(raw(s.name))}</div>${raw(s.title) ? `<div class="title">${esc(s.title)}</div>` : ''}${contact ? `<div class="contact">${contact}</div>` : ''}</header>`,
    css: `
    body{font-family:'Merriweather',Georgia,serif}
    .lh{border-bottom:1px solid #c7b8a3;padding-bottom:13px}
    .name{font-family:'Poppins',sans-serif;font-weight:600;font-size:21pt;color:#3b352c}
    .title{font-size:10pt;color:#8a7a5e;margin-top:3px;letter-spacing:.5px}
    .contact{font-size:9.5pt;color:#6b6354;margin-top:7px}
    .body p{line-height:1.72}`,
  },
  // 6 — Graduate / Entry Level (Global): modern, approachable, indigo
  graduate: {
    salutation: 'Dear Hiring Manager,', closing: 'Sincerely,',
    header: (s, contact) => `<header class="lh"><div class="name">${esc(raw(s.name))}</div>${raw(s.title) ? `<div class="title">${esc(s.title)}</div>` : ''}${contact ? `<div class="contact">${contact}</div>` : ''}</header>`,
    css: `
    .lh{background:#f4f4fb;border:1px solid #e5e5f3;border-radius:12px;padding:16px 18px}
    .name{font-family:'Poppins',sans-serif;font-weight:700;font-size:21pt;color:#16161d;letter-spacing:-.3px}
    .title{font-size:10.5pt;color:#5b5bd6;font-weight:600;margin-top:2px}
    .contact{font-size:9.5pt;color:#44445a;margin-top:7px}`,
  },
};

// ── Generic / Original — preview that mirrors the original branded letter
//    (dark sidebar with photo + TO/FROM/DATE, body with name header + "Cover Letter").
//    The DOWNLOAD for this template is produced by the original PDFKit generator
//    (generateRichCoverLetterPDF) so it is byte-for-byte the user's previous letter.
function standardLetter(data, opts = {}) {
  const { s, c, date, body } = prep(data);
  const hex6 = String(opts.brandColor || '').replace('#', '');
  const brand = /^[0-9a-fA-F]{6}$/.test(hex6) ? `#${hex6}` : '#3a6cb5';
  const ini = raw(s.name).split(/\s+/).filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  const avatar = opts.photo ? `<img src="${esc(opts.photo)}" alt="">` : (ini ? `<span>${esc(ini)}</span>` : '');
  let dateShort = date;
  try { dateShort = new Date().toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' }); } catch {}
  const footRows = [raw(s.email), raw(s.location)].filter(Boolean).map(x => `<div>${esc(x)}</div>`).join('');
  const topRight = [raw(s.location), raw(s.email)].filter(Boolean).map(x => `<div>${esc(x)}</div>`).join('');
  const pageRule = opts.mode === 'a4' ? '@page{size:A4;margin:0}.sheet{min-height:0}' : '@page{margin:0}.sheet{min-height:297mm}';
  return `<!DOCTYPE html><html lang="en"><head>${fontsHead('Cover Letter')}<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{background:#fff;font-family:'Lato',-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#2b333b}
  body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .sheet{width:210mm;background:#fff;display:flex;overflow:hidden}
  .side{width:70mm;flex:0 0 70mm;background:linear-gradient(180deg,#1c2431,#0d1014);color:#c8d0da;padding:24mm 20px 16mm;display:flex;flex-direction:column}
  .avatar{width:96px;height:96px;border-radius:50%;overflow:hidden;margin:0 auto 22px;border:2px solid #fff;display:flex;align-items:center;justify-content:center;background:#2b3442;flex:0 0 auto}
  .avatar img{width:100%;height:100%;object-fit:cover}.avatar span{font-family:'Poppins',sans-serif;font-weight:700;font-size:32px;color:#fff}
  .blk{margin-bottom:18px}
  .lbl{font-family:'Poppins',sans-serif;font-weight:700;font-size:10pt;letter-spacing:1.5px;color:#fff}
  .lbl::after{content:"";display:block;width:22px;height:2px;background:${brand};margin:5px 0 7px}
  .blk .v{font-size:9.5pt;line-height:1.5;color:#c8d0da}.blk .v b{color:#fff;font-weight:700}
  .side-foot{margin-top:auto;font-size:8.5pt;color:#8b95a3;line-height:1.7}
  .main{flex:1;padding:24mm 18mm 18mm;min-width:0}
  .top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:1px solid #e2e8f0;padding-bottom:14px;margin-bottom:18px;gap:14px}
  .nm{font-family:'Poppins',sans-serif;font-weight:700;font-size:18pt;color:#1a2230;letter-spacing:.5px;text-transform:uppercase}
  .applicant{font-size:9.5pt;color:#8a94a3;margin-top:3px}
  .tr{text-align:right;font-size:9pt;color:#8a94a3;line-height:1.7;white-space:nowrap}
  .ttl{font-family:'Poppins',sans-serif;font-weight:700;font-size:13pt;color:#1a2230;margin-bottom:14px}
  .salutation{font-size:10.5pt;margin-bottom:12px}
  .body p{font-size:10.5pt;line-height:1.6;color:#2b333b;margin-bottom:11px}
  .body strong,.body b{font-weight:700}
  .closing{margin-top:16px}.cl-word{font-size:10.5pt}.cl-name{font-family:'Poppins',sans-serif;font-weight:700;font-size:10.5pt;color:#1a2230;margin-top:14px;text-transform:uppercase}
  ${pageRule}
</style></head><body><div class="sheet">
  <aside class="side">
    <div class="avatar">${avatar}</div>
    <div class="blk"><div class="lbl">TO</div><div class="v">Hiring Manager,${raw(c.name) ? `<br><b>${esc(c.name)}</b>` : ''}${raw(c.address) ? `<br>${esc(c.address)}` : ''}</div></div>
    <div class="blk"><div class="lbl">FROM</div><div class="v"><b>${esc(raw(s.name))}</b></div></div>
    <div class="blk"><div class="lbl">DATE</div><div class="v">${esc(dateShort)}</div></div>
    ${footRows ? `<div class="side-foot">${footRows}</div>` : ''}
  </aside>
  <main class="main">
    <div class="top"><div><div class="nm">${esc(raw(s.name))}</div><div class="applicant">${raw(s.title) ? esc(s.title) : 'Applicant'}</div></div><div class="tr">${topRight}</div></div>
    <div class="ttl">Cover Letter</div>
    <div class="salutation">Dear Hiring Manager,</div>
    <div class="body">${body}</div>
    <div class="closing"><div class="cl-word">Best regards,</div><div class="cl-name">${esc(raw(s.name) || '')}</div></div>
  </main>
</div></body></html>`;
}

const TEMPLATES = [
  { id: 'standard',        name: 'Original (Branded)',        accent: '#3a6cb5', generic: true, build: (d, o) => standardLetter(d, o) },
  { id: 'ats_pro',         name: 'ATS Professional',          accent: '#1f2937', build: (d, o) => buildLetter(d, o, STYLES.ats_pro) },
  { id: 'exec_leader',     name: 'Executive Leadership',      accent: '#b8995a', build: (d, o) => buildLetter(d, o, STYLES.exec_leader) },
  { id: 'technical',       name: 'Technical Specialist',      accent: '#0e7490', build: (d, o) => buildLetter(d, o, STYLES.technical) },
  { id: 'german',          name: 'German Professional',       accent: '#334155', build: (d, o) => buildLetter(d, o, STYLES.german) },
  { id: 'euro_motivation', name: 'European Motivation',       accent: '#8a7a5e', build: (d, o) => buildLetter(d, o, STYLES.euro_motivation) },
  { id: 'graduate',        name: 'Graduate / Entry Level',    accent: '#5b5bd6', build: (d, o) => buildLetter(d, o, STYLES.graduate) },
];
const TEMPLATE_IDS = TEMPLATES.map(t => t.id);

const REGIONS = [
  { id: 'generic', label: 'Generic',       sub: 'Your original letter, unchanged', templates: ['standard'], noRewrite: true },
  { id: 'us_ca',  label: 'USA / Canada',   sub: 'Direct, achievement-based', templates: ['ats_pro', 'exec_leader', 'technical'] },
  { id: 'uk_au',  label: 'UK / Australia', sub: 'Professional, respectful',   templates: ['exec_leader', 'ats_pro'] },
  { id: 'india',  label: 'India',          sub: 'Skills & projects',          templates: ['technical', 'ats_pro'] },
  { id: 'dach',   label: 'Germany / DACH', sub: 'Formal, qualification-led',  templates: ['german'] },
  { id: 'eu',     label: 'Europe / EU',    sub: 'Motivation & fit',           templates: ['euro_motivation', 'exec_leader'] },
  { id: 'sg',     label: 'Singapore',      sub: 'Corporate, concise',         templates: ['exec_leader', 'ats_pro'] },
  { id: 'global', label: 'Global / Entry', sub: 'Graduate & internships',     templates: ['graduate', 'ats_pro'] },
];

function templatesForRegion(regionId) {
  const r = REGIONS.find(x => x.id === regionId);
  return (r ? r.templates : REGIONS[0].templates).map(id => TEMPLATES.find(t => t.id === id)).filter(Boolean);
}
function renderCoverLetterHtml(templateId, data, opts = {}) {
  const tpl = TEMPLATES.find(t => t.id === templateId) || TEMPLATES[0];
  return tpl.build(data || {}, opts);
}

module.exports = { TEMPLATES, TEMPLATE_IDS, REGIONS, templatesForRegion, renderCoverLetterHtml };
