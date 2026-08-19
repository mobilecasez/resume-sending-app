// AI Hub — new feature. Safe to delete without affecting existing app.
//
// The Jobs tab used to open on an empty text box, and production said almost nobody used it: 18
// people ever, against 87 who opened the feed. This asks the two questions a jobseeker can actually
// answer (role + place), answers them from their own résumé where it can, and only suggests what we
// hold jobs for.
//
// PRESENTATION (reworked): the page carries only a full-width CTA card — no horizontal margin,
// because the list's own contentContainer padding (12) already frames every sibling card, and the
// first version's marginHorizontal:16 stacked INSIDE that padding, which is exactly why it read as
// "not matching the cards above and below". Tapping it opens a BOTTOM SHEET in the same visual
// language as the Filters popup (same overlay tint, grip, radius, padding), so the two panels feel
// like one family.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Animated, Easing,
  ActivityIndicator, Keyboard, Modal, Pressable, ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { fetchSearchPrefill, fetchRoleSuggestions, fetchPlaceSuggestions } from '../services/interestsService';
import { localRoles, localPlaces, mergeSuggestions, composeQuery } from '../utils/searchSuggest';

// Same reason as THREAD_ROUTE in app/(support)/index.tsx: expo-router builds its typed-route table
// during prebuild, so a group it has not indexed yet fails typecheck even though the path is real.
const TUTORIAL_ROUTE = '/(tutorial)' as never;

const T = {
  ink: '#0B1120', muted: '#5B6B8A', faint: '#8896B0',
  surface: '#FFFFFF', bg: '#F0F4FA', border: 'rgba(11,17,32,0.08)', field: '#F4F7FB',
  cyan: '#06B6D4', blue: '#3B82F6', violet: '#7C6BFF', amber: '#F4A259',
};

export type LaunchPayload = { query: string; role: string; location: string; url: string; mode: 'query' | 'url' };

type Suggest = { label: string; sub?: string };

// The robot's nudge, under the CTA. Sits on the page rather than in the sheet: the point is to be
// FOUND by someone who does not yet know what happens after a search, not to interrupt one.
function CoachRow({ onWatch }: { onWatch: () => void }) {
  const wave = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(wave, { toValue: 1, duration: 620, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(wave, { toValue: 0, duration: 620, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.delay(2400),
    ]));
    loop.start();
    return () => loop.stop();
  }, [wave]);
  return (
    <TouchableOpacity activeOpacity={0.85} onPress={onWatch} style={s.coach}>
      <Animated.View style={{ transform: [{ rotate: wave.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '16deg'] }) }] }}>
        <View style={s.coachBot}><Ionicons name="hardware-chip-outline" size={17} color="#fff" /></View>
      </Animated.View>
      <View style={{ flex: 1 }}>
        <Text style={s.coachTitle}>New here? Watch how it works</Text>
        <Text style={s.coachSub}>Search · save a job · write the cover letter · apply — 90 seconds</Text>
      </View>
      <Ionicons name="play-circle" size={26} color={T.amber} />
    </TouchableOpacity>
  );
}

export default function JobSearchLauncher({
  onLaunch, onExpandChange, autoExpand,
}: {
  onLaunch: (p: LaunchPayload) => void;
  onExpandChange?: (open: boolean) => void;
  autoExpand?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState('');
  const [location, setLocation] = useState('');
  const [url, setUrl] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [prefilled, setPrefilled] = useState(false);

  const [roleSug, setRoleSug] = useState<Suggest[]>([]);
  const [placeSug, setPlaceSug] = useState<Suggest[]>([]);
  const [focus, setFocus] = useState<'role' | 'place' | null>(null);

  // The "Searching for X in Y" read-back before the browser takes over — a wrong reading gets
  // caught by the user here, not discovered after the fact.
  const [launching, setLaunching] = useState(false);
  const [typed, setTyped] = useState('');

  const shine = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (open) { shine.stopAnimation(); return; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(shine, { toValue: 1, duration: 1500, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(shine, { toValue: 0, duration: 1500, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [open, shine]);

  useEffect(() => { onExpandChange?.(open); }, [open, onExpandChange]);

  const watchTutorial = useCallback(() => { try { router.push(TUTORIAL_ROUTE); } catch {} }, [router]);

  // Prefill from the résumé on first open — a returning jobseeker should never retype their own
  // job title. Failure is silent: an empty sheet is still a working sheet.
  const primeOnce = useRef(false);
  const expand = useCallback(async () => {
    setOpen(true);
    if (primeOnce.current) return;
    primeOnce.current = true;
    try {
      const p = await fetchSearchPrefill();
      if (p.role) setRole((cur) => cur || p.role);
      if (p.location) setLocation((cur) => cur || p.location);
      if (p.role || p.location) setPrefilled(true);
    } catch {}
  }, []);

  useEffect(() => { if (autoExpand) expand(); }, [autoExpand, expand]);

  // Local suggestions answer on the FIRST keystroke; server results (with real job counts) merge
  // in on top when they arrive. The server being unreachable never empties the list.
  useEffect(() => {
    if (focus !== 'role' || role.trim().length < 1) { setRoleSug([]); return; }
    const local = localRoles(role.trim());
    setRoleSug(local);
    const t = setTimeout(async () => {
      try {
        const r = await fetchRoleSuggestions(role.trim());
        const server = r.map((x) => ({ label: x.name, sub: `${Number(x.jobs).toLocaleString('en-US')} jobs` }));
        if (server.length) setRoleSug(mergeSuggestions(server, local));
      } catch { /* keep the local list */ }
    }, 240);
    return () => clearTimeout(t);
  }, [role, focus]);

  useEffect(() => {
    if (focus !== 'place' || location.trim().length < 1) { setPlaceSug([]); return; }
    const local = localPlaces(location.trim());
    setPlaceSug(local);
    const t = setTimeout(async () => {
      try {
        const r = await fetchPlaceSuggestions(location.trim());
        const server = r.map((x) => ({ label: x.label, sub: `${Number(x.jobs).toLocaleString('en-US')} jobs` }));
        if (server.length) setPlaceSug(mergeSuggestions(server, local));
      } catch { /* keep the local list */ }
    }, 240);
    return () => clearTimeout(t);
  }, [location, focus]);

  const composed = composeQuery(role, location);
  const canGo = !!(url.trim() || role.trim() || location.trim());

  const go = useCallback(() => {
    if (!canGo) return;
    Keyboard.dismiss();
    setFocus(null); setRoleSug([]); setPlaceSug([]);

    const isUrl = !!url.trim();
    const line = isUrl ? 'Opening that job…' : `Searching for ${role.trim() || 'jobs'}${location.trim() ? ` in ${location.trim()}` : ''}…`;
    setLaunching(true); setTyped('');

    let i = 0;
    const tick = setInterval(() => {
      i += 1;
      setTyped(line.slice(0, i));
      if (i >= line.length) {
        clearInterval(tick);
        setTimeout(() => {
          setLaunching(false);
          setOpen(false);              // the sheet closes; the browser opens over the page
          onLaunch({
            query: isUrl ? url.trim() : composed,
            role: role.trim(), location: location.trim(), url: url.trim(),
            mode: isUrl ? 'url' : 'query',
          });
        }, 420);
      }
    }, 22);
  }, [canGo, url, role, location, composed, onLaunch]);

  const suggestBox = (items: Suggest[], pick: (v: string) => void, icon: 'search' | 'location') => (
    <View style={s.sugBox}>
      {items.map((x, i) => (
        <TouchableOpacity key={x.label + i} style={s.sugRow} activeOpacity={0.7}
          onPress={() => { pick(x.label); setFocus(null); Keyboard.dismiss(); }}>
          <Ionicons name={icon} size={13} color={T.faint} />
          <Text style={s.sugTx} numberOfLines={1}>{x.label}</Text>
          {!!x.sub && <Text style={s.sugSub}>{x.sub}</Text>}
        </TouchableOpacity>
      ))}
    </View>
  );

  return (
    <View style={s.wrap}>
      {/* The CTA card — full width like every sibling card; the list's own padding frames it. */}
      <TouchableOpacity activeOpacity={0.9} onPress={expand}>
        <LinearGradient colors={[T.cyan, T.blue]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.cta}>
          <View style={s.ctaIcon}><Ionicons name="search" size={18} color="#fff" /></View>
          <View style={{ flex: 1 }}>
            <Text style={s.ctaTitle}>Find your job now</Text>
            <Text style={s.ctaSub}>Tell us the role and the place — we'll do the searching</Text>
          </View>
          <Animated.View style={{ opacity: shine.interpolate({ inputRange: [0, 1], outputRange: [0.55, 1] }) }}>
            <Ionicons name="arrow-forward-circle" size={26} color="#fff" />
          </Animated.View>
        </LinearGradient>
      </TouchableOpacity>
      <CoachRow onWatch={watchTutorial} />

      {/* The form, as a bottom sheet — the Filters popup's own language: overlay, grip, radius. */}
      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <View style={s.sheetOverlay}>
          <Pressable style={{ flex: 1 }} onPress={() => { Keyboard.dismiss(); setOpen(false); }} />
          <View style={s.sheet}>
            <View style={s.sheetGrip} />
            <View style={s.sheetHead}>
              <Text style={s.sheetTitle}>Find your job now</Text>
              <TouchableOpacity onPress={() => setOpen(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={20} color={T.faint} />
              </TouchableOpacity>
            </View>
            {prefilled && (
              <View style={s.prefillNote}>
                <Ionicons name="sparkles" size={12} color={T.violet} />
                <Text style={s.prefillTx}>Filled in from your résumé — change anything you like</Text>
              </View>
            )}

            <ScrollView style={{ maxHeight: 460 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              <Text style={s.label}>Role you're looking for</Text>
              <View style={s.fieldWrap}>
                <Ionicons name="briefcase-outline" size={16} color={T.blue} />
                <TextInput
                  value={role} onChangeText={setRole} placeholder="e.g. Warehouse Operative" placeholderTextColor={T.faint}
                  style={s.input} autoCapitalize="words" autoCorrect={false} returnKeyType="next"
                  onFocus={() => setFocus('role')}
                />
                {!!role && <TouchableOpacity onPress={() => setRole('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}><Ionicons name="close-circle" size={16} color={T.faint} /></TouchableOpacity>}
              </View>
              {focus === 'role' && roleSug.length > 0 && suggestBox(roleSug, setRole, 'search')}

              <Text style={s.label}>Location</Text>
              <View style={s.fieldWrap}>
                <Ionicons name="location-outline" size={16} color={T.blue} />
                <TextInput
                  value={location} onChangeText={setLocation} placeholder="City, state or country" placeholderTextColor={T.faint}
                  style={s.input} autoCapitalize="words" autoCorrect={false} returnKeyType="search"
                  onFocus={() => setFocus('place')} onSubmitEditing={go}
                />
                {!!location && <TouchableOpacity onPress={() => setLocation('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}><Ionicons name="close-circle" size={16} color={T.faint} /></TouchableOpacity>}
              </View>
              {focus === 'place' && placeSug.length > 0 && suggestBox(placeSug, setLocation, 'location')}

              <TouchableOpacity style={s.advToggle} activeOpacity={0.7} onPress={() => setAdvanced((v) => !v)}>
                <Ionicons name={advanced ? 'chevron-down' : 'chevron-forward'} size={14} color={T.muted} />
                <Text style={s.advTx}>Advanced</Text>
              </TouchableOpacity>
              {advanced && (
                <View>
                  <View style={s.orRow}><View style={s.orLine} /><Text style={s.orTx}>or open a job you already have</Text><View style={s.orLine} /></View>
                  <View style={s.fieldWrap}>
                    <Ionicons name="link-outline" size={16} color={T.violet} />
                    <TextInput
                      value={url} onChangeText={setUrl} placeholder="Paste a job link" placeholderTextColor={T.faint}
                      style={s.input} autoCapitalize="none" autoCorrect={false} keyboardType="url" returnKeyType="go"
                      onSubmitEditing={go}
                    />
                  </View>
                  <Text style={s.advHint}>We'll open that page straight away — then use the robot to fetch and save it.</Text>
                </View>
              )}

              <TouchableOpacity activeOpacity={0.9} onPress={go} disabled={!canGo} style={{ marginTop: 14, opacity: canGo ? 1 : 0.45 }}>
                <LinearGradient colors={[T.cyan, T.blue]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={s.goBtn}>
                  <Ionicons name={url.trim() ? 'open-outline' : 'search'} size={17} color="#fff" />
                  <Text style={s.goTx}>{url.trim() ? 'Open this job' : 'Search jobs'}</Text>
                </LinearGradient>
              </TouchableOpacity>
              {!url.trim() && !!composed && <Text style={s.preview} numberOfLines={1}>We'll search: {composed}</Text>}
            </ScrollView>

            {launching && (
              <View style={s.launchOverlay}>
                <ActivityIndicator color={T.cyan} />
                <Text style={s.launchTx}>{typed}<Text style={{ color: T.cyan }}>|</Text></Text>
              </View>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  // ⚠️ NO marginHorizontal. Sibling cards (searchWrap, card, recentBox in the discover screen) are
  // full-width inside the list's contentContainer padding of 12 — an extra margin here is exactly
  // what made the first version narrower than its neighbours.
  wrap: { marginBottom: 10 },
  cta: {
    flexDirection: 'row', alignItems: 'center', gap: 12, padding: 15, borderRadius: 20,
    shadowColor: '#0284C7', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.3, shadowRadius: 18, elevation: 6,
  },
  ctaIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.22)', alignItems: 'center', justifyContent: 'center' },
  ctaTitle: { color: '#fff', fontSize: 17, fontWeight: '800', letterSpacing: -0.3 },
  ctaSub: { color: 'rgba(255,255,255,0.9)', fontSize: 12, marginTop: 2 },

  coach: {
    flexDirection: 'row', alignItems: 'center', gap: 11, marginTop: 10,
    backgroundColor: '#FFF8EF', borderRadius: 15, padding: 12,
    borderWidth: 1, borderColor: 'rgba(244,162,89,0.28)',
  },
  coachBot: { width: 34, height: 34, borderRadius: 11, backgroundColor: T.amber, alignItems: 'center', justifyContent: 'center' },
  coachTitle: { fontSize: 13.5, fontWeight: '800', color: T.ink, letterSpacing: -0.2 },
  coachSub: { fontSize: 11, color: T.muted, marginTop: 2 },

  // Mirrors the Filters sheet exactly (sheetOverlay/sheet/sheetGrip/sheetHead in the discover
  // screen) so the two popups read as one family.
  sheetOverlay: { flex: 1, backgroundColor: 'rgba(6,10,25,0.45)' },
  sheet: { backgroundColor: T.bg, borderTopLeftRadius: 26, borderTopRightRadius: 26, paddingTop: 8, paddingHorizontal: 18, paddingBottom: 28 },
  sheetGrip: { alignSelf: 'center', width: 40, height: 4, borderRadius: 100, backgroundColor: 'rgba(11,15,34,0.14)', marginBottom: 10 },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  sheetTitle: { fontSize: 18, fontWeight: '800', color: T.ink },
  prefillNote: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  prefillTx: { fontSize: 11.5, color: T.violet, fontWeight: '600' },

  label: { fontSize: 11.5, fontWeight: '700', color: T.muted, letterSpacing: 0.4, textTransform: 'uppercase', marginTop: 14, marginBottom: 6 },
  fieldWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 9, backgroundColor: T.surface,
    borderRadius: 13, paddingHorizontal: 12, height: 46, borderWidth: 1, borderColor: T.border,
  },
  input: { flex: 1, fontSize: 14.5, color: T.ink, padding: 0 },

  sugBox: { marginTop: 6, backgroundColor: T.surface, borderRadius: 13, borderWidth: 1, borderColor: T.border, overflow: 'hidden' },
  sugRow: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 12, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.border },
  sugTx: { flex: 1, fontSize: 13.5, color: T.ink, fontWeight: '600' },
  sugSub: { fontSize: 11, color: T.faint },

  advToggle: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 14 },
  advTx: { fontSize: 12.5, color: T.muted, fontWeight: '700' },
  orRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginVertical: 10 },
  orLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: T.border },
  orTx: { fontSize: 11, color: T.faint },
  advHint: { fontSize: 11, color: T.faint, marginTop: 6, lineHeight: 15 },

  goBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 50, borderRadius: 15 },
  goTx: { color: '#fff', fontSize: 15.5, fontWeight: '800', letterSpacing: -0.2 },
  preview: { fontSize: 11.5, color: T.faint, textAlign: 'center', marginTop: 8 },

  launchOverlay: {
    ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(240,244,250,0.97)',
    borderTopLeftRadius: 26, borderTopRightRadius: 26,
    alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 24,
  },
  launchTx: { fontSize: 15, fontWeight: '700', color: T.ink, textAlign: 'center' },
});
