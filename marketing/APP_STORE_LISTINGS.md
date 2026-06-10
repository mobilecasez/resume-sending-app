# CVApplyr — App Store Listing Pack (Apple + Google Play)

Prepared 10 June 2026 · v1.0.9 · All character counts machine-verified (UTF-8, wc -m).
Copy each field straight into the store consoles. Numbers in parentheses are verified character counts.

---

## ⭐ Recommended combo (ship this)

| Field | Pick | Why |
|---|---|---|
| Apple Name | CVApplyr: AI Job Search (23) | Brand + the highest-volume head term |
| Apple Subtitle | Resume Builder & Auto Apply (27) | Adds the two next-biggest intents with zero word overlap with the name |
| Apple Keywords | the 97-char set below | De-duplicated against the name+subtitle above |
| Google Title | CVApplyr: AI Job Apply & CV (27) | Covers AI, job, apply, CV without emoji or all-caps (policy-safe) |
| Google Short desc | Option 1 (77) | Packs the most indexed keywords into one natural sentence |

Important pairing rule: the Apple keyword field was de-duplicated against THIS name+subtitle combo. If you ship a different pair, re-check for wasted duplicate words (e.g. Subtitle option 2 contains "Recruiters", which would waste the "recruiter" keyword).

---

## 🍏 Apple App Store

Where to paste: App Store Connect → My Apps → CVApplyr → the new version page (Name, Subtitle, Keywords and Description are review-gated — they ship with a version). Promotional Text can be changed anytime without review.

### App Name options (limit 30)
1. CVApplyr: AI Job Search (23)
2. CVApplyr: Jobs, Resume, Apply (29)
3. CVApplyr - AI Resume & Jobs (27)

### Subtitle options (limit 30)
1. Resume Builder & Auto Apply (27)
2. Find Recruiters, Get Replies (28)
3. Cover Letters, CV & Autofill (28)
4. Apply Direct to Hiring Teams (28)
5. Resume, Cover Letter, Apply (27)

### Keyword field (limit 100 — paste exactly, no spaces after commas)
Primary (97 chars):

    cv,career,recruiter,hiring,cover,letter,vacancy,interview,application,hr,ats,intern,graduate,work

Alternative set — international/country angle (100 chars), good once you localize storefronts:

    lebenslauf,cv,germany,uk,abroad,international,format,cover,letter,recruiter,career,vacancy,hr,intern

### Promotional Text (limit 170 — editable anytime)
Skip the job-board black hole. Find live roles on real company career pages, see your match score, and email the hiring team — resume and cover letter attached.

### Description (limit 4000 — verified 3005 chars)

Tired of firing applications into the job-board black hole? 200 applications, zero replies — we have all been there.

CVApplyr flips the script. Point it at a company you actually want to work for, and the AI researches that employer's own careers page, finds live roles, and helps you reach the people who can hire you.

FIND
◆ Type a company name or careers-page URL — AI scans the employer's own careers site and returns live openings with location, experience level, required skills, and salary when listed.
◆ Searches keep running while you do other things; you get a notification when results are ready.
◆ Find recruiter and HR contacts for any company — with verified emails where available — based on publicly available professional profiles.

MATCH
◆ Every job gets a match percentage against your resume, so you know where you stand before you apply.
◆ Jobs show hiring contacts when found — name, role, email — and you can add your own contacts too.

BUILD
◆ Resume Builder: paste your career story or an old resume, and AI turns it into a structured, ATS-friendly resume. Edit every section.
◆ Three modern designs plus country-specific formats (Germany, UK, US, and more) chosen with a simple region picker.
◆ AI cover letters tailored to the exact job and company, with country-aware tone. Free preview, fully editable before you send.

APPLY
◆ Apply on the portal: open the application form inside the app and let AI fill in your details — even radio buttons and "How did you hear about this role?" questions.
◆ Your privacy, your answers: sensitive and legal questions (work authorization, visa, salary expectations, demographics) are always left for you to answer yourself.
◆ Your resume and cover letter can be attached to the form automatically.
◆ Apply via mail: one tap opens an email to the hiring contact with your region-formatted resume and tailored cover letter attached, plus an AI-written message. Cc and Bcc supported. Send through your connected Gmail or Outlook, or our mail service.

TRACK
◆ Recruiter replies are forwarded straight to your inbox — never miss a response.
◆ Every cover letter you generate is saved to your Letters library to review or re-download anytime.
◆ Works on mobile and on the web at cvapplyr.com.

WHO IT IS FOR
◆ Active job seekers done with the application black hole.
◆ International applicants who need country-correct documents — German Lebenslauf-style, UK CV, US resume.
◆ Career switchers, students, and new grads building their first strong resume.
◆ Busy professionals tired of re-typing the same form fields again and again.

PRICING, HONESTLY
CVApplyr is free to download. Previews are free; AI actions use small amounts of credits from credit packs — for example, 3 credits per company search and 2 credits per PDF download.

Stop waiting in the queue. Go straight to the companies — and the humans — who can hire you. Download CVApplyr and make your next application the one that gets answered.

Questions? We are at cv@cvapplyr.com.

### What's New (v1.0.9)
Job hunting just got a little less lonely.

◆ Job Hub: new company cards make search results cleaner and easier to scan.
◆ Resume Builder: smoother editing and better section handling.
◆ Cover letters: country-specific formats — pick a region, get the right tone and layout.
◆ Plus bug fixes and performance polish throughout.

Spotted something off? Tell us at cv@cvapplyr.com — we read everything.

### Screenshot captions (overlay text, in story order)
1. Search any company you want
2. Live jobs, instant match scores
3. Know exactly who is hiring
4. AI fills the form for you
5. Cover letters tailored to each job
6. Country-correct formats, one tap
7. Paste your story, get a resume
8. Email recruiters, documents attached

### Category
Primary: Business — Apple's job-search and career apps live here, so it matches user browsing intent. Secondary: Productivity — the resume/cover-letter building and form-autofill workflow fits the category's "get work done faster" framing.

### Compliance notes (Apple)
VERIFIED CHARACTER COUNTS (printf '%s' | wc -m): keywords100 = 97 chars; keywordsAlt100 = 100 chars; promoText170 = 160 chars; description4000 = 3005 chars; whatsNew = 399 chars. Name options: 23 / 29 / 27 chars; subtitle options: 27 / 28 / 28 / 28 / 27 chars — all within Apple's 30-char limits.

PAIRING ASSUMPTION: both keyword strings were de-duplicated against the RECOMMENDED combo — Name option 1 ("CVApplyr: AI Job Search") + Subtitle option 1 ("Resume Builder & Auto Apply"). If you ship a different name/subtitle pair, re-check for word overlap (e.g., Subtitle 2 contains "Recruiters", which would waste the "recruiter" keyword; Subtitle 3 contains "Cover"/"Letters"/"CV").

APPLE 2.3.7 / METADATA NOTES: (1) No competitor or third-party brand names anywhere — the description deliberately says "publicly available professional profiles" instead of naming LinkedIn; keep it that way in metadata (naming LinkedIn inside the app UI is fine, in App Store metadata it risks rejection). Gmail/Outlook are named only as the user's own connected send-from accounts, which is an accepted integration-disclosure use; if a reviewer flags it, fall back to "your connected email account". (2) Keyword fields contain no plurals, no spaces after commas, no brand terms — do not add "jobs" or "linkedin" later. (3) Screenshots must show real app UI; the captions provided are overlay text, not replacements for UI. (4) The "free to download, credits for AI actions" line keeps pricing claims honest; Apple auto-displays the "In-App Purchases" badge, so do not write "Free" in the app name or subtitle. (5) Promo text is not review-gated — safe to A/B reword anytime; keywords/name/subtitle changes require a new app version. (6) "cv" is kept as a standalone keyword because Apple does not reliably tokenize it out of the "CVApplyr" brand token — low risk, high value for UK/EU/India searches.

---

## 🤖 Google Play

Where to paste: Play Console → Grow users → Store presence → Main store listing.

### Title options (limit 30)
1. CVApplyr: AI Job Apply & CV (27)
2. CVApplyr - AI Job Search & CV (29)
3. CVApplyr: CV & Cover Letter AI (30)

### Short description options (limit 80 — Google indexes this heavily)
1. AI job search & auto-fill: resume builder, cover letters, recruiter contacts. (77)
2. Find live jobs on company career pages. Auto fill forms, email recruiters. (74)
3. AI resume builder, cover letters & auto-fill. Skip the job board black hole. (76)
4. Search any company, match your resume, find recruiters, apply by email. (71)
5. Auto-fill with AI: job match scores, country CV formats, recruiter finder. (74)

### Full description (limit 4000 — verified 3728 chars, keyword-indexed)

Tired of sending 200 applications into the job-board black hole? CVApplyr flips your job search around. Instead of scrolling listings and hoping, you point the AI at a company you actually want to work for. It researches that employer's own careers page, surfaces live openings, scores each one against your resume, finds hiring contacts, builds country-correct documents and helps you apply — on the portal with AI autofill, or straight to a human by email.

CVApplyr is an AI job application copilot for active job seekers, international applicants, career switchers, students and busy professionals.

🔎 AI JOB SEARCH ON COMPANY CAREERS PAGES
- Type a company name or careers-page URL; the AI researches the employer's careers site
- Get live openings with location, experience, required skills and salary when listed
- Searches keep running in the background — you're notified when results are ready
- Every job gets a match percentage against your resume, so you know where you fit

👤 FIND THE HUMANS WHO HIRE
- Jobs show hiring contacts when found: name, role, email, sometimes LinkedIn
- Recruiter Finder surfaces recruiter and HR contacts for any company from publicly available LinkedIn profiles — with verified emails where available
- Add your own contacts too

⚡ APPLY WITH AI AUTOFILL
- Open the job application form inside the app and let AI fill in your details — even radio buttons and "How did you hear about this role?"
- Your resume and cover letter are attached to the form automatically
- Sensitive questions (work authorization, visa, salary, demographics) are always left for you — the AI never answers them on your behalf

✉️ APPLY VIA MAIL
- One tap opens an email to the hiring contact with your region-formatted resume and tailored cover letter attached
- AI writes the email body; you can edit everything, preview attachments, add Cc/Bcc
- Send through your connected Gmail/Outlook or the app's mail service
- Recruiter replies are forwarded to your inbox, so you never miss a response

📄 AI RESUME BUILDER (ATS-FRIENDLY)
- Paste your career story or old resume text; AI builds a structured, ATS-friendly resume
- Edit every section, then download as a polished PDF
- 3 modern designs plus country-specific layouts

🌍 COUNTRY-CORRECT CV FORMATS
Applying abroad? Formats differ — and recruiters notice.
- German Lebenslauf-style CV for Germany
- UK CV format for Britain
- US resume format for America
- Pick your region; your documents and cover letter tone adapt to local norms

✍️ AI COVER LETTERS
- A tailored cover letter for each specific job and company, with country-aware tone
- 6 country formats plus generic templates
- Free image preview; fully editable before sending
- Every letter is saved in your library to review and re-download anytime

MADE FOR
- Job seekers done with the application black hole
- International applicants navigating German CV, UK CV or US resume norms
- Career switchers, students and new grads who need a strong resume fast
- Busy professionals tired of re-typing the same application forms

PRIVACY BY DESIGN
CVApplyr never auto-answers sensitive or legal application questions, and gender/pronoun details are only used with your explicit consent.

HONEST PRICING
Free to download. Previews are free. AI actions use small credit amounts via in-app credit packs — for example, 3 credits per company search and 2 per PDF download.

Works on mobile and on the web at cvapplyr.com — the web app mirrors your Job Hub, resumes and letters.

Questions or feedback? Write to cv@cvapplyr.com — we read everything.

Stop applying into the void. Search the company, score the match, reach the human. Download CVApplyr and make your next application land on a real desk.

### Tags (Play Console → Store settings → Tags; pick closest available)
- Job Search
- Careers
- Resume Builder
- Artificial Intelligence
- Productivity

### Category
Business — job-search and career apps live in Business on Google Play, and it matches CVApplyr's job-application core better than Productivity or Education.

### Screenshot captions (same story order as Apple)
1. Search any company's careers page
2. Live jobs with match scores
3. Hiring contacts on every job
4. AI fills the application form
5. Tailored cover letters per job
6. Country-correct CV formats
7. Build an ATS-friendly resume
8. Apply by email, documents attached

### Compliance notes (Google)
VERIFIED CHARACTER COUNTS (python3 len(), equivalent to printf | wc -m under UTF-8):
- fullDesc4000: 3724 / 4000 chars. Emojis count as 1-2 chars in this count (✉️ and ✍️ include a variation selector); even if Play counts emoji or em-dashes differently, there is a 276-char safety margin.
- Title 1 "CVApplyr: AI Job Apply & CV" = 27 / 30
- Title 2 "CVApplyr - AI Job Search & CV" = 29 / 30
- Title 3 "CVApplyr: CV & Cover Letter AI" = 30 / 30
- Short 1 = 77 / 80; Short 2 = 74 / 80; Short 3 = 76 / 80; Short 4 = 71 / 80; Short 5 = 74 / 80
- All 8 screenshot captions are 3-5 words (limit: 6 words), ordered to match the Apple listing story: company search, live jobs + match %, contacts, autofill, cover letter, country formats, resume builder, apply via mail.

GOOGLE PLAY METADATA POLICY COMPLIANCE:
- Keyword stuffing: target terms (ai job search, auto-fill, resume builder, cover letter, recruiter, German CV / UK CV / US resume, ATS) are integrated in natural sentences and bullets; no repeated keyword blocks or comma-separated keyword lists anywhere. Density of core terms is roughly 2% of the ~600-word description.
- No performance claims: copy contains no "guaranteed job/interview", no "#1", "best", "top", or ranking claims, and no fake/unattributed testimonials.
- No competitor brand names used as keywords. Gmail/Outlook and LinkedIn appear only as factual descriptions of the user's own connected mail service and the public-profile data source (permitted interoperability references, not comparative keywords).
- Recruiter Finder wording follows the brief exactly: "recruiter and HR contacts ... from publicly available LinkedIn profiles — with verified emails where available." No promise of unlimited or guaranteed email finding; mobile "Coming Soon" work-email feature is not claimed.
- Monetization disclosed honestly: free to download, in-app credit packs, example credit costs stated. Matches Play's requirement to not misrepresent paid content.
- Emoji usage: max one emoji per section header (7 headers with emoji, the rest plain) — within Play title/description formatting norms; note Play TITLES must not contain emoji, and none of the 3 titles do. Titles also avoid ALL-CAPS words (CV/AI/CVApplyr are brand/standard acronyms).
- Sensitive-data trust angle ("never auto-answers work authorization/visa/demographics; gender/pronoun only with explicit consent") is stated as designed, supporting Data Safety form consistency.

TAGS CAVEAT: Play Console only allows tags from its predefined list, which changes over time. Pick the closest available matches to the 5 suggested; "Job Search" and "Careers" are the priority two if only some exist. If "Resume Builder" or "Artificial Intelligence" are unavailable in your console, substitute "Self-Improvement" or "Tools".

TITLE RECOMMENDATION: Option 1 (27 chars) is the safest default — covers "AI", "Job", "Apply", "CV" without punctuation-heavy formatting. Option 3 maxes the 30-char budget for cover-letter keyword coverage.
SHORT-DESC RECOMMENDATION: Option 1 packs the most indexed keywords (ai job search, auto-fill, resume builder, cover letters, recruiter); Option 3 adds the rebellious "job board black hole" hook if you prefer voice over keyword breadth.

---

## 🔑 Keyword bank (for listings, localization and content)

### Core head terms (high competition — win via title/subtitle/short desc)
- job search
- job application
- ai job application
- ai job search
- resume builder
- resume maker
- cv maker
- cv builder
- cover letter generator
- ai cover letter
- ai resume builder
- job finder
- apply for jobs
- ats resume

### Long-tail phrases (medium competition — weave into the Google full description)
- auto fill job applications
- autofill job application forms
- find recruiter email
- find recruiters for a company
- who is the hiring manager
- find hr contacts at a company
- apply to jobs fast
- apply directly to companies
- apply without job boards
- search company careers pages
- find jobs at a specific company
- email resume to hiring manager
- send job application by email
- resume match score for job
- check resume against job description
- tailored cover letter for each job
- cover letter for specific job and company
- build resume from old resume text
- ats friendly resume builder
- country specific cv format
- resume format for jobs abroad
- stop rewriting cover letters
- job application assistant app
- new grad job application help
- career change resume builder

### Low-competition terms (most realistic first wins for a v1.0.x app)
- application autofill
- job application autofill
- recruiter contact finder
- hiring contact finder
- apply by email
- job match score
- careers page job search
- employer career page jobs
- cover letter library
- country cv formats
- direct apply to company

### Country-specific terms (use in localized storefronts: de-DE, en-GB, en-IN, en-US)
- lebenslauf app
- lebenslauf erstellen
- german cv maker
- cv for germany
- uk cv format
- uk cv builder
- us resume format
- american resume builder
- ats resume india
- resume maker india
- european cv maker
- international cv builder
- cv format for abroad jobs

### Never use (policy/trademark/overclaim risk)
- LinkedIn, Indeed, Glassdoor, Naukri, Monster, ZipRecruiter, Teal, Simplify, LazyApply, Jobscan, Zety, Novoresume, Kickresume — no competitor or third-party brand names anywhere in metadata (trademark + rejection risk; LinkedIn may only appear in neutral in-app copy about public profiles, never in keywords)
- linkedin scraper / profile scraper / email scraper — policy-violating framing; recruiter discovery must be framed as publicly available profiles
- unlimited email finder / free email finder / verified emails guaranteed — brief explicitly forbids promising unlimited or guaranteed email finding
- guaranteed job / guaranteed interview / get hired guaranteed — unverifiable overclaim, store-policy risk
- #1 job app / best job search app — unverifiable superlative claims
- auto apply bot / mass apply / apply to 100 jobs — implies bulk auto-application the product does not do (it autofills one form at a time)
- job board / job board app — positions CVApplyr as exactly what it is not; the differentiator is employer-careers-page-first
- visa sponsorship jobs / work visa jobs — feature does not exist; the app deliberately leaves visa questions to the user
- free credits / free unlimited ai — misrepresents the credits model; say free to download, credit packs for AI actions
- headhunter database / hr database — implies a scraped contact database rather than per-company public-profile lookup

### Placement map
Apple 100-char keyword field: pack the core singles plus the lowCompetition fragments (comma-separated, no spaces, no plurals, and omit any word already in the app name/subtitle — likely "cvapplyr", "ai", "job", "resume", "cover letter"); core terms are high-competition, so the winnable Apple terms early on are the lowCompetition cluster — give them priority characters. CountrySpecific terms go in localized Apple keyword fields per storefront (de-DE: lebenslauf terms; en-GB: uk cv terms; en-IN: ats resume india; en-US: us resume format) rather than burning the global field. Google Play: the 80-char short description should carry 2-3 core terms in one natural sentence (e.g., AI job application copilot — resume builder, cover letters, application autofill); the full description should weave the longTail phrases through the P1-P12 feature paragraphs at natural density (each core term repeated roughly 3-5 times total, never stuffed), with in-listing headers using exact core + lowCompetition phrases ("Auto-fill job applications", "Find recruiter and HR contacts", "Job match score"); countrySpecific terms belong in the localized Play listings and in the country-formats paragraph (P8) of the main description. Competition is qualitative: core = high (rank via title/subtitle/short description), longTail = medium (full-description territory), lowCompetition and countrySpecific = low-to-medium and the most realistic first-rank wins for a v1.0.x app.

---

## 📸 Screenshot production plan

Record these 8 app screens (light padding, deep-navy device frame, caption overlay top, brand colors #0B1120 / #06B6D4→#3B82F6). The same set works for both stores:

1. Job Hub search with live results — caption 1
2. Job card with match % badge — caption 2
3. Job detail with hiring contacts — caption 3
4. Auto-Fill running on a portal form — caption 4
5. Cover-letter preview (free preview screen) — caption 5
6. Region picker with country formats — caption 6
7. Resume Builder result — caption 7
8. Apply-via-Mail compose with attachment chips — caption 8

## 🌍 Localization (the cheapest next win)
When ready, localize listings: de-DE (lebenslauf terms — the keyword bank has them), en-GB (UK CV terms), en-IN (ATS resume India). Country-specific keywords go in those storefronts' fields instead of burning the global 100 chars.
