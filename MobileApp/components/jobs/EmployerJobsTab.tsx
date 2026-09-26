// AI Hub — new feature. Safe to delete without affecting existing app.
//
// "Find job" → BY EMPLOYER. The other tab asks Google what exists; this one starts from the company:
// type a name, pick it (with its website — the same free lookup the Add-employer sheet on Home uses,
// GET /discover/employers), and the server says where that employer actually lists its jobs —
// their openings on whatever ATS they use, their careers page, or career URLs from their sitemap
// (GET /discover/employer-pages, services/careerPages.js). Tapping one opens it in the SAME in-app
// browser a Google result opens in, so "Fetch job" works exactly as it does today.
//
// ⚠️ NOTHING HERE COSTS ANYTHING AND NOTHING IS SAVED. Both endpoints are reads. Picking an employer
// does NOT track it, does NOT research it and does NOT build anything — that is Home's flow, which
// charges, and forking a paid path in two is how one gets charged twice. This tab only finds a page
// and hands its URL to the browser.
//
// ⚠️ A PAGE IS ONLY OFFERED WHEN THE SERVER FOUND IT. No guessed /careers URL is ever shown as a
// result: the user would tap it and land on a 404 that looks like our mistake. When the lookup finds
// nothing, the employer's own website is offered instead, which is honest and still useful.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, ScrollView, Keyboard,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as SecureStore from 'expo-secure-store';
import { API_BASE } from '../../config';

export type EmployerHit = { name: string; website: string; location?: string | null; jobs?: number };
export type EmployerPage = { url: string; label: string; kind: 'openings' | 'careers' | 'job'; source: string };

const T = {
  ink: '#0B1120', muted: '#5B6B8A', faint: '#8896B0',
  surface: '#FFFFFF', border: 'rgba(11,17,32,0.08)', field: '#F4F7FB',
  cyan: '#06B6D4', blue: '#3B82F6', violet: '#7C6BFF', emerald: '#10B981',
};

const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

async function authHeader(): Promise<Record<string, string>> {
  try {
    const tok = JSON.parse((await SecureStore.getItemAsync('userSession')) || '{}')?.token;
    return tok ? { Authorization: `Bearer ${tok}` } : {};
  } catch { return {}; }
}

/** The employer lookup — name in, company + website out. Website-only: a name alone opens nothing. */
async function searchEmployers(q: string, signal: AbortSignal): Promise<EmployerHit[]> {
  const r = await fetch(`${API_BASE}/discover/employers?q=${encodeURIComponent(q)}&limit=10`,
    { headers: await authHeader(), signal });
  if (!r.ok) throw new Error(`employers_${r.status}`);
  const j = await r.json();
  if (!Array.isArray(j?.employers)) throw new Error('employers_shape');
  return j.employers
    .map((e: any) => {
      const domain = String(e?.website || e?.domain || '').trim();
      const website = domain ? (/^https?:\/\//i.test(domain) ? domain : `https://${domain}`) : '';
      return { name: String(e?.name || '').trim(), website, location: e?.location || null, jobs: Number(e?.jobs) || 0 };
    })
    .filter((e: EmployerHit) => e.name && e.website)
    .slice(0, 10);
}

/** Where that employer lists its jobs. Never throws — an empty list is an answer the caller can show. */
async function employerPages(site: string, signal: AbortSignal): Promise<{ pages: EmployerPage[]; reason: string | null }> {
  try {
    const r = await fetch(`${API_BASE}/discover/employer-pages?site=${encodeURIComponent(site)}&limit=8`,
      { headers: await authHeader(), signal });
    if (!r.ok) return { pages: [], reason: 'unreachable' };
    const j = await r.json();
    const pages: EmployerPage[] = Array.isArray(j?.pages)
      ? j.pages.filter((p: any) => p && typeof p.url === 'string' && /^https?:\/\//i.test(p.url)).slice(0, 8)
      : [];
    return { pages, reason: pages.length ? null : String(j?.reason || 'nothing_found') };
  } catch { return { pages: [], reason: 'unreachable' }; }
}

const ICON: Record<EmployerPage['kind'], { name: any; color: string }> = {
  openings: { name: 'list-outline', color: T.emerald },
  careers: { name: 'business-outline', color: T.blue },
  job: { name: 'document-text-outline', color: T.violet },
};
const KIND_TX: Record<EmployerPage['kind'], string> = {
  openings: 'Current openings', careers: 'Careers page', job: 'A posting',
};

export default function EmployerJobsTab({ onOpen, maxH }: { onOpen: (url: string) => void; maxH: number }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<EmployerHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);

  const [picked, setPicked] = useState<EmployerHit | null>(null);
  const [pages, setPages] = useState<EmployerPage[]>([]);
  const [pagesReason, setPagesReason] = useState<string | null>(null);
  const [loadingPages, setLoadingPages] = useState(false);

  const searchCtl = useRef<AbortController | null>(null);
  const pagesCtl = useRef<AbortController | null>(null);
  const alive = useRef(true);
  useEffect(() => () => {
    alive.current = false;
    searchCtl.current?.abort(); pagesCtl.current?.abort();
  }, []);

  // Typing searches on a debounce; an employer already picked is left alone until the text changes.
  useEffect(() => {
    const term = q.trim();
    searchCtl.current?.abort();
    if (term.length < 2) { setHits([]); setSearching(false); setSearchErr(null); return; }
    const ctl = new AbortController();
    searchCtl.current = ctl;
    setSearching(true); setSearchErr(null);
    const t = setTimeout(async () => {
      try {
        const found = await searchEmployers(term, ctl.signal);
        if (!alive.current || ctl.signal.aborted) return;
        setHits(found);
        // ⚠️ An empty list is "we did not find it", never "this company has no website".
        setSearchErr(found.length ? null : 'no_match');
      } catch (e: any) {
        if (!alive.current || ctl.signal.aborted || e?.name === 'AbortError') return;
        setHits([]); setSearchErr('unavailable');
      } finally {
        if (alive.current && !ctl.signal.aborted) setSearching(false);
      }
    }, 350);
    return () => { clearTimeout(t); };
  }, [q]);

  const pick = useCallback(async (hit: EmployerHit) => {
    Keyboard.dismiss();
    pagesCtl.current?.abort();
    const ctl = new AbortController();
    pagesCtl.current = ctl;
    setPicked(hit); setPages([]); setPagesReason(null); setLoadingPages(true);
    const out = await employerPages(hit.website, ctl.signal);
    if (!alive.current || ctl.signal.aborted) return;
    setPages(out.pages); setPagesReason(out.reason); setLoadingPages(false);
  }, []);

  const back = useCallback(() => {
    pagesCtl.current?.abort();
    setPicked(null); setPages([]); setPagesReason(null); setLoadingPages(false);
  }, []);

  // ── the pages of one employer ──────────────────────────────────────────────────────────────
  if (picked) {
    return (
      <ScrollView style={{ maxHeight: maxH }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <TouchableOpacity style={s.backRow} onPress={back} activeOpacity={0.7}>
          <Ionicons name="chevron-back" size={16} color={T.muted} />
          <Text style={s.backTx}>Another employer</Text>
        </TouchableOpacity>

        <View style={s.pickedCard}>
          <View style={s.pickedIcon}><Ionicons name="business" size={15} color="#fff" /></View>
          <View style={{ flex: 1 }}>
            <Text style={s.pickedName} numberOfLines={1}>{picked.name}</Text>
            <Text style={s.pickedSite} numberOfLines={1}>{hostOf(picked.website)}</Text>
          </View>
        </View>

        {loadingPages ? (
          <View style={s.centreBox}>
            <ActivityIndicator color={T.cyan} />
            <Text style={s.centreTx}>Looking for their jobs page…</Text>
          </View>
        ) : pages.length ? (
          <View>
            <Text style={s.label}>Open one of these</Text>
            {pages.map((p) => (
              <TouchableOpacity key={p.url} style={s.pageRow} activeOpacity={0.8} onPress={() => onOpen(p.url)}>
                <View style={[s.pageIcon, { backgroundColor: `${ICON[p.kind].color}1A` }]}>
                  <Ionicons name={ICON[p.kind].name} size={15} color={ICON[p.kind].color} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={s.pageLabel} numberOfLines={1}>{p.label}</Text>
                  <Text style={s.pageMeta} numberOfLines={1}>{KIND_TX[p.kind]} · {hostOf(p.url)}</Text>
                </View>
                <Ionicons name="open-outline" size={16} color={T.faint} />
              </TouchableOpacity>
            ))}
            <Text style={s.hint}>Open the page, tap a job, then use the robot to fetch and save it.</Text>
          </View>
        ) : (
          <View>
            <View style={s.noteBox}>
              <Ionicons name="information-circle-outline" size={14} color={T.muted} />
              <Text style={s.noteTx}>
                {pagesReason === 'unreachable'
                  ? 'We could not read their website just now.'
                  : 'We could not find a jobs page on their website.'}
              </Text>
            </View>
            <TouchableOpacity style={s.pageRow} activeOpacity={0.8} onPress={() => onOpen(picked.website)}>
              <View style={[s.pageIcon, { backgroundColor: `${T.blue}1A` }]}>
                <Ionicons name="globe-outline" size={15} color={T.blue} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.pageLabel} numberOfLines={1}>Open {hostOf(picked.website)}</Text>
                <Text style={s.pageMeta} numberOfLines={1}>Their website · look for “Careers”</Text>
              </View>
              <Ionicons name="open-outline" size={16} color={T.faint} />
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    );
  }

  // ── search for the employer ────────────────────────────────────────────────────────────────
  return (
    <ScrollView style={{ maxHeight: maxH }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
      <Text style={s.label}>Employer</Text>
      <View style={s.fieldWrap}>
        <Ionicons name="business-outline" size={16} color={T.blue} />
        <TextInput
          value={q} onChangeText={setQ} placeholder="e.g. Nordex, Zalando, Infosys" placeholderTextColor={T.faint}
          style={s.input} autoCapitalize="words" autoCorrect={false} returnKeyType="search"
        />
        {searching ? <ActivityIndicator size="small" color={T.faint} />
          : !!q && (
            <TouchableOpacity onPress={() => setQ('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close-circle" size={16} color={T.faint} />
            </TouchableOpacity>
          )}
      </View>

      {hits.map((h) => (
        <TouchableOpacity key={`${h.name}:${h.website}`} style={s.hitRow} activeOpacity={0.8} onPress={() => pick(h)}>
          <View style={s.hitIcon}><Text style={s.hitInitial}>{(h.name[0] || '?').toUpperCase()}</Text></View>
          <View style={{ flex: 1 }}>
            <Text style={s.hitName} numberOfLines={1}>{h.name}</Text>
            <Text style={s.hitSite} numberOfLines={1}>{hostOf(h.website)}{h.location ? ` · ${h.location}` : ''}</Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={T.faint} />
        </TouchableOpacity>
      ))}

      {!searching && q.trim().length >= 2 && !hits.length && (
        <View style={s.noteBox}>
          <Ionicons name="information-circle-outline" size={14} color={T.muted} />
          <Text style={s.noteTx}>
            {searchErr === 'unavailable'
              ? 'The employer lookup is unavailable right now — try the other tab, or paste their website.'
              : 'No employer found by that name. Try their full name, or paste their website.'}
          </Text>
        </View>
      )}

      {/* A website typed straight in — the lookup is a convenience, not a gate. */}
      {q.trim().includes('.') && !q.trim().includes(' ') && (
        <TouchableOpacity
          style={s.pageRow} activeOpacity={0.8}
          onPress={() => pick({ name: q.trim(), website: /^https?:\/\//i.test(q.trim()) ? q.trim() : `https://${q.trim()}` })}
        >
          <View style={[s.pageIcon, { backgroundColor: `${T.violet}1A` }]}>
            <Ionicons name="link-outline" size={15} color={T.violet} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.pageLabel} numberOfLines={1}>Use {q.trim()}</Text>
            <Text style={s.pageMeta} numberOfLines={1}>Look for their jobs page</Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={T.faint} />
        </TouchableOpacity>
      )}

      {q.trim().length < 2 && (
        <Text style={s.hint}>
          Pick the employer and we’ll find where they list their jobs — their openings page, their careers page,
          or the jobs in their sitemap.
        </Text>
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  label: { fontSize: 11.5, fontWeight: '800', color: T.muted, letterSpacing: 0.4, textTransform: 'uppercase', marginTop: 12, marginBottom: 7 },
  fieldWrap: { flexDirection: 'row', alignItems: 'center', gap: 9, backgroundColor: T.field, borderRadius: 13, borderWidth: 1, borderColor: T.border, paddingHorizontal: 12, minHeight: 46 },
  input: { flex: 1, fontSize: 14.5, color: T.ink, paddingVertical: 10 },

  hitRow: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: T.surface, borderRadius: 13, borderWidth: 1, borderColor: T.border, paddingHorizontal: 12, paddingVertical: 11, marginTop: 8, minHeight: 56 },
  hitIcon: { width: 30, height: 30, borderRadius: 9, backgroundColor: 'rgba(59,130,246,0.12)', alignItems: 'center', justifyContent: 'center' },
  hitInitial: { fontSize: 13, fontWeight: '800', color: T.blue },
  hitName: { fontSize: 14, fontWeight: '700', color: T.ink },
  hitSite: { fontSize: 11.5, color: T.faint, marginTop: 2 },

  backRow: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 10 },
  backTx: { fontSize: 13, fontWeight: '700', color: T.muted },
  pickedCard: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: T.surface, borderRadius: 14, borderWidth: 1, borderColor: T.border, padding: 12 },
  pickedIcon: { width: 32, height: 32, borderRadius: 10, backgroundColor: T.blue, alignItems: 'center', justifyContent: 'center' },
  pickedName: { fontSize: 15, fontWeight: '800', color: T.ink },
  pickedSite: { fontSize: 11.5, color: T.faint, marginTop: 2 },

  pageRow: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: T.surface, borderRadius: 13, borderWidth: 1, borderColor: T.border, paddingHorizontal: 12, paddingVertical: 11, marginTop: 8, minHeight: 56 },
  pageIcon: { width: 30, height: 30, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  pageLabel: { fontSize: 14, fontWeight: '700', color: T.ink },
  pageMeta: { fontSize: 11.5, color: T.faint, marginTop: 2 },

  centreBox: { alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 28 },
  centreTx: { fontSize: 13, fontWeight: '600', color: T.muted },
  noteBox: { flexDirection: 'row', alignItems: 'flex-start', gap: 7, backgroundColor: 'rgba(91,107,138,0.08)', borderRadius: 12, padding: 11, marginTop: 10 },
  noteTx: { flex: 1, fontSize: 12.5, color: T.muted, lineHeight: 17 },
  hint: { fontSize: 12, color: T.faint, lineHeight: 17, marginTop: 12 },
});
