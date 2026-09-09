// AI Hub — new feature. Safe to delete without affecting existing app.
//
// EVERYTHING YOU HAVE ALREADY PAID FOR, AND CAN HAVE AGAIN.
//
// This is what now fills the space under the hero. What used to be there re-showed the SAME resume
// page thumbnails the carousel above was already showing — `image={cards[i % cards.length]?.image}`
// under a company badge — so scrolling revealed the same designs a second time and told the user
// nothing new. This tells them something only they know: what they bought.
//
// ⚠️ THE PADLOCK IS THE SERVER'S ANSWER, NEVER OURS. `unlocked` is computed server-side from the
// same subscription and the same passes that canDownload will consult the instant they tap, using
// the same fuzzy employer match. If this component ever decided free-ness for itself — "they own
// the employer, so it must be open" — it would draw an open padlock over a 403 the moment a plan
// lapsed. It draws what it was told and nothing else.
//
// ⚠️ NO NEW PICTURES ARE FETCHED HERE. Resume thumbnails are BORROWED from the images Home already
// hydrated for the carousel, matched by template id. Server-side rendering is serial and
// single-process chromium dies after about five pages, which is why /home-cards is capped at five
// ids and Home's own hydration runs behind a single-flight mutex. A history list that requested its
// own renders would stampede the app's front door. A row with no already-loaded image gets the
// letterpress mark instead, which costs nothing and still reads as a document.
//
// ⚠️ A COVER LETTER HAS NO THUMBNAIL ANYWHERE IN THIS SYSTEM. The only letter preview endpoint
// demands the letter's HTML in the request body and renders per request with no disk cache. So
// letters get a drawn miniature — a page with its letterhead bar in the employer's own colour and
// ruled lines — rather than a picture. It is honestly a representation, not a claim to be the file.
//
// ⚠️ ANIMATION DRIVER RULE (the b126-128 fatal crash): one driver per view tree. This section is
// rendered INSIDE Home's outer Animated.ScrollView, whose onScroll already drives a native-driven
// value — so everything here is useNativeDriver:true on transform/opacity only, and there is not a
// single JS-driven Animated.Value. No width, height, margin or colour is ever animated.
import React, { useCallback, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Animated, Easing, ActivityIndicator, Platform,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Image as ExpoImage } from 'expo-image';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { E } from './theme';
import { gradFor, DownloadHistoryItem } from '../../services/employerHomeService';

/** A page's proportions, the same 300:424 the renderer itself uses. */
const MARK_W = 52;
const MARK_H = Math.round(MARK_W * (424 / 300));

/** How many rows Home shows before it offers the rest. Home is a hero surface, not a list screen. */
export const HISTORY_PREVIEW = 4;

/**
 * Frosted white, which is what "glass" means on a light ground.
 *
 * ⚠️ THE GLASS IS POSITIONAL. On the dark hero, glass is rgba(255,255,255,0.08) over a 1px
 * rgba(255,255,255,0.14) border — that recipe is invisible down here, below the stage's melt into
 * E.bg, and mixing the two across the fade line is the "two surfaces" seam this design already
 * fought once. So this is the light-family version of the same material: a real blur where the
 * platform gives us one, a translucent white body, and a bright hairline along the top edge only,
 * which is where light would actually catch.
 *
 * ⚠️ ANDROID GETS THE SOLID FALLBACK ON PURPOSE. BlurView over a scrolling parent is expensive
 * there and samples imperfectly; on a flat #E5EAF3 ground the difference between a blur and a
 * near-opaque white is almost nothing, and a smooth list is worth more than a sampling artefact.
 */
function Glass({ children, style }: { children: React.ReactNode; style?: any }) {
  return (
    <View style={[s.glassOuter, style]}>
      <View style={s.glassClip}>
        {Platform.OS === 'ios'
          ? <BlurView intensity={26} tint="light" style={StyleSheet.absoluteFill} />
          : <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(255,255,255,0.96)' }]} />}
        <View style={[StyleSheet.absoluteFill, s.glassBody]} pointerEvents="none" />
        <LinearGradient
          colors={['rgba(255,255,255,0.85)', 'rgba(255,255,255,0)']}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 1 }}
          style={s.glassTopLight}
          pointerEvents="none"
        />
        {children}
      </View>
    </View>
  );
}

/** The drawn stand-in for a document we have no picture of. Ruled lines under a coloured head. */
function LetterMark({ accent }: { accent: [string, string] }) {
  return (
    <View style={s.markPage}>
      <LinearGradient colors={accent} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.markHead} />
      <View style={s.markLines}>
        {[1, 0.72, 0.9, 0.55, 0.84, 0.4].map((w, i) => (
          <View key={i} style={[s.markLine, { width: `${w * 100}%` }]} />
        ))}
      </View>
    </View>
  );
}

/** "Tuesday", "12 Mar", "12 Mar 2025" — near dates read as words, older ones as dates. */
function friendlyDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const now = Date.now();
  const days = Math.floor((now - t) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  const sameYear = new Date(now).getFullYear() === d.getFullYear();
  return d.toLocaleDateString(undefined, sameYear
    ? { day: 'numeric', month: 'short' }
    : { day: 'numeric', month: 'short', year: 'numeric' });
}

function Row({
  item, image, index, busy, onAgain,
}: {
  item: DownloadHistoryItem;
  image?: string | null;
  index: number;
  busy: boolean;
  onAgain: (it: DownloadHistoryItem) => void;
}) {
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    // Staggered so the list assembles rather than appearing. Transform + opacity, native driver.
    Animated.timing(t, {
      toValue: 1,
      duration: 320,
      delay: Math.min(index, 6) * 55,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [t, index]);

  const accent = gradFor(item.employer || item.templateName);
  const who = item.employer || 'No employer';

  return (
    <Animated.View
      style={{
        opacity: t,
        transform: [{ translateY: t.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }],
      }}
    >
      <Glass style={s.row}>
        <TouchableOpacity
          style={s.rowInner}
          activeOpacity={0.86}
          onPress={() => onAgain(item)}
          disabled={busy}
          accessibilityLabel={`${item.unlocked ? 'Download again' : 'Unlock'} ${item.templateName} for ${who}`}
        >
          <View style={s.markWrap}>
            {image
              ? (
                <View style={s.markPage}>
                  <ExpoImage
                    source={{ uri: image }}
                    style={StyleSheet.absoluteFill}
                    contentFit="cover"
                    contentPosition="top"
                    transition={180}
                  />
                </View>
              )
              : <LetterMark accent={accent} />}
            <View style={[s.fmt, item.format === 'docx' && s.fmtDocx]}>
              <Text style={s.fmtTx}>{item.format === 'docx' ? 'DOC' : 'PDF'}</Text>
            </View>
          </View>

          <View style={s.rowMid}>
            <Text style={s.who} numberOfLines={1}>{who}</Text>
            <Text style={s.what} numberOfLines={1}>{item.templateName || 'Your design'}</Text>
            <View style={s.metaRow}>
              <Ionicons name="time-outline" size={11} color={E.textFaint} />
              <Text style={s.meta} numberOfLines={1}>
                {friendlyDate(item.downloadedAt)}
                {item.times > 1 ? `  ·  ${item.times} times` : ''}
              </Text>
            </View>
          </View>

          <View style={s.actionWrap}>
            {busy ? (
              <ActivityIndicator size="small" color={E.blueDeep} />
            ) : item.unlocked ? (
              <LinearGradient colors={[E.blue, E.purple]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.action}>
                <Ionicons name="arrow-down" size={16} color="#fff" />
              </LinearGradient>
            ) : (
              <View style={s.actionLocked}>
                <Ionicons name="lock-closed" size={14} color={E.textMuted} />
              </View>
            )}
          </View>
        </TouchableOpacity>
      </Glass>
    </Animated.View>
  );
}

export default function DownloadHistory({
  mode, items, loading, expanded, busyId, thumbFor, onAgain, onExpand, onMoreJobs,
}: {
  mode: 'resume' | 'letter';
  items: DownloadHistoryItem[];
  loading: boolean;
  expanded: boolean;
  /** The row currently being produced, so only that one shows a spinner. */
  busyId: number | null;
  /** An already-loaded page image for this design, or nothing. Never triggers a fetch. */
  thumbFor: (templateId: string) => string | null | undefined;
  onAgain: (it: DownloadHistoryItem) => void;
  onExpand: () => void;
  onMoreJobs: () => void;
}) {
  const shown = expanded ? items : items.slice(0, HISTORY_PREVIEW);
  const noun = mode === 'letter' ? 'cover letters' : 'resumes';

  const renderEmpty = useCallback(() => (
    <Glass style={s.empty}>
      <View style={s.emptyIcon}>
        <Ionicons name={mode === 'letter' ? 'mail-outline' : 'document-text-outline'} size={19} color={E.blueDeep} />
      </View>
      <Text style={s.emptyH}>Nothing downloaded yet</Text>
      <Text style={s.emptyTx}>
        {mode === 'letter'
          ? 'Cover letters you download will collect here, ready to send again.'
          : 'Resumes you download will collect here, so you can get them again on any phone.'}
      </Text>
    </Glass>
  ), [mode]);

  return (
    <View style={s.wrap}>
      <View style={s.head}>
        <View style={{ flex: 1 }}>
          <Text style={s.eyebrow}>Your library</Text>
          <Text style={s.title} numberOfLines={1}>
            {items.length ? `${items.length} ${items.length === 1 ? noun.slice(0, -1) : noun}, yours to keep` : `Your ${noun}`}
          </Text>
        </View>
        {/* The only affordance worth keeping from the section this replaced. */}
        <TouchableOpacity style={s.moreBtn} activeOpacity={0.8} onPress={onMoreJobs}>
          <Text style={s.moreTx}>More jobs </Text>
          <Ionicons name="arrow-forward" size={12} color={E.blueDeep} />
        </TouchableOpacity>
      </View>

      {loading && !items.length ? (
        <View style={s.skeletons}>
          {[0, 1, 2].map((i) => <View key={i} style={s.skeleton} />)}
        </View>
      ) : !items.length ? (
        renderEmpty()
      ) : (
        <View style={s.list}>
          {shown.map((it, i) => (
            <Row
              key={`${it.id}`}
              item={it}
              index={i}
              image={mode === 'letter' ? null : thumbFor(it.templateId)}
              busy={busyId === it.id}
              onAgain={onAgain}
            />
          ))}
          {!expanded && items.length > HISTORY_PREVIEW && (
            <TouchableOpacity style={s.seeAll} activeOpacity={0.8} onPress={onExpand}>
              <Text style={s.seeAllTx}>See all {items.length}</Text>
              <Ionicons name="chevron-down" size={14} color={E.blueDeep} />
            </TouchableOpacity>
          )}
          {mode === 'resume' && (
            // Said plainly because it is true and would otherwise surprise: there is one resume
            // record per person, so a design re-rendered today carries today's wording.
            <Text style={s.footnote}>Re-downloads use your latest resume in that design.</Text>
          )}
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { paddingHorizontal: 16, paddingTop: 24 },

  head: { flexDirection: 'row', alignItems: 'flex-end', gap: 10, marginBottom: 14 },
  eyebrow: { fontSize: 10.5, fontWeight: '800', letterSpacing: 1.4, color: E.textFaint, textTransform: 'uppercase' },
  title: { fontSize: 19, fontWeight: '800', color: E.ink, letterSpacing: -0.5, marginTop: 3, flexShrink: 1 },
  moreBtn: { flexDirection: 'row', alignItems: 'center', paddingBottom: 3 },
  moreTx: { fontSize: 12.5, fontWeight: '800', color: E.blueDeep, flexShrink: 1 },

  list: { gap: 10 },

  // ⚠️ The shadow lives on the OUTER view and the clipping on the INNER one. iOS drops a shadow
  // drawn on the same view as overflow:'hidden' — this exact trap has been hit three times here.
  glassOuter: {
    borderRadius: 20,
    shadowColor: '#0B0F22',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.07,
    shadowRadius: 18,
    elevation: 3,
  },
  glassClip: {
    borderRadius: 20,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.72)',
    backgroundColor: Platform.OS === 'ios' ? 'transparent' : 'rgba(255,255,255,0.96)',
  },
  glassBody: { backgroundColor: 'rgba(255,255,255,0.52)' },
  glassTopLight: { position: 'absolute', left: 0, right: 0, top: 0, height: 22 },

  row: {},
  rowInner: { flexDirection: 'row', alignItems: 'center', gap: 13, padding: 11 },

  markWrap: { width: MARK_W, height: MARK_H },
  markPage: {
    width: MARK_W, height: MARK_H, borderRadius: 7, overflow: 'hidden',
    backgroundColor: '#EEF2F8', borderWidth: 1, borderColor: 'rgba(11,15,34,0.07)',
  },
  markHead: { height: 15 },
  markLines: { paddingHorizontal: 6, paddingTop: 7, gap: 4 },
  markLine: { height: 2.5, borderRadius: 2, backgroundColor: 'rgba(11,15,34,0.13)' },
  fmt: {
    position: 'absolute', right: -5, bottom: -4,
    paddingHorizontal: 5, paddingVertical: 2, borderRadius: 5,
    backgroundColor: E.ink,
  },
  fmtDocx: { backgroundColor: E.blueDeep },
  fmtTx: { fontSize: 7.5, fontWeight: '900', color: '#fff', letterSpacing: 0.6 },

  rowMid: { flex: 1, minWidth: 0 },
  who: { fontSize: 15, fontWeight: '800', color: E.ink, letterSpacing: -0.3, flexShrink: 1 },
  what: { fontSize: 12, fontWeight: '600', color: E.textMuted, marginTop: 2, flexShrink: 1 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 5 },
  meta: { fontSize: 11, fontWeight: '600', color: E.textFaint, flexShrink: 1 },

  actionWrap: { width: 40, alignItems: 'flex-end' },
  action: { width: 34, height: 34, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  actionLocked: {
    width: 34, height: 34, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    backgroundColor: E.inputBg, borderWidth: 1, borderColor: E.border,
  },

  seeAll: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
    paddingVertical: 11, marginTop: 2,
  },
  seeAllTx: { fontSize: 13, fontWeight: '800', color: E.blueDeep, flexShrink: 1 },
  footnote: { fontSize: 11, fontWeight: '600', color: E.textFaint, textAlign: 'center', marginTop: 6, flexShrink: 1 },

  skeletons: { gap: 10 },
  skeleton: { height: 96, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.6)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.7)' },

  empty: { paddingVertical: 22, paddingHorizontal: 18, alignItems: 'center' },
  emptyIcon: {
    width: 40, height: 40, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(79,141,255,0.12)', marginBottom: 10,
  },
  emptyH: { fontSize: 15, fontWeight: '800', color: E.ink, flexShrink: 1 },
  emptyTx: { fontSize: 12.5, fontWeight: '600', color: E.textMuted, textAlign: 'center', marginTop: 5, lineHeight: 18, flexShrink: 1 },
});
