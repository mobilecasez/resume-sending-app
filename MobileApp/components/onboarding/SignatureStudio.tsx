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
//
// ⚠️ A DRAWN SIGNATURE IS NEVER THROWN AWAY BY "NEXT" (2026-09-19). It used to be saved only by this
// component's own "Use this" — and the wizard's footer "Next" was always enabled, so the owner drew his
// signature, tapped Next, and it was gone: reopening the wizard asked for it again. The studio now says
// when it holds ink nobody has saved (onDirty) and hands the wizard commit(), which exports and uploads
// exactly as "Use this" does and resolves only once the upload has answered — so Next waits for it, and
// stays on the step if it failed.
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, TextInput, Alert,
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
    var o=[];
    for(var j=0;j<v.length;j++){
      var a=v[Math.max(0,j-1)], b=v[j], d=v[Math.min(v.length-1,j+1)];
      o.push((a+b+d)/3);
    }
    return o;
  }
  /* ── ENHANCE, THE PIPELINE ──────────────────────────────────────────────────────────────────
   * ⚠️ THE FIRST VERSION OF THIS DID ALMOST NOTHING, AND THE REASON IS WORTH KEEPING.
   * It ran the raw samples through Catmull-Rom, which is an INTERPOLATING spline: it passes exactly
   * through every point it is given. So every tremor in the original gesture survived intact and
   * "enhance" only added in-between points — smoother in the small, identical in the large.
   * Smoothing has to move points OFF the path they were captured on. Four stages, in order:
   *   1. resample  — uniform spacing, so the filter treats a slow stroke and a fast one alike
   *   2. soften    — a moving average, repeated: this is the stage that actually removes the shake
   *   3. refit     — re-draw through every Nth softened point, so the curve is described by a
   *                  handful of controls rather than hundreds; that is what makes it FLOW
   *   4. ribbon    — variable width from the recorded speed, tapered at both ends
   */
  function resample(pts, step){
    if(pts.length<2) return pts.slice();
    var out=[{x:pts[0].x,y:pts[0].y,v:pts[0].v}], carry=0;
    for(var i=1;i<pts.length;i++){
      var a=pts[i-1], b=pts[i];
      var d=Math.hypot(b.x-a.x, b.y-a.y);
      if(d<0.0001) continue;
      var t=(step-carry)/d;
      while(t<=1){
        out.push({x:a.x+(b.x-a.x)*t, y:a.y+(b.y-a.y)*t, v:a.v+(b.v-a.v)*t});
        t+=step/d;
      }
      carry=(1-(t-step/d))*d;
    }
    var last=pts[pts.length-1];
    out.push({x:last.x,y:last.y,v:last.v});
    return out;
  }
  // ⚠️ THE ENDS ARE PINNED ON EVERY PASS. Without that the average walks the first and last points
  // inward and the stroke visibly shrinks a little each time it is smoothed.
  function soften(pts, passes, w){
    for(var p=0;p<passes;p++){
      var o=[];
      for(var i=0;i<pts.length;i++){
        var sx=0, sy=0, sv=0, n=0;
        for(var k=Math.max(0,i-w);k<=Math.min(pts.length-1,i+w);k++){
          sx+=pts[k].x; sy+=pts[k].y; sv+=pts[k].v; n++;
        }
        o.push({x:sx/n, y:sy/n, v:sv/n});
      }
      o[0]=pts[0]; o[o.length-1]=pts[pts.length-1];
      pts=o;
    }
    return pts;
  }
  function crThrough(ctrl){
    if(ctrl.length<3) return ctrl.slice();
    var out=[];
    for(var i=0;i<ctrl.length-1;i++){
      var p0=ctrl[i-1]||ctrl[i], p1=ctrl[i], p2=ctrl[i+1], p3=ctrl[i+2]||ctrl[i+1];
      var n=Math.max(3, Math.min(24, Math.ceil(Math.hypot(p2.x-p1.x,p2.y-p1.y)/1.4)));
      for(var j=0;j<n;j++){
        var t=j/n, t2=t*t, t3=t2*t;
        out.push({
          x:0.5*((2*p1.x)+(-p0.x+p2.x)*t+(2*p0.x-5*p1.x+4*p2.x-p3.x)*t2+(-p0.x+3*p1.x-3*p2.x+p3.x)*t3),
          y:0.5*((2*p1.y)+(-p0.y+p2.y)*t+(2*p0.y-5*p1.y+4*p2.y-p3.y)*t2+(-p0.y+3*p1.y-3*p2.y+p3.y)*t3),
          v:p1.v+(p2.v-p1.v)*t
        });
      }
    }
    out.push(ctrl[ctrl.length-1]);
    return out;
  }
  function refit(pts, every){
    if(pts.length<=every*2) return pts.slice();
    var ctrl=[pts[0]];
    for(var i=every;i<pts.length-1;i+=every) ctrl.push(pts[i]);
    ctrl.push(pts[pts.length-1]);
    return crThrough(ctrl);
  }
  // Enhanced: one filled ribbon, thick where the finger was slow, tapered at both ends.
  function inked(g, pts){
    if(pts.length<2){ g.beginPath(); g.arc(pts[0].x,pts[0].y,1.8,0,6.284); g.fill(); return; }
    var vs=speeds(pts);
    var src=pts.map(function(p,i){ return {x:p.x,y:p.y,v:vs[i]}; });
    var sp=refit(soften(resample(src, 1.8), 3, 2), 6);
    var n=sp.length;
    if(n<2){ g.beginPath(); g.arc(sp[0].x,sp[0].y,1.8,0,6.284); g.fill(); return; }
    var W=[];
    for(var i=0;i<n;i++){
      var f=Math.max(0, Math.min(1, sp[i].v/0.85));
      var w=4.4-3.1*f;
      // Taper the first and last few millimetres — a stroke that starts at full width reads stamped.
      var edge=Math.min(i, n-1-i)/Math.max(1, Math.min(14, (n-1)/2));
      W.push(w*(0.34+0.66*Math.min(1,edge)));
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
      // ⚠️ THE TANGENT SPANS FIVE SAMPLES, NOT TWO. The curve lands a point every ~1.4px, so two
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
    for(var p2=1;p2<n;p2++) g.lineTo(L[p2].x,L[p2].y);
    for(var q2=n-1;q2>=0;q2--) g.lineTo(R[q2].x,R[q2].y);
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
  // Exports the tab it is asked for (the one on screen when none is named): a commit can save the ink of the tab the
  // user left for one with nothing on it. The drawn canvas keeps its pixels while hidden (size() skips a 0-wide pad).
  window.__export=function(m){
    var md=(m==='type'||m==='draw')?m:mode;
    if(md==='type'){
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
      post({type:'sig',mode:'type',data:trim(o).toDataURL('image/png')});
      return;
    }
    if(!drawn()){ post({type:'empty'}); return; }
    post({type:'sig',mode:'draw',data:trim(c).toDataURL('image/png')});
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

/** What a commit came to: saved (uploaded), empty (no ink / no name), failed (the UPLOAD failed — the wizard's
 *  saveSignature has already said so), stuck (the PAD could not hand the signature over: the page never answered, its
 *  process died, or the image could not be written — nothing has told the user yet, so the caller must), or clean
 *  (there was nothing unsaved to commit). */
export type SigCommit = 'saved' | 'empty' | 'failed' | 'stuck' | 'clean';
/** What the pad holds, for sigToCommit. `typeKey` is the name and the hand on screen ("Rishi|0"); `savedTypeKey` the
 *  one last saved from the gallery (null: none). */
export type SigPad = {
  mode: SigMode; drawnUnsaved: boolean; typeTapped: boolean;
  name: string; hands: number; typeKey: string; savedTypeKey: string | null;
};

/**
 * WHICH TAB A COMMIT SAVES — or null when nothing on the pad is unsaved. Pure, so the suite runs it.
 * ⚠️ THE HAND ON SCREEN IS A CHOICE ALREADY MADE (review round 2, 2026-09-19). The gallery opens with hand #1 ticked and
 * "Use this" lit — yet only a TAP counted as unsaved, so Next on the hand the screen showed as chosen found nothing
 * to save, the wizard stored the signature as SKIPPED, and letters went out unsigned: the owner's "not saved
 * signature", again. So on the "Pick a hand" tab, a name in a hand is unsaved until exactly that name in exactly that
 * hand was saved.
 * ⚠️ AND WORK LEFT ON THE OTHER TAB IS NOT THROWN AWAY: ink drawn before switching to a tab with nothing on it (the
 * name cleared), or a hand TAPPED before switching to an empty pad, is what gets saved. A hand merely looked at and
 * left is not (the pad on screen is empty; that is a skip).
 * ⚠️ …BUT THE UNTAPPED HAND ON SCREEN IS A CHOICE ONLY WHEN THE USER SAID "NEXT" (review round 4, 2026-09-20). Counted
 * everywhere, it made "Skip for now", the back arrow, the step dots and the close/swipe guard upload the pre-ticked
 * hand #1 — a cursive signature the user had just turned down, which then signed every letter. So `handOnScreen` is
 * off unless the caller is Next: without it, only drawn ink or a TAPPED hand is unsaved work.
 */
export function sigToCommit(s: SigPad, handOnScreen = false): SigMode | null {
  const typeReady = !!s.name.trim() && s.hands > 0 && s.typeKey !== s.savedTypeKey;
  if (s.mode === 'type') return typeReady && (handOnScreen || s.typeTapped) ? 'type' : s.drawnUnsaved ? 'draw' : null;
  if (s.drawnUnsaved) return 'draw';
  return typeReady && s.typeTapped ? 'type' : null;
}

export type SignatureStudioHandle = {
  /** Ink or a tapped hand that nobody has saved yet (sigToCommit without handOnScreen) — what the leave guard saves. */
  isDirty: () => boolean;
  /** Export + upload what is on the pad — the same path as "Use this" — and resolve once the upload answered.
   *  `handOnScreen`: the untapped hand the gallery shows ticked counts too — for the wizard's Next, and nothing else. */
  commit: (opts?: { handOnScreen?: boolean }) => Promise<SigCommit>;
};

const SignatureStudio = forwardRef<SignatureStudioHandle, {
  /** What the typed hands are set in — the name from step one, editable here. */
  name: string;
  /** An already-saved signature, so "you have one" is visible rather than assumed. */
  existing?: string | null;
  /** A file:// path to a PNG on disk, ready to upload. Resolve false when the upload failed (the ink stays unsaved). */
  onCaptured: (uri: string) => void | boolean | Promise<void | boolean>;
  onEmpty?: () => void;
  /** Called when the pad starts / stops holding something unsaved. */
  onDirty?: (dirty: boolean) => void;
}>(function SignatureStudio({
  name, existing, onCaptured, onEmpty, onDirty,
}, ref) {
  const web = useRef<WebView>(null);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<SigMode>('draw');
  const [drawn, setDrawn] = useState(false);
  const [smooth, setSmooth] = useState(false);
  const [busy, setBusy] = useState(false);
  const [styles, setStyles] = useState<string[]>([]);
  const [signAs, setSignAs] = useState(name);
  // Unsaved work, PER TAB: a stroke since the last save (draw), a hand TAPPED since then (type); with the name and hand
  // on screen and the last ones saved from the gallery. What a commit saves — and so "dirty" — is sigToCommit's answer
  // ("dirty" without handOnScreen: the untapped hand on screen never arms the leave guard).
  const unsaved = useRef<Record<SigMode, boolean>>({ draw: false, type: false });
  const modeRef = useRef<SigMode>('draw');
  modeRef.current = mode;
  const signAsRef = useRef(signAs);
  signAsRef.current = signAs;
  const handsRef = useRef(0);
  handsRef.current = styles.length;
  const pickRef = useRef(0);   // the page opens with hand #1 ticked; a tap says which ('style')
  const savedTypeKey = useRef<string | null>(null);
  const typeKeyOf = useCallback(() => `${signAsRef.current.trim()}|${pickRef.current}`, []);
  const toCommit = useCallback((handOnScreen = false): SigMode | null => sigToCommit({
    mode: modeRef.current, drawnUnsaved: unsaved.current.draw, typeTapped: unsaved.current.type,
    name: signAsRef.current, hands: handsRef.current, typeKey: typeKeyOf(), savedTypeKey: savedTypeKey.current,
  }, handOnScreen), [typeKeyOf]);
  const dirty = useRef(false);
  const syncDirty = useCallback(() => {
    const v = toCommit() !== null;
    if (dirty.current === v) return;
    dirty.current = v;
    onDirty?.(v);
  }, [onDirty, toCommit]);
  const setDirty = useCallback((v: boolean, which: SigMode = modeRef.current) => {
    unsaved.current[which] = v;
    syncDirty();
  }, [syncDirty]);
  // The tab, the name and the hands on offer each change what a commit would save.
  useEffect(() => { syncDirty(); }, [mode, signAs, styles.length, syncDirty]);
  // The commit() waiting for this export's answer (the "Use this" button waits through the same path).
  const pending = useRef<((r: SigCommit) => void) | null>(null);
  // The tab that export was asked for, and the name and hand it had then (recorded as saved when its upload lands).
  const exporting = useRef<{ mode: SigMode; key: string } | null>(null);
  const settle = useCallback((r: SigCommit) => {
    const p = pending.current;
    pending.current = null;
    if (p) p(r);
  }, []);

  /**
   * ⚠️ A PAD WHOSE PAGE HAS DIED IS RELOADED, NOT LEFT BLANK AND "DIRTY" (review, 2026-09-20). iOS kills a WKWebView's
   * content process under memory pressure (the photo picker on this same step, a long spell in the background) and
   * react-native-webview does not reload it; the pad went blank while `unsaved.draw` stayed true, so every Next and back
   * waited 8 s for an export nobody could answer and then did nothing. The page is remounted (a new key) with a clean
   * slate — its ink went with the process — and a commit still waiting on it settles 'stuck' so the caller can say so.
   * The export watchdog comes here too: a page that has not answered in 8 s is one nobody can use.
   */
  const [pageKey, setPageKey] = useState(0);
  const resetPage = useCallback(() => {
    setReady(false);
    setDrawn(false);
    setSmooth(false);
    setBusy(false);
    unsaved.current = { draw: false, type: false };
    pickRef.current = 0;              // the new page opens with hand #1 ticked again
    syncDirty();
    setPageKey((k) => k + 1);
    settle('stuck');
  }, [settle, syncDirty]);

  const send = useCallback((js: string) => { web.current?.injectJavaScript(`${js};true;`); }, []);

  // The name arrives from step one and can be shortened here; the page is told either way.
  useEffect(() => { if (ready) send(`window.__name(${JSON.stringify(signAs)})`); }, [ready, signAs, send]);
  useEffect(() => { if (ready) send(`window.__mode(${JSON.stringify(mode)})`); }, [ready, mode, send]);

  const onMessage = useCallback(async (e: any) => {
    let msg: any = null;
    try { msg = JSON.parse(e?.nativeEvent?.data || '{}'); } catch { return; }
    if (msg.type === 'ready') { setStyles(msg.styles || []); setReady(true); return; }
    if (msg.type === 'state') { setDrawn(!!msg.drawn); setDirty(!!msg.drawn, 'draw'); return; }
    if (msg.type === 'style') { pickRef.current = Math.max(0, Number(msg.i) || 0); setDirty(true, 'type'); return; }
    if (msg.type === 'empty') {
      setBusy(false);
      // A commit from the wizard's Next finds nothing to save — that is not an error to shout about.
      if (pending.current) settle('empty'); else onEmpty?.();
      return;
    }
    if (msg.type !== 'sig' || !msg.data) return;
    // ⚠️ THE PAGE HAS ANSWERED: from here the UPLOAD's own result settles the commit (review, 2026-09-19). The request
    // leaves `pending`, so the 8 s watchdog — which is for a WebView that never answers — cannot fail a signature whose
    // upload is merely slow (on 3G, Next "did nothing" and the pad then turned into the saved image by itself).
    const waiting = pending.current;
    pending.current = null;
    const sent = exporting.current;
    let result: SigCommit = 'failed';
    try {
      const base64 = String(msg.data).replace(/^data:image\/png;base64,/, '');
      const uri = `${cacheDirectory}signature_${base64.length}.png`;
      await writeAsStringAsync(uri, base64, { encoding: EncodingType.Base64 });
      const up = await onCaptured(uri);
      result = up === false ? 'failed' : 'saved';
      if (result === 'saved') {
        // What was saved IS the signature now: the hand it was (if a hand), and neither tab's older work is pending.
        if ((msg.mode || (sent && sent.mode)) === 'type' && sent) savedTypeKey.current = sent.key;
        unsaved.current.draw = false;
        unsaved.current.type = false;
        syncDirty();
      }
    } catch {
      // The image could not be written (or handed over): no upload was tried, so no upload alert was shown — 'stuck',
      // which every caller turns into a sentence (it used to be a silent 'failed').
      result = 'stuck';
      if (!waiting) onEmpty?.();
    } finally {
      setBusy(false);
      if (waiting) waiting(result);
    }
  }, [onCaptured, onEmpty, setDirty, syncDirty]);

  /**
   * The one export path: "Use this" and the wizard's commit() both come through here.
   * ONE AT A TIME: a second ask while an export (or its upload) is still going JOINS it — the leave guard can commit
   * while Next's upload is in flight, and two exports would be two uploads of the same ink.
   */
  const inflight = useRef<Promise<SigCommit> | null>(null);
  const exportNow = useCallback((which: SigMode): Promise<SigCommit> => {
    if (inflight.current) return inflight.current;
    exporting.current = { mode: which, key: typeKeyOf() };
    const run = new Promise<SigCommit>((resolve) => {
      pending.current = resolve;
      setBusy(true);
      send(`window.__export(${JSON.stringify(which)})`);
      // The page always answers ('sig' or 'empty'); a WebView that has gone away must not hang the step — it is
      // reloaded and the commit settles 'stuck' (resetPage).
      setTimeout(() => { if (pending.current === resolve) resetPage(); }, 8000);
    });
    const joined = run.then((r) => { inflight.current = null; return r; });
    inflight.current = joined;
    return joined;
  }, [send, resetPage, typeKeyOf]);

  /** "Use this": the studio's own button, so the studio says what went wrong (the upload's own alert is the wizard's). */
  const saveNow = useCallback(async () => {
    const r = await exportNow(modeRef.current);
    if (r === 'empty') onEmpty?.();
    else if (r === 'stuck') Alert.alert('Your signature is not saved', 'The signature pad stopped working. Please try again.');
  }, [exportNow, onEmpty]);

  useImperativeHandle(ref, () => ({
    isDirty: () => dirty.current,
    // Saves the tab sigToCommit names — the hand on screen counts only when the caller says so (Next), else a tapped one.
    commit: async (opts?: { handOnScreen?: boolean }) => {
      const which = ready ? toCommit(!!(opts && opts.handOnScreen)) : null;
      return which ? exportNow(which) : 'clean';
    },
  }), [exportNow, ready, toCommit]);

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
            key={pageKey}
            ref={web}
            // A page whose process died is reloaded clean (resetPage) — iOS and Android each report it their own way.
            onContentProcessDidTerminate={resetPage}
            onRenderProcessGone={resetPage}
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
              <Ionicons name="refresh" size={15} color={drawn ? 'rgba(255,255,255,0.72)' : 'rgba(255,255,255,0.32)'} />
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
                        color={!drawn ? 'rgba(255,255,255,0.32)' : smooth ? E.mint : 'rgba(255,255,255,0.72)'} />
              <Text style={[s.toolTx, smooth && s.toolTxOn, !drawn && s.toolOff]}>Enhance</Text>
            </TouchableOpacity>
          </>
        ) : (
          <View style={s.pickHint}>
            <Ionicons name="hand-left-outline" size={14} color="rgba(255,255,255,0.45)" />
            <Text style={s.pickHintTx} numberOfLines={1}>
              {styles.length > 1 ? `Tap a hand · ${styles.length} on this device` : 'Tap a hand'}
            </Text>
          </View>
        )}

        <TouchableOpacity
          style={[s.save, (!canSave || busy) && s.saveOff]}
          activeOpacity={0.9}
          disabled={!canSave || busy}
          onPress={() => { saveNow(); }}
        >
          {busy
            ? <ActivityIndicator size="small" color="#04211C" />
            : <><Ionicons name="checkmark" size={16} color={canSave ? '#04211C' : 'rgba(255,255,255,0.4)'} /><Text style={[s.saveTx, !canSave && s.saveTxOff]}>Use this</Text></>}
        </TouchableOpacity>
      </View>

      {!!existing && (
        <Text style={s.have}>You already have one saved. Saving a new one replaces it.</Text>
      )}
    </View>
  );
});

export default SignatureStudio;

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

  // ⚠️ THE TOOLS BELONG TO THE PAGE, NOT TO THE PAD. Light chips under a white pad ran the two
  // together into one pale block that read as a separate section pasted onto a dark screen. They
  // are glass on the page now, and the one that commits is the same mint as every other primary
  // action in this flow.
  tools: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  tool: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    height: 46, paddingHorizontal: 14, borderRadius: 14,
    backgroundColor: 'rgba(6,11,30,0.42)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
  },
  toolOn: { backgroundColor: 'rgba(45,224,192,0.16)', borderColor: 'rgba(45,224,192,0.38)' },
  toolTx: { fontSize: 13, fontWeight: '700', color: 'rgba(255,255,255,0.72)', flexShrink: 1 },
  toolTxOn: { color: E.mint },
  toolOff: { color: 'rgba(255,255,255,0.32)' },

  pickHint: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, height: 46, paddingHorizontal: 12,
    borderRadius: 14, backgroundColor: 'rgba(6,11,30,0.42)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
  },
  pickHintTx: { fontSize: 12, fontWeight: '700', color: 'rgba(255,255,255,0.45)', flexShrink: 1 },

  save: {
    flex: 1, height: 46, borderRadius: 14, backgroundColor: '#2DE0C0',
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
  },
  saveOff: { backgroundColor: 'rgba(255,255,255,0.09)' },
  saveTx: { fontSize: 14.5, fontWeight: '800', color: '#04211C', flexShrink: 1 },
  saveTxOff: { color: 'rgba(255,255,255,0.4)' },

  have: { fontSize: 11.5, fontWeight: '600', color: 'rgba(255,255,255,0.45)', textAlign: 'center', flexShrink: 1 },
});
