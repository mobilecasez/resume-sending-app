// The REAL autofillMap, end to end, with the model and the database stubbed.
//
//   node tools/test-autofill-pipeline.js
//
// tools/test-autofill-postpass.js tests the pure helpers; tools/test-real-payload.js tests
// production. Neither could answer the question that matters most here: what does the server
// send the device when the MODEL CONTRIBUTES NOTHING? Every deterministic guarantee — the phone
// split, the country, the résumé-built repeaters, the chips, the consent hold-back, the
// demographic refusals — has to hold on its own, because the model is the part that fails: it
// times out, it rate-limits, and (measured on production) it answers questions it was told to
// leave alone when the payload gets big.
//
// So each scenario below pins a MODEL REPLY and asserts what reaches the device. The hostile
// scenarios are the point: they are the model doing the exact thing we must never ship.
'use strict';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test@localhost:5432/test';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';

const path = require('path');
const CTRL_DIR = path.join(__dirname, '..', 'server', 'controllers');

// ── Stubs, installed BEFORE the controller is required (it destructures at require time) ──
let MODEL_REPLY = { values: {}, skipped: {} };
const stub = (request, exports) => {
    const p = require.resolve(request, { paths: [CTRL_DIR] });
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('@google/generative-ai', {
    GoogleGenerativeAI: class {
        getGenerativeModel() {
            return { generateContent: async () => ({ response: { text: () => JSON.stringify(MODEL_REPLY) } }) };
        }
    },
});
stub('../services/eventCosts', {
    getEventCost: async () => 0,
    chargeCredits: async () => ({ insufficient: false, cost: 0, remaining: 99 }),
    refundCredits: async () => {},
});

// The database: one profile, one parsed résumé, one builder résumé, and the learned Q&A store.
let DB = {};
const dbConfig = require(path.join(__dirname, '..', 'db-config.js'));
dbConfig.get = async (sql) => {
    if (/FROM users/i.test(sql)) return DB.user;
    if (/resume_metadata/i.test(sql)) return DB.meta;
    if (/user_resumes/i.test(sql)) return DB.builder ? { resume_data: DB.builder } : null;
    return null;
};
dbConfig.query = async (sql) => (/user_job_portal_details/i.test(sql) ? (DB.portalQA || []) : []);

const { autofillMap } = require(path.join(CTRL_DIR, 'aiHubController.js'));

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); } };

async function run(fields, modelReply) {
    MODEL_REPLY = modelReply || { values: {}, skipped: {} };
    let out = null;
    const req = { user: { id: 7 }, body: { fields, jobTitle: 'Analytical Chemist', companyName: 'Revolut' } };
    const res = { json: (j) => { out = j; return j; }, status: () => ({ json: (j) => { out = j; return j; } }) };
    await autofillMap(req, res);
    const skipMap = {};
    for (const s of (Array.isArray(out.skipped) ? out.skipped : [])) skipMap[s.key] = s.why;
    return { v: out.values || {}, why: skipMap };
}

// ── A synthetic candidate. NOT a real user's CV. ──────────────────────────────
// Country is deliberately NULL: that is the shape of the two accounts on production, and it is
// what the phone pass has to survive.
DB = {
    user: {
        full_name: 'Marta Ilves', email: 'marta.ilves@example.com',
        phone_number: '+919970020596', city: null, country: null, address: 'Lambertikirchhof 3',
        date_of_birth: '1990-04-11', nationality: null, gender: 'Female',
    },
    meta: {
        parse_status: 'done',
        skills: ['HPLC', 'Mass Spectrometry', 'GMP', 'Method Validation', 'Titration'],
        soft_skills: ['Reporting'],
        languages: ['English', 'Estonian', 'German'],
        education: [{ institution: 'University of Tartu', degree: 'MSc', field_of_study: 'Analytical Chemistry', end_date: 'June 2014' }],
        experience_years: 9,
        raw_text: 'Analytical chemist. Nordlab OU 2015-2021. Curia Global since 2021.',
    },
    builder: {
        experience: [
            { company: 'Curia Global', role: 'Senior Analytical Chemist', start_date: '2021-03', end_date: 'Present', location: 'Tartu' },
            { company: 'Nordlab OU', role: 'Analytical Chemist', start_date: 'Aug 2015', end_date: '2021-02' },
        ],
        education: [{ institution: 'University of Tartu', degree: 'MSc', field_of_study: 'Analytical Chemistry', end_date: '2014-06' }],
        skills: { technical: ['HPLC', 'Mass Spectrometry', 'GMP'] },
    },
    portalQA: [],
};

// The dial-code control as the shipped scan really reports it (Revolut): a button with a
// TRUNCATED option list, because the real sheet is virtualised.
const DIAL = { key: 'f3', tag: 'input', type: 'button', label: 'Search phone country codes', optionsTruncated: true,
    options: ['+1', '+7', '+20', '+27', '+30', '+31', '+33', '+34', '+36', '+39', '+40', '+41', '+43', '+44', '+45', '+46', '+47', '+48', '+49', '+91'] };
const PHONE = { key: 'f4', tag: 'input', type: 'tel', label: 'Phone number', name: 'phoneNumber' };
const COUNTRY = { key: 'f5', tag: 'select', type: 'select', label: 'Country', name: 'country', options: ['Estonia', 'India', 'Netherlands'] };

(async () => {
    console.log('\nthe model contributes NOTHING — every deterministic guarantee still has to hold');
    {
        const r = await run([DIAL, PHONE, COUNTRY,
            { key: 'l:skills|text', tag: 'input', type: 'text', widget: 'chips', multi: true, optionsUnknown: true, label: 'Skills' },
            { key: 'l:languages you speak|text', tag: 'input', type: 'text', widget: 'chips', multi: true, optionsUnknown: true, label: 'Languages you speak' },
            { key: 'rp:form>div:nth-of-type(14)>button|repeater', tag: 'button', type: 'repeater', widget: 'repeater', multi: true, rowsUnknown: true,
              label: 'Experience (optional) Please highlight your work experience, starting with the most recent' },
            { key: 'rp:form>div:nth-of-type(15)>button|repeater', tag: 'button', type: 'repeater', widget: 'repeater', multi: true, rowsUnknown: true,
              label: 'Education (optional) Please enter the name of the universities you attended' },
        ], { values: {}, skipped: {} });
        ok('the dial code is filled from the number itself, with NO country on the profile', r.v.f3 === '+91', { f3: r.v.f3, why: r.why.f3 });
        ok('and the number half carries no dial code', r.v.f4 === '9970020596', r.v.f4);
        ok('skills chips come from the résumé', typeof r.v['l:skills|text'] === 'string' && /HPLC/.test(r.v['l:skills|text']), r.v['l:skills|text']);
        ok('spoken languages are the languages, not the skills', /Estonian/.test(String(r.v['l:languages you speak|text'])) && !/HPLC/.test(String(r.v['l:languages you speak|text'])), r.v['l:languages you speak|text']);
        const work = r.v['rp:form>div:nth-of-type(14)>button|repeater'];
        const edu = r.v['rp:form>div:nth-of-type(15)>button|repeater'];
        ok('the work repeater is built from the résumé, newest first', Array.isArray(work) && work[0] && work[0].Company === 'Curia Global', work);
        ok('its dates are normalised', Array.isArray(work) && work[1] && work[1]['Start date'] === '2015-08', work && work[1]);
        ok('the education repeater got the school, not the employer', Array.isArray(edu) && edu[0] && /Tartu/.test(edu[0].School) && !edu[0].Company, edu);
        ok('every repeater cell is a plain string', [work, edu].every((rows) => Array.isArray(rows) && rows.every((row) => Object.values(row).every((c) => typeof c === 'string' && c.trim() !== ''))), { work, edu });
    }

    console.log('\nthe model answers a demographic question anyway — the server must not pass it on');
    {
        const F = [
            { key: 'n:ethnicity|checkbox', tag: 'input', type: 'checkbox', widget: 'checkboxgroup', multi: true, name: 'ethnicity',
              label: 'Please select your ethnicity (optional)', options: ['Asian', 'Black', 'Hispanic', 'White', 'Mixed', 'Prefer not to say'] },
            { key: 'n:eeo[veteran]|radio', tag: 'input', type: 'radio', widget: 'radiogroup', name: 'eeo[veteran]',
              label: 'Veteran status', options: ['I am a veteran', 'I am not a veteran', 'I decline to answer'] },
            { key: 'n:eeo[disability]|radio', tag: 'input', type: 'radio', widget: 'radiogroup', name: 'eeo[disability]',
              label: 'Do you have a disability, or have you ever had one?', options: ['Yes', 'No', 'I do not wish to answer'] },
            { key: 'g:radio|form>fieldset:nth-of-type(4)|what is your race#white~asian~other', tag: 'input', type: 'radio', widget: 'radiogroup',
              label: 'What is your race?', options: ['White', 'Asian', 'Other'] },
            { key: 'n:gender|radio', tag: 'input', type: 'radio', widget: 'radiogroup', name: 'gender',
              label: 'Gender', options: ['Male', 'Female', 'Non-binary', 'Prefer not to say'] },
            { key: 'g:checkbox|form>div:nth-of-type(11)|which pronouns do you use#he/him~she/her~they/them', tag: 'input', type: 'checkbox',
              widget: 'checkboxgroup', multi: true, label: 'Which pronouns do you use? (optional)', options: ['He/him', 'She/her', 'They/them', 'Prefer not to say'] },
        ];
        // The hostile reply: the model guessing every one of them from a European name.
        const r = await run(F, { values: {
            'n:ethnicity|checkbox': 'White',
            'n:eeo[veteran]|radio': 'I am not a veteran',
            'n:eeo[disability]|radio': 'No',
            'g:radio|form>fieldset:nth-of-type(4)|what is your race#white~asian~other': 'White',
            'n:gender|radio': 'Female',
            'g:checkbox|form>div:nth-of-type(11)|which pronouns do you use#he/him~she/her~they/them': 'She/her',
        }, skipped: {} });
        ok('ethnicity is dropped', r.v['n:ethnicity|checkbox'] === undefined, r.v['n:ethnicity|checkbox']);
        ok('veteran status is dropped', r.v['n:eeo[veteran]|radio'] === undefined, r.v['n:eeo[veteran]|radio']);
        ok('disability is dropped', r.v['n:eeo[disability]|radio'] === undefined, r.v['n:eeo[disability]|radio']);
        ok('race is dropped', r.v['g:radio|form>fieldset:nth-of-type(4)|what is your race#white~asian~other'] === undefined, r.v['g:radio|form>fieldset:nth-of-type(4)|what is your race#white~asian~other']);
        ok('and each one is handed back to the applicant by name', ['n:ethnicity|checkbox', 'n:eeo[veteran]|radio', 'n:eeo[disability]|radio'].every((k) => r.why[k]), r.why);
        // Gender is the ONE demographic with an explicit profile column. It stays — from the
        // profile value, snapped to an option the page really offers.
        ok('gender survives, because the profile states it', r.v['n:gender|radio'] === 'Female', r.v['n:gender|radio']);
        ok('pronouns survive for the same reason', r.v['g:checkbox|form>div:nth-of-type(11)|which pronouns do you use#he/him~she/her~they/them'] === 'She/her', r.v['g:checkbox|form>div:nth-of-type(11)|which pronouns do you use#he/him~she/her~they/them']);
    }

    console.log('\n…and with NO gender on the profile, gender is nobody‘s to answer');
    {
        const saved = DB.user.gender;
        DB.user = { ...DB.user, gender: null };
        const F = [{ key: 'n:gender|radio', tag: 'input', type: 'radio', widget: 'radiogroup', name: 'gender', label: 'Gender', options: ['Male', 'Female', 'Prefer not to say'] },
                   { key: 'g:checkbox|x|which pronouns do you use#he/him~she/her', tag: 'input', type: 'checkbox', widget: 'checkboxgroup', multi: true, label: 'Which pronouns do you use?', options: ['He/him', 'She/her', 'They/them'] }];
        const r = await run(F, { values: { 'n:gender|radio': 'Female', 'g:checkbox|x|which pronouns do you use#he/him~she/her': 'She/her' }, skipped: {} });
        ok('gender guessed from the name is dropped', r.v['n:gender|radio'] === undefined, r.v['n:gender|radio']);
        ok('pronouns guessed from the name are dropped', r.v['g:checkbox|x|which pronouns do you use#he/him~she/her'] === undefined, r.v['g:checkbox|x|which pronouns do you use#he/him~she/her']);
        DB.user = { ...DB.user, gender: saved };
    }

    console.log('\nconsent stays the applicant’s to give, and the new shapes carry it too');
    {
        const F = [
            { key: 'g:radio|form>div:nth-of-type(7)|do you consent#yes, i consent~no, i don\'t consent', tag: 'input', type: 'radio', widget: 'radiogroup', consent: true, required: false,
              label: 'Do you consent to us keeping your personal data on file for 12 months?', options: ['Yes, I consent', "No, I don't consent"] },
            { key: 'l:i confirm the information is true|checkbox', tag: 'input', type: 'checkbox', consent: true, required: true,
              label: 'I confirm the information I have provided is true and complete' },
        ];
        const r = await run(F, { values: {
            'g:radio|form>div:nth-of-type(7)|do you consent#yes, i consent~no, i don\'t consent': 'Yes, I consent',
            'l:i confirm the information is true|checkbox': 'yes',
        }, skipped: {} });
        ok('an OPTIONAL consent group is handed back, not agreed to for them', r.v['g:radio|form>div:nth-of-type(7)|do you consent#yes, i consent~no, i don\'t consent'] === undefined, r.v['g:radio|form>div:nth-of-type(7)|do you consent#yes, i consent~no, i don\'t consent']);
        ok('…with a reason the applicant can read', r.why['g:radio|form>div:nth-of-type(7)|do you consent#yes, i consent~no, i don\'t consent'] === 'needs your consent', r.why);
        ok('a REQUIRED consent keeps its answer (the form cannot be sent without it)', r.v['l:i confirm the information is true|checkbox'] === 'yes', r.v['l:i confirm the information is true|checkbox']);
    }

    console.log('\nwork authorisation is the applicant’s own answer or nobody’s');
    {
        const F = [{ key: 'g:radio|form>fieldset:nth-of-type(2)|sponsorship#yes~no', tag: 'input', type: 'radio', widget: 'radiogroup', required: true,
            label: 'Will you now or in the future require visa sponsorship to work in the Netherlands?', options: ['Yes', 'No'] }];
        const r = await run(F, { values: { 'g:radio|form>fieldset:nth-of-type(2)|sponsorship#yes~no': 'No' }, skipped: {} });
        ok('an invented immigration answer is dropped', r.v['g:radio|form>fieldset:nth-of-type(2)|sponsorship#yes~no'] === undefined, r.v['g:radio|form>fieldset:nth-of-type(2)|sponsorship#yes~no']);
        ok('…and the applicant is told it is theirs', r.why['g:radio|form>fieldset:nth-of-type(2)|sponsorship#yes~no'] === 'needs your judgement', r.why);
        DB.portalQA = [{ q_key: 'willyounoworinthefuturerequirevisasponsorshiptoworkinthenetherlands', question: 'Will you now or in the future require visa sponsorship to work in the Netherlands?', answer: 'No' }];
        const r2 = await run(F, { values: {}, skipped: {} });
        ok('their OWN earlier answer to the same question does replay', r2.v['g:radio|form>fieldset:nth-of-type(2)|sponsorship#yes~no'] === 'No', r2.v['g:radio|form>fieldset:nth-of-type(2)|sponsorship#yes~no']);
        DB.portalQA = [];
    }

    // ⚠️ THE COMBINED WORDING IS THE COMMON ONE on Greenhouse and Lever, and it used to walk
    // straight through the guard: two topics match, so workAuthTopic() answers null, and the guard
    // read that as "not a work-authorisation question" and kept whatever the model had said.
    console.log('\nthe question that asks BOTH halves at once is guarded too');
    {
        const K = 'n:eeo[auth]|radio';
        const F = [{ key: K, tag: 'input', type: 'radio', widget: 'radiogroup', name: 'eeo[auth]', required: true,
            label: 'Are you legally authorized to work in the United States, and will you now or in the future require visa sponsorship for employment?',
            options: ['Yes', 'No'] }];
        const r = await run(F, { values: { [K]: 'Yes' }, skipped: {} });
        ok('the model\'s answer to the combined question is dropped', r.v[K] === undefined, r.v[K]);
        ok('…and it is handed back to the applicant', r.why[K] === 'needs your judgement', r.why);
        // …and NOTHING may be replayed onto it either: the two halves have opposite answers, so an
        // earlier "No" to a sponsorship question says nothing about the authorisation half.
        DB.portalQA = [{ q_key: 'x', question: 'Will you now or in the future require visa sponsorship for employment?', answer: 'No' }];
        const r3 = await run(F, { values: {}, skipped: {} });
        ok('an earlier answer to ONE half is never replayed onto the combined question', r3.v[K] === undefined, r3.v[K]);
        DB.portalQA = [];
    }

    console.log('\nBACKWARD COMPATIBILITY — the payload the SHIPPED build sends, which carries none of the new flags');
    {
        const LEGACY = [DIAL, PHONE, COUNTRY,
            { key: 'f14', tag: 'input', type: 'checkbox', label: 'He/him' },
            { key: 'f15', tag: 'input', type: 'checkbox', label: 'She/her' },
            { key: 'f10', tag: 'input', type: 'button', label: 'Select ethnicity (optional)', options: ['Asian', 'White', 'Prefer not to say'] },
            { key: 'f13', tag: 'input', type: 'button', label: '1. Have you previously been employed by Revolut? Select one', options: ['Yes', 'No'] },
        ];
        // The model guesses BOTH pronoun boxes from the name. Only the one matching the profile's
        // own stated gender may survive.
        const r = await run(LEGACY, { values: { f13: 'No', f14: 'He/him', f15: 'She/her', f10: 'White' }, skipped: {} });
        ok('the old payload still gets its dial code', r.v.f3 === '+91', r.v.f3);
        // Nothing on this profile states a country, so it is resolved from the dial code of the
        // candidate's own number — and snapped to the field's own spelling.
        ok('the old payload still gets a country, resolved from their own number', r.v.f5 === 'India', r.v.f5);
        ok('the pronoun box matching the stated gender is ticked', r.v.f15 === 'She/her', r.v.f15);
        ok('…and the one contradicting it is refused, not ticked', r.v.f14 === undefined, r.v.f14);
        ok('the old-shape ethnicity control is refused too', r.v.f10 === undefined, r.v.f10);
        ok('an ordinary question is still answered', r.v.f13 === 'No', r.v.f13);
        ok('no value is empty', Object.keys(r.v).every((k) => Array.isArray(r.v[k]) || String(r.v[k]).trim() !== ''), r.v);
    }

    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS FAILED:', e); process.exit(1); });
