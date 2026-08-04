// The ACTUAL fields our scan reads off real application forms, sent to the REAL production
// endpoint as a REAL user — not a hand-made toy payload.
//
//   node tools/test-real-payload.js
//
// TWO payloads run, and both matter:
//   LEGACY — the 18 fields the SHIPPED app build sends today, byte-identical to what this file
//            has always sent. The server must keep answering it exactly as it does now: an old
//            app cannot be rebuilt to match a new server, so the new server must fit the old app.
//   NEXT   — the shapes the new scan emits: a radiogroup, a checkboxgroup, a chips input and two
//            repeater regions, taken from the live Revolut / Lever / Workable forms.
//
// The assertions are the point. A value that is not one of the field's OWN options cannot be
// clicked by the device, a repeater that is not an array of rows cannot be typed, and a
// demographic question we answered at all is a bug we must never ship.
require('dotenv').config();
const jwt = require('jsonwebtoken');
const API = process.env.AUTOFILL_TEST_API || 'https://cvapplyr-website-production.up.railway.app';

// ── LEGACY: exactly what the shipped build sends (do not edit — it is the compatibility baseline)
const LEGACY = [
 {key:'f1',tag:'input',type:'text',label:'Full name',placeholder:'Full name'},
 {key:'f2',tag:'input',type:'text',label:'Email',placeholder:'Email'},
 {key:'f3',tag:'input',type:'button',label:'Search phone country codes',options:['+1','+7','+20','+27','+30','+31','+33','+34','+36','+39','+40','+41','+43','+44','+45','+46','+47','+48','+49','+91'],optionsTruncated:true},
 {key:'f4',tag:'input',type:'tel',label:'Phone number',name:'phoneNumber'},
 {key:'f5',tag:'input',type:'button',label:'Current country',options:['Afghanistan','Albania','Algeria','American Samoa','Andorra','India','Netherlands','United Kingdom','United States'],optionsTruncated:true},
 {key:'f6',tag:'input',type:'button',label:'Preferred work locations',options:['Vienna','Munich']},
 {key:'f7',tag:'input',type:'text',label:'Link to your LinkedIn profile (optional)'},
 {key:'f8',tag:'input',type:'text',label:'Links to your Github, portfolio, etc. (optional)'},
 {key:'f9',tag:'input',type:'button',label:'Select gender you identify with (optional)',options:['Male','Female','Non-binary','Prefer not to say','Other']},
 {key:'f10',tag:'input',type:'button',label:'Select ethnicity (optional)',options:['Asian','Black','Hispanic','White','Mixed','Other','Prefer not to say']},
 {key:'f11',tag:'input',type:'button',label:'1. How did you hear about our job posting? (optional) Select one',options:['LinkedIn','Referral','Job board','Company website','Other']},
 {key:'f12',tag:'input',type:'button',label:'2. Have we met at a conference or event? Tell us which one. (optional) Select one',options:['Yes','No']},
 {key:'f13',tag:'input',type:'button',label:'1. Have you previously been employed by Revolut? Select one',options:['Yes','No']},
 {key:'f14',tag:'input',type:'checkbox',label:'He/him'},
 {key:'f15',tag:'input',type:'checkbox',label:'She/her'},
 {key:'f16',tag:'input',type:'checkbox',label:'They/them'},
 {key:'f17',tag:'input',type:'radio',label:'Yes, I consent'},
 {key:'f18',tag:'input',type:'radio',label:"No, I don't consent"},
];

// ── NEXT: the new shapes, with the keys and labels the live scan actually produces
const NEXT = [
 {key:'n:name|text',tag:'input',type:'text',name:'name',label:'Full name',required:true},
 {key:'n:email|email',tag:'input',type:'email',name:'email',label:'Email',required:true},
 // A NAMED radio group (Lever) — key unchanged from the pre-group format on purpose.
 {key:'n:eeo[veteran]|radio',tag:'input',type:'radio',widget:'radiogroup',name:'eeo[veteran]',
  label:'Veteran status',required:false,options:['I am a veteran','I am not a veteran','I decline to answer']},
 // An UNNAMED radio group (Revolut) — the pair that used to arrive as two one-option fields.
 {key:'g:radio|form>div:nth-of-type(7)|do you consent to us keeping your data for 12 months#yes, i consent~no, i don\'t consent',
  tag:'input',type:'radio',widget:'radiogroup',name:'',consent:true,required:false,
  label:'Do you consent to us keeping your personal data on file for 12 months?',
  options:['Yes, I consent',"No, I don't consent"]},
 // A REQUIRED yes/no group behind a visually-hidden native (Workable).
 {key:'g:radio|form>fieldset:nth-of-type(2)|are you legally authorised to work in the netherlands#yes~no',
  tag:'input',type:'radio',widget:'radiogroup',name:'',required:true,
  label:'Are you legally authorised to work in the Netherlands?',options:['Yes','No']},
 {key:'g:radio|form>fieldset:nth-of-type(3)|will you now or in the future require sponsorship#yes~no',
  tag:'input',type:'radio',widget:'radiogroup',name:'',required:true,
  label:'Will you now or in the future require visa sponsorship to work in the Netherlands?',options:['Yes','No']},
 // A checkbox GROUP (Revolut pronouns) — one field, several members, multi.
 {key:'g:checkbox|form>div:nth-of-type(11)|which pronouns do you use#he/him~she/her~they/them',
  tag:'input',type:'checkbox',widget:'checkboxgroup',multi:true,name:'',required:false,
  label:'Which pronouns do you use? (optional)',options:['He/him','She/her','They/them','Prefer not to say']},
 // A checkbox GROUP that is a demographic question — must come back UNANSWERED.
 {key:'n:ethnicity|checkbox',tag:'input',type:'checkbox',widget:'checkboxgroup',multi:true,name:'ethnicity',
  label:'Please select your ethnicity (optional)',options:['Asian','Black','Hispanic','White','Mixed','Prefer not to say']},
 // An OPTIONAL consent group and a REQUIRED consent box.
 {key:'l:i would like to hear about future roles|checkbox',tag:'input',type:'checkbox',consent:true,required:false,
  label:'I would like to hear about future roles at this company'},
 {key:'l:i confirm the information i have provided is true|checkbox',tag:'input',type:'checkbox',consent:true,required:true,
  label:'I confirm the information I have provided is true and complete'},
 // Chip / tag inputs.
 {key:'l:skills|text',tag:'input',type:'text',widget:'chips',multi:true,optionsUnknown:true,label:'Skills'},
 {key:'l:languages you speak|text',tag:'input',type:'text',widget:'chips',multi:true,optionsUnknown:true,label:'Languages you speak'},
 // Repeater regions (Revolut wording, measured).
 {key:'rp:form>div:nth-of-type(14)>button|repeater',tag:'button',type:'repeater',widget:'repeater',multi:true,rowsUnknown:true,name:'',
  label:'Experience (optional) Please highlight your work experience, starting with the most recent'},
 {key:'rp:form>div:nth-of-type(15)>button|repeater',tag:'button',type:'repeater',widget:'repeater',multi:true,rowsUnknown:true,name:'',
  label:'Education (optional) Please enter the name of the universities you attended'},
];

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if (c) { pass++; console.log('    ✓ ' + n); } else { fail++; console.log('    ✗ ' + n + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); } };

async function callServer(uid, fields, label) {
  const token = jwt.sign({ id: uid, email: 'x@y.z' }, process.env.JWT_SECRET);
  const t0 = Date.now();
  const r = await fetch(API + '/api/ai-hub/autofill-map', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields, jobTitle: 'Legal Counsel (Loyalty)', companyName: 'Revolut' }),
  });
  const txt = await r.text();
  let j = null; try { j = JSON.parse(txt); } catch {}
  console.log('\n=== user ' + uid + ' · ' + label + ' — HTTP ' + r.status + ' in ' + (Date.now() - t0) + 'ms ===');
  if (!j) { console.log('  NON-JSON:', txt.slice(0, 300)); return null; }
  if (r.status !== 200) { console.log('  ERROR BODY:', txt.slice(0, 400)); return null; }
  // `skipped` is an ARRAY of {key,label,why} — it stopped being an object when the app started
  // naming the questions we deliberately left blank.
  const skipMap = {};
  for (const s of (Array.isArray(j.skipped) ? j.skipped : [])) skipMap[s.key] = s.why;
  const v = j.values || {};
  for (const f of fields) {
    const got = v[f.key];
    const mark = got !== undefined ? 'FILLED' : (skipMap[f.key] ? 'skip  ' : '  --  ');
    console.log('  ' + mark + '  ' + String(f.label).slice(0, 52).padEnd(54) + (got !== undefined ? JSON.stringify(got).slice(0, 150) : (skipMap[f.key] || '')));
  }
  console.log('  filled ' + Object.keys(v).length + '/' + fields.length);
  return { values: v, skipMap, raw: j };
}

(async () => {
  for (const uid of [11, 1]) {
    // ── LEGACY: an old app build must keep getting an answer it can act on ────────
    const L = await callServer(uid, LEGACY, 'LEGACY payload (what the shipped build sends)');
    if (L) {
      ok('the shipped payload still answers the basics', L.values['f1'] && L.values['f2'], { name: L.values['f1'], email: L.values['f2'] });
      ok('every option-bearing legacy answer is a REAL option of its own field',
        LEGACY.filter((f) => f.options && L.values[f.key] !== undefined)
              .every((f) => f.optionsTruncated || f.options.indexOf(String(L.values[f.key])) >= 0),
        LEGACY.filter((f) => f.options && L.values[f.key] !== undefined && !f.optionsTruncated && f.options.indexOf(String(L.values[f.key])) < 0).map((f) => [f.label, L.values[f.key]]));
      ok('ethnicity is NOT answered', L.values['f10'] === undefined, L.values['f10']);
      ok('no lone checkbox comes back falsy (a "No" would untick the applicant)',
        ['f14', 'f15', 'f16'].every((k) => L.values[k] === undefined || /^(yes|true|on|1|he\/him|she\/her|they\/them)$/i.test(String(L.values[k]))),
        ['f14', 'f15', 'f16'].map((k) => L.values[k]));
      ok('no value is an empty string', Object.keys(L.values).every((k) => String(L.values[k]).trim() !== ''));
    }

    // ── NEXT: the shapes the new scan emits ──────────────────────────────────────
    const N = await callServer(uid, NEXT, 'NEXT payload (groups, chips, repeaters, consent)');
    if (N) {
      const val = (k) => N.values[k];
      const field = (k) => NEXT.find((f) => f.key === k);
      const groups = NEXT.filter((f) => f.widget === 'radiogroup' || f.widget === 'checkboxgroup');
      ok('every GROUP answer is copied verbatim from that group’s own options',
        groups.filter((f) => val(f.key) !== undefined)
              .every((f) => String(val(f.key)).split(/\s*,\s*/).every((p) => f.options.indexOf(p) >= 0)),
        groups.filter((f) => val(f.key) !== undefined).map((f) => [f.label.slice(0, 40), val(f.key)]));
      ok('a radiogroup gets exactly ONE answer',
        NEXT.filter((f) => f.widget === 'radiogroup' && val(f.key) !== undefined)
            .every((f) => String(val(f.key)).indexOf(',') < 0 || f.options.indexOf(String(val(f.key))) >= 0),
        NEXT.filter((f) => f.widget === 'radiogroup').map((f) => val(f.key)));
      // RULE 2 — demographics are never inferred.
      ok('veteran status is left to the applicant', val('n:eeo[veteran]|radio') === undefined, val('n:eeo[veteran]|radio'));
      ok('ethnicity is left to the applicant', val('n:ethnicity|checkbox') === undefined, val('n:ethnicity|checkbox'));
      // RULE 5 — consent is theirs to give.
      ok('the OPTIONAL consent is not ticked for them', val('l:i would like to hear about future roles|checkbox') === undefined, val('l:i would like to hear about future roles|checkbox'));
      ok('and the applicant is TOLD it needs them', N.skipMap['l:i would like to hear about future roles|checkbox'] === 'needs your consent', N.skipMap['l:i would like to hear about future roles|checkbox']);
      ok('the unnamed consent radiogroup is handed back too', val(field('g:radio|form>div:nth-of-type(7)|do you consent to us keeping your data for 12 months#yes, i consent~no, i don\'t consent').key) === undefined || field('g:radio|form>div:nth-of-type(7)|do you consent to us keeping your data for 12 months#yes, i consent~no, i don\'t consent').required === true);
      // Work authorisation. MEASURED: asked alone, the model skips it; asked inside the full
      // payload it answered "Yes" for a real account — an invented statement about someone's
      // immigration status. It may now only carry the applicant's OWN earlier answer, so what
      // this asserts is the property, not a fixed value: whatever comes back must be one of the
      // field's options AND must be reproducible when the same question is asked on its own
      // (a value that appears only in company of other fields is the model improvising).
      for (const wa of NEXT.filter((f) => /authoris|sponsorship/i.test(f.label))) {
        const v = val(wa.key);
        if (v === undefined) { ok('the ' + (/sponsor/i.test(wa.label) ? 'sponsorship' : 'authorisation') + ' question is left to the applicant', N.skipMap[wa.key] === 'needs your judgement', N.skipMap[wa.key]); continue; }
        ok('a work-authorisation answer is one of the field’s options', wa.options.indexOf(String(v)) >= 0, v);
        const alone = await callServer(uid, [wa], 'work-authorisation asked ALONE (is the answer stable?)');
        ok('…and it is the SAME answer when the question is asked alone (so it is theirs, not improvised)',
          alone && alone.values[wa.key] === v, alone && alone.values[wa.key]);
      }
      // Repeaters.
      for (const rp of NEXT.filter((f) => f.widget === 'repeater')) {
        const v = val(rp.key);
        const kind = /education|universit/i.test(rp.label) ? 'education' : 'work';
        if (v === undefined) { console.log('    · ' + kind + ' repeater: not answered (' + (N.skipMap[rp.key] || 'no reason given') + ')'); continue; }
        ok(kind + ' repeater is an ARRAY of row objects', Array.isArray(v) && v.length > 0 && v.every((r) => r && typeof r === 'object' && !Array.isArray(r)), v);
        ok(kind + ' repeater has at most 3 rows', Array.isArray(v) && v.length <= 3, Array.isArray(v) ? v.length : v);
        ok(kind + ' rows hold only plain string cells', Array.isArray(v) && v.every((r) => Object.keys(r).every((c) => typeof r[c] === 'string' && r[c].trim() !== '')), v);
        if (kind === 'education') ok('the education region got SCHOOLS, not employers', v.every((r) => !r.Company), v);
        if (kind === 'work') ok('the work region got EMPLOYERS, not schools', v.every((r) => !r.School), v);
      }
      // Chips.
      const sk = val('l:skills|text');
      if (sk === undefined) console.log('    · skills chips: not answered (' + (N.skipMap['l:skills|text'] || 'no reason given') + ')');
      else {
        ok('skills come back as a comma-separated list', typeof sk === 'string' && sk.indexOf(',') > 0, sk);
        ok('at most 10 chips', String(sk).split(/\s*,\s*/).length <= 10, String(sk).split(/\s*,\s*/).length);
      }
      ok('no value is an empty string', Object.keys(N.values).every((k) => Array.isArray(N.values[k]) || String(N.values[k]).trim() !== ''));
    }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('REQUEST FAILED:', e.message); process.exit(1); });
