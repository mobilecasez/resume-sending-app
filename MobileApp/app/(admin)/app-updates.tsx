// AI Hub — new feature. Safe to delete without affecting existing app.
//
// Admin-only: the forced-upgrade gate. One target build per platform plus a single switch that
// decides whether being below it is compulsory.
//
//   Mandatory ON  → anyone on an older build gets a sheet they cannot dismiss until they update.
//   Mandatory OFF → same sheet, with a "Not now" button.
//   Target 0      → the gate is off entirely for that platform.
//
// ⚠️ THIS IS THE ONE ADMIN CONTROL THAT CAN LOCK EVERY USER OUT AT ONCE, so turning Mandatory on
// asks for a confirmation that spells out who it will hit, and the target defaults to this device's
// own build rather than to something typed in a hurry.
//
// ⚠️ IT ONLY REACHES BUILDS THAT SHIPPED WITH THE GATE (iOS 163+). Users on anything older never
// ask the server the question, so no number here can reach them — they update via the App Store as
// normal. That is stated on the screen too, because a silent no-op is worse than a visible limit.

import React, { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Switch, SafeAreaView, Alert, Platform, KeyboardAvoidingView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import { fetchVersionGate, saveVersionGate, type VersionGate } from '../../services/aiHubService';
import { APP_BUILD } from '../../services/analytics';

const T = {
  bg: '#0B1120', card: 'rgba(255,255,255,0.055)', line: 'rgba(255,255,255,0.09)',
  ink: '#FFFFFF', muted: 'rgba(255,255,255,0.55)', faint: 'rgba(255,255,255,0.38)',
  cyan: '#22D3EE', amber: '#FBBF24', red: '#F87171', emerald: '#34D399',
};

const DEFAULT_TITLE = 'Update CVApplyr';
const DEFAULT_MESSAGE = 'This version is out of date. Update to the latest version to carry on.';

export default function AppUpdatesScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [iosBuild, setIosBuild] = useState('0');
  const [androidCode, setAndroidCode] = useState('0');
  const [mandatory, setMandatory] = useState(false);
  const [title, setTitle] = useState(DEFAULT_TITLE);
  const [message, setMessage] = useState(DEFAULT_MESSAGE);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const apply = (g: VersionGate) => {
    setIosBuild(String(g.ios_target_build || 0));
    setAndroidCode(String(g.android_target_code || 0));
    setMandatory(!!g.mandatory);
    setTitle(g.title || DEFAULT_TITLE);
    setMessage(g.message || DEFAULT_MESSAGE);
    setSavedAt(g.updated_at || null);
  };

  const load = useCallback(async () => {
    setError(null);
    try { apply(await fetchVersionGate()); }
    catch (e: any) {
      setError(e?.response?.status === 403 ? 'Admin access required.' : 'Could not load — try again.');
    } finally { setLoading(false); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const iosN = parseInt(iosBuild, 10) || 0;
  const androidN = parseInt(androidCode, 10) || 0;
  const armed = iosN > 0 || androidN > 0;

  const persist = useCallback(async (patch: Partial<VersionGate>) => {
    setSaving(true);
    try {
      apply(await saveVersionGate(patch));
      return true;
    } catch {
      Alert.alert('Not saved', 'The setting could not be saved. Check your connection and try again.');
      return false;
    } finally { setSaving(false); }
  }, []);

  // Turning the hard block ON is the dangerous direction, so it is the only one that asks.
  const flipMandatory = useCallback((val: boolean) => {
    if (!val) { setMandatory(false); return; }
    Alert.alert(
      'Make the update compulsory?',
      `Everyone on iOS build ${iosN || '—'} or older will be stopped at a sheet they cannot dismiss until they install the latest version from the App Store.\n\nUse this only for a build that is genuinely unusable. Otherwise leave it off and they will still be told an update exists.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Yes, make it compulsory', style: 'destructive', onPress: () => setMandatory(true) },
      ],
    );
  }, [iosN]);

  const save = useCallback(async () => {
    if (mandatory && iosN <= 0 && androidN <= 0) {
      Alert.alert('Nothing to enforce', 'Set a target build first — with the target at 0 the gate is off and nobody sees anything.');
      return;
    }
    const ok = await persist({
      ios_target_build: iosN, android_target_code: androidN, mandatory,
      title: title.trim() || DEFAULT_TITLE, message: message.trim() || DEFAULT_MESSAGE,
    });
    if (ok) {
      Alert.alert('Saved', !armed
        ? 'The gate is off — nobody will be asked to update.'
        : mandatory
          ? `Anyone below iOS build ${iosN} must update before they can carry on. Takes effect within a minute.`
          : `Anyone below iOS build ${iosN} will see a dismissible update prompt. Takes effect within a minute.`);
    }
  }, [mandatory, iosN, androidN, title, message, armed, persist]);

  const turnOff = useCallback(() => {
    Alert.alert('Turn the gate off?', 'Nobody will be prompted to update. The message text is kept.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Turn off',
        onPress: async () => {
          const ok = await persist({ ios_target_build: 0, android_target_code: 0, mandatory: false });
          if (ok) Alert.alert('Gate off', 'No update prompts will be shown.');
        },
      },
    ]);
  }, [persist]);

  const statusLine = !armed
    ? 'OFF — nobody is prompted'
    : mandatory
      ? `HARD BLOCK below build ${iosN || androidN}`
      : `Reminder below build ${iosN || androidN}`;
  const statusColor = !armed ? T.faint : mandatory ? T.red : T.amber;

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.head}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} style={s.backBtn}>
          <Ionicons name="arrow-back" size={22} color={T.ink} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.headTitle}>App Updates</Text>
          <Text style={s.headSub}>Ask — or require — everyone to move to a newer build</Text>
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
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

            {/* Current state, first thing, in plain words. */}
            <View style={[s.statusCard, { borderColor: armed ? (mandatory ? 'rgba(248,113,113,0.4)' : 'rgba(251,191,36,0.4)') : T.line }]}>
              <View style={[s.statusDot, { backgroundColor: statusColor }]} />
              <View style={{ flex: 1 }}>
                <Text style={[s.statusTx, { color: statusColor }]}>{statusLine}</Text>
                <Text style={s.statusSub}>
                  This device is on build {APP_BUILD || '—'}
                  {savedAt ? ` · last changed ${new Date(savedAt).toLocaleString()}` : ''}
                </Text>
              </View>
            </View>

            <Text style={s.secTitle}>TARGET BUILD</Text>
            <View style={s.card}>
              <Text style={s.label}>iOS build everyone should be on</Text>
              <View style={s.row}>
                <TextInput
                  style={s.input}
                  value={iosBuild}
                  onChangeText={(t) => setIosBuild(t.replace(/[^0-9]/g, ''))}
                  keyboardType="number-pad"
                  placeholder="0"
                  placeholderTextColor={T.faint}
                />
                <TouchableOpacity style={s.useThis} onPress={() => APP_BUILD && setIosBuild(String(parseInt(APP_BUILD, 10) || 0))}>
                  <Text style={s.useThisTx}>Use this build ({APP_BUILD || '—'})</Text>
                </TouchableOpacity>
              </View>
              <Text style={s.hint}>0 turns the gate off for iOS. Anyone on a lower build is prompted.</Text>

              <View style={s.sep} />

              <Text style={s.label}>Android version code</Text>
              <TextInput
                style={s.input}
                value={androidCode}
                onChangeText={(t) => setAndroidCode(t.replace(/[^0-9]/g, ''))}
                keyboardType="number-pad"
                placeholder="0"
                placeholderTextColor={T.faint}
              />
              <Text style={s.hint}>0 turns the gate off for Android.</Text>
            </View>

            <Text style={s.secTitle}>IS IT COMPULSORY?</Text>
            <View style={[s.card, mandatory && { borderColor: 'rgba(248,113,113,0.4)', backgroundColor: 'rgba(248,113,113,0.07)' }]}>
              <View style={s.switchRow}>
                <View style={{ flex: 1, paddingRight: 12 }}>
                  <Text style={s.cardTitle}>Update is mandatory for all users</Text>
                  <Text style={s.cardDesc}>
                    {mandatory
                      ? 'ON — the prompt cannot be dismissed. Users below the target build cannot use the app until they update.'
                      : 'OFF — users below the target build see the prompt but can tap “Not now” and carry on.'}
                  </Text>
                </View>
                <Switch
                  value={mandatory}
                  onValueChange={flipMandatory}
                  trackColor={{ false: 'rgba(255,255,255,0.15)', true: 'rgba(248,113,113,0.5)' }}
                  thumbColor={mandatory ? T.red : '#f4f3f4'}
                />
              </View>
            </View>

            <Text style={s.secTitle}>WHAT THEY SEE</Text>
            <View style={s.card}>
              <Text style={s.label}>Title</Text>
              <TextInput style={s.input} value={title} onChangeText={setTitle} maxLength={120} placeholder={DEFAULT_TITLE} placeholderTextColor={T.faint} />
              <View style={{ height: 12 }} />
              <Text style={s.label}>Message</Text>
              <TextInput
                style={[s.input, s.textarea]}
                value={message}
                onChangeText={setMessage}
                multiline
                maxLength={500}
                placeholder={DEFAULT_MESSAGE}
                placeholderTextColor={T.faint}
              />
            </View>

            {/* The limit, said out loud. */}
            <View style={s.noteCard}>
              <Ionicons name="information-circle-outline" size={17} color={T.cyan} />
              <Text style={s.noteTx}>
                This only reaches builds that shipped with the update check (iOS 163 and later). Users on
                older builds are never asked, so no number here can prompt them — they update through the
                App Store as usual.
              </Text>
            </View>

            <TouchableOpacity style={s.saveBtn} onPress={save} disabled={saving} activeOpacity={0.9}>
              {saving ? <ActivityIndicator color="#04222B" /> : <Text style={s.saveTx}>Save</Text>}
            </TouchableOpacity>

            {armed && (
              <TouchableOpacity style={s.offBtn} onPress={turnOff} disabled={saving} activeOpacity={0.85}>
                <Text style={s.offTx}>Turn the gate off</Text>
              </TouchableOpacity>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
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
  secTitle: { color: T.faint, fontSize: 10.5, fontWeight: '800', letterSpacing: 1, marginBottom: 9, marginLeft: 2, marginTop: 18 },
  statusCard: { flexDirection: 'row', alignItems: 'center', gap: 11, backgroundColor: T.card, borderWidth: 1, borderRadius: 16, padding: 14 },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  statusTx: { fontSize: 13.5, fontWeight: '800' },
  statusSub: { color: T.faint, fontSize: 11, marginTop: 3 },
  card: { backgroundColor: T.card, borderWidth: 1, borderColor: T.line, borderRadius: 18, padding: 14 },
  cardTitle: { color: T.ink, fontSize: 14.5, fontWeight: '800' },
  cardDesc: { color: T.muted, fontSize: 11.5, lineHeight: 17, marginTop: 4 },
  switchRow: { flexDirection: 'row', alignItems: 'center' },
  label: { color: T.muted, fontSize: 12, fontWeight: '700', marginBottom: 7 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  input: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.28)', borderWidth: 1, borderColor: T.line, borderRadius: 12,
    paddingHorizontal: 12, paddingVertical: 10, color: T.ink, fontSize: 15, fontWeight: '700',
  },
  textarea: { height: 88, textAlignVertical: 'top', fontWeight: '400', fontSize: 13.5, lineHeight: 19 },
  useThis: { backgroundColor: 'rgba(34,211,238,0.14)', borderWidth: 1, borderColor: 'rgba(34,211,238,0.32)', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 },
  useThisTx: { color: T.cyan, fontSize: 12, fontWeight: '800' },
  hint: { color: T.faint, fontSize: 11, marginTop: 7, lineHeight: 15 },
  sep: { height: 1, backgroundColor: T.line, marginVertical: 14 },
  noteCard: { flexDirection: 'row', gap: 9, backgroundColor: 'rgba(34,211,238,0.07)', borderWidth: 1, borderColor: 'rgba(34,211,238,0.22)', borderRadius: 14, padding: 12, marginTop: 18 },
  noteTx: { flex: 1, color: T.muted, fontSize: 11.5, lineHeight: 17 },
  saveBtn: { backgroundColor: T.cyan, borderRadius: 14, height: 50, alignItems: 'center', justifyContent: 'center', marginTop: 18 },
  saveTx: { color: '#04222B', fontSize: 15, fontWeight: '800' },
  offBtn: { alignItems: 'center', paddingVertical: 14, marginTop: 4 },
  offTx: { color: T.faint, fontSize: 13, fontWeight: '700' },
});
