// AI Hub — new feature. Safe to delete without affecting existing app.

'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const dbConfig = require('../../db-config');

// ─── helpers ─────────────────────────────────────────────────────────────────

const LOGO_COLORS = [
    ['#06B6D4', '#3B82F6'],
    ['#8B5CF6', '#6D28D9'],
    ['#10B981', '#059669'],
    ['#F59E0B', '#D97706'],
    ['#EF4444', '#DC2626'],
    ['#635BFF', '#4338CA'],
    ['#EC4899', '#DB2777'],
];

function logoColorFor(name) {
    return LOGO_COLORS[(name.charCodeAt(0) || 0) % LOGO_COLORS.length];
}

function safeParseJSON(str, fallback) {
    if (!str) return fallback;
    try { return JSON.parse(str); } catch { return fallback; }
}

function flattenSkills(resumeMetadata) {
    const skills = new Set();
    safeParseJSON(resumeMetadata.skills, []).forEach(s => skills.add(s));
    const ts = safeParseJSON(resumeMetadata.technical_skills, {});
    Object.values(ts).forEach(arr => Array.isArray(arr) && arr.forEach(s => skills.add(s)));
    safeParseJSON(resumeMetadata.soft_skills, []).forEach(s => skills.add(s));
    return [...skills];
}

async function fetchCareersPageText(url) {
    try {
        const resp = await axios.get(url, {
            timeout: 12000,
            maxContentLength: 2 * 1024 * 1024,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                Accept: 'text/html,application/xhtml+xml',
            },
        });
        const $ = cheerio.load(resp.data);
        $('script, style, nav, footer, header, noscript, iframe').remove();
        return $('body').text().replace(/\s+/g, ' ').trim().slice(0, 10000);
    } catch (err) {
        console.log(`[aiHub] Could not pre-fetch page (${err.message}) — Gemini will search directly`);
        return '';
    }
}

// ─── Gemini job-search + match ────────────────────────────────────────────────

async function findAndMatchJobs(companyInput, careersPageText, candidateProfile) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
        model: 'gemini-2.5-flash',
        tools: [{ googleSearch: {} }],
    });

    const prompt = `You are a job-matching AI assistant. A candidate has given you a company URL or name and wants to see ALL currently open job positions there, matched against their profile.

COMPANY / URL: ${companyInput}

CANDIDATE PROFILE:
- Skills: ${candidateProfile.skills.join(', ') || 'Not specified'}
- Experience: ${candidateProfile.experience_years || 0} years
- Previous job titles: ${(candidateProfile.job_titles || []).join(', ') || 'Not specified'}
- Industries: ${(candidateProfile.industries || []).join(', ') || 'Not specified'}
- Summary: ${candidateProfile.summary || 'Not provided'}

${careersPageText ? `CAREERS PAGE TEXT (pre-fetched — use as primary source):
"""
${careersPageText}
"""
` : ''}

TASK:
1. Use Google Search to find the company's current open job listings. Search for:
   - "[company name] open positions" or "[company name] jobs"
   - Visit the careers/jobs page of the URL provided
   - Look for ALL distinct job roles currently advertised
2. For every open position found, extract full details
3. Score each job against the candidate's profile (0–100) based on skill overlap and experience fit

Return ONLY a valid JSON object (no markdown fences, no explanation) in EXACTLY this structure:
{
  "company_name": "Full official company name",
  "sub_info": "City, Country · Industry",
  "jobs": [
    {
      "title": "Exact job title as advertised",
      "location": "City, Country or Remote",
      "experience": "X+ years or as stated",
      "salary": "range if listed, otherwise null",
      "job_type": "Full-time",
      "urgent": false,
      "match_score": 82,
      "skills": ["skill1", "skill2", "skill3"],
      "job_url": "https://direct-apply-url or null"
    }
  ]
}

Rules:
- Include EVERY open position found — do not filter or limit
- Set match_score based on how well this candidate fits (0=no match, 100=perfect match)
- Sort jobs by match_score descending
- If you genuinely cannot find any open positions, return an empty "jobs" array
- Never invent jobs that are not actually advertised
- skills array must contain the actual required skills for that specific role`;

    const result = await model.generateContent(prompt);
    let text = result.response.text().trim();

    // Strip any accidental markdown fences
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    // Find the outermost JSON object
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('Gemini did not return valid JSON');
    return JSON.parse(text.slice(start, end + 1));
}

// ─── shape into Employer type ─────────────────────────────────────────────────

function buildEmployer(companyInput, geminiResult) {
    const name = geminiResult.company_name || companyInput;
    const jobs = (geminiResult.jobs || []).map((j, i) => ({
        id: `${name.toLowerCase().replace(/\s+/g, '-')}-job-${i + 1}`,
        title: j.title || 'Open Position',
        location: j.location || 'Location TBD',
        experience: j.experience || 'Not specified',
        salary: j.salary || 'Not listed',
        jobType: j.job_type || 'Full-time',
        urgent: !!j.urgent,
        matchScore: j.match_score || 0,
        applyUrl: j.job_url || null,
        skills: Array.isArray(j.skills) ? j.skills : [],
        contacts: [],
    }));

    return {
        id: `emp-${name.toLowerCase().replace(/\s+/g, '-')}`,
        name,
        subInfo: geminiResult.sub_info || `${companyInput} · Careers Portal`,
        logoColor: logoColorFor(name),
        logoInitial: name.charAt(0).toUpperCase(),
        status: 'watching',
        jobs,
    };
}

// ─── route handlers ───────────────────────────────────────────────────────────

/**
 * POST /api/ai-hub/analyze-wishlist
 * Body: { companies: string[] }
 */
async function analyzeWishlist(req, res) {
    try {
        const { companies } = req.body;
        if (!Array.isArray(companies) || companies.length === 0) {
            return res.status(400).json({ error: 'companies must be a non-empty array' });
        }
        return res.json({ matches: 0, sources: companies.length });
    } catch (error) {
        console.error('[aiHub] analyzeWishlist error:', error);
        return res.status(500).json({ error: 'Failed to analyze wishlist' });
    }
}

/**
 * GET /api/ai-hub/jobs?company={URL or name}
 *
 * 1. Load the user's parsed resume skills from resume_metadata
 * 2. Fetch the careers page HTML (best-effort, continues if it fails)
 * 3. Send everything to Gemini with Google Search grounding
 * 4. Return the matched Employer + Jobs object
 */
async function getJobMatches(req, res) {
    try {
        const { company } = req.query;
        if (!company) {
            return res.status(400).json({ error: 'company query parameter is required' });
        }

        const userId = req.user.id;

        // 1. Load resume metadata
        const resumeMetadata = await dbConfig.get(
            'SELECT skills, technical_skills, soft_skills, experience_years, job_titles, industries, summary FROM resume_metadata WHERE user_id = ? AND parse_status = ?',
            [userId, 'done']
        );

        if (!resumeMetadata) {
            return res.status(400).json({
                error: 'Resume not analysed yet. Please upload your resume in Profile → the system will process it automatically.',
            });
        }

        const candidateProfile = {
            skills: flattenSkills(resumeMetadata),
            experience_years: resumeMetadata.experience_years,
            job_titles: safeParseJSON(resumeMetadata.job_titles, []),
            industries: safeParseJSON(resumeMetadata.industries, []),
            summary: resumeMetadata.summary || '',
        };

        // 2. Pre-fetch careers page (best-effort)
        const careersUrl = company.startsWith('http') ? company : `https://${company}`;
        const careersPageText = await fetchCareersPageText(careersUrl);

        // 3. Ask Gemini to find + match jobs
        console.log(`[aiHub] Asking Gemini to find jobs at: ${company}`);
        const geminiResult = await findAndMatchJobs(company, careersPageText, candidateProfile);
        console.log(`[aiHub] Gemini found ${geminiResult.jobs?.length ?? 0} jobs at ${company}`);

        // 4. Shape and return
        const employer = buildEmployer(company, geminiResult);
        return res.json(employer);

    } catch (error) {
        console.error('[aiHub] getJobMatches error:', error.message);
        return res.status(500).json({ error: `Failed to fetch job matches: ${error.message}` });
    }
}

/**
 * POST /api/ai-hub/verify-email
 * Body: { email: string }
 *
 * TODO: SMTP handshake probing + LinkedIn cross-referencing
 */
async function verifyEmail(req, res) {
    try {
        const { email } = req.body;
        if (!email || typeof email !== 'string') {
            return res.status(400).json({ error: 'email is required' });
        }
        return res.json({ verified: true, confidence: 0.94 });
    } catch (error) {
        console.error('[aiHub] verifyEmail error:', error);
        return res.status(500).json({ error: 'Failed to verify email' });
    }
}

/**
 * POST /api/ai-hub/jobs/:jobId/contacts
 * Body: { name, role, email }
 *
 * TODO: persist to ai_hub_contacts, trigger async email verification
 */
async function addContactToJob(req, res) {
    try {
        const { jobId } = req.params;
        const { name, role, email } = req.body;
        if (!name || !role || !email) {
            return res.status(400).json({ error: 'name, role, and email are required' });
        }
        const contact = {
            id: `contact-${Date.now()}`,
            name, role, email,
            verified: false,
            avatarColor: ['#64748B', '#475569'],
        };
        console.log(`[aiHub] Contact added to job ${jobId}:`, name);
        return res.status(201).json(contact);
    } catch (error) {
        console.error('[aiHub] addContactToJob error:', error);
        return res.status(500).json({ error: 'Failed to add contact' });
    }
}

module.exports = { analyzeWishlist, getJobMatches, verifyEmail, addContactToJob };
