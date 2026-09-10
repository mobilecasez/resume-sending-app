// AI Hub — new feature. Safe to delete without affecting existing app.
//
// One picker, two jobs: the phone's dial code and the country you live in.
//
// They are the same list and the same search, so they are the same component — but they are NOT
// the same answer. A dial code cannot be turned back into a country (+1 is twenty-two countries)
// and a country cannot be assumed from one either, so each field asks for its own and neither
// silently rewrites the other.
//
// ⚠️ NO ANIMATED VALUE ANYWHERE IN HERE. The wizard behind it drives a native-driver slide, and the
// b126-128 crash was two drivers in one tree. A Modal is its own tree, but the cheapest way to be
// certain is to own no animation at all: the sheet uses Modal's own `animationType`, which is
// platform code, not an Animated.Value.
import React, { useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Modal, TextInput, TouchableOpacity, Pressable, FlatList,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { E } from '../employer-home/theme';
import { COUNTRIES, Country, searchCountries } from '../../constants/countries';

const ROW_H = 54;

export default function CountrySheet({
  open, mode, selectedIso, onPick, onClose,
}: {
  open: boolean;
  /** 'dial' shows the code as the answer; 'country' shows the name. */
  mode: 'dial' | 'country';
  selectedIso?: string | null;
  onPick: (c: Country) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [q, setQ] = useState('');
  const list = useMemo(() => (q ? searchCountries(q) : COUNTRIES), [q]);
  const listRef = useRef<FlatList<Country>>(null);

  // Opening on the current answer rather than at Afghanistan. getItemLayout makes this exact
  // without measuring, which is the only reason every row is a fixed height.
  const initialIndex = useMemo(() => {
    if (q || !selectedIso) return 0;
    const i = COUNTRIES.findIndex((c) => c.iso === selectedIso);
    return i > 2 ? i - 2 : 0;
  }, [q, selectedIso]);

  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={s.backdrop}>
        <Pressable style={s.dismiss} onPress={onClose} />
        <View style={[s.sheet, { paddingBottom: insets.bottom + 8 }]}>
          <View style={s.grab} />
          <View style={s.headRow}>
            <Text style={s.title}>{mode === 'dial' ? 'Country code' : 'Country'}</Text>
            <TouchableOpacity onPress={onClose} style={s.close} activeOpacity={0.8}>
              <Ionicons name="close" size={17} color="rgba(255,255,255,0.7)" />
            </TouchableOpacity>
          </View>

          <View style={s.searchWrap}>
            <Ionicons name="search" size={16} color="rgba(255,255,255,0.4)" />
            <TextInput
              style={s.search}
              value={q}
              onChangeText={setQ}
              placeholder={mode === 'dial' ? 'Country or code' : 'Search countries'}
              placeholderTextColor="rgba(255,255,255,0.32)"
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="search"
            />
            {!!q && (
              <TouchableOpacity onPress={() => setQ('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="close-circle" size={16} color="rgba(255,255,255,0.35)" />
              </TouchableOpacity>
            )}
          </View>

          <FlatList
            ref={listRef}
            data={list}
            keyExtractor={(c) => c.iso}
            keyboardShouldPersistTaps="handled"
            initialScrollIndex={initialIndex}
            getItemLayout={(_, i) => ({ length: ROW_H, offset: ROW_H * i, index: i })}
            // A scroll to an index that was filtered out of a short list would throw.
            onScrollToIndexFailed={() => {}}
            style={s.list}
            ListEmptyComponent={<Text style={s.empty}>No country matches “{q}”.</Text>}
            renderItem={({ item }) => {
              const on = item.iso === selectedIso;
              return (
                <TouchableOpacity
                  style={[s.row, on && s.rowOn]}
                  activeOpacity={0.8}
                  onPress={() => { onPick(item); onClose(); }}
                >
                  <Text style={s.flag}>{item.flag}</Text>
                  <Text style={[s.name, on && s.nameOn]} numberOfLines={1}>{item.name}</Text>
                  <Text style={[s.dial, on && s.dialOn]}>{item.dial}</Text>
                  {on && <Ionicons name="checkmark" size={16} color={E.mint} />}
                </TouchableOpacity>
              );
            }}
          />
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(4,6,14,0.62)', justifyContent: 'flex-end' },
  dismiss: { flex: 1 },
  sheet: {
    maxHeight: '82%', borderTopLeftRadius: 26, borderTopRightRadius: 26, paddingHorizontal: 16,
    backgroundColor: '#0E1428', borderTopWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
  },
  grab: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.18)', marginTop: 9 },
  headRow: { flexDirection: 'row', alignItems: 'center', marginTop: 12, marginBottom: 12 },
  title: { flex: 1, fontSize: 19, fontWeight: '800', color: '#fff', letterSpacing: -0.5 },
  close: {
    width: 32, height: 32, borderRadius: 11, alignItems: 'center', justifyContent: 'center',
    backgroundColor: E.glass, borderWidth: 1, borderColor: E.glassBorder,
  },

  searchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 9, height: 46, paddingHorizontal: 13,
    borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.07)', borderWidth: 1, borderColor: E.glassBorder,
  },
  search: { flex: 1, fontSize: 15, fontWeight: '600', color: '#fff', padding: 0 },

  list: { marginTop: 10 },
  row: { height: ROW_H, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, borderRadius: 13 },
  rowOn: { backgroundColor: 'rgba(79,141,255,0.16)' },
  flag: { fontSize: 21 },
  name: { flex: 1, fontSize: 14.5, fontWeight: '600', color: 'rgba(255,255,255,0.82)' },
  nameOn: { color: '#fff', fontWeight: '800' },
  dial: { fontSize: 13.5, fontWeight: '700', color: 'rgba(255,255,255,0.42)' },
  dialOn: { color: E.mint },
  empty: { paddingVertical: 26, textAlign: 'center', fontSize: 13.5, fontWeight: '600', color: 'rgba(255,255,255,0.42)' },
});
