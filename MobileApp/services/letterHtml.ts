// AI Hub — new feature. Safe to delete without affecting existing app.
//
// THE LETTER EDITOR'S TWO CONVERSIONS — pure, no React Native, so a node script runs them as they are
// (MobileApp/scripts/test-letter-editor.js):
//   • the stored letter HTML  ⇄ the paragraph CARDS of /(cover-letter)/edit (splitLetterParagraphs / joinLetterParagraphs)
//   • the letter's fields (company, address, subject, greeting, closing, sender) ⇄ the payload PUT stores (withLetterFields)
//
// ⚠️ BOLD IS KEPT AS <strong>, END TO END (the owner, 2026-09-19: "if the word is bold then it should be bold too in that
// page and editable text box too"). The old editor showed a letter as one text box with **asterisks**; now each paragraph
// card SHOWS the <strong> runs bold (ContentText), its editor is the résumé's Quill box holding the same <strong> (bold in
// the box too), and Quill hands <strong> back. Nothing in between turns bold into punctuation and back.
//
// ⚠️ ONLY SAFE MARKUP LEAVES THIS FILE. Whatever the stored HTML holds — an unedited AI letter keeps
// <p style="…"> and its text is NOT escaped (coverLetterController.formatCoverLetterWithHTML), a pasted blob may hold
// anything — a card's html is cleanInline output: escaped text plus <strong>, <em> and <br> written by cleanInline itself,
// attribute-free. So it is safe to template into the editor WebView's `<div id="editor">…</div>`, "a < b" stays text, and
// typed or pasted markup can never become markup. The server's normaliseLetterHtml stays the authority on what is STORED.
//
// ⚠️ AN UNEDITED LETTER IS NEVER REWRITTEN. The cards are a VIEW of coverLetterHtml; the screen re-joins them only when a
// paragraph actually changed (added, edited, moved or removed). Saving the subject or the address sends the stored string
// back byte for byte.

export type LetterBlock = { kind: 'p' | 'list'; html: string };

/* ── ENTITIES AND ESCAPING ───────────────────────────────────────────────────────────────────────── */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', sbquo: '‚', bdquo: '„',
  ndash: '–', mdash: '—', hellip: '…', bull: '•', middot: '·',
  euro: '€', pound: '£', copy: '©', reg: '®', trade: '™', deg: '°',
  eacute: 'é', egrave: 'è', aacute: 'á', agrave: 'à', iacute: 'í', oacute: 'ó',
  uacute: 'ú', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö',
  Uuml: 'Ü', szlig: 'ß', ccedil: 'ç', ntilde: 'ñ',
};

/**
 * ONE pass, so "&amp;lt;" becomes the text "&lt;" and never "<". Numeric references (&#8217; &#x2019;) decode too;
 * unknown names stay as written. No C0 control survives (they are not letter text, and ContentText's sentinels
 * must not be forgeable through "&#1;").
 */
export function decodeEntities(s: string): string {
  return String(s == null ? '' : s).replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/gi, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!isFinite(code) || code <= 0 || code > 0x10ffff) return m;
      if (code === 160) return ' ';
      if (code < 32 && code !== 9 && code !== 10) return '';
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : m;
  });
}

export const escapeHtml = (t: string) =>
  String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ── HTML → CARDS ────────────────────────────────────────────────────────────────────────────────── */

// Elements whose CONTENT is never letter text — dropped whole, the server's LETTER_DROP_WITH_CONTENT idea. An unclosed
// one swallows the rest of the letter rather than leaking its source as words.
const DROP_WITH_CONTENT_RE =
  /<(script|style|iframe|noscript|template|textarea|title|object|svg|math|head|select)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;

/** Comments, <!doctype>/<![CDATA[…]]>/<?xml?> and the drop-with-content elements, gone. */
function stripNonText(html: string): string {
  return String(html == null ? '' : html)
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(DROP_WITH_CONTENT_RE, '')
    .replace(/<[!?][^>]*>/g, '');
}

// Whitespace plus the zero-width space / joiners, word joiner and BOM — built from code points so the source stays ASCII.
const NOT_TEXT_RE = new RegExp('[' + String.raw`\s` + String.fromCharCode(0x200b) + '-' + String.fromCharCode(0x200d)
  + String.fromCharCode(0x2060, 0xfeff) + ']+', 'g');

/** Letter text is there: tags, entities, whitespace and zero-width characters are not text. */
export function hasText(html: string): boolean {
  return decodeEntities(String(html == null ? '' : html).replace(/<[^>]*>/g, ''))
    .replace(NOT_TEXT_RE, '').length > 0;
}

/**
 * One paragraph's inline HTML, made safe: <strong>/<b> → <strong>, <em>/<i> → <em>, <br> → <br>, every other tag gone
 * (its text stays), every text run decoded once and re-escaped, open <strong>/<em> closed at the end. Source newlines are
 * HTML whitespace (the PDF prints them as a space), so they read as a space here too.
 */
export function cleanInline(html: string): string {
  const s = stripNonText(html);
  const TAG = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  const open: string[] = [];
  let out = '';
  let last = 0;
  const text = (t: string) => { out += escapeHtml(decodeEntities(t).replace(/[\t\r\n\x0b\f]+/g, ' ')); };
  let m: RegExpExecArray | null;
  while ((m = TAG.exec(s))) {
    text(s.slice(last, m.index));
    last = m.index + m[0].length;
    const name = m[1].toLowerCase();
    const tag = name === 'strong' || name === 'b' ? 'strong' : name === 'em' || name === 'i' ? 'em' : name === 'br' ? 'br' : null;
    if (!tag) continue;
    if (tag === 'br') { out += '<br>'; continue; }
    if (m[0][1] === '/') {
      const k = open.lastIndexOf(tag);
      if (k >= 0) while (open.length > k) out += `</${open.pop()}>`;
      continue;                                       // a closer with nothing open is dropped
    }
    out += `<${tag}>`;
    open.push(tag);
  }
  text(s.slice(last));
  while (open.length) out += `</${open.pop()}>`;
  return out;
}

/** A paragraph's edges: whitespace and <br>s there print nothing and would only grow blank lines. */
const trimEdges = (h: string) => h.replace(/^(?:\s|<br>)+/, '').replace(/(?:\s|<br>)+$/, '');

/** A list's inline runs go through cleanInline; its ul/ol/li stay, attribute-free, balanced. */
function cleanList(raw: string): string {
  const TAG = /<(\/?)(ul|ol|li)\b[^>]*>/gi;
  const open: string[] = [];
  let out = '';
  let last = 0;
  const text = (t: string) => { const c = cleanInline(t); out += hasText(c) ? trimEdges(c) : ''; };
  let m: RegExpExecArray | null;
  while ((m = TAG.exec(raw))) {
    text(raw.slice(last, m.index));
    last = m.index + m[0].length;
    const name = m[2].toLowerCase();
    if (m[1] === '/') {
      const k = open.lastIndexOf(name);
      if (k >= 0) while (open.length > k) out += `</${open.pop()}>`;
      continue;
    }
    out += `<${name}>`;
    open.push(name);
  }
  text(raw.slice(last));
  while (open.length) out += `</${open.pop()}>`;
  return out;
}

// The test coverLetterTemplates.bodyToHtml makes: a letter with none of these tags is PLAIN TEXT to every design
// (blank line = paragraph, newline = line break, everything escaped) — so the cards read it the same way.
const LETTER_MARKUP_RE = /<(p|br|div|strong|em|ul|li)\b/i;
const BLOCK_RE = /<(\/?)(p|div|h[1-6]|blockquote|section|article|header|footer|table|tr|td|li|ul|ol)\b[^>]*>/gi;

/* ── THE MODEL'S JUNK IN A STORED LETTER — the cards' backstop ──────────────────────────────────────────────── */

// ⚠️ MIRRORS server/utils/letterText.js (2026-09-19, the owner: "On Customize my cover letter it started showing some json
// in paragraph 5,6"). The Airbus letter was stored as its four paragraphs + '"', "}", the model's "I have completed the
// cover letter …", "Here is the JSON output:", a ```json block and the letter again — nine cards. The server now writes
// only checked letters and REPAIRS a stored one before it serves it (GET /api/employer-docs/:id); this is the same repair on
// the cards, for a letter that reaches this page any other way. The same signals, line rules and duplicate test as the
// server — change one side, change both. A clean letter's cards are returned as the very same array.
// ⚠️ ONLY THE LETTER AS SERVED — NEVER WHAT THE USER TYPES (review, 2026-09-19). quillToBlocks (a paragraph's Done) and the
// editor's own re-split after a save read the cards raw (splitLetterCards): the first version ran this backstop there, and
// a paragraph the user typed — "I hope this cover letter shows why I would be a strong fit." — came back as NO card, so
// Done deleted it and saved the letter without it. And, as on the server, a line that only SOUNDS like the model is never
// junk by itself: it goes only next to the answer's JSON, as an introducer with nothing to introduce, when it names the
// format in a letter that carries the JSON, or as the model's wrapper — its opener as the first line, its sign-off as the
// last (chatterJunkIn). ⚠️ Round 2 (review, 2026-09-19): "… in the requested format." on its own words cut a user's
// closing; "Sure! Here is the cover letter …" / "I hope this helps!" inside the letter were stored as cards. Both fixed on
// both sides (see letterText.js).
const JQ = '(?:"|&quot;|&#0*34;|&#x0*22;)';
const LETTER_KEYS = 'to|employer_name|position|addresses|subject|cover_letter|coverLetter';
const FENCE_RE = /^```/;
const BRACE_LINE_RE = /^"?\s*[{}[\]](?:\s*[{}[\],])*\s*;?$/;
const KEY_LINE_RE = new RegExp(`^"(?:${LETTER_KEYS})"\\s*:`, 'i');
const KEY_ANYWHERE_RE = new RegExp(`"(?:${LETTER_KEYS})"\\s*:`);
const LETTER_KEY_LINE_RE = /^"(?:cover_letter|coverLetter)"\s*:\s*"/i;
const LETTER_VALUE_PREFIX_RE = new RegExp(`^[\\s\\S]*?${JQ}(?:cover_letter|coverLetter)${JQ}\\s*:\\s*${JQ}`, 'i');
const JSON_STRING_LINE_RE = /^"(?:[^"\\]|\\.)*"\s*,?$/;
const HEADING_RE = /^#{1,6}\s/;
const RULE_RE = /^(?:-{3,}|\*{3,}|_{3,}|={3,}(?:.*={3,})?)$/;
const LABEL_LINE_RE = /^(?:\*\*)?\s*(?:(?:the\s+|your\s+|final\s+)?cover\s+letter(?:\s+(?:for|to)\s+[^:]{1,80})?|letter|json(?:\s+output)?|output|response|answer|paragraph\s*\d+)\s*(?:\*\*)?\s*:?\s*(?:\*\*)?$/i;
const PARA_LABEL_RE = /^\s*(?:\*\*|<(?:strong|b)>)?\s*paragraph\s*\d+\s*(?:\([^)]{0,60}\)\s*)?(?:[:.\-—–]|(?=\*\*|<\/(?:strong|b)>))\s*(?:\*\*|<\/(?:strong|b)>)?\s*(?:[:.\-—–]\s*)?/i;
const TRAILING_QUOTE_RE = new RegExp(`${JQ}\\s*,?\\s*$`, 'i');
const LEADING_QUOTE_RE = new RegExp(`^(\\s*)${JQ}`, 'i');
const CHATTER_MAX_CHARS = 240;
const DUP_MIN_CHARS = 60;
// ⚠️ A NEAR-COPY IS A COPY (review round 3, 2026-09-20): letterText's NEAR_DUP_OVERLAP / isNearDuplicate / repeatsKept,
// the same numbers and the same words (no \p{…} — Hermes). The Airbus answer with one literal `"` in its first copy was
// stored as the letter + a fifth card: the second copy's first paragraph without that quote (0.99 of its words).
// ⚠️ Round 4 (2026-09-20), both sides: round 3 also called two paragraphs with the same first 12 words one paragraph —
// which a letter's own parallel paragraphs are ("In my role as Project Manager at METASYS SOFTWARE PVT. LTD. in Indore,
// I directed …" / "… I also led …") — and a paragraph that merely QUOTES an earlier one. Both cut a real card, and the
// next save wrote the letter back without it.
const NEAR_DUP_OVERLAP = 0.85;
// ⚠️ Round 5 (2026-09-20), both sides: the word-set test and "made of earlier cards" are PROSE tests (letterText.
// NEAR_DUP_MIN_WORDS). A letterhead card at the top and the signature card at the bottom share every word but
// "Sincerely," — and the signature is literally "Sincerely," plus the letterhead — so the SIGNATURE was dropped from the
// cards, and the next save wrote the letter back without it. Production's 604 letter paragraphs are 22 words at the
// shortest, one in a hundred under 25; two different paragraphs of one letter share at most 0.26 of their words.
const NEAR_DUP_MIN_WORDS = 25;
// Past this many paragraphs only EXACT copies count, so a huge pasted letter cannot make this quadratic (letterText.
// NEAR_DUP_MAX_PARAGRAPHS = 3 × MAX_PARAGRAPHS; the suite checks the two sides hold the same number).
const NEAR_DUP_MAX_PARAGRAPHS = 24;
// ⚠️ A WALK FROM EACH END, not `/^[^X]+|[^X]+$/g` (review, 2026-09-20 — letterText.trimWordEdges, the same characters):
// that regex tried `[^X]+$` from every character of a punctuation run inside a word and rescanned the run each time, so a
// long one cost its square. The server reads letters a client sends (the Send page's classic lane); this side mirrors it.
const WORD_CHAR_RE = new RegExp('[A-Za-z0-9\\u00C0-\\u1FFF\\u2070-\\uFFFF]');
const PREAMBLE_RE = /^(?:\*\*)?(?:here(?:'s|’s| is| are)|below (?:is|are)|sure|certainly|of course|okay|ok|absolutely)\b/i;
const SURE_RE = /^(?:\*\*)?(?:sure|certainly|of course|okay|ok|absolutely)\b/i;
const DONE_RE = /^(?:[A-Z][\w'’-]{0,30},\s*)?I(?:'ve|’ve| have) (?:now |just )?(?:completed|written|drafted|prepared|generated|created|finished|crafted|composed|updated|revised)\b/i;
const AFTERWORD_RE = /^(?:\*\*)?(?:let me know|please let me know|feel free|i hope this|note:)/i;
const HELPS_RE = /^(?:\*\*)?(?:(?:i )?hope (?:this|it|that) helps(?=\s*(?:[!.,;:)]|\*\*|$))|(?:good|best of) luck with (?:your|the|this) application\b)/i;
const BARE_SURE_RE = /^(?:\*\*)?(?:sure|certainly|of course|okay|ok|absolutely)\s*[!.,]*\s*(?:\*\*)?$/i;
const HERE_RE = /^(?:\*\*)?(?:here(?:'s|’s| is| are)|below (?:is|are))\b/i;
const MODEL_LETTER_RE = /\b(?:the|your|a|an)\s+(?:[\w'’-]+\s+){0,4}?(?:cover\s+letter|letter)\b/i;
const MODEL_COVER_LETTER_RE = /\b(?:the|your|a|an)\s+(?:[\w'’-]+\s+){0,4}?cover\s+letter\b/i;
const ABOUT_FORMAT_RE = /\b(?:json|output|as requested|requested format)\b/i;
const ABOUT_LETTER_RE = /\b(?:cover letter|the letter|your letter|the draft|this draft)\b/i;
const JSON_FORMAT_RE = /\b(?:json output|json format|in json)\b/i;
const INTRODUCER_RE = /:\s*(?:\*\*)?$/;
const FORMAT_TAIL_RE = /\b(?:(?:the|this|your|in|as)\s+json(?:\s+(?:output|format|object|response|version|block))?|(?:the|in the|in a)\s+requested\s+format)\s*(?:below)?\s*[:.!]?\s*(?:\*\*)?$/i;

/** SHAPED like the model talking about its answer — short, about the output or the letter. Only a shape (chatterJunkIn). */
export function isChatterLine(line: string): boolean {
  const s = String(line == null ? '' : line).trim();
  if (!s || s.length > CHATTER_MAX_CHARS) return false;
  if (HELPS_RE.test(s)) return true;
  if (PREAMBLE_RE.test(s)) {
    const colon = /:\s*(?:\*\*)?$/.test(s);
    if (ABOUT_FORMAT_RE.test(s) && (colon || s.length <= 120)) return true;
    return ABOUT_LETTER_RE.test(s) && (colon || SURE_RE.test(s));
  }
  if (DONE_RE.test(s)) return ABOUT_LETTER_RE.test(s) || JSON_FORMAT_RE.test(s);
  if (AFTERWORD_RE.test(s)) return ABOUT_LETTER_RE.test(s) || ABOUT_FORMAT_RE.test(s);
  return false;
}

/** Chatter that names the answer's format ("Here is the JSON output:") — only a shape: junk in a letter carrying the JSON. */
function namesFormatLine(line: string): boolean {
  const s = String(line == null ? '' : line).trim();
  return isChatterLine(s) && FORMAT_TAIL_RE.test(s) && (!DONE_RE.test(s) || ABOUT_LETTER_RE.test(s));
}

/**
 * The model HANDING THE ANSWER OVER — letterText.handsToUser. ⚠️ Round 5 (2026-09-20): "Rishi, I have completed the cover
 * letter for the Cyber Security Manager position at Airbus." (the doc-15 sentence itself) was chatter-shaped but junk in
 * no position, so inside cover_letter it was stored, charged and shown as a card. The letter in the MODEL's words only —
 * never "my cover letter", never "this cover letter" — and only as the first line or the last.
 */
function handsToUserLine(s: string): boolean {
  return DONE_RE.test(s) && MODEL_LETTER_RE.test(s);
}

/**
 * The model OPENING its answer ("Sure!", "Certainly! Below is the cover letter.") — junk only as the FIRST line.
 * ⚠️ "Here is / Below is" needs a COVER letter (round 5): an applicant's own "Here is the letter of interest you asked me
 * for on Tuesday …" was dropped from the cards, and the next save wrote the letter back without it.
 */
function opensAnswerLine(line: string): boolean {
  const s = String(line == null ? '' : line).trim();
  if (!s || s.length > CHATTER_MAX_CHARS) return false;
  if (BARE_SURE_RE.test(s)) return true;
  if (SURE_RE.test(s)) return ABOUT_LETTER_RE.test(s) || MODEL_LETTER_RE.test(s);
  if (handsToUserLine(s)) return true;
  return HERE_RE.test(s) && MODEL_COVER_LETTER_RE.test(s);
}

/** …and SIGNING OFF ("I hope this helps!", "Rishi, I have completed the cover letter …") — junk only as the LAST line. */
function closesAnswerLine(line: string): boolean {
  const s = String(line == null ? '' : line).trim();
  if (!s || s.length > CHATTER_MAX_CHARS) return false;
  return HELPS_RE.test(s) || handsToUserLine(s);
}

/** A card's text as a reader sees it: <br> a line break, no tags, entities decoded. */
const cardText = (h: string) => decodeEntities(String(h == null ? '' : h).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ''));
const paraKey = (t: string) => t.replace(/\*\*/g, '').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
function trimWordEdges(w: string): string {
  let a = 0;
  let b = w.length;
  while (a < b && !WORD_CHAR_RE.test(w[a])) a++;
  while (b > a && !WORD_CHAR_RE.test(w[b - 1])) b--;
  return a === 0 && b === w.length ? w : w.slice(a, b);
}
const wordsOfKey = (key: string) => key.split(' ').map(trimWordEdges).filter(Boolean);
const wordSetOf = (key: string) => new Set(wordsOfKey(key));
/** The share of their words two word sets have in common (Jaccard) — letterText.overlapOf. */
function overlapOf(sa: Set<string>, sb: Set<string>): number {
  let both = 0;
  sa.forEach((w) => { if (sb.has(w)) both++; });
  const all = sa.size + sb.size - both;
  return all > 0 ? both / all : 0;
}
/** Two paraKeys (both DUP_MIN_CHARS+) that are one paragraph written twice with an edit — letterText.isNearDuplicate. */
export function isNearDuplicate(a: string, b: string): boolean {
  return overlapOf(wordSetOf(a), wordSetOf(b)) >= NEAR_DUP_OVERLAP;
}
/** How much of a text `len` long the spans [from, to) cover, as a share — letterText.coveredShare. */
function coveredShare(spans: number[][], len: number): number {
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
 * "Is this a card the letter has already?" asked of each card in order — letterText.repeatsKept, rule for rule: the same
 * card, one an earlier card is NEARLY ALL of (word for word inside it, NEAR_DUP_OVERLAP of its characters — the same
 * card with a stray `}` on one of the two), a near-copy of one, or a card MADE of earlier cards (they cover
 * NEAR_DUP_OVERLAP of it: the letter again as one block). ⚠️ NEVER a card that only QUOTES an earlier one — a headline
 * card repeated inside a longer paragraph further down would have taken that paragraph's own words with it — and ⚠️ never
 * a card that merely SAYS a sentence an earlier card ends with (round 5: a closing the user typed on Customize,
 * "I am available to start within four weeks and can relocate to Munich at my own expense.", was dropped).
 */
function repeatsKept(count: number): (key: string) => boolean {
  const exact = new Set<string>();
  const long: { key: string; words: Set<string>; prose: boolean }[] = [];
  const fuzzy = count <= NEAR_DUP_MAX_PARAGRAPHS;
  return (key: string) => {
    if (exact.has(key)) return true;
    exact.add(key);
    if (!fuzzy || key.length < DUP_MIN_CHARS) return false;
    const list = wordsOfKey(key);
    const words = new Set(list);
    const prose = list.length >= NEAR_DUP_MIN_WORDS;
    const held: number[][] = [];
    for (const s of long) {
      if ((key.length >= NEAR_DUP_OVERLAP * s.key.length && s.key.includes(key))
        || (prose && s.prose && overlapOf(s.words, words) >= NEAR_DUP_OVERLAP)) return true;
      if (!prose || !s.prose) continue;   // "made of earlier cards" is a prose test too: see NEAR_DUP_MIN_WORDS
      const at = key.indexOf(s.key);
      if (at >= 0) held.push([at, at + s.key.length]);
    }
    if (coveredShare(held, key.length) >= NEAR_DUP_OVERLAP) return true;
    long.push({ key, words, prose });
    return false;
  };
}

type FlowLine = { p: number; i: number; t: string; inJson: boolean; kind?: string };

/**
 * THE CHATTER RULE — the server's letterText.chatterJunkIn, line for line: which chatter-shaped lines are the model talking
 * ("card:line" keys). A chatter line goes when the line before it CLOSES the answer's JSON (a "}" / "]" line, a closing
 * fence), the line after it OPENS some (a ```json fence, a "{" / "[" line), it introduces the letter with nothing to
 * introduce (first or last, or right before a paragraph the letter already has), or it names the answer's format.
 * `paras` = each card's line texts; a list card is one line of letter text.
 */
function chatterJunkIn(paras: string[][]): Set<string> {
  const flat: FlowLine[] = [];
  const repeats = repeatsKept(paras.length);
  const dupAt = new Set<number>();
  paras.forEach((lines, p) => {
    const inJson = lines.some((t) => FENCE_RE.test(t) || BRACE_LINE_RE.test(t) || KEY_LINE_RE.test(t));
    const key = paraKey(lines.join('\n'));
    if (key && repeats(key)) dupAt.add(p);
    lines.forEach((t, i) => flat.push({ p, i, t, inJson }));
  });
  let inFence = false;
  flat.forEach((x, k) => {
    const t = x.t;
    let kind = 'text';
    if (!t) kind = 'blank';
    else if (FENCE_RE.test(t)) {
      const opens = /^```\s*[A-Za-z]/.test(t) || (!inFence && flat.slice(k + 1).some((y) => !!y.t));
      inFence = opens;
      kind = opens ? 'open' : 'close';
    } else if (BRACE_LINE_RE.test(t)) {
      const b = t.replace(/[^{}[\]]/g, '');
      const open = /[{[]$/.test(b);
      const close = /^[}\]]/.test(b);
      kind = open && close ? 'both' : open ? 'open' : close ? 'close' : 'json';
    } else if (KEY_LINE_RE.test(t) || (x.inJson && JSON_STRING_LINE_RE.test(t))) kind = 'json';
    else if (isChatterLine(t) || opensAnswerLine(t)) kind = 'chatter';
    else if (RULE_RE.test(t) || HEADING_RE.test(t) || LABEL_LINE_RE.test(t)) kind = 'label';
    x.kind = kind;
  });
  const carriesJson = flat.some((x) => x.kind === 'open' || x.kind === 'close' || x.kind === 'both' || x.kind === 'json' || KEY_ANYWHERE_RE.test(x.t));
  const firstLineOf = new Map<number, number>();
  flat.forEach((x, k) => { if (x.kind !== 'blank' && !firstLineOf.has(x.p)) firstLineOf.set(x.p, k); });
  const passes = (x: FlowLine) => x.kind === 'blank' || x.kind === 'chatter' || x.kind === 'label';
  const junk = new Set<string>();
  flat.forEach((x, k) => {
    if (x.kind !== 'chatter') return;
    let j = k - 1; while (j >= 0 && passes(flat[j])) j--;
    let n = k + 1; while (n < flat.length && passes(flat[n])) n++;
    const prev = j >= 0 ? flat[j] : null;
    const next = n < flat.length ? flat[n] : null;
    const introduces = INTRODUCER_RE.test(x.t) && (ABOUT_LETTER_RE.test(x.t) || namesFormatLine(x.t))
      && (!prev || !next || (dupAt.has(next.p) && firstLineOf.get(next.p) === n));
    const wraps = (!prev && opensAnswerLine(x.t)) || (!next && closesAnswerLine(x.t));
    if ((carriesJson && namesFormatLine(x.t)) || introduces || wraps
      || (prev && (prev.kind === 'close' || prev.kind === 'both'))
      || (next && (next.kind === 'open' || next.kind === 'both'))) junk.add(`${x.p}:${x.i}`);
  });
  return junk;
}

/**
 * The server's strong signal (letterText.looksContaminatedHtml): a fence, a JSON key or brace line, a paragraph twice, or a
 * line the chatter rule names (next to the JSON, an introducer to nothing, the model's opener first / sign-off last). A
 * line that only SOUNDS like the model is not one.
 */
export function looksLikeModelJunk(blocks: LetterBlock[]): boolean {
  const texts = blocks.map((b) => cardText(b.html));
  const all = texts.join('\n\n');
  if (/```/.test(all) || KEY_ANYWHERE_RE.test(all)) return true;
  const lines = all.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.some((l) => BRACE_LINE_RE.test(l) || KEY_LINE_RE.test(l))) return true;
  // The lines exactly as withoutModelJunk reads them (a card's <br> lines), so a letter flagged here is one it repairs.
  if (chatterJunkIn(blocks.map((b) => (b.kind === 'p' ? b.html.split(/<br\s*\/?>/i).map((l) => cardText(l).trim()) : ['·']))).size) return true;
  // A card twice — or nearly (repeatsKept, what withoutModelJunk drops it by; exact copies only until round 3).
  // ⚠️ Counted over EVERY card, not just the long ones (round 5): repeatsKept turns its near-copy test off past
  // NEAR_DUP_MAX_PARAGRAPHS and withoutModelJunk counts all the 'p' cards, so counting the long ones here flagged a
  // 25-card letter with fuzzy matching ON that the repair then ran with it OFF — flagged for ever, repaired never.
  const keys = texts.map(paraKey).filter((x) => x.length >= DUP_MIN_CHARS);
  return keys.some(repeatsKept(blocks.filter((b) => b.kind === 'p').length));
}

/** One line of a card → the line kept (its own markup), a shorter one (a label or a JSON key off the front), or null. */
function cleanJunkLine(raw: string, text: string, inJson: boolean, chatterJunk: boolean): string | null {
  const t = text.trim();
  if (!t) return raw;
  if (FENCE_RE.test(t) || BRACE_LINE_RE.test(t) || RULE_RE.test(t) || HEADING_RE.test(t) || LABEL_LINE_RE.test(t) || chatterJunk) return null;
  if (KEY_LINE_RE.test(t)) {
    if (!LETTER_KEY_LINE_RE.test(t)) return null;
    const kept = raw.replace(LETTER_VALUE_PREFIX_RE, '');
    return kept !== raw && cardText(kept).trim() ? kept : null;
  }
  if (inJson && JSON_STRING_LINE_RE.test(t)) return null;
  if (PARA_LABEL_RE.test(t)) {
    const kept = raw.replace(PARA_LABEL_RE, '');
    if (kept === raw) return raw;
    return cardText(kept).trim() ? kept : null;
  }
  return raw;
}

/**
 * The cards with the model's junk out — only when looksLikeModelJunk says so; otherwise the SAME array.
 *
 * ⚠️ RUN TO A FIXED POINT, as letterText.repairLetterHtml is (round 5, 2026-09-20): chatterJunkIn reads a chatter line's
 * neighbours BEFORE the brace / fence / label lines are cleaned away in the same pass, so an opener shielded by a "{"
 * card before it (or a sign-off shielded by a `"subject": …` card after it) is junk only on the NEXT pass. One pass left
 * "Sure! Here is the cover letter you asked for." on screen and in the server's served letter alike.
 */
export function withoutModelJunk(blocks: LetterBlock[]): LetterBlock[] {
  let out = blocks;
  for (let i = 0; i < 3; i++) {
    const next = withoutModelJunkOnce(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * One pass — see withoutModelJunk. Each 'p' card's <br> lines go through the server's line rules, a card left empty
 * goes, a card already seen goes; lists pass untouched.
 */
function withoutModelJunkOnce(blocks: LetterBlock[]): LetterBlock[] {
  if (!looksLikeModelJunk(blocks)) return blocks;
  const out: LetterBlock[] = [];
  const repeats = repeatsKept(blocks.filter((b) => b.kind === 'p').length);
  const linesOf = blocks.map((b) => (b.kind === 'p' ? b.html.split(/<br\s*\/?>/i) : []));
  const textsOf = linesOf.map((lines) => lines.map((l) => cardText(l).trim()));
  const junk = chatterJunkIn(blocks.map((b, k) => (b.kind === 'p' ? textsOf[k] : ['·'])));
  blocks.forEach((b, k) => {
    if (b.kind !== 'p') { out.push(b); return; }
    const lines = linesOf[k];
    const texts = textsOf[k];
    const inJson = texts.some((t) => FENCE_RE.test(t) || BRACE_LINE_RE.test(t) || KEY_LINE_RE.test(t));
    let touched = false;
    const kept: string[] = [];
    lines.forEach((l, i) => {
      const next = cleanJunkLine(l, texts[i], inJson, junk.has(`${k}:${i}`));
      if (next !== l) touched = true;
      if (next !== null) kept.push(next);
    });
    let html = b.html;
    if (touched) {
      html = trimEdges(kept.join('<br>'));
      // The end of a JSON string: an unmatched straight quote at the card's end (or its start).
      if ((cardText(html).match(/"/g) || []).length % 2 === 1) {
        const endless = html.replace(TRAILING_QUOTE_RE, '');
        html = endless !== html ? endless : html.replace(LEADING_QUOTE_RE, '$1');
      }
      html = trimEdges(html);
    }
    const key = paraKey(cardText(html));
    if (!key || repeats(key)) return;
    out.push(touched ? { kind: 'p', html } : b);
  });
  return out;
}

/**
 * Stored letter HTML → the paragraph cards, top to bottom.
 *   <p …> (attributes allowed — an unedited AI letter carries <p style>), <div>, <h1-6>, <blockquote> … → one 'p' card each
 *   <ul>/<ol> … </ul> → ONE 'list' card (its ul/ol/li kept, its text cleaned)
 *   text outside every block (a plain-text letter, loose runs between blocks) → split on <br><br> / blank lines
 * Cards with no text ("<br>", "&nbsp;", whitespace) are dropped — and so is the model's junk, when a letter carries it
 * (withoutModelJunk: a clean letter's cards are exactly what they were).
 * ⚠️ For the letter AS THE SERVER SERVED IT only. What the user made on this page is read with splitLetterCards.
 */
export function splitLetterParagraphs(html: string): LetterBlock[] {
  return withoutModelJunk(splitCards(html));
}

/** The same cards with NO junk backstop: for HTML the user wrote on this page (a saved edit, an unsaved draft). */
export function splitLetterCards(html: string): LetterBlock[] {
  return splitCards(html);
}

function splitCards(html: string): LetterBlock[] {
  const src = stripNonText(html);
  const out: LetterBlock[] = [];
  const pushP = (raw: string) => {
    const h = trimEdges(cleanInline(raw));
    if (hasText(h)) out.push({ kind: 'p', html: h });
  };
  if (!LETTER_MARKUP_RE.test(src)) {
    src.replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
      .forEach((p) => { const h = escapeHtml(p).replace(/\n/g, '<br>'); if (hasText(h)) out.push({ kind: 'p', html: h }); });
    return out;
  }
  let buf = '';
  let inBlock = false;
  const flush = () => {
    if (inBlock) pushP(buf);
    else buf.split(/(?:<br\s*\/?>\s*){2,}|\n[ \t]*\n/i).forEach(pushP);   // loose text: <br><br> is a paragraph break
    buf = '';
  };
  BLOCK_RE.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = BLOCK_RE.exec(src))) {
    buf += src.slice(last, m.index);
    last = m.index + m[0].length;
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    if ((name === 'ul' || name === 'ol') && !closing) {
      flush();
      inBlock = false;
      // The whole list, nested lists included, up to its own closer (or the end of an unclosed one).
      const LIST = /<(\/?)(ul|ol)\b[^>]*>/gi;
      LIST.lastIndex = last;
      let depth = 1;
      let end = src.length;
      let lm: RegExpExecArray | null;
      while ((lm = LIST.exec(src))) {
        depth += lm[1] === '/' ? -1 : 1;
        if (depth === 0) { end = lm.index + lm[0].length; break; }
      }
      const list = cleanList(src.slice(m.index, end));
      if (hasText(list)) out.push({ kind: 'list', html: list });
      last = end;
      BLOCK_RE.lastIndex = end;
      continue;
    }
    flush();
    inBlock = !closing;
  }
  buf += src.slice(last);
  flush();
  return out;
}

/** The cards → letter HTML: every 'p' card wrapped in <p>, a 'list' card as it is. */
export function joinLetterParagraphs(blocks: LetterBlock[]): string {
  return (Array.isArray(blocks) ? blocks : [])
    .map((b) => (b.kind === 'list' ? b.html : `<p>${b.html}</p>`))
    .join('');
}

/**
 * What the rich-text box handed back → the card(s) it becomes. Pressing Enter inside a paragraph makes a new <p> in Quill,
 * so one card can come back as several — on purpose. Empty paragraphs (<p><br></p>) are dropped. Quill 1.x has no soft
 * line break, so an inner <br> of the original splits too; our AI never writes one (its paragraphs are \n\n-separated).
 * ⚠️ WHAT THE USER TYPED IS NEVER FILTERED (review, 2026-09-19): the raw splitter, not splitLetterParagraphs — the junk
 * backstop there turned a typed "I hope this cover letter shows …" into no card, and Done then deleted the paragraph.
 */
export function quillToBlocks(quillHtml: string): LetterBlock[] {
  return splitCards(quillHtml).filter((b) => hasText(b.html));
}

/** The HTML a card's rich-text box opens with: cleanInline output only, so it is safe inside the editor's page. */
export function editorHtmlOf(block: LetterBlock | null | undefined): string {
  if (!block) return '';
  return block.kind === 'list' ? cleanList(block.html) : `<p>${trimEdges(cleanInline(block.html))}</p>`;
}

/* ── THE LETTER'S FIELDS ─────────────────────────────────────────────────────────────────────────── */

// ⚠️ MIRRORS THE SERVER (employerDocsRoutes payloadProblem + coverLetterController.mergeLetterSender): the same keys, the
// same caps, the same merge. A field the server would refuse is refused here first; a sender shown here is the one printed.
export const SENDER_KEYS = ['name', 'title', 'email', 'phone', 'location'] as const;
export type SenderKey = typeof SENDER_KEYS[number];
export type LetterSender = Record<SenderKey, string>;
export const LINE_MAX = 200;
export const SUBJECT_MAX = 300;
export const ADDRESS_MAX = 600;
export const EMPTY_SENDER: LetterSender = { name: '', title: '', email: '', phone: '', location: '' };

/** One printed line: control characters and line breaks become spaces, runs collapse, cut at `max`. */
export function oneLine(v: unknown, max = LINE_MAX): string {
  if (typeof v !== 'string') return '';
  return v.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

/** The address box is multiline for typing; the letter prints one line, so its lines join with ", ". */
export function addressLine(v: unknown): string {
  if (typeof v !== 'string') return '';
  return oneLine(v.split(/\r\n?|\n/).map((l) => l.trim().replace(/,+$/, '')).filter(Boolean).join(', '), ADDRESS_MAX);
}

function senderOf(v: unknown): Partial<LetterSender> {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  const out: Partial<LetterSender> = {};
  if (!o) return out;
  for (const k of SENDER_KEYS) if (typeof o[k] === 'string') out[k] = oneLine(o[k]);
  return out;
}

/**
 * The sender a letter PRINTS: the profile (the server's buildCLSender), each key the letter overrides laid over it.
 * An override of '' prints nothing — except the name, which falls back to the profile (a letter is always signed).
 */
export function effectiveSender(profile: Partial<LetterSender> | null | undefined, override: unknown): LetterSender {
  const base: LetterSender = { ...EMPTY_SENDER };
  for (const k of SENDER_KEYS) base[k] = oneLine((profile && profile[k]) || '');
  const o = senderOf(override);
  for (const k of SENDER_KEYS) {
    if (o[k] === undefined) continue;
    if (k === 'name' && !o[k]) continue;
    base[k] = o[k] as string;
  }
  return base;
}

export type LetterFields = {
  companyName: string;
  companyAddress: string;
  subject: string;
  /** '' = the design's own greeting ("Dear Hiring Manager," — "Dear Sir or Madam," on German Professional). */
  salutation: string;
  /** '' = the design's own closing (Sincerely, / Best regards, / Respectfully, …). */
  closing: string;
  sender: LetterSender;
};

/** What the field cards show for a stored payload. `employer` is the row's own name — what prints when companyName is blank. */
export function letterFieldsOf(payload: any, employer: string, profile: Partial<LetterSender> | null): LetterFields {
  const p = payload && typeof payload === 'object' ? payload : {};
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    companyName: str(p.companyName) || str(employer),
    companyAddress: str(p.companyAddress),
    subject: str(p.subject),
    salutation: str(p.salutation),
    closing: str(p.closing),
    sender: effectiveSender(profile, p.sender),
  };
}

/**
 * The payload to store after a field card's Done: a copy of `payload` where ONLY the fields that changed between
 * `before` (what the card opened with) and `after` (what it holds now) are written. An untouched letter keeps every key
 * it had — no `sender` / `salutation` / `closing` appears unless the user edited it, and coverLetterHtml is never touched.
 *   • greeting / closing cleared → the key is removed (the design's own line prints again);
 *   • a sender key set back to the profile's value (or a cleared name) → its override is removed, so the letter follows
 *     the profile again; an override object left empty is removed.
 */
export function withLetterFields(payload: any, before: LetterFields, after: LetterFields,
  profile: Partial<LetterSender> | null): Record<string, any> {
  const next: Record<string, any> = { ...(payload && typeof payload === 'object' ? payload : {}) };
  if (after.companyName !== before.companyName) next.companyName = oneLine(after.companyName);
  if (after.companyAddress !== before.companyAddress) next.companyAddress = addressLine(after.companyAddress);
  if (after.subject !== before.subject) next.subject = oneLine(after.subject, SUBJECT_MAX);
  for (const k of ['salutation', 'closing'] as const) {
    if (after[k] === before[k]) continue;
    const v = oneLine(after[k]);
    if (v) next[k] = v; else delete next[k];
  }
  const o: Partial<LetterSender> = senderOf(next.sender);
  let touched = false;
  for (const k of SENDER_KEYS) {
    if (after.sender[k] === before.sender[k]) continue;
    touched = true;
    const v = oneLine(after.sender[k]);
    if (k === 'name' && !v) delete o.name;
    else if (profile && v === oneLine(profile[k] || '')) delete o[k];
    else o[k] = v;
  }
  if (touched) {
    if (Object.keys(o).length) next.sender = o; else delete next.sender;
  }
  return next;
}

/** Did any field change? (The Save pill and the unsaved-changes guard read this.) */
export function fieldsDiffer(a: LetterFields | null, b: LetterFields | null): boolean {
  if (!a || !b) return false;
  if (a.companyName !== b.companyName || a.companyAddress !== b.companyAddress || a.subject !== b.subject
    || a.salutation !== b.salutation || a.closing !== b.closing) return true;
  return SENDER_KEYS.some((k) => a.sender[k] !== b.sender[k]);
}
