// Company name → official WEBSITE, from free keyless public lookups. ADDITIVE.
//
// WHY THIS EXISTS. Building a résumé or a cover letter for an employer needs the employer's
// website — a bare name is not enough, and a job posting is not a substitute. The Add-employer
// sheet searches GET /discover/employers, which only knows employers we have already stored
// (`employers`, `global_jobs`). Nordex SE — a 10,000-employee company — has a row in neither, so
// there was no website to show. This module asks the open web instead:
//   1. Clearbit company autocomplete (primary) — measured: "nordex" → Nordex SE, nordex-online.com.
//   2. Wikidata search + P31 "is an organisation" + P856 "official website" (fallback) — ONLY when
//      Clearbit errors, times out, or its circuit breaker is open. An empty Clearbit list is an
//      ANSWER, not a failure, and does not trigger it.
//
// ⚠️ A RESOLVER THAT FINDS NOTHING SAYS NOTHING. aiHubController.resolveCareersUrl falls back to
// FABRICATING https://www.{slug}.com — for Nordex that is nordex.com, a different company. Nothing
// here guesses a domain: every hit is a domain an upstream actually returned for a name.
//
// ⚠️ PRIVACY — THE FIRST PLACE THIS APP SENDS TYPED INPUT TO A THIRD-PARTY COMPANY-LOOKUP SERVICE.
// Exactly one thing leaves the server: the company-name query string. No user id, no token, no
// email, no client IP (nothing is forwarded — no X-Forwarded-For, no request headers copied), and
// the User-Agent names the app, not the user. Keep it that way: never pass `req` into this module.
// ⚠️ The caller cannot keep that promise for us — the sheet's box also receives pasted emails,
// posting URLs and job-description text. companyNameIn() below is where it is ENFORCED.
//
// ⚠️ NEVER THROWS. Every failure — network, timeout, rate limit, a changed response shape —
// resolves to { hits: [], status: 'unavailable' }. Four statuses, so the caller never tells a
// user "no website exists" on the strength of a lookup that did not really happen:
//   'ok'          — the primary provider answered; an empty list means no website was found.
//   'degraded'    — Clearbit was down/skipped and the Wikidata FALLBACK answered. Its hits are real
//                   official websites but a weaker match, and an EMPTY degraded list proves nothing:
//                   treat it like 'unavailable' for the "no website found" message.
//   'unavailable' — neither provider could be asked (errors, both circuit breakers open, or the
//                   fallback rate limit is spent).
//   'refused'     — the privacy gate would not send the input anywhere (an email, a URL, prose).
//                   The app maps every status it does not know to 'unavailable', so it reads this
//                   one that way too — never as "no website found".
//
// ⚠️ ONE WALL-CLOCK BUDGET FOR THE WHOLE LOOKUP. The sheet calls this on a keystroke debounce, so a
// slow upstream is a frozen sheet. Per-call caps (2.5s Clearbit, 3s each Wikidata call) are clamped
// to what is left of a 4.5s budget, and a call that would get less than MIN_CALL_MS is not made.
// axios `timeout` alone is a socket-IDLE timer (a slow-dripping body outlives it), so every call
// also carries an AbortSignal — that is the hard cap.
'use strict';

const axios = require('axios');
// ⚠️ ONE answer to "is this the same company?" — the download pass owns it. Used here only to strip
// a trailing legal suffix for the retry below, never as a second normaliser. Requiring it loads
// db-config, which exits without DATABASE_URL: a test that requires this module sets a dummy
// DATABASE_URL first, the way test-live-forms.js already does for aiHubController.
const { sameEmployer } = require('./downloads');

const CLEARBIT_URL = 'https://autocomplete.clearbit.com/v1/companies/suggest';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
// Wikimedia REQUIRES a descriptive User-Agent with contact information, or it may block the IP.
const UA = 'CVApplyrBot/1.0 (https://cvapplyr.com; company-website lookup) axios/1';

const BUDGET_MS = 4500;
const CLEARBIT_TIMEOUT_MS = 2500;
const WIKIDATA_TIMEOUT_MS = 3000;
const MIN_CALL_MS = 250;
const MAX_QUERY = 64;   // "Deutsche Gesellschaft für Internationale Zusammenarbeit GmbH" is 60
const MAX_WORDS = 6;
const MIN_QUERY = 2;
const WIKIDATA_CANDIDATES = 5;
// ⚠️ While Clearbit's breaker is open EVERY uncached keystroke lands on Wikimedia, so the fan-out
// shrinks: 1 search + <=3 P31 + <=3 P856 = <=7 calls a lookup (was <=11; 7-9 measured live).
const WIKIDATA_CANDIDATES_OUTAGE = 3;
const MAX_BODY = 1024 * 1024;   // real answers are < 10 KB; anything near this is not the API we called

// ── domains ─────────────────────────────────────────────────────────────────────────────────────
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/**
 * A website as a bare hostname: lowercase, no scheme, no leading "www.", no path/query/port —
 * or null when it is not a plausible public hostname.
 *
 * ⚠️ Our own tables store things in `domain` columns that are NOT domains: synthetic identity keys
 * ("web-acme", "linkedin-acme", "search:software-engineer") and name slugs ("nordex-se"). Requiring
 * a dotted hostname with an alphabetic TLD is what keeps those from being shown as a website.
 */
function normaliseDomain(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || /[\s@]/.test(s)) return null;
  let host;
  try {
    // URL does the hard parts (userinfo, port, IPv6 brackets, IDN → punycode).
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'http://' + s.replace(/^\/+/, '')).hostname;
  } catch { return null; }
  host = host.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  if (!host || host.length > 253) return null;
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l)) || !TLD.test(labels[labels.length - 1])) return null;
  return host;
}

function cleanName(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 120); }

/** Drop hits with no name or no plausible domain; one hit per domain, upstream order kept. */
function tidy(raw) {
  const out = [];
  const seen = new Set();
  for (const h of raw) {
    const name = cleanName(h && h.name);
    const domain = normaliseDomain(h && h.domain);
    if (!name || !domain || seen.has(domain)) continue;
    seen.add(domain);
    const logo = h && typeof h.logo === 'string' && /^https:\/\//i.test(h.logo) ? h.logo : null;
    out.push(Object.freeze({ name, domain, logo }));
  }
  return out;
}

// ── HTTP ────────────────────────────────────────────────────────────────────────────────────────
async function getJson(url, params, cap, deadline) {
  const ms = Math.min(cap, deadline - Date.now());
  // Tagged: running out of OUR budget says nothing about the upstream's health, so a breaker
  // must not trip on it (a slow Clearbit would otherwise shut Wikidata off too).
  if (ms < MIN_CALL_MS) throw Object.assign(new Error('lookup budget spent'), { budget: true });
  try {
    const { data } = await axios.get(url, {
      params,
      timeout: ms,
      signal: AbortSignal.timeout(ms),
      maxContentLength: MAX_BODY,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    return data;
  } catch (e) {
    // ⚠️ A CLAMPED TIMEOUT IS OURS TOO. When `ms` was cut below `cap` to fit the budget, a
    // cancel/timeout means "the call outlived what WE had left", not "the upstream is broken".
    // Untagged, it reached settle() as a real failure: Clearbit hanging 2.5s left a healthy 700ms
    // Wikidata ~1.3s for its claim calls, they aborted, and wikidata.fail() switched the fallback off
    // for 60s exactly when it was needed. A timeout at the FULL cap still counts — and once
    // Clearbit's breaker is open the fallback gets the whole budget, so its search runs at the full
    // cap and a genuinely hung Wikidata still trips its own breaker.
    if (ms < cap && e && (axios.isCancel(e) || e.name === 'AbortError' || e.name === 'TimeoutError'
      || e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT' || e.code === 'ERR_CANCELED')) e.budget = true;
    throw e;
  }
}

async function fromClearbit(query, deadline) {
  const data = await getJson(CLEARBIT_URL, { query }, CLEARBIT_TIMEOUT_MS, deadline);
  // A 200 that is not the array we know (an HTML error page, a changed API) is a FAILURE, not an
  // empty answer — reading it as "no companies" would tell the user no website exists.
  if (!Array.isArray(data)) throw new Error('clearbit: unexpected response shape');
  return tidy(data);
}

/** The item's official website (P856): the preferred-rank statement, else the first normal one. */
function officialSite(claimsData) {
  const list = (claimsData && claimsData.claims && claimsData.claims.P856) || [];
  const usable = list.filter((c) => c && c.rank !== 'deprecated'
    && c.mainsnak && c.mainsnak.snaktype === 'value' && c.mainsnak.datavalue);
  const best = usable.find((c) => c.rank === 'preferred') || usable[0];
  return best ? best.mainsnak.datavalue.value : null;
}

// P31 "instance of" values that make a search hit an EMPLOYER. Direct membership, not a subclass
// walk (that is a SPARQL query or a call per level). The first five are the generic classes; the
// rest are the classes real employers were measured to carry INSTEAD of them (2026-09-11):
// University of Oxford, Charité and the NHS carry none of the first five. Still missed: IKEA and
// Aldi (a "brand" / "store chain" — adding brand would admit products). This is the FALLBACK, and
// its empty answer is 'degraded', so a miss here never tells anyone the company has no website.
const EMPLOYER_CLASSES = new Set([
  'Q4830453',   // business
  'Q783794',    // company
  'Q43229',     // organization
  'Q891723',    // public company
  'Q6881511',   // enterprise
  'Q1589009',   // privately held company
  'Q658255',    // subsidiary company
  'Q167037',    // corporation
  'Q161726',    // multinational corporation
  'Q778575',    // conglomerate
  'Q21980538',  // commercial organization
  'Q22687',     // bank
  'Q2089936',   // consulting company
  'Q1058914',   // software company
  'Q163740',    // nonprofit organization
  'Q327333',    // government agency
  'Q3918',      // university
  'Q875538',    // public university
  'Q902104',    // private university
  'Q16917',     // hospital
  'Q1059324',   // university hospital
]);

function claimIds(claimsData, prop) {
  const list = (claimsData && claimsData.claims && claimsData.claims[prop]) || [];
  return list.filter((c) => c && c.rank !== 'deprecated' && c.mainsnak && c.mainsnak.snaktype === 'value'
    && c.mainsnak.datavalue && c.mainsnak.datavalue.value).map((c) => c.mainsnak.datavalue.value.id);
}

// Ask one property of each item in parallel. → [{ ok, d }] in item order; `budget` = every failure
// was our own budget running out (see getJson), not the upstream.
async function claimsFor(items, prop, deadline) {
  const res = await Promise.all(items.map((it) =>
    getJson(WIKIDATA_API, { action: 'wbgetclaims', entity: it.id, property: prop, format: 'json' },
      WIKIDATA_TIMEOUT_MS, deadline).then((d) => ({ ok: !!(d && d.claims), d }), (e) => ({ ok: false, budget: !!(e && e.budget) }))));
  const failures = res.filter((r) => !r.ok);
  // Every candidate failed: we learned nothing, and [] would read as "no website exists".
  if (failures.length === items.length) {
    throw Object.assign(new Error(`wikidata ${prop}: all requests failed`), { budget: failures.every((r) => r.budget) });
  }
  return { res, partial: failures.length > 0 };
}

// Wikidata search → P31 (is it an employer?) → P856 (its website), per candidate.
// ⚠️ NOT wbgetentities&props=claims for the batch: that returns EVERY claim, and for five search
// hits including Siemens it measured 540 KB / 3.1s — the whole budget. wbgetclaims filtered to one
// property is a few KB per item (~0.6s cold), so candidates are asked in parallel.
// ⚠️ SEARCH HITS ARE ITEMS, NOT COMPANIES, and many items have an official website: with only P856,
// "jordan" answered jordan.gov.ph (a Philippine municipality) and "paris" answered paris.fr and
// paristexas.gov. So P31 filters FIRST, and P856 is asked only for the survivors — for a place
// name that is zero website calls, which also keeps this fallback's Wikimedia load down.
// Returns { hits, partial } — partial = some candidates could not be asked, so do not cache it.
async function fromWikidata(query, deadline, candidates) {
  const s = await getJson(WIKIDATA_API, {
    action: 'wbsearchentities', search: query, language: 'en', uselang: 'en',
    type: 'item', limit: candidates, format: 'json',
  }, WIKIDATA_TIMEOUT_MS, deadline);
  if (!s || !Array.isArray(s.search)) throw new Error('wikidata search: unexpected response shape');
  const items = s.search.filter((it) => it && /^Q\d+$/.test(it.id) && it.label).slice(0, candidates);
  if (!items.length) return { hits: [], partial: false };

  const kinds = await claimsFor(items, 'P31', deadline);
  const employers = items.filter((it, i) => kinds.res[i].ok && claimIds(kinds.res[i].d, 'P31').some((id) => EMPLOYER_CLASSES.has(id)));
  if (!employers.length) return { hits: [], partial: kinds.partial };

  const sites = await claimsFor(employers, 'P856', deadline);
  const hits = tidy(employers.map((it, i) => ({ name: it.label, domain: sites.res[i].ok ? officialSite(sites.res[i].d) : null, logo: null })));
  return { hits, partial: kinds.partial || sites.partial };
}

// ⚠️ CLEARBIT MATCHES A PREFIX OF THE COMPANY'S NAME, SO A LEGAL SUFFIX THE NAME LACKS EMPTIES IT.
// Measured: "deutsche bank" → 5 hits, "deutsche bank ag" → []; "siemens ag" → []; "infosys
// limited" → []. People type the legal name they copied off a posting, and under rule (2) an
// empty answer tells them the company has no website. So an EMPTY answer is asked once more with
// the trailing legal words removed — only trailing ones, and only while the download pass's
// identity rule says it is still the same company ("bank of america" is left alone). A non-empty
// answer is never second-guessed: "booking holdings" finds Booking Holdings as typed, and
// stripping first would have returned Booking.com instead.
function withoutLegalSuffix(q) {
  let words = q.split(' ');
  while (words.length > 1 && sameEmployer(q, words.slice(0, -1).join(' '))) words = words.slice(0, -1);
  return words.join(' ').replace(/[\s,.;:&+-]+$/, '');
}

// ── cache ───────────────────────────────────────────────────────────────────────────────────────
// In-memory LRU (a Map in recency order). Acceptable because the upstreams are FREE: a deploy or a
// second replica starting cold costs a few 0.3s calls, not money, and nothing here is state a user
// owns. What it buys is the keystroke pattern — "nor", "nord", "norde" from many users, and the
// same user deleting and retyping.
// ⚠️ 'unavailable' is NEVER cached — a thirty-second Clearbit outage must not pin "lookup failed"
// on a query for hours. An empty answer is cached briefly (a company can be added upstream).
// A 'degraded' (fallback) answer is cached only when it has hits, and is SERVED only while the
// Clearbit breaker is still tripped: the first real Clearbit success retires every degraded entry
// at once. A degraded EMPTY answer is never cached — it would pin "no website found" on a query
// the primary provider never saw.
// ⚠️ The cache is not what stops an outage storm — every uncached keystroke is a new query. The
// circuit breakers and the fallback token bucket below are.
const CACHE_CAP = 1000;
const HIT_TTL_MS = 12 * 60 * 60 * 1000;
const SHORT_TTL_MS = 30 * 60 * 1000;
const cache = new Map();   // normalised query → { hits, status, exp }

function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  cache.delete(key);
  if (e.exp <= Date.now()) return null;
  if (e.status === 'degraded' && !clearbit.tripped()) return null;   // Clearbit is back: ask it
  cache.set(key, e);   // re-insert = most recently used
  return e;
}

function cachePut(key, hits, status, ttl) {
  cache.delete(key);
  cache.set(key, { hits, status, exp: Date.now() + ttl });
  while (cache.size > CACHE_CAP) cache.delete(cache.keys().next().value);
}

// ── circuit breakers ────────────────────────────────────────────────────────────────────────────
// ⚠️ WITHOUT THESE, AN OUTAGE IS A STORM. While Clearbit was down, every uncached keystroke from
// every user waited out its 2.5s timeout and then fired a Wikidata search plus the per-candidate
// claim calls — several Wikimedia requests PER KEYSTROKE, which is exactly the traffic Wikimedia's
// User-Agent policy says gets an IP blocked (and that would take the fallback down with it). And
// discoverEmployers awaits this alongside its DB queries, so ready DB rows were held back 4.5s.
// One failure trips a breaker for COOL_OFF_MS; while it is open the provider is not called at all.
// When the cool-off ends exactly ONE call probes — concurrent keystrokes keep skipping until that
// probe settles — and a success closes the breaker, a failure re-opens it for another cool-off.
const COOL_OFF_MS = 60 * 1000;

function breaker() {
  let openUntil = 0;     // > 0 = tripped; stays > 0 until a call SUCCEEDS, even after the cool-off
  let probing = false;
  return {
    tripped: () => openUntil > 0,
    /** true = make the call, and then report exactly one of ok() / fail() / release(). */
    allow() {
      if (!openUntil) return true;
      if (probing || Date.now() < openUntil) return false;
      probing = true;
      return true;
    },
    ok() { openUntil = 0; probing = false; },
    fail() { openUntil = Date.now() + COOL_OFF_MS; probing = false; },
    release() { probing = false; },   // no verdict (our budget ran out): let the next call probe
  };
}
const clearbit = breaker();
const wikidata = breaker();

/** Report a provider call's outcome to its breaker. A budget error is not the upstream's fault. */
function settle(br, e) { if (!e) br.ok(); else if (e.budget) br.release(); else br.fail(); }

// ── fallback rate limit ─────────────────────────────────────────────────────────────────────────
// ⚠️ THE BREAKERS ONLY REACT TO FAILURES. A long Clearbit outage with a HEALTHY Wikidata trips
// nothing on the Wikidata side, so every uncached keystroke from every user was still a fallback
// lookup — sustained per-keystroke Wikimedia traffic, the pattern its User-Agent policy warns can
// get the IP blocked (and a block takes the fallback down too). So fallback LOOKUPS draw from one
// process-wide token bucket: FALLBACK_PER_MIN refill, FALLBACK_BURST capacity. Empty bucket =
// 'unavailable' at once, no Wikimedia call. Numbers: 30 lookups/min x <=7 calls (outage fan-out) =
// <=210 Wikimedia requests/min (~3.5/s) per replica at worst, a burst of 10 lookups (<=70 calls)
// on top. Cached and in-flight-shared answers take no token. 'unavailable' is never cached and the
// client never reads it as "no website found", so a user who hits the cap just types again later.
const FALLBACK_PER_MIN = 30;
const FALLBACK_BURST = 10;
const fallbackBucket = { tokens: FALLBACK_BURST, at: Date.now() };

/** true = a token was taken. Refills continuously; never above the burst. */
function takeFallbackToken() {
  const now = Date.now();
  fallbackBucket.tokens = Math.min(FALLBACK_BURST, fallbackBucket.tokens + ((now - fallbackBucket.at) / 60000) * FALLBACK_PER_MIN);
  fallbackBucket.at = now;
  if (fallbackBucket.tokens < 1) return false;
  fallbackBucket.tokens -= 1;
  return true;
}

// ── privacy gate ────────────────────────────────────────────────────────────────────────────────
// ⚠️ THIS IS WHERE "ONLY THE COMPANY NAME LEAVES THE SERVER" IS ENFORCED — not in the controller,
// not in the app. The search box receives whatever is pasted into it: an email address, a posting
// URL carrying tracking / candidate tokens, a phone number, a paragraph of job description. None
// of that may reach Clearbit (HubSpot) or Wikidata. Anything that does not look like a company
// name is refused BEFORE the cache and before any outbound call:
//   '@'                 an email address
//   '/' (so '://'), '?', '='   a URL, path or query string
//   6+ digits           a phone, candidate/requisition id or account number — separators between
//                       the digits ("+49 151 2345-6789") do not hide it
//   > MAX_WORDS words   pasted prose
//   > MAX_QUERY chars   no real employer name is this long (the controller already cuts at 80, so
//                       a longer paste arrives truncated — truncation must not make it lookable)
// ⚠️ Refused queries answer 'refused' + [] — NEVER 'ok'. 'ok' + [] is the sheet's "no website found,
// add it" message, and a refusal looked nothing up. The app reads any status other than 'ok' /
// 'degraded' as 'unavailable' (AddEmployerSheet), which is the right message for a refusal too.
// A real name of 7+ words is refused; the sheet queries as the user types, so a shorter prefix of
// it was already looked up on the way there (and Clearbit matches prefixes).
// ⚠️ A '/' INSIDE A LEGAL FORM IS A NAME, NOT A PATH: Danish "A/S" (Novo Nordisk A/S, Maersk A/S,
// Vestas Wind Systems A/S), Brazilian "S/A" (Petrobras S/A), K/S, I/S, P/S, A/B, "c/o". The bare '/'
// test refused all of them as 'ok' + [] — "no website found" for Novo Nordisk. So a whitespace-
// delimited token of exactly letters/letters (1-2 each side) is removed and the REMAINDER is what
// gets checked and looked up. Only a whole token goes: "example.com/a/b" keeps its '/' and stays
// refused, and every '@ ? =', digit run and other '/' is tested on what remains. Length and word
// count are tested on the input AS RECEIVED, so stripping can never shrink a paste into lookability.
const SLASH_LEGAL_FORM = /(^| )[a-z]{1,2}\/[a-z]{1,2}[.,]?(?= |$)/g;

/** The lookable company name inside a normalised query, or null = refuse (make no call). */
function companyNameIn(q) {
  if (q.length > MAX_QUERY || q.split(' ').length > MAX_WORDS) return null;
  const core = q.replace(SLASH_LEGAL_FORM, ' ').replace(/ +/g, ' ').trim().replace(/[\s,.;:&+-]+$/, '');
  if (core.length < MIN_QUERY || /[@/?=]/.test(core) || /\d(?:[\s().-]*\d){5}/.test(core)) return null;
  return core;
}

// One warning per provider per minute: an upstream outage must not turn every keystroke into a
// log line. The QUERY is deliberately not logged.
const lastWarn = {};
function warn(provider, e) {
  const now = Date.now();
  if (now - (lastWarn[provider] || 0) < 60000) return;
  lastWarn[provider] = now;
  console.warn(`[companyLookup] ${provider} failed —`, e && e.message ? e.message : e);
}

// ── public ──────────────────────────────────────────────────────────────────────────────────────
/**
 * Look up the official website(s) for a typed company name.
 * @typedef {'ok'|'degraded'|'unavailable'|'refused'} LookupStatus
 * @returns {Promise<{ hits: Array<{name: string, domain: string, logo: string|null}>, status: LookupStatus }>}
 *   'ok' = Clearbit answered · 'degraded' = the Wikidata fallback answered (an empty list proves
 *   nothing — show it like 'unavailable') · 'unavailable' = no provider could be asked ·
 *   'refused' = the input is not a company name and was never sent anywhere (the client treats it
 *   exactly like 'unavailable' — it must never become "no website found").
 */
async function lookupWebsites(query) {
  try {
    const q = companyNameIn(String(query == null ? '' : query).replace(/\s+/g, ' ').trim().toLowerCase());
    if (!q) return { hits: [], status: 'refused' };

    const cached = cacheGet(q);
    if (cached) return { hits: cached.hits.map((h) => ({ ...h })), status: cached.status };

    // ⚠️ IN-FLIGHT DE-DUPLICATION: two users (or one user's retried debounce) asking the same query
    // at once share ONE upstream lookup. The cache is written inside the shared promise, before it
    // leaves the in-flight map, so there is no moment when a query is in neither.
    let pending = inflight.get(q);
    if (!pending) {
      pending = resolveWebsites(q)
        .then((r) => { if (r.ttl) cachePut(q, r.hits, r.status, r.ttl); return r; })
        .finally(() => inflight.delete(q));
      inflight.set(q, pending);
    }
    const r = await pending;
    return { hits: r.hits.map((h) => ({ ...h })), status: r.status };
  } catch (e) {
    warn('lookup', e);
    return { hits: [], status: 'unavailable' };
  }
}

const inflight = new Map();   // normalised query → Promise<{ hits, status, ttl }>

async function resolveWebsites(q) {
  const deadline = Date.now() + BUDGET_MS;
  if (clearbit.allow()) {
    try {
      let hits = await fromClearbit(q, deadline);
      if (!hits.length) {
        const core = withoutLegalSuffix(q);
        if (core.length >= MIN_QUERY && core !== q) hits = await fromClearbit(core, deadline);
      }
      settle(clearbit);
      return { hits, status: 'ok', ttl: hits.length ? HIT_TTL_MS : SHORT_TTL_MS };
    } catch (e) {
      settle(clearbit, e);
      warn('clearbit', e);
    }
  }
  // Clearbit failed or its breaker is open: straight to the fallback, no 2.5s wait.
  if (!wikidata.allow()) return { hits: [], status: 'unavailable', ttl: 0 };
  // Breaker first, bucket second: an OPEN breaker must not burn a token. release() hands back a
  // probe slot allow() may just have granted, since no call — so no verdict — follows.
  if (!takeFallbackToken()) { wikidata.release(); return { hits: [], status: 'unavailable', ttl: 0 }; }
  try {
    // As typed: Wikidata matches ALIASES, so "siemens ag" finds Siemens by its alias "Siemens AG".
    const wd = await fromWikidata(q, deadline, clearbit.tripped() ? WIKIDATA_CANDIDATES_OUTAGE : WIKIDATA_CANDIDATES);
    settle(wikidata);
    return { hits: wd.hits, status: 'degraded', ttl: wd.partial || !wd.hits.length ? 0 : SHORT_TTL_MS };
  } catch (e) {
    settle(wikidata, e);
    warn('wikidata', e);
    return { hits: [], status: 'unavailable', ttl: 0 };
  }
}

module.exports = { lookupWebsites, normaliseDomain };
