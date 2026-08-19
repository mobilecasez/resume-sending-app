/**
 * The built scenes - the ones with no footage behind them - rendered as PNG frame sequences
 * straight out of headless Chromium.
 *
 * Frames, not a video filter, and that is the whole point. Every frame is drawn from scratch at
 * full resolution, so a move can scale, reflow or pull back without ever resampling a previous
 * frame. Resampling a still slightly differently on each frame is exactly what made an earlier cut
 * of the 90-second film shimmer; a 2.4x pull-back here costs nothing in sharpness.
 *
 * Each scene exposes window.seek(u) with u running 0 -> 1 across the scene. Nothing reads a clock,
 * so a rebuild is byte-identical and the animation always fits the narration it was measured
 * against - however long that narration turned out to be.
 *
 *   node render-anim.js f1-02 12.40      -> work/anim-f1-02/00000.png ...
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const [, , SCENE, DUR_S] = process.argv;
const W = 1080;
const H = 1920;
const FPS = 30;
const DUR = parseFloat(DUR_S);
const OUT = path.join(HERE, 'work', `anim-${SCENE}`);

const cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'series.json'), 'utf8'));
let scene = null, film = null;
for (const f of cfg.films) {
  const s = f.scenes.find((x) => x.id === SCENE);
  if (s) { scene = s; film = f; break; }
}
if (!scene) { console.error(`no scene ${SCENE} in series.json`); process.exit(1); }

const iconPath = path.resolve(HERE, '../../../MobileApp/assets/images/icon.png');
const ICON = fs.existsSync(iconPath)
  ? 'data:image/png;base64,' + fs.readFileSync(iconPath).toString('base64') : '';

const TOKENS = `
  --ink:#080D18; --ground-1:#16223A; --ground-2:#0B1220; --rule:#2B3C61;
  --fg:#F3F6FB; --fg-dim:#93A4C4; --fg-faint:#55668A; --accent:#F4A259; --brand:#64709D;
  --good:#48B98A; --warn:#E0A64B; --bad:#C4636B;
  --sans:-apple-system,BlinkMacSystemFont,"SF Pro Display","Helvetica Neue",sans-serif;
`;

// Rail markup is shared with render-cards.js by hand rather than by import: this file writes it
// into a live DOM that seek() animates, the other writes it into a flat PNG.
const rail = (n, on) => `<div class="rail">${cfg.films.map((f) => `
  <div class="seg ${f.n < n ? 'done' : f.n === n ? 'on' : ''}">
    <div class="bar"><i id="rb${f.n}" style="width:${f.n < n ? 100 : 0}%"></i></div>
    <div class="sn">${String(f.n).padStart(2, '0')}</div>
  </div>`).join('')}</div>`;

const RAIL_CSS = `
  .rail { position:absolute; left:76px; right:76px; top:76px; display:flex; gap:14px; }
  .seg { flex:1; opacity:.3 } .seg.done { opacity:.55 } .seg.on { opacity:1 }
  .bar { height:5px; border-radius:3px; background:var(--rule); overflow:hidden }
  .bar i { display:block; height:100%; border-radius:3px; background:var(--fg-faint) }
  .seg.done .bar i { background:var(--brand) } .seg.on .bar i { background:var(--accent) }
  .sn { margin-top:11px; font-size:19px; font-weight:700; letter-spacing:.12em;
        color:var(--fg-faint); font-variant-numeric:tabular-nums }
  .seg.on .sn { color:var(--fg) }
`;

const SHELL = (body, style, script) => `<!doctype html><meta charset="utf-8">
<style>
  :root{${TOKENS}}
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:${W}px;height:${H}px;overflow:hidden;background:var(--ink)}
  body{font-family:var(--sans);-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision}
  .stage{position:relative;width:${W}px;height:${H}px;overflow:hidden;
    background:radial-gradient(120% 82% at 50% 38%,
      var(--ground-1) 0%, var(--ground-2) 52%, var(--ink) 100%)}
  .grain{position:absolute;inset:0;opacity:.055;mix-blend-mode:overlay;pointer-events:none;
    background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3'/></filter><rect width='160' height='160' filter='url(%23n)'/></svg>")}
  h1{font-weight:640;letter-spacing:-.024em;line-height:1.04;color:var(--fg);text-wrap:balance}
  .sub{color:var(--fg-dim);font-weight:420;text-wrap:balance}
  ${RAIL_CSS}
  ${style}
</style>
<div class="stage" id="stage">${body}<div class="grain"></div></div>
<script>
const W=${W}, H=${H}, FILM=${film.n};
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
// Normalised progress through a window, eased. Every move below is driven by these three.
const seg=(u,a,b)=>clamp((u-a)/(b-a),0,1);
const ease=t=>t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;      // inOutCubic
const easeOut=t=>1-Math.pow(1-t,3);
const back=t=>{const c=1.70158+1;return 1+ c*Math.pow(t-1,3)+1.70158*Math.pow(t-1,2)};
const set=(el,o)=>{ if(el) for(const k in o) el.style[k]=o[k]; };
const $=(id)=>document.getElementById(id);
${script}
</script>`;

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ═══════════════════════════════════════════════════════════════════════════════
// Chapter card - opens every film.
// ═══════════════════════════════════════════════════════════════════════════════
function chapterScene() {
  const c = scene.card;
  return SHELL(`
    ${rail(film.n, true)}
    <div class="num" id="num">${String(film.n).padStart(2, '0')}</div>
    <div class="wrap">
      <div class="kick" id="kick">Part ${film.n} of ${cfg.films.length}</div>
      <h1 id="big">${esc(c.big)}</h1>
      <div class="hair" id="hair"></div>
      <div class="sub" id="sb">${esc(c.sub)}</div>
    </div>
    <div class="mark" id="mark">CVApplyr</div>`, `
    /* The numeral is set in outline and sits BEHIND the words - it dates the chapter without
       competing with the title for the eye. */
    .num{position:absolute;left:0;right:0;top:392px;text-align:center;
      font-size:520px;font-weight:800;letter-spacing:-.06em;line-height:1;
      color:transparent;-webkit-text-stroke:3px var(--rule);opacity:0;
      font-variant-numeric:tabular-nums}
    .wrap{position:absolute;left:96px;right:96px;top:660px;text-align:center}
    .kick{font-size:24px;font-weight:700;letter-spacing:.32em;text-transform:uppercase;
      color:var(--accent);margin-bottom:40px;opacity:0}
    h1{font-size:96px}
    .hair{width:0;height:3px;background:var(--rule);margin:56px auto 0}
    .sub{font-size:36px;margin-top:34px;opacity:0}
    .mark{position:absolute;left:0;right:0;bottom:120px;text-align:center;font-size:23px;
      font-weight:700;letter-spacing:.3em;text-transform:uppercase;color:var(--fg-faint);opacity:0}`, `
    const big=$('big'), words=big.textContent.trim().split(' ');
    big.innerHTML=words.map((w,i)=>'<span class="w" id="w'+i+'" style="display:inline-block">'+w+'</span>').join(' ');
    window.seek=(u)=>{
      const n=seg(u,0,.55); set($('num'),{opacity:(0.9*easeOut(n)).toFixed(3),
        transform:'scale('+(1.06-0.06*easeOut(n)).toFixed(4)+')'});
      set($('kick'),{opacity:easeOut(seg(u,.04,.22)).toFixed(3)});
      // Words rise one after another rather than the block fading as one - it reads as speech.
      for(let i=0;i<words.length;i++){
        const t=easeOut(seg(u,.10+i*0.035,.34+i*0.035));
        set($('w'+i),{opacity:t.toFixed(3),transform:'translateY('+((1-t)*34).toFixed(1)+'px)'});
      }
      set($('hair'),{width:(160*easeOut(seg(u,.34,.6))).toFixed(1)+'px'});
      const s=seg(u,.42,.68); set($('sb'),{opacity:easeOut(s).toFixed(3),
        transform:'translateY('+((1-easeOut(s))*20).toFixed(1)+'px)'});
      set($('mark'),{opacity:(0.85*easeOut(seg(u,.6,.85))).toFixed(3)});
      set($('rb'+FILM),{width:(6*easeOut(seg(u,.2,.9))).toFixed(1)+'%'});
    };`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// f1 - one profile, every form. The point of the whole product in one picture.
// ═══════════════════════════════════════════════════════════════════════════════
function stackScene() {
  const ROWS = [['Full name', 'John Mathews'], ['Email', 'john.mathews@mail.com'],
                ['Phone', '+1 222 223 4567'], ['Address', 'New York'],
                ['Résumé', 'Resume.pdf'], ['Signature', 'John Mathews']];
  const FORMS = ['Northwind', 'Vertex', 'Kestrel', 'Pinegate', 'Orbit Labs', 'Ashfield'];
  return SHELL(`
    <div class="hd" id="hd">Fill it in once</div>
    <div class="card" id="card">
      <div class="ct"><span class="dot"></span>Your profile</div>
      ${ROWS.map((r, i) => `<div class="row" id="r${i}"><span class="k">${r[0]}</span>
        <span class="v" id="v${i}">${esc(r[1])}</span></div>`).join('')}
    </div>
    <svg class="wires" width="${W}" height="${H}">
      ${FORMS.map((_, i) => `<path id="p${i}" fill="none" stroke="var(--brand)" stroke-width="2"
        stroke-linecap="round" opacity=".55"/>`).join('')}
    </svg>
    ${FORMS.map((b, i) => `<div class="frm" id="f${i}">
        <div class="fb">${b}</div>
        <div class="fl"></div><div class="fl"></div><div class="fl s"></div>
        <div class="tick" id="t${i}">✓</div>
      </div>`).join('')}`, `
    .hd{position:absolute;left:80px;right:80px;top:150px;text-align:center;font-size:52px;
      font-weight:660;letter-spacing:-.02em;color:var(--fg);opacity:0}
    .card{position:absolute;left:270px;top:272px;width:540px;border-radius:26px;
      background:linear-gradient(180deg,#152340,#101A2E);border:1px solid #2A3A5C;padding:26px 30px;
      box-shadow:0 40px 90px rgba(0,0,0,.55);opacity:0}
    .ct{display:flex;align-items:center;gap:12px;font-size:24px;font-weight:700;letter-spacing:.12em;
      text-transform:uppercase;color:var(--accent);margin-bottom:22px}
    .dot{width:11px;height:11px;border-radius:50%;background:var(--accent)}
    .row{display:flex;justify-content:space-between;align-items:baseline;gap:18px;
      padding:15px 0;border-top:1px solid #223css}
    .row{border-top:1px solid #22314F}
    .k{font-size:24px;color:var(--fg-faint);white-space:nowrap}
    .v{font-size:26px;color:var(--fg);font-weight:520;text-align:right;opacity:0}
    .wires{position:absolute;left:0;top:0;pointer-events:none}
    /* Six employer forms, deliberately identical to each other and unlike the profile card:
       the eye should read them as "another one of those", which is the experience being described. */
    .frm{position:absolute;width:284px;height:212px;border-radius:18px;background:#0E1729;
      border:1px solid #223css;border:1px solid #22314F;padding:18px 20px;opacity:0}
    .fb{font-size:21px;font-weight:700;color:var(--fg-dim);margin-bottom:16px}
    .fl{height:15px;border-radius:8px;background:#1A2740;margin-bottom:13px}
    .fl.s{width:58%}
    .tick{position:absolute;right:16px;bottom:14px;font-size:30px;color:var(--good);opacity:0}`, `
    const FN=${FORMS.length}, CARD={x:270,y:272,w:540,h:0};
    const card=$('card');
    // Two columns of three, below the profile card, running off neither edge.
    // Three across, two down, on the same 76px side margin the captions use. Laid out by hand
    // rather than by a grid so the right-hand column cannot drift off frame.
    const POS=[[76,1150],[398,1150],[720,1150],[76,1420],[398,1420],[720,1420]];
    for(let i=0;i<FN;i++) set($('f'+i),{left:POS[i][0]+'px',top:POS[i][1]+'px'});
    let wired=false;
    function wires(){
      const cb=card.getBoundingClientRect();
      const sx=cb.left+cb.width/2, sy=cb.bottom-8;
      for(let i=0;i<FN;i++){
        const b=$('f'+i).getBoundingClientRect();
        const tx=b.left+b.width/2, ty=b.top;
        const d='M'+sx+','+sy+' C'+sx+','+((sy+ty)/2)+' '+tx+','+((sy+ty)/2)+' '+tx+','+ty;
        const p=$('p'+i); p.setAttribute('d',d);
        const L=p.getTotalLength(); p.style.strokeDasharray=L; p.style.strokeDashoffset=L;
        p.dataset.len=L;
      }
      wired=true;
    }
    window.seek=(u)=>{
      set($('hd'),{opacity:easeOut(seg(u,.02,.16)).toFixed(3),
        transform:'translateY('+((1-easeOut(seg(u,.02,.16)))*22).toFixed(1)+'px)'});
      const c=seg(u,.05,.20); set(card,{opacity:easeOut(c).toFixed(3),
        transform:'translateY('+((1-easeOut(c))*30).toFixed(1)+'px)'});
      if(!wired) wires();
      // Rows land one at a time across the first 45% - this is the "once" half of the scene.
      for(let i=0;i<${ROWS.length};i++){
        const t=easeOut(seg(u,.16+i*0.042,.30+i*0.042));
        set($('v'+i),{opacity:t.toFixed(3),transform:'translateX('+((1-t)*22).toFixed(1)+'px)'});
      }
      // Then it flows outward: each wire draws, its form appears, and it stamps filled.
      for(let i=0;i<FN;i++){
        const a=.48+i*0.058;
        const w=easeOut(seg(u,a,a+.13)), p=$('p'+i);
        p.style.strokeDashoffset=(p.dataset.len*(1-w)).toFixed(1);
        const f=easeOut(seg(u,a+.06,a+.17));
        set($('f'+i),{opacity:f.toFixed(3),transform:'scale('+(0.9+0.1*f).toFixed(3)+')'});
        set($('t'+i),{opacity:easeOut(seg(u,a+.14,a+.22)).toFixed(3)});
      }
    };`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// f2 - what the parser sees. The claim here is the app's own ATS rating, nothing more.
// ═══════════════════════════════════════════════════════════════════════════════
function parseScene() {
  const BAD = ['Name', 'Job titles', 'Dates', 'Skills'];
  return SHELL(`
    <div class="hd" id="hd">Software reads it first</div>
    <div class="doc bad" id="dA">
      <div class="dl">The pretty one</div>
      <div class="two">
        <div class="side">${'<div class="b"></div>'.repeat(9)}</div>
        <div class="main">${'<div class="l"></div>'.repeat(11)}</div>
      </div>
      <div class="scan" id="sA"></div>
    </div>
    <div class="doc good" id="dB">
      <div class="dl">The readable one</div>
      <div class="one">${'<div class="l"></div>'.repeat(14)}</div>
      <div class="scan" id="sB"></div>
    </div>
    <div class="out" id="oA">${BAD.map((b, i) => `<div class="f" id="fa${i}">
      <span class="x">✕</span>${b}</div>`).join('')}</div>
    <div class="out" id="oB">${BAD.map((b, i) => `<div class="f" id="fb${i}">
      <span class="c">✓</span>${b}</div>`).join('')}</div>
    <div class="stars" id="st"><span class="lbl">ATS</span>
      ${'<span class="s">★</span>'.repeat(5)}</div>`, `
    .hd{position:absolute;left:80px;right:80px;top:150px;text-align:center;font-size:52px;
      font-weight:660;letter-spacing:-.02em;color:var(--fg);opacity:0}
    .doc{position:absolute;top:296px;width:426px;height:566px;border-radius:14px;background:#F2F4F8;
      overflow:hidden;padding:18px;opacity:0;box-shadow:0 26px 60px rgba(0,0,0,.5)}
    #dA{left:76px} #dB{left:578px}
    .dl{position:absolute;left:0;right:0;top:-46px;text-align:center;font-size:23px;font-weight:700;
      letter-spacing:.14em;text-transform:uppercase;color:var(--fg-faint)}
    /* The left document is the two-column, sidebar-and-skill-bars look almost every résumé
       template sells. The right is a single column. That difference is the entire point. */
    .two{display:flex;gap:14px;height:100%}
    .side{width:34%;background:#26354F;border-radius:8px;padding:14px 10px}
    .side .b{height:9px;border-radius:5px;background:#5A6B88;margin-bottom:15px}
    .side .b:nth-child(2n){width:70%}
    .main{flex:1;padding-top:6px}
    .one{padding-top:8px}
    .l{height:11px;border-radius:6px;background:#C9D2E0;margin-bottom:19px}
    .l:nth-child(3n){width:72%} .l:nth-child(4n){width:88%}
    .scan{position:absolute;left:0;right:0;height:5px;top:0;opacity:0;
      background:linear-gradient(90deg,transparent,var(--accent),transparent);
      box-shadow:0 0 26px 7px rgba(244,162,89,.45)}
    .out{position:absolute;top:940px;width:426px;display:flex;flex-direction:column;gap:15px}
    #oA{left:76px} #oB{left:578px}
    .f{display:flex;align-items:center;gap:14px;font-size:27px;color:var(--fg-dim);
      background:#101A2E;border:1px solid #22314F;border-radius:12px;padding:15px 18px;opacity:0}
    .x{color:var(--bad);font-size:26px;font-weight:700}
    .c{color:var(--good);font-size:26px;font-weight:700}
    #oA .f{color:var(--fg-faint)}
    .stars{position:absolute;left:578px;width:426px;top:1300px;display:flex;align-items:center;
      justify-content:center;gap:9px;opacity:0}
    .lbl{font-size:24px;font-weight:800;letter-spacing:.2em;color:var(--fg-faint);margin-right:8px}
    .s{font-size:40px;color:var(--accent)}`, `
    const N=${BAD.length};
    window.seek=(u)=>{
      set($('hd'),{opacity:easeOut(seg(u,.02,.14)).toFixed(3)});
      set($('dA'),{opacity:easeOut(seg(u,.05,.18)).toFixed(3),
        transform:'translateY('+((1-easeOut(seg(u,.05,.18)))*26).toFixed(1)+'px)'});
      set($('dB'),{opacity:easeOut(seg(u,.09,.22)).toFixed(3),
        transform:'translateY('+((1-easeOut(seg(u,.09,.22)))*26).toFixed(1)+'px)'});
      // One scan pass down both documents at once, so the comparison is like-for-like.
      const sc=seg(u,.26,.50);
      const vis=(sc>0&&sc<1)?1:0;
      for(const id of ['sA','sB']) set($(id),{opacity:vis,top:(sc*560).toFixed(1)+'px'});
      for(let i=0;i<N;i++){
        set($('fa'+i),{opacity:easeOut(seg(u,.50+i*.035,.60+i*.035)).toFixed(3)});
        set($('fb'+i),{opacity:easeOut(seg(u,.50+i*.035,.60+i*.035)).toFixed(3)});
      }
      // The pretty one dims once both results are on screen. Nothing is said about it out loud;
      // the picture makes the point and the narration stays factual.
      const d=easeOut(seg(u,.70,.84));
      set($('dA'),{opacity:(1-.55*d).toFixed(3)});
      set($('oA'),{opacity:(1-.45*d).toFixed(3)});
      const s=easeOut(seg(u,.78,.94));
      set($('st'),{opacity:s.toFixed(3),transform:'scale('+(0.86+0.14*back(Math.min(1,s))).toFixed(3)+')'});
    };`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// f2 - the regions. Every card below is a real entry in server/utils/resumeTemplates.js.
// ═══════════════════════════════════════════════════════════════════════════════
function regionsScene() {
  const R = [
    { f: '🌐', n: 'Generic', d: 'Any country', photo: false },
    { f: '🇺🇸', n: 'USA / Canada', d: 'No photo, one page', photo: false },
    { f: '🇬🇧', n: 'UK / Australia', d: 'No photo, two pages', photo: false },
    { f: '🇮🇳', n: 'India / South Asia', d: 'Full detail', photo: false },
    { f: '🇩🇪', n: 'Germany / DACH', d: 'Photo expected', photo: true },
    { f: '🇪🇺', n: 'Europe / EU', d: 'Europass, photo', photo: true },
    { f: '🇸🇬', n: 'Singapore', d: 'APAC hubs', photo: false },
  ];
  return SHELL(`
    <div class="hd" id="hd">One résumé.<br>Rebuilt for where you apply.</div>
    <div class="grid">
      ${R.map((r, i) => `<div class="rc" id="rc${i}">
        <div class="fl">${r.f}</div>
        <div class="tx"><div class="nm">${esc(r.n)}</div><div class="ds">${esc(r.d)}</div></div>
        <div class="mini">${r.photo ? '<div class="ph"></div>' : ''}
          ${'<div class="ln"></div>'.repeat(r.photo ? 4 : 6)}</div>
      </div>`).join('')}
    </div>`, `
    .hd{position:absolute;left:80px;right:80px;top:170px;text-align:center;font-size:54px;
      font-weight:660;letter-spacing:-.022em;line-height:1.12;color:var(--fg);opacity:0}
    .grid{position:absolute;left:76px;right:76px;top:430px;display:grid;
      grid-template-columns:1fr 1fr;gap:20px}
    .rc{display:flex;align-items:center;gap:16px;background:#101A2E;border:1px solid #22314F;
      border-radius:18px;padding:20px 18px;opacity:0;height:150px}
    .rc:last-child{grid-column:1 / -1}
    .fl{font-size:44px;line-height:1}
    .tx{flex:1;min-width:0}
    .nm{font-size:27px;font-weight:640;color:var(--fg);letter-spacing:-.01em}
    .ds{font-size:21px;color:var(--fg-faint);margin-top:6px}
    /* A thumbnail of the actual document shape - the photo block is the difference the
       narration is naming, so it has to be visible at a glance. */
    .mini{width:78px;height:104px;background:#F2F4F8;border-radius:6px;padding:8px 7px;flex:none}
    .ph{width:24px;height:24px;border-radius:50%;background:#5A6B88;margin:0 auto 7px}
    .ln{height:6px;border-radius:3px;background:#C9D2E0;margin-bottom:8px}
    .ln:nth-child(3n){width:66%}`, `
    const N=${R.length};
    window.seek=(u)=>{
      set($('hd'),{opacity:easeOut(seg(u,.02,.16)).toFixed(3),
        transform:'translateY('+((1-easeOut(seg(u,.02,.16)))*24).toFixed(1)+'px)'});
      for(let i=0;i<N;i++){
        const a=.20+i*.072, t=easeOut(seg(u,a,a+.16));
        set($('rc'+i),{opacity:t.toFixed(3),
          transform:'translateY('+((1-t)*26).toFixed(1)+'px) scale('+(0.96+0.04*t).toFixed(3)+')'});
      }
      // A slow sweep of emphasis across the set at the end, so it closes on movement rather
      // than on a static grid.
      const sw=seg(u,.74,1);
      for(let i=0;i<N;i++){
        const d=Math.abs(sw*(N+1)-1-i);
        const g=clamp(1-d,0,1);
        set($('rc'+i),{borderColor:g>.25?'rgba(244,162,89,'+(0.25+0.55*g).toFixed(2)+')':'#22314F',
          background:g>.25?'rgba(30,44,72,'+(0.6+0.4*g).toFixed(2)+')':'#101A2E'});
      }
    };`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// f3 - the unpaid hour, moving across. No time claim is made; the columns carry it.
// ═══════════════════════════════════════════════════════════════════════════════
function hoursScene() {
  const TASKS = ['Read the whole posting', 'Work out what they actually do',
                 'Find the salary range', 'Pull out the skills they want',
                 'Find who to write to', 'Match it to your résumé'];
  return SHELL(`
    <div class="hd" id="hd">The part before the applying</div>
    <div class="cols">
      <div class="colh" id="hL">You</div>
      <div class="colh right" id="hR">CVApplyr</div>
    </div>
    <div class="lane" id="lane">
      ${TASKS.map((t, i) => `<div class="task" id="tk${i}">
        <span class="bul" id="bu${i}"></span><span class="tt">${esc(t)}</span></div>`).join('')}
    </div>`, `
    .hd{position:absolute;left:80px;right:80px;top:158px;text-align:center;font-size:52px;
      font-weight:660;letter-spacing:-.02em;color:var(--fg);opacity:0}
    .cols{position:absolute;left:76px;right:76px;top:330px;display:flex;justify-content:space-between}
    .colh{font-size:25px;font-weight:700;letter-spacing:.22em;text-transform:uppercase;
      color:var(--fg-faint);opacity:0}
    .colh.right{color:var(--accent)}
    .lane{position:absolute;left:76px;right:76px;top:412px}
    .task{position:relative;display:flex;align-items:center;gap:16px;background:#101A2E;
      border:1px solid #22314F;border-radius:16px;padding:24px 22px;margin-bottom:20px;opacity:0}
    .bul{width:16px;height:16px;border-radius:50%;border:2px solid var(--fg-faint);flex:none}
    .tt{font-size:29px;color:var(--fg-dim);letter-spacing:-.008em}`, `
    const N=${TASKS.length};
    window.seek=(u)=>{
      set($('hd'),{opacity:easeOut(seg(u,.02,.14)).toFixed(3)});
      set($('hL'),{opacity:easeOut(seg(u,.06,.18)).toFixed(3)});
      for(let i=0;i<N;i++){
        const a=.10+i*.045, t=easeOut(seg(u,a,a+.13));
        set($('tk'+i),{opacity:t.toFixed(3),transform:'translateX('+((1-t)*-26).toFixed(1)+'px)'});
      }
      set($('hR'),{opacity:easeOut(seg(u,.46,.58)).toFixed(3)});
      // Then each task slides across to the app's column and is marked done, one after another.
      for(let i=0;i<N;i++){
        const a=.50+i*.062, m=ease(seg(u,a,a+.16));
        set($('tk'+i),{transform:'translateX('+(m*116).toFixed(1)+'px)',
          borderColor:m>.5?'rgba(72,185,138,'+(0.3+0.5*m).toFixed(2)+')':'#22314F',
          background:m>.5?'rgba(19,38,42,'+(0.5+0.5*m).toFixed(2)+')':'#101A2E'});
        const b=$('bu'+i);
        set(b,{background:m>.55?'var(--good)':'transparent',
          borderColor:m>.55?'var(--good)':'var(--fg-faint)',
          transform:'scale('+(1+0.35*Math.sin(Math.PI*clamp((m-.4)/.35,0,1))).toFixed(3)+')'});
      }
    };`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// f4 - generic against specific. The right-hand letter uses the real posting from the footage.
// ═══════════════════════════════════════════════════════════════════════════════
function letterScene() {
  const GEN = ['Dear Hiring Manager,', 'I am writing to apply for the',
               'advertised position. I am a', 'hard-working team player with',
               'excellent communication skills', 'and a passion for excellence.',
               'I believe I would be a great fit', 'for your organisation.'];
  const SPEC = [
    ['Dear Hiring Manager,', []],
    ['I am applying for the Lead', ['Lead']],
    ['Fullstack Engineer role at', ['Fullstack Engineer']],
    ['SQUER Solutions in Vienna.', ['SQUER Solutions', 'Vienna']],
    ['My last four years were spent', []],
    ['on .NET and Azure DevOps —', ['.NET', 'Azure DevOps']],
    ['the stack your posting names', []],
    ['as the core of the role.', []],
  ];
  const mark = (line, hits) => hits.reduce(
    (s, h) => s.replace(h, `<b>${h}</b>`), esc(line));
  return SHELL(`
    <div class="hd" id="hd">Everyone can spot a template</div>
    <div class="sheet" id="lA"><div class="tag" id="gA">Could be anyone</div>
      ${GEN.map((l, i) => `<div class="ln" id="ga${i}">${esc(l)}</div>`).join('')}</div>
    <div class="sheet" id="lB"><div class="tag good" id="gB">Could only be you</div>
      ${SPEC.map((l, i) => `<div class="ln" id="gb${i}">${mark(l[0], l[1])}</div>`).join('')}</div>`, `
    .hd{position:absolute;left:80px;right:80px;top:158px;text-align:center;font-size:52px;
      font-weight:660;letter-spacing:-.02em;color:var(--fg);opacity:0}
    .sheet{position:absolute;top:330px;width:436px;min-height:600px;background:#F5F7FA;
      border-radius:14px;padding:52px 26px 30px;opacity:0;box-shadow:0 26px 60px rgba(0,0,0,.5)}
    #lA{left:70px} #lB{left:574px}
    .tag{position:absolute;left:0;right:0;top:-48px;text-align:center;font-size:22px;font-weight:700;
      letter-spacing:.14em;text-transform:uppercase;color:var(--fg-faint)}
    .tag.good{color:var(--accent)}
    .ln{font-size:23px;line-height:1.5;color:#4A5568;margin-bottom:15px;opacity:0}
    /* The specifics are the only thing set in ink on the page - the eye finds them before the
       narration gets to the word "specific". */
    .ln b{color:#101A2E;font-weight:700;background:rgba(244,162,89,.32);
      border-radius:4px;padding:1px 4px}`, `
    const A=${GEN.length}, B=${SPEC.length};
    window.seek=(u)=>{
      set($('hd'),{opacity:easeOut(seg(u,.02,.14)).toFixed(3)});
      const a=easeOut(seg(u,.06,.18));
      set($('lA'),{opacity:a.toFixed(3),transform:'translateY('+((1-a)*26).toFixed(1)+'px)'});
      for(let i=0;i<A;i++) set($('ga'+i),{opacity:easeOut(seg(u,.12+i*.022,.22+i*.022)).toFixed(3)});
      const b=easeOut(seg(u,.42,.56));
      set($('lB'),{opacity:b.toFixed(3),transform:'translateY('+((1-b)*26).toFixed(1)+'px)'});
      for(let i=0;i<B;i++) set($('gb'+i),{opacity:easeOut(seg(u,.48+i*.026,.58+i*.026)).toFixed(3)});
      // The template recedes rather than being crossed out. Nothing is being mocked; it is
      // simply not the one that gets read.
      const d=easeOut(seg(u,.72,.9));
      set($('lA'),{opacity:(1-.62*d).toFixed(3),
        transform:'translateY(0) scale('+(1-.05*d).toFixed(3)+')'});
      set($('lB'),{transform:'translateY(0) scale('+(1+.045*d).toFixed(3)+')'});
    };`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// f5 - the form that kills the application. Two fields stay empty on purpose.
// ═══════════════════════════════════════════════════════════════════════════════
function fieldsScene() {
  const F = [
    ['First name', 'John'], ['Last name', 'Mathews'], ['Email', 'john.mathews@mail.com'],
    ['Phone', '+1 222 223 4567'], ['Address', 'New York'], ['Date of birth', '16 June 1996'],
    ['Current title', 'Project Manager'], ['Years of experience', '14'],
    ['Notice period', '1 month'], ['LinkedIn', 'linkedin.com/in/…'],
    ['Résumé', 'Resume.pdf'], ['Cover letter', 'Cover_Letter.pdf'],
    ['Available from', null], ['Expected salary', null],
  ];
  return SHELL(`
    <!-- No count in the headline: the narration says "a thirty field form" as a fair description
         of a real ATS portal, but only fourteen rows fit legibly here, and a headline that states
         a number the picture contradicts is the kind of thing a careful viewer notices. -->
    <div class="hd" id="hd">A form you have never seen.<br>Asking what you already answered.</div>
    <div class="form" id="form">
      ${F.map((f, i) => `<div class="fr" id="fr${i}">
        <div class="fk">${esc(f[0])}</div>
        <div class="fv" id="fv${i}">${f[1] === null
          ? '<span class="need" id="nd' + i + '">needs you</span>' : esc(f[1])}</div>
      </div>`).join('')}
    </div>
    <div class="count" id="cnt"><b id="cn">0</b> filled from your profile</div>`, `
    .hd{position:absolute;left:80px;right:80px;top:150px;text-align:center;font-size:50px;
      font-weight:660;letter-spacing:-.02em;line-height:1.14;color:var(--fg);opacity:0}
    .form{position:absolute;left:76px;right:76px;top:392px;background:#0E1729;
      border:1px solid #22314F;border-radius:22px;padding:12px 24px;opacity:0}
    .fr{display:flex;align-items:center;justify-content:space-between;gap:20px;
      padding:16px 0;border-bottom:1px solid #1A2740}
    .fr:last-child{border-bottom:none}
    .fk{font-size:23px;color:var(--fg-faint);white-space:nowrap}
    .fv{font-size:25px;color:var(--fg);font-weight:520;opacity:0;text-align:right;
      overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
    .need{color:var(--warn);font-size:22px;font-weight:700;letter-spacing:.06em;
      text-transform:uppercase;border:1px solid rgba(224,166,75,.45);border-radius:8px;
      padding:5px 11px}
    .count{position:absolute;left:0;right:0;bottom:132px;text-align:center;font-size:28px;
      color:var(--fg-dim);opacity:0}
    .count b{color:var(--accent);font-weight:800;font-variant-numeric:tabular-nums}`, `
    const N=${F.length}, FILLED=12;
    window.seek=(u)=>{
      set($('hd'),{opacity:easeOut(seg(u,.02,.15)).toFixed(3),
        transform:'translateY('+((1-easeOut(seg(u,.02,.15)))*22).toFixed(1)+'px)'});
      const f=easeOut(seg(u,.08,.22));
      set($('form'),{opacity:f.toFixed(3),transform:'translateY('+((1-f)*28).toFixed(1)+'px)'});
      // A fast cascade top to bottom. Each row lights its own row-tint for a moment as it lands,
      // which is what makes it read as being filled rather than merely appearing.
      let done=0;
      for(let i=0;i<N;i++){
        const a=.34+i*.035, t=easeOut(seg(u,a,a+.09));
        set($('fv'+i),{opacity:t.toFixed(3),transform:'translateX('+((1-t)*18).toFixed(1)+'px)'});
        const flash=Math.sin(Math.PI*clamp((seg(u,a,a+.14)),0,1));
        set($('fr'+i),{background: i<FILLED
          ? 'rgba(244,162,89,'+(0.10*flash).toFixed(3)+')'
          : 'rgba(224,166,75,'+(0.07*t).toFixed(3)+')'});
        if(i<FILLED && t>.5) done++;
      }
      $('cn').textContent=done;
      set($('cnt'),{opacity:easeOut(seg(u,.40,.52)).toFixed(3)});
    };`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Next-up card - closes films 1 to 4.
// ═══════════════════════════════════════════════════════════════════════════════
function nextScene() {
  const c = scene.card;
  return SHELL(`
    ${rail(film.n, true)}
    <div class="wrap">
      <div class="kick" id="kick">${esc(c.kicker)}</div>
      <div class="row">
        <div class="n" id="n">${esc(c.n)}</div>
        <div class="chev" id="chev">
          <span class="cv"></span><span class="cv"></span><span class="cv"></span>
        </div>
      </div>
      <h1 id="big">${esc(c.big)}</h1>
    </div>
    <div class="mark" id="mark">CVApplyr</div>`, `
    .wrap{position:absolute;left:96px;right:96px;top:640px;text-align:center}
    .kick{font-size:24px;font-weight:700;letter-spacing:.32em;text-transform:uppercase;
      color:var(--accent);margin-bottom:44px;opacity:0}
    .row{display:flex;align-items:center;justify-content:center;gap:34px;margin-bottom:48px}
    .n{font-size:168px;font-weight:800;letter-spacing:-.05em;color:var(--fg);opacity:0;
      font-variant-numeric:tabular-nums;line-height:1}
    .chev{display:flex;gap:12px;opacity:0}
    .cv{width:26px;height:26px;border-right:5px solid var(--accent);
      border-top:5px solid var(--accent);transform:rotate(45deg);border-radius:3px}
    h1{font-size:76px}
    .mark{position:absolute;left:0;right:0;bottom:120px;text-align:center;font-size:23px;
      font-weight:700;letter-spacing:.3em;text-transform:uppercase;color:var(--fg-faint);opacity:0}`, `
    window.seek=(u)=>{
      set($('kick'),{opacity:easeOut(seg(u,.02,.20)).toFixed(3)});
      const n=easeOut(seg(u,.10,.34));
      set($('n'),{opacity:n.toFixed(3),transform:'translateY('+((1-n)*30).toFixed(1)+'px)'});
      // Chevrons chase rightward on a loop - the one bit of motion that says "keep going".
      const ch=easeOut(seg(u,.22,.42));
      set($('chev'),{opacity:ch.toFixed(3)});
      const cvs=document.querySelectorAll('.cv');
      for(let i=0;i<cvs.length;i++){
        const p=((u*2.1)-i*0.14)%1;
        cvs[i].style.opacity=(0.22+0.78*Math.max(0,Math.sin(Math.PI*clamp(p*1.6,0,1)))).toFixed(3);
      }
      const b=easeOut(seg(u,.30,.56));
      set($('big'),{opacity:b.toFixed(3),transform:'translateY('+((1-b)*26).toFixed(1)+'px)'});
      set($('mark'),{opacity:(0.85*easeOut(seg(u,.5,.75))).toFixed(3)});
      // The rail runs the current film out to full and starts the next one - the series
      // position is the actual message of this card.
      set($('rb'+FILM),{width:(100*easeOut(seg(u,.1,.5))).toFixed(1)+'%'});
      if(FILM<5) set($('rb'+(FILM+1)),{width:(12*easeOut(seg(u,.5,.85))).toFixed(1)+'%'});
    };`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// End card - closes film 5, and the series.
// ═══════════════════════════════════════════════════════════════════════════════
function endScene() {
  const c = scene.card;
  return SHELL(`
    ${rail(film.n, true)}
    <div class="wrap">
      ${ICON ? `<img class="icon" id="ic" src="${ICON}">` : ''}
      <h1 id="big">${esc(c.big)}</h1>
      <div class="sub" id="sb">${esc(c.sub)}</div>
      <div class="url" id="url">${esc(c.url)}</div>
      <div class="stores" id="st">App Store &nbsp;·&nbsp; Google Play</div>
    </div>`, `
    .wrap{position:absolute;left:0;right:0;top:560px;text-align:center}
    .icon{width:196px;height:196px;border-radius:42px;margin-bottom:52px;opacity:0;
      box-shadow:0 30px 80px rgba(0,0,0,.55)}
    h1{font-size:104px;letter-spacing:-.03em;opacity:0}
    .sub{font-size:36px;margin-top:28px;opacity:0}
    .url{margin-top:58px;font-size:27px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;
      color:var(--accent);opacity:0}
    .stores{margin-top:30px;font-size:23px;letter-spacing:.14em;color:var(--fg-faint);
      text-transform:uppercase;font-weight:700;opacity:0}`, `
    window.seek=(u)=>{
      const i=easeOut(seg(u,.02,.26));
      set($('ic'),{opacity:i.toFixed(3),transform:'scale('+(0.86+0.14*back(Math.min(1,i))).toFixed(3)+')'});
      const b=easeOut(seg(u,.14,.38));
      set($('big'),{opacity:b.toFixed(3),transform:'translateY('+((1-b)*24).toFixed(1)+'px)'});
      set($('sb'),{opacity:easeOut(seg(u,.28,.5)).toFixed(3)});
      set($('url'),{opacity:easeOut(seg(u,.44,.66)).toFixed(3)});
      set($('st'),{opacity:easeOut(seg(u,.56,.78)).toFixed(3)});
      for(let n=1;n<=5;n++) set($('rb'+n),{width:(100*easeOut(seg(u,.1,.55))).toFixed(1)+'%'});
    };`);
}

const BUILDERS = {
  chapter: chapterScene, stack: stackScene, parse: parseScene, regions: regionsScene,
  hours: hoursScene, letter: letterScene, fields: fieldsScene, next: nextScene, end: endScene,
};

(async () => {
  const build = BUILDERS[scene.anim];
  if (!build) { console.error(`unknown anim "${scene.anim}"`); process.exit(1); }

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await page.setContent(build(), { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);

  const n = Math.max(2, Math.round(DUR * FPS));
  for (let i = 0; i < n; i++) {
    await page.evaluate((u) => window.seek(u), n === 1 ? 0 : i / (n - 1));
    await page.screenshot({ path: path.join(OUT, String(i).padStart(5, '0') + '.png') });
  }
  await browser.close();
  console.log(`  anim ${SCENE} (${scene.anim}) ${n} frames`);
})();
