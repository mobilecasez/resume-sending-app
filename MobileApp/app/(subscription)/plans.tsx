// AI Hub — new feature. Safe to delete without affecting existing app.
//
// The plan catalog: the 7-day free trial and five monthly tiers. Store purchases are NOT wired
// yet (the subscription products must first exist in App Store Connect / Play Console) — tapping
// a plan explains that honestly. Admins can assign plans server-side for testing.
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { fetchSubscriptionStatus, type SubscriptionStatus, type Plan } from '../../services/subscriptionService';

const T = {
  bg: '#F0F4FA', card: '#FFFFFF', ink: '#0B0F22', muted: '#5B6B8A', faint: '#8896B0',
  line: 'rgba(11,15,34,0.06)', blue: '#2563EB', cyan: '#06B6D4', emerald: '#10B981',
};
// The middle tier is what most people should pick — flag it.
const POPULAR_KEY = 'plus';

export default function PlansScreen() {
  const [status, setStatus] = useState<SubscriptionStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try { setStatus(await fetchSubscriptionStatus()); } catch {} finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const choose = useCallback((p: Plan) => {
    // Honest until the store products exist: no fake purchase flow, no dead sheet.
    Alert.alert(
      `${p.label} — $${p.priceUsd.toFixed(2)}/month`,
      `${p.letters} cover letters + ${p.resumes} resume generations every month.\n\nSubscriptions are almost ready — purchasing opens in the next update. Your free trial and any credits keep working until then.`,
      [{ text: 'OK' }]
    );
  }, []);

  if (loading) return <View style={s.center}><ActivityIndicator size="large" color={T.blue} /></View>;

  const current = status?.subscription?.planKey || null;
  const trial = status?.trialState;
  const trialActive = !current && trial?.active;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: T.bg }} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
      {/* ── Trial card ── */}
      <View style={[s.trialCard, trialActive ? s.trialOn : null]}>
        <View style={s.trialHead}>
          <Ionicons name={trialActive ? 'checkmark-circle' : trial?.blocked ? 'close-circle-outline' : 'time-outline'} size={20} color={trialActive ? T.emerald : T.faint} />
          <Text style={s.trialTitle}>7-day free trial</Text>
        </View>
        <Text style={s.trialBody}>
          {trialActive
            ? `Active — ${Math.max(0, (status?.trial.letters || 5) - (trial?.used?.letters || 0))} cover letters and ${Math.max(0, (status?.trial.resumes || 2) - (trial?.used?.resumes || 0))} resume generations left.`
            : trial?.blocked === 'device_trial_used'
              ? 'This device has already used its free trial.'
              : 'Every new account starts with 5 cover letters + 2 resume generations, free for 7 days.'}
        </Text>
      </View>

      <Text style={s.freeNote}>
        <Ionicons name="gift-outline" size={13} color={T.emerald} />  Searching, fetching jobs, Auto Fill, translate, applying and downloads stay free on every plan.
      </Text>

      {/* ── Plans ── */}
      {(status?.plans || []).map((p) => {
        const isCurrent = current === p.key;
        const popular = p.key === POPULAR_KEY;
        return (
          <TouchableOpacity key={p.key} activeOpacity={0.9} onPress={() => choose(p)} style={[s.plan, popular && s.planPopular, isCurrent && s.planCurrent]}>
            {popular && (
              <LinearGradient colors={['#06B6D4', '#3B82F6']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={s.popularTag}>
                <Text style={s.popularText}>MOST POPULAR</Text>
              </LinearGradient>
            )}
            <View style={s.planRow}>
              <View style={{ flex: 1 }}>
                <Text style={s.planName}>{p.label}{isCurrent ? '  ·  current' : ''}</Text>
                <Text style={s.planQuota}>{p.letters} cover letters / month</Text>
                <Text style={s.planQuota}>{p.resumes} resume generations / month</Text>
              </View>
              <View style={s.priceBox}>
                <Text style={s.price}>${p.priceUsd.toFixed(2)}</Text>
                <Text style={s.per}>/month</Text>
              </View>
            </View>
          </TouchableOpacity>
        );
      })}

      <Text style={s.fine}>
        Deductions happen only after a generation succeeds — a failed attempt never counts. Full history in Plans & Usage.
      </Text>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: T.bg },
  trialCard: { backgroundColor: T.card, borderRadius: 18, borderWidth: 1, borderColor: T.line, padding: 15, marginBottom: 12 },
  trialOn: { borderColor: 'rgba(16,185,129,0.4)', backgroundColor: '#F2FDF8' },
  trialHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  trialTitle: { fontSize: 15, fontWeight: '800', color: T.ink },
  trialBody: { fontSize: 12.5, color: T.muted, lineHeight: 18 },
  freeNote: { fontSize: 12, color: '#047857', fontWeight: '600', lineHeight: 18, marginBottom: 14, marginLeft: 2 },

  plan: { backgroundColor: T.card, borderRadius: 20, borderWidth: 1.5, borderColor: T.line, padding: 16, marginBottom: 11, overflow: 'hidden' },
  planPopular: { borderColor: T.cyan },
  planCurrent: { borderColor: T.emerald, backgroundColor: '#F6FEFA' },
  popularTag: { position: 'absolute', top: 0, right: 0, borderBottomLeftRadius: 12, paddingHorizontal: 10, paddingVertical: 4 },
  popularText: { color: '#fff', fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  planRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  planName: { fontSize: 16.5, fontWeight: '800', color: T.ink, marginBottom: 5, letterSpacing: -0.2 },
  planQuota: { fontSize: 12.5, color: T.muted, fontWeight: '600', marginTop: 1 },
  priceBox: { alignItems: 'flex-end' },
  price: { fontSize: 21, fontWeight: '800', color: T.ink, letterSpacing: -0.5 },
  per: { fontSize: 11, color: T.faint, fontWeight: '600' },
  fine: { fontSize: 11, color: T.faint, lineHeight: 16, marginTop: 8, marginLeft: 2 },
});
