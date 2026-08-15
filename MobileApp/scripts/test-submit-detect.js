// Runs the REAL SUBMIT_DETECT_JS (extracted verbatim from app/(ai-hub)/submitDetect.ts) against
// page shapes that have actually broken it, and asserts both directions:
//   * a genuine submission IS detected  (else the job never gets marked Applied)
//   * anything short of one is NOT      (a false "Applied" is worse than a missed one)
//
// The shape that motivated this file is nexplore.ch, which renders the whole application form
// TWICE. The surviving copy kept formStillHere() true forever, so the language-agnostic path could
// never fire, and the German phrase list only carried the FORMAL "Ihre Bewerbung" while the site
// speaks du-form. Both routes were blocked at once and the applicant saw nothing recorded.
//
//   node MobileApp/scripts/test-submit-detect.js
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { webkit } = require('playwright');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app', '(ai-hub)', 'submitDetect.ts'), 'utf8');
const SUBMIT_DETECT_JS = JSON.parse(SRC.match(/= ("[\s\S]*?");\n/)[1]);

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra) : '')); }
};

const FORM = `<form><input name="firstname"><input name="lastname"><input name="email" type="email">
  <input name="phone" type="tel"><input type="file" name="attachment"><textarea name="comments"></textarea>
  <button type="submit">Bewerbung absenden</button></form>`;
const FILLER = (s) => `<p>${(s + ' ').repeat(60)}</p>`;

// Faithful to nexplore: two complete copies of the form, each in its own wrapper, separated by a
// wall of marketing text so the page can never be "short".
const TWICE = `<!doctype html><html lang="de"><body><h1>Senior Full Stack Software Engineer</h1>
  ${FILLER('Wir suchen dich für spannende Projekte.')}
  <h2>Bewerbungsformular</h2><div class="wrap">${FORM}</div>
  ${FILLER('Fragen? Wir sind gerne für dich da.')}
  <h2>Bewerbungsformular</h2><div class="wrap">${FORM}</div></body></html>`;

// Serve over a real origin: sessionStorage throws on setContent's opaque origin, which silently
// disables recentSubmit() and made an earlier version of this test pass for the wrong reason.
let server, base;
const startServer = () => new Promise((res) => {
  server = http.createServer((req, r) => { r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); r.end(TWICE); });
  server.listen(0, '127.0.0.1', () => { base = 'http://127.0.0.1:' + server.address().port + '/'; res(); });
});

// submit the first form, then mutate the page the way the site would, then read the verdict
async function scenario(browser, { submit = true, replaceForm = true, text = '', keepForm = false }) {
  const p = await browser.newPage();
  await p.goto(base, { waitUntil: 'domcontentloaded' });
  await p.evaluate(`window.__msgs=[];window.ReactNativeWebView={postMessage:s=>window.__msgs.push(JSON.parse(s))};`);
  await p.evaluate(SUBMIT_DETECT_JS);
  if (submit) {
    await p.evaluate(`(() => { const f=document.querySelectorAll('form')[0];
      f.addEventListener('submit', e => e.preventDefault()); f.requestSubmit(); })()`);
    await p.waitForTimeout(250);
  }
  await p.evaluate(`(() => {
    const f = document.querySelectorAll('form')[0];
    const d = document.createElement('div'); d.textContent = ${JSON.stringify(text)};
    if (${replaceForm} && !${keepForm}) f.parentNode.replaceChild(d, f);
    else f.parentNode.insertBefore(d, f);
  })()`);
  await p.waitForTimeout(2600);
  const r = await p.evaluate(`({ success: window.__msgs.some(m=>m.type==='SUBMIT_SUCCESS'),
                                 intent: window.__msgs.some(m=>m.type==='SUBMIT_INTENT') })`);
  await p.close();
  return r;
}

(async () => {
  await startServer();
  const browser = await webkit.launch();
  console.log('\n── the page renders the application form TWICE (nexplore.ch) ──');

  // ── MUST fire ───────────────────────────────────────────────────────────────────────────────
  for (const [label, text] of [
    ['German du-form  "Vielen Dank für deine Bewerbung"', 'Vielen Dank für deine Bewerbung! Wir melden uns bald bei dir.'],
    ['German du-form  "Wir haben deine Bewerbung erhalten"', 'Wir haben deine Bewerbung erhalten.'],
    ['German du-form  "Deine Bewerbung wurde erfolgreich übermittelt"', 'Deine Bewerbung wurde erfolgreich übermittelt.'],
    ['German formal   "Vielen Dank für Ihre Bewerbung" (regression)', 'Vielen Dank für Ihre Bewerbung!'],
    ['English         (regression)', 'Thank you for applying! Your application has been received.'],
    ['a language we do not train on at all — structural path', 'Grazas pola túa candidatura. Recibímola correctamente.'],
  ]) {
    const r = await scenario(browser, { text });
    ok('detects: ' + label, r.success && r.intent, r);
  }

  // ── MUST NOT fire ───────────────────────────────────────────────────────────────────────────
  console.log('\n── a false "Applied" is worse than a missed one ──');
  {
    const r = await scenario(browser, { submit: false, replaceForm: false, text: 'Vielen Dank für dein Interesse an dieser Stelle.' });
    ok('no submit at all → silent', !r.success && !r.intent, r);
  }
  {
    const r = await scenario(browser, { keepForm: true, replaceForm: false,
      text: 'Fehler: Bitte fülle alle Pflichtfelder aus. Die Bewerbung konnte nicht gesendet werden.' });
    ok('submit + validation error, form still there → silent', !r.success, r);
  }
  {
    const r = await scenario(browser, { keepForm: true, replaceForm: false,
      text: 'Bitte überprüfe deine Bewerbung, bevor du sie abschickst.' });
    ok('submit + review-before-you-send step → silent', !r.success, r);
  }
  {
    // The form vanished, but nothing on the page says an application was received.
    const r = await scenario(browser, { text: 'Unsere Standorte in der Schweiz und weitere Informationen zum Unternehmen.' });
    ok('form gone but no confirmation wording → silent', !r.success, r);
  }

  await browser.close();
  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); try { server.close(); } catch (_) {} process.exit(1); });
