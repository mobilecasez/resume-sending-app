// First-run explainer — a CENTERED POPUP (~75% of the screen) over a dimmed backdrop, showing what
// CVApplyr does via real store screenshots. Also exports TUTORIAL_SLIDES + <SlideCarousel/> so the
// in-app help assistant can replay the same guide ("View tutorial"). Additive + safe; pure StyleSheet.
import React, { useRef, useState } from 'react';
import { View, Text, StyleSheet, Modal, TouchableOpacity, ScrollView, Image, Dimensions, StatusBar } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';

const { width: SW, height: SH } = Dimensions.get('window');
const CARD_W = Math.min(SW * 0.9, 440);
const CARD_H = Math.min(SH * 0.76, 720);

export const TUTORIAL_SLIDES = [
  { img: require('../assets/onboarding/slide-01.png') },   // Search any company
  { img: require('../assets/onboarding/slide-02.png') },   // Live jobs
  { img: require('../assets/onboarding/slide-03.png') },   // Know who's hiring
  { img: require('../assets/onboarding/slide-04.png') },   // Apply on portal / email
  { img: require('../assets/onboarding/cover-letter-sample.png'), caption: 'AI cover letters, tailored to each role & region', sub: 'Generated in seconds — download as PDF or edit before you apply.' },
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
          <View key={i} style={{ width: w, alignItems: 'center', justifyContent: 'flex-start' }}>
            {s.caption ? (
              <View style={cs.capWrap}>
                <Text style={cs.caption}>{s.caption}</Text>
                {s.sub ? <Text style={cs.capSub}>{s.sub}</Text> : null}
              </View>
            ) : null}
            <Image source={s.img} style={{ width: w - 16, height: imgH - (s.caption ? 60 : 0) }} resizeMode="contain" />
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

  const goTo = (i) => { scroller.current?.scrollTo({ x: i * CARD_W, animated: true }); setPage(i); };
  const onScroll = (e) => { const i = Math.round(e.nativeEvent.contentOffset.x / CARD_W); if (i !== page) setPage(i); };

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <StatusBar barStyle="light-content" />
      <View style={styles.backdrop}>
        <View style={[styles.card, { width: CARD_W, height: CARD_H }]}>
          <TouchableOpacity style={styles.skip} onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Text style={styles.skipText}>Skip</Text>
          </TouchableOpacity>

          <ScrollView
            ref={scroller} horizontal pagingEnabled showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={onScroll} scrollEventThrottle={16} style={{ flexGrow: 0 }}
          >
            {TUTORIAL_SLIDES.map((s, i) => (
              <View key={i} style={[styles.slide, { width: CARD_W, height: IMG_H }]}>
                {s.caption ? (
                  <View style={styles.capWrapAbs}>
                    <Text style={styles.captionAbs}>{s.caption}</Text>
                    {s.sub ? <Text style={styles.capSubAbs}>{s.sub}</Text> : null}
                  </View>
                ) : null}
                <Image source={s.img} style={{ width: CARD_W - 24, height: IMG_H - (s.caption ? 66 : 8) }} resizeMode="contain" />
              </View>
            ))}
          </ScrollView>

          <View style={styles.footer}>
            <View style={styles.dots}>
              {TUTORIAL_SLIDES.map((_, i) => <View key={i} style={[styles.dot, i === page && styles.dotOn]} />)}
            </View>
            <TouchableOpacity activeOpacity={0.9} onPress={() => (last ? (onExplore ? onExplore() : onClose()) : goTo(page + 1))} style={styles.cta}>
              <LinearGradient colors={['#06B6D4', '#3B82F6']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.ctaGrad}>
                <Text style={styles.ctaText}>{last ? 'Explore jobs now' : 'Next'}</Text>
                <Ionicons name={last ? 'arrow-forward' : 'chevron-forward'} size={18} color="#fff" />
              </LinearGradient>
            </TouchableOpacity>
          </View>
        </View>
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
  backdrop: { flex: 1, backgroundColor: 'rgba(6,10,25,0.72)', alignItems: 'center', justifyContent: 'center', padding: 16 },
  card: { backgroundColor: '#fff', borderRadius: 26, paddingTop: 44, paddingBottom: 18, overflow: 'hidden', shadowColor: '#000', shadowOffset: { width: 0, height: 20 }, shadowOpacity: 0.35, shadowRadius: 40, elevation: 20 },
  skip: { position: 'absolute', top: 12, right: 14, zIndex: 5, paddingVertical: 6, paddingHorizontal: 12, backgroundColor: 'rgba(11,17,32,0.05)', borderRadius: 100 },
  skipText: { color: '#5B6B8A', fontSize: 13, fontWeight: '700' },
  slide: { alignItems: 'center', justifyContent: 'center' },
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
