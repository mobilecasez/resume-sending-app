// Product Hunt gallery images — 1270x760, built from the July 2026 feature recordings + brand kit.
//
// History: v2 used video frames the user rejected (small phone, mid-animation frames); v3 used the
// June simulator captures behind the App Store set, rejected as "older screenshots". v4 = video
// frames again (current UI: Job tools dock, Still-needs-you list, Applied toast) but with the v3
// layout — big phone bleeding off the bottom — and every timestamp hand-picked from contact sheets
// to land on a static, fully-rendered screen.
//
// Frames are extracted frame-accurately (⚠️ -ss AFTER -i; keyframe seeking lands on the wrong
// screen; the recordings are VFR so always re-verify visually after changing a timestamp).
//
// Privacy: the chosen frames contain NO real-person data — the persona is the fictional
// "John Mathews" (cvapplyrtest@gmail.com) and the SQUER Hiring Contacts card is empty.
// ⚠️ If you add or move a frame, re-check it for real names/emails before shipping.
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
const CROP = { x: 712, y: 0, w: 496, h: 1080 };        // phone strip inside the 1920x1080 recordings
const PHONE_W = 420;                                    // phone bleeds off the bottom edge
const PHONE_X = W - PHONE_W - 96;
const PHONE_Y = 96;
const PHONE_R = 34;

const V = {
  resume: 'Resume Builder.mov',
  fetch: 'Fetch Job and Generate Cover Letter.mov',
  apply: 'Apply Job with Auto Fill.mov',
};

// kicker = cyan eyebrow; head lines drawn as given (manual wrapping = no surprises)
const IMAGES = [
  {
    id: '01_hero', v: 'apply', t: 14.4,                 // Job tools dock over SQUER's own portal
    kicker: 'CVAPPLYR — AI JOB APPLICATIONS',
    head: ['The AI that does the', 'job-hunt paperwork'],
    sub: ['Find jobs on the real Google. The AI reads the posting,', 'writes your cover letter and fills the employer’s own', 'application form. You review — and you hit submit.'],
    foot: 'cvapplyr.com  ·  iOS + Android',
  },
  {
    id: '02_google', v: 'fetch', t: 4.6,                // real Google results, AI Overview, Job tools FAB
    kicker: 'SEARCH',
    head: ['The real Google,', 'inside the app'],
    sub: ['No scraped listings, no stale board. Open any result —', 'tap the robot on the job’s own page and the AI reads', 'and saves the posting with full details.'],
    foot: 'Works on any job site — even ones we’ve never seen',
  },
  {
    id: '03_apply', v: 'apply', t: 2.0,                 // job detail: match %, salary, contacts, AI letter
    kicker: 'APPLY',
    head: ['Apply on the portal', '— or straight by email'],
    sub: ['Match score, salary and skills up front. The AI writes', 'the letter and preps your documents — add a hiring', 'contact and the same application can go out by email.'],
    foot: 'You review every application before it goes out',
  },
  {
    id: '04_autofill', v: 'apply', t: 15.7,             // "Done — review & submit" + STILL NEEDS YOU list
    kicker: 'AUTO FILL',
    head: ['AI fills the form.', 'You stay in charge.'],
    sub: ['It completes the company’s own application and lists', 'what still needs you. Visa, salary and personal questions', 'are always yours — nothing is submitted without you.'],
    foot: 'Works on the employer’s own career portal',
  },
  {
    id: '05_coverletter', v: 'apply', t: 5.5,           // Cover Letter, country tabs, photo template
    kicker: 'COVER LETTERS',
    head: ['Written from the', 'real posting'],
    sub: ['The AI reads the actual job description and writes', 'for it — not a template. Pick the format the country', 'expects. Preview free, download as PDF or Word.'],
    foot: 'Country-correct formats, ready to attach',
  },
  {
    id: '06_resume', v: 'resume', t: 1.6,               // "Tell Us Your Story", no keyboard
    kicker: 'RÉSUMÉ BUILDER',
    head: ['Paste your messy story.', 'Get a clean résumé.'],
    sub: ['Old résumé text, a LinkedIn bio, rough notes — the AI', 'structures it into an ATS-friendly résumé, with every', 'section editable before you export.'],
    foot: 'Your words in, a hiring-ready document out',
  },
  {
    id: '07_formats', v: 'resume', t: 6.5,              // Choose a Format, Azure Sidebar template
    kicker: 'COUNTRY FORMATS',
    head: ['One profile.', 'Every country’s format.'],
    sub: ['Swipe to compare designs and switch region any time —', 'the same profile exports in the format local', 'recruiters expect. Previews are free.'],
    foot: 'Generic, USA/Canada, UK/Australia and more',
  },
  {
    id: '08_applied', v: 'apply', t: 18.4,              // green "marked as Applied" toast on the thank-you page
    kicker: 'TRACKING',
    head: ['Submitted — and', 'tracked automatically'],
    sub: ['The app detects the employer’s real “thank you” page', 'and marks the job Applied on your dashboard — no', 'manual logging, no spreadsheets.'],
    foot: 'Free to download, credit packs for AI actions',
  },
];

const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function backdropSvg(img) {
  const headY = 258;
  const heads = img.head.map((l, i) =>
    `<text x="86" y="${headY + i * 60}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="50" font-weight="800" letter-spacing="-1" fill="#FFFFFF">${esc(l)}</text>`).join('');
  const subY = headY + img.head.length * 60 + 26;
  const subs = img.sub.map((l, i) =>
    `<text x="86" y="${subY + i * 31}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="20" fill="#B9C4DC">${esc(l)}</text>`).join('');
  const footY = subY + img.sub.length * 31 + 44;
  const rx = PHONE_X - 6, ry = PHONE_Y - 6;
  return Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0B1120"/><stop offset="1" stop-color="#101A33"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#06B6D4"/><stop offset="1" stop-color="#3B82F6"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#06B6D4" stop-opacity="0.26"/><stop offset="1" stop-color="#06B6D4" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#06B6D4" stop-opacity="0.75"/><stop offset="1" stop-color="#3B82F6" stop-opacity="0.55"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <circle cx="${PHONE_X + PHONE_W / 2}" cy="${H / 2 + 40}" r="430" fill="url(#glow)"/>
  <rect x="86" y="196" width="46" height="5" rx="2.5" fill="url(#accent)"/>
  <text x="86" y="180" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="17" font-weight="700" letter-spacing="3.5" fill="#06B6D4">${esc(img.kicker)}</text>
  ${heads}
  ${subs}
  <text x="86" y="${Math.min(footY, H - 56)}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="17.5" font-weight="600" fill="#5F6E92">${esc(img.foot)}</text>
  <text x="40" y="${H - 30}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="15" font-weight="700" fill="#3D4A68">cvapplyr.com</text>
  <rect x="${rx}" y="${ry}" width="${PHONE_W + 12}" height="${H - ry + 60}" rx="${PHONE_R + 6}" fill="none" stroke="url(#ring)" stroke-width="3"/>
</svg>`);
}

// rounded-top mask: rect extends past the crop bottom so only the top corners round
const phoneMask = (w, h, r) => Buffer.from(
  `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><rect width="${w}" height="${h + r}" rx="${r}" ry="${r}" fill="#fff"/></svg>`);

// the recordings carry iOS's red screen-recording dot inside the (pure black) island pill at a
// fixed spot — a black circle over it reads as a normal pill (source coords, same in every video)
const RECORD_DOT_PATCH = Buffer.from(
  `<svg width="${CROP.w}" height="${CROP.h}" xmlns="http://www.w3.org/2000/svg"><circle cx="159" cy="40" r="15" fill="#000"/></svg>`);

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // clear the previous set so the folder is exactly this one
  for (const f of fs.readdirSync(OUT_DIR)) fs.unlinkSync(path.join(OUT_DIR, f));
  let total = 0;

  for (const img of IMAGES) {
    const src = path.join(SRC_DIR, V[img.v]);
    if (!fs.existsSync(src)) throw new Error('missing source: ' + src);
    const framePng = path.join(TMP, img.id + '.png');
    sh('ffmpeg', ['-v', 'error', '-i', src, '-ss', String(img.t),
      '-vf', `crop=${CROP.w}:${CROP.h}:${CROP.x}:${CROP.y}`, '-frames:v', '1', framePng, '-y']);

    const cleaned = await sharp(framePng)
      .composite([{ input: RECORD_DOT_PATCH }])
      .png().toBuffer();

    const visibleH = H - PHONE_Y;                       // phone bleeds off the bottom
    const phone = await sharp(cleaned)
      .resize(PHONE_W, Math.round(CROP.h * PHONE_W / CROP.w), { kernel: 'lanczos3' })
      .extract({ left: 0, top: 0, width: PHONE_W, height: visibleH })
      .composite([{ input: phoneMask(PHONE_W, visibleH, PHONE_R), blend: 'dest-in' }])
      .png().toBuffer();

    const out = path.join(OUT_DIR, img.id + '.png');
    await sharp(backdropSvg(img))
      .composite([{ input: phone, left: PHONE_X, top: PHONE_Y }])
      .png({ compressionLevel: 9 }).toFile(out);

    const kb = Math.round(fs.statSync(out).size / 1024);
    total += kb;
    console.log(`${img.id.padEnd(16)} ${W}x${H}  ${kb} KB  (${img.v} @ ${img.t}s)`);
  }
  console.log(`\n${IMAGES.length} gallery images, ${Math.round(total / 1024 * 10) / 10} MB → ${OUT_DIR}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
