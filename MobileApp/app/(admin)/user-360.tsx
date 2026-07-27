// AI Hub — new feature. Safe to delete without affecting existing app.
//
// Admin-only NATIVE "User 360" screen — the in-app equivalent of public/admin-user-detail.html.
// Light theme (same C tokens as store-analytics / user-analytics / registered-users).
// Route: /(admin)/user-360?userId=N
//
// Everything about ONE user: profile, documents, résumé insight, every cover letter / saved job /
// application / credit spend / search, best-matching jobs, and one-tap notifications that reach a
// REAL phone. Wired to server/routes/adminUserOpsRoutes.js via the "Admin USER OPS" section of
// services/aiHubService.ts. This screen reads; the only writes are the two confirmed sends.
//
// Three things this file deliberately refuses to get wrong:
//   1. `activity.applications` is a UNION of two records of the SAME act, so the bare total is NOT
//      "applications made" — the server's meta.note / meta.sources are rendered verbatim.
//   2. An unedited title/body is sent as NO override, so the server personalises it per user; only
//      copy the admin actually changed goes over as an override. The confirm sheet says which.
//   3. A send can be BLOCKED and still answer success:true. Blocked is reported distinctly and
//      NEVER gets a green tick — delivered ⇔ push.ok === true.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  SafeAreaView, RefreshControl, Modal, Pressable, Platform, TextInput, Image, Linking,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { WebView } from 'react-native-webview';
import LiveTargetWarning from '../../components/LiveTargetWarning';
import {
  fetchAdminUserOverview, fetchAdminUserMatchedJobs, fetchAdminUserActivity,
  fetchAdminCoverLetter, fetchAdminNotifyTemplates, sendAdminUserNotification,
  adminFileSource, adminAuthHeaderValue, adminFileUrl,
  type AdminUserOverview, type AdminMatchedJob, type AdminMatchedJobsResponse,
  type AdminActivityKind, type AdminActivityMeta, type AdminActivityCoverLetter,
  type AdminActivitySavedJob, type AdminActivityApplication, type AdminActivityCredit,
  type AdminActivitySearch, type AdminActivityItemMap, type AdminCoverLetter,
  type AdminNotifyTemplate, type AdminNotifyTemplatesResponse, type AdminUserNotifyResult,
  type AdminFileKind,
} from '../../services/aiHubService';

// ─── tokens (shared with store-analytics.tsx / user-analytics.tsx) ───
const C = {
  bg: '#E5EAF3', bgSoft: '#DCE2ED', surface: '#FFFFFF', ink: '#0B0F22', inkSoft: '#1A2046',
  textMuted: '#5B6B8A', textFaint: '#8896B0', border: 'rgba(11,15,34,0.06)', borderHi: 'rgba(11,15,34,0.10)',
  blue: '#4F8DFF', blueDeep: '#2563EB', purple: '#7C6BFF', teal: '#14B8A6', emerald: '#10B981',
  amber: '#F59E0B', rose: '#EF4444',
};
type IconName = React.ComponentProps<typeof Ionicons>['name'];

// The REAL delivery limits the server clips to (notifyTemplates.js) — the counters below count what
// the server counts (whitespace-collapsed), so nothing the admin types is silently cut.
const LIM = { title: 90, body: 200 };
const ACT_PAGE = 25;

// ─── small helpers ───
const has = (v: unknown): boolean => v != null && String(v).trim() !== '';
const fmt = (x?: number | null): string =>
  x == null || isNaN(Number(x)) ? '0' : Math.round(Number(x)).toLocaleString('en-US');
const norm = (s?: string | null): string => String(s ?? '').replace(/\s+/g, ' ').trim();
const clip = (s: string, n: number): string => {
  const t = norm(s);
  return t.length > n ? `${t.slice(0, n - 1).replace(/\s+$/, '')}…` : t;
};
const arr = <T,>(v: T[] | null | undefined): T[] => (Array.isArray(v) ? v : []);
const safeUrl = (u?: string | null): string => {
  const s = String(u ?? '').trim();
  return /^https?:\/\//i.test(s) ? s : '';
};
function dateLabel(iso?: string | null): string {
  if (!iso) return '';
  const dt = new Date(iso);
  if (isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
}
function clock(iso?: string | null): string {
  if (!iso) return '';
  const dt = new Date(iso);
  if (isNaN(dt.getTime())) return '';
  return dt.toLocaleString('en-US', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}
function timeAgo(iso?: string | null): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30); if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}
const initials = (name?: string | null, email?: string | null): string => {
  const src = (name && name.trim()) || email || '?';
  const parts = String(src).trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return String(src).slice(0, 2).toUpperCase();
};
const AV_GRADS: [string, string][] = [
  ['#4F8DFF', '#2563EB'], ['#7C6BFF', '#5B4BE0'], ['#14B8A6', '#0E9488'],
  ['#F59E0B', '#D97706'], ['#EF4444', '#DC2626'], ['#10B981', '#059669'],
];
const gradFor = (k: string | number): [string, string] => {
  let h = 0;
  const s = String(k ?? 'x');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AV_GRADS[h % AV_GRADS.length];
};
// COSMETIC ONLY — not a sanitiser. Cover-letter previews come back as HTML; everything here is
// rendered inside <Text>, which cannot execute markup, so this only makes it read as a sentence.
const ENTS: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
const plain = (s?: string | null): string =>
  String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/&(amp|lt|gt|quot|#39|nbsp);/gi, (m) => ENTS[m.toLowerCase()] || m);

// app_events.props is JSON — it may arrive parsed or as a string.
function propsOf(p: unknown): Record<string, any> {
  if (p == null) return {};
  if (typeof p === 'object') return p as Record<string, any>;
  if (typeof p === 'string') {
    try { const j = JSON.parse(p); return j && typeof j === 'object' ? j : { value: p }; }
    catch { return { value: p }; }
  }
  return { value: String(p) };
}
const PK_Q = ['query', 'q', 'keyword', 'keywords', 'search', 'searchTerm', 'search_term', 'term', 'text', 'title', 'role'];
const PK_L = ['location', 'city', 'country', 'place', 'where', 'region'];
function pickKey(o: Record<string, any>, keys: string[]): string {
  for (const k of keys) { const v = o[k]; if (has(v) && typeof v !== 'object') return String(v); }
  return '';
}
function restBits(o: Record<string, any>, skip: string[]): string {
  const out: string[] = [];
  Object.keys(o || {}).forEach((k) => {
    if (skip.indexOf(k) >= 0) return;
    let v = o[k];
    if (v == null || v === '') return;
    if (typeof v === 'object') { try { v = JSON.stringify(v); } catch { v = '[object]'; } }
    out.push(`${String(k).replace(/_/g, ' ')}: ${String(v)}`);
  });
  return clip(out.slice(0, 6).join(' · '), 200);
}
// Status text is free-form DB text — classified by shape, never trusted as an enum.
function statusTone(sv?: string | null): string | null {
  const s = norm(sv);
  if (!s) return null;
  const l = s.toLowerCase();
  if (/(sent|delivered|applied|complete|success|done|hired|accept)/.test(l)) return C.emerald;
  if (/(fail|error|reject|declin|cancel|expire)/.test(l)) return C.rose;
  if (/(draft|pending|generat|progress|review|saved|new|queue)/.test(l)) return C.amber;
  return C.textMuted;
}
const matchTone = (m: number | null): string => (m == null ? C.textFaint : m >= 70 ? C.emerald : m >= 40 ? C.amber : C.textFaint);

// ═══════════════════════════════════════════════════════════════════════════════
// Send outcomes — the ONE place that decides what a send result means.
// The API answers success:true for opted_out / no_token / recently_sent: the REQUEST succeeded,
// the send did not. Those are `skipped` and must never read as a delivery.
// ═══════════════════════════════════════════════════════════════════════════════
type OutcomeKind = 'delivered' | 'blocked' | 'inapp' | 'failed' | 'cancelled';
type Outcome = { kind: OutcomeKind; text: string; color: string; icon: IconName; badge: string | null };

const SKIP_COPY: Record<string, string> = {
  opted_out: 'Blocked — the user opted out of this category. Nothing delivered, nothing saved in-app.',
  no_token: 'Blocked — no push token on file. Nothing delivered, nothing saved in-app.',
  recently_sent: 'Blocked — this template already reached them in the last 72h. Nothing sent.',
  job_not_found: 'Blocked — the job could not be resolved. Nothing sent.',
  bad_template_category: 'Blocked — the template category cannot be opt-out gated. Nothing sent.',
  unknown_template: 'Blocked — unknown template. Nothing sent.',
  user_not_found: 'Blocked — user not found. Nothing sent.',
};
function outcomeOf(res: AdminUserNotifyResult | null | undefined): Outcome {
  if (!res || !res.success) {
    return { kind: 'failed', text: 'Failed — the request did not succeed. Nothing sent.', color: C.rose, icon: 'close-circle', badge: 'Failed' };
  }
  const sk = res.skipped ? String(res.skipped) : '';
  if (sk) {
    return {
      kind: 'blocked',
      text: SKIP_COPY[sk] || `Blocked — ${sk.replace(/_/g, ' ')}. Nothing sent.`,
      color: C.rose, icon: 'hand-left', badge: 'Not sent',
    };
  }
  const p = res.push || ({ ok: false } as AdminUserNotifyResult['push']);
  if (p.ok) return { kind: 'delivered', text: 'Delivered to the phone.', color: C.emerald, icon: 'checkmark-circle', badge: 'Sent' };
  return {
    kind: 'inapp',
    text: `Saved in-app only · push NOT delivered${p.error ? ` (${String(p.error)})` : ''}`,
    color: C.amber, icon: 'alert-circle', badge: 'In-app only',
  };
}
// A send-log row with push_ok=false is NOT always "in-app only" — the rails log opted_out /
// no_token BEFORE anything is written or delivered, so those must read as blocked.
const LOG_BLOCKED: Record<string, string> = {
  opted_out: 'opted out of this category', no_token: 'no push token',
  recently_sent: 'already sent in the last 72h', job_not_found: 'the job no longer exists',
  bad_template_category: 'template misconfigured', unknown_template: 'unknown template',
  user_not_found: 'user not found', reservation_abandoned: 'send was interrupted',
};

// Mirrors the server's specific_job template so the confirmation shows the real wording.
function jobPreview(j: AdminMatchedJob | null | undefined): { title: string; body: string } {
  const job = j || ({} as AdminMatchedJob);
  const mRaw = Number(job.match);
  const m = isFinite(mRaw) ? Math.round(mRaw) : 0;
  const title = clip(m ? `${m}% match: ${job.title || ''}` : `New role for you: ${job.title || ''}`, LIM.title);
  const line = [job.employer_name, job.location, job.work_mode, job.salary].filter(has).join(' · ');
  const body = clip(line ? `${line}. Tap to see the full role and apply.` : 'Tap to see the full role and apply.', 180);
  return { title, body };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Presentational atoms
// ═══════════════════════════════════════════════════════════════════════════════
function Section({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <View style={s.card}>
      <View style={s.sectHead}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.sect}>{title}</Text>
          {!!sub && <Text style={s.sectSub}>{sub}</Text>}
        </View>
      </View>
      {children}
    </View>
  );
}
function Chip({ label, value, tone }: { label: string; value?: string | null; tone?: string }) {
  return (
    <View style={[s.chip, tone ? { backgroundColor: `${tone}14`, borderColor: `${tone}2E` } : null]}>
      <Text style={[s.chipT, tone ? { color: tone } : null]} numberOfLines={1}>
        {label}{has(value) ? <Text style={s.chipB}> {value}</Text> : null}
      </Text>
    </View>
  );
}
function Pill({ text, tone }: { text: string; tone: string }) {
  return (
    <View style={[s.pill, { backgroundColor: `${tone}18` }]}>
      <Text style={[s.pillT, { color: tone }]} numberOfLines={1}>{text}</Text>
    </View>
  );
}
function KV({ k, v, important }: { k: string; v?: string | null; important?: boolean }) {
  const ok = has(v);
  return (
    <View style={s.kv}>
      <Text style={s.kvK}>{k}</Text>
      <View style={s.kvRight}>
        <Text style={[s.kvV, !ok && s.kvBlank]} numberOfLines={2}>{ok ? String(v) : '—'}</Text>
        {!ok && important ? <View style={s.kvDot} /> : null}
      </View>
    </View>
  );
}
function Note({ text, tone = C.amber, strong }: { text: string; tone?: string; strong?: string | null }) {
  return (
    <View style={[s.note, { backgroundColor: `${tone}12`, borderColor: `${tone}2E` }]}>
      <Ionicons name="information-circle-outline" size={14} color={tone} style={{ marginTop: 1 }} />
      <View style={{ flex: 1 }}>
        {!!strong && <Text style={[s.noteT, { fontWeight: '800' }]}>{strong}</Text>}
        <Text style={s.noteT}>{text}</Text>
      </View>
    </View>
  );
}
function Empty({ text, icon = 'file-tray-outline' }: { text: string; icon?: IconName }) {
  return (
    <View style={s.empty}>
      <Ionicons name={icon} size={26} color={C.textFaint} />
      <Text style={s.emptyT}>{text}</Text>
    </View>
  );
}
function Skel({ text }: { text: string }) {
  return (
    <View style={s.skel}>
      <ActivityIndicator color={C.blue} size="small" />
      <Text style={s.skelT}>{text}</Text>
    </View>
  );
}
function ChipRow({ items, max = 30 }: { items: unknown[]; max?: number }) {
  // A parsed résumé can carry nulls and objects (education rows) in the same array — a null must not
  // become the chip "null", and an object must not become "[object Object]".
  const labelled = arr(items).map((x) => {
    if (x == null) return '';
    if (typeof x === 'object') {
      const o = x as Record<string, any>;
      const pick = o.name || o.title || o.degree || o.institution;
      return String(pick != null && String(pick).trim() ? pick : JSON.stringify(x));
    }
    return String(x);
  }).filter((t) => has(t) && t !== '{}' && t !== '[]');
  if (!labelled.length) return <Text style={s.dash}>—</Text>;
  const shown = labelled.slice(0, max);
  const list = labelled;
  return (
    <View style={s.chips}>
      {shown.map((label, i) => <Chip key={`${label}-${i}`} label={clip(label, 48)} />)}
      {list.length > shown.length ? <Chip label={`+${list.length - shown.length} more`} /> : null}
    </View>
  );
}
function ResultLine({ out }: { out?: Outcome | null }) {
  if (!out) return null;
  return (
    <View style={[s.resLine, { backgroundColor: `${out.color}12`, borderColor: `${out.color}2E` }]}>
      <Ionicons name={out.icon} size={14} color={out.color} style={{ marginTop: 1 }} />
      <Text style={[s.resT, { color: out.color }]}>{out.text}</Text>
    </View>
  );
}
function OpenLink({ url, label }: { url: string; label: string }) {
  if (!url) return null;
  return (
    <TouchableOpacity
      onPress={() => { Linking.openURL(url).catch(() => {}); }}
      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      activeOpacity={0.7}
    >
      <Text style={s.link}>{label}</Text>
    </TouchableOpacity>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Activity tabs
// ═══════════════════════════════════════════════════════════════════════════════
type ActivityItem = AdminActivityItemMap[AdminActivityKind];
type TabState = {
  rows: ActivityItem[]; total: number | null; seed: number | null;
  loaded: boolean; loading: boolean; done: boolean;
  error: string | null; meta: AdminActivityMeta | null; unavailable: string | null;
};
const emptyTab = (seed: number | null): TabState => ({
  rows: [], total: null, seed, loaded: false, loading: false, done: false, error: null, meta: null, unavailable: null,
});
const TABS: { k: AdminActivityKind; label: string; icon: IconName; empty: string; seedKey: 'cover_letters' | 'saved_jobs' | 'applications' | 'searches' | null }[] = [
  { k: 'cover_letters', label: 'Cover letters', icon: 'document-attach-outline', empty: 'No cover letters generated yet.', seedKey: 'cover_letters' },
  { k: 'saved_jobs', label: 'Saved jobs', icon: 'bookmark-outline', empty: 'Nothing saved yet.', seedKey: 'saved_jobs' },
  { k: 'applications', label: 'Applications', icon: 'paper-plane-outline', empty: 'No applications tracked yet.', seedKey: 'applications' },
  { k: 'credits', label: 'Credit usage', icon: 'cash-outline', empty: 'No credits spent yet.', seedKey: null },
  { k: 'searches', label: 'Searches', icon: 'search-outline', empty: 'No searches recorded yet.', seedKey: 'searches' },
];
const APP_SRC: Record<string, string> = { email: 'emailed', cover_letter: 'cover letter', job_match: 'in-app' };

function ActivityRow({ kind, row, onOpenLetter }: {
  kind: AdminActivityKind; row: ActivityItem; onOpenLetter: (r: AdminActivityCoverLetter) => void;
}) {
  if (kind === 'cover_letters') {
    const r = row as AdminActivityCoverLetter;
    const tone = statusTone(r.status);
    const meta = [r.company_name, clock(r.created_at)].filter(has).join(' · ');
    return (
      <View style={s.arow}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={s.arowTitleRow}>
            <Text style={s.arowT} numberOfLines={2}>{has(r.position) ? r.position : 'Cover letter'}</Text>
            {tone && has(r.status) ? <Pill text={String(r.status).replace(/_/g, ' ')} tone={tone} /> : null}
          </View>
          <Text style={s.arowM} numberOfLines={2}>{meta || '—'}</Text>
          {has(r.website_url) ? <OpenLink url={safeUrl(r.website_url)} label="open site ↗" /> : null}
          {has(r.preview) ? <Text style={s.arowPv} numberOfLines={3}>{clip(plain(r.preview), 240)}</Text> : null}
        </View>
        {r.id != null ? (
          <TouchableOpacity style={s.ghostBtn} activeOpacity={0.8} onPress={() => onOpenLetter(r)}>
            <Ionicons name="reader-outline" size={13} color={C.blueDeep} />
            <Text style={s.ghostBtnT}>View</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    );
  }
  if (kind === 'saved_jobs') {
    const r = row as AdminActivitySavedJob;
    const bits = [r.employer_name, r.location].filter(has).map(String);
    if (r.saved_at) bits.push(`saved ${timeAgo(r.saved_at) || dateLabel(r.saved_at)}`);
    return (
      <View style={s.arow}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.arowT} numberOfLines={2}>{has(r.title) ? r.title : 'Untitled role'}</Text>
          <Text style={s.arowM} numberOfLines={2}>{bits.join(' · ') || '—'}</Text>
          <OpenLink url={safeUrl(r.job_url)} label="open posting ↗" />
        </View>
      </View>
    );
  }
  if (kind === 'applications') {
    const r = row as AdminActivityApplication;
    const tone = statusTone(r.status);
    const meta = [r.company_name, r.created_at ? clock(r.created_at) : ''].filter(has).join(' · ');
    return (
      <View style={s.arow}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={s.arowTitleRow}>
            <Text style={s.arowT} numberOfLines={2}>
              {has(r.title) ? r.title : has(r.position) ? r.position : 'Untitled role'}
            </Text>
            {tone && has(r.status) ? <Pill text={String(r.status).replace(/_/g, ' ')} tone={tone} /> : null}
            {r.reply_received === true ? <Pill text="replied" tone={C.emerald} /> : null}
          </View>
          <Text style={s.arowM} numberOfLines={2}>{meta || '—'}</Text>
          <View style={s.chips}>
            {has(r.source) ? <Chip label={APP_SRC[String(r.source)] || String(r.source)} /> : null}
          </View>
          <OpenLink url={safeUrl(r.job_url)} label="open posting ↗" />
        </View>
      </View>
    );
  }
  if (kind === 'credits') {
    const r = row as AdminActivityCredit;
    const n = isFinite(Number(r.credits_used)) ? Number(r.credits_used) : 0;
    const meta = [r.company_name, r.position, clock(r.created_at)].filter(has).join(' · ');
    return (
      <View style={s.arow}>
        <View style={[s.creditBadge, { backgroundColor: n > 0 ? `${C.amber}18` : C.bgSoft }]}>
          <Text style={[s.creditBadgeT, { color: n > 0 ? C.amber : C.textMuted }]}>{n > 0 ? `−${fmt(n)}` : fmt(n)}</Text>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.arowT} numberOfLines={2}>{String(r.action_type || 'credit use').replace(/_/g, ' ')}</Text>
          <Text style={s.arowM} numberOfLines={2}>{meta || '—'}</Text>
        </View>
      </View>
    );
  }
  const r = row as AdminActivitySearch;
  const p = propsOf(r.props);
  // ⚠️ `query` and `location` are null on 100% of live rows — the thing the user actually searched
  // for is recorded as `company` (both top-level and inside props). Without this fallback every row
  // rendered the placeholder "Search" and the tab looked broken.
  const q = pickKey(p, PK_Q) || r.query || r.company || pickKey(p, ['company']) || '';
  const loc = pickKey(p, PK_L) || r.location || '';
  const rest = restBits(p, PK_Q.concat(PK_L));
  const meta = [loc, clock(r.created_at)].filter(has).join(' · ');
  return (
    <View style={s.arow}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={s.arowT} numberOfLines={2}>{has(q) ? String(q) : 'Search'}</Text>
        <Text style={s.arowM} numberOfLines={2}>{meta || '—'}</Text>
        {!!rest && <Text style={[s.arowPv, s.mono]} numberOfLines={3}>{rest}</Text>}
      </View>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Template card — keeps its draft copy LOCAL so typing does not re-render the page.
// ═══════════════════════════════════════════════════════════════════════════════
type SendRequest = {
  tpl: AdminNotifyTemplate; title: string; body: string;
  titleEdited: boolean; bodyEdited: boolean; clipped: boolean;
};
const TemplateCard = React.memo(function TemplateCard({ tpl, rel, result, busy, onSend }: {
  tpl: AdminNotifyTemplate; rel: 'suggested' | 'available' | 'not_applicable';
  result?: Outcome | null; busy: boolean; onSend: (req: SendRequest) => void;
}) {
  const [title, setTitle] = useState(tpl.title || '');
  const [body, setBody] = useState(tpl.body || '');
  const [unlocked, setUnlocked] = useState(false);
  const [localErr, setLocalErr] = useState<string | null>(null);

  const na = rel === 'not_applicable';
  const tLen = norm(title).length;
  const bLen = norm(body).length;
  const titleEdited = norm(title) !== norm(tpl.title);
  const bodyEdited = norm(body) !== norm(tpl.body);
  const blocked = na && !unlocked;

  const press = () => {
    setLocalErr(null);
    // The disabled prop alone is not the guard — this refuses the send itself, so a "not applicable"
    // template cannot go out until the admin explicitly chose "Send anyway".
    if (blocked) { setLocalErr('Not applicable for this user — use “Send anyway” first.'); return; }
    const t = clip(title, LIM.title);
    const b = clip(body, LIM.body);
    if (!t || !b) { setLocalErr('Title and body are both required.'); return; }
    onSend({ tpl, title: t, body: b, titleEdited, bodyEdited, clipped: tLen > LIM.title || bLen > LIM.body });
  };

  return (
    <View style={[s.tcard, rel === 'suggested' && s.tcardSug, blocked && s.tcardNa]}>
      <View style={s.tcardHead}>
        <Text style={s.tcardName} numberOfLines={2}>{tpl.label || tpl.key || 'Template'}</Text>
        {rel === 'suggested' ? <Pill text="Suggested" tone={C.blueDeep} /> : null}
        {na ? <Pill text="n/a" tone={C.textMuted} /> : null}
      </View>
      <View style={s.chips}>
        {has(tpl.category) ? <Chip label={String(tpl.category).replace(/_/g, ' ')} /> : null}
        {tpl.needsJob ? <Chip label="needs a job" tone={C.purple} /> : null}
      </View>
      {has(tpl.description) ? <Text style={s.tcardDesc}>{tpl.description}</Text> : null}
      {has(tpl.reason) ? (
        <Text style={[s.tcardReason, na && { color: C.rose }]}>{tpl.reason}</Text>
      ) : null}

      <View style={s.lblRow}>
        <Text style={s.lbl}>TITLE</Text>
        <Text style={[s.cnt, tLen > LIM.title && { color: C.rose }]}>
          {tLen}/{LIM.title}{tLen > LIM.title ? ' — will be cut' : ''}
        </Text>
      </View>
      <TextInput
        value={title}
        onChangeText={setTitle}
        style={s.input}
        maxLength={LIM.title}
        placeholder="Notification title"
        placeholderTextColor={C.textFaint}
      />
      <View style={s.lblRow}>
        <Text style={s.lbl}>BODY</Text>
        <Text style={[s.cnt, bLen > LIM.body && { color: C.rose }]}>
          {bLen}/{LIM.body}{bLen > LIM.body ? ' — will be cut' : ''}
        </Text>
      </View>
      <TextInput
        value={body}
        onChangeText={setBody}
        style={[s.input, s.textarea]}
        maxLength={LIM.body}
        multiline
        placeholder="Notification body"
        placeholderTextColor={C.textFaint}
      />
      {has(tpl.route) ? (
        <Text style={[s.mono, s.routeT]} numberOfLines={2}>
          {tpl.route}{tpl.params && Object.keys(tpl.params).length ? ` · ${JSON.stringify(tpl.params)}` : ''}
        </Text>
      ) : null}

      <Text style={s.editState}>
        {titleEdited || bodyEdited
          ? `Edited — ${[titleEdited ? 'title' : null, bodyEdited ? 'body' : null].filter(Boolean).join(' and ')} will be sent exactly as typed.`
          : 'Unedited — sent with no override, so the server personalises it for this user.'}
      </Text>

      <View style={s.tcardActions}>
        <TouchableOpacity
          style={[s.sendBtn, (busy || blocked) && s.sendBtnOff]}
          activeOpacity={0.85}
          disabled={busy}
          onPress={press}
        >
          {busy
            ? <ActivityIndicator color="#fff" size="small" />
            : <><Ionicons name="send" size={13} color="#fff" /><Text style={s.sendBtnT}>Send</Text></>}
        </TouchableOpacity>
        {na && !unlocked ? (
          <TouchableOpacity onPress={() => setUnlocked(true)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={s.unlock}>Send anyway</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {localErr ? <Text style={s.inlineErr}>{localErr}</Text> : null}
      <ResultLine out={result} />
    </View>
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// Overlays — EXACTLY ONE <Modal> is ever mounted (a nested Modal hard-crashed iOS in build 87),
// which the single `overlay` state and the chained render below make structural.
// ═══════════════════════════════════════════════════════════════════════════════
type ConfirmPayload = {
  kind: 'confirm';
  heading: string; who: string; whoSub: string;
  title: string; body: string;
  templateLabel: string; route: string | null;
  naReason: string | null; noToken: boolean; clipped: boolean;
  editNote: string; extraNote: string | null;
  targetId: string;
  run: () => Promise<AdminUserNotifyResult>;
};
type Overlay =
  | { kind: 'doc'; doc: AdminFileKind; label: string; sub: string }
  | { kind: 'letter'; meta: AdminActivityCoverLetter; letter: AdminCoverLetter | null; loading: boolean; error: string | null }
  | ConfirmPayload;

function OverlayShell({ title, sub, onClose, children, footer }: {
  title: string; sub?: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode;
}) {
  return (
    <View style={s.mSafe}>
      <View style={s.mHead}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.mTitle} numberOfLines={1}>{title}</Text>
          {!!sub && <Text style={s.mSub} numberOfLines={2}>{sub}</Text>}
        </View>
        <TouchableOpacity onPress={onClose} style={s.mClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="close" size={18} color={C.ink} />
        </TouchableOpacity>
      </View>
      {children}
      {footer}
    </View>
  );
}

function DocViewer({ ov, userId, onClose }: { ov: Extract<Overlay, { kind: 'doc' }>; userId: string; onClose: () => void }) {
  const [src, setSrc] = useState<{ uri: string; headers: Record<string, string> } | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const sc = await adminFileSource(userId, ov.doc);
        if (!alive) return;
        if (!sc) { setState('error'); return; }
        setSrc(sc); setState('ready');
      } catch { if (alive) setState('error'); }
    })();
    return () => { alive = false; };
  }, [ov.doc, userId]);

  const isImage = ov.doc !== 'resume';
  return (
    <OverlayShell title={ov.label} sub={ov.sub} onClose={onClose}>
      <View style={s.docBody}>
        {state === 'loading' ? (
          <Skel text="Opening the file…" />
        ) : state === 'error' || !src ? (
          <Empty icon="alert-circle-outline" text="Could not build an authenticated link for this file — the admin session may have expired." />
        ) : isImage ? (
          <ScrollView contentContainerStyle={s.docImgWrap} maximumZoomScale={4} minimumZoomScale={1}>
            {failed
              ? <Empty icon="image-outline" text="The file could not be displayed." />
              : <Image source={src} style={s.docImg} resizeMode="contain" onError={() => setFailed(true)} />}
          </ScrollView>
        ) : (
          <WebView
            source={src}
            style={s.web}
            startInLoadingState
            renderLoading={() => <View style={s.webLoading}><ActivityIndicator color={C.blue} size="large" /></View>}
            onError={() => setFailed(true)}
            setSupportMultipleWindows={false}
            // ⚠️ Same hardening as the cover-letter viewer below. This renders a file the USER
            // uploaded, inside an admin session that holds an admin token — and react-native-webview
            // defaults javaScriptEnabled to true and originWhitelist to ['*'], so an uploaded HTML
            // "résumé" would run script and could navigate anywhere. A PDF needs neither.
            javaScriptEnabled={false}
            originWhitelist={[]}
            allowsInlineMediaPlayback={false}
            onShouldStartLoadWithRequest={(req) => req.url === (src as any)?.uri}
          />
        )}
        {!isImage && state === 'ready' ? (
          <Text style={s.docHint}>
            {failed
              ? 'The viewer could not load this file. It is served from an admin-only endpoint — open it from the web admin if this keeps failing.'
              : Platform.OS === 'android'
                ? 'PDFs do not always render inline in Android’s system WebView. A blank page here does not mean the file is missing.'
                : 'Served from the admin-only file endpoint with your session header.'}
          </Text>
        ) : null}
        {state === 'ready' ? <Text style={[s.mono, s.docUrl]} numberOfLines={1}>{adminFileUrl(userId, ov.doc)}</Text> : null}
      </View>
    </OverlayShell>
  );
}

function LetterViewer({ ov, onClose }: { ov: Extract<Overlay, { kind: 'letter' }>; onClose: () => void }) {
  const meta = ov.meta;
  const sub = [meta.company_name, meta.status, clock(meta.created_at)].filter(has).join(' · ');
  const raw = ov.letter?.html || '';
  // The letter body is USER-GENERATED. It only ever reaches a WebView with scripts OFF and an empty
  // origin whitelist, so it cannot execute and cannot navigate. It is never injected anywhere else.
  const doc = useMemo(() => {
    const html = String(raw || '');
    if (!html.trim()) return '';
    if (/<html[\s>]|<!doctype/i.test(html)) return html;
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
      + `<style>body{margin:0;padding:16px;font-family:-apple-system,Roboto,sans-serif;font-size:14px;line-height:1.55;color:#0B0F22;background:#fff;}`
      + `img{max-width:100%;height:auto;}table{max-width:100%;}</style></head><body>${html}</body></html>`;
  }, [raw]);

  return (
    <OverlayShell title={meta.position || meta.company_name || 'Cover letter'} sub={sub} onClose={onClose}>
      <View style={s.docBody}>
        {ov.loading ? (
          <Skel text="Loading the letter…" />
        ) : ov.error ? (
          <Empty icon="alert-circle-outline" text={ov.error} />
        ) : !doc ? (
          <Empty icon="document-outline" text="This letter has no stored HTML." />
        ) : (
          <WebView
            originWhitelist={[]}
            javaScriptEnabled={false}
            source={{ html: doc }}
            style={s.web}
            setSupportMultipleWindows={false}
            // Belt and braces on top of the empty origin whitelist: no navigable scheme is allowed.
            onShouldStartLoadWithRequest={(req) => !/^(https?|intent|market|tel|mailto|file):/i.test(String(req?.url || ''))}
          />
        )}
        {doc && !ov.loading && !ov.error ? (
          <Text style={s.docHint}>
            Rendered with scripts disabled and navigation blocked
            {ov.letter?.sanitized ? ' · the server also stripped script-ish markup from this letter.' : '.'}
          </Text>
        ) : null}
      </View>
    </OverlayShell>
  );
}

function ConfirmSheet({ ov, sending, onCancel, onGo }: {
  ov: ConfirmPayload; sending: boolean; onCancel: () => void; onGo: () => void;
}) {
  const shortWho = ov.who.length > 26 ? `${ov.who.slice(0, 25)}…` : ov.who;
  return (
    <View style={s.confirmWrap}>
      <Pressable style={{ flex: 1 }} onPress={sending ? undefined : onCancel} />
      <View style={s.confirmSheet}>
        <View style={s.sheetGrip} />
        <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 8 }} showsVerticalScrollIndicator={false}>
          <Text style={s.confirmH}>{ov.heading}</Text>
          <Text style={s.confirmWho}>
            This goes straight to the phone of <Text style={{ fontWeight: '800', color: C.ink }}>{ov.who}</Text>
            {ov.whoSub ? ` · ${ov.whoSub}` : ''}.
          </Text>
          <Text style={s.confirmTpl}>
            Template: {ov.templateLabel}{ov.route ? `  ·  opens ${ov.route}` : ''}
          </Text>

          {ov.naReason ? <Note tone={C.rose} text={`Marked NOT APPLICABLE for this user — ${ov.naReason}`} /> : null}
          {ov.noToken ? <Note tone={C.rose} text="This user has no push token. Nothing will reach the phone; at best it is stored in-app." /> : null}
          {ov.clipped ? <Note text={`Shortened to the delivery limits (${LIM.title} title / ${LIM.body} body). The preview below is what is actually delivered.`} /> : null}
          {ov.extraNote ? <Note tone={C.blueDeep} text={ov.extraNote} /> : null}

          <View style={s.pv}>
            <Text style={s.pvL}>DELIVERED TITLE</Text>
            <Text style={s.pvT}>{ov.title || '—'}</Text>
            <Text style={[s.pvL, { marginTop: 10 }]}>DELIVERED BODY</Text>
            <Text style={s.pvB}>{ov.body || '—'}</Text>
          </View>
          <Text style={s.confirmEdit}>{ov.editNote}</Text>
        </ScrollView>
        <View style={s.confirmActions}>
          <TouchableOpacity style={[s.cancelBtn, sending && s.sendBtnOff]} disabled={sending} onPress={onCancel} activeOpacity={0.85}>
            <Text style={s.cancelBtnT}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.dangerBtn, sending && s.sendBtnOff]} disabled={sending} onPress={onGo} activeOpacity={0.85}>
            {sending
              ? <ActivityIndicator color="#fff" size="small" />
              : <><Ionicons name="send" size={14} color="#fff" /><Text style={s.dangerBtnT} numberOfLines={1}>Send to {shortWho}</Text></>}
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Screen
// ═══════════════════════════════════════════════════════════════════════════════
export default function User360Screen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ userId?: string | string[] }>();
  const rawId = Array.isArray(params.userId) ? params.userId[0] : params.userId;
  const userId = String(rawId ?? '').trim();

  const [ov, setOv] = useState<AdminUserOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [photoSrc, setPhotoSrc] = useState<{ uri: string; headers: Record<string, string> } | null>(null);
  const [photoFailed, setPhotoFailed] = useState(false);
  const [hasSession, setHasSession] = useState(true);

  const [matched, setMatched] = useState<AdminMatchedJobsResponse | null>(null);
  const [jobsLoading, setJobsLoading] = useState(true);
  const [jobsErr, setJobsErr] = useState<string | null>(null);

  const [tpls, setTpls] = useState<AdminNotifyTemplatesResponse | null>(null);
  const [tplLoading, setTplLoading] = useState(true);
  const [tplErr, setTplErr] = useState<string | null>(null);
  const [tplVersion, setTplVersion] = useState(0);

  const [tabs, setTabs] = useState<Record<AdminActivityKind, TabState>>(() => ({
    cover_letters: emptyTab(null), saved_jobs: emptyTab(null), applications: emptyTab(null),
    credits: emptyTab(null), searches: emptyTab(null),
  }));
  const [activeTab, setActiveTab] = useState<AdminActivityKind>('cover_letters');

  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<Record<string, Outcome>>({});
  const alive = useRef(true);
  // Re-armed on mount, not only cleared on unmount — React 18 StrictMode mounts an effect twice in
  // dev, and a one-way `alive = false` would leave every later setState silently dropped.
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const inFlight = useRef<Partial<Record<AdminActivityKind, boolean>>>({});

  // ── loaders ──────────────────────────────────────────────────────────────────
  const loadOverview = useCallback(async () => {
    if (!userId) return null;
    try {
      const d = await fetchAdminUserOverview(userId);
      if (!alive.current) return null;
      if (!d || !d.success || !d.user) { setFatal(`User ${userId} was not found.`); setOv(null); return null; }
      setFatal(null); setOv(d);
      return d;
    } catch (e: unknown) {
      if (!alive.current) return null;
      const err = e as { message?: string; status?: number };
      setFatal(err?.status === 403 ? 'Admin access required.' : err?.message || 'Could not load this user.');
      setOv(null);
      return null;
    }
  }, [userId]);

  const loadJobs = useCallback(async () => {
    if (!userId) return;
    setJobsLoading(true); setJobsErr(null);
    try {
      const d = await fetchAdminUserMatchedJobs(userId, 20);
      if (!alive.current) return;
      setMatched(d);
    } catch (e: unknown) {
      if (!alive.current) return;
      setMatched(null);
      setJobsErr((e as { message?: string })?.message || 'Could not load matches.');
    } finally { if (alive.current) setJobsLoading(false); }
  }, [userId]);

  const loadTemplates = useCallback(async () => {
    if (!userId) return;
    setTplLoading(true); setTplErr(null);
    try {
      const d = await fetchAdminNotifyTemplates(userId);
      if (!alive.current) return;
      setTpls(d); setTplVersion((v) => v + 1);
    } catch (e: unknown) {
      if (!alive.current) return;
      setTpls(null);
      setTplErr((e as { message?: string })?.message || 'Could not load templates.');
    } finally { if (alive.current) setTplLoading(false); }
  }, [userId]);

  // `offset` is passed in rather than read out of a setTabs updater: React may run an updater during
  // the render phase, so anything assigned inside one is not readable on the next line.
  const loadTab = useCallback(async (k: AdminActivityKind, offset: number) => {
    if (!userId) return;
    if (inFlight.current[k]) return;          // synchronous guard — state is too late to dedupe on
    inFlight.current[k] = true;
    const more = offset > 0;
    setTabs((prev) => ({ ...prev, [k]: { ...prev[k], loading: true, error: null } }));
    try {
      const d = await fetchAdminUserActivity(userId, k, ACT_PAGE, offset);
      if (!alive.current) return;
      setTabs((prev) => {
        const st = prev[k];
        const items = arr(d?.items) as ActivityItem[];
        const rows = more ? st.rows.concat(items) : items;
        const t = d && isFinite(Number(d.total)) ? Number(d.total) : null;
        return {
          ...prev,
          [k]: {
            ...st,
            rows,
            total: t == null ? rows.length : Math.max(t, rows.length),
            loaded: true, loading: false, error: null,
            // A short page means the server ran out of rows; a known total ends it too.
            done: items.length < ACT_PAGE || (t != null && rows.length >= t),
            meta: d?.meta || null,
            unavailable: d?.unavailable || null,
          },
        };
      });
    } catch (e: unknown) {
      if (!alive.current) return;
      const msg = (e as { message?: string })?.message || 'Could not load this list.';
      setTabs((prev) => ({ ...prev, [k]: { ...prev[k], loading: false, loaded: true, error: msg } }));
    } finally {
      inFlight.current[k] = false;
    }
  }, [userId]);

  // seed the tab counters from the overview, then open the first tab
  const seedTabs = useCallback((d: AdminUserOverview | null) => {
    const a = d?.activity;
    setTabs((prev) => {
      const next = { ...prev };
      TABS.forEach((t) => {
        const seed = t.seedKey && a && isFinite(Number(a[t.seedKey])) ? Number(a[t.seedKey]) : null;
        next[t.k] = { ...next[t.k], seed };
      });
      return next;
    });
  }, []);

  const bootstrap = useCallback(async () => {
    if (!userId) { setLoading(false); return; }
    setLoading(true);
    const [d] = await Promise.all([loadOverview(), loadJobs(), loadTemplates()]);
    if (!alive.current) return;
    seedTabs(d);
    setLoading(false);
  }, [userId, loadOverview, loadJobs, loadTemplates, seedTabs]);

  useEffect(() => { bootstrap(); }, [bootstrap]);

  // the admin-only file route needs the Authorization header on the <Image> source itself
  useEffect(() => {
    if (!userId) return;
    let live = true;
    (async () => {
      try {
        const auth = await adminAuthHeaderValue();
        if (!live) return;
        setHasSession(!!auth);
        setPhotoSrc(auth ? { uri: adminFileUrl(userId, 'photo'), headers: { Authorization: auth } } : null);
      } catch { if (live) { setHasSession(false); setPhotoSrc(null); } }
    })();
    return () => { live = false; };
  }, [userId]);

  // lazy-load a tab the first time it is opened
  useEffect(() => {
    if (loading || !userId || fatal) return;
    const st = tabs[activeTab];
    if (!st.loaded && !st.loading) loadTab(activeTab, 0);
  }, [activeTab, loading, userId, fatal, tabs, loadTab]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setResults({});
    setTabs({
      cover_letters: emptyTab(null), saved_jobs: emptyTab(null), applications: emptyTab(null),
      credits: emptyTab(null), searches: emptyTab(null),
    });
    setPhotoFailed(false);
    const [d] = await Promise.all([loadOverview(), loadJobs(), loadTemplates()]);
    if (!alive.current) return;
    seedTabs(d);
    setRefreshing(false);
  }, [loadOverview, loadJobs, loadTemplates, seedTabs]);

  // after a send, the notification / admin-send history is stale
  const refreshHistory = useCallback(() => { loadOverview(); }, [loadOverview]);

  // ── send plumbing ────────────────────────────────────────────────────────────
  const user = ov?.user;
  const whoName = user?.full_name || user?.email || (userId ? `User ${userId}` : 'this user');
  const whoSub = [user?.email && user?.full_name ? user.email : null, `user id ${user?.id ?? userId}`]
    .filter(Boolean).join(' · ');
  const noToken = ov?.push?.has_token === false;

  const askTemplateSend = useCallback((req: SendRequest) => {
    const { tpl } = req;
    const na = tpl.relevance === 'not_applicable' ? (tpl.reason || 'Not applicable for this user right now.') : null;
    // Only an EDITED field goes over as an override; anything untouched is omitted so the server
    // renders it for this user. Saying which is happening is the whole point of this line.
    const both = req.titleEdited && req.bodyEdited;
    const which = both ? 'The title and body are' : req.titleEdited ? 'The title is' : 'The body is';
    const editNote = req.titleEdited || req.bodyEdited
      ? `${which} sent as an override — exactly this wording, with no per-user personalisation for ${both ? 'either field' : 'that field'}.`
      : 'Nothing was edited, so no override is sent — the server renders this template for this user at send time (the preview above is that render).';
    setOverlay({
      kind: 'confirm',
      heading: 'Send this notification?',
      who: whoName, whoSub,
      title: req.title, body: req.body,
      templateLabel: tpl.label || tpl.key, route: tpl.route,
      naReason: na, noToken, clipped: req.clipped,
      editNote, extraNote: tpls?.userKnown === false
        ? 'The template catalogue came back WITHOUT user context, so this copy is the generic render, not a personalised one.'
        : null,
      targetId: `tpl:${tpl.key}`,
      run: () => sendAdminUserNotification(userId, {
        key: tpl.key,
        overrides: req.titleEdited || req.bodyEdited
          ? { ...(req.titleEdited ? { title: req.title } : {}), ...(req.bodyEdited ? { body: req.body } : {}) }
          : null,
      }),
    });
  }, [whoName, whoSub, noToken, tpls, userId]);

  const askJobSend = useCallback((job: AdminMatchedJob) => {
    const pv = jobPreview(job);
    const tpl = arr(tpls?.templates).find((t) => t.key === 'specific_job');
    const na = tpl && tpl.relevance === 'not_applicable' ? (tpl.reason || 'Not applicable for this user right now.') : null;
    const notAdvertisable = matched?.advertisable === false;
    setOverlay({
      kind: 'confirm',
      heading: 'Send this job?',
      who: whoName, whoSub,
      title: pv.title, body: pv.body,
      templateLabel: tpl?.label || 'One specific job', route: tpl?.route || '/(discover)',
      naReason: na, noToken, clipped: false,
      editNote: `Mirrors the server's specific_job template — the server renders the final wording for job ${job.id}. No override is sent.`,
      extraNote: notAdvertisable
        ? 'These match scores are the UNFILTERED admin fallback (nothing cleared the 10% floor). A score from this list must not be quoted to the user — the delivered push may still contain one.'
        : null,
      targetId: `job:${job.id}`,
      run: () => sendAdminUserNotification(userId, { key: 'specific_job', jobId: job.id }),
    });
  }, [tpls, matched, whoName, whoSub, noToken, userId]);

  const runConfirmed = useCallback(async () => {
    const p = overlay && overlay.kind === 'confirm' ? overlay : null;
    if (!p || sending) return;
    setSending(true);
    let out: Outcome;
    try {
      out = outcomeOf(await p.run());
    } catch (e: unknown) {
      const msg = (e as { message?: string })?.message || 'unknown error';
      out = { kind: 'failed', text: `Failed — ${msg}. Nothing sent.`, color: C.rose, icon: 'close-circle', badge: 'Failed' };
    }
    if (!alive.current) return;
    setSending(false);
    setResults((r) => ({ ...r, [p.targetId]: out }));
    setOverlay(null);
    if (out.kind !== 'failed') refreshHistory();
  }, [overlay, sending, refreshHistory]);

  const cancelConfirm = useCallback(() => {
    const p = overlay && overlay.kind === 'confirm' ? overlay : null;
    setOverlay(null);
    if (p) {
      setResults((r) => ({
        ...r,
        [p.targetId]: { kind: 'cancelled', text: 'Cancelled — nothing sent.', color: C.textMuted, icon: 'remove-circle-outline', badge: null },
      }));
    }
  }, [overlay]);

  const openLetter = useCallback(async (row: AdminActivityCoverLetter) => {
    setOverlay({ kind: 'letter', meta: row, letter: null, loading: true, error: null });
    try {
      const letter = await fetchAdminCoverLetter(userId, row.id);
      if (!alive.current) return;
      setOverlay((cur) => (cur && cur.kind === 'letter' && cur.meta.id === row.id
        ? { ...cur, letter, loading: false } : cur));
    } catch (e: unknown) {
      if (!alive.current) return;
      const msg = (e as { message?: string })?.message || 'Could not load this letter.';
      setOverlay((cur) => (cur && cur.kind === 'letter' && cur.meta.id === row.id
        ? { ...cur, loading: false, error: msg } : cur));
    }
  }, [userId]);

  // ── derived ──────────────────────────────────────────────────────────────────
  const grouped = useMemo(() => {
    const list = arr(tpls?.templates);
    const g: Record<'suggested' | 'available' | 'not_applicable', AdminNotifyTemplate[]> = {
      suggested: [], available: [], not_applicable: [],
    };
    list.forEach((t) => {
      const r = t?.relevance;
      if (r === 'suggested') g.suggested.push(t);
      else if (r === 'not_applicable') g.not_applicable.push(t);
      else g.available.push(t);
    });
    return g;
  }, [tpls]);

  // ── no user id ───────────────────────────────────────────────────────────────
  if (!userId) {
    return (
      <SafeAreaView style={s.safe}>
        <Stack.Screen options={{ headerShown: false }} />
        <TopBar title="User 360" sub="Open with a user id" onBack={() => router.back()} onRefresh={null} />
        <View style={s.card}>
          <Text style={s.sect}>Pick a user</Text>
          <Text style={s.sectSub}>
            This screen opens as /(admin)/user-360?userId=N. Browse the list and tap a person to get here.
          </Text>
          <TouchableOpacity style={s.primaryBtn} activeOpacity={0.85} onPress={() => router.push('/(admin)/registered-users')}>
            <Ionicons name="people-outline" size={15} color="#fff" />
            <Text style={s.primaryBtnT}>Browse registered users</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.safe}>
      <Stack.Screen options={{ headerShown: false }} />
      <TopBar
        title="User 360"
        sub={ov?.user ? whoName : `User ${userId}`}
        onBack={() => router.back()}
        onRefresh={() => { setRefreshing(true); onRefresh(); }}
      />

      {loading ? (
        <View style={s.center}>
          <ActivityIndicator size="large" color={C.blue} />
          <Text style={s.centerT}>Loading this user…</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 14, paddingBottom: 48 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.blue} />}
        >
          {fatal ? (
            <View style={s.card}>
              <View style={s.errRow}>
                <Ionicons name="warning-outline" size={18} color={C.rose} />
                <Text style={s.errT}>{fatal}</Text>
              </View>
              <TouchableOpacity style={s.primaryBtn} activeOpacity={0.85} onPress={onRefresh}>
                <Ionicons name="refresh" size={15} color="#fff" />
                <Text style={s.primaryBtnT}>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : null}

          {ov && user ? (
            <>
              {/* ── 1. HEADER ─────────────────────────────────────────────── */}
              <View style={s.card}>
                <View style={s.headRow}>
                  {ov.assets?.photo?.has && photoSrc && !photoFailed ? (
                    <Image source={photoSrc} style={s.avatarImg} onError={() => setPhotoFailed(true)} />
                  ) : (
                    <LinearGradient
                      colors={gradFor(user.id ?? userId)}
                      start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
                      style={s.avatarImg}
                    >
                      <Text style={s.avatarT}>{initials(user.full_name, user.email)}</Text>
                    </LinearGradient>
                  )}
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={s.nm} numberOfLines={2}>{whoName}</Text>
                    <Text style={s.nmSub} numberOfLines={2} selectable>
                      {user.email || '—'} · id {String(user.id ?? userId)}
                    </Text>
                    <View style={s.chips}>
                      {has(user.oauth_provider)
                        ? <Chip label={String(user.oauth_provider)} tone={C.blueDeep} />
                        : <Chip label="email signup" />}
                      {String(user.role || '').toLowerCase() === 'admin' ? <Chip label="admin" tone={C.purple} /> : null}
                    </View>
                  </View>
                </View>

                <View style={s.chips}>
                  <Chip label="Joined" value={dateLabel(user.created_at) || '—'} />
                  <Chip
                    label={user.last_seen_at ? 'Last seen' : 'Last event'}
                    value={(() => {
                      const seen = user.last_seen_at || ov.activity?.last_event || null;
                      return seen ? (timeAgo(seen) || dateLabel(seen)) : 'never';
                    })()}
                  />
                </View>

                {/* completeness */}
                <View style={s.compBox}>
                  <View style={s.compTop}>
                    <Text style={s.lbl}>PROFILE COMPLETENESS</Text>
                    <Text style={[s.compPct, { color: compTone(ov.completeness?.percent) }]}>
                      {Math.max(0, Math.min(100, Math.round(Number(ov.completeness?.percent) || 0)))}%
                    </Text>
                  </View>
                  <View style={s.compTrack}>
                    <View style={{
                      width: `${Math.max(0, Math.min(100, Math.round(Number(ov.completeness?.percent) || 0)))}%`,
                      height: '100%', borderRadius: 100, backgroundColor: compTone(ov.completeness?.percent),
                    }} />
                  </View>
                  <View style={s.chips}>
                    {arr(ov.completeness?.missing).length
                      ? arr(ov.completeness?.missing).map((m) => (
                        <Chip key={String(m)} label={String(m).replace(/_/g, ' ')} tone={C.rose} />
                      ))
                      : <Chip label="Nothing missing" tone={C.emerald} />}
                  </View>
                </View>

                {arr(ov.notes).map((n, i) => <Note key={i} text={String(n)} tone={C.blueDeep} />)}
                {!hasSession ? (
                  <Note tone={C.rose} text="No admin session token was found on this device — the file endpoints will refuse to serve documents." />
                ) : null}
              </View>

              {/* ── 2. AT A GLANCE ────────────────────────────────────────── */}
              <Section title="At a glance" sub="How many — the items themselves are further down.">
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.statRow}>
                  <Stat
                    n={fmt(ov.credits?.remaining)}
                    suffix={` / ${fmt(ov.credits?.total)}`}
                    label="Credits"
                    sub={ov.credits?.expiry_date
                      ? `expires ${dateLabel(ov.credits.expiry_date)}`
                      : ov.credits?.last_purchase_date ? `last buy ${dateLabel(ov.credits.last_purchase_date)}` : 'no expiry set'}
                    tone={C.emerald}
                    icon="wallet-outline"
                  />
                  <Stat n={fmt(ov.activity?.saved_jobs)} label="Saved jobs" tone={C.blue} icon="bookmark-outline" />
                  {/* ⚠️ This is NOT the same number as the Applications tab, and the difference is
                      the honest part. Here the server takes MAX(emailed, applied-cover-letters) — a
                      conservative de-dupe, so it is the closest thing to "applications made". The tab
                      lists both record sets unioned, so its total is higher and double-counts. The
                      previous caption claimed the opposite ("union — one act can count twice"), which
                      described the tab, not this tile. */}
                  <Stat
                    n={fmt(ov.activity?.applications)}
                    label="Applications"
                    sub="de-duplicated best estimate"
                    tone={C.amber}
                    icon="paper-plane-outline"
                  />
                  <Stat n={fmt(ov.activity?.cover_letters)} label="Cover letters" tone={C.purple} icon="document-attach-outline" />
                  <Stat n={fmt(ov.activity?.searches)} label="Searches" tone={C.teal} icon="search-outline" />
                  <Stat
                    n={fmt(ov.activity?.events_30d)}
                    label="Events · 30d"
                    sub={ov.activity?.first_event ? `first ${dateLabel(ov.activity.first_event)}` : ''}
                    tone={C.blueDeep}
                    icon="pulse-outline"
                  />
                  <Stat
                    n={ov.push?.has_token ? 'Yes' : 'No'}
                    label="Push reachable"
                    sub={ov.push?.platform ? String(ov.push.platform) : ov.push?.has_token ? '' : 'no token'}
                    tone={ov.push?.has_token ? C.emerald : C.rose}
                    icon="notifications-outline"
                  />
                </ScrollView>
                <Text style={s.footnote}>
                  “Application records” is a union of an emailed application and its cover letter marked applied — open the
                  Applications tab for the server’s own breakdown.
                </Text>
                {arr(ov.credits?.recent).length ? (
                  <View style={s.chips}>
                    {arr(ov.credits?.recent).slice(0, 4).map((x, i) => {
                      const amt = Number(x.amount) || 0;
                      return (
                        <Chip
                          key={i}
                          label={`${amt > 0 ? '+' : ''}${amt} ${x.type || x.description || 'credit'}`}
                          value={dateLabel(x.created_at)}
                          tone={amt > 0 ? C.emerald : undefined}
                        />
                      );
                    })}
                  </View>
                ) : null}
                {ov.insights ? (
                  <View style={s.chips}>
                    {has(ov.insights.field) ? <Chip label="Field" value={String(ov.insights.field)} /> : null}
                    {ov.insights.strong_matches != null
                      ? <Chip label="Strong matches" value={fmt(ov.insights.strong_matches)} tone={C.emerald} /> : null}
                    {ov.insights.days_since_last_seen != null
                      ? <Chip label="Last seen" value={`${fmt(ov.insights.days_since_last_seen)}d ago`} /> : null}
                    {ov.insights.days_since_signup != null
                      ? <Chip label="Signed up" value={`${fmt(ov.insights.days_since_signup)}d ago`} /> : null}
                  </View>
                ) : null}
              </Section>

              {/* ── 3. PROFILE DETAILS ────────────────────────────────────── */}
              <Section title="Profile details">
                <KV k="Phone" v={user.phone_number} important />
                <KV k="Date of birth" v={user.date_of_birth ? dateLabel(user.date_of_birth) : ''} important />
                <KV k="Address" v={user.address} important />
                <KV k="City / country" v={[user.city, user.country].filter(has).join(', ')} important />
                <KV k="Gender" v={user.gender} />
                <KV k="Nationality" v={user.nationality} />
                {has(user.registration_ip) || has(user.last_login_ip) ? (
                  <Text style={s.footnote}>
                    {[has(user.registration_ip) ? `signup ${user.registration_ip}` : null,
                      has(user.last_login_ip) ? `last login ${user.last_login_ip}` : null].filter(Boolean).join(' · ')}
                  </Text>
                ) : null}
                <View style={s.legendRow}>
                  <View style={s.kvDot} />
                  <Text style={s.footnote}>amber = a blank field that blocks a complete application</Text>
                </View>
              </Section>

              {/* ── 4. DOCUMENTS ──────────────────────────────────────────── */}
              <Section title="Documents" sub="Served from the admin-only file endpoint.">
                <DocRow
                  icon="document-text-outline"
                  label="Résumé"
                  sub={ov.assets?.resume?.has ? (ov.assets.resume.filename || 'uploaded file') : 'No résumé uploaded'}
                  present={!!ov.assets?.resume?.has}
                  onOpen={() => setOverlay({
                    kind: 'doc', doc: 'resume', label: 'Résumé',
                    sub: ov.assets?.resume?.filename || `resume-user-${userId}`,
                  })}
                />
                <DocRow
                  icon="image-outline"
                  label="Profile photo"
                  sub={ov.assets?.photo?.has ? 'Uploaded' : 'No photo uploaded'}
                  present={!!ov.assets?.photo?.has}
                  onOpen={() => setOverlay({ kind: 'doc', doc: 'photo', label: 'Profile photo', sub: whoName })}
                />
                <DocRow
                  icon="create-outline"
                  label="Signature"
                  sub={ov.assets?.signature?.has ? 'Uploaded' : 'No signature uploaded'}
                  present={!!ov.assets?.signature?.has}
                  onOpen={() => setOverlay({ kind: 'doc', doc: 'signature', label: 'Signature', sub: whoName })}
                />
              </Section>

              {/* ── 5. RÉSUMÉ INSIGHT ─────────────────────────────────────── */}
              <ResumeSection ov={ov} />

              {/* ── 6. EVERYTHING THEY HAVE DONE ──────────────────────────── */}
              <Section title="Everything they have done" sub="The actual items behind the counters above — open a tab to load it.">
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.tabBar}>
                  {TABS.map((t) => {
                    const st = tabs[t.k];
                    const n = st.total != null ? st.total : st.seed;
                    const on = t.k === activeTab;
                    return (
                      <TouchableOpacity
                        key={t.k}
                        style={[s.tab, on && s.tabOn]}
                        activeOpacity={0.85}
                        onPress={() => setActiveTab(t.k)}
                      >
                        <Ionicons name={t.icon} size={13} color={on ? '#fff' : C.textMuted} />
                        <Text style={[s.tabT, { color: on ? '#fff' : C.textMuted }]}>{t.label}</Text>
                        {n != null ? (
                          <View style={[s.tabCount, on && { backgroundColor: 'rgba(255,255,255,0.24)' }]}>
                            <Text style={[s.tabCountT, on && { color: '#fff' }]}>{fmt(n)}</Text>
                          </View>
                        ) : null}
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
                <TabPanel
                  kind={activeTab}
                  st={tabs[activeTab]}
                  def={TABS.find((t) => t.k === activeTab)!}
                  onMore={() => loadTab(activeTab, tabs[activeTab].rows.length)}
                  onRetry={() => loadTab(activeTab, 0)}
                  onOpenLetter={openLetter}
                />
              </Section>

              {/* ── 7. BEST MATCHED JOBS ──────────────────────────────────── */}
              <Section title="Best matched jobs" sub="The same score the user's own feed shows.">
                {jobsLoading ? (
                  <Skel text="Scoring the feed against this résumé…" />
                ) : jobsErr ? (
                  <RetryBox text={jobsErr} onRetry={loadJobs} />
                ) : !matched || !matched.success ? (
                  <Empty icon="briefcase-outline" text="Matches are unavailable for this user right now." />
                ) : matched.noProfile ? (
                  <>
                    <Note text="No parsed résumé for this user, so there is nothing to match against. Match scores stay hidden until a résumé is uploaded and parsed." />
                    <Empty icon="cloud-upload-outline" text="Try the “upload your résumé” nudge below." />
                  </>
                ) : !arr(matched.jobs).length ? (
                  <Empty icon="briefcase-outline" text={matched.note || matched.reason || 'No matching jobs in the feed right now.'} />
                ) : (
                  <>
                    {matched.advertisable === false ? (
                      <Note
                        tone={C.rose}
                        strong="Not advertisable"
                        text="Nothing cleared the match floor, so this is an unfiltered admin-only list — a row here can score 0%. Do not quote these scores to the user."
                      />
                    ) : null}
                    {has(matched.note) ? <Note text={String(matched.note)} tone={C.blueDeep} /> : null}
                    {arr(matched.jobs).map((j, i) => (
                      <JobRow
                        key={has(j.id) ? `job-${j.id}` : `job-idx-${i}`}
                        job={j}
                        result={results[`job:${j.id}`]}
                        busy={sending}
                        onSend={() => askJobSend(j)}
                      />
                    ))}
                  </>
                )}
              </Section>

              {/* ── 8. SEND A NOTIFICATION ────────────────────────────────── */}
              <Section
                title="Send a notification"
                sub="Every send asks first and shows the exact text that lands on the phone."
              >
                <LiveTargetWarning what="Sending here pushes to this person's real phone" />
                {tplLoading ? (
                  <Skel text="Loading templates…" />
                ) : tplErr ? (
                  <RetryBox text={tplErr} onRetry={loadTemplates} />
                ) : (
                  <>
                    {noToken ? (
                      <Note tone={C.rose} text="This user has no push token — anything sent is stored in-app only and will not reach their phone." />
                    ) : null}
                    {tpls?.userKnown === false ? (
                      <Note tone={C.rose} text="The copy below is the GENERIC render — the server could not resolve this user, so nothing here is personalised." />
                    ) : null}
                    {has(tpls?.warning) ? <Note text={String(tpls?.warning)} /> : null}
                    <View style={s.chips}>
                      {Object.entries(ov.push?.preferences || {}).map(([k, on]) => (
                        <Chip key={k} label={k.replace(/_/g, ' ')} value={on ? 'on' : 'off'} tone={on ? C.emerald : C.rose} />
                      ))}
                    </View>
                    <Text style={s.footnote}>
                      Titles are delivered at most {LIM.title} characters and bodies {LIM.body}. A send can still be blocked by the
                      rails (opt-out, no push token, or the same template inside 72h) — the result line says which.
                    </Text>

                    {!arr(tpls?.templates).length ? (
                      <Empty icon="notifications-off-outline" text="No templates available for this user." />
                    ) : (
                      (['suggested', 'available', 'not_applicable'] as const).map((rel) => {
                        const list = grouped[rel];
                        if (!list.length) return null;
                        const heading = rel === 'suggested' ? 'Suggested for this user'
                          : rel === 'not_applicable' ? 'Not applicable right now' : 'Other templates';
                        return (
                          <View key={rel}>
                            <Text style={[s.lbl, { marginTop: 16 }]}>{heading.toUpperCase()}</Text>
                            {list.map((t) => (
                              <TemplateCard
                                key={`${t.key}:${tplVersion}`}
                                tpl={t}
                                rel={rel}
                                result={results[`tpl:${t.key}`]}
                                busy={sending}
                                onSend={askTemplateSend}
                              />
                            ))}
                          </View>
                        );
                      })
                    )}
                  </>
                )}
              </Section>

              {/* ── history ───────────────────────────────────────────────── */}
              <Section title="Recent notifications">
                {!arr(ov.recent_notifications).length ? (
                  <Empty icon="notifications-outline" text="No notifications yet." />
                ) : arr(ov.recent_notifications).map((n, i) => (
                  <View key={i} style={s.arow}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <View style={s.arowTitleRow}>
                        <Text style={s.arowT} numberOfLines={2}>{n.title || n.type || 'Notification'}</Text>
                        {!n.is_read ? <Pill text="unread" tone={C.blueDeep} /> : null}
                      </View>
                      {has(n.message) ? <Text style={s.arowPv} numberOfLines={3}>{plain(n.message)}</Text> : null}
                      <Text style={s.arowM} numberOfLines={1}>{[n.type, clock(n.created_at)].filter(has).join(' · ')}</Text>
                    </View>
                  </View>
                ))}
              </Section>

              <Section title="Admin sends" sub="What has already been pushed to this person.">
                {!arr(ov.admin_sends).length ? (
                  <Empty icon="send-outline" text="Nothing sent to this user yet." />
                ) : arr(ov.admin_sends).map((row, i) => {
                  const err = String(row.push_error || '');
                  const blockedWhy = LOG_BLOCKED[err];
                  const tone = row.push_ok === true ? C.emerald : blockedWhy ? C.rose : C.amber;
                  const label = row.push_ok === true ? 'delivered'
                    : blockedWhy ? `blocked · ${blockedWhy}`
                      : `in-app only${err ? ` · ${err}` : ''}`;
                  return (
                    <View key={i} style={s.arow}>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <View style={s.arowTitleRow}>
                          <Text style={s.arowT} numberOfLines={2}>{row.title || row.template_key || 'Send'}</Text>
                          <Pill text={label} tone={tone} />
                        </View>
                        <Text style={s.arowM} numberOfLines={2}>
                          {[row.template_key, clock(row.created_at),
                            has(row.sent_by_email) ? `by ${row.sent_by_email}` : has(row.sent_by) ? `by ${row.sent_by}` : null]
                            .filter(has).join(' · ')}
                        </Text>
                      </View>
                    </View>
                  );
                })}
              </Section>
            </>
          ) : null}
        </ScrollView>
      )}

      {/* EXACTLY ONE modal is ever mounted — never nest them (build 87 hard-crashed iOS). */}
      {overlay ? (
        <Modal
          visible
          transparent={overlay.kind === 'confirm'}
          animationType="slide"
          statusBarTranslucent
          onRequestClose={() => {
            if (sending) return;                       // a send is in flight — the back button must not orphan it
            if (overlay.kind === 'confirm') cancelConfirm(); else setOverlay(null);
          }}
        >
          {overlay.kind === 'doc' ? (
            <DocViewer ov={overlay} userId={userId} onClose={() => setOverlay(null)} />
          ) : overlay.kind === 'letter' ? (
            <LetterViewer ov={overlay} onClose={() => setOverlay(null)} />
          ) : (
            <ConfirmSheet ov={overlay} sending={sending} onCancel={cancelConfirm} onGo={runConfirmed} />
          )}
        </Modal>
      ) : null}
    </SafeAreaView>
  );
}

const compTone = (p?: number | null): string => {
  const v = Math.max(0, Math.min(100, Math.round(Number(p) || 0)));
  return v >= 80 ? C.emerald : v >= 50 ? C.amber : C.rose;
};

// ─── screen-level pieces ───
function TopBar({ title, sub, onBack, onRefresh }: {
  title: string; sub?: string; onBack: () => void; onRefresh: (() => void) | null;
}) {
  return (
    <View style={s.topBar}>
      <TouchableOpacity onPress={onBack} style={s.hBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
        <Ionicons name="chevron-back" size={22} color={C.ink} />
      </TouchableOpacity>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={s.hTitle}>{title}</Text>
        {!!sub && <Text style={s.hSub} numberOfLines={1}>{sub}</Text>}
      </View>
      {onRefresh ? (
        <TouchableOpacity onPress={onRefresh} style={s.hBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="refresh" size={18} color={C.ink} />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

function Stat({ n, suffix, label, sub, tone, icon }: {
  n: string; suffix?: string; label: string; sub?: string; tone: string; icon: IconName;
}) {
  return (
    <View style={s.stat}>
      <View style={[s.statIcon, { backgroundColor: `${tone}18` }]}>
        <Ionicons name={icon} size={14} color={tone} />
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
        <Text style={s.statN} numberOfLines={1}>{n}</Text>
        {!!suffix && <Text style={s.statSuffix}>{suffix}</Text>}
      </View>
      <Text style={s.statL} numberOfLines={2}>{label}</Text>
      {!!sub && <Text style={s.statS} numberOfLines={2}>{sub}</Text>}
    </View>
  );
}

function DocRow({ icon, label, sub, present, onOpen }: {
  icon: IconName; label: string; sub: string; present: boolean; onOpen: () => void;
}) {
  return (
    <View style={s.docRow}>
      <View style={[s.docIcon, { backgroundColor: present ? `${C.blueDeep}14` : C.bgSoft }]}>
        <Ionicons name={icon} size={17} color={present ? C.blueDeep : C.textFaint} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={s.docLabel}>{label}</Text>
        <Text style={s.docSub} numberOfLines={2}>{sub}</Text>
      </View>
      {present ? (
        <TouchableOpacity style={s.ghostBtn} activeOpacity={0.8} onPress={onOpen}>
          <Ionicons name="open-outline" size={13} color={C.blueDeep} />
          <Text style={s.ghostBtnT}>Open</Text>
        </TouchableOpacity>
      ) : (
        <Pill text="missing" tone={C.rose} />
      )}
    </View>
  );
}

function ResumeSection({ ov }: { ov: AdminUserOverview }) {
  const r = ov.resume;
  const st = String(r?.parse_status || 'none').toLowerCase();
  const tone = st === 'done' ? C.emerald : st === 'failed' || st === 'error' ? C.rose : st === 'none' ? C.textMuted : C.amber;
  // ⚠️ The résumé parser stores some of these GROUPED, so the column comes back as string[][] —
  // technical_skills is [["SQL Server","MySQL"],["C#","C++",…]] on live data. Rendering it as a flat
  // list printed raw JSON into the chips. Flatten one level and coerce, so a grouped column, a flat
  // one, or a stray object all end up as readable chips.
  const flat = (v: unknown): string[] =>
    arr(v as any[])
      .flatMap((x) => (Array.isArray(x) ? x : [x]))
      .map((x) => (typeof x === 'string' ? x : x == null ? '' : String(x)))
      .map((x) => x.trim())
      .filter(Boolean);
  const skills = flat(r?.skills), tech = flat(r?.technical_skills), soft = flat(r?.soft_skills);
  const titles = flat(r?.job_titles), inds = flat(r?.industries), edu = flat(r?.education), langs = flat(r?.languages);

  if (st !== 'done' && !skills.length && !tech.length) {
    return (
      <Section title="Résumé insight">
        <View style={s.chips}><Pill text={`parse: ${st}`} tone={tone} /></View>
        <Empty
          icon="document-outline"
          text="No parsed résumé yet — job matching and personalised nudges stay generic until one is uploaded and parsed."
        />
      </Section>
    );
  }
  return (
    <Section title="Résumé insight">
      <View style={s.chips}>
        <Pill text={`parse: ${st}`} tone={tone} />
        {r?.experience_years != null ? <Chip label="Experience" value={`${r.experience_years} yrs`} /> : null}
        {r?.parsed_at ? <Chip label="Parsed" value={dateLabel(r.parsed_at)} /> : null}
      </View>
      {has(r?.summary) ? <Text style={s.summary}>{r.summary}</Text> : null}
      <Text style={[s.lbl, { marginTop: 12 }]}>SKILLS</Text>
      <ChipRow items={skills} max={30} />
      {tech.length ? <><Text style={[s.lbl, { marginTop: 12 }]}>TECHNICAL SKILLS</Text><ChipRow items={tech} max={30} /></> : null}
      {soft.length ? <><Text style={[s.lbl, { marginTop: 12 }]}>SOFT SKILLS</Text><ChipRow items={soft} max={20} /></> : null}
      <Text style={[s.lbl, { marginTop: 12 }]}>JOB TITLES</Text>
      <ChipRow items={titles} max={15} />
      <Text style={[s.lbl, { marginTop: 12 }]}>INDUSTRIES</Text>
      <ChipRow items={inds} max={15} />
      {edu.length ? <><Text style={[s.lbl, { marginTop: 12 }]}>EDUCATION</Text><ChipRow items={edu} max={10} /></> : null}
      {langs.length ? <><Text style={[s.lbl, { marginTop: 12 }]}>LANGUAGES</Text><ChipRow items={langs} max={10} /></> : null}
    </Section>
  );
}

function RetryBox({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <View>
      <View style={s.errRow}>
        <Ionicons name="warning-outline" size={16} color={C.rose} />
        <Text style={s.errT}>{text}</Text>
      </View>
      <TouchableOpacity style={s.ghostBtnWide} activeOpacity={0.8} onPress={onRetry}>
        <Ionicons name="refresh" size={13} color={C.blueDeep} />
        <Text style={s.ghostBtnT}>Retry</Text>
      </TouchableOpacity>
    </View>
  );
}

function TabPanel({ kind, st, def, onMore, onRetry, onOpenLetter }: {
  kind: AdminActivityKind;
  st: TabState;
  def: { label: string; empty: string };
  onMore: () => void; onRetry: () => void;
  onOpenLetter: (r: AdminActivityCoverLetter) => void;
}) {
  if (st.loading && !st.rows.length) return <Skel text={`Loading ${def.label.toLowerCase()}…`} />;
  if (st.error) return <RetryBox text={st.error} onRetry={onRetry} />;

  const sources = st.meta?.sources && typeof st.meta.sources === 'object' ? st.meta.sources : null;
  const srcText = sources && Object.keys(sources).length > 1
    ? Object.keys(sources).map((x) => `${x.replace(/_/g, ' ')} ${fmt(sources[x])}`).join('  +  ')
    : null;
  // ⚠️ Never present a total the server has told us not to trust — meta.note explains that the
  // applications total is a UNION of two records of the same act, and it has to reach the screen.
  const metaBox = st.meta?.note || srcText
    ? <Note tone={C.amber} strong={srcText} text={String(st.meta?.note || '')} />
    : null;

  if (!st.rows.length) {
    return (
      <>
        {metaBox}
        {st.unavailable ? <Note tone={C.rose} text={`${st.unavailable} — an empty list here means “unknown”, not “none”.`} /> : null}
        <Empty text={def.empty} />
      </>
    );
  }
  return (
    <>
      {metaBox}
      {st.unavailable ? <Note tone={C.rose} text={String(st.unavailable)} /> : null}
      {kind === 'credits' && st.meta?.total_credits_used != null ? (
        <Text style={s.footnote}>Total credits used: {fmt(st.meta.total_credits_used)}</Text>
      ) : null}
      {st.rows.map((row, i) => (
        <ActivityRow key={`${kind}-${i}`} kind={kind} row={row} onOpenLetter={onOpenLetter} />
      ))}
      <Text style={s.shown}>
        Showing {fmt(st.rows.length)}{st.total != null ? ` of ${fmt(st.total)} record${st.total === 1 ? '' : 's'}` : ''}
      </Text>
      {!st.done ? (
        <TouchableOpacity style={s.ghostBtnWide} activeOpacity={0.8} onPress={onMore} disabled={st.loading}>
          {st.loading
            ? <ActivityIndicator color={C.blueDeep} size="small" />
            : <><Ionicons name="chevron-down" size={13} color={C.blueDeep} /><Text style={s.ghostBtnT}>Load more</Text></>}
        </TouchableOpacity>
      ) : null}
    </>
  );
}

function JobRow({ job, result, busy, onSend }: {
  job: AdminMatchedJob; result?: Outcome | null; busy: boolean; onSend: () => void;
}) {
  const mRaw = Number(job.match);
  const m = isFinite(mRaw) ? Math.round(mRaw) : null;
  const tone = matchTone(m);
  // Without an id the server cannot resolve the job, so the send is refused here rather than
  // producing a job_not_found round-trip that reads like a rail block.
  const sendable = has(job.id);
  const meta = [job.employer_name || job.company, job.location, job.work_mode, job.job_type, job.field, job.salary]
    .filter(has).join(' · ');
  return (
    <View style={s.jrow}>
      <View style={s.jrowTop}>
        <View style={[s.matchBadge, { backgroundColor: `${tone}18`, borderColor: `${tone}33` }]}>
          <Text style={[s.matchBadgeT, { color: tone }]}>{m == null ? '—' : `${m}%`}</Text>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.jt} numberOfLines={2}>{job.title || 'Untitled role'}</Text>
          <Text style={s.jm} numberOfLines={3}>{meta || '—'}</Text>
          <OpenLink url={safeUrl(job.url || job.job_url)} label="open posting ↗" />
          {arr(job.skills).length ? (
            <View style={s.chips}>
              {arr(job.skills).filter(has).slice(0, 6).map((sk, i) => <Chip key={`${sk}-${i}`} label={String(sk)} />)}
            </View>
          ) : null}
        </View>
      </View>
      <TouchableOpacity
        style={[s.jSend, (busy || !sendable) && s.sendBtnOff]}
        activeOpacity={0.85}
        disabled={busy || !sendable}
        onPress={onSend}
      >
        <Ionicons name="send" size={13} color="#fff" />
        <Text style={s.sendBtnT}>{sendable ? 'Send this job' : 'No job id — cannot send'}</Text>
      </TouchableOpacity>
      <ResultLine out={result} />
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg, paddingTop: Platform.OS === 'android' ? 28 : 0 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  centerT: { color: C.textMuted, fontSize: 13, fontWeight: '600' },

  topBar: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingTop: 8, paddingBottom: 10 },
  hBtn: { width: 38, height: 38, borderRadius: 12, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  hTitle: { fontSize: 19, fontWeight: '800', color: C.ink, letterSpacing: -0.4 },
  hSub: { fontSize: 12, color: C.textMuted, marginTop: 1 },

  card: {
    backgroundColor: C.surface, borderRadius: 18, borderWidth: 1, borderColor: C.border,
    padding: 14, marginBottom: 12,
    shadowColor: '#0F172A', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.05, shadowRadius: 14, elevation: 2,
  },
  sectHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 10 },
  sect: { fontSize: 15.5, fontWeight: '800', color: C.ink, letterSpacing: -0.3 },
  sectSub: { fontSize: 11.5, color: C.textMuted, marginTop: 2, lineHeight: 16 },

  headRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatarImg: { width: 62, height: 62, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bgSoft },
  avatarT: { color: '#fff', fontWeight: '800', fontSize: 21 },
  nm: { fontSize: 17.5, fontWeight: '800', color: C.ink, letterSpacing: -0.4 },
  nmSub: { fontSize: 12, color: C.textMuted, marginTop: 2 },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  chip: { paddingHorizontal: 9, paddingVertical: 5, borderRadius: 100, backgroundColor: C.bgSoft, borderWidth: 1, borderColor: C.border, maxWidth: '100%' },
  chipT: { fontSize: 11, fontWeight: '600', color: C.inkSoft },
  chipB: { fontWeight: '800', color: C.ink },
  pill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 100, maxWidth: '100%' },
  pillT: { fontSize: 10, fontWeight: '800', letterSpacing: 0.1 },

  compBox: { marginTop: 14, backgroundColor: C.bgSoft, borderRadius: 14, padding: 12 },
  compTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  compPct: { fontSize: 20, fontWeight: '800', letterSpacing: -0.6 },
  compTrack: { marginTop: 8, height: 7, borderRadius: 100, backgroundColor: 'rgba(11,15,34,0.08)', overflow: 'hidden' },

  statRow: { gap: 10, paddingVertical: 2, paddingRight: 4 },
  stat: { width: 132, backgroundColor: C.bgSoft, borderRadius: 14, padding: 11 },
  statIcon: { width: 26, height: 26, borderRadius: 9, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  statN: { fontSize: 21, fontWeight: '800', color: C.ink, letterSpacing: -0.7 },
  statSuffix: { fontSize: 11.5, fontWeight: '700', color: C.textMuted, marginLeft: 2 },
  statL: { fontSize: 11, fontWeight: '700', color: C.inkSoft, marginTop: 3 },
  statS: { fontSize: 10, fontWeight: '600', color: C.textFaint, marginTop: 2, lineHeight: 13 },

  kv: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 9, borderTopWidth: 1, borderTopColor: C.border },
  kvK: { width: 116, fontSize: 12, fontWeight: '600', color: C.textMuted },
  kvRight: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
  kvV: { flex: 1, fontSize: 12.5, fontWeight: '700', color: C.ink },
  kvBlank: { color: C.textFaint, fontWeight: '600' },
  kvDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.amber },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },

  docRow: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 10, borderTopWidth: 1, borderTopColor: C.border },
  docIcon: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  docLabel: { fontSize: 13.5, fontWeight: '700', color: C.ink },
  docSub: { fontSize: 11.5, color: C.textMuted, marginTop: 2 },

  summary: { fontSize: 12.5, color: C.textMuted, lineHeight: 18, marginTop: 10 },
  lbl: { fontSize: 10, fontWeight: '800', color: C.textFaint, letterSpacing: 0.8 },
  dash: { fontSize: 12.5, color: C.textFaint, marginTop: 6 },

  tabBar: { gap: 7, paddingVertical: 2, paddingRight: 4 },
  tab: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 11, paddingVertical: 8, borderRadius: 100, backgroundColor: C.bgSoft, borderWidth: 1, borderColor: C.border },
  tabOn: { backgroundColor: C.blueDeep, borderColor: C.blueDeep },
  tabT: { fontSize: 12, fontWeight: '700' },
  tabCount: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 100, backgroundColor: 'rgba(11,15,34,0.07)' },
  tabCountT: { fontSize: 10, fontWeight: '800', color: C.inkSoft },

  arow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 11, borderTopWidth: 1, borderTopColor: C.border },
  arowTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  arowT: { fontSize: 13, fontWeight: '700', color: C.ink, flexShrink: 1 },
  arowM: { fontSize: 11.5, color: C.textMuted, marginTop: 3, lineHeight: 16 },
  arowPv: { fontSize: 11.5, color: C.textFaint, marginTop: 5, lineHeight: 16 },
  mono: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  creditBadge: { minWidth: 44, paddingHorizontal: 8, paddingVertical: 6, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  creditBadgeT: { fontSize: 12, fontWeight: '800' },
  shown: { fontSize: 11, color: C.textFaint, fontWeight: '600', marginTop: 10, textAlign: 'center' },
  link: { fontSize: 11.5, fontWeight: '700', color: C.blueDeep, marginTop: 4 },

  jrow: { paddingVertical: 12, borderTopWidth: 1, borderTopColor: C.border },
  jrowTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  matchBadge: { minWidth: 48, paddingHorizontal: 8, paddingVertical: 7, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  matchBadgeT: { fontSize: 13, fontWeight: '800', letterSpacing: -0.3 },
  jt: { fontSize: 13.5, fontWeight: '700', color: C.ink },
  jm: { fontSize: 11.5, color: C.textMuted, marginTop: 3, lineHeight: 16 },
  jSend: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 10, height: 38, borderRadius: 12, backgroundColor: C.blueDeep },

  tcard: { backgroundColor: C.bgSoft, borderRadius: 16, borderWidth: 1, borderColor: C.border, padding: 12, marginTop: 10 },
  tcardSug: { backgroundColor: `${C.blueDeep}0D`, borderColor: `${C.blueDeep}33` },
  tcardNa: { opacity: 0.62 },
  tcardHead: { flexDirection: 'row', alignItems: 'center', gap: 7, flexWrap: 'wrap' },
  tcardName: { fontSize: 13.5, fontWeight: '800', color: C.ink, flexShrink: 1 },
  tcardDesc: { fontSize: 11.5, color: C.textMuted, marginTop: 7, lineHeight: 16 },
  tcardReason: { fontSize: 11, color: C.blueDeep, marginTop: 5, fontWeight: '600', lineHeight: 15 },
  lblRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 11, marginBottom: 5 },
  cnt: { fontSize: 10, fontWeight: '700', color: C.textFaint },
  input: {
    backgroundColor: C.surface, borderWidth: 1, borderColor: C.borderHi, borderRadius: 10,
    paddingHorizontal: 11, paddingVertical: 9, fontSize: 12.5, color: C.ink,
  },
  textarea: { minHeight: 74, textAlignVertical: 'top' },
  routeT: { fontSize: 10, color: C.textFaint, marginTop: 8 },
  editState: { fontSize: 10.5, color: C.textMuted, fontWeight: '600', marginTop: 9, lineHeight: 15 },
  tcardActions: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 10 },
  sendBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, height: 36, paddingHorizontal: 18, borderRadius: 11, backgroundColor: C.blueDeep },
  sendBtnOff: { opacity: 0.5 },
  sendBtnT: { color: '#fff', fontSize: 12.5, fontWeight: '800' },
  unlock: { fontSize: 11.5, fontWeight: '700', color: C.rose, textDecorationLine: 'underline' },
  inlineErr: { fontSize: 11.5, color: C.rose, fontWeight: '700', marginTop: 8 },

  ghostBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 11, paddingVertical: 8, borderRadius: 10, backgroundColor: C.surface, borderWidth: 1, borderColor: C.borderHi },
  ghostBtnWide: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 10, height: 38, borderRadius: 12, backgroundColor: C.surface, borderWidth: 1, borderColor: C.borderHi },
  ghostBtnT: { fontSize: 12, fontWeight: '800', color: C.blueDeep },
  primaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, marginTop: 12, height: 44, borderRadius: 13, backgroundColor: C.blueDeep },
  primaryBtnT: { color: '#fff', fontSize: 13.5, fontWeight: '800' },

  note: { flexDirection: 'row', gap: 8, marginTop: 10, padding: 10, borderRadius: 12, borderWidth: 1 },
  noteT: { flex: 1, fontSize: 11.5, color: C.inkSoft, fontWeight: '600', lineHeight: 16 },
  footnote: { fontSize: 10.5, color: C.textFaint, fontWeight: '600', marginTop: 8, lineHeight: 15 },
  empty: { alignItems: 'center', justifyContent: 'center', paddingVertical: 26, gap: 9 },
  emptyT: { fontSize: 12.5, color: C.textMuted, fontWeight: '600', textAlign: 'center', paddingHorizontal: 18, lineHeight: 18 },
  skel: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, paddingVertical: 26 },
  skelT: { fontSize: 12.5, color: C.textMuted, fontWeight: '600' },
  errRow: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: `${C.rose}14`, borderRadius: 12, padding: 11 },
  errT: { flex: 1, fontSize: 12, color: C.rose, fontWeight: '700', lineHeight: 17 },
  resLine: { flexDirection: 'row', gap: 7, marginTop: 9, padding: 9, borderRadius: 11, borderWidth: 1 },
  resT: { flex: 1, fontSize: 11.5, fontWeight: '700', lineHeight: 16 },

  // ── overlays ──
  mSafe: { flex: 1, backgroundColor: C.bg, paddingTop: Platform.OS === 'android' ? 24 : 52 },
  mHead: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: C.border },
  mTitle: { fontSize: 16, fontWeight: '800', color: C.ink },
  mSub: { fontSize: 11.5, color: C.textMuted, marginTop: 2 },
  mClose: { width: 34, height: 34, borderRadius: 17, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  docBody: { flex: 1, padding: 12 },
  web: { flex: 1, borderRadius: 14, overflow: 'hidden', backgroundColor: '#fff' },
  webLoading: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  docImgWrap: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
  docImg: { width: '100%', height: 420, backgroundColor: C.surface, borderRadius: 14 },
  docHint: { fontSize: 10.5, color: C.textFaint, fontWeight: '600', marginTop: 9, lineHeight: 15 },
  docUrl: { fontSize: 9.5, color: C.textFaint, marginTop: 5 },

  confirmWrap: { flex: 1, backgroundColor: 'rgba(6,10,25,0.45)' },
  confirmSheet: { backgroundColor: C.bg, borderTopLeftRadius: 26, borderTopRightRadius: 26, paddingTop: 8, maxHeight: '86%' },
  sheetGrip: { alignSelf: 'center', width: 40, height: 4, borderRadius: 100, backgroundColor: C.borderHi, marginBottom: 4 },
  confirmH: { fontSize: 18, fontWeight: '800', color: C.ink, letterSpacing: -0.4 },
  confirmWho: { fontSize: 12.5, color: C.textMuted, marginTop: 7, lineHeight: 18 },
  confirmTpl: { fontSize: 11.5, color: C.textFaint, fontWeight: '600', marginTop: 5 },
  confirmEdit: { fontSize: 11, color: C.textMuted, fontWeight: '600', marginTop: 10, lineHeight: 16 },
  pv: { backgroundColor: C.surface, borderRadius: 14, borderWidth: 1, borderColor: C.border, padding: 13, marginTop: 12 },
  pvL: { fontSize: 9.5, fontWeight: '800', color: C.textFaint, letterSpacing: 0.8 },
  pvT: { fontSize: 14, fontWeight: '800', color: C.ink, marginTop: 4, lineHeight: 19 },
  pvB: { fontSize: 12.5, color: C.inkSoft, marginTop: 4, lineHeight: 18 },
  confirmActions: { flexDirection: 'row', gap: 10, padding: 16, paddingTop: 10, borderTopWidth: 1, borderTopColor: C.border },
  cancelBtn: { flex: 1, height: 46, borderRadius: 13, backgroundColor: C.surface, borderWidth: 1, borderColor: C.borderHi, alignItems: 'center', justifyContent: 'center' },
  cancelBtnT: { fontSize: 13.5, fontWeight: '800', color: C.inkSoft },
  dangerBtn: { flex: 1.5, flexDirection: 'row', height: 46, borderRadius: 13, backgroundColor: C.rose, alignItems: 'center', justifyContent: 'center', gap: 7, paddingHorizontal: 10 },
  dangerBtnT: { fontSize: 13.5, fontWeight: '800', color: '#fff', flexShrink: 1 },
});
