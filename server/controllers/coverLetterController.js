const dbConfig = require('../../db-config');
const path = require('path');
const fs = require('fs').promises;
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { generateCoverLetter: generateCoverLetterV2 } = require('../../ai-cover-letter-v2');
const { notifyCoverLetterGenerated, notifyError } = require('./notificationsController');
const jobService = require('../services/jobService');
const { generateCoverLetterPDF: generateRichCoverLetterPDF } = require('./emailController');

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

        // CHECK CREDITS
        try {
            const creditCheck = await checkUserCredits(userId, recipients.length);
            if (!creditCheck.hasCredits) {
                return res.status(402).json({ 
                    error: creditCheck.message,
                    remainingCredits: creditCheck.remaining,
                    creditsRequired: recipients.length
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

            // Load resume metadata once for all recipients
            const resumeMetadata = await dbConfig.get(
                'SELECT * FROM resume_metadata WHERE user_id = ?',
                [userId]
            );

            if (!resumeMetadata) {
                return res.status(400).json({
                    error: 'Resume not processed yet',
                    message: 'Your resume is still being analyzed. Please wait a moment and try again.'
                });
            }

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
                        await deductCredits(userId, 1, 'cover_letter_generation', {
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
        const { recipientEmail, websiteUrl, position } = req.body;

        console.log(`\n📨 [${requestId}] Generate Cover Letter Details Request (${useAsync ? 'ASYNC' : 'SYNC'})`);
        console.log(`   User: ${userId}, Position: ${position}`);

        // CHECK CREDITS (always synchronous — fast DB check)
        try {
            const creditCheck = await checkUserCredits(userId, 1);
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
                recipientEmail, websiteUrl, position
            });
            console.log(`🚀 [${requestId}] Async job created: ${jobId}`);

            // Respond immediately with 202
            res.status(202).json({ jobId, status: 'pending' });

            // Fire and forget — process in background
            processGenerationJob(jobId, userId, { recipientEmail, websiteUrl, position }).catch(err => {
                console.error(`❌ [${requestId}] Async job ${jobId} failed:`, err.message);
                jobService.failJob(jobId, err.message).catch(console.error);
            });

        } else {
            // SYNC MODE: Original behavior — hold connection until done
            const result = await executeGenerationWork(userId, user, { recipientEmail, websiteUrl, position });

            const duration = Date.now() - startTime;
            console.log(`✅ [${requestId}] Response sent in ${duration}ms`);

            res.json(result);
        }

    } catch (error) {
        const duration = Date.now() - startTime;
        console.error(`❌ [${requestId}] Error (${duration}ms):`, error.message);
        res.status(500).json({ error: error.message || 'Failed to generate cover letter' });
    }
};

/**
 * The actual heavy generation work — used by both sync and async modes
 */
async function executeGenerationWork(userId, user, { recipientEmail, websiteUrl, position }) {
    // Normalize URL
    const normalizedWebsiteUrl = websiteUrl && websiteUrl.match(/^https?:\/\//) ? websiteUrl : `https://${websiteUrl}`;

    // Load pre-parsed resume metadata (generated by resumeParserService after upload)
    // Retry a few times in case the background parser is still running
    let resumeMetadata = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        resumeMetadata = await dbConfig.get(
            'SELECT * FROM resume_metadata WHERE user_id = ? AND parse_status = ?',
            [userId, 'done']
        );
        if (resumeMetadata) break;
        if (attempt < 2) await new Promise(r => setTimeout(r, 4000)); // wait 4s before retry
    }

    if (!resumeMetadata) {
        throw new Error('Resume not processed yet. Please wait a moment after uploading and try again.');
    }

    console.log(`[coverLetterController] Calling AI v2 for user ${userId}, url=${normalizedWebsiteUrl}, position=${position}`);

    // Single AI call: deep-researches the employer and generates the full letter
    const aiResult = await generateCoverLetterV2(resumeMetadata, normalizedWebsiteUrl, position);

    const companyName = aiResult.employer_name || normalizedWebsiteUrl;
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

    // Format markdown cover letter body as HTML
    const coverLetterHtml = formatCoverLetterWithHTML(aiResult.cover_letter || '', {});

    // DEDUCT CREDIT
    try {
        console.log(`💳 Deducting 1 credit from user ${userId}...`);
        await deductCredits(userId, 1, 'cover_letter_generation', {
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
        const { coverLetterHtml, companyName, companyAddress } = req.body;

        // Get user profile
        const user = await dbConfig.get('SELECT * FROM users WHERE id = ?', [userId]);
        
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Use the EXACT same PDF generator as the email attachment flow
        console.log('🖨️ [PDF DOWNLOAD] generateRichCoverLetterPDF type:', typeof generateRichCoverLetterPDF);
        console.log('🖨️ [PDF DOWNLOAD] companyName:', companyName, '| companyAddress:', companyAddress);
        console.log('🖨️ [PDF DOWNLOAD] html length:', coverLetterHtml?.length, '| preview:', coverLetterHtml?.slice(0, 80));
        const generateRichPDF = () => generateRichCoverLetterPDF(user, coverLetterHtml, companyName, companyAddress || '');

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

module.exports = {
    generateCoverLetters,
    generateCoverLetterDetails,
    generateCoverLetterPdf,
    executeGenerationWork
};
