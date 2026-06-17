// AI Hub — new feature. Safe to delete without affecting existing app.
//
// Admin-only page: lists every AI event in the system with its credit cost and lets
// the admin change the credits deducted per event (or toggle an event free). Saving a
// row hits PUT /api/admin/ai-event-costs/:eventKey; the change takes effect within a few
// seconds server-side (no redeploy). Backend enforces admin via authenticateAdmin.

import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity,
  ActivityIndicator, Switch, SafeAreaView, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useFocusEffect } from 'expo-router';
import {
  fetchAdminAiEvents, updateAiEventCost, type AiEventCost,
  adminSearchUsers, adminSetUserCredits, type AdminUser,
} from '../../services/aiHubService';

type Row = AiEventCost & { _credits: string; _active: boolean; _dirty: boolean; _saving: boolean; _saved: boolean };

export default function AiEventCreditsScreen() {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const events = await fetchAdminAiEvents();
      setRows(events.map((e) => ({
        ...e,
        _credits: String(e.credits),
        _active: e.is_active === 1,
        _dirty: false, _saving: false, _saved: false,
      })));
    } catch (e: any) {
      setError(e?.response?.status === 403 ? 'Admin access required.' : 'Could not load AI events.');
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const patch = (key: string, p: Partial<Row>) =>
    setRows((prev) => prev.map((r) => (r.event_key === key ? { ...r, ...p } : r)));

  const onCredits = (key: string, text: string) => {
    const clean = text.replace(/[^0-9]/g, '').slice(0, 4);
    patch(key, { _credits: clean, _dirty: true, _saved: false });
  };
  const onToggle = (key: string, val: boolean) => patch(key, { _active: val, _dirty: true, _saved: false });

  const save = async (row: Row) => {
    const credits = parseInt(row._credits, 10);
    if (isNaN(credits) || credits < 0) { Alert.alert('Invalid', 'Enter a whole number ≥ 0.'); return; }
    patch(row.event_key, { _saving: true });
    try {
      await updateAiEventCost(row.event_key, credits, row._active);
      patch(row.event_key, {
        _saving: false, _dirty: false, _saved: true,
        credits, is_active: row._active ? 1 : 0, _credits: String(credits),
      });
      setTimeout(() => patch(row.event_key, { _saved: false }), 1800);
    } catch (e: any) {
      patch(row.event_key, { _saving: false });
      Alert.alert('Save failed', e?.response?.data?.error || 'Please try again.');
    }
  };

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="arrow-back" size={22} color="#fff" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.title}>AI Event Credits</Text>
          <Text style={s.subtitle}>Credits charged per AI action — edit live</Text>
        </View>
        <TouchableOpacity onPress={load} style={s.backBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="refresh" size={19} color="#9FB2D4" />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={s.center}><ActivityIndicator size="large" color="#06B6D4" /></View>
      ) : error ? (
        <View style={s.center}>
          <Ionicons name="lock-closed-outline" size={34} color="#64748B" />
          <Text style={s.errTxt}>{error}</Text>
          <TouchableOpacity onPress={load} style={s.retry}><Text style={s.retryTxt}>Retry</Text></TouchableOpacity>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
          <UserCreditAdmin />
          <Text style={s.sectionTitle}>Event credit costs</Text>
          <Text style={s.note}>Set credits to 0 to make an action free. Inactive events are never charged.</Text>
          {rows.map((r) => (
            <View key={r.event_key} style={s.card}>
              <View style={s.cardTop}>
                <View style={{ flex: 1, paddingRight: 10 }}>
                  <View style={s.labelRow}>
                    <Text style={s.cardLabel}>{r.label}</Text>
                    <View style={[s.tag, r.category === 'free' ? s.tagFree : s.tagPaid]}>
                      <Text style={[s.tagTxt, { color: r.category === 'free' ? '#34D399' : '#38BDF8' }]}>{r.category}</Text>
                    </View>
                  </View>
                  <Text style={s.cardDesc} numberOfLines={2}>{r.description}</Text>
                  <Text style={s.cardKey}>{r.event_key}</Text>
                </View>
              </View>

              <View style={s.controls}>
                <View style={s.creditBox}>
                  <TextInput
                    style={s.creditInput}
                    value={r._credits}
                    onChangeText={(t) => onCredits(r.event_key, t)}
                    keyboardType="number-pad"
                    maxLength={4}
                    selectTextOnFocus
                  />
                  <Text style={s.creditUnit}>credits</Text>
                </View>

                <View style={s.activeBox}>
                  <Text style={s.activeLabel}>Active</Text>
                  <Switch
                    value={r._active}
                    onValueChange={(v) => onToggle(r.event_key, v)}
                    trackColor={{ false: '#334155', true: '#0E7490' }}
                    thumbColor={r._active ? '#22D3EE' : '#94A3B8'}
                  />
                </View>

                <TouchableOpacity
                  onPress={() => save(r)}
                  disabled={!r._dirty || r._saving}
                  style={[s.saveBtn, (!r._dirty || r._saving) && s.saveBtnOff, r._saved && s.saveBtnDone]}
                  activeOpacity={0.85}
                >
                  {r._saving ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : r._saved ? (
                    <Ionicons name="checkmark" size={18} color="#fff" />
                  ) : (
                    <Text style={s.saveTxt}>Save</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

// ── User credit management: email typeahead → select → set credits → save ──────
function UserCreditAdmin() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<AdminUser[]>([]);
  const [selected, setSelected] = useState<AdminUser | null>(null);
  const [edit, setEdit] = useState('');
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (selected) return;                       // not searching while a user is selected
    const term = q.trim();
    if (term.length < 2) { setResults([]); setSearching(false); return; }
    setSearching(true);
    const t = setTimeout(async () => {
      try { setResults(await adminSearchUsers(term)); }
      catch { setResults([]); }
      finally { setSearching(false); }
    }, 300);                                    // debounce
    return () => clearTimeout(t);
  }, [q, selected]);

  const pick = (u: AdminUser) => { setSelected(u); setEdit(String(u.credits_remaining)); setResults([]); setQ(u.email); setSaved(false); };
  const reset = () => { setSelected(null); setQ(''); setEdit(''); setResults([]); setSaved(false); };

  const save = async () => {
    if (!selected) return;
    const n = parseInt(edit, 10);
    if (isNaN(n) || n < 0) { Alert.alert('Invalid', 'Enter a whole number ≥ 0.'); return; }
    setSaving(true);
    try {
      const newBal = await adminSetUserCredits(selected.id, n);
      setSelected({ ...selected, credits_remaining: newBal });
      setEdit(String(newBal));
      setSaved(true); setTimeout(() => setSaved(false), 1800);
    } catch (e: any) {
      Alert.alert('Save failed', e?.response?.data?.error || 'Please try again.');
    } finally { setSaving(false); }
  };

  const unchanged = edit === '' || edit === String(selected?.credits_remaining);

  return (
    <View style={s.ucCard}>
      <View style={s.ucHeader}>
        <Ionicons name="person-circle-outline" size={20} color="#22D3EE" />
        <Text style={s.ucTitle}>User credits</Text>
      </View>
      <Text style={s.ucSub}>Search a user by email, then set their available credits.</Text>

      {!selected ? (
        <>
          <View style={s.ucSearchBox}>
            <Ionicons name="search" size={15} color="#64748B" />
            <TextInput
              style={s.ucSearchInput}
              value={q}
              onChangeText={setQ}
              placeholder="Type an email…"
              placeholderTextColor="#64748B"
              autoCapitalize="none"
              keyboardType="email-address"
              autoCorrect={false}
            />
            {searching ? <ActivityIndicator size="small" color="#64748B" /> : null}
          </View>
          {results.length > 0 && (
            <View style={s.ucResults}>
              {results.map((u) => (
                <TouchableOpacity key={u.id} style={s.ucResultRow} onPress={() => pick(u)} activeOpacity={0.7}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={s.ucResultEmail} numberOfLines={1}>{u.email}</Text>
                    {!!u.full_name && <Text style={s.ucResultName} numberOfLines={1}>{u.full_name}</Text>}
                  </View>
                  <Text style={s.ucResultCredits}>{u.credits_remaining}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
          {q.trim().length >= 2 && !searching && results.length === 0 && (
            <Text style={s.ucEmpty}>No users match that email.</Text>
          )}
        </>
      ) : (
        <View>
          <View style={s.ucSelTop}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={s.ucSelName} numberOfLines={1}>{selected.full_name || '—'}</Text>
              <Text style={s.ucSelEmail} numberOfLines={1}>{selected.email}</Text>
            </View>
            <TouchableOpacity onPress={reset} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close-circle" size={22} color="#64748B" />
            </TouchableOpacity>
          </View>

          <View style={s.ucEditRow}>
            <View style={s.ucCreditBox}>
              <TextInput
                style={s.ucCreditInput}
                value={edit}
                onChangeText={(t) => { setEdit(t.replace(/[^0-9]/g, '').slice(0, 7)); setSaved(false); }}
                keyboardType="number-pad"
                maxLength={7}
                selectTextOnFocus
              />
              <Text style={s.ucCreditUnit}>credits</Text>
            </View>
            <TouchableOpacity
              onPress={save}
              disabled={saving || unchanged}
              style={[s.saveBtn, (saving || unchanged) && s.saveBtnOff, saved && s.saveBtnDone]}
              activeOpacity={0.85}
            >
              {saving ? <ActivityIndicator size="small" color="#fff" /> : saved ? <Ionicons name="checkmark" size={18} color="#fff" /> : <Text style={s.saveTxt}>Save</Text>}
            </TouchableOpacity>
          </View>
          <TouchableOpacity onPress={reset}><Text style={s.ucAnother}>Search another user</Text></TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0B1120' },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 14, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  backBtn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.06)' },
  title: { fontSize: 18, fontWeight: '800', color: '#fff' },
  subtitle: { fontSize: 12, color: '#94A3B8', marginTop: 2 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  errTxt: { color: '#CBD5E1', fontSize: 14 },
  retry: { backgroundColor: '#1E293B', paddingHorizontal: 18, paddingVertical: 9, borderRadius: 10 },
  retryTxt: { color: '#fff', fontWeight: '700' },
  note: { color: '#7C8BA5', fontSize: 12.5, lineHeight: 18, marginBottom: 14 },
  sectionTitle: { color: '#F8FAFC', fontSize: 16, fontWeight: '800', marginTop: 22, marginBottom: 6 },
  // User-credit card
  ucCard: { backgroundColor: 'rgba(34,211,238,0.06)', borderColor: 'rgba(34,211,238,0.18)', borderWidth: 1, borderRadius: 16, padding: 14 },
  ucHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  ucTitle: { color: '#F8FAFC', fontSize: 15.5, fontWeight: '800' },
  ucSub: { color: '#94A3B8', fontSize: 12.5, lineHeight: 17, marginTop: 4, marginBottom: 12 },
  ucSearchBox: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)', paddingHorizontal: 12, height: 44 },
  ucSearchInput: { flex: 1, color: '#F1F5F9', fontSize: 14, paddingVertical: 0 },
  ucResults: { marginTop: 8, backgroundColor: 'rgba(2,6,23,0.5)', borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', overflow: 'hidden' },
  ucResultRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.06)' },
  ucResultEmail: { color: '#E2E8F0', fontSize: 13.5, fontWeight: '600' },
  ucResultName: { color: '#7C8BA5', fontSize: 11.5, marginTop: 1 },
  ucResultCredits: { color: '#22D3EE', fontSize: 13, fontWeight: '800' },
  ucEmpty: { color: '#64748B', fontSize: 12.5, marginTop: 10 },
  ucSelTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  ucSelName: { color: '#F8FAFC', fontSize: 15, fontWeight: '700' },
  ucSelEmail: { color: '#94A3B8', fontSize: 12.5, marginTop: 2 },
  ucEditRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14 },
  ucCreditBox: { flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 7 },
  ucCreditInput: { color: '#fff', fontSize: 18, fontWeight: '800', minWidth: 54, textAlign: 'center', paddingVertical: 3 },
  ucCreditUnit: { color: '#94A3B8', fontSize: 12 },
  ucAnother: { color: '#22D3EE', fontSize: 12.5, fontWeight: '600', marginTop: 12 },
  card: { backgroundColor: 'rgba(255,255,255,0.04)', borderColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderRadius: 16, padding: 14, marginBottom: 12 },
  cardTop: { flexDirection: 'row' },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  cardLabel: { fontSize: 15, fontWeight: '700', color: '#F8FAFC' },
  tag: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 20 },
  tagPaid: { backgroundColor: 'rgba(56,189,248,0.14)' },
  tagFree: { backgroundColor: 'rgba(16,185,129,0.14)' },
  tagTxt: { fontSize: 10.5, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  cardDesc: { fontSize: 12.5, color: '#94A3B8', marginTop: 4, lineHeight: 17 },
  cardKey: { fontSize: 11, color: '#475569', marginTop: 5, fontFamily: 'monospace' },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 14 },
  creditBox: { flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 6 },
  creditInput: { color: '#fff', fontSize: 18, fontWeight: '800', minWidth: 34, textAlign: 'center', paddingVertical: 4 },
  creditUnit: { color: '#94A3B8', fontSize: 12 },
  activeBox: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  activeLabel: { color: '#94A3B8', fontSize: 12 },
  saveBtn: { marginLeft: 'auto', backgroundColor: '#06B6D4', borderRadius: 11, paddingHorizontal: 18, height: 38, minWidth: 64, alignItems: 'center', justifyContent: 'center' },
  saveBtnOff: { backgroundColor: '#1E293B' },
  saveBtnDone: { backgroundColor: '#16A34A' },
  saveTxt: { color: '#fff', fontWeight: '800', fontSize: 14 },
});
