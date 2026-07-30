// AI Hub — new feature. Safe to delete without affecting existing app.
//
// The redesigned Jobs tab: GROUP CARDS in the same horizontal square-card strip the company
// dashboard used. A group is a place + skills (or a country the résumé matches, or a pinned exact
// job URL). The first card is always "Tell us where and what". Selecting a card shows that group's
// jobs BELOW as the app's real detailed job cards (rendered by the parent via renderJob).
//
// ⚠️ The add-interest form is ONE top-level <Modal>, never nested inside another (build-87 lesson).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, Modal, ActivityIndicator, Alert, Platform,
  KeyboardAvoidingView, ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import {
  fetchInterests, createInterest, deleteInterest, fetchInterestJobs,
  fetchCountryOptions, fetchCityOptions, fetchSuggestedByCountry,
  type Interest, type InterestJob, type PlaceOption, type SuggestedGroup,
} from '../services/interestsService';

const T = {
  card: '#FFFFFF', ink: '#0B0F22', muted: '#5B6B8A', faint: '#8896B0',
  line: 'rgba(11,15,34,0.06)', blue: '#4F8DFF', blueDeep: '#2563EB', cyan: '#06B6D4', emerald: '#10B981',
};
const AV: [string, string][] = [['#06B6D4', '#3B82F6'], ['#3B82F6', '#7C6BFF'], ['#7C6BFF', '#EC4899'], ['#10B981', '#06B6D4'], ['#F59E0B', '#EF4444']];
export const gradFor = (s: string): [string, string] => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return AV[h % AV.length]; };
export const hashId = (s: string) => { let h = 0; const k = s || 'x'; for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0; return 'gj_' + h.toString(36); };

const hostOf = (u?: string | null) => { try { return u ? new URL(u).hostname.replace(/^www\./, '') : ''; } catch { return ''; } };

// Same job-detail hand-off the Explore feed uses (fallback when the parent gives no renderJob).
function openJob(router: ReturnType<typeof useRouter>, j: InterestJob) {
  const job = {
    id: hashId(j.job_url || j.id), title: j.title, location: j.location || 'Not specified',
    experience: j.experience || '', salary: j.salary || '', jobType: j.job_type || '',
    workMode: j.work_mode || null, urgent: false, skills: Array.isArray(j.skills) ? j.skills : [],
    responsibilities: Array.isArray(j.responsibilities) ? j.responsibilities : [], contacts: [],
    applyUrl: j.job_url, matchScore: null,
  };
  const name = j.employer_name || 'Company';
  const employer = {
    id: 'g_' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name, subInfo: [j.location, j.country].filter(Boolean).join(' · ') || 'Live opening',
    logoColor: gradFor(name), logoInitial: (name[0] || '?').toUpperCase(), domain: j.employer_domain || '',
  };
  router.push({ pathname: '/(ai-hub)/job-detail', params: { jobStr: JSON.stringify(job), employerStr: JSON.stringify(employer) } });
}

// ── One square strip card, visually identical to the company bookmark cards ──────────────────────
function GroupCard({ icon, title, sub, count, selected, grad, onPress, onRemove }: {
  icon: keyof typeof Ionicons.glyphMap; title: string; sub?: string; count: number;
  selected: boolean; grad: [string, string]; onPress: () => void; onRemove?: () => void;
}) {
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85} style={[s.gcWrap, selected && s.gcWrapSelected]}>
      {selected && (
        <LinearGradient colors={[T.blue, '#7C6BFF']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.gcRing} />
      )}
      <View style={s.gcInner}>
        <Text style={s.gcWatermark} numberOfLines={1}>{title.replace(/\s+/g, '').slice(0, 4).toUpperCase()}</Text>
        {!!onRemove && (
          <TouchableOpacity
            style={s.gcDeleteBtn}
            onPress={(e: any) => { e?.stopPropagation?.(); onRemove(); }}
            activeOpacity={0.7}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
          >
            <Ionicons name="close" size={12} color="rgba(255,255,255,0.7)" />
          </TouchableOpacity>
        )}
        <LinearGradient colors={grad} style={s.gcLogo}>
          <Ionicons name={icon} size={22} color="#fff" />
        </LinearGradient>
        <Text style={s.gcName} numberOfLines={2} ellipsizeMode="tail">{title}</Text>
        {!!sub && <Text style={s.gcSub} numberOfLines={1}>{sub}</Text>}
        <View style={s.gcRow}>
          <Ionicons name="briefcase-outline" size={11} color="#22D3EE" />
          <Text style={s.gcStat}>{count}</Text>
          <Text style={s.gcStatLbl}>jobs</Text>
        </View>
        {selected && (
          <View style={s.gcTick}>
            <Ionicons name="checkmark" size={11} color="#fff" />
          </View>
        )}
      </View>
    </TouchableOpacity>
  );
}

type Selected = { kind: 'interest'; id: number } | { kind: 'suggested'; country: string } | null;

export default function InterestBoard({
  addOpen, onAddClose, onRequestAdd, renderJob, onStats,
}: {
  addOpen: boolean;                       // parent's + button opens the form
  onAddClose: () => void;
  onRequestAdd?: () => void;              // the first strip card opens the form too
  renderJob?: (job: InterestJob) => React.ReactNode;   // parent renders the app's detailed job card
  onStats?: (s: { groups: number; jobs: number; pinned: number }) => void;   // hero summary
}) {
  const router = useRouter();
  const [items, setItems] = useState<Interest[]>([]);
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState<Selected>(null);
  const userCleared = useRef(false);        // explicit deselect must not be undone by auto-select
  const selectNewest = useRef(false);       // after a save, jump to the freshly created card
  const [jobs, setJobs] = useState<Record<number, { jobs: InterestJob[]; total: number; loading: boolean; pendingUrl?: boolean; urlFailed?: boolean; failed?: boolean }>>({});
  // add form — dropdown-driven places + chip-based skills + optional exact job URL
  const [country, setCountry] = useState('');
  const [city, setCity] = useState('');
  const [skillChips, setSkillChips] = useState<string[]>([]);
  const [skillInput, setSkillInput] = useState('');
  const [jobUrl, setJobUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [countryOpts, setCountryOpts] = useState<PlaceOption[]>([]);
  const [cityOpts, setCityOpts] = useState<PlaceOption[]>([]);
  const [picker, setPicker] = useState<'country' | 'city' | null>(null);
  const [pickerFilter, setPickerFilter] = useState('');

  // Preload country options at MOUNT (not first open) so the picker is instant; retry on open if
  // the first fetch failed. City options follow the chosen country, with a visible loading state.
  const [cityLoading, setCityLoading] = useState(false);
  useEffect(() => { fetchCountryOptions().then(setCountryOpts).catch(() => {}); }, []);
  useEffect(() => {
    if (!addOpen) { setPicker(null); return; }
    if (!countryOpts.length) fetchCountryOptions().then(setCountryOpts).catch(() => {});
  }, [addOpen]);
  useEffect(() => {
    setCity(''); setCityOpts([]);
    if (country) {
      setCityLoading(true);
      fetchCityOptions(country).then(setCityOpts).catch(() => {}).finally(() => setCityLoading(false));
    }
  }, [country]);

  // chips: comma or Enter turns the typed text into a chip
  const commitSkill = useCallback((raw?: string) => {
    const t = String(raw != null ? raw : skillInput).trim().replace(/,+$/, '');
    if (!t) return;
    setSkillChips((prev) => (prev.some((s) => s.toLowerCase() === t.toLowerCase()) || prev.length >= 8) ? prev : [...prev, t]);
    setSkillInput('');
  }, [skillInput]);
  const onSkillChange = useCallback((v: string) => {
    if (v.includes(',')) {
      const parts = v.split(',');
      parts.slice(0, -1).forEach((p) => commitSkill(p));
      setSkillInput(parts[parts.length - 1]);
    } else setSkillInput(v);
  }, [commitSkill]);

  // Nothing saved yet → best-matched jobs from the directory, grouped by country (résumé skills).
  const [suggested, setSuggested] = useState<SuggestedGroup[]>([]);
  const [suggestedNote, setSuggestedNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await fetchInterests();
      setItems(list);
      if (list.length === 0) {
        try {
          const sug = await fetchSuggestedByCountry();
          setSuggested(sug.groups);
          setSuggestedNote(sug.noResume ? 'Upload your résumé and this fills with jobs matched to your skills.' : (sug.skills && sug.skills.length ? `Matched to your skills: ${sug.skills.slice(0, 3).join(', ')}` : null));
          onStats?.({ groups: sug.groups.length, jobs: sug.groups.reduce((s, g) => s + (g.total || 0), 0), pinned: 0 });
        } catch { setSuggested([]); onStats?.({ groups: 0, jobs: 0, pinned: 0 }); }
      } else {
        setSuggested([]);
        onStats?.({
          groups: list.length,
          jobs: list.reduce((s, i) => s + (i.jobCount || 0), 0),
          pinned: list.filter((i) => !!i.jobUrl).length,
        });
      }
    } catch {} finally { setLoading(false); }
  }, [onStats]);
  useEffect(() => { load(); }, [load]);

  const loadJobsFor = useCallback(async (id: number, force = false) => {
    // pendingUrl / error results are NOT warm cache — re-selecting the card must retry them,
    // otherwise "re-open this card" would be a lie and one transient failure sticks all session.
    const c = jobs[id];
    if (!force && c && !c.pendingUrl && !c.failed) return;
    setJobs((p) => ({ ...p, [id]: { jobs: p[id]?.jobs || [], total: p[id]?.total || 0, loading: true } }));
    try {
      const r = await fetchInterestJobs(id);
      setJobs((p) => ({ ...p, [id]: { ...r, loading: false } }));
    } catch {
      setJobs((p) => ({ ...p, [id]: { jobs: [], total: 0, loading: false, failed: true } }));
    }
  }, [jobs]);

  const selectInterest = useCallback((id: number) => {
    if (sel?.kind === 'interest' && sel.id === id) { userCleared.current = true; setSel(null); return; }
    userCleared.current = false;
    setSel({ kind: 'interest', id });
    loadJobsFor(id);
  }, [sel, loadJobsFor]);

  const selectSuggested = useCallback((c: string) => {
    if (sel?.kind === 'suggested' && sel.country === c) { userCleared.current = true; setSel(null); return; }
    userCleared.current = false;
    setSel({ kind: 'suggested', country: c });
  }, [sel]);

  // Keep the selection valid, jump to a freshly created card, and auto-select the first group so
  // the tab never opens onto an empty jobs area.
  useEffect(() => {
    if (loading) return;
    if (selectNewest.current && items.length) {
      selectNewest.current = false;
      userCleared.current = false;
      setSel({ kind: 'interest', id: items[0].id });   // list is newest-first
      loadJobsFor(items[0].id, true);
      return;
    }
    if (sel?.kind === 'interest' && !items.some((i) => i.id === sel.id)) { setSel(null); return; }
    if (sel?.kind === 'suggested' && !suggested.some((g) => g.country === sel.country)) { setSel(null); return; }
    if (!sel && !userCleared.current) {
      if (items.length) { setSel({ kind: 'interest', id: items[0].id }); loadJobsFor(items[0].id); }
      else if (suggested.length) setSel({ kind: 'suggested', country: suggested[0].country });
    }
  }, [loading, items, suggested, sel, loadJobsFor]);

  const save = useCallback(async () => {
    const sk = [...skillChips, ...(skillInput.trim() ? [skillInput.trim()] : [])];
    const url = jobUrl.trim();
    const hasUrl = /^https?:\/\/\S+$/i.test(url);
    if (url && !hasUrl) { Alert.alert('Check the job URL', 'It should start with http:// or https://.'); return; }
    if (!hasUrl && !country) { Alert.alert('Missing country', 'Pick the country you want jobs in — or paste an exact job URL instead.'); return; }
    if (!hasUrl && !sk.length) { Alert.alert('Missing skills', 'Add at least one skill or role — e.g. "plumber" or "react".'); return; }
    setSaving(true);
    try {
      const ok = await createInterest({
        country: country || undefined, city: city || undefined,
        skills: sk.length ? sk : undefined, jobUrl: hasUrl ? url : undefined,
      });
      if (ok) {
        setCountry(''); setCity(''); setSkillChips([]); setSkillInput(''); setJobUrl('');
        selectNewest.current = true;
        onAddClose(); load();
      } else Alert.alert('Could not save', 'Please try again.');
    } catch (e: any) {
      Alert.alert('Could not save', e?.response?.data?.error || 'Please try again.');
    } finally { setSaving(false); }
  }, [country, city, skillChips, skillInput, jobUrl, onAddClose, load]);

  const remove = useCallback((it: Interest) => {
    Alert.alert('Remove this card?', `${it.label} — job alerts for it stop too.`, [
      { text: 'Keep', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: async () => { try { await deleteInterest(it.id); load(); } catch {} } },
    ]);
  }, [load]);

  const cardTitle = (it: Interest) =>
    it.city ? `${it.city}, ${it.country}` : (it.country || hostOf(it.jobUrl) || it.label);
  const cardSub = (it: Interest) =>
    it.skills.length ? it.skills.join(' · ') : (it.jobUrl ? 'Pinned job' : '');

  const selInterest = sel?.kind === 'interest' ? items.find((i) => i.id === sel.id) : undefined;
  const selGroup = sel?.kind === 'suggested' ? suggested.find((g) => g.country === sel.country) : undefined;
  const selJobs = sel?.kind === 'interest' ? jobs[sel.id] : undefined;

  const renderOne = (job: InterestJob) =>
    renderJob ? (
      <React.Fragment key={job.job_url || job.id}>{renderJob(job)}</React.Fragment>
    ) : (
      <TouchableOpacity key={job.job_url || job.id} style={s.jobRow} activeOpacity={0.85} onPress={() => openJob(router, job)}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.jobTitle} numberOfLines={2}>{job.title}</Text>
          <Text style={s.jobMeta} numberOfLines={1}>{[job.employer_name, job.location].filter(Boolean).join(' · ')}</Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color={T.faint} />
      </TouchableOpacity>
    );

  return (
    <View style={s.wrap}>
      {/* ── Horizontal square-card strip — the add card is ALWAYS first ── */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={s.stripScroll}
        contentContainerStyle={s.strip}
      >
        <TouchableOpacity style={s.addSq} activeOpacity={0.85} onPress={() => (onRequestAdd ? onRequestAdd() : undefined)}>
          <LinearGradient colors={[T.blue, T.blueDeep]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.addSqLogo}>
            <Ionicons name="add" size={24} color="#fff" />
          </LinearGradient>
          <Text style={s.addSqTitle}>Tell us where{'\n'}and what</Text>
          <Text style={s.addSqSub}>or paste a job URL</Text>
        </TouchableOpacity>

        {items.map((it) => (
          <GroupCard
            key={it.id}
            icon={it.skills.length ? 'location' : 'link'}
            title={cardTitle(it)}
            sub={cardSub(it)}
            count={it.jobCount}
            selected={sel?.kind === 'interest' && sel.id === it.id}
            grad={gradFor(it.label || it.country || String(it.id))}
            onPress={() => selectInterest(it.id)}
            onRemove={() => remove(it)}
          />
        ))}

        {items.length === 0 && suggested.map((g) => (
          <GroupCard
            key={g.country}
            icon="earth"
            title={g.country}
            sub="Matched to you"
            count={g.total}
            selected={sel?.kind === 'suggested' && sel.country === g.country}
            grad={gradFor(g.country)}
            onPress={() => selectSuggested(g.country)}
          />
        ))}
      </ScrollView>

      {loading ? (
        <ActivityIndicator color={T.blue} style={{ marginVertical: 26 }} />
      ) : (
        <>
          {!!suggestedNote && items.length === 0 && <Text style={s.suggNote}>{suggestedNote}</Text>}

          {/* ── Jobs for the selected group, as the app's real detailed job cards ── */}
          {selInterest && (
            <View style={s.jobsArea}>
              <View style={s.jobsHead}>
                <Text style={s.jobsHeadCount}>
                  {selJobs && !selJobs.loading ? `${selJobs.total} ${selJobs.total === 1 ? 'job' : 'jobs'}` : ' '}
                </Text>
                <Text style={s.jobsHeadLabel} numberOfLines={1}>{selInterest.label}</Text>
              </View>
              {!selJobs || selJobs.loading ? (
                <ActivityIndicator color={T.blue} style={{ marginVertical: 22 }} />
              ) : selJobs.jobs.length === 0 ? (
                <Text style={s.noJobs}>
                  {selJobs.pendingUrl
                    ? 'Fetching that exact job for you now — tap this card again in a minute to check.'
                    : selJobs.urlFailed
                    ? 'We couldn’t fetch this job — the link may be behind a login or blocking us. Check it opens in a normal browser, or add skills + a place instead.'
                    : selJobs.failed
                    ? 'Couldn’t load right now — tap this card again to retry.'
                    : 'Nothing in the directory yet — our researcher hunts for this twice a day, and you’ll get a notification when matches land.'}
                </Text>
              ) : (
                <>
                  {selJobs.jobs.map(renderOne)}
                  {selJobs.total > selJobs.jobs.length && (
                    <Text style={s.moreNote}>{selJobs.total - selJobs.jobs.length} more in Search → filter by {selInterest.country}</Text>
                  )}
                </>
              )}
            </View>
          )}

          {selGroup && (
            <View style={s.jobsArea}>
              <View style={s.jobsHead}>
                <Text style={s.jobsHeadCount}>{selGroup.total} {selGroup.total === 1 ? 'job' : 'jobs'}</Text>
                <Text style={s.jobsHeadLabel} numberOfLines={1}>{selGroup.country} · matched to your résumé</Text>
              </View>
              {selGroup.jobs.map(renderOne)}
              {selGroup.total > selGroup.jobs.length && (
                <Text style={s.moreNote}>{selGroup.total - selGroup.jobs.length} more in Search → filter by {selGroup.country}</Text>
              )}
            </View>
          )}

          {!sel && !items.length && !suggested.length && !!suggestedNote && (
            <Text style={s.suggNote}>{suggestedNote}</Text>
          )}
        </>
      )}

      {/* ── Add-interest form — ONE top-level modal. The sheet has a FIXED height and the picker
             REPLACES the form content (back arrow returns), so nothing stretches or jumps while
             choosing a country/city. ── */}
      <Modal visible={addOpen} transparent animationType="slide" onRequestClose={() => { if (picker) setPicker(null); else onAddClose(); }}>
        <KeyboardAvoidingView
          style={s.sheetOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={onAddClose} />
          <View style={s.sheet}>
            {picker ? (
              /* ── PICKER PAGE — fills the whole sheet, zero reflow ── */
              <View style={{ flex: 1 }}>
                <View style={s.sheetHead}>
                  <TouchableOpacity onPress={() => setPicker(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} style={{ marginRight: 10 }}>
                    <Ionicons name="arrow-back" size={22} color={T.ink} />
                  </TouchableOpacity>
                  <Text style={s.sheetTitle}>{picker === 'country' ? 'Choose a country' : `City in ${country}`}</Text>
                  <TouchableOpacity onPress={onAddClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                    <Ionicons name="close" size={22} color={T.muted} />
                  </TouchableOpacity>
                </View>
                <View style={s.searchWrap}>
                  <Ionicons name="search" size={15} color={T.faint} />
                  <TextInput
                    value={pickerFilter} onChangeText={setPickerFilter}
                    placeholder={picker === 'country' ? 'Search countries…' : 'Search cities…'}
                    placeholderTextColor={T.faint} style={s.searchInput} autoCapitalize="none" autoCorrect={false}
                  />
                </View>
                <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled">
                  {picker === 'city' && !cityLoading && (
                    <TouchableOpacity style={s.pickerRow} onPress={() => { setCity(''); setPicker(null); }}>
                      <Text style={s.pickerRowText}>Any city</Text>
                      {!city && <Ionicons name="checkmark" size={16} color={T.emerald} />}
                    </TouchableOpacity>
                  )}
                  {(picker === 'city' && cityLoading) ? (
                    <View style={s.pickerLoading}><ActivityIndicator color={T.blue} /><Text style={s.pickerEmpty}>Loading cities…</Text></View>
                  ) : (
                    (picker === 'country' ? countryOpts : cityOpts)
                      .filter((o) => !pickerFilter || o.name.toLowerCase().includes(pickerFilter.toLowerCase()))
                      .map((o) => {
                        const selected = picker === 'country' ? country === o.name : city === o.name;
                        return (
                          <TouchableOpacity
                            key={o.name} style={s.pickerRow}
                            onPress={() => { if (picker === 'country') setCountry(o.name); else setCity(o.name); setPicker(null); setPickerFilter(''); }}
                          >
                            <Text style={[s.pickerRowText, selected && { color: T.blueDeep }]}>{o.name}</Text>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                              <Text style={s.pickerRowN}>{o.jobs} jobs</Text>
                              {selected && <Ionicons name="checkmark" size={16} color={T.emerald} />}
                            </View>
                          </TouchableOpacity>
                        );
                      })
                  )}
                  {picker === 'country' && countryOpts.length === 0 && (
                    <View style={s.pickerLoading}><ActivityIndicator color={T.blue} /><Text style={s.pickerEmpty}>Loading countries…</Text></View>
                  )}
                  {picker === 'city' && !cityLoading && cityOpts.length === 0 && (
                    <Text style={s.pickerEmpty}>No city breakdown for {country} yet — "Any city" covers the whole country.</Text>
                  )}
                  <View style={{ height: 20 }} />
                </ScrollView>
              </View>
            ) : (
            /* ── FORM PAGE ── */
            <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            <View style={s.sheetHead}>
              <Text style={s.sheetTitle}>What jobs should we watch for?</Text>
              <TouchableOpacity onPress={onAddClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color={T.muted} />
              </TouchableOpacity>
            </View>

            {/* COUNTRY */}
            <Text style={s.label}>COUNTRY *</Text>
            <TouchableOpacity style={s.select} activeOpacity={0.8} onPress={() => { setPicker('country'); setPickerFilter(''); }}>
              <Text style={[s.selectText, !country && { color: T.faint }]}>{country || 'Choose a country'}</Text>
              <Ionicons name="chevron-forward" size={16} color={T.faint} />
            </TouchableOpacity>

            {/* CITY */}
            <Text style={s.label}>CITY (OPTIONAL — ITS JOBS RANK FIRST)</Text>
            <TouchableOpacity
              style={[s.select, !country && { opacity: 0.5 }]}
              activeOpacity={0.8}
              disabled={!country}
              onPress={() => { setPicker('city'); setPickerFilter(''); }}
            >
              <Text style={[s.selectText, !city && { color: T.faint }]}>{city || (country ? 'Any city' : 'Pick a country first')}</Text>
              <Ionicons name="chevron-forward" size={16} color={T.faint} />
            </TouchableOpacity>

            {/* SKILLS as chips: comma or return adds a card */}
            <Text style={s.label}>SKILLS OR ROLES *</Text>
            <View style={s.chipBox}>
              {skillChips.map((c) => (
                <View key={c} style={s.chip}>
                  <Text style={s.chipText}>{c}</Text>
                  <TouchableOpacity onPress={() => setSkillChips((prev) => prev.filter((x) => x !== c))} hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}>
                    <Ionicons name="close-circle" size={15} color={T.blueDeep} />
                  </TouchableOpacity>
                </View>
              ))}
              <TextInput
                value={skillInput}
                onChangeText={onSkillChange}
                onSubmitEditing={() => commitSkill()}
                blurOnSubmit={false}
                placeholder={skillChips.length ? 'Add another…' : 'e.g. react — or plumber'}
                placeholderTextColor={T.faint}
                style={s.chipInput}
                autoCapitalize="none"
                returnKeyType="done"
              />
            </View>
            <Text style={s.infoLine}>
              <Ionicons name="information-circle-outline" size={12} color={T.faint} /> Type a skill and press return (or a comma) to add it as a card — up to 8. We research these for you twice a day.
            </Text>

            {/* EXACT JOB URL — the "fetch just this job" field */}
            <Text style={s.label}>EXACT JOB URL (OPTIONAL)</Text>
            <View style={s.urlBox}>
              <Ionicons name="link-outline" size={15} color={T.faint} />
              <TextInput
                value={jobUrl}
                onChangeText={setJobUrl}
                placeholder="https:// — paste a posting to fetch just that job"
                placeholderTextColor={T.faint}
                style={s.urlInput}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />
            </View>
            <Text style={s.infoLine}>
              <Ionicons name="information-circle-outline" size={12} color={T.faint} /> Have a specific posting in mind? Paste its URL and we fetch that exact job — with a URL you can even skip country and skills.
            </Text>

            <TouchableOpacity style={[s.saveBtn, saving && { opacity: 0.6 }]} onPress={save} disabled={saving} activeOpacity={0.9}>
              <LinearGradient colors={[T.blue, T.blueDeep]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={s.saveGrad}>
                {saving ? <ActivityIndicator color="#fff" size="small" /> : <Text style={s.saveText}>Start watching</Text>}
              </LinearGradient>
            </TouchableOpacity>
            <View style={{ height: 12 }} />
            </ScrollView>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { marginBottom: 8 },

  // ── Square-card strip (same look as the company bookmark cards) ──
  stripScroll: { marginBottom: 12 },
  strip: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 6, paddingHorizontal: 2 },
  gcWrap: {
    width: 130, alignSelf: 'flex-start', borderRadius: 20, backgroundColor: T.card,
    shadowColor: T.ink, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.09, shadowRadius: 14,
    elevation: 5, padding: 2,
  },
  gcWrapSelected: { shadowOpacity: 0.18, shadowRadius: 20, elevation: 10 },
  gcRing: { ...StyleSheet.absoluteFillObject, borderRadius: 20 },
  gcInner: {
    backgroundColor: '#0D1230', borderRadius: 18, paddingVertical: 16, paddingHorizontal: 12,
    alignItems: 'center', gap: 7, overflow: 'hidden',
  },
  gcWatermark: {
    position: 'absolute', bottom: -8, right: -4, fontSize: 52, fontWeight: '900',
    color: 'rgba(255,255,255,0.045)', letterSpacing: -2,
  },
  gcLogo: { width: 48, height: 48, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  gcName: {
    fontSize: 13, fontWeight: '700', color: '#fff', letterSpacing: -0.3, textAlign: 'center',
    lineHeight: 18, maxHeight: 36,
  },
  gcSub: { fontSize: 10.5, fontWeight: '600', color: 'rgba(255,255,255,0.55)', maxWidth: 104, textAlign: 'center' },
  gcRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  gcStat: { fontSize: 12, fontWeight: '700', color: '#22D3EE' },
  gcStatLbl: { fontSize: 10, fontWeight: '600', color: 'rgba(255,255,255,0.45)' },
  gcTick: {
    position: 'absolute', top: 8, right: 8, width: 18, height: 18, borderRadius: 9,
    backgroundColor: T.blue, alignItems: 'center', justifyContent: 'center',
  },
  gcDeleteBtn: {
    position: 'absolute', top: 7, left: 7, width: 20, height: 20, borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.12)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center', justifyContent: 'center', zIndex: 10,
  },

  // ── The always-first add card (square, dashed) ──
  addSq: {
    width: 130, alignSelf: 'stretch', borderRadius: 20, borderWidth: 1.5, borderStyle: 'dashed',
    borderColor: 'rgba(79,141,255,0.45)', backgroundColor: 'rgba(79,141,255,0.06)',
    paddingVertical: 18, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center', gap: 7,
  },
  addSqLogo: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  addSqTitle: { fontSize: 12.5, fontWeight: '800', color: T.blueDeep, textAlign: 'center', lineHeight: 16 },
  addSqSub: { fontSize: 10, fontWeight: '600', color: T.faint, textAlign: 'center' },

  suggNote: { fontSize: 11.5, color: T.faint, fontWeight: '600', marginBottom: 9, marginLeft: 2 },

  // ── Jobs area under the strip ──
  jobsArea: { marginTop: 2 },
  jobsHead: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginBottom: 8, marginLeft: 2 },
  jobsHeadCount: { fontSize: 14, fontWeight: '800', color: T.ink, letterSpacing: -0.2 },
  jobsHeadLabel: { flex: 1, fontSize: 11.5, fontWeight: '600', color: T.faint },
  noJobs: { fontSize: 12, color: T.faint, lineHeight: 17, paddingVertical: 10, paddingHorizontal: 2 },
  moreNote: { fontSize: 11, color: T.faint, fontWeight: '600', paddingVertical: 9, textAlign: 'center' },
  // fallback simple rows (used only when the parent passes no renderJob)
  jobRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: T.line },
  jobTitle: { fontSize: 13, fontWeight: '700', color: T.ink, lineHeight: 18 },
  jobMeta: { fontSize: 11.5, color: T.muted, marginTop: 2 },

  // ── Add-interest sheet ──
  sheetOverlay: { flex: 1, backgroundColor: 'rgba(6,10,25,0.5)', justifyContent: 'flex-end' },
  // FIXED height: opening the picker or the keyboard swaps/scrolls content INSIDE the sheet —
  // the sheet itself never grows or jumps (that reflow was the "moving and expanding" complaint).
  sheet: { backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 18, paddingBottom: Platform.OS === 'ios' ? 30 : 16, height: 600, maxHeight: '88%' },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  searchWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#F4F7FC', borderWidth: 1, borderColor: T.line, borderRadius: 13, paddingHorizontal: 12, height: 42, marginBottom: 8 },
  searchInput: { flex: 1, fontSize: 13.5, color: T.ink, paddingVertical: 0 },
  pickerLoading: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 13 },
  sheetTitle: { fontSize: 16.5, fontWeight: '800', color: T.ink, letterSpacing: -0.2, flex: 1 },
  label: { fontSize: 10, fontWeight: '800', color: T.faint, letterSpacing: 0.8, marginTop: 10, marginBottom: 5 },
  select: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#F4F7FC', borderWidth: 1, borderColor: T.line, borderRadius: 13, paddingHorizontal: 13, height: 46 },
  selectText: { fontSize: 14, color: T.ink, fontWeight: '600' },
  pickerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 13, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: T.line },
  pickerRowText: { fontSize: 13.5, color: T.ink, fontWeight: '600' },
  pickerRowN: { fontSize: 11, color: T.faint, fontWeight: '700' },
  pickerEmpty: { fontSize: 12, color: T.faint, padding: 13 },
  chipBox: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, backgroundColor: '#F4F7FC', borderWidth: 1, borderColor: T.line, borderRadius: 13, paddingHorizontal: 9, paddingVertical: 7, minHeight: 46 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(79,141,255,0.12)', borderWidth: 1, borderColor: 'rgba(79,141,255,0.3)', borderRadius: 100, paddingLeft: 11, paddingRight: 7, paddingVertical: 6 },
  chipText: { fontSize: 12.5, fontWeight: '700', color: T.blueDeep },
  chipInput: { flexGrow: 1, minWidth: 110, fontSize: 13.5, color: T.ink, paddingVertical: 4 },
  urlBox: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#F4F7FC', borderWidth: 1, borderColor: T.line, borderRadius: 13, paddingHorizontal: 12, height: 46 },
  urlInput: { flex: 1, fontSize: 13.5, color: T.ink, paddingVertical: 0 },
  infoLine: { fontSize: 11, color: T.faint, lineHeight: 16, marginTop: 6, marginLeft: 2 },
  saveBtn: { marginTop: 16, borderRadius: 14, overflow: 'hidden' },
  saveGrad: { height: 50, alignItems: 'center', justifyContent: 'center' },
  saveText: { color: '#fff', fontSize: 15, fontWeight: '800' },
});
