'use strict';

/**
 * DOM Optimizer — converts raw HTML to compact, AI-optimized Markdown.
 *
 * Approach (mirrors ShopFlix AI scraping stack):
 *   Raw HTML (500k–2M chars)
 *     → strip noise (nav, footer, ads, tracking)
 *     → extract structured data scripts (JSON-LD, __NEXT_DATA__, window state)
 *     → convert remaining DOM to clean Markdown
 *   → 10–30× token reduction before Gemini sees anything
 *
 * Only uses `cheerio` — no extra packages needed.
 */

const cheerio = require('cheerio');

// ─── Noise selectors stripped before markdown conversion ─────────────────────
const NOISE_SELECTORS = [
    'script', 'style', 'noscript', 'iframe', 'link', 'meta', 'svg', 'canvas',
    'nav', 'header', 'footer', 'aside',
    '[class*="cookie"]', '[class*="Cookie"]',
    '[class*="banner"]', '[id*="banner"]',
    '[class*="advertisement"]', '[class*="tracking"]',
    '[class*="social-share"]', '[class*="shareButton"]',
    '[class*="breadcrumb"]', '[id*="breadcrumb"]',
    '[class*="related-jobs"]', '[class*="similar-jobs"]',
    '[class*="newsletter"]', '[class*="subscribe"]',
    '[aria-hidden="true"]',
    '.skip-link', '#skip-to-content',
];

// Inline tags — just recurse into children, don't add whitespace
const INLINE_TAGS = new Set(['span', 'a', 'em', 'i', 'u', 'abbr', 'time', 'label', 'small', 'cite', 'q', 'sup', 'sub']);

/**
 * Recursively walks a cheerio DOM node and appends lines to `acc`.
 * @param {object} el    Cheerio element
 * @param {object} $     Cheerio root
 * @param {string[]} acc Line accumulator
 * @param {number} depth Current nesting depth (for lists)
 */
function nodeToLines(el, $, acc, depth = 0) {
    if (!el) return;

    if (el.type === 'text') {
        const txt = (el.data || '').replace(/\s+/g, ' ').trim();
        if (txt.length > 1) acc.push(txt);
        return;
    }

    if (el.type !== 'tag') return;
    const tag = el.tagName?.toLowerCase();
    if (!tag) return;

    // Headings
    if (/^h[1-6]$/.test(tag)) {
        const level = parseInt(tag[1], 10);
        const text = $(el).text().replace(/\s+/g, ' ').trim();
        if (text) {
            acc.push('');
            acc.push(`${'#'.repeat(level)} ${text}`);
            acc.push('');
        }
        return;
    }

    // Lists
    if (tag === 'ul' || tag === 'ol') {
        acc.push('');
        $(el).children('li').each((_, li) => {
            const text = $(li).text().replace(/\s+/g, ' ').trim();
            if (text) acc.push(`${'  '.repeat(depth)}- ${text}`);
        });
        acc.push('');
        return;
    }

    // Paragraph
    if (tag === 'p') {
        const text = $(el).text().replace(/\s+/g, ' ').trim();
        if (text) { acc.push(text); acc.push(''); }
        return;
    }

    // Line break
    if (tag === 'br') { acc.push(''); return; }

    // Bold/strong — emit inline but don't add extra newlines
    if (tag === 'strong' || tag === 'b') {
        const text = $(el).text().replace(/\s+/g, ' ').trim();
        if (text) acc.push(`**${text}**`);
        return;
    }

    // Tables — flatten to pipe-separated rows
    if (tag === 'table') {
        $(el).find('tr').each((_, row) => {
            const cells = [];
            $(row).find('td, th').each((_, cell) => {
                cells.push($(cell).text().replace(/\s+/g, ' ').trim());
            });
            if (cells.some(c => c)) acc.push(cells.join(' | '));
        });
        acc.push('');
        return;
    }

    // Inline tags — recurse without adding whitespace
    if (INLINE_TAGS.has(tag)) {
        $(el).contents().each((_, child) => nodeToLines(child, $, acc, depth));
        return;
    }

    // Block containers — recurse
    $(el).contents().each((_, child) => nodeToLines(child, $, acc, depth));
}

/**
 * Optimizes raw HTML for Gemini.
 *
 * @param {string} html  Full raw page HTML
 * @returns {{
 *   markdown:      string,   // Clean markdown, ~15-20k chars max
 *   dataScripts:   string,   // JSON-LD + window state scripts, ~40k chars max
 *   structuredData: object[] // Parsed JSON-LD objects (JobPosting schema etc.)
 * }}
 */
function optimizeHtmlForAI(html) {
    if (!html) return { markdown: '', dataScripts: '', structuredData: [] };

    const $ = cheerio.load(html);

    // ── Step 1: Extract structured data BEFORE stripping scripts ─────────────
    const structuredData = [];
    const rawDataScripts = [];

    // JSON-LD — most valuable: often contains full JobPosting schema
    $('script[type="application/ld+json"]').each((_, el) => {
        const content = ($(el).html() || '').trim();
        if (!content) return;
        rawDataScripts.push(content);
        try { structuredData.push(JSON.parse(content)); } catch { /* malformed */ }
    });

    // Window state blobs (__NEXT_DATA__, window.__STATE__, etc.)
    $('script:not([src])').each((_, el) => {
        const content = ($(el).html() || '').trim();
        if (content.length < 100 || content.length > 200_000) return;
        if (content.includes('googletag') || content.includes('fbevents') ||
            content.includes('_gaq')      || content.includes('gtag(')) return;
        if (content.includes('__NEXT_DATA__') || content.includes('window.__') ||
            content.includes('"@type"')        || content.includes('initialState')) {
            rawDataScripts.push(content.slice(0, 50_000));
        }
    });

    // ── Step 2: Strip all noise from the DOM ─────────────────────────────────
    $(NOISE_SELECTORS.join(', ')).remove();

    // ── Step 3: Focus on main content region if available ────────────────────
    // Only accept a selector match if it has actual text content (skip-link anchors etc. can be empty)
    let mainEl = null;
    for (const sel of [
        'main', '[role="main"]', 'article',
        '.job-detail', '.vacancy-detail', '.job-description', '.jobDetails',
        '#job-detail', '#vacancy-detail', '#jobDescription',
        '.content-area', '.page-wrapper', '.page-content',
        '#main-content', '#content',
    ]) {
        const el = $(sel).first();
        if (el.length && el.text().trim().length > 100) { mainEl = el; break; }
    }

    const root = mainEl || $('body');

    // ── Step 4: Walk DOM → Markdown ───────────────────────────────────────────
    const lines = [];
    root.contents().each((_, child) => nodeToLines(child, $, lines));

    // Collapse excessive blank lines
    const markdown = lines
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, 20_000);

    // Cap data scripts
    const dataScripts = rawDataScripts
        .slice(0, 6)
        .join('\n\n---\n\n')
        .slice(0, 40_000);

    return { markdown, dataScripts, structuredData };
}

/**
 * Quick check: does the structured data contain a JobPosting schema?
 * If so, we can skip or heavily reduce the Gemini content pass.
 *
 * @param {object[]} structuredData  Parsed JSON-LD objects
 * @returns {object|null}
 */
function extractJobPostingSchema(structuredData) {
    for (const item of structuredData) {
        if (item?.['@type'] === 'JobPosting') return item;
        // Sometimes wrapped in @graph
        if (Array.isArray(item?.['@graph'])) {
            const found = item['@graph'].find(x => x?.['@type'] === 'JobPosting');
            if (found) return found;
        }
    }
    return null;
}

// ─── Schema-first field extraction ───────────────────────────────────────────

/**
 * Formats a salary value from a JobPosting baseSalary object.
 * Handles any currency, any unitText (MONTH / YEAR / HOUR / WEEK).
 */
function formatSalaryFromSchema(baseSalary) {
    if (!baseSalary) return null;
    const val = baseSalary.value;
    if (!val) return null;
    const currency = baseSalary.currency || '';
    const unit     = (val.unitText || 'YEAR').toUpperCase();
    const unitLabel = { YEAR: '/year', MONTH: '/month', HOUR: '/hour', WEEK: '/week' }[unit] || `/${unit.toLowerCase()}`;
    if (val.minValue && val.maxValue) return `${currency} ${val.minValue.toLocaleString()}–${val.maxValue.toLocaleString()}${unitLabel}`;
    if (val.value)                    return `${currency} ${val.value.toLocaleString()}${unitLabel}`;
    return null;
}

/**
 * Extracts a human-readable location string from jobLocation.
 * Handles single Place, array of Places, and TELECOMMUTE.
 */
function formatLocationFromSchema(jobLocation, jobLocationType) {
    // Remote / telecommute
    if (jobLocationType === 'TELECOMMUTE') return 'Remote';
    if (!jobLocation) return null;

    const loc = Array.isArray(jobLocation) ? jobLocation[0] : jobLocation;
    const addr = loc?.address;
    if (!addr) return null;

    const city    = addr.addressLocality  || '';
    const region  = addr.addressRegion    || '';
    const country = addr.addressCountry   || '';
    return [city, region, country].filter(Boolean).join(', ') || null;
}

/**
 * Maps schema employmentType codes to human-readable strings.
 * Works for strings or arrays, any ATS format.
 */
function formatEmploymentType(et) {
    if (!et) return 'Full-time';
    const MAP = {
        FULL_TIME: 'Full-time', PART_TIME: 'Part-time',
        CONTRACTOR: 'Contract', TEMPORARY: 'Contract',
        INTERN: 'Internship', VOLUNTEER: 'Volunteer',
        PER_DIEM: 'Per Diem', OTHER: 'Full-time',
    };
    const types = (Array.isArray(et) ? et : [et]);
    const mapped = types.map(t => MAP[t?.toUpperCase()] || t).filter(Boolean);
    return mapped.join(' / ') || 'Full-time';
}

/**
 * Extracts all structured fields from a JobPosting JSON-LD schema.
 * Returns null for any field not found — caller should fall back to Gemini for those.
 *
 * @param {object} schema  Parsed JobPosting schema object
 * @returns {{ title, location, salary, employment_type, experience, is_expired }}
 */
function extractFieldsFromSchema(schema) {
    if (!schema) return null;

    const title           = schema.title || null;
    const location        = formatLocationFromSchema(schema.jobLocation, schema.jobLocationType);
    const salary          = formatSalaryFromSchema(schema.baseSalary);
    const employment_type = formatEmploymentType(schema.employmentType);

    // Experience: some schemas include experienceRequirements as text
    let experience = null;
    const expReq = schema.experienceRequirements;
    if (typeof expReq === 'string' && expReq.length < 100) experience = expReq;
    else if (expReq?.['@type'] === 'OccupationalExperienceRequirements') {
        const months = expReq.monthsOfExperience;
        if (months) experience = `${Math.round(months / 12)}+ years`;
    }

    // Expiry — flag as urgent if closing within 3 days
    let is_expired = false;
    if (schema.validThrough) {
        const exp = new Date(schema.validThrough);
        if (!isNaN(exp) && exp < new Date()) is_expired = true;
    }

    return { title, location, salary, employment_type, experience, is_expired };
}

// ─── Company info from HTML meta tags ────────────────────────────────────────

/**
 * Extracts company name and sub_info from page meta tags.
 * Used to skip Phase-1 Gemini call when job links are already known from sitemap.
 *
 * @param {string} html      Raw page HTML
 * @param {string} pageUrl   Page URL (fallback for company name)
 * @returns {{ name: string, sub_info: string }}
 */
function extractCompanyInfoFromHtml(html, pageUrl) {
    if (!html) return { name: '', sub_info: '' };
    const $ = cheerio.load(html);

    // Phrases that are navigation labels / CTAs, never a company name (any language)
    const NAV_PHRASE_LIST = [
        // English
        'view all jobs','all jobs','apply now','job search','find jobs','search jobs',
        'job listings','open positions','current openings','explore careers','join our team',
        'work with us','find your next role','discover opportunities','jobs near you',
        'browse jobs','all openings','career opportunities','browse all jobs',
        // Dutch
        'bekijk alle vacatures','alle vacatures','vacatures bekijken','zoek vacatures',
        'zoek een baan','werken bij','alle openstaande vacatures',
        // German
        'stellenangebote','alle stellen','jetzt bewerben','stellen suchen','karriere',
        'offene stellen','alle offenen stellen',
        // French
        'nos offres','toutes nos offres','postuler','rechercher un emploi',
        "offres d'emploi",'toutes les offres',
        // Spanish
        'todas las ofertas','buscar empleo','ver ofertas','ofertas de trabajo',
        'trabajar con nosotros','ver todas las ofertas',
        // Portuguese
        'todas as vagas','buscar vagas','candidatar-se','oportunidades de carreira',
        // Italian
        'tutte le offerte','cerca lavoro','candidati ora','offerte di lavoro',
        // Nordic
        'alle ledige stillinger','søk jobb','ledige stillinger',
        'alla jobb','sök jobb','lediga tjänster',
        'kaikki työpaikat','hae töitä','avoimet työpaikat',
        // Chinese
        '查看所有职位','搜索职位','立即申请','职业机会','所有职位',
        // Japanese
        'すべての求人','求人を探す','応募する','採用情報',
        // Korean
        '모든 채용','채용 공고','지원하기','채용 정보',
        // Arabic
        'جميع الوظائف','ابحث عن وظيفة','قدم الآن','فرص العمل',
        // Hindi
        'सभी नौकरियां','नौकरी खोजें','अभी आवेदन करें',
        // Russian
        'все вакансии','найти работу','подать заявку','карьера',
        // Turkish
        'tüm ilanlar','iş ara','hemen başvur','kariyer fırsatları',
    ];
    const NAV_PHRASES = new RegExp(
        '^(' + NAV_PHRASE_LIST.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')$',
        'i'
    );

    // Strips common careers-page prefixes/suffixes from a company name
    const cleanName = (raw) => raw
        .replace(/^(jobs at|careers at|work at|vacancies at|vacatures bij|working at)\s+/i, '')
        .replace(/\s*[\|\-–—·]\s*(careers|jobs|vacancies|vacatures|werk)\s*$/i, '')
        .replace(/\s*(careers|jobs portal|job board)\s*$/i, '')
        .trim();

    // Domain slug for cross-checking (e.g. "experis" from "experis.nl")
    const domainSlug = (() => {
        try {
            const host = new URL(pageUrl).hostname.replace(/^www\./, '');
            return host.split('.')[0].toLowerCase(); // "experis" from "experis.nl"
        } catch { return ''; }
    })();

    // Company name — try several sources in priority order
    const rawName = (
        // og:site_name is the most reliable (set by the company, not affected by page content)
        $('meta[property="og:site_name"]').attr('content')  ||
        $('meta[name="application-name"]').attr('content')   ||
        (() => {
            // "Jobs at Acme Corp | Careers" → prefer segment that matches domain slug
            const title = $('title').text();
            const parts = title.split(/[|\-–—·]/).map(s => s.trim()).filter(s => s.length > 1 && !NAV_PHRASES.test(s.trim()));
            // First try: find segment whose slug matches domain (e.g. "Experis" matches "experis.nl")
            const domainMatch = parts.find(p => p.toLowerCase().replace(/\s+/g, '').includes(domainSlug) && domainSlug.length > 2);
            if (domainMatch) return domainMatch;
            // Second: prefer the longest part that isn't a nav phrase
            return parts.sort((a, b) => b.length - a.length)[0] || '';
        })() ||
        (() => {
            // Fallback: capitalise domain slug
            return domainSlug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        })()
    );
    const name = cleanName(rawName).slice(0, 100) || rawName.trim().slice(0, 100);

    // Sub info — description or first heading after stripping nav
    const desc = (
        $('meta[property="og:description"]').attr('content') ||
        $('meta[name="description"]').attr('content')         ||
        ''
    ).replace(/\s+/g, ' ').trim().slice(0, 120);

    return { name, sub_info: desc };
}

// ─── Requirements section extractor ──────────────────────────────────────────

/**
 * Pulls the requirements / qualifications / skills section from a markdown string.
 * Looks for common section headers used by job postings across any language/ATS.
 *
 * @param {string} markdown  Clean markdown from optimizeHtmlForAI
 * @returns {string}         The requirements text, up to 2 000 chars
 */
function extractRequirementsSection(markdown) {
    if (!markdown) return '';

    // Section header patterns across all major languages
    // Matches markdown headers (##/###) followed by requirements/profile/skills keywords
    const HEADER_PATTERNS = [
        // ── English ──────────────────────────────────────────────────────────────
        /#{1,4}\s*(requirements?|qualifications?|what you(?:'ll)? bring|you bring|must.have|your background)/i,
        /#{1,4}\s*(skills? required|technical\s+skills?|skills? &.+experience|skills? and experience)/i,
        /#{1,4}\s*(profile|candidate profile|ideal candidate|about you|who you are|what we('re| are) looking for)/i,
        /#{1,4}\s*(experience required|experience &.+skills?|your skills|your qualifications)/i,
        /#{1,4}\s*(what you('ll)? need|what you bring|what you offer|you have|you possess)/i,
        // ── Dutch ────────────────────────────────────────────────────────────────
        /#{1,4}\s*(vereisten|jouw profiel|wat breng jij mee|wat verwachten wij|dit breng jij mee)/i,
        /#{1,4}\s*(dit ben jij|hier herken jij je in|wat vragen we|wie ben jij|dit neem jij mee)/i,
        /#{1,4}\s*(jouw achtergrond|jouw kennis|jouw vaardigheden|kennis en vaardigheden|functie.eisen)/i,
        /#{1,4}\s*(wat wij vragen|wat jij meebrengt|jouw competenties|gewenst profiel)/i,
        // ── German ───────────────────────────────────────────────────────────────
        /#{1,4}\s*(anforderungen|dein profil|was du mitbringst|qualifikationen|was wir suchen)/i,
        /#{1,4}\s*(deine qualifikationen|dein hintergrund|das bringst du mit|das bringen sie mit)/i,
        /#{1,4}\s*(ihr profil|sie bringen mit|kenntnisse und fähigkeiten|voraussetzungen)/i,
        /#{1,4}\s*(was sie mitbringen|fachliche anforderungen|persönliche anforderungen)/i,
        // ── French ───────────────────────────────────────────────────────────────
        /#{1,4}\s*(prérequis|profil recherché|compétences requises|votre profil)/i,
        /#{1,4}\s*(ce que nous recherchons|ce que vous apportez|votre expérience|vos compétences)/i,
        /#{1,4}\s*(formation et expérience|qualifications requises|critères de sélection)/i,
        // ── Spanish ──────────────────────────────────────────────────────────────
        /#{1,4}\s*(requisitos|perfil del candidato|habilidades requeridas|lo que buscamos)/i,
        /#{1,4}\s*(qué buscamos|tu perfil|lo que necesitas|conocimientos requeridos)/i,
        /#{1,4}\s*(experiencia requerida|competencias|formación requerida)/i,
        // ── Portuguese ───────────────────────────────────────────────────────────
        /#{1,4}\s*(requisitos|perfil desejado|competências necessárias|o que procuramos)/i,
        /#{1,4}\s*(o que você precisa|sua experiência|qualificações necessárias)/i,
        // ── Italian ──────────────────────────────────────────────────────────────
        /#{1,4}\s*(requisiti|profilo del candidato|competenze richieste|cosa cerchiamo)/i,
        /#{1,4}\s*(cosa offri|la tua esperienza|qualifiche richieste)/i,
        // ── Swedish ──────────────────────────────────────────────────────────────
        /#{1,4}\s*(krav|din profil|vad vi söker|kvalifikationer|vad du behöver)/i,
        // ── Norwegian ────────────────────────────────────────────────────────────
        /#{1,4}\s*(krav|kvalifikasjoner|hva vi ser etter|din bakgrunn|hvem er du)/i,
        // ── Danish ───────────────────────────────────────────────────────────────
        /#{1,4}\s*(krav|kvalifikationer|hvad vi søger|din baggrund|dit profil)/i,
        // ── Polish ───────────────────────────────────────────────────────────────
        /#{1,4}\s*(wymagania|profil kandydata|umiejętności|czego szukamy|twój profil)/i,
        // ── Russian ──────────────────────────────────────────────────────────────
        /#{1,4}\s*(требования|профиль кандидата|навыки|что мы ищем|ваш опыт)/i,
        // ── Turkish ──────────────────────────────────────────────────────────────
        /#{1,4}\s*(gereksinimler|aranan nitelikler|aday profili|beklentilerimiz)/i,
        // ── Arabic ───────────────────────────────────────────────────────────────
        /#{1,4}\s*(المتطلبات|المؤهلات|المهارات المطلوبة|ما نبحث عنه)/,
        // ── Japanese ─────────────────────────────────────────────────────────────
        /#{1,4}\s*(応募資格|必須スキル|求める人材|必要なスキル)/,
        // ── Chinese ──────────────────────────────────────────────────────────────
        /#{1,4}\s*(任职要求|岗位要求|技能要求|我们在寻找)/,
        // ── Korean ───────────────────────────────────────────────────────────────
        /#{1,4}\s*(지원자격|필요역량|우대사항|자격요건)/,
    ];

    for (const pattern of HEADER_PATTERNS) {
        const match = markdown.match(pattern);
        if (match) {
            const start = match.index;
            return markdown.slice(start, start + 2000);
        }
    }

    // Fallback: return the second half of the markdown (requirements usually come after role description)
    // Return up to 4 000 chars to ensure we capture multi-section job posts
    const mid = Math.floor(markdown.length / 2);
    return markdown.slice(mid, mid + 4000);
}

module.exports = {
    optimizeHtmlForAI,
    extractJobPostingSchema,
    extractFieldsFromSchema,
    extractCompanyInfoFromHtml,
    extractRequirementsSection,
};
