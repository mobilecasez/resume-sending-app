/**
 * Renders the animated scenes as PNG frame sequences, straight out of headless Chromium.
 *
 * Why frames and not a video filter: every frame is drawn from scratch at full resolution, so a
 * move can scale, pull back or reflow without ever resampling a previous frame. That is the exact
 * failure mode that made the earlier cut shimmer - a `zoompan` push re-scaling a still image
 * slightly differently on every frame. Here a 2.4x pull-back costs nothing in sharpness.
 *
 * Each scene exposes window.seek(u) where u runs 0 -> 1 across the scene. Nothing reads the clock,
 * so a rebuild is byte-identical and the animation always fits the narration it was measured for.
 *
 *   node render-anim.js 01 7.50            -> work/anim-01/00000.png ...
 *   node render-anim.js 01 7.50 --vertical
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const [, , SCENE, DUR_S] = process.argv;
const VERTICAL = process.argv.includes('--vertical');
const W = VERTICAL ? 1080 : 1920;
const H = VERTICAL ? 1920 : 1080;
const FPS = 30;
const DUR = parseFloat(DUR_S);
const OUT = path.join(HERE, 'work', VERTICAL ? 'v' : 'h', `anim-${SCENE}`);

const cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'scenes.json'), 'utf8'));
const scene = cfg.scenes.find((s) => s.id === SCENE);

const TOKENS = `
  --ink:#080D18; --ground-1:#16223A; --ground-2:#0B1220; --rule:#2B3C61;
  --fg:#F3F6FB; --fg-dim:#93A4C4; --fg-faint:#55668A; --accent:#F4A259; --brand:#64709D;
  --sans:-apple-system,BlinkMacSystemFont,"SF Pro Display","Helvetica Neue",sans-serif;
`;

const SHELL = (body, style, script) => `<!doctype html><meta charset="utf-8">
<style>
  :root{${TOKENS}}
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:${W}px;height:${H}px;overflow:hidden;background:var(--ink)}
  body{font-family:var(--sans);-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision}
  .stage{position:relative;width:${W}px;height:${H}px;
    background:radial-gradient(120% 90% at ${VERTICAL ? '50% 40%' : '58% 46%'},
      var(--ground-1) 0%, var(--ground-2) 52%, var(--ink) 100%);overflow:hidden}
  ${style}
</style>
<div class="stage" id="stage">${body}</div>
<script>
const W=${W}, H=${H}, VERT=${VERTICAL};
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
// Normalised progress through a window, eased. Everything below is driven by these two.
const seg=(u,a,b)=>clamp((u-a)/(b-a),0,1);
const ease=t=>t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;   // inOutCubic
const easeOut=t=>1-Math.pow(1-t,3);
${script}
</script>`;

// ── Scene 01: the retyping problem ──────────────────────────────────────────
// Application forms stream past, each a different employer's layout, each asking for the details
// the last one already had. The camera pulls back to a wall of them. No headline - the narration
// carries the words, and competing text would only fight it.
function retypingScene() {
  const VALUES = { name: 'John Mathews', email: 'john.mathews@mail.com', phone: '+1 222 223 4567',
                   city: 'New York', role: 'Project Manager' };
  // Nine layouts, deliberately unalike: a real applicant meets a different form every time.
  const BASE_LAYOUTS = [
    ['name', 'email', 'phone'], ['name', 'role', 'city', 'email'], ['email', 'name'],
    ['name', 'phone', 'city'], ['role', 'name', 'email', 'phone'], ['name', 'email', 'city'],
    ['phone', 'name', 'email'], ['name', 'city', 'role'], ['email', 'phone', 'name'],
    ['name', 'email', 'role', 'city'],
  ];
  const LABEL = { name: 'Full name', email: 'Email address', phone: 'Phone number',
                  city: 'Location', role: 'Current title' };
  const BRANDS = ['Northwind', 'Acme Group', 'Vertex', 'Bluefin', 'Kestrel', 'Orbit Labs',
                  'Halden', 'Pinegate', 'Sable & Co', 'Marrow', 'Ashfield', 'Quill',
                  'Tenby Group', 'Rowan', 'Castellan', 'Meridian', 'Larkfield', 'Osprey',
                  'Fenwick', 'Dunmore'];
  // Twenty of them, laid five across and four down, so the pull-back ends on a wall that runs off
  // every edge of frame rather than a tidy cluster floating in space.
  const COUNT = 20;
  const LAYOUTS = Array.from({ length: COUNT }, (_, i) => BASE_LAYOUTS[i % BASE_LAYOUTS.length]);

  const cards = LAYOUTS.map((fields, i) => `
    <div class="card" id="c${i}">
      <div class="chrome"><span class="dot"></span><span class="brand">${BRANDS[i]}</span>
        <span class="tag">Application form</span></div>
      <div class="rows">
        ${fields.map((f) => `
          <div class="row">
            <div class="lab">${LABEL[f]}</div>
            <div class="inp"><span class="val" data-v="${VALUES[f]}"></span><span class="caret"></span></div>
          </div>`).join('')}
        <div class="btn">Submit application</div>
      </div>
    </div>`).join('');

  const style = `
    .world{position:absolute;left:50%;top:50%;width:0;height:0;}
    /* Cards vary in height (two fields to four), so they are centred by transform rather than by a
       fixed offset - otherwise the taller forms sit low and the row never lines up. */
    .card{position:absolute;width:${VERTICAL ? 760 : 820}px;left:0;top:0;
      background:linear-gradient(180deg,#182541 0%,#131E36 100%);
      border:1px solid #2A3A5C;border-radius:22px;padding:26px 30px 30px;
      box-shadow:0 40px 90px rgba(0,0,0,.55);will-change:transform,opacity}
    .chrome{display:flex;align-items:center;gap:14px;padding-bottom:18px;margin-bottom:20px;
      border-bottom:1px solid #263553}
    .dot{width:11px;height:11px;border-radius:50%;background:var(--brand);flex:none}
    .brand{font-size:25px;font-weight:640;color:var(--fg);letter-spacing:-.01em}
    .tag{margin-left:auto;font-size:16px;font-weight:600;letter-spacing:.15em;
      text-transform:uppercase;color:var(--fg-faint)}
    .rows{display:flex;flex-direction:column;gap:15px}
    .lab{font-size:16px;font-weight:600;letter-spacing:.11em;text-transform:uppercase;
      color:var(--fg-faint);margin-bottom:8px}
    .inp{height:56px;border:1px solid #2E3F63;border-radius:11px;background:#0E1729;
      display:flex;align-items:center;padding:0 16px;position:relative}
    .val{font-size:25px;color:var(--fg);white-space:nowrap}
    .caret{width:2px;height:27px;background:var(--accent);margin-left:3px;opacity:0}
    .btn{margin-top:9px;height:54px;border-radius:11px;background:#22355C;color:var(--fg-dim);
      font-size:20px;font-weight:640;display:flex;align-items:center;justify-content:center}
    /* The tally has to read over a wall of forms, so it carries its own pool of shade. */
    .counter{position:absolute;left:${VERTICAL ? 70 : 132}px;bottom:${VERTICAL ? 150 : 108}px;opacity:0;
      padding:38px 64px 34px 8px}
    .counter::before{content:'';position:absolute;left:-90px;top:-70px;width:460px;height:340px;
      background:radial-gradient(50% 50% at 42% 55%,rgba(8,13,24,.94) 0%,rgba(8,13,24,.72) 45%,
        rgba(8,13,24,0) 100%);z-index:-1}
    .counter .n{font-size:${VERTICAL ? 110 : 128}px;font-weight:680;color:var(--fg);
      letter-spacing:-.04em;line-height:.9;font-variant-numeric:tabular-nums}
    .counter .l{margin-top:14px;font-size:19px;font-weight:600;letter-spacing:.24em;
      text-transform:uppercase;color:var(--accent)}
    .vig{position:absolute;inset:0;pointer-events:none;
      background:radial-gradient(78% 70% at 50% 48%,rgba(8,13,24,0) 45%,rgba(8,13,24,.72) 100%)}`;

  const script = `
    const N=${LAYOUTS.length};
    const cards=[...Array(N)].map((_,i)=>document.getElementById('c'+i));
    const world=document.getElementById('world');
    const counter=document.getElementById('counter'), cnum=document.getElementById('cnum');
    // Each card takes the centre in turn, faster and faster, then parks in a grid slot. Slots are
    // laid out around the origin so the pull-back reveals a wall rather than a column.
    const COLS=${VERTICAL ? 3 : 5}, ROWS=Math.ceil(N/COLS);
    const GX=${VERTICAL ? 820 : 900}, GY=620;
    const CW=${VERTICAL ? 760 : 820}, CH=470;
    // Slots are filled from the centre outwards, so the wall grows around the form you were just
    // reading instead of starting in a corner.
    const slots=[...Array(N)].map((_,i)=>({
        x:((i%COLS)-(COLS-1)/2)*GX, y:(Math.floor(i/COLS)-(ROWS-1)/2)*GY }))
      .sort((a,b)=>Math.hypot(a.x,a.y*1.4)-Math.hypot(b.x,b.y*1.4));

    // Accelerating entrances: the first form gets time to read, the rest pile up. Geometric decay
    // from a long opening beat down to a flicker, all landing before the scene ends.
    const starts=(()=>{
      const out=[0.03]; let t=0.30, gap=0.150;
      for(let i=1;i<N;i++){ out.push(t); t+=gap; gap*=0.82; }
      const span=out[N-1]-0.30, want=0.60;                  // last card lands at u=0.90
      return out.map((v,i)=> i===0 ? v : 0.30+(v-0.30)*(want/span));
    })();
    // A card parks when the next one arrives, so exactly one form is ever live.
    const parks=starts.map((s,i)=> i<N-1 ? starts[i+1]-0.015 : 0.93);

    // The camera holds whatever has been placed so far. Computed from the slots themselves, which
    // is why the frame never empties out mid-scene: as a card parks at the edge, the view widens
    // by exactly enough to keep it.
    const need=(()=>{
      const out=[]; let mx=CW/2, my=CH/2;
      for(let k=0;k<N;k++){
        mx=Math.max(mx,Math.abs(slots[k].x)+CW/2);
        my=Math.max(my,Math.abs(slots[k].y)+CH/2);
        out.push(Math.min(1,(W/2-46)/mx,(H/2-46)/my));
      }
      return out;
    })();

    window.seek=function(u){
      let scale=need[0];
      for(let i=1;i<N;i++){
        const w=ease(seg(u,parks[i-1],parks[i-1]+0.075));
        if(w<=0) break;
        scale=need[i-1]+(need[i]-need[i-1])*w;
      }
      world.style.transform='translate(-50%,-50%) scale('+scale.toFixed(4)+')';

      cards.forEach((el,i)=>{
        const t0=starts[i];
        const inp=easeOut(seg(u,t0,t0+0.055));            // fly in from the right
        const parked=ease(seg(u,parks[i],parks[i]+0.075)); // then step aside for the next one
        if(inp<=0){ el.style.opacity=0; return; }
        const sx=W*0.80/scale, sy=0;
        const x=sx+(0-sx)*inp+slots[i].x*parked;
        const y=sy+(0-sy)*inp+slots[i].y*parked;
        // Parked cards settle back a little, but stay bright enough to read as a crowd.
        const z=1-0.06*parked, o=(0.25+0.75*inp)*(1-0.20*parked);
        el.style.opacity=o.toFixed(3);
        el.style.transform='translate(calc(-50% + '+x.toFixed(1)+'px),calc(-50% + '+y.toFixed(1)+'px)) scale('+z.toFixed(3)+')';

        // Field values. The first form is typed out so you read what is being asked for; after
        // that they snap in, because the point is that it is the same answer every time.
        const vals=[...el.querySelectorAll('.val')], caret=el.querySelector('.caret');
        const fill=seg(u,t0+0.012,t0+(i===0?0.235:0.045));
        const per=1/vals.length;
        vals.forEach((v,k)=>{
          const p=clamp((fill-k*per)/per,0,1);
          const s=v.dataset.v;
          v.textContent=i===0? s.slice(0,Math.round(s.length*p)) : (p>0.35?s:'');
          v.style.color=p>0?'var(--fg)':'transparent';
        });
        if(caret){ const live=fill>0&&fill<1&&i===0;
          caret.style.opacity=live&&(Math.floor(u*${DUR}*6)%2===0)?1:0; }
      });

      // The tally, arriving with the pull-back.
      const cu=seg(u,0.42,0.97);
      counter.style.opacity=easeOut(seg(u,0.42,0.55)).toFixed(3);
      cnum.textContent=String(Math.round(1+cu*46)).padStart(2,'0');
    };`;

  return SHELL(
    `<div class="world" id="world">${cards}</div><div class="vig"></div>
     <div class="counter" id="counter"><div class="n" id="cnum">01</div>
       <div class="l">Applications</div></div>`,
    style, script);
}

// ── Scene 14: the close ─────────────────────────────────────────────────────
// Set-up completes and drops away; find and apply stay, cycling. The shape of the film in one
// image: the work happens once, the loop is what is left.
function loopScene() {
  const style = `
    .wrap{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
      justify-content:center;gap:${VERTICAL ? 76 : 76}px}
    .chips{display:flex;align-items:center;gap:${VERTICAL ? 22 : 40}px;
      flex-direction:${VERTICAL ? 'column' : 'row'}}
    .chip{position:relative;padding:${VERTICAL ? '26px 46px' : '34px 68px'};border-radius:999px;
      border:2px solid var(--rule);background:rgba(22,34,58,.6);
      font-size:${VERTICAL ? 44 : 60}px;font-weight:660;letter-spacing:-.01em;color:var(--fg-dim);
      display:flex;align-items:center;gap:18px;white-space:nowrap}
    .chip.live{border-color:var(--accent);color:var(--fg)}
    .tick{width:${VERTICAL ? 36 : 44}px;height:${VERTICAL ? 36 : 44}px;border-radius:50%;
      background:var(--brand);display:flex;align-items:center;justify-content:center;
      font-size:26px;color:#0B1220;font-weight:800;opacity:0}
    .arrow{color:var(--fg-faint);font-size:${VERTICAL ? 40 : 54}px;opacity:.5;
      transform:rotate(${VERTICAL ? '90deg' : '0deg'})}
    .line{font-size:${VERTICAL ? 58 : 78}px;font-weight:660;color:var(--fg);letter-spacing:-.02em;
      text-align:center;opacity:0;padding:0 8%}
    .line em{font-style:normal;color:var(--accent)}`;

  const script = `
    const setup=document.getElementById('s1'), find=document.getElementById('s2'),
          apply=document.getElementById('s3'), tick=document.getElementById('tk'),
          line=document.getElementById('ln'), a1=document.getElementById('a1');
    window.seek=function(u){
      // Set up gets ticked, then fades back - it is done, and it does not come round again.
      const done=easeOut(seg(u,0.10,0.26));
      tick.style.opacity=done.toFixed(3);
      tick.style.transform='scale('+(0.5+0.5*done).toFixed(3)+')';
      const rec=ease(seg(u,0.30,0.50));
      setup.style.opacity=(1-0.62*rec).toFixed(3);
      setup.style.transform='scale('+(1-0.10*rec).toFixed(3)+')';
      setup.classList.toggle('live', u<0.30);

      // Find and apply take over, alternating - the loop you are left with.
      const on=easeOut(seg(u,0.34,0.50));
      [find,apply].forEach((el,i)=>{
        el.style.opacity=(0.45+0.55*on).toFixed(3);
        const beat=Math.floor(clamp((u-0.42)/0.155,0,9));
        el.classList.toggle('live', on>0.4 && beat%2===i);
      });
      a1.style.opacity=(0.5*on).toFixed(3);
      line.style.opacity=easeOut(seg(u,0.58,0.76)).toFixed(3);
      line.style.transform='translateY('+(20*(1-easeOut(seg(u,0.58,0.76)))).toFixed(1)+'px)';
    };`;

  return SHELL(
    `<div class="wrap">
       <div class="chips">
         <div class="chip live" id="s1">Set up<span class="tick" id="tk">✓</span></div>
         <div class="chip" id="s2">Find a job</div>
         <div class="arrow" id="a1">→</div>
         <div class="chip" id="s3">Apply</div>
       </div>
       <div class="line" id="ln">No retyping.<br><em>Just find, and apply.</em></div>
     </div>`, style, script);
}

// ── Scene 02 / 15: the cards, given movement ────────────────────────────────
function titleScene() {
  const c = scene.card;
  const style = `
    .wrap{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;
      align-items:center;text-align:center;padding:0 ${VERTICAL ? '7%' : '12%'}}
    .kick{font-size:26px;font-weight:600;letter-spacing:.34em;text-transform:uppercase;
      color:var(--accent);margin-bottom:42px;opacity:0}
    h1{font-size:${VERTICAL ? 74 : 108}px;line-height:1.1;font-weight:640;letter-spacing:-.025em;
      color:var(--fg);text-wrap:balance}
    h1 span{display:block;opacity:0}
    h1 .dim{color:var(--fg-dim);font-weight:560}
    .hair{width:0;height:3px;background:var(--rule);margin:52px auto 0}`;
  const script = `
    const k=document.getElementById('k'),l1=document.getElementById('l1'),
          l2=document.getElementById('l2'),h=document.getElementById('h');
    window.seek=function(u){
      k.style.opacity=easeOut(seg(u,0.04,0.20)).toFixed(3);
      [[l1,0.12],[l2,0.26]].forEach(([el,t0])=>{
        const p=easeOut(seg(u,t0,t0+0.26));
        el.style.opacity=p.toFixed(3);
        el.style.transform='translateY('+(34*(1-p)).toFixed(1)+'px)';
      });
      h.style.width=(120*easeOut(seg(u,0.46,0.76))).toFixed(1)+'px';
    };`;
  return SHELL(
    `<div class="wrap"><div class="kick" id="k">${esc(c.kicker)}</div>
      <h1><span id="l1">${esc(c.big)}</span><span class="dim" id="l2">${esc(c.big2)}</span></h1>
      <div class="hair" id="h"></div></div>`, style, script);
}

function endScene() {
  const c = scene.card;
  const iconPath = path.resolve(HERE, '../../../MobileApp/assets/images/icon.png');
  const icon = fs.existsSync(iconPath)
    ? 'data:image/png;base64,' + fs.readFileSync(iconPath).toString('base64') : '';
  const style = `
    .wrap{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;
      align-items:center;text-align:center}
    .icon{width:${VERTICAL ? 200 : 200}px;height:${VERTICAL ? 200 : 200}px;border-radius:45px;
      margin-bottom:52px;box-shadow:0 30px 80px rgba(0,0,0,.55);opacity:0}
    h1{font-size:${VERTICAL ? 100 : 122}px;font-weight:640;letter-spacing:-.03em;color:var(--fg);opacity:0}
    .sub{font-size:${VERTICAL ? 36 : 42}px;margin-top:30px;color:var(--fg-dim);font-weight:420;opacity:0}
    .url{margin-top:56px;font-size:26px;font-weight:600;letter-spacing:.2em;text-transform:uppercase;
      color:var(--accent);opacity:0}
    .stores{margin-top:30px;font-size:22px;letter-spacing:.14em;color:var(--fg-faint);
      text-transform:uppercase;font-weight:600;opacity:0}`;
  const script = `
    const els=['ic','h1','sb','ur','st'].map(i=>document.getElementById(i));
    window.seek=function(u){
      [[0,0.02],[1,0.14],[2,0.26],[3,0.40],[4,0.50]].forEach(([i,t0])=>{
        const p=easeOut(seg(u,t0,t0+0.24)), el=els[i];
        if(!el) return;
        el.style.opacity=p.toFixed(3);
        el.style.transform = i===0
          ? 'scale('+(0.86+0.14*p).toFixed(3)+')'
          : 'translateY('+(24*(1-p)).toFixed(1)+'px)';
      });
    };`;
  return SHELL(
    `<div class="wrap">
      ${icon ? `<img class="icon" id="ic" src="${icon}">` : ''}
      <h1 id="h1">${esc(c.big)}</h1><div class="sub" id="sb">${esc(c.sub)}</div>
      <div class="url" id="ur">${esc(c.url)}</div>
      <div class="stores" id="st">App Store &nbsp;·&nbsp; Google Play</div></div>`, style, script);
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/(\w)'(\w)/g, '$1’$2');

(async () => {
  const html = { retyping: retypingScene, loop: loopScene, title: titleScene, end: endScene }[scene.anim]();
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);

  const n = Math.round(DUR * FPS);
  for (let f = 0; f < n; f++) {
    await page.evaluate((u) => window.seek(u), n === 1 ? 0 : f / (n - 1));
    await page.screenshot({ path: path.join(OUT, String(f).padStart(5, '0') + '.png') });
  }
  await browser.close();
  console.log(`  anim ${SCENE} (${scene.anim}) ${n} frames @${W}x${H}`);
})();
