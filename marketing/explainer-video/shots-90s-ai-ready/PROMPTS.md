# 90-second master — AI-ready clips (each 3–10s)

Every clip is inside the 3–10 second window most AI video tools accept. Filenames are the running
order. Four were slowed to reach 3s; the other six are untouched realtime.

| # | Clip | Length | Speed | Narration to lay over it |
|---|---|---|---|---|
| 02 | `02-set-it-up-once.mp4` | 4.3s | 0.59× | "First, you fill in your details one time. Name, phone, address — the things every application asks for." |
| 03 | `03-resume-photo-signature.mp4` | 6.1s | realtime | "Add your résumé and a photo. And if you don't have a signature saved anywhere, it'll draw one from your name — pick a style, save, done. That's the last time you type any of it." |
| 04 | `04-ai-writes-your-resume.mp4` | 5.2s | realtime | "No résumé yet? Tell it your story in rough notes and it writes one for you." |
| 05 | `05-pick-a-country-format.mp4` | 4.2s | 0.53× | "Then pick the format for where you're applying — a German CV and a US résumé are not the same document — and download it." |
| 06 | `06-search-live-jobs.mp4` | 3.9s | realtime | "Now the jobs. You search the live web from inside the app, so you're looking at real, current listings — not a stale copy of them." |
| 07 | `07-fetch-and-save.mp4` | 4.2s | 0.53× | "Found one? One tap pulls the whole posting in and saves it." |
| 08 | `08-cover-letter-writes-itself.mp4` | 3.4s | realtime | "It reads the role, looks up the company, and writes a cover letter for that specific job — not a template with the name swapped." |
| 09 | `09-letter-format-and-download.mp4` | 3.5s | realtime | "Same idea with the letter format. Pick your region, download as PDF or Word." |
| 10 | `10-auto-fill-the-form.mp4` | 3.4s | realtime | "Then the part that actually saves the time. Open the employer's own application form, tap the robot, and it fills the whole thing in — your details, the dropdowns, the questions your résumé already answers — and attaches the right files." |
| 11 | `11-submitted-and-tracked.mp4` | 3.7s | 0.28× | "Submit. It's logged on your dashboard automatically." |

**Total screen footage: 41.9s.** Scenes 01 and 12 are presenter-only (no clip here) — generate those
from the presenter brief in `../SCRIPT.md` §1.

---

## Per-clip prompts

Use these if your tool wants a text prompt alongside each clip (to generate a matching presenter
shot, or to describe the b-roll). They describe **what is actually on screen** — do not let a tool
invent UI that isn't there.

**02** — A phone screen showing an app's Account Settings page opening: profile card with name and
photo, then Email and Personal Information sections. Calm, unhurried. No people, no hands.

**03** — The same settings page scrolling through a filled-in profile: résumé attached with a green
tick, then a signature panel where four handwriting styles are offered and one is chosen, ending on
a "Profile saved successfully" confirmation.

**04** — A Résumé Builder screen: rough notes typed into a text box, then a "Generate My Resume with
AI" button pressed, resolving into a finished, formatted résumé document.

**05** — A résumé preview with a country/region format selector across the top (Generic, USA/Canada,
UK/Australia), and download buttons for PDF and Word beneath it.

**06** — A job search screen on a phone: a query typed, then live search results appearing as a list
of real job postings.

**07** — A job posting open on a phone, a "Fetch job" control tapped in a bottom bar, resolving to a
"Saved" confirmation.

**08** — A job detail screen showing a match percentage and role title, with an AI cover-letter card
below it moving through "Generating…" and "Researching company…" progress states.

**09** — A finished cover letter displayed on a phone, with a region format selector above it and
"Download PDF" / "Download as Word" buttons below.

**10** — An employer's own web application form inside a phone browser, with a small robot button
floating over it. The robot is tapped and an overlay reads "Auto-filling your application" while the
form's fields populate by themselves.

**11** — A confirmation state on a phone: "Application submitted", with a thank-you message from the
employer visible behind it.

---

## Why four clips were slowed

They were shorter than the 3-second floor, so a tool would reject them. Slowing was the right fix
rather than trimming a longer clip, because each of these four is a *moment* — a save confirmation,
a format picker, a "Saved ✓", a submission — and there is no more footage of them to borrow.

Clip 11 is slowed the most (0.28×). It is a near-static confirmation screen, so it reads as a held
beat rather than obvious slow motion. If it looks wrong in your edit, the alternative is to freeze
its final frame for 3 seconds instead.

The six realtime clips were deliberately **not** slowed. A voiceover generated against them stays in
sync; slowing everything uniformly would have pushed the master well past 90 seconds.
