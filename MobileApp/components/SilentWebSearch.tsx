// AI Hub — hidden on-device "silent browser". Safe to delete without affecting the existing app.
// Runs an ATS X-Ray dork on DuckDuckGo-lite inside an OFFSCREEN WebView (the user's own IP — a shared
// server IP gets rate-limited), scrapes the ATS board links from the results, and hands them back so
// the backend can hydrate + ingest them. No UI; render it while a web search is in flight.
import React, { useRef } from 'react';
import { View } from 'react-native';
import { WebView } from 'react-native-webview';

// Runs at document-end inside the DDG-lite results page and posts the ATS board URLs it finds.
const EXTRACT_JS = `(function(){
  function grab(){
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
      var urls = Object.keys(out).slice(0, 30);
      var blocked = /captcha|unusual traffic|are you a robot|too many requests/i.test(hay) && urls.length===0;
      window.ReactNativeWebView.postMessage(JSON.stringify({ __cvfx:true, urls:urls, blocked:blocked }));
    } catch(e){ window.ReactNativeWebView.postMessage(JSON.stringify({ __cvfx:true, urls:[], error:String(e&&e.message||e) })); }
  }
  setTimeout(grab, 350);   // let the results DOM settle
})(); true;`;

export default function SilentWebSearch({ query, onResult }: { query: string; onResult: (urls: string[], blocked: boolean) => void }) {
  const done = useRef(false);
  if (!query) return null;
  const uri = 'https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(query);
  return (
    <View style={{ width: 1, height: 1, opacity: 0, position: 'absolute', left: -2000, top: -2000 }} pointerEvents="none">
      <WebView
        source={{ uri }}
        injectedJavaScript={EXTRACT_JS}
        onMessage={(e) => {
          if (done.current) return;
          try {
            const d = JSON.parse(e.nativeEvent.data);
            if (d && d.__cvfx) { done.current = true; onResult(Array.isArray(d.urls) ? d.urls : [], !!d.blocked); }
          } catch {}
        }}
        onError={() => { if (!done.current) { done.current = true; onResult([], false); } }}
        onHttpError={() => { if (!done.current) { done.current = true; onResult([], true); } }}
        javaScriptEnabled
        domStorageEnabled
        cacheEnabled={false}
        incognito
        userAgent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
      />
    </View>
  );
}
