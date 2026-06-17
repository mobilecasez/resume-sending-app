// AI Hub — new feature. Safe to delete without affecting existing app.
//
// Elegant, app-themed rating prompt. Tap a star (mandatory — no skip):
//   4–5★ → native store review sheet (only happy users reach the store)
//   1–3★ → private feedback form → our backend
// Use the useRatingPrompt() hook on a trigger screen, then render <RatingPromptModal/>.

import React, { useCallback, useEffect, useState } from 'react';
import { Modal, View, Text, TouchableOpacity, TextInput, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import {
  shouldAskForReview, recordAsked, markRated, markHandled, openNativeReview, submitFeedback,
} from '../services/ratingService';

export function useRatingPrompt() {
  const [trigger, setTrigger] = useState<string | null>(null);
  // Returns true if the prompt was shown (so a back-navigation can wait for it).
  const ask = useCallback(async (t: string): Promise<boolean> => {
    if (await shouldAskForReview()) { await recordAsked(); setTrigger(t); return true; }
    return false;
  }, []);
  const close = useCallback(() => setTrigger(null), []);
  return { trigger, ask, close };
}

export default function RatingPromptModal({
  visible, trigger, onClose,
}: { visible: boolean; trigger: string | null; onClose: () => void }) {
  const [step, setStep] = useState<'rate' | 'feedback' | 'thanks'>('rate');
  const [stars, setStars] = useState(0);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (visible) { setStep('rate'); setStars(0); setMsg(''); setBusy(false); } }, [visible]);

  const finish = () => onClose();

  const onStar = async (n: number) => {
    setStars(n);
    if (n >= 4) {
      await markRated();
      setStep('thanks');
      setTimeout(async () => { await openNativeReview(); finish(); }, 750);
    } else {
      setStep('feedback');
    }
  };

  const sendFeedback = async () => {
    setBusy(true);
    await submitFeedback(stars, msg.trim(), trigger || 'unknown');
    await markHandled();
    setBusy(false);
    setStep('thanks');
    setTimeout(finish, 1100);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={() => {}}>
      <View style={s.backdrop}>
        <View style={s.card}>
          <LinearGradient colors={['#06B6D4', '#3B82F6']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.iconWrap}>
            <Ionicons name={step === 'thanks' ? 'checkmark' : step === 'feedback' ? 'chatbubble-ellipses' : 'sparkles'} size={26} color="#fff" />
          </LinearGradient>

          {step === 'rate' && (
            <>
              <Text style={s.title}>Enjoying CVApplyr?</Text>
              <Text style={s.subtitle}>Tap a star to rate your experience — it helps us a lot.</Text>
              <View style={s.starsRow}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <TouchableOpacity key={n} onPress={() => onStar(n)} activeOpacity={0.7} hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}>
                    <Ionicons name={n <= stars ? 'star' : 'star-outline'} size={38} color={n <= stars ? '#FBBF24' : '#475569'} style={s.star} />
                  </TouchableOpacity>
                ))}
              </View>
            </>
          )}

          {step === 'feedback' && (
            <>
              <Text style={s.title}>Help us improve</Text>
              <Text style={s.subtitle}>Sorry it wasn't 5 stars. Tell us what to fix — this goes straight to our team.</Text>
              <TextInput
                style={s.input}
                value={msg}
                onChangeText={setMsg}
                placeholder="What can we do better?"
                placeholderTextColor="#64748B"
                multiline
                maxLength={1000}
                autoFocus
              />
              <TouchableOpacity onPress={sendFeedback} disabled={busy} activeOpacity={0.88} style={s.btnOuter}>
                <LinearGradient colors={['#06B6D4', '#3B82F6']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={s.btn}>
                  {busy ? <ActivityIndicator size="small" color="#fff" /> : <Text style={s.btnText}>Send feedback</Text>}
                </LinearGradient>
              </TouchableOpacity>
            </>
          )}

          {step === 'thanks' && (
            <>
              <Text style={s.title}>Thank you! 🙌</Text>
              <Text style={s.subtitle}>{stars >= 4 ? 'Opening the store so you can post your rating…' : 'We really appreciate your feedback.'}</Text>
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
  iconWrap: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  title: { fontSize: 20, fontWeight: '800', color: '#F8FAFC', textAlign: 'center' },
  subtitle: { fontSize: 13.5, color: '#94A3B8', textAlign: 'center', marginTop: 8, lineHeight: 19, paddingHorizontal: 4 },
  starsRow: { flexDirection: 'row', gap: 6, marginTop: 20, marginBottom: 6 },
  star: { marginHorizontal: 3 },
  input: { width: '100%', minHeight: 96, maxHeight: 160, backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)', color: '#F1F5F9', fontSize: 14, padding: 13, marginTop: 18, textAlignVertical: 'top' },
  btnOuter: { width: '100%', marginTop: 16, borderRadius: 14, overflow: 'hidden' },
  btn: { height: 50, alignItems: 'center', justifyContent: 'center', borderRadius: 14 },
  btnText: { color: '#fff', fontSize: 15, fontWeight: '800' },
});
