# The five-part how-to series

Five standalone vertical films (1080×1920), one per thing the app does, cut from the same four
screen recordings as the 90-second explainer but with their own narration.

| # | File | Covers |
|---|------|--------|
| 1 | `CVApplyr-01-Set-Up-Your-Profile.mp4` | Fill the profile in once |
| 2 | `CVApplyr-02-AI-Resume-And-Formats.mp4` | Build a résumé with AI, and the regional formats |
| 3 | `CVApplyr-03-Save-A-Job.mp4` | Search, fetch and save a job |
| 4 | `CVApplyr-04-Cover-Letter.mp4` | The cover letter writes itself |
| 5 | `CVApplyr-05-Auto-Fill-And-Apply.mp4` | Auto Fill the employer's own form |

Each ships with a matching `.srt` and `.vtt`. Films 1–4 end on a card naming the next one; film 5
ends on the app.

## Build

```
python3 gen-vo.py            # narration, one WAV per scene (Gemini TTS, voice Charon)
node render-cards.js         # caption plates + the ground the phone sits on
python3 build.py             # all five films
python3 make-subs.py         # .srt and .vtt for each
```

Re-run any single piece: `python3 build.py --film 3`, `--only f5-06`, `python3 gen-vo.py --only f2-04`.

## The one rule

**A scene is exactly as long as its narration.** Nothing in `series.json` sets a scene length. Change
a line, re-run `gen-vo.py` and `build.py`, and the picture re-times itself around the new voice.

The corollary is the thing that actually bit during the build: there is only about **78 seconds of
screen recording in total**, against roughly **340 seconds of narration**. A tutorial explains, so its
lines are far longer than the 90-second film's were, and a long line over a short clip means the
picture freezes on the last frame while the voice keeps going. The first pass had scenes holding a
frozen frame for **ten seconds**.

The fix was structural, not cosmetic:

- **Explanation lives on the drawn scenes.** `anim` scenes are rendered frame by frame at whatever
  length the line needs, so they never freeze. Every "why this matters" paragraph sits on one.
- **Demo scenes get terse lines and more footage.** Each recording is now allocated contiguously
  across its film's screen scenes — no frame of the source is left unused.
- **In/out points end on confirmation screens** ("Saved", "Attached", "Done — review & submit"), so
  the hold that remains reads as a beat rather than a stall.

`build.py` prints a warning for any scene holding a frozen frame longer than `STALL_WARN` (4.0s), so
a future edit cannot reintroduce this silently. Current worst case is 4.8s; the shipped 90-second
film had holds up to 4.3s.

## Why the picture is stable

Two rules carried over from the 90-second film, both of which exist because an earlier cut of it
visibly shimmered:

1. **Speed factors are quantised to 1.0 or 2.0.** A 60fps source slowed exactly 2× is 30fps content
   on a 30fps grid: one source frame, one output frame. Any other factor lands source frames between
   output frames and ffmpeg resolves it by repeating some and dropping others on an uneven cadence —
   which reads as stutter on exactly the vertical scrolls these recordings are full of. Where a
   quantised speed would overrun the line, the *segment* is trimmed rather than the speed fudged.
   The three 24fps recordings therefore get no slow-motion at all.
2. **No `zoompan`, ever.** Re-scaling the same still slightly differently on each frame is what made
   the earlier cut shimmer. The footage is scaled **once**, straight to final size. Movement comes
   from frame sequences drawn in Chromium, where a pull-back costs nothing in sharpness because
   there are no previous pixels to resample.

## Claims

Nothing in the narration asserts something the product does not do or the code does not show:

- **The five-star rating in film 2 is the app's own ATS rating** — `ats: 5` / `ats: 4` in
  `server/utils/resumeTemplates.js`, displayed on the template picker. No percentile, ranking or
  success-rate claim is made anywhere.
- **The seven regions in film 2** are the real `REGIONS` list from the same file. The "German CV
  carries a photo, a US résumé must not" line is `photo: true` on `germany` and `europass` and
  absent everywhere else.
- **No live counts are spoken.** The recording shows "63,917 live openings"; that number was true at
  capture and is not now, so the narration says "live openings" and lets the screen speak for itself.
- **No wall-clock timings are claimed** for résumé, letter or Auto Fill generation.
- Film 5 says the form is filled "on their site, not ours", and that questions needing human
  judgement are "flagged, not guessed at" — both are what the recording shows.

## Frame accuracy

Every in/out point in `series.json` was read off frame strips of the source at 0.35–0.5s resolution,
not estimated. Two traps found that way and avoided:

- `Resume Builder.mov` ends on the iOS share sheet's **"Add a caption…"** screen from 9.7s. Film 2's
  last screen scene stops at 9.55s. (The same trap cost a re-cut on the 90-second film.)
- `Apply Job with Auto Fill.mov` has the Auto Fill checklist visible for only ~0.5s before it flips
  to the result panel. Film 5's scene runs *through* the flip so the hold lands on
  "Done — review & submit" rather than on a spinner.

## Notes for the next edit

- The films are vertical only, matching what was asked for. A 1:1 or 16:9 cut means re-rendering the
  plates and anims at the new size — the phone geometry constants at the top of `build.py` and
  `render-cards.js` are the only things that have to agree.
- Film 2 is the longest (~89s) because it carries two concept scenes. If it needs to be shorter, the
  `parse` line is the one to cut.
- `.gemini-key` is written into this directory transiently and deleted after a run. It is gitignored;
  so are `vo/`, `work/`, `cards/` and the mp4s.
