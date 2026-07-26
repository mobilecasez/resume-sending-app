// First-run explainer — a CENTERED POPUP (~75% of the screen) over a dimmed backdrop, showing what
// CVApplyr does via short recordings of the real app. Shown ONCE per user; dismissing it animates the
// popup into the floating help button so it is clear where the guide can be found again.
// Also exports TUTORIAL_SLIDES + <SlideCarousel/> so the in-app help assistant can replay the same
// guide ("View tutorial"). Additive + safe; pure StyleSheet.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Modal, TouchableOpacity, ScrollView, Image, Dimensions, StatusBar,
  Animated, Easing, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';

const { width: SW, height: SH } = Dimensions.get('window');
const CARD_W = Math.min(SW * 0.9, 440);
const CARD_H = Math.min(SH * 0.76, 720);

// Where the help assistant's floating button sits at rest. HelpAssistant positions its FAB from these
// SAME numbers — if the two ever drift apart the dismiss animation shrinks the popup into empty space
// and the one thing it is there to teach ("your guide lives in that button") is lost.
export const HELP_FAB = { size: 56, right: 16, bottom: Platform.OS === 'ios' ? 120 : 100 };

// Short screen recordings of the real app, with a ripple where each control is tapped, so the guide
// SHOWS the flow instead of describing it. Built by tools/build-guide-gifs.js from the clips in
// Videos/July 2026/Edited — re-run it (with --verify) if the UI changes.
export const TUTORIAL_SLIDES = [
  {
    img: require('../assets/onboarding/guide-profile.gif'),
    caption: 'Start with your profile',
    sub: 'Your details, r\u00e9sum\u00e9 and signature are filled in once — every application and cover letter after this uses them.',
  },
  {
    img: require('../assets/onboarding/guide-resume-builder.gif'),
    caption: 'Upload a r\u00e9sum\u00e9, or let the AI write one',
    sub: 'Paste your story or reuse the r\u00e9sum\u00e9 you uploaded. Pick a country format and download it as PDF or Word.',
  },
  {
    img: require('../assets/onboarding/guide-fetch-job.gif'),
    caption: 'Find a job on Google — save it in one tap',
    sub: 'Search the real Google inside the app. Open any result, tap the robot \u2192 Fetch job, and CVApplyr reads the posting and writes your cover letter.',
  },
  {
    img: require('../assets/onboarding/guide-auto-fill.gif'),
    caption: 'Apply with Auto Fill',
    sub: 'On the company\u2019s own form, tap the robot \u2192 Auto Fill. It reads the whole form, fills your details and attaches your r\u00e9sum\u00e9 — you review, then submit.',
  },
];

// Reusable swipeable carousel of the guide slides — used by the intro popup AND the help assistant's
// "View tutorial". `pageW` = page width; `imgH` = image height.
export function SlideCarousel({ slides = TUTORIAL_SLIDES, pageW, imgH = 360 }) {
  const w = pageW || Math.min(SW * 0.82, 380);
  const [page, setPage] = useState(0);
  const onScroll = (e) => { const i = Math.round(e.nativeEvent.contentOffset.x / w); if (i !== page) setPage(i); };
  return (
    <View>
      <ScrollView horizontal pagingEnabled showsHorizontalScrollIndicator={false} onMomentumScrollEnd={onScroll} scrollEventThrottle={16} style={{ flexGrow: 0 }}>
        {slides.map((s, i) => (
          <View key={i} style={{ width: w, height: imgH, alignItems: 'center', justifyContent: 'flex-start' }}>
            {s.caption ? (
              <View style={cs.capWrap}>
                <Text style={cs.caption}>{s.caption}</Text>
                {s.sub ? <Text style={cs.capSub}>{s.sub}</Text> : null}
              </View>
            ) : null}
            <Image source={s.img} style={{ flex: 1, width: w - 16 }} resizeMode="contain" />
          </View>
        ))}
      </ScrollView>
      <View style={cs.dots}>{slides.map((_, i) => <View key={i} style={[cs.dot, i === page && cs.dotOn]} />)}</View>
    </View>
  );
}

export default function WelcomeExplainer({ visible, onClose, onExplore }) {
  const [page, setPage] = useState(0);
  const scroller = useRef(null);
  const last = page >= TUTORIAL_SLIDES.length - 1;
  const IMG_H = CARD_H - 150;

  // ── Dismiss: the card shrinks and flies into the floating help button ──────────────────────────
  // Closing a first-run guide usually just deletes it, and the user never learns it can be reopened.
  // Sending it visibly INTO the help button answers "where did that go?" before it is asked.
  const fly = useRef(new Animated.Value(0)).current;   // 0 = card at rest, 1 = swallowed by the button
  const pop = useRef(new Animated.Value(0)).current;   // the button appearing to catch it
  const closing = useRef(false);
  const [box, setBox] = useState({ w: SW, h: SH });    // measured, so the flight lands on the real button
  useEffect(() => {
    if (visible) { closing.current = false; fly.setValue(0); pop.setValue(0); }
  }, [visible, fly, pop]);

  const dx = (box.w - HELP_FAB.right - HELP_FAB.size / 2) - box.w / 2;
  const dy = (box.h - HELP_FAB.bottom - HELP_FAB.size / 2) - box.h / 2;

  // `then` runs once the card has landed — the screen underneath only changes after the animation.
  const dismiss = useCallback((then) => {
    if (closing.current) return;
    closing.current = true;
    // The button appears as the card arrives. Started separately — and NOT awaited — so the handover
    // is timed by the flight (480ms), not by however long a spring takes to settle.
    // `delay` on the spring itself: Animated.delay runs on the JS driver, and mixing drivers inside
    // one sequence is a trap.
    Animated.spring(pop, { toValue: 1, delay: 230, friction: 6, tension: 140, useNativeDriver: true }).start();
    Animated.timing(fly, { toValue: 1, duration: 480, easing: Easing.in(Easing.cubic), useNativeDriver: true })
      .start(() => { (then || onClose)(); });
  }, [fly, pop, onClose]);

  const cardAnim = {
    opacity: fly.interpolate({ inputRange: [0, 0.7, 1], outputRange: [1, 0.9, 0] }),
    transform: [
      // translate BEFORE scale: the card's centre travels to the button's centre whatever the scale.
      { translateX: fly.interpolate({ inputRange: [0, 1], outputRange: [0, dx] }) },
      { translateY: fly.interpolate({ inputRange: [0, 1], outputRange: [0, dy] }) },
      { scale: fly.interpolate({ inputRange: [0, 1], outputRange: [1, 0.07] }) },
    ],
  };

  const goTo = (i) => { scroller.current?.scrollTo({ x: i * CARD_W, animated: true }); setPage(i); };
  const onScroll = (e) => { const i = Math.round(e.nativeEvent.contentOffset.x / CARD_W); if (i !== page) setPage(i); };

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={() => dismiss()}>
      <StatusBar barStyle="light-content" />
      <View
        style={styles.root}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          setBox((b) => (b.w === width && b.h === height ? b : { w: width, h: height }));
        }}
      >
        <Animated.View
          pointerEvents="none"
          style={[styles.backdropFill, { opacity: fly.interpolate({ inputRange: [0, 0.85, 1], outputRange: [1, 0.25, 0] }) }]}
        />
        <Animated.View style={[styles.card, { width: CARD_W, height: CARD_H }, cardAnim]}>
          <TouchableOpacity style={styles.skip} onPress={() => dismiss()} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Text style={styles.skipText}>Skip</Text>
          </TouchableOpacity>

          <ScrollView
            ref={scroller} horizontal pagingEnabled showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={onScroll} scrollEventThrottle={16} style={{ flexGrow: 0 }}
          >
            {TUTORIAL_SLIDES.map((s, i) => (
              <View key={i} style={[styles.slide, { width: CARD_W, height: IMG_H }]}>
                {s.caption ? (
                  <View style={styles.capWrap}>
                    <Text style={styles.captionAbs}>{s.caption}</Text>
                    {s.sub ? <Text style={styles.capSubAbs}>{s.sub}</Text> : null}
                  </View>
                ) : null}
                <View style={styles.slideMedia}>
                  <Image source={s.img} style={styles.slideImg} resizeMode="contain" />
                </View>
              </View>
            ))}
          </ScrollView>

          <View style={styles.footer}>
            <View style={styles.dots}>
              {TUTORIAL_SLIDES.map((_, i) => <View key={i} style={[styles.dot, i === page && styles.dotOn]} />)}
            </View>
            <TouchableOpacity activeOpacity={0.9} onPress={() => (last ? dismiss(onExplore || onClose) : goTo(page + 1))} style={styles.cta}>
              <LinearGradient colors={['#06B6D4', '#3B82F6']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.ctaGrad}>
                <Text style={styles.ctaText}>{last ? 'Explore jobs now' : 'Next'}</Text>
                <Ionicons name={last ? 'arrow-forward' : 'chevron-forward'} size={18} color="#fff" />
              </LinearGradient>
            </TouchableOpacity>
          </View>
        </Animated.View>

        {/* The help button, drawn where the real one will be, appearing just as the card reaches it —
            so the guide is seen going somewhere rather than simply disappearing. */}
        <Animated.View
          pointerEvents="none"
          style={[styles.ghost, {
            opacity: pop,
            transform: [{ scale: pop.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) }],
          }]}
        >
          <LinearGradient colors={['#06B6D4', '#3B82F6']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.ghostGrad}>
            <Ionicons name="sparkles" size={22} color="#fff" />
          </LinearGradient>
        </Animated.View>
      </View>
    </Modal>
  );
}

const cs = StyleSheet.create({
  capWrap: { alignItems: 'center', paddingHorizontal: 14, marginBottom: 4 },
  caption: { color: '#0B1120', fontSize: 17, fontWeight: '800', letterSpacing: -0.3, textAlign: 'center' },
  capSub: { color: '#5B6B8A', fontSize: 12, textAlign: 'center', marginTop: 5, lineHeight: 17 },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 7, marginTop: 10 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: 'rgba(11,17,32,0.16)' },
  dotOn: { width: 18, backgroundColor: '#06B6D4' },
});

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
  // A separate layer from the card so the dim can fade out while the card is still in flight.
  backdropFill: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(6,10,25,0.72)' },
  ghost: { position: 'absolute', right: HELP_FAB.right, bottom: HELP_FAB.bottom, width: HELP_FAB.size, height: HELP_FAB.size },
  ghostGrad: { width: HELP_FAB.size, height: HELP_FAB.size, borderRadius: HELP_FAB.size / 2, alignItems: 'center', justifyContent: 'center', shadowColor: '#2563EB', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.4, shadowRadius: 12, elevation: 8 },
  card: { backgroundColor: '#fff', borderRadius: 26, paddingTop: 44, paddingBottom: 18, overflow: 'hidden', shadowColor: '#000', shadowOffset: { width: 0, height: 20 }, shadowOpacity: 0.35, shadowRadius: 40, elevation: 20 },
  skip: { position: 'absolute', top: 12, right: 14, zIndex: 5, paddingVertical: 6, paddingHorizontal: 12, backgroundColor: 'rgba(11,17,32,0.05)', borderRadius: 100 },
  skipText: { color: '#5B6B8A', fontSize: 13, fontWeight: '700' },
  slide: { alignItems: 'center', justifyContent: 'flex-start', paddingHorizontal: 12 },
  capWrap: { paddingHorizontal: 8, paddingTop: 2, paddingBottom: 10, alignItems: 'center' },
  slideMedia: { flex: 1, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' },
  slideImg: { flex: 1, width: '100%' },
  capWrapAbs: { position: 'absolute', top: 4, left: 20, right: 20, zIndex: 2, alignItems: 'center' },
  captionAbs: { color: '#0B1120', fontSize: 19, fontWeight: '800', letterSpacing: -0.3, textAlign: 'center' },
  capSubAbs: { color: '#5B6B8A', fontSize: 12.5, textAlign: 'center', marginTop: 6, lineHeight: 18 },
  footer: { paddingHorizontal: 22, paddingTop: 6 },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 8, marginBottom: 14 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: 'rgba(11,17,32,0.16)' },
  dotOn: { width: 20, backgroundColor: '#06B6D4' },
  cta: { borderRadius: 15, overflow: 'hidden' },
  ctaGrad: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 52 },
  ctaText: { color: '#fff', fontSize: 16, fontWeight: '800' },
});
