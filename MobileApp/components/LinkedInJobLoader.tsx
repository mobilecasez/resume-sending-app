// AI Hub — new feature. Safe to delete without affecting existing app.
//
// LinkedInJobLoader — a HIDDEN, off-screen WebView that loads a LinkedIn job page using the user's
// real device (IP + browser fingerprint + any LinkedIn session cookies), so LinkedIn serves the real
// page instead of the HTTP-999 auth-wall that blocks server-side scrapers. An injected script grabs the
// page innerText (a free ~100x "trimmer") and posts it back; we send that tiny payload to our separate
// LinkedIn API (/ai-hub/linkedin/extract) which AI-extracts structured JSON + stores it for cover letters.
//
// Usage (render only while extracting; clear `url` when done):
//   {liUrl ? <LinkedInJobLoader url={liUrl} onResult={j => {...}} onError={m => {...}} onStage={setMsg} /> : null}
import React, { useEffect, useRef } from 'react';
import { View } from 'react-native';
import { WebView } from 'react-native-webview';
import { extractLinkedInJob, addLinkedInJob, type LinkedInJob } from '../services/aiHubService';

// A real mobile Safari UA so LinkedIn serves the normal job page (not a bot/stripped variant).
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

// Injected into the hidden WebView. Waits for the job description to render, then posts the page innerText.
const LINKEDIN_EXTRACT_JS = `(function(){
  function post(o){ try{ window.ReactNativeWebView.postMessage(JSON.stringify(o)); }catch(e){} }
  function grab(){
    try{
      var c = document.querySelector('.job-view-layout, .jobs-search__job-details, .jobs-description, .top-card-layout, main') || document.body;
      var text = ((c && c.innerText) || document.body.innerText || '').replace(/\\n{3,}/g,'\\n\\n').trim();
      var clean = location.href.split('?')[0].split('#')[0];
      var blocked = /authwall|sign in to see|join linkedin to|join now to see/i.test(text) && text.length < 700;
      post({ source:'LinkedIn_Hidden_WebView', url: clean, content: text, blocked: blocked });
    }catch(e){ post({ source:'LinkedIn_Hidden_WebView', error: String(e) }); }
  }
  // Retry as React content streams in; bail out (and grab whatever we have) after ~12s.
  var n=0; var iv=setInterval(function(){ n++;
    var d = document.querySelector('.jobs-description, .description__text, .show-more-less-html, .jobs-box__html-content');
    if (d && (d.innerText||'').length > 250){ clearInterval(iv); grab(); }
    else if (n>=8){ clearInterval(iv); grab(); }
  }, 1500);
  true;
})();`;

type Props = {
  url: string;
  onResult: (job: LinkedInJob) => void;
  onError: (message: string) => void;
  onStage?: (stage: string) => void;
  timeoutMs?: number;
  add?: boolean; // true → also add the job to the user's Job Hub (dashboard); false → just extract/enrich
};

export default function LinkedInJobLoader({ url, onResult, onError, onStage, timeoutMs = 25000, add = false }: Props) {
  const done = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    done.current = false;
    if (!url) return;
    onStage?.('Opening LinkedIn securely…');
    timer.current = setTimeout(() => {
      if (!done.current) { done.current = true; onError('LinkedIn took too long to respond. Please try again.'); }
    }, timeoutMs);
    return () => { if (timer.current) clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  if (!url) return null;

  const finish = (fn: () => void) => {
    if (done.current) return;
    done.current = true;
    if (timer.current) clearTimeout(timer.current);
    fn();
  };

  const handleMessage = async (e: { nativeEvent: { data: string } }) => {
    if (done.current) return;
    let msg: any;
    try { msg = JSON.parse(e.nativeEvent.data); } catch { return; }
    if (!msg || msg.source !== 'LinkedIn_Hidden_WebView') return;
    if (msg.error) return finish(() => onError('Could not read the LinkedIn page.'));
    if (msg.blocked) return finish(() => onError('LinkedIn showed a sign-in wall. Sign in to LinkedIn once in the app, then retry.'));

    finish(async () => {
      try {
        onStage?.(add ? 'Adding the job to your hub…' : 'Reading the job details…');
        const job = add
          ? await addLinkedInJob(msg.url || url, msg.content || '')
          : await extractLinkedInJob(msg.url || url, msg.content || '');
        if (job && job.title) onResult(job);
        else onError('We couldn’t read this job. Please try another link.');
      } catch (err: any) {
        onError(err?.response?.data?.message || err?.response?.data?.error || 'Could not extract this job.');
      }
    });
  };

  return (
    // Off-screen + invisible, but a real viewport size so LinkedIn's React app actually renders.
    <View style={{ position: 'absolute', left: -100000, top: 0, width: 390, height: 780, opacity: 0 }} pointerEvents="none">
      <WebView
        source={{ uri: url }}
        injectedJavaScript={LINKEDIN_EXTRACT_JS}
        onMessage={handleMessage}
        userAgent={MOBILE_UA}
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        javaScriptEnabled
        domStorageEnabled
        originWhitelist={['*']}
        cacheEnabled
        onError={() => finish(() => onError('LinkedIn page failed to load.'))}
        onHttpError={(e) => {
          // 999 = LinkedIn auth-wall for non-human requests; with the real device it usually still renders,
          // so only fail on a hard error AFTER the injected grab had its chance (the timeout covers that).
          if (e?.nativeEvent?.statusCode && e.nativeEvent.statusCode >= 400 && e.nativeEvent.statusCode !== 999) {
            finish(() => onError('LinkedIn returned an error loading this job.'));
          }
        }}
      />
    </View>
  );
}
