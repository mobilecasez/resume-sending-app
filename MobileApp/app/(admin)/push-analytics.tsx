// AI Hub — new feature. Safe to delete without affecting existing app.
//
// Admin-only: what happened to the pushes we sent.
//
// ⚠️ THE WHOLE POINT OF THIS SCREEN IS TO NOT OVERSTATE. Push dashboards lie by default — they show
// "delivered" for something nobody confirmed, and an open rate that is really "taps we happened to
// be able to measure". The rules here:
//   • never the word "delivered". Apple and Google do not report it. The furthest honest label is
//     "Handed to Apple/Google".
//   • taps are only reported by builds carrying the tap ping. Where a campaign predates that, the
//     row says so instead of printing a 0% open rate, because 0% reads as "nobody cared" when the
//     truth is "nothing could tell us".
//   • "Active after" is a CORRELATION and is labelled as one, every time it appears.
//   • a rate over a tiny denominator is shown as the raw fraction, not a percentage.
import React, { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, SafeAreaView, RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import {
  fetchPushAnalytics, fetchPushCampaign, fetchPushVideo,
  type PushAnalytics, type PushCampaignRow, type PushFunnel, type PushWatcher, type PushSendRow,
} from '../../services/aiHubService';

const T = {
  bg: '#0B1120', card: 'rgba(255,255,255,0.055)', line: 'rgba(255,255,255,0.09)',
  ink: '#FFFFFF', muted: 'rgba(255,255,255,0.55)', faint: 'rgba(255,255,255,0.38)',
  cyan: '#22D3EE', blue: '#4F8DFF', amber: '#FBBF24', red: '#F87171', emerald: '#34D399',
  purple: '#A78BFA',
};

const RANGES = [7, 30, 90];

const fmt = (n: any) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString() : '0');
const dateLabel = (v?: string | null) => {
  if (!v) return '—';
  try { return new Date(v).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return String(v).slice(0, 16); }
};

/**
 * A rate, or the honest refusal to give one.
 * Under 20 in the denominator a percentage is noise dressed as precision, so show the fraction.
 */
function rate(num: number, den: number): string {
  if (!den) return '—';
  if (den < 20) return `${fmt(num)} of ${fmt(den)}`;
  return `${Math.round((num / den) * 100)}%`;
}

function Bar({ label, n, total, tone, sub }: { label: string; n: number; total: number; tone: string; sub?: string }) {
  const pct = total > 0 ? Math.max(0, Math.min(100, (n / total) * 100)) : 0;
  return (
    <View style={s.barRow}>
      <View style={s.barTop}>
        <Text style={s.barLabel}>{label}</Text>
        <Text style={[s.barN, { color: tone }]}>{fmt(n)}</Text>
      </View>
      <View style={s.track}><View style={{ width: `${pct}%`, height: '100%', borderRadius: 100, backgroundColor: tone }} /></View>
      {sub ? <Text style={s.barSub}>{sub}</Text> : null}
    </View>
  );
}

function Funnel({ f, opensMeasurable }: { f: PushFunnel; opensMeasurable: boolean }) {
  const chosen = f.rows || 0;
  return (
    <View>
      <Bar label="Chosen to receive" n={chosen} total={chosen} tone={T.blue} />
      {f.not_reachable > 0 ? (
        <Bar
          label="Not reachable"
          n={f.not_reachable}
          total={chosen}
          tone={T.faint}
          sub={[f.no_token ? `${fmt(f.no_token)} no push token` : null,
               f.opted_out ? `${fmt(f.opted_out)} opted out` : null].filter(Boolean).join(' · ')}
        />
      ) : null}
      <Bar label="Accepted by Expo" n={f.accepted} total={chosen} tone={T.cyan}
           sub="Expo took the message. Says nothing yet about Apple or Google." />
      {f.rejected > 0 ? <Bar label="Rejected" n={f.rejected} total={chosen} tone={T.red} /> : null}
      <Bar label="Handed to Apple/Google" n={f.handed_off} total={chosen} tone={T.emerald}
           sub={f.receipt_pending ? `${fmt(f.receipt_pending)} still awaiting a receipt` : 'Not proof it appeared, and never proof it was seen.'} />
      {f.dead_device > 0 ? (
        <Bar label="Uninstalled / notifications off" n={f.dead_device} total={chosen} tone={T.amber} />
      ) : null}
      {opensMeasurable ? (
        <Bar label="Opened" n={f.opened} total={f.handed_off || f.accepted || chosen} tone={T.purple}
             sub={`${rate(f.opened, f.handed_off || f.accepted)} of those handed off`} />
      ) : (
        <View style={s.note}>
          <Ionicons name="information-circle-outline" size={15} color={T.faint} />
          <Text style={s.noteTx}>
            Taps are not measurable for this send — the app builds it reached do not report them.
            That is why no open rate is shown rather than a 0%.
          </Text>
        </View>
      )}
    </View>
  );
}

export default function PushAnalyticsScreen() {
  const router = useRouter();
  const [days, setDays] = useState(30);
  const [data, setData] = useState<PushAnalytics | null>(null);
  const [video, setVideo] = useState<Awaited<ReturnType<typeof fetchPushVideo>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showWatchers, setShowWatchers] = useState(false);

  const load = useCallback(async (d = days) => {
    setError(null);
    try {
      const [a, v] = await Promise.all([fetchPushAnalytics(d), fetchPushVideo(d)]);
      setData(a); setVideo(v);
    } catch (e: any) {
      setError(e?.response?.status === 403 ? 'Admin access required.' : 'Could not load — pull to retry.');
    } finally { setLoading(false); setRefreshing(false); }
  }, [days]);

  useFocusEffect(useCallback(() => { load(days); }, [load, days]));

  const openCampaign = useCallback(async (id: string) => {
    if (openId === id) { setOpenId(null); setDetail(null); return; }
    setOpenId(id); setDetail(null); setDetailLoading(true);
    try { setDetail(await fetchPushCampaign(id, 24)); }
    catch { setDetail(null); }
    finally { setDetailLoading(false); }
  }, [openId]);

  const dur = video?.duration || null;

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.head}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} style={s.backBtn}>
          <Ionicons name="arrow-back" size={22} color={T.ink} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.headTitle}>Push Analytics</Text>
          <Text style={s.headSub}>What happened to what we sent</Text>
        </View>
        <TouchableOpacity onPress={() => load(days)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="refresh" size={20} color={T.muted} />
        </TouchableOpacity>
      </View>

      <View style={s.rangeRow}>
        {RANGES.map((d) => (
          <TouchableOpacity key={d} onPress={() => { setDays(d); setLoading(true); load(d); }}
            style={[s.range, days === d && s.rangeOn]}>
            <Text style={[s.rangeTx, days === d && s.rangeTxOn]}>{d}d</Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <View style={s.center}><ActivityIndicator color={T.cyan} size="large" /></View>
      ) : error ? (
        <View style={s.center}>
          <Ionicons name="lock-closed-outline" size={34} color={T.faint} />
          <Text style={s.errTx}>{error}</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: 60 }}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(days); }} tintColor={T.cyan} />}
        >
          {/* ── VIDEO ─────────────────────────────────────────────────────── */}
          <Text style={s.secTitle}>EXPLAINER VIDEO</Text>
          <View style={s.card}>
            {dur ? (
              <>
                <View style={s.statRow}>
                  <View style={s.stat}><Text style={s.statN}>{fmt(dur.watchers)}</Text><Text style={s.statL}>watchers</Text></View>
                  <View style={s.stat}><Text style={s.statN}>{fmt(dur.avg_seconds)}s</Text><Text style={s.statL}>average watch</Text></View>
                  <View style={s.stat}><Text style={s.statN}>{fmt(dur.median_seconds)}s</Text><Text style={s.statL}>median</Text></View>
                  <View style={s.stat}><Text style={s.statN}>{fmt(dur.avg_cover_pct)}%</Text><Text style={s.statL}>avg watched</Text></View>
                </View>
                <Bar label="Watched to the end" n={dur.completed} total={dur.watchers} tone={T.emerald} />
                <Bar label="Watched 75%+" n={dur.watched_75} total={dur.watchers} tone={T.cyan} />
                <Bar label="Watched 50%+" n={dur.watched_50} total={dur.watchers} tone={T.blue} />
                <Bar label="Watched 25%+" n={dur.watched_25} total={dur.watchers} tone={T.faint} />
                <TouchableOpacity style={s.moreBtn} onPress={() => setShowWatchers((v) => !v)}>
                  <Text style={s.moreTx}>{showWatchers ? 'Hide' : 'See every watcher'}</Text>
                  <Ionicons name={showWatchers ? 'chevron-up' : 'chevron-down'} size={15} color={T.cyan} />
                </TouchableOpacity>
                {showWatchers ? (
                  <View style={{ marginTop: 8 }}>
                    {(video?.watchers || []).map((w: PushWatcher) => (
                      <View key={w.user_id} style={s.wRow}>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={s.wName} numberOfLines={1}>{w.full_name || w.email || `user ${w.user_id}`}</Text>
                          <Text style={s.wSub} numberOfLines={1}>
                            {dateLabel(w.last_at)}{w.replays ? ` · ${w.replays} replay${w.replays > 1 ? 's' : ''}` : ''}
                            {w.nid ? ' · from a push' : ''}
                          </Text>
                        </View>
                        <Text style={[s.wPct, { color: w.completed ? T.emerald : (w.best_cover_pct || 0) >= 50 ? T.cyan : T.amber }]}>
                          {fmt(w.best_seconds)}s · {fmt(w.best_cover_pct)}%
                        </Text>
                      </View>
                    ))}
                    {!(video?.watchers || []).length ? <Text style={s.empty}>No measured watches yet.</Text> : null}
                  </View>
                ) : null}
              </>
            ) : (
              <View>
                <Text style={s.empty}>
                  No watch durations yet. Plays are counted below, but how long each person watched is
                  only reported by app builds carrying the watch measurement.
                </Text>
                <View style={s.chips}>
                  {Object.entries(video?.byEvent || {}).map(([k, v]: any) => (
                    <View key={k} style={s.chip}>
                      <Text style={s.chipL}>{k.replace('tutorial_', '')}</Text>
                      <Text style={s.chipV}>{fmt(v.users)} users</Text>
                    </View>
                  ))}
                </View>
              </View>
            )}
            {video?.notes?.coverage ? <Text style={s.footnote}>{video.notes.coverage}</Text> : null}
          </View>

          {/* ── CAMPAIGNS ─────────────────────────────────────────────────── */}
          <Text style={s.secTitle}>CAMPAIGNS</Text>
          {!(data?.campaigns || []).length ? (
            <View style={s.card}><Text style={s.empty}>No campaigns in this window.</Text></View>
          ) : (
            (data?.campaigns || []).map((c: PushCampaignRow) => {
              const opensMeasurable = c.opened > 0;
              const isOpen = openId === c.id;
              return (
                <View key={c.id} style={s.card}>
                  <TouchableOpacity onPress={() => openCampaign(c.id)} activeOpacity={0.85}>
                    <View style={s.cTop}>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={s.cTitle} numberOfLines={1}>{c.title || c.template_key || c.id}</Text>
                        <Text style={s.cSub}>{dateLabel(c.sent_at)} · {c.source || 'campaign'}</Text>
                      </View>
                      <Ionicons name={isOpen ? 'chevron-up' : 'chevron-down'} size={18} color={T.faint} />
                    </View>
                    <View style={s.chips}>
                      <View style={s.chip}><Text style={s.chipL}>Chosen</Text><Text style={s.chipV}>{fmt(c.rows)}</Text></View>
                      <View style={s.chip}><Text style={s.chipL}>Accepted</Text><Text style={[s.chipV, { color: T.cyan }]}>{fmt(c.accepted)}</Text></View>
                      <View style={s.chip}><Text style={s.chipL}>Handed off</Text><Text style={[s.chipV, { color: T.emerald }]}>{fmt(c.handed_off)}</Text></View>
                      {opensMeasurable
                        ? <View style={s.chip}><Text style={s.chipL}>Opened</Text><Text style={[s.chipV, { color: T.purple }]}>{fmt(c.opened)}</Text></View>
                        : <View style={s.chip}><Text style={s.chipL}>Taps</Text><Text style={[s.chipV, { color: T.faint }]}>not measurable</Text></View>}
                    </View>
                  </TouchableOpacity>

                  {isOpen ? (
                    detailLoading ? (
                      <View style={{ paddingVertical: 18 }}><ActivityIndicator color={T.cyan} /></View>
                    ) : detail ? (
                      <View style={s.detail}>
                        <Funnel f={detail} opensMeasurable={detail.opened > 0} />
                        <View style={s.note}>
                          <Ionicons name="pulse-outline" size={15} color={T.amber} />
                          <Text style={s.noteTx}>
                            <Text style={{ color: T.ink, fontWeight: '800' }}>{fmt(detail.active_after)}</Text> used the app
                            within 24h of this send. This is a correlation, not an attribution — it includes people who
                            would have opened the app anyway.
                          </Text>
                        </View>
                        <Text style={s.subHead}>RECIPIENTS</Text>
                        {(detail.rows || []).slice(0, 60).map((r: PushSendRow) => (
                          <View key={r.id} style={s.rRow}>
                            <View style={{ flex: 1, minWidth: 0 }}>
                              <Text style={s.rName} numberOfLines={1}>{r.email || `user ${r.user_id}`}</Text>
                              <Text style={s.rSub} numberOfLines={1}>
                                {r.ticket_status === 'skipped' ? `not sent — ${r.ticket_error}`
                                  : r.ticket_status === 'ok' ? (r.receipt_status === 'ok' ? 'handed off'
                                    : r.receipt_error ? r.receipt_error : 'awaiting receipt')
                                  : `rejected — ${r.ticket_error || 'unknown'}`}
                              </Text>
                            </View>
                            {r.opened_at ? (
                              <View style={s.openTag}><Text style={s.openTagTx}>opened</Text></View>
                            ) : null}
                          </View>
                        ))}
                        {(detail.rows || []).length > 60
                          ? <Text style={s.footnote}>Showing the first 60 of {fmt((detail.rows || []).length)}.</Text> : null}
                      </View>
                    ) : (
                      <Text style={s.empty}>Could not load this campaign.</Text>
                    )
                  ) : null}
                </View>
              );
            })
          )}

          {/* ── AUTOMATED ─────────────────────────────────────────────────── */}
          <Text style={s.secTitle}>AUTOMATED SENDS</Text>
          <View style={s.card}>
            {(data?.sources || []).length ? (data?.sources || []).map((r) => (
              <View key={r.source} style={s.sRow}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={s.sName}>{r.source.replace(/_/g, ' ')}</Text>
                  <Text style={s.sSub}>last {dateLabel(r.last_at)}</Text>
                </View>
                <Text style={s.sN}>{fmt(r.accepted)}<Text style={s.sNSub}> of {fmt(r.rows)}</Text></Text>
              </View>
            )) : <Text style={s.empty}>Nothing sent automatically in this window.</Text>}
          </View>

          {data?.notes ? (
            <View style={[s.card, { marginTop: 6 }]}>
              <Text style={s.subHead}>WHAT THESE NUMBERS MEAN</Text>
              {Object.values(data.notes).map((n, i) => (
                <Text key={i} style={s.footnote}>{n}</Text>
              ))}
            </View>
          ) : null}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: T.bg },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  backBtn: { width: 38, height: 38, borderRadius: 12, backgroundColor: T.card, alignItems: 'center', justifyContent: 'center' },
  headTitle: { color: T.ink, fontSize: 18, fontWeight: '800', letterSpacing: -0.3 },
  headSub: { color: T.faint, fontSize: 11.5, marginTop: 1 },
  rangeRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 8 },
  range: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 100, backgroundColor: T.card, borderWidth: 1, borderColor: T.line },
  rangeOn: { backgroundColor: 'rgba(34,211,238,0.16)', borderColor: 'rgba(34,211,238,0.4)' },
  rangeTx: { color: T.muted, fontSize: 12.5, fontWeight: '700' },
  rangeTxOn: { color: T.cyan },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 30 },
  errTx: { color: T.muted, fontSize: 13.5, textAlign: 'center' },
  secTitle: { color: T.faint, fontSize: 10.5, fontWeight: '800', letterSpacing: 1, marginBottom: 9, marginLeft: 2, marginTop: 16 },
  card: { backgroundColor: T.card, borderWidth: 1, borderColor: T.line, borderRadius: 18, padding: 14, marginBottom: 10 },
  statRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, marginBottom: 12 },
  stat: { minWidth: 68 },
  statN: { color: T.ink, fontSize: 19, fontWeight: '800' },
  statL: { color: T.faint, fontSize: 10.5, fontWeight: '700', marginTop: 1 },
  barRow: { marginTop: 10 },
  barTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  barLabel: { color: T.muted, fontSize: 12, fontWeight: '700' },
  barN: { fontSize: 12.5, fontWeight: '800' },
  track: { marginTop: 5, height: 6, borderRadius: 100, backgroundColor: 'rgba(255,255,255,0.07)', overflow: 'hidden' },
  barSub: { color: T.faint, fontSize: 10.5, marginTop: 4, lineHeight: 15 },
  note: { flexDirection: 'row', gap: 8, backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 12, padding: 10, marginTop: 12 },
  noteTx: { flex: 1, color: T.muted, fontSize: 11, lineHeight: 16 },
  cTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  cTitle: { color: T.ink, fontSize: 14, fontWeight: '800' },
  cSub: { color: T.faint, fontSize: 11, marginTop: 2 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 10 },
  chip: { backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 9, paddingHorizontal: 9, paddingVertical: 6 },
  chipL: { color: T.faint, fontSize: 9.5, fontWeight: '700' },
  chipV: { color: T.ink, fontSize: 12.5, fontWeight: '800', marginTop: 1 },
  detail: { marginTop: 12, borderTopWidth: 1, borderTopColor: T.line, paddingTop: 10 },
  subHead: { color: T.faint, fontSize: 10, fontWeight: '800', letterSpacing: 0.8, marginTop: 14, marginBottom: 6 },
  rRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)' },
  rName: { color: T.ink, fontSize: 12.5, fontWeight: '700' },
  rSub: { color: T.faint, fontSize: 10.5, marginTop: 1 },
  openTag: { backgroundColor: 'rgba(167,139,250,0.18)', borderRadius: 7, paddingHorizontal: 7, paddingVertical: 3 },
  openTagTx: { color: T.purple, fontSize: 10, fontWeight: '800' },
  sRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
  sName: { color: T.ink, fontSize: 13, fontWeight: '700', textTransform: 'capitalize' },
  sSub: { color: T.faint, fontSize: 10.5, marginTop: 1 },
  sN: { color: T.cyan, fontSize: 14, fontWeight: '800' },
  sNSub: { color: T.faint, fontSize: 11, fontWeight: '700' },
  wRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)' },
  wName: { color: T.ink, fontSize: 12.5, fontWeight: '700' },
  wSub: { color: T.faint, fontSize: 10.5, marginTop: 1 },
  wPct: { fontSize: 12, fontWeight: '800' },
  moreBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 12, paddingVertical: 9, borderRadius: 12, backgroundColor: 'rgba(34,211,238,0.10)' },
  moreTx: { color: T.cyan, fontSize: 12.5, fontWeight: '800' },
  empty: { color: T.faint, fontSize: 12, lineHeight: 17 },
  footnote: { color: T.faint, fontSize: 10.5, lineHeight: 15, marginTop: 8 },
});
