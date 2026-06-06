// Resume Builder — new feature. Safe to delete without affecting existing app.
'use strict';

const dbConfig     = require('../../db-config');
const axios        = require('axios');
const cheerio      = require('cheerio');
const path         = require('path');
const fs           = require('fs').promises;
const { renderPdf, renderPreviews } = require('../utils/resumeRenderer');
const { TEMPLATE_IDS }              = require('../utils/resumeTemplates');

const RESUME_CREDIT_COST = 2; // credits charged per generation / regeneration

// ── Shared credit helpers (mirrors coverLetterController) ───────────────────
async function checkUserCredits(userId, creditsRequired) {
    try {
        const credits = await dbConfig.get('SELECT credits_remaining FROM user_credits WHERE user_id = $1', [userId]);
        if (!credits) return { hasCredits: false, remaining: 0, message: 'No credit account found. Please purchase credits.' };
        const remaining = credits.credits_remaining || 0;
        if (remaining < creditsRequired) return { hasCredits: false, remaining, message: `Insufficient credits. You have ${remaining} credit(s) but need ${creditsRequired}.` };
        return { hasCredits: true, remaining };
    } catch (e) { throw e; }
}

async function deductCredits(userId, amount, actionType, metadata) {
    await dbConfig.run(
        `UPDATE user_credits SET credits_remaining = credits_remaining - $1 WHERE user_id = $2`,
        [amount, userId]
    );
    await dbConfig.run(
        `INSERT INTO credit_transactions (user_id, credits_used, action_type, metadata, created_at)
         VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`,
        [userId, amount, actionType, JSON.stringify(metadata || {})]
    );
}

// ── DB init ──────────────────────────────────────────────────────────────────
async function ensureResumeTable() {
    await dbConfig.run(`
        CREATE TABLE IF NOT EXISTS user_resumes (
            id         SERIAL PRIMARY KEY,
            user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            resume_data JSONB   NOT NULL DEFAULT '{}',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (user_id)
        )
    `);
}

// ── URL extraction from free-form text ───────────────────────────────────────
function extractUrls(text) {
    const pattern = /https?:\/\/[^\s"'<>()]+|(?:www\.|github\.com|linkedin\.com)[^\s"'<>()]+/gi;
    const raw = text.match(pattern) || [];
    return [...new Set(raw.map(u => u.startsWith('http') ? u : `https://${u}`))].slice(0, 5);
}

// ── Light page scrape: title + meta description + og:description ─────────────
async function scrapePage(url) {
    try {
        const { data } = await axios.get(url, {
            timeout: 6000,
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CVApplyr/1.0)' },
            maxContentLength: 500_000,
        });
        const $ = cheerio.load(data);
        const title       = $('title').first().text().trim().substring(0, 200);
        const metaDesc    = $('meta[name="description"]').attr('content') || '';
        const ogDesc      = $('meta[property="og:description"]').attr('content') || '';
        const ogTitle     = $('meta[property="og:title"]').attr('content') || '';
        $('script, style, nav, footer, header').remove();
        const bodyText    = $('body').text().replace(/\s+/g, ' ').trim().substring(0, 600);
        return {
            url,
            title:       ogTitle || title,
            description: ogDesc  || metaDesc || bodyText,
        };
    } catch {
        return { url, title: '', description: '' };
    }
}

// ── Gemini call with 90-second hard timeout ───────────────────────────────────
async function callGemini(prompt) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
        model: 'gemini-2.5-flash',
        generationConfig: { temperature: 0.4, maxOutputTokens: 8192 },
    });

    const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('AI_TIMEOUT')), 90_000)
    );

    const result = await Promise.race([
        model.generateContent(prompt),
        timeoutPromise,
    ]);
    return result.response.text().trim();
}

// ── Build the structured Gemini prompt ───────────────────────────────────────
function buildParsePrompt(name, email, phone, location, rawText, scrapedProjects) {
    const projectContext = scrapedProjects.length
        ? scrapedProjects.map(p =>
            `URL: ${p.url}\nTitle: ${p.title}\nDescription: ${p.description}`
          ).join('\n\n')
        : 'None found.';

    return `You are an expert executive resume writer AND veteran corporate recruiter. Your task is to parse the candidate information below and return a single, clean JSON object — NO markdown, NO code fences, NO conversational text, ONLY the raw JSON.

=== CANDIDATE DETAILS ===
Full Name: ${name}
Email:     ${email}
Phone:     ${phone}
Location:  ${location}

=== RAW CAREER TEXT (the candidate's own words) ===
${rawText}

=== SCRAPED PROJECT PAGES (enrichment context) ===
${projectContext}

=== ⚠️ ZERO-MISS RULE (most important rule — read first) ===
You MUST capture EVERY single piece of information the candidate has written.
- Every job, internship, freelance gig, or work mention → goes into experience
- Every educational qualification mentioned — including Class X (10th), Class XII (12th), schooling, college, university — MUST appear in education. Do NOT skip school-level education.
- Every percentage, grade, GPA, or score mentioned (e.g. "85%", "8.5 CGPA") → goes into the grade field of that education entry
- Every project, side project, freelance project, or client work → goes into projects
- Every skill, tool, technology, or soft skill mentioned → goes into skills
- If you are unsure whether something is worth including — INCLUDE IT. Missing information is the only unacceptable outcome.

=== GENERAL PARSING INSTRUCTIONS ===
1. Extract and structure ALL work experience, education, projects, and skills — nothing skipped.
2. Write every experience highlight as a strong, metric-driven achievement starting with a past-tense action verb.
   BAD:  "worked at a bank fixing code bugs"
   GOOD: "Diagnosed and resolved critical software defects in a high-volume banking environment, reducing bug recurrence by [X%]"
3. Dates: use "Month YYYY" format or "Present" for current roles. For education end dates, year alone is fine (e.g. "2021").
4. If a LinkedIn or portfolio URL is mentioned, place it in personal_info.
5. Infer technical and soft skills from the full context — do not duplicate obvious ones.
6. If a metric is unknown, write [X%] or [Insert Key Metric] — NEVER fabricate numbers.

=== EDUCATION — CRITICAL RULES ===
- Capture ALL levels: Class X / SSC / 10th standard, Class XII / HSC / 12th standard, Diploma, Bachelor's, Master's, PhD — every single one.
- For school qualifications use degree = "Class X" or "Class XII" and field_of_study = the board name (e.g. "CBSE", "Maharashtra State Board", "ICSE") if mentioned.
- ALWAYS capture percentage, CGPA, grade, or score in the "grade" field exactly as the candidate wrote it (e.g. "85.40%", "8.5 CGPA", "A Grade").
- If no grade is mentioned, use grade = "".

DEGREE EXPANSION RULE — Never copy short forms or abbreviations as-is. Always expand to the full official degree name and put the abbreviation in brackets.
  Examples:
  BCA      → "Bachelor of Computer Applications (BCA)"
  MCA      → "Master of Computer Applications (MCA)"
  B.Tech / BTech → "Bachelor of Technology (B.Tech)"
  M.Tech / MTech → "Master of Technology (M.Tech)"
  BCS / B.Sc CS  → "Bachelor of Science in Computer Science (B.Sc. CS)"
  MBA      → "Master of Business Administration (MBA)"
  BBA      → "Bachelor of Business Administration (BBA)"
  B.Com    → "Bachelor of Commerce (B.Com)"
  M.Com    → "Master of Commerce (M.Com)"
  BSc      → "Bachelor of Science (B.Sc.)"
  MSc      → "Master of Science (M.Sc.)"
  BE       → "Bachelor of Engineering (B.E.)"
  ME       → "Master of Engineering (M.E.)"
  PhD      → "Doctor of Philosophy (Ph.D.)"
  SSC / 10th → "Secondary School Certificate (SSC) — Class X"
  HSC / 12th → "Higher Secondary Certificate (HSC) — Class XII"
  If you encounter an abbreviation not listed above, use your knowledge to expand it correctly.

INSTITUTION NAME EXPANSION RULE — Never copy abbreviated or casually written institute names as-is. Use your training knowledge to look up and write the full official name of the institution.
  Examples:
  "ACTS Pune" or "ACTS"    → "C-DAC ACTS (Advanced Computing Training School), Pune, Maharashtra"
  "IIT Bombay"             → "Indian Institute of Technology Bombay (IIT Bombay), Mumbai, Maharashtra"
  "BITS Pilani"            → "Birla Institute of Technology and Science (BITS), Pilani, Rajasthan"
  "DU"                     → "University of Delhi (DU), New Delhi"
  "Pune University"        → "Savitribai Phule Pune University (SPPU), Pune, Maharashtra"
  "Mumbai University"      → "University of Mumbai (MU), Mumbai, Maharashtra"
  "NIT Nagpur"             → "Visvesvaraya National Institute of Technology (VNIT), Nagpur, Maharashtra"
  "COEP"                   → "College of Engineering Pune (COEP), Pune, Maharashtra"
  "VIT"                    → "Vellore Institute of Technology (VIT), Vellore, Tamil Nadu"
  Apply the same logic to ALL institutions — schools, colleges, universities, training institutes.
  If you are not certain of the full name, write the best-known official name you are aware of.
  Always include the city and state/country if known or inferable.

=== PROFESSIONAL SUMMARY — CRITICAL RULES ===
RULE 1 — NO THIRD-PERSON: Never use the candidate's name, "He", "She", or "They".
RULE 2 — NO OBVIOUS FIRST-PERSON: Never use "I", "Me", "My", or "We".
RULE 3 — IMPLIED FIRST-PERSON ONLY: Begin with a strong professional adjective, title, or action verb.
  GOOD: "Results-driven Software Engineer with 8+ years..."
  BAD:  "I am a software engineer..." / "John is a software engineer..."
RULE 4 — STRUCTURE (hybrid paragraph + bullets):
  Write a tight paragraph of 3-4 sentences MAX, then exactly 3 metric-driven bullet points.
  Separate with \\n. Each bullet starts with "• ".
RULE 5 — NO CLICHES: Banned — "passionate professional", "proven track record of success", "dynamic", "go-getter", "team player", "results-oriented" (alone).
RULE 6 — BUSINESS VALUE: Every sentence = concrete business outcome (revenue, cost, time, scale).
RULE 7 — NO BIOGRAPHY TONE: Punchy, corporate. No "Throughout his career..." / "Over the years...".
RULE 8 — SUBTLE KEYWORD EMPHASIS: Wrap important terms in **double asterisks** — this includes:
  technologies/tools (e.g. **React Native**, **Node.js**), years of experience (e.g. **6+ years**),
  domain areas (e.g. **fintech**, **e-commerce**), key metrics (e.g. **[X%]**, **[$X]**),
  and core specialisations. Do NOT wrap every word — only genuinely significant terms (3-6 per sentence max).
  Example: "Results-driven **Full-Stack Engineer** with **6+ years** delivering scalable platforms across **fintech** and **e-commerce**."

=== EXPERIENCE BULLET RULES ===
Each highlight must:
- Start with a strong past-tense action verb (Spearheaded, Architected, Delivered, Scaled, Engineered, Launched, Optimised, Streamlined, Led, Reduced, Increased...)
- Include a positive, professional metric wherever possible — use [X%] / [$X] / [N users] / [N engineers] as placeholders if the actual value is unknown
- NEVER use negative framing like "reduced downtime" — instead write "improved system reliability by [X%]" or "achieved [X]% uptime"
- NEVER use vague placeholders like "[insert metric]" — keep placeholders short: [X%], [$X], [N]
- One concise sentence, max 20 words
- Focus on business outcome, not task description

=== PROJECT FORMAT RULES ===
Each project has TWO distinct parts:
PART 1 — ABOUT THE PROJECT: 2-3 sentences describing what the project/company IS.
  - Use the scraped page data (if available) to explain the product, platform, or business.
  - Mention the tech stack, domain, and scale/user base if known.
  - Write this from a third-party perspective (what the project is), NOT what the candidate did.
  - Wrap important keywords (tech stack names, domain terms, key metrics, product names) in **double asterisks** so the app can render them with subtle emphasis.
    Example: "**NeuCo** is a **utility construction** management platform built with **React Native**, **Node.js**, and **PostgreSQL**, serving over **500 field engineers** across the US."
PART 2 — CANDIDATE'S ROLE: The candidate's title/role in the project, then 2-3 bullet points of what they specifically built or contributed.
  - Each bullet starts with a strong action verb.
  - Include metrics or [X%] placeholders.

=== REQUIRED OUTPUT SCHEMA (return ONLY this JSON, nothing else) ===
{
  "personal_info": {
    "full_name": "",
    "email": "",
    "phone": "",
    "location": "",
    "linkedin_url": "",
    "portfolio_url": ""
  },
  "summary": "3-4 sentence implied-first-person paragraph followed by exactly 3 metric-driven bullets using bullet prefix and newline separator",
  "experience": [
    {
      "company": "",
      "role": "",
      "location": "",
      "start_date": "",
      "end_date": "",
      "highlights": ["Action-verb achievement with metric or [X%] placeholder"]
    }
  ],
  "education": [
    {
      "institution": "",
      "degree": "e.g. Class X / Class XII / Bachelor of Engineering / Master of Science",
      "field_of_study": "e.g. Science / CBSE / Computer Engineering / Artificial Intelligence",
      "end_date": "e.g. 2018 or May 2022",
      "grade": "e.g. 85.40% / 8.5 CGPA / A Grade — use exactly what candidate wrote, or empty string"
    }
  ],
  "projects": [
    {
      "title": "Project or company name only, e.g. NeuCo",
      "type": "Short descriptor of what kind of project/company it is, e.g. Utility Construction Company / E-commerce Platform / SaaS Product",
      "link": "URL if mentioned, else empty string",
      "about": "2-3 sentences about what the project/company IS: its domain, tech stack, product, and scale. Written from a third-party perspective.",
      "role": "The candidate's role/title in this project, e.g. Full Stack Developer / Lead Engineer",
      "role_highlights": ["Action-verb bullet: what the candidate built or achieved", "Second bullet", "Third bullet if applicable"]
    }
  ],
  "skills": {
    "technical": [],
    "soft": []
  }
}`;
}

// ══════════════════════════════════════════════════════════════════════════════
// ROUTE HANDLERS
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/resume-builder/generate-ai
async function generateAI(req, res) {
    const userId = req.user.id;
    const { name, email, phone, location, rawText } = req.body;

    if (!rawText || rawText.trim().length < 20) {
        return res.status(400).json({ error: 'Please provide more detail about your experience.' });
    }

    try {
        const creditCheck = await checkUserCredits(userId, RESUME_CREDIT_COST);
        if (!creditCheck.hasCredits) {
            return res.status(402).json({ error: creditCheck.message, creditsRequired: RESUME_CREDIT_COST, creditsRemaining: creditCheck.remaining });
        }

        const urls = extractUrls(rawText);
        console.log(`[resumeBuilder] Found ${urls.length} URL(s):`, urls);

        const scrapedProjects = urls.length
            ? await Promise.all(urls.map(scrapePage))
            : [];

        const prompt    = buildParsePrompt(name || '', email || '', phone || '', location || '', rawText, scrapedProjects);
        const raw       = await callGemini(prompt);
        const cleaned   = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        const resumeData = JSON.parse(cleaned);

        if (name)     resumeData.personal_info.full_name = name;
        if (email)    resumeData.personal_info.email     = email;
        if (phone)    resumeData.personal_info.phone     = phone;
        if (location) resumeData.personal_info.location  = location;

        resumeData._buildMethod = 'ai';

        try {
            await deductCredits(userId, RESUME_CREDIT_COST, 'resume_generation', { name: resumeData.personal_info?.full_name });
        } catch (e) { console.warn('[resumeBuilder] credit deduction failed:', e.message); }

        await ensureResumeTable();
        await dbConfig.run(
            `INSERT INTO user_resumes (user_id, resume_data, updated_at)
             VALUES ($1, $2, CURRENT_TIMESTAMP)
             ON CONFLICT (user_id) DO UPDATE
             SET resume_data = EXCLUDED.resume_data,
                 updated_at  = CURRENT_TIMESTAMP`,
            [userId, JSON.stringify(resumeData)]
        );

        return res.json({ success: true, resumeData });
    } catch (e) {
        console.error('[resumeBuilder] generateAI error:', e.message);
        const isTimeout = e.message === 'AI_TIMEOUT' || e.message?.includes('timeout') || e.message?.includes('ETIMEDOUT');
        const userMessage = isTimeout
            ? 'The AI took too long to respond. Please try again — it usually works on the second attempt.'
            : (e.message || 'AI generation failed. Please try again.');
        return res.status(isTimeout ? 504 : 500).json({ error: userMessage, isTimeout });
    }
}

// POST /api/resume-builder/save
async function saveResume(req, res) {
    const userId = req.user.id;
    const { resumeData } = req.body;
    if (!resumeData) return res.status(400).json({ error: 'resumeData is required' });
    try {
        await ensureResumeTable();
        await dbConfig.run(
            `INSERT INTO user_resumes (user_id, resume_data, updated_at)
             VALUES ($1, $2, CURRENT_TIMESTAMP)
             ON CONFLICT (user_id) DO UPDATE
             SET resume_data = EXCLUDED.resume_data,
                 updated_at  = CURRENT_TIMESTAMP`,
            [userId, JSON.stringify(resumeData)]
        );
        return res.json({ success: true });
    } catch (e) {
        return res.status(500).json({ error: 'Failed to save resume.' });
    }
}

// GET /api/resume-builder
async function getResume(req, res) {
    const userId = req.user.id;
    try {
        await ensureResumeTable();
        const row = await dbConfig.get(
            'SELECT resume_data FROM user_resumes WHERE user_id = $1', [userId]
        );
        return res.json({ resumeData: row ? row.resume_data : null });
    } catch (e) {
        return res.status(500).json({ error: 'Failed to load resume.' });
    }
}


// Resolve a user's stored profile photo to an on-disk path (or null).
async function resolvePhotoPath(userId) {
    try {
        const uRow = await dbConfig.get('SELECT photo_path FROM users WHERE id = $1', [userId]);
        if (uRow && uRow.photo_path) {
            const p = path.join(__dirname, '../../', uRow.photo_path);
            await fs.access(p);
            return p;
        }
    } catch { /* no photo */ }
    return null;
}

// Read a resolved photo file into a compact, EXIF-corrected square JPEG data URI
// (or null) for embedding in the resume templates. Resizing keeps PDFs small and
// renders fast; .rotate() fixes phone photos that would otherwise appear sideways.
async function loadPhotoDataUri(photoPath) {
    if (!photoPath) return null;
    try {
        const sharp = require('sharp');
        const out = await sharp(photoPath)
            .rotate()                                                   // honour EXIF orientation
            .resize(400, 400, { fit: 'cover', position: 'attention' })  // square crop toward the face
            .jpeg({ quality: 86 })
            .toBuffer();
        return `data:image/jpeg;base64,${out.toString('base64')}`;
    } catch (e) {
        // sharp failed (corrupt/unsupported) — fall back to embedding the raw file.
        try {
            const buf  = await fs.readFile(photoPath);
            const ext  = path.extname(photoPath).toLowerCase();
            const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
            return `data:${mime};base64,${buf.toString('base64')}`;
        } catch { return null; }
    }
}

// POST /api/resume-builder/generate-pdf  — renders the chosen HTML design template
// (Azure / Executive / Minimal) to PDF; falls back to the PDFKit layout if needed.
async function generatePDF(req, res) {
    const userId = req.user.id;
    const { template, mode } = req.body || {};
    try {
        await ensureResumeTable();
        const row = await dbConfig.get('SELECT resume_data FROM user_resumes WHERE user_id = $1', [userId]);
        if (!row || !row.resume_data) {
            return res.status(404).json({ error: 'No resume found. Please generate your resume first.' });
        }

        // Profile photo path
        let photoPath = null;
        try {
            const uRow = await dbConfig.get('SELECT photo_path FROM users WHERE id = $1', [userId]);
            if (uRow && uRow.photo_path) {
                photoPath = path.join(__dirname, '../../', uRow.photo_path);
                await fs.access(photoPath);
            }
        } catch { photoPath = null; }

        const resume = row.resume_data;
        const pi     = resume.personal_info || {};
        const strip  = (t) => (t || '').replace(/\*\*(.+?)\*\*/g, '$1').trim();

        // ── Preferred path: render one of the 3 HTML design templates to PDF ──
        // (Falls back to the PDFKit layout below if Playwright/chromium is unavailable.)
        try {
            const tplId = TEMPLATE_IDS.includes(template) ? template : TEMPLATE_IDS[0];
            const pdfBuffer = await renderPdf(tplId, resume, { photo: await loadPhotoDataUri(photoPath), mode });
            const tSafe = strip(pi.full_name || 'Resume').replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '_');
            const tFile = `${tSafe}_Resume_${Date.now()}.pdf`;
            const tDir  = path.join(__dirname, '../../temp');
            await fs.mkdir(tDir, { recursive: true });
            await fs.writeFile(path.join(tDir, tFile), pdfBuffer);
            return res.json({ success: true, downloadUrl: `/api/download-resume/${encodeURIComponent(tFile)}`, template: tplId });
        } catch (tplErr) {
            console.warn('[resumeBuilder] template render failed, falling back to PDFKit:', tplErr.message);
        }

        // ── Fonts (same as cover letter) ─────────────────────────────
        const PDFKit  = require('pdfkit');
        const fsSync  = require('fs');
        const fontsDir = path.join(__dirname, '../../fonts');
        const fontR   = path.join(fontsDir, 'Lato-Regular.ttf');
        const fontB   = path.join(fontsDir, 'Lato-Bold.ttf');

        // ── Page geometry (same as cover letter) ──────────────────────
        const PW        = 595;
        const PH        = 841;
        const SBW       = 180;  // sidebar width
        const CX        = SBW + 40;  // right content x
        const CW        = PW - CX - 35; // right content width
        const SP        = 20;   // sidebar padding

        // ── File output ───────────────────────────────────────────────
        const safeName = strip(pi.full_name || 'Resume').replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '_');
        const fileName = `${safeName}_Resume_${Date.now()}.pdf`;
        const tempDir  = path.join(__dirname, '../../temp');
        await fs.mkdir(tempDir, { recursive: true });
        const filePath = path.join(tempDir, fileName);

        await new Promise((resolve, reject) => {
            const doc = new PDFKit({
                size: [PW, PH],
                margins: { top: 0, bottom: 0, left: 0, right: 0 },
                autoFirstPage: false,
            });

            doc.registerFont('F',  fontR);
            doc.registerFont('FB', fontB);
            doc.font('F');

            const writeStream = fsSync.createWriteStream(filePath);
            doc.pipe(writeStream);
            writeStream.on('error', reject);
            writeStream.on('finish', resolve);

            // ── Sidebar gradient (same formula as cover letter) ─────────
            const drawSidebar = () => {
                const grad = doc.linearGradient(0, 0, 0, PH);
                grad.stop(0,   '#0d0d1a');
                grad.stop(0.5, '#141428');
                grad.stop(1,   '#1c1c2e');
                doc.rect(0, 0, SBW, PH).fill(grad);
            };

            // ── Add page with sidebar ─────────────────────────────────
            let contentY = 50;
            const addPage = () => {
                doc.addPage({ size: [PW, PH], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
                drawSidebar();
                contentY = 30;
            };
            addPage();

            // ── Check page break ──────────────────────────────────────
            const checkBreak = (needed = 40) => {
                if (contentY + needed > PH - 30) {
                    addPage();
                    return true;
                }
                return false;
            };

            // ── Right-column section heading ──────────────────────────
            const rSection = (title) => {
                checkBreak(50);
                contentY += 16;
                doc.font('FB').fontSize(11).fillColor('#1a1a2e');
                doc.text(title.toUpperCase(), CX, contentY, { lineBreak: false });
                contentY += 14;
                doc.moveTo(CX, contentY).lineTo(PW - 30, contentY).lineWidth(0.8).strokeColor('#cccccc').stroke();
                contentY += 10;
            };

            // ── Timeline entry: circle + role bold + date right ───────
            const rEntry = (titleTxt, date) => {
                checkBreak(30);
                // Circle marker
                doc.circle(CX + 5, contentY + 6, 4).fillColor('#1a1a2e').fill();
                doc.circle(CX + 5, contentY + 6, 2).fillColor('#ffffff').fill();
                // Role title
                doc.font('FB').fontSize(10.5).fillColor('#1a1a2e');
                const titleW = CW - (date ? doc.widthOfString(date, { fontSize: 8.5 }) + 12 : 0) - 18;
                doc.text(strip(titleTxt), CX + 16, contentY, { width: titleW, lineBreak: true });
                const titleH = doc.heightOfString(strip(titleTxt), { width: titleW });
                // Date right-aligned on first line
                if (date) {
                    doc.font('F').fontSize(8.5).fillColor('#888888');
                    doc.text(date, PW - 30 - doc.widthOfString(date, { fontSize: 8.5 }), contentY, { lineBreak: false });
                }
                contentY += Math.max(titleH, 14);
            };

            // ── Sub-label (company, institution) ─────────────────────
            const rSub = (txt) => {
                if (!strip(txt)) return;
                checkBreak(15);
                doc.font('F').fontSize(9.5).fillColor('#3a6cb5');
                doc.text(strip(txt), CX + 16, contentY, { width: CW - 16, lineBreak: true });
                contentY += doc.heightOfString(strip(txt), { width: CW - 16, fontSize: 9.5 });
                contentY += 2;
            };

            // ── Bullet line ───────────────────────────────────────────
            const rBullet = (txt) => {
                const clean = strip(txt);
                if (!clean) return;
                checkBreak(15);
                doc.font('F').fontSize(9.5).fillColor('#444444');
                const bw = CW - 28;
                const bh = doc.heightOfString(clean, { width: bw, fontSize: 9.5 });
                doc.rect(CX + 18, contentY + 4.5, 3, 3).fillColor('#3a6cb5').fill();
                doc.font('F').fontSize(9.5).fillColor('#444444');
                doc.text(clean, CX + 27, contentY, { width: bw, lineBreak: true });
                contentY += bh + 2;
            };

            // ── Right body text ───────────────────────────────────────
            const rText = (txt, sz = 9.5, color = '#444444') => {
                const clean = strip(txt);
                if (!clean) return;
                checkBreak(15);
                doc.font('F').fontSize(sz).fillColor(color);
                doc.text(clean, CX, contentY, { width: CW, lineBreak: true, align: 'justify' });
                contentY += doc.heightOfString(clean, { width: CW, fontSize: sz }) + 4;
            };

            // ────────────────────────────────────────────────────────────
            // SIDEBAR CONTENT (page 1)
            // ────────────────────────────────────────────────────────────
            const photoX = SBW / 2;
            const photoY = 72;
            const photoR = 42;

            // Photo circle border
            doc.circle(photoX, photoY, photoR + 3).lineWidth(2.5).strokeColor('#ffffff').stroke();

            if (photoPath) {
                try {
                    doc.save();
                    doc.circle(photoX, photoY, photoR).clip();
                    doc.image(photoPath, photoX - photoR, photoY - photoR, { width: photoR * 2, height: photoR * 2 });
                    doc.restore();
                } catch {
                    photoPath = null; // fall through to initials
                }
            }
            if (!photoPath) {
                doc.circle(photoX, photoY, photoR).fillColor('#1e2440').fill();
                const parts = strip(pi.full_name || '?').trim().split(/\s+/);
                const ini   = (parts.length >= 2 ? parts[0][0] + parts[parts.length - 1][0] : parts[0][0] || '?').toUpperCase();
                doc.font('FB').fontSize(22).fillColor('#ffffff');
                doc.text(ini, photoX - 18, photoY - 13, { width: 36, align: 'center' });
            }

            let sy = photoY + photoR + 28; // sidebar y cursor

            // Sidebar section helper
            const sSection = (title) => {
                doc.font('FB').fontSize(9).fillColor('#ffffff');
                doc.text(title, SP, sy, { lineBreak: false });
                sy += 14;
                doc.moveTo(SP, sy).lineTo(SBW - SP, sy).lineWidth(0.5).strokeColor('#555577').stroke();
                sy += 10;
            };

            // Sidebar label + value
            const sItem = (label, value) => {
                if (!value || !strip(value)) return;
                doc.font('FB').fontSize(8).fillColor('#9999bb');
                doc.text(label, SP, sy, { lineBreak: false });
                sy += 11;
                doc.font('F').fontSize(9).fillColor('#ddddee');
                const clean = strip(value);
                doc.text(clean, SP, sy, { width: SBW - SP * 2, lineBreak: true });
                sy += doc.heightOfString(clean, { width: SBW - SP * 2, fontSize: 9 }) + 5;
            };

            // Sidebar skill item
            const sSkill = (txt) => {
                const clean = strip(txt);
                if (!clean) return;
                doc.font('F').fontSize(9).fillColor('#ddddee');
                // Small dot
                doc.circle(SP + 3, sy + 4.5, 2).fillColor('#3a6cb5').fill();
                doc.text(clean, SP + 10, sy, { width: SBW - SP - 14, lineBreak: true });
                sy += doc.heightOfString(clean, { width: SBW - SP - 14, fontSize: 9 }) + 5;
            };

            // CONTACT
            sSection('CONTACT');
            sItem('Phone',    pi.phone);
            sItem('Email',    pi.email);
            sItem('Location', pi.location);
            if (pi.linkedin_url)  sItem('LinkedIn',  'linkedin.com/in/...');
            if (pi.portfolio_url) sItem('Portfolio', strip(pi.portfolio_url).substring(0, 22));

            sy += 8;

            // TECH SKILLS
            if (resume.skills?.technical?.length) {
                sSection('TECH SKILLS');
                for (const sk of resume.skills.technical.slice(0, 12)) sSkill(sk);
                sy += 4;
            }

            // SOFT SKILLS
            if (resume.skills?.soft?.length) {
                sSection('SOFT SKILLS');
                for (const sk of resume.skills.soft.slice(0, 8)) sSkill(sk);
            }

            // ────────────────────────────────────────────────────────────
            // RIGHT COLUMN HEADER (mirrors cover letter header exactly)
            // ────────────────────────────────────────────────────────────

            // Name — large bold (same as cover letter)
            doc.font('FB').fontSize(18).fillColor('#000000');
            doc.text(strip(pi.full_name || 'YOUR NAME').toUpperCase(), CX, contentY, { lineBreak: false });

            // Contact details right-aligned (same as cover letter)
            doc.font('F').fontSize(9).fillColor('#4d4d4d');
            const rightX = PW - 30;
            if (pi.phone) {
                doc.text(strip(pi.phone), rightX - doc.widthOfString(strip(pi.phone)), contentY, { lineBreak: false });
            }
            if (pi.email) {
                doc.text(strip(pi.email), rightX - doc.widthOfString(strip(pi.email)), contentY + 14, { lineBreak: false });
            }
            if (pi.location) {
                doc.text(strip(pi.location), rightX - doc.widthOfString(strip(pi.location)), contentY + 28, { lineBreak: false });
            }
            contentY += 22;

            // Job title subtitle (same as cover letter "Applicant")
            const jobTitle = strip(resume.experience?.[0]?.role || 'Professional');
            doc.font('F').fontSize(11).fillColor('#666666');
            doc.text(jobTitle, CX, contentY, { lineBreak: false });
            contentY += 22;

            // Separator line (same as cover letter)
            doc.moveTo(CX, contentY).lineTo(PW - 30, contentY).lineWidth(1).strokeColor('#cccccc').stroke();
            contentY += 18;

            // ────────────────────────────────────────────────────────────
            // SUMMARY
            // ────────────────────────────────────────────────────────────
            if (resume.summary) {
                rSection('Professional Summary');
                const sumLines = resume.summary.split('\n').filter(l => l.trim());
                for (const line of sumLines) {
                    const isBullet = line.trim().startsWith('•');
                    const text = strip(line.replace(/^•\s*/, ''));
                    if (!text) continue;
                    if (isBullet) rBullet(text);
                    else rText(text);
                }
                contentY += 4;
            }

            // ────────────────────────────────────────────────────────────
            // EXPERIENCE
            // ────────────────────────────────────────────────────────────
            if (resume.experience?.length) {
                rSection('Experience');
                for (let i = 0; i < resume.experience.length; i++) {
                    const e = resume.experience[i];
                    const dates = [e.start_date, e.end_date].filter(Boolean).join(' – ');
                    rEntry(strip(e.role || ''), dates);
                    rSub([strip(e.company || ''), strip(e.location || '')].filter(Boolean).join('  |  '));
                    for (const h of (e.highlights || [])) rBullet(h);
                    contentY += 6;
                    if (i < resume.experience.length - 1) {
                        doc.moveTo(CX + 14, contentY).lineTo(PW - 30, contentY).lineWidth(0.3).strokeColor('#dddddd').stroke();
                        contentY += 6;
                    }
                }
            }

            // ────────────────────────────────────────────────────────────
            // EDUCATION
            // ────────────────────────────────────────────────────────────
            if (resume.education?.length) {
                rSection('Education');
                for (const e of resume.education) {
                    const deg = [strip(e.degree || ''), strip(e.field_of_study || '')].filter(Boolean).join(' — ');
                    rEntry(deg, strip(e.end_date || ''));
                    rSub(strip(e.institution || ''));
                    if (e.grade) {
                        checkBreak(15);
                        doc.font('F').fontSize(9.5).fillColor('#555555');
                        doc.text(`Grade: ${strip(e.grade)}`, CX + 16, contentY, { lineBreak: false });
                        contentY += 13;
                    }
                    contentY += 6;
                }
            }

            // ────────────────────────────────────────────────────────────
            // PROJECTS
            // ────────────────────────────────────────────────────────────
            if (resume.projects?.length) {
                rSection('Projects');
                for (const p of resume.projects) {
                    const titleType = strip(p.title || '') + (p.type ? `  (${strip(p.type)})` : '');
                    rEntry(titleType, '');
                    const about = strip(p.about || p.description || '');
                    if (about) rText(about);
                    if (p.role) {
                        checkBreak(15);
                        doc.font('FB').fontSize(9.5).fillColor('#1a1a2e');
                        doc.text('Role: ', CX + 16, contentY, { lineBreak: false, continued: true });
                        doc.font('F').fillColor('#3a6cb5');
                        doc.text(strip(p.role), { lineBreak: false });
                        contentY += 13;
                    }
                    for (const h of (p.role_highlights || [])) rBullet(h);
                    contentY += 6;
                }
            }

            doc.end();
        });

        return res.json({ success: true, downloadUrl: `/api/download-resume/${encodeURIComponent(fileName)}` });
    } catch (e) {
        console.error('[resumeBuilder] generatePDF error:', e.message);
        return res.status(500).json({ error: 'Failed to generate PDF. Please try again.' });
    }
}

// POST /api/resume-builder/preview-templates — renders the saved resume in all 3
// designs and returns base64 JPEG previews so the user can pick one before download.
async function previewTemplates(req, res) {
    const userId = req.user.id;
    try {
        await ensureResumeTable();
        const row = await dbConfig.get('SELECT resume_data FROM user_resumes WHERE user_id = $1', [userId]);
        if (!row || !row.resume_data) {
            return res.status(404).json({ error: 'No resume found. Please generate your resume first.' });
        }
        const photo = await loadPhotoDataUri(await resolvePhotoPath(userId));
        const previews = await renderPreviews(row.resume_data, { photo });
        return res.json({ success: true, previews });
    } catch (e) {
        console.error('[resumeBuilder] previewTemplates error:', e.message);
        return res.status(500).json({ error: 'Failed to render design previews. Please try again.' });
    }
}

module.exports = { generateAI, saveResume, getResume, generatePDF, previewTemplates };
