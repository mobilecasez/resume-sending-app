// Word (.docx) builder — thin dispatcher. Each resume template and the cover
// letter have a bespoke, PDF-matching layout in ./docxLayouts/*. We pick the
// layout for the selected template, look up its accent from the PDF template
// registry (so colours stay in sync), and pack it to a Buffer. A layout error
// never breaks the download — we fall back to the safe Azure layout.
//
// Employer brand (opts.brand = { accent, font } — a Home employer document's design.brand; the letter
// lane may still send the older opts.brandColor / opts.brandFont pair): the brand colour SETS the layout
// accent — every layout derives its fills, rules and heading inks from the accent it is handed, and
// textOn() picks the readable ink for text on it — and a verified Google font becomes the document font
// (Word substitutes when the machine lacks the family, the same thing it does for any file from another
// computer).
// ⚠️ The accent handed to a layout is NEVER the raw brand hex. The layouts paint the accent as TEXT on
// white (Europass section titles, Startup's name, exec_pro's title, Azure's dates and bullets, the ATS /
// German letter rules) and textOn() only guards text ON an accent fill — so a pastel brand (#f6d365 on
// white is ~1.4:1) went out as unreadable heading ink, and the Word file stopped matching the PDF. The
// PDF never paints the raw colour: resumeTemplates.brandedTemplate re-hues the FAMILY's accent to the
// brand's hue at the accent's OWN luminance, and coverLetterTemplates.brandedLetterAccent does the same
// against each letter style's registry accent (the generic style excepted — it paints the raw colour on
// its label bars, under textOn ink, in HTML and here alike). The Word file takes exactly those.
'use strict';

const H = require('./docxHelpers');

let RT = null, CLT = null, RES_TPL = [], CL_TPL = [];
try { RT = require('./resumeTemplates'); RES_TPL = RT.TEMPLATES || []; } catch (e) { /* keep defaults */ }
try { CLT = require('./coverLetterTemplates'); CL_TPL = CLT.TEMPLATES || []; } catch (e) { /* keep defaults */ }
const resEntry = (id) => RES_TPL.find((t) => t.id === id) || null;
const resAccent = (id) => H.hex((resEntry(id) || {}).accent || '#0A7AA6');
const clEntry = (id) => CL_TPL.find((t) => t.id === id) || null;
const clAccent = (id) => H.hex((clEntry(id) || {}).accent || '#3A6CB5');

const RESUME_LAYOUTS = {
  azure: require('./docxLayouts/resume/azure'),
  executive: require('./docxLayouts/resume/executive'),
  minimal: require('./docxLayouts/resume/minimal'),
  ats: require('./docxLayouts/resume/ats'),
  exec_pro: require('./docxLayouts/resume/exec_pro'),
  india: require('./docxLayouts/resume/india'),
  germany: require('./docxLayouts/resume/germany'),
  europass: require('./docxLayouts/resume/europass'),
  startup: require('./docxLayouts/resume/startup'),
};
const CL_LAYOUTS = {
  standard: require('./docxLayouts/cl/standard'),
  ats_pro: require('./docxLayouts/cl/ats_pro'),
  exec_leader: require('./docxLayouts/cl/exec_leader'),
  technical: require('./docxLayouts/cl/technical'),
  german: require('./docxLayouts/cl/german'),
  euro_motivation: require('./docxLayouts/cl/euro_motivation'),
  graduate: require('./docxLayouts/cl/graduate'),
};

// ── The employer brand, as the builders read it ──────────────────────────────
const HEX_RE = /^#?[0-9a-f]{6}$/i;
const brandHex = (v) => (typeof v === 'string' && HEX_RE.test(v.trim()) ? H.hex(v.trim()) : null);
// { family, google } | null — the same reading resumeTemplates makes: surrounding quotes dropped, then
// cut at the first character that is not a letter, digit, space or hyphen (the name lands inside XML
// attributes), ≤60 chars.
function brandFontOf(v) {
  if (!v || typeof v !== 'object') return null;
  const family = String(v.family == null ? '' : v.family).replace(/^['"\s]+|['"\s]+$/g, '').split(/[^A-Za-z0-9 \-]/)[0].replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!family || !/[A-Za-z]/.test(family)) return null;
  return { family, google: v.google === true };
}
function brandOf(opts) {
  const b = opts && opts.brand && typeof opts.brand === 'object' ? opts.brand : {};
  const accent = brandHex(b.accent) || brandHex(opts && opts.brandColor);
  const font = brandFontOf(b.font) || brandFontOf(opts && opts.brandFont);
  return accent || font ? { accent, font } : null;
}
// The accent a resume layout paints for a brand: the HTML's own derivation — brandedTemplate re-hues
// the reference template's FAMILY accent to the brand's hue at that accent's luminance (a variant brands
// from its family, exactly as the PDF). `ref` is the registry entry the layout is drawing, or the id of
// the fallback layout when the picked family has no Word layout (then Azure's accent is what gets
// re-hued — the Azure layout is what the reader sees). Without the renderer (the try-require above) the
// layout keeps its registry accent: an unbranded Word file beats an unreadable one.
function brandedResumeAccent(ref, brand, fallback) {
  if (!brand || !brand.accent || !RT || typeof RT.brandedTemplate !== 'function') return fallback;
  try {
    const hx = brandHex(RT.brandedTemplate(ref, { accent: brand.accent }).accent);
    return hx || fallback;
  } catch (e) { console.warn('[docx] brand accent not derived -', e && e.message); return fallback; }
}
// The letter twin: brandedLetterAccent re-hues the style's registry accent against itself (the ATS
// ink-dark rule and the Executive gold both land on the brand's hue at their own darkness); the generic
// style alone gets the raw colour, as its HTML does.
function brandedLetterAccent(tpl, brand, fallback) {
  if (!brand || !brand.accent || !tpl || !CLT || typeof CLT.brandedLetterAccent !== 'function') return fallback;
  try {
    const hx = brandHex(CLT.brandedLetterAccent(tpl, brand.accent));
    return hx || fallback;
  } catch (e) { console.warn('[docx] brand letter accent not derived -', e && e.message); return fallback; }
}

// ── The document font ────────────────────────────────────────────────────────
// Every run the layouts emit names Calibri outright (docxHelpers' FONT — a TextRun's own font beats
// the document default), so the brand font cannot be set through a style: the packed file is opened
// and the font attributes rewritten in word/document.xml and word/styles.xml. jszip is the zip engine
// `docx` itself packs with — resolved from docx's own tree, so no dependency is added. Any failure
// returns the buffer as packed: a Word file in Calibri beats no Word file.
let JSZipMod = null;
function jszip() {
  if (JSZipMod) return JSZipMod;
  try { JSZipMod = require('jszip'); }
  catch {
    const path = require('path');
    JSZipMod = require(require.resolve('jszip', { paths: [path.dirname(require.resolve('docx'))] }));
  }
  return JSZipMod;
}
const xmlAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
async function withDocumentFont(buffer, family) {
  try {
    const zip = await jszip().loadAsync(buffer);
    const fam = xmlAttr(family);
    // Only the <w:rFonts …> tags, and only the Calibri values in them — nothing else in the XML moves.
    const refont = (xml) => xml.replace(/<w:rFonts\b[^>]*>/g, (tag) => tag.replace(/="Calibri"/g, `="${fam}"`));
    let changed = false;
    for (const part of ['word/document.xml', 'word/styles.xml']) {
      const f = zip.file(part);
      if (!f) continue;
      const xml = await f.async('string');
      const next = refont(xml);
      if (next !== xml) { zip.file(part, next); changed = true; }
    }
    if (!changed) return buffer;
    return await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  } catch (e) {
    console.warn('[docx] brand font not applied -', e && e.message);
    return buffer;
  }
}
const withBrandFont = (buf, brand) => (brand && brand.font && brand.font.google ? withDocumentFont(buf, brand.font.family) : buf);

async function buildResumeDocx(resumeData = {}, opts = {}) {
  const d = resumeData || {};
  // A variant id (azure_emerald, banner_crimson…) has no layout of its own: it renders in its FAMILY's
  // layout with its own accent — the rule the PDF registry follows. A family without a Word layout
  // still falls back to Azure, in Azure's colours, as before.
  const entry = resEntry(opts.template);
  const layoutId = RESUME_LAYOUTS[opts.template] ? opts.template : (entry && RESUME_LAYOUTS[entry.family] ? entry.family : null);
  const tplId = layoutId || 'azure';
  const brand = brandOf(opts);
  // The brand re-hues whichever accent the layout would otherwise paint — the picked entry's, or Azure's
  // when Azure is standing in for a family without a Word layout — never the raw brand hex (see top).
  const ref = layoutId && entry ? entry : tplId;
  const accent = brandedResumeAccent(ref, brand, layoutId && entry ? H.hex(entry.accent) : resAccent(tplId));
  const photoOpts = { photo: opts.photo || null, photoRect: opts.photoRect || null };
  let buf;
  try {
    buf = await H.pack(RESUME_LAYOUTS[tplId](d, photoOpts, accent));
  } catch (e) {
    console.error('[docx] resume layout error for', tplId, '-', e.message);
    buf = await H.pack(RESUME_LAYOUTS.azure(d, photoOpts, resAccent('azure')));
  }
  return withBrandFont(buf, brand);
}

async function buildCoverLetterDocx(data = {}, opts = {}) {
  const dd = data || {};
  const tplId = CL_LAYOUTS[opts.template] ? opts.template : 'standard';
  const brand = brandOf(opts);
  // `branded` tells the ATS / German layouts to paint their ink-coloured rule in the accent too — which
  // they never do for a template accent, so an unbranded letter is exactly what it was. That accent is
  // the style's own, re-hued to the brand (brandedLetterAccent — what the PDF paints), never the raw hex.
  const clOpts = { accent: brandedLetterAccent(clEntry(tplId), brand, clAccent(tplId)), photo: opts.photo || null, ...(brand && brand.accent ? { branded: true } : {}) };
  let buf;
  try {
    buf = await H.pack(CL_LAYOUTS[tplId](dd, clOpts));
  } catch (e) {
    console.error('[docx] cover-letter layout error for', tplId, '-', e.message);
    buf = await H.pack(CL_LAYOUTS.standard(dd, { accent: clAccent('standard'), photo: opts.photo || null }));
  }
  return withBrandFont(buf, brand);
}

module.exports = { buildResumeDocx, buildCoverLetterDocx };
