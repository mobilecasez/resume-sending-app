// AI Hub — new feature. Safe to delete without affecting existing app.
//
// The Job Agent screen: tell it what you want, and every day it finds matching jobs, scores the fit honestly,
// prepares a tailored résumé + cover letter for the best ones (within your plan's monthly allowance) and — only if
// you choose — emails applications whose posting gives an email, from your own mailbox. Everything else waits in
// "Ready", opening in the in-app apply browser with Auto Fill: a company form is never submitted for you.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, Switch, ActivityIndicator, Alert, RefreshControl,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { track } from '../../services/analytics';
import {
  fetchOverview, fetchQueue, saveSettings, runNow, prepareItem, sendItem, markApplied, skipItem, reasonText,
  type AgentOverview, type AgentItem, type AgentCriteria, AgentError,
} from '../../services/jobAgentService';

const C = {
  navy: '#0B1120', panel: '#F0F4FA', card: '#FFFFFF', ink: '#0F172A', muted: '#64748B', faint: '#94A3B8',
  border: '#E2E8F0', cyan: '#06B6D4', blue: '#3B82F6', emerald: '#10B981', amber: '#F59E0B', rose: '#F43F5E', violet: '#8B5CF6',
};
const BAND_COLOR: Record<string, string> = { strong: C.emerald, good: C.blue, moderate: C.amber, weak: C.rose, poor: C.rose };
const TABS = [
  { key: 'ready', label: 'Ready', statuses: ['ready', 'preparing', 'sending'] },
  { key: 'matched', label: 'Matched', statuses: ['matched', 'failed'] },
  { key: 'done', label: 'Applied', statuses: ['sent', 'applied'] },
] as const;
type TabKey = typeof TABS[number]['key'];

const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
const joinList = (a: string[] | undefined) => (a || []).join(', ');
const hashId = (s: string) => { let h = 0; const k = s || 'x'; for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0; return 'gj_' + h.toString(36); };

export default function JobAgentScreen() {
  const router = useRouter();
  const [ov, setOv] = useState<AgentOverview | null>(null);
  const [items, setItems] = useState<AgentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<TabKey>('ready');
  const [busyId, setBusyId] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  // The criteria form — strings while typing, cleaned into lists on save.
  const [roles, setRoles] = useState('');
  const [locations, setLocations] = useState('');
  const [countries, setCountries] = useState('');
  const [remote, setRemote] = useState<AgentCriteria['remote']>('any');
  const [minFit, setMinFit] = useState(60);
  const [dailyCap, setDailyCap] = useState(5);
  const [sendMode, setSendMode] = useState<'review' | 'auto_email'>('review');
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [o, q] = await Promise.all([fetchOverview(), fetchQueue()]);
      setOv(o);
      setItems(q.items || []);
      const c = o.settings.criteria;
      setRoles(joinList(c.roles)); setLocations(joinList(c.locations)); setCountries(joinList(c.countries));
      setRemote(c.remote); setMinFit(c.minFit); setDailyCap(o.settings.dailyCap); setSendMode(o.settings.sendMode);
      if (!c.roles.length) setEditing(true);   // nothing to look for yet: open the form
      setLoadError(null);
    } catch (e: any) {
      // Never a blank, switched-off agent: say it could not load, and keep whatever was on screen.
      setLoadError(e instanceof AgentError && e.reason === 'signed_out' ? reasonText('signed_out') : 'Could not load your Job Agent. Pull down to try again.');
    } finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { track('job_agent_view', {}).catch(() => {}); }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const shown = useMemo(() => {
    const want = TABS.find((t) => t.key === tab)!.statuses as readonly string[];
    return items.filter((i) => want.includes(i.status));
  }, [items, tab]);
  const countOf = (k: TabKey) => items.filter((i) => (TABS.find((t) => t.key === k)!.statuses as readonly string[]).includes(i.status)).length;

  const fail = (e: any) => Alert.alert('Job Agent', reasonText(e instanceof AgentError ? e.reason : 'failed'));

  const save = async (enabledOverride?: boolean) => {
    setSaving(true);
    try {
      const r = await saveSettings({
        enabled: enabledOverride != null ? enabledOverride : ov?.settings.enabled,
        criteria: { roles: list(roles), locations: list(locations), countries: list(countries), remote, minFit, excludeEmployers: ov?.settings.criteria.excludeEmployers || [] },
        sendMode, dailyCap,
      });
      track('job_agent_save', { enabled: r.settings.enabled, sendMode, dailyCap, roles: r.settings.criteria.roles.length }).catch(() => {});
      setOv((o) => (o ? { ...o, settings: r.settings } : o));
      setEditing(false);
      return true;
    } catch (e) { fail(e); return false; } finally { setSaving(false); }
  };

  const toggle = async (on: boolean) => {
    track('job_agent_toggle', { on }).catch(() => {});
    if (on && !list(roles).length) { setEditing(true); Alert.alert('Job Agent', reasonText('roles_required')); return; }
    await save(on);
  };

  const run = async () => {
    if (loadError) { load(); return; }
    if (!ov?.settings.enabled) { Alert.alert('Job Agent', 'Switch the agent on first.'); return; }
    setRunning(true);
    track('job_agent_run', {}).catch(() => {});
    try {
      const r = await runNow();
      const s = r.summary;
      const parts = [`${s.matched} new match${s.matched === 1 ? '' : 'es'}`, `${s.prepared} prepared`];
      if (s.sent) parts.push(`${s.sent} sent`);
      const reason = s.skippedReason || s.stoppedReason || s.sendBlocked;
      const why = reason ? `\n\n${reasonText(reason)}` : '';
      Alert.alert('Job Agent', parts.join(' · ') + '.' + why);
      setTab(s.prepared ? 'ready' : 'matched');
    } catch (e) { fail(e); } finally { setRunning(false); load(); }
  };

  const act = async (item: AgentItem, what: 'prepare' | 'send' | 'applied' | 'skip') => {
    setBusyId(item.id);
    track(`job_agent_${what}`, { channel: item.channel, score: item.fit?.score ?? null }).catch(() => {});
    try {
      if (what === 'prepare') await prepareItem(item.id);
      if (what === 'send') await sendItem(item.id);
      if (what === 'applied') await markApplied(item.id);
      if (what === 'skip') await skipItem(item.id);
    } catch (e) { fail(e); } finally { setBusyId(null); load(); }
  };

  const confirmSend = (item: AgentItem) => Alert.alert(
    'Send this application?',
    `Your tailored résumé and cover letter will be emailed to ${item.applyEmail} from your own mailbox.`,
    [{ text: 'Cancel', style: 'cancel' }, { text: 'Send', onPress: () => act(item, 'send') }],
  );

  const openApply = (item: AgentItem) => {
    track('job_agent_open_apply', { channel: item.channel }).catch(() => {});
    const job = { id: hashId(item.jobUrl), title: item.title, location: item.location || 'Not specified', experience: '', salary: '', jobType: '',
      workMode: null, urgent: false, skills: [], responsibilities: [], contacts: [], applyUrl: item.jobUrl, matchScore: item.fit?.score ?? null };
    const employer = { id: 'g_' + String(item.employer || 'co').toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: item.employer || 'Company',
      subInfo: [item.location, item.country].filter(Boolean).join(' · '), logoColor: [C.cyan, C.blue], logoInitial: (item.employer || '?').charAt(0).toUpperCase(), domain: '' };
    router.push({ pathname: '/(ai-hub)/job-detail', params: { jobStr: JSON.stringify(job), employerStr: JSON.stringify(employer), autoApply: '1', applyNowUrl: item.jobUrl } } as never);
  };

  if (loading) return <View style={s.center}><ActivityIndicator color={C.cyan} /></View>;
  const a = ov?.allowance;
  const enabled = !!ov?.settings.enabled;
  const pct = a && a.monthly > 0 ? Math.min(1, a.used / a.monthly) : 0;

  return (
    <SafeAreaView style={s.root} edges={['top']}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.back} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="arrow-back" size={22} color="#fff" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.title}>Job Agent</Text>
          <Text style={s.subtitle}>Finds jobs, tailors your documents, and helps you apply</Text>
        </View>
        <Switch value={enabled} onValueChange={toggle} disabled={saving} trackColor={{ true: C.emerald, false: '#334155' }} thumbColor="#fff" />
      </View>

      <ScrollView style={s.panel} contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={C.cyan} />}>
        {loadError ? (
          <View style={s.errBox}><Ionicons name="cloud-offline-outline" size={16} color={C.rose} /><Text style={s.errTx}>{loadError}</Text></View>
        ) : null}

        {/* ── this month ── */}
        {a ? (
          <View style={s.card}>
            <View style={s.rowBetween}>
              <Text style={s.cardLabel}>{a.preview ? 'FREE PREVIEW' : 'THIS MONTH'}</Text>
              <Text style={s.meta}>{a.used} of {a.monthly} prepared</Text>
            </View>
            <View style={s.bar}><View style={[s.barFill, { width: `${pct * 100}%` }]} /></View>
            <Text style={s.small}>
              {a.preview
                ? `The agent prepares up to ${a.monthly} tailored applications a month on the free plan. Sending applications needs a plan.`
                : `${a.remaining} left until your plan renews. Up to ${ov?.settings.dailyCap} a day.`}
            </Text>
            {a.preview || a.remaining === 0 ? (
              <TouchableOpacity style={s.linkBtn} onPress={() => router.push('/(subscription)/plans' as never)}>
                <Text style={s.linkTx}>{a.preview ? 'See plans' : 'Upgrade for more'}</Text>
                <Ionicons name="chevron-forward" size={14} color={C.blue} />
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}

        {/* ── what to look for ── */}
        <View style={s.card}>
          <View style={s.rowBetween}>
            <Text style={s.cardLabel}>WHAT YOU WANT</Text>
            {!editing ? <TouchableOpacity onPress={() => setEditing(true)}><Text style={s.linkTx}>Edit</Text></TouchableOpacity> : null}
          </View>
          {editing ? (
            <>
              <Field label="Roles" hint="e.g. Customer Support, Sales Executive" value={roles} onChange={setRoles} />
              <Field label="Cities (optional)" hint="e.g. Pune, Bengaluru" value={locations} onChange={setLocations} />
              <Field label="Countries (optional)" hint="e.g. India, United Arab Emirates" value={countries} onChange={setCountries} />
              <Text style={s.fieldLabel}>Work type</Text>
              <View style={s.chips}>
                {(['any', 'remote', 'hybrid', 'onsite'] as const).map((r) => (
                  <Chip key={r} on={remote === r} label={r === 'any' ? 'Any' : r === 'onsite' ? 'On-site' : r[0].toUpperCase() + r.slice(1)} onPress={() => setRemote(r)} />
                ))}
              </View>
              <Text style={s.fieldLabel}>Only jobs that fit at least</Text>
              <View style={s.chips}>
                {[50, 60, 70, 80].map((n) => <Chip key={n} on={minFit === n} label={`${n}%`} onPress={() => setMinFit(n)} />)}
              </View>
              <Text style={s.fieldLabel}>Applications prepared per day</Text>
              <View style={s.stepper}>
                <TouchableOpacity style={s.stepBtn} onPress={() => setDailyCap((n) => Math.max(1, n - 1))}><Ionicons name="remove" size={18} color={C.ink} /></TouchableOpacity>
                <Text style={s.stepVal}>{dailyCap}</Text>
                <TouchableOpacity style={s.stepBtn} onPress={() => setDailyCap((n) => Math.min(ov?.dailyCapMax || 10, n + 1))}><Ionicons name="add" size={18} color={C.ink} /></TouchableOpacity>
              </View>
              <Text style={s.fieldLabel}>Sending</Text>
              <Radio on={sendMode === 'review'} title="I review each one" body="Nothing is sent until you tap Send or apply yourself." onPress={() => setSendMode('review')} />
              <Radio on={sendMode === 'auto_email'} title="Send email applications automatically"
                disabled={!a?.canSend}
                body={a?.canSend
                  ? 'When a job asks for applications by email, the agent sends your tailored résumé and letter from your own Gmail or Outlook. Company forms always wait for you.'
                  : 'Needs a plan. When a job asks for applications by email, the agent can send them from your own Gmail or Outlook.'}
                onPress={() => setSendMode('auto_email')} />
              <TouchableOpacity style={[s.primary, saving && { opacity: 0.6 }]} disabled={saving} onPress={() => save()}>
                {saving ? <ActivityIndicator color="#fff" /> : <Text style={s.primaryTx}>Save</Text>}
              </TouchableOpacity>
            </>
          ) : (
            <View style={{ gap: 6 }}>
              <Summary icon="briefcase-outline" text={joinList(ov?.settings.criteria.roles) || '—'} />
              {ov?.settings.criteria.locations.length || ov?.settings.criteria.countries.length
                ? <Summary icon="location-outline" text={[...(ov?.settings.criteria.locations || []), ...(ov?.settings.criteria.countries || [])].join(', ')} /> : null}
              <Summary icon="speedometer-outline" text={`Fit ${ov?.settings.criteria.minFit}%+ · ${ov?.settings.dailyCap} a day · ${ov?.settings.criteria.remote === 'any' ? 'any work type' : ov?.settings.criteria.remote}`} />
              <Summary icon={ov?.settings.sendMode === 'auto_email' ? 'mail-outline' : 'hand-left-outline'}
                text={ov?.settings.sendMode === 'auto_email'
                  ? (a?.canSend ? 'Email applications are sent automatically' : 'Automatic sending is paused — it needs a plan')
                  : 'You review each application'} />
            </View>
          )}
        </View>

        {/* ── run now ── */}
        <TouchableOpacity activeOpacity={0.88} disabled={running} onPress={run}>
          <LinearGradient colors={[C.cyan, C.blue]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={[s.runBtn, running && { opacity: 0.7 }]}>
            {running ? <ActivityIndicator color="#fff" /> : <Ionicons name="sparkles" size={18} color="#fff" />}
            <Text style={s.runTx}>{running ? 'Finding and preparing… this can take a few minutes' : 'Find jobs now'}</Text>
          </LinearGradient>
        </TouchableOpacity>
        {ov?.settings.lastRunAt ? (
          <Text style={s.lastRun}>Last run {new Date(ov.settings.lastRunAt).toLocaleString()}{enabled ? ' · runs again automatically every day' : ''}</Text>
        ) : null}

        {/* ── the queue ── */}
        <View style={s.tabs}>
          {TABS.map((t) => (
            <TouchableOpacity key={t.key} style={[s.tab, tab === t.key && s.tabOn]} onPress={() => setTab(t.key)}>
              <Text style={[s.tabTx, tab === t.key && s.tabTxOn]}>{t.label} {countOf(t.key) ? `(${countOf(t.key)})` : ''}</Text>
            </TouchableOpacity>
          ))}
        </View>
        {shown.length === 0 ? (
          <Text style={s.empty}>
            {tab === 'ready' ? 'Applications the agent prepared appear here, ready to send or apply.'
              : tab === 'matched' ? 'Jobs that fit you appear here. Tap Prepare to tailor documents for one.'
                : 'Applications you sent or submitted appear here.'}
          </Text>
        ) : shown.map((it) => (
          <ItemCard key={it.id} item={it} busy={busyId === it.id} canSend={!!a?.canSend}
            onPrepare={() => act(it, 'prepare')} onSend={() => confirmSend(it)} onApply={() => openApply(it)}
            onApplied={() => act(it, 'applied')} onSkip={() => act(it, 'skip')}
            onResume={() => it.resumeDocId && router.push({ pathname: '/(resume-builder)/preview', params: { docId: it.resumeDocId, from: 'home' } } as never)}
            onLetter={() => it.letterDocId && router.push({ pathname: '/(cover-letter)/edit', params: { docId: it.letterDocId } } as never)} />
        ))}

        <View style={s.note}>
          <Ionicons name="shield-checkmark-outline" size={16} color={C.muted} />
          <Text style={s.noteTx}>
            The agent only uses your real experience, skips jobs that rule you out (citizenship or a language you don’t speak), and never applies
            to the same employer twice in a month. Company forms are never submitted for you — you review and tap Submit.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function ItemCard({ item, busy, canSend, onPrepare, onSend, onApply, onApplied, onSkip, onResume, onLetter }: {
  item: AgentItem; busy: boolean; canSend: boolean;
  onPrepare: () => void; onSend: () => void; onApply: () => void; onApplied: () => void; onSkip: () => void; onResume: () => void; onLetter: () => void;
}) {
  const fit = item.fit;
  const color = fit ? BAND_COLOR[fit.band] || C.blue : C.faint;
  const working = item.status === 'preparing' || item.status === 'sending';
  return (
    <View style={s.item}>
      <View style={s.rowBetween}>
        <View style={{ flex: 1, paddingRight: 8 }}>
          <Text style={s.itemTitle} numberOfLines={2}>{item.title}</Text>
          <Text style={s.itemSub} numberOfLines={1}>{[item.employer, item.location].filter(Boolean).join(' · ')}</Text>
        </View>
        {fit ? <View style={[s.fitPill, { backgroundColor: color + '1A', borderColor: color + '55' }]}><Text style={[s.fitTx, { color }]}>{fit.score}% fit</Text></View> : null}
      </View>
      <View style={s.tags}>
        <Tag icon={item.channel === 'email' ? 'mail-outline' : 'globe-outline'} text={item.channel === 'email' ? `Email · ${item.applyEmail}` : 'Apply on the company site'} />
        {fit?.deadline ? <Tag icon="time-outline" text={`Closes ${fit.deadline}`} /> : null}
        {item.status === 'sent' || item.status === 'applied' ? <Tag icon="checkmark-circle-outline" text={item.status === 'sent' ? 'Sent' : 'Applied'} /> : null}
      </View>
      {fit?.strengths?.slice(0, 2).map((x, i) => <Text key={'s' + i} style={s.strength}>✓ {x}</Text>)}
      {fit?.gaps?.slice(0, 2).map((x, i) => <Text key={'g' + i} style={s.gap}>– {x}</Text>)}
      {fit?.language === 'flag' && fit.languageQuote ? <Text style={s.warn}>⚠ Language: “{fit.languageQuote}”</Text> : null}
      {item.error && item.status !== 'sent' ? <Text style={s.warn}>{reasonText(item.error)}</Text> : null}

      {busy || working ? <ActivityIndicator style={{ marginTop: 10 }} color={C.cyan} /> : (
        <View style={s.actions}>
          {item.status === 'matched' || item.status === 'failed' ? (
            <>
              <Btn primary label="Prepare documents" onPress={onPrepare} />
              <Btn label="Skip" onPress={onSkip} />
            </>
          ) : null}
          {item.status === 'ready' ? (
            <>
              {item.channel === 'email' && canSend ? <Btn primary label="Send" onPress={onSend} /> : <Btn primary label="Open & apply" onPress={onApply} />}
              <Btn label="Résumé" onPress={onResume} />
              <Btn label="Letter" onPress={onLetter} />
              {!(item.channel === 'email' && canSend) ? <Btn label="I applied" onPress={onApplied} /> : null}
              <Btn label="Skip" onPress={onSkip} />
            </>
          ) : null}
          {item.status === 'sent' || item.status === 'applied' ? (
            <>
              <Btn label="Résumé" onPress={onResume} />
              <Btn label="Letter" onPress={onLetter} />
            </>
          ) : null}
        </View>
      )}
    </View>
  );
}

function Field({ label, hint, value, onChange }: { label: string; hint: string; value: string; onChange: (v: string) => void }) {
  return (
    <View style={{ marginTop: 10 }}>
      <Text style={s.fieldLabel}>{label}</Text>
      <TextInput style={s.input} value={value} onChangeText={onChange} placeholder={hint} placeholderTextColor={C.faint} autoCapitalize="words" />
    </View>
  );
}
function Chip({ on, label, onPress }: { on: boolean; label: string; onPress: () => void }) {
  return <TouchableOpacity onPress={onPress} style={[s.chip, on && s.chipOn]}><Text style={[s.chipTx, on && s.chipTxOn]}>{label}</Text></TouchableOpacity>;
}
function Radio({ on, title, body, onPress, disabled }: { on: boolean; title: string; body: string; onPress: () => void; disabled?: boolean }) {
  return (
    <TouchableOpacity onPress={disabled ? undefined : onPress} disabled={disabled} style={[s.radio, on && s.radioOn, disabled && s.radioOff]} activeOpacity={0.85}>
      <Ionicons name={on ? 'radio-button-on' : 'radio-button-off'} size={18} color={on ? C.blue : C.faint} />
      <View style={{ flex: 1 }}><Text style={s.radioTitle}>{title}</Text><Text style={s.small}>{body}</Text></View>
    </TouchableOpacity>
  );
}
function Summary({ icon, text }: { icon: any; text: string }) {
  return <View style={s.sumRow}><Ionicons name={icon} size={15} color={C.muted} /><Text style={s.sumTx} numberOfLines={2}>{text}</Text></View>;
}
function Tag({ icon, text }: { icon: any; text: string }) {
  return <View style={s.tag}><Ionicons name={icon} size={12} color={C.muted} /><Text style={s.tagTx} numberOfLines={1}>{text}</Text></View>;
}
function Btn({ label, onPress, primary }: { label: string; onPress: () => void; primary?: boolean }) {
  return <TouchableOpacity onPress={onPress} style={[s.btn, primary && s.btnPrimary]}><Text style={[s.btnTx, primary && s.btnTxPrimary]}>{label}</Text></TouchableOpacity>;
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.navy },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.navy },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
  back: { padding: 4 },
  title: { color: '#fff', fontSize: 20, fontWeight: '800', letterSpacing: -0.4 },
  subtitle: { color: 'rgba(255,255,255,0.55)', fontSize: 12, marginTop: 2 },
  panel: { flex: 1, backgroundColor: C.panel, borderTopLeftRadius: 28, borderTopRightRadius: 28 },
  card: { backgroundColor: C.card, borderRadius: 20, padding: 16, marginBottom: 14, shadowColor: '#0F172A', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.06, shadowRadius: 16, elevation: 3 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardLabel: { fontSize: 11, fontWeight: '800', color: C.muted, letterSpacing: 1 },
  meta: { fontSize: 13, fontWeight: '700', color: C.ink },
  bar: { height: 8, borderRadius: 4, backgroundColor: '#E2E8F0', marginTop: 10, overflow: 'hidden' },
  barFill: { height: 8, borderRadius: 4, backgroundColor: C.cyan },
  small: { fontSize: 12, color: C.muted, marginTop: 8, lineHeight: 17 },
  linkBtn: { flexDirection: 'row', alignItems: 'center', marginTop: 10, gap: 2 },
  linkTx: { color: C.blue, fontWeight: '700', fontSize: 13 },
  fieldLabel: { fontSize: 12, fontWeight: '700', color: C.ink, marginTop: 12, marginBottom: 6 },
  input: { borderWidth: 1, borderColor: C.border, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: C.ink, backgroundColor: '#F8FAFC' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: C.border, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 7, backgroundColor: '#fff', minHeight: 34 },
  chipOn: { backgroundColor: C.blue, borderColor: C.blue },
  chipTx: { fontSize: 12, fontWeight: '700', color: C.ink },
  chipTxOn: { color: '#fff' },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  stepBtn: { width: 40, height: 40, borderRadius: 12, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  stepVal: { fontSize: 18, fontWeight: '800', color: C.ink, minWidth: 24, textAlign: 'center' },
  radio: { flexDirection: 'row', gap: 10, borderWidth: 1, borderColor: C.border, borderRadius: 14, padding: 12, marginTop: 8, backgroundColor: '#fff' },
  radioOn: { borderColor: C.blue, backgroundColor: '#EFF6FF' },
  radioOff: { opacity: 0.55 },
  radioTitle: { fontSize: 13, fontWeight: '800', color: C.ink },
  errBox: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#FFF1F2', borderRadius: 14, padding: 12, marginBottom: 12 },
  errTx: { flex: 1, color: '#9F1239', fontSize: 13 },
  primary: { marginTop: 16, height: 48, borderRadius: 14, backgroundColor: C.ink, alignItems: 'center', justifyContent: 'center' },
  primaryTx: { color: '#fff', fontWeight: '800', fontSize: 15 },
  sumRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sumTx: { flex: 1, fontSize: 13, color: C.ink },
  runBtn: { height: 52, borderRadius: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 16 },
  runTx: { color: '#fff', fontWeight: '800', fontSize: 15, flexShrink: 1 },
  lastRun: { textAlign: 'center', fontSize: 11, color: C.muted, marginTop: 8 },
  tabs: { flexDirection: 'row', backgroundColor: '#E2E8F0', borderRadius: 14, padding: 4, marginTop: 18, marginBottom: 12 },
  tab: { flex: 1, paddingVertical: 9, borderRadius: 10, alignItems: 'center' },
  tabOn: { backgroundColor: '#fff' },
  tabTx: { fontSize: 13, fontWeight: '700', color: C.muted },
  tabTxOn: { color: C.ink },
  empty: { textAlign: 'center', color: C.muted, fontSize: 13, paddingVertical: 24, paddingHorizontal: 20, lineHeight: 19 },
  item: { backgroundColor: C.card, borderRadius: 18, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: C.border },
  itemTitle: { fontSize: 15, fontWeight: '800', color: C.ink },
  itemSub: { fontSize: 12, color: C.muted, marginTop: 2 },
  fitPill: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 9, paddingVertical: 4 },
  fitTx: { fontSize: 12, fontWeight: '800' },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8, marginBottom: 6 },
  tag: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#F1F5F9', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4, maxWidth: '100%' },
  tagTx: { fontSize: 11, color: C.muted, fontWeight: '600', flexShrink: 1 },
  strength: { fontSize: 12, color: '#047857', marginTop: 3 },
  gap: { fontSize: 12, color: '#B45309', marginTop: 3 },
  warn: { fontSize: 12, color: C.rose, marginTop: 6 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  btn: { borderWidth: 1, borderColor: C.border, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9, backgroundColor: '#fff', minHeight: 38, justifyContent: 'center' },
  btnPrimary: { backgroundColor: C.blue, borderColor: C.blue },
  btnTx: { fontSize: 12, fontWeight: '800', color: C.ink },
  btnTxPrimary: { color: '#fff' },
  note: { flexDirection: 'row', gap: 8, marginTop: 18, padding: 12, borderRadius: 14, backgroundColor: '#E2E8F0' },
  noteTx: { flex: 1, fontSize: 11, color: C.muted, lineHeight: 16 },
});
