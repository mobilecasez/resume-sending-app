// Bespoke single-employer job boards — ADDITIVE, ISOLATED.
//
// atsDiscovery.js covers MULTI-TENANT platforms: one adapter there serves every company on
// Greenhouse/Lever/Workday/…. This file is the other half — the handful of very large employers
// who run their OWN board on their OWN stack. Each adapter here is worth writing only because the
// employer is big enough to matter on its own (Amazon alone is ~19.5k live postings, more than the
// next 200 boards in our source list combined).
//
// Same contract as an atsDiscovery adapter: detect(ctx) → token|false, fetch(ctx) → rawJobs[].
// Every adapter is host-anchored, so a wrong guess cannot fire. Public, no-auth, no-key endpoints
// only — the same endpoints the employer's own careers page calls from a browser.
'use strict';

module.exports = function buildEmployerAdapters(h) {
  const { fetchText, fetchJson, mapLimit, makeJob, strip } = h;

  // Employer boards are single points of failure: 200 requests fired at once gets us a 503 wall
  // (measured — Amazon started 503ing every request after a fast 250-request sweep, and stayed
  // that way for minutes). Everything here goes through this: low concurrency, real backoff.
  async function getJsonRetry(url, tries = 4) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
      try { return await fetchJson(url); }
      catch (e) {
        lastErr = e;
        // Only a throttle/transient is worth waiting for; a 404 will still be a 404 in 3 seconds.
        if (!/HTTP (429|503|502|500)/.test(e.message)) throw e;
        await new Promise((r) => setTimeout(r, 700 * Math.pow(2, i)));
      }
    }
    throw lastErr;
  }

  // RSS/XML <tag> reader that tolerates namespaced tags (g:location) and CDATA.
  const tagOf = (block, tag) => {
    const t = tag.replace(/[:]/g, '\\:');
    const m = block.match(new RegExp('<' + t + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + t + '>', 'i'));
    if (!m) return '';
    return m[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
  };

  return [
    // ── SAP ────────────────────────────────────────────────────────────────────────────────────
    // jobs.sap.com/sitemap.xml is misnamed: it is a Google-Jobs RSS 2.0 feed, not a sitemap, and it
    // carries the FULL job ad in <description>. One ~16MB request replaces 1,000 detail crawls.
    {
      name: 'sap-jobs',
      detect: (c) => /(^|\.)jobs\.sap\.com$/i.test(c.host) ? 'sap' : false,
      async fetch() {
        const xml = await fetchText('https://jobs.sap.com/sitemap.xml');
        const items = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];
        return items.map((it) => {
          const link = tagOf(it, 'link');
          const loc = tagOf(it, 'g:location');
          // The feed title repeats the location in trailing parens
          // ("SAP BTP Architect (Ciudad de México, MX, 06500)") — strip it so the title is the ROLE.
          let title = strip(tagOf(it, 'title')).replace(/\s*\([^()]*\)\s*$/, '').trim();
          // The description is HTML that has been entity-escaped a second time inside CDATA, so a
          // single unescape leaves live markup for strip()/bulletsFrom() to read.
          const descHtml = tagOf(it, 'description')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
          return makeJob({
            title, location: strip(loc) || 'Not specified', job_url: link,
            employer_name: strip(tagOf(it, 'g:employer')) || 'SAP', descHtml,
          });
        }).filter((j) => j.title && j.job_url);
      },
    },

    // ── ZALANDO ────────────────────────────────────────────────────────────────────────────────
    // Zalando fronts Workday with their own API, which returns every posting in ONE call with the
    // description inline. The payload carries NO url field — the canonical page is built from
    // Job_Req_Id (verified 200 on /en/jobs/{id}; the trailing-slash form 308-redirects to it).
    {
      name: 'zalando-jobs',
      detect: (c) => /(^|\.)jobs\.zalando\.com$/i.test(c.host) ? 'zalando' : false,
      async fetch() {
        const data = await getJsonRetry('https://jobs-api.corptech.zalan.do/workday/jobs?limit=500');
        const list = Array.isArray(data) ? data : (data.jobs || data.data || data.content || []);
        return list.filter((j) => {
          // Observed statuses are "In Review" (live on site) and "Closed". Exclude only what is
          // explicitly closed, so a new status value fails OPEN rather than silently dropping a board.
          const st = String(j.Job_Posting_Status || '').toLowerCase();
          return j.Job_Req_Id && j.Posting_Title && st !== 'closed';
        }).map((j) => makeJob({
          title: j.Posting_Title,
          location: [j.All_Loc_for_Job_Req || j.Primary_Location_City, j.Job_Req_Country].filter(Boolean).join(', ') || 'Not specified',
          job_url: `https://jobs.zalando.com/en/jobs/${j.Job_Req_Id}`,
          employer_name: j.Company || 'Zalando',
          employmentCode: j.Time_Type, experience: j.Experience_Level || null,
          descHtml: j.Job_Description,
        }));
      },
    },

    // ── AMAZON ─────────────────────────────────────────────────────────────────────────────────
    // amazon.jobs/en/search.json is public and returns the full ad inline. The catch is an
    // Elasticsearch result window capped at 10,000: an unfiltered sweep reports hits=10000 and can
    // page no further, so the board LOOKS like 10k jobs when it is ~19.5k. Partitioning by
    // normalized_country_code[] gets under the cap for all 56 non-US countries (largest: IND 2,594).
    // The USA partition alone still reports exactly 10000 — a clamp, not a count — so US coverage
    // is capped until a sub-partition key is found (normalized_state_name / state / city all
    // return 0 hits; they are not real filter params).
    {
      name: 'amazon-jobs',
      detect: (c) => /(^|\.)amazon\.jobs$/i.test(c.host) ? 'amazon' : false,
      async fetch() {
        // ⚠️ ORDER MATTERS, and it is SMALLEST-FIRST on purpose. This sweep is time-boxed, and
        // whatever the budget cuts off is cut off the SAME way on every run — so a largest-first
        // order permanently strands the tail. (Measured: largest-first at a 240s budget returned
        // 11,865 of 19,546 and left USA truncated at 6,800.) Smallest-first guarantees the 56
        // long-tail countries — the ones nothing else in our source list covers — always complete,
        // and lets the USA partition, which is clamped by the API anyway, absorb any shortfall.
        const COUNTRIES = String(process.env.ATS_AMZ_COUNTRIES || [
          'PER', 'PRI', 'MUS', 'KWT', 'HUN', 'MAR', 'NGA', 'JOR', 'GRC', 'DNK', 'PRT', 'NOR', 'FIN',
          'NZL', 'BEL', 'ARG', 'IDN', 'CHL', 'AUT', 'SVK', 'TUR', 'ROU', 'COL', 'THA', 'CZE', 'VNM',
          'PHL', 'CHE', 'MYS', 'NLD', 'HKG', 'SWE', 'ZAF', 'SAU', 'CRI', 'POL', 'EGY', 'LUX', 'ARE',
          'TWN', 'KOR', 'ISR', 'SGP', 'ITA', 'IRL', 'FRA', 'ESP', 'CHN', 'MEX', 'CAN', 'AUS', 'BRA',
          'DEU', 'GBR', 'JPN', 'IND', 'USA',
        ].join(',')).split(',').map((s) => s.trim()).filter(Boolean);

        const PAGE = 100;
        const WINDOW = 10000;                                              // hard ES result window
        const BUDGET = parseInt(process.env.ATS_AMZ_MS || '420000', 10);
        const t0 = Date.now();
        const byId = new Map();                                            // id_icims → job (dedupe)

        await mapLimit(COUNTRIES, parseInt(process.env.ATS_AMZ_CONCURRENCY || '4', 10), async (cc) => {
          for (let offset = 0; offset < WINDOW; offset += PAGE) {
            if (Date.now() - t0 > BUDGET) return;
            let page;
            try {
              page = await getJsonRetry(`https://www.amazon.jobs/en/search.json?result_limit=${PAGE}&offset=${offset}&normalized_country_code[]=${encodeURIComponent(cc)}`);
            } catch { return; }
            const jobs = (page && Array.isArray(page.jobs)) ? page.jobs : [];
            for (const j of jobs) {
              const id = j.id_icims || j.id || j.job_path;
              if (id && !byId.has(id)) byId.set(id, j);
            }
            if (jobs.length < PAGE) return;
            if (Number.isFinite(page.hits) && offset + PAGE >= Math.min(page.hits, WINDOW)) return;
          }
        });

        return [...byId.values()].filter((j) => j.title && j.job_path).map((j) => makeJob({
          title: j.title,
          location: j.normalized_location || [j.city, j.state, j.country_code].filter(Boolean).join(', ') || 'Not specified',
          job_url: `https://www.amazon.jobs${j.job_path}`,
          employer_name: j.company_name || 'Amazon',
          employmentCode: j.job_schedule_type,
          descHtml: j.description || j.description_short,
          reqHtml: [j.basic_qualifications, j.preferred_qualifications].filter(Boolean).join('\n'),
        }));
      },
    },
  ];
};
