// First-run explainer — tells a new user what CVApplyr actually does, in 3 screens, BEFORE any setup.
// Additive + safe: a full-screen Modal shown once (AsyncStorage 'explainer_seen_v1'); pure StyleSheet.
import React, { useRef, useState } from 'react';
import { View, Text, StyleSheet, Modal, TouchableOpacity, ScrollView, Dimensions, StatusBar } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';

const { width } = Dimensions.get('window');

const SLIDES = [
  { icon: 'telescope', grad: ['#06B6D4', '#3B82F6'], title: 'Find the hidden jobs', body: 'Tell us the companies you want to work at. We surface their live openings — including roles that never hit the big job boards.' },
  { icon: 'mail-open', grad: ['#8B5CF6', '#3B82F6'], title: 'Reach the right person', body: 'For each role we find the hiring manager and their verified email — so your application lands in front of a human, not a black hole.' },
  { icon: 'rocket', grad: ['#06B6D4', '#10B981'], title: 'Apply in minutes', body: 'We write a tailored cover letter and help you apply — one tap. Or just browse thousands of live jobs right now, no setup needed.' },
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
      <LinearGradient colors={['#0B1120', '#0d1730']} style={styles.root}>
        <TouchableOpacity style={styles.skip} onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Text style={styles.skipText}>Skip</Text>
        </TouchableOpacity>

        <ScrollView
          ref={scroller} horizontal pagingEnabled showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={onScroll} scrollEventThrottle={16} style={{ flexGrow: 0 }}
        >
          {SLIDES.map((s, i) => (
            <View key={i} style={[styles.slide, { width }]}>
              <LinearGradient colors={s.grad} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.iconBadge}>
                <Ionicons name={s.icon} size={54} color="#fff" />
              </LinearGradient>
              <Text style={styles.title}>{s.title}</Text>
              <Text style={styles.body}>{s.body}</Text>
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
          {last && (
            <TouchableOpacity onPress={onClose} style={styles.secondary}>
              <Text style={styles.secondaryText}>Set up my profile first</Text>
            </TouchableOpacity>
          )}
        </View>
      </LinearGradient>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingTop: 54, paddingBottom: 36 },
  skip: { position: 'absolute', top: 52, right: 20, zIndex: 5, paddingVertical: 6, paddingHorizontal: 10 },
  skipText: { color: 'rgba(255,255,255,0.55)', fontSize: 14, fontWeight: '600' },
  slide: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 34, flex: 1 },
  iconBadge: { width: 118, height: 118, borderRadius: 32, alignItems: 'center', justifyContent: 'center', marginBottom: 40, shadowColor: '#06B6D4', shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.4, shadowRadius: 24, elevation: 10 },
  title: { color: '#fff', fontSize: 26, fontWeight: '800', letterSpacing: -0.5, textAlign: 'center', marginBottom: 14 },
  body: { color: 'rgba(255,255,255,0.68)', fontSize: 15.5, lineHeight: 23, textAlign: 'center', maxWidth: 340 },
  footer: { paddingHorizontal: 28 },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 8, marginBottom: 24 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.22)' },
  dotOn: { width: 22, backgroundColor: '#06B6D4' },
  cta: { borderRadius: 15, overflow: 'hidden' },
  ctaGrad: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 54 },
  ctaText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  secondary: { alignItems: 'center', paddingVertical: 14 },
  secondaryText: { color: 'rgba(255,255,255,0.6)', fontSize: 14, fontWeight: '600' },
});
