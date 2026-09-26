// WHERE DOES THIS EMPLOYER ACTUALLY LIST ITS JOBS?
//
// The Jobs page can now start from an EMPLOYER instead of a Google query: pick the company, and this
// answers with the pages worth opening — their openings on whatever ATS they use, their careers page,
// and, when the site says nothing, career URLs found in its sitemap. The user opens one in the same
// in-app browser as before and "Fetch job" works exactly as it does today. Nothing here saves, charges
// or researches anything: it reads a website and returns links.
//
// ⚠️ THIS FETCHES A URL THE USER CHOSE, so every request goes through brandExtract's fetcher, which is
// the one audited way this server touches a user-named site: https only at every hop, the host resolved
// first and every address checked as public (no loopback, private, CGNAT, link-local/metadata — in v4
// and v6), the socket pinned to those addresses so a rebind buys nothing, ≤3 redirects each re-checked,
// bodies capped and counted after decompression. A second fetcher here would be a second thing to get
// wrong, so there isn't one.
//
// ⚠️ EVERY LINK RETURNED IS EITHER ON THE EMPLOYER'S OWN SITE OR ON A KNOWN ATS. An employer page can
// link anywhere; handing the app "the jobs page we found" and having it be some third party's page is
// how a user ends up fetching a posting that has nothing to do with the employer they picked.
//
// ⚠️ IT IS ALL BOUNDED — one deadline over the whole answer, a handful of fetches, a capped scan of each
// document. It runs on the API's thread; an employer with a 5 MB homepage must not hold it.
'use strict';

const brand = require('./brandExtract');
const fetchCapped = brand._internals.fetchCapped;

const DEADLINE_MS = 9000;          // the whole answer, DNS and redirects included
const HTML_CAP = 900 * 1024;
const XML_CAP = 1.5 * 1024 * 1024;
const MAX_ANCHORS = 600;           // anchors read from one page
const MAX_SITEMAPS = 3;            // sitemap documents fetched
const MAX_SITEMAP_URLS = 4000;     // URLs read from one sitemap
const DEFAULT_LIMIT = 8;

// `accept` is a PREDICATE over the response's content type (brandExtract.requestOnce), not a string — a page
// that answers with a PDF, an image or a download is not a careers page and is never read.
const HTML_OK = (t) => !t || t === 'text/html' || t === 'application/xhtml+xml';
const XML_OK = (t) => !t || /^(text\/(xml|plain)|application\/(xml|rss\+xml|xhtml\+xml))$/.test(t);
const TEXT_OK = (t) => !t || /^text\//.test(t);

// "Careers", in the languages our users' employers actually use. Matched against a URL path and against
// link text, so both /karriere and <a>Karriere</a> are found.
const CAREER_WORDS = [
    'career', 'careers', 'jobs', 'job', 'vacancy', 'vacancies', 'openings', 'opening', 'opportunities',
    'join-us', 'join', 'work-with-us', 'work-for-us', 'working-at', 'life-at', 'recruit', 'recruitment',
    'hiring', 'apply', 'employment', 'talent', 'positions', 'roles',
    'karriere', 'karriar', 'karriär', 'stellen', 'stellenangebote', 'jobb', 'ledige-stillinger',
    'carriere', 'carrières', 'carrieres', 'emploi', 'emplois', 'offres-emploi', 'rejoignez-nous',
    'vacatures', 'werken-bij', 'empleo', 'empleos', 'trabaja-con-nosotros', 'unete',
    'lavora-con-noi', 'carriera', 'carreiras', 'vagas', 'trabalhe-conosco',
    'kariyer', 'kariera', 'praca', 'kariéra', 'jobbing', 'rekrytering', 'ansokan',
    '採用', '求人', '채용', '招聘', 'вакансии', 'карьера',
];
const WORD_RE = new RegExp(`(${CAREER_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'i');
// A path segment that IS one of those words (so /careers and /de/karriere hit, /careerbuilder-news does not).
const PATH_RE = new RegExp(`(^|[/_-])(${CAREER_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})([/_.-]|$)`, 'i');

// Hosts that ARE a job list: an employer linking to one is telling us where its openings live. Kept here
// rather than derived from utils/atsDiscovery's adapters — that module answers "parse this ATS", this one
// only needs "is this link a jobs list", and the two questions drift apart.
const ATS_HOSTS = [
    /(^|\.)greenhouse\.io$/i, /(^|\.)boards\.greenhouse\.io$/i, /(^|\.)lever\.co$/i, /(^|\.)jobs\.lever\.co$/i,
    /(^|\.)myworkdayjobs\.com$/i, /(^|\.)workday\.com$/i, /(^|\.)smartrecruiters\.com$/i,
    /(^|\.)successfactors\.(com|eu)$/i, /(^|\.)sapsf\.(com|eu)$/i, /(^|\.)recruitee\.com$/i,
    /(^|\.)personio\.(de|com)$/i, /(^|\.)jobs\.personio\.de$/i, /(^|\.)workable\.com$/i,
    /(^|\.)bamboohr\.com$/i, /(^|\.)teamtailor\.com$/i, /(^|\.)jobvite\.com$/i, /(^|\.)icims\.com$/i,
    /(^|\.)ashbyhq\.com$/i, /(^|\.)pinpointhq\.com$/i, /(^|\.)hrmdirect\.com$/i, /(^|\.)taleo\.net$/i,
    /(^|\.)oraclecloud\.com$/i, /(^|\.)eightfold\.ai$/i, /(^|\.)phenompeople\.com$/i, /(^|\.)avature\.net$/i,
    /(^|\.)comeet\.co$/i, /(^|\.)breezy\.hr$/i, /(^|\.)jazz\.co$/i, /(^|\.)applytojob\.com$/i,
    /(^|\.)zohorecruit\.com$/i, /(^|\.)freshteam\.com$/i, /(^|\.)darwinbox\.com$/i, /(^|\.)keka\.com$/i,
    /(^|\.)factorialhr\.com$/i, /(^|\.)join\.com$/i, /(^|\.)softgarden\.io$/i, /(^|\.)concludis\.de$/i,
    /(^|\.)rexx-systems\.com$/i, /(^|\.)dvinci\.de$/i, /(^|\.)talent\.com$/i, /(^|\.)eRecruiter\.net$/i,
];
const isAtsHost = (host) => ATS_HOSTS.some((re) => re.test(host));

// An employer's own job PORTAL usually lives on its own subdomain — jobs.acme.com, careers.acme.com.
// That is a job list, not a "careers" story page, and it belongs at the top of the answer.
const JOBS_SUB_RE = /^(jobs?|careers?|karriere|recruiting|recruitment|hiring|talent|apply|emploi|empleo|vagas)\./i;

// ⚠️ A WORD IS NOT A SECTION. "…/blog/active-directory-for-job-roles" matches the word list and is an
// article, not a way to apply — the first run offered exactly that. Anything written to be READ is out.
const EDITORIAL_RE = /(^|\/)(blog|news|press|pressroom|media|insights?|articles?|stories|resources?|events?|case-stud\w*|investor\w*|newsroom|magazine|podcast|webinar|report)(\/|$)/i;

/** The registrable-ish root, so www.acme.com, careers.acme.com and acme.com count as the same employer. */
function rootOf(host) {
    const p = String(host || '').toLowerCase().replace(/^www\./, '').split('.');
    if (p.length <= 2) return p.join('.');
    // Two-part public suffixes we actually meet (co.uk, com.au, co.in …) — a short list beats a wrong guess.
    const two = /^(co|com|org|net|gov|ac|edu)\.[a-z]{2}$/i.test(p.slice(-2).join('.'));
    return p.slice(two ? -3 : -2).join('.');
}

/** The employer's site as an https origin, or null when it is not a usable website. */
function originOf(site) {
    const raw = String(site || '').trim();
    if (!raw) return null;
    const withScheme = /^https?:\/\//i.test(raw) ? raw.replace(/^http:/i, 'https:') : `https://${raw}`;
    try {
        const u = new URL(withScheme);
        if (u.protocol !== 'https:' || !u.hostname.includes('.')) return null;
        // ⚠️ A WEBSITE IS A NAME, NEVER AN ADDRESS. `new URL('https://42')` resolves to the host 0.0.0.42, so a
        // stray number read as a "site" would send the fetcher at an IP. It would refuse that address anyway —
        // this makes the answer honest ("that is not a website") instead of "we could not reach it".
        const host = u.hostname.replace(/^\[|\]$/g, '');
        if (/^[0-9.]+$/.test(host) || host.includes(':')) return null;          // IPv4 / IPv6 literal
        if (!/\.[a-z]{2,}$/i.test(host)) return null;                           // must end in a real TLD
        return `https://${u.hostname}`;
    } catch { return null; }
}

const text = (r) => (r && r.ok && r.body ? r.body.toString('utf8') : '');

/** Anchors of one page: { href, label }, bounded, entity-decoded, one pass. */
function anchorsOf(html) {
    const out = [];
    const re = /<a\b([^>]*)>([\s\S]{0,300}?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) && out.length < MAX_ANCHORS) {
        const href = (m[1].match(/\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i) || [])[0] || '';
        const val = href.replace(/^\s*href\s*=\s*/i, '').replace(/^["']|["']$/g, '').trim();
        if (!val || /^(#|javascript:|mailto:|tel:)/i.test(val)) continue;
        const label = m[2].replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
        out.push({ href: val, label: label.slice(0, 80) });
    }
    return out;
}

/** <loc> values of a sitemap, bounded. */
function locsOf(xml) {
    const out = [];
    const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
    let m;
    while ((m = re.exec(xml)) && out.length < MAX_SITEMAP_URLS) out.push(m[1]);
    return out;
}

/** A link is ours when it is on the employer's own domain, or on a host that IS a job list. */
function keepable(u, siteRoot) {
    try {
        const url = new URL(u);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
        const host = url.hostname.toLowerCase();
        if (EDITORIAL_RE.test(url.pathname)) return null;
        if (isAtsHost(host)) return { url: url.toString(), host, ats: true };
        if (rootOf(host) === siteRoot) return { url: url.toString(), host, ats: false, portal: JOBS_SUB_RE.test(host) };
        return null;
    } catch { return null; }
}

/** What to call a page in the list, in the user's terms. */
function labelFor({ ats, label, url }) {
    const clean = String(label || '').trim();
    if (ats) return clean && clean.length > 2 ? `${clean} · current openings` : 'Current openings';
    if (clean && clean.length > 2) return clean;
    try {
        const p = new URL(url).pathname.replace(/\/+$/, '').split('/').filter(Boolean).pop() || '';
        const nice = p.replace(/[-_]+/g, ' ').replace(/\.(html?|php|aspx)$/i, '').trim();
        return nice ? nice.replace(/\b\w/g, (c) => c.toUpperCase()) : 'Careers page';
    } catch { return 'Careers page'; }
}

/**
 * Find where an employer lists its jobs.
 * @returns {Promise<{ site: string|null, pages: Array<{url,label,kind,source}>, reason: string|null }>}
 *   kind: 'openings' (an ATS job list) | 'careers' (their own careers page) | 'job' (one posting from the sitemap)
 *   reason: why the list is empty — 'bad_site' | 'unreachable' | 'nothing_found' — never shown as an excuse for
 *   something we did find.
 */
async function findCareerPages(site, { limit = DEFAULT_LIMIT, deadlineMs = DEADLINE_MS, fetcher = fetchCapped } = {}) {
    const origin = originOf(site);
    if (!origin) return { site: null, pages: [], reason: 'bad_site' };
    const deadline = Date.now() + deadlineMs;
    const siteRoot = rootOf(new URL(origin).hostname);
    const found = new Map();                      // url → page (first wins: the earlier source ranks higher)
    const add = (page) => {
        // www.acme.com/careers and acme.com/careers are ONE page; a sitemap lists both.
        const key = page.url.replace(/[#?].*$/, '').replace(/\/+$/, '').toLowerCase()
            .replace(/^https?:\/\//, '').replace(/^www\./, '');
        if (!found.has(key) && found.size < limit * 4) found.set(key, page);
    };

    // 1. The homepage's own links. This is where an employer says "Careers" in its own words.
    const home = await fetcher(origin, { deadline, cap: HTML_CAP, accept: HTML_OK });
    const homeHtml = text(home);
    if (homeHtml) {
        for (const a of anchorsOf(homeHtml)) {
            let abs;
            try { abs = new URL(a.href, origin).toString(); } catch { continue; }
            const k = keepable(abs, siteRoot);
            if (!k) continue;
            const pathAndText = `${new URL(k.url).pathname} ${a.label}`;
            if (!k.ats && !(PATH_RE.test(new URL(k.url).pathname) || WORD_RE.test(a.label))) continue;
            if (k.ats || PATH_RE.test(new URL(k.url).pathname) || WORD_RE.test(pathAndText)) {
                add({
                    url: k.url,
                    label: labelFor({ ats: k.ats || k.portal, label: a.label, url: k.url }),
                    kind: (k.ats || k.portal) ? 'openings' : 'careers',
                    source: k.ats ? 'ats' : 'homepage',
                });
            }
        }
    }

    // 2. The usual careers paths, when the homepage linked none (a JS-rendered menu says nothing to a
    //    plain GET). Only a page that actually answers is offered — never a guess the user would land on.
    if (![...found.values()].some((p) => p.kind !== 'job') && Date.now() < deadline) {
        for (const path of ['/careers', '/jobs', '/career', '/en/careers']) {
            if (Date.now() >= deadline) break;
            const r = await fetcher(`${origin}${path}`, { deadline, cap: HTML_CAP, accept: HTML_OK });
            if (r && r.ok) { add({ url: r.url || `${origin}${path}`, label: 'Careers page', kind: 'careers', source: 'homepage' }); break; }
        }
    }

    // 3. The sitemap — the answer for a site whose menu is JavaScript. robots.txt names it when it is not
    //    at the usual place; job URLs there are real postings, so they are offered as postings.
    // ⚠️ THE SITEMAP STAGE IS THE SLOW ONE (robots + up to 3 XML documents, and a big employer's sitemap is
    // megabytes). A site that already told us where its jobs are does not need it — Nordex spent the whole
    // 9 s deadline there for links it had already given us on the homepage.
    const strong = [...found.values()].filter((p) => p.kind === 'openings' || p.kind === 'careers').length;
    if (strong < 2 && found.size < limit && Date.now() < deadline) {
        const maps = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
        const robots = await fetcher(`${origin}/robots.txt`, { deadline, cap: 64 * 1024, accept: TEXT_OK });
        for (const m of (text(robots).match(/^\s*sitemap:\s*(\S+)/gim) || []).slice(0, 2)) {
            const u = m.replace(/^\s*sitemap:\s*/i, '').trim();
            if (u) maps.unshift(u);
        }
        let read = 0;
        for (const map of maps) {
            if (read >= MAX_SITEMAPS || Date.now() >= deadline || found.size >= limit) break;
            const r = await fetcher(map, { deadline, cap: XML_CAP, accept: XML_OK });
            const xml = text(r);
            if (!xml) continue;
            read += 1;
            const locs = locsOf(xml);
            // A sitemap index points at more sitemaps: follow the one that looks like careers, not all of them.
            if (/<sitemapindex/i.test(xml)) {
                const next = locs.find((u) => PATH_RE.test(u) || WORD_RE.test(u));
                if (next && read < MAX_SITEMAPS) maps.push(next);
                continue;
            }
            for (const loc of locs) {
                if (found.size >= limit * 2) break;
                const k = keepable(loc, siteRoot);
                if (!k) continue;
                let p;
                try { p = new URL(k.url).pathname; } catch { continue; }
                if (!PATH_RE.test(p)) continue;
                const deep = p.split('/').filter(Boolean).length >= 3;     // /careers/jobs/senior-engineer → a posting
                add({
                    url: k.url,
                    label: labelFor({ ats: k.ats || k.portal, label: '', url: k.url }),
                    kind: (k.ats || k.portal) ? 'openings' : deep ? 'job' : 'careers',
                    source: 'sitemap',
                });
            }
        }
    }

    // Openings first (that is where the jobs are), then the careers page, then postings from the sitemap.
    const RANK = { openings: 0, careers: 1, job: 2 };
    const pages = [...found.values()]
        .sort((a, b) => (RANK[a.kind] - RANK[b.kind]) || (a.url.length - b.url.length))
        .slice(0, limit);

    return {
        site: origin,
        pages,
        reason: pages.length ? null : (homeHtml ? 'nothing_found' : 'unreachable'),
    };
}

module.exports = {
    findCareerPages,
    // for the suite
    _internals: { HTML_OK, XML_OK, TEXT_OK, originOf, rootOf, anchorsOf, locsOf, keepable, labelFor, isAtsHost, PATH_RE, WORD_RE, ATS_HOSTS, DEADLINE_MS, DEFAULT_LIMIT },
};
