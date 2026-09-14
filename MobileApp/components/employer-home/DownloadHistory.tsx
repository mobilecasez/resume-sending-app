// AI Hub — new feature. Safe to delete without affecting existing app.
//
// THE DOWNLOAD LIBRARY — EVERYTHING YOU HAVE ALREADY PAID FOR, AND CAN HAVE AGAIN.
//
// This is what fills the space under the hero. What used to be there re-showed the SAME resume
// page thumbnails the carousel above was already showing — `image={cards[i % cards.length]?.image}`
// under a company badge — so scrolling revealed the same designs a second time and told the user
// nothing new. This shows something only they know: what they bought.
//
// IT IS A SHELF OF DOCUMENTS, NOT A LIST OF ROWS (the product owner's call, 2026-09-15: "the download
// cards look very bad"). A row gave the document 50×70pt and spent the rest of its width on three lines of
// caption, so the one thing that made a card worth looking at — the page they paid for — was a postage
// stamp. Now the page is the card: two paper cards to a line, the rendered document filling the top of each
// (an A4 page cropped from the foot, because the head is where the name and the design live), the
// employer's ribbon on it exactly as the hero page wears one, and a single strip underneath that says which
// design, what file and when. Everything a row said is still said; it just no longer competes with the page.
//
// ⚠️ A TAP OPENS THE PAGE, IT NEVER DOWNLOADS (the product owner's call, 2026-09-13). A card grows into
// the same zoomed page a hero page does (PaperZoom), with the same two doors — Customize and View PDF —
// and the download happens from View PDF exactly as it does from the hero. So a card only REPORTS: which
// item, and where its paper is on screen (onOpen). What that item opens — the employer's saved document,
// the base resume, or for a letter with nothing saved the file itself — is Home's decision, not this list's.
//
// ⚠️ THE GLASS IS DRAWN FROM ITS EDGES, NOT FROM A BLUR. expo-blur is installed, and it is still
// the wrong tool here: BlurView over a scrolling parent samples imperfectly on Android and costs
// real frames, so the card would look like two different materials on two platforms. What actually
// makes something read as glass is not the blur — it is the LIT TOP FACE, the bright compressed
// edge where light refracts, the fall-off down the pane and the return light at the foot. All of
// those are linear gradients, which render identically everywhere. The stack below is that, in
// order, and the press animation slides the specular across the top edge: a static highlight is a
// picture of glass, a highlight that moves is glass. The paper sits INSET in that pane, so the frame
// and its lit rim stay visible around it — a page bled to the edges would bury the material.
//
// ⚠️ THE PADLOCK IS THE SERVER'S ANSWER, NEVER OURS. `unlocked` is computed server-side from the
// same subscription and the same passes canDownload consults the instant they tap, using the same
// fuzzy employer match. If this component decided free-ness for itself — "they own the employer, so
// it must be open" — it would draw an open padlock over a 403 the moment a plan lapsed. That is
// also why there is no `unlockedEmployers` set: a second source of truth for a money question is
// how the two answers start to disagree.
//
// ⚠️ NO RENDER IS EVER REQUESTED FROM THIS FILE. Every picture comes through `imageFor`, which Home
// answers from what it already holds: the employer's own document pages (the image cache the deck
// fills, and the few cards Home warms for the front of the shelf), the base pages it hydrated for the
// carousel, or nothing. Rendering is serial server-side and single-process chromium dies after about
// five pages, which is why every page endpoint caps its ids; a shelf that asked for its own renders
// would stampede the front door of the app. A card with nothing in hand gets the letterpress page —
// the accent-tinted drawn page PaperSkeleton draws for a deck slot, at this size — which costs
// nothing and still reads as THAT design rather than as a hole.
//
// ⚠️ A COVER LETTER'S ONLY PICTURE IS A SAVED LETTER'S OWN PAGE — there is no thumbnail endpoint for
// a letter that is not saved, and the preview endpoint renders per request with no disk cache. So a
// drawn letter page is the NORMAL case for a letter with nothing saved, not a failure, and it draws
// itself as a letter: a right-aligned address block where a resume has its name.
//
// ⚠️ ANIMATION DRIVER RULE (the b126-128 fatal crash): one driver per view tree. This section is a
// child of Home's outer Animated.ScrollView, whose onScroll already drives a native value — so
// every animation here is useNativeDriver:true on transform and opacity ONLY. Nothing animates
// width, height, margin, borderRadius or colour, and there is no JS-driven Animated.Value.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Pressable, TouchableOpacity, Animated, Easing, ActivityIndicator,
  type DimensionValue,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { E } from './theme';
import { AFFORDANCE } from './PaperSkeleton';
import { gradFor, DownloadHistoryItem } from '../../services/employerHomeService';
import type { OriginRect } from './PaperZoom';

/** Two cards to a line, this far apart — and the same distance between lines. */
const GUTTER = 12;
/**
 * The paper's width ÷ height. A4 is 0.707; the page is CROPPED to this from the foot (contentPosition
 * top), so the card shows the head of the page — name, headline, the design's band — at a height two
 * lines of cards can afford on a phone. The zoom then grows the whole page out of this rectangle.
 */
const PAPER_RATIO = 0.8;
/** The glass frame around the paper: enough to show the pane and its lit rim, never a mat. */
const FRAME = 6;

/**
 * Home is a hero surface, not a list screen. Four cards is two lines — one glance — and "See all N"
 * opens the rest. ⚠️ Expanded shows EVERYTHING the server sent: the server itself keeps at most 60 per
 * kind (downloadHistory KEEP_PER_KIND), so the bound is upstream, and a second cap here would hide a
 * file they paid for behind a number that reads as a bug.
 */
const PREVIEW_CARDS = 4;

/** Every colour in the employer palette is 6-digit hex. */
const rgba = (hex: string, a: number) =>
  `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;

/**
 * Catalogue accents are 6-digit hex, but the recolour variants are GENERATED, so the string is never
 * trusted blindly — an unparsable accent falls back to the same E.blue that `accentFor` uses, rather
 * than throwing NaN into a colour string. (PaperSkeleton's guard, at this size — see its header on why
 * the two drawn pages are deliberate siblings rather than one import.)
 */
function tint(hex: string, a: number): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec((hex || '').trim());
  if (!m) return `rgba(79,141,255,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** today / yesterday / 4 days ago / 12 Aug / 12 Aug 2025. Never an ISO string, never a clock time. */
function stamp(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const now = Date.now();
  const h = (now - t) / 3600000;
  if (h < 24) return 'today';
  if (h < 48) return 'yesterday';
  const days = Math.floor(h / 24);
  if (days < 7) return `${days} days ago`;
  const m = d.toLocaleDateString('en-GB', { month: 'short' });
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
  // ⚠️ RE-WEIGHTED FOR A DARK GROUND. These same numbers over white read as a tint; over the page
  // gradient they have to carry the whole card, so the colour goes up and every WHITE face comes
  // DOWN — a 0.50 sheen that looked like light on a white card is a grey patch on a dark one, and
  // it takes the text's contrast with it.
  const a0 = dim ? 0.20 : (warm ? 0.30 : 0.40);
  const a1 = dim ? 0.07 : 0.13;
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
          colors={['rgba(255,255,255,0.42)', 'rgba(255,255,255,0)']}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={StyleSheet.absoluteFill}
        />
      </View>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: sheenOpacity }]} pointerEvents="none">
        <LinearGradient
          colors={['rgba(255,255,255,0.17)', 'rgba(255,255,255,0.03)', 'rgba(255,255,255,0)']}
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
        <LinearGradient colors={['rgba(255,255,255,0.16)', 'rgba(255,255,255,0)']} start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 1 }} style={StyleSheet.absoluteFill} />
      </View>
      <View style={s.shade} pointerEvents="none">
        <LinearGradient colors={['rgba(4,6,16,0)', 'rgba(4,6,16,0.22)']} start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 1 }} style={StyleSheet.absoluteFill} />
      </View>
      {/* Dark, then bright, in two points. That reversal at the foot is what reads as an object
          made of a material rather than a rectangle with a gradient in it. */}
      <View style={s.returnLight} pointerEvents="none" />
    </>
  );
}

/* ── the page ───────────────────────────────────────────────────────────────────────────────── */

const pct = (n: number): DimensionValue => `${n}%`;

/** Section headings, in % of page height — the design's accent, faint. */
const RESUME_HEADS = [28, 54, 75];
/**
 * [top % of the page, width % of the page] — ragged on purpose: even line lengths read as a barcode.
 * The last rule stops well short of the foot so the zoom affordance drawn there never crosses one.
 */
const RESUME_RULES: Array<[number, number]> = [
  [34, 70], [39, 58], [44, 66], [49, 46],
  [60, 64], [65, 72], [70, 52],
  [81, 60], [86, 68],
];
/** A letter: the subject line takes the accent, then paragraphs, then a sign-off half a line wide. */
const LETTER_RULES: Array<[number, number]> = [
  [40, 72], [45, 66], [50, 70], [55, 50],
  [64, 70], [69, 64], [74, 58],
  [84, 36],
];

/**
 * Drawn in RN, costing nothing, as a page of THIS design: the accent gets the head (on a real page that
 * is usually where it is), then a name block or an address block, then rule lines in the proportions of
 * a page. ⚠️ Every measure is a percentage of the paper, never a point: the same page draws at 120pt on a
 * 320pt phone and at 175pt on a 430pt one, and a fixed 50×70 grid of rules would sit in one corner of it.
 */
function Letterpress({ accent, letter }: { accent: string; letter: boolean }) {
  return (
    <View style={s.pPage} pointerEvents="none">
      <View style={[s.pAccent, { backgroundColor: accent }]} />
      <LinearGradient
        colors={[tint(accent, 0.16), 'transparent']}
        start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 1 }}
        style={s.pWash}
      />
      {letter ? (
        // A letter is not a resume and must not draw like one: the head of a letter is the
        // recipient's address, set to the right, and the subject line carries the accent.
        <>
          <View style={s.pAddr}>
            {[44, 38, 30].map((w, i) => (
              <View key={i} style={[s.pRule, { width: pct(w), alignSelf: 'flex-end', marginTop: i ? 4 : 0 }]} />
            ))}
          </View>
          <View style={[s.pHead, { top: pct(30), width: pct(40), backgroundColor: tint(accent, 0.5) }]} />
        </>
      ) : (
        <>
          <View style={s.pName} />
          <View style={s.pSub} />
          {RESUME_HEADS.map((t, i) => (
            <View key={i} style={[s.pHead, { top: pct(t), width: pct(22), backgroundColor: tint(accent, 0.5) }]} />
          ))}
        </>
      )}
      {(letter ? LETTER_RULES : RESUME_RULES).map(([t, w], i) => (
        <View key={i} style={[s.pRule, s.pRuleAbs, { top: pct(t), width: pct(w) }]} />
      ))}
    </View>
  );
}

/* ── one card ───────────────────────────────────────────────────────────────────────────────── */

function Card({
  item, image, accent, brandAccent, index, busy, onOpen,
}: {
  item: DownloadHistoryItem;
  image?: string | null;
  /** The design's catalogue accent — the drawn page's tint unless `brandAccent` overrides it. */
  accent: string;
  /**
   * The employer's brand accent when this row's document is the one on screen (Home's brandAccentFor): its
   * pages were recoloured to it, and the deck above tints its skeletons with it, so the drawn page here wears
   * the same colour rather than promising the catalogue blue beside a red hero. Null = the catalogue accent.
   */
  brandAccent?: string | null;
  index: number;
  busy: boolean;
  onOpen: (it: DownloadHistoryItem, origin: OriginRect | null) => void;
}) {
  const a = useRef(new Animated.Value(0)).current;
  const p = useRef(new Animated.Value(0)).current;
  // The paper the zoom grows out of — see `tap`.
  const paper = useRef<View>(null);
  const [justDone, setJustDone] = useState(false);
  const wasBusy = useRef(false);

  useEffect(() => {
    // Capped at index 5 so an expanded sixty-card shelf never cascades for four seconds.
    Animated.timing(a, {
      toValue: 1, duration: 300, delay: Math.min(index, 5) * 60,
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
  const who = (item.employer || '').trim();
  const pair = gradFor(item.employer || item.templateName);
  const letter = item.kind === 'cover_letter';

  /**
   * Open this card. ⚠️ MEASURED FROM THE PAPER, NOT FROM THE CARD. PaperZoom puts frame one of the page on the
   * rectangle it is handed with ONE uniform scale taken from that rectangle's width, so the rectangle has to
   * be the page's: the paper is the cropped head of the page, and the page grows straight out of it. The
   * whole card would start the page wider than it ends (the strip is not paper) and shrink it into place.
   * null = the paper could not be measured, and the zoom opens from the centre instead.
   * A padlock does not stop the tap: looking is free, and whether the download goes through is View PDF's
   * question, answered by the same gate as a first download.
   */
  const tap = useCallback(() => {
    if (busy) return;
    try { Haptics.selectionAsync(); } catch {}
    const node: any = paper.current;
    if (!node || typeof node.measureInWindow !== 'function') { onOpen(item, null); return; }
    node.measureInWindow((x: number, y: number, w: number, h: number) => onOpen(item, w ? { x, y, w, h } : null));
  }, [busy, item, onOpen]);

  const label = busy ? 'Getting your file'
    : justDone ? 'Saved'
      : `Open ${item.templateName || 'your design'} for ${who || 'this employer'}`
        + `, ${item.format === 'docx' ? 'Word' : 'PDF'}`
        + (item.times > 1 ? `, downloaded ${item.times} times` : '')
        + (free ? '' : '. Downloading it again is locked because your plan ended');

  return (
    <View style={s.cell}>
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
          accessibilityLabel={label}
          accessibilityHint={busy || justDone ? undefined : 'Opens the page, with Customize and View PDF'}
        >
          <Animated.View
            style={[s.shell, { transform: [{ scale: p.interpolate({ inputRange: [0, 1], outputRange: [1, 0.975] }) }] }]}
          >
            {/* The material only — BEHIND the body, and never what decides the card's height. */}
            <View style={s.clip} pointerEvents="none">
              <Facets
                pair={pair}
                dim={!free}
                rim={p.interpolate({ inputRange: [0, 1], outputRange: [0, -28] })}
                sheenOpacity={p.interpolate({ inputRange: [0, 1], outputRange: [1, 0.60] })}
              />
            </View>

            <View style={s.body}>
              {/* ── the paper ──
                  collapsable={false}: Android may flatten a view that only lays out, and a flattened view
                  cannot be measured — this one carries the zoom's starting rectangle. */}
              <View ref={paper} collapsable={false} style={s.paper}>
                <View style={s.paperClip}>
                  {image ? (
                    <ExpoImage
                      source={{ uri: image }}
                      style={s.paperImg}
                      contentFit="cover"
                      contentPosition="top"
                      transition={220}
                    />
                  ) : (
                    <Letterpress accent={brandAccent || accent} letter={letter} />
                  )}
                </View>

                {/* ── the employer's ribbon, top-left, as the hero page wears it; the padlock top-right ──
                    ⚠️ The ribbon shrinks, the padlock never does: a long employer name truncates inside the
                    pill instead of pushing the lock off the paper. Never dimmed on a locked card — greying
                    the name is what makes people believe their work is gone. */}
                <View style={s.overlay} pointerEvents="none">
                  <View style={s.ribbon}>
                    <LinearGradient colors={pair} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.ribbonTile}>
                      <Text style={s.ribbonTileTx} allowFontScaling={false}>
                        {(who || '?').charAt(0).toUpperCase()}
                      </Text>
                    </LinearGradient>
                    <Text style={s.ribbonTx} numberOfLines={1} maxFontSizeMultiplier={1.15}>
                      {who || 'No employer'}
                    </Text>
                  </View>
                  {!free && (
                    // Amber, never red: red says you did something wrong, amber says paused.
                    <View style={s.lockPill}>
                      <Ionicons name="lock-closed" size={11} color="#FCD34D" />
                    </View>
                  )}
                </View>

                {/* ── what a tap does, bottom-right, the hero page's own affordance at its own size ──
                    ⚠️ "Open", never a download arrow: the tap opens the page (see the header), and an arrow
                    promised a file the tap no longer fetches. The spinner and the tick belong to the only
                    paths that still fetch a file from here: a letter card with no saved letter to open, and
                    a file the paywall has just unlocked. Same box in every state so nothing shifts. */}
                <View style={[s.affordance, (busy || justDone) && s.affordanceLive]} pointerEvents="none">
                  {busy ? <ActivityIndicator size="small" color={E.mint} />
                    : justDone ? <Ionicons name="checkmark" size={15} color={E.mint} />
                      : <Ionicons name="expand-outline" size={13} color="#fff" />}
                </View>
              </View>

              {/* ── which design, what file, when ──
                  ⚠️ THE META LINE MAY WRAP, AND ITS SEPARATORS ARE ONE SPACE WIDE. The strip's text is
                  ~116pt on a 320pt phone (cell 150 − gutter 12 − frame/strip padding 22), and at
                  numberOfLines 1 with "  ·  " and a letter-spaced format, "WORD · 12 Aug 2025 · ×12" ran to
                  ~140pt at the default size and ~170pt at 1.25× — the ellipsis ate the count first and then the
                  date, the two things the line is for. Single-space dots and no letter-spacing keep the worst
                  case (~112pt) on one line at 1×; larger text wraps the tail onto a second line the strip grows
                  for (minHeight, never height) instead of cutting it off. */}
              <View style={s.strip}>
                <Text style={s.design} numberOfLines={1} maxFontSizeMultiplier={1.3}>
                  {item.templateName || 'Your design'}
                </Text>
                <Text style={s.meta} numberOfLines={2} maxFontSizeMultiplier={1.25}>
                  <Text style={[s.fmt, item.format === 'docx' && s.fmtDoc]}>
                    {item.format === 'docx' ? 'WORD' : 'PDF'}
                  </Text>
                  <Text style={s.metaDot}>{' · '}</Text>
                  {stamp(item.downloadedAt)}
                  {/* Honest data, never decoration: `times` is a real count, because a download is
                      upserted on document identity rather than appended per tap. */}
                  {item.times > 1 && (
                    <>
                      <Text style={s.metaDot}>{' · '}</Text>
                      <Text style={s.times}>×{item.times}</Text>
                    </>
                  )}
                </Text>
              </View>
            </View>

            {/* Above the content so nothing crosses it. RN cannot colour a border per side, so one
                even rim plus the directional gradients above is the closest honest approximation. */}
            <View style={s.innerRim} pointerEvents="none" />
          </Animated.View>
        </Pressable>
      </Animated.View>
    </View>
  );
}

/* ── loading ────────────────────────────────────────────────────────────────────────────────── */

function SkeletonCard({ index }: { index: number }) {
  const g = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.delay(index * 220),
      Animated.timing(g, { toValue: 1, duration: 1100, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(g, { toValue: 0, duration: 0, useNativeDriver: true }),
      Animated.delay(500),
    ]));
    loop.start();
    return () => loop.stop();
  }, [g, index]);
  const still = useRef(new Animated.Value(0)).current;
  return (
    <View style={s.cell}>
      <View style={s.shell}>
        {/* The material is not what we are waiting for, so it is already here — nothing reflows
            when the data lands. */}
        <View style={s.clip} pointerEvents="none">
          <Facets pair={[E.blue, E.purple]} dim rim={still} sheenOpacity={1 as any} />
          <Animated.View
            style={[s.glare, { transform: [{ translateX: g.interpolate({ inputRange: [0, 1], outputRange: [-160, 320] }) }] }]}
            pointerEvents="none"
          >
            <LinearGradient
              colors={['transparent', 'rgba(255,255,255,0.55)', 'transparent']}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
              style={StyleSheet.absoluteFill}
            />
          </Animated.View>
        </View>
        <View style={s.body}>
          <View style={s.skPaper} />
          <View style={s.strip}>
            <View style={[s.skBar, s.skBarDesign]} />
            <View style={[s.skBar, s.skBarMeta]} />
          </View>
        </View>
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
/** The fan's blank sheets: the renderer's own A4 ratio (68 * 300/424 = 48.1). */
const FAN_W = 50;
const FAN_H = 70;

/**
 * Nothing downloaded yet.
 *
 * ⚠️ THE CARD IS AS TALL AS WHAT IS IN IT — NEVER A FIXED HEIGHT (the product owner's iPhone, 2026-09-14). It
 * used to be `height: 150` with the whole body inside the absolutely-filled clip, so the body could not make
 * the card any taller: the fan, the heading, two-to-three lines of text and a 34pt button need ~210pt at the
 * default text size, and the card cut the button and the last line off with no padding at all — worse on a
 * 320pt phone, where the sentence runs to three lines, and worse again with larger text. Now the material (wash,
 * facets, rim) stays in the absolute clip BEHIND, and the body sits in normal flow in front of it with its own
 * generous padding, so the card grows to fit whatever the text size and width make of the copy. minHeight
 * only keeps a short card from looking like a row.
 */
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
    <View style={s.emptyShell}>
      {/* The material only — BEHIND the body, and never what decides the card's height. */}
      <View style={s.clip} pointerEvents="none">
        <View style={s.wash} pointerEvents="none">
          <LinearGradient
            colors={['rgba(79,141,255,0.16)', 'rgba(124,107,255,0.05)', 'transparent']}
            locations={[0, 0.55, 1]}
            start={{ x: 0, y: 0.15 }} end={{ x: 1, y: 0.85 }}
            style={StyleSheet.absoluteFill}
          />
        </View>
        <Facets pair={[E.blue, E.purple]} dim rim={still} sheenOpacity={1 as any} />
        <View style={s.innerRim} />
      </View>
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
              {[{ t: 14, w: 76 }, { t: 20, w: 86 }, { t: 26, w: 64 }, { t: 34, w: 42 }].map((r, j) => (
                <View key={j} style={[s.pRule, s.pRuleAbs, { top: r.t, width: pct(r.w), backgroundColor: 'rgba(11,15,34,0.06)' }]} />
              ))}
            </Animated.View>
          ))}
        </View>
        <Text style={s.emptyH} numberOfLines={2} maxFontSizeMultiplier={1.35}>Nothing downloaded yet</Text>
        {/* ⚠️ No numberOfLines here: this sentence is the explanation, and at 320pt with large text it needs
            four lines — the card grows for it rather than cutting it off. */}
        <Text style={s.emptyTx} maxFontSizeMultiplier={1.3}>
          {mode === 'letter'
            ? 'Every cover letter you download lands here, ready to send again.'
            : 'Every resume you download lands here, so you can get the same file again without paying twice.'}
        </Text>
        {/* Not a gradient CTA and not a navigation: the designs are on this same screen, straight
            up. Sending someone somewhere else for something already here would be a small lie. */}
        <TouchableOpacity
          style={s.emptyLink}
          activeOpacity={0.85}
          onPress={onScrollToTop}
          accessibilityRole="button"
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
        >
          <Ionicons name="arrow-up" size={13} color="#fff" />
          {/* ⚠️ PER MODE. In letter mode what is above is the employer's letter — a Write button when none is
              saved, its ranked formats when one is — so "Pick a design" named something that may not be there. */}
          <Text style={s.emptyLinkTx} numberOfLines={1} maxFontSizeMultiplier={1.3}>
            {mode === 'letter' ? 'Your cover letter is above' : 'Pick a design above'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

/* ── the section ────────────────────────────────────────────────────────────────────────────── */

export default function DownloadHistory({
  mode, items, loading, expanded, busyId, imageFor, accentFor, brandAccentFor, onOpen, onExpand,
  onScrollToTop, onMoreJobs,
}: {
  mode: 'resume' | 'letter';
  items: DownloadHistoryItem[];
  loading: boolean;
  expanded: boolean;
  /** The card currently being produced, so only that one shows a spinner. */
  busyId: number | null;
  /**
   * The page for this card, from what Home ALREADY HOLDS — the employer's own document page when one is
   * in hand, else the base page in that design, else nothing (the drawn page). ⚠️ NEVER triggers a
   * render: it is read at every paint, so it answers from memory or not at all. Decided per item, not per
   * mode, so a card knows a letter from a resume by its own `kind`.
   */
  imageFor: (item: DownloadHistoryItem) => string | null | undefined;
  /** The design's accent from the catalogue Home already loaded — the drawn page's tint. */
  accentFor: (templateId: string) => string;
  /**
   * The employer's brand accent for a row whose saved document is the one on screen (its pages were
   * recoloured to it — see Card.brandAccent), else null: the drawn page then keeps the catalogue accent.
   * Optional so a caller that knows no documents (the preview harness) type-checks unchanged.
   */
  brandAccentFor?: (item: DownloadHistoryItem) => string | null;
  /**
   * A card was tapped: open it. `origin` is its paper's rectangle on screen (measureInWindow), for the zoom
   * to grow out of; null when it could not be measured.
   */
  onOpen: (item: DownloadHistoryItem, origin: OriginRect | null) => void;
  /**
   * ⚠️ NO LONGER CALLED BY A TAP — a card opens its page (see the header). Optional, and read by nothing in
   * this file, so a caller that still passes them type-checks and a tap still cannot download.
   */
  onAgain?: (it: DownloadHistoryItem) => void;
  onPay?: (employer: string | null) => void;
  onExpand: () => void;
  onScrollToTop: () => void;
  /** The one affordance the section this replaced had, and the only route to the jobs tab from
   *  Home in resume mode. Losing it would quietly lose the targets entry point. */
  onMoreJobs: () => void;
}) {
  const shown = expanded ? items : items.slice(0, PREVIEW_CARDS);
  // ⚠️ Counted over the cards ACTUALLY ON SCREEN. Counting the whole list made the strip announce
  // a locked file that was hidden behind "See all", which reads as a bug in the count.
  const lockedCount = shown.filter((i) => !i.unlocked).length;

  /**
   * The shelf fades in on a mode change; the header and the title never move.
   *
   * ⚠️ THE CARDS ARE RENDERED STRAIGHT FROM PROPS AND ARE NEVER HELD BEHIND AN ANIMATION CALLBACK.
   * The first version swapped them inside the completion handler of a fade-OUT, which deadlocked:
   * flipping the mode also refetches, so `items` changes a moment after `mode` does, the effect ran
   * a second time, the second Animated.timing cancelled the first — and a cancelled animation still
   * calls its callback, so the fade-in fired while the newer fade-out was driving the value back
   * down. The list settled at opacity 0 and the whole section went blank on the app's front door.
   * Snapping to 0 and animating up has no callback, cannot race, and reads the same: the old cards
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
        <View style={s.headTx}>
          <Text style={s.eyebrow} numberOfLines={1} maxFontSizeMultiplier={1.3}>Your library</Text>
          <Text style={s.title} numberOfLines={1} maxFontSizeMultiplier={1.3}>{title}</Text>
        </View>
        <TouchableOpacity style={s.seeAll} activeOpacity={0.8} onPress={onMoreJobs} accessibilityRole="button">
          <Text style={s.seeAllTx} numberOfLines={1} maxFontSizeMultiplier={1.3}>More jobs </Text>
          <Ionicons name="arrow-forward" size={12} color={LINK} />
        </TouchableOpacity>
      </View>

      {showSkeletons ? (
        <View style={s.grid}>{[0, 1, 2, 3].map((i) => <SkeletonCard key={i} index={i} />)}</View>
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
          <View style={s.grid}>
            {shown.map((it, i) => (
              <Card
                key={`${mode}-${it.id}`}
                item={it}
                index={i}
                image={imageFor(it)}
                accent={accentFor(it.templateId)}
                brandAccent={brandAccentFor ? brandAccentFor(it) : null}
                busy={busyId === it.id}
                onOpen={onOpen}
              />
            ))}
          </View>

          {items.length > PREVIEW_CARDS && !expanded && (
            <TouchableOpacity style={s.expand} activeOpacity={0.85} onPress={onExpand} accessibilityRole="button">
              <Text style={s.expandTx} numberOfLines={1} maxFontSizeMultiplier={1.3}>See all {items.length}</Text>
              <Ionicons name="chevron-down" size={14} color="rgba(255,255,255,0.7)" />
            </TouchableOpacity>
          )}

          {lockedCount > 0 && (
            // ⚠️ LOAD-BEARING COPY. It says what happened and what fixes it, and it must never
            // imply they are being charged twice for the same thing — they are not; a pass buys the
            // employer and everything for that employer comes back. No date is named because the
            // endpoint returns none, and an invented one would be a lie.
            <View style={s.lockedStrip}>
              <Ionicons name="information-circle" size={15} color="#B9AEFF" style={s.lockedIcon} />
              <Text style={s.lockedTx} maxFontSizeMultiplier={1.3}>
                {lockedCount === 1 ? '1 file is' : `${lockedCount} files are`} locked because your plan
                ended. Nothing was deleted — your designs and your details are exactly as you left
                them. One payment for a company, or a plan, brings them back.
              </Text>
            </View>
          )}

          {mode === 'resume' && (
            <Text style={s.footnote} maxFontSizeMultiplier={1.3}>Tap one to open it · a download uses your latest resume in that design.</Text>
          )}
        </Animated.View>
      )}
    </View>
  );
}

/** The one blue that still reads as a link on this ground. */
const LINK = '#9DBEFF';

/**
 * The glass pane's own box — fill, hairline, shadow — shared by a card and the empty card, both sized by
 * their content. See `shell` below for why it is darker than the page.
 */
const GLASS_SHELL = {
  borderRadius: 16, backgroundColor: 'rgba(6,11,30,0.46)',
  borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.10)',
  shadowColor: '#01030A', shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.45, shadowRadius: 20,
  elevation: 4,
} as const;

const s = StyleSheet.create({
  // ⚠️ 22 on top, not 26: the hero above ends where its content ends and melts across its last
  // 118pt, so this section starts immediately after that ramp. A second 26pt of air on top
  // of it re-opened the same gap the melt was shortened to close.
  wrap: { paddingHorizontal: 16, paddingTop: 22 },

  head: { flexDirection: 'row', alignItems: 'flex-end', gap: 10, marginBottom: 12 },
  // The eyebrow + title take what "More jobs" leaves, so a long title truncates rather than pushing the link off.
  headTx: { flex: 1 },
  // The same values the hero's own eyebrow uses, so it reads as its sibling.
  eyebrow: { fontSize: 10, fontWeight: '700', letterSpacing: 1.8, textTransform: 'uppercase', color: 'rgba(255,255,255,0.45)' },
  title: { fontSize: 19, fontWeight: '800', color: '#fff', letterSpacing: -0.7, marginTop: 3, flexShrink: 1 },
  seeAll: { flexDirection: 'row', alignItems: 'center', paddingBottom: 3, flexShrink: 0 },
  seeAllTx: { fontSize: 12.5, fontWeight: '700', color: LINK, flexShrink: 1 },

  // ⚠️ TWO TO A LINE BY HALVES, NEVER BY A MEASURED WIDTH OR A PERCENT-PLUS-GAP. Two 48% cards with a
  // 12pt gap between them add up to more than 100% on a 320pt phone, and the second card wraps to its
  // own line. Each cell is exactly half the row and carries half the gutter as its own padding, the
  // grid pulls itself out by that half-gutter on each side, and the cards land flush with the section's
  // margins with GUTTER between them — at any width, without an onLayout. Lines are rowGap apart.
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -GUTTER / 2, rowGap: GUTTER },
  cell: { width: '50%', paddingHorizontal: GUTTER / 2 },

  // ⚠️ Shadow and clipping never share a view: iOS drops a shadow drawn on an overflow:'hidden'
  // view. The fill is TRANSLUCENT, so the page gradient shows through the card — that is what
  // makes it read as glass laid on the page rather than a white tile dropped on it. It is still
  // opaque enough that a card is a card even if every gradient below fails to draw.
  // ⚠️ DARKER THAN THE PAGE, NOT LIGHTER. A white tint over a blue gradient is a milky grey-blue —
  // the card and the ground meet in the middle, white text loses its contrast, and the whole shelf
  // reads as fog. Glass on a dark ground works the other way round: the pane is DEEPER than what is
  // behind it, and it is the lit rim that describes its shape. Now the ink is the brightest thing
  // on the card, which is what it should be.
  // ⚠️ NO `height`: the body (paper + strip) sizes the card, so a larger text size grows the strip
  // instead of clipping it, and the paper's own ratio sets the rest.
  shell: { ...GLASS_SHELL },
  // 15 and not 16: absolute children position against the padding box, so matching radii leave a
  // sub-pixel seam of shell colour at each corner.
  clip: { ...StyleSheet.absoluteFillObject, borderRadius: 15, overflow: 'hidden' },
  body: { flexGrow: 1 },

  wash: { position: 'absolute', left: 0, top: 0, bottom: 0, width: '58%' },
  // 22, not the row's 26: this band now runs behind the strip's text, and a wider one lit the first letters.
  refract: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 22 },
  rim: { position: 'absolute', top: 0, left: '-20%', width: '140%', height: 1.5 },
  falloff: { position: 'absolute', top: 1.5, left: 0, right: 0, height: 16 },
  shade: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 22 },
  returnLight: { position: 'absolute', bottom: 0, left: 10, right: 10, height: 1, backgroundColor: 'rgba(255,255,255,0.60)' },
  innerRim: { ...StyleSheet.absoluteFillObject, borderRadius: 15, borderWidth: 1, borderColor: 'rgba(255,255,255,0.13)' },

  // The paper: inset in the frame, its own drop shadow so it sits ON the glass rather than in it. The
  // clip is a child (shadow and clipping never share a view), and the overlays are its siblings so they
  // sit above the picture and are never cropped with it.
  paper: {
    marginTop: FRAME, marginHorizontal: FRAME, aspectRatio: PAPER_RATIO, borderRadius: 10, backgroundColor: '#fff',
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.35, shadowRadius: 8, elevation: 3,
  },
  // Not #fff: slightly cool, so a drawn page reads as paper in shade rather than as a grey panel, and a
  // real page (which is white) reads brighter than the one still on its way.
  paperClip: { ...StyleSheet.absoluteFillObject, borderRadius: 10, overflow: 'hidden', backgroundColor: '#EDF1F8' },
  paperImg: { ...StyleSheet.absoluteFillObject },

  // The drawn page. Everything in % of the paper — see Letterpress.
  pPage: { ...StyleSheet.absoluteFillObject },
  pAccent: { position: 'absolute', left: 0, right: 0, top: 0, height: '7%' },
  pWash: { position: 'absolute', left: 0, right: 0, top: '7%', height: '18%' },
  pName: { position: 'absolute', left: '9%', top: '13%', width: '56%', height: '4.5%', borderRadius: 3, backgroundColor: 'rgba(11,15,34,0.22)' },
  pSub: { position: 'absolute', left: '9%', top: '20%', width: '36%', height: '2.6%', borderRadius: 2, backgroundColor: 'rgba(11,15,34,0.13)' },
  pAddr: { position: 'absolute', left: '9%', right: '9%', top: '13%' },
  pHead: { position: 'absolute', left: '9%', height: 3, borderRadius: 2 },
  pRule: { height: 2, borderRadius: 1, backgroundColor: 'rgba(11,15,34,0.10)' },
  pRuleAbs: { position: 'absolute', left: '9%' },

  // The overlays on the paper: the ribbon and the padlock across the head, the affordance at the foot.
  overlay: {
    position: 'absolute', left: 6, right: 6, top: 6,
    flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 6,
  },
  // The hero page's ribbon — same dark glass, same tile, same uppercase — one size up for a card
  // that is looked at rather than swiped past.
  ribbon: {
    flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1,
    paddingVertical: 4, paddingLeft: 4, paddingRight: 8, borderRadius: 100,
    backgroundColor: 'rgba(11,15,34,0.86)',
  },
  ribbonTile: { width: 16, height: 16, borderRadius: 5, alignItems: 'center', justifyContent: 'center' },
  ribbonTileTx: { fontSize: 8.5, fontWeight: '800', color: '#fff' },
  ribbonTx: { fontSize: 8.5, fontWeight: '800', color: '#fff', letterSpacing: 0.5, textTransform: 'uppercase', flexShrink: 1 },
  lockPill: {
    width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    backgroundColor: 'rgba(11,15,34,0.86)', borderWidth: 1, borderColor: 'rgba(245,158,11,0.42)',
  },
  // ⚠️ BUILT FROM PaperSkeleton's AFFORDANCE, like the hero's own button, so the two never drift apart.
  affordance: {
    position: 'absolute', right: AFFORDANCE.inset, bottom: AFFORDANCE.inset,
    width: AFFORDANCE.size, height: AFFORDANCE.size, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(11,15,34,0.55)',
  },
  // The same mint that says "do this" everywhere else on the screen, for the one moment a card is
  // actually fetching or has just saved a file.
  affordanceLive: { backgroundColor: 'rgba(45,224,192,0.16)', borderWidth: 1, borderColor: 'rgba(45,224,192,0.38)' },

  // The strip: minHeight, never height — a larger text size grows it.
  strip: { paddingHorizontal: 11, paddingTop: 9, paddingBottom: 10, minHeight: 48, justifyContent: 'center' },
  design: { fontSize: 12.5, fontWeight: '800', color: '#fff', letterSpacing: -0.3 },
  // The hero's caption metric, recoloured. The type scale is the clearest tell that the two halves of
  // this screen are one design.
  // lineHeight so the two lines it may wrap to (see the strip) sit as one block rather than at the platform's
  // looser default; no letterSpacing on the format — it cost ~3pt a letter on a line that has ~116pt to spend.
  meta: { marginTop: 3, fontSize: 10, lineHeight: 14, fontWeight: '700', color: 'rgba(255,255,255,0.5)' },
  fmt: { fontSize: 9.5, fontWeight: '800', color: 'rgba(255,255,255,0.55)' },
  fmtDoc: { color: '#9DBEFF' },
  metaDot: { color: 'rgba(255,255,255,0.28)' },
  times: { color: 'rgba(255,255,255,0.62)', fontWeight: '800' },

  skPaper: { marginTop: FRAME, marginHorizontal: FRAME, aspectRatio: PAPER_RATIO, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.09)' },
  skBar: { backgroundColor: 'rgba(255,255,255,0.09)' },
  // The two lines of the strip, as bars: the design name, then the meta line under it.
  skBarDesign: { width: '72%', height: 10, borderRadius: 5 },
  skBarMeta: { width: '48%', height: 7, borderRadius: 3.5, marginTop: 7 },
  glare: { position: 'absolute', top: 0, bottom: 0, width: 120 },

  // ⚠️ NO `height` (see EmptyState): the same glass as a card, sized by its body. The body is in flow and
  // carries the padding — 26 on top clears the fan's rotated corners, 24 below keeps the button off the rim.
  emptyShell: { minHeight: 208, ...GLASS_SHELL },
  emptyBody: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 22, paddingTop: 26, paddingBottom: 24 },
  // Tall enough for the fan's lowest corner (FAN_H + its 5pt drop), so the heading never overlaps a page.
  fanRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', minHeight: FAN_H + 8 },
  blank: {
    width: FAN_W, height: FAN_H, borderRadius: 6, backgroundColor: '#FFFFFF',
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(11,15,34,0.10)', marginHorizontal: -12,
  },
  emptyH: { marginTop: 14, fontSize: 15, fontWeight: '800', color: '#fff', letterSpacing: -0.3, textAlign: 'center', flexShrink: 1 },
  // A definite width (the body's, capped at 300) so the sentence wraps inside the card's padding at any width.
  emptyTx: {
    marginTop: 6, fontSize: 12.5, fontWeight: '600', color: 'rgba(255,255,255,0.6)', textAlign: 'center',
    lineHeight: 18, width: '100%', maxWidth: 300,
  },
  // minHeight, not height, so a larger text size grows the button instead of clipping its label.
  emptyLink: {
    marginTop: 16, minHeight: 38, paddingVertical: 8, maxWidth: '100%',
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16,
    borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.12)', borderWidth: 1, borderColor: E.glassBorder,
  },
  emptyLinkTx: { fontSize: 12.5, fontWeight: '700', color: '#fff', flexShrink: 1 },

  expand: {
    marginTop: 12, minHeight: 42, paddingVertical: 8, borderRadius: 14, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'center', gap: 5,
    backgroundColor: 'rgba(255,255,255,0.07)', borderWidth: 1, borderColor: E.glassBorder,
  },
  expandTx: { fontSize: 13, fontWeight: '700', color: 'rgba(255,255,255,0.82)', flexShrink: 1 },

  lockedStrip: {
    marginTop: 12, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 14,
    backgroundColor: 'rgba(124,107,255,0.16)', borderWidth: 1, borderColor: 'rgba(124,107,255,0.34)',
    flexDirection: 'row', alignItems: 'flex-start', gap: 9,
  },
  // Nudged onto the first line's x-height so the icon reads as part of the sentence, not floating above it.
  lockedIcon: { marginTop: 1 },
  lockedTx: { flex: 1, fontSize: 11.5, fontWeight: '600', color: 'rgba(255,255,255,0.72)', lineHeight: 16 },

  footnote: { fontSize: 11, fontWeight: '600', color: 'rgba(255,255,255,0.42)', textAlign: 'center', marginTop: 10, flexShrink: 1 },
});
