// AI Hub — new feature. Safe to delete without affecting existing app.
//
// Forced-upgrade gate. Asks the server whether THIS build may keep running and, when it may not,
// covers the app with a sheet that cannot be dismissed.
//
// ⚠️ FAILURE MUST NEVER BLOCK. Offline, a 500, a timeout, a malformed answer — every one of them
// leaves the app usable. The gate exists to stop a genuinely broken build from being used; a check
// that bricks the app when the network hiccups would cause far more damage than it prevents.
//
// ⚠️ AND IT ONLY GOVERNS BUILDS THAT SHIPPED WITH IT. Every user on an older build never asks the
// question, so raising the floor cannot reach them. This protects future releases, not past ones.
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, Linking, Platform, AppState } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { API_BASE } from '../config';
import { APP_BUILD } from '../services/analytics';

type Action = 'ok' | 'nudge' | 'block';
type Gate = { action: Action; title?: string; message?: string; storeUrl?: string };

const TIMEOUT_MS = 6000;

export default function UpdateGate() {
  const [gate, setGate] = useState<Gate>({ action: 'ok' });
  const [dismissed, setDismissed] = useState(false);

  const check = useCallback(async () => {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      const url = `${API_BASE}/app-version-gate?platform=${Platform.OS}&build=${encodeURIComponent(APP_BUILD || '')}`;
      const r = await fetch(url, { signal: ctl.signal });
      clearTimeout(timer);
      if (!r.ok) return;
      const j = await r.json();
      const action: Action = j && (j.action === 'block' || j.action === 'nudge') ? j.action : 'ok';
      setGate({ action, title: j?.title, message: j?.message, storeUrl: j?.storeUrl });
    } catch { /* offline / slow / broken → stay out of the way */ }
  }, []);

  useEffect(() => { check(); }, [check]);

  // Re-check when the app comes back to the foreground: that is the moment AFTER someone has been
  // to the App Store, so the block clears itself without them having to kill the app.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') check(); });
    return () => sub.remove();
  }, [check]);

  const open = () => { if (gate.storeUrl) Linking.openURL(gate.storeUrl).catch(() => {}); };

  const blocking = gate.action === 'block';
  const showing = blocking || (gate.action === 'nudge' && !dismissed);
  if (!showing) return null;

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      // Android hardware back must not be an escape hatch out of a hard block.
      onRequestClose={() => { if (!blocking) setDismissed(true); }}
    >
      <View style={s.backdrop}>
        <View style={s.card}>
          <View style={s.iconWrap}><Ionicons name="rocket" size={26} color="#06B6D4" /></View>
          <Text style={s.title}>{gate.title || 'Update CVApplyr'}</Text>
          <Text style={s.body}>
            {gate.message || 'This version is out of date. Update to the latest version to carry on.'}
          </Text>
          <TouchableOpacity style={s.cta} activeOpacity={0.9} onPress={open}>
            <Text style={s.ctaTx}>{Platform.OS === 'android' ? 'Update on Google Play' : 'Update on the App Store'}</Text>
          </TouchableOpacity>
          {!blocking && (
            <TouchableOpacity style={s.later} activeOpacity={0.8} onPress={() => setDismissed(true)}>
              <Text style={s.laterTx}>Not now</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(5,8,15,0.88)', alignItems: 'center', justifyContent: 'center', padding: 26 },
  card: { width: '100%', maxWidth: 380, backgroundColor: '#0B1120', borderRadius: 22, borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)', padding: 24, alignItems: 'center' },
  iconWrap: { width: 54, height: 54, borderRadius: 27, backgroundColor: 'rgba(6,182,212,0.14)', alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  title: { color: '#F1F5F9', fontSize: 19, fontWeight: '800', textAlign: 'center' },
  body: { color: '#94A3B8', fontSize: 14, lineHeight: 21, textAlign: 'center', marginTop: 9 },
  cta: { backgroundColor: '#06B6D4', borderRadius: 14, height: 50, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center', marginTop: 20 },
  ctaTx: { color: '#04222B', fontSize: 15, fontWeight: '800' },
  later: { marginTop: 12, paddingVertical: 8, paddingHorizontal: 16 },
  laterTx: { color: '#64748B', fontSize: 13.5, fontWeight: '700' },
});
