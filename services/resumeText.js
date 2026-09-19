'use strict';

/**
 * WHAT A CV FILE IS, AND ITS TEXT — for every format the app now accepts, with Node's own modules only.
 *
 * ⚠️ WHY THIS EXISTS (2026-09-19). The "Make Yours" wizard told people "Choose a PDF", and the owner asked for
 * Word too. The server side of that was worse than the copy: /users/profile/resume accepted ANY file, saved it
 * as the résumé BEFORE anything checked it could be read, and the parser only knew PDF and images — so a .docx
 * uploaded happily, replaced a good CV, and then failed in the background with nothing on screen. This module
 * is the one answer to "what is this file, and can we read it", asked BEFORE the upload is committed.
 *
 * ⚠️ NO NEW DEPENDENCY, BY RULE — and none is needed. package.json has no Word reader (no mammoth, no
 * word-extractor; jszip is a devDependency only, so it is not on the production image). Each format is small:
 *   .docx / .odt — a ZIP of XML: the central directory + zlib.inflateRawSync, then the text runs of one XML part;
 *   .doc (Word 97-2003) — an OLE2 compound file: the FAT chain to the WordDocument + table streams, then the
 *     piece table (Clx) that says where each run of characters lives and whether it is 8-bit or UTF-16;
 *   .rtf — a group-aware stripper (a naive one leaks the font table's names into the text, measured);
 *   .txt — UTF-8, UTF-16 with a BOM, or Windows-1252.
 * PDF and images are NOT read here: they keep pdf-parse and the vision fallback in resumeParserService.
 *
 * ⚠️ NEVER CLAIM A FORMAT THIS CANNOT READ. Word 6/95, a password-protected file, .pages, spreadsheets and
 * anything unrecognised are REFUSED with a sentence that says what to do instead — the refusal happens at the
 * upload, so a file the server cannot read never replaces one it could.
 *
 * ⚠️ LINEAR AND BOUNDED, BY RULE (review, 2026-09-20). This runs SYNCHRONOUSLY on the one event loop — in the upload
 * request and in the background parser alike — so a slow file stops the whole server for every user, and a big one
 * crashes it. What the review measured on the first version: `<w:del>` ×64,000 (a 1 KB .docx) held the loop 52 s,
 * because `<tag[^>]*>[\s\S]*?</tag>` and even plain `<[^>]+>` are QUADRATIC on unbalanced markup; 20,000 spaces in a
 * .txt held it 5 s in tidy()'s `[ \t]+\n`; a 1.5 KB .doc whose DIF chain points at itself spun for minutes and grew to
 * 2.3 GB; sixty 39 MB headers in a 2 MB .docx aborted the process. So: markup is walked ONCE, forward, with indexOf
 * (markupText) — never a backtracking regex over a whole part; every loop over a header count or a sector chain is
 * clamped to what the file can hold and guarded against cycles; ONE decompression budget covers a whole document; and
 * the text handed back is capped. A regex here may only ever run over a bounded slice (a tag, 48 characters of RTF).
 */

const zlib = require('zlib');
const path = require('path');

/**
 * ⚠️ THE SIZE CEILING IS THE LAST READER'S, NOT A ROUND NUMBER (review, 2026-09-20).
 *
 * The app's résumé route had NO limit; one of 10 MB was added with this gate, and it refused files every reader
 * downstream can still read: pdf-parse has no limit of its own, and the vision reader that transcribes a scanned or
 * photographed CV takes up to 18 MB (resumeParserService.VISION_MAX_BYTES, which is now this constant). Measured: a
 * 12,583,740-byte PDF CV with a perfect text layer — a photo-heavy export, or a multi-page phone scan — uploaded and
 * parsed end to end before the change and was a 413 after it, with nothing in the app to shrink the file with.
 * So the cap is the ceiling of the last reader in the chain: nothing is refused for its size that something could
 * have read, and what is refused is refused with a sentence that names the real number.
 */
const MAX_UPLOAD_BYTES = 18 * 1024 * 1024;

// The user-facing sentences. One place, so the upload's 415 and the parser's recorded error say the same thing.
const MESSAGES = {
    unsupported: 'We can read PDF, Word (.docx or .doc), OpenDocument (.odt), RTF and plain-text CVs. Please save yours as a PDF or .docx and upload it again.',
    encrypted: 'This file is password-protected, so we cannot read it. Please remove the password (or save it as a PDF) and upload it again.',
    old_word: 'This is a very old Word file (Word 95 or earlier). Please open it and save it as .docx or PDF, then upload it again.',
    damaged: 'We could not open this file — it looks damaged. Please save it again as a PDF or .docx and upload that.',
    empty: 'We could not find any text in this file. If it is a scan, please upload it as a PDF instead.',
    too_large: `That file is over ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB. Please upload a smaller copy of your CV (a PDF or .docx is usually well under 1 MB).`,
};

// What the app's picker and the copy may promise. ⚠️ Keep in step with the wizard's picker list.
const FORMATS = {
    pdf: { ext: '.pdf', mime: 'application/pdf', label: 'PDF' },
    docx: { ext: '.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', label: 'DOCX' },
    doc: { ext: '.doc', mime: 'application/msword', label: 'DOC' },
    odt: { ext: '.odt', mime: 'application/vnd.oasis.opendocument.text', label: 'ODT' },
    rtf: { ext: '.rtf', mime: 'application/rtf', label: 'RTF' },
    txt: { ext: '.txt', mime: 'text/plain', label: 'TXT' },
    // Images are read by the vision fallback; accepted so a photographed CV (web, older builds) keeps working.
    png: { ext: '.png', mime: 'image/png', label: 'PNG', image: true },
    jpg: { ext: '.jpg', mime: 'image/jpeg', label: 'JPG', image: true },
    webp: { ext: '.webp', mime: 'image/webp', label: 'WEBP', image: true },
    heic: { ext: '.heic', mime: 'image/heic', label: 'HEIC', image: true },
};
/** The kinds whose text this module extracts itself (PDF and images go to resumeParserService's readers). */
const TEXT_KINDS = new Set(['docx', 'doc', 'odt', 'rtf', 'txt']);

const refuse = (reason) => ({ ok: false, reason, message: MESSAGES[reason] || MESSAGES.unsupported });
const accept = (kind) => ({ ok: true, kind, ...FORMATS[kind] });

class ResumeFileError extends Error {
    constructor(reason) { super(MESSAGES[reason] || MESSAGES.unsupported); this.reason = reason; }
}

/* ── ZIP (docx, odt) ──────────────────────────────────────────────────────────────────────────────────── */

// ⚠️ ONE BUDGET FOR THE WHOLE DOCUMENT, not per entry (review, 2026-09-20): a per-entry cap let a 2 MB .docx carry sixty
// 39 MB headers and inflate to 2.3 GB — a process abort, not a catchable error. A résumé's XML is kilobytes (a long,
// heavily formatted one is well under 2 MB); every part one document reads draws on this, and past it the file is refused.
const ZIP_DOC_MAX = 8 * 1024 * 1024;
const ZIP_HEADERS_MAX = 12;             // Word writes ≤ 3 headers per section; a CV has one or two sections
const zipBudget = (bytes = ZIP_DOC_MAX) => ({ left: bytes });

/** The central directory: [{ name, method, flags, csize, usize, lho }]. Throws ResumeFileError('damaged'). */
function zipEntries(buf) {
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new ResumeFileError('damaged');
    const n = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    // ZIP64 markers: no CV needs one, and reading one wrongly is how a parser walks off the buffer.
    if (n === 0xFFFF || p === 0xFFFFFFFF) throw new ResumeFileError('damaged');
    const out = [];
    for (let k = 0; k < n; k++) {
        if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ResumeFileError('damaged');
        const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10);
        const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
        const fnl = buf.readUInt16LE(p + 28), exl = buf.readUInt16LE(p + 30), cml = buf.readUInt16LE(p + 32);
        const lho = buf.readUInt32LE(p + 42);
        out.push({ name: buf.toString('utf8', p + 46, p + 46 + fnl), flags, method, csize, usize, lho });
        p += 46 + fnl + exl + cml;
    }
    return out;
}

/**
 * One entry's bytes, or null when the archive has no such entry. What it inflates is taken from `budget` (zipBudget()),
 * shared by every part of one document; an entry that would overdraw it is refused as 'damaged' — zlib stops at the
 * limit, so a bomb costs at most the budget, never its declared size.
 */
function zipRead(buf, entries, name, budget = zipBudget()) {
    const e = entries.find((x) => x.name === name);
    if (!e) return null;
    if (e.flags & 0x1) throw new ResumeFileError('encrypted');          // a ZIP-level password
    if (e.lho + 30 > buf.length || buf.readUInt32LE(e.lho) !== 0x04034b50) throw new ResumeFileError('damaged');
    const start = e.lho + 30 + buf.readUInt16LE(e.lho + 26) + buf.readUInt16LE(e.lho + 28);
    // ⚠️ The size comes from the CENTRAL directory: a writer that streams (flag bit 3) leaves the local one 0.
    const data = buf.subarray(start, start + e.csize);
    if (data.length !== e.csize) throw new ResumeFileError('damaged');
    if (budget.left <= 0) throw new ResumeFileError('damaged');
    let out;
    try {
        if (e.method === 0) out = data;
        else if (e.method === 8) out = zlib.inflateRawSync(data, { maxOutputLength: budget.left });
    } catch { throw new ResumeFileError('damaged'); }
    if (!out || out.length > budget.left) throw new ResumeFileError('damaged');
    budget.left -= out.length;
    return out;
}

/**
 * The text of a piece of XML or HTML, in ONE forward pass (indexOf, never a backtracking regex over the part — see the
 * header: `<[^>]+>` alone is quadratic on 20,000 "<"). Text between tags is kept; each tag is offered to
 * `onTag(name, closing, selfClosing, src, lt, gt)` (the tag is src[lt..gt]) and the string it returns takes its place; an element named in
 * `skip` (opened, not self-closing) is dropped with its contents up to its FIRST close — the old lazy regex's meaning,
 * and why `<w:del/>` (a deleted paragraph MARK, self-closing) no longer swallows everything up to the next deletion.
 * `caseless` compares tag names ignoring ASCII case (HTML). Linear: a close that is not there is searched for once
 * per name, and a found one is jumped past. It stops once `max` characters have been collected — what is past the
 * cap on the text this module hands back (MAX_TEXT_CHARS) is thrown away anyway, so there is no reason to walk it.
 */
function markupText(src, { skip = new Set(), onTag = () => '', caseless = false, max = Infinity } = {}) {
    const s = String(src);
    // ASCII-only lowering keeps every index valid (String#toLowerCase can change the length: "İ" → "i̇").
    const low = caseless ? s.replace(/[A-Z]+/g, (m) => m.toLowerCase()) : s;
    const parts = [];
    const unclosed = new Set();      // skip names with no close anywhere after the point they were looked for
    let size = 0;
    const put = (t) => { parts.push(t); size += t.length; };
    let i = 0;
    while (i < s.length && size < max) {
        const lt = s.indexOf('<', i);
        if (lt < 0) { put(s.slice(i)); break; }
        if (lt > i) put(s.slice(i, lt));
        const gt = s.indexOf('>', lt + 1);
        if (gt < 0) { put(s.slice(lt)); break; }              // a "<" with no ">" after it is text, as it always was
        const closing = s.charCodeAt(lt + 1) === 47;           // "</"
        const n0 = lt + (closing ? 2 : 1);
        let k = n0;
        for (; k < gt; k++) {
            const c = s.charCodeAt(k);
            if (c === 32 || c === 9 || c === 10 || c === 13 || c === 47) break;
        }
        const name = low.slice(n0, k);
        const selfClosing = !closing && s.charCodeAt(gt - 1) === 47;
        i = gt + 1;
        if (!closing && !selfClosing && skip.has(name) && !unclosed.has(name)) {
            const end = closeAfter(low, name, i);
            if (end >= 0) { i = end; continue; }
            unclosed.add(name);                                // not there: the tag is an ordinary tag, as before
        }
        const r = onTag(name, closing, selfClosing, s, lt, gt);
        if (r) put(r);
    }
    return parts.join('');
}

/** Just past the first `</name>` at or after `from` in `low`, or -1. `</w:delText>` is not a close of `w:del`. */
function closeAfter(low, name, from) {
    const needle = '</' + name;
    for (let at = low.indexOf(needle, from); at >= 0; at = low.indexOf(needle, at + needle.length)) {
        const c = low.charCodeAt(at + needle.length);
        if (c === 62) return at + needle.length + 1;          // "</name>"
        if (c === 32 || c === 9 || c === 10 || c === 13) {    // "</name  >"
            const gt = low.indexOf('>', at);
            return gt < 0 ? -1 : gt + 1;
        }
    }
    return -1;
}

function decodeXmlEntities(s) {
    return s
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => safeCodePoint(Number(d)))
        .replace(/&amp;/g, '&');
}
const safeCodePoint = (n) => { try { return String.fromCodePoint(n); } catch { return ''; } };

// Not on the page: deleted tracked changes (w:del, and w:delText wherever it appears), field instructions, a text
// box's VML fallback (a text box is written twice — the modern shape and the fallback — and would read twice), and a
// paragraph's tab-stop DEFINITIONS (w:tabs holds <w:tab w:pos=…/> entries, which are not tab characters).
// ⚠️ An element is dropped only when it is OPENED: Word marks a deleted paragraph mark with a self-closing <w:del …/>
// in the paragraph's run properties, and the old `<w:del\b[^>]*>[\s\S]*?</w:del>` read that as an opening tag and
// deleted every paragraph up to the next real deletion — whole Experience and Education sections, silently (review).
const DOCX_SKIP = new Set(['w:del', 'w:delText', 'w:instrText', 'mc:Fallback', 'w:tabs']);
function docxTag(name, closing) {
    if (closing) return name === 'w:p' ? '\n' : name === 'w:tc' ? '\t' : '';
    if (name === 'w:tab') return '\t';
    if (name === 'w:br' || name === 'w:cr') return '\n';
    if (name === 'w:noBreakHyphen') return '-';
    return '';
}
const docxXmlText = (xml) => decodeXmlEntities(markupText(xml, { skip: DOCX_SKIP, onTag: docxTag, max: MAX_MARKUP_CHARS }));

/**
 * word/document.xml, plus its headers AND ITS FOOTERS → text.
 *
 * ⚠️ THE FOOTERS ARE NOT OPTIONAL (review, 2026-09-20). Headers were read because "many CVs keep the name and contact
 * line" there; the Word and Europass templates people actually use put exactly the same things in the FOOTER —
 * LinkedIn URL, address, second phone number, "References available on request" — and reading only one of the pair
 * dropped them silently, so a contact detail never reached resume_metadata.raw_text or any AI build. Measured on a
 * two-section .docx with header1/2 and footer1/2: both HEADER lines came back and neither FOOTER line did.
 * Each list keeps its own ZIP_HEADERS_MAX clamp and both draw on the one shared budget; footers go AFTER the body,
 * where they are on the page, so the reading order the model sees stays natural.
 */
function docxText(buf, entries) {
    const budget = zipBudget();
    const doc = zipRead(buf, entries, 'word/document.xml', budget);   // the body first: it is what the budget is for
    if (!doc) throw new ResumeFileError('damaged');
    const named = (re) => entries.map((e) => e.name).filter((n) => re.test(n)).sort().slice(0, ZIP_HEADERS_MAX);
    const textOf = (names) => names.map((n) => docxXmlText(zipRead(buf, entries, n, budget) || '')).filter((t) => t.trim());
    const parts = textOf(named(/^word\/header\d*\.xml$/));
    parts.push(docxXmlText(doc));
    parts.push(...textOf(named(/^word\/footer\d*\.xml$/)));
    return parts.join('\n');
}

const ODT_SKIP = new Set(['office:annotation']);
function odtTag(name, closing, selfClosing, src, lt, gt) {
    if (closing) return name === 'text:p' || name === 'text:h' ? '\n' : name === 'table:table-cell' ? '\t' : '';
    if (name === 'text:tab') return '\t';
    if (name === 'text:line-break') return '\n';
    if (name === 'text:s') {                                  // N spaces; the regex runs over this ONE tag only
        const m = /\btext:c="(\d+)"/.exec(src.slice(lt, gt));
        return ' '.repeat(m ? Math.min(40, Number(m[1]) || 1) : 1);
    }
    return '';
}

/** content.xml of an OpenDocument text → text. */
function odtText(buf, entries) {
    const xml = zipRead(buf, entries, 'content.xml', zipBudget());
    if (!xml) throw new ResumeFileError('damaged');
    return decodeXmlEntities(markupText(xml, { skip: ODT_SKIP, onTag: odtTag, max: MAX_MARKUP_CHARS }));
}

/* ── OLE2 compound file (doc) ──────────────────────────────────────────────────────────────────────────── */

/** A reader over an OLE2 file's streams by name. Bounds-checked: a damaged file throws, it never walks off. */
function cfbOpen(buf) {
    if (buf.length < 512 || buf.readUInt32LE(0) !== 0xe011cfd0 || buf.readUInt32LE(4) !== 0xe11ab1a1) throw new ResumeFileError('damaged');
    const shift = buf.readUInt16LE(30), mshift = buf.readUInt16LE(32);
    if (shift < 9 || shift > 12 || mshift > shift) throw new ResumeFileError('damaged');
    const ss = 1 << shift, mss = 1 << mshift;
    const dirStart = buf.readInt32LE(48), cutoff = buf.readUInt32LE(56);
    const miniFatStart = buf.readInt32LE(60), difStart = buf.readInt32LE(68), nDif = buf.readUInt32LE(72);
    const nSectors = Math.floor(buf.length / ss);
    // ⚠️ EVERY COUNT IN THE HEADER IS THE FILE'S CLAIM, clamped to what the bytes can hold (review, 2026-09-20): a
    // 1.5 KB file claiming 4 billion FAT sectors, with a DIF sector that names itself as the next one, spun here for
    // minutes and grew to 2.3 GB. A FAT cannot have more sectors than the file; the DIF chain is cycle-checked like
    // every other chain.
    const nFat = Math.min(buf.readUInt32LE(44), Math.max(0, nSectors));
    // ⚠️ (i + 1) * ss, not 512 + i * ss: a version-4 file's header occupies a whole 4096-byte sector.
    const sec = (i) => {
        if (!(i >= 0 && i < nSectors)) throw new ResumeFileError('damaged');
        return (i + 1) * ss;
    };
    const fatSecs = [];
    for (let i = 0; i < 109 && fatSecs.length < nFat; i++) fatSecs.push(buf.readInt32LE(76 + i * 4));
    const difSeen = new Set();
    for (let d = difStart, k = 0; k < nDif && d >= 0 && fatSecs.length < nFat; k++) {
        if (difSeen.has(d)) throw new ResumeFileError('damaged');   // a DIF chain that loops
        difSeen.add(d);
        const o = sec(d);
        for (let i = 0; i < ss / 4 - 1 && fatSecs.length < nFat; i++) fatSecs.push(buf.readInt32LE(o + i * 4));
        d = buf.readInt32LE(o + ss - 4);
    }
    // ⚠️ A FAT THE HEADER CANNOT LIST IS NOT DAMAGE — AND IT IS NEVER READ SHORT (review, 2026-09-20). The 109 slots
    // in the header reach 13,952 sectors, about 7.1 MB of a 512-byte-sector file; past that a conforming writer puts
    // the rest in DIFAT sectors. macOS's own converter (textutil, and TextEdit's "Save as Word 97") does not: it
    // declares csectFat = 159 with sectDifStart = ENDOFCHAIN and csectDif = 0, and simply lays the remaining FAT
    // sectors CONTIGUOUSLY after the last one it listed. Measured: a 7.8 MB .doc that macOS reads back in full
    // (textutil -convert txt → 8.1 MB of text) arrived here as a WordDocument stream cut at exactly 13,953 sectors
    // and was refused as "damaged" — a file the user can open, rejected, with support sent after corruption that is
    // not there. So the continuation is taken from where that writer puts it, and ONLY while it really reads like a
    // FAT (almost every entry in it a sector number this file could hold); anything else is refused at once rather
    // than assembled into a FAT that would send the reader to the wrong sectors.
    if (fatSecs.length && fatSecs.length < nFat && !(difStart >= 0 && nDif > 0)) {
        const looksLikeFat = (s) => {
            if (!(s >= 0 && s < nSectors)) return false;
            const o = (s + 1) * ss;
            if (o + ss > buf.length) return false;
            let sane = 0;
            for (let i = 0; i < ss / 4; i++) { const v = buf.readInt32LE(o + i * 4); if (v >= -4 && v < nSectors) sane++; }
            return sane * 8 >= (ss / 4) * 7;
        };
        for (let n = fatSecs[fatSecs.length - 1] + 1; fatSecs.length < nFat && looksLikeFat(n); n++) fatSecs.push(n);
    }
    // ⚠️ A FAT still shorter than the header claims is NOT refused here. Whether it matters is a question about the
    // streams this file actually holds, and `chain` below answers it exactly: a FAT that covers everything needed
    // reads, and one that does not throws the moment a chain runs off its end. Refusing up front would turn a file
    // that reads perfectly today — a writer that over-declares csectFat — into "damaged" for no reason.
    const fat = [];
    for (const s of fatSecs) { const o = sec(s); for (let i = 0; i < ss / 4; i++) fat.push(buf.readInt32LE(o + i * 4)); }
    // A chain of sector numbers below `max`: past the end, or back on itself, is damage (never a hang).
    // ⚠️ AND A SECTOR THE FAT DOES NOT COVER IS DAMAGE TOO, NOT THE END OF THE CHAIN (review, 2026-09-20): `next[s]`
    // undefined made `undefined >= 0` false, so this loop simply STOPPED and handed back a short stream — a
    // truncated WordDocument, or a directory missing its later entries, with nothing said. Silence is the one thing
    // a résumé reader may not do: part of a CV returned as though it were all of it is worse than a refusal.
    // `soft` is for the DIRECTORY alone (below): losing a directory entry can only end in a refusal, never in a
    // shortened résumé, so that one chain may stop where the FAT stops. Every real stream stays strict.
    const chain = (start, next, max, soft) => {
        const out = [];
        const seen = new Uint8Array(Math.max(0, max));
        for (let s = start; s >= 0;) {
            if (s >= max || seen[s]) throw new ResumeFileError('damaged');
            seen[s] = 1; out.push(s);
            const nx = next[s];
            if (typeof nx !== 'number') { if (soft) break; throw new ResumeFileError('damaged'); }
            s = nx;
        }
        return out;
    };
    const readBig = (start, size, soft) => {
        const parts = chain(start, fat, nSectors, soft).map((s) => { const o = sec(s); return buf.subarray(o, o + ss); });
        const all = Buffer.concat(parts);
        return size == null ? all : all.subarray(0, size);
    };
    // ⚠️ The directory is read SOFTLY, and only the directory. The same macOS converter writes the directory, the FAT
    // and the mini-FAT into sectors PAST the end of what its own FAT describes, so a strict walk of the directory
    // chain refuses a 10.4 MB .doc whose WordDocument stream is entirely inside the FAT and reads perfectly. A short
    // directory costs at most an entry, and a missing entry is refused out loud a few lines below ('unsupported' with
    // no WordDocument, 'damaged' with no table stream) — it can never hand back part of a CV as if it were all of it.
    const dir = readBig(dirStart, null, true);
    const entries = [];
    for (let o = 0; o + 128 <= dir.length; o += 128) {
        const nl = dir.readUInt16LE(o + 64);
        if (!nl || nl > 64) continue;
        entries.push({
            name: dir.toString('utf16le', o, o + nl - 2), type: dir[o + 66],
            start: dir.readInt32LE(o + 116), size: dir.readUInt32LE(o + 120),
        });
    }
    const root = entries.find((e) => e.type === 5);
    let miniStream = null, miniFat = null;
    const mini = () => {
        if (!miniStream) {
            miniStream = root && root.start >= 0 ? readBig(root.start, root.size) : Buffer.alloc(0);
            miniFat = [];
            if (miniFatStart >= 0) {
                const b = readBig(miniFatStart);
                for (let i = 0; i + 4 <= b.length; i += 4) miniFat.push(b.readInt32LE(i));
            }
        }
    };
    const readMini = (start, size) => {
        mini();
        const parts = chain(start, miniFat, Math.floor(miniStream.length / mss)).map((s) => {
            if ((s + 1) * mss > miniStream.length) throw new ResumeFileError('damaged');
            return miniStream.subarray(s * mss, s * mss + mss);
        });
        return Buffer.concat(parts).subarray(0, size);
    };
    return {
        names: entries.map((e) => e.name),
        get(name) {
            const e = entries.find((x) => x.name === name && x.type === 2);
            if (!e) return null;
            return e.size < cutoff ? readMini(e.start, e.size) : readBig(e.start, e.size);
        },
    };
}

// Windows-1252's 0x80-0x9F — the "8-bit" pieces of a .doc are this code page, not Latin-1 (smart quotes, dashes).
const CP1252 = {
    0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8A: 'Š',
    0x8B: '‹', 0x8C: 'Œ', 0x8E: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—',
    0x98: '˜', 0x99: '™', 0x9A: 'š', 0x9B: '›', 0x9C: 'œ', 0x9E: 'ž', 0x9F: 'Ÿ',
};
// ⚠️ IN BULK, NEVER BYTE BY BYTE (review, 2026-09-20). `s += …` once per byte cost 8.9 SECONDS and half a gigabyte
// of RSS on a 9.9 MB .txt — and this runs synchronously inside the HTTP request, so every other user's request
// waited those seconds (measured: one such upload blocked the event loop for 5.1 s). 'latin1' is the same
// byte-for-code-unit decode, done in C, and the 32 code points Windows-1252 puts where Latin-1 has controls are
// swapped by ONE bounded character-class replace — no backtracking, 110 ms for that file, and the string it returns
// is identical for every one of the 256 byte values.
const CP1252_HIGH = /[-]/g;
function cp1252(bytes) {
    const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    return b.toString('latin1').replace(CP1252_HIGH, (c) => CP1252[c.charCodeAt(0)] || '');
}

/**
 * Word 97-2003's own markup in the character stream → plain text (field results kept, field codes dropped).
 * ⚠️ Collected into an array and joined once, and stopped at MAX_MARKUP_CHARS: `out += ch` per character, over a
 * .doc that can be ten megabytes, is the same rope-building that cost seconds and hundreds of MB in cp1252 — and
 * every character past the cap is thrown away by extractText anyway (review, 2026-09-20).
 */
function cleanWordChars(raw) {
    const parts = [];
    let size = 0;
    const put = (t) => { parts.push(t); size += t.length; };
    const fields = [];   // per open field: true while inside its INSTRUCTION (between 0x13 and 0x14)
    // ⚠️ How many of `fields` are true, kept as a count: `fields.some(Boolean)` per character was quadratic in the
    // number of open fields (a stream of 0x13 0x14 pairs, then text — review, 2026-09-20).
    let inInstruction = 0;
    for (let i = 0; i < raw.length && size < MAX_MARKUP_CHARS; i++) {
        const c = raw.charCodeAt(i);
        if (c === 0x13) { fields.push(true); inInstruction++; continue; }
        if (c === 0x14) { if (fields.length && fields[fields.length - 1]) { fields[fields.length - 1] = false; inInstruction--; } continue; }
        if (c === 0x15) { if (fields.length && fields.pop()) inInstruction--; continue; }
        if (inInstruction > 0) continue;
        if (c === 0x0D || c === 0x0B || c === 0x0C) put('\n');
        else if (c === 0x07) put('\t');
        else if (c === 0x1E) put('-');
        else if (c === 0xA0) put(' ');
        else if (c === 0x09 || c === 0x0A || c >= 0x20) put(raw[i]);
        // everything else (0x01 picture, 0x02 footnote ref, 0x05 comment ref, 0x08 drawn object, 0x1F soft hyphen) goes
    }
    return parts.join('');
}

/**
 * The FIB header of a Word 97-2003 file — what it is, and whether it can be read at all.
 * Throws ResumeFileError('old_word' / 'encrypted' / 'damaged'). ⚠️ This is all sniff() needs: it used to call
 * docText and throw the text away, so every .doc was parsed TWICE per inspectResumeFile and four times across one
 * upload — 926 ms of pure duplicate work on a 6.7 MB file, on the one event loop (review, 2026-09-20).
 */
function docFib(cfb) {
    const wd = cfb.get('WordDocument');
    if (!wd || wd.length < 0x1AA) throw new ResumeFileError('damaged');
    const wIdent = wd.readUInt16LE(0), nFib = wd.readUInt16LE(2);
    if (wIdent === 0xA5DC || (wIdent === 0xA5EC && nFib < 0xC1)) throw new ResumeFileError('old_word');
    if (wIdent !== 0xA5EC) throw new ResumeFileError('damaged');
    const flags = wd.readUInt16LE(0x0A);
    if (flags & 0x0100 || flags & 0x8000) throw new ResumeFileError('encrypted');
    return { wd, flags };
}

/** The main-document text of a Word 97-2003 file. Throws ResumeFileError for Word 6/95 and encrypted files. */
function docText(buf, cfb) {
    const { wd, flags } = docFib(cfb);
    const table = cfb.get(flags & 0x0200 ? '1Table' : '0Table');
    if (!table) throw new ResumeFileError('damaged');
    const ccpText = wd.readUInt32LE(0x4C);
    const fcClx = wd.readUInt32LE(0x1A2), lcbClx = wd.readUInt32LE(0x1A6);
    if (fcClx + lcbClx > table.length || lcbClx < 5) throw new ResumeFileError('damaged');
    const clx = table.subarray(fcClx, fcClx + lcbClx);
    let p = 0;
    while (p < clx.length && clx[p] === 0x01) p += 3 + clx.readUInt16LE(p + 1);   // skip the Prc blocks
    if (p >= clx.length || clx[p] !== 0x02) throw new ResumeFileError('damaged');
    const lcb = clx.readUInt32LE(p + 1);
    const plc = clx.subarray(p + 5, p + 5 + lcb);
    if (plc.length !== lcb || (lcb - 4) % 12) throw new ResumeFileError('damaged');
    const n = (lcb - 4) / 12;
    let raw = '';
    // ⚠️ The pieces are ranges of the WordDocument stream that do not overlap, so together they cannot hold more
    // characters than the stream has bytes. A piece table that repeats one range (0→N, N→0, 0→N, …) used to build a
    // string of hundreds of millions of characters before failing; it is damage, and is refused as such at once.
    let total = 0;
    for (let i = 0; i < n; i++) {
        const cpStart = plc.readUInt32LE(i * 4);
        const cpEnd = Math.min(plc.readUInt32LE((i + 1) * 4), ccpText);   // the main document only — not footnotes or headers
        if (cpStart >= cpEnd) continue;
        const fcRaw = plc.readUInt32LE((n + 1) * 4 + i * 8 + 2);
        const compressed = !!(fcRaw & 0x40000000);
        const fc = fcRaw & 0x3FFFFFFF;
        const len = cpEnd - cpStart;
        if ((total += len) > wd.length) throw new ResumeFileError('damaged');
        if (compressed) {
            const at = fc / 2;
            if (at + len > wd.length) throw new ResumeFileError('damaged');
            raw += cp1252(wd.subarray(at, at + len));
        } else {
            if (fc + len * 2 > wd.length) throw new ResumeFileError('damaged');
            raw += wd.subarray(fc, fc + len * 2).toString('utf16le');
        }
    }
    return cleanWordChars(raw);
}

/* ── RTF ──────────────────────────────────────────────────────────────────────────────────────────────── */

// Groups whose contents are never page text. ⚠️ `\*` before any control word marks an ignorable destination too.
const RTF_SKIP = new Set([
    'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'listtable', 'listoverridetable', 'rsidtbl',
    'generator', 'xmlnstbl', 'themedata', 'colorschememapping', 'datastore', 'latentstyles', 'fldinst', 'revtbl',
    'filetbl', 'mmathPr', 'pntxta', 'pntxtb', 'bkmkstart', 'bkmkend', 'shpinst', 'nonshppict', 'wgrffmtfilter',
    'pgdsctbl', 'protusertbl', 'listtext', 'userprops', 'docvar', 'template', 'operator', 'author', 'title',
]);
const RTF_CHARS = {
    par: '\n', line: '\n', sect: '\n', page: '\n', row: '\n', tab: '\t', cell: '\t',
    emdash: '—', endash: '–', bullet: '•', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”',
    emspace: ' ', enspace: ' ', qmspace: ' ',
};

// A control word and its argument, matched AT a position (sticky) — never a slice per backslash.
const RTF_WORD = /([a-zA-Z]{1,32})(-?\d{1,10})? ?/y;
// A run of ordinary text: everything up to the next control sequence, group or line break. Sticky and a plain
// character class, so it is matched at the position and cannot backtrack.
const RTF_PLAIN = /[^\\{}\r\n]+/y;
// Real RTF nests a few dozen groups deep. Past this, groups are only counted (they share the deepest state): ten
// million "{" used to be ten million saved states — hundreds of MB from a 10 MB upload (review, 2026-09-20).
const RTF_MAX_DEPTH = 256;

function rtfText(buf) {
    const s = buf.toString('latin1');
    // ⚠️ COLLECTED, BOUNDED, AND IN RUNS (review, 2026-09-20). `out += ch` once per character, on the one event loop,
    // held a 9.5 MB .rtf for 4.2 seconds and 460 MB of RSS — and everything past MAX_MARKUP_CHARS is thrown away by
    // extractText anyway. So: parts joined once, the walk stops at the cap, and a stretch with no control sequence in
    // it is taken whole (RTF_PLAIN, a character class — bounded, never backtracking) instead of a character at a time.
    const parts = [];
    let size = 0;
    let st = { skip: false, uc: 1 };
    const stack = [];
    let deeper = 0;                  // open groups past RTF_MAX_DEPTH
    let pendingSkipChars = 0;        // fallback characters owed after a \uN
    let i = 0;
    // ⚠️ Exactly what emitting `t` one character at a time did: the \uN fallback owes `uc` characters, and a run
    // pays that debt from its front before any of it is kept.
    const emit = (t) => {
        if (st.skip) return;
        if (pendingSkipChars > 0) {
            if (t.length <= pendingSkipChars) { pendingSkipChars -= t.length; return; }
            t = t.slice(pendingSkipChars);
            pendingSkipChars = 0;
        }
        parts.push(t); size += t.length;
    };
    while (i < s.length && size < MAX_MARKUP_CHARS) {
        const ch = s[i];
        if (ch === '{') {
            if (stack.length < RTF_MAX_DEPTH) { stack.push(st); st = { ...st }; } else deeper++;
            pendingSkipChars = 0; i++; continue;
        }
        if (ch === '}') {
            if (deeper > 0) deeper--; else st = stack.pop() || { skip: false, uc: 1 };
            pendingSkipChars = 0; i++; continue;
        }
        if (ch === '\r' || ch === '\n') { i++; continue; }
        if (ch !== '\\') {                                    // ordinary text: take the whole run, not one character
            RTF_PLAIN.lastIndex = i;
            const run = RTF_PLAIN.exec(s);
            const t = run ? run[0] : ch;
            emit(t); i += t.length; continue;
        }
        // A control sequence.
        const nx = s[i + 1];
        if (nx === undefined) break;
        if (nx === '\\' || nx === '{' || nx === '}') { emit(nx); i += 2; continue; }
        if (nx === '~') { emit(' '); i += 2; continue; }
        if (nx === '_') { emit('-'); i += 2; continue; }
        if (nx === '-') { i += 2; continue; }
        if (nx === '*') { st.skip = true; i += 2; continue; }
        if (nx === '\'') {
            const hex = s.slice(i + 2, i + 4);
            const b = parseInt(hex, 16);
            if (!Number.isNaN(b)) emit(cp1252([b]));
            i += 4; continue;
        }
        if (nx === '\r' || nx === '\n') { emit('\n'); i += 2; continue; }   // "\<newline>" is a \par
        RTF_WORD.lastIndex = i + 1;
        const m = RTF_WORD.exec(s);
        if (!m) { i += 2; continue; }
        const word = m[1], arg = m[2] != null ? Number(m[2]) : null;
        i += 1 + m[0].length;
        if (word === 'bin' && arg > 0) { i += arg; continue; }
        if (RTF_SKIP.has(word)) { st.skip = true; continue; }
        if (word === 'uc' && arg != null) { st.uc = Math.max(0, arg); continue; }
        if (word === 'u' && arg != null) {
            emit(safeCodePoint(arg < 0 ? arg + 65536 : arg));
            pendingSkipChars = st.uc;
            continue;
        }
        if (RTF_CHARS[word] !== undefined) { emit(RTF_CHARS[word]); continue; }
        // every other control word is formatting
    }
    return parts.join('');
}

/* ── plain text ───────────────────────────────────────────────────────────────────────────────────────── */

/** Decoded text, or null when the bytes are not text (binary, or a format this module does not know). */
function plainText(buf) {
    let t;
    if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) t = buf.subarray(2).toString('utf16le');
    else if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
        const sw = Buffer.from(buf.subarray(2));
        for (let i = 0; i + 1 < sw.length; i += 2) { const a = sw[i]; sw[i] = sw[i + 1]; sw[i + 1] = a; }
        t = sw.toString('utf16le');
    } else {
        if (buf.includes(0)) return null;                         // binary, or UTF-16 with no BOM — neither is a .txt
        const start = (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) ? 3 : 0;
        t = buf.subarray(start).toString('utf8');
        if (t.includes('�')) t = cp1252(buf.subarray(start));   // not UTF-8: Windows-1252
    }
    // ⚠️ By index, not `for (const ch of t)`: iterating a ten-million-character string as code points cost 810 ms
    // where charCodeAt costs 117 ms, for the same count (review, 2026-09-20).
    let ctl = 0;
    for (let i = 0; i < t.length; i++) { const c = t.charCodeAt(i); if (c < 0x20 && c !== 9 && c !== 10 && c !== 13 && c !== 12) ctl++; }
    if (t.length && ctl / t.length > 0.01) return null;
    return t;
}

/* ── sniffing ─────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * What this file REALLY is, from its bytes — the name and the phone's MIME type are hints at best (iOS hands a
 * .docx over as application/octet-stream, and a renamed file is still what its bytes say).
 * Returns accept(kind) or refuse(reason). Never throws.
 */
function sniff(buf) {
    try {
        if (!buf || !buf.length) return refuse('empty');
        const head = buf.subarray(0, 1024).toString('latin1');
        const pdfAt = head.indexOf('%PDF-');
        if (pdfAt >= 0) return accept('pdf');
        if (buf[0] === 0x89 && head.startsWith('\x89PNG')) return accept('png');
        if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return accept('jpg');
        if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return accept('webp');
        if (head.slice(4, 8) === 'ftyp' && /^(heic|heix|mif1|msf1|heim|heis|hevc)/.test(head.slice(8, 12))) return accept('heic');
        if (buf.readUInt32LE(0) === 0x04034b50) {                  // PK\3\4 — a ZIP container
            const entries = zipEntries(buf);
            const names = new Set(entries.map((e) => e.name));
            if (names.has('word/document.xml')) return accept('docx');
            if (names.has('content.xml')) {
                const mt = zipRead(buf, entries, 'mimetype', zipBudget(4096));   // 39 bytes in a real .odt
                if (mt && /opendocument\.text/.test(String(mt))) return accept('odt');
            }
            return refuse('unsupported');                          // .pages, .xlsx, .pptx, a plain zip…
        }
        if (buf.length >= 8 && buf.readUInt32LE(0) === 0xe011cfd0) {  // OLE2
            const cfb = cfbOpen(buf);
            if (cfb.names.includes('EncryptedPackage')) return refuse('encrypted');   // a password-protected .docx
            if (!cfb.names.includes('WordDocument')) return refuse('unsupported');     // .xls, .ppt, .msg…
            docFib(cfb);                                           // Word 6/95 or encrypted throw with their own reason
            return accept('doc');
        }
        if (/^\s*\{\\rtf/.test(head)) return accept('rtf');
        if (plainText(buf.subarray(0, Math.min(buf.length, 64 * 1024))) != null) return accept('txt');
        return refuse('unsupported');
    } catch (e) {
        return refuse(e instanceof ResumeFileError ? e.reason : 'damaged');
    }
}

/**
 * A "Word document" that is really a web page — CV builders and Word's own "Save as Web Page" produce .doc files that
 * are HTML inside. It sniffs as text; this turns the markup into the lines a reader sees.
 */
const HTML_SKIP = new Set(['script', 'style', 'head']);
const HTML_BREAK = new Set(['p', 'div', 'li', 'tr', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
function htmlTag(name, closing) {
    if (closing) return HTML_BREAK.has(name) ? '\n' : (name === 'td' || name === 'th') ? '\t' : '';
    return name === 'br' ? '\n' : '';
}
function htmlToText(t) {
    return decodeXmlEntities(markupText(t, { skip: HTML_SKIP, onTag: htmlTag, caseless: true, max: MAX_MARKUP_CHARS })
        .replace(/&(nbsp|ndash|mdash|lsquo|rsquo|ldquo|rdquo|bull|hellip|middot);/gi, (_, n) => HTML_NAMED[n.toLowerCase()]));
}
const HTML_NAMED = { nbsp: ' ', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', hellip: '…', middot: '·' };

/**
 * Tidy what any reader produced: no NULs, no runs of blank lines, no trailing spaces.
 * ⚠️ Line by line, not `[ \t]+\n` over the whole text: that regex backtracks over every run of spaces, so a .txt with
 * 20,000 spaces in it held the event loop for 5 seconds and a 10 MB one would never come back (review, 2026-09-20).
 */
function tidy(t) {
    const lines = String(t || '').replace(/ /g, '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let blank = 0;
    for (const line of lines) {
        let e = line.length;
        while (e > 0 && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;   // trailing spaces/tabs
        const l = e === line.length ? line : line.slice(0, e);
        if (!l) { if (++blank > 1) continue; } else blank = 0;   // at most one blank line between paragraphs
        out.push(l);
    }
    return out.join('\n').trim();
}

// No CV is longer than this; what a bigger file holds is not a résumé, and everything downstream (the model's prompt,
// resume_metadata.raw_text, the country back-fill) is better off never seeing megabytes of it.
const MAX_TEXT_CHARS = 400 * 1000;
// What a reader may collect before tidying (tidy only ever shrinks): enough slack that no real document is shortened.
const MAX_MARKUP_CHARS = MAX_TEXT_CHARS * 3;

/**
 * The text of a docx / doc / odt / rtf / txt, or throws ResumeFileError. `kind` is sniff()'s; a kind this
 * module does not read (pdf, images) is a programming error and throws too.
 */
function extractText(buf, kind) {
    let t;
    if (kind === 'docx') t = docxText(buf, zipEntries(buf));
    else if (kind === 'odt') t = odtText(buf, zipEntries(buf));
    else if (kind === 'doc') t = docText(buf, cfbOpen(buf));
    else if (kind === 'rtf') t = rtfText(buf);
    else if (kind === 'txt') {
        t = plainText(buf);
        if (t == null) throw new ResumeFileError('unsupported');
        if (t.length > MAX_MARKUP_CHARS) t = t.slice(0, MAX_MARKUP_CHARS);
        if (/<(html|body)\b/i.test(t.slice(0, 4096))) t = htmlToText(t);
    }
    else throw new Error(`resumeText cannot read ${kind}`);
    const text = tidy(t);
    return text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
}

/**
 * The upload's question, answered before anything is committed: is this a CV the server can read?
 * { ok: true, kind, ext, mime, label, text? } — `text` for the kinds read here (checked non-trivial);
 * { ok: false, reason, message } otherwise. PDFs and images are accepted on their bytes alone: a scanned PDF
 * legitimately has no text layer, and the vision reader is what reads it.
 */
function inspectResumeFile(buf) {
    const fmt = sniff(buf);
    if (!fmt.ok || !TEXT_KINDS.has(fmt.kind)) return fmt;
    try {
        const text = extractText(buf, fmt.kind);
        if (text.replace(/\s+/g, ' ').trim().length < 50) return refuse('empty');
        return { ...fmt, text };
    } catch (e) {
        return refuse(e instanceof ResumeFileError ? e.reason : 'damaged');
    }
}

/** The extension a stored file should carry for `kind` ('.pdf' when unknown). */
const extOf = (kind) => (FORMATS[kind] && FORMATS[kind].ext) || '.pdf';

/** The kind a stored path's extension names, for files written before sniffing existed. */
function kindOfPath(p) {
    const ext = path.extname(String(p || '')).toLowerCase();
    if (ext === '.jpeg') return 'jpg';
    const hit = Object.keys(FORMATS).find((k) => FORMATS[k].ext === ext);
    return hit || null;
}

module.exports = {
    MESSAGES, FORMATS, TEXT_KINDS, ResumeFileError, MAX_UPLOAD_BYTES,
    sniff, extractText, inspectResumeFile, extOf, kindOfPath,
    // exposed for the suite
    _internals: { zipEntries, zipRead, cfbOpen, rtfText, plainText, docText, cleanWordChars, cp1252, markupText, tidy, htmlToText, MAX_TEXT_CHARS, ZIP_DOC_MAX, ZIP_HEADERS_MAX },
};
