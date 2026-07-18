const dbConfig = require('../../db-config');
const path = require('path');
const fs = require('fs').promises;
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { generateCoverLetter: generateCoverLetterV2 } = require('../../ai-cover-letter-v2');
const { researchEmployer } = require('../../ai-employer-researcher');
const { notifyCoverLetterGenerated, notifyError } = require('./notificationsController');
const jobService = require('../services/jobService');
const { generateCoverLetterPDF: generateRichCoverLetterPDF } = require('./emailController');
const clTemplates = require('../utils/coverLetterTemplates');
const clRenderer  = require('../utils/coverLetterRenderer');
const { getEventCost } = require('../services/eventCosts');
const { emit } = require('../services/track');   // first-party analytics

const CL_DOWNLOAD_CREDIT_COST = 2; // fallback; live cost via getEventCost('cover_letter_download')

// Helper function: Check user credits
async function checkUserCredits(userId, creditsRequired = 1) {
    try {
        // Get user's credit info
        const credits = await dbConfig.get(
            'SELECT credits_remaining, expiry_date FROM user_credits WHERE user_id = ?',
            [userId]
        );

        if (!credits) {
            return {
                hasCredits: false,
                remaining: 0,
                message: 'No credit account found. Please purchase credits.'
            };
        }

        const now = new Date();
        const expiryDate = credits.expiry_date ? new Date(credits.expiry_date) : null;
        const isExpired = expiryDate && expiryDate < now;

        if (isExpired) {
            return {
                hasCredits: false,
                remaining: 0,
                message: 'Your credits have expired. Please purchase new credits.'
            };
        }

        const remaining = credits.credits_remaining || 0;

        if (remaining < creditsRequired) {
            return {
                hasCredits: false,
                remaining: remaining,
                message: `Insufficient credits. You have ${remaining} credit(s) but need ${creditsRequired}.`
            };
        }

        return {
            hasCredits: true,
            remaining: remaining
        };
    } catch (error) {
        console.error('Error checking credits:', error);
        throw error;
    }
}

// Helper function: Deduct credits
async function deductCredits(userId, creditsToDeduct = 1, actionType = 'cover_letter_generation', metadata = {}) {
    try {
        // Get current credit balance
        const userCredits = await dbConfig.get(
            'SELECT credits_remaining FROM user_credits WHERE user_id = ?',
            [userId]
        );

        if (!userCredits || userCredits.credits_remaining < creditsToDeduct) {
            throw new Error('Insufficient credits');
        }

        const newBalance = userCredits.credits_remaining - creditsToDeduct;

        // Update user_credits table
        await dbConfig.run(
            'UPDATE user_credits SET credits_remaining = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?',
            [newBalance, userId]
        );

        // Record in credit_usage_history
        await dbConfig.run(
            `INSERT INTO credit_usage_history 
            (user_id, credits_used, action_type, company_name, position, recipient_email, created_at)
            VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            [
                userId,
                creditsToDeduct,
                actionType,
                metadata.companyName || null,
                metadata.position || null,
                metadata.recipientEmail || null
            ]
        );

        console.log(`✅ Deducted ${creditsToDeduct} credit(s). New balance: ${newBalance}`);
        
        return {
            success: true,
            newBalance: newBalance,
            creditsDeducted: creditsToDeduct
        };
    } catch (error) {
        console.error('Error deducting credits:', error);
        throw error;
    }
}

// Helper function: Format cover letter with HTML highlighting
function formatCoverLetterWithHTML(coverLetterText, metadata) {
    if (!coverLetterText) return '';

    // Normalise line endings and collapse 3+ newlines to 2
    const normalized = coverLetterText
        .replace(/\r\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n');

    // Split on double newlines (paragraph breaks)
    const paragraphs = normalized.split(/\n\n+/);

    let html = '';
    paragraphs.forEach(para => {
        const trimmed = para.trim();
        if (!trimmed) return;

        // Within a paragraph, replace single \n with <br> for soft line breaks
        let formatted = trimmed
            .replace(/\n/g, '<br>')
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

        html += `<p style="margin-bottom: 15px; line-height: 1.6;">${formatted}</p>`;
    });

    return html;
}

// Helper function: Generate cover letter PDF
async function generateCoverLetterPDF(user, coverLetterHtmlOrText, companyName, companyAddress = '') {
    // Determine if input is HTML or plain text
    const isHtml = coverLetterHtmlOrText.includes('<') && coverLetterHtmlOrText.includes('>');
    
    // Extract plain text from HTML if needed
    let coverLetterText = coverLetterHtmlOrText;
    if (isHtml) {
        coverLetterText = coverLetterHtmlOrText
            .replace(/<br\s*\/?>/gi, ' ')   // soft break → space (PDF word-wraps itself)
            .replace(/<\/p>/gi, '\n\n')     // paragraph end → blank line
            .replace(/<strong>(.*?)<\/strong>/gi, '$1')  // strip bold tags, keep text
            .replace(/<[^>]+>/g, '')        // strip any remaining tags
            .replace(/&nbsp;/g, ' ')
            .replace(/\n{3,}/g, '\n\n')    // collapse excess blank lines
            .trim();
    }
    
    // Create PDF
    const pdfDoc = await PDFDocument.create();
    let page = pdfDoc.addPage([595.28, 841.89]); // A4 size
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    
    const fontSize = 11;
    const lineHeight = 16;
    const margin = 50;
    let yPosition = page.getHeight() - margin;
    
    // Add header with user info
    page.drawText(user.full_name, {
        x: margin,
        y: yPosition,
        size: 14,
        font: boldFont,
        color: rgb(0, 0, 0)
    });
    yPosition -= 20;
    
    // Contact info
    const contactInfo = [user.email, user.phone_number, user.city && user.country ? `${user.city}, ${user.country}` : ''].filter(Boolean).join(' | ');
    page.drawText(contactInfo, {
        x: margin,
        y: yPosition,
        size: 9,
        font: font,
        color: rgb(0.3, 0.3, 0.3)
    });
    yPosition -= 30;
    
    // Date
    const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    page.drawText(date, {
        x: margin,
        y: yPosition,
        size: 10,
        font: font
    });
    yPosition -= 25;
    
    // Company address
    if (companyAddress) {
        page.drawText(companyName, {
            x: margin,
            y: yPosition,
            size: 10,
            font: boldFont
        });
        yPosition -= 15;
        
        page.drawText(companyAddress, {
            x: margin,
            y: yPosition,
            size: 10,
            font: font
        });
        yPosition -= 25;
    }
    
    // Salutation
    page.drawText('Dear Hiring Manager,', {
        x: margin,
        y: yPosition,
        size: 11,
        font: font
    });
    yPosition -= 25;
    
    // Body text with word wrapping (preserve paragraph breaks)
    const maxWidth = page.getWidth() - (margin * 2);
    const paragraphs = coverLetterText
        .split(/\n\s*\n/)
        .map(p => p.trim())
        .filter(Boolean);

    for (const paragraph of paragraphs) {
        const words = paragraph.split(/\s+/);
        let line = '';

        for (const word of words) {
            const testLine = line + (line ? ' ' : '') + word;
            const width = font.widthOfTextAtSize(testLine, fontSize);

            if (width > maxWidth && line) {
                page.drawText(line, {
                    x: margin,
                    y: yPosition,
                    size: fontSize,
                    font: font
                });
                yPosition -= lineHeight;
                line = word;

                // Add new page if needed
                if (yPosition < margin + 100) {
                    page = pdfDoc.addPage([595.28, 841.89]);
                    yPosition = page.getHeight() - margin;
                }
            } else {
                line = testLine;
            }
        }

        if (line) {
            page.drawText(line, {
                x: margin,
                y: yPosition,
                size: fontSize,
                font: font
            });
            yPosition -= lineHeight;
        }

        // Paragraph spacing
        yPosition -= 9;

        if (yPosition < margin + 100) {
            page = pdfDoc.addPage([595.28, 841.89]);
            yPosition = page.getHeight() - margin;
        }
    }
    
    // Closing
    if (yPosition < margin + 80) {
        const newPage = pdfDoc.addPage([595.28, 841.89]);
        yPosition = newPage.getHeight() - margin;
    }
    
    yPosition -= 10;
    page.drawText('Sincerely,', {
        x: margin,
        y: yPosition,
        size: 11,
        font: font
    });
    yPosition -= 20;
    
    page.drawText(user.full_name, {
        x: margin,
        y: yPosition,
        size: 11,
        font: boldFont
    });
    
    // Save PDF
    const pdfBytes = await pdfDoc.save();
    const fileName = `Cover_Letter_${companyName.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}.pdf`;
    const filePath = path.join(__dirname, '../../temp', fileName);
    
    // Ensure temp directory exists
    await fs.mkdir(path.join(__dirname, '../../temp'), { recursive: true });
    
    await fs.writeFile(filePath, pdfBytes);
    
    return { filePath, fileName };
}

// Persist all employer research data into DB tables (fire-and-forget safe)
async function saveEmployerResearch(data) {
    if (!data || !data.website_url) return;
    const url = data.website_url;
    try {
        // employer_profiles
        await dbConfig.run(
            `INSERT INTO employer_profiles (website_url, employer_name, founded_year, company_size, industry, mission, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT (website_url) DO UPDATE SET
               employer_name = EXCLUDED.employer_name,
               founded_year = EXCLUDED.founded_year,
               company_size = EXCLUDED.company_size,
               industry = EXCLUDED.industry,
               mission = EXCLUDED.mission,
               updated_at = CURRENT_TIMESTAMP`,
            [url, data.employer_name || null, data.founded_year || null,
             data.company_size || null, data.industry || null, data.mission || null]
        );
        // employer_brand_profiles
        await dbConfig.run(
            `INSERT INTO employer_brand_profiles (website_url, brand_color, font_name)
             VALUES (?, ?, ?)
             ON CONFLICT (website_url) DO UPDATE SET brand_color = EXCLUDED.brand_color, font_name = EXCLUDED.font_name`,
            [url, data.brand_color || '#262633', data.font_name || 'Lato']
        );
        // employer_technologies — clear old rows then insert fresh
        await dbConfig.run('DELETE FROM employer_technologies WHERE website_url = ?', [url]);
        for (const t of (data.technologies || [])) {
            if (t.name) await dbConfig.run(
                'INSERT INTO employer_technologies (website_url, name, category) VALUES (?, ?, ?)',
                [url, t.name, t.category || null]
            );
        }
        // employer_clients
        await dbConfig.run('DELETE FROM employer_clients WHERE website_url = ?', [url]);
        for (const c of (data.clients || [])) {
            if (c.client_name) await dbConfig.run(
                'INSERT INTO employer_clients (website_url, client_name, industry, notes) VALUES (?, ?, ?, ?)',
                [url, c.client_name, c.industry || null, c.notes || null]
            );
        }
        // employer_recent_activity
        await dbConfig.run('DELETE FROM employer_recent_activity WHERE website_url = ?', [url]);
        for (const a of (data.recent_activity || [])) {
            if (a.description) await dbConfig.run(
                'INSERT INTO employer_recent_activity (website_url, activity_type, description) VALUES (?, ?, ?)',
                [url, a.activity_type || null, a.description]
            );
        }
        // employer_contacts
        await dbConfig.run('DELETE FROM employer_contacts WHERE website_url = ?', [url]);
        for (const k of (data.key_contacts || [])) {
            if (k.name || k.role) await dbConfig.run(
                'INSERT INTO employer_contacts (website_url, name, role, source) VALUES (?, ?, ?, ?)',
                [url, k.name || null, k.role || null, k.source || null]
            );
        }
        // employer_locations (from research addresses if available)
        if ((data.locations || []).length > 0) {
            await dbConfig.run('DELETE FROM employer_locations WHERE website_url = ?', [url]);
            for (const loc of data.locations) {
                if (loc.address) await dbConfig.run(
                    'INSERT INTO employer_locations (website_url, address, is_headquarters) VALUES (?, ?, ?)',
                    [url, loc.address, loc.is_headquarters || false]
                );
            }
        }
        console.log(`💾 [employer-research] Saved all data for ${url}`);
    } catch (err) {
        console.error(`[employer-research] ❌ DB save failed for ${url}:`, err.message);
        console.error(err.stack);
    }
}

// Helper function: Generate additional details (hiring manager, locations, subject)
async function generateAdditionalDetails(websiteUrl, companyName, position = 'Position', userFullName = '') {
    const geminiKey = process.env.GEMINI_API_KEY;
    
    if (!geminiKey) {
        console.log('⚠️ No Gemini API key - using defaults');
        const applicantName = userFullName || 'Applicant';
        return {
            hiringManager: 'Hiring Manager',
            locations: [{ 
                country: '', 
                city: '', 
                address: 'Address not available online',
                isHeadquarters: true 
            }],
            subject: `Application for ${position} - ${applicantName}`
        };
    }

    try {
        const { GoogleGenerativeAI } = require('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(geminiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

        const applicantName = userFullName || 'Applicant';
        const prompt = `You are extracting hiring manager information and company office locations from a company website.

Company: ${companyName}
Website: ${websiteUrl}
Position: ${position}
Applicant Name: ${applicantName}

Extract the following information and return ONLY valid JSON:

1. **Hiring Manager Name**: Look for HR contact, recruiter, or hiring manager name. If not found, return "Hiring Manager"
2. **All Company Locations**: Extract ALL office locations (headquarters and branches) with complete street address, city, and country. Try multiple sources: About page, Contact page, footer, headquarters section.
3. **Subject Line**: Generate a professional, concise email subject line for this job application using the applicant's name

Return this EXACT JSON format (no markdown, no code blocks):
{
  "hiringManager": "Name or 'Hiring Manager'",
  "locations": [
    {"country": "Country", "city": "City", "address": "Complete Street Address with ZIP/Postal Code", "isHeadquarters": true},
    {"country": "Country2", "city": "City2", "address": "Complete Street Address", "isHeadquarters": false}
  ],
  "subject": "Application for ${position} - ${applicantName}"
}

IMPORTANT: 
- For subject line, use the format: "Application for [Position] - [Applicant Name]" or "[Position] Application - [Applicant Name]"
- For each location, provide the MOST COMPLETE address you can find:
  * First priority: Full street address with number, street name, city, state/province, ZIP/postal code, country
  * Second priority: Building/Office name, city, state/province, country  
  * Third priority: City, state/province, country
  * Last resort: City, country
- Search thoroughly: check Contact page, About page, footer, "Locations" page, "Find Us" page
- If you cannot find ANY location information on the website, search Google for "${companyName} headquarters address" or "${companyName} office location"
- DO NOT return "Not specified" unless you've exhausted all options including Google search

Research thoroughly and extract real information.`;

        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            tools: [{ googleSearch: {} }]
        });
        
        const response = await result.response;
        let text = response.text();
        
        // Check if response is null or empty
        if (!text || text.trim() === '') {
            console.warn('⚠️ Gemini returned empty response, using defaults');
            throw new Error('Gemini returned empty response');
        }
        
        // Clean up response
        text = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
        
        // Extract JSON
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const data = JSON.parse(jsonMatch[0]);
            
            // Ensure each location has an address field
            const locations = (data.locations || []).map(loc => {
                const city = loc.city || '';
                const country = loc.country || '';
                let address = loc.address || '';
                
                // If no address provided, construct from city and country
                if (!address && city && country) {
                    address = `${city}, ${country}`;
                } else if (!address && (city || country)) {
                    address = city || country;
                } else if (!address) {
                    address = 'Address not available online';
                }
                
                return {
                    ...loc,
                    address: address,
                    city: city || 'Not specified',
                    country: country || 'Not specified',
                    isHeadquarters: loc.isHeadquarters !== undefined ? loc.isHeadquarters : true
                };
            });
            
            return {
                hiringManager: data.hiringManager || 'Hiring Manager',
                locations: locations.length > 0 ? locations : [{ 
                    country: '', 
                    city: '', 
                    address: 'Address not available online',
                    isHeadquarters: true 
                }],
                subject: data.subject || `Application for ${position} - ${userFullName || 'Applicant'}`
            };
        }
        
        throw new Error('Failed to parse AI response');
        
    } catch (error) {
        console.error('Error generating additional details:', error.message);
        const applicantName = userFullName || 'Applicant';
        return {
            hiringManager: 'Hiring Manager',
            locations: [{ 
                country: '', 
                city: '', 
                address: 'Address not available online',
                isHeadquarters: true 
            }],
            subject: `Application for ${position} - ${applicantName}`
        };
    }
}

// Generate cover letter (bulk)
const generateCoverLetters = async (req, res) => {
    try {
        const userId = req.user.id;
        const { recipients } = req.body;

        console.log('\n📝 ============ GENERATE COVER LETTERS START ============');
        console.log('📝 [GENERATE] User ID:', userId);
        console.log('📝 [GENERATE] Recipients count:', recipients?.length || 0);

        if (!recipients || recipients.length === 0) {
            return res.status(400).json({ error: 'No recipients provided' });
        }

        // CHECK CREDITS — per-cover-letter cost is admin-configurable.
        const clCost = await getEventCost('cover_letter_generate');
        try {
            const creditCheck = await checkUserCredits(userId, recipients.length * clCost);
            if (!creditCheck.hasCredits) {
                return res.status(402).json({
                    error: creditCheck.message,
                    remainingCredits: creditCheck.remaining,
                    creditsRequired: recipients.length * clCost
                });
            }
        } catch (error) {
            return res.status(500).json({ error: 'Failed to check credit balance' });
        }

        // Get user profile
        try {
            const user = await dbConfig.get('SELECT * FROM users WHERE id = ?', [userId]);
            
            if (!user) {
                return res.status(404).json({ error: 'User not found' });
            }
            
            if (!user.resume_path || user.resume_path.trim() === '') {
                // Create notification for missing resume
                await notifyError(
                    userId,
                    'Resume Required',
                    'Please upload your resume before generating cover letters. Go to Profile (top right) to upload your resume.',
                    'upload_resume'
                );
                
                return res.status(400).json({ 
                    error: 'Resume required',
                    message: 'Please upload your resume before generating cover letters. Go to Profile (top right) to upload your resume.',
                    action: 'upload_resume'
                });
            }

            const results = [];
            let creditsDeducted = 0;

            // Load resume metadata once for all recipients, with retries
            let resumeMetadata = null;
            for (let attempt = 0; attempt < 5; attempt++) {
                resumeMetadata = await dbConfig.get(
                    'SELECT * FROM resume_metadata WHERE user_id = ? AND parse_status = ?',
                    [userId, 'done']
                );
                if (resumeMetadata) break;
                if (attempt < 4) await new Promise(r => setTimeout(r, 5000)); // wait 5s
            }

            if (!resumeMetadata) {
                return res.status(400).json({
                    error: 'Resume not processed yet',
                    message: 'Your resume is still being analyzed. This can take up to a minute. Please wait a moment and try again.'
                });
            }

            // Point 6: add Builder-resume context (if present) for richer letters.
            resumeMetadata = await mergeBuilderResume(userId, resumeMetadata);

            for (const recipient of recipients) {
                try {
                    console.log(`\n📤 Processing: ${recipient.email}`);

                    const aiResult = await generateCoverLetterV2(
                        resumeMetadata,
                        recipient.website,
                        recipient.position || 'Position'
                    );

                    const companyName = aiResult.employer_name || recipient.website;
                    const coverLetterText = aiResult.cover_letter;
                    
                    console.log(`✅ Generated personalized cover letter for ${companyName}`);

                    // DEDUCT CREDIT
                    try {
                        await deductCredits(userId, clCost, 'cover_letter_generation', {
                            companyName: companyName,
                            position: recipient.position,
                            recipientEmail: recipient.email
                        });
                        creditsDeducted++;
                    } catch (creditError) {
                        console.error('Failed to deduct credit:', creditError);
                    }

                    // Format and generate PDF
                    const coverLetterHtml = formatCoverLetterWithHTML(coverLetterText, {});
                    const { filePath, fileName } = await generateCoverLetterPDF(
                        user,
                        coverLetterHtml,
                        companyName,
                        ''
                    );

                    const downloadUrl = `/api/download-cover-letter/${encodeURIComponent(fileName)}`;

                    results.push({
                        email: recipient.email,
                        company: companyName,
                        position: recipient.position || 'Position',
                        website: recipient.website,
                        fileName: fileName,
                        downloadUrl: downloadUrl,
                        status: 'generated',
                        metadata: {}
                    });

                } catch (error) {
                    console.error(`❌ Failed to generate for ${recipient.email}:`, error.message);
                    results.push({
                        email: recipient.email,
                        status: 'failed',
                        error: error.message,
                    });
                }
            }

            const successCount = results.filter(r => r.status === 'generated').length;
            
            // Update total_generated counter
            if (successCount > 0) {
                await dbConfig.run(
                    'UPDATE users SET total_generated = total_generated + ? WHERE id = ?',
                    [successCount, userId]
                );
            }
            
            // Get updated credit balance
            const creditCheck = await checkUserCredits(userId, 0);
            
            res.json({
                success: true,
                message: `Generated ${successCount}/${recipients.length} cover letters`,
                results,
                creditsUsed: creditsDeducted,
                creditsRemaining: creditCheck.remaining
            });

        } catch (error) {
            console.error('Database error:', error);
            return res.status(500).json({ error: 'Failed to load user profile' });
        }
    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({ error: error.message });
    }
};

// Generate cover letter details (for review page)
const generateCoverLetterDetails = async (req, res) => {
    const requestId = Date.now();
    const startTime = Date.now();
    const useAsync = process.env.USE_ASYNC_JOBS !== 'false';
    
    try {
        const userId = req.user.id;
        let { recipientEmail, websiteUrl, position, responsibilities, jobLocation, jobId: sourceJobId, companyName: companyNameHint } = req.body;

        // Job-aware augmentation: the dashboard LIST payload trims responsibilities to 3 for
        // speed — when the client says which job this is, prefer the FULL stored list so the
        // letter's tailoring never depends on what the client happened to hold.
        if (sourceJobId) {
            try {
                // Scoped to the caller's own matched jobs (same ownership rule as /jobs/:id/full).
                const row = await dbConfig.get(
                    'SELECT j.responsibilities FROM jobs j JOIN user_job_matches ujm ON ujm.job_id = j.id WHERE j.id = ? AND ujm.user_id = ?',
                    [sourceJobId, userId]
                );
                const full = row && row.responsibilities
                    ? (typeof row.responsibilities === 'string' ? JSON.parse(row.responsibilities) : row.responsibilities)
                    : [];
                if (Array.isArray(full) && full.length > (Array.isArray(responsibilities) ? responsibilities.length : 0)) {
                    responsibilities = full;
                }
            } catch { /* augmentation is best-effort — the client-sent list still works */ }
        }

        console.log(`\n📨 [${requestId}] Generate Cover Letter Details Request (${useAsync ? 'ASYNC' : 'SYNC'})`);
        console.log(`   User: ${userId}, Position: ${position}`);
        emit(req, 'cover_letter_generate', { forJob: !!sourceJobId });

        // CHECK CREDITS (always synchronous — fast DB check)
        try {
            const creditCheck = await checkUserCredits(userId, await getEventCost('cover_letter_generate'));
            if (!creditCheck.hasCredits) {
                return res.status(402).json({ 
                    error: creditCheck.message,
                    remainingCredits: creditCheck.remaining,
                    creditsRequired: 1
                });
            }
        } catch (error) {
            return res.status(500).json({ error: 'Failed to check credit balance' });
        }

        // Get user profile (always synchronous — fast DB check)
        const user = await dbConfig.get('SELECT * FROM users WHERE id = ?', [userId]);
        
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        if (!user.resume_path || user.resume_path.trim() === '') {
            await notifyError(
                userId,
                'Resume Required',
                'Please upload your resume before generating cover letters. Go to Profile (top right) to upload your resume.',
                'upload_resume'
            );
            
            return res.status(400).json({ 
                error: 'Resume required',
                message: 'Please upload your resume before generating cover letters. Go to Profile (top right) to upload your resume.',
                action: 'upload_resume'
            });
        }

        if (useAsync) {
            // ASYNC MODE: Create job and return immediately
            const jobId = await jobService.createJob(userId, 'generate_cover_letter', {
                recipientEmail, websiteUrl, position, responsibilities, jobLocation, companyNameHint
            });
            console.log(`🚀 [${requestId}] Async job created: ${jobId}`);

            // Respond immediately with 202
            res.status(202).json({ jobId, status: 'pending' });

            // Fire and forget — process in background
            processGenerationJob(jobId, userId, { recipientEmail, websiteUrl, position, responsibilities, jobLocation, companyNameHint }).catch(err => {
                console.error(`❌ [${requestId}] Async job ${jobId} failed:`, err.message);
                // The stored failure message is shown to the user by the poller —
                // only deliberately user-facing text may pass through.
                const safeMsg = (err.userFacing || /^Resume not processed yet/.test(err.message || ''))
                    ? err.message
                    : 'Failed to generate the cover letter. Please try again.';
                jobService.failJob(jobId, safeMsg).catch(console.error);
            });

        } else {
            // SYNC MODE: Original behavior — hold connection until done
            const result = await executeGenerationWork(userId, user, { recipientEmail, websiteUrl, position, responsibilities, jobLocation, companyNameHint });

            const duration = Date.now() - startTime;
            console.log(`✅ [${requestId}] Response sent in ${duration}ms`);

            res.json(result);
        }

    } catch (error) {
        const duration = Date.now() - startTime;
        console.error(`❌ [${requestId}] Error (${duration}ms):`, error.message);
        // Only deliberately user-facing messages may reach the client; raw internal
        // errors (JSON SyntaxError, DB, API) are logged above and replaced.
        const safeMessage = (error.userFacing || /^Resume not processed yet/.test(error.message || ''))
            ? error.message
            : 'Failed to generate the cover letter. Please try again.';
        res.status(500).json({ error: safeMessage });
    }
};

/**
 * The actual heavy generation work — used by both sync and async modes
 */
// Job BOARDS are not employers. A posting opened on instahyre/naukri/linkedin gives us the board's
// host, and researching THAT produced letters addressed to the job board instead of the company.
const AGGREGATOR_HOST = /(instahyre|naukri|linkedin|indeed|glassdoor|monster|shine|timesjobs|foundit|wellfound|ziprecruiter|simplyhired|jooble|careerjet|adzuna|talent\.com|jobs?\.[a-z]+\.com)\b/i;

async function executeGenerationWork(userId, user, { recipientEmail, websiteUrl, position, responsibilities = null, jobLocation = null, companyNameHint = null }) {
    console.log(`🚀 [executeGenerationWork] ENTERED — userId=${userId}, websiteUrl=${websiteUrl}, position=${position}, hasResponsibilities=${!!(responsibilities && responsibilities.length)}, jobLocation=${jobLocation || 'none'}, companyHint=${companyNameHint || 'none'}`);
    // Normalize URL
    const normalizedWebsiteUrl = websiteUrl && websiteUrl.match(/^https?:\/\//) ? websiteUrl : `https://${websiteUrl}`;
    // Who do we actually research? If the only URL we have is a job board, research the COMPANY NAME
    // we extracted from the posting instead — otherwise the letter is written to the job board.
    const researchSubject = (companyNameHint && AGGREGATOR_HOST.test(normalizedWebsiteUrl))
        ? String(companyNameHint).trim()
        : normalizedWebsiteUrl;
    if (researchSubject !== normalizedWebsiteUrl) console.log(`🏢 [employer] job-board URL detected → researching "${researchSubject}" instead of ${normalizedWebsiteUrl}`);

    // Load pre-parsed resume metadata (generated by resumeParserService after upload)
    // Retry multiple times with increasing delay in case the background parser is still running
    let resumeMetadata = null;
    for (let attempt = 0; attempt < 5; attempt++) { // Increased to 5 retries
        resumeMetadata = await dbConfig.get(
            'SELECT * FROM resume_metadata WHERE user_id = ? AND parse_status = ?',
            [userId, 'done'] // Corrected status to 'done' to match the parser
        );
        if (resumeMetadata) break;
        // Wait longer before retrying
        if (attempt < 4) await new Promise(r => setTimeout(r, 5000)); // wait 5s before retry
    }

    if (!resumeMetadata) {
        throw new Error('Resume not processed yet. Please wait a moment after uploading and try again.');
    }

    // Point 6: add Builder-resume context (if present) for richer letters.
    resumeMetadata = await mergeBuilderResume(userId, resumeMetadata);

    console.log(`[coverLetterController] Starting generation for user ${userId}, url=${normalizedWebsiteUrl}, position=${position}`);

    // Check employer brand cache first
    const cached = await dbConfig.get(
        'SELECT brand_color, font_name FROM employer_brand_profiles WHERE website_url = ?',
        [researchSubject]
    );

    let brandColor, fontName, aiResult;

    if (cached) {
        // Cache hit — run cover letter generation alone at full speed
        console.log(`🎨 [employer] Cache hit → color=${cached.brand_color}, font=${cached.font_name}`);
        aiResult = await generateCoverLetterV2(resumeMetadata, researchSubject, position, responsibilities, jobLocation);
        brandColor = cached.brand_color;
        fontName = cached.font_name;
    } else {
        // Cache miss — run cover letter generation + full employer research IN PARALLEL
        console.log(`🔍 [employer] Cache miss — running cover letter + employer research in parallel`);
        const [clResult, researchData] = await Promise.all([
            generateCoverLetterV2(resumeMetadata, researchSubject, position, responsibilities, jobLocation),
            researchEmployer(researchSubject),
        ]);
        aiResult = clResult;
        brandColor = researchData?.brand_color || '#262633';
        fontName   = researchData?.font_name   || 'Lato';
        // Persist all employer research tables (non-blocking)
        console.log(`🔬 [employer] researchData received:`, researchData ? `name=${researchData.employer_name}, color=${researchData.brand_color}, font=${researchData.font_name}` : 'NULL');
        if (researchData) {
            saveEmployerResearch(researchData).catch(err => {
                console.error('[employer] saveEmployerResearch FAILED:', err.message, err.stack);
            });
        } else {
            console.warn('[employer] researchData was null — skipping DB save');
        }
    }

    const companyName = aiResult.employer_name || companyNameHint || researchSubject;
    const hiringManager = aiResult.to || 'Hiring Manager';
    const subject = aiResult.subject || `Application for ${position}`;

    // Map addresses array → locations format expected by the mobile app
    const locations = (aiResult.addresses || []).map((addr, i) => ({
        address: addr,
        city: '',
        country: '',
        isHeadquarters: i === 0
    }));
    if (locations.length === 0) {
        locations.push({ address: 'Address not available', city: '', country: '', isHeadquarters: true });
    }

    // Job-aware selection: a cover letter generated FOR A JOB must use that job's office,
    // not the HQ. If jobLocation was provided, surface the matching office first (flagged
    // matchesJobLocation); if none of the scraped addresses match, synthesize an entry from
    // the job location so it is always present AND first. The mobile picker defaults to it.
    // A placeholder job location (extraction couldn't resolve it) must NEVER be surfaced — otherwise
    // the letter shows "Location TBD, Location TBD, Location TBD". Treat these as "no job location"
    // and fall back to the real researched offices (HQ first).
    const isPlaceholderLoc = (v) => !v || /^(location\s*tbd|tbd\s*location|tbd|n\.?\/?a\.?|none|null|unknown|not\s*(specified|available|provided)|various|multiple\s*locations?|remote|hybrid|on[\s-]?site|—|–|-)$/i.test(String(v).trim());
    if (jobLocation && jobLocation.trim() && !isPlaceholderLoc(jobLocation)) {
        const jl = jobLocation.toLowerCase().trim();
        const tokens = jl.split(/[,\s]+/).map(t => t.trim()).filter(t => t.length >= 3 && !isPlaceholderLoc(t));
        const matchIdx = locations.findIndex(l => {
            const hay = `${l.address} ${l.city} ${l.country}`.toLowerCase();
            return (jl.length >= 4 && hay.includes(jl)) || tokens.some(t => hay.includes(t));
        });
        if (matchIdx >= 0) {
            const [match] = locations.splice(matchIdx, 1);
            match.matchesJobLocation = true;
            locations.unshift(match);
        } else {
            const parts = jobLocation.split(',').map(s => s.trim()).filter(Boolean);
            locations.unshift({
                address: jobLocation.trim(),
                city: parts[0] || '',
                // Only set country from a distinct 2nd part — never duplicate the city as the country.
                country: parts.length > 1 ? parts[parts.length - 1] : '',
                isHeadquarters: false,
                matchesJobLocation: true,
            });
        }
    }
    // Drop any placeholder/junk locations that slipped through (e.g. a synthesized 'Location TBD').
    let cleaned = locations.filter((l) => !(isPlaceholderLoc(l.address) && isPlaceholderLoc(l.city) && isPlaceholderLoc(l.country)));
    if (cleaned.length === 0) cleaned = [{ address: 'Address not available', city: '', country: '', isHeadquarters: true }];
    locations.length = 0;
    locations.push(...cleaned);

    // Format markdown cover letter body as HTML. This single region-neutral
    // letter is used for every region — the picker only changes PDF formatting.
    const coverLetterHtml = formatCoverLetterWithHTML(aiResult.cover_letter || '', {});

    // DEDUCT CREDIT (admin-configurable cost)
    try {
        const clCost = await getEventCost('cover_letter_generate');
        console.log(`💳 Deducting ${clCost} credit(s) from user ${userId}...`);
        await deductCredits(userId, clCost, 'cover_letter_generation', {
            companyName,
            position,
            recipientEmail
        });
        console.log(`✅ Credit deducted successfully`);

        await dbConfig.run(
            'UPDATE users SET total_generated = total_generated + 1 WHERE id = ?',
            [userId]
        );
    } catch (creditError) {
        console.error('❌ Failed to deduct credit:', creditError);
    }

    // Get updated credits
    const creditCheck = await checkUserCredits(userId, 0);
    console.log(`💰 User ${userId} now has ${creditCheck.remaining} credits remaining`);

    // Create notification
    try {
        await notifyCoverLetterGenerated(userId, companyName, position, normalizedWebsiteUrl);
    } catch (notifError) {
        console.error('Failed to create notification:', notifError);
    }

    return {
        success: true,
        companyName,
        hiringManager,
        subject,
        locations,
        coverLetterHtml,
        brandColor,
        fontName,
        metadata: {},
        creditsUsed: 1,
        creditsRemaining: creditCheck.remaining
    };
}

/**
 * Process a generation job asynchronously (called fire-and-forget)
 */
async function processGenerationJob(jobId, userId, input) {
    await jobService.startJob(jobId);
    await jobService.updateJobProgress(jobId, 10);

    const user = await dbConfig.get('SELECT * FROM users WHERE id = ?', [userId]);
    await jobService.updateJobProgress(jobId, 20);

    const result = await executeGenerationWork(userId, user, input);
    await jobService.completeJob(jobId, result);
    console.log(`✅ Async job ${jobId} completed successfully`);
}

// Generate cover letter PDF for download
const generateCoverLetterPdf = async (req, res) => {
    const useAsync = process.env.USE_ASYNC_JOBS === 'true';
    
    try {
        const userId = req.user.id;
        const { coverLetterHtml, companyName, companyAddress, websiteUrl } = req.body;
        let { brandColor, fontName } = req.body;

        // Get user profile
        const user = await dbConfig.get('SELECT * FROM users WHERE id = ?', [userId]);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // If brand data not passed by client, look it up from employer_brand_profiles cache
        if (!brandColor || !fontName) {
            // Step 1: Try direct URL lookup
            let lookupUrl = websiteUrl;
            if (lookupUrl && !lookupUrl.startsWith('http')) lookupUrl = 'https://' + lookupUrl;
            if (lookupUrl) {
                const cached = await dbConfig.get(
                    'SELECT brand_color, font_name FROM employer_brand_profiles WHERE website_url = ?',
                    [lookupUrl]
                );
                if (cached) {
                    brandColor = brandColor || cached.brand_color;
                    fontName   = fontName   || cached.font_name;
                    console.log(`🎨 [PDF DOWNLOAD] Brand from URL cache: color=${brandColor}, font=${fontName}`);
                }
            }

            // Step 2: Look up stored_recipient_website from this user's cover letter rows, match by company name first word
            if (!brandColor && companyName) {
                const firstWord = companyName.split(/\s+/)[0];
                const rclRow = await dbConfig.get(
                    `SELECT stored_recipient_website FROM review_cover_letters
                     WHERE user_id = ? AND stored_recipient_website IS NOT NULL AND stored_recipient_website <> ''
                     AND company_name ILIKE ?
                     LIMIT 1`,
                    [userId, `%${firstWord}%`]
                );
                if (rclRow?.stored_recipient_website) {
                    let rclUrl = rclRow.stored_recipient_website;
                    if (!rclUrl.startsWith('http')) rclUrl = 'https://' + rclUrl;
                    const cached = await dbConfig.get(
                        'SELECT brand_color, font_name FROM employer_brand_profiles WHERE website_url = ?',
                        [rclUrl]
                    );
                    if (cached) {
                        brandColor = brandColor || cached.brand_color;
                        fontName   = fontName   || cached.font_name;
                        console.log(`🎨 [PDF DOWNLOAD] Brand from cover letter URL (${rclUrl}): color=${brandColor}, font=${fontName}`);
                    }
                }
            }

            // Step 3: Fuzzy match on employer_profiles.employer_name
            if (!brandColor && companyName) {
                const firstWord = companyName.split(/\s+/)[0];
                const byName = await dbConfig.get(
                    `SELECT ebp.brand_color, ebp.font_name
                     FROM employer_brand_profiles ebp
                     JOIN employer_profiles ep ON ep.website_url = ebp.website_url
                     WHERE ep.employer_name ILIKE ?
                     LIMIT 1`,
                    [`%${firstWord}%`]
                );
                if (byName) {
                    brandColor = brandColor || byName.brand_color;
                    fontName   = fontName   || byName.font_name;
                    console.log(`🎨 [PDF DOWNLOAD] Brand by name fuzzy match: color=${brandColor}, font=${fontName}`);
                }
            }

            if (!brandColor) console.log(`🎨 [PDF DOWNLOAD] No brand found — using default dark grey`);
        }

        // Use the EXACT same PDF generator as the email attachment flow
        console.log('🖨️ [PDF DOWNLOAD] companyName:', companyName, '| companyAddress:', companyAddress);
        console.log('🖨️ [PDF DOWNLOAD] brandColor:', brandColor, '| fontName:', fontName);
        console.log('🖨️ [PDF DOWNLOAD] html length:', coverLetterHtml?.length, '| preview:', coverLetterHtml?.slice(0, 80));
        const generateRichPDF = () => generateRichCoverLetterPDF(user, coverLetterHtml, companyName, companyAddress || '', brandColor || null, fontName || null);

        if (useAsync) {
            const jobId = await jobService.createJob(userId, 'generate_pdf', {
                coverLetterHtml, companyName, companyAddress
            });

            res.status(202).json({ jobId, status: 'pending' });

            // Fire and forget
            (async () => {
                try {
                    await jobService.startJob(jobId);
                    const { filePath, fileName } = await generateRichPDF();
                    const downloadUrl = `/api/download-cover-letter/${encodeURIComponent(fileName)}`;
                    await jobService.completeJob(jobId, { success: true, downloadUrl, fileName });
                } catch (err) {
                    await jobService.failJob(jobId, err.message).catch(console.error);
                }
            })();
        } else {
            const { filePath, fileName } = await generateRichPDF();
            const downloadUrl = `/api/download-cover-letter/${encodeURIComponent(fileName)}`;
            res.json({ success: true, downloadUrl, fileName });
        }

    } catch (error) {
        console.error('Error generating PDF:', error);
        res.status(500).json({ error: error.message || 'Failed to generate PDF' });
    }
};

// ══════════════════════════════════════════════════════════════════════════════
// COUNTRY-FORMAT COVER LETTER TEMPLATES (preview + credited download)
// ══════════════════════════════════════════════════════════════════════════════

// Sender block from the user record (+ a title from their saved resume if present).
async function buildCLSender(userId) {
    let u = {};
    try { u = await dbConfig.get('SELECT full_name, email, phone_number, city, country FROM users WHERE id = ?', [userId]) || {}; } catch {}
    let title = '';
    try {
        const r = await dbConfig.get('SELECT resume_data FROM user_resumes WHERE user_id = ?', [userId]);
        const rd = r && r.resume_data;
        title = (rd && ((rd.personal_info && rd.personal_info.title) || (rd.experience && rd.experience[0] && rd.experience[0].role))) || '';
    } catch {}
    const location = u.city && u.country ? `${u.city}, ${u.country}` : (u.city || u.country || '');
    return { name: u.full_name || '', email: u.email || '', phone: u.phone_number || '', location, title };
}

// Profile photo → compact JPEG data URI (flatten transparency to white).
async function loadCLPhotoDataUri(userId) {
    try {
        const u = await dbConfig.get('SELECT photo_path FROM users WHERE id = ?', [userId]);
        if (!u || !u.photo_path) return null;
        const p = path.join(__dirname, '../../', u.photo_path);
        await fs.access(p);
        const sharp = require('sharp');
        const out = await sharp(p).rotate().flatten({ background: '#ffffff' }).resize(300, 300, { fit: 'cover', position: 'attention' }).jpeg({ quality: 84 }).toBuffer();
        return `data:image/jpeg;base64,${out.toString('base64')}`;
    } catch { return null; }
}

// Look up the employer's brand colour for the Generic/branded letter.
async function lookupBrandColor(companyName, websiteUrl) {
    try {
        let url = websiteUrl;
        if (url && !url.startsWith('http')) url = 'https://' + url;
        if (url) {
            const c = await dbConfig.get('SELECT brand_color FROM employer_brand_profiles WHERE website_url = ?', [url]);
            if (c && c.brand_color) return c.brand_color;
        }
        if (companyName) {
            const fw = companyName.split(/\s+/)[0];
            const byName = await dbConfig.get(
                `SELECT ebp.brand_color FROM employer_brand_profiles ebp
                 JOIN employer_profiles ep ON ep.website_url = ebp.website_url
                 WHERE ep.employer_name ILIKE ? LIMIT 1`, [`%${fw}%`]);
            if (byName && byName.brand_color) return byName.brand_color;
        }
    } catch {}
    return null;
}

// POST /api/cover-letter/preview-templates  — free previews; FORMATTING ONLY (no AI).
// All regions render the same content in their visual template; Generic = branded original.
async function previewCoverLetterTemplates(req, res) {
    const userId = req.user.id;
    const { region, coverLetterHtml, companyName, companyAddress, brandColor, websiteUrl } = req.body || {};
    try {
        if (!coverLetterHtml || !String(coverLetterHtml).trim()) {
            return res.status(400).json({ error: 'No cover letter content to preview. Generate a cover letter first.' });
        }
        const rgn = region || 'generic';
        const sender = await buildCLSender(userId);

        // The Generic/branded letter needs the photo + brand colour; other templates are plain.
        let renderOpts = {};
        if (rgn === 'generic') {
            renderOpts = { photo: await loadCLPhotoDataUri(userId), brandColor: brandColor || await lookupBrandColor(companyName, websiteUrl) };
        }

        const data = { sender, company: { name: companyName || '', address: companyAddress || '' }, bodyHtml: coverLetterHtml };
        const tpls = clTemplates.templatesForRegion(rgn);
        const previews = await clRenderer.renderPreviews(data, renderOpts, tpls);
        return res.json({ success: true, region: rgn, previews });
    } catch (e) {
        console.error('[coverLetter] previewCoverLetterTemplates error:', e.message);
        return res.status(500).json({ error: 'Failed to render cover-letter previews. Please try again.' });
    }
}

// POST /api/cover-letter/generate-template-pdf  — PDF only (no rewriting), charge credits.
// Generic = the byte-exact original letter (original PDFKit generator); others = HTML templates.
async function generateCoverLetterTemplatePdf(req, res) {
    const userId = req.user.id;
    const { template, mode, coverLetterHtml, companyName, companyAddress, brandColor, websiteUrl } = req.body || {};
    try {
        const CL_DOWNLOAD_CREDIT_COST = await getEventCost('cover_letter_download');   // admin-configurable
        if (!coverLetterHtml || !String(coverLetterHtml).trim()) {
            return res.status(400).json({ error: 'No cover letter content. Generate a cover letter first.' });
        }
        const credit = await checkUserCredits(userId, CL_DOWNLOAD_CREDIT_COST);
        if (!credit.hasCredits) {
            return res.status(402).json({ error: credit.message, creditsRequired: CL_DOWNLOAD_CREDIT_COST, creditsRemaining: credit.remaining });
        }
        const tplId = clTemplates.TEMPLATE_IDS.includes(template) ? template : clTemplates.TEMPLATE_IDS[0];
        const tplMeta = clTemplates.TEMPLATES.find(t => t.id === tplId);

        let fileName;
        if (tplMeta && tplMeta.generic) {
            // Exact original branded letter — produced by the original PDFKit generator.
            const user  = await dbConfig.get('SELECT * FROM users WHERE id = ?', [userId]);
            const brand = brandColor || await lookupBrandColor(companyName, websiteUrl);
            const result = await generateRichCoverLetterPDF(user, coverLetterHtml, companyName || '', companyAddress || '', brand, null);
            fileName = result.fileName;
        } else {
            const sender = await buildCLSender(userId);
            const data = { sender, company: { name: companyName || '', address: companyAddress || '' }, bodyHtml: coverLetterHtml };
            const pdf = await clRenderer.renderPdf(tplId, data, { mode });
            const safeCo = (companyName || 'Company').replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').slice(0, 40);
            fileName = `Cover_Letter_${safeCo}_${Date.now()}.pdf`;
            const tempDir = path.join(__dirname, '../../temp');
            await fs.mkdir(tempDir, { recursive: true });
            await fs.writeFile(path.join(tempDir, fileName), pdf);
        }

        try { await deductCredits(userId, CL_DOWNLOAD_CREDIT_COST, 'cover_letter_download', { template: tplId, mode: mode || 'onepage' }); }
        catch (e) { console.warn('[coverLetter] credit deduction failed:', e.message); }

        return res.json({ success: true, downloadUrl: `/api/download-cover-letter/${encodeURIComponent(fileName)}`, template: tplId, creditsRemaining: Math.max(0, credit.remaining - CL_DOWNLOAD_CREDIT_COST) });
    } catch (e) {
        console.error('[coverLetter] generateCoverLetterTemplatePdf error:', e.message);
        return res.status(500).json({ error: 'Failed to generate cover letter PDF. Please try again.' });
    }
}

// POST /api/cover-letter/generate-template-docx — Word (.docx) export of a cover
// letter. Reuses the SAME template HTML as the PDF path (renderCoverLetterHtml,
// which falls back to a clean letter for the generic template), then converts via
// html-to-docx. Additive — the PDF path is untouched. Same credit cost.
async function generateCoverLetterTemplateDocx(req, res) {
    const userId = req.user.id;
    const { template, mode, coverLetterHtml, companyName, companyAddress } = req.body || {};
    try {
        const CL_DOWNLOAD_CREDIT_COST = await getEventCost('cover_letter_download');   // admin-configurable
        if (!coverLetterHtml || !String(coverLetterHtml).trim()) {
            return res.status(400).json({ error: 'No cover letter content. Generate a cover letter first.' });
        }
        const credit = await checkUserCredits(userId, CL_DOWNLOAD_CREDIT_COST);
        if (!credit.hasCredits) {
            return res.status(402).json({ error: credit.message, creditsRequired: CL_DOWNLOAD_CREDIT_COST, creditsRemaining: credit.remaining });
        }
        const tplId = clTemplates.TEMPLATE_IDS.includes(template) ? template : clTemplates.TEMPLATE_IDS[0];
        const sender = await buildCLSender(userId);
        const data = { sender, company: { name: companyName || '', address: companyAddress || '' }, bodyHtml: coverLetterHtml };
        const photo = await loadCLPhotoDataUri(userId).catch(() => null);

        const { buildCoverLetterDocx } = require('../utils/docxBuilder');
        const docxBuffer = await buildCoverLetterDocx(data, { template: tplId, photo });

        const safeCo = (companyName || 'Company').replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').slice(0, 40);
        const fileName = `Cover_Letter_${safeCo}_${Date.now()}.docx`;
        const tempDir = path.join(__dirname, '../../temp');
        await fs.mkdir(tempDir, { recursive: true });
        await fs.writeFile(path.join(tempDir, fileName), docxBuffer);

        try { await deductCredits(userId, CL_DOWNLOAD_CREDIT_COST, 'cover_letter_download', { template: tplId, format: 'docx' }); }
        catch (e) { console.warn('[coverLetter] credit deduction failed:', e.message); }

        return res.json({ success: true, downloadUrl: `/api/download-cover-letter-docx/${encodeURIComponent(fileName)}`, template: tplId, creditsRemaining: Math.max(0, credit.remaining - CL_DOWNLOAD_CREDIT_COST) });
    } catch (e) {
        console.error('[coverLetter] generateCoverLetterTemplateDocx error:', e.message);
        return res.status(500).json({ error: 'Failed to generate cover letter Word document. Please try again.' });
    }
}

// Point 6: enrich the cover-letter context with the user's Resume-Builder resume (if any),
// so letters have richer, more specific detail than the uploaded resume alone. Additive —
// returns the same metadata object untouched when no builder resume exists.
async function mergeBuilderResume(userId, resumeMetadata) {
    try {
        const row = await dbConfig.get('SELECT resume_data FROM user_resumes WHERE user_id = ?', [userId]);
        if (row && row.resume_data) {
            const rd = typeof row.resume_data === 'string' ? JSON.parse(row.resume_data) : row.resume_data;
            if (rd && typeof rd === 'object') {
                console.log(`[coverLetter] enriching context with Builder resume for user ${userId}`);
                return { ...resumeMetadata, builder_resume: rd };
            }
        }
    } catch (e) {
        console.warn('[coverLetter] mergeBuilderResume failed:', e.message);
    }
    return resumeMetadata;
}

// Reusable: build a cover-letter PDF for a given REGION and return { filePath, fileName }.
// Used by the email-send flow (point 3). Generic → the exact original branded letter;
// any other region → the recommended visual template for that region. No credits here.
async function buildCoverLetterPdfForRegion(userId, { region, coverLetterHtml, companyName, companyAddress, brandColor, websiteUrl, mode } = {}) {
    const rgn = region || 'generic';
    const tpls = clTemplates.templatesForRegion(rgn);
    const tplId = (tpls && tpls[0] && tpls[0].id) || clTemplates.TEMPLATE_IDS[0];
    const tplMeta = clTemplates.TEMPLATES.find(t => t.id === tplId);
    const tempDir = path.join(__dirname, '../../temp');
    await fs.mkdir(tempDir, { recursive: true });

    if (tplMeta && tplMeta.generic) {
        // Exact original branded letter (original PDFKit generator) — byte-for-byte the old file.
        const user  = await dbConfig.get('SELECT * FROM users WHERE id = ?', [userId]);
        const brand = brandColor || await lookupBrandColor(companyName, websiteUrl);
        const result = await generateRichCoverLetterPDF(user, coverLetterHtml, companyName || '', companyAddress || '', brand, null);
        return { filePath: result.filePath, fileName: result.fileName, template: tplId, generic: true };
    }

    const sender = await buildCLSender(userId);
    const data = { sender, company: { name: companyName || '', address: companyAddress || '' }, bodyHtml: coverLetterHtml };
    const pdf = await clRenderer.renderPdf(tplId, data, { mode: mode || 'a4' });
    const safeCo = (companyName || 'Company').replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').slice(0, 40);
    const fileName = `Cover_Letter_${safeCo}_${Date.now()}.pdf`;
    const filePath = path.join(tempDir, fileName);
    await fs.writeFile(filePath, pdf);
    return { filePath, fileName, template: tplId, generic: false };
}

module.exports = {
    generateCoverLetters,
    generateCoverLetterDetails,
    generateCoverLetterPdf,
    executeGenerationWork,
    previewCoverLetterTemplates,
    generateCoverLetterTemplatePdf,
    generateCoverLetterTemplateDocx,
    buildCoverLetterPdfForRegion
};
