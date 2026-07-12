// First-run explainer — shows what CVApplyr does using REAL app screenshots (search companies →
// live jobs → who's hiring → apply + AI cover letter → a real generated letter). Additive + safe:
// a full-screen Modal shown once (AsyncStorage 'explainer_seen_v1'); pure StyleSheet.
import React, { useRef, useState } from 'react';
import { View, Text, StyleSheet, Modal, TouchableOpacity, ScrollView, Image, Dimensions, StatusBar } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';

const { width } = Dimensions.get('window');

// The store screenshots already carry their own benefit caption; the cover-letter sample gets one.
const SLIDES = [
  { img: require('../assets/onboarding/slide-01.png') },   // "Search any company you want"
  { img: require('../assets/onboarding/slide-02.png') },   // "Live jobs from real careers pages"
  { img: require('../assets/onboarding/slide-03.png') },   // "Know exactly who is hiring"
  { img: require('../assets/onboarding/slide-04.png') },   // "Apply on portal or by email" (+ AI cover letter)
  { img: require('../assets/onboarding/cover-letter-sample.png'), caption: 'AI cover letters, tailored to each role & region', sub: 'Generated in seconds — download as PDF or edit before you apply.' },
];

export default function WelcomeExplainer({ visible, onClose, onExplore }) {
  const [page, setPage] = useState(0);
  const scroller = useRef(null);
  const last = page >= SLIDES.length - 1;

  const goTo = (i) => { scroller.current?.scrollTo({ x: i * width, animated: true }); setPage(i); };
  const onScroll = (e) => {
    const i = Math.round(e.nativeEvent.contentOffset.x / width);
    if (i !== page) setPage(i);
  };

  return (
    <Modal visible={visible} animationType="fade" onRequestClose={onClose}>
      <StatusBar barStyle="light-content" />
      <View style={styles.root}>
        <TouchableOpacity style={styles.skip} onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Text style={styles.skipText}>Skip</Text>
        </TouchableOpacity>

        <ScrollView
          ref={scroller} horizontal pagingEnabled showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={onScroll} scrollEventThrottle={16} style={styles.pager}
        >
          {SLIDES.map((s, i) => (
            <View key={i} style={[styles.slide, { width }]}>
              {s.caption ? (
                <View style={styles.capWrap}>
                  <Text style={styles.caption}>{s.caption}</Text>
                  {s.sub ? <Text style={styles.capSub}>{s.sub}</Text> : null}
                </View>
              ) : null}
              <Image source={s.img} style={styles.img} resizeMode="contain" />
            </View>
          ))}
        </ScrollView>

        <View style={styles.footer}>
          <View style={styles.dots}>
            {SLIDES.map((_, i) => (
              <View key={i} style={[styles.dot, i === page && styles.dotOn]} />
            ))}
          </View>
          <TouchableOpacity activeOpacity={0.9} onPress={() => (last ? (onExplore ? onExplore() : onClose()) : goTo(page + 1))} style={styles.cta}>
            <LinearGradient colors={['#06B6D4', '#3B82F6']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.ctaGrad}>
              <Text style={styles.ctaText}>{last ? 'Explore jobs now' : 'Next'}</Text>
              <Ionicons name={last ? 'arrow-forward' : 'chevron-forward'} size={18} color="#fff" />
            </LinearGradient>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0B1120', paddingTop: 44 },
  skip: { position: 'absolute', top: 52, right: 20, zIndex: 5, paddingVertical: 6, paddingHorizontal: 10 },
  skipText: { color: 'rgba(255,255,255,0.6)', fontSize: 14, fontWeight: '600' },
  pager: { flex: 1 },
  slide: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  img: { width: '100%', height: '100%' },
  capWrap: { position: 'absolute', top: 8, left: 24, right: 24, zIndex: 2, alignItems: 'center' },
  caption: { color: '#fff', fontSize: 24, fontWeight: '800', letterSpacing: -0.4, textAlign: 'center' },
  capSub: { color: 'rgba(255,255,255,0.66)', fontSize: 13.5, textAlign: 'center', marginTop: 8, maxWidth: 320, lineHeight: 20 },
  footer: { paddingHorizontal: 28, paddingBottom: 34, paddingTop: 10 },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 8, marginBottom: 18 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.22)' },
  dotOn: { width: 22, backgroundColor: '#06B6D4' },
  cta: { borderRadius: 15, overflow: 'hidden' },
  ctaGrad: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 54 },
  ctaText: { color: '#fff', fontSize: 16, fontWeight: '800' },
});
