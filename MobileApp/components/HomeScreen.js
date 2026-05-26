import React, { useRef, useEffect, useState, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView,
  Animated, Modal, ActivityIndicator, SafeAreaView, StatusBar,
  TouchableWithoutFeedback, Image, Dimensions,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView as SafeAreaViewContext } from 'react-native-safe-area-context';
import DateTimePicker from '@react-native-community/datetimepicker';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// ─── Design tokens ────────────────────────────────────────────────────────────
const T = {
  bg:        '#E5EAF3',
  surface:   '#FFFFFF',
  inputBg:   '#F1F4FA',
  ink:       '#0B0F22',
  textMuted: '#5B6B8A',
  textFaint: '#8896B0',
  border:    'rgba(11,15,34,0.06)',
  borderHi:  'rgba(11,15,34,0.10)',
  blue:      '#4F8DFF',
  blueDeep:  '#2563EB',
  purple:    '#7C6BFF',
  purpleDeep:'#5B4FE8',
  teal:      '#14B8A6',
  emerald:   '#10B981',
  amber:     '#F59E0B',
  rose:      '#EF4444',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function domainFrom(website) {
  if (!website) return '';
  return website.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
}

function initials(str) {
  if (!str) return '?';
  return str.trim()[0].toUpperCase();
}

function formatShortDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function weekDayLabel(offsetFromToday) {
  const d = new Date();
  d.setDate(d.getDate() - offsetFromToday);
  return d.toLocaleDateString('en-US', { weekday: 'short' }).slice(0, 1);
}

// ─── PulsingDot ───────────────────────────────────────────────────────────────
function PulsingDot({ color = T.blue, size = 7 }) {
  const anim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 0.45, duration: 550, useNativeDriver: true }),
        Animated.timing(anim, { toValue: 1, duration: 550, useNativeDriver: true }),
      ])
    ).start();
  }, []);
  return (
    <Animated.View
      style={{
        width: size, height: size, borderRadius: size / 2,
        backgroundColor: color, opacity: anim,
      }}
    />
  );
}

// ─── ActivityChart ────────────────────────────────────────────────────────────
function ActivityChart({ applicationHistory }) {
  const days = useMemo(() => {
    const arr = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toLocaleDateString('en-CA');
      const sent = applicationHistory.filter(a => {
        const s = a.sentDate ? new Date(a.sentDate).toLocaleDateString('en-CA') : null;
        return s === key;
      }).length;
      arr.push({ label: weekDayLabel(i), sent, generated: sent });
    }
    return arr;
  }, [applicationHistory]);

  const maxVal = Math.max(1, ...days.map(d => Math.max(d.sent, d.generated)));
  const BAR_H = 76;

  return (
    <View style={chartStyles.row}>
      {days.map((d, i) => (
        <View key={i} style={chartStyles.col}>
          <View style={[chartStyles.barWrap, { height: BAR_H }]}>
            {d.generated > 0 && (
              <LinearGradient
                colors={[T.blue, T.purple]}
                style={[chartStyles.bar, { height: Math.max(4, (d.generated / maxVal) * BAR_H) }]}
                start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
              />
            )}
            {d.sent > 0 && d.sent !== d.generated && (
              <View style={[chartStyles.sentBar, { height: Math.max(4, (d.sent / maxVal) * BAR_H) }]} />
            )}
            {d.generated === 0 && (
              <View style={chartStyles.emptyBar} />
            )}
          </View>
          <Text style={chartStyles.label}>{d.label}</Text>
        </View>
      ))}
    </View>
  );
}
const chartStyles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  col: { alignItems: 'center', flex: 1 },
  barWrap: { justifyContent: 'flex-end', alignItems: 'center', width: '80%' },
  bar: { width: '100%', borderRadius: 4 },
  sentBar: { width: '100%', borderRadius: 4, backgroundColor: T.teal },
  emptyBar: { width: '100%', height: 4, borderRadius: 2, backgroundColor: T.border },
  label: { marginTop: 6, fontSize: 11, color: T.textFaint, fontWeight: '600' },
});

// ─── CompanyCard ──────────────────────────────────────────────────────────────
function CompanyCard({
  recipient, index, canRemove,
  onRemove, onUpdate, onGenerate,
}) {
  const [mode, setMode] = useState('edit'); // 'edit' | 'ready'

  const domain = domainFrom(recipient.website);
  const companyInitial = domain ? domain[0].toUpperCase() : (recipient.email ? recipient.email.split('@')[1]?.[0]?.toUpperCase() ?? 'C' : 'C');
  const companyName = domain || (recipient.email ? recipient.email.split('@')[1] ?? 'New Company' : 'New Company');
  const isReady = recipient.email && recipient.website;

  useEffect(() => {
    if (isReady) setMode('ready');
    else setMode('edit');
  }, [isReady]);

  const eyebrow = mode === 'edit' ? 'NEW OUTREACH' : 'OUTREACH TO';

  return (
    <View style={cardStyles.card}>
      {/* Envelope top row */}
      <View style={cardStyles.topRow}>
        <Text style={cardStyles.eyebrow}>{eyebrow}</Text>
        <LinearGradient colors={[T.blue, T.purple]} style={cardStyles.creditStamp} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
          <Ionicons name="diamond" size={8} color="#fff" />
          <Text style={cardStyles.creditStampText}> 1 CREDIT</Text>
        </LinearGradient>
      </View>

      {/* Watermark */}
      <Text style={cardStyles.watermark}>{companyInitial}</Text>

      {/* Identity row */}
      {mode === 'ready' ? (
        <TouchableOpacity onPress={() => setMode('edit')} activeOpacity={0.8}>
          <View style={cardStyles.identityRow}>
            <View style={cardStyles.avatar}>
              <Text style={cardStyles.avatarText}>{companyInitial}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={cardStyles.companyName}>{companyName}</Text>
              <Text style={cardStyles.positionText} numberOfLines={1}>{recipient.position || 'Position not specified'}</Text>
            </View>
            {canRemove && (
              <TouchableOpacity onPress={() => onRemove(recipient.id)} style={cardStyles.trashBtn}>
                <Ionicons name="trash-outline" size={14} color={T.rose} />
              </TouchableOpacity>
            )}
          </View>
        </TouchableOpacity>
      ) : (
        <View>
          <View style={cardStyles.editHeader}>
            <View style={cardStyles.editAvatarPlaceholder}>
              <Ionicons name="add" size={18} color={T.textFaint} />
            </View>
            <Text style={cardStyles.editTitle}>New company</Text>
            {canRemove && (
              <TouchableOpacity onPress={() => onRemove(recipient.id)} style={cardStyles.trashBtn}>
                <Ionicons name="trash-outline" size={14} color={T.rose} />
              </TouchableOpacity>
            )}
          </View>

          <View style={cardStyles.inputGroup}>
            <Text style={cardStyles.inputLabel}>Company Website *</Text>
            <TextInput
              style={cardStyles.input}
              placeholder="https://company.com"
              placeholderTextColor={T.textFaint}
              keyboardType="url"
              autoCapitalize="none"
              value={recipient.website}
              onChangeText={t => onUpdate(recipient.id, 'website', t)}
            />
          </View>
          <View style={cardStyles.inputGroup}>
            <Text style={cardStyles.inputLabel}>Hiring Manager Email *</Text>
            <TextInput
              style={cardStyles.input}
              placeholder="hiring@company.com"
              placeholderTextColor={T.textFaint}
              keyboardType="email-address"
              autoCapitalize="none"
              value={recipient.email}
              onChangeText={t => onUpdate(recipient.id, 'email', t)}
            />
          </View>
          <View style={cardStyles.inputGroup}>
            <Text style={cardStyles.inputLabel}>Position / Role</Text>
            <TextInput
              style={cardStyles.input}
              placeholder="e.g. Software Engineer"
              placeholderTextColor={T.textFaint}
              value={recipient.position}
              onChangeText={t => onUpdate(recipient.id, 'position', t)}
            />
          </View>
        </View>
      )}

      {/* Perforation line */}
      <View style={cardStyles.perforation} />

      {/* Recipient row (ready mode only) */}
      {mode === 'ready' && (
        <View style={cardStyles.recipientRow}>
          <View style={cardStyles.mailTile}>
            <Ionicons name="mail-outline" size={11} color={T.blue} />
          </View>
          <Text style={cardStyles.emailText} numberOfLines={1}>{recipient.email}</Text>
        </View>
      )}

      {/* Status row (ready mode) */}
      {mode === 'ready' && (
        <View style={cardStyles.statusRow}>
          <Ionicons name="link-outline" size={10} color={T.textFaint} />
          <Text style={cardStyles.websiteText}>{domain}</Text>
          <View style={cardStyles.statusDot}>
            <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: T.emerald }} />
            <Text style={cardStyles.statusText}>Ready</Text>
          </View>
        </View>
      )}

      {/* Generate button */}
      <TouchableOpacity onPress={onGenerate} activeOpacity={0.85} style={{ marginTop: 10 }}>
        <LinearGradient colors={[T.blue, T.purple, T.purpleDeep]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={cardStyles.generateBtn}>
          <Ionicons name="sparkles" size={13} color="#fff" />
          <Text style={cardStyles.generateBtnText}>Generate Cover Letter</Text>
        </LinearGradient>
      </TouchableOpacity>
    </View>
  );
}
const cardStyles = StyleSheet.create({
  card: {
    backgroundColor: T.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: T.border,
    padding: 18,
    marginBottom: 12,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  eyebrow: { fontSize: 10, fontWeight: '700', letterSpacing: 1.4, color: T.textFaint },
  creditStamp: { flexDirection: 'row', alignItems: 'center', borderRadius: 20, paddingHorizontal: 7, paddingVertical: 2 },
  creditStampText: { fontSize: 8, fontWeight: '700', color: '#fff', letterSpacing: 0.4 },
  watermark: {
    position: 'absolute', right: 14, top: 28,
    fontSize: 72, fontWeight: '800', color: 'rgba(11,15,34,0.04)',
    lineHeight: 80,
  },
  identityRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 2 },
  avatar: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: T.blue + '22',
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { fontSize: 16, fontWeight: '700', color: T.blue },
  companyName: { fontSize: 14, fontWeight: '700', color: T.ink },
  positionText: { fontSize: 11, color: T.textMuted, marginTop: 1 },
  trashBtn: { width: 28, height: 28, borderRadius: 8, backgroundColor: T.rose + '15', alignItems: 'center', justifyContent: 'center' },
  editHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  editAvatarPlaceholder: {
    width: 36, height: 36, borderRadius: 10,
    borderWidth: 1.5, borderColor: T.border, borderStyle: 'dashed',
    alignItems: 'center', justifyContent: 'center',
  },
  editTitle: { flex: 1, fontSize: 14, fontWeight: '600', color: T.textMuted },
  inputGroup: { marginBottom: 8 },
  inputLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.8, color: T.textFaint, marginBottom: 5, textTransform: 'uppercase' },
  input: {
    backgroundColor: T.inputBg,
    borderRadius: 8, borderWidth: 1, borderColor: T.border,
    paddingHorizontal: 12, paddingVertical: 11,
    fontSize: 14, color: T.ink,
  },
  perforation: {
    height: 0,
    borderTopWidth: 1, borderStyle: 'dashed', borderColor: T.borderHi,
    marginVertical: 10,
  },
  recipientRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 6 },
  mailTile: {
    width: 22, height: 22, borderRadius: 5,
    backgroundColor: T.blue + '15', alignItems: 'center', justifyContent: 'center',
  },
  emailText: { fontSize: 13, color: T.ink, fontFamily: 'Courier', flex: 1 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  websiteText: { fontSize: 12, color: T.textFaint, flex: 1 },
  statusDot: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  statusText: { fontSize: 12, fontWeight: '600', color: T.emerald },
  generateBtn: { borderRadius: 12, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  generateBtnText: { fontSize: 14, fontWeight: '700', color: '#fff' },
});

// ─── AppCard ──────────────────────────────────────────────────────────────────
const STATUS_CONFIG = {
  replied:   { color: T.emerald,  label: 'REPLIED',   icon: 'checkmark-circle' },
  pending:   { color: T.amber,    label: 'PENDING',   icon: 'time-outline' },
  interview: { color: T.purple,   label: 'INTERVIEW', icon: 'briefcase-outline' },
  noreply:   { color: T.textFaint,label: 'NO REPLY',  icon: 'mail-unread-outline' },
};

function getAppStatus(app) {
  if (app.interviewScheduled) return 'interview';
  if (app.replyReceived)      return 'replied';
  const daysSince = (Date.now() - new Date(app.sentDate)) / 86400000;
  if (daysSince > 21)         return 'noreply';
  return 'pending';
}

function AppCard({ app, index, onMarkReply, onShowReplies }) {
  const status = getAppStatus(app);
  const cfg = STATUS_CONFIG[status];
  const companyName = app.companyName || 'Company';
  const initial = companyName[0].toUpperCase();
  const sentLabel = formatShortDate(app.sentDate);

  const steps = ['Sent', 'Opened', 'Replied', 'Interview'];
  const activeStep = status === 'interview' ? 3 : status === 'replied' ? 2 : status === 'pending' ? 0 : 0;

  return (
    <View style={appStyles.card}>
      {/* Accent strip */}
      <View style={[appStyles.accentStrip, { backgroundColor: cfg.color }]} />

      {/* Watermark */}
      <Text style={appStyles.watermark}>{initial}</Text>

      {/* Top meta row */}
      <View style={appStyles.topRow}>
        <Text style={appStyles.eyebrow}>REPLY FROM</Text>
        <View style={[appStyles.statusBadge, { backgroundColor: cfg.color + '20', borderColor: cfg.color + '40' }]}>
          <Text style={[appStyles.statusText, { color: cfg.color }]}>{cfg.label}</Text>
        </View>
      </View>

      {/* Company row */}
      <View style={appStyles.companyRow}>
        <View style={[appStyles.avatar, { backgroundColor: cfg.color + '20' }]}>
          <Text style={[appStyles.avatarText, { color: cfg.color }]}>{initial}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={appStyles.companyName} numberOfLines={1}>{companyName}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <Ionicons name="briefcase-outline" size={10} color={T.textFaint} />
            <Text style={appStyles.positionText} numberOfLines={1}>
              {app.position || 'Position not specified'} · sent {sentLabel}
            </Text>
          </View>
        </View>
      </View>

      {/* Perforation */}
      <View style={appStyles.perforation} />

      {/* Reply quote or action hint */}
      {app.replyReceived && app.replySnippet ? (
        <TouchableOpacity onPress={() => onShowReplies(app.id, companyName)} activeOpacity={0.8}>
          <View style={appStyles.quoteBlock}>
            <Text style={appStyles.quoteMark}>"</Text>
            <Text style={appStyles.quoteText} numberOfLines={2}>{app.replySnippet}</Text>
          </View>
          {app.replyFromEmail && (
            <View style={appStyles.senderRow}>
              <View style={appStyles.senderCircle}><Text style={appStyles.senderInitial}>{app.replyFromEmail[0].toUpperCase()}</Text></View>
              <Text style={appStyles.senderText}>{app.replyFromEmail}</Text>
              {app.replyCount > 1 && (
                <View style={appStyles.countBadge}><Text style={appStyles.countBadgeText}>{app.replyCount} replies</Text></View>
              )}
            </View>
          )}
        </TouchableOpacity>
      ) : !app.replyReceived ? (
        <TouchableOpacity onPress={() => onMarkReply(app.id)} style={appStyles.actionHint}>
          <Text style={appStyles.actionHintText}>Tap to mark as replied</Text>
        </TouchableOpacity>
      ) : null}

      {/* Timeline stepper */}
      <Text style={appStyles.journeyLabel}>JOURNEY</Text>
      <View style={appStyles.timeline}>
        {steps.map((step, si) => {
          const done = si <= activeStep;
          const active = si === activeStep;
          return (
            <React.Fragment key={step}>
              <View style={appStyles.timelineItem}>
                <View style={[appStyles.stepDot, done ? { backgroundColor: cfg.color } : appStyles.stepDotEmpty]}>
                  {done && <Ionicons name="checkmark" size={7} color="#fff" />}
                </View>
                <Text style={[appStyles.stepLabel, done && { color: cfg.color }]}>{step}</Text>
              </View>
              {si < steps.length - 1 && (
                <View style={[appStyles.stepLine, done && si < activeStep && { backgroundColor: cfg.color }]} />
              )}
            </React.Fragment>
          );
        })}
      </View>

      {/* Footer actions */}
      <View style={appStyles.footer}>
        <TouchableOpacity onPress={() => onShowReplies(app.id, companyName)} style={appStyles.outlineBtn}>
          <Text style={appStyles.outlineBtnText}>View thread</Text>
        </TouchableOpacity>
        {status === 'interview' ? (
          <LinearGradient colors={[T.purple, T.purpleDeep]} style={appStyles.gradBtn} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
            <Text style={appStyles.gradBtnText}>Prep for chat</Text>
          </LinearGradient>
        ) : (
          <LinearGradient colors={[T.blue, T.blueDeep]} style={appStyles.gradBtn} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
            <Text style={appStyles.gradBtnText}>Reply now</Text>
          </LinearGradient>
        )}
      </View>
    </View>
  );
}
const appStyles = StyleSheet.create({
  card: {
    backgroundColor: T.surface, borderRadius: 16, borderWidth: 1, borderColor: T.border,
    marginBottom: 10, overflow: 'hidden',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8, elevation: 2,
    paddingTop: 3,
  },
  accentStrip: { height: 3, borderTopLeftRadius: 16, borderTopRightRadius: 16 },
  watermark: {
    position: 'absolute', right: 14, top: 30,
    fontSize: 64, fontWeight: '800', color: 'rgba(11,15,34,0.04)',
  },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 10, marginBottom: 8 },
  eyebrow: { fontSize: 10, fontWeight: '700', letterSpacing: 1.2, color: T.textFaint },
  statusBadge: { borderRadius: 6, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 3 },
  statusText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.6 },
  companyRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, marginBottom: 4 },
  avatar: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 16, fontWeight: '700' },
  companyName: { fontSize: 15, fontWeight: '700', color: T.ink },
  positionText: { fontSize: 12, color: T.textFaint, marginTop: 1 },
  perforation: { height: 0, borderTopWidth: 1, borderStyle: 'dashed', borderColor: T.borderHi, marginVertical: 10, marginHorizontal: 14 },
  quoteBlock: { paddingHorizontal: 14, marginBottom: 4, position: 'relative' },
  quoteMark: { fontSize: 28, fontWeight: '800', color: T.blue + '30', lineHeight: 28, position: 'absolute', left: 12, top: -6 },
  quoteText: { fontSize: 13, color: T.textMuted, lineHeight: 18, paddingLeft: 14 },
  senderRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, marginBottom: 8 },
  senderCircle: { width: 20, height: 20, borderRadius: 10, backgroundColor: T.blue + '20', alignItems: 'center', justifyContent: 'center' },
  senderInitial: { fontSize: 10, fontWeight: '700', color: T.blue },
  senderText: { fontSize: 12, color: T.textFaint, flex: 1 },
  countBadge: { backgroundColor: T.inputBg, borderRadius: 10, paddingHorizontal: 7, paddingVertical: 3 },
  countBadgeText: { fontSize: 11, color: T.textFaint, fontWeight: '600' },
  actionHint: {
    paddingHorizontal: 14, marginBottom: 10, paddingVertical: 13,
    backgroundColor: T.blue + '12', marginHorizontal: 14, borderRadius: 10,
    borderWidth: 1, borderColor: T.blue + '25',
  },
  actionHintText: { fontSize: 13, color: T.blue, textAlign: 'center', fontWeight: '600' },
  journeyLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 1.2, color: T.textFaint, paddingHorizontal: 14, marginBottom: 7 },
  timeline: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, marginBottom: 12 },
  timelineItem: { alignItems: 'center', gap: 3 },
  stepDot: { width: 15, height: 15, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  stepDotEmpty: { borderWidth: 1.5, borderColor: T.borderHi, backgroundColor: 'transparent' },
  stepLabel: { fontSize: 10, fontWeight: '600', color: T.textFaint },
  stepLine: { flex: 1, height: 1.5, backgroundColor: T.borderHi, marginBottom: 12 },
  footer: { flexDirection: 'row', gap: 8, padding: 12, backgroundColor: T.surface },
  outlineBtn: {
    flex: 1, borderWidth: 1, borderColor: T.borderHi, borderRadius: 11,
    paddingVertical: 13, alignItems: 'center',
  },
  outlineBtnText: { fontSize: 14, fontWeight: '600', color: T.ink },
  gradBtn: { flex: 1, borderRadius: 11, paddingVertical: 13, alignItems: 'center' },
  gradBtnText: { fontSize: 14, fontWeight: '700', color: '#fff' },
});

// ─── StatChip ─────────────────────────────────────────────────────────────────
function StatChip({ label, value, sub, subColor }) {
  return (
    <View style={chipStyles.chip}>
      <Text style={chipStyles.label}>{label}</Text>
      <Text style={chipStyles.value}>{value}</Text>
      {sub ? <Text style={[chipStyles.sub, subColor && { color: subColor }]}>{sub}</Text> : null}
    </View>
  );
}
const chipStyles = StyleSheet.create({
  chip: { flex: 1, alignItems: 'center', paddingVertical: 12 },
  label: { fontSize: 10, fontWeight: '700', letterSpacing: 0.8, color: T.textFaint, textTransform: 'uppercase', marginBottom: 5 },
  value: { fontSize: 17, fontWeight: '800', color: T.ink },
  sub: { fontSize: 12, fontWeight: '600', color: T.textMuted, marginTop: 2 },
});

// ─── HomeScreen ───────────────────────────────────────────────────────────────
export default function HomeScreen({
  // data
  user, creditBalance, unreadCount,
  totalSent, totalGenerated, totalReplied,
  recipients, applicationHistory,
  showSettings, setShowSettings,
  showNotifications, setShowNotifications,
  notifications, loadingNotifications,
  isCheckingReplies,
  showReplyDatePicker, setShowReplyDatePicker,
  selectedReplyDate, setSelectedReplyDate, selectedReplyDateRef,
  replyAppId, setReplyAppId,
  showReplyDetailsModal, setShowReplyDetailsModal,
  selectedReplyDetails, isAdmin,
  // handlers
  handleReview, addRecipient, removeRecipient, updateRecipient,
  checkEmailReplies, loadNotifications, markNotificationAsRead,
  showAllReplies, handleLogout, isValidEmail, getTimeAgo, setScreen,
  renderCompleteProfileModal,
  // API_BASE for inline reply confirm handler
  API_BASE, userRef,
  setApplicationHistory, setTotalReplied,
}) {
  const firstName = user?.fullName?.split(' ')[0] || user?.name?.split(' ')[0] || 'User';
  const isMicrosoft = user?.provider === 'microsoft' || user?.oauth_provider === 'microsoft';

  // Derived stats
  const replyRate = totalSent > 0 ? Math.round((totalReplied / totalSent) * 100) : 0;
  const replyLabel = totalSent > 0 ? `${totalReplied}/${totalSent} ${replyRate}%` : '0/0 —';

  // This week delta: letters generated this week vs last week
  const thisWeekGenerated = useMemo(() => {
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 7);
    return applicationHistory.filter(a => new Date(a.sentDate) >= cutoff).length;
  }, [applicationHistory]);

  const lastWeekGenerated = useMemo(() => {
    const start = new Date(); start.setDate(start.getDate() - 14);
    const end = new Date(); end.setDate(end.getDate() - 7);
    return applicationHistory.filter(a => {
      const d = new Date(a.sentDate);
      return d >= start && d < end;
    }).length;
  }, [applicationHistory]);

  const deltaLetters = thisWeekGenerated - lastWeekGenerated;

  // Streak: consecutive days with activity
  const streak = useMemo(() => {
    if (!applicationHistory.length) return 0;
    let count = 0;
    const d = new Date();
    for (let i = 0; i < 30; i++) {
      const key = new Date(d.getFullYear(), d.getMonth(), d.getDate() - i).toLocaleDateString('en-CA');
      const hasActivity = applicationHistory.some(a => {
        const s = a.sentDate ? new Date(a.sentDate).toLocaleDateString('en-CA') : null;
        return s === key;
      });
      if (hasActivity) count++;
      else if (i > 0) break;
    }
    return count;
  }, [applicationHistory]);

  const hasPendingReady = recipients.some(r => r.email && r.website);

  function handleMarkReply(appId) {
    setReplyAppId(appId);
    const now = new Date();
    setSelectedReplyDate(now);
    if (selectedReplyDateRef) selectedReplyDateRef.current = now;
    setShowReplyDatePicker(true);
  }

  return (
    <SafeAreaViewContext style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor={T.bg} translucent={false} />

      {renderCompleteProfileModal && renderCompleteProfileModal()}

      {/* ── TOP BAR ──────────────────────────────────────────── */}
      <View style={styles.topBar}>
        {/* Logo + wordmark */}
        <View style={styles.logoRow}>
          <Image
            source={require('../assets/images/logo_img.png')}
            style={styles.logoImg}
            resizeMode="contain"
          />
          <Text style={styles.wordmark}>
            <Text style={styles.wordmarkCv}>cv</Text>
            <Text style={styles.wordmarkApplyr}>applyr</Text>
          </Text>
        </View>
        {/* Actions */}
        <View style={styles.topBarActions}>
          <TouchableOpacity
            style={styles.iconCard}
            onPress={async () => {
              setShowNotifications(!showNotifications);
              if (!showNotifications && loadNotifications) await loadNotifications();
            }}
          >
            <Ionicons name="notifications-outline" size={18} color={T.ink} />
            {unreadCount > 0 && (
              <View style={styles.bellBadge}>
                <Text style={styles.bellBadgeText}>{unreadCount > 99 ? '99+' : unreadCount}</Text>
              </View>
            )}
          </TouchableOpacity>
          <TouchableOpacity style={styles.iconCard} onPress={() => setShowSettings(!showSettings)}>
            <View style={styles.hamburger}>
              <View style={styles.hamburgerLine} />
              <View style={[styles.hamburgerLine, { width: 12 }]} />
              <View style={styles.hamburgerLine} />
            </View>
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* ── HERO CARD ─────────────────────────────────────── */}
        <View style={styles.heroCard}>
          {/* Dark navy base */}
          <LinearGradient
            colors={['#0B0F22', '#0F1635', '#0B0F22']}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFillObject}
          />
          {/* Mesh blobs */}
          <View style={styles.meshBlob1} />
          <View style={styles.meshBlob2} />
          <View style={styles.meshBlob3} />
          <View style={styles.meshBlob4} />

          {/* Top: welcome + streak */}
          <View style={styles.heroTop}>
            <Text style={styles.heroWelcome}>Welcome back, <Text style={styles.heroName}>{firstName}</Text></Text>
            <View style={styles.streakPill}>
              <Text style={styles.streakFlame}>🔥</Text>
              <Text style={styles.streakText}>{streak}-day streak</Text>
            </View>
          </View>

          {/* Credits row: big number left + reply mini-card right */}
          <View style={styles.creditsRow}>
            <View>
              <Text style={styles.creditsNumber}>{creditBalance}</Text>
              <Text style={styles.creditsLabel}>AVAILABLE CREDITS</Text>
            </View>
            <View style={styles.replyMiniCard}>
              <Text style={styles.replyMiniLabel}>REPLIES</Text>
              <Text style={styles.replyMiniValue}>{totalReplied}/{totalSent}</Text>
              <Text style={styles.replyMiniRate}>{replyRate}%</Text>
            </View>
          </View>

          {/* Top up button */}
          <TouchableOpacity style={styles.topUpPill} onPress={() => setScreen('usage')} activeOpacity={0.85}>
            <Ionicons name="flash" size={11} color={T.ink} />
            <Text style={styles.topUpText}>Top up</Text>
          </TouchableOpacity>

          {/* Glass stat strip */}
          <View style={styles.heroStatStrip}>
            <View style={styles.heroStat}>
              <Text style={styles.heroStatLabel}>SENT</Text>
              <Text style={styles.heroStatValue}>{totalSent}</Text>
            </View>
            <View style={styles.heroStatDivider} />
            <View style={styles.heroStat}>
              <Text style={styles.heroStatLabel}>LETTERS</Text>
              <Text style={styles.heroStatValue}>{totalGenerated}</Text>
            </View>
            <View style={styles.heroStatDivider} />
            <View style={styles.heroStat}>
              <Text style={styles.heroStatLabel}>REPLY RATE</Text>
              <Text style={[styles.heroStatValue, { color: T.teal }]}>{replyRate}%</Text>
            </View>
          </View>
        </View>

        {/* ── THIS WEEK ────────────────────────────────────── */}
        <View style={styles.sectionCard}>
          <View style={styles.sectionHeader}>
            <View>
              <Text style={styles.sectionTitle}>This week</Text>
              <Text style={[styles.sectionSub, { color: deltaLetters >= 0 ? T.emerald : T.rose }]}>
                {deltaLetters >= 0 ? '+' : ''}{deltaLetters} letters vs last week
              </Text>
            </View>
            <TouchableOpacity><Text style={styles.detailsLink}>Details →</Text></TouchableOpacity>
          </View>
          <ActivityChart applicationHistory={applicationHistory} />
          <View style={styles.chartLegend}>
            <View style={styles.legendItem}>
              <LinearGradient colors={[T.blue, T.purple]} style={styles.legendSwatch} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} />
              <Text style={styles.legendText}>Generated</Text>
            </View>
            <View style={styles.legendItem}>
              <View style={[styles.legendSwatch, { backgroundColor: T.teal }]} />
              <Text style={styles.legendText}>Sent</Text>
            </View>
          </View>
        </View>

        {/* ── COMPANIES ────────────────────────────────────── */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={styles.sectionTitle}>Companies</Text>
                <View style={styles.countPill}>
                  <Text style={styles.countPillText}>{recipients.length}</Text>
                </View>
              </View>
              <Text style={styles.sectionSub}>Tap a card to send your cover letter</Text>
            </View>
            <TouchableOpacity onPress={addRecipient} activeOpacity={0.85}>
              <LinearGradient colors={[T.blue, T.purple]} style={styles.addPill} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
                <Text style={styles.addPillText}>+ Add new</Text>
              </LinearGradient>
            </TouchableOpacity>
          </View>

          {recipients.map((r, i) => (
            <CompanyCard
              key={r.id}
              recipient={r}
              index={i}
              canRemove={recipients.length > 1}
              onRemove={removeRecipient}
              onUpdate={updateRecipient}
              onGenerate={handleReview}
            />
          ))}

          {/* Generate & send all CTA */}
          <TouchableOpacity
            onPress={handlePendingReady}
            disabled={!hasPendingReady}
            activeOpacity={0.85}
          >
            <LinearGradient
              colors={['#0F5132', '#14653A', '#0E3F26']}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
              style={[styles.generateAllBtn, !hasPendingReady && { opacity: 0.5 }]}
            >
              <Text style={styles.generateAllText}>Generate & send all pending</Text>
              <View style={styles.creditsBadge}>
                <Text style={styles.creditsBadgeText}>{recipients.filter(r => r.email && r.website).length} credits</Text>
              </View>
            </LinearGradient>
          </TouchableOpacity>
        </View>

        {/* ── RECENT APPLICATIONS ──────────────────────────── */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={styles.sectionTitle}>Recent applications</Text>
                <View style={styles.countPill}>
                  <Text style={styles.countPillText}>{applicationHistory.length}</Text>
                </View>
              </View>
              <Text style={styles.sectionSub}>You're on a hot streak — keep it going</Text>
            </View>
            {isMicrosoft && (
              <TouchableOpacity onPress={checkEmailReplies} disabled={isCheckingReplies} style={styles.syncPill}>
                {isCheckingReplies
                  ? <ActivityIndicator size="small" color="#fff" />
                  : <><Ionicons name="sync-outline" size={11} color="#fff" /><Text style={styles.syncText}>Sync</Text></>
                }
              </TouchableOpacity>
            )}
          </View>

          {/* Stats strip */}
          {applicationHistory.length > 0 && (
            <View style={styles.statsStrip}>
              <StatChip label="Reply rate" value={`${replyRate}%`} sub={`${totalReplied}/${totalSent}`} />
              <View style={styles.stripDivider} />
              <StatChip label="Avg. reply" value={avgReplyDays(applicationHistory)} sub="days" />
              <View style={styles.stripDivider} />
              <StatChip label="Interviews" value={interviewCount(applicationHistory)} />
            </View>
          )}

          {applicationHistory.length === 0 ? (
            <View style={styles.emptyState}>
              <Ionicons name="mail-outline" size={28} color={T.textFaint} />
              <Text style={styles.emptyTitle}>No Applications Yet</Text>
              <Text style={styles.emptySub}>Your recent job applications will appear here</Text>
            </View>
          ) : (
            applicationHistory.slice(0, 5).map((app, i) => (
              <AppCard
                key={app.id || i}
                app={app}
                index={i}
                onMarkReply={handleMarkReply}
                onShowReplies={showAllReplies}
              />
            ))
          )}
        </View>

        <View style={{ height: 100 }} />
      </ScrollView>

      {/* ── FLOATING TAB BAR ─────────────────────────────── */}
      <View style={tabStyles.wrapper}>
        <View style={tabStyles.bar}>
          {/* Home — active */}
          <LinearGradient
            colors={[T.blue, T.blueDeep]}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
            style={tabStyles.activeTab}
          >
            <Ionicons name="home" size={16} color="#fff" />
            <Text style={tabStyles.activeLabel}>Home</Text>
          </LinearGradient>

          {/* Jobs */}
          <TouchableOpacity
            style={tabStyles.tab}
            onPress={() => require('expo-router').router?.push?.('/(ai-hub)')}
            activeOpacity={0.7}
          >
            <Ionicons name="briefcase-outline" size={20} color={T.textFaint} />
            <Text style={tabStyles.label}>Jobs</Text>
          </TouchableOpacity>

          {/* Letters */}
          <TouchableOpacity
            style={tabStyles.tab}
            onPress={() => handleReview()}
            activeOpacity={0.7}
          >
            <Ionicons name="document-text-outline" size={20} color={T.textFaint} />
            <Text style={tabStyles.label}>Letters</Text>
          </TouchableOpacity>

          {/* Me */}
          <TouchableOpacity
            style={tabStyles.tab}
            onPress={() => setScreen('profile')}
            activeOpacity={0.7}
          >
            <Ionicons name="person-outline" size={20} color={T.textFaint} />
            <Text style={tabStyles.label}>Me</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* ── SIDE MENU MODAL ──────────────────────────────── */}
      <Modal visible={showSettings} transparent animationType="none" onRequestClose={() => setShowSettings(false)}>
        <View style={menuStyles.container}>
          <TouchableOpacity style={menuStyles.backdrop} activeOpacity={1} onPress={() => setShowSettings(false)} />
          <View style={menuStyles.panel}>
            <TouchableOpacity style={menuStyles.closeBtn} onPress={() => setShowSettings(false)}>
              <Ionicons name="close" size={18} color={T.ink} />
            </TouchableOpacity>
            {[
              { icon: 'settings-outline',   title: 'Account Settings',   sub: 'View your profile',          onPress: () => { setShowSettings(false); setScreen('profile'); } },
              { icon: 'briefcase-outline',   title: 'Jobs Dashboard',     sub: 'AI-powered job search hub',  onPress: () => { setShowSettings(false); require('expo-router').router?.push?.('/(ai-hub)'); } },
            ].concat(isAdmin ? [{ icon: 'star-outline', title: 'Admin Panel', sub: 'Manage credit packages', onPress: () => { setShowSettings(false); setScreen('admin'); } }] : []).concat([
              null,
              { icon: 'document-text-outline', title: 'Terms & Conditions', sub: 'View terms of service',   onPress: () => { setShowSettings(false); setScreen('terms'); } },
              { icon: 'shield-outline',          title: 'Privacy Policy',   sub: 'How we protect your data', onPress: () => { setShowSettings(false); setScreen('privacy'); } },
              { icon: 'card-outline',            title: 'Refund Policy',    sub: 'Credit refund information', onPress: () => { setShowSettings(false); setScreen('refund'); } },
              null,
              { icon: 'log-out-outline',         title: 'Sign Out',         sub: 'Logout from your account',  onPress: () => { setShowSettings(false); handleLogout(); } },
            ]).map((item, i) =>
              item === null
                ? <View key={`div-${i}`} style={menuStyles.divider} />
                : (
                  <TouchableOpacity key={item.title} style={menuStyles.item} onPress={item.onPress}>
                    <View style={menuStyles.iconBox}><Ionicons name={item.icon} size={16} color={T.blue} /></View>
                    <View style={{ flex: 1 }}>
                      <Text style={menuStyles.itemTitle}>{item.title}</Text>
                      <Text style={menuStyles.itemSub}>{item.sub}</Text>
                    </View>
                  </TouchableOpacity>
                )
            )}
          </View>
        </View>
      </Modal>

      {/* ── NOTIFICATIONS MODAL ──────────────────────────── */}
      <Modal visible={showNotifications} transparent animationType="slide" onRequestClose={() => setShowNotifications(false)}>
        <TouchableWithoutFeedback onPress={() => setShowNotifications(false)}>
          <View style={notifStyles.overlay}>
            <TouchableWithoutFeedback>
              <SafeAreaViewContext style={notifStyles.wrapper}>
                <View style={notifStyles.sheet}>
                  <View style={notifStyles.handle} />
                  <View style={notifStyles.header}>
                    <Text style={notifStyles.title}>Notifications</Text>
                    {unreadCount > 0 && <View style={notifStyles.badge}><Text style={notifStyles.badgeText}>{unreadCount}</Text></View>}
                  </View>
                  <ScrollView showsVerticalScrollIndicator={false} style={{ flex: 1 }}>
                    {loadingNotifications ? (
                      <ActivityIndicator size="large" color={T.blue} style={{ marginTop: 40 }} />
                    ) : notifications.length === 0 ? (
                      <View style={notifStyles.empty}>
                        <Ionicons name="notifications-off-outline" size={36} color={T.textFaint} />
                        <Text style={notifStyles.emptyText}>No notifications yet</Text>
                      </View>
                    ) : notifications.map((n, i) => (
                      <TouchableOpacity
                        key={n.id || i}
                        style={[notifStyles.item, !n.is_read && notifStyles.itemUnread]}
                        onPress={() => !n.is_read && markNotificationAsRead(n.id)}
                        activeOpacity={0.7}
                      >
                        <View style={notifStyles.notifIcon}>
                          <Ionicons name={n.type === 'email' ? 'mail' : n.type === 'credits' ? 'diamond' : 'notifications'} size={14} color={T.blue} />
                        </View>
                        <View style={{ flex: 1 }}>
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                            <Text style={notifStyles.itemTitle} numberOfLines={1}>{n.title}</Text>
                            <Text style={notifStyles.itemTime}>{getTimeAgo(n.created_at)}</Text>
                          </View>
                          <Text style={notifStyles.itemMsg} numberOfLines={2}>{n.message}</Text>
                        </View>
                        {!n.is_read && <View style={notifStyles.unreadDot} />}
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                  {notifications.length > 0 && (
                    <TouchableOpacity onPress={() => { setShowNotifications(false); setScreen('notifications'); }} activeOpacity={0.85}>
                      <LinearGradient colors={[T.blue, T.purple]} style={notifStyles.viewAllBtn} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
                        <Text style={notifStyles.viewAllText}>View All Notifications</Text>
                      </LinearGradient>
                    </TouchableOpacity>
                  )}
                </View>
              </SafeAreaViewContext>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>

      {/* ── REPLY DETAILS MODAL ──────────────────────────── */}
      <Modal visible={showReplyDetailsModal} transparent animationType="fade" onRequestClose={() => setShowReplyDetailsModal(false)}>
        <View style={replyStyles.overlay}>
          <View style={replyStyles.modal}>
            <View style={replyStyles.header}>
              <Text style={replyStyles.title}>📬 {selectedReplyDetails?.companyName || 'Reply Details'}</Text>
              <TouchableOpacity onPress={() => setShowReplyDetailsModal(false)} style={replyStyles.closeBtn}>
                <Ionicons name="close" size={18} color={T.textMuted} />
              </TouchableOpacity>
            </View>
            {selectedReplyDetails?.replies?.length > 0 && (() => {
              const first = selectedReplyDetails.replies[0];
              return (
                <>
                  <Text style={replyStyles.from} numberOfLines={1}>✉️  {first.replyFromEmail}</Text>
                  <Text style={replyStyles.subject} numberOfLines={2}>{first.replySubject || '(No Subject)'}</Text>
                  <Text style={replyStyles.count}>{selectedReplyDetails.count} {selectedReplyDetails.count === 1 ? 'reply' : 'replies'}</Text>
                  <ScrollView style={replyStyles.body} nestedScrollEnabled>
                    {[...selectedReplyDetails.replies].sort((a, b) => new Date(b.replyDate) - new Date(a.replyDate)).map((r, i) => (
                      <View key={r.id || i} style={replyStyles.card}>
                        <Text style={replyStyles.date}>{new Date(r.replyDate).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</Text>
                        <Text style={replyStyles.snippet}>{r.replySnippet || '(No content available)'}</Text>
                      </View>
                    ))}
                  </ScrollView>
                </>
              );
            })()}
            <TouchableOpacity style={replyStyles.closeAction} onPress={() => setShowReplyDetailsModal(false)}>
              <Text style={replyStyles.closeActionText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ── REPLY DATE PICKER ────────────────────────────── */}
      <Modal visible={showReplyDatePicker} transparent animationType="slide" onRequestClose={() => setShowReplyDatePicker(false)}>
        <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' }}>
          <TouchableWithoutFeedback onPress={() => setShowReplyDatePicker(false)}>
            <View style={{ flex: 1 }} />
          </TouchableWithoutFeedback>
          <SafeAreaViewContext style={{ backgroundColor: T.surface }}>
            <View style={{ padding: 16 }}>
              <View style={{ alignItems: 'center', marginBottom: 8 }}>
                <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: T.border }} />
                <Text style={{ fontSize: 15, fontWeight: '700', color: T.ink, marginTop: 8 }}>Reply Date</Text>
              </View>
              <DateTimePicker
                value={selectedReplyDate}
                mode="date"
                display="spinner"
                onChange={(event, date) => {
                  const d = date || selectedReplyDate;
                  setSelectedReplyDate(d);
                  if (selectedReplyDateRef) selectedReplyDateRef.current = d;
                }}
                maximumDate={new Date()}
                themeVariant="light"
                style={{ height: 216, width: '100%' }}
              />
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
                <TouchableOpacity style={pickerStyles.cancelBtn} onPress={() => setShowReplyDatePicker(false)}>
                  <Text style={pickerStyles.cancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={{ flex: 1 }} onPress={async () => {
                  try {
                    const response = await fetch(`${API_BASE}/users/application-history/${replyAppId}`, {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${userRef?.current?.token}` },
                      body: JSON.stringify({ replyReceived: true, replyDate: (selectedReplyDateRef?.current ?? selectedReplyDate).toLocaleDateString('en-CA') }),
                    });
                    if (response.ok) {
                      const iso = (selectedReplyDateRef?.current ?? selectedReplyDate).toLocaleDateString('en-CA');
                      setApplicationHistory(prev => {
                        const updated = prev.map(item => item.id === replyAppId ? { ...item, replyReceived: true, replyDate: iso } : item);
                        return updated;
                      });
                      setTotalReplied(p => p + 1);
                      setShowReplyDatePicker(false);
                    }
                  } catch (e) { console.error(e); }
                }}>
                  <LinearGradient colors={[T.blue, T.purple]} style={pickerStyles.confirmBtn} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
                    <Text style={pickerStyles.confirmText}>Confirm</Text>
                  </LinearGradient>
                </TouchableOpacity>
              </View>
            </View>
          </SafeAreaViewContext>
        </View>
      </Modal>
    </SafeAreaViewContext>
  );

  function handlePendingReady() {
    handleReview();
  }
}

// ─── Utility computations ─────────────────────────────────────────────────────
function avgReplyDays(history) {
  const replied = history.filter(a => a.replyReceived && a.replyDate && a.sentDate);
  if (!replied.length) return '—';
  const total = replied.reduce((sum, a) => {
    const diff = (new Date(a.replyDate) - new Date(a.sentDate)) / 86400000;
    return sum + Math.max(0, diff);
  }, 0);
  return Math.round(total / replied.length).toString();
}

function interviewCount(history) {
  return history.filter(a => a.interviewScheduled).length.toString();
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: T.bg },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 20 },

  // Top bar
  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: 12, paddingBottom: 12, paddingHorizontal: 16,
    backgroundColor: T.bg,
  },
  logoRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  logoImg: { width: 37, height: 37 },
  wordmark: { fontSize: 18, letterSpacing: -0.3 },
  wordmarkCv: { fontWeight: '700', color: T.ink },
  wordmarkApplyr: { fontWeight: '700', color: T.blue },
  topBarActions: { flexDirection: 'row', gap: 8 },
  iconCard: {
    width: 38, height: 38, backgroundColor: T.surface, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: T.border,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4, elevation: 1,
  },
  bellBadge: {
    position: 'absolute', top: 5, right: 5,
    minWidth: 14, height: 14, borderRadius: 7,
    backgroundColor: T.rose, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: T.surface,
  },
  bellBadgeText: { fontSize: 8, fontWeight: '800', color: '#fff', paddingHorizontal: 2 },
  hamburger: { gap: 3 },
  hamburgerLine: { width: 16, height: 1.5, backgroundColor: T.ink, borderRadius: 1 },

  // Hero card
  heroCard: {
    marginHorizontal: 16, borderRadius: 24, overflow: 'hidden',
    padding: 20, paddingBottom: 16, marginBottom: 12,
    minHeight: 220,
  },
  meshBlob1: {
    position: 'absolute', width: 180, height: 180, borderRadius: 90,
    backgroundColor: T.blue, opacity: 0.12,
    top: -40, left: -40,
  },
  meshBlob2: {
    position: 'absolute', width: 150, height: 150, borderRadius: 75,
    backgroundColor: T.teal, opacity: 0.10,
    top: 20, right: -30,
  },
  meshBlob3: {
    position: 'absolute', width: 130, height: 130, borderRadius: 65,
    backgroundColor: T.purple, opacity: 0.10,
    bottom: 10, left: 60,
  },
  meshBlob4: {
    position: 'absolute', width: 100, height: 100, borderRadius: 50,
    backgroundColor: T.rose, opacity: 0.08,
    bottom: -20, right: 40,
  },
  heroTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  heroWelcome: { fontSize: 14, color: 'rgba(255,255,255,0.7)', fontWeight: '500' },
  heroName: { color: '#fff', fontWeight: '700' },
  streakPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(255,255,255,0.12)', borderRadius: 20,
    paddingHorizontal: 10, paddingVertical: 5,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)',
  },
  streakFlame: { fontSize: 13 },
  streakText: { fontSize: 12, fontWeight: '600', color: '#fff' },
  creditsRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  creditsNumber: { fontSize: 64, fontWeight: '800', color: '#fff', lineHeight: 68, letterSpacing: -2 },
  creditsLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 1.6, color: 'rgba(255,255,255,0.5)', marginBottom: 10, marginTop: 2 },
  replyMiniCard: {
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 16, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)',
    paddingHorizontal: 16, paddingVertical: 12,
    alignItems: 'center', justifyContent: 'center',
    alignSelf: 'flex-start', marginTop: 4,
  },
  replyMiniLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 1.4, color: 'rgba(255,255,255,0.5)', marginBottom: 5 },
  replyMiniValue: { fontSize: 22, fontWeight: '800', color: '#fff', lineHeight: 26 },
  replyMiniRate: { fontSize: 12, fontWeight: '600', color: T.teal, marginTop: 3 },
  topUpPill: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: '#fff', borderRadius: 20,
    paddingHorizontal: 13, paddingVertical: 6,
    alignSelf: 'flex-start', marginBottom: 16,
  },
  topUpText: { fontSize: 12, fontWeight: '700', color: T.ink },
  heroStatStrip: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.10)',
    borderRadius: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
    paddingVertical: 12,
  },
  heroStat: { flex: 1, alignItems: 'center' },
  heroStatLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 1, color: 'rgba(255,255,255,0.5)', marginBottom: 4 },
  heroStatValue: { fontSize: 15, fontWeight: '800', color: '#fff' },
  heroStatDivider: { width: 1, height: 28, backgroundColor: 'rgba(255,255,255,0.12)' },

  // Section card
  sectionCard: {
    backgroundColor: T.surface, borderRadius: 16, marginHorizontal: 16,
    padding: 18, marginBottom: 14,
    borderWidth: 1, borderColor: T.border,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.04, shadowRadius: 8, elevation: 1,
  },
  section: { marginHorizontal: 16, marginBottom: 14, marginTop: 6 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 },
  sectionTitle: { fontSize: 17, fontWeight: '700', color: T.ink },
  sectionSub: { fontSize: 12, color: T.textMuted, marginTop: 3 },
  detailsLink: { fontSize: 12, color: T.blue, fontWeight: '600' },
  chartLegend: { flexDirection: 'row', gap: 14, marginTop: 12 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendSwatch: { width: 22, height: 6, borderRadius: 3 },
  legendText: { fontSize: 12, color: T.textMuted, fontWeight: '500' },

  // Count pill
  countPill: { backgroundColor: T.ink, borderRadius: 10, paddingHorizontal: 9, paddingVertical: 3 },
  countPillText: { fontSize: 11, fontWeight: '700', color: '#fff' },
  addPill: { borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8 },
  addPillText: { fontSize: 13, fontWeight: '700', color: '#fff' },

  // Generate all button
  generateAllBtn: { borderRadius: 14, paddingVertical: 17, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  generateAllText: { fontSize: 15, fontWeight: '700', color: '#fff' },
  creditsBadge: { backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 10, paddingHorizontal: 9, paddingVertical: 4 },
  creditsBadgeText: { fontSize: 12, fontWeight: '700', color: '#fff' },

  // Sync pill
  syncPill: { backgroundColor: T.emerald, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6, flexDirection: 'row', alignItems: 'center', gap: 4 },
  syncText: { fontSize: 12, fontWeight: '700', color: '#fff' },

  // Stats strip
  statsStrip: {
    backgroundColor: T.surface, borderRadius: 12, flexDirection: 'row', alignItems: 'center',
    borderWidth: 1, borderColor: T.border, marginBottom: 10,
  },
  stripDivider: { width: 1, height: 32, backgroundColor: T.border },

  // Empty state
  emptyState: { alignItems: 'center', paddingVertical: 32, gap: 8 },
  emptyTitle: { fontSize: 15, fontWeight: '700', color: T.ink },
  emptySub: { fontSize: 12, color: T.textMuted, textAlign: 'center' },
});

const menuStyles = StyleSheet.create({
  container: { flex: 1, flexDirection: 'row' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  panel: {
    width: 280, backgroundColor: T.surface, padding: 20,
    shadowColor: '#000', shadowOffset: { width: -4, height: 0 }, shadowOpacity: 0.15, shadowRadius: 20, elevation: 12,
  },
  closeBtn: { alignSelf: 'flex-end', marginBottom: 12, width: 32, height: 32, borderRadius: 16, backgroundColor: T.inputBg, alignItems: 'center', justifyContent: 'center' },
  item: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  iconBox: { width: 34, height: 34, borderRadius: 10, backgroundColor: T.blue + '15', alignItems: 'center', justifyContent: 'center' },
  itemTitle: { fontSize: 14, fontWeight: '600', color: T.ink },
  itemSub: { fontSize: 11, color: T.textMuted, marginTop: 1 },
  divider: { height: 1, backgroundColor: T.border, marginVertical: 4 },
});

const notifStyles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  wrapper: { backgroundColor: T.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '80%' },
  sheet: { flex: 1, padding: 16 },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: T.border, alignSelf: 'center', marginBottom: 12 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  title: { fontSize: 17, fontWeight: '700', color: T.ink },
  badge: { backgroundColor: T.rose, borderRadius: 10, paddingHorizontal: 7, paddingVertical: 2 },
  badgeText: { fontSize: 10, fontWeight: '700', color: '#fff' },
  empty: { alignItems: 'center', paddingVertical: 40, gap: 8 },
  emptyText: { fontSize: 13, color: T.textMuted },
  item: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderColor: T.border },
  itemUnread: { backgroundColor: T.blue + '08' },
  notifIcon: { width: 32, height: 32, borderRadius: 10, backgroundColor: T.blue + '15', alignItems: 'center', justifyContent: 'center' },
  itemTitle: { fontSize: 13, fontWeight: '600', color: T.ink, flex: 1 },
  itemTime: { fontSize: 10, color: T.textFaint },
  itemMsg: { fontSize: 11, color: T.textMuted, marginTop: 2 },
  unreadDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: T.blue, marginTop: 5 },
  viewAllBtn: { borderRadius: 12, paddingVertical: 13, alignItems: 'center', marginTop: 8 },
  viewAllText: { fontSize: 14, fontWeight: '700', color: '#fff' },
});

const replyStyles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 20 },
  modal: { backgroundColor: T.surface, borderRadius: 20, padding: 20, maxHeight: '80%' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  title: { fontSize: 16, fontWeight: '700', color: T.ink, flex: 1 },
  closeBtn: { width: 28, height: 28, borderRadius: 14, backgroundColor: T.inputBg, alignItems: 'center', justifyContent: 'center' },
  from: { fontSize: 12, color: T.textMuted, marginBottom: 4 },
  subject: { fontSize: 13, fontWeight: '600', color: T.ink, marginBottom: 4 },
  count: { fontSize: 11, color: T.textFaint, marginBottom: 12 },
  body: { maxHeight: 240 },
  card: { backgroundColor: T.inputBg, borderRadius: 10, padding: 12, marginBottom: 8 },
  date: { fontSize: 10, color: T.textFaint, marginBottom: 4 },
  snippet: { fontSize: 12, color: T.ink },
  closeAction: { backgroundColor: T.inputBg, borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 12 },
  closeActionText: { fontSize: 14, fontWeight: '600', color: T.ink },
});

const pickerStyles = StyleSheet.create({
  cancelBtn: { flex: 1, borderWidth: 1, borderColor: T.border, borderRadius: 12, paddingVertical: 13, alignItems: 'center' },
  cancelText: { fontSize: 14, fontWeight: '600', color: T.ink },
  confirmBtn: { borderRadius: 12, paddingVertical: 13, alignItems: 'center' },
  confirmText: { fontSize: 14, fontWeight: '700', color: '#fff' },
});

const tabStyles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    bottom: 0, left: 0, right: 0,
    paddingHorizontal: 20,
    paddingBottom: 28,  // extra room above home indicator on iPhone
    paddingTop: 8,
    // soft gradient fade so scroll content doesn't hard-cut
    backgroundColor: 'transparent',
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: T.surface,
    borderRadius: 28,
    paddingVertical: 8,
    paddingHorizontal: 8,
    gap: 4,
    shadowColor: '#0B0F22',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.14,
    shadowRadius: 24,
    elevation: 12,
  },
  // Active tab: gradient pill
  activeTab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 22,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  activeLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: '#fff',
    letterSpacing: -0.2,
  },
  // Inactive tab
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingVertical: 6,
  },
  label: {
    fontSize: 10,
    fontWeight: '600',
    color: T.textFaint,
    letterSpacing: -0.1,
  },
});
