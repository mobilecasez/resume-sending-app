// Product Hunt gallery images — 1270x760, built from real app frames + the brand kit.
//
// Layout: headline + subline on the left in the brand navy, a real phone frame on the right with
// rounded corners and a soft glow. Every headline names what the AI actually DOES (reads the
// posting / fills the form / writes the letter) — the ask was to make the AI concrete, and the
// guardrails ban vague "revolutionize" filler anyway.
//
// Frames come from the same recordings as the in-app guide, extracted frame-accurately
// (⚠️ -ss AFTER -i; keyframe seeking lands on the wrong screen).
//
// Usage: node tools/build-ph-images.js
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SRC_DIR = '/Volumes/External/Work/cvApplyr/Videos/July 2026/Edited';
const OUT_DIR = path.join(__dirname, '..', 'Claude', 'cvApplyr', 'ph_gallery');
const TMP = path.join(require('os').tmpdir(), 'cvf-ph-images');

const W = 1270, H = 760;
const CROP = { x: 712, y: 0, w: 496, h: 1080 };
const PHONE_H = 640;
const PHONE_W = Math.round(PHONE_H * CROP.w / CROP.h);   // ≈294

const V = {
  profile: 'Profile Update.mov',
  resume: 'Resume Builder.mov',
  fetch: 'Fetch Job and Generate Cover Letter.mov',
  apply: 'Apply Job with Auto Fill.mov',
};

// kicker = small cyan eyebrow; head lines are drawn as given (manual wrapping = no surprises).
const IMAGES = [
  {
    id: '01_hero', v: 'apply', t: 14.4,
    kicker: 'CVAPPLYR — AI JOB APPLICATIONS',
    head: ['The AI that does the', 'job-hunt paperwork'],
    sub: ['Find jobs on the real Google. The AI reads the posting,', 'writes your cover letter, and fills the application form.', 'You review everything — and you hit submit.'],
    foot: 'cvapplyr.com  ·  iOS + Android  ·  free to download',
  },
  {
    id: '02_google', v: 'fetch', t: 4.6,
    kicker: 'SEARCH',
    head: ['The real Google,', 'inside the app'],
    sub: ['No scraped listings, no stale board. Open any result —', 'the AI reads whatever job page you land on', 'and saves it with full details in one tap.'],
    foot: 'Works on any job site — even ones we’ve never seen',
  },
  {
    id: '03_autofill', v: 'apply', t: 15.7,
    kicker: 'AUTO FILL',
    head: ['AI fills the form.', 'You stay in charge.'],
    sub: ['It completes the company’s own application and lists', 'what still needs you. Visa, salary and personal questions', 'are always yours — nothing is submitted without you.'],
    foot: 'Works on Greenhouse, Workday, Personio and more',
  },
  {
    id: '04_coverletter', v: 'fetch', t: 16.6,
    kicker: 'COVER LETTERS',
    head: ['Written from the', 'real posting'],
    sub: ['The AI reads the actual job description and writes for it —', 'not a template. German, UK or US format, one tap.', 'Preview free, download as PDF or Word.'],
    foot: 'Country-correct formats, ready to attach',
  },
  {
    id: '05_resume', v: 'resume', t: 8.5,
    kicker: 'RÉSUMÉ BUILDER',
    head: ['Paste your messy story.', 'Get a clean résumé.'],
    sub: ['Old résumé text, a LinkedIn bio, rough notes — the AI', 'structures it into an ATS-friendly résumé in your', 'country’s format, with every section editable.'],
    foot: 'German Lebenslauf-style, UK CV, US resume',
  },
  {
    id: '06_applied', v: 'apply', t: 18.4,
    kicker: 'TRACKING',
    head: ['Submitted — and', 'tracked automatically'],
    sub: ['The app detects the successful submit and marks the job', 'Applied on your dashboard. Saved jobs, match scores', 'and every letter you’ve written, in one place.'],
    foot: 'free to download, credit packs for AI actions',
  },
];

const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function backdropSvg(img) {
  const headY = 268;
  const heads = img.head.map((l, i) =>
    `<text x="86" y="${headY + i * 62}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="52" font-weight="800" letter-spacing="-1" fill="#FFFFFF">${esc(l)}</text>`).join('');
  const subY = headY + img.head.length * 62 + 26;
  const subs = img.sub.map((l, i) =>
    `<text x="86" y="${subY + i * 31}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="21" fill="#B9C4DC">${esc(l)}</text>`).join('');
  const footY = subY + img.sub.length * 31 + 44;
  return Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0B1120"/><stop offset="1" stop-color="#101A33"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#06B6D4"/><stop offset="1" stop-color="#3B82F6"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#06B6D4" stop-opacity="0.28"/><stop offset="1" stop-color="#06B6D4" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <circle cx="${W - 330}" cy="${H / 2}" r="430" fill="url(#glow)"/>
  <rect x="86" y="196" width="46" height="5" rx="2.5" fill="url(#accent)"/>
  <text x="86" y="180" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="17" font-weight="700" letter-spacing="3.5" fill="#06B6D4">${esc(img.kicker)}</text>
  ${heads}
  ${subs}
  <text x="86" y="${Math.min(footY, H - 56)}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="17.5" font-weight="600" fill="#5F6E92">${esc(img.foot)}</text>
  <text x="${W - 40}" y="${H - 30}" text-anchor="end" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="15" font-weight="700" fill="#3D4A68">cvapplyr.com</text>
</svg>`);
}

const phoneMask = (w, h, r) => Buffer.from(
  `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><rect width="${w}" height="${h}" rx="${r}" ry="${r}" fill="#fff"/></svg>`);
const phoneBorder = (w, h, r) => Buffer.from(
  `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><rect x="1.5" y="1.5" width="${w - 3}" height="${h - 3}" rx="${r}" ry="${r}" fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="3"/></svg>`);

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let total = 0;

  for (const img of IMAGES) {
    const src = path.join(SRC_DIR, V[img.v]);
    if (!fs.existsSync(src)) throw new Error('missing source: ' + src);
    const framePng = path.join(TMP, img.id + '.png');
    sh('ffmpeg', ['-v', 'error', '-i', src, '-ss', String(img.t),
      '-vf', `crop=${CROP.w}:${CROP.h}:${CROP.x}:${CROP.y}`, '-frames:v', '1', framePng, '-y']);

    const R = 30;
    const phone = await sharp(framePng)
      .resize(PHONE_W, PHONE_H, { fit: 'fill', kernel: 'lanczos3' })
      .composite([{ input: phoneMask(PHONE_W, PHONE_H, R), blend: 'dest-in' }])
      .png().toBuffer();
    const phoneWithBorder = await sharp(phone)
      .composite([{ input: phoneBorder(PHONE_W, PHONE_H, R) }])
      .png().toBuffer();

    const px = W - PHONE_W - 118;
    const py = Math.round((H - PHONE_H) / 2);
    const out = path.join(OUT_DIR, img.id + '.png');
    await sharp(backdropSvg(img))
      .composite([{ input: phoneWithBorder, left: px, top: py }])
      .png({ compressionLevel: 9 }).toFile(out);

    const kb = Math.round(fs.statSync(out).size / 1024);
    total += kb;
    console.log(`${img.id.padEnd(16)} ${W}x${H}  ${kb} KB`);
  }
  console.log(`\n${IMAGES.length} gallery images, ${Math.round(total / 1024 * 10) / 10} MB → ${OUT_DIR}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
