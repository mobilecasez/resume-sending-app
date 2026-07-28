// Guide GIFs — turns the recorded feature clips into the app's onboarding slides.
//
// Input : the 1920x1080 exports in Videos/July 2026/Edited/ (a portrait phone capture centred on a
//         black canvas — the phone occupies x=712..1208, i.e. 496x1080).
// Output: MobileApp/assets/onboarding/guide-*.gif — phone-cropped, trimmed, rounded-corner GIFs with
//         a tap ripple drawn where each control was pressed.
//
// ⚠️ Tap positions are NORMALISED (0-1 of the crop) and hand-verified, not detected. Colour matching
// was tried first and abandoned: the recordings carry a shifted colour profile — the app's #2563EB
// reads as ~#204080 on screen — so hue lookups found the wrong control or none at all. Run
//   node tools/build-guide-gifs.js --verify
// to render a contact sheet per clip showing every ripple on its frame, and CHECK IT after any edit:
// a highlight pointing at the wrong control teaches the wrong thing, which is worse than no highlight.
//
// Usage: node tools/build-guide-gifs.js [--verify] [slug…]
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SRC_DIR = '/Volumes/External/Work/cvApplyr/Videos/July 2026/Edited';
const OUT_DIR = path.join(__dirname, '..', 'MobileApp', 'assets', 'onboarding');
const TMP = path.join(require('os').tmpdir(), 'cvf-guide-build');

const CROP = { x: 712, y: 0, w: 496, h: 1080 };   // the phone inside the 1920x1080 canvas
const OUT_W = 264;                                 // ~= the on-screen size in the explainer card
const OUT_H = Math.round((CROP.h / CROP.w) * OUT_W / 2) * 2;
const FPS = 8;                                     // plenty for UI motion; every frame costs GIF bytes
const RADIUS = 26;                                 // rounded corners, painted in the card's white
const COLORS = 128;

// `t` is a SOURCE timestamp (seconds into the original clip); x/y are fractions of the phone crop.
const CLIPS = [
  {
    // Search the real Google → save the job → open it with the letter already writing.
    slug: 'guide-fetch-job',
    file: 'Fetch Job and Generate Cover Letter.mov',
    start: 1.6, end: 17.8, speed: 1.45,
    taps: [
      { t: 3.05,  x: 0.347, y: 0.489, note: 'Search live on Google' },
      { t: 11.75, x: 0.265, y: 0.735, note: 'Fetch job (dock)' },
      { t: 14.10, x: 0.750, y: 0.846, note: 'View & Apply' },
    ],
    holds: [
      { t: 13.10, ms: 1600, note: 'Saved ✓' },
      { t: 14.70, ms: 2000, note: 'cover letter written' },
      { t: 16.60, ms: 2600, note: 'the finished letter' },
    ],
    slow: [{ from: 14.3, to: 17.8, ms: 280, note: 'the cover letter' }],
  },
  {
    // The Google-search flow ALONE, at NORMAL speed — the first-visit popup on the Jobs page plays
    // this, where the user needs time to actually read it (the combined fetch-job guide runs 1.45x).
    slug: 'guide-google-search',
    file: 'Fetch Job and Generate Cover Letter.mov',
    start: 1.6, end: 14.0, speed: 1.0,
    taps: [
      { t: 3.05,  x: 0.347, y: 0.489, note: 'Google Search' },
      { t: 11.75, x: 0.265, y: 0.735, note: 'Fetch job (dock)' },
    ],
    holds: [
      { t: 4.80, ms: 1800, note: 'real Google results' },
      { t: 13.10, ms: 2400, note: 'Saved ✓' },
    ],
    slow: [{ from: 3.3, to: 5.4, ms: 260, note: 'results load' }],
  },
  {
    // The robot on a real application form → Auto Fill → submitted.
    slug: 'guide-auto-fill',
    file: 'Apply Job with Auto Fill.mov',
    start: 12.4, end: 18.6, speed: 1.1,
    taps: [
      { t: 13.85, x: 0.882, y: 0.816, note: 'the robot → Job tools' },
      { t: 14.70, x: 0.729, y: 0.624, note: 'Auto Fill' },
    ],
    holds: [
      { t: 15.60, ms: 2000, note: 'the form filled + review' },
      { t: 16.90, ms: 1600, note: 'résumé attached' },
      { t: 18.30, ms: 2600, note: 'application submitted' },
    ],
    slow: [{ from: 15.1, to: 18.6, ms: 280, note: 'the filled form + submit' }],
  },
  {
    // Tell your story → AI writes the resume → pick a format → download.
    slug: 'guide-resume-builder',
    file: 'Resume Builder.mov',
    start: 1.4, end: 9.6, speed: 1.15,
    taps: [
      { t: 3.50, x: 0.500, y: 0.484, note: 'Generate My Resume with AI' },
      { t: 9.05, x: 0.500, y: 0.830, note: 'Download PDF' },
    ],
    holds: [
      { t: 5.60, ms: 2400, note: 'the résumé the AI wrote' },
      { t: 8.05, ms: 1800, note: 'pick a country format' },
    ],
    slow: [
      { from: 4.0, to: 6.6, ms: 300, note: 'the résumé the AI wrote' },
      { from: 7.6, to: 9.6, ms: 260, note: 'formats + download' },
    ],
  },
  {
    // Fill the profile once — it feeds every application.
    slug: 'guide-profile',
    file: 'Profile Update.mov',
    start: 1.2, end: 10.6, speed: 1.15,
    taps: [
      { t: 7.78, x: 0.500, y: 0.600, note: 'Generate Signature from Name' },
      { t: 9.90, x: 0.500, y: 0.505, note: 'Save Changes' },   // the page has scrolled by now
    ],
    holds: [
      { t: 8.60, ms: 1600, note: 'signature styles' },
      { t: 10.35, ms: 2400, note: 'profile saved' },
    ],
    slow: [{ from: 9.5, to: 10.6, ms: 260, note: 'saved confirmation' }],
  },
];


// ─── Per-frame pacing ────────────────────────────────────────────────────────
// A constant frame rate is wrong for a guide: scrolling through text can fly by, but a button press
// and the result it produces need time to register. GIF stores a delay PER FRAME, so we encode at a
// constant rate and then rewrite the delays — fast through the scrolling, slow into each tap, and a
// real pause on the tap itself and on the result.
//
// The delays live in each frame's Graphic Control Extension. Walk the GIF structurally rather than
// scanning for the 21 F9 04 signature: that byte sequence occurs inside LZW image data too, and
// patching a false positive corrupts the file.
function retimeGif(file, delaysMs) {
  const b = fs.readFileSync(file);
  let p = 6;                                            // header "GIF89a"
  const packed = b[p + 4];
  p += 7;
  if (packed & 0x80) p += 3 * (1 << ((packed & 7) + 1)); // global colour table
  const skipSubBlocks = () => { while (b[p] !== 0x00) p += 1 + b[p]; p += 1; };
  let frame = 0, patched = 0;
  while (p < b.length) {
    const marker = b[p];
    if (marker === 0x3B) break;                          // trailer
    if (marker === 0x21) {                               // extension
      const label = b[p + 1];
      p += 2;
      if (label === 0xF9 && b[p] === 4) {                // graphic control extension
        const cs = Math.max(2, Math.round((delaysMs[Math.min(frame, delaysMs.length - 1)] || 80) / 10));
        b.writeUInt16LE(cs, p + 2);                      // delay, in centiseconds
        patched += 1;
      }
      skipSubBlocks();
    } else if (marker === 0x2C) {                        // image descriptor
      const ipacked = b[p + 9];
      p += 10;
      if (ipacked & 0x80) p += 3 * (1 << ((ipacked & 7) + 1));  // local colour table
      p += 1;                                            // LZW minimum code size
      skipSubBlocks();
      frame += 1;
    } else break;                                        // unknown block — stop rather than corrupt
  }
  fs.writeFileSync(file, b);
  const total = delaysMs.slice(0, patched).reduce((a, c) => a + c, 0);
  return { patched, frames: frame, seconds: total / 1000 };
}

// Quick through scrolling; slower approaching a tap; a real pause ON the tap and a long one on what
// it produced. A `slow` range (below) drops a whole RESULT SECTION — a written cover letter, a
// generated résumé — to a readable rate, because a result is something you read, not a single frame
// you glance at.
const PACE = { base: 110, approach: 200, tap: 900, result: 1600, last: 1800 };
function buildDelays(count, taps, span, fps, holds, slows) {
  const d = new Array(count).fill(PACE.base);
  // Result sections first, so a tap's own pauses can still raise them further.
  for (const r of (slows || [])) {
    for (let i = Math.max(0, r.from); i <= Math.min(count - 1, r.to); i += 1) d[i] = Math.max(d[i], r.ms);
  }
  for (const t of taps) {
    if (!t.ok) continue;
    const from = Math.max(0, t.idx - Math.round(span * 0.6));
    for (let k = 0; k < span && from + k < count; k += 1) d[from + k] = PACE.approach;
    const peak = Math.min(count - 1, from + Math.round(span * 0.45));
    d[peak] = PACE.tap;                                     // hold on the press itself
    const result = Math.min(count - 1, t.idx + Math.round(fps * 0.45));
    d[result] = Math.max(d[result], PACE.result);           // …and on what it produced
  }
  for (const h of (holds || [])) {
    if (h.idx == null || h.idx < 0 || h.idx >= count) continue;
    d[h.idx] = Math.max(d[h.idx], h.ms);                    // linger on a payoff nobody tapped for
  }
  d[count - 1] = PACE.last;                                 // a beat before the loop restarts
  return d;
}

const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });

// A tap ripple: a steady dot with two rings expanding and fading out of it.
function rippleSvg(w, h, cx, cy, p) {
  const R = Math.round(w * 0.12);
  const ring = (delay) => {
    const q = p - delay;
    if (q <= 0 || q >= 1) return '';
    const r = R * (0.35 + q * 1.55);
    return `<circle cx="${cx}" cy="${cy}" r="${r.toFixed(1)}" fill="none" stroke="#06B6D4" stroke-width="${(3.4 * (1 - q * 0.5)).toFixed(2)}" opacity="${((1 - q) * 0.6).toFixed(3)}"/>`;
  };
  const dotO = p < 0.75 ? 1 : Math.max(0, 1 - (p - 0.75) / 0.25);
  return Buffer.from(
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
       ${ring(0)}${ring(0.3)}
       <circle cx="${cx}" cy="${cy}" r="${(R * 0.42).toFixed(1)}" fill="#06B6D4" opacity="${(dotO * 0.3).toFixed(3)}"/>
       <circle cx="${cx}" cy="${cy}" r="${(R * 0.22).toFixed(1)}" fill="#ffffff" opacity="${(dotO * 0.95).toFixed(3)}" stroke="#06B6D4" stroke-width="2.2"/>
     </svg>`
  );
}

const roundMask = (w, h, r) => Buffer.from(
  `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><rect width="${w}" height="${h}" rx="${r}" ry="${r}" fill="#fff"/></svg>`
);

async function build(clip, verify) {
  const src = path.join(SRC_DIR, clip.file);
  if (!fs.existsSync(src)) throw new Error('missing source: ' + src);
  const work = path.join(TMP, clip.slug);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });

  // 1. crop to the phone, trim, retime, lay down frames at the output size.
  sh('ffmpeg', ['-v', 'error', '-ss', String(clip.start), '-t', String(clip.end - clip.start), '-i', src,
    '-vf', `crop=${CROP.w}:${CROP.h}:${CROP.x}:${CROP.y},setpts=PTS/${clip.speed},fps=${FPS},scale=${OUT_W}:${OUT_H}:flags=lanczos`,
    '-start_number', '0', path.join(work, 'f_%04d.png'), '-y']);
  const frames = fs.readdirSync(work).filter((f) => f.startsWith('f_')).sort();
  if (!frames.length) throw new Error('no frames for ' + clip.slug);

  // 2. paint each ripple over the frames around its moment.
  const RIPPLE_S = 0.9;                              // one ripple's length, in OUTPUT seconds
  const span = Math.round(RIPPLE_S * FPS);
  const overlays = new Map();
  const report = [];
  for (const tap of clip.taps) {
    const idx = Math.round(((tap.t - clip.start) / clip.speed) * FPS);
    if (idx < 0 || idx >= frames.length) { report.push({ ...tap, ok: false, why: 'outside the trim' }); continue; }
    const cx = Math.round(tap.x * OUT_W);
    const cy = Math.round(tap.y * OUT_H);
    // Lead the transition so the tap reads as the cause, not the effect.
    const from = Math.max(0, idx - Math.round(span * 0.6));
    for (let k = 0; k < span && from + k < frames.length; k += 1) {
      overlays.set(from + k, rippleSvg(OUT_W, OUT_H, cx, cy, k / span));
    }
    report.push({ ...tap, ok: true, idx, cx, cy });
  }

  const toIdx = (t) => Math.round(((t - clip.start) / clip.speed) * FPS);
  const holds = (clip.holds || []).map((h) => ({ ...h, idx: toIdx(h.t) }))
    .filter((h) => h.idx >= 0 && h.idx < frames.length);
  const slows = (clip.slow || []).map((r) => ({ ...r, from: toIdx(r.from), to: toIdx(r.to) }));

  // 3. composite ripple, then round the corners over WHITE (the explainer card is white — this beats
  //    GIF's 1-bit transparency, which leaves the corners jagged).
  const mask = roundMask(OUT_W, OUT_H, RADIUS);
  const outDir = path.join(work, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  for (let i = 0; i < frames.length; i += 1) {
    let buf = fs.readFileSync(path.join(work, frames[i]));
    if (overlays.has(i)) buf = await sharp(buf).composite([{ input: overlays.get(i) }]).png().toBuffer();
    const rounded = await sharp(buf).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
    await sharp({ create: { width: OUT_W, height: OUT_H, channels: 4, background: '#ffffff' } })
      .composite([{ input: rounded }]).png()
      .toFile(path.join(outDir, `o_${String(i).padStart(4, '0')}.png`));
  }

  // 4. encode with a per-clip palette — UI screens are flat colour, so this stays crisp.
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const gif = path.join(OUT_DIR, clip.slug + '.gif');
  const pal = path.join(work, 'palette.png');
  sh('ffmpeg', ['-v', 'error', '-framerate', String(FPS), '-i', path.join(outDir, 'o_%04d.png'),
    '-vf', `palettegen=max_colors=${COLORS}:stats_mode=diff`, pal, '-y']);
  sh('ffmpeg', ['-v', 'error', '-framerate', String(FPS), '-i', path.join(outDir, 'o_%04d.png'), '-i', pal,
    '-lavfi', 'paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle', '-loop', '0', gif, '-y']);

  // 5. a contact sheet of exactly the frames that carry a ripple, so the positions can be CHECKED.
  if (verify) {
    const peak = report.filter((r) => r.ok).map((r) => Math.max(0, r.idx - Math.round(span * 0.6) + Math.round(span * 0.45)));
    if (peak.length) {
      const tiles = await Promise.all(peak.map((i) => sharp(path.join(outDir, `o_${String(i).padStart(4, '0')}.png`)).toBuffer()));
      const sheet = sharp({ create: { width: OUT_W * tiles.length, height: OUT_H, channels: 3, background: '#111827' } });
      await sheet.composite(tiles.map((input, k) => ({ input, left: k * OUT_W, top: 0 })))
        .png().toFile(path.join(TMP, `verify-${clip.slug}.png`));
    }
  }

  const timing = retimeGif(gif, buildDelays(frames.length, report, span, FPS, holds, slows));

  const kb = Math.round(fs.statSync(gif).size / 1024);
  console.log(`${clip.slug.padEnd(22)} ${frames.length}f  ${OUT_W}x${OUT_H}  ${kb} KB  ${timing.seconds.toFixed(1)}s (retimed ${timing.patched}/${timing.frames})`);
  report.forEach((r) => console.log(`   ${r.ok ? '·' : '✗'} tap  ${String(r.t).padStart(5)}s  ${r.note}${r.ok ? ` → (${r.cx},${r.cy})` : `  SKIPPED: ${r.why}`}`));
  holds.forEach((h) => console.log(`   ⏸ hold ${String(h.t).padStart(5)}s  ${h.note}  ${h.ms}ms`));
  slows.forEach((r) => console.log(`   ▷ slow ${String(r.note).padEnd(26)} frames ${r.from}-${r.to} @ ${r.ms}ms`));
  return { slug: clip.slug, kb, report };
}

(async () => {
  const args = process.argv.slice(2);
  const verify = args.includes('--verify');
  const only = args.filter((a) => !a.startsWith('--'));
  const list = only.length ? CLIPS.filter((c) => only.includes(c.slug)) : CLIPS;
  const out = [];
  for (const c of list) out.push(await build(c, verify));
  console.log(`\ntotal ${out.reduce((s, r) => s + r.kb, 0)} KB across ${out.length} guides`);
  if (verify) console.log(`verification sheets → ${TMP}/verify-*.png`);
})().catch((e) => { console.error(e.message); process.exit(1); });
