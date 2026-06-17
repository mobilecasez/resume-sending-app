// Word (.docx) builder — thin dispatcher. Each resume template and the cover
// letter have a bespoke, PDF-matching layout in ./docxLayouts/*. We pick the
// layout for the selected template, look up its accent from the PDF template
// registry (so colours stay in sync), and pack it to a Buffer. A layout error
// never breaks the download — we fall back to the safe Azure layout.
'use strict';

const H = require('./docxHelpers');

let RES_TPL = [], CL_TPL = [];
try { RES_TPL = require('./resumeTemplates').TEMPLATES || []; } catch (e) { /* keep defaults */ }
try { CL_TPL = require('./coverLetterTemplates').TEMPLATES || []; } catch (e) { /* keep defaults */ }
const resAccent = (id) => H.hex((RES_TPL.find((t) => t.id === id) || {}).accent || '#0A7AA6');
const clAccent = (id) => H.hex((CL_TPL.find((t) => t.id === id) || {}).accent || '#3A6CB5');

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

async function buildResumeDocx(resumeData = {}, opts = {}) {
  const d = resumeData || {};
  const tplId = RESUME_LAYOUTS[opts.template] ? opts.template : 'azure';
  const photoOpts = { photo: opts.photo || null, photoRect: opts.photoRect || null };
  try {
    return await H.pack(RESUME_LAYOUTS[tplId](d, photoOpts, resAccent(tplId)));
  } catch (e) {
    console.error('[docx] resume layout error for', tplId, '-', e.message);
    return H.pack(RESUME_LAYOUTS.azure(d, photoOpts, resAccent('azure')));
  }
}

async function buildCoverLetterDocx(data = {}, opts = {}) {
  const dd = data || {};
  const tplId = CL_LAYOUTS[opts.template] ? opts.template : 'standard';
  const clOpts = { accent: clAccent(tplId), photo: opts.photo || null };
  try {
    return await H.pack(CL_LAYOUTS[tplId](dd, clOpts));
  } catch (e) {
    console.error('[docx] cover-letter layout error for', tplId, '-', e.message);
    return H.pack(CL_LAYOUTS.standard(dd, { accent: clAccent('standard'), photo: opts.photo || null }));
  }
}

module.exports = { buildResumeDocx, buildCoverLetterDocx };
