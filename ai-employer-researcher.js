'use strict';

/**
 * AI Employer Researcher
 *
 * One Gemini call that extracts all structured employer data:
 * brand, tech stack, clients, recent activity, team contacts, locations.
 *
 * Runs in parallel with cover letter generation — zero extra wall-clock time on first visit.
 * Results are cached in DB tables so subsequent generations are instant (no AI call).
 *
 * Output: Promise<EmployerResearch>
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');

const RESEARCH_PROMPT = `You are an employer research analyst. Visit the company website below and extract structured data about this employer. Use Google Search aggressively on the URL and company name.

Employer Website: {employer_url}

Extract ALL of the following:

1. IDENTITY — full official company name, founding year (integer or null), company size (e.g. "50-200 employees"), primary industry, core mission or tagline.

2. BRAND — primary brand color used in logo/header/buttons (6-digit hex e.g. "#1A73E8", default "#262633" if unknown), primary font family used in headings/body (e.g. "Inter", "Roboto", default "Lato" if unknown).

3. TECHNOLOGIES — every named product, SaaS platform, service, language, framework, cloud provider, database they use or have built. Include a category for each: "product", "language", "framework", "cloud", "database", "integration", or "other".

4. CLIENTS — actual named client companies (not generic descriptions). Include the industry they serve and any notes (e.g. "enterprise contract", "government deal", "named case study"). Return up to 8.

5. RECENT ACTIVITY — last 2 years: product launches, partnerships, acquisitions, funding rounds, awards, new offices. Include activity_type: "launch", "partnership", "funding", "award", "acquisition", or "expansion".

6. KEY CONTACTS — any publicly listed hiring managers, department heads, or leadership names. Include their role and where found (e.g. "LinkedIn", "website About page", "job posting").

Return ONLY this JSON object with nothing before or after it:
{
  "employer_name": "Full official company name",
  "founded_year": 2010,
  "company_size": "200-500 employees",
  "industry": "FinTech / Payments",
  "mission": "Core mission or tagline",
  "brand_color": "#xxxxxx",
  "font_name": "Font Family Name",
  "technologies": [
    { "name": "React", "category": "framework" },
    { "name": "AWS", "category": "cloud" }
  ],
  "clients": [
    { "client_name": "Accenture", "industry": "Consulting", "notes": "named case study" }
  ],
  "recent_activity": [
    { "activity_type": "funding", "description": "Raised $50M Series B in Jan 2024" }
  ],
  "key_contacts": [
    { "name": "Jane Smith", "role": "Head of Engineering", "source": "LinkedIn" }
  ]
}`;

async function researchEmployer(employerUrl) {
    if (!employerUrl) return null;

    let normalizedUrl = employerUrl.trim();
    if (!normalizedUrl.startsWith('http')) normalizedUrl = 'https://' + normalizedUrl;

    const prompt = RESEARCH_PROMPT.replace('{employer_url}', normalizedUrl);

    try {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) throw new Error('GEMINI_API_KEY not set');

        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({
            model: 'gemini-2.5-flash',
            generationConfig: { temperature: 1, topP: 0.95, maxOutputTokens: 8192 },
        });

        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            tools: [{ googleSearch: {} }],
        });

        const raw = result.response.text().trim();
        console.log(`[ai-employer-researcher] Raw response length: ${raw.length}`);

        // Strip markdown fences if present
        const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

        // Extract JSON object
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start === -1 || end === -1) throw new Error('No JSON object in response');

        const parsed = JSON.parse(cleaned.slice(start, end + 1));

        // Validate and sanitise brand color
        if (!parsed.brand_color || !/^#[0-9A-Fa-f]{6}$/.test(parsed.brand_color)) {
            parsed.brand_color = '#262633';
        }
        if (!parsed.font_name || typeof parsed.font_name !== 'string') {
            parsed.font_name = 'Lato';
        }

        console.log(`[ai-employer-researcher] ✅ ${normalizedUrl} → ${parsed.employer_name}, color=${parsed.brand_color}, font=${parsed.font_name}, techs=${parsed.technologies?.length || 0}, clients=${parsed.clients?.length || 0}`);
        return { ...parsed, website_url: normalizedUrl };

    } catch (err) {
        console.error(`[ai-employer-researcher] ❌ Failed for ${normalizedUrl}:`, err.message);
        console.error(err.stack);
        return null;
    }
}

module.exports = { researchEmployer };
