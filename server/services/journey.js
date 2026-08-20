// Activation journey — ADDITIVE, ISOLATED. The five things a new user has to do before the app
// does anything useful for them, and which one they should do next.
//
// WHY THIS EXISTS: the funnel is brutal and measurable. On production today: 337 registered,
// 92 uploaded a résumé, 19 built one with AI, 18 generated a cover letter, 8 ever applied.
// Almost nobody finds the next step on their own, so the app has to point at it.
//
// The order is NOT arbitrary — it is the order of the five tutorial films, which are numbered
// 01-05 on screen. Changing it here without re-cutting the films would have the coach point at
// step 3 while the film says "04".
'use strict';

const dbConfig = require('../../db-config');

/** The five steps, in the order the films teach them. `video` matches TUTORIAL_FILES in the app. */
const STEPS = [
  { key: 'profile',      title: 'Set up your profile',   blurb: 'Typed once, kept for every form' },
  { key: 'resume',       title: 'Build an AI résumé',    blurb: 'A real résumé in a country format' },
  { key: 'save_job',     title: 'Save a job',            blurb: 'Keep the ones worth applying to' },
  { key: 'cover_letter', title: 'Write a cover letter',  blurb: 'Tailored to that exact job' },
  { key: 'apply',        title: 'Auto Fill & apply',     blurb: 'The form fills itself' },
];

const one = async (sql, params) => {
  try { const r = await dbConfig.query(sql, params); return !!(r && r.length); }
  catch (e) { console.warn('[journey]', e.message); return false; }
};

/**
 * Where this user is in the journey. Never throws — this drives a home-screen nudge, and a broken
 * read must degrade to "nothing to show" rather than an error on someone's home screen.
 *
 * Each step is a plain EXISTS: cheap, and honest about what "done" means. `apply` deliberately
 * counts application_history rather than a job flagged Applied, because history is what the send
 * pipeline actually writes.
 */
async function journeyFor(userId) {
  const uid = Number(userId);
  if (!uid) return null;

  // Step 1 reuses the profile controller's own completeness rule — including its file-on-disk
  // check, so a résumé row pointing at a deleted file does NOT count as done here either.
  let profileDone = false;
  try {
    const { livePath } = require('../controllers/profileController');
    const u = await dbConfig.get(
      `SELECT phone_number, address, date_of_birth, photo_path, resume_path, signature_path
         FROM users WHERE id = ? AND deleted_at IS NULL`, [uid]);
    if (u) {
      profileDone = !!(u.phone_number && u.address && u.date_of_birth
        && livePath(u.photo_path) && livePath(u.resume_path) && livePath(u.signature_path));
    }
  } catch (e) { console.warn('[journey] profile:', e.message); }

  const [resume, savedJob, coverLetter, applied] = await Promise.all([
    one('SELECT 1 FROM user_resumes WHERE user_id = $1 LIMIT 1', [uid]),
    one('SELECT 1 FROM user_saved_jobs WHERE user_id = $1 LIMIT 1', [uid]),
    one('SELECT 1 FROM job_cover_letters WHERE user_id = $1 LIMIT 1', [uid]),
    one('SELECT 1 FROM application_history WHERE user_id = $1 AND deleted_at IS NULL LIMIT 1', [uid]),
  ]);

  const doneBy = { profile: profileDone, resume, save_job: savedJob, cover_letter: coverLetter, apply: applied };
  const steps = STEPS.map((s, i) => ({ ...s, n: i + 1, done: !!doneBy[s.key] }));
  const completed = steps.filter((s) => s.done).length;

  // The NEXT step is the first UNDONE one, in film order — not "the one after the last done one".
  // Someone who applied to a job before finishing their profile still needs the profile step, and
  // skipping it because a later step is done is how the coach would point at nothing useful.
  const next = steps.find((s) => !s.done) || null;

  return {
    steps,
    nextKey: next ? next.key : null,
    nextN: next ? next.n : null,
    completed,
    total: steps.length,
    pct: Math.round((completed / steps.length) * 100),
    complete: completed === steps.length,
  };
}

module.exports = { journeyFor, STEPS };
