// AI Hub — new feature. Safe to delete without affecting existing app.
// "Browse & Fetch" — a VISIBLE in-app browser for job-board pages (Indeed/Naukri/Glassdoor…): the
// user browses like a human, opens a job, then uses the floating draggable bubble → a translucent
// DOCK with two actions:
//   • Fetch job  — capture this posting into CVApplyr (scrape → AI extract → Saved Jobs)
//   • Apply here — jump into the full apply experience (AI auto-fill, resume upload, cover letter)
// Fetch failures explain WHY (login required / human check / no job on page) instead of a generic
// error. Login sessions persist in the system cookie store (sharedCookies) so signing in to
// LinkedIn/Naukri once keeps working for later jobs — even after the app restarts.
//
// ⚠️ Deliberately NOT a <Modal>: it renders as a full-screen overlay VIEW inside the caller's modal.
// A Modal nested inside another Modal crashed the app on iOS when dismissed (v3.3 build 87).
import React, { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Animated, PanResponder, Alert, Dimensions, BackHandler, Pressable, Platform, Linking, TextInput, Keyboard,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { WebView } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { fetchJobDetail, saveCard, translateBatch, type LiveJobCard } from '../services/aiHubService';
import { isListingUrl, isSearchEngineUrl } from '../utils/jobListing';
import RobotIcon from './RobotIcon';
import { FRAME_GUARD_JS, AUTH_FLOW_JS, STAY_IN_APP_JS, PASSKEY_GUARD_JS } from '../utils/webviewAuth';
import { APP_BUILD } from '../services/analytics';
import { xlateScanJS, xlateApplyJS, XLATE_RESTORE_JS, XLATE_WATCH_JS, runXlatePasses, looksAlreadyEnglish, type XlateItem } from '../utils/webviewTranslate';
import { PAGE_TEXT_FN, FORM_TOUCH_JS } from '../utils/webviewPageText';

// ── search-or-open helpers (shared with GoogleJobBrowser and the Search tab) ─────────────────────
// Google's plain results page. `ie/oe` keep it UTF-8 on every locale; nothing else is forced, so the
// user gets their own country/language exactly as they would in their browser.
export function googleSearchUrl(query: string): string {
  const q = String(query || '').trim();
  return 'https://www.google.com/search?ie=UTF-8&oe=UTF-8&q=' + encodeURIComponent(q || 'jobs near me');
}

// A pasted job link should OPEN, not be googled. Deliberately conservative: a scheme or www. prefix,
// or a bare domain that carries a path ("company.com/careers/123"). Plain words — including things
// like "node.js" — still search.
export function directUrlOf(query: string): string | null {
  const t = String(query || '').trim();
  if (!t || /\s/.test(t)) return null;
  if (/^https?:\/\/\S+$/i.test(t)) return t;
  if (/^www\.[^\s/]+\.[^\s/]+/i.test(t)) return 'https://' + t;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+\/\S+$/i.test(t)) return 'https://' + t;
  return null;
}

const NOT_COMPANY_RE = /linkedin\.com|licdn\.com|lnkd\.in|google\.[a-z.]+|bing\.com|duckduckgo|accounts\.|login\.|signin\.|auth[0-9]?\.|appleid\.apple|facebook\.com|about:blank/i;

// The ONLY hosts the cancel-and-reload guard below applies to. Every other site navigates
// normally — the blunt "cancel every cross-host navigation" version worked but made ordinary
// browsing noticeably slower, because each hop paid for a cancelled navigation plus a fresh load.
// LinkedIn is the one domain that actually claims its links as iOS universal links here, so it is
// the only one that has to pay that price. lnkd.in is LinkedIn's own shortener and resolves to it.
const APP_CLAIMED_HOST_RE = /(^|\.)(linkedin\.com|lnkd\.in)$/i;
const isAppClaimedUrl = (u: string) => {
  try { return APP_CLAIMED_HOST_RE.test(new URL(u).hostname); } catch { return false; }
};

const { height: SH } = Dimensions.get('window');

// Real-browser UA (same fix as the job-detail apply WebView, commit d1f9627): Google rejects
// embedded-WebView UAs with "disallowed_useragent" — "Sign in with Google" silently dies. A clean
// platform-browser UA makes OAuth serve its redirect-based mobile flow that works in one WebView.
const BROWSER_UA = Platform.OS === 'android'
  ? 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
  : 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

// Page grab (the user has visually confirmed the job is on screen — no challenge-waiting).
// The per-fetch id lets onMessage ignore stale grabs from an earlier, abandoned fetch.
//
// Sends BOTH the cleaned HTML and the page's VISIBLE TEXT, because raw outerHTML alone kept missing
// jobs the user could plainly see:
//  • script/style are stripped BEFORE the 220KB clip, so the budget goes to content instead of being
//    eaten by <head> + inline hydration JSON (the server strips them only AFTER truncation).
//  • same-origin iframes (Greenhouse/SmartRecruiters embeds) hold the real job body — appended as a
//    SIBLING, since the server's cleaner removes <iframe> elements and would drop nested content.
//  • innerText survives SPA/shadow-DOM rendering that never shows up in outerHTML at all.
//  • if the body still looks empty (SPA mid-render), wait one short beat and grab again.
const grabNowJs = (id: number) => `(function(){
  ${PAGE_TEXT_FN}
  function collect(){
    var html = '';
    try {
      var clone = document.documentElement.cloneNode(true);
      var junk = clone.querySelectorAll('script,style,noscript,svg,link,meta');
      for (var i = 0; i < junk.length; i++) { try { junk[i].parentNode.removeChild(junk[i]); } catch (e) {} }
      html = clone.outerHTML || '';
    } catch (e) { try { html = document.documentElement.outerHTML || ''; } catch (e2) { html = ''; } }
    var text = '';
    try { text = (document.body && document.body.innerText) || ''; } catch (e) {}
    var mainText = '';
    try { mainText = cvfMainText(); } catch (e) {}
    try {
      var fr = document.querySelectorAll('iframe');
      for (var k = 0; k < fr.length && k < 4; k++) {
        try {
          var d2 = fr[k].contentDocument;
          if (d2 && d2.body) {
            html += '\\n<div data-cvbf-frame="1">' + (d2.body.innerHTML || '') + '</div>';
            if (d2.body.innerText) text += '\\n' + d2.body.innerText;
          }
        } catch (e) {}   // cross-origin frame — unreachable, that's fine
      }
    } catch (e) {}
    return { html: String(html).slice(0, 220000), text: String(text).slice(0, 40000), mainText: String(mainText).slice(0, 40000) };
  }
  function send(){
    try {
      var c = collect();
      window.ReactNativeWebView.postMessage(JSON.stringify({
        __cvbf: true, id: ${id}, url: location.href, title: String(document.title || ''),
        html: c.html, text: c.text, mainText: c.mainText
      }));
    } catch (e) {}
  }
  try {
    var t0 = (document.body && document.body.innerText) || '';
    if (t0.length < 400) { setTimeout(send, 900); return; }   // SPA still painting — one short beat
  } catch (e) {}
  send();
})(); true;`;

// Does this page hold anything the user actually typed? "Apply here" hands the page to another
// screen, and iOS cannot carry WebView state across two WebViews — but warning about that on a page
// with nothing typed is pure friction, which is exactly what it felt like when browsing search
// results. Ask the page, then only warn when there is something to lose.
const DIRTY_FORM_JS = `(function(){
  function post(o){ try{ o.__cvf=true; window.ReactNativeWebView.postMessage(JSON.stringify(o)); }catch(e){} }
  try{
    // The recorder is the reliable signal (see FORM_TOUCH_JS) and covers frames + contenteditable.
    var dirty = !!window.__cvfDirty;
    var els = dirty ? [] : document.querySelectorAll('input,textarea,select');
    for (var i = 0; i < els.length; i++) {
      var el = els[i], t = String(el.type || '').toLowerCase();
      if (t === 'hidden' || t === 'submit' || t === 'button' || t === 'reset' || t === 'image') continue;
      if (el.disabled || el.readOnly) continue;
      if (t === 'checkbox' || t === 'radio') { if (el.checked !== el.defaultChecked) { dirty = true; break; } continue; }
      if (el.tagName === 'SELECT') { var o2 = el.options[el.selectedIndex]; if (o2 && !o2.defaultSelected && el.selectedIndex > 0) { dirty = true; break; } continue; }
      // A search box the page itself filled in (Google keeps the query there) is not the user's work.
      if (/^(q|search|query|s)$/i.test(String(el.name || '')) ) continue;
      var v = String(el.value == null ? '' : el.value).trim();
      if (v && v !== String(el.defaultValue || '').trim()) { dirty = true; break; }
    }
    post({ type: 'FORM_DIRTY', dirty: dirty });
  }catch(e){ post({ type: 'FORM_DIRTY', dirty: true }); }   // can't tell → assume there IS work
})(); true;`;

// KEEP the query string (an Indeed job is /viewjob?jk=<id> — the query IS the job identity); drop only
// tracking params + hash + trailing slashes.
const normUrl = (u: string) => {
  try {
    const x = new URL(String(u || ''));
    const qp = new URLSearchParams(x.search);
    for (const k of [...qp.keys()]) if (/^(utm_|gclid|fbclid|msclkid|mc_|_hs|ref$|trk)/i.test(k)) qp.delete(k);
    const q = qp.toString();
    return (x.origin + x.pathname).replace(/\/+$/, '') + (q ? '?' + q : '');
  } catch { return String(u || '').split('#')[0].replace(/\/+$/, ''); }
};

// Which job platform is this page on? Shown in the dock + used in failure messages.
export function platformOf(u: string): string {
  const s = String(u || '').toLowerCase();
  if (isSearchEngineUrl(u)) { try { return new URL(u).hostname.replace(/^www\./, '').replace(/\..*$/, '').replace(/^./, (c) => c.toUpperCase()); } catch { return 'Search'; } }
  if (/linkedin\.com|lnkd\.in/.test(s)) return 'LinkedIn';
  if (/naukri\.com/.test(s)) return 'Naukri';
  if (/indeed\./.test(s)) return 'Indeed';
  if (/glassdoor\./.test(s)) return 'Glassdoor';
  if (/foundit\.(in|com)|monsterindia/.test(s)) return 'foundit';
  if (/monster\./.test(s)) return 'Monster';
  if (/shine\.com/.test(s)) return 'Shine';
  if (/timesjobs\.com/.test(s)) return 'TimesJobs';
  if (/wellfound\.com/.test(s)) return 'Wellfound';
  if (/instahyre\.com/.test(s)) return 'Instahyre';
  if (/(greenhouse|lever|ashbyhq|workday|smartrecruiters|recruitee|jobvite|icims)\./.test(s)) return 'Company portal';
  try { return new URL(String(u)).hostname.replace(/^www\./, ''); } catch { return 'this site'; }
}

// Is the shared cookie jar actually signed in to LinkedIn? The dock used to offer "Sign in to
// LinkedIn" unconditionally, which reads as broken once you ARE signed in. RN's fetch goes through
// the same cookie store as our WebViews (NSHTTPCookieStorage on iOS, the WebView CookieManager via
// ForwardingCookieHandler on Android), so one credentialed request answers it honestly.
// Returns the member's name when the feed hands it over, else just signed-in/out.
type LiSession = { signedIn: boolean; name: string } | 'unknown';
async function linkedInSession(): Promise<LiSession> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const res = await fetch('https://www.linkedin.com/feed/', {
      credentials: 'include', headers: { 'User-Agent': BROWSER_UA }, signal: ctl.signal,
    });
    clearTimeout(t);
    const finalUrl = String(res.url || '');
    if (/\/(login|uas\/login|authwall|checkpoint)/i.test(finalUrl)) return { signedIn: false, name: '' };
    const html = (await res.text()).slice(0, 200000);
    if (/name="session_key"|id="session_key"|<title>[^<]*(Sign Up|Login|Sign In)/i.test(html)) return { signedIn: false, name: '' };
    let name = '';
    const m = html.match(/"(?:identityDisplayName|memberFirstName|firstName)"\s*:\s*"([^"]{1,60})"/);
    if (m) name = m[1].replace(/\\u[0-9a-f]{4}/gi, '').trim();
    return { signedIn: true, name };
  } catch { return 'unknown'; }   // offline / timeout / LinkedIn blocked us — that is NOT a sign-out
}

// Why did the page not yield a job? Inspect the grabbed HTML BEFORE spending a credit.
function diagnosePage(html: string): 'login' | 'challenge' | null {
  const h = String(html || '');
  const text = h.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 6000);
  if (/just a moment|verify (that )?you.?re (a )?human|are you a robot|unusual traffic|checking your browser|attention required|px-captcha|hcaptcha|recaptcha/i.test(text)) return 'challenge';
  const hasPassword = /<input[^>]+type=["']?password/i.test(h);
  const loginWords = /authwall|sign in to (view|continue|apply)|log ?in to (view|continue|apply)|join now to view|login to apply|register to apply|create an account to/i.test(text);
  if (loginWords || (hasPassword && text.length < 2500)) return 'login';
  return null;
}

export default function BrowseFetch({ url, fetchCost, onClose, onFetched, onApplyHere, homeUrl, backRef }: {
  url: string;
  fetchCost: number;
  onClose: () => void;
  onFetched: (job: LiveJobCard | null, sourceUrl: string) => void;
  onApplyHere?: (applyUrl: string, pageTitle: string) => void;
  // Where "start over" goes — the search-results page this browsing session began at. Set by the
  // Google job search; without it the user has to tap back a dozen times to run another search.
  homeUrl?: string;
  // A host <Modal> hands us its Android back press here (the Modal intercepts the key itself).
  backRef?: React.MutableRefObject<(() => boolean) | null>;
}) {
  const webRef = useRef<WebView>(null);
  const insets = useSafeAreaInsets();
  const [currentUrl, setCurrentUrl] = useState(url);
  // What the WebView is told to LOAD (as opposed to where it has since navigated). Only the search
  // box changes this; ordinary link taps move the page without touching it. See openTypedLink for
  // why a search has to be a native load rather than injected JS.
  const [navUri, setNavUri] = useState(url);
  // How many link taps the stay-in-app guard has caught this session. Shown next to the build
  // number in the dock so a tester can see at a glance whether the guard is alive.
  const [stayKept, setStayKept] = useState(0);
  // The one URL we have just re-issued ourselves. The policy check below cancels every cross-host
  // navigation and replays it from script; without this, it would cancel its own replay too and
  // no link would ever open.
  const selfNavRef = useRef('');
  // "Opening LinkedIn…" banner. Shown the instant the tap is intercepted, not when the load starts,
  // because the gap between those two is exactly the dead-feeling part.
  const [handoff, setHandoff] = useState(false);
  const handoffTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Hosts already told that passkeys need the real browser — sites retry on every tap.
  const passkeyToldRef = useRef<Set<string>>(new Set());
  const [canGoBack, setCanGoBack] = useState(false);
  const [pageLoading, setPageLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [stage, setStage] = useState<null | 'reading' | 'understanding' | 'saving'>(null);   // what the loader says
  const [justSaved, setJustSaved] = useState(false);
  const [dockOpen, setDockOpen] = useState(false);
  const [companyHint, setCompanyHint] = useState(false);   // reached the company site after a LinkedIn apply
  const [tipHidden, setTipHidden] = useState(false);       // "tap a result, then Fetch job" tip on a results page
  const [liSession, setLiSession] = useState<LiSession | null>(null);   // null = not checked yet, 'unknown' = couldn't tell
  const applyWantRef = useRef(false);                      // an Apply-here tap waiting on the dirty-form probe
  const applyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Google sometimes answers a search with its own human-check page (/sorry). We do NOT try to get
  // around that — the user completes it themselves if they want to. We just stop pretending the page
  // is results, and offer the same query on another engine, exactly as they'd do in their browser.
  const [engineWall, setEngineWall] = useState(false);
  // Address bar: an always-available way to open a pasted link (or run a fresh search) from
  // inside the browser — no need to close it and start over.
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkText, setLinkText] = useState('');
  const sawLinkedInRef = useRef(false);
  const currentUrlRef = useRef(url);
  const currentTitleRef = useRef('');
  const canGoBackRef = useRef(false);
  const fetchingRef = useRef(false);
  const savedUrlsRef = useRef<Set<string>>(new Set());   // don't double-charge the same posting
  const fetchIdRef = useRef(0);                          // per-fetch nonce (stale grabs are ignored)
  const grabTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Translate is ON by default and re-applies itself on EVERY page — you shouldn't have to ask for
  // English again each time you open a result. Pages that are already English cost nothing: the scan
  // is local, and `looksAlreadyEnglish` skips the round trip entirely.
  const [webTranslated, setWebTranslated] = useState(true);
  const [webTranslating, setWebTranslating] = useState(false);
  const xlateOnRef = useRef(true);
  const xlateDirtyRef = useRef(false);   // page changed mid-pass → run once more when it finishes
  const xlateSettleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const xlateGenRef = useRef(0);       // discard replies from a superseded pass
  const xlateBusyRef = useRef(false);  // a pass is mid-flight — ignore the DOM churn it causes
  const webLoadingRef = useRef(false); // don't scan while a page load is in flight
  // Translate runs by itself here, so "this page is already English" is only worth SAYING when the
  // user actually asked. Without this the alert fires on every English job page, unprompted.
  const xlateManualRef = useRef(false);
  // …and an English page switching itself off must not disable translate for every LATER page.
  // Only an explicit tap on the control counts as "the user wants this off".
  const xlateOptOutRef = useRef(false);

  const platform = platformOf(currentUrl);

  // The banner is cleared by onLoadEnd in the normal case. The timer is the safety net: if the load
  // never ends (dead network, a redirect chain that stalls), the banner still goes away rather than
  // sitting on screen forever claiming to be busy.
  const hideHandoff = useCallback(() => {
    if (handoffTimerRef.current) { clearTimeout(handoffTimerRef.current); handoffTimerRef.current = null; }
    setHandoff(false);
  }, []);
  const showHandoff = useCallback(() => {
    setHandoff(true);
    if (handoffTimerRef.current) clearTimeout(handoffTimerRef.current);
    handoffTimerRef.current = setTimeout(() => { handoffTimerRef.current = null; setHandoff(false); }, 20000);
  }, []);
  useEffect(() => () => { if (handoffTimerRef.current) clearTimeout(handoffTimerRef.current); }, []);

  const runXlate = useCallback((_why = 'toggle') => {
    if (!webRef.current || !xlateOnRef.current) return;
    // ⚠️ DO NOT WAIT FOR THE LOAD TO FINISH. This used to return here and only show a spinner, so on
    // a slow board (or after an upload reloads the page) tapping Translate looked like it did
    // nothing for many seconds. The scan is repeatable and de-dupes against what it already
    // collected, so translating what is on screen NOW costs nothing — the load-end pass below picks
    // up whatever arrived afterwards. Same fix as the apply WebView in job-detail.
    if (webLoadingRef.current) setWebTranslating(true);
    // ⚠️ NEVER start a pass on top of a running one. Bumping the generation makes the in-flight pass
    // stale, and its already-scanned strings stay marked "seen" — so the page ends up permanently
    // untranslated with no error. This is what the 2.2s settle sweep was doing to the 400ms one.
    if (xlateBusyRef.current) { xlateDirtyRef.current = true; return; }
    const gen = ++xlateGenRef.current;
    setWebTranslating(true);
    try { webRef.current.injectJavaScript(xlateScanJS(gen)); } catch { setWebTranslating(false); }
  }, []);

  const toggleTranslate = useCallback(() => {
    if (!webRef.current) return;
    const next = !xlateOnRef.current;
    xlateOnRef.current = next; setWebTranslated(next);
    if (next) { xlateManualRef.current = true; xlateOptOutRef.current = false; runXlate('toggle-on'); }
    else { xlateOptOutRef.current = true; xlateGenRef.current++; setWebTranslating(false); try { webRef.current.injectJavaScript(XLATE_RESTORE_JS); } catch {} }
  }, [runXlate]);

  // The query this browsing session started from, so a blocked engine can be swapped for another one.
  const homeQuery = useMemo(() => {
    try { return new URL(String(homeUrl || '')).searchParams.get('q') || ''; } catch { return ''; }
  }, [homeUrl]);
  const searchElsewhere = useCallback(() => {
    if (!homeQuery || !webRef.current) return;
    const alt = 'https://duckduckgo.com/?q=' + encodeURIComponent(homeQuery);
    try { webRef.current.injectJavaScript(`window.location.href = ${JSON.stringify(alt)}; true;`); } catch {}
  }, [homeQuery]);

  // "Start a new search" — jump straight back to the results page this session began at, instead of
  // tapping back through every company site the user opened along the way.

  // Address bar: open what was typed — a link goes straight there, anything else Google-searches.
  const toggleLinkBar = useCallback(() => {
    if (fetchingRef.current) { Alert.alert('Fetching in progress', 'Please wait a few seconds — your job is being read and saved.'); return; }
    setLinkOpen((v) => {
      if (!v) setLinkText(currentUrlRef.current || '');
      return !v;
    });
  }, []);
  // The search control. Opens the box EMPTY — the old behaviour prefilled the current address,
  // so anyone wanting to search had to clear a long URL first. Tapping it again closes it.
  const openSearchBar = useCallback(() => {
    if (fetchingRef.current) { Alert.alert('Fetching in progress', 'Please wait a few seconds — your job is being read and saved.'); return; }
    setLinkOpen((v) => { if (!v) setLinkText(''); return !v; });
  }, []);
  const openTypedLink = useCallback(() => {
    const t = linkText.trim();
    if (!t) return;
    const target = directUrlOf(t) || googleSearchUrl(t);
    setLinkOpen(false);
    Keyboard.dismiss();
    // ⚠️ A NATIVE LOAD, NOT injectJavaScript. Searching used to set window.location.href from
    // injected JS, and iOS still handed google.com to the GOOGLE APP — the search left CVApplyr
    // entirely. Driving the WebView's own `source` makes this a loadRequest issued by the app,
    // which is not a user-activated navigation and therefore can never be claimed by another app's
    // universal links. Same destination, but it cannot escape.
    setNavUri((prev) => {
      // Re-searching the identical URL would not change state, so nothing would load. Reload
      // explicitly rather than leaving the user looking at a dead Go button.
      if (prev === target) { try { webRef.current?.reload(); } catch {} }
      return target;
    });
  }, [linkText]);

  // Re-check on every dock open: the user may have just signed in (or been signed out) since the
  // last look. Cheap enough not to cache, and always current when the row is actually on screen.
  useEffect(() => {
    if (!dockOpen) return;
    let alive = true;
    linkedInSession().then((r) => { if (alive) setLiSession(r); });
    return () => { alive = false; };
  }, [dockOpen]);

  // While a fetch is running, back/close are BLOCKED — leaving the page mid-grab loses the fetch.
  const guardBusy = useCallback((): boolean => {
    if (!fetchingRef.current) return false;
    Alert.alert('Fetching in progress', 'Please wait a few seconds — your job is being read and saved.');
    return true;
  }, []);

  // ONE back decision, used by the top-bar chevron, the Android hardware key, and — because a RN
  // <Modal> swallows the hardware key on Android and calls onRequestClose instead — by the host
  // Modal too (see the backRef prop). Without that, one back press tore down a whole browsing
  // session five pages deep, mid-fetch, ignoring the "fetching in progress" guard.
  const handleBack = useCallback(() => {
    if (fetchingRef.current) { guardBusy(); return true; }
    if (canGoBackRef.current) { webRef.current?.goBack(); return true; }
    onClose();
    return true;
  }, [onClose, guardBusy]);
  useEffect(() => { if (backRef) backRef.current = handleBack; }, [backRef, handleBack]);

  // Android hardware back: blocked while fetching; else web-history back first, then close.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', handleBack);
    return () => { sub.remove(); };
  }, [handleBack]);

  // Timers die with the COMPONENT, not with the BackHandler effect. That effect depends on `onClose`,
  // which the Discover screen passes as an inline arrow — so it tears down on every parent re-render,
  // and clearing the apply/fetch watchdogs there silently disarmed them mid-flight.
  useEffect(() => () => {
    if (grabTimerRef.current) clearTimeout(grabTimerRef.current);
    if (xlateSettleRef.current) clearTimeout(xlateSettleRef.current);
    if (applyTimerRef.current) clearTimeout(applyTimerRef.current);
  }, []);

  // Draggable bubble (same pattern as the Help assistant): drag moves it, a TAP opens the dock.
  const pan = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const moved = useRef(false);
  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 4 || Math.abs(g.dy) > 4,
      onPanResponderGrant: () => {
        moved.current = false;
        pan.setOffset({ x: (pan.x as any).__getValue(), y: (pan.y as any).__getValue() });
        pan.setValue({ x: 0, y: 0 });
      },
      onPanResponderMove: (e, g) => {
        if (Math.abs(g.dx) > 4 || Math.abs(g.dy) > 4) moved.current = true;
        pan.setValue({ x: g.dx, y: g.dy });
      },
      onPanResponderRelease: () => {
        pan.flattenOffset();
        if (!moved.current) { if (!fetchingRef.current) setDockOpen((o) => !o); }
      },
    })
  ).current;

  // Sign-in taken over from the page: run it here, then bring the user back to where they were.
  const preAuthUrlRef = useRef<string>('');
  const authOriginRef = useRef<string>('');
  const authAtRef = useRef<number>(0);
  const beginAuthFlow = useCallback((target: string, from?: string) => {
    if (!target || !webRef.current) return;
    const back = (from && /^https?:/i.test(from) ? from : currentUrlRef.current) || '';
    if (back && !/\/(login|signin|sign-in|register|oauth2?|auth|callback|sso)(\/|$|\?)/i.test(back)) {
      preAuthUrlRef.current = back;
      try { authOriginRef.current = new URL(back).origin; } catch { authOriginRef.current = ''; }
    }
    authAtRef.current = Date.now();
    try { webRef.current.injectJavaScript(`window.location.href = ${JSON.stringify(target)}; true;`); } catch {}
  }, []);
  const returnFromAuth = useCallback((delay = 900) => {
    const url = preAuthUrlRef.current;
    if (!url || !webRef.current) return;
    preAuthUrlRef.current = ''; authOriginRef.current = ''; authAtRef.current = 0;
    setTimeout(() => { try { webRef.current?.injectJavaScript(`window.location.href = ${JSON.stringify(url)}; true;`); } catch {} }, delay);
  }, []);

  const doGrab = useCallback(() => {
    const id = ++fetchIdRef.current;
    fetchingRef.current = true; setFetching(true); setStage('reading');
    webRef.current?.injectJavaScript(grabNowJs(id));
    // Safety net ONLY for "the page never posted back" — cleared the moment the grab arrives
    // (the backend extraction can legitimately take >20s and must not be interrupted).
    if (grabTimerRef.current) clearTimeout(grabTimerRef.current);
    grabTimerRef.current = setTimeout(() => {
      if (fetchingRef.current && fetchIdRef.current === id) {
        fetchingRef.current = false; setFetching(false); setStage(null);
        Alert.alert('Page didn’t respond', 'The page didn’t hand over its content. Reload it and try again.');
      }
    }, 20000);
  }, []);

  const fetchCurrent = useCallback(() => {
    if (fetchingRef.current) return;
    setDockOpen(false);
    const u = currentUrlRef.current;
    // A page of search results is never a job. Say that outright — the generic "is one job open?"
    // confirm let people fetch the Google page itself and get nonsense back.
    if (isSearchEngineUrl(u)) {
      Alert.alert('Open a job first', 'These are search results. Tap a result to open the actual job page, then tap Fetch job to save it.');
      return;
    }
    if (savedUrlsRef.current.has(normUrl(u))) {
      // ⚠️ THIS USED TO BE A DEAD END, and it is what "Fetch job stopped working" turned out to be:
      // the job had been fetched once before, so every later tap answered "Already saved" and did
      // nothing — indistinguishable from a broken button, especially while testing the same posting
      // repeatedly. Re-fetching is a legitimate thing to want (the posting may have changed, and a
      // card saved by an older extractor holds worse details), so offer it instead of refusing.
      Alert.alert(
        'Already saved',
        fetchCost > 0
          ? `This job is already in your Saved Jobs. Fetching it again refreshes its details and costs ${fetchCost} credit${fetchCost === 1 ? '' : 's'}.`
          : 'This job is already in your Saved Jobs. Fetching it again refreshes its details.',
        [{ text: 'Keep what I have', style: 'cancel' }, { text: 'Fetch again', onPress: doGrab }],
      );
      return;
    }
    // The URL LOOKS like a list — but SPA boards (Glassdoor/Indeed) open a job without changing the
    // URL, so this can be wrong. CONFIRM instead of blocking: the user can see what's on screen.
    if (isListingUrl(u)) {
      Alert.alert(
        'Is one job open?',
        'This page looks like a list of jobs. If you have a specific job open, go ahead and fetch it.',
        [{ text: 'Cancel', style: 'cancel' }, { text: 'Fetch this job', onPress: doGrab }],
      );
      return;
    }
    doGrab();
  }, [doGrab, fetchCost]);

  // Hand the page to the apply tools. On a page with nothing typed (browsing results, reading a
  // posting) this just goes — the old unconditional "this will reopen the page" confirm was friction
  // on every single tap. The warning is kept for the one case it is actually true: a part-filled form.
  const goApply = useCallback(() => {
    onApplyHere?.(currentUrlRef.current, currentTitleRef.current);
  }, [onApplyHere]);
  const applyHere = useCallback(() => {
    if (guardBusy()) return;
    setDockOpen(false);
    applyWantRef.current = true;
    if (applyTimerRef.current) clearTimeout(applyTimerRef.current);
    // If the page never answers (blank tab, hostile CSP) just go — never strand the user on a tap.
    applyTimerRef.current = setTimeout(() => { if (applyWantRef.current) { applyWantRef.current = false; goApply(); } }, 700);
    try { webRef.current?.injectJavaScript(DIRTY_FORM_JS); }
    catch { applyWantRef.current = false; if (applyTimerRef.current) clearTimeout(applyTimerRef.current); goApply(); }
  }, [guardBusy, goApply]);

  // Open the page in the phone's OWN browser — the DEFAULT one, Safari or Chrome, as a real
  // handover out of CVApplyr.
  //
  // ⚠️ Linking.openURL, NOT WebBrowser.openBrowserAsync. openBrowserAsync shows
  // SFSafariViewController, which is another in-app browser: it looked like a third window stacked
  // on the two the user was already in, and it carries its own "Open in …" button, so the one
  // control that is supposed to mean "leave" needed a second tap to actually leave.
  const openInBrowser = useCallback(() => {
    if (guardBusy()) return;
    setDockOpen(false);
    const u = currentUrlRef.current;
    if (!u || !/^https?:\/\//i.test(u)) return;
    Linking.openURL(u).catch(() => {});
  }, [guardBusy]);

  // Sign in to LinkedIn INSIDE the app's own browser. iOS keeps Safari / SFSafariViewController /
  // the LinkedIn app in separate cookie jars the app can't read, which is why "Log in with LinkedIn"
  // on a job site kept asking for a password. Logging in here lands the session in the shared jar
  // every in-app browser uses, so those buttons recognise you from then on.
  const signInLinkedIn = useCallback(() => {
    if (guardBusy()) return;
    setDockOpen(false);
    Alert.alert(
      'Sign in to LinkedIn',
      'We’ll open LinkedIn here so your session is saved inside CVApplyr. After that, “Log in with LinkedIn” on job sites will recognise you without asking for your password again.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Continue', onPress: () => { try { webRef.current?.injectJavaScript(`window.location.href='https://www.linkedin.com/login'; true;`); } catch {} } },
      ],
    );
  }, [guardBusy]);

  const onMessage = useCallback(async (raw: string) => {
    let payload: any = null; try { payload = JSON.parse(raw); } catch { return; }
    // Sign-in shim (see utils/webviewAuth.ts): iOS can never give the page a real popup.
    // Evidence that the stay-in-app interceptor actually ran. "The LinkedIn app still opened" and
    // "our handler never fired" are indistinguishable from the outside, and that ambiguity is what
    // let this bug survive two builds. Now the log says which one it was.
    if (payload && payload.__cvf && payload.type === 'STAY_INTERCEPT') {
      console.log('[stay-in-app] kept in the web view:', payload.host);
      setStayKept((n) => n + 1);
      return;
    }
    if (payload && payload.__cvf && payload.type === 'STAY_BLOCKED_SCHEME') {
      console.log('[stay-in-app] blocked an app-scheme link:', payload.url);
      setStayKept((n) => n + 1);
      return;
    }
    if (payload && payload.__cvf && payload.type === 'AUTH_POPUP') { beginAuthFlow(String(payload.url || ''), String(payload.from || '')); return; }
    if (payload && payload.__cvf && payload.type === 'AUTH_DONE') { returnFromAuth(600); return; }

    if (payload && payload.__cvf && payload.type === 'FORM_DIRTY') {
      if (!applyWantRef.current) return;
      applyWantRef.current = false;
      if (applyTimerRef.current) { clearTimeout(applyTimerRef.current); applyTimerRef.current = null; }
      if (!payload.dirty) { goApply(); return; }
      Alert.alert(
        'You’ve started filling this form',
        'The apply tools open this page in their own browser, and iOS can’t carry what you’ve typed across — you’d need to enter it again there.',
        [{ text: 'Stay here', style: 'cancel' }, { text: 'Open apply tools', onPress: goApply }],
      );
      return;
    }

    // ── translation (shared bridge; works even where a page's CSP blocks Google's widget) ──
    if (payload && payload.__cvf && payload.type === 'XLATE_ITEMS') {
      if (payload.gen !== xlateGenRef.current || !xlateOnRef.current) return;
      const items: XlateItem[] = Array.isArray(payload.items) ? payload.items : [];
      if (!items.length) { setWebTranslating(false); return; }
      const gen = payload.gen;
      xlateBusyRef.current = true;
      (async () => {
        const stale = () => gen !== xlateGenRef.current || !xlateOnRef.current;
        if (looksAlreadyEnglish(items)) {
          // Nothing to translate — but SAY SO. This used to return silently: the spinner stopped,
          // the button stayed lit, and not one word on the page changed. On an English posting
          // (measured on efinancialcareers.com — 310 strings, all English) that is indistinguishable
          // from "Translate is broken", which is exactly how it was reported.
          xlateBusyRef.current = false;
          setWebTranslating(false);
          xlateOnRef.current = false; setWebTranslated(false);   // leave the control off, not falsely lit
          // …but only SAY it when the user asked. Translate is on by default here, so alerting on
          // every English job page would be an unrequested modal on most of them.
          if (xlateManualRef.current) {
            xlateManualRef.current = false;
            Alert.alert('Already in English', 'This page is already in English, so there is nothing to translate.');
          }
          return;
        }
        xlateManualRef.current = false;   // a real pass is running; the tap has been answered
        let applied = 0;
        try {
          applied = await runXlatePasses(
            items,
            (batch) => translateBatch(batch),
            (map, final) => { try { webRef.current?.injectJavaScript(xlateApplyJS(gen, map, final)); } catch {} },
            stale,
          );
        } finally { xlateBusyRef.current = false; }
        if (stale()) return;
        // The page rendered more while we were working (lazy sections, infinite scroll). We ignored
        // those signals during the pass so they couldn't cancel it — so honour them now.
        if (xlateDirtyRef.current) { xlateDirtyRef.current = false; setTimeout(() => runXlate('settle'), 250); return; }
        if (!applied) {
          setWebTranslating(false);
          Alert.alert('Translation unavailable', "We couldn't translate this page right now. You can open it in your phone's browser to translate it there.");
        }
      })();
      return;
    }
    // Only the FINAL round ends the pass — earlier rounds are progress, not completion.
    if (payload && payload.__cvf && payload.type === 'XLATE_APPLIED') { if (payload.gen === xlateGenRef.current && payload.final) setWebTranslating(false); return; }
    // A passkey prompt cannot complete inside a WebView (see PASSKEY_GUARD_JS). We already rejected
    // it so the site falls back to a password — say why, once per host, and offer the browser.
    if (payload && payload.__cvf && payload.type === 'PASSKEY_BLOCKED') {
      const host = String(payload.host || '');
      if (passkeyToldRef.current.has(host)) return;
      passkeyToldRef.current.add(host);
      Alert.alert(
        'Passkeys need your browser',
        "Passkeys and Face ID sign-in only work in your phone's own browser, not inside an app. Use a password here, or open this page in your browser.",
        [{ text: 'Stay here', style: 'cancel' }, { text: 'Open in browser', onPress: () => openInBrowser() }],
      );
      return;
    }
    // Our own writes churn the DOM, so a mid-pass "dirty" would restart (and cancel) the pass.
    if (payload && payload.__cvf && payload.type === 'XLATE_DIRTY') {
      if (!xlateOnRef.current || webLoadingRef.current) return;
      if (xlateBusyRef.current) { xlateDirtyRef.current = true; return; }   // handled when the pass ends
      runXlate('spa'); return;
    }

    if (!payload || !payload.__cvbf || !fetchingRef.current) return;
    if (payload.id !== fetchIdRef.current) return;   // stale grab from an earlier, abandoned fetch
    if (grabTimerRef.current) { clearTimeout(grabTimerRef.current); grabTimerRef.current = null; }
    const srcUrl = String(payload.url || currentUrlRef.current);
    const plat = platformOf(srcUrl);
    // Diagnose BEFORE calling the backend — a login wall / bot check can't yield a job (and must
    // not cost a credit). Tell the user exactly what to do about it.
    const problem = diagnosePage(String(payload.html || ''));
    if (problem === 'login') {
      fetchingRef.current = false; setFetching(false); setStage(null);
      Alert.alert(
        `${plat} asks you to log in`,
        `This job is protected — ${plat} wants a login before showing it.\n\n• Log in on this page (CVApplyr remembers your session, even after you close the app), then tap “Fetch job” again.\n• Or tap “Apply here” to open the application with AI auto-fill.`,
      );
      return;
    }
    if (problem === 'challenge') {
      fetchingRef.current = false; setFetching(false); setStage(null);
      Alert.alert(
        `${plat} is checking you’re human`,
        'Complete the check shown on the page, wait for the job to appear, then tap “Fetch job” again.',
      );
      return;
    }
    // Advance the label so a slow extraction doesn't look frozen on "Fetching…".
    setStage('reading');
    const stageT1 = setTimeout(() => setStage('understanding'), 2500);
    const stageT2 = setTimeout(() => setStage('saving'), 12000);
    const clearStages = () => { clearTimeout(stageT1); clearTimeout(stageT2); };
    // Last-resort save so the user is NEVER left with nothing: keep the posting with what the page
    // already told us (title + url), exactly as live search degrades.
    const degrade = async () => {
      try {
        await saveCard({ id: srcUrl, job_url: srcUrl, title: String(payload.title || '').slice(0, 200) || 'Job', company: null, employer_name: null, location: null, work_mode: null, job_type: null, salary: null, experience: null, responsibilities: [], skills: [], source: plat, highlights: [], saved: false, summary: null } as any);
        // ⚠️ DO NOT mark this URL as saved. This is the title-only fallback after a fetch FAILED —
        // adding it here poisoned the set, so every later attempt on the same posting was
        // intercepted by the "Already saved" gate and the user could never get the real details.
        // Only the success path below records it.
        return true;
      } catch { return false; }
    };
    try {
      const job = await fetchJobDetail(srcUrl, String(payload.html || ''), '', String(payload.text || ''), String(payload.mainText || ''));
      clearStages();
      if (payload.id !== fetchIdRef.current) return;   // a newer fetch superseded this one
      fetchingRef.current = false; setFetching(false); setStage(null);
      if (job) {
        savedUrlsRef.current.add(normUrl(srcUrl));
        setJustSaved(true); setTimeout(() => setJustSaved(false), 2600);
        onFetched(job, srcUrl);
      } else {
        const kept = await degrade();
        Alert.alert(
          'Couldn’t read the full job',
          `We couldn’t pull the details from this page.${kept ? '\n\nIt’s saved to your Saved Jobs with the title, so you don’t lose it.' : ''}\n\nOpen the job’s own page on ${plat} and try again — or use “Apply here” to apply directly.`,
        );
        onFetched(null, srcUrl);
      }
    } catch (e: any) {
      clearStages();
      if (payload.id !== fetchIdRef.current) return;
      fetchingRef.current = false; setFetching(false); setStage(null);
      if (e && e.insufficient) {
        Alert.alert('Not enough credits', `Fetching a job costs ${fetchCost || 1} credit${(fetchCost || 1) === 1 ? '' : 's'}. You have ${e.creditsRemaining ?? 0}. Top up in Account → Credits.`);
        return;
      }
      // A timeout is NOT a failure — the server finishes and caches the job, so a retry is instant
      // (and free). Say so honestly instead of the old blanket "Could not fetch", and keep the job.
      const timedOut = e && (e.code === 'ECONNABORTED' || /timeout/i.test(String(e.message || '')));
      const kept = await degrade();
      Alert.alert(
        timedOut ? 'Taking longer than expected' : 'Could not fetch',
        timedOut
          ? `This job is still being read in the background.${kept ? ' We’ve saved it with the title so you don’t lose it.' : ''}\n\nTap Retry in a moment — it’ll be ready instantly, and you won’t be charged twice.`
          : `Something went wrong reading this page.${kept ? ' We’ve saved it with the title so you don’t lose it.' : ''}`,
        [{ text: 'OK', style: 'cancel' }, { text: 'Retry', onPress: () => { setTimeout(doGrab, 300); } }],
      );
    }
  }, [fetchCost, onFetched, doGrab, runXlate, goApply]);

  let host = ''; try { host = new URL(currentUrl).hostname.replace(/^www\./, ''); } catch {}
  const onSearchPage = isSearchEngineUrl(currentUrl);

  return (
    <View style={[StyleSheet.absoluteFillObject, styles.root, { paddingTop: Math.max(insets.top, 14) }]}>
      {/* top bar */}
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => { if (guardBusy()) return; canGoBack ? webRef.current?.goBack() : onClose(); }} style={[styles.navBtn, fetching && styles.navBtnOff]} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="chevron-back" size={20} color={fetching ? '#94A3B8' : '#0F172A'} />
        </TouchableOpacity>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text style={styles.host} numberOfLines={1}>{platform}</Text>
          <Text style={styles.hint} numberOfLines={1}>{host}</Text>
        </View>
        {/* SEARCH — always available, on every page including Google's own results.
            It used to re-navigate to the ORIGINAL search URL, which is a google.com address: iOS
            hands those to the Google app, so tapping "search" left CVApplyr entirely. It now opens
            the box below, which already accepts either a pasted link or a search phrase and stays
            in this window. */}
        <TouchableOpacity onPress={openSearchBar} style={[styles.navBtn, linkOpen && styles.navBtnActive, fetching && styles.navBtnOff]} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="search" size={17} color={fetching ? '#94A3B8' : linkOpen ? '#fff' : '#0F172A'} />
        </TouchableOpacity>
        <TouchableOpacity onPress={toggleTranslate} style={[styles.navBtn, webTranslated && styles.navBtnActive]} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          {webTranslating
            ? <ActivityIndicator size="small" color="#06B6D4" />
            : <Ionicons name="language" size={18} color={webTranslated ? '#fff' : '#0F172A'} />}
        </TouchableOpacity>
        <TouchableOpacity onPress={() => { if (!fetching) webRef.current?.reload(); }} style={[styles.navBtn, fetching && styles.navBtnOff]} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="refresh" size={17} color={fetching ? '#94A3B8' : '#0F172A'} />
        </TouchableOpacity>
        {/* LEAVING for the phone's own browser — the LAST control before close, because it is the
            only one in this bar that ends the session. Nothing else in this browser ever hands a
            page to another app, so this is the single, deliberate way out. */}
        <TouchableOpacity onPress={openInBrowser} style={[styles.navBtn, fetching && styles.navBtnOff]} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="open-outline" size={18} color={fetching ? '#94A3B8' : '#0F172A'} />
        </TouchableOpacity>
        <TouchableOpacity onPress={() => { if (guardBusy()) return; onClose(); }} style={[styles.navBtn, fetching && styles.navBtnOff]} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="close" size={20} color={fetching ? '#94A3B8' : '#0F172A'} />
        </TouchableOpacity>
      </View>
      {/* Address bar — open a pasted link directly, or Google-search anything else. Plain view
          below the top bar (NOT a Modal — we already live inside one). */}
      {linkOpen && (
        <View style={styles.linkBar}>
          <Ionicons name="link-outline" size={15} color="#64748B" />
          <TextInput
            value={linkText}
            onChangeText={setLinkText}
            placeholder="Paste a job link — or type a search"
            placeholderTextColor="#94A3B8"
            style={styles.linkInput}
            autoCapitalize="none"
            autoCorrect={false}
            // ⚠️ NOT keyboardType="url". iOS's URL keyboard has NO SPACE BAR — it replaces it with
            // "/" and ".", so typing a space into a search phrase produced a slash and the box was
            // usable only for addresses. This field takes EITHER a link or a search phrase, so it
            // needs an ordinary keyboard; 'web-search' is the iOS one that keeps a Go key.
            keyboardType={Platform.OS === 'ios' ? 'web-search' : 'default'}
            returnKeyType="go"
            autoFocus
            selectTextOnFocus
            onSubmitEditing={openTypedLink}
          />
          {linkText.length > 0 && (
            <TouchableOpacity onPress={() => setLinkText('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close-circle" size={16} color="#94A3B8" />
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={openTypedLink} style={styles.linkGoBtn} activeOpacity={0.85}>
            <Text style={styles.linkGoTx}>Go</Text>
          </TouchableOpacity>
        </View>
      )}
      {engineWall && (
        <View style={styles.wallBar}>
          <Ionicons name="shield-outline" size={15} color="#92400E" />
          <Text style={styles.wallTx} numberOfLines={3}>This search engine is asking you to confirm you’re human. Finish the check on the page — or search somewhere else.</Text>
          {!!homeQuery && (
            <TouchableOpacity onPress={searchElsewhere} style={styles.wallBtn} activeOpacity={0.85}>
              <Text style={styles.wallBtnTx}>Try DuckDuckGo</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
      {/* On the results page the robot bubble has nothing to fetch yet, so say what to do with it.
          Dismissible, and it comes back on the next search — it costs one tap and answers the only
          question a first-time user has here. */}
      {onSearchPage && !tipHidden && (
        <TouchableOpacity style={styles.tipBar} activeOpacity={0.9} onPress={() => setTipHidden(true)}>
          <Ionicons name="hand-left-outline" size={15} color="#0F172A" />
          <Text style={styles.tipTx} numberOfLines={2}>Tap any result to open it. Once you’re on the job’s own page, tap the robot → <Text style={styles.tipBold}>Fetch job</Text> to save it.</Text>
          <Ionicons name="close" size={14} color="#64748B" />
        </TouchableOpacity>
      )}
      {companyHint && (
        <TouchableOpacity style={styles.hintBar} activeOpacity={0.9} onPress={() => { setCompanyHint(false); fetchCurrent(); }}>
          <Ionicons name="business" size={15} color="#fff" />
          <Text style={styles.hintTx} numberOfLines={2}>You’re on the company’s page — tap to Fetch this job with full details.</Text>
          <Ionicons name="sparkles" size={15} color="#fff" />
        </TouchableOpacity>
      )}
      {/* Intercepted LinkedIn tap. Deliberately louder than the plain page spinner: this path is
          slower than a normal link, and the user's complaint was that nothing acknowledged the tap. */}
      {handoff && (
        <View style={styles.handoffBar}>
          <ActivityIndicator size="small" color="#fff" />
          <Text style={styles.handoffTx}>Opening LinkedIn inside CVApplyr…</Text>
        </View>
      )}
      {pageLoading && !handoff && <View style={styles.progress}><ActivityIndicator size="small" color="#06B6D4" /></View>}

      <WebView
        ref={webRef}
        source={{ uri: navUri }}
        style={{ flex: 1 }}
        onNavigationStateChange={(nav) => {
          if (nav.url && preAuthUrlRef.current && authOriginRef.current && !nav.loading) {
            let sameSite = false;
            try { sameSite = new URL(nav.url).origin === authOriginRef.current; } catch {}
            if (sameSite && Date.now() - authAtRef.current > 2500
                && !/\/(login|signin|sign-in|oauth2?|auth|callback|sso)(\/|$|\?)/i.test(nav.url)
                && nav.url !== preAuthUrlRef.current) returnFromAuth(1200);
          }
          // Google answers some searches with its own human-check page instead of results. We never
          // try to get past it — we just stop calling it results, so the user isn't left staring at a
          // screen that looks broken, and can pick another engine if they'd rather not bother.
          setEngineWall(/\/sorry\/|\/recaptcha\//i.test(String(nav.url || '')));
          currentUrlRef.current = nav.url; canGoBackRef.current = nav.canGoBack;
          currentTitleRef.current = String(nav.title || '');
          setCurrentUrl(nav.url); setCanGoBack(nav.canGoBack);
          // LinkedIn hides the external apply URL from us, but tapping Apply lands the user on the
          // company's own site. Detect that hop → nudge them to Fetch the REAL company page (full
          // details), which is exactly what they wanted for aasoka / iris etc.
          // Recompute the hint on EVERY navigation so it never goes stale: show it only while we're
          // actually on a company page reached from LinkedIn (hide on LinkedIn itself, on Google/Apple
          // sign-in, on auth pages, etc.).
          if (/linkedin\.com/i.test(nav.url || '')) { sawLinkedInRef.current = true; setCompanyHint(false); }
          else if (nav.url && /^https?:\/\//i.test(nav.url) && sawLinkedInRef.current && !NOT_COMPANY_RE.test(nav.url)) setCompanyHint(true);
          else setCompanyHint(false);
        }}
        onLoadStart={() => {
          setPageLoading(true); webLoadingRef.current = true;
          // New document: nothing from the old page's pass can apply to it, and its records are gone.
          xlateGenRef.current += 1; xlateBusyRef.current = false; xlateDirtyRef.current = false;
          // RE-ARM. The "already English" branch turns translate off so the control is not falsely
          // lit — but this browser translates by default, so leaving it off would mean the NEXT
          // page (a German posting, say) silently stays untranslated for the rest of the session.
          // An explicit tap on the control still sticks, via xlateOptOutRef.
          if (!xlateOnRef.current && !xlateOptOutRef.current) { xlateOnRef.current = true; setWebTranslated(true); }
          if (xlateSettleRef.current) { clearTimeout(xlateSettleRef.current); xlateSettleRef.current = null; }
        }}
        onLoadEnd={() => {
          setPageLoading(false); webLoadingRef.current = false;
          hideHandoff();
          if (!xlateOnRef.current) return;
          setTimeout(() => runXlate('load'), 400);            // re-apply / flush a mid-load tap
          // Job pages routinely paint their body after load. One late sweep catches that without a
          // polling loop; anything later still arrives via the MutationObserver.
          if (xlateSettleRef.current) clearTimeout(xlateSettleRef.current);
          xlateSettleRef.current = setTimeout(() => runXlate('settle'), 2200);
        }}
        // ⚠️ STAY_IN_APP_JS also runs BEFORE the page's own scripts. Injected only after load, our
        // capture-phase listener is installed behind whatever the site registered first — and a
        // single-page app like LinkedIn hydrates and starts handling clicks well before that point,
        // so a link tapped early still reached the OS and opened the native app. Registering first
        // is the whole mechanism. FRAME_GUARD_JS comes along because STAY_IN_APP_JS reads the
        // __cvfSkipFrame flag it sets, and without it we would install inside captcha frames too.
        // Re-injection is harmless: the __cvfStayHook guard makes the second run a no-op.
        injectedJavaScriptBeforeContentLoaded={FRAME_GUARD_JS + '\n' + STAY_IN_APP_JS}
        injectedJavaScriptBeforeContentLoadedForMainFrameOnly={false}
        injectedJavaScript={FRAME_GUARD_JS + '\n' + AUTH_FLOW_JS + '\n' + PASSKEY_GUARD_JS + '\n' + STAY_IN_APP_JS + '\n' + XLATE_WATCH_JS + '\n' + FORM_TOUCH_JS}
        injectedJavaScriptForMainFrameOnly={false}
        onMessage={(e) => onMessage(e.nativeEvent.data)}
        javaScriptEnabled
        domStorageEnabled
        // Persist logins: cookies live in the system web store, SHARED across all our WebViews and
        // surviving app restarts — log in to LinkedIn/Naukri once, stay logged in for future jobs.
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        originWhitelist={['*']}
        allowsBackForwardNavigationGestures
        // OAuth (Google/Apple/Microsoft) support — same fix as the apply WebView: clean browser UA,
        // popups allowed, and popup windows loaded IN THIS WebView (iOS drops them by default →
        // "nothing happens" / endless spinner on Sign in with Google/Apple).
        userAgent={BROWSER_UA}
        javaScriptCanOpenWindowsAutomatically
        setSupportMultipleWindows={false}
        onOpenWindow={(e: any) => {
          const target = e?.nativeEvent?.targetUrl;
          if (target) beginAuthFlow(target);   // remembers the page so we can come back
        }}
        // ⚠️ EVERY http(s) PAGE STAYS IN THIS WINDOW. Without an explicit decision here, a
        // navigation to an address the OS claims — google.com is the one that bit us, because the
        // Google app registers it — can be handed to that app instead, and the user is suddenly
        // outside CVApplyr with their search session gone. Leaving is now only ever something
        // they ask for, via the button next to the search one.
        onShouldStartLoadWithRequest={(req: any) => {
          const u = req?.url || '';
          if (!u || u === 'about:blank') return true;
          if (/^(mailto|tel|sms|facetime|maps|geo):/i.test(u)) { Linking.openURL(u).catch(() => {}); return false; }
          if (!/^https?:\/\//i.test(u)) return false;   // app-scheme deep links (linkedin://, googleapp://…)

          // ⚠️⚠️ THIS IS THE UNIVERSAL-LINK FIX. Read before simplifying.
          //
          // This callback IS WKWebView's decidePolicyForNavigationAction (see RNCWebViewImpl.m —
          // it reads navigationAction.navigationType and bridges the result). Returning true is
          // .allow, and ALLOWING a user-activated navigation is precisely what lets iOS hand the
          // URL to another app that owns the domain. Tapping a LinkedIn result on Google opened
          // the LinkedIn app for exactly this reason: we said yes, and the OS took us up on it.
          //
          // No JavaScript can undo that — by the time the policy is allowed, the decision is the
          // OS's. Three builds tried to fix it above this layer and could not.
          //
          // Apple's only public remedy is to CANCEL and load the URL yourself. So: deny the
          // link-activated navigation, then re-issue the identical URL from script. A scripted
          // navigation is not user-activated, so universal links do not apply to it, and it comes
          // back through here as navigationType 'other' and is allowed. location.assign (rather
          // than swapping `source`) keeps the page in session history, so Back still works.
          //
          // The alternative found in research — WKNavigationActionPolicyAllow + 2 — is a PRIVATE
          // API and risks rejection. Not viable with a version in review.
          // ⚠️ NOT just navigationType === 'click'. That was the b155 miss, and it is exactly the
          // reported case: a Google result link goes to google.com/url?q=… which 302-REDIRECTS to
          // linkedin.com. A redirect arrives here as 'other', not 'click', so a click-only guard
          // waves it through and iOS hands it to the LinkedIn app. The cancel has to cover the
          // redirect too, whatever triggered it — which is fine, because the URL we see at that
          // point IS the linkedin.com one.
          //
          // ⚠️ SCOPED TO LINKEDIN ON PURPOSE (b158). The first working version cancelled EVERY
          // cross-host navigation, which is correct but costs a cancelled navigation plus a fresh
          // load on every single hop between sites — browsing felt slow. LinkedIn is the domain
          // that actually claims these links, so it is the only one that pays. Every other site
          // takes the plain `return true` path it always did.
          if (Platform.OS === 'ios' && req?.isTopFrame !== false && isAppClaimedUrl(u)) {
            // Our own re-issued navigation must be let through, or this cancels itself forever.
            if (selfNavRef.current === u) { selfNavRef.current = ''; return true; }
            let sameHost = false;
            try { sameHost = new URL(u).host === new URL(currentUrlRef.current || url).host; } catch {}
            if (!sameHost) {
              selfNavRef.current = u;
              // The reload below is a full page load of a heavy site, and it starts from nothing —
              // the tap looked like it did nothing for a second or two. Say so immediately, in the
              // same tick as the tap, so the wait reads as progress rather than a dead link.
              showHandoff();
              // ⚠️ setNavUri — a NATIVE load — not injectJavaScript. This is the difference between
              // b156 and this build, and it comes from the user's own experiment: pasting a
              // LinkedIn URL into the address bar opened it IN the web view, while tapping the same
              // link opened the LinkedIn app. The paste path is exactly this — it changes `source`,
              // so WKWebView issues loadRequest from app code and universal links never apply.
              //
              // b155/b156 replayed the URL with window.location.assign instead. That runs INSIDE
              // the page, still inside the user's gesture, and iOS evidently still counts it as
              // user-driven — so the app opened anyway. Same destination, wrong messenger.
              //
              // Changing source.uri calls loadRequest on the SAME WKWebView, so the back-forward
              // list survives and Back still works.
              setNavUri(u);
              return false;
            }
          }
          return true;
        }}
      />

      {/* ── translucent DOCK (iOS-style sheet above the bubble) ── */}
      {dockOpen && (
        <Pressable style={styles.dockBackdrop} onPress={() => setDockOpen(false)}>
          <Pressable style={[styles.dock, { paddingBottom: Math.max(insets.bottom, 12) }]} onPress={() => {}}>
            <View style={styles.dockGrip} />
            <View style={styles.dockHead}>
              <View style={styles.dockPlatIcon}><Ionicons name="globe-outline" size={15} color="#22D3EE" /></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.dockPlatName} numberOfLines={1}>{platform}</Text>
                {/* Build number in plain sight. A bug report that says "still broken" is only
                    actionable if we know which build it was seen on, and the marketing version
                    alone ("3.6") cannot tell 151 from 152. */}
                <Text style={styles.dockPlatHost} numberOfLines={1}>
                  {host}{APP_BUILD ? `  ·  build ${APP_BUILD}` : ''}{stayKept > 0 ? `  ·  kept ${stayKept}` : ''}
                </Text>
              </View>
              <TouchableOpacity onPress={() => setDockOpen(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={19} color="rgba(255,255,255,0.6)" />
              </TouchableOpacity>
            </View>
            <View style={styles.dockRow}>
              <TouchableOpacity style={styles.dockItem} onPress={fetchCurrent} activeOpacity={0.85}>
                <LinearGradient colors={['#06B6D4', '#3B82F6']} style={styles.dockItemIcon}>
                  <Ionicons name="sparkles" size={22} color="#fff" />
                </LinearGradient>
                <Text style={styles.dockItemTitle}>Fetch job</Text>
                <Text style={styles.dockItemSub}>{fetchCost > 0 ? `Save to CVApplyr · ${fetchCost} cr` : 'Save to CVApplyr'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.dockItem} onPress={applyHere} activeOpacity={0.85}>
                <LinearGradient colors={['#7C6BFF', '#EC4899']} style={styles.dockItemIcon}>
                  <Ionicons name="flash" size={22} color="#fff" />
                </LinearGradient>
                <Text style={styles.dockItemTitle}>Apply here</Text>
                <Text style={styles.dockItemSub}>AI auto-fill + resume</Text>
              </TouchableOpacity>
            </View>
            <TouchableOpacity style={styles.dockLinkRow} onPress={openInBrowser} activeOpacity={0.8}>
              <Ionicons name="open-outline" size={16} color="#22D3EE" />
              <Text style={styles.dockLinkTx}>Open this page in your browser</Text>
              <Ionicons name="chevron-forward" size={14} color="rgba(255,255,255,0.4)" />
            </TouchableOpacity>
            {/* Only offer a sign-in when there ISN'T one. Once the shared cookie jar has a LinkedIn
                session, say so instead — the old always-on "Sign in to LinkedIn" read as broken. */}
            {liSession && liSession !== 'unknown' && liSession.signedIn ? (
              <View style={[styles.dockLinkRow, styles.dockLinkRowFlat]}>
                <Ionicons name="logo-linkedin" size={16} color="#0A66C2" />
                <Text style={styles.dockLinkTx} numberOfLines={1}>
                  {liSession.name ? `Signed in to LinkedIn as ${liSession.name}` : 'Signed in to LinkedIn'}
                </Text>
                <Ionicons name="checkmark-circle" size={16} color="#34D399" />
              </View>
            ) : (
              <TouchableOpacity style={styles.dockLinkRow} onPress={signInLinkedIn} activeOpacity={0.8}>
                <Ionicons name="logo-linkedin" size={16} color="#0A66C2" />
                {/* Only claim they're signed OUT when the probe actually proved it. */}
                <Text style={styles.dockLinkTx}>{liSession === null || liSession === 'unknown' ? 'Sign in to LinkedIn (so job sites recognise you)' : 'Signed out of LinkedIn — sign in again'}</Text>
                <Ionicons name="chevron-forward" size={14} color="rgba(255,255,255,0.4)" />
              </TouchableOpacity>
            )}
            <Text style={styles.dockHint}>Open a specific job first, then fetch it or apply with auto-fill.</Text>
          </Pressable>
        </Pressable>
      )}

      {/* draggable bubble — opens the dock */}
      <Animated.View style={[styles.fabWrap, { transform: pan.getTranslateTransform() }]} {...responder.panHandlers}>
        <View style={styles.fabInner}>
          <LinearGradient colors={justSaved ? ['#10B981', '#059669'] : ['#06B6D4', '#3B82F6']} style={styles.fabCircle}>
            {fetching
              ? <ActivityIndicator size="small" color="#fff" />
              : justSaved ? <Ionicons name="checkmark" size={22} color="#fff" /> : <RobotIcon size={24} color="#fff" />}
          </LinearGradient>
          <View style={styles.fabLabel}>
            <Text style={styles.fabLabelTx}>
              {fetching
                ? (stage === 'saving' ? 'Saving…' : stage === 'understanding' ? 'Understanding the job…' : 'Reading page…')
                : justSaved ? 'Saved ✓' : 'Job tools'}
            </Text>
          </View>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: '#F0F4FA', zIndex: 100, elevation: 100 },
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingBottom: 10, gap: 4, backgroundColor: '#F0F4FA' },
  navBtn: { width: 36, height: 36, borderRadius: 12, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#E2E8F0' },
  navBtnOff: { opacity: 0.55 },
  navBtnActive: { backgroundColor: '#06B6D4', borderColor: '#06B6D4' },
  host: { fontSize: 13.5, fontWeight: '800', color: '#0F172A' },
  hint: { fontSize: 10.5, color: '#64748B', marginTop: 1 },
  progress: { position: 'absolute', top: 100, alignSelf: 'center', zIndex: 5, backgroundColor: '#fff', borderRadius: 14, padding: 8, shadowColor: '#0F172A', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.12, shadowRadius: 10, elevation: 6 },
  handoffBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, marginHorizontal: 10, marginBottom: 8, backgroundColor: '#0A66C2', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 },
  handoffTx: { color: '#fff', fontSize: 12.5, fontWeight: '700' },
  hintBar: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 10, marginBottom: 8, backgroundColor: '#2563EB', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 },
  hintTx: { flex: 1, color: '#fff', fontSize: 12.5, fontWeight: '700', lineHeight: 16 },
  tipBar: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 10, marginBottom: 8, backgroundColor: '#fff', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: '#E2E8F0' },
  tipTx: { flex: 1, color: '#334155', fontSize: 12, fontWeight: '600', lineHeight: 16 },
  tipBold: { fontWeight: '800', color: '#0F172A' },
  linkBar: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 10, marginBottom: 8, backgroundColor: '#F1F5F9', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 7, borderWidth: 1, borderColor: '#E2E8F0' },
  linkInput: { flex: 1, fontSize: 13, color: '#0F172A', paddingVertical: 2 },
  linkGoBtn: { backgroundColor: '#06B6D4', borderRadius: 9, paddingHorizontal: 13, paddingVertical: 6 },
  linkGoTx: { color: '#fff', fontSize: 12, fontWeight: '800' },
  wallBar: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 10, marginBottom: 8, backgroundColor: '#FEF3C7', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: '#FDE68A' },
  wallTx: { flex: 1, color: '#92400E', fontSize: 12, fontWeight: '600', lineHeight: 16 },
  wallBtn: { backgroundColor: '#92400E', borderRadius: 9, paddingHorizontal: 10, paddingVertical: 6 },
  wallBtnTx: { color: '#fff', fontSize: 11.5, fontWeight: '800' },
  fabWrap: { position: 'absolute', right: 14, bottom: Math.min(SH * 0.16, 140), zIndex: 30 },
  fabInner: { alignItems: 'center' },
  fabCircle: { width: 58, height: 58, borderRadius: 29, alignItems: 'center', justifyContent: 'center', shadowColor: '#0B0F22', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.3, shadowRadius: 14, elevation: 10 },
  fabLabel: { marginTop: 5, backgroundColor: '#0B0F22', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3.5 },
  fabLabelTx: { fontSize: 10.5, fontWeight: '800', color: '#fff' },
  // dock
  dockBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(6,10,25,0.35)', justifyContent: 'flex-end', zIndex: 40 },
  dock: { marginHorizontal: 10, marginBottom: 10, borderRadius: 26, backgroundColor: 'rgba(11,15,34,0.94)', paddingHorizontal: 16, paddingTop: 8, shadowColor: '#000', shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.4, shadowRadius: 28, elevation: 20, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' },
  dockGrip: { alignSelf: 'center', width: 40, height: 4.5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.22)', marginBottom: 10 },
  dockHead: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  dockPlatIcon: { width: 30, height: 30, borderRadius: 10, backgroundColor: 'rgba(34,211,238,0.14)', alignItems: 'center', justifyContent: 'center' },
  dockPlatName: { fontSize: 14.5, fontWeight: '800', color: '#fff' },
  dockPlatHost: { fontSize: 11, color: 'rgba(255,255,255,0.55)', marginTop: 1 },
  dockRow: { flexDirection: 'row', gap: 10 },
  dockItem: { flex: 1, backgroundColor: 'rgba(255,255,255,0.07)', borderRadius: 18, alignItems: 'center', paddingVertical: 14, paddingHorizontal: 8, borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)' },
  dockItemIcon: { width: 46, height: 46, borderRadius: 15, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  dockItemTitle: { fontSize: 13.5, fontWeight: '800', color: '#fff' },
  dockItemSub: { fontSize: 10.5, color: 'rgba(255,255,255,0.55)', marginTop: 2, textAlign: 'center' },
  dockHint: { fontSize: 10.5, color: 'rgba(255,255,255,0.45)', textAlign: 'center', marginTop: 12, marginBottom: 2 },
  dockLinkRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14,
    paddingVertical: 11, paddingHorizontal: 12, borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
  },
  dockLinkTx: { flex: 1, fontSize: 12, fontWeight: '600', color: 'rgba(255,255,255,0.85)' },
  dockLinkRowFlat: { marginTop: 8, backgroundColor: 'rgba(16,185,129,0.10)', borderColor: 'rgba(16,185,129,0.22)' },
});
