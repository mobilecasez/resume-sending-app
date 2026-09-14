// Which resume / cover-letter designs fit THIS employer, ranked from most to least likely to be
// picked, each with an integer fit % the app shows on the carousel card.
//
// WHY THIS EXISTS: the employer lane rewrites the resume for a company, and the design is half of
// how that resume reads to the person screening it — a photo CV in Munich, a plain one-column
// ATS page at a 50,000-person US bank, a monospace engineering page at a dev-tools startup. The AI
// that writes the content also scores the layout FAMILIES (it knows the employer from the web
// research), and this file blends that with deterministic rules we can reason about, expands the
// families into every colour variant, and emits the one Design object the rest of the stack
// stores (user_employer_documents.design) and renders.
//
// ⚠️ EMPLOYER FIRST, CANDIDATE SECOND (2026-09-14). Prod ranked the exec_pro family first for a Swiss
// IT SME, a Moroccan public agency and a Ghanaian job site alike: two had no region (.ma/.com fell to
// 'generic') and the candidate's seniority was the loudest remaining signal. The rules now lead with
// what the EMPLOYER's side of the table expects — the hiring country's CV conventions (photo, length,
// format, personal details), the employer type and sector, an applicant tracking system in the apply
// flow — researched per employer (employerResearch conventions) and, where research is silent, the
// country's general habits (regionFromCountry CV profiles, weighted lower). Seniority is a small nudge.
//
// ⚠️ THE INVARIANTS ARE THE CONTRACT, NOT A NICETY. Every consumer (home-cards, the templates
// screen, the carousel) indexes `ranked` as "the whole catalogue, best first": `ranked` lists EVERY
// template id of that kind exactly once, sorted by score desc with ties in catalogue order, and
// every score is an integer 0..100. A design with a missing id makes that design unreachable from
// the ranked gallery; a duplicate shows the same card twice; a float fit renders "87.4% fit". So
// every producer below funnels through finaliseRanked(), and a stored design from an older catalogue is
// repaired by normaliseDesign() rather than trusted.
//
// ⚠️ THE AI'S SCORES ARE ADVICE, NEVER THE WHOLE ANSWER. A model asked to score 15 families will
// sometimes score three, return "92%" strings, key by a variant id, or rate a German photo CV 95
// for a US bank — or, as prod showed, rate the same family first for every employer. Blend =
// round(0.3·ai + 0.7·rule) where the AI actually scored a family, and round(0.2·ai + 0.8·rule) when
// researched conventions are in hand (evidence about this employer outranks a model's taste);
// everything else is rule-only, so a null/garbled AI answer still yields a complete, sane ranking.
// The AI's own scores ride along in the design (aiFamilies) so rerankDesign can re-rank a stored
// design against new research without paying for the AI again.
//
// ⚠️ PURE AND SYNCHRONOUS. No DB, no network, no AI: it runs on the doc lane after the charge, on
// the GET /employer-docs read path for rows that predate designs, and in unit tests. Keep it that
// way — a design that needed I/O would be a new way for a paid build to fail after charging.
'use strict';

const resumeTemplates = require('../utils/resumeTemplates');
const coverLetterTemplates = require('../utils/coverLetterTemplates');
const regionUtil = require('../utils/regionFromCountry');

const VALID_REGIONS = new Set(['generic', 'us_ca', 'uk_au', 'india', 'dach', 'eu', 'sg']);
const VALID_MODES = new Set(['a4', 'onepage']);
const HEX_RE = /^#[0-9a-f]{6}$/i;

const REASON_MAX = 90;
const TONE_MAX = 40;
const HEADLINE_MAX = 120;
const SUMMARY_MAX = 120;

// ── Small helpers ─────────────────────────────────────────────────────────────
const clampInt = (n) => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 0;
};

/** User-facing short text: collapse whitespace, trim, hard cap (with an ellipsis when cut). */
function shortText(v, max) {
  if (typeof v !== 'string') return '';
  const s = v.replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1).replace(/\s+\S*$/, '').trimEnd() + '…';
}
const textOrNull = (v, max) => shortText(v, max) || null;

const hexOrNull = (v) => (typeof v === 'string' && HEX_RE.test(v.trim()) ? v.trim().toLowerCase() : null);
const regionOrNull = (v) => (typeof v === 'string' && VALID_REGIONS.has(v) ? v : null);

/**
 * Rule points → 0..100. A soft ceiling instead of a clamp: a dozen agreeing signals would otherwise
 * pin several families at 100, and a tie there is decided by catalogue order, not by fit.
 */
const squash = (points, spread) => clampInt(50 + 48 * Math.tanh(points / spread));

// ── Conventions (contract 1: employerResearch conventions) ────────────────────
const EMPLOYER_TYPES = new Set(['public_sector', 'enterprise', 'sme', 'startup', 'agency', 'ngo', 'academia', 'other']);
const PHOTO_VALUES = new Set(['expected', 'optional', 'avoid']);
const LENGTH_VALUES = new Set(['one_page', 'two_pages', 'flexible']);
const DETAILS_VALUES = new Set(['include', 'avoid']);
const FORMAT_VALUES = new Set(['tabular', 'narrative', 'europass', 'ats_plain']);

/**
 * The conventions as this file reads them: enums only, flattened, or null when nothing usable.
 * ⚠️ Read defensively on purpose — a stored research JSON from an older build, a caller that passes
 * the raw model answer — so an unknown value is "no signal", never a crash or a wrong boost.
 * ⚠️ IDEMPOTENT: this file's own flattened view (photo/length/… at the top level) reads back the same,
 * so a helper that already flattened can hand it on without the CV habits silently disappearing.
 */
const NO_ANSWER_RE = /^(null|none|no|unknown|n\/?a|not (known|found|specified|available))$/i;
function conventionsOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const cvRaw = raw.cv;
  const cv = cvRaw && typeof cvRaw === 'object' && !Array.isArray(cvRaw) ? cvRaw : raw;
  const pick = (set, v) => {
    const k = typeof v === 'string' ? v.trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
    return set.has(k) ? k : null;
  };
  const str = (v, max) => (typeof v === 'string' && !NO_ANSWER_RE.test(v.trim()) ? textOrNull(v, max) : null);
  const out = {
    hqCountry: str(raw.hqCountry != null ? raw.hqCountry : raw.hq_country, 60),
    roleCountry: str(raw.roleCountry != null ? raw.roleCountry : raw.role_country, 60),
    employerType: pick(EMPLOYER_TYPES, raw.employerType != null ? raw.employerType : raw.employer_type),
    sector: str(raw.sector, 60),
    atsVendor: str(raw.atsVendor != null ? raw.atsVendor : raw.ats_vendor, 40),
    photo: pick(PHOTO_VALUES, cv.photo),
    length: pick(LENGTH_VALUES, cv.length),
    personalDetails: pick(DETAILS_VALUES, cv.personalDetails != null ? cv.personalDetails : cv.personal_details),
    format: pick(FORMAT_VALUES, cv.format),
    tone: str(raw.tone, 60),
  };
  return Object.values(out).some((v) => v != null) ? out : null;
}

const TYPE_LABEL = {
  public_sector: 'public sector', enterprise: 'enterprise', sme: 'SME', startup: 'startup',
  agency: 'agency', ngo: 'non-profit', academia: 'academia',
};
const FORMAT_LABEL = { tabular: 'tabular CV', narrative: 'profile-led CV', europass: 'Europass', ats_plain: 'plain ATS CV' };
const LENGTH_LABEL = { one_page: 'one page', two_pages: 'two pages', flexible: 'flexible length' };
const PHOTO_LABEL = { expected: 'photo expected', optional: 'photo optional', avoid: 'no photo' };

/** "Switzerland · SME · IT services · ATS: Workday · photo optional · tabular CV · two pages" (≤ 120). */
function conventionsSummaryOf(conv) {
  if (!conv) return null;
  const bits = [];
  const where = conv.roleCountry || conv.hqCountry;
  if (where) bits.push(where);
  if (conv.employerType && TYPE_LABEL[conv.employerType]) bits.push(TYPE_LABEL[conv.employerType]);
  if (conv.sector) bits.push(conv.sector);
  if (conv.atsVendor) bits.push(`ATS: ${conv.atsVendor}`);
  if (conv.photo) bits.push(PHOTO_LABEL[conv.photo]);
  if (conv.format) bits.push(FORMAT_LABEL[conv.format]);
  if (conv.length) bits.push(LENGTH_LABEL[conv.length]);
  if (conv.personalDetails) bits.push(conv.personalDetails === 'include' ? 'personal details' : 'no personal details');
  return bits.length ? textOrNull(bits.join(' · '), SUMMARY_MAX) : null;
}

// ── Resume family metadata ────────────────────────────────────────────────────
// Inferred from each builder's CSS in resumeTemplates.js (keep in sync when a family's layout
// changes). `ats` here is only the fallback: the catalogue's own `ats` wins when it declares one.
//
// ⚠️ `photo` is "has a photo/avatar slot", which is NOT the catalogue's `photo` flag: azure,
// executive and minimal predate that flag but every one of them renders a round avatar (initials
// when no photo). For "should a US resume carry a face" they are photo layouts. germany and europass
// go further: with no photo they print an empty "PHOTO" box.
//
// ⚠️ `regional` marks families whose NAME says a country (India Professional, Germany Professional,
// Europass). Offered to an employer outside `home` they read as a mistake, not a style.
//
// `pages`: the length the layout reads best at ('one' dense single page, 'two' room to breathe, 'any').
// `details`: renders a personal-details block (nationality, date of birth) — only germany does.
const FAMILY_META = {
  azure:     { layout: 'sidebar',       photo: true,  ats: 3, pages: 'any', tone: 'colourful left sidebar, skill bars, modern',              short: 'Modern and colourful' },
  executive: { layout: 'sidebar',       photo: true,  ats: 3, pages: 'two', tone: 'dark slate sidebar with gold accents, premium',           short: 'Premium and dark' },
  minimal:   { layout: 'two-column',    photo: true,  ats: 3, pages: 'any', tone: 'clean header, main column + skills column with chips',    short: 'Clean and modern' },
  ats:       { layout: 'single column', photo: false, ats: 5, pages: 'one', tone: 'plain black-and-white, maximally parseable',              short: 'Plain and ATS-first' },
  exec_pro:  { layout: 'single column', photo: false, ats: 5, pages: 'two', tone: 'centred name, gold rules, senior leadership',             short: 'Senior and understated' },
  india:     { layout: 'single column', photo: false, ats: 4, pages: 'two', tone: 'skills chips and projects up front, technical',           short: 'Skills-led and technical', regional: true, home: ['india'] },
  germany:   { layout: 'single column', photo: true,  ats: 4, pages: 'two', tone: 'formal Lebenslauf: photo, personal details, signature',    short: 'Formal German CV', regional: true, home: ['dach'], details: true },
  europass:  { layout: 'single column', photo: true,  ats: 4, pages: 'two', tone: 'European standard: blue photo header, language bars',     short: 'European standard', regional: true, home: ['eu', 'dach'] },
  startup:   { layout: 'single column', photo: false, ats: 4, pages: 'one', tone: 'airy product-company look, links first',                  short: 'Airy startup look' },
  banner:    { layout: 'single column', photo: true,  ats: 4, pages: 'any', tone: 'full-width colour banner header, marketing-forward',       short: 'Bold and marketing-forward' },
  rightrail: { layout: 'sidebar',       photo: true,  ats: 3, pages: 'any', tone: 'main column with a tinted right rail, contemporary',      short: 'Contemporary and structured' },
  mono:      { layout: 'single column', photo: false, ats: 5, pages: 'one', tone: 'monospace terminal accents, engineering',                 short: 'Engineering and technical' },
  elegant:   { layout: 'single column', photo: false, ats: 4, pages: 'two', tone: 'serif typography with small caps, classic and refined',   short: 'Classic serif' },
  compact:   { layout: 'two-column',    photo: false, ats: 4, pages: 'one', tone: 'dense two-column page that fits a lot on one page',      short: 'Dense and efficient' },
  timeline:  { layout: 'single column', photo: true,  ats: 4, pages: 'two', tone: 'date-rail timeline telling a career story',               short: 'Story-led timeline' },
};

const EXEC_FAMILIES = new Set(['executive', 'exec_pro']);
const EARLY_FAMILIES = new Set(['compact', 'startup']);
const VISUAL_FAMILIES = new Set(['banner', 'rightrail', 'timeline', 'startup', 'azure']);

/** Catalogue view, derived from the live registry every call-site renders from (so a new family or
 *  variant is ranked the day it ships — unknown families get neutral metadata). */
function resumeCatalogue() {
  const families = (resumeTemplates.FAMILIES || []).map((f) => {
    const m = FAMILY_META[f.id] || {};
    return {
      id: f.id,
      name: f.name,
      layout: m.layout || 'single column',
      photo: m.photo != null ? m.photo : !!f.photo,
      ats: Number(f.ats) || m.ats || 3,
      tone: m.tone || '',
      short: m.short || f.name,
      regional: !!m.regional,
      home: Array.isArray(m.home) ? m.home : [],
      pages: m.pages || 'any',
      details: !!m.details,
      members: (resumeTemplates.TEMPLATES || []).filter((t) => t.family === f.id).map((t) => ({ id: t.id, name: t.name, accent: t.accent })),
    };
  });
  return { families, ids: resumeTemplates.TEMPLATE_IDS.slice() };
}

const REGION_LABEL = {
  generic: 'most countries', us_ca: 'the US and Canada', uk_au: 'the UK and Australia',
  india: 'India', dach: 'Germany, Austria and Switzerland', eu: 'Europe', sg: 'Singapore',
};

// ── resumeFamilyBrief ─────────────────────────────────────────────────────────
/**
 * Compact table of the design families for the AI prompt. One line per family; the AI scores
 * FAMILIES (15), never the 73 colour variants — colour is our job (brand-colour distance below).
 */
function resumeFamilyBrief() {
  const { families } = resumeCatalogue();
  const lines = ['id | name | layout | photo slot | ats 1-5 | visual tone'];
  for (const f of families) {
    lines.push(`${f.id} | ${f.name} | ${f.layout} | ${f.photo ? 'yes' : 'no'} | ${f.ats} | ${f.tone}`);
  }
  lines.push('(Each family also ships several colour variants — score the family only; the colour is matched to the employer separately.)');
  return lines.join('\n');
}

// ── seniorityYearsOf ──────────────────────────────────────────────────────────
const MONTHS = [
  [/^jan/, 0], [/^(feb|fév|fev)/, 1], [/^(mar|mär|maerz|mrz)/, 2], [/^(apr|avr)/, 3], [/^(may|mai|mei|mag)/, 4],
  [/^(jun|juin|giu)/, 5], [/^(jul|juil|lug)/, 6], [/^(aug|aoû|aou|ago)/, 7], [/^(sep|set)/, 8],
  [/^(oct|okt|ott)/, 9], [/^nov/, 10], [/^(dec|dez|déc|dic)/, 11],
];
const PRESENT_RE = /\b(present|current(ly)?|now|today|ongoing|till date|to date|heute|aktuell|actuel|présent|presente|actualidad|attuale|heden|nu|jetzt)\b/i;

/** One date-ish string → months since year 0, or null. `isEnd` picks December for a bare year. */
function monthIndexOf(s, isEnd, nowIdx) {
  const str = String(s == null ? '' : s).trim().toLowerCase();
  if (!str) return null;
  if (PRESENT_RE.test(str)) return nowIdx;
  let y = null; let m = null;
  let mm = str.match(/\b((?:19|20)\d{2})[-/.](\d{1,2})\b/);
  if (mm) { y = +mm[1]; m = +mm[2] - 1; }
  if (y == null) { mm = str.match(/\b(\d{1,2})[-/.]((?:19|20)\d{2})\b/); if (mm) { y = +mm[2]; m = +mm[1] - 1; } }
  if (y == null) {
    mm = str.match(/\b((?:19|20)\d{2})\b/);
    if (mm) {
      y = +mm[1];
      const word = str.replace(mm[0], ' ').match(/[a-zà-ÿ]{3,}/);
      if (word) { const hit = MONTHS.find(([re]) => re.test(word[0])); if (hit) m = hit[1]; }
    }
  }
  if (y == null) return null;
  if (m == null || m < 0 || m > 11) m = isEnd ? 11 : 0;
  const idx = y * 12 + m;
  if (y < 1950) return null;
  return Math.min(idx, nowIdx);
}

/**
 * Years spanned by experience[] dates (earliest start → latest end, ongoing roles end today),
 * one decimal. 0 when nothing parses — callers treat 0 as "unknown/early", never as a fact.
 */
function seniorityYearsOf(resumeData) {
  try {
    const exp = resumeData && Array.isArray(resumeData.experience) ? resumeData.experience : [];
    if (!exp.length) return 0;
    const now = new Date();
    const nowIdx = now.getFullYear() * 12 + now.getMonth();
    let lo = null; let hi = null;
    exp.forEach((e, i) => {
      if (!e || typeof e !== 'object') return;
      let startRaw = e.start_date; let endRaw = e.end_date;
      // "2019 – Present" typed entirely into start_date.
      if (startRaw && !String(endRaw || '').trim()) {
        const parts = String(startRaw).split(/\s+[-–—]\s+|\s+to\s+|\s+bis\s+/i);
        if (parts.length === 2) { startRaw = parts[0]; endRaw = parts[1]; }
      }
      const a = monthIndexOf(startRaw, false, nowIdx);
      let b = monthIndexOf(endRaw, true, nowIdx);
      // A start with no end is the ongoing role when it is the newest entry; otherwise unknown.
      if (a != null && b == null) b = i === 0 ? nowIdx : a;
      if (a == null && b == null) return;
      const s = a != null ? a : b; const t = b != null ? b : a;
      lo = lo == null ? Math.min(s, t) : Math.min(lo, s, t);
      hi = hi == null ? Math.max(s, t) : Math.max(hi, s, t);
    });
    if (lo == null || hi == null || hi < lo) return 0;
    return Math.min(60, Math.round(((hi - lo) / 12) * 10) / 10);
  } catch {
    return 0;
  }
}

// ── regionFor ─────────────────────────────────────────────────────────────────
/**
 * The convention region for an employer: the caller's country, then the research's role country,
 * the website's ccTLD, the research's HQ country, a region word ("Europe"), then 'generic' — the one
 * chain in regionFromCountry.resolveRegion (employerResearch.regionForConventions uses it too).
 * ⚠️ 'generic' is a TRUTHY string: a caller that wants its own fallback must test for it, not `||`.
 */
function regionFor({ country, website, conventions } = {}) {
  const r = regionUtil.resolveRegion({
    country: typeof country === 'string' ? country : '',
    website: typeof website === 'string' ? website : '',
    conventions: conventionsOf(conventions),
  });
  return VALID_REGIONS.has(r) ? r : 'generic';
}

// ── Employer signals ──────────────────────────────────────────────────────────
/** 'large' | 'small' | null from a free-text size ("10,001+ employees", "50-200", "Enterprise"). */
function sizeClassOf(companySize) {
  const s = String(companySize == null ? '' : companySize).toLowerCase();
  if (!s.trim()) return null;
  if (/\b(enterprise|multinational|fortune|conglomerate|large|global corporation)\b/.test(s)) return 'large';
  if (/\b(startup|start-up|seed|series a|early[- ]stage|small)\b/.test(s)) return 'small';
  const nums = (s.replace(/(\d),(\d{3})/g, '$1$2').match(/\d+(\.\d+)?\s*k?/g) || [])
    .map((x) => (/k/.test(x) ? parseFloat(x) * 1000 : parseFloat(x)))
    .filter((n) => Number.isFinite(n) && n > 0 && n < 5e6);
  if (!nums.length) return null;
  const max = Math.max(...nums);
  if (max >= 1000) return 'large';
  if (max <= 200) return 'small';
  return null;
}

// Strongly visual employers (a layout is part of the pitch) vs consumer brands (a little colour helps).
// ⚠️ Engineering "design" and "architecture" are not creative ("chip design", "software architecture"),
// and neither is "state-of-the-art".
const CREATIVE_RE = /(?<!(?:chip|circuit|asic|semiconductor|software|system|systems|hardware|engineering|mechanical|electrical|structural|solution|solutions|database|network|api)[ -])\b(design\w*|creative|advertis\w*|branding|fashion|film|music|(?<!of[- ]the[- ])arts?|animation|photograph\w*|illustrat\w*|architectural|architecture (firm|studio|practice)|gaming|games|playful|vibrant|bold)\b/;
const CONSUMER_RE = /\b(media|marketing|publishing|content|social media|e-?commerce|retail|consumer|hospitality|travel|beauty|lifestyle|entertainment)\b/;
const FORMAL_RE = /\b(bank\w*|finance|financial|insurance|legal|law|attorneys?|government|public sector|federal|ministry|municipal\w*|accounting|audit\w*|tax|investment|asset management|wealth|compliance|regulat\w*|defen[cs]e|conservative|formal|traditional)\b/;
const TECH_RE = /\b(software|saas|developer\w*|engineering|cloud|data|ai|machine learning|cyber\w*|security|devops|it services|technology|tech|platform|semiconductor\w*|telecom\w*|fintech|internet|technical)\b/;
const STARTUP_RE = /\b(startup|start-up|scale-?up|fast-paced|scrappy|seed|series [a-c])\b/;
const PREMIUM_RE = /\b(luxury|premium|elegant|prestig\w*|academ\w*|universit\w*|museum|research institute)\b/;
const GOV_RE = /\b(government|public sector|public administration|public agency|public employment|public service|ministry|municipal\w*|federal agency|state agency|civil service|city council|county council|local authority)\b/;
const ACADEMIA_RE = /\b(universit\w*|college|higher education|research institute|academ\w*|school district)\b/;
const NGO_RE = /\b(non-?profit|not-for-profit|charit\w*|ngo|humanitarian|united nations|international organi[sz]ation)\b/;
const RECRUIT_RE = /\b(recruit\w*|staffing|job boards?|jobs boards?|job sites?|job portals?|jobs portals?|employment agency|headhunt\w*|executive search|hr services|career portals?)\b/;
const AGENCY_RE = /\b(design studio|creative agency|advertising agency|marketing agency|digital agency|branding agency|media agency|pr agency)\b/;

/** The employer type free text implies, when research did not say (weighted as a guess). */
function inferEmployerType(text, size) {
  if (GOV_RE.test(text)) return 'public_sector';
  if (ACADEMIA_RE.test(text)) return 'academia';
  if (NGO_RE.test(text)) return 'ngo';
  if (RECRUIT_RE.test(text) || AGENCY_RE.test(text)) return 'agency';
  if (STARTUP_RE.test(text)) return 'startup';
  if (size === 'large') return 'enterprise';
  if (size === 'small') return 'sme';
  return null;
}

// Evidence weights: a researched fact about THIS employer counts in full; the same fact researched for
// another country than the one being ranked for (a US HQ's habits for a role in Germany), a country's
// general habit, or an employer type guessed from free text, count for less.
const W_RESEARCH = 1;
const W_FOREIGN_RESEARCH = 0.4;
const W_COUNTRY_DEFAULT = 0.6;
const W_INFERRED_TYPE = 0.6;
// How much the writing model's own family scores count against the rules.
const AI_WEIGHT = 0.3;
const AI_WEIGHT_WITH_RESEARCH = 0.2;

/**
 * Employer type → family points. 'agency' splits on the sector: a creative agency sells with its
 * look; a recruitment agency re-sends CVs through its own tracking system.
 */
const TYPE_POINTS = {
  public_sector:   { exec_pro: 12, elegant: 8, ats: 8, europass: 4, germany: 3, minimal: 4, banner: -12, rightrail: -10, timeline: -6, startup: -12, mono: -8, azure: -6, executive: -4, compact: -2 },
  enterprise:      { ats: 6, exec_pro: 6, elegant: 3, compact: 2, mono: 2, germany: 3, europass: 2, azure: -6, executive: -4, rightrail: -6, banner: -3, timeline: -2 },
  sme:             { minimal: 5, exec_pro: 4, elegant: 3, timeline: 3, compact: 3, startup: 2, banner: 1 },
  startup:         { startup: 14, mono: 6, compact: 6, minimal: 5, rightrail: 3, banner: 2, exec_pro: -8, executive: -10, elegant: -8, germany: -6, europass: -6 },
  agency_creative: { banner: 12, rightrail: 11, timeline: 8, minimal: 4, azure: 4, startup: 3, ats: -6, exec_pro: -6, elegant: -4 },
  agency:          { ats: 10, exec_pro: 6, compact: 4, elegant: 2, azure: -6, rightrail: -6, banner: -4, executive: -4, timeline: -2 },
  ngo:             { minimal: 6, timeline: 6, elegant: 4, exec_pro: 4, europass: 2, mono: -4, startup: -2, executive: -4 },
  academia:        { elegant: 14, exec_pro: 6, minimal: 4, europass: 3, timeline: 2, banner: -8, rightrail: -6, startup: -8, mono: -4, azure: -4, compact: -2 },
};
const TYPE_WHY = {
  public_sector: 'Formal, conservative layout public-sector panels expect',
  enterprise: 'ATS-safe layout large employers screen reliably',
  sme: 'Clean, versatile layout for an established company',
  startup: 'Modern look startups respond to',
  agency_creative: 'Visual layout suits a creative, brand-led employer',
  agency: 'Plain layout that recruiters’ tracking systems parse cleanly',
  ngo: 'Warm, structured layout for a mission-led organisation',
  academia: 'Classic, understated layout academic panels expect',
};

const NEEDS_THE = /^(united |netherlands$|philippines$|bahamas$|gambia$|maldives$|seychelles$|comoros$|czech republic$|dominican republic$|central african republic$|republic of |dr congo$|isle of man$|cayman islands$|faroe islands$|solomon islands$|uk$|us$|uae$)/i;
/** ' in Switzerland' / ' in the United States' / ' in Europe' / '' — where a convention's reason holds. */
const inWhere = (name) => (name ? ` in ${NEEDS_THE.test(name) ? 'the ' : ''}${name}` : '');

/**
 * One CV convention's points for one family: { pts, why }. `where` names the country (or region)
 * the convention belongs to, for the user-facing reason.
 */
function conventionPoints(f, field, value, where) {
  switch (field) {
    case 'photo':
      if (value === 'expected') return f.photo ? { pts: 12, why: `Photo CVs are expected${inWhere(where)}` } : { pts: -6, why: '' };
      if (value === 'optional') return f.photo ? { pts: 3, why: `Has the photo slot CVs${inWhere(where)} often carry` } : { pts: 0, why: '' };
      if (value === 'avoid') return f.photo ? { pts: -14, why: '' } : { pts: 4, why: `No photo, as CVs${inWhere(where)} usually leave it out` };
      break;
    case 'personalDetails':
      if (value === 'include' && f.details) return { pts: 6, why: `Personal details section, as CVs${inWhere(where)} include` };
      if (value === 'avoid' && f.details) return { pts: -8, why: '' };
      break;
    case 'length':
      if (value === 'one_page') return f.pages === 'one' ? { pts: 8, why: `One-page layout, the norm${inWhere(where)}` } : f.pages === 'two' ? { pts: -6, why: '' } : { pts: 0, why: '' };
      if (value === 'two_pages') return f.pages === 'two' ? { pts: 5, why: `Room for the two-page CV usual${inWhere(where)}` } : f.pages === 'one' ? { pts: -3, why: '' } : { pts: 0, why: '' };
      break;
    case 'format': {
      if (value === 'tabular') {
        const pts = { germany: 16, timeline: 5, europass: 4, exec_pro: 2 }[f.id] || 0;
        return { pts, why: pts > 0 ? `Tabular, date-led CV layout standard${inWhere(where)}` : '' };
      }
      if (value === 'europass') {
        const pts = { europass: 16, germany: 4 }[f.id] || 0;
        return { pts, why: pts > 0 ? `Europass-style CV widely used${inWhere(where)}` : '' };
      }
      if (value === 'ats_plain') {
        if (f.layout !== 'single column') return { pts: -10, why: '' };
        return f.ats >= 5 ? { pts: 10, why: 'Plain single column that applicant tracking systems parse' } : { pts: 3, why: '' };
      }
      if (value === 'narrative') {
        const pts = { exec_pro: 5, elegant: 4, minimal: 3, ats: 3, banner: 2, timeline: 2 }[f.id] || 0;
        return { pts, why: pts > 0 ? `Profile-led layout that reads well${inWhere(where)}` : '' };
      }
      break;
    }
    default: break;
  }
  return { pts: 0, why: '' };
}

// ── Resume rule score ─────────────────────────────────────────────────────────
/**
 * 0..100 rule score for one family plus the strongest positive reason (user-facing, ≤ 90 chars).
 * Each contribution carries its own sentence so the card can say WHY it ranks, not just a number.
 * ctx: { region, home, place, size, type, typeWeight, creative, atsVendor, seniorityYears, text, cv }
 * where cv is [{ field, value, weight, where }] — every CV convention that applies, already weighted.
 */
function ruleScoreFamily(f, ctx) {
  const parts = [];
  // `say` only breaks near-ties when picking the reason: a sentence about the employer (its type,
  // sector, ATS) tells the user more than "room for two pages" at the same points.
  const add = (pts, why, say = 0) => { if (pts) parts.push({ pts, why, say }); };

  // 1) The hiring country's CV conventions: researched for this employer, else the country's habit.
  for (const c of ctx.cv || []) {
    const { pts, why } = conventionPoints(f, c.field, c.value, c.where);
    // A photo slot costs a creative employer less: its CVs are judged as design work too (and the
    // slot shows initials when the candidate has no photo).
    const soften = c.field === 'photo' && c.value === 'avoid' && pts < 0 && ctx.creative ? 0.35 : 1;
    add(pts * c.weight * soften, why, c.field === 'length' ? -2 : 1);
  }

  // 2) The employer type (researched, or guessed from size / industry text at a lower weight).
  if (ctx.type) {
    const key = ctx.type === 'agency' && ctx.creative ? 'agency_creative' : ctx.type;
    const pts = TYPE_POINTS[key] && TYPE_POINTS[key][f.id];
    if (pts) add(pts * (ctx.typeWeight || 1), pts > 0 ? TYPE_WHY[key] : '', 2);
  }

  // 3) Applicant tracking: heavier where screening software is near-universal, heaviest when the
  //    research found the ATS in the employer's own apply flow.
  const heavyAts = ctx.size === 'large' || ctx.type === 'enterprise' || ctx.type === 'public_sector'
    || ctx.region === 'us_ca' || ctx.region === 'uk_au' || ctx.region === 'india' || !!ctx.atsVendor;
  add((f.ats - 3) * (heavyAts ? 2.5 : 1.5), f.ats >= 5
    ? (ctx.size === 'large' ? 'ATS-safe layout that large employers screen reliably' : 'Parses cleanly in applicant tracking systems')
    : f.ats >= 4 ? 'Reads well in applicant tracking systems' : '');
  if (ctx.atsVendor) {
    if (f.layout === 'single column') add(f.ats >= 5 ? 5 : 3, `ATS-safe single column that ${ctx.atsVendor} parses cleanly`, 1);
    else add(f.ats >= 4 ? -2 : -10, '');
  }

  // 4) The region's curated gallery (earlier = more typical there) — a prior, weaker than evidence
  //    about the employer. A proxy region (Morocco in "eu", Ghana in "uk_au") and a family named for
  //    another country count half and claim no reason; so does a conservative pick for a creative
  //    employer, whose own taste outranks the country's default.
  const regionRow = (resumeTemplates.REGIONS || []).find((r) => r.id === ctx.region);
  const list = regionRow ? regionRow.templates : [];
  const at = list.indexOf(f.id);
  const awayFromHome = f.regional && !f.home.includes(ctx.region);
  if (at >= 0) {
    const base = ctx.region === 'generic' ? 3 - 0.75 * at : 6 - 1.5 * at;
    const scale = (ctx.home ? 1 : 0.5) * (awayFromHome ? 0.5 : 1) * (ctx.creative && !VISUAL_FAMILIES.has(f.id) ? 0.5 : 1);
    add(base * scale, ctx.home && !awayFromHome
      ? (ctx.region === 'generic' ? 'A well-proven all-round format' : `A standard format in ${REGION_LABEL[ctx.region]}`)
      : '');
    if (awayFromHome) add(-4, ''); // "Germany Professional" for a French or Moroccan employer: listed, but named for elsewhere
  } else if (f.regional && ctx.region !== 'generic') {
    add(-10, '');
  }

  // 5) Sector and tone words (industry, the research's sector and tone, the AI's tone).
  const text = ctx.text;
  if (text) {
    if (CREATIVE_RE.test(text)) {
      const pts = { banner: 12, rightrail: 11, timeline: 8, startup: 3, azure: 3, ats: -4, exec_pro: -4, elegant: -2 }[f.id] || 0;
      add(pts, pts > 0 ? 'Visual layout suits a creative, brand-led employer' : '', 2);
    } else if (CONSUMER_RE.test(text)) {
      const pts = { banner: 5, rightrail: 4, timeline: 3, azure: 2 }[f.id] || 0;
      add(pts, pts > 0 ? 'A touch of colour suits a consumer-facing brand' : '');
    }
    if (FORMAL_RE.test(text)) {
      const pts = { exec_pro: 8, elegant: 6, ats: 6, germany: 4, europass: 4, minimal: 2, banner: -6, rightrail: -4, startup: -4, mono: -2 }[f.id] || 0;
      add(pts, pts > 0 ? 'Conservative look for finance, legal or government' : '', 2);
    }
    if (TECH_RE.test(text)) {
      const pts = { mono: 10, startup: 4, compact: 4 }[f.id] || 0;
      add(pts, f.id === 'mono' ? 'Engineering-style layout for a tech employer' : 'Modern layout that suits a tech employer', 2);
    }
    if (PREMIUM_RE.test(text) && (f.id === 'elegant' || f.id === 'executive')) add(6, 'Refined look for a prestige employer', 2);
    if (ctx.type !== 'startup' && STARTUP_RE.test(text) && f.id === 'startup') add(6, 'Modern look startups respond to', 2);
    if (ctx.type !== 'agency' && RECRUIT_RE.test(text)) {
      const pts = { ats: 6, exec_pro: 2 }[f.id] || 0;
      add(pts, pts > 0 ? 'Plain layout that recruiters’ tracking systems parse cleanly' : '', 2);
    }
  }

  // 6) Seniority — a nudge, not a verdict. ⚠️ 0 means UNKNOWN (seniorityYearsOf found no dates), not
  //    "no experience": the early-career lift only applies to a known 0 < years < 3.
  const yrs = ctx.seniorityYears;
  if (EXEC_FAMILIES.has(f.id)) {
    if (yrs >= 12) add(4, 'Leadership format for 12+ years of experience');
    else if (yrs >= 8) add(2, 'Senior format for a seasoned career');
    else if (yrs > 0 && yrs < 3) add(-3, '');
  }
  if (f.id === 'elegant' && yrs >= 12) add(2, 'Understated classic look for a senior career');
  if (EARLY_FAMILIES.has(f.id) && yrs > 0 && yrs < 3) add(3, f.id === 'compact' ? 'Compact one-pager for an early career' : 'Fresh, modern look for an early career');

  const score = squash(parts.reduce((s, p) => s + p.pts, 0), 60);
  const best = parts.filter((p) => p.pts > 0 && p.why).sort((a, b) => (b.pts + b.say) - (a.pts + a.say))[0];
  return { score, reason: best ? shortText(best.why, REASON_MAX) : '' };
}

/**
 * Everything the rules need about the employer, from whatever the caller has: the region, the
 * country whose habits apply, the researched conventions, the employer type, the words.
 */
function employerContext({ region, conventions, employerType, country, website, companySize, industry, toneText, seniorityYears }) {
  const conv = conventionsOf(conventions);
  const hinted = !!(conv || (typeof country === 'string' && country.trim()) || (typeof website === 'string' && website.trim()));
  const reg = regionOrNull(region) || (hinted ? regionFor({ country, website, conventions: conv }) : 'generic');

  // The country whose general CV habits apply — only when it sits in the region being ranked for.
  let place = null;
  try { place = regionUtil.placeFor({ country, website, conventions: conv }); } catch { place = null; }
  if (place && place.region !== reg) place = null;
  const where = place ? place.name : (reg !== 'generic' ? REGION_LABEL[reg] : null);
  const defaults = regionUtil.cvDefaultsFor(place || reg) || {};

  // Researched CV habits count in full unless they were researched for another country's hiring.
  const convPlace = conv ? (regionUtil.countryOf(conv.roleCountry || '') || regionUtil.countryOf(conv.hqCountry || '')) : null;
  // ('generic' is "no region known", not another country: nothing to be foreign to.)
  const convWeight = convPlace && reg !== 'generic' && convPlace.region !== reg ? W_FOREIGN_RESEARCH : W_RESEARCH;
  const convWhere = convPlace ? convPlace.name : where;
  const cv = [];
  for (const field of ['photo', 'personalDetails', 'length', 'format']) {
    const researched = conv && conv[field];
    if (researched && convWeight === W_RESEARCH) { cv.push({ field, value: researched, weight: W_RESEARCH, where: convWhere }); continue; }
    if (defaults[field]) cv.push({ field, value: defaults[field], weight: W_COUNTRY_DEFAULT, where });
    if (researched) cv.push({ field, value: researched, weight: W_FOREIGN_RESEARCH, where: convWhere });
  }

  const size = sizeClassOf(companySize);
  const text = [industry, toneText, companySize, conv && conv.sector, conv && conv.tone]
    .filter((x) => typeof x === 'string').join(' ').toLowerCase();
  const declared = typeof employerType === 'string' && EMPLOYER_TYPES.has(employerType) ? employerType : (conv && conv.employerType) || null;
  const type = declared && declared !== 'other' ? declared : (declared === 'other' ? null : inferEmployerType(text, size));
  const yrs = Number.isFinite(Number(seniorityYears)) ? Math.max(0, Number(seniorityYears)) : 0;

  return {
    conv,
    region: reg,
    home: place ? place.home : true,
    place,
    cv,
    size,
    type,
    typeWeight: declared ? W_RESEARCH : W_INFERRED_TYPE,
    creative: CREATIVE_RE.test(text) || AGENCY_RE.test(text),
    atsVendor: conv && conv.atsVendor ? conv.atsVendor : null,
    seniorityYears: yrs,
    text,
    // The page length the RESEARCH asked for (never a default, never another country's habit).
    researchedLength: conv && convWeight === W_RESEARCH ? conv.length : null,
  };
}

// ── Colour distance (CIE76 in Lab) ────────────────────────────────────────────
function hexToLab(hex) {
  const h = String(hex || '').replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  const lin = (i) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const r = lin(0); const g = lin(2); const b = lin(4);
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = (r * 0.2126 + g * 0.7152 + b * 0.0722);
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x); const fy = f(y); const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function colourDistance(a, b) {
  const la = hexToLab(a); const lb = hexToLab(b);
  if (!la || !lb) return Infinity;
  return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
}

// ── finalise: the one place invariants are enforced ───────────────────────────
/**
 * scores: Map id → { score, reason }. Emits EVERY catalogue id exactly once (missing → 0),
 * integer-clamped, sorted by score desc, ties in catalogue order.
 */
function finaliseRanked(ids, scores) {
  const order = new Map(ids.map((id, i) => [id, i]));
  return ids
    .map((id) => {
      const s = scores.get(id);
      return { id, score: clampInt(s ? s.score : 0), reason: shortText(s && s.reason, REASON_MAX) };
    })
    .sort((a, b) => (b.score - a.score) || (order.get(a.id) - order.get(b.id)));
}

// ── rankResumeDesigns ─────────────────────────────────────────────────────────
/** Accepts { score, reason } | number | "92%" per family; anything else = "the AI did not score it". */
function aiEntryOf(v) {
  if (v == null) return null;
  const rawScore = typeof v === 'object' ? v.score : v;
  // Only a number or a numeric string counts — Number(null) / Number(true) would read as a real score.
  if (typeof rawScore !== 'number' && typeof rawScore !== 'string') return null;
  const n = typeof rawScore === 'string' ? parseFloat(rawScore) : rawScore;
  if (!Number.isFinite(n)) return null;
  return { score: clampInt(n), reason: typeof v === 'object' ? shortText(v.reason, REASON_MAX) : '' };
}

/** The AI's family scores keyed by FAMILY id in catalogue order (a variant key maps home), or null. */
function aiFamiliesOf(raw, families) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return new Map();
  const familyOfId = new Map();
  for (const f of families) for (const m of f.members) familyOfId.set(m.id, f.id);
  const byFamily = new Map();
  for (const [k, v] of Object.entries(raw)) {
    const fam = families.some((f) => f.id === k) ? k : familyOfId.get(k);
    const entry = aiEntryOf(v);
    if (!fam || !entry) continue;
    if (byFamily.has(fam) && fam !== k) continue; // an exact family key beats a variant-keyed guess
    byFamily.set(fam, entry);
  }
  const ordered = new Map();
  for (const f of families) if (byFamily.has(f.id)) ordered.set(f.id, byFamily.get(f.id));
  return ordered;
}

function rankResumeDesigns({
  aiFamilyScores = null, region = null, brandColor = null, companySize = null, industry = null,
  seniorityYears = 0, mode = null, tone = null, headline = null,
  conventions = null, employerType = null, country = null, website = null,
} = {}) {
  const { families, ids } = resumeCatalogue();
  const brand = hexOrNull(brandColor);
  const toneText = shortText(tone, TONE_MAX);
  const ctx = employerContext({ region, conventions, employerType, country, website, companySize, industry, toneText, seniorityYears });
  const reg = ctx.region;
  const yrs = ctx.seniorityYears;

  const ai = aiFamiliesOf(aiFamilyScores, families);
  const aiWeight = ctx.conv ? AI_WEIGHT_WITH_RESEARCH : AI_WEIGHT;

  const scores = new Map();
  const familyResults = [];
  for (const f of families) {
    const rule = ruleScoreFamily(f, ctx);
    const a = ai.get(f.id);
    const famScore = a ? clampInt(aiWeight * a.score + (1 - aiWeight) * rule.score) : rule.score;
    // With research in hand the card says what the EMPLOYER expects; the model's line is the fallback.
    const reason = ctx.conv ? (rule.reason || (a && a.reason) || '') : ((a && a.reason) || rule.reason);
    familyResults.push({ f, score: famScore, reason });

    // Variants: closest accent to the brand first. The step grows by one per rank plus up to 3 for
    // a far colour, so within a family the order is STRICTLY decreasing — the global tie-break
    // (catalogue order) can never flip "closest first".
    let members = f.members.map((m, i) => ({ ...m, i, d: brand ? colourDistance(m.accent, brand) : 0 }));
    if (brand) {
      members = members.slice().sort((x, y) => (x.d - y.d) || (x.i - y.i));
      const finite = members.map((m) => m.d).filter(Number.isFinite);
      const maxD = finite.length ? Math.max(...finite, 1) : 1;
      members.forEach((m, rank) => {
        const far = Number.isFinite(m.d) ? Math.round((m.d / maxD) * 3) : 3;
        scores.set(m.id, { score: famScore - rank - far, reason });
      });
    } else {
      members.forEach((m, rank) => scores.set(m.id, { score: famScore - rank, reason }));
    }
  }

  const ranked = finaliseRanked(ids, scores);
  const top = ranked[0];
  const topFamily = top && familyResults.find((r) => r.f.members.some((m) => m.id === top.id));
  const topName = top ? ((resumeTemplates.TEMPLATES.find((t) => t.id === top.id) || {}).name || top.id) : '';

  // Page mode: the page length THIS employer's research asked for, else the AI's call, else the
  // regional default (short careers in one-page markets print as one continuous page).
  const modeOut = ctx.researchedLength === 'one_page' ? 'onepage'
    : ctx.researchedLength === 'two_pages' ? 'a4'
      : VALID_MODES.has(mode) ? mode
        : (yrs < 8 && ['us_ca', 'uk_au', 'sg', 'india'].includes(reg) ? 'onepage' : 'a4');

  // ⚠️ The model's headline names ITS favourite. Once the rules outvote it, that sentence would sit
  // above a different design — so it is used only while the model's top family is the one leading.
  const aiTop = ai.size ? [...ai.entries()].sort((x, y) => y[1].score - x[1].score)[0][0] : null;
  const aiHeadlineFits = !aiTop || (topFamily && topFamily.f.id === aiTop);
  const headlineOut = (aiHeadlineFits ? shortText(headline, HEADLINE_MAX) : '')
    || (top ? shortText(top.reason ? `${topName} fits best — ${top.reason}` : `${topName} is the strongest fit for this employer`, HEADLINE_MAX) : '');

  return {
    v: 1,
    kind: 'resume',
    ranked,
    mode: modeOut,
    brandColor: brand,
    tone: toneText || (topFamily ? shortText(topFamily.f.short, TONE_MAX) : '') || null,
    region: reg,
    headline: headlineOut || null,
    aiFamilies: ai.size ? Object.fromEntries([...ai.entries()].map(([id, e]) => [id, { score: e.score, reason: e.reason }])) : null,
    conventionsSummary: conventionsSummaryOf(ctx.conv),
  };
}

// ── rankLetterDesigns ─────────────────────────────────────────────────────────
const LETTER_REGION_WHY = {
  generic: 'Your branded letter layout, ready for any employer',
  us_ca: 'Direct, achievement-led format US and Canadian employers expect',
  uk_au: 'Professional, respectful format for UK and Australian employers',
  india: 'Skills-and-projects format Indian employers expect',
  dach: 'The formal letter format German-speaking employers expect',
  eu: 'Motivation-led format European employers expect',
  sg: 'Corporate, concise format for Singapore employers',
};
const LETTER_TYPE_POINTS = {
  public_sector:   { ats_pro: 8, euro_motivation: 4, german: 3, exec_leader: 2, graduate: -6, standard: -6 },
  enterprise:      { ats_pro: 6, exec_leader: 3, standard: -2 },
  sme:             { standard: 5, euro_motivation: 2, technical: 1 },
  startup:         { standard: 8, technical: 4, graduate: 2, exec_leader: -6, german: -4, euro_motivation: -2 },
  agency_creative: { standard: 14, exec_leader: -2, ats_pro: -4 },
  agency:          { ats_pro: 8, exec_leader: 2 },
  ngo:             { euro_motivation: 4, standard: 4, exec_leader: 2 },
  academia:        { exec_leader: 4, ats_pro: 4, euro_motivation: 3, graduate: -2 },
};
// Per template: the same employer type is a different sentence for each letter it lifts.
const LETTER_TYPE_WHY = {
  public_sector: {
    ats_pro: 'Conservative, criteria-led letter for a public-sector employer',
    euro_motivation: 'Motivation letter in the formal register public bodies expect',
    german: 'Conservative, criteria-led letter for a public-sector employer',
    exec_leader: 'Measured, senior tone for a public-sector employer',
  },
  enterprise: { ats_pro: 'ATS-safe letter for a large employer', exec_leader: 'Polished, senior tone for a large employer' },
  sme: { standard: 'Personable branded letter for an established company', euro_motivation: 'Motivation-led letter for an established company', technical: 'Leads with technical depth for a technical role' },
  startup: { standard: 'Direct, branded letter a startup reads quickly', technical: 'Leads with the technical work a startup hires for', graduate: 'Approachable letter for a startup team' },
  agency_creative: { standard: 'Branded letter for a creative, brand-led employer' },
  agency: { ats_pro: 'Clean letter that recruiters’ tracking systems parse reliably', exec_leader: 'Polished tone recruiters forward to their clients' },
  ngo: { euro_motivation: 'Sincere, motivation-led letter for a mission-led organisation', standard: 'Warm branded letter for a mission-led organisation', exec_leader: 'Measured tone for a mission-led organisation' },
  academia: { exec_leader: 'Formal, measured letter academic panels expect', ats_pro: 'Formal, measured letter academic panels expect', euro_motivation: 'Formal, measured letter academic panels expect' },
};

/**
 * Deterministic — letters have 7 designs and no AI scoring. The convention region's own formats
 * lead, then the employer type / ATS / register, then career signals (small); every catalogue id is
 * present.
 */
function rankLetterDesigns({
  region = null, seniorityYears = 0, industry = null, companySize = null, isTechnicalRole = false, brandColor = null,
  conventions = null, employerType = null, country = null, website = null,
} = {}) {
  const ids = coverLetterTemplates.TEMPLATE_IDS.slice();
  const brand = hexOrNull(brandColor);
  const ctx = employerContext({ region, conventions, employerType, country, website, companySize, industry, toneText: '', seniorityYears });
  const reg = ctx.region;
  const yrs = ctx.seniorityYears;
  const size = ctx.size;
  const text = ctx.text;
  const typeKey = ctx.type === 'agency' && ctx.creative ? 'agency_creative' : ctx.type;
  const formal = FORMAL_RE.test(text) || ctx.type === 'public_sector';
  const regionRow = (coverLetterTemplates.REGIONS || []).find((r) => r.id === reg);
  const list = regionRow ? regionRow.templates : [];

  const scores = new Map();
  for (const id of ids) {
    const parts = [];
    const add = (pts, why) => { if (pts) parts.push({ pts, why }); };
    const at = list.indexOf(id);
    // A proxy region (Morocco in "eu") still leads with its formats, a little less, without the claim.
    if (at >= 0) add((20 - 5 * at) * (ctx.home ? 1 : 0.6), ctx.home ? (LETTER_REGION_WHY[reg] || '') : '');
    if (id === 'german' && reg !== 'dach') add(-12, '');
    if (id === 'euro_motivation' && reg !== 'eu' && reg !== 'dach') add(-6, '');
    const tp = typeKey && LETTER_TYPE_POINTS[typeKey] ? LETTER_TYPE_POINTS[typeKey][id] : 0;
    if (tp) add(tp * ctx.typeWeight, tp > 0 ? ((LETTER_TYPE_WHY[typeKey] || {})[id] || '') : '');
    if (id === 'ats_pro' && ctx.atsVendor) add(6, `ATS-safe letter that ${ctx.atsVendor} parses cleanly`);
    if (id === 'ats_pro' && formal) add(3, 'Clean, conservative letter for a formal employer');
    if (id === 'standard' && ctx.creative) add(4, 'Branded letter for a creative, brand-led employer');
    if (id === 'ats_pro' && size === 'large' && !ctx.type) add(6, 'ATS-safe letter for a large employer');
    if (id === 'exec_leader') {
      if (yrs >= 12) add(4, 'Leadership tone for 12+ years of experience');
      else if (yrs > 0 && yrs < 3) add(-4, '');
    }
    if (id === 'technical' && (isTechnicalRole || TECH_RE.test(text))) add(isTechnicalRole ? 12 : 5, 'Leads with technical depth for a technical role');
    if (id === 'graduate') { // 0 = unknown years (see ruleScoreFamily), never "a graduate"
      if (yrs > 0 && yrs < 2) add(5, 'Approachable format for an early career');
      else if (yrs >= 8) add(-5, '');
    }
    if (id === 'standard' && brand) add(8, 'Carries the employer’s brand colour');
    const best = parts.filter((p) => p.pts > 0 && p.why).sort((a, b) => b.pts - a.pts)[0];
    scores.set(id, { score: squash(parts.reduce((s, p) => s + p.pts, 0), 30), reason: best ? best.why : '' });
  }

  const ranked = finaliseRanked(ids, scores);
  const top = ranked[0];
  const topName = top ? ((coverLetterTemplates.TEMPLATES.find((t) => t.id === top.id) || {}).name || top.id) : '';
  return {
    v: 1,
    kind: 'cover_letter',
    ranked,
    mode: 'a4', // the letter download lanes default to A4; a letter is one page either way
    brandColor: brand,
    tone: regionRow && reg !== 'generic' ? textOrNull(regionRow.sub, TONE_MAX) : null,
    region: reg,
    headline: top ? textOrNull(top.reason ? `${topName} fits best — ${top.reason}` : `${topName} is the strongest fit for this employer`, HEADLINE_MAX) : null,
    aiFamilies: null, // letters are ranked by rules alone
    conventionsSummary: conventionsSummaryOf(ctx.conv),
  };
}

// ── normaliseDesign ───────────────────────────────────────────────────────────
/**
 * Repair a stored design against TODAY's catalogue: unknown ids dropped (a retired template),
 * duplicates dropped (first wins), missing ids appended with score 0 (a family that shipped after
 * the build), scores clamped, re-sorted, defaults filled. null only when raw is not an object —
 * a broken design is fixable, a missing one is the caller's "compute a rule-only design" signal.
 * aiFamilies (resume only: family ids of today's catalogue, clamped) and conventionsSummary are kept —
 * they are what lets rerankDesign re-rank the design later without the AI.
 */
function normaliseDesign(raw, kind) {
  let obj = raw;
  if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch { return null; } }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  const k = kind === 'resume' || kind === 'cover_letter'
    ? kind
    : (obj.kind === 'resume' || obj.kind === 'cover_letter' ? obj.kind : 'resume');
  const ids = k === 'resume' ? resumeTemplates.TEMPLATE_IDS.slice() : coverLetterTemplates.TEMPLATE_IDS.slice();
  const known = new Set(ids);

  const scores = new Map();
  for (const e of Array.isArray(obj.ranked) ? obj.ranked : []) {
    const id = typeof e === 'string' ? e : (e && typeof e === 'object' ? e.id : null);
    if (typeof id !== 'string' || !known.has(id) || scores.has(id)) continue;
    const entry = e && typeof e === 'object' ? aiEntryOf(e) : null;
    scores.set(id, { score: entry ? entry.score : 0, reason: e && typeof e === 'object' ? shortText(e.reason, REASON_MAX) : '' });
  }

  let aiFamilies = null;
  if (k === 'resume') {
    const ai = aiFamiliesOf(obj.aiFamilies, resumeCatalogue().families);
    // Only exact family keys survive a stored design (aiFamiliesOf also maps variant keys home — harmless here).
    if (ai.size) aiFamilies = Object.fromEntries([...ai.entries()].map(([id, e]) => [id, { score: e.score, reason: e.reason }]));
  }

  return {
    v: 1,
    kind: k,
    ranked: finaliseRanked(ids, scores),
    mode: VALID_MODES.has(obj.mode) ? obj.mode : 'a4',
    brandColor: hexOrNull(obj.brandColor),
    tone: textOrNull(obj.tone, TONE_MAX),
    region: regionOrNull(obj.region),
    headline: textOrNull(obj.headline, HEADLINE_MAX),
    aiFamilies,
    conventionsSummary: textOrNull(obj.conventionsSummary, SUMMARY_MAX),
  };
}

// ── rerankDesign ──────────────────────────────────────────────────────────────
/**
 * A stored design re-ranked against what is known NOW (new conventions, a region the build did not
 * have, today's rules) — no AI: the stored aiFamilies stand in for the model's scores. Returns a
 * normalised Design (every invariant holds). A design stored before aiFamilies existed re-ranks on
 * rules alone.
 *
 * Region: an explicit valid `region`; else the chain over the `country` / `website` the caller
 * re-supplies; else the stored region when it is not 'generic'; else what the conventions imply.
 * The stored headline and tone are kept only while the same design / family still leads — they
 * name it.
 */
function rerankDesign(design, {
  conventions = null, region = null, brandColor, companySize = null, industry = null, seniorityYears = 0,
  kind = null, employerType = null, country = null, website = null, isTechnicalRole = false,
} = {}) {
  const k = kind === 'resume' || kind === 'cover_letter'
    ? kind
    : (design && typeof design === 'object' && design.kind === 'cover_letter' ? 'cover_letter' : 'resume');
  const stored = normaliseDesign(design, k);
  const conv = conventionsOf(conventions); // for the region only — the rankers read `conventions` themselves
  const suppliedPlace = (typeof country === 'string' && country.trim()) || (typeof website === 'string' && website.trim());
  const hinted = suppliedPlace || conv ? regionFor({ country, website, conventions: conv }) : 'generic';
  const reg = regionOrNull(region)
    || (suppliedPlace && hinted !== 'generic' ? hinted : null)
    || (stored && stored.region && stored.region !== 'generic' ? stored.region : null)
    || hinted;
  const brand = brandColor === undefined ? (stored ? stored.brandColor : null) : hexOrNull(brandColor);

  if (k === 'cover_letter') {
    return normaliseDesign(rankLetterDesigns({
      region: reg, seniorityYears, industry, companySize, isTechnicalRole, brandColor: brand,
      conventions, employerType, country, website,
    }), 'cover_letter');
  }

  const next = rankResumeDesigns({
    aiFamilyScores: stored ? stored.aiFamilies : null,
    region: reg, brandColor: brand, companySize, industry, seniorityYears,
    mode: stored ? stored.mode : null, // the build's page mode stands unless the research now says otherwise
    tone: null, headline: null, // a stored tone fed back as input would vote for the family it describes
    conventions, employerType, country, website,
  });
  if (stored && stored.ranked[0] && next.ranked[0]) {
    const familyOf = (id) => (resumeTemplates.TEMPLATES.find((t) => t.id === id) || {}).family || id;
    if (stored.ranked[0].id === next.ranked[0].id && stored.headline) next.headline = stored.headline;
    if (familyOf(stored.ranked[0].id) === familyOf(next.ranked[0].id) && stored.tone) next.tone = stored.tone;
  }
  return normaliseDesign(next, 'resume');
}

module.exports = {
  resumeFamilyBrief,
  seniorityYearsOf,
  regionFor,
  rankResumeDesigns,
  rankLetterDesigns,
  normaliseDesign,
  rerankDesign,
  // exposed for tests / diagnostics only
  _internals: {
    sizeClassOf, colourDistance, ruleScoreFamily, resumeCatalogue, FAMILY_META,
    conventionsOf, conventionsSummaryOf, employerContext, inferEmployerType, TYPE_POINTS, LETTER_TYPE_POINTS,
  },
};
