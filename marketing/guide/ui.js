// Shared look-and-feel for the in-app "How to use CVApplyr" guide GIFs.
// Mirrors the real app's design language (see MobileApp/CLAUDE.md + job-detail.tsx theme):
//   dark hero #0B1120 · feed #EDF1F8 · white cards r24 · cyan #06B6D4 → blue #3B82F6 accents.
// Everything here is GENERIC — persona "Alex Taylor", fictional employers. No real user data.
'use strict';

const P = {
  name: 'Alex Taylor',
  email: 'alex.taylor@example.com',
  phone: '+1 555 0134',
  city: 'Berlin, Germany',
  role: '.NET Developer',
  initials: 'AT',
};

const CO = {
  main: 'Northwind Analytics',
  mainDomain: 'northwind-analytics.com',
  alt: 'Orbit Systems',
  alt2: 'Lumen Labs',
};

const CSS = `
*{margin:0;padding:0;box-sizing:border-box;-webkit-font-smoothing:antialiased}
body{width:540px;height:1000px;overflow:hidden;font-family:-apple-system,'SF Pro Display','Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#0B1120}
.stage{position:relative;width:540px;height:1000px;background:#EDF1F8;overflow:hidden}

/* ── caption bar ─────────────────────────────────────────── */
.cap{position:absolute;left:0;right:0;top:0;z-index:60;padding:16px 20px 30px;
  background:linear-gradient(180deg,rgba(8,12,28,.97) 0%,rgba(8,12,28,.97) 74%,rgba(8,12,28,.80) 88%,rgba(8,12,28,0) 100%)}
.cap .eyebrow{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.cap .num{font-size:11px;font-weight:800;letter-spacing:.14em;color:#22D3EE;text-transform:uppercase}
.cap .dots{display:flex;gap:4px;margin-left:auto}
.cap .dot{width:5px;height:5px;border-radius:3px;background:rgba(255,255,255,.24)}
.cap .dot.on{background:#22D3EE;width:14px}
.cap h2{font-size:20px;line-height:1.25;font-weight:750;color:#fff;letter-spacing:-.4px}
.cap p{margin-top:4px;font-size:13.5px;line-height:1.35;color:rgba(255,255,255,.66);font-weight:500}

/* ── phone chrome ────────────────────────────────────────── */
.screen{position:absolute;left:0;right:0;top:0;bottom:0;background:#EDF1F8;display:flex;flex-direction:column}
.statusbar{height:34px;display:flex;align-items:center;justify-content:space-between;padding:0 22px;font-size:12px;font-weight:700;color:#0B0F22;flex:0 0 auto}
.body{flex:1;overflow:hidden;padding:0 16px}
.pad{padding-top:96px}

/* ── app header ──────────────────────────────────────────── */
.apphead{display:flex;align-items:center;gap:10px;padding:6px 2px 12px}
.logo{font-size:19px;font-weight:800;color:#0B0F22;letter-spacing:-.5px}
.logo b{color:#3B82F6}
.hbtn{margin-left:auto;width:36px;height:36px;border-radius:12px;background:#fff;display:flex;align-items:center;justify-content:center;
  box-shadow:0 2px 10px rgba(15,23,42,.10);font-size:14px}

/* ── cards ───────────────────────────────────────────────── */
.hero{border-radius:22px;padding:18px;background:linear-gradient(145deg,#0B1120 0%,#16204a 62%,#1d2a5e 100%);color:#fff;position:relative;overflow:hidden}
.hero .k{font-size:10.5px;font-weight:800;letter-spacing:.16em;color:rgba(255,255,255,.5);text-transform:uppercase}
.hero h3{font-size:25px;font-weight:800;letter-spacing:-.6px;margin-top:5px}
.hero .sub{font-size:12.5px;color:rgba(255,255,255,.6);margin-top:5px;line-height:1.35}
.hero .stats{display:flex;gap:0;margin-top:14px;background:rgba(255,255,255,.07);border-radius:14px;padding:11px 0}
.hero .st{flex:1;text-align:center}
.hero .st .v{font-size:17px;font-weight:800}
.hero .st .l{font-size:9.5px;color:rgba(255,255,255,.55);margin-top:2px;letter-spacing:.06em;text-transform:uppercase}
.card{background:#fff;border-radius:20px;padding:15px;box-shadow:0 6px 22px rgba(15,23,42,.07);margin-top:12px}
.card.tight{padding:13px}
.rowc{display:flex;align-items:center;gap:11px}
.ttl{font-size:15px;font-weight:750;color:#0B0F22;letter-spacing:-.25px}
.sub2{font-size:12px;color:#5A6480;margin-top:3px;line-height:1.35}
.muted{font-size:11.5px;color:#8A93B2}
.sec{font-size:10.5px;font-weight:800;letter-spacing:.14em;color:#8A93B2;text-transform:uppercase;margin:16px 2px 8px}

/* ── bits ────────────────────────────────────────────────── */
.chip{display:inline-flex;align-items:center;gap:5px;padding:5px 10px;border-radius:999px;font-size:11px;font-weight:650;
  background:#F1F5FB;color:#334155;border:1px solid #E2E8F0;margin:0 5px 5px 0}
.chip.blue{background:rgba(79,141,255,.10);color:#2563EB;border-color:rgba(79,141,255,.28)}
.chip.green{background:rgba(16,185,129,.11);color:#059669;border-color:rgba(16,185,129,.30)}
.chip.add{background:#fff;color:#4F8DFF;border:1px dashed rgba(79,141,255,.5)}
.badge{display:inline-flex;align-items:center;gap:5px;padding:4px 9px;border-radius:999px;font-size:10.5px;font-weight:750}
.badge.g{background:rgba(16,185,129,.12);color:#059669}
.badge.b{background:rgba(79,141,255,.12);color:#2563EB}
.badge.a{background:rgba(245,158,11,.14);color:#B45309}
.btn{height:46px;border-radius:14px;display:flex;align-items:center;justify-content:center;gap:8px;font-size:14px;font-weight:750;color:#fff;
  background:linear-gradient(100deg,#4F8DFF,#7C6BFF 55%,#5B4FE8)}
.btn.cy{background:linear-gradient(100deg,#06B6D4,#3B82F6)}
.btn.gr{background:linear-gradient(100deg,#10B981,#059669)}
.btn.ghost{background:#fff;color:#0B0F22;border:1.5px solid #CBD5E1}
.av{width:44px;height:44px;border-radius:14px;display:flex;align-items:center;justify-content:center;font-weight:800;color:#fff;font-size:15px;flex:0 0 auto}
.tick{width:22px;height:22px;border-radius:11px;background:#10B981;color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;flex:0 0 auto}
.circle{width:22px;height:22px;border-radius:11px;border:2px solid #CBD5E1;flex:0 0 auto}
.bar{height:7px;border-radius:4px;background:#E2E8F0;overflow:hidden}
.bar i{display:block;height:100%;border-radius:4px;background:linear-gradient(90deg,#06B6D4,#3B82F6)}
.field{border:1.5px solid #E2E8F0;border-radius:12px;padding:10px 12px;background:#fff;margin-top:8px}
.field .lb{font-size:10px;font-weight:750;color:#8A93B2;letter-spacing:.08em;text-transform:uppercase}
.field .vl{font-size:13.5px;color:#0B0F22;font-weight:600;margin-top:3px}
.field.fill{border-color:rgba(16,185,129,.55);background:rgba(16,185,129,.05)}
.field.focus{border-color:#4F8DFF;box-shadow:0 0 0 3px rgba(79,141,255,.16)}

/* ── tab bar ─────────────────────────────────────────────── */
.tabs{position:absolute;left:14px;right:14px;bottom:14px;height:62px;background:#fff;border-radius:22px;display:flex;align-items:center;
  padding:0 8px;box-shadow:0 8px 26px rgba(15,23,42,.13);z-index:20}
.tab{flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;font-size:10.5px;font-weight:650;color:#8A93B2}
.tab .ic{font-size:16px}
.tab.on{color:#fff}
.tab.on .pill{background:#3B82F6;border-radius:14px;padding:8px 16px;display:flex;align-items:center;gap:6px;color:#fff;font-size:12px;font-weight:750}

/* ── pointer + highlight ─────────────────────────────────── */
.ring{position:absolute;border:3px solid #22D3EE;border-radius:16px;z-index:45;box-shadow:0 0 0 4px rgba(34,211,238,.20)}
.ptr{position:absolute;z-index:50;width:38px;height:38px;margin:-19px 0 0 -19px}
.ptr .h{position:absolute;inset:0;border-radius:19px;background:rgba(34,211,238,.30);border:2px solid #22D3EE}
.ptr .c{position:absolute;left:11px;top:11px;width:16px;height:16px;border-radius:8px;background:#22D3EE;box-shadow:0 2px 8px rgba(0,0,0,.3)}
.note{position:absolute;z-index:55;background:#0B0F22;color:#fff;font-size:12px;font-weight:650;padding:8px 12px;border-radius:12px;
  box-shadow:0 8px 24px rgba(0,0,0,.28);max-width:250px;line-height:1.3}
.note:after{content:'';position:absolute;width:10px;height:10px;background:#0B0F22;transform:rotate(45deg)}
.note.up:after{top:-5px;left:22px}
.note.dn:after{bottom:-5px;left:22px}
`;

// ── helpers ────────────────────────────────────────────────
const statusbar = () => `<div class="statusbar"><span>9:41</span><span>􀙇 􀛨</span></div>`;
const tabs = (on = 'Home', target = null) => {
  const t = (ic, l) => {
    const mark = target === l ? ' t' : '';
    return on === l
      ? `<div class="tab on${mark}"><div class="pill"><span>${ic}</span>${l}</div></div>`
      : `<div class="tab${mark}"><span class="ic">${ic}</span><span>${l}</span></div>`;
  };
  return `<div class="tabs">${t('⌂', 'Home')}${t('💼', 'Jobs')}${t('📄', 'Letters')}${t('👤', 'Me')}</div>`;
};
const apphead = (right = '☰') => `<div class="apphead"><div class="logo">cv<b>applyr</b></div><div class="hbtn">🔔</div><div class="hbtn">${right}</div></div>`;
const av = (txt, c1, c2) => `<div class="av" style="background:linear-gradient(135deg,${c1},${c2})">${txt}</div>`;

// Caption + screen only. The highlight ring / pointer / tip are injected by the renderer AFTER
// measuring the element marked `.t`, so they always land exactly on the real target.
function frame({ n, total, title, note, screen }) {
  const dots = Array.from({ length: total }, (_, i) => `<div class="dot${i === n - 1 ? ' on' : ''}"></div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body><div class="stage">
    <div class="screen">${statusbar()}${screen}</div>
    <div class="cap"><div class="eyebrow"><span class="num">Step ${n} of ${total}</span><div class="dots">${dots}</div></div>
      <h2>${title}</h2>${note ? `<p>${note}</p>` : ''}</div>
  </div></body></html>`;
}

module.exports = { P, CO, CSS, frame, statusbar, tabs, apphead, av };
