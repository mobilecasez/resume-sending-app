/**
 * Every static graphic layer the five films need, as PNG, via headless Chromium.
 *
 * Chromium rather than ffmpeg's drawtext because the ffmpeg on this machine is built without
 * libfreetype, so drawtext does not exist - but it is the better trade regardless: real font
 * stacks, real kerning, text-wrap balancing and CSS gradients instead of one line of text at a
 * time.
 *
 * Palette is the app icon's own (#23375d / #41577e / #64709d) pushed to an ink ground, so the phone
 * screen - almost entirely white UI - stays the brightest thing in frame. One warm accent (#F4A259)
 * carries the series rail and nothing else.
 *
 * The rail across the top is the one piece of chrome unique to the series. It is not decoration:
 * five segments, the current film's filled to how far through it you are, so someone who lands on
 * film 4 in a feed can see immediately that there are three before it and one after.
 *
 *   node render-cards.js
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const W = 1080;
const H = 1920;
const OUT = path.join(HERE, 'cards');

const cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'series.json'), 'utf8'));

// Phone geometry, mirrored exactly in build.py. Everything above and below is laid out around it.
const PH_H = 1100;
const PH_W = Math.round((496 / 1080) * PH_H / 2) * 2;
const PH_X = Math.round((W - PH_W) / 2);
const PH_Y = 560;

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
  --good:     #48B98A;
  --sans: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", sans-serif;
`;

const BASE = `
  <style>
    :root { ${T} }
    * { margin:0; padding:0; box-sizing:border-box; }
    html,body { width:${W}px; height:${H}px; overflow:hidden; }
    body { font-family:var(--sans); -webkit-font-smoothing:antialiased;
           font-feature-settings:"kern" 1; text-rendering:geometricPrecision; }
    .stage { position:relative; width:${W}px; height:${H}px; }
    .ground {
      background: radial-gradient(120% 82% at 50% 36%,
                  var(--ground-1) 0%, var(--ground-2) 52%, var(--ink) 100%);
    }
    /* Fine grain so a gradient this large never bands on a phone screen. */
    .grain { position:absolute; inset:0; opacity:.055; mix-blend-mode:overlay;
      background-image:url("data:image/svg+xml;utf8,\
<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'>\
<filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3'/></filter>\
<rect width='160' height='160' filter='url(%23n)'/></svg>"); }
    h1 { font-weight:640; letter-spacing:-.022em; line-height:1.04; color:var(--fg);
         text-wrap:balance; }
    .sub { color:var(--fg-dim); font-weight:420; letter-spacing:-.005em; text-wrap:balance; }
  </style>`;

// ── the series rail ──────────────────────────────────────────────────────────
// Five segments across the top. Past films read as solid brand; the current one fills to the
// scene's position within it; the ones ahead stay as empty track.
function railHtml(filmN, frac) {
  const segs = cfg.films.map((f) => {
    const state = f.n < filmN ? 'done' : f.n === filmN ? 'on' : '';
    const pct = f.n < filmN ? 100 : f.n === filmN ? Math.round(frac * 100) : 0;
    return `<div class="seg ${state}"><div class="bar"><i style="width:${pct}%"></i></div>
              <div class="sn">${String(f.n).padStart(2, '0')}</div></div>`;
  }).join('');
  return `<div class="rail">${segs}</div>`;
}
const RAIL_CSS = `
  .rail { position:absolute; left:76px; right:76px; top:76px; display:flex; gap:14px; }
  .seg { flex:1; opacity:.3; }
  .seg.done { opacity:.55; }
  .seg.on { opacity:1; }
  .bar { height:5px; border-radius:3px; background:var(--rule); overflow:hidden; }
  .bar i { display:block; height:100%; border-radius:3px; background:var(--fg-faint); }
  .seg.done .bar i { background:var(--brand); }
  .seg.on   .bar i { background:var(--accent); }
  .sn { margin-top:11px; font-size:19px; font-weight:700; letter-spacing:.12em;
        color:var(--fg-faint); font-variant-numeric:tabular-nums; }
  .seg.on .sn { color:var(--fg); }
`;

// ── per-scene caption plate (transparent, composited over the footage) ───────
function platePage(film, sc, frac) {
  return `<!doctype html><meta charset="utf-8">${BASE}
  <style>
    body { background:transparent; }
    ${RAIL_CSS}
    .col { position:absolute; left:76px; right:76px; top:196px; }
    .eyebrow { font-size:22px; font-weight:700; letter-spacing:.2em; text-transform:uppercase;
               color:var(--accent); margin-bottom:20px; }
    h1 { font-size:64px; margin-bottom:18px; }
    .sub { font-size:29px; line-height:1.34; }
    .mark { position:absolute; left:0; right:0; bottom:96px; text-align:center;
            font-size:23px; font-weight:700; letter-spacing:.3em; text-transform:uppercase;
            color:var(--fg-faint); }
  </style>
  <div class="stage">
    ${railHtml(film.n, frac)}
    <div class="col">
      <div class="eyebrow">${esc(film.title)}</div>
      <h1>${esc(sc.head)}</h1>
      <div class="sub">${esc(sc.sub)}</div>
    </div>
    <div class="mark">CVApplyr</div>
  </div>`;
}

// ── full-frame ground (the bed every screen scene is composited onto) ────────
function groundPage() {
  return `<!doctype html><meta charset="utf-8">${BASE}
  <div class="stage ground"><div class="grain"></div></div>`;
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/(\w)'(\w)/g, '$1’$2')
  .replace(/'(\w)/g, '’$1')
  .replace(/"([^"]*)"/g, '“$1”');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });

  async function shot(html, file, transparent) {
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(OUT, file), omitBackground: !!transparent });
    process.stdout.write(`  ${file}\n`);
  }

  await shot(groundPage(), 'ground.png', false);

  for (const film of cfg.films) {
    const screens = film.scenes.filter((s) => s.kind === 'screen');
    for (const sc of film.scenes) {
      if (sc.kind !== 'screen') continue;
      // How far through this film the scene sits, by position in the demo - not by wall clock,
      // which would need the narration to exist before a plate could be drawn.
      const frac = screens.indexOf(sc) === screens.length - 1
        ? 1 : (screens.indexOf(sc) + 1) / (screens.length + 1);
      await shot(platePage(film, sc, frac), `plate-${sc.id}.png`, true);
    }
  }

  await browser.close();
  console.log(`\nRendered into ${path.relative(HERE, OUT)}/ at ${W}x${H}`);
  console.log(`Phone box: ${PH_W}x${PH_H} at ${PH_X},${PH_Y}`);
})();
