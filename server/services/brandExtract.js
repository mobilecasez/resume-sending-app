// The employer's brand, read off its own website: the colour it paints its buttons and sidebars with,
// and the font it sets its pages in. Deterministic — one GET of the homepage, at most two of its
// stylesheets, a yes/no against Google Fonts. No AI, no third-party brand API.
//
// WHY THIS EXISTS: every employer resume came out in the same colours. ai-employer-researcher.js does
// name a brand_color and a font_name, but they are a model's recollection of a website and it invents
// '#262633' / 'Lato' when it has none (employerResearch stores those as null). The website itself
// declares its colours and fonts in markup nobody has to guess at: <meta name="theme-color">, the
// --brand / --primary custom properties in its CSS, the colour it paints its backgrounds with most, the
// font-family on <body>, the Google Fonts <link> it loads. Reading those is free, repeatable and right
// far more often than a summary of the page is.
//
// COLOUR, in this order (the first that gives a SATURATED, MID-LIGHTNESS colour wins — greys, whites and
// near-blacks are never a brand, whatever the site says):
//   (a) <meta name="theme-color">                                          → from.primary 'theme-color'
//   (b) a CSS custom property named like --brand / --primary / --accent / --main / --theme  → 'css-var'
//   (c) the most frequent colour in color / background(-color) / border-color declarations, backgrounds
//       counted twice (a brand paints surfaces)                            → 'frequency'
// Secondary = the next candidate with a clearly different hue (≥ 30°), or null.
//
// FONT: the first non-generic family declared on html / body / :root ('body'); else the family of a
// Google Fonts <link> the page loads ('google-link'); else the most frequently declared family
// ('frequency'). System-stack names (sans-serif, system-ui, -apple-system, Segoe UI, Arial, Helvetica…)
// never count; Roboto / Ubuntu / Fira Sans / Noto Sans — the tail of every default stack — count only when
// nothing else was named. font.google is whether https://fonts.googleapis.com/css2?family=<name> answers
// 200 (cached in memory for 24 h), because that is the only kind of font the renderer can actually load.
//
// ⚠️ THIS MODULE FETCHES A URL A USER TYPED. An employer's "website" is user input, so every fetch here is
// SSRF-safe, without exception:
//   • https only — at the first hop and at every redirect (a 302 to http://169.254.169.254/ is refused).
//   • the host is RESOLVED FIRST and every address it resolves to must be public: no loopback, private
//     (10/8, 172.16/12, 192.168/16), CGNAT, link-local / cloud-metadata (169.254/16), multicast, reserved
//     or documentation ranges, in v4 and v6 — and a v4 address tunnelled inside v6 (::ffff:10.0.0.1,
//     NAT64, 6to4) is judged as the v4 address it carries. ONE bad address refuses the whole host.
//   • the connection is PINNED to the addresses that passed: a custom lookup hands the socket that list,
//     so a DNS answer that changes between the check and the connect (rebinding) buys nothing.
//   • ≤ 3 redirects, each re-resolved and re-checked; one deadline (8 s) over the whole extraction —
//     DNS, redirects, stylesheets, the Google check — never per request.
//   • bodies are capped (1.5 MB page, 400 KB per stylesheet), counted AFTER decompression as well as
//     before, so a gzip bomb stops at the cap; only text/html pages and text/css sheets are read; a
//     stylesheet must be https too. Nothing else on the page is fetched — no images, no scripts, no fonts.
//   • the READ of what was fetched is bounded as well, because it runs synchronously on the API's thread
//     where no deadline can interrupt it: every scan is one pass over its input (no regex that re-reads to
//     the end for every opener), at most 300 KB of CSS / 20k rules are parsed, and the parse stops at 500 ms
//     with what it has — see "The read budget" below.
//
// ⚠️ NEVER THROWS, NEVER BLOCKS A BUILD. extractBrand answers null on every failure — a null, undefined or
// non-object argument included — and employerResearch runs it beside the research calls under its own
// bound. A null brand means "paint it the usual way".
'use strict';

const dns = require('dns');
const net = require('net');
const https = require('https');
const zlib = require('zlib');

const TIMEOUT_MS = 8000;
const HTML_CAP = 1.5 * 1024 * 1024;
const CSS_CAP = 400 * 1024;
const MAX_REDIRECTS = 3;
const MAX_SHEETS = 2;
const GOOGLE_TTL_MS = 24 * 60 * 60 * 1000;
const GOOGLE_CHECK_MS = 3000;
const GOOGLE_CAP = 64 * 1024;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── The read budget ───────────────────────────────────────────────────────────
// ⚠️ WHY: parseHtml and brandFromSources run SYNCHRONOUSLY on the API's main thread (extractBrand awaits
// nothing while it parses), so the network deadline cannot stop them — a homepage that is cheap to fetch but
// expensive to parse freezes every request on the process. A 1.4 MB <style> of 'a{}' (490k rules, under
// the page cap) used to take MINUTES: cssRules asked css.lastIndexOf(';', open) for every rule, and with no
// ';' on the sheet each call scanned back to offset 0 (20k rules 0.36 s, 40k 2.1 s, 160k 36 s). Every scan
// in this module is now one pass over its input, and the parse itself is capped three ways — characters of
// CSS read, rules kept, wall clock. Past a cap the read keeps what it has rather than answering nothing: the
// :root variables and the body rule sit at the top of a sheet, so a brand read from the first 300 KB of a
// 700 KB bundle is the same brand.
const CSS_TEXT_BUDGET = 300 * 1024;   // characters of CSS parsed per read, over every <style>, sheet and style=""
const CSS_RULE_BUDGET = 20000;        // rules kept per read (300 KB of minified CSS is about that many)
const CSS_TIME_BUDGET_MS = 500;       // wall clock for one synchronous read
const IMPORT_SCAN_CHARS = 8 * 1024;   // @import is only legal before every other rule, so only a sheet's head is asked
const VALUE_MAX = 2000;               // longest declaration value kept — before and after var() substitution
const VAR_STEPS = 256;                // var() references one value may follow, over every hop

// ── Addresses ─────────────────────────────────────────────────────────────────
function parseIPv4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s || ''));
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

/** Public unicast only. Every range a request from this server must never reach is listed by name. */
function ipv4Public([a, b, c]) {
  if (a === 0 || a === 10 || a === 127) return false;                 // "this" network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return false;                  // CGNAT 100.64/10
  if (a === 169 && b === 254) return false;                            // link-local — and the cloud metadata service
  if (a === 172 && b >= 16 && b <= 31) return false;                   // private 172.16/12
  if (a === 192 && b === 168) return false;                            // private 192.168/16
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;      // IETF protocol assignments, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false;               // benchmarking 198.18/15
  if (a === 198 && b === 51 && c === 100) return false;                // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false;                 // TEST-NET-3
  if (a >= 224) return false;                                          // multicast 224/4, reserved 240/4, broadcast
  return true;
}

/** '::ffff:10.0.0.1' → [0,0,0,0,0,0xffff,0x0a00,0x0001]; null when it is not an IPv6 address. */
function parseIPv6(s) {
  if (!net.isIPv6(String(s || ''))) return null;
  const str = String(s).split('%')[0].toLowerCase();
  const halves = str.split('::');
  if (halves.length > 2) return null;
  const groupsOf = (part) => {
    if (!part) return [];
    const out = [];
    for (const g of part.split(':')) {
      if (g.includes('.')) {
        const v4 = parseIPv4(g);
        if (!v4) return null;
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
        out.push(parseInt(g, 16));
      }
    }
    return out;
  };
  const left = groupsOf(halves[0]);
  const right = halves.length === 2 ? groupsOf(halves[1]) : [];
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  return [...left, ...new Array(missing).fill(0), ...right];
}

const v4Of = (hi, lo) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];

function ipv6Public(g) {
  const zerosTo = (n) => g.slice(0, n).every((x) => x === 0);
  if (zerosTo(8)) return false;                                                      // ::
  if (zerosTo(7) && g[7] === 1) return false;                                        // ::1
  if (zerosTo(5) && g[5] === 0xffff) return ipv4Public(v4Of(g[6], g[7]));            // ::ffff:a.b.c.d  (v4-mapped)
  if (zerosTo(6)) return ipv4Public(v4Of(g[6], g[7]));                               // ::a.b.c.d       (v4-compatible)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return ipv4Public(v4Of(g[6], g[7])); // 64:ff9b::/96 NAT64
  if (g[0] === 0x2002) return ipv4Public(v4Of(g[1], g[2]));                          // 2002::/16 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return false;                                      // unique local fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return false;                                      // link-local fe80::/10
  if ((g[0] & 0xffc0) === 0xfec0) return false;                                      // site-local (deprecated) fec0::/10
  if ((g[0] & 0xff00) === 0xff00) return false;                                      // multicast ff00::/8
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false;                              // documentation 2001:db8::/32
  return true;
}

/** Whether a resolved address may be connected to. Anything unparsable is refused. */
function isPublicAddress(addr) {
  const s = String(addr || '').replace(/^\[|\]$/g, '');
  const kind = net.isIP(s);
  if (kind === 4) { const o = parseIPv4(s); return !!o && ipv4Public(o); }
  if (kind === 6) { const g = parseIPv6(s); return !!g && ipv6Public(g); }
  return false;
}

/** A DNS name (labels of letters, digits, hyphens) or an IP literal. Nothing else is asked the resolver. */
function validHost(host) {
  const h = String(host || '');
  if (!h || h.length > 253) return false;
  if (net.isIP(h)) return true;
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i.test(h);
}

const defaultLookup = (host, opts) => dns.promises.lookup(host, opts);

/**
 * The public addresses `host` resolves to, or null when it resolves to none — or to ANY address this
 * server must not reach. `allowLoopback` (tests only — never passed by production code) admits 127/8 so a
 * fixture server on this machine can stand in for a website; every other rule still applies to it.
 */
async function resolvePublic(host, { lookup = defaultLookup, allowLoopback = false } = {}) {
  const permitted = (a) => isPublicAddress(a) || (allowLoopback && /^127\.\d+\.\d+\.\d+$/.test(String(a)));
  const literal = String(host || '').replace(/^\[|\]$/g, '');
  if (net.isIP(literal)) return permitted(literal) ? [{ address: literal, family: net.isIP(literal) }] : null;
  let list;
  try {
    list = await lookup(literal, { all: true });
  } catch {
    return null;
  }
  if (!Array.isArray(list) || !list.length) return null;
  const out = [];
  for (const e of list) {
    const address = e && typeof e.address === 'string' ? e.address : null;
    if (!address || !permitted(address)) return null;
    out.push({ address, family: (e.family === 4 || e.family === 6) ? e.family : net.isIP(address) });
  }
  return out;
}

// ── One capped GET ────────────────────────────────────────────────────────────
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function withDeadline(promise, ms, fallback) {
  if (!(ms > 0)) return Promise.resolve(fallback);
  let timer = null;
  const wait = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([promise, wait]).finally(() => clearTimeout(timer));
}

/**
 * GET `url` once, connected ONLY to `addrs` (already checked), decoding gzip / deflate / br and keeping at
 * most `cap` decoded bytes. Resolves { redirect } for a 3xx with a Location, else
 * { ok, status, type, body, truncated, refused }. Never rejects.
 */
function requestOnce(url, addrs, { deadline, cap, accept, ca, headers }) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let req = null;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const pinned = (hostname, options, cb) => {
      if (typeof options === 'function') { cb = options; options = {}; }
      if (options && options.all) cb(null, addrs.map((a) => ({ address: a.address, family: a.family })));
      else cb(null, addrs[0].address, addrs[0].family);
    };
    try {
      req = https.request(url, {
        method: 'GET',
        lookup: pinned,
        agent: false,
        timeout: Math.max(1, deadline - Date.now()),
        ...(ca ? { ca } : {}),
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,text/css;q=0.9,*/*;q=0.5',
          'Accept-Language': 'en-US,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          Connection: 'close',
          ...(headers || {}),
        },
      });
    } catch (err) {
      return done({ ok: false, status: 0, type: '', body: null, truncated: false, refused: 'network', error: err && err.message });
    }
    timer = setTimeout(() => { try { req.destroy(new Error('deadline')); } catch { /* already gone */ } }, Math.max(1, deadline - Date.now()));

    req.on('response', (res) => {
      const status = res.statusCode || 0;
      const type = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (REDIRECT_STATUSES.has(status) && res.headers.location) {
        res.resume();
        return done({ redirect: String(res.headers.location), status });
      }
      if (status !== 200) {
        res.resume();
        return done({ ok: false, status, type, body: null, truncated: false, refused: 'status' });
      }
      if (typeof accept === 'function' && !accept(type)) {
        req.destroy();
        return done({ ok: false, status, type, body: null, truncated: false, refused: 'content-type' });
      }
      const enc = String(res.headers['content-encoding'] || '').trim().toLowerCase();
      let stream = res;
      if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      else if (enc && enc !== 'identity') {
        req.destroy();
        return done({ ok: false, status, type, body: null, truncated: false, refused: 'encoding' });
      }
      const chunks = [];
      let size = 0;
      let raw = 0;
      let truncated = false;
      const finish = () => done({ ok: true, status, type, body: Buffer.concat(chunks), truncated, refused: null, bytes: size });
      const cut = () => { truncated = true; finish(); try { req.destroy(); } catch { /* ignore */ } };
      // With a decompressor in the path the WIRE bytes are counted too: a page whose compressed form alone
      // exceeds the cap is not read on. (Identity bodies are capped exactly by the handler below — a second
      // counter on the same chunk would cut before the chunk that completes the cap is kept.)
      if (stream !== res) res.on('data', (c) => { raw += c.length; if (raw > cap && !truncated) cut(); });
      stream.on('data', (c) => {
        if (truncated) return;
        size += c.length;
        if (size >= cap) { chunks.push(c.subarray(0, c.length - (size - cap))); size = cap; cut(); return; }
        chunks.push(c);
      });
      stream.on('end', finish);
      stream.on('error', () => (chunks.length ? cut() : done({ ok: false, status, type, body: null, truncated: false, refused: 'network' })));
      res.on('error', () => (chunks.length ? cut() : done({ ok: false, status, type, body: null, truncated: false, refused: 'network' })));
      res.on('aborted', () => (chunks.length ? cut() : done({ ok: false, status, type, body: null, truncated: false, refused: 'network' })));
    });
    req.on('timeout', () => { try { req.destroy(new Error('timeout')); } catch { /* ignore */ } });
    req.on('error', (err) => done({ ok: false, status: 0, type: '', body: null, truncated: false, refused: /deadline|timeout/i.test(err && err.message) ? 'timeout' : 'network', error: err && err.message }));
    req.end();
  });
}

/**
 * The module's only way onto the network: an https GET under every rule in the header. Follows at most
 * MAX_REDIRECTS redirects, resolving and checking the host again at each. Answers
 * { ok, status, type, body: Buffer|null, truncated, refused, url } — `refused` names the rule that stopped
 * it ('scheme' | 'host' | 'address' | 'redirects' | 'content-type' | 'encoding' | 'status' | 'timeout' |
 * 'network' | 'url'), `url` is the final URL. Never rejects.
 */
async function fetchCapped(input, { deadline = Date.now() + TIMEOUT_MS, cap = HTML_CAP, accept = null, lookup, allowLoopback = false, ca, headers } = {}) {
  let url;
  try {
    url = new URL(String(input));
  } catch {
    return { ok: false, status: 0, type: '', body: null, truncated: false, refused: 'url', url: String(input) };
  }
  const refuse = (why, status = 0) => ({ ok: false, status, type: '', body: null, truncated: false, refused: why, url: url.toString() });
  for (let hop = 0; ; hop++) {
    if (url.protocol !== 'https:') return refuse('scheme');
    if (url.username || url.password) return refuse('url');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!validHost(host)) return refuse('host');
    let left = deadline - Date.now();
    if (left <= 0) return refuse('timeout');
    const addrs = await withDeadline(resolvePublic(host, { lookup, allowLoopback }), left, null);
    if (!addrs) return refuse(Date.now() >= deadline ? 'timeout' : 'address');
    left = deadline - Date.now();
    if (left <= 0) return refuse('timeout');
    const res = await requestOnce(url, addrs, { deadline, cap, accept, ca, headers });
    if (res.redirect !== undefined) {
      if (hop >= MAX_REDIRECTS) return refuse('redirects', res.status);
      let next;
      try {
        next = new URL(res.redirect, url);
      } catch {
        return refuse('url', res.status);
      }
      url = next; // the loop re-checks the scheme and re-resolves the host
      continue;
    }
    return { ...res, url: url.toString() };
  }
}

// ── HTML ──────────────────────────────────────────────────────────────────────
const ENTITY = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', '#39': "'", '#x27': "'", '#x2f': '/', '#47': '/' };
const decodeEntities = (s) => String(s || '').replace(/&(amp|quot|apos|lt|gt|#39|#x27|#x2f|#47);/gi, (_, k) => ENTITY[k.toLowerCase()] || '');

/** The attributes of one tag, names lower-cased, values entity-decoded. */
function attrsOf(tag) {
  const out = {};
  const body = String(tag).replace(/^<[a-zA-Z][\w:-]*/, '').replace(/\/?>$/, '');
  for (const m of body.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const name = m[1].toLowerCase();
    if (!(name in out)) out[name] = decodeEntities(m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] != null ? m[4] : '');
  }
  return out;
}

const isGoogleFontsCss = (u) => u.hostname === 'fonts.googleapis.com' && /^\/css2?$/.test(u.pathname);

/** 'https://fonts.googleapis.com/css2?family=Inter:wght@400;700&family=Lora' → ['Inter', 'Lora'] (css v1 '|' lists too). */
function googleFamiliesOf(u) {
  const out = [];
  for (const raw of u.searchParams.getAll('family')) {
    for (const part of String(raw).split('|')) {
      const fam = part.split(':')[0].replace(/\s+/g, ' ').trim();
      if (fam && !out.some((f) => f.toLowerCase() === fam.toLowerCase())) out.push(fam);
    }
  }
  return out;
}

/**
 * @import url("x.css") / @import "x.css" in a stylesheet → the URLs as written. Only the sheet's first
 * IMPORT_SCAN_CHARS are asked: an @import is only legal before every other rule, so that is where a real
 * one is. ⚠️ WHY THE TAIL IS `[^;{}]{0,200};` AND NOT `[^;]*;`: the unbounded form re-read the sheet to its
 * END for every '@import' on a sheet with no ';' at all — quadratic, 2k of them cost 0.1 s, 140k minutes.
 */
function importsOf(css) {
  const out = [];
  for (const m of String(css).slice(0, IMPORT_SCAN_CHARS).matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?[^;{}]{0,200};/gi)) out.push(m[1]);
  return out;
}

// ── One-pass scans over the page ──────────────────────────────────────────────
// ⚠️ WHY NOT /<!--[\s\S]*?-->/g, /<meta\b[^>]*>/gi AND FRIENDS: on an opener that never closes, a regex like
// that reads to the END of the input, fails, and starts again from the next opener — '<!--' × 375k (1.5 MB,
// under the page cap) is O(n²): 8k openers cost 0.1 s, 32k 1.8 s, the cap minutes, on the API's thread.
// The scans below visit every character once and give the regex's exact answer: a span is cut only when its
// closer exists, and an opener with no closer after it ends the pass (nothing later can close either).

/** `src` with every openRe … closeRe span replaced by one space — what /open[\s\S]*?close/g does, in one pass. */
function cutSpans(src, openRe, closeRe) {
  const parts = [];
  let i = 0;
  for (;;) {
    openRe.lastIndex = i;
    const o = openRe.exec(src);
    if (!o) break;
    closeRe.lastIndex = o.index + o[0].length;
    const c = closeRe.exec(src);
    if (!c) break;
    parts.push(src.slice(i, o.index), ' ');
    i = c.index + c[0].length;
  }
  parts.push(src.slice(i));
  return parts.join('');
}

/** The `<name …>` tags of `src`, each up to its first '>' — what /<name\b[^>]*>/gi matches, in one pass. */
function tagsOf(src, name, max = Infinity) {
  const openRe = new RegExp('<' + name + '\\b', 'gi');
  const out = [];
  let i = 0;
  while (out.length < max) {
    openRe.lastIndex = i;
    const o = openRe.exec(src);
    if (!o) break;
    const gt = src.indexOf('>', o.index + o[0].length);
    if (gt < 0) break;
    out.push(src.slice(o.index, gt + 1));
    i = gt + 1;
  }
  return out;
}

/** The text inside every <style …>…</style>, in document order, in one pass. */
function styleBlocksOf(src) {
  const openRe = /<style\b/gi;
  const closeRe = /<\/style\s*>/gi;
  const out = [];
  let i = 0;
  for (;;) {
    openRe.lastIndex = i;
    const o = openRe.exec(src);
    if (!o) break;
    const gt = src.indexOf('>', o.index + o[0].length);
    if (gt < 0) break;
    closeRe.lastIndex = gt + 1;
    const c = closeRe.exec(src);
    if (!c) break;
    out.push(src.slice(gt + 1, c.index));
    i = c.index + c[0].length;
  }
  return out;
}

/**
 * What the extraction reads off a page: theme colours, <style> blocks, style="" attributes, the
 * stylesheet URLs (absolute, in document order), and the families of any Google Fonts CSS it loads.
 */
function parseHtml(html, baseUrl) {
  const src = cutSpans(cutSpans(String(html || ''), /<!--/g, /-->/g), /<script\b/gi, /<\/script\s*>/gi);
  const out = { base: String(baseUrl || ''), themeColors: [], styles: [], inlineStyles: [], sheets: [], googleFamilies: [] };
  const abs = (href) => { try { return new URL(href, out.base || undefined); } catch { return null; } };
  const baseTag = tagsOf(src, 'base', 1)[0];
  if (baseTag) {
    const a = attrsOf(baseTag);
    const u = a.href ? abs(a.href) : null;
    if (u) out.base = u.toString();
  }
  for (const tag of tagsOf(src, 'meta')) {
    const a = attrsOf(tag);
    if (String(a.name || '').trim().toLowerCase() === 'theme-color' && a.content) out.themeColors.push(a.content.trim());
  }
  const addSheet = (href) => {
    const u = href ? abs(href) : null;
    if (!u) return;
    if (isGoogleFontsCss(u)) { for (const f of googleFamiliesOf(u)) if (!out.googleFamilies.includes(f)) out.googleFamilies.push(f); return; }
    if (u.protocol === 'https:' && !out.sheets.includes(u.toString())) out.sheets.push(u.toString());
  };
  for (const tag of tagsOf(src, 'link')) {
    const a = attrsOf(tag);
    if (!a.href) continue;
    const u = abs(a.href);
    if (u && isGoogleFontsCss(u)) { addSheet(a.href); continue; } // a preload of Google Fonts CSS names the font too
    const rel = String(a.rel || '').toLowerCase().split(/\s+/);
    if (!rel.includes('stylesheet')) continue;
    if (a.media && /\bprint\b/i.test(a.media) && !/\b(all|screen)\b/i.test(a.media)) continue;
    addSheet(a.href);
  }
  out.styles = styleBlocksOf(src);
  // (this one is already one pass: each quoted value runs to its own closing quote, never past it)
  for (const m of src.matchAll(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) out.inlineStyles.push(decodeEntities(m[1] != null ? m[1] : m[2]));
  for (const css of out.styles) for (const href of importsOf(css)) addSheet(href);
  return out;
}

// ── CSS ───────────────────────────────────────────────────────────────────────
// The sheet without its comments — one pass (cutSpans); the lazy regex took 0.4 s on '/* ' × 32k never closed.
const stripCssComments = (css) => cutSpans(String(css || ''), /\/\*/g, /\*\//g);

/** One read's allowance — characters of CSS still to be read, rules to keep, a wall clock — shared by every parse loop of the read. */
const newBudget = (timeMs = CSS_TIME_BUDGET_MS) => ({ text: CSS_TEXT_BUDGET, maxRules: CSS_RULE_BUDGET, until: Date.now() + timeMs, spent: false });
/** Whether the read must stop keeping rules (latches: once spent, spent). */
const budgetSpent = (b, rules) => b.spent || (b.spent = rules.length >= b.maxRules || Date.now() > b.until);

function matchingBrace(css, open) {
  let depth = 0;
  let quote = null;
  for (let j = open; j < css.length; j++) {
    const ch = css[j];
    if (quote) { if (ch === '\\') j++; else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return j; }
  }
  return -1;
}

/**
 * The next `{` at or after `from` (quotes skipped) and where the prelude before it begins: just past the
 * last top-level `;` or `}` met on the way (a @charset / @import statement, a stray brace) — null when no
 * rule opens. ⚠️ WHY THE START IS FOUND ON THE WAY FORWARD: cssRules used to ask css.lastIndexOf(';', open)
 * and lastIndexOf('}', open) for every rule, which on a sheet with no ';' at all scans back to offset 0
 * every time — 'a{}' repeated was O(n²) (20k rules 0.36 s, 40k 2.1 s, 160k 36 s, the 1.4 MB a page may
 * carry: minutes) on the API's thread. Noting the separator as the scan advances costs nothing extra.
 */
function nextRule(css, from) {
  let quote = null;
  let start = from;
  for (let j = from; j < css.length; j++) {
    const ch = css[j];
    if (quote) { if (ch === '\\') j++; else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{') return { open: j, start };
    else if (ch === ';' || ch === '}') start = j + 1;
  }
  return null;
}

const NESTING_AT_RULES = new Set(['media', 'supports', 'layer', 'container', 'document', '-moz-document', 'scope']);

/**
 * Every { selector, decls } in a stylesheet, descending into @media-like blocks; @font-face kept as a rule.
 * One pass — nextRule and matchingBrace each move past what they read (a nested block is read once more
 * per level, at most 4 deep). Stops with what it has once `budget` is spent: rules kept or wall clock.
 */
function cssRules(css, out = [], depth = 0, budget = newBudget()) {
  let i = 0;
  while (i < css.length && !budgetSpent(budget, out)) {
    const at = nextRule(css, i);
    if (!at) break;
    const prelude = css.slice(at.start, at.open).trim();
    const close = matchingBrace(css, at.open);
    if (close < 0) break;
    const body = css.slice(at.open + 1, close);
    if (prelude.startsWith('@')) {
      const name = ((/^@([a-z-]+)/i.exec(prelude) || [])[1] || '').toLowerCase();
      if (NESTING_AT_RULES.has(name)) { if (depth < 4) cssRules(body, out, depth + 1, budget); }
      else if (name === 'font-face') out.push({ selector: '@font-face', decls: body });
      // @keyframes, @page, @property, @counter-style: nothing brand-like lives there
    } else if (prelude) {
      out.push({ selector: prelude, decls: body });
    }
    i = close + 1;
  }
  return out;
}

/** 'color: red; background: url(a;b.png)' → [['color', 'red'], ['background', 'url(a;b.png)']] (paren-aware, nested blocks skipped). */
function declarationsOf(text) {
  const parts = [];
  let cur = '';
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) { cur += ch; if (ch === '\\') { cur += text[++i] || ''; } else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ';' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  const out = [];
  for (const p of parts) {
    if (p.includes('{') || p.includes('}')) continue;
    const idx = p.indexOf(':');
    if (idx <= 0) continue;
    const prop = p.slice(0, idx).trim().toLowerCase();
    const value = p.slice(idx + 1).replace(/!\s*important\s*$/i, '').trim();
    if (!prop || !value || value.length > VALUE_MAX || /[^\w-]/.test(prop)) continue;
    out.push([prop, value]);
  }
  return out;
}

/**
 * var(--x[, fallback]) resolved through the page's custom properties, a few hops deep. Bounded two ways,
 * because a page can feed a property to itself: `--a: var(--b) × 120` over `--b: var(--c) × 120` over … is
 * 120⁴ hops at 4 deep and used to throw "Invalid string length" after a long stall — now at most VAR_STEPS
 * references are followed per value over every hop (the rest stays as written), and the result stops at
 * VALUE_MAX characters (no colour or font stack is longer).
 */
function substituteVars(value, props, depth = 0, budget = { steps: VAR_STEPS }) {
  if (depth > 4 || !value.includes('var(')) return value;
  let out = '';
  let i = 0;
  while (i < value.length && out.length <= VALUE_MAX) {
    const at = value.indexOf('var(', i);
    if (at < 0 || budget.steps-- <= 0) { out += value.slice(i); break; }
    out += value.slice(i, at);
    let d = 0;
    let j = at + 3;
    for (; j < value.length; j++) {
      if (value[j] === '(') d++;
      else if (value[j] === ')') { d--; if (d === 0) break; }
    }
    if (j >= value.length) { out += value.slice(at); break; }
    const inner = value.slice(at + 4, j);
    const comma = inner.indexOf(',');
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim().toLowerCase();
    const fallback = comma < 0 ? '' : inner.slice(comma + 1).trim();
    const resolved = props.has(name) ? props.get(name) : fallback;
    out += resolved ? substituteVars(resolved, props, depth + 1, budget) : '';
    i = j + 1;
  }
  return out;
}

// ── Colours ───────────────────────────────────────────────────────────────────
const NAMED = {
  black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], green: [0, 128, 0], blue: [0, 0, 255], yellow: [255, 255, 0],
  orange: [255, 165, 0], purple: [128, 0, 128], pink: [255, 192, 203], gray: [128, 128, 128], grey: [128, 128, 128],
  silver: [192, 192, 192], maroon: [128, 0, 0], navy: [0, 0, 128], teal: [0, 128, 128], olive: [128, 128, 0], lime: [0, 255, 0],
  aqua: [0, 255, 255], cyan: [0, 255, 255], fuchsia: [255, 0, 255], magenta: [255, 0, 255], brown: [165, 42, 42], gold: [255, 215, 0],
  coral: [255, 127, 80], crimson: [220, 20, 60], indigo: [75, 0, 130], violet: [238, 130, 238], tomato: [255, 99, 71],
  orangered: [255, 69, 0], royalblue: [65, 105, 225], dodgerblue: [30, 144, 255], steelblue: [70, 130, 180], skyblue: [135, 206, 235],
  lightgray: [211, 211, 211], lightgrey: [211, 211, 211], darkgray: [169, 169, 169], darkgrey: [169, 169, 169], dimgray: [105, 105, 105],
  dimgrey: [105, 105, 105], whitesmoke: [245, 245, 245], gainsboro: [220, 220, 220], lightblue: [173, 216, 230], darkblue: [0, 0, 139],
  darkgreen: [0, 100, 0], forestgreen: [34, 139, 34], seagreen: [46, 139, 87], limegreen: [50, 205, 50], darkred: [139, 0, 0],
  firebrick: [178, 34, 34], salmon: [250, 128, 114], hotpink: [255, 105, 180], deeppink: [255, 20, 147], chocolate: [210, 105, 30],
  sienna: [160, 82, 45], tan: [210, 180, 140], khaki: [240, 230, 140], beige: [245, 245, 220], ivory: [255, 255, 240], snow: [255, 250, 250],
  linen: [250, 240, 230], lavender: [230, 230, 250], plum: [221, 160, 221], orchid: [218, 112, 214], turquoise: [64, 224, 208],
  slategray: [112, 128, 144], slategrey: [112, 128, 144], lightslategray: [119, 136, 153], darkslategray: [47, 79, 79],
  midnightblue: [25, 25, 112], rebeccapurple: [102, 51, 153], darkorange: [255, 140, 0], goldenrod: [218, 165, 32], darkviolet: [148, 0, 211],
  mediumpurple: [147, 112, 219], mediumseagreen: [60, 179, 113], cadetblue: [95, 158, 160], cornflowerblue: [100, 149, 237],
  deepskyblue: [0, 191, 255], darkcyan: [0, 139, 139], darkslateblue: [72, 61, 139], slateblue: [106, 90, 205], darkolivegreen: [85, 107, 47],
  olivedrab: [107, 142, 35], yellowgreen: [154, 205, 50], springgreen: [0, 255, 127], mediumvioletred: [199, 21, 133], palevioletred: [219, 112, 147],
};

const clamp255 = (n) => Math.max(0, Math.min(255, Math.round(n)));

function hslToRgb(h, s, l) {
  const hh = (((h % 360) + 360) % 360) / 360;
  if (s === 0) return [clamp255(l * 255), clamp255(l * 255), clamp255(l * 255)];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [clamp255(f(hh + 1 / 3) * 255), clamp255(f(hh) * 255), clamp255(f(hh - 1 / 3) * 255)];
}

function toHsl([r, g, b]) {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rr) h = (gg - bb) / d + (gg < bb ? 6 : 0);
  else if (max === gg) h = (bb - rr) / d + 2;
  else h = (rr - gg) / d + 4;
  return { h: h * 60, s, l };
}

const toHex = ([r, g, b]) => '#' + [r, g, b].map((n) => clamp255(n).toString(16).padStart(2, '0')).join('');
const hexToRgb = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];

const num = (s, scale = 255) => {
  const t = String(s).trim();
  if (/%$/.test(t)) return (parseFloat(t) / 100) * scale;
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : NaN;
};

/** One CSS colour token → [r, g, b], or null (unparsable, transparent, currentColor, a keyword). */
function parseColor(token) {
  const t = String(token || '').trim().toLowerCase();
  if (!t) return null;
  let m;
  if ((m = /^#([0-9a-f]{3,8})$/.exec(t))) {
    const h = m[1];
    if (h.length === 3 || h.length === 4) {
      if (h.length === 4 && h[3] === '0') return null;
      return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
    }
    if (h.length === 6 || h.length === 8) {
      if (h.length === 8 && h.slice(6) === '00') return null;
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    return null;
  }
  if ((m = /^rgba?\(\s*([^)]*)\)$/.exec(t))) {
    const parts = m[1].split(/\s*[,/]\s*|\s+/).filter(Boolean);
    if (parts.length < 3) return null;
    const rgb = parts.slice(0, 3).map((p) => num(p));
    if (rgb.some((n) => !Number.isFinite(n))) return null;
    if (parts[3] !== undefined) { const a = num(parts[3], 1); if (Number.isFinite(a) && a <= 0) return null; }
    return rgb.map(clamp255);
  }
  if ((m = /^hsla?\(\s*([^)]*)\)$/.exec(t))) {
    const parts = m[1].split(/\s*[,/]\s*|\s+/).filter(Boolean);
    if (parts.length < 3) return null;
    let h = parseFloat(parts[0]);
    if (/turn$/.test(parts[0])) h *= 360;
    else if (/rad$/.test(parts[0])) h = (h * 180) / Math.PI;
    const s = num(parts[1], 1);
    const l = num(parts[2], 1);
    if (![h, s, l].every(Number.isFinite)) return null;
    if (parts[3] !== undefined) { const a = num(parts[3], 1); if (Number.isFinite(a) && a <= 0) return null; }
    return hslToRgb(h, Math.max(0, Math.min(1, s)), Math.max(0, Math.min(1, l)));
  }
  // The bare channel lists custom properties carry for rgb(var(--x) / .5): "13, 110, 253" · "59 130 246" · "222 47% 11%"
  if ((m = /^(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})$/.exec(t))) return [m[1], m[2], m[3]].map((n) => clamp255(Number(n)));
  if ((m = /^([\d.]+)(?:deg)?\s+([\d.]+)%\s+([\d.]+)%$/.exec(t))) return hslToRgb(parseFloat(m[1]), parseFloat(m[2]) / 100, parseFloat(m[3]) / 100);
  if (Object.prototype.hasOwnProperty.call(NAMED, t)) return NAMED[t].slice();
  return null;
}

/** Every colour in a declaration value (a gradient carries several), url() and strings ignored. */
function coloursIn(value) {
  const v = String(value).replace(/url\([^)]*\)/gi, ' ').replace(/"[^"]*"|'[^']*'/g, ' ');
  const out = [];
  const whole = parseColor(v);
  if (whole) return [whole];
  for (const m of v.matchAll(/#[0-9a-f]{3,8}(?![0-9a-z])|\b(?:rgba?|hsla?)\([^()]*\)|\b[a-z]{3,20}\b/gi)) {
    const c = parseColor(m[0]);
    if (c) out.push(c);
  }
  return out;
}

const brandish = (hsl) => hsl.s >= 0.25 && hsl.l >= 0.12 && hsl.l <= 0.85;
const hueDistance = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

const VAR_KEYWORD_RE = /(brand|primary|accent|main|theme)/;
const VAR_MODIFIER_RE = /(light|dark|hover|active|focus|muted|subtle|contrast|text|fg|foreground|bg|background|border|shadow|disabled|inverse|soft|tint|shade|secondary|tertiary|gradient|-\d{1,3}$|-\d{1,3}-)/;

/** The custom properties that name the brand, ranked: --brand = --primary > --accent > --main/--theme; plain over modified (-hover, -light, -bg…). */
function rankedVarCandidates(props, freq) {
  const best = new Map(); // hex → { hex, hsl, score, first }
  let order = 0;
  for (const [name, raw] of props) {
    const key = name.replace(/^--/, '').toLowerCase();
    if (!VAR_KEYWORD_RE.test(key)) continue;
    const value = substituteVars(raw, props);
    const rgb = parseColor(value) || coloursIn(value)[0];
    if (!rgb) continue;
    const hsl = toHsl(rgb);
    if (!brandish(hsl)) continue;
    const hex = toHex(rgb);
    // --brand and --primary tie; the one the stylesheet actually paints with (frequency) breaks it.
    let score = /brand|primary/.test(key) ? 30 : /accent/.test(key) ? 20 : 10;
    if (VAR_MODIFIER_RE.test(key) && !/-(500|600)$/.test(key)) score -= 25;
    score += Math.min(9, (freq.get(hex) || { weight: 0 }).weight);
    const prev = best.get(hex);
    if (!prev || prev.score < score) best.set(hex, { hex, hsl, score, first: prev ? prev.first : order++ });
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.first - b.first);
}

function chooseColours({ themeColors, props, freq }) {
  let primary = null;
  let from = null;
  for (const t of themeColors || []) {
    const rgb = parseColor(t);
    if (rgb && brandish(toHsl(rgb))) { primary = toHex(rgb); from = 'theme-color'; break; }
  }
  const varCands = rankedVarCandidates(props, freq);
  if (!primary && varCands.length) { primary = varCands[0].hex; from = 'css-var'; }
  const freqCands = [...freq.values()].filter((e) => brandish(e.hsl)).sort((a, b) => b.weight - a.weight || a.first - b.first);
  if (!primary && freqCands.length) { primary = freqCands[0].hex; from = 'frequency'; }
  let secondary = null;
  if (primary) {
    const ph = toHsl(hexToRgb(primary)).h;
    const next = [...varCands, ...freqCands].find((e) => e.hex !== primary && hueDistance(e.hsl.h, ph) >= 30);
    secondary = next ? next.hex : null;
  }
  return { primary, secondary, from };
}

// ── Fonts ─────────────────────────────────────────────────────────────────────
const GENERIC_FAMILIES = new Set([
  'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded',
  '-apple-system', 'blinkmacsystemfont', 'segoe ui', 'segoe ui emoji', 'segoe ui symbol', 'apple color emoji', 'noto color emoji', 'emoji',
  'arial', 'helvetica', 'helvetica neue', 'times', 'times new roman', 'courier', 'courier new', 'georgia', 'verdana', 'tahoma', 'trebuchet ms',
  'liberation sans', 'liberation serif', 'dejavu sans', 'dejavu serif', 'nimbus sans', 'oxygen', 'oxygen-sans', 'cantarell', 'sans', 'math',
  'inherit', 'initial', 'unset', 'revert', 'none', 'system', 'menu', 'caption', 'icon', 'message-box', 'small-caption', 'status-bar',
]);
const FALLBACK_FAMILIES = new Set(['roboto', 'ubuntu', 'fira sans', 'noto sans', 'droid sans']);
const ICON_FAMILY_RE = /icon|glyph|awesome|symbol|emoji|webflow|slick|swiper|revicons|dashicons|ionicons|linearicons|themify|eleganticons|pe-icon|flaticon/i;

const cleanFamily = (f) => String(f || '').replace(/^["'\s]+|["'\s]+$/g, '').replace(/\s+/g, ' ').trim();

/** 'real' (a chosen font), 'fallback' (the tail of a default stack), or 'excluded'. */
function classifyFamily(f) {
  const fam = cleanFamily(f);
  const key = fam.toLowerCase();
  if (!fam || fam.length > 60 || fam.length < 2 || /[(){};:<>]/.test(fam) || !/^[a-z0-9][a-z0-9 .'_-]*$/i.test(fam)) return 'excluded';
  if (GENERIC_FAMILIES.has(key) || ICON_FAMILY_RE.test(key)) return 'excluded';
  if (FALLBACK_FAMILIES.has(key)) return 'fallback';
  return 'real';
}

/** The families a font-family / font declaration names, in stack order. */
function familiesOf(prop, value) {
  let list = value;
  if (prop === 'font') {
    // The families follow the size (the last unit-bearing token — a bare "400" is a weight). Greedy prefix,
    // so "italic 400 16px/1.5 X, Y" splits after "16px/1.5", not after "400".
    const m = /^(?:.*\s)?(?:[\d.]+(?:px|em|rem|%|pt|vw|vh|ch|ex|cm|mm|in)|xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger)(?:\s*\/\s*[\w.%-]+)?\s+([^;]+)$/i.exec(value);
    if (!m) return [];
    list = m[1];
  }
  const out = [];
  let cur = '';
  let quote = null;
  for (const ch of list) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === ',') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(cleanFamily).filter(Boolean);
}

const isRootSelector = (selector) => String(selector).split(',').some((s) => /^(html|body|:root|html\s+body|html\s*>\s*body)$/i.test(s.trim()));

function chooseFont({ fontDecls, googleFamilies }) {
  const linked = (googleFamilies || []).filter((f) => classifyFamily(f) !== 'excluded');
  const isLinked = (fam) => linked.some((f) => f.toLowerCase() === cleanFamily(fam).toLowerCase());
  const firstOf = (families, cls) => families.find((f) => classifyFamily(f) === cls) || null;
  let bodyReal = null;
  let bodyFallback = null;
  for (const d of fontDecls) {
    if (!isRootSelector(d.selector)) continue;
    bodyReal = bodyReal || firstOf(d.families, 'real');
    bodyFallback = bodyFallback || firstOf(d.families, 'fallback');
  }
  if (bodyReal) return { family: bodyReal, from: 'body', googleLinked: isLinked(bodyReal) };
  if (linked.length) return { family: linked[0], from: 'google-link', googleLinked: true };
  const counts = new Map();
  const bump = (fam) => { const k = fam.toLowerCase(); const e = counts.get(k) || { family: fam, n: 0, first: counts.size }; e.n++; counts.set(k, e); };
  for (const d of fontDecls) { const f = firstOf(d.families, 'real'); if (f) bump(f); }
  const top = [...counts.values()].sort((a, b) => b.n - a.n || a.first - b.first)[0];
  if (top) return { family: top.family, from: 'frequency', googleLinked: isLinked(top.family) };
  if (bodyFallback) return { family: bodyFallback, from: 'body', googleLinked: isLinked(bodyFallback) };
  counts.clear();
  for (const d of fontDecls) { const f = firstOf(d.families, 'fallback'); if (f) bump(f); }
  const fb = [...counts.values()].sort((a, b) => b.n - a.n || a.first - b.first)[0];
  return fb ? { family: fb.family, from: 'frequency', googleLinked: isLinked(fb.family) } : null;
}

// ── The heuristics over a parsed page ─────────────────────────────────────────
const COLOR_PROPS = new Set(['color', 'background', 'background-color', 'border-color']);

/**
 * Pure: a parsed page + the text of its fetched stylesheets → { primary, secondary, from, font } where
 * font is { family, from, googleLinked } | null. No network — the Google check happens in extractBrand.
 * ⚠️ BOUNDED (see "The read budget"): the CSS is read in page order — <style> blocks, then the sheets, then
 * style="" attributes — until CSS_TEXT_BUDGET characters are read (the text that crosses the line is cut
 * back to its last '}', the rest is not read), CSS_RULE_BUDGET rules are kept, or CSS_TIME_BUDGET_MS have
 * passed; what was read by then is judged. `timeBudgetMs` exists for the harness.
 */
function brandFromSources(parsed, sheets = [], { timeBudgetMs = CSS_TIME_BUDGET_MS } = {}) {
  const budget = newBudget(timeBudgetMs);
  const rules = [];
  // The next text, as much of it as the budget still admits — whole, cut to its last '}' on the budget's
  // side of the line, or none (a text with no rule boundary inside the allowance has nothing to read).
  const admit = (text) => {
    const css = String(text || '');
    const cut = css.length <= budget.text ? css : css.slice(0, css.lastIndexOf('}', budget.text) + 1);
    budget.text -= cut.length;
    return cut;
  };
  for (const text of [...(parsed.styles || []), ...sheets]) {
    if (budget.text <= 0 || budgetSpent(budget, rules)) break;
    cssRules(stripCssComments(admit(text)), rules, 0, budget);
  }
  for (const s of parsed.inlineStyles || []) {
    if (budget.text <= 0 || budgetSpent(budget, rules)) break;
    const decls = String(s || '').slice(0, budget.text); // declarations, not rules: a plain cut is a clean cut
    budget.text -= decls.length;
    rules.push({ selector: '(inline)', decls });
  }
  const props = new Map();
  for (const r of rules) for (const [prop, value] of declarationsOf(r.decls)) if (prop.startsWith('--') && !props.has(prop)) props.set(prop, value);
  const freq = new Map();
  const fontDecls = [];
  let order = 0;
  for (const r of rules) {
    if (Date.now() > budget.until) break; // the clock covers the judging too: a colour a rule — this is where a rule costs most
    for (const [prop, value] of declarationsOf(r.decls)) {
      if (COLOR_PROPS.has(prop)) {
        const weight = prop.startsWith('background') ? 2 : 1;
        for (const rgb of coloursIn(substituteVars(value, props))) {
          const hex = toHex(rgb);
          const e = freq.get(hex) || { hex, hsl: toHsl(rgb), weight: 0, first: order++ };
          e.weight += weight;
          freq.set(hex, e);
        }
      } else if (prop === 'font-family' || prop === 'font') {
        const families = familiesOf(prop, substituteVars(value, props));
        if (families.length) fontDecls.push({ selector: r.selector, families });
      }
    }
  }
  const colours = chooseColours({ themeColors: parsed.themeColors || [], props, freq });
  return { ...colours, font: chooseFont({ fontDecls, googleFamilies: parsed.googleFamilies || [] }) };
}

// ── Google Fonts ──────────────────────────────────────────────────────────────
const googleCache = new Map(); // family (lower-case) → { ok, at }

/** The cached answer for a family: true / false, or null when it was never checked in the last 24 h. */
function googleFontKnown(family) {
  const fam = cleanFamily(family);
  const e = fam ? googleCache.get(fam.toLowerCase()) : null;
  if (!e) return null;
  if (Date.now() - e.at > GOOGLE_TTL_MS) { googleCache.delete(fam.toLowerCase()); return null; }
  return e.ok;
}

/**
 * Whether Google Fonts serves `family` (its css2 endpoint answers 200 for a family it has, 400 for one it
 * does not). Cached for 24 h either way; a network failure is NOT cached and answers false. Never throws.
 */
async function checkGoogleFont(family, { timeoutMs = GOOGLE_CHECK_MS, deadline = null, lookup, allowLoopback = false, ca } = {}) {
  try {
    const fam = cleanFamily(family);
    if (!fam || classifyFamily(fam) === 'excluded') return false;
    const known = googleFontKnown(fam);
    if (known !== null) return known;
    const until = Math.min(Date.now() + timeoutMs, deadline || Infinity);
    if (until - Date.now() < 200) return false;
    const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fam).replace(/%20/g, '+')}`;
    const res = await fetchCapped(url, { deadline: until, cap: GOOGLE_CAP, accept: (t) => !t || t === 'text/css', lookup, allowLoopback, ca });
    if (res.ok) { googleCache.set(fam.toLowerCase(), { ok: true, at: Date.now() }); return true; }
    if (res.refused === 'status' && (res.status === 400 || res.status === 404)) googleCache.set(fam.toLowerCase(), { ok: false, at: Date.now() });
    return false;
  } catch {
    return false;
  }
}

// ── Stylesheet choice ─────────────────────────────────────────────────────────
// A framework's stylesheet is that framework's brand (Bootstrap's blue on every Bootstrap site): the
// site's own sheets come first, and the well-known libraries are not read at all.
const LIBRARY_RE = /(^|\/)(bootstrap|bulma|foundation|materialize|tailwind|normalize|reset|sanitize|animate|font-?awesome|all\.min\.css$|swiper|slick|owl\.|jquery|leaflet|mapbox|video-?js|plyr|glide|aos|flickity|lightbox|fancybox|magnific|select2|choices|flatpickr|datepicker|toastr|sweetalert|prism|highlight|katex|mathjax|icons?)[\w.-]*\.css/i;
const registrable = (host) => String(host || '').toLowerCase().split('.').slice(-2).join('.');

function pickSheets(urls, pageHost, max = MAX_SHEETS) {
  const own = [];
  const other = [];
  const seen = new Set();
  const site = registrable(pageHost);
  for (const u of urls || []) {
    let x;
    try { x = new URL(u); } catch { continue; }
    if (x.protocol !== 'https:' || seen.has(x.href)) continue;
    seen.add(x.href);
    if (LIBRARY_RE.test(x.pathname)) continue;
    (registrable(x.hostname) === site ? own : other).push(x.href);
  }
  return [...own, ...other].slice(0, max);
}

// ── extractBrand ──────────────────────────────────────────────────────────────
const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml']);

/**
 * The brand of the website at https://<domain>/ →
 *   { primary: '#rrggbb'|null, secondary: '#rrggbb'|null, font: { family, google }|null,
 *     from: { primary: 'theme-color'|'css-var'|'frequency'|null, font: 'body'|'frequency'|'google-link'|null },
 *     fetchedAt: ISO }
 * or null (nothing found, or any refusal / failure). `website` may carry a scheme: an explicit non-https
 * scheme is refused rather than upgraded. Bounded by timeoutMs on the network and by the read budget on the
 * parse. NEVER throws — null, undefined or a non-object in either argument answers null like any other
 * junk input.
 *
 * `lookup`, `allowLoopback` and `ca` exist for the test harness only (a fixture server on 127.0.0.1 with
 * its own certificate); production callers pass nothing but timeoutMs.
 */
async function extractBrand(input, options) {
  try {
    // Destructured INSIDE the try: a parameter default `{ website, domain } = {}` covers undefined but not
    // null, and extractBrand(null) rejected — the one input that broke "never throws".
    const { website, domain } = input && typeof input === 'object' ? input : {};
    const { timeoutMs = TIMEOUT_MS, lookup, allowLoopback = false, ca } = options && typeof options === 'object' ? options : {};
    let host = String(domain || '').trim().toLowerCase();
    let port = '';
    let explicitScheme = null;
    if (typeof website === 'string' && website.trim()) {
      const w = website.trim();
      const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(w);
      explicitScheme = m ? m[1].toLowerCase() : null;
      try {
        const u = new URL(m ? w : 'https://' + w);
        if (!host) host = u.hostname.toLowerCase();
        if (u.hostname.toLowerCase() === host) port = u.port; // a port only when the website names one for THIS host (the harness's fixture)
      } catch { /* the domain alone decides */ }
    }
    if (explicitScheme && explicitScheme !== 'https') return null;
    host = host.replace(/\.$/, '');
    if (!host || !validHost(host)) return null;
    const deadline = Date.now() + Math.max(500, Number(timeoutMs) || TIMEOUT_MS);
    const net_ = { deadline, lookup, allowLoopback, ca };

    const page = await fetchCapped(`https://${port ? `${host}:${port}` : host}/`, { ...net_, cap: HTML_CAP, accept: (t) => HTML_TYPES.has(t) });
    if (!page.ok || !page.body) return null;
    const parsed = parseHtml(page.body.toString('utf8'), page.url);
    let finalHost = host;
    try { finalHost = new URL(page.url).hostname; } catch { /* keep host */ }

    const sheetUrls = pickSheets(parsed.sheets, finalHost);
    const sheets = [];
    if (sheetUrls.length && deadline - Date.now() > 300) {
      const results = await Promise.all(sheetUrls.map((u) => fetchCapped(u, { ...net_, cap: CSS_CAP, accept: (t) => !t || t === 'text/css' })));
      for (const r of results) if (r.ok && r.body) sheets.push(r.body.toString('utf8'));
    }

    const found = brandFromSources(parsed, sheets);
    let font = null;
    if (found.font) {
      const google = found.font.googleLinked ? true : await checkGoogleFont(found.font.family, { deadline, lookup, allowLoopback, ca });
      font = { family: found.font.family, google: google === true };
    }
    if (!found.primary && !font) return null;
    return {
      primary: found.primary,
      secondary: found.secondary,
      font,
      from: { primary: found.primary ? found.from : null, font: font ? found.font.from : null },
      fetchedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

module.exports = {
  extractBrand,
  checkGoogleFont,
  googleFontKnown,
  // exposed for the harness / tests only
  _internals: {
    TIMEOUT_MS, HTML_CAP, CSS_CAP, MAX_REDIRECTS, MAX_SHEETS,
    CSS_TEXT_BUDGET, CSS_RULE_BUDGET, CSS_TIME_BUDGET_MS, IMPORT_SCAN_CHARS, VALUE_MAX, VAR_STEPS,
    isPublicAddress, parseIPv4, parseIPv6, validHost, resolvePublic, fetchCapped,
    parseHtml, importsOf, cutSpans, tagsOf, styleBlocksOf, stripCssComments,
    cssRules, declarationsOf, substituteVars, parseColor, coloursIn, toHsl, toHex, brandish,
    familiesOf, classifyFamily, chooseFont, chooseColours, brandFromSources, pickSheets, googleFamiliesOf,
    _googleCache: googleCache,
  },
};
