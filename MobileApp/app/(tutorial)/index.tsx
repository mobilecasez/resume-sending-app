// AI Hub — new feature. Safe to delete without affecting existing app.
//
// "How CVApplyr works" — the narrated tutorial, five short clips (FILMS below), played in-app.
//
// WHICH CLIP OPENS: route params, all optional —
//   film  — the clip to open on (a FILMS key, or its 1..5 number). Absent → 01, the whole walkthrough.
//           The Home coach passes the user's next step; a push passes the clip it is about; the menu
//           passes nothing.
//   until — play straight on through the following clips up to this one (a push about "04-05").
//   nid   — the push that brought them here, so a watch is credited to that campaign.
// ⚠️ These are honoured when they CHANGE, not only on mount: a push tapped while this screen is
// already open retargets this player (pushRouting navigates, it does not stack a second screen).
//
// The films are HOSTED, not bundled. Bundling would add them to the download for every installer
// including the majority who never open them, and — the part that actually bites — a bundled file can
// only be corrected in a store release. Each one is replaced by swapping a file on the server.
//
// They still play instantly and work offline after the first watch: the network URL starts playing
// immediately (the mp4s are encoded +faststart, so playback begins before the download finishes) and
// a copy is pulled into the cache directory in the BACKGROUND for next time. Playback never waits
// on the cache, and a failed cache write is invisible to the user.
//
// Cache invalidation is by FILENAME (`guide-0N-…-v1.mp4`). Re-cut a film, ship `-v2`, bump its FILMS
// entry, and every device fetches the new one — no cache-clearing logic to get wrong.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, SafeAreaView,
  Dimensions, StatusBar, Platform, AppState,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Video, ResizeMode, Audio, InterruptionModeIOS, InterruptionModeAndroid } from 'expo-av';
import { downloadAsync, getInfoAsync, cacheDirectory } from 'expo-file-system/legacy';
import { API_BASE } from '../../config';
import { track } from '../../services/analytics';

const T = {
  bg: '#05080F', ink: '#F1F5F9', mut: '#94A3B8', faint: '#64748B',
  accent: '#F4A259', border: 'rgba(255,255,255,0.10)',
};

/**
 * The five films, in the order they teach — and the order they are NUMBERED ON SCREEN. Each clip
 * renders "01 … 05" in its own header, so this array and the films have to agree: reordering here
 * without re-cutting them would show a film captioned "04" under the heading "Step 3 of 5".
 *
 * `key` matches the server's journey step keys (server/services/journey.js), which is how the coach
 * on Home opens the film for whatever the user has to do next.
 *
 * ⚠️ Every file is HOSTED, never bundled. Together they are ~7.7 MB — bundling would add that to
 * the download for every installer including the majority who never open the guide, and a bundled
 * file can only be corrected in a store release. Cache-busting is by FILENAME (`-v1`): re-cut a
 * film, ship `-v2`, bump the entry, and every device fetches the new one.
 */
const FILMS = [
  { key: 'profile',      n: 1, file: 'guide-01-profile-v1.mp4',     title: 'Set up your profile',  secs: 31 },
  { key: 'resume',       n: 2, file: 'guide-02-resume-v1.mp4',      title: 'AI résumé + formats',  secs: 48 },
  { key: 'save_job',     n: 3, file: 'guide-03-savejob-v1.mp4',     title: 'Save a job',           secs: 26 },
  { key: 'cover_letter', n: 4, file: 'guide-04-coverletter-v1.mp4', title: 'Cover letter',         secs: 28 },
  { key: 'apply',        n: 5, file: 'guide-05-autofill-v1.mp4',    title: 'Auto Fill & apply',    secs: 40 },
] as const;

const filmIndexFor = (v?: string) => {
  if (!v) return 0;
  const byKey = FILMS.findIndex((f) => f.key === v);
  if (byKey >= 0) return byKey;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 1 && n <= FILMS.length ? n - 1 : 0;
};
/** Where an `until` param says to stop auto-advancing: its index when it names a clip AFTER `from`,
 *  else -1 (no chain). Deliberately NOT filmIndexFor — that falls back to 01, and an unknown `until`
 *  must mean "just this clip", never "loop back to the start". */
const chainEndFor = (v: string | undefined, from: number) => {
  if (!v) return -1;
  const byKey = FILMS.findIndex((f) => f.key === v);
  const n = parseInt(v, 10);
  const i = byKey >= 0 ? byKey : (Number.isFinite(n) && n >= 1 && n <= FILMS.length ? n - 1 : -1);
  return i > from ? i : -1;
};
/** What CHANGED route params do to the player already on screen — a push tapped while this screen
 *  is open reaches this same instance (pushRouting navigates, it does not stack a second player).
 *    switch — another clip: start it (selectFilm flushes the outgoing clip's watch first)
 *    replay — this clip, and it has finished: play it again from the top
 *    resume — this clip, not finished: make sure it is PLAYING, from where it is.
 *  ⚠️ 2026-09-19: "resume" used to be "leave it alone", on the theory that an unfinished clip must
 *  still be playing. It often is not: blur pauses it (useFocusEffect in the screen), so does the
 *  user, so does the app going to the background — and a push tap is exactly how people come back
 *  from one of those. The tap said "watch" and got a frozen frame. Not restarted from 0: this clip
 *  is already the one asked for, and jumping back mid-sentence is the worse tap; playAsync on a clip
 *  that IS playing does nothing. Pure, so server/scripts/test-journey.js pins it without a player. */
const retargetFor = (want: number, at: number, done: boolean): 'switch' | 'replay' | 'resume' =>
  want !== at ? 'switch' : done ? 'replay' : 'resume';
/** Router params arrive as string | string[] | undefined. */
const one = (v: unknown): string | undefined =>
  typeof v === 'string' && v ? v : (Array.isArray(v) && typeof v[0] === 'string' && v[0] ? v[0] : undefined);
/** API_BASE ends in `/api` and is a LIVE binding (an admin can repoint it) — so derive the media
 *  origin from it at call time rather than hard-coding a host. */
const mediaUrl = (name: string) => `${String(API_BASE).replace(/\/api\/?$/, '')}/media/${name}`;

type Src = { uri: string };

export default function TutorialScreen() {
  const router = useRouter();
  // Set when the screen was reached from a push, so a watch can be credited to the campaign that
  // drove it. Absent when opened from the menu or the help sheet — which is most of the time, and
  // is exactly why watches must not all be attributed to whatever push went out that day.
  const { nid: nidParam, film: filmRaw, until: untilRaw } = useLocalSearchParams<{ nid?: string; film?: string; until?: string }>();
  const nid = one(nidParam) || null;
  const filmParam = one(filmRaw);
  const untilParam = one(untilRaw);
  // Which film to open on. The coach passes the user's NEXT step key; a push passes the clip it is
  // about; the menu passes nothing.
  const [at, setAt] = useState(() => filmIndexFor(filmParam));
  const film = FILMS[at];
  // Auto-advance target: when the clip at `at` finishes and chainTo is further on, the next clip
  // starts by itself instead of the "done" footer. -1 = no chain (the default everywhere but a push
  // or a hand-off that asked for a run of clips). A chip tap cancels it — the user took the wheel.
  const [chainTo, setChainTo] = useState(() => chainEndFor(untilParam, filmIndexFor(filmParam)));
  const videoRef = useRef<Video | null>(null);
  const [source, setSource] = useState<Src | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [done, setDone] = useState(false);
  const reported = useRef<{ half: boolean; end: boolean }>({ half: false, end: false });
  // Latest-value mirrors for the callbacks that must NOT be re-created on every change: the player's
  // status callback and the param-change effect below both read these instead of closing over state.
  const atRef = useRef(at); atRef.current = at;
  const chainRef = useRef(chainTo); chainRef.current = chainTo;
  const doneRef = useRef(done); doneRef.current = done;
  // ⚠️ `nid` is READ, never a trigger. Since a push can retarget a mounted screen, `nid` changes
  // mid-watch — and every effect or callback that depended on it re-ran: tutorial_opened fired for
  // the clip already on screen (before the switch) under the NEW push, and the unmount flush's
  // cleanup sent an 'unmount' that was not one. New clips take it from here; each watch record
  // keeps the nid it was opened under (see `watch`).
  const nidRef = useRef(nid); nidRef.current = nid;

  // Pick a source, then warm the cache. Deliberately ordered: decide what to PLAY first (fast),
  // and only then spend bandwidth on making next time offline-capable.
  useEffect(() => {
    let alive = true;
    setReady(false); setFailed(false); setDone(false);
    reported.current = { half: false, end: false };
    (async () => {
      const remote = mediaUrl(film.file);
      const local = `${cacheDirectory}${film.file}`;
      try {
        const info = await getInfoAsync(local);
        // A truncated file from an interrupted download would play as a few broken seconds, so
        // require a plausible size before trusting the cache.
        if (info?.exists && (info as any).size > 1_000_000) {
          if (alive) setSource({ uri: local });
          return;
        }
      } catch { /* no cache yet — stream */ }

      if (alive) setSource({ uri: remote });
      try {
        await downloadAsync(remote, local);      // for next time; nothing waits on this
      } catch { /* offline or server down — streaming already covered the user */ }
    })();
    return () => { alive = false; };
  }, [film.file]);

  // ⚠️ WITHOUT THIS THE FILM PLAYS SILENTLY FOR MOST PEOPLE. expo-av defaults
  // playsInSilentModeIOS to FALSE, which means iOS honours the ring/silent switch — and that switch
  // is left on silent by a large share of iPhone users. The video looked fine and simply had no
  // narration, with nothing on screen to explain why. A muted explainer is a broken explainer: the
  // whole point is the voice-over.
  //
  // Scoped to this screen on purpose. The mode is global to the app, and claiming the playback
  // category app-wide would let any later sound ignore the user's silent switch — so it is restored
  // on unmount. DoNotMix/DuckOthers because this is speech the user chose to listen to: it should
  // interrupt music rather than fight it.
  useEffect(() => {
    Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      allowsRecordingIOS: false,
      staysActiveInBackground: false,
      interruptionModeIOS: InterruptionModeIOS.DoNotMix,
      interruptionModeAndroid: InterruptionModeAndroid.DuckOthers,
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: false,
    }).catch(() => { /* session refused — the film still plays, just under the silent switch */ });
    // Hand the silent switch back to the rest of the app on the way out.
    return () => {
      Audio.setAudioModeAsync({ playsInSilentModeIOS: false, allowsRecordingIOS: false })
        .catch(() => {});
    };
  }, []);

  // Opening a film is its own event, and switching counts as opening the next one. Keyed on the film
  // ONLY: with `nid` in the deps, a push retargeting a mounted screen fired this for the OUTGOING
  // clip under the new push (the commit that brings the new nid still shows the old clip), and the
  // push's real clip followed a render later — every retarget counted as two opens.
  useEffect(() => { track('tutorial_opened', { file: film.file, film: film.key, nid: nidRef.current || undefined }).catch(() => {}); }, [film.file, film.key]);

  // ── Watch measurement ───────────────────────────────────────────────────────────────────────
  //
  // TWO numbers, because neither alone is honest:
  //
  //   coverPct — how much of the film they actually SAW. The timeline is cut into BUCKETS and a
  //     bucket is marked as the position passes through it. Immune to scrubbing (this player has
  //     useNativeControls, so people DO scrub), cannot exceed 100%, and counts a replayed second
  //     only once.
  //   seconds — time actually spent playing. Only forward deltas smaller than MAX_STEP_MS are
  //     banked, so dragging the scrubber 40s ahead adds nothing. Can exceed the running time when
  //     someone genuinely rewatches, which is real and worth seeing.
  //
  // A plain "watched %" built from positionMillis would report 100% for a user who dragged the
  // scrubber to the end in two seconds. That number would be worse than having none.
  const BUCKETS = 40;
  const MAX_STEP_MS = 1500;
  // ⚠️ `file` lives IN the ref. flush() runs on unmount and on switching films, and by then `film`
  // is already the NEXT one — reading it there would file every film's watch time under its
  // successor. The ref records what was actually being measured.
  // `nid` lives in it for the same reason (2026-09-19): when a push retargets the screen, the switch
  // flush runs with the NEW push's nid already in the params, and reading it there credited the
  // outgoing clip — opened from the menu, say — to a push that never caused it.
  const watch = useRef<{ seen: Set<number>; ms: number; lastPos: number; replays: number; sent: number; file: string; key: string; nid: string | null }>(
    { seen: new Set<number>(), ms: 0, lastPos: -1, replays: 0, sent: 0, file: FILMS[0].file, key: FILMS[0].key, nid });

  /** Send what we have. Called on a timer, on unmount, and when the app goes to the background.
   *  ⚠️ STABLE (no deps — it reads only refs). Three effects below subscribe with it, and a flush
   *  that changed identity re-ran their cleanups mid-watch; the unmount one then sent 'unmount'. */
  const flush = useCallback((reason: string) => {
    const w = watch.current;
    const seconds = Math.round(w.ms / 1000);
    // Nothing meaningful yet, and nothing new since the last flush → stay quiet.
    if (seconds < 1 || seconds === w.sent) return;
    w.sent = seconds;
    track('tutorial_progress', {
      file: w.file,
      film: w.key,
      seconds,
      coverPct: Math.min(100, Math.round((w.seen.size / BUCKETS) * 100)),
      completed: reported.current.end,
      replays: w.replays,
      reason,
      nid: w.nid || undefined,
    }).catch(() => {});
  }, []);

  // Periodic flush while watching, so a user who force-quits mid-film is not lost entirely.
  useEffect(() => {
    const t = setInterval(() => flush('tick'), 10000);
    return () => clearInterval(t);
  }, [flush]);

  // Backgrounding is the common way a watch ends — more common than pressing close.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st !== 'active') flush('background');
    });
    return () => sub.remove();
  }, [flush]);

  // The last word on the way out. Unmount ONLY — which holds because `flush` is stable. It used to
  // depend on `nid`, so a push retargeting the open screen ran this cleanup mid-watch.
  useEffect(() => () => { flush('unmount'); }, [flush]);

  // selectFilm is declared below and re-created whenever `at` changes; the player's status callback
  // and the param-change effect call the CURRENT one through this ref.
  const selectFilmRef = useRef<(i: number) => void>(() => {});

  const onStatus = useCallback((s: any) => {
    if (!s?.isLoaded) return;
    const dur = s.durationMillis || 0;
    const pos = s.positionMillis || 0;
    const w = watch.current;

    if (dur > 0) {
      w.seen.add(Math.min(BUCKETS - 1, Math.floor((pos / dur) * BUCKETS)));
      const step = pos - w.lastPos;
      // Forward, and small enough to be real playback rather than a seek.
      if (w.lastPos >= 0 && step > 0 && step <= MAX_STEP_MS && s.isPlaying) w.ms += step;
      w.lastPos = pos;
    }

    if (dur > 0 && !reported.current.half && pos / dur >= 0.5) {
      reported.current.half = true;
      track('tutorial_halfway', { film: watch.current.key, nid: watch.current.nid || undefined }).catch(() => {});
    }
    if (s.didJustFinish && !reported.current.end) {
      reported.current.end = true;
      track('tutorial_completed', { film: watch.current.key, nid: watch.current.nid || undefined }).catch(() => {});
      flush('finished');
      // A run of clips was asked for (a push about "04-05") and this is not the last of it: roll
      // straight on into the next one rather than stopping on a footer the user never asked to see.
      // Read through refs — this callback is handed to the player and must not go stale.
      const cur = atRef.current;
      if (chainRef.current > cur && cur + 1 < FILMS.length) selectFilmRef.current(cur + 1);
      else setDone(true);
    }
  }, [flush]);

  // Switch films. Flush FIRST — the outgoing film's watch time belongs to the outgoing film — then
  // reset the counters so the next one starts from zero rather than inheriting a coverage figure.
  const selectFilm = useCallback((i: number) => {
    if (i === at || i < 0 || i >= FILMS.length) return;
    flush('switch');
    // Stamped with the nid in force NOW: the push that retargeted us, or whatever opened the screen.
    watch.current = { seen: new Set<number>(), ms: 0, lastPos: -1, replays: 0, sent: 0, file: FILMS[i].file, key: FILMS[i].key, nid: nidRef.current };
    setAt(i);
  }, [at, flush]);
  selectFilmRef.current = selectFilm;

  // A chip is the user choosing for themselves, so it ends any auto-advance a push set up.
  const pickFilm = useCallback((i: number) => { setChainTo(-1); selectFilm(i); }, [selectFilm]);

  // Keep the ref pointed at the film on screen even when `at` was set by the route param rather
  // than by selectFilm (a coach deep-link opens straight on film 3, and nothing else would set it).
  useEffect(() => { watch.current.file = film.file; watch.current.key = film.key; }, [film.file, film.key]);

  const replay = useCallback(async () => {
    setDone(false);
    reported.current = { half: false, end: false };
    // Keep `seen` and `ms` across a replay — a rewatch adds to the time spent, and coverage of a
    // second already watched must not be double-counted. Only the position tracker resets.
    watch.current.replays += 1;
    watch.current.lastPos = -1;
    try { await videoRef.current?.replayAsync(); } catch { /* ignore */ }
  }, []);

  // ── New params while mounted ────────────────────────────────────────────────────────────────
  // ⚠️ 2026-09-19. `at` and `chainTo` are seeded from the params ONCE, by their useState
  // initialisers. A push tapped while this screen is already open reaches THIS instance with new
  // params (pushRouting navigates rather than stacking a second player), and without this effect
  // the new clip was silently ignored. Compared by value rather than skipped on first run, so the
  // mount — including React's dev-mode double effect — is a no-op, and only a real change acts.
  // `nid` is part of the value on purpose: a second push for the same clip (a new nid) is a new
  // request, while a replayed cold-start response (the same nid) is correctly a no-op.
  const appliedParams = useRef(`${filmParam || ''}|${untilParam || ''}|${nid || ''}`);
  useEffect(() => {
    const sig = `${filmParam || ''}|${untilParam || ''}|${nid || ''}`;
    if (sig === appliedParams.current) return;
    appliedParams.current = sig;
    const i = filmIndexFor(filmParam);
    setChainTo(chainEndFor(untilParam, i));
    const act = retargetFor(i, atRef.current, doneRef.current);
    if (act === 'switch') selectFilmRef.current(i);      // flushes the outgoing clip's watch first
    else if (act === 'replay') replay();                 // same clip, already over → play it again
    // Same clip, not over → PLAY it from where it is. It may be paused (blur, background, the user);
    // a no-op if it is already playing. Still loading → shouldPlay starts it, so a reject is fine.
    // The watch record stays the one this clip was opened under: resuming it is not a new open.
    else videoRef.current?.playAsync().catch(() => {});
  }, [filmParam, untilParam, nid, replay]);

  // ── Never play behind another screen ────────────────────────────────────────────────────────
  // `shouldPlay` is fixed on, and nothing paused the player when something covered this screen —
  // "Find my first job", or a second tutorial stacked by an older path — so the narration carried
  // on underneath. Pause on blur; the native controls resume it. Deliberately no dependencies: a
  // useFocusEffect whose callback changes re-runs its cleanup WHILE focused, which would pause the
  // clip a param change had just started.
  useFocusEffect(useCallback(() => () => {
    videoRef.current?.pauseAsync().catch(() => { /* not loaded yet / already unloaded */ });
  }, []));

  const close = useCallback(() => {
    try { router.back(); } catch { /* opened cold from a push — nothing to go back to */ }
  }, [router]);

  const { width, height } = Dimensions.get('window');

  return (
    <SafeAreaView style={s.safe}>
      <StatusBar barStyle="light-content" backgroundColor={T.bg} />

      <View style={s.header}>
        <View style={{ flex: 1 }}>
          <Text style={s.eyebrow}>STEP {film.n} OF {FILMS.length}</Text>
          <Text style={s.title}>{film.title}</Text>
          <Text style={s.sub}>{film.secs} seconds</Text>
        </View>
        <TouchableOpacity onPress={close} style={s.close} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Ionicons name="close" size={26} color={T.mut} />
        </TouchableOpacity>
      </View>

      <View style={s.stage}>
        {source && !failed ? (
          <Video
            // ⚠️ KEYED ON THE FILM. Swapping only `source` REUSES the underlying player, and it
            // keeps the old playhead — so switching from 20s into film 1 started film 2 at 0:20,
            // which is what was reported. The key forces a fresh player per film, and
            // positionMillis={0} states the intent rather than relying on that.
            key={film.file}
            ref={videoRef}
            source={source}
            positionMillis={0}
            style={{ width, height: height * 0.72 }}
            resizeMode={ResizeMode.CONTAIN}
            useNativeControls
            shouldPlay
            isLooping={false}
            // Belt and braces: if a player ever IS reused, rewind the moment it reports ready.
            // Seeking to 0 on a stream already at 0 is a no-op, so this cannot cause a visible jump.
            onLoad={() => { setReady(true); videoRef.current?.setPositionAsync(0).catch(() => {}); }}
            onError={() => { setFailed(true); track('tutorial_failed').catch(() => {}); }}
            onPlaybackStatusUpdate={onStatus}
          />
        ) : null}

        {!ready && !failed ? (
          <View style={s.overlay} pointerEvents="none">
            <ActivityIndicator size="large" color={T.accent} />
          </View>
        ) : null}

        {failed ? (
          <View style={s.overlay}>
            <Ionicons name="cloud-offline-outline" size={40} color={T.faint} />
            <Text style={s.errTitle}>Could not load the video</Text>
            <Text style={s.errBody}>Check your connection and try again.</Text>
            <TouchableOpacity
              style={s.btn}
              onPress={() => { setFailed(false); setReady(false); setSource({ uri: mediaUrl(film.file) }); }}
            >
              <Text style={s.btnText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </View>

      {/* Chapter strip. Always visible, because "there are five of these and I am on the second"
          is the single most useful thing to know here — and it lets someone who only needs the
          Auto Fill film get to it without sitting through four others. */}
      <View style={s.strip}>
        {FILMS.map((f, i) => (
          <TouchableOpacity
            key={f.key}
            onPress={() => pickFilm(i)}
            style={[s.chip, i === at && s.chipOn]}
            hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
            accessibilityLabel={`Step ${f.n}: ${f.title}`}
          >
            <Text style={[s.chipText, i === at && s.chipTextOn]}>{String(f.n).padStart(2, '0')}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* The point of the whole screen: send them somewhere useful the moment it ends. A tutorial
          that finishes on a dead end wastes the attention it just earned. */}
      <View style={s.footer}>
        {done ? (
          <>
            {at < FILMS.length - 1 ? (
              <TouchableOpacity style={[s.btn, s.btnPrimary]} onPress={() => selectFilm(at + 1)}>
                <Ionicons name="play" size={17} color="#0B1120" />
                <Text style={[s.btnText, s.btnTextPrimary]}>Next: {FILMS[at + 1].title}</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity style={[s.btn, s.btnPrimary]} onPress={() => router.push('/(discover)')}>
                <Ionicons name="search" size={18} color="#0B1120" />
                <Text style={[s.btnText, s.btnTextPrimary]}>Find my first job</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={s.ghost} onPress={replay}>
              <Ionicons name="refresh" size={16} color={T.mut} />
              <Text style={s.ghostText}>Watch again</Text>
            </TouchableOpacity>
          </>
        ) : chainTo > at && at + 1 < FILMS.length ? (
          // Say it before it happens: a clip that changes by itself with no warning reads as a glitch.
          <Text style={s.hint}>Next: {FILMS[at + 1].title} plays automatically</Text>
        ) : (
          <Text style={s.hint}>Set up once — then it’s find a job, and apply.</Text>
        )}
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: T.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20,
    paddingTop: Platform.OS === 'android' ? 14 : 6, paddingBottom: 14,
  },
  eyebrow: { color: T.accent, fontSize: 10.5, fontWeight: '800', letterSpacing: 1.4, marginBottom: 3 },
  title: { color: T.ink, fontSize: 20, fontWeight: '700', letterSpacing: -0.3 },
  strip: { flexDirection: 'row', justifyContent: 'center', gap: 8, paddingTop: 14 },
  chip: {
    minWidth: 40, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999,
    borderWidth: 1, borderColor: T.border, alignItems: 'center',
  },
  chipOn: { backgroundColor: T.accent, borderColor: T.accent },
  chipText: { color: T.faint, fontSize: 12.5, fontWeight: '800', letterSpacing: 0.4 },
  chipTextOn: { color: '#0B1120' },
  sub: { color: T.faint, fontSize: 13, marginTop: 3 },
  close: { padding: 4 },
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#000' },
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', gap: 10 },
  errTitle: { color: T.ink, fontSize: 16, fontWeight: '600', marginTop: 6 },
  errBody: { color: T.mut, fontSize: 13, marginBottom: 6 },
  footer: { paddingHorizontal: 20, paddingVertical: 18, alignItems: 'center', gap: 12 },
  hint: { color: T.faint, fontSize: 14, textAlign: 'center' },
  btn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 22, paddingVertical: 13, borderRadius: 12,
    borderWidth: 1, borderColor: T.border,
  },
  btnPrimary: { backgroundColor: T.accent, borderColor: T.accent },
  btnText: { color: T.ink, fontSize: 15, fontWeight: '600' },
  btnTextPrimary: { color: '#0B1120', fontWeight: '700' },
  ghost: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6 },
  ghostText: { color: T.mut, fontSize: 14, fontWeight: '500' },
});
