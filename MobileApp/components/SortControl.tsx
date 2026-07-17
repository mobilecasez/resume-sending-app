// AI Hub — new feature. Safe to delete without affecting existing app.
// Compact "Sort · <label> ▾" pill that opens a small iOS-style option sheet. Reused on the Search,
// My Jobs and Saved tabs so sorting is consistent everywhere.
import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export type SortOption = { key: string; label: string };

export default function SortControl({ options, value, onChange }: {
  options: SortOption[];
  value: string;
  onChange: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const cur = options.find((o) => o.key === value) || options[0];
  return (
    <>
      <TouchableOpacity onPress={() => setOpen(true)} style={styles.pill} activeOpacity={0.8} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
        <Ionicons name="swap-vertical" size={13} color="#4F8DFF" />
        <Text style={styles.pillTx} numberOfLines={1}>{cur?.label || 'Sort'}</Text>
        <Ionicons name="chevron-down" size={12} color="#8896B0" />
      </TouchableOpacity>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <Text style={styles.title}>Sort by</Text>
            {options.map((o) => {
              const on = o.key === value;
              return (
                <TouchableOpacity key={o.key} style={styles.row} onPress={() => { onChange(o.key); setOpen(false); }} activeOpacity={0.7}>
                  <Text style={[styles.rowTx, on && styles.rowTxOn]}>{o.label}</Text>
                  {on && <Ionicons name="checkmark" size={18} color="#4F8DFF" />}
                </TouchableOpacity>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#EEF3FF', borderRadius: 9, paddingHorizontal: 9, paddingVertical: 5, borderWidth: 1, borderColor: 'rgba(79,141,255,0.22)' },
  pillTx: { fontSize: 12, fontWeight: '800', color: '#2563EB', maxWidth: 120 },
  backdrop: { flex: 1, backgroundColor: 'rgba(11,15,34,0.4)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#fff', borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingHorizontal: 18, paddingTop: 14, paddingBottom: 30 },
  title: { fontSize: 13, fontWeight: '800', color: '#8896B0', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#F1F5F9' },
  rowTx: { fontSize: 15.5, fontWeight: '600', color: '#334155' },
  rowTxOn: { color: '#2563EB', fontWeight: '800' },
});
