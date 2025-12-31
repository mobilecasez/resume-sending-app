const axios = require('axios');
const cheerio = require('cheerio');
const pdf = require('pdf-parse');
const fs = require('fs').promises;
const path = require('path');
const translate = require('@vitalets/google-translate-api').translate;

/**
 * AI-Powered Cover Letter Generator
 * Analyzes resume, scrapes company website, and generates personalized cover letters
 */

class AICoverLetterGenerator {
    constructor() {
        // Will use OpenAI API if key is provided, otherwise uses template-based generation
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
     * Extract text content from PDF resume
     */
    async extractResumeText(resumePath) {
        try {
            const dataBuffer = await fs.readFile(resumePath);
            const data = await pdf(dataBuffer);
            return data.text;
        } catch (error) {
            console.error('Error extracting resume text:', error);
            return null;
        }
    }

    /**
     * Parse resume to extract key information
     */
    parseResumeData(resumeText) {
        const data = {
            skills: [],
            experience: [],
            education: [],
            summary: ''
        };

        if (!resumeText) return data;

        // Extract skills (look for common skill section headers)
        const skillsMatch = resumeText.match(/(?:Skills|Technical Skills|Core Competencies)[:\s]+([\s\S]*?)(?:\n\n|\n[A-Z])/i);
        if (skillsMatch) {
            data.skills = skillsMatch[1]
                .split(/[,•\n]/)
                .map(s => s.trim())
                .filter(s => s.length > 2 && s.length < 50);
        }

        // Extract experience (look for job titles and companies)
        const experienceMatches = resumeText.matchAll(/(?:^|\n)([A-Z][^•\n]{10,60})\s*(?:at|@|\|)\s*([A-Z][^•\n]{3,40})\s*(?:\n|•)/gm);
        for (const match of experienceMatches) {
            data.experience.push({
                title: match[1].trim(),
                company: match[2].trim()
            });
        }

        // Extract summary (usually first paragraph after name)
        const summaryMatch = resumeText.match(/\n([A-Z][^•\n]{50,300}\.)/);
        if (summaryMatch) {
            data.summary = summaryMatch[1].trim();
        }

        return data;
    }

    /**
     * Detect if text is in English or another language and translate if needed
     */
    async detectAndTranslate(text) {
        if (!text || text.trim().length === 0) return text;

        try {
            // Detect language and translate to English
            const result = await translate(text, { to: 'en' });
            
            if (result.from.language.iso !== 'en') {
                console.log(`🌍 Detected ${result.from.language.iso.toUpperCase()} - Translating to English`);
                return result.text;
            }
            
            return text;
        } catch (error) {
            console.warn('Translation warning:', error.message);
            return text; // Fallback to original text
        }
    }

    /**
     * Scrape company website to understand their business (with multi-language support)
     */
    async scrapeCompanyWebsite(websiteUrl) {
        try {
            // Add protocol if missing
            if (!websiteUrl.startsWith('http')) {
                websiteUrl = 'https://' + websiteUrl;
            }

            console.log(`🌐 Fetching website: ${websiteUrl}`);

            const response = await axios.get(websiteUrl, {
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            const $ = cheerio.load(response.data);

            // Remove scripts and styles
            $('script, style, nav, footer').remove();

            // Extract key information
            const title = $('title').text().trim();
            const metaDescription = $('meta[name="description"]').attr('content') || '';
            const h1s = $('h1').map((i, el) => $(el).text().trim()).get().slice(0, 3);
            const paragraphs = $('p').map((i, el) => $(el).text().trim()).get()
                .filter(p => p.length > 30 && p.length < 300)
                .slice(0, 5);

            console.log('🔍 Analyzing content language...');

            // Translate all content to English
            const translatedTitle = await this.detectAndTranslate(title);
            const translatedDescription = await this.detectAndTranslate(metaDescription);
            
            const translatedH1s = [];
            for (const h1 of h1s) {
                const translated = await this.detectAndTranslate(h1);
                translatedH1s.push(translated);
            }

            const translatedParagraphs = [];
            for (const para of paragraphs) {
                const translated = await this.detectAndTranslate(para);
                translatedParagraphs.push(translated);
            }

            console.log('✅ Website content translated to English');

            return {
                title: translatedTitle,
                description: translatedDescription,
                headings: translatedH1s,
                content: translatedParagraphs.join(' ').substring(0, 1000),
                domain: new URL(websiteUrl).hostname
            };
        } catch (error) {
            console.error('Error scraping website:', error.message);
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
        if (/^\d+$/.test(cleaned)) return false;
        return true;
    }
    
    /**
     * Extract company name from URL with smart parsing
     */
    extractCompanyFromUrl(url) {
        try {
            const urlObj = new URL(url.startsWith('http') ? url : `https://${url}`);
            let hostname = urlObj.hostname.replace('www.', '').toLowerCase();
            let name = hostname.split('.')[0];
            
            // Common job portal patterns
            const jobPatterns = [
                /^jobsat(.+)$/i,
                /^workat(.+)$/i,
                /^careerat(.+)$/i,
                /^careersat(.+)$/i,
                /^join(.+)$/i,
                /^(.+)careers$/i,
                /^(.+)jobs$/i,
                /^(.+)career$/i,
                /^(.+)hiring$/i,
            ];
            
            for (const pattern of jobPatterns) {
                const match = name.match(pattern);
                if (match && match[1] && match[1].length >= 2) {
                    name = match[1];
                    break;
                }
            }
            
            const formattedName = name.charAt(0).toUpperCase() + name.slice(1);
            return this.isValidCompanyName(formattedName) ? formattedName : null;
        } catch {
            return null;
        }
    }

    /**
     * Extract company name from email domain
     */
    extractCompanyFromEmail(email) {
        const domain = email.split('@')[1];
        if (!domain) return null;

        // Ignore common email providers
        const commonProviders = ['gmail', 'yahoo', 'outlook', 'hotmail', 'icloud', 'protonmail', 'aol'];
        const domainName = domain.split('.')[0].toLowerCase();
        if (commonProviders.includes(domainName)) return null;

        // Remove common TLDs and subdomains
        const name = domain
            .replace(/\.(com|org|net|io|co|in|uk|au|de|fr|ca)$/i, '')
            .replace(/^(www|mail|info|jobs|careers)\./i, '')
            .split('.')
            .map(part => part.charAt(0).toUpperCase() + part.slice(1))
            .join(' ');

        return this.isValidCompanyName(name) ? name : null;
    }

    /**
     * Get the best company name from multiple sources
     */
    extractBestCompanyName(companyInfo, recipientEmail, recipientWebsite) {
        const candidates = [];
        
        // 1. Try from company info title (split by separators)
        if (companyInfo?.title) {
            const titleParts = companyInfo.title.split(/\s*[\|\-–—:>]\s*/);
            for (const part of titleParts) {
                const cleaned = part.trim();
                if (this.isValidCompanyName(cleaned)) {
                    candidates.push(cleaned);
                }
            }
        }
        
        // 2. Try from URL
        if (recipientWebsite) {
            const urlName = this.extractCompanyFromUrl(recipientWebsite);
            if (urlName) candidates.push(urlName);
        }
        
        // 3. Try from email
        if (recipientEmail) {
            const emailName = this.extractCompanyFromEmail(recipientEmail);
            if (emailName) candidates.push(emailName);
        }
        
        // Return first valid candidate or fallback
        return candidates[0] || 'the Company';
    }

    /**
     * Generate cover letter using AI (OpenAI GPT)
     */
    async generateWithAI(userData, resumeData, companyInfo, recipientEmail, recipientWebsite) {
        if (!this.openaiApiKey) {
            throw new Error('OpenAI API key not configured');
        }

        const companyName = this.extractBestCompanyName(companyInfo, recipientEmail, recipientWebsite);

        const prompt = `Write a professional, human-sounding cover letter for a job application. 

CANDIDATE INFORMATION:
Name: ${userData.fullName}
Location: ${userData.city ? `${userData.city}, ${userData.country}` : userData.country || ''}
Phone: ${userData.phoneNumber || 'N/A'}
Email: ${userData.email}

RESUME SUMMARY:
${resumeData.summary || 'Experienced professional with diverse skill set'}

KEY SKILLS:
${resumeData.skills.slice(0, 10).join(', ')}

WORK EXPERIENCE:
${resumeData.experience.slice(0, 3).map(exp => `- ${exp.title} at ${exp.company}`).join('\n')}

COMPANY INFORMATION:
Company Name: ${companyName}
Website: ${recipientWebsite || recipientEmail}
About: ${companyInfo?.description || companyInfo?.content?.substring(0, 200) || 'A leading company in their field'}

REQUIREMENTS:
1. Write in a natural, conversational tone - NOT robotic or AI-like
2. Show genuine enthusiasm and personality
3. Match candidate's skills with company's needs based on their website
4. Keep it concise (250-350 words)
5. Use specific examples when possible
6. Don't use overly formal or corporate jargon
7. Sound like a real person wrote it, with natural flow
8. Include a strong opening that grabs attention
9. End with a clear call to action

Write ONLY the body of the cover letter (no "Dear Hiring Manager" or signature). Start directly with an engaging opening paragraph.`;

        try {
            const response = await axios.post(
                'https://api.openai.com/v1/chat/completions',
                {
                    model: 'gpt-4',
                    messages: [
                        {
                            role: 'system',
                            content: 'You are an expert cover letter writer who creates authentic, human-sounding application letters that help candidates stand out. You write in a natural, conversational style that sounds genuine and personal, never robotic or templated.'
                        },
                        {
                            role: 'user',
                            content: prompt
                        }
                    ],
                    temperature: 0.8,
                    max_tokens: 800
                },
                {
                    headers: {
                        'Authorization': `Bearer ${this.openaiApiKey}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            return response.data.choices[0].message.content.trim();
        } catch (error) {
            console.error('OpenAI API error:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Generate cover letter using templates (fallback when no AI)
     */
    generateWithTemplate(userData, resumeData, companyInfo, recipientEmail, recipientWebsite) {
        const companyName = this.extractBestCompanyName(companyInfo, recipientEmail, recipientWebsite);

        // Select a random opening to add variety
        const openings = [
            `I'm reaching out because I believe my background in ${resumeData.skills[0] || 'technology'} aligns perfectly with what ${companyName} is building.`,
            `When I came across ${companyName}, I was immediately drawn to ${companyInfo?.description?.substring(0, 100) || 'your innovative approach'}. My experience in ${resumeData.skills[0] || 'the field'} has prepared me to contribute meaningfully to your team.`,
            `I've been following ${companyName}'s work, and I'm excited about the possibility of bringing my ${resumeData.experience[0]?.title || 'expertise'} background to your team.`,
            `After learning about ${companyName} and ${companyInfo?.description?.substring(0, 80) || 'your mission'}, I knew I had to reach out. My experience aligns closely with what you're looking for.`
        ];

        const opening = openings[Math.floor(Math.random() * openings.length)];

        // Build experience paragraph
        let experiencePara = '';
        if (resumeData.experience.length > 0) {
            const exp = resumeData.experience[0];
            experiencePara = `In my recent role as ${exp.title} at ${exp.company}, I've honed skills that would translate directly to your needs. `;
        }
        experiencePara += `I specialize in ${resumeData.skills.slice(0, 3).join(', ')}, and I'm passionate about using these skills to solve real problems.`;

        // Value proposition
        const value = companyInfo?.content 
            ? `What excites me most about ${companyName} is how you're ${companyInfo.content.substring(0, 100)}. I'd love to contribute to this mission by bringing my technical expertise and collaborative approach.`
            : `I'm particularly drawn to ${companyName}'s approach and believe I can contribute immediately with my background in ${resumeData.skills[0] || 'the industry'}.`;

        // Closing
        const closing = `I'd welcome the chance to discuss how my experience can help ${companyName} achieve its goals. I'm available for a conversation at your convenience.`;

        return `${opening}\n\n${experiencePara}\n\n${value}\n\n${closing}`;
    }

    /**
     * Main method to generate cover letter
     */
    async generateCoverLetter(userData, resumePath, recipientEmail, recipientWebsite) {
        try {
            console.log('\n🤖 Starting AI cover letter generation...');
            console.log(`📄 Analyzing resume: ${resumePath}`);
            
            // Extract and parse resume
            const resumeText = await this.extractResumeText(resumePath);
            const resumeData = this.parseResumeData(resumeText);
            
            console.log(`✅ Found ${resumeData.skills.length} skills, ${resumeData.experience.length} experiences`);

            // Scrape company website
            let companyInfo = null;
            if (recipientWebsite) {
                console.log(`🌐 Analyzing company website: ${recipientWebsite}`);
                companyInfo = await this.scrapeCompanyWebsite(recipientWebsite);
                if (companyInfo) {
                    console.log(`✅ Extracted company info: ${companyInfo.title}`);
                }
            }

            // Generate cover letter (try AI first, fallback to template)
            let coverLetterText;
            if (this.openaiApiKey) {
                console.log('🤖 Generating with OpenAI GPT...');
                try {
                    coverLetterText = await this.generateWithAI(userData, resumeData, companyInfo, recipientEmail, recipientWebsite);
                    console.log('✅ AI generation successful');
                } catch (error) {
                    console.log('⚠️  AI generation failed, using template');
                    coverLetterText = this.generateWithTemplate(userData, resumeData, companyInfo, recipientEmail, recipientWebsite);
                }
            } else {
                console.log('📝 Generating with smart template...');
                coverLetterText = this.generateWithTemplate(userData, resumeData, companyInfo, recipientEmail, recipientWebsite);
                console.log('✅ Template generation successful');
            }

            return {
                success: true,
                coverLetter: coverLetterText,
                companyName: companyInfo?.title?.split(/[-|]/)[0].trim() || this.extractCompanyFromEmail(recipientEmail),
                metadata: {
                    skillsFound: resumeData.skills.length,
                    experienceCount: resumeData.experience.length,
                    companyWebsiteScraped: !!companyInfo,
                    generationMethod: this.openaiApiKey ? 'ai' : 'template'
                }
            };

        } catch (error) {
            console.error('❌ Cover letter generation error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }
}

module.exports = AICoverLetterGenerator;
