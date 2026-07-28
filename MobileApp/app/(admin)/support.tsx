// AI Hub — new feature. Safe to delete without affecting existing app.
//
// The support inbox: every user who needs help, and the conversation with each one.
//
// ⚠️ EXACTLY ONE <Modal> is ever mounted (a nested Modal hard-crashed iOS in build 87). The chat
// opens as an in-place view swap driven by `openId`, not as a second modal over the list.
//
// A reply is NOT behind the type-to-confirm gate. That gate exists so a broadcast to strangers
// cannot be sent by reflex; a reply is an answer to a person who is waiting for one, and putting a
// confirmation on every message would turn the gate into muscle memory — which is the exact failure
// it was built to prevent. Staff-INITIATED conversations do go through it, in user-360.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  TextInput, SafeAreaView, RefreshControl, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import {
  fetchSupportInbox, fetchAdminThread, sendAdminReply, setThreadStatus, markAdminThreadRead,
  type SupportThread, type SupportMessage, type SupportInbox,
} from '../../services/supportService';

const C = {
  bg: '#F0F4FA', card: '#FFFFFF', ink: '#0B0F22', muted: '#64748B', faint: '#94A3B8',
  line: '#E7EDF5', blue: '#2563EB', blueSoft: '#EFF6FF', blueLine: '#BFDBFE',
  emerald: '#10B981', amber: '#F59E0B', rose: '#E11D48',
};

const ago = (iso?: string | null) => {
  if (!iso) return '';
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(m)) return '';
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
};
const when = (iso: string) => {
  try { return new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
};

export default function AdminSupport() {
  const router = useRouter();
  const params = useLocalSearchParams<{ threadId?: string }>();

  const [inbox, setInbox] = useState<SupportInbox | null>(null);
  const [filter, setFilter] = useState<'open' | 'resolved' | 'all'>('open');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Which thread is open. A view swap, never a second Modal.
  const [openId, setOpenId] = useState<string | null>(params.threadId ? String(params.threadId) : null);
  const [thread, setThread] = useState<SupportThread | null>(null);
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [chatErr, setChatErr] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView | null>(null);

  const load = useCallback(async (isRefresh?: boolean) => {
    if (isRefresh) setRefreshing(true);
    try { setInbox(await fetchSupportInbox(filter)); setError(null); }
    catch (e: any) { setError(e?.message || 'Could not load the inbox'); }
    finally { setLoading(false); setRefreshing(false); }
  }, [filter]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  const openThread = useCallback(async (id: string) => {
    setOpenId(id); setChatLoading(true); setChatErr(null); setReply('');
    try {
      const v = await fetchAdminThread(id);
      setThread(v.thread); setMessages(v.messages);
      await markAdminThreadRead(id);
      load();
    } catch (e: any) { setChatErr(e?.message || 'Could not load the conversation'); }
    finally { setChatLoading(false); }
  }, [load]);

  // A push tap arrives with ?threadId= — open it straight away.
  useEffect(() => { if (params.threadId) openThread(String(params.threadId)); /* eslint-disable-next-line */ }, [params.threadId]);

  const send = useCallback(async () => {
    const body = reply.trim();
    if (!body || !openId || sending) return;
    setSending(true); setChatErr(null);
    try {
      const { message } = await sendAdminReply(openId, body);
      setMessages((p) => [...p, message]);
      setReply('');
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 60);
      load();
    } catch (e: any) { setChatErr(e?.message || 'Could not send the reply'); }
    finally { setSending(false); }
  }, [reply, openId, sending, load]);

  const toggleStatus = useCallback(async () => {
    if (!thread) return;
    try {
      const t = await setThreadStatus(thread.id, thread.status === 'open' ? 'resolved' : 'open');
      setThread(t); load();
    } catch (e: any) { setChatErr(e?.message || 'Could not update'); }
  }, [thread, load]);

  // ── chat view ──────────────────────────────────────────────────────────────
  if (openId) {
    return (
      <SafeAreaView style={s.root}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={Platform.OS === 'ios' ? 8 : 0}>
          <View style={s.chatHead}>
            <TouchableOpacity onPress={() => { setOpenId(null); setThread(null); setMessages([]); }} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="arrow-back" size={21} color={C.ink} />
            </TouchableOpacity>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={s.chatT} numberOfLines={1}>{thread?.user?.name || thread?.user?.email || 'User'}</Text>
              <Text style={s.chatB} numberOfLines={1}>{thread?.issue_title || ''}</Text>
            </View>
            {thread ? (
              <TouchableOpacity style={s.statusBtn} onPress={toggleStatus} activeOpacity={0.8}>
                <Ionicons name={thread.status === 'open' ? 'checkmark-done-outline' : 'refresh-outline'} size={13} color={C.blue} />
                <Text style={s.statusBtnT}>{thread.status === 'open' ? 'Resolve' : 'Reopen'}</Text>
              </TouchableOpacity>
            ) : null}
          </View>

          {thread?.user ? (
            <TouchableOpacity
              style={s.userStrip}
              activeOpacity={0.8}
              onPress={() => router.push({ pathname: '/(admin)/user-360', params: { userId: String(thread.user!.id) } })}
            >
              <Ionicons name="person-circle-outline" size={15} color={C.blue} />
              <Text style={s.userStripT} numberOfLines={1}>{thread.user.email} · open their full profile</Text>
              <Ionicons name="chevron-forward" size={13} color={C.blue} />
            </TouchableOpacity>
          ) : null}

          {chatLoading ? (
            <View style={s.center}><ActivityIndicator color={C.blue} size="large" /></View>
          ) : (
            <ScrollView
              ref={scrollRef}
              style={{ flex: 1 }}
              contentContainerStyle={{ padding: 16, paddingBottom: 16 }}
              onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
            >
              {messages.map((m) => {
                const staff = m.sender === 'admin';
                return (
                  <View key={m.id} style={[s.row, staff ? s.rowRight : s.rowLeft]}>
                    <View style={[s.bubble, staff ? s.staff : s.theirs]}>
                      <Text style={[s.body, staff && { color: '#FFFFFF' }]} selectable>{m.body}</Text>
                      <Text style={[s.time, staff && { color: 'rgba(255,255,255,0.75)' }]}>{when(m.created_at)}</Text>
                    </View>
                  </View>
                );
              })}
              {!messages.length ? <Text style={s.empty}>No messages.</Text> : null}
            </ScrollView>
          )}

          <View style={s.composer}>
            {chatErr ? <Text style={s.sendErr}>{chatErr}</Text> : null}
            <View style={s.composerRow}>
              <TextInput
                value={reply}
                onChangeText={(v) => { setReply(v); if (chatErr) setChatErr(null); }}
                style={s.input}
                placeholder="Reply to this user…"
                placeholderTextColor={C.faint}
                multiline
                maxLength={2000}
              />
              <TouchableOpacity
                style={[s.sendBtn, (!reply.trim() || sending) && s.sendOff]}
                onPress={send}
                disabled={!reply.trim() || sending}
                activeOpacity={0.85}
              >
                {sending ? <ActivityIndicator color="#FFFFFF" size="small" /> : <Ionicons name="send" size={17} color="#FFFFFF" />}
              </TouchableOpacity>
            </View>
            <Text style={s.composerHint}>Goes straight to this user’s phone as a notification.</Text>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  // ── inbox ──────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={s.root}>
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={C.blue} />}
      >
        <Text style={s.h1}>Support</Text>
        <Text style={s.sub}>Issues users have reported, newest and unanswered first.</Text>

        {inbox ? (
          <View style={s.chips}>
            <View style={[s.chip, inbox.counts.waiting > 0 && { borderColor: C.rose, backgroundColor: '#FEF2F2' }]}>
              <Text style={[s.chipN, inbox.counts.waiting > 0 && { color: C.rose }]}>{inbox.counts.waiting}</Text>
              <Text style={s.chipL}>waiting on us</Text>
            </View>
            <View style={s.chip}><Text style={s.chipN}>{inbox.counts.open}</Text><Text style={s.chipL}>open</Text></View>
            <View style={s.chip}><Text style={s.chipN}>{inbox.counts.total}</Text><Text style={s.chipL}>all time</Text></View>
          </View>
        ) : null}

        <View style={s.tabs}>
          {(['open', 'resolved', 'all'] as const).map((f) => (
            <TouchableOpacity key={f} style={[s.tab, filter === f && s.tabOn]} onPress={() => setFilter(f)} activeOpacity={0.8}>
              <Text style={[s.tabT, filter === f && s.tabTOn]}>{f[0].toUpperCase() + f.slice(1)}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {loading ? (
          <View style={s.center}><ActivityIndicator color={C.blue} size="large" /></View>
        ) : error ? (
          <View style={s.errBox}>
            <Text style={s.errT}>{error}</Text>
            <TouchableOpacity onPress={() => load()}><Text style={s.errRetry}>Try again</Text></TouchableOpacity>
          </View>
        ) : !inbox || !inbox.threads.length ? (
          <View style={s.emptyBox}>
            <Ionicons name="chatbubbles-outline" size={34} color={C.faint} />
            <Text style={s.emptyT}>Nothing here</Text>
            <Text style={s.emptyB}>
              {filter === 'open' ? 'No open conversations. Users can start one from Help & support.' : 'No conversations in this view.'}
            </Text>
          </View>
        ) : (
          inbox.threads.map((t) => (
            <TouchableOpacity key={t.id} style={s.item} activeOpacity={0.85} onPress={() => openThread(t.id)}>
              <View style={[s.itemIcon, t.unread > 0 && { backgroundColor: '#FEF2F2', borderColor: '#FECACA' }]}>
                <Ionicons name={(t.issue_icon || 'chatbubble-outline') as any} size={17} color={t.unread > 0 ? C.rose : C.muted} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <View style={s.itemTop}>
                  <Text style={s.itemName} numberOfLines={1}>{t.user?.name || t.user?.email || `User ${t.user?.id}`}</Text>
                  <Text style={s.itemAgo}>{ago(t.last_message_at)}</Text>
                </View>
                <Text style={s.itemIssue} numberOfLines={1}>{t.issue_title}</Text>
                <Text style={s.itemBody} numberOfLines={2}>
                  {t.last_sender === 'admin' ? 'You: ' : ''}{t.last_body || '—'}
                </Text>
              </View>
              {t.unread > 0 ? <View style={s.badge}><Text style={s.badgeT}>{t.unread}</Text></View> : null}
            </TouchableOpacity>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  center: { paddingVertical: 40, alignItems: 'center', justifyContent: 'center' },
  h1: { fontSize: 24, fontWeight: '900', color: C.ink, letterSpacing: -0.6 },
  sub: { fontSize: 13, color: C.muted, marginTop: 4, marginBottom: 14, lineHeight: 19 },

  chips: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  chip: { flex: 1, backgroundColor: C.card, borderColor: C.line, borderWidth: 1, borderRadius: 12, padding: 11, alignItems: 'center' },
  chipN: { fontSize: 19, fontWeight: '900', color: C.ink },
  chipL: { fontSize: 10.5, color: C.faint, fontWeight: '700', marginTop: 2, textAlign: 'center' },

  tabs: { flexDirection: 'row', gap: 7, marginBottom: 12 },
  tab: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: C.card, borderColor: C.line, borderWidth: 1 },
  tabOn: { backgroundColor: C.blue, borderColor: C.blue },
  tabT: { fontSize: 12.5, fontWeight: '800', color: C.muted },
  tabTOn: { color: '#FFFFFF' },

  item: {
    flexDirection: 'row', alignItems: 'center', gap: 11,
    backgroundColor: C.card, borderColor: C.line, borderWidth: 1, borderRadius: 14, padding: 12, marginBottom: 8,
  },
  itemIcon: {
    width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#F8FAFC', borderColor: C.line, borderWidth: 1,
  },
  itemTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  itemName: { flex: 1, fontSize: 14, fontWeight: '800', color: C.ink },
  itemAgo: { fontSize: 11, color: C.faint, fontWeight: '700' },
  itemIssue: { fontSize: 11.5, color: C.blue, fontWeight: '700', marginTop: 2 },
  itemBody: { fontSize: 12.5, color: C.muted, marginTop: 3, lineHeight: 17 },
  badge: { minWidth: 22, height: 22, borderRadius: 11, backgroundColor: C.rose, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  badgeT: { fontSize: 11, fontWeight: '900', color: '#FFFFFF' },

  emptyBox: { alignItems: 'center', paddingVertical: 46, gap: 8 },
  emptyT: { fontSize: 15, fontWeight: '800', color: C.ink },
  emptyB: { fontSize: 12.5, color: C.faint, textAlign: 'center', paddingHorizontal: 30, lineHeight: 18 },
  errBox: { backgroundColor: '#FEF2F2', borderColor: '#FECACA', borderWidth: 1, borderRadius: 12, padding: 13, gap: 6 },
  errT: { fontSize: 12.5, color: '#9F1239', fontWeight: '700' },
  errRetry: { fontSize: 12.5, fontWeight: '800', color: C.blue },

  chatHead: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: C.card, borderBottomColor: C.line, borderBottomWidth: 1,
    paddingHorizontal: 16, paddingVertical: 11,
  },
  chatT: { fontSize: 15, fontWeight: '900', color: C.ink },
  chatB: { fontSize: 11.5, color: C.blue, fontWeight: '700', marginTop: 2 },
  statusBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: C.blueSoft, borderColor: C.blueLine, borderWidth: 1,
    borderRadius: 9, paddingHorizontal: 10, paddingVertical: 7,
  },
  statusBtnT: { fontSize: 11.5, fontWeight: '800', color: C.blue },
  userStrip: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    backgroundColor: C.blueSoft, borderBottomColor: C.blueLine, borderBottomWidth: 1,
    paddingHorizontal: 16, paddingVertical: 9,
  },
  userStripT: { flex: 1, fontSize: 11.5, color: C.blue, fontWeight: '700' },

  row: { flexDirection: 'row', marginBottom: 10 },
  rowRight: { justifyContent: 'flex-end' },
  rowLeft: { justifyContent: 'flex-start' },
  bubble: { maxWidth: '84%', borderRadius: 16, paddingHorizontal: 13, paddingVertical: 10 },
  staff: { backgroundColor: C.blue, borderBottomRightRadius: 5 },
  theirs: { backgroundColor: C.card, borderColor: C.line, borderWidth: 1, borderBottomLeftRadius: 5 },
  body: { fontSize: 14, color: C.ink, lineHeight: 20 },
  time: { fontSize: 10, color: C.faint, marginTop: 5, fontWeight: '600' },
  empty: { fontSize: 13, color: C.faint, textAlign: 'center', marginTop: 30 },

  composer: { backgroundColor: C.card, borderTopColor: C.line, borderTopWidth: 1, padding: 10 },
  composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 9 },
  composerHint: { fontSize: 10.5, color: C.faint, marginTop: 6, marginLeft: 4 },
  input: {
    flex: 1, backgroundColor: '#F8FAFC', borderColor: C.line, borderWidth: 1, borderRadius: 20,
    paddingHorizontal: 14, paddingTop: 10, paddingBottom: 10, maxHeight: 120, fontSize: 14, color: C.ink,
  },
  sendBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: C.blue, alignItems: 'center', justifyContent: 'center' },
  sendOff: { opacity: 0.45 },
  sendErr: { fontSize: 12, color: C.rose, fontWeight: '700', marginBottom: 6, marginLeft: 4 },
});
