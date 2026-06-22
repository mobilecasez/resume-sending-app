// AI Hub — new feature. Safe to delete without affecting existing app.
//
// DEDICATED, always-available "Rate this App" experience (distinct from the auto-trigger
// RatingPromptModal which only fires on a frequency cap). This one is opened on demand
// from a menu item, so it ALWAYS shows the full UI: interactive 1–5 star selector, a
// multiline review box, and a Submit button.
//
// Compliant "review routing" — reuses services/ratingService.ts:
//   • 4–5★ → save the typed review privately (so it isn't lost) AND open the platform's
//            NATIVE store review sheet (expo-store-review); falls back to the store listing
//            deep-link if the native sheet isn't available.
//   • 1–3★ → save the rating + review to our private feedback backend (app_feedback). Never
//            sent to the store; user sees a "thanks for your feedback" confirmation.
//
// ⚠️ OS LIMITATION: Apple App Store and Google Play do NOT allow an app to pre-fill the
// native review sheet's star value or text, nor to post a review through any API. The
// native sheet alone controls what actually gets posted to the store. This custom UI only
// COLLECTS the user's intent (stars + text) and routes accordingly — it cannot transfer the
// stars/text the user typed here into the native sheet. The typed review is therefore also
// saved to our own backend so it is never lost.

import React, { useEffect, useState } from 'react';
import { Modal, View, Text, TouchableOpacity, TextInput, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { markRated, markHandled, openNativeReview, submitFeedback } from '../services/ratingService';

const TRIGGER = 'menu_rate_this_app';

export default function RateAppModal({
  visible, onClose,
}: { visible: boolean; onClose: () => void }) {
  const [stars, setStars] = useState(0);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [thanks, setThanks] = useState<'store' | 'feedback' | null>(null);

  // Reset to a clean state every time the modal is opened.
  useEffect(() => {
    if (visible) { setStars(0); setMsg(''); setBusy(false); setThanks(null); }
  }, [visible]);

  const submit = async () => {
    if (stars === 0 || busy) return;
    setBusy(true);
    const review = msg.trim();

    if (stars >= 4) {
      // Happy user. Persist the typed review privately (the native store sheet cannot be
      // pre-filled with it — OS limitation), mark as rated, then open the native review.
      await submitFeedback(stars, review, TRIGGER);
      await markRated();
      setBusy(false);
      setThanks('store');
      // Give the confirmation a beat, then hand off to the native store review sheet.
      setTimeout(async () => { await openNativeReview(); onClose(); }, 800);
    } else {
      // Unhappy user → private feedback only. Never routed to the store.
      await submitFeedback(stars, review, TRIGGER);
      await markHandled();
      setBusy(false);
      setThanks('feedback');
      setTimeout(onClose, 1300);
    }
  };

  const showThanks = thanks !== null;

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <View style={s.backdrop}>
        <View style={s.card}>
          {/* Close button (always-available entry, so allow dismissing without rating) */}
          {!showThanks && (
            <TouchableOpacity onPress={onClose} style={s.closeBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} activeOpacity={0.7}>
              <Ionicons name="close" size={20} color="#64748B" />
            </TouchableOpacity>
          )}

          <LinearGradient colors={['#06B6D4', '#3B82F6']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.iconWrap}>
            <Ionicons name={showThanks ? 'checkmark' : 'star'} size={26} color="#fff" />
          </LinearGradient>

          {!showThanks && (
            <>
              <Text style={s.title}>Rate CVApplyr</Text>
              <Text style={s.subtitle}>How would you rate your experience? Your feedback helps us improve.</Text>

              <View style={s.starsRow}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <TouchableOpacity
                    key={n}
                    onPress={() => setStars(n)}
                    activeOpacity={0.7}
                    hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                  >
                    <Ionicons
                      name={n <= stars ? 'star' : 'star-outline'}
                      size={38}
                      color={n <= stars ? '#FBBF24' : '#475569'}
                      style={s.star}
                    />
                  </TouchableOpacity>
                ))}
              </View>

              <TextInput
                style={s.input}
                value={msg}
                onChangeText={setMsg}
                placeholder="Write a review (optional)…"
                placeholderTextColor="#64748B"
                multiline
                maxLength={1000}
              />

              <TouchableOpacity onPress={submit} disabled={busy || stars === 0} activeOpacity={0.88} style={[s.btnOuter, (busy || stars === 0) && s.btnDisabled]}>
                <LinearGradient colors={['#06B6D4', '#3B82F6']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={s.btn}>
                  {busy ? <ActivityIndicator size="small" color="#fff" /> : <Text style={s.btnText}>Submit</Text>}
                </LinearGradient>
              </TouchableOpacity>
            </>
          )}

          {thanks === 'store' && (
            <>
              <Text style={s.title}>Thank you! 🙌</Text>
              <Text style={s.subtitle}>Opening the store so you can post your rating…</Text>
            </>
          )}

          {thanks === 'feedback' && (
            <>
              <Text style={s.title}>Thanks for your feedback</Text>
              <Text style={s.subtitle}>We really appreciate it — our team reads every message and uses it to improve the app.</Text>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(2,6,23,0.72)', alignItems: 'center', justifyContent: 'center', padding: 28 },
  card: { width: '100%', maxWidth: 380, backgroundColor: '#0F1B30', borderRadius: 24, paddingTop: 30, paddingBottom: 24, paddingHorizontal: 22, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' },
  closeBtn: { position: 'absolute', top: 14, right: 14, zIndex: 2, padding: 4 },
  iconWrap: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  title: { fontSize: 20, fontWeight: '800', color: '#F8FAFC', textAlign: 'center' },
  subtitle: { fontSize: 13.5, color: '#94A3B8', textAlign: 'center', marginTop: 8, lineHeight: 19, paddingHorizontal: 4 },
  starsRow: { flexDirection: 'row', gap: 6, marginTop: 20, marginBottom: 6 },
  star: { marginHorizontal: 3 },
  input: { width: '100%', minHeight: 96, maxHeight: 160, backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)', color: '#F1F5F9', fontSize: 14, padding: 13, marginTop: 18, textAlignVertical: 'top' },
  btnOuter: { width: '100%', marginTop: 16, borderRadius: 14, overflow: 'hidden' },
  btnDisabled: { opacity: 0.5 },
  btn: { height: 50, alignItems: 'center', justifyContent: 'center', borderRadius: 14 },
  btnText: { color: '#fff', fontSize: 15, fontWeight: '800' },
});
