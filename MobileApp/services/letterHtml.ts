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

/**
 * Stored letter HTML → the paragraph cards, top to bottom.
 *   <p …> (attributes allowed — an unedited AI letter carries <p style>), <div>, <h1-6>, <blockquote> … → one 'p' card each
 *   <ul>/<ol> … </ul> → ONE 'list' card (its ul/ol/li kept, its text cleaned)
 *   text outside every block (a plain-text letter, loose runs between blocks) → split on <br><br> / blank lines
 * Cards with no text ("<br>", "&nbsp;", whitespace) are dropped.
 */
export function splitLetterParagraphs(html: string): LetterBlock[] {
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
 */
export function quillToBlocks(quillHtml: string): LetterBlock[] {
  return splitLetterParagraphs(quillHtml).filter((b) => hasText(b.html));
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
