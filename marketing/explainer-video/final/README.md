# CVApplyr — the finished explainer

The film is built, not storyboarded. Everything in this folder regenerates it from source.

| File | What it is |
|---|---|
| `CVApplyr-Explainer-1080p.mp4` | **1920×1080, 1:27, 18 MB.** YouTube, the website, the store listing |
| `CVApplyr-Explainer-Vertical.mp4` | **1080×1920, 1:27, 19 MB.** Reels, Shorts, TikTok |
| `CVApplyr-Explainer.srt` / `.vtt` | Subtitles, generated from the same edit list — they cannot drift |
| `scenes.json` | **The edit.** Narration, source in/out points, on-screen text |
| `vo/` | The narration, one WAV per line, plus measured durations |

Audio is **−16.0 LUFS integrated** — the standard target for web and social. No presenter: the film
opens and closes on built animation.

---

## The one idea the build rests on

**A scene is exactly as long as its narration.** Nothing in `scenes.json` sets a duration.
`gen-vo.py` records each line, measures it, and every scene is cut to what came back. Change a line
of copy and the film re-times itself around it — the picture always fits the voice, never the other
way round.

That is also why the subtitle file can't go out of sync: `make-subs.py` computes cue times from the
same measured durations that `build.py` uses to lay out the timeline.

## Rebuilding

```bash
python3 gen-vo.py && node render-assets.js && python3 build.py
```

Individual pieces, when you only changed one thing:

```bash
python3 build.py --only 09,11        # re-render two scenes, rejoin
python3 gen-vo.py --voice Iapetus    # a different read, to compare
python3 build.py --music bed.m4a     # duck a music bed under the narration
```

`--music` sidechains the bed against the narration, so words always sit on top. There is no bed in
the current cut — the film is clean voice on purpose, and a track is a licensing decision, not a
technical one.

---

## Why the picture is stable now

The earlier cut shimmered, and the cause was mine. Every screen scene ended with a slow `zoompan`
push, which re-scales the same pixels *slightly differently on every frame*. On 400px-wide UI text
that reads as crawling. Measuring it made it plain: on a scene whose tail holds a frozen frame — a
frame that should be byte-identical thirty times a second — the phone area was changing by an
average of **3.36 levels per frame, peaking at 7.75**.

Two changes fixed it, and both are load-bearing:

**The push is gone.** The footage is now scaled exactly once, straight to its final size, and never
touched again. The same frozen tail measures **0.00** — pixel-identical, as it always should have
been. Movement now comes from the footage, the captions, and the cuts.

**Speeds are quantised.** A slow factor is only ever 1× or 2×, never 1.62×. A 60fps source slowed
exactly 2× becomes 30fps content on a 30fps grid: one source frame, one output frame, no duplication
and no drops. Any other factor lands source frames between output frames, and ffmpeg resolves that
by repeating some and dropping others on an uneven cadence — stutter, on exactly the vertical
scrolls these recordings are full of. Where the quantised speed would overrun a line, the source
segment is trimmed rather than the speed fudged.

The file is 18 MB where it was 32 MB for the same length. That drop *is* the fix: an encoder spends
its bitrate on change, and there is far less spurious change to spend it on.

## The animated scenes

The opening, the two cards and the close are drawn frame by frame in headless Chromium
(`render-anim.js`), then assembled. Each scene exposes `seek(u)` for `u` from 0 to 1 and nothing
reads a clock, so a rebuild is identical and the animation always fits the narration it was measured
against.

This is also why those scenes can move freely without the problem above: every frame is drawn from
scratch at full resolution, so the opening's 2.4× pull-back costs nothing in sharpness — there are
no previous pixels to resample.

**The opening** is the argument in one shot. Application forms arrive one after another, each a
different employer's layout, each asking for details the last one already had. The first is typed
out so you read what is being asked; after that they snap in, because the point is that it is the
same answer every time. The camera widens to hold whatever has been placed — computed from the slot
positions, which is why the frame never empties mid-scene — and ends on a wall of twenty forms with
the tally at 47.

**The close** resolves the three phases: *Set up* is ticked and drops away, *Find* and *Apply* stay,
cycling. The shape of the film in one image — the work happens once, the loop is what is left.

---

## Two things worth knowing before this goes public

**1. A real employer is on screen throughout.** SQUER Solutions GmbH — their careers page, a live job
posting, and their advertised salary band (€75,000–95,000) are legible in scenes 7 through 13. That
is genuine footage of the product doing its job, but it puts a named third party and their
compensation data in your marketing. Worth a deliberate decision before this runs as a paid ad.

**2. Scene 7 shows the previous Search UI.** `Fetch Job and Generate Cover Letter.mov` was recorded
25 July, three days before the 3.4 Jobs redesign shipped. Existing users will spot it; new ones
won't. Re-recording that one screen is about 40 seconds of capture, then `--only 07`.

---

## How the rest is put together

**Narration** — Gemini `gemini-3.1-flash-tts-preview`, voice *Charon*. Every line goes out with the
same delivery direction so fifteen separate API calls come back sounding like one person in one
session. Returned audio is trimmed of dead air, levelled to a common loudness, and given a fixed
0.15 s head and 0.45 s tail so scenes never collide at the splice.

**Typography** — rendered through headless Chromium, not `drawtext`. The local ffmpeg is built
without libfreetype, and a browser is the better tool anyway: real font stacks, real kerning,
`text-wrap: balance`. SF Pro throughout, set against a ground whose palette is lifted from the app
icon itself (`#23375d` / `#41577e` / `#64709d`), pushed dark so the phone screen — which is mostly
white UI — is the brightest thing in frame. One warm accent (`#F4A259`) carries the phase marks and
nothing else.

**Structure** — three phases, *Set up · Find · Apply*, not a numbered list of steps. The résumé
builder is a branch for people who arrive without a CV, not step three of eight, and the rail says
so honestly.

**Holds** — where a line outruns its footage the last frame holds. The holds land on the app's own
confirmation screens ("Attached", "Done — review & submit", the submitted job on the dashboard), so
the pause reads as a beat you are meant to read rather than a stall.

## Files

```
scenes.json         the edit — copy, source in/out, on-screen text
gen-vo.py           narration  →  vo/*.wav + durations.json
render-assets.js    static graphics → cards/ (landscape) and cards-v/ (vertical)
render-anim.js      animated scenes → work/{h,v}/anim-NN/*.png
build.py            scenes → segments → crossfaded master
make-subs.py        subtitles, from the same timings
work/               intermediates (gitignored)
```

Source recordings: `/Volumes/External/Work/cvApplyr/Videos/July 2026/Edited/`.
