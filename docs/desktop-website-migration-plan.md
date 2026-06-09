# Desktop Website — Feature-Parity Migration Plan

Goal: bring the **desktop website** (`/public/*.html`) up to par with the **mobile app**, with correct
formatting and functionality, **reusing the exact same backend API** (no new endpoints — the server
already powers both). This is a plan, not an implementation.

---

## 0. Current state (audit summary)

**Desktop** = server-rendered static pages in `/public`, served by `express.static` + a clean-URL
middleware (so `public/foo.html` is reachable at `/foo`). Same Express backend as mobile.

- **Stack:** Bootstrap 4.1.1 (barely used; most layout is hand-rolled CSS), jQuery 3.6 (loaded but
  **all API calls are vanilla `fetch`**), Montserrat + Material Icons + FontAwesome.
- **Auth:** token in `localStorage.authToken`; user in `localStorage.userData`; every call sends
  `Authorization: Bearer <token>`; on 401/403 → clear token, redirect `/login`.
- **Shared chrome:** `js/app-header.js` (`insertAppHeader`), `js/app-footer.js`, `js/credit-validation.js`
  (`creditValidation.checkCredits()` → `GET /api/user/credits`; recharge modal → `/packages`). Mount points
  `<div id="app-header">` / `<div id="app-footer">`. **Add a new page** = drop `public/<name>.html` with those
  mounts + the 3 helper scripts; surface it in nav by editing `app-header.js`.
- **Main app pages today:**
  - `/dashboard` — recipient builder (Email/Website/Position) + application history. Writes
    `localStorage.pendingRecipients` → `/review`.
  - `/review` — the cover-letter engine: generate / regenerate / edit (contentEditable) / send /
    download PDF / batch "Generate All". **Uses the OLD flow** (no regions, no gender, no per-attachment
    control, no portal/mail choice).
  - `/profile` — Full Name, Email, DOB, Phone, Address + resume/photo/signature uploads. **No gender.**

**What's missing on desktop vs mobile (grep-confirmed zero matches):** AI Hub / Job Hub, Resume Builder,
cover-letter **country/region templates**, in-form **autofill**, **gender** profile field, **two-button
apply** (portal/mail), **attachment chips** + per-attachment toggles, recruiter finder, region on
generate/send.

**Backend is ready.** Everything the mobile uses already exists and is reusable:
regions (`resumeRegion`/`coverLetterRegion`), per-attachment flags (`includeResume`/`includeCoverLetter`),
`gender` on profile update, async-job polling, AI-Hub endpoints, resume-builder endpoints, templates,
autofill. **One backend gap fixed during this plan:** `GET /api/users/profile` now also returns `gender`.

---

## 1. Hard constraint: in-page autofill on third-party sites is NOT possible from a website

The mobile "Apply on Portal → AI Auto-fill" injects JS into the employer's form **inside an in-app WebView**.
A website **cannot** script a third-party page (same-origin policy) — only a **browser extension** can.

**Desktop adaptation:**
- "Apply on Portal" = open the apply URL in a **new tab** (`window.open`). No auto-fill there.
- Keep the AI value where it works on the web: a **"Copy my details" / autofill helper panel** that calls
  `POST /api/ai-hub/autofill-map` for a pasted field list, OR (recommended, later) ship a **Chrome
  extension** that reuses `autofill-map` + `autofill-files`. Treat the extension as a separate Phase.
- Everything else (generate, regions, templates, preview, download, **Apply via Mail**, recruiter finder,
  resume builder, gender) ports cleanly to the web.

Other platform swaps: native pickers → `<input type=file>`; OS share sheet → direct blob download
(desktop already does this); mobile slide-up sheets → centered modals/off-canvas; image preview overlay →
a lightbox modal.

---

## 2. Design system port (do this first — everything else depends on it)

Create `public/css/cva-ui.css` + `public/js/cva-ui.js` encoding the mobile design language so all new
pages share it. Replicate:

- **Theme tokens** as CSS vars: `--ink #0B0F22`, `--blue #4F8DFF`, `--blueDeep #2563EB`, `--purple #7C6BFF`,
  `--teal #14B8A6`, `--emerald #10B981`, `--amber #F59E0B`, `--rose #EF4444`, surfaces `#FFFFFF`,
  bg `#E5EAF3`, navy `#0B1120`, muted `#5B6B8A`, faint `#8A93B2`.
- **Card:** white, radius 20–22, hairline border `rgba(11,15,34,.06)`, soft shadow; optional faint
  company-initials watermark.
- **Gradient primary button** (`.cva-btn-primary`): 46px, radius 12, gradient
  `linear-gradient(135deg,#4F8DFF,#7C6BFF,#5B4FE8)`, leading icon + label + trailing glass arrow-pill.
- **Progress-in-button** (signature interaction): a JS helper `cvaProgressButton(el)` that, on loading,
  keeps the footprint and renders a `#9FB9E8` base + animated left→right gradient fill (CSS width %) +
  shimmer sweep + ring spinner + live `%`; done → solid green + "✓ label". Reuse for Generate / Download /
  Send. (Port from `GenerateButton`/`DownloadButton`/`SendButton` in `MobileApp/components/HomeScreen.js`.)
- **One-row action pattern:** one big primary (`flex:1`) + 46×46 icon-only secondaries (Edit cyan pencil,
  Download PDF doc-icon with its own progress-fill + green-tick done).
- **Region chips:** picker style (flag emoji + label, selected = navy fill/white) and inline compact pills.
- **Attachment chip:** tinted icon-box + name + region meta + eye/options/close icon buttons; collapses to a
  dashed "+ Attach …" add-back row.
- **Shared helpers** in `cva-ui.js`: `apiFetch(path, opts)` (injects Bearer token, handles 401),
  `pollJob(jobId, {poller})` (polls `/api/job-status/:id` **or** `/api/ai-hub/job-status/:id`, 2s, returns
  `data`), `REGION_OPTIONS` / `RESUME_REGION_OPTIONS` / `regionFromCountry` / `regionLabel` (port
  `MobileApp/regionUtils.js` verbatim to JS), `creditGuard(cost, fn)` (reuse `credit-validation.js`).

Reuse copy verbatim (tone parity): cover-letter card *"Generate a letter tailored to this role. Once it's
ready you can download it as a PDF or edit the wording — it's attached automatically when you apply."*;
pickers *"Swipe to compare · scroll & pinch to zoom · preview is free"* and *"N credits per download …"*.

---

## 3. Phased rollout

Ordered by value × reuse. Each phase = drop-in `public/*.html` + reuse of existing endpoints. No DB or
route changes needed (backend already supports all of it).

### Phase 1 — Profile: Gender field  *(tiny; unblocks autofill correctness)*
- `public/profile.html`: add a **Gender** segmented control (Male / Female / Prefer Not to Say, toggle-off)
  with the consent helper copy. Load from `GET /api/users/profile` (now returns `gender`); save by adding
  `gender` to the existing `POST /api/users/profile/update` body. *(Note: desktop profile currently posts to
  `/api/update-user-details`; either add `gender` there too, or switch the gender save to
  `/api/users/profile/update` which already validates it.)*
- **Effort:** S. **Endpoints:** `GET /api/users/profile`, `POST /api/users/profile/update`.

### Phase 2 — Region-aware cover letter on `/review` (templates + preview + correct PDF)
Upgrade the existing engine instead of replacing it.
- After generate, show a **region chip row** (port `REGION_OPTIONS`). Default = `regionFromCountry(company
  address)`.
- **Free preview:** `POST /api/cover-letter/preview-templates` `{ region, coverLetterHtml, companyName,
  companyAddress }` → render `previews[]` images in a **lightbox** (swipe/zoom). Always free.
- **Download (2 credits):** switch the download to `POST /api/cover-letter/generate-template-pdf`
  `{ template, mode, coverLetterHtml, companyName, companyAddress }` → fetch `downloadUrl` as an
  authenticated blob. Keep One Page / A4 toggle + diamond "2" credit badge + footer note.
- Keep generic path (`/api/generate-cover-letter-pdf`) for the "Generic" region.
- **Effort:** M. **Endpoints:** preview-templates, generate-template-pdf, generate-cover-letter-pdf.

### Phase 3 — Region-aware **Send** + attachment chips + Cc/Bcc on `/review`
- Add an **ATTACHMENTS** block to the send UI: Resume + Cover Letter chips, each with region label, **eye**
  (preview via the Phase-2 lightbox), **options** (inline region pills), **×** (remove → add-back row).
- Send via the **already-upgraded** `POST /api/send-single-application` with
  `resumeRegion`, `coverLetterRegion`, `includeResume`, `includeCoverLetter` (+ existing
  `recipientEmail/websiteUrl/position/coverLetterText/companyName/companyAddress`). Poll
  `/api/job-status/:id`. Progress-in-button → green "Sent ✓".
- Move Cc/Bcc to a right-aligned "Add Cc / Bcc" toggle (UI only — server send is single-recipient today;
  keep parity with mobile, which also doesn't wire Cc/Bcc to the server yet).
- **Effort:** M. **Endpoints:** send-single-application (already region/flag-aware), job-status.

### Phase 4 — Resume Builder  *(new page `public/resume-builder.html`)*
- **Build:** free-form career text → `POST /api/resume-builder/generate-ai` `{ name,email,phone,location,
  rawText, includeUploadedResume }` (2 credits; opt-in `__async:true` + poll for resilience). Edit the
  structured JSON, `POST /api/resume-builder/save`.
- **Region templates + free preview:** `POST /api/resume-builder/preview-templates { region }` → lightbox;
  add the **ATS stars** row (resume-only).
- **Download (2 credits):** `POST /api/resume-builder/generate-pdf { template, mode }` → blob.
- Nav: add "Resume Builder" to `app-header.js`.
- **Effort:** L. **Endpoints:** resume-builder/{generate-ai,save,GET /,preview-templates,generate-pdf}.

### Phase 5 — AI Job Hub  *(new pages `public/job-hub.html` + `public/job.html`)*
Largest surface; mirrors `MobileApp/app/(ai-hub)/`.
- **Hub:** hero + stats, add-company modal (name or career-page URL, **3-credit** pre-check via
  `GET /api/user/credits`), wishlist pills, job-portal-URL rejection (handle `422 {error:'job_portal'}`).
  `GET /api/ai-hub/jobs?company=…` → poll `/api/ai-hub/job-status/:id` (stream partial employer results);
  persist in-flight searches in `localStorage`. List via `GET /api/ai-hub/dashboard`; remove via
  `DELETE /api/ai-hub/dashboard/:jobId`.
- **Job detail (`/job?id=`):** meta chips, skills, responsibilities, match-score badge, **Hiring Contacts**
  (`GET/POST /api/ai-hub/jobs/:jobId/contacts`), **AI Cover Letter** card (generate via
  `POST /api/ai-hub/jobs/:jobId/generate-cover-letter` or the shared `generate-cover-letter-details`;
  persist via `…/jobs/:jobId/cover-letter`), the **one-row** Generate/Download/Edit actions, and the
  **two apply buttons**: *Apply on Portal* (`window.open`, **no autofill** — see §1) + *Apply via Mail*
  (compose modal reusing Phase-3 attachments + `send-single-application`).
- **Recruiter finder:** when a job has no contacts —
  `POST /api/ai-hub/employers/:id/find-recruiters` then `…/find-emails` (each 1 credit; `__async:true` + poll).
- **Email body:** `POST /api/ai-hub/generate-email-body` for the compose modal default.
- **Effort:** XL. **Endpoints:** the full `/api/ai-hub/*` set + send + job-status.

### Phase 6 (optional) — Browser extension for true in-form autofill
Only way to replicate mobile autofill on the web. A small Chrome/Edge extension that, on an employer apply
page, calls `POST /api/ai-hub/autofill-map` (field list → values) and `POST /api/ai-hub/autofill-files`
(resume/CL base64), then fills the page. Reuses the **same** endpoints + the same origin-gating/consent
rules. Ship after Phases 1–5.

---

## 4. Suggested sequencing & estimates

| Phase | Scope | Effort | Net-new files |
|------|-------|--------|---------------|
| 0 | Design system (`cva-ui.css/js`, regionUtils port, helpers) | M | 3 |
| 1 | Gender on `/profile` | S | 0 (edit) |
| 2 | Region CL templates + preview + PDF on `/review` | M | 0 (edit) |
| 3 | Region send + attachment chips + Cc/Bcc on `/review` | M | 0 (edit) |
| 4 | Resume Builder page | L | 1 |
| 5 | AI Job Hub (hub + job detail) | XL | 2 |
| 6 | Browser extension (true autofill) | L | separate repo/dir |

Recommended order: **0 → 1 → 2 → 3 → 4 → 5 → (6)**. Phases 0–3 upgrade what exists (fast, high value);
4–5 add the big new surfaces; 6 is optional and separate.

---

## 5. Risks / watch-items

- **Autofill on third-party sites** is impossible from a website (§1) — set expectations; extension is the
  only true-parity path.
- **Two pollers / two async modes:** opt-in `__async` routes poll `/api/ai-hub/job-status/:id`; env-gated
  ones (generate-details, send, batch, ai-hub/jobs) poll `/api/job-status/:id`. The `cva-ui.js` `pollJob`
  helper must take the poller as a param. (Both return `status ∈ pending|processing|completed|failed` with
  `data`/`error`.)
- **Credits:** use `GET /api/user/credits` for the authoritative balance (handles expiry), not
  `/api/ai-hub/credits`. Pre-check before paid actions (generate 1, template/resume PDF 2, company search 3,
  recruiter step 1 each).
- **Auth parity:** desktop uses `localStorage.authToken`; keep the `apiFetch` 401→`/login` behavior.
- **Backgrounding resilience** matters less on desktop (tabs aren't suspended like mobile apps), but the
  poll-based design still gives free resilience against flaky networks.
- **`/profile` save endpoint mismatch:** desktop posts `/api/update-user-details` (legacy) while mobile uses
  `/api/users/profile/update`. For the gender field, prefer `/api/users/profile/update` (already validates
  gender) — or add `gender` handling to `update-user-details` to avoid splitting the save.

---

## 6. Endpoint cheat-sheet (all reused; all `Authorization: Bearer <token>`)

- **Profile:** `GET /api/users/profile` (now incl. gender), `POST /api/users/profile/update` `{…, gender}`.
- **Cover letter:** `POST /api/generate-cover-letter-details` (async→`/api/job-status`),
  `POST /api/cover-letter/preview-templates` (free), `POST /api/cover-letter/generate-template-pdf` (2 cr),
  `POST /api/generate-cover-letter-pdf` (generic).
- **Resume builder:** `POST /api/resume-builder/generate-ai` (2 cr, `__async`), `/save`, `GET /`,
  `/preview-templates` (free, `__async`), `/generate-pdf` (2 cr).
- **Send:** `POST /api/send-single-application` `{…, resumeRegion, coverLetterRegion, includeResume,
  includeCoverLetter }` (async→`/api/job-status`); `POST /api/batch-process` (batch).
- **AI Hub:** `GET /api/ai-hub/jobs?company=`, `GET /api/ai-hub/job-status/:id`, `GET /api/ai-hub/dashboard`,
  `DELETE /api/ai-hub/dashboard/:id`, `GET|POST /api/ai-hub/jobs/:id/contacts`,
  `POST /api/ai-hub/jobs/:id/generate-cover-letter`, `…/jobs/:id/cover-letter` (save/get/patch),
  `POST /api/ai-hub/autofill-map` / `autofill-files` / `generate-email-body` (`__async`),
  `…/employers/:id/find-recruiters` / `find-emails` (`__async`).
- **Credits:** `GET /api/user/credits`.
- **Async polling:** `/api/job-status/:id` (env-gated routes) | `/api/ai-hub/job-status/:id` (`__async` routes).
