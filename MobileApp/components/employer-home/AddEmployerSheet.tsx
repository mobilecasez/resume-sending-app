// AI Hub — new feature. Safe to delete without affecting existing app.
//
// "Add employer" — the bottom sheet behind the + at the end of the employer row.
//
// Search an employer by name, paste a careers URL, or narrow by region; picking one hands off to
// the Job Hub's existing add flow.
//
// ⚠️ IT DELIBERATELY DOES NOT ADD THE EMPLOYER ITSELF. Adding one costs the user credits
// (app/(ai-hub)/index.tsx handleAddPill: a `company_search` cost precheck, then fetchJobMatches
// followed by deductSearchCredits), and that path also carries job-portal detection, LinkedIn URL
// handling, in-flight recovery across app restarts and the server's own error messages. Rebuilding
// any of that here would fork a MONEY path in two, so this sheet does only the free half —
// searching, which costs nothing — and hands the chosen name to the one audited flow.
//
// ⚠️ AN EMPLOYER IS A NAME, NOT A ROW IN OUR JOBS INDEX. This sheet used to "search" by running a
// JOB search and deduping the companies out of the rows, so an employer existed only if we had
// already crawled one of their postings. Measured: "Nordex" returned NOTHING at all, and "Siemens"
// returned the staffing agencies that repost their roles rather than Siemens. But nothing about
// writing a resume for Nordex requires Nordex to be in our index — the name is the whole
// requirement. So the lookup now asks the employer endpoint, and whatever the user typed is ALWAYS
// offered as the first row. That row is what makes "it wont miss any employer" true.
//
// ⚠️ EVERYTHING IN HERE STAYS FREE. The employer lookup is a read, the typed-name row only hands a
// string on, and the pasted listing is prompt context — none of it generates, and none of it
// deducts. Anything that costs belongs behind the Job Hub's audited add flow, above.
//
// ⚠️ ANIMATION DRIVER RULE (b126-128): transform/opacity, native driver, one tree.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Modal, TouchableOpacity, TextInput, ScrollView,
  ActivityIndicator, Animated, Easing, Keyboard, Platform,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';
import { E } from './theme';
import { API_BASE } from '../../config';
import { fetchDiscoverJobs } from '../../services/aiHubService';
import { fetchCountryOptions } from '../../services/interestsService';
import { track } from '../../services/analytics';

// Enough to tell two same-named companies apart: the site they hire from and where the role is.
// `source` says where the row came from, because the two are not equally solid: 'tracked' is an
// employer this app already follows, 'jobs' was only inferred from postings we happened to crawl.
export type EmployerHit = {
  name: string; domain: string | null; location: string | null; jobs: number;
  source?: 'tracked' | 'jobs';
};

const looksLikeUrl = (v: string) => /^https?:\/\//i.test(v) || /\.[a-z]{2,}(\/|$)/i.test(v.trim());

// What a search ASKED for. Region is part of it because "no postings indexed" is a per-region
// claim: the same name can be empty in Norway and full in Germany.
const askedKey = (term: string, ctry: string) => `${term.toLowerCase()}\u0000${ctry}`;

/**
 * The employer lookup — GET /discover/employers. Free: it reads employer records, renders nothing
 * and charges nothing.
 *
 * ⚠️ API_BASE IS READ INSIDE THE CALL ON PURPOSE. It is a live `let` binding in ../../config (an
 * admin can point the device at another environment at startup); snapshotting it into a
 * module-level const captures the pre-switch value and sends some requests to one database and
 * some to another.
 *
 * Throws on anything that is not a well-formed answer — the throw is the signal to fall back.
 */
async function fetchEmployerMatches(q: string, ctry: string, ms = 12000): Promise<EmployerHit[]> {
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
    // list instead of falling back.
    if (!r.ok) throw new Error(`employers_${r.status}`);
    const j = await r.json();
    if (!Array.isArray(j?.employers)) throw new Error('employers_shape');
    return j.employers
      .map((e: any): EmployerHit => ({
        name: String(e?.name || '').trim(),
        domain: e?.domain || null,
        location: e?.location || null,
        jobs: Number(e?.jobs) || 0,
        source: e?.source === 'tracked' ? 'tracked' : 'jobs',
      }))
      .filter((e: EmployerHit) => !!e.name)
      .slice(0, 12);
  } finally { clearTimeout(timer); }
}

/**
 * ⚠️ THE OLD SEARCH, KEPT ONLY AS A FALLBACK. It dedupes companies out of a JOB feed, so it can
 * only ever return employers whose postings we have already crawled — which is the exact bug the
 * report was about. It stays because the employer endpoint ships in its own deploy: until that
 * server is live, a 404 has to degrade to the previous behaviour rather than to an empty sheet.
 */
async function searchViaJobFeed(term: string, ctry: string): Promise<EmployerHit[]> {
  const r = await fetchDiscoverJobs({ q: term, country: ctry || '', limit: 50, sort: 'match' });
  const by = new Map<string, EmployerHit>();
  for (const j of ((r as any)?.jobs || [])) {
    const name = String(j.company || j.employer_name || '').trim();
    if (!name) continue;
    const k = name.toLowerCase();
    const prev = by.get(k);
    if (prev) {
      prev.jobs += 1;
      prev.domain = prev.domain || j.employer_domain || null;
      prev.location = prev.location || j.location || j.country || null;
      continue;
    }
    by.set(k, {
      name,
      domain: j.employer_domain || null,
      location: j.location || j.country || null,
      jobs: 1,
      source: 'jobs',
    });
  }
  return [...by.values()].sort((a, b) => b.jobs - a.jobs).slice(0, 12);
}

export default function AddEmployerSheet({
  visible, onClose, onPick, regionHint,
}: {
  visible: boolean;
  onClose: () => void;
  /**
   * The employer name or careers URL, plus — optionally — the actual posting they are applying
   * to. The listing is what makes the resume and the letter specific to THIS job rather than
   * generic to the company.
   */
  onPick: (value: string, extra?: { country?: string; jobUrl?: string; jobText?: string }) => void;
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
  // ⚠️ WHAT THE LAST SETTLED SEARCH ASKED FOR — not what is in the field. `busy` is only set
  // INSIDE search(), which runs 320ms after the last keystroke, so gating the zero-result row on
  // `!busy` flashed "No postings indexed for X yet" during the debounce — a factual claim about a
  // term the index had not been asked about yet.
  const [settled, setSettled] = useState('');
  // Set when the user says "not in the list" — the same field then takes a careers URL.
  const [urlMode, setUrlMode] = useState(false);
  // What they had typed when they went into urlMode, so backing out puts it back.
  const [keptName, setKeptName] = useState('');
  // The specific posting — optional, and free: it is prompt context, not another search.
  const [showJob, setShowJob] = useState(false);
  const [jobUrl, setJobUrl] = useState('');
  const [jobText, setJobText] = useState('');
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
      setQ(''); setHits([]); setUrlMode(false); setKeptName(''); setShowJob(false); setJobUrl(''); setJobText('');
      if (missTimer.current) { clearTimeout(missTimer.current); missTimer.current = null; }
    }
  }, [visible, t]);

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
   * An employer we could not find is the single most useful thing this sheet can tell us — it is
   * the "no match for nordex" report, arriving as data instead of as a complaint.
   *
   * ⚠️ NEVER THE QUERY ITSELF. A typed employer name is the user's own job hunt; only its length
   * goes out. ⚠️ And it is reported on a delay: the search is debounced per keystroke, so firing
   * immediately files "no", "nor", "nord", "norde" as four separate misses of one word. The timer
   * is cancelled by the next search, so only the query they settled on is ever reported.
   *
   * ⚠️ `reason` IS NOT DECORATION. 'empty' is the answer this slice exists to measure — we looked
   * and we have nothing for them. 'error' means both the employer endpoint AND the job-feed
   * fallback threw, i.e. offline, an expired token or a timeout, which says nothing about our
   * coverage. Folding the two together would let a flaky network read as a coverage gap, so the
   * two are reported apart and must be filtered apart downstream.
   */
  const reportMiss = useCallback((term: string, ctry: string, reason: 'empty' | 'error') => {
    clearMiss();
    missTimer.current = setTimeout(() => {
      track('home_add_employer_miss', { len: term.length, region: !!ctry, reason });
    }, 1500);
  }, [clearMiss]);

  // Free either way — a lookup, not a generation — so it can run as they type.
  const search = useCallback(async (text: string, ctry: string) => {
    const term = text.trim();
    clearMiss();
    if (term.length < 2 || looksLikeUrl(term)) { setHits([]); setSettled(askedKey(term, ctry)); return; }
    const mine = ++seq.current;
    setBusy(true);
    try {
      let found: EmployerHit[];
      try { found = await fetchEmployerMatches(term, ctry); }
      catch { found = await searchViaJobFeed(term, ctry); }
      if (mine !== seq.current) return;                     // a later keystroke already won
      setHits(found);
      if (!found.length) reportMiss(term, ctry, 'empty');   // we looked, and we have nobody
    } catch {
      if (mine !== seq.current) return;
      setHits([]);
      reportMiss(term, ctry, 'error');                      // both lookups down — NOT a coverage gap
    } finally {
      if (mine === seq.current) { setBusy(false); setSettled(askedKey(term, ctry)); }
    }
  }, [clearMiss, reportMiss]);

  useEffect(() => {
    // In urlMode the field holds a careers URL, not a name — there is nothing to look up.
    if (!visible || urlMode) return;
    const id = setTimeout(() => search(q, country), 320);   // debounce the typing
    return () => clearTimeout(id);
  }, [q, country, visible, urlMode, search]);

  const close = () => { Keyboard.dismiss(); onClose(); };
  const take = (value: string) => {
    Keyboard.dismiss();
    onPick(value.trim(), {
      country: country || undefined,
      jobUrl: jobUrl.trim() || undefined,
      jobText: jobText.trim() || undefined,
    });
  };
  const hint = country && regionHint ? regionHint(country) : null;
  const typed = q.trim();
  // The one condition for offering what they typed: it is a name, and it is long enough to be one.
  const canUseTyped = typed.length >= 2 && !looksLikeUrl(q);
  // True only once a search for exactly what is on screen has finished — see `settled`.
  const asked = settled === askedKey(typed, country);

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={close} statusBarTranslucent>
      <View style={s.fill}>
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: t }]}>
          <View style={s.scrim} />
        </Animated.View>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={close} />

        <Animated.View
          style={[
            s.sheet,
            {
              paddingBottom: insets.bottom + 12,
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
          <Text style={s.sub}>
            {urlMode ? 'Paste the careers page you want us to watch.' : 'Type a name — we will look them up.'}
          </Text>

          <View style={s.field}>
            <Ionicons name="search" size={16} color={E.textFaint} />
            <TextInput
              style={s.input}
              value={q}
              onChangeText={setQ}
              placeholder={urlMode ? "https://careers.company.com" : "Employer name or URL"}
              placeholderTextColor={E.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="go"
              onSubmitEditing={() => q.trim() && take(q)}
            />
            {busy && <ActivityIndicator size="small" color={E.blue} />}
          </View>

          {/* ⚠️ urlMode used to be a ONE-WAY DOOR: entering it wiped the field and there was no way
              back, so a user who tapped it by accident lost the name they had typed and had no path
              back to searching. It is now reversible, and the name is restored. */}
          {urlMode && (
            <TouchableOpacity
              style={s.backRow}
              activeOpacity={0.85}
              onPress={() => { setUrlMode(false); if (keptName && (!q.trim() || looksLikeUrl(q))) setQ(keptName); }}
            >
              <Ionicons name="arrow-back" size={14} color={E.blueDeep} />
              <Text style={s.backTx} numberOfLines={1}>
                {keptName ? `Back to searching “${keptName}”` : 'Back to search'}
              </Text>
            </TouchableOpacity>
          )}

          {/* region */}
          <Text style={s.lbl}>REGION</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.regions}>
            <Region on={!country} label="Anywhere" onPress={() => setCountry('')} />
            {countries.map((c) => (
              <Region key={c} on={country === c} label={c} onPress={() => setCountry(country === c ? '' : c)} />
            ))}
          </ScrollView>
          {/* ── the actual posting (optional) ─────────────────────────────────────────────────
              A resume written against the real listing beats one written against a company's
              home page, so this is worth asking for — but it stays optional, and supplying it
              costs nothing extra: it is context for the prompt, not a second search. */}
          <TouchableOpacity style={s.jobToggle} activeOpacity={0.8} onPress={() => setShowJob((v) => !v)}>
            <Ionicons name={showJob ? 'chevron-down' : 'chevron-forward'} size={15} color={E.blueDeep} />
            <Text style={s.jobToggleTx} numberOfLines={1}>
              Applying to a specific role? Add the listing
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
                We write the resume and the letter against this posting — its duties and its wording.
              </Text>
            </View>
          )}

          {!!hint && (
            <View style={s.hint}>
              <Ionicons name="sparkles" size={12} color={E.blueDeep} />
              <Text style={s.hintTx} numberOfLines={1}>Best design for {country}: {hint}</Text>
            </View>
          )}

          {/* a pasted URL is its own answer — no search can improve on it */}
          {looksLikeUrl(q) && (
            <TouchableOpacity style={s.urlRow} activeOpacity={0.9} onPress={() => take(q)}>
              <View style={s.urlIcon}><Ionicons name="link" size={15} color="#fff" /></View>
              <View style={{ flex: 1 }}>
                <Text style={s.urlTx} numberOfLines={1}>Use this careers page</Text>
                <Text style={s.urlSub} numberOfLines={1}>{q.trim()}</Text>
              </View>
              <Ionicons name="arrow-forward" size={16} color={E.blueDeep} />
            </TouchableOpacity>
          )}

          {/* ⚠️ THE ROW THAT MAKES "it wont miss any employer" TRUE. Before it, the only way to
              proceed with a name we had no postings for was the keyboard's "go" key, which nothing
              on screen advertised — so the sheet's answer to "Nordex" was "no match", full stop. It
              sits ABOVE the list and shows on every non-empty query, not just on zero hits: the
              employer someone means is missing from a short list just as often as from an empty
              one, and a resume needs the NAME, never an index row. */}
          {/* ⚠️ `!urlMode` MATTERS: in urlMode the field holds a careers URL and the subtitle asks
              for one, so a gradient Use “Nordex” row here offered a second, contradictory answer
              for the same field (with the back row as a third control for the same string). */}
          {!urlMode && canUseTyped && (
            <TouchableOpacity style={s.useRow} activeOpacity={0.9} onPress={() => take(q)}>
              <LinearGradient
                colors={[E.blue, E.purple]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={s.useIcon}
              >
                <Ionicons name="sparkles" size={15} color="#fff" />
              </LinearGradient>
              <View style={{ flex: 1 }}>
                <Text style={s.useTx} numberOfLines={1}>Use “{typed}”</Text>
                <Text style={s.useSub} numberOfLines={2}>
                  We will build your resume for them whether or not we have their postings.
                </Text>
              </View>
              <Ionicons name="arrow-forward" size={16} color={E.blueDeep} />
            </TouchableOpacity>
          )}

          <ScrollView style={s.results} keyboardShouldPersistTaps="handled">
            {hits.map((h) => {
              // A tracked employer legitimately has 0 crawled postings — saying "0 open roles"
              // would read as a defect, so the count only appears when there is one.
              const meta = [h.location || '', h.jobs > 0 ? `${h.jobs} open role${h.jobs === 1 ? '' : 's'}` : '']
                .filter(Boolean).join(' · ');
              const tracked = h.source === 'tracked';
              return (
              <TouchableOpacity key={`${h.source || 'x'}_${h.name}`} style={s.hit} activeOpacity={0.85} onPress={() => take(h.name)}>
                <View style={s.hitTile}><Text style={s.hitTileTx}>{h.name.charAt(0).toUpperCase()}</Text></View>
                <View style={{ flex: 1 }}>
                  <View style={s.hitTop}>
                    <Text style={s.hitName} numberOfLines={1}>{h.name}</Text>
                    {/* Which of the two stores this came from. 'Tracked' is an employer record;
                        the other kind was only inferred from postings, and that inference is how
                        "Siemens" came back as the staffing agencies reposting their roles. */}
                    <View style={s.tag}>
                      <Text style={[s.tagTx, tracked && s.tagTxOn]}>{tracked ? 'TRACKED' : 'FROM POSTINGS'}</Text>
                    </View>
                  </View>
                  {!!h.domain && (
                    <View style={s.hitLine}>
                      <Ionicons name="globe-outline" size={11} color={E.textFaint} />
                      <Text style={s.hitSub} numberOfLines={1}>{h.domain}</Text>
                    </View>
                  )}
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

            {/* The third way in, under the other two: watch a careers page we do not index.
                ⚠️ THIS USED TO `setQ('')` — the affordance for "we found nothing" threw away the
                one thing the user had given us, so recovering meant retyping the name. It keeps the
                text now, and `keptName` lets the back row put it back verbatim.
                ⚠️ And the empty-list wording no longer says "no match": we have every employer,
                because an employer is a name. What we are missing is their POSTINGS.
                ⚠️ `asked` NOT `!busy`: the wording is a factual claim about the index, so it may
                only appear once a search for EXACTLY this term and region has settled. */}
            {!urlMode && canUseTyped && asked && (
              <TouchableOpacity
                style={s.notListed}
                activeOpacity={0.85}
                // ⚠️ THE FIELD MUST BE CLEARED HERE, not left for the paste to replace.
                // `selectTextOnFocus` looked like it covered this and does not: the native
                // TextInput applies it on a FOCUS EVENT, and this row sits under
                // keyboardShouldPersistTaps="handled" so the input never blurs — flipping the prop
                // on an already-focused field does nothing and the pasted URL lands at the caret,
                // spliced into the name. `keptName` is what puts the name back on the way out.
                onPress={() => { setKeptName(typed); setUrlMode(true); setHits([]); setQ(''); }}
              >
                <Ionicons name="link-outline" size={15} color={E.blueDeep} />
                <View style={{ flex: 1 }}>
                  <Text style={s.notListedTx} numberOfLines={1}>
                    {hits.length ? 'Not the right one?' : `No postings indexed for “${typed}” yet`}
                  </Text>
                  <Text style={s.notListedSub} numberOfLines={1}>Add their careers URL so we watch it</Text>
                </View>
                <Ionicons name="chevron-forward" size={15} color={E.textFaint} />
              </TouchableOpacity>
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
    paddingHorizontal: 16, paddingTop: 8, maxHeight: '86%',
  },
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
  // Same palette as the URL row on purpose — the two are the same offer for different input, and
  // they are never on screen together (one wants a name, the other a link).
  useRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14, padding: 11,
    borderRadius: 14, borderWidth: 1, borderColor: 'rgba(79,141,255,0.35)', backgroundColor: 'rgba(79,141,255,0.07)',
  },
  useIcon: { width: 30, height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  useTx: { fontSize: 13.5, fontWeight: '800', color: E.ink },
  useSub: { fontSize: 11, fontWeight: '600', color: E.textMuted, marginTop: 1, lineHeight: 15 },
  backRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
  backTx: { flexShrink: 1, fontSize: 12, fontWeight: '700', color: E.blueDeep },
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
  notListedSub: { fontSize: 11.5, fontWeight: '600', color: E.blueDeep, marginTop: 1 },
  note: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 10 },
  noteTx: { flexShrink: 1, fontSize: 11, fontWeight: '600', color: E.textFaint, lineHeight: 15 },
});
