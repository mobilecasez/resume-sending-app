// AI Hub — new feature. Safe to delete without affecting existing app.
//
// The Home "rebuild your resume" card: score ring + a styled mini-preview of their (future)
// AI resume + one CTA into the builder's auto lane. Self-contained on purpose — HomeScreen.js
// only mounts <ResumeRebuildCard />, so the monolith's diff stays two lines.
//
// Renders NOTHING until the user has a resume score or a built resume: brand-new users are
// already looked after by the OnboardingChecklist, and stacking a third banner on their first
// open is how a home screen turns into a wall of cards.
//
// ⚠️ Animation rule (b126-128 crash): every Animated.Value here uses useNativeDriver:false.
import React, { useCallback, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated, Image } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { useFocusEffect } from 'expo-router';
import { API_BASE } from '../config';
import { fetchResumeScore, claimEnhancePass, markResumeScore, ResumeScore } from '../services/resumeScoreService';
import { track } from '../services/analytics';

const T = {
  surface: '#FFFFFF', ink: '#0B0F22', muted: '#5B6B8A', faint: '#8896B0',
  border: 'rgba(11,15,34,0.06)',
};

// Same bands as ResumeScoreModal.paletteFor — low scores are amber, never red: the card exists
// to invite a rebuild, not to scold.
function paletteFor(score: number): { grad: [string, string]; tint: string } {
  if (score >= 85) return { grad: ['#10B981', '#06B6D4'], tint: '#10B981' };
  if (score >= 70) return { grad: ['#14B8A6', '#3B82F6'], tint: '#14B8A6' };
  if (score >= 55) return { grad: ['#4F8DFF', '#7C6BFF'], tint: '#4F8DFF' };
  return { grad: ['#F59E0B', '#F97316'], tint: '#F59E0B' };
}

// No react-native-svg in this project — the ring is the clipped-half-circle technique: two
// halves, each rotated by its share of the sweep. Static (no animation needed at this size).
function ScoreRing({ score, size = 62, stroke = 6, tint }: { score: number; size?: number; stroke?: number; tint: string }) {
  const clamped = Math.max(0, Math.min(100, score));
  const sweep = clamped * 3.6;
  const half = (rot: number) => ({
    position: 'absolute' as const, width: size, height: size, borderRadius: size / 2,
    borderWidth: stroke, borderColor: 'transparent',
    borderTopColor: tint, borderRightColor: tint,
    transform: [{ rotate: `${rot - 135}deg` }],
  });
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ position: 'absolute', width: size, height: size, borderRadius: size / 2, borderWidth: stroke, borderColor: 'rgba(11,15,34,0.08)' }} />
      {sweep > 0 && <View style={half(Math.min(sweep, 180) / 2)} />}
      {sweep > 180 && <View style={half(90 + (sweep - 180) / 2)} />}
      <Text style={{ fontSize: size * 0.30, fontWeight: '900', color: T.ink, letterSpacing: -0.5 }}>{clamped}</Text>
    </View>
  );
}

// The "your new resume" mock: a tiny designed page. Real name + real accent, skeleton body —
// honest (nothing is fabricated) and it reads instantly as "this is what you get".
function MiniResume({ name, tint }: { name: string; tint: string }) {
  const initials = (name || '?').trim().split(/\s+/).map((p) => p[0] || '').slice(0, 2).join('').toUpperCase() || '?';
  const Line = ({ w, c }: { w: number; c?: string }) => (
    <View style={{ width: `${w}%` as any, height: 4, borderRadius: 2, backgroundColor: c || 'rgba(11,15,34,0.10)', marginBottom: 4 }} />
  );
  return (
    <View style={m.page}>
      <View style={[m.band, { backgroundColor: tint }]}>
        <View style={m.avatar}><Text style={[m.avatarText, { color: tint }]}>{initials}</Text></View>
        <View style={{ flex: 1 }}>
          <View style={{ width: '80%', height: 5, borderRadius: 2.5, backgroundColor: 'rgba(255,255,255,0.95)', marginBottom: 4 }} />
          <View style={{ width: '55%', height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.55)' }} />
        </View>
      </View>
      <View style={{ padding: 8, paddingTop: 7 }}>
        <Line w={38} c={tint + '66'} /><Line w={96} /><Line w={88} /><Line w={92} />
        <View style={{ height: 3 }} />
        <Line w={30} c={tint + '66'} /><Line w={90} /><Line w={72} />
        <View style={m.chips}>
          {[26, 20, 30].map((w, i) => <View key={i} style={[m.chip, { width: w, backgroundColor: tint + '22' }]} />)}
        </View>
      </View>
      <View style={[m.newTag, { backgroundColor: tint }]}><Text style={m.newTagText}>AI</Text></View>
    </View>
  );
}

export default function ResumeRebuildCard() {
  const [score, setScore] = useState<ResumeScore | null>(null);
  const [hasScore, setHasScore] = useState(false);
  const [hasBuilt, setHasBuilt] = useState(false);
  const [name, setName] = useState('');
  // The REAL rendered preview of their built resume (cached server-side per version).
  const [thumb, setThumb] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lastFetch = useRef(0);
  const press = useRef(new Animated.Value(1)).current;

  useFocusEffect(useCallback(() => {
    // HomeScreen never unmounts (App.js keeps it alive) — refresh on focus, throttled.
    if (Date.now() - lastFetch.current < 60_000) return;
    lastFetch.current = Date.now();
    (async () => {
      try {
        const r = await fetchResumeScore();
        // Unlike the popup, the card keeps the score whether or not the server wants to PROMPT —
        // shouldPrompt gates interruptions, not information.
        if (r.hasScore && r.score) { setScore(r.score); setHasScore(true); }
        const raw = await SecureStore.getItemAsync('userSession');
        const token = JSON.parse(raw || '{}')?.token;
        if (token) {
          const res = await fetch(`${API_BASE}/resume-builder`, { headers: { Authorization: `Bearer ${token}` } });
          if (res.ok) {
            const j = await res.json();
            setHasBuilt(!!j.resumeData);
            const n = j.resumeData?.personal_info?.full_name;
            if (n) setName(String(n));
            if (j.resumeData) {
              // The actual rendered resume beats any mock. Cached per version server-side, so
              // this is a file read for every open except the first after a (re)generate.
              try {
                const tr = await fetch(`${API_BASE}/resume-builder/home-thumb`, { headers: { Authorization: `Bearer ${token}` } });
                if (tr.ok) { const tj = await tr.json(); if (tj.image) setThumb(tj.image); }
              } catch {}
            }
          }
        }
      } catch {}
    })();
  }, []));

  if (!hasScore && !hasBuilt) return null;

  const sc = score?.score ?? 0;
  const pal = paletteFor(sc);
  const needsWork = !hasScore || sc < 75;

  const headline = hasBuilt
    ? 'Your AI resume is ready'
    : needsWork
      ? 'Your resume needs a rebuild to get noticed'
      : 'Strong resume — make it stunning';
  const sub = hasBuilt
    ? 'Open it, pick from 37 designs, or regenerate it with one tap.'
    : needsWork
      ? 'Recruiters skim in seconds. Let AI rebuild yours into a designed, ATS-friendly resume.'
      : 'Turn it into a beautifully designed resume — 37 formats, previews free.';

  async function go() {
    if (busy) return;
    setBusy(true);
    try {
      track('home_rebuild_card_tap', { hasBuilt, score: sc });
      if (hasBuilt) {
        require('expo-router').router?.push?.('/(resume-builder)/preview');
        return;
      }
      // Mirror enhanceFromScore: claim the free pass BEFORE navigating, so the "free" on the
      // button is true by the time the builder POSTs.
      let free = false;
      if (score?.id) {
        try { const c = await claimEnhancePass(score.id); free = !!c?.free; } catch {}
        try { await markResumeScore(score.id, 'acted'); } catch {}
      }
      await AsyncStorage.setItem('resume_builder_entry', JSON.stringify({
        from: 'home_card', autoBuild: true, scoreId: score?.id, score: sc, free,
      }));
      require('expo-router').router?.push?.('/(resume-builder)');
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={s.card}>
      <LinearGradient colors={[pal.tint + '14', 'rgba(255,255,255,0)']} start={{ x: 0, y: 0 }} end={{ x: 0.9, y: 0.9 }} style={StyleSheet.absoluteFill} />
      <View style={s.topRow}>
        {hasScore ? (
          <View style={s.ringWrap}>
            <ScoreRing score={sc} tint={pal.tint} />
            <Text style={s.ringLabel}>Resume score</Text>
          </View>
        ) : (
          <View style={s.ringWrap}>
            <View style={[s.readyBadge, { backgroundColor: pal.tint + '1A' }]}><Ionicons name="sparkles" size={26} color={pal.tint} /></View>
            <Text style={s.ringLabel}>AI resume</Text>
          </View>
        )}
        <View style={{ flex: 1 }}>
          <Text style={s.headline}>{headline}</Text>
          <Text style={s.sub}>{sub}</Text>
        </View>
        {thumb ? (
          <View style={m.page}>
            <Image source={{ uri: thumb }} style={m.thumbImg} resizeMode="cover" />
            <View style={[m.newTag, { backgroundColor: pal.tint }]}><Text style={m.newTagText}>AI</Text></View>
          </View>
        ) : (
          <MiniResume name={name} tint={pal.tint} />
        )}
      </View>
      <Animated.View style={{ transform: [{ scale: press }] }}>
        <TouchableOpacity
          activeOpacity={0.92}
          onPress={go}
          disabled={busy}
          onPressIn={() => Animated.spring(press, { toValue: 0.97, useNativeDriver: false }).start()}
          onPressOut={() => Animated.spring(press, { toValue: 1, useNativeDriver: false }).start()}
        >
          <LinearGradient colors={pal.grad} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.cta}>
            <Ionicons name={hasBuilt ? 'document-text' : 'color-wand'} size={17} color="#fff" />
            <Text style={s.ctaText}>{hasBuilt ? 'View my new resume' : 'Rebuild my resume — free'}</Text>
            <View style={s.ctaArrow}><Ionicons name="arrow-forward" size={15} color="#fff" /></View>
          </LinearGradient>
        </TouchableOpacity>
      </Animated.View>
      <Text style={s.note}>{hasBuilt ? '37 designs · previews always free' : 'Built from your uploaded resume · previews of all designs free'}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    marginHorizontal: 16, marginBottom: 16, backgroundColor: T.surface, borderRadius: 22,
    borderWidth: 1, borderColor: T.border, padding: 18, overflow: 'hidden',
    shadowColor: '#0B0F22', shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.08, shadowRadius: 32, elevation: 4,
  },
  topRow:    { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 14 },
  ringWrap:  { alignItems: 'center', gap: 5 },
  ringLabel: { fontSize: 9.5, fontWeight: '800', color: T.faint, letterSpacing: 0.5, textTransform: 'uppercase' },
  readyBadge:{ width: 62, height: 62, borderRadius: 31, alignItems: 'center', justifyContent: 'center' },
  headline:  { fontSize: 15.5, fontWeight: '800', color: T.ink, letterSpacing: -0.3, lineHeight: 20, marginBottom: 4 },
  sub:       { fontSize: 12, color: T.muted, lineHeight: 16.5 },
  cta:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, height: 48, borderRadius: 15, paddingHorizontal: 14 },
  ctaText:   { fontSize: 14.5, fontWeight: '800', color: '#fff', letterSpacing: -0.2 },
  ctaArrow:  { width: 28, height: 28, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' },
  note:      { fontSize: 10.5, color: T.faint, textAlign: 'center', marginTop: 8 },
});

const m = StyleSheet.create({
  page: {
    width: 86, height: 112, borderRadius: 9, backgroundColor: '#fff', overflow: 'hidden',
    borderWidth: 1, borderColor: 'rgba(11,15,34,0.10)',
    shadowColor: '#0B0F22', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.14, shadowRadius: 12, elevation: 5,
  },
  band:       { flexDirection: 'row', alignItems: 'center', gap: 5, padding: 7, paddingVertical: 8 },
  avatar:     { width: 18, height: 18, borderRadius: 9, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 8, fontWeight: '900' },
  thumbImg:   { width: '100%', height: '100%' },
  chips:      { flexDirection: 'row', gap: 3, marginTop: 4 },
  chip:       { height: 7, borderRadius: 3.5 },
  newTag:     { position: 'absolute', top: 5, right: 5, borderRadius: 5, paddingHorizontal: 4, paddingVertical: 1.5 },
  newTagText: { fontSize: 7, fontWeight: '900', color: '#fff', letterSpacing: 0.5 },
});
