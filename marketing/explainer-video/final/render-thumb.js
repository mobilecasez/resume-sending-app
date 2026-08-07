/**
 * The YouTube thumbnail. 1280x720, which is what YouTube wants and what it downscales from.
 *
 * Designed to survive being 210px wide in a search result, which is where it is actually judged:
 * two words of real size, one accent, and a single readable proof image. The screen detail is
 * cropped BELOW the browser chrome on purpose - the recording is of a real employer's careers site,
 * and their name does not belong on the face of an ad.
 *
 *   node render-thumb.js
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const OUT = path.join(HERE, 'thumb');
const W = 1280, H = 720;

const dataUri = (p) => 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');

(async () => {
  const shot = dataUri(path.join(OUT, 'screen.png'));
  const icon = dataUri(path.resolve(HERE, '../../../MobileApp/assets/images/icon.png'));

  const html = `<!doctype html><meta charset="utf-8"><style>
    :root{--ink:#080D18;--g1:#16223A;--g2:#0B1220;--fg:#F3F6FB;--dim:#93A4C4;--accent:#F4A259;
      --sans:-apple-system,BlinkMacSystemFont,"SF Pro Display","Helvetica Neue",sans-serif}
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:${W}px;height:${H}px;overflow:hidden}
    body{font-family:var(--sans);-webkit-font-smoothing:antialiased}
    .stage{position:relative;width:${W}px;height:${H}px;
      background:radial-gradient(110% 95% at 74% 44%,var(--g1) 0%,var(--g2) 52%,var(--ink) 100%)}
    .copy{position:absolute;left:74px;top:50%;transform:translateY(-50%);width:640px}
    .brandrow{display:flex;align-items:center;gap:16px;margin-bottom:30px}
    .brandrow img{width:60px;height:60px;border-radius:15px}
    .brandrow b{font-size:31px;font-weight:680;color:var(--fg);letter-spacing:-.02em}
    h1{font-size:118px;line-height:.90;font-weight:760;letter-spacing:-.045em;color:var(--fg)}
    h1 .a{color:var(--accent);display:block}
    .rule{width:150px;height:7px;background:var(--accent);border-radius:4px;margin:34px 0 26px}
    .sub{font-size:36px;font-weight:560;color:var(--dim);letter-spacing:-.015em;line-height:1.22}
    /* The proof: a slab of the real filled form, tilted just enough to read as a screen. */
    .shotwrap{position:absolute;right:-26px;top:50%;width:520px;height:600px;
      transform:translateY(-50%) rotate(-6deg);border-radius:30px;overflow:hidden;
      border:3px solid rgba(150,168,205,.28);box-shadow:0 50px 110px rgba(0,0,0,.72)}
    .shotwrap img{width:100%;display:block}
    .badge{position:absolute;right:250px;top:96px;display:flex;align-items:center;gap:14px;
      background:var(--accent);color:#121A2B;padding:17px 30px 17px 22px;border-radius:999px;
      font-size:31px;font-weight:760;letter-spacing:-.01em;
      box-shadow:0 22px 46px rgba(0,0,0,.6);transform:rotate(-6deg)}
    .badge .tick{width:38px;height:38px;border-radius:50%;background:#121A2B;color:var(--accent);
      display:flex;align-items:center;justify-content:center;font-size:23px;font-weight:800}
  </style>
  <div class="stage">
    <div class="shotwrap"><img src="${shot}"></div>
    <div class="copy">
      <div class="brandrow"><img src="${icon}"><b>CVApplyr</b></div>
      <h1>STOP<span class="a">RETYPING</span></h1>
      <div class="rule"></div>
      <div class="sub">AI fills the employer’s<br>job form for you</div>
    </div>
    <div class="badge"><span class="tick">✓</span>AUTO-FILLED</div>
  </div>`;

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(OUT, 'thumbnail-1280x720.png') });
  await browser.close();

  const kb = (fs.statSync(path.join(OUT, 'thumbnail-1280x720.png')).size / 1024).toFixed(0);
  console.log(`  thumb/thumbnail-1280x720.png  ${kb} KB (YouTube limit 2048 KB)`);
})();
