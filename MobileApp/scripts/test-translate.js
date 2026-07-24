// Runs the REAL translate scripts from utils/webviewTranslate.ts against a LIVE page and asserts the
// full toggle cycle — including translating a SECOND time after turning it off, which is the bug the
// old implementation had (its collector returned an empty list and the app silently did nothing).
//   node MobileApp/scripts/test-translate.js [url]
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const URL_UNDER_TEST = process.argv[2]
  || 'https://www.arbeitsagentur.de/jobsuche/jobdetail/17311-44302666-79-S';

const TS = fs.readFileSync(path.join(__dirname, '..', 'utils', 'webviewTranslate.ts'), 'utf8');
function body(name) {
  const i = TS.indexOf('export const ' + name);
  if (i < 0) throw new Error('missing ' + name);
  const s = TS.indexOf('`', i);
  let j = s + 1;
  while (j < TS.length) { if (TS[j] === '\\') { j += 2; continue; } if (TS[j] === '`') break; j++; }
  return TS.slice(s + 1, j);
}
const MARK = '__cvfX';
const fill = (b, gen, map) => b
  .split('${XLATE_MARK}').join(MARK)
  .split('${gen}').join(String(gen))
  .split('${JSON.stringify(map)}').join(JSON.stringify(map || {}));

const SCAN = (gen) => fill(body('xlateScanJS'), gen);
const APPLY = (gen, map, final = true) => fill(body('xlateApplyJS'), gen, map).split('${FIN}').join(final ? '1' : '0');
const RESTORE = fill(body('XLATE_RESTORE_JS'), 0);
const WATCH = fill(body('XLATE_WATCH_JS'), 0);

// runXlatePasses is real TypeScript, so compile the module once and require the output — testing a
// hand-written JS copy of the batching logic would prove nothing about what actually ships.
function loadModule() {
  const ts = require('typescript');
  const src = TS.replace(/\bexport\s+type\s+[\s\S]*?;\n/g, '');
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText;
  const out = path.join(require('os').tmpdir(), 'cvf-webviewTranslate-' + process.pid + '.js');
  fs.writeFileSync(out, js);
  const mod = require(out);
  try { fs.unlinkSync(out); } catch (_) {}
  return mod;
}

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); } };

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1' });
  console.log('page: ' + URL_UNDER_TEST);
  await page.goto(URL_UNDER_TEST, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2500);

  const bridge = () => page.evaluate(() => { window.__msgs = []; window.ReactNativeWebView = { postMessage: (s) => window.__msgs.push(JSON.parse(s)) }; });
  const msgs = () => page.evaluate(() => window.__msgs);
  const run = (js) => page.evaluate((code) => { eval(code); }, js);

  // ── pass 1: scan ──────────────────────────────────────────────────────────
  console.log('\nfirst translate');
  await bridge();
  await run(SCAN(1));
  const m1 = (await msgs()).find((m) => m.type === 'XLATE_ITEMS');
  ok('scan returns items', !!m1 && m1.n > 50, m1 && m1.n);
  const textCount = m1 ? m1.items.length : 0;
  console.log('    captured ' + textCount + ' strings');

  // fake the backend translation so the test needs no AI + no credits
  const map1 = {}; (m1 ? m1.items : []).forEach((it) => { map1[it.i] = 'EN[' + it.t.slice(0, 20) + ']'; });
  await run(APPLY(1, map1));
  const applied = (await msgs()).find((m) => m.type === 'XLATE_APPLIED');
  ok('apply reports a count', !!applied && applied.count > 50, applied && applied.count);

  const st1 = await page.evaluate(() => ({
    bodyHasEN: (document.body.innerText || '').indexOf('EN[') >= 0,
    attrDone: !!document.querySelector('[aria-label^="EN["]'),
    marked: document.documentElement.getAttribute('data-cvf-xlated') === '1',
  }));
  ok('visible text is translated', st1.bodyHasEN, st1);
  ok('ATTRIBUTES translated too (aria-label/title/alt)', st1.attrDone, st1);
  ok('page marked as translated', st1.marked, st1);

  // ── toggle OFF: restore in place, no reload ───────────────────────────────
  console.log('\nturn translate off');
  const beforeUrl = page.url();
  await run(RESTORE);
  const st2 = await page.evaluate(() => ({
    bodyHasEN: (document.body.innerText || '').indexOf('EN[') >= 0,
    attrStill: !!document.querySelector('[aria-label^="EN["]'),
    marked: document.documentElement.hasAttribute('data-cvf-xlated'),
  }));
  ok('original text restored', !st2.bodyHasEN, st2);
  ok('original attributes restored', !st2.attrStill, st2);
  ok('translated flag cleared', !st2.marked, st2);
  ok('restored WITHOUT reloading the page', page.url() === beforeUrl);

  // ── toggle ON again — the reported bug ────────────────────────────────────
  console.log('\ntranslate AGAIN (the reported bug)');
  await bridge();
  await run(SCAN(2));
  const m2 = (await msgs()).find((m) => m.type === 'XLATE_ITEMS');
  ok('second scan returns items (was 0 before)', !!m2 && m2.n > 50, m2 && m2.n);
  // A LIVE page keeps rendering between passes, so exact equality is not a meaningful assertion —
  // what matters is that the second pass captures a comparable amount rather than collapsing to ~0
  // (the old collector returned exactly 0 here, which is the bug).
  ok('second scan captures a comparable amount (not ~0)',
     !!m2 && m2.n >= Math.floor(textCount * 0.8), { first: textCount, second: m2 && m2.n });
  const map2 = {}; (m2 ? m2.items : []).forEach((it) => { map2[it.i] = 'RE[' + it.t.slice(0, 18) + ']'; });
  await run(APPLY(2, map2));
  const st3 = await page.evaluate(() => ({ hasRE: (document.body.innerText || '').indexOf('RE[') >= 0 }));
  ok('page is translated a second time', st3.hasRE, st3);

  // ── live content watcher ──────────────────────────────────────────────────
  console.log('\nlive (SPA) content');
  await bridge();
  await run(WATCH);
  await page.evaluate(() => { const d = document.createElement('div'); d.textContent = 'Neue Stellenangebote wurden geladen'; document.body.appendChild(d); });
  await page.waitForTimeout(1400);
  const dirty = (await msgs()).some((m) => m.type === 'XLATE_DIRTY');
  ok('new content triggers a re-translate signal', dirty, await msgs());

  // ── progressive apply: a long page is written back round by round ─────────
  // The whole point is that the user sees text land instead of a spinner that either works or
  // doesn't. So a NON-final round must write its share, keep the pass open, and say it isn't done.
  console.log('\nprogressive apply (round by round)');
  await run(RESTORE);
  await bridge();
  await run(SCAN(3));
  const m3 = (await msgs()).find((m) => m.type === 'XLATE_ITEMS');
  const its = m3 ? m3.items : [];
  // Split by TEXT-node records only — the tail of a scan is mostly aria-label/title/alt, which never
  // shows up in innerText, so slicing the raw item list would test nothing about what the user sees.
  const textIdx = await page.evaluate((M) => ((window[M] && window[M].pending) || [])
    .map((r, i) => (r && r.k === 't' ? i : -1)).filter((i) => i >= 0), MARK);
  ok('scan records text nodes separately from attributes', textIdx.length > 20, textIdx.length);
  const cut = Math.floor(textIdx.length / 2);
  const byI = {}; its.forEach((it) => { byI[it.i] = it.t; });
  const r1 = {}; textIdx.slice(0, cut).forEach((i) => { r1[String(i)] = 'P1[' + String(byI[String(i)] || '').slice(0, 12) + ']'; });
  const r2 = {}; textIdx.slice(cut).forEach((i) => { r2[String(i)] = 'P2[' + String(byI[String(i)] || '').slice(0, 12) + ']'; });

  await run(APPLY(3, r1, false));
  const a1 = (await msgs()).filter((m) => m.type === 'XLATE_APPLIED').pop();
  const s1 = await page.evaluate((MARK) => ({
    hasP1: (document.body.innerText || '').indexOf('P1[') >= 0,
    hasP2: (document.body.innerText || '').indexOf('P2[') >= 0,
    pendingKept: !!(window[MARK] && window[MARK].pending),
    on: !!(window[MARK] && window[MARK].on),
  }), MARK);
  ok('round 1 writes its share immediately', s1.hasP1, s1);
  ok('round 1 does NOT report the pass finished', !!a1 && !a1.final, a1);
  ok('round 1 keeps the pass open (pending survives)', s1.pendingKept, s1);
  ok('round 1 leaves the SPA watcher asleep (st.on still false)', !s1.on, s1);

  // Read the records themselves, not innerText: a scan also captures text inside hidden subtrees,
  // which innerText legitimately omits, so only the nodes prove every record was written.
  const wrote = (which, idxs) => page.evaluate(({ W, I }) => {
    const list = window.__testPending || [];
    let hit = 0;
    I.forEach((i) => { const r = list[i]; if (r && r.n && String(r.n.nodeValue || '').indexOf(W) >= 0) hit++; });
    return { hit, of: I.length };
  }, { W: which, I: idxs });

  // Keep a handle on the record list: the final round clears st.pending, and st.targets is a
  // different (concatenated) array whose indices no longer match the scan's.
  await page.evaluate((M) => { window.__testPending = window[M].pending; }, MARK);
  await run(APPLY(3, r2, true));
  const a2 = (await msgs()).filter((m) => m.type === 'XLATE_APPLIED').pop();
  const w2 = await wrote('P2[', textIdx.slice(cut));
  const w1 = await wrote('P1[', textIdx.slice(0, cut));
  const s2 = await page.evaluate((MARK) => ({
    pendingCleared: !(window[MARK] && window[MARK].pending),
    on: !!(window[MARK] && window[MARK].on),
  }), MARK);
  ok('final round writes the rest', w2.hit === w2.of, w2);
  ok('round 1 text survives round 2', w1.hit === w1.of, w1);
  ok('final round reports the pass finished', !!a2 && !!a2.final, a2);
  ok('final round closes the pass and wakes the watcher', s2.pendingCleared && s2.on, s2);

  // Re-sending an already-written key must not translate the translation.
  const before = await page.evaluate(() => (document.body.innerText || '').indexOf('P1[P1[') >= 0);
  await run(APPLY(3, r1, true));
  const doubled = await page.evaluate(() => (document.body.innerText || '').indexOf('P1[P1[') >= 0);
  ok('a repeated key is never written twice', !before && !doubled);

  // Everything must still restore cleanly after a multi-round pass.
  await run(RESTORE);
  const s3 = await page.evaluate(() => (document.body.innerText || ''));
  ok('multi-round pass restores fully', s3.indexOf('P1[') < 0 && s3.indexOf('P2[') < 0);

  // ── a SUPERSEDED pass must give its strings back ──────────────────────────
  // The scan marks every node it collects in a `seen` WeakSet. If a pass is superseded before it
  // writes (a second pass starts, or the user navigates), those nodes used to stay marked forever —
  // so the next scan returned nothing and the page sat permanently untranslated with no error.
  // This is what auto-translate's 2.2s "settle" sweep was doing to its own 400ms pass.
  console.log('\nsuperseded pass');
  await run(RESTORE);
  await bridge();
  await run(SCAN(10));
  const sA = (await msgs()).find((m) => m.type === 'XLATE_ITEMS');
  ok('first scan collects the page', !!sA && sA.n > 50, sA && sA.n);
  await bridge();
  await run(SCAN(11));                       // supersede it WITHOUT applying anything
  const sB = (await msgs()).find((m) => m.type === 'XLATE_ITEMS');
  ok('a superseded scan releases its strings for the next pass',
     !!sB && sB.n >= Math.floor((sA ? sA.n : 0) * 0.8), { first: sA && sA.n, second: sB && sB.n });
  // …and a pass that DID write must not hand the same strings out again.
  const mapB = {}; (sB ? sB.items : []).forEach((it) => { mapB[it.i] = 'SUP[' + it.t.slice(0, 10) + ']'; });
  await run(APPLY(11, mapB, true));
  await bridge();
  await run(SCAN(12));
  const sC = (await msgs()).find((m) => m.type === 'XLATE_ITEMS');
  ok('an APPLIED pass does not re-offer what it already wrote', !!sC && sC.n < Math.max(4, (sB ? sB.n : 0) * 0.25), { applied: sB && sB.n, after: sC && sC.n });
  await run(RESTORE);

  // ── batching: dedupe + progressive rounds (the real shipped function) ─────
  console.log('\nbatching (runXlatePasses)');
  const { runXlatePasses, XLATE_CHUNK, XLATE_PARALLEL } = loadModule();

  // ── already-English detection ────────────────────────────────────────────
  // Translation is ON by default, so every page would otherwise pay a round trip just to be handed
  // its own words back. A FALSE POSITIVE here is the bad one: a foreign page that silently doesn't
  // translate. The trap case is prose in another language stuffed with English tech words.
  const { looksAlreadyEnglish } = loadModule();
  const mk = (arr) => arr.map((t, i) => ({ i: String(i), t }));
  const EN = mk(['We are looking for a full stack engineer to join our platform team in Amsterdam.', 'You will design, build and operate the services that power our customer facing products.', 'The role involves close collaboration with product managers and designers every week.', 'Experience with TypeScript, Node and Postgres is helpful but it is not required at all.', 'We offer a competitive salary, flexible hours and the option to work from home.']);
  const DE = mk(['Wir suchen eine erfahrene Entwicklerin für unser Plattform-Team in Berlin.', 'Sie entwerfen und betreiben die Dienste, die unsere Produkte für Kunden antreiben.', 'Die Rolle umfasst eine enge Zusammenarbeit mit Produktmanagern und Designern.', 'Erfahrung mit TypeScript und Postgres ist hilfreich, aber nicht zwingend erforderlich.', 'Wir bieten ein gutes Gehalt und die Möglichkeit, von zu Hause aus zu arbeiten.']);
  const NL = mk(['Wij zoeken een ervaren ontwikkelaar voor ons platformteam in Amsterdam.', 'Je ontwerpt en beheert de diensten die onze producten voor klanten mogelijk maken.', 'De rol omvat nauwe samenwerking met productmanagers en ontwerpers.', 'Ervaring met TypeScript en Postgres is handig maar niet strikt noodzakelijk.', 'Wij bieden een goed salaris en de mogelijkheid om vanuit huis te werken.']);
  const FR = mk(['Nous recherchons un ingénieur expérimenté pour rejoindre notre équipe plateforme.', 'Vous concevrez et exploiterez les services qui alimentent nos produits clients.', 'Le poste implique une collaboration étroite avec les chefs de produit et les designers.', 'Une expérience avec TypeScript et Postgres est utile mais pas obligatoire.', 'Nous offrons un bon salaire et la possibilité de travailler depuis chez vous.']);
  const NLMIX = mk(['Wij zoeken een senior full stack developer met ervaring in React en Node.js.', 'Je werkt met TypeScript, Docker, Kubernetes en AWS in een agile scrum team.', 'De rol omvat code reviews, pair programming en continuous deployment naar productie.', 'Ervaring met microservices, REST APIs en GraphQL is een sterke pre voor deze functie.', 'Wij bieden remote work, een laptop naar keuze en een goed salaris.']);
  ok('English prose → skip the round trip', looksAlreadyEnglish(EN) === true);
  ok('German prose → translate', looksAlreadyEnglish(DE) === false);
  ok('Dutch prose → translate', looksAlreadyEnglish(NL) === false);
  ok('French prose → translate', looksAlreadyEnglish(FR) === false);
  ok('Dutch stuffed with English tech words → still translate', looksAlreadyEnglish(NLMIX) === false);
  ok('too little prose to judge → translate, never guess', looksAlreadyEnglish(mk(['Apply now', 'Save', 'Home'])) === false);
  ok('empty scan → translate', looksAlreadyEnglish([]) === false);
  ok('the live page under test is not mistaken for English', looksAlreadyEnglish(m1 ? m1.items : []) === false);


  // 300 occurrences of only 3 distinct strings — a page's repeated nav/labels.
  const rep = Array.from({ length: 300 }, (_, i) => ({ i: String(i), t: ['Bewerben', 'Speichern', 'Vollzeit'][i % 3] }));
  let sent = 0, calls = 0;
  const rounds = [];
  const n1 = await runXlatePasses(
    rep,
    async (batch) => { calls++; sent += batch.length; const m = {}; batch.forEach((b) => { m[b.i] = 'X:' + b.t; }); return m; },
    (map, final) => rounds.push({ n: Object.keys(map).length, final }),
    () => false,
  );
  ok('dedupe: 300 occurrences cost one call', calls === 1, { calls, sent });
  ok('dedupe: only the 3 distinct strings are sent', sent === 3, { sent });
  ok('dedupe: every occurrence still gets written', n1 === 300, { n1 });
  ok('dedupe: exactly one round, marked final', rounds.length === 1 && rounds[0].final && rounds[0].n === 300, rounds);

  // A long page must arrive in several rounds, only the last marked final.
  const many = Array.from({ length: XLATE_CHUNK * XLATE_PARALLEL * 2 }, (_, i) => ({ i: String(i), t: 'unique-' + i }));
  const rounds2 = [];
  const n2 = await runXlatePasses(
    many,
    async (batch) => { const m = {}; batch.forEach((b) => { m[b.i] = 'X:' + b.t; }); return m; },
    (map, final) => rounds2.push({ n: Object.keys(map).length, final }),
    () => false,
  );
  ok('long page is written in several rounds', rounds2.length === 2, rounds2.map((r) => r.n));
  ok('only the last round is final', rounds2.filter((r) => r.final).length === 1 && rounds2[rounds2.length - 1].final, rounds2);
  ok('every string is written', n2 === many.length, { n2 });

  // One failed chunk must cost only its own strings — never the whole page.
  const rounds3 = [];
  let seq = 0;
  const n3 = await runXlatePasses(
    many,
    async (batch) => { seq++; if (seq === 1) throw new Error('boom'); const m = {}; batch.forEach((b) => { m[b.i] = 'X:' + b.t; }); return m; },
    (map, final) => rounds3.push({ n: Object.keys(map).length, final }),
    () => false,
  );
  ok('a failed chunk costs only its own strings', n3 === many.length - XLATE_CHUNK, { n3, expected: many.length - XLATE_CHUNK });
  ok('a partly translated page is still applied', rounds3.length > 0 && rounds3.some((r) => r.n > 0), rounds3);

  // Total failure must apply NOTHING, so the caller can show an honest error.
  const rounds4 = [];
  const n4 = await runXlatePasses(many, async () => { throw new Error('down'); }, (map, final) => rounds4.push({ map, final }), () => false);
  ok('total failure writes nothing (caller alerts)', n4 === 0 && rounds4.length === 0, { n4, rounds: rounds4.length });

  // Toggling off mid-pass must stop the writes.
  const rounds5 = [];
  let stale = false;
  const n5 = await runXlatePasses(
    many,
    async (batch) => { const m = {}; batch.forEach((b) => { m[b.i] = 'X:' + b.t; }); return m; },
    (map, final) => { rounds5.push(final); stale = true; },
    () => stale,
  );
  ok('toggling off mid-pass stops further rounds', rounds5.length === 1, rounds5);
  ok('a cancelled pass still reports what it wrote', n5 > 0 && n5 < many.length, { n5 });

  await browser.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
