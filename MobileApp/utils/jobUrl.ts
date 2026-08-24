// AI Hub — new feature. Safe to delete without affecting existing app.
//
// Canonicalise a job URL before we store or open it.
//
// WHY: search engines index the *login / popup* variants of ATS pages, so a live-search result can
// be something like
//   career-schwab.icims.com/jobs/123720/<slug>/login?mobile=true&width=402&height=684&needsRedirect=false
// which is iCIMS's small popup sign-in window — and THAT page is the one behind hCaptcha/reCAPTCHA.
// The plain job page (…/<slug>/job) has no captcha at all and offers a normal Apply link. Saving the
// login variant meant every open landed the user on a security wall instead of the job.

// Popup/window-sizing + auth-routing params. Harmless to drop everywhere; they only exist because
// the link was generated for a child window.
const POPUP_PARAMS = /^(mobile|width|height|bga|needsredirect|jan1offset|jun1offset|loginonly|inframe|iframe|popup|embed|ispopup)$/i;

// A path segment that means "sign in / create an account", not "the job".
const AUTH_SEG = /^(login|signin|sign-in|register|registration|createaccount|create-account|auth)$/i;
// Older portals put sign-in in a FILE, not a folder — Glassdoor's is `/profile/login_input.htm`.
// ⚠️ Deliberately requires a file EXTENSION. The obvious widening (`^login[._-]`) would also match
// a job slug like `sign-in-systems-engineer`, and a false positive here is worse than a miss: it
// makes the portal-capture skip a real job URL and makes the apply flow treat a job page as a
// sign-in page.
const AUTH_FILE = /^(login|signin|sign-in|register|registration|createaccount|create-account|auth)([_-][a-z]+)?\.(htm|html|aspx|php|jsp|do|action)$/i;

/**
 * A sign-in that can ONLY answer by postMessage to `window.opener` — Google Identity Services and
 * the legacy gapi popup flow.
 *
 * ⚠️ iOS never gives a WKWebView a real popup window, so there IS no opener to answer. Our
 * window.open stub therefore takes the MAIN frame to Google; Google finishes and redirects to
 * `storagerelay://…`, which WKWebView cannot load — and the user is parked on a dead page with the
 * half-filled application gone. Nothing about that is recoverable in-app, so the only honest move is
 * to spot it BEFORE navigating and offer the phone's browser instead.
 *
 * Deliberately narrow: a normal redirect-flow OAuth (`redirect_uri=https://portal.com/callback`)
 * works fine through the main frame and must NOT be caught here.
 */
export function isPostMessageOnlyAuth(url: string): boolean {
  try {
    const u = new URL(String(url));
    if (/^\/gsi\//i.test(u.pathname)) return true;                                    // Google Identity Services
    const ru = u.searchParams.get('redirect_uri') || '';
    // ⚠️ THE ONE RULE THAT MATTERS: A REDIRECT TARGET THAT IS NOT AN http(s) URL CANNOT LAND HERE.
    //
    // The three named cases below were each added after being seen in the wild, and the list kept
    // missing the next one — most importantly Glassdoor's, captured live from its own button:
    //   window.open('…/o/oauth2/v2/auth?gsiwebsdk=gis_attributes&redirect_uri=gis_transform
    //                &response_type=token&display=popup&response_mode=form_post',
    //               'g_auth_token_window_…', 'width=500,height=550,…')
    // `gis_transform` is a GIS sentinel, not an address. Google posts the token INTO the popup and
    // the SDK relays it to window.opener — so nothing is ever redirected back to glassdoor.com, and
    // there is no URL for this WebView to arrive at. Compare Indeed, which works here precisely
    // because its redirect_uri is a real one: https://secure.indeed.com/account/googleauth.
    //
    // So stop enumerating sentinels and test the property itself. A custom-scheme redirect_uri
    // (a native app's com.example:/oauth) is caught by the same rule and for the same reason.
    if (ru && !/^https?:\/\//i.test(ru)) return true;
    return false;
  } catch { return false; }
}

/**
 * Glassdoor hands its e-mail/Apple sign-in to Indeed — and Indeed's Google button DOES work here,
 * because Indeed uses a real redirect_uri. So when Glassdoor's own popup-only Google button is
 * refused, there is a route that actually works, and the user found it before we did: take
 * "Continue with Apple or email", then choose Google on the Indeed page that follows.
 */
export function hasIndeedGoogleRoute(pageUrl: string): boolean {
  try { return /(^|\.)glassdoor\.[a-z.]+$/i.test(new URL(String(pageUrl)).hostname); } catch { return false; }
}

/**
 * ⚠️ `isBlockedEmbeddedAuth` USED TO LIVE HERE, AND DELETING IT IS THE FIX.
 *
 * It reported every Google OAuth endpoint as impossible-in-a-web-view and both callers cancelled
 * the navigation on its word. The premise was Google's embedded-webview block
 * (`disallowed_useragent`) — real, but not what happens to us: with a clean browser UA Google
 * serves the ordinary redirect-based mobile flow, which needs no popup and no `window.opener` and
 * completes inside a single WebView.
 *
 * Proven in the field: signing in to Glassdoor through Indeed, "log in with Google" went through
 * normally in this same view. It only survived because Indeed starts Google with a SERVER redirect
 * and WKWebView does not consult `decidePolicyForNavigationAction` on a 302 — so the block never
 * ran. Every path where the block DID run is a path we broke ourselves.
 *
 * The refusal is now detected instead of predicted: GOOGLE_AUTH_WATCH_JS reads Google's own error
 * page and reports it, so we speak up when Google has actually said no. Do not reintroduce a
 * pre-emptive URL test here — a wrong prediction costs a working sign-in.
 */

/** True when the URL is an account/sign-in page rather than a job posting. */
export function isAuthUrl(url: string): boolean {
  try {
    const u = new URL(String(url));
    const segs = u.pathname.split('/').filter(Boolean);
    if (segs.some((s) => AUTH_SEG.test(s) || AUTH_FILE.test(s))) return true;
    if (/^(login|signin|accounts|auth[0-9]?)\./i.test(u.hostname)) return true;
    return false;
  } catch { return false; }
}

/**
 * Rewrite an ATS login/popup URL to the real job page where we can do so safely, and always strip
 * popup-only query params. Returns the input unchanged if there's nothing to fix.
 */
export function canonicalJobUrl(url: string): string {
  const raw = String(url || '').trim();
  if (!/^https?:\/\//i.test(raw)) return raw;
  let u: URL;
  try { u = new URL(raw); } catch { return raw; }

  // 1) drop popup/window params
  for (const k of [...u.searchParams.keys()]) if (POPUP_PARAMS.test(k)) u.searchParams.delete(k);

  const segs = u.pathname.split('/').filter(Boolean);
  const last = segs[segs.length - 1] || '';

  // 2) iCIMS: /jobs/<id>/<slug>/login|register  →  /jobs/<id>/<slug>/job   (verified: the /job page
  //    carries no captcha and exposes a normal Apply link)
  if (/\.icims\.com$/i.test(u.hostname) && AUTH_SEG.test(last) && segs.length >= 3) {
    segs[segs.length - 1] = 'job';
    u.pathname = '/' + segs.join('/');
    u.searchParams.delete('redirect');
    return u.toString();
  }

  // 3) Anything else ending in an auth segment: drop that segment and let the site route us. Only
  //    when something meaningful remains, so we never degrade a URL to a bare domain.
  if (AUTH_SEG.test(last) && segs.length >= 3) {
    segs.pop();
    u.pathname = '/' + segs.join('/');
    u.searchParams.delete('redirect');
    return u.toString();
  }

  return u.toString();
}
