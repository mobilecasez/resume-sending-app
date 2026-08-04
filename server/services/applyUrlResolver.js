// Where is the actual application FORM? — ADDITIVE, vendor-neutral.
//
// WHY THIS EXISTS. An end-to-end audit of 50 random jobs from global_jobs found that Auto Fill
// could act on only ~32% of them — and almost none of the failures were the fill engine. 46% of our
// job_urls point at an AGGREGATOR (a national employment board or a job search site) whose page has
// no application form at all: it links out to the employer. Another handful point at an employer
// listing whose form sits one click further on. The engine was being blamed for never being handed
// a form.
//
// So this module answers two questions before Auto Fill is ever offered:
//   1. isAggregator(url)      — is this a listing site rather than an employer's own form?
//   2. resolveApplyUrl(url)   — where does the real form live?
//
// ⚠️ NOTHING HERE IS EMPLOYER-SPECIFIC. Aggregators are recognised by host, because a host IS the
// identity of a job board — but the RESOLUTION is structural: find the outbound link whose text or
// rel marks it as the application, on any page, in any language. No per-company selectors.
'use strict';

const dbConfig = require('../../db-config');

// Job boards and national employment agencies: their pages describe a job, they do not host its
// form. Measured share of our own corpus, so this list is drawn from what we actually store.
// Matched on the registrable host, suffix-wise, so subdomains count.
const AGGREGATOR_HOSTS = [
  // national / public employment services
  'arbetsformedlingen.se', 'arbeitsagentur.de', 'job-room.ch', 'jobs.ch', 'jobup.ch',
  'werkenbijdeoverheid.nl', 'pole-emploi.fr', 'francetravail.fr', 'sepe.es', 'nav.no',
  'jobnet.dk', 'te-palvelut.fi', 'tyomarkkinatori.fi', 'jobsplus.gov.mt',
  // commercial aggregators / search engines
  'indeed.com', 'linkedin.com', 'glassdoor.com', 'monster.com', 'stepstone.de', 'stepstone.com',
  'totaljobs.com', 'reed.co.uk', 'seek.com.au', 'naukri.com', 'yourfirm.de', 'xing.com',
  'jooble.org', 'adzuna.com', 'careerjet.com', 'neuvoo.com', 'talent.com', 'jobrapido.com',
  'simplyhired.com', 'ziprecruiter.com', 'glassdoor.co.uk', 'irishjobs.ie', 'jobsite.co.uk',
];

// Hosts that ARE the form — an ATS. Present so a resolver never "resolves" away from a good URL.
const ATS_HOSTS = [
  'greenhouse.io', 'lever.co', 'ashbyhq.com', 'myworkdayjobs.com', 'smartrecruiters.com',
  'personio.com', 'personio.de', 'recruitee.com', 'workable.com', 'teamtailor.com',
  'bamboohr.com', 'jobvite.com', 'successfactors.com', 'successfactors.eu', 'icims.com',
  'taleo.net', 'join.com', 'pinpointhq.com', 'talentadore.com', 'hrmdirect.com',
  'applytojob.com', 'breezy.hr', 'jazzhr.com', 'rippling.com', 'ashby.hq',
];

function hostOf(url) {
  try { return new URL(String(url)).hostname.replace(/^www\./i, '').toLowerCase(); }
  catch { return ''; }
}
const endsWithHost = (host, list) => list.some((h) => host === h || host.endsWith('.' + h));

/** Is this URL a job board / aggregator listing rather than an employer's application form? */
function isAggregator(url) { return endsWithHost(hostOf(url), AGGREGATOR_HOSTS); }
/** Is this URL already an applicant-tracking system, i.e. almost certainly the form itself? */
function isAts(url) { return endsWithHost(hostOf(url), ATS_HOSTS); }

/**
 * How likely is it that Auto Fill can do anything here? Used to set expectations in the UI instead
 * of letting someone tap "Auto Fill" on a page that has no form and conclude the feature is broken.
 *   'form'      — an ATS or a page we resolved to a form
 *   'listing'   — an employer listing; the form is probably one click away
 *   'aggregator'— a job board; the form is on someone else's site entirely
 */
function classify(url) {
  if (!url) return 'unknown';
  if (isAts(url)) return 'form';
  if (isAggregator(url)) return 'aggregator';
  return 'listing';
}

// ── finding the outbound application link, structurally ──────────────────────────────────────
// Link text that means "this is the application", across the languages our corpus actually spans.
// Deliberately anchored: "apply" must START the phrase, so "applied filters" and "how we apply
// your data" do not qualify.
const APPLY_TEXT = new RegExp([
  '^apply\\b', '^apply now', '^apply for', '^apply here', '^apply online', '^start application',
  '^submit application', '^i am interested', '^ansök', '^ansok', '^søk', '^søg', '^hae\\b',
  '^jetzt bewerben', '^bewerben', '^bewerbung', '^postuler', '^candidater', '^solicitar',
  '^candidatarsi', '^candidatura', '^solliciteer', '^sollicitatie', '^aplicar', '^zgłoś',
].join('|'), 'i');

/**
 * Extract the most likely application URL from a listing page's HTML.
 *
 * PURE and testable: takes html + the page's own URL, returns a URL or null. It never fetches.
 * Ranking, best first:
 *   1. a link to a KNOWN ATS host (unambiguous — that is where forms live)
 *   2. a link whose visible text reads as "apply", off-site
 *   3. a link whose text reads as "apply", same-site
 * A link back to the same page, or to a share/login/print URL, is never chosen.
 */
function extractApplyUrl(html, pageUrl) {
  const src = String(html || '');
  if (!src) return null;
  const base = String(pageUrl || '');
  const here = hostOf(base);
  const cands = [];
  // <a ...>text</a> — attribute order varies, so pull href and inner text separately.
  const re = /<a\b([^>]*)>([\s\S]{0,300}?)<\/a>/gi;
  let m;
  while ((m = re.exec(src)) && cands.length < 400) {
    const attrs = m[1] || '';
    const hrefM = attrs.match(/href\s*=\s*["']([^"']+)["']/i);
    if (!hrefM) continue;
    let href = hrefM[1].trim();
    if (!href || /^(#|javascript:|mailto:|tel:)/i.test(href)) continue;
    let abs;
    try { abs = new URL(href, base).toString(); } catch { continue; }
    if (abs.split('#')[0] === base.split('#')[0]) continue;                 // same page
    if (/\/(login|signin|register|share|print|privacy|cookie)/i.test(abs)) continue;
    const text = String(m[2] || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const aria = (attrs.match(/aria-label\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
    const label = (text || aria).slice(0, 120);
    const h = hostOf(abs);
    if (endsWithHost(h, ATS_HOSTS)) { cands.push({ url: abs, score: 100, why: 'links to an ATS', label }); continue; }
    if (APPLY_TEXT.test(label)) {
      cands.push({ url: abs, score: h && h !== here ? 60 : 40, why: 'apply link', label });
    }
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.score - a.score);
  return cands[0];
}

/**
 * Resolve a job URL to the page that actually holds the application form.
 *
 * Returns { url, kind, resolved, why }. `resolved` is false when the input was already a form (or
 * we could not do better) — the caller should still use `url`, it simply did not change.
 * Never throws; a failed fetch returns the original URL, because a broken resolver must not stop
 * someone opening their own job posting.
 */
async function resolveApplyUrl(jobUrl, opts = {}) {
  const url = String(jobUrl || '');
  const kind = classify(url);
  if (!url) return { url, kind: 'unknown', resolved: false, why: 'no url' };
  if (kind === 'form') return { url, kind, resolved: false, why: 'already an ATS form' };

  let html = '';
  try {
    const fetchText = opts.fetchText || defaultFetchText;
    html = await fetchText(url, opts.timeoutMs || 12000);
  } catch (e) {
    return { url, kind, resolved: false, why: 'fetch failed: ' + (e.message || '').slice(0, 80) };
  }
  const hit = extractApplyUrl(html, url);
  if (!hit) return { url, kind, resolved: false, why: 'no application link found on the page' };
  return { url: hit.url, kind: classify(hit.url), resolved: true, why: hit.why, via: hit.label, from: url };
}

async function defaultFetchText(url, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    return await r.text();
  } finally { clearTimeout(t); }
}

/** Cache a resolution so the same listing is not re-fetched for every user who opens it. */
async function rememberResolution(jobUrl, resolvedUrl) {
  if (!jobUrl || !resolvedUrl || jobUrl === resolvedUrl) return;
  try {
    await dbConfig.query(
      `INSERT INTO apply_url_resolutions (job_url, apply_url, resolved_at)
       VALUES ($1,$2,NOW())
       ON CONFLICT (job_url) DO UPDATE SET apply_url = EXCLUDED.apply_url, resolved_at = NOW()`,
      [String(jobUrl).slice(0, 500), String(resolvedUrl).slice(0, 500)]);
  } catch (e) { /* the cache is an optimisation; never let it break a resolution */ }
}
async function cachedResolution(jobUrl) {
  try {
    const r = await dbConfig.query(
      `SELECT apply_url FROM apply_url_resolutions WHERE job_url = $1 AND resolved_at > NOW() - INTERVAL '30 days'`,
      [String(jobUrl).slice(0, 500)]);
    return r && r[0] ? r[0].apply_url : null;
  } catch { return null; }
}

module.exports = {
  AGGREGATOR_HOSTS, ATS_HOSTS, APPLY_TEXT,
  hostOf, isAggregator, isAts, classify, extractApplyUrl, resolveApplyUrl,
  rememberResolution, cachedResolution,
};
