// Web research about an employer, cached per domain, for grounding the employer-tailored resume and
// cover letter (what the company does, its stack, its tone, its brand colour — and, since 2026-09-14,
// HOW IT HIRES: its country's CV conventions, its employer type, the applicant tracking system in its
// apply flow).
//
// WHY THIS EXISTS: "rewrite my resume for Amazon" is only better than a generic rewrite if the model
// knows what Amazon cares about. ai-employer-researcher.js already does that with one grounded
// Gemini call, but it is ~10-25 s and real money, and the answer is about the COMPANY, not the user:
// the same research serves every user who tailors for that domain. So it is cached globally by
// domain in employer_research_cache (Migration 046) for 30 days.
//
// WHY CONVENTIONS: prod ranked one design family first for a Swiss SME, a Moroccan public agency and a
// Ghanaian job site alike. The design order and the resume's format must come from the employer: where
// it hires and what CVs look like there (photo, length, personal details, tabular vs profile-led vs
// Europass), whether it is a ministry or a startup, whether an ATS reads the CV first. That is ONE more
// grounded call (researchConventions), run IN PARALLEL with the researcher so a fresh employer waits for
// the slower of the two, not their sum, and stored in the SAME cache row under `conventions` (no
// migration). A cached row from before this carries none: they are fetched onto it the first time it
// is read, and merged into the row without touching its fetched_at (the base facts do not get younger).
//
// WHY THE BRAND (2026-09-15): "the resume looks exactly the same for every employer". The researcher's
// brand_color / font_name are a model's recollection of a website, null more often than not. The
// employer's website STATES its colours and fonts — theme-color, its --brand custom properties, the colour
// it paints backgrounds with, the font on <body>, the Google Fonts it loads — and brandExtract.js reads
// them deterministically, SSRF-safe, under its own 8 s bound. The Brand lives in the SAME row under `brand`
// with its own `brandAt` stamp (30-day TTL, merged like the conventions — no migration) and rides on the
// flight as a THIRD STAGE that `full` never waits for: the base write and the conventions land exactly
// when they did before the brand existed, and getEmployerResearch folds the brand into the caller's copy
// within what is left of the caller's time. Only a FOUND brand is written to the row (a null is mostly
// the network's — a timeout, a 403 for non-browsers — and is remembered in memory for an hour instead).
// brandOf(research) is what the renderers paint with: the website's brand first, the researcher's second.
// EMPLOYER_BRAND_EXTRACT=off switches the website read off; every build then paints the usual way.
//
// ⚠️ RESEARCH IS OPTIONAL GROUNDING, NEVER A DEPENDENCY. getEmployerResearch NEVER throws and
// answers null on every failure (no website, DB down, table missing, AI error, timeout). The doc
// lane has already passed the billing gate when it calls this; a research failure that failed the
// build would be a paid build lost to a nice-to-have. Null = "write it from the resume alone";
// conventions: null = "no hiring conventions known" (designFit then uses the country's general habits).
//
// ⚠️ THE RESEARCH IS UNTRUSTED TEXT. It is a model's summary of arbitrary web pages. It is
// sanitised before it is cached or returned (key_contacts dropped — personal names of real people
// have no place in a resume prompt or a shared cache; every list and string capped; whitespace
// collapsed; "===" runs removed so a scraped string cannot fake a prompt section header), and
// researchPromptBlock labels it "may be incomplete or wrong" with hard rules that nothing in it may
// enter the candidate's resume as a claim. Conventions are sanitised harder still: enums only for every
// judgement, countries only when they are real countries, notes stripped of anything that looks like a
// person or a contact, sources only https URLs the grounded search actually returned.
//
// ⚠️ THE CACHE HOLDS ONLY WHAT THE RESEARCHER SAID. Nothing a requester typed (their company name, the
// chip's country) is ever written to employer_research_cache or put into either research prompt — the
// cache is shared by every user of that domain. The requester's name is applied per request, on a copy
// (withDisplayName); the requester's country picks the region per request (regionForConventions).
//
// ⚠️ DO NOT MODIFY ai-employer-researcher.js FROM HERE. The cover letter lane shares it and its
// output shape is also written by that lane into its own tables.
'use strict';

const regionUtil = require('../utils/regionFromCountry');
const brandExtract = require('./brandExtract');

/**
 * Folded into every employer document's fingerprint. ⚠️ Conventions did NOT bump it: a bump re-labels
 * every stored resume and letter "stale" and bills a Refresh for research the user never asked about.
 * The documents built from here on use the conventions; a document built before stays valid. The brand
 * (2026-09-15) did not bump it either: a document without one is simply painted the usual way.
 */
const RESEARCH_REV = 'r1';

const TTL_DAYS = 30;
const FAIL_MEMORY_MS = 60 * 60 * 1000; // a failed domain is not retried for 1 hour (no retry storm)
const STR_MAX = 400;

/** ⚠️ ≤ 48 chars, like every model id this codebase stores. */
const CONVENTIONS_MODEL = 'gemini-2.5-flash';
/** How long a flight waits for the conventions call (contract: 25 s). The call itself keeps going. */
const CONVENTIONS_WAIT_MS = 25000;
/** The hard stop for a call nobody waits for any more (a hung socket must not live forever). */
const CONVENTIONS_HARD_TIMEOUT_MS = 90000;
/** How long a build waits for the website read (brandExtract bounds itself to this) plus a grace for the row write. */
const BRAND_WAIT_MS = 8000;
const BRAND_GRACE_MS = 1000;
/** The Google Fonts yes/no for a family the RESEARCHER named (brandExtract remembers the answer for a day). */
const FONT_CHECK_MS = 3000;

// ── domainKeyOf ───────────────────────────────────────────────────────────────
/**
 * 'https://www.Amazon.jobs:443/en/' → 'amazon.jobs'. null when the input is not a host or URL
 * (empty, an email address, a bare word like "localhost", an IP address, spaces).
 */
function domainKeyOf(website) {
  if (typeof website !== 'string') return null;
  let s = website.trim();
  if (!s || s.length > 2048 || /\s/.test(s)) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  if (!hasScheme && s.includes('@')) return null; // an email, not a website
  if (!hasScheme) s = 'https://' + s.replace(/^\/+/, '');
  let host;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    host = u.hostname;
  } catch {
    return null;
  }
  host = String(host || '').toLowerCase().replace(/\.+$/, '').replace(/^www\./, '');
  if (!host || host.length > 253 || !host.includes('.')) return null;
  if (!/^[a-z0-9.-]+$/.test(host)) return null; // URL() punycodes IDNs, so this admits them too
  if (/^\d+(\.\d+){3}$/.test(host)) return null; // IPv4 — nothing to research
  const tld = host.split('.').pop();
  if (!/^(xn--[a-z0-9-]+|[a-z]{2,63})$/.test(tld)) return null;
  if (host.split('.').some((label) => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'))) return null;
  return host;
}

// ── Sanitising ────────────────────────────────────────────────────────────────
function cleanStr(v, max = STR_MAX) {
  if (v == null) return '';
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  return String(v)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/={3,}/g, '—')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

/** Names from [{name}] / [{client_name}] / ['x'], de-duplicated case-insensitively, capped. */
function namesOf(list, keys, maxItems, maxLen = STR_MAX) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    let v = '';
    if (typeof item === 'string') v = item;
    else if (item && typeof item === 'object') { for (const k of keys) { if (typeof item[k] === 'string' && item[k].trim()) { v = item[k]; break; } } }
    const s = cleanStr(v, maxLen);
    const key = s.toLowerCase();
    if (!s || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

/**
 * ⚠️ THE RESEARCHER INVENTS DEFAULTS. ai-employer-researcher.js writes brand_color '#262633' and
 * font_name 'Lato' when it could not find the real ones. Cached as facts, '#262633' would pull every
 * unknown employer's resume towards the charcoal colour variants and make the letter lane think a
 * brand colour is known. Those exact fallback values mean "unknown" and are stored as null.
 */
const RESEARCHER_DEFAULT_COLOR = '#262633';
const RESEARCHER_DEFAULT_FONT = 'lato';

// ── Brand sanitising ──────────────────────────────────────────────────────────
// The brand is what brandExtract read off the employer's own website (see that module's header). It is
// cached in the same shared row under `brand` with its own `brandAt` stamp and 30-day TTL, so it is
// sanitised like everything else that comes out of the row: two hex colours, one font family of plain
// characters (it goes into a CSS font stack and a Google Fonts URL), the provenance enums, a timestamp.
const BRAND_PRIMARY_FROM = new Set(['theme-color', 'css-var', 'frequency']);
/** 'researcher' is not a website source: the model's fontName, laid over a caller's COPY by withResearcherFont. */
const BRAND_FONT_FROM = new Set(['body', 'frequency', 'google-link', 'researcher']);

function hexOrNull(v) {
  const s = cleanStr(v, 7).toLowerCase();
  return /^#[0-9a-f]{6}$/.test(s) ? s : null;
}

/** A font family safe for a CSS stack and a URL: letters, digits, spaces, . ' _ - ; 2–80 chars; else null. */
function familyOf(v) {
  const s = cleanStr(v, 80).replace(/^["']+|["']+$/g, '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9 .'_-]{1,79}$/.test(s) ? s : null;
}

/** Any brand-shaped object (fresh from brandExtract, or a cached row's) → Brand | null (null when it names neither a colour nor a font). */
function sanitiseBrand(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const primary = hexOrNull(raw.primary);
  const secondary = hexOrNull(raw.secondary);
  const fontRaw = raw.font && typeof raw.font === 'object' && !Array.isArray(raw.font) ? raw.font : null;
  const family = fontRaw ? familyOf(fontRaw.family) : null;
  const font = family ? { family, google: fontRaw.google === true } : null;
  if (!primary && !font) return null;
  const from = raw.from && typeof raw.from === 'object' && !Array.isArray(raw.from) ? raw.from : {};
  const t = typeof raw.fetchedAt === 'string' ? Date.parse(raw.fetchedAt) : NaN;
  return {
    primary,
    secondary: secondary && secondary !== primary ? secondary : null,
    font,
    from: {
      primary: primary && BRAND_PRIMARY_FROM.has(from.primary) ? from.primary : null,
      font: font && BRAND_FONT_FROM.has(from.font) ? from.font : null,
    },
    fetchedAt: Number.isFinite(t) ? new Date(t).toISOString() : new Date().toISOString(),
  };
}

// ── Conventions sanitising ────────────────────────────────────────────────────
const EMPLOYER_TYPES = new Set(['public_sector', 'enterprise', 'sme', 'startup', 'agency', 'ngo', 'academia', 'other']);
const PHOTO_VALUES = new Set(['expected', 'optional', 'avoid']);
const LENGTH_VALUES = new Set(['one_page', 'two_pages', 'flexible']);
const DETAILS_VALUES = new Set(['include', 'avoid']);
const FORMAT_VALUES = new Set(['tabular', 'narrative', 'europass', 'ats_plain']);

// A model asked for an enum still writes "Public sector", "1-2 pages", "Not expected". Ordered: the
// first matching pattern wins, so the more specific reading goes first ("not required" is optional,
// not "required"; a public university is academia).
const TYPE_SYNONYMS = [
  [/universit|academ|research institute|college|school/i, 'academia'],
  [/non-?profit|not-for-profit|\bngo\b|charit|humanitarian|international organi[sz]ation/i, 'ngo'],
  [/start-?up|scale-?up/i, 'startup'],
  // ⚠️ public_sector BEFORE agency: "Government agency" / "public employment agency" (a Moroccan public agency was
  // the prod case) is the public sector, not a recruitment agency. "Public relations agency" is still an agency.
  [/public(?! relations)|government|ministry|municipal|civil service|state administration/i, 'public_sector'],
  [/agency|recruit|staffing|job ?board|job site|headhunt/i, 'agency'],
  [/enterprise|corporat|multinational|large company|conglomerate/i, 'enterprise'],
  [/\bsmes?\b|\bsmb\b|small|medium|mid-?size/i, 'sme'],
];
const PHOTO_SYNONYMS = [
  [/optional|not required|not mandatory|either way|sometimes|varies|acceptable|common but/i, 'optional'],
  [/avoid|discourag|not (expected|recommended|common|usual|customary)|uncommon|unusual|no photo|never|prohibit|illegal|^no$/i, 'avoid'],
  [/expected|required|mandatory|customary|usual|standard|common|^yes$/i, 'expected'],
];
const LENGTH_SYNONYMS = [
  [/flexib|varies|no (strict )?limit|any length|2\s*[-–to]+\s*3|three|3\+? pages/i, 'flexible'],
  [/two[\s_-]*pages?|2[\s-]*pages?|1\s*[-–]\s*2|one to two|up to two/i, 'two_pages'],
  [/one[\s_-]*page|1[\s-]*page|single page/i, 'one_page'],
];
const DETAILS_SYNONYMS = [
  [/avoid|omit|exclude|discourag|not (expected|included|required|recommended|common)|illegal|^no$/i, 'avoid'],
  [/include|expected|common|usual|customary|required|^yes$/i, 'include'],
];
const FORMAT_SYNONYMS = [
  [/europass/i, 'europass'],
  [/tabular|table|lebenslauf|rirekisho/i, 'tabular'],
  [/\bats\b|plain|machine|parse/i, 'ats_plain'],
  [/narrative|profile|chronolog|summary|achievement/i, 'narrative'],
];

function enumOf(v, allowed, synonyms) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > 120) return null;
  const key = s.toLowerCase().replace(/[\s-]+/g, '_');
  if (allowed.has(key)) return key;
  if (/^(null|none|unknown|n\/?a|not (known|found|specified|available))$/i.test(s)) return null;
  for (const [re, value] of synonyms) if (re.test(s)) return value;
  return null;
}

/** A real country's canonical English name, or null ("Remote", "Global", "EMEA" are not countries). */
function countryNameOf(v) {
  if (typeof v !== 'string' || !v.trim() || v.length > 80) return null;
  const c = regionUtil.countryOf(v);
  return c ? c.name : null;
}

/**
 * Contact-shaped or person-shaped text: never cached, never prompted. Deliberately eager — a dropped
 * note costs nothing, a real person's name in every user's prompt costs trust.
 *   an email / link · a phone number (9+ digits; a "2015-2024" range is not one) · "Mr. Smith" ·
 *   a role word followed by a Capitalised Name ("contact Hans Muster", "CEO Jane Doe").
 */
const CONTACT_RE = /@|https?:\/\/|www\./i;
const PHONE_RE = /\+?\(?\d[\d\s().-]{6,}\d/g;
const HONORIFIC_RE = /\b(Mr|Mrs|Ms|Dr|Prof)\.?\s+[A-Z]/;
const ROLE_WORD_RE = /\b(contact|recruiter|hiring manager|talent (acquisition|partner)|hr (manager|business partner|director)|head of|ceo|cto|founder|director|manager)\b/gi;
function looksPersonal(s) {
  const text = String(s || '');
  if (CONTACT_RE.test(text) || HONORIFIC_RE.test(text)) return true;
  for (const m of text.matchAll(PHONE_RE)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 9 && !/^\d{4}\s*[-–]\s*\d{4}$/.test(m[0].trim())) return true;
  }
  for (const m of text.matchAll(ROLE_WORD_RE)) {
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 48).split('.')[0];
    if (/(^|[\s,:;(])[A-Z][a-z]+ [A-Z][a-z]+/.test(after)) return true; // case-sensitive on purpose
  }
  return false;
}

/** A short descriptive phrase (sector, tone): no links, contacts or people; null when empty. */
function phraseOf(v, max) {
  const s = cleanStr(v, max);
  if (!s || s.length < 2 || looksPersonal(s)) return null;
  if (/^(null|none|unknown|n\/?a|not (known|found|specified|available))$/i.test(s)) return null;
  return s;
}

// Known applicant tracking systems, by what their apply links and names look like.
const ATS_VENDORS = [
  ['Workday', /\bworkday\b|myworkdayjobs/i], ['SAP SuccessFactors', /success\s*factors/i], ['Oracle Taleo', /\btaleo\b/i],
  ['Oracle Recruiting Cloud', /oracle\s+(recruiting|hcm|cloud|fusion)/i], ['Greenhouse', /\bgreenhouse\b/i], ['Lever', /\blever\b/i],
  ['iCIMS', /\bicims\b/i], ['SmartRecruiters', /smart\s*recruiters/i], ['Workable', /\bworkable\b/i], ['BambooHR', /bamboo\s*hr/i],
  ['Jobvite', /\bjobvite\b/i], ['Personio', /\bpersonio\b/i], ['Recruitee', /\brecruitee\b/i], ['Teamtailor', /team\s*tailor/i],
  ['JazzHR', /jazz\s*hr/i], ['Ashby', /\bashby(hq)?\b/i], ['Bullhorn', /\bbullhorn\b/i], ['Avature', /\bavature\b/i],
  ['Cornerstone OnDemand', /\bcornerstone\b|csod/i], ['UKG', /\bukg\b|ultipro/i], ['ADP', /\badp\b/i], ['softgarden', /soft\s*garden/i],
  ['d.vinci', /d\.?\s*vinci/i], ['rexx systems', /\brexx\b/i], ['Umantis', /\bumantis\b/i], ['Pinpoint', /\bpinpoint(hq)?\b/i],
  ['Breezy HR', /\bbreezy\b/i], ['Zoho Recruit', /zoho\s*recruit/i], ['PageUp', /\bpage\s*up\b/i], ['Oleeo', /\boleeo\b/i],
  ['Tribepad', /\btribepad\b/i], ['Eightfold', /\beightfold\b/i], ['Phenom', /\bphenom\b/i], ['Dayforce', /dayforce|ceridian/i],
  ['Paylocity', /\bpaylocity\b/i], ['ClearCompany', /clear\s*company|hrmdirect/i], ['Welcome to the Jungle', /welcome to the jungle|welcomekit/i],
  ['Talentsoft', /talent\s*soft/i], ['JOIN', /\bjoin\.com\b/i], ['Manatal', /\bmanatal\b/i], ['Freshteam', /\bfreshteam\b/i],
  ['Comeet', /\bcomeet\b/i], ['Jobylon', /\bjobylon\b/i], ['HireHive', /\bhirehive\b/i], ['Beamery', /\bbeamery\b/i],
  ['Radancy', /\bradancy\b|talentbrew/i], ['IBM Kenexa BrassRing', /\bkenexa\b|brassring/i], ['PeopleFluent', /peoplefluent/i],
];
function atsVendorOf(v) {
  const s = cleanStr(v, 80);
  if (!s || looksPersonal(s)) return null;
  const known = ATS_VENDORS.find(([, re]) => re.test(s));
  if (known) return known[0];
  // "none", "email", "its own careers site" are answers, not a vendor.
  if (/^(null|none|unknown|n\/?a|not (known|found|specified|available))$/i.test(s)
    || /\b(e-?mail|in-?house|internal|custom|proprietary|own (portal|site|website)|careers? (page|site|portal)|direct|website|linkedin)\b/i.test(s)) return null;
  return /^[A-Za-z0-9][A-Za-z0-9 .&+'’-]{1,39}$/.test(s) && s.split(/\s+/).length <= 4 ? s : null;
}

/** "MM/YYYY", "DD.MM.YYYY", "Month YYYY" — a date pattern, nothing else. */
function dateFormatOf(v) {
  const s = cleanStr(v, 24);
  if (!s || s.length > 20) return null;
  return /^(?:DD?|MM?|MMM|YYYY|YY|Month|Mon)(?:[\s./–-]+(?:DD?|MM?|MMM|YYYY|YY|Month|Mon))*$/i.test(s) ? s : null;
}

/** An https URL safe to store: no credentials, no fragment, ≤ 300 chars; null otherwise. */
function httpsUrlOf(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > 300 || !/^https:\/\//i.test(s)) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    if (!domainKeyOf(u.toString())) return null;
    u.hash = '';
    const out = u.toString();
    return out.length <= 300 ? out : null;
  } catch {
    return null;
  }
}

/**
 * ≤ 5 source URLs. With `groundedHosts` (the hosts the grounded search really returned), a URL the
 * model lists is kept only when its host is one of them, and the grounded hosts it did not list are
 * added as bare origins — "sources actually used", not the model's recollection.
 *
 * ⚠️ THREE CASES, NOT TWO:
 *   groundedHosts null     → a CACHED list being re-sanitised (it was verified when it was stored): kept.
 *   groundedHosts empty Set → a FRESH answer whose grounding metadata named no host: NOTHING is
 *                             verifiable, so sources: []. It used to fall through to "unverified, keep
 *                             everything", storing the model's recollection as sources for 30 days.
 *   groundedHosts non-empty → verified against those hosts only. The employer's own domain is NOT a
 *                             free pass any more (the model can invent https://acme.com/careers/cv-tips);
 *                             an own-domain URL is kept only when that host was itself grounded.
 * `domain` is accepted for callers' symmetry and deliberately unused.
 */
function sourcesOf(list, { groundedHosts = null, domain = null } = {}) {
  void domain;
  if (groundedHosts instanceof Set && groundedHosts.size === 0) return [];
  const verified = groundedHosts && groundedHosts.size ? [...groundedHosts] : null;
  const related = (h) => !verified || verified.some((g) => h === g || h.endsWith('.' + g) || g.endsWith('.' + h));
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const url = httpsUrlOf(item);
    const host = url ? domainKeyOf(url) : null;
    if (!url || !host || /(^|\.)(vertexaisearch\.cloud\.google\.com|google\.com)$/.test(host) || !related(host) || out.includes(url)) continue;
    out.push(url);
    if (out.length >= 5) return out;
  }
  if (verified) {
    for (const h of groundedHosts) {
      if (out.length >= 5) break;
      if (!out.some((u) => domainKeyOf(u) === h)) out.push(`https://${h}/`);
    }
  }
  return out;
}

/**
 * Any conventions answer (the model's snake_case JSON, a cached camelCase object) → Conventions | null.
 * Shape (contract 1): { hqCountry, roleCountry, employerType, sector, atsVendor,
 *   cv: { photo, length, personalDetails, dateFormat, format, notes[] }, tone, sources[] }.
 * null when nothing usable is left — sources alone are not knowledge.
 */
function sanitiseConventions(raw, { groundedHosts = null, domain = null } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const pick = (obj, ...keys) => { for (const k of keys) if (obj && obj[k] != null && obj[k] !== '') return obj[k]; return null; };
  const cvRaw = pick(raw, 'cv');
  const cvObj = cvRaw && typeof cvRaw === 'object' && !Array.isArray(cvRaw) ? cvRaw : {};

  const notesRaw = pick(cvObj, 'notes') || pick(raw, 'notes');
  const notes = [];
  for (const n of Array.isArray(notesRaw) ? notesRaw : []) {
    const s = cleanStr(typeof n === 'string' ? n : '', 400);
    if (s.length < 12 || looksPersonal(s)) continue;
    const cut = s.length <= 160 ? s : s.slice(0, 160).replace(/\s+\S*$/, '').trim();
    if (cut && !notes.some((x) => x.toLowerCase() === cut.toLowerCase())) notes.push(cut);
    if (notes.length >= 5) break;
  }

  const c = {
    hqCountry: countryNameOf(pick(raw, 'hqCountry', 'hq_country')),
    roleCountry: countryNameOf(pick(raw, 'roleCountry', 'role_country')),
    employerType: enumOf(pick(raw, 'employerType', 'employer_type'), EMPLOYER_TYPES, TYPE_SYNONYMS),
    sector: phraseOf(pick(raw, 'sector'), 60),
    atsVendor: atsVendorOf(pick(raw, 'atsVendor', 'ats_vendor')),
    cv: {
      photo: enumOf(pick(cvObj, 'photo'), PHOTO_VALUES, PHOTO_SYNONYMS),
      length: enumOf(pick(cvObj, 'length'), LENGTH_VALUES, LENGTH_SYNONYMS),
      personalDetails: enumOf(pick(cvObj, 'personalDetails', 'personal_details'), DETAILS_VALUES, DETAILS_SYNONYMS),
      dateFormat: dateFormatOf(pick(cvObj, 'dateFormat', 'date_format')),
      format: enumOf(pick(cvObj, 'format'), FORMAT_VALUES, FORMAT_SYNONYMS),
      notes,
    },
    tone: phraseOf(pick(raw, 'tone'), 60),
    sources: sourcesOf(pick(raw, 'sources'), { groundedHosts, domain }),
  };
  const known = c.hqCountry || c.roleCountry || c.employerType || c.sector || c.atsVendor || c.tone
    || c.cv.photo || c.cv.length || c.cv.personalDetails || c.cv.dateFormat || c.cv.format || c.cv.notes.length;
  return known ? c : null;
}

/** An ISO timestamp younger than the cache TTL. */
function freshIso(v) {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) && Date.now() - t < TTL_DAYS * 24 * 60 * 60 * 1000 && t <= Date.now() + 60 * 1000;
}

/**
 * Any researcher output (fresh camel/snake-case object or a cached row) → Research | null.
 * null when it carries no usable fact at all (so an empty answer is remembered as a failure, not
 * cached for 30 days as "we know nothing about Amazon"). Conventions count as a fact: how an
 * employer hires is worth keeping even when its website told the researcher nothing else. So does a
 * brand (what the website paints itself with) — though neither is a BASE fact: the researcher still runs.
 *
 * `conventionsAt` (when the conventions were researched) is BOOKKEEPING for the cache row: it is how a
 * row that was checked and found nothing ("conventions": null) differs from one never checked. It is
 * stripped from what callers receive (publicResearch).
 *
 * ⚠️ fallbackName IS NEVER PASSED ON A PATH THAT WRITES THE SHARED CACHE. The cache is keyed by
 * domain and read by EVERY user; a requester's typed company name ("my old boss's shop", a typo,
 * anything) stored as employerName would be served into other users' prompts as the "Official name"
 * for 30 days. The cache stores only a name the researcher itself returned; the requester's name is
 * laid over a per-request COPY in getEmployerResearch (withDisplayName) and never written back.
 */
function sanitiseResearch(raw, domain, fallbackName) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const pick = (...keys) => { for (const k of keys) if (raw[k] != null && raw[k] !== '') return raw[k]; return null; };

  const colorRaw = cleanStr(pick('brandColor', 'brand_color'), 7).toLowerCase();
  const brandColor = /^#[0-9a-f]{6}$/i.test(colorRaw) && colorRaw !== RESEARCHER_DEFAULT_COLOR ? colorRaw : null;
  const fontRaw = cleanStr(pick('fontName', 'font_name'), 80);
  const fontName = fontRaw && fontRaw.toLowerCase() !== RESEARCHER_DEFAULT_FONT ? fontRaw : null;

  const research = {
    domain: cleanStr(domain || raw.domain, 253).toLowerCase(),
    employerName: cleanStr(pick('employerName', 'employer_name')) || cleanStr(fallbackName),
    industry: cleanStr(pick('industry')),
    companySize: cleanStr(pick('companySize', 'company_size')),
    mission: cleanStr(pick('mission')),
    technologies: namesOf(pick('technologies'), ['name', 'technology', 'title'], 20),
    clients: namesOf(pick('clients'), ['client_name', 'name', 'client'], 10),
    recentActivity: namesOf(pick('recentActivity', 'recent_activity'), ['description', 'title', 'activity'], 5, 200),
    brandColor,
    fontName,
    brand: sanitiseBrand(pick('brand')),
    conventions: sanitiseConventions(pick('conventions')),
    fetchedAt: (() => {
      const t = pick('fetchedAt', 'fetched_at');
      const d = t ? new Date(t) : null;
      return d && Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString();
    })(),
  };
  if (typeof raw.conventionsAt === 'string' && Number.isFinite(Date.parse(raw.conventionsAt))) {
    research.conventionsAt = new Date(raw.conventionsAt).toISOString();
  }
  // The brand has its own clock: a stamp past the TTL (a row's brandAt, else the brand's own fetchedAt)
  // drops it, so a site that rebranded is read again while the row's base facts are still fresh.
  if (research.brand) {
    const stamp = typeof raw.brandAt === 'string' ? raw.brandAt : research.brand.fetchedAt;
    if (freshIso(stamp)) research.brandAt = new Date(stamp).toISOString();
    else research.brand = null;
  }
  // key_contacts is deliberately never copied (see header).

  const hasFact = hasBaseFact(research) || research.conventions || research.brand || cleanStr(pick('employerName', 'employer_name'));
  return hasFact ? research : null;
}

/** Whether the researcher's own part (not the conventions) knows anything. */
function hasBaseFact(r) {
  return !!(r && (r.industry || r.mission || r.companySize || (r.technologies && r.technologies.length)
    || (r.clients && r.clients.length) || (r.recentActivity && r.recentActivity.length) || r.brandColor || r.employerName));
}

/** What callers receive: no bookkeeping, and conventions they may mutate without touching the flight's object. */
function publicResearch(r) {
  if (!r || typeof r !== 'object') return r || null;
  const { conventionsAt: _bookkeeping, brandAt: _brandBookkeeping, ...rest } = r;
  return {
    ...rest,
    conventions: rest.conventions ? JSON.parse(JSON.stringify(rest.conventions)) : null,
    brand: rest.brand ? JSON.parse(JSON.stringify(rest.brand)) : null,
  };
}

// ── DB (lazy, degrade-to-miss) ────────────────────────────────────────────────
/**
 * ⚠️ db-config.js calls process.exit(1) AT REQUIRE TIME when DATABASE_URL is missing — no try/catch
 * can stop that. The pure helpers here (domainKeyOf, researchPromptBlock) are used from unit tests
 * and scripts with no database, so the DB module is required lazily, and only when a database is
 * configured or a test has already stubbed db-config into require.cache.
 */
function db() {
  try {
    const p = require.resolve('../../db-config');
    if (!require.cache[p] && !/^postgres/i.test(process.env.DATABASE_URL || '')) return null;
    return require('../../db-config');
  } catch {
    return null;
  }
}

let lastDbWarnAt = 0;
function warnDb(where, err) {
  const now = Date.now();
  if (now - lastDbWarnAt < 60 * 1000) return; // a missing table would otherwise log on every build
  lastDbWarnAt = now;
  console.warn(`[employerResearch] ${where} failed — treating as a cache miss: ${err && err.message}`);
}

/**
 * The domain's cache row → { research, hasBase, conventionsChecked } | null.
 *   hasBase: the researcher's part knows something (a conventions-only row does not).
 *   conventionsChecked: conventions were researched within the TTL — found or not.
 *
 * ⚠️ A ROW THAT IS ONLY "CHECKED, NOTHING FOUND" IS STILL A ROW. A domain whose researcher knows nothing
 * and whose conventions call answered empty is stored as { conventions: null, conventionsAt }. That
 * sanitises to null (no fact at all), and returning null here read as "never checked" — so the grounded
 * call (a paid search-grounded Gemini request) repeated on EVERY build for that domain, forever. The
 * checked-ness is read off the raw row BEFORE sanitising: such a row comes back as
 * { research: null, hasBase: false, conventionsChecked: true } (flightFor already treats research as optional).
 */
async function readCache(domain) {
  const d = db();
  if (!d) return null;
  try {
    const row = await d.get(
      `SELECT research, fetched_at FROM employer_research_cache
        WHERE domain = ? AND fetched_at > NOW() - INTERVAL '${TTL_DAYS} days'`,
      [domain],
    );
    if (!row) return null;
    let r = row.research;
    if (typeof r === 'string') { try { r = JSON.parse(r); } catch { return null; } }
    // No fallback name: a cached row's employerName is whatever the researcher returned, or ''.
    const rawObj = r && typeof r === 'object' && !Array.isArray(r) ? r : {};
    const research = sanitiseResearch({ ...rawObj, fetchedAt: row.fetched_at }, domain);
    const conventionsChecked = freshIso(research ? research.conventionsAt : rawObj.conventionsAt);
    if (!research) return conventionsChecked ? { research: null, hasBase: false, conventionsChecked: true } : null;
    return { research, hasBase: hasBaseFact(research), conventionsChecked };
  } catch (err) {
    warnDb('cache read', err);
    return null;
  }
}

/**
 * The researcher's facts, fresh — fetched_at restarts. ⚠️ MERGED into the row (`||`), never replacing
 * it: the conventions call persists itself on its own schedule, and a base write that landed after it
 * must not wipe what it wrote. Unanswered conventions are left out of the write for the same reason —
 * and so is a brand not yet extracted (a `brand: null` would blank the one patchBrand merged in).
 */
async function writeCache(domain, research) {
  const d = db();
  if (!d) return;
  try {
    const { conventions, conventionsAt, brand, brandAt, ...base } = research || {};
    const row = { ...base };
    if (conventionsAt) Object.assign(row, { conventions, conventionsAt });
    if (brand && brandAt) Object.assign(row, { brand, brandAt });
    await d.query(
      `INSERT INTO employer_research_cache (domain, research, fetched_at) VALUES (?, ?::jsonb, NOW())
       ON CONFLICT (domain) DO UPDATE SET research = employer_research_cache.research || EXCLUDED.research, fetched_at = NOW()`,
      [domain, JSON.stringify(row)],
    );
  } catch (err) {
    warnDb('cache write', err);
  }
}

/**
 * The conventions answer merged into the row. fetched_at is NOT touched on an existing row (the base
 * facts are as old as they were); a domain with no row yet gets a conventions-only row.
 */
async function patchConventions(domain, conventions) {
  const d = db();
  if (!d) return;
  try {
    await d.query(
      `INSERT INTO employer_research_cache (domain, research, fetched_at) VALUES (?, ?::jsonb, NOW())
       ON CONFLICT (domain) DO UPDATE SET research = employer_research_cache.research || EXCLUDED.research`,
      [domain, JSON.stringify({ domain, conventions: conventions || null, conventionsAt: new Date().toISOString() })],
    );
  } catch (err) {
    warnDb('conventions write', err);
  }
}

/**
 * The website's brand merged into the row like the conventions: fetched_at untouched, a brand-only row
 * created when there is none. ⚠️ ONLY A FOUND BRAND IS WRITTEN. A null answer is mostly the network's (a
 * timeout, a 403 for non-browsers, a JS-only shell) — not a fact about the employer worth 30 days in a
 * shared row; brandCallFor remembers it in memory for an hour instead, so a transient failure heals on
 * the next build and the row never says "no brand" about a site that has one. The trailing comment
 * labels the statement (it is otherwise the conventions patch, character for character).
 */
async function patchBrand(domain, brand) {
  const d = db();
  if (!d || !brand) return;
  try {
    await d.query(
      `INSERT INTO employer_research_cache (domain, research, fetched_at) VALUES (?, ?::jsonb, NOW())
       ON CONFLICT (domain) DO UPDATE SET research = employer_research_cache.research || EXCLUDED.research /* brand */`,
      [domain, JSON.stringify({ domain, brand, brandAt: new Date().toISOString() })],
    );
  } catch (err) {
    warnDb('brand write', err);
  }
}

// ── The conventions call ──────────────────────────────────────────────────────
/**
 * ⚠️ The prompt takes the DOMAIN and a name the researcher itself returned — never a requester's
 * input. Its answer is cached for every user of the domain (see header).
 */
function conventionsPrompt(domain, employerName) {
  const nameLine = employerName ? `\nEmployer name (as its own website gives it): ${cleanStr(employerName, 120)}` : '';
  return `You research how ONE employer hires, for a job seeker tailoring a CV and a cover letter to it. Use Google Search on the website below and on the organisation behind it: its careers or jobs pages, where its "apply" links lead (the host names the applicant tracking system — myworkdayjobs.com = Workday, successfactors = SAP SuccessFactors, taleo.net = Oracle Taleo, greenhouse.io = Greenhouse, lever.co = Lever, smartrecruiters.com = SmartRecruiters, icims.com = iCIMS, personio = Personio), any application advice it publishes, and the CV conventions of the country it hires in.

Employer website: https://${domain}${nameLine}

Rules:
- Answer ONLY from what the search results support. Use null for anything you cannot support — null is far better than a guess.
- Never include the name, email address or phone number of any person.
- Write countries as plain English names ("Switzerland", "United Arab Emirates").

Return ONLY this JSON object, with nothing before or after it:
{
  "hq_country": "country of its headquarters, or null",
  "role_country": "the country its open roles are in when that is ONE country, else null",
  "employer_type": "public_sector | enterprise | sme | startup | agency | ngo | academia | other | null",
  "sector": "its sector in a few words, or null",
  "ats_vendor": "the applicant tracking system its apply links use (e.g. \\"Workday\\"), or null",
  "cv": {
    "photo": "expected | optional | avoid | null",
    "length": "one_page | two_pages | flexible | null",
    "personal_details": "include | avoid | null",
    "date_format": "how CV dates are usually written there (e.g. \\"MM/YYYY\\"), or null",
    "format": "tabular | narrative | europass | ats_plain | null",
    "notes": ["3 to 5 short factual notes, each under 160 characters"]
  },
  "tone": "the register of its hiring communication in a few words (e.g. \\"formal\\"), or null",
  "sources": ["up to 5 https URLs you actually used"]
}

Definitions:
- employer_type: public_sector = a government body, ministry, public agency or public administration; enterprise = a large company (roughly 1,000+ employees); sme = a smaller established company; startup = a young, venture-funded or fast-growing company; agency = a recruitment, staffing or job-board business, or a creative, marketing or digital agency serving clients; ngo = a non-profit, charity or international organisation; academia = a university, school or research institute.
- photo, personal_details and length describe what applicants to THIS employer, in the country it hires in, usually do: expected = most include it; optional = common but not required; avoid = unusual or discouraged (anti-discrimination norms, applicant tracking guidance). personal_details means date of birth, nationality or marital status.
- format: tabular = a table-like CV with dates in a left column (e.g. the German Lebenslauf); narrative = a profile summary followed by achievement bullets (UK / US style); europass = the EU Europass CV; ats_plain = a plain single-column document written for applicant tracking systems.
- notes: how to apply to THIS employer, or the CV habits of the country it hires in (e.g. "Applications go through its Workday portal; a cover letter is optional"). No salaries, no people, no URLs.`;
}

/** The first {...} in a model answer (fences and prose around it allowed) → object | null. */
function parseModelJson(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const v = JSON.parse(cleaned.slice(start, end + 1));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** Hosts the grounded search really returned (a chunk's title is its site's domain). Empty when unknown. */
function groundedHostsOf(response) {
  const hosts = new Set();
  try {
    for (const cand of Array.isArray(response && response.candidates) ? response.candidates : []) {
      const chunks = cand && cand.groundingMetadata && Array.isArray(cand.groundingMetadata.groundingChunks) ? cand.groundingMetadata.groundingChunks : [];
      for (const chunk of chunks) {
        const web = chunk && chunk.web;
        if (!web) continue;
        for (const h of [domainKeyOf(typeof web.title === 'string' ? web.title : ''), domainKeyOf(typeof web.uri === 'string' ? web.uri : '')]) {
          if (h && !/(^|\.)(vertexaisearch\.cloud\.google\.com|google\.com)$/.test(h)) hosts.add(h);
        }
      }
    }
  } catch { /* a changed metadata shape: no host is verifiable, so the answer stores sources: [] */ }
  return hosts;
}

/**
 * ONE grounded call about how `domain` hires → { answered: true, conventions } | { answered: false, why }.
 * NEVER throws. `answered` means the model returned a JSON object — an object with nothing usable is
 * still an answer (conventions: null) and is cached as "checked"; a throw, a timeout or prose is not.
 *
 * ⚠️ Called through module.exports (see conventionsCallFor), so a test can stub it without the SDK.
 */
async function researchConventions(domain, employerName) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { answered: false, why: 'GEMINI_API_KEY not set' };
  try {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
      model: CONVENTIONS_MODEL,
      // ⚠️ gemini-2.5-flash THINKS by default and its thinking tokens count against maxOutputTokens. With
      // Google Search grounding the thoughts can run long, and at 4096 they could eat the whole budget:
      // the answer arrived cut off mid-JSON → "no JSON object" → a paid call that taught us nothing. The
      // budget is capped (the SDK passes generationConfig through verbatim, so thinkingConfig reaches the
      // API) and the ceiling doubled, so the ~1 KB JSON always has room after the thoughts.
      generationConfig: { temperature: 0.2, topP: 0.9, maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 1024 } },
    });
    const result = await model.generateContent(
      { contents: [{ role: 'user', parts: [{ text: conventionsPrompt(domain, employerName) }] }], tools: [{ googleSearch: {} }] },
      { timeout: CONVENTIONS_HARD_TIMEOUT_MS },
    );
    const response = result && result.response;
    const parsed = parseModelJson(response && typeof response.text === 'function' ? response.text() : '');
    if (!parsed) return { answered: false, why: 'no JSON object in the answer' };
    return { answered: true, conventions: sanitiseConventions(parsed, { groundedHosts: groundedHostsOf(response), domain }) };
  } catch (err) {
    return { answered: false, why: (err && err.message) || 'failed' };
  }
}

// ── getEmployerResearch ───────────────────────────────────────────────────────
const inflight = new Map(); // domain → { base, full, baseSettled, baseValue }   (single-flight per process)
const conventionsInflight = new Map(); // domain → Promise<answer> — may OUTLIVE the flight that started it
const failedAt = new Map(); // key (domain | 'conventions:' + domain) → ms of the last failure
const conventionsKey = (domain) => `conventions:${domain}`;

function recentlyFailed(key) {
  const t = failedAt.get(key);
  if (!t) return false;
  if (Date.now() - t < FAIL_MEMORY_MS) return true;
  failedAt.delete(key);
  return false;
}

function rememberFailure(key) {
  failedAt.set(key, Date.now());
  if (failedAt.size > 5000) { // bounded: drop the oldest entries
    const cut = [...failedAt.entries()].sort((a, b) => a[1] - b[1]).slice(0, failedAt.size - 4000);
    for (const [k] of cut) failedAt.delete(k);
  }
}

/**
 * The conventions call for a domain, shared by every flight — including one that starts while an older
 * flight's call (which stopped being waited for) is still running, so no domain pays for two. It
 * PERSISTS ITS OWN ANSWER whenever it lands: the cache learns it even when every caller moved on.
 */
function conventionsCallFor(domain, employerName) {
  const existing = conventionsInflight.get(domain);
  if (existing) return existing;
  const p = Promise.resolve()
    .then(() => module.exports.researchConventions(domain, employerName))
    .then(async (answer) => {
      if (answer && answer.answered) {
        await patchConventions(domain, answer.conventions);
        // An EMPTY answer is also held in memory: the row above is what normally stops a repeat, but with
        // no DB (or a failed write) readCache misses and every build would pay for the same empty search.
        // Harmless when a row exists — a checked domain never asks recentlyFailed for its conventions.
        if (!answer.conventions) rememberFailure(conventionsKey(domain));
        return { answered: true, conventions: answer.conventions || null };
      }
      rememberFailure(conventionsKey(domain));
      console.warn(`[employerResearch] conventions unavailable for ${domain}: ${(answer && answer.why) || 'no answer'}`);
      return { answered: false };
    })
    .catch((err) => {
      rememberFailure(conventionsKey(domain));
      console.warn(`[employerResearch] conventions failed for ${domain}: ${err && err.message}`);
      return { answered: false };
    })
    .finally(() => { conventionsInflight.delete(domain); });
  conventionsInflight.set(domain, p);
  return p;
}

/** The conventions answer, or { answered: false } after CONVENTIONS_WAIT_MS (the call keeps running). */
function boundedConventions(domain, employerName) {
  let timer = null;
  const wait = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ answered: false, waited: true }), CONVENTIONS_WAIT_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([conventionsCallFor(domain, employerName), wait]).finally(() => { if (timer) clearTimeout(timer); });
}

// ── The brand extraction ──────────────────────────────────────────────────────
const brandInflight = new Map(); // domain → Promise<Brand|null> — may OUTLIVE the flight that started it, like the conventions
const brandKey = (domain) => `brand:${domain}`;
// Found brands, in memory, for the case the row cannot hold them (no DB, a failed write, a build that
// lands before the patch does): without this every such build would read the website again (a bounded
// read, but 45 s of them in the stubbed doc-lane test). Bounded like failedAt, an hour like it.
const brandMemo = new Map(); // domain → { brand, at }
const BRAND_MEMO_MS = 60 * 60 * 1000;
function rememberBrand(domain, brand) {
  brandMemo.set(domain, { brand, at: Date.now() });
  if (brandMemo.size > 2000) {
    const cut = [...brandMemo.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, brandMemo.size - 1500);
    for (const [k] of cut) brandMemo.delete(k);
  }
}
function rememberedBrand(domain) {
  const e = brandMemo.get(domain);
  if (!e) return null;
  if (Date.now() - e.at < BRAND_MEMO_MS) return e.brand;
  brandMemo.delete(domain);
  return null;
}

/** Off when EMPLOYER_BRAND_EXTRACT is off / 0 / false: every build then paints the usual way; nothing else changes. */
const brandExtractionOn = () => !/^(off|0|false|no)$/i.test(String(process.env.EMPLOYER_BRAND_EXTRACT || '').trim());

/**
 * ONE deterministic read of https://<domain>/ → Brand | null (brandExtract never throws, bounds itself).
 * ⚠️ Called through module.exports (see brandCallFor), so a test can stub it without a network.
 */
function researchBrand(domain) {
  return brandExtract.extractBrand({ website: `https://${domain}/`, domain }, { timeoutMs: BRAND_WAIT_MS });
}

/** Google Fonts' yes/no for a family the RESEARCHER named — bounded, remembered a day. Stubbable like researchBrand. */
function googleFontCheck(family) {
  return brandExtract.checkGoogleFont(family, { timeoutMs: FONT_CHECK_MS });
}

/**
 * The website read for a domain, shared by every flight — including one that starts while an older
 * flight's read (no longer waited for) is still running. It PERSISTS ITS OWN ANSWER when it lands, and
 * only then: a null is remembered in memory for an hour, never written (see patchBrand).
 */
function brandCallFor(domain) {
  const existing = brandInflight.get(domain);
  if (existing) return existing;
  const p = Promise.resolve()
    .then(() => module.exports.researchBrand(domain))
    .then(async (raw) => {
      const brand = sanitiseBrand(raw);
      if (!brand) { rememberFailure(brandKey(domain)); return null; }
      rememberBrand(domain, brand);
      await patchBrand(domain, brand);
      return brand;
    })
    .catch((err) => {
      rememberFailure(brandKey(domain));
      console.warn(`[employerResearch] brand extraction failed for ${domain}: ${err && err.message}`);
      return null;
    })
    .finally(() => { brandInflight.delete(domain); });
  brandInflight.set(domain, p);
  return p;
}

/** The brand, or null after BRAND_WAIT_MS + a grace for the row write (the read keeps running and persists itself). */
function boundedBrand(domain) {
  let timer = null;
  const wait = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), BRAND_WAIT_MS + BRAND_GRACE_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([brandCallFor(domain), wait]).finally(() => { if (timer) clearTimeout(timer); });
}

/**
 * The whole lookup-or-research for one domain, shared by every concurrent caller. Checks the cache
 * INSIDE the flight so two builds for the same new employer make one AI call, not two.
 *
 * THREE STAGES: `base` settles as soon as the researcher's facts are known (from the row, or the
 * researcher call); `full` settles when the conventions are in too (or stopped being waited for). A
 * caller whose own timeout fires first still gets `base` if it is there — a cached employer never
 * loses its instant answer because its conventions are being fetched. `brand` (the website read)
 * settles on its own clock and `full` never waits for it — getEmployerResearch folds it in.
 *
 * ⚠️ NO REQUESTER INPUT ENTERS THE FLIGHT. Its result is written to the shared cache AND handed to
 * every concurrent caller (possibly different users), so it takes only the domain. It used to take the
 * first caller's company name as the employerName fallback, which put that user's typed name into the
 * cache and into the other callers' results.
 */
function flightFor(domain) {
  const existing = inflight.get(domain);
  if (existing) return existing;
  const flight = { base: null, full: null, brand: null, baseSettled: false, baseValue: null, brandSettled: false, brandValue: null };
  let settleBase = null;
  let settleBrand = null;
  let brandStarted = false;
  flight.base = new Promise((resolve) => {
    settleBase = (value) => {
      if (flight.baseSettled) return;
      flight.baseSettled = true;
      flight.baseValue = value || null;
      resolve(value || null);
    };
  });
  // THE THIRD STAGE. The brand settles on its own clock (≤ BRAND_WAIT_MS + grace after the cache read)
  // and `full` never waits for it: the base write and the conventions land exactly when they did before
  // the brand existed. getEmployerResearch merges it into the caller's copy within the caller's time.
  flight.brand = new Promise((resolve) => {
    settleBrand = (value) => {
      if (flight.brandSettled) return;
      flight.brandSettled = true;
      flight.brandValue = value || null;
      resolve(value || null);
    };
  });
  flight.full = (async () => {
    const cached = await readCache(domain);
    const needBase = !cached || !cached.hasBase;
    const needConventions = !cached || !cached.conventionsChecked;
    // The website read starts now, beside the two research calls; a row that carries a fresh brand is done already.
    brandStarted = true;
    const knownBrand = (cached && cached.research && cached.research.brand) || rememberedBrand(domain);
    if (knownBrand) settleBrand(knownBrand);
    else if (brandExtractionOn() && !recentlyFailed(brandKey(domain))) boundedBrand(domain).then(settleBrand, () => settleBrand(null));
    else settleBrand(null);
    if (!needBase) settleBase(cached.research);
    if (!needBase && !needConventions) return cached.research;

    // Both calls start now, in parallel. The conventions prompt may name the employer only with the
    // name the researcher itself returned (a cached row's), never with a requester's.
    const conventionsP = needConventions && !recentlyFailed(conventionsKey(domain))
      ? boundedConventions(domain, (cached && cached.research && cached.research.employerName) || '')
      : Promise.resolve({ answered: false });

    let freshBase = null;
    if (needBase && !recentlyFailed(domain)) {
      let baseRaw = null;
      try {
        baseRaw = await require('../../ai-employer-researcher').researchEmployer('https://' + domain);
      } catch (err) {
        console.warn(`[employerResearch] researcher threw for ${domain}: ${err && err.message}`);
        baseRaw = null;
      }
      freshBase = baseRaw ? sanitiseResearch(baseRaw, domain) : null; // no fallback name — cached for everyone
      if (!hasBaseFact(freshBase)) { freshBase = null; rememberFailure(domain); }
    }

    // The row as it was, the researcher's fresh facts over it, the conventions when they answer.
    const merge = (answer) => {
      let raw = cached && cached.research ? { ...cached.research } : {};
      if (freshBase) {
        // A fresh researcher answer knows no brand (brand: null): it must not blank the one the row carries.
        const { conventions: _c, conventionsAt: _a, brand: _b, brandAt: _ba, ...facts } = freshBase;
        raw = { ...raw, ...facts };
      }
      if (answer && answer.answered) raw = { ...raw, conventions: answer.conventions, conventionsAt: new Date().toISOString() };
      return raw;
    };
    if (needBase) settleBase(sanitiseResearch(merge(null), domain));

    const answer = await conventionsP;
    const raw = merge(answer);
    const research = sanitiseResearch(raw, domain);
    if (!research) return null;
    // The conventions call wrote its own answer; only fresh researcher facts are written here.
    if (freshBase) await writeCache(domain, research);
    return research;
  })()
    .catch((err) => {
      console.warn(`[employerResearch] research failed for ${domain}: ${err && err.message}`);
      rememberFailure(domain);
      return null;
    })
    .finally(() => {
      settleBase(null); // no-op when the base already settled
      if (!brandStarted) settleBrand(null); // the cache read threw before the read could start; a started one settles itself
      inflight.delete(domain);
    });
  inflight.set(domain, flight);
  return flight;
}

/**
 * The requester's company name as the employerName of THIS caller's copy, when the researcher found
 * none. A new object every time: the flight's result is shared by concurrent callers and is the very
 * object written to the cache, so it is never mutated. The name the caller gets back is exactly what
 * it passed in (as before this fix), so its prompt block and its own stored doc read the same.
 */
function withDisplayName(research, displayName) {
  if (!research || typeof research !== 'object') return research || null;
  if (research.employerName || !displayName) return { ...research };
  return { ...research, employerName: displayName };
}

const TIMED_OUT = Symbol('timed out');

/** `promise` within `ms`, else `fallback` (Infinity = no bound; ≤ 0 = the fallback at once, nothing waited for). */
function within(promise, ms, fallback) {
  if (!(ms > 0)) return Promise.resolve(fallback);
  if (!Number.isFinite(ms)) return promise;
  let timer = null;
  const wait = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, wait]).finally(() => { if (timer) clearTimeout(timer); });
}

/**
 * The caller's copy with the brand in it — a NEW object: the flight's research is shared by concurrent
 * callers and is the very object written to the cache. A research that already carries this brand (a
 * cached row's) comes back as it is; no research at all becomes a brand-only one (a brand is a fact).
 */
function withBrand(research, domain, brand) {
  const b = sanitiseBrand(brand);
  if (!b) return research;
  if (research && research.brand && research.brand.fetchedAt === b.fetchedAt) return research;
  const raw = { ...(research || { domain }), brand: b, brandAt: b.fetchedAt };
  return sanitiseResearch(raw, domain) || research;
}

/**
 * A font the RESEARCHER named (fontName) becomes brand.font on the caller's copy when the website itself
 * declared none — google true only when Google Fonts was seen to serve it (the renderer can load no other
 * kind), from.font 'researcher'. Bounded by what is left of the caller's time; brandExtract remembers the
 * answer per family for a day, so a cold check costs one build one short request. ⚠️ This is the ONE place
 * that memory is consulted: the answer is written here, on brand.font, and brandOf only ever reads it back.
 */
async function withResearcherFont(research, ms) {
  if (!research || (research.brand && research.brand.font)) return research;
  const family = familyOf(research.fontName);
  if (!family) return research;
  let google = brandExtract.googleFontKnown(family);
  if (google === null && ms > 200) google = await within(module.exports.googleFontCheck(family), ms, null);
  const base = research.brand || { primary: null, secondary: null, font: null, from: { primary: null, font: null }, fetchedAt: research.fetchedAt || new Date().toISOString() };
  const brand = { ...base, font: { family, google: google === true }, from: { ...base.from, font: 'researcher' } };
  return { ...research, brand, brandAt: research.brandAt || brand.fetchedAt };
}

/**
 * Research for an employer's website, or null. NEVER throws. The result carries `conventions`
 * (null when unknown) and `brand` (the website's colours and font, null when unknown — see brandOf).
 *
 * `name` is the requester's company name. It is a DISPLAY fallback for this caller only (see
 * withDisplayName) and never reaches the shared employer_research_cache. `country` (the chip's
 * country) is accepted and deliberately NOT used here: it is a per-request fact, and everything in the
 * flight is shared. The region that country implies is regionForConventions' job.
 *
 * ⚠️ ON TIMEOUT WE STOP WAITING, NOT WORKING. The caller gets the researcher's facts without the
 * conventions (or null, when even those are not in) after timeoutMs and writes the document without
 * them, but the pending calls keep running and still populate the cache — so the NEXT build for that
 * employer (any user) gets them instantly. Aborting them would waste the money already spent.
 */
async function getEmployerResearch({ website, name, country } = {}, { timeoutMs = 25000 } = {}) {
  void country; // see above: never part of the shared research
  try {
    const domain = domainKeyOf(website);
    if (!domain) return null;
    const displayName = cleanStr(name, 200);
    const finish = (r) => withDisplayName(publicResearch(r), displayName);
    // The flight reads the cache before consulting the failure memory, so a remembered failure
    // never hides a good cached row — it only stops a second AI call within the hour.
    const flight = flightFor(domain);
    const ms = Number(timeoutMs);
    const bounded = Number.isFinite(ms) && ms > 0;
    const started = Date.now();
    const left = () => (bounded ? ms - (Date.now() - started) : Infinity);
    let research;
    if (!bounded) {
      research = await flight.full;
    } else {
      let timer = null;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
        if (timer && typeof timer.unref === 'function') timer.unref();
      });
      try {
        const won = await Promise.race([flight.full, timeout]);
        research = won !== TIMED_OUT ? won : (flight.baseSettled ? flight.baseValue : null);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    // The brand, within what is left of the caller's time (its own clock runs from the cache read, see
    // flightFor); a caller whose time is up takes it only if it is already there.
    const brand = flight.brandSettled ? flight.brandValue : await within(flight.brand, left(), null);
    research = withBrand(research, domain, brand);
    research = await withResearcherFont(research, left());
    return finish(research);
  } catch (err) {
    console.warn(`[employerResearch] getEmployerResearch swallowed: ${err && err.message}`);
    return null;
  }
}

// ── researchPromptBlock ───────────────────────────────────────────────────────
/**
 * The research as a prompt section, '' when there is nothing to say. The rules travel WITH the
 * facts so no caller can include the research without the guard rails. Conventions are NOT in this
 * block — they have their own (conventionsPromptBlock), which a caller includes on purpose.
 */
function researchPromptBlock(research, company, { forLetter = false } = {}) {
  if (!research || typeof research !== 'object') return '';
  const r = sanitiseResearch(research, research.domain, research.employerName);
  if (!r) return '';
  const who = cleanStr(company, 120) || r.employerName || 'THIS EMPLOYER';

  const facts = [];
  if (r.employerName && r.employerName.toLowerCase() !== who.toLowerCase()) facts.push(`Official name: ${r.employerName}`);
  if (r.industry) facts.push(`Industry: ${r.industry}`);
  if (r.companySize) facts.push(`Size: ${r.companySize}`);
  if (r.mission) facts.push(`Mission / tagline: ${r.mission}`);
  if (r.technologies.length) facts.push(`Technologies and products they use or build: ${r.technologies.join(', ')}`);
  if (r.clients.length) facts.push(`Named clients: ${r.clients.join(', ')}`);
  if (r.recentActivity.length) facts.push(`Recent activity:\n${r.recentActivity.map((a) => `- ${a}`).join('\n')}`);
  // A block that would only say the name and website teaches the model nothing — skip it. The colour is
  // design, not knowledge (brandOf: the website's, else the researcher's): it rides along, never leads.
  if (!facts.length) return '';
  const accent = brandOf(research).accent;
  if (accent) facts.push(`Brand colour: ${accent}`);
  if (r.domain) facts.unshift(`Website: ${r.domain}`);

  const rules = [
    `- Use this ONLY to decide emphasis, ordering, wording and design: which of the candidate's real experience, skills and projects matter most to ${who}, and which vocabulary ${who} uses.`,
    '- NEVER add a skill, tool, technology, employer, job title, date, degree, certification, client or number that the candidate\'s own material does not already contain. A technology listed above that the candidate never used stays out.',
  ];
  if (forLetter) {
    rules.push(`- You may reference clearly public facts from this block (industry, mission, products) to explain why the candidate fits ${who}, but NEVER invent anything beyond it — no made-up initiatives, figures, people, values or news.`);
    rules.push('- If a fact above looks doubtful or unrelated to this employer, leave it out.');
  } else {
    rules.push(`- This is a RESUME: never state facts about ${who} anywhere in it (no company name, mission, clients, products or news) — the resume is about the candidate only.`);
  }

  return [
    `=== WHAT WE KNOW ABOUT ${who} (web research — may be incomplete or wrong) ===`,
    ...facts,
    'HOW TO USE THIS RESEARCH:',
    ...rules,
    '=== END OF EMPLOYER RESEARCH ===',
  ].join('\n');
}

// ── conventionsPromptBlock ────────────────────────────────────────────────────
const TYPE_TEXT = {
  public_sector: 'public sector (government body or public agency)', enterprise: 'large enterprise', sme: 'small or medium-sized company',
  startup: 'startup', agency: 'agency (recruitment, staffing or client services)', ngo: 'non-profit / international organisation', academia: 'academia (university or research institute)',
};
const PHOTO_TEXT = { expected: 'a photo is expected', optional: 'a photo is optional', avoid: 'no photo (unusual or discouraged)' };
const LENGTH_TEXT = { one_page: 'one page', two_pages: 'up to two pages', flexible: 'no strict length' };
const DETAILS_TEXT = { include: 'personal details (date of birth, nationality) are commonly included', avoid: 'personal details (date of birth, nationality, marital status) are left out' };
const FORMAT_TEXT = {
  tabular: 'tabular (concise, date-led entries, like a German Lebenslauf)', narrative: 'profile-led (short profile, then achievement bullets)',
  europass: 'Europass-style (the EU standard CV)', ats_plain: 'plain single column built for applicant tracking systems',
};

/**
 * How THIS employer hires, as a prompt section ('' when there are no conventions). The rules travel
 * with the facts: conventions shape FORMAT and EMPHASIS only and never create a fact about the
 * candidate. The letter version leaves the CV habits out (photo, length, personal details belong to
 * the resume) and keeps what shapes a letter: employer type, sector, ATS, tone, notes.
 */
function conventionsPromptBlock(conventions, company, { forLetter = false } = {}) {
  const c = sanitiseConventions(conventions);
  if (!c) return '';
  const who = cleanStr(company, 120) || 'THIS EMPLOYER';

  const facts = [];
  if (c.hqCountry) facts.push(`Headquarters: ${c.hqCountry}`);
  if (c.roleCountry) facts.push(`Hires in: ${c.roleCountry}`);
  if (c.employerType && TYPE_TEXT[c.employerType]) facts.push(`Employer type: ${TYPE_TEXT[c.employerType]}`);
  if (c.sector) facts.push(`Sector: ${c.sector}`);
  if (c.atsVendor) facts.push(`Applicant tracking system in its apply flow: ${c.atsVendor}`);
  if (!forLetter) {
    const cv = [];
    if (c.cv.photo) cv.push(PHOTO_TEXT[c.cv.photo]);
    if (c.cv.length) cv.push(LENGTH_TEXT[c.cv.length]);
    if (c.cv.personalDetails) cv.push(DETAILS_TEXT[c.cv.personalDetails]);
    if (c.cv.dateFormat) cv.push(`dates written as ${c.cv.dateFormat}`);
    if (c.cv.format) cv.push(`format: ${FORMAT_TEXT[c.cv.format]}`);
    if (cv.length) facts.push(`CV conventions: ${cv.join('; ')}`);
  }
  if (c.tone) facts.push(`Register of its hiring communication: ${c.tone}`);
  if (c.cv.notes.length) facts.push(`Notes:\n${c.cv.notes.map((n) => `- ${n}`).join('\n')}`);
  // Countries alone give the writer nothing to act on (they already chose the region); the letter
  // version has nothing to act on without the employer's type, sector, ATS, register or notes.
  const actionable = c.employerType || c.sector || c.atsVendor || c.tone || c.cv.notes.length
    || (!forLetter && (c.cv.photo || c.cv.length || c.cv.personalDetails || c.cv.dateFormat || c.cv.format));
  if (!actionable) return '';

  const rules = [];
  if (forLetter) {
    rules.push(`- These conventions shape the letter's register, structure and emphasis ONLY. Never state or imply a fact about the candidate or ${who} that the candidate's material or the employer research does not contain.`);
    rules.push('- CV conventions (photo, date of birth, nationality, personal details, CV length) belong to the resume: never mention them in the letter.');
    rules.push(`- If a note looks doubtful or unrelated to ${who}, ignore it.`);
  } else {
    rules.push('- These conventions shape FORMAT and EMPHASIS only: section order, length, how much detail each role gets, whether personal details appear, the date format, the register. They never change what is true about the candidate.');
    rules.push('- NEVER invent anything to satisfy a convention: no photo, date of birth, nationality, marital status, signature, language level, certificate, date, employer, title or number that the candidate\'s own material does not contain. A convention the material cannot meet is simply not met.');
    if (c.cv.personalDetails === 'include') rules.push('- Personal details: keep the date of birth and nationality ONLY where the candidate\'s material already states them.');
    if (c.cv.personalDetails === 'avoid') rules.push('- Personal details: leave date of birth, nationality and marital status out, even where the candidate\'s material states them.');
    if (c.cv.length === 'one_page') rules.push('- Length: fit one page by keeping the most relevant roles and trimming older detail — never by dropping a real qualification the role asks for.');
    if (c.cv.dateFormat) rules.push(`- Dates: where the material gives a date, write it as ${c.cv.dateFormat}; never add a day or month the material does not give.`);
    if (c.cv.format === 'tabular') rules.push('- Tabular CV: concise, factual entries (role, employer, dates, a few bullets); no first-person prose.');
    if (c.cv.format === 'narrative') rules.push('- Profile-led CV: open with a short professional profile, then achievement bullets per role.');
    if (c.cv.format === 'europass') rules.push('- Europass-style CV: languages with their levels ONLY where the material states the levels.');
    if (c.cv.format === 'ats_plain') rules.push('- Plain ATS CV: standard section headings, plain wording, no symbols or decorative characters in the text.');
    if (c.atsVendor) rules.push(`- ${c.atsVendor} parses this CV before a person reads it: standard section headings, plain wording, and job titles and skill names exactly as the candidate's material words them.`);
    rules.push(`- Never mention ${who}, these conventions or this research anywhere in the resume.`);
  }

  return [
    `=== HOW ${who} HIRES (web research — may be incomplete or wrong) ===`,
    ...facts,
    'HOW TO USE THESE CONVENTIONS:',
    ...rules,
    '=== END OF HIRING CONVENTIONS ===',
  ].join('\n');
}

// ── brandOf ───────────────────────────────────────────────────────────────────
/**
 * What the renderers paint with: { accent: '#rrggbb'|null, font: { family, google }|null }. The website's
 * own brand wins (brand.primary, brand.font); the researcher's brandColor / fontName stand in when the
 * website gave none. Always an object, NEVER throws; null and a research from before the brand existed are fine.
 *
 * ⚠️ DETERMINISTIC — A BARE RESEARCHER fontName IS google:false, ALWAYS (2026-09-15). The Google Fonts answer for
 * a researcher font lives on brand.font, where withResearcherFont writes it on every fresh research (google true
 * only when the check saw Google serve the family). This function used to consult brandExtract.googleFontKnown
 * for a fontName that never got there — a per-process 24 h memory — so a document stored before design.brand
 * existed (its research: fontName 'Montserrat', no brand) rendered in Lato after a deploy, in Montserrat once any
 * user's build had checked that family (a new thumb/preview cache key, every card re-rendered), and in Lato again
 * a day later. A stored document's brand must read the same on every process, so nothing here reads that memory:
 * a font with no verified answer on the research is not a Google font, and the renderer keeps the design's stack.
 */
function brandOf(research) {
  try {
    const r = research && typeof research === 'object' && !Array.isArray(research) ? research : null;
    const b = r ? sanitiseBrand(r.brand) : null;
    const researcherHex = r ? hexOrNull(r.brandColor) : null;
    const accent = (b && b.primary) || (researcherHex && researcherHex !== RESEARCHER_DEFAULT_COLOR ? researcherHex : null);
    let font = b && b.font ? { family: b.font.family, google: b.font.google === true } : null;
    if (!font && r) {
      const family = familyOf(r.fontName);
      if (family && family.toLowerCase() !== RESEARCHER_DEFAULT_FONT) font = { family, google: false };
    }
    return { accent, font };
  } catch {
    return { accent: null, font: null };
  }
}

// ── cachedBrandFor ────────────────────────────────────────────────────────────
/**
 * The shared row's brand for a domain — the sanitised Brand ({ primary, secondary, font, from, fetchedAt }) or
 * null — for a STORED document that has none of its own: a build whose website read missed its deadline stored
 * design.brand = null and a research snapshot without a brand, and that document never gained the employer's
 * colour even after patchBrand had written it to the row for everyone. The doc lanes lay this over the snapshot
 * (docBrandOf / letterBrandOf → brandOf) at render time.
 *
 * ⚠️ ONE READ-ONLY SELECT AND NOTHING ELSE: never the researcher, never the website (brandCallFor), never a
 * write — a render must not be able to bill anyone or move a row's clocks. The row's own fetched_at is not a
 * condition here (patchBrand does not touch it, so a fresh brand can sit on a stale base): the brand's OWN 30-day
 * clock (brandAt, applied by sanitiseResearch) decides. Any error, no database, or a domain that is not one →
 * null, the same as "no brand".
 */
async function cachedBrandFor(domain) {
  try {
    const key = domainKeyOf(domain);
    const d = key ? db() : null;
    if (!d) return null;
    const row = await d.get('SELECT research FROM employer_research_cache WHERE domain = ?', [key]);
    if (!row) return null;
    let r = row.research;
    if (typeof r === 'string') { try { r = JSON.parse(r); } catch { return null; } }
    if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
    const research = sanitiseResearch(r, key);
    return research && research.brand ? research.brand : null;
  } catch (err) {
    warnDb('brand read', err);
    return null;
  }
}

// ── regionForConventions ──────────────────────────────────────────────────────
/**
 * The template region for an employer (generic | us_ca | uk_au | india | dach | eu | sg): the caller's
 * own country when it names one (a posting's country is the role's), then the research's role country,
 * the website's ccTLD, the research's HQ country, a region word in the caller's country ("Europe"),
 * then 'generic'. One chain — regionFromCountry.resolveRegion, which designFit.regionFor also uses.
 * NEVER throws. Accepts sanitised conventions, a raw answer, or null.
 */
function regionForConventions(conventions, { country = null, website = null } = {}) {
  try {
    const c = conventions && typeof conventions === 'object' && !Array.isArray(conventions) ? conventions : null;
    const r = regionUtil.resolveRegion({
      country: typeof country === 'string' ? country : '',
      website: typeof website === 'string' ? website : '',
      conventions: c ? { hqCountry: c.hqCountry || c.hq_country || null, roleCountry: c.roleCountry || c.role_country || null } : null,
    });
    return typeof r === 'string' && r ? r : 'generic';
  } catch {
    return 'generic';
  }
}

module.exports = {
  RESEARCH_REV,
  domainKeyOf,
  getEmployerResearch,
  researchPromptBlock,
  conventionsPromptBlock,
  regionForConventions,
  brandOf,
  // A stored document's way to the row's brand (read-only; see the function) — never part of a build.
  cachedBrandFor,
  // The one grounded conventions call. Looked up through module.exports on every use, so a test can
  // replace it (like getEmployerResearch in test-employer-letter.js) without stubbing the Gemini SDK.
  researchConventions,
  // The website read and the Google Fonts yes/no — the same way, so a test needs no network.
  researchBrand,
  googleFontCheck,
  // exposed for tests / diagnostics only
  sanitiseResearch,
  sanitiseConventions,
  sanitiseBrand,
  _internals: { conventionsPrompt, parseModelJson, groundedHostsOf, sourcesOf, readCache, writeCache, patchConventions, patchBrand, flightFor, brandCallFor, withBrand, withResearcherFont },
  _reset() { inflight.clear(); conventionsInflight.clear(); brandInflight.clear(); brandMemo.clear(); failedAt.clear(); lastDbWarnAt = 0; },
};
