import React, { useRef, useEffect, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView,
  Animated, Modal, ActivityIndicator, StatusBar, Alert, Image,
  TouchableWithoutFeedback, Platform,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView as SafeAreaViewContext, useSafeAreaInsets } from 'react-native-safe-area-context';
import DateTimePicker from '@react-native-community/datetimepicker';

// ─── Design tokens ─────────────────────────────────────────────────────────────
const T = {
  bg:          '#E5EAF3',
  bgSoft:      '#DCE2ED',
  surface:     '#FFFFFF',
  inputBg:     '#F1F4FA',
  ink:         '#0B0F22',
  inkSoft:     '#1A2046',
  textMuted:   '#5B6B8A',
  textFaint:   '#8896B0',
  border:      'rgba(11,15,34,0.06)',
  borderHi:    'rgba(11,15,34,0.10)',
  blue:        '#4F8DFF',
  blueDeep:    '#2563EB',
  purple:      '#7C6BFF',
  purpleDeep:  '#5B4FE8',
  teal:        '#14B8A6',
  emerald:     '#10B981',
  amber:       '#F59E0B',
  rose:        '#EF4444',
};

// ─── Helpers ────────────────────────────────────────────────────────────────────
function domainFrom(website) {
  if (!website) return '';
  return website.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
}

function companyFrom(recipient) {
  if (recipient.website) return domainFrom(recipient.website);
  if (recipient.email) return recipient.email.split('@')[1] || 'Company';
  return 'Company';
}

// ─── HTMLCoverLetterPreview ─────────────────────────────────────────────────────
function HTMLCoverLetterPreview({ htmlContent }) {
  if (!htmlContent) return <Text style={rStyles.previewEmpty}>No cover letter generated yet.</Text>;
  const html = `<!DOCTYPE html><html><head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; padding: 0; font-family: -apple-system, sans-serif;
             font-size: 13px; line-height: 1.65; color: #1a2046; background: transparent;
             overflow: hidden; }
      p { margin: 0 0 10px; }
      strong { font-weight: 700; }
      br { display: block; margin-bottom: 4px; }
    </style></head><body>${htmlContent}</body></html>`;
  return (
    <WebView
      source={{ html }}
      style={rStyles.previewWebView}
      scrollEnabled={false}
      javaScriptEnabled={false}
      showsVerticalScrollIndicator={false}
      pointerEvents="none"
    />
  );
}

// ─── PulsingDot ─────────────────────────────────────────────────────────────────
function PulsingDot({ color = T.emerald, size = 6 }) {
  const anim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.loop(Animated.sequence([
      Animated.timing(anim, { toValue: 0.4, duration: 600, useNativeDriver: true }),
      Animated.timing(anim, { toValue: 1,   duration: 600, useNativeDriver: true }),
    ])).start();
  }, []);
  return <Animated.View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, opacity: anim }} />;
}

// ─── ReviewScreen ───────────────────────────────────────────────────────────────
export default function ReviewScreen({
  // navigation
  setScreen,
  // data
  user, creditBalance, unreadCount,
  recipients, currentReviewTab, setCurrentReviewTab,
  reviewCoverLetters,
  // card flip
  getRecipientFlipAnim, handleRecipientFlip,
  // edit mode
  editingReviewIndex, toggleReviewEditMode,
  editedCoverLetterData, setEditedCoverLetterData,
  showAddressDropdown, setShowAddressDropdown,
  saveReviewEdits,
  // handlers
  generateCoverLetterForReview,
  downloadCoverLetterPDFFromReview,
  sendApplicationFromReview,
  generateAllCoverLettersForReview,
  sendAllApplicationsFromReview,
  generateAndSendAllApplications,
  // states
  reviewGeneratingIndex,
  reviewLoading, reviewDownloading,
  reviewGeneratingAll, reviewSendingAll, reviewGeneratingAndSendingAll,
  isAnyLoadingActive, allApplicationsSent,
  progressiveLoadingMessage, progressiveLoadingProgress,
  progressAnimValue, cancelOperation,
  // payment modal
  showPaymentModal, setShowPaymentModal,
  paymentUrl, setPaymentUrl,
  // date picker
  showReviewDatePicker, setShowReviewDatePicker,
  selectedReviewDate, setSelectedReviewDate, selectedReviewDateRef,
  // notifications
  setShowNotifications,
  // cover letter preview modal (full view)
  showCoverLetterPreview, setShowCoverLetterPreview,
}) {
  const activeRecipient = recipients[currentReviewTab] || {};
  const activeEmail     = activeRecipient?.email;

  // Cover letters are keyed by recipient email (stable). We also do a legacy linear
  // scan as a fallback so any old numeric-keyed entries are never lost.
  const activeCL = (() => {
    if (!activeEmail) return null;
    if (reviewCoverLetters[activeEmail]) return reviewCoverLetters[activeEmail];
    return Object.values(reviewCoverLetters).find(
      e => e?.storedRecipientEmail === activeEmail
    ) || null;
  })();
  const totalRecipients = recipients.length;

  // word count helper
  function wordCount(html) {
    if (!html) return 0;
    return html.replace(/<[^>]*>/g, '').trim().split(/\s+/).filter(Boolean).length;
  }
  const wc = wordCount(activeCL?.coverLetterHtml);
  const readMin = Math.max(1, Math.ceil(wc / 200));

  return (
    <SafeAreaViewContext style={rStyles.container}>
      <StatusBar barStyle="dark-content" backgroundColor={T.bg} translucent={false} />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={rStyles.scrollContent}
      >
        {/* ── TOP BAR ─────────────────────────────────────────────────── */}
        <View style={rStyles.topBar}>
          {/* Back pill */}
          <TouchableOpacity
            style={rStyles.backPill}
            onPress={() => setScreen('dashboard')}
            activeOpacity={0.8}
          >
            <Ionicons name="arrow-back" size={14} color={T.ink} />
            <Text style={rStyles.backPillText}>Back</Text>
          </TouchableOpacity>

          {/* Wordmark */}
          <View style={rStyles.wordmark}>
            <Image
              source={require('../assets/images/logo_img.png')}
              style={rStyles.wordmarkLogo}
              resizeMode="contain"
            />
            <Text style={rStyles.wordmarkText}>
              cv<Text style={rStyles.wordmarkBlue}>applyr</Text>
            </Text>
          </View>

          {/* Bell */}
          <TouchableOpacity
            style={rStyles.bellBtn}
            onPress={() => setShowNotifications && setShowNotifications(true)}
            activeOpacity={0.8}
          >
            <Ionicons name="notifications-outline" size={18} color={T.ink} />
            {unreadCount > 0 && (
              <View style={rStyles.bellBadge}>
                <Text style={rStyles.bellBadgeText}>{unreadCount > 9 ? '9+' : unreadCount}</Text>
              </View>
            )}
          </TouchableOpacity>
        </View>

        {/* ── HERO CARD ─────────────────────────────────────────────────── */}
        <View style={rStyles.heroCard}>
          <LinearGradient
            colors={['#0B0F22', '#0F1635', '#0B0F22']}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFillObject}
          />
          {/* Mesh blobs */}
          <View style={[rStyles.meshBlob, { top: -20, left: -30, backgroundColor: 'rgba(79,141,255,0.18)', width: 140, height: 140 }]} />
          <View style={[rStyles.meshBlob, { top: 10, right: -20, backgroundColor: 'rgba(124,107,255,0.14)', width: 110, height: 110 }]} />
          <View style={[rStyles.meshBlob, { bottom: -10, left: 60, backgroundColor: 'rgba(20,184,166,0.10)', width: 90, height: 90 }]} />

          {/* Eyebrow row */}
          <View style={rStyles.heroEyeRow}>
            <Text style={rStyles.heroEyebrow}>STEP 3 · REVIEW &amp; SEND</Text>
            <TouchableOpacity
              style={rStyles.creditChip}
              onPress={() => setScreen('usage')}
              activeOpacity={0.8}
            >
              <Ionicons name="diamond" size={10} color="#fff" />
              <Text style={rStyles.creditChipText}>{creditBalance}</Text>
            </TouchableOpacity>
          </View>

          {/* Title */}
          <Text style={rStyles.heroTitle}>Review applications.</Text>
          <Text style={rStyles.heroSub}>
            Polish each cover letter, then send to all {totalRecipients} recipient{totalRecipients !== 1 ? 's' : ''}.
          </Text>

          {/* Step indicator strip */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={rStyles.stepsScroll}
            contentContainerStyle={rStyles.stepsContent}
          >
            {recipients.map((_, i) => {
              const isActive = i === currentReviewTab;
              return (
                <React.Fragment key={i}>
                  <TouchableOpacity
                    onPress={() => setCurrentReviewTab(i)}
                    activeOpacity={0.8}
                    style={[rStyles.stepChip, isActive && rStyles.stepChipActive]}
                  >
                    <Text style={[rStyles.stepChipText, isActive && rStyles.stepChipTextActive]}>
                      {i + 1}
                    </Text>
                  </TouchableOpacity>
                  {i < recipients.length - 1 && (
                    <View style={[rStyles.stepBar, i < currentReviewTab && rStyles.stepBarDone]} />
                  )}
                </React.Fragment>
              );
            })}
            {/* Done target */}
            <View style={rStyles.stepBar} />
            <View style={rStyles.stepDoneCircle}>
              <Ionicons name="checkmark-circle" size={18} color={T.emerald} />
            </View>
          </ScrollView>
        </View>

        {/* ── RECIPIENTS SECTION ──────────────────────────────────────── */}
        <View style={rStyles.sectionCard}>
          {/* Header */}
          <View style={rStyles.sectionHeaderRow}>
            <View style={{ flex: 1 }}>
              <View style={rStyles.sectionTitleRow}>
                <Text style={rStyles.sectionTitle}>Recipients</Text>
                <View style={rStyles.countBadge}>
                  <Text style={rStyles.countBadgeText}>{totalRecipients}</Text>
                </View>
              </View>
              <Text style={rStyles.sectionSub}>
                Tap to switch · {currentReviewTab + 1} of {totalRecipients}
              </Text>
            </View>
            <View style={rStyles.allReadyPill}>
              <PulsingDot color={T.emerald} size={5} />
              <Text style={rStyles.allReadyText}>All ready</Text>
            </View>
          </View>

          {/* Chips row */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={rStyles.chipsScroll}
          >
            {recipients.map((r, i) => {
              const isActive = i === currentReviewTab;
              const company  = companyFrom(r);
              const initial  = company[0]?.toUpperCase() ?? 'C';
              const GRAD_PAIRS = [
                [T.blue, T.purple],
                [T.teal, T.emerald],
                [T.purple, T.rose],
                [T.amber, '#F97316'],
                [T.emerald, T.teal],
              ];
              const grad = GRAD_PAIRS[i % GRAD_PAIRS.length];
              return (
                <TouchableOpacity
                  key={i}
                  onPress={() => setCurrentReviewTab(i)}
                  activeOpacity={0.8}
                  style={[rStyles.chip, isActive && rStyles.chipActive]}
                >
                  {/* Active check badge */}
                  {isActive && (
                    <LinearGradient
                      colors={[T.blue, T.purple]}
                      style={rStyles.chipCheckBadge}
                      start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
                    >
                      <Ionicons name="checkmark" size={8} color="#fff" />
                    </LinearGradient>
                  )}
                  {/* Avatar */}
                  <LinearGradient colors={grad} style={rStyles.chipAvatar} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>
                    <Text style={rStyles.chipAvatarText}>{initial}</Text>
                  </LinearGradient>
                  {/* Eyebrow */}
                  <View style={rStyles.chipEyeRow}>
                    <Text style={rStyles.chipNum}>#{i + 1}</Text>
                    <View style={rStyles.chipDot} />
                    <PulsingDot color={T.emerald} size={5} />
                    <Text style={rStyles.chipReadyText}>Ready</Text>
                  </View>
                  {/* Role */}
                  <Text style={rStyles.chipRole} numberOfLines={1}>{r.position || 'No position'}</Text>
                  {/* Company */}
                  <View style={rStyles.chipCompanyRow}>
                    <Ionicons name="briefcase-outline" size={9} color={T.textFaint} />
                    <Text style={rStyles.chipCompany} numberOfLines={1}>{company}</Text>
                  </View>
                  {/* Email pill */}
                  <View style={[rStyles.chipEmailPill, isActive && rStyles.chipEmailPillActive]}>
                    <Text style={[rStyles.chipEmail, isActive && rStyles.chipEmailActive]} numberOfLines={1}>
                      {r.email}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>

        {/* ── RECIPIENT DETAILS CARD ──────────────────────────────────── */}
        {activeCL ? (
          <>
            <View style={rStyles.detailsCard}>
              {/* Watermark */}
              <Text style={rStyles.detailsWatermark}>
                {companyFrom(activeRecipient)[0]?.toUpperCase() ?? 'C'}
              </Text>

              {/* Header */}
              <View style={rStyles.detailsHeader}>
                <View style={rStyles.detailsHeaderLeft}>
                  <LinearGradient
                    colors={[T.blue, T.purple]}
                    style={rStyles.detailsNumBadge}
                    start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
                  >
                    <Text style={rStyles.detailsNumText}>#{currentReviewTab + 1}</Text>
                  </LinearGradient>
                  <View>
                    <Text style={rStyles.detailsTitle}>Recipient details</Text>
                    <Text style={rStyles.detailsSub}>Verify before sending</Text>
                  </View>
                </View>
                {editingReviewIndex !== currentReviewTab && (
                  <TouchableOpacity
                    onPress={() => toggleReviewEditMode(currentReviewTab)}
                    style={rStyles.editPill}
                    activeOpacity={0.8}
                  >
                    <Ionicons name="create-outline" size={12} color="#fff" />
                    <Text style={rStyles.editPillText}>Edit</Text>
                  </TouchableOpacity>
                )}
              </View>

              {editingReviewIndex === currentReviewTab ? (
                /* ── EDIT MODE ── */
                <View style={rStyles.editForm}>
                  <EditField label="To (Hiring Manager)" value="The Hiring Manager" editable={false} />
                  <EditField
                    label="Employer"
                    value={editedCoverLetterData.companyName}
                    onChange={v => setEditedCoverLetterData({ ...editedCoverLetterData, companyName: v })}
                    placeholder="Company Name"
                  />
                  <EditField label="Email" value={editedCoverLetterData.email} editable={false} mono />

                  {/* Address */}
                  <View style={rStyles.editFieldWrap}>
                    <Text style={rStyles.editLabel}>Address</Text>
                    {activeCL.locations?.length > 0 ? (
                      <TouchableOpacity
                        style={rStyles.dropdownBtn}
                        onPress={() => setShowAddressDropdown(true)}
                        activeOpacity={0.8}
                      >
                        <Text style={rStyles.dropdownBtnText} numberOfLines={1}>
                          {editedCoverLetterData.address || 'Select Address'}
                        </Text>
                        <Ionicons name="chevron-down" size={14} color={T.textFaint} />
                      </TouchableOpacity>
                    ) : (
                      <TextInput
                        style={rStyles.editInput}
                        value={editedCoverLetterData.address}
                        onChangeText={v => setEditedCoverLetterData({ ...editedCoverLetterData, address: v })}
                        placeholder="Company Address"
                        placeholderTextColor={T.textFaint}
                      />
                    )}
                  </View>

                  {/* Address dropdown modal */}
                  <Modal visible={showAddressDropdown} transparent animationType="fade">
                    <TouchableOpacity
                      style={rStyles.dropdownOverlay}
                      onPress={() => setShowAddressDropdown(false)}
                      activeOpacity={1}
                    >
                      <View style={rStyles.dropdownMenu}>
                        <ScrollView>
                          {activeCL.locations?.map((loc, idx) => (
                            <TouchableOpacity
                              key={idx}
                              style={rStyles.dropdownItem}
                              onPress={() => {
                                setEditedCoverLetterData({
                                  ...editedCoverLetterData,
                                  address: `${loc.address}, ${loc.city}, ${loc.country}`,
                                });
                                setShowAddressDropdown(false);
                              }}
                            >
                              <Text style={rStyles.dropdownItemText}>
                                {`${loc.address}, ${loc.city}, ${loc.country}${loc.isHeadquarters ? ' (HQ)' : ''}`}
                              </Text>
                            </TouchableOpacity>
                          ))}
                        </ScrollView>
                      </View>
                    </TouchableOpacity>
                  </Modal>

                  {/* Date */}
                  <View style={rStyles.editFieldWrap}>
                    <Text style={rStyles.editLabel}>Date</Text>
                    <TouchableOpacity
                      style={rStyles.dropdownBtn}
                      onPress={() => {
                        try {
                          const d = editedCoverLetterData.date ? new Date(editedCoverLetterData.date) : new Date();
                          setSelectedReviewDate(isNaN(d.getTime()) ? new Date() : d);
                          selectedReviewDateRef.current = isNaN(d.getTime()) ? new Date() : d;
                        } catch { setSelectedReviewDate(new Date()); selectedReviewDateRef.current = new Date(); }
                        setShowReviewDatePicker(true);
                      }}
                      activeOpacity={0.8}
                    >
                      <Text style={rStyles.dropdownBtnText}>{editedCoverLetterData.date || 'Select Date'}</Text>
                      <Ionicons name="calendar-outline" size={14} color={T.textFaint} />
                    </TouchableOpacity>
                  </View>

                  <EditField
                    label="Position"
                    value={editedCoverLetterData.position}
                    onChange={v => setEditedCoverLetterData({ ...editedCoverLetterData, position: v })}
                    placeholder="Position"
                  />
                  <EditField
                    label="Subject"
                    value={editedCoverLetterData.subject}
                    onChange={v => setEditedCoverLetterData({ ...editedCoverLetterData, subject: v })}
                    placeholder="Email Subject"
                  />

                  {/* Rich text editor */}
                  <View style={rStyles.editFieldWrap}>
                    <Text style={rStyles.editLabel}>Cover Letter</Text>
                    <RichTextEditorWebViewLocal
                      initialHtml={activeCL?.coverLetterHtml || editedCoverLetterData.coverLetterHtml || ''}
                      onContentChange={html => setEditedCoverLetterData({ ...editedCoverLetterData, coverLetterHtml: html })}
                    />
                  </View>

                  {/* Save / Cancel */}
                  <View style={rStyles.editActions}>
                    <TouchableOpacity
                      style={rStyles.editSaveBtn}
                      onPress={() => saveReviewEdits(currentReviewTab)}
                      activeOpacity={0.85}
                    >
                      <LinearGradient colors={[T.emerald, '#059669']} style={rStyles.editBtnGrad} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
                        <Ionicons name="checkmark" size={14} color="#fff" />
                        <Text style={rStyles.editBtnText}>Save</Text>
                      </LinearGradient>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={rStyles.editCancelBtn}
                      onPress={() => toggleReviewEditMode(currentReviewTab)}
                      activeOpacity={0.85}
                    >
                      <View style={rStyles.editCancelInner}>
                        <Text style={rStyles.editCancelText}>Cancel</Text>
                      </View>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : (
                /* ── VIEW MODE — field grid ── */
                <View style={rStyles.fieldGrid}>
                  <FieldTile label="To" value="The Hiring Manager" icon="person-outline" full />
                  <FieldTile label="Employer" value={activeCL.companyName} icon="business-outline" full />
                  <FieldTile label="Position" value={activeRecipient.position} icon="briefcase-outline" half />
                  <FieldTile label="Date" value={activeCL.date} icon="calendar-outline" half />
                  <FieldTile label="Address" value={activeCL.address} icon="location-outline" full />
                  <FieldTile label="Email" value={activeRecipient.email} icon="mail-outline" full mono />
                  <FieldTile label="Subject" value={activeCL.subject} icon="text-outline" full />
                </View>
              )}
            </View>

            {/* ── COVER LETTER PREVIEW CARD ────────────────────────── */}
            <View style={rStyles.previewCard}>
              {/* Accent strip */}
              <LinearGradient
                colors={[T.blue, T.purple, T.teal]}
                start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                style={rStyles.previewAccent}
              />
              <View style={rStyles.previewInner}>
                {/* Header row */}
                <View style={rStyles.previewHeader}>
                  <Text style={rStyles.previewEyebrow}>📄 COVER LETTER · PREVIEW</Text>
                  <View style={rStyles.previewReadyPill}>
                    <PulsingDot color={T.emerald} size={5} />
                    <Text style={rStyles.previewReadyText}>Ready</Text>
                  </View>
                </View>

                {/* Letterhead */}
                <View style={rStyles.letterHead}>
                  <LinearGradient
                    colors={[T.blue, T.purple]}
                    style={rStyles.letterAvatar}
                    start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
                  >
                    <Text style={rStyles.letterAvatarText}>
                      {(activeCL.companyName || companyFrom(activeRecipient))[0]?.toUpperCase() ?? 'C'}
                    </Text>
                  </LinearGradient>
                  <View>
                    <Text style={rStyles.letterTo}>To {activeCL.companyName || companyFrom(activeRecipient)}</Text>
                    <Text style={rStyles.letterMeta}>{activeRecipient.position || ''}{activeRecipient.position && activeCL.date ? ' · ' : ''}{activeCL.date || ''}</Text>
                  </View>
                </View>

                {/* Perforation */}
                <View style={rStyles.perforation} />

                {/* Letter body (truncated) */}
                <View style={rStyles.letterBodyWrap}>
                  <HTMLCoverLetterPreview htmlContent={activeCL.coverLetterHtml} />
                  <LinearGradient
                    colors={['transparent', T.surface]}
                    style={rStyles.letterFade}
                    start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
                    pointerEvents="none"
                  />
                </View>

                {/* Footer */}
                <View style={rStyles.previewFooter}>
                  <Text style={rStyles.wordCountText}>{wc} words · ~{readMin} min read</Text>
                  <TouchableOpacity
                    style={rStyles.readFullPill}
                    onPress={() => setShowCoverLetterPreview && setShowCoverLetterPreview(true)}
                    activeOpacity={0.8}
                  >
                    <Text style={rStyles.readFullText}>Read full</Text>
                    <Ionicons name="arrow-forward" size={11} color={T.blue} />
                  </TouchableOpacity>
                </View>
              </View>
            </View>

            {/* ── ACTION BAR ───────────────────────────────────────── */}
            <View style={rStyles.actionCard}>
              {/* Top row: Regenerate + Download */}
              <View style={rStyles.actionTopRow}>
                {/* Regenerate */}
                <TouchableOpacity
                  style={rStyles.ghostBtn}
                  onPress={() => generateCoverLetterForReview(currentReviewTab)}
                  disabled={reviewGeneratingIndex === currentReviewTab || reviewLoading || reviewGeneratingAll || reviewGeneratingAndSendingAll}
                  activeOpacity={0.8}
                >
                  <View style={[rStyles.ghostIconTile, { backgroundColor: 'rgba(251,146,60,0.12)' }]}>
                    <Ionicons name="refresh-outline" size={16} color={T.amber} />
                  </View>
                  <Text style={rStyles.ghostBtnLabel} numberOfLines={1}>Regenerate</Text>
                  <View style={[rStyles.ghostBtnBadge, rStyles.ghostBtnBadgeCorner]}>
                    <Text style={rStyles.ghostBtnBadgeText}>1 CR</Text>
                  </View>
                </TouchableOpacity>

                <View style={rStyles.actionDivider} />

                {/* Download */}
                <TouchableOpacity
                  style={rStyles.ghostBtn}
                  onPress={() => {
                    if (creditBalance <= 0) {
                      Alert.alert(
                        'Insufficient Credits',
                        'Remaining credits are 0. Please recharge to continue.',
                        [{ text: 'Cancel', style: 'cancel' }, { text: 'Recharge Now', onPress: () => setScreen('packages') }]
                      );
                      return;
                    }
                    downloadCoverLetterPDFFromReview(currentReviewTab);
                  }}
                  disabled={reviewDownloading}
                  activeOpacity={0.8}
                >
                  <View style={[rStyles.ghostIconTile, { backgroundColor: 'rgba(20,184,166,0.12)' }]}>
                    <Ionicons name="download-outline" size={16} color={T.teal} />
                  </View>
                  <Text style={rStyles.ghostBtnLabel} numberOfLines={1}>Download</Text>
                  <View style={[rStyles.ghostBtnBadge, rStyles.ghostBtnBadgeCorner, { backgroundColor: 'rgba(20,184,166,0.12)' }]}>
                    <Text style={[rStyles.ghostBtnBadgeText, { color: T.teal }]}>PDF</Text>
                  </View>
                </TouchableOpacity>
              </View>

              {/* Send button */}
              <TouchableOpacity
                onPress={() => {
                  if (creditBalance <= 0) {
                    Alert.alert(
                      'Insufficient Credits',
                      'Remaining credits are 0. Please recharge to continue.',
                      [{ text: 'Cancel', style: 'cancel' }, { text: 'Recharge Now', onPress: () => setScreen('packages') }]
                    );
                    return;
                  }
                  sendApplicationFromReview(currentReviewTab);
                }}
                disabled={reviewLoading || reviewSendingAll || reviewGeneratingAndSendingAll || activeCL.sent}
                activeOpacity={0.85}
                style={rStyles.sendBtnWrap}
              >
                {activeCL.sent ? (
                  <View style={[rStyles.sendBtn, { backgroundColor: T.emerald }]}>
                    <View style={rStyles.sendIconBox}>
                      <Ionicons name="checkmark-circle" size={22} color={T.emerald} />
                    </View>
                    <View style={rStyles.sendTextBlock}>
                      <Text style={rStyles.sendTitle}>Application Sent</Text>
                      <Text style={rStyles.sendEmail} numberOfLines={1}>{activeRecipient.email}</Text>
                    </View>
                  </View>
                ) : (
                  <LinearGradient
                    colors={[T.blue, T.purple, T.purpleDeep]}
                    start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                    style={rStyles.sendBtn}
                  >
                    {/* Shimmer */}
                    <ShimmerOverlay />
                    <View style={rStyles.sendIconBox}>
                      <Ionicons name="send" size={20} color={T.blue} />
                    </View>
                    <View style={rStyles.sendTextBlock}>
                      <Text style={rStyles.sendTitle}>Send application</Text>
                      <Text style={rStyles.sendEmail} numberOfLines={1}>{activeRecipient.email}</Text>
                    </View>
                    <View style={rStyles.sendCreditChip}>
                      <Ionicons name="diamond" size={9} color="#fff" />
                      <Text style={rStyles.sendCreditText}> 1</Text>
                    </View>
                    <View style={rStyles.sendArrowCircle}>
                      <Ionicons name="arrow-forward" size={18} color="#fff" />
                    </View>
                  </LinearGradient>
                )}
              </TouchableOpacity>
            </View>
          </>
        ) : (
          /* ── EMPTY STATE (no cover letter yet) ─────────────────────── */
          <View style={rStyles.emptyCard}>
            <LinearGradient colors={[T.blue + '15', T.purple + '10']} style={rStyles.emptyIconBox} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>
              <Ionicons name="document-text-outline" size={32} color={T.blue} />
            </LinearGradient>
            <Text style={rStyles.emptyTitle}>No Cover Letter Generated</Text>
            <Text style={rStyles.emptySub}>
              Generate a professional cover letter to review and send to this recipient
            </Text>
            <TouchableOpacity
              style={rStyles.emptyGenBtn}
              onPress={() => {
                if (creditBalance <= 0) {
                  Alert.alert('Insufficient Credits', 'Please recharge to continue.', [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Recharge Now', onPress: () => setScreen('packages') },
                  ]);
                  return;
                }
                generateCoverLetterForReview(currentReviewTab);
              }}
              disabled={reviewGeneratingIndex === currentReviewTab || reviewGeneratingAll || reviewGeneratingAndSendingAll}
              activeOpacity={0.85}
            >
              <LinearGradient colors={[T.blue, T.purple]} style={rStyles.emptyGenGrad} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
                <Ionicons name="sparkles" size={14} color="#fff" />
                <Text style={rStyles.emptyGenText}>Generate Cover Letter</Text>
              </LinearGradient>
            </TouchableOpacity>
          </View>
        )}

        {/* ── BATCH OPERATIONS CARD ────────────────────────────────────── */}
        <View style={rStyles.batchCard}>
          <LinearGradient
            colors={['#0B0F22', '#0F1635', '#0B0F22']}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFillObject}
          />
          {/* Mesh */}
          <View style={[rStyles.meshBlob, { top: -15, right: -10, backgroundColor: 'rgba(124,107,255,0.18)', width: 100, height: 100 }]} />
          <View style={[rStyles.meshBlob, { bottom: -10, left: 20, backgroundColor: 'rgba(16,185,129,0.12)', width: 80, height: 80 }]} />

          {/* Header */}
          <View style={rStyles.batchHeader}>
            <View style={rStyles.batchHeaderLeft}>
              <View style={rStyles.batchIconBox}>
                <Ionicons name="flash" size={14} color={T.amber} />
              </View>
              <View>
                <Text style={rStyles.batchTitle}>Batch operations</Text>
                <Text style={rStyles.batchSub}>Run actions across all {totalRecipients} applications at once.</Text>
              </View>
            </View>
            <View style={rStyles.batchReadyPill}>
              <PulsingDot color={T.emerald} size={5} />
              <Text style={rStyles.batchReadyText}>Ready</Text>
            </View>
          </View>

          {/* Queue strip */}
          <View style={rStyles.queueStrip}>
            <View style={rStyles.queueEnvelopes}>
              {recipients.slice(0, 4).map((_, i) => {
                const GRADS = [[T.blue, T.purple], [T.teal, T.emerald], [T.amber, '#F97316'], [T.purple, T.rose]];
                return (
                  <LinearGradient key={i} colors={GRADS[i % GRADS.length]} style={[rStyles.queueEnvelope, { marginLeft: i === 0 ? 0 : -10, zIndex: 4 - i }]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>
                    <Ionicons name="mail" size={10} color="#fff" />
                  </LinearGradient>
                );
              })}
            </View>
            <View style={{ flex: 1, marginLeft: 10 }}>
              <Text style={rStyles.queueCount}>{totalRecipients} in queue</Text>
              <Text style={rStyles.queueNames} numberOfLines={1}>
                {recipients.slice(0, 3).map(r => companyFrom(r)).join(' · ')}
              </Text>
            </View>
            <View style={rStyles.queueCreditChip}>
              <Text style={rStyles.queueCreditText}>{creditBalance} cr</Text>
            </View>
          </View>

          {/* Pipeline row */}
          <View style={rStyles.pipeline}>
            {/* Stage 1: Generate all */}
            <TouchableOpacity
              style={rStyles.pipelineStage}
              onPress={generateAllCoverLettersForReview}
              activeOpacity={0.8}
            >
              <LinearGradient colors={['rgba(16,185,129,0.2)', 'rgba(16,185,129,0.08)']} style={rStyles.pipelineStageInner} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}>
                <Ionicons name="sparkles" size={18} color={T.emerald} />
                <Text style={rStyles.pipelineStageTitle}>Generate all</Text>
                <Text style={rStyles.pipelineStageSub}>Fresh letters</Text>
              </LinearGradient>
            </TouchableOpacity>

            {/* Arrow */}
            <View style={rStyles.pipelineArrow}>
              <Ionicons name="arrow-forward" size={16} color="rgba(255,255,255,0.4)" />
            </View>

            {/* Stage 2: Send all */}
            <TouchableOpacity
              style={rStyles.pipelineStage}
              onPress={sendAllApplicationsFromReview}
              activeOpacity={0.8}
            >
              <LinearGradient colors={['rgba(79,141,255,0.2)', 'rgba(79,141,255,0.08)']} style={rStyles.pipelineStageInner} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}>
                <Ionicons name="send" size={18} color={T.blue} />
                <Text style={rStyles.pipelineStageTitle}>Send all</Text>
                <Text style={rStyles.pipelineStageSub}>Email everyone</Text>
              </LinearGradient>
            </TouchableOpacity>
          </View>

          {/* OR DO IT ALL divider */}
          <View style={rStyles.orDivider}>
            <View style={rStyles.orLine} />
            <Text style={rStyles.orLabel}>OR DO IT ALL</Text>
            <View style={rStyles.orLine} />
          </View>

          {/* Auto process button */}
          <TouchableOpacity
            onPress={generateAndSendAllApplications}
            disabled={allApplicationsSent}
            activeOpacity={0.85}
            style={rStyles.autoProcessWrap}
          >
            <LinearGradient
              colors={allApplicationsSent ? ['#374151', '#4B5563'] : [T.purple, T.blue]}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
              style={rStyles.autoProcessBtn}
            >
              <ShimmerOverlay />
              <View style={rStyles.autoProIconBox}>
                <Ionicons name="flash" size={16} color={T.purple} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={rStyles.autoProcessTitle}>
                  {allApplicationsSent ? 'All Completed ✓' : 'Auto process'}
                </Text>
                <Text style={rStyles.autoProcessSub}>Generate &amp; send to all</Text>
              </View>
              <View style={rStyles.proBadge}>
                <Text style={rStyles.proBadgeText}>PRO</Text>
              </View>
              <View style={rStyles.autoArrowCircle}>
                <Ionicons name="arrow-forward" size={16} color="#fff" />
              </View>
            </LinearGradient>
          </TouchableOpacity>
        </View>

        {/* ── FLOATING TAB BAR ────────────────────────────────────────── */}
        <View style={{ height: 90 }} />
      </ScrollView>

      {/* Tab bar */}
      <View style={rStyles.tabWrapper}>
        <View style={rStyles.tabBar}>
          {/* Home */}
          <TouchableOpacity style={rStyles.tab} onPress={() => setScreen('dashboard')} activeOpacity={0.7}>
            <Ionicons name="home-outline" size={20} color={T.textFaint} />
            <Text style={rStyles.tabLabel}>Home</Text>
          </TouchableOpacity>
          {/* Jobs */}
          <TouchableOpacity style={rStyles.tab} onPress={() => { try { require('expo-router').router?.push?.('/(ai-hub)'); } catch (_) {} }} activeOpacity={0.7}>
            <Ionicons name="briefcase-outline" size={20} color={T.textFaint} />
            <Text style={rStyles.tabLabel}>Jobs</Text>
          </TouchableOpacity>
          {/* Letters — ACTIVE */}
          <LinearGradient colors={[T.blue, T.blueDeep]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={rStyles.tabActive}>
            <TouchableOpacity style={rStyles.tabActiveInner} activeOpacity={0.8}>
              <Ionicons name="document-text" size={16} color="#fff" />
              <Text style={rStyles.tabActiveLabel}>Letters</Text>
            </TouchableOpacity>
          </LinearGradient>
          {/* Me */}
          <TouchableOpacity style={rStyles.tab} onPress={() => setScreen('profile')} activeOpacity={0.7}>
            <Ionicons name="person-outline" size={20} color={T.textFaint} />
            <Text style={rStyles.tabLabel}>Me</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* ── LOADING MODAL ───────────────────────────────────────────── */}
      <Modal visible={isAnyLoadingActive} transparent animationType="fade">
        <View style={rStyles.loadingOverlay}>
          <View style={rStyles.loadingCard}>
            <LinearGradient colors={['#0B0F22', '#1A2046']} style={StyleSheet.absoluteFillObject} />
            <ActivityIndicator size="large" color={T.blue} />
            <Text style={rStyles.loadingTitle}>
              {reviewGeneratingAll ? 'Generating Cover Letters' :
               reviewSendingAll ? 'Sending Applications' :
               reviewGeneratingAndSendingAll ? 'Auto Processing' :
               reviewDownloading ? 'Preparing Download' :
               reviewLoading ? 'Sending Application' : 'Processing…'}
            </Text>
            <Text style={rStyles.loadingSub}>
              {progressiveLoadingMessage ||
               (reviewGeneratingAll ? 'Creating professional cover letters…' :
                reviewSendingAll ? 'Delivering applications…' :
                reviewGeneratingAndSendingAll ? 'Generating and sending…' :
                reviewDownloading ? 'Generating your PDF…' :
                'Please wait…')}
            </Text>
            {progressiveLoadingProgress > 0 && (
              <View style={rStyles.loadingProgress}>
                <View style={rStyles.loadingProgressBg}>
                  <Animated.View style={[rStyles.loadingProgressFill, {
                    width: progressAnimValue.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] }),
                  }]}>
                    <LinearGradient colors={[T.blue, T.purple]} style={StyleSheet.absoluteFillObject} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} />
                  </Animated.View>
                </View>
                <Text style={rStyles.loadingPct}>{progressiveLoadingProgress}%</Text>
              </View>
            )}
            <TouchableOpacity style={rStyles.loadingCancelBtn} onPress={cancelOperation} activeOpacity={0.8}>
              <Ionicons name="close" size={14} color={T.textFaint} />
              <Text style={rStyles.loadingCancelText}>Cancel Operation</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ── PAYMENT MODAL ───────────────────────────────────────────── */}
      <Modal
        visible={showPaymentModal}
        animationType="slide"
        onRequestClose={() => { setShowPaymentModal(false); setPaymentUrl(''); }}
      >
        <SafeAreaViewContext style={{ flex: 1, backgroundColor: '#fff' }}>
          <View style={rStyles.paymentHeader}>
            <TouchableOpacity onPress={() => { setShowPaymentModal(false); setPaymentUrl(''); }} style={{ padding: 8 }}>
              <Text style={{ fontSize: 16, color: T.blue }}>✕ Close</Text>
            </TouchableOpacity>
            <Text style={{ flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '600' }}>Complete Payment</Text>
            <View style={{ width: 60 }} />
          </View>
          <WebView
            source={{ uri: paymentUrl }}
            style={{ flex: 1 }}
            onNavigationStateChange={navState => {
              if (navState.url.includes('/payment-success.html')) {
                setTimeout(() => { setShowPaymentModal(false); setPaymentUrl(''); }, 1000);
              } else if (navState.url.includes('/payment-failure.html')) {
                setTimeout(() => {
                  setShowPaymentModal(false); setPaymentUrl('');
                  Alert.alert('Payment Failed', 'Payment was not completed. Please try again.');
                }, 1000);
              }
            }}
            javaScriptEnabled domStorageEnabled startInLoadingState scalesPageToFit
          />
        </SafeAreaViewContext>
      </Modal>

      {/* ── FULL COVER LETTER MODAL ─────────────────────────────────── */}
      <Modal
        visible={!!showCoverLetterPreview}
        animationType="slide"
        onRequestClose={() => setShowCoverLetterPreview && setShowCoverLetterPreview(false)}
      >
        <FullCoverLetterView
          htmlContent={activeCL?.coverLetterHtml}
          onClose={() => setShowCoverLetterPreview && setShowCoverLetterPreview(false)}
        />
      </Modal>

      {/* ── DATE PICKER MODAL ───────────────────────────────────────── */}
      <Modal
        transparent
        visible={showReviewDatePicker}
        animationType="slide"
        onRequestClose={() => setShowReviewDatePicker(false)}
      >
        <View style={rStyles.dateOverlay}>
          <TouchableWithoutFeedback onPress={() => setShowReviewDatePicker(false)}>
            <View style={{ flex: 1 }} />
          </TouchableWithoutFeedback>
          <SafeAreaViewContext style={rStyles.dateSheetWrap}>
            <View style={rStyles.dateSheet}>
              <View style={rStyles.dateHandle} />
              <Text style={rStyles.dateTitle}>Cover Letter Date</Text>
              <DateTimePicker
                value={selectedReviewDate}
                mode="date"
                display="spinner"
                onChange={(_, date) => {
                  const d = date || selectedReviewDate;
                  setSelectedReviewDate(d);
                  selectedReviewDateRef.current = d;
                }}
                themeVariant="light"
                style={{ height: 216, width: '100%' }}
              />
              <View style={rStyles.dateActions}>
                <TouchableOpacity style={rStyles.dateCancelBtn} onPress={() => setShowReviewDatePicker(false)}>
                  <Text style={rStyles.dateCancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={rStyles.dateConfirmBtnWrap}
                  onPress={() => {
                    const d = selectedReviewDateRef.current.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
                    setEditedCoverLetterData({ ...editedCoverLetterData, date: d });
                    setShowReviewDatePicker(false);
                  }}
                >
                  <LinearGradient colors={[T.blue, T.purple]} style={rStyles.dateConfirmBtn} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
                    <Text style={rStyles.dateConfirmText}>Confirm</Text>
                  </LinearGradient>
                </TouchableOpacity>
              </View>
            </View>
          </SafeAreaViewContext>
        </View>
      </Modal>
    </SafeAreaViewContext>
  );
}

// ─── Small helper components ────────────────────────────────────────────────────
function EditField({ label, value, onChange, editable = true, placeholder, mono }) {
  return (
    <View style={rStyles.editFieldWrap}>
      <Text style={rStyles.editLabel}>{label}</Text>
      <TextInput
        style={[rStyles.editInput, !editable && rStyles.editInputReadOnly, mono && rStyles.editInputMono]}
        value={value}
        onChangeText={onChange}
        editable={editable}
        placeholder={placeholder}
        placeholderTextColor={T.textFaint}
      />
    </View>
  );
}

function FieldTile({ label, value, icon, full, half, mono }) {
  return (
    <View style={[rStyles.tile, full && rStyles.tileFull, half && rStyles.tileHalf]}>
      <View style={rStyles.tileLabel}>
        {icon && <Ionicons name={icon} size={9} color={T.textFaint} />}
        <Text style={rStyles.tileLabelText}>{label.toUpperCase()}</Text>
      </View>
      <Text style={[rStyles.tileValue, mono && rStyles.tileValueMono]} numberOfLines={2}>{value || '—'}</Text>
    </View>
  );
}

function ShimmerOverlay() {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.loop(
      Animated.timing(anim, { toValue: 1, duration: 2000, useNativeDriver: true })
    ).start();
  }, []);
  const translateX = anim.interpolate({ inputRange: [0, 1], outputRange: [-200, 300] });
  return (
    <Animated.View
      style={[StyleSheet.absoluteFillObject, { transform: [{ translateX }], borderRadius: 16 }]}
      pointerEvents="none"
    >
      <LinearGradient
        colors={['transparent', 'rgba(255,255,255,0.18)', 'transparent']}
        start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
        style={StyleSheet.absoluteFillObject}
      />
    </Animated.View>
  );
}

// Inline rich text editor (mirrors the one in App.js)
function RichTextEditorWebViewLocal({ initialHtml, onContentChange }) {
  const editorHtml = `<!DOCTYPE html><html><head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="https://cdn.quilljs.com/1.3.6/quill.snow.css" rel="stylesheet">
  <script src="https://cdn.quilljs.com/1.3.6/quill.min.js"></script>
  <style>
    body { margin:0; font-family:-apple-system,sans-serif; }
    #editor { min-height:400px; font-size:15px; }
    .ql-toolbar { position:sticky; top:0; z-index:10; background:#fff; }
  </style></head><body>
  <div id="editor">${initialHtml || ''}</div>
  <script>
    var quill = new Quill('#editor', { theme:'snow', modules:{toolbar:[[{header:[1,2,false]}],['bold','italic','underline'],['clean']]} });
    quill.on('text-change', function() {
      window.ReactNativeWebView && window.ReactNativeWebView.postMessage(quill.root.innerHTML);
    });
  </script></body></html>`;
  return (
    <WebView
      source={{ html: editorHtml }}
      style={{ height: 500, borderRadius: 12, overflow: 'hidden' }}
      javaScriptEnabled
      domStorageEnabled
      onMessage={e => onContentChange && onContentChange(e.nativeEvent.data)}
    />
  );
}

// ─── FullCoverLetterView ────────────────────────────────────────────────────────
// Separate component so useSafeAreaInsets works correctly inside a Modal
function FullCoverLetterView({ htmlContent, onClose }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: T.bg }}>
      <StatusBar barStyle="dark-content" backgroundColor={T.bg} />
      {/* WebView constrained to safe area — starts below notch, ends above home bar */}
      <WebView
        source={{ html: `<!DOCTYPE html><html><head>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body { margin: 0; padding: 20px 20px 80px; font-family: -apple-system, Georgia, serif;
                   font-size: 15px; line-height: 1.75; color: #1a2046; background: #f0f4fa; }
            p { margin: 0 0 14px; }
            strong { font-weight: 700; }
          </style></head><body>
          ${htmlContent || '<p style="color:#8896B0">No cover letter content yet.</p>'}
          </body></html>` }}
        style={{ flex: 1, marginTop: insets.top, marginBottom: insets.bottom }}
        javaScriptEnabled
        domStorageEnabled
        startInLoadingState
        renderLoading={() => (
          <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: T.bg }}>
            <ActivityIndicator color={T.blue} />
          </View>
        )}
      />
      {/* Floating close button — bottom-right, above home bar */}
      <TouchableOpacity
        onPress={onClose}
        activeOpacity={0.85}
        style={[rStyles.clFloatingClose, { bottom: insets.bottom + 20, right: 20 }]}
      >
        <Ionicons name="close" size={16} color="#fff" />
        <Text style={rStyles.clFloatingCloseText}>Close</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────────
const rStyles = StyleSheet.create({
  container:     { flex: 1, backgroundColor: T.bg },
  scrollContent: { paddingBottom: 20 },

  // Top bar
  topBar:         { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12 },
  backPill:       { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: T.surface, borderRadius: 100, paddingHorizontal: 12, paddingVertical: 7, borderWidth: 1, borderColor: T.borderHi, shadowColor: T.ink, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 6, elevation: 2 },
  backPillText:   { fontSize: 13, fontWeight: '600', color: T.ink },
  wordmark:       { position: 'absolute', left: 0, right: 0, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 6, pointerEvents: 'none' },
  wordmarkLogo:   { width: 22, height: 22 },
  wordmarkText:   { fontSize: 21, fontWeight: '800', color: T.ink, letterSpacing: 0.5 },
  wordmarkBlue:   { color: T.blue },
  bellBtn:        { width: 38, height: 38, borderRadius: 12, backgroundColor: T.surface, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: T.border, position: 'relative' },
  bellBadge:      { position: 'absolute', top: -4, right: -4, backgroundColor: T.rose, borderRadius: 10, minWidth: 16, height: 16, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center' },
  bellBadgeText:  { fontSize: 9, fontWeight: '700', color: '#fff' },

  // Hero card
  heroCard:       { marginHorizontal: 16, borderRadius: 24, overflow: 'hidden', padding: 20, marginBottom: 12, shadowColor: T.ink, shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.22, shadowRadius: 24, elevation: 8 },
  meshBlob:       { position: 'absolute', borderRadius: 1000 },
  heroEyeRow:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  heroEyebrow:    { fontSize: 10, fontWeight: '700', letterSpacing: 1.4, color: 'rgba(255,255,255,0.55)' },
  creditChip:     { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 100, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)' },
  creditChipText: { fontSize: 12, fontWeight: '700', color: '#fff' },
  heroTitle:      { fontSize: 28, fontWeight: '800', color: '#fff', letterSpacing: -0.8, marginBottom: 6 },
  heroSub:        { fontSize: 13, color: 'rgba(255,255,255,0.55)', fontWeight: '500', marginBottom: 18, lineHeight: 18 },

  // Step indicator
  stepsScroll:    { marginHorizontal: -4 },
  stepsContent:   { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, paddingBottom: 4 },
  stepChip:       { width: 30, height: 30, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.12)', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)' },
  stepChipActive: { backgroundColor: '#fff', borderColor: '#fff' },
  stepChipText:   { fontSize: 12, fontWeight: '700', color: 'rgba(255,255,255,0.7)' },
  stepChipTextActive: { color: T.ink },
  stepBar:        { flex: 1, height: 2, backgroundColor: 'rgba(255,255,255,0.15)', marginHorizontal: 4, minWidth: 14, maxWidth: 30 },
  stepBarDone:    { backgroundColor: T.blue },
  stepDoneCircle: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },

  // Section card
  sectionCard:    { backgroundColor: T.surface, borderRadius: 20, marginHorizontal: 16, marginBottom: 12, padding: 16, shadowColor: T.ink, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.07, shadowRadius: 16, elevation: 3 },
  sectionHeaderRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 },
  sectionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sectionTitle:   { fontSize: 15, fontWeight: '700', color: T.ink },
  countBadge:     { backgroundColor: T.ink, borderRadius: 100, paddingHorizontal: 8, paddingVertical: 2 },
  countBadgeText: { fontSize: 11, fontWeight: '700', color: '#fff' },
  sectionSub:     { fontSize: 11, color: T.textFaint, marginTop: 2 },
  allReadyPill:   { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: T.emerald + '15', borderRadius: 100, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: T.emerald + '30' },
  allReadyText:   { fontSize: 11, fontWeight: '700', color: T.emerald },

  // Recipient chips
  chipsScroll:    { flexDirection: 'row', gap: 10, paddingBottom: 4 },
  chip:           { width: 130, backgroundColor: T.bgSoft, borderRadius: 16, padding: 12, borderWidth: 1.5, borderColor: T.border, position: 'relative', opacity: 0.85 },
  chipActive:     { borderColor: T.blue, backgroundColor: T.surface, opacity: 1, shadowColor: T.blue, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.22, shadowRadius: 12, elevation: 4 },
  chipCheckBadge: { position: 'absolute', top: 8, right: 8, width: 18, height: 18, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  chipAvatar:     { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  chipAvatarText: { fontSize: 16, fontWeight: '800', color: '#fff' },
  chipEyeRow:     { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 4 },
  chipNum:        { fontSize: 10, fontWeight: '700', color: T.textFaint },
  chipDot:        { width: 3, height: 3, borderRadius: 2, backgroundColor: T.textFaint },
  chipReadyText:  { fontSize: 10, fontWeight: '600', color: T.emerald },
  chipRole:       { fontSize: 12, fontWeight: '700', color: T.ink, marginBottom: 3 },
  chipCompanyRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 6 },
  chipCompany:    { fontSize: 10, color: T.textFaint, flex: 1 },
  chipEmailPill:  { backgroundColor: T.bgSoft, borderRadius: 100, paddingHorizontal: 7, paddingVertical: 3 },
  chipEmailPillActive: { backgroundColor: T.blue + '15' },
  chipEmail:      { fontSize: 9, fontFamily: 'Courier', color: T.textFaint },
  chipEmailActive: { color: T.blue },

  // Details card
  detailsCard:    { backgroundColor: T.bgSoft, borderRadius: 22, marginHorizontal: 16, marginBottom: 12, padding: 16, overflow: 'hidden', shadowColor: T.ink, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.08, shadowRadius: 20, elevation: 3 },
  detailsWatermark: { position: 'absolute', right: -8, top: -16, fontSize: 150, fontWeight: '800', color: T.ink, opacity: 0.03, lineHeight: 150 },
  detailsHeader:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  detailsHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  detailsNumBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  detailsNumText: { fontSize: 12, fontWeight: '800', color: '#fff' },
  detailsTitle:   { fontSize: 14, fontWeight: '700', color: T.ink },
  detailsSub:     { fontSize: 11, color: T.textFaint, marginTop: 1 },
  editPill:       { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: T.ink, borderRadius: 100, paddingHorizontal: 12, paddingVertical: 6 },
  editPillText:   { fontSize: 12, fontWeight: '700', color: '#fff' },

  // Field grid (view mode)
  fieldGrid:      { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tile:           { backgroundColor: T.surface, borderRadius: 12, padding: 10, borderWidth: 1, borderColor: T.border },
  tileFull:       { width: '100%' },
  tileHalf:       { flex: 1, minWidth: 0 },
  tileLabel:      { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 4 },
  tileLabelText:  { fontSize: 9, fontWeight: '700', letterSpacing: 0.8, color: T.textFaint },
  tileValue:      { fontSize: 13, fontWeight: '700', color: T.ink, lineHeight: 18 },
  tileValueMono:  { fontFamily: 'Courier', fontSize: 11 },

  // Edit form
  editForm:       { gap: 12 },
  editFieldWrap:  { gap: 6 },
  editLabel:      { fontSize: 11, fontWeight: '700', letterSpacing: 0.5, color: T.textMuted },
  editInput:      { backgroundColor: T.surface, borderRadius: 10, borderWidth: 1, borderColor: T.borderHi, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: T.ink },
  editInputReadOnly: { backgroundColor: T.inputBg, color: T.textFaint },
  editInputMono:  { fontFamily: 'Courier' },
  dropdownBtn:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: T.surface, borderRadius: 10, borderWidth: 1, borderColor: T.borderHi, paddingHorizontal: 12, paddingVertical: 10 },
  dropdownBtnText: { fontSize: 14, color: T.ink, flex: 1 },
  dropdownOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', padding: 24 },
  dropdownMenu:   { backgroundColor: T.surface, borderRadius: 16, overflow: 'hidden', maxHeight: 280 },
  dropdownItem:   { padding: 14, borderBottomWidth: 1, borderBottomColor: T.border },
  dropdownItemText: { fontSize: 13, color: T.ink },
  editActions:    { flexDirection: 'row', gap: 10, marginTop: 4 },
  editSaveBtn:    { flex: 1, borderRadius: 12, overflow: 'hidden' },
  editBtnGrad:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, height: 44 },
  editBtnText:    { fontSize: 14, fontWeight: '700', color: '#fff' },
  editCancelBtn:  { flex: 1, borderRadius: 12, overflow: 'hidden' },
  editCancelInner: { height: 44, backgroundColor: T.bgSoft, alignItems: 'center', justifyContent: 'center', borderRadius: 12 },
  editCancelText: { fontSize: 14, fontWeight: '700', color: T.textMuted },

  // Cover letter preview card
  previewCard:    { backgroundColor: T.surface, borderRadius: 20, marginHorizontal: 16, marginBottom: 12, overflow: 'hidden', shadowColor: T.ink, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.08, shadowRadius: 20, elevation: 3 },
  previewAccent:  { height: 4 },
  previewInner:   { padding: 16 },
  previewHeader:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  previewEyebrow: { fontSize: 10, fontWeight: '700', letterSpacing: 1, color: T.textFaint },
  previewReadyPill: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: T.emerald + '15', borderRadius: 100, paddingHorizontal: 9, paddingVertical: 4, borderWidth: 1, borderColor: T.emerald + '30' },
  previewReadyText: { fontSize: 10, fontWeight: '700', color: T.emerald },
  letterHead:     { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  letterAvatar:   { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  letterAvatarText: { fontSize: 16, fontWeight: '800', color: '#fff' },
  letterTo:       { fontSize: 13, fontWeight: '700', color: T.ink },
  letterMeta:     { fontSize: 11, color: T.textFaint, marginTop: 1 },
  perforation:    { height: 1, borderTopWidth: 1, borderStyle: 'dashed', borderColor: T.borderHi, marginBottom: 12 },
  letterBodyWrap: { height: 220, overflow: 'hidden', position: 'relative' },
  letterFade:     { position: 'absolute', left: 0, right: 0, bottom: 0, height: 80 },
  previewWebView: { height: 220, backgroundColor: 'transparent' },
  previewEmpty:   { fontSize: 13, color: T.textFaint, textAlign: 'center', paddingVertical: 20 },
  previewFooter:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 },
  wordCountText:  { fontSize: 11, color: T.textFaint, fontWeight: '500' },
  readFullPill:   { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: T.blue + '12', borderRadius: 100, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: T.blue + '25' },
  readFullText:   { fontSize: 11, fontWeight: '700', color: T.blue },

  // Action card
  actionCard:     { backgroundColor: T.surface, borderRadius: 20, marginHorizontal: 16, marginBottom: 12, padding: 14, shadowColor: T.ink, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.08, shadowRadius: 20, elevation: 3 },
  actionTopRow:   { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  ghostBtn:       { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: T.inputBg, borderRadius: 14, padding: 12, paddingBottom: 18, position: 'relative' },
  ghostIconTile:  { width: 32, height: 32, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  ghostBtnLabel:  { flex: 1, fontSize: 13, fontWeight: '700', color: T.ink },
  ghostBtnBadge:  { backgroundColor: 'rgba(251,146,60,0.12)', borderRadius: 100, paddingHorizontal: 7, paddingVertical: 3 },
  ghostBtnBadgeCorner: { position: 'absolute', bottom: 6, right: 8 },
  ghostBtnBadgeText: { fontSize: 9, fontWeight: '700', color: T.amber },
  actionDivider:  { width: 10 },
  sendBtnWrap:    { borderRadius: 16, overflow: 'hidden' },
  sendBtn:        { height: 60, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, borderRadius: 16, overflow: 'hidden' },
  sendIconBox:    { width: 40, height: 40, borderRadius: 12, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  sendTextBlock:  { flex: 1 },
  sendTitle:      { fontSize: 15, fontWeight: '800', color: '#fff' },
  sendEmail:      { fontSize: 10, color: 'rgba(255,255,255,0.65)', fontFamily: 'Courier', marginTop: 2 },
  sendCreditChip: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 100, paddingHorizontal: 8, paddingVertical: 4, marginRight: 10 },
  sendCreditText: { fontSize: 11, fontWeight: '700', color: '#fff' },
  sendArrowCircle: { width: 42, height: 42, borderRadius: 21, backgroundColor: 'rgba(255,255,255,0.22)', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)' },

  // Empty state
  emptyCard:      { backgroundColor: T.surface, borderRadius: 20, marginHorizontal: 16, marginBottom: 12, padding: 28, alignItems: 'center', shadowColor: T.ink, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.07, shadowRadius: 16, elevation: 3 },
  emptyIconBox:   { width: 64, height: 64, borderRadius: 18, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  emptyTitle:     { fontSize: 16, fontWeight: '700', color: T.ink, marginBottom: 8, textAlign: 'center' },
  emptySub:       { fontSize: 13, color: T.textMuted, textAlign: 'center', lineHeight: 18, marginBottom: 20 },
  emptyGenBtn:    { borderRadius: 14, overflow: 'hidden', alignSelf: 'stretch' },
  emptyGenGrad:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 48 },
  emptyGenText:   { fontSize: 14, fontWeight: '700', color: '#fff' },

  // Batch card
  batchCard:      { marginHorizontal: 16, borderRadius: 24, overflow: 'hidden', padding: 18, marginBottom: 12, shadowColor: T.ink, shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.22, shadowRadius: 24, elevation: 8 },
  batchHeader:    { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 },
  batchHeaderLeft: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, flex: 1 },
  batchIconBox:   { width: 32, height: 32, borderRadius: 9, backgroundColor: 'rgba(245,158,11,0.2)', alignItems: 'center', justifyContent: 'center' },
  batchTitle:     { fontSize: 15, fontWeight: '800', color: '#fff' },
  batchSub:       { fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 2 },
  batchReadyPill: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(16,185,129,0.2)', borderRadius: 100, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: 'rgba(16,185,129,0.3)' },
  batchReadyText: { fontSize: 10, fontWeight: '700', color: T.emerald },

  // Queue strip
  queueStrip:     { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.07)', borderRadius: 14, padding: 12, marginBottom: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  queueEnvelopes: { flexDirection: 'row' },
  queueEnvelope:  { width: 28, height: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.25)' },
  queueCount:     { fontSize: 12, fontWeight: '700', color: '#fff' },
  queueNames:     { fontSize: 10, color: 'rgba(255,255,255,0.5)', marginTop: 1 },
  queueCreditChip: { backgroundColor: 'rgba(245,158,11,0.2)', borderRadius: 100, paddingHorizontal: 9, paddingVertical: 4, borderWidth: 1, borderColor: 'rgba(245,158,11,0.3)' },
  queueCreditText: { fontSize: 11, fontWeight: '700', color: T.amber },

  // Pipeline
  pipeline:       { flexDirection: 'row', alignItems: 'center', gap: 0, marginBottom: 16 },
  pipelineStage:  { flex: 1, borderRadius: 14, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)' },
  pipelineStageInner: { alignItems: 'center', justifyContent: 'center', padding: 14, gap: 4 },
  pipelineStageTitle: { fontSize: 13, fontWeight: '700', color: '#fff' },
  pipelineStageSub: { fontSize: 10, color: 'rgba(255,255,255,0.5)' },
  pipelineArrow:  { paddingHorizontal: 10 },

  // OR divider
  orDivider:      { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 14 },
  orLine:         { flex: 1, height: 1, backgroundColor: 'rgba(255,255,255,0.1)' },
  orLabel:        { fontSize: 10, fontWeight: '700', letterSpacing: 1.2, color: 'rgba(255,255,255,0.4)' },

  // Auto process
  autoProcessWrap: { borderRadius: 16, overflow: 'hidden' },
  autoProcessBtn: { height: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, overflow: 'hidden' },
  autoProIconBox: { width: 36, height: 36, borderRadius: 10, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  autoProcessTitle: { fontSize: 15, fontWeight: '800', color: '#fff' },
  autoProcessSub: { fontSize: 11, color: 'rgba(255,255,255,0.6)', marginTop: 1 },
  proBadge:       { backgroundColor: 'rgba(255,255,255,0.25)', borderRadius: 100, paddingHorizontal: 8, paddingVertical: 3, marginRight: 10 },
  proBadgeText:   { fontSize: 10, fontWeight: '700', color: '#fff' },
  autoArrowCircle: { width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(255,255,255,0.22)', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)' },

  // Tab bar
  tabWrapper:     { position: 'absolute', bottom: 0, left: 0, right: 0, paddingHorizontal: 20, paddingBottom: 28, paddingTop: 8, backgroundColor: 'transparent' },
  tabBar:         { flexDirection: 'row', alignItems: 'center', backgroundColor: T.surface, borderRadius: 28, paddingVertical: 8, paddingHorizontal: 8, gap: 4, shadowColor: T.ink, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.14, shadowRadius: 24, elevation: 12 },
  tab:            { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3, paddingVertical: 6 },
  tabLabel:       { fontSize: 10, fontWeight: '600', color: T.textFaint, letterSpacing: -0.1 },
  tabActive:      { flex: 1, borderRadius: 22 },
  tabActiveInner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, paddingHorizontal: 12 },
  tabActiveLabel: { fontSize: 13, fontWeight: '700', color: '#fff', letterSpacing: -0.2 },

  // Loading modal
  loadingOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', alignItems: 'center', justifyContent: 'center', padding: 32 },
  loadingCard:    { width: '100%', borderRadius: 24, padding: 28, alignItems: 'center', overflow: 'hidden', gap: 14 },
  loadingTitle:   { fontSize: 18, fontWeight: '800', color: '#fff', textAlign: 'center' },
  loadingSub:     { fontSize: 13, color: 'rgba(255,255,255,0.6)', textAlign: 'center', lineHeight: 18 },
  loadingProgress: { width: '100%', gap: 8 },
  loadingProgressBg: { height: 6, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 3, overflow: 'hidden', width: '100%' },
  loadingProgressFill: { height: 6, borderRadius: 3, overflow: 'hidden' },
  loadingPct:     { fontSize: 13, fontWeight: '700', color: '#fff', textAlign: 'center' },
  loadingCancelBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6, backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 100, paddingHorizontal: 16, paddingVertical: 10 },
  loadingCancelText: { fontSize: 13, fontWeight: '600', color: T.textFaint },

  // Payment modal
  paymentHeader:  { flexDirection: 'row', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: '#e5e7eb' },

  // Date picker
  dateOverlay:    { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  dateSheetWrap:  { backgroundColor: T.surface },
  dateSheet:      { backgroundColor: T.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingTop: 12 },
  dateHandle:     { width: 40, height: 4, backgroundColor: T.border, borderRadius: 2, alignSelf: 'center', marginBottom: 16 },
  dateTitle:      { fontSize: 16, fontWeight: '700', color: T.ink, textAlign: 'center', marginBottom: 12 },
  dateActions:    { flexDirection: 'row', gap: 12, marginTop: 16 },
  dateCancelBtn:  { flex: 1, height: 48, backgroundColor: T.inputBg, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  dateCancelText: { fontSize: 14, fontWeight: '700', color: T.textMuted },
  dateConfirmBtnWrap: { flex: 1, borderRadius: 12, overflow: 'hidden' },
  dateConfirmBtn: { height: 48, alignItems: 'center', justifyContent: 'center' },
  dateConfirmText: { fontSize: 14, fontWeight: '700', color: '#fff' },

  // Full cover letter modal — floating close pill
  clFloatingClose:     { position: 'absolute', flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(11,15,34,0.75)', borderRadius: 100, paddingHorizontal: 18, paddingVertical: 11, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.22, shadowRadius: 12, elevation: 8 },
  clFloatingCloseText: { fontSize: 14, fontWeight: '700', color: '#fff' },
});
