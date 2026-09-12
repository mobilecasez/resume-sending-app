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
// for a US bank. Blend = round(0.6·ai + 0.4·rule) only where the AI actually scored a family;
// everything else is rule-only, so a null/garbled AI answer still yields a complete, sane ranking.
//
// ⚠️ PURE AND SYNCHRONOUS. No DB, no network, no AI: it runs on the doc lane after the charge, on
// the GET /employer-docs read path for rows that predate designs, and in unit tests. Keep it that
// way — a design that needed I/O would be a new way for a paid build to fail after charging.
'use strict';

const resumeTemplates = require('../utils/resumeTemplates');
const coverLetterTemplates = require('../utils/coverLetterTemplates');
const { regionFromCountry, regionFromTld } = require('../utils/regionFromCountry');

const VALID_REGIONS = new Set(['generic', 'us_ca', 'uk_au', 'india', 'dach', 'eu', 'sg']);
const VALID_MODES = new Set(['a4', 'onepage']);
const HEX_RE = /^#[0-9a-f]{6}$/i;

const REASON_MAX = 90;
const TONE_MAX = 40;
const HEADLINE_MAX = 120;

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

// ── Resume family metadata ────────────────────────────────────────────────────
// Inferred from each builder's CSS in resumeTemplates.js (keep in sync when a family's layout
// changes). `ats` here is only the fallback: the catalogue's own `ats` wins when it declares one.
//
// ⚠️ `photo` is "has a photo/avatar slot", which is NOT the catalogue's `photo` flag: azure,
// executive and minimal predate that flag but every one of them renders a round avatar (initials
// when no photo). For "should a US resume carry a face" they are photo layouts.
//
// ⚠️ `regional` marks families whose NAME says a country (India Professional, Germany Professional,
// Europass). Offered to an employer outside those regions they read as a mistake, not a style.
const FAMILY_META = {
  azure:     { layout: 'sidebar',       photo: true,  ats: 3, tone: 'colourful left sidebar, skill bars, modern',              short: 'Modern and colourful' },
  executive: { layout: 'sidebar',       photo: true,  ats: 3, tone: 'dark slate sidebar with gold accents, premium',           short: 'Premium and dark' },
  minimal:   { layout: 'two-column',    photo: true,  ats: 3, tone: 'clean header, main column + skills column with chips',    short: 'Clean and modern' },
  ats:       { layout: 'single column', photo: false, ats: 5, tone: 'plain black-and-white, maximally parseable',              short: 'Plain and ATS-first' },
  exec_pro:  { layout: 'single column', photo: false, ats: 5, tone: 'centred name, gold rules, senior leadership',             short: 'Senior and understated' },
  india:     { layout: 'single column', photo: false, ats: 4, tone: 'skills chips and projects up front, technical',           short: 'Skills-led and technical', regional: true },
  germany:   { layout: 'single column', photo: true,  ats: 4, tone: 'formal Lebenslauf: photo, personal details, signature',    short: 'Formal German CV', regional: true },
  europass:  { layout: 'single column', photo: true,  ats: 4, tone: 'European standard: blue photo header, language bars',     short: 'European standard', regional: true },
  startup:   { layout: 'single column', photo: false, ats: 4, tone: 'airy product-company look, links first',                  short: 'Airy startup look' },
  banner:    { layout: 'single column', photo: true,  ats: 4, tone: 'full-width colour banner header, marketing-forward',       short: 'Bold and marketing-forward' },
  rightrail: { layout: 'sidebar',       photo: true,  ats: 3, tone: 'main column with a tinted right rail, contemporary',      short: 'Contemporary and structured' },
  mono:      { layout: 'single column', photo: false, ats: 5, tone: 'monospace terminal accents, engineering',                 short: 'Engineering and technical' },
  elegant:   { layout: 'single column', photo: false, ats: 4, tone: 'serif typography with small caps, classic and refined',   short: 'Classic serif' },
  compact:   { layout: 'two-column',    photo: false, ats: 4, tone: 'dense two-column page that fits a lot on one page',      short: 'Dense and efficient' },
  timeline:  { layout: 'single column', photo: true,  ats: 4, tone: 'date-rail timeline telling a career story',               short: 'Story-led timeline' },
};

const EXEC_FAMILIES = new Set(['executive', 'exec_pro']);
const EARLY_FAMILIES = new Set(['compact', 'startup']);
const CREATIVE_FAMILIES = new Set(['banner', 'rightrail', 'timeline', 'startup']);
const FORMAL_FAMILIES = new Set(['ats', 'exec_pro', 'elegant', 'minimal']);
const TECH_FAMILIES = new Set(['mono', 'startup', 'compact']);

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
 * ⚠️ Both helpers return the TRUTHY string 'generic' on no match, so a plain `a || b` would never
 * reach the TLD fallback. 'generic' is treated as "no answer" at each step.
 */
function regionFor({ country, website } = {}) {
  const byCountry = regionFromCountry(typeof country === 'string' ? country : '');
  if (byCountry && byCountry !== 'generic' && VALID_REGIONS.has(byCountry)) return byCountry;
  const byTld = regionFromTld(typeof website === 'string' ? website : '');
  if (byTld && byTld !== 'generic' && VALID_REGIONS.has(byTld)) return byTld;
  return 'generic';
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

const CREATIVE_RE = /\b(design|creative|media|marketing|advertis\w*|agency|fashion|entertainment|gaming|games|film|music|arts?|publishing|content|social media|e-?commerce|retail|consumer|hospitality|travel|beauty|lifestyle|bold|playful|vibrant)\b/;
const FORMAL_RE = /\b(bank\w*|finance|financial|insurance|legal|law|attorneys?|government|public sector|federal|ministry|municipal\w*|accounting|audit\w*|tax|investment|asset management|wealth|compliance|regulat\w*|defen[cs]e|conservative|formal|traditional)\b/;
const TECH_RE = /\b(software|saas|developer\w*|engineering|cloud|data|ai|machine learning|cyber\w*|security|devops|it services|technology|tech|platform|semiconductor\w*|telecom\w*|fintech|internet|technical)\b/;
const STARTUP_RE = /\b(startup|start-up|scale-?up|fast-paced|scrappy|seed|series [a-c])\b/;
const PREMIUM_RE = /\b(luxury|premium|elegant|prestig\w*|academ\w*|universit\w*|museum|research institute)\b/;

// ── Resume rule score ─────────────────────────────────────────────────────────
/**
 * 0..100 rule score for one family plus the strongest positive reason (user-facing, ≤ 90 chars).
 * Each contribution carries its own sentence so the card can say WHY it ranks, not just a number.
 */
function ruleScoreFamily(f, ctx) {
  const parts = [];
  const add = (pts, why) => { if (pts) parts.push({ pts, why }); };

  // ATS weight: heavier where screening software is near-universal.
  const heavyAts = ctx.size === 'large' || ctx.region === 'us_ca' || ctx.region === 'uk_au' || ctx.region === 'india';
  const atsPts = (f.ats - 3) * (heavyAts ? 8 : 4);
  add(atsPts, f.ats >= 5
    ? (ctx.size === 'large' ? 'ATS-safe layout that large employers screen reliably' : 'Parses cleanly in applicant tracking systems')
    : f.ats >= 4 ? 'Reads well in applicant tracking systems' : '');

  // Region: membership of that region's curated families (earlier = more typical there).
  const regionRow = (resumeTemplates.REGIONS || []).find((r) => r.id === ctx.region);
  const list = regionRow ? regionRow.templates : [];
  const at = list.indexOf(f.id);
  if (at >= 0) {
    add(ctx.region === 'generic' ? 10 - 2 * at : 18 - 3 * at,
      ctx.region === 'generic' ? 'A well-proven all-round format' : `A standard format in ${REGION_LABEL[ctx.region]}`);
  } else if (f.regional && ctx.region !== 'generic') {
    add(-10, '');
  }

  // Photo conventions.
  if (f.photo) {
    if (ctx.region === 'us_ca' || ctx.region === 'uk_au') add(-14, '');
    else if (ctx.region === 'dach') add(12, 'A photo CV is expected in German-speaking countries');
    else if (ctx.region === 'eu') add(8, 'Photo CVs are common with European employers');
  }

  // Seniority. ⚠️ 0 means UNKNOWN (seniorityYearsOf found no dates), not "no experience": the
  // early-career lift and its user-facing "for an early career" reason only apply to a known
  // 0 < years < 3, or every resume with unparseable dates would be told it is junior.
  const yrs = ctx.seniorityYears;
  if (EXEC_FAMILIES.has(f.id)) {
    if (yrs >= 12) add(12, 'Leadership format for 12+ years of experience');
    else if (yrs >= 8) add(5, 'Senior format for a seasoned career');
    else if (yrs > 0 && yrs < 3) add(-8, '');
  }
  if (f.id === 'elegant' && yrs >= 12) add(4, 'Understated classic look for a senior career');
  if (EARLY_FAMILIES.has(f.id) && yrs > 0 && yrs < 3) add(10, f.id === 'compact' ? 'Compact one-pager for an early career' : 'Fresh, modern look for an early career');

  // Industry / tone keywords.
  const text = ctx.text;
  if (text) {
    if (CREATIVE_RE.test(text) && CREATIVE_FAMILIES.has(f.id)) add(10, 'Visual layout suits a creative, brand-led employer');
    if (FORMAL_RE.test(text) && FORMAL_FAMILIES.has(f.id)) add(10, 'Conservative look for finance, legal or government');
    if (TECH_RE.test(text) && TECH_FAMILIES.has(f.id)) add(f.id === 'mono' ? 10 : 4, f.id === 'mono' ? 'Engineering-style layout for a tech employer' : 'Modern layout that suits a tech employer');
    if (PREMIUM_RE.test(text) && (f.id === 'elegant' || f.id === 'executive')) add(6, 'Refined look for a prestige employer');
  }
  if ((ctx.size === 'small' || STARTUP_RE.test(text)) && f.id === 'startup') add(6, 'Modern look startups respond to');

  const score = clampInt(55 + parts.reduce((s, p) => s + p.pts, 0));
  const best = parts.filter((p) => p.pts > 0 && p.why).sort((a, b) => b.pts - a.pts)[0];
  return { score, reason: best ? shortText(best.why, REASON_MAX) : '' };
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

function rankResumeDesigns({
  aiFamilyScores = null, region = 'generic', brandColor = null, companySize = null, industry = null,
  seniorityYears = 0, mode = null, tone = null, headline = null,
} = {}) {
  const { families, ids } = resumeCatalogue();
  const reg = regionOrNull(region) || 'generic';
  const brand = hexOrNull(brandColor);
  const yrs = Number.isFinite(Number(seniorityYears)) ? Math.max(0, Number(seniorityYears)) : 0;
  const toneText = shortText(tone, TONE_MAX);
  const ctx = {
    region: reg,
    size: sizeClassOf(companySize),
    seniorityYears: yrs,
    text: [industry, toneText, companySize].filter((x) => typeof x === 'string').join(' ').toLowerCase(),
  };

  // The AI may key by family id or (wrongly) by a variant id — map the latter home once.
  const ai = new Map();
  if (aiFamilyScores && typeof aiFamilyScores === 'object' && !Array.isArray(aiFamilyScores)) {
    const familyOfId = new Map();
    for (const f of families) for (const m of f.members) familyOfId.set(m.id, f.id);
    for (const [k, v] of Object.entries(aiFamilyScores)) {
      const fam = families.some((f) => f.id === k) ? k : familyOfId.get(k);
      const entry = aiEntryOf(v);
      if (!fam || !entry) continue;
      if (ai.has(fam) && fam !== k) continue; // an exact family key beats a variant-keyed guess
      ai.set(fam, entry);
    }
  }

  const scores = new Map();
  const familyResults = [];
  for (const f of families) {
    const rule = ruleScoreFamily(f, ctx);
    const a = ai.get(f.id);
    const famScore = a ? clampInt(0.6 * a.score + 0.4 * rule.score) : rule.score;
    const reason = (a && a.reason) || rule.reason;
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

  const modeOut = VALID_MODES.has(mode)
    ? mode
    : (yrs < 8 && ['us_ca', 'uk_au', 'sg', 'india'].includes(reg) ? 'onepage' : 'a4');

  const headlineOut = shortText(headline, HEADLINE_MAX)
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

/**
 * Deterministic — letters have 7 designs and no AI scoring. Region order leads, then career
 * signals; every catalogue id is present.
 */
function rankLetterDesigns({
  region = 'generic', seniorityYears = 0, industry = null, companySize = null, isTechnicalRole = false, brandColor = null,
} = {}) {
  const ids = coverLetterTemplates.TEMPLATE_IDS.slice();
  const reg = regionOrNull(region) || 'generic';
  const brand = hexOrNull(brandColor);
  const yrs = Number.isFinite(Number(seniorityYears)) ? Math.max(0, Number(seniorityYears)) : 0;
  const size = sizeClassOf(companySize);
  const text = String(industry || '').toLowerCase();
  const regionRow = (coverLetterTemplates.REGIONS || []).find((r) => r.id === reg);
  const list = regionRow ? regionRow.templates : [];

  const scores = new Map();
  for (const id of ids) {
    const parts = [];
    const add = (pts, why) => { if (pts) parts.push({ pts, why }); };
    const at = list.indexOf(id);
    if (at >= 0) add(30 - 6 * at, LETTER_REGION_WHY[reg] || '');
    if (id === 'german' && reg !== 'dach') add(-12, '');
    if (id === 'euro_motivation' && reg !== 'eu' && reg !== 'dach') add(-6, '');
    if (id === 'exec_leader') {
      if (yrs >= 12) add(12, 'Leadership tone for 12+ years of experience');
      else if (yrs > 0 && yrs < 3) add(-8, '');
    }
    if (id === 'technical' && (isTechnicalRole || TECH_RE.test(text))) add(isTechnicalRole ? 12 : 5, 'Leads with technical depth for a technical role');
    if (id === 'graduate') { // 0 = unknown years (see ruleScoreFamily), never "a graduate"
      if (yrs > 0 && yrs < 2) add(10, 'Approachable format for an early career');
      else if (yrs >= 8) add(-10, '');
    }
    if (id === 'ats_pro' && size === 'large') add(10, 'ATS-safe letter for a large employer');
    if (id === 'ats_pro' && FORMAL_RE.test(text)) add(4, 'Clean, conservative letter for a formal employer');
    if (id === 'standard' && brand) add(8, 'Carries the employer’s brand colour');
    const best = parts.filter((p) => p.pts > 0 && p.why).sort((a, b) => b.pts - a.pts)[0];
    scores.set(id, { score: 55 + parts.reduce((s, p) => s + p.pts, 0), reason: best ? best.why : '' });
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
  };
}

// ── normaliseDesign ───────────────────────────────────────────────────────────
/**
 * Repair a stored design against TODAY's catalogue: unknown ids dropped (a retired template),
 * duplicates dropped (first wins), missing ids appended with score 0 (a family that shipped after
 * the build), scores clamped, re-sorted, defaults filled. null only when raw is not an object —
 * a broken design is fixable, a missing one is the caller's "compute a rule-only design" signal.
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

  return {
    v: 1,
    kind: k,
    ranked: finaliseRanked(ids, scores),
    mode: VALID_MODES.has(obj.mode) ? obj.mode : 'a4',
    brandColor: hexOrNull(obj.brandColor),
    tone: textOrNull(obj.tone, TONE_MAX),
    region: regionOrNull(obj.region),
    headline: textOrNull(obj.headline, HEADLINE_MAX),
  };
}

module.exports = {
  resumeFamilyBrief,
  seniorityYearsOf,
  regionFor,
  rankResumeDesigns,
  rankLetterDesigns,
  normaliseDesign,
  // exposed for tests / diagnostics only
  _internals: { sizeClassOf, colourDistance, ruleScoreFamily, resumeCatalogue, FAMILY_META },
};
