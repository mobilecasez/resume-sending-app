// AI Hub — new feature. Safe to delete without affecting existing app.
//
// A signature you actually draw with your finger.
//
// ⚠️ THIS HAS TO BE A WEBVIEW, AND NOT BECAUSE ANYONE PREFERRED IT. Drawing a smooth stroke needs a
// vector path, and there is no react-native-svg, no skia and no canvas library in this project —
// nor may any be added. The only honest pure-RN alternative is a PanResponder feeding hundreds of
// absolutely-positioned rotated Views, which is janky, and worse, cannot produce the PNG the
// server's /users/profile/signature endpoint expects. An HTML <canvas> inside react-native-webview
// gives a real path, real smoothing and a real toDataURL — and the exact bridge is already proven
// in production by the "generate my signature" feature (App.js), which uses this same
// postMessage → base64 → writeAsStringAsync → multipart chain.
//
// ⚠️ NO NETWORK. The existing generator pulls cursive faces from Google Fonts, so it silently fails
// offline. This page loads nothing: the ink is a path the user drew, so there is nothing to fetch.
//
// ⚠️ The canvas is drawn at 2x and exported at 2x, then downscaled by whoever renders it. A
// signature captured at 1x looks visibly ragged on a printed A4 letterhead.
import React, { useCallback, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import { writeAsStringAsync, cacheDirectory, EncodingType } from 'expo-file-system/legacy';
import { E } from '../employer-home/theme';

const PAGE = `<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>
  html,body{margin:0;padding:0;height:100%;background:#FFFFFF;overflow:hidden;
            -webkit-user-select:none;user-select:none;-webkit-touch-callout:none;}
  #c{display:block;width:100%;height:100%;touch-action:none;}
</style></head><body>
<canvas id="c"></canvas>
<script>
(function(){
  var c=document.getElementById('c'), ctx=c.getContext('2d'), S=2;
  var drawing=false, dirty=false, last=null, mid=null;
  function size(){
    var w=c.clientWidth, h=c.clientHeight;
    c.width=w*S; c.height=h*S;
    ctx.scale(S,S);
    ctx.lineWidth=2.6; ctx.lineCap='round'; ctx.lineJoin='round'; ctx.strokeStyle='#0B0F22';
  }
  size();
  window.addEventListener('resize', function(){ var d=dirty; size(); if(!d) post({type:'state',drawn:false}); });
  function post(o){ if(window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(o)); }
  function pt(e){
    var r=c.getBoundingClientRect();
    var t=(e.touches && e.touches[0]) || e;
    return {x:t.clientX-r.left, y:t.clientY-r.top};
  }
  function down(e){
    e.preventDefault(); drawing=true; last=pt(e); mid=last;
    ctx.beginPath(); ctx.moveTo(last.x,last.y); ctx.lineTo(last.x+0.1,last.y); ctx.stroke();
    if(!dirty){ dirty=true; post({type:'state',drawn:true}); }
  }
  function move(e){
    if(!drawing) return; e.preventDefault();
    var p=pt(e);
    // Quadratic through the midpoint: a polyline of raw touch samples reads as a jagged scribble.
    var m={x:(last.x+p.x)/2, y:(last.y+p.y)/2};
    ctx.beginPath(); ctx.moveTo(mid.x,mid.y); ctx.quadraticCurveTo(last.x,last.y,m.x,m.y); ctx.stroke();
    last=p; mid=m;
  }
  function up(e){ if(!drawing) return; e.preventDefault(); drawing=false; }
  c.addEventListener('touchstart',down,{passive:false});
  c.addEventListener('touchmove',move,{passive:false});
  c.addEventListener('touchend',up,{passive:false});
  c.addEventListener('touchcancel',up,{passive:false});
  c.addEventListener('mousedown',down); c.addEventListener('mousemove',move);
  window.addEventListener('mouseup',up);

  window.__clear=function(){
    ctx.clearRect(0,0,c.width,c.height); dirty=false; post({type:'state',drawn:false});
  };
  window.__export=function(){
    if(!dirty){ post({type:'empty'}); return; }
    // Trim to the ink, with a small margin — a signature centred in a huge transparent canvas
    // renders as a speck on the letterhead.
    var w=c.width,h=c.height,d=ctx.getImageData(0,0,w,h).data;
    var x0=w,y0=h,x1=0,y1=0;
    for(var y=0;y<h;y++) for(var x=0;x<w;x++){
      if(d[(y*w+x)*4+3]>8){ if(x<x0)x0=x; if(x>x1)x1=x; if(y<y0)y0=y; if(y>y1)y1=y; }
    }
    if(x1<x0||y1<y0){ post({type:'empty'}); return; }
    var pad=Math.round(10*S);
    x0=Math.max(0,x0-pad); y0=Math.max(0,y0-pad);
    x1=Math.min(w-1,x1+pad); y1=Math.min(h-1,y1+pad);
    var ow=x1-x0+1, oh=y1-y0+1;
    var o=document.createElement('canvas'); o.width=ow; o.height=oh;
    o.getContext('2d').drawImage(c,x0,y0,ow,oh,0,0,ow,oh);
    post({type:'sig',data:o.toDataURL('image/png')});
  };
  post({type:'ready'});
})();
</script></body></html>`;

export default function SignaturePad({
  onCaptured, onEmpty,
}: {
  /** A file:// path to a PNG on disk, ready to upload. */
  onCaptured: (uri: string) => void;
  onEmpty?: () => void;
}) {
  const web = useRef<WebView>(null);
  const [drawn, setDrawn] = useState(false);
  const [busy, setBusy] = useState(false);

  const onMessage = useCallback(async (e: any) => {
    let msg: any = null;
    try { msg = JSON.parse(e?.nativeEvent?.data || '{}'); } catch { return; }
    if (msg.type === 'state') { setDrawn(!!msg.drawn); return; }
    if (msg.type === 'empty') { setBusy(false); onEmpty?.(); return; }
    if (msg.type !== 'sig' || !msg.data) return;
    try {
      const base64 = String(msg.data).replace(/^data:image\/png;base64,/, '');
      const uri = `${cacheDirectory}signature_${base64.length}.png`;
      await writeAsStringAsync(uri, base64, { encoding: EncodingType.Base64 });
      onCaptured(uri);
    } catch {
      onEmpty?.();
    } finally {
      setBusy(false);
    }
  }, [onCaptured, onEmpty]);

  return (
    <View style={s.wrap}>
      <View style={s.padOuter}>
        <View style={s.pad}>
          <WebView
            ref={web}
            source={{ html: PAGE }}
            originWhitelist={['*']}
            javaScriptEnabled
            scrollEnabled={false}
            bounces={false}
            overScrollMode="never"
            onMessage={onMessage}
            style={s.web}
            containerStyle={s.web}
          />
          {!drawn && (
            <View style={s.hintWrap} pointerEvents="none">
              <View style={s.baseline} />
              <Text style={s.hint}>Sign here with your finger</Text>
            </View>
          )}
        </View>
      </View>

      <View style={s.tools}>
        <TouchableOpacity
          style={s.tool}
          activeOpacity={0.85}
          disabled={!drawn || busy}
          onPress={() => web.current?.injectJavaScript('window.__clear();true;')}
        >
          <Ionicons name="refresh" size={15} color={drawn ? E.textMuted : E.textFaint} />
          <Text style={[s.toolTx, !drawn && { color: E.textFaint }]}>Clear</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[s.save, (!drawn || busy) && s.saveOff]}
          activeOpacity={0.9}
          disabled={!drawn || busy}
          onPress={() => { setBusy(true); web.current?.injectJavaScript('window.__export();true;'); }}
        >
          {busy
            ? <ActivityIndicator size="small" color="#fff" />
            : <><Ionicons name="checkmark" size={16} color="#fff" /><Text style={s.saveTx}>Use this</Text></>}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { gap: 12 },
  // Shadow outside, clipping inside — iOS drops a shadow drawn on an overflow:'hidden' view.
  padOuter: {
    borderRadius: 18,
    shadowColor: '#0B0F22', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.08, shadowRadius: 16, elevation: 3,
  },
  pad: {
    height: 190, borderRadius: 18, overflow: 'hidden',
    backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: 'rgba(11,15,34,0.08)',
  },
  web: { flex: 1, backgroundColor: 'transparent' },
  hintWrap: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 44 },
  baseline: { position: 'absolute', left: 26, right: 26, bottom: 56, height: 1, backgroundColor: 'rgba(11,15,34,0.12)' },
  hint: { fontSize: 12.5, fontWeight: '600', color: E.textFaint, flexShrink: 1 },

  tools: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  tool: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    height: 46, paddingHorizontal: 18, borderRadius: 14,
    backgroundColor: E.inputBg, borderWidth: 1, borderColor: E.border,
  },
  toolTx: { fontSize: 13.5, fontWeight: '700', color: E.textMuted, flexShrink: 1 },
  save: {
    flex: 1, height: 46, borderRadius: 14, backgroundColor: E.blueDeep,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
  },
  saveOff: { backgroundColor: '#C3CEDF' },
  saveTx: { fontSize: 14.5, fontWeight: '800', color: '#fff', flexShrink: 1 },
});
