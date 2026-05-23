// AI Hub — new feature. Safe to delete without affecting existing app.

'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const dbConfig = require('../../db-config');
const jobService = require('../services/jobService');

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

const AVATAR_COLORS = [
    ['#06B6D4', '#3B82F6'],
    ['#8B5CF6', '#6D28D9'],
    ['#10B981', '#059669'],
    ['#F59E0B', '#D97706'],
    ['#EF4444', '#DC2626'],
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

const HTTP_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml',
};

/** Scrape a single URL — returns its body text and all internal links */
async function scrapePage(url, origin, usePuppeteer = false) {
    try {
        let html = '';
        if (usePuppeteer) {
            const puppeteer = require('puppeteer');
            const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
            const page = await browser.newPage();
            // Pretend to be a real browser to avoid blocks
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36');
            await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
            html = await page.content();
            await browser.close();
        } else {
            const resp = await axios.get(url, {
                timeout: 12000,
                maxContentLength: 2 * 1024 * 1024,
                headers: HTTP_HEADERS,
            });
            html = resp.data;
        }

        const $ = cheerio.load(html);

        const seen = new Set();
        const links = [];
        $('a[href]').each((_, el) => {
            try {
                const href = $(el).attr('href') || '';
                if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
                const full = href.startsWith('http') ? href : new URL(href, url).href;
                if (!full.startsWith(origin) || seen.has(full)) return;
                seen.add(full);
                const text = $(el).text().replace(/\s+/g, ' ').trim().slice(0, 120);
                links.push({ url: full, text });
            } catch { /* malformed href */ }
        });

        $('script, style, nav, footer, header, noscript, iframe').remove();
        const pageText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 6000);

        return { pageText, links };
    } catch {
        return { pageText: '', links: [] };
    }
}

/**
 * Heuristic: does this URL look like an individual job detail page
 * (as opposed to a listing/search/category page)?
 * Individual job pages typically have a numeric ID, or a specific slug
 * that is much more specific than the root listing path.
 */
function looksLikeJobDetailUrl(url, listingUrl) {
    try {
        const u = new URL(url);
        const l = new URL(listingUrl);
        const path = u.pathname;
        // Must be longer / more specific than the listing URL path
        if (path === l.pathname) return false;
        
        // Exclude common listing paths that might look like details
        if (/(search|results|all-jobs|vacatures$|jobs$|careers$)/i.test(path)) return false;

        // Common individual-job path patterns across many ATS/CMS systems
        if (/\/(jobb?|vacatur[ae]|vacancy|vacancies|position|opening|role|career|requisition|posting)s?\/[0-9a-z_-]+/i.test(path)) return true;
        // Path contains a numeric segment (likely a job ID)
        if (/\/\d{4,}\//.test(path) || /\/\d{4,}$/.test(path)) return true;
        return false;
    } catch {
        return false;
    }
}

/**
 * Fetches the careers page and extracts body text + individual job links.
 *
 * If the main page is JS-rendered (few/no individual job links found),
 * tries common "all jobs" URL variants derived from the same domain/path
 * so that statically-served index pages are used as fallback.
 */
async function fetchCareersPageData(url) {
    try {
        const origin = new URL(url).origin;
        const { pathname } = new URL(url);
        const parentPath = pathname.replace(/\/[^/]*$/, ''); // strip last segment

        // ── Primary scrape ────────────────────────────────────────────────────
        let primary = await scrapePage(url, origin, false);
        let jobDetailLinks = primary.links.filter(l => looksLikeJobDetailUrl(l.url, url));
        console.log(`[aiHub] Primary scrape: ${primary.links.length} links, ${jobDetailLinks.length} job-detail-like`);

        if (jobDetailLinks.length < 3) {
            console.log(`[aiHub] Few links found. Attempting Puppeteer scrape for JS-rendered content...`);
            try {
                const pupPrimary = await scrapePage(url, origin, true);
                const pupJobDetailLinks = pupPrimary.links.filter(l => looksLikeJobDetailUrl(l.url, url));
                console.log(`[aiHub] Puppeteer scrape: ${pupPrimary.links.length} links, ${pupJobDetailLinks.length} job-detail-like`);
                if (pupJobDetailLinks.length > jobDetailLinks.length) {
                    primary = pupPrimary;
                    jobDetailLinks = pupJobDetailLinks;
                }
            } catch (err) {
                console.log(`[aiHub] Puppeteer scrape failed:`, err.message);
            }
        }

        if (jobDetailLinks.length >= 3) {
            // Good enough — return primary results
            return { pageText: primary.pageText, jobLinks: jobDetailLinks };
        }

        // ── Fallback: try sibling "all jobs" style pages ──────────────────────
        // Build candidate fallback URLs from common patterns used by job boards
        const fallbackPaths = [
            `${parentPath}/all-jobs`,
            `${parentPath}/alle-vacatures`,
            `${parentPath}/all-vacancies`,
            `${parentPath}/jobs`,
            '/all-jobs',
            '/jobs',
            '/vacatures',
            '/careers/jobs',
        ];
        // Also include any link on the main page that itself looks like an "all jobs" index
        primary.links
            .filter(l => /all.?jobs|alle.?vacatures|all.?vacancies|vacature.*overzicht/i.test(l.url + l.text))
            .slice(0, 3)
            .forEach(l => fallbackPaths.unshift(new URL(l.url).pathname));

        const dedupedFallbacks = [...new Set(fallbackPaths)]
            .map(p => `${origin}${p}`)
            .filter(u => u !== url);

        for (const fbUrl of dedupedFallbacks) {
            let fb = await scrapePage(fbUrl, origin, false);
            let fbJobLinks = fb.links.filter(l => looksLikeJobDetailUrl(l.url, fbUrl));
            console.log(`[aiHub] Fallback ${fbUrl}: ${fbJobLinks.length} job-detail links`);
            
            if (fbJobLinks.length < 3) {
                try {
                    const pupFb = await scrapePage(fbUrl, origin, true);
                    const pupFbJobLinks = pupFb.links.filter(l => looksLikeJobDetailUrl(l.url, fbUrl));
                    console.log(`[aiHub] Puppeteer Fallback ${fbUrl}: ${pupFbJobLinks.length} job-detail links`);
                    if (pupFbJobLinks.length > fbJobLinks.length) {
                        fb = pupFb;
                        fbJobLinks = pupFbJobLinks;
                    }
                } catch (e) { /* ignore */ }
            }

            if (fbJobLinks.length >= 3) {
                return { pageText: fb.pageText || primary.pageText, jobLinks: fbJobLinks };
            }
        }

        // Nothing worked well — return what we have (even if empty, Gemini will Google-search)
        console.log(`[aiHub] No individual job links found via scraping — Gemini will use Google Search`);
        return { pageText: primary.pageText, jobLinks: [] };

    } catch (err) {
        console.log(`[aiHub] fetchCareersPageData error (${err.message}) — Gemini will search directly`);
        return { pageText: '', jobLinks: [] };
    }
}

// withSearch=true only when we have no scraped links and need Gemini to find the page itself
function geminiModel(withSearch = false) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');
    const genAI = new GoogleGenerativeAI(apiKey);
    const cfg = withSearch
        ? { model: 'gemini-2.5-flash', tools: [{ googleSearch: {} }] }
        : { model: 'gemini-2.5-flash' };
    return genAI.getGenerativeModel(cfg);
}

function parseJsonObject(text) {
    const t = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('No JSON object found in response');
    return JSON.parse(t.slice(start, end + 1));
}

function parseJsonArray(text) {
    const t = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const start = t.indexOf('[');
    const end = t.lastIndexOf(']');
    if (start === -1 || end === -1) return [];
    return JSON.parse(t.slice(start, end + 1));
}

// ─── Phase 1: Find all job listings + their URLs ──────────────────────────────

async function findJobListings(companyInput, pageData, candidateProfile) {
    // Only enable Google Search when we have no scraped links — otherwise Gemini ignores our links
    const hasLinks = pageData.jobLinks.length > 0;
    const model = geminiModel(!hasLinks);
    const { pageText, jobLinks } = pageData;

    const linksSection = hasLinks
        ? `LINKS EXTRACTED DIRECTLY FROM THE PAGE HTML — these are the ONLY valid job_url values:
${jobLinks.slice(0, 300).map(l => `  ${l.url}  |  "${l.text}"`).join('\n')}`
        : '';

    const candidateSkills = (candidateProfile?.skills || []).join(', ') || 'Not specified';
    const candidateTitles = (candidateProfile?.job_titles || []).join(', ') || 'Not specified';

    const prompt = `You are a job listing identifier. Find the open positions at this company that best match the candidate profile below.

COMPANY / URL: ${companyInput}

CANDIDATE PROFILE (use this to filter relevant jobs — return up to 30 best matches):
- Skills: ${candidateSkills}
- Previous titles: ${candidateTitles}

${pageText ? `PAGE TEXT (pre-fetched from the careers page):
"""
${pageText}
"""
` : ''}
${linksSection}

${hasLinks ? `CRITICAL INSTRUCTIONS — YOU MUST FOLLOW THESE EXACTLY:
1. The "LINKS EXTRACTED" block above is the complete set of individual job pages scraped from the real HTML.
2. Select up to 30 links that are most relevant to the candidate profile above.
3. The job_url for each job MUST be copied EXACTLY as it appears in the links list above — character for character.
4. DO NOT use Google Search. DO NOT visit any URL. DO NOT construct or modify any URL.
5. Extract the job title from the link text next to each URL.` : `CRITICAL INSTRUCTIONS:
1. Use Google Search to find specific, individual job postings at "${companyInput}".
2. You MUST return the ACTUAL DIRECT URL (deep link) to the specific job detail page for each job.
3. DO NOT return generic search pages, job boards, or main career portal URLs (e.g. avoiding /jobs or /vacatures without a specific job slug).
4. Each job MUST have a unique, direct URL that leads directly to the job description.`}

Return ONLY valid JSON (no markdown, no explanation):
{
  "company_name": "Full official company name in English",
  "sub_info": "City, Country · Industry",
  "careers_page_url": "https://url-of-the-jobs-listing-page",
  "jobs": [
    { "title": "Job Title in English", "job_url": "${hasLinks ? "https://exact-url-copied-from-links-list" : "https://exact-direct-url-to-specific-job"}" }
  ]
}

STRICT RULES:
- job_url must be an INDIVIDUAL job detail page URL copied verbatim from the links list
- NEVER use a listing/category/search page as a job_url
- NEVER construct, guess, or modify any URL
- If no individual link exists for a job, set job_url to null
- All output in English, proper title case`;

    const result = await model.generateContent(prompt);
    return parseJsonObject(result.response.text().trim());
}

// ─── Phase 2: Fetch full details from each job's individual page ──────────────

async function fetchJobDetailsBatch(jobBatch, careersUrl, candidateProfile) {
    // Enable Google Search so Gemini can search for the specific job details if the scraped text is insufficient (e.g. for SPAs)
    const model = geminiModel(true);

    // Pre-scrape each job page so we have real text to feed Gemini alongside the URL.
    // Use scrapePage directly (not fetchCareersPageData) — individual job pages don't need
    // the fallback logic, which would mistakenly follow links back to the listing page.
    const scrapedPages = await Promise.all(
        jobBatch.map(async (j) => {
            const origin = (() => { try { return new URL(j.job_url).origin; } catch { return ''; } })();
            let d = await scrapePage(j.job_url, origin, false);
            // If text is very short, it's likely an SPA. Try puppeteer.
            if (!d.pageText || d.pageText.length < 500) {
                try {
                    const pupD = await scrapePage(j.job_url, origin, true);
                    if (pupD.pageText && pupD.pageText.length > d.pageText.length) {
                        d = pupD;
                    }
                } catch (e) {
                    console.error(`[aiHub] Puppeteer detail scrape failed for ${j.job_url}:`, e.message);
                }
            }
            return { job: j, pageText: d.pageText };
        })
    );

    const urlLines = scrapedPages
        .map((s, i) => {
            const pageSnippet = s.pageText
                ? `\n   PAGE CONTENT:\n   """\n   ${s.pageText.slice(0, 3000)}\n   """`
                : '';
            return `${i + 1}. Title: "${s.job.title}" — URL: ${s.job.job_url}${pageSnippet}`;
        })
        .join('\n\n');

    const prompt = `You are a job detail extractor. For each URL below, extract every detail about the job.
If the PAGE CONTENT provided is empty or missing details (e.g. because it's a JavaScript-heavy page), you MUST use the Google Search tool to search for the specific job title and company to find the actual job description, salary, and contact person.

JOB DETAIL PAGES TO VISIT:
${urlLines}

For EACH page, extract:
1. Confirmed job title — read from the H1/heading on the page (translate to English, proper title case with spaces)
2. job_url — copy the URL EXACTLY as given above for that entry. Do not change it.
3. Location — city, country, or "Remote"
4. Required experience — e.g. "3+ years", "Senior level"
5. Salary / pay — look in every section: header, sidebar, "Compensation", "What we offer", "Benefits", "Salary indication". Include currency and range (e.g. "€3,500–€4,200/month"). Set null ONLY if truly absent everywhere.
6. Employment type — Full-time / Part-time / Contract / Freelance
7. Required skills — from "Requirements", "You bring", "Must have", "Profile" sections
8. Contact person — look in "Contact", "Questions?", "Your recruiter", "Apply via", "Hiring manager" sections. Extract full name, role/title, email address, phone number.
9. urgent — true only if the page explicitly says "Urgent" or "ASAP", otherwise false

CANDIDATE PROFILE (for scoring each role 0–100 based on skill and experience match):
- Skills: ${candidateProfile.skills.join(', ') || 'Not specified'}
- Experience: ${candidateProfile.experience_years || 0} years
- Previous titles: ${(candidateProfile.job_titles || []).join(', ') || 'Not specified'}

Return ONLY a valid JSON array (no markdown), one object per URL in the exact same order:
[
  {
    "title": "Properly spaced English job title",
    "job_url": "https://exact-url-as-given-above",
    "location": "City, Country or Remote",
    "experience": "X+ years or as stated",
    "salary": "€3,500–€4,200/month or null",
    "job_type": "Full-time",
    "urgent": false,
    "match_score": 82,
    "skills": ["skill1", "skill2"],
    "contacts": [
      { "name": "Full Name", "role": "Recruiter", "email": "name@company.com or null", "phone": "+31 6 12345678 or null" }
    ]
  }
]

STRICT RULES:
- job_url must be the SAME specific URL you were asked to visit — not the listing page, not a search page
- salary: include exact figures and currency from the page. null only if completely absent
- ALL output in English — translate titles, locations, sections
- Proper title case: every word capitalised, spaces between words (e.g. "DevOps Consultant Rotterdam" not "DevOpsconsultantRotterdam")`;

    const result = await model.generateContent(prompt);
    try {
        return parseJsonArray(result.response.text().trim());
    } catch {
        console.error('[aiHub] Phase 2 batch parse failed — skipping batch');
        return [];
    }
}

// ─── Shape raw job data into typed Job object ─────────────────────────────────

function buildJob(raw, index, slug, careersUrl) {
    const contacts = (Array.isArray(raw.contacts) ? raw.contacts : [])
        .filter(c => c && c.name)
        .map((c, ci) => ({
            id: `${slug}-job${index + 1}-c${ci + 1}`,
            name: c.name,
            role: c.role || 'Recruiter',
            email: c.email || '',
            phone: c.phone || null,
            verified: false,
            avatarColor: AVATAR_COLORS[ci % AVATAR_COLORS.length],
        }));

    const applyUrl = raw.job_url && raw.job_url.startsWith('http') ? raw.job_url : careersUrl;

    return {
        id: `${slug}-job-${index + 1}`,
        title: raw.title || 'Open Position',
        location: raw.location || 'Location TBD',
        experience: raw.experience || 'Not specified',
        salary: raw.salary || 'Not listed',
        jobType: raw.job_type || 'Full-time',
        urgent: !!raw.urgent,
        matchScore: raw.match_score || 0,
        applyUrl,
        skills: Array.isArray(raw.skills) ? raw.skills : [],
        contacts,
    };
}

// ─── route handlers ───────────────────────────────────────────────────────────

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
 * Two-phase progressive streaming:
 *   Phase 1  — Gemini finds all job titles + their individual URLs (~15s)
 *   Phase 2  — Gemini visits each job URL in batches of 3, emitting partial results
 *              as each batch completes so the client sees jobs appear incrementally.
 *
 * Returns 202 { jobId } immediately. Client polls /api/job-status/:jobId.
 * During processing, polls return partial employer data (jobs found so far).
 */
async function getJobMatches(req, res) {
    try {
        const { company } = req.query;
        if (!company) {
            return res.status(400).json({ error: 'company query parameter is required' });
        }

        const userId = req.user.id;

        const resumeMetadata = await dbConfig.get(
            'SELECT skills, technical_skills, soft_skills, experience_years, job_titles, industries, summary FROM resume_metadata WHERE user_id = ? AND parse_status = ?',
            [userId, 'done']
        );

        if (!resumeMetadata) {
            return res.status(400).json({
                error: 'Resume not analysed yet. Please upload your resume in Profile → the system will process it automatically.',
            });
        }

        const jobId = await jobService.createJob(userId, 'ai_hub_job_search', { company });
        res.status(202).json({ jobId, status: 'pending' });

        // ── Background processing ──────────────────────────────────────────────
        (async () => {
            try {
                await jobService.startJob(jobId);

                const candidateProfile = {
                    skills: flattenSkills(resumeMetadata),
                    experience_years: resumeMetadata.experience_years,
                    job_titles: safeParseJSON(resumeMetadata.job_titles, []),
                    industries: safeParseJSON(resumeMetadata.industries, []),
                    summary: resumeMetadata.summary || '',
                };

                // ── Phase 1: get job list + URLs ──────────────────────────────
                const careersUrl = company.startsWith('http') ? company : `https://${company}`;
                const pageData = await fetchCareersPageData(careersUrl);

                console.log(`[aiHub:${jobId}] Phase 1 — finding job listings at: ${company}`);
                const listResult = await findJobListings(company, pageData, candidateProfile);
                const resolvedCareersUrl = listResult.careers_page_url || careersUrl;

                const name = listResult.company_name || company;
                const slug = name.toLowerCase().replace(/\s+/g, '-');
                const baseEmployer = {
                    id: `emp-${slug}`,
                    name,
                    subInfo: listResult.sub_info || `${company} · Careers Portal`,
                    logoColor: logoColorFor(name),
                    logoInitial: name.charAt(0).toUpperCase(),
                    status: 'watching',
                };

                const rawList = listResult.jobs || [];
                const withUrl = rawList.filter(j => j.job_url && j.job_url.startsWith('http'));
                const withoutUrl = rawList.filter(j => !j.job_url || !j.job_url.startsWith('http'));

                console.log(`[aiHub:${jobId}] Phase 1 found ${rawList.length} jobs (${withUrl.length} with URLs)`);

                // Emit jobs-without-URL immediately with basic info so user sees something fast
                const immediateJobs = withoutUrl.map((j, i) =>
                    buildJob({ ...j, job_url: resolvedCareersUrl }, i, slug, resolvedCareersUrl)
                );

                let completedJobs = [...immediateJobs];
                let jobIndex = immediateJobs.length;

                if (immediateJobs.length > 0) {
                    await jobService.updateJobPartialResult(jobId, {
                        ...baseEmployer,
                        jobs: completedJobs,
                    });
                    await jobService.updateJobProgress(jobId, 15);
                }

                // ── Phase 2: visit each job URL in batches of 3 ───────────────
                const BATCH_SIZE = 3;

                for (let i = 0; i < withUrl.length; i += BATCH_SIZE) {
                    const batch = withUrl.slice(i, i + BATCH_SIZE);
                    console.log(`[aiHub:${jobId}] Phase 2 batch ${Math.floor(i / BATCH_SIZE) + 1} — visiting ${batch.length} job pages`);

                    let detailedBatch = [];
                    try {
                        detailedBatch = await fetchJobDetailsBatch(batch, resolvedCareersUrl, candidateProfile);
                    } catch (err) {
                        console.error(`[aiHub:${jobId}] Phase 2 batch failed:`, err.message);
                        // Fall back to basic job info from Phase 1 for this batch
                        detailedBatch = batch.map(j => ({ ...j, contacts: [] }));
                    }

                    // Build job objects — job_url is ALWAYS from Phase 1 (scraped HTML), never from Gemini
                    const batchJobs = batch.map((phase1Job, bi) => {
                        const detail = detailedBatch[bi] || phase1Job;
                        return buildJob(
                            {
                                title: detail.title || phase1Job.title,
                                job_url: phase1Job.job_url,  // pinned to scraped URL — Gemini cannot change this
                                location: detail.location,
                                experience: detail.experience,
                                salary: detail.salary,
                                job_type: detail.job_type,
                                urgent: detail.urgent,
                                match_score: detail.match_score,
                                skills: detail.skills,
                                contacts: detail.contacts,
                            },
                            jobIndex + bi,
                            slug,
                            resolvedCareersUrl
                        );
                    });

                    completedJobs = [...completedJobs, ...batchJobs];
                    jobIndex += batchJobs.length;

                    const progress = 15 + Math.floor(((i + BATCH_SIZE) / withUrl.length) * 80);
                    await Promise.all([
                        jobService.updateJobPartialResult(jobId, { ...baseEmployer, jobs: completedJobs }),
                        jobService.updateJobProgress(jobId, Math.min(progress, 95)),
                    ]);

                    console.log(`[aiHub:${jobId}] Partial update: ${completedJobs.length} jobs so far`);
                }

                // Sort final list by match score descending
                completedJobs.sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));

                await jobService.completeJob(jobId, { ...baseEmployer, jobs: completedJobs });
                console.log(`[aiHub:${jobId}] Done — ${completedJobs.length} total jobs`);

            } catch (err) {
                console.error(`[aiHub:${jobId}] Background job failed:`, err.message);
                await jobService.failJob(jobId, err.message);
            }
        })();

    } catch (error) {
        console.error('[aiHub] getJobMatches error:', error.message);
        return res.status(500).json({ error: `Failed to start job search: ${error.message}` });
    }
}

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

const getDashboard = async (req, res) => {
    // Return a dummy "Coming Soon" state so the mobile app renders a maintenance message
    // without requiring an app store update.
    return res.json({
        dashboard: [
            {
                jobId: 'coming-soon-job',
                status: 'completed',
                progress: 100,
                employer: {
                    id: 'maintenance',
                    name: 'Jobs Dashboard (Coming Soon)',
                    subInfo: 'Feature Under Maintenance',
                    logoColor: ['#F59E0B', '#D97706'],
                    logoInitial: '🚧',
                    status: 'active',
                    jobs: [
                        {
                            id: 'maintenance-job-1',
                            title: 'We are upgrading the AI Jobs Hub!',
                            location: 'System Update',
                            experience: 'N/A',
                            salary: 'N/A',
                            jobType: 'Maintenance',
                            urgent: false,
                            matchScore: 0,
                            skills: ['This feature is currently being upgraded.', 'Please check back in our next release!'],
                            contacts: []
                        }
                    ]
                },
                updatedAt: new Date().toISOString()
            }
        ]
    });
};

const removeDashboardItem = async (req, res) => {
    return res.json({ success: true });
};

module.exports = { analyzeWishlist, getJobMatches, verifyEmail, addContactToJob, getDashboard, removeDashboardItem };
