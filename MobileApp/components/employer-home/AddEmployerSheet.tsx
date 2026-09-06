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
// ⚠️ ANIMATION DRIVER RULE (b126-128): transform/opacity, native driver, one tree.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Modal, TouchableOpacity, TextInput, ScrollView,
  ActivityIndicator, Animated, Easing, Keyboard, Platform,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { E } from './theme';
import { fetchDiscoverJobs } from '../../services/aiHubService';
import { fetchCountryOptions } from '../../services/interestsService';

// Enough to tell two same-named companies apart: the site they hire from and where the role is.
export type EmployerHit = { name: string; domain: string | null; location: string | null; jobs: number };

const looksLikeUrl = (v: string) => /^https?:\/\//i.test(v) || /\.[a-z]{2,}(\/|$)/i.test(v.trim());

export default function AddEmployerSheet({
  visible, onClose, onPick, regionHint,
}: {
  visible: boolean;
  onClose: () => void;
  /** The employer name, or a pasted careers URL. The caller routes it to the add flow. */
  onPick: (value: string, country?: string) => void;
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
  // Set when the user says "not in the list" — the same field then takes a careers URL.
  const [urlMode, setUrlMode] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    Animated.timing(t, {
      toValue: visible ? 1 : 0,
      duration: visible ? 260 : 170,
      easing: visible ? Easing.out(Easing.cubic) : Easing.in(Easing.quad),
      useNativeDriver: true,
    }).start();
    if (!visible) { setQ(''); setHits([]); setUrlMode(false); }
  }, [visible, t]);

  useEffect(() => {
    if (!visible || countries.length) return;
    fetchCountryOptions()
      .then((opts) => setCountries((opts || []).slice(0, 24).map((o: any) => o.name).filter(Boolean)))
      .catch(() => {});
  }, [visible, countries.length]);

  // Search is free (it reads the jobs index), so it can run as they type. Employers are deduped
  // out of the job rows because there is no employer-search endpoint to call.
  const search = useCallback(async (text: string, ctry: string) => {
    const term = text.trim();
    if (term.length < 2 || looksLikeUrl(term)) { setHits([]); return; }
    const mine = ++seq.current;
    setBusy(true);
    try {
      const r = await fetchDiscoverJobs({ q: term, country: ctry || '', limit: 50, sort: 'match' });
      if (mine !== seq.current) return;                     // a later keystroke already won
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
        });
      }
      setHits([...by.values()].sort((a, b) => b.jobs - a.jobs).slice(0, 12));
    } catch {
      if (mine === seq.current) setHits([]);
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    const id = setTimeout(() => search(q, country), 320);   // debounce the typing
    return () => clearTimeout(id);
  }, [q, country, visible, search]);

  const close = () => { Keyboard.dismiss(); onClose(); };
  const take = (value: string) => { Keyboard.dismiss(); onPick(value.trim(), country || undefined); };
  const hint = country && regionHint ? regionHint(country) : null;

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

          {/* region */}
          <Text style={s.lbl}>REGION</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.regions}>
            <Region on={!country} label="Anywhere" onPress={() => setCountry('')} />
            {countries.map((c) => (
              <Region key={c} on={country === c} label={c} onPress={() => setCountry(country === c ? '' : c)} />
            ))}
          </ScrollView>
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

          <ScrollView style={s.results} keyboardShouldPersistTaps="handled">
            {hits.map((h) => (
              <TouchableOpacity key={h.name} style={s.hit} activeOpacity={0.85} onPress={() => take(h.name)}>
                <View style={s.hitTile}><Text style={s.hitTileTx}>{h.name.charAt(0).toUpperCase()}</Text></View>
                <View style={{ flex: 1 }}>
                  <Text style={s.hitName} numberOfLines={1}>{h.name}</Text>
                  {!!h.domain && (
                    <View style={s.hitLine}>
                      <Ionicons name="globe-outline" size={11} color={E.textFaint} />
                      <Text style={s.hitSub} numberOfLines={1}>{h.domain}</Text>
                    </View>
                  )}
                  <View style={s.hitLine}>
                    {!!h.location && <Ionicons name="location-outline" size={11} color={E.textFaint} />}
                    <Text style={s.hitSub} numberOfLines={1}>
                      {h.location ? `${h.location} · ` : ''}{h.jobs} open role{h.jobs === 1 ? '' : 's'}
                    </Text>
                  </View>
                </View>
                <Ionicons name="add-circle" size={22} color={E.blueDeep} />
              </TouchableOpacity>
            ))}

            {/* Always reachable once they have typed: the index only knows employers that already
                have postings in it, so "not listed" is a normal outcome, not a failure. */}
            {!urlMode && !looksLikeUrl(q) && q.trim().length >= 2 && !busy && (
              <TouchableOpacity style={s.notListed} activeOpacity={0.85} onPress={() => { setUrlMode(true); setHits([]); setQ(''); }}>
                <Ionicons name="link-outline" size={15} color={E.blueDeep} />
                <View style={{ flex: 1 }}>
                  <Text style={s.notListedTx} numberOfLines={1}>
                    {hits.length ? 'Not the right one?' : `No match for “${q.trim()}”`}
                  </Text>
                  <Text style={s.notListedSub} numberOfLines={1}>Add their careers URL instead</Text>
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
  hint: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
  hintTx: { flexShrink: 1, fontSize: 11.5, fontWeight: '700', color: E.blueDeep },
  urlRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14, padding: 11,
    borderRadius: 14, borderWidth: 1, borderColor: 'rgba(79,141,255,0.35)', backgroundColor: 'rgba(79,141,255,0.07)',
  },
  urlIcon: { width: 30, height: 30, borderRadius: 10, backgroundColor: E.blueDeep, alignItems: 'center', justifyContent: 'center' },
  urlTx: { fontSize: 13.5, fontWeight: '800', color: E.ink },
  urlSub: { fontSize: 11, fontWeight: '600', color: E.textMuted, marginTop: 1 },
  results: { marginTop: 12 },
  hit: {
    flexDirection: 'row', alignItems: 'center', gap: 11, padding: 10, marginBottom: 8,
    borderRadius: 14, borderWidth: 1, borderColor: E.border, backgroundColor: E.inputBg,
  },
  hitLine: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  hitTile: { width: 38, height: 38, borderRadius: 12, backgroundColor: E.surface, borderWidth: 1, borderColor: E.border, alignItems: 'center', justifyContent: 'center' },
  hitTileTx: { fontSize: 14, fontWeight: '800', color: E.textMuted },
  hitName: { fontSize: 14, fontWeight: '700', color: E.ink },
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
