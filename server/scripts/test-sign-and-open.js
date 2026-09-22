// Two production reports from 2026-09-22, one suite.
//   node server/scripts/test-sign-and-open.js
//
// 1. "On the cover letter it didn't show the signature." The HTML letter designs never drew it — only the old PDFKit
//    Original did — and the A4 / One-page change moved the Original's A4 PDF onto its HTML twin too, while letter
//    downloads default to A4. So the owner's Nordex letter (doc 19, German design) went out unsigned.
// 2. "If I open the resume that was loading … it didn't show any loader." The pagers' spinners covered "the server is
//    rendering", not the seconds between a page ARRIVING and being DRAWN (a 3x page is ~2000x4400 px; the Azure Sidebar
//    took 5.8 s to render in production), so the card sat empty and white.
// Behaviour is checked by rendering the real templates; wiring is checked on COMMENT-STRIPPED source (matching our own
// explanation would prove nothing).
'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');
const R = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x).slice(0, 300) : '')); } };

const t = require(path.join(ROOT, 'server', 'utils', 'coverLetterTemplates.js'));
// A tiny real PNG (1x1), so the data-URI shape is exactly what the loader produces.
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const DATA = { sender: { name: 'Rishi Samadhiya', title: 'Project Manager' }, company: { name: 'Nordex SE', address: 'Hamburg' }, bodyHtml: '<p>One.</p><p>Two.</p>' };
const IMG = 'class="cl-sig"';

console.log('── 1. Every design signs the letter ──');
for (const id of t.TEMPLATE_IDS) {
    for (const mode of ['onepage', 'a4']) {
        const h = t.renderCoverLetterHtml(id, DATA, { mode, signature: SIG });
        ok(`${id} (${mode}) draws the signature`, h.includes(IMG) && h.includes(SIG));
        // Between the closing word and the typed name — a signature under the name reads as someone else's.
        const close = h.slice(h.indexOf('class="closing"'));
        ok(`${id} (${mode}) signs BETWEEN the closing word and the name`,
            close.indexOf('cl-word') < close.indexOf(IMG) && close.indexOf(IMG) < close.indexOf('cl-name'));
    }
    const plain = t.renderCoverLetterHtml(id, DATA, { mode: 'onepage' });
    ok(`${id} without a signature renders no image at all`, !plain.includes(IMG));
}

console.log('── 2. Only an image ever reaches the page ──');
for (const bad of ['javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', '" onerror="alert(1)', 'data:image/png;base64,AAA" onload="x', 'http://evil/x.png', 42, {}, null]) {
    const h = t.renderCoverLetterHtml('german', DATA, { mode: 'onepage', signature: bad });
    ok(`dropped: ${JSON.stringify(bad)}`, !h.includes(IMG));
}

console.log('── 3. Every letter render is handed the signature ──');
const CLC = strip(R('server/controllers/coverLetterController.js'));
const pdfFn = (CLC.match(/async function renderLetterPdfFile[\s\S]*?\n}\n/) || [''])[0];
ok('⚠️ the PDF (download + email attachment) signs every design, not just the branded one',
    /const signature = await loadCLSignatureDataUri\(userId\);\s*if \(signature\) opts\.signature = signature;\s*const pdf = await clRenderer\.renderPdf/.test(pdfFn));
ok('the free preview signs every region', /const signature = await loadCLSignatureDataUri\(userId\);\s*if \(signature\) renderOpts\.signature = signature;/.test(CLC));
ok('the loader is exported for the Home letter cards', /loadCLSignatureDataUri,/.test(CLC));
ok('the loader keeps transparency (PNG) and survives an untrimmable image',
    /\.png\(\{ compressionLevel: 9 \}\)/.test(CLC) && /try \{ out = await shrink\(sharp\(p\)\.rotate\(\)\.trim/.test(CLC) && /catch \{ out = await shrink\(sharp\(p\)\.rotate\(\)\); \}/.test(CLC));

const ELC = strip(R('server/controllers/employerLetterController.js'));
ok('Home letter cards render with the signature', /renderPreviews\(data, \{ photo, signature, brandColor: accent, brandFont \}, missing\)/.test(ELC));
ok('⚠️ a signed user\'s cards are keyed on the signature (no unsigned card is served again)',
    /\.\.\.\(sigVer \? \[sigVer\] : \[\]\)\]\.join\('\|'\)/.test(ELC));
ok('…and an unsigned user\'s keys are untouched (null adds nothing to the key)',
    /async function signatureVersionOf[\s\S]*?if \(!u \|\| !u\.signature_path\) return null;[\s\S]*?catch \{ return null; \}/.test(ELC));

console.log('── 4. A page is never blank while it opens ──');
const PAGERS = [
    ['résumé pager', 'MobileApp/app/(resume-builder)/templates.tsx', 'tid', 'p.image'],
    ['Home letter pager', 'MobileApp/app/(cover-letter)/templates.tsx', 'slot.id', 'img.image'],
    ['classic letter pager', 'MobileApp/app/(cover-letter)/templates.tsx', 'p.id', 'p.image'],
];
for (const [name, file, idExpr, imgExpr] of PAGERS) {
    const src = strip(R(file));
    const id = idExpr.replace('.', '\\.'); const img = imgExpr.replace('.', '\\.');
    ok(`${name}: "Opening…" shows until THIS page's image has drawn`,
        new RegExp(`\\{drawn\\[${id}\\] !== ${img} && \\(\\s*<View style=\\{s\\.pageOpening\\} pointerEvents="none">\\s*<ActivityIndicator`).test(src));
    ok(`${name}: drawing the image clears it`, new RegExp(`setDrawn\\(\\(d\\) => \\(d\\[${id}\\] === ${img} \\? d : \\{ \\.\\.\\.d, \\[${id}\\]: ${img} \\}\\)\\)`).test(src));
    ok(`${name}: a broken image clears it too (never an eternal spinner)`, new RegExp(`onError=\\{\\(\\) => setDrawn\\(\\(d\\) => \\(\\{ \\.\\.\\.d, \\[${id}\\]: ${img} \\}\\)\\)\\}`).test(src));
}
for (const file of ['MobileApp/app/(resume-builder)/templates.tsx', 'MobileApp/app/(cover-letter)/templates.tsx']) {
    ok(`${path.basename(path.dirname(file))}: the overlay covers the page and never eats a touch`,
        /pageOpening:\s*\{ \.\.\.StyleSheet\.absoluteFillObject,[^}]*backgroundColor: '#fff' \}/.test(R(file)));
}

console.log(`\nsign and open: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
