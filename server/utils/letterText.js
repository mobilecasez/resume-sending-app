// A cover letter's TEXT, made a letter and checked: the model's answer on the way in, a stored letter on the way out.
//
// ⚠️ WHY THIS EXISTS (2026-09-19, the owner: "On Customize my cover letter it started showing some json in paragraph 5,6 …
// it should never occur"). Home's Airbus letter (user_employer_documents 15, gemini-2.5-flash, grounded) came back as TWO
// JSON objects with the model's own chatter between them: JSON#1, "Rishi, I have completed the cover letter …", "Here is
// the JSON output:", then a fenced ```json JSON#2```. The parser read ONE span from the first "{" to the last "}", could not
// parse it, and its field extractor ran the letter to the closing quote of the SECOND object — so the stored letter was
// the real four paragraphs + '"\n}' + the chatter + the fence + all of JSON#2 (its letter again): nine cards on Customize,
// the same junk in the PDF and the Word file, and the unit charged. Three pieces keep it from happening again:
//   • jsonObjectsIn — every balanced {…} of an answer, found string-aware, so each object is parsed on its own
//     (coverLetterController.parseLegacyLetterJson);
//   • cleanLetterText + letterProblem — what a model can leave INSIDE the letter (code fences, JSON lines, "Here is the
//     JSON output:", markdown headings and rules, "PARAGRAPH 1:" labels, a paragraph written twice — or nearly twice,
//     isNearDuplicate) comes out, and a letter
//     that still carries any of it is refused BEFORE it is stored or charged (writeLegacyLetter asks once more, then fails
//     saying nothing was charged);
//   • repairLetterHtml — a letter already STORED with that junk is repaired wherever it is read (the editor, the thumbnails,
//     the PDF and Word downloads). It acts only on a strong signal, and a clean letter comes back as the very same string.
// ⚠️ NEVER A LETTER'S OWN WORDS. Every rule is measured against all 161 letters stored in production (2026-09-19): only the
// Airbus letter (and the download that froze it) changes. "XML/JSON" in a sentence, "I have completed over 40 projects …",
// "Here is what I would bring …:", "Let me know when we can talk" and a one-<p> letter of <br> lines all stay as written —
// and so does a closing that only SOUNDS like the model ("I hope this cover letter shows …", "Please let me know … as
// requested", "… in the requested format."): a chatter-shaped line goes only next to the answer's JSON, in a letter that
// carries the JSON, or where it wraps the letter from outside — its first line or its last (chatterJunkIn).
// ⚠️ MIRRORED in MobileApp/services/letterHtml.ts (splitLetterParagraphs' backstop): change a rule in both.
// Pure and dependency-free, so the renderers (coverLetterTemplates, docxBuilder) require it without a cycle through the
// controller.
'use strict';

/**
 * Folded into a REPAIRED letter's thumbnail key (employerLetterController.letterCardsFor) — and only a repaired one's, so
 * every clean letter keeps its cached cards. Bump it when the repair changes what a stored letter reads as.
 */
const LETTER_REPAIR_REV = 'lj1';

/** Past these it is not a letter any more (ai-cover-letter-v2 asks for 4 paragraphs, 300–450 words). */
const MAX_PARAGRAPHS = 8;
const MAX_LINE_CHARS = 2500;
const MAX_WORDS = 1000;
/** …and short of these it is not one yet (see letterProblem: production's shortest letter is 252 words in 4 paragraphs). */
const MIN_WORDS = 120;
const MIN_LINES = 2;
/**
 * Two paragraphs this long are one paragraph written twice when a later one is said already inside an earlier one, or is
 * made (NEAR_DUP_OVERLAP of it) of paragraphs kept above — never merely because it QUOTES an earlier one (repeatsKept).
 */
const DUP_MIN_CHARS = 60;
/**
 * …and so are two that are NEARLY the same (review round 3, 2026-09-20): NEAR_DUP_OVERLAP of their words shared
 * (Jaccard). The Airbus answer with one literal `"` in its first copy ("a 27" monitor") came back as the letter + the
 * second copy's first paragraph WITHOUT that quote (0.99 of its words) — not the same text, neither holding the other, so
 * it was stored, charged and served as a fifth paragraph. Measured on all 158 letters stored in production (2026-09-20):
 * two DIFFERENT paragraphs of one letter share at most 0.32 of their words.
 * ⚠️ NO "SAME OPENING" RULE (review round 4, 2026-09-20). Round 3 also called two paragraphs with the same first 12 words
 * one paragraph, whatever the rest said — and a letter's own parallel paragraphs have exactly that: "In my role as Project
 * Manager at METASYS SOFTWARE PVT. LTD. in Indore, I directed …" / "… I also led …" (0.28 of their words shared), the same
 * in German ("Während meiner Tätigkeit als Projektleiter bei der Siemens AG in München von 2019 bis 2022 habe ich …") or
 * Hindi. The second one was cut from the letter before it was stored and charged, from every read of a stored letter, and
 * from the app's cards (then from the row, with the next save). No real case needed it: the Airbus near-copy is caught by
 * the words alone.
 */
const NEAR_DUP_OVERLAP = 0.85;
/**
 * ⚠️ …AND ONLY BETWEEN TWO PARAGRAPHS OF PROSE (review round 5, 2026-09-20). A word SET is the right test for prose and
 * the wrong one for the short structured blocks a letter legitimately writes twice: a letterhead at the top and the
 * signature at the bottom carry the same name, street, city, e-mail and phone — every word but "Sincerely," — so the
 * SIGNATURE was deleted (by the word sets, and by "made of earlier paragraphs": it IS "Sincerely," plus the letterhead,
 * 0.88 of its characters) before the letter was stored and charged, on every read of a
 * stored one and from the app's cards (and then from the row, with the next save). Measured over the 604 paragraphs of
 * all 152 letters stored in production (2026-09-20): the shortest is 22 words, one in a hundred is under 25, and two
 * DIFFERENT paragraphs of one letter share at most 0.26 of their words. So a floor here costs the real near-copy nothing
 * (the Airbus one is ~200 words) and spares every address block. An exact copy is still an exact copy at any length.
 */
const NEAR_DUP_MIN_WORDS = 25;
/**
 * ⚠️ PAST THIS MANY PARAGRAPHS, EXACT COPIES ONLY (review round 4, 2026-09-20). The near-copy test compares a paragraph
 * with every one kept before it, so its cost grows with the SQUARE of what a request sends: a free preview
 * (POST /api/cover-letter/preview-templates) of 853 short <p> held the server's one thread for 13 s per template, a
 * megabyte for tens of minutes. No letter has this many paragraphs (the writer's gate allows MAX_PARAGRAPHS); past it a
 * text's paragraphs are checked against a Set — linear, whatever it sends.
 */
const NEAR_DUP_MAX_PARAGRAPHS = 3 * MAX_PARAGRAPHS;

// A straight double quote as a model writes it, or as stored HTML can spell it.
const Q = '(?:"|&quot;|&#0*34;|&#x0*22;)';
/** ai-cover-letter-v2's answer keys (and the camelCase spelling a model sometimes uses). */
const LETTER_KEYS = 'to|employer_name|position|addresses|subject|cover_letter|coverLetter';

// ── the line rules — each reads ONE line of the letter's TEXT (tags stripped, entities decoded, trimmed) ──
const FENCE_RE = /^```/;
/** A line that is only JSON punctuation: "{", "}", "],", "}]" (a stray closing quote before it too). */
const BRACE_LINE_RE = /^"?\s*[{}[\]](?:\s*[{}[\],])*\s*;?$/;
/** `"subject": …` at the start of a line — a key of the answer's JSON, never letter prose. */
const KEY_LINE_RE = new RegExp(`^"(?:${LETTER_KEYS})"\\s*:`, 'i');
/** …or anywhere in the letter, and an object opening inline: `{"to": …`. */
const KEY_ANYWHERE_RE = new RegExp(`"(?:${LETTER_KEYS})"\\s*:`);
const INLINE_OBJECT_RE = /\{\s*"[A-Za-z_]+"\s*:/;
/** The one key line whose VALUE is letter text: `"cover_letter": "With 14 years …`. */
const LETTER_KEY_LINE_RE = /^"(?:cover_letter|coverLetter)"\s*:\s*"/i;
/** A line that is only a JSON string ("1, Rond Point …",) — dropped only inside a paragraph that is JSON already. */
const JSON_STRING_LINE_RE = /^"(?:[^"\\]|\\.)*"\s*,?$/;
const HEADING_RE = /^#{1,6}\s/;
/** A markdown rule, or a banner like the prompt's own "=== PARAGRAPH 1 — … ===". */
const RULE_RE = /^(?:-{3,}|\*{3,}|_{3,}|={3,}(?:.*={3,})?)$/;
/** A line that only NAMES what follows: "Cover Letter:", "**JSON**", "Paragraph 2". */
const LABEL_LINE_RE = /^(?:\*\*)?\s*(?:(?:the\s+|your\s+|final\s+)?cover\s+letter(?:\s+(?:for|to)\s+[^:]{1,80})?|letter|json(?:\s+output)?|output|response|answer|paragraph\s*\d+)\s*(?:\*\*)?\s*:?\s*(?:\*\*)?$/i;
/**
 * "PARAGRAPH 1: …", "**Paragraph 2:** …", "<strong>Paragraph 3 (Value):</strong> …" — the label goes, the paragraph stays.
 * A separator is required, so "Paragraph 1 about Node.js …" (a sentence) is never touched. Reads the raw line too.
 */
const PARA_LABEL_RE = /^\s*(?:\*\*|<(?:strong|b)>)?\s*paragraph\s*\d+\s*(?:\([^)]{0,60}\)\s*)?(?:[:.\-—–]|(?=\*\*|<\/(?:strong|b)>))\s*(?:\*\*|<\/(?:strong|b)>)?\s*(?:[:.\-—–]\s*)?/i;

// ── the model talking ABOUT its answer. Only short lines, and only about the output or the letter: a letter's own sentence
// that merely starts the same way ("Here is what I would bring …:", "I have completed over 40 projects …") stays. ──
// ⚠️ A CHATTER LINE IS NEVER JUNK ON ITS OWN WORDS (review, 2026-09-19). The shape below also fits a letter's own closing —
// "I hope this cover letter shows why I would be a strong fit …", "Please let me know if you need anything further; my
// portfolio is attached as requested.", "Recently, I have completed the draft …" — and treated alone as junk it cut those
// paragraphs out of letters that were then stored and charged, out of every read of a stored letter, and out of what a
// user had just typed on Customize. So a chatter line goes ONLY when the letter itself shows it stands outside the letter
// (chatterJunkIn): it touches the answer's JSON (the line after it OPENS a fence / "{" / "[", or the line before it CLOSES
// one), it introduces nothing (a line ending in ":" at the very start or end of the letter, or right before a paragraph
// the letter already has), it names the answer's format in a letter that CARRIES the answer's JSON, or it wraps the
// letter — the model opening its answer as the letter's first line, or signing off as its last. Anything else stays as
// written — the writer, every read and the app alike.
// ⚠️ ROUND 2 (review, 2026-09-19) — both ways:
//   • "names the format" was still a words-only rule: "Please let me know if you would like my certificates in the
//     requested format." (a user's own closing on Customize) was cut from every read and, with the next save of any field,
//     from the row for good; a model letter ending "… sample API contracts in JSON format." was stored and charged without
//     it. It now counts only in a letter that carries the JSON too (a fence, a key or a brace line) — the Airbus letter
//     does; a clean letter never loses a sentence to it. A line ENDING ":" that names the format is still an introducer.
//   • the model's wrapper INSIDE cover_letter passed the gate and was stored and charged as a card: "Sure! Here is the
//     cover letter you asked for." / "Certainly! Below is the tailored cover letter." first, "I hope this helps!" last.
//     Those go now — by POSITION (the letter's first / last line) and only in the shapes a letter never has there: an
//     opener that is "Sure!" alone, or "Sure/Certainly/Of course …" or "Here is / Below is …" ABOUT the letter in the
//     model's words ("the / your / a … letter" — never "Here is my cover letter for …", which an applicant writes), and a
//     sign-off "I hope this helps" / "Good luck with your application". AFTERWORD closings ("I hope this cover letter
//     shows …", "Please let me know … as requested") stay the letter's own, as round 1 decided.
const CHATTER_MAX_CHARS = 240;
const PREAMBLE_RE = /^(?:\*\*)?(?:here(?:'s|’s| is| are)|below (?:is|are)|sure|certainly|of course|okay|ok|absolutely)\b/i;
const SURE_RE = /^(?:\*\*)?(?:sure|certainly|of course|okay|ok|absolutely)\b/i;
const DONE_RE = /^(?:[A-Z][\w'’-]{0,30},\s*)?I(?:'ve|’ve| have) (?:now |just )?(?:completed|written|drafted|prepared|generated|created|finished|crafted|composed|updated|revised)\b/i;
const AFTERWORD_RE = /^(?:\*\*)?(?:let me know|please let me know|feel free|i hope this|note:)/i;
/**
 * The model signing off: "I hope this helps!", "Hope it helps.", "Good luck with your application!" — never a letter's last
 * words. "helps" must END the clause: "I hope this helps explain why I fit the role." is an applicant's sentence.
 */
const HELPS_RE = /^(?:\*\*)?(?:(?:i )?hope (?:this|it|that) helps(?=\s*(?:[!.,;:)]|\*\*|$))|(?:good|best of) luck with (?:your|the|this) application\b)/i;
/** The model opening its answer with nothing else: "Sure!", "Certainly.", "**Absolutely!**". */
const BARE_SURE_RE = /^(?:\*\*)?(?:sure|certainly|of course|okay|ok|absolutely)\s*[!.,]*\s*(?:\*\*)?$/i;
const HERE_RE = /^(?:\*\*)?(?:here(?:'s|’s| is| are)|below (?:is|are))\b/i;
/** The letter in the MODEL's words — "the cover letter", "your tailored letter", "a cover letter" — never "my cover letter". */
const MODEL_LETTER_RE = /\b(?:the|your|a|an)\s+(?:[\w'’-]+\s+){0,4}?(?:cover\s+letter|letter)\b/i;
/**
 * …and the half of it that is only ever the model: a COVER letter in the model's words. ⚠️ "Here is / Below is" + the bare
 * word "letter" is NOT enough (review round 5, 2026-09-20): an applicant answering a recruiter opens "Here is the letter
 * of interest you asked me for on Tuesday …", and that first paragraph was deleted from the stored letter, the PDF, the
 * Word file and the cards. "Here is the cover letter you asked for." / "Below is your tailored cover letter." still go,
 * and a bare-"letter" opener that ENDS in a colon is still an introducer with nothing to introduce (chatterJunkIn).
 */
const MODEL_COVER_LETTER_RE = /\b(?:the|your|a|an)\s+(?:[\w'’-]+\s+){0,4}?cover\s+letter\b/i;
const ABOUT_FORMAT_RE = /\b(?:json|output|as requested|requested format)\b/i;
const ABOUT_LETTER_RE = /\b(?:cover letter|the letter|your letter|the draft|this draft)\b/i;
const JSON_FORMAT_RE = /\b(?:json output|json format|in json)\b/i;
/** A chatter line that introduces what follows ("Here is your cover letter:"). */
const INTRODUCER_RE = /:\s*(?:\*\*)?$/;
/**
 * A chatter line that ENDS by naming the answer's format — "Here is the JSON output:", "Here's the JSON:", "… the cover
 * letter in JSON format." — never "Here is how I used JSON schemas …" or "… parsers that emit data in JSON format for 40
 * partners." (the JSON there is the candidate's work, and the line does not end on it).
 */
const FORMAT_TAIL_RE = /\b(?:(?:the|this|your|in|as)\s+json(?:\s+(?:output|format|object|response|version|block))?|(?:the|in the|in a)\s+requested\s+format)\s*(?:below)?\s*[:.!]?\s*(?:\*\*)?$/i;

/** Is this line SHAPED like the model talking about its answer? Only a shape: see chatterJunkIn for when it is junk. */
function isChatter(line) {
  const s = String(line == null ? '' : line).trim();
  if (!s || s.length > CHATTER_MAX_CHARS) return false;
  if (HELPS_RE.test(s)) return true;
  if (PREAMBLE_RE.test(s)) {
    const colon = /:\s*(?:\*\*)?$/.test(s);
    if (ABOUT_FORMAT_RE.test(s) && (colon || s.length <= 120)) return true;
    if (ABOUT_LETTER_RE.test(s) && (colon || SURE_RE.test(s))) return true;
    return false;
  }
  if (DONE_RE.test(s)) return ABOUT_LETTER_RE.test(s) || JSON_FORMAT_RE.test(s);
  if (AFTERWORD_RE.test(s)) return ABOUT_LETTER_RE.test(s) || ABOUT_FORMAT_RE.test(s);
  return false;
}

/**
 * Chatter that names the answer's format ("I have written …" only about the letter itself). Only a shape: junk in a letter
 * that carries the answer's JSON, or ending ":" with nothing to introduce (chatterJunkIn) — never on its words alone.
 */
function namesFormat(line) {
  const s = String(line == null ? '' : line).trim();
  return isChatter(s) && FORMAT_TAIL_RE.test(s) && (!DONE_RE.test(s) || ABOUT_LETTER_RE.test(s));
}

/**
 * The model OPENING its answer — junk only as the letter's FIRST line: "Sure!", "Certainly! Below is the cover letter.",
 * "Rishi, I have completed the cover letter for the Cyber Security Manager position at Airbus." (handsToUser).
 */
function opensAnswer(line) {
  const s = String(line == null ? '' : line).trim();
  if (!s || s.length > CHATTER_MAX_CHARS) return false;
  if (BARE_SURE_RE.test(s)) return true;
  if (SURE_RE.test(s)) return ABOUT_LETTER_RE.test(s) || MODEL_LETTER_RE.test(s);
  if (handsToUser(s)) return true;
  return HERE_RE.test(s) && MODEL_COVER_LETTER_RE.test(s);
}

/**
 * …and SIGNING OFF — junk only as the letter's LAST line: "I hope this helps!", "Good luck with your application!",
 * "Rishi, I have completed the cover letter …".
 */
function closesAnswer(line) {
  const s = String(line == null ? '' : line).trim();
  if (!s || s.length > CHATTER_MAX_CHARS) return false;
  return HELPS_RE.test(s) || handsToUser(s);
}

/**
 * ⚠️ THE DOC-15 WRAPPER ITSELF (review round 5, 2026-09-20): "Rishi, I have completed the cover letter for the Cyber
 * Security Manager position at Airbus." — the very sentence in fixtures/letter-doc15-raw.txt — is chatter-SHAPED but was
 * junk in no position: it wraps nothing (it is neither an opener nor a sign-off), it introduces nothing (no colon), and
 * the "names the format" arm needs the answer's JSON beside it. So when the model wrote it INSIDE cover_letter, with the
 * JSON nowhere near, it passed the gate, was stored, charged, printed in the PDF and the Word file and e-mailed to the
 * recruiter — the model addressing the user by name in their own letter. It goes now by POSITION, like the other
 * wrappers: "I have completed / written / drafted / generated …" + the letter in the MODEL's words (MODEL_LETTER_RE —
 * never "my cover letter", never "this cover letter"), as the letter's first line or its last. An applicant's own
 * closing ("I hope this cover letter shows …", "I have prepared this cover letter for your team") is untouched.
 */
function handsToUser(s) {
  return DONE_RE.test(s) && MODEL_LETTER_RE.test(s);
}

/** A line of only JSON punctuation → does it OPEN a block ("{", "[", "},{"), CLOSE one ("}", "],", "}]"), or both? */
function braceSides(t) {
  const b = t.replace(/[^{}[\]]/g, '');
  return { open: /[{[]$/.test(b), close: /^[}\]]/.test(b) };
}

/**
 * THE CHATTER RULE (see the ⚠️ above): which chatter-shaped lines of a letter are the model talking — a Set of
 * "paragraph:line" keys. `paras` = the letter's paragraphs, each an array of its line TEXTS (tags stripped, trimmed); a
 * paragraph the line rules never touch (a list) is passed as one non-empty line, so it is letter text to its neighbours.
 * Blank lines, other chatter and markdown labels are skipped when a line looks for its neighbours.
 */
function chatterJunkIn(paras) {
  const flat = [];
  const repeats = repeatsKept(paras.length);
  const dupAt = new Set();   // paragraphs that repeat an earlier one
  paras.forEach((lines, p) => {
    const inJson = lines.some((t) => FENCE_RE.test(t) || BRACE_LINE_RE.test(t) || KEY_LINE_RE.test(t));
    const key = normKey(lines.join('\n'));
    if (key && repeats(key)) dupAt.add(p);
    lines.forEach((t, i) => flat.push({ p, i, t, inJson }));
  });
  // A fence OPENS when it names a language or starts a block with lines after it; it CLOSES an open block, or ends the text.
  let inFence = false;
  // The last line with text: "a line with text after k" is k < lastText (not a copy of the rest per fence — quadratic).
  let lastText = -1;
  flat.forEach((y, k) => { if (y.t) lastText = k; });
  flat.forEach((x, k) => {
    const t = x.t;
    let kind = 'text';
    if (!t) kind = 'blank';
    else if (FENCE_RE.test(t)) {
      const opens = /^```\s*[A-Za-z]/.test(t) || (!inFence && k < lastText);
      inFence = opens;
      kind = opens ? 'open' : 'close';
    } else if (BRACE_LINE_RE.test(t)) {
      const s = braceSides(t);
      kind = s.open && s.close ? 'both' : s.open ? 'open' : s.close ? 'close' : 'json';
    } else if (KEY_LINE_RE.test(t) || (x.inJson && JSON_STRING_LINE_RE.test(t))) kind = 'json';
    else if (isChatter(t) || opensAnswer(t)) kind = 'chatter';
    else if (RULE_RE.test(t) || HEADING_RE.test(t) || LABEL_LINE_RE.test(t)) kind = 'label';
    x.kind = kind;
  });
  // Does the letter carry the answer's JSON anywhere (a fence, a brace line, a key line, a key inline)?
  const carriesJson = flat.some((x) => x.kind === 'open' || x.kind === 'close' || x.kind === 'both' || x.kind === 'json' || KEY_ANYWHERE_RE.test(x.t));
  const firstLineOf = new Map();
  flat.forEach((x, k) => { if (x.kind !== 'blank' && !firstLineOf.has(x.p)) firstLineOf.set(x.p, k); });
  const passes = (x) => x.kind === 'blank' || x.kind === 'chatter' || x.kind === 'label';
  // Each line's nearest neighbour that does not pass, before and after — one sweep each way. (A walk from every chatter
  // line through its passing neighbours was quadratic in a run of them: 'Sure!\n' × 3,000 took a second.)
  const prevAt = new Array(flat.length);
  const nextAt = new Array(flat.length);
  for (let k = 0, at = -1; k < flat.length; k++) { prevAt[k] = at; if (!passes(flat[k])) at = k; }
  for (let k = flat.length - 1, at = flat.length; k >= 0; k--) { nextAt[k] = at; if (!passes(flat[k])) at = k; }
  const junk = new Set();
  flat.forEach((x, k) => {
    if (x.kind !== 'chatter') return;
    const j = prevAt[k];
    const n = nextAt[k];
    const prev = j >= 0 ? flat[j] : null;
    const next = n < flat.length ? flat[n] : null;
    // An introducer about the letter itself ("Here is your cover letter:") or the answer's format ("Here is the JSON
    // output:"), not one about the candidate's work ("Here is how I used JSON schemas …:" stays wherever it stands).
    const introduces = INTRODUCER_RE.test(x.t) && (ABOUT_LETTER_RE.test(x.t) || namesFormat(x.t))
      && (!prev || !next || (dupAt.has(next.p) && firstLineOf.get(next.p) === n));
    // The wrapper: nothing of the letter before an opener, nothing after a sign-off (other chatter and labels aside).
    const wraps = (!prev && opensAnswer(x.t)) || (!next && closesAnswer(x.t));
    if ((carriesJson && namesFormat(x.t)) || introduces || wraps
      || (prev && (prev.kind === 'close' || prev.kind === 'both'))
      || (next && (next.kind === 'open' || next.kind === 'both'))) junk.add(`${x.p}:${x.i}`);
  });
  return junk;
}

// ── text helpers ──
const ENTITIES = { quot: '"', amp: '&', lt: '<', gt: '>', nbsp: ' ', apos: "'" };
/** One pass (so "&amp;quot;" is the text "&quot;"); unknown names stay as written. */
function decodeEntities(s) {
  return String(s == null ? '' : s).replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,8});/gi, (m, b) => {
    if (b[0] === '#') {
      const c = b[1] === 'x' || b[1] === 'X' ? parseInt(b.slice(2), 16) : parseInt(b.slice(1), 10);
      if (!Number.isFinite(c) || c <= 0 || c > 0x10ffff) return m;
      return c === 160 ? ' ' : String.fromCodePoint(c);
    }
    const k = b.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ENTITIES, k) ? ENTITIES[k] : m;
  });
}
/**
 * A tag is `<` … `>` with NO other `<` inside. ⚠️ LINEAR ON PURPOSE (review, 2026-09-20): `/<[^>]*>/g` rescans to the end
 * of the text from every `<` that has no `>` after it — '<'.repeat(60000) held the event loop for 30 s, and a classic
 * letter (letterSendController, /classic/…) arrives from the client. A stray `<` in a letter's text is text anyway.
 */
const TAG_RE = /<[^<>]*>/g;
const textOfHtml = (h) => decodeEntities(String(h == null ? '' : h).replace(TAG_RE, ''));
const textOfText = (t) => String(t == null ? '' : t);
/** A paragraph's words, for "is this the same paragraph": no markup, no bold stars, no quotes, one-spaced, lower case. */
const normKey = (t) => String(t).replace(/\*\*/g, '').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
/** A normKey's words, punctuation off their ends ("years," "years" alike). No \p{…}: the app's mirror runs on Hermes. */
// ⚠️ Trimmed by a walk from each end, not `/^[^X]+|[^X]+$/g`: that regex tried `[^X]+$` from every character of a
// punctuation run inside a word and rescanned it each time — quadratic ('a' + '!' × 10,000 + 'a' took seconds). Same
// characters, same code units (no u flag there either).
const WORD_CHAR_RE = new RegExp('[A-Za-z0-9\\u00C0-\\u1FFF\\u2070-\\uFFFF]');
function trimWordEdges(w) {
  let a = 0;
  let b = w.length;
  while (a < b && !WORD_CHAR_RE.test(w[a])) a++;
  while (b > a && !WORD_CHAR_RE.test(w[b - 1])) b--;
  return a === 0 && b === w.length ? w : w.slice(a, b);
}
const wordsOfKey = (key) => key.split(' ').map(trimWordEdges).filter(Boolean);
const wordSetOf = (key) => new Set(wordsOfKey(key));
/** The share of their words two word sets have in common (Jaccard). */
function overlapOf(sa, sb) {
  let both = 0;
  sa.forEach((w) => { if (sb.has(w)) both++; });
  const all = sa.size + sb.size - both;
  return all > 0 ? both / all : 0;
}
/** Two normKeys (both DUP_MIN_CHARS+) that are one paragraph written twice with an edit: see NEAR_DUP_OVERLAP. */
const isNearDuplicate = (a, b) => overlapOf(wordSetOf(a), wordSetOf(b)) >= NEAR_DUP_OVERLAP;
/** How much of a text `len` long the spans [from, to) cover, as a share (the spans may overlap). */
function coveredShare(spans, len) {
  if (!spans.length || !len) return 0;
  spans.sort((x, y) => x[0] - y[0]);
  let covered = 0;
  let end = 0;
  for (const [from, to] of spans) {
    if (to <= end) continue;
    covered += to - Math.max(from, end);
    end = to;
  }
  return covered / len;
}
/**
 * "Is this a paragraph the letter has already?" for a letter of `count` paragraphs, asked of each paragraph in order:
 * true when `key` (a normKey) repeats one asked before — otherwise it is remembered and the answer is false. A repeat is
 *   • the same paragraph;
 *   • (both DUP_MIN_CHARS+) said already, word for word, inside an earlier paragraph that is NEARLY ALL of it
 *     (NEAR_DUP_OVERLAP of its characters) — the same paragraph with a stray `}` or quote left on it;
 *   • a near-copy of an earlier one (NEAR_DUP_OVERLAP of their words: isNearDuplicate), both of them prose
 *     (NEAR_DUP_MIN_WORDS);
 *   • MADE of earlier paragraphs (they cover NEAR_DUP_OVERLAP of it): the letter again as one block, a paragraph with a
 *     stray `}` after it.
 * ⚠️ NOT a paragraph that merely QUOTES an earlier one (review round 4, 2026-09-20). A headline paragraph "Certified Scrum
 * Master and PMP with fourteen years in enterprise software delivery" and, further down, "As a Certified Scrum Master and
 * PMP with fourteen years in enterprise software delivery, I have run programmes of up to forty engineers …" are two
 * paragraphs; "one holding the other" dropped the later, LONGER one — every achievement in it — from the letter the writer
 * stored and charged, and (once round 3 made it the read side's signal too) from every read of a stored letter.
 * ⚠️ NOR A PARAGRAPH ONE SENTENCE OF WHICH AN EARLIER ONE ALREADY SAYS (review round 5, 2026-09-20). "One holding the
 * other" was round 4's own false positive read the other way round: a closing the user typed on Customize —
 * "I am available to start within four weeks and can relocate to Munich at my own expense." — repeating word for word a
 * sentence that ends an earlier paragraph was cut from the stored letter, from the PDF, the Word file and the cards. It
 * counts now only when the earlier paragraph is NEARLY ALL of it (NEAR_DUP_OVERLAP of its characters), which is the
 * shape the rule was written for: the same paragraph with a stray `}` or a closing quote left on one of the two.
 * Each paragraph's words are read ONCE; past NEAR_DUP_MAX_PARAGRAPHS only exact copies count (a Set: linear).
 */
function repeatsKept(count) {
  const exact = new Set();
  const long = [];   // { key, words, prose } of the paragraphs kept so far that are DUP_MIN_CHARS+ long
  const fuzzy = count <= NEAR_DUP_MAX_PARAGRAPHS;
  return (key) => {
    if (exact.has(key)) return true;
    exact.add(key);
    if (!fuzzy || key.length < DUP_MIN_CHARS) return false;
    const list = wordsOfKey(key);
    const words = new Set(list);
    const prose = list.length >= NEAR_DUP_MIN_WORDS;
    const held = [];
    for (const s of long) {
      if ((key.length >= NEAR_DUP_OVERLAP * s.key.length && s.key.includes(key))
        || (prose && s.prose && overlapOf(s.words, words) >= NEAR_DUP_OVERLAP)) return true;
      if (!prose || !s.prose) continue;   // "made of earlier paragraphs" is a prose test too: see NEAR_DUP_MIN_WORDS
      const at = key.indexOf(s.key);
      if (at >= 0) held.push([at, at + s.key.length]);
    }
    if (coveredShare(held, key.length) >= NEAR_DUP_OVERLAP) return true;
    long.push({ key, words, prose });
    return false;
  };
}
const quotesIn = (t) => (String(t).match(/"/g) || []).length;
/** The markup a letter HTML is written in; without any of it a letter is plain text (coverLetterTemplates.bodyToHtml's test). */
const MARKUP_RE = /<(p|br|div|strong|em|ul|li)\b/i;
/** Block markup the line rules never reach into: a list or a table in a letter is left exactly as it is. */
const BLOCK_MARKUP_RE = /<\/?(?:ul|ol|li|div|table|tr|td|h[1-6]|blockquote|section|article)\b/i;
/** A list or a table: its text is never read as paragraphs, whatever else the chunk around it holds (repairOnce). */
const LIST_MARKUP_RE = /<\/?(?:ul|ol|li|table|tr|td)\b/i;
/** …while these only CONTAIN a paragraph: the run of tags stays as it is and the text between them is read (repairOnce). */
const CONTAINER_TAGS_RE = /((?:<\/?(?:div|h[1-6]|blockquote|section|article)\b[^<>]*>\s*)+)/i;
/** A paragraph container left holding nothing once its one paragraph was dropped (repairOnce). */
const EMPTY_CONTAINER_RE = /<(div|h[1-6]|blockquote|section|article)\b[^<>]*>\s*<\/\1\s*>/gi;

const LETTER_VALUE_PREFIX_RE = new RegExp(`^[\\s\\S]*?${Q}(?:cover_letter|coverLetter)${Q}\\s*:\\s*${Q}`, 'i');
// `(?:\s*,)?\s*$`, not `\s*,?\s*$`: two \s* side by side retry every split of a whitespace run — quadratic (see TAG_RE).
const TRAILING_QUOTE_RE = new RegExp(`${Q}(?:\\s*,)?\\s*$`, 'i');
const LEADING_QUOTE_RE = new RegExp(`^(\\s*)${Q}`, 'i');

/**
 * One line → the line to keep (its own raw markup when nothing in it changes), a shorter line (a label or a key taken off
 * the front) or null (drop it). `text` is the line's text; `inJson` says its paragraph is JSON already; `chatterJunk`
 * that chatterJunkIn named this line (a chatter-shaped line it did not name is the letter's own and stays).
 */
function cleanLine(raw, text, inJson, textOf, chatterJunk) {
  const t = text.trim();
  if (!t) return raw;
  if (FENCE_RE.test(t) || BRACE_LINE_RE.test(t) || RULE_RE.test(t) || HEADING_RE.test(t) || LABEL_LINE_RE.test(t) || chatterJunk) return null;
  if (KEY_LINE_RE.test(t)) {
    if (!LETTER_KEY_LINE_RE.test(t)) return null;   // "to": "…", "subject": "…" — the answer's other fields
    // "cover_letter": "With 14 years … — the letter's own words (with their markup); a copy of a paragraph kept above is
    // dropped as a duplicate afterwards.
    const kept = raw.replace(LETTER_VALUE_PREFIX_RE, '');
    return kept !== raw && textOf(kept).trim() ? kept : null;
  }
  if (inJson && JSON_STRING_LINE_RE.test(t)) return null;   // an element of "addresses": [ … ]
  if (PARA_LABEL_RE.test(t)) {
    const kept = raw.replace(PARA_LABEL_RE, '');
    if (kept === raw) return raw;
    return textOf(kept).trim() ? kept : null;
  }
  return raw;
}

/**
 * The core, for text and HTML alike. `blocks` = paragraphs, each an array of { raw, sep } lines (sep = what followed the
 * line: "\n" or "<br>"). Every line rule runs, then a paragraph emptied by them goes, then a paragraph already seen goes.
 * → { kept: [{ index, inner, touched }], changed } — `inner` is the paragraph's raw, `touched` whether it was rewritten.
 * An untouched paragraph's inner is its source, byte for byte.
 */
function cleanBlocks(blocks, textOf, others = []) {
  let changed = false;
  const kept = [];
  const repeats = repeatsKept(blocks.length);
  const allTexts = blocks.map((lines) => lines.map((l) => textOf(l.raw).trim()));
  // `others` = where the units the rules never touch (a list) stand among the paragraphs: letter text to a chatter line's
  // neighbour search (chatterJunkIn), never cleaned themselves.
  const flow = allTexts.map((texts, index) => ({ texts, index }));
  others.forEach((at, k) => flow.splice(Math.min(at + k, flow.length), 0, { texts: ['·'], index: -1 }));
  const junkAt = chatterJunkIn(flow.map((f) => f.texts));
  const junk = new Set();
  flow.forEach((f, p) => { if (f.index >= 0) f.texts.forEach((_, i) => { if (junkAt.has(`${p}:${i}`)) junk.add(`${f.index}:${i}`); }); });
  blocks.forEach((lines, index) => {
    const source = lines.map((l) => l.raw + l.sep).join('');
    const texts = allTexts[index];
    const inJson = texts.some((t) => FENCE_RE.test(t) || BRACE_LINE_RE.test(t) || KEY_LINE_RE.test(t));
    let touched = false;
    let out = [];
    lines.forEach((l, i) => {
      const next = cleanLine(l.raw, texts[i], inJson, textOf, junk.has(`${index}:${i}`));
      if (next !== l.raw) touched = true;
      if (next !== null) out.push({ raw: next, sep: l.sep });
    });
    let inner = source;
    // Only a paragraph a rule rewrote is rebuilt (a JSON paragraph always is: its fence / brace / key line goes).
    if (touched) {
      // Blank lines a dropped line left at either end print nothing.
      while (out.length && !textOf(out[0].raw).trim()) out.shift();
      while (out.length && !textOf(out[out.length - 1].raw).trim()) out.pop();
      out = out.map((l, i) => (i === out.length - 1 ? { raw: l.raw, sep: '' } : l));
      // The end of a JSON string: an unmatched straight quote at the paragraph's end (or its start).
      if (out.length && quotesIn(out.map((l) => textOf(l.raw)).join('\n')) % 2 === 1) {
        const last = out[out.length - 1];
        const endless = last.raw.replace(TRAILING_QUOTE_RE, '');
        if (endless !== last.raw) out[out.length - 1] = { raw: endless, sep: '' };
        else out[0] = { raw: out[0].raw.replace(LEADING_QUOTE_RE, '$1'), sep: out[0].sep };
      }
      inner = out.map((l) => l.raw + l.sep).join('');
    }
    // Its words LINE BY LINE (review round 4, 2026-09-20): textOf(inner) deletes a <br> and glues the words either side of
    // it together ("Razorpay<br>Cut" → "razorpaycut"), so a near-copy the read-side signal and the app both see (their text
    // turns <br> into a line break) was never found here — flagged, then served unrepaired: a paragraph every download
    // printed that Customize showed no card for.
    const key = normKey((touched ? out.map((l) => textOf(l.raw)) : texts).join('\n'));
    if (!key) {
      if (normKey(textOf(source))) { changed = true; return; }   // emptied by the rules: it goes
      kept.push({ index, inner: source, touched: false });       // it was empty already: left alone
      return;
    }
    if (repeats(key)) { changed = true; return; }
    if (touched) changed = true;
    kept.push({ index, inner, touched });
  });
  return { kept, changed };
}

const linesOf = (s, splitter) => {
  const parts = String(s).split(splitter);   // splitter has ONE capture group: the separators come back in between
  const lines = [];
  for (let i = 0; i < parts.length; i += 2) lines.push({ raw: parts[i], sep: parts[i + 1] || '' });
  return lines;
};

/**
 * The model's letter text (paragraphs split by blank lines, v2's shape) with the junk out. A clean letter comes back as
 * the SAME string, byte for byte — so what is stored for it is exactly what it always was.
 */
function cleanLetterText(text) {
  const src = String(text == null ? '' : text);
  const blocks = src.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/).map((p) => p.trim()).filter(Boolean)
    .map((p) => linesOf(p, /(\n)/));
  const { kept, changed } = cleanBlocks(blocks, textOfText);
  if (!changed) return src;
  return kept.map((b) => b.inner.trim()).filter(Boolean).join('\n\n');
}

/**
 * The prompt's OWN template, echoed back instead of a letter (review, 2026-09-19): ai-cover-letter-v2's output format
 * shows `"cover_letter": "PARAGRAPH 1 text\n\nPARAGRAPH 2 text …"` and the slots "[Target Position]", "[User Full Name
 * from metadata]", "[City, Country]", "[Your Name]", "[company name]". Only those — not every bracket: the general
 * placeholder guard went with the old prompt on purpose (employerLetterController), and no stored letter holds a bracket.
 */
const TEMPLATE_PARA_RE = /^(?:\*\*)?\s*paragraph\s*\d+\s*(?:text|content|here)\b/im;
const PROMPT_SLOT_RE = /\[(?:target position|user full name[^\]\n]{0,40}|city,\s*country|your name|company name)\]/i;
/** Is this text (a letter, or a one-line field) the prompt's template rather than something written? */
const hasPromptTemplate = (t) => TEMPLATE_PARA_RE.test(String(t == null ? '' : t)) || PROMPT_SLOT_RE.test(String(t == null ? '' : t));

/**
 * THE GATE: is this letter text a letter? null = yes; else the reason — 'empty', 'code_fence', 'json', 'assistant_text',
 * 'duplicated_paragraph', 'too_many_paragraphs', 'paragraph_too_long', 'too_long', 'template', 'too_short'. Read on the
 * CLEANED text, before the letter is stored or charged. No reformatting: a letter of single line breaks is judged as it is
 * (its lines are its paragraphs).
 * ⚠️ A LOWER BOUND TOO (review, 2026-09-19): a parse that picks one object of several could hand on "Please see the letter
 * below." or the prompt's own template, and nothing here refused it. v2 asks for four paragraphs and 300–450 words; the
 * shortest letter stored in production (2026-09-19, every user_employer_documents / review_cover_letters /
 * job_cover_letters letter) is 252 words in 4 paragraphs — so fewer than MIN_WORDS words or MIN_LINES lines is not a letter.
 */
function letterProblem(text) {
  const s = String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim();
  if (!s) return 'empty';
  if (/```/.test(s)) return 'code_fence';
  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean);
  if (KEY_ANYWHERE_RE.test(s) || INLINE_OBJECT_RE.test(s) || lines.some((l) => BRACE_LINE_RE.test(l) || KEY_LINE_RE.test(l))) return 'json';
  const paras = s.split(/\n[ \t]*\n/);
  if (chatterJunkIn(paras.map((p) => p.split('\n').map((l) => l.trim()))).size) return 'assistant_text';
  const keys = paras.map(normKey).filter(Boolean);
  const repeats = repeatsKept(keys.length);
  if (keys.some(repeats)) return 'duplicated_paragraph';
  if (keys.length > MAX_PARAGRAPHS) return 'too_many_paragraphs';
  if (lines.some((l) => l.length > MAX_LINE_CHARS)) return 'paragraph_too_long';
  const words = s.split(/\s+/).length;
  if (words > MAX_WORDS) return 'too_long';
  if (hasPromptTemplate(s)) return 'template';
  if (words < MIN_WORDS || lines.length < MIN_LINES) return 'too_short';
  return null;
}

/** A letter's HTML (or plain text) as the text a reader sees: <br> a line, </p> a blank line, no tags, entities decoded. */
function htmlToLetterText(html) {
  return decodeEntities(String(html == null ? '' : html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|blockquote)\s*>/gi, '\n\n')
    .replace(TAG_RE, ''));
}

/**
 * The STRONG signal a stored letter carries the model's junk: a code fence, a key of the answer's JSON, a line that is only
 * JSON punctuation, a paragraph (60+ characters) written out twice (or nearly: isNearDuplicate), or a line THE CHATTER RULE names (chatterJunkIn — the
 * same rule the writer's gate refuses: next to the JSON, an introducer with nothing to introduce, the model's opener as
 * the first line or its sign-off as the last). Nothing weaker — a letter that merely mentions JSON is a letter, and a line
 * that only SOUNDS like the model ("I hope this cover letter shows …", "Please let me know … in the requested format.")
 * is the letter's own.
 */
function looksContaminatedHtml(html) {
  const t = htmlToLetterText(html);
  if (!t.trim()) return false;
  if (/```/.test(t) || KEY_ANYWHERE_RE.test(t)) return true;
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.some((l) => BRACE_LINE_RE.test(l) || KEY_LINE_RE.test(l))) return true;
  const paras = t.split(/\n[ \t]*\n/);
  if (chatterJunkIn(paras.map((p) => p.split('\n').map((l) => l.trim()))).size) return true;
  // A paragraph twice: the same test the repair drops it by (repeatsKept — said already inside an earlier one, a near-copy,
  // or made of earlier ones; never one that only QUOTES an earlier one). Until round 3 (2026-09-20) this was exact copies
  // only, so a stored near-copy was never even looked at.
  // ⚠️ COUNTED OVER EVERY PARAGRAPH, not just the long ones (review round 5, 2026-09-20): repeatsKept turns its near-copy
  // test OFF past NEAR_DUP_MAX_PARAGRAPHS, and cleanBlocks counts ALL the paragraphs it is given. Counting only the
  // DUP_MIN_CHARS+ ones here left a letter of 25 paragraphs with 2 long ones flagged with fuzzy matching ON and repaired
  // with it OFF: repairLetterHtml returned repaired:false, the GET route logged nothing, and the near-duplicate kept
  // printing in every download. Both sides now ask the same question of the same population.
  const keys = paras.map(normKey).filter((x) => x.length >= DUP_MIN_CHARS);
  return keys.some(repeatsKept(paras.length));
}

/**
 * A STORED letter (HTML, or plain text) → { html, repaired }. Only when looksContaminatedHtml says so; otherwise the very
 * same string comes back with repaired:false. Each <p> keeps its own opening tag and every surviving line its own markup
 * (bold stays bold); lists and other block markup are left as they are.
 *
 * ⚠️ A FIXED POINT, NOT ONE PASS (review round 5, 2026-09-20). chatterJunkIn reads a chatter line's neighbours as the
 * letter stands BEFORE cleaning, while cleanLine removes the brace / fence / label lines in the same pass — so a chatter
 * line shielded by a "{" line before it, or by a `"subject": …` line after it, is not junk on the first pass and is junk
 * on the second, which never ran. `{`, "Sure! Here is the cover letter you asked for.", the real paragraphs, `}` came
 * back from the repair with the opener still in it — served, printed in the paid PDF and the Word file and attached to
 * the recruiter's e-mail. A fuzz over 8,000 letters built from production paragraphs plus doc-15 junk found 74 such
 * letters, every one of them settled by the second pass; REPAIR_ROUNDS caps the work so a pathological input cannot loop.
 * A clean letter still costs ONE looksContaminatedHtml (~0.7 ms) and comes back as the very same string.
 */
const REPAIR_ROUNDS = 3;
function repairLetterHtml(html) {
  const s = typeof html === 'string' ? html : String(html == null ? '' : html);
  let out = s;
  for (let i = 0; i < REPAIR_ROUNDS; i++) {
    const r = repairOnce(out);
    if (!r.repaired) break;
    out = r.html;
  }
  return { html: out, repaired: out !== s };
}

/** One pass of the repair — see repairLetterHtml, which runs it to a fixed point. */
function repairOnce(html) {
  const s = typeof html === 'string' ? html : String(html == null ? '' : html);
  if (!looksContaminatedHtml(s)) return { html: s, repaired: false };
  if (!MARKUP_RE.test(s)) {
    const t = cleanLetterText(s);
    return { html: t, repaired: t !== s };
  }
  // Units: every <p …>…</p>, and the loose runs between them (each split into its paragraphs on <br><br> / a blank line).
  const units = [];   // { pre, inner, post, cleanable }
  // Every <p …>…</p>: an opening tag, then the FIRST </p> after it. ⚠️ Two linear scans, not one lazy regex
  // (`(<p\b[^>]*>)([\s\S]*?)(<\/p\s*>)` read to the end of the text from every <p that has no </p> after it — quadratic on
  // a client's letter, see TAG_RE). When no </p> follows an opening tag, none follows any later one: the loop ends there.
  const P_OPEN_RE = /<p\b[^<>]*>/gi;
  const P_CLOSE_RE = /<\/p\s*>/gi;
  // ⚠️ A CONTAINER IS NOT A LIST (review round 5, 2026-09-20). Marking the WHOLE chunk untouchable as soon as it held any
  // block markup made a letter written in <div>s (or <h2>s, or <blockquote>s) instead of <p>s one non-cleanable unit: the
  // repair returned repaired:false on a letter looksContaminatedHtml had just flagged, and the ```json, the "cover_letter"
  // line and the model's chatter were served, printed in the paid download and attached to the Send e-mail — while the
  // app's own splitCards read those same <div>s as cards and dropped the junk, so the screen and the file disagreed about
  // what the letter said. A list or a table still passes through byte for byte; a paragraph CONTAINER's tags do too, and
  // the letter text between them is read as paragraphs, exactly as the app reads it (LIST_MARKUP_RE / CONTAINER_TAGS_RE).
  const paragraphsOf = (chunk) => {
    const parts = chunk.split(/((?:<br\s*\/?>\s*){2,}|\n[ \t]*\n)/i);
    for (let i = 0; i < parts.length; i += 2) units.push({ pre: '', inner: parts[i], post: parts[i + 1] || '', cleanable: true });
  };
  const loose = (chunk) => {
    if (!chunk) return;
    if (!chunk.trim() || LIST_MARKUP_RE.test(chunk)) { units.push({ pre: chunk, inner: '', post: '', cleanable: false }); return; }
    if (!BLOCK_MARKUP_RE.test(chunk)) { paragraphsOf(chunk); return; }
    const parts = chunk.split(CONTAINER_TAGS_RE);   // [text, tags, text, tags, … ] — one capture group
    for (let i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      if (i % 2) units.push({ pre: parts[i], inner: '', post: '', cleanable: false });
      else paragraphsOf(parts[i]);
    }
  };
  let last = 0;
  let m;
  while ((m = P_OPEN_RE.exec(s))) {
    P_CLOSE_RE.lastIndex = m.index + m[0].length;
    const c = P_CLOSE_RE.exec(s);
    if (!c) break;
    const inner = s.slice(m.index + m[0].length, c.index);
    loose(s.slice(last, m.index));
    units.push({ pre: m[0], inner, post: c[0], cleanable: !BLOCK_MARKUP_RE.test(inner) });
    last = c.index + c[0].length;
    P_OPEN_RE.lastIndex = last;
  }
  loose(s.slice(last));

  const cleanable = units.map((u, i) => ({ u, i })).filter((x) => x.u.cleanable);
  // A list (or other block the rules leave alone) is still letter text between two paragraphs: where each one stands.
  const others = [];
  let before = 0;
  for (const u of units) {
    if (u.cleanable) before++;
    else if (textOfHtml(u.pre + u.inner + u.post).trim()) others.push(before);
  }
  const { kept, changed } = cleanBlocks(cleanable.map((x) => linesOf(x.u.inner, /(<br\s*\/?>|\n)/i)), textOfHtml, others);
  if (!changed) return { html: s, repaired: false };
  const keptAt = new Map(kept.map((k) => [cleanable[k.index].i, k]));
  let out = units.map((u, i) => {
    if (!u.cleanable) return u.pre + u.inner + u.post;
    const k = keptAt.get(i);
    return k ? u.pre + k.inner + u.post : '';
  }).join('');
  // A container whose only paragraph was junk prints an empty block: `<div>{</div>` must leave nothing, not `<div></div>`.
  out = out.replace(EMPTY_CONTAINER_RE, '');
  // A loose paragraph whose followers all went keeps its <br><br> after it: the letter did not end in one, so neither does this.
  if (!/(?:<br\s*\/?>|\s)$/i.test(s)) out = trimTrailingBreaks(out);
  return { html: out, repaired: out !== s };
}

/**
 * `out.replace(/(?:\s*<br\s*\/?>)+\s*$/i, '')` — trailing <br>s (and the whitespace around them) off the end — done from
 * the END. ⚠️ That regex was tried at every whitespace character of the text and rescanned the run each time: quadratic,
 * 18 s on a 60,000-character letter of spaces (see TAG_RE). Only when at least one <br> is there, like the regex.
 */
const TRAILING_BR_RE = /<br\s*\/?>$/i;
function trimTrailingBreaks(out) {
  let end = out.length;
  let cut = -1;
  for (;;) {
    let e = end;
    while (e > 0 && /\s/.test(out[e - 1])) e--;
    if (e === 0 || out[e - 1] !== '>') break;
    const from = out.lastIndexOf('<', e - 1);
    if (from < 0 || !TRAILING_BR_RE.test(out.slice(from, e))) break;
    end = from;
    cut = from;
  }
  if (cut < 0) return out;
  // The whitespace before the first trailing <br> goes too (the regex's leading \s*).
  let e = cut;
  while (e > 0 && /\s/.test(out[e - 1])) e--;
  return out.slice(0, e);
}

/**
 * A stored letter payload for READING: the same object when its coverLetterHtml is clean (or absent), else a copy with the
 * repaired HTML. Nothing is written back — a row heals the next time the user saves it (the editor sends what it was served).
 */
function repairedLetterPayload(payload) {
  if (!payload || typeof payload !== 'object' || typeof payload.coverLetterHtml !== 'string') return payload;
  const r = repairLetterHtml(payload.coverLetterHtml);
  return r.repaired ? { ...payload, coverLetterHtml: r.html } : payload;
}

/**
 * Every balanced top-level {…} of a model's answer, in order — string-aware, so a brace inside a JSON string does not count
 * (a quote only opens a string inside an object). An object whose quotes never balance (a literal " in the letter) is simply
 * not found here; the caller's older whole-span stages still read it.
 */
function jsonObjectsIn(text) {
  const src = String(text == null ? '' : text);
  const out = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { if (depth > 0) inStr = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; continue; }
    if (ch === '}' && depth > 0) { depth--; if (depth === 0) out.push(src.slice(start, i + 1)); }
  }
  return out;
}

module.exports = {
  LETTER_REPAIR_REV,
  MAX_PARAGRAPHS, MAX_LINE_CHARS, MAX_WORDS, MIN_WORDS, MIN_LINES, NEAR_DUP_OVERLAP, NEAR_DUP_MAX_PARAGRAPHS,
  isNearDuplicate,
  jsonObjectsIn,
  cleanLetterText,
  letterProblem,
  looksContaminatedHtml,
  repairLetterHtml,
  repairedLetterPayload,
  hasPromptTemplate,
  isChatter,
  namesFormat,
  opensAnswer,
  closesAnswer,
  chatterJunkIn,
};
