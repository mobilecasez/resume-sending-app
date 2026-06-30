// AI Hub — new feature. Safe to delete without affecting existing app.
//
// Admin-only NATIVE "Live Analytics" screen. Light theme, platform switch (All / iOS / Android),
// a dark gradient "Active right now" hero, a 2-col metric grid, top countries, app versions, a live
// activity feed, and a date-range total-activity card — every count taps to open a bottom-sheet
// drill-down. Wired to GET /api/admin/store-analytics (authenticateAdmin). Reached from the ☰ menu.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  SafeAreaView, RefreshControl, Animated, Easing, Modal, Pressable, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter, useFocusEffect } from 'expo-router';
import { fetchStoreAnalytics, runUninstallSweep, type StoreAnalytics } from '../../services/aiHubService';

// ─── tokens ───
const C = {
  bg: '#E5EAF3', bgSoft: '#DCE2ED', surface: '#FFFFFF', ink: '#0B0F22', inkSoft: '#1A2046',
  textMuted: '#5B6B8A', textFaint: '#8896B0', border: 'rgba(11,15,34,0.06)', borderHi: 'rgba(11,15,34,0.10)',
  blue: '#4F8DFF', blueDeep: '#2563EB', purple: '#7C6BFF', teal: '#14B8A6', emerald: '#10B981',
  amber: '#F59E0B', rose: '#EF4444',
};
const IOS = '#0A84FF', ANDROID = '#34A853';
type Plat = 'all' | 'ios' | 'android';
const PLATS: Plat[] = ['all', 'ios', 'android'];

const fmt = (x?: number) => (x == null || isNaN(x) ? '0' : Math.round(x).toLocaleString('en-US'));
const platLabel = (p: Plat) => (p === 'all' ? 'All platforms' : p === 'ios' ? 'iOS' : 'Android');
const platIcon = (p: Plat) => (p === 'ios' ? 'logo-apple' : p === 'android' ? 'logo-android' : 'apps');

// ─── animated number ───
function useCountUp(target: number, dur = 750) {
  const av = useRef(new Animated.Value(target)).current;
  const [v, setV] = useState(target);
  const prev = useRef(target);
  useEffect(() => {
    const from = prev.current;
    if (from === target) { setV(target); return; }
    av.setValue(from);
    const id = av.addListener(({ value }) => setV(value));
    Animated.timing(av, { toValue: target, duration: dur, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start(() => { prev.current = target; });
    return () => av.removeListener(id);
  }, [target]);
  return v;
}
function CountUp({ value, style }: { value: number; style?: any }) {
  const v = useCountUp(value);
  return <Text style={style}>{fmt(v)}</Text>;
}

// ─── pulsing live dot ───
function LiveDot({ color = '#34D399', size = 7 }: { color?: string; size?: number }) {
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(a, { toValue: 1, duration: 1800, easing: Easing.out(Easing.ease), useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, []);
  const scale = a.interpolate({ inputRange: [0, 1], outputRange: [1, 2.6] });
  const opacity = a.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] });
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View style={{ position: 'absolute', width: size, height: size, borderRadius: size, backgroundColor: color, transform: [{ scale }], opacity }} />
      <View style={{ width: size, height: size, borderRadius: size, backgroundColor: color }} />
    </View>
  );
}

// ─── delta pill ───
function Delta({ value, suffix = '%', tone, size = 'sm' }: { value: number; suffix?: string; tone?: string; size?: 'sm' | 'md' }) {
  const up = value >= 0;
  const c = tone || (up ? C.emerald : C.rose);
  const fs = size === 'sm' ? 10 : 11.5;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 1, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 100, backgroundColor: (up ? 'rgba(16,185,129,0.10)' : 'rgba(239,68,68,0.10)') }}>
      <Ionicons name={up ? 'arrow-up' : 'arrow-down'} size={fs} color={c} />
      <Text style={{ color: c, fontSize: fs, fontWeight: '800' }}>{Math.abs(value)}{suffix}</Text>
    </View>
  );
}

// ─── mini bar sparkline (no SVG) ───
function MiniBars({ data, color, height = 42, light }: { data?: number[]; color: string; height?: number; light?: boolean }) {
  const arr = data && data.length ? data : [3, 4, 3, 5, 4, 6, 5, 7];
  const max = Math.max(...arr, 1);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', height, gap: 2 }}>
      {arr.map((val, i) => (
        <View key={i} style={{ flex: 1, height: Math.max(2, (val / max) * height), borderRadius: 2, backgroundColor: i === arr.length - 1 ? (light ? '#fff' : color) : (light ? 'rgba(255,255,255,0.5)' : color + '66') }} />
      ))}
    </View>
  );
}

// ─── iOS/Android split bar ───
function SplitBar({ ios, android, height = 7, legend, light }: { ios: number; android: number; height?: number; legend?: boolean; light?: boolean }) {
  const total = ios + android || 1;
  const iosPct = Math.round((ios / total) * 100);
  const iC = light ? '#fff' : IOS, aC = light ? 'rgba(255,255,255,0.42)' : ANDROID;
  return (
    <View>
      <View style={{ flexDirection: 'row', height, borderRadius: 100, overflow: 'hidden', backgroundColor: light ? 'rgba(255,255,255,0.18)' : C.bgSoft, gap: 2 }}>
        <View style={{ width: `${iosPct}%`, backgroundColor: iC }} />
        <View style={{ flex: 1, backgroundColor: aC }} />
      </View>
      {legend && (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 7 }}>
          <Text style={{ fontSize: 10.5, fontWeight: '700', color: light ? 'rgba(255,255,255,0.86)' : C.ink }}>iOS {fmt(ios)}</Text>
          <Text style={{ fontSize: 10.5, fontWeight: '700', color: light ? 'rgba(255,255,255,0.86)' : C.ink }}>Android {fmt(android)}</Text>
        </View>
      )}
    </View>
  );
}

// ─── helpers over live data ───
function pick(arr: any[] | undefined, platform: Plat, key: string) {
  if (!arr) return 0;
  if (platform === 'all') return arr.reduce((s, r) => s + (Number(r[key]) || 0), 0);
  const row = arr.find((r) => String(r.platform || '').toLowerCase() === platform);
  return row ? Number(row[key]) || 0 : 0;
}
const DAY = 86400000;
function sumRange(series: any[] | undefined, platform: Plat, days: number) {
  const cutoff = Date.now() - days * DAY;
  const acc = { installs: 0, uninstalls: 0, opens: 0, purchases: 0, revenue: 0 };
  (series || []).forEach((r) => {
    if (platform !== 'all' && String(r.platform).toLowerCase() !== platform) return;
    const t = new Date(String(r.day) + 'T00:00:00Z').getTime();
    if (isFinite(t) && t < cutoff) return;
    acc.installs += r.installs || 0; acc.uninstalls += r.uninstalls || 0; acc.opens += r.opens || 0;
    acc.purchases += r.purchases || 0; acc.revenue += r.revenue || 0;
  });
  return acc;
}
function seriesTrend(series: any[] | undefined, platform: Plat, field: string, n = 14) {
  const byDay: Record<string, number> = {};
  (series || []).forEach((r) => {
    if (platform !== 'all' && String(r.platform).toLowerCase() !== platform) return;
    byDay[r.day] = (byDay[r.day] || 0) + (r[field] || 0);
  });
  const days = Object.keys(byDay).sort();
  const tail = days.slice(-n).map((d) => byDay[d]);
  return tail.length ? tail : [0, 0, 0, 0, 0];
}

const RANGES = [
  { key: '24h', label: '24H', days: 1 }, { key: '7d', label: '7D', days: 7 },
  { key: '30d', label: '30D', days: 30 }, { key: '90d', label: '90D', days: 90 },
  { key: 'all', label: 'All', days: 100000 },
];

// ─── drill-down bottom sheet ───
function DetailSheet({ payload, onClose, onAction }: { payload: any; onClose: () => void; onAction?: () => void }) {
  const ty = useRef(new Animated.Value(700)).current;
  useEffect(() => { Animated.timing(ty, { toValue: 0, duration: 320, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start(); }, []);
  const close = () => { Animated.timing(ty, { toValue: 700, duration: 240, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start(() => onClose()); };
  const p = payload;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={close} statusBarTranslucent>
      <Pressable style={dl.overlay} onPress={close} />
      <Animated.View style={[dl.sheet, { transform: [{ translateY: ty }] }]}>
        <View style={dl.handle} />
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: 18, paddingBottom: 28 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={[dl.iconLg, { backgroundColor: p.color + '18' }]}><Ionicons name={p.icon} size={23} color={p.color} /></View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={dl.title}>{p.title}</Text>
              <Text style={dl.sub}>{p.subtitle}</Text>
            </View>
            <TouchableOpacity onPress={close} style={dl.x}><Ionicons name="close" size={18} color={C.textMuted} /></TouchableOpacity>
          </View>

          {p.rows ? (
            <View style={dl.rowsCard}>
              {p.rows.map(([k, v]: [string, string], i: number) => (
                <View key={k} style={[dl.kv, i ? { borderTopWidth: 1, borderTopColor: C.border } : null]}>
                  <Text style={dl.kvK}>{k}</Text><Text style={dl.kvV}>{v}</Text>
                </View>
              ))}
            </View>
          ) : (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 10, marginTop: 18 }}>
                <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
                  {p.money ? <Text style={dl.bigCur}>$</Text> : null}
                  <CountUp value={p.value} style={dl.big} />
                  {p.suffix ? <Text style={dl.bigCur}>{p.suffix}</Text> : null}
                </View>
                {p.delta != null ? <View style={{ marginBottom: 5 }}><Delta value={p.delta} tone={p.invert ? (p.delta <= 0 ? C.emerald : C.rose) : (p.delta >= 0 ? C.emerald : C.rose)} size="md" /></View> : null}
                <Text style={{ flex: 1, textAlign: 'right', fontSize: 11.5, fontWeight: '600', color: C.textFaint, marginBottom: 6 }}>{p.valueLabel || 'vs yesterday'}</Text>
              </View>

              {p.note ? (
                <View style={[dl.note, { backgroundColor: p.color + '12', borderColor: p.color + '22' }]}>
                  <Ionicons name="sparkles-outline" size={14} color={p.color} /><Text style={dl.noteT}>{p.note}</Text>
                </View>
              ) : null}

              {p.stats && p.stats.length ? (
                <View style={dl.statsGrid}>
                  {p.stats.map((st: any, i: number) => (
                    <View key={i} style={dl.statCell}><Text style={dl.statL}>{st[0]}</Text><Text style={dl.statV}>{st[1]}</Text></View>
                  ))}
                </View>
              ) : null}

              <View style={dl.block}>
                <Text style={dl.blockLbl}>Trend</Text>
                <MiniBars data={p.trend} color={p.color} height={64} />
              </View>

              {p.split ? (
                <View style={dl.block}>
                  <Text style={dl.blockLbl}>Platform split</Text>
                  <SplitBar ios={p.split.ios} android={p.split.android} height={10} legend />
                </View>
              ) : null}

              {p.breakdown && p.breakdown.length ? (
                <View style={{ marginTop: 14 }}>
                  <Text style={[dl.blockLbl, { marginBottom: 9 }]}>{p.breakdownTitle || 'Breakdown'}</Text>
                  {p.breakdown.map((b: any, i: number) => {
                    const maxV = p.breakdown.reduce((mx: number, x: any) => (typeof x.value === 'number' ? Math.max(mx, x.value) : mx), 1);
                    return (
                      <View key={i} style={dl.bRow}>
                        {b.code ? <View style={dl.bCode}><Text style={dl.bCodeT}>{b.code}</Text></View> : null}
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                            <Text style={dl.bLbl} numberOfLines={1}>{b.label}</Text>
                            <Text style={dl.bVal}>{b.raw ? b.value : fmt(b.value)}</Text>
                          </View>
                          {!b.raw ? (
                            <View style={dl.bTrack}><View style={{ width: `${Math.round((b.value / maxV) * 100)}%`, height: '100%', borderRadius: 100, backgroundColor: b.color || p.color }} /></View>
                          ) : null}
                        </View>
                      </View>
                    );
                  })}
                </View>
              ) : null}

              {p.txns && p.txns.length ? (
                <View style={{ marginTop: 14 }}>
                  <Text style={[dl.blockLbl, { marginBottom: 9 }]}>Recent transactions</Text>
                  {p.txns.map((t: any, i: number) => (
                    <View key={i} style={dl.bRow}>
                      <View style={[dl.bCode, { backgroundColor: C.purple + '18' }]}><Ionicons name="cart" size={13} color={C.purple} /></View>
                      <View style={{ flex: 1 }}>
                        <Text style={dl.bLbl}>{t.platform === 'apple' ? 'Apple' : (t.platform || 'order')}</Text>
                        <Text style={{ fontSize: 11, color: C.textMuted, fontWeight: '600' }}>{String(t.created_at || '').slice(0, 10)}</Text>
                      </View>
                      <Text style={dl.bVal}>{t.currency || ''} {fmt(Number(t.amount) || 0)}</Text>
                    </View>
                  ))}
                </View>
              ) : null}
            </>
          )}

          {p.action ? (
            <TouchableOpacity activeOpacity={0.85} onPress={() => { p.action.run ? p.action.run() : onAction && onAction(); }} disabled={p.action.busy}>
              <LinearGradient colors={[p.color, C.purple]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={dl.cta}>
                {p.action.busy ? <ActivityIndicator color="#fff" /> : <><Ionicons name={p.action.icon || 'flash'} size={16} color="#fff" /><Text style={dl.ctaT}>{p.action.label}</Text></>}
              </LinearGradient>
            </TouchableOpacity>
          ) : null}
        </ScrollView>
      </Animated.View>
    </Modal>
  );
}

export default function StoreAnalyticsScreen() {
  const router = useRouter();
  const [data, setData] = useState<StoreAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [platform, setPlatform] = useState<Plat>('all');
  const [range, setRange] = useState('7d');
  const [detail, setDetail] = useState<any>(null);
  const [sweeping, setSweeping] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try { setData(await fetchStoreAnalytics()); }
    catch (e: any) { setError(e?.response?.status === 403 ? 'Admin access required.' : 'Could not load analytics. Pull to retry.'); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);
  useFocusEffect(useCallback(() => { setLoading(true); load(); }, [load]));

  // animated platform-switch thumb
  const thumb = useRef(new Animated.Value(0)).current;
  useEffect(() => { Animated.timing(thumb, { toValue: PLATS.indexOf(platform), duration: 320, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start(); }, [platform]);

  const doSweep = useCallback(async () => {
    setSweeping(true);
    try {
      const r = await runUninstallSweep();
      Alert.alert('Uninstall sweep', `Checked ${r.checked} device${r.checked === 1 ? '' : 's'} · ${r.uninstalled} uninstall${r.uninstalled === 1 ? '' : 's'} detected.`);
      setDetail(null); await load();
    } catch (e: any) { Alert.alert('Uninstall sweep', e?.response?.status === 403 ? 'Admin access required.' : 'Sweep failed — try again.'); }
    finally { setSweeping(false); }
  }, [load]);

  const L: any = data?.live || {};
  const A2: any = data?.apple || {};   // Apple store downloads (delayed, lifetime)
  const G: any = data?.google || {};   // Google installs/uninstalls (delayed, monthly)
  const LM: any = data?.local || {};   // real transactions/revenue from payment_orders
  const purch = L.purchasesToday || [];
  const purTotalN = purch.reduce((s: number, p: any) => s + (p.n || 0), 0);
  const purTotalRev = purch.reduce((s: number, p: any) => s + (Number(p.revenue) || 0), 0);
  const subStarted = (L.lifecycle?.events || []).filter((e: any) => e.event === 'subscription_started').reduce((s: number, e: any) => s + (e.d1 || 0), 0);
  const refunds = L.lifecycle?.refunds?.d1 || 0;
  const countries = (L.byCountry || []).filter((c: any) => c.country && c.country !== '??');
  const versions = L.byVersion || [];
  const empty = (L.totalEvents || 0) === 0;

  const activeNow = platform === 'all' ? (L.activeNow?.total || 0) : pick(L.activeNow?.byPlatform, platform, 'users');

  const METRICS = useMemo(() => ([
    { key: 'installs', label: 'New installs', icon: 'download', tone: C.emerald, sub: 'today', value: platform === 'all' ? (L.newInstalls?.last_24h || 0) : pick(L.newInstallsByPlatform, platform, 'installs'), delta: L.deltas?.installs, split: { ios: pick(L.newInstallsByPlatform, 'ios', 'installs'), android: pick(L.newInstallsByPlatform, 'android', 'installs') } },
    { key: 'purchases', label: 'Live purchases', icon: 'cart', tone: C.purple, sub: 'today', money: true, live: true, value: platform === 'ios' ? purch.filter((p: any) => p.platform === 'apple').reduce((s: number, p: any) => s + p.n, 0) : platform === 'android' ? purch.filter((p: any) => p.platform !== 'apple').reduce((s: number, p: any) => s + p.n, 0) : purTotalN },
    { key: 'opens', label: 'App opens', icon: 'pulse', tone: C.teal, sub: 'today', value: platform === 'all' ? (L.opens?.last_24h || 0) : pick(L.opensByPlatform, platform, 'opens'), delta: L.deltas?.opens, split: { ios: pick(L.opensByPlatform, 'ios', 'opens'), android: pick(L.opensByPlatform, 'android', 'opens') } },
    { key: 'uninstalls', label: 'Uninstalls', icon: 'person-remove', tone: C.amber, sub: 'today', invert: true, value: platform === 'all' ? (L.uninstalls?.last_24h || 0) : pick(L.uninstallsByPlatform, platform, 'uninstalls'), delta: L.deltas?.uninstalls, split: { ios: pick(L.uninstallsByPlatform, 'ios', 'uninstalls'), android: pick(L.uninstallsByPlatform, 'android', 'uninstalls') } },
    { key: 'subs', label: 'Subscriptions', icon: 'card', tone: C.blueDeep, sub: 'started today', value: subStarted },
    { key: 'refunds', label: 'Refunds', icon: 'arrow-undo', tone: C.rose, sub: 'today', invert: true, value: refunds },
  ]), [data, platform]);

  const openMetric = (m: any) => {
    const base: any = {
      icon: m.icon, color: m.tone, title: m.label, subtitle: `${m.sub} · ${platLabel(platform)}`,
      value: m.value, money: m.money, delta: m.delta, invert: m.invert,
      split: platform === 'all' && m.split && (m.split.ios || m.split.android) ? m.split : null,
      trend: seriesTrend(L.series, platform, m.key === 'purchases' ? 'revenue' : (m.key === 'subs' || m.key === 'refunds' ? 'opens' : m.key)),
    };
    if (m.key === 'installs') {
      base.stats = [['Today', fmt(L.newInstalls?.last_24h)], ['7 days', fmt(L.newInstalls?.last_7d)], ['All-time', fmt(L.newInstalls?.all_time)], ['Net', fmt(L.netInstalls?.all_time)]];
      base.breakdownTitle = 'By app version'; base.breakdown = versions.slice(0, 4).map((v: any) => ({ label: `v${v.version}`, value: platform === 'all' ? v.total : platform === 'ios' ? v.ios : v.android }));
      const sd = (A2.totalDownloads || 0) + (G.totalInstalls || 0);
      base.note = sd ? `Store lifetime downloads: ${fmt(A2.totalDownloads || 0)} iOS · ${fmt(G.totalInstalls || 0)} Android` : 'Live first-party installs (fills out as v2.8 rolls out)';
    } else if (m.key === 'uninstalls') {
      base.stats = [['Today', fmt(L.uninstalls?.last_24h)], ['7 days', fmt(L.uninstalls?.last_7d)], ['All-time', fmt(L.uninstalls?.all_time)], ['Net inst.', fmt(L.netInstalls?.all_time)]];
      base.note = G.totalUninstalls != null ? `Google official (this month): ${fmt(G.totalUninstalls)} uninstalls` : 'Detected live via push receipts';
      base.action = { label: 'Run uninstall sweep', icon: 'scan', run: doSweep, busy: sweeping };
    } else if (m.key === 'opens') {
      base.stats = [['Last hour', fmt(L.opens?.last_hour)], ['24 hours', fmt(L.opens?.last_24h)], ['Unique 24h', fmt(L.opens?.unique_24h)]];
    } else if (m.key === 'purchases') {
      const tw = LM.txnWindows || {};
      base.money = true; base.value = Math.round(tw.all?.revenue || 0); base.valueLabel = 'revenue · all-time';
      base.stats = [['24h', fmt(tw['24h']?.txns)], ['7 days', fmt(tw['7d']?.txns)], ['30 days', fmt(tw['30d']?.txns)], ['All txns', fmt(tw.all?.txns)]];
      base.breakdownTitle = 'Revenue by platform (lifetime)';
      base.breakdown = (LM.byPlatform || []).map((b: any) => ({ label: `${b.platform === 'apple' ? 'Apple' : b.platform} · ${b.currency || ''}`, value: Math.round(Number(b.revenue) || 0) }));
      base.txns = (LM.recent || []).slice(0, 6);
      base.note = LM.credits?.credits_sold ? `${fmt(LM.credits.credits_sold)} credits sold · ${fmt(LM.credits.purchase_events)} purchase events` : null;
    } else if (m.key === 'subs' || m.key === 'refunds') {
      const evs = (L.lifecycle?.events || []).filter((e: any) => (m.key === 'subs' ? /sub/.test(e.event) : /refund/.test(e.event)));
      base.stats = [['24h', fmt(evs.reduce((sx: number, e: any) => sx + e.d1, 0))], ['7 days', fmt(evs.reduce((sx: number, e: any) => sx + e.d7, 0))], ['All-time', fmt(evs.reduce((sx: number, e: any) => sx + e.all_time, 0))]];
      base.breakdownTitle = 'By store'; base.breakdown = evs.map((e: any) => ({ label: `${e.store === 'apple' ? 'Apple' : 'Google'} · ${e.event}`, value: e.all_time }));
      base.note = 'Real-time from Apple App Store Server Notifications + Google RTDN';
    }
    setDetail(base);
  };
  const openActive = () => setDetail({
    icon: 'people', color: C.blue, title: 'Active users', subtitle: `Live · last 30 min · ${platLabel(platform)}`,
    value: activeNow, delta: L.deltas?.active,
    stats: [['Now · 30m', fmt(activeNow)], ['Active · 24h', fmt(L.activeToday?.total)], ['Opens · 24h', fmt(L.opens?.last_24h)]],
    split: platform === 'all' ? { ios: pick(L.activeNow?.byPlatform, 'ios', 'users'), android: pick(L.activeNow?.byPlatform, 'android', 'users') } : null,
    trend: (L.hourly || []).map((h: any) => h.users),
    breakdownTitle: countries.length ? 'Active by country' : undefined,
    breakdown: countries.slice(0, 6).map((c: any) => ({ label: c.country, code: c.country, value: c.users })),
    note: 'Unique users seen in the last 30 minutes',
  });
  const openCountry = (c: any, max: number) => setDetail({
    icon: 'location', color: C.blue, title: c.country, subtitle: `${Math.round((c.users / (max || 1)) * 100)}% of the top region · ${platLabel(platform)}`,
    value: c.users, valueLabel: 'active users', trend: seriesTrend(L.series, platform, 'opens'),
  });
  const openVersion = (v: any) => setDetail({
    icon: 'layers', color: C.purple, title: `Version ${v.version}`, subtitle: `Devices (last 30 days) · ${platLabel(platform)}`,
    value: platform === 'all' ? v.total : (platform === 'ios' ? v.ios : v.android), valueLabel: 'devices',
    stats: [['Total', fmt(v.total)], ['iOS', fmt(v.ios)], ['Android', fmt(v.android)]],
    split: platform === 'all' && (v.ios || v.android) ? { ios: v.ios, android: v.android } : null,
    trend: seriesTrend(L.series, platform, 'opens'),
  });
  const openTotals = () => {
    const r = RANGES.find((x) => x.key === range)!;
    const s = sumRange(L.series, platform, r.days);
    const tw = (LM.txnWindows || {})[range] || { txns: 0, revenue: 0 };
    const win = r.label === 'All' ? 'all time' : 'last ' + r.label;
    setDetail({
      icon: 'stats-chart', color: C.blue, title: 'Total activity', subtitle: `${r.label === 'All' ? 'All time' : 'Last ' + r.label} · ${platLabel(platform)}`,
      value: Math.round(tw.revenue), money: true, valueLabel: 'revenue · ' + win, trend: seriesTrend(L.series, platform, 'revenue', 20),
      stats: [['Transactions', fmt(tw.txns)], ['New installs', fmt(s.installs)], ['App opens', fmt(s.opens)], ['Uninstalls', fmt(s.uninstalls)]],
      breakdownTitle: `Totals · ${win}`,
      breakdown: [
        { label: 'Revenue', value: '$' + fmt(tw.revenue), raw: true }, { label: 'Transactions', value: fmt(tw.txns), raw: true },
        { label: 'New installs', value: fmt(s.installs), raw: true }, { label: 'Net installs', value: fmt(s.installs - s.uninstalls), raw: true },
        { label: 'App opens', value: fmt(s.opens), raw: true }, { label: 'Uninstalls', value: fmt(s.uninstalls), raw: true },
        { label: 'Store downloads · iOS', value: fmt(A2.totalDownloads || 0), raw: true }, { label: 'Store installs · Android', value: fmt(G.totalInstalls || 0), raw: true },
      ],
      note: r.label === 'All' ? 'Lifetime — payments are exact; first-party installs/opens cover the telemetry window' : `Compared with the previous ${r.label}`,
    });
  };

  // unified live feed (app events + store notifications)
  const feed = useMemo(() => {
    const a = (L.recent || []).map((r: any) => ({ kind: r.event, plat: r.platform, ts: r.created_at, store: false }));
    const b = (L.storeNotifications || []).map((r: any) => ({ kind: r.event || r.notification_type, plat: r.store === 'apple' ? 'ios' : 'android', ts: r.created_at, store: true, price: r.price, currency: r.currency }));
    return [...a, ...b].sort((x, y) => String(y.ts).localeCompare(String(x.ts))).slice(0, 10);
  }, [data]);
  const feedIcon = (k: string) => k === 'app_open' || k === 'foreground' ? 'pulse' : k === 'uninstall' ? 'person-remove' : k === 'apply_open' ? 'open' : /refund/.test(k) ? 'arrow-undo' : /sub/.test(k) ? 'card' : /purchase/.test(k) ? 'cart' : 'ellipse';
  const feedColor = (k: string) => k === 'uninstall' ? C.amber : /refund/.test(k) ? C.rose : /sub/.test(k) ? C.blueDeep : /purchase/.test(k) ? C.purple : k === 'app_open' ? C.teal : C.blue;
  const ago = (ts: string) => { const s = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 1000)); return s < 60 ? (s < 3 ? 'now' : s + 's') : s < 3600 ? Math.floor(s / 60) + 'm' : Math.floor(s / 3600) + 'h'; };

  const countryMax = Math.max(1, ...countries.map((c: any) => c.users));
  const rangeSum = sumRange(L.series, platform, (RANGES.find((x) => x.key === range) || RANGES[1]).days);
  // Revenue + transactions = the EXACT figures from payment_orders (all platforms, all-time capable);
  // per-platform falls back to the 90-day series. Installs/opens/uninstalls come from first-party series.
  const tw = platform === 'all' ? ((LM.txnWindows || {})[range] || { txns: rangeSum.purchases, revenue: rangeSum.revenue }) : { txns: rangeSum.purchases, revenue: rangeSum.revenue };
  const storeDownloads = (A2.totalDownloads || 0) + (G.totalInstalls || 0);

  return (
    <SafeAreaView style={s.safe}>
      {loading ? (
        <View style={s.center}><ActivityIndicator size="large" color={C.blue} /><Text style={[s.muted, { marginTop: 12 }]}>Loading analytics…</Text></View>
      ) : error ? (
        <View style={s.center}><Ionicons name="alert-circle-outline" size={32} color={C.rose} /><Text style={[s.muted, { marginTop: 8 }]}>{error}</Text><TouchableOpacity onPress={() => { setLoading(true); load(); }} style={s.retry}><Text style={s.retryT}>Retry</Text></TouchableOpacity></View>
      ) : (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={C.blue} />}>

          {/* header */}
          <View style={s.header}>
            <TouchableOpacity onPress={() => router.back()} style={s.hBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}><Ionicons name="chevron-back" size={22} color={C.ink} /></TouchableOpacity>
            <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 9, marginLeft: 4 }}>
              <LinearGradient colors={[C.blue, C.blueDeep]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.logo}><Ionicons name="stats-chart" size={16} color="#fff" /></LinearGradient>
              <View>
                <Text style={s.hTitle}>Live Analytics</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 }}><LiveDot color="#34D399" size={6} /><Text style={s.hSub}>Updated just now</Text></View>
              </View>
            </View>
            <TouchableOpacity onPress={() => { setRefreshing(true); load(); }} style={s.hBtn}><Ionicons name="refresh" size={18} color={C.ink} /></TouchableOpacity>
          </View>

          {empty ? (
            <View style={s.emptyBox}>
              <Ionicons name="cellular-outline" size={18} color={C.blue} />
              <Text style={s.emptyT}>No app activity recorded yet. Live numbers fill in the instant the app (with telemetry, v2.8+) is opened — reopen on Expo to see yourself appear. Store events arrive once the Apple/Google webhooks are configured.</Text>
            </View>
          ) : null}

          {/* platform switch */}
          <View style={{ paddingHorizontal: 16, marginTop: 4 }}>
            <View style={s.switch}>
              <Animated.View style={[s.thumb, { left: thumb.interpolate({ inputRange: [0, 2], outputRange: ['1.5%', '67.8%'] }) }]}>
                <LinearGradient colors={platform === 'all' ? [C.blue, C.purple] : platform === 'ios' ? [IOS, IOS] : [ANDROID, ANDROID]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ flex: 1, borderRadius: 14 }} />
              </Animated.View>
              {PLATS.map((p) => {
                const on = p === platform;
                const cnt = p === 'all' ? (L.activeNow?.total || 0) : pick(L.activeNow?.byPlatform, p, 'users');
                return (
                  <TouchableOpacity key={p} activeOpacity={0.8} onPress={() => setPlatform(p)} style={s.swBtn}>
                    <Ionicons name={platIcon(p) as any} size={17} color={on ? '#fff' : (p === 'all' ? C.ink : p === 'ios' ? IOS : ANDROID)} />
                    <Text style={[s.swLbl, { color: on ? '#fff' : C.textMuted }]}>{p === 'all' ? 'All' : p === 'ios' ? 'iOS' : 'Android'}</Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <LiveDot color={on ? '#fff' : '#34D399'} size={5} />
                      <Text style={{ fontSize: 10.5, fontWeight: '700', color: on ? 'rgba(255,255,255,0.92)' : C.textFaint }}>{fmt(cnt)}</Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {/* hero */}
          <View style={{ paddingHorizontal: 16, marginTop: 14 }}>
            <TouchableOpacity activeOpacity={0.92} onPress={openActive}>
              <LinearGradient colors={['#11163a', '#0B0F22']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.hero}>
                <LinearGradient colors={['rgba(79,141,255,0.55)', 'transparent']} start={{ x: 0, y: 0 }} end={{ x: 0.7, y: 0.7 }} style={StyleSheet.absoluteFill as any} />
                <LinearGradient colors={['transparent', 'rgba(20,184,166,0.4)']} start={{ x: 0.3, y: 0.3 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill as any} />
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}><LiveDot color="#34D399" size={7} /><Text style={s.heroEy}>ACTIVE RIGHT NOW</Text></View>
                  <View style={s.heroChip}><Text style={{ color: '#fff', fontSize: 10.5, fontWeight: '800' }}>{platLabel(platform)}</Text><Ionicons name="chevron-forward" size={11} color="rgba(255,255,255,0.8)" /></View>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginTop: 8 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 9 }}>
                    <CountUp value={activeNow} style={s.heroNum} />
                    {L.deltas?.active != null ? <View style={{ marginBottom: 8 }}><Delta value={L.deltas.active} tone="#34D399" size="md" /></View> : null}
                  </View>
                  <View style={{ width: 108, marginBottom: 2 }}><MiniBars data={(L.hourly || []).map((h: any) => h.users)} color="#fff" height={42} light /></View>
                </View>
                <View style={s.heroMini}>
                  {[['NEW / HR', fmt(L.newInstalls?.last_hour)], ['OPENS / HR', fmt(L.opens?.last_hour)], ['ACTIVE · 24H', fmt(L.activeToday?.total)]].map(([l, v], i) => (
                    <React.Fragment key={l}>
                      {i > 0 ? <View style={s.heroDiv} /> : null}
                      <View style={{ flex: 1 }}><Text style={s.heroMiniL}>{l}</Text><Text style={s.heroMiniV}>{v}</Text></View>
                    </React.Fragment>
                  ))}
                </View>
                {platform === 'all' ? (
                  <View style={{ marginTop: 12 }}><SplitBar ios={pick(L.activeNow?.byPlatform, 'ios', 'users')} android={pick(L.activeNow?.byPlatform, 'android', 'users')} height={7} legend light /></View>
                ) : null}
              </LinearGradient>
            </TouchableOpacity>
          </View>

          {/* metrics grid */}
          <View style={{ paddingHorizontal: 16, marginTop: 22 }}>
            <Text style={s.secTitle}>Today's activity</Text>
            <View style={s.grid}>
              {METRICS.map((m) => {
                const tone = m.invert ? ((m.delta ?? 0) <= 0 ? C.emerald : C.rose) : ((m.delta ?? 0) >= 0 ? C.emerald : C.rose);
                return (
                  <TouchableOpacity key={m.key} activeOpacity={0.85} onPress={() => openMetric(m)} style={s.card}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
                        <View style={[s.iconChip, { backgroundColor: m.tone + '18' }]}><Ionicons name={m.icon as any} size={15} color={m.tone} /></View>
                        <Text style={s.cardLbl} numberOfLines={1}>{m.label}</Text>
                      </View>
                      {m.live ? <LiveDot color="#34D399" size={6} /> : <Ionicons name="chevron-forward" size={14} color={C.textFaint} />}
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 2, marginTop: 9 }}>
                      {m.money ? <Text style={s.cardCur}>$</Text> : null}
                      <CountUp value={m.value} style={s.cardVal} />
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 6 }}>
                      {m.delta != null ? <Delta value={m.delta} tone={tone} /> : <Text style={{ fontSize: 10.5, color: C.textFaint, fontWeight: '700' }}>—</Text>}
                      <Text style={s.cardSub}>{m.sub}</Text>
                    </View>
                    {platform === 'all' && m.split && (m.split.ios || m.split.android) ? <View style={{ marginTop: 10 }}><SplitBar ios={m.split.ios} android={m.split.android} height={5} /></View> : null}
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {/* countries */}
          {countries.length ? (
            <View style={{ paddingHorizontal: 16, marginTop: 24 }}>
              <View style={s.secRow}><Text style={s.secTitle}>Top countries</Text><View style={s.countPill}><Text style={s.countPillT}>{countries.length}</Text></View></View>
              <View style={{ gap: 9 }}>
                {countries.slice(0, 5).map((c: any) => (
                  <TouchableOpacity key={c.country} activeOpacity={0.85} onPress={() => openCountry(c, countryMax)} style={s.row}>
                    <View style={s.codeChip}><Text style={s.codeChipT}>{c.country}</Text></View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Text style={s.rowName}>{c.country}</Text><Text style={s.rowVal}>{fmt(c.users)}</Text></View>
                      <View style={s.track}><View style={{ width: `${Math.round((c.users / countryMax) * 100)}%`, height: '100%', borderRadius: 100, backgroundColor: C.blue }} /></View>
                    </View>
                    <Ionicons name="chevron-forward" size={14} color={C.textFaint} />
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          ) : null}

          {/* versions */}
          {versions.length ? (
            <View style={{ paddingHorizontal: 16, marginTop: 24 }}>
              <Text style={s.secTitle}>Top app versions</Text>
              <View style={{ gap: 9, marginTop: 11 }}>
                {versions.map((v: any) => {
                  const total = versions.reduce((sx: number, x: any) => sx + (x.total || 0), 0) || 1;
                  const share = Math.round(((platform === 'all' ? v.total : platform === 'ios' ? v.ios : v.android) / (total)) * 100);
                  return (
                    <TouchableOpacity key={v.version} activeOpacity={0.85} onPress={() => openVersion(v)} style={s.row}>
                      <View style={[s.codeChip, { backgroundColor: C.purple + '14' }]}><Ionicons name="layers" size={15} color={C.purple} /></View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Text style={[s.rowName, { fontWeight: '800' }]}>{v.version}</Text><Text style={s.rowVal}>{fmt(platform === 'all' ? v.total : platform === 'ios' ? v.ios : v.android)}</Text></View>
                        <View style={s.track}><View style={{ width: `${share}%`, height: '100%', borderRadius: 100, backgroundColor: C.purple }} /></View>
                      </View>
                      <Ionicons name="chevron-forward" size={14} color={C.textFaint} />
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          ) : null}

          {/* live feed */}
          {feed.length ? (
            <View style={{ paddingHorizontal: 16, marginTop: 24 }}>
              <View style={s.secRow}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={s.secTitle}>Live activity</Text>
                  <View style={s.livePill}><LiveDot color="#10B981" size={5} /><Text style={s.livePillT}>LIVE</Text></View>
                </View>
                <Text style={{ fontSize: 11.5, fontWeight: '700', color: C.textFaint }}>recent</Text>
              </View>
              <View style={{ gap: 8 }}>
                {feed.map((e, i) => (
                  <View key={i} style={s.feed}>
                    <View style={[s.iconChip, { width: 30, height: 30, backgroundColor: feedColor(e.kind) + '18' }]}>
                      <Ionicons name={feedIcon(e.kind) as any} size={15} color={feedColor(e.kind)} />
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={s.feedT} numberOfLines={1}><Text style={{ fontWeight: '800' }}>{String(e.kind || 'event').replace(/_/g, ' ')}</Text>{e.price ? <Text style={{ color: feedColor(e.kind), fontWeight: '800' }}>  ·  {e.currency || ''} {e.price}</Text> : null}</Text>
                      <Text style={s.feedSub}>{e.plat === 'ios' ? 'iOS' : e.plat === 'android' ? 'Android' : (e.plat || '—')}{e.store ? ' · store' : ''}</Text>
                    </View>
                    <Text style={s.feedAgo}>{ago(e.ts)}</Text>
                  </View>
                ))}
              </View>
            </View>
          ) : null}

          {/* total activity */}
          <View style={{ paddingHorizontal: 16, marginTop: 26 }}>
            <Text style={s.secTitle}>Total activity</Text>
            <Text style={s.secSub}>Cumulative over the selected window</Text>
            <View style={s.rangeBar}>
              {RANGES.map((r) => {
                const on = r.key === range;
                return (
                  <TouchableOpacity key={r.key} activeOpacity={0.8} onPress={() => setRange(r.key)} style={[s.rangeBtn, on ? s.rangeBtnOn : null]}>
                    <Text style={[s.rangeT, { color: on ? '#fff' : C.textMuted }]}>{r.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <TouchableOpacity activeOpacity={0.9} onPress={openTotals} style={s.totalCard}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={s.totalEy}>TOTAL REVENUE</Text>
                <View style={s.totalChip}><Ionicons name={platIcon(platform) as any} size={12} color={platform === 'all' ? C.ink : platform === 'ios' ? IOS : ANDROID} /><Text style={s.totalChipT}>{platLabel(platform)}</Text></View>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 3, marginTop: 8 }}>
                <Text style={s.totalCur}>$</Text><CountUp value={Math.round(tw.revenue)} style={s.totalNum} />
                <Text style={{ marginLeft: 8, marginBottom: 6, fontSize: 11.5, fontWeight: '700', color: C.textFaint }}>{fmt(tw.txns)} txns</Text>
              </View>
              <View style={{ marginTop: 8 }}><MiniBars data={seriesTrend(L.series, platform, 'revenue', 20)} color={C.blue} height={48} /></View>
              <View style={s.totGrid}>
                {[['Transactions', C.purple, tw.txns], ['Revenue', C.blueDeep, Math.round(tw.revenue)], ['New installs', C.emerald, rangeSum.installs], ['App opens', C.teal, rangeSum.opens], ['Uninstalls', C.amber, rangeSum.uninstalls], ['Store downloads', C.blue, storeDownloads]].map(([l, col, val]) => (
                  <View key={l as string} style={s.totCell}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 5 }}><View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: col as string }} /><Text style={s.totCellL} numberOfLines={1}>{l as string}</Text></View>
                    <Text style={s.totCellV}>{l === 'Revenue' ? '$' : ''}{fmt(val as number)}</Text>
                  </View>
                ))}
              </View>
            </TouchableOpacity>
          </View>
        </ScrollView>
      )}

      {detail ? <DetailSheet payload={detail} onClose={() => setDetail(null)} /> : null}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  muted: { color: C.textMuted, fontSize: 13, textAlign: 'center' },
  retry: { marginTop: 16, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 12, backgroundColor: C.blue },
  retryT: { color: '#fff', fontWeight: '800', fontSize: 13 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingTop: 10, paddingBottom: 10, gap: 4 },
  hBtn: { width: 38, height: 38, borderRadius: 12, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  logo: { width: 30, height: 30, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  hTitle: { fontSize: 16, fontWeight: '800', color: C.ink, letterSpacing: -0.3 },
  hSub: { fontSize: 10.5, fontWeight: '700', color: C.textMuted },
  emptyBox: { flexDirection: 'row', gap: 9, marginHorizontal: 16, marginTop: 6, padding: 13, borderRadius: 14, backgroundColor: C.blue + '12', borderWidth: 1, borderColor: C.blue + '22' },
  emptyT: { flex: 1, fontSize: 12, color: C.inkSoft, fontWeight: '600', lineHeight: 17 },
  switch: { flexDirection: 'row', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, borderRadius: 18, padding: 5, position: 'relative' },
  thumb: { position: 'absolute', top: 5, bottom: 5, width: '31.3%', borderRadius: 14 },
  swBtn: { flex: 1, alignItems: 'center', paddingVertical: 9, gap: 4 },
  swLbl: { fontSize: 12.5, fontWeight: '800', letterSpacing: -0.1 },
  hero: { borderRadius: 24, padding: 16, overflow: 'hidden' },
  heroEy: { fontSize: 11, fontWeight: '800', letterSpacing: 1.6, color: 'rgba(255,255,255,0.82)' },
  heroChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 9, paddingVertical: 4, borderRadius: 100, backgroundColor: 'rgba(255,255,255,0.16)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)' },
  heroNum: { fontSize: 56, fontWeight: '800', color: '#fff', letterSpacing: -2.5, lineHeight: 58 },
  heroMini: { marginTop: 14, padding: 11, backgroundColor: 'rgba(255,255,255,0.12)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)', borderRadius: 14, flexDirection: 'row', alignItems: 'center' },
  heroDiv: { width: 1, height: 26, backgroundColor: 'rgba(255,255,255,0.18)', marginHorizontal: 8 },
  heroMiniL: { fontSize: 9, color: 'rgba(255,255,255,0.7)', fontWeight: '700', letterSpacing: 0.6 },
  heroMiniV: { fontSize: 15.5, fontWeight: '800', color: '#fff', marginTop: 2, letterSpacing: -0.3 },
  secTitle: { fontSize: 16.5, fontWeight: '800', color: C.ink, letterSpacing: -0.4 },
  secSub: { fontSize: 11.5, color: C.textMuted, fontWeight: '600', marginTop: 2 },
  secRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 11 },
  countPill: { paddingHorizontal: 7, paddingVertical: 1, borderRadius: 100, backgroundColor: C.ink },
  countPillT: { color: '#fff', fontSize: 10, fontWeight: '800' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 11, marginTop: 11 },
  card: { width: '47%', flexGrow: 1, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, borderRadius: 18, padding: 13 },
  iconChip: { width: 28, height: 28, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  cardLbl: { fontSize: 11.5, fontWeight: '700', color: C.textMuted, flexShrink: 1 },
  cardCur: { fontSize: 16, fontWeight: '800', color: C.ink },
  cardVal: { fontSize: 26, fontWeight: '800', color: C.ink, letterSpacing: -0.9 },
  cardSub: { fontSize: 10.5, fontWeight: '600', color: C.textFaint },
  row: { flexDirection: 'row', alignItems: 'center', gap: 11, padding: 11, backgroundColor: C.surface, borderRadius: 14, borderWidth: 1, borderColor: C.border },
  codeChip: { width: 32, height: 32, borderRadius: 9, backgroundColor: C.bgSoft, alignItems: 'center', justifyContent: 'center' },
  codeChipT: { fontSize: 11, fontWeight: '800', color: C.inkSoft },
  rowName: { fontSize: 13.5, fontWeight: '700', color: C.ink, flex: 1 },
  rowVal: { fontSize: 13.5, fontWeight: '800', color: C.ink },
  track: { marginTop: 6, height: 5, borderRadius: 100, backgroundColor: C.bgSoft, overflow: 'hidden' },
  livePill: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 9, paddingVertical: 3, borderRadius: 100, backgroundColor: 'rgba(16,185,129,0.12)' },
  livePillT: { fontSize: 10, fontWeight: '800', color: '#0E9B6F', letterSpacing: 0.4 },
  feed: { flexDirection: 'row', alignItems: 'center', gap: 11, padding: 10, backgroundColor: C.surface, borderRadius: 14, borderWidth: 1, borderColor: C.border },
  feedT: { fontSize: 12.5, color: C.ink, textTransform: 'capitalize' },
  feedSub: { fontSize: 11, color: C.textMuted, fontWeight: '600', marginTop: 1 },
  feedAgo: { fontSize: 10.5, fontWeight: '700', color: C.textFaint },
  rangeBar: { flexDirection: 'row', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, borderRadius: 14, padding: 4, marginTop: 11, gap: 2 },
  rangeBtn: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 10 },
  rangeBtnOn: { backgroundColor: C.blue },
  rangeT: { fontSize: 12, fontWeight: '800' },
  totalCard: { marginTop: 11, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, borderRadius: 20, padding: 15 },
  totalEy: { fontSize: 9.5, fontWeight: '800', color: C.textMuted, letterSpacing: 1.6 },
  totalChip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 100, backgroundColor: C.bgSoft },
  totalChipT: { fontSize: 10, fontWeight: '800', color: C.inkSoft },
  totalCur: { fontSize: 24, fontWeight: '800', color: C.ink, letterSpacing: -1 },
  totalNum: { fontSize: 40, fontWeight: '800', color: C.ink, letterSpacing: -2 },
  totGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  totCell: { width: '31%', flexGrow: 1, backgroundColor: C.bgSoft, borderRadius: 12, padding: 9 },
  totCellL: { fontSize: 9.5, fontWeight: '700', color: C.textMuted, flexShrink: 1 },
  totCellV: { fontSize: 16, fontWeight: '800', color: C.ink, letterSpacing: -0.5 },
});

const dl = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(11,15,34,0.42)' },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '88%', backgroundColor: C.bg, borderTopLeftRadius: 28, borderTopRightRadius: 28, overflow: 'hidden' },
  handle: { alignSelf: 'center', width: 40, height: 5, borderRadius: 100, backgroundColor: C.borderHi, marginTop: 10, marginBottom: 2 },
  iconLg: { width: 46, height: 46, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 19, fontWeight: '800', color: C.ink, letterSpacing: -0.5 },
  sub: { fontSize: 12.5, color: C.textMuted, fontWeight: '600', marginTop: 2 },
  x: { width: 30, height: 30, borderRadius: 15, backgroundColor: C.bgSoft, alignItems: 'center', justifyContent: 'center' },
  big: { fontSize: 44, fontWeight: '800', color: C.ink, letterSpacing: -2.2 },
  bigCur: { fontSize: 24, fontWeight: '800', color: C.ink },
  note: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, padding: 11, borderRadius: 12, borderWidth: 1 },
  noteT: { flex: 1, fontSize: 12, fontWeight: '600', color: C.inkSoft },
  block: { marginTop: 14, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, borderRadius: 16, padding: 14 },
  blockLbl: { fontSize: 11, fontWeight: '800', color: C.textFaint, letterSpacing: 1, textTransform: 'uppercase' },
  rowsCard: { marginTop: 18, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, borderRadius: 16, overflow: 'hidden' },
  kv: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 13 },
  kvK: { fontSize: 12.5, fontWeight: '600', color: C.textMuted },
  kvV: { fontSize: 13, fontWeight: '800', color: C.ink },
  bRow: { flexDirection: 'row', alignItems: 'center', gap: 11, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, borderRadius: 13, padding: 11, marginBottom: 8 },
  bCode: { width: 26, height: 26, borderRadius: 8, backgroundColor: C.bgSoft, alignItems: 'center', justifyContent: 'center' },
  bCodeT: { fontSize: 10, fontWeight: '800', color: C.inkSoft },
  bLbl: { fontSize: 12.5, fontWeight: '700', color: C.ink, flex: 1 },
  bVal: { fontSize: 12.5, fontWeight: '800', color: C.ink },
  bTrack: { marginTop: 6, height: 5, borderRadius: 100, backgroundColor: C.bgSoft, overflow: 'hidden' },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 },
  statCell: { width: '23%', flexGrow: 1, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, borderRadius: 13, paddingVertical: 10, paddingHorizontal: 11 },
  statL: { fontSize: 9.5, fontWeight: '700', color: C.textMuted, letterSpacing: 0.2 },
  statV: { fontSize: 17, fontWeight: '800', color: C.ink, letterSpacing: -0.5, marginTop: 3 },
  cta: { marginTop: 18, height: 50, borderRadius: 15, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  ctaT: { color: '#fff', fontSize: 13.5, fontWeight: '800' },
});
