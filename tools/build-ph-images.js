// Product Hunt gallery images — 1270x760, built from the SAME simulator screenshots as the
// uploaded App Store set (marketing/iOS, June 10 captures) + the brand kit.
//
// v2 used video frames; the user rejected them ("not up to the mark") — video compression and
// mid-animation frames read badly at gallery size. These are the crisp native captures behind
// marketing/store-screenshots/apple/*, so the PH gallery matches what's live on the stores.
//
// ⚠️ PRIVACY: two source shots contain REAL recruiter names/emails (Experis contacts). The store
// set pixelated them; the same blur boxes are replicated here. Never ship these without the blur.
//
// Every headline names what the AI actually DOES (reads the posting / writes the letter / preps
// the application) — captions must match the visible UI, and the guardrails ban vague filler.
//
// Usage: node tools/build-ph-images.js
'use strict';
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const RAW_DIR = path.join(__dirname, '..', 'marketing', 'iOS');
const OUT_DIR = path.join(__dirname, '..', 'Claude', 'cvApplyr', 'ph_gallery');

const W = 1270, H = 760;
const SRC_W = 1320, SRC_H = 2868;
const PHONE_W = 420;                                    // phone bleeds off the bottom edge
const PHONE_X = W - PHONE_W - 96;
const PHONE_Y = 96;
const PHONE_R = 34;

// sorted() order matches marketing/store-screenshots/make_store_shots.py IOS[] indices
const RAW = fs.readdirSync(RAW_DIR).filter((f) => f.endsWith('.png')).sort()
  .map((f) => path.join(RAW_DIR, f));

// blur boxes in full-res source coords [x0, y0, x1, y1] — same as the uploaded store set
const BLURS = {
  5: [[85, 1195, 1000, 1455]],  // apply screen: hiring-contact block (taller than the store box — it clipped the name's top)
  6: [[200, 850, 950, 935]],    // email compose: To: address
};

// kicker = cyan eyebrow; head lines drawn as given (manual wrapping = no surprises)
const IMAGES = [
  {
    id: '01_hero', src: 11,
    kicker: 'CVAPPLYR — AI JOB APPLICATIONS',
    head: ['The AI that does the', 'job-hunt paperwork'],
    sub: ['Point it at any company. The AI finds their live jobs,', 'writes your cover letter and preps the application.', 'You review everything — and you hit submit.'],
    foot: 'cvapplyr.com  ·  iOS + Android',
  },
  {
    id: '02_livejobs', src: 3,
    kicker: 'LIVE JOBS',
    head: ['Real roles, from the', 'employer’s own site'],
    sub: ['No stale board copies. The AI reads each company’s', 'careers page and pulls the live openings — title,', 'location, skills, and salary when listed.'],
    foot: 'Straight from the source, not a scraped feed',
  },
  {
    id: '03_apply', src: 5,
    kicker: 'APPLY',
    head: ['Apply on the portal', '— or straight by email'],
    sub: ['The AI writes the letter and preps your documents', 'for the company’s own application. Visa, salary and', 'personal questions stay yours — nothing sends without you.'],
    foot: 'You review every application before it goes out',
  },
  {
    id: '04_coverletter', src: 10,
    kicker: 'COVER LETTERS',
    head: ['Written from the', 'real posting'],
    sub: ['The AI reads the actual job description and writes', 'for it — not a template. Pick the format the country', 'expects. Preview free, download as PDF or Word.'],
    foot: 'Country-correct formats, ready to attach',
  },
  {
    id: '05_email', src: 6,
    kicker: 'EMAIL APPLY',
    head: ['Email the recruiter,', 'documents attached'],
    sub: ['The app finds recruiter and HR contacts — with verified', 'emails where available — and drafts the email with your', 'résumé and tailored letter already attached.'],
    foot: 'You press send — always',
  },
  {
    id: '06_resume', src: 9,
    kicker: 'RÉSUMÉ BUILDER',
    head: ['Paste your messy story.', 'Get a clean résumé.'],
    sub: ['Old résumé text, a LinkedIn bio, rough notes — the AI', 'structures it into an ATS-friendly résumé, with every', 'section editable before you export.'],
    foot: 'Your words in, a hiring-ready document out',
  },
  {
    id: '07_formats', src: 8,
    kicker: 'COUNTRY FORMATS',
    head: ['One profile.', 'Every country’s format.'],
    sub: ['Swipe to compare designs and switch region any time —', 'the same profile exports in the format local', 'recruiters expect. Previews are free.'],
    foot: 'Free to download, credit packs for AI actions',
  },
];

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

async function pixelate(srcPath, boxes) {
  const buf = fs.readFileSync(srcPath);
  const overlays = [];
  for (const [x0, y0, x1, y1] of boxes) {
    const w = x1 - x0, h = y1 - y0;
    // ⚠️ two resizes must be separate pipelines — chained .resize() calls override, not compose
    const small = await sharp(buf)
      .extract({ left: x0, top: y0, width: w, height: h })
      .resize(Math.max(1, Math.round(w / 24)), Math.max(1, Math.round(h / 24)), { fit: 'fill' })
      .png().toBuffer();
    const region = await sharp(small)
      .resize(w, h, { fit: 'fill', kernel: 'nearest' })
      .png().toBuffer();
    overlays.push({ input: region, left: x0, top: y0 });
  }
  return sharp(buf).composite(overlays).png().toBuffer();
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // clear v2 leftovers so the folder is exactly this set
  for (const f of fs.readdirSync(OUT_DIR)) fs.unlinkSync(path.join(OUT_DIR, f));
  let total = 0;

  for (const img of IMAGES) {
    const srcPath = RAW[img.src];
    if (!srcPath) throw new Error('missing raw screenshot index ' + img.src);
    const meta = await sharp(srcPath).metadata();
    if (meta.width !== SRC_W || meta.height !== SRC_H) {
      throw new Error(`${path.basename(srcPath)} is ${meta.width}x${meta.height}, expected ${SRC_W}x${SRC_H}`);
    }

    const srcBuf = BLURS[img.src]
      ? await pixelate(srcPath, BLURS[img.src])
      : fs.readFileSync(srcPath);

    const visibleH = H - PHONE_Y;                       // phone bleeds off the bottom
    const phone = await sharp(srcBuf)
      .resize(PHONE_W, Math.round(SRC_H * PHONE_W / SRC_W), { kernel: 'lanczos3' })
      .extract({ left: 0, top: 0, width: PHONE_W, height: visibleH })
      .composite([{ input: phoneMask(PHONE_W, visibleH, PHONE_R), blend: 'dest-in' }])
      .png().toBuffer();

    const out = path.join(OUT_DIR, img.id + '.png');
    await sharp(backdropSvg(img))
      .composite([{ input: phone, left: PHONE_X, top: PHONE_Y }])
      .png({ compressionLevel: 9 }).toFile(out);

    const kb = Math.round(fs.statSync(out).size / 1024);
    total += kb;
    console.log(`${img.id.padEnd(16)} ${W}x${H}  ${kb} KB  (raw #${img.src}${BLURS[img.src] ? ', blurred' : ''})`);
  }
  console.log(`\n${IMAGES.length} gallery images, ${Math.round(total / 1024 * 10) / 10} MB → ${OUT_DIR}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
