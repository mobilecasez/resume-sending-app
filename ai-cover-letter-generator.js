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
     * Scrape company website to understand their business (with multi-language support and deeper analysis)
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

            // Extract comprehensive information
            const title = $('title').text().trim();
            const metaDescription = $('meta[name="description"]').attr('content') || '';
            const metaKeywords = $('meta[name="keywords"]').attr('content') || '';
            
            // Get all headings for better context
            const h1s = $('h1').map((i, el) => $(el).text().trim()).get().slice(0, 5);
            const h2s = $('h2').map((i, el) => $(el).text().trim()).get().slice(0, 8);
            const h3s = $('h3').map((i, el) => $(el).text().trim()).get().slice(0, 6);
            
            // Get substantial paragraphs
            const paragraphs = $('p').map((i, el) => $(el).text().trim()).get()
                .filter(p => p.length > 30 && p.length < 500)
                .slice(0, 10);
            
            // Look for About/Services sections
            const aboutSection = $('section[class*="about"], div[class*="about"], section[id*="about"]')
                .find('p').map((i, el) => $(el).text().trim()).get()
                .filter(p => p.length > 40)
                .slice(0, 3);
            
            const servicesSection = $('section[class*="service"], div[class*="service"], section[id*="service"]')
                .find('p, li').map((i, el) => $(el).text().trim()).get()
                .filter(p => p.length > 20)
                .slice(0, 5);
            
            // Extract list items that might contain key info
            const listItems = $('ul li, ol li').map((i, el) => $(el).text().trim()).get()
                .filter(li => li.length > 15 && li.length < 200)
                .slice(0, 8);

            console.log('🔍 Analyzing content language and extracting detailed information...');

            // Translate all content to English
            const translatedTitle = await this.detectAndTranslate(title);
            const translatedDescription = await this.detectAndTranslate(metaDescription);
            
            const translatedH1s = [];
            for (const h1 of h1s) {
                const translated = await this.detectAndTranslate(h1);
                translatedH1s.push(translated);
            }
            
            const translatedH2s = [];
            for (const h2 of h2s) {
                const translated = await this.detectAndTranslate(h2);
                translatedH2s.push(translated);
            }

            const translatedParagraphs = [];
            for (const para of paragraphs) {
                const translated = await this.detectAndTranslate(para);
                translatedParagraphs.push(translated);
            }
            
            const translatedAbout = [];
            for (const para of aboutSection) {
                const translated = await this.detectAndTranslate(para);
                translatedAbout.push(translated);
            }
            
            const translatedServices = [];
            for (const service of servicesSection) {
                const translated = await this.detectAndTranslate(service);
                translatedServices.push(translated);
            }

            console.log('✅ Website content translated and analyzed');

            // Combine all content intelligently
            const allHeadings = [...translatedH1s, ...translatedH2s].filter(h => h && h.length > 3);
            const mainContent = [
                translatedDescription,
                ...translatedAbout,
                ...translatedParagraphs,
                ...translatedServices
            ].filter(c => c && c.length > 30).join(' ');

            return {
                title: translatedTitle,
                description: translatedDescription,
                keywords: metaKeywords,
                headings: allHeadings,
                content: mainContent.substring(0, 2000), // Increased from 1000 to 2000 for deeper context
                services: translatedServices.join(', '),
                aboutInfo: translatedAbout.join(' '),
                keyPoints: listItems.slice(0, 5),
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

        // Enhanced prompt with deeper analysis requirements
        const prompt = `You are writing a highly personalized, value-driven cover letter for a job application. This should NOT be generic - analyze the company deeply and show exactly how the candidate will add value.

CANDIDATE INFORMATION:
Name: ${userData.fullName}
Location: ${userData.city ? `${userData.city}, ${userData.country}` : userData.country || ''}
Phone: ${userData.phoneNumber || 'N/A'}
Email: ${userData.email}

RESUME SUMMARY:
${resumeData.summary || 'Experienced professional with diverse skill set'}

KEY SKILLS & EXPERTISE:
${resumeData.skills.slice(0, 15).join(', ')}

WORK EXPERIENCE & ACHIEVEMENTS:
${resumeData.experience.slice(0, 4).map(exp => `- ${exp.title} at ${exp.company}`).join('\n')}

EMPLOYER DEEP ANALYSIS:
Company Name: ${companyName}
Website: ${recipientWebsite || recipientEmail}
Company Description: ${companyInfo?.description || 'Not available'}
Main Focus Areas: ${companyInfo?.headings?.join(', ') || 'Not available'}
Detailed Business Context: ${companyInfo?.content || 'Limited information available - focus on what you can infer from the domain/name'}

YOUR TASK - CRITICAL REQUIREMENTS:
1. DEEP ANALYSIS: Study the company's description and content carefully. Identify:
   - What specific problems they solve
   - Their key products/services/projects
   - Their target market or industry focus
   - Technologies or methodologies they likely use
   - Their mission, values, or unique approach

2. MATCH SKILLS TO NEEDS: For each relevant skill the candidate has, explain:
   - How it directly addresses the company's specific needs
   - A concrete example of how you'd apply it to their work
   - The measurable value/impact you'd bring

3. SHOW SPECIFIC VALUE: Include 2-3 specific examples like:
   - "I noticed ${companyName} focuses on [specific area from their website]. In my previous role, I [specific relevant achievement] which resulted in [measurable outcome]. I'd apply this same approach to help ${companyName} [specific benefit]."
   - Reference their actual projects, products, or services if mentioned
   - Connect your experience to their specific challenges

4. DEMONSTRATE RESEARCH: Show you've done homework:
   - Mention something specific from their website (project, value, technology, approach)
   - Show understanding of their industry/market
   - Reference how their work aligns with your professional interests

5. BE AUTHENTIC & CONVERSATIONAL:
   - Write like a real person, not a robot
   - Show genuine enthusiasm for THEIR specific work
   - Use natural language, avoid corporate buzzwords
   - Keep paragraphs short and punchy

6. STRUCTURE (250-350 words):
   - Opening: Hook with specific insight about their company
   - Body: 2-3 concrete examples of how you'll add value to THEIR specific work
   - Closing: Clear call to action with enthusiasm

7. NEVER:
   - Use generic phrases like "I am writing to apply"
   - Say vague things like "I am a hard worker"
   - Write anything that could apply to any company
   - Sound like a template or AI wrote it

Write ONLY the body of the cover letter (no "Dear Hiring Manager" or signature). Start with a compelling opening that shows you understand THEIR specific business.`;

        try {
            const response = await axios.post(
                'https://api.openai.com/v1/chat/completions',
                {
                    model: 'gpt-4',
                    messages: [
                        {
                            role: 'system',
                            content: 'You are an expert career strategist who writes highly personalized, value-driven cover letters. You deeply analyze each employer to create letters that demonstrate genuine understanding of their business and show concrete examples of how the candidate will contribute. You NEVER write generic content - every sentence is specific to the employer and candidate match. You write in an authentic, conversational tone that sounds like a real person who has done their research.'
                        },
                        {
                            role: 'user',
                            content: prompt
                        }
                    ],
                    temperature: 0.85,
                    max_tokens: 1000
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
     * Generate cover letter using templates (fallback when no AI) - Enhanced with better personalization
     */
    generateWithTemplate(userData, resumeData, companyInfo, recipientEmail, recipientWebsite) {
        const companyName = this.extractBestCompanyName(companyInfo, recipientEmail, recipientWebsite);

        // Analyze company info to extract specific details
        const companyFocus = companyInfo?.headings?.[0] || companyInfo?.description?.substring(0, 80) || 'innovative solutions';
        const companyServices = companyInfo?.services || 'your products and services';
        const specificDetail = companyInfo?.content?.substring(0, 150) || `the work ${companyName} is doing`;

        // Select varied opening that references specific company info
        const openings = [
            `I was excited to discover ${companyName} and learn about ${specificDetail}. My background in ${resumeData.skills[0] || 'technology'} positions me to contribute immediately to your mission.`,
            `After researching ${companyName}'s focus on ${companyFocus}, I'm convinced my experience aligns perfectly with your needs. ${resumeData.experience[0]?.title ? 'As a ' + resumeData.experience[0].title + ', I\'ve' : 'I\'ve'} developed expertise that would directly benefit your team.`,
            `${companyName}'s work in ${companyFocus} resonates strongly with my professional experience and interests. I'm reaching out because I believe I can add significant value to your initiatives.`,
            `What drew me to ${companyName} is ${specificDetail}. This aligns perfectly with my experience in ${resumeData.skills.slice(0, 2).join(' and ')}, and I'm eager to contribute.`
        ];

        const opening = openings[Math.floor(Math.random() * openings.length)];

        // Build detailed experience paragraph with specific value proposition
        let experiencePara = '';
        if (resumeData.experience.length > 0) {
            const exp = resumeData.experience[0];
            experiencePara = `In my role as ${exp.title} at ${exp.company}, I developed deep expertise in ${resumeData.skills.slice(0, 3).join(', ')}. `;
        } else {
            experiencePara = `My professional background includes significant experience with ${resumeData.skills.slice(0, 3).join(', ')}. `;
        }
        
        // Add specific value connection
        if (companyInfo?.content && companyInfo.content.length > 100) {
            experiencePara += `I see clear parallels between ${companyName}'s focus and my expertise—particularly in how I could apply my skills to ${companyServices}.`;
        } else {
            experiencePara += `I'm particularly excited about applying these skills to help ${companyName} achieve its objectives.`;
        }

        // Enhanced value proposition with concrete examples
        const skills = resumeData.skills.slice(0, 4);
        const value = `What I bring to ${companyName}:\n\n` +
            `• ${skills[0] || 'Technical expertise'}: I've used this to solve complex challenges and could apply it directly to ${companyFocus}.\n` +
            `• ${skills[1] || 'Problem-solving ability'}: Essential for navigating the type of work ${companyName} does.\n` +
            `• ${skills[2] || 'Collaborative approach'}: I thrive in team environments and enjoy contributing to shared goals.` +
            (skills[3] ? `\n• ${skills[3]}: Another key strength that aligns with your needs.` : '');

        // Specific, action-oriented closing
        const closings = [
            `I'd welcome the opportunity to discuss specific ways I can contribute to ${companyName}'s success. I'm available for a conversation at your convenience and excited about the possibility of joining your team.`,
            `I'm genuinely excited about the potential to contribute to ${companyName}. I'd love to explore how my background aligns with your current needs. Let's schedule a time to discuss.`,
            `I believe I could make an immediate impact at ${companyName}. I'd appreciate the chance to discuss how my experience maps to your goals. I'm happy to provide additional examples of my work.`
        ];
        
        const closing = closings[Math.floor(Math.random() * closings.length)];

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
