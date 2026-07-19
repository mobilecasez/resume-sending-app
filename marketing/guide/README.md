# In-app how-to guide GIFs

Six low-FPS animated guides for the first-run info screen. Each one walks through a flow
step by step, with a highlight ring + tap pointer showing exactly **what to tap and where to go**.

| File | Shows | Steps | Size |
|---|---|---|---|
| `01-set-up-your-profile.gif` | Me tab → details, photo, résumé upload, signature | 7 | ~222 KB |
| `02-build-a-resume-for-any-region.gif` | Résumé Builder → region picker → sample output (DE vs US) | 5 | ~156 KB |
| `03-find-and-save-live-jobs.gif` | Live search → results → open a job → save to Job Hub | 6 | ~194 KB |
| `04-send-a-researched-cover-letter.gif` | Generate cover letter → final letter → send with attachments | 6 | ~164 KB |
| `05-auto-fill-an-application.gif` | Portal → robot dock → Auto Fill (incl. skills) → upload box w/ region → submitted | 7 | ~176 KB |
| `06-track-applications-and-replies.gif` | My Jobs → statuses → sort → reply → per-job timeline | 5 | ~134 KB |

460 px wide · 5 fps · ~2.2 s per step · 128-colour palette. Total ≈ 1.0 MB for all six.

## Content rules

- **Generic persona only.** "Alex Taylor", `alex.taylor@example.com`, fictional employers
  (Northwind Analytics, Orbit Systems, Lumen Labs, Vantage Digital). No real names, emails,
  domains or account data appear anywhere — the existing store screenshots were deliberately
  NOT reused because they contain live personal/business data.
- Screens are faithful mockups of the current UI (robot dock, Auto Fill stages, region picker),
  not old screenshots — so they match what a new user actually sees today.

## Regenerating

```bash
node marketing/guide/render.js          # all six
node marketing/guide/render.js 03 05    # only those ids
```

Requires Playwright chromium (already a project dep) and `ffmpeg` on PATH.

- `ui.js` — shared design system (colours mirror `MobileApp/CLAUDE.md`), persona, frame shell.
- `guides.js` — the six storyboards. Each step is `{ title, note, screen, tip?, noTap? }`.
- `render.js` — renders frames and assembles the GIF.

**How targeting works:** a step marks its tap target with `class="t"` in the screen HTML. The
renderer *measures* that element (`getBoundingClientRect`) and draws the ring/pointer over it, so
highlights can never drift out of alignment when the layout changes. Steps that show a *result*
rather than an action set `noTap: true` — they keep the highlight but drop the tap finger.

Tuning knobs in `render.js`: `FPS`, `HOLD` (frames per step), `TAIL`, `WIDTH`.
