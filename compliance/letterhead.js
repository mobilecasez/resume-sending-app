/**
 * The company letterhead, shared by every compliance letter in this folder.
 *
 * It lives in one place because these documents arrive in batches — a payments-profile verification
 * asks for a management list, a shareholding pattern, a board resolution — and they must all carry
 * an identical masthead. Two letters from the same company with different CIN formatting or a
 * differently-worded footer is exactly the inconsistency that gets a submission queried.
 *
 * Nothing here invents a value. A field missing from details.json prints as a discreet rule to
 * complete by hand, never as a plausible guess: a wrong CIN on a verification letter fails the whole
 * profile, where a visible gap merely gets filled in.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A typed value, or a rule of roughly the right width to write it on. */
const fill = (v, width = 200) =>
  v ? `<b>${esc(v)}</b>` : `<span class="blank" style="min-width:${width}px"></span>`;

/** One masthead identifier. Omitted entirely when unknown, so the line never reads as a gap. */
const idPair = (k, v) => (v ? `<span class="idp"><span class="k">${esc(k)}</span> ${esc(v)}</span>` : '');

/** Indian digit grouping (1,00,000 — not 100,000). Pass-through for anything already formatted. */
function inr(n) {
  if (n == null || n === '') return '';
  const s = String(n).replace(/[^0-9.]/g, '');
  if (!s) return String(n);
  const [i, d] = s.split('.');
  const last3 = i.slice(-3);
  const rest = i.slice(0, -3);
  const grouped = rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3 : last3;
  return grouped + (d ? '.' + d : '');
}

const CSS = `
  @page { size: A4; margin: 12mm 17mm 10mm 17mm; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:Georgia,"Times New Roman",Times,serif; color:#111; font-size:10.9pt;
         line-height:1.52; -webkit-print-color-adjust:exact; print-color-adjust:exact; }

  .head { display:flex; align-items:center; gap:15px; }
  .head img { width:56px; height:56px; border-radius:13px; }
  .co { font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;
        font-size:21pt; font-weight:700; letter-spacing:-0.025em; line-height:1.1; }
  .tag { font-family:"Helvetica Neue",Helvetica,Arial,sans-serif; font-size:8.2pt; color:#555;
         letter-spacing:.20em; text-transform:uppercase; margin-top:4px; }
  .rule  { height:2.6px; background:#111; margin:9px 0 0; }
  .rule2 { height:0.8px; background:#111; margin:1.6px 0 7px; }

  .ids { font-family:"Helvetica Neue",Helvetica,Arial,sans-serif; font-size:8.3pt; color:#333;
         line-height:1.75; }
  .idp { white-space:nowrap; }
  .idp + .idp::before { content:"·"; color:#AAA; margin:0 8px; }
  .ids .k { color:#777; }
  .ids .addr { display:block; margin-top:1px; }
  .headrule { height:0.8px; background:#BBB; margin:8px 0 13px; }

  .datebar { display:flex; justify-content:space-between; align-items:baseline;
             font-size:10.2pt; margin-bottom:10px; }
  .to { margin-bottom:11px; line-height:1.45; }
  .to .l { font-weight:bold; }

  h1 { font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;
       font-size:11.4pt; font-weight:700; text-align:center; letter-spacing:.04em;
       text-decoration:underline; text-underline-offset:4px; margin:12px 0 10px; }

  p { margin-bottom:8px; text-align:justify; }

  table { width:100%; border-collapse:collapse; margin:10px 0 12px; }
  th, td { border:0.9px solid #444; padding:7px 9px; font-size:10.2pt; vertical-align:middle; }
  th { background:#F0F0F0; font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;
       font-weight:700; text-align:left; font-size:8.6pt; letter-spacing:.06em; text-transform:uppercase; }
  td.num  { width:30px; text-align:center; color:#666; }
  td.nm   { font-weight:bold; }
  td.mono { font-family:"SF Mono",Menlo,Consolas,monospace; font-size:9.4pt; letter-spacing:.01em; }
  .r { text-align:right; }
  .c { text-align:center; }
  tr.total td { background:#F7F7F7; font-weight:bold; }

  .blank { display:inline-block; border-bottom:0.9px solid #555; height:1em; vertical-align:baseline; }

  /* The seal is OPEN SPACE with a caption beneath, never a drawn box — a rubber stamp lands where
     it lands, and a printed rectangle it fails to line up with makes the page look wrong. */
  .sign { margin-top:10px; page-break-inside:avoid; display:flex; justify-content:space-between;
          align-items:flex-start; gap:30px; }
  .signL { flex:1; }
  .forco { font-weight:bold; font-size:11.1pt; margin-bottom:40px; }   /* the gap IS the signature space */
  .sigline { width:262px; border-top:0.9px solid #111; padding-top:5px;
             font-family:"Helvetica Neue",Helvetica,Arial,sans-serif; font-size:8.6pt; color:#555;
             letter-spacing:.04em; text-transform:uppercase; }
  .sigfield { margin-top:5px; font-size:10.4pt; }
  .sigfield .k { display:inline-block; width:104px; color:#555; }
  .sealwrap { flex:none; width:150px; text-align:center; padding-top:6px; }
  .sealspace { height:104px; }
  .sealcap { font-family:"Helvetica Neue",Helvetica,Arial,sans-serif; font-size:8pt; color:#999;
             letter-spacing:.10em; text-transform:uppercase; border-top:0.8px solid #DDD; padding-top:6px; }

  .foot { margin-top:9px; padding-top:6px; border-top:0.8px solid #DDD;
          font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;
          font-size:7.4pt; color:#999; text-align:center; letter-spacing:.02em; }
`;

function loadDetails(argv) {
  const i = argv.indexOf('--details');
  const p = i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  return p && fs.existsSync(path.resolve(HERE, p))
    ? JSON.parse(fs.readFileSync(path.resolve(HERE, p), 'utf8')) : {};
}

function icon() {
  const p = path.resolve(HERE, '../MobileApp/assets/images/icon.png');
  return fs.existsSync(p) ? 'data:image/png;base64,' + fs.readFileSync(p).toString('base64') : '';
}

/** Masthead + identifiers + date + addressee — everything above the letter's own title.
 *  `addressee:false` drops the "To," block: a certified extract from the minutes book is a record of
 *  the Company's own act, not a letter written to someone, and addressing it makes it read as the
 *  wrong kind of document. */
function masthead(D, company, { addressee = true } = {}) {
  const ic = icon();
  return `
<div class="head">
  ${ic ? `<img src="${ic}">` : ''}
  <div>
    <div class="co">${esc(company)}</div>
    <div class="tag">${esc(D.tagline || 'Creators of CVApplyr')}</div>
  </div>
</div>
<div class="rule"></div>
<div class="rule2"></div>

<div class="ids">
  <div>${idPair('CIN', D.cin)}${idPair('PAN', D.pan)}${idPair('TAN', D.tan)}${idPair('GSTIN', D.gstin)}</div>
  <div>${idPair('Email', D.email || 'support@cvapplyr.com')}${idPair('Web', D.website || 'www.cvapplyr.com')}${idPair('Incorporated', D.incorporated)}</div>
  <span class="addr"><span class="k">Registered Office:</span> ${D.address ? esc(D.address) : '<span class="blank" style="min-width:330px"></span>'}</span>
</div>
<div class="headrule"></div>

<div class="datebar">
  <div>${D.ref ? `<b>Ref:</b> ${esc(D.ref)}` : ''}</div>
  <div><b>Date:</b> ${fill(D.date, 140)}</div>
</div>

${addressee ? `<div class="to">
  <div class="l">To,</div>
  <div>${esc(D.addressee || 'The Authorised Officer')}</div>
  <div>${esc(D.addresseeOrg || 'BillDesk / Google Play — Payments Profile Verification')}</div>
</div>` : ''}`;
}

/** Closing declaration, signature space, and the seal area. */
function signature(D, company, { declaration = true } = {}) {
  return `
${declaration ? `<p>We hereby confirm that the particulars stated above are true, complete and correct to the best of our knowledge and belief; that the undersigned is duly authorised to issue this certificate on behalf of the Company; and that it is issued at the request of the addressee solely for verification of the Company&rsquo;s payments profile.</p>` : ''}

<div class="sign">
  <div class="signL">
    <div class="forco">For ${esc(company)}</div>
    <div class="sigline">Authorised Signatory</div>
    <div class="sigfield"><span class="k">Name</span>${fill(D.signatoryName, 200)}</div>
    <div class="sigfield"><span class="k">Designation</span>${fill(D.signatoryDesignation, 200)}</div>
    ${D.signatoryDin ? `<div class="sigfield"><span class="k">DIN</span>${fill(D.signatoryDin, 200)}</div>` : ''}
    ${D.signatoryPan ? `<div class="sigfield"><span class="k">PAN</span>${fill(D.signatoryPan, 200)}</div>` : ''}
    <div class="sigfield"><span class="k">Place</span>${fill(D.place, 200)}</div>
  </div>
  <div class="sealwrap">
    <div class="sealspace"></div>
    <div class="sealcap">Company Seal</div>
  </div>
</div>

<div class="foot">${esc(company)}${D.cin ? ` &nbsp;·&nbsp; CIN ${esc(D.cin)}` : ''} &nbsp;·&nbsp; Valid only when signed by the Authorised Signatory and bearing the Company seal.</div>`;
}

/** Render to A4 and report page count — these letters must never run to two pages, because a
 *  second page carrying only a signature reads as a broken document. */
async function render(body, outFile, warnings = []) {
  const html = `<!doctype html><meta charset="utf-8"><style>${CSS}</style>${body}`;
  const out = path.join(HERE, outFile);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.pdf({ path: out, format: 'A4', printBackground: true });

  // Measure the same layout at the A4 printable size. When one of these letters runs to two pages
  // the useful question is "by how much", not "which paragraph felt long" — this reports the
  // overflow in pixels and names the tallest blocks, so the trim is a decision rather than a guess.
  const [mmW, mmH] = [210 - 17 * 2, 297 - 12 - 10];           // page minus @page margins
  const px = (mm) => Math.round(mm * 96 / 25.4);
  await page.setViewportSize({ width: px(mmW), height: px(mmH) });
  const m = await page.evaluate(() => ({
    total: document.body.scrollHeight,
    parts: [...document.body.children]
      .map((e) => ({ t: String(e.className || e.tagName).split(' ')[0].slice(0, 12),
                     h: Math.round(e.getBoundingClientRect().height) }))
      .filter((x) => x.h > 12).sort((a, b) => b.h - a.h).slice(0, 6),
  }));
  await browser.close();

  const buf = fs.readFileSync(out);
  const pages = (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  console.log(`  ${outFile}  ${(buf.length / 1024).toFixed(0)} KB  A4  ${pages} page${pages === 1 ? '' : 's'}`);
  if (pages !== 1) {
    console.log(`  ⚠️  content ${m.total}px vs ${px(mmH)}px printable — over by ${m.total - px(mmH)}px`);
    console.log(`      tallest: ${m.parts.map((p) => `${p.t}=${p.h}`).join('  ')}`);
  }
  warnings.forEach((w) => console.log(`  ⚠️  ${w}`));
  return { pages, height: m.total, printable: px(mmH) };
}

module.exports = { esc, fill, idPair, inr, CSS, loadDetails, masthead, signature, render, HERE };
