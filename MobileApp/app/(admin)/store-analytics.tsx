// AI Hub — new feature. Safe to delete without affecting existing app.
//
// Admin-only NATIVE screen: App Store + Google Play downloads and recorded transactions.
// Pulls GET /api/admin/store-analytics (authenticateAdmin). Store download figures lag ~1 day.

import React, { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  SafeAreaView, RefreshControl, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import { fetchStoreAnalytics, runUninstallSweep, type StoreAnalytics } from '../../services/aiHubService';

const C = {
  bg: '#0B1120', panel: '#111A2E', line: '#22304D', text: '#E2E8F0', muted: '#94A3B8',
  cyan: '#06B6D4', blue: '#3B82F6', green: '#34D399', amber: '#FB923C', violet: '#A78BFA', red: '#F87171',
};
const n = (x?: number) => (x == null || isNaN(x) ? '0' : Number(x).toLocaleString());

function Bars({ data, k, color }: { data?: any[]; k: string; color: string }) {
  if (!data || !data.length) return <Text style={[s.muted, { marginTop: 10 }]}>No daily data yet.</Text>;
  const max = Math.max(1, ...data.map((d) => d[k] || 0));
  return (
    <View style={{ marginTop: 12 }}>
      <View style={s.chart}>
        {data.map((d, i) => (
          <View key={i} style={[s.bar, { height: Math.max(2, ((d[k] || 0) / max) * 60), backgroundColor: color }]} />
        ))}
      </View>
      <View style={s.chartAxis}>
        <Text style={s.axisLbl}>{data[0]?.date}</Text>
        <Text style={s.axisLbl}>{data[data.length - 1]?.date}</Text>
      </View>
    </View>
  );
}

function Kpi({ value, label, accent }: { value: string; label: string; accent?: string }) {
  return (
    <View style={s.kpi}>
      <Text style={[s.kpiV, accent ? { color: accent } : null]}>{value}</Text>
      <Text style={s.kpiL}>{label}</Text>
    </View>
  );
}

function Pill({ d }: { d: any }) {
  if (!d || d.configured === false) return <View style={[s.pill, s.pillSetup]}><Text style={[s.pillT, { color: C.amber }]}>needs setup</Text></View>;
  if (d.pending) return <View style={[s.pill, s.pillPending]}><Text style={[s.pillT, { color: C.violet }]}>warming up</Text></View>;
  return <View style={[s.pill, s.pillLive]}><Text style={[s.pillT, { color: C.green }]}>live</Text></View>;
}

export default function StoreAnalyticsScreen() {
  const router = useRouter();
  const [data, setData] = useState<StoreAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sweeping, setSweeping] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await fetchStoreAnalytics());
    } catch (e: any) {
      setError(e?.response?.status === 403 ? 'Admin access required.' : 'Could not load analytics. Pull to retry.');
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { setLoading(true); load(); }, [load]));

  const doSweep = useCallback(async () => {
    setSweeping(true);
    try {
      const r = await runUninstallSweep();
      Alert.alert('Uninstall sweep', `Checked ${r.checked} device${r.checked === 1 ? '' : 's'} · ${r.uninstalled} uninstall${r.uninstalled === 1 ? '' : 's'} detected.`);
      await load();
    } catch (e: any) {
      Alert.alert('Uninstall sweep', e?.response?.status === 403 ? 'Admin access required.' : 'Sweep failed — try again.');
    } finally {
      setSweeping(false);
    }
  }, [load]);

  const apple = data?.apple, google = data?.google, local = data?.local;
  const ios = apple?.configured && !apple?.pending ? (apple.totalDownloads || 0) : null;
  const android = google?.configured ? (google.totalInstalls || 0) : null;
  const total = (ios || 0) + (android || 0);
  let payers = 0; const rev: string[] = [];
  (local?.byPlatform || []).forEach((r) => { payers += r.paying_users || 0; rev.push(`${r.currency || ''} ${Math.round(Number(r.revenue) || 0).toLocaleString()}`.trim()); });

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="arrow-back" size={24} color={C.text} />
        </TouchableOpacity>
        <Text style={s.hTitle}>Store Analytics</Text>
        <TouchableOpacity onPress={() => { setRefreshing(true); load(); }} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="refresh" size={20} color={C.cyan} />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={s.center}><ActivityIndicator size="large" color={C.cyan} /><Text style={[s.muted, { marginTop: 12 }]}>Loading analytics…</Text></View>
      ) : error ? (
        <View style={s.center}><Ionicons name="alert-circle-outline" size={32} color={C.red} /><Text style={[s.muted, { marginTop: 8 }]}>{error}</Text></View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={C.cyan} />}
        >
          <Text style={s.note2}>Real-time activity from the app + store downloads. Store figures lag ~1 day; the Live Pulse is instant.</Text>

          {/* LIVE PULSE — real-time, from first-party app telemetry (no store delay) */}
          {data?.live ? (
            <View style={s.card}>
              <View style={s.cardHead}>
                <Text style={s.cardTitle}>🔴  Live Pulse</Text>
                <View style={[s.pill, s.pillLive]}><Text style={[s.pillT, { color: C.green }]}>real-time</Text></View>
              </View>
              <View style={[s.kpis, { marginTop: 6 }]}>
                <Kpi value={n(data.live.newInstalls?.last_24h)} label="New installs · 24h" accent={C.green} />
                <Kpi value={n(data.live.uninstalls?.last_24h)} label="Uninstalls · 24h" accent={C.red} />
                <Kpi value={n(data.live.netInstalls?.last_24h)} label="Net · 24h" accent={C.blue} />
                <Kpi value={n(data.live.activeNow?.total)} label="Active now · 30m" accent={C.green} />
              </View>
              {(data.live.newInstallsByPlatform || []).length > 0 ? (
                <Text style={s.cap}>installs (24h): {(data.live.newInstallsByPlatform || []).map((p) => `${p.platform} ${p.installs}`).join('   ·   ')}   ·   all-time {n(data.live.newInstalls?.all_time)}</Text>
              ) : null}
              {(data.live.uninstallsByPlatform || []).length > 0 ? (
                <Text style={s.cap}>uninstalls (24h): {(data.live.uninstallsByPlatform || []).map((p) => `${p.platform} ${p.uninstalls}`).join('   ·   ')}   ·   all-time {n(data.live.uninstalls?.all_time)}</Text>
              ) : null}
              {(data.live.activeNow?.byPlatform || []).length > 0 ? (
                <Text style={s.cap}>active now: {(data.live.activeNow?.byPlatform || []).map((p) => `${p.platform} ${p.users}`).join('   ·   ')}</Text>
              ) : null}
              <Bars data={data.live.hourly} k="users" color={C.violet} />
              {(data.live.topEvents || []).length > 0 ? (
                <>
                  <Text style={[s.cap, { marginTop: 12 }]}>Top events · 24h</Text>
                  {(data.live.topEvents || []).slice(0, 6).map((e, i) => (
                    <View key={i} style={s.txRow}><Text style={[s.txCell, { flex: 2 }]}>{e.event}</Text><Text style={[s.txCell, { textAlign: 'right' }]}>{n(e.n)}</Text></View>
                  ))}
                </>
              ) : null}
              {(data.live.recent || []).length > 0 ? (
                <>
                  <Text style={[s.cap, { marginTop: 12 }]}>Recent activity</Text>
                  {(data.live.recent || []).slice(0, 8).map((r, i) => (
                    <View key={i} style={s.txRow}>
                      <Text style={[s.txCell, { flex: 2 }]}>{r.event}</Text>
                      <Text style={s.txCell}>{r.platform}</Text>
                      <Text style={[s.txCell, { textAlign: 'right', color: C.muted }]}>{String(r.created_at || '').slice(11, 16)}</Text>
                    </View>
                  ))}
                </>
              ) : data.live.totalEvents === 0 ? (
                <Text style={s.info}>No app activity recorded yet — opens/foregrounds appear here the instant the app (with this build) is used. Reopen the app to see yourself appear live.</Text>
              ) : null}
            </View>
          ) : null}

          {/* LIFECYCLE & REVENUE — uninstalls + subscriptions/refunds/purchases from store webhooks */}
          {data?.live ? (
            <View style={s.card}>
              <View style={s.cardHead}>
                <Text style={s.cardTitle}>🔁  Lifecycle & Revenue</Text>
                <TouchableOpacity onPress={doSweep} disabled={sweeping} style={[s.pill, s.pillSetup]}>
                  {sweeping ? <ActivityIndicator size="small" color={C.amber} /> : <Text style={[s.pillT, { color: C.amber }]}>run uninstall sweep</Text>}
                </TouchableOpacity>
              </View>
              <View style={[s.kpis, { marginTop: 6 }]}>
                <Kpi value={n(data.live.uninstalls?.all_time)} label="Uninstalls · all" accent={C.red} />
                <Kpi value={n(data.live.netInstalls?.all_time)} label="Net installs · all" accent={C.blue} />
                <Kpi value={n(data.live.lifecycle?.subsNetEst)} label="Net subs (est)" />
                <Kpi value={n(data.live.lifecycle?.refunds?.d7)} label="Refunds · 7d" accent={C.amber} />
              </View>
              {(data.live.lifecycle?.events || []).length > 0 ? (
                <>
                  <Text style={[s.cap, { marginTop: 12 }]}>Store events (24h · 7d · all)</Text>
                  {(data.live.lifecycle?.events || []).slice(0, 10).map((e, i) => (
                    <View key={i} style={s.txRow}>
                      <Text style={[s.txCell, { flex: 2 }]}>{e.store === 'apple' ? '🍏' : '🤖'} {e.event}</Text>
                      <Text style={[s.txCell, { textAlign: 'right' }]}>{n(e.d1)} · {n(e.d7)} · {n(e.all_time)}</Text>
                    </View>
                  ))}
                </>
              ) : (
                <Text style={s.info}>No subscription/refund events yet. They appear in real time once Apple & Google's server notifications point at the webhook URLs (App Store Server Notifications V2 + Play RTDN). You sell one-time credits today, so subscription rows stay empty until you add subscriptions — the logging is ready either way.</Text>
              )}
              {(data.live.storeNotifications || []).length > 0 ? (
                <>
                  <Text style={[s.cap, { marginTop: 12 }]}>Recent store notifications</Text>
                  {(data.live.storeNotifications || []).slice(0, 8).map((r, i) => (
                    <View key={i} style={s.txRow}>
                      <Text style={[s.txCell, { flex: 2 }]}>{r.store === 'apple' ? '🍏' : '🤖'} {r.event || r.notification_type}</Text>
                      <Text style={s.txCell}>{r.price ? `${r.currency || ''} ${r.price}` : (r.product_id || '').slice(0, 14)}</Text>
                      <Text style={[s.txCell, { textAlign: 'right', color: C.muted }]}>{String(r.created_at || '').slice(5, 16).replace('T', ' ')}</Text>
                    </View>
                  ))}
                </>
              ) : null}
            </View>
          ) : null}

          {/* KPIs */}
          <View style={s.kpis}>
            <Kpi value={ios === null && android === null ? '—' : n(total)} label="Total downloads" accent={C.blue} />
            <Kpi value={ios === null ? 'setup' : n(ios)} label="iOS downloads" />
            <Kpi value={android === null ? 'setup' : n(android)} label="Android installs" />
            <Kpi value={n(payers)} label="Paying users" />
          </View>
          {rev.length > 0 && (
            <View style={[s.kpis, { marginTop: 0 }]}>
              {rev.map((r, i) => <Kpi key={i} value={r} label="Revenue" accent={C.green} />)}
            </View>
          )}

          {/* Apple */}
          <Text style={s.section}>Downloads by platform</Text>
          <View style={s.card}>
            <View style={s.cardHead}><Text style={s.cardTitle}>🍏  Apple App Store</Text><Pill d={apple} /></View>
            <Text style={s.cap}>iOS downloads</Text>
            {!apple || apple.configured === false ? (
              <Text style={s.warn}>{apple?.reason || 'Not configured.'}</Text>
            ) : apple.pending ? (
              <Text style={s.info}>{apple.note || 'Apple is preparing your downloads report (~1 day).'}</Text>
            ) : (
              <>
                <View style={s.subRow}>
                  <View style={s.subStat}><Text style={[s.subV, { color: C.cyan }]}>{n(apple.totalDownloads)}</Text><Text style={s.subL}>Total</Text></View>
                  <View style={s.subStat}><Text style={s.subV}>{n(apple.firstTime)}</Text><Text style={s.subL}>First-time</Text></View>
                  <View style={s.subStat}><Text style={s.subV}>{n(apple.redownloads)}</Text><Text style={s.subL}>Redownloads</Text></View>
                </View>
                <Bars data={apple.series} k="downloads" color={C.cyan} />
                {apple.report ? <Text style={s.src}>source: {apple.report}{apple.processingDate ? ` · ${apple.processingDate}` : ''}</Text> : null}
              </>
            )}
          </View>

          {/* Google */}
          <View style={s.card}>
            <View style={s.cardHead}><Text style={s.cardTitle}>🤖  Google Play</Text><Pill d={google} /></View>
            <Text style={s.cap}>Android installs</Text>
            {!google || google.configured === false ? (
              <Text style={s.warn}>{google?.reason || 'Not configured.'}</Text>
            ) : (
              <>
                <View style={s.subRow}>
                  <View style={s.subStat}><Text style={[s.subV, { color: C.green }]}>{n(google.totalInstalls)}</Text><Text style={s.subL}>Installs ({google.month || ''})</Text></View>
                  <View style={s.subStat}><Text style={[s.subV, { color: C.red }]}>{n(google.totalUninstalls)}</Text><Text style={s.subL}>Uninstalls</Text></View>
                  <View style={s.subStat}><Text style={[s.subV, { color: C.blue }]}>{n(google.netInstalls != null ? google.netInstalls : (google.totalInstalls || 0))}</Text><Text style={s.subL}>Net</Text></View>
                </View>
                {google.activeInstalls != null ? <Text style={s.cap}>active install base: {n(google.activeInstalls)}</Text> : null}
                <Bars data={google.series} k="installs" color={C.green} />
                {google.note ? <Text style={s.info}>{google.note}</Text> : null}
              </>
            )}
          </View>

          {/* Transactions */}
          <Text style={s.section}>Recorded transactions</Text>
          <View style={s.card}>
            <View style={s.kpis}>
              <Kpi value={n(local?.completedTxns?.last_24h)} label="Txns · 24h" />
              <Kpi value={n(local?.completedTxns?.last_7d)} label="Txns · 7d" />
              <Kpi value={n(local?.completedTxns?.last_30d)} label="Txns · 30d" />
              <Kpi value={n(local?.completedTxns?.all_time)} label="All time" />
              <Kpi value={n(local?.credits?.credits_sold)} label="Credits sold" />
            </View>
            {(local?.byPlatform || []).length > 0 && (
              <>
                <Text style={[s.cap, { marginTop: 14 }]}>Revenue by platform</Text>
                {(local!.byPlatform || []).map((r, i) => (
                  <View key={i} style={s.txRow}>
                    <Text style={[s.txCell, { flex: 1.2, textTransform: 'capitalize' }]}>{r.platform}</Text>
                    <Text style={s.txCell}>{n(r.txns)} txns</Text>
                    <Text style={s.txCell}>{n(r.paying_users)} users</Text>
                    <Text style={[s.txCell, { color: C.green, textAlign: 'right', flex: 1.2 }]}>{r.currency} {Math.round(Number(r.revenue) || 0).toLocaleString()}</Text>
                  </View>
                ))}
              </>
            )}
          </View>
          <Text style={s.src}>as of {String(data?.generatedAt || '').slice(0, 16).replace('T', ' ')} UTC</Text>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.line },
  hTitle: { fontSize: 18, fontWeight: '800', color: C.text, letterSpacing: -0.4 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  muted: { color: C.muted, fontSize: 13 },
  note2: { color: C.muted, fontSize: 12.5, lineHeight: 18, marginBottom: 14 },
  kpis: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -5, marginTop: 4 },
  kpi: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderRadius: 14, paddingVertical: 12, paddingHorizontal: 12, margin: 5, minWidth: 100, flexGrow: 1 },
  kpiV: { fontSize: 22, fontWeight: '800', color: C.text, letterSpacing: -0.5 },
  kpiL: { fontSize: 10.5, color: C.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 3 },
  section: { fontSize: 11, color: C.muted, textTransform: 'uppercase', letterSpacing: 1, marginTop: 22, marginBottom: 8 },
  card: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderRadius: 16, padding: 16, marginBottom: 12 },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardTitle: { fontSize: 14, fontWeight: '700', color: C.text },
  cap: { fontSize: 10.5, color: C.muted, textTransform: 'uppercase', letterSpacing: 1, marginTop: 10 },
  pill: { paddingVertical: 2, paddingHorizontal: 9, borderRadius: 999, borderWidth: 1 },
  pillT: { fontSize: 10, fontWeight: '800', letterSpacing: 0.3 },
  pillLive: { backgroundColor: 'rgba(52,211,153,0.12)', borderColor: 'rgba(52,211,153,0.35)' },
  pillPending: { backgroundColor: 'rgba(167,139,250,0.12)', borderColor: 'rgba(167,139,250,0.35)' },
  pillSetup: { backgroundColor: 'rgba(251,146,60,0.12)', borderColor: 'rgba(251,146,60,0.35)' },
  subRow: { flexDirection: 'row', marginTop: 10 },
  subStat: { marginRight: 22 },
  subV: { fontSize: 21, fontWeight: '800', color: C.text },
  subL: { fontSize: 10, color: C.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 1 },
  chart: { flexDirection: 'row', alignItems: 'flex-end', height: 64 },
  bar: { flex: 1, marginRight: 1.5, borderRadius: 1 },
  chartAxis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 3 },
  axisLbl: { fontSize: 9.5, color: C.muted },
  warn: { backgroundColor: 'rgba(251,146,60,0.10)', borderWidth: 1, borderColor: 'rgba(251,146,60,0.30)', color: '#FCD9B6', borderRadius: 12, padding: 12, fontSize: 12.5, lineHeight: 19, marginTop: 10 },
  info: { backgroundColor: 'rgba(167,139,250,0.10)', borderWidth: 1, borderColor: 'rgba(167,139,250,0.30)', color: '#D8CCFF', borderRadius: 12, padding: 12, fontSize: 12.5, lineHeight: 19, marginTop: 10 },
  src: { fontSize: 10.5, color: C.muted, marginTop: 8 },
  txRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: C.line },
  txCell: { flex: 1, fontSize: 12.5, color: C.text },
});
