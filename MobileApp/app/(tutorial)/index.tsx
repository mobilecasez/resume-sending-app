// AI Hub — new feature. Safe to delete without affecting existing app.
//
// "How CVApplyr works" — the 1:27 explainer, played in-app.
//
// The film is HOSTED, not bundled. Bundling would add ~5.6 MB to the download for every installer
// including the majority who never open it, and — the part that actually bites — a bundled file can
// only be corrected in a store release. This one is replaced by swapping a file on the server.
//
// It still plays instantly and works offline after the first watch: the network URL starts playing
// immediately (the mp4 is encoded +faststart, so playback begins before the download finishes) and
// a copy is pulled into the cache directory in the BACKGROUND for next time. Playback never waits
// on the cache, and a failed cache write is invisible to the user.
//
// Cache invalidation is by FILENAME (`tutorial-v1.mp4`). Re-cut the film, ship `-v2`, bump
// TUTORIAL_FILE, and every device fetches the new one — no cache-clearing logic to get wrong.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, SafeAreaView,
  Dimensions, StatusBar, Platform, AppState,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Video, ResizeMode, Audio, InterruptionModeIOS, InterruptionModeAndroid } from 'expo-av';
import { downloadAsync, getInfoAsync, cacheDirectory } from 'expo-file-system/legacy';
import { API_BASE } from '../../config';
import { track } from '../../services/analytics';

const T = {
  bg: '#05080F', ink: '#F1F5F9', mut: '#94A3B8', faint: '#64748B',
  accent: '#F4A259', border: 'rgba(255,255,255,0.10)',
};

const TUTORIAL_FILE = 'tutorial-v1.mp4';
/** API_BASE ends in `/api` and is a LIVE binding (an admin can repoint it) — so derive the media
 *  origin from it at call time rather than hard-coding a host. */
const mediaUrl = (name: string) => `${String(API_BASE).replace(/\/api\/?$/, '')}/media/${name}`;

type Src = { uri: string };

export default function TutorialScreen() {
  const router = useRouter();
  // Set when the screen was reached from a push, so a watch can be credited to the campaign that
  // drove it. Absent when opened from the menu or the help sheet — which is most of the time, and
  // is exactly why watches must not all be attributed to whatever push went out that day.
  const { nid: nidParam } = useLocalSearchParams<{ nid?: string }>();
  const nid = typeof nidParam === 'string' && nidParam ? nidParam : null;
  const videoRef = useRef<Video | null>(null);
  const [source, setSource] = useState<Src | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [done, setDone] = useState(false);
  const reported = useRef<{ half: boolean; end: boolean }>({ half: false, end: false });

  // Pick a source, then warm the cache. Deliberately ordered: decide what to PLAY first (fast),
  // and only then spend bandwidth on making next time offline-capable.
  useEffect(() => {
    let alive = true;
    (async () => {
      const remote = mediaUrl(TUTORIAL_FILE);
      const local = `${cacheDirectory}${TUTORIAL_FILE}`;
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
  }, []);

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

  useEffect(() => { track('tutorial_opened', { file: TUTORIAL_FILE, nid: nid || undefined }).catch(() => {}); }, [nid]);

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
  const watch = useRef({ seen: new Set<number>(), ms: 0, lastPos: -1, replays: 0, sent: 0 });

  /** Send what we have. Called on a timer, on unmount, and when the app goes to the background. */
  const flush = useCallback((reason: string) => {
    const w = watch.current;
    const seconds = Math.round(w.ms / 1000);
    // Nothing meaningful yet, and nothing new since the last flush → stay quiet.
    if (seconds < 1 || seconds === w.sent) return;
    w.sent = seconds;
    track('tutorial_progress', {
      file: TUTORIAL_FILE,
      seconds,
      coverPct: Math.min(100, Math.round((w.seen.size / BUCKETS) * 100)),
      completed: reported.current.end,
      replays: w.replays,
      reason,
      nid: nid || undefined,
    }).catch(() => {});
  }, [nid]);

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

  // The last word on the way out. An empty deps array on purpose: this must run on unmount only.
  useEffect(() => () => { flush('unmount'); }, [flush]);

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
      track('tutorial_halfway', { nid: nid || undefined }).catch(() => {});
    }
    if (s.didJustFinish && !reported.current.end) {
      reported.current.end = true;
      setDone(true);
      track('tutorial_completed', { nid: nid || undefined }).catch(() => {});
      flush('finished');
    }
  }, [flush, nid]);

  const replay = useCallback(async () => {
    setDone(false);
    reported.current = { half: false, end: false };
    // Keep `seen` and `ms` across a replay — a rewatch adds to the time spent, and coverage of a
    // second already watched must not be double-counted. Only the position tracker resets.
    watch.current.replays += 1;
    watch.current.lastPos = -1;
    try { await videoRef.current?.replayAsync(); } catch { /* ignore */ }
  }, []);

  const close = useCallback(() => {
    try { router.back(); } catch { /* opened cold from a push — nothing to go back to */ }
  }, [router]);

  const { width, height } = Dimensions.get('window');

  return (
    <SafeAreaView style={s.safe}>
      <StatusBar barStyle="light-content" backgroundColor={T.bg} />

      <View style={s.header}>
        <View style={{ flex: 1 }}>
          <Text style={s.title}>How CVApplyr works</Text>
          <Text style={s.sub}>1 minute 27 seconds</Text>
        </View>
        <TouchableOpacity onPress={close} style={s.close} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Ionicons name="close" size={26} color={T.mut} />
        </TouchableOpacity>
      </View>

      <View style={s.stage}>
        {source && !failed ? (
          <Video
            ref={videoRef}
            source={source}
            style={{ width, height: height * 0.72 }}
            resizeMode={ResizeMode.CONTAIN}
            useNativeControls
            shouldPlay
            isLooping={false}
            onLoad={() => setReady(true)}
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
              onPress={() => { setFailed(false); setReady(false); setSource({ uri: mediaUrl(TUTORIAL_FILE) }); }}
            >
              <Text style={s.btnText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </View>

      {/* The point of the whole screen: send them somewhere useful the moment it ends. A tutorial
          that finishes on a dead end wastes the attention it just earned. */}
      <View style={s.footer}>
        {done ? (
          <>
            <TouchableOpacity style={[s.btn, s.btnPrimary]} onPress={() => router.push('/(discover)')}>
              <Ionicons name="search" size={18} color="#0B1120" />
              <Text style={[s.btnText, s.btnTextPrimary]}>Find my first job</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.ghost} onPress={replay}>
              <Ionicons name="refresh" size={16} color={T.mut} />
              <Text style={s.ghostText}>Watch again</Text>
            </TouchableOpacity>
          </>
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
  title: { color: T.ink, fontSize: 20, fontWeight: '700', letterSpacing: -0.3 },
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
