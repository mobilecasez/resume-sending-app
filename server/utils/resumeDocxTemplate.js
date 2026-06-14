// Clean, Word-native resume HTML built from resume_data — designed to convert
// faithfully to .docx (single column, system fonts, no gradients / flex / absolute
// positioning / pseudo-elements). This is SEPARATE from the PDF design templates
// (resumeTemplates.js) so the PDF path is never touched.
'use strict';

const BRAND = '#0a4f6e';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
// Escape then render simple **bold** / *italic* markdown that the AI may emit.
function rich(s) {
  let t = esc(s);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<i>$2</i>');
  return t;
}
const has = (v) => v != null && String(v).trim() !== '';
const arr = (a) => (Array.isArray(a) ? a.filter((x) => x != null && String(x).trim() !== '') : []);

function dateRange(a, b) {
  const s = has(a) ? String(a).trim() : '';
  const e = has(b) ? String(b).trim() : '';
  if (s && e) return `${s} – ${e}`;
  return s || e || '';
}

function sectionHead(title, brand) {
  return `<p style="margin:14pt 0 3pt 0;border-bottom:1.5px solid ${brand};">`
    + `<span style="font-size:11.5pt;font-weight:bold;color:${brand};letter-spacing:0.5px;text-transform:uppercase;">${esc(title)}</span></p>`;
}
function bullets(list) {
  const items = arr(list).map((h) => `<li style="margin:0 0 2pt 0;">${rich(h)}</li>`).join('');
  return items ? `<ul style="margin:3pt 0 0 0;padding-left:16pt;">${items}</ul>` : '';
}

/**
 * @param {object} resumeData  the stored resume_data JSON
 * @param {object} [opts]      { photo?: dataURI, brandColor?: string }
 * @returns {string} full Word-friendly HTML document
 */
function buildResumeDocxHtml(resumeData = {}, opts = {}) {
  const d = resumeData || {};
  const pi = d.personal_info || {};
  const brand = opts.brandColor || BRAND;

  const exp = arr(d.experience);
  const edu = arr(d.education);
  const proj = arr(d.projects);
  const tech = arr(d.skills && d.skills.technical);
  const soft = arr(d.skills && d.skills.soft);
  const certs = arr(d.certifications);
  const langs = arr(d.languages);
  const ach = arr(d.achievements);

  const name = has(pi.full_name) ? pi.full_name : 'Your Name';
  const title = has(pi.title) ? pi.title : (exp[0] && exp[0].role) || '';
  const contactBits = [pi.email, pi.phone, pi.location, pi.linkedin_url, pi.portfolio_url]
    .filter(has).map((x) => esc(x)).join('&nbsp;&nbsp;·&nbsp;&nbsp;');

  // Header — table so the photo (if any) sits to the right of the name block.
  const photoCell = opts.photo
    ? `<td style="width:104px;text-align:right;vertical-align:top;border:0;padding:0;">`
      + `<img src="${opts.photo}" width="92" height="92" alt="" /></td>`
    : '';
  const header = `<table style="width:100%;border-collapse:collapse;border:0;"><tr>`
    + `<td style="vertical-align:top;border:0;padding:0;">`
    + `<p style="margin:0;font-size:22pt;font-weight:bold;color:${brand};">${esc(name)}</p>`
    + (has(title) ? `<p style="margin:2pt 0 0 0;font-size:12pt;color:#555555;">${esc(title)}</p>` : '')
    + (contactBits ? `<p style="margin:6pt 0 0 0;font-size:9.5pt;color:#444444;">${contactBits}</p>` : '')
    + `</td>${photoCell}</tr></table>`;

  // Summary
  const summaryHtml = has(d.summary)
    ? sectionHead('Summary', brand) + `<p style="margin:3pt 0 0 0;font-size:10.5pt;line-height:1.35;">${rich(d.summary)}</p>`
    : '';

  // Experience
  const jobs = exp.map((e) => {
    const meta = [e.company, e.location].filter(has).map(esc).join(' · ');
    const dates = dateRange(e.start_date, e.end_date);
    const metaLine = (meta || dates)
      ? `<p style="margin:0;font-size:10pt;color:#555555;">`
        + (meta ? `<b>${meta}</b>` : '')
        + (meta && dates ? '&nbsp;&nbsp;|&nbsp;&nbsp;' : '')
        + (dates ? `<span style="color:#777777;">${esc(dates)}</span>` : '')
        + `</p>`
      : '';
    return `<p style="margin:9pt 0 0 0;font-size:11.5pt;font-weight:bold;color:#1a1a1a;">${esc(e.role || 'Role')}</p>`
      + metaLine + bullets(e.highlights);
  }).join('');
  const expHtml = jobs ? sectionHead('Experience', brand) + jobs : '';

  // Projects
  const projects = proj.map((p) => {
    const t = [has(p.title) ? `<b>${esc(p.title)}</b>` : '', has(p.type) ? esc(p.type) : '']
      .filter(Boolean).join(' — ');
    const desc = has(p.about || p.description) ? `<p style="margin:1pt 0 0 0;font-size:10pt;">${rich(p.about || p.description)}</p>` : '';
    return `<p style="margin:8pt 0 0 0;font-size:11pt;">${t || '<b>Project</b>'}</p>`
      + (has(p.role) ? `<p style="margin:0;font-size:9.5pt;color:#666666;">${esc(p.role)}</p>` : '')
      + desc + bullets(p.role_highlights);
  }).join('');
  const projHtml = projects ? sectionHead('Projects', brand) + projects : '';

  // Education
  const education = edu.map((e) => {
    const deg = [e.degree, e.field_of_study].filter(has).map(esc).join(' · ');
    return `<p style="margin:8pt 0 0 0;font-size:11pt;font-weight:bold;color:#1a1a1a;">${esc(deg || e.degree || 'Education')}</p>`
      + [has(e.institution) ? esc(e.institution) : '', has(e.end_date) ? esc(e.end_date) : '', has(e.grade) ? esc(e.grade) : '']
        .filter(Boolean).map((x) => `<span style="font-size:10pt;color:#555555;">${x}</span>`).join('&nbsp;&nbsp;·&nbsp;&nbsp;')
        ? `<p style="margin:0;">` + [has(e.institution) ? esc(e.institution) : '', has(e.end_date) ? esc(e.end_date) : '', has(e.grade) ? esc(e.grade) : ''].filter(Boolean).join(' · ') + `</p>`
        : '';
  }).join('');
  const eduHtml = education ? sectionHead('Education', brand) + education : '';

  // Skills
  let skillsHtml = '';
  if (tech.length || soft.length) {
    skillsHtml = sectionHead('Skills', brand);
    if (tech.length) skillsHtml += `<p style="margin:3pt 0 0 0;font-size:10.5pt;"><b>Technical:</b> ${tech.map(esc).join(', ')}</p>`;
    if (soft.length) skillsHtml += `<p style="margin:2pt 0 0 0;font-size:10.5pt;"><b>Soft:</b> ${soft.map(esc).join(', ')}</p>`;
  }

  // Certifications / Languages / Achievements
  const certHtml = certs.length ? sectionHead('Certifications', brand)
    + '<ul style="margin:3pt 0 0 0;padding-left:16pt;">' + certs.map((c) => {
      if (c && typeof c === 'object') {
        const sub = [c.issuer || c.authority, c.year || c.date].filter(has).map(esc).join(' · ');
        return `<li style="font-size:10pt;"><b>${esc(c.name || c.title || '')}</b>${sub ? ` — ${sub}` : ''}</li>`;
      }
      return `<li style="font-size:10pt;">${esc(c)}</li>`;
    }).join('') + '</ul>' : '';

  const langHtml = langs.length ? sectionHead('Languages', brand)
    + `<p style="margin:3pt 0 0 0;font-size:10.5pt;">` + langs.map((l) => {
      if (l && typeof l === 'object') {
        const lvl = l.level || l.proficiency;
        return `${esc(l.name || l.language || '')}${has(lvl) ? ` (${esc(lvl)})` : ''}`;
      }
      return esc(l);
    }).filter(Boolean).join(',&nbsp;&nbsp;') + '</p>' : '';

  const achHtml = ach.length ? sectionHead('Achievements', brand) + bullets(ach) : '';

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Resume</title></head>`
    + `<body style="font-family:Calibri,Arial,sans-serif;color:#222222;font-size:10.5pt;">`
    + header + summaryHtml + expHtml + projHtml + eduHtml + skillsHtml + certHtml + langHtml + achHtml
    + `</body></html>`;
}

module.exports = { buildResumeDocxHtml };
