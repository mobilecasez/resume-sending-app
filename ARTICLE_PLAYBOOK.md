# CVApplyr SEO Article Playbook (for the automated routine)

GOAL: publish ONE new high-quality, SEO-optimized, genuinely engaging article to the CVApplyr
article hub on each run. Each article turns a real job-search problem we solve into a discoverable,
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
     to `https://cvapplyr.com/articles/<slug>`, OG + Twitter tags,
   - `Article` + `FAQPage` JSON-LD (4 real FAQs matching the on-page FAQ),
   - `<link rel="stylesheet" href="/css/article.css">`,
   - the shared site header — `<div id="app-header"></div>` near the top of `<body>` PLUS
     `<script src="/js/app-header.js?v=5"></script>` just before `</body>` (this injects the common menu);
     the `.fab` floating Download button (→ `/download`); and the footer — copy verbatim.
3. **Body**: 1500–2000 words, problem → why it's hard → how CVApplyr solves it, step by step. Engaging,
   concrete, NOT boring or salesy. Include **2 graphics**: at least one custom inline `<svg>` (on-brand
   gradient `#06B6D4`→`#3B82F6`, e.g. a chart/comparison) AND one promo image. Reuse a WIDE 1200×628
   image from `public/articles/img/` (apply-in-minutes, stop-manual-applying, reply-rate) or copy a
   fitting wide ad from `Claude/cvApplyr/ad_images_wide/` into `public/articles/img/`. ⚠️ NEVER use a
   cropped image or one with text cut off at the edges — open/verify it first (the square
   `before-after.jpg` is cropped — do NOT use it). When in doubt, build a custom inline SVG instead
   (no crop, full control). One inline
   `.ctaband` mid-article + the FAQ + a "Keep reading" `.related` block linking 1–2 other articles.
4. **Add an index card**: insert a `<article class="card">…</article>` (copy the existing card shape)
   immediately after `<!-- ARTICLE_CARDS_START -->` in `public/articles/index.html` (newest first).
5. **Sitemap**: add a `<url>` for `https://cvapplyr.com/articles/<slug>` (priority 0.7, monthly) right
   after the `/articles` entry in `public/sitemap.xml`. Update its `<lastmod>` to today.
6. **Verify locally**: the new HTML is well-formed (one `<head>`, one `.fab`, one gtag) — quick grep.
7. **Ship**: `git add public/articles public/sitemap.xml && git commit -m "SEO article: <title>"` then
   `railway up --service "CVApplyr Website" --ci`. After deploy, `curl -s -o /dev/null -w "%{http_code}"
   https://cvapplyr.com/articles/<slug>` MUST be `200`. If not, investigate before finishing.
8. **Guardrails**: only touch files under `public/articles/`, `public/sitemap.xml` (and copy images into
   `public/articles/img/`). Do NOT modify server.js, the app, the DB, or any other page. If anything
   looks risky, stop and report instead of deploying.

## Style
Conversational, specific, skimmable (short paras, H2/H3, bullets). Lead with the reader's pain, pay it
off with the feature. No hype, no fake stats — illustrative numbers are fine if framed as such. Always
end with a soft CTA to download. British/US English consistent within a piece.

## Topic backlog (write the first un-published one each run)
1. apply-to-100-jobs-without-burnout — ✅ published
2. write-a-cover-letter-with-ai — "How to Write a Cover Letter with AI (That Doesn't Sound Like AI)"
3. find-the-hiring-managers-email — "How to Find the Hiring Manager's Email: 4 Ways That Actually Work"
4. why-job-applications-get-ghosted — "Why Your Job Applications Get Ghosted (and How to Get Replies)"
5. beat-the-ats-resume-screening — "How to Beat the ATS: Get Your Resume Past the Robots"
6. tailor-your-resume-to-every-job — "Tailor Your Resume to Every Job in Minutes, Not Hours"
7. job-application-follow-up-email — "The Follow-Up Email That Actually Gets Responses"
8. apply-on-company-career-pages — "Stop Relying on LinkedIn: Applying Directly on Career Pages"
9. job-search-while-employed — "How to Job-Search Quietly While You're Still Employed"
10. how-many-jobs-should-you-apply-to — "How Many Jobs Should You Actually Apply To? (Real Numbers)"
11. cover-letter-examples-that-get-interviews — "Cover Letter Examples That Got Interviews (and Why)"
12. beat-job-board-fatigue — "Job-Board Fatigue Is Real — Here's How to Beat It"

When the backlog runs low, invent a new high-search-intent topic about a job-application problem
CVApplyr solves, append it here with a slug, and write it.
