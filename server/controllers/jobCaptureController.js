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
const { cleanSkills, seniorityFromTitle } = require('../utils/jobFields');
const { noteAiFailure, isOutage, outageResponse } = require('../services/aiHealth');

// Strip query/hash + trailing slash so the same job dedupes to one jobs row (UNIQUE job_url).
function cleanUrl(u) {
  try { const x = new URL(String(u)); return (x.origin + x.pathname).replace(/\/+$/, ''); }
  catch { return String(u || '').split('?')[0].split('#')[0].replace(/\/+$/, ''); }
}
function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80); }
function domainOf(u) { try { return new URL(String(u)).hostname.replace(/^www\./, ''); } catch { return ''; } }
const arr = (v) => Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
const str = (v) => String(v == null ? '' : v).trim();

// Headings are often styled uppercase, and the AI copies what it reads — so a page whose <h1> is
// text-transform:uppercase gave us "FULL-STACK SOFTWARE ENGINEER (GROWTH)" as the job title. Only
// touch a title that is ENTIRELY caps; leave genuine acronyms ("Senior QA Engineer") alone.
function fixShoutyTitle(s) {
  const t = str(s);
  if (t.length < 9 || t !== t.toUpperCase() || !/[A-Z]/.test(t)) return t;
  return t.toLowerCase().replace(/(^|[\s(/&-])([a-z])/g, (m, p, c) => p + c.toUpperCase());
}

// Real posting bodies sit under headings like these; a card strip or nav bar never has them.
const BODY_HEADINGS = /(about the role|about this role|about the job|job description|the role|responsibilities|duties|what you.{0,4}ll do|what you will do|requirements|qualifications|your profile|who you are|we offer|benefits|aufgaben|anforderungen|profil|wir bieten|functie|taken|vereisten|missions?|profil recherch)/i;

// A page's "more open roles" strip is a list of SHORT cards — a title plus a marketing tagline.
// When the AI reads those instead of the posting body it emits slogan bullets ("Code", "Build",
// "Deploy" — reported live on growtheroses.co.uk) and a one-line description. Slogans are short and
// verb-only, so the shape is detectable without another AI call; flag it and spend ONE retry.
function looksThin(out, pageText) {
  if (!out) return false;
  const body = String(pageText || '');
  if (body.length < 800 || !BODY_HEADINGS.test(body)) return false;   // page really has no body — nothing better to get
  const resp = Array.isArray(out.responsibilities)
    ? out.responsibilities.map((r) => String(r || '').trim()).filter(Boolean)
    : [];
  const desc = String(out.description || '').trim();
  if (!resp.length) return true;
  const terse = resp.filter((r) => r.split(/\s+/).length <= 3).length;
  if (terse / resp.length >= 0.5) return true;
  return resp.length < 4 && desc.length < 160;
}

// The app sends the WHOLE page's visible text plus, when the page marks one up, just its main/article
// region. Prefer the narrow one — but only when it plainly holds the posting itself, so a site whose
// <main> wraps a sidebar (or nothing) still falls back to everything we used to read.
function pickPostingText(full, main) {
  const f = String(full || '');
  const m = String(main || '');
  if (m.length >= 600 && m.length <= f.length && BODY_HEADINGS.test(m)) return m;
  return f;
}

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
  const build = (corrective) => `You extract a job posting from the plain text of a job/careers web page.
Return ONLY a JSON object with EXACTLY these keys:
"title" (string), "company" (string), "location" (string),
"employment_type" (Full-time/Part-time/Contract/Internship or ""),
"work_mode" ("Onsite"|"Hybrid"|"Remote"|""), "salary" (string or ""), "seniority" (string or ""),
"skills" (array of strings), "responsibilities" (array of bullet strings — full duties, never one-word tags),
"description" (a clean plain-text overview of the role drawn from the posting body — what the team does, what the person will own and what is expected of them; ~150-250 words),
"contact_email" (string or ""), "contact_name" (string or ""), "contact_role" (string or "").
Rules: use ONLY facts present in the text; use "" or [] when absent; never invent. JSON only, no markdown.
If the page explains how to apply by email (e.g. "To apply, send your CV to X", "email us at Y", "apply via Z", "contact <name> at <email>"), put that address in contact_email, the person's name (if any) in contact_name, and their title in contact_role. Use ONLY an email literally present in the text.

THIS IS A WHOLE WEB PAGE, not a clean posting. It normally also carries navigation, cookie notices,
contact/newsletter forms, a footer, and a "more open roles" / "similar jobs" strip — short cards that
hold only another role's title, a one-line marketing tagline and an "Apply now" link. The card for
THIS SAME role is often in that strip too.
Take "description", "responsibilities" and "skills" ONLY from the MAIN posting body: the long prose
under headings like About the Role / Job Description / Responsibilities / What you'll do /
Requirements / Qualifications / Benefits (or their non-English equivalents). Never build them from a
card tagline, a heading, a nav item or a footer — a responsibility is a real duty ("Design and ship
the payments API"), never a bare verb ("Code", "Build", "Deploy") or a slogan ("Scale impact").
"title" is the posting's OWN heading — the role this page is for. If the body prose names a different
role than the heading (some sites reuse boilerplate), keep the HEADING as "title" but still take
"description"/"responsibilities"/"skills" from that body: report what the page actually says, and
never invent content to fit the heading.
${corrective ? `
CORRECTION — your previous answer was rejected: it returned slogan-like bullets or a one-line
description, which means you read the card strip instead of the posting body. Re-read the text, find
the longest prose section, and take every bullet from THERE, in full sentences.
` : ''}${hint ? 'THE LISTING CARD SAID (a hint only — the page text always wins, and never invent content to match it): ' + hint + '\n' : ''}
JOB PAGE TEXT:
${t}`;
  const callOnce = async (corrective) => JSON.parse((await model.generateContent(build(corrective))).response.text());
  let out = null;
  try { out = await callOnce(false); } catch (e1) {
    // ⚠️ THIS USED TO BE `catch { return null }` TWICE, WHICH IS HOW A BILLING OUTAGE BECAME A
    // "successful" capture: null here means the caller falls back to title "Job application" and
    // the domain as the company, and then SAVES that. Tell the caller WHY it failed instead — an
    // out-of-credit provider is not the same as a page with nothing on it.
    try { out = await callOnce(false); } catch (e2) {
      const kind = noteAiFailure(e2, 'capture.extractFromText');
      if (isOutage(kind)) { const err = new Error('ai_unavailable'); err.aiKind = kind; throw err; }
      return null;
    }
  }
  if (looksThin(out, t)) {
    try {
      const second = await callOnce(true);
      if (second && !looksThin(second, t)) out = second;   // keep the retry ONLY if it did better
    } catch { /* keep the first answer */ }
  }
  return out;
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
    let contactEmail = '', contactName = '', contactRole = '';   // "To apply, email …" details

    // AI-extract ONLY when we lack substance — keeps the common (already-rich) case free.
    const needExtract = (responsibilities.length < 2 || !description || !title || !company);
    const postingText = pickPostingText(b.pageText, b.mainText);
    if (needExtract && str(postingText).length >= 120) {
      const hint = [title && ('title=' + title), company && ('company=' + company)].filter(Boolean).join('; ');
      let out = null;
      try {
        out = await extractFromText(postingText, hint);
      } catch (e) {
        // ⚠️ THE PROVIDER IS DOWN, NOT THE PAGE. Falling through here would stamp this job with
        // title "Job application" and the domain as the employer and SAVE it — which is exactly
        // what happened during the 2026-08-14 credit outage: Fetch job reported success and the
        // user got a junk row. Refuse, and say so, UNLESS the client already sent enough to stand
        // on its own (a rich card from search) — in that case there is nothing to be sorry about.
        if (e && e.aiKind) {
          const haveOwn = !!title && !!company && (responsibilities.length >= 2 || !!description);
          if (!haveOwn) return outageResponse(res, e.aiKind, 'Reading this job');
        } else {
          throw e;
        }
      }
      if (out && typeof out === 'object') {
        title       = title       || fixShoutyTitle(out.title);
        company     = company     || str(out.company);
        location    = location    || str(out.location);
        jobType     = jobType     || str(out.employment_type);
        workMode    = workMode    || str(out.work_mode);
        experience  = experience  || str(out.seniority);
        salary      = salary      || str(out.salary);
        description = description || str(out.description);
        if (arr(out.responsibilities).length > responsibilities.length) responsibilities = arr(out.responsibilities);
        if (arr(out.skills).length > skills.length) skills = arr(out.skills);
        contactEmail = str(out.contact_email); contactName = str(out.contact_name); contactRole = str(out.contact_role);
      }
    }
    if (!title) title = 'Job application';
    if (!company) company = domainOf(url) || 'Company';
    responsibilities = responsibilities.slice(0, 20);
    // Shape-check whatever came back (ours OR the client's card, which may carry another pipeline's
    // output): a requirement sentence stored as a "skill" gets rendered as a chip. See utils/jobFields.
    skills = cleanSkills(skills);
    if (!experience) experience = seniorityFromTitle(title);

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

    // "To apply, email …" — persist the contact the page named so the job's contact section shows it
    // and the in-app "apply by email" flow can use it. Upsert on (job_id,email) → idempotent.
    const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
    // Domain-qualify the infra names — a bare "sentry" would reject real employers like
    // careers@sentry.io / jobs@sentryinsurance.com.
    const BAD_EMAIL = /noreply|no-reply|donotreply|do-not-reply|postmaster|mailer-daemon|example\.(com|org)|@sentry\.io|@wixpress\.com/i;
    const capturedContacts = [];
    if (contactEmail && EMAIL_RE.test(contactEmail) && !BAD_EMAIL.test(contactEmail) && contactEmail.length <= 100) {
      const cName = contactName || contactEmail.split('@')[0];
      const cRole = contactRole || 'Recruiter';
      try {
        await jobService.addJobContact(jobId, cName, cRole, contactEmail, null, null, null, null);
        capturedContacts.push({ name: cName, role: cRole, email: contactEmail, verified: false, avatarColor: ['#06B6D4', '#3B82F6'] });
      } catch (e) { /* best-effort; upsert is idempotent */ }
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
      job: { id: String(jobId), title, company, location, jobType, workMode, experience, salary, responsibilities, skills, description, url, contacts: capturedContacts },
    });
  } catch (e) {
    console.error('[capture] error:', e && e.message);
    return res.status(500).json({ error: 'Could not capture this job.' });
  }
}

// extractFromText is also reused by discover's fetch-detail as its SPA/iframe-proof fallback:
// a job board that renders into an iframe or late-hydrates isn't in the page's outerHTML, but IS
// in its visible text. Same bounded cost (1 call + 1 retry, 12k cap).
module.exports = { captureJob, extractFromText, pickPostingText };
