// AI Hub — new feature. Safe to delete without affecting existing app.
//
// A signature, two ways: drawn with a finger, or set in a hand the device already owns.
//
// ⚠️ THIS HAS TO BE A WEBVIEW, AND NOT BECAUSE ANYONE PREFERRED IT. Drawing a smooth stroke needs a
// vector path, and there is no react-native-svg, no skia and no canvas library in this project —
// nor may any be added. The only honest pure-RN alternative is a PanResponder feeding hundreds of
// absolutely-positioned rotated Views, which is janky, and worse, cannot produce the PNG the
// server's /users/profile/signature endpoint expects. An HTML <canvas> gives a real path, real
// smoothing and a real toDataURL — and the exact bridge is already proven in production by App.js,
// which uses this same postMessage → base64 → writeAsStringAsync → multipart chain.
//
// ⚠️ NO NETWORK, WHICH IS WHY THE TYPED HANDS ARE THE DEVICE'S OWN. App.js's older "generate my
// signature" pulls cursive faces from Google Fonts and therefore silently produces nothing on a
// bad connection — and expo-font cannot help, because a bundled face would have to be added to the
// repo and loaded before first paint. Every device already ships several joined hands (iOS has
// Snell Roundhand, Savoye, Zapfino, Bradley Hand, Noteworthy, SignPainter; Android has its cursive
// and casual families), so the page ASKS THE DEVICE what it has, by measuring: a font that did not
// resolve measures identically to the fallback. Faces that resolve to the same metrics are folded
// together, so Android shows its three real hands rather than five copies of Dancing Script.
//
// ⚠️ ENHANCE IS A RE-RENDER, NOT A FILTER. Every point is kept with its timestamp, so "smooth" can
// re-draw the same gesture as a tapered ribbon — Catmull-Rom through the samples, width driven by
// how fast the finger was moving. That is what makes ink read as ink; a blur of the same bitmap
// would only make it foggy. It is reversible for the same reason: nothing was destroyed.
//
// ⚠️ THE CANVAS IS 2x AND EXPORTS AT 2x. A signature captured at 1x is visibly ragged once it is
// scaled onto a printed A4 letterhead.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, TextInput,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import { writeAsStringAsync, cacheDirectory, EncodingType } from 'expo-file-system/legacy';
import { E } from '../employer-home/theme';

const PAGE = `<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>
  html,body{margin:0;padding:0;height:100%;background:#FFFFFF;overflow:hidden;
            -webkit-user-select:none;user-select:none;-webkit-touch-callout:none;
            font-family:-apple-system,system-ui,sans-serif;}
  #c{display:block;width:100%;height:100%;touch-action:none;}
  #g{display:none;height:100%;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:8px;box-sizing:border-box;}
  body.type #c{display:none;} body.type #g{display:block;}
  .op{position:relative;border:1.5px solid rgba(11,15,34,0.07);border-radius:12px;margin-bottom:8px;
      background:#fff;overflow:hidden;}
  .op.on{border-color:#2563EB;background:rgba(37,99,235,0.05);}
  .op canvas{display:block;width:100%;}
  .tag{position:absolute;left:9px;top:7px;font-size:9px;letter-spacing:.9px;font-weight:700;
       text-transform:uppercase;color:rgba(11,15,34,0.28);}
  .op.on .tag{color:#2563EB;}
  .tick{position:absolute;right:9px;top:50%;margin-top:-9px;width:18px;height:18px;border-radius:9px;
        background:#2563EB;display:none;}
  .tick:after{content:'';position:absolute;left:5px;top:4px;width:5px;height:9px;
              border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg);}
  .op.on .tick{display:block;}
</style></head><body>
<canvas id="c"></canvas>
<div id="g"></div>
<script>
(function(){
  var S=2, INK='#0B0F22';
  var c=document.getElementById('c'), ctx=c.getContext('2d');
  var gal=document.getElementById('g');
  var strokes=[], cur=null, drawing=false, smooth=false;
  var mode='draw', name='', styles=[], pick=0;

  function post(o){ if(window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(o)); }
  function drawn(){ for(var i=0;i<strokes.length;i++) if(strokes[i].length) return true; return false; }
  function announce(){ post({type:'state',drawn:drawn()}); }

  /* ── the pad ─────────────────────────────────────────────────────────────────────────────── */
  function size(){
    var w=c.clientWidth, h=c.clientHeight;
    if(!w||!h) return;
    c.width=w*S; c.height=h*S;
    ctx.setTransform(S,0,0,S,0,0);
    ctx.lineCap='round'; ctx.lineJoin='round'; ctx.strokeStyle=INK; ctx.fillStyle=INK;
    render();
  }
  function pt(e){
    var r=c.getBoundingClientRect(), t=(e.touches&&e.touches[0])||e;
    return {x:t.clientX-r.left, y:t.clientY-r.top, t:Date.now()};
  }
  function down(e){
    e.preventDefault(); drawing=true; cur=[pt(e)]; strokes.push(cur);
    render(); announce();
  }
  function move(e){
    if(!drawing) return; e.preventDefault();
    var p=pt(e), l=cur[cur.length-1];
    // Anything closer than a pixel is finger noise, and it wrecks the speed estimate.
    if(Math.abs(p.x-l.x)+Math.abs(p.y-l.y) < 0.7) return;
    cur.push(p); render();
  }
  function up(e){ if(!drawing) return; e.preventDefault(); drawing=false; cur=null; render(); }
  c.addEventListener('touchstart',down,{passive:false});
  c.addEventListener('touchmove',move,{passive:false});
  c.addEventListener('touchend',up,{passive:false});
  c.addEventListener('touchcancel',up,{passive:false});
  c.addEventListener('mousedown',down); c.addEventListener('mousemove',move);
  window.addEventListener('mouseup',up);
  window.addEventListener('resize',size);

  /* ── ink ─────────────────────────────────────────────────────────────────────────────────── */
  // Raw: a quadratic through the midpoints. A polyline of touch samples reads as a jagged scribble.
  function raw(g, pts){
    if(pts.length===1){ g.beginPath(); g.arc(pts[0].x,pts[0].y,1.5,0,6.284); g.fill(); return; }
    g.lineWidth=2.6; g.beginPath(); g.moveTo(pts[0].x,pts[0].y);
    var mx=pts[0].x, my=pts[0].y;
    for(var i=1;i<pts.length;i++){
      var m={x:(pts[i-1].x+pts[i].x)/2, y:(pts[i-1].y+pts[i].y)/2};
      g.quadraticCurveTo(pts[i-1].x,pts[i-1].y,m.x,m.y);
      mx=m.x; my=m.y;
    }
    g.lineTo(pts[pts.length-1].x,pts[pts.length-1].y);
    g.stroke();
  }
  // Speed per sample, in px/ms, so the ribbon can thin where the finger ran.
  function speeds(pts){
    var v=[];
    for(var i=0;i<pts.length;i++){
      if(i===0){ v.push(0); continue; }
      var dt=Math.max(8, pts[i].t-pts[i-1].t);
      v.push(Math.hypot(pts[i].x-pts[i-1].x, pts[i].y-pts[i-1].y)/dt);
    }
    // A three-tap mean: raw speed jumps between consecutive samples and the width would flicker.
    var o=[];
    for(var j=0;j<v.length;j++){
      var a=v[Math.max(0,j-1)], b=v[j], d=v[Math.min(v.length-1,j+1)];
      o.push((a+b+d)/3);
    }
    return o;
  }
  function spline(pts, vs){
    if(pts.length<3) return pts.map(function(p,i){ return {x:p.x,y:p.y,v:vs[i]||0}; });
    var out=[];
    for(var i=0;i<pts.length-1;i++){
      var p0=pts[i-1]||pts[i], p1=pts[i], p2=pts[i+1], p3=pts[i+2]||pts[i+1];
      var v1=vs[i], v2=vs[i+1];
      var n=Math.max(2, Math.min(16, Math.ceil(Math.hypot(p2.x-p1.x,p2.y-p1.y)/2.2)));
      for(var j=0;j<n;j++){
        var t=j/n, t2=t*t, t3=t2*t;
        out.push({
          x:0.5*((2*p1.x)+(-p0.x+p2.x)*t+(2*p0.x-5*p1.x+4*p2.x-p3.x)*t2+(-p0.x+3*p1.x-3*p2.x+p3.x)*t3),
          y:0.5*((2*p1.y)+(-p0.y+p2.y)*t+(2*p0.y-5*p1.y+4*p2.y-p3.y)*t2+(-p0.y+3*p1.y-3*p2.y+p3.y)*t3),
          v:v1+(v2-v1)*t
        });
      }
    }
    var last=pts[pts.length-1];
    out.push({x:last.x,y:last.y,v:vs[vs.length-1]||0});
    return out;
  }
  // Enhanced: one filled ribbon, thick where the finger was slow, tapered at both ends.
  function inked(g, pts){
    if(pts.length<2){ g.beginPath(); g.arc(pts[0].x,pts[0].y,1.7,0,6.284); g.fill(); return; }
    var sp=spline(pts, speeds(pts));
    var n=sp.length, W=[];
    for(var i=0;i<n;i++){
      var f=Math.max(0, Math.min(1, sp[i].v/0.9));
      var w=3.5-2.1*f;
      // Taper the first and last few millimetres — a stroke that starts at full width reads stamped.
      var edge=Math.min(i, n-1-i)/Math.max(1, Math.min(9, (n-1)/2));
      W.push(w*(0.42+0.58*Math.min(1,edge)));
    }
    // A five-tap mean over the widths, or a single noisy sample pinches the ribbon.
    var WS=[];
    for(var m=0;m<n;m++){
      var sum=0, cnt=0;
      for(var q=Math.max(0,m-2);q<=Math.min(n-1,m+2);q++){ sum+=W[q]; cnt++; }
      WS.push(sum/cnt);
    }
    W=WS;
    var L=[], R=[];
    for(var k=0;k<n;k++){
      // ⚠️ THE TANGENT SPANS FIVE SAMPLES, NOT TWO. The spline lands a point every ~2px, so two
      // adjacent ones are nearly collinear and their normal swings with rounding error — which
      // showed up as a bumpy, chewed edge along an otherwise clean curve.
      var a=sp[Math.max(0,k-2)], b=sp[Math.min(n-1,k+2)];
      var dx=b.x-a.x, dy=b.y-a.y, len=Math.hypot(dx,dy)||1;
      var nx=-dy/len, ny=dx/len, h=W[k]/2;
      L.push({x:sp[k].x+nx*h, y:sp[k].y+ny*h});
      R.push({x:sp[k].x-nx*h, y:sp[k].y-ny*h});
    }
    g.beginPath();
    g.moveTo(L[0].x,L[0].y);
    for(var p=1;p<n;p++) g.lineTo(L[p].x,L[p].y);
    for(var q=n-1;q>=0;q--) g.lineTo(R[q].x,R[q].y);
    g.closePath(); g.fill();
    g.beginPath(); g.arc(sp[0].x,sp[0].y,W[0]/2,0,6.284); g.fill();
    g.beginPath(); g.arc(sp[n-1].x,sp[n-1].y,W[n-1]/2,0,6.284); g.fill();
  }
  function render(){
    ctx.clearRect(0,0,c.width,c.height);
    for(var i=0;i<strokes.length;i++){
      if(!strokes[i].length) continue;
      if(smooth) inked(ctx, strokes[i]); else raw(ctx, strokes[i]);
    }
  }

  /* ── typed hands ─────────────────────────────────────────────────────────────────────────── */
  // label, family stack, size, slant in degrees, and whether it gets an underline swash.
  var CANDIDATES=[
    ['Roundhand','"Snell Roundhand","Savoye LET",cursive',44,-2,1],
    ['Script','"Savoye LET","Snell Roundhand",cursive',50,-5,0],
    ['Flourish','Zapfino,"Snell Roundhand",cursive',26,0,0],
    ['Signwriter','SignPainter,"Bradley Hand",cursive',44,-3,1],
    ['Hand','"Bradley Hand",casual,cursive',40,-3,0],
    ['Notes','Noteworthy,casual,cursive',36,-1,1],
    ['Cursive','cursive',44,-3,1],
    ['Classic','italic "Times New Roman",serif',40,-4,1]
  ];
  // A face that did not resolve measures exactly like the fallback, and two styles that resolved to
  // the SAME face measure like each other — both are folded out here, so the gallery only ever
  // shows hands this device can really draw.
  function resolve(){
    var probe=document.createElement('canvas').getContext('2d');
    var seen={}, out=[];
    probe.font='40px monospace';
    var base=Math.round(probe.measureText('Signature Mg').width*10);
    for(var i=0;i<CANDIDATES.length;i++){
      var st=CANDIDATES[i];
      probe.font='40px '+st[1];
      var w=Math.round(probe.measureText('Signature Mg').width*10);
      if(w===base && st[1].indexOf('serif')<0 && st[1]!=='cursive') continue;
      if(seen[w]) continue;
      seen[w]=1;
      out.push({label:st[0], font:st[1], size:st[2], slant:st[3], swash:st[4]});
    }
    if(!out.length) out.push({label:'Classic', font:'italic "Times New Roman",serif', size:40, slant:-4, swash:1});
    return out;
  }
  // A style's CSS font shorthand at a given size. The italic lives at the FRONT of the shorthand,
  // never in the family list, or the whole declaration is invalid and silently ignored.
  function fontStr(st, size){
    var it=st.font.indexOf('italic')===0;
    return (it?'italic ':'')+size+'px '+(it?st.font.slice(7):st.font);
  }
  // One signature, drawn into any context at any scale. Returns its measured width.
  function sign(g, st, text, x, y, scale){
    var size=st.size*scale;
    g.save();
    g.translate(x,y);
    g.rotate(st.slant*Math.PI/180);
    g.font=fontStr(st,size);
    g.fillStyle=INK; g.textBaseline='alphabetic';
    g.fillText(text,0,0);
    var w=g.measureText(text).width;
    if(st.swash){
      // The stroke a person adds under their own name. Two curves so it is not a straight rule.
      g.strokeStyle=INK; g.lineWidth=Math.max(1.2, size*0.045); g.lineCap='round';
      g.beginPath();
      g.moveTo(-size*0.06, size*0.20);
      g.quadraticCurveTo(w*0.42, size*0.40, w*0.86, size*0.16);
      g.quadraticCurveTo(w*0.99, size*0.06, w*0.72, size*0.10);
      g.stroke();
    }
    g.restore();
    return w;
  }
  /**
   * ⚠️ EVERY PREVIEW IS DRAWN BIG, TRIMMED, AND THEN FITTED — it is not text laid out in a box.
   * These faces disagree wildly about what "40px" means (Zapfino's ascenders are three times
   * Bradley Hand's) and the slant adds height the metrics do not report, so a shared font size
   * clipped the tall ones and left the short ones swimming. Trimming to the ink first makes every
   * hand the same optical size, which is also the only way to compare them.
   */
  var BM={};
  function bitmap(st, text){
    var key=st.label+'|'+text;
    if(BM[key]) return BM[key];
    var probe=document.createElement('canvas').getContext('2d');
    probe.font=fontStr(st, st.size);
    var w=probe.measureText(text).width;
    var o=document.createElement('canvas');
    o.width=Math.ceil((w+st.size*1.8)*S);
    o.height=Math.ceil(st.size*3.2*S);
    var g=o.getContext('2d');
    g.setTransform(S,0,0,S,0,0);
    sign(g, st, text, st.size*0.6, st.size*1.9, 1);
    BM[key]=trim(o);
    return BM[key];
  }
  function gallery(){
    gal.innerHTML='';
    var text=(name||'').trim();
    if(!text){ gal.innerHTML='<div style="padding:26px 12px;text-align:center;font-size:13px;'+
      'font-weight:600;color:rgba(11,15,34,0.4)">Type the name you sign with.</div>'; return; }
    var W=gal.clientWidth-16-3, H=84;
    for(var i=0;i<styles.length;i++){
      (function(i){
        var st=styles[i];
        var d=document.createElement('div');
        d.className='op'+(i===pick?' on':'');
        d.innerHTML='<span class="tag">'+st.label+'</span><span class="tick"></span>';
        var cv=document.createElement('canvas');
        cv.width=W*S; cv.height=H*S; cv.style.height=H+'px';
        var g=cv.getContext('2d'); g.setTransform(S,0,0,S,0,0);
        var bm=bitmap(st,text), bw=bm.width/S, bh=bm.height/S;
        // Room on the right for the tick, and never blown up past its natural size.
        var sc=Math.min((W-64)/bw, (H-18)/bh, 1.15);
        g.drawImage(bm, 0,0,bm.width,bm.height, 18, (H-bh*sc)/2+5, bw*sc, bh*sc);
        d.appendChild(cv);
        d.addEventListener('click', function(){ pick=i; gallery(); post({type:'style',i:i}); });
        gal.appendChild(d);
      })(i);
    }
  }
  // Re-drawing eight faces on every keystroke is work nobody sees; one frame after they stop is.
  var galT=null;
  function galSoon(){ if(galT) clearTimeout(galT); galT=setTimeout(function(){ galT=null; gallery(); }, 140); }

  /* ── the bridge ──────────────────────────────────────────────────────────────────────────── */
  window.__clear=function(){ strokes=[]; cur=null; render(); announce(); };
  window.__smooth=function(on){ smooth=!!on; render(); };
  window.__mode=function(m){
    mode=(m==='type')?'type':'draw';
    document.body.className=(mode==='type')?'type':'';
    if(mode==='type') gallery(); else size();
  };
  window.__name=function(n){ name=String(n||''); if(mode==='type') galSoon(); };
  window.__pick=function(i){ pick=Math.max(0,Math.min(styles.length-1,i|0)); if(mode==='type') gallery(); };
  window.__export=function(){
    if(mode==='type'){
      var text=(name||'').trim();
      if(!text){ post({type:'empty'}); return; }
      var st=styles[pick]||styles[0];
      var X=3;                                  // exported larger than the preview: it goes on A4
      var probe=document.createElement('canvas').getContext('2d');
      probe.font=fontStr(st, st.size*X);
      var w=probe.measureText(text).width;
      var o=document.createElement('canvas');
      // Room for the slant and the swash on every side, or a descender lands on the crop edge.
      o.width=Math.ceil(w+st.size*X*1.4); o.height=Math.ceil(st.size*X*2.4);
      sign(o.getContext('2d'), st, text, st.size*X*0.4, o.height*0.60, X);
      post({type:'sig',data:trim(o).toDataURL('image/png')});
      return;
    }
    if(!drawn()){ post({type:'empty'}); return; }
    post({type:'sig',data:trim(c).toDataURL('image/png')});
  };
  // Trim to the ink with a small margin — a signature centred in a huge transparent canvas renders
  // as a speck on a letterhead.
  function trim(src){
    var w=src.width,h=src.height,d=src.getContext('2d').getImageData(0,0,w,h).data;
    var x0=w,y0=h,x1=0,y1=0;
    for(var y=0;y<h;y++) for(var x=0;x<w;x++){
      if(d[(y*w+x)*4+3]>8){ if(x<x0)x0=x; if(x>x1)x1=x; if(y<y0)y0=y; if(y>y1)y1=y; }
    }
    if(x1<x0||y1<y0) return src;
    var pad=Math.round(10*S);
    x0=Math.max(0,x0-pad); y0=Math.max(0,y0-pad);
    x1=Math.min(w-1,x1+pad); y1=Math.min(h-1,y1+pad);
    var ow=x1-x0+1, oh=y1-y0+1;
    var o=document.createElement('canvas'); o.width=ow; o.height=oh;
    o.getContext('2d').drawImage(src,x0,y0,ow,oh,0,0,ow,oh);
    return o;
  }

  size();
  styles=resolve();
  post({type:'ready',styles:styles.map(function(s){return s.label;})});
})();
</script></body></html>`;

export type SigMode = 'draw' | 'type';

export default function SignatureStudio({
  name, existing, onCaptured, onEmpty,
}: {
  /** What the typed hands are set in — the name from step one, editable here. */
  name: string;
  /** An already-saved signature, so "you have one" is visible rather than assumed. */
  existing?: string | null;
  /** A file:// path to a PNG on disk, ready to upload. */
  onCaptured: (uri: string) => void;
  onEmpty?: () => void;
}) {
  const web = useRef<WebView>(null);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<SigMode>('draw');
  const [drawn, setDrawn] = useState(false);
  const [smooth, setSmooth] = useState(false);
  const [busy, setBusy] = useState(false);
  const [styles, setStyles] = useState<string[]>([]);
  const [signAs, setSignAs] = useState(name);

  const send = useCallback((js: string) => { web.current?.injectJavaScript(`${js};true;`); }, []);

  // The name arrives from step one and can be shortened here; the page is told either way.
  useEffect(() => { if (ready) send(`window.__name(${JSON.stringify(signAs)})`); }, [ready, signAs, send]);
  useEffect(() => { if (ready) send(`window.__mode(${JSON.stringify(mode)})`); }, [ready, mode, send]);

  const onMessage = useCallback(async (e: any) => {
    let msg: any = null;
    try { msg = JSON.parse(e?.nativeEvent?.data || '{}'); } catch { return; }
    if (msg.type === 'ready') { setStyles(msg.styles || []); setReady(true); return; }
    if (msg.type === 'state') { setDrawn(!!msg.drawn); return; }
    if (msg.type === 'style') return;
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

  const canSave = mode === 'draw' ? drawn : !!signAs.trim() && !!styles.length;

  return (
    <View style={s.wrap}>
      <View style={s.tabs}>
        {([['draw', 'Draw it', 'brush-outline'], ['type', 'Pick a hand', 'text-outline']] as const).map(([k, label, icon]) => (
          <TouchableOpacity
            key={k}
            style={[s.tab, mode === k && s.tabOn]}
            activeOpacity={0.9}
            onPress={() => setMode(k as SigMode)}
          >
            <Ionicons name={icon as any} size={15} color={mode === k ? '#fff' : 'rgba(255,255,255,0.6)'} />
            <Text style={[s.tabTx, mode === k && s.tabTxOn]} numberOfLines={1}>{label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {mode === 'type' && (
        <View style={s.asRow}>
          <Text style={s.asLabel}>SIGNED AS</Text>
          <TextInput
            style={s.asInput}
            value={signAs}
            onChangeText={setSignAs}
            placeholder="Your name"
            placeholderTextColor="rgba(255,255,255,0.3)"
            autoCapitalize="words"
            returnKeyType="done"
          />
        </View>
      )}

      {/* Shadow outside, clipping inside — iOS drops a shadow drawn on an overflow:'hidden' view. */}
      <View style={s.padOuter}>
        <View style={[s.pad, mode === 'type' && s.padTall]}>
          <WebView
            ref={web}
            source={{ html: PAGE }}
            originWhitelist={['*']}
            javaScriptEnabled
            scrollEnabled={mode === 'type'}
            bounces={false}
            overScrollMode="never"
            onMessage={onMessage}
            style={s.web}
            containerStyle={s.web}
          />
          {mode === 'draw' && !drawn && (
            <View style={s.hintWrap} pointerEvents="none">
              <View style={s.baseline} />
              <Text style={s.hint}>Sign here with your finger</Text>
            </View>
          )}
        </View>
      </View>

      <View style={s.tools}>
        {mode === 'draw' ? (
          <>
            <TouchableOpacity
              style={s.tool}
              activeOpacity={0.85}
              disabled={!drawn || busy}
              onPress={() => { setSmooth(false); send('window.__smooth(0)'); send('window.__clear()'); }}
            >
              <Ionicons name="refresh" size={15} color={drawn ? E.textMuted : E.textFaint} />
              <Text style={[s.toolTx, !drawn && s.toolOff]}>Clear</Text>
            </TouchableOpacity>
            {/* ⚠️ A TOGGLE, NOT A ONE-WAY BUTTON. The points are kept, so this re-renders the same
                gesture rather than filtering the bitmap — which means it can be turned back off. */}
            <TouchableOpacity
              style={[s.tool, smooth && s.toolOn]}
              activeOpacity={0.85}
              disabled={!drawn || busy}
              onPress={() => { const v = !smooth; setSmooth(v); send(`window.__smooth(${v ? 1 : 0})`); }}
            >
              <Ionicons name={smooth ? 'sparkles' : 'sparkles-outline'} size={15}
                        color={!drawn ? E.textFaint : smooth ? E.blueDeep : E.textMuted} />
              <Text style={[s.toolTx, smooth && s.toolTxOn, !drawn && s.toolOff]}>Enhance</Text>
            </TouchableOpacity>
          </>
        ) : (
          <View style={s.pickHint}>
            <Ionicons name="hand-left-outline" size={14} color={E.textFaint} />
            <Text style={s.pickHintTx} numberOfLines={1}>
              {styles.length > 1 ? `Tap a hand · ${styles.length} on this device` : 'Tap a hand'}
            </Text>
          </View>
        )}

        <TouchableOpacity
          style={[s.save, (!canSave || busy) && s.saveOff]}
          activeOpacity={0.9}
          disabled={!canSave || busy}
          onPress={() => { setBusy(true); send('window.__export()'); }}
        >
          {busy
            ? <ActivityIndicator size="small" color="#fff" />
            : <><Ionicons name="checkmark" size={16} color="#fff" /><Text style={s.saveTx}>Use this</Text></>}
        </TouchableOpacity>
      </View>

      {!!existing && (
        <Text style={s.have}>You already have one saved. Saving a new one replaces it.</Text>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { gap: 10 },

  tabs: { flexDirection: 'row', gap: 8 },
  tab: {
    flex: 1, height: 42, borderRadius: 13, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'center', gap: 7,
    backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: E.glassBorder,
  },
  tabOn: { backgroundColor: 'rgba(79,141,255,0.22)', borderColor: 'rgba(150,186,255,0.6)' },
  tabTx: { fontSize: 13, fontWeight: '700', color: 'rgba(255,255,255,0.6)', flexShrink: 1 },
  tabTxOn: { color: '#fff' },

  asRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, height: 46, paddingHorizontal: 13,
    borderRadius: 13, backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: E.glassBorder,
  },
  asLabel: { fontSize: 9.5, fontWeight: '800', letterSpacing: 1.1, color: 'rgba(255,255,255,0.42)' },
  asInput: { flex: 1, fontSize: 15, fontWeight: '700', color: '#fff', padding: 0, textAlign: 'right' },

  padOuter: {
    borderRadius: 18,
    shadowColor: '#0B0F22', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.08, shadowRadius: 16, elevation: 3,
  },
  pad: {
    height: 178, borderRadius: 18, overflow: 'hidden',
    backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: 'rgba(11,15,34,0.08)',
  },
  padTall: { height: 226 },
  web: { flex: 1, backgroundColor: '#FFFFFF' },
  hintWrap: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 40 },
  baseline: { position: 'absolute', left: 26, right: 26, bottom: 52, height: 1, backgroundColor: 'rgba(11,15,34,0.12)' },
  hint: { fontSize: 12.5, fontWeight: '600', color: E.textFaint, flexShrink: 1 },

  tools: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  tool: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    height: 46, paddingHorizontal: 14, borderRadius: 14,
    backgroundColor: E.inputBg, borderWidth: 1, borderColor: E.border,
  },
  toolOn: { backgroundColor: 'rgba(37,99,235,0.12)', borderColor: 'rgba(37,99,235,0.28)' },
  toolTx: { fontSize: 13, fontWeight: '700', color: E.textMuted, flexShrink: 1 },
  toolTxOn: { color: E.blueDeep },
  toolOff: { color: E.textFaint },

  pickHint: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, height: 46, paddingHorizontal: 12,
    borderRadius: 14, backgroundColor: E.inputBg, borderWidth: 1, borderColor: E.border,
  },
  pickHintTx: { fontSize: 12, fontWeight: '700', color: E.textFaint, flexShrink: 1 },

  save: {
    flex: 1, height: 46, borderRadius: 14, backgroundColor: E.blueDeep,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
  },
  saveOff: { backgroundColor: '#C3CEDF' },
  saveTx: { fontSize: 14.5, fontWeight: '800', color: '#fff', flexShrink: 1 },

  have: { fontSize: 11.5, fontWeight: '600', color: 'rgba(255,255,255,0.45)', textAlign: 'center', flexShrink: 1 },
});
