// A CV IN ANY FORMAT THE APP PROMISES — services/resumeText.js and the résumé upload (2026-09-19).
//
//   node server/scripts/test-resume-text.js
//
// The owner: "for resume it says upload pdf only... it should say both pdf or any type of document too". The server
// could not read anything but PDF and images, and /users/profile/resume saved ANY file as the résumé before checking
// — so a .docx replaced a good CV and failed in the background with nothing on screen. This pins:
//   1. the exact text of real files in every promised format (fixtures made with macOS textutil, committed under
//      server/scripts/fixtures/cv/) plus a .docx written by the `docx` package this server already ships;
//   2. every refusal: Word 95, a password, .pages / .xlsx / .xls, random bytes, an empty file, a truncated one;
//   3. the upload itself, over real HTTP through the real router + multer + controller: a file the server cannot read
//      is refused with 415 BEFORE it is committed (the CV on file is untouched), a Word file arriving as ".bin" is
//      stored as ".docx", the parse is marked pending BEFORE the answer, and a file past what any reader here can
//      take (18 MB, services/resumeText.MAX_UPLOAD_BYTES) is a 413 the app can show — while a 12 MB scanned PDF,
//      which pdf-parse and the vision reader handle perfectly, is still accepted;
//   4. and what must never be lost: a .docx's footers, a .doc whose FAT the header cannot list, a stream read short
//      in silence, and a big .txt / .rtf / .doc read without holding the event loop for seconds (section 7c).
'use strict';
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const ROOT = path.join(__dirname, '..', '..');
process.chdir(ROOT);   // the upload root is <cwd>/uploads, as on the server

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x).slice(0, 400) : '')); }
};

const T = require(path.join(ROOT, 'services', 'resumeText.js'));
const FIX = path.join(__dirname, 'fixtures', 'cv');
const fx = (f) => fs.readFileSync(path.join(FIX, f));
const EXPECT = [
  'Priya Sharma',
  'Senior Project Manager — Pune, India · priya@example.com',
  'Experience',
  'Project Manager at Tata Consultancy Services, 2016–2024',
  '•\tLed a 14-person team delivering “Atlas”, a payments platform.',
  '•\tCut release time by 30% with café-style stand-ups.',
  'Education',
  'B.E. Computer Engineering, University of Pune, 2015',
];
// Bullets are a list style in some writers and a character in others — compare the words, not the list glyphs.
const words = (t) => String(t).replace(/[•\t]/g, ' ').replace(/\s+/g, ' ').trim();

/** A minimal STORED zip (no compression) — enough to fabricate .pages / .xlsx / odd .docx files for refusals. */
function storedZip(files) {
  const locals = [], centrals = [];
  let off = 0;
  for (const [name, content] of Object.entries(files)) {
    const nb = Buffer.from(name), data = Buffer.from(content);
    const crc = zlib.crc32 ? zlib.crc32(data) : 0;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc >>> 0, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
    locals.push(lh, nb, data);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc >>> 0, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    centrals.push(ch, nb);
    off += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(Object.keys(files).length, 8); e.writeUInt16LE(Object.keys(files).length, 10);
  e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
}
const W = (body) => `<?xml version="1.0"?><w:document xmlns:w="w" xmlns:mc="mc"><w:body>${body}</w:body></w:document>`;

/** A zip whose entries are DEFLATED, as Word and LibreOffice write them — what a bomb needs. A value may be
 *  { deflated, usize } to reuse one compressed blob under many names (60 header parts without 2 GB in this process). */
function deflatedZip(files) {
  const locals = [], centrals = [];
  let off = 0;
  for (const [name, content] of Object.entries(files)) {
    const nb = Buffer.from(name);
    const pre = content && content.deflated ? content : null;
    const raw = pre ? null : Buffer.from(content);
    const data = pre ? pre.deflated : zlib.deflateRawSync(raw, { level: 9 });
    const usize = pre ? pre.usize : raw.length;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(usize, 22); lh.writeUInt16LE(nb.length, 26);
    locals.push(lh, nb, data);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(usize, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    centrals.push(ch, nb);
    off += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(Object.keys(files).length, 8); e.writeUInt16LE(Object.keys(files).length, 10);
  e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
}

/**
 * An OLE2 (".doc") built sector by sector, so a LAYOUT can be tested rather than a whole Word document.
 *   streams       — { name: Buffer }, each laid out contiguously from sector 0 and named in the directory
 *   fatSectors    — how many FAT sectors the header CLAIMS (csectFat)
 *   listInHeader  — how many of them it actually LISTS in its 109 slots; the rest follow the last one contiguously,
 *                   which is exactly how macOS's textutil / TextEdit write a .doc bigger than ~7.1 MB
 *   extraSectors  — filler sectors the FAT does not describe
 */
function cfbFile({ streams, fatSectors, listInHeader = 109, extraSectors = 0 }) {
  const SS = 512, out = [];
  let at = 0;
  const put = (buf) => { const start = at; for (let o = 0; o < buf.length; o += SS) { const s = Buffer.alloc(SS); buf.copy(s, 0, o, Math.min(o + SS, buf.length)); out.push(s); at++; } return start; };
  const dirEntries = [{ name: 'Root Entry', type: 5, start: -2, size: 0 }];
  const runs = [];
  for (const [name, data] of Object.entries(streams)) {
    const start = put(data);
    runs.push([start, at - start]);
    dirEntries.push({ name, type: 2, start, size: data.length });
  }
  const dir = Buffer.alloc(SS * Math.ceil(dirEntries.length / 4));
  dirEntries.forEach((e, i) => {
    const o = i * 128, nb = Buffer.from(e.name + '\0', 'utf16le');
    nb.copy(dir, o); dir.writeUInt16LE(nb.length, o + 64); dir[o + 66] = e.type;
    dir.writeInt32LE(-1, o + 68); dir.writeInt32LE(-1, o + 72); dir.writeInt32LE(-1, o + 76);
    dir.writeInt32LE(e.start, o + 116); dir.writeUInt32LE(e.size, o + 120);
  });
  const dirStart = put(dir), dirLen = at - dirStart;
  for (let i = 0; i < extraSectors; i++) { out.push(Buffer.alloc(SS)); at++; }
  const fatStart = at;
  for (let i = 0; i < fatSectors; i++) { out.push(Buffer.alloc(SS, 0xFF)); at++; }   // FREESECT everywhere by default
  const setFat = (sector, value) => {
    const f = fatStart + Math.floor(sector / 128);
    if (f < fatStart + fatSectors) out[f].writeInt32LE(value, (sector % 128) * 4);
  };
  for (const [start, n] of [...runs, [dirStart, dirLen]]) for (let k = 0; k < n; k++) setFat(start + k, k === n - 1 ? -2 : start + k + 1);
  for (let i = 0; i < fatSectors; i++) setFat(fatStart + i, -3);                     // FATSECT
  const h = Buffer.alloc(SS, 0xFF);
  h.writeUInt32LE(0xe011cfd0, 0); h.writeUInt32LE(0xe11ab1a1, 4);
  h.writeUInt16LE(3, 26); h.writeUInt16LE(0xFFFE, 28); h.writeUInt16LE(9, 30); h.writeUInt16LE(6, 32);
  h.writeUInt32LE(fatSectors, 44); h.writeInt32LE(dirStart, 48); h.writeUInt32LE(4096, 56);
  h.writeInt32LE(-2, 60); h.writeInt32LE(-2, 68); h.writeUInt32LE(0, 72);            // no mini-FAT, and NO DIFAT sector
  for (let i = 0; i < Math.min(listInHeader, 109); i++) h.writeInt32LE(fatStart + i, 76 + i * 4);
  return Buffer.concat([h, ...out]);
}

/** An OLE2 (".doc") header whose DIF sector names itself as the next one, claiming `nDif` of them and `nFat` FAT sectors. */
function difLoopDoc(nDif, nFat) {
  const b = Buffer.alloc(512 * 3);
  b.writeUInt32LE(0xe011cfd0, 0); b.writeUInt32LE(0xe11ab1a1, 4);
  b.writeUInt16LE(3, 26); b.writeUInt16LE(0xFFFE, 28); b.writeUInt16LE(9, 30); b.writeUInt16LE(6, 32);
  b.writeUInt32LE(nFat, 44); b.writeInt32LE(1, 48); b.writeUInt32LE(4096, 56); b.writeInt32LE(-2, 60);
  b.writeInt32LE(0, 68); b.writeUInt32LE(nDif, 72);          // the DIF chain starts at sector 0 …
  for (let i = 0; i < 128; i++) b.writeInt32LE(0, 512 + i * 4);   // … whose "next DIF sector" is sector 0 again
  return b;
}

/** The .doc fixture with its FIB (WordDocument stream start) edited: the sector whose first word is 0xA5EC. */
function docWith(mutate) {
  const b = Buffer.from(fx('cv.doc'));
  for (let o = 512; o + 0x20 < b.length; o += 512) {
    if (b.readUInt16LE(o) === 0xA5EC && b.readUInt16LE(o + 2) >= 0xC1) { mutate(b, o); return b; }
  }
  throw new Error('no FIB found in the fixture');
}
/** The .doc fixture with its 'WordDocument' directory entry renamed (an .xls is 'Workbook', a locked .docx 'EncryptedPackage'). */
function docRenamed(to) {
  const b = Buffer.from(fx('cv.doc'));
  const from = Buffer.from('WordDocument\0', 'utf16le');
  const at = b.indexOf(from);
  if (at < 0) throw new Error('no WordDocument entry');
  const nb = Buffer.from(to + '\0', 'utf16le');
  b.fill(0, at, at + 64); nb.copy(b, at); b.writeUInt16LE(nb.length, at + 64);
  return b;
}

(async () => {
  console.log('\n── 1 · the text of every promised format, exactly ──');
  for (const f of ['docx', 'doc', 'odt', 'rtf', 'txt']) {
    const r = T.inspectResumeFile(fx('cv.' + f));
    ok(`.${f}: accepted as ${f}, with the right extension and MIME type`, r.ok && r.kind === f && r.ext === '.' + f && !!r.mime, { ok: r.ok, kind: r.kind, reason: r.reason });
    ok(`.${f}: the text is the document's, word for word — smart quotes, dashes, "café" and "·" intact`, r.ok && words(r.text) === words(EXPECT.join('\n')), r.text);
  }
  ok('⚠️ the RTF font table does not leak into the text (a naive stripper printed "Times-Roman;")',
    !/Times|Helvetica|;/.test(T.inspectResumeFile(fx('cv.rtf')).text));

  // A .docx from a different writer: the `docx` package the server already uses for its own Word downloads.
  try {
    const docx = require('docx');
    const d = new docx.Document({ sections: [{ headers: { default: new docx.Header({ children: [new docx.Paragraph('Aarav Mehta · +91 98765 43210')] }) },
      children: [new docx.Paragraph({ children: [new docx.TextRun({ text: 'Staff Engineer', bold: true }), new docx.TextRun('\tBengaluru')] }),
        new docx.Paragraph('Built the ledger service at Razorpay, 2018–2023; led four engineers across two releases.')] }] });
    const buf = await docx.Packer.toBuffer(d);
    const r = T.inspectResumeFile(buf);
    ok('a .docx written by another writer (the `docx` package): read, header (name + phone) included, tabs kept',
      r.ok && r.kind === 'docx' && /Aarav Mehta/.test(r.text) && /Staff Engineer\tBengaluru/.test(r.text) && /ledger service at Razorpay, 2018–2023/.test(r.text), r.text || r);
  } catch (e) { ok('the `docx` package wrote a file to read', false, e.message); }

  const edgy = storedZip({
    '[Content_Types].xml': '<Types/>',
    'word/document.xml': W('<w:p><w:r><w:t>Kept line with &amp; and &#233;</w:t></w:r><w:del><w:r><w:delText>DELETED-TEXT</w:delText></w:r></w:del></w:p>'
      + '<w:p><w:r><mc:AlternateContent><mc:Choice><w:t>Box once</w:t></mc:Choice><mc:Fallback><w:t>Box once</w:t></mc:Fallback></mc:AlternateContent></w:r></w:p>'
      + '<w:p><w:r><w:instrText>HYPERLINK "x"</w:instrText><w:t>Link text</w:t><w:br/><w:t>after break, enough words to count as a résumé here</w:t></w:r></w:p>'),
  });
  const er = T.inspectResumeFile(edgy);
  ok('docx: tracked DELETIONS and field codes are not text; a text box is read once; entities and <w:br/> decoded',
    er.ok && !/DELETED-TEXT|HYPERLINK/.test(er.text) && (er.text.match(/Box once/g) || []).length === 1 && /Kept line with & and é/.test(er.text) && /Link text\nafter break/.test(er.text), er.text || er);

  const u16 = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(EXPECT.join('\r\n'), 'utf16le')]);
  ok('.txt in UTF-16 with a BOM (Notepad\'s "Unicode") is read', words(T.inspectResumeFile(u16).text) === words(EXPECT.join('\n')));
  const w1252 = Buffer.concat([Buffer.from('Caf'), Buffer.from([0xE9]), Buffer.from(' '), Buffer.from([0x93]), Buffer.from('Atlas'), Buffer.from([0x94]),
    Buffer.from(' '), Buffer.from([0x96]), Buffer.from(' Project Manager, Tata Consultancy Services, 2016 to 2024.')]);
  ok('.txt in Windows-1252 (not UTF-8) is decoded as 1252 — é, “ ”, – — not as "�"', T.inspectResumeFile(w1252).text === 'Café “Atlas” – Project Manager, Tata Consultancy Services, 2016 to 2024.', T.inspectResumeFile(w1252).text);

  const webDoc = Buffer.from('<html><head><style>p{color:red}</style></head><body><p>Priya Sharma</p><p>Project Manager at Tata Consultancy Services, 2016&ndash;2024 &amp; more</p><br><table><tr><td>Skills</td><td>Delivery</td></tr></table></body></html>');
  const wr = T.inspectResumeFile(webDoc);
  ok('a ".doc" that is really a web page (CV builders, "Save as Web Page") is read as its text, not its markup',
    wr.ok && /^Priya Sharma\nProject Manager at Tata Consultancy Services, 2016–2024 & more/.test(wr.text) && !/<|color:red|&ndash;/.test(wr.text) && /Skills\tDelivery/.test(wr.text), wr.text || wr);

  console.log('\n── 2 · PDFs and images are accepted on their bytes (their text is the parser\'s pdf-parse / vision job) ──');
  const PDFDocument = require('pdfkit');
  const pdf = await new Promise((resolve) => { const d = new PDFDocument(); const parts = []; d.on('data', (c) => parts.push(c)); d.on('end', () => resolve(Buffer.concat(parts))); d.text('Priya Sharma — Project Manager'); d.end(); });
  const p = T.inspectResumeFile(pdf);
  ok('a PDF → pdf, and no text is demanded of it here (a scan has none; vision reads it)', p.ok && p.kind === 'pdf' && p.ext === '.pdf' && p.text === undefined, p);
  ok('PNG / JPEG / HEIC bytes → images (read by vision), whatever the name says',
    T.sniff(Buffer.from('\x89PNG\r\n\x1a\n0000', 'latin1')).kind === 'png' && T.sniff(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0])).kind === 'jpg'
    && T.sniff(Buffer.from('\0\0\0\x18ftypheic0000', 'latin1')).kind === 'heic');

  console.log('\n── 3 · ⚠️ what is REFUSED, and the sentence that goes with it ──');
  const refusal = (buf) => { const r = T.inspectResumeFile(buf); return r.ok ? 'ACCEPTED ' + r.kind : r.reason; };
  ok('Word 6 / 95 → old_word ("save it as .docx or PDF")', refusal(docWith((b, o) => b.writeUInt16LE(0xA5DC, o))) === 'old_word' && /Word 95/.test(T.MESSAGES.old_word));
  ok('a password-protected .doc → encrypted', refusal(docWith((b, o) => b.writeUInt16LE(b.readUInt16LE(o + 0x0A) | 0x0100, o + 0x0A))) === 'encrypted');
  ok('a password-protected .docx (an OLE2 "EncryptedPackage") → encrypted', refusal(docRenamed('EncryptedPackage')) === 'encrypted');
  ok('an .xls (OLE2 with a Workbook, no WordDocument) → unsupported', refusal(docRenamed('Workbook')) === 'unsupported');
  ok('a .pages file (a zip with no word/document.xml) → unsupported', refusal(storedZip({ 'Index/Document.iwa': 'x', 'Metadata/Properties.plist': 'y' })) === 'unsupported');
  ok('an .xlsx → unsupported', refusal(storedZip({ '[Content_Types].xml': '<Types/>', 'xl/workbook.xml': '<workbook/>' })) === 'unsupported');
  ok('random bytes → unsupported; nothing → empty', refusal(Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919) % 256))) === 'unsupported' && refusal(Buffer.alloc(0)) === 'empty');
  const doc = fx('cv.docx');
  ok('a truncated .docx (a broken download) → damaged, never a throw', refusal(doc.subarray(0, Math.floor(doc.length / 2))) === 'damaged');
  ok('a .docx with no words in it → empty ("if it is a scan, upload it as a PDF")',
    refusal(storedZip({ 'word/document.xml': W('<w:p><w:r><w:t>  </w:t></w:r></w:p>') })) === 'empty' && /scan/.test(T.MESSAGES.empty));
  ok('every refusal sentence names what to do instead', Object.values(T.MESSAGES).every((m) => /PDF|\.docx|smaller|password/.test(m)));

  console.log('\n── 4 · the upload over real HTTP: router → multer → uploadResume ──');
  // The world uploadResume talks to, faked: the database, the parser (it must NOT really run), analytics.
  const runs = [];
  const order = [];
  const dbPath = require.resolve(path.join(ROOT, 'db-config.js'));
  let dbGet = async () => null;   // section 4b scripts reads
  let onRun = () => {};           // section 4c applies profile writes to its fake account
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
    get: (...a) => dbGet(...a), query: async () => [], rawDb: () => ({}), initializeConnection: () => {},
    run: async (sql, p) => { runs.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), p }); if (/UPDATE users SET resume_path/.test(sql)) order.push('commit'); onRun(String(sql), p); return {}; },
  } };
  const stub = (rel, exports) => { const p2 = require.resolve(path.join(ROOT, rel)); require.cache[p2] = { id: p2, filename: p2, loaded: true, exports }; };
  const parser = { pending: [], triggered: [] };
  stub('services/resumeParserService.js', {
    markParsePending: async (u) => { parser.pending.push(u); order.push('pending'); },
    triggerResumeParsingBackground: (u, rel) => { parser.triggered.push({ u, rel }); order.push('parse'); },
  });
  stub('server/controllers/notificationsController.js', { notifyProfileUpdated: async () => {} });
  stub('server/services/track.js', { emit: () => {} });
  const express = require('express');
  const router = require(path.join(ROOT, 'server', 'routes', 'profileRoutes.js'));
  const UID = 'zz_cvfmt_' + process.pid;
  const app = express();
  app.use(express.json());   // as server.js does, globally
  app.use((req, res, next) => { req.user = { id: UID }; const j = res.json.bind(res); res.json = (b) => { order.push('answer'); return j(b); }; next(); });
  app.use('/api/users', router);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/users`;
  const dir = path.join(ROOT, 'uploads', `user_${UID}`);
  const post = async (name, bytes, type = 'application/octet-stream') => {
    const form = new FormData();
    form.append('resume', new Blob([bytes], { type }), name);
    const r = await fetch(`${base}/profile/resume`, { method: 'POST', body: form });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const filesNow = () => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);
  try {
    runs.length = 0; order.length = 0;
    const bad = await post('resume.pages', storedZip({ 'Index/Document.iwa': 'x' }));
    ok('⚠️ an unreadable format → 415 with the sentence to show, reason unsupported_format',
      bad.status === 415 && bad.body && bad.body.reason === 'unsupported_format' && /PDF/.test(bad.body.error), bad);
    ok('⚠️ …BEFORE it was committed: users.resume_path untouched, no parse started, and the file is gone from disk',
      !runs.some((r) => /UPDATE users SET resume_path/.test(r.sql)) && parser.triggered.length === 0 && filesNow().length === 0, { runs: runs.map((r) => r.sql.slice(0, 40)), files: filesNow() });
    const locked = await post('cv.doc', docWith((b, o) => b.writeUInt16LE(b.readUInt16LE(o + 0x0A) | 0x0100, o + 0x0A)), 'application/msword');
    ok('a password-protected Word file → 415 "encrypted", the password sentence', locked.status === 415 && locked.body.reason === 'encrypted' && /password/.test(locked.body.error), locked);

    runs.length = 0; order.length = 0;
    const good = await post('My CV.bin', fx('cv.docx'));
    const stored = runs.find((r) => /UPDATE users SET resume_path/.test(r.sql));
    ok('a Word file → 200, format DOCX', good.status === 200 && good.body && good.body.success === true && good.body.format === 'DOCX', good);
    ok('⚠️ …stored under its REAL extension (".bin" in, ".docx" on disk and in users.resume_path) — the email paths name the attachment from it',
      !!stored && /\.docx$/.test(stored.p[0]) && filesNow().some((f) => /\.docx$/.test(f)) && !filesNow().some((f) => /\.bin$/.test(f)), { stored: stored && stored.p, files: filesNow() });
    ok('⚠️ …the parse is marked PENDING before the answer (a build tapped next cannot read the previous CV as this one)',
      order.indexOf('commit') < order.indexOf('pending') && order.indexOf('pending') < order.indexOf('answer') && parser.triggered.length === 1, order);
    const txt = await post('notes.txt', fx('cv.txt'), 'text/plain');
    const rtf = await post('cv.rtf', fx('cv.rtf'), 'application/rtf');
    const odt = await post('cv.odt', fx('cv.odt'));
    const pdfUp = await post('cv.pdf', pdf, 'application/pdf');
    ok('.txt, .rtf, .odt and .pdf uploads are all accepted, each stored with its own extension',
      [txt, rtf, odt, pdfUp].every((r) => r.status === 200) && ['.txt', '.rtf', '.odt', '.pdf'].every((e) => filesNow().some((f) => f.endsWith(e))), { txt: txt.status, rtf: rtf.status, odt: odt.status, pdf: pdfUp.status, files: filesNow() });

    runs.length = 0;
    const huge = await post('huge.pdf', Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(T.MAX_UPLOAD_BYTES + 4096, 0x20)]), 'application/pdf');
    ok('⚠️ a file over the ceiling → 413 JSON reason too_large (it used to have NO limit), and nothing committed',
      huge.status === 413 && huge.body && huge.body.reason === 'too_large' && /18 MB/.test(huge.body.error) && !runs.some((r) => /UPDATE users/.test(r.sql)), huge);
    // ⚠️ THE LIMIT IS THE READERS' OWN (review, 2026-09-20). It was first written as 10 MB, and every PDF and phone
    // photo between 10 MB and the 18 MB pdf-parse/vision can read — a photo-heavy export, a multi-page scan — was a
    // 413 on the app's own route, where CVs are actually picked, although it had uploaded and parsed fine the week
    // before (that route had no limit at all). The band is open again, and nothing in it is refused for its size.
    runs.length = 0;
    const twelveMb = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(12 * 1024 * 1024, 0x20), Buffer.from('\n%%EOF\n')]);
    const big = await post('scan.pdf', twelveMb, 'application/pdf');
    ok(`⚠️ a ${(twelveMb.length / 1e6).toFixed(0)} MB PDF CV (a scan, or a photo-heavy export) is ACCEPTED — the vision reader takes 18 MB`,
      big.status === 200 && big.body && big.body.format === 'PDF' && runs.some((r) => /UPDATE users SET resume_path/.test(r.sql)), big);
    ok('…and the route\'s limit IS that ceiling, not a number typed twice (services/resumeText.MAX_UPLOAD_BYTES)',
      T.MAX_UPLOAD_BYTES === 18 * 1024 * 1024 && / over 18 MB\./.test(T.MESSAGES.too_large)
      && /const VISION_MAX_BYTES = resumeText\.MAX_UPLOAD_BYTES;/.test(fs.readFileSync(path.join(ROOT, 'services', 'resumeParserService.js'), 'utf8'))
      && /limits: \{ fileSize: MAX_UPLOAD_BYTES/.test(fs.readFileSync(path.join(ROOT, 'server', 'routes', 'profileRoutes.js'), 'utf8')),
      T.MAX_UPLOAD_BYTES);

    // ── 4b · GET /users/profile keeps every old key and ADDS the wizard's state ──
    const docxOnDisk = filesNow().find((f) => f.endsWith('.docx'));
    const onbRows = {};
    dbGet = async (sql, p) => {
      const q = String(sql).replace(/\s+/g, ' ');
      if (/FROM users WHERE id = \?/.test(q) && /full_name as "fullName"/.test(q)) {
        return { fullName: 'Priya Sharma', email: 'p@e.st', resumePath: `uploads/user_${UID}/${docxOnDisk}`, photoPath: null, signaturePath: null,
          phoneNumber: '+91 98765 43210', address: 'Pune, India', dateOfBirth: null, gender: null, createdAt: null, oauthProvider: null };
      }
      if (/FROM user_onboarding WHERE user_id = \$1/.test(q)) return onbRows[p[0]] || null;
      if (/FROM resume_metadata WHERE user_id = \$1/.test(q)) return { parse_status: 'pending', parse_error: null };
      return null;
    };
    const prof = await (await fetch(`${base}/profile`)).json();
    ok('the old setup keys are exactly as before (DOB missing → profile false; only the CV on disk)',
      prof.setup && prof.setup.profile === false && prof.setup.resume === true && prof.setup.photo === false && prof.setup.signature === false && prof.setup.complete === false, prof.setup);
    ok('⚠️ …and setup.wizard is ADDED: no progress row yet → "none"; its CV is the DOCX on disk, being read; resumeParse mirrors it',
      prof.setup.wizard && prof.setup.wizard.state === 'none' && prof.setup.wizard.cv && prof.setup.wizard.cv.ext === 'DOCX' && prof.setup.wizard.cv.status === 'pending'
      && prof.resumeParse && prof.resumeParse.status === 'pending', { wizard: prof.setup.wizard, resumeParse: prof.resumeParse });
    ok('the wizard\'s own step rule: details are done WITHOUT a date of birth (optional on its screen) → it opens on step 1',
      prof.setup.wizard.done.you === true && prof.setup.wizard.stepKey === 'sign', prof.setup.wizard);
    runs.length = 0;
    onbRows[UID] = { user_id: UID, notes: 'x'.repeat(45), lane: 'write', skipped: { photo: true, signature: true } };
    const saved = await (await fetch(`${base}/profile/onboarding`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CV-Source': 'onboarding' },
      body: JSON.stringify({ notes: 'x'.repeat(45), lane: 'write', skipped: { photo: true, signature: true } }) })).json();
    ok('POST /profile/onboarding stores notes / lane / skips and answers with the fresh state (open, at Build)',
      runs.some((r) => /^INSERT INTO user_onboarding/.test(r.sql) && r.p[1] === 'x'.repeat(45) && r.p[2] === 'write' && /"photo":true/.test(r.p[3]))
      && saved.wizard && saved.wizard.state === 'open' && saved.wizard.stepKey === 'build' && JSON.stringify(saved.wizard.left) === '["building your resume"]', saved);
    // ⚠️ Review, 2026-09-19: the wizard asks for an unread CV to be read the moment it OPENS. That alone is not the user
    // writing anything, and must not turn "opened it and closed it" into "Pick up where you left off".
    runs.length = 0;
    delete onbRows[UID];
    const readOnly = await (await fetch(`${base}/profile/onboarding`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CV-Source': 'onboarding' },
      body: JSON.stringify({ readCv: true }) })).json();
    ok('⚠️ …but a request that ONLY asks for the CV to be read opens no progress row (opening the wizard is not writing through it)',
      !runs.some((r) => /INSERT INTO user_onboarding/.test(r.sql)) && readOnly.wizard && readOnly.wizard.state === 'none', { sql: runs.map((r) => r.sql.slice(0, 60)), wizard: readOnly.wizard });

    // ── 4c · ⚠️ Account Settings closes an open wizard only on the write that COMPLETED the profile (review round 2) ──
    // The real router + noteProfileBefore + updateProfile + afterProfileWrite, over HTTP, on a fake account that the
    // UPDATE really changes. Both photo and signature skipped in the wizard, the CV on file and READ.
    const acct = { full_name: 'Priya Sharma', phone_number: '+91 98765 43210', address: 'Pune, India', photo_path: null, signature_path: null,
      resume_path: `uploads/user_${UID}/${docxOnDisk}` };
    onRun = (sql, p) => {
      const m = /^UPDATE users SET (.+) WHERE id = \?$/.exec(sql.replace(/\s+/g, ' ').trim());
      if (!m) return;
      m[1].split(', ').forEach((set, i) => { const col = set.replace(/ = \?$/, ''); if (col in acct) acct[col] = p[i]; });
    };
    dbGet = async (sql, p) => {
      const q = String(sql).replace(/\s+/g, ' ');
      if (/^SELECT full_name, phone_number, address, photo_path, resume_path, signature_path FROM users WHERE id = \?/.test(q.trim())) return { ...acct };
      if (/FROM user_onboarding WHERE user_id = \$1/.test(q)) return onbRows[p[0]] || null;
      if (/FROM resume_metadata WHERE user_id = \$1/.test(q)) return { parse_status: 'done', parse_error: null };
      return null;
    };
    const closeRuns = () => runs.filter((r) => /^UPDATE user_onboarding SET closed_at = NOW\(\)/.test(r.sql)).length;
    const settingsSave = (body, headers = {}) => fetch(`${base}/profile/update`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    onbRows[UID] = { user_id: UID, skipped: { photo: true, signature: true } };
    runs.length = 0;
    const same = await settingsSave({ phone: '+91 98765 43210' });
    ok('⚠️ an open wizard over a profile ALREADY complete (user 616\'s shape) + an Account Settings save → 200, and the wizard stays OPEN',
      same.status === 200 && closeRuns() === 0 && runs.some((r) => /^UPDATE users SET phone_number = \?/.test(r.sql)), runs.map((r) => r.sql.slice(0, 60)));
    acct.address = '';
    runs.length = 0;
    const byWizard = await settingsSave({ address: 'Pune, India' }, { 'X-CV-Source': 'onboarding' });
    ok('…the wizard\'s own save that completes it keeps it open too (it touches the row instead)',
      byWizard.status === 200 && closeRuns() === 0 && runs.some((r) => /^INSERT INTO user_onboarding/.test(r.sql)) && acct.address === 'Pune, India');
    acct.address = '';
    runs.length = 0;
    const completing = await settingsSave({ address: 'Pune, India' });
    ok('⚠️ …and the Account Settings save that supplies the one missing field (the address) is the one that CLOSES it',
      completing.status === 200 && closeRuns() === 1 && acct.address === 'Pune, India', runs.map((r) => r.sql.slice(0, 60)));
    onRun = () => {};
    dbGet = async () => null;
  } catch (e) {
    ok('the HTTP upload part ran without an error', false, e.stack || e.message);
  } finally {
    server.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  console.log('\n── 5 · the parser reads by what the file IS, and a refusal is never retried ──');
  const psrc = fs.readFileSync(path.join(ROOT, 'services', 'resumeParserService.js'), 'utf8');
  ok('_parseResume sniffs the bytes and reads docx/doc/odt/rtf/txt through resumeText before pdf-parse',
    /const fmt = resumeText\.sniff\(fileBuf\);/.test(psrc) && /resumeText\.TEXT_KINDS\.has\(fmt\.kind\)/.test(psrc) && /resumeText\.extractText\(fileBuf, fmt\.kind\)/.test(psrc));
  // The REAL parser, with the model, the skills tables and the post-parse research faked: a Word CV end to end.
  const model = { prompts: [] };
  const genaiPath = require.resolve('@google/generative-ai');
  require.cache[genaiPath] = { id: genaiPath, filename: genaiPath, loaded: true, exports: { GoogleGenerativeAI: class {
    getGenerativeModel() { return { generateContent: async (prm) => { model.prompts.push(typeof prm === 'string' ? prm : JSON.stringify(prm));
      return { response: { text: () => JSON.stringify({ summary: 'PM', skills: ['Delivery'], job_titles: ['Project Manager'] }) } }; } }; }
  } } };
  stub('server/services/jobService.js', { upsertSkill: async () => 1, linkUserSkill: async () => {} });
  stub('server/services/instantResearch.js', { onResumeParsed: () => {} });
  stub('server/services/demandResearch.js', { countryFromResume: () => null });
  process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key-not-used';
  delete require.cache[require.resolve(path.join(ROOT, 'services', 'resumeParserService.js'))];
  const realParser = require(path.join(ROOT, 'services', 'resumeParserService.js'));
  const parseDir = path.join(ROOT, 'uploads', `user_${UID}_p`);
  fs.mkdirSync(parseDir, { recursive: true });
  try {
    for (const f of ['docx', 'doc']) {
      fs.writeFileSync(path.join(parseDir, 'resume-1.' + f), fx('cv.' + f));
      runs.length = 0; model.prompts.length = 0;
      await realParser._parseResume(UID, path.relative(ROOT, path.join(parseDir, 'resume-1.' + f)));
      const saved = runs.find((r) => /^INSERT INTO resume_metadata \( user_id, raw_text/.test(r.sql));
      ok(`⚠️ a .${f} CV is PARSED end to end: the model is given its text, and the row is saved 'done' with it`,
        model.prompts.length === 1 && model.prompts[0].includes('Tata Consultancy Services') && !!saved && /Tata Consultancy/.test(saved.p[1]),
        { prompts: model.prompts.length, saved: !!saved, errors: runs.filter((r) => /parse_error/.test(r.sql)).map((r) => r.p) });
    }
    fs.writeFileSync(path.join(parseDir, 'resume-2.docx'), storedZip({ 'Index/Document.iwa': 'x' }));
    runs.length = 0; model.prompts.length = 0;
    const quiet = console.error; console.error = () => {};
    try { await realParser._parseResume(UID, path.relative(ROOT, path.join(parseDir, 'resume-2.docx'))); } finally { console.error = quiet; }
    const err = runs.find((r) => /^INSERT INTO resume_metadata \(user_id, parse_status, parse_error/.test(r.sql));
    ok('…an older upload the parser cannot read is recorded as a PERMANENT error with the refusal sentence, and no model call',
      model.prompts.length === 0 && !!err && err.p[1] === 'error' && /^unsupported document: We can read PDF/.test(err.p[2]), err && err.p);
  } finally { try { fs.rmSync(parseDir, { recursive: true, force: true }); } catch {} }
  ok('⚠️ a refused document is PERMANENT (the sweeper never retries it); a 503 is still transient',
    !realParser.isTransientError('unsupported document: ' + T.MESSAGES.unsupported) && !realParser.isTransientError('unsupported document: 503 overloaded')
    && realParser.isTransientError('503 Service Unavailable'));
  ok('the upload marks the parse pending through the parser\'s own upsert (one definition)', typeof realParser.markParsePending === 'function');

  console.log('\n── 6 · ⚠️ a Word résumé is attached as a Word file, never as a broken ".pdf" ──');
  const { resumeAttachmentOf } = require(path.join(ROOT, 'server', 'utils', 'resumeFile.js'));
  const a1 = resumeAttachmentOf('uploads/user_7/resume-1.docx', 'Priya_Sharma'), a2 = resumeAttachmentOf('temp/Priya_Resume_1.pdf', 'P');
  ok('the stored path decides: .docx → "_Resume.docx" + the Word MIME type; the Builder\'s PDF stays a PDF',
    a1.filename === 'Priya_Sharma_Resume.docx' && /wordprocessingml/.test(a1.contentType) && a2.filename === 'P_Resume.pdf' && a2.contentType === 'application/pdf');
  ok('.doc / .odt / .rtf / .txt each keep their own type; an unknown or missing extension is the PDF it always was',
    resumeAttachmentOf('a.doc', 'x').contentType === 'application/msword' && /opendocument/.test(resumeAttachmentOf('a.odt', 'x').contentType)
    && resumeAttachmentOf('a.RTF', 'x').filename === 'x_Resume.rtf' && resumeAttachmentOf('a.txt', 'x').contentType === 'text/plain'
    && resumeAttachmentOf('uploads/u/resume-9', 'x').filename === 'x_Resume.pdf');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  const emailC = strip(fs.readFileSync(path.join(ROOT, 'server', 'controllers', 'emailController.js'), 'utf8'));
  const serverC = strip(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'));
  ok('⚠️ no send path names the STORED résumé "_Resume.pdf" any more (emailController ×5, server.js ×1)',
    !/_Resume\.pdf`/.test(emailC) && !/_Resume\.pdf`/.test(serverC)
    && (emailC.match(/resumeAttachmentOf\(resumePath, sanitizeName\(user\.full_name\)\)/g) || []).length >= 5
    && /resumeAttachmentOf\(resumePath, sanitizeName\(user\.full_name\)\)/.test(serverC));

  // ── 7 · ⚠️ NOTHING A FILE CAN SAY MAY HANG OR CRASH THE SERVER (review, 2026-09-20) ──
  // Every reader here runs SYNCHRONOUSLY on the one event loop — inside the upload request (profileController line
  // ~216) and in the background parser, the same process. So each of these is a real outage: measured on the first
  // version, 64,000 "<w:del>" in a 1 KB .docx froze every request for 51.7 s, a self-referencing DIF chain in a
  // 1.5 KB ".doc" for minutes (2.3 GB RSS), and sixty 39 MB headers in a 2.3 MB .docx aborted the process outright.
  console.log('\n── 7 · ⚠️ a hostile file is refused in milliseconds — it can never hang or crash the server ──');
  const timed = (label, buf, want, budget = 4000) => {
    const t0 = Date.now();
    const r = T.inspectResumeFile(buf);
    const ms = Date.now() - t0;
    ok(`${label} — ${ms} ms`, ms < budget && want(r), { ms, budget, ok: r.ok, reason: r.reason, text: r.text && r.text.slice(0, 120) });
    return r;
  };
  const refused = (r) => r.ok === false;
  timed('a .docx of 64,000 unbalanced <w:del> tags (810 bytes; it used to take 51.7 s)',
    deflatedZip({ 'word/document.xml': '<w:del>'.repeat(64000) }), refused);
  timed('an .odt of 8,000 unbalanced <text:s tags (it used to take 26 s)',
    deflatedZip({ mimetype: 'application/vnd.oasis.opendocument.text', 'content.xml': '<text:s '.repeat(8000) }),
    (r) => r.ok || refused(r));
  timed('a .txt that opens <html><body> then 20,000 unbalanced <head tags (it used to take 30 s)',
    Buffer.from('<html><body>' + '<head '.repeat(20000)), (r) => r.ok || refused(r));
  timed('a .txt with two million spaces in it (tidy\'s [ \\t]+\\n backtracked over every one)',
    Buffer.from('Priya Sharma — Project Manager at Tata Consultancy Services, 2016–2024, Pune.' + ' '.repeat(2000000) + 'x'),
    (r) => r.ok && /Priya Sharma/.test(r.text));
  timed('a ".doc" whose DIF chain points at itself and claims 100,000,000 DIF and 4 billion FAT sectors (1.5 KB → 2.3 GB)',
    difLoopDoc(100000000, 0xFFFFFFF0), refused);
  timed('…and the same file claiming every sector of a 4 GB FAT', difLoopDoc(1000000, 0xFFFFFFFF), refused);
  // ⚠️ THE ZIP BOMB: one 39 MB blob, deflated ONCE, referenced by sixty header parts — a 2.3 MB .docx that used to
  // inflate to 2.3 GB and abort the process (an abort, so the parser's try/catch never recorded anything).
  const blob = { deflated: zlib.deflateRawSync(Buffer.alloc(39 * 1024 * 1024, 0x41), { level: 9 }), usize: 39 * 1024 * 1024 };
  const bombParts = { 'word/document.xml': W('<w:p><w:r><w:t>Priya Sharma — Project Manager at Tata Consultancy Services, Pune, India.</w:t></w:r></w:p>') };
  for (let i = 1; i <= 60; i++) bombParts[`word/header${i}.xml`] = blob;
  timed('a 2.3 MB .docx carrying sixty 39 MB header parts (2.3 GB of output) — refused, not inflated', deflatedZip(bombParts), refused);
  const fieldSpam = T._internals.cleanWordChars('\x13\x14'.repeat(400000) + 'Priya Sharma, Project Manager'.repeat(20000));
  ok('a .doc whose character stream is 400,000 empty field markers is cleaned in one pass, not scanned per character',
    fieldSpam.includes('Priya Sharma'), fieldSpam.length);
  const rtfBomb = Buffer.from('{\\rtf1 Priya Sharma, Project Manager at Tata Consultancy Services, 2016-2024, Pune. ' + '{'.repeat(4000000));
  timed('an .rtf of four million "{" (one saved state each: hundreds of MB from a 4 MB file)', rtfBomb, (r) => r.ok || refused(r));

  console.log('\n── 7b · …and a real CV is still read exactly as before ──');
  // Heavy formatting, tab stops, tracked-change marks and a text box on every paragraph: 2 MB of XML for 240 KB of
  // text — far beyond any real CV, and read in full (a budget tight enough to cut this one off would cut CVs off).
  const heavy = '<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="2160"/><w:tab w:val="right" w:pos="9026"/></w:tabs>'
    + '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-IN"/></w:rPr></w:pPr>'
    + '<w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:b/><w:sz w:val="22"/></w:rPr>'
    + '<w:t xml:space="preserve">Project Manager at Tata Consultancy Services, 2016–2024. Led a 14-person team.</w:t></w:r></w:p>';
  const bigOk = T.inspectResumeFile(deflatedZip({ 'word/document.xml': W(heavy.repeat(3000)) }));
  ok(`a long, heavily formatted .docx (${(heavy.length * 3000 / 1e6).toFixed(1)} MB of XML, far more than any CV) is still read in full`,
    bigOk.ok && bigOk.kind === 'docx' && (bigOk.text.match(/Tata Consultancy/g) || []).length === 3000, { ok: bigOk.ok, reason: bigOk.reason, len: bigOk.text && bigOk.text.length });
  // ⚠️ THE TRACKED-CHANGE BUG THE WALKER FIXES: Word marks a DELETED PARAGRAPH MARK with a self-closing <w:del/> in
  // the paragraph's properties. The old `<w:del\b[^>]*>[\s\S]*?</w:del>` read that as an opening tag and swallowed
  // every paragraph up to the next real deletion — the whole Experience and Education sections, silently.
  const tracked = deflatedZip({ 'word/document.xml': W(
    '<w:p><w:r><w:t>Priya Sharma — Senior Project Manager, Pune</w:t></w:r></w:p>'
    + '<w:p><w:pPr><w:rPr><w:del w:id="1" w:author="a" w:date="2026-01-01T00:00:00Z"/></w:rPr></w:pPr><w:r><w:t>Experience</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>Project Manager at Tata Consultancy Services, 2016–2024</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>Education: B.E. Computer Engineering, University of Pune</w:t></w:r>'
    + '<w:del w:id="2" w:author="a"><w:r><w:delText>REMOVED BY THE AUTHOR</w:delText></w:r></w:del></w:p>'
    + '<w:p><w:r><w:t>Skills: Agile, Scrum, JIRA</w:t></w:r></w:p>') });
  const tr = T.inspectResumeFile(tracked);
  ok('⚠️ a CV edited with Track Changes on (a deleted paragraph MARK, self-closing <w:del/>) keeps Experience and Education…',
    tr.ok && /Experience/.test(tr.text) && /Tata Consultancy Services, 2016–2024/.test(tr.text) && /University of Pune/.test(tr.text), tr.text || tr);
  ok('…and the words the author really deleted are still not in it', tr.ok && !/REMOVED BY THE AUTHOR/.test(tr.text), tr.text);
  const spaced = T.inspectResumeFile(deflatedZip({ mimetype: 'application/vnd.oasis.opendocument.text',
    'content.xml': '<office:document-content><text:p>Priya<text:s text:c="5"/>Sharma — Project Manager at Tata Consultancy Services, Pune</text:p></office:document-content>' }));
  ok('an .odt\'s <text:s text:c="5"/> is still five spaces', spaced.ok && /Priya {5}Sharma/.test(spaced.text), spaced.text || spaced);

  // ── 7c · ⚠️ NOTHING ON THE PAGE IS DROPPED, AND NOTHING READABLE IS CALLED DAMAGED (review, 2026-09-20) ──
  console.log('\n── 7c · ⚠️ every part of the document, and every file the readers can open ──');
  const H = (body) => `<?xml version="1.0"?><w:hdr xmlns:w="w">${body}</w:hdr>`;
  const F = (body) => `<?xml version="1.0"?><w:ftr xmlns:w="w">${body}</w:ftr>`;
  const para = (t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
  // ⚠️ FOOTERS WERE READ NOWHERE. Headers were read because "many CVs keep the name and contact line" there — and
  // the Word and Europass templates people use put the LinkedIn URL, the address and the second phone number in the
  // FOOTER. Measured before this: a two-section .docx gave back both HEADER lines and neither FOOTER line.
  const hf = T.inspectResumeFile(deflatedZip({
    'word/document.xml': W(para('María González — Ingeniera de Software Senior')
      + para('Experiencia: Arquitecta, Telefónica, 2018–2026')
      + '<w:tbl><w:tr><w:tc>' + para('Habilidad') + '</w:tc><w:tc>' + para('Kubernetes') + '</w:tc></w:tr></w:tbl>'
      + para('Educación: Máster en Informática, Universidad Politécnica de Madrid')),
    'word/header1.xml': H(para('HEADER1: María González · Madrid')),
    'word/header2.xml': H(para('HEADER2: Currículum Vitae')),
    'word/footer1.xml': F(para('FOOTER1: linkedin.com/in/mgonzalez · Madrid, España')),
    'word/footer2.xml': F(para('FOOTER2: Referencias disponibles a petición · +34 600 123 456')),
  }));
  ok('⚠️ a .docx\'s FOOTERS are read as well as its headers — the contact line so many CVs keep there is not dropped',
    hf.ok && /linkedin\.com\/in\/mgonzalez · Madrid, España/.test(hf.text) && /\+34 600 123 456/.test(hf.text), hf.text || hf);
  ok('…headers still come first, the body next and the footers last, so the reading order is the page\'s',
    hf.ok && hf.text.indexOf('HEADER1') < hf.text.indexOf('María González — Ingeniera')
    && hf.text.indexOf('Máster en Informática') < hf.text.indexOf('FOOTER1')
    && /Habilidad\n\tKubernetes/.test(hf.text), hf.text);   // both table cells, in order

  // ⚠️ THE .doc A MAC WRITES. The 109 DIFAT slots in a CFB header reach 13,952 sectors — about 7.1 MB — and past that
  // a conforming writer puts the rest in DIFAT sectors. macOS does not: it declares csectFat = 159 with
  // sectDifStart = ENDOFCHAIN and csectDif = 0, and lays the extra FAT sectors contiguously. Measured before this:
  // a 7.8 MB .doc that `textutil -convert txt` reads back as 8.1 MB of text came back with its WordDocument stream
  // cut at exactly 13,953 sectors and was refused — "We could not open this file — it looks damaged."
  const realDoc = T._internals.cfbOpen(fx('cv.doc'));
  const wdStream = realDoc.get('WordDocument');
  const tableName = realDoc.names.find((n) => n === '1Table' || n === '0Table');
  const macLaidOut = cfbFile({ streams: { WordDocument: wdStream, [tableName]: realDoc.get(tableName) }, fatSectors: 120, listInHeader: 109 });
  const macDoc = T.inspectResumeFile(macLaidOut);
  ok('⚠️ a .doc whose FAT is longer than the 109 the header can list (every macOS .doc over ~7.1 MB) is READ, not "damaged"',
    macDoc.ok && macDoc.kind === 'doc' && words(macDoc.text) === words(EXPECT.join('\n')), { ok: macDoc.ok, reason: macDoc.reason, text: macDoc.text });
  // ⚠️ AND A CHAIN IS NEVER READ SHORT. `next[s]` undefined made `undefined >= 0` false, so the walk simply STOPPED:
  // this stream came back as 65,536 bytes of the 71,680 it declares, with nothing said. Part of a CV returned as if
  // it were all of it is the one failure a résumé reader may not have.
  const shortFat = cfbFile({ streams: { WordDocument: Buffer.alloc(140 * 512, 0x41) }, fatSectors: 1, listInHeader: 1 });
  const threw = (buf) => { try { T._internals.cfbOpen(buf).get('WordDocument'); return null; } catch (e) { return e; } };
  const shortErr = threw(shortFat);
  ok('⚠️ a stream whose sectors run past the end of the FAT is REFUSED, never handed back truncated in silence',
    shortErr instanceof T.ResumeFileError && shortErr.reason === 'damaged', shortErr && shortErr.message);
  const overDeclared = Buffer.from(shortFat); overDeclared.writeUInt32LE(3, 44);   // csectFat says 3; the file holds 1
  ok('…and FAT sectors the file does not hold are never invented to fill the count the header claims',
    (threw(overDeclared) || {}).reason === 'damaged', threw(overDeclared));

  // ⚠️ THE FILE IS READ ONCE, NOT TWICE. sniff() called docText purely to tell Word 6/95 and a password apart, and
  // threw the text away — so every .doc was parsed twice per inspectResumeFile (787 ms of it duplicated on a 1.7 MB
  // file, on the one event loop). It reads the FIB header now, which is all those two answers need.
  const brokenClx = docWith((b, o) => b.writeUInt32LE(0xFFFFFF, o + 0x1A6));   // a valid FIB, an impossible piece table
  ok('sniff() reads the FIB header only: a .doc with a good header and a broken piece table sniffs as "doc"…',
    T.sniff(brokenClx).kind === 'doc', T.sniff(brokenClx));
  ok('…and inspectResumeFile still refuses it, so nothing about the answer changed — only the duplicate parse went',
    T.inspectResumeFile(brokenClx).reason === 'damaged', T.inspectResumeFile(brokenClx));

  // ⚠️ A BIG TEXT FILE IS NOT A STALL. The .txt / .rtf / .doc readers decoded byte by byte (`s += …` per character),
  // inside the HTTP request, on the one event loop: a 9.9 MB Windows-1252 .txt held it for 5.1 SECONDS at 650 MB of
  // RSS, and a 9.5 MB .rtf for 4.2 s — every other user's request waiting on both. Any signed-in user could do it.
  const w1252Line = Buffer.from('Zo\xEB M\xFCller \x97 Ing\xE9nieur logiciel senior, Z\xFCrich. Staff Engineer, Zahlungsbank AG, 2019-2026.\n', 'latin1');
  const bigTxt = Buffer.concat(Array.from({ length: Math.floor(9.9 * 1024 * 1024 / w1252Line.length) }, () => w1252Line));
  const txtR = timed(`a ${(bigTxt.length / 1e6).toFixed(1)} MB Windows-1252 .txt (it used to hold the event loop 5.1 s at 650 MB)`,
    bigTxt, (r) => r.ok && /Zoë Müller — Ingénieur/.test(r.text) && r.text.length === T._internals.MAX_TEXT_CHARS, 1500);
  ok('…and its accents and 1252 punctuation are exactly what the slow byte-at-a-time decoder produced',
    txtR.ok && txtR.text.startsWith('Zoë Müller — Ingénieur logiciel senior, Zürich.'), txtR.text && txtR.text.slice(0, 60));
  const rtfLine = '\\par Zo\\\'eb M\\\'fcller \\endash  Ing\\\'e9nieur logiciel senior, Z\\\'fcrich, 2019-2026.';
  const bigRtf = Buffer.from('{\\rtf1\\ansi\\ansicpg1252 ' + rtfLine.repeat(Math.ceil(9.5 * 1024 * 1024 / rtfLine.length)) + '}', 'latin1');
  timed(`a ${(bigRtf.length / 1e6).toFixed(1)} MB .rtf (it used to hold it 4.2 s at 460 MB)`,
    bigRtf, (r) => r.ok && /Zoë Müller – Ingénieur/.test(r.text) && r.text.length === T._internals.MAX_TEXT_CHARS, 1500);

  console.log('\n── 8 · ⚠️ the website\'s upload passes the SAME gate as the app\'s ──');
  const { vetUploadedResume } = require(path.join(ROOT, 'server', 'utils', 'resumeFile.js'));
  const gateDir = path.join(ROOT, 'uploads', `user_${UID}_g`);
  fs.mkdirSync(gateDir, { recursive: true });
  try {
    const bad = path.join(gateDir, 'resume-1-My_CV.pdf');
    fs.writeFileSync(bad, storedZip({ 'Index/Document.iwa': 'x' }));               // a .pages renamed ".pdf"
    const badR = await vetUploadedResume(bad);
    ok('a file the server cannot read → 415 with the sentence to show, and the file is GONE (nothing to commit)',
      badR.ok === false && badR.status === 415 && badR.body.reason === 'unsupported_format' && /PDF/.test(badR.body.error) && !fs.existsSync(bad), badR);
    const good = path.join(gateDir, 'resume-2-My_CV.pdf');
    fs.writeFileSync(good, fx('cv.docx'));                                          // a Word file the browser called ".pdf"
    const goodR = await vetUploadedResume(good);
    ok('a Word file named ".pdf" → accepted, and RENAMED to .docx (every send path names the attachment from the stored path)',
      goodR.ok && goodR.fmt.kind === 'docx' && goodR.path.endsWith('.docx') && fs.existsSync(goodR.path) && !fs.existsSync(good), goodR);
    const none = await vetUploadedResume(path.join(gateDir, 'not-here.pdf'));
    ok('a file that is not there is a refusal, never a throw', none.ok === false && none.status === 415, none);
  } finally { try { fs.rmSync(gateDir, { recursive: true, force: true }); } catch {} }
  const srvSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const uploadProfile = srvSrc.slice(srvSrc.indexOf("app.post('/api/upload-profile'"), srvSrc.indexOf("// Save/Update recipients for a user"));
  ok('⚠️ /api/upload-profile (the website and older builds) vets the résumé BEFORE the UPDATE that points resume_path at it',
    /vetUploadedResume\(req\.files\['resume'\]\[0\]\.path\)/.test(uploadProfile)
    && uploadProfile.indexOf('vetUploadedResume') < uploadProfile.indexOf("updates.push('resume_path = ?')")
    && /return res\.status\(vetted\.status\)\.json\(\{ \.\.\.vetted\.body/.test(uploadProfile), uploadProfile.slice(0, 200));
  // ⚠️ THE PHOTO AND THE SIGNATURE GO WITH IT — AND THE USER IS TOLD (review, 2026-09-20). public/profile.html posts
  // all three in ONE request, so a CV the server cannot read takes the new photo and signature down with it. The
  // body carried the CV's sentence alone and the page went on showing both previews, so the two looked saved.
  ok('a refusal names every file it discarded, and lists them for the page (discarded: [photo, signature])',
    /const discarded = \[\];/.test(uploadProfile) && /discarded\.push\(field\)/.test(uploadProfile)
    && /not saved either/.test(uploadProfile) && /discarded \}\);/.test(uploadProfile), uploadProfile.slice(uploadProfile.indexOf('const discarded'), uploadProfile.indexOf('const discarded') + 400));
  const profileHtml = fs.readFileSync(path.join(ROOT, 'public', 'profile.html'), 'utf8');
  ok('…and the page puts its previews back on a refusal, instead of showing files the server threw away',
    /function clearUploadPreviews\(\)/.test(profileHtml)
    && /clearUploadPreviews\(\);\s*\n\s*await loadUserProfile\(\);\s*\n\s*showToast\(result\.error/.test(profileHtml), 'profile.html saveProfile');
  ok('…and the app\'s own upload uses that same one gate (not its own copy of the rules)',
    /vetUploadedResume\(req\.file\.path\)/.test(fs.readFileSync(path.join(ROOT, 'server', 'controllers', 'profileController.js'), 'utf8')));

  console.log(`\nresume text: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
