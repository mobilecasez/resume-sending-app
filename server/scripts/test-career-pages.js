// "Where does this employer list its jobs?" — the answer behind the Jobs page's employer tab.
//   node server/scripts/test-career-pages.js
//
// The network is faked here (one function in, pages out), so what is actually checked is the JUDGEMENT:
//   • an employer's own job portal and any known ATS come FIRST — that is where the openings are;
//   • a link is kept only when it is on the employer's own domain or on a job list we recognise. A
//     careers page may link anywhere, and handing the app a third party's page would have the user
//     fetching a posting from a company they never picked;
//   • an article is not a way to apply ("…/blog/active-directory-for-job-roles" matched the word list
//     on the first real run and was offered as a careers page);
//   • the slow stage (robots + sitemaps) is skipped when the site already answered, and the whole thing
//     is bounded — it runs on the API's thread.
// The REAL fetcher is brandExtract's SSRF-safe one; that wiring is pinned on source, because a second
// fetcher in here would be a second thing to get wrong.
'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');
const { findCareerPages, _internals } = require(path.join(ROOT, 'server', 'services', 'careerPages.js'));
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x).slice(0, 300) : '')); } };

/** A fake network: a map of url → { html } | { xml } | { text } | { status } . Records what was asked for. */
function net(pages) {
    const asked = [];
    const fetcher = async (url, opts) => {
        asked.push(String(url));
        const hit = pages[String(url).replace(/\/$/, '')] ?? pages[String(url)];
        if (!hit) return { ok: false, status: 404, type: '', body: null, refused: 'status', url: String(url) };
        if (hit.slow) await new Promise((r) => setTimeout(r, hit.slow));
        const body = Buffer.from(hit.html || hit.xml || hit.text || '', 'utf8');
        return { ok: true, status: 200, type: hit.xml ? 'text/xml' : 'text/html', body, truncated: false, refused: null, url: hit.finalUrl || String(url) };
    };
    return { fetcher, asked };
}
const A = (href, label) => `<a href="${href}">${label}</a>`;

(async () => {
    console.log('── 1. A site that says where its jobs are ──');
    {
        const { fetcher, asked } = net({
            'https://acme.com': { html: `<html><body>
                ${A('/about', 'About us')}
                ${A('/careers', 'Careers')}
                ${A('https://jobs.acme.com/list', 'Job portal')}
                ${A('https://boards.greenhouse.io/acme', 'See our openings')}
                ${A('https://twitter.com/acme/careers', 'Follow us')}
                ${A('/blog/active-directory-for-job-roles', 'A post about job roles')}
                ${A('mailto:hr@acme.com', 'Email HR')}
                ${A('javascript:void(0)', 'Careers menu')}
            </body></html>` },
        });
        const r = await findCareerPages('acme.com', { fetcher, limit: 8 });
        const urls = r.pages.map((p) => p.url);
        ok('the ATS and the job portal come first', r.pages.slice(0, 2).every((p) => p.kind === 'openings'), r.pages.map((p) => `${p.kind}:${p.url}`));
        ok('…the greenhouse board is one of them', urls.some((u) => u.includes('boards.greenhouse.io/acme')));
        ok('…and so is jobs.acme.com', urls.some((u) => u.startsWith('https://jobs.acme.com')));
        ok('the careers page is kept', urls.some((u) => u === 'https://acme.com/careers'));
        ok('⚠️ a third party is NOT kept, even with "careers" in the path', !urls.some((u) => u.includes('twitter.com')), urls);
        ok('⚠️ an article is not a way to apply', !urls.some((u) => u.includes('/blog/')), urls);
        ok('mailto: and javascript: are not links to open', !urls.some((u) => /^(mailto|javascript)/i.test(u)));
        ok('every page carries a label a person can read', r.pages.every((p) => typeof p.label === 'string' && p.label.length > 2), r.pages.map((p) => p.label));
        ok('the site it answered for is the https origin', r.site === 'https://acme.com', r.site);
        ok('⚠️ the slow stage was skipped — the site already answered', !asked.some((u) => /robots\.txt|sitemap/.test(u)), asked);
    }

    console.log('── 2. A site whose menu is JavaScript: the sitemap answers ──');
    {
        const { fetcher, asked } = net({
            'https://quiet.com': { html: '<html><body><div id="root"></div></body></html>' },
            'https://quiet.com/careers': { html: '<html><body>Careers</body></html>' },
            'https://quiet.com/robots.txt': { text: 'User-agent: *\nSitemap: https://quiet.com/sitemap_a.xml\n' },
            'https://quiet.com/sitemap_a.xml': {
                xml: `<urlset>
                    <url><loc>https://quiet.com/about</loc></url>
                    <url><loc>https://quiet.com/careers</loc></url>
                    <url><loc>https://www.quiet.com/careers</loc></url>
                    <url><loc>https://quiet.com/careers/jobs/senior-engineer</loc></url>
                    <url><loc>https://quiet.com/blog/how-we-hire-for-jobs</loc></url>
                    <url><loc>https://elsewhere.com/careers</loc></url>
                </urlset>`,
            },
        });
        const r = await findCareerPages('quiet.com', { fetcher, limit: 8 });
        const urls = r.pages.map((p) => p.url);
        ok('the sitemap was read (the page itself said nothing)', asked.some((u) => u.includes('sitemap_a.xml')), asked);
        ok('robots.txt named it', asked.some((u) => u.endsWith('/robots.txt')));
        ok('the careers page is offered', urls.some((u) => /\/careers$/.test(u)), urls);
        ok('⚠️ www and non-www are ONE page, not two', urls.filter((u) => /\/careers$/.test(u)).length === 1, urls);
        ok('a deep career URL is offered as a posting', r.pages.some((p) => p.kind === 'job' && p.url.includes('senior-engineer')), r.pages);
        ok('the article is still refused', !urls.some((u) => u.includes('/blog/')), urls);
        ok('another company\'s careers page is refused', !urls.some((u) => u.includes('elsewhere.com')), urls);
        ok('a careers page ranks above a single posting', r.pages.findIndex((p) => p.kind === 'careers') < r.pages.findIndex((p) => p.kind === 'job'), r.pages.map((p) => p.kind));
    }

    console.log('── 3. A sitemap index points at the careers sitemap ──');
    {
        const { fetcher } = net({
            'https://big.com': { html: '<html><body>nothing here</body></html>' },
            'https://big.com/robots.txt': { text: '' },
            'https://big.com/sitemap.xml': {
                xml: `<sitemapindex>
                    <sitemap><loc>https://big.com/sitemap-products.xml</loc></sitemap>
                    <sitemap><loc>https://big.com/sitemap-careers.xml</loc></sitemap>
                </sitemapindex>`,
            },
            'https://big.com/sitemap-careers.xml': {
                xml: '<urlset><url><loc>https://big.com/careers/open-positions</loc></url></urlset>',
            },
        });
        const r = await findCareerPages('big.com', { fetcher, limit: 8 });
        ok('it follows the careers sitemap, not the product one', r.pages.some((p) => p.url.includes('open-positions')), r.pages);
    }

    console.log('── 4. Nothing to offer is said plainly ──');
    {
        const { fetcher } = net({ 'https://empty.com': { html: '<html><body>We are a company.</body></html>' }, 'https://empty.com/robots.txt': { text: '' } });
        const r = await findCareerPages('empty.com', { fetcher });
        ok('no pages, reason nothing_found', r.pages.length === 0 && r.reason === 'nothing_found', r);
    }
    {
        const { fetcher } = net({});                       // every fetch 404s
        const r = await findCareerPages('down.com', { fetcher });
        ok('a site we could not read says unreachable, not "no jobs"', r.pages.length === 0 && r.reason === 'unreachable', r);
    }
    for (const bad of ['', '   ', 'not a url', 'localhost', 'ftp://acme.com', null, undefined, 42]) {
        const r = await findCareerPages(bad, { fetcher: net({}).fetcher });
        ok(`refused as a site: ${JSON.stringify(bad)}`, r.pages.length === 0 && r.reason === 'bad_site', r.reason);
    }

    console.log('── 5. Bounded, and never more than asked ──');
    {
        const many = Array.from({ length: 40 }, (_, i) => A(`/careers/role-${i}`, `Careers ${i}`)).join('');
        const { fetcher } = net({ 'https://lots.com': { html: `<html><body>${many}</body></html>` } });
        const r = await findCareerPages('lots.com', { fetcher, limit: 5 });
        ok('the list is capped at the limit asked for', r.pages.length === 5, r.pages.length);
    }
    {
        const { fetcher, asked } = net({ 'https://slow.com': { html: `<html><body>${A('/careers', 'Careers')}</body></html>`, slow: 120 } });
        const t0 = Date.now();
        const r = await findCareerPages('slow.com', { fetcher, deadlineMs: 250 });
        const spent = Date.now() - t0;
        ok('a slow site does not hold the request open', spent < 1500, { spent, asked: asked.length });
        ok('…and it still answers with what it had', r.pages.length >= 1, r.pages);
    }
    {
        // 600 anchors is the cap; a page with more must not be read forever.
        const huge = Array.from({ length: 5000 }, (_, i) => A(`/careers/x-${i}`, 'Careers')).join('');
        const { fetcher } = net({ 'https://huge.com': { html: `<html><body>${huge}</body></html>` } });
        const t0 = Date.now();
        await findCareerPages('huge.com', { fetcher, limit: 8 });
        ok('a huge page is read in bounded time', Date.now() - t0 < 2000, Date.now() - t0);
    }

    console.log('── 6. The one audited way onto the network ──');
    const SRC = fs.readFileSync(path.join(ROOT, 'server', 'services', 'careerPages.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    ok('⚠️ it fetches through brandExtract\'s SSRF-safe fetcher', /require\('\.\/brandExtract'\)/.test(SRC) && /brand\._internals\.fetchCapped/.test(SRC));
    ok('…and opens no socket of its own', !/require\('(https?|net|dns)'\)/.test(SRC), SRC.match(/require\('[a-z]+'\)/g));
    ok('the content types are predicates, not strings (the API takes a function)',
        /const HTML_OK = \(t\) =>/.test(SRC) && /accept: HTML_OK/.test(SRC) && !/accept: '(html|xml)'/.test(SRC));
    ok('http is upgraded to https before anything is fetched', _internals.originOf('http://acme.com') === 'https://acme.com');
    ok('a host with no dot is not a website', _internals.originOf('localhost') === null && _internals.originOf('http://[::1]/') === null);

    console.log('── 7. The route is free, read-only and never 500s ──');
    const CTRL = fs.readFileSync(path.join(ROOT, 'server', 'controllers', 'discoverController.js'), 'utf8');
    const fn = (CTRL.match(/async function employerPages[\s\S]*?\n}\n/) || [''])[0];
    ok('it charges nothing and writes nothing', !/consume|charge|INSERT|UPDATE|deduct/i.test(fn), fn.slice(0, 200));
    ok('a failure still answers a usable body', /catch \(e\)[\s\S]*?res\.json\(\{ success: true[\s\S]*?reason: 'unreachable'/.test(fn));
    ok('the limit is clamped', /Math\.min\(Math\.max\(parseInt\(req\.query\.limit, 10\) \|\| 8, 1\), 12\)/.test(fn));
    const ROUTES = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'discoverRoutes.js'), 'utf8');
    ok('the route needs a signed-in user', /router\.get\('\/discover\/employer-pages', authenticateToken, ctrl\.employerPages\)/.test(ROUTES));

    console.log(`\ncareer pages: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE CRASHED', e); process.exit(1); });
