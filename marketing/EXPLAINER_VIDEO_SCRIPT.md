# CVApplyr — Animated Presenter Explainer

**Deliverable:** a 90-second explainer with an AI-generated presenter walking through the app, cut
against the real screen recordings we already have. Plus a 30s ad cutdown and a 15s vertical cut.

Everything below is production-ready: every shot names a real file with in/out timecodes measured
from the source, and every narration line is timed to the beat it sits over.

---

## 0. Read this first — two decisions worth making deliberately

**The presenter is a HOST, not a customer.** The script is written for someone saying *"here's how
this works"*, never *"this app got me a job"*. An animated character delivering a success story is a
fabricated testimonial: the person doesn't exist, the outcome never happened, and it is the kind of
thing that gets an ad account pulled and a listing flagged. A host explaining a product is
completely normal, converts just as well, and is true. Every line below holds to that.

**The Search/Jobs footage is out of date.** `Fetch Job and Generate Cover Letter.mov` was recorded
on 25 July, before the 3.4 Jobs redesign shipped on 28–29 July. It shows the **old dark Search card
with the green "Search live on Google" pill**. Today's app has the redesigned Search tab with the
"Google Search" button, the movable filter button and the help assistant. Scenes 4 and 5 use that
footage. Options, in order of preference:

1. **Re-record scenes 4–5** on 3.5 (~40 seconds of screen capture). Best outcome, smallest job.
2. Ship as-is and accept that two shots show a previous version — noticeable to existing users,
   invisible to new ones.
3. Cut scenes 4–5 to their non-Search moments only (the results list, the save, the job card).

The profile, résumé-builder, cover-letter and auto-fill footage all still match the shipped app.

---

## 1. Presenter brief (for HeyGen / Synthesia / Runway / D-ID)

| Field | Value |
|---|---|
| Role | Friendly product host — the person who shows you around, not a spokesmodel |
| Apparent age | 28–35 |
| Wardrobe | Plain crew-neck or simple shirt in a mid tone. No suit, no lanyard, no headset |
| Background | Soft neutral (warm grey / off-white), gentle depth blur. No office stock set |
| Framing | Chest-up, centred for scene 1, then bottom-right corner inset for the demo scenes |
| Energy | Calm and capable. Someone explaining a shortcut to a friend, not selling |
| Gesture | Sparse. One open-hand gesture per scene at most |

**Voice**
- Warm, mid-pitch, natural pace (≈2.2 words/second), light conversational lilt.
- Neutral international English. Our users span 51 countries — avoid a strong regional accent.
- **No hype inflection.** No rising "…and it's *free!*" sell tone. Read it like instructions.
- Micro-pause (0.3s) before each numbered step so the on-screen action lands first.

**Prompt you can paste into most avatar tools:**
> A friendly, natural-looking presenter in their early thirties, chest-up, wearing a plain
> crew-neck top, standing against a soft neutral background with gentle depth of field. Calm,
> warm, conversational delivery — explaining rather than selling. Minimal hand gestures. Neutral
> international English accent, moderate pace.

---

## 2. Master script — 90 seconds

Shots are `file @ in–out` in **source seconds**. All source clips are 1920×1080 with the phone
centred; the phone occupies `x=712, w=496, full height` (see §5 for the exact crop).

| # | Time | Shot | On-screen text | Narration |
|---|---|---|---|---|
| 1 | 0:00–0:09 | **Presenter full frame** | — | "Applying for jobs is mostly retyping. Your name, your number, your history — over and over, into a different form every time. This is the app that stops that. Let me show you the whole thing in about a minute." |
| 2 | 0:09–0:15 | `Profile Update.mov` @ 0.0–2.5 → presenter shrinks to corner inset | **1. Set it up once** | "First, you fill in your details one time. Name, phone, address — the things every application asks for." |
| 3 | 0:15–0:24 | `Profile Update.mov` @ 4.5–10.6 | *Signature — generated* | "Add your résumé and a photo. And if you don't have a signature saved anywhere, it'll draw one from your name — pick a style, save, done. That's the last time you type any of it." |
| 4 | 0:24–0:34 | `Resume Builder.mov` @ 1.4–6.6 | **2. Get a résumé that fits** | "No résumé yet? Tell it your story in rough notes and it writes one for you." |
| 5 | 0:34–0:41 | `Resume Builder.mov` @ 7.4–9.6 | *Formats per country* | "Then pick the format for where you're applying — a German CV and a US résumé are not the same document — and download it." |
| 6 | 0:41–0:52 | `Fetch Job and Generate Cover Letter.mov` @ 1.6–5.4 ⚠️ *stale UI* | **3. Find a real job** | "Now the jobs. You search the live web from inside the app, so you're looking at real, current listings — not a stale copy of them." |
| 7 | 0:52–0:59 | `Fetch Job and Generate Cover Letter.mov` @ 11.4–13.6 | *Saved ✓* | "Found one? One tap pulls the whole posting in and saves it." |
| 8 | 0:59–1:08 | `Apply Job with Auto Fill.mov` @ 1.8–5.2 | **4. The letter writes itself** | "It reads the role, looks up the company, and writes a cover letter for that specific job — not a template with the name swapped." |
| 9 | 1:08–1:13 | `Apply Job with Auto Fill.mov` @ 6.0–9.5 | *Choose a format · PDF or Word* | "Same idea with the letter format. Pick your region, download as PDF or Word." |
| 10 | 1:13–1:24 | `Apply Job with Auto Fill.mov` @ 13.6–17.0 | **5. And the form fills itself** | "Then the part that actually saves the time. Open the employer's own application form, tap the robot, and it fills the whole thing in — your details, the dropdowns, the questions your résumé already answers — and attaches the right files." |
| 11 | 1:24–1:29 | `Apply Job with Auto Fill.mov` @ 17.8–18.9 | *Submitted · marked as Applied* | "Submit. It's logged on your dashboard automatically." |
| 12 | 1:29–1:38 | **Presenter full frame**, app icon + wordmark lower third | *CVApplyr — iOS & Android* | "Set up once, then it's find a job, and apply. That's it. It's called CVApplyr — free to start, on iPhone and Android." |

**Total narration: 213 words → ~1:37 at 2.2 w/s.** Trim scene 1 to *"Applying for jobs is mostly
retyping — the same details into a different form every time. This is the app that stops that."*
if you need a hard 90.

---

## 3. Cutdown A — 30 seconds (paid social / pre-roll)

The 30 is not a summary of the 90; it is one promise delivered fast.

| # | Time | Shot | On-screen text | Narration |
|---|---|---|---|---|
| 1 | 0:00–0:04 | Presenter, tight | — | "Every job application asks you the same twenty questions." |
| 2 | 0:04–0:10 | `Apply Job with Auto Fill.mov` @ 13.6–15.2 | **Tap once** | "So let something else answer them." |
| 3 | 0:10–0:18 | `Apply Job with Auto Fill.mov` @ 15.2–17.2 | *Filled · files attached* | "It fills the employer's real form — details, dropdowns, attachments — from your profile." |
| 4 | 0:18–0:23 | `Apply Job with Auto Fill.mov` @ 2.0–4.5 | *Cover letter, written for that job* | "It writes the cover letter for that specific role, too." |
| 5 | 0:23–0:27 | `Apply Job with Auto Fill.mov` @ 17.8–18.9 | *Submitted* | "Then you submit, and it's tracked." |
| 6 | 0:27–0:31 | Presenter + icon | *CVApplyr — free to start* | "CVApplyr. Free to start." |

---

## 4. Cutdown B — 15 seconds vertical (Reels / TikTok / Shorts)

9:16, no presenter — the phone IS the frame. Burned-in captions, hook in the first 1.5s.

| Time | Shot | Burned caption |
|---|---|---|
| 0:00–0:02 | `Apply Job with Auto Fill.mov` @ 13.8–15.0 | "POV: the job form fills itself" |
| 0:02–0:07 | `Apply Job with Auto Fill.mov` @ 15.0–17.2 | "name · phone · dropdowns · résumé attached" |
| 0:07–0:10 | `Apply Job with Auto Fill.mov` @ 2.0–4.0 | "+ a cover letter written for that job" |
| 0:10–0:13 | `Apply Job with Auto Fill.mov` @ 17.8–18.9 | "submitted ✓" |
| 0:13–0:15 | App icon on solid `#0B1120` | "CVApplyr — free to start" |

---

## 5. Asset manifest

All source clips: **1920×1080, phone centred at `x=712, y=0, w=496, h=1080`.**

| File | Length | What it contains |
|---|---|---|
| `/Volumes/External/Work/cvApplyr/Videos/July 2026/Edited/Profile Update.mov` | 10.71s | Menu → Account Settings → photo picker → personal details → résumé ✓ → signature generator (4 styles) → Save → "Profile saved successfully" |
| `…/Edited/Resume Builder.mov` | 10.50s | Resume Builder intro → "Build with AI" → story notes → *Generate My Resume with AI* → finished résumé → country format picker (Generic / USA-Canada / UK-Australia) → Download PDF / Word |
| `…/Edited/Fetch Job and Generate Cover Letter.mov` | 19.50s | ⚠️ *pre-3.4 Search UI.* Search tab → live web results → job listing → Fetch job → Saved ✓ → View & Apply → cover letter writing → finished letter |
| `…/Edited/Apply Job with Auto Fill.mov` | 18.92s | My Jobs dashboard → job detail (85% match) → cover letter generating → researching company → finished letter → format picker → employer portal → robot dock → **Auto Fill** → filled form → attach résumé + letter → "Application submitted — marked as Applied" |

**Beat-level index** (source seconds — measured, not estimated):

*Profile Update.mov* — 0.0 side menu · 1.0 Account Settings · 2.0 photo picker sheet · 3.0 personal
details · 4.0 form filled + résumé ✓ · 5.0 signature card · 6.0 Save Changes + stats · 7.0 choose
signature · 7.8 **Generate Signature from Name** · 8.0 four signature styles · 9.9 **Save Changes** ·
10.35 "Profile saved successfully"

*Resume Builder.mov* — 0.0 Resume Builder intro (Build with AI / Build Manually) · 2.0 story notes ·
3.5 **Generate My Resume with AI** · 5.6 the finished résumé · 8.05 country format picker ·
9.05 **Download PDF**

*Fetch Job and Generate Cover Letter.mov* — 1.6 Search tab · 3.05 **search tap** · 4.8 live results ·
11.75 **Fetch job (dock)** · 13.1 Saved ✓ · 14.1 **View & Apply** · 14.7 letter writing ·
16.6 the finished letter

*Apply Job with Auto Fill.mov* — 0.0 My Jobs dashboard · 2.0 job detail (SQUER, 85% match, Vienna,
€75–95k) + "Generating cover letter 7%" · 4.0 "Researching Company 78%" · 5.0 Apply on Portal /
via Mail · 6.0 cover-letter format picker · 8.0 branded letter with photo · 10.0 portal opens ·
13.85 **tap the robot → Job tools** · 14.7 **Auto Fill** · 15.0 "Auto-filling your application"
(scanning → matching with your profile → filling in your details → adding your skills) ·
15.6 the filled form · 16.9 attach files (résumé Europe/EU, letter Germany/DACH) ·
18.3 **"Application submitted — marked as Applied on your dashboard"**

**Supporting stills** (if the editor wants cutaways): `MobileApp/assets/onboarding/steps/*.png`
(23 full-frame screens), `marketing/guide/out/*.gif` (six clean animated walkthroughs, generic
persona), `Claude/cvApplyr/logo_img.png`.

---

## 6. Assembly notes

**Extract a phone-cropped shot** (repeat per row of the tables above):

```bash
ffmpeg -i "Apply Job with Auto Fill.mov" -ss 13.6 -to 17.0 -vf "crop=496:1080:712:0" -an scene10.mp4
```

- **16:9 master** — 1920×1080. Phone sits right-of-centre at ~62% height; presenter inset
  bottom-left at 22% width with a soft shadow. Background `#0B1120` (the app's navy) with a subtle
  radial lift behind the phone.
- **9:16 vertical** — drop the presenter, scale the 496×1080 crop to fill 1080×1920, captions in
  the lower third but above the platform UI (keep 320px clear at the bottom).
- **Pacing** — hold 0.8s on every confirmation state ("Saved ✓", "Profile saved successfully",
  "Application submitted"). Those frames are the proof; cutting them fast wastes the shot.
- **Speed** — the raw clips are real-time and occasionally slow. Ramp to 1.3–1.5× through scrolling
  and typing, and drop back to 1.0× on every tap and result. This is exactly what
  `tools/build-guide-gifs.js` does for the in-app guides, and it is the difference between "demo"
  and "watchable".
- **Captions** — burn in for social, and ship a `.srt` for YouTube. 60%+ of feed views are muted;
  the script must read silently.
- **Music** — a quiet, unobtrusive bed at −22 LUFS under the VO. No build, no drop.
- **End card** — app icon, "CVApplyr", store badges, `cvapplyr.com/download`.

---

## 7. Copy guardrails — do not drift from these

These are the same rules the store listing follows. An AI voice tool will happily read anything you
type, so the constraint has to live here.

- **Never** say or imply the app applies to jobs *for* you without you. It fills the form; the
  person reviews and submits. Scene 11 says "Submit" for exactly this reason.
- **Never** state or imply a guaranteed interview, job, or response rate.
- Hiring-contact features are **"where available"** — do not claim we always find a recruiter email.
- Do not name competitor apps or job boards.
- Do not put a price in the VO. Pricing changes; "free to start" is true and stays true.
- The on-screen demo account (John Mathews, `cvapplyrtest@gmail.com`, a placeholder phone number and
  New York address) is **test data, not a real person** — confirm before publishing, and blur the
  phone number if you'd rather not show a number-shaped string at all.
- The employer shown (SQUER Solutions GmbH) is a real company whose public careers page appears in
  the recording. It reads as a neutral demonstration of a public page, but if you want zero risk,
  re-record scenes 8–11 against a generic sample posting.

---

## 8. What to hand your AI video tool

1. **Presenter clips** — paste §1 as the avatar prompt, and the narration column of §2 as the
   script. Generate one clip per scene so the timing is yours to control, not the tool's.
2. **Screen footage** — the four `.mov` files, cropped per §6.
3. **Assembly** — the tables in §2–§4 are a shot list in edit order; hand them to the editor (or
   the tool's timeline) as-is.
4. **Captions** — generate from the narration column.
