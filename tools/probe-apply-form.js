// GENERIC application-form probe. Works on ANY employer / ATS — nothing in here knows about a
// particular vendor.
//
//   node tools/probe-apply-form.js <url> [--json]
//
// It reports two things side by side:
//   GROUND TRUTH — every control the page really has, by archetype (text / combo / checkbox group /
//                  radio group / file / repeater "add another" button), read straight from the DOM.
//   WHAT WE SEE  — the same page as scanned by the REAL shipped JS_HELPERS from job-detail.tsx.
//
// The gap between the two columns is the engine's actual coverage on that form. Run it across a
// corpus of employers and the gaps that repeat are the ones worth building for; a gap that shows up
// on exactly one site is that site's quirk.
//
// ⚠️ READ-ONLY. It never types, never picks, never clicks a submit. A probe that fills things in
// would be applying for jobs on strangers' postings.
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const REPO = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(REPO, 'MobileApp', 'app', '(ai-hub)', 'job-detail.tsx'), 'utf8');
function raw(name) {
  const m = SRC.match(new RegExp('(?:export )?const ' + name + ' = `([\\s\\S]*?)`;\\n'));
  if (!m) throw new Error('could not extract ' + name);
  return m[1];
}
const JS_HELPERS = new Function('JS_HELPERS', 'return `' + raw('JS_HELPERS') + '`;')('');
const READ_FIELDS_JS = new Function('JS_HELPERS', 'return `' + raw('READ_FIELDS_JS') + '`;')(JS_HELPERS);

const url = process.argv[2];
const asJson = process.argv.includes('--json');
if (!url) { console.error('usage: node tools/probe-apply-form.js <url>'); process.exit(2); }

// Words that identify a control's PURPOSE regardless of who built the page. Used only to classify
// the probe's output — the engine has its own semantics.
const SEMANTIC = [
  ['dial_code', /dial|calling code|phone code|country code|\bisd\b/i],
  ['country', /\bcountry\b|nationality|citizenship|location|where.*(based|live)/i],
  ['phone', /phone|mobile|telephone|contact number/i],
  ['email', /e-?mail/i],
  ['name', /full name|first name|last name|given name|surname|your name/i],
  ['pronouns', /pronoun/i],
  ['gender', /gender|\bsex\b/i],
  ['ethnicity', /ethnic|race|racial|heritage|diversity/i],
  ['disability', /disab|accommodat/i],
  ['veteran', /veteran|military/i],
  ['consent', /consent|i agree|agree to|privacy|gdpr|terms|permission|authorise|authorize/i],
  ['work_auth', /work (permit|authoris|authoriz)|right to work|visa|sponsor|eligible to work/i],
  ['salary', /salary|compensation|expected pay|rate/i],
  ['notice', /notice period|available from|start date/i],
  ['linkedin', /linkedin/i],
  ['portfolio', /github|portfolio|website|personal site/i],
  ['cv', /resume|cv\b|curriculum/i],
  ['cover_letter', /cover letter|motivation/i],
  ['referral', /how did you hear|referral|refer(red)? by|source/i],
  ['experience_years', /years of experience|how many years/i],
];
function semanticOf(label) {
  const s = String(label || '');
  for (const [k, re] of SEMANTIC) if (re.test(s)) return k;
  return null;
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
  });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  const res = { url, ok: false };
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(7000);
    // Consent banners block the form on many EU sites. Dismissing one is not "accepting terms" on
    // the user's behalf — nobody is applying here; it is the only way to see the form at all.
    for (const t of ['Accept all', 'Allow all', 'Accept cookies', 'Accept', 'Godkänn', 'Alle akzeptieren']) {
      const b = page.locator(`button:has-text("${t}")`).first();
      if (await b.count().catch(() => 0)) { await b.click({ timeout: 1500 }).catch(() => {}); break; }
    }
    // Many postings hide the form behind an "Apply" button.
    for (const t of ['Apply for this job', 'Apply now', 'Apply for this position', 'Apply']) {
      const b = page.locator(`a:has-text("${t}"), button:has-text("${t}")`).first();
      if (await b.count().catch(() => 0)) { await b.click({ timeout: 2500 }).catch(() => {}); break; }
    }
    await page.waitForTimeout(5000);

    res.truth = await page.evaluate(() => {
      const vis = (el) => { try { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; } catch { return false; } };
      const txt = (el) => String(el && (el.innerText || el.textContent) || '').replace(/\s+/g, ' ').trim();
      const labelOf = (el) => {
        const bits = [];
        if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) bits.push(txt(l)); }
        const w = el.closest('label'); if (w) bits.push(txt(w));
        for (const a of ['aria-label', 'placeholder', 'name']) if (el.getAttribute(a)) bits.push(el.getAttribute(a));
        let p = el.parentElement, n = 0;
        while (p && n < 4 && !bits.length) { const t = txt(p); if (t && t.length < 120) { bits.push(t); break; } p = p.parentElement; n++; }
        return bits.filter(Boolean).join(' | ').slice(0, 160);
      };
      const out = { text: [], combo: [], select: [], checkbox: [], radio: [], file: [], textarea: [], repeaters: [], groups: {} };
      document.querySelectorAll('input,textarea,select').forEach((el) => {
        const t = (el.type || '').toLowerCase();
        if (t === 'hidden') return;
        if (!vis(el) && t !== 'file') return;
        const label = labelOf(el);
        const rec = { label, value: String(el.value || '').slice(0, 40), required: !!el.required, readOnly: !!el.readOnly };
        if (el.tagName === 'SELECT') { rec.options = Array.from(el.options).length; out.select.push(rec); }
        else if (el.tagName === 'TEXTAREA') out.textarea.push(rec);
        else if (t === 'file') out.file.push(rec);
        else if (t === 'checkbox') out.checkbox.push(rec);
        else if (t === 'radio') { rec.name = el.name || ''; out.radio.push(rec); }
        else if (t === 'button' || el.readOnly) out.combo.push(rec);   // button-shaped / readOnly = a custom picker
        else out.text.push(rec);
      });
      // custom pickers that are not <input> at all
      document.querySelectorAll('[role=combobox],[role=listbox],[aria-haspopup=listbox]').forEach((el) => {
        if (!vis(el)) return;
        out.combo.push({ label: labelOf(el), value: txt(el).slice(0, 40), aria: true });
      });
      // repeaters: a button whose text is an "add another" and that sits inside/next to a field group
      document.querySelectorAll('button,[role=button],a').forEach((el) => {
        if (!vis(el)) return;
        const t = txt(el);
        if (!t || t.length > 40) return;
        if (/^(\+\s*)?(add|add another|add more|add new|another|\+)\b/i.test(t) || /^\+$/.test(t)) {
          out.repeaters.push({ text: t, tag: el.tagName.toLowerCase() });
        }
      });
      // radio/checkbox groups by shared name or shared container
      out.radio.forEach((r) => { const k = r.name || '(unnamed)'; out.groups[k] = (out.groups[k] || 0) + 1; });
      return out;
    });

    // What the SHIPPED engine sees on the same page.
    try {
      const scanned = await page.evaluate(READ_FIELDS_JS);
      const parsed = typeof scanned === 'string' ? JSON.parse(scanned) : scanned;
      const fields = (parsed && (parsed.fields || parsed)) || [];
      res.engine = {
        count: Array.isArray(fields) ? fields.length : 0,
        byType: {},
        withOptions: 0,
        labels: [],
      };
      (Array.isArray(fields) ? fields : []).forEach((f) => {
        const t = (f.type || f.tag || '?');
        res.engine.byType[t] = (res.engine.byType[t] || 0) + 1;
        if (Array.isArray(f.options) && f.options.length) res.engine.withOptions++;
        res.engine.labels.push(String(f.label || f.name || '').slice(0, 60));
      });
    } catch (e) { res.engine = { error: e.message.slice(0, 200) }; }

    // Semantic coverage: which archetypes exist on this form at all.
    const allLabels = []
      .concat(res.truth.text, res.truth.combo, res.truth.select, res.truth.checkbox,
              res.truth.radio, res.truth.file, res.truth.textarea)
      .map((f) => f.label);
    const sem = {};
    allLabels.forEach((l) => { const k = semanticOf(l); if (k) sem[k] = (sem[k] || 0) + 1; });
    res.semantics = sem;
    res.counts = {
      text: res.truth.text.length, combo: res.truth.combo.length, select: res.truth.select.length,
      checkbox: res.truth.checkbox.length, radio: res.truth.radio.length, file: res.truth.file.length,
      textarea: res.truth.textarea.length, repeaters: res.truth.repeaters.length,
      radioGroups: Object.keys(res.truth.groups).length,
    };
    res.ok = true;
  } catch (e) {
    res.error = e.message.slice(0, 300);
  }
  await browser.close();

  if (asJson) { console.log(JSON.stringify(res)); return; }
  console.log('URL:', res.url);
  if (!res.ok) { console.log('FAILED:', res.error); return; }
  console.log('GROUND TRUTH counts:', JSON.stringify(res.counts));
  console.log('SEMANTIC archetypes:', JSON.stringify(res.semantics));
  console.log('ENGINE saw:', JSON.stringify(res.engine && { count: res.engine.count, byType: res.engine.byType, withOptions: res.engine.withOptions, error: res.engine.error }));
  if (res.truth.repeaters.length) console.log('REPEATER buttons:', JSON.stringify(res.truth.repeaters.map((r) => r.text)));
  if (res.truth.combo.length) console.log('COMBOS:', JSON.stringify(res.truth.combo.slice(0, 10).map((c) => c.label.slice(0, 50) + (c.value ? ' =' + c.value : ''))));
  if (res.truth.radio.length) console.log('RADIOS:', JSON.stringify(res.truth.radio.slice(0, 10).map((c) => c.label.slice(0, 45))));
})().catch((e) => { console.error('PROBE ERROR:', e.message); process.exit(1); });
