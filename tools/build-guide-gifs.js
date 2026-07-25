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
  },
];

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

  const kb = Math.round(fs.statSync(gif).size / 1024);
  console.log(`${clip.slug.padEnd(22)} ${frames.length}f  ${OUT_W}x${OUT_H}  ${kb} KB`);
  report.forEach((r) => console.log(`   ${r.ok ? '·' : '✗'} ${String(r.t).padStart(5)}s  ${r.note}${r.ok ? ` → (${r.cx},${r.cy})` : `  SKIPPED: ${r.why}`}`));
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
