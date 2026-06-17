// AI Hub — new feature. Safe to delete without affecting existing app.
//
// Admin-only "Automated backend agent" dashboard for the self-improving employer
// fix loop. Lists every employer a user couldn't fetch, shows the agent's diagnosis
// (green = fixed & double-verified, red = failed, amber = pending/needs-review) along
// with the EXACT fix applied, and lets the admin:
//   • Investigate / re-run the agent ("rethink / revisit deeper")  → POST .../investigate
//   • View full version history and Roll back / Re-apply any version → POST .../activate
//   • Turn the fix off for a domain                                  → POST .../deactivate
// Backend enforces admin via authenticateAdmin.

import React, { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, SafeAreaView, Alert, RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import {
  adminListEmployerRequests, adminInvestigateRequest, adminOverrideHistory,
  adminActivateOverride, adminDeactivateOverride,
  type EmployerFixRequest, type EmployerFixOverride,
} from '../../services/aiHubService';

const STATUS = {
  resolved:      { color: '#34D399', bg: 'rgba(52,211,153,0.15)', label: 'FIXED', icon: 'checkmark-circle' as const },
  pending:       { color: '#FB923C', bg: 'rgba(251,146,60,0.15)', label: 'PENDING', icon: 'time' as const },
  investigating: { color: '#3B82F6', bg: 'rgba(59,130,246,0.15)', label: 'WORKING', icon: 'sync' as const },
  needs_review:  { color: '#FBBF24', bg: 'rgba(251,191,36,0.15)', label: 'NEEDS REVIEW', icon: 'alert-circle' as const },
  failed:        { color: '#FF4E64', bg: 'rgba(255,78,100,0.15)', label: 'FAILED', icon: 'close-circle' as const },
};
const statusOf = (s: string) => STATUS[s as keyof typeof STATUS] || STATUS.pending;

function fmtDate(iso?: string) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
}
function fixSummary(fc: any): string {
  if (!fc) return '—';
  if (fc.kind === 'careers_url') return `Scrape → ${fc.url}` + (fc.ats ? ` (${fc.ats})` : '');
  if (fc.kind === 'api') return `Hidden API → ${fc.apiUrl}`;
  if (fc.kind === 'jsonld') return `JSON-LD → ${fc.url}`;
  return JSON.stringify(fc);
}

export default function EmployerRequestsScreen() {
  const router = useRouter();
  const [rows, setRows] = useState<EmployerFixRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);          // request id being investigated
  const [history, setHistory] = useState<Record<number, EmployerFixOverride[]>>({});

  const load = useCallback(async () => {
    setError(null);
    try { setRows(await adminListEmployerRequests()); }
    catch (e: any) { setError(e?.response?.status === 403 ? 'Admin access required.' : 'Could not load requests.'); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useFocusEffect(useCallback(() => { setLoading(true); load(); }, [load]));

  const onRefresh = () => { setRefreshing(true); load(); };

  const investigate = async (r: EmployerFixRequest) => {
    setBusy(r.id);
    try {
      const result = await adminInvestigateRequest(r.id);
      await load();
      const ok = result?.verified;
      Alert.alert(
        ok ? '✅ Fixed & verified' : 'Not resolved',
        ok ? `${result.jobCount} jobs extracted and verified.\n\n${fixSummary(result.fixConfig)}`
           : `Status: ${result?.status || 'failed'}.\nThe agent could not extract verified jobs. Try "Investigate" again later or handle manually.`,
      );
    } catch (e: any) {
      Alert.alert('Error', e?.response?.data?.error || 'Investigation failed.');
    } finally { setBusy(null); }
  };

  const loadHistory = async (r: EmployerFixRequest) => {
    try { const { overrides } = await adminOverrideHistory(r.id); setHistory((h) => ({ ...h, [r.id]: overrides })); }
    catch { Alert.alert('Error', 'Could not load history.'); }
  };

  const rollback = (r: EmployerFixRequest, ov: EmployerFixOverride) => {
    Alert.alert('Apply this version?', `Make v${ov.version} the active fix for ${r.domain}?\n\n${fixSummary(ov.fixConfig)}`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Apply', onPress: async () => { try { await adminActivateOverride(ov.id); await load(); await loadHistory(r); } catch { Alert.alert('Error', 'Failed.'); } } },
    ]);
  };

  const deactivate = (r: EmployerFixRequest) => {
    Alert.alert('Turn off fix?', `Remove the active fix for ${r.domain}? Searches will use the default pipeline again. History is kept and can be re-applied.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Turn off', style: 'destructive', onPress: async () => { try { await adminDeactivateOverride(r.id); await load(); } catch { Alert.alert('Error', 'Failed.'); } } },
    ]);
  };

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Ionicons name="arrow-back" size={22} color="#fff" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.title}>Employer Fix Agent</Text>
          <Text style={s.subtitle}>Auto-diagnoses & fixes employers we couldn't fetch</Text>
        </View>
        <TouchableOpacity onPress={onRefresh} style={s.backBtn}><Ionicons name="refresh" size={20} color="#06B6D4" /></TouchableOpacity>
      </View>

      {loading ? (
        <View style={s.center}><ActivityIndicator color="#06B6D4" size="large" /></View>
      ) : error ? (
        <View style={s.center}><Text style={s.errTxt}>{error}</Text></View>
      ) : rows.length === 0 ? (
        <View style={s.center}>
          <Ionicons name="checkmark-done-circle-outline" size={48} color="#334155" />
          <Text style={s.emptyTxt}>No fix requests yet.</Text>
          <Text style={s.emptySub}>When a user can't fetch an employer, it shows up here.</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#06B6D4" />}
        >
          {rows.map((r) => {
            const st = statusOf(r.status);
            const isOpen = expanded === r.id;
            const steps: string[] = (r.diagnosis && r.diagnosis.steps) || [];
            const ov = r.activeOverride;
            const hist = history[r.id];
            return (
              <View key={r.id} style={s.card}>
                <TouchableOpacity activeOpacity={0.8} onPress={() => setExpanded(isOpen ? null : r.id)}>
                  <View style={s.cardTop}>
                    <View style={[s.badge, { backgroundColor: st.bg }]}>
                      <Ionicons name={st.icon} size={12} color={st.color} />
                      <Text style={[s.badgeTxt, { color: st.color }]}>{st.label}</Text>
                    </View>
                    {r.jobCount > 0 && <Text style={s.jobCount}>{r.jobCount} jobs</Text>}
                    <Ionicons name={isOpen ? 'chevron-up' : 'chevron-down'} size={18} color="#64748B" style={{ marginLeft: 'auto' }} />
                  </View>
                  <Text style={s.domain}>{r.domain || r.employerInput}</Text>
                  <Text style={s.meta}>
                    {r.detectedAts ? `${r.detectedAts} · ` : ''}{r.email || 'unknown'} · {fmtDate(r.createdAt)}
                    {r.attempts > 1 ? ` · ${r.attempts} attempts` : ''}
                  </Text>
                  {ov ? <Text style={s.fixLine} numberOfLines={1}>🟢 {fixSummary(ov.fixConfig)}</Text> : null}
                </TouchableOpacity>

                {isOpen && (
                  <View style={s.detail}>
                    <Text style={s.detailLabel}>INPUT</Text>
                    <Text style={s.detailVal}>{r.employerInput}</Text>

                    <Text style={s.detailLabel}>DIAGNOSIS</Text>
                    {steps.length ? steps.map((stp, i) => <Text key={i} style={s.step}>• {stp}</Text>)
                      : <Text style={s.detailVal}>{(r.diagnosis && r.diagnosis.note) || 'No diagnosis yet — run Investigate.'}</Text>}

                    {ov && (
                      <>
                        <Text style={s.detailLabel}>FIX APPLIED (v{ov.version}, verified {ov.verifyJobCount} jobs)</Text>
                        <Text style={s.detailVal}>{fixSummary(ov.fixConfig)}</Text>
                        {ov.verifySample && ov.verifySample.length > 0 && (
                          <Text style={s.sample}>e.g. {ov.verifySample.slice(0, 3).map((j: any) => j.title).join(' · ')}</Text>
                        )}
                      </>
                    )}

                    <View style={s.actions}>
                      <TouchableOpacity style={[s.actBtn, s.actPrimary]} disabled={busy === r.id} onPress={() => investigate(r)}>
                        {busy === r.id ? <ActivityIndicator color="#06B6D4" size="small" />
                          : <><Ionicons name="sparkles-outline" size={15} color="#06B6D4" /><Text style={s.actPrimaryTxt}>Investigate</Text></>}
                      </TouchableOpacity>
                      <TouchableOpacity style={s.actBtn} onPress={() => (hist ? setHistory((h) => { const c = { ...h }; delete c[r.id]; return c; }) : loadHistory(r))}>
                        <Ionicons name="git-branch-outline" size={15} color="#94A3B8" /><Text style={s.actTxt}>{hist ? 'Hide' : 'History'}</Text>
                      </TouchableOpacity>
                      {ov && (
                        <TouchableOpacity style={s.actBtn} onPress={() => deactivate(r)}>
                          <Ionicons name="power-outline" size={15} color="#FF4E64" /><Text style={[s.actTxt, { color: '#FF4E64' }]}>Turn off</Text>
                        </TouchableOpacity>
                      )}
                    </View>

                    {hist && (
                      <View style={s.history}>
                        <Text style={s.detailLabel}>VERSION HISTORY</Text>
                        {hist.length === 0 ? <Text style={s.detailVal}>No versions yet.</Text> : hist.map((h) => (
                          <View key={h.id} style={s.histRow}>
                            <View style={{ flex: 1 }}>
                              <Text style={s.histTitle}>v{h.version} {h.active ? '· ACTIVE' : ''} · {h.verifyJobCount} jobs · {h.createdBy}</Text>
                              <Text style={s.histSub} numberOfLines={1}>{fixSummary(h.fixConfig)}</Text>
                            </View>
                            {!h.active && (
                              <TouchableOpacity style={s.applyBtn} onPress={() => rollback(r, h)}>
                                <Text style={s.applyTxt}>Apply</Text>
                              </TouchableOpacity>
                            )}
                          </View>
                        ))}
                      </View>
                    )}
                  </View>
                )}
              </View>
            );
          })}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0B1120' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingTop: 8, paddingBottom: 14, gap: 10 },
  backBtn: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.06)' },
  title: { color: '#fff', fontSize: 19, fontWeight: '800', letterSpacing: -0.4 },
  subtitle: { color: 'rgba(255,255,255,0.45)', fontSize: 12, marginTop: 2 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 },
  errTxt: { color: '#FF4E64', fontSize: 14, textAlign: 'center' },
  emptyTxt: { color: '#94A3B8', fontSize: 15, fontWeight: '700', marginTop: 12 },
  emptySub: { color: '#475569', fontSize: 12, marginTop: 4, textAlign: 'center' },
  card: { backgroundColor: '#131C2E', borderRadius: 18, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)' },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  badgeTxt: { fontSize: 10, fontWeight: '800', letterSpacing: 0.4 },
  jobCount: { color: '#34D399', fontSize: 12, fontWeight: '700' },
  domain: { color: '#fff', fontSize: 16, fontWeight: '700' },
  meta: { color: '#64748B', fontSize: 12, marginTop: 3 },
  fixLine: { color: '#94A3B8', fontSize: 12, marginTop: 6 },
  detail: { marginTop: 12, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.06)', paddingTop: 12 },
  detailLabel: { color: '#475569', fontSize: 10, fontWeight: '800', letterSpacing: 0.6, marginTop: 10, marginBottom: 4 },
  detailVal: { color: '#CBD5E1', fontSize: 13 },
  step: { color: '#94A3B8', fontSize: 12, marginBottom: 2, lineHeight: 17 },
  sample: { color: '#64748B', fontSize: 11, marginTop: 4, fontStyle: 'italic' },
  actions: { flexDirection: 'row', gap: 8, marginTop: 14 },
  actBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.05)' },
  actPrimary: { backgroundColor: 'rgba(6,182,212,0.12)' },
  actPrimaryTxt: { color: '#06B6D4', fontSize: 13, fontWeight: '700' },
  actTxt: { color: '#94A3B8', fontSize: 13, fontWeight: '600' },
  history: { marginTop: 6 },
  histRow: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: 10, padding: 10, marginBottom: 6 },
  histTitle: { color: '#CBD5E1', fontSize: 12, fontWeight: '700' },
  histSub: { color: '#64748B', fontSize: 11, marginTop: 2 },
  applyBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, backgroundColor: 'rgba(6,182,212,0.15)' },
  applyTxt: { color: '#06B6D4', fontSize: 12, fontWeight: '700' },
});
