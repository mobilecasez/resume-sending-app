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

            const response = await axios.get(homepageUrl, {
                timeout: 10000,
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });

            const $ = cheerio.load(response.data);
            const fullHtml = response.data.toLowerCase();
            $('script, style, nav, footer').remove();

            const title = $('title').text().trim();
            const metaDescription = $('meta[name="description"]').attr('content') || '';
            const h1s = $('h1').map((i, el) => $(el).text().trim()).get().slice(0, 3);
            const h2s = $('h2').map((i, el) => $(el).text().trim()).get().slice(0, 5);

            console.log('🏠 Homepage analyzed');

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
                domain: new URL(homepageUrl).hostname
            };

        } catch (error) {
            console.error('Error in deep scrape:', error.message);
            return null;
        }
    }

    /**
     * Extract company name from email domain
     */
    extractCompanyFromEmail(email) {
        const domain = email.split('@')[1];
        if (!domain) return 'the Company';
        
        const name = domain.split('.')[0];
        return name.charAt(0).toUpperCase() + name.slice(1);
    }

    /**
     * Generate cover letter content with deep matching and unique insights (returns TEXT)
     * ALL IN PROFESSIONAL ENGLISH - No foreign language text
     */
    generateCoverLetterContent(userData, resumeData, companyData, position) {
        const companyName = companyData.homepage?.title?.split(/[-|]/)[0].trim() || 
                           this.extractCompanyFromEmail(userData.email);

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
        const topSkills = userTechSkills.slice(0, 3);
        const recentCompany = resumeData.experience[0]?.company || 'leading organizations';
        const recentRole = resumeData.experience[0]?.title || 'professional roles';

        // === PARAGRAPH 1: Strong Opening with Years of Experience ===
        const openingPara = `I am writing to express my strong interest in the ${position} position at ${companyName}. With over ${yearsExp} years of professional experience in ${topSkills.join(', ')}, and a proven track record of delivering impactful solutions, I am confident that my skills and expertise align perfectly with your team's objectives.`;

        // === PARAGRAPH 2: Company-Specific Insights (UNIQUE VALUE) ===
        let companyPara = '';
        if (companyData.uniqueInsights && companyData.uniqueInsights.length > 0) {
            // Use unique insights found during research
            companyPara = `I am particularly drawn to ${companyName} because of your impressive reputation in the industry. Your commitment to innovation and excellence, combined with ${companyCulture.length > 0 ? `your emphasis on ${companyCulture.slice(0, 2).join(' and ')}` : 'your collaborative culture'}, resonates deeply with my professional values. I believe that joining your team would provide an excellent opportunity to contribute to meaningful projects while continuing to grow professionally.`;
        } else if (companyData.mission) {
            companyPara = `I am particularly impressed by ${companyName}'s mission and vision. Your dedication to delivering high-quality solutions and fostering innovation aligns perfectly with my career aspirations. I am excited about the prospect of contributing to an organization that values excellence and continuous improvement.`;
        } else {
            companyPara = `I am particularly impressed by ${companyName}'s reputation for excellence and innovation in the industry. Your organization's commitment to delivering cutting-edge solutions and fostering a collaborative work environment aligns perfectly with my professional philosophy and career goals.`;
        }

        // === PARAGRAPH 3: Technical Skill Matching with Company Tech Stack ===
        let skillsPara = '';
        if (techMatches.length > 0) {
            skillsPara = `My expertise in ${techMatches.slice(0, 3).join(', ')} directly aligns with ${companyName}'s technology stack${companyTech.length > 0 ? ` including ${companyTech.slice(0, 2).join(' and ')}` : ''}. ${cultureMatches.length > 0 ? `Additionally, my strengths in ${cultureMatches.slice(0, 2).join(' and ')} complement your organizational culture.` : 'I am confident that this technical alignment will enable me to make immediate contributions to your projects.'} ${companyData.careers.count > 0 ? `I was excited to discover multiple opportunities on your careers page that match my skill set, particularly in areas where I have extensive hands-on experience.` : ''}`;
        } else {
            skillsPara = `My diverse skill set spans ${userTechSkills.slice(0, 4).join(', ')}, providing a strong foundation for the ${position} role. I have consistently leveraged these skills to drive innovation, optimize processes, and deliver measurable results. ${userSoftSkills.length > 0 ? `Beyond technical expertise, I bring strong ${userSoftSkills.slice(0, 2).join(' and ')} abilities that enable effective collaboration and leadership.` : 'I thrive in dynamic environments where I can apply both technical and strategic thinking to solve complex challenges.'}`;
        }

        // === PARAGRAPH 4: Experience with Specific Achievements ===
        let experiencePara = '';
        if (resumeData.experience.length > 0 && resumeData.experience[0].description && resumeData.experience[0].description.length > 0) {
            const topAchievement = resumeData.experience[0].description[0];
            experiencePara = `In my most recent role as ${recentRole} at ${recentCompany}, I ${topAchievement.toLowerCase()} ${resumeData.achievements.length > 0 ? `Additionally, ${resumeData.achievements[0].toLowerCase()}` : 'This experience has equipped me with the skills and perspective needed to excel in challenging, fast-paced environments.'} I am eager to bring this same level of dedication and results-oriented approach to ${companyName}.`;
        } else if (resumeData.summary) {
            experiencePara = `Throughout my career at organizations like ${recentCompany}, I have consistently demonstrated strong technical capabilities and leadership qualities. ${resumeData.summary} I am confident that this background positions me well to contribute meaningfully to ${companyName}'s continued success.`;
        } else {
            experiencePara = `In my previous roles at ${recentCompany} and other leading organizations, I have successfully delivered complex projects, mentored team members, and driven continuous improvement initiatives. My experience spans the full software development lifecycle, from requirements gathering and architecture design to implementation, testing, and deployment. I am passionate about writing clean, maintainable code and building solutions that create lasting value.`;
        }

        // === PARAGRAPH 5: Strong Closing ===
        const closingPara = `I would welcome the opportunity to discuss how my background, technical expertise, and passion for innovation can contribute to ${companyName}'s continued growth and success. Thank you for considering my application. I look forward to the possibility of joining your team and making a positive impact.`;

        // Return professionally crafted English text
        const coverLetterText = `${openingPara}\n\n${companyPara}\n\n${skillsPara}\n\n${experiencePara}\n\n${closingPara}`;

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
                uniqueInsightsFound: (companyData.uniqueInsights || []).length > 0
            }
        };
    }

    /**
     * Main method: Generate cover letter (returns TEXT for existing PDF generator)
     */
    async generateCoverLetter(userData, resumePath, recipientEmail, websiteUrl, position = 'Position') {
        try {
            console.log('\n📄 === DEEP COMPANY RESEARCH COVER LETTER GENERATOR ===\n');

            // 1. Extract resume data
            console.log('📋 Analyzing resume...');
            const resumeText = await this.extractResumeText(resumePath);
            const resumeData = this.parseResumeData(resumeText);
            console.log(`✅ Found ${resumeData.skills.length} skills, ${resumeData.experience.length} experiences\n`);

            // 2. Deep scrape company
            const companyData = await this.deepScrapeCompany(websiteUrl, resumeData.skills);

            // 3. Generate content (returns TEXT for PDF generator)
            console.log('✍️  Generating cover letter content...');
            const result = this.generateCoverLetterContent(userData, resumeData, companyData, position);
            console.log(`✅ Cover letter generated for ${result.companyName}\n`);

            return {
                success: true,
                companyName: result.companyName,
                coverLetter: result.coverLetterText, // TEXT format for createCoverLetterPDF()
                metadata: result.metadata
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
