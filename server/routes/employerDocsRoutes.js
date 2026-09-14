// The tailored resume / cover letter Home shows for each employer chip — read, list and hand-edit.
// Mounted at /api/employer-docs (server.js). Storage is services/employerDocs.js (Migrations 045/046).
//
// ⚠️ THIS FILE NEVER GENERATES AND NEVER CHARGES. Every route here reads or edits a document that was
// already paid for. Building one is POST /api/resume-builder/generate-ai (saveTo 'employer_doc') or
// POST /api/cover-letter/employer-build — behind their gates. A lookup that "helpfully" started a
// build when nothing was stored would be the letters auto-regen drain again: money spent because a
// screen was opened. `stale` below is only a LABEL the client shows next to an explicit Refresh.
//
// ⚠️ OWNERSHIP IS IN THE SQL. Every read and write scopes by req.user.id AND the store environment
// (downloads.envOf(req), via employerDocs) — ids come from the client, and a document fetched by id
// and checked in JS afterwards is one forgotten `if` away from serving another user's resume.
'use strict';

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const docs = require('../services/employerDocs');

const KINDS = new Set(['resume', 'cover_letter']);
const kindOf = (v) => (KINDS.has(v) ? v : null);

/** A cover letter's HTML is a page of text; 60 KB is generous and keeps a pasted blob out. */
const MAX_LETTER_HTML_BYTES = 60 * 1024;

/**
 * The stale label waits at most this long for the fingerprint (it reads the base narrative and the
 * parsed upload). ⚠️ This runs on every chip switch — a slow read must cost the label, not the
 * document: past the cap the answer is stale:false and the document is shown anyway.
 */
const STALE_TIMEOUT_MS = 8000;

/** Only strings reach the fingerprint; anything else is "absent" (generationFingerprint treats both as ''). */
const strOrUndef = (v) => (typeof v === 'string' ? v : undefined);
const strOrNull = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

const iso = (v) => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** Resolve after `ms` with undefined — never rejects, never keeps the process alive. */
function withTimeout(p, ms) {
  let t;
  const timer = new Promise((resolve) => { t = setTimeout(resolve, ms); if (t.unref) t.unref(); });
  return Promise.race([Promise.resolve(p), timer]).finally(() => clearTimeout(t));
}

/**
 * Has the user's material moved since this document was built?
 *
 * ⚠️ THE SAME FINGERPRINT THE BUILD AND THE GATE COMPUTE. The controllers own it; they are required
 * lazily so a controller that fails to load (or has not shipped its export yet) costs only the label.
 * A second implementation here would drift and the pill would either nag on every document or never
 * appear. Anything but a real string answer — a throw, a timeout, null (base unreadable) — is stale:false.
 *
 * ⚠️ THE JOB IS THE ONE THE DOCUMENT WAS BUILT FOR, when the row stored it (job_input, Migration 046).
 * The question this label answers is "has the user's MATERIAL moved?" — re-hashing it against whatever
 * listing the phone happens to hold today made a document read stale FOR EVER once the phone's evicting
 * listing cache dropped the posting (different job fields, a fingerprint that can never match again).
 * Only a row written before job_input existed falls back to the fields the client sends (docLookupOf):
 * the posting link when the chip has one (postingUrl — an employer-level doc may be written against a
 * pasted posting), else the identity jobUrl — exactly what the build hashed as job.url.
 * The company is not hashed by either lane; it rides along for the contract only.
 */
async function staleFor(userId, kind, doc, b, req) {
  if (!doc || !doc.input_fingerprint) return false;
  const ji = doc.job_input && typeof doc.job_input === 'object' ? doc.job_input : null;
  const job = ji
    ? {
      company: strOrUndef(b.employer),
      title: ji.title, url: ji.url, description: ji.description, website: ji.website,
    }
    : {
      company: strOrUndef(b.employer),
      title: strOrUndef(b.jobTitle),
      // `postingUrl || jobUrl`, the same truthiness the phone's build body uses — never trimmed here.
      url: strOrUndef(b.postingUrl) || strOrUndef(b.jobUrl),
      description: strOrUndef(b.jobText),
      website: strOrUndef(b.website),
    };
  try {
    let fp;
    if (kind === 'resume') {
      const fn = require('../controllers/resumeBuilderController').currentResumeFingerprint;
      if (typeof fn !== 'function') return false;
      fp = await withTimeout(fn(userId, { job, env: req }), STALE_TIMEOUT_MS);
    } else {
      const fn = require('../controllers/employerLetterController').currentLetterFingerprint;
      if (typeof fn !== 'function') return false;
      fp = await withTimeout(fn(userId, { job, country: strOrUndef(b.country), env: req }), STALE_TIMEOUT_MS);
    }
    return typeof fp === 'string' && fp !== '' && fp !== doc.input_fingerprint;
  } catch (e) {
    // A controller that has not shipped yet is a known state, not news on every chip switch.
    if (e && e.code !== 'MODULE_NOT_FOUND') console.warn(`[employerDocs] stale check (${kind}) failed:`, e.message);
    return false;
  }
}

const TECH_ROLE_RE = /\b(engineer|engineering|developer|software|devops|sre|data|machine learning|ml|ai|scientist|architect|programmer|technical|it|security|cloud|backend|frontend|full[- ]?stack|qa|firmware|embedded)\b/i;

/**
 * The years of experience a LETTER's design is ranked with. A letter payload has no work history. ⚠️ Seniority
 * must still come from somewhere real: designFit reads a missing number as 0 years, which would push the GRADUATE
 * letter to the top for a director. This employer's own tailored resume is one indexed row away; the user's
 * experience is the same whichever employer it was tailored for. 0 when there is none (or the read fails).
 */
async function letterSeniorityOf(fit, userId, doc, req) {
  try {
    const resumeDoc = await docs.currentFor(userId, 'resume',
      { employer: doc.employer_name, employerId: doc.employer_id, jobUrl: doc.job_url }, req);
    if (resumeDoc && resumeDoc.payload) return fit.seniorityYearsOf(resumeDoc.payload);
  } catch { /* no resume doc: ranked without seniority */ }
  return 0;
}

/** A letter's "technical role" signal: its job title and the position the letter names. */
const letterRoleIsTechnical = (doc) => TECH_ROLE_RE.test(
  [doc.job_title, doc.payload && typeof doc.payload === 'object' ? doc.payload.position : null].filter((v) => typeof v === 'string').join(' '));

/**
 * A researched document's design RE-RANKED on read, or null (a row without research, or the re-rank unavailable).
 *
 * ⚠️ ONE IMPLEMENTATION, IN THE CONTROLLER (resumeBuilderController.rerankStoredDesign), because home-cards ?doc=
 * reads a resume document's design from the very same answer (its preferred card, fit and reason, and a download's
 * default mode). A second copy here would drift, and one document would show two orders. Its inputs come from the
 * row alone — the build's region, the stored research and payload — never from the client's country/website, for
 * the same reason; a letter adds only what its payload cannot say (seniority, a technical role), read here.
 * Required lazily, like the fingerprints: a controller that fails to load costs the re-rank, never the document.
 */
async function rerankedDesignOf(fit, userId, kind, doc, req) {
  if (!doc || !doc.research || typeof doc.research !== 'object' || Array.isArray(doc.research)) return null;
  // A stored design with no rerankDesign to put it through stands as it is — so skip the letter's seniority read.
  if (doc.design && typeof fit.rerankDesign !== 'function') return null;
  try {
    const fn = require('../controllers/resumeBuilderController').rerankStoredDesign;
    if (typeof fn !== 'function') return null;
    const opts = kind === 'cover_letter'
      ? { kind, seniorityYears: await letterSeniorityOf(fit, userId, doc, req), isTechnicalRole: letterRoleIsTechnical(doc) }
      : { kind: 'resume' };
    const d = fn(doc, opts);
    return d && typeof d === 'object' && Array.isArray(d.ranked) && d.ranked.length ? d : null;
  } catch (e) {
    if (e && e.code !== 'MODULE_NOT_FOUND') console.warn(`[employerDocs] design re-rank (${kind}) unavailable:`, e.message);
    return null;
  }
}

/**
 * The brand a document RENDERS in — design.brand = { accent, font } | null, what the phone tints its skeletons and
 * placeholders with while the branded pages load. ONE answer, the controller's (resumeBuilderController.docBrandOf:
 * the design's stored brand, else the research's), because home-cards ?doc=, the gallery and the downloads draw the
 * pages with that very answer — a second reading here would tint for a colour the pages never arrive in. The
 * re-rank path already carries it (rerankStoredDesign attaches it); this is for the two paths that do not. When
 * the controller cannot load, the stored design's own `brand` (shape-checked) is the only thing safe to promise.
 */
function brandFor(doc) {
  try {
    const fn = require('../controllers/resumeBuilderController').docBrandOf;
    if (typeof fn === 'function') return fn(doc) || null;
  } catch (e) {
    if (e && e.code !== 'MODULE_NOT_FOUND') console.warn('[employerDocs] brand unavailable:', e.message);
  }
  const d = doc && doc.design && typeof doc.design === 'object' && !Array.isArray(doc.design) ? doc.design : null;
  const b = d && d.brand && typeof d.brand === 'object' && !Array.isArray(d.brand) ? d.brand : null;
  if (!b) return null;
  const accent = typeof b.accent === 'string' && /^#[0-9a-f]{6}$/i.test(b.accent.trim()) ? b.accent.trim().toLowerCase() : null;
  const font = b.font && typeof b.font === 'object' && typeof b.font.family === 'string' && b.font.family.trim()
    ? { family: b.font.family.trim().slice(0, 80), google: b.font.google === true } : null;
  return accent || font ? { accent, font } : null;
}

/**
 * The document's design:
 *   • a document that carries research (with or without its hiring conventions) → its design RE-RANKED against
 *     today's employer-first rules (rerankedDesignOf). A document built before those rules gets the better order
 *     now, for free — no AI, nothing stored, and never a paid Refresh just to fix an ordering. The phone's deck
 *     draws its order and fit % from this design (the card endpoints only supply the page images);
 *   • otherwise its stored design, repaired against today's catalogue;
 *   • or, for a row built before designs were stored, a RULE-ONLY ranking computed now.
 * Every path answers with `brand` (brandFor) — the colour and font the pages are drawn in — and the rule-only
 * ranking orders the variants by that accent first, so the order and the colour agree.
 *
 * ⚠️ COMPUTED, NEVER STORED. Writing a computed ranking back would freeze a guess into the row and
 * make it indistinguishable from the AI-scored design the build writes. designFit is required lazily:
 * if it is missing or throws, the client gets design:null and shows the catalogue order.
 * ⚠️ NONE OF THIS TOUCHES `stale` (staleFor): a better order is not a changed document.
 */
async function designFor(userId, kind, doc, ctx, req) {
  let fit;
  try { fit = require('../services/designFit'); } catch (e) {
    console.warn('[employerDocs] designFit unavailable:', e.message);
    return null;
  }
  const reranked = await rerankedDesignOf(fit, userId, kind, doc, req);
  if (reranked) return reranked;
  const brand = brandFor(doc);
  try {
    // normaliseDesign keeps only the fields it knows — the brand rides on after.
    const repaired = typeof fit.normaliseDesign === 'function' ? fit.normaliseDesign(doc.design, kind) : null;
    if (repaired) return { ...repaired, brand };
  } catch (e) { console.warn('[employerDocs] normaliseDesign failed:', e.message); }

  try {
    const research = doc.research && typeof doc.research === 'object' ? doc.research : {};
    const payload = doc.payload && typeof doc.payload === 'object' ? doc.payload : {};
    const region = fit.regionFor({ country: strOrNull(ctx.country), website: strOrNull(ctx.website) });
    const industry = strOrNull(research.industry);
    const companySize = strOrNull(research.companySize);
    const accent = brand && brand.accent ? brand.accent : null;
    if (kind === 'resume') {
      return { ...fit.rankResumeDesigns({
        aiFamilyScores: null, region,
        brandColor: accent || strOrNull(research.brandColor),
        companySize, industry,
        seniorityYears: fit.seniorityYearsOf(payload),
      }), brand };
    }
    return { ...fit.rankLetterDesigns({
      region, seniorityYears: await letterSeniorityOf(fit, userId, doc, req), industry, companySize,
      isTechnicalRole: letterRoleIsTechnical(doc),
      brandColor: strOrNull(payload.brandColor) || accent || strOrNull(research.brandColor),
    }), brand };
  } catch (e) {
    console.warn(`[employerDocs] rule-only design (${kind}) failed:`, e.message);
    return null;
  }
}

/**
 * DocMeta — the shape both Home and the builder screens read. No research, ever (it is internal context).
 * `design` carries `brand` = { accent, font } | null (designFor): the look the document's pages are rendered
 * in, so the phone can tint for it — never the research it was read from.
 * jobInput is the job the document was built for ({ title, url, description, website }, or null on a row
 * from before Migration 046 stored it): a Refresh rebuilds against THAT posting, not whatever the phone's
 * evicting listing cache still holds. It is the user's own pasted listing, so it is theirs to read.
 */
function metaOf(doc, { stale, design }) {
  const payload = doc.payload && typeof doc.payload === 'object' ? doc.payload : {};
  const pi = payload.personal_info && typeof payload.personal_info === 'object' ? payload.personal_info : {};
  const ji = doc.job_input && typeof doc.job_input === 'object' ? doc.job_input : null;
  return {
    docId: Number(doc.id),
    kind: doc.kind,
    employer: doc.employer_name || '',
    employerId: doc.employer_id ? String(doc.employer_id) : null,
    jobUrl: doc.job_url || '',
    jobTitle: doc.job_title || '',
    jobInput: ji ? {
      title: typeof ji.title === 'string' ? ji.title : '',
      url: typeof ji.url === 'string' ? ji.url : '',
      description: typeof ji.description === 'string' ? ji.description : '',
      website: typeof ji.website === 'string' ? ji.website : '',
    } : null,
    createdAt: iso(doc.created_at),
    updatedAt: iso(doc.updated_at),
    editedAt: iso(doc.edited_at),
    stale: !!stale,
    design: design || null,
    summary: {
      title: typeof pi.title === 'string' ? pi.title : '',
      subject: typeof payload.subject === 'string' ? payload.subject : '',
    },
  };
}

// GET /api/employer-docs?kind=resume|cover_letter — every employer document this user holds (slim).
router.get('/', authenticateToken, async (req, res) => {
  const kind = kindOf(String(req.query.kind || ''));
  if (!kind) return res.status(400).json({ success: false, reason: 'bad_kind' });
  try {
    const list = await docs.listSlim(req.user.id, kind, req);
    return res.json({ success: true, docs: list });
  } catch (e) {
    console.error('[employerDocs] list route failed:', e.message);
    return res.status(500).json({ success: false, reason: 'failed' });
  }
});

/**
 * ⚠️ THE PHONE MUST SEE THE SAME BRAND THE PAGES ARRIVE IN. A document built while the employer's website read
 * missed its deadline carries design.brand = null and a research snapshot with no brand; the render lanes
 * (loadResumeDoc / employerLetterDocFor) lay the SHARED employer row's brand over it (one read-only SELECT,
 * never an AI call), so its cards, PDF and Word file render branded. These two routes used to answer the raw
 * row, so the deck skeletons and the library tinted with the catalogue colour under branded pages. Same lay-over
 * here; a controller that cannot load leaves the document as it is.
 */
async function withSharedBrandFor(doc, kind) {
  try {
    const mod = kind === 'cover_letter'
      ? require('../controllers/coverLetterController')
      : require('../controllers/resumeBuilderController');
    const fn = kind === 'cover_letter' ? mod.withSharedLetterBrand : mod.withSharedBrand;
    if (typeof fn === 'function') return (await fn(doc)) || doc;
  } catch (e) {
    if (e && e.code !== 'MODULE_NOT_FOUND') console.warn('[employerDocs] shared brand unavailable:', e.message);
  }
  return doc;
}

// POST /api/employer-docs/current — the document for one chip, or null. ⚠️ null starts NOTHING.
// Body: { kind, employer, employerId?, jobUrl, postingUrl?, jobTitle?, jobText?, website?, country? }.
// ⚠️ jobUrl is the doc's IDENTITY ('' = the employer itself) and is the only URL the lookup uses;
// postingUrl is only the fallback stale-check input for a row without job_input (see staleFor).
router.post('/current', authenticateToken, async (req, res) => {
  const b = req.body || {};
  const kind = kindOf(b.kind);
  if (!kind) return res.status(400).json({ success: false, reason: 'bad_kind' });
  try {
    const found = await docs.currentFor(req.user.id, kind, {
      employer: typeof b.employer === 'string' ? b.employer : '',
      employerId: typeof b.employerId === 'string' ? b.employerId : null,
      jobUrl: typeof b.jobUrl === 'string' ? b.jobUrl : '',
    }, req);
    if (!found) return res.json({ success: true, doc: null });
    const doc = await withSharedBrandFor(found, kind);
    const [stale, design] = await Promise.all([
      staleFor(req.user.id, kind, doc, b, req),
      designFor(req.user.id, kind, doc, { country: b.country, website: b.website }, req),
    ]);
    return res.json({ success: true, doc: metaOf(doc, { stale, design }) });
  } catch (e) {
    console.error('[employerDocs] current route failed:', e.message);
    return res.status(500).json({ success: false, reason: 'failed' });
  }
});

// GET /api/employer-docs/:id — one document with its payload (the builder preview / letter download).
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const found = await docs.getById(req.user.id, req.params.id, req);
    if (!found) return res.status(404).json({ success: false, reason: 'gone' });
    const kind = kindOf(found.kind);
    const doc = kind ? await withSharedBrandFor(found, kind) : found;
    const design = kind
      ? await designFor(req.user.id, kind, doc, { country: req.query.country, website: req.query.website }, req)
      : null;
    return res.json({ success: true, doc: { ...metaOf(doc, { stale: false, design }), payload: doc.payload || {} } });
  } catch (e) {
    console.error('[employerDocs] get route failed:', e.message);
    return res.status(500).json({ success: false, reason: 'failed' });
  }
});

/**
 * The payload must still be the kind of document the row is, or the next render breaks: a resume
 * without an object personal_info crashes every template, and a letter without its HTML 400s on
 * download (the renderer refuses empty content).
 */
function payloadProblem(kind, payload) {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) return 'invalid';
  if (kind === 'resume') {
    const pi = payload.personal_info;
    return pi && typeof pi === 'object' && !Array.isArray(pi) ? null : 'invalid';
  }
  const html = payload.coverLetterHtml;
  if (typeof html !== 'string' || !html.trim()) return 'invalid';
  // Refuse, never trim — a letter cut mid-tag renders as a broken letter the user then sends.
  if (Buffer.byteLength(html, 'utf8') > MAX_LETTER_HTML_BYTES) return 'too_big';
  return null;
}

/** The only markup a stored letter may carry — each WITHOUT attributes. */
const LETTER_TAGS = new Set(['p', 'br', 'strong', 'b', 'em', 'i', 'ul', 'ol', 'li']);
/** Elements dropped WITH their content: script source, css, an embedded document is never letter text. */
const LETTER_DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'noscript', 'noembed', 'noframes', 'template',
  'textarea', 'title', 'xmp', 'plaintext', 'object', 'applet', 'svg', 'math', 'head', 'select',
  'video', 'audio', 'canvas',
]);
const TAG_OPEN_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/y;
/** Text is re-escaped; an existing character reference (&amp; &#39; &eacute;) is kept as written. */
const escLetterText = (t) => t
  .replace(/&(?!(?:#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});)/gi, '&amp;')
  .replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A hand-edited letter's HTML, normalised to the strict allowlist before it is STORED.
 *
 * ⚠️ WHY THE PUT NORMALISES AND DOES NOT TRUST THE RENDERER: this HTML is later loaded into the server's
 * chromium (the PDF and the Home thumbnail), and the renderer's sanitizeBody is a handful of regexes
 * (script/style/on*=/javascript:) — an <iframe src="http://169.254.169.254/…">, an <img>, a <link> or a
 * <meta refresh> all pass it, and the THUMBNAIL then shows the user an internal page. A letter needs
 * none of that: paragraphs, line breaks, bold, italics and lists.
 *
 * ⚠️ THE OUTPUT GRAMMAR IS CLOSED, which is what makes a hand-rolled pass safe: whatever the input, the
 * result is only escaped text and the nine tags above written by THIS function with no attributes — a
 * mis-tokenised input can lose letter text, it can never emit markup. Everything else goes: comments,
 * <!doctype>/<?…?>, every other tag (its text stays — a <span> or <a> around words is still words),
 * and the elements in LETTER_DROP_WITH_CONTENT together with what is inside them. Open tags are closed,
 * stray closers dropped, so the stored letter is well formed. ⚠️ A <div>-per-paragraph letter loses its
 * paragraph breaks — our own formatter writes <p>, and the templates style `.body p`, so a <p style>
 * losing its inline style renders in the template's own spacing.
 */
function normaliseLetterHtml(input) {
  const s = String(input == null ? '' : input);
  const n = s.length;
  const open = [];
  let out = '';
  let i = 0;
  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { out += escLetterText(s.slice(i)); break; }
    out += escLetterText(s.slice(i, lt));
    i = lt;
    if (s.startsWith('<!--', i)) {
      const end = s.indexOf('-->', i + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (s[i + 1] === '!' || s[i + 1] === '?') {          // <!doctype …>, <![CDATA[…]]>, <?xml …?>
      const end = s.indexOf('>', i + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }
    TAG_OPEN_RE.lastIndex = i;
    const m = TAG_OPEN_RE.exec(s);
    if (!m) { out += '&lt;'; i += 1; continue; }        // "a < b" is text
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    // The tag ends at the first '>' outside a QUOTED ATTRIBUTE VALUE (a quote only opens one right
    // after '='), so <a title="x>y"> is one tag. An unterminated tag runs to the end and is dropped.
    let j = i + m[0].length;
    let quote = null;
    let afterEq = false;
    for (; j < n; j++) {
      const ch = s[j];
      if (quote) { if (ch === quote) quote = null; continue; }
      if (ch === '>') break;
      if (ch === '=') { afterEq = true; continue; }
      if (afterEq && (ch === '"' || ch === "'")) { quote = ch; afterEq = false; continue; }
      if (!/\s/.test(ch)) afterEq = false;
    }
    if (j >= n) break;                                     // unterminated: the browser drops it too
    // Only foreign content honours "/>" — a browser still OPENS <script/> or <iframe/> and reads on.
    const selfClosing = s[j - 1] === '/' && (name === 'svg' || name === 'math');
    i = j + 1;

    if (closing) {
      if (name === 'br') { out += '<br>'; continue; }     // browsers read </br> as <br>
      const k = open.lastIndexOf(name);
      if (k >= 0) while (open.length > k) out += `</${open.pop()}>`;
      continue;                                            // a closer with nothing open is dropped
    }
    if (LETTER_DROP_WITH_CONTENT.has(name)) {
      if (selfClosing) continue;
      const close = new RegExp(`</${name}(?=[\\s/>])`, 'ig');
      close.lastIndex = i;
      const cm = close.exec(s);
      if (!cm) { i = n; continue; }                        // never closed: everything after it goes
      const end = s.indexOf('>', cm.index);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (name === 'br') { out += '<br>'; continue; }
    if (LETTER_TAGS.has(name)) { out += `<${name}>`; open.push(name); continue; }
    // Any other element: the tag goes, its text stays.
  }
  while (open.length) out += `</${open.pop()}>`;
  return out;
}

/** Does this letter HTML still say anything? Tags, whitespace-only references and zero-width chars are not text. */
function letterHasText(html) {
  return String(html)
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:nbsp|#0*(?:160|9|10|13|32)|#x0*(?:a0|9|a|d|20));/gi, ' ')
    .replace(/[\s​-‍⁠﻿]+/g, '')
    .length > 0;
}

// PUT /api/employer-docs/:id  { payload } — the user's hand edits. Same row, same fingerprint.
router.put('/:id', authenticateToken, async (req, res) => {
  let payload = (req.body || {}).payload;
  try {
    // ⚠️ slimById THROWS on a DB error (→ 500 below) rather than answering null: "gone" makes the
    // client drop the user's unsaved edits, and a blip must not do that.
    const row = await docs.slimById(req.user.id, req.params.id, req);
    if (!row) return res.status(404).json({ success: false, reason: 'gone' });
    let problem = payloadProblem(row.kind, payload);
    if (problem === 'too_big') return res.status(413).json({ success: false, reason: 'too_big' });
    if (problem) return res.status(400).json({ success: false, reason: 'invalid' });
    if (row.kind === 'cover_letter') {
      // The letter is STORED normalised (see normaliseLetterHtml) — never as the client sent it.
      payload = { ...payload, coverLetterHtml: normaliseLetterHtml(payload.coverLetterHtml) };
      if (!letterHasText(payload.coverLetterHtml)) {
        return res.status(400).json({ success: false, reason: 'invalid', error: 'This letter has no text left to save.' });
      }
      // Re-escaping can grow the text ("&" → "&amp;"); the cap holds for what is stored, refused, never cut.
      problem = payloadProblem(row.kind, payload);
      if (problem === 'too_big') return res.status(413).json({ success: false, reason: 'too_big' });
      if (problem) return res.status(400).json({ success: false, reason: 'invalid' });
    }

    const r = await docs.updatePayload(req.user.id, row.id, payload, req, { kind: row.kind });
    if (r.ok) return res.json({ success: true, updatedAt: r.updatedAt });
    if (r.reason === 'gone') return res.status(404).json({ success: false, reason: 'gone' });
    if (r.reason === 'too_big') return res.status(413).json({ success: false, reason: 'too_big' });
    if (r.reason === 'invalid') return res.status(400).json({ success: false, reason: 'invalid' });
    return res.status(500).json({ success: false, reason: 'failed' });
  } catch (e) {
    console.error('[employerDocs] put route failed:', e.message);
    return res.status(500).json({ success: false, reason: 'failed' });
  }
});

module.exports = router;
// For the route tests only — not middleware, so the router's stack is unchanged.
module.exports.normaliseLetterHtml = normaliseLetterHtml;
module.exports.letterHasText = letterHasText;
