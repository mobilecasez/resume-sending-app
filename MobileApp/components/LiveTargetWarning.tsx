// AI Hub — new feature. Safe to delete without affecting existing app.
//
// A standing warning for admin screens that can message REAL people.
//
// MobileApp/config.js currently pins API_BASE to the PRODUCTION url unconditionally (it used to be
// `__DEV__ ? LOCAL : PRODUCTION`, and the note in that file says it is deliberate so a dev build can
// load real data without a local backend). That was harmless while the admin screens were read-only.
// It is not harmless now: a Send button in a development build reaches the live backend and a real
// stranger's phone, with no visible difference from a local sandbox.
//
// This does not undo that choice — it makes it impossible to forget. On a dev build pointed at
// production the strip is loud; on a real release build it stays out of the way.
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { API_BASE, LOCAL_API_URL } from '../config';

/** True when this is a development build that is nevertheless talking to the live backend. */
export function isDevAgainstProduction(): boolean {
  // eslint-disable-next-line no-undef
  const dev = typeof __DEV__ !== 'undefined' && !!__DEV__;
  const local = String(LOCAL_API_URL || '');
  const base = String(API_BASE || '');
  return dev && !!base && base !== local && !/localhost|127\.0\.0\.1|192\.168\.|10\.0\./.test(base);
}

export default function LiveTargetWarning({ what = 'Sending here reaches real users' }: { what?: string }) {
  if (!isDevAgainstProduction()) return null;
  return (
    <View style={s.wrap}>
      <Ionicons name="warning" size={16} color="#7A2E0E" style={{ marginTop: 1 }} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={s.t}>Development build · live production data</Text>
        <Text style={s.b}>{what}. There is no sandbox behind these buttons.</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    flexDirection: 'row', gap: 9, alignItems: 'flex-start',
    backgroundColor: '#FEF3C7', borderColor: '#F59E0B', borderWidth: 1,
    borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 12,
  },
  t: { fontSize: 12.5, fontWeight: '800', color: '#7A2E0E' },
  b: { fontSize: 11.5, color: '#8A4B12', marginTop: 2, lineHeight: 16 },
});
