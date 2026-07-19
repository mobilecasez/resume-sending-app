// Guide storyboards built on the REAL app screenshots (not mockups).
//
// Coordinates are expressed in the source screenshot's own space (921 x 2000 reference), which the
// renderer scales to the output. Every piece of personal / third-party data in a screenshot is
// covered by a `patch` — a filled rect (matching the local background) with generic text drawn on
// top — so the guides show the genuine interface without leaking anyone's details.
'use strict';
const path = require('path');

const SHOT_DIR = path.join(__dirname, '..', '..', 'Claude', 'cvApplyr', 'Images for Quick Video');
// Embed as a data URI: page.setContent() runs on an about:blank origin, which is not allowed to
// load file:// resources, so a plain file path silently renders a broken image.
const fs = require('fs');
const _cache = {};
const shot = (n) => (_cache[n] ||= 'data:image/png;base64,' + fs.readFileSync(path.join(SHOT_DIR, `${n}.png`)).toString('base64'));

// Generic stand-ins
const NAME = 'Alex Taylor';
const EMAIL = 'alex.taylor@example.com';
const CO = 'Northwind Analytics';
const CO_MAIL = 'careers@northwind.example.com';

// Sampled straight out of the screenshots so the patches are invisible.
const DARK  = '#0b1120';    // hero card fill (flat, not a gradient)
const DIM   = '#0b1020';    // same card, dimmed behind the compose sheet
const SIDE  = '#191f2b';    // cover-letter sidebar fill
const WHITE = '#ffffff';
const LIGHT = '#e5eaf3';    // light grey card / page background

// p = plain fill; t = fill + text on top
const p = (x, y, w, h, bg, r) => ({ x, y, w, h, bg, r });
const t = (x, y, w, h, bg, text, opts = {}) => ({ x, y, w, h, bg, text, ...opts });

// ── per-screenshot redactions ──────────────────────────────────────────────
const PATCH = {
  // 5.png — job detail with the cover letter generating
  jobDetail: [
    p(70, 328, 92, 86, '#e0338a', 22),                                   // company badge
    t(70, 328, 92, 86, 'transparent', 'N', { size: 40, weight: 800, color: '#fff', center: true }),
    t(182, 296, 700, 48, DARK, CO, { size: 30, weight: 800, color: '#fff' }),
    t(182, 342, 700, 104, DARK, 'A data & analytics company hiring across engineering, delivery and IT.',
      { size: 22, color: 'rgba(255,255,255,.62)', lh: 1.35 }),
    t(40, 412, 838, 134, DARK, 'Solution Architect Video and Audio',     // also hides the watermark
      { size: 33, weight: 800, color: '#fff', pt: 54 }),
    p(66, 870, 76, 76, '#3B82F6', 38),
    t(66, 870, 76, 76, 'transparent', 'HM', { size: 24, weight: 800, color: '#fff', center: true }),
    t(160, 858, 420, 34, WHITE, 'Hiring Manager', { size: 26, weight: 800, color: '#0B0F22' }),
    t(160, 894, 420, 30, WHITE, 'Recruiter', { size: 22, color: '#64748B' }),
    t(160, 924, 420, 34, WHITE, 'hiring@northwind.example.com', { size: 21, color: '#3B82F6', mono: true }),
  ],
  // 6.png — cover letter format picker + preview
  letterPreview: [
    p(116, 528, 108, 108, '#4F8DFF', 54),
    t(116, 528, 108, 108, 'transparent', 'AT', { size: 34, weight: 800, color: '#fff', center: true }),
    t(386, 528, 292, 36, WHITE, NAME.toUpperCase(), { size: 26, weight: 800, color: '#0B0F22' }),
    t(668, 528, 160, 24, WHITE, EMAIL, { size: 12, color: '#94A3B8', right: true }),
    t(42, 712, 252, 72, SIDE, CO, { size: 15, weight: 800, color: '#fff' }),
    t(42, 736, 252, 48, SIDE, 'Friedrichstr. 68, 10117 Berlin', { size: 14, color: '#cbd5e1', lh: 1.3 }),
    t(42, 830, 210, 28, SIDE, NAME, { size: 15, weight: 800, color: '#fff' }),
  ],
  // 7.png — compose + send
  compose: [
    p(60, 284, 830, 138, DIM),                                          // covers the dimmed company badge + name
    t(40, 486, 645, 44, WHITE, `New Application (${CO})`, { size: 27, weight: 800, color: '#0B0F22' }),
    t(166, 613, 470, 40, WHITE, CO_MAIL, { size: 22, color: '#0B0F22' }),
    t(470, 1336, 292, 34, LIGHT, 'Northwind Analytics.', { size: 23, weight: 400, color: '#0B0F22' }),
    t(66, 1714, 200, 34, LIGHT, NAME, { size: 23, weight: 400, color: '#0B0F22' }),
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
const guide4 = {
  id: '04-send-a-researched-cover-letter',
  title: 'Send a researched cover letter',
  steps: [
    {
      title: 'Generate the cover letter',
      note: 'It reads this posting and researches the employer before writing.',
      img: shot(5), patches: PATCH.jobDetail,
      ring: { x: 40, y: 1120, w: 852, h: 330 },
      noTap: true,
      tip: 'Written from the real job, not a template',
    },
    {
      title: 'Pick the country format',
      note: 'Each region has its own letter conventions — preview is free.',
      img: shot(6), patches: PATCH.letterPreview,
      ring: { x: 258, y: 283, w: 300, h: 66 },
    },
    {
      title: 'Download it when you’re happy',
      note: 'One page or A4 — saved straight to your documents.',
      img: shot(6), patches: PATCH.letterPreview,
      ring: { x: 30, y: 1792, w: 862, h: 92 },
    },
    {
      title: 'Send it to the employer',
      note: 'Résumé and cover letter attached automatically.',
      img: shot(7), patches: PATCH.compose,
      ring: { x: 308, y: 1828, w: 580, h: 96 },
    },
  ],
};

module.exports = [guide4];
