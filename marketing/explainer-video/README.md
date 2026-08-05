# CVApplyr explainer video — upload pack

Everything an AI video tool needs, in one folder. All clips are **normal speed** — no ramping, no
time-lapse — so a voiceover can sit over them without drifting out of sync.

```
SCRIPT.md                  the full script: scene table, presenter brief, cutdowns, guardrails
narration/                 the spoken lines, per scene, ready to paste into a TTS / avatar tool
shots-90s/                 10 clips for the 90-second master   (496x1080, all realtime)
shots-90s-ai-ready/        the SAME 10 clips, every one 3-10s  <- USE THIS for AI video tools
                           + PROMPTS.md: per-clip prompt and the narration line for each
shots-30s/                 4 clips for the 30-second ad        (496x1080)
shots-15s-vertical/        4 clips for Reels/TikTok/Shorts     (1080x1920, padded)
```

**Filenames are the running order.** `02-…` follows `01-…`. The numbers match the scene numbers in
`SCRIPT.md` and the `[NN — over …]` markers in the narration files, so nothing has to be matched up
by eye.

## How to assemble

1. **Presenter clips** — paste the presenter brief from `SCRIPT.md` §1 into your avatar tool, and one
   `[NN]` block from `narration/90s-narration.txt` per generated clip. Generating one clip per scene
   keeps the timing yours rather than the tool's.
2. **Screen clips** — the files here. Drop them in filename order.
3. **Layout** — 16:9 master: phone right-of-centre at ~62% height, presenter inset bottom-left at
   ~22% width, background `#0B1120`. Vertical: the phone already fills the frame, no presenter.
4. **Captions** — generate from the narration text. Burn them in for social; ship an `.srt` for
   YouTube.

## Two things to hold to

- **The presenter is a HOST, not a customer.** Every line says "here's how this works", never "this
  app got me a job". An animated character delivering a success story is a fabricated testimonial —
  the person doesn't exist and the outcome never happened.
- **Never imply it applies for you unaided.** It fills the form; the person reviews and submits.
  Scene 11 says "Submit" for exactly this reason. No guaranteed interviews, no response rates, no
  price in the voiceover, and hiring-contact features are "where available".

## Known gaps in the footage

- ⚠️ **Scenes 06 and 07 show the pre-3.4 Search screen** (the old dark card with a green "Search live
  on Google" pill). They were recorded 25 July; the Jobs redesign shipped 28–29 July. Re-record those
  two on the current build if you want it exact — about 40 seconds of screen capture.
- The demo account on screen is test data (John Mathews, `cvapplyrtest@gmail.com`, placeholder phone
  and New York address), not a real person. Confirm before publishing; blur the phone number if you'd
  rather not show a number-shaped string.
- The employer shown is SQUER Solutions GmbH, whose public careers page appears in the recording. It
  reads as a neutral demonstration of a public page. Re-record scenes 08–11 against a generic sample
  posting if you want zero risk.

## Re-cutting

Sources: `/Volumes/External/Work/cvApplyr/Videos/July 2026/Edited/` (1920x1080, phone at
`x=712, w=496`). Every clip here was produced with:

```
ffmpeg -ss <in> -to <out> -i "<source>.mov" -vf "crop=496:1080:712:0" -an \
       -c:v libx264 -crf 18 -preset slow -pix_fmt yuv420p <out>.mp4
```

Exact in/out points per scene are in `SCRIPT.md` §5.
