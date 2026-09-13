// AI Hub — new feature. Safe to delete without affecting existing app.
//
// Tap a page in the Home carousel and it grows into this — full-bleed, with what you can actually do
// with that design underneath it, and how well it fits the employer when the design was ranked.
//
// ⚠️ THE TRANSITION IS MEASURED, NOT GUESSED. The card reports its real on-screen rectangle
// (measureInWindow) when it is tapped; this sheet renders the page at its FINAL size and position
// and then applies the inverse transform, so frame one is pixel-aligned with the little card the
// finger is still on and the spring carries it to full size. Animating width/height/left/top would
// have to run on the JS driver and would judder on a real device — the whole move here is
// translate + scale + opacity, native driver, which is also what the b126 one-driver rule requires.
//
// ⚠️ WHERE THE BUTTONS GO (verified against the real screens, not assumed). Home decides the
// routes; this sheet only says which actions a page HAS — and a resume page and a cover letter page
// have the SAME two (the product owner's call, 2026-09-13):
//   Customize → the document's own editor, never a generator.
//               A resume: /(resume-builder)/preview — the section list with per-card Edit controls.
//               With a saved employer document it carries that doc's id, so the edits land on THAT
//               employer's version and never on the base resume.
//               A cover letter: /(cover-letter)/edit — its subject and paragraphs, saved back to that
//               letter by id. (Until it existed a letter had no Customize at all: a button that landed
//               on a resume editor would have been a lie.)
//               It writes NOTHING to AsyncStorage. `resume_builder_entry {autoBuild}` and
//               `resumeBuilderAction` both arm a PAID regeneration, so neither is touched here.
//   View PDF  → the design gallery, opened on the design tapped — and the ONLY place a download happens.
//               A resume: /(resume-builder)/templates, pinch-zoom + PDF/DOCX download (it takes a
//               `template` param, added for this). A cover letter: the letter picker, on the saved letter.
// The same sheet opens from a card in Home's download library, with the same two buttons: a library card
// previews, it never downloads on the tap (EmployerHome.openHistoryItem).
import React, { useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, Animated, Modal, TouchableOpacity, ScrollView, Platform, Easing,
} from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { E } from './theme';
import { PaperCard } from './PaperCarousel';
import type { DocKind } from '../../services/homeAddEmployer';

export type OriginRect = { x: number; y: number; w: number; h: number };

const A4 = 424 / 300;

/** The fit tiers the carousel pill uses, so a design reads the same size of "good" in both places. */
function fitTone(fit: number): string {
  if (fit >= 85) return E.mint;
  if (fit >= 70) return '#8CB4FF';
  return 'rgba(255,255,255,0.62)';
}

export default function PaperZoom({
  card, origin, subtitle, isPaid, sample: sampleProp, kind = 'resume', fit, onClose, onCustomize, onViewPdf,
}: {
  /** null closes the sheet. */
  card: PaperCard | null;
  origin: OriginRect | null;
  subtitle?: string;
  /** Downloads are a paid-plan feature; say so here rather than at the download. */
  isPaid?: boolean;
  /** These pages are a stand-in, so there is nothing to customise or download yet. */
  sample?: boolean;
  /** Which document this page is. The words only — a resume and a cover letter get the same two actions. */
  kind?: DocKind;
  /** How well this design fits the employer (0-100). Defaults to the card's own fit; null hides it. */
  fit?: number | null;
  onClose: () => void;
  /** The document's editor: the resume's sections, or the letter's subject and paragraphs. */
  onCustomize: () => void;
  /** The primary action: the design gallery, where the download is. */
  onViewPdf: () => void;
}) {
  const insets = useSafeAreaInsets();
  const t = useRef(new Animated.Value(0)).current;
  const [frame, setFrame] = React.useState({ w: 0, h: 0 });
  const open = !!card;
  const letter = kind === 'cover_letter';
  const fitRaw = fit !== undefined ? fit : card?.fit;
  const fitPct = typeof fitRaw === 'number' && isFinite(fitRaw) ? Math.max(0, Math.min(100, Math.round(fitRaw))) : null;
  // A sample is a resume-only stand-in; a letter is never one.
  const sample = !!sampleProp && !letter;
  const reason = !sample && card?.reason ? String(card.reason) : '';

  useEffect(() => {
    if (!open) return;
    t.setValue(0);
    Animated.spring(t, { toValue: 1, useNativeDriver: true, damping: 22, stiffness: 210, mass: 0.9 }).start();
  }, [open, card?.id, t]);

  const close = () => {
    Animated.timing(t, { toValue: 0, duration: 190, easing: Easing.out(Easing.quad), useNativeDriver: true })
      .start(({ finished }) => { if (finished) onClose(); });
  };

  // Final page box: as big as the frame allows once the chrome above and below is taken out.
  // ⚠️ The "why it fits" line sits ABOVE the buttons, so its height comes out of the page, not out of
  // the buttons' room — otherwise the page is drawn underneath it.
  const chrome = insets.top + 54 + 116 + (reason ? 28 : 0) + insets.bottom;   // buttons + the gating line under them
  const maxH = Math.max(220, frame.h - chrome);
  const byW = frame.w - 40;
  const pageW = Math.min(byW, Math.round(maxH / A4));
  const pageH = Math.round(pageW * A4);
  const pageTop = insets.top + 54 + Math.max(0, (maxH - pageH) / 2);
  const pageLeft = Math.round((frame.w - pageW) / 2);

  // The inverse transform that puts frame one exactly on top of the card that was tapped.
  let scale0 = 0.3, tx0 = 0, ty0 = 0;
  if (origin && pageW > 0) {
    scale0 = origin.w / pageW;
    tx0 = origin.x + origin.w / 2 - (pageLeft + pageW / 2);
    ty0 = origin.y + origin.h / 2 - (pageTop + pageH / 2);
  }
  const lerp = (from: number, to: number) => t.interpolate({ inputRange: [0, 1], outputRange: [from, to] });

  return (
    <Modal visible={open} transparent animationType="none" onRequestClose={close} statusBarTranslucent>
      <View style={s.fill} onLayout={(e) => setFrame({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: t }]}>
          <LinearGradient colors={['rgba(4,6,16,0.96)', 'rgba(7,10,24,0.99)']} style={StyleSheet.absoluteFill} />
        </Animated.View>

        {/* tapping the ground closes — the page itself is left alone so it can be pinched */}
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={close} />

        <Animated.View style={[s.topBar, { paddingTop: insets.top + 6, opacity: t }]} pointerEvents="box-none">
          <View style={{ flex: 1 }}>
            <View style={s.titleRow}>
              <Text style={s.title} numberOfLines={1}>{card?.name || (letter ? 'Your cover letter' : 'Your resume')}</Text>
              {fitPct != null && !sample && (
                <View style={s.fitPill}>
                  <Text style={[s.fitTx, { color: fitTone(fitPct) }]} numberOfLines={1}>{fitPct}% fit</Text>
                </View>
              )}
            </View>
            {!!subtitle && <Text style={s.sub} numberOfLines={1}>{subtitle}</Text>}
          </View>
          <TouchableOpacity onPress={close} style={s.close} activeOpacity={0.85} accessibilityLabel="Close">
            <Ionicons name="close" size={20} color="#fff" />
          </TouchableOpacity>
        </Animated.View>

        {pageW > 0 && (
          <Animated.View
            style={[
              s.page,
              {
                left: pageLeft, top: pageTop, width: pageW, height: pageH,
                opacity: t.interpolate({ inputRange: [0, 0.12, 1], outputRange: [0, 1, 1] }),
                transform: [
                  { translateX: lerp(tx0, 0) },
                  { translateY: lerp(ty0, 0) },
                  { scale: lerp(scale0, 1) },
                ],
              },
            ]}
          >
            <ScrollView
              style={s.pageClip}
              maximumZoomScale={Platform.OS === 'ios' ? 3 : 1}
              minimumZoomScale={1}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{ width: pageW, height: pageH }}
            >
              {card?.image ? (
                <Image source={{ uri: card.image }} style={s.img} contentFit="cover" contentPosition="top" transition={0} />
              ) : (
                <View style={[s.img, { backgroundColor: '#EEF2F8' }]} />
              )}
            </ScrollView>
          </Animated.View>
        )}

        <Animated.View
          style={[
            s.actions,
            {
              paddingBottom: insets.bottom + 14,
              opacity: t,
              transform: [{ translateY: t.interpolate({ inputRange: [0, 1], outputRange: [26, 0] }) }],
            },
          ]}
        >
          {/* Why THIS design, for this employer — the ranking's own sentence, when it gave one. */}
          {!!reason && <Text style={s.reason} numberOfLines={1}>{reason}</Text>}
          {/* ⚠️ A sample has nothing behind it: Customize would land on the editor's "No resume data
              found" dead end and a download would produce the placeholder. One honest action. */}
          {sample ? (
            <TouchableOpacity style={s.primaryWrap} activeOpacity={0.9} onPress={() => { close(); setTimeout(onCustomize, 200); }}>
              <LinearGradient colors={[E.blue, E.purple]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.primary}>
                <Ionicons name="color-wand" size={17} color="#fff" />
                <Text style={s.primaryTx} numberOfLines={1}>Build my resume</Text>
              </LinearGradient>
            </TouchableOpacity>
          ) : (
            // A resume and a cover letter alike: edit the words, or look at the design (and download it there).
            <>
              <TouchableOpacity style={s.ghost} activeOpacity={0.85} onPress={() => { close(); setTimeout(onCustomize, 200); }}>
                <Ionicons name="create-outline" size={17} color="#fff" />
                <Text style={s.ghostTx} numberOfLines={1}>Customize</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.primaryWrap} activeOpacity={0.9} onPress={() => { close(); setTimeout(onViewPdf, 200); }}>
                <LinearGradient colors={[E.blue, E.purple]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.primary}>
                  <Ionicons name="document-text-outline" size={17} color="#fff" />
                  <Text style={s.primaryTx} numberOfLines={1}>View PDF</Text>
                </LinearGradient>
              </TouchableOpacity>
            </>
          )}
          <Text style={s.gate} numberOfLines={2}>
            {sample
              ? 'These pages are a sample — build yours to fill them with your details'
              : isPaid ? 'Every design free to preview · downloads are on your plan'
              : 'Every design free to preview · downloads are on paid plans'}
          </Text>
        </Animated.View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  topBar: {
    position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: 16, paddingBottom: 8,
    flexDirection: 'row', alignItems: 'center', gap: 12,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // flexShrink: a long design name gives way to the fit pill instead of pushing it off the bar
  title: { fontSize: 16, fontWeight: '800', color: '#fff', letterSpacing: -0.3, flexShrink: 1 },
  fitPill: {
    paddingHorizontal: 7, paddingVertical: 2.5, borderRadius: 100,
    backgroundColor: 'rgba(11,15,34,0.86)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)',
  },
  fitTx: { fontSize: 10.5, fontWeight: '800', letterSpacing: 0.2 },
  sub: { fontSize: 11.5, fontWeight: '600', color: 'rgba(255,255,255,0.55)', marginTop: 2 },
  reason: { width: '100%', textAlign: 'center', marginBottom: 2, fontSize: 12, fontWeight: '600', color: 'rgba(197,255,245,0.82)' },
  close: {
    width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    backgroundColor: E.glass, borderWidth: 1, borderColor: E.glassBorder,
  },
  // ⚠️ shadow on the outer view, clipping on the inner one — iOS drops a shadow drawn on the same
  // view as overflow:'hidden' (the bug that flattened the Home carousel on device).
  page: {
    position: 'absolute', borderRadius: 16, backgroundColor: '#fff',
    shadowColor: '#000', shadowOffset: { width: 0, height: 26 }, shadowOpacity: 0.55, shadowRadius: 44, elevation: 16,
  },
  pageClip: { flex: 1, borderRadius: 16, overflow: 'hidden' },
  img: { width: '100%', height: '100%' },
  actions: {
    position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 16, paddingTop: 12,
    flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'center',
  },
  gate: { width: '100%', textAlign: 'center', marginTop: 10, fontSize: 11, fontWeight: '600', color: 'rgba(255,255,255,0.5)' },
  ghost: {
    flex: 1, height: 52, borderRadius: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: E.glass, borderWidth: 1, borderColor: E.glassBorder,
  },
  ghostTx: { fontSize: 15, fontWeight: '700', color: '#fff', flexShrink: 1 },
  primaryWrap: { flex: 1, borderRadius: 16, shadowColor: E.blue, shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.4, shadowRadius: 24, elevation: 8 },
  primary: { height: 52, borderRadius: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, overflow: 'hidden' },
  primaryTx: { fontSize: 15, fontWeight: '800', color: '#fff', flexShrink: 1 },
});
