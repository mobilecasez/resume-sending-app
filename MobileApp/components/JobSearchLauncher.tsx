// AI Hub — new feature. Safe to delete without affecting existing app.
//
// The Jobs tab used to open on an empty text box labelled "Search jobs — or paste a job link", and
// production said almost nobody used it: 18 people ever, against 87 who opened the feed. An empty
// box asks the user to invent a query with no idea what we hold. This asks two questions instead,
// answers them from their own résumé where it can, and only ever suggests something we have jobs for.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Animated, Easing,
  ActivityIndicator, Keyboard, Platform, LayoutAnimation, UIManager,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { fetchSearchPrefill, fetchRoleSuggestions, fetchPlaceSuggestions } from '../services/interestsService';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const T = {
  ink: '#0B1120', muted: '#5B6B8A', faint: '#8896B0',
  surface: '#FFFFFF', border: 'rgba(11,17,32,0.08)', field: '#F4F7FB',
  cyan: '#06B6D4', blue: '#3B82F6', violet: '#7C6BFF',
};

export type LaunchPayload = { query: string; role: string; location: string; url: string; mode: 'query' | 'url' };

type Suggest = { label: string; sub?: string };

export default function JobSearchLauncher({
  onLaunch, onExpandChange, autoExpand,
}: {
  onLaunch: (p: LaunchPayload) => void;
  onExpandChange?: (open: boolean) => void;
  autoExpand?: boolean;                    // open on first visit, so the feature is discovered
}) {
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState('');
  const [location, setLocation] = useState('');
  const [url, setUrl] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [prefilled, setPrefilled] = useState(false);

  const [roleSug, setRoleSug] = useState<Suggest[]>([]);
  const [placeSug, setPlaceSug] = useState<Suggest[]>([]);
  const [focus, setFocus] = useState<'role' | 'place' | null>(null);

  // The "Searching for X in Y" moment. It is not decoration: it reads back what we understood
  // BEFORE the browser takes over, so a wrong reading is caught by the user, not discovered later.
  const [launching, setLaunching] = useState(false);
  const [typed, setTyped] = useState('');

  const grow = useRef(new Animated.Value(0)).current;      // collapsed → expanded
  const shine = useRef(new Animated.Value(0)).current;     // idle sheen on the closed CTA

  useEffect(() => {
    Animated.timing(grow, {
      toValue: open ? 1 : 0, duration: 340, easing: Easing.out(Easing.cubic), useNativeDriver: true,
    }).start();
    onExpandChange?.(open);
  }, [open, grow, onExpandChange]);

  useEffect(() => {
    if (open) { shine.stopAnimation(); return; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(shine, { toValue: 1, duration: 1500, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(shine, { toValue: 0, duration: 1500, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [open, shine]);

  // Prefill from the résumé the first time it opens — a returning jobseeker should never retype
  // their own job title. Failure is silent: an empty panel is still a working panel.
  const primeOnce = useRef(false);
  const expand = useCallback(async () => {
    LayoutAnimation.configureNext(LayoutAnimation.create(300, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity));
    setOpen(true);
    if (primeOnce.current) return;
    primeOnce.current = true;
    try {
      const p = await fetchSearchPrefill();
      if (p.role && !role) setRole(p.role);
      if (p.location && !location) setLocation(p.location);
      if (p.role || p.location) setPrefilled(true);
    } catch {}
  }, [role, location]);

  useEffect(() => { if (autoExpand) expand(); }, [autoExpand, expand]);

  // Debounced suggestions. Only what we hold jobs for is ever offered.
  useEffect(() => {
    if (focus !== 'role' || role.trim().length < 2) { setRoleSug([]); return; }
    const t = setTimeout(async () => {
      try {
        const r = await fetchRoleSuggestions(role.trim());
        setRoleSug(r.map((x) => ({ label: x.name, sub: `${x.jobs.toLocaleString('en-US')} jobs` })));
      } catch { setRoleSug([]); }
    }, 260);
    return () => clearTimeout(t);
  }, [role, focus]);

  useEffect(() => {
    if (focus !== 'place' || location.trim().length < 2) { setPlaceSug([]); return; }
    const t = setTimeout(async () => {
      try {
        const r = await fetchPlaceSuggestions(location.trim());
        setPlaceSug(r.map((x) => ({ label: x.label, sub: `${x.jobs.toLocaleString('en-US')} jobs` })));
      } catch { setPlaceSug([]); }
    }, 260);
    return () => clearTimeout(t);
  }, [location, focus]);

  const composed = [role.trim(), location.trim() ? `in ${location.trim()}` : ''].filter(Boolean).join(' ');
  const canGo = !!(url.trim() || role.trim() || location.trim());

  const go = useCallback(() => {
    if (!canGo) return;
    Keyboard.dismiss();
    setFocus(null); setRoleSug([]); setPlaceSug([]);

    const isUrl = !!url.trim();
    const line = isUrl ? 'Opening that job…' : `Searching for ${role.trim() || 'jobs'}${location.trim() ? ` in ${location.trim()}` : ''}…`;
    setLaunching(true); setTyped('');

    // Type it out, then hand over. The delay is the animation's real length, not a guess.
    let i = 0;
    const tick = setInterval(() => {
      i += 1;
      setTyped(line.slice(0, i));
      if (i >= line.length) {
        clearInterval(tick);
        setTimeout(() => {
          setLaunching(false);
          onLaunch({
            query: isUrl ? url.trim() : (composed || role.trim() || location.trim()),
            role: role.trim(), location: location.trim(), url: url.trim(),
            mode: isUrl ? 'url' : 'query',
          });
        }, 420);
      }
    }, 22);
  }, [canGo, url, role, location, composed, onLaunch]);

  // ── collapsed ────────────────────────────────────────────────────────────────────────────────
  if (!open) {
    return (
      <TouchableOpacity activeOpacity={0.9} onPress={expand} style={s.wrap}>
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
    );
  }

  // ── expanded ─────────────────────────────────────────────────────────────────────────────────
  return (
    <Animated.View style={[s.wrap, s.panel, {
      opacity: grow,
      transform: [{ translateY: grow.interpolate({ inputRange: [0, 1], outputRange: [-8, 0] }) }],
    }]}>
      <View style={s.panelHead}>
        <Text style={s.panelTitle}>Find your job now</Text>
        <TouchableOpacity onPress={() => { setOpen(false); setFocus(null); }} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="chevron-up" size={19} color={T.faint} />
        </TouchableOpacity>
      </View>
      {prefilled && (
        <View style={s.prefillNote}>
          <Ionicons name="sparkles" size={12} color={T.violet} />
          <Text style={s.prefillTx}>Filled in from your résumé — change anything you like</Text>
        </View>
      )}

      {/* Role */}
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
      {focus === 'role' && roleSug.length > 0 && (
        <View style={s.sugBox}>
          {roleSug.map((x, i) => (
            <TouchableOpacity key={x.label + i} style={s.sugRow} activeOpacity={0.7}
              onPress={() => { setRole(x.label); setRoleSug([]); setFocus(null); Keyboard.dismiss(); }}>
              <Ionicons name="search" size={13} color={T.faint} />
              <Text style={s.sugTx} numberOfLines={1}>{x.label}</Text>
              <Text style={s.sugSub}>{x.sub}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Location */}
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
      {focus === 'place' && placeSug.length > 0 && (
        <View style={s.sugBox}>
          {placeSug.map((x, i) => (
            <TouchableOpacity key={x.label + i} style={s.sugRow} activeOpacity={0.7}
              onPress={() => { setLocation(x.label); setPlaceSug([]); setFocus(null); Keyboard.dismiss(); }}>
              <Ionicons name="location" size={13} color={T.faint} />
              <Text style={s.sugTx} numberOfLines={1}>{x.label}</Text>
              <Text style={s.sugSub}>{x.sub}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Advanced — the escape hatch for someone who already has the link */}
      <TouchableOpacity style={s.advToggle} activeOpacity={0.7} onPress={() => { LayoutAnimation.easeInEaseOut(); setAdvanced((v) => !v); }}>
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

      {/* Go */}
      <TouchableOpacity activeOpacity={0.9} onPress={go} disabled={!canGo} style={{ marginTop: 12, opacity: canGo ? 1 : 0.45 }}>
        <LinearGradient colors={[T.cyan, T.blue]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={s.goBtn}>
          <Ionicons name={url.trim() ? 'open-outline' : 'search'} size={17} color="#fff" />
          <Text style={s.goTx}>{url.trim() ? 'Open this job' : 'Search jobs'}</Text>
        </LinearGradient>
      </TouchableOpacity>
      {!url.trim() && !!composed && <Text style={s.preview} numberOfLines={1}>We'll search: {composed}</Text>}

      {/* The typing moment */}
      {launching && (
        <View style={s.launchOverlay}>
          <ActivityIndicator color={T.cyan} />
          <Text style={s.launchTx}>{typed}<Text style={{ color: T.cyan }}>|</Text></Text>
        </View>
      )}
    </Animated.View>
  );
}

const s = StyleSheet.create({
  wrap: { marginHorizontal: 14, marginTop: 10, marginBottom: 8 },
  cta: {
    flexDirection: 'row', alignItems: 'center', gap: 12, padding: 15, borderRadius: 20,
    shadowColor: '#0284C7', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.3, shadowRadius: 18, elevation: 6,
  },
  ctaIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.22)', alignItems: 'center', justifyContent: 'center' },
  ctaTitle: { color: '#fff', fontSize: 17, fontWeight: '800', letterSpacing: -0.3 },
  ctaSub: { color: 'rgba(255,255,255,0.9)', fontSize: 12, marginTop: 2 },

  panel: {
    backgroundColor: T.surface, borderRadius: 22, padding: 16, borderWidth: 1, borderColor: T.border,
    shadowColor: '#0F172A', shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.10, shadowRadius: 26, elevation: 5,
  },
  panelHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  panelTitle: { fontSize: 17, fontWeight: '800', color: T.ink, letterSpacing: -0.3 },
  prefillNote: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  prefillTx: { fontSize: 11.5, color: T.violet, fontWeight: '600' },

  label: { fontSize: 11.5, fontWeight: '700', color: T.muted, letterSpacing: 0.4, textTransform: 'uppercase', marginTop: 14, marginBottom: 6 },
  fieldWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 9, backgroundColor: T.field,
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
    ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(255,255,255,0.96)',
    borderRadius: 22, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 24,
  },
  launchTx: { fontSize: 15, fontWeight: '700', color: T.ink, textAlign: 'center' },
});
