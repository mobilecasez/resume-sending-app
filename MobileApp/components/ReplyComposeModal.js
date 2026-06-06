import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Modal,
  ScrollView, ActivityIndicator, Alert, KeyboardAvoidingView,
  Platform, Linking,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';

const T = {
  bg: '#E5EAF3',
  surface: '#FFFFFF',
  ink: '#0B0F22',
  inkFaint: '#6B7280',
  blue: '#4F8DFF',
  purple: '#7C6BFF',
  purpleDeep: '#5B4FD9',
  border: '#D1D9E6',
  green: '#22C55E',
  red: '#EF4444',
};

export default function ReplyComposeModal({
  visible,
  onClose,
  app,           // the application object
  user,
  API_BASE,
  onReplySent,   // callback after successful send
}) {
  const [replyBody, setReplyBody] = useState('');
  const [subject, setSubject] = useState('');
  const [threadChain, setThreadChain] = useState('');
  const [loadingThread, setLoadingThread] = useState(false);
  const [sending, setSending] = useState(false);
  const scrollRef = useRef(null);

  const isMicrosoft = user?.provider === 'microsoft' || user?.oauth_provider === 'microsoft';
  const isGoogle    = user?.provider === 'google'    || user?.oauth_provider === 'google';
  const fromEmail   = user?.email || '';
  const toEmail     = app?.recipientEmail || '';

  // Load thread when modal opens
  useEffect(() => {
    if (!visible || !app) return;

    const rawSubject = app.replySubject
      ? (app.replySubject.startsWith('Re:') ? app.replySubject : `Re: ${app.replySubject}`)
      : `Re: Application for ${app.position || 'the position'} at ${app.companyName || 'your company'}`;
    setSubject(rawSubject);
    setReplyBody('');
    setThreadChain('');

    const fetchThread = async () => {
      setLoadingThread(true);
      try {
        const res = await fetch(`${API_BASE}/users/application-history/${app.id}/replies`, {
          headers: { Authorization: `Bearer ${user?.token}` }
        });
        if (res.ok) {
          const result = await res.json();
          if (result.success && result.replies?.length > 0) {
            const sorted = [...result.replies].reverse(); // oldest first
            const chain = sorted.map(r => {
              const dateStr = r.replyDate ? new Date(r.replyDate).toLocaleString() : '';
              return `--- On ${dateStr}, ${r.replyFromEmail || toEmail} wrote ---\n${r.replySnippet || ''}`;
            }).join('\n\n');
            setThreadChain(chain);
          }
        }
      } catch (_) {}
      setLoadingThread(false);
    };

    fetchThread();
  }, [visible, app?.id]);

  const handleSendInApp = async () => {
    if (!replyBody.trim()) {
      Alert.alert('Empty reply', 'Please write your reply before sending.');
      return;
    }

    setSending(true);
    try {
      const fullBody = `${replyBody.trim()}${threadChain ? `\n\n${threadChain}` : ''}`;
      const res = await fetch(`${API_BASE}/send-reply`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user?.token}`
        },
        body: JSON.stringify({
          applicationId: app.id,
          companyName: app.companyName,
          to: toEmail,
          subject,
          body: fullBody,
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Send failed');

      Alert.alert('Sent!', `Your reply was sent from ${fromEmail}.`);
      onReplySent?.();
      onClose();
    } catch (err) {
      Alert.alert('Failed to send', err.message || 'Please try again.');
    }
    setSending(false);
  };

  const handleOpenInApp = async () => {
    const subjectEncoded = encodeURIComponent(subject);
    const fullBody = `${replyBody.trim()}${threadChain ? `\n\n${threadChain}` : ''}`;
    const bodyEncoded = encodeURIComponent(fullBody);
    const toEncoded = encodeURIComponent(toEmail);

    const outlookLink = `ms-outlook://compose?to=${toEncoded}&subject=${subjectEncoded}&body=${bodyEncoded}`;
    const gmailLinkiOS = `googlegmail://co?to=${toEncoded}&subject=${subjectEncoded}&body=${bodyEncoded}`;
    const gmailLinkAndroid = `intent://co?to=${toEncoded}&subject=${subjectEncoded}&body=${bodyEncoded}#Intent;scheme=googlegmail;package=com.google.android.gm;end`;
    const gmailLink = Platform.OS === 'android' ? gmailLinkAndroid : gmailLinkiOS;
    const mailtoLink = `mailto:${toEncoded}?subject=${subjectEncoded}&body=${bodyEncoded}`;

    try {
      if (isMicrosoft) {
        if (await Linking.canOpenURL(outlookLink)) return Linking.openURL(outlookLink);
        if (await Linking.canOpenURL(gmailLink))   return Linking.openURL(gmailLink);
        return Linking.openURL(mailtoLink);
      } else if (isGoogle) {
        if (await Linking.canOpenURL(gmailLink))   return Linking.openURL(gmailLink);
        if (await Linking.canOpenURL(outlookLink)) return Linking.openURL(outlookLink);
        return Linking.openURL(mailtoLink);
      } else {
        try { return await Linking.openURL(mailtoLink); } catch (_) {
          if (await Linking.canOpenURL(outlookLink)) return Linking.openURL(outlookLink);
          if (await Linking.canOpenURL(gmailLink))   return Linking.openURL(gmailLink);
        }
      }
    } catch {
      Alert.alert('Error', `Could not open email app.\n\nPlease email ${toEmail} manually.`);
    }
  };

  const externalAppLabel = isMicrosoft ? 'Open in Outlook' : isGoogle ? 'Open in Gmail' : 'Open in Mail';
  const externalAppIcon  = isMicrosoft ? 'logo-windows' : isGoogle ? 'logo-google' : 'mail-outline';

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>

        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} style={styles.headerBtn}>
            <Ionicons name="close" size={22} color={T.ink} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Reply</Text>
          <View style={{ width: 36 }} />
        </View>

        <ScrollView ref={scrollRef} style={styles.scroll} keyboardShouldPersistTaps="handled">

          {/* Email meta */}
          <View style={styles.metaCard}>
            <View style={styles.metaRow}>
              <Text style={styles.metaLabel}>From</Text>
              <Text style={styles.metaValue} numberOfLines={1}>{fromEmail}</Text>
            </View>
            <View style={styles.divider} />
            <View style={styles.metaRow}>
              <Text style={styles.metaLabel}>To</Text>
              <Text style={styles.metaValue} numberOfLines={1}>{toEmail}</Text>
            </View>
            <View style={styles.divider} />
            <View style={styles.metaRow}>
              <Text style={styles.metaLabel}>Subject</Text>
              <Text style={styles.metaValue} numberOfLines={2}>{subject}</Text>
            </View>
          </View>

          {/* Reply body input */}
          <View style={styles.composeCard}>
            <TextInput
              style={styles.bodyInput}
              placeholder="Write your reply here..."
              placeholderTextColor={T.inkFaint}
              multiline
              value={replyBody}
              onChangeText={setReplyBody}
              autoFocus
              textAlignVertical="top"
            />
          </View>

          {/* Thread chain */}
          {loadingThread ? (
            <View style={styles.threadLoading}>
              <ActivityIndicator size="small" color={T.blue} />
              <Text style={styles.threadLoadingText}>Loading thread…</Text>
            </View>
          ) : threadChain ? (
            <View style={styles.threadCard}>
              <View style={styles.threadHeader}>
                <Ionicons name="git-merge-outline" size={13} color={T.inkFaint} />
                <Text style={styles.threadHeaderText}>Previous messages</Text>
              </View>
              <Text style={styles.threadBody}>{threadChain}</Text>
            </View>
          ) : null}

          <View style={{ height: 40 }} />
        </ScrollView>

        {/* Action buttons */}
        <View style={styles.footer}>
          {/* Send in-app */}
          <TouchableOpacity
            style={styles.sendBtn}
            onPress={handleSendInApp}
            disabled={sending}
            activeOpacity={0.85}
          >
            <LinearGradient
              colors={[T.blue, '#3B6FE8']}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
              style={styles.sendBtnGrad}
            >
              {sending
                ? <ActivityIndicator color="#fff" size="small" />
                : <>
                    <Ionicons name="send" size={15} color="#fff" />
                    <Text style={styles.sendBtnText}>Send Reply</Text>
                  </>
              }
            </LinearGradient>
          </TouchableOpacity>

          {/* Open in external app */}
          <TouchableOpacity style={styles.externalBtn} onPress={handleOpenInApp} activeOpacity={0.8}>
            <Ionicons name={externalAppIcon} size={15} color={T.ink} />
            <Text style={styles.externalBtnText}>{externalAppLabel}</Text>
          </TouchableOpacity>
        </View>

      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.bg },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14,
    backgroundColor: T.surface, borderBottomWidth: 1, borderBottomColor: T.border,
  },
  headerBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 16, fontWeight: '600', color: T.ink },

  scroll: { flex: 1 },

  metaCard: {
    backgroundColor: T.surface, borderRadius: 14, marginHorizontal: 16, marginTop: 14,
    borderWidth: 1, borderColor: T.border, overflow: 'hidden',
  },
  metaRow: {
    flexDirection: 'row', alignItems: 'flex-start',
    paddingHorizontal: 14, paddingVertical: 10, gap: 10,
  },
  metaLabel: { fontSize: 12, fontWeight: '600', color: T.inkFaint, width: 52, paddingTop: 1 },
  metaValue: { flex: 1, fontSize: 13, color: T.ink },
  divider: { height: 1, backgroundColor: T.border, marginHorizontal: 14 },

  composeCard: {
    backgroundColor: T.surface, borderRadius: 14, marginHorizontal: 16, marginTop: 10,
    borderWidth: 1, borderColor: T.border, minHeight: 160, padding: 14,
  },
  bodyInput: {
    flex: 1, fontSize: 15, color: T.ink, minHeight: 140, lineHeight: 22,
  },

  threadLoading: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 16, marginTop: 10, padding: 12,
  },
  threadLoadingText: { fontSize: 13, color: T.inkFaint },

  threadCard: {
    backgroundColor: T.surface, borderRadius: 14, marginHorizontal: 16, marginTop: 10,
    borderWidth: 1, borderColor: T.border, padding: 14,
  },
  threadHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 },
  threadHeaderText: { fontSize: 12, fontWeight: '600', color: T.inkFaint, textTransform: 'uppercase', letterSpacing: 0.5 },
  threadBody: { fontSize: 12, color: T.inkFaint, lineHeight: 18 },

  footer: {
    paddingHorizontal: 16, paddingVertical: 12, gap: 10,
    backgroundColor: T.surface, borderTopWidth: 1, borderTopColor: T.border,
  },

  sendBtn: { borderRadius: 14, overflow: 'hidden' },
  sendBtnGrad: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 14, gap: 8,
  },
  sendBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },

  externalBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 12, borderRadius: 14,
    borderWidth: 1.5, borderColor: T.border, backgroundColor: T.surface,
  },
  externalBtnText: { fontSize: 14, fontWeight: '600', color: T.ink },
});
