const dbConfig = require('../../db-config');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const TemplateCoverLetterGenerator = require('../../template-cover-letter-generator');

const templateGenerator = new TemplateCoverLetterGenerator();
const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-key';

// Helper function: Create OAuth2 Client
function createOAuth2Client(user) {
    const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.NODE_ENV === 'production' 
            ? 'https://cvapplyr.com/auth/google/callback'
            : 'http://localhost:3000/auth/google/callback'
    );

    oauth2Client.setCredentials({
        access_token: user.google_access_token,
        refresh_token: user.google_refresh_token
    });

    return oauth2Client;
}

// Helper function: Generate professional email body
function generateEmailBody(position, companyName, userFullName) {
    return `Dear Hiring Manager,

I hope this email finds you well. I am writing to express my strong interest in the ${position} position at ${companyName}.

I have attached my resume and cover letter for your review. I believe my skills and experience make me a strong candidate for this role, and I would welcome the opportunity to discuss how I can contribute to your team.

Thank you for considering my application. I look forward to hearing from you.

Best regards,
${userFullName}`;
}

// Helper function: Send email via Gmail API
async function sendEmailViaGmail(user, recipientEmail, subject, emailBody, resumePath, coverLetterPdfBuffer) {
    try {
        const oauth2Client = createOAuth2Client(user);
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        
        // Create email message with attachments
        const boundary = 'boundary_' + Date.now();
        const nl = '\r\n';
        
        let message = [
            `To: ${recipientEmail}`,
            `From: ${user.email}`,
            `Subject: ${subject}`,
            'MIME-Version: 1.0',
            `Content-Type: multipart/mixed; boundary="${boundary}"`,
            '',
            `--${boundary}`,
            'Content-Type: text/plain; charset="UTF-8"',
            'Content-Transfer-Encoding: 7bit',
            '',
            emailBody,
            ''
        ].join(nl);
        
        // Attach resume if exists
        if (resumePath && fsSync.existsSync(resumePath)) {
            const resumeBuffer = await fs.readFile(resumePath);
            const resumeBase64 = resumeBuffer.toString('base64');
            const resumeFilename = path.basename(resumePath);
            
            message += [
                `--${boundary}`,
                'Content-Type: application/pdf',
                'Content-Transfer-Encoding: base64',
                `Content-Disposition: attachment; filename="${resumeFilename}"`,
                '',
                resumeBase64,
                ''
            ].join(nl);
        }
        
        // Attach cover letter PDF
        if (coverLetterPdfBuffer) {
            const coverLetterBase64 = coverLetterPdfBuffer.toString('base64');
            
            message += [
                `--${boundary}`,
                'Content-Type: application/pdf',
                'Content-Transfer-Encoding: base64',
                'Content-Disposition: attachment; filename="cover_letter.pdf"',
                '',
                coverLetterBase64,
                ''
            ].join(nl);
        }
        
        message += `--${boundary}--`;
        
        // Encode message to base64url
        const encodedMessage = Buffer.from(message)
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
        
        // Send email
        const result = await gmail.users.messages.send({
            userId: 'me',
            requestBody: {
                raw: encodedMessage
            }
        });
        
        console.log('Email sent via Gmail API:', result.data);
        return { success: true, messageId: result.data.id };
        
    } catch (error) {
        console.error('Error sending email via Gmail API:', error);
        
        // If access token expired, try to refresh
        if (error.code === 401 || error.message?.includes('invalid_grant')) {
            throw new Error('OAuth token expired. Please log in again.');
        }
        
        throw error;
    }
}

// Helper function: Create SMTP transporter
function createTransporter(smtpUser, smtpPass) {
    return nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: smtpUser,
            pass: smtpPass,
        },
    });
}

// Helper function: Decrypt data
function decryptData(encryptedText) {
    const crypto = require('crypto');
    const algorithm = 'aes-256-ctr';
    const encryptionKey = Buffer.from(process.env.ENCRYPTION_KEY || 'default-32-char-encryption-key!', 'utf8');
    
    if (encryptionKey.length !== 32) {
        throw new Error('Encryption key must be exactly 32 characters long');
    }

    const textParts = encryptedText.split(':');
    const iv = Buffer.from(textParts.shift(), 'hex');
    const encryptedData = Buffer.from(textParts.join(':'), 'hex');
    const decipher = crypto.createDecipheriv(algorithm, encryptionKey, iv);
    const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
    
    return decrypted.toString();
}

// Helper functions from coverLetterController
function formatCoverLetterWithHTML(coverLetterText, metadata) {
    let html = '';
    const paragraphs = coverLetterText.split('\n\n');
    
    paragraphs.forEach(para => {
        if (!para.trim()) return;
        
        // Replace **text** with <strong>text</strong> for bolding
        let formatted = para.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        
        // Wrap in paragraph tag
        html += `<p style="margin-bottom: 15px; line-height: 1.6;">${formatted}</p>`;
    });
    
    return html;
}

async function generateCoverLetterPDF(user, coverLetterHtmlOrText, companyName, companyAddress = '') {
    const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
    
    // Determine if input is HTML or plain text
    const isHtml = coverLetterHtmlOrText.includes('<') && coverLetterHtmlOrText.includes('>');
    
    // Extract plain text from HTML if needed
    let coverLetterText = coverLetterHtmlOrText;
    if (isHtml) {
        coverLetterText = coverLetterHtmlOrText
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/p>/gi, '\n\n')
            .replace(/<strong>/gi, '')
            .replace(/<\/strong>/gi, '')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ')
            .trim();
    }
    
    // Create PDF
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595.28, 841.89]); // A4 size
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
    
    // Body text with word wrapping
    const maxWidth = page.getWidth() - (margin * 2);
    const words = coverLetterText.split(/\s+/);
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
                const newPage = pdfDoc.addPage([595.28, 841.89]);
                yPosition = newPage.getHeight() - margin;
            }
        } else {
            line = testLine;
        }
    }
    
    // Draw remaining line
    if (line) {
        page.drawText(line, {
            x: margin,
            y: yPosition,
            size: fontSize,
            font: font
        });
        yPosition -= 25;
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

// Send applications (bulk)
const sendApplications = async (req, res) => {
    try {
        const userId = req.user.id;
        const { recipients } = req.body;

        console.log('\n📧 ============ SEND APPLICATIONS START ============');
        console.log('📧 [SEND] User ID:', userId);
        console.log('📧 [SEND] Recipients count:', recipients?.length || 0);

        if (!recipients || recipients.length === 0) {
            return res.status(400).json({ error: 'No recipients provided' });
        }

        // Get user profile
        const user = await dbConfig.get('SELECT * FROM users WHERE id = ?', [userId]);
        
        if (!user || !user.resume_path) {
            return res.status(400).json({ error: 'Resume is required' });
        }

        // Check if user has SMTP or use default from .env
        let smtpEmail, smtpPassword;
        
        if (user.smtp_email && user.smtp_password) {
            smtpEmail = user.smtp_email;
            smtpPassword = decryptData(user.smtp_password);
        } else if (process.env.SMTP_USER && process.env.SMTP_PASS) {
            smtpEmail = process.env.SMTP_USER;
            smtpPassword = process.env.SMTP_PASS;
        } else {
            return res.status(400).json({ 
                error: 'Email settings required. Please configure email in Settings.' 
            });
        }

        const transporter = createTransporter(smtpEmail, smtpPassword);
        const results = [];
        const emailSettings = {
            email: smtpEmail,
            name: user.sender_name || user.full_name || smtpEmail.split('@')[0]
        };

        const userData = {
            fullName: user.full_name,
            email: user.email,
            phoneNumber: user.phone_number,
            city: user.city,
            country: user.country
        };

        const resumePath = path.join(__dirname, '../../', user.resume_path);

        for (const recipient of recipients) {
            try {
                console.log(`\n📤 Processing: ${recipient.email}`);

                let filePath, fileName, companyName;

                // Check if cover letter was pre-generated
                if (recipient.fileName) {
                    fileName = recipient.fileName;
                    filePath = path.join(__dirname, '../../temp', fileName);
                    companyName = fileName.split('_')[2] || 'Company';
                    
                    try {
                        await fs.access(filePath);
                        console.log(`✅ Using pre-generated cover letter: ${fileName}`);
                    } catch {
                        throw new Error('Pre-generated cover letter not found');
                    }
                } else {
                    // Generate cover letter on the fly
                    const coverLetterResult = await templateGenerator.generateCoverLetter(
                        userData,
                        resumePath,
                        recipient.email,
                        recipient.website,
                        recipient.position || 'Position'
                    );

                    if (!coverLetterResult.success) {
                        throw new Error(`Cover letter generation failed: ${coverLetterResult.error}`);
                    }

                    companyName = coverLetterResult.companyName;
                    const coverLetterText = coverLetterResult.coverLetter;
                    
                    const coverLetterHtml = formatCoverLetterWithHTML(coverLetterText, coverLetterResult.metadata);
                    const pdfResult = await generateCoverLetterPDF(
                        user,
                        coverLetterHtml,
                        companyName,
                        ''
                    );
                    
                    filePath = pdfResult.filePath;
                    fileName = pdfResult.fileName;
                }

                const position = recipient.position || 'Position at your company';

                // Send email
                const mailOptions = {
                    from: `${emailSettings.name} <${emailSettings.email}>`,
                    to: recipient.email,
                    replyTo: user.email,
                    subject: `Application for ${position}`,
                    html: `
                        <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; line-height: 1.6; color: #333;">
                            <h2 style="color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 10px;">Dear Hiring Manager at ${companyName},</h2>
                            
                            <p style="font-size: 16px; margin: 20px 0;">
                                I'm excited to submit my application for the <strong>${position}</strong> role. 
                                Please find attached my personalized cover letter and resume.
                            </p>
                            
                            <p style="font-size: 16px; margin: 20px 0;">
                                I believe my background and skills align well with what ${companyName} is looking for.
                            </p>
                            
                            <div style="background: #f8f9fa; padding: 15px; border-left: 4px solid #3498db; margin: 25px 0;">
                                <p style="margin: 0; font-size: 14px;">
                                    📧 <strong>Email:</strong> ${user.email}<br>
                                    ${user.phone_number ? `📱 <strong>Phone:</strong> ${user.phone_number}<br>` : ''}
                                    ${user.city && user.country ? `📍 <strong>Location:</strong> ${user.city}, ${user.country}` : ''}
                                </p>
                            </div>
                            
                            <p style="font-size: 16px; margin: 20px 0;">
                                I'm looking forward to hearing from you!
                            </p>
                            
                            <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd;">
                                <p style="margin: 5px 0; font-size: 16px;"><strong>${userData.fullName}</strong></p>
                                <p style="margin: 5px 0; font-size: 14px; color: #666;">${user.email}</p>
                            </div>
                        </div>
                    `,
                    attachments: [
                        {
                            filename: fileName,
                            path: filePath,
                        },
                        {
                            filename: path.basename(resumePath),
                            path: resumePath,
                        }
                    ],
                };

                await transporter.sendMail(mailOptions);

                // Clean up temp PDF
                await fs.unlink(filePath);

                // Save to application history
                await dbConfig.run(
                    'INSERT INTO application_history (user_id, company_name, position, recipient_email, sent_date) VALUES (?, ?, ?, ?, ?)',
                    [userId, companyName, position, recipient.email, new Date().toISOString()]
                );

                results.push({
                    email: recipient.email,
                    company: companyName,
                    status: 'success',
                    message: 'Application sent successfully'
                });

                console.log(`✅ Email sent successfully to ${recipient.email}`);

            } catch (error) {
                console.error(`❌ Failed to send to ${recipient.email}:`, error.message);
                results.push({
                    email: recipient.email,
                    status: 'failed',
                    error: error.message,
                });
            }
        }

        const successCount = results.filter(r => r.status === 'success').length;
        
        // Update total_sent counter
        if (successCount > 0) {
            await dbConfig.run(
                'UPDATE users SET total_sent = total_sent + ? WHERE id = ?',
                [successCount, userId]
            );
        }
        
        res.json({
            success: true,
            message: `Sent to ${successCount}/${recipients.length} recipients`,
            results,
        });

    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({ error: error.message });
    }
};

// Send single application (from review page)
const sendSingleApplication = async (req, res) => {
    const userId = req.user.id;
    const { recipientEmail, websiteUrl, position, coverLetterText, companyName, companyAddress } = req.body;

    try {
        // Get user profile
        const user = await dbConfig.get('SELECT * FROM users WHERE id = ?', [userId]);
        
        if (!user || !user.resume_path) {
            return res.status(400).json({ error: 'Resume is required' });
        }

        // Generate PDF
        const { filePath, fileName } = await generateCoverLetterPDF(
            user,
            coverLetterText,
            companyName,
            companyAddress
        );

        const resumePath = path.join(__dirname, '../../', user.resume_path);
        const coverLetterPdfBuffer = await fs.readFile(filePath);

        // Generate email body and subject
        const emailBody = generateEmailBody(position, companyName, user.full_name);
        const subject = `Application for ${position} - ${user.full_name}`;

        // Priority 1: Try Gmail API if user logged in with OAuth
        if (user.oauth_provider === 'google' && user.google_access_token) {
            try {
                console.log('📧 Sending via Gmail API (OAuth)...');
                
                await sendEmailViaGmail(
                    user,
                    recipientEmail,
                    subject,
                    emailBody,
                    resumePath,
                    coverLetterPdfBuffer
                );

                console.log(`✅ Application sent via Gmail to ${recipientEmail}`);
                
                // Save to history
                await dbConfig.run(
                    'INSERT INTO application_history (user_id, company_name, position, recipient_email, sent_date) VALUES (?, ?, ?, ?, ?)',
                    [userId, companyName, position, recipientEmail, new Date().toISOString()]
                );

                await dbConfig.run(
                    'UPDATE users SET total_sent = total_sent + 1 WHERE id = ?',
                    [userId]
                );

                // Clean up
                await fs.unlink(filePath);

                return res.json({ 
                    success: true, 
                    message: 'Application sent successfully via Gmail',
                    method: 'gmail'
                });

            } catch (gmailError) {
                console.error('Gmail API error:', gmailError.message);
                
                if (gmailError.message.includes('OAuth token expired')) {
                    return res.status(401).json({ 
                        error: 'Your Gmail session has expired. Please log in again.',
                        requiresReauth: true
                    });
                }
                
                throw gmailError;
            }
        }

        // Priority 2: Use SMTP if configured
        if (user.smtp_email && user.smtp_password) {
            try {
                console.log('📧 Sending via SMTP...');
                
                const smtpPassword = decryptData(user.smtp_password);
                const transporter = createTransporter(user.smtp_email, smtpPassword);

                const mailOptions = {
                    from: `${user.sender_name || user.full_name} <${user.smtp_email}>`,
                    to: recipientEmail,
                    replyTo: user.email,
                    subject: subject,
                    text: emailBody,
                    attachments: [
                        {
                            filename: fileName,
                            path: filePath
                        },
                        {
                            filename: path.basename(resumePath),
                            path: resumePath
                        }
                    ]
                };

                await transporter.sendMail(mailOptions);

                // Save to history
                await dbConfig.run(
                    'INSERT INTO application_history (user_id, company_name, position, recipient_email, sent_date) VALUES (?, ?, ?, ?, ?)',
                    [userId, companyName, position, recipientEmail, new Date().toISOString()]
                );

                await dbConfig.run(
                    'UPDATE users SET total_sent = total_sent + 1 WHERE id = ?',
                    [userId]
                );

                // Clean up
                await fs.unlink(filePath);

                return res.json({ 
                    success: true, 
                    message: 'Application sent successfully via SMTP',
                    method: 'smtp'
                });

            } catch (smtpError) {
                console.error('SMTP error:', smtpError.message);
                throw smtpError;
            }
        }

        // No sending method available
        return res.status(400).json({ 
            error: 'No email sending method configured. Please set up SMTP or log in with Google.' 
        });

    } catch (error) {
        console.error('Send single application error:', error);
        res.status(500).json({ error: error.message || 'Failed to send application' });
    }
};

module.exports = {
    sendApplications,
    sendSingleApplication
};
