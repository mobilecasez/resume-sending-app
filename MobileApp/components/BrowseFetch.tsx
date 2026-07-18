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
import React, { useRef, useState, useCallback, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Animated, PanResponder, Alert, Dimensions, BackHandler, Pressable, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { WebView } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { fetchJobDetail, saveCard, type LiveJobCard } from '../services/aiHubService';
import { isListingUrl } from '../utils/jobListing';
import RobotIcon from './RobotIcon';

const NOT_COMPANY_RE = /linkedin\.com|licdn\.com|lnkd\.in|google\.[a-z.]+|bing\.com|duckduckgo|accounts\.|login\.|signin\.|auth[0-9]?\.|appleid\.apple|facebook\.com|about:blank/i;

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
    return { html: String(html).slice(0, 220000), text: String(text).slice(0, 40000) };
  }
  function send(){
    try {
      var c = collect();
      window.ReactNativeWebView.postMessage(JSON.stringify({
        __cvbf: true, id: ${id}, url: location.href, title: String(document.title || ''),
        html: c.html, text: c.text
      }));
    } catch (e) {}
  }
  try {
    var t0 = (document.body && document.body.innerText) || '';
    if (t0.length < 400) { setTimeout(send, 900); return; }   // SPA still painting — one short beat
  } catch (e) {}
  send();
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

export default function BrowseFetch({ url, fetchCost, onClose, onFetched, onApplyHere }: {
  url: string;
  fetchCost: number;
  onClose: () => void;
  onFetched: (job: LiveJobCard | null, sourceUrl: string) => void;
  onApplyHere?: (applyUrl: string, pageTitle: string) => void;
}) {
  const webRef = useRef<WebView>(null);
  const insets = useSafeAreaInsets();
  const [currentUrl, setCurrentUrl] = useState(url);
  const [canGoBack, setCanGoBack] = useState(false);
  const [pageLoading, setPageLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [stage, setStage] = useState<null | 'reading' | 'understanding' | 'saving'>(null);   // what the loader says
  const [justSaved, setJustSaved] = useState(false);
  const [dockOpen, setDockOpen] = useState(false);
  const [companyHint, setCompanyHint] = useState(false);   // reached the company site after a LinkedIn apply
  const sawLinkedInRef = useRef(false);
  const currentUrlRef = useRef(url);
  const currentTitleRef = useRef('');
  const canGoBackRef = useRef(false);
  const fetchingRef = useRef(false);
  const savedUrlsRef = useRef<Set<string>>(new Set());   // don't double-charge the same posting
  const fetchIdRef = useRef(0);                          // per-fetch nonce (stale grabs are ignored)
  const grabTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const platform = platformOf(currentUrl);

  // While a fetch is running, back/close are BLOCKED — leaving the page mid-grab loses the fetch.
  const guardBusy = useCallback((): boolean => {
    if (!fetchingRef.current) return false;
    Alert.alert('Fetching in progress', 'Please wait a few seconds — your job is being read and saved.');
    return true;
  }, []);

  // Android hardware back: blocked while fetching; else web-history back first, then close.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (fetchingRef.current) { guardBusy(); return true; }
      if (canGoBackRef.current) { webRef.current?.goBack(); return true; }
      onClose();
      return true;
    });
    return () => { sub.remove(); if (grabTimerRef.current) clearTimeout(grabTimerRef.current); };
  }, [onClose, guardBusy]);

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
    if (savedUrlsRef.current.has(normUrl(u))) {
      Alert.alert('Already saved', 'This job is already in your Saved Jobs.');
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
  }, [doGrab]);

  const applyHere = useCallback(() => {
    if (guardBusy()) return;
    setDockOpen(false);
    // Be honest: the apply tools live on another screen, so this reopens the page in a fresh browser
    // and iOS cannot carry a page's typed-in state across two web views. Warn before destroying work.
    Alert.alert(
      'Open the apply tools?',
      'This reopens this page with Auto Fill, uploads and your saved details.\n\nAnything you have already typed on this page won’t carry over — you’d need to re-enter it.',
      [
        { text: 'Stay here', style: 'cancel' },
        { text: 'Open apply tools', onPress: () => onApplyHere?.(currentUrlRef.current, currentTitleRef.current) },
      ],
    );
  }, [onApplyHere, guardBusy]);

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
        savedUrlsRef.current.add(normUrl(srcUrl));
        return true;
      } catch { return false; }
    };
    try {
      const job = await fetchJobDetail(srcUrl, String(payload.html || ''), '', String(payload.text || ''));
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
  }, [fetchCost, onFetched, doGrab]);

  let host = ''; try { host = new URL(currentUrl).hostname.replace(/^www\./, ''); } catch {}

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
        <TouchableOpacity onPress={() => { if (!fetching) webRef.current?.reload(); }} style={[styles.navBtn, fetching && styles.navBtnOff]} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="refresh" size={17} color={fetching ? '#94A3B8' : '#0F172A'} />
        </TouchableOpacity>
        <TouchableOpacity onPress={() => { if (guardBusy()) return; onClose(); }} style={[styles.navBtn, fetching && styles.navBtnOff]} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="close" size={20} color={fetching ? '#94A3B8' : '#0F172A'} />
        </TouchableOpacity>
      </View>
      {companyHint && (
        <TouchableOpacity style={styles.hintBar} activeOpacity={0.9} onPress={() => { setCompanyHint(false); fetchCurrent(); }}>
          <Ionicons name="business" size={15} color="#fff" />
          <Text style={styles.hintTx} numberOfLines={2}>You’re on the company’s page — tap to Fetch this job with full details.</Text>
          <Ionicons name="sparkles" size={15} color="#fff" />
        </TouchableOpacity>
      )}
      {pageLoading && <View style={styles.progress}><ActivityIndicator size="small" color="#06B6D4" /></View>}

      <WebView
        ref={webRef}
        source={{ uri: url }}
        style={{ flex: 1 }}
        onNavigationStateChange={(nav) => {
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
        onLoadStart={() => setPageLoading(true)}
        onLoadEnd={() => setPageLoading(false)}
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
          if (target && webRef.current) {
            webRef.current.injectJavaScript(`window.location.href = ${JSON.stringify(target)}; true;`);
          }
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
                <Text style={styles.dockPlatHost} numberOfLines={1}>{host}</Text>
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
            <TouchableOpacity style={styles.dockLinkRow} onPress={signInLinkedIn} activeOpacity={0.8}>
              <Ionicons name="logo-linkedin" size={16} color="#0A66C2" />
              <Text style={styles.dockLinkTx}>Sign in to LinkedIn (so job sites recognise you)</Text>
              <Ionicons name="chevron-forward" size={14} color="rgba(255,255,255,0.4)" />
            </TouchableOpacity>
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
  host: { fontSize: 13.5, fontWeight: '800', color: '#0F172A' },
  hint: { fontSize: 10.5, color: '#64748B', marginTop: 1 },
  progress: { position: 'absolute', top: 100, alignSelf: 'center', zIndex: 5, backgroundColor: '#fff', borderRadius: 14, padding: 8, shadowColor: '#0F172A', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.12, shadowRadius: 10, elevation: 6 },
  hintBar: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 10, marginBottom: 8, backgroundColor: '#2563EB', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 },
  hintTx: { flex: 1, color: '#fff', fontSize: 12.5, fontWeight: '700', lineHeight: 16 },
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
});
