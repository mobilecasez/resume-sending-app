'use strict';

/**
 * AI Brand Extractor
 *
 * Visits an employer website and extracts brand color + font.
 * This is a separate, lightweight call — completely independent of
 * cover letter generation so that prompt is never touched.
 *
 * Output (Promise<{ brand_color: string, font_name: string }>)
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');

const BRAND_PROMPT = `You are a brand analyst. Visit the employer website below and extract ONLY two things:

1. PRIMARY BRAND COLOR — the dominant hex color used in the company logo, header background, primary buttons, or navigation bar. Return as a 6-digit hex string e.g. "#1A73E8". If you genuinely cannot determine it, return "#1A2046".

2. PRIMARY FONT — the main font family used in the website headings or body text (e.g. "Inter", "Roboto", "Open Sans", "Helvetica Neue", "Montserrat"). If you cannot determine it, return "Lato".

Employer Website: {employer_url}

Return ONLY this JSON object with nothing before or after it:
{
  "brand_color": "#xxxxxx",
  "font_name": "Font Family Name"
}`;

async function extractBrandProfile(employerUrl) {
    if (!employerUrl) return { brand_color: '#1A2046', font_name: 'Lato' };

    let normalizedUrl = employerUrl.trim();
    if (!normalizedUrl.startsWith('http')) normalizedUrl = 'https://' + normalizedUrl;

    const prompt = BRAND_PROMPT.replace('{employer_url}', normalizedUrl);

    try {
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({
            model: 'gemini-2.5-flash',
            tools: [{ googleSearch: {} }],
        });

        const result = await model.generateContent(prompt);
        const raw = result.response.text().trim();

        // Strip markdown fences if present
        const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

        // Extract JSON object
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start === -1 || end === -1) throw new Error('No JSON in response');

        const parsed = JSON.parse(cleaned.slice(start, end + 1));

        const brandColor = (parsed.brand_color && /^#[0-9A-Fa-f]{6}$/.test(parsed.brand_color))
            ? parsed.brand_color : '#1A2046';
        const fontName = (parsed.font_name && typeof parsed.font_name === 'string')
            ? parsed.font_name.trim() : 'Lato';

        console.log(`[ai-brand-extractor] ${normalizedUrl} → color=${brandColor}, font=${fontName}`);
        return { brand_color: brandColor, font_name: fontName };

    } catch (err) {
        console.warn(`[ai-brand-extractor] Failed for ${normalizedUrl}: ${err.message} — using defaults`);
        return { brand_color: '#1A2046', font_name: 'Lato' };
    }
}

module.exports = { extractBrandProfile };
