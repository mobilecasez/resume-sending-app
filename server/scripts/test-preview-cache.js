// The gallery's design-preview cache — a real round trip through the disk, no chromium involved.
//   DATABASE_URL=postgresql://t@localhost:5432/t node server/scripts/test-preview-cache.js
//
// Why this exists: opening the design gallery used to render every design it showed, EVERY time,
// and again on every swatch tap. Nothing was reused, so the first design in the list also paid the
// browser cold start and always looked slow. These assertions pin the cache that fixed it — and,
// just as importantly, pin that it INVALIDATES, because a stale preview of someone's resume is a
// worse bug than a slow one.
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x).slice(0, 200) : '')); } };

const { previewFile, readPreviewCache, writePreviewCache } = require('../controllers/resumeBuilderController.js');

const USER = 999999;                                  // not a real account; nothing else touches it
const ROW = { updated_at: new Date('2026-01-01T00:00:00Z'), resume_data: {} };
const PREVIEW = { id: 'azure', name: 'Azure Sidebar', accent: '#2563eb', ats: null, image: 'data:image/jpeg;base64,AAAA', width: 794, height: 1123 };

const tmp = path.join(__dirname, '..', '..', 'temp');
const mine = () => { try { return fs.readdirSync(tmp).filter((n) => n.startsWith(`resume_prev_${USER}_`)); } catch { return []; } };
const clean = () => mine().forEach((n) => { try { fs.unlinkSync(path.join(tmp, n)); } catch {} });

(async () => {
  clean();

  console.log('── a rendered preview survives to the next request ──');
  ok('nothing cached to begin with', (await readPreviewCache(USER, ROW, 'azure', 'none')) === null);
  await writePreviewCache(USER, ROW, PREVIEW, 'none');
  const hit = await readPreviewCache(USER, ROW, 'azure', 'none');
  ok('…and comes back', !!hit);
  ok('…with the image intact', hit && hit.image === PREVIEW.image);
  ok('⚠️ …and the page HEIGHT, which varies per design and the client lays out against',
    hit && hit.height === 1123 && hit.width === 794);

  console.log('── ⚠️ it invalidates, or it would serve a stale resume ──');
  ok('a different design is a different entry', (await readPreviewCache(USER, ROW, 'mono', 'none')) === null);
  ok('a NEW PHOTO invalidates', (await readPreviewCache(USER, ROW, 'azure', '17000000000')) === null);
  const edited = { ...ROW, updated_at: new Date('2026-02-02T00:00:00Z') };
  ok('an EDITED RESUME invalidates', (await readPreviewCache(USER, edited, 'azure', 'none')) === null);
  ok('…and the old entry is still there for the old version (not clobbered)',
    !!(await readPreviewCache(USER, ROW, 'azure', 'none')));

  console.log('── keys are filesystem-safe and per user ──');
  const f = previewFile(USER, ROW, 'azure', 'none');
  ok('the filename carries no separators from the key', !path.basename(f).includes('/') && !path.basename(f).includes(':'));
  ok('…and is namespaced away from the Home thumbnails',
    path.basename(f).startsWith(`resume_prev_${USER}_`) && !path.basename(f).includes('resume_thumb'));
  ok('another user cannot read it', previewFile(USER + 1, ROW, 'azure', 'none') !== f);

  console.log('── a corrupt entry is a miss, never a crash ──');
  fs.writeFileSync(f, 'not json at all');
  ok('unparseable cache reads as empty', (await readPreviewCache(USER, ROW, 'azure', 'none')) === null);
  fs.writeFileSync(f, JSON.stringify({ id: 'azure' }));            // no image
  ok('an entry with no image reads as empty', (await readPreviewCache(USER, ROW, 'azure', 'none')) === null);

  clean();
  console.log(`\npreview cache: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
