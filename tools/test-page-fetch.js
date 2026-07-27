#!/usr/bin/env node
// Tests for the challenge-page detector.
//
// The reason this needs tests: the OLD blocked-test was
//     (pageData.text || '').trim().length < 200 && (pageData.rawHtml || '').length < 1500
// which is wrong twice over — `pageData.text` never existed (the field is `pageText`, so the first
// clause was always vacuously true), and requiring the HTML to be under 1500 bytes means the one
// shape that matters, a huge scripted interstitial carrying no text, can never be detected. Revolut's
// is 873 KB of HTML with 107 characters of text. Both mistakes are asserted against below.
//
//   node tools/test-page-fetch.js            # offline assertions
//   node tools/test-page-fetch.js --live     # also hits the real Revolut URLs

const { isChallengePage, isRetryableStatus, fetchHtml } = require('../server/utils/pageFetch');

let pass = 0;
const fails = [];
const ok = (name, cond, extra) => { if (cond) pass++; else fails.push(`${name}${extra ? ` — ${extra}` : ''}`); };
const eq = (n, a, b) => ok(n, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

// A faithful miniature of the Revolut interstitial: enormous scripted payload, ~no text.
const REVOLUT_CHALLENGE = `<!DOCTYPE html><html><head><title>Just a quick security check | Revolut</title></head>`
  + `<body><h1>Just a quick security check</h1><p>Enable JavaScript and cookies to continue</p>`
  + `<script>${'x'.repeat(60000)}</script></body></html>`;

// A real careers page: lots of text, no challenge phrases.
const REAL_PAGE = `<!DOCTYPE html><html><head><title>Careers | Revolut</title></head><body>`
  + `<h1>We have 599 open positions</h1>`
  + Array.from({ length: 60 }, (_, i) => `<a href="/careers/position/role-${i}/">Senior Engineer ${i}</a><p>Build the future of money, work with a great team, ship fast.</p>`).join('')
  + `</body></html>`;

// ── the interstitial is detected ─────────────────────────────────────────────
ok('revolut challenge @403 detected', isChallengePage(REVOLUT_CHALLENGE, 403));
ok('revolut challenge detected on text alone (any status)', isChallengePage(REVOLUT_CHALLENGE, 200));
ok('cloudflare "checking your browser"', isChallengePage('<html><body>Checking your browser before accessing</body></html>', 503));
ok('cloudflare markup marker', isChallengePage(`<html><div id="cf-browser-verification"></div></html>`, 403));
ok('incapsula marker', isChallengePage('<html><script src="/_Incapsula_Resource?SWJIYLWA"></script></html>', 403));
ok('"verify you are human"', isChallengePage('<html>Please verify you are human</html>', 403));
ok('"Pardon Our Interruption"', isChallengePage('<html><h1>Pardon Our Interruption</h1></html>', 403));

// THE regression: huge HTML must not exempt a page from detection.
ok('huge-HTML interstitial is still detected (old test required <1500 bytes)',
  isChallengePage(`<html><body>Just a quick security check<script>${'y'.repeat(900000)}</script></body></html>`, 403));

// Shape test: refusal status + big scripted payload + no text, with no known phrase at all.
ok('shape test catches an unbranded 403 interstitial',
  isChallengePage(`<html><body><script>${'z'.repeat(50000)}</script></body></html>`, 403));

// ── real pages are NOT flagged ───────────────────────────────────────────────
ok('real careers page not flagged @200', !isChallengePage(REAL_PAGE, 200));
ok('real careers page not flagged @403 (text is rich)', !isChallengePage(REAL_PAGE, 403));
ok('empty body not flagged', !isChallengePage('', 403));
ok('null not flagged', !isChallengePage(null, 403));
// A thin SPA shell at 200 is a RENDER problem, not a challenge — misfiling it would send the
// pipeline down the wrong repair path.
ok('thin SPA shell @200 is not a challenge', !isChallengePage('<html><body><div id="root"></div></body></html>', 200));
ok('small 403 body with no markers is not a challenge (needs >20k)',
  !isChallengePage('<html><body>Forbidden</body></html>', 403));
// A job posting that happens to discuss security must not trip the detector.
ok('a security-engineer posting is not a challenge',
  !isChallengePage(`<html><body><h1>Security Engineer</h1><p>${'You will run security checks and reviews. '.repeat(200)}</p></body></html>`, 200));

// ── retryable statuses ───────────────────────────────────────────────────────
for (const s of [403, 408, 425, 429, 500, 502, 503, 504]) ok(`${s} is retryable`, isRetryableStatus(s));
for (const s of [200, 301, 400, 401, 404, 410, 451]) ok(`${s} is NOT retryable`, !isRetryableStatus(s));

// ── live check (opt-in) ──────────────────────────────────────────────────────
(async () => {
  if (process.argv.includes('--live')) {
    // ⚠️ These assert OUR classification, never the site's mood. "Revolut serves us the listing"
    // is not a property of this codebase — during development the same URL returned 200 on the
    // second try, and later 403 on every try once the host had seen enough traffic from one IP.
    // A test that demands a 200 would just encode which of those two afternoons it was written on.
    //
    // The invariant that IS ours, and that the Revolut bug violated: whatever comes back is
    // labelled truthfully. ok ⇒ we hold real HTML. Not ok ⇒ `blocked` says so and `html` is empty,
    // so no caller can mistake a refusal for a thin page and start guessing.
    const listing = await fetchHtml('https://www.revolut.com/careers/', { tries: 3 });
    console.log(`   live listing: status=${listing.status} ok=${listing.ok} blocked=${listing.blocked} tries=${listing.tries} reason=${listing.reason || '—'}`);
    if (listing.ok) {
      ok('LIVE ok ⇒ real HTML, not an interstitial', listing.html.length > 1000 && !/just a quick security check/i.test(listing.html));
      const hrefs = new Set([...listing.html.matchAll(/href="(\/careers\/position\/[^"]+)"/g)].map((m) => m[1]));
      console.log(`   live listing exposed ${hrefs.size} job links, ${listing.html.length} bytes`);
    } else {
      ok('LIVE refusal ⇒ blocked is set', listing.blocked === true, `blocked=${listing.blocked}`);
      ok('LIVE refusal ⇒ html is empty (nothing to misread)', listing.html === '', `len=${listing.html.length}`);
      ok('LIVE refusal ⇒ a reason is given', !!listing.reason);
    }

    // A 404 is an ANSWER. It must not be retried into a "blocked" verdict — that distinction is
    // what lets the caller say "no such page" instead of "this site blocks us".
    const gone = await fetchHtml('https://example.com/definitely-not-a-real-path-xyz-9f2', { tries: 2 });
    console.log(`   live 404 probe: status=${gone.status} blocked=${gone.blocked}`);
    ok('LIVE 404 is not reported as blocked', gone.status !== 404 || gone.blocked === false,
      `status=${gone.status} blocked=${gone.blocked}`);
  }

  console.log(`\npageFetch: ${pass} assertions passed, ${fails.length} failed`);
  if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
  console.log('✅ all green');
})();
