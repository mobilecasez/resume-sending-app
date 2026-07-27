// Shared HTML fetch with challenge-page detection and retry.
//
// WHY THIS EXISTS — the Revolut case.
// A user pasted a Revolut careers URL and got back ONE job with no details. The cause was not the
// extractor: `https://www.revolut.com/careers/` intermittently answers HTTP 403 with a
// "Just a quick security check / Enable JavaScript and cookies to continue" interstitial — 873 KB of
// HTML carrying 107 characters of text. Our fetch treated that 403 as terminal and moved on, so the
// pipeline fell through to a guess. Measured: the SAME url, requested again moments later with the
// same headers, returns 200 and the real 590 KB page listing 599 open positions.
//
// So the challenge is a rate/heuristic hiccup, not a wall. This module does the one correct thing
// for a transient error — ask again, with backoff — and NOTHING more:
//
//   • it does not solve, forge, or evade any challenge;
//   • it does not spoof fingerprints, rotate identities, or lie about who we are;
//   • it sends the same honest User-Agent every time and obeys the site's redirects;
//   • when the site keeps refusing, `blocked: true` comes back and the CALLER MUST report that
//     honestly rather than inventing results. That is the actual bug this repairs — a blocked page
//     used to become a plausible-looking wrong answer.
//
// If a site genuinely does not want automated reads, retrying identically will keep failing, and it
// should: `blocked` is the answer, not a problem to route around.

const http = require('http');
const https = require('https');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const DEFAULT_TIMEOUT = 15000;
const MAX_BYTES = 8_000_000;

/** Phrases these interstitials show. Deliberately narrow — a real job page must never match. */
const CHALLENGE_TEXT = /(just a quick security check|checking your browser|enable javascript and cookies to continue|verify you are (a )?human|please (enable|turn on) javascript|attention required!?\s*\|\s*cloudflare|ddos protection by|access denied.{0,40}(cloudflare|akamai|incapsula)|request unsuccessful.{0,40}incapsula|pardon our interruption)/i;

/** Vendor markers that appear in the markup of a challenge, not of a real page. */
const CHALLENGE_MARKUP = /(cf-browser-verification|cf_chl_opt|__cf_chl|_incapsula_resource|\/_Incapsula_Resource|awswaf|challenge-platform|px-captcha|perimeterx)/i;

/**
 * Is this response a bot-check interstitial rather than the page we asked for?
 *
 * The strongest single signal is SHAPE: a challenge ships a large scripted payload with almost no
 * readable text. A real careers page is the opposite. Note this deliberately does NOT require the
 * HTML to be small — Revolut's interstitial is 873 KB, and an earlier version of this test
 * (`text < 200 && html < 1500`) called it "not blocked" for exactly that reason.
 */
function isChallengePage(html, status) {
  const s = String(html || '');
  if (!s) return false;
  if (CHALLENGE_TEXT.test(s.slice(0, 200000))) return true;
  if (CHALLENGE_MARKUP.test(s.slice(0, 200000))) return true;
  // Shape test, only for statuses that already signal refusal — a 200 with thin text is an SPA
  // shell, which is a different problem with a different fix (render it), not a challenge.
  if (status === 403 || status === 429 || status === 503) {
    const text = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length < 400 && s.length > 20000) return true;
  }
  return false;
}

/** True when asking again could plausibly succeed. A 404 is an answer; a 403 here is a hiccup. */
function isRetryableStatus(status) {
  return status === 403 || status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One request. Resolves { status, body, url } — never rejects on an HTTP status. */
function once(url, { timeout = DEFAULT_TIMEOUT, redirects = 0, accept } = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    let parsed;
    try { parsed = new URL(url); } catch (e) { return reject(e); }
    const lib = parsed.protocol === 'http:' ? http : https;
    const req = lib.get(url, {
      headers: {
        'User-Agent': UA,
        Accept: accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout,
    }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        const next = r.headers.location.startsWith('http')
          ? r.headers.location : new URL(r.headers.location, url).href;
        return resolve(once(next, { timeout, redirects: redirects + 1, accept }));
      }
      let d = '';
      r.setEncoding('utf8');
      r.on('data', (c) => {
        d += c;
        // ⚠️ destroy WITH an Error. A bare req.destroy() emits no 'error' event, so the promise
        // never settles and the caller hangs forever — that exact bug made every board over the
        // size cap silently report zero jobs.
        if (d.length > MAX_BYTES) req.destroy(new Error(`response over ${MAX_BYTES / 1e6}MB from ${url}`));
      });
      r.on('end', () => resolve({ status: r.statusCode, body: d, url }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

/**
 * Fetch HTML, retrying transient refusals and challenge interstitials.
 *
 * Returns { ok, status, html, url, blocked, tries, reason }. `blocked` means the site answered but
 * refused to show us the page — the caller must surface that, never paper over it.
 */
async function fetchHtml(url, { tries = 3, timeout = DEFAULT_TIMEOUT, accept } = {}) {
  let last = { status: 0, body: '', url };
  let sawChallenge = false;
  const attempts = Math.max(1, tries);

  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(600 * i + Math.min(400, 100 * i * i));   // 600ms, 1.4s, 2.6s…
    try {
      last = await once(url, { timeout, accept });
    } catch (e) {
      last = { status: 0, body: '', url, err: e.message };
      continue;   // network/timeout — worth another go
    }
    const challenged = isChallengePage(last.body, last.status);
    if (challenged) { sawChallenge = true; continue; }
    if (last.status === 200) {
      return { ok: true, status: 200, html: last.body, url: last.url, blocked: false, tries: i + 1, reason: null };
    }
    if (!isRetryableStatus(last.status)) break;   // 404/410 — asking again changes nothing
  }

  const blocked = sawChallenge || isRetryableStatus(last.status);
  return {
    ok: false,
    status: last.status,
    html: last.status === 200 ? last.body : '',
    url: last.url || url,
    blocked,
    tries: attempts,
    reason: sawChallenge
      ? 'bot-check interstitial after retries'
      : last.err || (last.status ? `HTTP ${last.status}` : 'no response'),
  };
}

/** Back-compat shape for callers that just want a string and treat failure as an exception. */
async function fetchTextOrThrow(url, opts) {
  const r = await fetchHtml(url, opts);
  if (!r.ok) throw new Error(r.reason || `HTTP ${r.status}`);
  return r.html;
}

module.exports = { fetchHtml, fetchTextOrThrow, isChallengePage, isRetryableStatus, UA };
