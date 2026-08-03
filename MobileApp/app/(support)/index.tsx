// AI Hub — new feature. Safe to delete without affecting existing app.
//
// "Are you facing any issues?" — the user picks what is going wrong from a short list, optionally
// adds detail, and that opens a conversation with a real person.
//
// Two design notes worth keeping:
//   • Existing conversations are shown ABOVE the cards. Someone who already reported a problem and
//     came back is looking for the reply, not for the form — putting the form first makes them open
//     a second report about the same thing.
//   • The cards describe SYMPTOMS in the user's words ("Cover letter would not generate"), not our
//     subsystems. Somebody who cannot apply to a job does not know whether that is autofill, the
//     WebView or the job URL, and should not have to.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  TextInput, RefreshControl, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useFocusEffect, useLocalSearchParams } from 'expo-router';
// expo-router generates its typed-route table during prebuild, so a route folder added in this
// same commit is not in it yet and `router.push('/(support)/thread')` fails typecheck until the
// next build regenerates it. The path is real — this widens the type without silencing anything
// else, and it goes away on its own once the table includes (support).
const THREAD_ROUTE = '/(support)/thread' as never;

import {
  fetchSupportIssues, fetchMyThreads, startSupportThread,
  type SupportIssue, type SupportThread,
} from '../../services/supportService';

const C = {
  bg: '#F0F4FA', card: '#FFFFFF', ink: '#0B0F22', muted: '#64748B', faint: '#94A3B8',
  line: '#E7EDF5', blue: '#2563EB', blueSoft: '#EFF6FF', blueLine: '#BFDBFE',
  emerald: '#10B981', amber: '#F59E0B', rose: '#E11D48',
};

function timeAgo(iso?: string | null): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 7 ? `${d}d ago` : new Date(iso).toLocaleDateString();
}

export default function SupportHome() {
  const router = useRouter();
  // Arriving from the "are you facing any issue?" push. `focus` scrolls to and highlights the
  // picker; `issue` pre-selects one card when the notification already knew the symptom. Neither
  // writes anything — the user still chooses and still types, because a ticket the app filed on
  // their behalf would tell support what WE guessed, not what actually happened to them.
  const params = useLocalSearchParams<{ focus?: string; issue?: string }>();
  const wantsFocus = String(params.focus || '') === '1';
  const wantsIssue = String(params.issue || '').trim().toLowerCase();
  const scrollRef = useRef<ScrollView | null>(null);
  const pickerY = useRef(0);
  const focusedOnce = useRef(false);

  const [issues, setIssues] = useState<SupportIssue[]>([]);
  const [detailsMax, setDetailsMax] = useState(1500);
  const [threads, setThreads] = useState<SupportThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [picked, setPicked] = useState<SupportIssue | null>(null);
  const [details, setDetails] = useState('');
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState<string | null>(null);

  const load = useCallback(async (isRefresh?: boolean) => {
    if (isRefresh) setRefreshing(true);
    try {
      const [i, t] = await Promise.all([fetchSupportIssues(), fetchMyThreads()]);
      setIssues(i.issues); setDetailsMax(i.detailsMax); setThreads(t.threads); setError(null);
    } catch (e: any) {
      setError(e?.message || 'Could not load help');
    } finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { load(); }, [load]);
  // Coming back from a conversation should show the new state, not a stale badge.
  useFocusEffect(useCallback(() => { fetchMyThreads().then((t) => setThreads(t.threads)).catch(() => {}); }, []));

  // Once the issue cards exist, act on the deep link. Guarded by focusedOnce so returning from a
  // thread does not yank the user back down the page, and so a re-render cannot re-open a card
  // they deliberately closed.
  useEffect(() => {
    if (focusedOnce.current || !issues.length) return;
    if (!wantsFocus && !wantsIssue) return;
    focusedOnce.current = true;
    if (wantsIssue) {
      const hit = issues.find((i) => i.key === wantsIssue);
      if (hit) setPicked(hit);
    }
    // Let the list lay out first — pickerY is measured by onLayout below.
    const t = setTimeout(() => {
      try { scrollRef.current?.scrollTo({ y: Math.max(0, pickerY.current - 12), animated: true }); } catch { /* ignore */ }
    }, 350);
    return () => clearTimeout(t);
  }, [issues, wantsFocus, wantsIssue]);

  const submit = useCallback(async () => {
    if (!picked || sending) return;
    setSending(true); setSendErr(null);
    try {
      const { thread } = await startSupportThread(picked.key, details.trim());
      setPicked(null); setDetails('');
      router.push({ pathname: THREAD_ROUTE, params: { id: thread.id } });
    } catch (e: any) {
      setSendErr(e?.message || 'Could not start the report');
    } finally { setSending(false); }
  }, [picked, details, sending, router]);

  if (loading) {
    return <View style={s.center}><ActivityIndicator color={C.blue} size="large" /><Text style={s.centerT}>Loading…</Text></View>;
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        ref={scrollRef}
        style={s.root}
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={C.blue} />}
      >
        {error ? (
          <View style={s.errBox}>
            <Ionicons name="cloud-offline-outline" size={18} color={C.rose} />
            <Text style={s.errT}>{error}</Text>
            <TouchableOpacity onPress={() => load()}><Text style={s.errRetry}>Try again</Text></TouchableOpacity>
          </View>
        ) : null}

        {/* Existing conversations first — a returning user is here for the reply. */}
        {threads.length ? (
          <View style={{ marginBottom: 22 }}>
            <Text style={s.h2}>Your conversations</Text>
            {threads.map((t) => (
              <TouchableOpacity
                key={t.id}
                style={s.thread}
                activeOpacity={0.8}
                onPress={() => router.push({ pathname: THREAD_ROUTE, params: { id: t.id } })}
              >
                <View style={[s.threadIcon, t.unread > 0 && { backgroundColor: C.blueSoft, borderColor: C.blueLine }]}>
                  <Ionicons name={(t.issue_icon || 'chatbubble-outline') as any} size={17} color={t.unread > 0 ? C.blue : C.muted} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={s.threadTop}>
                    <Text style={s.threadT} numberOfLines={1}>{t.issue_title}</Text>
                    {t.status === 'resolved'
                      ? <View style={s.doneChip}><Text style={s.doneChipT}>Resolved</Text></View>
                      : t.unread > 0 ? <View style={s.dot} /> : null}
                  </View>
                  <Text style={s.threadB} numberOfLines={2}>
                    {t.last_sender === 'admin' ? 'Support: ' : ''}{t.last_body || '—'}
                  </Text>
                  <Text style={s.threadTime}>{timeAgo(t.last_message_at)}</Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={C.faint} />
              </TouchableOpacity>
            ))}
          </View>
        ) : null}

        <View onLayout={(e) => { pickerY.current = e.nativeEvent.layout.y; }}>
          <Text style={s.h1}>Are you facing any issues?</Text>
          <Text style={s.sub}>
            Pick what is going wrong and a real person will get back to you here. The more you tell us,
            the faster we can fix it.
          </Text>
        </View>

        {issues.map((i) => {
          const on = picked?.key === i.key;
          return (
            <View key={i.key}>
              <TouchableOpacity
                style={[s.card, on && s.cardOn]}
                activeOpacity={0.85}
                onPress={() => { setPicked(on ? null : i); setSendErr(null); }}
              >
                <View style={[s.cardIcon, on && { backgroundColor: C.blue }]}>
                  <Ionicons name={(i.icon || 'help-circle-outline') as any} size={18} color={on ? '#FFFFFF' : C.blue} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[s.cardT, on && { color: C.blue }]}>{i.title}</Text>
                  <Text style={s.cardB}>{i.blurb}</Text>
                </View>
                <Ionicons name={on ? 'chevron-up' : 'chevron-down'} size={16} color={on ? C.blue : C.faint} />
              </TouchableOpacity>

              {on ? (
                <View style={s.form}>
                  <Text style={s.formL}>Anything else we should know? <Text style={s.optional}>(optional)</Text></Text>
                  <TextInput
                    value={details}
                    onChangeText={setDetails}
                    style={s.input}
                    placeholder="What were you doing when it happened? A link or a company name helps a lot."
                    placeholderTextColor={C.faint}
                    multiline
                    maxLength={detailsMax}
                    textAlignVertical="top"
                  />
                  <Text style={s.count}>{details.length}/{detailsMax}</Text>
                  {sendErr ? <Text style={s.formErr}>{sendErr}</Text> : null}
                  <TouchableOpacity
                    style={[s.submit, sending && s.submitOff]}
                    onPress={submit}
                    disabled={sending}
                    activeOpacity={0.85}
                  >
                    {sending
                      ? <ActivityIndicator color="#FFFFFF" size="small" />
                      : <><Ionicons name="chatbubbles-outline" size={15} color="#FFFFFF" /><Text style={s.submitT}>Chat with a specialist</Text></>}
                  </TouchableOpacity>
                  <Text style={s.formHint}>
                    This opens a conversation with our team. You will get a notification when they reply.
                  </Text>
                </View>
              ) : null}
            </View>
          );
        })}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg, gap: 10 },
  centerT: { fontSize: 13, color: C.muted, fontWeight: '600' },

  h1: { fontSize: 21, fontWeight: '900', color: C.ink, letterSpacing: -0.4 },
  h2: { fontSize: 12, fontWeight: '900', color: C.muted, letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 8 },
  sub: { fontSize: 13.5, color: C.muted, lineHeight: 20, marginTop: 6, marginBottom: 16 },

  thread: {
    flexDirection: 'row', alignItems: 'center', gap: 11,
    backgroundColor: C.card, borderColor: C.line, borderWidth: 1, borderRadius: 14,
    padding: 12, marginBottom: 8,
  },
  threadIcon: {
    width: 38, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#F8FAFC', borderColor: C.line, borderWidth: 1,
  },
  threadTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  threadT: { flex: 1, fontSize: 14, fontWeight: '800', color: C.ink },
  threadB: { fontSize: 12.5, color: C.muted, marginTop: 3, lineHeight: 17 },
  threadTime: { fontSize: 11, color: C.faint, fontWeight: '600', marginTop: 4 },
  dot: { width: 9, height: 9, borderRadius: 5, backgroundColor: C.blue },
  doneChip: { backgroundColor: '#ECFDF5', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 },
  doneChipT: { fontSize: 10, fontWeight: '800', color: '#047857' },

  card: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: C.card, borderColor: C.line, borderWidth: 1, borderRadius: 14,
    padding: 13, marginBottom: 9,
  },
  cardOn: { borderColor: C.blueLine, backgroundColor: '#FBFDFF' },
  cardIcon: {
    width: 38, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.blueSoft, borderColor: C.blueLine, borderWidth: 1,
  },
  cardT: { fontSize: 14.5, fontWeight: '800', color: C.ink },
  cardB: { fontSize: 12.5, color: C.muted, marginTop: 3, lineHeight: 17 },

  form: {
    backgroundColor: C.card, borderColor: C.blueLine, borderWidth: 1, borderRadius: 14,
    padding: 13, marginTop: -4, marginBottom: 12,
  },
  formL: { fontSize: 12, fontWeight: '800', color: C.ink },
  optional: { color: C.faint, fontWeight: '600' },
  input: {
    backgroundColor: '#F8FAFC', borderColor: C.line, borderWidth: 1, borderRadius: 11,
    padding: 11, minHeight: 96, fontSize: 13.5, color: C.ink, marginTop: 8, lineHeight: 19,
  },
  count: { fontSize: 10.5, color: C.faint, fontWeight: '700', textAlign: 'right', marginTop: 4 },
  formErr: { fontSize: 12.5, color: C.rose, fontWeight: '700', marginTop: 6 },
  submit: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: C.blue, borderRadius: 12, height: 46, marginTop: 10,
  },
  submitOff: { opacity: 0.6 },
  submitT: { fontSize: 14.5, fontWeight: '800', color: '#FFFFFF' },
  formHint: { fontSize: 11, color: C.faint, marginTop: 8, lineHeight: 16 },

  errBox: {
    flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 14,
    backgroundColor: '#FEF2F2', borderColor: '#FECACA', borderWidth: 1, borderRadius: 12, padding: 11,
  },
  errT: { flex: 1, fontSize: 12.5, color: '#9F1239', fontWeight: '700' },
  errRetry: { fontSize: 12.5, fontWeight: '800', color: C.blue },
});
