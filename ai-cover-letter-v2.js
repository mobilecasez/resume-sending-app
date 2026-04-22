'use strict';

/**
 * AI Cover Letter Generator v2
 *
 * Inputs:
 *   - userMetadata  : row from resume_metadata table (object)
 *   - employerUrl   : employer website URL (string)
 *   - targetPosition: job position title (string)
 *
 * Output (Promise<object>):
 *   {
 *     to            : string  – salutation / addressee
 *     employer_name : string  – official company name
 *     position      : string  – target position
 *     addresses     : string[] – office addresses (HQ first)
 *     subject       : string  – email subject line
 *     cover_letter  : string  – full letter body in Markdown
 *   }
 *
 * No manual scraping — Gemini performs deep research on the employer URL
 * itself using its built-in Google Search grounding tool.
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');

// ---------------------------------------------------------------------------
// Gemini call
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an expert cover letter writer who does deep employer research before writing. Follow every instruction below exactly — the quality of the output depends entirely on how much specific, named detail you uncover about the employer.

INPUTS:
- User Metadata: {user_metadata}
- Target Position: {target_position}
- Employer Website URL: {employer_url_or_scraped_text}

---

STEP 1 — DEEP EMPLOYER RESEARCH (use Google Search aggressively on the URL and company name):

Search for ALL of the following — the more named, specific facts you find, the better the letter:

A. COMPANY IDENTITY
   - Full official company name
   - Year founded, size, industry vertical(s)
   - Core mission / tagline
   - OFFICE ADDRESSES (required — search aggressively):
     * Search "[company name] office locations" and "[company name] headquarters address"
     * Search the Contact or About page of the employer website for physical addresses
     * List EVERY address found: HQ, regional offices, international branches — all of them
     * Format each as: Street address, Postal code City, Country
     * If only one location exists, return that one. Do not invent addresses.

B. PRODUCTS & PLATFORMS (aim for 3–5 named items)
   - Every named software product, SaaS platform, or service they have built
   - Any white-label solutions, APIs, or integrations they offer
   - Technology stack they use (languages, frameworks, cloud providers, databases)

C. CLIENTS & CONTRACTS (aim for 3–5 named clients)
   - Actual client company names — not generic "Fortune 500" descriptions
   - Industries served: fintech, healthcare, real estate, government, retail, energy, etc.
   - Any named government contracts, enterprise deals, or partnership agreements
   - Any publicly mentioned case studies with client names

D. RECENT ACTIVITY (search news/press in the last 2 years)
   - Recent product launches or version releases
   - New partnerships, acquisitions, or funding rounds
   - Awards, certifications, or recognition
   - Any new market expansions or new office openings

E. TEAM & HIRING
   - Hiring manager name or department head name if publicly listed on LinkedIn, the website, or job boards
   - Notable leadership team members

F. DOMAINS & TECHNICAL FOCUS
   - List every technical domain they operate in (e.g. cloud-native architecture, data engineering, mobile development, AI/ML, cybersecurity, ERP integration, etc.)
   - Match each domain against the user's skills and experience

---

STEP 2 — WRITE THE COVER LETTER BODY (4 paragraphs, separated by blank lines):

=== PARAGRAPH 1 — INTRODUCTION + EMPLOYER CONNECTION (most critical paragraph) ===

STRUCTURE — write in this exact order:
1. ONE opening sentence: introduce the user with their years of experience and current/most recent role title — keep it brief and factual (not enthusiastic)
2. TWO to THREE sentences: pivot immediately to the employer — name a specific product, client, project, contract, or recent activity of theirs found in your research. Explain what specifically about the employer makes this role a natural fit for someone with the user's background.

FORBIDDEN phrases anywhere in this paragraph:
- "fascination", "passion", "thrilled", "excited", "eager", "deeply resonates", "drawn to", "always been interested"
- "I am writing to express", "I have always", "I have been following your work"
- Vague generic claims like "innovative company", "leading firm", "dynamic environment"

BOLD RULES for this paragraph:
- Bold the user's years of experience (e.g. **14+ Years**)
- Bold the user's role title (e.g. **Senior Software Engineer**)
- Bold the employer name
- Bold any specific product, client, or project name you reference

GOOD EXAMPLE (follow this structure exactly):
"With **14+ Years** of experience in **Full-Stack Development** and enterprise software delivery, I am applying for the **Senior Software Engineer** position at **Disruptive Tech Solutions**. Your **Simp Realty Platform**, built for **Capital Bank** and delivered in ten weeks using **Delphix Test Data Management** and a microservices architecture, is exactly the kind of high-stakes, high-tempo work my background has been building toward. The combination of **SaaS product engineering** and real estate domain expertise you are developing maps directly to projects I have shipped across similar domains."

BAD EXAMPLE (never write like this):
"My passion for technology and fascination with turning complex ideas into products drew me to Disruptive Tech Solutions, where innovation is at the heart of everything."

=== PARAGRAPH 2 — SKILLS & DOMAIN MATCH ===

- List 4–6 of the employer's core technical domains found in research
- For each domain, name the user's matching skill or past project explicitly
- Example: "Your **Azure**-heavy stack aligns directly with my three years building microservices on **Azure Kubernetes Service** and **Azure Data Factory** pipelines for a healthcare client."
- Bold every technical skill, framework, platform, and tool name mentioned
- Bold every named client, product, or project from both the employer and the user's background

=== PARAGRAPH 3 — VALUE PROPOSITION ===

- Reference 2–3 specific things the employer is known for (named products, client sectors, recent launches)
- Show exactly how the user's background addresses those needs — be concrete, not generic
- Mention the user's most relevant past role title in bold
- No filler phrases — every sentence must state a specific claim

=== PARAGRAPH 4 — CLOSING WITH RELOCATION INTENT ===

- State genuine interest in joining the team
- If the employer city/country differs from the user's location: explicitly say "I am prepared to relocate to **[City, Country]**"
- Bold the employer name and the city/country
- End with a single, direct thank-you sentence

---

TONE RULES:
- Professional but human — sounds like a person who did their homework, not a template
- Clear, direct, medium vocabulary — no overly formal language
- Vary sentence length and structure — avoid monotonous rhythm
- Absolutely forbidden words/phrases: delve, testament, tapestry, leverage, synergy, spearhead, multifaceted, holistic, "proven track record", "I am confident that", "I believe I am", "ideal candidate", "I am eager to", "I am excited to"

---

BOLD RULES — apply **double asterisks** to ALL of the following (this is required, not optional):
- Employer's official name — every single time it appears in the text
- User's years of experience — always bold, e.g. **14+ Years**, **10+ Years**, **8 Years**
- Every named client company mentioned
- Every named product, platform, or service (employer's or user's)
- Every named project or contract
- Every technical skill, framework, programming language, cloud platform, tool, or database — e.g. **ASP.NET Core**, **React**, **Azure Kubernetes Service**, **PostgreSQL**, **Node.js**, **Angular**, **SQL Server**, **Azure DevOps**, **Docker**, **Kubernetes**, **PySpark**, **Azure Data Factory**
- User's past role title(s) mentioned — e.g. **Senior Software Engineer**, **Technical Lead**
- Industry domain names when used as key descriptors — e.g. **Full-Stack Development**, **Cloud-Native Architecture**, **Data Engineering**, **Healthcare IT**
- Employer city and country in the closing paragraph

TARGET: At least 15–20 bolded items across the full letter. If you have fewer than 15, you have not bolded enough.

---

STRICT OUTPUT RULES — VIOLATIONS WILL BREAK THE APPLICATION:
1. "cover_letter" MUST start with the very first word of Paragraph 1 — no preamble, no label
2. NO "Dear ...", NO "To Whom It May Concern", NO salutation anywhere inside cover_letter
3. NO "Sincerely,", NO "Best regards,", NO "[Your Name]" — no sign-off anywhere inside cover_letter
4. Salutation goes ONLY in the "to" field. Sign-off is added by the system.
5. Paragraphs separated by \\n\\n — no bullet points, no numbered lists, no headers inside cover_letter

---

OUTPUT FORMAT — return ONLY this JSON object, with absolutely nothing before or after it:
{
  "to": "Hiring manager name if found, otherwise most relevant title e.g. Head of Engineering",
  "employer_name": "Full official company name",
  "position": "Target position exactly as provided",
  "addresses": ["HQ full street address, postal code, city, country", "second office address if found", "third office if found — return every address you found, one per array item"],
  "subject": "Application for [Target Position] — [User Full Name from metadata]",
  "cover_letter": "PARAGRAPH 1 text\\n\\nPARAGRAPH 2 text\\n\\nPARAGRAPH 3 text\\n\\nPARAGRAPH 4 text"
}`;

/**
 * Build the filled-in prompt text by substituting placeholders.
 */
function buildPrompt(userMetadata, targetPosition, employerUrlOrText) {
    return SYSTEM_PROMPT
        .replace('{user_metadata}', JSON.stringify(userMetadata, null, 2))
        .replace('{target_position}', targetPosition)
        .replace('{employer_url_or_scraped_text}', employerUrlOrText);
}

/**
 * Call Gemini with Google Search grounding enabled so the model can
 * autonomously research the employer URL before writing the letter.
 * Returns the parsed JSON response object.
 *
 * NOTE: responseMimeType 'application/json' is intentionally NOT combined
 * with googleSearch grounding in the same request — the Gemini API does not
 * allow both simultaneously. We request JSON output via the prompt instead
 * and parse the response ourselves.
 *
 * @param {string} promptText
 * @returns {Promise<object>}
 */
async function callGemini(promptText) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY environment variable is not set');

    console.log('\n' + '═'.repeat(80));
    console.log('📤 [ai-cover-letter-v2] FULL PROMPT SENT TO GEMINI:');
    console.log('═'.repeat(80));
    console.log(promptText);
    console.log('═'.repeat(80) + '\n');

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
        model: 'gemini-2.5-flash',
        generationConfig: {
            temperature: 1,
            topP: 0.95,
            maxOutputTokens: 8192,
        },
    });

    const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: promptText }] }],
        tools: [{ googleSearch: {} }],
    });

    const text = result.response.text();

    console.log('\n' + '═'.repeat(80));
    console.log('📥 [ai-cover-letter-v2] RAW RESPONSE FROM GEMINI:');
    console.log('═'.repeat(80));
    console.log(text);
    console.log('═'.repeat(80) + '\n');

    if (!text || text.trim() === '') {
        throw new Error('Gemini returned an empty response');
    }

    // Strip markdown code fences if the model wrapped the JSON
    const cleaned = text
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim();

    // Extract the JSON object (in case the model prefixes any commentary)
    const jsonStart = cleaned.indexOf('{');
    const jsonEnd = cleaned.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) {
        throw new Error('Gemini response did not contain a JSON object');
    }

    const jsonStr = cleaned.slice(jsonStart, jsonEnd + 1);

    // First attempt: direct parse
    try {
        return JSON.parse(jsonStr);
    } catch (_) {}

    // Second attempt: character-by-character sanitiser — escapes unescaped
    // control characters (\n \r \t) found inside JSON string values.
    const sanitised = sanitiseJsonString(jsonStr);
    try {
        return JSON.parse(sanitised);
    } catch (_) {}

    // Third attempt: regex field extractor — Gemini sometimes puts literal
    // unescaped double-quotes inside string values which are impossible to
    // fix generically. Extract each known field individually instead.
    try {
        return extractJsonFields(sanitised);
    } catch (e3) {
        throw new Error(`JSON parse failed after all recovery attempts: ${e3.message}`);
    }
}

/**
 * Walk through a JSON string character by character, tracking whether we are
 * inside a string literal. Any unescaped \n, \r or \t found inside a string
 * is replaced with its proper JSON escape sequence.
 */
function sanitiseJsonString(raw) {
    let out = '';
    let inString = false;
    let escaped = false;

    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];

        if (escaped) {
            out += ch;
            escaped = false;
            continue;
        }

        if (ch === '\\' && inString) {
            out += ch;
            escaped = true;
            continue;
        }

        if (ch === '"') {
            inString = !inString;
            out += ch;
            continue;
        }

        if (inString) {
            if (ch === '\n') { out += '\\n'; continue; }
            if (ch === '\r') { out += '\\r'; continue; }
            if (ch === '\t') { out += '\\t'; continue; }
        }

        out += ch;
    }

    return out;
}

/**
 * Last-resort extractor: pull each known field from the raw JSON string using
 * targeted regex patterns. Used when Gemini emits unescapable characters
 * (e.g. literal double-quotes) inside string values that break JSON.parse.
 */
function extractJsonFields(raw) {
    function extractString(key) {
        // Match: "key": "...value..." — value runs until the next `,\n  "` or `\n}` boundary
        const re = new RegExp(`"${key}"\\s*:\\s*"([\\s\\S]*?)"(?:\\s*,\\s*"[a-z_]+"\\s*:|\\s*\\})`, 'i');
        const m = raw.match(re);
        return m ? m[1].replace(/\\n/g, '\n').replace(/\\t/g, '\t') : '';
    }

    function extractArray(key) {
        const re = new RegExp(`"${key}"\\s*:\\s*(\\[[\\s\\S]*?\\])`, 'i');
        const m = raw.match(re);
        if (!m) return [];
        try {
            return JSON.parse(sanitiseJsonString(m[1]));
        } catch (_) {
            // fallback: pull quoted strings from the array manually
            return [...m[1].matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)].map(x => x[1]);
        }
    }

    // cover_letter is always the last field — capture everything between its
    // opening quote and the final `"}` of the whole object
    function extractCoverLetter() {
        const start = raw.indexOf('"cover_letter"');
        if (start === -1) return '';
        const colon = raw.indexOf(':', start);
        const quote = raw.indexOf('"', colon + 1);
        if (quote === -1) return '';
        // Find the closing quote: last `"` before final `}`
        const objEnd = raw.lastIndexOf('}');
        let closeQuote = raw.lastIndexOf('"', objEnd - 1);
        const value = raw.slice(quote + 1, closeQuote);
        return value
            .replace(/\\n/g, '\n')
            .replace(/\\t/g, '\t')
            .replace(/\\"/g, '"');
    }

    return {
        to:            extractString('to'),
        employer_name: extractString('employer_name'),
        position:      extractString('position'),
        addresses:     extractArray('addresses'),
        subject:       extractString('subject'),
        cover_letter:  extractCoverLetter(),
    };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a personalized cover letter using AI.
 *
 * @param {object} userMetadata    - Row from resume_metadata table
 * @param {string} employerUrl     - Employer website URL
 * @param {string} targetPosition  - Job position title
 * @returns {Promise<{to, employer_name, position, addresses, subject, cover_letter}>}
 */
async function generateCoverLetter(userMetadata, employerUrl, targetPosition) {
    if (!userMetadata || typeof userMetadata !== 'object') {
        throw new Error('userMetadata must be a non-null object');
    }
    if (!employerUrl || typeof employerUrl !== 'string') {
        throw new Error('employerUrl must be a non-empty string');
    }
    if (!targetPosition || typeof targetPosition !== 'string') {
        throw new Error('targetPosition must be a non-empty string');
    }

    // Normalise the URL so Gemini always receives a proper https:// link
    let normalizedUrl = employerUrl.trim();
    if (!normalizedUrl.startsWith('http')) normalizedUrl = 'https://' + normalizedUrl;

    // Pass the URL directly — Gemini will research the employer itself
    // via Google Search grounding. No manual scraping required.
    const prompt = buildPrompt(userMetadata, targetPosition, normalizedUrl);

    console.log(`[ai-cover-letter-v2] Calling Gemini to research ${normalizedUrl} and generate cover letter...`);
    const result = await callGemini(prompt);
    console.log('[ai-cover-letter-v2] Done ✅');

    return result;
}

module.exports = { generateCoverLetter };
