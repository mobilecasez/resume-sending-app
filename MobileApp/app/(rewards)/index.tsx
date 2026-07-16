// AI Hub — new feature. Safe to delete without affecting existing app.
// "Earn free credits" — store-safe reward centre: activation rewards (complete profile / first apply /
// rate the app) + referrals. Reads GET /api/rewards + /api/referral; rewards are auto-granted server-side
// the moment their condition is met, so this screen just reflects + celebrates them.
import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, SafeAreaView, Share, TextInput, Alert, Platform, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter, useFocusEffect } from 'expo-router';
import { fetchRewards, fetchReferral, claimReferral, type Reward, type ReferralInfo } from '../../services/rewardsService';
import RateAppModal from '../../components/RateAppModal';

const T = { bg: '#0B1120', card: '#111C33', ink: '#F1F5F9', mut: '#94A3B8', faint: '#64748B', border: 'rgba(255,255,255,0.08)', green: '#34D399', blue: '#3B82F6', cyan: '#06B6D4' };
const META: Record<string, { icon: any; color: string; hint?: string }> = {
  reward_complete_profile: { icon: 'person-circle-outline', color: '#22D3EE', hint: 'Upload your résumé in Account settings.' },
  reward_first_apply:      { icon: 'paper-plane-outline',  color: '#A78BFA', hint: 'Apply to a job from the Job Hub.' },
  reward_rate_app:         { icon: 'star',                  color: '#FBBF24' },
  reward_referral:         { icon: 'people',                color: '#34D399' },
};

export default function RewardsScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [balance, setBalance] = useState(0);
  const [totalEarned, setTotalEarned] = useState(0);
  const [referral, setReferral] = useState<ReferralInfo | null>(null);
  const [rateOpen, setRateOpen] = useState(false);
  const [codeInput, setCodeInput] = useState('');
  const [claiming, setClaiming] = useState(false);
  const [showClaim, setShowClaim] = useState(false);

  const load = useCallback(async () => {
    const [r, ref] = await Promise.all([fetchRewards(), fetchReferral()]);
    setRewards(r.rewards.filter((x) => x.key !== 'reward_referral')); setBalance(r.balance); setTotalEarned(r.totalEarned);
    setReferral(ref);
  }, []);

  useFocusEffect(useCallback(() => { let alive = true; (async () => { await load(); if (alive) setLoading(false); })(); return () => { alive = false; }; }, [load]));

  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);

  const shareInvite = async () => {
    if (!referral) return;
    try {
      await Share.share({
        message: `Get a head start on your job hunt with CVApplyr — AI finds jobs, writes your cover letters, and more. Use my code ${referral.code} when you sign up and we both earn free credits. ${referral.link}`,
      });
    } catch {}
  };

  const doClaim = async () => {
    const code = codeInput.trim().toUpperCase();
    if (!code || claiming) return;
    setClaiming(true);
    const r = await claimReferral(code);
    setClaiming(false);
    if (r.ok) { setShowClaim(false); setCodeInput(''); Alert.alert('Code applied ✓', 'When you complete your profile and apply to a job, your friend earns credits — thanks for joining!'); load(); }
    else {
      const msg = r.reason === 'already_referred' ? 'You’ve already used a referral code.'
        : r.reason === 'self' ? 'You can’t use your own code.'
        : r.reason === 'invalid_code' ? 'That code isn’t valid.' : 'Could not apply that code.';
      Alert.alert('Hmm', msg);
    }
  };

  if (loading) return <View style={[st.safe, { alignItems: 'center', justifyContent: 'center' }]}><ActivityIndicator color={T.cyan} size="large" /></View>;

  return (
    <SafeAreaView style={st.safe}>
      <View style={st.topBar}>
        <TouchableOpacity onPress={() => router.back()} style={st.backBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}><Ionicons name="chevron-back" size={22} color={T.ink} /></TouchableOpacity>
        <Text style={st.topTitle}>Earn free credits</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={T.cyan} />}>

        {/* Balance */}
        <LinearGradient colors={['#0F1635', '#131F45']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={st.balCard}>
          <Text style={st.balLabel}>YOUR CREDITS</Text>
          <Text style={st.balValue}>{balance}</Text>
          <Text style={st.balSub}>{totalEarned > 0 ? `${totalEarned} earned from rewards` : 'Complete the steps below to earn free credits'}</Text>
        </LinearGradient>

        {/* Ways to earn */}
        <Text style={st.section}>WAYS TO EARN</Text>
        {rewards.map((rw) => {
          const m = META[rw.key] || { icon: 'gift-outline', color: T.cyan };
          const isRate = rw.key === 'reward_rate_app';
          return (
            <View key={rw.key} style={[st.tile, rw.earned && st.tileEarned]}>
              <View style={[st.tileIcon, { backgroundColor: m.color + '22' }]}><Ionicons name={m.icon} size={20} color={m.color} /></View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={st.tileTitle}>{rw.label}</Text>
                <Text style={st.tileDesc} numberOfLines={2}>{rw.earned ? 'Earned — nice work!' : (m.hint || rw.description)}</Text>
              </View>
              {rw.earned ? (
                <View style={st.earnedPill}><Ionicons name="checkmark-circle" size={15} color={T.green} /><Text style={st.earnedTxt}>+{rw.amount}</Text></View>
              ) : isRate ? (
                <TouchableOpacity onPress={() => setRateOpen(true)} activeOpacity={0.85} style={st.ctaBtn}><Text style={st.ctaTxt}>Rate · +{rw.amount}</Text></TouchableOpacity>
              ) : (
                <View style={st.amtPill}><Text style={st.amtTxt}>+{rw.amount}</Text></View>
              )}
            </View>
          );
        })}

        {/* Referral */}
        {referral && (
          <>
            <Text style={st.section}>INVITE FRIENDS</Text>
            <View style={st.refCard}>
              <View style={st.refHead}>
                <View style={[st.tileIcon, { backgroundColor: T.green + '22' }]}><Ionicons name="people" size={20} color={T.green} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={st.tileTitle}>Refer a friend</Text>
                  <Text style={st.tileDesc}>Earn +{referral.creditsPerReferral} credits when a friend joins, completes their profile & applies.</Text>
                </View>
              </View>
              <View style={st.codeRow}>
                <View style={st.codeBox}><Text style={st.codeLabel}>YOUR CODE</Text><Text style={st.codeVal}>{referral.code}</Text></View>
                <TouchableOpacity onPress={shareInvite} activeOpacity={0.85} style={st.shareBtn}>
                  <LinearGradient colors={[T.cyan, T.blue]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={st.shareGrad}>
                    <Ionicons name="share-social" size={16} color="#fff" /><Text style={st.shareTxt}>Share invite</Text>
                  </LinearGradient>
                </TouchableOpacity>
              </View>
              <View style={st.refStats}>
                <View style={st.refStat}><Text style={st.refStatN}>{referral.invited}</Text><Text style={st.refStatL}>Invited</Text></View>
                <View style={st.refDivider} />
                <View style={st.refStat}><Text style={st.refStatN}>{referral.qualified}</Text><Text style={st.refStatL}>Joined & active</Text></View>
                <View style={st.refDivider} />
                <View style={st.refStat}><Text style={[st.refStatN, { color: T.green }]}>+{referral.qualified * referral.creditsPerReferral}</Text><Text style={st.refStatL}>Earned</Text></View>
              </View>
            </View>

            {/* Have a code? (for users who were invited) */}
            {!showClaim ? (
              <TouchableOpacity onPress={() => setShowClaim(true)} style={st.haveCode}><Text style={st.haveCodeTxt}>Have a referral code?</Text></TouchableOpacity>
            ) : (
              <View style={st.claimRow}>
                <TextInput value={codeInput} onChangeText={(t) => setCodeInput(t.toUpperCase())} placeholder="Enter code" placeholderTextColor={T.faint} autoCapitalize="characters" style={st.claimInput} maxLength={12} />
                <TouchableOpacity onPress={doClaim} disabled={claiming || !codeInput.trim()} style={[st.claimBtn, (claiming || !codeInput.trim()) && { opacity: 0.5 }]}>
                  {claiming ? <ActivityIndicator size="small" color="#fff" /> : <Text style={st.claimBtnTxt}>Apply</Text>}
                </TouchableOpacity>
              </View>
            )}
          </>
        )}

        <Text style={st.foot}>Credits are added automatically the moment you complete a step. Rating the app rewards you for your feedback — it never requires a public review.</Text>
      </ScrollView>

      <RateAppModal visible={rateOpen} onClose={() => { setRateOpen(false); load(); }} />
    </SafeAreaView>
  );
}

const st = StyleSheet.create({
  safe: { flex: 1, backgroundColor: T.bg },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingTop: Platform.OS === 'android' ? 28 : 6, paddingBottom: 8 },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  topTitle: { fontSize: 17, fontWeight: '800', color: T.ink, letterSpacing: -0.3 },
  balCard: { borderRadius: 22, padding: 20, borderWidth: 1, borderColor: T.border, marginBottom: 20 },
  balLabel: { fontSize: 10.5, fontWeight: '800', letterSpacing: 1.5, color: 'rgba(255,255,255,0.4)' },
  balValue: { fontSize: 44, fontWeight: '900', color: '#fff', letterSpacing: -1.5, marginTop: 4 },
  balSub: { fontSize: 13, color: T.mut, marginTop: 2 },
  section: { fontSize: 11, fontWeight: '800', letterSpacing: 1, color: T.faint, marginBottom: 10, marginLeft: 2 },
  tile: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: T.card, borderRadius: 16, borderWidth: 1, borderColor: T.border, padding: 14, marginBottom: 10 },
  tileEarned: { borderColor: 'rgba(52,211,153,0.35)', backgroundColor: 'rgba(52,211,153,0.06)' },
  tileIcon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  tileTitle: { fontSize: 15, fontWeight: '800', color: T.ink },
  tileDesc: { fontSize: 12, color: T.mut, marginTop: 2, lineHeight: 16 },
  earnedPill: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(52,211,153,0.14)', borderRadius: 100, paddingHorizontal: 10, paddingVertical: 6 },
  earnedTxt: { color: T.green, fontWeight: '800', fontSize: 13 },
  amtPill: { backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 100, paddingHorizontal: 12, paddingVertical: 6 },
  amtTxt: { color: T.ink, fontWeight: '800', fontSize: 13 },
  ctaBtn: { backgroundColor: '#FBBF24', borderRadius: 100, paddingHorizontal: 14, height: 34, alignItems: 'center', justifyContent: 'center' },
  ctaTxt: { color: '#1F2937', fontWeight: '800', fontSize: 12.5 },
  refCard: { backgroundColor: T.card, borderRadius: 18, borderWidth: 1, borderColor: T.border, padding: 16, marginBottom: 12 },
  refHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  codeRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 16 },
  codeBox: { flex: 1, borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)', borderStyle: 'dashed', borderRadius: 12, paddingVertical: 8, paddingHorizontal: 12 },
  codeLabel: { fontSize: 9.5, fontWeight: '800', letterSpacing: 1, color: T.faint },
  codeVal: { fontSize: 20, fontWeight: '900', color: '#fff', letterSpacing: 3, marginTop: 1 },
  shareBtn: { borderRadius: 12, overflow: 'hidden' },
  shareGrad: { flexDirection: 'row', alignItems: 'center', gap: 7, height: 48, paddingHorizontal: 16 },
  shareTxt: { color: '#fff', fontWeight: '800', fontSize: 13.5 },
  refStats: { flexDirection: 'row', alignItems: 'center', marginTop: 16, backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 12, paddingVertical: 12 },
  refStat: { flex: 1, alignItems: 'center' },
  refStatN: { fontSize: 18, fontWeight: '800', color: T.ink },
  refStatL: { fontSize: 10.5, color: T.faint, marginTop: 2, fontWeight: '600' },
  refDivider: { width: 1, height: 26, backgroundColor: T.border },
  haveCode: { alignItems: 'center', paddingVertical: 8 },
  haveCodeTxt: { color: T.cyan, fontWeight: '700', fontSize: 13 },
  claimRow: { flexDirection: 'row', gap: 10, marginTop: 4 },
  claimInput: { flex: 1, backgroundColor: T.card, borderWidth: 1, borderColor: T.border, borderRadius: 12, color: T.ink, fontSize: 15, fontWeight: '700', letterSpacing: 2, paddingHorizontal: 14, height: 48 },
  claimBtn: { backgroundColor: T.blue, borderRadius: 12, paddingHorizontal: 20, height: 48, alignItems: 'center', justifyContent: 'center' },
  claimBtnTxt: { color: '#fff', fontWeight: '800', fontSize: 14 },
  foot: { fontSize: 11.5, color: T.faint, lineHeight: 17, marginTop: 18, textAlign: 'center', paddingHorizontal: 8 },
});
