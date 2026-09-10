// AI Hub — new feature. Safe to delete without affecting existing app.
//
// THE PAGE BEFORE ITS PIXELS.
//
// The deck is 73 design slots and at most five of them have real pixels at any moment:
// /home-cards renders serially into a --single-process chromium that dies after about five
// setContent+screenshot cycles, so the cap is a CRASH constraint, not a tuning knob. Every other
// slot therefore has to live on what the catalogue already handed us — an id, a NAME and an
// ACCENT — and that turns out to be enough to draw a page that looks like THAT design instead of
// like a hole where a design should be. What was here before was `imgEmpty`: a flat #EEF2F8
// rectangle. That rectangle is what the user reported as "blank resume".
//
// ⚠️ DELIBERATE SIBLING OF `Letterpress` IN DownloadHistory.tsx. Same idea — accent band, name
// block, rule lines — at a different size and for a different reason: that one is a 50x70 chip
// standing in for a page that will NEVER exist (a cover letter has no thumbnail endpoint anywhere
// in this system), this one is a full A4 card standing in for a page that is about to arrive. The
// duplication is on purpose. DownloadHistory is a screen section, not a library, and reaching into
// a screen for one of its private components is how two screens lose the ability to change
// independently. If you change the ink here, decide about the chip there — don't assume.
//
// ⚠️ ANIMATION DRIVER RULE (the b126-128 fatal crash): PaperCarousel is a native-driver tree —
// scrollX, every card transform and Glare are all useNativeDriver:true. The sweep below copies
// Glare's pattern exactly: one Animated.Value, transform and opacity ONLY, useNativeDriver:true.
// A single JS-driven value anywhere in this tree takes the app down.
import React, { useEffect, useMemo, useRef } from 'react';
import { View, Text, StyleSheet, Animated, Easing } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

/**
 * The zoom affordance PaperCarousel paints over this page, expressed as a footprint the skeleton
 * has to stay out of. ⚠️ THE BUTTON IS STYLED THERE AND MEASURED HERE ON PURPOSE — `s.expand` in
 * PaperCarousel is built from these exact numbers, so the button and the clearance can never drift
 * apart again. They did drift, and the name chip spent the whole b2xx cycle running underneath it.
 */
export const AFFORDANCE = { size: 24, inset: 8, gap: 6 };
/** The right-hand strip the chip may not enter: 8 inset + 24 button + 6 breathing room = 38pt. */
export const AFFORDANCE_CLEAR = AFFORDANCE.inset + AFFORDANCE.size + AFFORDANCE.gap;

/**
 * What is actually happening to a slot with no pixels yet. Only the caller can know this — see the
 * note on the `state` prop.
 */
export type PaperState = 'loading' | 'queued' | 'idle';

/** Section headings, in % of page height. */
const HEADS = [26.5, 51, 74];
/** [top%, width% of the text column] — ragged on purpose: even line lengths read as a barcode. */
const RULES: Array<[number, number]> = [
  [32.0, 86], [36.4, 71], [40.8, 80], [45.2, 57],
  [56.5, 78], [60.9, 88], [65.3, 63],
  // ⚠️ The last row stops at 82%, not at 88%. The name tag sits at the foot of the page and the
  // smallest card in the deck is only ~240pt tall — at that size a lower final rule collides with
  // it, and a rule running under a chip reads as a rendering fault rather than as a page.
  [78.0, 74], [82.2, 84],
];

/**
 * Catalogue accents are 6-digit hex (server/utils/resumeTemplates.js TEMPLATES), but the recolour
 * variants are GENERATED, so the string is never trusted blindly — an unparsable accent falls back
 * to the same E.blue that `accentFor` uses, rather than throwing NaN into a colour string.
 */
function tint(hex: string, a: number): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec((hex || '').trim());
  if (!m) return `rgba(79,141,255,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/**
 * Glare's loop, at loading speed. ⚠️ It lives in its own component so that `shimmer={false}` does
 * not merely hide it — the hooks, and therefore the Animated.loop, never exist at all. Rendering
 * it hidden would leave 73 loops running behind an opacity of 0.
 */
function Sweep({ w, band, fade }: {
  w: number;
  band: number;
  fade: Animated.AnimatedInterpolation<number> | Animated.Value | number;
}) {
  const x = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const l = Animated.loop(Animated.sequence([
      Animated.timing(x, { toValue: 1, duration: 1150, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.delay(360),
    ]));
    l.start();
    return () => l.stop();
  }, [x]);
  return (
    <Animated.View
      pointerEvents="none"
      style={[s.sweep, {
        width: band,
        opacity: fade as any,
        transform: [
          { translateX: x.interpolate({ inputRange: [0, 1], outputRange: [-band, w + band] }) },
          { rotate: '12deg' },
        ],
      }]}
    >
      {/* ⚠️ WHITE, AND IT ONLY WORKS BECAUSE THE PAGE IS NOT WHITE. The skeleton's ground is
          #EDF1F8 precisely so a white sweep has something to brighten; drawn on the card's own
          #fff paper the same gradient is invisible and the page looks frozen, not loading. */}
      <LinearGradient
        colors={['transparent', 'rgba(255,255,255,0.95)', 'transparent']}
        start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }}
        style={StyleSheet.absoluteFill}
      />
    </Animated.View>
  );
}

export default function PaperSkeleton({ w, h, accent, name, detail, shimmer, fade, state = 'idle' }: {
  w: number;
  h: number;
  /** The design's own accent — the one thing we know about how it looks before it is rendered. */
  accent?: string;
  name?: string;
  /** Draw the body copy. Off for cards far enough out that only the head is readable anyway. */
  detail: boolean;
  /** Run the sweep at all — see the gating note in PaperCarousel's Card. */
  shimmer: boolean;
  /** Distance-from-centre opacity for the sweep, driven by the carousel's own `d`. */
  fade: Animated.AnimatedInterpolation<number> | Animated.Value | number;
  /**
   * ⚠️ TOLD, NEVER INFERRED. This used to be `!image` → ", loading", which was a lie across most of
   * the deck: the hydrator only ever asks for a window of cards around the one on screen, five at a
   * time, and any id the renderer fails to return is marked dead and never asked for again. So "no
   * image" overwhelmingly means "nothing is coming", and 73 cards sat there claiming to be busy.
   * The caller owns this because only the caller knows its own fetch window; the default is the
   * honest one — say nothing at all unless somebody says work is genuinely happening.
   */
  state?: PaperState;
}) {
  // Everything is derived from the MEASURED card box, never from Dimensions — same rule as the
  // carousel itself (b202 centred a pager from a module-load width and missed by a card).
  const g = useMemo(() => {
    const inset = Math.round(w * 0.085);
    const col = Math.max(10, w - inset * 2);
    const pt = (pct: number) => Math.round((h * pct) / 100);
    const wd = (pct: number) => Math.round((col * pct) / 100);
    return {
      inset,
      band: pt(8.5),
      hair: Math.max(2, Math.round(h * 0.009)),
      headH: Math.max(3, Math.round(h * 0.016)),
      nameH: Math.max(6, Math.round(h * 0.036)),
      subH: Math.max(4, Math.round(h * 0.020)),
      nameTop: pt(14.5), nameW: wd(52),
      subTop: pt(20.4), subW: wd(34),
      heads: HEADS.map((t) => ({ top: pt(t), width: wd(24) })),
      rules: RULES.map(([t, ww]) => ({ top: pt(t), width: wd(ww) })),
      tagBottom: pt(7),
      fs: Math.max(8.5, Math.min(11.5, w * 0.05)),
      sweep: Math.max(64, Math.round(w * 0.45)),
    };
  }, [w, h]);

  const label = (name || '').trim() || 'Your design';
  const headTint = tint(accent || '', 0.5);
  // 'idle' adds nothing: an unrendered slot that nobody is fetching is just this design, named.
  const note = state === 'loading' ? ', loading' : state === 'queued' ? ', queued' : '';

  return (
    <View style={[StyleSheet.absoluteFill, s.page]} pointerEvents="none">
      {/* The accent gets the head, because on a real page that is usually where it is — and it is
          the only thing that makes one waiting slot look unlike the next one. */}
      <View style={[s.band, { height: g.band, backgroundColor: accent || '#4F8DFF' }]} />
      <LinearGradient
        colors={[tint(accent || '', 0.16), 'transparent']}
        start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 1 }}
        style={[s.wash, { top: g.band, height: Math.round(g.band * 2.4) }]}
      />
      <View style={[s.name, { left: g.inset, top: g.nameTop, width: g.nameW, height: g.nameH }]} />
      <View style={[s.sub, { left: g.inset, top: g.subTop, width: g.subW, height: g.subH }]} />

      {detail && (
        <>
          {g.heads.map((r, i) => (
            <View key={`h${i}`} style={[s.head, { left: g.inset, top: r.top, width: r.width, height: g.headH, backgroundColor: headTint }]} />
          ))}
          {g.rules.map((r, i) => (
            <View key={`r${i}`} style={[s.rule, { left: g.inset, top: r.top, width: r.width, height: g.hair }]} />
          ))}
        </>
      )}

      {shimmer && <Sweep w={w} band={g.sweep} fade={fade} />}

      {/* ⚠️ AFTER the sweep, so the sweep passes UNDER it. The shimmer is decoration; this line is
          the only honest information on a page that has none yet, and washing it out to sell the
          animation would be the wrong trade. A named design that is loading is reassuring in a way
          an anonymous grey rectangle never is — the user knows which one they are waiting for.

          ⚠️ AND IT USED TO RUN STRAIGHT UNDER THE ZOOM BUTTON, which PaperCarousel draws AFTER the
          skeleton — so the button sat ON TOP of the last word of the name. The arithmetic, so the
          next person can check it rather than eyeball it:
            • the chip's bottom is h*0.07 → 17pt on the 240pt card, 25pt on the 356pt card, and the
              chip is ~20-25pt tall, so it lands inside the button's 8→32pt band on BOTH sizes;
            • raising it above 32pt is not available: the last rule row sits at 82.2% of h, i.e.
              ~43pt off the foot of the small card, and a rule crossing the chip reads as a fault.
          So the chip's CONTAINER stops AFFORDANCE_CLEAR (38pt) short of the right edge instead.
          Centred in a container of C = w-38 and capped at 86% of it, the chip's right edge is at
          most C/2 + 0.43C = 0.93C = 0.93w - 35.3, which clears the button's left edge (w-32) by
          0.07w + 3.3 pt — 15pt on the narrowest card (w=170), 21pt on the widest (w=252). It is a
          little left of the page's centre by design: the button balances it on the right. */}
      <View style={[s.tagWrap, { bottom: g.tagBottom }]}>
        <View style={s.tag}>
          <View style={[s.tagDot, { backgroundColor: accent || '#4F8DFF' }]} />
          <Text style={[s.tagTx, { fontSize: g.fs }]} numberOfLines={1} allowFontScaling={false}>
            {label}{!!note && <Text style={s.tagDim}>{note}</Text>}
          </Text>
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  // Not #fff: see the sweep's colour note. Slightly cool so it reads as paper in shade rather
  // than as a grey panel.
  page: { backgroundColor: '#EDF1F8' },
  band: { position: 'absolute', left: 0, right: 0, top: 0 },
  wash: { position: 'absolute', left: 0, right: 0 },
  name: { position: 'absolute', borderRadius: 3, backgroundColor: 'rgba(11,15,34,0.22)' },
  sub: { position: 'absolute', borderRadius: 2, backgroundColor: 'rgba(11,15,34,0.13)' },
  head: { position: 'absolute', borderRadius: 2 },
  rule: { position: 'absolute', borderRadius: 1.5, backgroundColor: 'rgba(11,15,34,0.10)' },
  sweep: { position: 'absolute', top: -30, bottom: -30 },
  // `right` is the collision fix: the chip is centred in what is left of the card once the zoom
  // button's footprint is taken out. See the arithmetic above the tag.
  tagWrap: { position: 'absolute', left: 0, right: AFFORDANCE_CLEAR, alignItems: 'center' },
  tag: {
    flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '86%',
    paddingVertical: 5, paddingHorizontal: 9, borderRadius: 100,
    backgroundColor: 'rgba(11,15,34,0.78)',
  },
  tagDot: { width: 5, height: 5, borderRadius: 3 },
  tagTx: { fontWeight: '800', color: '#fff', letterSpacing: -0.1, flexShrink: 1 },
  tagDim: { fontWeight: '600', color: 'rgba(255,255,255,0.62)' },
});
