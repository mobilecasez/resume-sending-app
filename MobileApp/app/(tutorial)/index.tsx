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
  Dimensions, StatusBar, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Video, ResizeMode } from 'expo-av';
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

  useEffect(() => { track('tutorial_opened', { file: TUTORIAL_FILE }).catch(() => {}); }, []);

  const onStatus = useCallback((s: any) => {
    if (!s?.isLoaded) return;
    const dur = s.durationMillis || 0;
    const pos = s.positionMillis || 0;
    if (dur > 0 && !reported.current.half && pos / dur >= 0.5) {
      reported.current.half = true;
      track('tutorial_halfway').catch(() => {});
    }
    if (s.didJustFinish && !reported.current.end) {
      reported.current.end = true;
      setDone(true);
      track('tutorial_completed').catch(() => {});
    }
  }, []);

  const replay = useCallback(async () => {
    setDone(false);
    reported.current = { half: false, end: false };
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
