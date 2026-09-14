// brandExtract (server/services/brandExtract.js) — the employer's website colour + font, read without AI.
//   node server/scripts/test-brand-extract.js
//
// ⚠️ WHY: this module fetches a URL the EMPLOYER's record names, from a server that can reach private networks
// and cloud metadata. Every refusal here (private / loopback / link-local / metadata ranges, v4 carried inside v6,
// non-https, ≤3 redirects re-checked per hop, 1.5 MB page / 400 KB sheet caps counted AFTER decompression, only
// text/html pages) is a rule an SSRF would walk through if it went missing. A fixture HTTPS server on 127.0.0.1
// stands in for "a website" (allowLoopback + its own certificate — test-only options); every other rule is the
// real one. NO NETWORK: the injected lookup REFUSES any host the fixture does not own, and the Google Fonts
// answer comes from the module's own 24 h memory, pre-filled.
'use strict';
const https = require('https');
const zlib = require('zlib');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const BE = require(path.join(ROOT, 'server/services/brandExtract.js'));
const { fetchCapped, HTML_CAP, isPublicAddress, parseHtml, brandFromSources, _googleCache } = BE._internals;

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x).slice(0, 400) : '')); } };

// ── the fixture certificate (CN=brand-fixture, 2026-09 → 2036-09; SANs: site/big/cssroot.example, localhost, 127.0.0.1) ──
// A throwaway self-signed pair for THIS fixture server only — it signs nothing else and is trusted by nothing else.
const FIXTURE_CERT = `-----BEGIN CERTIFICATE-----
MIIDWzCCAkOgAwIBAgIUXTXPT/2QRz+rohe0Up3BiX6s5GowDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNYnJhbmQtZml4dHVyZTAeFw0yNjA5MTQyMjE1MDhaFw0z
NjA5MTEyMjE1MDhaMBgxFjAUBgNVBAMMDWJyYW5kLWZpeHR1cmUwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQCsK8TictEtSxUrhB6iBlbP7RbCd9LfBsj+
K096v58wUNhinoCoC1fjhynW51IT5TmSf5QAMdu9YlB0Tv9hUXWoBdIyBFxrjX89
wZaq1nhHmDctxTFVXVSIIICiFD83867LL0S7en3GcF28Vxy0JwDQ3f5Pf49AXrpr
wBBOJVxX3JhXdx4UrfaLGtoYACYtajx75wt5TNmdVTk/P7ZQlCi1pg9l0RVPR3uK
WWx53ctPMkzOXE9f7CZypfQec/jJEiAwNSPNIOD6V7V0Y6bPLS60M/ZMP5fIQxwr
l8A4//ib9XwFUQRN+MjJhws4wpawxjnp95nRgJhXQKCxAMiialJvAgMBAAGjgZww
gZkwHQYDVR0OBBYEFEyYH4DCApPCgTs0nv9KgvZrdsSHMB8GA1UdIwQYMBaAFEyY
H4DCApPCgTs0nv9KgvZrdsSHMA8GA1UdEwEB/wQFMAMBAf8wRgYDVR0RBD8wPYIM
c2l0ZS5leGFtcGxlggtiaWcuZXhhbXBsZYIPY3Nzcm9vdC5leGFtcGxlgglsb2Nh
bGhvc3SHBH8AAAEwDQYJKoZIhvcNAQELBQADggEBAGR7q8DA3S5/vM+P+6/YQspt
17ME0s5/StsIRb84gQ9ZC+JR6FQwAxCf8cBc34bfDYWl0mk4CD1bYGG0fF+kA7Za
Zfsr8Tqe5HvhguelJ+Agn+MKc4lx2YXKx0biPBNKc9Xk/3DnVWpesyDekax3tYqc
5ExHGvOj3SE+5/e1/jJoQxAhDvkYV2JhI5tewQNzitiGvFmyA62kxvtoWqmW+6nj
0m1AWZhUvduRcVYgxGmWTisNgDHEDpuUvH7EMexZuSzrsQyxVky+VW0py5fibRud
dOmykwZc5wC44+buC6D651EJhTYVgvN3fmLn+rjwOwbyPmx41n+UFBmIglcrVUY=
-----END CERTIFICATE-----
`;
const FIXTURE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCsK8TictEtSxUr
hB6iBlbP7RbCd9LfBsj+K096v58wUNhinoCoC1fjhynW51IT5TmSf5QAMdu9YlB0
Tv9hUXWoBdIyBFxrjX89wZaq1nhHmDctxTFVXVSIIICiFD83867LL0S7en3GcF28
Vxy0JwDQ3f5Pf49AXrprwBBOJVxX3JhXdx4UrfaLGtoYACYtajx75wt5TNmdVTk/
P7ZQlCi1pg9l0RVPR3uKWWx53ctPMkzOXE9f7CZypfQec/jJEiAwNSPNIOD6V7V0
Y6bPLS60M/ZMP5fIQxwrl8A4//ib9XwFUQRN+MjJhws4wpawxjnp95nRgJhXQKCx
AMiialJvAgMBAAECggEAO1TQAftwQ0wLDRZ4GfzWQMwi2jxBsnLbo99YAeR0HsnV
b9LQYliaXoHPNMw9eDa3qtkFLzX/VBnDwPkSP767LX5oC61+DeBSl30Vh2TmSUHW
zhKU6CaEAW819OTGTmlO9J0i8fqJym8hlkxsy1ZfjRrbTxkVzCh41LX4yH1Of8Yo
C/EKYNfUXDl0rUgN64DU0T3CaMVbZsR4CCfI8fCwi4nAyggT5enmteQT5Q0CHsYD
3oudYjeljaXbbW17bHkZ58dAIVKIRS1OLtzP1zmDAVf6hftfie5GDmMbKiySIngw
oTJfJV4TjVsPJstOUjp29WUpeH9g9Vx+o33UyDJeLQKBgQDWpDSsVeuJs2cBASNd
58+ciCVVvKr2eQh3KTGclCgnIADebnFNqM86ByGgPTJp39GkgkYl+7KU5Cw6F8j8
1J6hNWvh53v1Q9R3ZF20efH/X1bPPNurvnqAkybYLwFZlteOiTcnCEo2pcgXmgAU
fuDvO2Mqj9Romc/vmAvr7isT3QKBgQDNWJaWbV1aPDg12SmKxDLL3Suf17ExilRa
4iLgd87wpyBfeLANC2UhyxjPTTypenwKqdiOPiTWzj+WaFgrvSy7UAlXkD+jvkse
JAepXidXClXHF02wEk9QyAHk+ySP8ZaczVLNiUVwDjDUqlViGsNP9FRkZrkzJjB7
xt4EwbkQuwKBgQCZtgx2oi1EdrK8OGlwdXLrYWCDTtKMIc8bLuf1fvBmXHfi0urX
N533q2W8UDcLNRr4GcdMqjyQffriO2hXD5juT8iLhe/yi/na6ohkl7PjMw6C6M1T
59voufjmdnscAncp/z/89uXWztBFfqayBs7k4/23XDs8EXKk3ZkkA3LcDQKBgAI0
sWlsQ1R00SXC729OLD2EYrOU3ZJqqf1P8I/4uYBcSzy7TyjUtoFmbR3M9pnbdvmm
WW0tvbeQ/53eARR3M8PPWEpYglZ/9M6eFHb9S+7jbYh195+skq2LeHm9OOdS8Qs+
KWWL0/MgM+YU7lXfc7moJj/t2o9yGZM6z6e9bP+BAoGBANFKSc08drgNMbmSQ2Ff
WTGp34vBpfauPJcDMVovzuQWWoZ6aQ5gu2U/U8ALrKXd3+9uDKyps5Xf5dILN+Qq
OaiNKk7Uw7RH6DeGEA5kiEtrx6ojs/AzSMBc2Z5HEynWDhS8k98cN3dSrY7q6/Vk
pNh8P2KqxyvFNrkmhfsmx0d5
-----END PRIVATE KEY-----
`;

// ── the fixture website ───────────────────────────────────────────────────────────────────────
const HOME = '<!doctype html><html><head><meta name="theme-color" content="#e30613"><link rel="stylesheet" href="/site.css"><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5/dist/css/bootstrap.min.css"></head><body style="color:#333">ok</body></html>';
const SITE_CSS = 'body{font-family:"Space Grotesk",sans-serif;color:#222;background:#fff} .btn{background:#e30613;color:#fff} a{color:#00857c}';
// big.example's homepage: a Google Fonts <link> names the family — proof enough, no Fonts request is made for it.
const LINKED = '<!doctype html><html><head><link href="https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;700&amp;display=swap" rel="stylesheet"><style>body{font-family:"Open Sans",sans-serif;background:#00695c;color:#fff}</style></head><body>ok</body></html>';
const BIG = '<!doctype html><html><head><meta name="theme-color" content="#0a66c2"></head><body>' + 'x'.repeat(3 * 1024 * 1024) + '</body></html>';
const BOMB = zlib.gzipSync(Buffer.alloc(24 * 1024 * 1024, 0x20)); // 24 MB of spaces, ~24 KB on the wire

const sockets = new Set();
const server = https.createServer({ key: FIXTURE_KEY, cert: FIXTURE_CERT }, (req, res) => {
  const host = String(req.headers.host || '').split(':')[0];
  const p = req.url.split('?')[0];
  const send = (status, type, body, extra = {}) => { res.writeHead(status, { 'content-type': type, ...extra }); res.end(body); };
  if (host === 'cssroot.example') return send(200, 'text/css', 'body{color:#e30613}');
  if (host === 'big.example' && p === '/') return send(200, 'text/html', LINKED);
  if (p === '/') return send(200, 'text/html; charset=utf-8', HOME);
  if (p === '/site.css') return send(200, 'text/css', SITE_CSS);
  if (p === '/big') return send(200, 'text/html', BIG);
  if (p === '/css') return send(200, 'text/css', 'body{color:#e30613}');
  if (p === '/bomb') return send(200, 'text/html', BOMB, { 'content-encoding': 'gzip' });
  if (/^\/r[1-4]$/.test(p)) { const n = Number(p[2]); return send(302, 'text/plain', '', { location: n === 4 ? '/' : `/r${n + 1}` }); } // r1→r2→r3→r4→/ : 4 redirects
  if (/^\/s[1-3]$/.test(p)) { const n = Number(p[2]); return send(302, 'text/plain', '', { location: n === 3 ? '/' : `/s${n + 1}` }); } // s1→s2→s3→/ : 3 redirects
  if (p === '/to-private') return send(302, 'text/plain', '', { location: 'https://private.example/' });
  if (p === '/to-http') return send(302, 'text/plain', '', { location: `http://site.example:${server.address().port}/` });
  if (p === '/to-meta') return send(302, 'text/plain', '', { location: 'https://169.254.169.254/latest/meta-data/' });
  if (p === '/slow') return; // never answers
  return send(404, 'text/plain', 'nope');
});
server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

// ⚠️ THE INJECTED RESOLVER: the fixture's hosts, a few hostile answers — and a REFUSAL for anything else, so a test
// that reached the real network (fonts.googleapis.com included) fails loudly instead of passing by luck.
const MAP = {
  'site.example': '127.0.0.1', 'big.example': '127.0.0.1', 'cssroot.example': '127.0.0.1',
  'private.example': '10.0.0.5', 'meta.example': '169.254.169.254', 'v6.example': 'fd00::1',
  'mapped.example': '::ffff:10.1.1.1', 'mixed.example': ['93.184.216.34', '10.0.0.9'], 'sixtofour.example': '2002:0a00:0001::1',
  'nat64.example': '64:ff9b::a00:1', 'cgnat.example': '100.64.3.4', 'testnet.example': '203.0.113.9',
};
const lookups = [];
const lookup = async (host) => {
  lookups.push(host);
  const v = MAP[host];
  if (!v) throw Object.assign(new Error(`test resolver refuses ${host}`), { code: 'ENOTFOUND' });
  return [].concat(v).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const ca = [FIXTURE_CERT];
  const strict = { lookup, ca };                        // the production rules (no loopback)
  const fixture = { lookup, ca, allowLoopback: true };  // 127/8 admitted so the fixture can be "a website"
  const dl = () => ({ deadline: Date.now() + 4000 });
  const html = (t) => t === 'text/html';
  const brief = (r) => ({ ok: r.ok, refused: r.refused, status: r.status, url: r.url, bytes: r.body ? r.body.length : null, truncated: r.truncated });

  console.log('── the address policy, range by range (pure) ──');
  const refused4 = ['0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.254', '127.0.0.1', '127.9.9.9', '169.254.169.254', '169.254.0.1',
    '172.16.0.1', '172.31.255.254', '192.168.1.1', '192.0.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '198.18.0.1', '198.19.255.255', '224.0.0.1', '239.1.1.1', '240.0.0.1', '255.255.255.255'];
  const allowed4 = ['8.8.8.8', '93.184.216.34', '1.1.1.1', '100.63.255.255', '100.128.0.1', '172.15.0.1', '172.32.0.1', '198.17.0.1', '198.20.0.1', '11.0.0.1', '223.255.255.254'];
  ok('⚠️ every private / loopback / link-local / CGNAT / TEST-NET / benchmark / multicast / reserved v4 range is refused', refused4.every((a) => isPublicAddress(a) === false), refused4.filter((a) => isPublicAddress(a) !== false));
  ok('…and the public v4 addresses either side of each range are allowed', allowed4.every((a) => isPublicAddress(a) === true), allowed4.filter((a) => isPublicAddress(a) !== true));
  const refused6 = ['::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'fec0::1', 'ff02::1', '2001:db8::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1', '::ffff:169.254.169.254', '::10.0.0.1', '64:ff9b::a00:1', '64:ff9b::7f00:1', '2002:0a00:0001::1', '2002:7f00:0001::1'];
  const allowed6 = ['2606:4700::1111', '2a00:1450:4001:82a::200e', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:0808:0808::1'];
  ok('⚠️ unspecified, loopback, ULA, link-local, site-local, multicast, documentation v6 — and a private v4 carried inside v6 (mapped, compatible, NAT64, 6to4) — are refused', refused6.every((a) => isPublicAddress(a) === false), refused6.filter((a) => isPublicAddress(a) !== false));
  ok('…while public v6 and a PUBLIC v4 carried inside v6 are allowed', allowed6.every((a) => isPublicAddress(a) === true), allowed6.filter((a) => isPublicAddress(a) !== true));
  ok('junk is not an address (never "public" by accident)', ['', 'localhost', '10.0.0', '1.2.3.4.5', 'not-an-ip', '::g', null, undefined, 12].every((a) => isPublicAddress(a) !== true));

  console.log('── A. refusals under the production rules (no loopback, the real policy, an injected resolver) ──');
  let r = await fetchCapped('http://127.0.0.1/', { ...strict, ...dl() });
  ok('http://127.0.0.1 → refused: scheme (https only, never upgraded)', r.refused === 'scheme', brief(r));
  ok('extractBrand({ website: "http://127.0.0.1" }) → null', (await BE.extractBrand({ website: 'http://127.0.0.1' }, { ...strict, timeoutMs: 2000 })) === null);
  ok('extractBrand({ website: "http://site.example" }) → null: an explicit http scheme is refused, not upgraded', (await BE.extractBrand({ website: `http://site.example:${port}/` }, { ...fixture, timeoutMs: 2000 })) === null);
  r = await fetchCapped('https://169.254.169.254/latest/meta-data/', { ...strict, ...dl() });
  ok('https://169.254.169.254 (the metadata literal) → refused: address', r.refused === 'address', brief(r));
  ok('extractBrand({ website: "https://169.254.169.254" }) → null', (await BE.extractBrand({ website: 'https://169.254.169.254' }, { ...strict, timeoutMs: 2000 })) === null);
  ok('extractBrand({ domain: "10.0.0.5" }) / ({ domain: "localhost" }) → null', (await BE.extractBrand({ domain: '10.0.0.5' }, { ...strict, timeoutMs: 2000 })) === null && (await BE.extractBrand({ domain: 'localhost' }, { ...strict, timeoutMs: 2000 })) === null);
  for (const [host, why] of [['private.example', '10.0.0.5'], ['meta.example', '169.254.169.254'], ['v6.example', 'fd00::1 (unique-local v6)'], ['mapped.example', '::ffff:10.1.1.1 (v4-mapped private)'],
    ['sixtofour.example', '2002:0a00:0001::1 (6to4 carrying 10.0.0.1)'], ['nat64.example', '64:ff9b::a00:1 (NAT64 carrying 10.0.0.1)'], ['cgnat.example', '100.64.3.4 (CGNAT)'], ['testnet.example', '203.0.113.9 (TEST-NET-3)']]) {
    r = await fetchCapped(`https://${host}/`, { ...strict, ...dl() });
    ok(`hostname → ${why} → refused: address (resolved FIRST, never connected)`, r.refused === 'address', brief(r));
  }
  r = await fetchCapped('https://mixed.example/', { ...strict, ...dl() });
  ok('⚠️ hostname → [93.184.216.34, 10.0.0.9] (ONE private answer among public ones) → refused: address', r.refused === 'address', brief(r));
  r = await fetchCapped(`https://site.example:${port}/`, { ...strict, ...dl() });
  ok('hostname → 127.0.0.1 WITHOUT allowLoopback → refused: address (loopback is not public)', r.refused === 'address', brief(r));
  r = await fetchCapped(`https://user:pw@site.example:${port}/`, { ...fixture, ...dl() });
  ok('credentials in the URL → refused: url', r.refused === 'url', brief(r));
  r = await fetchCapped('https://nowhere.example/', { ...strict, ...dl() });
  ok('a host the resolver has no answer for → refused, never a throw', !r.ok && !!r.refused, brief(r));

  console.log('── B. caps, types, redirects and the deadline against the fixture (allowLoopback — every other rule live) ──');
  r = await fetchCapped(`https://big.example:${port}/big`, { ...fixture, ...dl(), cap: HTML_CAP, accept: html });
  ok('a 3 MB text/html body → the read stops at the 1.5 MB cap (truncated, body.length === cap)', r.ok && r.truncated && r.body.length === HTML_CAP, brief(r));
  r = await fetchCapped(`https://big.example:${port}/bomb`, { ...fixture, ...dl(), cap: HTML_CAP, accept: html });
  ok('⚠️ a gzip bomb (24 MB inflated from ~24 KB) → the DECOMPRESSED bytes are capped at 1.5 MB', r.ok && r.truncated && r.body.length === HTML_CAP, brief(r));
  r = await fetchCapped(`https://big.example:${port}/css`, { ...fixture, ...dl(), cap: HTML_CAP, accept: html });
  ok('text/css where a page is expected → refused: content-type', r.refused === 'content-type', brief(r));
  ok('extractBrand on a host whose homepage is text/css → null', (await BE.extractBrand({ website: `https://cssroot.example:${port}/` }, { ...fixture, timeoutMs: 3000 })) === null);
  r = await fetchCapped(`https://site.example:${port}/r1`, { ...fixture, ...dl(), cap: HTML_CAP, accept: html });
  ok('a 4-redirect chain (/r1→/r2→/r3→/r4→/) → refused: redirects (the limit is 3)', r.refused === 'redirects', brief(r));
  r = await fetchCapped(`https://site.example:${port}/s1`, { ...fixture, ...dl(), cap: HTML_CAP, accept: html });
  ok('a 3-redirect chain (/s1→/s2→/s3→/) → followed, lands on /', r.ok && /\/$/.test(r.url), brief(r));
  lookups.length = 0;
  r = await fetchCapped(`https://site.example:${port}/to-private`, { ...fixture, ...dl(), cap: HTML_CAP, accept: html });
  ok('⚠️ a redirect to https://private.example (10.0.0.5) → refused: address — the hop was RE-RESOLVED and re-checked', r.refused === 'address' && lookups.includes('private.example'), { ...brief(r), lookups });
  r = await fetchCapped(`https://site.example:${port}/to-http`, { ...fixture, ...dl(), cap: HTML_CAP, accept: html });
  ok('a redirect to http:// → refused: scheme', r.refused === 'scheme', brief(r));
  r = await fetchCapped(`https://site.example:${port}/to-meta`, { ...fixture, ...dl(), cap: HTML_CAP, accept: html });
  ok('a redirect to https://169.254.169.254 → refused: address', r.refused === 'address', brief(r));
  let t0 = Date.now();
  r = await fetchCapped(`https://site.example:${port}/slow`, { ...fixture, deadline: Date.now() + 1200, cap: HTML_CAP, accept: html });
  ok('a server that never answers → refused: timeout at the deadline (~1.2 s), the socket not left open', r.refused === 'timeout' && Date.now() - t0 < 2500, { ...brief(r), ms: Date.now() - t0 });

  console.log('── C. the whole extraction against the fixture (the Fonts answer from the 24 h memory, never the wire) ──');
  _googleCache.clear();
  _googleCache.set('space grotesk', { ok: true, at: Date.now() });
  lookups.length = 0;
  t0 = Date.now();
  const brand = await BE.extractBrand({ website: `https://site.example:${port}/` }, { ...fixture, timeoutMs: 8000 });
  ok('theme-color #e30613 is the primary; the Bootstrap CDN sheet was skipped; the own sheet puts Space Grotesk on body',
    !!brand && brand.primary === '#e30613' && brand.from.primary === 'theme-color' && !!brand.font && brand.font.family === 'Space Grotesk' && brand.from.font === 'body', brand);
  ok('secondary = the next distinct hue (#00857c from a{color}); fetchedAt is an ISO stamp', !!brand && brand.secondary === '#00857c' && Number.isFinite(Date.parse(brand.fetchedAt)), brand);
  ok('font.google true from the memory, and NO lookup of fonts.googleapis.com or the CDN happened', !!brand && brand.font.google === true && !lookups.some((h) => /googleapis|jsdelivr/.test(h)), { google: brand && brand.font, lookups });
  ok(`the read took one bounded pass (${Date.now() - t0} ms)`, Date.now() - t0 < 4000);
  _googleCache.set('space grotesk', { ok: false, at: Date.now() });
  const notGoogle = await BE.extractBrand({ website: `https://site.example:${port}/` }, { ...fixture, timeoutMs: 8000 });
  ok('the same page with "not on Google Fonts" remembered → the family is kept, google:false', !!notGoogle && notGoogle.font.family === 'Space Grotesk' && notGoogle.font.google === false, notGoogle && notGoogle.font);
  _googleCache.clear();
  lookups.length = 0;
  const linked = await BE.extractBrand({ website: `https://big.example:${port}/` }, { ...fixture, timeoutMs: 8000 });
  ok('a page that LINKS Google Fonts: the family is google:true on the link\'s word, no Fonts request, the body colour from frequency',
    !!linked && linked.font && linked.font.family === 'Open Sans' && linked.font.google === true && linked.primary === '#00695c' && linked.from.primary === 'frequency' && !lookups.some((h) => /googleapis/.test(h)), { linked, lookups });
  t0 = Date.now();
  const late = await BE.extractBrand({ website: `https://site.example:${port}/slow` }, { ...fixture, timeoutMs: 8000 });
  ok('extractBrand fetches the ROOT, never the path it was given (…/slow answers as / did)', !!late && late.primary === '#e30613', { late, ms: Date.now() - t0 });
  ok('extractBrand never throws on junk input: {} / a non-URL / a number → null', (await BE.extractBrand({})) === null && (await BE.extractBrand({ website: 'not a url' }, { ...strict, timeoutMs: 1000 })) === null && (await BE.extractBrand({ website: 42, domain: 42 }, { ...strict, timeoutMs: 1000 })) === null);
  // ⚠️ FLIPPED (2026-09-15): extractBrand(null) used to throw on the parameter default `{ website, domain } = {}` (null is
  // not undefined) BEFORE its try. Both arguments are destructured INSIDE the try now, so no input shape can throw.
  ok('extractBrand(null) → null (guarded — never throws)', (await BE.extractBrand(null)) === null);
  ok('…and every other non-object, in either position: undefined / 42 / "str" / ({}, null) / ({}, 7) → null, no throw',
    (await BE.extractBrand(undefined)) === null && (await BE.extractBrand(42)) === null && (await BE.extractBrand('str')) === null
    && (await BE.extractBrand({}, null)) === null && (await BE.extractBrand({}, 7)) === null);
  ok('a stale memory (older than 24 h) is no memory', (() => { _googleCache.set('inter', { ok: true, at: Date.now() - 25 * 3600 * 1000 }); return BE.googleFontKnown('Inter') === null; })());
  _googleCache.clear();
  lookups.length = 0;
  ok('checkGoogleFont: an excluded/system family answers false with no request at all', (await BE.checkGoogleFont('Arial', { lookup })) === false && (await BE.checkGoogleFont('sans-serif', { lookup })) === false && lookups.length === 0);
  ok('checkGoogleFont: a network failure answers false and is NOT remembered (asked again tomorrow, not "not a Google font")',
    (await BE.checkGoogleFont('Definitely Not A Font 123', { lookup, timeoutMs: 800 })) === false && BE.googleFontKnown('Definitely Not A Font 123') === null && lookups.includes('fonts.googleapis.com'), lookups);
  _googleCache.set('inter', { ok: true, at: Date.now() });
  ok('checkGoogleFont: a remembered yes is a yes without a request', (lookups.length = 0, (await BE.checkGoogleFont('Inter', { lookup })) === true && lookups.length === 0));
  _googleCache.clear();

  console.log('── D. the colour / font heuristics on saved pages (pure: parse + choose, no network) ──');
  const SAMPLES = {
    '1. theme-color page (greys around it)': {
      html: '<!doctype html><html><head><meta charset="utf-8"><meta name="theme-color" content="#0a66c2"><style>body{margin:0;color:#333;background:#fff;font-family:Arial,sans-serif} .nav{background:#f3f2ef;border-color:#ddd} .btn{background:#0a66c2;color:#fff}</style></head><body></body></html>',
      expect: { primary: '#0a66c2', from: 'theme-color', font: null },
    },
    '2. CSS-var page (a WHITE theme-color is ignored, --color-primary wins, --brand-accent is the secondary)': {
      html: '<!doctype html><html><head><meta name="theme-color" content="#ffffff"><style>:root{--color-primary:#e30613;--color-primary-hover:#c10511;--brand-accent:#00857c;--text:#222;--bg:#f7f7f7;--bs-primary-rgb:13,110,253} body{color:var(--text);background:var(--bg);font-family:"Source Sans Pro",Helvetica,Arial,sans-serif} .cta{background:var(--color-primary)}</style></head><body></body></html>',
      expect: { primary: '#e30613', from: 'css-var', secondary: '#00857c', font: 'Source Sans Pro', fontFrom: 'body' },
    },
    '3. frequency page (whites, blacks and greys everywhere; orange paints the surfaces ×2; green is the next hue)': {
      html: '<!doctype html><html><head><style>*{color:#333} body{background:#ffffff;color:#000} .card{background:#fff;border-color:#e5e5e5} .muted{color:#777} .footer{background:#f5f5f5;color:#999} .hero{background:#ff6600} .btn{background:#ff6600;color:#fff} .btn:hover{background:#e65c00} .ribbon{background:linear-gradient(90deg,#ff6600,#ffffff)} a{color:#2e7d32} .tag{border-color:#2e7d32} .alert{color:#c62828} h1{font-family:"Playfair Display",Georgia,serif} p{font-family:Inter,sans-serif} li{font-family:Inter,sans-serif}</style></head><body><header style="background:#ff6600">x</header></body></html>',
      expect: { primary: '#ff6600', from: 'frequency', secondary: '#2e7d32', font: 'Inter', fontFrom: 'frequency' },
    },
    '4. Google-Fonts link page (near-black theme-color ignored; body names the linked family)': {
      html: '<!doctype html><html><head><link rel="preconnect" href="https://fonts.gstatic.com"><link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;700&amp;display=swap" rel="stylesheet"><link rel="stylesheet" href="/site.css"><meta name="theme-color" content="#111111"></head><body></body></html>',
      sheets: ['body{font-family:"Space Grotesk",sans-serif;color:#1c1c1c} .btn{background:#6c3fd1;color:#fff} .btn-alt{background:#f2b705}'],
      expect: { primary: '#6c3fd1', from: 'frequency', secondary: '#f2b705', font: 'Space Grotesk', fontFrom: 'body', googleLinked: true },
    },
    '5. Google-Fonts link (css v1, no body declaration anywhere)': {
      html: '<!doctype html><html><head><link href="https://fonts.googleapis.com/css?family=Open+Sans:400,700|Roboto" rel="stylesheet"></head><body style="background:#00695c"></body></html>',
      expect: { primary: '#00695c', from: 'frequency', font: 'Open Sans', fontFrom: 'google-link', googleLinked: true },
    },
    '6. system stack only (Roboto is the last resort)': {
      html: '<!doctype html><html><head><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:#222} .a{color:#005fcc}</style></head><body></body></html>',
      expect: { primary: '#005fcc', from: 'frequency', font: 'Roboto', fontFrom: 'body' },
    },
    '7. Bootstrap variables (--bs-primary, the rgb triple, a generic body font)': {
      html: '<!doctype html><html><head><style>:root{--bs-blue:#0d6efd;--bs-primary:#0d6efd;--bs-primary-rgb:13,110,253;--bs-gray:#6c757d;--bs-danger:#dc3545} .btn-primary{background-color:var(--bs-primary)} body{font-family:var(--bs-body-font-family, system-ui)}</style></head><body></body></html>',
      expect: { primary: '#0d6efd', from: 'css-var', font: null },
    },
    '8. shadcn-style hsl triples (--primary too dark, --accent too light, --brand usable)': {
      html: '<!doctype html><html><head><style>:root{--primary:222.2 47.4% 11.2%;--accent:210 40% 96.1%;--brand:24 95% 53%} .x{background:hsl(var(--brand))}</style></head><body></body></html>',
      expect: { from: 'css-var' },
    },
    '9. nothing usable (a grey page with a system font)': {
      html: '<!doctype html><html><head><style>body{background:#fafafa;color:#444;font-family:Helvetica,Arial,sans-serif}</style></head><body></body></html>',
      expect: { primary: null, font: null },
    },
    '10. a saturated but too-dark theme-color (#050520, l ≈ 0.07) falls through to the CSS; a near-white one (#fff5f5) is never a colour': {
      html: '<!doctype html><html><head><meta name="theme-color" content="#050520"><style>.btn{background:#1e88e5;color:#fff} .pale{background:#fff5f5}</style></head><body></body></html>',
      expect: { primary: '#1e88e5', from: 'frequency', secondary: null },
    },
    '11. a theme-color at the edge of the band (#0a0a40, l ≈ 0.145, s ≈ 0.73) is accepted': {
      html: '<!doctype html><html><head><meta name="theme-color" content="#0a0a40"><style>.btn{background:#1e88e5;color:#fff}</style></head><body></body></html>',
      expect: { primary: '#0a0a40', from: 'theme-color', secondary: '#1e88e5' },
    },
  };
  for (const [name, s] of Object.entries(SAMPLES)) {
    const parsed = parseHtml(s.html, 'https://example.test/');
    const found = brandFromSources(parsed, s.sheets || []);
    const e = s.expect;
    const bad = [];
    if ('primary' in e && found.primary !== e.primary) bad.push(`primary ${found.primary} ≠ ${e.primary}`);
    if ('from' in e && found.from !== e.from) bad.push(`from ${found.from} ≠ ${e.from}`);
    if ('secondary' in e && found.secondary !== e.secondary) bad.push(`secondary ${found.secondary} ≠ ${e.secondary}`);
    if ('font' in e && (found.font ? found.font.family : null) !== e.font) bad.push(`font ${found.font && found.font.family} ≠ ${e.font}`);
    if ('fontFrom' in e && !(found.font && found.font.from === e.fontFrom)) bad.push(`font from ${found.font && found.font.from} ≠ ${e.fontFrom}`);
    if ('googleLinked' in e && !(found.font && found.font.googleLinked === e.googleLinked)) bad.push('google-linked');
    ok(name, bad.length === 0, { bad, found });
  }
  // s and l computed here, independently of the module's own converter.
  const hsl = (hx) => { const n = parseInt(hx.slice(1), 16); const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); const l = (mx + mn) / 2; const s = mx === mn ? 0 : (mx - mn) / (1 - Math.abs(2 * l - 1)); return { s, l }; };
  const chosen = [];
  for (const s of Object.values(SAMPLES)) { const f = brandFromSources(parseHtml(s.html, 'https://example.test/'), s.sheets || []); for (const hx of [f.primary, f.secondary]) if (hx) chosen.push(hx); }
  ok(`every chosen colour (${chosen.length}) is saturated (s ≥ 0.25) and mid-lightness (0.12 ≤ l ≤ 0.85)`, chosen.length >= 12 && chosen.every((hx) => { const h = hsl(hx); return h.s >= 0.25 && h.l >= 0.12 && h.l <= 0.85; }), chosen.map((hx) => [hx, hsl(hx)]).filter(([, h]) => !(h.s >= 0.25 && h.l >= 0.12 && h.l <= 0.85)));

  console.log('── E. ⚠️ the read is LINEAR and BUDGETED (2026-09-15): a page at the caps costs milliseconds, never minutes ──');
  {
    // WHY: brandFromSources runs synchronously on the API's thread for every build. Before this round cssRules paid a
    // css.lastIndexOf back to offset 0 per rule, importsOf's `[^;]*;` tail re-read the sheet per '@import', seven
    // /<x[\s\S]*?y/ regexes re-scanned to the END per unclosed opener, and a self-feeding var() chain expanded
    // 120⁴-fold before throwing "Invalid string length" — each O(n²) or worse: MINUTES at the 1.5 MB page / 400 KB
    // sheet caps the fetch admits, from one employer's website. Every clause below is a shape that used to hang,
    // timed under a budget the fixed code meets by 100× (1-15 ms measured), so a regression is a wall, not a jitter.
    const { cssRules, importsOf, cutSpans, tagsOf, styleBlocksOf, stripCssComments, substituteVars, CSS_TEXT_BUDGET, CSS_RULE_BUDGET, IMPORT_SCAN_CHARS, VALUE_MAX } = BE._internals;
    const timed = (fn) => { const t = process.hrtime.bigint(); const v = fn(); return { v, ms: Number(process.hrtime.bigint() - t) / 1e6 }; };
    const MS = 1000;
    let r = timed(() => cssRules('a{}'.repeat(200000)));
    ok(`cssRules on 'a{}' × 200k: linear (${r.ms.toFixed(1)} ms < ${MS}), and keeps exactly CSS_RULE_BUDGET (${CSS_RULE_BUDGET}) rules`, r.ms < MS && r.v.length === CSS_RULE_BUDGET, { ms: r.ms, n: r.v.length });
    r = timed(() => cssRules('.x{color:#e30613;background:var(--b)} '.repeat(25000)));
    ok('…on 25k real rules: the first CSS_RULE_BUDGET in page order, selector and body intact', r.ms < MS && r.v.length === CSS_RULE_BUDGET && r.v[0].selector === '.x' && r.v[0].decls === 'color:#e30613;background:var(--b)', { ms: r.ms, n: r.v.length, first: r.v[0] });
    ok('nested at-rules still open (@media → its rules) and a ";" / "}" inside a QUOTED prelude no longer cuts it (the forward scan is quote-aware)',
      (() => { const v = cssRules('@media (min-width:1px){ .m{color:#111} } a[title="x;y}"]{color:#e30613} b{color:#00857c}'); return v.length === 3 && v[0].selector === '.m' && v[1].selector === 'a[title="x;y}"]' && v[2].selector === 'b'; })(), cssRules('@media (min-width:1px){ .m{color:#111} } a[title="x;y}"]{color:#e30613} b{color:#00857c}'));
    const IMPORT = '@import "x.css";';
    r = timed(() => importsOf(IMPORT.repeat(140000)));
    ok(`importsOf on 140k imports: ${r.ms.toFixed(1)} ms < ${MS}; only the sheet's first IMPORT_SCAN_CHARS (${IMPORT_SCAN_CHARS}) are read`,
      r.ms < MS && r.v.length > 0 && r.v.length <= Math.ceil(IMPORT_SCAN_CHARS / IMPORT.length) && r.v.every((u) => u === 'x.css'), { ms: r.ms, n: r.v.length });
    r = timed(() => importsOf('@import "x.css" '.repeat(20000)));
    ok(`importsOf on 20k '@import' with no ";" anywhere: ${r.ms.toFixed(1)} ms < ${MS}, nothing matched`, r.ms < MS && r.v.length === 0, { ms: r.ms, n: r.v.length });
    ok('importsOf still reads every legal form at the head of a sheet', JSON.stringify(importsOf('@charset "utf-8"; @import url("a.css"); @import \'b.css\' screen; @import url(c.css);\n.x{}')) === JSON.stringify(['a.css', 'b.css', 'c.css']), importsOf('@charset "utf-8"; @import url("a.css"); @import \'b.css\' screen; @import url(c.css);\n.x{}'));
    // The regex shapes that re-scanned to the end per unclosed opener, at the real page cap.
    r = timed(() => parseHtml('<!doctype html><html><head>' + '<!--'.repeat(375000) + '</head><body></body></html>', 'https://example.test/'));
    ok(`375k unclosed "<!--" (1.5 MB, the page cap): parseHtml in ${r.ms.toFixed(1)} ms < ${MS}`, r.ms < MS, r.ms);
    r = timed(() => parseHtml('<html><head>' + '<meta '.repeat(150000) + '<link '.repeat(80000) + '<base '.repeat(20000) + '<script>'.repeat(30000) + '<style>'.repeat(30000) + '</head></html>', 'https://example.test/'));
    ok(`unclosed <meta / <link / <base / <script / <style openers by the hundred thousand: parseHtml in ${r.ms.toFixed(1)} ms < ${MS}`, r.ms < MS, r.ms);
    r = timed(() => stripCssComments('/* '.repeat(136000)));
    ok(`136k unclosed "/*" in a 400 KB sheet: stripCssComments in ${r.ms.toFixed(1)} ms < ${MS}, the text kept as written`, r.ms < MS && r.v === '/* '.repeat(136000), r.ms);
    const big = '<!doctype html><html><head><style>' + 'a{}'.repeat(480000) + '</style></head><body></body></html>';   // 1.44 MB of a{}, under HTML_CAP
    r = timed(() => brandFromSources(parseHtml(big, 'https://example.test/'), []));
    ok(`the reviewer's 1.4 MB <style> of a{}: parseHtml + brandFromSources end to end in ${r.ms.toFixed(1)} ms < ${MS}, a null brand, no throw`,
      big.length < HTML_CAP && r.ms < MS && r.v.primary === null && r.v.font === null, { ms: r.ms, v: r.v });
    // The one-pass scans give the old regexes' EXACT answer (an opener with no closer after it ends the pass, exactly
    // as the regex failed on it and on every later opener): fuzzed here against those regexes.
    const ALPHA = ['<!--', '-->', '<script>', '</script>', '<script', '<style>', '</style>', '<style type="text/css">', '<meta ', '<meta', '<link ', '<base ', '>', '<', 'a', ' ', '/*', '*/', '"', 'x{}', '\n', '<metal'];
    const rnd = (n) => { let s = ''; for (let i = 0; i < n; i++) s += ALPHA[Math.floor(Math.random() * ALPHA.length)]; return s; };
    const mismatches = [];
    for (let i = 0; i < 4000 && mismatches.length < 5; i++) {
      const s = rnd(1 + Math.floor(Math.random() * 40));
      if (cutSpans(s, /<!--/g, /-->/g) !== s.replace(/<!--[\s\S]*?-->/g, ' ')) mismatches.push(['comment', s]);
      if (cutSpans(s, /<script\b/gi, /<\/script>/gi) !== s.replace(/<script\b[\s\S]*?<\/script>/gi, ' ')) mismatches.push(['script', s]);
      if (stripCssComments(s) !== s.replace(/\/\*[\s\S]*?\*\//g, ' ')) mismatches.push(['css-comment', s]);
      for (const tag of ['meta', 'link', 'base']) if (JSON.stringify(tagsOf(s, tag)) !== JSON.stringify(s.match(new RegExp('<' + tag + '\\b[^>]*>', 'gi')) || [])) mismatches.push([tag, s]);
      if (JSON.stringify(styleBlocksOf(s)) !== JSON.stringify([...s.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]))) mismatches.push(['style', s]);
    }
    ok('cutSpans / tagsOf / styleBlocksOf / stripCssComments: exact parity with the regexes they replaced (4000 random pages)', mismatches.length === 0, mismatches);
    ok('tagsOf honours its cap (max) and stops at the first ">" like /<meta\\b[^>]*>/', JSON.stringify(tagsOf('<meta a><meta b><meta c', 'meta', 2)) === JSON.stringify(['<meta a>', '<meta b>']) && tagsOf('<metal x>', 'meta').length === 0);
    // The var() chain that expanded 120⁴-fold and threw inside brandFromSources.
    const chain = new Map([['--a', 'var(--b)'.repeat(120)], ['--b', 'var(--c)'.repeat(120)], ['--c', 'var(--d)'.repeat(120)], ['--d', 'x'.repeat(120)]]);
    r = timed(() => substituteVars('var(--a)', chain));
    ok(`a self-feeding var() chain (120⁴ hops): ${r.ms.toFixed(1)} ms < ${MS}, no throw, the value held near VALUE_MAX`, r.ms < MS && typeof r.v === 'string' && r.v.length <= VALUE_MAX + 200, { ms: r.ms, len: r.v && r.v.length });
    ok('a legitimate two-hop chain resolves unchanged; a missing var takes its fallback', substituteVars('rgb(var(--x) / .5)', new Map([['--x', 'var(--y)'], ['--y', '227 6 19']])) === 'rgb(227 6 19 / .5)' && substituteVars('var(--nope, #e30613)', new Map()) === '#e30613');
    r = timed(() => brandFromSources(parseHtml('<html><head><style>:root{' + '--a:var(--b);'.repeat(1) + '--b:' + 'var(--c)'.repeat(120) + ';--c:' + 'var(--d)'.repeat(120) + ';--d:' + 'var(--e)'.repeat(120) + ';--e:#e30613} .x{background:var(--b)}</style></head></html>', 'https://example.test/'), []));
    ok(`…and through brandFromSources the same chain answers in ${r.ms.toFixed(1)} ms < ${MS} without throwing`, r.ms < MS && r.v && typeof r.v === 'object', r.ms);
    // The text budget: a sheet past CSS_TEXT_BUDGET still yields the brand from its TOP; a rule past the line is not read.
    const filler = '.f{margin:0}'.repeat(Math.ceil((CSS_TEXT_BUDGET + 20 * 1024) / 12));
    const sheet = ':root{--brand:#e30613} .cta{background:var(--brand)} ' + filler + ' body{font-family:"Zilla Slab",serif}';
    const empty = parseHtml('<!doctype html><html><head></head><body></body></html>', 'https://example.test/');
    r = timed(() => brandFromSources(empty, [sheet]));
    ok(`a ${(sheet.length / 1024).toFixed(0)} KB sheet: --brand from its top is the primary (css-var); the body rule past the 300 KB line is NOT read (font null); ${r.ms.toFixed(1)} ms < ${MS}`,
      sheet.length > CSS_TEXT_BUDGET && r.v.primary === '#e30613' && r.v.from === 'css-var' && r.v.font === null && r.ms < MS, { ms: r.ms, v: r.v });
    const under = brandFromSources(empty, [':root{--brand:#e30613} .cta{background:var(--brand)} body{font-family:"Zilla Slab",serif}']);
    ok('…the same sheet under the line reads the font too (so the null above IS the budget, not the heuristics)', under.primary === '#e30613' && !!under.font && under.font.family === 'Zilla Slab', under);
    ok('a spent clock (timeBudgetMs: -1) answers nulls without throwing', (() => { const v = brandFromSources(parseHtml('<html><head><style>.x{background:#e30613}</style></head></html>', 'https://example.test/'), [], { timeBudgetMs: -1 }); return v && v.primary === null && v.font === null; })());
  }

  for (const s of sockets) s.destroy();
  server.close();
  console.log(`\nbrand extract: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR:', e); for (const s of sockets) s.destroy(); server.close(); process.exit(2); });
