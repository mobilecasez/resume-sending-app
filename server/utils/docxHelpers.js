// Shared helpers for the programmatic Word (.docx) builders. Each resume/cover-letter
// layout imports this so layouts can be developed and unit-tested independently.
'use strict';

const docx = require('docx');
const {
  Document, Packer, Paragraph, TextRun, AlignmentType, TabStopType, BorderStyle,
  ImageRun, Table, TableRow, TableCell, WidthType, VerticalAlign, ShadingType, HeightRule,
} = docx;

// Palette + page geometry (A4 in twips).
const INK = '222222', MUTED = '555555', FAINT = '777777', FONT = 'Calibri';
const PAGE_W = 11906, PAGE_H = 16838;

const has = (v) => v != null && String(v).trim() !== '';
const arr = (a) => (Array.isArray(a) ? a.filter((x) => x != null && String(x).trim() !== '') : []);
const hex = (c) => String(c || '').replace(/^#/, '').toUpperCase() || '0A4F6E';
function textOn(h) {
  h = hex(h);
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '1A1A1A' : 'FFFFFF';
}
// Lighten/darken a hex colour by mixing toward white/black (amt 0..1).
function mix(h, target, amt) {
  h = hex(h); const t = hex(target);
  const f = (i) => { const a = parseInt(h.slice(i, i + 2), 16), b = parseInt(t.slice(i, i + 2), 16); return Math.round(a + (b - a) * amt).toString(16).padStart(2, '0'); };
  return (f(0) + f(2) + f(4)).toUpperCase();
}
const lighten = (h, a = 0.85) => mix(h, 'FFFFFF', a);
const darken = (h, a = 0.4) => mix(h, '000000', a);

function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&rsquo;/gi, '’').replace(/&[a-z#0-9]+;/gi, ' ');
}
const stripTags = (h) => String(h || '').replace(/<[^>]+>/g, '');

// text with **markdown** or <b>/<strong>/<em>/<i> → TextRun[]
function inlineRuns(html, base = {}) {
  let h = String(html || '')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<i>$2</i>');
  const runs = [];
  const re = /<(b|strong|em|i)>([\s\S]*?)<\/\1>|([^<]+)|<[^>]+>/gi;
  let m;
  while ((m = re.exec(h)) !== null) {
    if (m[1]) {
      const bold = /^(b|strong)$/i.test(m[1]), italics = /^(em|i)$/i.test(m[1]);
      const t = decodeEntities(stripTags(m[2]));
      if (t) runs.push(new TextRun({ text: t, bold, italics, font: base.font || FONT, color: base.color || INK, size: base.size || 21 }));
    } else if (m[3] != null) {
      const t = decodeEntities(m[3]);
      if (t) runs.push(new TextRun({ text: t, font: base.font || FONT, color: base.color || INK, size: base.size || 21 }));
    }
  }
  return runs.length ? runs : [new TextRun({ text: '', font: FONT })];
}

// Cover-letter body HTML → Paragraph[]
function htmlToParagraphs(html, base = {}) {
  let h = String(html || '');
  h = h.replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n\n').replace(/<br\s*\/?>(?!\n)/gi, '\n');
  const blocks = h.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const paras = blocks.map((block) => {
    const children = [];
    block.split(/\n/).forEach((line, i) => { if (i > 0) children.push(new TextRun({ break: 1 })); children.push(...inlineRuns(line, base)); });
    return new Paragraph({ spacing: { after: base.after != null ? base.after : 160, line: base.line || 276 }, alignment: base.alignment, indent: base.indent, children });
  });
  return paras.length ? paras : [new Paragraph({ children: [new TextRun({ text: '', font: FONT })] })];
}

function dataUriToImage(uri) {
  const m = /^data:image\/(\w+);base64,(.+)$/i.exec(uri || '');
  if (!m) return null;
  const ext = m[1].toLowerCase();
  return { data: Buffer.from(m[2], 'base64'), type: ext === 'jpeg' ? 'jpg' : ext };
}
const run = (text, o = {}) => new TextRun({ text: String(text == null ? '' : text), font: FONT, size: 21, color: INK, ...o });
const bullet = (text, indent, o = {}) => new Paragraph({ bullet: { level: 0 }, spacing: { after: 30, line: 264 }, indent, children: inlineRuns(text, { size: o.size || 21, color: o.color }) });

// Section heading with a coloured bottom rule (style customisable).
function sectionHeading(title, accent, opts = {}) {
  return new Paragraph({
    spacing: { before: opts.before != null ? opts.before : 240, after: opts.after != null ? opts.after : 90 }, indent: opts.indent,
    alignment: opts.alignment,
    border: opts.noRule ? undefined : { bottom: { style: opts.ruleStyle || BorderStyle.SINGLE, size: opts.ruleSize || 6, color: opts.ruleColor || accent, space: 2 } },
    children: [run(String(title).toUpperCase(), { bold: true, color: opts.color || accent, size: opts.size || 22, characterSpacing: opts.tracking })],
  });
}

const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const NO_BORDERS = { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER, insideHorizontal: NO_BORDER, insideVertical: NO_BORDER };
const line = (color, size = 4) => ({ style: BorderStyle.SINGLE, size, color: hex(color), space: 2 });

// Build a Document from a layout result { children, margin }.
async function pack(built) {
  const doc = new Document({
    creator: 'CVApplyr',
    styles: { default: { document: { run: { font: FONT, size: 21, color: INK } } } },
    sections: [{ properties: { page: { size: { width: PAGE_W, height: PAGE_H }, margin: built.margin } }, children: built.children }],
  });
  return Packer.toBuffer(doc);
}

module.exports = {
  docx, Document, Packer, Paragraph, TextRun, AlignmentType, TabStopType, BorderStyle,
  ImageRun, Table, TableRow, TableCell, WidthType, VerticalAlign, ShadingType, HeightRule,
  INK, MUTED, FAINT, FONT, PAGE_W, PAGE_H,
  has, arr, hex, textOn, mix, lighten, darken, decodeEntities, stripTags,
  inlineRuns, htmlToParagraphs, dataUriToImage, run, bullet, sectionHeading,
  NO_BORDER, NO_BORDERS, line, pack,
};
