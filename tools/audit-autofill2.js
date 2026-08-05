// END-TO-END AUTO FILL AUDIT, v2 — same navigation as audit-autofill.js, but it MEASURES HONESTLY
// and it breaks the score down by WIDGET ARCHETYPE.
//
//   node tools/audit-autofill2.js <jobs.json> [limit]
//   CVF_ENGINE=/path/to/another/job-detail.tsx node tools/audit-autofill2.js <jobs.json>
//
// Why this file exists next to audit-autofill.js rather than replacing it:
//
//   1. THE OLD VERIFIER OVER-COUNTS. It asked, for every wanted value, "does ANY input on this page
//      hold this text — or, if the target was a tick control, is ANY checkbox on the page checked?"
//      The tick branch is not anchored to the field at all: one pre-ticked box anywhere (a marketing
//      opt-in the page ticks for you, a cookie row) scores EVERY radio/checkbox target as a hit.
//      That inflated the 88% baseline, and it inflates the new engine MORE, because the new engine
//      turns N loose radios into one group target. Comparing the two on that verifier would have
//      credited a measurement artefact as a win.
//   2. So the headline here is keyHit: the value is only a hit if the CONTROL THAT OWNS THE KEY
//      carries it. The key is re-derived in the page with the engine's own sig()/grpKey(), so the
//      verifier and the filler agree on identity by construction.
//   3. looseHit is still computed, unchanged, so the old number remains comparable.
//
// CVF_ENGINE lets the SAME harness drive an OLD job-detail.tsx. That is the only controlled way to
// say whether the engine improved: same URLs, same hour, same verifier, two engines.
//
// The two hard rules of audit-autofill.js are inherited verbatim: every submit path is neutralised
// before a single character is typed and the run asserts zero submits afterwards, and the profile is
// invented and matches nobody.
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const REPO = path.join(__dirname, '..');
const ENGINE = process.env.CVF_ENGINE || path.join(REPO, 'MobileApp', 'app', '(ai-hub)', 'job-detail.tsx');
const SRC = fs.readFileSync(ENGINE, 'utf8');
const raw = (n) => { const m = SRC.match(new RegExp('(?:export )?const ' + n + ' = `([\\s\\S]*?)`;\\n')); if (!m) throw new Error('no ' + n); return m[1]; };
const rawFn = (n) => { const m = SRC.match(new RegExp('function ' + n + '\\([^)]*\\)[^{]*\\{[\\s\\S]*?return `([\\s\\S]*?)`;\\s*\\}')); if (!m) throw new Error('no fn ' + n); return m[1]; };
const JS_HELPERS = new Function('JS_HELPERS', 'return `' + raw('JS_HELPERS') + '`;')('');
const READ_FIELDS_JS = new Function('JS_HELPERS', 'return `' + raw('READ_FIELDS_JS') + '`;')(JS_HELPERS);
const FILL_BODY = rawFn('fillJs');
const fillJsFor = (values) => new Function('JS_HELPERS', 'values', 'return `' + FILL_BODY + '`;')(JS_HELPERS, values);

// Entirely invented. Matches nobody.
const PROFILE = {
  full_name: 'Alex Taylor', first_name: 'Alex', last_name: 'Taylor',
  email: 'alex.taylor@example.com', phone: '+31 6 12345678', dial: '+31', national: '612345678',
  country: 'Netherlands', city: 'Amsterdam', address: 'Keizersgracht 1, Amsterdam',
  linkedin: 'https://www.linkedin.com/in/example-alex-taylor',
  portfolio: 'https://example.com/alex-taylor',
  salary: '65000', notice: '1 month', years: '6',
  gender: 'prefer not to say',
};

// Byte-identical to audit-autofill.js's valueFor, so the two harnesses target the same things.
function valueFor(f) {
  const L = String((f.label || '') + ' ' + (f.name || '') + ' ' + (f.placeholder || '')).toLowerCase();
  const opts = Array.isArray(f.options) ? f.options.map(String) : [];
  const pick = (re) => opts.find((o) => re.test(o));
  const t = String(f.type || '').toLowerCase();

  // Demographics are never guessed. Left blank on purpose — see the prompt rules in aiHubController.
  if (/ethnic|race|racial|disab|veteran|pronoun/.test(L)) return null;
  if (/gender|\bsex\b/.test(L)) return pick(/prefer not|decline|not to say/i) || null;

  if (/dial|calling code|phone code|country code/.test(L)) return PROFILE.dial;
  if (/\bcountry\b|country of residence|where.*(based|live)/.test(L)
      && !/citizen|national|birth|tax|passport/.test(L)
      && !(L.length > 45 || /\?|^(are|do|will|have|can|would|is)\b/.test(L.trim()))) {
    return pick(new RegExp('^' + PROFILE.country + '$', 'i')) || PROFILE.country;
  }
  if (/first name|given name|forename/.test(L)) return PROFILE.first_name;
  if (/last name|surname|family name/.test(L)) return PROFILE.last_name;
  if (/full name|your name|^name$|applicant name/.test(L)) return PROFILE.full_name;
  if (/e-?mail/.test(L)) return PROFILE.email;
  if (/phone|mobile|telephone|contact number/.test(L)) return PROFILE.national;
  if (/linkedin/.test(L)) return PROFILE.linkedin;
  if (/github|portfolio|website|personal site/.test(L)) return PROFILE.portfolio;
  if (/city|town|locality/.test(L)) return PROFILE.city;
  if (/address|street/.test(L)) return PROFILE.address;
  if (/salary|compensation|expected pay|rate/.test(L)) return PROFILE.salary;
  if (/notice period|available from|start date/.test(L)) return PROFILE.notice;
  if (/years of experience|how many years/.test(L)) return PROFILE.years;
  if (/consent|i agree|agree to|privacy|gdpr|terms/.test(L)) {
    if (t === 'radio' || t === 'checkbox') return pick(/^yes|i consent|i agree|agree/i) || 'yes';
    return null;
  }
  if (/right to work|eligible to work|work (permit|authoris|authoriz)/.test(L)) return pick(/^yes/i) || 'yes';
  if (/require (visa|sponsor)|need sponsor/.test(L)) return pick(/^no/i) || 'no';
  if (opts.length && /select one|please select|choose/.test(L)) return null;
  return null;
}

// One archetype per scanned field. The engine already labels the hard ones on the field itself
// (widget:'radiogroup'|'checkboxgroup'|'chips'|'combobox'|'repeater'); the rest fall back to the
// control type, so an OLD engine that emits no widget tag still classifies.
function archetypeOf(f) {
  const w = String(f.widget || '');
  if (w === 'radiogroup') return 'radio group';
  if (w === 'checkboxgroup') return 'checkbox group';
  if (w === 'repeater') return 'repeater';
  if (w === 'chips') return 'chip';
  if (w === 'combobox') return 'custom dropdown';
  const t = String(f.type || '').toLowerCase();
  if (t === 'radio') return 'lone radio';
  if (t === 'checkbox') return 'lone checkbox';
  if (t === 'select-one' || t === 'select-multiple' || String(f.tag) === 'select') return 'native select';
  return 'text';
}

// Runs INSIDE the page with the engine's own helpers, so "which control owns this key" is answered
// by the same code that filled it. Anything the helper set does not provide (an older engine has no
// grpKey, no chipTexts) is guarded, never assumed.
const VERIFY_JS = (helpers) => `(function(){
  ${helpers}
  window.__cvfVerify = function(wanted, meta){
    var norm=function(s){return String(s==null?'':s).replace(/\\s+/g,' ').trim().toLowerCase();};
    // A phone box is the one place where "the value we asked for" and "the value the field holds"
    // legitimately differ: the page's own mask rewrites 612345678 as 06 12345678 or 612-345-678,
    // and an intl widget prefixes the dial code. Compare the digits, and accept the wanted number
    // as a SUFFIX of what is there. Anything shorter than 6 digits is not a phone number and is
    // compared as text, so this cannot quietly excuse a wrong short answer.
    var digits=function(s){return String(s==null?'':s).replace(/[^0-9]/g,'');};
    var phoneSame=function(have, want){
      var h=digits(have), w=digits(want);
      return w.length>=6 && h.length>=6 && h.indexOf(w)>=0;
    };
    var els=[]; try{ els=ctrls(); }catch(e){ els=Array.prototype.slice.call(document.querySelectorAll('input,textarea,select')); }
    var hasGrp = (typeof grpKey==='function' && typeof grpType==='function');
    var lbl1=function(el){ try{ return nlbl(el)||el.value||''; }catch(e){ return el.value||''; } };
    var out={};
    Object.keys(wanted).forEach(function(key){
      var want=norm(wanted[key]); var arch=(meta[key]&&meta[key].arch)||'text';
      if(!want){ out[key]={skip:true}; return; }
      var owners=[];
      for(var i=0;i<els.length;i++){
        var el=els[i]; var k1='', k2='';
        try{ k1=sig(el); }catch(e){}
        if(hasGrp){ try{ if(grpType(el)) k2=grpKey(el)||''; }catch(e){} }
        if(k1===key||k2===key) owners.push(el);
      }
      if(!owners.length){ out[key]={hit:false, why:'no control carries this key any more'}; return; }
      var hit=false, why='';
      if(arch==='lone checkbox'){
        // A SINGLE checkbox has no options: the answer "yes" IS the tick and "no" IS the empty box.
        // Requiring the box's label to contain the word "yes" scored every correctly ticked consent
        // box as a miss, which is the verifier being wrong, not the engine.
        var ck=owners.some(function(el){return el.checked;});
        if(/^(yes|true|y|i agree|i consent|agree|agreed|on)$/.test(want)){ hit=ck; why=ck?'':'not ticked'; }
        else if(/^(no|false|n|off)$/.test(want)){ hit=!ck; why=ck?'ticked when the answer is no':''; }
        else { hit=ck&&owners.some(function(el){return el.checked&&norm(lbl1(el)).indexOf(want)>=0;});
               if(!hit) why=ck?'ticked, but the label does not carry the answer':'not ticked'; }
      } else if(arch==='radio group'||arch==='checkbox group'||arch==='lone radio'){
        var checked=owners.filter(function(el){return el.checked;});
        if(!checked.length){ why='nothing ticked'; }
        else {
          // The wanted answer must be the one that is ticked — not merely that SOMETHING is ticked.
          hit=checked.some(function(el){ var t=norm(lbl1(el))+' | '+norm(el.value);
            return t.indexOf(want)>=0 || (want.length>3 && want.indexOf(norm(lbl1(el)))>=0 && norm(lbl1(el)).length>2); });
          if(!hit) why='ticked, but a different option ('+checked.map(function(el){return norm(lbl1(el)).slice(0,24);}).join('/')+')';
        }
      } else if(arch==='chip'){
        var texts=[];
        try{ if(typeof chipTexts==='function') texts=chipTexts(owners[0])||[]; }catch(e){}
        if(!texts.length){ try{ var w0=owners[0].closest('div'); texts=[norm(w0&&w0.innerText)]; }catch(e){} }
        hit=texts.some(function(t){return norm(t).indexOf(want)>=0;}) || norm(owners[0].value).indexOf(want)>=0;
        if(!hit) why='no chip carries it (shows: '+texts.join(',').slice(0,40)+')';
      } else {
        var isPhone=/phone|tel|mobil|telefon/.test(norm((meta[key]&&meta[key].label)||'')) || (owners[0].type||'')==='tel';
        hit=owners.some(function(el){
          var v=norm(el.value);
          if(el.tagName==='SELECT'){ var o=el.options&&el.options[el.selectedIndex]; v=norm(o&&(o.text||o.value)); }
          if(isPhone && phoneSame(v, want)) return true;
          return v.indexOf(want)>=0 || (want.indexOf(v)>=0 && v.length>2);
        });
        if(!hit){
          // A custom dropdown keeps its answer in the widget, not in el.value.
          try{ var w1=owners[0].closest('[class*=select],[class*=Select],[class*=combo],[class*=dropdown]')||owners[0].parentElement;
               if(w1 && norm(w1.innerText).indexOf(want)>=0) hit=true; }catch(e){}
        }
        if(!hit) why='empty or different value ('+norm(owners[0].value).slice(0,24)+')';
      }
      out[key]={hit:hit, why:why};
    });
    return out;
  };
})(); true;`;

async function auditOne(browser, job) {
  const out = { url: job.job_url, employer: job.employer_name, host: (() => { try { return new URL(job.job_url).host.replace(/^www\./, ''); } catch { return '?'; } })() };
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
  });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  let navigations = 0;
  page.on('framenavigated', (fr) => { if (fr === page.mainFrame()) navigations++; });
  try {
    await page.goto(job.job_url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000);
    for (const t of ['Accept all', 'Allow all', 'Accept cookies', 'Godkänn alla', 'Alle akzeptieren', 'Accept']) {
      const b = page.locator(`button:has-text("${t}")`).first();
      if (await b.count().catch(() => 0)) { await b.click({ timeout: 1500 }).catch(() => {}); break; }
    }
    await page.waitForTimeout(1500);
    out.reachedVia = 'direct';
    for (const t of ['Apply for this job', 'Apply now', 'Ansök', 'Jetzt bewerben', 'Postuler', 'Apply']) {
      const b = page.locator(`a:has-text("${t}"), button:has-text("${t}")`).first();
      if (await b.count().catch(() => 0)) {
        await b.click({ timeout: 3000 }).catch(() => {});
        out.reachedVia = 'apply-button';
        break;
      }
    }
    await page.waitForTimeout(5000);

    // ⚠️ Neutralise every submit path BEFORE anything is typed.
    await page.evaluate(() => {
      document.querySelectorAll('form').forEach((f) => { f.addEventListener('submit', (e) => { e.preventDefault(); e.stopPropagation(); window.__cvfSubmits = (window.__cvfSubmits || 0) + 1; }, true); f.onsubmit = (e) => { e.preventDefault(); return false; }; });
      document.querySelectorAll('button[type=submit],input[type=submit]').forEach((b) => { b.setAttribute('type', 'button'); b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); window.__cvfSubmits = (window.__cvfSubmits || 0) + 1; }, true); });
      window.__cvfSubmits = 0;
    });

    const fields = await page.evaluate(async (scanJs) => {
      return await new Promise((resolve) => {
        const got = [];
        window.ReactNativeWebView = { postMessage: (s) => { try { const o = JSON.parse(s); if (o && o.type === 'FIELDS') { got.push(o.fields || []); } } catch (e) {} } };
        try { eval(scanJs); } catch (e) { return resolve({ error: String(e && e.message) }); }
        const t0 = Date.now();
        const poll = () => {
          if (got.length) return resolve(got[got.length - 1]);
          if (Date.now() - t0 > 30000) return resolve([]);
          setTimeout(poll, 400);
        };
        poll();
      });
    }, READ_FIELDS_JS);

    if (fields && fields.error) { out.scanError = fields.error; out.fields = 0; }
    else {
      const list = Array.isArray(fields) ? fields : [];
      out.fields = list.length;
      out.byArch = {};
      list.forEach((f) => { const a = archetypeOf(f); out.byArch[a] = (out.byArch[a] || 0) + 1; });

      const values = {}, meta = {};
      list.forEach((f) => {
        const v = valueFor(f);
        if (v != null && f.key) { values[f.key] = v; meta[f.key] = { arch: archetypeOf(f), label: String(f.label || f.name || '').slice(0, 70) }; }
      });
      out.targeted = Object.keys(values).length;
      out.targetsByArch = {};
      Object.values(meta).forEach((m) => { out.targetsByArch[m.arch] = (out.targetsByArch[m.arch] || 0) + 1; });

      if (out.targeted) {
        const ctrlsBefore = await page.evaluate(() => document.querySelectorAll('input,textarea,select').length);
        await page.evaluate((js) => { try { eval(js); } catch (e) { window.__cvfFillErr = String(e && e.message); } }, fillJsFor(values));
        await page.waitForTimeout(6000);
        out.ctrlsAdded = (await page.evaluate(() => document.querySelectorAll('input,textarea,select').length)) - ctrlsBefore;

        // (a) the OLD, loose verifier — kept verbatim so the 88% baseline stays comparable.
        out.loose = await page.evaluate((wanted) => {
          const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
          let hit = 0, miss = 0;
          const els = Array.from(document.querySelectorAll('input,textarea,select'));
          Object.entries(wanted).forEach(([, want]) => {
            const w = norm(want); if (!w) return;
            const found = els.some((el) => {
              const t = (el.type || '').toLowerCase();
              if (t === 'checkbox' || t === 'radio') return el.checked;
              return norm(el.value).indexOf(w) >= 0 || (w.indexOf(norm(el.value)) >= 0 && norm(el.value).length > 2);
            });
            if (found) hit++; else miss++;
          });
          return { hit, miss };
        }, values);

        // (b) the key-anchored verifier — the honest number.
        await page.evaluate((js) => { try { eval(js); } catch (e) { window.__cvfVerifyErr = String(e && e.message); } }, VERIFY_JS(JS_HELPERS));
        const per = await page.evaluate(({ wanted, m }) => {
          try { return window.__cvfVerify ? window.__cvfVerify(wanted, m) : { __err: window.__cvfVerifyErr || 'verifier missing' }; }
          catch (e) { return { __err: String(e && e.message) }; }
        }, { wanted: values, m: meta });
        out.perField = [];
        out.keyed = { hit: 0, miss: 0 };
        out.archScore = {};
        if (per && per.__err) out.verifyError = per.__err;
        else Object.entries(per).forEach(([k, r]) => {
          if (r.skip) return;
          const a = (meta[k] || {}).arch || 'text';
          out.archScore[a] = out.archScore[a] || { hit: 0, miss: 0 };
          if (r.hit) { out.keyed.hit++; out.archScore[a].hit++; }
          else { out.keyed.miss++; out.archScore[a].miss++; }
          out.perField.push({ arch: a, label: (meta[k] || {}).label, wanted: String(values[k]).slice(0, 30), hit: !!r.hit, why: r.why || '' });
        });
        out.fillErr = await page.evaluate(() => window.__cvfFillErr || null);
      } else { out.loose = { hit: 0, miss: 0 }; out.keyed = { hit: 0, miss: 0 }; out.archScore = {}; out.perField = []; }
    }
    out.submits = await page.evaluate(() => window.__cvfSubmits || 0).catch(() => 0);
    out.navigations = navigations;
    out.ok = true;
  } catch (e) {
    out.error = String(e && e.message).slice(0, 160);
  }
  await ctx.close().catch(() => {});
  return out;
}

(async () => {
  const jobs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const limit = parseInt(process.argv[3], 10) || jobs.length;
  const outPath = process.env.CVF_OUT || '/tmp/audit2_results.json';
  const browser = await chromium.launch();
  const results = [];
  const CONC = 4;
  for (let i = 0; i < Math.min(limit, jobs.length); i += CONC) {
    const batch = jobs.slice(i, i + CONC);
    const got = await Promise.all(batch.map((j) => auditOne(browser, j).catch((e) => ({ url: j.job_url, error: String(e && e.message).slice(0, 120) }))));
    got.forEach((g) => {
      results.push(g);
      console.error(`[${results.length}/${Math.min(limit, jobs.length)}] ${g.host || '?'} fields=${g.fields != null ? g.fields : '-'} keyed=${g.keyed ? g.keyed.hit + '/' + (g.keyed.hit + g.keyed.miss) : '-'} loose=${g.loose ? g.loose.hit + '/' + (g.loose.hit + g.loose.miss) : '-'}${g.error ? ' ERR:' + g.error.slice(0, 50) : ''}`);
    });
    fs.writeFileSync(outPath, JSON.stringify(results, null, 1));
  }
  await browser.close();
  const submits = results.reduce((n, r) => n + (r.submits || 0), 0);
  console.error('TOTAL SUBMITS (must be 0): ' + submits);
  fs.writeFileSync(outPath, JSON.stringify(results, null, 1));
  console.error('wrote ' + outPath);
})().catch((e) => { console.error('AUDIT FAILED:', e.message); process.exit(1); });
