// AI Hub — new feature. Safe to delete without affecting existing app.
//
// DEDICATED "Rate this App" experience, opened on demand from a menu item.
//
// Sentiment-gate routing (compliant — reuses services/ratingService.ts):
//   • 👍 "Loving it"  → open the platform's NATIVE store review sheet (expo-store-review). The user
//                       posts their rating ONCE, there. (Apple & Google forbid pre-filling or posting
//                       a review programmatically, so this hand-off is the ONLY route to a public review.)
//   • 👎 "Not really" → reveal a private feedback box → saved to our backend (app_feedback). NEVER
//                       sent to the store; the user sees a "thanks for your feedback" confirmation.
//
// Why a gate instead of an in-app star + review form: the store sheet can't be pre-filled, so
// collecting stars/text here for happy users would just make them enter it twice. The gate sends
// happy users straight to the store (single entry) and keeps unhappy users' detail private.

import React, { useEffect, useRef, useState } from 'react';
import { Modal, View, Text, TouchableOpacity, TextInput, StyleSheet, ActivityIndicator, Image, Animated, Easing, TouchableWithoutFeedback, Keyboard, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { markRated, markHandled, openNativeReview, submitFeedback } from '../services/ratingService';

const TRIGGER = 'menu_rate_this_app';

export default function RateAppModal({
  visible, onClose,
}: { visible: boolean; onClose: () => void }) {
  const [mode, setMode] = useState<'ask' | 'feedback'>('ask');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [thanks, setThanks] = useState<'store' | 'feedback' | null>(null);
  const [earned, setEarned] = useState(0);   // credits granted for sharing feedback (rate-app reward)

  // Native-driven vertical shift so the card lifts SMOOTHLY above the keyboard. (KeyboardAvoidingView's
  // padding reflow re-lays-out the centered card on the JS thread → jerky.)
  const translateY = useRef(new Animated.Value(0)).current;

  // Reset to a clean state every time the modal is opened.
  useEffect(() => {
    if (visible) { setMode('ask'); setMsg(''); setBusy(false); setThanks(null); setEarned(0); translateY.setValue(0); }
  }, [visible]);

  // Drive the card's shift from the keyboard's own show/hide animation (same duration → in sync).
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const onShow = (e: any) => {
      const h = e?.endCoordinates?.height ?? 0;
      Animated.timing(translateY, { toValue: -Math.min(h / 2, 240), duration: e?.duration || 250, easing: Easing.out(Easing.ease), useNativeDriver: true }).start();
    };
    const onHide = (e: any) => {
      Animated.timing(translateY, { toValue: 0, duration: e?.duration || 250, easing: Easing.out(Easing.ease), useNativeDriver: true }).start();
    };
    const subShow = Keyboard.addListener(showEvt, onShow);
    const subHide = Keyboard.addListener(hideEvt, onHide);
    return () => { subShow.remove(); subHide.remove(); };
  }, [translateY]);

  // 👍 happy → straight to the native store review sheet (single entry, posted there).
  const onLove = async () => {
    if (busy) return;
    setBusy(true);
    const r = await submitFeedback(5, '', TRIGGER);   // record the positive sentiment (no text — they review on the store)
    setEarned(r?.reward?.credits || 0);
    await markRated();
    setBusy(false);
    setThanks('store');
    setTimeout(async () => { await openNativeReview(); onClose(); }, 1100);
  };

  // 👎 unhappy → private feedback only. Never routed to the store.
  const sendFeedback = async () => {
    const text = msg.trim();
    if (!text || busy) return;
    Keyboard.dismiss();
    setBusy(true);
    const r = await submitFeedback(2, text, TRIGGER);
    setEarned(r?.reward?.credits || 0);
    await markHandled();
    setBusy(false);
    setThanks('feedback');
    setTimeout(onClose, 1600);
  };

  const showThanks = thanks !== null;

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
      <View style={s.backdrop}>
        <Animated.View style={[s.card, { transform: [{ translateY }] }]}>
          {/* Close button (always-available entry, so allow dismissing without rating) */}
          {!showThanks && (
            <TouchableOpacity onPress={onClose} style={s.closeBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} activeOpacity={0.7}>
              <Ionicons name="close" size={20} color="#64748B" />
            </TouchableOpacity>
          )}

          <LinearGradient colors={['#06B6D4', '#3B82F6']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.iconWrap}>
            {showThanks
              ? <Ionicons name="checkmark" size={26} color="#fff" />
              : <Image source={require('../assets/images/logo_img_white.png')} style={s.brandLogo} resizeMode="contain" />}
          </LinearGradient>

          {/* ── ASK: sentiment gate ── */}
          {!showThanks && mode === 'ask' && (
            <>
              <Text style={s.title}>Enjoying <Text style={s.brandCv}>cv</Text><Text style={s.brandApplyr}>applyr</Text>?</Text>
              <Text style={s.subtitle}>Your feedback helps us make it better.</Text>
              <View style={s.choiceRow}>
                <TouchableOpacity onPress={() => setMode('feedback')} activeOpacity={0.85} style={[s.choiceBtn, s.choiceGhost]}>
                  <Ionicons name="thumbs-down-outline" size={16} color="#94A3B8" />
                  <Text style={s.choiceGhostText}>Not really</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={onLove} disabled={busy} activeOpacity={0.88} style={[s.choiceBtn, busy && s.btnDisabled]}>
                  <LinearGradient colors={['#06B6D4', '#3B82F6']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={s.choiceGrad}>
                    {busy ? <ActivityIndicator size="small" color="#fff" /> : (<><Ionicons name="thumbs-up" size={16} color="#fff" /><Text style={s.choiceText}>Loving it!</Text></>)}
                  </LinearGradient>
                </TouchableOpacity>
              </View>
            </>
          )}

          {/* ── FEEDBACK: private, never goes to the store ── */}
          {!showThanks && mode === 'feedback' && (
            <>
              <Text style={s.title}>What can we improve?</Text>
              <Text style={s.subtitle}>Sorry to hear that. Tell us what went wrong — this goes straight to our team, not the store.</Text>
              <TextInput
                style={s.input}
                value={msg}
                onChangeText={setMsg}
                placeholder="What's not working for you?…"
                placeholderTextColor="#64748B"
                multiline
                maxLength={1000}
                autoFocus
              />
              <TouchableOpacity onPress={sendFeedback} disabled={busy || msg.trim() === ''} activeOpacity={0.88} style={[s.btnOuter, (busy || msg.trim() === '') && s.btnDisabled]}>
                <LinearGradient colors={['#06B6D4', '#3B82F6']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={s.btn}>
                  {busy ? <ActivityIndicator size="small" color="#fff" /> : <Text style={s.btnText}>Send feedback</Text>}
                </LinearGradient>
              </TouchableOpacity>
            </>
          )}

          {thanks === 'store' && (
            <>
              <Text style={s.title}>Thank you! 🙌</Text>
              <Text style={s.subtitle}>Opening the App Store so you can post your rating…</Text>
              {earned > 0 && <View style={s.creditPill}><Ionicons name="sparkles" size={13} color="#34D399" /><Text style={s.creditPillText}>+{earned} credits added 🎉</Text></View>}
            </>
          )}

          {thanks === 'feedback' && (
            <>
              <Text style={s.title}>Thanks for your feedback</Text>
              <Text style={s.subtitle}>We really appreciate it — our team reads every message and uses it to improve the app.</Text>
              {earned > 0 && <View style={s.creditPill}><Ionicons name="sparkles" size={13} color="#34D399" /><Text style={s.creditPillText}>+{earned} credits added 🎉</Text></View>}
            </>
          )}
        </Animated.View>
      </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(2,6,23,0.72)', alignItems: 'center', justifyContent: 'center', padding: 28 },
  card: { width: '100%', maxWidth: 380, backgroundColor: '#0F1B30', borderRadius: 24, paddingTop: 30, paddingBottom: 24, paddingHorizontal: 22, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' },
  closeBtn: { position: 'absolute', top: 14, right: 14, zIndex: 2, padding: 4 },
  iconWrap: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  title: { fontSize: 20, fontWeight: '800', color: '#F8FAFC', textAlign: 'center' },
  brandLogo: { width: 32, height: 32 },
  brandCv: { color: '#F8FAFC', letterSpacing: 0.3 },
  brandApplyr: { color: '#3B82F6', letterSpacing: 0.3 },
  subtitle: { fontSize: 13.5, color: '#94A3B8', textAlign: 'center', marginTop: 8, lineHeight: 19, paddingHorizontal: 4 },
  choiceRow: { flexDirection: 'row', gap: 12, marginTop: 22, width: '100%' },
  choiceBtn: { flex: 1, borderRadius: 14, overflow: 'hidden' },
  choiceGhost: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, height: 50, borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)', backgroundColor: 'rgba(255,255,255,0.04)' },
  choiceGhostText: { color: '#CBD5E1', fontSize: 15, fontWeight: '700' },
  choiceGrad: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, height: 50 },
  choiceText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  input: { width: '100%', minHeight: 96, maxHeight: 160, backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)', color: '#F1F5F9', fontSize: 14, padding: 13, marginTop: 18, textAlignVertical: 'top' },
  btnOuter: { width: '100%', marginTop: 16, borderRadius: 14, overflow: 'hidden' },
  btnDisabled: { opacity: 0.5 },
  btn: { height: 50, alignItems: 'center', justifyContent: 'center', borderRadius: 14 },
  btnText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  creditPill: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 16, backgroundColor: 'rgba(52,211,153,0.12)', borderWidth: 1, borderColor: 'rgba(52,211,153,0.35)', borderRadius: 100, paddingHorizontal: 14, paddingVertical: 8 },
  creditPillText: { color: '#34D399', fontSize: 14, fontWeight: '800' },
});
