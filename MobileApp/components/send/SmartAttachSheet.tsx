// AI Hub — new feature. Safe to delete without affecting existing app.
//
// THE SMART FILE UPLOAD CONTROL, AS A SHEET ANYONE CAN OPEN (2026-09-19). The owner calls it "our smart file upload
// control box": the Job Hub's "Attach a file" sheet (app/(ai-hub)/job-detail.tsx — grabber, title, one tinted block
// per document of ours, "Choose from device", Cancel). That one is wired into the apply WebView's file inputs; this is
// the same look and the same three kinds of choice, in the customization pages' light palette (RichText T), for the
// letter's Send page: pick one of OUR versions of a document, or a PDF / Word file from the phone.
//
// ⚠️ ONE MODAL AT A TIME. "Choose from device" opens the system document picker — a native modal of its own, and iOS
// cannot present one while this sheet is still sliding away (the picker simply never appears; the tap reads as dead).
// So the sheet asks its parent to close FIRST and runs the picker from onDismiss, with a short net in case that event
// never comes (templates.tsx's download sheet, the same rule). Android stacks dialogs, so it runs at once there.
// ⚠️ NO Animated here — the Modal's own slide is the only motion (the one-driver-per-tree rule, builds 126-128).
// ⚠️ PDF AND WORD, ≤ 5 MB, said before the picker opens; the server checks the bytes again (letterEmail.checkDeviceFile).
import React, { useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, Pressable, Platform, ActivityIndicator, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import { T } from '../rich-text/RichText';

export type AttachOption = {
  key: string;
  icon: any;
  tint: string;
  label: string;
  hint?: string;
  selected?: boolean;
  locked?: boolean;
};

export type DeviceFile = { uri: string; name: string; mimeType: string | null; size: number | null };

/** The document picker's filter: PDF and both generations of Word. */
export const DEVICE_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];
const MAX_BYTES = 5 * 1024 * 1024;
const OK_EXT = /\.(pdf|docx?)$/i;
/** How long the sheet may take to leave before the picker runs anyway (a slide is ~300 ms). */
const SHEET_SETTLE_MS = 650;

export default function SmartAttachSheet({
  visible, title, subtitle, options, busyKey, onPick, onDevice, onClose,
}: {
  visible: boolean;
  title: string;
  subtitle?: string;
  options: AttachOption[];
  /** The row (or 'device') whose work is running — a spinner there, every row disabled. */
  busyKey?: string | null;
  onPick: (key: string) => void;
  /** A file the user picked on the phone — already checked for type and size. */
  onDevice: (file: DeviceFile) => void;
  onClose: () => void;
}) {
  const pending = useRef<null | (() => void)>(null);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { pending.current = null; if (settle.current) clearTimeout(settle.current); }, []);

  const runPending = () => {
    if (settle.current) { clearTimeout(settle.current); settle.current = null; }
    const run = pending.current;
    pending.current = null;              // exactly once, whichever of onDismiss / the net gets here first
    run?.();
  };

  const openPicker = async () => {
    try {
      const r = await DocumentPicker.getDocumentAsync({ type: DEVICE_TYPES, copyToCacheDirectory: true, multiple: false });
      if (r.canceled || !r.assets || !r.assets.length) return;
      const a = r.assets[0];
      const name = a.name || 'document.pdf';
      if (!OK_EXT.test(name)) {
        Alert.alert('That file cannot be attached', 'Pick a PDF or Word file (.pdf, .doc, .docx).');
        return;
      }
      if (typeof a.size === 'number' && a.size > MAX_BYTES) {
        Alert.alert('That file is too large', 'Files up to 5 MB can be attached. Pick a smaller one.');
        return;
      }
      onDevice({ uri: a.uri, name, mimeType: a.mimeType || null, size: typeof a.size === 'number' ? a.size : null });
    } catch (e: any) {
      Alert.alert('Could not open that file', e?.message || 'Please try again.');
    }
  };

  const chooseDevice = () => {
    if (busyKey || pending.current) return;
    pending.current = openPicker;
    onClose();
    if (Platform.OS !== 'ios') { runPending(); return; }
    settle.current = setTimeout(runPending, SHEET_SETTLE_MS);
  };

  const busy = !!busyKey;
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} onDismiss={runPending}>
      <Pressable style={st.backdrop} onPress={() => { if (!busy) onClose(); }} />
      <View style={st.sheet}>
        <View style={st.grabber} />
        <Text style={st.title}>{title}</Text>
        {!!subtitle && <Text style={st.sub} numberOfLines={2}>{subtitle}</Text>}

        {options.map((o) => (
          <TouchableOpacity
            key={o.key}
            style={[st.block, o.selected && st.blockOn]}
            activeOpacity={0.85}
            disabled={busy}
            onPress={() => onPick(o.key)}
            accessibilityState={{ selected: !!o.selected }}
          >
            <View style={[st.icon, { backgroundColor: o.tint + '1F' }]}>
              <Ionicons name={o.icon} size={20} color={o.tint} />
            </View>
            <View style={st.fill}>
              <Text style={st.label} numberOfLines={1}>{o.label}</Text>
              {!!o.hint && <Text style={st.hint} numberOfLines={2}>{o.hint}</Text>}
            </View>
            {busyKey === o.key ? <ActivityIndicator size="small" color={T.blue} />
              : o.locked ? <View style={st.lock}><Ionicons name="lock-closed" size={10} color={T.muted} /><Text style={st.lockText}>Paid plans</Text></View>
                : o.selected ? <Ionicons name="checkmark-circle" size={20} color={T.emerald} />
                  : <Ionicons name="ellipse-outline" size={20} color={T.faint} />}
          </TouchableOpacity>
        ))}

        <TouchableOpacity style={st.row} activeOpacity={0.8} disabled={busy} onPress={chooseDevice}>
          <View style={[st.icon, { backgroundColor: 'rgba(90,100,128,0.12)' }]}>
            {busyKey === 'device' ? <ActivityIndicator size="small" color={T.muted} /> : <Ionicons name="folder-open" size={19} color={T.muted} />}
          </View>
          <View style={st.fill}>
            <Text style={st.label}>Choose from device</Text>
            <Text style={st.hint}>A PDF or Word file (.pdf, .doc, .docx) · up to 5 MB</Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={T.faint} />
        </TouchableOpacity>

        <TouchableOpacity style={st.cancel} activeOpacity={0.8} disabled={busy} onPress={onClose}>
          <Text style={st.cancelText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

const st = StyleSheet.create({
  backdrop:  { flex: 1, backgroundColor: 'rgba(11,15,34,0.45)' },
  sheet:     { backgroundColor: T.surface, borderTopLeftRadius: 26, borderTopRightRadius: 26, paddingHorizontal: 18, paddingTop: 10, paddingBottom: Platform.select({ ios: 34, default: 20 }), shadowColor: '#000', shadowOffset: { width: 0, height: -6 }, shadowOpacity: 0.18, shadowRadius: 20, elevation: 16 },
  grabber:   { alignSelf: 'center', width: 38, height: 4, borderRadius: 2, backgroundColor: 'rgba(11,15,34,0.10)', marginBottom: 12 },
  title:     { fontSize: 17, fontWeight: '800', color: T.ink, letterSpacing: -0.3 },
  sub:       { fontSize: 12.5, color: T.muted, marginTop: 2, marginBottom: 4 },
  fill:      { flex: 1 },
  block:     { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 10, padding: 12, borderRadius: 16, backgroundColor: T.bg, borderWidth: 1.5, borderColor: 'transparent' },
  blockOn:   { borderColor: T.emerald + '66', backgroundColor: T.emerald + '10' },
  icon:      { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  label:     { fontSize: 14.5, fontWeight: '700', color: T.ink },
  hint:      { fontSize: 11.5, color: T.muted, marginTop: 1 },
  lock:      { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: T.bgSoft, borderRadius: 10, paddingHorizontal: 7, paddingVertical: 3 },
  lockText:  { fontSize: 10.5, fontWeight: '800', color: T.muted },
  row:       { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 12, borderRadius: 14, backgroundColor: T.bg, marginTop: 10 },
  cancel:    { marginTop: 14, height: 46, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: T.bg, borderWidth: 1, borderColor: 'rgba(11,15,34,0.10)' },
  cancelText:{ fontSize: 14, fontWeight: '700', color: T.muted },
});
