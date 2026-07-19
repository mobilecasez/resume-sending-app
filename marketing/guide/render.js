// Render the "How to use CVApplyr" guide GIFs.
//   node marketing/guide/render.js            → all guides
//   node marketing/guide/render.js 01 03       → only those ids
// Frames are rendered with Playwright at 2x then assembled by ffmpeg into a low-fps GIF
// (a held frame costs almost nothing in GIF, so each step lingers long enough to READ).
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const { frame } = require('./ui');
const GUIDES = require('./guides');

const OUT = path.join(__dirname, 'out');
const FPS = 5;              // low fps, as requested
const HOLD = 11;            // frames per step (~2.2s) — enough to read the caption
const TAIL = 7;             // extra frames on the final step
const WIDTH = 460;          // GIF width

async function renderGuide(browser, guide) {
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cvguide-'));
  const page = await browser.newPage({ viewport: { width: 540, height: 1000 }, deviceScaleFactor: 2 });
  const total = guide.steps.length;
  let k = 0;

  for (let s = 0; s < total; s++) {
    const step = guide.steps[s];
    const count = HOLD + (s === total - 1 ? TAIL : 0);
    await page.setContent(frame({ n: s + 1, total, title: step.title, note: step.note, screen: step.screen }), { waitUntil: 'load' });

    // Measure the element marked `.t` so the ring/pointer land exactly on the real target,
    // instead of on hand-guessed coordinates that drift whenever the layout changes.
    const box = await page.$eval('.t', (el) => {
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    }).catch(() => null);

    for (let i = 0; i < count; i++) {
      // tap pulse on the first few frames, then hold perfectly still (cheap in GIF)
      const scale = i < 3 ? 1.5 - i * 0.17 : 1;
      const op = i < 3 ? 0.55 + i * 0.15 : 1;
      await page.evaluate(({ box, scale, op, tip, pad, noTap }) => {
        document.querySelectorAll('.ring,.ptr,.note').forEach((n) => n.remove());
        if (!box) return;
        const mk = (cls, css) => { const d = document.createElement('div'); d.className = cls; d.style.cssText = css; return d; };
        const rx = box.x - pad, ry = box.y - pad, rw = box.w + pad * 2, rh = box.h + pad * 2;
        document.querySelector('.stage').appendChild(
          mk('ring', `left:${rx}px;top:${ry}px;width:${rw}px;height:${rh}px;border-radius:${Math.min(18, rh / 2)}px`));
        if (!noTap) {   // a result/progress screen gets the highlight but no "tap here" finger
          const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
          const p = mk('ptr', `left:${cx}px;top:${cy}px;transform:scale(${scale});opacity:${op}`);
          p.innerHTML = '<div class="h"></div><div class="c"></div>';
          document.querySelector('.stage').appendChild(p);
        }
        if (tip) {
          // Prefer BELOW the highlight (nothing to collide with there); only go above when the
          // target sits near the bottom of the screen. Never let it ride up into the caption.
          const above = ry + rh > 790;
          const top = above ? Math.max(150, ry - 48) : ry + rh + 12;
          const n = mk('note', `left:${Math.max(14, Math.min(rx, 280))}px;top:${top}px`);
          n.classList.add(above ? 'dn' : 'up');
          n.textContent = tip;
          document.querySelector('.stage').appendChild(n);
        }
      }, { box, scale, op, tip: step.tip || null, pad: step.pad == null ? 6 : step.pad, noTap: !!step.noTap });
      await page.screenshot({ path: path.join(tmp, `f${String(k).padStart(4, '0')}.png`) });
      k++;
    }
  }
  await page.close();

  fs.mkdirSync(OUT, { recursive: true });
  const gif = path.join(OUT, `${guide.id}.gif`);
  // palettegen/paletteuse keeps the flat UI colours clean at a small file size
  execFileSync('ffmpeg', ['-y', '-framerate', String(FPS), '-i', path.join(tmp, 'f%04d.png'),
    '-vf', `scale=${WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
    '-loop', '0', gif], { stdio: 'pipe' });
  fs.rmSync(tmp, { recursive: true, force: true });
  const kb = Math.round(fs.statSync(gif).size / 1024);
  console.log(`✓ ${guide.id}.gif  ${k} frames  ${kb} KB  — ${guide.title}`);
  return { gif, kb, frames: k };
}

(async () => {
  const only = process.argv.slice(2);
  const list = only.length ? GUIDES.filter((g) => only.some((o) => g.id.startsWith(o))) : GUIDES;
  if (!list.length) { console.error('no matching guides'); process.exit(1); }
  const browser = await chromium.launch();
  for (const g of list) await renderGuide(browser, g);
  await browser.close();
  console.log(`\nOutput: ${OUT}`);
})().catch((e) => { console.error(e); process.exit(1); });
