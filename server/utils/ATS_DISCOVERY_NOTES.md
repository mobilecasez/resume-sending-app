# Universal job discovery — ATS detection + public-API extraction

## Why
The old pipeline guessed job links by URL shape (`looksLikeJobDetailUrl` regex). Every new
ATS = a new shape it didn't know (Breezy `/p/`, Recruitee `/o/`…) → broken/0 results. The
durable fix: detect the **ATS platform** (even on a custom domain) and pull all jobs from
its **public JSON API**. One adapter per ATS covers every company on it.

## Architecture (server/utils/atsDiscovery.js)
- `detectAndFetchAts(url, rawHtml)` → `{ ats, companyName, jobs[] }` or **null** (safe: any
  miss/error → null → caller falls back to the existing scrape pipeline; nothing breaks).
- Each job is fully normalized: `{ title, location, job_url, job_type, salary, experience,
  responsibilities[], skills[], employer_name, _atsApi:true }`.
- `responsibilities` = bullets from the API description/requirements HTML.
  `skills` = curated-keyword extraction (`extractSkills`) — short, chip-friendly (the ATS
  "requirements" are long sentences, which the save loop's >100-char skill filter drops).

## Wiring (server/controllers/aiHubController.js — ADDITIVE)
1. `require('../utils/atsDiscovery')`.
2. In `processJobSearch`, after `fetchCareersPageData`: try `detectAndFetchAts`. If jobs →
   build `listingData` (company + jobs) from it and SKIP scrape discovery; **else** the
   entire existing flow runs unchanged (in an `else` block).
3. In `fetchJobDetailsBatch`, an ATS-API fast path: `if (every j._atsApi) return jobBatch
   mapped to the detail shape` — no fetch, no AI (mirrors the existing `_ats` sitemap path).
   `employer_name` flows through so the company name is correct (fixes the "N/A" cards).

## Verified end-to-end (this session) — 8 adapters live
- **Recruitee** (`{origin}/api/offers/`, custom domains): careers.hostaway.com → 19 "Hostaway" ✅ (the user's bug)
- **Greenhouse** (`boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true`): airbnb → 224 ✅
- **Ashby** (`api.ashbyhq.com/posting-api/job-board/{org}`): ramp → 111 ✅ ; Notion (notion.so/careers, CUSTOM domain, detected via HTML embed) → 151 ✅
- **Workday** (the JS-wall case — page is a 6KB shell, but POST `{tenant}.wdN.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs`, paginated; detail GET `…/cxs/…{externalPath}`): nvidia → 120 (of 2000) jobs ✅. Latency ~10-17s for big lists (per-job detail GETs at concurrency 12) — TODO: stream detail fetch via Phase-2 instead of upfront.
- **SmartRecruiters** (`api.smartrecruiters.com/v1/companies/{co}/postings` + `/postings/{id}` detail): Visa → 9 ✅
- Lever (`api.lever.co/v0/postings/{co}?mode=json`), Breezy (`{co}.breezy.hr/json`), Workable (`apply.workable.com/api/v1/widget/accounts/{co}?details=true`) — adapters live, endpoints correct; need verified example cos.
- Non-ATS sites (tesla/google/stripe) → null → existing pipeline ✅ (nothing breaks)

## Gaps found by the diverse stress test (→ research will close these)
- **Eightfold** (Netflix `explore.jobs.netflix.net`) — careers-AI platform, has an API. ADD.
- **Custom SPAs with NO ATS marker**: Spotify (lifeatspotify.com), GitLab (about.gitlab.com/jobs), Stripe — these need the **AI pattern-free fallback** (Layer 4: render DOM, LLM classifies links — no URL regex) or network-capture (intercept the page's own jobs XHR). The existing Gemini `findJobListings` is the current fallback; the gap was the `looksLikeJobDetailUrl` regex dropping valid links before AI.
- Personio (XML feed `{co}.jobs.personio.com/xml`) verified — ADD (XML parse).

## Token extraction
- subdomain ATSes (Recruitee/Breezy/Workable): token = subdomain or `{origin}`.
- path ATSes (Greenhouse/Lever/Ashby): token = first path segment (`firstSeg`); on a CUSTOM
  domain, token comes from an HTML fingerprint (embed `for=`, CDN host, JS global).
- company name: `resolveCompany` prefers a real `og:site_name`, else title-cases the token.

## TODO (integrate from the ats-registry-research workflow → 200+ ATSes)
- SmartRecruiters (`api.smartrecruiters.com/v1/companies/{co}/postings` + per-posting detail
  `/postings/{id}` → jobAd.sections) — verified Visa→9; needs detail fetch for description.
- Personio (`{co}.jobs.personio.com/xml` — XML feed; parse `<position>`) — verified.
- Teamtailor, JazzHR, iCIMS, Workday, SuccessFactors, Jobvite, Recruitee-likes, + the long
  tail from the research registry. Prefer a **data-driven generic adapter** (config: detection
  signatures + endpoint template + token rule + jobsPath + fieldMap) so 200+ become DATA, not
  200 hand-coded functions. The 6 hand-coded adapters above stay for special cases.
- Careers-page discovery for ROOT domains (hostaway.com → find careers.hostaway.com) so
  "enter just the company domain" also resolves to the ATS.
- AI pattern-free fallback (Layer 4) for sites on NO known ATS: LLM classifies links from the
  rendered DOM (no URL regex) — the existing Gemini `findJobListings` is the current fallback.
