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
    if (/^storagerelay:/i.test(ru)) return true;                                      // the GIS popup relay
    if (/^\/o\/oauth2\//i.test(u.pathname) && /^postmessage$/i.test(ru)) return true;  // legacy gapi
    return false;
  } catch { return false; }
}

/** True when the URL is an account/sign-in page rather than a job posting. */
export function isAuthUrl(url: string): boolean {
  try {
    const u = new URL(String(url));
    const segs = u.pathname.split('/').filter(Boolean);
    if (segs.some((s) => AUTH_SEG.test(s))) return true;
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
