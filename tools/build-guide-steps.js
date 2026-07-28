// Per-step screenshots for the in-app help guide.
//
// The guide's steps used to be text only, and the text had drifted from the app (it still described
// "Ask AI" and a Generate-Cover-Letter button that no longer work that way). These are real frames
// from the same recordings the onboarding GIFs come from, so the guide can SHOW each step.
//
// Each shot is the FULL phone frame (496x1080) with the same cyan ring the GIFs use marking the
// control the step is about. The shots used to be 340px bands cropped around the control — user
// feedback was that the cropped slices looked broken ("the images you are showing are cropped..
// better to show full images"), so the whole screen ships and the ring does the pointing.
//
// Usage: node tools/build-guide-steps.js [--verify]
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SRC_DIR = '/Volumes/External/Work/cvApplyr/Videos/July 2026/Edited';
const OUT_DIR = path.join(__dirname, '..', 'MobileApp', 'assets', 'onboarding', 'steps');
const TMP = path.join(require('os').tmpdir(), 'cvf-guide-steps');

const CROP = { x: 712, y: 0, w: 496, h: 1080 };   // the phone inside the 1920x1080 canvas
// Full-frame output. 320 wide keeps 23 PNGs at a sane bundle cost while staying ~2x the width the
// card renders them at; the tap-to-zoom view is where fine text gets read.
const OUT_W = 320;
const OUT_H = Math.round((CROP.h / CROP.w) * OUT_W / 2) * 2;

const V = {
  profile: 'Profile Update.mov',
  resume: 'Resume Builder.mov',
  fetch: 'Fetch Job and Generate Cover Letter.mov',
  apply: 'Apply Job with Auto Fill.mov',
};

// `y` is the vertical CENTRE of the band (0-1 of the phone). `ring` marks the control, when there is
// one to point at — a step that just shows a result gets no ring.
const SHOTS = [
  // ── profile ──
  { id: 'profile-menu',    v: 'profile', t: 0.5,  y: 0.16, ring: [0.45, 0.097] },
  { id: 'profile-details', v: 'profile', t: 4.2,  y: 0.22 },
  { id: 'profile-resume',  v: 'profile', t: 6.5,  y: 0.30 },
  { id: 'profile-sign',    v: 'profile', t: 7.7,  y: 0.60, ring: [0.50, 0.60] },
  { id: 'profile-save',    v: 'profile', t: 10.0, y: 0.55, ring: [0.50, 0.505] },
  // ── résumé builder ──
  { id: 'resume-open',     v: 'resume',  t: 0.6,  y: 0.24, ring: [0.45, 0.295] },
  { id: 'resume-story',    v: 'resume',  t: 3.2,  y: 0.35 },
  { id: 'resume-generate', v: 'resume',  t: 3.5,  y: 0.48, ring: [0.50, 0.484] },
  { id: 'resume-result',   v: 'resume',  t: 5.6,  y: 0.35 },
  { id: 'resume-download', v: 'resume',  t: 9.0,  y: 0.83, ring: [0.50, 0.830] },
  // ── find a job on Google ──
  { id: 'find-search',     v: 'fetch',   t: 3.0,  y: 0.42, ring: [0.347, 0.489] },
  { id: 'find-results',    v: 'fetch',   t: 4.6,  y: 0.42 },
  { id: 'find-fetch',      v: 'fetch',   t: 11.7, y: 0.74, ring: [0.265, 0.735] },
  { id: 'find-saved',      v: 'fetch',   t: 13.6, y: 0.30 },
  // ── cover letter ──
  { id: 'cl-open',         v: 'fetch',   t: 14.1, y: 0.82, ring: [0.750, 0.846] },
  { id: 'cl-writing',      v: 'fetch',   t: 14.4, y: 0.65 },
  { id: 'cl-formats',      v: 'fetch',   t: 16.6, y: 0.14 },
  { id: 'cl-download',     v: 'fetch',   t: 16.8, y: 0.86 },
  // ── auto fill ──
  { id: 'apply-robot',     v: 'apply',   t: 13.8, y: 0.78, ring: [0.882, 0.816] },
  { id: 'apply-autofill',  v: 'apply',   t: 14.4, y: 0.62, ring: [0.729, 0.624] },
  { id: 'apply-review',    v: 'apply',   t: 15.7, y: 0.55 },
  // 17.8, not 17.0: at 17.0 the résumé preview is open, which does not show what the step describes.
  // Here the "Attached ✓" confirmation and the filled Documents rows are both visible.
  { id: 'apply-attached',  v: 'apply',   t: 17.8, y: 0.58 },
  { id: 'apply-done',      v: 'apply',   t: 18.4, y: 0.20 },
];

const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });

const ringSvg = (w, h, cx, cy) => {
  const R = Math.round(w * 0.055);
  return Buffer.from(
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
       <circle cx="${cx}" cy="${cy}" r="${(R * 2.0).toFixed(1)}" fill="none" stroke="#06B6D4" stroke-width="3" opacity="0.35"/>
       <circle cx="${cx}" cy="${cy}" r="${(R * 1.25).toFixed(1)}" fill="none" stroke="#06B6D4" stroke-width="3.5" opacity="0.85"/>
       <circle cx="${cx}" cy="${cy}" r="${(R * 0.42).toFixed(1)}" fill="#ffffff" opacity="0.95" stroke="#06B6D4" stroke-width="2.5"/>
     </svg>`);
};
const roundMask = (w, h, r) => Buffer.from(
  `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><rect width="${w}" height="${h}" rx="${r}" ry="${r}" fill="#fff"/></svg>`);

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let total = 0;
  const sheet = [];

  for (const s of SHOTS) {
    const src = path.join(SRC_DIR, V[s.v]);
    if (!fs.existsSync(src)) throw new Error('missing source: ' + src);
    const full = path.join(TMP, s.id + '_full.png');
    // ⚠️ -ss AFTER -i = frame-accurate. With -ss BEFORE -i ffmpeg seeks to the nearest keyframe and
    // can hand back a frame up to a second away — which lands the shot on a different screen.
    sh('ffmpeg', ['-v', 'error', '-i', src, '-ss', String(s.t),
      '-vf', `crop=${CROP.w}:${CROP.h}:${CROP.x}:${CROP.y}`, '-frames:v', '1', full, '-y']);

    // full frame — no band cropping; the ring points at the control instead
    let buf = await sharp(full).resize(OUT_W, OUT_H, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer();

    if (s.ring) {
      const cx = Math.round(s.ring[0] * OUT_W);
      const cy = Math.round(s.ring[1] * OUT_H);
      buf = await sharp(buf).composite([{ input: ringSvg(OUT_W, OUT_H, cx, cy) }]).png().toBuffer();
    }

    const rounded = await sharp(buf).composite([{ input: roundMask(OUT_W, OUT_H, 18), blend: 'dest-in' }]).png().toBuffer();
    const out = path.join(OUT_DIR, s.id + '.png');
    await sharp({ create: { width: OUT_W, height: OUT_H, channels: 4, background: '#ffffff' } })
      .composite([{ input: rounded }]).png({ quality: 88, compressionLevel: 9 }).toFile(out);

    const kb = Math.round(fs.statSync(out).size / 1024);
    total += kb;
    sheet.push({ input: out });
    console.log(`${s.id.padEnd(18)} ${OUT_W}x${OUT_H}  ${kb} KB${s.ring ? '  (ring)' : ''}`);
  }
  console.log(`\n${SHOTS.length} step shots, ${total} KB total → ${OUT_DIR}`);

  if (process.argv.includes('--verify')) {
    const cols = 6, rowsN = Math.ceil(sheet.length / cols);
    await sharp({ create: { width: OUT_W * cols, height: OUT_H * rowsN, channels: 3, background: '#0B1120' } })
      .composite(sheet.map((t, i) => ({ input: t.input, left: (i % cols) * OUT_W, top: Math.floor(i / cols) * OUT_H })))
      .png().toFile(path.join(TMP, 'verify-steps.png'));
    console.log('verification sheet →', path.join(TMP, 'verify-steps.png'));
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
