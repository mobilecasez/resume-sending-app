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

const MODEL = process.env.RESUME_SCORE_MODEL || 'claude-opus-5';
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
  try {
    const meta = await dbConfig.get(
      "SELECT full_text, summary, experience, education, skills FROM resume_metadata WHERE user_id = ? AND parse_status = 'done'", [userId]);
    if (meta) {
      const text = String(meta.full_text || [meta.summary, meta.experience, meta.education, meta.skills].filter(Boolean).join('\n\n') || '');
      if (text.trim().length > 120) return { text: text.slice(0, 24000), source: 'upload' };
    }
  } catch (e) { console.warn('[resumeScore] metadata read failed:', e.message); }
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

/** Readable résumé text to prefill the builder with. Returns { text, source } or null. */
async function narrativeFor(userId) {
  try {
    const built = await dbConfig.get('SELECT resume_data FROM user_resumes WHERE user_id = ?', [userId]);
    if (built && built.resume_data) {
      const rd = typeof built.resume_data === 'string' ? JSON.parse(built.resume_data) : built.resume_data;
      const text = flattenResume(rd || {});
      if (text.length > 80) return { text: text.slice(0, 18000), source: 'builder' };
    }
  } catch (e) { console.warn('[resumeScore] narrative builder read failed:', e.message); }
  const raw = await resumeContentFor(userId);
  if (raw && raw.source === 'upload') return { text: raw.text.slice(0, 18000), source: 'upload' };
  return null;
}

// ── The prompt ───────────────────────────────────────────────────────────────────────────────
// Deliberately constrained: the popup has room for ONE headline, TWO short lines, and THREE fixes.
// Asking for more produces an essay nobody reads and costs more tokens. The tone rule is not
// decoration — this lands unprompted on someone's home screen, and a harsh verdict about their
// career from an app they just installed is how you lose the user, not activate them.
// ── The output contract ──────────────────────────────────────────────────────────────────────
// A real JSON Schema, enforced by the API during generation — not a shape described in prose and
// hoped for. This is the main reason this service is worth moving off a "return JSON" prompt:
// "exactly 3 improvements" and every character limit are now GUARANTEED rather than requested,
// so the model writes to the popup's real dimensions instead of being truncated mid-word by us.
// The limits match ResumeScoreModal's layout exactly; changing one means changing both.
const SCORE_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'integer', minimum: 0, maximum: 100 },
    subscores: {
      type: 'object',
      properties: {
        impact: { type: 'integer', minimum: 0, maximum: 100 },
        clarity: { type: 'integer', minimum: 0, maximum: 100 },
        keywords: { type: 'integer', minimum: 0, maximum: 100 },
        completeness: { type: 'integer', minimum: 0, maximum: 100 },
      },
      required: ['impact', 'clarity', 'keywords', 'completeness'],
      additionalProperties: false,
    },
    headline: { type: 'string', maxLength: 60 },
    summary: { type: 'string', maxLength: 240 },
    improvements: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', maxLength: 42 },
          detail: { type: 'string', maxLength: 110 },
        },
        required: ['title', 'detail'],
        additionalProperties: false,
      },
    },
  },
  required: ['score', 'subscores', 'headline', 'summary', 'improvements'],
  additionalProperties: false,
};

// ── The prompt ───────────────────────────────────────────────────────────────────────────────
// Only JUDGEMENT lives here now. The shape used to be half this prompt — restating it alongside an
// enforced schema just gives the model two sources of truth to disagree with.
//
// The tone rule is not decoration: this lands unprompted on someone's home screen, and a harsh
// verdict about their career from an app they installed yesterday loses the user rather than
// activating them.
const SYSTEM_PROMPT = `You are a veteran technical recruiter who has screened tens of thousands of résumés.

Score résumés HONESTLY and on a CALIBRATED scale. Most real résumés land between 45 and 75.
Reserve 85+ for a résumé that would genuinely pass a top-tier screen with no changes. Never inflate
a score to be kind — a flattering number the candidate cannot act on is worthless to them.

Judge four dimensions, each 0-100:
- impact:       are achievements quantified and outcome-led, or just duty lists?
- clarity:      structure, length, readability, consistent tense and formatting
- keywords:     concrete skills, tools and domain terms an ATS and a recruiter would search for
- completeness: contact details, dates, education, no unexplained gaps, no missing sections

The overall score is your judgement, NOT an average of the four.

Order "improvements" by how much each would raise the score, highest first.

TONE: address the candidate as "your résumé". Be specific and constructive, never harsh or
discouraging. Point at the fix, not the failure.`;

function buildPrompt(text, source) {
  return `Score the résumé below (${source === 'builder' ? 'structured JSON from our résumé builder' : 'text extracted from an uploaded file'}).

=== RÉSUMÉ ===
${text}`;
}

// One Claude call. Adaptive thinking is on because scoring is a calibration judgement, not an
// extraction — the difference between a 58 and a 71 is exactly the kind of thing worth thinking
// about. Effort is left at its default (high) and exposed as an env var rather than quietly
// lowered: how much to spend per résumé is an operator decision, not one to bury in a constant.
let _client = null;
function client() {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const Anthropic = require('@anthropic-ai/sdk');
  _client = new Anthropic({ apiKey, maxRetries: 2 });
  return _client;
}

async function callClaude(prompt) {
  const req = {
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    thinking: { type: 'adaptive' },
    output_config: { format: { type: 'json_schema', schema: SCORE_SCHEMA } },
    messages: [{ role: 'user', content: prompt }],
  };
  const effort = process.env.RESUME_SCORE_EFFORT;
  if (effort) req.output_config.effort = effort;

  const res = await client().messages.create(req);

  // A safety decline returns HTTP 200 with stop_reason 'refusal' and NO usable content, so it must
  // be checked before reading content or the next line throws something unrelated and misleading.
  if (res.stop_reason === 'refusal') {
    throw new Error(`AI_REFUSED: ${(res.stop_details && res.stop_details.category) || 'unspecified'}`);
  }
  // content is a discriminated union — thinking blocks come first when thinking is on, so pick the
  // text block by type rather than trusting position.
  const block = (res.content || []).find((b) => b.type === 'text');
  if (!block || !block.text) throw new Error('AI_BAD_OUTPUT: no text block');
  return block.text;
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
    parsed = normalise(await callClaude(buildPrompt(content.text, content.source)));
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
  console.log(`[resumeScore] sweep scheduler armed — every ${SWEEP_MIN}min (still gated on the 'resume_score' admin switch)`);
  return { started: true, everyMs };
}

module.exports = { scoreOne, runSweep, latestFor, mark, startScheduler, resumeContentFor, narrativeFor, fingerprintOf, bandFor, _normalise: normalise, _flattenResume: flattenResume };
