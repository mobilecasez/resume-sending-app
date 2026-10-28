// AI Hub — new feature. Safe to delete without affecting existing app.
//
// The two ways to pay for a download, offered side by side: buy this one employer outright, or
// take a plan. Shown when the download button is locked.
//
// ⚠️ THE ONE-OFF IS THE FIRST OPTION, AND IT STAYS REACHABLE. Sending someone to the plans screen
// must not be a dead end for the person who only wanted one file: the sheet keeps its `visible`
// state while the plans screen is open, so backing out without subscribing lands you right back
// on it with the one-off still there.
//
// ⚠️ BUT IT MUST HIDE ITSELF WHILE ANOTHER SCREEN IS UP. A react-native Modal is not a view inside
// this screen — it is a separate native window that floats ABOVE the whole navigator. So "leaving
// it mounted underneath the plans screen" is not a thing that can happen: left visible, it covers
// the plans screen the user just asked to see. Hence `visible && screenFocused` below. Staying
// mounted (state preserved) and staying VISIBLE are different things, and only the first is wanted.
//
// ⚠️ PRICES COME FROM THE STORE, NEVER FROM US. `displayPrice` is Apple's / Google's own localised
// string — ₹99 in India, $0.99 in the US. A hardcoded "$1" would be wrong in most of the world and
// is exactly the kind of thing app review rejects.
//
// ⚠️ ANIMATION DRIVER RULE (b126-128): transform/opacity, native driver, one tree.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Modal, TouchableOpacity, ActivityIndicator, Animated, Easing, Platform,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { E } from '../employer-home/theme';
import { buyDownloadPass, fetchPassPrice, fetchDownloadState, recoverStrandedPasses } from '../../services/downloadPassService';
import { track } from '../../services/analytics';

export default function DownloadPaywallSheet({
  visible, employer, onClose, onUnlocked, onSeePlans,
}: {
  visible: boolean;
  /** The company this download is for — what the pass will be spent on. */
  employer?: string | null;
  onClose: () => void;
  /** Fired once the server confirms the user may now download. */
  onUnlocked: () => void;
  /** Open the subscription screen. The sheet hides while it is up and returns on the way back. */
  onSeePlans: () => void;
}) {
  const insets = useSafeAreaInsets();
  const t = useRef(new Animated.Value(0)).current;
  const [price, setPrice] = useState<string | null>(null);
  // ⚠️ "NO PRICE YET" AND "NOT ON SALE" ARE DIFFERENT ANSWERS (2026-10-28). The sheet used to show
  // "Checking the App Store price…" for ever when the store had no pass to sell — the first option on the
  // only screen where anyone meets a price was a dead one, and its tap said "not on sale yet". Once the store
  // has answered, an unavailable pass says so and the plan becomes the way to download today.
  const [passState, setPassState] = useState<'loading' | 'available' | 'unavailable'>('loading');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // False the moment the calling screen is covered (the plans screen being the only route this
  // sheet pushes). Keeps the native modal window off the top of whatever the user navigated to.
  const screenFocused = useIsFocused();

  useEffect(() => {
    Animated.timing(t, {
      toValue: visible ? 1 : 0,
      duration: visible ? 260 : 170,
      easing: visible ? Easing.out(Easing.cubic) : Easing.in(Easing.quad),
      useNativeDriver: true,
    }).start();
    if (visible) {
      setNote(null);
      setPassState('loading');
      // The paywall is the one moment a free user meets a price; until 2026-10 nothing recorded it.
      track('paywall_shown', { forEmployer: !!employer }).catch(() => {});
      fetchPassPrice()
        .then((p) => {
          setPrice(p);
          setPassState(p ? 'available' : 'unavailable');
          track('paywall_pass', { available: !!p }).catch(() => {});
        })
        .catch(() => { setPrice(null); setPassState('unavailable'); });
      // A purchase Play still holds unconsumed is money we took and never honoured. Heal it as the
      // sheet opens, so someone who was cut off mid-verification is not asked to pay a second time.
      // No-op everywhere but Android; the server dedupes, so it cannot grant twice.
      recoverStrandedPasses().catch(() => {});
    }
  }, [visible, t, employer]);

  // Coming BACK from the plans screen. If they subscribed, this sheet has nothing left to offer;
  // if they backed out, it stays exactly as it was and the one-off is still there.
  useFocusEffect(useCallback(() => {
    if (!visible) return;
    let alive = true;
    fetchDownloadState(employer).then((s) => {
      if (!alive) return;
      if (s.unlimited || s.ownsEmployer || s.passes > 0 || (s.paid && (s.remaining ?? 0) > 0)) onUnlocked();
    }).catch(() => {});
    return () => { alive = false; };
  }, [visible, employer, onUnlocked]));

  const buy = async () => {
    if (busy || passState !== 'available') return;
    setBusy(true); setNote(null);
    track('paywall_pass_tap', { price }).catch(() => {});
    // What the purchase ended as. ⚠️ `paid` and `pending` are not failures (see BuyResult) — counting them as
    // such would make the funnel lie in exactly the direction that hides money we took.
    let result = 'failed';
    try {
      const r = await buyDownloadPass(employer);
      result = r.ok ? 'ok' : r.cancelled ? 'cancelled' : r.pending ? 'pending' : r.paid ? 'paid_unconfirmed' : 'failed';
      if (r.ok) { onUnlocked(); return; }
      if (r.cancelled) return;                       // they changed their mind; say nothing
      setNote(r.message || 'That did not go through.');
    } finally {
      track('pass_purchase_result', { result }).catch(() => {});
      setBusy(false);
    }
  };

  const seePlans = () => { track('paywall_plans_tap', { pass: passState }).catch(() => {}); onSeePlans(); };
  const dismiss = () => { if (busy) return; track('paywall_dismissed', { pass: passState }).catch(() => {}); onClose(); };
  const passOff = passState === 'unavailable';

  const who = employer ? employer : 'this employer';

  return (
    <Modal visible={visible && screenFocused} transparent animationType="none" onRequestClose={dismiss} statusBarTranslucent>
      <View style={s.fill}>
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: t }]}><View style={s.scrim} /></Animated.View>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={busy ? undefined : dismiss} />

        <Animated.View
          style={[s.sheet, {
            paddingBottom: insets.bottom + 14,
            transform: [{ translateY: t.interpolate({ inputRange: [0, 1], outputRange: [460, 0] }) }],
          }]}
        >
          <View style={s.grab} />
          <View style={s.headRow}>
            <View style={{ flex: 1 }}>
              <Text style={s.h}>Download this document</Text>
              <Text style={s.sub} numberOfLines={2}>Previewing every design is free. Downloading is paid.</Text>
            </View>
            <TouchableOpacity onPress={dismiss} style={s.x} activeOpacity={0.85} disabled={busy} accessibilityLabel="Close">
              <Ionicons name="close" size={18} color={E.textMuted} />
            </TouchableOpacity>
          </View>

          {/* ── one-off ─────────────────────────────────────────────────────────────────── */}
          <TouchableOpacity
            style={[s.one, passOff && s.oneOff]}
            activeOpacity={0.9}
            onPress={buy}
            disabled={busy || passState !== 'available'}
            accessibilityState={{ disabled: busy || passState !== 'available' }}
          >
            <View style={[s.oneIcon, passOff && s.oneIconOff]}><Ionicons name="download" size={19} color="#fff" /></View>
            <View style={{ flex: 1 }}>
              <Text style={[s.oneTitle, passOff && s.textOff]} numberOfLines={1}>Just this one</Text>
              {/* 3 lines: at 2 an iPhone 16 Pro cut "One payment, no subscription" to "no s…" — the one line that says it isn't a subscription. */}
              <Text style={s.oneSub} numberOfLines={3}>
                {passOff
                  ? 'One-off downloads are not available in your store yet.'
                  : `Unlocks every design and the cover letter for ${who}. One payment, no subscription.`}
              </Text>
            </View>
            {busy
              ? <ActivityIndicator color={E.blueDeep} />
              : passState === 'loading'
                ? <ActivityIndicator size="small" color={E.textFaint} />
                : <Text style={[s.price, passOff && s.textOff]} numberOfLines={1}>{passOff ? 'Soon' : price}</Text>}
          </TouchableOpacity>

          {/* ── the plan ────────────────────────────────────────────────────────────────── */}
          <TouchableOpacity style={[s.planRow, passOff && s.planRowPrimary]} activeOpacity={0.9} onPress={seePlans} disabled={busy}>
            <LinearGradient colors={[E.blue, E.purple]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.planIcon}>
              <Ionicons name="sparkles" size={17} color="#fff" />
            </LinearGradient>
            <View style={{ flex: 1 }}>
              <Text style={s.planTitle} numberOfLines={1}>{passOff ? 'Take a monthly plan' : 'Or take a monthly plan'}</Text>
              <Text style={s.planSub} numberOfLines={2}>
                Downloads every month, plus AI resumes and cover letters.
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={E.textFaint} />
          </TouchableOpacity>

          {!!note && (
            <View style={s.note}>
              <Ionicons name="alert-circle-outline" size={14} color="#B45309" />
              <Text style={s.noteTx} numberOfLines={3}>{note}</Text>
            </View>
          )}
          {passState === 'loading' && (
            <Text style={s.unavailable} numberOfLines={2}>
              {Platform.OS === 'ios' ? 'Checking the App Store price…' : 'Checking the Play Store price…'}
            </Text>
          )}
        </Animated.View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1, justifyContent: 'flex-end' },
  scrim: { flex: 1, backgroundColor: 'rgba(7,10,24,0.55)' },
  sheet: {
    backgroundColor: E.surface, borderTopLeftRadius: 26, borderTopRightRadius: 26,
    paddingHorizontal: 16, paddingTop: 8,
  },
  grab: { alignSelf: 'center', width: 38, height: 4, borderRadius: 100, backgroundColor: '#D7DEEA', marginBottom: 10 },
  headRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  h: { fontSize: 19, fontWeight: '800', color: E.ink, letterSpacing: -0.4 },
  sub: { fontSize: 12.5, fontWeight: '600', color: E.textMuted, marginTop: 3 },
  x: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: E.inputBg },
  one: {
    flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 16, padding: 13,
    borderRadius: 16, borderWidth: 1.5, borderColor: 'rgba(79,141,255,0.55)', backgroundColor: 'rgba(79,141,255,0.07)',
  },
  oneOff: { borderColor: E.border, backgroundColor: E.inputBg },
  oneIconOff: { backgroundColor: E.textFaint },
  textOff: { color: E.textFaint },
  planRowPrimary: { borderWidth: 1.5, borderColor: 'rgba(79,141,255,0.55)', backgroundColor: 'rgba(79,141,255,0.07)' },
  oneIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: E.blueDeep, alignItems: 'center', justifyContent: 'center' },
  oneTitle: { fontSize: 15, fontWeight: '800', color: E.ink },
  oneSub: { fontSize: 11.5, fontWeight: '600', color: E.textMuted, marginTop: 2, lineHeight: 15 },
  price: { fontSize: 16, fontWeight: '800', color: E.blueDeep, flexShrink: 0 },
  planRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 10, padding: 13,
    borderRadius: 16, borderWidth: 1, borderColor: E.border, backgroundColor: E.inputBg,
  },
  planIcon: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  planTitle: { fontSize: 14.5, fontWeight: '800', color: E.ink },
  planSub: { fontSize: 11.5, fontWeight: '600', color: E.textMuted, marginTop: 2, lineHeight: 15 },
  note: { flexDirection: 'row', alignItems: 'flex-start', gap: 7, marginTop: 12 },
  noteTx: { flex: 1, fontSize: 12, fontWeight: '600', color: '#92400E', lineHeight: 16 },
  unavailable: { marginTop: 10, fontSize: 11.5, fontWeight: '600', color: E.textFaint, textAlign: 'center' },
});
