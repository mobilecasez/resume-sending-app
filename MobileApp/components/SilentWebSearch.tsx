// AI Hub — hidden on-device "silent browser". Safe to delete without affecting the existing app.
// Runs the ATS X-Ray as SEPARATE per-site queries (DuckDuckGo-lite handles `site:` far better than an
// OR-group — verified: OR-group→0 boards, per-site→hits) inside offscreen WebViews on the USER's own IP
// (a shared server IP gets rate-limited). Scrapes the greenhouse/lever/ashby board links from each and
// returns the merged set so the backend can hydrate + ingest them. No visible UI.
import React, { useEffect, useRef } from 'react';
import { View } from 'react-native';
import { WebView } from 'react-native-webview';

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// Scrape ATS board slugs from the (server-rendered) DDG-lite results. Retries a few times in case the
// DOM is still settling, then posts whatever it found.
const EXTRACT_JS = `(function(){
  function scan(){
    try {
      var html = document.documentElement.innerHTML || '';
      var dec = html; try { dec = decodeURIComponent(html.replace(/&amp;/g,'&')); } catch(e){}
      var hay = dec + ' ' + html;
      var pats = [
        [/(?:boards|job-boards)\\.greenhouse\\.io\\/([a-z0-9_-]+)/gi, 'https://boards.greenhouse.io/'],
        [/jobs\\.lever\\.co\\/([a-z0-9_-]+)/gi, 'https://jobs.lever.co/'],
        [/jobs\\.ashbyhq\\.com\\/([a-z0-9_-]+)/gi, 'https://jobs.ashbyhq.com/']
      ];
      var out = {}, m;
      for (var i=0;i<pats.length;i++){ var re=pats[i][0], base=pats[i][1]; while((m=re.exec(hay))){ out[base+m[1].toLowerCase()]=1; } }
      return { urls: Object.keys(out), blocked: /captcha|unusual traffic|are you a robot|too many requests/i.test(hay) };
    } catch(e){ return { urls: [], blocked:false }; }
  }
  var tries = 0;
  var iv = setInterval(function(){
    tries++;
    var r = scan();
    if (r.urls.length > 0 || tries >= 6) {
      clearInterval(iv);
      try { window.ReactNativeWebView.postMessage(JSON.stringify({ __cvfx:true, urls:r.urls, blocked:r.blocked })); } catch(e){}
    }
  }, 400);
})(); true;`;

export default function SilentWebSearch({ urls, onResult }: { urls: string[]; onResult: (urls: string[], blocked: boolean) => void }) {
  const acc = useRef<Set<string>>(new Set());
  const doneCount = useRef(0);
  const blockedCount = useRef(0);
  const finished = useRef(false);
  const list = (urls || []).filter(Boolean).slice(0, 6);

  const finish = () => { if (finished.current) return; finished.current = true; onResult([...acc.current], acc.current.size === 0 && blockedCount.current > 0); };
  const onEach = (found: string[], blocked: boolean) => {
    found.forEach((u) => acc.current.add(u));
    if (blocked) blockedCount.current += 1;
    doneCount.current += 1;
    if (doneCount.current >= list.length) finish();
  };

  // Safety net: don't hang the "searching…" state if a WebView never reports back.
  useEffect(() => { const t = setTimeout(finish, 18000); return () => clearTimeout(t); }, []);

  if (!list.length) return null;
  return (
    <View style={{ position: 'absolute', left: -4000, top: -4000, width: 1, height: 1, opacity: 0 }} pointerEvents="none">
      {list.map((uri, i) => (
        <WebView
          key={i}
          source={{ uri }}
          injectedJavaScript={EXTRACT_JS}
          onMessage={(e) => { try { const d = JSON.parse(e.nativeEvent.data); if (d && d.__cvfx) onEach(Array.isArray(d.urls) ? d.urls : [], !!d.blocked); } catch {} }}
          onError={() => onEach([], false)}
          onHttpError={() => onEach([], true)}
          javaScriptEnabled
          domStorageEnabled
          cacheEnabled={false}
          incognito
          userAgent={MOBILE_UA}
        />
      ))}
    </View>
  );
}
