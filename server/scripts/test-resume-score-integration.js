// INTEGRATION test — needs a local Postgres (DATABASE_URL from .env). The pure unit assertions
// live in test-resume-score.js and run anywhere; this one exercises the real database path:
// upsert, fingerprint caching, version history, refusal handling, cascade delete.
//
// The Claude transport is stubbed so the suite costs nothing and is deterministic — but the REQUEST
// it builds is asserted field by field, because that request is the part no unit test can see and
// the part that breaks silently when a model or parameter changes.
//
//   node server/scripts/test-resume-score-integration.js
//
require('dotenv').config();
// Stub ONLY the transport. Prompt build, schema, refusal handling, normalise, fingerprint, upsert,
// history, latestFor, mark and cascade are all the real production path.
const sdkPath = require.resolve('@google/generative-ai');
let lastReq = null, lastCfg = null, calls = 0, nextScore = 58, mode = 'ok';
require.cache[sdkPath] = { id: sdkPath, filename: sdkPath, loaded: true, exports: {
  GoogleGenerativeAI: class {
    constructor(key) { this.key = key; }
    getGenerativeModel(cfg) {
      lastCfg = cfg;
      return { generateContent: async (prompt) => {
        lastReq = prompt; calls++;
        if (mode === 'truncated') return { response: { candidates: [{ finishReason: 'MAX_TOKENS' }], text: () => '{"score":' } };
        if (mode === 'garbage') return { response: { candidates: [{ finishReason: 'STOP' }], text: () => 'I think it is quite good!' } };
        return { response: { candidates: [{ finishReason: 'STOP' }], text: () => JSON.stringify({
          score: nextScore,
          subscores: { impact: nextScore - 12, clarity: nextScore + 6, keywords: nextScore - 4, completeness: nextScore + 9 },
          headline: 'Your achievements read as duties, not results',
          summary: 'Solid experience, but almost nothing is quantified. Add numbers and this lifts fast.',
          improvements: [
            { title: 'Quantify your top 5 bullets', detail: 'Add a number to each — team size, %, revenue, time saved.' },
            { title: 'Lead with the outcome', detail: 'Start each bullet with what changed, not what you were assigned.' },
            { title: 'Add a certifications section', detail: 'List credentials a recruiter would filter on.' },
          ],
        }) } };
      } };
    }
  },
} };
process.env.GEMINI_API_KEY = 'stub-key';

const db = require('../../db-config'); db.initializeConnection();
const scorer = require('../services/resumeScorer');
const notifSwitch = require('../services/notifSwitch');
const RESUME = 'RAJESH KUMAR\nBackend Developer, TechCorp Pune 2022-Present\n- Responsible for maintaining the payments API\n- Worked on bug fixes and code reviews\nEDUCATION B.E. Computer Engineering, Pune University 2021\nSKILLS Java, Spring Boot, MySQL, Git';

(async () => {
  let ok = 0, bad = 0;
  const t = (n, c, x) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (x !== undefined ? ' → ' + x : '')); } };

  await db.query(`DELETE FROM users WHERE email='e2e-resume-score@test.local'`);
  const uid = (await db.query(`INSERT INTO users (email,password,full_name) VALUES ($1,'x','Rajesh Kumar') RETURNING id`, ['e2e-resume-score@test.local']))[0].id;
  await db.query(`INSERT INTO resume_metadata (user_id,parse_status,full_text) VALUES ($1,'done',$2)
                  ON CONFLICT (user_id) DO UPDATE SET full_text=EXCLUDED.full_text, parse_status='done'`, [uid, RESUME]);

  console.log('── switch OFF is still a hard stop ──');
  t('scoreOne refuses', (await scorer.scoreOne(uid)).reason === 'switch_off');
  t('zero API calls made', calls === 0, calls);
  await notifSwitch.set('resume_score', true);

  console.log('\n── the request we actually send to Claude ──');
  const r = await scorer.scoreOne(uid);
  t('scored', r.ok && r.reason === 'scored', r.reason);
  t('model is gemini-2.5-flash', lastCfg.model === 'gemini-2.5-flash', lastCfg.model);
  t('JSON mime type set', lastCfg.generationConfig.responseMimeType === 'application/json');
  t('schema travels with the request', !!lastCfg.generationConfig.responseSchema.properties.score);
  t('exactly-3 enforced by the schema, not the prompt', lastCfg.generationConfig.responseSchema.properties.improvements.minItems === 3);
  t('system instruction carries the calibration', /calibrated|CALIBRATED/i.test(lastCfg.systemInstruction));
  t('maxOutputTokens leaves room for thinking', lastCfg.generationConfig.maxOutputTokens >= 8192, lastCfg.generationConfig.maxOutputTokens);
  t('résumé text reaches the model', lastReq.includes('RAJESH KUMAR'));
  t('prompt no longer restates the JSON shape', !/"improvements"\s*:\s*\[/.test(lastReq));

  console.log('\n── response parsing ──');
  t('response parsed', r.row.score === 58, r.row && r.row.score);
  t('band derived', r.row.band === 'Decent', r.row && r.row.band);
  const imp = typeof r.row.improvements === 'string' ? JSON.parse(r.row.improvements) : r.row.improvements;
  t('3 improvements stored', imp.length === 3, imp.length);

  console.log('\n── failure modes must not write a row or crash ──');
  const before = (await db.query('SELECT COUNT(*)::int n FROM resume_scores WHERE user_id=$1',[uid]))[0].n;
  mode = 'truncated';
  const ref = await scorer.scoreOne(uid, { force: true });
  t('a token-truncated response degrades to ai_failed', ref.ok === false && ref.reason === 'ai_failed', ref.reason);
  mode = 'garbage';
  const nt = await scorer.scoreOne(uid, { force: true });
  t('non-JSON prose degrades to ai_failed', nt.ok === false && nt.reason === 'ai_failed', nt.reason);
  t('no row written by either failure', (await db.query('SELECT COUNT(*)::int n FROM resume_scores WHERE user_id=$1',[uid]))[0].n === before);
  t('the previous good score still stands', (await scorer.latestFor(uid)).score.score === 58);
  mode = 'ok';

  console.log('\n── fingerprint still makes a re-score free ──');
  const c0 = calls; const again = await scorer.scoreOne(uid);
  t('cached', again.reason === 'cached', again.reason);
  t('no API call', calls === c0, calls - c0);

  console.log('\n── edit → new version → history + delta ──');
  await db.query(`UPDATE resume_metadata SET full_text=$2 WHERE user_id=$1`, [uid, RESUME + '\nCERT: AWS SAA 2024\n- Cut p99 840ms->210ms']);
  nextScore = 79; await scorer.scoreOne(uid);
  const L = await scorer.latestFor(uid);
  t('two rows', (await db.query('SELECT COUNT(*)::int n FROM resume_scores WHERE user_id=$1',[uid]))[0].n === 2);
  t('previousScore drives the delta chip', L.score.previousScore === 58, L.score.previousScore);
  t('model recorded on the row', /gemini/.test((await db.query('SELECT model FROM resume_scores WHERE user_id=$1 ORDER BY id DESC LIMIT 1',[uid]))[0].model));

  console.log('\n── missing key must be a clean, nameable failure ──');
  const saved = process.env.GEMINI_API_KEY; delete process.env.GEMINI_API_KEY;
  delete require.cache[require.resolve('../services/resumeScorer')];
  const fresh = require('../services/resumeScorer');
  await db.query(`UPDATE resume_metadata SET full_text=$2 WHERE user_id=$1`, [uid, RESUME + '\nANOTHER EDIT']);
  const nokey = await fresh.scoreOne(uid);
  t('no key → ai_failed, not a crash', nokey.ok === false && nokey.reason === 'ai_failed', nokey.reason);
  process.env.GEMINI_API_KEY = saved;

  await notifSwitch.set('resume_score', false);
  t('switch left OFF', (await notifSwitch.isOn('resume_score')) === false);
  await db.query(`DELETE FROM users WHERE id=$1`, [uid]);

  console.log(`\nresume score integration: ${ok} passed, ${bad} failed  (API calls: ${calls})`);
  await db.close(); process.exit(bad ? 1 : 0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
