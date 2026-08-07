/**
 * Renders every graphic layer the film needs, as PNG, via headless Chromium.
 *
 * This exists because the ffmpeg on this machine is built without libfreetype, so `drawtext` is
 * unavailable. Rendering type in a browser is the better trade anyway: real font stacks, real
 * kerning, text-wrap balancing, and CSS gradients, instead of ffmpeg's one-line-at-a-time text.
 *
 * Palette is lifted from the app icon itself (#23375d / #41577e / #64709d), pushed to an ink
 * ground so the phone screen - which is mostly white UI - reads as the brightest thing in frame.
 * One warm accent (#F4A259) carries the phase marks and nothing else.
 *
 *   node render-assets.js            # 1920x1080 landscape
 *   node render-assets.js --vertical # 1080x1920 for Reels/Shorts
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const VERTICAL = process.argv.includes('--vertical');
const W = VERTICAL ? 1080 : 1920;
const H = VERTICAL ? 1920 : 1080;
const OUT = path.join(HERE, VERTICAL ? 'cards-v' : 'cards');

const cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'scenes.json'), 'utf8'));

// ── design tokens ────────────────────────────────────────────────────────────
const T = `
  --ink:      #080D18;
  --ground-1: #16223A;
  --ground-2: #0B1220;
  --rule:     #2B3C61;
  --fg:       #F3F6FB;
  --fg-dim:   #93A4C4;
  --fg-faint: #55668A;
  --accent:   #F4A259;
  --brand:    #64709D;
`;

const FONTS = `
  --sans: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", sans-serif;
  --cond: "DIN Condensed", "Avenir Next Condensed", var(--sans);
`;

const BASE = `
  <style>
    :root { ${T} ${FONTS} }
    * { margin:0; padding:0; box-sizing:border-box; }
    html,body { width:${W}px; height:${H}px; overflow:hidden; }
    body { font-family:var(--sans); -webkit-font-smoothing:antialiased;
           font-feature-settings:"kern" 1; text-rendering:geometricPrecision; }
    .stage { position:relative; width:${W}px; height:${H}px; }
    .transparent { background:transparent; }
    /* The ground: an off-centre pool of light behind the phone, falling to near-black at the
       edges, plus a fine grain so the gradient never bands on a big screen. */
    .ground {
      background:
        radial-gradient(120% 90% at ${VERTICAL ? '50% 34%' : '72% 42%'},
                        var(--ground-1) 0%, var(--ground-2) 52%, var(--ink) 100%);
    }
    .grain { position:absolute; inset:0; opacity:.055; mix-blend-mode:overlay;
      background-image:url("data:image/svg+xml;utf8,\
<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'>\
<filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3'/></filter>\
<rect width='160' height='160' filter='url(%23n)'/></svg>"); }
    .eyebrow { font-size:${VERTICAL ? 22 : 24}px; font-weight:600; letter-spacing:.22em;
               text-transform:uppercase; color:var(--accent); }
    .tick { width:56px; height:3px; background:var(--accent); border-radius:2px; margin-bottom:26px; }
    h1 { font-weight:640; letter-spacing:-.022em; line-height:1.03; color:var(--fg);
         text-wrap:balance; }
    .sub { color:var(--fg-dim); font-weight:420; letter-spacing:-.005em; text-wrap:balance; }
  </style>`;

// ── the per-scene text plate (alpha) ─────────────────────────────────────────
function platePage(sc) {
  const phases = cfg.phases;
  const label = (phases.find((p) => p.key === sc.phase) || {}).label || '';
  const rail = phases.map((p) => {
      const done = phases.findIndex((x) => x.key === p.key) < phases.findIndex((x) => x.key === sc.phase);
      const now = p.key === sc.phase;
      const pct = now ? Math.round((sc.phase_i / p.n) * 100) : done ? 100 : 0;
      return `<div class="ph ${now ? 'on' : done ? 'done' : ''}" style="flex:${p.n}">
                <div class="bar"><i style="width:${pct}%"></i></div>
                <div class="phl">${p.label}</div>
              </div>`;
    }).join('');

  const col = VERTICAL
    ? `left:80px; right:80px; top:150px;`
    : `left:150px; width:1010px; top:50%; transform:translateY(-50%);`;

  return `<!doctype html><meta charset="utf-8">${BASE}
  <style>
    body { background:transparent; }
    .col { position:absolute; ${col} }
    .eyebrow { margin-bottom:${VERTICAL ? 18 : 22}px; }
    h1 { font-size:${VERTICAL ? 68 : 78}px; margin-bottom:${VERTICAL ? 20 : 26}px; }
    .sub { font-size:${VERTICAL ? 30 : 35}px; line-height:1.35; }
    /* Stops short of the device. Run full-bleed it draws a line straight across the phone. */
    .rail { position:absolute; left:${VERTICAL ? 80 : 150}px;
            right:${VERTICAL ? 80 : 760}px; bottom:${VERTICAL ? 110 : 82}px;
            display:flex; gap:22px; align-items:flex-end; }
    .ph { opacity:.34; }
    .ph.done { opacity:.5; }
    .ph.on  { opacity:1; }
    .bar { height:4px; border-radius:3px; background:var(--rule); overflow:hidden; }
    .bar i { display:block; height:100%; background:var(--fg-faint); border-radius:3px; }
    .ph.done .bar i { background:var(--brand); }
    .ph.on   .bar i { background:var(--accent); }
    .phl { margin-top:13px; font-size:19px; font-weight:600; letter-spacing:.16em;
           text-transform:uppercase; color:var(--fg-dim); }
    .ph.on .phl { color:var(--fg); }
  </style>
  <div class="stage">
    <div class="col">
      <div class="tick"></div>
      <div class="eyebrow">${label}</div>
      <h1>${esc(sc.head)}</h1>
      <div class="sub">${esc(sc.sub)}</div>
    </div>
    <div class="rail">${rail}</div>
  </div>`;
}

// ── full-frame cards ─────────────────────────────────────────────────────────
function titlePage(sc) {
  const c = sc.card;
  return `<!doctype html><meta charset="utf-8">${BASE}
  <style>
    .wrap { position:absolute; inset:0; display:flex; flex-direction:column;
            justify-content:center; align-items:center; text-align:center;
            padding:0 ${VERTICAL ? '7%' : '12%'}; }
    .kick { font-size:26px; font-weight:600; letter-spacing:.34em; text-transform:uppercase;
            color:var(--accent); margin-bottom:42px; }
    h1 { font-size:${VERTICAL ? 74 : 108}px; line-height:1.08; }
    h1 .dim { color:var(--fg-dim); font-weight:560; }
    .hair { width:120px; height:3px; background:var(--rule); margin:52px auto 0; }
  </style>
  <div class="stage ground"><div class="grain"></div>
    <div class="wrap">
      <div class="kick">${esc(c.kicker)}</div>
      <h1>${esc(c.big)}<br><span class="dim">${esc(c.big2)}</span></h1>
      <div class="hair"></div>
    </div>
  </div>`;
}

function endPage(sc, iconDataUri) {
  const c = sc.card;
  return `<!doctype html><meta charset="utf-8">${BASE}
  <style>
    .wrap { position:absolute; inset:0; display:flex; flex-direction:column;
            justify-content:center; align-items:center; text-align:center; }
    .icon { width:${VERTICAL ? 190 : 168}px; height:${VERTICAL ? 190 : 168}px; border-radius:38px;
            margin-bottom:46px; box-shadow:0 30px 80px rgba(0,0,0,.55); }
    h1 { font-size:${VERTICAL ? 96 : 104}px; letter-spacing:-.03em; }
    .sub { font-size:${VERTICAL ? 34 : 38}px; margin-top:26px; }
    .url { margin-top:56px; font-size:26px; font-weight:600; letter-spacing:.2em;
           text-transform:uppercase; color:var(--accent); }
    .stores { margin-top:30px; font-size:22px; letter-spacing:.14em; color:var(--fg-faint);
              text-transform:uppercase; font-weight:600; }
  </style>
  <div class="stage ground"><div class="grain"></div>
    <div class="wrap">
      ${iconDataUri ? `<img class="icon" src="${iconDataUri}">` : ''}
      <h1>${esc(c.big)}</h1>
      <div class="sub">${esc(c.sub)}</div>
      <div class="url">${esc(c.url)}</div>
      <div class="stores">App Store &nbsp;·&nbsp; Google Play</div>
    </div>
  </div>`;
}

// Presenter overlay: a scrim up the bottom of frame carrying the lower third. It has a second job -
// the de-watermarked plate leaves a faint smear where the Luma mark crossed the presenter's
// shoulder, and this covers exactly that band.
function presenterOverlayPage(lower) {
  return `<!doctype html><meta charset="utf-8">${BASE}
  <style>
    body { background:transparent; }
    /* Held near-opaque well up its height on purpose. The generated clip carries a moving Luma
       watermark that visits all four corners; the two bottom visits sit partly on the presenter's
       shoulder, where delogo can only smear rather than reconstruct. This scrim is what covers that
       band, so it has to stay dense to roughly 45% of its height, not fade out immediately. */
    .scrim { position:absolute; left:0; right:0; bottom:0; height:${VERTICAL ? 700 : 400}px;
      background:linear-gradient(to top,
        rgba(8,13,24,.96) 0%, rgba(8,13,24,.92) 34%, rgba(8,13,24,.74) 56%, rgba(8,13,24,.36) 78%, rgba(8,13,24,0) 100%); }
    .lt { position:absolute; left:${VERTICAL ? 80 : 130}px; bottom:${VERTICAL ? 180 : 104}px; }
    .lt .tick { margin-bottom:20px; }
    .lt .t { font-size:${VERTICAL ? 58 : 62}px; font-weight:660; letter-spacing:-.02em; color:var(--fg); }
    .lt .s { margin-top:10px; font-size:${VERTICAL ? 28 : 30}px; color:var(--fg-dim); letter-spacing:.01em; }
  </style>
  <div class="stage">
    <div class="scrim"></div>
    ${lower ? `<div class="lt"><div class="tick"></div>
        <div class="t">${esc(lower.title)}</div>
        <div class="s">${esc(lower.sub)}</div></div>` : ''}
  </div>`;
}

function groundPage() {
  return `<!doctype html><meta charset="utf-8">${BASE}
  <div class="stage ground"><div class="grain"></div></div>`;
}

// Escapes for HTML, and promotes straight quotes to typographic ones - a straight apostrophe in a
// 78px headline is the single most obvious tell that type was pasted rather than set.
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/(\w)'(\w)/g, '$1’$2')      // employer's
  .replace(/'(\w)/g, '’$1')            // 'tis, it's at a word start
  .replace(/"([^"]*)"/g, '“$1”'); // paired doubles

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const iconPath = path.resolve(HERE, '../../../MobileApp/assets/images/icon.png');
  let icon = null;
  if (fs.existsSync(iconPath)) icon = 'data:image/png;base64,' + fs.readFileSync(iconPath).toString('base64');

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });

  async function shot(html, file, transparent) {
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(OUT, file), omitBackground: !!transparent });
    process.stdout.write(`  ${file}\n`);
  }

  await shot(groundPage(), 'ground.png', false);

  for (const sc of cfg.scenes) {
    if (sc.kind === 'screen') await shot(platePage(sc), `plate-${sc.id}.png`, true);
    else if (sc.kind === 'titlecard') await shot(titlePage(sc), `card-${sc.id}.png`, false);
    else if (sc.kind === 'endcard') await shot(endPage(sc, icon), `card-${sc.id}.png`, false);
    else if (sc.kind === 'presenter') await shot(presenterOverlayPage(sc.lower_third), `pres-${sc.id}.png`, true);
  }

  await browser.close();
  console.log(`\nRendered into ${path.relative(HERE, OUT)}/ at ${W}x${H}`);
})();
