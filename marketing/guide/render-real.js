// Render guide GIFs from the REAL app screenshots.
//   node marketing/guide/render-real.js [ids…]
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const GUIDES = require('./real');

const OUT = path.join(__dirname, 'out');
const FPS = 5, HOLD = 11, TAIL = 7;
const SRC_W = 921, SRC_H = 2000;      // reference space the storyboard coords are written in
const W = 460;                         // output width
const IMG_H = Math.round(W * SRC_H / SRC_W);
const CAP_H = 118;                     // caption band ABOVE the screen, so no app UI is covered
const H = IMG_H + CAP_H;
const S = W / SRC_W;                   // source → output scale

const px = (v) => `${(v * S).toFixed(2)}px`;

function patchHtml(list = []) {
  return list.map((q) => {
    const base = `position:absolute;left:${px(q.x)};top:${px(q.y)};width:${px(q.w)};height:${px(q.h)};`
      + `background:${q.bg};${q.r ? `border-radius:${px(q.r)};` : ''}overflow:hidden;`;
    if (!q.text) return `<div style="${base}"></div>`;
    const font = q.mono ? "ui-monospace,Menlo,monospace" : "-apple-system,'SF Pro Text','Segoe UI',Roboto,Helvetica,Arial,sans-serif";
    const align = q.center ? 'center' : q.right ? 'flex-end' : 'flex-start';
    const just = q.center ? 'center' : 'flex-start';
    return `<div style="${base}display:flex;align-items:${just};justify-content:${align};`
      + `padding-top:${px(q.pt || 0)};font-family:${font};font-size:${px(q.size || 22)};`
      + `font-weight:${q.weight || 600};color:${q.color || '#0B0F22'};line-height:${q.lh || 1.2};`
      + `letter-spacing:-0.2px;white-space:${q.lh ? 'normal' : 'nowrap'}">${q.text}</div>`;
  }).join('');
}

function html(step, n, total, pulse) {
  const dots = Array.from({ length: total }, (_, i) => `<div style="width:${i === n - 1 ? 14 : 5}px;height:5px;border-radius:3px;background:${i === n - 1 ? '#22D3EE' : 'rgba(255,255,255,.24)'}"></div>`).join('');
  const r = step.ring;
  const rx = (r.x - 8) * S, ry = (r.y - 8) * S + CAP_H, rw = (r.w + 16) * S, rh = (r.h + 16) * S;
  const cx = rx + rw / 2, cy = ry + rh / 2;
  const tipAbove = ry + rh > H - 150;
  const tipTop = tipAbove ? ry - 52 : ry + rh + 14;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{margin:0;padding:0;box-sizing:border-box;-webkit-font-smoothing:antialiased}
    body{width:${W}px;height:${H}px;overflow:hidden;background:#080C1C;
      font-family:-apple-system,'SF Pro Display','Segoe UI',Roboto,Helvetica,Arial,sans-serif}
    .cap{height:${CAP_H}px;padding:15px 20px 0;background:#080C1C}
    .eb{display:flex;align-items:center;gap:8px;margin-bottom:6px}
    .num{font-size:11px;font-weight:800;letter-spacing:.14em;color:#22D3EE;text-transform:uppercase}
    .dots{display:flex;gap:4px;margin-left:auto;align-items:center}
    h2{font-size:19px;line-height:1.22;font-weight:750;color:#fff;letter-spacing:-.4px}
    p.n{margin-top:4px;font-size:13px;line-height:1.32;color:rgba(255,255,255,.66);font-weight:500}
    .shot{position:absolute;left:0;top:${CAP_H}px;width:${W}px;height:${IMG_H}px}
    .shot img{width:${W}px;height:${IMG_H}px;display:block}
    .ring{position:absolute;border:3px solid #22D3EE;border-radius:14px;box-shadow:0 0 0 4px rgba(34,211,238,.20);z-index:40}
    .ptr{position:absolute;z-index:50;width:38px;height:38px;margin:-19px 0 0 -19px}
    .ptr .h{position:absolute;inset:0;border-radius:19px;background:rgba(34,211,238,.30);border:2px solid #22D3EE}
    .ptr .c{position:absolute;left:11px;top:11px;width:16px;height:16px;border-radius:8px;background:#22D3EE;box-shadow:0 2px 8px rgba(0,0,0,.35)}
    .note{position:absolute;z-index:55;background:#0B0F22;color:#fff;font-size:12px;font-weight:650;
      padding:8px 12px;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.35);max-width:260px;line-height:1.3}
  </style></head><body>
    <div class="cap"><div class="eb"><span class="num">Step ${n} of ${total}</span><div class="dots">${dots}</div></div>
      <h2>${step.title}</h2>${step.note ? `<p class="n">${step.note}</p>` : ''}</div>
    <div class="shot"><img src="${step.img}">${patchHtml(step.patches)}</div>
    <div class="ring" style="left:${rx}px;top:${ry}px;width:${rw}px;height:${rh}px"></div>
    ${step.noTap ? '' : `<div class="ptr" style="left:${cx}px;top:${cy}px;transform:scale(${pulse.s});opacity:${pulse.o}"><div class="h"></div><div class="c"></div></div>`}
    ${step.tip ? `<div class="note" style="left:${Math.max(12, Math.min(rx, W - 274))}px;top:${tipTop}px">${step.tip}</div>` : ''}
  </body></html>`;
}

(async () => {
  const only = process.argv.slice(2);
  const list = only.length ? GUIDES.filter((g) => only.some((o) => g.id.startsWith(o))) : GUIDES;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
  fs.mkdirSync(OUT, { recursive: true });

  for (const guide of list) {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cvreal-'));
    let k = 0;
    for (let s = 0; s < guide.steps.length; s++) {
      const step = guide.steps[s];
      const count = HOLD + (s === guide.steps.length - 1 ? TAIL : 0);
      for (let i = 0; i < count; i++) {
        const pulse = { s: i < 3 ? 1.5 - i * 0.17 : 1, o: i < 3 ? 0.55 + i * 0.15 : 1 };
        await page.setContent(html(step, s + 1, guide.steps.length, pulse), { waitUntil: 'load' });
        await page.screenshot({ path: path.join(tmp, `f${String(k).padStart(4, '0')}.png`) });
        k++;
      }
    }
    const gif = path.join(OUT, `${guide.id}.gif`);
    execFileSync('ffmpeg', ['-y', '-framerate', String(FPS), '-i', path.join(tmp, 'f%04d.png'),
      '-vf', `scale=${W}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
      '-loop', '0', gif], { stdio: 'pipe' });
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`✓ ${guide.id}.gif  ${k} frames  ${Math.round(fs.statSync(gif).size / 1024)} KB`);
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
