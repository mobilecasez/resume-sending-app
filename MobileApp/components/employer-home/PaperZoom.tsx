// AI Hub — new feature. Safe to delete without affecting existing app.
//
// Tap a page in the Home carousel and it grows into this — full-bleed, with the two things you can
// actually do with a design underneath it.
//
// ⚠️ THE TRANSITION IS MEASURED, NOT GUESSED. The card reports its real on-screen rectangle
// (measureInWindow) when it is tapped; this sheet renders the page at its FINAL size and position
// and then applies the inverse transform, so frame one is pixel-aligned with the little card the
// finger is still on and the spring carries it to full size. Animating width/height/left/top would
// have to run on the JS driver and would judder on a real device — the whole move here is
// translate + scale + opacity, native driver, which is also what the b126 one-driver rule requires.
//
// ⚠️ WHERE THE TWO BUTTONS GO (verified against the real screens, not assumed):
//   Customize → /(resume-builder)/preview   — the section list with per-card Edit controls.
//               It writes NOTHING to AsyncStorage. `resume_builder_entry {autoBuild}` and
//               `resumeBuilderAction` both arm a PAID regeneration, so neither is touched here.
//   View PDF  → /(resume-builder)/templates — the design view with pinch-zoom + PDF/DOCX download.
//               It takes a `template` param (added for this) so it opens on the design tapped.
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

export type OriginRect = { x: number; y: number; w: number; h: number };

const A4 = 424 / 300;

export default function PaperZoom({
  card, origin, subtitle, isPaid, sample, onClose, onCustomize, onViewPdf,
}: {
  /** null closes the sheet. */
  card: PaperCard | null;
  origin: OriginRect | null;
  subtitle?: string;
  /** Downloads are a paid-plan feature; say so here rather than at the download. */
  isPaid?: boolean;
  /** These pages are a stand-in, so there is nothing to customise or download yet. */
  sample?: boolean;
  onClose: () => void;
  onCustomize: () => void;
  onViewPdf: () => void;
}) {
  const insets = useSafeAreaInsets();
  const t = useRef(new Animated.Value(0)).current;
  const [frame, setFrame] = React.useState({ w: 0, h: 0 });
  const open = !!card;

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
  const chrome = insets.top + 54 + 116 + insets.bottom;   // buttons + the gating line under them
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
            <Text style={s.title} numberOfLines={1}>{card?.name || 'Your resume'}</Text>
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
                <Image source={{ uri: card.image }} style={s.img} contentFit="cover" transition={0} />
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
  title: { fontSize: 16, fontWeight: '800', color: '#fff', letterSpacing: -0.3 },
  sub: { fontSize: 11.5, fontWeight: '600', color: 'rgba(255,255,255,0.55)', marginTop: 2 },
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
