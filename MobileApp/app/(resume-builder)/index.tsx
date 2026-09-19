// Resume Builder — new feature. Safe to delete without affecting existing app.
import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, ActivityIndicator, Alert, Animated, Platform, Image,
  KeyboardAvoidingView, Modal, FlatList,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadJobListing } from '../../services/employerHomeService';
import * as SecureStore from 'expo-secure-store';
import { API_BASE } from '../../config';
import { fetchResumeSourceText } from '../../services/resumeScoreService';

const T = {
  bg:       '#E5EAF3',
  bgSoft:   '#F0F4FA',
  surface:  '#FFFFFF',
  ink:      '#0B0F22',
  inkSoft:  '#1A2046',
  muted:    '#5A6480',
  faint:    '#8A93B2',
  border:   'rgba(11,15,34,0.07)',
  blue:     '#4F8DFF',
  blueDeep: '#2563EB',
  cyan:     '#06B6D4',
  emerald:  '#10B981',
  navy:     '#0B1120',
};

// ── Country list ─────────────────────────────────────────────────────────────
const COUNTRIES = [
  { name: 'India',          flag: '🇮🇳', dial: '+91'  },
  { name: 'United States',  flag: '🇺🇸', dial: '+1'   },
  { name: 'United Kingdom', flag: '🇬🇧', dial: '+44'  },
  { name: 'Canada',         flag: '🇨🇦', dial: '+1'   },
  { name: 'Australia',      flag: '🇦🇺', dial: '+61'  },
  { name: 'UAE',            flag: '🇦🇪', dial: '+971' },
  { name: 'Singapore',      flag: '🇸🇬', dial: '+65'  },
  { name: 'Germany',        flag: '🇩🇪', dial: '+49'  },
  { name: 'France',         flag: '🇫🇷', dial: '+33'  },
  { name: 'Netherlands',    flag: '🇳🇱', dial: '+31'  },
  { name: 'Ireland',        flag: '🇮🇪', dial: '+353' },
  { name: 'New Zealand',    flag: '🇳🇿', dial: '+64'  },
  { name: 'South Africa',   flag: '🇿🇦', dial: '+27'  },
  { name: 'Saudi Arabia',   flag: '🇸🇦', dial: '+966' },
  { name: 'Qatar',          flag: '🇶🇦', dial: '+974' },
  { name: 'Bahrain',        flag: '🇧🇭', dial: '+973' },
  { name: 'Kuwait',         flag: '🇰🇼', dial: '+965' },
  { name: 'Pakistan',       flag: '🇵🇰', dial: '+92'  },
  { name: 'Bangladesh',     flag: '🇧🇩', dial: '+880' },
  { name: 'Sri Lanka',      flag: '🇱🇰', dial: '+94'  },
  { name: 'Nepal',          flag: '🇳🇵', dial: '+977' },
  { name: 'Malaysia',       flag: '🇲🇾', dial: '+60'  },
  { name: 'Philippines',    flag: '🇵🇭', dial: '+63'  },
  { name: 'Japan',          flag: '🇯🇵', dial: '+81'  },
  { name: 'China',          flag: '🇨🇳', dial: '+86'  },
  { name: 'South Korea',    flag: '🇰🇷', dial: '+82'  },
  { name: 'Indonesia',      flag: '🇮🇩', dial: '+62'  },
  { name: 'Thailand',       flag: '🇹🇭', dial: '+66'  },
  { name: 'Italy',          flag: '🇮🇹', dial: '+39'  },
  { name: 'Spain',          flag: '🇪🇸', dial: '+34'  },
  { name: 'Sweden',         flag: '🇸🇪', dial: '+46'  },
  { name: 'Switzerland',    flag: '🇨🇭', dial: '+41'  },
  { name: 'Brazil',         flag: '🇧🇷', dial: '+55'  },
  { name: 'Mexico',         flag: '🇲🇽', dial: '+52'  },
  { name: 'Nigeria',        flag: '🇳🇬', dial: '+234' },
  { name: 'Kenya',          flag: '🇰🇪', dial: '+254' },
  { name: 'Egypt',          flag: '🇪🇬', dial: '+20'  },
];
const DEFAULT_COUNTRY = COUNTRIES[0]; // India

// Remove ONE OR MORE leading dial-code groups (e.g. "+91 " or a buggy "+91 +91 ")
// so the phone field only ever holds the bare number — prevents the country code
// from being prepended twice on regenerate.
const stripDial = (s?: string) => (s || '').replace(/^(\s*\+\d{1,3}\s+)+/, '').trim();
// Re-select the saved country (by name first, then dial) so the dial prefix stays correct.
const findCountry = (name?: string, dial?: string) =>
  COUNTRIES.find(c => c.name === name) || COUNTRIES.find(c => c.dial === dial) || DEFAULT_COUNTRY;

async function getAuthHeader(): Promise<Record<string, string>> {
  try {
    const raw = await SecureStore.getItemAsync('userSession');
    const token = JSON.parse(raw || '{}')?.token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch { return {}; }
}

// ── THE BUILD RUNS AS A BACKGROUND JOB, WITH ONE clientBuildId PER TAP ─────────────────────────────────────
// ⚠️ ONE RESUME WAS TWO CHARGES. Both Generate lanes held one socket for up to four and a half minutes of server work
// against a 120-second client abort, then said "tap Generate again" — while the server finished, saved and charged the
// first resume. The next tap had nothing to reuse (a build with no employer has no cache) and was charged again: two
// units, one resume. Now the build is sent with __async:true (the route's asJob lane answers with a job id at once) and
// polled here for up to 5½ minutes, the way the Make Yours wizard's generateResume does; the alert's Try again /
// Keep waiting repeat THAT build (same id, same track — below), never a new one. And at the deadline nothing invites
// a regenerate: the saved resume is read first, and opened when this build has already landed.
//
// ⚠️ …AND "KEEP WAITING" WAS A SECOND CHARGE ONCE THE PHONE HAD BEEN PUT DOWN. It re-POSTed the same clientBuildId and
// trusted asJob to hand back the job it already ran — but asJob dedupes an id for 15 minutes from the FIRST POST (its
// memory map and its async_jobs lookup alike), not for ever. "Still building…" shows at 5½ minutes; a user who
// backgrounded the app and tapped Keep waiting ten minutes later was past the window: a brand-new job, a second unit
// charged for the resume already saved — under "You will not be charged twice". Worse, the rerun re-read `before`,
// which by then WAS the finished resume, so not even the deadline check could recognise it. So a build carries a
// BuildTrack through every rerun: the job its POST was answered with — Keep waiting FOLLOWS that job (async_jobs keeps
// a finished row for 24 hours) and never POSTs again — and the saved resume as it was before the FIRST POST, carried,
// never re-read. A rerun with no job to follow (the POST got no answer, or the row is gone) looks at the saved resume
// against that snapshot first and opens what landed; only when nothing did is the same id POSTed again.
type BuildTrack = {
  before: string | null | undefined;   // the saved resume before the FIRST POST (savedResumeText's three answers)
  jobId: string | null;                // the job that POST started, when an answer reached us and the row still exists
};
type BuildOutcome =
  | { kind: 'done'; resumeData: any }
  | { kind: 'quota'; message: string }
  | { kind: 'regen_limit'; message: string }
  | { kind: 'failed'; message: string; retrySame: boolean; track?: BuildTrack }   // retrySame: no answer reached us — the build may be running
  | { kind: 'late'; track: BuildTrack };                                         // past the deadline, and not saved yet: still building

const newBuildId = () => `rb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const BUILD_POLL_MS = 1500;
const BUILD_DEADLINE_MS = 5.5 * 60 * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What the alert's rerun repeats: after a real failure a NEW build (fresh id, fresh snapshot); otherwise THIS one —
 *  its id and its track, so a late tap follows the job it already has instead of POSTing past asJob's window. */
function rerunOf(outcome: BuildOutcome, buildId: string): [string, BuildTrack | undefined] {
  if (outcome.kind === 'failed' && !outcome.retrySame) return [newBuildId(), undefined];
  return [buildId, outcome.kind === 'late' || outcome.kind === 'failed' ? outcome.track : undefined];
}

/** The saved resume, as text to compare against: null when there is none, undefined when it could not be read. */
async function savedResumeText(auth: Record<string, string>): Promise<string | null | undefined> {
  try {
    const r = await fetch(`${API_BASE}/resume-builder`, { headers: auth });
    if (!r.ok) return undefined;
    const j = await r.json();
    return j && j.resumeData ? JSON.stringify(j.resumeData) : null;
  } catch { return undefined; }
}

/** Start one build — or, given a rerun's `track`, re-join it — and follow it to its end. Never throws. */
async function runResumeBuild(payload: Record<string, any>, buildId: string, headers: Record<string, string>, isLeft: () => boolean, track?: BuildTrack): Promise<BuildOutcome> {
  const auth: Record<string, string> = headers.Authorization ? { Authorization: headers.Authorization } : {};
  // What is saved BEFORE this build — the deadline compares against it, so an older resume is never mistaken for this one.
  // ⚠️ A rerun CARRIES it from the first run: read now, after the build may have landed, it would BE this build.
  const before = track ? track.before : await savedResumeText(auth);
  /** The saved resume once it is no longer the one from before — this build has landed. Only against a "before" that
   *  was really read: an unreadable one would make the OLD resume look new. */
  const landed = async (): Promise<any | null> => {
    const now = before === undefined ? undefined : await savedResumeText(auth);
    if (typeof now === 'string' && now !== before) {
      try { return JSON.parse(now); } catch { /* fall through */ }
    }
    return null;
  };
  let jobId: string | null = track ? track.jobId : null;
  if (track && !jobId) {
    // A rerun with no job to follow — the first POST got no answer (it may have run and saved long ago) or its row is
    // gone. Look before POSTing: past asJob's 15 minutes the same id would be a new job and a second charge.
    const got = await landed();
    if (got) return { kind: 'done', resumeData: got };
  }
  if (!jobId) {
    let status = 0;
    let started: any = null;
    try {
      const r = await fetch(`${API_BASE}/resume-builder/generate-ai`, {
        method: 'POST', headers, body: JSON.stringify({ ...payload, __async: true, clientBuildId: buildId }),
      });
      status = r.status;
      started = await r.json().catch(() => ({}));
    } catch {
      return { kind: 'failed', message: 'We could not reach the server. Please check your connection and try again.', retrySame: true, track: { before, jobId: null } };
    }
    if (status === 402) return { kind: 'quota', message: started?.error || 'You have used your included resume generations.' };
    if (status === 403 && started?.reason === 'regen_limit') return { kind: 'regen_limit', message: started?.error || 'Your free plan includes one regeneration.' };
    // ⚠️ asJob runs the build SYNCHRONOUSLY when it cannot create a job row — then this is the finished resume.
    if (started && started.resumeData) return { kind: 'done', resumeData: started.resumeData };
    jobId = (started && started.jobId) || null;
    if (status >= 400 || !jobId) return { kind: 'failed', message: started?.error || 'We could not start building your resume.', retrySame: false };
  }
  // else: Keep waiting on a build whose job we already have — follow THAT job; a second POST is what charged twice.
  const job: string = jobId;

  const until = Date.now() + BUILD_DEADLINE_MS;
  let missing = 0;   // consecutive 404s: the job row is gone (cleaned up) — nothing left to wait for
  while (Date.now() < until) {
    await sleep(BUILD_POLL_MS);
    if (isLeft()) return { kind: 'late', track: { before, jobId: job } };
    let j: any = null;
    try {
      const r = await fetch(`${API_BASE}/job-status/${encodeURIComponent(job)}`, { headers: auth });
      if (r.status === 404) { if (++missing >= 2) break; continue; }
      missing = 0;
      j = await r.json().catch(() => null);
    } catch { /* one dropped poll is not a failure; the next one will answer */ }
    if (!j) continue;
    if (j.status === 'completed') {
      const d = j.data || {};
      if (d.resumeData) return { kind: 'done', resumeData: d.resumeData };
      return { kind: 'failed', message: d.error || 'The resume finished but came back empty. Please try again.', retrySame: false };
    }
    if (j.status === 'failed') {
      // asJob keeps a refusal's reason on the job: the allowance is used up → Plans, not a Try again.
      if (j.reason === 'quota_exhausted') return { kind: 'quota', message: j.error || 'You have used your included resume generations.' };
      if (j.reason === 'regen_limit') return { kind: 'regen_limit', message: j.error || 'Your free plan includes one regeneration.' };
      return { kind: 'failed', message: j.error || 'We could not finish building your resume. Please try again.', retrySame: false };
    }
  }
  // Out of time (or lost track): the build may well have landed — look before saying anything.
  const got = await landed();
  if (got) return { kind: 'done', resumeData: got };
  // Still building: Keep waiting follows this job — unless its row is gone, when the rerun looks and only then POSTs.
  return { kind: 'late', track: { before, jobId: missing >= 2 ? null : job } };
}

// A ready-to-edit starter resume for the "Build Manually" path — realistic example values the
// user simply taps and replaces (their real name/email/phone/location get merged in at seed time).
const SAMPLE_RESUME = {
  _buildMethod: 'manual',
  personal_info: { full_name: 'Your Name', email: 'you@email.com', phone: '', location: 'City, Country', linkedin_url: '', portfolio_url: '' },
  summary: 'Results-driven professional with a track record of delivering impactful work. Replace this with 2–3 lines on your strengths, focus areas, and what you bring to a team.',
  experience: [
    { role: 'Your Job Title', company: 'Company Name', location: 'City, Country', start_date: 'Jan 2022', end_date: 'Present',
      highlights: ['Describe a key achievement — include a number or result where you can.', 'Add another responsibility or outcome from this role.'] },
  ],
  education: [
    { degree: 'Your Degree', field_of_study: 'Field of Study', institution: 'University / College Name', end_date: '2021', grade: '' },
  ],
  projects: [
    { title: 'Project Name', type: 'Web app', about: 'One line about what this project does and the problem it solves.', role: 'Your role',
      role_highlights: ['What you built or achieved on this project.'] },
  ],
  skills: { technical: ['Skill 1', 'Skill 2', 'Skill 3'], soft: ['Communication', 'Teamwork', 'Problem Solving'] },
};

// The story box is PLAIN TEXT. Pulled resume text and saved stories can carry **markdown**
// emphasis from the AI's own resume fields — those markers must never reach the textarea.
function plainStory(t?: string | null): string {
  return String(t || '')
    .replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*/g, '')
    .replace(/^#+\s*/gm, '').replace(/^[-•]\s*/gm, '')
    // Every paragraph change reads as one: a single newline becomes a blank line, so the story
    // box shows clearly separated paragraphs instead of a cramped wall of lines.
    .replace(/\n{2,}/g, '\n').replace(/\n/g, '\n\n').trim();
}

export default function ResumeBuilderIndex() {
  const router = useRouter();
  // The model is SUBSCRIPTION COUNTS now, not credits — the button shows what the user has
  // LEFT this period (server truth via /subscription/status), never a per-action price.
  const [resumesLeft, setResumesLeft] = useState<number | null>(null);
  useEffect(() => {
    (async () => {
      try {
        const { fetchSubscriptionStatus } = require('../../services/subscriptionService');
        const st = await fetchSubscriptionStatus();
        if (st && st.remaining && typeof st.remaining.resumes === 'number') setResumesLeft(Math.max(0, st.remaining.resumes));
      } catch {}
    })();
  }, []);
  const [mode, setMode] = useState<'select' | 'ai' | 'loading'>('select');
  const [existingResume, setExistingResume] = useState<{ full_name?: string; email?: string } | null>(null);
  const [buildMethod, setBuildMethod] = useState<'ai' | 'manual'>('manual');

  // AI form fields
  const [name,        setName]        = useState('');
  const [email,       setEmail]       = useState('');
  const [country,     setCountry]     = useState(DEFAULT_COUNTRY);
  const [phone,       setPhone]       = useState('');
  const [location,    setLocation]    = useState('');
  const [rawText,     setRawText]     = useState('');
  const [pickerOpen,  setPickerOpen]  = useState(false);
  const [pickerSearch, setPickerSearch] = useState('');
  // Point 5: optionally fold the uploaded profile resume into the AI generation.
  const [hasUploadedResume,      setHasUploadedResume]      = useState(false);
  const [includeUploadedResume,  setIncludeUploadedResume]  = useState(false);
  // Set when the user arrived by tapping "Enhance My Résumé" on the score popup. It drives the
  // prefill + the "anything to add?" prompt, and nothing else — a normal visit is untouched.
  const [scoreEntry, setScoreEntry] = useState<{ score: number; free: boolean; improvements: string[] } | null>(null);
  // The next POST is a REGENERATE (free plan: exactly one). A ref, not state — it is read inside
  // an async handler right after being set, where state would still be stale.
  const regenPendingRef = React.useRef(false);
  // The posting this build is for, and the listing the user pasted for it (device-local).
  const jobTargetRef = React.useRef<any>(null);
  const jobListingRef = React.useRef<any>(null);
  /** The `job` block the server tailors against — undefined when this is a generic build. */
  const jobForRequest = () => {
    const t = jobTargetRef.current; const l = jobListingRef.current;
    if (!t && !l) return undefined;
    return {
      title: t?.role || '', company: t?.company || '',
      url: l?.jobUrl || t?.applyUrl || '', description: l?.jobText || '',
    };
  };
  const [pulling, setPulling] = useState(false);

  // Runs every time screen gains focus
  useFocusEffect(useCallback(() => {
    (async () => {

      // ── 0. Arrived from the résumé-score popup ──────────────────────────────
      // The promise on that button was "we will improve YOUR résumé", so the box must not open
      // empty. Pull their current résumé in as prose, then ask what to add. The key is consumed
      // immediately so backing out and returning does not silently re-prefill over their edits.
      const entryRaw = await AsyncStorage.getItem('resume_builder_entry').catch(() => null);
      if (entryRaw) {
        await AsyncStorage.removeItem('resume_builder_entry').catch(() => {});
        try {
          const e = JSON.parse(entryRaw);
          // The posting Home was pointing at. Held for the generate call so the resume is written
          // against THIS job rather than against the company in general.
          if (e && e.target && (e.target.company || e.target.role)) {
            jobTargetRef.current = e.target;
            loadJobListing(e.target).then((l) => { if (l) jobListingRef.current = l; }).catch(() => {});
          }
          // ── The Home card's one-tap lane: uploaded resume + photo → straight to a built
          // resume. No uploaded resume → walk them to the upload first (the AI has nothing to
          // rebuild from); missing photo is fine — most designs render initials instead.
          if (e && e.autoBuild) {
            setBuildMethod('ai');
            setMode('ai');
            await AsyncStorage.setItem('resumeBuilderMethod', 'ai').catch(() => {});
            setPulling(true);
            const [pulled, prof] = await Promise.all([
              fetchResumeSourceText(),
              (async () => {
                try {
                  const raw0 = await SecureStore.getItemAsync('userSession');
                  const tok = JSON.parse(raw0 || '{}')?.token;
                  if (!tok) return {} as any;
                  const r0 = await fetch(`${API_BASE}/users/profile`, { headers: { Authorization: `Bearer ${tok}` } });
                  return r0.ok ? await r0.json() : {};
                } catch { return {}; }
              })(),
            ]);
            setPulling(false);
            if (!prof.resume || !pulled || pulled.trim().length < 30) {
              Alert.alert(
                'Upload your resume first',
                'To build your new resume, upload your current one — the AI rebuilds it from there. A profile photo is optional but makes the designs shine.',
                [
                  { text: 'Not now', style: 'cancel' },
                  { text: 'Upload resume', onPress: async () => {
                      await AsyncStorage.setItem('onboarding_focus_target', 'resume').catch(() => {});
                      router.back();
                  } },
                ],
              );
            } else {
              if (typeof e.score === 'number') setScoreEntry({ score: Number(e.score) || 0, free: !!e.free, improvements: [] });
              setRawText(pulled);
              autoGenerate({
                name: prof.fullName || '', email: prof.email || '',
                phone: prof.phone || '', location: prof.address || '',
                rawText: pulled, includeUploaded: true,
              });
            }
            return;
          }
          if (e && e.from === 'resume_score') {
            setScoreEntry({ score: Number(e.score) || 0, free: !!e.free, improvements: Array.isArray(e.improvements) ? e.improvements : [] });
            setBuildMethod('ai');
            setMode('ai');
            await AsyncStorage.setItem('resumeBuilderMethod', 'ai').catch(() => {});
            setPulling(true);
            const pulled = await fetchResumeSourceText();
            setPulling(false);
            // Only ever ADD to what is there. Overwriting text the user already typed would
            // destroy work in the one flow where they are most likely to have typed something.
            if (pulled) setRawText((t) => (t && t.trim().length > 30 ? t : plainStory(pulled)));
          }
        } catch {}
      }

      // ── 1. Handle "Regenerate" flag set by preview screen ───────────────────
      const action = await AsyncStorage.getItem('resumeBuilderAction').catch(() => null);
      if (action === 'regenerate') {
        await AsyncStorage.removeItem('resumeBuilderAction').catch(() => {});
        regenPendingRef.current = true;   // the server counts this against the free allowance
        // ⚠️ Regenerate SHOWS the Tell-us-your-story form, prefilled — it does not auto-run.
        // The one-tap auto-regenerate shipped in b195 and was reverted on direct feedback: the
        // user adjusts the story before the AI re-runs. isRegenerate stays armed so the server
        // still counts the eventual Generate as the free regeneration.
        const formRaw = await AsyncStorage.getItem('resumeBuilderFormData').catch(() => null);
        const d = formRaw ? JSON.parse(formRaw) : {};
        if (d.name)     setName(d.name);
        if (d.email)    setEmail(d.email);
        // restore the saved country, then show just the bare number
        if (d.countryDial || d.countryName) setCountry(findCountry(d.countryName, d.countryDial));
        if (d.phone)    setPhone(stripDial(d.phone));
        if (d.location) setLocation(d.location);
        if (d.rawText) {
          setRawText(plainStory(d.rawText));
        } else {
          // A resume built through the auto lane may predate the saved-form write — pull the
          // uploaded resume's text so the story box is never empty on a regenerate.
          setPulling(true);
          const pulled = await fetchResumeSourceText().catch(() => '');
          setPulling(false);
          if (pulled) setRawText(plainStory(pulled));
        }
        setBuildMethod('ai');
        setMode('ai');
        return;
      }

      // ── 2. Reset mid-generation spinner ─────────────────────────────────────
      setMode(prev => prev === 'loading' ? 'ai' : prev);

      // ── 3. Restore form fields — saved form data first, profile as fallback ────
      const formRaw = await AsyncStorage.getItem('resumeBuilderFormData').catch(() => null);
      const hasFormData = !!formRaw;

      // Parse saved form data
      const saved = formRaw ? JSON.parse(formRaw) : {};

      // Fetch profile from API for auto-fill
      let profile: Record<string, string> = {};
      try {
        const sessionRaw = await SecureStore.getItemAsync('userSession');
        const token = JSON.parse(sessionRaw || '{}')?.token;
        if (token) {
          const pRes = await fetch(`${API_BASE}/users/profile`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (pRes.ok) profile = await pRes.json();
        }
      } catch {}

      // Point 5: show the "include uploaded resume" option only when one exists on file.
      setHasUploadedResume(!!profile.resume);

      // Helper: pick saved value first, then profile, then keep current state
      const pick = (saved: string, profileVal: string) => saved || profileVal || '';

      // For phone: keep only the bare number (strip any dial code from saved or profile)
      const profilePhone = stripDial(profile.phone || '');

      // Restore the saved country (only if the user hasn't already picked one this session)
      if (saved.countryDial || saved.countryName) {
        setCountry(c => (c === DEFAULT_COUNTRY ? findCountry(saved.countryName, saved.countryDial) : c));
      }

      setName(n     => n || pick(saved.name,     profile.fullName || ''));
      setEmail(e    => e || pick(saved.email,    profile.email    || ''));
      setPhone(p    => p || stripDial(pick(saved.phone, profilePhone)));
      setLocation(l => l || pick(saved.location, profile.address  || ''));
      if (saved.rawText) setRawText(saved.rawText);

      // ── 4. Determine build method (3-tier fallback) ──────────────────────────
      // Tier 1: explicit AsyncStorage key (set on every generate/save)
      const storedMethod = await AsyncStorage.getItem('resumeBuilderMethod').catch(() => null);
      if (storedMethod === 'ai' || storedMethod === 'manual') {
        setBuildMethod(storedMethod);
      } else {
        // Tier 2: DB _buildMethod tag
        // (checked inside the DB fetch below — handled there)

        // Tier 3 (final fallback): if the user has ever used the AI form, assume AI
        if (hasFormData) {
          setBuildMethod('ai');
          await AsyncStorage.setItem('resumeBuilderMethod', 'ai').catch(() => {});
        }
      }

      // ── 5. Load existing resume from DB ──────────────────────────────────────
      try {
        const sessionRaw = await SecureStore.getItemAsync('userSession');
        const token = JSON.parse(sessionRaw || '{}')?.token;
        if (!token) return;
        const res = await fetch(`${API_BASE}/resume-builder`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const json = await res.json();
        if (json.resumeData?.personal_info) {
          setExistingResume(json.resumeData.personal_info);
          // Tier 2 fallback: use DB tag if AsyncStorage had nothing
          if (!storedMethod && json.resumeData._buildMethod) {
            setBuildMethod(json.resumeData._buildMethod);
            await AsyncStorage.setItem('resumeBuilderMethod', json.resumeData._buildMethod).catch(() => {});
          }
        } else {
          setExistingResume(null);
        }
      } catch {}
    })();
  }, []));

  // Build Manually → seed the sample resume (with the user's real contact details) and open the
  // editable preview so they create their resume by tapping & replacing the example values.
  const startManualBuild = async () => {
    const dial = (country && (country as any).dial) ? `${(country as any).dial} ` : '';
    const sample = {
      ...SAMPLE_RESUME,
      personal_info: {
        ...SAMPLE_RESUME.personal_info,
        full_name: name || SAMPLE_RESUME.personal_info.full_name,
        email:     email || SAMPLE_RESUME.personal_info.email,
        phone:     phone ? `${dial}${phone}`.trim() : SAMPLE_RESUME.personal_info.phone,
        location:  location || SAMPLE_RESUME.personal_info.location,
      },
    };
    await AsyncStorage.setItem('resumeBuilderData', JSON.stringify(sample)).catch(() => {});
    await AsyncStorage.setItem('resumeBuilderMethod', 'manual').catch(() => {});
    await AsyncStorage.setItem('resumeBuilderSeedSample', '1').catch(() => {});
    router.push('/(resume-builder)/preview');
  };

  // Loading animation
  const dotAnim = useRef(new Animated.Value(0)).current;
  const [loadingMsg, setLoadingMsg] = useState('Extracting your career story…');
  const loadingMsgs = [
    'Extracting your career story…',
    'Scanning for project links…',
    'Enriching project details…',
    'Crafting professional summaries…',
    'Finalising your resume…',
  ];

  function startLoadingAnim() {
    let idx = 0;
    const iv = setInterval(() => {
      idx = (idx + 1) % loadingMsgs.length;
      setLoadingMsg(loadingMsgs[idx]);
    }, 2800);
    Animated.loop(Animated.sequence([
      Animated.timing(dotAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
      Animated.timing(dotAnim, { toValue: 0, duration: 600, useNativeDriver: true }),
    ])).start();
    return iv;
  }

  // The screen is gone: a build still polling must not push the preview over whatever the user went to (the build
  // itself carries on server-side, is saved and charged as before, and is here the next time they open the builder).
  const leftRef = useRef(false);
  useEffect(() => { leftRef.current = false; return () => { leftRef.current = true; }; }, []);

  /** What a build ended in, told the same way by both lanes. `rerun` repeats it with the SAME build id. */
  function settleBuild(outcome: BuildOutcome, rerun: () => void, onDone: (resumeData: any) => Promise<void>) {
    if (leftRef.current) return;
    if (outcome.kind === 'done') { onDone(outcome.resumeData).catch(() => {}); return; }
    setMode('ai');
    if (outcome.kind === 'regen_limit') {
      Alert.alert('Regeneration used', outcome.message,
        [{ text: 'Not now', style: 'cancel' }, { text: 'See plans', onPress: () => router.push('/(subscription)/plans' as never) }]);
      return;
    }
    if (outcome.kind === 'quota') {
      // Quota exhausted (trial or plan) → route to Plans; legacy credit users see the same sheet.
      Alert.alert('Limit reached', outcome.message,
        [{ text: 'Not now', style: 'cancel' }, { text: 'See plans', onPress: () => router.push('/(subscription)/plans' as never) }]);
      return;
    }
    if (outcome.kind === 'late') {
      // ⚠️ NEVER "tap Generate again" here: the build is still running and will be charged once it lands. Keep waiting
      // follows THAT build's job (rerunOf carries its track) — never a second POST, however late the tap.
      Alert.alert('Still building…',
        'Your resume is taking longer than usual. It is still being built — tap Keep waiting to pick it up. You will not be charged twice.',
        [{ text: 'Not now', style: 'cancel' }, { text: 'Keep waiting', onPress: rerun }]);
      return;
    }
    // failed: Try Again repeats the SAME build when it may already be running (no answer reached us), else a new one.
    Alert.alert('Generation failed', outcome.message,
      [{ text: 'Not now', style: 'cancel' }, { text: 'Try Again', onPress: rerun }]);
  }

  // Generation with EXPLICIT values — the auto lanes run before React state has settled, so
  // reading component state here would post stale/empty fields.
  async function autoGenerate(v: { name: string; email: string; phone: string; location: string; rawText: string; includeUploaded: boolean }, buildId: string = newBuildId(), track?: BuildTrack) {
    setMode('loading');
    const iv = startLoadingAnim();
    const authHeader = await getAuthHeader();
    let devHeaders: Record<string, string> = {};
    try { devHeaders = await require('../../services/deviceId').deviceHeader(); } catch {}
    const wasRegen = regenPendingRef.current;
    const outcome = await runResumeBuild(
      { name: v.name, email: v.email, phone: v.phone, location: v.location,
        rawText: v.rawText, includeUploadedResume: v.includeUploaded, isRegenerate: wasRegen, job: jobForRequest() },
      buildId, { 'Content-Type': 'application/json', ...authHeader, ...devHeaders }, () => leftRef.current, track,
    );
    clearInterval(iv);
    settleBuild(outcome, () => autoGenerate(v, ...rerunOf(outcome, buildId)), async (resumeData) => {
      regenPendingRef.current = false;
      await AsyncStorage.setItem('resumeBuilderData', JSON.stringify(resumeData));
      await AsyncStorage.setItem('resumeBuilderMethod', 'ai').catch(() => {});
      await AsyncStorage.setItem('resumeBuilderFormData', JSON.stringify({
        name: v.name, email: v.email, phone: stripDial(v.phone), location: v.location, rawText: v.rawText,
      })).catch(() => {});
      setBuildMethod('ai');
      router.push('/(resume-builder)/preview');
    });
  }

  // The Generate button. A TAP is a new build (a fresh id); only the alert's Try Again / Keep waiting repeats one.
  function handleAIGenerate() { generateFromStory(newBuildId()); }

  async function generateFromStory(buildId: string, track?: BuildTrack) {
    if (!rawText.trim() || rawText.trim().length < 30) {
      Alert.alert('More detail needed', 'Please share more about your experience (at least a few sentences).');
      return;
    }
    // Save form data so regenerate from preview can pre-fill.
    // Store the BARE number (no dial) so the country code is only ever added once.
    const cleanPhone = stripDial(phone);
    const fullPhone  = cleanPhone ? `${country.dial} ${cleanPhone}` : '';
    await AsyncStorage.setItem('resumeBuilderFormData', JSON.stringify({ name, email, phone: cleanPhone, location, rawText, countryDial: country.dial, countryName: country.name })).catch(() => {})
    setMode('loading');
    const iv = startLoadingAnim();

    const authHeader = await getAuthHeader();
    // device id → per-device trial quota on the server (one 7-day trial per phone)
    let devHeaders: Record<string, string> = {};
    try { devHeaders = await require('../../services/deviceId').deviceHeader(); } catch {}
    const outcome = await runResumeBuild(
      { name, email, phone: fullPhone, location, rawText, includeUploadedResume: hasUploadedResume && includeUploadedResume, isRegenerate: regenPendingRef.current, job: jobForRequest() },
      buildId, { 'Content-Type': 'application/json', ...authHeader, ...devHeaders }, () => leftRef.current, track,
    );
    clearInterval(iv);
    settleBuild(outcome, () => generateFromStory(...rerunOf(outcome, buildId)), async (resumeData) => {
      regenPendingRef.current = false;
      await AsyncStorage.setItem('resumeBuilderData', JSON.stringify(resumeData));
      await AsyncStorage.setItem('resumeBuilderMethod', 'ai').catch(() => {});
      setBuildMethod('ai');
      router.push('/(resume-builder)/preview');
    });
  }

  // ── SELECT MODE ─────────────────────────────────────────────────────────────
  if (mode === 'select') {
    return (
      <SafeAreaView style={s.safe} edges={['top']}>
        {/* Top bar */}
        <View style={s.topBar}>
          <TouchableOpacity onPress={() => router.back()} style={s.backPill} activeOpacity={0.8}>
            <Ionicons name="arrow-back" size={14} color={T.ink} />
            <Text style={s.backPillText}>Back</Text>
          </TouchableOpacity>
          <View style={s.wordmark} pointerEvents="none">
            <Image source={require('../../assets/images/logo_img.png')} style={s.logoImg} resizeMode="contain" />
            <Text style={s.wordmarkText}>CV<Text style={s.wordmarkBlue}>Applyr</Text></Text>
          </View>
          <View style={{ width: 70 }} />
        </View>

        <ScrollView contentContainerStyle={s.selectScroll} showsVerticalScrollIndicator={false}>
          {/* Hero */}
          <View style={s.heroCard}>
            <LinearGradient colors={[T.cyan, T.blue]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.heroBadge}>
              <Ionicons name="document-text" size={28} color="#fff" />
            </LinearGradient>
            <Text style={s.heroTitle}>Resume Builder</Text>
            <Text style={s.heroSub}>Create a job-ready resume in minutes — powered by AI or built manually.</Text>
          </View>

          {/* Existing Resume Card */}
          {existingResume && (
            <View style={s.existingCard}>
              <View style={s.existingLeft}>
                <LinearGradient colors={[T.emerald, '#059669']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.existingIcon}>
                  <Ionicons name="document-text" size={20} color="#fff" />
                </LinearGradient>
                <View style={s.existingText}>
                  <Text style={s.existingTitle}>{existingResume.full_name || 'My Resume'}</Text>
                  <Text style={s.existingSub}>{existingResume.email || 'Resume saved'}</Text>
                </View>
              </View>
              <View style={s.existingActions}>
                <TouchableOpacity style={s.existingViewBtn} onPress={() => router.push('/(resume-builder)/preview')} activeOpacity={0.8}>
                  <Text style={s.existingViewText}>View</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={s.existingEditBtn}
                  onPress={() => buildMethod === 'ai' ? setMode('ai') : router.push('/(resume-builder)/preview')}
                  activeOpacity={0.8}
                >
                  <Text style={s.existingEditText}>Edit</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* AI Card */}
          <TouchableOpacity style={s.modeCard} onPress={() => setMode('ai')} activeOpacity={0.88}>
            <LinearGradient colors={[T.cyan, T.blue]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={s.modeIconWrap}>
              <Ionicons name="flash" size={22} color="#fff" />
            </LinearGradient>
            <View style={s.modeTextWrap}>
              <Text style={s.modeTitle}>Build with AI  <Text style={s.modeBadge}>Recommended</Text></Text>
              <Text style={s.modeSub}>Paste any rough notes, old CV snippets, or career story — our AI structures it into a polished resume instantly.</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={T.faint} />
          </TouchableOpacity>

          {/* Manual Card */}
          <TouchableOpacity style={s.modeCard} onPress={startManualBuild} activeOpacity={0.88}>
            <View style={[s.modeIconWrap, { backgroundColor: T.bgSoft }]}>
              <Ionicons name="create-outline" size={22} color={T.blue} />
            </View>
            <View style={s.modeTextWrap}>
              <Text style={s.modeTitle}>Build Manually</Text>
              <Text style={s.modeSub}>Start from a sample resume and tap any section to replace it with your details.</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={T.faint} />
          </TouchableOpacity>

          {/* What you get */}
          <View style={s.featureCard}>
            <Text style={s.featureTitle}>What you get</Text>
            {[
              ['checkmark-circle', T.emerald, 'Professional summary written by AI'],
              ['checkmark-circle', T.emerald, 'Impact-driven bullet points for every role'],
              ['checkmark-circle', T.emerald, 'Auto-enriched project descriptions from your links'],
              ['checkmark-circle', T.emerald, 'Downloadable PDF resume'],
            ].map(([icon, color, text], i) => (
              <View key={i} style={s.featureRow}>
                <Ionicons name={icon as any} size={16} color={color as string} />
                <Text style={s.featureText}>{text as string}</Text>
              </View>
            ))}
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ── LOADING ──────────────────────────────────────────────────────────────────
  if (mode === 'loading') {
    return (
      <SafeAreaView style={[s.safe, { justifyContent: 'center', alignItems: 'center' }]} edges={['top']}>
        <LinearGradient colors={[T.cyan, T.blue]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.loadingIcon}>
          <Ionicons name="flash" size={36} color="#fff" />
        </LinearGradient>
        <ActivityIndicator size="large" color={T.blue} style={{ marginTop: 28 }} />
        <Text style={s.loadingTitle}>Building Your Resume</Text>
        <Text style={s.loadingMsg}>{loadingMsg}</Text>
        <View style={s.loadingSteps}>
          {['Extracting URLs', 'Enriching Projects', 'AI Generation', 'Structuring Data'].map((step, i) => (
            <View key={i} style={s.loadingStep}>
              <Animated.View style={[s.loadingDot, { opacity: dotAnim }]} />
              <Text style={s.loadingStepText}>{step}</Text>
            </View>
          ))}
        </View>
      </SafeAreaView>
    );
  }

  // ── AI FORM ──────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.select({ ios: 'padding', android: undefined })}>
        {/* Top bar */}
        <View style={s.topBar}>
          <TouchableOpacity onPress={() => setMode('select')} style={s.backPill} activeOpacity={0.8}>
            <Ionicons name="arrow-back" size={14} color={T.ink} />
            <Text style={s.backPillText}>Back</Text>
          </TouchableOpacity>
          <View style={s.wordmark} pointerEvents="none">
            <Image source={require('../../assets/images/logo_img.png')} style={s.logoImg} resizeMode="contain" />
            <Text style={s.wordmarkText}>CV<Text style={s.wordmarkBlue}>Applyr</Text></Text>
          </View>
          <View style={{ width: 70 }} />
        </View>

        <ScrollView contentContainerStyle={s.aiScroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          <View style={s.aiHero}>
            <Text style={s.aiHeroTitle}>Tell Us Your Story</Text>
            <Text style={s.aiHeroSub}>We'll structure it into a professional resume using AI</Text>
          </View>

          {/* Basic info */}
          <View style={s.card}>
            <Text style={s.sectionLabel}>BASIC DETAILS</Text>

            {/* Name */}
            <View style={s.inputRow}>
              <Ionicons name="person-outline" size={16} color={T.blue} style={s.inputIcon} />
              <TextInput style={s.input} placeholder="Full Name" placeholderTextColor={T.faint} value={name} onChangeText={setName} autoCapitalize="words" />
            </View>

            {/* Email */}
            <View style={s.inputRow}>
              <Ionicons name="mail-outline" size={16} color={T.blue} style={s.inputIcon} />
              <TextInput style={s.input} placeholder="Email" placeholderTextColor={T.faint} value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
            </View>

            {/* Country picker */}
            <TouchableOpacity style={s.inputRow} onPress={() => { setPickerSearch(''); setPickerOpen(true); }} activeOpacity={0.7}>
              <Ionicons name="globe-outline" size={16} color={T.blue} style={s.inputIcon} />
              <Text style={[s.input, { paddingTop: 0, lineHeight: 20, color: T.ink }]}>
                {country.flag}  {country.name}
              </Text>
              <Ionicons name="chevron-down" size={14} color={T.faint} />
            </TouchableOpacity>

            {/* Phone with non-editable country code */}
            <View style={s.inputRow}>
              <Ionicons name="call-outline" size={16} color={T.blue} style={s.inputIcon} />
              <View style={s.phoneDialBox}>
                <Text style={s.phoneDialText}>{country.dial}</Text>
              </View>
              <TextInput
                style={[s.input, { marginLeft: 8 }]}
                placeholder="Phone number"
                placeholderTextColor={T.faint}
                value={phone}
                onChangeText={setPhone}
                keyboardType="phone-pad"
              />
            </View>

            {/* Location */}
            <View style={[s.inputRow, { borderBottomWidth: 0 }]}>
              <Ionicons name="location-outline" size={16} color={T.blue} style={s.inputIcon} />
              <TextInput style={s.input} placeholder="City, Country" placeholderTextColor={T.faint} value={location} onChangeText={setLocation} autoCapitalize="words" />
            </View>
          </View>

          {/* Country picker modal */}
          <Modal visible={pickerOpen} animationType="slide" transparent onRequestClose={() => setPickerOpen(false)}>
            <View style={s.modalOverlay}>
              <View style={s.modalSheet}>
                <View style={s.modalHeader}>
                  <Text style={s.modalTitle}>Select Country</Text>
                  <TouchableOpacity onPress={() => setPickerOpen(false)} style={s.modalClose}>
                    <Ionicons name="close" size={20} color={T.ink} />
                  </TouchableOpacity>
                </View>
                <View style={s.searchRow}>
                  <Ionicons name="search-outline" size={15} color={T.faint} />
                  <TextInput
                    style={s.searchInput}
                    placeholder="Search country..."
                    placeholderTextColor={T.faint}
                    value={pickerSearch}
                    onChangeText={setPickerSearch}
                    autoCapitalize="none"
                  />
                </View>
                <FlatList
                  data={COUNTRIES.filter(c => c.name.toLowerCase().includes(pickerSearch.toLowerCase()))}
                  keyExtractor={c => c.name}
                  keyboardShouldPersistTaps="handled"
                  renderItem={({ item }) => (
                    <TouchableOpacity
                      style={[s.countryRow, item.name === country.name && s.countryRowActive]}
                      onPress={() => { setCountry(item); setPickerOpen(false); }}
                      activeOpacity={0.7}
                    >
                      <Text style={s.countryFlag}>{item.flag}</Text>
                      <Text style={s.countryName}>{item.name}</Text>
                      <Text style={s.countryDial}>{item.dial}</Text>
                      {item.name === country.name && <Ionicons name="checkmark" size={16} color={T.blue} />}
                    </TouchableOpacity>
                  )}
                />
              </View>
            </View>
          </Modal>

          {/* ── Arrived from the résumé score: their résumé is already in the box ────────────
              This is the "would you like to add more details before generating?" step. It replaces
              the generic hint rather than sitting above it, because the generic hint ("paste
              anything") is wrong advice once the box is already full of their own résumé. */}
          {!!scoreEntry && (
            <View style={s.scoreEntryCard}>
              <View style={s.scoreEntryHead}>
                <View style={s.scoreEntryBadge}>
                  <Text style={s.scoreEntryBadgeNum}>{scoreEntry.score}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={s.scoreEntryTitle}>
                    {pulling ? 'Pulling in your résumé…' : 'Your résumé is loaded below'}
                  </Text>
                  <Text style={s.scoreEntrySub}>
                    Anything to add before we rewrite it? A recent role, a certification, or real
                    numbers behind your work — all of it lifts the score.
                  </Text>
                </View>
              </View>
              {scoreEntry.improvements.length > 0 && (
                <View style={s.scoreEntryChips}>
                  {scoreEntry.improvements.map((t, i) => (
                    <View key={i} style={s.scoreEntryChip}>
                      <Ionicons name="arrow-up-circle" size={12} color={T.emerald} />
                      <Text style={s.scoreEntryChipText} numberOfLines={1}>{t}</Text>
                    </View>
                  ))}
                </View>
              )}
              {scoreEntry.free && (
                <View style={s.scoreEntryFree}>
                  <Ionicons name="gift" size={13} color={T.emerald} />
                  <Text style={s.scoreEntryFreeText}>This rewrite is on us — no credits will be used.</Text>
                </View>
              )}
            </View>
          )}

          {/* Story textarea */}
          <View style={s.card}>
            <Text style={s.sectionLabel}>{scoreEntry ? 'YOUR RÉSUMÉ — ADD ANYTHING NEW' : 'YOUR CAREER STORY'}</Text>
            <Text style={s.storyHint}>
              {scoreEntry
                ? 'Edit anything that is out of date, and add what is missing. We will rewrite the whole thing from this.'
                : 'Paste anything — old resume text, LinkedIn bio, rough notes about your jobs, projects, and education. The more detail, the better.'}
            </Text>
            <TextInput
              style={s.storyInput}
              placeholder={`e.g.\n"Worked at TechCorp as a backend dev for 3 years. Built a REST API for payments. Also did an open-source project at github.com/me/myapp — it's a task manager built with React + Node.\n\nEducation: B.Tech Computer Science, Delhi University, 2020."`}
              placeholderTextColor={T.faint}
              value={rawText}
              onChangeText={setRawText}
              multiline
              textAlignVertical="top"
            />
            <View style={s.storyHintRow}>
              <Ionicons name="link-outline" size={13} color={T.cyan} />
              <Text style={s.storyHintSmall}>Include any GitHub / portfolio links — we'll auto-enrich them</Text>
            </View>
          </View>

          {/* Point 5: merge uploaded profile resume (only shown when one exists) */}
          {hasUploadedResume && (
            <TouchableOpacity style={s.checkCard} activeOpacity={0.85} onPress={() => setIncludeUploadedResume(v => !v)}>
              <Ionicons
                name={includeUploadedResume ? 'checkbox' : 'square-outline'}
                size={22}
                color={includeUploadedResume ? T.blue : T.faint}
              />
              <View style={s.checkTextWrap}>
                <Text style={s.checkLabel}>Include my uploaded resume</Text>
                <Text style={s.checkSub}>Merge the resume from your Profile with the story above, so the AI uses both.</Text>
              </View>
            </TouchableOpacity>
          )}

          {/* Generate button */}
          <TouchableOpacity onPress={handleAIGenerate} activeOpacity={0.88} style={s.generateOuter}>
            <LinearGradient colors={[T.cyan, T.blue]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={s.generateBtn}>
              <Ionicons name="flash" size={18} color="#fff" />
              <Text style={s.generateText}>Generate My Resume with AI</Text>
              {resumesLeft != null && (
                <View style={s.creditBadge}>
                  <Text style={s.creditBadgeText}>{resumesLeft} left</Text>
                </View>
              )}
            </LinearGradient>
          </TouchableOpacity>
          <Text style={s.creditNote}>{resumesLeft == null ? 'Included in your plan' : resumesLeft > 0 ? `${resumesLeft} generation${resumesLeft === 1 ? '' : 's'} left this period` : 'Limit reached — see plans for more'}</Text>
          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  // ── résumé-score entry banner ──────────────────────────────────────────────
  scoreEntryCard: {
    marginHorizontal: 16, marginBottom: 14, padding: 16, borderRadius: 20,
    backgroundColor: '#F0FDF9', borderWidth: 1, borderColor: 'rgba(16,185,129,0.22)',
  },
  scoreEntryHead: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  scoreEntryBadge: {
    width: 42, height: 42, borderRadius: 14, backgroundColor: '#FFFFFF',
    alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: 'rgba(16,185,129,0.35)',
  },
  scoreEntryBadgeNum: { fontSize: 17, fontWeight: '800', color: T.emerald, letterSpacing: -0.5 },
  scoreEntryTitle: { fontSize: 15.5, fontWeight: '800', color: T.ink, letterSpacing: -0.3 },
  scoreEntrySub: { fontSize: 12.8, color: T.muted, lineHeight: 18, marginTop: 3 },
  scoreEntryChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 12 },
  scoreEntryChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: '100%',
    backgroundColor: '#FFFFFF', borderRadius: 999, paddingHorizontal: 9, paddingVertical: 5,
    borderWidth: 1, borderColor: 'rgba(16,185,129,0.20)',
  },
  scoreEntryChipText: { fontSize: 11.5, fontWeight: '700', color: T.inkSoft, flexShrink: 1 },
  scoreEntryFree: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12 },
  scoreEntryFreeText: { fontSize: 12.3, fontWeight: '700', color: T.emerald },

  safe:         { flex: 1, backgroundColor: T.bg },
  topBar:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10, backgroundColor: T.bg },
  backPill:     { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: T.surface, borderRadius: 20, paddingVertical: 7, paddingHorizontal: 12, shadowColor: T.ink, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.07, shadowRadius: 8, elevation: 3 },
  backPillText: { fontSize: 13, fontWeight: '600', color: T.ink },
  wordmark:     { position: 'absolute', left: 0, right: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, zIndex: 0 },
  logoImg:      { width: 22, height: 22 },
  wordmarkText: { fontSize: 16, fontWeight: '800', color: T.ink, letterSpacing: -0.3 },
  wordmarkBlue: { color: T.blue },

  // Select mode
  selectScroll:      { padding: 16, gap: 14, paddingBottom: 40 },
  existingCard:      { backgroundColor: T.surface, borderRadius: 20, padding: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1.5, borderColor: '#10B981', shadowColor: T.ink, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.07, shadowRadius: 12, elevation: 3 },
  existingLeft:      { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 },
  existingIcon:      { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  existingText:      { flex: 1 },
  existingTitle:     { fontSize: 14, fontWeight: '700', color: T.ink },
  existingSub:       { fontSize: 11, color: T.muted, marginTop: 1 },
  existingActions:   { flexDirection: 'row', gap: 8, flexShrink: 0 },
  existingViewBtn:   { backgroundColor: '#10B981', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 7 },
  existingViewText:  { fontSize: 12, fontWeight: '700', color: '#fff' },
  existingEditBtn:   { backgroundColor: 'rgba(16,185,129,0.1)', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 7, borderWidth: 1, borderColor: 'rgba(16,185,129,0.3)' },
  existingEditText:  { fontSize: 12, fontWeight: '700', color: '#10B981' },
  heroCard:     { backgroundColor: T.surface, borderRadius: 24, padding: 24, alignItems: 'center', gap: 10, shadowColor: T.ink, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.08, shadowRadius: 16, elevation: 4 },
  heroBadge:    { width: 64, height: 64, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  heroTitle:    { fontSize: 22, fontWeight: '800', color: T.ink, letterSpacing: -0.5 },
  heroSub:      { fontSize: 14, color: T.muted, textAlign: 'center', lineHeight: 20 },
  modeCard:     { backgroundColor: T.surface, borderRadius: 20, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 14, shadowColor: T.ink, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.07, shadowRadius: 12, elevation: 3 },
  modeIconWrap: { width: 48, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  modeTextWrap: { flex: 1, gap: 3 },
  modeTitle:    { fontSize: 15, fontWeight: '700', color: T.ink },
  modeBadge:    { fontSize: 10, fontWeight: '700', color: T.cyan, backgroundColor: 'rgba(6,182,212,0.12)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, overflow: 'hidden' },
  modeSub:      { fontSize: 12, color: T.muted, lineHeight: 17 },
  featureCard:  { backgroundColor: T.surface, borderRadius: 20, padding: 18, gap: 10, shadowColor: T.ink, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.07, shadowRadius: 12, elevation: 3 },
  featureTitle: { fontSize: 13, fontWeight: '700', color: T.ink, marginBottom: 4 },
  featureRow:   { flexDirection: 'row', alignItems: 'center', gap: 8 },
  featureText:  { fontSize: 13, color: T.inkSoft ?? T.muted, flex: 1 },

  // Loading
  loadingIcon:  { width: 80, height: 80, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  loadingTitle: { fontSize: 20, fontWeight: '800', color: T.ink, marginTop: 16, letterSpacing: -0.3 },
  loadingMsg:   { fontSize: 14, color: T.muted, marginTop: 6, textAlign: 'center', paddingHorizontal: 40 },
  loadingSteps: { marginTop: 28, gap: 10, alignSelf: 'stretch', paddingHorizontal: 40 },
  loadingStep:  { flexDirection: 'row', alignItems: 'center', gap: 10 },
  loadingDot:   { width: 8, height: 8, borderRadius: 4, backgroundColor: T.cyan },
  loadingStepText: { fontSize: 13, color: T.muted },

  // AI form
  aiScroll:   { padding: 16, gap: 14, paddingBottom: 40 },
  aiHero:     { marginBottom: 4 },
  aiHeroTitle:{ fontSize: 22, fontWeight: '800', color: T.ink, letterSpacing: -0.4 },
  aiHeroSub:  { fontSize: 13, color: T.muted, marginTop: 4 },
  card:       { backgroundColor: T.surface, borderRadius: 22, padding: 16, shadowColor: T.ink, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.07, shadowRadius: 16, elevation: 4, gap: 2 },
  sectionLabel: { fontSize: 10, fontWeight: '800', color: T.faint, letterSpacing: 1.2, marginBottom: 10 },
  inputRow:     { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: T.border, paddingVertical: 10, gap: 10 },
  inputIcon:    { width: 20 },
  input:        { flex: 1, fontSize: 14, color: T.ink, fontWeight: '500' },
  phoneDialBox: { backgroundColor: T.bgSoft, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: T.border },
  phoneDialText:{ fontSize: 13, fontWeight: '700', color: T.ink },
  // Country picker modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  modalSheet:   { backgroundColor: T.surface, borderTopLeftRadius: 28, borderTopRightRadius: 28, maxHeight: '75%', paddingBottom: Platform.select({ ios: 34, default: 16 }) },
  modalHeader:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: T.border },
  modalTitle:   { fontSize: 16, fontWeight: '800', color: T.ink },
  modalClose:   { width: 32, height: 32, borderRadius: 16, backgroundColor: T.bgSoft, alignItems: 'center', justifyContent: 'center' },
  searchRow:    { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginVertical: 10, backgroundColor: T.bgSoft, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: T.border },
  searchInput:  { flex: 1, fontSize: 14, color: T.ink },
  countryRow:   { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 13, gap: 12, borderBottomWidth: 1, borderBottomColor: T.border },
  countryRowActive: { backgroundColor: 'rgba(79,141,255,0.06)' },
  countryFlag:  { fontSize: 22 },
  countryName:  { flex: 1, fontSize: 14, fontWeight: '500', color: T.ink },
  countryDial:  { fontSize: 13, color: T.muted, fontWeight: '600' },
  storyHint:  { fontSize: 12, color: T.muted, lineHeight: 17, marginBottom: 10 },
  storyInput: { fontSize: 13, color: T.ink, lineHeight: 20, minHeight: 180, backgroundColor: T.bg, borderRadius: 14, padding: 12, borderWidth: 1, borderColor: T.border },
  storyHintRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 8 },
  storyHintSmall: { fontSize: 11, color: T.cyan, fontWeight: '600' },
  checkCard:    { backgroundColor: T.surface, borderRadius: 16, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12, shadowColor: T.ink, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.06, shadowRadius: 10, elevation: 2 },
  checkTextWrap:{ flex: 1, gap: 2 },
  checkLabel:   { fontSize: 14, fontWeight: '700', color: T.ink },
  checkSub:     { fontSize: 12, color: T.muted, lineHeight: 16 },
  generateOuter:   { borderRadius: 16, overflow: 'hidden', marginTop: 4 },
  generateBtn:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, height: 54, borderRadius: 16 },
  generateText:    { fontSize: 16, fontWeight: '800', color: '#fff' },
  creditBadge:     { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: 'rgba(0,0,0,0.2)', borderRadius: 10, paddingHorizontal: 7, paddingVertical: 3 },
  creditBadgeText: { fontSize: 11, fontWeight: '800', color: '#fff' },
  creditNote:      { fontSize: 11, color: T.faint, textAlign: 'center', marginTop: 6 },
});
