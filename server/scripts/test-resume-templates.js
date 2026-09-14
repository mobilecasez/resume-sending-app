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

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE EMPLOYER'S BRAND (2026-09-15, contract 3): opts.brand = { accent, font } re-hues a design to the
// employer's colour — LUMINANCE-MATCHED, so every accent keeps its own lightness and text-on-accent stays
// readable — and puts the employer's Google font first in the stacks. No brand → byte-identical output.
// The same for every letter template (opts.brandColor / opts.brandFont) and for the Word files.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
const RT = require('../utils/resumeTemplates');
const CL = require('../utils/coverLetterTemplates');
const DX = require('../utils/docxBuilder');
const S = {
  resume: {
    personal_info: { full_name: 'Ava Torres', title: 'Product Engineer', email: 'ava@example.com', phone: '+41 79 000 00 00', location: 'Zürich, CH', linkedin_url: 'linkedin.com/in/ava', nationality: 'Swiss' },
    summary: 'Product engineer with **eight years** shipping consumer software across web and mobile.\n• Shipped 12 products to 4M users\n• Led a team of 5 engineers',
    experience: [
      { role: 'Senior Product Engineer', company: 'Acme', location: 'Zürich', start_date: '2020', end_date: 'Present', highlights: ['Cut checkout latency **40%** by moving to edge rendering', 'Led the migration of 3 services to Kubernetes', 'Mentored 4 engineers'] },
      { role: 'Software Engineer', company: 'Beta Labs', location: 'Berlin', start_date: '2016', end_date: '2020', highlights: ['Built the payments API used by 200 merchants', 'Introduced CI, cutting release time from days to hours'] },
    ],
    education: [{ degree: 'BSc Computer Science', institution: 'ETH Zürich', start_date: '2012', end_date: '2016', grade: '5.6/6' }],
    projects: [{ title: 'Ledger', type: 'Open source', about: 'A double-entry bookkeeping library.', role_highlights: ['2k GitHub stars'], link: 'https://ledger.example' }],
    skills: { technical: ['TypeScript', 'React', 'Node.js', 'PostgreSQL', 'Kubernetes', 'GraphQL'], soft: ['Leadership', 'Mentoring', 'Communication'] },
    certifications: [{ name: 'AWS Solutions Architect', issuer: 'Amazon', year: '2022' }],
    languages: [{ name: 'English', level: 'Native' }, { name: 'German', level: 'C1' }],
    achievements: ['Speaker at JSConf EU 2023'],
  },
  letter: {
    sender: { name: 'Ava Torres', title: 'Product Engineer', email: 'ava@example.com', phone: '+41 79 000 00 00', location: 'Zürich, CH' },
    company: { name: 'Nordex SE', address: 'Langenhorner Chaussee 600, Hamburg' },
    bodyHtml: '<p>I am writing to apply for the Senior Engineer role. Over eight years I have shipped <strong>twelve products</strong> to four million users.</p><p>At Acme I cut checkout latency by 40% and led a team of five. I would bring the same focus to Nordex.</p><p>Thank you for your consideration.</p>',
  },
};
const BRAND = { accent: '#e30613', font: { family: 'Montserrat', google: true } };
const IDS = ['azure', 'banner', 'germany', 'exec_pro'];
const hueOf = (hx) => RT.hexToHsl(hx).h;
const isRedHue = (h) => h >= 345 || h <= 8;
const contrast = (a, b) => { const la = RT.relLum(a), lb = RT.relLum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };

console.log('── brand: no brand → byte-identical (undefined / null / {} / junk / a non-google font alone) ──');
for (const id of [...IDS, 'azure_emerald', 'banner_crimson']) {
  const a = RT.renderResumeHtml(id, S.resume, { photo: null });
  const same = [
    RT.renderResumeHtml(id, S.resume, { photo: null, brand: undefined }),
    RT.renderResumeHtml(id, S.resume, { photo: null, brand: null }),
    RT.renderResumeHtml(id, S.resume, { photo: null, brand: {} }),
    RT.renderResumeHtml(id, S.resume, { photo: null, brand: { accent: 'red', font: 'Arial' } }),
    RT.renderResumeHtml(id, S.resume, { photo: null, brand: { accent: null, font: { family: 'Montserrat', google: false } } }),
  ].every((h) => h === a);
  ok(`${id}: identical without a brand`, same);
}

console.log('── brand: the colour is the employer\'s, the lightness stays the family\'s; the font leads the stacks ──');
const brandedHtml = {};
const SEED_ACCENTS = { azure: ['#0a7aa6', '#0e6e93', '#13567a', '#3fb9e6'], banner: ['#2563eb', '#1d4ed8', '#1e40af'], germany: ['#0f172a', '#1f2937', '#334155'], exec_pro: ['#7c6a45', '#c9a96a'] };
for (const id of IDS) {
  const tpl = TEMPLATES.find((t) => t.id === id);
  const html = RT.renderResumeHtml(id, S.resume, { photo: null, brand: BRAND });
  brandedHtml[id] = html;
  ok(`${id}: differs from unbranded`, html !== RT.renderResumeHtml(id, S.resume, { photo: null }));
  ok(`${id}: Montserrat <link> (400;600;700) before the first <style>`, html.includes('<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700&display=swap" rel="stylesheet"><style>'));
  ok(`${id}: Montserrat leads the body stack, Lato kept as the fallback`, html.includes("font-family:'Montserrat','Lato',-apple-system"));
  ok(`${id}: Montserrat leads the heading stacks, Poppins kept`, html.includes("font-family:'Montserrat','Poppins',sans-serif") && !/font-family:'Poppins'/.test(html));
  ok(`${id}: the family's seed accent is gone`, !html.toLowerCase().includes(FAMILY_ACCENT_SEED[id]));
  const { theme, accent, band } = RT.brandedTemplate(tpl, BRAND);
  ok(`${id}: theme hue is the brand's; the reported accent ${accent} is red`, isRedHue(theme.hue) && isRedHue(hueOf(accent)));
  for (const hx of SEED_ACCENTS[id]) {
    const next = RT.shiftHex(hx, theme);
    const dl = Math.abs(RT.relLum(hx) - RT.relLum(next));
    const l = RT.hexToHsl(hx).l;
    ok(`${id}: ${hx} → ${next} keeps its luminance (Δ${dl.toFixed(3)}) and is red, and is in the HTML`, (l <= 0.15 || l >= 0.8 || dl < 0.03) && isRedHue(hueOf(next)) && html.includes(next), { hx, next });
  }
  if (band) {
    ok(`${id}: the A4 band is recoloured ${band.top}/${band.bottom} and white text on it stays readable`,
      isRedHue(hueOf(band.top)) && isRedHue(hueOf(band.bottom)) && contrast('#ffffff', band.top) >= 4.5 && contrast('#ffffff', band.bottom) >= 4.5, band);
  }
}
ok('a variant brands from its FAMILY (azure_emerald + brand === azure + brand)', RT.renderResumeHtml('azure_emerald', S.resume, { photo: null, brand: BRAND }) === brandedHtml.azure);
ok('font only (no accent): a variant keeps its own palette and gets the font', (() => { const h = RT.renderResumeHtml('azure_emerald', S.resume, { photo: null, brand: { accent: null, font: BRAND.font } }); return h.includes('Montserrat') && h.includes(TEMPLATES.find((t) => t.id === 'azure_emerald').accent); })());
ok('accent only (no font): no Google link added', !RT.renderResumeHtml('azure', S.resume, { photo: null, brand: { accent: '#e30613' } }).includes('Montserrat'));
ok('a non-google font changes nothing about the type', (() => { const h = RT.renderResumeHtml('azure', S.resume, { photo: null, brand: { accent: '#e30613', font: { family: 'Helvetica Neue', google: false } } }); return !h.includes('Helvetica') && !h.includes('css2?family=H'); })());
ok('⚠️ the font family is sanitised for CSS and the URL (no injection through a website\'s font name)', (() => { const h = RT.renderResumeHtml('azure', S.resume, { photo: null, brand: { font: { family: "Open Sans'; </style><script>", google: true } } }); return h.includes("font-family:'Open Sans','Lato'") && h.includes('css2?family=Open+Sans:wght') && !h.includes('<script>'); })());
ok('elegant (Georgia stack) leads with the brand font; mono keeps its ui-monospace labels',
  RT.renderResumeHtml('elegant', S.resume, { photo: null, brand: BRAND }).includes("font-family:'Montserrat',Georgia,'Times New Roman',serif")
  && RT.renderResumeHtml('mono', S.resume, { photo: null, brand: BRAND }).includes('font-family:ui-monospace,'));
ok('a muted brand mutes a vivid family (satMul < 1); a vivid brand lifts a near-neutral one (satMul > 1)',
  RT.brandThemeOf('#6b7c93', 'azure').satMul < 0.4 && RT.brandThemeOf('#6b7c93', 'azure').satFloor < 0.2 && RT.brandThemeOf('#e30613', 'germany').satMul > 2, { muted: RT.brandThemeOf('#6b7c93', 'azure') });
ok('#rgb / no-hash accents accepted; quoted and comma-listed families read cleanly',
  RT.brandThemeOf('e30613').hue === RT.brandThemeOf('#e30613').hue && RT.normHex('#f00') === '#ff0000'
  && RT.brandFontOf({ family: "'Montserrat'", google: true }).family === 'Montserrat' && RT.brandFontOf({ family: 'Roboto, sans-serif', google: true }).family === 'Roboto');
{
  let all = 0;
  for (const t of TEMPLATES) {
    const h = RT.renderResumeHtml(t.id, S.resume, { photo: null, brand: BRAND });
    const base = TEMPLATES.find((x) => x.id === t.family);
    const b = RT.brandedTemplate(t, BRAND);
    if (h.length > 3000 && h.includes('Montserrat') && !h.toLowerCase().includes(base.accent) && isRedHue(hueOf(b.accent)) && Math.abs(RT.relLum(b.accent) - RT.relLum(base.accent)) < 0.05) all++;
  }
  ok(`all ${TEMPLATES.length} designs render branded (red accent, luminance-matched to the family's, font linked)`, all === TEMPLATES.length, all);
}

console.log('── brand: the A4 PDF band is the RECOLOURED band ──');
{
  const azure = TEMPLATES.find((t) => t.id === 'azure');
  const bb = RT.brandedTemplate('azure', BRAND).band;
  ok('brandedTemplate(azure, brand).band is red at the family band\'s luminance (±0.05), not the azure blue',
    bb && isRedHue(hueOf(bb.top)) && isRedHue(hueOf(bb.bottom)) && bb.top !== azure.band.top
    && Math.abs(RT.relLum(bb.top) - RT.relLum(azure.band.top)) < 0.05 && Math.abs(RT.relLum(bb.bottom) - RT.relLum(azure.band.bottom)) < 0.05
    && bb.side === azure.band.side && bb.widthMm === azure.band.widthMm, { was: azure.band, now: bb });
  ok('a brand with no colour hands back the template\'s own band', JSON.stringify(RT.brandedTemplate(azure, { accent: null, font: BRAND.font }).band) === JSON.stringify(azure.band));
  ok('a variant\'s branded band is its family\'s branded band', JSON.stringify(RT.brandedTemplate('azure_emerald', BRAND).band) === JSON.stringify(bb));
  // The compositor reads THAT band: resumeRenderer's a4 path takes brandedTemplate(tpl, opts.brand).band when a brand is set.
  const rr = require('fs').readFileSync(require('path').join(__dirname, '../utils/resumeRenderer.js'), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  ok('⚠️ resumeRenderer composites the branded band and passes opts.brand through renderPdf / renderPreviews',
    /opts\.brand \? brandedTemplate\(tpl, opts\.brand\)\.band : tpl\.band/.test(rr) && (rr.match(/opts\.brand/g) || []).length >= 3, (rr.match(/opts\.brand/g) || []).length);
}

console.log('── brand: EVERY letter template re-hues to brandColor; brandFont leads ──');
{
  const L_BRAND = { photo: null, brandColor: '#e30613', brandFont: BRAND.font };
  for (const t of CL.TEMPLATES) {
    const html = CL.renderCoverLetterHtml(t.id, S.letter, L_BRAND);
    const plainHtml = CL.renderCoverLetterHtml(t.id, S.letter, { photo: null });
    ok(`${t.id}: differs from unbranded; Montserrat linked and leading Lato`, html !== plainHtml && html.includes('css2?family=Montserrat:wght@400;600;700') && html.includes("font-family:'Montserrat','Lato',"));
    ok(`${t.id}: every registry accent re-hued away, the reported accent red`, (CL.LETTER_ACCENTS[t.id] || []).every((hx) => !html.includes(hx)) && isRedHue(hueOf(CL.brandedLetterAccent(t, '#e30613'))), CL.brandedLetterAccent(t, '#e30613'));
    ok(`${t.id}: unbranded twice is byte-identical`, plainHtml === CL.renderCoverLetterHtml(t.id, S.letter, { photo: null, brandColor: null, brandFont: null }));
    if (t.id === 'exec_leader') ok('exec_leader: the Merriweather stack led by Montserrat', html.includes("font-family:'Montserrat','Merriweather',Georgia,serif"));
    if (t.id === 'standard') ok('standard: the raw brand still paints the label bars', html.includes('background:#e30613'));
  }
  ok('no brand → the registry accent unchanged', CL.brandedLetterAccent(CL.TEMPLATES[1], undefined) === CL.TEMPLATES[1].accent);
}

console.log('── brand: the Word files take the accent and (a Google) font ──');
(async () => {
  let JSZip = null;
  try { JSZip = require('jszip'); } catch { try { JSZip = require(require.resolve('jszip', { paths: [require('path').dirname(require.resolve('docx'))] })); } catch { /* reported below */ } }
  if (!JSZip) ok('jszip is resolvable (docx\'s own zip engine)', false);
  else {
    const docXml = async (buf) => { const z = await JSZip.loadAsync(buf); return { doc: await z.file('word/document.xml').async('string'), styles: await z.file('word/styles.xml').async('string') }; };
    // ⚠️ RETARGETED (2026-09-15): the Word file paints the HTML's DERIVED accent, never the raw brand hex. A raw #f6d365
    // (pastel yellow, relLum 0.67) landed as heading ink on white paper and a raw #fafafa as invisible ink, while the
    // PDF of the same document re-hued the FAMILY accent to the brand's hue at the accent's own luminance
    // (brandedTemplate / brandedLetterAccent). The docx now derives through the same two functions, so the pins
    // below read the expected hex FROM them (a pin on the raw E30613 was the defect) — and pin the derivation
    // itself once, so a drift in brandedTemplate is caught here and not blamed on the Word builder.
    const HX = (h) => String(h).replace('#', '').toUpperCase();
    const azBrand = HX(RT.brandedTemplate('azure', { accent: '#e30613' }).accent);
    const deBrand = HX(RT.brandedTemplate('germany', { accent: '#e30613' }).accent);
    const atsLetter = HX(CL.brandedLetterAccent(CL.TEMPLATES.find((t) => t.id === 'ats_pro'), '#e30613'));
    const deLetter = HX(CL.brandedLetterAccent(CL.TEMPLATES.find((t) => t.id === 'german'), '#e30613'));
    ok('the derivation the docx follows (pinned once): azure → E20613, germany → 84040B, ats_pro letter → 540207, german letter → 84040B — none the raw E30613',
      azBrand === 'E20613' && deBrand === '84040B' && atsLetter === '540207' && deLetter === '84040B', { azBrand, deBrand, atsLetter, deLetter });
    const p = await docXml(await DX.buildResumeDocx(S.resume, { template: 'azure' }));
    const b = await docXml(await DX.buildResumeDocx(S.resume, { template: 'azure', brand: BRAND }));
    ok('unbranded azure docx: azure blue fill, Calibri, no Montserrat', p.doc.includes('w:fill="0A7AA6"') && p.doc.includes('"Calibri"') && !p.doc.includes('Montserrat'));
    ok(`branded azure docx: the fill is azure's accent re-hued to the brand (${azBrand}), never the raw E30613, no azure blue left`,
      b.doc.includes(`w:fill="${azBrand}"`) && !b.doc.includes('E30613') && !b.doc.includes('0A7AA6'));
    ok('branded azure docx: Montserrat in document.xml + styles.xml, no Calibri left in any rFonts', b.doc.includes('"Montserrat"') && b.styles.includes('"Montserrat"') && !/<w:rFonts[^>]*Calibri/.test(b.doc) && !/<w:rFonts[^>]*Calibri/.test(b.styles));
    const nonGoogle = await docXml(await DX.buildResumeDocx(S.resume, { template: 'azure', brand: { accent: '#e30613', font: { family: 'Helvetica Neue', google: false } } }));
    ok('a non-google brand font: the derived accent applied, the document font left as Calibri', nonGoogle.doc.includes(`w:fill="${azBrand}"`) && !nonGoogle.doc.includes('E30613') && nonGoogle.doc.includes('"Calibri"') && !nonGoogle.doc.includes('Helvetica'));
    const germanyBrand = await docXml(await DX.buildResumeDocx(S.resume, { template: 'germany', brand: BRAND }));
    ok(`branded germany docx: headings in germany's slate re-hued to the brand (${deBrand}) + Montserrat, no raw hex`, germanyBrand.doc.includes(`w:color="${deBrand}"`) && !germanyBrand.doc.includes('E30613') && germanyBrand.doc.includes('"Montserrat"'));
    const clPlain = await docXml(await DX.buildCoverLetterDocx(S.letter, { template: 'ats_pro', photo: null }));
    const clBrand = await docXml(await DX.buildCoverLetterDocx(S.letter, { template: 'ats_pro', photo: null, brand: BRAND }));
    const clPair = await docXml(await DX.buildCoverLetterDocx(S.letter, { template: 'ats_pro', photo: null, brandColor: '#e30613', brandFont: BRAND.font }));
    ok('ats_pro letter docx unbranded: dark rule, Calibri, no red', clPlain.doc.includes('w:color="111827"') && !clPlain.doc.includes('E30613') && clPlain.doc.includes('"Calibri"'));
    ok(`ats_pro letter docx branded (opts.brand, and the brandColor/brandFont pair alike): the rule in the ink-dark on-hue ${atsLetter} + Montserrat, no raw hex`,
      clBrand.doc.includes(`w:color="${atsLetter}"`) && !clBrand.doc.includes('E30613') && clBrand.doc.includes('"Montserrat"') && clPair.doc.includes(`w:color="${atsLetter}"`) && !clPair.doc.includes('E30613') && clPair.doc.includes('"Montserrat"'));
    const gPlain = await docXml(await DX.buildCoverLetterDocx(S.letter, { template: 'german', photo: null }));
    const gBrand = await docXml(await DX.buildCoverLetterDocx(S.letter, { template: 'german', photo: null, brand: BRAND }));
    ok(`german letter docx: slate rule unbranded, the re-hued ${deLetter} rule branded (no raw hex, no slate left)`, gPlain.doc.includes('w:color="94A3B8"') && !gPlain.doc.includes('E30613') && gBrand.doc.includes(`w:color="${deLetter}"`) && !gBrand.doc.includes('E30613') && !gBrand.doc.includes('94A3B8'));

    console.log('── ⚠️ brand: a PASTEL or NEAR-WHITE brand keeps the family accent\'s luminance in Word too (2026-09-15) ──');
    // The defect this guards: a brand the website read as #f6d365 (pastel yellow) or #fafafa (near-white) went into
    // the docx RAW as heading ink and rules on white paper — unreadable — while the PDF re-hued the family's accent
    // at that accent's own luminance. Every family with a Word layout, a variant (brands from its FAMILY), and a
    // family with no Word layout (Azure stands in — Azure's accent re-hued, never the raw hex) are read below.
    const inks = (xml) => [...xml.matchAll(/<w:color w:val="([0-9A-Fa-f]{6})"/g)].map((m) => m[1].toUpperCase());
    const anyHex = (xml) => [...xml.matchAll(/w:(?:color|fill|val)="([0-9A-Fa-f]{6})"/g)].map((m) => m[1].toUpperCase());
    const lum = (h) => RT.relLum('#' + HX(h).toLowerCase());
    const PASTEL = '#f6d365', NEAR_WHITE = '#fafafa';
    ok(`the two brands are the hazard they stand for: relLum ${lum(PASTEL).toFixed(2)} (pastel) and ${lum(NEAR_WHITE).toFixed(2)} (near-white), both far above any family accent`,
      lum(PASTEL) > 0.6 && lum(NEAR_WHITE) > 0.9 && FAMILIES.every((f) => lum(f.accent) < 0.5));
    const WORD_FAMILIES = ['azure', 'executive', 'minimal', 'ats', 'exec_pro', 'india', 'germany', 'europass', 'startup'];
    ok('the families with a Word layout are all real registry families', WORD_FAMILIES.every((id) => FAMILIES.some((f) => f.id === id)));
    for (const id of WORD_FAMILIES) {
      const fam = TEMPLATES.find((t) => t.id === id);
      const want = HX(RT.brandedTemplate(fam, { accent: PASTEL }).accent);
      const xml = (await docXml(await DX.buildResumeDocx(S.resume, { template: id, brand: { accent: PASTEL } }))).doc;
      const l = lum(want), lf = lum(fam.accent);
      ok(`${id} + pastel: the docx paints the HTML's ${want} (relLum ${l.toFixed(3)} vs the family's ${lf.toFixed(3)}, within ±0.06), F6D365 nowhere in it`,
        xml.includes(want) && !xml.includes('F6D365') && Math.abs(l - lf) <= 0.06 && l < lum(PASTEL) - 0.2, { want, l, lf, raw: xml.includes('F6D365') });
      const wx = (await docXml(await DX.buildResumeDocx(S.resume, { template: id, brand: { accent: NEAR_WHITE } }))).doc;
      const wantW = HX(RT.brandedTemplate(fam, { accent: NEAR_WHITE }).accent);
      ok(`${id} + near-white: never FAFAFA as ink, fill or border; the derived ${wantW} (relLum ${lum(wantW).toFixed(3)}) reads on paper`,
        !anyHex(wx).includes('FAFAFA') && !inks(wx).includes('FAFAFA') && !wx.includes('FAFAFA') && wx.includes(wantW) && lum(wantW) < 0.45, { wantW, l: lum(wantW) });
    }
    const variant = TEMPLATES.find((t) => t.family === 'azure' && t.id !== 'azure');
    const azPastel = HX(RT.brandedTemplate('azure', { accent: PASTEL }).accent);
    if (variant) {
      const vx = (await docXml(await DX.buildResumeDocx(S.resume, { template: variant.id, brand: { accent: PASTEL } }))).doc;
      const wantV = HX(RT.brandedTemplate(variant, { accent: PASTEL }).accent);
      ok(`a variant (${variant.id}) brands from its FAMILY: the docx paints ${wantV} = azure's re-hued ${azPastel}, no raw hex`, wantV === azPastel && vx.includes(wantV) && !vx.includes('F6D365'), { wantV, azPastel });
    } else ok('an azure variant exists to read', false);
    const noLayout = TEMPLATES.find((t) => (!t.family || t.family === t.id) && !WORD_FAMILIES.includes(t.id));
    if (noLayout) {
      const nx = (await docXml(await DX.buildResumeDocx(S.resume, { template: noLayout.id, brand: { accent: PASTEL } }))).doc;
      ok(`${noLayout.id} (no Word layout → Azure stands in): Azure's re-hued ${azPastel}, never the raw hex`, nx.includes(azPastel) && !nx.includes('F6D365'));
    } else ok('a family without a Word layout exists to read', false);
    // Letters: each style's registry accent re-hued against itself; the generic 'standard' alone keeps the raw colour,
    // and paints it ONLY as the label bars on its dark sidebar (a border under textOn ink) — never as run ink.
    for (const t of CL.TEMPLATES) {
      for (const brand of [PASTEL, NEAR_WHITE]) {
        const raw = HX(brand);
        const want = HX(CL.brandedLetterAccent(t, brand));
        const xml = (await docXml(await DX.buildCoverLetterDocx(S.letter, { template: t.id, photo: null, brand: { accent: brand } }))).doc;
        if (t.generic) {
          ok(`${t.id} + ${brand}: the generic style keeps the raw colour (${want}) as a sidebar bar only — never run ink`,
            want === raw && xml.includes(raw) && !inks(xml).includes(raw), { want, inks: inks(xml).filter((h) => h === raw).length });
        } else {
          const rule = ['ats_pro', 'german'].includes(t.id);
          ok(`${t.id} + ${brand}: the docx paints ${want} (relLum ${lum(want).toFixed(3)} vs the style's ${lum(t.accent).toFixed(3)}, within ±0.06), raw absent${rule ? ', the rule in it' : ''}`,
            xml.includes(want) && !xml.includes(raw) && Math.abs(lum(want) - lum(t.accent)) <= 0.06 && (!rule || xml.includes(`w:color="${want}"`)), { want, raw: xml.includes(raw) });
        }
      }
    }
    ok('a brand never changes an UNBRANDED file: azure 0A7AA6 and the ats_pro 111827 rule as before', p.doc.includes('w:fill="0A7AA6"') && clPlain.doc.includes('w:color="111827"'));
    const dxC = require('fs').readFileSync(require('path').join(__dirname, '../utils/docxBuilder.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    ok('⚠️ docxBuilder derives through the renderers (RT.brandedTemplate / CLT.brandedLetterAccent) and guards each derivation with the registry accent',
      /RT\.brandedTemplate\(ref, \{ accent: brand\.accent \}\)\.accent/.test(dxC) && /CLT\.brandedLetterAccent\(tpl, brand\.accent\)/.test(dxC)
      && /brandedResumeAccent\(ref, brand, /.test(dxC) && /brandedLetterAccent\(clEntry\(tplId\), brand, clAccent\(tplId\)\)/.test(dxC)
      && !/accent: brand\.accent\b(?!\s*\})/.test(dxC.replace(/RT\.brandedTemplate\(ref, \{ accent: brand\.accent \}\)/g, '')));
  }
  console.log(`\nresume templates: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(2); });
