// AI Hub — new feature. Safe to delete without affecting existing app.
//
// EVERYTHING YOU HAVE ALREADY PAID FOR, AND CAN HAVE AGAIN.
//
// This is what now fills the space under the hero. What used to be there re-showed the SAME resume
// page thumbnails the carousel above was already showing — `image={cards[i % cards.length]?.image}`
// under a company badge — so scrolling revealed the same designs a second time and told the user
// nothing new. This shows something only they know: what they bought.
//
// ⚠️ THE GLASS IS DRAWN FROM ITS EDGES, NOT FROM A BLUR. expo-blur is installed, and it is still
// the wrong tool here: BlurView over a scrolling parent samples imperfectly on Android and costs
// real frames, so the card would look like two different materials on two platforms. What actually
// makes something read as glass is not the blur — it is the LIT TOP FACE, the bright compressed
// edge where light refracts, the fall-off down the pane and the return light at the foot. All of
// those are linear gradients, which render identically everywhere. The stack below is that, in
// order, and the press animation slides the specular across the top edge: a static highlight is a
// picture of glass, a highlight that moves is glass.
//
// ⚠️ THE PADLOCK IS THE SERVER'S ANSWER, NEVER OURS. `unlocked` is computed server-side from the
// same subscription and the same passes canDownload consults the instant they tap, using the same
// fuzzy employer match. If this component decided free-ness for itself — "they own the employer, so
// it must be open" — it would draw an open padlock over a 403 the moment a plan lapsed. That is
// also why there is no `unlockedEmployers` set: a second source of truth for a money question is
// how the two answers start to disagree.
//
// ⚠️ NO NEW PICTURES ARE FETCHED HERE. Resume thumbnails are BORROWED from images Home already
// hydrated for the carousel, matched by template id. Rendering is serial server-side and
// single-process chromium dies after about five pages, which is why /home-cards is capped at five
// ids. A library row that requested its own render would stampede the front door of the app. A row
// with nothing loaded gets the letterpress page, which costs nothing and still reads as a document.
//
// ⚠️ A COVER LETTER HAS NO THUMBNAIL ANYWHERE IN THIS SYSTEM — the only letter preview endpoint
// demands the letter's HTML in the request body and renders per request with no disk cache. So in
// letter mode the drawn page is the NORMAL case, not a failure, and it draws itself as a letter:
// a right-aligned address block where a resume has its headline.
//
// ⚠️ ANIMATION DRIVER RULE (the b126-128 fatal crash): one driver per view tree. This section is a
// child of Home's outer Animated.ScrollView, whose onScroll already drives a native value — so
// every animation here is useNativeDriver:true on transform and opacity ONLY. Nothing animates
// width, height, margin, borderRadius or colour, and there is no JS-driven Animated.Value.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Pressable, TouchableOpacity, Animated, Easing, ActivityIndicator,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { E } from './theme';
import { gradFor, DownloadHistoryItem } from '../../services/employerHomeService';

/** 48 x 68 is the renderer's own A4 ratio (68 * 300/424 = 48.1). */
const CHIP_W = 48;
const CHIP_H = 68;
const ROW_H = 90;

/**
 * Home is a hero surface, not a list screen — but three was too mean. Someone with five downloads
 * was shown three and a "See all 5", and the locked strip underneath then counted a row they could
 * not see. Six covers almost everyone in one glance and still stops the front door becoming a feed.
 */
const PREVIEW_ROWS = 6;
const MAX_ROWS = 20;

/** Every colour in the employer palette is 6-digit hex. */
const rgba = (hex: string, a: number) =>
  `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;

/** TODAY / YESTERDAY / 4 DAYS AGO / 12 AUG / 12 AUG 2025. Never an ISO string, never a clock time. */
function stamp(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const now = Date.now();
  const h = (now - t) / 3600000;
  if (h < 24) return 'TODAY';
  if (h < 48) return 'YESTERDAY';
  const days = Math.floor(h / 24);
  if (days < 7) return `${days} DAYS AGO`;
  const m = d.toLocaleDateString('en-GB', { month: 'short' }).toUpperCase();
  const sameYear = new Date(now).getFullYear() === d.getFullYear();
  return sameYear ? `${d.getDate()} ${m}` : `${d.getDate()} ${m} ${d.getFullYear()}`;
}

/* ── the material ───────────────────────────────────────────────────────────────────────────── */

/**
 * The lit faces of a pane, bottom to top. `rim` slides on press; everything else is static.
 *
 * The order is the whole point and must not be shuffled: the wash is what is BEHIND the glass, the
 * refraction band is where that compresses and goes bright at the thick edge, the sheen is the
 * light across the face, and the rim / falloff / shade / return-light are the four surfaces of the
 * pane itself, top to bottom.
 */
function Facets({
  pair, dim, rim, sheenOpacity,
}: {
  pair: [string, string];
  dim: boolean;
  rim: Animated.AnimatedInterpolation<number> | Animated.Value;
  sheenOpacity: Animated.AnimatedInterpolation<number> | Animated.Value;
}) {
  // The amber/red pair drifts warm enough under white to read as a warning state at full strength.
  const warm = pair[0] === '#F59E0B';
  const a0 = dim ? 0.13 : (warm ? 0.15 : 0.22);
  const a1 = dim ? 0.04 : 0.06;
  return (
    <>
      <View style={s.wash} pointerEvents="none">
        <LinearGradient
          colors={[rgba(pair[0], a0), rgba(pair[1], a1), 'transparent']}
          locations={[0, 0.55, 1]}
          start={{ x: 0, y: 0.15 }}
          end={{ x: 1, y: 0.85 }}
          style={StyleSheet.absoluteFill}
        />
      </View>
      <View style={s.refract} pointerEvents="none">
        <LinearGradient
          colors={['rgba(255,255,255,0.58)', 'rgba(255,255,255,0)']}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={StyleSheet.absoluteFill}
        />
      </View>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: sheenOpacity }]} pointerEvents="none">
        <LinearGradient
          colors={['rgba(255,255,255,0.50)', 'rgba(255,255,255,0.06)', 'transparent']}
          locations={[0, 0.40, 1]}
          start={{ x: 0.10, y: 0 }}
          end={{ x: 0.72, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
      {/* The specular. 1.5pt, not a hairline: a hairline reads as a border, this reads as a lit
          face. Oversized so its own ends can never enter the clip when it slides. */}
      <Animated.View style={[s.rim, { transform: [{ translateX: rim }] }]} pointerEvents="none">
        <LinearGradient
          colors={['rgba(255,255,255,0.30)', 'rgba(255,255,255,1)', 'rgba(255,255,255,0.50)']}
          locations={[0, 0.32, 1]}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
      <View style={s.falloff} pointerEvents="none">
        <LinearGradient colors={['rgba(255,255,255,0.40)', 'transparent']} start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 1 }} style={StyleSheet.absoluteFill} />
      </View>
      <View style={s.shade} pointerEvents="none">
        <LinearGradient colors={['rgba(11,15,34,0)', 'rgba(11,15,34,0.06)']} start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 1 }} style={StyleSheet.absoluteFill} />
      </View>
      {/* Dark, then bright, in two points. That reversal at the foot is what reads as an object
          made of a material rather than a rectangle with a gradient in it. */}
      <View style={s.returnLight} pointerEvents="none" />
    </>
  );
}

/* ── the page ───────────────────────────────────────────────────────────────────────────────── */

const RESUME_RULES = [
  { top: 21, w: '86%' }, { top: 27, w: '72%' }, { top: 33, w: '80%' },
  { top: 41, w: '64%' }, { top: 47, w: '84%' }, { top: 53, w: '48%' },
];
const LETTER_RULES = [
  { top: 33, w: '80%' }, { top: 41, w: '64%' }, { top: 47, w: '84%' }, { top: 53, w: '48%' },
];

/** Drawn in RN, costing nothing. The accent is what makes one design look unlike another. */
function Letterpress({ accent, letter }: { accent: string; letter: boolean }) {
  return (
    <>
      <View style={[s.pAccent, { backgroundColor: accent }]} />
      {letter ? (
        // A letter is not a resume and must not draw like one: the head of a letter is the
        // recipient's address, set to the right.
        <View style={s.pAddr}>
          {['44%', '38%', '30%'].map((w, i) => <View key={i} style={[s.pRule, { width: w as any, alignSelf: 'flex-end', marginTop: i ? 4 : 0 }]} />)}
        </View>
      ) : (
        <View style={s.pName} />
      )}
      {(letter ? LETTER_RULES : RESUME_RULES).map((r, i) => (
        <View key={i} style={[s.pRule, s.pRuleAbs, { top: r.top, width: r.w as any }]} />
      ))}
    </>
  );
}

/* ── one row ────────────────────────────────────────────────────────────────────────────────── */

function Row({
  item, image, accent, index, busy, onAgain, onPay,
}: {
  item: DownloadHistoryItem;
  image?: string | null;
  accent: string;
  index: number;
  busy: boolean;
  onAgain: (it: DownloadHistoryItem) => void;
  onPay: (employer: string | null) => void;
}) {
  const a = useRef(new Animated.Value(0)).current;
  const p = useRef(new Animated.Value(0)).current;
  const [justDone, setJustDone] = useState(false);
  const wasBusy = useRef(false);

  useEffect(() => {
    // Capped at index 3 so an expanded twelve-row list never cascades for two seconds.
    Animated.timing(a, {
      toValue: 1, duration: 300, delay: Math.min(index, 3) * 70,
      easing: Easing.out(Easing.cubic), useNativeDriver: true,
    }).start();
  }, [a, index]);

  useEffect(() => {
    if (wasBusy.current && !busy) {
      setJustDone(true);
      const t = setTimeout(() => setJustDone(false), 1500);
      return () => clearTimeout(t);
    }
    wasBusy.current = busy;
    return undefined;
  }, [busy]);

  const spring = (to: number) =>
    Animated.spring(p, { toValue: to, damping: 18, stiffness: 320, mass: 0.8, useNativeDriver: true }).start();

  const free = item.unlocked;
  const pair = gradFor(item.employer || item.templateName);
  const shims = Math.min(2, Math.max(0, (item.times || 1) - 1));

  const tap = useCallback(() => {
    if (busy) return;
    try {
      if (free) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      else Haptics.selectionAsync();
    } catch {}
    if (free) onAgain(item); else onPay(item.employer || null);
  }, [busy, free, item, onAgain, onPay]);

  return (
    <Animated.View
      style={{
        opacity: a,
        transform: [{ translateY: a.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }],
      }}
    >
      <Pressable
        onPress={tap}
        onPressIn={() => spring(1)}
        onPressOut={() => spring(0)}
        accessibilityRole="button"
        accessibilityLabel={
          busy ? 'Getting your file'
            : justDone ? 'Saved'
            : free ? `Download ${item.templateName} for ${item.employer || 'this employer'} again`
            : `${item.templateName} for ${item.employer || 'this employer'} is locked because your plan ended`
        }
      >
        <Animated.View
          style={[s.shell, { transform: [{ scale: p.interpolate({ inputRange: [0, 1], outputRange: [1, 0.982] }) }] }]}
        >
          <View style={s.clip}>
            <Facets
              pair={pair}
              dim={!free}
              rim={p.interpolate({ inputRange: [0, 1], outputRange: [0, -28] })}
              sheenOpacity={p.interpolate({ inputRange: [0, 1], outputRange: [1, 0.60] })}
            />

            <View style={s.content}>
              {/* ── the paper ── */}
              <View style={s.chipWrap}>
                {/* Honest data, never decoration: `times` is a real count, because a download is
                    upserted on document identity rather than appended per tap. */}
                {shims >= 2 && <View style={[s.shim, s.shim2]} />}
                {shims >= 1 && <View style={[s.shim, s.shim1]} />}
                <View style={s.chipLift}>
                  <View style={s.chipClip}>
                    {image ? (
                      <ExpoImage
                        source={{ uri: image }}
                        style={s.chipImg}
                        contentFit="cover"
                        contentPosition="top"
                        transition={200}
                      />
                    ) : (
                      <Letterpress accent={accent} letter={item.kind === 'cover_letter'} />
                    )}
                    <View style={[s.stamp, item.format === 'docx' ? s.stampDoc : s.stampPdf]}>
                      <Text style={s.stampTx} allowFontScaling={false}>{item.format === 'docx' ? 'WORD' : 'PDF'}</Text>
                    </View>
                  </View>
                  <LinearGradient colors={pair} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.badge}>
                    <Text style={s.badgeTx} allowFontScaling={false}>
                      {(item.employer || '?').trim().charAt(0).toUpperCase()}
                    </Text>
                  </LinearGradient>
                </View>
              </View>

              {/* ── who, what, when ── */}
              <View style={s.mid}>
                <Text style={s.who} numberOfLines={1} allowFontScaling={false}>
                  {item.employer || 'No employer'}
                </Text>
                <View style={s.l2}>
                  <Text style={s.what} numberOfLines={1} allowFontScaling={false}>
                    {item.templateName || 'Your design'}
                  </Text>
                  {/* ⚠️ The separator only exists to separate. Rendering it unconditionally left a
                      dot hanging off the end of every ordinary row — "Modern Minimal ·" — which
                      reads as a line that got cut off. */}
                  {(!free || item.times > 1) && <View style={s.capDot} />}
                  {!free ? (
                    <View style={s.planPill}>
                      <Text style={s.planPillTx} allowFontScaling={false}>PLAN ENDED</Text>
                    </View>
                  ) : item.times > 1 ? (
                    <Text style={s.times} allowFontScaling={false}>{item.times} times</Text>
                  ) : null}
                </View>
                <Text style={s.when} numberOfLines={1} allowFontScaling={false}>{stamp(item.downloadedAt)}</Text>
              </View>

              {/* ── the action, same geometry in every state so nothing shifts ── */}
              <View style={[s.act, free ? s.actFree : s.actLocked]}>
                {busy ? <ActivityIndicator size="small" color={E.blueDeep} />
                  : justDone ? <Ionicons name="checkmark" size={17} color={E.emerald} />
                  : free ? <Ionicons name="arrow-down" size={17} color={E.blueDeep} />
                  : <Ionicons name="lock-closed" size={14} color={E.textFaint} />}
              </View>
            </View>

            {/* Above the content so nothing crosses it. RN cannot colour a border per side, so one
                even rim plus the directional gradients above is the closest honest approximation. */}
            <View style={s.innerRim} pointerEvents="none" />
          </View>
        </Animated.View>
      </Pressable>
    </Animated.View>
  );
}

/* ── loading ────────────────────────────────────────────────────────────────────────────────── */

function SkeletonRow({ index }: { index: number }) {
  const g = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.delay(index * 300),
      Animated.timing(g, { toValue: 1, duration: 1100, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(g, { toValue: 0, duration: 0, useNativeDriver: true }),
      Animated.delay(500),
    ]));
    loop.start();
    return () => loop.stop();
  }, [g, index]);
  const still = useRef(new Animated.Value(0)).current;
  return (
    <View style={s.shell}>
      <View style={s.clip}>
        {/* The material is not what we are waiting for, so it is already here — nothing reflows
            when the data lands. */}
        <Facets pair={[E.blue, E.purple]} dim rim={still} sheenOpacity={1 as any} />
        <View style={s.content}>
          <View style={s.skPaper} />
          <View style={s.mid}>
            <View style={[s.skBar, { width: 112, height: 10, borderRadius: 5 }]} />
            <View style={[s.skBar, { width: 74, height: 8, borderRadius: 4, marginTop: 6 }]} />
            <View style={[s.skBar, { width: 52, height: 7, borderRadius: 3.5, marginTop: 5 }]} />
          </View>
          <View style={s.skAct} />
        </View>
        <Animated.View
          style={[s.glare, { transform: [{ translateX: g.interpolate({ inputRange: [0, 1], outputRange: [-220, 420] }) }] }]}
          pointerEvents="none"
        >
          <LinearGradient
            colors={['transparent', 'rgba(255,255,255,0.55)', 'transparent']}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
        <View style={s.innerRim} pointerEvents="none" />
      </View>
    </View>
  );
}

/* ── empty ──────────────────────────────────────────────────────────────────────────────────── */

const FAN = [
  { rot: '-9deg', tx: -6, ty: 5 },
  { rot: '0deg', tx: 0, ty: 0 },
  { rot: '9deg', tx: 6, ty: 5 },
];

function EmptyState({ mode, onScrollToTop }: { mode: 'resume' | 'letter'; onScrollToTop: () => void }) {
  const f = useRef(FAN.map(() => new Animated.Value(0))).current;
  useEffect(() => {
    // rotate and translate are both transforms, so the fan-out is native-driver legal — and the
    // fan-out IS the animation. Nothing else on this card moves.
    Animated.stagger(70, f.map((v) =>
      Animated.spring(v, { toValue: 1, damping: 15, stiffness: 160, mass: 1, useNativeDriver: true }))).start();
  }, [f]);
  const still = useRef(new Animated.Value(0)).current;

  return (
    <View style={[s.shell, s.emptyShell]}>
      <View style={s.clip}>
        <View style={s.wash} pointerEvents="none">
          <LinearGradient
            colors={['rgba(79,141,255,0.16)', 'rgba(124,107,255,0.05)', 'transparent']}
            locations={[0, 0.55, 1]}
            start={{ x: 0, y: 0.15 }} end={{ x: 1, y: 0.85 }}
            style={StyleSheet.absoluteFill}
          />
        </View>
        <Facets pair={[E.blue, E.purple]} dim rim={still} sheenOpacity={1 as any} />
        <View style={s.emptyBody}>
          <View style={s.fanRow}>
            {FAN.map((cfg, i) => (
              <Animated.View
                key={i}
                style={[
                  s.blank,
                  {
                    transform: [
                      { rotate: f[i].interpolate({ inputRange: [0, 1], outputRange: ['0deg', cfg.rot] }) },
                      { translateX: f[i].interpolate({ inputRange: [0, 1], outputRange: [0, cfg.tx] }) },
                      { translateY: f[i].interpolate({ inputRange: [0, 1], outputRange: [0, cfg.ty] }) },
                    ],
                  },
                ]}
              >
                {[{ t: 14, w: '76%' }, { t: 20, w: '86%' }, { t: 26, w: '64%' }, { t: 34, w: '42%' }].map((r, j) => (
                  <View key={j} style={[s.pRule, s.pRuleAbs, { top: r.t, width: r.w as any, backgroundColor: 'rgba(11,15,34,0.06)' }]} />
                ))}
              </Animated.View>
            ))}
          </View>
          <Text style={s.emptyH}>Nothing downloaded yet</Text>
          <Text style={s.emptyTx}>
            {mode === 'letter'
              ? 'Every cover letter you download lands here, ready to send again.'
              : 'Every resume you download lands here, so you can get the same file again without paying twice.'}
          </Text>
          {/* Not a gradient CTA and not a navigation: the designs are on this same screen, straight
              up. Sending someone somewhere else for something already here would be a small lie. */}
          <TouchableOpacity style={s.emptyLink} activeOpacity={0.85} onPress={onScrollToTop}>
            <Ionicons name="arrow-up" size={13} color={E.blueDeep} />
            <Text style={s.emptyLinkTx}>Pick a design above</Text>
          </TouchableOpacity>
        </View>
        <View style={s.innerRim} pointerEvents="none" />
      </View>
    </View>
  );
}

/* ── the section ────────────────────────────────────────────────────────────────────────────── */

export default function DownloadHistory({
  mode, items, loading, expanded, busyId, thumbFor, accentFor, onAgain, onPay, onExpand,
  onScrollToTop, onMoreJobs,
}: {
  mode: 'resume' | 'letter';
  items: DownloadHistoryItem[];
  loading: boolean;
  expanded: boolean;
  /** The row currently being produced, so only that one shows a spinner. */
  busyId: number | null;
  /** An already-loaded page image for this design, or nothing. NEVER triggers a fetch. */
  thumbFor: (templateId: string) => string | null | undefined;
  /** The design's accent from the catalogue Home already loaded. */
  accentFor: (templateId: string) => string;
  onAgain: (it: DownloadHistoryItem) => void;
  onPay: (employer: string | null) => void;
  onExpand: () => void;
  onScrollToTop: () => void;
  /** The one affordance the section this replaced had, and the only route to the jobs tab from
   *  Home in resume mode. Losing it would quietly lose the targets entry point. */
  onMoreJobs: () => void;
}) {
  const shown = expanded ? items.slice(0, MAX_ROWS) : items.slice(0, PREVIEW_ROWS);
  // ⚠️ Counted over the rows ACTUALLY ON SCREEN. Counting the whole list made the strip announce
  // a locked file that was hidden behind "See all", which reads as a bug in the count.
  const lockedCount = shown.filter((i) => !i.unlocked).length;

  /**
   * The list fades in on a mode change; the header and the title never move.
   *
   * ⚠️ THE ROWS ARE RENDERED STRAIGHT FROM PROPS AND ARE NEVER HELD BEHIND AN ANIMATION CALLBACK.
   * The first version swapped them inside the completion handler of a fade-OUT, which deadlocked:
   * flipping the mode also refetches, so `items` changes a moment after `mode` does, the effect ran
   * a second time, the second Animated.timing cancelled the first — and a cancelled animation still
   * calls its callback, so the fade-in fired while the newer fade-out was driving the value back
   * down. The list settled at opacity 0 and the whole section went blank on the app's front door.
   * Snapping to 0 and animating up has no callback, cannot race, and reads the same: the old rows
   * are gone the instant the mode changes, which is what the user asked for anyway.
   */
  const m = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    m.setValue(0);
    Animated.timing(m, { toValue: 1, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [m, mode]);

  // A fast answer should still read as a load rather than as a flicker.
  const [floor, setFloor] = useState(true);
  useEffect(() => { const t = setTimeout(() => setFloor(false), 350); return () => clearTimeout(t); }, [mode]);
  const showSkeletons = (loading || floor) && !items.length;

  const title = useMemo(
    () => (mode === 'letter' ? 'Letters you have saved' : 'Yours to download again'),
    [mode],
  );

  return (
    <View style={s.wrap}>
      <View style={s.head}>
        <View style={{ flex: 1 }}>
          <Text style={s.eyebrow}>Downloaded</Text>
          <Text style={s.title} numberOfLines={1}>{title}</Text>
        </View>
        <TouchableOpacity style={s.seeAll} activeOpacity={0.8} onPress={onMoreJobs}>
          <Text style={s.seeAllTx}>More jobs </Text>
          <Ionicons name="arrow-forward" size={12} color={E.blueDeep} />
        </TouchableOpacity>
      </View>

      {showSkeletons ? (
        <View style={s.list}>{[0, 1, 2].map((i) => <SkeletonRow key={i} index={i} />)}</View>
      ) : !items.length ? (
        <EmptyState mode={mode} onScrollToTop={onScrollToTop} />
      ) : (
        <Animated.View
          style={{
            // Opaque a quarter of the way in rather than ghosting the whole distance.
            opacity: m.interpolate({ inputRange: [0, 0.25, 1], outputRange: [0, 1, 1] }),
            transform: [{ translateY: m.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }],
          }}
        >
          <View style={s.list}>
            {shown.map((it, i) => (
              <Row
                key={`${mode}-${it.id}`}
                item={it}
                index={i}
                image={mode === 'letter' ? null : thumbFor(it.templateId)}
                accent={accentFor(it.templateId)}
                busy={busyId === it.id}
                onAgain={onAgain}
                onPay={onPay}
              />
            ))}
          </View>

          {items.length > PREVIEW_ROWS && !expanded && (
            <TouchableOpacity style={s.expand} activeOpacity={0.85} onPress={onExpand}>
              <Text style={s.expandTx}>See all {items.length}</Text>
              <Ionicons name="chevron-down" size={14} color={E.blueDeep} />
            </TouchableOpacity>
          )}

          {lockedCount > 0 && (
            // ⚠️ LOAD-BEARING COPY. It says what happened and what fixes it, and it must never
            // imply they are being charged twice for the same thing — they are not; a pass buys the
            // employer and everything for that employer comes back. No date is named because the
            // endpoint returns none, and an invented one would be a lie.
            <View style={s.lockedStrip}>
              <Ionicons name="information-circle" size={15} color={E.purple} style={{ marginTop: 1 }} />
              <Text style={s.lockedTx}>
                {lockedCount === 1 ? '1 file is' : `${lockedCount} files are`} locked because your plan
                ended. Nothing was deleted — your designs and your details are exactly as you left
                them. One payment for a company, or a plan, brings them back.
              </Text>
            </View>
          )}

          {mode === 'resume' && (
            <Text style={s.footnote}>Re-downloads use your latest resume in that design.</Text>
          )}
        </Animated.View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  // ⚠️ 14, NOT 26. The hero above now ends where its content ends and melts across the last
  // 118pt, so this section starts immediately after that ramp. A second 26pt of air on top
  // of it re-opened the same gap the melt was shortened to close.
  wrap: { paddingHorizontal: 16, paddingTop: 14 },

  head: { flexDirection: 'row', alignItems: 'flex-end', gap: 10, marginBottom: 12 },
  // The same values the section this replaced used, so it reads as its sibling.
  eyebrow: { fontSize: 10, fontWeight: '700', letterSpacing: 1.8, textTransform: 'uppercase', color: E.textFaint },
  title: { fontSize: 19, fontWeight: '800', color: E.ink, letterSpacing: -0.7, marginTop: 3, flexShrink: 1 },
  seeAll: { flexDirection: 'row', alignItems: 'center', paddingBottom: 3 },
  seeAllTx: { fontSize: 12.5, fontWeight: '700', color: E.blueDeep, flexShrink: 1 },

  list: { gap: 10 },

  // ⚠️ Shadow and clipping never share a view: iOS drops a shadow drawn on an overflow:'hidden'
  // view. The white is opaque because iOS derives the shadow from the alpha channel — a transparent
  // card casts nothing — and because the row must still be a card if every gradient fails to draw.
  shell: {
    height: ROW_H, borderRadius: 20, backgroundColor: '#FFFFFF',
    borderWidth: StyleSheet.hairlineWidth, borderColor: E.border,
    shadowColor: '#0B0F22', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.07, shadowRadius: 20,
    elevation: 3,
  },
  // 19 and not 20: absolute children position against the padding box, so matching radii leave a
  // sub-pixel seam of shell colour at each corner.
  clip: { ...StyleSheet.absoluteFillObject, borderRadius: 19, overflow: 'hidden' },
  content: { flex: 1, padding: 11, flexDirection: 'row', alignItems: 'center', gap: 12 },

  wash: { position: 'absolute', left: 0, top: 0, bottom: 0, width: '42%' },
  refract: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 26 },
  rim: { position: 'absolute', top: 0, left: '-20%', width: '140%', height: 1.5 },
  falloff: { position: 'absolute', top: 1.5, left: 0, right: 0, height: 16 },
  shade: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 22 },
  returnLight: { position: 'absolute', bottom: 0, left: 10, right: 10, height: 1, backgroundColor: 'rgba(255,255,255,0.60)' },
  innerRim: { ...StyleSheet.absoluteFillObject, borderRadius: 19, borderWidth: 1, borderColor: 'rgba(255,255,255,0.62)' },

  chipWrap: { width: CHIP_W, height: CHIP_H },
  shim: {
    position: 'absolute', width: CHIP_W, height: CHIP_H, borderRadius: 6, backgroundColor: '#FFFFFF',
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(11,15,34,0.10)',
  },
  shim1: { opacity: 0.62, transform: [{ rotate: '-4deg' }, { translateX: -3 }] },
  shim2: { opacity: 0.40, transform: [{ rotate: '-7.5deg' }, { translateX: -5.5 }, { translateY: 2 }] },
  chipLift: {
    width: CHIP_W, height: CHIP_H, borderRadius: 6, backgroundColor: '#fff',
    shadowColor: '#0B0F22', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.16, shadowRadius: 7, elevation: 3,
  },
  chipClip: { width: CHIP_W, height: CHIP_H, borderRadius: 6, overflow: 'hidden', backgroundColor: '#fff' },
  chipImg: { width: '100%', height: '100%' },

  pAccent: { position: 'absolute', left: 0, right: 0, top: 0, height: 4 },
  pName: { position: 'absolute', left: 6, top: 11, width: '58%', height: 4, borderRadius: 2, backgroundColor: 'rgba(11,15,34,0.22)' },
  pAddr: { position: 'absolute', left: 6, right: 6, top: 11 },
  pRule: { height: 2, borderRadius: 1, backgroundColor: 'rgba(11,15,34,0.075)' },
  pRuleAbs: { position: 'absolute', left: 6, right: 6 },

  stamp: { position: 'absolute', right: 3, bottom: 3, height: 13, paddingHorizontal: 4, borderRadius: 4, alignItems: 'center', justifyContent: 'center' },
  stampPdf: { backgroundColor: 'rgba(11,15,34,0.72)' },
  stampDoc: { backgroundColor: 'rgba(37,99,235,0.90)' },
  stampTx: { fontSize: 7.5, fontWeight: '800', letterSpacing: 0.6, color: '#fff' },

  // A sibling of the clip so it can bleed outside it — the same badge the hero uses, at 82%.
  badge: {
    position: 'absolute', left: -5, bottom: -5, width: 18, height: 18, borderRadius: 6,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: '#fff',
  },
  badgeTx: { fontSize: 9, fontWeight: '800', color: '#fff' },

  mid: { flex: 1, minWidth: 0 },
  // Never dimmed on a locked row: greying the name is what makes people believe their work is gone.
  who: { fontSize: 14, fontWeight: '800', color: E.ink, letterSpacing: -0.3, flexShrink: 1 },
  l2: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 },
  what: { fontSize: 11.5, fontWeight: '600', color: E.textMuted, flexShrink: 1 },
  capDot: { width: 3, height: 3, borderRadius: 2, backgroundColor: 'rgba(11,15,34,0.20)' },
  times: { fontSize: 11, fontWeight: '600', color: E.textFaint, flexShrink: 1 },
  // Amber, never red: red says you did something wrong, amber says paused.
  planPill: {
    height: 16, paddingHorizontal: 6, borderRadius: 5, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(245,158,11,0.12)', borderWidth: 1, borderColor: 'rgba(245,158,11,0.28)',
  },
  planPillTx: { fontSize: 8.5, fontWeight: '800', letterSpacing: 0.4, color: '#B45309' },
  // The hero's caption metric, recoloured. The type scale crossing the dark/light boundary is the
  // clearest tell that the two halves of this screen are one design.
  when: { fontSize: 10, fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase', color: E.textFaint, marginTop: 5, flexShrink: 1 },

  act: { width: 34, height: 34, borderRadius: 11, alignItems: 'center', justifyContent: 'center', flexShrink: 0, borderWidth: 1 },
  actFree: { backgroundColor: 'rgba(37,99,235,0.10)', borderColor: 'rgba(37,99,235,0.20)' },
  actLocked: { backgroundColor: 'rgba(11,15,34,0.05)', borderColor: 'rgba(11,15,34,0.07)' },

  skPaper: { width: CHIP_W, height: CHIP_H, borderRadius: 6, backgroundColor: 'rgba(11,15,34,0.055)' },
  skBar: { backgroundColor: 'rgba(11,15,34,0.055)' },
  skAct: { width: 34, height: 34, borderRadius: 11, backgroundColor: 'rgba(11,15,34,0.04)' },
  glare: { position: 'absolute', top: 0, bottom: 0, width: 160 },

  emptyShell: { height: 150 },
  emptyBody: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 22 },
  fanRow: { flexDirection: 'row', alignItems: 'center' },
  blank: {
    width: CHIP_W, height: CHIP_H, borderRadius: 6, backgroundColor: '#FFFFFF',
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(11,15,34,0.10)', marginHorizontal: -12,
  },
  emptyH: { marginTop: 13, fontSize: 15, fontWeight: '800', color: E.ink, letterSpacing: -0.3, flexShrink: 1 },
  emptyTx: { marginTop: 5, fontSize: 12.5, fontWeight: '600', color: E.textMuted, textAlign: 'center', lineHeight: 18, maxWidth: 262, flexShrink: 1 },
  emptyLink: {
    marginTop: 12, height: 34, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14,
    borderRadius: 11, backgroundColor: 'rgba(37,99,235,0.10)', borderWidth: 1, borderColor: 'rgba(37,99,235,0.20)',
  },
  emptyLinkTx: { fontSize: 12.5, fontWeight: '700', color: E.blueDeep, flexShrink: 1 },

  expand: {
    marginTop: 10, height: 42, borderRadius: 14, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'center', gap: 5,
    backgroundColor: 'rgba(37,99,235,0.07)', borderWidth: 1, borderColor: 'rgba(37,99,235,0.16)',
  },
  expandTx: { fontSize: 13, fontWeight: '700', color: E.blueDeep, flexShrink: 1 },

  lockedStrip: {
    marginTop: 10, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 14,
    backgroundColor: 'rgba(124,107,255,0.07)', borderWidth: 1, borderColor: 'rgba(124,107,255,0.18)',
    flexDirection: 'row', alignItems: 'flex-start', gap: 9,
  },
  lockedTx: { flex: 1, fontSize: 11.5, fontWeight: '600', color: E.textMuted, lineHeight: 16 },

  footnote: { fontSize: 11, fontWeight: '600', color: E.textFaint, textAlign: 'center', marginTop: 8, flexShrink: 1 },
});
