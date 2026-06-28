// LinkedIn job extraction — a SEPARATE pipeline from the normal scraper. The app's hidden on-device
// WebView loads the LinkedIn job page (real user IP/fingerprint/session → bypasses the HTTP 999 wall),
// grabs page innerText, and POSTs it here. We AI-extract structured JSON, store the raw text + JSON
// (for cover-letter reuse), and return the job. Nothing in the existing search pipeline is touched.
'use strict';
const { GoogleGenerativeAI } = require('@google/generative-ai');
const store = require('../services/linkedinJobStore');

// Strip query/hash + trailing slash so the same job dedupes to one row.
function cleanUrl(u) {
  try { const x = new URL(String(u)); return (x.origin + x.pathname).replace(/\/+$/, ''); }
  catch { return String(u || '').split('?')[0].split('#')[0].replace(/\/+$/, ''); }
}

// POST /api/ai-hub/linkedin/extract   body { url, content, force? }
async function extractLinkedInJob(req, res) {
  try {
    const userId = req.user && req.user.id;
    const url = cleanUrl((req.body && req.body.url) || '');
    let content = String((req.body && req.body.content) || '').replace(/[ \t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

    if (!url || !/linkedin\.com/i.test(url)) return res.status(400).json({ error: 'A LinkedIn job URL is required.' });
    // The hidden WebView sends innerText; if it's tiny the page likely hit the auth-wall / hadn't rendered.
    if (content.length < 40 || /sign in to|join linkedin|authwall|HTTP 999/i.test(content) && content.length < 400) {
      return res.status(422).json({ error: 'linkedin_blocked', message: 'The job text could not be read (LinkedIn may have shown a sign-in wall). Please make sure you are signed in to LinkedIn and try again.' });
    }
    content = content.slice(0, 12000); // innerText is already tiny; cap as a safety net

    // Cache: already extracted this URL → return it (no AI cost).
    if (!(req.body && req.body.force)) {
      const existing = await store.getLinkedInJob(url).catch(() => null);
      if (existing && existing.data) {
        const d = typeof existing.data === 'string' ? JSON.parse(existing.data) : existing.data;
        if (d && d.title) return res.json({ cached: true, url, job: d });
      }
    }

    const key = process.env.GEMINI_API_KEY;
    if (!key) return res.status(500).json({ error: 'AI is not configured.' });
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

LINKEDIN JOB PAGE TEXT:
${content}`;

    async function callOnce() { const r = await model.generateContent(prompt); return JSON.parse(r.response.text()); }
    let out = null;
    try { out = await callOnce(); } catch (e1) { try { out = await callOnce(); } catch (e2) { return res.status(502).json({ error: 'Could not extract the job details. Please try again.' }); } }
    if (!out || typeof out !== 'object' || !String(out.title || '').trim()) {
      return res.status(502).json({ error: 'Could not read this LinkedIn job.' });
    }

    const arr = (v) => Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
    const job = {
      title: String(out.title || '').trim(),
      company: String(out.company || '').trim(),
      location: String(out.location || '').trim(),
      employment_type: String(out.employment_type || '').trim(),
      work_mode: String(out.work_mode || '').trim(),
      salary: String(out.salary || '').trim(),
      seniority: String(out.seniority || '').trim(),
      skills: arr(out.skills).slice(0, 30),
      responsibilities: arr(out.responsibilities).slice(0, 20),
      description: String(out.description || '').trim(),
      url, source: 'linkedin',
    };

    await store.saveLinkedInJob({ userId, url, rawText: content, data: job }).catch((e) => console.error('[linkedin] save failed:', e.message));
    return res.json({ cached: false, url, job });
  } catch (e) {
    console.error('[linkedin] extract error:', e.message);
    return res.status(500).json({ error: 'Extraction failed.' });
  }
}

// GET /api/ai-hub/linkedin/job?url=...  → the stored job (+ raw text) for reuse (e.g. cover letters)
async function getLinkedInJobByUrl(req, res) {
  try {
    const url = cleanUrl((req.query && req.query.url) || '');
    if (!url) return res.status(400).json({ error: 'url is required' });
    const row = await store.getLinkedInJob(url);
    if (!row) return res.status(404).json({ error: 'not found' });
    const d = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    return res.json({ url, job: d, rawText: row.raw_text });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

module.exports = { extractLinkedInJob, getLinkedInJobByUrl };
