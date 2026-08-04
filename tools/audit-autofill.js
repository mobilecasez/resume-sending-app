// END-TO-END AUTO FILL AUDIT across many real employers.
//
//   node tools/audit-autofill.js /tmp/audit50.json [limit]
//
// For each real job URL: open it, get to the application form, run the ACTUAL shipped scan
// (READ_FIELDS_JS) and the ACTUAL shipped fill (fillJs) from job-detail.tsx, then measure the DOM
// to see what really got set. The output is a per-platform score for how well Auto Fill works.
//
// ⚠️ TWO HARD RULES, because these are strangers' live application forms:
//   1. NEVER SUBMIT. Every submit/button[type=submit] is neutralised before the fill runs, and the
//      audit asserts afterwards that no navigation or submit happened. Filling a form sends nothing;
//      submitting one applies for a job in someone else's name.
//   2. SYNTHETIC DATA ONLY. The profile below is invented. No real user's name, email, phone or
//      address is ever typed into a third party's page.
//
// The scan posts its result asynchronously to window.ReactNativeWebView (that is how the app
// receives it), so this harness installs a capture shim for that bridge rather than expecting a
// return value — without it the scan silently appears to produce nothing.
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const REPO = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(REPO, 'MobileApp', 'app', '(ai-hub)', 'job-detail.tsx'), 'utf8');
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

// Turn a scanned field into a value, by SEMANTICS only — no vendor, no employer, no DOM selectors.
// This stands in for the server's AI mapping so the audit measures the ENGINE's mechanical ability
// to set a field, which is the thing that varies between employers.
function valueFor(f) {
  const L = String((f.label || '') + ' ' + (f.name || '') + ' ' + (f.placeholder || '')).toLowerCase();
  const opts = Array.isArray(f.options) ? f.options.map(String) : [];
  const pick = (re) => opts.find((o) => re.test(o));
  const t = String(f.type || '').toLowerCase();

  // Demographics are never guessed. Left blank on purpose — see the prompt rules in aiHubController.
  if (/ethnic|race|racial|disab|veteran|pronoun/.test(L)) return null;
  if (/gender|\bsex\b/.test(L)) return pick(/prefer not|decline|not to say/i) || null;

  if (/dial|calling code|phone code|country code/.test(L)) return PROFILE.dial;
  // ⚠️ A label is only a COUNTRY field if the word is the label's subject, not a word inside a
  // sentence. "Are you legally authorized to work within the country in which..." is a yes/no
  // question; matching /country/ anywhere in it answered it with "Netherlands". Long labels that
  // read as questions are excluded.
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
  // consent / agreement — answer affirmatively only when the control is an explicit opt-in
  if (/consent|i agree|agree to|privacy|gdpr|terms/.test(L)) {
    if (t === 'radio' || t === 'checkbox') return pick(/^yes|i consent|i agree|agree/i) || 'yes';
    return null;
  }
  if (/right to work|eligible to work|work (permit|authoris|authoriz)/.test(L)) return pick(/^yes/i) || 'yes';
  if (/require (visa|sponsor)|need sponsor/.test(L)) return pick(/^no/i) || 'no';
  if (opts.length && /select one|please select|choose/.test(L)) return null;   // unanswerable without context
  return null;
}

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
    // Reach the form. Many postings put it behind a button or a second page.
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

    // Capture the scan's async bridge post.
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
      out.byType = {};
      list.forEach((f) => { const k = (f.type || f.tag || '?'); out.byType[k] = (out.byType[k] || 0) + 1; });
      out.withOptions = list.filter((f) => Array.isArray(f.options) && f.options.length).length;

      // Build the values map from semantics.
      const values = {};
      let targeted = 0;
      list.forEach((f) => { const v = valueFor(f); if (v != null && f.key) { values[f.key] = v; targeted++; } });
      out.targeted = targeted;

      if (targeted) {
        await page.evaluate((js) => { try { eval(js); } catch (e) { window.__cvfFillErr = String(e && e.message); } }, fillJsFor(values));
        await page.waitForTimeout(6000);
        // Measure what is genuinely set now.
        const labelByKey = {};
        list.forEach((f) => { if (f.key) labelByKey[f.key] = String(f.label || f.name || '').slice(0, 60); });
        out.filled = await page.evaluate(({ wanted, labels }) => {
          const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
          let hit = 0, miss = 0;
          const missed = [];
          const els = Array.from(document.querySelectorAll('input,textarea,select'));
          Object.entries(wanted).forEach(([key, want]) => {
            const w = norm(want);
            if (!w) return;
            const found = els.some((el) => {
              const t = (el.type || '').toLowerCase();
              if (t === 'checkbox' || t === 'radio') return el.checked;
              return norm(el.value).indexOf(w) >= 0 || (w.indexOf(norm(el.value)) >= 0 && norm(el.value).length > 2);
            });
            if (found) hit++;
            else { miss++; missed.push({ label: labels[key] || key, wanted: String(want).slice(0, 40) }); }
          });
          return { hit, miss, missed, fillErr: window.__cvfFillErr || null };
        }, { wanted: values, labels: labelByKey });
      } else out.filled = { hit: 0, miss: 0 };
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
  const jobs = JSON.parse(fs.readFileSync(process.argv[2] || '/tmp/audit50.json', 'utf8'));
  const limit = parseInt(process.argv[3], 10) || jobs.length;
  const browser = await chromium.launch();
  const results = [];
  const CONC = 4;
  for (let i = 0; i < Math.min(limit, jobs.length); i += CONC) {
    const batch = jobs.slice(i, i + CONC);
    const got = await Promise.all(batch.map((j) => auditOne(browser, j).catch((e) => ({ url: j.job_url, error: String(e && e.message).slice(0, 120) }))));
    got.forEach((g) => { results.push(g); console.error(`[${results.length}/${Math.min(limit, jobs.length)}] ${g.host || '?'} fields=${g.fields != null ? g.fields : '-'} filled=${g.filled ? g.filled.hit + '/' + (g.filled.hit + g.filled.miss) : '-'}${g.error ? ' ERR:' + g.error.slice(0, 50) : ''}`); });
    fs.writeFileSync('/tmp/audit_results.json', JSON.stringify(results, null, 1));
  }
  await browser.close();
  console.log(JSON.stringify(results, null, 1));
})().catch((e) => { console.error('AUDIT FAILED:', e.message); process.exit(1); });
