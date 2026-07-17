// AI Hub — new feature. Safe to delete without affecting existing app.
// A draggable, blinking-robot "Job tools" floater that opens a translucent dock of actions. Used in
// the apply WebView (Auto Fill / My details / Upload) so every job — Saved, My Jobs, live — has one
// simple, consistent control. Rendered as a plain overlay VIEW (never a Modal — it lives INSIDE the
// apply Modal, and Modal-in-Modal crashes iOS).
import React, { useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated, PanResponder, Pressable, Dimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import RobotIcon from './RobotIcon';

const { height: SH } = Dimensions.get('window');

export type DockAction = { key: string; icon: any; label: string; sub?: string; colors: [string, string]; onPress: () => void };

export default function JobToolsDock({ actions, bottomInset = 0, busy, busyLabel }: {
  actions: DockAction[];
  bottomInset?: number;
  busy?: boolean;         // an action is running → bubble shows a spinner-ish state, dock disabled-ish
  busyLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const pan = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const moved = useRef(false);
  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 4 || Math.abs(g.dy) > 4,
      onPanResponderGrant: () => { moved.current = false; pan.setOffset({ x: (pan.x as any).__getValue(), y: (pan.y as any).__getValue() }); pan.setValue({ x: 0, y: 0 }); },
      onPanResponderMove: (e, g) => { if (Math.abs(g.dx) > 4 || Math.abs(g.dy) > 4) moved.current = true; pan.setValue({ x: g.dx, y: g.dy }); },
      onPanResponderRelease: () => { pan.flattenOffset(); if (!moved.current) setOpen((o) => !o); },
    })
  ).current;

  return (
    <>
      {open && (
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={[styles.dock, { paddingBottom: Math.max(bottomInset, 12) }]} onPress={() => {}}>
            <View style={styles.grip} />
            <View style={styles.head}>
              <RobotIcon size={18} color="#22D3EE" />
              <Text style={styles.headTx}>Job tools</Text>
              <View style={{ flex: 1 }} />
              <TouchableOpacity onPress={() => setOpen(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={19} color="rgba(255,255,255,0.6)" />
              </TouchableOpacity>
            </View>
            <View style={styles.row}>
              {actions.map((a) => (
                <TouchableOpacity key={a.key} style={styles.item} activeOpacity={0.85} onPress={() => { setOpen(false); a.onPress(); }}>
                  <LinearGradient colors={a.colors} style={styles.itemIcon}><Ionicons name={a.icon} size={21} color="#fff" /></LinearGradient>
                  <Text style={styles.itemTitle} numberOfLines={1}>{a.label}</Text>
                  {!!a.sub && <Text style={styles.itemSub} numberOfLines={2}>{a.sub}</Text>}
                </TouchableOpacity>
              ))}
            </View>
          </Pressable>
        </Pressable>
      )}

      <Animated.View style={[styles.fabWrap, { bottom: Math.max(bottomInset, 12) + 70 }, { transform: pan.getTranslateTransform() }]} {...responder.panHandlers}>
        <View style={styles.fabInner}>
          <LinearGradient colors={['#7C6BFF', '#4F8DFF']} style={styles.fab}>
            <RobotIcon size={26} color="#fff" />
          </LinearGradient>
          <View style={styles.fabLabel}><Text style={styles.fabLabelTx}>{busy ? (busyLabel || 'Working…') : 'Job tools'}</Text></View>
        </View>
      </Animated.View>
    </>
  );
}

const styles = StyleSheet.create({
  fabWrap: { position: 'absolute', right: 14, zIndex: 40 },
  fabInner: { alignItems: 'center' },
  fab: { width: 58, height: 58, borderRadius: 29, alignItems: 'center', justifyContent: 'center', shadowColor: '#0B0F22', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.3, shadowRadius: 14, elevation: 10 },
  fabLabel: { marginTop: 5, backgroundColor: '#0B0F22', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3.5 },
  fabLabelTx: { fontSize: 10.5, fontWeight: '800', color: '#fff' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(6,10,25,0.4)', justifyContent: 'flex-end', zIndex: 60 },
  dock: { marginHorizontal: 10, marginBottom: 10, borderRadius: 26, backgroundColor: 'rgba(11,15,34,0.95)', paddingHorizontal: 16, paddingTop: 8, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', shadowColor: '#000', shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.4, shadowRadius: 28, elevation: 20 },
  grip: { alignSelf: 'center', width: 40, height: 4.5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.22)', marginBottom: 10 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  headTx: { fontSize: 14.5, fontWeight: '800', color: '#fff' },
  row: { flexDirection: 'row', gap: 10 },
  item: { flex: 1, backgroundColor: 'rgba(255,255,255,0.07)', borderRadius: 18, alignItems: 'center', paddingVertical: 14, paddingHorizontal: 6, borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)' },
  itemIcon: { width: 44, height: 44, borderRadius: 15, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  itemTitle: { fontSize: 12.5, fontWeight: '800', color: '#fff', textAlign: 'center' },
  itemSub: { fontSize: 10, color: 'rgba(255,255,255,0.55)', marginTop: 2, textAlign: 'center' },
});
