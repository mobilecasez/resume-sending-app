// A cover letter's text: the model's answer read into a letter, the letter checked before it is stored or charged, and a
// letter already stored with the model's JSON in it repaired wherever it is read (server/utils/letterText.js and
// coverLetterController.parseLegacyLetterJson). Pure: no database, no network, no model.
//   node server/scripts/test-letter-json.js
//
// ⚠️ WHY (2026-09-19, the owner): "On Customize my cover letter it started showing some json in paragraph 5,6 please
// correct this issue and it should never occur". Home → Airbus, user 1 (user_employer_documents 15, gemini-2.5-flash,
// grounded): the answer was TWO JSON objects with the model's chatter between them. v2's parsing read ONE span from the
// first "{" to the last "}", JSON.parse failed on it, and the field extractor ran the letter to the closing quote of the
// SECOND object — the stored letter was the real four paragraphs + '"' + "}" + "Rishi, I have completed the cover letter
// …" + "Here is the JSON output:" + a ```json block + the letter again: nine cards on Customize, the same in the PDF and
// the Word file, and the unit charged (usage_ledger 125).
//   fixtures/letter-doc15-raw.txt     that answer (reconstructed; section 1 proves it reproduces the stored letter BYTE FOR
//                                     BYTE through the old reading, which is kept below as V2_SINGLE_SPAN — the "before")
//   fixtures/letter-doc15-stored.html what production stored (the editor's 22:12 save had dropped the <p style>)
// Every rule is also run against the shapes found in ALL 161 letters stored in production that day (section 7): only the
// Airbus letter (and the download that froze it) changes.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key-not-used';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key';
const dbPath = require.resolve(path.join(ROOT, 'db-config.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
  get: async () => null, query: async () => [], run: async () => ({ changes: 0 }),
  withTransaction: async (fn) => fn({ get: async () => null, run: async () => ({ rows: [] }), query: async () => ({ rows: [] }) }),
  isUniqueViolation: () => false, getDbType: () => 'postgres',
} };

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 500) : '')); } };
const quiet = (fn) => { const w = console.warn, l = console.log; console.warn = () => {}; console.log = () => {}; try { return fn(); } finally { console.warn = w; console.log = l; } };

const LT = require(path.join(ROOT, 'server/utils/letterText.js'));
const CL = quiet(() => require(path.join(ROOT, 'server/controllers/coverLetterController.js')));
const parse = CL._internals.parseLegacyLetterJson;
const format = CL.formatCoverLetterWithHTML;
const RAW = fs.readFileSync(path.join(ROOT, 'server/scripts/fixtures/letter-doc15-raw.txt'), 'utf8');
const STORED = fs.readFileSync(path.join(ROOT, 'server/scripts/fixtures/letter-doc15-stored.html'), 'utf8');
const JUNK = /```|"cover_letter"|"employer_name"|"addresses"|Here is the JSON|I have completed the cover letter|\n\}|<br>\}/;
const parasOfHtml = (h) => (String(h).match(/<\/p>/g) || []).length;
const unstyled = (h) => String(h).replace(/<p style="[^"]*">/g, '<p>');
const STORED_P = STORED.split('</p>').filter(Boolean).map((p) => p + '</p>');

// ── THE "BEFORE": ai-cover-letter-v2's reading as coverLetterController ran it until 2026-09-19, verbatim (the escape
// function is the controller's own, unchanged). Kept here only to prove the fixture IS the production failure. ──
function escapeRawControlChars(raw) {
  let out = ''; let inString = false; let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) { out += ch; escaped = false; continue; }
    if (ch === '\\' && inString) { out += ch; escaped = true; continue; }
    if (ch === '"') { inString = !inString; out += ch; continue; }
    if (inString) { if (ch === '\n') { out += '\\n'; continue; } if (ch === '\r') { out += '\\r'; continue; } if (ch === '\t') { out += '\\t'; continue; } }
    out += ch;
  }
  return out;
}
function V2_SINGLE_SPAN(text) {
  const cleaned = String(text).replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  const json = cleaned.slice(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1);
  try { return JSON.parse(json); } catch (_) {
    const raw = escapeRawControlChars(json);
    try { return JSON.parse(raw); } catch (__) {
      const str = (key) => { const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"([\\s\\S]*?)"(?:\\s*,\\s*"[a-z_]+"\\s*:|\\s*\\})`, 'i')); return m ? m[1].replace(/\\n/g, '\n').replace(/\\t/g, '\t') : ''; };
      const start = raw.indexOf('"cover_letter"');
      const quote = raw.indexOf('"', raw.indexOf(':', start) + 1);
      const close = raw.lastIndexOf('"', raw.lastIndexOf('}') - 1);
      return { to: str('to'), subject: str('subject'), cover_letter: raw.slice(quote + 1, close).replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"') };
    }
  }
}

console.log('── 1. the fixture IS the production failure ──');
{
  const before = V2_SINGLE_SPAN(RAW);
  const html = unstyled(format(before.cover_letter, {}));
  ok('⚠️ the old reading of fixtures/letter-doc15-raw.txt → EXACTLY what production stored for doc 15 (byte for byte)', html === STORED, { len: html.length, stored: STORED.length });
  ok('…nine paragraphs: the fence, the JSON keys, "Here is the JSON output:" and the chatter among them',
    parasOfHtml(html) === 9 && /```json/.test(html) && /"employer_name"/.test(html) && /<p>Here is the JSON output:<\/p>/.test(html) && /I have completed the cover letter/.test(html));
  let whole = null; try { JSON.parse(RAW.slice(RAW.indexOf('{'), RAW.lastIndexOf('}') + 1)); whole = true; } catch (_) { whole = false; }
  ok('…because the one span from the first "{" to the last "}" is not JSON (two objects, chatter between)', whole === false);
  ok('the answer holds TWO balanced objects (letterText.jsonObjectsIn, string-aware)', LT.jsonObjectsIn(RAW).length === 2, LT.jsonObjectsIn(RAW).map((o) => o.length));
}

console.log('── 2. the Airbus answer, read now ──');
{
  const a = parse(RAW);
  const ps = a.cover_letter.split('\n\n');
  ok('⚠️ FOUR paragraphs, nothing of the JSON, the fence or the chatter in them', ps.length === 4 && !JUNK.test(a.cover_letter), ps.map((p) => p.slice(0, 40)));
  ok('⚠️ …and they pass the letter check (the gate writeLegacyLetter runs before anything is charged)', LT.letterProblem(a.cover_letter) === null);
  ok('…the HTML every lane stores from it is the same four real paragraphs production stored first (P4 without the \'"\', "}" and the chatter)',
    unstyled(format(a.cover_letter, {})) === STORED_P.slice(0, 3).join('') + STORED_P[3].replace(/"<br>\}<br>[^<]*<\/p>$/, '</p>'), unstyled(format(a.cover_letter, {})).slice(-120));
  ok('the one-line fields are the object\'s own: the addressee, the subject, all nine offices',
    a.to === 'Head of Cybersecurity' && a.employer_name === 'Airbus SE' && a.position === 'Cyber Security Manager'
    && a.subject === 'Application for Cyber Security Manager — Rishi Samadhiya' && a.addresses.length === 9 && a.addresses[0].startsWith('1, Rond Point'), a);
  ok('…and the HTML is not flagged by the read-side signal either', !LT.looksContaminatedHtml(format(a.cover_letter, {})));
}

console.log('── 3. every shape a model writes around (or inside) its letter ──');
// A paragraph as long as a real one (~40 words): four of them clear the gate's lower bound (letterText.MIN_WORDS).
// ⚠️ EACH ONE DIFFERENT, as a letter's paragraphs are (review round 3, 2026-09-20). They used to differ only by their number
// — one paragraph written nine times, which the near-copy rule (letterText.isNearDuplicate) now rightly refuses. Real
// letters are nowhere near: two paragraphs of one stored letter share at most 0.32 of their words (158 letters, 2026-09-20).
const WORK = [
  'on the payments ledger: I rebuilt the settlement pipeline for card and bank payouts, cut reconciliation from two days to four hours, and wrote the runbooks the finance team still follows at every month-end close across both European entities.',
  'on search, moving product lookup from nightly batch jobs to streaming indexes, so merchants saw their price changes within seconds and a whole class of stale-catalogue support tickets simply disappeared from the queue that spring.',
  'on reliability: I led the incident review programme, set service-level objectives for eleven services, and paired with on-call engineers until paging volume fell by half within one quarter, without adding a single new hire.',
  'on people, mentoring six junior developers through their first production launches, running weekly design clinics, and helping two of them grow into leads who now own the fraud and identity services end to end.',
  'on cost: an audit of storage tiers, connection pooling and query plans trimmed the monthly database bill by thirty percent, while the busiest customer dashboards actually got faster during the same eight-week effort.',
  'on migrations, retiring a fragile monolith schema in eleven reversible steps, shadow-writing every table and comparing results daily, so not one customer noticed the switch to partitioned storage over that long winter.',
  'on security: I introduced secret rotation, least-privilege roles and audit trails for administrative queries, which passed an external penetration test and a PCI assessment on the first attempt, ahead of the regulator\'s deadline.',
  'on analytics, designing event pipelines that feed near-real-time funnels for marketing, while the same warehouse models now drive demand forecasting for inventory planners in three regions and the quarterly board pack.',
  'on mobile: a lean GraphQL gateway in front of legacy endpoints halved payload sizes for the iOS and Android apps and let designers ship offline-friendly screens for travelling sales staff in rural areas.',
  'on hiring, rewriting our interview loop around realistic pairing exercises, training twelve interviewers, and shortening time-to-offer from five weeks to under three without lowering the bar for any of the senior roles.',
];
const PARA = (n) => `Paragraph ${n} about **Node.js** and **PostgreSQL** work ${WORK[(n - 1) % WORK.length]}`;
const L4 = [1, 2, 3, 4].map(PARA).join('\n\n');
const J = (letter, extra = {}) => JSON.stringify({ to: 'Hiring Manager', employer_name: 'Acme', position: 'Dev', addresses: ['1 Road'], subject: 'S', cover_letter: letter, ...extra }, null, 2);
const rawNl = (s) => s.replace(/\\n/g, '\n');   // the model writes the paragraph breaks as REAL newlines inside the string
{
  const cases = {
    'fenced ```json (the normal answer)': '```json\n' + J(L4) + '\n```',
    'unfenced, with a "Here is the JSON output:" preamble': 'Here is the JSON output:\n\n' + J(L4),
    'the model\'s chatter AFTER the object': J(L4) + '\n\nI have completed the cover letter. Let me know if you need changes.',
    'two objects with chatter between (the Airbus shape), raw newlines': rawNl(J(L4)) + '\nRishi, I have completed the cover letter.\n\nHere is the JSON output:\n\n```json\n' + rawNl(J(L4)) + '\n```',
    'a prose letter first, THEN the fenced object': L4 + '\n\n```json\n' + J(L4) + '\n```',
    'the object first, then the letter again as prose': J(L4) + '\n\n' + L4,
    'markdown heading, "PARAGRAPH 1:" / "**Paragraph 2:**" labels and a rule INSIDE cover_letter': J('## Cover Letter\n\nPARAGRAPH 1: ' + PARA(1) + '\n\n**Paragraph 2:** ' + PARA(2) + '\n\n' + PARA(3) + '\n\n---\n\n' + PARA(4)),
    'a preamble INSIDE cover_letter': J('Sure! Here is your cover letter:\n\n' + L4),
    'the letter written twice inside the field': J(L4 + '\n\n' + L4),
    'the letter written twice, raw newlines': rawNl(J(L4 + '\n\n' + L4)),
    'the object nested one level down': JSON.stringify({ response: JSON.parse(J(L4)) }),
    'cover_letter as an array of paragraphs': J([1, 2, 3, 4].map(PARA)),
    'camelCase coverLetter': JSON.stringify({ to: 'Hiring Manager', coverLetter: L4 }),
    'the whole answer again, string-encoded inside cover_letter': J(J(L4)),
    'a JSON-only answer whose letter holds a trailing ```': J(L4 + '\n\n```'),
  };
  for (const [name, raw] of Object.entries(cases)) {
    let a = null, err = null;
    try { a = parse(raw); } catch (e) { err = e; }
    const ps = a ? a.cover_letter.split('\n\n') : [];
    ok(`${name} → the 4 paragraphs, clean, passing the gate`, !!a && ps.length === 4 && ps.every((p, i) => p === PARA(i + 1)) && LT.letterProblem(a.cover_letter) === null,
      err ? err.message : ps.map((p) => p.slice(0, 30)));
  }
  // v2's own stage 3 still works: a literal double quote no parser repairs, the letter ending at ITS closing quote.
  const quoted = '{"to": "HR", "employer_name": "Acme", "position": "Dev", "addresses": ["1 Road"], "subject": "S", "cover_letter": "He said "ship it" and we did.\\n\\nPara two."}';
  ok('a literal " inside the letter → v2\'s field extractor, unchanged result', parse(quoted).cover_letter === 'He said "ship it" and we did.\n\nPara two.' && parse(quoted).employer_name === 'Acme', parse(quoted));
  const quoted2 = quoted + '\nHere is the JSON output:\n' + quoted;
  ok('⚠️ …and followed by a SECOND such object, the letter ends at its OWN closing quote (the old reading ran into the second one)',
    parse(quoted2).cover_letter === 'He said "ship it" and we did.\n\nPara two.', parse(quoted2).cover_letter);
  const E = CL._internals.extractLetterFields;
  ok('extractLetterFields: cover_letter not last → it still ends at its own quote', E('{"cover_letter": "A "b" c.", "subject": "S"}').cover_letter === 'A "b" c.', E('{"cover_letter": "A "b" c.", "subject": "S"}'));
  // One-line fields that are not one line are dropped, so letterDetailsOf's own fallbacks fill them.
  const bad = parse(J(L4, { to: '{"name": "HR"}', subject: '```json', addresses: ['1 Road', '"street": "x"', 7] }));
  ok('a JSON-looking addressee / subject / address is dropped (the lane\'s fallback fills it: "Hiring Manager", "Application for …")',
    bad.to === '' && bad.subject === '' && JSON.stringify(bad.addresses) === JSON.stringify(['1 Road']) && CL.letterDetailsOf(bad, { position: 'Dev' }).hiringManager === 'Hiring Manager', bad);
  // Several objects: the LAST one that is a letter.
  const two = parse(J(PARA(9) + '\n\n' + PARA(9)) + '\n' + J(L4, { to: 'Second' }));
  ok('of several objects, the LAST whose letter passes the check', two.to === 'Second' && two.cover_letter === L4);
  const lastBad = parse(J(L4, { to: 'First' }) + '\n' + J([1, 2, 3, 4, 5, 6, 7, 8, 9].map(PARA).join('\n\n'), { to: 'Second' }));
  ok('…so a broken second object never replaces a good first one', lastBad.to === 'First' && lastBad.cover_letter === L4);
}

console.log('── 3c. ⚠️ ONE LITERAL " IN THE FIRST COPY, and a paragraph written NEARLY twice (review round 3, 2026-09-20) ──');
{
  // The critic's reproduction: the Airbus answer with ' 27"' in copy 1's first paragraph. That quote flips
  // escapeRawControlChars' in-string parity, so the REAL newline before copy 1's "}" became the two characters \n; the
  // extractor's end test (raw whitespace only) found no end, fell back to the answer's last quote, and the letter ran on into
  // copy 2 — whose first paragraph, WITHOUT the quote, came out as a fifth paragraph no exact-copy test caught. The gate
  // passed it, the read-side signal passed it: stored and charged.
  const insertAt = (s, anchor, ins, nth = 0) => {
    let i = -1;
    for (let k = 0; k <= nth; k++) i = s.indexOf(anchor, i + 1);
    if (i < 0) throw new Error(`fixture anchor not found: ${anchor}`);
    return s.slice(0, i + anchor.length) + ins + s.slice(i + anchor.length);
  };
  const CLEAN = parse(RAW).cover_letter;
  const ODD = insertAt(RAW, '14+ years', ' 27"');
  const span = (s) => s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1);
  // THE "BEFORE": the 2026-09-19 end test, verbatim, on the escaped answer — no end of its own before the chatter.
  const esc = escapeRawControlChars(span(ODD));
  const from = esc.indexOf('"', esc.indexOf(':', esc.indexOf('"cover_letter"')) + 1) + 1;
  const OLD_END = /"(?=\s*(?:\}|,\s*"[A-Za-z_]+"\s*:))/g;
  OLD_END.lastIndex = from;
  let oldEnd = -1;
  for (let m = OLD_END.exec(esc); m; m = OLD_END.exec(esc)) { if (esc[m.index - 1] !== '\\') { oldEnd = m.index; break; } }
  ok('the "before": in that answer the old end test finds no end of copy 1 (the newline before its "}" is an escaped \\n now)',
    (oldEnd === -1 || oldEnd > esc.indexOf('Here is the JSON output')) && /consideration\."\\n\}/.test(esc), oldEnd);
  const E = CL._internals.extractLetterFields;
  ok('⚠️ extractLetterFields now ends the letter at copy 1\'s OWN closing quote (the escaped space before "}" accepted)',
    E(esc).cover_letter === insertAt(CLEAN, '14+ years', ' 27"'), E(esc).cover_letter.slice(-80));
  const a = parse(ODD);
  const ps = a.cover_letter.split('\n\n');
  ok('⚠️ the critic\'s case → EXACTLY 4 paragraphs (it was 5: paragraph 1 again, a near-copy), copy 1\'s own, its quote kept',
    ps.length === 4 && a.cover_letter === insertAt(CLEAN, '14+ years', ' 27"') && !JUNK.test(a.cover_letter), ps.map((p) => p.slice(0, 40)));
  ok('…its one-line fields intact: the addressee, the subject, the nine offices',
    a.to === 'Head of Cybersecurity' && a.subject === 'Application for Cyber Security Manager — Rishi Samadhiya' && a.addresses.length === 9, a.subject);
  ok('…and it passes the gate and the HTML check', LT.letterProblem(a.cover_letter) === null && !LT.looksContaminatedHtml(format(a.cover_letter, {})));
  // The same quote anywhere else in the answer.
  const variants = [
    ['copy 1, paragraph 3', '8+ developers**', ' at 27" screens', 0, true],
    ['copy 1, its last paragraph', 'Prestwick, UK**', ' (a 27" hop)', 0, true],
    ['copy 1\'s subject', 'Cyber Security Manager — Rishi', ' 27"', 0, false],
    ['copy 2 only', '14+ years', ' 27"', 1, false],
  ];
  for (const [where, anchor, ins, nth, inLetter] of variants) {
    let v = null, err = null;
    try { v = parse(insertAt(RAW, anchor, ins, nth)); } catch (e) { err = e; }
    const want = inLetter ? insertAt(CLEAN, anchor, ins) : CLEAN;
    ok(`a literal " in ${where} → exactly copy 1's 4 paragraphs, passing the gate`,
      !!v && v.cover_letter === want && v.cover_letter.split('\n\n').length === 4 && LT.letterProblem(v.cover_letter) === null && v.addresses.length === 9,
      err ? err.message : v.cover_letter.split('\n\n').map((p) => p.slice(0, 30)));
  }
  const sub = parse(insertAt(RAW, 'Cyber Security Manager — Rishi', ' 27"'));
  ok('…the subject with the quote is read whole (its end, too, accepts the escaped separator)', sub.subject === 'Application for Cyber Security Manager — Rishi 27" Samadhiya', sub.subject);
  // ⚠️ AND THAT SEPARATOR ENDS NOTHING EARLY (review round 4, 2026-09-20). The end test now steps over `\n` as well as raw
  // whitespace, so it must still fire only at the letter's OWN closing quote: a paragraph that ENDS on a quote, with the
  // paragraph breaks arriving as the escapes the parity flip wrote, is followed by the letter's next paragraph — not by
  // `}` or the next key — so the letter comes back whole, every paragraph of it.
  {
    const body = [PARA(1) + ' We ran the whole review on a 27"', PARA(2), PARA(3), PARA(4)].join('\n\n');
    const answer = `{\n"to": "Hiring Manager",\n"employer_name": "Acme",\n"position": "Dev",\n"addresses": ["1 Road"],\n"subject": "S",\n"cover_letter": "${body}"\n}`;
    const a2 = parse(answer);
    ok('⚠️ a paragraph ENDING on a literal " (the breaks after it escaped) → all four paragraphs, the quote kept, passing the gate',
      a2.cover_letter === body && a2.cover_letter.split('\n\n').length === 4 && a2.to === 'Hiring Manager' && LT.letterProblem(a2.cover_letter) === null,
      a2.cover_letter.split('\n\n').map((p) => p.slice(-24)));
    // …and a letter that MENTIONS a backslash-n, next to a literal quote, is not cut there either.
    const slashN = [PARA(1) + ' Our exports separate records with a \\n and a "strict" parser reads them', PARA(2), PARA(3), PARA(4)].join('\n\n');
    const a3 = CL._internals.extractLetterFields(`{"to": "HR", "cover_letter": "${slashN}", "subject": "S"}`);
    ok('…and one that mentions a backslash-n beside a quote keeps every paragraph', a3.cover_letter.split('\n\n').length === 4 && a3.to === 'HR',
      a3.cover_letter.split('\n\n').map((p) => p.slice(-20)));
  }

  // THE SECOND DEFENCE, on its own: a paragraph written NEARLY twice is a paragraph written twice.
  const before = V2_SINGLE_SPAN(ODD).cover_letter;   // what the old reading handed on for that answer
  ok('⚠️ even the old run-on letter cleans to copy 1\'s 4 paragraphs now (the near-copy goes with the exact ones)',
    LT.cleanLetterText(before) === insertAt(CLEAN, '14+ years', ' 27"'), LT.cleanLetterText(before).split('\n\n').length);
  const storedBefore = format(before, {});
  const rb = LT.repairLetterHtml(storedBefore);
  ok('⚠️ …and stored that way, the read side flags it and repairs it to those 4 paragraphs',
    LT.looksContaminatedHtml(storedBefore) && rb.repaired && parasOfHtml(rb.html) === 4 && rb.html === format(insertAt(CLEAN, '14+ years', ' 27"'), {}), parasOfHtml(rb.html));
  const P1x = PARA(1).replace('two days', 'two full days');   // one word added
  const near = [PARA(1), PARA(2), PARA(3), PARA(4), P1x].join('\n\n');
  ok('a near-copy of paragraph 1 (one word added) is dropped by cleanLetterText', LT.cleanLetterText(near) === L4, LT.cleanLetterText(near).split('\n\n').length);
  ok('…refused uncleaned by the gate (duplicated_paragraph)', LT.letterProblem(near) === 'duplicated_paragraph', LT.letterProblem(near));
  ok('…flagged and repaired on the read side, as HTML and as plain text',
    LT.looksContaminatedHtml(format(near, {})) && LT.repairLetterHtml(format(near, {})).html === format(L4, {}) && LT.repairLetterHtml(near).html === L4);
  ok('…and handed on as the 4 paragraphs by the parser (then passing the gate)', parse(J(near)).cover_letter === L4 && LT.letterProblem(parse(J(near)).cover_letter) === null);
  // ⚠️ AND NEVER TWO PARAGRAPHS THAT ONLY OPEN THE SAME WAY (review round 4, 2026-09-20). Round 3 also called the same
  // first 12 words a copy, whatever the rest said — and a letter's own parallel paragraphs have exactly that opening as
  // soon as they name a long job title and employer. The second one was cut from the letter before it was stored and
  // charged, from every read of a stored one, and from the app's cards.
  const LEAD = 'In my role as Project Manager at METASYS SOFTWARE PVT. LTD. in Indore, I ';
  const twin = [PARA(1),
    LEAD + 'directed a portfolio of twelve client programmes worth four million dollars, standardised the reporting cadence for the executive board and cut schedule slippage by a third over two years.',
    LEAD + 'also led the hiring of nine engineers, introduced a mentoring scheme for new analysts and negotiated the vendor contracts that saved the company a quarter of its licence bill.',
    PARA(4)].join('\n\n');
  const sharedLead = (a, b) => { const x = a.toLowerCase().split(/\s+/), y = b.toLowerCase().split(/\s+/); let i = 0; while (i < x.length && x[i] === y[i]) i++; return i; };
  const twinPs = twin.split('\n\n');
  ok(`⚠️ two paragraphs with the same ${sharedLead(twinPs[1], twinPs[2])}-word opening are TWO paragraphs: kept by the writer, passing the gate, not flagged, not repaired`,
    sharedLead(twinPs[1], twinPs[2]) >= 12 && LT.cleanLetterText(twin) === twin && LT.letterProblem(twin) === null
      && !LT.looksContaminatedHtml(format(twin, {})) && !LT.repairLetterHtml(format(twin, {})).repaired
      && parse(J(twin)).cover_letter === twin, { lead: sharedLead(twinPs[1], twinPs[2]), problem: LT.letterProblem(twin), paras: LT.cleanLetterText(twin).split('\n\n').length });
  // …in German and in Hindi too (a long opening repeated, different endings — word edges, accents, Devanagari).
  const DE_LEAD = 'Während meiner Tätigkeit als Projektleiter bei der Siemens AG in München von 2019 bis 2022 habe ich ';
  const deTwin = [DE_LEAD + 'die Einführung eines neuen ERP-Systems für drei Standorte verantwortet und das Budget jedes Mal eingehalten.',
    DE_LEAD + 'außerdem ein Team von zwölf Entwicklerinnen aufgebaut und die Einarbeitung neuer Kolleginnen von Grund auf strukturiert.'].join('\n\n');
  const HI_LEAD = 'मैं टाटा कंसल्टेंसी सर्विसेज में वरिष्ठ परियोजना प्रबंधक के रूप में पिछले आठ वर्षों से ';
  const hiTwin = [HI_LEAD + 'बैंकिंग ग्राहकों के लिए भुगतान प्रणालियाँ बना रहा हूँ और उनकी विश्वसनीयता की जिम्मेदारी संभाल रहा हूँ।',
    HI_LEAD + 'नए इंजीनियरों को प्रशिक्षित कर रहा हूँ तथा तीन शहरों में फैली टीम का नेतृत्व कर रहा हूँ।'].join('\n\n');
  ok('…the same in German and in Hindi: both paragraphs stay, and neither letter is refused as a duplicate',
    LT.cleanLetterText(deTwin) === deTwin && LT.letterProblem(deTwin) !== 'duplicated_paragraph'
      && LT.cleanLetterText(hiTwin) === hiTwin && LT.letterProblem(hiTwin) !== 'duplicated_paragraph',
    { de: LT.cleanLetterText(deTwin).split('\n\n').length, hi: LT.cleanLetterText(hiTwin).split('\n\n').length });
  // ⚠️ AND NEVER A PARAGRAPH THAT ONLY QUOTES AN EARLIER ONE (review round 4): a headline paragraph written out again
  // INSIDE a longer paragraph further down. Round 3 made "one holding the other" the read side's signal too, so the
  // longer paragraph — the one with the new words — was dropped from every read, every download and the app's cards.
  const HEAD = 'Certified Scrum Master and PMP with fourteen years in enterprise software delivery';
  const quoted3 = ['I am writing about the Delivery Lead role at Globex, which matches the programmes I have run for the last decade in regulated industries across Europe.',
    HEAD,
    `As a ${HEAD}, I have run programmes of up to forty engineers across three countries, introduced release trains that cut lead time by half, and kept every milestone of a national rollout on schedule for two years.`,
    'Thank you for considering my application; I would be glad to talk about how I can help Globex deliver its roadmap with the same discipline and pace.'].join('\n\n');
  ok('⚠️ a paragraph that QUOTES an earlier (shorter) one keeps every word it adds — the letter is neither cleaned nor flagged',
    LT.cleanLetterText(quoted3) === quoted3 && LT.letterProblem(quoted3) !== 'duplicated_paragraph'
      && !LT.looksContaminatedHtml(format(quoted3, {})) && !LT.repairLetterHtml(format(quoted3, {})).repaired,
    LT.cleanLetterText(quoted3).split('\n\n').length);
  // …while the letter written out again as ONE block (its paragraphs on single lines) is still a copy: what it holds IS
  // the letter, so nothing of its own is lost.
  const block = [L4, [PARA(1), PARA(2), PARA(3), PARA(4)].join('\n')].join('\n\n');
  ok('…but the whole letter again as one block is still dropped (it is made of the paragraphs above it)',
    LT.cleanLetterText(block) === L4 && LT.letterProblem(block) === 'duplicated_paragraph', LT.cleanLetterText(block).split('\n\n').length);
  // ⚠️ A <br> IS A LINE BREAK TO THE REPAIR TOO (review round 4): the repair keyed a paragraph on its text with the <br>
  // simply deleted ("Razorpay<br>Cut" → one word), so a near-copy the signal and the app both saw was served unrepaired —
  // a paragraph every download printed and Customize showed no card for.
  const lines4 = 'Led the settlement rebuild at Razorpay<br>Cut reconciliation errors by ninety percent<br>Mentored fourteen engineers across three teams<br>Shipped UPI autopay for the largest merchants';
  const asOne = lines4.replace(/<br>/g, ', ').replace('fourteen', 'fifteen');
  const brHtml = `<p>${PARA(1)}</p><p>${lines4}</p><p>${PARA(4)}</p><p>${asOne}</p>`;
  const brFix = LT.repairLetterHtml(brHtml);
  ok('⚠️ a near-copy of a paragraph of <br> lines is flagged AND repaired (3 paragraphs, the <br> lines kept)',
    LT.looksContaminatedHtml(brHtml) && brFix.repaired && parasOfHtml(brFix.html) === 3
      && brFix.html === `<p>${PARA(1)}</p><p>${lines4}</p><p>${PARA(4)}</p>`, { repaired: brFix.repaired, paras: parasOfHtml(brFix.html) });
  // ⚠️ AND IT CANNOT HOLD THE SERVER (review round 4): the near-copy test compares every paragraph with every one before
  // it, and repairLetterHtml runs on every letter a template renders — a free preview of a few hundred <p> froze the one
  // Node thread for seconds per template (13 s for 853 paragraphs). Past NEAR_DUP_MAX_PARAGRAPHS: exact copies only.
  const row = (i) => `Number ${i} of the list, where the team shipped feature ${(i * 7919) % 10007} for customer group ${(i * 104729) % 99991} in that quarter.`;
  const wide = Array.from({ length: 400 }, (_, i) => `<p>${row(i)}</p>`).join('');
  const t0 = Date.now();
  const wideFix = LT.repairLetterHtml(wide);
  const took = Date.now() - t0;
  ok(`400 distinct paragraphs: nothing flagged, nothing repaired, in well under a second (${took} ms)`,
    !LT.looksContaminatedHtml(wide) && !wideFix.repaired && wideFix.html === wide && took < 1000, took);
  const overBoth = (p) => Array.from({ length: LT.NEAR_DUP_MAX_PARAGRAPHS + 1 }, (_, i) => `<p>${row(i)}</p>`).join('') + `<p>${p}</p>`;
  ok(`past ${LT.NEAR_DUP_MAX_PARAGRAPHS} paragraphs only an EXACT copy counts (no text that long is a letter — the gate allows ${LT.MAX_PARAGRAPHS})`,
    LT.looksContaminatedHtml(overBoth(row(3))) && !LT.looksContaminatedHtml(overBoth(row(3).replace('that quarter', 'that same quarter'))),
    [LT.looksContaminatedHtml(overBoth(row(3))), LT.looksContaminatedHtml(overBoth(row(3).replace('that quarter', 'that same quarter')))]);
  // …and never a letter's own paragraphs.
  const airbus = CLEAN.split('\n\n').map((p) => p.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase());
  ok('the four real Airbus paragraphs are not near-copies of each other (nor are the ten test paragraphs)',
    airbus.every((x, i) => airbus.every((y, j) => i === j || !LT.isNearDuplicate(x, y)))
      && WORK.every((_, i) => WORK.every((__, j) => i === j || !LT.isNearDuplicate(PARA(i + 1).toLowerCase(), PARA(j + 1).toLowerCase()))));
  ok(`the threshold is the measured one (${LT.NEAR_DUP_OVERLAP} of the words shared; production's distinct paragraphs share at most 0.32), and the letter's own parallel paragraphs are nowhere near it`,
    LT.NEAR_DUP_OVERLAP === 0.85 && LT.NEAR_DUP_MAX_PARAGRAPHS === 3 * LT.MAX_PARAGRAPHS
      && !LT.isNearDuplicate(twinPs[1].toLowerCase(), twinPs[2].toLowerCase()) && !LT.isNearDuplicate(HEAD.toLowerCase(), quoted3.split('\n\n')[2].toLowerCase()));
  // Words are cut at punctuation only — a letter in German, Polish or Russian is read word for word, not as nothing.
  const de = 'in münchen und kraków habe ich zahlungssysteme für über zwölf länder gebaut, mit klarer verantwortung für betrieb und qualität.';
  const ru = 'в москве я руководил командой из восьми разработчиков и отвечал за платёжную систему, её надёжность и сроки поставки.';
  ok('non-English letters: a near-copy is found (one word changed), a different paragraph is not',
    LT.isNearDuplicate(de, de.replace('zwölf', 'dreizehn')) && LT.isNearDuplicate(ru, ru.replace('восьми', 'девяти'))
      && !LT.isNearDuplicate(de, 'ich freue mich darauf, meine erfahrung in ihr team einzubringen, und danke ihnen für ihre zeit und aufmerksamkeit heute.'));
  ok('short lines are never near-copies (a signature, a greeting: under 60 characters)',
    LT.cleanLetterText(L4 + '\n\nKind regards,\nRishi\n\nKind regards,\nRishi S.') === L4 + '\n\nKind regards,\nRishi\n\nKind regards,\nRishi S.');
}

console.log('── 4. what is NOT junk stays exactly as written ──');
{
  const keep = [
    'I integrated external APIs (REST, gRPC, XML/JSON) for the platform and its partners.',
    'I have completed over 40 projects for clients in fintech and retail, shipping every quarter.',
    'Here is what I would bring to your platform team:',
    'Here is my cover letter for the Software Engineer role at Acme.',
    'Let me know when we can talk about the role.',
    'Please let me know if you need any further information.',
    'Paragraph 1 about the work is a sentence, not a label.',
    'He said "ship it" and we did.',
    'My output rose 40% after we rebuilt the ledger service.',
    'Great teams measure output, not hours.',
    'OKRs and JSON schemas were my daily tools.',
  ];
  for (const line of keep) {
    const text = line + '\n\n' + L4;
    ok(`kept: ${JSON.stringify(line.slice(0, 50))}`, LT.cleanLetterText(text) === text && LT.letterProblem(text) === null && parse(J(text)).cover_letter === text, LT.cleanLetterText(text));
  }
  // A clean letter comes back as the SAME string — whatever its line endings — so what is stored is what it always was.
  for (const text of [L4, L4.replace(/\n\n/g, '\r\n\r\n'), '  ' + L4 + '\n\n\n', 'One line.\nSecond line.\n\nThird.', 'Short.']) {
    ok(`cleanLetterText hands a clean letter back untouched (${JSON.stringify(text.slice(0, 12))}…)`, LT.cleanLetterText(text) === text);
  }
  // A one-<p> letter of <br> lines (15 stored review/job letters are exactly this; the longest line is 1253 characters).
  const oneP = '<p style="margin-bottom: 15px; line-height: 1.6;">' + ['A'.repeat(1253), 'Second line of the same paragraph.', 'Third.'].join('<br>') + '</p>';
  ok('a one-<p> letter of long <br> lines is not flagged and not rewritten', !LT.looksContaminatedHtml(oneP) && LT.repairLetterHtml(oneP).html === oneP);
  ok('…and the gate accepts a letter of single line breaks (its lines are its paragraphs — no blank-line shape demanded)',
    LT.letterProblem([1, 2, 3, 4].map(PARA).join('\n')) === null);
}

console.log('── 4b. ⚠️ A LINE THAT ONLY SOUNDS LIKE THE MODEL is the letter\'s own (review, 2026-09-19) ──');
{
  // Each was cut out as "chatter" by the first version of the rules — on the write side (stored and charged without it),
  // on every read of a stored letter, and in the app from what the user had just typed.
  const CLOSINGS = [
    'I hope this cover letter shows why I am prepared to relocate to **Berlin, Germany** to join **Acme GmbH**. Thank you for your consideration.',
    'I hope this cover letter shows why I would be a strong fit for Acme. Thank you for your consideration.',
    'Please let me know if you need anything further; my portfolio is attached as requested.',
    'Please let me know if you would like the letter in another language.',
    'Recently, I have completed the draft of our platform roadmap and its migration plan.',
    'Feel free to contact me; I have attached my résumé alongside this cover letter.',
    'Of course, the output of my team speaks for itself in the numbers we shipped.',
    'I have written parsers that emit data in JSON format for 40 partners.',
    'Here is how I used JSON schemas to cut integration time:',
    // ⚠️ ROUND 2 (review, 2026-09-19): "names the format" was still junk on its words alone — each of these was cut.
    'Please let me know if you would like my certificates in the requested format.',
    'Feel free to request my portfolio in the requested format.',
    'Here are my references, available in the requested format.',
    'I hope this letter shows my fit; I can share sample API contracts in JSON format.',
    // …and a sign-off only when "helps" ends the clause.
    'I hope this helps explain why I am moving from finance into platform engineering at Acme.',
  ];
  for (const c of CLOSINGS) {
    const text = [PARA(1), PARA(2), PARA(3), c].join('\n\n');
    const a = parse(J(text));
    ok(`⚠️ write: ${JSON.stringify(c.slice(0, 44))}… stays, and the letter passes the gate (stored WITH it)`,
      LT.cleanLetterText(text) === text && a.cover_letter === text && LT.letterProblem(a.cover_letter) === null, a.cover_letter.split('\n\n').length);
    const html = format(text, {});
    ok(`⚠️ read: …a stored letter ending with it is not flagged and comes back as the same string`,
      !LT.looksContaminatedHtml(html) && LT.repairLetterHtml(html).html === html && LT.repairLetterHtml(html).repaired === false);
  }
  // ⚠️ ROUND 2: the same closings in the MIDDLE of a letter (where the reviewer put them: before the last paragraph).
  for (const c of CLOSINGS.slice(-5)) {
    const text = [PARA(1), PARA(2), PARA(3), c, PARA(4)].join('\n\n');
    const html = format(text, {});
    ok(`⚠️ mid-letter: ${JSON.stringify(c.slice(0, 44))}… stays on write (gate null) and on read (same string)`,
      LT.cleanLetterText(text) === text && parse(J(text)).cover_letter === text && LT.letterProblem(text) === null
        && !LT.looksContaminatedHtml(html) && LT.repairLetterHtml(html).html === html, LT.repairLetterHtml(html).repaired);
  }
  // A line naming the format with NO JSON anywhere in the letter is, as far as any rule can tell, the letter's words.
  const midFormat = PARA(1) + '\n\nHere is the JSON output.\n\n' + [2, 3, 4].map(PARA).join('\n\n');
  ok('⚠️ a line naming the format mid-letter, no JSON anywhere → kept (write and read): never junk on its words alone',
    LT.namesFormat('Here is the JSON output.') && LT.cleanLetterText(midFormat) === midFormat && !LT.looksContaminatedHtml(format(midFormat, {})));
  const reviewerHtml = '<p>Dear Hiring Manager,</p><p>I have led things for years at many companies and delivered.</p><p>Please let me know if you need anything further; my portfolio is attached as requested.</p><p>Sincerely,<br>Rishi</p>';
  ok('⚠️ read: the reviewer\'s Job Hub / Letters letter (no JSON anywhere) keeps its "Please let me know … as requested." paragraph',
    LT.repairLetterHtml(reviewerHtml).repaired === false && LT.repairLetterHtml(reviewerHtml).html === reviewerHtml);
  // In a letter that DOES carry the junk, a closing that sounds like the model still stays: it is not next to the JSON's
  // opening, and nothing closes right before it (the stray '"' and the "}" come AFTER it).
  const closing = 'I hope this cover letter shows why I would be a strong fit for <strong>Airbus SE</strong>. Thank you for your consideration.';
  // (the letter's fourth paragraph is that closing — and so is its copy at the end of the junk, the ninth)
  const stored = STORED_P.slice(0, 3).join('') + STORED_P[3].replace(/^<p>[\s\S]*?(?="<br>\})/, '<p>' + closing)
    + STORED_P.slice(4, 8).join('') + '<p>' + closing + '</p>';
  const rs = LT.repairLetterHtml(stored);
  ok('⚠️ the Airbus junk around a closing that SOUNDS like the model: the junk goes, the closing stays (4 paragraphs)',
    rs.repaired && parasOfHtml(rs.html) === 4 && rs.html.endsWith('<p>' + closing + '</p>') && !JUNK.test(rs.html), rs.html.slice(-220));
  // What still goes: a chatter line that touches the JSON, introduces nothing, or names the format.
  const drops = {
    'after a closing fence': L4 + '\n\n```json\n{\n"subject": "S"\n}\n```\n\nI hope this helps! Let me know if you want changes to the letter.',
    'right before an opening fence': L4 + '\n\nI have completed the cover letter for the role.\n\n```json\n{',
    'right after a closing brace': L4 + '\n}\nRishi, I have completed the cover letter for the Cyber Security Manager position at Airbus.',
    'an introducer at the start': 'Sure! Here is your cover letter:\n\n' + L4,
    'an introducer at the end': L4 + '\n\nHere is the cover letter for the role:',
    'an introducer before the letter again': L4 + '\n\nHere is the letter again:\n\n' + L4,
    // RETARGETED 2026-09-19 (round 2): was "naming the format, anywhere" — now only in a letter that carries the JSON (here
    // far from it: neither neighbour is the JSON), or as an introducer with nothing to introduce.
    'naming the format, in a letter carrying the JSON': PARA(1) + '\n\nHere is the JSON output.\n\n' + [2, 3, 4].map(PARA).join('\n\n') + '\n\n```json\n{\n"subject": "S"\n}\n```',
    'naming the format as the last line (an introducer to nothing)': L4 + '\n\nHere is the JSON output:',
  };
  for (const [name, text] of Object.entries(drops)) {
    const out = LT.cleanLetterText(text);
    ok(`chatter ${name} still goes (the four paragraphs are left)`, out === L4, out.slice(-120));
  }
}

console.log('── 4c. ⚠️ THE MODEL\'S WRAPPER INSIDE cover_letter: its opener as the first line, its sign-off as the last (review round 2, 2026-09-19) ──');
{
  // Each of these passed the gate before round 2 and was stored and charged as a paragraph card on Customize.
  const WRAPPED = {
    '"Sure! Here is the cover letter you asked for." first': 'Sure! Here is the cover letter you asked for.\n\n' + L4,
    '"Certainly! Below is the tailored cover letter." first': 'Certainly! Below is the tailored cover letter.\n\n' + L4,
    '"Sure!" alone, then "Here is your cover letter."': 'Sure!\n\nHere is your cover letter.\n\n' + L4,
    '"Here is a tailored cover letter for the role at Acme." first (no colon)': 'Here is a tailored cover letter for the role at Acme.\n\n' + L4,
    '"**Of course! Here\'s your letter.**" first, in bold': '**Of course! Here\'s your letter.**\n\n' + L4,
    'the opener on the first paragraph\'s own first line': 'Certainly! Here is the cover letter.\n' + L4,
    '"I hope this helps!" last': L4 + '\n\nI hope this helps!',
    '"Good luck with your application!" last': L4 + '\n\nGood luck with your application!',
    '"I hope this helps! Let me know …" last': L4 + '\n\nI hope this helps! Let me know if you want any changes.',
    'both ends': 'Sure! Here is the cover letter:\n\n' + L4 + '\n\nHope this helps. Good luck!',
  };
  for (const [name, text] of Object.entries(WRAPPED)) {
    const a = parse(J(text));
    ok(`⚠️ write: ${name} → refused by the gate as it came, taken out by the cleaning: the 4 paragraphs, passing`,
      LT.letterProblem(text) === 'assistant_text' && LT.cleanLetterText(text) === L4 && a.cover_letter === L4 && LT.letterProblem(a.cover_letter) === null,
      { raw: LT.letterProblem(text), out: a.cover_letter.slice(0, 60) });
    const html = format(text, {});
    const r = LT.repairLetterHtml(html);
    ok('⚠️ read: …a letter stored with it is flagged and served as the 4 paragraphs (idempotent)',
      LT.looksContaminatedHtml(html) && r.repaired && r.html === format(L4, {}) && LT.repairLetterHtml(r.html).repaired === false, r.html.slice(0, 160));
  }
  // What only LOOKS like a wrapper, at the very start or the very end, is the letter's own.
  const LOOKALIKES = [
    'Here is my cover letter for the Software Engineer role at Acme.',                 // an applicant writes "my"
    'Here are three reasons the role at Acme fits me.',
    'Of course, the output of my team speaks for itself in the numbers we shipped.',
    'Certainly the most rewarding project of my career was the Acme ledger rebuild.',
    'Sure enough, the numbers followed: revenue grew 40% in a year.',
    'I hope this helps explain why I am moving from finance into platform engineering at Acme.',
    'Good luck to the whole team with the launch; I would love to help ship the next one.',
  ];
  for (const l of LOOKALIKES) {
    for (const [where, text] of [['first', l + '\n\n' + L4], ['last', L4 + '\n\n' + l]]) {
      const html = format(text, {});
      ok(`kept ${where}: ${JSON.stringify(l.slice(0, 44))}… (write: same string, gate null; read: not flagged)`,
        LT.cleanLetterText(text) === text && parse(J(text)).cover_letter === text && LT.letterProblem(text) === null
          && !LT.looksContaminatedHtml(html) && LT.repairLetterHtml(html).html === html, { clean: LT.cleanLetterText(text) === text, gate: LT.letterProblem(text) });
    }
  }
  // Not first, not last: an opener or a sign-off in the middle of the letter is left as written.
  const mid = PARA(1) + '\n\nI hope this helps!\n\n' + [2, 3, 4].map(PARA).join('\n\n');
  ok('a sign-off in the MIDDLE is not junk by position (no rule names it)', LT.cleanLetterText(mid) === mid && !LT.looksContaminatedHtml(format(mid, {})));
  // Stored with a salutation and a signature (a Letters / Job Hub letter): the wrapper still stands outside them.
  const signed = '<p>Sure! Here is the cover letter you asked for.</p><p>Dear Hiring Manager,</p><p>' + PARA(1) + '</p><p>Sincerely,<br>Rishi</p><p>I hope this helps!</p>';
  const rs = LT.repairLetterHtml(signed);
  ok('⚠️ read: a signed letter wrapped by the model → the salutation, the body and the signature, nothing else',
    rs.repaired && rs.html === '<p>Dear Hiring Manager,</p><p>' + PARA(1) + '</p><p>Sincerely,<br>Rishi</p>', rs.html);
}

console.log('── 5. THE GATE: what is refused before a letter is stored or charged ──');
{
  const cases = [
    ['', 'empty'],
    ['   \n  ', 'empty'],
    [PARA(1) + '\n\n```json\n{}', 'code_fence'],
    [PARA(1) + '\n"subject": "S",', 'json'],
    [PARA(1) + ' {"to": "HR"}', 'json'],
    [PARA(1) + '\n}', 'json'],
    [L4 + '\n\nHere is the JSON output:', 'assistant_text'],
    [L4 + '\n}\nRishi, I have completed the cover letter for the role at Airbus.', 'json'],
    ['Here is the cover letter for the role:\n\n' + L4, 'assistant_text'],
    [PARA(1) + '\n\n' + PARA(2) + '\n\n' + PARA(1), 'duplicated_paragraph'],
    [[1, 2, 3, 4, 5, 6, 7, 8, 9].map(PARA).join('\n\n'), 'too_many_paragraphs'],
    ['x'.repeat(2501), 'paragraph_too_long'],
    // 1001 words in seven paragraphs of 143 (each line well under the 2500-character cap)
    [Array.from({ length: 7 }, (_, i) => Array.from({ length: 143 }, () => `w${i}`).join(' ')).join('\n\n'), 'too_long'],
    // ⚠️ THE LOWER BOUND AND THE PROMPT'S TEMPLATE (review, 2026-09-19): what a parse could hand on in place of a letter.
    ['PARAGRAPH 1 text\n\nPARAGRAPH 2 text\n\nPARAGRAPH 3 text\n\nPARAGRAPH 4 text', 'template'],
    [L4.replace('Paragraph 4 about', 'I am prepared to relocate to **[City, Country]**. Paragraph 4 about'), 'template'],
    ['Please see the letter below.', 'too_short'],
    [PARA(1), 'too_short'],
    [[1, 2].map(PARA).join('\n\n'), 'too_short'],
    [Array.from({ length: 130 }, () => 'word').join(' '), 'too_short'],   // 130 words on ONE line: not a letter's shape
  ];
  for (const [text, want] of cases) ok(`gate: ${want} (${JSON.stringify(text.slice(-30))})`, LT.letterProblem(text) === want, LT.letterProblem(text));
  ok('gate: eight paragraphs, 1000 words, 2500-char lines are still a letter',
    LT.letterProblem([1, 2, 3, 4, 5, 6, 7, 8].map(PARA).join('\n\n')) === null && LT.letterProblem('x'.repeat(2500) + '\n\n' + L4) === null
      && LT.letterProblem(Array.from({ length: 8 }, (_, i) => Array.from({ length: 125 }, () => `w${i}`).join(' ')).join('\n\n')) === null);
  ok(`gate: the lower bound is ${LT.MIN_WORDS} words in ${LT.MIN_LINES}+ lines — three real paragraphs pass, and production's shortest (252 words, 4 paragraphs) is far above it`,
    LT.MIN_WORDS === 120 && LT.MIN_LINES === 2 && LT.letterProblem([1, 2, 3].map(PARA).join('\n\n')) === null);
  // ⚠️ THE DOC-15 WRAPPER ITSELF, WITH NO JSON AROUND IT (review round 5, 2026-09-20). Until round 5 this exact sentence —
  // the one in fixtures/letter-doc15-raw.txt — was junk in NO position: it wraps nothing, introduces nothing, and the
  // "names the format" arm wants the answer's JSON beside it. So a model that wrote it INSIDE cover_letter got it stored,
  // charged, printed in the PDF and the Word file and e-mailed to the recruiter. It is a wrapper by POSITION now.
  ok('gate: "Rishi, I have completed the cover letter …" as the LAST paragraph is refused (the doc-15 wrapper)',
    LT.letterProblem(L4 + '\n\nRishi, I have completed the cover letter for the role at Airbus.') === 'assistant_text',
    LT.letterProblem(L4 + '\n\nRishi, I have completed the cover letter for the role at Airbus.'));
  ok('gate: …and as the FIRST paragraph too',
    LT.letterProblem('I have drafted the cover letter for the Cyber Security Manager position at Airbus.\n\n' + L4) === 'assistant_text');
  // …while the applicant's own sentences of that shape stay the letter's own, first, last and in the middle.
  for (const own of ['I have completed my cover letter with your Toulouse team in mind.',
    'I have prepared this cover letter specifically for the Cyber Security Manager brief.',
    'I have completed over forty enterprise projects in fourteen years of delivery leadership.']) {
    ok(`gate: a letter's own "${own.slice(0, 34)}…" is not refused, first or last`,
      LT.letterProblem(L4 + '\n\n' + own) === null && LT.letterProblem(own + '\n\n' + L4) === null,
      [LT.letterProblem(L4 + '\n\n' + own), LT.letterProblem(own + '\n\n' + L4)]);
  }
}

console.log('── 5b. ⚠️ SEVERAL OBJECTS: the fullest letter that passes, never the prompt\'s template or a stub (review, 2026-09-19) ──');
{
  const TEMPLATE = JSON.stringify({ to: 'Hiring manager name if found, otherwise most relevant title e.g. Head of Engineering', employer_name: 'Full official company name',
    position: 'Target position exactly as provided', addresses: ['HQ full street address, postal code, city, country'],
    subject: 'Application for [Target Position] — [User Full Name from metadata]', cover_letter: 'PARAGRAPH 1 text\n\nPARAGRAPH 2 text\n\nPARAGRAPH 3 text\n\nPARAGRAPH 4 text' }, null, 2);
  const real = J(L4, { to: 'Head of Engineering', subject: 'Application for Dev — Ada' });
  const a = parse(real + '\n\nThe output follows this format:\n\n' + TEMPLATE);
  ok('⚠️ the real letter, then the prompt\'s template echoed back → the REAL letter and its own subject (the old "last that passes" took the template)',
    a.cover_letter === L4 && a.subject === 'Application for Dev — Ada' && a.to === 'Head of Engineering', { letter: a.cover_letter.slice(0, 40), subject: a.subject });
  const b = parse(real + '\n' + JSON.stringify({ cover_letter: 'Please see the letter below.' }));
  ok('…the real letter, then a one-line object → the real letter', b.cover_letter === L4 && b.to === 'Head of Engineering');
  const c = parse(TEMPLATE);
  ok('the template ALONE is handed on as it is, and the gate refuses it (writeLegacyLetter asks again; nothing is charged)',
    LT.letterProblem(c.cover_letter) === 'template');
  const longer = [1, 2, 3, 4, 5].map(PARA).join('\n\n');
  const d = parse(J(longer, { to: 'First' }) + '\n' + J([1, 2, 3].map(PARA).join('\n\n'), { to: 'Second' }));
  ok('of two letters that pass, the FULLER one', d.to === 'First' && d.cover_letter === longer);
  const e = parse(J(L4, { to: 'First' }) + '\n' + J(L4, { to: 'Second' }));
  ok('…of two equal ones, the later (the Airbus answer: its two objects were the same letter)', e.to === 'Second');
  const f = parse(J(L4, { subject: 'Application for [Target Position] — [User Full Name from metadata]', to: '[Your Name]' }));
  ok('a real letter whose subject / addressee is still the prompt\'s slot → those fields dropped (the lane\'s fallback: "Application for <position>", "Hiring Manager")',
    f.cover_letter === L4 && f.subject === '' && f.to === '' && CL.letterDetailsOf(f, { position: 'Dev' }).subject === 'Application for Dev'
      && CL.letterDetailsOf(f, { position: 'Dev' }).hiringManager === 'Hiring Manager', f);
}

console.log('── 6. a STORED letter, repaired where it is read ──');
{
  const r = LT.repairLetterHtml(STORED);
  ok('⚠️ doc 15 as stored → FOUR paragraphs, repaired:true, no fence / key / chatter / brace left', r.repaired === true && parasOfHtml(r.html) === 4 && !JUNK.test(r.html) && !LT.looksContaminatedHtml(r.html), r.html.slice(-200));
  ok('⚠️ …the first three byte for byte as stored (their bold kept), the fourth ending at "consideration."',
    r.html.startsWith(STORED_P.slice(0, 3).join('')) && r.html === STORED_P.slice(0, 3).join('') + STORED_P[3].replace(/"<br>\}<br>[^<]*<\/p>$/, '</p>') && (r.html.match(/<strong>/g) || []).length > 20);
  const r2 = LT.repairLetterHtml(r.html);
  ok('idempotent: the repaired letter reads as clean and comes back as the same string', r2.repaired === false && r2.html === r.html);
  const cleanHtml = format(L4, {});
  ok('a clean formatter letter (<p style>, bold) is handed back as the very same string', LT.repairLetterHtml(cleanHtml).html === cleanHtml && LT.repairLetterHtml(cleanHtml).repaired === false);
  ok('a clean plain-text letter too', LT.repairLetterHtml(L4).html === L4 && LT.repairLetterHtml('').html === '' && LT.repairLetterHtml(null).html === '');
  // The same junk, in the shapes a stored letter can have.
  const styled = format(V2_SINGLE_SPAN(RAW).cover_letter, {});   // the UNEDITED Airbus letter: <p style="…"> blocks
  const rs = LT.repairLetterHtml(styled);
  ok('the unedited letter (<p style>) → four paragraphs, each keeping its own <p style>', rs.repaired && parasOfHtml(rs.html) === 4 && (rs.html.match(/<p style="margin-bottom: 15px; line-height: 1\.6;">/g) || []).length === 4 && unstyled(rs.html) === r.html);
  const plain = V2_SINGLE_SPAN(RAW).cover_letter;   // plain text (a classic body)
  const rp = LT.repairLetterHtml(plain);
  ok('the same letter as plain text → plain text, four paragraphs', rp.repaired && !/</.test(rp.html) && rp.html.split('\n\n').length === 4 && !JUNK.test(rp.html), rp.html.slice(-120));
  const loose = STORED.replace(/<\/p><p>/g, '<br><br>').replace(/^<p>|<\/p>$/g, '');   // paragraphs as <br><br>, no <p>
  const rl = LT.repairLetterHtml(loose);
  ok('…and as <br><br>-separated HTML with no <p>', rl.repaired && rl.html.split('<br><br>').length === 4 && !JUNK.test(rl.html), rl.html.split('<br><br>').length);
  const escaped = STORED.replace(/"/g, '&quot;');   // quotes stored as entities
  const re = LT.repairLetterHtml(escaped);
  ok('…and with its quotes stored as &quot;', re.repaired && parasOfHtml(re.html) === 4 && !/&quot;cover_letter&quot;|```/.test(re.html) && /consideration\.<\/p>$/.test(re.html));
  const withList = '<p>Intro to the role.</p><ul><li>Led a team</li></ul>' + STORED;
  ok('a list in the letter is left exactly as it was', LT.repairLetterHtml(withList).html.startsWith('<p>Intro to the role.</p><ul><li>Led a team</li></ul>'));
  // The payload helper: the same object when clean, a copy (the row untouched) when repaired.
  const cleanP = { coverLetterHtml: cleanHtml, subject: 'S' };
  const badP = { coverLetterHtml: STORED, subject: 'S' };
  const fixedP = LT.repairedLetterPayload(badP);
  ok('repairedLetterPayload: the SAME object for a clean letter, a repaired copy otherwise (the stored one untouched)',
    LT.repairedLetterPayload(cleanP) === cleanP && fixedP !== badP && fixedP.coverLetterHtml === r.html && fixedP.subject === 'S' && badP.coverLetterHtml === STORED
      && LT.repairedLetterPayload(null) === null && LT.repairedLetterPayload({ personal_info: {} }).personal_info);
}

// ⚠️ ROUND 5 (review, 2026-09-20). Six ways the repair still lost a paid letter's own words, or still served the model's:
//   • a letterhead card and the signature card are the same words — the SIGNATURE was deleted (word sets, and "made of
//     earlier paragraphs": the signature IS "Sincerely," plus the letterhead);
//   • a closing that repeats a sentence the body already ends with was deleted ("one holding the other");
//   • an applicant's own "Here is the letter of interest you asked me for …" was deleted (a bare "letter" is not the
//     model's word for its answer; "the COVER letter" is);
//   • the doc-15 wrapper INSIDE cover_letter was kept, stored, charged and printed (section 5 gates it now);
//   • one pass is not a fixed point: a chatter line shielded by a "{" before it, or a key line after it, survived the
//     repair the GET route serves;
//   • a letter written in <div>s instead of <p>s was left whole — junk served, while the app's cards dropped it.
console.log('── 6b. ⚠️ the letter\'s own words, and the model\'s, round 5 (review, 2026-09-20) ──');
{
  const PP = (t) => `<p style="margin-bottom: 15px; line-height: 1.6;">${t}</p>`;
  const B = [
    'With <strong>fourteen years</strong> of delivery leadership I am applying for the Cyber Security Manager position at Airbus SE, a brief that matches everything I have built since 2011.',
    'In my role as Project Manager at METASYS SOFTWARE PVT. LTD. in Indore, I directed twelve client programmes worth four million dollars and cut schedule slippage by a third over two years.',
    'I am genuinely interested in the strategic cybersecurity initiatives at Airbus SE and am prepared to relocate to Prestwick. Thank you for your consideration of my application.',
  ];
  const kept = (name, paras) => {
    const html = paras.map(PP).join('');
    const r = LT.repairLetterHtml(html);
    ok(`⚠️ ${name} → every paragraph kept, nothing flagged`,
      r.repaired === false && r.html === html && !LT.looksContaminatedHtml(html) && LT.cleanLetterText(paras.join('\n\n')) === paras.join('\n\n'),
      { repaired: r.repaired, was: paras.length, now: parasOfHtml(r.html) });
  };
  const HEAD = 'Rishi Samadhiya<br>42 Vijay Nagar<br>Indore 452010<br>India<br>rishi@example.com<br>+91 98765 43210';
  kept('a letterhead at the top and the same block signed at the bottom', [HEAD, 'Dear Hiring Manager,', ...B, 'Sincerely,<br>' + HEAD]);
  const SAME = 'I am available to start within four weeks and can relocate to Munich at my own expense.';
  kept('a closing that repeats word for word a sentence the body already ends with', ['Dear Hiring Manager,', B[0] + ' ' + SAME, B[1], SAME, 'Sincerely,<br>Rishi Samadhiya']);
  kept('an applicant opening "Here is the letter of interest you asked me for …"',
    ['Here is the letter of interest you asked me for on Tuesday, together with a note on my notice period.', ...B, 'Sincerely,<br>Rishi Samadhiya']);
  kept('a headline paragraph quoted inside a longer one further down',
    ['Certified Scrum Master and PMP with fourteen years in enterprise software delivery',
      'As a Certified Scrum Master and PMP with fourteen years in enterprise software delivery, I have run programmes of up to forty engineers across three countries.', ...B]);
  // …and the model's own wrappers still go, in every one of those positions.
  const goes = (name, paras, gone) => {
    const html = paras.map(PP).join('');
    const r = LT.repairLetterHtml(html);
    ok(`⚠️ ${name} → gone in ONE call, and the result reads as clean`,
      r.repaired === true && !gone.test(r.html) && !LT.looksContaminatedHtml(r.html) && LT.repairLetterHtml(r.html).repaired === false,
      { repaired: r.repaired, left: gone.test(r.html), still: LT.looksContaminatedHtml(r.html) });
  };
  goes('"Here is the cover letter you asked for." as the first paragraph', ['Here is the cover letter you asked for.', ...B], /Here is the cover letter/);
  goes('the doc-15 wrapper as the last paragraph', [...B, 'Rishi, I have completed the cover letter for the Cyber Security Manager position at Airbus.'], /I have completed the cover letter/);
  goes('the doc-15 wrapper as the first paragraph', ['Rishi, I have completed the cover letter for the Cyber Security Manager position at Airbus.', ...B], /I have completed the cover letter/);
  // ⚠️ A FIXED POINT, NOT ONE PASS: chatterJunkIn judges a chatter line by its neighbours BEFORE cleanLine removes the
  // brace / key lines beside it, so these two shapes were "repaired" with the model's words still in them.
  goes('an opener shielded by a "{" line before it', ['{', 'Sure! Here is the cover letter you asked for.', ...B, '}'], /Sure! Here is/);
  goes('a sign-off shielded by a key line after it', [...B, 'I hope this helps!', '"subject": "Application for Cyber Security Manager"'], /hope this helps/);
  // ⚠️ THE DETECTOR AND THE REPAIR COUNT THE SAME PARAGRAPHS: past NEAR_DUP_MAX_PARAGRAPHS neither looks for near-copies,
  // so a letter can never be flagged for ever and repaired never (repaired:false, no log line, the copy still printing).
  {
    const long = 'With fourteen years in enterprise software delivery I have run programmes of up to forty engineers and delivered custom solutions across many sectors and countries worldwide every year.';
    const many = [long, ...Array.from({ length: 23 }, (_, i) => `Line ${i}.`), long.replace('every year', 'each year')];
    const html = many.map(PP).join('');
    ok(`⚠️ ${many.length} paragraphs, ${many.filter((p) => p.length >= 60).length} of them long: flagged ⇒ repaired (never one without the other)`,
      LT.looksContaminatedHtml(html) === LT.repairLetterHtml(html).repaired, { flagged: LT.looksContaminatedHtml(html), repaired: LT.repairLetterHtml(html).repaired });
  }
  // ⚠️ A CONTAINER IS NOT A LIST: a letter written in <div>s (or <h2>s) is repaired like one written in <p>s — the app's
  // own splitCards always read those as cards, so a letter the app showed clean was served and printed with the junk in it.
  for (const tag of ['div', 'h2', 'blockquote']) {
    const html = [...B, '}', 'Here is the JSON output:', '```json', '"cover_letter": "…"'].map((t) => `<${tag}>${t}</${tag}>`).join('');
    const r = LT.repairLetterHtml(html);
    ok(`⚠️ a letter written in <${tag}> instead of <p>: the junk goes, the three paragraphs stay`,
      r.repaired === true && !JUNK.test(r.html) && !LT.looksContaminatedHtml(r.html) && B.every((t) => r.html.includes(t)) && !/<\w+>\s*<\/\w+>/.test(r.html), r.html.slice(0, 160));
  }
  ok('…while a real list between two <p> paragraphs is still left exactly as it was',
    LT.repairLetterHtml(PP(B[0]) + '<ul><li>Azure DevOps</li><li>.NET Core</li></ul>' + PP(B[1]) + PP('```json') + PP('"cover_letter": "x"')).html
      .includes('<ul><li>Azure DevOps</li><li>.NET Core</li></ul>'));
  // Repairing on EVERY read has to be free for a normal letter: the GET route, the editor, both downloads and the e-mail.
  {
    const clean = format(L4, {});
    for (let i = 0; i < 200; i++) LT.repairLetterHtml(clean);
    const t = Date.now();
    for (let i = 0; i < 500; i++) LT.repairLetterHtml(clean);
    const per = (Date.now() - t) / 500;
    ok(`a clean letter costs ${per.toFixed(2)} ms a read (well under 5 ms, and the same string back)`, per < 5 && LT.repairLetterHtml(clean).html === clean, per);
  }
}

console.log('── 7. the renderers print the repaired letter ──');
(async () => {
  const T = require(path.join(ROOT, 'server/utils/coverLetterTemplates.js'));
  const data = (bodyHtml) => ({ sender: { name: 'Rishi Samadhiya', title: '', email: 'r@x.test', phone: '', location: '' }, company: { name: 'Airbus', address: '' }, bodyHtml });
  for (const id of T.TEMPLATE_IDS) {
    const h = T.renderCoverLetterHtml(id, data(STORED), { mode: 'a4' });
    ok(`design ${id}: the stored Airbus letter prints its four paragraphs only (no fence, no JSON, no chatter, "consideration" once)`,
      !/```|"cover_letter"|Here is the JSON|I have completed the cover letter/.test(h) && (h.match(/Thank you for your consideration/g) || []).length === 1, id);
  }
  const cleanHtml = format(L4, {});
  ok('a clean letter reaches the design untouched (its HTML verbatim in the page)', T.renderCoverLetterHtml('ats_pro', data(cleanHtml), { mode: 'a4' }).includes(cleanHtml));
  try {
    const JSZip = require('jszip');
    const { buildCoverLetterDocx } = require(path.join(ROOT, 'server/utils/docxBuilder.js'));
    const docText = async (buf) => (await (await JSZip.loadAsync(buf)).file('word/document.xml').async('string')).replace(/<[^>]+>/g, ' ');
    for (const tpl of ['standard', 'german']) {
      const x = await docText(await buildCoverLetterDocx(data(STORED), { template: tpl }));
      ok(`the Word file (${tpl}) of the stored Airbus letter: four paragraphs, no fence, no JSON, no chatter`,
        !/```|&quot;cover_letter&quot;|"cover_letter"|Here is the JSON|I have completed the cover letter/.test(x) && (x.match(/Thank you for your consideration/g) || []).length === 1, x.slice(-300));
    }
    const d = data(cleanHtml);
    const cx = await docText(await buildCoverLetterDocx(d, { template: 'standard' }));
    ok('…and a clean letter\'s Word file carries its words (the data object is not rewritten)', /Paragraph 4 about/.test(cx) && d.bodyHtml === cleanHtml);
  } catch (e) {
    ok('the Word builder ran', false, String(e && e.stack || e));
  }

  // The Letters page (review_cover_letters) and the Job Hub (job_cover_letters) serve their stored letters repaired too.
  // No stored row there carries the junk today; these are the doors a future one would come through.
  {
    const db = require.cache[dbPath].exports;
    const realGet = db.get, realQuery = db.query;
    const mkRes = () => { const r = { statusCode: 200, body: null }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
    try {
      const rowsOf = (html) => [{ letter_key: 'k', companyName: 'Airbus', recipientEmail: 'hr@airbus.test', coverLetterHtml: html, subject: 'S', address: '', date: '', position: 'P', locations: null, generated: 1, sent: 0, storedRecipientEmail: 'hr@airbus.test', storedRecipientWebsite: 'airbus.test' }];
      const UD = quiet(() => require(path.join(ROOT, 'server/controllers/userDataController.js')));
      db.query = async () => rowsOf(STORED);
      let res = mkRes(); await quiet(() => UD.getReviewCoverLetters({ user: { id: 7 } }, res));
      const served = JSON.stringify((res.body || {})).includes('```json');
      const letterOf = (b) => { const o = (b && (b.reviewCoverLetters || b.coverLetters || b.letters)) || {}; const v = Object.values(o)[0]; return v && v.coverLetterHtml; };
      ok('the Letters page (GET review cover letters) serves the stored Airbus letter repaired', !served && parasOfHtml(letterOf(res.body)) === 4, res.body && Object.keys(res.body));
      const clean = format(L4, {});
      db.query = async () => rowsOf(clean);
      res = mkRes(); await quiet(() => UD.getReviewCoverLetters({ user: { id: 7 } }, res));
      ok('…and a clean one exactly as stored', letterOf(res.body) === clean);
      const HUB = quiet(() => require(path.join(ROOT, 'server/controllers/aiHubController.js')));
      const JOB = '0f8fad5b-d9cb-469f-a165-70867728950e';
      db.get = async (sql) => (/FROM job_cover_letters/.test(sql) ? { id: 1, user_id: 7, job_id: JOB, cover_letter_html: STORED, status: 'generated' } : null);
      res = mkRes(); await quiet(() => HUB.getJobCoverLetter({ user: { id: 7 }, params: { jobId: JOB } }, res));
      const h = res.body && res.body.coverLetter && res.body.coverLetter.cover_letter_html;
      ok('the Job Hub (GET a job\'s cover letter) serves it repaired, the rest of the row as stored', parasOfHtml(h) === 4 && !/```/.test(h) && res.body.coverLetter.status === 'generated', res.body);
      db.get = async (sql) => (/FROM job_cover_letters/.test(sql) ? { id: 1, user_id: 7, job_id: JOB, cover_letter_html: clean, status: 'applied' } : null);
      res = mkRes(); await quiet(() => HUB.getJobCoverLetter({ user: { id: 7 }, params: { jobId: JOB } }, res));
      ok('…and a clean one exactly as stored', res.body && res.body.coverLetter && res.body.coverLetter.cover_letter_html === clean);
    } catch (e) {
      ok('the Letters page / Job Hub letter reads ran', false, String(e && e.stack || e));
    } finally { db.get = realGet; db.query = realQuery; }
  }

  // The Send page (letterSendController, review 2026-09-19): its email-body draft QUOTES the letter to the model, and a send
  // freezes it into download_history — both read it through loadLetter, which serves it repaired too.
  {
    const docsMod = require(path.join(ROOT, 'server/services/employerDocs.js'));
    const aiMod = quiet(() => require(path.join(ROOT, 'server/services/aiText.js')));
    const realGetById = docsMod.getById, realGen = aiMod.generateText;
    const prompts = [];
    const mkRes = () => { const r = { statusCode: 200, body: null }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
    try {
      const rowOf = (html) => ({ id: 15, user_id: 7, kind: 'cover_letter', environment: 'Sandbox', employer_name: 'Airbus', job_url: '', payload: { coverLetterHtml: html, subject: 'S', companyName: 'Airbus SE', position: 'Cyber Security Manager' } });
      let row = rowOf(STORED);
      docsMod.getById = async () => row;
      aiMod.generateText = async (o) => { prompts.push(String(o && o.prompt)); return { text: '', model: 'stub' }; };
      const LS = quiet(() => require(path.join(ROOT, 'server/controllers/letterSendController.js')));
      let res = mkRes(); await quiet(() => LS.draftEmailBody({ user: { id: 7 }, params: { id: '15' }, headers: {}, query: {}, body: {} }, res));
      const quoted = (prompts[0] || '').split('"""')[1] || '';
      ok('⚠️ Send: the email-body draft quotes the stored Airbus letter REPAIRED (four paragraphs, no fence / JSON / chatter)',
        res.statusCode === 200 && prompts.length === 1 && !/```|Here is the JSON|"cover_letter"|I have completed the cover letter/.test(quoted)
          && quoted.trim().split('\n\n').length === 4 && (quoted.match(/Thank you for your consideration/g) || []).length === 1, { status: res.statusCode, paras: quoted.trim().split('\n\n').length });
      ok('…and the stored row is not rewritten (a copy is served)', row.payload.coverLetterHtml === STORED);
      const clean = format(L4, {});
      row = rowOf(clean);
      prompts.length = 0;
      res = mkRes(); await quiet(() => LS.draftEmailBody({ user: { id: 7 }, params: { id: '15' }, headers: {}, query: {}, body: {} }, res));
      ok('…a clean letter is quoted as stored', prompts.length === 1 && /Paragraph 4 about/.test(prompts[0]) && res.statusCode === 200);
      const lsSrc = fs.readFileSync(path.join(ROOT, 'server/controllers/letterSendController.js'), 'utf8');
      const load = (lsSrc.match(/async function loadLetter\([\s\S]*?\n\}/) || [''])[0];
      // Every handler reads the letter through ONE loader: loadLetter itself, or (2026-09-20, the classic lane) loadLetterFor,
      // which is loadLetter for a saved letter and loadClassicLetter for the one a request carries — and both repair it.
      const loadFor = (lsSrc.match(/function loadLetterFor\([\s\S]*?\n\}/) || [''])[0];
      const classic = (lsSrc.match(/async function loadClassicLetter\([\s\S]*?\n\}/) || [''])[0];
      const direct = (lsSrc.match(/await loadLetter\(userId, req\.params\.id, req\)/g) || []).length;
      const viaFor = (lsSrc.match(/await loadLetterFor\(userId, req\)/g) || []).length;
      ok('every Send handler reads the letter through loadLetter (or loadLetterFor), and every lane of it repairs the letter',
        /repairedLetterPayload\(branded\.payload\)/.test(load)
          && (direct >= 3 || (viaFor >= 3 && /loadLetter\(userId, req\.params\.id, req\)/.test(loadFor)
            && (!/loadClassicLetter\(/.test(loadFor) || /repairedLetterPayload\(\{ coverLetterHtml: html/.test(classic))))
          && (lsSrc.match(/getById\([^)]*kind: 'cover_letter'/g) || []).length === 1 && /getById\([^)]*kind: 'cover_letter'/.test(load), { direct, viaFor });
    } catch (e) {
      ok('the Send page letter read ran', false, String(e && e.stack || e));
    } finally { docsMod.getById = realGetById; aiMod.generateText = realGen; }
  }

  console.log('── 7b. the free preview lane renders no more than a letter (review round 4, 2026-09-20) ──');
  {
    // Every design of a region renders the letter the REQUEST carries, and each render reads it paragraph by paragraph
    // (bodyToHtml → repairLetterHtml) on the one Node thread. The cap is the stored letter's own (60 KB; the longest
    // letter ever stored is 7.4 KB), and it answers before anything is rendered — no browser, no AI, nothing charged.
    const mkRes = () => { const r = { statusCode: 200, body: null }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
    const big = '<p>' + 'Number one of a very long list of paragraphs. '.repeat(1600) + '</p>';
    const res = mkRes();
    await quiet(() => CL.previewCoverLetterTemplates({ user: { id: 7 }, body: { coverLetterHtml: big } }, res));
    ok('a body past 60 KB is refused before any design renders (413, nothing charged)',
      big.length > 60000 && res.statusCode === 413 && /too long to preview/i.test(res.body.error || ''), { len: big.length, status: res.statusCode, body: res.body });
    const empty = mkRes();
    await quiet(() => CL.previewCoverLetterTemplates({ user: { id: 7 }, body: { coverLetterHtml: '   ' } }, empty));
    ok('…and an empty one still answers 400, as before', empty.statusCode === 400, empty.body);
  }

  console.log('── 8. the code rules ──');
  const R = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  const cl = strip(R('server/controllers/coverLetterController.js'));
  const fn = (name) => (cl.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`)) || [''])[0];
  const wll = fn('writeLegacyLetter');
  ok('⚠️ the writer checks every parsed letter (text AND the HTML it becomes) before it returns it',
    /const problem = letterText\.letterProblem\(letter\.cover_letter\)\s*\|\| \(letterText\.looksContaminatedHtml\(formatCoverLetterWithHTML\(letter\.cover_letter, \{\}\)\)/.test(wll)
      && wll.indexOf('letterText.letterProblem(') < wll.indexOf('return { letter, model: out.model }'), wll.slice(0, 200));
  ok('…asks once more at most (LEGACY_LETTER_GATE_TRIES = 2, inside LEGACY_LETTER_TRIES = 3)', CL._internals.LEGACY_LETTER_GATE_TRIES === 2 && CL._internals.LEGACY_LETTER_TRIES === 3);
  ok('…and its ending says nothing was charged, with no err.reason (the lanes\' 402 / 503 mapping untouched)',
    /Nothing was charged/.test(CL._internals.LEGACY_LETTER_UNUSABLE) && !/err\.reason\s*=/.test(wll) && /err\.letterCheck = lastErr\.letterCheck;/.test(wll));
  ok('the parser reads each JSON object on its own, and cleans every letter', /letterText\.jsonObjectsIn\(src\)/.test(fn('parseLegacyLetterJson')) && /letterText\.cleanLetterText\(o\.cover_letter\)/.test(fn('parseLegacyLetterJson')));
  ok('⚠️ the owner\'s prompt is still ai-cover-letter-v2\'s own buildPrompt (never copied or edited here)', /letterV2\.buildPrompt\(resumeMetadata, position, url, responsibilities, jobLocation, listing\)/.test(wll) && !/cover_letter.*MUST start with the very first word/.test(cl));
  ok('the read side repairs at every door: the doc GET, the docId downloads, the Original, the cards, the designs, the Word file',
    /letterText\.repairedLetterPayload\(payload\)/.test(strip(R('server/routes/employerDocsRoutes.js')))
      && /letterText\.repairedLetterPayload\(branded\.payload\)/.test(cl)
      && /generateRichCoverLetterPDFRaw\(user,\s*typeof coverLetterHtml === 'string' \? letterText\.repairLetterHtml\(coverLetterHtml\)\.html/.test(cl)
      && /const body = letterText\.repairLetterHtml\(p\.coverLetterHtml\);/.test(strip(R('server/controllers/employerLetterController.js')))
      && /const s = repairLetterHtml\(String\(input \|\| ''\)\)\.html;/.test(strip(R('server/utils/coverLetterTemplates.js')))
      && /withLetterLines\(withRepairedBody\(data \|\| \{\}\)\)/.test(strip(R('server/utils/docxBuilder.js'))));
  ok('letterText is dependency-free (the renderers require it with no cycle through a controller)', !/require\(/.test(strip(R('server/utils/letterText.js'))));

  console.log(`\nletter json: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('TEST ERROR', e && e.stack); process.exit(2); });
