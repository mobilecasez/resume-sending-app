# CVApplyr SEO Article Playbook (for the automated routine)

GOAL: publish ONE new high-quality, SEO-optimized, genuinely engaging article to the CVApplyr
article hub on each run. Each article turns a REAL job-search problem we solve into a discoverable,
helpful guide that ranks on Google and converts readers into app downloads. **Never break the site.**

Working dir: `/Users/rishisamadhiya/Desktop/Files/Personal/Shopify Apps/resume-sending-app`
Live exemplar to match in quality + structure: `public/articles/apply-to-100-jobs-without-burnout.html`

## Each run — do exactly this
1. **Pick the next topic** from the Backlog below that does NOT already have a file in
   `public/articles/` (check existing `*.html` slugs; skip ones already written). One per run.
2. **Write `public/articles/<slug>.html`** by copying the exemplar's structure and replacing the
   content. MUST include, unchanged in shape:
   - the gtag block (`AW-18266469423`) as the FIRST thing in `<head>`,
   - SEO `<title>` (≈55–60 chars, keyword-led), meta description (≈150 chars), `<link rel=canonical>`
     to `https://cvapplyr.com/articles/<slug>`, OG + Twitter tags, favicon set,
   - `Article` + `FAQPage` JSON-LD (4 real FAQs matching the on-page FAQ),
   - **`<link rel="stylesheet" href="/css/article.css?v=5">`** — the `?v=N` cache-buster is REQUIRED
     (see Caching rule below); use the CURRENT version number,
   - the shared site header — `<div id="app-header"></div>` near the top of `<body>` PLUS
     `<script src="/js/app-header.js?v=5"></script>` just before `</body>` (this injects the common menu);
     the `.fab` floating Download button (→ `/download`); and the footer — copy verbatim.
3. **Body**: 1500–2000 words, problem → why it's hard → how CVApplyr solves it, step by step. Engaging,
   concrete, NOT boring or salesy. Include **2+ graphics**:
   - **at least one custom inline `<svg>`** analytics graphic (on-brand gradient `#06B6D4`→`#3B82F6`):
     a bar chart, comparison, funnel, or before/after. Use REAL industry numbers from the Stat Bank
     below (cite the source in the figcaption) OR clearly-illustrative numbers framed as such.
   - **at least one REAL app screenshot** from `public/articles/img/screen-*.jpg` that fits the topic
     (see the screenshot map). Portrait phone shots go in `<figure class="shot">…</figure>` (constrained
     + centred). Two can sit side by side in `<div class="shotrow"> <figure>…</figure> <figure>…</figure> </div>`.
   - You may also reuse a WIDE 1200×628 image from `public/articles/img/` (apply-in-minutes,
     stop-manual-applying, reply-rate). ⚠️ NEVER use a cropped image or one with text cut at the edges —
     the square `before-after.jpg` is cropped; do NOT use it. When unsure, build another custom SVG.
   - One inline `.ctaband` mid/late article + the FAQ + a "Keep reading" `.related` block linking 1–2
     other articles in the same category (use their real slugs).
4. **Add an index card**: insert a `<article class="card">…</article>` (copy an existing card's shape)
   immediately after `<!-- ARTICLE_CARDS_START -->` in `public/articles/index.html` (newest first). If a
   matching wide image exists use it as the `.thumb` background; otherwise leave the gradient default.
5. **Sitemap**: add a `<url>` for `https://cvapplyr.com/articles/<slug>` (priority 0.7, monthly) right
   after the `/articles` entry in `public/sitemap.xml`. Update its `<lastmod>` to today.
6. **Verify locally**: well-formed (one `<head>`, one `.fab`, one gtag, css link has `?v=`) — quick grep.
7. **Ship**: `git add public/articles public/sitemap.xml && git commit -m "SEO article: <title>"` then
   `railway up --service "CVApplyr Website" --ci`. After deploy, `curl -s -o /dev/null -w "%{http_code}"
   https://cvapplyr.com/articles/<slug>` MUST be `200`. If not, investigate before finishing.
8. **Guardrails**: only touch files under `public/articles/`, `public/sitemap.xml` (and copy images into
   `public/articles/img/`). Do NOT modify server.js, the app, the DB, or any other page. If anything
   looks risky, stop and report instead of deploying.

## ⚠️ Caching rule (this caused real "my change isn't showing" pain — do not skip)
`/css/article.css` is served with `cache-control: max-age=86400` (24h). The `<link>` therefore carries a
version query `?v=N`. **Whenever you edit `article.css`, bump N** (e.g. `?v=2` → `?v=3`) in EVERY article
HTML file (`public/articles/*.html`) in the same commit, so visitors fetch the new CSS instead of a stale
cached copy. New articles must use the current `?v=N`. (Current version: **v=5**.)

## ⚠️ NEVER place two images back-to-back — text must separate them
Do not stack a hero and a screenshot (or any two `<figure>`s) with only whitespace between. The hero is the
only full-width image right after `.meta`. The portrait app screenshot goes in a **two-column split** beside
text (the shopflixai pattern), e.g. pair it with the lead paragraph:
`<figure class="hero">…</figure>` then
`<div class="split"><div class="split-text"><p class="lead">…</p></div><figure class="shot"><img …></figure></div>`
then the first `<h2>`. Any later screenshot must likewise sit next to a paragraph, never directly after
another figure. (`.split` stacks to text-then-image on mobile.)

## Header + layout treatment (already in article.css — do NOT regress)
- On article pages the shared header uses a **solid white background that matches the page**
  (`#app-header .nav{background:var(--bg)}` with dark nav text + a faint bottom border), so it reads as a
  clean integrated bar. This override lives in `article.css` only, so every OTHER page of the site keeps
  its normal dark header. Do NOT change it back to transparent or dark.
- Top spacing lives on the article element: **`.article{margin:100px auto 0}`** and `body{padding-top:0}`.
  Keep the 100px on `.article` (not on body) so the title clears the fixed header.

## Hero image + comments (every article now has these — copy from the exemplar)
- **Hero image:** ⚠️ **2026-07-27 — the Imagen 4 `:predict` endpoints now 404 for this project**
  ("no longer available to new users"), and the **local `.env` `GEMINI_API_KEY` is out of prepay credits
  (429)**. Use the **prod** key and the current Gemini image model instead:
  `K=$(railway variables --service "CVApplyr Website" --kv | grep '^GEMINI_API_KEY=' | cut -d= -f2-)` then POST
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent?key=$K`
  with `{contents:[{parts:[{text: PROMPT}]}], generationConfig:{responseModalities:["IMAGE"], imageConfig:{aspectRatio:"16:9"}}}`
  and read the image from `candidates[0].content.parts[].inlineData.data` (base64 JPEG). Use an
  editorial-photo prompt relevant to the topic (suffix: "no text, no UI, no logos, soft natural light,
  realistic"). **ALWAYS look at the generated image before shipping it** — these models happily render
  legible calendars/whiteboards/brand marks despite the negative prompt; add explicit negatives
  ("no calendars, no posters, no writing of any kind, no brand marks") and regenerate. Downscale to
  1200px-wide JPG (~q82) with `sips -Z 1200 -s format jpeg -s formatOptions 82 in.jpg --out out.jpg` and save as
  `public/articles/img/hero-<slug>.jpg`. Embed it as the FIRST figure under the `.meta` line:
  `<figure class="hero"><img src="/articles/img/hero-<slug>.jpg" alt="<descriptive keyword alt>" width="1200" height="675" loading="eager"></figure>`.
  Point `og:image`, `twitter:image` and the Article JSON-LD `image` at this hero. (Imagen has a per-minute
  quota — on HTTP 429 wait ~40s and retry; generate sequentially.)
- **Comments:** include `<section id="article-comments" class="comments" data-slug="<slug>"></section>`
  right after `</article>`, and `<script src="/js/article-comments.js?v=1"></script>` just before `</body>`
  (after the app-header script). The widget + first-party API (`/api/article-comments`, table
  `article_comments`) already exist — nothing else to wire.
- **BreadcrumbList JSON-LD** (Home › Articles › Title) in `<head>`, alongside the Article + FAQPage JSON-LD.

## Real screenshots available (public/articles/img/) → map to topics
These are REAL in-app captures (polished marketing frames). Pick the ones that fit the article:
- `screen-jobhub.jpg` — AI Job Hub dashboard: matches / contacts / verified stats, tracked companies. → apply-at-scale, tracking, hidden-market.
- `screen-live-jobs.jpg` — live jobs pulled from real careers pages, skills + Apply Now. → career-pages, where-to-apply.
- `screen-who-is-hiring.jpg` — job listings with **Hiring Contacts** + Add Contact / View Job / Apply Now. → contact-finder, ghosting, recruiter-vs-HM.
- `screen-apply-portal-email.jpg` — job detail: hiring contacts + **AI Cover Letter generating** + Apply on Portal / Apply via Mail. → cover letters, where-to-apply.
- `screen-cover-letter.jpg` — cover-letter preview with country/region picker. → cover-letter articles.
- `screen-resume-formats.jpg` — resume preview, country-correct formats, template picker, Download Resume. → resume/ATS articles.
- `screen-paste-story-resume.jpg` — "Tell Us Your Story" → AI builds a resume. → resume/ATS, new-grad, career-change.
- `screen-email-recruiters.jpg` — email composer to a recruiter with **Resume + Cover Letter attached**, AI-written body. → cold email, follow-up, ghosting.
Wide 1200×628 (hero/inline): `apply-in-minutes.jpg`, `stop-manual-applying.jpg`, `reply-rate.jpg`.

## Stat Bank (real, attributable — cite source in figcaption; keep framing honest)
- The average corporate job opening attracts ~250 applicants; only a handful reach interview. (Glassdoor.)
- Recruiters spend ~6–7 seconds on the first pass over a resume. (Ladders eye-tracking study, 2018.)
- A large majority of mid/large employers use an ATS to filter applications. (Jobscan / industry surveys.)
- Referred candidates are hired at far higher rates — referrals are a small share of applicants but a
  large share of hires. (Jobvite / iCIMS.) Frame as "studies suggest".
- "Hidden job market": a large share of roles are filled via networking/referral before/without a public
  post — commonly cited but soft; frame as "often cited" / "estimates vary".
- Tailoring a resume/letter to the job description measurably lifts callback rates. (Jobscan.)
CVApplyr-specific numbers (time saved, applications/night) are ILLUSTRATIVE — frame as "in practice" /
"users often find", never as measured guarantees.

## Style
Conversational, specific, skimmable (short paras, H2/H3, bullets). Lead with the reader's real pain, pay
it off with the feature. No hype, no fake guarantees. Always end with a soft CTA to download. Consistent
British/US English within a piece.

## Topic backlog — grouped by the feature it showcases (write the first un-published one each run)
### Apply faster / at scale (Job Hub)
1. apply-to-100-jobs-without-burnout — ✅ published
2. how-many-jobs-should-you-apply-to — "How Many Jobs Should You Actually Apply To? (The Real Numbers)"
3. beat-job-board-fatigue — "Job-Board Fatigue Is Real — Here's How to Beat It"
4. 30-minute-a-day-job-search — "The 30-Minutes-a-Day Job Search That Actually Works"
### Cover letters (AI generator)
5. write-a-cover-letter-with-ai — "How to Write a Cover Letter with AI (That Doesn't Sound Like AI)"
6. cover-letter-examples-that-get-interviews — "Cover Letter Examples That Got Interviews (and Why They Worked)"
7. tailor-a-cover-letter-in-60-seconds — "Tailor a Cover Letter to Any Job in 60 Seconds"
8. do-cover-letters-still-matter-2026 — "Do Cover Letters Still Matter in 2026?"
### Reaching real people (contact finder)
9. find-the-hiring-managers-email — "How to Find the Hiring Manager's Email: 4 Ways That Actually Work"
10. why-job-applications-get-ghosted — "Why Your Applications Get Ghosted (and How to Get Replies)"
11. cold-email-that-lands-interviews — "The Cold Email That Lands Interviews (Templates Inside)"
12. recruiter-vs-hiring-manager — "Recruiter vs. Hiring Manager: Who to Actually Email"
### Resume / ATS (resume builder + matching)
13. beat-the-ats-resume-screening — "How to Beat the ATS: Get Your Resume Past the Robots"
14. tailor-your-resume-to-every-job — "Tailor Your Resume to Every Job in Minutes, Not Hours"
15. resume-keywords-that-get-you-shortlisted — "The Resume Keywords That Get You Shortlisted"
### Follow-up & tracking (jobs hub)
16. job-application-follow-up-email — "The Follow-Up Email That Actually Gets Responses"
17. track-50-applications — "How to Track 50+ Applications Without Losing Your Mind"
18. what-to-do-after-you-apply — "What to Do After You Apply (The Step Most People Skip)"
### Where & how to apply (universal job discovery)
19. apply-on-company-career-pages — "Stop Relying on LinkedIn: Applying Directly on Career Pages"
20. the-hidden-job-market — "The Hidden Job Market: Apply Before Jobs Are Even Posted"
21. apply-to-jobs-abroad — "How to Apply to Jobs Abroad Without Getting Auto-Rejected"
### Situational
22. job-search-while-employed — "How to Job-Search Quietly While You're Still Employed"
23. job-search-after-a-layoff — "Job Searching After a Layoff: A Calm, Fast Playbook"
24. new-grad-job-search-no-experience — "New-Grad Job Search: Stand Out With No Experience"
25. career-change-job-search — "Career Change: How to Apply When Switching Fields"
### Added after the original backlog was exhausted
26. explain-employment-gaps-resume — ✅ published (2026-07-20)
27. how-long-does-it-take-to-find-a-job — ✅ published (2026-07-27)

**The original 25 are all published.** From here every run invents its own topic (see below).

When the backlog runs low, invent a new high-search-intent topic about a job-application problem
CVApplyr solves, append it here with a slug, and write it.

### Candidate topics for upcoming runs (unwritten — take the first one each run, then append more)
28. apply-if-you-dont-meet-requirements — "Should You Apply If You Don't Meet All the Requirements?"
29. job-application-forms-take-forever — "Why Job Application Forms Take So Long (and How to Cut It to Minutes)"
30. linkedin-easy-apply-worth-it — "Is LinkedIn Easy Apply Worth It? What Actually Happens to Those Applications"
31. how-to-follow-up-without-being-annoying — "How to Follow Up Without Being Annoying"
32. best-time-to-apply-for-jobs — "Is There a Best Time to Apply for a Job? What Actually Matters"

## ⚠️ Finish the run — a half-shipped article is worse than none
The 2026-07-20 run deployed `explain-employment-gaps-resume.html` but never generated its hero image,
never added the index card, never added the sitemap entry, and never committed the file — so it sat live
with a broken hero and no way to reach it. Before finishing, confirm ALL of: hero JPG exists on disk,
index card inserted, sitemap `<url>` added, `git status` clean for `public/articles`, and the live
article URL **and** the live hero image URL both return 200.
