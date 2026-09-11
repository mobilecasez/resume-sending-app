// Résumé scoring — ADDITIVE, ISOLATED. Scores each user's résumé in the background so Home can
// open with "your résumé scores 61, and here is what is holding it back".
//
// WHY THIS EXISTS: 42 of 50 real installs never upload a résumé, and of the ones who do, almost
// none ever learn whether it is any good. A score is the cheapest honest reason to come back —
// and the natural hand-off into the résumé builder, which is the thing that actually helps them.
//
// COST DISCIPLINE — this spends money, so three guards, all of them load-bearing:
//   1. the admin switch 'resume_score' must be ON (Migration 041 seeds the row FALSE, and
//      notifSwitch is FAIL-CLOSED: if the table cannot be read, the answer is "no")
//   2. a fingerprint of the exact scored text is UNIQUE per user — re-running the sweep over an
//      unchanged résumé costs NOTHING, while an edited résumé produces a new score to compare
//   3. a per-run cap and a 24h platform-wide cap
'use strict';

const crypto = require('crypto');
const dbConfig = require('../../db-config');

const MODEL = process.env.RESUME_SCORE_MODEL || 'gemini-2.5-flash';
const DAILY_CAP = parseInt(process.env.RESUME_SCORE_DAILY_CAP || '200', 10);
const RUN_CAP = parseInt(process.env.RESUME_SCORE_RUN_CAP || '25', 10);
const SWEEP_MIN = parseFloat(process.env.RESUME_SCORE_SWEEP_MIN || '60');

const clampInt = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const str = (v, n) => (v == null ? null : String(v).replace(/\s+/g, ' ').trim().slice(0, n) || null);

function bandFor(score) {
  if (score >= 85) return 'Excellent';
  if (score >= 70) return 'Strong';
  if (score >= 55) return 'Decent';
  if (score >= 40) return 'Needs work';
  return 'Weak';
}

// ── What we actually score ───────────────────────────────────────────────────────────────────
// Two possible sources, and the BUILDER one wins when both exist: it is the résumé the user most
// recently curated, and it is already structured, so no file parsing is involved. The uploaded
// résumé's parsed `full_text` is the fallback.
async function resumeContentFor(userId) {
  try {
    const built = await dbConfig.get('SELECT resume_data FROM user_resumes WHERE user_id = ?', [userId]);
    if (built && built.resume_data) {
      const rd = typeof built.resume_data === 'string' ? JSON.parse(built.resume_data) : built.resume_data;
      const text = JSON.stringify(rd);
      if (text && text.length > 120) return { text: text.slice(0, 24000), source: 'builder' };
    }
  } catch (e) { console.warn('[resumeScore] builder read failed:', e.message); }
  return uploadContentFor(userId);
}

/**
 * A read failure a `strict` caller must hear about, as opposed to "there is nothing there".
 * ⚠️ An absent table or column (42P01 / 42703 — user_resumes is created lazily, tailored_for by a
 * swallowed ALTER) IS "nothing there": reporting it as an outage would 5xx every user for ever.
 */
const isMissingSchema = (e) => !!e && (e.code === '42P01' || e.code === '42703');
const rethrowIfStrict = (strict, e) => { if (strict && !isMissingSchema(e)) throw e; };

/** The uploaded résumé alone, as { text, source: 'upload' } or null. `strict` rethrows a DB failure. */
async function uploadContentFor(userId, { strict = false } = {}) {
  try {
    // ⚠️ SELECT *, not a column list. database/postgres-schema.sql describes a resume_metadata with
    // `full_text`; PRODUCTION has no such column — it has raw_text plus structured skills /
    // technical_skills / education / certifications / job_titles / industries. Naming columns made
    // every uploaded résumé throw "column full_text does not exist" and silently skip, which is 95
    // of the 103 people waiting for a score. Reading the whole row and serialising whatever is
    // there works against both shapes and cannot break again when the parser adds a field.
    const meta = await dbConfig.get("SELECT * FROM resume_metadata WHERE user_id = ? AND parse_status = 'done'", [userId]);
    if (meta) {
      const { id, user_id, parse_status, parse_error, parsed_at, created_at, updated_at, ...rest } = meta;
      const parts = [];
      for (const [k, v] of Object.entries(rest)) {
        if (v == null || v === '') continue;
        const val = (typeof v === 'string') ? v
          : (Array.isArray(v) ? v.filter(Boolean).join(', ') : JSON.stringify(v));
        if (!val || val === '[]' || val === '{}') continue;
        parts.push(`${k.replace(/_/g, ' ').toUpperCase()}: ${val}`);
      }
      const text = parts.join('\n\n');
      if (text.trim().length > 120) return { text: text.slice(0, 24000), source: 'upload' };
    }
  } catch (e) { console.warn('[resumeScore] metadata read failed:', e.message); rethrowIfStrict(strict, e); }
  return null;
}

const fingerprintOf = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');

// ── "Pull my résumé" ─────────────────────────────────────────────────────────────────────────
// What the builder prefills its free-text box with when the user arrives from the score popup.
//
// This is NOT the same string we score. Scoring feeds the model raw JSON, which is fine for a
// machine and unreadable for a person — dropping that into a text box the user is being asked to
// EDIT would be hostile. So a builder résumé is flattened back into plain prose here, and an
// uploaded résumé (already prose) is passed through.
function flattenResume(rd) {
  const out = [];
  const line = (v) => { const t = String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); if (t) out.push(t); };
  const arr = (v) => (Array.isArray(v) ? v : []);
  const pi = rd.personal_info || {};
  if (pi.title) line(`Current title: ${pi.title}`);
  if (rd.summary) { line(''); line('SUMMARY'); line(String(rd.summary).replace(/\n+/g, ' ')); }
  if (arr(rd.experience).length) {
    line(''); line('EXPERIENCE');
    for (const e of arr(rd.experience)) {
      const when = [e.start_date, e.end_date].filter(Boolean).join(' – ');
      line([[e.role, e.company].filter(Boolean).join(' at '), e.location, when].filter(Boolean).join(' | '));
      for (const h of arr(e.highlights)) line(`- ${h}`);
    }
  }
  if (arr(rd.projects).length) {
    line(''); line('PROJECTS');
    for (const p of arr(rd.projects)) {
      line([p.title, p.type, p.role].filter(Boolean).join(' | '));
      if (p.about) line(p.about);
      for (const h of arr(p.role_highlights)) line(`- ${h}`);
    }
  }
  if (arr(rd.education).length) {
    line(''); line('EDUCATION');
    for (const e of arr(rd.education)) {
      line([[e.degree, e.field_of_study].filter(Boolean).join(', '), e.institution, e.end_date, e.grade].filter(Boolean).join(' | '));
    }
  }
  const sk = rd.skills || {};
  const tech = arr(sk.technical), soft = arr(sk.soft);
  if (tech.length || soft.length) { line(''); line('SKILLS'); if (tech.length) line(tech.join(', ')); if (soft.length) line(soft.join(', ')); }
  if (arr(rd.certifications).length) {
    line(''); line('CERTIFICATIONS');
    for (const c of arr(rd.certifications)) line([c.name, c.issuer, c.year].filter(Boolean).join(' — '));
  }
  if (arr(rd.languages).length) { line(''); line('LANGUAGES'); line(arr(rd.languages).map((l) => [l.name, l.level].filter(Boolean).join(' (') + (l.level ? ')' : '')).join(', ')); }
  if (arr(rd.achievements).length) { line(''); line('ACHIEVEMENTS'); for (const a2 of arr(rd.achievements)) line(`- ${a2}`); }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * The builder résumé as it read BEFORE any employer tailoring — see narrativeFor's `base`.
 *
 * Stored by resumeBuilderController through employerDocs under the '(none)' employer scope with this
 * FIXED fingerprint, so there is exactly one per user per environment and it is findable without
 * knowing what it was built from. ⚠️ The marker must never collide with a real fingerprint: those
 * are 64 hex chars, and this is not hex.
 */
const BASE_SNAPSHOT_FP = 'base-resume-before-tailoring:v1';

async function baseSnapshotFor(userId, reqOrEnv) {
  const docs = require('./employerDocs');          // lazy: keeps this module's require graph light
  const { NONE } = require('./downloads');
  const hit = await docs.get(userId, 'resume', NONE, BASE_SNAPSHOT_FP, reqOrEnv);
  return hit && hit.payload && typeof hit.payload === 'object' && Object.keys(hit.payload).length ? hit.payload : null;
}

/**
 * Readable résumé text to prefill the builder with. Returns { text, source } or null.
 *
 * `base: true` asks for the résumé the user OWNS rather than the one they last had tailored.
 * ⚠️ WHY: user_resumes is one row per user and a tailored build overwrites it. A rebuild for employer
 * B that pulls the current row is written FROM employer A's tailored résumé — the tailoring compounds
 * with every company, and the cache fingerprints drift because the "base" text keeps changing.
 * So when the row is marked tailored_for, the pre-tailoring snapshot is the base.
 *
 * ⚠️ NO SNAPSHOT IS NOT PERMISSION TO SERVE THE TAILORED ROW. A user whose only résumé was an upload
 * never had a builder row to snapshot, so their base is the upload; a snapshot lost to prune() is the
 * same story. The current (tailored) row is only the last resort, because it is the compounding bug.
 *
 * `strict: true` — a failed READ throws instead of degrading to "no résumé".
 * ⚠️ WHY: null means "this user has no résumé", and the app answers that with "upload your resume
 * first". Swallowing a DB blip into null told a user who HAS a résumé to upload one — the first step
 * towards them overwriting it. Only a genuinely empty result may be null in strict mode. (A corrupt
 * resume_data that will not JSON.parse is empty, not a blip: it would fail identically for ever.)
 * ⚠️ Known gap: employerDocs.get swallows its own errors, so a failed SNAPSHOT read still degrades to
 * the upload / current row here — never to null while either exists.
 */
async function narrativeFor(userId, { base = false, env = null, strict = false } = {}) {
  if (base) {
    let tailored = false;
    try {
      const row = await dbConfig.get('SELECT tailored_for FROM user_resumes WHERE user_id = ?', [userId]);
      tailored = !!(row && row.tailored_for);
    } catch (e) { rethrowIfStrict(strict, e); /* no tailored_for column yet = nothing has ever been tailored */ }
    if (tailored) {
      try {
        const snap = await baseSnapshotFor(userId, env);
        const text = snap ? flattenResume(snap) : '';
        if (text.length > 80) return { text: text.slice(0, 18000), source: 'builder' };
      } catch (e) { console.warn('[resumeScore] base snapshot read failed:', e.message); rethrowIfStrict(strict, e); }
      const up = await uploadContentFor(userId, { strict });
      if (up) return { text: up.text.slice(0, 18000), source: 'upload' };
      console.warn(`[resumeScore] user ${userId} is tailored but has no base snapshot or upload — serving the current row`);
    }
  }
  let built = null;
  try {
    built = await dbConfig.get('SELECT resume_data FROM user_resumes WHERE user_id = ?', [userId]);
  } catch (e) { console.warn('[resumeScore] narrative builder read failed:', e.message); rethrowIfStrict(strict, e); }
  if (built && built.resume_data) {
    try {
      const rd = typeof built.resume_data === 'string' ? JSON.parse(built.resume_data) : built.resume_data;
      const text = flattenResume(rd || {});
      if (text.length > 80) return { text: text.slice(0, 18000), source: 'builder' };
    } catch (e) { console.warn('[resumeScore] narrative builder row unreadable:', e.message); }
  }
  // The upload directly — resumeContentFor would re-read the builder row just read above, and a row
  // too thin to narrate but long as JSON made it answer 'builder', which this then dropped as null.
  const up = await uploadContentFor(userId, { strict });
  if (up) return { text: up.text.slice(0, 18000), source: 'upload' };
  return null;
}

// ── The output contract ──────────────────────────────────────────────────────────────────────
// Handed to Gemini as `responseSchema`, which constrains generation — so this is what makes
// "exactly 3 improvements" a GUARANTEE rather than a request the model may quietly ignore. The
// popup renders improvements[0..2] unconditionally, so that count is load-bearing.
//
// ⚠️ Gemini's responseSchema is a SUBSET of JSON Schema. It honours type / properties / required /
// items / minItems / maxItems / enum / nullable / description, and does NOT honour
// `additionalProperties`, `minimum`, `maximum` or `maxLength`. So the SHAPE and the COUNT are
// enforced here, while numeric ranges and character budgets are enforced by normalise() below.
// The split is deliberate — do not add unsupported keywords here expecting them to bite.
const SCORE_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'integer', description: 'Overall 0-100. Your judgement, NOT an average of the four subscores.' },
    subscores: {
      type: 'object',
      properties: {
        impact: { type: 'integer', description: '0-100. Are achievements quantified and outcome-led, or just duty lists?' },
        clarity: { type: 'integer', description: '0-100. Structure, length, readability, consistent tense and formatting.' },
        keywords: { type: 'integer', description: '0-100. Concrete skills, tools and domain terms an ATS would search for.' },
        completeness: { type: 'integer', description: '0-100. Contact details, dates, education, no unexplained gaps.' },
      },
      required: ['impact', 'clarity', 'keywords', 'completeness'],
    },
    headline: { type: 'string', description: 'MAX 60 CHARACTERS. The single biggest thing holding the résumé back.' },
    summary: { type: 'string', description: 'MAX 220 CHARACTERS. Two short sentences, plain language, why it scores what it does.' },
    improvements: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      description: 'Exactly 3, ordered by how much each would raise the score, highest first.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'MAX 42 CHARACTERS. An action.' },
          detail: { type: 'string', description: 'MAX 110 CHARACTERS. Concretely what to change.' },
        },
        required: ['title', 'detail'],
      },
    },
  },
  required: ['score', 'subscores', 'headline', 'summary', 'improvements'],
};

// ── The prompt ───────────────────────────────────────────────────────────────────────────────
// Only JUDGEMENT lives here — the shape is the schema's job now. Restating the JSON shape next to
// an enforced schema just gives the model two sources of truth to disagree with, and it used to be
// half this prompt.
//
// The tone rule is not decoration: this lands unprompted on someone's home screen, and a harsh
// verdict about their career from an app they installed yesterday loses the user rather than
// activating them.
const SYSTEM_PROMPT = `You are a veteran technical recruiter who has screened tens of thousands of résumés.

Score résumés HONESTLY and on a CALIBRATED scale. Most real résumés land between 45 and 75. Reserve
85+ for a résumé that would genuinely pass a top-tier screen with no changes. Never inflate a score
to be kind — a flattering number the candidate cannot act on is worthless to them.

TONE: address the candidate as "your résumé". Be specific and constructive, never harsh or
discouraging. Point at the fix, not the failure.

Respect every character limit in the schema. They are the real dimensions of the card this appears
on, not a style preference.`;

function buildPrompt(text, source) {
  return `Score the résumé below (${source === 'builder' ? 'structured JSON from our résumé builder' : 'text extracted from an uploaded file'}).

=== RÉSUMÉ ===
${text}`;
}

// ⚠️ maxOutputTokens must stay generous: gemini-2.5-flash spends "thinking" tokens from the SAME
// budget, so a tight cap truncates the JSON mid-object and JSON.parse throws an opaque SyntaxError.
// This is the exact failure resumeBuilderController hit and documented; 4096 was too tight there.
async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
    model: MODEL,
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 8192,
      responseMimeType: 'application/json',
      responseSchema: SCORE_SCHEMA,
    },
  });
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('AI_TIMEOUT')), 60_000));
  const res = await Promise.race([model.generateContent(prompt), timeout]);
  // Say "truncated" out loud rather than letting JSON.parse throw something unrelated-looking.
  const cand = res.response.candidates && res.response.candidates[0];
  if (cand && cand.finishReason && cand.finishReason !== 'STOP') {
    throw new Error('AI_BAD_OUTPUT: finishReason ' + cand.finishReason);
  }
  return res.response.text().trim();
}

// Normalise whatever the model returned into something the UI can render without defensive code.
// A model that ignores "exactly 3" or emits a 0-10 score must not reach the popup.
function normalise(raw) {
  const o = JSON.parse(String(raw).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim());
  const sub = o.subscores || {};
  const improvements = (Array.isArray(o.improvements) ? o.improvements : [])
    .map((i) => ({ title: str(i && i.title, 42), detail: str(i && i.detail, 110) }))
    .filter((i) => i.title && i.detail)
    .slice(0, 3);
  if (!improvements.length) throw new Error('AI_BAD_OUTPUT: no improvements');
  const score = clampInt(o.score, 0, 100, NaN);
  if (!Number.isFinite(score)) throw new Error('AI_BAD_OUTPUT: no score');
  return {
    score,
    band: bandFor(score),
    headline: str(o.headline, 60) || 'A few changes would lift this résumé',
    summary: str(o.summary, 240) || '',
    improvements,
    subscores: {
      impact: clampInt(sub.impact, 0, 100, score),
      clarity: clampInt(sub.clarity, 0, 100, score),
      keywords: clampInt(sub.keywords, 0, 100, score),
      completeness: clampInt(sub.completeness, 0, 100, score),
    },
  };
}

/**
 * Score ONE user's résumé. Returns { ok, row, reason }.
 * Never throws — a scoring failure must never break the caller (upload handler, sweep, or route).
 *
 * `force` skips only the fingerprint short-circuit, NOT the switch and NOT the caps: "re-score me"
 * from the app must still be unable to spend money the admin has switched off.
 */
async function scoreOne(userId, { force = false } = {}) {
  const uid = Number(userId);
  if (!uid) return { ok: false, reason: 'bad_user' };

  const on = await require('./notifSwitch').isOn('resume_score').catch(() => false);
  if (!on) return { ok: false, reason: 'switch_off' };

  const content = await resumeContentFor(uid);
  if (!content) return { ok: false, reason: 'no_resume' };
  const fp = fingerprintOf(content.text);

  // Already scored THIS EXACT résumé — free, and the whole point of the fingerprint.
  const existing = await dbConfig.get('SELECT * FROM resume_scores WHERE user_id = ? AND fingerprint = ?', [uid, fp]);
  if (existing && !force) return { ok: true, row: existing, reason: 'cached' };

  try {
    const rows = await dbConfig.query("SELECT COUNT(*)::int AS n FROM resume_scores WHERE created_at >= NOW() - INTERVAL '24 hours'");
    if (rows && rows[0] && rows[0].n >= DAILY_CAP) return { ok: false, reason: 'daily_cap' };
  } catch (e) { console.warn('[resumeScore] cap check failed:', e.message); }

  let parsed;
  try {
    parsed = normalise(await callGemini(buildPrompt(content.text, content.source)));
  } catch (e) {
    console.warn(`[resumeScore] user ${uid} scoring failed: ${e.message}`);
    return { ok: false, reason: 'ai_failed' };
  }

  try {
    // ON CONFLICT so two concurrent callers (the sweep and an upload hook) cannot both insert.
    // A re-score of the SAME fingerprint overwrites the verdict but deliberately leaves
    // shown_at/dismissed_at alone — re-scoring is not a licence to re-interrupt the user.
    const saved = await dbConfig.query(
      `INSERT INTO resume_scores (user_id, score, band, headline, summary, improvements, subscores, source, fingerprint, model, status)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,'ready')
       ON CONFLICT (user_id, fingerprint) DO UPDATE SET
         score=EXCLUDED.score, band=EXCLUDED.band, headline=EXCLUDED.headline, summary=EXCLUDED.summary,
         improvements=EXCLUDED.improvements, subscores=EXCLUDED.subscores, model=EXCLUDED.model, status='ready'
       RETURNING *`,
      [uid, parsed.score, parsed.band, parsed.headline, parsed.summary,
        JSON.stringify(parsed.improvements), JSON.stringify(parsed.subscores), content.source, fp, MODEL]);
    console.log(`[resumeScore] user ${uid}: ${parsed.score}/100 (${parsed.band}, ${content.source})`);
    return { ok: true, row: saved && saved[0], reason: 'scored' };
  } catch (e) {
    console.warn('[resumeScore] save failed:', e.message);
    return { ok: false, reason: 'save_failed' };
  }
}

/**
 * The background sweep. Picks users who HAVE a résumé and have never been scored, oldest first.
 *
 * Note it selects candidates by "no resume_scores row at all" rather than by fingerprint: computing
 * a fingerprint requires loading the résumé, which is a per-user read we do not want to do for the
 * whole table in SQL. scoreOne() does the fingerprint check itself and returns 'cached' for free,
 * so a user whose résumé changed is still re-scored — just on the next sweep after their edit.
 */
async function runSweep({ limit } = {}) {
  const on = await require('./notifSwitch').isOn('resume_score').catch(() => false);
  if (!on) return { ran: false, reason: 'switch_off' };

  const cap = Math.max(1, Math.min(parseInt(limit || RUN_CAP, 10), 200));
  let candidates = [];
  try {
    candidates = await dbConfig.query(
      `SELECT u.id FROM users u
        WHERE u.deleted_at IS NULL
          AND (
            EXISTS (SELECT 1 FROM user_resumes r WHERE r.user_id = u.id)
            OR EXISTS (SELECT 1 FROM resume_metadata m WHERE m.user_id = u.id AND m.parse_status = 'done')
          )
          AND NOT EXISTS (SELECT 1 FROM resume_scores s WHERE s.user_id = u.id)
        ORDER BY u.id ASC
        LIMIT $1`, [cap]);
  } catch (e) {
    // Belt and braces for the bug above: Migration 041 now creates user_resumes, but this sweep
    // must not be one missing table away from doing nothing forever and saying nothing about it.
    // Fall back to the résumé-metadata half, which is where uploaded résumés live anyway.
    console.warn('[resumeScore] candidate query failed, falling back to uploads only:', e.message);
    try {
      candidates = await dbConfig.query(
        `SELECT u.id FROM users u
          WHERE u.deleted_at IS NULL
            AND EXISTS (SELECT 1 FROM resume_metadata m WHERE m.user_id = u.id AND m.parse_status = 'done')
            AND NOT EXISTS (SELECT 1 FROM resume_scores s WHERE s.user_id = u.id)
          ORDER BY u.id ASC
          LIMIT $1`, [cap]);
    } catch (e2) {
      console.warn('[resumeScore] fallback candidate query also failed:', e2.message);
      return { ran: false, reason: 'query_failed' };
    }
  }

  let scored = 0, skipped = 0;
  for (const c of candidates || []) {
    const r = await scoreOne(c.id);
    if (r.ok && r.reason === 'scored') scored++; else skipped++;
    if (r.reason === 'daily_cap' || r.reason === 'switch_off') break;
  }
  if (candidates.length) console.log(`[resumeScore] sweep: ${scored} scored, ${skipped} skipped of ${candidates.length}`);
  return { ran: true, candidates: candidates.length, scored, skipped };
}

/**
 * The latest score for a user, plus whether Home should interrupt them with it.
 *
 * `shouldPrompt` is the ONLY thing the app should gate the popup on. It is false once the user has
 * dismissed or acted on this résumé version — dismissing is per-ROW, so a NEW résumé version still
 * gets to speak up, which is exactly what makes "your score went 61 → 82" possible.
 */
async function latestFor(userId) {
  try {
    const row = await dbConfig.get(
      "SELECT * FROM resume_scores WHERE user_id = ? AND status = 'ready' ORDER BY created_at DESC LIMIT 1", [userId]);
    if (!row) return { hasScore: false, shouldPrompt: false };
    const prev = await dbConfig.get(
      "SELECT score FROM resume_scores WHERE user_id = ? AND status = 'ready' AND id <> ? ORDER BY created_at DESC LIMIT 1", [userId, row.id]);
    const jsonb = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v || d); } catch { return d; } };
    return {
      hasScore: true,
      shouldPrompt: !row.dismissed_at && !row.acted_at,
      score: {
        id: row.id, score: row.score, band: row.band, headline: row.headline, summary: row.summary,
        improvements: jsonb(row.improvements, []), subscores: jsonb(row.subscores, {}),
        source: row.source, createdAt: row.created_at,
        previousScore: prev ? prev.score : null,
        shownAt: row.shown_at, dismissedAt: row.dismissed_at, actedAt: row.acted_at,
      },
    };
  } catch (e) {
    console.warn('[resumeScore] latestFor failed:', e.message);
    return { hasScore: false, shouldPrompt: false };
  }
}

/** Stamp shown/dismissed/acted on ONE score row. Ignores unknown marks and other users' rows. */
async function mark(userId, scoreId, what) {
  const col = { shown: 'shown_at', dismissed: 'dismissed_at', acted: 'acted_at' }[what];
  if (!col) return false;
  try {
    await dbConfig.run(`UPDATE resume_scores SET ${col} = NOW() WHERE id = ? AND user_id = ? AND ${col} IS NULL`, [scoreId, userId]);
    return true;
  } catch (e) { console.warn('[resumeScore] mark failed:', e.message); return false; }
}

// ── Scheduler ────────────────────────────────────────────────────────────────────────────────
// ⚠️ SHIPS DISARMED, TWICE OVER. RESUME_SCORE_SWEEP must be explicitly '1' to even start the
// timer, and every sweep re-checks the admin switch, which Migration 041 seeds FALSE. A scheduler
// that spends money on AI must never be armed by the act of deploying it.
let timer = null;
function startScheduler() {
  if (timer) return { started: false, reason: 'already' };
  if (String(process.env.RESUME_SCORE_SWEEP || '0') !== '1') {
    console.log('[resumeScore] sweep scheduler DISARMED (set RESUME_SCORE_SWEEP=1 to arm)');
    return { started: false, reason: 'disarmed' };
  }
  const everyMs = Math.max(5, SWEEP_MIN) * 60 * 1000;
  timer = setInterval(() => { runSweep().catch((e) => console.warn('[resumeScore] sweep error:', e.message)); }, everyMs);
  if (timer.unref) timer.unref();
  // setInterval does not fire until one FULL period has elapsed, so arming this on a deploy used to
  // mean an hour of silence before the first score existed — and every redeploy restarted that
  // clock, so a service that redeploys often could sweep never. Kick one off shortly after boot
  // instead. The delay is so a restart storm doesn't have several instances sweeping at once, and
  // runSweep still re-checks the admin switch, so this cannot arm anything by itself.
  const first = setTimeout(() => { runSweep().catch((e) => console.warn('[resumeScore] initial sweep error:', e.message)); },
    parseInt(process.env.RESUME_SCORE_FIRST_MS || '120000', 10));
  if (first.unref) first.unref();
  console.log(`[resumeScore] sweep scheduler armed — every ${SWEEP_MIN}min (still gated on the 'resume_score' admin switch)`);
  return { started: true, everyMs };
}

module.exports = { scoreOne, runSweep, latestFor, mark, startScheduler, resumeContentFor, uploadContentFor, narrativeFor, BASE_SNAPSHOT_FP, fingerprintOf, bandFor, _normalise: normalise, _flattenResume: flattenResume };
