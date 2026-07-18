// AI Hub — universal job capture. Safe to delete without affecting existing app.
//
// When a user opens a live/web job in the in-app apply WebView and taps Apply, the app grabs the
// job page's visible text (the "actual job details" page, with responsibilities etc.) and POSTs it
// here. We:
//   1) AI-extract the responsibilities/description ONLY when the client's known card fields are thin
//      (so we never burn a call on an already-rich job),
//   2) upsert the employer + job into the hub so a REAL DB UUID exists (cover-letter + status
//      tracking key off it), preserving any responsibilities we already stored,
//   3) when track:true, add it to the user's My Jobs (user_job_matches) — this is the moment the job
//      appears on the dashboard (fired on Generate-Cover-Letter / successful submit, NOT on mere open).
// Returns the canonical jobId + the enriched job so the client can generate the best cover letter
// from real data without any further AI extraction. Nothing in the existing pipeline is touched.
'use strict';
const { GoogleGenerativeAI } = require('@google/generative-ai');
const dbConfig = require('../../db-config');
const jobService = require('../services/jobService');

// Strip query/hash + trailing slash so the same job dedupes to one jobs row (UNIQUE job_url).
function cleanUrl(u) {
  try { const x = new URL(String(u)); return (x.origin + x.pathname).replace(/\/+$/, ''); }
  catch { return String(u || '').split('?')[0].split('#')[0].replace(/\/+$/, ''); }
}
function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80); }
function domainOf(u) { try { return new URL(String(u)).hostname.replace(/^www\./, ''); } catch { return ''; } }
const arr = (v) => Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
const str = (v) => String(v == null ? '' : v).trim();

// AI-extract structured details from the job page's visible text. Cheap flash-lite, JSON only.
async function extractFromText(text, hint) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  let t = String(text || '').replace(/[ \t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (t.length < 120) return null;                 // too little to bother (login wall / blank page)
  if (/sign in|log in|create account|just a moment|verify you are human|enable javascript/i.test(t) && t.length < 500) return null;
  t = t.slice(0, 12000);                            // innerText is already tiny; cap as a safety net
  const model = new GoogleGenerativeAI(key).getGenerativeModel({
    model: process.env.GEMINI_FLASH_LITE_MODEL || 'gemini-2.5-flash-lite',
    generationConfig: { responseMimeType: 'application/json', temperature: 0.1, maxOutputTokens: 4096 },
  });
  const prompt = `You extract a job posting from the plain text of a job/careers web page.
Return ONLY a JSON object with EXACTLY these keys:
"title" (string), "company" (string), "location" (string),
"employment_type" (Full-time/Part-time/Contract/Internship or ""),
"work_mode" ("Onsite"|"Hybrid"|"Remote"|""), "salary" (string or ""), "seniority" (string or ""),
"skills" (array of strings), "responsibilities" (array of short bullet strings),
"description" (a clean plain-text summary of the role, max ~150 words).
Rules: use ONLY facts present in the text; use "" or [] when absent; never invent. JSON only, no markdown.
${hint ? 'KNOWN (may help disambiguate, prefer page text over this): ' + hint + '\n' : ''}
JOB PAGE TEXT:
${t}`;
  const callOnce = async () => JSON.parse((await model.generateContent(prompt)).response.text());
  try { return await callOnce(); } catch { try { return await callOnce(); } catch { return null; } }
}

// POST /api/ai-hub/jobs/capture
// body: { url, title, company, companyDomain, location, jobType, workMode, experience, salary,
//         responsibilities[], skills[], description, matchScore, pageText, track }
async function captureJob(req, res) {
  try {
    const userId = req.user && req.user.id;
    const b = req.body || {};
    const url = cleanUrl(b.url);
    if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'A job URL is required.' });

    // Start from the client's known card fields (title/company/location are often already good).
    let title = str(b.title), company = str(b.company), location = str(b.location);
    let jobType = str(b.jobType), workMode = str(b.workMode), experience = str(b.experience), salary = str(b.salary);
    let responsibilities = arr(b.responsibilities), skills = arr(b.skills), description = str(b.description);

    // AI-extract ONLY when we lack substance — keeps the common (already-rich) case free.
    const needExtract = (responsibilities.length < 2 || !description || !title || !company);
    if (needExtract && str(b.pageText).length >= 120) {
      const hint = [title && ('title=' + title), company && ('company=' + company)].filter(Boolean).join('; ');
      const out = await extractFromText(b.pageText, hint);
      if (out && typeof out === 'object') {
        title       = title       || str(out.title);
        company     = company     || str(out.company);
        location    = location    || str(out.location);
        jobType     = jobType     || str(out.employment_type);
        workMode    = workMode    || str(out.work_mode);
        experience  = experience  || str(out.seniority);
        salary      = salary      || str(out.salary);
        description = description || str(out.description);
        if (arr(out.responsibilities).length > responsibilities.length) responsibilities = arr(out.responsibilities);
        if (arr(out.skills).length > skills.length) skills = arr(out.skills);
      }
    }
    if (!title) title = 'Job application';
    if (!company) company = domainOf(url) || 'Company';
    responsibilities = responsibilities.slice(0, 20);
    skills = skills.slice(0, 30);

    // Look up any existing row for this URL ONCE, for two reasons:
    //  (a) Never SHRINK stored responsibilities — upsertJob overwrites the row, so a field-only
    //      re-capture (empty) or a slimmed card (3 items) must not wipe a richer set stored earlier.
    //  (b) Keep the job under its CURRENT employer — upsertJob re-points employer_id on conflict,
    //      which would otherwise steal a job another user already tracks under a different employer.
    const existing = await dbConfig.get(`SELECT employer_id, title, responsibilities FROM jobs WHERE job_url=$1`, [url]).catch(() => null);
    if (existing && existing.responsibilities) {
      try {
        const r = typeof existing.responsibilities === 'string' ? JSON.parse(existing.responsibilities) : existing.responsibilities;
        if (Array.isArray(r) && r.length > responsibilities.length) responsibilities = r;
      } catch {}
    }
    // Same idea for the title: a later field-only capture sends no title (the client deliberately
    // withholds a weak page-title), and upsertJob would overwrite a good stored one with a fallback.
    if (!title && existing && existing.title) title = String(existing.title);

    // Employer: reuse the job's current employer if it already exists (no re-point); otherwise
    // prefer the real site domain, else a synthetic per-company key (unique in employers.domain).
    let employerId;
    if (existing && existing.employer_id) {
      employerId = existing.employer_id;
    } else {
      const realDomain = str(b.companyDomain) || domainOf(url);
      const domain = realDomain || ('web-' + (slug(company) || 'job'));
      employerId = await jobService.upsertEmployer(
        domain, company, location || domain, ['#4F8DFF', '#2563EB'], (company[0] || 'C').toUpperCase()
      );
    }
    const locationId = location ? await jobService.upsertLocation(location).catch(() => null) : null;
    const jobId = await jobService.upsertJob(
      employerId, locationId, title, url,
      experience || null, salary || null, jobType || null, false,
      responsibilities, workMode || null
    );
    for (const sk of skills.slice(0, 20)) {
      try { const sid = await jobService.upsertSkill(sk); if (sid) await jobService.linkJobSkill(jobId, sid); } catch {}
    }

    // track:true → add to My Jobs (dashboard). The apply-open prefetch leaves it untracked so merely
    // opening a job doesn't clutter the dashboard; the entry appears on Generate-CL / submit.
    if (b.track && userId) {
      const ms = (typeof b.matchScore === 'number' && b.matchScore >= 0) ? Math.round(b.matchScore) : null;
      try { await jobService.trackUserEmployer(userId, employerId); } catch {}
      try { await jobService.saveUserJobMatch(userId, jobId, ms); } catch {}
    }

    return res.json({
      jobId: String(jobId), employerId: String(employerId), tracked: !!(b.track && userId),
      job: { id: String(jobId), title, company, location, jobType, workMode, experience, salary, responsibilities, skills, description, url },
    });
  } catch (e) {
    console.error('[capture] error:', e && e.message);
    return res.status(500).json({ error: 'Could not capture this job.' });
  }
}

// extractFromText is also reused by discover's fetch-detail as its SPA/iframe-proof fallback:
// a job board that renders into an iframe or late-hydrates isn't in the page's outerHTML, but IS
// in its visible text. Same bounded cost (1 call + 1 retry, 12k cap).
module.exports = { captureJob, extractFromText };
