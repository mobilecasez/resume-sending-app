// AI Hub — new feature. Safe to delete without affecting existing app.
// "Look for live jobs on Google" — a rich, interactive modal. The web browser is the ENGINE, never the
// UI: the search comes back as structured cards rendered in OUR style (the raw Google page is never
// shown). The user multi-selects cards and taps "Fetch details" → each posting is opened ONE AT A TIME
// in a hidden on-device WebView (the user's own IP → no bot wall), the page HTML is scraped, sent to the
// backend for AI extraction, STORED, and shown back as a full our-style job card.
import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  Modal, View, Text, StyleSheet, TouchableOpacity, FlatList, ActivityIndicator, Animated, Easing, Dimensions, AppState, Alert,
} from 'react-native';
import { useEventCosts } from '../hooks/useEventCosts';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { liveSearchJobs, fetchJobDetail, saveCard, type LiveJobCard } from '../services/aiHubService';
import { notifyLocal } from '../services/pushNotificationService';
import { expandTerm } from '../utils/searchSynonyms';
import { resolveLiveLocation, locationAllowed } from '../utils/jobLocation';
import { isListingUrl, parseLinkedInListing, listingCountFromTitle } from '../utils/jobListing';
import BrowseFetch from './BrowseFetch';

const { height: SH } = Dimensions.get('window');
type FetchState = 'idle' | 'fetching' | 'done' | 'failed';

// Grab the fully-rendered page HTML once the page has actually rendered (SPAs like arbeitsagentur/get-in-it
// load their content via JS). Polls until readyState=complete AND the body has real text, up to a 9s cap —
// so fast pages return quickly and slow SPAs still get captured (a fixed short delay was missing them).
// Grab the fully-rendered page HTML once it's actually ready. Waits out bot-challenge pages (Cloudflare
// "Just a moment" / Indeed / PerimeterX): those auto-resolve their JS challenge in a real on-device browser
// within a few seconds, so we must NOT grab the interstitial — keep polling up to a longer cap and grab the
// REAL page once it appears. Fast pages still return in ~250ms.
const GRAB_JS = `(function(){
  var START = Date.now(), MAXW = 13000;
  function grab(){ try { window.ReactNativeWebView.postMessage(JSON.stringify({ __cvd:true, url: location.href, html: (document.documentElement.outerHTML||'').slice(0,220000) })); } catch(e){} }
  function bodyText(){ try { return (document.body && document.body.innerText) || ''; } catch(e){ return ''; } }
  function isChallenge(t){ return /just a moment|checking (if the site|your browser)|verifying you are (a )?human|attention required|enable javascript and cookies|please enable (js|javascript)|cloudflare|unusual traffic|are you a robot|verify you.?re human|px-captcha|hcaptcha|recaptcha challenge/i.test(t); }
  function ready(){ try { var t = bodyText(); if (isChallenge(t) && Date.now()-START < MAXW) return false; return document.readyState === 'complete' && t.replace(/\\s+/g,' ').trim().length > 500; } catch(e){ return false; } }
  (function wait(){ if (ready() || Date.now()-START > MAXW) setTimeout(grab, 250); else setTimeout(wait, 300); })();
})(); true;`;

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// On-device organic-results scraper. A REAL Google (+ DuckDuckGo-lite fallback) search on the USER's own
// IP → works for ANY country/city and doesn't depend on the slow server-side grounding. Grabs each organic
// result's <h3> title + destination URL (resolving Google's /url? and DDG's redirect wrappers), skipping
// the engines' own domains. Retries while the page settles, then posts what it found.
const SEARCH_SCRAPE_JS = `(function(){
  function real(href){
    if(!href) return '';
    try{
      var m = href.match(/[?&](?:q|url|uddg)=([^&]+)/);
      if(/\\/url\\?|duckduckgo\\.com\\/l\\//i.test(href) && m){ return decodeURIComponent(m[1]); }
    }catch(e){}
    return href;
  }
  var SKIP = /google\\.|gstatic|googleusercontent|youtube\\.|webcache|duckduckgo\\.com|bing\\.|\\.google\\./i;
  function scan(){
    var out=[], seen={};
    try{
      var h3s=document.querySelectorAll('h3');
      for(var i=0;i<h3s.length;i++){
        var h=h3s[i], a=(h.closest?h.closest('a'):null);
        if(!a){ var p=h.parentElement; while(p && p.tagName!=='A'){ p=p.parentElement; } a=p; }
        if(!a||!a.href) continue;
        var href=real(a.href);
        if(!/^https?:\\/\\//i.test(href) || SKIP.test(href)) continue;
        var title=(h.innerText||h.textContent||'').trim();
        if(!title||title.length<3||seen[href]) continue; seen[href]=1;
        out.push({title:title.slice(0,180), url:href});
      }
      if(!out.length){   // DDG-lite / plain markup: result links carry the title text directly
        var as=document.querySelectorAll('a.result-link, a[href]');
        for(var j=0;j<as.length && out.length<30;j++){
          var href2=real(as[j].href||'');
          if(!/^https?:\\/\\//i.test(href2) || SKIP.test(href2)) continue;
          var t2=(as[j].innerText||as[j].textContent||'').trim();
          if(!t2||t2.length<8||seen[href2]) continue; seen[href2]=1;
          out.push({title:t2.slice(0,180), url:href2});
        }
      }
    }catch(e){}
    var bt=(document.body?document.body.innerText:'')||'';
    return {out:out, blocked:/captcha|unusual traffic|are you a robot|too many requests|before you continue|verify you.re human/i.test(bt)};
  }
  var tries=0;
  var iv=setInterval(function(){
    tries++;
    var r=scan();
    if(r.out.length>0 || tries>=14){
      clearInterval(iv);
      try{ window.ReactNativeWebView.postMessage(JSON.stringify({__cvsr:true, results:r.out, blocked:r.blocked})); }catch(e){}
    }
  },500);
})(); true;`;

// Scraper for LinkedIn's PUBLIC guest jobs API (no login) — the dense, paginated source of INDIVIDUAL
// postings (~25/page). Each guest card carries title + company + location + a real /jobs/view/ link.
const LINKEDIN_SCRAPE_JS = `(function(){
  function txt(el){ return el ? (el.innerText||el.textContent||'').trim() : ''; }
  function scan(){
    var out=[], seen={};
    var cards=document.querySelectorAll('li');
    for(var i=0;i<cards.length;i++){
      var c=cards[i];
      var a=c.querySelector('a.base-card__full-link, a[href*="/jobs/view/"]');
      if(!a||!a.href) continue;
      var href=a.href.split('?')[0];
      if(seen[href]) continue;
      var title=txt(c.querySelector('.base-search-card__title, h3'));
      if(!title) continue;
      var company=txt(c.querySelector('.base-search-card__subtitle, h4'));
      var loc=txt(c.querySelector('.job-search-card__location, .base-search-card__metadata span'));
      seen[href]=1;
      out.push({title:title.slice(0,180), url:href, company:company.slice(0,120), location:loc.slice(0,120)});
    }
    return out;
  }
  var tries=0;
  var iv=setInterval(function(){
    tries++;
    var r=scan();
    if(r.length>0 || tries>=16){
      clearInterval(iv);
      try{ window.ReactNativeWebView.postMessage(JSON.stringify({__cvli:true, results:r})); }catch(e){}
    }
  },500);
})(); true;`;

// Split a free-text query into {keywords, location} for the LinkedIn/engine URLs. Heuristic: "<role> in
// <place>" → keywords="<role>", location="<place>"; strips filler ("jobs", "vacancies", "near me"…).
function parseLiveQuery(q: string): { kw: string; loc: string } {
  const raw = String(q || '').trim();
  let kw = raw, loc = '';
  const m = raw.match(/\bin\b\s+(.+)$/i);
  if (m && typeof m.index === 'number') { loc = m[1].trim(); kw = raw.slice(0, m.index).trim(); }
  kw = kw.replace(/\b(jobs?|vacan\w*|openings?|positions?|roles?|hiring|profile|near\s+me)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  loc = loc.replace(/\b(jobs?|near\s+me)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  return { kw: kw || raw, loc };
}

// Build the LinkedIn guest `keywords` value with SYNONYM expansion + boolean OR (verified LinkedIn honours
// it: "(.net OR dotnet) developer" → strong). So ".net" also pulls "dotnet"/"dot net", "node" pulls
// "node.js"/"nodejs", "sde" pulls "software engineer", etc. — the user gets every phrasing.
//  • whole-phrase synonym (e.g. "full stack developer") → one OR group
//  • else expand each token; a token with variants becomes "(a OR b OR c)"
//  • a single bare symbol-token (".net","c#","node.js") also gets "developer" (LinkedIn returns junk for
//    a bare symbol otherwise — verified ".net" → 0 relevant, ".net developer"/"(.net OR dotnet) developer" → strong)
function buildLinkedInKeywords(kw: string): string {
  const raw = String(kw || '').trim();
  if (!raw) return raw;
  const tokens = raw.split(/\s+/).filter(Boolean);
  // Sanitize each variant: drop parenthetical fragments/stray parens (they break LinkedIn's boolean parser),
  // then quote any multi-word phrase so the OR groups stay unambiguous.
  const clean = (v: string) => v.replace(/\s*\([^)]*\)/g, '').replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  const q = (v: string) => (/\s/.test(v) ? '"' + v + '"' : v);
  const orGroup = (variants: string[]) => '(' + [...new Set(variants.map(clean).filter(Boolean))].map(q).join(' OR ') + ')';
  const whole = expandTerm(raw);
  let out: string;
  if (whole.length > 1) out = orGroup(whole);
  else out = tokens.map((t) => { const v = expandTerm(t); return v.length > 1 ? orGroup(v) : t; }).join(' ');
  if (tokens.length === 1 && /[.#+]/.test(tokens[0])) out += ' developer';
  return out;
}

// The URL to actually LOAD when fetching a card's details (the card keeps its real apply URL for the user).
// LinkedIn's /jobs/view/ page walls guests + shows an app-interstitial on mobile → its details never load;
// the PUBLIC guest jobPosting API returns the full JD (title/company/location/description/criteria) with NO
// login. So for LinkedIn cards we scrape the guest API instead. Everything else loads its own page.
function fetchSourceUrl(u: string): string {
  const s = String(u || '');
  try {
    if (/linkedin\.com\/jobs\/view\//i.test(s)) {
      const m = s.split('?')[0].match(/(\d{6,})\/?$/);   // trailing numeric job id
      if (m) return 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/' + m[1];
    }
  } catch {}
  return s;
}

export default function LiveJobSearch({ visible, query, onClose }: { visible: boolean; query: string; onClose: () => void }) {
  const CONCURRENCY = 5;   // fetch up to 5 selected postings at once (was one-at-a-time)
  const { costOf } = useEventCosts();
  const fetchCost = costOf('live_fetch') ?? 0;
  const [phase, setPhase] = useState<'searching' | 'results' | 'error'>('searching');
  const [cards, setCards] = useState<LiveJobCard[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState<Record<string, LiveJobCard>>({});
  const [fstate, setFstate] = useState<Record<string, FetchState>>({});
  const [fetching, setFetching] = useState(false);
  const [activeUrls, setActiveUrls] = useState<string[]>([]);   // urls with a live hidden WebView (≤ CONCURRENCY)
  const [webGen, setWebGen] = useState(0);                      // bump → remount WebViews (resume after background)
  const queueRef = useRef<string[]>([]);
  const activeRef = useRef<Set<string>>(new Set());
  const timersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const detailsRef = useRef<Record<string, LiveJobCard>>({});
  const fstateRef = useRef<Record<string, FetchState>>({});
  const cardsRef = useRef<LiveJobCard[]>([]);
  const fetchingRef = useRef(false);
  const queryRef = useRef(query);
  const batchRef = useRef<string[]>([]);   // urls in the current fetch batch (for the completion notification)
  const retryRef = useRef<Record<string, number>>({});   // per-url auto-retry count (retry once before failing)
  // On-device web search (real Google/DDG on the user's IP → worldwide, no server bot wall). Runs in
  // PARALLEL with the server search and merges in; we only show "no results" once BOTH have finished empty.
  const [searchActive, setSearchActive] = useState(false);
  const [searchGen, setSearchGen] = useState(0);
  const serverDoneRef = useRef(false);
  const webDoneRef = useRef(false);
  const webReportsRef = useRef(0);
  const webTargetsRef = useRef(0);   // how many on-device sources we're waiting on this run
  const webReportedRef = useRef<Set<number>>(new Set());   // source indices that have reported (dedup)
  // "Browse & Fetch" visible browser (non-LinkedIn listing pages / previewing any organic result).
  const [browseUrl, setBrowseUrl] = useState<string | null>(null);
  // LinkedIn LISTING expansion ("500+ .NET jobs in Gurgaon" card → the individual jobs, in-place).
  const [expandSrcs, setExpandSrcs] = useState<string[]>([]);   // hidden WebView urls ([] = unmounted)
  const [expandGen, setExpandGen] = useState(0);
  const [expandingUrl, setExpandingUrl] = useState<string | null>(null);   // the listing card being expanded
  const expandReportedRef = useRef<Set<number>>(new Set());
  const expandFoundRef = useRef(0);    // cards actually ADDED to the list (post-dedupe/filter)
  const expandRawRef = useRef(0);      // cards the scrape RETURNED (pre-filter) — scrape worked at all?
  const expandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => { cardsRef.current = cards; }, [cards]);
  useEffect(() => { queryRef.current = query; }, [query]);

  // Persist completed fetches so progress survives app minimize / restart (restored on open, below).
  const persistKey = () => 'live_fetch_v1:' + String(queryRef.current || '').trim().toLowerCase();
  const saveProgress = () => { AsyncStorage.setItem(persistKey(), JSON.stringify({ details: detailsRef.current, fstate: fstateRef.current })).catch(() => {}); };
  const setFetchingBoth = (v: boolean) => { fetchingRef.current = v; setFetching(v); };

  // On-device sources, run on the user's own device/IP for a RICH, real search:
  //  • LinkedIn public guest jobs API — dense, paginated INDIVIDUAL postings (~25/page → ~100 across pages)
  //  • Google + DuckDuckGo-lite web search — breadth (Naukri/Indeed/company career pages)
  // Resolve the searched place to a LinkedIn-recognizable "City, Country" — an UNqualified place ("delhi",
  // "delhi ncr") silently resolves to the WRONG location on LinkedIn (→ Cincinnati). Also yields match-terms
  // so any stray wrong-region card gets dropped in mergeCards.
  const locResolved = useMemo(() => resolveLiveLocation(parseLiveQuery(query).loc), [query]);
  const locRef = useRef(locResolved);
  useEffect(() => { locRef.current = locResolved; }, [locResolved]);

  const webSources = useMemo(() => {
    const q = String(query || '').trim();
    if (!q) return [] as { uri: string; kind: 'li' | 'organic' }[];
    const enc = encodeURIComponent;
    const { kw } = parseLiveQuery(q);
    const liLoc = locResolved.linkedInLocation;   // country-qualified (or '' → LinkedIn's default worldwide)
    const liBase = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=' + enc(buildLinkedInKeywords(kw)) + (liLoc ? '&location=' + enc(liLoc) : '');
    // LinkedIn guest returns ~10 individual postings per page → paginate by 10 for depth (8 pages ≈ 80 postings).
    const sources: { uri: string; kind: 'li' | 'organic' }[] = [0, 10, 20, 30, 40, 50, 60, 70].map((s) => ({ uri: liBase + '&start=' + s, kind: 'li' as const }));
    sources.push({ uri: 'https://www.google.com/search?num=30&hl=en&q=' + enc(q), kind: 'organic' });
    sources.push({ uri: 'https://www.google.com/search?num=30&hl=en&start=10&q=' + enc(q), kind: 'organic' });
    sources.push({ uri: 'https://lite.duckduckgo.com/lite/?q=' + enc(q), kind: 'organic' });
    return sources;
  }, [query, locResolved]);

  const normUrl = (u: string) => { try { const x = new URL(String(u || '')); return (x.origin + x.pathname).replace(/\/+$/, ''); } catch { return String(u || '').split('#')[0].replace(/\/+$/, ''); } };

  // Merge new cards (server grounded OR on-device web) into the list, de-duped by normalized URL; keep
  // already-saved ones at the bottom. Any card arriving flips the modal to the results view.
  // Returns how many cards were actually ADDED (post-dedupe, post-location-filter) — the listing
  // expansion needs the real number, not the raw scrape count.
  const mergeCards = useCallback((incoming: LiveJobCard[]): number => {
    if (!incoming || !incoming.length) return 0;
    const loc = locRef.current;   // drop cards that resolve to a clearly-different country than searched
    const seen = new Set(cardsRef.current.map((c) => normUrl(c.job_url)));
    const add: LiveJobCard[] = [];
    for (const c of incoming) { const k = normUrl(c.job_url); if (c && c.job_url && c.title && !seen.has(k) && locationAllowed(c.location, loc)) { seen.add(k); add.push(c); } }
    if (!add.length) return 0;
    setCards((prev) => {
      const seen2 = new Set(prev.map((c) => normUrl(c.job_url)));   // re-check against prev (batching safety)
      const add2 = add.filter((c) => !seen2.has(normUrl(c.job_url)));
      if (!add2.length) return prev;
      const next = [...prev, ...add2];
      next.sort((a, b) => (a.saved ? 1 : 0) - (b.saved ? 1 : 0));
      cardsRef.current = next;
      return next;
    });
    setPhase('results');
    return add.length;
  }, []);

  // On-device organic (Google/DDG) results → cards (company/location fill in when the user fetches details).
  const toWebCards = (results: { title: string; url: string }[]): LiveJobCard[] => (results || []).map((r) => {
    let host = ''; try { host = new URL(r.url).hostname.replace(/^www\./, ''); } catch {}
    return { id: r.url, job_url: r.url, title: r.title, company: host || null, employer_name: host || null, location: null, work_mode: null, job_type: null, salary: null, experience: null, responsibilities: [], skills: [], source: host || 'web', highlights: [], saved: false, summary: null } as LiveJobCard;
  });
  // LinkedIn guest cards already carry company + location.
  const toLiCards = (results: { title: string; url: string; company?: string; location?: string }[]): LiveJobCard[] => (results || []).map((r) => (
    { id: r.url, job_url: r.url, title: r.title, company: r.company || null, employer_name: r.company || null, location: r.location || null, work_mode: null, job_type: null, salary: null, experience: null, responsibilities: [], skills: [], source: 'linkedin.com', highlights: [], saved: false, summary: null } as LiveJobCard
  ));

  // Only fall to the empty/error state once BOTH the server and the on-device search have finished empty.
  const finishSource = useCallback((which: 'server' | 'web') => {
    if (which === 'server') serverDoneRef.current = true; else webDoneRef.current = true;
    if (serverDoneRef.current && webDoneRef.current) setPhase((p) => (p === 'results' || cardsRef.current.length > 0) ? 'results' : 'error');
  }, []);

  // Each on-device source (LinkedIn page / Google / DDG) reports here by its index; accumulate ALL of them,
  // then finish 'web' once every UNIQUE source has reported (or the safety timeout fires) — so all the
  // LinkedIn pages add up. Index-deduped so a double signal (onMessage + onError) can't end it early.
  const onWebReport = useCallback((idx: number, results: any[], kind: 'li' | 'organic') => {
    if (webReportedRef.current.has(idx)) return;
    webReportedRef.current.add(idx);
    const cards = kind === 'li' ? toLiCards(results) : toWebCards(results);
    if (cards.length) mergeCards(cards);
    if (webReportedRef.current.size >= (webTargetsRef.current || 1)) { setSearchActive(false); finishSource('web'); }
  }, [mergeCards, finishSource]);

  // ── Expand a LinkedIn LISTING card ("500+ jobs…") into its individual postings, in-place ──
  // The public listing page itself carries ~60 job cards in the exact markup LINKEDIN_SCRAPE_JS reads
  // (verified, no login wall); we also paginate the guest API (parsed keywords/location, country-qualified)
  // for extra depth. Results merge into the list; the listing card is then removed.
  const finishExpand = useCallback((listingUrl: string) => {
    if (expandTimerRef.current) { clearTimeout(expandTimerRef.current); expandTimerRef.current = null; }
    setExpandSrcs([]); setExpandingUrl(null);
    if (expandRawRef.current > 0) {
      // Scrape worked → the listing card is redundant now (its jobs were added, or were already in the
      // list / filtered by location) — remove it either way.
      setCards((prev) => { const next = prev.filter((c) => c.job_url !== listingUrl); cardsRef.current = next; return next; });
      setSelected((prev) => { const n = new Set(prev); n.delete(listingUrl); return n; });
    } else {
      Alert.alert('Could not open this list', 'LinkedIn didn’t return the jobs this time — try again, or use another result.');
    }
  }, []);
  const expandListing = useCallback((card: LiveJobCard) => {
    if (expandingUrl) return;   // one expansion at a time
    const listingUrl = card.job_url;
    const srcs: string[] = [listingUrl];
    const parsed = parseLinkedInListing(listingUrl);
    if (parsed && parsed.keywords) {
      const liLoc = resolveLiveLocation(parsed.location).linkedInLocation || parsed.location;
      const base = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=' + encodeURIComponent(parsed.keywords) + (liLoc ? '&location=' + encodeURIComponent(liLoc) : '');
      for (const s of [0, 10, 20, 30, 40, 50]) srcs.push(base + '&start=' + s);
    }
    expandReportedRef.current = new Set(); expandFoundRef.current = 0; expandRawRef.current = 0;
    setExpandingUrl(listingUrl); setExpandGen((g) => g + 1); setExpandSrcs(srcs);
    if (expandTimerRef.current) clearTimeout(expandTimerRef.current);
    expandTimerRef.current = setTimeout(() => finishExpand(listingUrl), 18000);   // safety net
  }, [expandingUrl, finishExpand]);
  const onExpandReport = useCallback((idx: number, results: any[], listingUrl: string, total: number) => {
    if (expandReportedRef.current.has(idx)) return;
    expandReportedRef.current.add(idx);
    const cards = toLiCards(results || []);
    if (cards.length) { expandRawRef.current += cards.length; expandFoundRef.current += mergeCards(cards); }
    if (expandReportedRef.current.size >= total) finishExpand(listingUrl);
  }, [mergeCards, finishExpand]);

  // ── A job fetched from the Browse & Fetch browser → reflect it on the matching card (or add one) ──
  const onBrowseFetched = useCallback((job: LiveJobCard | null, sourceUrl: string) => {
    if (!job) return;
    const k = normUrl(sourceUrl);
    const existing = cardsRef.current.find((c) => normUrl(c.job_url) === k);
    if (existing) {
      detailsRef.current = { ...detailsRef.current, [existing.job_url]: job }; setDetails((d) => ({ ...d, [existing.job_url]: job }));
      fstateRef.current = { ...fstateRef.current, [existing.job_url]: 'done' }; setFstate((s) => ({ ...s, [existing.job_url]: 'done' }));
      setSelected((prev) => { const n = new Set(prev); n.delete(existing.job_url); return n; });   // keep the footer count honest
    } else {
      // Append at the BOTTOM — saved cards sort last, so inserting at the top would visibly jump on the next merge.
      const card: LiveJobCard = { ...job, saved: true };
      setCards((prev) => { const next = [...prev, card]; cardsRef.current = next; return next; });
    }
    saveProgress();
    setPhase('results');
  }, []);

  // ── run the live search when opened ──
  useEffect(() => {
    if (!visible) return;
    setPhase('searching'); setCards([]); cardsRef.current = []; setSelected(new Set());
    setDetails({}); detailsRef.current = {};
    setFstate({}); fstateRef.current = {};
    setFetchingBoth(false); setActiveUrls([]); activeRef.current = new Set(); queueRef.current = [];
    Object.values(timersRef.current).forEach(clearTimeout); timersRef.current = {};
    serverDoneRef.current = false; webDoneRef.current = false; webReportsRef.current = 0;
    webReportedRef.current = new Set(); webTargetsRef.current = webSources.length;
    // reset listing-expansion + browser state from any previous run
    if (expandTimerRef.current) { clearTimeout(expandTimerRef.current); expandTimerRef.current = null; }
    setExpandSrcs([]); setExpandingUrl(null); expandReportedRef.current = new Set(); expandFoundRef.current = 0;
    setBrowseUrl(null);
    // Kick off the on-device web search (hidden WebViews mount below) in PARALLEL with the server search.
    setSearchGen((g) => g + 1); setSearchActive(true);
    let alive = true;
    // Safety net: if some hidden search WebViews never report back (offline / hard block), stop waiting.
    const webTimer = setTimeout(() => { if (alive) { setSearchActive(false); finishSource('web'); } }, 22000);
    (async () => {
      // restore any saved fetch progress for THIS query (survives minimize / app restart)
      try {
        const raw = await AsyncStorage.getItem('live_fetch_v1:' + String(query || '').trim().toLowerCase());
        if (alive && raw) { const p = JSON.parse(raw); if (p && p.details) { detailsRef.current = p.details; setDetails(p.details); } if (p && p.fstate) { fstateRef.current = p.fstate; setFstate(p.fstate); } }
      } catch (_) {}
      try {
        const r = await liveSearchJobs(query);
        if (!alive) return;
        mergeCards(r.cards || []);
      } catch { /* on-device search may still deliver */ }
      finally { if (alive) finishSource('server'); }
    })();
    return () => {
      alive = false; clearTimeout(webTimer); Object.values(timersRef.current).forEach(clearTimeout);
      // Also stop any in-flight listing expansion — its 18s safety timer must not fire (and Alert) after close.
      if (expandTimerRef.current) { clearTimeout(expandTimerRef.current); expandTimerRef.current = null; }
    };
  }, [visible, query]);

  // ── searching animation ──
  useEffect(() => {
    if (phase !== 'searching') return;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [phase, pulse]);

  const toggle = useCallback((url: string) => {
    setSelected((prev) => { const n = new Set(prev); n.has(url) ? n.delete(url) : n.add(url); return n; });
  }, []);
  const selectAll = useCallback(() => {
    // Only INDIVIDUAL jobs that aren't already saved are selectable — listing pages ("500+ jobs…")
    // can't be fetched as one job, they expand or open in the browser instead.
    const selectable = cards.filter((c) => !c.saved && fstateRef.current[c.job_url] !== 'done' && !isListingUrl(c.job_url)).map((c) => c.job_url);
    setSelected((prev) => (prev.size === selectable.length && selectable.length > 0) ? new Set() : new Set(selectable));
  }, [cards]);

  // ── fetch selected cards, up to CONCURRENCY at a time, via hidden on-device WebViews ──
  const PAGE_TIMEOUT = 28000;   // allow up to a 13s bot-challenge wait (GRAB_JS) + backend extraction
  // Fill open slots from the queue (mounts a hidden WebView per active url).
  function pump() {
    while (activeRef.current.size < CONCURRENCY && queueRef.current.length) {
      const u = queueRef.current.shift() as string;
      activeRef.current.add(u);
      fstateRef.current = { ...fstateRef.current, [u]: 'fetching' };
      setFstate((s) => ({ ...s, [u]: 'fetching' }));
      timersRef.current[u] = setTimeout(() => finish(u, false), PAGE_TIMEOUT);
    }
    setActiveUrls([...activeRef.current]);
    if (activeRef.current.size === 0 && queueRef.current.length === 0) {
      setFetchingBoth(false);
      // Batch finished → tell the user (fires even if they'd minimized and just returned).
      const batch = batchRef.current;
      if (batch.length) {
        const done = batch.filter((u) => fstateRef.current[u] === 'done').length;
        notifyLocal('Live jobs fetched', `${done} of ${batch.length} job${batch.length > 1 ? 's' : ''} saved — find them in Saved Jobs.`, { type: 'live_fetch_done', query: queryRef.current });
        batchRef.current = [];
      }
    }
  }
  // Resolve one url (done or failed), persist, and pull the next from the queue.
  function finish(url: string, ok: boolean, job?: LiveJobCard | null) {
    if (!activeRef.current.has(url)) return;   // already handled
    if (timersRef.current[url]) { clearTimeout(timersRef.current[url]); delete timersRef.current[url]; }
    activeRef.current.delete(url);
    // One automatic retry before giving up (a fresh WebView — key includes the retry count — reloads the
    // page; handles SPA/timing misses that failed the first pass).
    if (!ok && (retryRef.current[url] || 0) < 1) {
      retryRef.current[url] = (retryRef.current[url] || 0) + 1;
      queueRef.current.unshift(url);
      pump();
      return;
    }
    let st: FetchState = 'failed';
    if (ok && job) {
      detailsRef.current = { ...detailsRef.current, [url]: job }; setDetails((d) => ({ ...d, [url]: job }));
      st = 'done';
    } else {
      // Enrichment failed after the retry → still SAVE the basic card so EVERY selected job lands in
      // Saved Jobs (title/company/location/link we already have from the search).
      const basic = cardsRef.current.find((c) => c.job_url === url);
      if (basic) { saveCard(basic).catch(() => {}); st = 'done'; }
    }
    fstateRef.current = { ...fstateRef.current, [url]: st };
    setFstate((s) => ({ ...s, [url]: st }));
    saveProgress();
    pump();
  }
  function startFetch() {
    const urls = cardsRef.current.filter((c) => !c.saved).map((c) => c.job_url).filter((u) => selected.has(u) && fstateRef.current[u] !== 'done');
    if (!urls.length) return;
    queueRef.current = urls;
    batchRef.current = urls.slice();
    setFetchingBoth(true);
    pump();
  }
  // Out of credits mid-batch → stop everything and tell the user.
  function stopForCredits(remaining?: number) {
    queueRef.current = [];
    Object.values(timersRef.current).forEach(clearTimeout); timersRef.current = {};
    activeRef.current = new Set(); setActiveUrls([]);
    setFetchingBoth(false);
    Alert.alert('Not enough credits', `Fetching a job costs ${fetchCost || 1} credit${(fetchCost || 1) === 1 ? '' : 's'} each. You have ${remaining ?? 0}. Top up in Account → Credits.`);
  }
  async function onGrab(sourceUrl: string, raw: string) {
    let payload: any = null; try { payload = JSON.parse(raw); } catch { return; }
    if (!payload || !payload.__cvd) return;
    if (!activeRef.current.has(sourceUrl)) return;   // stale / already finished
    if (timersRef.current[sourceUrl]) { clearTimeout(timersRef.current[sourceUrl]); delete timersRef.current[sourceUrl]; }
    const card = cardsRef.current.find((c) => c.job_url === sourceUrl);
    try {
      const job = await fetchJobDetail(sourceUrl, String(payload.html || ''), card?.company || card?.employer_name || '');
      finish(sourceUrl, !!job, job || null);
    } catch (e: any) {
      if (e && e.insufficient) { stopForCredits(e.creditsRemaining); return; }
      finish(sourceUrl, false, null);
    }
  }

  // Keep fetching alive across app minimize/restore: iOS pauses background WebViews & timers, so on return
  // we re-arm timers and REMOUNT the in-flight WebViews (webGen bump) to resume the scrape, then keep pumping.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') {
        if (fetchingRef.current && (activeRef.current.size > 0 || queueRef.current.length > 0)) {
          activeRef.current.forEach((u) => {
            if (timersRef.current[u]) clearTimeout(timersRef.current[u]);
            timersRef.current[u] = setTimeout(() => finish(u, false), PAGE_TIMEOUT);
          });
          setWebGen((g) => g + 1);
          pump();
        }
      } else {
        Object.values(timersRef.current).forEach(clearTimeout);
        timersRef.current = {};   // don't let suspended time count as timeouts
      }
    });
    return () => sub.remove();
  }, []);

  const doneCount = Object.values(fstate).filter((s) => s === 'done').length;

  const renderCard = ({ item }: { item: LiveJobCard }) => {
    const st = fstate[item.job_url] || 'idle';
    const locked = !!item.saved || st === 'done';   // already saved (prior session) or fetched this session
    const isSel = !locked && selected.has(item.job_url);
    const det = details[item.job_url];
    const highlights = (det?.responsibilities?.length ? det.responsibilities : item.highlights) || [];

    // LISTING card ("500+ .NET jobs in Gurgaon") — many jobs behind one link, so it can't be fetched as
    // one job. LinkedIn lists expand into individual cards right here; other boards open in the in-app
    // browser where the floating "Fetch job" bubble captures whichever job the user opens.
    if (isListingUrl(item.job_url)) {
      const isLi = /linkedin\.com/i.test(item.job_url);
      const count = listingCountFromTitle(item.title);
      const busy = expandingUrl === item.job_url;
      const act = () => { if (busy) return; if (isLi) expandListing(item); else setBrowseUrl(item.job_url); };
      return (
        <TouchableOpacity activeOpacity={0.85} onPress={act} style={[styles.card, styles.cardListing]}>
          <View style={styles.cardTop}>
            <View style={styles.listIcon}><Ionicons name="albums-outline" size={14} color="#7C3AED" /></View>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle} numberOfLines={3}>{item.title}</Text>
              <View style={styles.listBadgeRow}>
                <View style={styles.listBadge}><Text style={styles.listBadgeTx}>{count ? `List · ${count} jobs` : 'List of jobs'}</Text></View>
                <Text style={styles.srcTx}>{item.source || 'web'}</Text>
              </View>
            </View>
          </View>
          <View style={styles.listActionRow}>
            <LinearGradient colors={busy ? ['#CBD5E1', '#CBD5E1'] : ['#7C3AED', '#6D28D9']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.listActionBtn}>
              {busy
                ? <><ActivityIndicator size="small" color="#fff" /><Text style={styles.listActionTx}>Opening the jobs…</Text></>
                : <><Ionicons name={isLi ? 'list' : 'globe-outline'} size={14} color="#fff" /><Text style={styles.listActionTx}>{isLi ? 'Show these jobs' : 'Browse & pick jobs'}</Text></>}
            </LinearGradient>
          </View>
        </TouchableOpacity>
      );
    }

    return (
      <TouchableOpacity activeOpacity={locked ? 1 : 0.85} onPress={() => { if (!locked) toggle(item.job_url); }} style={[styles.card, isSel && styles.cardSel, locked && styles.cardSaved]}>
        <View style={styles.cardTop}>
          {locked
            ? <View style={styles.savedIcon}><Ionicons name="bookmark" size={13} color="#059669" /></View>
            : <View style={[styles.check, isSel && styles.checkOn]}>{isSel && <Ionicons name="checkmark" size={13} color="#fff" />}</View>}
          <View style={{ flex: 1 }}>
            <Text style={styles.cardTitle} numberOfLines={3}>{det?.title || item.title}</Text>
            <Text style={styles.cardCompany} numberOfLines={2}>{det?.company || item.company || item.employer_name || 'Employer'}</Text>
            {!!(det?.location || item.location) && (
              <View style={styles.cardLocRow}>
                <Ionicons name="location-outline" size={11} color="#94A3B8" style={{ marginTop: 1 }} />
                <Text style={styles.cardLoc} numberOfLines={2}>{det?.location || item.location}</Text>
              </View>
            )}
          </View>
          {locked && <View style={styles.badgeDone}><Ionicons name="checkmark-circle" size={12} color="#059669" /><Text style={styles.badgeDoneTx}>Saved</Text></View>}
          {!locked && st === 'fetching' && <ActivityIndicator size="small" color="#06B6D4" />}
          {!locked && st === 'failed' && <Ionicons name="alert-circle-outline" size={16} color="#F59E0B" />}
        </View>
        {(det || highlights.length > 0) && (
          <View style={styles.cardBody}>
            {!!det && (
              <View style={styles.metaRow}>
                {!!det.job_type && <Text style={styles.metaPill}>{det.job_type}</Text>}
                {!!det.work_mode && <Text style={styles.metaPill}>{det.work_mode}</Text>}
                {!!det.salary && <Text style={styles.metaPill}>{det.salary}</Text>}
              </View>
            )}
            {highlights.slice(0, det ? 4 : 2).map((h, i) => (
              <Text key={i} style={styles.highlight} numberOfLines={2}>• {String(h).replace(/<[^>]+>/g, '')}</Text>
            ))}
            {!!det?.skills?.length && <Text style={styles.skills} numberOfLines={1}>{det.skills.slice(0, 6).join(' · ')}</Text>}
          </View>
        )}
        <View style={styles.srcRow}>
          <Ionicons name="globe-outline" size={11} color="#94A3B8" />
          <Text style={styles.srcTx}>{item.source || 'web'}</Text>
          {item.saved ? <Text style={[styles.tapHint, { color: '#059669' }]}>already in Saved Jobs</Text> : (st === 'idle' && <Text style={styles.tapHint}>tap to select</Text>)}
          <View style={{ flex: 1 }} />
          {/* Open the page in the in-app browser (verify it's the right job / fetch it from there with the
              floating bubble). LinkedIn postings excluded — they wall the visible browser; fetch handles them. */}
          {!/linkedin\.com/i.test(item.job_url) && (
            <TouchableOpacity onPress={() => setBrowseUrl(item.job_url)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} style={styles.previewBtn}>
              <Ionicons name="open-outline" size={12} color="#2563EB" />
              <Text style={styles.previewTx}>Open</Text>
            </TouchableOpacity>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.18] });
  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] });
  const selCount = selected.size;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} transparent>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          {/* header */}
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={styles.hTitle}>Live jobs on the web</Text>
              <Text style={styles.hSub} numberOfLines={1}>“{query}”</Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={24} color="#64748B" />
            </TouchableOpacity>
          </View>

          {phase === 'searching' && (
            <View style={styles.center}>
              <Animated.View style={{ transform: [{ scale }], opacity }}>
                <LinearGradient colors={['#06B6D4', '#3B82F6']} style={styles.pulseCircle}>
                  <Ionicons name="search" size={30} color="#fff" />
                </LinearGradient>
              </Animated.View>
              <Text style={styles.searchingTx}>Searching the live web…</Text>
              <Text style={styles.searchingSub}>Finding real, current openings and formatting them for you.</Text>
            </View>
          )}

          {phase === 'error' && (
            <View style={styles.center}>
              <Ionicons name="cloud-offline-outline" size={40} color="#CBD5E1" />
              <Text style={styles.searchingTx}>No live results right now</Text>
              <Text style={styles.searchingSub}>Try a broader search, or check your feed — it may already have matches.</Text>
              <TouchableOpacity style={styles.retryBtn} onPress={onClose}><Text style={styles.retryTx}>Close</Text></TouchableOpacity>
            </View>
          )}

          {phase === 'results' && (
            <>
              <View style={styles.subBar}>
                <Text style={styles.subBarTx}>{cards.length} found{doneCount ? ` · ${doneCount} fetched` : ''}</Text>
                <TouchableOpacity onPress={selectAll}><Text style={styles.selAll}>{selected.size === cards.length ? 'Clear' : 'Select all'}</Text></TouchableOpacity>
              </View>
              <FlatList
                data={cards}
                keyExtractor={(c) => c.job_url}
                renderItem={renderCard}
                contentContainerStyle={{ padding: 14, paddingBottom: 100 }}
                showsVerticalScrollIndicator={false}
              />
              <View style={styles.footer}>
                <TouchableOpacity disabled={!selCount || fetching} activeOpacity={0.85} onPress={startFetch} style={{ flex: 1 }}>
                  <LinearGradient colors={(!selCount || fetching) ? ['#CBD5E1', '#CBD5E1'] : ['#06B6D4', '#3B82F6']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.fetchBtn}>
                    {fetching
                      ? <><ActivityIndicator size="small" color="#fff" /><Text style={styles.fetchTx}>Fetching… {doneCount ? `(${doneCount} done)` : ''}</Text></>
                      : <><Ionicons name="download-outline" size={18} color="#fff" /><Text style={styles.fetchTx}>{selCount ? `Fetch details (${selCount})${fetchCost > 0 ? ` · ${selCount * fetchCost} cr` : ''}` : 'Select jobs to fetch'}</Text></>}
                  </LinearGradient>
                </TouchableOpacity>
              </View>
            </>
          )}

          {/* hidden on-device SEARCH — LinkedIn public guest jobs (dense individual postings, paginated) +
              Google/DDG (breadth), all on the user's own IP → rich worldwide results, no server bot wall. */}
          {searchActive && webSources.map((s, i) => (
            <View key={searchGen + '|w|' + i} style={styles.hiddenWeb} pointerEvents="none">
              <WebView
                source={{ uri: s.uri }}
                injectedJavaScript={s.kind === 'li' ? LINKEDIN_SCRAPE_JS : SEARCH_SCRAPE_JS}
                onMessage={(e) => { try { const d = JSON.parse(e.nativeEvent.data); if (d && d.__cvli) onWebReport(i, Array.isArray(d.results) ? d.results : [], 'li'); else if (d && d.__cvsr) onWebReport(i, Array.isArray(d.results) ? d.results : [], 'organic'); } catch {} }}
                onError={() => onWebReport(i, [], s.kind)}
                onHttpError={() => onWebReport(i, [], s.kind)}
                userAgent={MOBILE_UA}
                javaScriptEnabled
                domStorageEnabled
                originWhitelist={['*']}
              />
            </View>
          ))}

          {/* hidden LISTING-EXPANSION scrapers — the tapped LinkedIn list page + guest-API pages; each
              merges its individual postings into the results. */}
          {expandingUrl && expandSrcs.map((s, i) => (
            <View key={expandGen + '|x|' + i} style={styles.hiddenWeb} pointerEvents="none">
              <WebView
                source={{ uri: s }}
                injectedJavaScript={LINKEDIN_SCRAPE_JS}
                onMessage={(e) => { try { const d = JSON.parse(e.nativeEvent.data); if (d && d.__cvli) onExpandReport(i, Array.isArray(d.results) ? d.results : [], expandingUrl, expandSrcs.length); } catch {} }}
                onError={() => onExpandReport(i, [], expandingUrl, expandSrcs.length)}
                onHttpError={() => onExpandReport(i, [], expandingUrl, expandSrcs.length)}
                userAgent={MOBILE_UA}
                javaScriptEnabled
                domStorageEnabled
                originWhitelist={['*']}
              />
            </View>
          ))}

          {/* hidden on-device fetchers — up to CONCURRENCY pages at once, on the user's IP.
              Keyed by webGen so an AppState resume remounts them (iOS pauses background WebViews). */}
          {activeUrls.map((url) => (
            <View key={webGen + '|' + (retryRef.current[url] || 0) + '|' + url} style={styles.hiddenWeb} pointerEvents="none">
              <WebView
                source={{ uri: fetchSourceUrl(url) }}
                injectedJavaScript={GRAB_JS}
                onMessage={(e) => onGrab(url, e.nativeEvent.data)}
                userAgent={MOBILE_UA}
                javaScriptEnabled
                domStorageEnabled
                originWhitelist={['*']}
              />
            </View>
          ))}
        </View>
      </View>

      {/* Browse & Fetch — visible in-app browser (non-LinkedIn lists + "Open" on any card): browse like a
          human, open a job, tap the draggable "Fetch job" bubble to save it into CVApplyr. */}
      <BrowseFetch
        visible={!!browseUrl}
        url={browseUrl || 'about:blank'}
        fetchCost={fetchCost}
        onClose={() => setBrowseUrl(null)}
        onFetched={onBrowseFetched}
      />
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(6,10,25,0.55)', justifyContent: 'flex-end' },
  sheet: { height: Math.min(SH * 0.9, 800), backgroundColor: '#F0F4FA', borderTopLeftRadius: 26, borderTopRightRadius: 26, overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingTop: 18, paddingBottom: 12, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#EEF2F7' },
  hTitle: { fontSize: 18, fontWeight: '800', color: '#0F172A', letterSpacing: -0.4 },
  hSub: { fontSize: 12.5, color: '#64748B', marginTop: 2 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 },
  pulseCircle: { width: 76, height: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center' },
  searchingTx: { fontSize: 16, fontWeight: '700', color: '#0F172A', marginTop: 22 },
  searchingSub: { fontSize: 13, color: '#64748B', marginTop: 6, textAlign: 'center', lineHeight: 19 },
  retryBtn: { marginTop: 18, paddingHorizontal: 22, paddingVertical: 10, borderRadius: 12, backgroundColor: '#E2E8F0' },
  retryTx: { fontSize: 14, fontWeight: '700', color: '#334155' },
  subBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 2 },
  subBarTx: { fontSize: 12.5, fontWeight: '700', color: '#475569' },
  selAll: { fontSize: 12.5, fontWeight: '700', color: '#06B6D4' },
  card: { backgroundColor: '#fff', borderRadius: 18, padding: 14, marginBottom: 10, borderWidth: 1.5, borderColor: '#fff' },
  cardSel: { borderColor: '#06B6D4', backgroundColor: '#F7FEFF' },
  cardListing: { borderColor: '#EDE9FE', backgroundColor: '#FDFCFF' },
  listIcon: { width: 22, height: 22, borderRadius: 7, backgroundColor: '#F3E8FF', marginRight: 11, marginTop: 1, alignItems: 'center', justifyContent: 'center' },
  listBadgeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 5 },
  listBadge: { backgroundColor: '#F3E8FF', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  listBadgeTx: { fontSize: 10.5, fontWeight: '800', color: '#7C3AED' },
  listActionRow: { marginTop: 10, marginLeft: 33 },
  listActionBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, height: 38, borderRadius: 12 },
  listActionTx: { fontSize: 13, fontWeight: '800', color: '#fff' },
  previewBtn: { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: '#EFF6FF', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3.5 },
  previewTx: { fontSize: 10.5, fontWeight: '800', color: '#2563EB' },
  cardSaved: { backgroundColor: '#F8FAFC', borderColor: '#ECFDF5', opacity: 0.7 },
  savedIcon: { width: 22, height: 22, borderRadius: 7, backgroundColor: '#ECFDF5', marginRight: 11, marginTop: 1, alignItems: 'center', justifyContent: 'center' },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start' },
  check: { width: 22, height: 22, borderRadius: 7, borderWidth: 1.6, borderColor: '#CBD5E1', marginRight: 11, marginTop: 1, alignItems: 'center', justifyContent: 'center' },
  checkOn: { backgroundColor: '#06B6D4', borderColor: '#06B6D4' },
  cardTitle: { fontSize: 14.5, fontWeight: '800', color: '#0F172A', letterSpacing: -0.3 },
  cardCompany: { fontSize: 12.5, color: '#334155', fontWeight: '600', marginTop: 3 },
  cardLocRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 3, marginTop: 3 },
  cardLoc: { flex: 1, fontSize: 12, color: '#64748B', lineHeight: 16 },
  badgeDone: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#ECFDF5', paddingHorizontal: 7, paddingVertical: 3, borderRadius: 8, gap: 3 },
  badgeDoneTx: { fontSize: 10.5, fontWeight: '700', color: '#059669' },
  cardBody: { marginTop: 10, marginLeft: 33 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 },
  metaPill: { fontSize: 11, fontWeight: '600', color: '#0369A1', backgroundColor: '#E0F2FE', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, overflow: 'hidden' },
  highlight: { fontSize: 12, color: '#475569', lineHeight: 17, marginTop: 1 },
  skills: { fontSize: 11.5, color: '#7C3AED', marginTop: 6, fontWeight: '600' },
  srcRow: { flexDirection: 'row', alignItems: 'center', marginTop: 9, marginLeft: 33, gap: 4 },
  srcTx: { fontSize: 10.5, color: '#94A3B8', fontWeight: '600' },
  tapHint: { fontSize: 10.5, color: '#CBD5E1', marginLeft: 8 },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 14, backgroundColor: 'rgba(240,244,250,0.96)', borderTopWidth: 1, borderTopColor: '#E2E8F0' },
  fetchBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 52, borderRadius: 16, gap: 8 },
  fetchTx: { fontSize: 15.5, fontWeight: '800', color: '#fff' },
  hiddenWeb: { position: 'absolute', width: 1, height: 1, left: -4000, top: -4000, opacity: 0 },
});
