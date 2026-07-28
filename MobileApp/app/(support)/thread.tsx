// AI Hub — new feature. Safe to delete without affecting existing app.
//
// One support conversation, from the user's side.
//
// This is also where a push lands: staff can start a conversation about a problem they spotted in
// the user's data, and the notification deep-links straight here so the user opens the app already
// inside the relevant thread rather than at a blank help form.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity,
  ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import {
  fetchThread, sendSupportMessage, markThreadRead, setThreadMuted,
  type SupportMessage, type SupportThread,
} from '../../services/supportService';

const C = {
  bg: '#F0F4FA', card: '#FFFFFF', ink: '#0B0F22', muted: '#64748B', faint: '#94A3B8',
  line: '#E7EDF5', blue: '#2563EB', rose: '#E11D48',
};

const when = (iso: string) => {
  try { return new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
};

export default function SupportThreadScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const router = useRouter();
  const threadId = String(id || '');

  const [thread, setThread] = useState<SupportThread | null>(null);
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView | null>(null);

  const load = useCallback(async () => {
    if (!threadId) { setError('No conversation was specified.'); setLoading(false); return; }
    try {
      const v = await fetchThread(threadId);
      setThread(v.thread); setMessages(v.messages); setError(null);
      markThreadRead(threadId);
    } catch (e: any) {
      setError(e?.message || 'Could not load the conversation');
    } finally { setLoading(false); }
  }, [threadId]);

  useEffect(() => { load(); }, [load]);
  // Poll gently while the screen is open so a reply appears without the user pulling to refresh.
  useFocusEffect(useCallback(() => {
    const t = setInterval(() => {
      fetchThread(threadId).then((v) => { setThread(v.thread); setMessages(v.messages); markThreadRead(threadId); }).catch(() => {});
    }, 15000);
    return () => clearInterval(t);
  }, [threadId]));

  const send = useCallback(async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true); setSendErr(null);
    try {
      const m = await sendSupportMessage(threadId, body);
      setMessages((prev) => [...prev, m]);
      setText('');
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 60);
    } catch (e: any) {
      // The server's own words: "too quickly", "closed", etc. are more use than a generic failure.
      setSendErr(e?.message || 'Could not send');
    } finally { setSending(false); }
  }, [text, sending, threadId]);

  const toggleMute = useCallback(async () => {
    if (!thread) return;
    try {
      const muted = await setThreadMuted(threadId, !thread.muted);
      setThread({ ...thread, muted });
    } catch { /* leave the state alone if it failed */ }
  }, [thread, threadId]);

  if (loading) {
    return <View style={s.center}><ActivityIndicator color={C.blue} size="large" /></View>;
  }
  if (error) {
    return (
      <View style={s.center}>
        <Ionicons name="alert-circle-outline" size={34} color={C.faint} />
        <Text style={s.errT}>{error}</Text>
        <TouchableOpacity onPress={() => router.back()}><Text style={s.back}>Go back</Text></TouchableOpacity>
      </View>
    );
  }

  const closed = thread?.status === 'resolved';

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: C.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 92 : 0}
    >
      <View style={s.head}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.headT} numberOfLines={1}>{thread?.issue_title || 'Support'}</Text>
          <Text style={s.headB}>{closed ? 'Resolved' : 'Open · we usually reply within a day'}</Text>
        </View>
        <TouchableOpacity onPress={toggleMute} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name={thread?.muted ? 'notifications-off-outline' : 'notifications-outline'} size={19} color={thread?.muted ? C.faint : C.blue} />
        </TouchableOpacity>
      </View>

      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 20 }}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
      >
        {messages.map((m) => {
          const mine = m.sender === 'you' || m.sender === 'user';
          return (
            <View key={m.id} style={[s.row, mine ? s.rowMine : s.rowTheirs]}>
              <View style={[s.bubble, mine ? s.mine : s.theirs]}>
                {!mine ? <Text style={s.from}>Support</Text> : null}
                <Text style={[s.body, mine && { color: '#FFFFFF' }]} selectable>{m.body}</Text>
                <Text style={[s.time, mine && { color: 'rgba(255,255,255,0.75)' }]}>{when(m.created_at)}</Text>
              </View>
            </View>
          );
        })}
        {!messages.length ? <Text style={s.empty}>No messages yet.</Text> : null}
      </ScrollView>

      {closed ? (
        <View style={s.closedBar}>
          <Ionicons name="checkmark-circle-outline" size={16} color="#047857" />
          <Text style={s.closedT}>This conversation is resolved. Start a new report if you need more help.</Text>
        </View>
      ) : (
        <View style={s.composer}>
          {sendErr ? <Text style={s.sendErr}>{sendErr}</Text> : null}
          <View style={s.composerRow}>
            <TextInput
              value={text}
              onChangeText={(v) => { setText(v); if (sendErr) setSendErr(null); }}
              style={s.input}
              placeholder="Write a message…"
              placeholderTextColor={C.faint}
              multiline
              maxLength={2000}
            />
            <TouchableOpacity
              style={[s.sendBtn, (!text.trim() || sending) && s.sendOff]}
              onPress={send}
              disabled={!text.trim() || sending}
              activeOpacity={0.85}
            >
              {sending ? <ActivityIndicator color="#FFFFFF" size="small" /> : <Ionicons name="send" size={17} color="#FFFFFF" />}
            </TouchableOpacity>
          </View>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg, gap: 10, padding: 24 },
  errT: { fontSize: 13.5, color: C.muted, textAlign: 'center', lineHeight: 20 },
  back: { fontSize: 13, fontWeight: '800', color: C.blue, marginTop: 4 },

  head: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: C.card, borderBottomColor: C.line, borderBottomWidth: 1,
    paddingHorizontal: 16, paddingVertical: 11,
  },
  headT: { fontSize: 15, fontWeight: '900', color: C.ink },
  headB: { fontSize: 11.5, color: C.faint, fontWeight: '600', marginTop: 2 },

  row: { flexDirection: 'row', marginBottom: 10 },
  rowMine: { justifyContent: 'flex-end' },
  rowTheirs: { justifyContent: 'flex-start' },
  bubble: { maxWidth: '84%', borderRadius: 16, paddingHorizontal: 13, paddingVertical: 10 },
  mine: { backgroundColor: C.blue, borderBottomRightRadius: 5 },
  theirs: { backgroundColor: C.card, borderColor: C.line, borderWidth: 1, borderBottomLeftRadius: 5 },
  from: { fontSize: 10.5, fontWeight: '900', color: C.blue, letterSpacing: 0.4, marginBottom: 3 },
  body: { fontSize: 14, color: C.ink, lineHeight: 20 },
  time: { fontSize: 10, color: C.faint, marginTop: 5, fontWeight: '600' },
  empty: { fontSize: 13, color: C.faint, textAlign: 'center', marginTop: 30 },

  composer: { backgroundColor: C.card, borderTopColor: C.line, borderTopWidth: 1, padding: 10 },
  composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 9 },
  input: {
    flex: 1, backgroundColor: '#F8FAFC', borderColor: C.line, borderWidth: 1, borderRadius: 20,
    paddingHorizontal: 14, paddingTop: 10, paddingBottom: 10, maxHeight: 120, fontSize: 14, color: C.ink,
  },
  sendBtn: {
    width: 44, height: 44, borderRadius: 22, backgroundColor: C.blue,
    alignItems: 'center', justifyContent: 'center',
  },
  sendOff: { opacity: 0.45 },
  sendErr: { fontSize: 12, color: C.rose, fontWeight: '700', marginBottom: 6, marginLeft: 4 },

  closedBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#ECFDF5', borderTopColor: '#A7F3D0', borderTopWidth: 1, padding: 13,
  },
  closedT: { flex: 1, fontSize: 12.5, color: '#047857', fontWeight: '700', lineHeight: 17 },
});
