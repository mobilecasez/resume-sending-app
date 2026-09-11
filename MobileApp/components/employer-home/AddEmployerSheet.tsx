// AI Hub — new feature. Safe to delete without affecting existing app.
//
// "Add employer" — the bottom sheet behind the + at the end of the employer row.
//
// Type an employer's name and we look up their WEBSITE: each result is the company and its site, and
// picking one hands both to the Job Hub's existing add flow. A pasted website works too, and region
// narrows the lookup.
//
// ⚠️ A WEBSITE IS REQUIRED — A NAME ALONE IS NOT ENOUGH. The resume and the letter are tailored by
// researching the employer, and a bare name gave the builder nothing to research. This is the user's
// own requirement ("for resume building or cover letter building we need the website"), so no way
// out of this sheet carries a name without a site. When the lookup finds none, the sheet says so and
// asks for the site right there, inline. When the lookup could not run, it says THAT, and never
// that no website exists.
//
// ⚠️ A JOB POSTING IS NEVER A SUBSTITUTE FOR THE WEBSITE — the user was explicit. "Building for a
// specific job?" is always on screen and is extra context ON TOP OF an employer. Nothing here tells
// anyone to add a posting instead of the site, and a job link pasted where the site goes is moved
// into that box rather than accepted as the site.
//
// ⚠️ IT DELIBERATELY DOES NOT ADD THE EMPLOYER ITSELF. Adding one costs the user credits
// (app/(ai-hub)/index.tsx handleAddPill: a `company_search` cost precheck, then fetchJobMatches
// followed by deductSearchCredits), and that path also carries job-portal detection, LinkedIn URL
// handling, in-flight recovery across app restarts and the server's own error messages. Rebuilding
// any of that here would fork a MONEY path in two, so this sheet does only the free half —
// finding the employer, which costs nothing — and hands the chosen website to the one audited flow.
//
// ⚠️ AN EMPLOYER IS NOT A ROW IN OUR JOBS INDEX. This sheet used to "search" by running a JOB search
// and deduping the companies out of the rows, so an employer existed only if we had already crawled
// one of their postings. Measured: "Nordex" returned NOTHING at all, and "Siemens" returned the
// staffing agencies that repost their roles rather than Siemens. So the lookup asks the employer
// endpoint, which looks the site up whether or not we hold a single posting.
//
// ⚠️ NO WEBSITE IS EVER DERIVED FROM A JOB ROW ON THIS SIDE. The sheet once fell back to the job feed
// and read `employer_domain` as the site — but that is the host of the POSTING, and on production 73%
// of employers with any domain sit on a shared job host (arbetsformedlingen.se alone carries 4,014),
// so it offered job-room.ch or reed.co.uk as "their website". The server vets rows against the full
// board and ATS lists; when it cannot answer, the sheet says the lookup is unavailable and asks.
//
// ⚠️ EVERYTHING IN HERE STAYS FREE. The employer lookup is a read, a website only hands a string on,
// and the pasted listing is prompt context — none of it generates, and none of it deducts. Anything
// that costs belongs behind the Job Hub's audited add flow, above.
//
// ⚠️ ANIMATION DRIVER RULE (b126-128): transform/opacity, native driver, one tree.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Modal, TouchableOpacity, TextInput, ScrollView,
  ActivityIndicator, Animated, Easing, Keyboard, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';
import { E } from './theme';
import { API_BASE } from '../../config';
import { fetchCountryOptions } from '../../services/interestsService';
import { track } from '../../services/analytics';

// One employer, recognisable: its name, the website we will research (`domain`, a bare host), and —
// when known — where it hires and how many postings we hold. `source` says how solid the row is:
// 'tracked' is an employer this app already follows, 'web' was looked up for this search, and
// 'jobs' was only inferred from postings we happened to crawl.
export type EmployerHit = {
  name: string; domain: string; location: string | null; jobs: number;
  source: 'tracked' | 'jobs' | 'web';
};

/** What the sheet hands on. `website` is always `https://host`, the same string as `value`. */
export type EmployerPick = {
  /** The employer's name when we know it: a result's title, or the name they searched for. */
  name?: string;
  website: string;
  country?: string;
  jobUrl?: string;
  jobText?: string;
};

// Whether the server's website lookup actually ran. ⚠️ 'unavailable' is NOT "no website exists" —
// it means we never got to ask, and the sheet has to say it in those words. ⚠️ 'degraded' (the
// answer came from a fallback provider) is read EXACTLY like 'unavailable' for that claim: its rows
// are shown, but an empty degraded answer never tells anyone a website does not exist.
type WebsiteLookup = 'ok' | 'unavailable' | 'degraded';

// ⚠️ "Dr.Oetker" IS A NAME. "A dot followed by letters" used to count as a web address, so the lookup
// was skipped and the sheet offered "Use this website · dr.oetker" — https://dr.oetker, a site that
// does not exist. Without a scheme or a leading "www.", input is address-like only when its last
// label is a TLD we recognise.
const TLDS = new Set((
  'com net org io co ai app dev info biz me tv xyz tech online site cloud jobs careers group global '
  + 'de fr se uk nl ch at it es in au jp us eu ca be dk no fi pl pt ie lu li is cz sk hu ro bg gr hr '
  + 'si ee lv lt tr il ae sa qa sg hk tw kr cn nz za br mx ar cl my ph id th vn pk ng ke eg ma ua'
).split(' '));

/**
 * 'url'   — unmistakably an address ("https://…", "www.…", "acme.com/careers"): nothing to look up.
 * 'maybe' — a bare dotted token ending in a real TLD. "booking.com" is a website AND what people call
 *           the company, so the name lookup runs AND the "Use this website" row shows.
 * 'name'  — everything else, "Dr.Oetker" and "St. Gallen" included.
 */
function inputKind(raw: string): 'url' | 'maybe' | 'name' {
  const v = String(raw || '').trim().toLowerCase();
  if (/^https?:\/\//.test(v) || /^www\./.test(v)) return 'url';
  const head = v.split(/[/?#]/)[0];
  const host = head.replace(/\.$/, '');
  if (/\s/.test(host) || !host.includes('.')) return 'name';
  const tld = host.slice(host.lastIndexOf('.') + 1);
  if (!TLDS.has(tld) && !/^xn--[a-z0-9-]+$/.test(tld)) return 'name';
  return v.length > head.length + 1 ? 'url' : 'maybe';   // a path after the host settles it
}
const hostOf = (website: string) => website.replace(/^https:\/\//, '');

// What a search ASKED for. Region is part of it because "we could not find a website" is a claim
// about one search: the same name can come back empty in Norway and full in Germany.
const askedKey = (term: string, ctry: string) => `${term.toLowerCase()}\u0000${ctry}`;

// ⚠️ A JOB LINK IS NOT THE EMPLOYER'S WEBSITE. Cutting a URL down to https://host is right for a
// careers page (careers.nordex-online.com is still Nordex) and exactly wrong for a posting hosted by
// somebody else: linkedin.com/jobs/view/… would become "https://www.linkedin.com", and the builder
// would research LinkedIn — on the user's credits. Job boards, public employment services and
// applicant-tracking vendors all put other companies' jobs on THEIR domain (bolt.pinpointhq.com is
// Pinpoint, not Bolt), so a subdomain of one, or any page on one, is somebody else's.
// ⚠️ BUT THE BARE DOMAIN IS THE COMPANY ITSELF. LinkedIn and Indeed hire too, and checking the apex
// against the board list stranded anyone applying TO them: their row was dropped, the sheet said "We
// couldn't find a website for LinkedIn", and typing linkedin.com was called a job link. So a
// subdomain other than www is refused on every one of these hosts, and a path only where it is
// that is not one of the board's own pages (see BOARD_SELF_PATH). For a multi-label entry (go.talentech.io,
// recruit.visma.com, an Oracle fa.<dc>.oraclecloud.com pod) the whole entry is the apex.
//
// ⚠️ AGGREGATOR_HOSTS AND ATS_HOSTS ARE VERBATIM COPIES of the server's lists in
// server/services/applyUrlResolver.js — same entries, same spelling, same order. When the client kept
// its own shorter list, a pasted web103.reachmee.com posting was accepted here as an employer's
// website while the server refused that host. A test fails when the copies diverge: add a host on the
// server first, then paste it here. Anything client-only goes in CLIENT_BOARDS / CLIENT_ATS instead.
const AGGREGATOR_HOSTS = [
  'arbetsformedlingen.se', 'arbeitsagentur.de', 'job-room.ch', 'jobs.ch', 'jobup.ch',
  'werkenbijdeoverheid.nl', 'pole-emploi.fr', 'francetravail.fr', 'sepe.es', 'nav.no',
  'jobnet.dk', 'te-palvelut.fi', 'tyomarkkinatori.fi', 'jobsplus.gov.mt',
  'indeed.com', 'linkedin.com', 'glassdoor.com', 'monster.com', 'stepstone.de', 'stepstone.com',
  'totaljobs.com', 'reed.co.uk', 'seek.com.au', 'naukri.com', 'yourfirm.de', 'xing.com',
  'jooble.org', 'adzuna.com', 'careerjet.com', 'neuvoo.com', 'talent.com', 'jobrapido.com',
  'simplyhired.com', 'ziprecruiter.com', 'glassdoor.co.uk', 'irishjobs.ie', 'jobsite.co.uk',
  'easyapply.jobs', 'aplitrak.com', 'go.talentech.io',
];
const ATS_HOSTS = [
  'greenhouse.io', 'lever.co', 'ashbyhq.com', 'myworkdayjobs.com', 'smartrecruiters.com',
  'personio.com', 'personio.de', 'recruitee.com', 'workable.com', 'teamtailor.com',
  'bamboohr.com', 'jobvite.com', 'successfactors.com', 'successfactors.eu', 'icims.com',
  'taleo.net', 'join.com', 'pinpointhq.com', 'talentadore.com', 'hrmdirect.com',
  'applytojob.com', 'breezy.hr', 'jazzhr.com', 'rippling.com', 'ashby.hq',
  'varbi.com', 'reachmee.com', 'jobylon.com', 'ponty-system.se', 'recman.page', 'hr-manager.net',
  'cruitive.com', 'workspacerecruit.com', 'vismatalent.com',
  'recruit.visma.com',
  'softgarden.io', 'avature.net', 'myworkdaysite.com', 'dvinci-hr.com', 'eightfold.ai',
  'csod.com',
  'smrtr.io',
  'fa.em2.oraclecloud.com', 'fa.ocs.oraclecloud.com', 'fa.us6.oraclecloud.com', 'fa.us2.oraclecloud.com',
  'fa.ca3.oraclecloud.com',
];
// Client-only, as regex source: the other national spellings of the big boards, two boards the server
// does not list, and every Oracle Fusion datacentre — the server's suffix match cannot wildcard that
// label, so a pod in a datacentre it has not seen yet would otherwise pass as an employer's site.
const BOARD_TLD = '(?:com|[a-z]{2}|co\\.[a-z]{2}|com\\.[a-z]{2})';   // indeed.co.uk, glassdoor.de, seek.co.nz
const CLIENT_BOARDS = [
  `(?:indeed|glassdoor|stepstone|monster|seek|adzuna|careerjet|jobrapido)\\.${BOARD_TLD}`,
  'foundit\\.in', 'wellfound\\.com',
];
const CLIENT_ATS = ['fa\\.[a-z0-9-]+\\.oraclecloud\\.com'];
const hostRe = (alts: string[]) => new RegExp(`(?:^|\\.)(${alts.join('|')})$`);
const esc = (hosts: string[]) => hosts.map((h) => h.replace(/\./g, '\\.'));
const BOARD_HOST = hostRe([...CLIENT_BOARDS, ...esc(AGGREGATOR_HOSTS)]);
const JOB_HOST = hostRe([...CLIENT_BOARDS, ...CLIENT_ATS, ...esc(AGGREGATOR_HOSTS), ...esc(ATS_HOSTS)]);
// ⚠️ REDIRECTORS HAVE NO PAGES OF THEIR OWN. They sit in the server's aggregator list, but every path
// on them is a tracking link to one posting (easyapply.jobs/r/<id>, go.talentech.io/<code>), so none
// of them gets the board's "keep the apex" treatment below.
const LINK_ONLY = new Set(['easyapply.jobs', 'aplitrak.com', 'go.talentech.io']);
// What a posting (or a job search) looks like on a board's own apex. Lowercased input, so jobId= is
// jobid=; /jobs also covers /jobs/view. ⚠️ ONLY THIS SHAPE IS REFUSED: someone applying TO LinkedIn
// or Indeed pastes linkedin.com/company/x or indeed.com/?from=gnav from the address bar, and calling
// that a job link moved a page that is not a posting into "the specific job".
/**
 * ⚠️ AN ALLOWLIST OF THE BOARD'S OWN PAGES, NOT A DENYLIST OF POSTING SHAPES. The first version listed
 * posting shapes (/jobs, /viewjob, /rc/clk …) and a review immediately found two it missed —
 * glassdoor.com/job-listing/…-JV_IC123.htm and jobs.ch/en/vacancies/detail/123/ both came back as "the
 * employer's website". Every board invents its own URL scheme, so a list of shapes is always one board
 * behind. The set of pages that genuinely mean "this job board's OWN site" is tiny and stable: the bare
 * domain, /about, /home, /feed, a locale root. Everything deeper is a posting OR — just as wrong —
 * ANOTHER company's page: linkedin.com/company/nordex is Nordex's LinkedIn profile, and taking it as
 * LinkedIn's website would send the builder to research LinkedIn for someone applying to Nordex.
 */
const BOARD_SELF_PATH = /^\/?(?:(?:[a-z]{2}(?:[-_][a-z]{2})?)\/?)?(?:about(?:-?us)?|home|feed|company-info)?\/?$/;
/** A job key anywhere in the query — including prefixed forms like Indeed's `vjk=`. */
const JOB_QUERY = /[?&#;][a-z_]*(?:jk|jobid|job_id|jobkey|gh_jid|currentjobid|vacancyid|postingid)=/i;

type Vetted = { ok: true; website: string } | { ok: false; why: 'invalid' | 'job_link' };

/**
 * Anything typed, pasted or returned as a website → `https://host`, the one form handed on. Takes
 * "nordex-online.com", "www.nordex-online.com" or a full URL. The path is dropped on purpose: the
 * builder researches the employer's SITE, not one page of it.
 */
function vetWebsite(raw: string): Vetted {
  const v = String(raw || '').trim().toLowerCase().replace(/^https?:\/\//, '');
  const head = v.split(/[/?#]/)[0];
  const host = head.replace(/\.$/, '');
  const bare = host.replace(/^www\./, '');
  // At least two labels after any "www." and a letters-only TLD, which rules out a bare name,
  // "www.nordex", localhost, an IP address, "jobs@company.com", and anything with a space or a port.
  const plausible = bare.length <= 253 && bare.includes('.')
    && /^(?:[a-z0-9\u00a1-\uffff](?:[a-z0-9\u00a1-\uffff-]{0,61}[a-z0-9\u00a1-\uffff])?\.)+(?:[a-z\u00a1-\uffff]{2,63}|xn--[a-z0-9-]{1,59})$/.test(host);
  if (!plausible) return { ok: false, why: 'invalid' };
  const shared = bare.match(JOB_HOST);
  if (shared) {
    const rest = v.slice(head.length);
    // A lone trailing "/" is not a path. ⚠️ An ATS vendor's apex keeps refusing ANY path: join.com
    // and smrtr.io put postings straight on the apex with no posting shape to recognise, and a wrong
    // "yes" there sends the builder to research the vendor on the user's credits.
    const board = BOARD_HOST.test(shared[1]) && !LINK_ONLY.has(shared[1]);
    const path = rest.split(/[?#]/)[0];
    const refusedPath = /[/?#]./.test(rest)
      && (!board || !BOARD_SELF_PATH.test(path) || JOB_QUERY.test(rest));
    if (bare !== shared[1] || refusedPath) return { ok: false, why: 'job_link' };
  }
  return { ok: true, website: `https://${host}` };
}

// ⚠️ A ROW WITHOUT A USABLE WEBSITE IS DROPPED, NOT SHOWN. Under the website rule it cannot be
// picked, so listing it is a dead end. That covers a missing domain, a malformed one, and a
// "website" that is really a posting host on a job board or a tracking vendor.
function withWebsite(h: EmployerHit): EmployerHit | null {
  const v = vetWebsite(h.domain);
  return v.ok && h.name ? { ...h, domain: hostOf(v.website) } : null;
}
const isHit = (h: EmployerHit | null): h is EmployerHit => !!h;

/**
 * The employer lookup — GET /discover/employers. Free to the user: it reads and looks up, renders
 * nothing and charges nothing.
 *
 * ⚠️ API_BASE IS READ INSIDE THE CALL ON PURPOSE. It is a live `let` binding in ../../config (an
 * admin can point the device at another environment at startup); snapshotting it into a
 * module-level const captures the pre-switch value and sends some requests to one database and
 * some to another.
 *
 * Throws on anything that is not a well-formed answer; the caller reads a throw as "we could not
 * look", never as "no website exists".
 */
async function fetchEmployerMatches(
  q: string, ctry: string, ms = 12000,
): Promise<{ hits: EmployerHit[]; lookup: WebsiteLookup }> {
  let tok: string | undefined;
  try { tok = JSON.parse((await SecureStore.getItemAsync('userSession')) || '{}')?.token; } catch { tok = undefined; }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const url = `${API_BASE}/discover/employers?q=${encodeURIComponent(q)}`
      + `&country=${encodeURIComponent(ctry || '')}&limit=12`;
    const r = await fetch(url, { headers: tok ? { Authorization: `Bearer ${tok}` } : {}, signal: ctl.signal });
    // ⚠️ A server that has not shipped this route yet answers 404 with HTML, so status and shape are
    // both checked before we believe the answer — otherwise the sheet would show a confident empty
    // list instead of saying the lookup is unavailable.
    if (!r.ok) throw new Error(`employers_${r.status}`);
    const j = await r.json();
    if (!Array.isArray(j?.employers)) throw new Error('employers_shape');
    // ⚠️ AN ABSENT `websiteLookup` IS A SERVER THAT NEVER LOOKED — one that predates the web lookup
    // and read only our own tables. Taking it as 'ok' would tell the user their employer has no
    // website on the strength of a search that never checked.
    const lookup: WebsiteLookup = j.websiteLookup === 'ok' || j.websiteLookup === 'degraded'
      ? j.websiteLookup : 'unavailable';
    const hits = j.employers
      .map((e: any) => withWebsite({
        name: String(e?.name || '').trim(),
        domain: String(e?.domain || ''),
        location: e?.location || null,
        jobs: Number(e?.jobs) || 0,
        source: e?.source === 'tracked' || e?.source === 'web' ? e.source : 'jobs',
      }))
      .filter(isHit)
      .slice(0, 12);
    return { hits, lookup };
  } finally { clearTimeout(timer); }
}

const TAG: Record<EmployerHit['source'], string> = { tracked: 'TRACKED', web: 'FROM THE WEB', jobs: 'FROM POSTINGS' };

export default function AddEmployerSheet({
  visible, onClose, onPick, regionHint,
}: {
  visible: boolean;
  onClose: () => void;
  /**
   * `value` is the employer's website (`https://host`, the same string as `extra.website`), plus —
   * optionally — the actual posting they are applying to. ⚠️ It is never a bare name: a name gave
   * the builder nothing to research. The listing is what makes the resume and the letter specific
   * to THIS job rather than generic to the company; it rides along and never replaces the site.
   */
  onPick: (value: string, extra: EmployerPick) => void;
  /** Shown under the region picker: which design family suits the chosen country. */
  regionHint?: (country: string) => string | null;
}) {
  const insets = useSafeAreaInsets();
  const t = useRef(new Animated.Value(0)).current;
  const [q, setQ] = useState('');
  const [country, setCountry] = useState('');
  const [countries, setCountries] = useState<string[]>([]);
  const [hits, setHits] = useState<EmployerHit[]>([]);
  const [busy, setBusy] = useState(false);
  // Whether the settled search's website lookup ran — the difference between "we could not find
  // their website" and "we could not look it up right now".
  const [lookup, setLookup] = useState<WebsiteLookup>('ok');
  // ⚠️ WHAT THE LAST SETTLED SEARCH ASKED FOR — not what is in the field. `busy` is only set
  // INSIDE search(), which runs 320ms after the last keystroke, so gating the zero-result message
  // on `!busy` flashed a factual claim ("No postings indexed for X yet", now "We couldn't find a
  // website for X") about a term nothing had been asked about yet.
  const [settled, setSettled] = useState('');
  // The employer's website typed by hand: the inline answer when the lookup has none, or — opened
  // by `addSite` — when the right employer is missing from a list that is not empty.
  const [site, setSite] = useState('');
  const [siteWhy, setSiteWhy] = useState<'invalid' | 'job_link' | null>(null);
  const [addSite, setAddSite] = useState(false);
  // The specific posting — optional, and free: it is prompt context, not another search.
  const [showJob, setShowJob] = useState(false);
  const [jobUrl, setJobUrl] = useState('');
  const [jobText, setJobText] = useState('');
  const [kb, setKb] = useState(0);
  const seq = useRef(0);
  const missTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    Animated.timing(t, {
      toValue: visible ? 1 : 0,
      duration: visible ? 260 : 170,
      easing: visible ? Easing.out(Easing.cubic) : Easing.in(Easing.quad),
      useNativeDriver: true,
    }).start();
    if (!visible) {
      // ⚠️ `settled` and `seq` reset too. A stale `settled` meant reopening and retyping the same
      // name found `asked` already true with `hits` emptied, so "we couldn't find a website" showed
      // before the new search had answered; bumping `seq` stops a search still in flight at close
      // from landing its rows in the reopened sheet.
      seq.current += 1;
      setQ(''); setHits([]); setBusy(false); setSettled(''); setLookup('ok');
      setSite(''); setSiteWhy(null); setAddSite(false); setShowJob(false); setJobUrl(''); setJobText('');
      if (missTimer.current) { clearTimeout(missTimer.current); missTimer.current = null; }
    }
  }, [visible, t]);

  // ⚠️ ON iOS THE KEYBOARD IS DRAWN OVER THIS SHEET, and the website field sits near its BOTTOM —
  // without this, the one input the website rule depends on is typed into blind. A <Modal> is its
  // own window and nothing in it resizes, so the sheet is padded up by the keyboard's height (the
  // Add-Company sheet in app/(ai-hub)/index.tsx measures it the same way). Layout padding, not an
  // Animated value, so the one-driver rule is untouched.
  // ⚠️ iOS ONLY. RN 0.81's Android modal window is SOFT_INPUT_ADJUST_RESIZE (ReactModalHostView.kt)
  // and statusBarTranslucent zeroes only its TOP inset, so Android shrinks the window itself;
  // padding there as well double-counts — the trap the KeyboardAvoidingView 'padding' lesson hit.
  useEffect(() => {
    if (!visible || Platform.OS !== 'ios') return;
    const up = Keyboard.addListener('keyboardWillShow', (e) => setKb(e.endCoordinates?.height ?? 0));
    const down = Keyboard.addListener('keyboardWillHide', () => setKb(0));
    return () => { up.remove(); down.remove(); setKb(0); };
  }, [visible]);

  useEffect(() => {
    if (!visible || countries.length) return;
    fetchCountryOptions()
      .then((opts) => setCountries((opts || []).slice(0, 24).map((o: any) => o.name).filter(Boolean)))
      .catch(() => {});
  }, [visible, countries.length]);

  const clearMiss = useCallback(() => {
    if (missTimer.current) { clearTimeout(missTimer.current); missTimer.current = null; }
  }, []);

  // ⚠️ The !visible branch above only covers the sheet being DISMISSED. A parent that unmounts it
  // while it is still open (navigating away, a re-key) left the 1.5s timer alive to fire track()
  // for a sheet the user is no longer looking at.
  useEffect(() => clearMiss, [clearMiss]);

  /**
   * An employer we could not find a website for is the single most useful thing this sheet can tell
   * us — the "no match for nordex" report, arriving as data instead of as a complaint.
   *
   * ⚠️ NEVER THE QUERY ITSELF. A typed employer name is the user's own job hunt; only its length
   * goes out. ⚠️ And it is reported on a delay: the search is debounced per keystroke, so firing
   * immediately files "no", "nor", "nord", "norde" as four separate misses of one word. The timer
   * is cancelled by the next search, so only the query they settled on is ever reported.
   *
   * ⚠️ `reason` IS NOT DECORATION. 'no_website' is the answer this slice exists to measure: the
   * lookup ran and found no website for them. 'lookup_unavailable' means we never really looked —
   * the server's website lookup could not run, or only its fallback provider answered ('degraded').
   * 'error' means the request threw: offline, an expired token or a timeout. Neither of the last two says
   * anything about coverage, and folding them into the first would let an outage read as a
   * coverage gap, so they are reported apart and must be filtered apart downstream.
   */
  const reportMiss = useCallback((term: string, ctry: string, reason: 'no_website' | 'lookup_unavailable' | 'error') => {
    clearMiss();
    missTimer.current = setTimeout(() => {
      track('home_add_employer_miss', { len: term.length, region: !!ctry, reason });
    }, 1500);
  }, [clearMiss]);

  // Free either way — a lookup, not a generation — so it can run as they type.
  const search = useCallback(async (text: string, ctry: string) => {
    const term = text.trim();
    clearMiss();
    const kind = inputKind(term);
    if (term.length < 2 || kind === 'url') {
      // An unmistakable address needs no lookup and one letter is not a name ("booking.com" is
      // looked up — see inputKind). Bumping `seq` also retires a search still in flight for the
      // longer term they just deleted, which would otherwise land.
      seq.current += 1;
      setBusy(false); setHits([]); setSettled(askedKey(term, ctry));
      return;
    }
    const mine = ++seq.current;
    setBusy(true);
    let found: EmployerHit[] = [];
    let status: WebsiteLookup | 'error' = 'ok';
    try {
      const r = await fetchEmployerMatches(term, ctry);
      found = r.hits; status = r.lookup;
    } catch {
      // ⚠️ NO JOB-FEED FALLBACK: its rows carry the POSTING's host (see the header). A failed lookup
      // is shown as unavailable, with the add-website box, and is NOT a coverage gap.
      status = 'error';
    }
    if (mine !== seq.current) return;                                             // a later keystroke already won
    setHits(found);
    setLookup(status === 'error' ? 'unavailable' : status);
    setBusy(false);
    setSettled(askedKey(term, ctry));
    // Typed input that is itself a website candidate ("booking.com") is not a miss.
    if (!found.length && kind === 'name') {
      reportMiss(term, ctry, status === 'ok' ? 'no_website' : status === 'error' ? 'error' : 'lookup_unavailable');
    }
  }, [clearMiss, reportMiss]);

  useEffect(() => {
    if (!visible) return;
    const id = setTimeout(() => search(q, country), 320);   // debounce the typing
    return () => clearTimeout(id);
  }, [q, country, visible, search]);

  const close = () => { Keyboard.dismiss(); onClose(); };
  // ⚠️ THE ONE WAY OUT OF THIS SHEET, and it always carries a website: `value` and `extra.website`
  // are the same `https://host`. The name rides along when we know it; the listing is extra context.
  const take = (website: string, name?: string) => {
    Keyboard.dismiss();
    onPick(website, {
      name: name?.trim() || undefined,
      website,
      country: country || undefined,
      jobUrl: jobUrl.trim() || undefined,
      jobText: jobText.trim() || undefined,
    });
  };
  // A job link typed where a website goes is neither thrown away nor accepted as the site: it moves
  // to the specific-job box, where it was useful all along, and the website slot stays empty.
  const moveToJob = (link: string) => { setJobUrl(link.trim()); setShowJob(true); };

  const hint = country && regionHint ? regionHint(country) : null;
  const typed = q.trim();
  const kind = inputKind(q);
  // Address-like input gets the "Use this website" row — the ambiguous 'maybe' too, beside its results.
  const isUrl = kind !== 'name';
  // A pure name — the only input that can come back with "no website found" or "Not listed?". A
  // 'maybe' is looked up as well, but it already offers itself as the website in its own row.
  const isName = typed.length >= 2 && kind === 'name';
  // True only once a search for exactly what is on screen has finished — see `settled`.
  const asked = settled === askedKey(typed, country);
  // A website pasted straight into the search box, vetted exactly like the inline one.
  const fieldVet = isUrl ? vetWebsite(q) : null;
  const fieldWebsite = fieldVet?.ok ? fieldVet.website : null;
  const fieldWhy = fieldVet && !fieldVet.ok ? fieldVet.why : null;
  // The inline website box: the answer to a settled search with no website, or — opened from
  // "Not listed?" — to a list that is missing the right employer.
  const siteBox = isName && (hits.length ? addSite : asked);
  const submitSite = () => {
    const v = vetWebsite(site);
    if (v.ok) take(v.website, typed);
    else setSiteWhy(v.why);
  };

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={close} statusBarTranslucent>
      <View style={[s.fill, kb > 0 && { paddingBottom: kb }]}>
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: t }]}>
          <View style={s.scrim} />
        </Animated.View>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={close} />

        <Animated.View
          style={[
            s.sheet,
            {
              // The keyboard already covers the home indicator, so the inset is only needed without it.
              paddingBottom: (kb > 0 ? 0 : insets.bottom) + 12,
              transform: [{ translateY: t.interpolate({ inputRange: [0, 1], outputRange: [520, 0] }) }],
            },
          ]}
        >
          <View style={s.grab} />
          <View style={s.headRow}>
            <Text style={s.h}>Add an employer</Text>
            <TouchableOpacity onPress={close} style={s.x} activeOpacity={0.85} accessibilityLabel="Close">
              <Ionicons name="close" size={18} color={E.textMuted} />
            </TouchableOpacity>
          </View>
          <Text style={s.sub}>Type a name — we will find their website.</Text>

          <View style={s.field}>
            <Ionicons name="search" size={16} color={E.textFaint} />
            <TextInput
              style={s.input}
              value={q}
              onChangeText={setQ}
              placeholder="Employer name or website"
              placeholderTextColor={E.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              onSubmitEditing={() => { if (fieldWebsite) take(fieldWebsite); }}
            />
            {busy && <ActivityIndicator size="small" color={E.blue} />}
          </View>

          {/* region */}
          <Text style={s.lbl}>REGION</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.regions}>
            <Region on={!country} label="Anywhere" onPress={() => setCountry('')} />
            {countries.map((c) => (
              <Region key={c} on={country === c} label={c} onPress={() => setCountry(country === c ? '' : c)} />
            ))}
          </ScrollView>
          {/* ── building for a specific job (optional, ALWAYS here) ─────────────────────────────
              A resume written against the real listing beats one written against a company's home
              page, so this is worth asking for. ⚠️ But it is context ON TOP OF the employer's
              website, never a replacement for it, so it renders whatever the search state is and
              no state of this sheet points people to it instead of the site. Supplying it costs
              nothing extra: it is context for the prompt, not a second search. */}
          <TouchableOpacity style={s.jobToggle} activeOpacity={0.8} onPress={() => setShowJob((v) => !v)}>
            <Ionicons name={showJob ? 'chevron-down' : 'chevron-forward'} size={15} color={E.blueDeep} />
            <Text style={s.jobToggleTx} numberOfLines={2}>
              Building for a specific job? Add the job link or paste the description
            </Text>
            <Text style={s.jobOptional}>optional</Text>
          </TouchableOpacity>
          {showJob && (
            <View style={s.jobBox}>
              <TextInput
                style={s.jobUrlInput}
                value={jobUrl}
                onChangeText={setJobUrl}
                placeholder="Link to the job posting"
                placeholderTextColor={E.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TextInput
                style={s.jobTextInput}
                value={jobText}
                onChangeText={setJobText}
                placeholder="…or paste the job description here"
                placeholderTextColor={E.textFaint}
                multiline
                textAlignVertical="top"
              />
              <Text style={s.jobNote} numberOfLines={2}>
                Extra context on top of the employer — we write the resume and the letter against this posting.
              </Text>
            </View>
          )}

          {!!hint && (
            <View style={s.hint}>
              <Ionicons name="sparkles" size={12} color={E.blueDeep} />
              <Text style={s.hintTx} numberOfLines={1}>Best design for {country}: {hint}</Text>
            </View>
          )}

          {/* a pasted website is its own answer — no search can improve on it */}
          {!!fieldWebsite && (
            <TouchableOpacity style={s.urlRow} activeOpacity={0.9} onPress={() => take(fieldWebsite)}>
              <View style={s.urlIcon}><Ionicons name="globe-outline" size={15} color="#fff" /></View>
              <View style={s.grow}>
                <Text style={s.urlTx} numberOfLines={1}>Use this website</Text>
                <Text style={s.urlSub} numberOfLines={1}>{hostOf(fieldWebsite)}</Text>
              </View>
              <Ionicons name="arrow-forward" size={16} color={E.blueDeep} />
            </TouchableOpacity>
          )}
          {fieldWhy === 'job_link' && (
            <TouchableOpacity style={s.urlRow} activeOpacity={0.9} onPress={() => { moveToJob(q); setQ(''); }}>
              <View style={s.urlIcon}><Ionicons name="briefcase-outline" size={15} color="#fff" /></View>
              <View style={s.grow}>
                <Text style={s.urlTx} numberOfLines={1}>That's a page on a job site, not their website</Text>
                <Text style={s.urlSub} numberOfLines={2}>Tap to add it as the specific job, then search their name for the website</Text>
              </View>
              <Ionicons name="arrow-up" size={16} color={E.blueDeep} />
            </TouchableOpacity>
          )}
          {fieldWhy === 'invalid' && (
            <View style={s.why}>
              <Ionicons name="information-circle-outline" size={13} color={E.blueDeep} />
              <Text style={s.whyTx}>Not a full website yet — for example company.com</Text>
            </View>
          )}

          <ScrollView style={s.results} keyboardShouldPersistTaps="handled">
            {hits.map((h) => {
              // A tracked employer legitimately has 0 crawled postings — saying "0 open roles"
              // would read as a defect, so the count only appears when there is one.
              const meta = [h.location || '', h.jobs > 0 ? `${h.jobs} open role${h.jobs === 1 ? '' : 's'}` : '']
                .filter(Boolean).join(' · ');
              return (
              <TouchableOpacity key={`${h.domain}|${h.name}`} style={s.hit} activeOpacity={0.85} onPress={() => take(`https://${h.domain}`, h.name)}>
                <View style={s.hitTile}><Text style={s.hitTileTx}>{h.name.charAt(0).toUpperCase()}</Text></View>
                <View style={s.grow}>
                  <View style={s.hitTop}>
                    <Text style={s.hitName} numberOfLines={1}>{h.name}</Text>
                    {/* How solid the row is. 'Tracked' is an employer record and 'web' was looked
                        up for this search; the posting-inferred kind is how "Siemens" once came back
                        as the staffing agencies reposting their roles. */}
                    <View style={s.tag}>
                      <Text style={[s.tagTx, h.source === 'tracked' && s.tagTxOn]}>{TAG[h.source]}</Text>
                    </View>
                  </View>
                  {/* the website is what gets researched, so it is on every row — never optional */}
                  <View style={s.hitLine}>
                    <Ionicons name="globe-outline" size={11} color={E.textFaint} />
                    <Text style={s.hitSub} numberOfLines={1}>{h.domain}</Text>
                  </View>
                  {!!meta && (
                    <View style={s.hitLine}>
                      {!!h.location && <Ionicons name="location-outline" size={11} color={E.textFaint} />}
                      <Text style={s.hitSub} numberOfLines={1}>{meta}</Text>
                    </View>
                  )}
                </View>
                <Ionicons name="add-circle" size={22} color={E.blueDeep} />
              </TouchableOpacity>
              );
            })}

            {/* ⚠️ UNDER EVERY NON-EMPTY LIST, not only an empty one: the right employer is missing
                from a list that is not empty just as often ("Siemens" once listed only agencies),
                and without this the only way to a hand-typed website was to search for something
                that returns nothing. */}
            {isName && hits.length > 0 && !addSite && (
              <TouchableOpacity style={s.notListed} activeOpacity={0.85} onPress={() => setAddSite(true)}>
                <Ionicons name="globe-outline" size={15} color={E.blueDeep} />
                <Text style={[s.notListedTx, s.grow]} numberOfLines={1}>Not listed? Add their website</Text>
                <Ionicons name="chevron-forward" size={15} color={E.textFaint} />
              </TouchableOpacity>
            )}

            {/* ⚠️ THE WEBSITE BOX REPLACES THE OLD 'Use "<name>"' ROW. That row let a bare name
                through, and a name gave the builder nothing to research. It is inline and in place
                — not a mode that takes over the search field — so the typed name stays put.
                ⚠️ `asked` NOT `!busy`: "we couldn't find a website" is a factual claim, so it may
                only appear once a search for EXACTLY this term and region has settled. And when the
                lookup never ran, it says that instead: an outage is not a missing website. */}
            {siteBox && (
              <View style={s.siteBox}>
                <View style={s.siteHead}>
                  <Ionicons
                    name={hits.length || lookup === 'ok' ? 'globe-outline' : 'cloud-offline-outline'}
                    size={16}
                    color={E.blueDeep}
                  />
                  <View style={s.grow}>
                    <Text style={s.notListedTx} numberOfLines={2}>
                      {hits.length
                        ? 'Add their website'
                        : lookup === 'ok'
                          ? `We couldn't find a website for “${typed}”`
                          : "We couldn't look up websites right now"}
                    </Text>
                    <Text style={s.siteSub} numberOfLines={2}>
                      {hits.length
                        ? 'We need it to build your resume or cover letter.'
                        : lookup === 'ok'
                          ? 'Add the employer’s website — we need it to build your resume or cover letter.'
                          : 'You can still add the employer’s website — we need it to build your resume or cover letter.'}
                    </Text>
                  </View>
                </View>
                <View style={s.siteField}>
                  <Ionicons name="globe-outline" size={15} color={E.textFaint} />
                  <TextInput
                    style={s.input}
                    value={site}
                    onChangeText={(v) => { setSite(v); if (siteWhy) setSiteWhy(null); }}
                    placeholder="e.g. company.com"
                    placeholderTextColor={E.textFaint}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    returnKeyType="go"
                    // Opened from "Not listed?" the user asked for it; as the answer to an empty
                    // search it must NOT steal focus from a name they may still be typing.
                    autoFocus={hits.length > 0}
                    onSubmitEditing={submitSite}
                  />
                  <TouchableOpacity
                    style={[s.siteGo, !site.trim() && s.siteGoOff]}
                    activeOpacity={0.85}
                    disabled={!site.trim()}
                    onPress={submitSite}
                    accessibilityLabel="Use this website"
                  >
                    <Ionicons name="arrow-forward" size={16} color="#fff" />
                  </TouchableOpacity>
                </View>
                {/* a short inline hint, never an Alert — the fix is one edit away in the same box */}
                {siteWhy === 'invalid' && (
                  <Text style={s.whyTx}>That doesn’t look like a website — try something like company.com</Text>
                )}
                {siteWhy === 'job_link' && (
                  <Text style={s.whyTx}>
                    That's a page on a job site, not their website.{' '}
                    <Text
                      style={s.whyAct}
                      onPress={() => { moveToJob(site); setSite(''); setSiteWhy(null); }}
                    >
                      Add it as the specific job
                    </Text>
                  </Text>
                )}
              </View>
            )}
          </ScrollView>

          <View style={s.note}>
            <Ionicons name="information-circle-outline" size={13} color={E.textFaint} />
            <Text style={s.noteTx} numberOfLines={2}>
              Searching is free. Adding an employer runs a company search, which uses credits.
            </Text>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

function Region({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity style={[s.region, on && s.regionOn]} activeOpacity={0.85} onPress={onPress}>
      <Text style={[s.regionTx, on && s.regionTxOn]} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1, justifyContent: 'flex-end' },
  scrim: { flex: 1, backgroundColor: 'rgba(7,10,24,0.55)' },
  sheet: {
    backgroundColor: E.surface, borderTopLeftRadius: 26, borderTopRightRadius: 26,
    // flexShrink: with the keyboard padding the space under it, a full list must shrink its own
    // results ScrollView rather than push the header off the top of the screen.
    paddingHorizontal: 16, paddingTop: 8, maxHeight: '86%', flexShrink: 1,
  },
  grow: { flex: 1 },
  grab: { alignSelf: 'center', width: 38, height: 4, borderRadius: 100, backgroundColor: '#D7DEEA', marginBottom: 10 },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  h: { fontSize: 19, fontWeight: '800', color: E.ink, letterSpacing: -0.4 },
  x: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: E.inputBg },
  sub: { fontSize: 12.5, fontWeight: '600', color: E.textMuted, marginTop: 3 },
  field: {
    flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 14,
    backgroundColor: E.inputBg, borderRadius: 14, paddingHorizontal: 12, height: 48,
    borderWidth: 1, borderColor: E.border,
  },
  input: { flex: 1, fontSize: 14.5, fontWeight: '600', color: E.ink, padding: 0, ...Platform.select({ web: { outlineStyle: 'none' as any }, default: {} }) },
  lbl: { fontSize: 10, fontWeight: '800', color: E.textFaint, letterSpacing: 1.1, marginTop: 16, marginBottom: 8 },
  regions: { flexDirection: 'row', gap: 7, paddingRight: 16 },
  region: { paddingHorizontal: 12, height: 32, borderRadius: 100, backgroundColor: E.inputBg, borderWidth: 1, borderColor: E.border, justifyContent: 'center' },
  regionOn: { backgroundColor: 'rgba(79,141,255,0.12)', borderColor: 'rgba(79,141,255,0.5)' },
  regionTx: { fontSize: 12, fontWeight: '700', color: E.textMuted },
  regionTxOn: { color: E.blueDeep },
  jobToggle: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 14 },
  jobToggleTx: { flex: 1, fontSize: 12.5, fontWeight: '700', color: E.ink },
  jobOptional: { fontSize: 10, fontWeight: '800', color: E.textFaint, letterSpacing: 0.6, textTransform: 'uppercase' },
  jobBox: { marginTop: 10, gap: 8 },
  jobUrlInput: {
    height: 44, borderRadius: 12, paddingHorizontal: 12, backgroundColor: E.inputBg,
    borderWidth: 1, borderColor: E.border, fontSize: 13.5, fontWeight: '600', color: E.ink,
    ...Platform.select({ web: { outlineStyle: 'none' as any }, default: {} }),
  },
  jobTextInput: {
    minHeight: 88, borderRadius: 12, padding: 12, backgroundColor: E.inputBg,
    borderWidth: 1, borderColor: E.border, fontSize: 13, fontWeight: '500', color: E.ink,
    ...Platform.select({ web: { outlineStyle: 'none' as any }, default: {} }),
  },
  jobNote: { fontSize: 11, fontWeight: '600', color: E.textMuted, lineHeight: 15 },
  hint: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
  hintTx: { flexShrink: 1, fontSize: 11.5, fontWeight: '700', color: E.blueDeep },
  urlRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14, padding: 11,
    borderRadius: 14, borderWidth: 1, borderColor: 'rgba(79,141,255,0.35)', backgroundColor: 'rgba(79,141,255,0.07)',
  },
  urlIcon: { width: 30, height: 30, borderRadius: 10, backgroundColor: E.blueDeep, alignItems: 'center', justifyContent: 'center' },
  urlTx: { fontSize: 13.5, fontWeight: '800', color: E.ink },
  urlSub: { fontSize: 11, fontWeight: '600', color: E.textMuted, marginTop: 1 },
  why: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
  whyTx: { flexShrink: 1, fontSize: 11.5, fontWeight: '600', color: E.textMuted, lineHeight: 15 },
  whyAct: { fontWeight: '800', color: E.blueDeep },
  results: { marginTop: 12 },
  hit: {
    flexDirection: 'row', alignItems: 'center', gap: 11, padding: 10, marginBottom: 8,
    borderRadius: 14, borderWidth: 1, borderColor: E.border, backgroundColor: E.inputBg,
  },
  hitLine: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  hitTile: { width: 38, height: 38, borderRadius: 12, backgroundColor: E.surface, borderWidth: 1, borderColor: E.border, alignItems: 'center', justifyContent: 'center' },
  hitTileTx: { fontSize: 14, fontWeight: '800', color: E.textMuted },
  hitTop: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  hitName: { flexShrink: 1, fontSize: 14, fontWeight: '700', color: E.ink },
  tag: { paddingHorizontal: 5, paddingVertical: 1.5, borderRadius: 5, backgroundColor: E.surface, borderWidth: 1, borderColor: E.border },
  tagTx: { fontSize: 8.5, fontWeight: '800', letterSpacing: 0.5, color: E.textFaint },
  tagTxOn: { color: E.blueDeep },
  hitSub: { fontSize: 11.5, fontWeight: '600', color: E.textMuted, marginTop: 2 },
  notListed: {
    flexDirection: 'row', alignItems: 'center', gap: 9, padding: 11, marginTop: 2, marginBottom: 8,
    borderRadius: 14, borderWidth: 1, borderStyle: 'dashed', borderColor: 'rgba(79,141,255,0.45)',
  },
  notListedTx: { fontSize: 13, fontWeight: '800', color: E.ink },
  // Same dashed frame as "Not listed?" on purpose: it is what that row opens into.
  siteBox: {
    gap: 9, padding: 11, marginTop: 2, marginBottom: 8,
    borderRadius: 14, borderWidth: 1, borderStyle: 'dashed', borderColor: 'rgba(79,141,255,0.45)',
  },
  siteHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 9 },
  siteSub: { fontSize: 11.5, fontWeight: '600', color: E.textMuted, marginTop: 2, lineHeight: 15 },
  siteField: {
    flexDirection: 'row', alignItems: 'center', gap: 9, height: 44, paddingLeft: 12, paddingRight: 5,
    backgroundColor: E.inputBg, borderRadius: 12, borderWidth: 1, borderColor: E.border,
  },
  siteGo: { width: 34, height: 34, borderRadius: 10, backgroundColor: E.blueDeep, alignItems: 'center', justifyContent: 'center' },
  siteGoOff: { opacity: 0.4 },
  note: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 10 },
  noteTx: { flexShrink: 1, fontSize: 11, fontWeight: '600', color: E.textFaint, lineHeight: 15 },
});
