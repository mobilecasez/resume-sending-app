const axios = require('axios');
const cheerio = require('cheerio');
const pdf = require('pdf-parse');
const fs = require('fs').promises;
const path = require('path');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const translate = require('@vitalets/google-translate-api').translate;

/**
 * Template-Based Cover Letter Generator
 * Uses Cover_Letter_Google_New.pdf template and does deep company research
 */

class TemplateCoverLetterGenerator {
    constructor() {
        this.templatePath = path.join(__dirname, 'Cover_Letter_Google_New.pdf');
        this.openaiApiKey = process.env.OPENAI_API_KEY || null;
        
        // List of invalid/generic words that should NEVER be used as company names
        this.invalidCompanyNames = [
            'home', 'careers', 'jobs', 'career', 'job', 'welcome', 'hiring', 
            'about', 'contact', 'login', 'register', 'apply', 'search',
            'opportunities', 'vacancy', 'vacancies', 'positions', 'openings',
            'work', 'employment', 'recruit', 'recruiting', 'recruitment',
            'talent', 'join', 'team', 'culture', 'benefits', 'company',
            'undefined', 'null', 'error', 'page', 'website', 'site',
            'the company', 'our company', 'employer', 'organization'
        ];
    }

    /**
     * Detect and translate non-English text to English
     */
    async detectAndTranslate(text) {
        if (!text || text.trim().length === 0) return text;

        try {
            const result = await translate(text, { to: 'en' });
            
            if (result.from.language.iso !== 'en') {
                console.log(`🌍 Detected ${result.from.language.iso.toUpperCase()} - Translating to English`);
                return result.text;
            }
            
            return text;
        } catch (error) {
            return text; // Fallback to original
        }
    }

    /**
     * Extract text from PDF resume
     */
    async extractResumeText(resumePath) {
        try {
            const dataBuffer = await fs.readFile(resumePath);
            const data = await pdf(dataBuffer);
            return data.text;
        } catch (error) {
            console.error('Error extracting resume:', error.message);
            
            // If file not found, throw user-friendly error
            if (error.code === 'ENOENT') {
                throw new Error('Please upload your resume to generate cover letters');
            }
            
            return null;
        }
    }

    /**
     * Parse resume to extract skills, experience, education
     */
    parseResumeData(resumeText) {
        const data = {
            skills: [],
            experience: [],
            education: [],
            summary: ''
        };

        if (!resumeText) return data;

        // Extract skills (common patterns)
        const skillsSection = resumeText.match(/(?:SKILLS|TECHNICAL SKILLS|EXPERTISE)[\s\S]{0,500}/i);
        if (skillsSection) {
            const skills = skillsSection[0].match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) || [];
            data.skills = skills.filter(skill => 
                skill.length > 2 && 
                !['Skills', 'Technical', 'Expertise'].includes(skill)
            ).slice(0, 15);
        }

        // Extract experience
        const expMatches = resumeText.matchAll(/(?:^|\n)([A-Z][^•\n]{10,80})\s*[\|•]\s*([^\n]{5,50})/gm);
        for (const match of expMatches) {
            data.experience.push({
                title: match[1].trim(),
                company: match[2].trim()
            });
        }

        // Extract education
        const eduMatches = resumeText.matchAll(/(?:Bachelor|Master|MBA|PhD|B\.?S\.?|M\.?S\.?|B\.?Tech)[^\n]{10,100}/gi);
        for (const match of eduMatches) {
            data.education.push(match[0].trim());
        }

        // Extract summary
        const summaryMatch = resumeText.match(/\n([A-Z][^•\n]{50,300}\.)/);
        if (summaryMatch) {
            data.summary = summaryMatch[1].trim();
        }

        return data;
    }

    /**
     * Find and scrape About Us page
     */
    async scrapeAboutPage(websiteUrl) {
        try {
            const baseUrl = new URL(websiteUrl).origin;
            const aboutPaths = [
                '/about',
                '/about-us',
                '/aboutus',
                '/about-company',
                '/company',
                '/who-we-are',
                '/our-story'
            ];

            for (const path of aboutPaths) {
                try {
                    const url = baseUrl + path;
                    console.log(`🔍 Checking: ${url}`);
                    
                    const response = await axios.get(url, {
                        timeout: 8000,
                        headers: { 'User-Agent': 'Mozilla/5.0' },
                        validateStatus: (status) => status === 200
                    });

                    const $ = cheerio.load(response.data);
                    $('script, style, nav, footer, header').remove();

                    const content = $('main, article, .content, .about').first()
                        .text()
                        .replace(/\s+/g, ' ')
                        .trim()
                        .slice(0, 2000);

                    if (content.length > 100) {
                        console.log(`✅ Found About page: ${url}`);
                        const translated = await this.detectAndTranslate(content);
                        return translated;
                    }
                } catch (err) {
                    continue; // Try next path
                }
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    /**
     * Find and scrape Careers page to find matching positions
     */
    async scrapeCareersPage(websiteUrl, userSkills) {
        try {
            const baseUrl = new URL(websiteUrl).origin;
            const careerPaths = [
                '/careers',
                '/jobs',
                '/career',
                '/work-with-us',
                '/join-us',
                '/opportunities',
                '/job-openings'
            ];

            for (const path of careerPaths) {
                try {
                    const url = baseUrl + path;
                    console.log(`💼 Checking: ${url}`);
                    
                    const response = await axios.get(url, {
                        timeout: 8000,
                        headers: { 'User-Agent': 'Mozilla/5.0' },
                        validateStatus: (status) => status === 200
                    });

                    const $ = cheerio.load(response.data);
                    
                    // Extract job listings
                    const jobs = [];
                    $('[class*="job"], [class*="position"], [class*="vacancy"], .career-item').each((i, el) => {
                        const jobText = $(el).text().toLowerCase();
                        const matchedSkills = userSkills.filter(skill => 
                            jobText.includes(skill.toLowerCase())
                        );

                        if (matchedSkills.length > 0) {
                            jobs.push({
                                title: $(el).find('h2, h3, h4, .title').first().text().trim(),
                                skills: matchedSkills
                            });
                        }
                    });

                    if (jobs.length > 0) {
                        console.log(`✅ Found ${jobs.length} matching positions on Careers page`);
                        return jobs.slice(0, 3); // Top 3 matches
                    }
                } catch (err) {
                    continue;
                }
            }

            return [];
        } catch (error) {
            return [];
        }
    }

    /**
     * Deep scrape company website (homepage, about, careers, culture, tech stack)
     */
    async deepScrapeCompany(websiteUrl, userSkills) {
        if (!websiteUrl) return null;

        try {
            console.log(`\n🌐 Deep scanning website: ${websiteUrl}\n`);

            // 1. Scrape homepage
            let homepageUrl = websiteUrl;
            if (!homepageUrl.startsWith('http')) {
                homepageUrl = 'https://' + homepageUrl;
            }

            let response;
            try {
                // First attempt with full headers
                response = await axios.get(homepageUrl, {
                    timeout: 15000,
                    headers: { 
                        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.5',
                        'Accept-Encoding': 'gzip, deflate, br',
                        'Connection': 'keep-alive',
                        'Upgrade-Insecure-Requests': '1'
                    },
                    validateStatus: (status) => status >= 200 && status < 400
                });
            } catch (firstError) {
                console.log('First attempt failed, trying with www prefix...');
                try {
                    // Try with www prefix
                    const wwwUrl = homepageUrl.replace('https://', 'https://www.');
                    response = await axios.get(wwwUrl, {
                        timeout: 15000,
                        headers: { 
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                        },
                        validateStatus: (status) => status >= 200 && status < 400
                    });
                    homepageUrl = wwwUrl;
                } catch (secondError) {
                    console.log('Second attempt failed, trying without www...');
                    // Try without www
                    const noWwwUrl = homepageUrl.replace('://www.', '://');
                    response = await axios.get(noWwwUrl, {
                        timeout: 15000,
                        headers: { 
                            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                        },
                        validateStatus: (status) => status >= 200 && status < 400
                    });
                    homepageUrl = noWwwUrl;
                }
            }

            if (!response.data || response.data.length < 100) {
                throw new Error('Website returned insufficient data');
            }

            const $ = cheerio.load(response.data);
            const fullHtml = response.data.toLowerCase();
            $('script, style, nav, footer, header').remove();

            const title = $('title').text().trim();
            const metaDescription = $('meta[name="description"]').attr('content') || '';
            const h1s = $('h1').map((i, el) => $(el).text().trim()).get().slice(0, 5);
            const h2s = $('h2').map((i, el) => $(el).text().trim()).get().slice(0, 10);
            const h3s = $('h3').map((i, el) => $(el).text().trim()).get().slice(0, 10);
            
            // Extract ALL meaningful paragraphs (this captures product descriptions, services, etc.)
            const allParagraphs = $('p').map((i, el) => $(el).text().trim()).get()
                .filter(p => p.length > 40 && p.length < 800) // Substantial content only
                .slice(0, 15); // Get more paragraphs
            
            // Extract list items (often contains services, products, features)
            const listItems = $('li').map((i, el) => $(el).text().trim()).get()
                .filter(li => li.length > 20 && li.length < 300)
                .slice(0, 15);
            
            // Extract main content sections (often where detailed info lives)
            const mainContent = $('main, article, .content, .about, .services, .solutions, .products, section').first()
                .text()
                .replace(/\s+/g, ' ')
                .trim()
                .substring(0, 3000); // Get substantial content

            if (!title && h1s.length === 0) {
                throw new Error('Could not extract company information from website');
            }

            console.log('🏠 Homepage analyzed - extracted detailed content');

            // Translate homepage content
            const translatedTitle = await this.detectAndTranslate(title);
            const translatedDescription = await this.detectAndTranslate(metaDescription);
            
            const translatedH1s = [];
            for (const h1 of h1s) {
                translatedH1s.push(await this.detectAndTranslate(h1));
            }

            // 2. Find About page with MORE details
            const aboutContent = await this.scrapeAboutPage(homepageUrl);

            // 3. Find Careers page and matching positions
            const matchingJobs = await this.scrapeCareersPage(homepageUrl, userSkills);

            // 4. Detect company CULTURE keywords
            const cultureKeywords = {
                innovation: /innovat(e|ion|ive)|cutting.edge|breakthrough|pioneer/i,
                collaboration: /collaborat(e|ion|ive)|teamwork|together|partnership/i,
                quality: /quality|excellence|best.practices|standards/i,
                growth: /growth|learning|development|career|advancement/i,
                diversity: /diversity|inclusion|equal.opportunity|inclusive/i,
                customerFocus: /customer.first|client.focused|user.centered/i,
                agile: /agile|flexible|adaptive|dynamic/i
            };
            
            const detectedCulture = [];
            Object.keys(cultureKeywords).forEach(key => {
                if (cultureKeywords[key].test(fullHtml)) {
                    detectedCulture.push(key);
                }
            });

            // 5. Detect TECH STACK
            const techStack = [];
            const techKeywords = ['react', 'angular', 'vue', 'node.js', 'python', 'java', 'aws', 'azure', 'docker', 'kubernetes', 'microservices', 'ai', 'machine learning', 'data science', 'cloud', 'devops', 'agile', 'scrum'];
            techKeywords.forEach(tech => {
                if (fullHtml.includes(tech)) {
                    techStack.push(tech.charAt(0).toUpperCase() + tech.slice(1));
                }
            });

            // 6. Extract VALUES and MISSION
            const valuesKeywords = ['mission', 'vision', 'values', 'purpose', 'why we', 'our philosophy'];
            let missionStatement = '';
            valuesKeywords.forEach(keyword => {
                const regex = new RegExp(`${keyword}[^.]{10,300}[.]`, 'i');
                const match = $('body').text().match(regex);
                if (match && !missionStatement) {
                    missionStatement = match[0].trim();
                }
            });
            if (missionStatement) {
                missionStatement = await this.detectAndTranslate(missionStatement);
            }

            // 7. Extract contact info (HR email, address)
            const hrEmails = response.data.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g) || [];
            const hrEmail = hrEmails.find(email => 
                email.toLowerCase().includes('hr') || 
                email.toLowerCase().includes('recruit') ||
                email.toLowerCase().includes('career')
            ) || hrEmails[0];

            // Extract address from schema.org or footer
            let address = '';
            const addressScript = $('script[type="application/ld+json"]').text();
            if (addressScript) {
                try {
                    const schema = JSON.parse(addressScript);
                    if (schema.address) {
                        address = typeof schema.address === 'string' 
                            ? schema.address 
                            : `${schema.address.streetAddress || ''}, ${schema.address.addressLocality || ''}, ${schema.address.addressCountry || ''}`;
                    }
                } catch (e) {}
            }

            // 8. Extract UNIQUE INSIGHTS (awards, partnerships, recent news)
            const uniqueInsights = [];
            const insightKeywords = ['award', 'recognized', 'partnership', 'acquired', 'funding', 'series', 'leader', 'top company', 'best place to work'];
            insightKeywords.forEach(keyword => {
                const regex = new RegExp(`[^.]{30,200}${keyword}[^.]{10,100}[.]`, 'i');
                const match = $('body').text().match(regex);
                if (match) {
                    uniqueInsights.push(match[0].trim().substring(0, 150));
                }
            });

            console.log('\n✅ Deep scan complete\n');
            
            // Extract the best company name using multiple sources
            // Re-load cheerio without removing footer for company name extraction
            const $full = cheerio.load(response.data);
            const bestCompanyName = await this.extractBestCompanyName(
                homepageUrl, 
                $full, 
                title, 
                metaDescription
            );

            return {
                homepage: {
                    title: translatedTitle,
                    description: translatedDescription,
                    headings: translatedH1s,
                    subheadings: h2s
                },
                about: aboutContent,
                culture: detectedCulture,
                techStack: techStack,
                mission: missionStatement,
                uniqueInsights: uniqueInsights.slice(0, 2),
                careers: {
                    matchingPositions: matchingJobs,
                    count: matchingJobs.length
                },
                contact: {
                    hrEmail: hrEmail || null,
                    address: address || null
                },
                domain: new URL(homepageUrl).hostname,
                companyName: bestCompanyName // Extracted company name
            };

        } catch (error) {
            console.error('Error in deep scrape:', error.message);
            return null;
        }
    }

    /**
     * Extract company name from email domain or URL
     */
    extractCompanyFromEmail(email) {
        const domain = email.split('@')[1];
        if (!domain) return null;
        
        // Ignore common email providers
        const commonProviders = ['gmail', 'yahoo', 'outlook', 'hotmail', 'icloud', 'protonmail', 'aol'];
        const domainName = domain.split('.')[0].toLowerCase();
        
        if (commonProviders.includes(domainName)) {
            return null;
        }
        
        const name = domain.split('.')[0];
        const formattedName = name.charAt(0).toUpperCase() + name.slice(1);
        return this.isValidCompanyName(formattedName) ? formattedName : null;
    }
    
    /**
     * Extract the best company name using multiple sources and validation
     * Priority: 1) Page title (validated), 2) Meta tags, 3) OG tags, 4) URL parsing, 5) AI extraction
     */
    async extractBestCompanyName(websiteUrl, $, pageTitle, metaDescription) {
        const candidates = [];

        const addCandidate = (source, rawName, priority) => {
            const cleanedName = this.cleanCompanyNameCandidate(rawName);
            if (cleanedName && this.isValidCompanyName(cleanedName)) {
                candidates.push({ source, name: cleanedName, priority });
            }
        };

        // 0. Try extracting legal/full entity name from WordPress API pages (often includes Impressum/legal text)
        const wpLegalName = await this.extractLegalCompanyNameFromWordPress(websiteUrl);
        if (wpLegalName) {
            addCandidate('wp-legal', wpLegalName, -1); // Highest priority
        }
        
        // 1. Try extracting from page title (split by common separators)
        if (pageTitle) {
            // Split by common separators: |, -, –, —, :, >
            const titleParts = pageTitle.split(/\s*[\|\-–—:>]\s*/);
            for (const part of titleParts) {
                addCandidate('title', part.trim(), 1);
            }
        }
        
        // 2. Try OG site name (often the most reliable)
        if ($) {
            const ogSiteName = $('meta[property="og:site_name"]').attr('content');
            addCandidate('og:site_name', ogSiteName, 0);
            
            // 3. Try structured data (JSON-LD)
            $('script[type="application/ld+json"]').each((i, el) => {
                try {
                    const jsonLd = JSON.parse($(el).html());
                    addCandidate('json-ld', jsonLd.name, 0);
                    addCandidate('json-ld-hiring', jsonLd.hiringOrganization?.name, 0);
                    addCandidate('json-ld-org', jsonLd.organization?.name, 0);
                } catch (e) { /* ignore parse errors */ }
            });
            
            // 4. Look for company name in footer copyright
            const footerText = $('footer').text();
            const copyrightMatch = footerText.match(/(?:©|copyright|\(c\))\s*(?:\d{4})?\s*([A-Z][A-Za-z0-9\s&\.]+?)(?:\.|\s*all|\s*rights|,|$)/i);
            addCandidate('copyright', copyrightMatch?.[1], 2);
            
            // 5. Look for logo alt text
            const logoAlt = $('img[class*="logo"], img[id*="logo"], .logo img, #logo img, header img').first().attr('alt');
            addCandidate('logo-alt', logoAlt, 2);
        }
        
        // 6. Extract from URL
        const urlName = this.extractCompanyFromUrl(websiteUrl);
        if (urlName) {
            addCandidate('url', urlName, 3);
        }
        
        // 7. Try extracting from meta description
        if (metaDescription) {
            // Look for patterns like "Company Name is..." or "At Company Name,..."
            const descMatch = metaDescription.match(/^(?:at\s+)?([A-Z][A-Za-z0-9\s&\.]+?)(?:\s+is\s|\s+we\s|,|\.|\s+-)/i);
            addCandidate('meta-desc', descMatch?.[1], 2);
        }
        
        // Sort by priority (lower = better) and pick the best
        candidates.sort((a, b) => a.priority - b.priority);
        
        if (candidates.length > 0) {
            console.log(`📍 Company name candidates: ${candidates.map(c => `${c.name} (${c.source})`).join(', ')}`);
            console.log(`✅ Selected: ${candidates[0].name} from ${candidates[0].source}`);
            return candidates[0].name;
        }
        
        // 8. Last resort: Use AI to extract company name
        return await this.aiExtractCompanyName(websiteUrl, pageTitle, metaDescription);
    }

    /**
     * Try extracting legal/full employer name from WordPress JSON API pages.
     */
    async extractLegalCompanyNameFromWordPress(websiteUrl) {
        try {
            const normalizedUrl = websiteUrl.startsWith('http') ? websiteUrl : `https://${websiteUrl}`;
            const origin = new URL(normalizedUrl).origin;
            const apiUrl = `${origin}/wp-json/wp/v2/pages?per_page=100`;

            const response = await axios.get(apiUrl, {
                timeout: 10000,
                headers: { 'User-Agent': 'Mozilla/5.0' },
                validateStatus: (status) => status >= 200 && status < 400
            });

            const raw = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
            const decoded = raw
                .replace(/&amp;/gi, '&')
                .replace(/&#8211;|&ndash;/gi, '-')
                .replace(/&#8212;|&mdash;/gi, '-');

            const legalNameRegex = /\b([A-Z][A-Za-z0-9&'.-]*(?:\s+[A-Z][A-Za-z0-9&'.-]*){0,7}\s+(?:AG|GmbH|Ltd|Limited|Inc|LLC|S\.?A\.?|SARL|BV|UG|KG|GbR))\b/g;
            const matches = [];
            let match;

            while ((match = legalNameRegex.exec(decoded)) !== null) {
                const candidate = this.cleanCompanyNameCandidate(match[1]);
                if (candidate && this.isValidCompanyName(candidate)) {
                    matches.push(candidate);
                }
            }

            if (matches.length === 0) return null;

            const urlName = (this.extractCompanyFromUrl(websiteUrl) || '').toLowerCase().replace(/\s+/g, '');
            const related = matches.filter((name) => {
                const normalized = name.toLowerCase().replace(/\s+/g, '');
                if (!urlName) return true;
                return normalized.includes(urlName.slice(0, 3)) || urlName.includes(normalized.slice(0, 3));
            });

            const pool = related.length > 0 ? related : matches;
            pool.sort((a, b) => {
                const aWords = a.split(/\s+/).length;
                const bWords = b.split(/\s+/).length;
                return bWords - aWords || b.length - a.length;
            });
            return pool[0];
        } catch (error) {
            return null;
        }
    }

    /**
     * Clean noisy title/metadata values into a likely company name.
     */
    cleanCompanyNameCandidate(name) {
        if (!name || typeof name !== 'string') return null;

        let cleaned = name
            .replace(/&amp;/gi, '&')
            .replace(/&#8211;|&ndash;/gi, '-')
            .replace(/&#8212;|&mdash;/gi, '-')
            .replace(/\s+/g, ' ')
            .trim();

        const legalMatch = cleaned.match(/([A-Z][A-Za-z0-9&'.-]*(?:\s+[A-Z][A-Za-z0-9&'.-]*){0,7}\s+(?:AG|GmbH|Ltd|Limited|Inc|LLC|S\.?A\.?|SARL|BV|UG|KG|GbR))/i);
        if (legalMatch && legalMatch[1]) {
            return legalMatch[1].trim();
        }

        // Drop slogan tails such as "SIE suchen - WIR finden" after separators.
        cleaned = cleaned.split(/\s*[\|\-–—:>]\s*/)[0].trim();

        // Remove obvious slogan/boilerplate fragments.
        cleaned = cleaned
            .replace(/\b(sie suchen|wir finden|home|welcome|startseite)\b/gi, '')
            .replace(/\s{2,}/g, ' ')
            .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')
            .trim();

        return cleaned || null;
    }

    isSloganLikeName(name) {
        if (!name || typeof name !== 'string') return true;
        const lower = name.toLowerCase();
        return /(sie suchen|wir finden|home|startseite|comment feed|\bfeed\b|willkommen|you search|we find)/i.test(lower);
    }

    scoreCompanyNameCandidate(name, urlCompanyName) {
        if (!name || typeof name !== 'string') return -999;

        const cleaned = this.cleanCompanyNameCandidate(name);
        if (!cleaned || !this.isValidCompanyName(cleaned)) return -999;

        let score = 0;
        const lower = cleaned.toLowerCase();
        const words = cleaned.split(/\s+/).length;
        const urlStem = (urlCompanyName || '').toLowerCase().replace(/\s+/g, '');
        const normalized = lower.replace(/\s+/g, '');

        if (/(ag|gmbh|ltd|limited|inc|llc|s\.?a\.?|sarl|bv|ug|kg|gbr)$/i.test(cleaned)) score += 80;
        if (words >= 2) score += 15;
        if (words >= 3) score += 10;
        if (cleaned.length >= 6 && cleaned.length <= 80) score += 10;
        if (urlStem && (normalized.includes(urlStem.slice(0, 3)) || urlStem.includes(normalized.slice(0, 3)))) score += 20;

        if (this.isSloganLikeName(cleaned)) score -= 120;
        if (/[\-–—|]/.test(cleaned)) score -= 15;

        return score;
    }

    chooseBestCompanyName(candidates, urlCompanyName, fallback = 'the Company') {
        let best = null;
        let bestScore = -999;

        for (const candidate of candidates) {
            const cleaned = this.cleanCompanyNameCandidate(candidate);
            const score = this.scoreCompanyNameCandidate(cleaned, urlCompanyName);
            if (score > bestScore) {
                bestScore = score;
                best = cleaned;
            }
        }

        if (best && this.isValidCompanyName(best) && !this.isSloganLikeName(best)) {
            return best;
        }

        const fallbackClean = this.cleanCompanyNameCandidate(fallback);
        return (fallbackClean && this.isValidCompanyName(fallbackClean)) ? fallbackClean : 'the Company';
    }
    
    /**
     * Use AI to extract company name when all other methods fail
     */
    async aiExtractCompanyName(websiteUrl, pageTitle, metaDescription) {
        try {
            const geminiApiKey = process.env.GEMINI_API_KEY;
            if (!geminiApiKey) {
                console.log('⚠️ No Gemini API key, falling back to URL-based name');
                return 'the Company';
            }
            
            const { GoogleGenerativeAI } = require('@google/generative-ai');
            const genAI = new GoogleGenerativeAI(geminiApiKey);
            const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash-latest' });
            
            const prompt = `Extract the actual company/organization name from this website information.

Website URL: ${websiteUrl}
Page Title: ${pageTitle || 'N/A'}
Meta Description: ${metaDescription || 'N/A'}

IMPORTANT RULES:
- Return ONLY the company name, nothing else
- DO NOT return generic words like: Home, Careers, Jobs, Welcome, About, Contact
- You MUST research the EXACT domain provided — the TLD matters (.ch is NOT .com, .co.uk is NOT .com)
- If the URL has a subdomain like "career.limeflight.com", the company is likely "Limeflight" (ignore generic subdomains like career/jobs/hiring)
- If the URL is like "jobsatcompany.com", extract "Company" as the name
- If the URL is like "companyname-careers.com", extract "CompanyName"
- If you cannot determine the company name with certainty, return "UNKNOWN"

Company name:`;
            
            const result = await model.generateContent(prompt);
            const response = await result.response;
            const text = response.text();
            
            if (!text || text.trim() === '') {
                throw new Error('Gemini returned empty response');
            }
            
            const companyName = text.trim();
            
            if (companyName && companyName !== 'UNKNOWN' && this.isValidCompanyName(companyName)) {
                console.log(`🤖 AI extracted company name: ${companyName}`);
                return companyName;
            }
        } catch (error) {
            console.log('⚠️ AI company name extraction failed:', error.message);
        }
        
        return 'the Company';
    }
    
    /**
     * Extract company name from website URL with smart parsing
     * Handles patterns like: jobsatcompany, companycareer, workatcompany, etc.
     */
    extractCompanyFromUrl(url) {
        try {
            const urlObj = new URL(url.startsWith('http') ? url : `https://${url}`);
            let hostname = urlObj.hostname.replace('www.', '').toLowerCase();
            const hostParts = hostname.split('.');
            let name = hostParts[0];
            
            // Generic subdomains that indicate the real company is in the next part
            const genericSubdomains = [
                'career', 'careers', 'jobs', 'job', 'hiring', 'recruit', 'recruiting',
                'recruitment', 'talent', 'join', 'work', 'apply', 'opportunities',
                'portal', 'app', 'hr', 'people', 'team', 'boards', 'board'
            ];
            
            // If first part is a generic subdomain and there are more parts, use the next part
            // e.g., career.limeflight.com -> limeflight
            if (genericSubdomains.includes(name) && hostParts.length >= 3) {
                name = hostParts[1];
            }
            
            // Common job portal patterns to extract actual company name
            const jobPatterns = [
                /^jobsat(.+)$/i,      // jobsateneco -> eneco
                /^workat(.+)$/i,      // workatgoogle -> google
                /^careerat(.+)$/i,    // careeratapple -> apple
                /^careersat(.+)$/i,   // careersatmeta -> meta
                /^jointhe(.+)$/i,     // jointheteam -> team (but will be filtered)
                /^join(.+)$/i,        // joinspotify -> spotify
                /^(.+)careers$/i,     // googlecareers -> google
                /^(.+)jobs$/i,        // applejobs -> apple
                /^(.+)career$/i,      // microsoftcareer -> microsoft
                /^(.+)hiring$/i,      // netflixhiring -> netflix
                /^(.+)recruit$/i,     // amazonrecruit -> amazon
                /^(.+)talent$/i,      // metatalent -> meta
            ];
            
            for (const pattern of jobPatterns) {
                const match = name.match(pattern);
                if (match && match[1] && match[1].length >= 2) {
                    name = match[1];
                    break;
                }
            }
            
            // Capitalize properly
            const formattedName = name.charAt(0).toUpperCase() + name.slice(1);
            
            // Check if it's a valid company name
            if (this.isValidCompanyName(formattedName)) {
                return formattedName;
            }
            
            return null; // Return null so we can try other methods
        } catch {
            return null;
        }
    }
    
    /**
     * Check if a string is a valid company name (not generic/invalid)
     */
    isValidCompanyName(name) {
        if (!name || typeof name !== 'string') return false;
        const cleaned = name.trim().toLowerCase();
        if (cleaned.length < 2) return false;
        if (this.invalidCompanyNames.includes(cleaned)) return false;
        if (/\b(sie suchen|wir finden|home|startseite|comment feed|feed)\b/i.test(cleaned)) return false;
        // Check if it's mostly numbers
        if (/^\d+$/.test(cleaned)) return false;
        return true;
    }

    /**
     * Generate cover letter content with deep matching and unique insights (returns TEXT)
     * ALL IN PROFESSIONAL ENGLISH - No foreign language text
     */
    generateCoverLetterContent(userData, resumeData, companyData, position) {
        // Handle case where company data scraping failed
        if (!companyData) {
            companyData = {
                homepage: { title: '', description: '', headings: [] },
                about: null,
                culture: [],
                techStack: [],
                mission: '',
                uniqueInsights: [],
                careers: { matchingPositions: [], count: 0 },
                contact: { hrEmail: null, address: null }
            };
        }
        
        // Use the validated company name from companyData, or fallback with validation
        let companyName = companyData.companyName;
        if (!companyName || !this.isValidCompanyName(companyName)) {
            // Try from email as last resort
            companyName = this.extractCompanyFromEmail(userData.email) || 'the Company';
        }

        // DEEP SKILL MATCHING
        const userTechSkills = resumeData.technicalSkills || resumeData.skills;
        const userSoftSkills = resumeData.softSkills || [];
        const companyTech = companyData.techStack || [];
        const companyCulture = companyData.culture || [];
        
        // Match technical skills with company tech stack
        const techMatches = userTechSkills.filter(skill => 
            companyTech.some(tech => tech.toLowerCase().includes(skill.toLowerCase()) || skill.toLowerCase().includes(tech.toLowerCase()))
        );
        
        // Match soft skills with culture
        const cultureMatches = userSoftSkills.filter(skill => 
            companyCulture.some(cult => skill.toLowerCase().includes(cult.toLowerCase()))
        );

        // Build experience summary
        const yearsExp = resumeData.yearsOfExperience || (resumeData.experience.length * 2);
        const topSkills = userTechSkills.slice(0, 3).join(', ');
        const recentCompany = resumeData.experience[0]?.company || 'leading organizations';
        const recentRole = resumeData.experience[0]?.title || 'professional roles';

        // Find best matching job from careers page
        let bestMatchingJob = null;
        if (companyData.careers?.matchingPositions?.length > 0) {
            bestMatchingJob = companyData.careers.matchingPositions[0];
        }

        // === PARAGRAPH 1: Opening with Profound Interest and Role Alignment ===
        const jobTitle = bestMatchingJob ? bestMatchingJob.title : position;
        const openingPara = `I am writing to express my profound interest in the ${jobTitle} position at ${companyName}. With over ${yearsExp} years of dedicated experience in ${topSkills}, combined with a proven track record in leading software development and delivery, I am confident in my ability to immediately contribute to your mission${companyData.mission ? ' of ' + companyData.mission.toLowerCase() : ' and drive exceptional results'}.`;

        // === PARAGRAPH 2: Career Goals and Role Fit ===
        const careerGoalPara = `My resume details a career focused on managing the full project lifecycle, from scoping to go-live, for multiple enterprise software solutions. I am specifically seeking a challenging leadership role${userData.country === 'Switzerland' || companyName.includes('Swiss') ? ' in Switzerland' : ''}, and the opportunity to ${bestMatchingJob?.description?.toLowerCase().includes('lead') ? 'lead a technical team and' : 'contribute to'} design architecture for high-impact ${companyData.uniqueInsights?.some(i => i.toLowerCase().includes('finance')) ? 'financial' : companyData.uniqueInsights?.some(i => i.toLowerCase().includes('health')) ? 'health-tech' : 'web'} applications${bestMatchingJob ? ' in the ' + jobTitle + ' space' : ''} is an ideal fit.`;

        // === PARAGRAPH 3: How Experience Matches Requirements (Section Header) ===
        const matchHeaderPara = `How My Experience Directly Matches Your Requirements:\n\nMy qualifications align seamlessly with the technical and leadership requirements for this role:`;

        // === PARAGRAPH 4: Technical Alignment with Bullet Points ===
        let technicalAlignmentPara = '';
        if (techMatches.length > 0) {
            const primaryTech = techMatches.slice(0, 3);
            technicalAlignmentPara = `${primaryTech[0]} Architecture and Development: My hands-on experience is deeply rooted in ${primaryTech.join(', ')}${companyTech.length > 0 ? `, which aligns with ${companyName}'s technology stack including ${companyTech.slice(0, 2).join(' and ')}` : ''}. I possess the necessary deep understanding to define robust technical architectures and ensure coding excellence within your team.\n\n`;
        }

        // Add Cloud/DevOps if present in skills
        if (userTechSkills.some(s => s.toLowerCase().includes('azure') || s.toLowerCase().includes('devops') || s.toLowerCase().includes('cloud'))) {
            technicalAlignmentPara += `Cloud and DevOps Expertise: I have direct experience with ${userTechSkills.find(s => s.toLowerCase().includes('azure')) || 'cloud platforms'}, which directly supports your utilization of modern cloud infrastructure. My ability to efficiently leverage AI to enhance productivity and minimize manual effort speaks to the required deep understanding of DevOps principles for effective implementation.\n\n`;
        }

        // Add Agile/Leadership
        if (resumeData.experience[0]?.description?.some(d => d.toLowerCase().includes('team') || d.toLowerCase().includes('lead'))) {
            technicalAlignmentPara += `Agile Team Leadership: I have consistently managed cross-functional teams of 8+ developers and testers using Agile/Scrum methodologies. I am skilled in mentoring, coaching, and fostering a collaborative environment while liaising with global clients for requirement gathering, planning, and delivery.\n\n`;
        }

        // === PARAGRAPH 5: Value Proposition (Section Header) ===
        const valueHeaderPara = `My Value Proposition to ${companyName}:\n\nMy contribution to ${companyName} will be centered on driving technical modernization and maximizing team efficiency:`;

        // === PARAGRAPH 6: Specific Value Points ===
        let valuePropositionPara = '';
        
        // Migration/Modernization
        if (companyData.uniqueInsights?.some(i => i.toLowerCase().includes('cloud') || i.toLowerCase().includes('migration'))) {
            valuePropositionPara += `Successful Migration Leadership: With your current focus on migrating infrastructure to the cloud, my expertise in leading long-term modernization projects would be invaluable. I can help plan and execute this transition, ensuring minimal disruption and successful cloud adoption.\n\n`;
        }

        // Quality Delivery
        if (resumeData.experience.some(e => e.description?.some(d => d.toLowerCase().includes('sap') || d.toLowerCase().includes('integration')))) {
            valuePropositionPara += `Driving High-Quality Delivery: I have a track record of directing complex projects involving enterprise integrations like SAP and QuickBooks. This experience is critical for managing integrated platforms and ensuring the high quality and reliability of your ${companyData.uniqueInsights?.some(i => i.toLowerCase().includes('comparison')) ? 'comparison services' : 'core products'}${companyData.uniqueInsights?.some(i => i.toLowerCase().includes('insurance')) ? ' in insurance and finance' : ''}.\n\n`;
        }

        // Efficiency
        valuePropositionPara += `Technical and Operational Efficiency: My proficiency in ${topSkills} combined with experience in modern practices like ${userTechSkills.find(s => s.toLowerCase().includes('devops')) || 'Agile methodologies'} will ensure that the development team adheres to best practices and continuously improves workflows and efficiency.\n\n`;

        // === PARAGRAPH 7: Summary and Motivation ===
        const summaryPara = `My background is an exceptional fit for a role that requires both strategic architectural design and dedicated team leadership within a fast-paced, technology-driven organization. I am highly motivated to bring my ${yearsExp}+ years of experience to ${companyName} and help shape the future of your ${companyData.uniqueInsights?.some(i => i.toLowerCase().includes('platform')) ? 'platform' : 'products'}.`;

        // === PARAGRAPH 8: Professional Closing ===
        const closingPara = `Thank you for your time and consideration. I look forward to the possibility of discussing this exciting leadership opportunity further.`;

        // Build complete cover letter
        const coverLetterText = `${openingPara}\n\n${careerGoalPara}\n\n${matchHeaderPara}\n\n${technicalAlignmentPara}${valueHeaderPara}\n\n${valuePropositionPara}${summaryPara}\n\n${closingPara}`;

        return {
            coverLetterText,
            companyName,
            metadata: {
                techMatches,
                cultureMatches,
                matchingJobs: companyData.careers.matchingPositions || [],
                hrEmail: companyData.contact?.hrEmail,
                aboutPageFound: !!companyData?.about,
                careersPageFound: companyData?.careers?.count > 0,
                uniqueInsightsFound: (companyData.uniqueInsights || []).length > 0,
                bestMatchingJob: bestMatchingJob
            }
        };
    }

    /**
     * AI-powered company research fallback when scraping fails
     * Uses Google Gemini AI
     */
    async aiCompanyResearch(websiteUrl, companyName, userSkills) {
        const geminiKey = process.env.GEMINI_API_KEY;
        
        if (!geminiKey) {
            console.log('⚠️  No Gemini API key - using generic company data');
            return null;
        }

        try {
            console.log('🤖 Using Gemini AI to research company...');
            const { GoogleGenerativeAI } = require('@google/generative-ai');
            const genAI = new GoogleGenerativeAI(geminiKey);
            const model = genAI.getGenerativeModel({ model: 'gemini-2.5-pro' });

            const prompt = `Research and provide detailed information about the company at ${websiteUrl} (${companyName}). 

Based on the company name and website URL, provide:
1. A brief company description (2-3 sentences about what they do)
2. Company culture keywords (3-5 values like: innovation, collaboration, quality, growth, customer-focus, etc.)
3. Likely technologies they use based on their industry (3-5 tech tools/languages)
4. 1-2 notable facts, achievements, or unique aspects about them
5. A mission statement or company vision

Format your response as JSON:
{
    "description": "Brief description of what the company does",
    "culture": ["culture1", "culture2", "culture3"],
    "techStack": ["tech1", "tech2", "tech3"],
    "insights": ["notable fact 1", "notable fact 2"],
    "mission": "Company mission or vision statement"
}

Be professional and factual. If you don't have specific information, make reasonable industry-based assumptions.`;

            const result = await model.generateContent(prompt);
            const response = await result.response;
            const text = response.text();
            
            if (!text || text.trim() === '') {
                throw new Error('Gemini returned empty response for research');
            }
            
            // Extract JSON from response
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                throw new Error('Could not parse AI response');
            }
            
            const aiData = JSON.parse(jsonMatch[0]);
            console.log('✅ Gemini AI research completed');

            return {
                homepage: {
                    title: companyName,
                    description: aiData.description || '',
                    headings: []
                },
                about: aiData.description || null,
                culture: aiData.culture || [],
                techStack: aiData.techStack || [],
                mission: aiData.mission || '',
                uniqueInsights: aiData.insights || [],
                careers: { matchingPositions: [], count: 0 },
                contact: { hrEmail: null, address: null }
            };

        } catch (error) {
            console.error('Gemini AI research failed:', error.message);
            return null;
        }
    }

    /**
     * Use Gemini AI to research the company website and extract detailed intelligence
     */
    async researchCompanyWithAI(websiteUrl, companyName) {
        const geminiKey = process.env.GEMINI_API_KEY;
        
        if (!geminiKey) {
            console.log('⚠️  No Gemini API key - cannot research company');
            return null;
        }

        try {
            const { GoogleGenerativeAI } = require('@google/generative-ai');
            const genAI = new GoogleGenerativeAI(geminiKey);
            const model = genAI.getGenerativeModel({ 
                model: 'gemini-2.5-flash',
                generationConfig: {
                    temperature: 0.7,
                    topP: 0.95,
                    topK: 40,
                    maxOutputTokens: 4096,
                }
            });

                        const scrapedCompanyData = await this.deepScrapeCompany(websiteUrl, []);
                        const anchoredCompanyName = scrapedCompanyData?.companyName || companyName;

                        const exactSitePrompt = scrapedCompanyData ? `Role: You are an expert Headhunter performing deep company research to extract SPECIFIC PROPER NOUNS.

You must use ONLY the exact website content provided below. Do NOT use external knowledge, do NOT use search results, and do NOT infer details from similarly named domains.

**Company to Research:**
- EXACT Domain/URL: ${websiteUrl}
- URL-extracted name: ${companyName}
- Site-extracted company name: ${anchoredCompanyName}
- Site hostname: ${scrapedCompanyData.domain || websiteUrl}

**ABSOLUTELY CRITICAL - DOMAIN ACCURACY:**
You MUST stay anchored to the exact domain "${websiteUrl}".
- The TLD matters: .ch is NOT .com, .co.uk is NOT .com, .de is NOT .com
- Use ONLY the content below from the exact site we fetched
- If the exact site content does not mention products, clients, or partners, return "Not found" or "Could not find specific ... names"
- NEVER substitute facts from another company, another country, or another domain

**EXACT SITE CONTENT:**
- Title: ${scrapedCompanyData.homepage?.title || 'Not found'}
- Meta Description: ${scrapedCompanyData.homepage?.description || 'Not found'}
- Headings: ${(scrapedCompanyData.homepage?.headings || []).join(' | ') || 'Not found'}
- Subheadings: ${(scrapedCompanyData.homepage?.subheadings || []).join(' | ') || 'Not found'}
- About Page: ${scrapedCompanyData.about || 'Not found'}
- Mission: ${scrapedCompanyData.mission || 'Not found'}
- Tech Stack from site: ${(scrapedCompanyData.techStack || []).join(', ') || 'Not found'}
- Unique Site Details: ${(scrapedCompanyData.uniqueInsights || []).join(' | ') || 'Not found'}
- Careers Matches: ${scrapedCompanyData.careers?.count || 0}
- Contact Address: ${scrapedCompanyData.contact?.address || 'Not found'}

**MOST CRITICAL - Company Name Extraction:**
1. Find the FULL, OFFICIAL employer name as shown on the exact website (prefer legal/company-register style names)
2. Check title, footer copyright, contact page, legal notice, impressum, and about sections for the legal entity name
3. Prefer the longest valid official form when available (e.g., "ICMAG AG" over "ICMAG")
4. Do NOT replace it with a company from another domain
5. If unsure, keep the company name anchored to "${anchoredCompanyName}"

**EXTRACTION GOALS:**
1. Specific Product Names: only if explicitly visible in the exact site content
2. Specific Client Names: only if explicitly visible in the exact site content
3. Specific Partners/Tools/Technologies: only if explicitly visible in the exact site content
4. Founder/Leadership Background: only if explicitly visible in the exact site content
5. Company Focus & Methodology: summarize from the exact site content only

**VALIDATION RULES:**
- Do NOT invent or guess names
- Do NOT use generic terms like "their software" if the site gives no branded name
- If a category is missing from the site content, say "Could not find specific [category] names"

**Output Format (JSON):**
{
    "companyName": "Full official employer name with proper spacing and capitalization (prefer legal suffixes like AG, GmbH, Ltd, Inc, LLC when present on site)",
    "products": ["Product 1", "Product 2"],
    "clients": ["Client 1", "Client 2"],
    "technologies": ["Tech 1", "Tech 2", "Tech 3"],
    "partnerships": ["Partner 1", "Partner 2"],
    "businessModel": "Brief description of what they do",
    "mission": "Their mission statement or vision",
    "uniqueDetails": ["Unique fact 1", "Unique fact 2"],
    "industryFocus": "Industries they serve"
}

Return ONLY the JSON, no other text.` : null;

            const researchPrompt = `Role: You are an expert Headhunter performing deep company research to extract SPECIFIC PROPER NOUNS.

**Company to Research:**
- EXACT Domain/URL: ${websiteUrl}
- URL-extracted name: ${companyName}

**ABSOLUTELY CRITICAL - DOMAIN ACCURACY:**
You MUST research the EXACT domain "${websiteUrl}" — NOT any similar-sounding domain.
- The TLD matters: .ch is NOT .com, .co.uk is NOT .com, .de is NOT .com
- For example, if given "icmag.ch", research ONLY icmag.ch (a Swiss company), NOT icmag.com (a completely different company)
- NEVER substitute or guess a different domain. The user provided this exact URL for a reason.
- If you cannot find information about the exact domain, say so — do NOT return information about a different company on a different domain.

**MOST CRITICAL - Company Name Extraction:**
The first and MOST IMPORTANT task is to find the EXACT, OFFICIAL company name with proper spacing and capitalization.

CRITICAL RULES FOR COMPANY NAME:
1. The company name MUST be related to the domain "${companyName}"
2. Search the website's <title> tag, <h1>, About Us page, footer copyright, and meta tags
3. The name should be a properly spaced version of "${companyName}"
   - Example: "disruptivetechsolutions" → "Disruptive Tech Solutions" (add spaces between words)
   - Example: "techstack" → ONLY use this if it's actually the company name on the website
4. DO NOT return a completely different company name unless it's absolutely clear from the website
5. If unsure, use "${companyName}" with proper word spacing

**VALIDATION:**
- The extracted company name MUST contain parts of "${companyName}" 
- If the website shows a completely different name, verify it's not just a product/partner name
- When in doubt, format "${companyName}" with proper capitalization and spacing

**CRITICAL INSTRUCTIONS - Step 2: Deep Research & Entity Extraction**

After confirming the correct company name, extract the following "Proper Nouns":

1. **Specific Product Names** (CRITICAL):
   - Find the names of SaaS products, platforms, or tools they have built
   - Examples: "Simp Realty Platform", "Textbook Treasure", "Property Management SaaS"
   - Look for branded product names, not generic descriptions
   - If they build custom software, find client project names

2. **Specific Client Names** (CRITICAL):
   - Find actual company names they have worked with
   - Examples: "Capital Bank", "BCBS", "United Health Care", "Delphix"
   - Look in case studies, testimonials, client logos, or portfolio sections
   - Industry names are NOT enough - we need actual client company names

3. **Specific Partners/Tools/Technologies** (CRITICAL):
   - Find niche tools, platforms, or technologies they specialize in
   - Examples: "Delphix", "Salesforce", "Azure DevOps", "ASP.NET Core", "Angular"
   - Look for technology partnerships or certified partnerships
   - Find their exact tech stack if mentioned

4. **Founder/Leadership Background** (IMPORTANT):
   - Find the founder's name and professional background
   - Examples: "Founded by John Smith, former Supply Chain Director at IBM"
   - Look for leadership team bios or About Us pages
   - Note any unique expertise or industry experience

5. **Company Focus & Methodology** (IMPORTANT):
   - What industry do they focus on? (Healthcare, Finance, Real Estate, etc.)
   - Do they follow specific methodologies? (Agile, DevOps, etc.)
   - What makes them unique in their market?

**VALIDATION RULES:**
- If you cannot find specific product/client/partner names, explicitly state: "Could not find specific [product/client/partner] names"
- Do NOT invent or guess names
- Do NOT use generic terms like "their software" or "various clients"
- Prioritize finding at least 2-3 specific proper nouns from the categories above

**CRITICAL RULES:**
- Find SPECIFIC details, not generic descriptions
- Look for proper nouns (product names, client names, partner names)
- Extract actual quotes or phrases from their website
- If you can't find something, say "Not found" - don't make it up

**Output Format (JSON):**
{
  "companyName": "Exact company name with proper spacing and capitalization (e.g., 'Disruptive Tech Solutions' not 'disruptivetechsolutions')",
  "products": ["Product 1 with brief description", "Product 2 with brief description"],
  "clients": ["Client 1", "Client 2"],
  "technologies": ["Tech 1", "Tech 2", "Tech 3"],
  "partnerships": ["Partner 1", "Partner 2"],
  "businessModel": "Brief description of what they do",
  "mission": "Their mission statement or vision",
  "uniqueDetails": ["Unique fact 1", "Unique fact 2"],
  "industryFocus": "Industries they serve"
}

Research ${websiteUrl} now and extract these details. Return ONLY the JSON, no other text.`;

            console.log(scrapedCompanyData
                ? '🔍 Step 1: Researching company from exact scraped website content...'
                : '🔍 Step 1: Researching company with Gemini AI + Google Search...');

            const generationRequest = {
                contents: [{ role: 'user', parts: [{ text: exactSitePrompt || researchPrompt }] }]
            };

            if (!scrapedCompanyData) {
                generationRequest.tools = [{ googleSearch: {} }];
            }

            const result = await model.generateContent(generationRequest);
            const response = await result.response;
            let researchText = response.text();
            
            if (!researchText || researchText.trim() === '') {
                throw new Error('Gemini returned empty research response');
            }
            
            // Clean up the response (remove markdown code fences if present)
            researchText = researchText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
            
            // Extract JSON from response - try multiple patterns
            let jsonMatch = researchText.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                // Try finding JSON starting with { and ending with }
                const startIdx = researchText.indexOf('{');
                const endIdx = researchText.lastIndexOf('}');
                if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
                    jsonMatch = [researchText.substring(startIdx, endIdx + 1)];
                }
            }
            
            if (!jsonMatch) {
                console.log('⚠️  Could not parse research results - no JSON found');
                console.log('Response text:', researchText.substring(0, 200));
                return null;
            }
            
            try {
                const companyIntel = JSON.parse(jsonMatch[0]);

                const aiCompanyName = typeof companyIntel.companyName === 'string'
                    ? companyIntel.companyName.trim()
                    : '';
                const scrapedCompanyName = typeof scrapedCompanyData?.companyName === 'string'
                    ? scrapedCompanyData.companyName.trim()
                    : '';

                companyIntel.companyName = this.chooseBestCompanyName(
                    [aiCompanyName, scrapedCompanyName, companyName],
                    companyName,
                    companyName
                );

                if ((!Array.isArray(companyIntel.technologies) || companyIntel.technologies.length === 0) && scrapedCompanyData?.techStack?.length) {
                    companyIntel.technologies = scrapedCompanyData.techStack;
                }

                if ((!companyIntel.mission || companyIntel.mission === 'Not found') && scrapedCompanyData?.mission) {
                    companyIntel.mission = scrapedCompanyData.mission;
                }

                if ((!Array.isArray(companyIntel.uniqueDetails) || companyIntel.uniqueDetails.length === 0) && scrapedCompanyData?.uniqueInsights?.length) {
                    companyIntel.uniqueDetails = scrapedCompanyData.uniqueInsights;
                }

                if ((!companyIntel.businessModel || companyIntel.businessModel === 'Not found') && scrapedCompanyData?.about) {
                    companyIntel.businessModel = scrapedCompanyData.about.substring(0, 240);
                }

                console.log('✅ Company research complete:');
                console.log('   Products:', companyIntel.products?.length || 0);
                console.log('   Technologies:', companyIntel.technologies?.length || 0);
                console.log('   Partnerships:', companyIntel.partnerships?.length || 0);
                
                return companyIntel;
            } catch (parseError) {
                console.log('⚠️  Could not parse research JSON:', parseError.message);
                console.log('JSON string:', jsonMatch[0].substring(0, 200));
                return null;
            }

        } catch (error) {
            console.error('Company research failed:', error.message);
            return null;
        }
    }

    /**
     * Use Gemini AI to generate the complete cover letter WITH RESEARCHED COMPANY DATA
     */
    async generateCoverLetterWithAI(resumeText, websiteUrl, position, companyName, companyIntel, companyLocations = null) {
        const geminiKey = process.env.GEMINI_API_KEY;
        
        if (!geminiKey) {
            console.log('⚠️  No Gemini API key - cannot use AI generation');
            return null;
        }

        try {
            const { GoogleGenerativeAI } = require('@google/generative-ai');
            const genAI = new GoogleGenerativeAI(geminiKey);
            const model = genAI.getGenerativeModel({ 
                model: 'gemini-2.5-flash',
                generationConfig: {
                    temperature: 1,
                    topP: 0.95,
                    topK: 40,
                    maxOutputTokens: 8192,
                }
            });

            console.log('🤖 Step 2: Generating cover letter with research...');

            // Extract company location info
            let locationText = '';
            let continentText = '';
            let hasLocation = false;
            
            if (companyLocations && companyLocations.length > 0) {
                const headquarters = companyLocations.find(loc => loc.isHeadquarters) || companyLocations[0];
                const country = headquarters.country;
                const city = headquarters.city;
                
                if (country && country !== 'Not specified') {
                    hasLocation = true;
                    console.log(`📍 Company location detected: ${city}, ${country}`);
                    
                    // Determine continent and relocation text
                    const europeanCountries = ['Switzerland', 'Germany', 'Austria', 'France', 'Italy', 'Spain', 'Netherlands', 'Belgium', 'Sweden', 'Norway', 'Denmark', 'Finland', 'Poland', 'Czech Republic', 'Hungary', 'Romania', 'Bulgaria', 'Greece', 'Portugal', 'Ireland', 'Luxembourg', 'Slovakia', 'Slovenia', 'Croatia', 'Estonia', 'Latvia', 'Lithuania', 'Malta', 'Cyprus', 'United Kingdom', 'UK'];
                    const asianCountries = ['China', 'Japan', 'India', 'Singapore', 'South Korea', 'Thailand', 'Vietnam', 'Malaysia', 'Indonesia', 'Philippines', 'Taiwan', 'Hong Kong'];
                    const northAmericanCountries = ['United States', 'USA', 'US', 'Canada', 'Mexico'];
                    
                    if (europeanCountries.includes(country)) {
                        locationText = `${country}/Europe`;
                        continentText = 'Europe';
                    } else if (asianCountries.includes(country)) {
                        locationText = `${country}/Asia`;
                        continentText = 'Asia';
                    } else if (northAmericanCountries.includes(country)) {
                        locationText = country === 'United States' || country === 'USA' || country === 'US' ? 'the United States' : country;
                        continentText = 'North America';
                    } else {
                        locationText = country;
                        continentText = country;
                    }
                }
            }

            // Format the company intelligence nicely
            const productsInfo = Array.isArray(companyIntel?.products) ? companyIntel.products.join('\n   - ') : 'Not available';
            const clientsInfo = Array.isArray(companyIntel?.clients) ? companyIntel.clients.join(', ') : 'Not available';
            const techInfo = Array.isArray(companyIntel?.technologies) ? companyIntel.technologies.join(', ') : 'Not available';
            const partnersInfo = Array.isArray(companyIntel?.partnerships) ? companyIntel.partnerships.join(', ') : 'Not available';
            const businessModel = companyIntel?.businessModel || 'Technology company';
            const mission = companyIntel?.mission || '';
            const uniqueDetails = Array.isArray(companyIntel?.uniqueDetails) ? companyIntel.uniqueDetails.join('\n   - ') : '';
            const industry = companyIntel?.industryFocus || '';

            // Extract candidate insights from resume
            const yearsMatch = resumeText.match(/(\d+)\+?\s*years?\s+of\s+(experience|exp)/i);
            const yearsOfExperience = yearsMatch ? yearsMatch[1] + '+ years' : 'extensive';
            
            const hasLeadership = /team\s+lead|project\s+manager|scrum\s+master|technical\s+lead|architect|senior/i.test(resumeText);
            const hasAIExperience = /\b(AI|artificial\s+intelligence|machine\s+learning|ML|deep\s+learning|neural\s+network|NLP|computer\s+vision|GPT|LLM|generative\s+AI)\b/i.test(resumeText);
            
            // Extract all technologies from resume for bolding
            const techKeywords = resumeText.match(/\b(\.NET|C#|ASP\.NET|Azure|AWS|SQL|Python|JavaScript|React|Angular|Node\.js|Docker|Kubernetes|DevOps|CI\/CD|Agile|Scrum|SAP|REST|API|Microservices|MongoDB|Redis|Jenkins|Git|TypeScript|Java|Spring|Kafka|RabbitMQ|GraphQL|TensorFlow|PyTorch|OpenAI|GPT|LLM|Machine Learning|AI|Blockchain|Web3|Cloud|GCP|Oracle|PostgreSQL|MySQL|NoSQL|Elasticsearch|Terraform|Ansible|Linux|Windows Server|IIS|NGINX|Apache|HTML|CSS|SASS|Redux|Vue\.js|Next\.js|Express|Django|Flask|FastAPI|Ruby|Rails|PHP|Laravel|Symfony|Go|Rust|Scala|Kotlin|Swift|Objective-C|Flutter|React Native|Ionic|Xamarin|Unity|Unreal Engine|Salesforce|Dynamics|ServiceNow|Jira|Confluence|SharePoint|Power BI|Tableau|Excel|VBA)\b/gi) || [];
            const uniqueTechs = [...new Set(techKeywords.map(t => t.toUpperCase()))];

            const prompt = `You are an expert Executive Recruiter and Career Storyteller. Write a highly personalized, narrative-driven cover letter that proves deep research was done.

**TARGET COMPANY:** ${companyName} (EXACT website: ${websiteUrl})
**IMPORTANT:** This cover letter is for the company at the EXACT domain ${websiteUrl}. Do NOT confuse with any similar domain names (e.g. .ch is NOT .com, .co.uk is NOT .com). The company name "${companyName}" refers ONLY to the entity operating at ${websiteUrl}.
**POSITION:** ${position}
**COMPANY LOCATION:** ${locationText}

**CANDIDATE PROFILE:**
${resumeText}

**CANDIDATE KEY INSIGHTS (MUST INCLUDE):**
- Years of Experience: ${yearsOfExperience}
- Leadership Experience: ${hasLeadership ? 'YES - Team Lead/Project Manager roles' : 'Individual Contributor'}
- AI/ML Experience: ${hasAIExperience ? 'YES - Has AI/ML expertise' : 'No'}
- Key Technologies: ${uniqueTechs.slice(0, 15).join(', ')}

**COMPANY RESEARCH (use these specific details):**
- Products: ${productsInfo}
- Clients: ${clientsInfo}  
- Tech Stack: ${techInfo}
- Partners: ${partnersInfo}
- Business Model: ${businessModel}
- Mission: ${mission}

**INSTRUCTIONS:**

Write a 3-4 paragraph cover letter following this EXACT structure:

**CRITICAL FORMATTING:** Separate each paragraph with a double newline (blank line). Each paragraph should appear on its own with clear visual separation.
Example format:
Paragraph 1 text here...

Paragraph 2 text here...

Paragraph 3 text here...

Paragraph 4 text here...

**Paragraph 1 - The Hook with Experience:**
MUST START with years of experience and current role level. Then reference a specific product/initiative from company research.

Example: "With over ${yearsOfExperience} of experience as a ${hasLeadership ? 'Team Lead and Solutions Architect' : 'Senior Software Engineer'}, I have been following ${companyName}'s unique trajectory in the market, specifically your ability to balance [specific product/service from research]..."

**Paragraph 2 - Technical Depth:**
Connect candidate's architecture/technical skills to company's specific products or technologies. Bold ALL technology names using **double asterisks**.

Example: "Having architected and deployed enterprise applications using **ASP.NET Core** and **SQL Server**, I recognize the complexities involved in building scalable platforms like **${companyName}'s specific product**..."

**Paragraph 3 - Leadership & Strategic Value:**
${hasLeadership ? 'MUST emphasize Team Lead/Project Management experience and how it helps employer manage teams, deliver projects on time, and coordinate cross-functional efforts.' : 'Focus on technical contributions and collaboration.'}
${hasAIExperience ? 'MUST include 2-3 sentences about AI/ML expertise and how it can help employer innovate, automate processes, or enhance products with intelligent features.' : ''}
Reference specific company clients/partners from research. Bold all proper nouns.

Example: "As a Team Lead managing cross-functional Agile teams, I bring not just technical expertise but the ability to drive projects to completion. ${hasAIExperience ? 'My experience in **AI** and **Machine Learning** positions me to help ' + companyName + ' leverage intelligent automation and data-driven insights...' : ''} I see powerful synergy with your work for clients like **[specific client name]**..."

**Paragraph 4 - Closing (MANDATORY):**
Write a UNIQUE, VARIED closing paragraph (2-3 sentences) that conveys:
${hasLocation 
  ? `1. Interest in joining **${companyName}** 
2. Willingness to work in/relocate to ${locationText} (mention the location naturally)
3. Appreciation for their consideration`
  : `1. Interest in joining **${companyName}**
2. Appreciation for their consideration`
}

CRITICAL RULES FOR CLOSING:
✅ MUST write it differently each time - vary sentence structure, word choice, and phrasing
✅ Keep tone: polite, humble, professional (not arrogant or overconfident)
✅ Use varied expressions like: "opportunity to contribute", "chance to be part of", "looking forward to", "excited about", "interested in discussing"
${hasLocation ? `✅ Naturally mention ${locationText} (don't say "Not specified")` : ''}

❌ FORBIDDEN PHRASES (will be rejected):
- "I am eager to relocate to"
- "excellent fit for [company]'s environment"
- "I am keen to discuss how my expertise"
- "I am confident that"
- "proven track record"
- Any exact repetition of previous closings

IMPORTANT: Generate FRESH wording every time. Vary your sentence structures and vocabulary.

**CRITICAL FORMATTING RULES:**
**CRITICAL FORMATTING RULES:**
✅ MUST start first sentence with years of experience (${yearsOfExperience})
✅ MUST bold ALL technologies using **double asterisks** (e.g., **ASP.NET Core**, **Azure**, **SQL Server**, **Python**, **JavaScript**)
✅ MUST bold ALL company products using **double asterisks** (e.g., **Simp Realty Platform**)
✅ MUST bold ALL client names using **double asterisks** (e.g., **Capital Bank**, **BCBS**)
✅ MUST bold ALL partnerships/tools using **double asterisks** (e.g., **Delphix**, **Salesforce**)
${hasLeadership ? '✅ MUST include leadership/project management experience and how it helps deliver projects on time' : ''}
${hasAIExperience ? '✅ MUST include 2-3 sentences about AI/ML expertise and how it helps employer with automation/innovation' : ''}
✅ Use narrative paragraphs only - NO bullet points, NO lists
✅ Professional, confident, senior-level tone
✅ 300-400 words total

❌ NO generic phrases ("I am writing to express...", "proven track record", "aligns with")
❌ NO bullet points or skill lists
❌ NO preambles ("Here's the letter...")

**OUTPUT:** Return ONLY the cover letter body. No meta-commentary. Start directly with paragraph 1 stating years of experience.

---

**MANDATORY INCLUSIONS:**
1. First sentence MUST mention "${yearsOfExperience} of experience"
${hasLeadership ? '2. MUST dedicate sentences to Team Lead/Project Manager experience and delivering projects' : ''}
${hasAIExperience ? '3. MUST dedicate 2-3 sentences to AI/ML capabilities and business value for employer' : ''}
4. MUST bold EVERY technology, product, client, and partnership name
5. MUST end with exact closing about relocation to ${locationText}

---

**FORBIDDEN PHRASES (Will be rejected):**
- "I am writing to express my profound interest"
- "aligns with my career aspirations"
- "your esteemed organization"
- "I would be a valuable asset"
- "proven track record"
- "I look forward to the opportunity"

---

**VALIDATION REQUIREMENTS:**
- Every paragraph MUST reference at least one specific proper noun from the research (product name, client name, technology, or partnership)
- If research lacks details, be honest: "While specific client names aren't publicly listed, I understand you focus on [industry]..."
- Bold all specific company products, clients, and technologies using **double asterisks**

---

**CRITICAL OUTPUT INSTRUCTIONS:**
- Return ONLY the cover letter content itself
- Do NOT include any preambles like "Here's the cover letter" or "Okay, here's..." or "tailored to..."
- Do NOT include any explanations about what you're doing
- Do NOT include any meta-commentary or research notes
- Do NOT dump your research findings or search results into the output
- Do NOT include bullet points summarizing what you found about the company
- Do NOT include any non-English words or phrases (translate everything to English)
- Even if the company website is in German, French, or any other language, the cover letter MUST be 100% in PROFESSIONAL ENGLISH
- Start directly with the opening paragraph of the letter
- Write ONLY the body (no "Dear Hiring Manager" or signature)
- **NO BULLET POINTS, NO LISTS** - pure narrative paragraphs only
- **NO FOREIGN LANGUAGE WORDS** - everything must be in English
- Mention ONLY company-specific entities that exist in the provided COMPANY RESEARCH block
- If COMPANY RESEARCH fields are "Not available" or "Could not find specific...", do NOT invent product/client/partner names
- Never introduce unrelated industries or domains (e.g., cannabis/forum topics) unless explicitly present in COMPANY RESEARCH

Generate the narrative-driven cover letter now:`;

            console.log('\n========================================');
            console.log('GEMINI AI PROMPT BEING SENT:');
            console.log('========================================');
            console.log(prompt.substring(0, 800) + '...');
            console.log('========================================\n');

            console.log('🤖 Using Gemini with Google Search + deep research prompt...');
            
            // Try up to 3 times to get non-generic content
            for (let attempt = 1; attempt <= 3; attempt++) {
                console.log(`\n🔄 Attempt ${attempt}/3 to generate specific cover letter...`);
                
                const result = await model.generateContent({
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    tools: [{ googleSearch: {} }]
                });
                const response = await result.response;
                let coverLetterText = response.text();
                
                if (!coverLetterText || coverLetterText.trim() === '') {
                    console.warn(`⚠️ Attempt ${attempt}: Gemini returned empty response`);
                    if (attempt < 3) continue;
                    throw new Error('Gemini returned empty cover letter after 3 attempts');
                }
                
                // Clean up any meta commentary, thinking notes, or research dumps the AI might have added
                // Strip everything before the actual cover letter starts (first paragraph with years of experience)
                
                // 1. Remove common preambles
                coverLetterText = coverLetterText
                    .replace(/^(Okay,?\s+)?(Here's|Here is) (the|a) cover letter.*?[\n:]+/i, '')
                    .replace(/^.*?tailored to.*?[\n:]+/i, '')
                    .trim();
                
                // 2. Remove AI thinking/research notes that leak before the actual letter
                // These typically start with phrases like "The search results...", "Based on my research...", etc.
                // The actual letter should start with "With over X years..." or similar experience statement
                const thinkingPatterns = [
                    /^.*?(?:The search results?|My research|Based on (?:my |the )?research|I (?:found|discovered|confirmed)|Let me|I will proceed|One crucial detail|Here's what I found).*?\n+/gis,
                    /^.*?(?:•\s+[^\n]+\n)+/gm,  // Remove bullet point lists at the start
                ];
                
                for (const pattern of thinkingPatterns) {
                    coverLetterText = coverLetterText.replace(pattern, '').trim();
                }
                
                // 3. Find the actual letter start - should begin with "With over" or a capital letter starting a proper paragraph
                // If there's still research junk before the letter, find where the letter actually starts
                const letterStartMatch = coverLetterText.match(/(?:^|\n)(With (?:over|more than)|Having (?:spent|dedicated|accumulated)|Throughout my|Over the (?:past|last)|As a (?:seasoned|senior|experienced)|My \d+\+?\s*years?|For (?:over|more than)|Drawing (?:on|from)|Bringing (?:over|more than))/i);
                if (letterStartMatch && letterStartMatch.index > 50) {
                    // There's significant text before the actual letter start - strip it
                    console.log(`⚠️ Stripped ${letterStartMatch.index} chars of AI thinking notes before letter start`);
                    coverLetterText = coverLetterText.substring(letterStartMatch.index).trim();
                }
                
                // 4. Remove any non-English text that leaked in (German, French, etc.)
                // Replace foreign phrases in parentheses like "Personaldienstleistungen (personnel services)"
                // Keep the English translation, remove the foreign word
                coverLetterText = coverLetterText
                    .replace(/\b[A-ZÄÖÜ][a-zäöüß]+(?:dienstleistungen|umgebungen|landschaften|anwendungen|leitung|ierung|ierung|stellung|schaft)\b/g, '')  // German compound words
                    .replace(/\s*\([^)]*(?:personnel|services|host|modern|programming|migration|project|management|virtualization|environments|landscapes)[^)]*\)\s*/gi, '')  // Remove parenthetical translations
                    .replace(/[""][^""]*(?:Erfolg|suchen|finden|Fähigkeiten|gefragt)[^""]*[""]/g, '')  // Remove German quoted phrases
                    .replace(/[ \t]{2,}/g, ' ')  // Clean up repeated spaces without destroying paragraph breaks
                    .replace(/\n{3,}/g, '\n\n')  // Keep paragraph separation stable
                    .trim();
                
                // 5. Ensure the cover letter is in English - check for excessive non-English content
                const nonEnglishWords = coverLetterText.match(/\b(?:für|und|der|die|das|ist|mit|von|zur|zum|ein|eine|sich|auf|bei|nach|über|unter|durch|gegen|ohne|bis|seit)\b/gi) || [];
                if (nonEnglishWords.length > 5) {
                    console.warn(`⚠️ Attempt ${attempt}: Cover letter contains ${nonEnglishWords.length} non-English words, rejecting`);
                    if (attempt < 3) continue;
                }
                
                console.log('\n========================================');
                console.log(`GEMINI AI RESPONSE (Attempt ${attempt}):`);
                console.log('========================================');
                console.log(coverLetterText.substring(0, 500) + '...');
                console.log('========================================\n');
                
                // VALIDATE: Reject if too generic (only check for the most egregious phrases)
                const genericPhrases = [
                    'I am writing to express my profound interest',
                    'How My Experience Directly Matches Your Requirements',
                    'My Value Proposition to',
                    'I am eager to relocate to',
                    'excellent fit for',
                    'I am keen to discuss how my expertise',
                    'Not specified', // Reject if location is "Not specified"
                    'The search results confirm',
                    'The search results show',
                    'Based on my research',
                    'I will proceed with generating',
                    'Let me proceed',
                    'Here\'s what I found',
                    'One crucial detail from',
                ];
                
                const foundGeneric = genericPhrases.filter(phrase => 
                    coverLetterText.toLowerCase().includes(phrase.toLowerCase())
                );
                
                if (foundGeneric.length > 0) {
                    console.log(`⚠️ Attempt ${attempt} contained generic/forbidden phrases:`, foundGeneric);
                    if (attempt < 3) {
                        console.log('🔄 Retrying with stricter prompt...');
                        continue;
                    } else {
                        console.log('❌ All 3 attempts were generic, returning null');
                        return null; // Force fallback to simplified generation
                    }
                }
                
                console.log('✅ AI generated specific, personalized content');
                
                // Convert markdown formatting to HTML
                // Convert **bold** to <strong>bold</strong>
                coverLetterText = coverLetterText.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
                
                // Convert single * to nothing (list bullets will be handled by line breaks)
                coverLetterText = coverLetterText.replace(/^\* /gm, '• ');
                
                // Convert line breaks to <br> for HTML display
                coverLetterText = coverLetterText.replace(/\n/g, '<br>');
                
                console.log('✅ Gemini AI cover letter generated and formatted');
                return coverLetterText;
            }
            
            // If we get here, both attempts failed
            return null;

        } catch (error) {
            console.error('Gemini AI cover letter generation failed:', error.message);
            return null;
        }
    }

    /**
     * Main method: Generate cover letter (returns TEXT for existing PDF generator)
     */
    async generateCoverLetter(userData, resumePath, recipientEmail, websiteUrl, position = 'Position', companyLocations = null) {
        try {
            console.log('\n📄 === DEEP COMPANY RESEARCH COVER LETTER GENERATOR ===\n');

            // 1. Extract resume data
            console.log('📋 Analyzing resume...');
            const resumeText = await this.extractResumeText(resumePath);
            const resumeData = this.parseResumeData(resumeText);
            console.log(`✅ Found ${resumeData.skills.length} skills, ${resumeData.experience.length} experiences\n`);

            // 2. Extract company name (initial fallback from URL)
            const urlCompanyName = this.extractCompanyFromUrl(websiteUrl) || 'the Company';
            let finalCompanyName = this.isValidCompanyName(urlCompanyName) ? urlCompanyName : 'the Company';
            
            console.log(`📋 URL-extracted company name: ${urlCompanyName}`);

            // 3. TWO-STEP AI APPROACH: Research THEN Generate
            let coverLetterText = null;
            
            if (process.env.GEMINI_API_KEY) {
                // STEP 1: Research the company with AI
                console.log('🔍 Step 1: Researching company with AI...');
                const companyIntel = await this.researchCompanyWithAI(websiteUrl, finalCompanyName);
                
                // Use AI-extracted company name ONLY if it's related to the URL name
                if (companyIntel && companyIntel.companyName) {
                    finalCompanyName = this.chooseBestCompanyName(
                        [companyIntel.companyName, finalCompanyName, urlCompanyName],
                        urlCompanyName,
                        urlCompanyName
                    );
                    console.log(`✅ Using normalized company name: ${finalCompanyName}`);
                }
                
                // STEP 2: Generate cover letter using researched intelligence
                if (companyIntel) {
                    console.log('🤖 Step 2: Generating cover letter with research...');
                    coverLetterText = await this.generateCoverLetterWithAI(
                        resumeText,
                        websiteUrl,
                        position,
                        finalCompanyName,
                        companyIntel,
                        companyLocations
                    );
                }
            }
            
            // 4. If AI generation failed, try simplified AI generation without deep research
            if (!coverLetterText && process.env.GEMINI_API_KEY) {
                console.log('⚠️  Detailed AI generation failed, trying simplified approach...');
                try {
                    const simplifiedIntel = {
                        companyName: finalCompanyName,
                        products: [],
                        clients: [],
                        technologies: [],
                        partnerships: [],
                        businessModel: 'Technology company',
                        mission: '',
                        uniqueDetails: [],
                        industryFocus: ''
                    };
                    
                    coverLetterText = await this.generateCoverLetterWithAI(
                        resumeText,
                        websiteUrl,
                        position,
                        finalCompanyName,
                        simplifiedIntel,
                        companyLocations
                    );
                } catch (error) {
                    console.error('❌ Simplified AI generation also failed:', error.message);
                }
            }
            
            // 5. Last resort: Use template fallback (but this should rarely happen)
            if (!coverLetterText) {
                console.log('⚠️  All AI attempts failed, using basic template...');
                // Create minimal companyData for template generation
                const companyData = {
                    companyName: finalCompanyName,
                    about: {},
                    contact: {},
                    careers: { matchingPositions: [], count: 0 },
                    uniqueInsights: []
                };
                const result = this.generateCoverLetterContent(userData, resumeData, companyData, position);
                coverLetterText = result.coverLetterText;
            }
            
            console.log(`✅ Cover letter generated for ${finalCompanyName}\n`);

            return {
                success: true,
                companyName: finalCompanyName,
                coverLetter: coverLetterText, // TEXT format for createCoverLetterPDF()
                metadata: {
                    techMatches: resumeData.skills || [],
                    cultureMatches: [],
                    matchingJobs: [],
                    hrEmail: null,
                    aboutPageFound: false,
                    careersPageFound: false,
                    uniqueInsightsFound: false
                }
            };

        } catch (error) {
            console.error('❌ Error generating cover letter:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }
}

module.exports = TemplateCoverLetterGenerator;
