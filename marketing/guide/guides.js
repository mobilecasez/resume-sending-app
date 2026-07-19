// Storyboards for the six in-app how-to GIFs. Generic persona + fictional employers throughout.
'use strict';
const { P, CO, tabs, apphead, av } = require('./ui');

const B = (inner, tab, tgt) => `<div class="body pad">${inner}</div>${tabs(tab, tgt)}`;

// ═══════════════════════════════════════════════════════════════════════════
// 1 — Set up your profile
// ═══════════════════════════════════════════════════════════════════════════
const setupList = (done, tgt) => {
  const row = (i, ic, t, s, extra = '') => `
    <div class="card tight${tgt === i ? ' t' : ''}"><div class="rowc">
      ${done > i ? '<div class="tick">✓</div>' : '<div class="circle"></div>'}
      <div style="flex:1"><div class="ttl">${ic} ${t}</div><div class="sub2">${done > i ? extra || 'Done' : s}</div></div>
      <div class="muted">${done > i ? '' : '›'}</div>
    </div></div>`;
  return `${apphead('👤')}
  <div class="hero"><div class="k">Getting started</div><h3>Your profile</h3>
    <div class="sub">Finish these once — every résumé, cover letter and application uses them.</div>
    <div style="margin-top:14px" class="bar${tgt === 'bar' ? ' t' : ''}"><i style="width:${done * 25}%"></i></div>
    <div style="margin-top:7px;font-size:11.5px;color:rgba(255,255,255,.62)">${done} of 4 complete</div>
  </div>
  ${row(0, '📝', 'Personal details', 'Name, contact, location')}
  ${row(1, '📷', 'Profile photo', 'Used on photo-style résumés', 'Uploaded')}
  ${row(2, '📄', 'Résumé', 'Upload any existing CV — we read it', 'Parsed · 14 skills found')}
  ${row(3, '✍️', 'Signature', 'Upload or generate one', 'Generated')}`;
};

const guide1 = {
  id: '01-set-up-your-profile',
  title: 'Set up your profile',
  steps: [
    {
      title: 'Open your account',
      note: 'Everything starts here. Tap the “Me” tab.',
      screen: B(`${apphead()}
        <div class="hero"><div class="k">Welcome</div><h3>Let’s get you ready</h3>
          <div class="sub">Complete your profile first — it powers every résumé and cover letter.</div></div>
        <div class="card"><div class="rowc">${av('1', '#06B6D4', '#3B82F6')}<div style="flex:1">
          <div class="ttl">Finish your profile</div><div class="sub2">Takes about 2 minutes</div></div>
          <div class="badge a">To do</div></div></div>`, 'Me', 'Me'),
    },
    {
      title: 'Add your personal details',
      note: 'Name, email, phone and location — used on every document.',
      screen: B(setupList(0, 0), 'Me'),
    },
    {
      title: 'Fill in the basics',
      note: 'These appear on your résumé header and cover letters.',
      screen: `<div class="body pad">${apphead('👤')}
        <div class="sec">Personal details</div>
        <div class="field fill"><div class="lb">Full name</div><div class="vl">${P.name}</div></div>
        <div class="field fill"><div class="lb">Email</div><div class="vl">${P.email}</div></div>
        <div class="field fill"><div class="lb">Phone</div><div class="vl">${P.phone}</div></div>
        <div class="field focus"><div class="lb">Location</div><div class="vl">${P.city}</div></div>
        <div style="margin-top:16px" class="btn cy t">Save details</div></div>`,
    },
    {
      title: 'Upload a profile photo',
      note: 'Needed for regions where photo CVs are the norm — Germany, France, India.',
      screen: B(`${apphead('👤')}
        <div class="sec">Profile photo</div>
        <div class="card"><div style="display:flex;flex-direction:column;align-items:center;padding:14px 0">
          ${av(P.initials, '#7C6BFF', '#4F8DFF').replace('width:44px;height:44px;border-radius:14px', 'width:96px;height:96px;border-radius:48px').replace('font-size:15px', 'font-size:32px')}
          <div class="ttl" style="margin-top:12px">${P.name}</div>
          <div class="sub2">${P.role} · ${P.city}</div>
        </div>
        <div class="btn cy t">Upload photo</div>
        <div style="text-align:center;margin-top:9px" class="muted">JPG or PNG · square works best</div></div>
        <div class="card tight"><div class="sub2">🇩🇪 🇫🇷 🇮🇳 Photo CVs are standard in these regions — we add it automatically when you pick one.</div></div>`, 'Me'),
    },
    {
      title: 'Upload any résumé you already have',
      note: 'Old or rough is fine — we read it and pull out your skills.',
      screen: B(`${apphead('👤')}
        <div class="sec">Résumé</div>
        <div class="card t"><div class="rowc">${av('📄', '#10B981', '#059669')}
          <div style="flex:1"><div class="ttl">my-cv-2024.pdf</div><div class="sub2">Uploaded · 148 KB</div></div>
          <div class="badge g">✓ Parsed</div></div>
          <div style="margin-top:12px" class="bar"><i style="width:100%"></i></div>
          <div class="sub2" style="margin-top:8px">We found <b>14 skills</b> and 3 roles.</div>
          <div style="margin-top:8px">
            <span class="chip blue">C#</span><span class="chip blue">.NET Core</span><span class="chip blue">Azure</span>
            <span class="chip blue">SQL</span><span class="chip">+10 more</span></div>
        </div>
        <div class="card tight"><div class="sub2">Don’t have one handy? Build a fresh one in <b>Résumé Builder</b> for any region.</div></div>`, 'Me'),
    },
    {
      title: 'Add your signature',
      note: 'Upload a photo of it, or let the app generate one for your cover letters.',
      screen: B(`${apphead('👤')}
        <div class="sec">Signature</div>
        <div class="card">
          <div style="height:110px;border-radius:14px;border:1.5px dashed #CBD5E1;background:#FAFBFF;display:flex;align-items:center;justify-content:center">
            <div style="font-family:'Snell Roundhand','Brush Script MT',cursive;font-size:38px;color:#0B0F22;transform:rotate(-4deg)">${P.name}</div>
          </div>
          <div style="display:flex;gap:9px;margin-top:12px">
            <div class="btn ghost" style="flex:1">Upload</div><div class="btn gr t" style="flex:1">Generate</div></div>
        </div>
        <div class="card tight"><div class="sub2">Your signature is placed at the bottom of every cover letter you send.</div></div>`, 'Me'),
    },
    {
      title: 'You’re ready',
      noTap: true,
      note: 'Profile complete — now every document is tailored to you automatically.',
      screen: B(setupList(4, 'bar'), 'Me'),
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// 2 — Résumé Builder for any region
// ═══════════════════════════════════════════════════════════════════════════
const regionRow = (flag, name, desc, on) => `
  <div class="card tight${on ? ' t' : ''}" style="${on ? 'border:2px solid #4F8DFF;background:rgba(79,141,255,.04)' : ''}">
    <div class="rowc"><div style="font-size:22px">${flag}</div>
      <div style="flex:1"><div class="ttl">${name}</div><div class="sub2">${desc}</div></div>
      ${on ? '<div class="tick">✓</div>' : '<div class="muted">›</div>'}</div></div>`;

const cvPaper = (opts) => `
  <div style="background:#fff;border-radius:12px;padding:14px;box-shadow:0 6px 22px rgba(15,23,42,.10)">
    <div style="display:flex;gap:11px;align-items:flex-start">
      ${opts.photo ? `<div style="width:56px;height:68px;border-radius:7px;background:linear-gradient(135deg,#7C6BFF,#4F8DFF);flex:0 0 auto;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800">${P.initials}</div>` : ''}
      <div style="flex:1">
        <div style="font-size:15px;font-weight:800;color:#0B0F22;letter-spacing:-.3px">${P.name}</div>
        <div style="font-size:10.5px;color:#5A6480;margin-top:2px">${P.role} · ${opts.loc}</div>
        <div style="font-size:9.5px;color:#8A93B2;margin-top:2px">${P.email} · ${P.phone}</div>
        ${opts.extra ? `<div style="font-size:9.5px;color:#8A93B2;margin-top:2px">${opts.extra}</div>` : ''}
      </div></div>
    <div style="height:1px;background:#E2E8F0;margin:11px 0"></div>
    <div style="font-size:9.5px;font-weight:800;letter-spacing:.12em;color:#8A93B2">${opts.h1}</div>
    ${[92, 78, 86].map((w) => `<div style="height:5px;border-radius:3px;background:#E8EDF6;margin-top:6px;width:${w}%"></div>`).join('')}
    <div style="font-size:9.5px;font-weight:800;letter-spacing:.12em;color:#8A93B2;margin-top:12px">${opts.h2}</div>
    ${[95, 70].map((w) => `<div style="height:5px;border-radius:3px;background:#E8EDF6;margin-top:6px;width:${w}%"></div>`).join('')}
    <div style="margin-top:11px">${['C#', '.NET', 'Azure', 'SQL'].map((s) => `<span class="chip" style="font-size:9px;padding:3px 7px">${s}</span>`).join('')}</div>
  </div>`;

const guide2 = {
  id: '02-build-a-resume-for-any-region',
  title: 'Build a résumé for any region',
  steps: [
    {
      title: 'Open Résumé Builder',
      note: 'One profile — a correctly formatted CV for every country.',
      screen: B(`${apphead('👤')}
        <div class="hero"><div class="k">Documents</div><h3>Résumé Builder</h3>
          <div class="sub">Pick a region and we apply that country’s CV conventions for you.</div></div>
        <div class="card"><div class="rowc">${av('📄', '#06B6D4', '#3B82F6')}
          <div style="flex:1" class="t"><div class="ttl">Build a new résumé</div><div class="sub2">9 designs · region-aware</div></div>
          <div class="muted">›</div></div></div>
        <div class="card tight"><div class="rowc">${av('✉️', '#7C6BFF', '#4F8DFF')}
          <div style="flex:1"><div class="ttl">Cover Letter formats</div><div class="sub2">Matching designs</div></div>
          <div class="muted">›</div></div></div>`, 'Me'),
    },
    {
      title: 'Choose the region you’re applying to',
      note: 'Each country expects a different CV — photo or no photo, one page or two.',
      screen: B(`${apphead('👤')}
        <div class="sec">Choose a region</div>
        ${regionRow('🌍', 'Global / ATS-safe', 'Plain, machine-readable', false)}
        ${regionRow('🇺🇸', 'United States', 'No photo, no date of birth', false)}
        ${regionRow('🇬🇧', 'United Kingdom', 'Two pages, personal statement', false)}
        ${regionRow('🇩🇪', 'Germany', 'Photo, Lebenslauf structure', true)}
        ${regionRow('🇮🇳', 'India', 'Photo, detailed skills section', false)}`, 'Me'),
    },
    {
      title: 'Germany — with photo, Lebenslauf layout',
      note: 'The right conventions applied automatically. No reformatting by hand.',
      screen: B(`${apphead('👤')}
        <div style="display:flex;align-items:center;gap:8px;margin:2px 2px 10px">
          <span class="chip blue" style="margin:0">🇩🇪 Germany</span><span class="muted">Photo · Lebenslauf</span></div>
        ${cvPaper({ photo: true, loc: 'Berlin', extra: 'Geburtsdatum · Staatsangehörigkeit', h1: 'BERUFSERFAHRUNG', h2: 'AUSBILDUNG' })}
        <div style="display:flex;gap:9px;margin-top:14px">
          <div class="btn ghost" style="flex:1">Preview</div><div class="btn cy t" style="flex:1">Download PDF</div></div>`, 'Me'),
    },
    {
      title: 'Switch region — the CV rebuilds itself',
      note: 'Same profile, US rules: no photo, no personal data, ATS-friendly.',
      screen: B(`${apphead('👤')}
        <div style="display:flex;align-items:center;gap:8px;margin:2px 2px 10px">
          <span class="chip blue t" style="margin:0">🇺🇸 United States</span><span class="muted">No photo · ATS-safe</span></div>
        ${cvPaper({ photo: false, loc: 'Berlin, Germany', h1: 'EXPERIENCE', h2: 'EDUCATION' })}
        <div style="display:flex;gap:9px;margin-top:14px">
          <div class="btn ghost" style="flex:1">Preview</div><div class="btn cy" style="flex:1">Download PDF</div></div>`, 'Me'),
    },
    {
      title: 'Download and you’re done',
      noTap: true,
      note: 'Saved to your documents — ready to attach to any application.',
      screen: B(`${apphead('👤')}
        <div class="card"><div class="rowc">${av('✓', '#10B981', '#059669')}
          <div style="flex:1" class="t"><div class="ttl">Résumé ready</div><div class="sub2">Alex-Taylor-CV-US.pdf · 1 page</div></div>
          <div class="badge g">Saved</div></div></div>
        <div class="sec">Your documents</div>
        <div class="card tight"><div class="rowc"><div style="font-size:19px">🇺🇸</div>
          <div style="flex:1"><div class="ttl">US résumé</div><div class="sub2">ATS-safe · updated just now</div></div>
          <div class="badge b">PDF</div></div></div>
        <div class="card tight"><div class="rowc"><div style="font-size:19px">🇩🇪</div>
          <div style="flex:1"><div class="ttl">German Lebenslauf</div><div class="sub2">With photo</div></div>
          <div class="badge b">PDF</div></div></div>`, 'Me'),
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// 3 — Find live jobs and save them
// ═══════════════════════════════════════════════════════════════════════════
const jobCard = (title, co, loc, match, saved) => `
  <div class="card tight"><div class="rowc">
    ${av(co[0], '#06B6D4', '#3B82F6')}
    <div style="flex:1"><div class="ttl">${title}</div><div class="sub2">${co} · ${loc}</div></div>
    ${saved ? '<div class="badge g">✓ Saved</div>' : `<div class="badge b">${match}%</div>`}
  </div></div>`;

const guide3 = {
  id: '03-find-and-save-live-jobs',
  title: 'Find live jobs and save them',
  steps: [
    {
      title: 'Open the Jobs tab',
      note: 'Search real openings from across the web, live.',
      screen: B(`${apphead()}
        <div class="hero"><div class="k">AI-powered job search</div><h3>Job Hub</h3>
          <div class="sub">Search live listings, save the good ones, apply from here.</div>
          <div class="stats"><div class="st"><div class="v">0</div><div class="l">Saved</div></div>
            <div class="st"><div class="v">0</div><div class="l">Applied</div></div>
            <div class="st"><div class="v">—</div><div class="l">Replies</div></div></div></div>`, 'Jobs', 'Jobs'),
    },
    {
      title: 'Type what you’re looking for',
      note: 'Plain language works — role plus city or country.',
      screen: B(`${apphead()}
        <div class="field focus" style="margin-top:4px"><div class="lb">Search</div>
          <div class="vl">${P.role} in Berlin<span style="color:#4F8DFF">|</span></div></div>
        <div style="display:flex;gap:9px;margin-top:10px">
          <div class="btn gr t" style="flex:1;font-size:13px">🔍 Search live on Google</div>
          <div class="btn ghost" style="width:56px">⚙︎</div></div>
        <div class="sec">Recent searches</div>
        <div class="card tight"><div class="sub2">Backend engineer in Amsterdam</div></div>
        <div class="card tight"><div class="sub2">.NET developer · Remote</div></div>`, 'Jobs'),
      tip: 'Green = search the live web right now',
    },
    {
      title: 'Live results come back with real job titles',
      note: 'Each card shows the role, the employer and how well it matches you.',
      screen: B(`${apphead()}
        <div class="rowc" style="margin:2px 2px 8px"><div class="badge g">● Live</div>
          <div class="muted" style="flex:1">18 openings found</div><div class="muted">Sort ▾</div></div>
        ${jobCard('Senior .NET Developer', CO.main, 'Berlin · Hybrid', 92).replace('card tight','card tight t')}
        ${jobCard('Backend Engineer (C#)', CO.alt, 'Berlin · Remote', 87)}
        ${jobCard('.NET Core Developer', CO.alt2, 'Munich · On-site', 81)}
        ${jobCard('Full-stack .NET Engineer', 'Vantage Digital', 'Berlin', 76)}`, 'Jobs'),
    },
    {
      title: 'Open a job to see the real posting',
      note: 'The full description opens right inside the app.',
      screen: `<div class="body" style="padding-top:96px">
        <div class="card" style="margin-top:0"><div class="rowc">${av('N', '#06B6D4', '#3B82F6')}
          <div style="flex:1"><div class="ttl">Senior .NET Developer</div><div class="sub2">${CO.main} · Berlin</div></div></div>
          <div style="margin-top:11px"><span class="chip">Full-time</span><span class="chip">Hybrid</span><span class="chip">5+ years</span></div>
          <div class="sec" style="margin:13px 0 6px">Responsibilities</div>
          <div class="sub2">• Build and maintain .NET Core services</div>
          <div class="sub2">• Design REST APIs used across the platform</div>
          <div class="sub2">• Work with Azure, SQL Server and CI/CD</div>
          <div class="sec" style="margin:13px 0 6px">Skills</div>
          <div><span class="chip blue">C#</span><span class="chip blue">.NET Core</span><span class="chip blue">Azure</span><span class="chip blue">SQL</span></div>
        </div>
        <div style="position:absolute;right:26px;bottom:120px;z-index:30;text-align:center">
          <div class="t" style="width:62px;height:62px;border-radius:31px;background:linear-gradient(135deg,#7C6BFF,#4F8DFF);display:flex;align-items:center;justify-content:center;font-size:26px;box-shadow:0 8px 24px rgba(79,141,255,.45)">🤖</div>
          <div style="margin-top:6px;background:#0B0F22;color:#fff;font-size:10px;font-weight:750;padding:4px 9px;border-radius:9px">Job tools</div>
        </div>`,
      tip: 'Tap the robot for job tools',
    },
    {
      title: 'Save it to your Job Hub',
      note: 'One tap captures the full posting — title, skills, everything.',
      screen: `<div class="body" style="padding-top:96px">
        <div class="card" style="margin-top:0;opacity:.35"><div class="rowc">${av('N', '#06B6D4', '#3B82F6')}
          <div style="flex:1"><div class="ttl">Senior .NET Developer</div><div class="sub2">${CO.main} · Berlin</div></div></div></div>
        <div style="position:absolute;left:16px;right:16px;bottom:96px;background:#131A32;border-radius:22px;padding:16px;z-index:40;box-shadow:0 -8px 30px rgba(0,0,0,.3)">
          <div style="width:38px;height:4px;border-radius:2px;background:rgba(255,255,255,.22);margin:0 auto 13px"></div>
          <div style="display:flex;gap:11px">
            <div class="t" style="flex:1;background:rgba(255,255,255,.06);border-radius:16px;padding:14px;text-align:center">
              <div style="width:44px;height:44px;border-radius:14px;margin:0 auto;background:linear-gradient(135deg,#06B6D4,#3B82F6);display:flex;align-items:center;justify-content:center;font-size:19px">✨</div>
              <div style="color:#fff;font-size:12.5px;font-weight:750;margin-top:8px">Save job</div>
              <div style="color:rgba(255,255,255,.5);font-size:10px;margin-top:2px">Add to Job Hub</div></div>
            <div style="flex:1;background:rgba(255,255,255,.06);border-radius:16px;padding:14px;text-align:center">
              <div style="width:44px;height:44px;border-radius:14px;margin:0 auto;background:linear-gradient(135deg,#7C6BFF,#EC4899);display:flex;align-items:center;justify-content:center;font-size:19px">⚡</div>
              <div style="color:#fff;font-size:12.5px;font-weight:750;margin-top:8px">Apply here</div>
              <div style="color:rgba(255,255,255,.5);font-size:10px;margin-top:2px">Auto-fill the form</div></div>
          </div></div>`,
    },
    {
      title: 'Saved — ready when you are',
      noTap: true,
      note: 'Your saved jobs live in the Job Hub with a match score each.',
      screen: B(`${apphead()}
        <div class="rowc" style="margin:2px 2px 8px"><div class="ttl" style="flex:1">Saved jobs</div><div class="muted">Sort ▾</div></div>
        ${jobCard('Senior .NET Developer', CO.main, 'Berlin · Hybrid', 92, true).replace('card tight','card tight t')}
        ${jobCard('Backend Engineer (C#)', CO.alt, 'Berlin · Remote', 87)}
        ${jobCard('.NET Core Developer', CO.alt2, 'Munich', 81)}`, 'Jobs'),
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// 4 — Cover letter → send to the employer
// ═══════════════════════════════════════════════════════════════════════════
const guide4 = {
  id: '04-send-a-researched-cover-letter',
  title: 'Send a researched cover letter',
  steps: [
    {
      title: 'Open a saved job',
      note: 'Pick the role you want to apply for.',
      screen: B(`${apphead()}
        <div class="rowc" style="margin:2px 2px 8px"><div class="ttl" style="flex:1">Saved jobs</div></div>
        ${jobCard('Senior .NET Developer', CO.main, 'Berlin · Hybrid', 92, true).replace('card tight','card tight t')}
        ${jobCard('Backend Engineer (C#)', CO.alt, 'Berlin · Remote', 87)}`, 'Jobs'),
    },
    {
      title: 'Generate the cover letter',
      note: 'It reads the actual posting and researches the employer first.',
      screen: `<div class="body" style="padding-top:96px">
        <div class="card" style="margin-top:0"><div class="rowc">${av('N', '#06B6D4', '#3B82F6')}
          <div style="flex:1"><div class="ttl">Senior .NET Developer</div><div class="sub2">${CO.main} · Berlin</div></div>
          <div class="badge b">92%</div></div>
          <div style="margin-top:11px"><span class="chip">Full-time</span><span class="chip">Hybrid</span></div></div>
        <div class="card"><div class="ttl">Cover letter</div>
          <div class="sub2" style="margin-top:4px">Written from this posting’s responsibilities and your résumé.</div>
          <div class="btn t" style="margin-top:12px">✨ Generate Cover Letter <span style="opacity:.75;font-size:12px">· 1 credit</span></div></div>`,
    },
    {
      title: 'It researches while it writes',
      noTap: true,
      note: 'Real responsibilities, the real employer — not a template.',
      screen: `<div class="body" style="padding-top:96px">
        <div class="card" style="margin-top:0"><div class="ttl">Writing your letter</div>
          <div style="margin-top:12px" class="bar t"><i style="width:68%"></i></div>
          <div style="margin-top:14px">
            <div class="rowc" style="margin-bottom:9px"><div class="tick">✓</div><div class="sub2" style="margin:0">Reading the job posting</div></div>
            <div class="rowc" style="margin-bottom:9px"><div class="tick">✓</div><div class="sub2" style="margin:0">Matching against your résumé</div></div>
            <div class="rowc" style="margin-bottom:9px"><div class="tick">✓</div><div class="sub2" style="margin:0">Researching ${CO.main}</div></div>
            <div class="rowc"><div class="circle"></div><div class="sub2" style="margin:0;color:#4F8DFF;font-weight:700">Writing the letter…</div></div>
          </div></div>`,
    },
    {
      title: 'Your letter, ready to review',
      noTap: true,
      note: 'Addressed to the real company, referencing the real role.',
      screen: `<div class="body" style="padding-top:96px">
        <div style="background:#fff;border-radius:16px;padding:16px;box-shadow:0 6px 22px rgba(15,23,42,.08)">
          <div style="font-size:11px;color:#8A93B2">${CO.main}</div>
          <div style="font-size:11px;color:#8A93B2">Friedrichstraße 68, 10117 Berlin</div>
          <div style="height:1px;background:#E2E8F0;margin:11px 0"></div>
          <div class="t" style="font-size:12.5px;font-weight:750;color:#0B0F22">Application for Senior .NET Developer</div>
          <div style="font-size:11.5px;color:#334155;line-height:1.55;margin-top:9px">Dear Hiring Team,</div>
          <div style="font-size:11.5px;color:#334155;line-height:1.55;margin-top:7px">
            Your posting calls for someone to build and maintain .NET Core services and design the REST APIs your
            platform runs on. That is the work I have done for the past five years —</div>
          ${[96, 90, 93, 84].map((w) => `<div style="height:5px;border-radius:3px;background:#E8EDF6;margin-top:6px;width:${w}%"></div>`).join('')}
          <div style="margin-top:12px;font-family:'Snell Roundhand','Brush Script MT',cursive;font-size:22px;color:#0B0F22;transform:rotate(-3deg)">${P.name}</div>
        </div>
        <div style="display:flex;gap:9px;margin-top:13px">
          <div class="btn ghost" style="flex:1">Edit</div><div class="btn cy" style="flex:1">Download PDF</div></div>`,
      tip: 'Written from the real posting',
    },
    {
      title: 'Send it to the employer',
      note: 'Résumé and cover letter attached — sent from inside the app.',
      screen: `<div class="body" style="padding-top:96px">
        <div class="card" style="margin-top:0">
          <div class="field"><div class="lb">To</div><div class="vl">careers@${CO.mainDomain}</div></div>
          <div class="field"><div class="lb">Subject</div><div class="vl">Application for Senior .NET Developer</div></div>
          <div class="sec" style="margin:14px 0 7px">Attachments</div>
          <div class="rowc" style="margin-bottom:8px">${av('📄', '#10B981', '#059669')}
            <div style="flex:1"><div class="ttl" style="font-size:13.5px">Résumé · 🇩🇪 Germany</div><div class="sub2">PDF · 1 page</div></div>
            <div class="tick">✓</div></div>
          <div class="rowc">${av('✉️', '#7C6BFF', '#4F8DFF')}
            <div style="flex:1"><div class="ttl" style="font-size:13.5px">Cover letter</div><div class="sub2">PDF · tailored</div></div>
            <div class="tick">✓</div></div>
          <div class="btn gr t" style="margin-top:14px">Send application</div></div>`,
    },
    {
      title: 'Sent — and tracked',
      noTap: true,
      note: 'The job moves to Applied so you can follow it up.',
      screen: B(`${apphead()}
        <div class="card"><div class="rowc">${av('✓', '#10B981', '#059669')}
          <div style="flex:1" class="t"><div class="ttl">Application sent</div><div class="sub2">${CO.main} · just now</div></div>
          <div class="badge g">Applied</div></div></div>
        <div class="sec">Your jobs</div>
        ${jobCard('Senior .NET Developer', CO.main, 'Applied · today', 92, true).replace('✓ Saved', '✓ Applied')}`, 'Jobs'),
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// 5 — Apply on the portal with Auto Fill
// ═══════════════════════════════════════════════════════════════════════════
const portalForm = (filled, skills) => `
  <div style="background:#fff;border-radius:12px;padding:13px">
    <div style="font-size:13px;font-weight:800;color:#0B0F22">Apply — Senior .NET Developer</div>
    <div style="font-size:10.5px;color:#8A93B2;margin-top:2px">${CO.mainDomain}/careers</div>
    <div class="field ${filled ? 'fill' : ''}"><div class="lb">Full name</div><div class="vl">${filled ? P.name : '&nbsp;'}</div></div>
    <div class="field ${filled ? 'fill' : ''}"><div class="lb">Email</div><div class="vl">${filled ? P.email : '&nbsp;'}</div></div>
    <div class="field ${filled ? 'fill' : ''}"><div class="lb">Years of experience</div><div class="vl">${filled ? '5' : '&nbsp;'}</div></div>
    <div class="field ${filled ? 'fill' : ''}"><div class="lb">Current role</div><div class="vl">${filled ? P.role : '&nbsp;'}</div></div>
    <div class="field ${filled ? 'fill' : ''}"><div class="lb">Phone</div><div class="vl">${filled ? P.phone : '&nbsp;'}</div></div>
    <div class="field ${filled ? 'fill' : ''}"><div class="lb">Location</div><div class="vl">${filled ? P.city : '&nbsp;'}</div></div>
    <div class="field ${filled ? 'fill' : ''}"><div class="lb">Notice period</div><div class="vl">${filled ? '1 month' : '&nbsp;'}</div></div>
    <div style="font-size:10px;font-weight:750;color:#8A93B2;letter-spacing:.08em;margin-top:11px;text-transform:uppercase">Your skills</div>
    <div class="${skills ? 't' : ''}" style="margin-top:6px">${skills
      ? ['C#', '.NET Core', 'Azure', 'SQL'].map((s) => `<span class="chip green">✓ ${s}</span>`).join('')
      : ['+ C#', '+ .NET Core', '+ Azure', '+ SQL'].map((s) => `<span class="chip add">${s}</span>`).join('')}</div>
  </div>`;

const robotFab = () => `
  <div style="position:absolute;right:26px;bottom:118px;z-index:30;text-align:center">
    <div class="t" style="width:62px;height:62px;border-radius:31px;background:linear-gradient(135deg,#7C6BFF,#4F8DFF);display:flex;align-items:center;justify-content:center;font-size:26px;box-shadow:0 8px 24px rgba(79,141,255,.45)">🤖</div>
    <div style="margin-top:6px;background:#0B0F22;color:#fff;font-size:10px;font-weight:750;padding:4px 9px;border-radius:9px">Job tools</div>
  </div>`;

const guide5 = {
  id: '05-auto-fill-an-application',
  title: 'Auto-fill an application',
  steps: [
    {
      title: 'Apply on the company’s own site',
      note: 'The portal opens inside the app, with your tools on top.',
      screen: `<div class="body" style="padding-top:96px">
        <div class="card" style="margin-top:0"><div class="rowc">${av('N', '#06B6D4', '#3B82F6')}
          <div style="flex:1"><div class="ttl">Senior .NET Developer</div><div class="sub2">${CO.main}</div></div></div>
          <div class="btn cy t" style="margin-top:13px">Apply on portal →</div></div>`,
    },
    {
      title: 'The form opens — tap the robot',
      note: 'Your job tools travel with you onto any careers site.',
      screen: `<div class="body" style="padding-top:96px">${portalForm(false, false)}</div>${robotFab()}`,
    },
    {
      title: 'Choose Auto Fill',
      note: 'Upload gives you your documents; My details is copy-and-paste.',
      screen: `<div class="body" style="padding-top:96px">${portalForm(false, false)}</div>
        <div style="position:absolute;left:16px;right:16px;bottom:96px;background:#131A32;border-radius:22px;padding:16px;z-index:40;box-shadow:0 -8px 30px rgba(0,0,0,.3)">
          <div style="width:38px;height:4px;border-radius:2px;background:rgba(255,255,255,.22);margin:0 auto 13px"></div>
          <div style="display:flex;gap:9px">
            ${[['🪄', 'Auto Fill', 'Fill this form'], ['📎', 'Upload', 'Résumé & letter'], ['👤', 'My details', 'Copy anything']]
              .map(([i, t, s], k) => `<div class="${k === 0 ? 't' : ''}" style="flex:1;background:rgba(255,255,255,${k === 0 ? '.14' : '.06'});border-radius:16px;padding:13px 9px;text-align:center${k === 0 ? ';border:1.5px solid rgba(79,141,255,.6)' : ''}">
                <div style="font-size:21px">${i}</div>
                <div style="color:#fff;font-size:11.5px;font-weight:750;margin-top:6px">${t}</div>
                <div style="color:rgba(255,255,255,.5);font-size:9.5px;margin-top:2px">${s}</div></div>`).join('')}
          </div></div>`,
    },
    {
      title: 'It fills what it already knows',
      noTap: true,
      note: 'Name, contact, experience — straight from your profile.',
      screen: `<div class="body" style="padding-top:96px">${portalForm(false, false)}</div>
        <div style="position:absolute;left:16px;right:16px;bottom:96px;background:#131A32;border-radius:22px;padding:16px;z-index:40">
          <div style="color:#fff;font-size:13px;font-weight:750;margin-bottom:11px">Auto-filling…</div>
          <div class="t">${[['Scanning the form', 1], ['Matching your profile', 1], ['Filling your details', 0], ['Adding your skills', -1]]
            .map(([t, st]) => `<div class="rowc" style="margin-bottom:9px">
              ${st === 1 ? '<div class="tick">✓</div>' : st === 0 ? '<div class="circle" style="border-color:#4F8DFF"></div>' : '<div class="circle" style="border-color:rgba(255,255,255,.25)"></div>'}
              <div style="font-size:12.5px;color:${st === 1 ? 'rgba(255,255,255,.85)' : st === 0 ? '#7CB0FF' : 'rgba(255,255,255,.4)'};font-weight:${st === 0 ? 700 : 600}">${t}</div></div>`).join('')}</div>
        </div>`,
    },
    {
      title: 'Even the skill chips get added',
      noTap: true,
      note: 'Those “+ skill” buttons most tools can’t touch — tapped for you.',
      screen: `<div class="body" style="padding-top:96px">${portalForm(true, true)}</div>${robotFab()}`,
      tip: 'Skills matched from your résumé',
    },
    {
      title: 'Attach your documents — pick the region here',
      note: 'Swap country format on the spot; the PDF rebuilds instantly.',
      screen: `<div class="body" style="padding-top:96px">${portalForm(true, true)}</div>
        <div style="position:absolute;left:16px;right:16px;bottom:96px;background:#fff;border-radius:22px;padding:16px;z-index:40;box-shadow:0 -8px 30px rgba(15,23,42,.22)">
          <div class="ttl">Attach a file</div>
          <div class="card tight" style="margin-top:10px;border:1.5px solid rgba(79,141,255,.45)">
            <div class="rowc">${av('📄', '#10B981', '#059669')}
              <div style="flex:1"><div class="ttl" style="font-size:13.5px">Résumé</div>
                <div class="sub2 t">Region: <b>🇩🇪 Germany</b> ▾</div></div>
              <div class="badge b">Preview</div></div></div>
          <div class="card tight" style="margin-top:9px">
            <div class="rowc">${av('✉️', '#7C6BFF', '#4F8DFF')}
              <div style="flex:1"><div class="ttl" style="font-size:13.5px">Cover letter</div>
                <div class="sub2">Region: <b>🇩🇪 Germany</b> ▾</div></div>
              <div class="badge b">Preview</div></div></div>
          <div class="btn cy" style="margin-top:12px">Attach both</div>
        </div>`,
    },
    {
      title: 'Submitted',
      noTap: true,
      note: 'The job is marked Applied automatically — no note-keeping needed.',
      screen: `<div class="body" style="padding-top:96px">
        <div class="card" style="margin-top:0"><div class="rowc">${av('✓', '#10B981', '#059669')}
          <div style="flex:1" class="t"><div class="ttl">Application submitted</div><div class="sub2">${CO.main} · just now</div></div></div>
          <div class="sub2" style="margin-top:11px">We detected the submission and marked this job <b>Applied</b>.</div>
          <div style="margin-top:11px"><span class="chip green">✓ Résumé attached</span><span class="chip green">✓ Cover letter attached</span></div>
        </div>`,
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// 6 — Track applications and replies
// ═══════════════════════════════════════════════════════════════════════════
const trackRow = (title, co, when, badge, cls) => `
  <div class="card tight"><div class="rowc">${av(co[0], '#06B6D4', '#3B82F6')}
    <div style="flex:1"><div class="ttl">${title}</div><div class="sub2">${co} · ${when}</div></div>
    <div class="badge ${cls}">${badge}</div></div></div>`;

const guide6 = {
  id: '06-track-applications-and-replies',
  title: 'Track applications and replies',
  steps: [
    {
      title: 'Open My Jobs',
      note: 'Everything you’ve saved, written or sent — in one list.',
      screen: B(`${apphead()}
        <div class="hero"><div class="k">Job Hub</div><h3>My jobs</h3>
          <div class="stats"><div class="st"><div class="v">12</div><div class="l">Saved</div></div>
            <div class="st"><div class="v">7</div><div class="l">Applied</div></div>
            <div class="st"><div class="v">3</div><div class="l">Replies</div></div></div></div>`, 'Jobs', 'Jobs'),
    },
    {
      title: 'Every job carries its status',
      noTap: true,
      note: 'Saved · CL Ready · Applied — updated as you go.',
      screen: B(`${apphead()}
        <div class="rowc" style="margin:2px 2px 8px"><div class="ttl" style="flex:1">My jobs</div><div class="muted">Sort ▾</div></div>
        ${trackRow('Senior .NET Developer', CO.main, 'Applied today', 'Applied', 'g').replace('card tight','card tight t')}
        ${trackRow('Backend Engineer (C#)', CO.alt, 'Letter ready', 'CL Ready', 'b')}
        ${trackRow('.NET Core Developer', CO.alt2, 'Saved 2 days ago', 'Saved', 'a')}
        ${trackRow('Full-stack Engineer', 'Vantage Digital', 'Applied 5 days ago', 'Applied', 'g')}`, 'Jobs'),
      tip: 'Status updates itself when you apply',
    },
    {
      title: 'Sort to see what needs attention',
      note: 'By date added, match score, or how far along it is.',
      screen: B(`${apphead()}
        <div class="rowc" style="margin:2px 2px 8px"><div class="ttl" style="flex:1">My jobs</div><div class="badge b">Sort ▾</div></div>
        <div class="card" style="margin-top:0;padding:8px">
          ${[['Date added — newest first', true], ['Match score', false], ['Status', false], ['Company A–Z', false]]
            .map(([t, on]) => `<div class="rowc ${on ? 't' : ''}" style="padding:9px 7px">${on ? '<div class="tick">✓</div>' : '<div class="circle"></div>'}
              <div class="ttl" style="font-size:13.5px;font-weight:${on ? 750 : 600}">${t}</div></div>`).join('')}
        </div>`, 'Jobs'),
    },
    {
      title: 'Replies find you',
      note: 'When an employer answers, you get a notification.',
      screen: B(`${apphead()}
        <div class="card t" style="border:2px solid rgba(16,185,129,.45)"><div class="rowc">${av('✉️', '#10B981', '#059669')}
          <div style="flex:1"><div class="ttl">New reply</div><div class="sub2">${CO.main} · 2h ago</div></div>
          <div class="badge g">●</div></div>
          <div class="sub2" style="margin-top:10px">“Thanks for applying — we’d like to schedule a first call…”</div></div>
        <div class="sec">Earlier</div>
        ${trackRow('Backend Engineer (C#)', CO.alt, 'Applied 3 days ago', 'Applied', 'g')}`, 'Jobs'),
    },
    {
      title: 'See the whole story per job',
      noTap: true,
      note: 'Saved, letter written, applied, replied — with dates.',
      screen: `<div class="body" style="padding-top:96px">
        <div class="card" style="margin-top:0"><div class="rowc">${av('N', '#06B6D4', '#3B82F6')}
          <div style="flex:1" class="t"><div class="ttl">Senior .NET Developer</div><div class="sub2">${CO.main}</div></div>
          <div class="badge g">Replied</div></div>
          <div class="sec" style="margin:14px 0 9px">Timeline</div>
          ${[['Saved from live search', '5 days ago', 1], ['Cover letter generated', '4 days ago', 1], ['Applied on portal', '2 days ago', 1], ['Employer replied', '2 hours ago', 1], ['Interview scheduled', 'next step', 0]]
            .map(([t, d, on]) => `<div class="rowc" style="margin-bottom:11px">
              ${on ? '<div class="tick">✓</div>' : '<div class="circle"></div>'}
              <div style="flex:1"><div class="ttl" style="font-size:13px">${t}</div><div class="muted">${d}</div></div></div>`).join('')}
        </div>`,
    },
  ],
};

module.exports = [guide1, guide2, guide3, guide4, guide5, guide6];
