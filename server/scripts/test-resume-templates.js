// Resume Builder — template registry + recoloring. Runs without a DB (resumeTemplates is pure).
//   node server/scripts/test-resume-templates.js
'use strict';
const { TEMPLATES, TEMPLATE_IDS, FAMILIES, REGIONS, renderResumeHtml } = require('../utils/resumeTemplates');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; } else { fail++; console.log('  ✗ ' + n + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); } };

const SAMPLE = {
  personal_info: { full_name: 'Ava Torres', email: 'ava@x.com', phone: '+41 79 000 00 00', location: 'Zürich, CH', linkedin_url: 'linkedin.com/in/ava' },
  professional_title: 'Product Engineer',
  summary: 'Builder of **useful** things.\n• Shipped 12 products\n• Led a team of 5',
  experience: [{ title: 'Engineer', company: 'Acme', location: 'Zürich', start_date: '2020', end_date: 'Present', bullets: ['Did **things** well', 'Cut costs 30%'] }],
  education: [{ degree: 'BSc CS', school: 'ETH', start_date: '2016', end_date: '2020' }],
  projects: [{ name: 'Tool', description: 'A tool.', url: 'https://t.example' }],
  skills: { technical: ['JS', 'SQL', 'React'], soft: ['Leadership'] },
  certifications: [{ name: 'Cert', issuer: 'Org', year: '2022' }],
  languages: [{ language: 'English', proficiency: 'Native' }],
};

console.log('── registry shape ──');
ok('at least 70 designs (37 + the six-family expansion)', TEMPLATES.length >= 70, TEMPLATES.length);
ok('15 layout families', FAMILIES.length === 15, FAMILIES.length);
ok('every family lists itself as its first variant', FAMILIES.every((f) => f.variants[0] && f.variants[0].id === f.id));
ok('ids are unique', new Set(TEMPLATE_IDS).size === TEMPLATE_IDS.length);
ok('every variant resolves in the registry', FAMILIES.every((f) => f.variants.every((v) => TEMPLATES.some((t) => t.id === v.id))));
// Regions are level ONE of the gallery now: each names its layout FAMILIES (base ids only —
// variants expand client-side). Old app builds render a region's whole list in one request,
// so the lists stay capped at 4.
ok('every region lists ≤4 families (old-client one-request cap)', REGIONS.every((r) => r.templates.length <= 4));
ok('region lists never name a variant id', REGIONS.every((r) => r.templates.every((id) => !TEMPLATES.some((t) => t.id === id && t.family !== t.id))));
ok('every LIVE family is reachable from some region', FAMILIES.every((f) => REGIONS.some((r) => r.templates.includes(f.id))));
ok('base ids unchanged (saved template ids in the field must keep resolving)',
  ['azure', 'executive', 'minimal', 'ats', 'exec_pro', 'india', 'germany', 'europass', 'startup'].every((id) => TEMPLATES.some((t) => t.id === id)));

console.log('── every design renders ──');
const FAMILY_ACCENT_SEED = { azure: '#0a7aa6', executive: '#e0a64b', minimal: '#0e9f8e', ats: '#1f2937', exec_pro: '#7c6a45', india: '#0e7490', germany: '#334155', europass: '#2557a7', startup: '#5b5bd6', banner: '#1d4ed8', rightrail: '#0f766e', mono: '#16a34a', elegant: '#7f1d1d', compact: '#4338ca', timeline: '#ea580c' };
for (const t of TEMPLATES) {
  let html = '';
  try { html = renderResumeHtml(t.id, SAMPLE, { photo: null }); } catch (e) { ok(`${t.id} renders`, false, e.message); continue; }
  ok(`${t.id} renders non-trivially`, html.length > 3000, html.length);
  // The generic family renders the name split ("Ava <span>Torres</span>"), so test the parts.
  ok(`${t.id} contains the name`, html.includes('Ava') && html.includes('Torres'));
  ok(`${t.id} escapes cleanly (no literal ** left)`, !/\*\*/.test(html));
  if (t.family && t.family !== t.id) {
    // A recolored variant must not leak its family's seed accent…
    const seed = FAMILY_ACCENT_SEED[t.family];
    ok(`${t.id} recolors (no ${seed} left)`, !html.toLowerCase().includes(seed), t.id);
    // …and must actually contain its OWN accent.
    ok(`${t.id} carries its own accent ${t.accent}`, html.toLowerCase().includes(t.accent.toLowerCase()));
  }
}

console.log('── recolored bands (a4 sidebar compositing) ──');
for (const t of TEMPLATES.filter((x) => x.band)) {
  ok(`${t.id} band hexes are valid`, /^#[0-9a-f]{6}$/i.test(t.band.top) && /^#[0-9a-f]{6}$/i.test(t.band.bottom), t.band);
  if (t.family !== t.id && t.family === 'azure') {
    ok(`${t.id} band is NOT the azure blue`, t.band.top.toLowerCase() !== '#0a7aa6', t.band.top);
  }
}

console.log('── contrast survives recoloring (luminance-matched re-hue) ──');
// shiftHex matches RELATIVE LUMINANCE for mid-range accents, so a variant's accent reads exactly
// as bright as the original — which is what keeps heading-on-paper and text-on-band contrast.
const lum = (h) => { const c = (i) => { const v = parseInt(h.slice(i, i + 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * c(1) + 0.7152 * c(3) + 0.0722 * c(5); };
for (const f of FAMILIES) {
  for (const v of f.variants.slice(1)) {
    const base = TEMPLATES.find((t) => t.id === f.id), vt = TEMPLATES.find((t) => t.id === v.id);
    ok(`${v.id} accent luminance matches its family's`, Math.abs(lum(base.accent) - lum(vt.accent)) < 0.05, { base: base.accent, v: vt.accent, dl: +(lum(base.accent) - lum(vt.accent)).toFixed(3) });
  }
}

console.log(`\nresume templates: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
