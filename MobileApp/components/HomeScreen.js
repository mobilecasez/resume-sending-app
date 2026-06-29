import React, { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import ReplyComposeModal from './ReplyComposeModal';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView,
  Animated, Modal, ActivityIndicator, SafeAreaView, StatusBar, Alert,
  TouchableWithoutFeedback, Image, Dimensions, Linking, Platform, RefreshControl,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect } from 'expo-router';
import { useEventCosts } from '../hooks/useEventCosts';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView as SafeAreaViewContext } from 'react-native-safe-area-context';
import DateTimePicker from '@react-native-community/datetimepicker';
import { downloadAsync, cacheDirectory } from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import AsyncStorage from '@react-native-async-storage/async-storage';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// ─── Design tokens ────────────────────────────────────────────────────────────
const T = {
  bg:        '#E5EAF3',
  bgSoft:    '#DCE2ED',
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

// ─── Module-level caches (persist while app is in memory) ────────────────────
// Card state: recipientId → { genState, coverLetterText, dlState, sendState }
const _cardStateCache = {};
// Generated counts per day: 'YYYY-MM-DD' → count (survives HomeScreen remounts)
const _generatedCountsCache = {};
// Call this on logout to prevent stale state leaking across user sessions
export function clearHomeScreenCache() {
  Object.keys(_cardStateCache).forEach(k => delete _cardStateCache[k]);
  Object.keys(_generatedCountsCache).forEach(k => delete _generatedCountsCache[k]);
}

// ─── Generation stage labels ──────────────────────────────────────────────────
function getStageLabel(progress) {
  if (progress < 25) return 'Analyzing Resume…';
  if (progress < 55) return 'Fetching company info…';
  if (progress < 80) return 'Generating cover letter…';
  return 'Writing final draft…';
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
function ActivityChart({ applicationHistory, chartTick = 0, usageData, tooltip, setTooltip }) {

  const days = useMemo(() => {
    // Prefer usageData.dateWiseActivity — same source as the Usage & Credits screen
    if (usageData?.dateWiseActivity?.length > 0) {
      // Take the last 7 days from the server data
      const slice = usageData.dateWiseActivity.slice(-7);
      return slice.map((d, i) => {
        const date = new Date(d.date);
        const offsetFromToday = slice.length - 1 - i;
        return {
          label: weekDayLabel(offsetFromToday),
          sent: d.sent || 0,
          generated: d.generated || 0,
          dateStr: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        };
      });
    }
    // Fallback: derive from applicationHistory + in-session generated cache
    const arr = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toLocaleDateString('en-CA');
      const sent = applicationHistory.filter(a => {
        const s = a.sentDate ? new Date(a.sentDate).toLocaleDateString('en-CA') : null;
        return s === key;
      }).length;
      const generated = Math.max(sent, _generatedCountsCache[key] || 0);
      const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      arr.push({ label: weekDayLabel(i), sent, generated, dateKey: key, dateStr });
    }
    return arr;
  }, [applicationHistory, chartTick, usageData]);

  const maxVal = Math.max(1, ...days.map(d => Math.max(d.sent, d.generated)));
  const BAR_H = 36;

  function handleBarPress(d, i) {
    if (tooltip && tooltip.index === i) { setTooltip(null); return; }
    setTooltip({ index: i, sent: d.sent, generated: d.generated, dateStr: d.dateStr });
  }

  return (
    <View style={chartStyles.row}>
      {days.map((d, i) => (
        <TouchableOpacity
          key={i}
          style={chartStyles.col}
          activeOpacity={0.75}
          onPress={() => handleBarPress(d, i)}
        >
          {/* Tooltip above bar */}
          {tooltip?.index === i && (
            <View style={chartStyles.tooltip}>
              <Text style={chartStyles.tooltipTitle}>{d.dateStr}</Text>
              <View style={chartStyles.tooltipRow}>
                <View style={[chartStyles.tooltipDot, { backgroundColor: T.blue }]} />
                <Text style={chartStyles.tooltipText}>Generated: {d.generated}</Text>
              </View>
              <View style={chartStyles.tooltipRow}>
                <View style={[chartStyles.tooltipDot, { backgroundColor: T.teal }]} />
                <Text style={chartStyles.tooltipText}>Sent: {d.sent}</Text>
              </View>
              <View style={chartStyles.tooltipArrow} />
            </View>
          )}

          <View style={chartStyles.barWrap}>
            {/* Generated bar (blue/purple gradient) */}
            <LinearGradient
              colors={d.generated > 0 ? [T.blue, T.purple] : [T.bgSoft, T.bgSoft]}
              style={[chartStyles.groupBar, {
                height: d.generated > 0 ? Math.max(4, (d.generated / maxVal) * BAR_H) : 4,
                borderWidth: d.generated > 0 ? 0 : 1,
                borderColor: T.border,
              }]}
              start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
            />
            {/* Sent bar (teal) */}
            <View style={[chartStyles.groupBar, {
              height: d.sent > 0 ? Math.max(4, (d.sent / maxVal) * BAR_H) : 4,
              backgroundColor: d.sent > 0 ? T.teal : T.bgSoft,
              borderWidth: d.sent > 0 ? 0 : 1,
              borderColor: T.border,
            }]} />
          </View>
          <Text style={[chartStyles.label, tooltip?.index === i && { color: T.blue, fontWeight: '700' }]}>{d.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}
const chartStyles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  col: { alignItems: 'center', flex: 1, position: 'relative' },
  barWrap: { height: 36, flexDirection: 'row', alignItems: 'flex-end', gap: 3, justifyContent: 'center' },
  groupBar: { width: 8, borderRadius: 3 },
  label: { marginTop: 6, fontSize: 11, color: T.textFaint, fontWeight: '600' },
  // Tooltip
  tooltip: {
    position: 'absolute',
    bottom: '110%',
    backgroundColor: T.ink,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    zIndex: 99,
    minWidth: 130,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 8,
    elevation: 8,
  },
  tooltipTitle: { fontSize: 11, fontWeight: '700', color: '#fff', marginBottom: 5, textAlign: 'center' },
  tooltipRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 3 },
  tooltipDot: { width: 6, height: 6, borderRadius: 3 },
  tooltipText: { fontSize: 11, color: 'rgba(255,255,255,0.85)', fontWeight: '500' },
  tooltipArrow: {
    width: 0, height: 0,
    borderLeftWidth: 5, borderRightWidth: 5, borderTopWidth: 6,
    borderLeftColor: 'transparent', borderRightColor: 'transparent', borderTopColor: T.ink,
    alignSelf: 'center', marginTop: 2,
  },
});

// ─── GenerateButton — matches the HTML prototype exactly ────────────────────
// idle:    full blue→purple gradient + "Generate Cover Letter" + glass arrow pill
// loading: #9FB9E8 base + animated fill left→right + shimmer + spinner + % on right
// done:    stays fully filled, checkmark + "Generated ✓"
function GenerateButton({ state, progress, progressAnim, onPress, stageLabel }) {
  const spinAnim = useRef(new Animated.Value(0)).current;
  const shimAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (state === 'loading') {
      Animated.loop(Animated.timing(spinAnim, { toValue: 1, duration: 800, useNativeDriver: true })).start();
      Animated.loop(Animated.timing(shimAnim, { toValue: 1, duration: 2200, useNativeDriver: true })).start();
    } else {
      spinAnim.stopAnimation(); shimAnim.stopAnimation();
    }
  }, [state]);

  const spin = spinAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const shimX = shimAnim.interpolate({ inputRange: [0, 1], outputRange: [-160, 360] });
  const fillW = progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

  if (state === 'idle') {
    return (
      <TouchableOpacity onPress={onPress} activeOpacity={0.85} style={genBtnStyles.wrap}>
        <LinearGradient colors={['#4F8DFF', '#7C6BFF', '#5B4FE8']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
        <View style={genBtnStyles.idleContent}>
          <Ionicons name="sparkles" size={14} color="#fff" />
          <Text style={genBtnStyles.label}>Generate Cover Letter</Text>
        </View>
        <View style={genBtnStyles.arrowPill}>
          <Ionicons name="arrow-forward" size={14} color="#fff" />
        </View>
      </TouchableOpacity>
    );
  }

  if (state === 'loading') {
    return (
      <View style={[genBtnStyles.wrap, { backgroundColor: '#9FB9E8' }]}>
        {/* Animated fill */}
        <Animated.View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: fillW, overflow: 'hidden' }}>
          <LinearGradient colors={[T.blue, T.purple]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
        </Animated.View>
        {/* Shimmer sweep */}
        <Animated.View style={{ position: 'absolute', top: 0, bottom: 0, width: 80, transform: [{ translateX: shimX }] }}>
          <LinearGradient colors={['transparent', 'rgba(255,255,255,0.28)', 'transparent']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
        </Animated.View>
        {/* Content */}
        <View style={[genBtnStyles.idleContent, { justifyContent: 'space-between', paddingRight: 14, zIndex: 2 }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Animated.View style={[genBtnStyles.spinner, { transform: [{ rotate: spin }] }]} />
            <Text style={genBtnStyles.label} numberOfLines={1}>{stageLabel || 'Generating cover letter…'}</Text>
          </View>
          <Text style={genBtnStyles.pct}>{Math.round(progress)}%</Text>
        </View>
      </View>
    );
  }

  // done
  return (
    <View style={[genBtnStyles.wrap, { overflow: 'hidden' }]}>
      <LinearGradient colors={[T.teal, T.emerald]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
      <View style={genBtnStyles.idleContent}>
        <Ionicons name="checkmark-circle" size={14} color="#fff" />
        <Text style={genBtnStyles.label}>Generated ✓</Text>
      </View>
    </View>
  );
}

// ─── FillButton — for Download and Send (same liquid fill, simpler) ──────────
function FillButton({ state, progress, progressAnim, onPress, label, labelLoading, labelDone, icon, colors, style }) {
  const spinAnim = useRef(new Animated.Value(0)).current;
  const shimAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (state === 'loading') {
      Animated.loop(Animated.timing(spinAnim, { toValue: 1, duration: 800, useNativeDriver: true })).start();
      Animated.loop(Animated.timing(shimAnim, { toValue: 1, duration: 2000, useNativeDriver: true })).start();
    } else {
      spinAnim.stopAnimation(); shimAnim.stopAnimation();
    }
  }, [state]);

  const spin = spinAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const shimX = shimAnim.interpolate({ inputRange: [0, 1], outputRange: [-120, 300] });
  const fillW = progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });
  const fillColors = colors || [T.ink, '#2D3748'];

  const isLoading = state === 'loading';
  const isDone = state === 'done';

  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={isLoading}
      activeOpacity={isLoading ? 1 : 0.82}
      style={[genBtnStyles.fillWrap, style]}
    >
      {/* Base background */}
      {isDone || isLoading ? (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: '#9FB9E8', borderRadius: 12 }]} />
      ) : (
        <LinearGradient colors={fillColors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={[StyleSheet.absoluteFill, { borderRadius: 12 }]} />
      )}
      {/* Fill */}
      {(isLoading || isDone) && (
        <Animated.View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: isDone ? '100%' : fillW, borderRadius: 12, overflow: 'hidden' }}>
          <LinearGradient colors={fillColors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
        </Animated.View>
      )}
      {/* Shimmer */}
      {isLoading && (
        <Animated.View style={{ position: 'absolute', top: 0, bottom: 0, width: 60, transform: [{ translateX: shimX }], zIndex: 1 }}>
          <LinearGradient colors={['transparent', 'rgba(255,255,255,0.22)', 'transparent']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
        </Animated.View>
      )}
      {/* Content */}
      <View style={[genBtnStyles.fillContent, { zIndex: 2 }]}>
        {isLoading ? (
          <Animated.View style={[genBtnStyles.spinner, { transform: [{ rotate: spin }] }]} />
        ) : (
          <Ionicons name={isDone ? 'checkmark-circle' : icon} size={13} color="#fff" />
        )}
        <Text style={genBtnStyles.fillLabel}>
          {isDone ? labelDone : isLoading ? (labelLoading || label) : label}
        </Text>
        {isLoading && <Text style={genBtnStyles.pct}>{Math.round(progress)}%</Text>}
      </View>
    </TouchableOpacity>
  );
}

// ─── DownloadButton — white outline, liquid fill on loading ──────────────────
function DownloadButton({ state, progress, progressAnim, onPress }) {
  const spinAnim = useRef(new Animated.Value(0)).current;
  const shimAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (state === 'loading') {
      Animated.loop(Animated.timing(spinAnim, { toValue: 1, duration: 800, useNativeDriver: true })).start();
      Animated.loop(Animated.timing(shimAnim, { toValue: 1, duration: 2000, useNativeDriver: true })).start();
    } else { spinAnim.stopAnimation(); shimAnim.stopAnimation(); }
  }, [state]);
  const spin = spinAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const shimX = shimAnim.interpolate({ inputRange: [0, 1], outputRange: [-120, 300] });
  const fillW = progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });
  const isLoading = state === 'loading';
  const isDone = state === 'done';
  return (
    <TouchableOpacity onPress={onPress} disabled={isLoading} activeOpacity={isLoading ? 1 : 0.82} style={genBtnStyles.dlWrap}>
      {/* Base */}
      {(isLoading || isDone) ? (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: '#9FB9E8', borderRadius: 12 }]} />
      ) : null}
      {/* Fill */}
      {(isLoading || isDone) && (
        <Animated.View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: isDone ? '100%' : fillW, borderRadius: 12, overflow: 'hidden' }}>
          <LinearGradient colors={[T.ink, '#2D3748']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
        </Animated.View>
      )}
      {/* Shimmer */}
      {isLoading && (
        <Animated.View style={{ position: 'absolute', top: 0, bottom: 0, width: 60, transform: [{ translateX: shimX }], zIndex: 1 }}>
          <LinearGradient colors={['transparent', 'rgba(255,255,255,0.22)', 'transparent']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
        </Animated.View>
      )}
      <View style={[genBtnStyles.fillContent, { zIndex: 2 }]}>
        {isLoading ? (
          <Animated.View style={[genBtnStyles.spinner, { transform: [{ rotate: spin }] }]} />
        ) : (
          <Ionicons name={isDone ? 'checkmark-circle' : 'download-outline'} size={14} color={isDone || isLoading ? '#fff' : T.ink} />
        )}
        <Text style={[genBtnStyles.fillLabel, (!isDone && !isLoading) && { color: T.ink }]}>
          {isDone ? 'Downloaded ✓' : isLoading ? 'Downloading…' : 'Download'}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

// ─── DownloadIconBtn — compact icon-only Download (keeps progress fill) ───────
function DownloadIconBtn({ state, progressAnim, onPress }) {
  const spinAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (state === 'loading') Animated.loop(Animated.timing(spinAnim, { toValue: 1, duration: 800, useNativeDriver: true })).start();
    else spinAnim.stopAnimation();
  }, [state]);
  const spin = spinAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const fillW = progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });
  const isLoading = state === 'loading';
  const isDone = state === 'done';
  return (
    <TouchableOpacity
      onPress={onPress} disabled={isLoading} activeOpacity={isLoading ? 1 : 0.82}
      style={[genBtnStyles.iconBtn, isDone && { borderColor: 'rgba(16,185,129,0.45)', backgroundColor: 'rgba(16,185,129,0.10)' }]}
    >
      {isLoading && <View style={[StyleSheet.absoluteFill, { backgroundColor: '#9FB9E8' }]} />}
      {isLoading && <Animated.View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: fillW, backgroundColor: T.ink }} />}
      {isLoading
        ? <Animated.View style={[genBtnStyles.spinner, { transform: [{ rotate: spin }] }]} />
        : isDone
          ? <Ionicons name="checkmark-circle" size={22} color={T.emerald} />
          : <Ionicons name="document-text-outline" size={18} color={T.ink} />
      }
    </TouchableOpacity>
  );
}

// ─── SendButton — gradient with glass arrow pill, liquid fill on loading ──────
function SendButton({ state, progress, progressAnim, onPress, fullWidth = false }) {
  const spinAnim = useRef(new Animated.Value(0)).current;
  const shimAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (state === 'loading') {
      Animated.loop(Animated.timing(spinAnim, { toValue: 1, duration: 800, useNativeDriver: true })).start();
      Animated.loop(Animated.timing(shimAnim, { toValue: 1, duration: 2200, useNativeDriver: true })).start();
    } else { spinAnim.stopAnimation(); shimAnim.stopAnimation(); }
  }, [state]);
  const spin = spinAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const shimX = shimAnim.interpolate({ inputRange: [0, 1], outputRange: [-160, 360] });
  const fillW = progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });
  const isLoading = state === 'loading';
  const isDone = state === 'done';
  if (isLoading) {
    return (
      <View style={[genBtnStyles.sendWrap, { backgroundColor: '#9FB9E8' }, fullWidth && { flex: undefined, width: '100%' }]}>
        <Animated.View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: fillW, overflow: 'hidden' }}>
          <LinearGradient colors={[T.blue, T.purple, '#5B4FE8']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
        </Animated.View>
        <Animated.View style={{ position: 'absolute', top: 0, bottom: 0, width: 80, transform: [{ translateX: shimX }] }}>
          <LinearGradient colors={['transparent', 'rgba(255,255,255,0.28)', 'transparent']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
        </Animated.View>
        <View style={[genBtnStyles.idleContent, { justifyContent: 'space-between', paddingRight: 14, zIndex: 2 }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Animated.View style={[genBtnStyles.spinner, { transform: [{ rotate: spin }] }]} />
            <Text style={genBtnStyles.label}>Sending…</Text>
          </View>
          <Text style={genBtnStyles.pct}>{Math.round(progress)}%</Text>
        </View>
      </View>
    );
  }
  if (isDone) {
    return (
      <View style={[genBtnStyles.sendWrap, { overflow: 'hidden' }, fullWidth && { flex: undefined, width: '100%' }]}>
        <LinearGradient colors={[T.teal, T.emerald]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
        <View style={genBtnStyles.idleContent}>
          <Ionicons name="checkmark-circle" size={13} color="#fff" />
          <Text style={genBtnStyles.label}>Sent ✓</Text>
        </View>
      </View>
    );
  }
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85} style={[genBtnStyles.sendWrap, fullWidth && { flex: undefined, width: '100%' }]}>
      <LinearGradient colors={[T.blue, T.purple, '#5B4FE8']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
      <View style={genBtnStyles.idleContent}>
        <Ionicons name="send" size={13} color="#fff" />
        <Text style={genBtnStyles.label}>Send Now</Text>
      </View>
      <View style={genBtnStyles.arrowPill}>
        <Ionicons name="arrow-forward" size={13} color="#fff" />
      </View>
    </TouchableOpacity>
  );
}

const genBtnStyles = StyleSheet.create({
  // GenerateButton
  wrap: {
    height: 46, borderRadius: 12, overflow: 'hidden',
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingLeft: 16, paddingRight: 5, marginTop: 10,
    shadowColor: 'rgba(79,141,255,0.34)', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 1, shadowRadius: 20, elevation: 6,
  },
  idleContent: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 7,
    paddingRight: 8,
  },
  label: { fontSize: 13, fontWeight: '700', color: '#fff', letterSpacing: -0.01 },
  pct: { fontSize: 13, fontWeight: '800', color: '#fff', letterSpacing: -0.02, minWidth: 36, textAlign: 'right' },
  arrowPill: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)',
    alignItems: 'center', justifyContent: 'center',
  },
  spinner: {
    width: 14, height: 14, borderRadius: 7,
    borderWidth: 2, borderColor: 'rgba(255,255,255,0.35)',
    borderTopColor: '#fff',
  },
  // Download button (outline → fill on load)
  dlWrap: {
    flex: 1, height: 46, borderRadius: 12, overflow: 'hidden',
    flexDirection: 'row', alignItems: 'center',
    borderWidth: 1.5, borderColor: '#CBD5E1',
    backgroundColor: '#fff',
  },
  // Compact icon-only action button (Download / Edit)
  iconBtn: {
    width: 46, height: 46, borderRadius: 12, overflow: 'hidden',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: '#CBD5E1', backgroundColor: '#fff',
  },
  // Send Now button (gradient → fill on load)
  sendWrap: {
    flex: 1.4, height: 46, borderRadius: 12, overflow: 'hidden',
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingLeft: 14, paddingRight: 5,
    shadowColor: 'rgba(79,141,255,0.34)', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 1, shadowRadius: 20, elevation: 6,
  },
  // FillButton (legacy, keep for backward compat)
  fillWrap: {
    height: 46, borderRadius: 12, overflow: 'hidden',
    flexDirection: 'row', alignItems: 'center',
  },
  fillContent: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingHorizontal: 10,
  },
  fillLabel: { fontSize: 13, fontWeight: '700', color: '#fff', letterSpacing: -0.01 },
});

// ─── CompanyCard ──────────────────────────────────────────────────────────────
function CompanyCard({
  recipient, index, canRemove,
  onRemove, onUpdate,
  user, API_BASE, handleReview,
  onGenerated,
  generateCoverLetterForReview,
}) {
  const { costs } = useEventCosts();
  const clGenCost = costs['cover_letter_generate'] ?? 1;   // admin-configurable
  // ── Restore from module-level cache on mount ────────────────────────────────
  const cached = _cardStateCache[recipient.id] || {};
  const isReadyInit = !!(recipient.email && recipient.website);
  const [mode, setMode] = useState(isReadyInit ? 'view' : 'edit'); // 'edit' | 'view'
  const [genState, setGenState] = useState(cached.genState || 'idle');
  const [genProgress, setGenProgress] = useState(cached.genState === 'done' ? 100 : 0);
  const [genLabel, setGenLabel] = useState('Analyzing Resume…');
  const genAnim = useRef(new Animated.Value(cached.genState === 'done' ? 1 : 0)).current;

  const [dlState, setDlState] = useState(cached.dlState || 'idle');
  const [dlProgress, setDlProgress] = useState(cached.dlState === 'done' ? 100 : 0);
  const dlAnim = useRef(new Animated.Value(cached.dlState === 'done' ? 1 : 0)).current;

  const [sendState, setSendState] = useState(cached.sendState || 'idle');
  const [sendProgress, setSendProgress] = useState(cached.sendState === 'done' ? 100 : 0);
  const sendAnim = useRef(new Animated.Value(cached.sendState === 'done' ? 1 : 0)).current;

  const [coverLetterText, setCoverLetterText] = useState(cached.coverLetterText || '');
  const pollRef = useRef(null);

  // Persist state changes to module-level cache
  function saveCache(updates) {
    _cardStateCache[recipient.id] = { ...(_cardStateCache[recipient.id] || {}), ...updates };
  }

  const domain = domainFrom(recipient.website);
  const companyInitial = domain ? domain[0].toUpperCase()
    : (recipient.email ? recipient.email.split('@')[1]?.[0]?.toUpperCase() ?? 'C' : 'C');
  const companyName = domain || (recipient.email ? recipient.email.split('@')[1] ?? 'New Company' : 'New Company');
  const isReady = !!(recipient.email && recipient.website);

  // No auto-collapse — user taps the checkmark to save explicitly

  // Load cover letter from the same storage as the Review page on mount.
  // Matches by email first, then falls back to recipientId (Job Hub bridge) or website.
  useEffect(() => {
    if (!user?.email) return;
    if (genState === 'done') return; // already restored from module cache
    AsyncStorage.getItem(`reviewCoverLetters_${user.email}`).then(raw => {
      if (!raw) return;
      const all = JSON.parse(raw);
      const entry =
        (recipient.email && Object.values(all).find(e => e?.storedRecipientEmail === recipient.email)) ||
        Object.values(all).find(e => e?.recipientId === recipient.id) ||
        (recipient.clKey && all[recipient.clKey]) ||
        (recipient.website && Object.values(all).find(e => e?.storedRecipientWebsite === recipient.website));
      if (entry?.coverLetterHtml) {
        setCoverLetterText(entry.coverLetterHtml);
        setGenState('done');
        genAnim.setValue(1);
        setGenProgress(100);
        saveCache({ genState: 'done', coverLetterText: entry.coverLetterHtml, reviewEntry: entry });
      }
    }).catch(() => {});
  }, [recipient.id, recipient.email, recipient.website, user?.email]);

  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  function animTo(anim, val) {
    Animated.timing(anim, { toValue: val, duration: 350, useNativeDriver: false }).start();
  }

  // ── Generate ──────────────────────────────────────────────────────────────
  async function handleGenerate() {
    if (genState === 'loading') return;

    // Delegate entirely to App.js's generateCoverLetterForReview (same path as Letters page)
    if (generateCoverLetterForReview) {
      setGenState('loading');
      setGenProgress(0);
      setGenLabel('Analyzing Resume…');
      genAnim.setValue(0);

      // Fake progress ticker while App.js handles the actual API call
      let fake = 0;
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(() => {
        if (fake < 88) {
          const step = fake < 50 ? 1.2 : fake < 75 ? 0.8 : 0.3;
          fake = Math.min(fake + step, 88);
          setGenProgress(Math.round(fake));
          setGenLabel(getStageLabel(Math.round(fake)));
          Animated.timing(genAnim, { toValue: fake / 100, duration: 120, useNativeDriver: false }).start();
        }
      }, 120);

      try {
        await generateCoverLetterForReview(index);
        // Success — App.js stored results; now sync card state from AsyncStorage
        clearInterval(pollRef.current);
        setGenProgress(100);
        Animated.timing(genAnim, { toValue: 1, duration: 400, useNativeDriver: false }).start();
        // Read the cover letter that App.js saved so card shows it
        const raw = await AsyncStorage.getItem(`reviewCoverLetters_${user?.email}`).catch(() => null);
        if (raw) {
          const all = JSON.parse(raw);
          const entry =
            (recipient.email && Object.values(all).find(e => e?.storedRecipientEmail === recipient.email)) ||
            Object.values(all).find(e => e?.recipientId === recipient.id) ||
            (recipient.clKey && all[recipient.clKey]) ||
            (recipient.website && Object.values(all).find(e => e?.storedRecipientWebsite === recipient.website));
          if (entry?.coverLetterHtml) {
            setCoverLetterText(entry.coverLetterHtml);
            saveCache({ genState: 'done', coverLetterText: entry.coverLetterHtml });
          }
        }
        setGenState('done');
        saveCache({ genState: 'done' });
        onGenerated && onGenerated();
      } catch (e) {
        clearInterval(pollRef.current);
        setGenState('idle');
        setGenProgress(0);
        genAnim.setValue(0);
        saveCache({ genState: 'idle' });
        // Error alert is handled by App.js — don't double-alert
      }
      return;
    }

    // Fallback (no prop passed — should not happen in normal flow)
    Alert.alert('Error', 'Generation handler not available. Please try from the Letters page.');
  }

  // ── Simple job poller (mirrors App.js pollJobStatus) ─────────────────────
  function pollJob(jobId, token, onDone, onFail) {
    const started = Date.now();
    const iv = setInterval(async () => {
      if (Date.now() - started > 150000) { clearInterval(iv); onFail('Request timed out.'); return; }
      try {
        const sr = await fetch(`${API_BASE}/job-status/${jobId}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        const sd = await sr.json();
        if (sd.status === 'completed') { clearInterval(iv); onDone(sd); }
        else if (sd.status === 'failed') { clearInterval(iv); onFail(sd.error || 'Job failed'); }
      } catch (_) {}
    }, 3000);
    return iv;
  }

  // Helper: read the stored review entry for this card — matches by email, recipientId, or website
  async function getStoredEntry() {
    if (!user?.email) return null;
    try {
      const raw = await AsyncStorage.getItem(`reviewCoverLetters_${user.email}`);
      if (!raw) return null;
      const all = JSON.parse(raw);
      return (
        (recipient.email && Object.values(all).find(e => e?.storedRecipientEmail === recipient.email)) ||
        Object.values(all).find(e => e?.recipientId === recipient.id) ||
        (recipient.clKey && all[recipient.clKey]) ||
        (recipient.website && Object.values(all).find(e => e?.storedRecipientWebsite === recipient.website)) ||
        null
      );
    } catch { return null; }
  }

  // ── Download → open the country-format picker (preview free, download = credits)
  async function handleDownload() {
    if (dlState === 'loading') return;
    try {
      // Read the letter + address from the same Review-page storage.
      const entry = await getStoredEntry();
      const html  = entry?.coverLetterHtml || coverLetterText;
      const addr  = entry?.address || '';
      const cName = entry?.companyName || companyName;
      if (!html) { Alert.alert('No cover letter', 'Generate a cover letter first.'); return; }
      await AsyncStorage.setItem('coverLetterPickerContext', JSON.stringify({ coverLetterHtml: html, companyName: cName, companyAddress: addr }));
      require('expo-router').router?.push?.('/(cover-letter)/templates');
    } catch (e) {
      Alert.alert('Error', 'Could not open download options.');
    }
  }

  // ── Send ──────────────────────────────────────────────────────────────────
  async function handleSend() {
    if (sendState === 'loading') return;
    setSendState('loading'); setSendProgress(0); sendAnim.setValue(0);

    let fake = 0;
    const tickTimer = setInterval(() => {
      if (fake < 82) { fake = Math.min(fake + 1, 82); setSendProgress(Math.round(fake)); animTo(sendAnim, fake / 100); }
    }, 180);

    function onSendDone() {
      clearInterval(tickTimer);
      setSendProgress(100); animTo(sendAnim, 1);
      setTimeout(() => { setSendState('done'); saveCache({ sendState: 'done' }); }, 300);
      Alert.alert('Sent! 🎉', `Your application has been sent to ${companyName}.`);
    }
    function onSendFail(msg) {
      clearInterval(tickTimer); setSendState('idle');
      Alert.alert('Send failed', msg || 'Could not send. Please try again.');
    }

    try {
      const token = user?.token;
      const hdrs = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
      // Read the full stored entry — same data Review page uses — so address + HTML are accurate
      const entry = await getStoredEntry();
      const html = entry?.coverLetterHtml || coverLetterText;
      const addr = entry?.address || '';
      const cName = entry?.companyName || companyName;
      const res = await fetch(`${API_BASE}/send-single-application`, {
        method: 'POST', headers: hdrs,
        body: JSON.stringify({
          recipientEmail: recipient.email,
          websiteUrl: recipient.website,
          position: recipient.position || '',
          coverLetterText: html,
          companyName: cName,
          companyAddress: addr,
        }),
      });

      if (res.status === 202) {
        const { jobId } = await res.json();
        pollJob(jobId, token,
          (sd) => { if (!sd || sd.success === false) onSendFail(sd?.error); else onSendDone(); },
          (msg) => onSendFail(msg)
        );
      } else if (res.ok) {
        onSendDone();
      } else {
        const err = await res.json().catch(() => ({}));
        onSendFail(err.message || err.error || `Server error ${res.status}`);
      }
    } catch (e) {
      onSendFail('Network error. Please check your connection.');
    }
  }

  const eyebrow = mode === 'edit' ? 'NEW OUTREACH' : 'OUTREACH TO';

  return (
    <View style={cardStyles.card}>
      {/* Top row */}
      <View style={cardStyles.topRow}>
        <Text style={cardStyles.eyebrow}>{eyebrow}</Text>
        <LinearGradient colors={[T.blue, T.purple]} style={cardStyles.creditStamp} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
          <Ionicons name="diamond" size={8} color="#fff" />
          <Text style={cardStyles.creditStampText}>{` ${clGenCost} CREDIT${clGenCost === 1 ? '' : 'S'}`}</Text>
        </LinearGradient>
      </View>

      {/* Watermark */}
      <Text style={cardStyles.watermark}>{companyInitial}</Text>

      {/* ── VIEW MODE ── */}
      {mode === 'view' && (
        <View style={cardStyles.identityRow}>
          <View style={cardStyles.avatar}>
            <Text style={cardStyles.avatarText}>{companyInitial}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={cardStyles.companyName}>{companyName}</Text>
            <Text style={cardStyles.positionText} numberOfLines={1}>{recipient.position || 'Position not specified'}</Text>
          </View>
          {/* Pencil edit button */}
          <TouchableOpacity onPress={() => setMode('edit')} style={cardStyles.editIconBtn}>
            <Ionicons name="create-outline" size={14} color={T.blue} />
          </TouchableOpacity>
          {canRemove && (
            <TouchableOpacity onPress={() => onRemove(recipient.id)} style={cardStyles.trashBtn}>
              <Ionicons name="trash-outline" size={14} color={T.rose} />
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* ── EDIT MODE ── */}
      {mode === 'edit' && (
        <View>
          <View style={cardStyles.editHeader}>
            <View style={cardStyles.editAvatarPlaceholder}>
              <Ionicons name="add" size={18} color={T.blueDeep} />
            </View>
            <Text style={cardStyles.editTitle}>{isReady ? companyName : 'New company'}</Text>
            {/* Confirm / collapse to view — always visible, green when ready */}
            <TouchableOpacity
              onPress={() => { if (isReady) setMode('view'); }}
              style={[cardStyles.confirmIconBtn, !isReady && cardStyles.confirmIconBtnDisabled]}
              activeOpacity={isReady ? 0.7 : 1}
            >
              <Ionicons name="checkmark" size={15} color={isReady ? T.emerald : T.textFaint} />
            </TouchableOpacity>
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

      {/* Perforation */}
      <View style={cardStyles.perforation} />

      {/* Email + status row (view mode only) */}
      {mode === 'view' && (
        <>
          <View style={cardStyles.recipientRow}>
            <View style={cardStyles.mailTile}>
              <Ionicons name="mail-outline" size={11} color={T.blue} />
            </View>
            <Text style={cardStyles.emailText} numberOfLines={1}>{recipient.email}</Text>
          </View>
          <View style={cardStyles.statusRow}>
            <Ionicons name="link-outline" size={10} color={T.textFaint} />
            <Text style={cardStyles.websiteText} numberOfLines={1}>{domain}</Text>
            <View style={cardStyles.statusDot}>
              {genState === 'done' ? (
                <>
                  <PulsingDot color={T.emerald} size={5} />
                  <Text style={[cardStyles.statusText, { color: T.emerald }]}>Ready to Send</Text>
                </>
              ) : genState === 'loading' ? (
                <>
                  <PulsingDot color={T.blue} size={5} />
                  <Text style={[cardStyles.statusText, { color: T.blue }]}>Processing…</Text>
                </>
              ) : (
                <>
                  <PulsingDot color={T.blue} size={5} />
                  <Text style={[cardStyles.statusText, { color: T.blue }]}>Ready to Process</Text>
                </>
              )}
            </View>
          </View>
        </>
      )}

      {/* ── ACTION BUTTONS (view mode only) ── */}
      {mode === 'view' && (
        <View style={{ marginTop: 10 }}>
          {/* Explainer — same guidance as the Apply-job page */}
          <Text style={cardStyles.clExplainer}>
            Generate a cover letter tailored to this role — then preview &amp; edit it, download the PDF, or send your application, all from here.
          </Text>

          {genState !== 'done' ? (
            <GenerateButton
              state={genState}
              progress={genProgress}
              progressAnim={genAnim}
              onPress={handleGenerate}
              stageLabel={genLabel}
            />
          ) : (
            // All three on one line: Send Now (big) + Edit (icon) + Download PDF (icon)
            <View style={cardStyles.clActionRow}>
              <SendButton
                state={sendState}
                progress={sendProgress}
                progressAnim={sendAnim}
                onPress={handleSend}
              />
              <TouchableOpacity
                onPress={() => handleReview && handleReview(index)}
                activeOpacity={0.85}
                style={cardStyles.iconActionCyan}
              >
                <Ionicons name="create-outline" size={18} color="#0891B2" />
              </TouchableOpacity>
              <DownloadIconBtn
                state={dlState}
                progressAnim={dlAnim}
                onPress={handleDownload}
              />
            </View>
          )}
        </View>
      )}
    </View>
  );
}
const cardStyles = StyleSheet.create({
  card: {
    backgroundColor: T.surface,
    borderRadius: 22, borderWidth: 1, borderColor: T.border,
    padding: 18, marginBottom: 12, overflow: 'hidden',
    shadowColor: '#0B0F22', shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.08, shadowRadius: 32, elevation: 4,
  },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  eyebrow: { fontSize: 10, fontWeight: '700', letterSpacing: 1.4, color: T.textFaint },
  creditStamp: { flexDirection: 'row', alignItems: 'center', borderRadius: 20, paddingHorizontal: 7, paddingVertical: 2 },
  creditStampText: { fontSize: 8, fontWeight: '700', color: '#fff', letterSpacing: 0.4 },
  watermark: {
    position: 'absolute', right: -8, top: -22,
    fontSize: 180, fontWeight: '800', color: T.ink, opacity: 0.035, lineHeight: 180,
    letterSpacing: -8,
  },
  // View mode identity row
  identityRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },
  avatar: { width: 36, height: 36, borderRadius: 10, backgroundColor: T.blue + '22', alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 16, fontWeight: '700', color: T.blue },
  companyName: { fontSize: 14, fontWeight: '700', color: T.ink },
  positionText: { fontSize: 11, color: T.textMuted, marginTop: 1 },
  editIconBtn: { width: 28, height: 28, borderRadius: 8, backgroundColor: T.blue + '12', alignItems: 'center', justifyContent: 'center' },
  closeIconBtn: { width: 28, height: 28, borderRadius: 8, backgroundColor: T.inputBg, alignItems: 'center', justifyContent: 'center' },
  confirmIconBtn: { width: 28, height: 28, borderRadius: 8, backgroundColor: T.emerald + '18', borderWidth: 1, borderColor: T.emerald + '40', alignItems: 'center', justifyContent: 'center' },
  confirmIconBtnDisabled: { backgroundColor: T.textFaint + '12', borderColor: T.textFaint + '30' },
  trashBtn: { width: 28, height: 28, borderRadius: 8, backgroundColor: T.rose + '15', alignItems: 'center', justifyContent: 'center' },
  // Edit mode
  editHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  editAvatarPlaceholder: {
    width: 38, height: 38, borderRadius: 12,
    backgroundColor: 'rgba(79,141,255,0.10)',
    borderWidth: 1.5, borderColor: 'rgba(79,141,255,0.42)', borderStyle: 'dashed',
    alignItems: 'center', justifyContent: 'center',
  },
  editTitle: { flex: 1, fontSize: 14, fontWeight: '600', color: T.textMuted },
  inputGroup: { marginBottom: 8 },
  inputLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.8, color: T.textFaint, marginBottom: 5, textTransform: 'uppercase' },
  input: {
    backgroundColor: T.inputBg, borderRadius: 8, borderWidth: 1, borderColor: T.border,
    paddingHorizontal: 12, paddingVertical: 11, fontSize: 14, color: T.ink,
  },
  perforation: { height: 0, borderTopWidth: 1, borderStyle: 'dashed', borderColor: T.borderHi, marginVertical: 10 },
  recipientRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 6 },
  mailTile: { width: 22, height: 22, borderRadius: 5, backgroundColor: T.blue + '15', alignItems: 'center', justifyContent: 'center' },
  emailText: { fontSize: 13, color: T.ink, fontFamily: 'Courier', flex: 1 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  websiteText: { fontSize: 12, color: T.textFaint, flex: 1 },
  statusDot: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  statusText: { fontSize: 12, fontWeight: '600' },
  // Edit letter button (after generation done) — cyan gradient like review page
  // Cover-letter explainer + one-line action row (Send big, Edit/PDF small)
  clExplainer: { fontSize: 11.5, color: T.textMuted, lineHeight: 16, marginBottom: 10 },
  clActionRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  iconActionCyan: {
    width: 46, height: 46, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(6,182,212,0.10)', borderWidth: 1.5, borderColor: 'rgba(6,182,212,0.40)',
  },
  editLetterBtn: {
    flexDirection: 'row', alignItems: 'center',
    height: 46, paddingLeft: 5, paddingRight: 5,
    shadowColor: 'rgba(6,182,212,0.35)', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 1, shadowRadius: 16, elevation: 4,
  },
  editLetterIconCircle: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center',
    marginRight: 10, marginLeft: 0,
  },
  editLetterBtnText: { flex: 1, fontSize: 13, fontWeight: '700', color: '#fff', letterSpacing: -0.2 },
  editLetterArrow: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.20)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)',
    alignItems: 'center', justifyContent: 'center',
  },
});

// ─── AppCard ──────────────────────────────────────────────────────────────────
const STATUS_CONFIG = {
  replied:   { color: T.emerald,  deepColor: '#0E9B6F', label: 'REPLIED',   icon: 'checkmark-circle' },
  pending:   { color: T.amber,    deepColor: '#D97706', label: 'PENDING',   icon: 'time-outline' },
  interview: { color: T.purple,   deepColor: '#5B4FE8', label: 'INTERVIEW', icon: 'briefcase-outline' },
  noreply:   { color: T.textFaint,deepColor: T.textMuted, label: 'NO REPLY', icon: 'mail-unread-outline' },
};

function getAppStatus(app) {
  if (app.interviewScheduled) return 'interview';
  if (app.replyReceived)      return 'replied';
  const daysSince = (Date.now() - new Date(app.sentDate)) / 86400000;
  if (daysSince > 21)         return 'noreply';
  return 'pending';
}

function AppCard({ app, index, onMarkReply, onShowReplies, onReplyNow, user }) {
  const isMicrosoft = user?.provider === 'microsoft' || user?.oauth_provider === 'microsoft';
  const status = getAppStatus(app);
  const cfg = STATUS_CONFIG[status];
  const companyName = app.companyName || 'Company';
  const initial = companyName[0].toUpperCase();
  const sentLabel = formatShortDate(app.sentDate);

  const steps = ['Sent', 'Opened', 'Replied', 'Interview'];
  const activeStep = status === 'interview' ? 3 : status === 'replied' ? 2 : status === 'pending' ? 0 : 0;

  return (
    <View style={appStyles.card}>
      {/* Accent strip — gradient */}
      <LinearGradient
        colors={[cfg.color, cfg.deepColor || cfg.color]}
        start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
        style={appStyles.accentStrip}
      />

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

      {/* Reply quote (only shown when a real reply exists) */}
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
        {isMicrosoft ? (
          /* Microsoft: View Thread + Reply Now (or Prep for chat if interview) */
          <>
            <TouchableOpacity onPress={() => onShowReplies(app.id, companyName)} style={appStyles.outlineBtn}>
              <Ionicons name="mail-open-outline" size={12} color={T.ink} />
              <Text style={appStyles.outlineBtnText}>View thread</Text>
            </TouchableOpacity>
            {status === 'interview' ? (
              <TouchableOpacity activeOpacity={0.85} style={{ flex: 1.2 }}>
                <LinearGradient colors={[T.purple, T.purpleDeep]} style={appStyles.gradBtn} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>
                  <View style={appStyles.gradBtnInner}>
                    <Ionicons name="sparkles" size={12} color="#fff" />
                    <Text style={appStyles.gradBtnText}>Prep for chat</Text>
                  </View>
                  <View style={appStyles.gradArrow}>
                    <Ionicons name="arrow-forward" size={12} color="#fff" />
                  </View>
                </LinearGradient>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity activeOpacity={0.85} style={{ flex: 1.2 }} onPress={() => onReplyNow(app)}>
                <LinearGradient colors={[cfg.color, cfg.deepColor || cfg.color]} style={appStyles.gradBtn} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>
                  <View style={appStyles.gradBtnInner}>
                    <Ionicons name="send" size={12} color="#fff" />
                    <Text style={appStyles.gradBtnText}>Reply now</Text>
                  </View>
                  <View style={appStyles.gradArrow}>
                    <Ionicons name="arrow-forward" size={12} color="#fff" />
                  </View>
                </LinearGradient>
              </TouchableOpacity>
            )}
          </>
        ) : (
          /* Google / other: full-width "Tap to mark as replied" */
          <TouchableOpacity
            onPress={() => onMarkReply(app.id)}
            activeOpacity={0.85}
            style={appStyles.markRepliedBtn}
          >
            <Ionicons name="checkmark-circle-outline" size={14} color={T.blue} />
            <Text style={appStyles.markRepliedText}>Tap to mark as replied</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}
const appStyles = StyleSheet.create({
  card: {
    backgroundColor: T.surface, borderRadius: 20, borderWidth: 1, borderColor: T.border,
    marginBottom: 10, overflow: 'hidden',
    shadowColor: '#0B0F22', shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.07, shadowRadius: 28, elevation: 3,
  },
  accentStrip: { height: 3 },
  watermark: {
    position: 'absolute', right: -6, top: 4,
    fontSize: 150, fontWeight: '800', color: T.ink, opacity: 0.035, lineHeight: 150,
    letterSpacing: -8,
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
  footer: { flexDirection: 'row', gap: 6, padding: 8, backgroundColor: T.surface, borderTopWidth: 1, borderTopColor: T.border },
  outlineBtn: {
    flex: 1, borderWidth: 1, borderColor: T.borderHi, borderRadius: 10,
    height: 36, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
    backgroundColor: T.surface,
  },
  outlineBtnText: { fontSize: 12, fontWeight: '700', color: T.ink },
  gradBtn: { height: 36, borderRadius: 10, paddingLeft: 11, paddingRight: 3, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  gradBtnInner: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  gradBtnText: { fontSize: 12, fontWeight: '700', color: '#fff' },
  gradArrow: { width: 28, height: 28, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.18)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)', alignItems: 'center', justifyContent: 'center' },
  markRepliedBtn: {
    flex: 1, height: 36, borderRadius: 10,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: T.blue + '12', borderWidth: 1, borderColor: T.blue + '30',
  },
  markRepliedText: { fontSize: 12, fontWeight: '700', color: T.blue },
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
  user, creditBalance, unreadCount, refreshCredits,
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
  handleReview, handleAutoStart, addRecipient, removeRecipient, updateRecipient,
  checkEmailReplies, loadNotifications, markNotificationAsRead,
  showAllReplies, handleLogout, onRateApp, isValidEmail, getTimeAgo, setScreen,
  renderCompleteProfileModal,
  generateCoverLetterForReview,
  // API_BASE for inline reply confirm handler
  API_BASE, userRef,
  setApplicationHistory, setTotalReplied,
  usageData,
}) {
  const firstName = user?.fullName?.split(' ')[0] || user?.name?.split(' ')[0] || 'User';

  // Refresh "Recent applications" whenever the Home tab regains focus — e.g. after the
  // user applies to a job via the Job Hub portal (which records server-side but doesn't
  // touch this screen's state). Pulls the merged history straight from the backend.
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      if (refreshCredits) refreshCredits();          // live credit balance on every Home focus
      (async () => {
        try {
          if (!user?.token || !API_BASE || !setApplicationHistory) return;
          const res = await fetch(`${API_BASE}/users/application-history`, {
            headers: { Authorization: `Bearer ${user.token}` },
          });
          if (!res.ok) return;
          const data = await res.json();
          if (alive && data?.success && Array.isArray(data.applicationHistory)) {
            setApplicationHistory(data.applicationHistory);
          }
        } catch { /* offline — keep cached list */ }
      })();
      return () => { alive = false; };
    }, [user?.token, API_BASE, setApplicationHistory, refreshCredits])
  );

  // Pull-to-refresh: live credits + recent applications.
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const tasks = [];
      if (refreshCredits) tasks.push(refreshCredits());
      if (user?.token && API_BASE && setApplicationHistory) {
        tasks.push((async () => {
          try {
            const res = await fetch(`${API_BASE}/users/application-history`, { headers: { Authorization: `Bearer ${user.token}` } });
            if (res.ok) { const d = await res.json(); if (d?.success && Array.isArray(d.applicationHistory)) setApplicationHistory(d.applicationHistory); }
          } catch {}
        })());
      }
      await Promise.all(tasks);
    } finally { setRefreshing(false); }
  }, [refreshCredits, user?.token, API_BASE, setApplicationHistory]);
  const isMicrosoft = user?.provider === 'microsoft' || user?.oauth_provider === 'microsoft';

  // Ref for scrolling to the companies section
  const mainScrollRef = useRef(null);
  const companiesSectionRef = useRef(null);

  // AI Hub bridge — poll every 800 ms while mounted.
  // HomeScreen never unmounts (App.js keeps it alive), so a mount-only useEffect
  // fires once at startup and misses later navigations back from the Job Hub tab.
  useEffect(() => {
    let handling = false;
    const interval = setInterval(async () => {
      if (handling) return;
      try {
        // Bridge 1: plain "scroll to companies" trigger
        const flag = await AsyncStorage.getItem('aiHub_trigger_add_recipient');
        if (flag === 'true') {
          handling = true;
          await AsyncStorage.removeItem('aiHub_trigger_add_recipient');
          setTimeout(() => {
            companiesSectionRef.current?.measureLayout(
              mainScrollRef.current,
              (_x, y) => mainScrollRef.current?.scrollTo({ y, animated: true }),
              () => mainScrollRef.current?.scrollToEnd({ animated: true }),
            );
            handling = false;
          }, 300);
          return; // don't fall through
        }

        // Bridge 2 (aiHub_add_recipient_with_cl) is now handled entirely by
        // App.js's polling (AppContent useEffect) which has direct access to
        // setRecipients, setScreen, and userRef. HomeScreen no longer needs this.
      } catch {
        handling = false;
      }
    }, 800);
    return () => clearInterval(interval);
  }, []);

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

  // Chart tooltip state — lifted here so any tap on screen dismisses it
  const [chartTooltip, setChartTooltip] = useState(null);
  const [replyModalVisible, setReplyModalVisible] = useState(false);
  const [replyModalApp, setReplyModalApp]         = useState(null);

  // Track locally-generated cover letters in module-level cache (survives navigation)
  const [chartTick, setChartTick] = useState(0);
  function handleCardGenerated() {
    const key = new Date().toLocaleDateString('en-CA');
    // Start from max(existing cached value, today's sent count) so we never go below sent
    const todaySent = applicationHistory.filter(a =>
      a.sentDate && new Date(a.sentDate).toLocaleDateString('en-CA') === key
    ).length;
    const prev = Math.max(_generatedCountsCache[key] || 0, todaySent);
    _generatedCountsCache[key] = prev + 1;
    setChartTick(t => t + 1);
  }

  function handleMarkReply(appId) {
    setReplyAppId(appId);
    const now = new Date();
    setSelectedReplyDate(now);
    if (selectedReplyDateRef) selectedReplyDateRef.current = now;
    setShowReplyDatePicker(true);
  }

  function handleReplyNow(app) {
    setReplyModalApp(app);
    setReplyModalVisible(true);
  }

  async function _unused_handleReplyNow_deeplink(app) {
    const toEmail = app.recipientEmail || '';
    const fromEmail = user?.email || '';
    const isMicrosoft = user?.provider === 'microsoft' || user?.oauth_provider === 'microsoft';
    const isGoogle = user?.provider === 'google' || user?.oauth_provider === 'google';

    // Determine subject — use the reply's subject if available (already "Re: ..."), else build one
    const rawSubject = app.replySubject
      ? (app.replySubject.startsWith('Re:') ? app.replySubject : `Re: ${app.replySubject}`)
      : `Re: Application for ${app.position || 'the position'} at ${app.companyName || 'your company'}`;

    // Fetch the full reply thread to build the quoted body chain
    let quotedChain = '';
    try {
      const res = await fetch(`${API_BASE}/users/application-history/${app.id}/replies`, {
        headers: { Authorization: `Bearer ${user?.token}` }
      });
      if (res.ok) {
        const result = await res.json();
        if (result.success && result.replies?.length > 0) {
          // Build quoted chain oldest→newest so the thread reads naturally
          const sorted = [...result.replies].reverse();
          quotedChain = sorted.map(r => {
            const dateStr = r.replyDate ? new Date(r.replyDate).toLocaleString() : '';
            return `\n\n--- On ${dateStr}, ${r.replyFromEmail || toEmail} wrote ---\n${r.replySnippet || ''}`;
          }).join('\n');
        }
      }
    } catch (_) { /* non-fatal — open compose without chain */ }

    const body = `\n\n${quotedChain}`;

    const subjectEncoded = encodeURIComponent(rawSubject);
    const bodyEncoded = encodeURIComponent(body);
    const toEncoded = encodeURIComponent(toEmail);
    const fromEncoded = encodeURIComponent(fromEmail);

    // Deep link URLs
    // Outlook: ms-outlook://compose (iOS + Android)
    const outlookLink = `ms-outlook://compose?to=${toEncoded}&subject=${subjectEncoded}&body=${bodyEncoded}`;
    // Gmail iOS deep link
    const gmailLinkiOS = `googlegmail://co?to=${toEncoded}&subject=${subjectEncoded}&body=${bodyEncoded}`;
    // Gmail Android intent
    const gmailLinkAndroid = `intent://co?to=${toEncoded}&subject=${subjectEncoded}&body=${bodyEncoded}#Intent;scheme=googlegmail;package=com.google.android.gm;end`;
    const gmailLink = Platform.OS === 'android' ? gmailLinkAndroid : gmailLinkiOS;
    const mailtoLink  = `mailto:${toEncoded}?subject=${subjectEncoded}&body=${bodyEncoded}`;

    try {
      if (isMicrosoft) {
        // Priority: Outlook → Gmail → Apple Mail (mailto)
        if (await Linking.canOpenURL(outlookLink)) {
          return await Linking.openURL(outlookLink);
        }
        if (await Linking.canOpenURL(gmailLink)) {
          return await Linking.openURL(gmailLink);
        }
        return await Linking.openURL(mailtoLink);
      } else if (isGoogle) {
        // Priority: Gmail → Outlook → Apple Mail (mailto)
        if (await Linking.canOpenURL(gmailLink)) {
          return await Linking.openURL(gmailLink);
        }
        if (await Linking.canOpenURL(outlookLink)) {
          return await Linking.openURL(outlookLink);
        }
        return await Linking.openURL(mailtoLink);
      } else {
        // Apple / other — Apple Mail first, then Outlook, then Gmail
        const canOutlook = await Linking.canOpenURL(outlookLink);
        const canGmail   = await Linking.canOpenURL(gmailLink);
        try {
          return await Linking.openURL(mailtoLink);
        } catch (_) {
          if (canOutlook) return await Linking.openURL(outlookLink);
          if (canGmail)   return await Linking.openURL(gmailLink);
        }
      }
    } catch (err) {
      Alert.alert(
        'Reply to Employer',
        `Could not open email app automatically.\n\nPlease email:\n${toEmail}\n\nSubject: ${rawSubject}`,
        [{ text: 'OK' }]
      );
    }
  }

  return (
    <SafeAreaViewContext style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor={T.bg} translucent={false} />

      {renderCompleteProfileModal && renderCompleteProfileModal()}

      <ReplyComposeModal
        visible={replyModalVisible}
        onClose={() => setReplyModalVisible(false)}
        app={replyModalApp}
        user={user}
        API_BASE={API_BASE}
        onReplySent={() => setReplyModalVisible(false)}
      />

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
        ref={mainScrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#4F8DFF" colors={['#4F8DFF']} />
        }
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
            </View>
          </View>

          {/* Top up button — below credits */}
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
              <Text style={styles.heroStatLabel}>REPLY%</Text>
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
            <TouchableOpacity onPress={() => setScreen('usage')}><Text style={styles.detailsLink}>Details →</Text></TouchableOpacity>
          </View>
          <ActivityChart applicationHistory={applicationHistory} chartTick={chartTick} usageData={usageData} tooltip={chartTooltip} setTooltip={setChartTooltip} />
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
        <View ref={companiesSectionRef} style={styles.section}>
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
                <Ionicons name="add" size={12} color="#fff" />
                <Text style={styles.addPillText}>Add new</Text>
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
              user={user}
              API_BASE={API_BASE}
              handleReview={handleReview}
              onGenerated={handleCardGenerated}
              generateCoverLetterForReview={generateCoverLetterForReview}
            />
          ))}

          {/* Auto-process card */}
          <View style={styles.autoCard}>
            <View style={styles.autoCardTop}>
              <View style={styles.autoCardIconWrap}>
                <Ionicons name="flash" size={15} color={T.emerald} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.autoCardTitle}>Generate & Send All</Text>
                <Text style={styles.autoCardDesc}>AI writes, brands & sends all in one go — no manual steps</Text>
              </View>
              <View style={styles.autoCardCreditsBadge}>
                <Text style={styles.autoCardCreditsText}>{recipients.filter(r => r.email && r.website).length} cr</Text>
              </View>
            </View>
            <TouchableOpacity
              onPress={handleAutoStart}
              disabled={!hasPendingReady}
              activeOpacity={0.85}
              style={[styles.autoCardBtn, !hasPendingReady && { opacity: 0.4 }]}
            >
              <LinearGradient
                colors={[T.blue, T.purple]}
                start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                style={styles.autoCardBtnGrad}
              >
                <Ionicons name="flash-outline" size={13} color="#fff" />
                <Text style={styles.autoCardBtnText}>Start Auto Process</Text>
              </LinearGradient>
            </TouchableOpacity>
          </View>
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
                onReplyNow={handleReplyNow}
                user={user}
              />
            ))
          )}
        </View>

        <View style={{ height: 100 }} />
      </ScrollView>

      {/* Dismiss chart tooltip when tapping anywhere outside the chart */}
      {chartTooltip !== null && (
        <TouchableWithoutFeedback onPress={() => setChartTooltip(null)}>
          <View style={styles.tooltipDismissOverlay} />
        </TouchableWithoutFeedback>
      )}

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
              { icon: 'document-text-outline', title: 'Resume Builder',   sub: 'Build your AI-powered resume', onPress: () => { setShowSettings(false); require('expo-router').router?.push?.('/(resume-builder)'); } },
            ].concat(isAdmin ? [
              { icon: 'star-outline', title: 'Admin Panel', sub: 'Manage credit packages', onPress: () => { setShowSettings(false); setScreen('admin'); } },
              { icon: 'pricetags-outline', title: 'AI Event Credits', sub: 'Set credits per AI action', onPress: () => { setShowSettings(false); require('expo-router').router?.push?.('/(admin)/ai-event-credits'); } },
              { icon: 'construct-outline', title: 'Employer Fix Agent', sub: 'Auto-fix employers we missed', onPress: () => { setShowSettings(false); require('expo-router').router?.push?.('/(admin)/employer-requests'); } },
              { icon: 'bar-chart-outline', title: 'Store Analytics', sub: 'iOS + Android downloads & revenue', onPress: () => { setShowSettings(false); require('expo-router').router?.push?.('/(admin)/store-analytics'); } },
            ] : []).concat([
              null,
              { icon: 'document-text-outline', title: 'Terms & Conditions', sub: 'View terms of service',   onPress: () => { setShowSettings(false); setScreen('terms'); } },
              { icon: 'shield-outline',          title: 'Privacy Policy',   sub: 'How we protect your data', onPress: () => { setShowSettings(false); setScreen('privacy'); } },
              { icon: 'card-outline',            title: 'Refund Policy',    sub: 'Credit refund information', onPress: () => { setShowSettings(false); setScreen('refund'); } },
              null,
              { icon: 'star',                    title: 'Rate this App',     sub: 'Tell us how we’re doing',   onPress: () => { setShowSettings(false); setTimeout(() => { onRateApp && onRateApp(); }, 320); } },
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
              <View style={notifStyles.wrapper}>
                <View style={notifStyles.sheet}>
                  <View style={notifStyles.handle} />
                  <View style={notifStyles.header}>
                    <Text style={notifStyles.title}>Notifications</Text>
                    {unreadCount > 0 && <View style={notifStyles.badge}><Text style={notifStyles.badgeText}>{unreadCount}</Text></View>}
                  </View>
                  <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: 340 }}>
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
              </View>
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
      {/* Android: native dialog applies + closes on tap (mirrors the Confirm PATCH) */}
      {Platform.OS === 'android' && showReplyDatePicker && (
        <DateTimePicker
          value={selectedReplyDate}
          mode="date"
          display="default"
          maximumDate={new Date()}
          onChange={async (event, date) => {
            setShowReplyDatePicker(false);
            if (event.type !== 'set' || !date) return;
            setSelectedReplyDate(date);
            if (selectedReplyDateRef) selectedReplyDateRef.current = date;
            try {
              const iso = date.toLocaleDateString('en-CA');
              const response = await fetch(`${API_BASE}/users/application-history/${replyAppId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${userRef?.current?.token}` },
                body: JSON.stringify({ replyReceived: true, replyDate: iso }),
              });
              if (response.ok) {
                setApplicationHistory(prev => prev.map(item => item.id === replyAppId ? { ...item, replyReceived: true, replyDate: iso } : item));
                setTotalReplied(p => p + 1);
              }
            } catch (e) { console.error(e); }
          }}
        />
      )}
      {Platform.OS === 'ios' && (
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
      )}
    </SafeAreaViewContext>
  );

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
  tooltipDismissOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 10 },
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
  wordmark: { fontSize: 23, letterSpacing: 0.5 },
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
    alignSelf: 'flex-start', marginTop: 18,
  },
  replyMiniLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 1.4, color: 'rgba(255,255,255,0.5)', marginBottom: 5 },
  replyMiniValue: { fontSize: 22, fontWeight: '800', color: '#fff', lineHeight: 26 },
  replyMiniRate: { fontSize: 12, fontWeight: '600', color: T.teal, marginTop: 3 },
  topUpPill: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: '#fff', borderRadius: 20,
    paddingHorizontal: 13, paddingVertical: 6,
    alignSelf: 'flex-start', marginBottom: 8,
  },
  topUpText: { fontSize: 12, fontWeight: '700', color: T.ink },
  heroStatStrip: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)',
    paddingVertical: 12, marginTop: 9,
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
  legendSwatch: { width: 8, height: 8, borderRadius: 2 },
  legendText: { fontSize: 12, color: T.textMuted, fontWeight: '500' },

  // Count pill
  countPill: { backgroundColor: T.ink, borderRadius: 10, paddingHorizontal: 9, paddingVertical: 3 },
  countPillText: { fontSize: 11, fontWeight: '700', color: '#fff' },
  addPill: { borderRadius: 100, paddingHorizontal: 11, paddingLeft: 9, height: 32, flexDirection: 'row', alignItems: 'center', gap: 5, shadowColor: 'rgba(79,141,255,0.32)', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 1, shadowRadius: 14, elevation: 4 },
  addPillText: { fontSize: 11, fontWeight: '700', color: '#fff' },

  // Generate all card
  autoCard: { marginTop: 6, backgroundColor: T.surface, borderRadius: 20, borderWidth: 1, borderColor: T.border, padding: 16 },
  autoCardTop: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 14 },
  autoCardIconWrap: { width: 34, height: 34, borderRadius: 10, backgroundColor: 'rgba(79,141,255,0.10)', borderWidth: 1, borderColor: 'rgba(79,141,255,0.20)', alignItems: 'center', justifyContent: 'center' },
  autoCardTitle: { fontSize: 13, fontWeight: '700', color: T.ink },
  autoCardDesc: { fontSize: 11, color: T.textMuted, marginTop: 2, lineHeight: 15 },
  autoCardCreditsBadge: { backgroundColor: 'rgba(79,141,255,0.10)', borderRadius: 100, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: 'rgba(79,141,255,0.20)' },
  autoCardCreditsText: { fontSize: 10, fontWeight: '700', color: T.blue },
  autoCardBtn: { borderRadius: 12, overflow: 'hidden' },
  autoCardBtnGrad: { height: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  autoCardBtnText: { fontSize: 13, fontWeight: '700', color: '#fff' },

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
  wrapper: {
    backgroundColor: T.surface,
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    maxHeight: '80%', minHeight: 200,
    paddingBottom: 24,
  },
  sheet: { padding: 16, flexShrink: 1 },
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
