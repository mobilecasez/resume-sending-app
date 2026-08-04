// ONE geo comparator for every ranked-jobs path — ADDITIVE, pure (no DB, no network, no AI).
//
// WHY THIS EXISTS
// The user's ask: "I live in France — French jobs first, and inside France the nearest ones first,
// then everywhere else." That has to hold in the feed, in search, in the admin match view, in the
// notification copy and in the nightly routine, so all of them now order through THIS file. Anything
// that orders matched jobs and does not call in here will disagree with the rest of the app.
//
// THE GUARD THAT MAKES IT SAFE (measured on production, 2026-08-04)
// France holds 899 active jobs; 5 of them are "Science & Research" (3 tagged country=France plus 2
// unpinned rows whose location says Paris). User 192 (Trainee Chemist, profile country France)
// would, under an unconditional country-first sort, get 899 Paris software and sales listings ahead
// of the Swedish and US chemistry roles that actually fit him — strictly worse than today. He is why
// the floor is a feed page and not a handful. So country-first is CONDITIONAL: it turns on only when the user's own field
// actually has jobs in their country (MIN_FIELD_JOBS). Otherwise we fall back to field/match-first
// across countries, with geography as a tie-break inside a match band, and we hand the caller a
// short honest line to show ("No Science & Research roles in France yet — showing the closest
// matches elsewhere."). We never silently reorder.
//
// HOW "NEAREST" IS BUILT
// global_jobs.location is free text ("Paris", "Paris, Paris, France", "All France (remote)") and
// there is no city column and no lat/long anywhere in the schema. So distance is a TIER off the
// location string — same city, same region, same country — and nothing more. No coordinates are
// invented and no geocoding dependency is added. Remote/anywhere markers count as the whole country
// (an "All France (remote)" role is not "far" from Paris).
//
// TWO EXECUTIONS, ONE DEFINITION
// Every ranked path is a SQL ORDER BY, but the tests (and any in-memory list) need JS. Both are
// generated from the SAME predicates in this file — the country regexes come from jobLocation.js
// (the repo's existing "which country is this location in" source of truth), the city test is the
// same word-boundary match on the same de-accented string. tools/test-geo-rank.js asserts the JS
// side; tools/geo-rank-prod-check.js re-checks SQL == JS on real production rows.
'use strict';

const { COUNTRY_PATTERNS, countryFromLocation } = require('./jobLocation');

// Tier 0 is nearest. UNKNOWN is what every job gets when we have no anchor at all — it makes the
// geo term a no-op rather than a guess.
const TIER = { CITY: 0, REGION: 1, COUNTRY: 2, OPEN_REMOTE: 3, ELSEWHERE: 4, UNKNOWN: 5 };
const TIER_LABEL = ['same city', 'same region', 'same country', 'remote (no country)', 'other country', 'no anchor'];

// How many jobs the user's own field needs in the user's own country before country-first is
// allowed. The number is ONE FEED PAGE (20): country-first reorders a pool that is not always
// field-scoped, so if the user's field cannot even fill the first page at home, "your country
// first" mostly means "other people's jobs first". Measured on production: France holds 5 Science &
// Research jobs (user 192's field) against 231 in IT & Software — a floor of 5 would have switched
// country-first ON for the chemist and buried him under 899 Paris software and sales listings,
// which is the exact failure this guard exists to prevent.
const MIN_FIELD_JOBS = Math.max(1, parseInt(process.env.GEO_MIN_FIELD_JOBS || '20', 10));

// Same de-accent pair discoverController already uses, so "Zürich" and "Zurich" compare equal on
// both sides (JS String.replace / SQL translate()).
const DEACC_FROM = 'üäöéèêàâçñ';
const DEACC_TO = 'uaoeeeaacn';
function deaccent(s) { return String(s || '').replace(/[üäöéèêàâçñ]/g, (m) => DEACC_TO[DEACC_FROM.indexOf(m)] || m); }

// Location labels that mean "no particular country" — global_jobs.country holds these for boards we
// could not pin down. They are the ONLY rows where we fall back to reading the location text for a
// country, because resolveCountry() already derived the label from the location for everything else.
const OPEN_LABELS = new Set(['', 'global', 'eu', 'europe', 'worldwide', 'remote', 'anywhere', 'international']);

// Remote markers. Shared source string: JS RegExp and Postgres ~* parse this identically (plain
// alternation, no back-references, no word-boundary escapes).
const REMOTE_SRC = '(remote|anywhere|work ?from ?home|home ?office|teletravail|télétravail|worldwide|fully ?distributed)';
const REMOTE_RE = new RegExp(REMOTE_SRC, 'i');

// Canonical country label → every spelling that means it. global_jobs.country stores the short label
// ('US', 'UK', 'UAE'); users.country is whatever the person typed ('United States', 'France').
const LABEL_ALIASES = {
  US: ['us', 'usa', 'u.s.', 'u.s.a.', 'united states', 'united states of america', 'america'],
  UK: ['uk', 'gb', 'britain', 'great britain', 'united kingdom', 'england', 'scotland', 'wales'],
  UAE: ['uae', 'united arab emirates', 'emirates'],
  Germany: ['germany', 'deutschland'],
  Netherlands: ['netherlands', 'holland', 'nederland'],
  Spain: ['spain', 'españa', 'espana'],
  Italy: ['italy', 'italia'],
  Sweden: ['sweden', 'sverige'],
  Norway: ['norway', 'norge'],
  Denmark: ['denmark', 'danmark'],
  Finland: ['finland', 'suomi'],
  Poland: ['poland', 'polska'],
  Austria: ['austria', 'österreich', 'osterreich'],
  Switzerland: ['switzerland', 'schweiz', 'suisse', 'svizzera'],
  Czechia: ['czechia', 'czech republic', 'czech'],
  Turkey: ['turkey', 'türkiye', 'turkiye'],
  Brazil: ['brazil', 'brasil'],
  Mexico: ['mexico', 'méxico'],
  'South Korea': ['south korea', 'korea', 'republic of korea'],
};
// Every label in jobLocation's table is also its own alias.
const LABEL_OF = new Map();
for (const [name] of COUNTRY_PATTERNS) LABEL_OF.set(name.toLowerCase(), name);
for (const [label, aliases] of Object.entries(LABEL_ALIASES)) for (const a of aliases) LABEL_OF.set(a, label);

const PATTERN_OF = new Map(COUNTRY_PATTERNS.map(([name, re]) => [name, re]));

/**
 * The canonical country label for any free-text country/location, or null.
 * 'France' → 'France' · 'united states' → 'US' · 'Paris, France' → 'France' · 'Global' → null.
 */
function canonCountry(text) {
  const s = String(text || '').trim().toLowerCase();
  if (!s || OPEN_LABELS.has(s)) return null;
  if (LABEL_OF.has(s)) return LABEL_OF.get(s);
  return countryFromLocation(s) || null;   // reads a country out of a longer location/address string
}

/**
 * Is this string a country NAME? Deliberately narrower than canonCountry(), which also resolves
 * cities ("Amsterdam" → Netherlands). Used to stop a one-line address that is only a country from
 * being mistaken for a city.
 */
function isCountryName(text) {
  const s = String(text || '').trim().toLowerCase();
  return !!s && (LABEL_OF.has(s) || OPEN_LABELS.has(s));
}

/** Every lowercase spelling of a canonical label — for `lower(country) = ANY(...)`. */
function countryLabels(label) {
  const out = new Set();
  if (!label) return [];
  out.add(String(label).toLowerCase());
  for (const [alias, canon] of LABEL_OF) if (canon === label) out.add(alias);
  return [...out];
}

// jobLocation's country regex, in a form BOTH engines accept: Postgres spells the word boundary \y,
// JavaScript spells it \b. Everything else in those patterns (char classes, alternation) is shared.
function countryRegexSrc(label, dialect) {
  const re = PATTERN_OF.get(label);
  const src = re ? re.source : '(?!)';
  return dialect === 'sql' ? src.replace(/\\b/g, '\\y') : src;
}
const _reCache = new Map();
function countryRe(label) {
  if (!_reCache.has(label)) _reCache.set(label, new RegExp(countryRegexSrc(label, 'js'), 'i'));
  return _reCache.get(label);
}

function escRe(s) { return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
/** Word-boundary pattern for a city/region name, on the de-accented lowercase location. */
function placePatternSrc(name, dialect) {
  const b = dialect === 'sql' ? '\\y' : '\\b';
  return b + escRe(deaccent(String(name || '').trim().toLowerCase())) + b;
}
const _placeCache = new Map();
function placeRe(name) {
  const k = String(name || '').toLowerCase();
  if (!_placeCache.has(k)) _placeCache.set(k, new RegExp(placePatternSrc(name, 'js'), 'i'));
  return _placeCache.get(k);
}

/**
 * A postal code is not a city. The city test is a WORD-BOUNDARY match on the job's location text,
 * so "75001 Paris" (the segment a French address actually yields) can never match a job stored as
 * "Paris, France" — the city tier would be permanently inert while the API still reported
 * `city: "75001 Paris", cityKnown: true` and the admin line still read "country-first from 75001
 * Paris, France". A city we can never match must not be advertised as one, so the code is stripped
 * before the guess is accepted:
 *   "75001 Paris" → "Paris" · "1017 CE Amsterdam" → "Amsterdam" · "London EC1A 1BB" → "London"
 * A short leading token is only dropped when a code was actually removed in front of it, so
 * "St Albans" and "Le Mans" survive intact. Returns '' when nothing with letters is left.
 */
function stripPostcode(text) {
  const toks = String(text || '').trim().split(/\s+/).filter(Boolean);
  const out = [];
  let droppedCode = false;
  for (const t of toks) {
    if (/\d/.test(t)) { droppedCode = true; continue; }          // 75001, EC1A, 1BB, 1017
    if (droppedCode && !out.length && t.replace(/[^a-zà-ÿ]/gi, '').length <= 2) continue;   // the "CE" of "1017 CE"
    out.push(t);
  }
  const s = out.join(' ').replace(/^[\s,.\-]+|[\s,.\-]+$/g, '');
  return /[a-zà-ÿ]/i.test(s) ? s : '';
}

// ─────────────────────────────────────────────────────────────────────────────
// The anchor: where the user actually is, using ONLY what they told us
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ users.city is NULL for 186/186 live accounts, so the city tier is inert today and this MUST
// degrade to country-level ordering instead of pretending to know proximity.
// ⚠️ We do NOT read a city out of an address whose own country disagrees with the anchor country.
// User 192 is the reason: profile country = France, address = "Kumbakonam" (India). Anchoring him
// to Kumbakonam would rank Indian jobs first for a man who told us he lives in France.
// ⚠️ We do NOT use the phone dial code. The same user carries an Indian number in France; a dial
// code says where a SIM was bought, not where somebody lives.
function buildAnchor({ user, resumeMeta } = {}) {
  const u = user || {};
  const out = { country: null, countrySource: null, city: null, region: null, citySource: null, cityRejected: null };

  const fromProfile = canonCountry(u.country);
  const fromAddress = fromProfile ? null : canonCountry(u.address);
  const head = resumeMeta && resumeMeta.raw_text ? String(resumeMeta.raw_text).slice(0, 600) : '';
  const fromResume = (fromProfile || fromAddress) ? null : canonCountry(head);
  if (fromProfile) { out.country = fromProfile; out.countrySource = 'profile'; }
  else if (fromAddress) { out.country = fromAddress; out.countrySource = 'address'; }
  else if (fromResume) { out.country = fromResume; out.countrySource = 'resume-header'; }
  if (!out.country) return out;

  // City. An explicit users.city is taken at face value ("I live here"); a city read out of the
  // free-text address is only taken when that address ALSO names the anchor country.
  const explicitCity = String(u.city || '').trim();
  if (explicitCity) {
    const parts = explicitCity.split(',').map((s) => s.trim()).filter(Boolean);
    out.city = parts[0];
    if (parts.length > 1) out.region = parts[1];
    out.citySource = 'profile';
    return out;
  }
  const addr = String(u.address || '').trim();
  if (addr) {
    const addrCountry = canonCountry(addr);
    const segs = addr.split(',').map((s) => s.trim()).filter(Boolean);
    const rawGuess = segs.length >= 2 ? segs[segs.length - 2] : segs[0];
    // A postal code is not a city — "75001 Paris" has to become "Paris" or the city tier can never
    // fire while the API keeps reporting a city (see stripPostcode).
    const guess = stripPostcode(rawGuess);
    // A one-line address that is just the country ("Netherlands") must not become a "city" —
    // everything in the country would then read as "same city", which is a claim we cannot make.
    const guessIsCountry = isCountryName(guess);
    if (addrCountry && addrCountry === out.country && guess && !guessIsCountry) { out.city = guess; out.citySource = 'address'; }
    else if (rawGuess) {
      // ⚠️ Each branch must name the reason it actually took. Saying "the address is in France, but
      // the profile country is France" (what the country-name branch used to report) is worse than
      // silence: it reads as a bug in the anchor rather than as the deliberate refusal it is.
      let reason;
      if (!guess) reason = `"${rawGuess}" is a postal code, not a place we can match against a job location`;
      else if (guessIsCountry) reason = `"${guess}" is the country itself, not a city inside it`;
      else if (!addrCountry) reason = `the address does not name ${out.country}, so we cannot tell it is a ${out.country} address`;
      else reason = `the address is in ${addrCountry}, but the profile country is ${out.country}`;
      out.cityRejected = { value: guess || rawGuess, reason };
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// The tier — JS side. tierSql() below is the same decision in SQL.
// ─────────────────────────────────────────────────────────────────────────────
function tierOf(job, anchor) {
  if (!anchor || !anchor.country) return TIER.UNKNOWN;
  const loc = String((job && job.location) || '').toLowerCase();
  const flat = deaccent(loc);
  const ctry = String((job && job.country) || '').trim().toLowerCase();
  const labelled = !OPEN_LABELS.has(ctry);
  const same = labelled ? countryLabels(anchor.country).includes(ctry) : countryRe(anchor.country).test(loc);
  if (same) {
    if (anchor.city && placeRe(anchor.city).test(flat)) return TIER.CITY;
    if (anchor.region && placeRe(anchor.region).test(flat)) return TIER.REGION;
    return TIER.COUNTRY;
  }
  if (!labelled && REMOTE_RE.test(loc)) return TIER.OPEN_REMOTE;
  return TIER.ELSEWHERE;
}

// ─────────────────────────────────────────────────────────────────────────────
// The comparator
// ─────────────────────────────────────────────────────────────────────────────
function numOrNull(v) { const n = Number(v); return v == null || Number.isNaN(n) ? null : n; }
function band(m) { return m == null ? -1 : Math.floor(m / 10); }   // 10-point match band; null sorts last
function cmpMatch(a, b) {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return b - a;
}

/**
 * Returns <0 if a should come first. 0 means "these are equal on geo+match" — callers keep their own
 * tie-breaks (per-employer round-robin, recency) after this.
 *   country-first : your country, nearest first, best match inside each tier.
 *   match-first   : best match first, but geography breaks ties inside a 10-point match band, so
 *                   "the closest matches elsewhere" is literally true.
 */
function compare(a, b, ctx) {
  const mode = (ctx && ctx.mode) || 'match-first';
  const anchor = (ctx && ctx.anchor) || null;
  const ta = tierOf(a, anchor), tb = tierOf(b, anchor);
  const ma = numOrNull(a && a.match), mb = numOrNull(b && b.match);
  if (mode === 'country-first') {
    if (ta !== tb) return ta - tb;
    return cmpMatch(ma, mb);
  }
  const ba = band(ma), bb = band(mb);
  if (ba !== bb) return bb - ba;
  if (ta !== tb) return ta - tb;
  return cmpMatch(ma, mb);
}

/** Stable sort of an in-memory list with the same comparator (used for cards outside global_jobs). */
function rank(jobs, ctx) {
  return (jobs || [])
    .map((j, i) => [j, i])
    .sort((x, y) => compare(x[0], y[0], ctx) || (x[1] - y[1]))
    .map((p) => p[0]);
}

// ─────────────────────────────────────────────────────────────────────────────
// The SQL side of the very same rules
// ─────────────────────────────────────────────────────────────────────────────
function lit(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

/**
 * `<location/country columns> is in the anchor's country` as a SQL boolean.
 * @param P a caller-supplied param binder returning '$n' (every value is bound, never inlined).
 */
function sameCountrySql(anchor, P, opts = {}) {
  if (!anchor || !anchor.country) return 'FALSE';
  const locationCol = opts.locationCol || 'location';
  const countryCol = opts.countryCol || null;
  const locLower = `lower(coalesce(${locationCol}, ''))`;
  const ctryLower = countryCol ? `lower(coalesce(${countryCol}, ''))` : `''`;
  const pLabels = P(countryLabels(anchor.country));
  const pOpen = P([...OPEN_LABELS]);
  const pRe = P(countryRegexSrc(anchor.country, 'sql'));
  // A row with a real country label is judged on the label ALONE — the label was already derived
  // from this very location text at ingest (jobLocation.resolveCountry), so re-reading the text can
  // only add false positives ("Paris, Texas"). Only the unpinned rows ('Global', 'EU', empty) get
  // the location regex.
  return `(CASE WHEN ${ctryLower} = ANY(${pOpen}::text[]) THEN ${locLower} ~* ${pRe}
                ELSE ${ctryLower} = ANY(${pLabels}::text[]) END)`;
}

/** The tier as a SQL integer expression — mirrors tierOf() branch for branch. */
function tierSql(anchor, P, opts = {}) {
  // ⚠️ Parenthesised + cast on purpose. A BARE integer in a Postgres ORDER BY is an ORDINAL column
  // reference, so returning "5" for an anchorless user would silently sort the whole list by its
  // 5th column. `(5)::int` is a constant in every position.
  if (!anchor || !anchor.country) return `(${TIER.UNKNOWN})::int`;
  const locationCol = opts.locationCol || 'location';
  const countryCol = opts.countryCol || null;
  const locLower = `lower(coalesce(${locationCol}, ''))`;
  const ctryLower = countryCol ? `lower(coalesce(${countryCol}, ''))` : `''`;
  const flat = `translate(${locLower}, ${lit(DEACC_FROM)}, ${lit(DEACC_TO)})`;
  const same = sameCountrySql(anchor, P, opts);
  const pOpen = P([...OPEN_LABELS]);
  const pRemote = P(REMOTE_SRC);
  const cityWhen = anchor.city ? `WHEN ${same} AND ${flat} ~* ${P(placePatternSrc(anchor.city, 'sql'))} THEN ${TIER.CITY}\n         ` : '';
  const regionWhen = anchor.region ? `WHEN ${same} AND ${flat} ~* ${P(placePatternSrc(anchor.region, 'sql'))} THEN ${TIER.REGION}\n         ` : '';
  return `(CASE ${cityWhen}${regionWhen}WHEN ${same} THEN ${TIER.COUNTRY}
         WHEN ${ctryLower} = ANY(${pOpen}::text[]) AND ${locLower} ~* ${pRemote} THEN ${TIER.OPEN_REMOTE}
         ELSE ${TIER.ELSEWHERE} END)`;
}

/**
 * The ORDER BY fragment, from the same two rules as compare(). Callers append their own tie-breaks
 * (per-employer rn, last_seen) after it.
 */
function orderSql(mode, opts = {}) {
  const tier = opts.tier || 'geo_tier';
  const match = opts.match || 'match';
  if (mode === 'country-first') return `${tier} ASC, ${match} DESC NULLS LAST`;
  return `floor(coalesce(${match}, -10)::numeric / 10) DESC, ${tier} ASC, ${match} DESC NULLS LAST`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The mode decision + the honest line that goes with it
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @param fieldJobsInCountry how many ACTIVE jobs the user's own field has in the user's own country;
 *        null means "we could not count" → we keep today's behaviour rather than guess.
 */
function decideMode({ anchor, field = null, fieldJobsInCountry = null, minFieldJobs = MIN_FIELD_JOBS } = {}) {
  const a = anchor || {};
  if (!a.country) {
    return { mode: 'match-first', notice: null, reason: 'no country on file for this user — geo ranking is off' };
  }
  if (!field) {
    return { mode: 'country-first', notice: null, reason: `no résumé field to check, so ${a.country} jobs simply come first` };
  }
  if (fieldJobsInCountry == null) {
    return { mode: 'match-first', notice: null, reason: 'could not count this field in this country — left the existing order alone' };
  }
  if (fieldJobsInCountry < minFieldJobs) {
    const none = fieldJobsInCountry === 0;
    return {
      mode: 'match-first',
      notice: none
        ? `No ${field} roles in ${a.country} yet — showing the closest matches elsewhere.`
        : `Only ${fieldJobsInCountry} ${field} role${fieldJobsInCountry === 1 ? '' : 's'} in ${a.country} so far — showing the closest matches elsewhere too.`,
      reason: `${fieldJobsInCountry} ${field} jobs in ${a.country} is below the ${minFieldJobs}-job floor`,
    };
  }
  return {
    mode: 'country-first',
    notice: null,
    reason: `${fieldJobsInCountry} ${field} jobs in ${a.country} — country-first is worth it`,
  };
}

/** What geo ranking is doing, in one line, for logs and admin views. */
function describe(ctx) {
  if (!ctx || !ctx.anchor || !ctx.anchor.country) return 'geo ranking off (no country on file)';
  const a = ctx.anchor;
  const where = a.city ? `${a.city}, ${a.country}` : a.country;
  return `${ctx.mode} from ${where} (country via ${a.countrySource}`
    + (a.city ? `, city via ${a.citySource}` : ', no city on file')
    + `) — ${ctx.reason}`;
}

// A context that switches every caller back to exactly today's ordering.
const INACTIVE = Object.freeze({
  active: false, mode: 'match-first', anchor: null, notice: null, field: null,
  fieldJobsInCountry: null, reason: 'geo ranking not resolved',
});

module.exports = {
  TIER, TIER_LABEL, MIN_FIELD_JOBS, INACTIVE, OPEN_LABELS, REMOTE_SRC, DEACC_FROM, DEACC_TO,
  deaccent, canonCountry, isCountryName, countryLabels, countryRegexSrc, placePatternSrc, stripPostcode,
  buildAnchor, tierOf, compare, rank, band,
  sameCountrySql, tierSql, orderSql,
  decideMode, describe,
};
