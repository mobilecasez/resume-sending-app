// AI Hub — new feature. Safe to delete without affecting existing app.
//
// Plans & Usage — the user's entitlement picture in one place: current plan (or trial), what's
// left this period, and the DETAILED ledger: every deduction with what it was for, when, and
// which pool paid it (trial / plan / legacy credits). Deductions happen only after a successful
// generation, so every row here corresponds to a letter or resume the user actually received.
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import {
  fetchSubscriptionStatus, fetchUsage, type SubscriptionStatus, type UsageItem,
} from '../../services/subscriptionService';

const T = {
  bg: '#F0F4FA', card: '#FFFFFF', ink: '#0B0F22', muted: '#5B6B8A', faint: '#8896B0',
  line: 'rgba(11,15,34,0.06)', blue: '#2563EB', cyan: '#06B6D4', emerald: '#10B981', amber: '#D97706',
};

const SOURCE_META: Record<string, { label: string; color: string }> = {
  trial: { label: 'Free trial', color: T.cyan },
  plan: { label: 'Plan', color: T.emerald },
  credits: { label: 'Credits', color: T.amber },
};

const when = (iso: string) => {
  try { return new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
};

function QuotaBar({ label, used, total, color }: { label: string; used: number; total: number; color: string }) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  return (
    <View style={s.quota}>
      <View style={s.quotaHead}>
        <Text style={s.quotaLabel}>{label}</Text>
        <Text style={s.quotaNum}>{Math.max(0, total - used)} left <Text style={s.quotaOf}>of {total}</Text></Text>
      </View>
      <View style={s.track}><View style={[s.fill, { width: `${pct}%`, backgroundColor: color }]} /></View>
    </View>
  );
}

export default function UsageScreen() {
  const router = useRouter();
  const [status, setStatus] = useState<SubscriptionStatus | null>(null);
  const [items, setItems] = useState<UsageItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [st, us] = await Promise.all([fetchSubscriptionStatus(), fetchUsage(150)]);
      setStatus(st); setItems(us); setError(null);
    } catch (e: any) {
      setError(e?.message || 'Could not load your plan');
    } finally { setLoading(false); setRefreshing(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (loading) return <View style={s.center}><ActivityIndicator size="large" color={T.blue} /></View>;

  const sub = status?.subscription;
  const trial = status?.trialState;
  const trialActive = !sub && trial?.active;
  const quotaTotals = sub
    ? status!.plans.find((p) => p.key === sub.planKey)
    : (trialActive ? status!.trial : null);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: T.bg }}
      contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={T.blue} />}
    >
      {error ? (
        <View style={s.errBox}><Ionicons name="cloud-offline-outline" size={16} color={T.faint} /><Text style={s.errText}>{error}</Text></View>
      ) : null}

      {/* ── Current plan card ── */}
      <View style={s.planCard}>
        <LinearGradient colors={['#0B0F22', '#0F1635', '#0B0F22']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFillObject} />
        <View style={s.planHead}>
          <View style={{ flex: 1 }}>
            <Text style={s.planEyebrow}>{sub ? 'CURRENT PLAN' : trialActive ? 'FREE TRIAL' : 'NO ACTIVE PLAN'}</Text>
            <Text style={s.planName}>
              {sub ? sub.label : trialActive ? '7-day free trial' : trial?.blocked === 'device_trial_used' ? 'Trial already used on this device' : 'Trial ended'}
            </Text>
            {sub ? <Text style={s.planSub}>Renews {when(sub.periodEnd)}</Text>
              : trialActive && trial?.endsAt ? <Text style={s.planSub}>Ends {when(trial.endsAt)}</Text>
              : <Text style={s.planSub}>Pick a plan to keep generating</Text>}
          </View>
          <Ionicons name={sub ? 'diamond-outline' : trialActive ? 'time-outline' : 'lock-closed-outline'} size={26} color="#22D3EE" />
        </View>
        {quotaTotals ? (
          <>
            <QuotaBar label="Cover letters" used={status!.used.letters} total={quotaTotals.letters} color="#22D3EE" />
            <QuotaBar label="Resume generations" used={status!.used.resumes} total={quotaTotals.resumes} color="#A78BFA" />
          </>
        ) : null}
        {typeof status?.legacyCredits === 'number' && status.legacyCredits > 0 && (
          <Text style={s.legacy}>+ {status.legacyCredits} legacy credits (still usable as backup)</Text>
        )}
        <TouchableOpacity style={s.plansBtn} activeOpacity={0.9} onPress={() => router.push('/(subscription)/plans' as never)}>
          <Text style={s.plansBtnText}>{sub ? 'Change plan' : 'See plans'}</Text>
          <Ionicons name="arrow-forward" size={15} color="#0B0F22" />
        </TouchableOpacity>
      </View>

      {/* ── What's free ── */}
      <View style={s.freeRow}>
        <Ionicons name="gift-outline" size={15} color={T.emerald} />
        <Text style={s.freeText}>Job search, fetching jobs, Auto Fill, translate, applying and downloads are all free — plans only count cover letters and resume generations.</Text>
      </View>

      {/* ── Ledger ── */}
      <Text style={s.sectionTitle}>Usage history</Text>
      {items.length === 0 ? (
        <View style={s.empty}><Ionicons name="receipt-outline" size={34} color={T.faint} /><Text style={s.emptyText}>Nothing used yet — deductions appear here only after a successful generation.</Text></View>
      ) : items.map((it) => {
        const src = SOURCE_META[it.source] || SOURCE_META.credits;
        const isLetter = it.kind === 'cover_letter';
        const title = isLetter
          ? (it.detail?.position ? `${it.detail.position}` : 'Cover letter')
          : (it.detail?.name ? `Resume — ${it.detail.name}` : 'Resume generation');
        const sub2 = isLetter ? (it.detail?.companyName || it.detail?.recipientEmail || '') : '';
        return (
          <View key={it.id} style={s.row}>
            <View style={[s.rowIcon, { backgroundColor: isLetter ? 'rgba(6,182,212,0.12)' : 'rgba(167,139,250,0.14)' }]}>
              <Ionicons name={isLetter ? 'mail-outline' : 'document-text-outline'} size={16} color={isLetter ? T.cyan : '#7C6BFF'} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={s.rowTitle} numberOfLines={1}>{title}</Text>
              {!!sub2 && <Text style={s.rowSub} numberOfLines={1}>{sub2}</Text>}
              <Text style={s.rowWhen}>{when(it.createdAt)}</Text>
            </View>
            <View style={[s.srcPill, { backgroundColor: src.color + '18', borderColor: src.color + '44' }]}>
              <Text style={[s.srcText, { color: src.color }]}>{src.label}</Text>
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: T.bg },
  errBox: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#FEF3F2', borderRadius: 12, padding: 12, marginBottom: 12 },
  errText: { flex: 1, fontSize: 12.5, color: '#B42318', fontWeight: '600' },

  planCard: { borderRadius: 24, overflow: 'hidden', padding: 18, marginBottom: 14 },
  planHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 14 },
  planEyebrow: { color: '#22D3EE', fontSize: 10, fontWeight: '800', letterSpacing: 1.4 },
  planName: { color: '#FFFFFF', fontSize: 20, fontWeight: '800', marginTop: 4, letterSpacing: -0.3 },
  planSub: { color: 'rgba(255,255,255,0.6)', fontSize: 12, marginTop: 3, fontWeight: '600' },
  quota: { marginBottom: 11 },
  quotaHead: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 5 },
  quotaLabel: { color: 'rgba(255,255,255,0.8)', fontSize: 12.5, fontWeight: '700' },
  quotaNum: { color: '#FFFFFF', fontSize: 12.5, fontWeight: '800' },
  quotaOf: { color: 'rgba(255,255,255,0.5)', fontWeight: '600' },
  track: { height: 7, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.12)', overflow: 'hidden' },
  fill: { height: 7, borderRadius: 4 },
  legacy: { color: 'rgba(255,255,255,0.55)', fontSize: 11.5, fontWeight: '600', marginTop: 2 },
  plansBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, backgroundColor: '#22D3EE', borderRadius: 14, height: 46, marginTop: 12 },
  plansBtnText: { color: '#0B0F22', fontSize: 14.5, fontWeight: '800' },

  freeRow: { flexDirection: 'row', gap: 9, alignItems: 'flex-start', backgroundColor: '#ECFDF5', borderRadius: 14, borderWidth: 1, borderColor: '#BBF0DB', padding: 12, marginBottom: 18 },
  freeText: { flex: 1, fontSize: 12, color: '#047857', fontWeight: '600', lineHeight: 17 },

  sectionTitle: { fontSize: 15, fontWeight: '800', color: T.ink, marginBottom: 10, letterSpacing: -0.2 },
  empty: { alignItems: 'center', gap: 10, padding: 30 },
  emptyText: { fontSize: 12.5, color: T.faint, textAlign: 'center', lineHeight: 18 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 11, backgroundColor: T.card, borderRadius: 16, borderWidth: 1, borderColor: T.line, padding: 12, marginBottom: 9 },
  rowIcon: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  rowTitle: { fontSize: 13.5, fontWeight: '800', color: T.ink },
  rowSub: { fontSize: 12, color: T.muted, marginTop: 1 },
  rowWhen: { fontSize: 10.5, color: T.faint, marginTop: 3, fontWeight: '600' },
  srcPill: { borderRadius: 9, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 3 },
  srcText: { fontSize: 10, fontWeight: '800' },
});
