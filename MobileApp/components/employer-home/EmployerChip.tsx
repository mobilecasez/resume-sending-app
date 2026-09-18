// AI Hub — new feature. Safe to delete without affecting existing app.
//
// ONE EMPLOYER CHIP in Home's "Designing for" row — extracted from EmployerHome so the chip can own
// its build status without dragging the whole screen into every progress tick.
//
// What a chip shows, beyond the name:
//   · an X (top-right, INSIDE the chip) that asks the parent to soft-remove it — the parent does the
//     optimistic exit + undo; the chip only plays the exit when `exiting` flips on;
//   · the live state of THIS target's build (services/homeBuilds) — a thin track + '<pct>%' while it
//     checks or builds, 'Queued', 'Didn’t finish' (or 'AI was busy' / 'AI unavailable' — see errorLineFor),
//     or a mint check for a few seconds after it lands;
//   · a tiny mint dot when a tailored document already exists for it (`hasDoc`).
//
// ⚠️ ANIMATION DRIVER RULE (the b126-128 fatal crash): this chip lives inside the hero's native tree.
// EVERY Animated value here uses useNativeDriver:true and animates transform/opacity ONLY — the
// progress track grows by scaleX (+ a compensating translateX), never by width.
// ⚠️ THE TICKING PERCENTAGE IS STATE IN AN ISOLATED MEMO CHILD (ChipBuildLine), never in the chip:
// useCreepPct re-renders every 90 ms, and a tick in the chip would re-render the tile, the gradient
// and the glow with it — in every building chip at once.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated, Easing, Platform } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { E } from './theme';
import type { Target } from '../../services/employerHomeService';
import type { DocKind, BuildStage } from '../../services/homeAddEmployer';
import { useTargetBuild, useCreepPct, storeKeyOf, type BuildPhase } from '../../services/homeBuilds';

export type EmployerChipProps = {
  t: Target;
  index: number;
  on: boolean;
  onPick: (i: number) => void;
  onRemove: (i: number) => void;
  /** Non-zero only on the chip that was just added; a new value replays the entrance. */
  enterToken?: number;
  /** Which document's build this chip reports — the build store is keyed kind + '|' + rk. */
  kind: DocKind;
  /** The chip's render key (the same rk the parent hands useHomeBuilds). */
  rk: string;
  /** A tailored document of this kind is already saved for this target. */
  hasDoc?: boolean;
  /** The parent is removing this chip: play the exit and stop taking touches. */
  exiting?: boolean;
};

/** How long a landed build keeps its mint check on the chip. */
const DONE_FRESH_MS = 6000;

/**
 * The chip's second line for a build that ended without a document. ⚠️ A BUSY OR DOWN AI PROVIDER IS NOT "DIDN’T
 * FINISH" (2026-09-18): the server stopped before any charge, and a red "Didn’t finish" read as the build — or the
 * user — having failed. Those two say what happened, in the room a 48pt chip has, with a dot that is not red; the
 * whole sentence (nothing was charged, try again in a minute) is one tap away in the overlay. Every other reason
 * keeps the line it always had. Exported for the behavioural test only.
 */
export function errorLineFor(reason: string | null | undefined): { text: string; calm: boolean } {
  if (reason === 'ai_busy') return { text: 'AI was busy', calm: true };
  if (reason === 'ai_down') return { text: 'AI unavailable', calm: true };
  return { text: 'Didn’t finish', calm: false };
}

/** Width of the progress track — fixed, because the grow-from-left trick needs a known width. */
const TRACK_W = 44;
/** The X's touch slop. Module-level so the memoised chip never hands the touchable a fresh object. */
const REMOVE_SLOP = { top: 10, right: 10, bottom: 10, left: 3 };

// A boolean that is true until `since + ms`, re-rendering once when it expires. `since` null = off.
// ⚠️ One timeout, not an interval: the chip re-renders exactly once more, when the check should go.
function useFreshSince(since: number | null, ms: number): boolean {
  const [, expire] = useState(0);
  const left = since == null ? 0 : ms - (Date.now() - since);
  useEffect(() => {
    if (since == null) return;
    const wait = ms - (Date.now() - since);
    if (wait <= 0) return;
    const id = setTimeout(() => expire((n) => n + 1), wait + 16);
    return () => clearTimeout(id);
  }, [since, ms]);
  return left > 0;
}

// The '<pct>%' + track line under the name while a build checks or runs.
// ⚠️ ISOLATED + MEMOISED: this is the only component that ticks. Its props are the store record's
// stage and phase, which change a handful of times per build — the 90 ms creep lives in here.
// ⚠️ `buildKey` (storeKeyOf(kind, rk), a stable string) is handed to useCreepPct so this line and the
// carousel's building card read and write ONE shared last-shown value: a card that mounts late used to
// seed at the stage ceiling while the chip was still creeping, and the two showed different numbers.
const ChipBuildLine = React.memo(function ChipBuildLine({ stage, phase, on, buildKey }: {
  stage: BuildStage | null; phase: BuildPhase; on: boolean; buildKey: string;
}) {
  const pct = useCreepPct(stage, phase, buildKey);
  const p = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    // ⚠️ NATIVE timing, restarted per whole-percent step: the native driver takes its from-value from
    // the native node, so an interrupted step continues from where the bar is, never jumps back.
    const a = Animated.timing(p, {
      toValue: Math.max(0, Math.min(100, pct)) / 100,
      duration: 240, easing: Easing.out(Easing.quad), useNativeDriver: true,
    });
    a.start();
    return () => a.stop();
  }, [pct, p]);
  // Grow from the LEFT edge: scaleX scales about the centre, so shift left by the half that is
  // missing. Built once — a fresh interpolate() per render re-attaches the native nodes.
  const fillStyle = useMemo(() => ({
    transform: [
      { translateX: p.interpolate({ inputRange: [0, 1], outputRange: [-TRACK_W / 2, 0], extrapolate: 'clamp' }) },
      // ⚠️ never exactly 0 — a singular transform matrix is dropped (and warned about) on iOS
      { scaleX: p.interpolate({ inputRange: [0, 1], outputRange: [0.001, 1], extrapolate: 'clamp' }) },
    ],
  }), [p]);
  return (
    <View style={s.buildLine}>
      <View style={[s.track, on && s.trackOn]}>
        <Animated.View style={[s.trackFill, fillStyle]} />
      </View>
      <Text style={[s.buildPct, on && s.buildPctOn]} numberOfLines={1}>{pct}%</Text>
    </View>
  );
});

function EmployerChipImpl({
  t, index, on, onPick, onRemove, enterToken = 0, kind, rk, hasDoc = false, exiting = false,
}: EmployerChipProps) {
  const onPress = useCallback(() => onPick(index), [onPick, index]);
  const onPressRemove = useCallback(() => onRemove(index), [onRemove, index]);

  // ⚠️ SUBSCRIBES TO ITS OWN RECORD ONLY: useTargetBuild re-renders this chip when THIS target's
  // build record object changes — a stage change on another chip never touches this one.
  const build = useTargetBuild(kind, rk);
  const phase: BuildPhase | null = build ? build.phase : null;
  const running = phase === 'checking' || phase === 'building';
  const doneFresh = useFreshSince(phase === 'done' && build ? build.updatedAt : null, DONE_FRESH_MS);
  const errLine = errorLineFor(phase === 'error' && build && build.error ? build.error.reason : null);

  // ⚠️ NATIVE DRIVER, transform + opacity ONLY: this chip lives inside the hero's native tree
  // (see ANIMATION DRIVER RULE). A chip that is not new starts at rest and never animates.
  const pop = useRef(new Animated.Value(enterToken ? 0 : 1)).current;
  const glow = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!enterToken) return;
    pop.setValue(0);
    glow.setValue(0);
    const a = Animated.parallel([
      Animated.spring(pop, { toValue: 1, friction: 6, tension: 90, useNativeDriver: true }),
      Animated.sequence([
        Animated.delay(160),
        Animated.timing(glow, { toValue: 1, duration: 260, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(glow, { toValue: 0.3, duration: 380, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(glow, { toValue: 1, duration: 300, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(glow, { toValue: 0, duration: 720, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      ]),
    ]);
    a.start();
    // ⚠️ Settle, not just stop: when another chip is added the token here drops to 0 mid-entrance,
    // and a stopped value would leave this chip frozen half-scaled.
    return () => { a.stop(); pop.setValue(1); glow.setValue(0); };
  }, [enterToken, pop, glow]);

  // The exit is its OWN value on an OUTER view, not folded into `pop`: an exit that starts while the
  // entrance spring is still running would otherwise fight it for the same node.
  const out = useRef(new Animated.Value(exiting ? 0 : 1)).current;
  const firstExit = useRef(true);
  useEffect(() => {
    if (firstExit.current) { firstExit.current = false; if (!exiting) return; }
    const a = Animated.timing(out, {
      toValue: exiting ? 0 : 1, duration: 180,
      easing: exiting ? Easing.in(Easing.quad) : Easing.out(Easing.quad), useNativeDriver: true,
    });
    a.start();
    return () => a.stop();
  }, [exiting, out]);

  // Built once per value, not per render: a fresh interpolate() re-creates the native animated nodes
  // and re-attaches them, mid-entrance, for nothing.
  const popStyle = useMemo(() => ({
    opacity: pop.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 1, 1], extrapolate: 'clamp' }),
    transform: [{ scale: pop.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) }],
  }), [pop]);
  const outStyle = useMemo(() => ({
    opacity: out,
    transform: [{ scale: out.interpolate({ inputRange: [0, 1], outputRange: [0.82, 1], extrapolate: 'clamp' }) }],
  }), [out]);
  const glowStyle = useMemo(() => [s.chipGlow, { opacity: glow }], [glow]);

  return (
    <Animated.View style={outStyle} pointerEvents={exiting ? 'none' : 'auto'}>
      <Animated.View style={popStyle}>
        <TouchableOpacity
          onPress={onPress}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityState={{ selected: on, busy: running }}
          accessibilityHint={hasDoc ? 'tailored' : undefined}
          style={[s.chip, on && s.chipOn]}
        >
          <View>
            <LinearGradient colors={t.colors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.chipTile}>
              <Text style={s.chipTileTx}>{t.initial}</Text>
            </LinearGradient>
            {/* On the tile's corner, not in the text column: it must not cost the name any width. */}
            {hasDoc && <View style={s.docDot} pointerEvents="none" />}
          </View>
          {/* Two lines, because a chip identifies a POSTING: the same employer can appear twice and the
              role underneath is the only thing telling the two apart. While a build is live the second
              line reports it instead — the chip stays 48 pt tall (the row clips at 48). */}
          <View style={s.chipText}>
            <Text style={[s.chipName, on && s.chipNameOn]} numberOfLines={1}>{t.company}</Text>
            {running && build ? (
              <ChipBuildLine stage={build.stage} phase={build.phase} on={on} buildKey={storeKeyOf(kind, rk)} />
            ) : phase === 'queued' ? (
              <View style={s.statusRow}>
                <Ionicons name="time-outline" size={10} color="rgba(255,255,255,0.62)" />
                <Text style={[s.statusTx, on && s.statusTxOn]} numberOfLines={1}>Queued</Text>
              </View>
            ) : phase === 'error' ? (
              <View style={s.statusRow}>
                <View style={[s.errDot, errLine.calm && s.calmDot]} />
                <Text style={[s.statusTx, on && s.statusTxOn]} numberOfLines={1}>{errLine.text}</Text>
              </View>
            ) : (
              !!t.role && <Text style={[s.chipRole, on && s.chipRoleOn]} numberOfLines={1}>{t.role}</Text>
            )}
          </View>
          {doneFresh ? (
            <Ionicons name="checkmark-circle" size={16} color={E.mint} accessibilityLabel="Ready" />
          ) : t.match != null ? (
            <View style={[s.chipPct, on && s.chipPctOn]}>
              <Text style={[s.chipPctTx, on && s.chipPctTxOn]}>{t.match}%</Text>
            </View>
          ) : null}
        </TouchableOpacity>
        {/* INSET, not a halo: the horizontal ScrollView clips to its 48pt row, so anything drawn
            outside the chip would be cut flat top and bottom. */}
        <Animated.View pointerEvents="none" style={glowStyle} />
        {/* ⚠️ A SIBLING OF THE CHIP'S TOUCHABLE, NOT A CHILD: a press here can never reach onPick.
            ⚠️ INSIDE the chip's box for the same 48pt clip — an overhanging badge would be cut in half.
            Sits in the chip's widened right padding, so it never covers the match pill.
            ⚠️ ASYMMETRIC SLOP, left ≤ 3: the X's left edge is only 5pt from the content (paddingRight 30 −
            right 5 − width 20), so a uniform hitSlop={10} reached 5pt into the match pill / name and a
            tap meant as a pick removed the employer. Right 10 stays short of the next chip (row gap 8,
            the X sits 5 in from this chip's edge). */}
        <TouchableOpacity
          onPress={onPressRemove}
          hitSlop={REMOVE_SLOP}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel={`Remove ${t.company}`}
          style={s.remove}
        >
          <Ionicons name="close" size={12} color="rgba(255,255,255,0.85)" />
        </TouchableOpacity>
      </Animated.View>
    </Animated.View>
  );
}

// ⚠️ MEMOISED, with a stable onPick/onRemove and its index instead of a per-render closure: Home
// re-renders on every build-stage tick, and each re-render used to re-render every chip in the row.
export const EmployerChip = React.memo(EmployerChipImpl);
export default EmployerChip;

// ⚠️ ANDROID Z-ORDER IS ELEVATION FIRST, SIBLING ORDER SECOND — for drawing AND for touch dispatch.
// chipOn gives the selected chip's touchable elevation 4 (its lit shadow), and that alone lifted it
// above its own X and glow even though both are later siblings: the X drew under the chip and a tap on
// it went to onPick. Moving the elevation up to the pop wrapper would keep the order but lose the
// shadow (a view with no background has no outline to cast one), so the two overlays sit one step
// higher instead. shadowColor transparent (API 28+) keeps them from casting a shadow of their own;
// elevation is a static style (the glow still animates opacity only, the X not at all), so the
// native-driver rule is untouched.
const ABOVE_CHIP_ANDROID = Platform.select({ android: { elevation: 5, shadowColor: 'transparent' }, default: {} });

const s = StyleSheet.create({
  // ⚠️ Selection is a GLASS state, never a white pill. A white chip on the dark hero was the single
  // loudest thing on the screen and fought every other surface; the selected chip should read as the
  // same material, lit.
  chip: {
    // paddingRight makes room for the X (right 5 + 20 wide + 5 gap); maxWidth grows by the same so
    // the name keeps the width it had before the X existed.
    height: 48, paddingLeft: 6, paddingRight: 30, borderRadius: 16, borderWidth: 1,
    borderColor: E.glassBorder, backgroundColor: E.glass,
    flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: 238,
  },
  chipText: { flexShrink: 1 },
  chipOn: {
    backgroundColor: 'rgba(79,141,255,0.22)', borderColor: 'rgba(150,186,255,0.6)',
    ...Platform.select({ ios: { shadowColor: E.blue, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.5, shadowRadius: 12 }, default: { elevation: 4 } }),
  },
  chipTile: { width: 30, height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  chipTileTx: { fontSize: 11.5, fontWeight: '800', color: '#fff' },
  chipName: { fontSize: 12.5, fontWeight: '700', color: 'rgba(255,255,255,0.8)', letterSpacing: -0.2 },
  chipRole: { fontSize: 10, fontWeight: '600', color: 'rgba(255,255,255,0.5)', marginTop: 1.5 },
  chipRoleOn: { color: 'rgba(255,255,255,0.78)' },
  chipNameOn: { color: '#fff', fontWeight: '800' },
  chipPct: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 100, backgroundColor: 'rgba(255,255,255,0.12)' },
  chipPctOn: { backgroundColor: 'rgba(255,255,255,0.22)' },
  chipPctTx: { fontSize: 9.5, fontWeight: '800', color: 'rgba(255,255,255,0.7)' },
  chipPctTxOn: { color: '#fff' },
  chipGlow: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 16,
    borderWidth: 1.5, borderColor: 'rgba(143,247,228,0.95)', backgroundColor: 'rgba(45,224,192,0.16)',
    ...ABOVE_CHIP_ANDROID,
  },

  // The X. top/right 5 keeps the whole 20pt circle inside the chip's 16pt corner arc.
  remove: {
    position: 'absolute', top: 5, right: 5, width: 20, height: 20, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.10)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
    ...ABOVE_CHIP_ANDROID,
  },

  // A saved tailored document. Ringed in the stage colour so it reads on any tile gradient.
  docDot: {
    position: 'absolute', top: -2, right: -2, width: 9, height: 9, borderRadius: 4.5,
    backgroundColor: E.mint, borderWidth: 1.5, borderColor: E.stage,
  },

  buildLine: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 4 },
  // overflow hidden clips the scaled fill to the rounded track
  track: { width: TRACK_W, height: 3, borderRadius: 2, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.14)' },
  trackOn: { backgroundColor: 'rgba(255,255,255,0.22)' },
  trackFill: { width: TRACK_W, height: 3, borderRadius: 2, backgroundColor: E.mint },
  // tabular digits: a ticking number must not make the chip breathe
  buildPct: { minWidth: 24, fontSize: 9.5, fontWeight: '800', color: 'rgba(255,255,255,0.72)', fontVariant: ['tabular-nums'] },
  buildPctOn: { color: '#fff' },

  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 1.5 },
  statusTx: { fontSize: 10, fontWeight: '700', color: 'rgba(255,255,255,0.62)' },
  statusTxOn: { color: 'rgba(255,255,255,0.85)' },
  errDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#FF6B81' },
  // The AI provider's ending — not the user's, and nothing was spent: the overlay's calm indigo, never red.
  calmDot: { backgroundColor: '#C7D2FE' },
});
