// AI Hub — new feature. Safe to delete without affecting existing app.
//
// Admin-only page: every automated push USERS receive (interest match, résumé match, follow-up
// reminders, credit expiry, weekly digest, reply alerts) with an on/off switch and how many were
// actually sent (24h / 7d) — plus the admin-alert toggles (installs / registrations / purchases)
// and a test push. Flipping a switch takes effect server-side within a minute, no deploy.

import React, { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, Switch, SafeAreaView, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import {
  fetchUserNotifSwitches, setUserNotifSwitch, type UserNotifSwitch,
  fetchAdminNotifySettings, updateAdminNotifySettings, type AdminNotifySettings,
  sendAdminTestNotification,
} from '../../services/aiHubService';

const T = {
  bg: '#0B1120', card: 'rgba(255,255,255,0.055)', line: 'rgba(255,255,255,0.09)',
  ink: '#FFFFFF', muted: 'rgba(255,255,255,0.55)', faint: 'rgba(255,255,255,0.38)',
  cyan: '#22D3EE', blue: '#4F8DFF', red: '#F87171', emerald: '#34D399',
};

const ADMIN_CATS: { key: keyof AdminNotifySettings; icon: string; label: string; desc: string }[] = [
  { key: 'installs', icon: '📲', label: 'New installs', desc: 'Alert on every new app install (iOS/Android).' },
  { key: 'registrations', icon: '🧑‍💻', label: 'New registrations', desc: 'Alert when a new user registers, with provider.' },
  { key: 'purchases', icon: '💰', label: 'Purchases', desc: 'Alert when a user buys credits or a subscription.' },
];

export default function PushNotificationsScreen() {
  const router = useRouter();
  const [switches, setSwitches] = useState<UserNotifSwitch[]>([]);
  const [adminSettings, setAdminSettings] = useState<AdminNotifySettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [testState, setTestState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');

  const load = useCallback(async () => {
    setError(null);
    try {
      const [sw, adm] = await Promise.all([fetchUserNotifSwitches(), fetchAdminNotifySettings()]);
      setSwitches(sw);
      setAdminSettings(adm);
    } catch (e: any) {
      setError(e?.response?.status === 403 ? 'Admin access required.' : 'Could not load — pull down or try again.');
    } finally {
      setLoading(false);
    }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const flipUser = useCallback(async (s: UserNotifSwitch, val: boolean) => {
    setBusyKey(s.key);
    setSwitches((prev) => prev.map((x) => (x.key === s.key ? { ...x, enabled: val } : x)));
    try {
      await setUserNotifSwitch(s.key, val);
    } catch {
      setSwitches((prev) => prev.map((x) => (x.key === s.key ? { ...x, enabled: !val } : x)));
      Alert.alert('Could not save', 'The switch was not changed — try again.');
    } finally { setBusyKey(null); }
  }, []);

  const flipAdmin = useCallback(async (key: keyof AdminNotifySettings, val: boolean) => {
    if (!adminSettings) return;
    const prev = adminSettings;
    setAdminSettings({ ...adminSettings, [key]: val });
    try {
      await updateAdminNotifySettings({ [key]: val });
    } catch {
      setAdminSettings(prev);
      Alert.alert('Could not save', 'The toggle was not changed — try again.');
    }
  }, [adminSettings]);

  const sendTest = useCallback(async () => {
    setTestState('sending');
    try { await sendAdminTestNotification(); setTestState('sent'); }
    catch { setTestState('failed'); }
    setTimeout(() => setTestState('idle'), 3500);
  }, []);

  return (
    <SafeAreaView style={s.safe}>
      {/* header — own back button (admin stack hides the native header) */}
      <View style={s.head}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} style={s.backBtn}>
          <Ionicons name="arrow-back" size={22} color={T.ink} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.headTitle}>Push Notifications</Text>
          <Text style={s.headSub}>What goes out automatically — flip anything off instantly</Text>
        </View>
        <TouchableOpacity onPress={load} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="refresh" size={20} color={T.muted} />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={s.center}><ActivityIndicator color={T.cyan} size="large" /></View>
      ) : error ? (
        <View style={s.center}>
          <Ionicons name="lock-closed-outline" size={34} color={T.faint} />
          <Text style={s.errTx}>{error}</Text>
          <TouchableOpacity onPress={() => { setLoading(true); load(); }} style={s.retryBtn}><Text style={s.retryTx}>Retry</Text></TouchableOpacity>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 46 }} showsVerticalScrollIndicator={false}>
          <Text style={s.secTitle}>AUTOMATED PUSHES TO USERS</Text>
          {switches.map((sw) => (
            <View key={sw.key} style={s.card}>
              <Text style={s.cardIcon}>{sw.icon}</Text>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.cardTitle}>
                  {sw.label}{!sw.enabled && <Text style={s.offTag}>  · OFF</Text>}
                </Text>
                <Text style={s.cardDesc}>{sw.description}</Text>
                <Text style={s.cardCounts}>Sent: <Text style={s.countB}>{sw.sent24h}</Text> in 24h · <Text style={s.countB}>{sw.sent7d}</Text> in 7 days</Text>
              </View>
              <Switch
                value={sw.enabled}
                disabled={busyKey === sw.key}
                onValueChange={(v) => flipUser(sw, v)}
                trackColor={{ false: 'rgba(255,255,255,0.16)', true: T.cyan }}
                thumbColor="#fff"
              />
            </View>
          ))}

          <Text style={[s.secTitle, { marginTop: 22 }]}>ALERTS TO ADMINS</Text>
          {ADMIN_CATS.map((c) => (
            <View key={c.key} style={s.card}>
              <Text style={s.cardIcon}>{c.icon}</Text>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.cardTitle}>{c.label}</Text>
                <Text style={s.cardDesc}>{c.desc}</Text>
              </View>
              <Switch
                value={adminSettings ? adminSettings[c.key] !== false : true}
                onValueChange={(v) => flipAdmin(c.key, v)}
                trackColor={{ false: 'rgba(255,255,255,0.16)', true: T.cyan }}
                thumbColor="#fff"
              />
            </View>
          ))}

          <TouchableOpacity style={s.testBtn} onPress={sendTest} disabled={testState === 'sending'} activeOpacity={0.85}>
            {testState === 'sending'
              ? <ActivityIndicator color="#fff" size="small" />
              : <>
                  <Ionicons name={testState === 'sent' ? 'checkmark-circle' : testState === 'failed' ? 'alert-circle' : 'notifications-outline'} size={16} color="#fff" />
                  <Text style={s.testTx}>{testState === 'sent' ? 'Sent — check your phone' : testState === 'failed' ? 'Failed — try again' : 'Send a test push to admin devices'}</Text>
                </>}
          </TouchableOpacity>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: T.bg },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  backBtn: { width: 38, height: 38, borderRadius: 12, backgroundColor: T.card, alignItems: 'center', justifyContent: 'center' },
  headTitle: { color: T.ink, fontSize: 18, fontWeight: '800', letterSpacing: -0.3 },
  headSub: { color: T.faint, fontSize: 11.5, marginTop: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 30 },
  errTx: { color: T.muted, fontSize: 13.5, textAlign: 'center' },
  retryBtn: { backgroundColor: T.card, borderRadius: 12, paddingHorizontal: 20, paddingVertical: 10 },
  retryTx: { color: T.cyan, fontWeight: '700', fontSize: 13 },
  secTitle: { color: T.faint, fontSize: 10.5, fontWeight: '800', letterSpacing: 1, marginBottom: 9, marginLeft: 2 },
  card: {
    flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: T.card,
    borderWidth: 1, borderColor: T.line, borderRadius: 18, padding: 14, marginBottom: 10,
  },
  cardIcon: { fontSize: 22 },
  cardTitle: { color: T.ink, fontSize: 14.5, fontWeight: '800' },
  offTag: { color: T.red, fontSize: 11.5, fontWeight: '800' },
  cardDesc: { color: T.muted, fontSize: 11.5, lineHeight: 16, marginTop: 3 },
  cardCounts: { color: T.faint, fontSize: 10.5, marginTop: 6 },
  countB: { color: T.cyan, fontWeight: '800' },
  testBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: 'rgba(79,141,255,0.22)', borderWidth: 1, borderColor: 'rgba(79,141,255,0.4)',
    borderRadius: 14, paddingVertical: 13, marginTop: 6,
  },
  testTx: { color: T.ink, fontSize: 13.5, fontWeight: '700' },
});
