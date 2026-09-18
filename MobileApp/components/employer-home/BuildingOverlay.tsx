// AI Hub — new feature. Safe to delete without affecting existing app.
//
// THE SCREEN THAT PLAYS WHILE A RESUME IS BUILT FOR ONE EMPLOYER.
//
// An explicit Add on Home is the user saying "build it", so Home starts the build and raises this
// over itself: a white page assembling on the same navy mesh as Home, an AI core pulsing beside it,
// a beam reading down the page, and the server's own stage label under it. When the build lands the
// page stamps complete and the overlay gets out of the way by itself, so the caller can scroll to the
// new card.
//
// ⚠️ THIS FILE STARTS NOTHING AND CHARGES NOTHING. The gate (plan / free allowance / pass / cache) is
// the caller's, and so is every network call. This only ever calls back. That is on purpose: the
// letters auto-regeneration incident came from a SCREEN deciding to spend money on entry.
//
// ⚠️ A USED-UP ALLOWANCE NEVER MENTIONS CREDITS (the product owner's call, 2026-09-13). Credits no longer
// pay for a resume or a letter: generation is a plan's monthly allowance or the free one — 3 resumes and
// 3 letters, ONE TIME for the life of the account, never refilled. So "used up" says WHICH of the two ran
// out (allowanceOf) and offers exactly one way on: See plans.
//
// ⚠️ "KEEP IT BUILDING IN THE BACKGROUND" IS NOT CANCEL, AND ITS COPY MUST NEVER SAY SO. The async job
// is already on the server and is charged whether or not anyone watches it; closing this only hides
// it. A "Cancel" label would be a promise the system cannot keep.
//
// ⚠️ THE PERCENTAGE IS HONEST, WHICH MEANS IT STALLS. The server reports 8 / 14 / 22 / 30 / 38 and then
// says nothing for the 30-90s one Gemini call takes before 88. The number creeps toward the CURRENT
// stage's ceiling and stops there (BuildStep's rule, copied), so it never claims work that has not
// started. What keeps the screen from reading as hung during that stall is the motion — the beam, the
// rings, the drifting sparkles — which is why they loop for as long as the build runs.
//
// ⚠️ ANIMATION DRIVER RULE (the b126-128 fatal crash): a Modal is its own view tree, and every
// Animated value in it is useNativeDriver:true on transform/opacity ONLY. The page "draws in" with
// scaleX plus a translateX compensation, never width; the bar is scaleX the same way the onboarding
// bar is. The creeping % is plain React state rendered as TEXT, not an Animated value, so it cannot
// put a second driver in the tree. MeshStage (the backdrop) is native-only too.
//
// ONE OVERLAY, TWO DOCUMENTS. `kind` picks the words — a resume is "built" and "tailored", a cover
// letter is "written" — and nothing else: the gate, the stages, the reasons and every rule above are
// the same for both lanes, so they share one scene rather than drifting apart as two copies.
//
// ⚠️ stage 'checking' MEANS NOTHING HAS STARTED. Home raises the overlay while the dry-run gate is still
// answering; no job exists yet, so "Keep it building in the background" would describe a build that is
// not there. That state's footer is a plain Close, and says so.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Animated, Easing, Modal, Pressable, TouchableOpacity, ScrollView,
  useWindowDimensions, AccessibilityInfo, Platform,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MeshStage from './MeshStage';
import { E, SERIF, sweepWords } from './theme';
import type { BuildStage, DocKind } from '../../services/homeAddEmployer';
import { useCreepPct } from '../../services/homeBuilds';
import type { BuildPhase } from '../../services/homeBuilds';

type IconName = React.ComponentProps<typeof Ionicons>['name'];
type Mode = 'run' | 'done' | 'error';

/** The words that differ between the two lanes. Everything else on this screen is shared. */
type Words = {
  kicker: string;
  /** The document, lower-case, as it sits mid-sentence. */
  noun: string;
  /** Run title with an employer: before + the employer (serif) + after. */
  runBefore: string;
  runAfter?: string;
  /** Run title with no employer name to show. */
  runBare: string;
  /** VoiceOver hint on "Keep it building in the background". */
  keepHint: string;
};

const WORDS: Record<DocKind, Words> = {
  resume: {
    kicker: 'AI RESUME BUILDER',
    noun: 'resume',
    runBefore: 'Tailoring for',
    runBare: 'Tailoring your resume',
    keepHint: 'Closes this screen. Your resume keeps building.',
  },
  cover_letter: {
    kicker: 'AI COVER LETTER WRITER',
    noun: 'cover letter',
    runBefore: 'Writing your',
    runAfter: 'cover letter',
    runBare: 'Writing your cover letter',
    keepHint: 'Closes this screen. Your cover letter keeps being written.',
  },
};

/** An unknown kind from a caller falls back to the resume copy rather than rendering blanks. */
const wordsFor = (kind: DocKind | undefined): Words => WORDS[kind === 'cover_letter' ? 'cover_letter' : 'resume'];

/** Page ratio, the same one the renderer and PaperCarousel use. */
const A4 = 424 / 300;
/** How long the finished page sits on screen before the overlay dismisses itself. */
const DONE_HOLD_MS = 1100;
/** The page's first assembly. Long enough to watch, short enough to finish before stage two. */
const INTRO_MS = 3400;

const MINT = ['#8FF7E4', '#2DE0C0', '#12BFA6'] as const;
const MINT_INK = '#04211C';

/**
 * ⚠️ CAPS ON DYNAMIC TYPE. At the largest iOS accessibility sizes an uncapped 23pt title and 13.5pt
 * body grew past a 667pt iPhone SE, pushed the footer off screen, and left an error state with no
 * reachable way out. The copy still scrolls (see Scene), but the caps keep the buttons on the first
 * screenful for every size short of the absurd.
 */
const FONT_CAP = { title: 1.3, body: 1.5, button: 1.4, pct: 1.3, small: 1.5 };

/* ── motion helpers ─────────────────────────────────────────────────────────────────────────── */

/**
 * The OS "reduce motion" switch. When it is on the page arrives whole and nothing loops — the stage
 * label and the percentage still say everything the motion says.
 *
 * ⚠️ null MEANS "NOT KNOWN YET", AND NOTHING ANIMATED MOUNTS WHILE IT IS null. Defaulting to false let
 * the intro, the rings, the sparks and the backdrop's washes all START before the promise resolved, so
 * a user who asked for no motion got a burst of it on every showing. If the OS never answers, the
 * fallback is the STATIC look — the safe side of a wrong guess is too little motion, not too much —
 * and it cannot be left at null, because an overlay that never mounts its content is an invisible
 * Modal swallowing every tap on Home.
 */
const REDUCE_MOTION_WAIT_MS = 500;
function useReduceMotion(): boolean | null {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => { if (alive) setOn(!!v); })
      .catch(() => { if (alive) setOn((o) => (o === null ? true : o)); });
    const id = setTimeout(() => { if (alive) setOn((o) => (o === null ? true : o)); }, REDUCE_MOTION_WAIT_MS);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (v) => setOn(!!v));
    return () => { alive = false; clearTimeout(id); sub.remove(); };
  }, []);
  return on;
}

/**
 * One element of the page drawing in from its left edge.
 *
 * ⚠️ scaleX SCALES ABOUT THE CENTRE, so on its own a line would grow out of its middle. translateX
 * pins the left edge: at scale s the left edge has moved in by (1 - s) * W / 2, and translating by
 * (s - 1) * W / 2 puts it back. The two ranges below are that formula evaluated at each stop — keep
 * them in step if you touch one. The floor is 0.001, not 0: a zero scale is a singular matrix and
 * iOS logs CGAffineTransformInvert for every frame of it.
 *
 * ⚠️ NO `easing` ON THE INTERPOLATION. A JS easing function cannot be serialised to the native
 * driver; the ease-out is faked with a middle stop instead.
 */
function drawIn(v: Animated.Value, from: number, to: number, width: number) {
  const mid = from + (to - from) * 0.55;
  return {
    opacity: v.interpolate({ inputRange: [from, from + 0.02], outputRange: [0, 1], extrapolate: 'clamp' }),
    transform: [
      { translateX: v.interpolate({ inputRange: [from, mid, to], outputRange: [-width * 0.4995, -width * 0.075, 0], extrapolate: 'clamp' }) },
      { scaleX: v.interpolate({ inputRange: [from, mid, to], outputRange: [0.001, 0.85, 1], extrapolate: 'clamp' }) },
    ],
  };
}

/* ── the page ───────────────────────────────────────────────────────────────────────────────── */

type Line = { x: number; y: number; w: number; h: number; color: string; from: number; to: number; flash: boolean };

/** [top as a fraction of the page, widths of its rule lines as a fraction of the text column]. */
const SECTIONS: Array<[number, number[]]> = [
  [0.25, [0.92, 0.76, 0.85]],
  [0.50, [0.83, 0.95, 0.60]],
  // Ragged on purpose, and shorter at the foot: even lengths read as a barcode, not a page.
  [0.74, [0.88, 0.68]],
];

/** Every mark on the page, in points, with the slice of the intro timeline it draws in over. */
function pageLayout(w: number, h: number) {
  const pad = Math.round(w * 0.1);
  const col = w - pad * 2;
  const bandH = Math.round(h * 0.17);
  const avatar = Math.round(bandH * 0.52);
  const textX = pad + avatar + Math.round(w * 0.05);
  const textCol = w - textX - pad;
  const nameH = Math.max(5, Math.round(w * 0.04));
  const ruleH = Math.max(3, Math.round(w * 0.022));
  const headH = Math.max(4, Math.round(w * 0.03));
  const nameY = Math.round(bandH * 0.3);

  const head: Line[] = [
    { x: textX, y: nameY, w: Math.round(textCol * 0.78), h: nameH, color: '#FFFFFF', from: 0.13, to: 0.26, flash: false },
    { x: textX, y: nameY + nameH + Math.max(4, Math.round(bandH * 0.12)), w: Math.round(textCol * 0.52), h: ruleH, color: 'rgba(255,255,255,0.72)', from: 0.2, to: 0.3, flash: false },
  ];

  const body: Line[] = [];
  SECTIONS.forEach(([top, rules]) => {
    const y = Math.round(h * top);
    body.push({ x: pad, y, w: Math.round(col * 0.34), h: headH, color: E.blueDeep, from: 0, to: 0, flash: true });
    rules.forEach((r, k) => {
      body.push({
        x: pad, y: y + Math.round(h * 0.058) + k * Math.round(h * 0.044), w: Math.round(col * r), h: ruleH,
        color: '#DCE3EE', from: 0, to: 0, flash: true,
      });
    });
  });
  // The body writes itself top to bottom across the rest of the intro, each line overlapping the
  // next a little so it reads as one hand moving rather than a list of separate events.
  const step = 0.66 / body.length;
  body.forEach((l, i) => { l.from = 0.3 + i * step; l.to = Math.min(1, l.from + 0.12); });

  return { bandH, avatar, avatarX: pad, avatarY: Math.round((bandH - avatar) / 2), lines: [...head, ...body] };
}

/**
 * What the page is doing. `built` is a build that really finished whose pages did not refresh: the
 * page is whole and stamped. `hold` is every other non-running state — it FREEZES where it is.
 */
type PaperMode = 'run' | 'done' | 'built' | 'hold';

function Paper({ w, h, mode, reduce }: { w: number; h: number; mode: PaperMode; reduce: boolean }) {
  const whole0 = reduce && mode !== 'hold' ? 1 : 0;
  const build = useRef(new Animated.Value(whole0)).current;
  const scan = useRef(new Animated.Value(0)).current;
  const stamp = useRef(new Animated.Value(0)).current;
  // How much of the page is drawn, as the native side last reported it. Only used to size the rest
  // of the intro; the animation itself starts from the node's own native value.
  const drawn = useRef(whole0);
  const geo = useMemo(() => pageLayout(w, h), [w, h]);
  const beamH = Math.max(28, Math.round(h * 0.16));

  useEffect(() => {
    if (mode === 'run') {
      stamp.setValue(0);
      if (reduce) { build.setValue(1); drawn.current = 1; return; }
      // ⚠️ CONTINUES FROM WHERE THE PAGE IS; NEVER setValue(0). This component mounts once per
      // SHOWING (the Scene is unmounted while hidden), so a fresh showing starts blank by construction.
      // Re-entering `run` within a showing is Home's "load my pages" retry at 97% — resetting here
      // wiped a built page and re-ran the whole intro under a number that said nearly done.
      scan.setValue(0);
      const from = Math.max(0, Math.min(1, drawn.current));
      const a = Animated.sequence([
        Animated.timing(build, {
          toValue: 1, duration: Math.round(INTRO_MS * (1 - from)), delay: from > 0 ? 0 : 220,
          easing: Easing.inOut(Easing.quad), useNativeDriver: true,
        }),
        // ⚠️ THE BEAM ONLY STARTS ONCE THE PAGE IS WHOLE. The line flashes below are keyed to the
        // beam's position, and a flash on a line that has not drawn yet lights up empty paper.
        Animated.loop(Animated.sequence([
          Animated.timing(scan, { toValue: 1, duration: 2600, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
          Animated.delay(650),
        ])),
      ]);
      a.start();
      // ⚠️ Park the beam on the way out. A loop stopped mid-sweep freezes a line mid-flash, and
      // scan = 0 is the one value at which every flash is dark and the beam is above the page.
      // stopAnimation(cb) asks the NATIVE node for its value; the JS copy is stale under the native
      // driver, so reading it directly would always say "nothing drawn".
      return () => { a.stop(); build.stopAnimation((v) => { drawn.current = v; }); scan.setValue(0); };
    }
    if (mode === 'hold') {
      // ⚠️ AN ERROR NEVER FINISHES THE PAGE. Completing the drawing here put a whole, finished-looking
      // resume behind "You've used your free resume generations" — a picture of the thing we just said
      // the user cannot have. Whatever was drawn stays exactly as it was (blank, for a gate refusal).
      // Under reduce motion the run page is a whole placeholder with no in-between, so blank is the
      // only honest picture — and it is a cut, not a motion.
      stamp.setValue(0);
      if (reduce) { build.setValue(0); drawn.current = 0; }
      return;
    }
    // Done, or built-but-not-refreshed: whatever was mid-draw finishes, so a REAL page is never left
    // half-built.
    // ⚠️ PARALLEL, NOT A SEQUENCE. A timing from 1 to 1 still takes its full duration, so a sequence
    // made the stamp wait 320ms on an already-whole page — a third of the 1.1s the user gets to see it.
    drawn.current = 1;
    const a = Animated.parallel([
      Animated.timing(build, { toValue: 1, duration: reduce ? 0 : 320, useNativeDriver: true }),
      reduce
        ? Animated.timing(stamp, { toValue: 1, duration: 0, useNativeDriver: true })
        : Animated.spring(stamp, { toValue: 1, friction: 5, tension: 140, useNativeDriver: true }),
    ]);
    a.start();
    return () => a.stop();
  }, [mode, reduce, build, scan, stamp]);

  // Interpolations are built once per page size, not per render: re-creating native nodes on every
  // parent render detaches and re-attaches them mid-loop for nothing.
  const styles = useMemo(() => {
    const flashAt = (l: Line) => {
      // Where `scan` puts the beam's centre on this line: the beam travels from -beamH to h.
      const c = (l.y + l.h / 2 + beamH / 2) / (h + beamH);
      return scan.interpolate({
        inputRange: [Math.max(0, c - 0.05), c, Math.min(1, c + 0.12)],
        outputRange: [0, 0.9, 0],
        extrapolate: 'clamp',
      });
    };
    return {
      band: drawIn(build, 0, 0.13, w),
      avatar: {
        opacity: build.interpolate({ inputRange: [0.08, 0.1], outputRange: [0, 1], extrapolate: 'clamp' }),
        transform: [{ scale: build.interpolate({ inputRange: [0.08, 0.15, 0.2], outputRange: [0.001, 1.12, 1], extrapolate: 'clamp' }) }],
      },
      lines: geo.lines.map((l) => ({ draw: drawIn(build, l.from, l.to, l.w), flash: l.flash ? flashAt(l) : null })),
      beam: { transform: [{ translateY: scan.interpolate({ inputRange: [0, 1], outputRange: [-beamH, h] }) }] },
      stamp: {
        opacity: stamp.interpolate({ inputRange: [0, 0.35], outputRange: [0, 1], extrapolate: 'clamp' }),
        // Extends past 1 on purpose: the spring's overshoot squashes the stamp slightly as it lands.
        transform: [{ scale: stamp.interpolate({ inputRange: [0, 1], outputRange: [1.9, 1] }) }, { rotate: '-8deg' }],
      },
    };
  }, [build, scan, stamp, geo, w, h, beamH]);

  const stampSize = Math.round(w * 0.34);

  return (
    <View style={[s.paper, { width: w, height: h }]}>
      <Animated.View style={[s.abs, { left: 0, top: 0, width: w, height: geo.bandH }, styles.band]}>
        <LinearGradient colors={[E.blue, E.purple]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
      </Animated.View>
      <Animated.View
        style={[s.abs, s.avatar, {
          left: geo.avatarX, top: geo.avatarY, width: geo.avatar, height: geo.avatar, borderRadius: geo.avatar / 2,
        }, styles.avatar]}
      />
      {geo.lines.map((l, i) => (
        <React.Fragment key={i}>
          <Animated.View
            style={[s.abs, { left: l.x, top: l.y, width: l.w, height: l.h, borderRadius: l.h / 2, backgroundColor: l.color }, styles.lines[i].draw]}
          />
          {/* The AI "rewriting" a line as the beam passes over it: a mint copy of the same line,
              lit only while the beam is on it. Same geometry, so it can never look misaligned. */}
          {!!styles.lines[i].flash && (
            <Animated.View
              style={[s.abs, s.flash, { left: l.x, top: l.y, width: l.w, height: l.h, borderRadius: l.h / 2, opacity: styles.lines[i].flash as any }]}
            />
          )}
        </React.Fragment>
      ))}
      {mode === 'run' && !reduce && (
        <Animated.View pointerEvents="none" style={[s.abs, { left: 0, top: 0, width: w, height: beamH }, styles.beam]}>
          {/* ⚠️ Ends on zero alpha of ITS OWN colour, never 'transparent' (transparent BLACK), which
              would drag a grey band down a white page — the same trap MeshStage documents. */}
          <LinearGradient
            colors={['rgba(94,234,212,0)', 'rgba(94,234,212,0.30)', 'rgba(79,141,255,0)']}
            locations={[0, 0.78, 1]}
            start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
          <View style={[s.beamEdge, { top: Math.round(beamH * 0.78) }]} />
        </Animated.View>
      )}
      {(mode === 'done' || mode === 'built') && (
        <Animated.View
          pointerEvents="none"
          style={[s.abs, s.stampRing, {
            left: (w - stampSize) / 2, top: Math.round(h * 0.47 - stampSize / 2),
            width: stampSize, height: stampSize, borderRadius: stampSize / 2,
          }, styles.stamp]}
        >
          <LinearGradient
            colors={[E.teal, E.blue]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
            style={[s.stampFill, { borderRadius: (stampSize - 8) / 2 }]}
          >
            <Ionicons name="checkmark" size={Math.round(stampSize * 0.5)} color="#fff" />
          </LinearGradient>
        </Animated.View>
      )}
    </View>
  );
}

/* ── the AI core ────────────────────────────────────────────────────────────────────────────── */

/** One ripple leaving the core. Its own component so an unmounted ring has no loop at all. */
function Ring({ size, delay }: { size: number; delay: number }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    // The delay sits OUTSIDE the loop so it staggers the rings once instead of lengthening every
    // period — three rings with in-loop delays drift out of phase and bunch up.
    const a = Animated.sequence([
      Animated.delay(delay),
      Animated.loop(Animated.timing(v, { toValue: 1, duration: 2400, easing: Easing.out(Easing.quad), useNativeDriver: true })),
    ]);
    a.start();
    return () => a.stop();
  }, [delay, v]);
  return (
    <Animated.View
      pointerEvents="none"
      style={[s.abs, s.ring, {
        width: size, height: size, borderRadius: size / 2,
        opacity: v.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 0.6, 0] }),
        transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [1, 2.3] }) }],
      }]}
    />
  );
}

/**
 * How the core looks. `wait` is a state we cannot call a failure (still running, or a reason we do
 * not know): the build's own blue, no rings, no red.
 */
type CoreLook = 'run' | 'done' | 'wait' | 'error';

function Core({ look, size, reduce, icon, tint }: {
  look: CoreLook; size: number; reduce: boolean; icon: IconName; tint: string;
}) {
  const hover = useRef(new Animated.Value(0)).current;
  const pop = useRef(new Animated.Value(look === 'run' || reduce ? 1 : 0)).current;

  useEffect(() => {
    if (look === 'run') {
      if (reduce) return;
      const l = Animated.loop(Animated.sequence([
        Animated.timing(hover, { toValue: 1, duration: 1700, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(hover, { toValue: 0, duration: 1700, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]));
      l.start();
      return () => l.stop();
    }
    if (reduce) return;
    const a = Animated.spring(pop, { toValue: 1, friction: 5, tension: 120, useNativeDriver: true });
    a.start();
    return () => a.stop();
  }, [look, reduce, hover, pop]);

  const orbColors = look === 'done'
    ? ([E.teal, E.emerald] as const)
    : look === 'error' ? (['#1A2140', '#0E1428'] as const) : ([E.blue, E.purple] as const);

  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, s.center, {
        opacity: pop.interpolate({ inputRange: [0, 0.3], outputRange: [0, 1], extrapolate: 'clamp' }),
        transform: [
          { translateY: hover.interpolate({ inputRange: [0, 1], outputRange: [0, -5] }) },
          { scale: pop.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] }) },
        ],
      }]}
    >
      {look === 'run' && !reduce && [0, 800, 1600].map((d) => <Ring key={d} size={size} delay={d} />)}
      <Animated.View
        pointerEvents="none"
        style={[s.abs, {
          width: size * 1.6, height: size * 1.6, borderRadius: size * 0.8,
          backgroundColor: look === 'done' ? 'rgba(20,184,166,0.22)' : look === 'error' ? 'rgba(255,255,255,0.05)' : 'rgba(79,141,255,0.22)',
          opacity: hover.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }),
          transform: [{ scale: hover.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] }) }],
        }]}
      />
      <View style={[s.orbShadow, { width: size, height: size, borderRadius: size / 2 }, look === 'done' && s.orbShadowDone]}>
        <LinearGradient
          colors={orbColors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
          style={[s.orb, { borderRadius: size / 2 }, look === 'error' && s.orbError]}
        >
          <Ionicons name={icon} size={Math.round(size * 0.46)} color={tint} />
        </LinearGradient>
      </View>
      {look === 'run' && (
        <View style={[s.orbBadge, { right: -2, top: -2 }]}>
          <Ionicons name="sparkles" size={10} color={E.mint} />
        </View>
      )}
    </Animated.View>
  );
}

/* ── sparkles ───────────────────────────────────────────────────────────────────────────────── */

/** [x, y] as fractions of the page, placed OUTSIDE its edges — a sparkle over white paper is lost. */
const SPARKS: Array<{ x: number; y: number; size: number; color: string; delay: number }> = [
  { x: -0.13, y: 0.2, size: 12, color: E.mint, delay: 0 },
  { x: 1.1, y: 0.48, size: 14, color: E.purpleLite, delay: 700 },
  { x: -0.17, y: 0.7, size: 10, color: '#FFFFFF', delay: 1400 },
  { x: 1.07, y: 0.88, size: 11, color: '#9DBEFF', delay: 2100 },
  { x: 0.3, y: -0.11, size: 9, color: E.mint, delay: 1050 },
];

function Spark({ x, y, size, color, delay }: { x: number; y: number; size: number; color: string; delay: number }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const a = Animated.sequence([
      Animated.delay(delay),
      Animated.loop(Animated.timing(v, { toValue: 1, duration: 3200, easing: Easing.out(Easing.quad), useNativeDriver: true })),
    ]);
    a.start();
    return () => a.stop();
  }, [delay, v]);
  return (
    <Animated.View
      pointerEvents="none"
      style={[s.abs, {
        left: x - size / 2, top: y - size / 2,
        opacity: v.interpolate({ inputRange: [0, 0.35, 1], outputRange: [0, 1, 0] }),
        transform: [
          { translateY: v.interpolate({ inputRange: [0, 1], outputRange: [0, -18] }) },
          { scale: v.interpolate({ inputRange: [0, 0.35, 1], outputRange: [0.6, 1, 0.8] }) },
        ],
      }]}
    >
      <Ionicons name="sparkles" size={size} color={color} />
    </Animated.View>
  );
}

/* ── the words ──────────────────────────────────────────────────────────────────────────────── */

/**
 * The live stage label, crossfading when the server moves on.
 *
 * ⚠️ THE TEXT SWAPS AT THE BOTTOM OF THE FADE, AND THE FADE-IN IS DRIVEN BY `text === shown`, NOT BY
 * THE FADE-OUT'S CALLBACK. Polls can deliver a new label mid-fade, or the old one again; a callback
 * chain would either skip the newest label or leave the line stuck at opacity 0. Deriving the fade-in
 * from state means whatever the last word is, it ends up visible.
 */
function StageLabel({ text, tone }: { text: string; tone: 'run' | 'done' }) {
  const [shown, setShown] = useState(text);
  const o = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (text === shown) {
      const a = Animated.timing(o, { toValue: 1, duration: 240, easing: Easing.out(Easing.quad), useNativeDriver: true });
      a.start();
      return () => a.stop();
    }
    let alive = true;
    const a = Animated.timing(o, { toValue: 0, duration: 150, easing: Easing.in(Easing.quad), useNativeDriver: true });
    a.start(({ finished }) => { if (alive && finished) setShown(text); });
    return () => { alive = false; a.stop(); };
  }, [text, shown, o]);

  // iOS has no live regions; announcing is how VoiceOver hears the stage move on.
  useEffect(() => {
    if (Platform.OS === 'ios' && shown) AccessibilityInfo.announceForAccessibility(shown);
  }, [shown]);

  return (
    <Animated.Text
      style={[s.stage, tone === 'done' && s.stageDone, {
        opacity: o, transform: [{ translateY: o.interpolate({ inputRange: [0, 1], outputRange: [4, 0] }) }],
      }]}
      numberOfLines={2}
      maxFontSizeMultiplier={FONT_CAP.body}
      accessibilityLiveRegion="polite"
      accessibilityLabel={shown}
    >
      {shown}
    </Animated.Text>
  );
}

/**
 * The percentage and the bar. ⚠️ ITS OWN COMPONENT BECAUSE IT RE-RENDERS EVERY 90ms while creeping;
 * kept up at the scene, every tick would re-render the page and rebuild its native nodes.
 *
 * The creep itself is services/homeBuilds' useCreepPct — the SAME curve the carousel's building cards
 * and the chip use, so the number on Home and the number in here never disagree about one build. It is
 * React state rendered as text, never an Animated value (the header's driver rule).
 *
 * ⚠️ `buildKey` IS WHAT MAKES "never disagree" TRUE. Keyless, the hook has no shared last-shown value to
 * read or write: this screen seeded at the CURRENT stage's ceiling and wrote nothing back, so opening the
 * overlay on a chip creeping at 24% read ~38% — two numbers for one build. A caller that passes no key
 * keeps the old ceiling-seeded behaviour rather than writing into some other build's shared number.
 */
function Progress({ pct, label, mode, checking, buildKey }: {
  pct: number; label: string; mode: 'run' | 'done'; checking: boolean;
  /** storeKeyOf(kind, rk) — the SAME string the chip's line and the carousel's card pass. */
  buildKey?: string;
}) {
  const target = mode === 'done' ? 100 : Math.max(0, Math.min(100, Number(pct) || 0));
  const phase: BuildPhase = mode === 'done' ? 'done' : checking ? 'checking' : 'building';
  // ⚠️ MEMOISED ON PRIMITIVES. Home hands down a fresh stage object on every poll; a hook keyed on the
  // object's identity would re-arm its ticker for a number that did not move.
  const creepStage = useMemo<BuildStage>(
    () => ({ stage: checking ? 'checking' : 'run', label, pct: target }),
    [checking, label, target],
  );
  const shown = useCreepPct(creepStage, phase, buildKey);
  const bar = useRef(new Animated.Value(Math.max(0.02, target / 100))).current;
  const [barW, setBarW] = useState(0);

  const whole = Math.max(0, Math.min(100, Math.round(Number(shown) || 0)));
  useEffect(() => {
    // Follows the NUMBER, not the server, so the bar and the digits can never disagree. It only
    // re-targets when the whole-number percentage changes, not on every 90ms tick.
    const a = Animated.timing(bar, { toValue: Math.max(0.02, whole / 100), duration: 240, easing: Easing.out(Easing.quad), useNativeDriver: true });
    a.start();
    return () => a.stop();
  }, [whole, bar]);

  // ⚠️ scaleX, not width — see the file header. translateX pins the fill's left edge to the track.
  const fillStyle = useMemo(() => ({
    transform: [{ translateX: Animated.multiply(Animated.add(bar, -1), barW / 2) }, { scaleX: bar }],
  }), [bar, barW]);

  return (
    <View style={s.progress}>
      <View style={s.progressRow}>
        <View style={s.stageWrap}><StageLabel text={label} tone={mode} /></View>
        <Text style={s.pct} accessibilityLabel={`${whole} percent`} maxFontSizeMultiplier={FONT_CAP.pct}>
          {whole}<Text style={s.pctSm}>%</Text>
        </Text>
      </View>
      <View style={s.track} onLayout={(e) => setBarW(e.nativeEvent.layout.width)}>
        <Animated.View style={[StyleSheet.absoluteFill, fillStyle]}>
          <LinearGradient colors={[E.blue, E.purpleLite, E.mint]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
        </Animated.View>
      </View>
    </View>
  );
}

/** "Tailoring for" in the sans, the employer in the sampled-gradient serif — Home's accent line. */
function Title({ before, company, after }: { before: string; company: string; after?: string }) {
  const words = company ? sweepWords(company) : [];
  return (
    <Text style={s.title} accessibilityRole="header" maxFontSizeMultiplier={FONT_CAP.title}>
      {before}
      {words.length > 0 && ' '}
      {words.map((wd, i) => (
        <Text key={i} style={[s.titleSerif, { color: wd.c }]}>{wd.w}{i < words.length - 1 ? ' ' : ''}</Text>
      ))}
      {!!after && ` ${after}`}
    </Text>
  );
}

function Primary({ label, icon, onPress }: { label: string; icon: IconName; onPress: () => void }) {
  return (
    <TouchableOpacity style={s.primaryWrap} activeOpacity={0.9} onPress={onPress} accessibilityRole="button">
      <LinearGradient colors={MINT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.primary}>
        <Ionicons name={icon} size={16} color={MINT_INK} />
        <Text style={s.primaryTx} numberOfLines={1} maxFontSizeMultiplier={FONT_CAP.button}>{label}</Text>
      </LinearGradient>
    </TouchableOpacity>
  );
}

function Secondary({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={s.secondary} activeOpacity={0.8} onPress={onPress} accessibilityRole="button">
      <Text style={s.secondaryTx} numberOfLines={1} maxFontSizeMultiplier={FONT_CAP.button}>{label}</Text>
    </TouchableOpacity>
  );
}

/**
 * Which footer a non-running state gets. `wait` and `unknown` never offer a rebuild; `built` retries
 * the page refresh, never the build; `down` (the AI provider refusing our key) is Close alone — a Try
 * again there could only fail the same way.
 */
type Outcome = 'plans' | 'upload' | 'retry' | 'wait' | 'built' | 'unknown' | 'down';

/**
 * Which allowance a 'quota_exhausted' / 'regen_limit' refusal ran out of: the FREE one (one time, never
 * refilled) or a PLAN's month.
 * ⚠️ THE SERVER'S OWN SENTENCE WINS WHEN IT SAYS. It refuses a free account with its "free" generations or
 * cover letters and a plan with "in your plan this month" — it counted the pool that refused, so it cannot be
 * wrong about which one. Only a sentence that names neither (a client-side gate refusal, say) falls back to
 * the caller's plan state; and 'regen_limit' only ever came from the free plan.
 */
function allowanceOf(reason: string, message: string, isPaid?: boolean): 'free' | 'plan' {
  if (reason === 'regen_limit') return 'free';
  const said = String(message || '');
  if (/\bfree\b/i.test(said)) return 'free';
  if (/\bthis month\b/i.test(said)) return 'plan';
  return isPaid ? 'plan' : 'free';
}

/**
 * What each non-running state honestly means, and what the core shows while saying it.
 *
 * ⚠️ A REASON THIS FILE DOES NOT RECOGNISE IS NOT A FAILURE. The old default said "That build didn't
 * finish" with Try again for ANY string — including the polling deadline, where the job was still
 * running on the server and would be charged when it landed. Try again there was an invitation to pay
 * twice. The polling deadline is now 'pending' (still running, never a rebuild), and anything else we
 * cannot name gets a neutral title, no Try again, and no red.
 *
 * ⚠️ `calm` = NOTHING WENT WRONG ON THE USER'S SIDE, AND NOTHING WAS SPENT: the AI provider was busy or down,
 * before any charge. The core waits instead of showing an error and the page is not dimmed — the screen must
 * not read as the user's mistake or their loss. Exported for the behavioural test only.
 */
export function errorCopy(reason: string, message: string, company: string, kind: DocKind, isPaid?: boolean): {
  title: string; body: string; icon: IconName; tint: string; outcome: Outcome; calm?: boolean;
} {
  const forWho = company ? `for ${company}` : 'for this employer';
  // Only the WORDS switch on kind. The outcome (and so the footer, and whether a rebuild is ever
  // offered) is the reason's alone — a letter's 'pending' is exactly as unsafe to rebuild as a resume's.
  const letter = kind === 'cover_letter';
  const noun = wordsFor(kind).noun;
  switch (reason) {
    case 'quota_exhausted':
    case 'regen_limit': {
      // ⚠️ NO CREDITS, AND NO PROMISE THE FREE ONES COME BACK: they are one time. See the header.
      const used = allowanceOf(reason, message, isPaid);
      if (used === 'free') {
        return letter
          ? {
            title: "You've used your free cover letters",
            body: `Free cover letters are a one-time allowance, so they don’t refill. Pick a plan to write the cover letter ${forWho}, and to keep writing one for every employer you add.`,
            icon: 'diamond-outline', tint: E.purpleLite, outcome: 'plans',
          }
          : {
            title: "You've used your free resume generations",
            body: `Free generations are a one-time allowance, so they don’t refill. Pick a plan to build the resume ${forWho}, and to keep tailoring one to every employer you add.`,
            icon: 'diamond-outline', tint: E.purpleLite, outcome: 'plans',
          };
      }
      return letter
        ? {
          title: "You've used this month's cover letters",
          body: `Your plan’s cover letters for this month are used. A plan with more lets you write the cover letter ${forWho} now.`,
          icon: 'diamond-outline', tint: E.purpleLite, outcome: 'plans',
        }
        : {
          title: "You've used this month's resume generations",
          body: `Your plan’s resume generations for this month are used. A plan with more lets you build the resume ${forWho} now.`,
          icon: 'diamond-outline', tint: E.purpleLite, outcome: 'plans',
        };
    }
    case 'no_resume':
      return {
        title: 'Upload your resume first',
        body: letter
          ? `We write from your own experience, so we need your resume before we can write a cover letter ${forWho}.`
          : `We tailor from your own experience, so we need your resume before we can build one ${forWho}.`,
        icon: 'document-attach-outline', tint: E.mint, outcome: 'upload',
      };
    case 'network':
      return {
        title: 'We lost the connection',
        body: message || 'Check your connection and try again.',
        icon: 'cloud-offline-outline', tint: '#FCA5A5', outcome: 'retry',
      };
    case 'failed':
      return {
        title: letter ? "That cover letter didn't finish" : "That build didn't finish",
        body: message || 'Something went wrong on our side. Try again in a moment.',
        icon: 'alert-circle-outline', tint: '#FCA5A5', outcome: 'retry',
      };
    // ⚠️ THE AI PROVIDER, NOT THE BUILD AND NOT THE USER — and in both cases BEFORE the charge. The body is the
    // server's own sentence (it says nothing was charged and what to do); the title never blames anyone. A busy
    // provider is worth another try in a minute (Try again — through the gate and the sheet, like the first
    // build); one refusing our key is not, so that one is Close alone.
    case 'ai_busy':
      return {
        title: "Google's AI is busy",
        body: message || `Google’s AI is overloaded right now, so your ${noun} could not be ${letter ? 'written' : 'built'}. Nothing was charged — please try again in a minute.`,
        icon: 'time-outline', tint: '#C7D2FE', outcome: 'retry', calm: true,
      };
    case 'ai_down':
      return {
        title: 'Our AI provider is unavailable',
        body: message || 'Our AI provider is unavailable right now. Nothing was charged.',
        icon: 'cloud-offline-outline', tint: '#C7D2FE', outcome: 'down', calm: true,
      };
    case 'pending':
      // ⚠️ The job may still finish AND CHARGE. The only honest action is to let it; no rebuild.
      return {
        title: letter ? 'Still writing your cover letter' : 'Still building your resume',
        body: "It may arrive in a minute — we'll show it on Home",
        icon: 'hourglass-outline', tint: E.mint, outcome: 'wait',
      };
    case 'refresh':
      // Built and charged; only the pages on Home did not refresh. Success, with one step left.
      return {
        title: letter ? 'Your cover letter is written' : 'Your resume is built',
        body: message || 'Load your pages to see it.',
        icon: 'checkmark', tint: '#FFFFFF', outcome: 'built',
      };
    default:
      return {
        title: "We couldn't confirm your " + noun + ' yet',
        body: 'If it finished, it will show on Home.',
        icon: 'help-circle-outline', tint: '#C7D2FE', outcome: 'unknown',
      };
  }
}

/* ── the scene ──────────────────────────────────────────────────────────────────────────────── */

/** The backdrop under reduce motion (and before we know): MeshStage's colours, none of its drift. */
const STILL_BACKDROP = ['#070A18', '#111A44', '#1A2C5E'] as const;
/** Below this the page is a smudge; at that point the copy is the whole story and the stage steps aside. */
const MIN_PAGE_W = 64;

function Scene({ kind, company, stage, mode, error, buildKey, isPaid, dismiss, onRetry, onSeePlans }: {
  kind: DocKind;
  company: string;
  stage: BuildStage | null;
  mode: Mode;
  error: { reason: string; message: string } | null;
  /** See BuildingOverlay's prop. */
  isPaid?: boolean;
  /** The bound build's store key — see Progress. */
  buildKey?: string;
  dismiss: () => void;
  onRetry?: () => void;
  onSeePlans?: () => void;
}) {
  const words = wordsFor(kind);
  // Only meaningful while running: a 'checking' stage left behind on a done or error state says nothing.
  const checking = mode === 'run' && stage?.stage === 'checking';
  const insets = useSafeAreaInsets();
  const { width: winW, height: winH } = useWindowDimensions();
  const reduce = useReduceMotion();
  const known = reduce !== null;

  const enter = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    // Waits for the reduce-motion answer so the entrance can honour it (no slide under reduce motion).
    if (!known) return;
    const a = Animated.timing(enter, { toValue: 1, duration: 280, easing: Easing.out(Easing.cubic), useNativeDriver: true });
    a.start();
    return () => a.stop();
  }, [enter, known]);

  // ⚠️ SIZED FROM THE LIVE WINDOW, NEVER Dimensions AT MODULE LOAD (PaperCarousel's b202 lesson). The
  // window term keeps the page one steady size across states; the MEASURED stage term only bites when
  // big Dynamic Type leaves the stage less room than the window guessed. The old 132pt floor is gone
  // from that path on purpose: it held the page at full size and pushed the buttons off an SE.
  const [stageH, setStageH] = useState(0);
  const PADX = 40;
  const PADT = 40;
  const orb = 54;
  const pwWindow = Math.max(132, Math.min(196, winW * 0.48, (winH - 430) * 0.62));
  const pw = Math.round(stageH > 0 ? Math.min(pwWindow, (stageH - PADT - 16) / A4) : pwWindow);
  const ph = Math.round(pw * A4);
  const showStage = known && stageH > 0 && pw >= MIN_PAGE_W;

  const who = (company || '').trim();
  const fail = mode === 'error' && error ? errorCopy(error.reason, error.message, who, kind, isPaid) : null;
  const outcome = fail ? fail.outcome : null;
  const paperMode: PaperMode = mode === 'run' ? 'run' : mode === 'done' ? 'done' : outcome === 'built' ? 'built' : 'hold';
  const look: CoreLook = mode === 'run' ? 'run'
    : mode === 'done' || outcome === 'built' ? 'done'
      : outcome === 'wait' || outcome === 'unknown' || (fail && fail.calm) ? 'wait' : 'error';
  // Dimmed only for a real refusal or failure — never for a build that is still going or already built, nor
  // for an AI provider that was busy (calm): that page was never the user's to lose.
  const dim = !(fail && fail.calm) && (outcome === 'plans' || outcome === 'upload' || outcome === 'retry');
  const core: { icon: IconName; tint: string } = fail
    ? { icon: fail.icon, tint: fail.tint }
    : mode === 'done' ? { icon: 'sparkles', tint: '#FFFFFF' } : { icon: 'hardware-chip-outline', tint: '#FFFFFF' };

  return (
    <Animated.View style={[s.fill, { opacity: enter }]} accessibilityViewIsModal>
      {/* ⚠️ MeshStage's washes loop forever, so under reduce motion (and until we know) the backdrop is
          one still gradient in its colours. */}
      {reduce === false
        ? <MeshStage style={StyleSheet.absoluteFill} focus={1} rows={Math.ceil(winH / 30)} lift={0.5} />
        : <LinearGradient colors={STILL_BACKDROP} locations={[0.12, 0.6, 1]} start={{ x: 0.2, y: 0 }} end={{ x: 0.8, y: 1 }} style={StyleSheet.absoluteFill} />}
      {/* ⚠️ accessible={false}: a Pressable root is otherwise ONE accessibility element, and every
          button inside it would be unreachable to VoiceOver. It only does anything once done. */}
      <Pressable
        style={[s.fill, { paddingTop: insets.top + 14, paddingBottom: insets.bottom + 18 }]}
        onPress={mode === 'done' ? dismiss : undefined}
        accessible={false}
      >
        <View style={s.kickerRow}>
          <Ionicons name="sparkles" size={12} color={E.mint} />
          <Text style={s.kicker} maxFontSizeMultiplier={FONT_CAP.small}>{words.kicker}</Text>
        </View>

        <Animated.View
          style={[s.stageBox, {
            transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [reduce ? 0 : 14, 0] }) }],
          }]}
          onLayout={(e) => {
            const hgt = Math.round(e.nativeEvent.layout.height);
            setStageH((o) => (Math.abs(o - hgt) > 1 ? hgt : o));
          }}
        >
          {showStage && (
            <View style={{ width: pw + PADX * 2, height: ph + PADT + 16 }}>
              {mode === 'run' && reduce === false && SPARKS.map((sp, i) => (
                <Spark key={i} x={PADX + sp.x * pw} y={PADT + sp.y * ph} size={sp.size} color={sp.color} delay={sp.delay} />
              ))}
              {/* ⚠️ Shadow on the wrapper, clipping on the page inside — iOS clips a shadow drawn on a
                  view that also has overflow:hidden (PaperCarousel's note). */}
              <View style={[s.paperShadow, { left: PADX, top: PADT, width: pw, height: ph }, dim && s.dim]}>
                <Paper w={pw} h={ph} mode={paperMode} reduce={!!reduce} />
              </View>
              <View style={[s.abs, { left: PADX + pw - orb * 0.62, top: PADT - orb * 0.5, width: orb, height: orb }]}>
                {/* keyed so a change of state remounts it: the old loops die with it and the new
                    state gets its entrance */}
                <Core key={mode + (error?.reason || '')} look={look} size={orb} reduce={!!reduce} icon={core.icon} tint={core.tint} />
              </View>
            </View>
          )}
        </Animated.View>

        {/* ⚠️ COPY AND FOOTER SCROLL. flexGrow 0 sizes this to its content, flexShrink 1 lets it give way
            before the screen does — so at any text size the buttons are reachable, and the stage above
            shrinks (or steps aside) instead of shoving them off the bottom of an SE. */}
        <ScrollView style={s.lower} alwaysBounceVertical={false}>
          <View style={s.copy}>
            {mode === 'run' && (who
              ? <Title before={words.runBefore} company={who} after={words.runAfter} />
              : <Title before={words.runBare} company="" />)}
            {mode === 'done' && (who
              ? <Title before="Your" company={who} after={`${words.noun} is ready`} />
              : <Title before={`Your ${words.noun} is ready`} company="" />)}
            {/* ⚠️ ONE Progress FOR BOTH run AND done, AT ONE POSITION IN THE TREE. Rendered separately per
                state it remounted on completion: the digits reset to 0 and the bar re-grew from empty,
                where it should simply finish from wherever the run left it. */}
            {mode !== 'error' && known && (
              <Progress
                pct={mode === 'done' ? 100 : Number(stage?.pct) || 0}
                label={mode === 'done' ? 'Ready — opening it now' : stage?.label || 'Getting started'}
                mode={mode}
                checking={checking}
                buildKey={buildKey}
              />
            )}
            {!!fail && (
              <>
                <Text style={s.title} accessibilityRole="header" maxFontSizeMultiplier={FONT_CAP.title}>{fail.title}</Text>
                <Text style={s.body} maxFontSizeMultiplier={FONT_CAP.body}>{fail.body}</Text>
              </>
            )}
          </View>

          <View style={s.footer}>
            {/* ⚠️ CHECKING IS NOT BUILDING. The gate is still answering and no job exists, so the only
                honest exit is Close — "keep it building" would promise a build that was never started. */}
            {checking && (
              <>
                <Secondary label="Close" onPress={dismiss} />
                <Text style={s.note} maxFontSizeMultiplier={FONT_CAP.small}>Nothing has started yet.</Text>
              </>
            )}
            {mode === 'run' && !checking && (
              <>
                <TouchableOpacity
                  style={s.bgBtn} activeOpacity={0.8} onPress={dismiss} accessibilityRole="button"
                  accessibilityHint={words.keepHint}
                >
                  <Ionicons name="arrow-down-circle-outline" size={17} color="rgba(255,255,255,0.85)" />
                  <Text style={s.bgTx} numberOfLines={1} maxFontSizeMultiplier={FONT_CAP.button}>Keep it building in the background</Text>
                </TouchableOpacity>
                {/* The building card on Home is the way back in: tapping it reopens this overlay. */}
                <Text style={s.note} maxFontSizeMultiplier={FONT_CAP.small}>Watch it any time — tap its card on Home.</Text>
              </>
            )}
            {mode === 'done' && <Text style={s.note} maxFontSizeMultiplier={FONT_CAP.small}>Tap anywhere to see it</Text>}
            {outcome === 'plans' && (
              <>
                {!!onSeePlans && <Primary label="See plans" icon="diamond-outline" onPress={onSeePlans} />}
                <Secondary label="Not now" onPress={dismiss} />
              </>
            )}
            {outcome === 'upload' && <Secondary label="Got it" onPress={dismiss} />}
            {outcome === 'retry' && (
              <>
                {!!onRetry && <Primary label="Try again" icon="refresh" onPress={onRetry} />}
                <Secondary label="Close" onPress={dismiss} />
              </>
            )}
            {/* ⚠️ NO Try again: the job may still land and charge. Closing only hides it, as in `run`. */}
            {outcome === 'wait' && <Primary label="Keep it building" icon="arrow-down-circle-outline" onPress={dismiss} />}
            {/* onRetry here reloads the pages; Home never rebuilds (or charges) from this state. */}
            {outcome === 'built' && (
              <>
                {!!onRetry && <Primary label="Load my pages" icon="refresh" onPress={onRetry} />}
                <Secondary label="Close" onPress={dismiss} />
              </>
            )}
            {outcome === 'unknown' && <Secondary label="Close" onPress={dismiss} />}
            {/* ⚠️ NO Try again: the provider refused our key, and another tap would only fail the same way. */}
            {outcome === 'down' && <Secondary label="Close" onPress={dismiss} />}
          </View>
        </ScrollView>
      </Pressable>
    </Animated.View>
  );
}

export default function BuildingOverlay({
  visible, kind = 'resume', company, stage, done, error, buildKey, isPaid, onDismiss, onRetry, onSeePlans,
}: {
  visible: boolean;
  /** Which document is being made. Changes the words only; defaults to the resume lane. */
  kind?: DocKind;
  company: string;
  stage: BuildStage | null;
  done: boolean;
  error?: { reason: string; message: string } | null;
  /**
   * storeKeyOf(kind, rk) for the build being watched — the key the chip and the carousel already pass to
   * useCreepPct. ⚠️ Without it the percentage in here seeds at the stage ceiling and disagrees with the
   * chip the user just tapped; left out, the screen behaves exactly as it did before it existed.
   */
  buildKey?: string;
  /**
   * The account has a plan, so a used-up allowance is that plan's month rather than the one-time free one.
   * Only the WORDS of a quota refusal read it, and only when the server's own sentence did not already say
   * which allowance it was (allowanceOf). Left out, the free wording is the fallback.
   */
  isPaid?: boolean;
  onDismiss: () => void;
  onRetry?: () => void;
  onSeePlans?: () => void;
}) {
  const mode: Mode = error ? 'error' : done ? 'done' : 'run';

  // ⚠️ THE LATEST CALLBACKS LIVE IN A REF. Home re-renders on every job poll and hands down fresh
  // arrows each time; with onDismiss in the auto-dismiss effect's deps, each poll would restart the
  // 1.1s timer and a slow-polling parent could hold the finished page on screen indefinitely.
  const latest = useRef({ onDismiss, onRetry, onSeePlans });
  latest.current = { onDismiss, onRetry, onSeePlans };

  // ⚠️ ONE ACTION PER SHOWING — dismiss, Try again / Load my pages, and See plans all share it. The
  // auto-dismiss timer, a tap on the finished page and Android's back button can land within the same
  // second, and a double tap on See plans pushed TWO plans screens (Try again, two gate runs). The
  // caller hears about exactly one. Re-armed whenever the overlay is shown again or changes state —
  // including checking → building, which keeps mode 'run' but swaps Close for Keep building.
  const fired = useRef(false);
  const checkingNow = !error && !done && stage?.stage === 'checking';
  useEffect(() => { fired.current = false; }, [visible, mode, error?.reason, checkingNow]);
  const once = useCallback((pick: 'onDismiss' | 'onRetry' | 'onSeePlans') => {
    const fn = latest.current[pick];
    if (fired.current || !fn) return;
    fired.current = true;
    fn();
  }, []);
  const dismiss = useCallback(() => once('onDismiss'), [once]);
  const retry = useCallback(() => once('onRetry'), [once]);
  const seePlans = useCallback(() => once('onSeePlans'), [once]);

  useEffect(() => {
    if (!visible || mode !== 'done') return;
    const id = setTimeout(dismiss, DONE_HOLD_MS);
    return () => clearTimeout(id);
  }, [visible, mode, dismiss]);

  return (
    <Modal visible={visible} transparent animationType="none" statusBarTranslucent onRequestClose={dismiss}>
      {/* ⚠️ MOUNTED ONLY WHILE VISIBLE. Every loop in here stops in an effect cleanup, and unmounting
          is what runs those cleanups — so a hidden overlay has no loops, not merely invisible ones. */}
      {visible && (
        <Scene
          kind={kind} company={company} stage={stage} mode={mode} error={error || null} buildKey={buildKey} isPaid={isPaid}
          dismiss={dismiss} onRetry={onRetry ? retry : undefined} onSeePlans={onSeePlans ? seePlans : undefined}
        />
      )}
    </Modal>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  abs: { position: 'absolute' },
  center: { alignItems: 'center', justifyContent: 'center' },

  kickerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  kicker: { fontSize: 10.5, fontWeight: '800', letterSpacing: 1.6, color: 'rgba(255,255,255,0.5)' },

  // minHeight 0 and overflow hidden: the stage is what gives way to big text, and whatever it cannot
  // fit must never paint over the copy below it.
  stageBox: { flex: 1, minHeight: 0, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  lower: { flexGrow: 0, flexShrink: 1 },

  // ⚠️ Shadow here, overflow:hidden on `paper` — never both on one view (iOS clips the shadow).
  paperShadow: {
    position: 'absolute', borderRadius: 12, backgroundColor: '#fff',
    shadowColor: '#000', shadowOffset: { width: 0, height: 22 }, shadowOpacity: 0.5, shadowRadius: 36, elevation: 14,
  },
  paper: { borderRadius: 12, overflow: 'hidden', backgroundColor: '#fff' },
  dim: { opacity: 0.5 },
  avatar: { backgroundColor: 'rgba(255,255,255,0.92)' },
  flash: { backgroundColor: E.mint },
  beamEdge: { position: 'absolute', left: 0, right: 0, height: 1.5, backgroundColor: 'rgba(45,224,192,0.85)' },
  stampRing: {
    backgroundColor: '#fff', padding: 4,
    shadowColor: E.teal, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.45, shadowRadius: 18, elevation: 8,
  },
  stampFill: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  ring: { borderWidth: 1.5, borderColor: 'rgba(140,180,255,0.75)' },
  orbShadow: {
    shadowColor: E.blue, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.85, shadowRadius: 18, elevation: 10,
    backgroundColor: E.stage,
  },
  orbShadowDone: { shadowColor: E.teal },
  orb: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.28)',
  },
  orbError: { borderColor: 'rgba(255,255,255,0.16)' },
  orbBadge: {
    position: 'absolute', width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(6,11,30,0.92)', borderWidth: 1, borderColor: 'rgba(94,234,212,0.45)',
  },

  copy: { paddingHorizontal: 24, alignItems: 'center' },
  title: { fontSize: 23, fontWeight: '800', color: '#fff', letterSpacing: -0.6, textAlign: 'center', lineHeight: 29 },
  titleSerif: { fontFamily: SERIF, fontStyle: 'italic', fontWeight: '400', letterSpacing: -0.2 },
  body: { fontSize: 13.5, fontWeight: '600', color: 'rgba(255,255,255,0.6)', textAlign: 'center', marginTop: 10, lineHeight: 20 },

  progress: { alignSelf: 'stretch', marginTop: 18 },
  progressRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 12 },
  stageWrap: { flex: 1, minWidth: 0 },
  stage: { fontSize: 14.5, fontWeight: '700', color: 'rgba(255,255,255,0.86)' },
  stageDone: { color: E.mint },
  pct: { fontSize: 22, fontWeight: '300', color: '#fff', letterSpacing: -0.6, fontVariant: ['tabular-nums'] },
  pctSm: { fontSize: 13, fontWeight: '600', color: 'rgba(255,255,255,0.45)' },
  track: { height: 6, borderRadius: 6, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.1)', marginTop: 10 },

  // Fixed height across states so the page does not jump when the footer's contents change.
  footer: { minHeight: 120, paddingHorizontal: 24, paddingTop: 20, justifyContent: 'flex-start', gap: 10 },
  bgBtn: {
    minHeight: 48, paddingVertical: 8, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingHorizontal: 16, backgroundColor: E.glass, borderWidth: 1, borderColor: E.glassBorder,
  },
  bgTx: { fontSize: 14, fontWeight: '700', color: 'rgba(255,255,255,0.9)', flexShrink: 1 },
  note: { fontSize: 11.5, fontWeight: '600', color: 'rgba(255,255,255,0.42)', textAlign: 'center' },

  primaryWrap: {
    borderRadius: 16,
    shadowColor: '#2DE0C0', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.4, shadowRadius: 16, elevation: 8,
  },
  primary: { minHeight: 52, paddingVertical: 8, borderRadius: 16, overflow: 'hidden', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  primaryTx: { fontSize: 15.5, fontWeight: '800', color: MINT_INK, flexShrink: 1 },
  secondary: {
    minHeight: 48, paddingVertical: 8, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
    backgroundColor: E.glass, borderWidth: 1, borderColor: E.glassBorder,
  },
  secondaryTx: { fontSize: 14.5, fontWeight: '700', color: 'rgba(255,255,255,0.88)' },
});
