// LinkedIn job extraction — a SEPARATE pipeline from the normal scraper. The app's hidden on-device
// WebView loads the LinkedIn job page (real user IP/fingerprint/session → bypasses the HTTP 999 wall),
// grabs page innerText, and POSTs it here. We AI-extract structured JSON, store the raw text + JSON
// (for cover-letter reuse), and either just return it (enrich an open job) or ADD it to the user's Job
// Hub (employer + job + tracking) so it shows on the dashboard like any added company. Nothing in the
// existing search pipeline is touched.
'use strict';
const { GoogleGenerativeAI } = require('@google/generative-ai');
const store = require('../services/linkedinJobStore');
const jobService = require('../services/jobService');
const { cleanSkills, seniorityFromTitle } = require('../utils/jobFields');

// Strip query/hash + trailing slash so the same job dedupes to one row.
function cleanUrl(u) {
  try { const x = new URL(String(u)); return (x.origin + x.pathname).replace(/\/+$/, ''); }
  catch { return String(u || '').split('?')[0].split('#')[0].replace(/\/+$/, ''); }
}
function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80); }

// Shared: turn (url, content) into a structured job — from the cache if present, else AI-extract + store.
// Returns { job, cached } on success, or { error, status } on a problem.
async function getOrExtractJob(url, content, userId, force) {
  let text = String(content || '').replace(/[ \t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!url || !/linkedin\.com/i.test(url)) return { error: 'A LinkedIn job URL is required.', status: 400 };
  if (text.length < 40 || (/sign in to|join linkedin|authwall|HTTP 999/i.test(text) && text.length < 400)) {
    return { error: 'linkedin_blocked', message: 'The job text could not be read (LinkedIn may have shown a sign-in wall). Make sure you are signed in to LinkedIn and try again.', status: 422 };
  }
  text = text.slice(0, 12000); // innerText is already tiny; cap as a safety net

  if (!force) {
    const existing = await store.getLinkedInJob(url).catch(() => null);
    if (existing && existing.data) {
      const d = typeof existing.data === 'string' ? JSON.parse(existing.data) : existing.data;
      if (d && d.title) return { job: d, cached: true };
    }
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) return { error: 'AI is not configured.', status: 500 };
  const model = new GoogleGenerativeAI(key).getGenerativeModel({
    model: 'gemini-2.5-flash-lite',
    generationConfig: { responseMimeType: 'application/json', temperature: 0.1, maxOutputTokens: 4096 },
  });
  const prompt = `You extract a job posting from the plain text of a LinkedIn job page.
Return ONLY a JSON object with EXACTLY these keys:
"title" (string), "company" (string), "location" (string),
"employment_type" (e.g. Full-time/Part-time/Contract/Internship, or ""),
"work_mode" ("Onsite"|"Hybrid"|"Remote"|""), "salary" (string or ""), "seniority" (string or ""),
"skills" (array of strings), "responsibilities" (array of short bullet strings),
"description" (a clean plain-text summary of the role, max ~150 words).
Rules: use ONLY facts present in the text; use "" or [] when absent; never invent. JSON only, no markdown.
"skills" are NAMES ONLY — a technology, tool, language or named competency, 1-4 words each
("Kubernetes", ".NET", "Docker", "Agile methodologies", "Technical coaching"). NEVER copy a
requirement sentence: "Several years of experience in software development" and "In-depth knowledge
of the .NET environment" are NOT skills — the skills there are "Software development" and ".NET".
"seniority" is the level as a single word or short phrase (Internship / Junior / Mid-level / Senior /
Lead / Principal). Read it from the title when the body does not state it.

LINKEDIN JOB PAGE TEXT:
${text}`;
  async function callOnce() { const r = await model.generateContent(prompt); return JSON.parse(r.response.text()); }
  let out = null;
  try { out = await callOnce(); } catch (e1) { try { out = await callOnce(); } catch (e2) { return { error: 'Could not extract the job details. Please try again.', status: 502 }; } }
  if (!out || typeof out !== 'object' || !String(out.title || '').trim()) return { error: 'Could not read this LinkedIn job.', status: 502 };

  const arr = (v) => Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
  const title = String(out.title || '').trim();
  const job = {
    title, company: String(out.company || '').trim(), location: String(out.location || '').trim(),
    employment_type: String(out.employment_type || '').trim(), work_mode: String(out.work_mode || '').trim(),
    salary: String(out.salary || '').trim(),
    // The card renders these straight from here, so shape them BEFORE they are stored — see
    // utils/jobFields. Previously a requirements list arrived as "skills" and three sentences were
    // rendered as chips until the job was opened and a second pipeline replaced them.
    seniority: String(out.seniority || '').trim() || seniorityFromTitle(title),
    skills: cleanSkills(out.skills), responsibilities: arr(out.responsibilities).slice(0, 20),
    description: String(out.description || '').trim(), url, source: 'linkedin',
  };
  await store.saveLinkedInJob({ userId, url, rawText: text, data: job }).catch((e) => console.error('[linkedin] save failed:', e.message));
  return { job, cached: false };
}

// Persist an extracted LinkedIn job into the user's Job Hub (so it shows on the dashboard).
async function persistToHub(userId, job) {
  const company = job.company || 'LinkedIn';
  const domain = `linkedin-${slug(company) || 'job'}`; // synthetic per-company key (unique in employers.domain)
  const employerId = await jobService.upsertEmployer(domain, company, job.location || 'LinkedIn', ['#0A66C2', '#004182'], (company[0] || 'L').toUpperCase());
  const locationId = job.location ? await jobService.upsertLocation(job.location).catch(() => null) : null;
  const jobId = await jobService.upsertJob(
    employerId, locationId, job.title, job.url,
    job.seniority || null, job.salary || null, job.employment_type || null, false,
    job.responsibilities || [], job.work_mode || null
  );
  if (Array.isArray(job.skills)) {
    for (const sk of job.skills.slice(0, 20)) {
      try { const sid = await jobService.upsertSkill(sk); if (sid) await jobService.linkJobSkill(jobId, sid); } catch {}
    }
  }
  await jobService.trackUserEmployer(userId, employerId);
  await jobService.saveUserJobMatch(userId, jobId, null); // unscored → card shows while it's evaluated
  return { employerId: String(employerId), jobId: String(jobId), domain };
}

// POST /api/ai-hub/linkedin/extract   body { url, content, force? }  → just return the structured job
async function extractLinkedInJob(req, res) {
  try {
    const r = await getOrExtractJob(cleanUrl((req.body || {}).url), (req.body || {}).content, req.user && req.user.id, req.body && req.body.force);
    if (r.error) return res.status(r.status || 500).json({ error: r.error, message: r.message });
    return res.json({ cached: !!r.cached, url: r.job.url, job: r.job });
  } catch (e) { console.error('[linkedin] extract error:', e.message); return res.status(500).json({ error: 'Extraction failed.' }); }
}

// POST /api/ai-hub/linkedin/add   body { url, content, force? }  → extract AND add to the user's Job Hub
async function addLinkedInJob(req, res) {
  try {
    const userId = req.user && req.user.id;
    const r = await getOrExtractJob(cleanUrl((req.body || {}).url), (req.body || {}).content, userId, req.body && req.body.force);
    if (r.error) return res.status(r.status || 500).json({ error: r.error, message: r.message });
    let hub = null;
    try { hub = await persistToHub(userId, r.job); }
    catch (e) { console.error('[linkedin] persistToHub failed:', e.message); return res.status(500).json({ error: 'Saved the job but could not add it to your hub.', job: r.job }); }
    return res.json({ added: true, url: r.job.url, job: r.job, ...hub });
  } catch (e) { console.error('[linkedin] add error:', e.message); return res.status(500).json({ error: 'Could not add this LinkedIn job.' }); }
}

// GET /api/ai-hub/linkedin/job?url=...  → the stored job (+ raw text) for reuse (e.g. cover letters)
async function getLinkedInJobByUrl(req, res) {
  try {
    const url = cleanUrl((req.query || {}).url || '');
    if (!url) return res.status(400).json({ error: 'url is required' });
    const row = await store.getLinkedInJob(url);
    if (!row) return res.status(404).json({ error: 'not found' });
    const d = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    return res.json({ url, job: d, rawText: row.raw_text });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

module.exports = { extractLinkedInJob, addLinkedInJob, getLinkedInJobByUrl };
