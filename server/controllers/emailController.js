const dbConfig = require('../../db-config');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const TemplateCoverLetterGenerator = require('../../template-cover-letter-generator');
const PDFKit = require('pdfkit');
const cheerio = require('cheerio');
const { sendEmailViaZeptoMail } = require('../services/zeptomailService');
const { notifyEmailSent, notifyError } = require('./notificationsController');

// Helper function to format DOB as YYYYMMDD for Reply-To email
function formatDOBForEmail(dateOfBirth) {
    if (!dateOfBirth) return null;
    // Use UTC methods to avoid timezone conversion issues
    const date = new Date(dateOfBirth);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}${month}${day}`;
}

const templateGenerator = new TemplateCoverLetterGenerator();
const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-key';

// Helper function: Create OAuth2 Client
function createOAuth2Client(user) {
    // Support both PKCE (mobile) and standard OAuth (web) flows
    // PKCE: No client secret, uses iOS OAuth client
    // Web: Uses client secret, uses Web OAuth client
    const isPkce = user.used_pkce === true || user.used_pkce === 1;
    
    const clientId = isPkce 
        ? process.env.GOOGLE_CLIENT_ID  // iOS OAuth Client
        : process.env.GOOGLE_WEB_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;  // Web OAuth Client
    
    const clientSecret = isPkce
        ? undefined  // PKCE doesn't use client secret
        : process.env.GOOGLE_WEB_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;  // Web needs client secret
    
    console.log('🔧 Creating OAuth2 client');
    console.log('   - Flow type:', isPkce ? 'PKCE (mobile)' : 'Standard OAuth (web)');
    console.log('   - Client ID:', clientId);
    console.log('   - Has client secret:', !!clientSecret);
    console.log('   - User ID:', user.id);
    console.log('   - Has access token:', !!user.google_access_token);
    console.log('   - Has refresh token:', !!user.google_refresh_token);
    
    const oauth2Client = new google.auth.OAuth2(
        clientId,
        clientSecret,
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
        
        // If refresh token is invalid, clear it from database
        if (error.code === 401 || error.message?.includes('invalid_grant') || error.response?.data?.error === 'invalid_grant') {
            console.log('❌ OAuth refresh token is invalid. Clearing tokens from database...');
            
            // Clear the invalid tokens
            await dbConfig.run(
                'UPDATE users SET google_access_token = NULL, google_refresh_token = NULL WHERE id = ?',
                [user.id]
            );
            
            console.log('✅ Cleared invalid OAuth tokens. User must re-authenticate.');
            throw new Error('OAuth token expired. Please log out and log in again with Google.');
        }
        
        throw error;
    }
}

// Helper function: Send email via Microsoft Graph API
async function sendEmailViaMicrosoft(user, recipientEmail, subject, emailBody, resumePath, coverLetterPdfBuffer) {
    try {
        const accessToken = user.microsoft_access_token;
        
        if (!accessToken) {
            throw new Error('No Microsoft access token available');
        }

        // Read and encode attachments
        const attachments = [];
        
        // Attach resume if exists
        if (resumePath && fsSync.existsSync(resumePath)) {
            const resumeBuffer = await fs.readFile(resumePath);
            const resumeBase64 = resumeBuffer.toString('base64');
            const resumeFilename = path.basename(resumePath);
            
            attachments.push({
                '@odata.type': '#microsoft.graph.fileAttachment',
                name: resumeFilename,
                contentType: 'application/pdf',
                contentBytes: resumeBase64
            });
        }
        
        // Attach cover letter PDF
        if (coverLetterPdfBuffer) {
            const coverLetterBase64 = coverLetterPdfBuffer.toString('base64');
            
            attachments.push({
                '@odata.type': '#microsoft.graph.fileAttachment',
                name: 'cover_letter.pdf',
                contentType: 'application/pdf',
                contentBytes: coverLetterBase64
            });
        }

        // Prepare email message for Microsoft Graph API
        const message = {
            message: {
                subject: subject,
                body: {
                    contentType: 'Text',
                    content: emailBody
                },
                toRecipients: [
                    {
                        emailAddress: {
                            address: recipientEmail
                        }
                    }
                ],
                attachments: attachments
            }
        };

        // Send email via Microsoft Graph API
        const response = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(message)
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            console.error('Microsoft Graph API error:', errorData);
            
            // Handle token expiration
            if (response.status === 401 || errorData.error?.code === 'InvalidAuthenticationToken') {
                console.log('❌ Microsoft OAuth token is invalid. Clearing tokens from database...');
                
                // Clear the invalid tokens
                await dbConfig.run(
                    'UPDATE users SET microsoft_access_token = NULL, microsoft_refresh_token = NULL WHERE id = ?',
                    [user.id]
                );
                
                console.log('✅ Cleared invalid Microsoft OAuth tokens. User must re-authenticate.');
                throw new Error('Microsoft OAuth token expired. Please log out and log in again with Microsoft.');
            }
            
            throw new Error(`Microsoft Graph API error: ${errorData.error?.message || response.statusText}`);
        }

        console.log('✅ Email sent successfully via Microsoft Graph API');
        return { success: true };
        
    } catch (error) {
        console.error('❌ Error sending email via Microsoft Graph API:', error);
        throw error;
    }
}

// Helper function: Create SMTP transporter
function createTransporter(smtpUser, smtpPass) {
    return nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: process.env.SMTP_PORT === '465', // Use SSL for port 465
        auth: {
            user: smtpUser,
            pass: smtpPass,
        },
        // Anti-spam settings - relaxed for Railway
        tls: {
            rejectUnauthorized: false, // Allow self-signed certificates for cloud platforms
            minVersion: 'TLSv1.2'
        },
        pool: true, // Use connection pool for better reputation
        maxConnections: 5,
        maxMessages: 100,
        // Add timeouts to prevent hanging
        connectionTimeout: 30000, // 30 seconds
        greetingTimeout: 30000,
        socketTimeout: 60000, // 60 seconds
        debug: true, // Enable debug logging
        logger: true // Enable logging
    });
}

// Helper function: Send email with timeout
async function sendEmailWithTimeout(transporter, mailOptions, timeoutMs = 60000) {
    return Promise.race([
        transporter.sendMail(mailOptions),
        new Promise((_, reject) => 
            setTimeout(() => reject(new Error(`Email sending timeout after ${timeoutMs/1000} seconds`)), timeoutMs)
        )
    ]);
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

async function createCoverLetterPDFFromHTML(userData, coverLetterHtml, companyName, companyAddress, photoPath, signaturePath) {
    console.log('\n');
    console.log('═══════════════════════════════════════════════════════');
    console.log('📄 createCoverLetterPDFFromHTML CALLED');
    console.log('═══════════════════════════════════════════════════════');
    console.log('companyName:', companyName);
    console.log('companyAddress:', companyAddress);
    console.log('companyAddress length:', companyAddress?.length);
    console.log('companyAddress is empty?:', !companyAddress);
    console.log('═══════════════════════════════════════════════════════\n');
    
    return new Promise(async (resolve, reject) => {
        try {
            const currentDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
            const timestamp = Date.now(); // Add millisecond timestamp for uniqueness
            const sanitizedCompanyName = companyName.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
            const fileName = `Cover_Letter_${currentDate}_${sanitizedCompanyName}_${timestamp}.pdf`;
            const filePath = path.join(__dirname, '../../temp', fileName);
            
            await fs.mkdir(path.join(__dirname, '../../temp'), { recursive: true });
            
            // First, calculate the required height by parsing content
            const $ = cheerio.load(coverLetterHtml);
            const bodyHtml = $('body').html() || coverLetterHtml;
            const paragraphs = bodyHtml.split(/<br\s*\/?>/gi);
            
            // Estimate content height
            const pageWidth = 595;
            const sidebarWidth = 180;
            const contentWidth = pageWidth - sidebarWidth - 80;
            const lineHeight = 14;
            const fontSize = 10;
            
            // Calculate approximate height needed for content
            let estimatedContentHeight = 50; // Starting Y
            estimatedContentHeight += 25; // Name
            estimatedContentHeight += 25; // Designation
            estimatedContentHeight += 30; // Separator
            estimatedContentHeight += 30; // Cover Letter heading
            estimatedContentHeight += 25; // Dear Hiring Manager
            
            // Estimate paragraph heights (rough calculation)
            for (const paraHtml of paragraphs) {
                const plainText = cheerio.load(`<div>${paraHtml}</div>`).text().trim();
                if (!plainText) continue;
                
                // Estimate lines needed (approx 80 chars per line at font size 10)
                const charsPerLine = 75;
                const numLines = Math.ceil(plainText.length / charsPerLine);
                estimatedContentHeight += (numLines * lineHeight) + 10; // + paragraph spacing
            }
            
            estimatedContentHeight += 10; // Before closing
            estimatedContentHeight += 30; // Best regards
            if (signaturePath) estimatedContentHeight += 50; // Signature
            estimatedContentHeight += 30; // Name
            estimatedContentHeight += 50; // Bottom margin
            
            // Ensure minimum height for sidebar content
            const minHeight = 600;
            const pageHeight = Math.max(minHeight, estimatedContentHeight);
            
            // Create PDF with calculated size - autoFirstPage false to control page creation
            const doc = new PDFKit({
                size: [pageWidth, pageHeight],
                margins: { top: 0, bottom: 0, left: 0, right: 0 },
                autoFirstPage: false
            });
            
            // Add single page with exact size
            doc.addPage({ size: [pageWidth, pageHeight], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
            
            const writeStream = fsSync.createWriteStream(filePath);
            doc.pipe(writeStream);
            
            // Register fonts
            const latoRegularPath = path.join(__dirname, '../../fonts', 'Lato-Regular.ttf');
            const latoBoldPath = path.join(__dirname, '../../fonts', 'Lato-Bold.ttf');
            
            doc.registerFont('Lato', latoRegularPath);
            doc.registerFont('Lato-Bold', latoBoldPath);
            
            // LEFT SIDEBAR (dark background) - full height
            doc.rect(0, 0, sidebarWidth, pageHeight).fill('#262633');
            
            // Photo/Initials circle at top
            const photoX = sidebarWidth / 2;
            const photoY = 70;
            const photoSize = 80;
            
            if (photoPath) {
                try {
                    doc.image(photoPath, photoX - photoSize/2, photoY - photoSize/2, {
                        width: photoSize,
                        height: photoSize
                    });
                } catch (e) {
                    // Draw initials circle if photo fails
                    doc.circle(photoX, photoY, photoSize/2).stroke('#ffffff');
                    const initials = userData.fullName ? userData.fullName.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) : 'RS';
                    doc.font('Lato-Bold').fontSize(24).fillColor('#ffffff');
                    doc.text(initials, photoX - 20, photoY - 12, { width: 40, align: 'center' });
                }
            } else {
                doc.circle(photoX, photoY, photoSize/2).lineWidth(2).stroke('#ffffff');
                const initials = userData.fullName ? userData.fullName.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) : 'RS';
                doc.font('Lato-Bold').fontSize(24).fillColor('#ffffff');
                doc.text(initials, photoX - 20, photoY - 12, { width: 40, align: 'center' });
            }
            
            let sidebarY = photoY + photoSize/2 + 40;
            
            // TO section
            doc.font('Lato-Bold').fontSize(11).fillColor('#ffffff');
            doc.text('TO', 20, sidebarY);
            sidebarY += 20;
            
            doc.font('Lato').fontSize(10).fillColor('#ffffff');
            doc.text('Hiring Manager,', 20, sidebarY);
            sidebarY += 16;
            
            // Company name (bold)
            doc.font('Lato-Bold').fontSize(11).fillColor('#ffffff');
            doc.text(companyName, 20, sidebarY, { width: sidebarWidth - 40 });
            sidebarY += doc.heightOfString(companyName, { width: sidebarWidth - 40 }) + 4;
            
            // Company address
            if (companyAddress) {
                doc.font('Lato').fontSize(10).fillColor('#ffffff');
                doc.text(companyAddress, 20, sidebarY, { width: sidebarWidth - 40 });
                sidebarY += doc.heightOfString(companyAddress, { width: sidebarWidth - 40 }) + 4;
            }
            
            sidebarY += 10;
            
            // Separator line
            doc.moveTo(20, sidebarY).lineTo(sidebarWidth - 20, sidebarY).lineWidth(0.5).stroke('#808080');
            sidebarY += 20;
            
            // FROM section
            doc.font('Lato-Bold').fontSize(11).fillColor('#ffffff');
            doc.text('FROM', 20, sidebarY);
            sidebarY += 20;
            
            doc.font('Lato').fontSize(10).fillColor('#ffffff');
            doc.text((userData.fullName || 'Applicant').toUpperCase(), 20, sidebarY, { width: sidebarWidth - 40 });
            sidebarY += 20;
            
            sidebarY += 10;
            
            // Separator line
            doc.moveTo(20, sidebarY).lineTo(sidebarWidth - 20, sidebarY).lineWidth(0.5).stroke('#808080');
            sidebarY += 20;
            
            // DATE section
            const today = new Date();
            const dateStr = today.toLocaleDateString('en-US', { 
                month: 'short', 
                day: '2-digit', 
                year: 'numeric' 
            }).replace(',', '');
            
            doc.font('Lato-Bold').fontSize(11).fillColor('#ffffff');
            doc.text('DATE', 20, sidebarY);
            sidebarY += 20;
            
            doc.font('Lato').fontSize(10).fillColor('#ffffff');
            doc.text(dateStr, 20, sidebarY);
            
            // Contact info at bottom of sidebar (positioned relative to page height)
            const contactY = pageHeight - 80;
            doc.font('Lato').fontSize(8).fillColor('#ffffff');
            if (userData.email) {
                doc.text(userData.email, 20, contactY, { lineBreak: false });
            }
            if (userData.phoneNumber) {
                doc.text(userData.phoneNumber, 20, contactY + 12, { lineBreak: false });
            }
            if (userData.city) {
                doc.text(userData.city, 20, contactY + 24, { lineBreak: false });
            }
            if (userData.country) {
                doc.text(userData.country, 20, contactY + 36, { lineBreak: false });
            }
            
            // RIGHT CONTENT AREA
            const contentX = sidebarWidth + 40;
            let contentY = 50;
            
            // Header with name
            doc.font('Lato-Bold').fontSize(18).fillColor('#000000');
            doc.text((userData.fullName || 'APPLICANT').toUpperCase(), contentX, contentY, { lineBreak: false });
            
            // Contact details on right
            doc.font('Lato').fontSize(9).fillColor('#4d4d4d');
            const rightX = pageWidth - 40;
            if (userData.city && userData.country) {
                const locationText = `${userData.city}, ${userData.country}`;
                doc.text(locationText, rightX - doc.widthOfString(locationText), contentY, { lineBreak: false });
            }
            if (userData.phoneNumber) {
                doc.text(userData.phoneNumber, rightX - doc.widthOfString(userData.phoneNumber), contentY + 15, { lineBreak: false });
            }
            if (userData.email) {
                doc.text(userData.email, rightX - doc.widthOfString(userData.email), contentY + 30, { lineBreak: false });
            }
            
            contentY += 25;
            
            // Designation
            doc.font('Lato').fontSize(11).fillColor('#666666');
            doc.text('Project Manager', contentX, contentY, { lineBreak: false });
            
            contentY += 25;
            
            // Separator line
            doc.moveTo(contentX, contentY).lineTo(pageWidth - 40, contentY).lineWidth(1).stroke('#cccccc');
            
            contentY += 30;
            
            // "Cover Letter" heading
            doc.font('Lato-Bold').fontSize(14).fillColor('#333333');
            doc.text('Cover Letter', contentX, contentY, { lineBreak: false });
            
            contentY += 30;
            
            // Opening
            doc.font('Lato').fontSize(10).fillColor('#000000');
            doc.text('Dear Hiring Manager,', contentX, contentY, { width: contentWidth });
            contentY += 25;
            
            // Helper function to extract text segments with bold info
            function extractTextSegments(node, segments, inheritBold = false) {
                if (node.type === 'text') {
                    const text = node.data;
                    if (text) {
                        segments.push({ text: text, bold: inheritBold });
                    }
                } else if (node.type === 'tag') {
                    const isBold = inheritBold || node.name === 'strong' || node.name === 'b';
                    if (node.children) {
                        node.children.forEach(child => {
                            extractTextSegments(child, segments, isBold);
                        });
                    }
                }
            }
            
            // Process paragraphs for rendering (already parsed above)
            for (const paraHtml of paragraphs) {
                // Parse this paragraph for bold/regular segments
                const $para = cheerio.load(`<div>${paraHtml}</div>`);
                const segments = [];
                
                $para('div').contents().each((i, elem) => {
                    extractTextSegments(elem, segments, false);
                });
                
                // If no segments found, try plain text
                if (segments.length === 0) {
                    const plainText = $para.text().trim();
                    if (plainText) {
                        segments.push({ text: plainText, bold: false });
                    }
                }
                
                if (segments.length === 0) continue;
                
                // Render segments with proper formatting
                let currentX = contentX;
                let lineStartY = contentY;
                const maxX = contentX + contentWidth;
                
                for (const segment of segments) {
                    const fontName = segment.bold ? 'Lato-Bold' : 'Lato';
                    doc.font(fontName).fontSize(10).fillColor('#000000');
                    
                    // Split text into words
                    const words = segment.text.split(/(\s+)/);
                    
                    for (const word of words) {
                        if (!word) continue;
                        
                        // Skip leading spaces at the start of a new line
                        if (currentX === contentX && /^\s+$/.test(word)) {
                            continue;
                        }
                        
                        const wordWidth = doc.widthOfString(word);
                        
                        // Check if word fits on current line
                        if (currentX + wordWidth > maxX && currentX > contentX) {
                            // Move to next line
                            currentX = contentX;
                            lineStartY += lineHeight;
                            
                            // Skip this word if it's just whitespace (don't render space at line start)
                            if (/^\s+$/.test(word)) {
                                continue;
                            }
                        }
                        
                        // Draw the word
                        doc.text(word, currentX, lineStartY, { lineBreak: false, continued: false });
                        currentX += wordWidth;
                    }
                }
                
                contentY = lineStartY + lineHeight + 10;
            }
            
            // Closing
            contentY += 10;
            doc.font('Lato').fontSize(10).fillColor('#000000');
            doc.text('Best regards,', contentX, contentY, { width: contentWidth });
            contentY += 30;
            
            // Signature
            if (signaturePath) {
                try {
                    doc.image(signaturePath, contentX, contentY, { width: 120, height: 40 });
                    contentY += 50;
                } catch (e) {
                    console.log('Could not embed signature');
                }
            }
            
            // Name
            doc.font('Lato-Bold').fontSize(10).fillColor('#000000');
            doc.text((userData.fullName || 'APPLICANT').toUpperCase(), contentX, contentY);
            
            // Finalize PDF
            doc.end();
            
            writeStream.on('finish', () => {
                console.log(`✅ PDF created with PDFKit: ${fileName}`);
                resolve({ filePath, fileName });
            });
            
            writeStream.on('error', (err) => {
                reject(err);
            });
            
        } catch (error) {
            reject(error);
        }
    });
}

// TWO-COLUMN cover letter PDF generator (like Cover_Letter_Google_New.pdf from Dec 4)
async function generateCoverLetterPDF(user, coverLetterHtmlOrText, companyName, companyAddress = '') {
    console.log('\n📄 [COMMON] Generating PDF with:');
    console.log('  User:', user.email);
    console.log('  Company:', companyName);
    console.log('  Address:', companyAddress);
    console.log('  Content length:', coverLetterHtmlOrText?.length);
    console.log('  Content type:', coverLetterHtmlOrText?.includes('<') ? 'HTML' : 'TEXT');
    
    // Prepare user data
    const userData = {
        fullName: user.full_name,
        email: user.email,
        phoneNumber: user.phone_number,
        city: user.city,
        country: user.country
    };

    // Get photo and signature paths
    const photoPath = user.photo_path ? path.join(__dirname, '../..', user.photo_path) : null;
    const signaturePath = user.signature_path ? path.join(__dirname, '../..', user.signature_path) : null;

    // CRITICAL FIX: Convert markdown **bold** to HTML <strong>bold</strong>
    // Mobile sends plain text with **markdown**, web sends HTML
    // Ensure consistent HTML format for PDF generation
    let coverLetterHtml = coverLetterHtmlOrText;
    
    // If text contains **markdown** but no HTML tags, convert markdown to HTML
    if (!coverLetterHtml.includes('<p>') && !coverLetterHtml.includes('<div>')) {
        console.log('  📝 Converting plain text with markdown to HTML...');
        
        // Split by double newlines for paragraphs
        const paragraphs = coverLetterHtml.split('\n\n').filter(p => p.trim());
        
        coverLetterHtml = paragraphs.map(para => {
            // Convert **text** to <strong>text</strong>
            let formatted = para.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
            // Wrap in paragraph tag
            return `<p>${formatted}</p>`;
        }).join('');
        
        console.log('  ✅ Converted to HTML with bold tags');
    } else {
        console.log('  ✅ Already HTML format');
    }

    // Generate PDF using HTML-based method (supports bold formatting)
    const { filePath, fileName } = await createCoverLetterPDFFromHTML(
        userData,
        coverLetterHtml,
        companyName,
        companyAddress || '',
        photoPath,
        signaturePath
    );

    console.log(`✅ [COMMON] PDF generated: ${fileName} at ${filePath}\n`);
    
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
        
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        if (!user.resume_path || user.resume_path.trim() === '') {
            // Create notification for missing resume
            await notifyError(
                userId,
                'Resume Required',
                'Please upload your resume before sending applications. Go to Profile (top right) to upload your resume.',
                'upload_resume'
            );
            
            return res.status(400).json({ 
                error: 'Resume required',
                message: 'Please upload your resume before sending applications. Go to Profile (top right) to upload your resume.',
                action: 'upload_resume'
            });
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
                    // Use address from recipient if provided (from web/mobile dropdown), otherwise empty
                    const companyAddress = recipient.companyAddress || '';
                    const coverLetterText = coverLetterResult.coverLetter;
                    
                    const coverLetterHtml = formatCoverLetterWithHTML(coverLetterText, coverLetterResult.metadata);
                    const pdfResult = await generateCoverLetterPDF(
                        user,
                        coverLetterHtml,
                        companyName,
                        companyAddress
                    );
                    
                    filePath = pdfResult.filePath;
                    fileName = pdfResult.fileName;
                }

                const position = recipient.position || 'Position at your company';
                const subject = `Application for ${position} - ${userData.fullName}`;
                const emailBody = generateEmailBody(position, companyName, user.full_name);

                // Read cover letter PDF buffer (needed for OAuth APIs)
                const coverLetterPdfBuffer = await fs.readFile(filePath);

                // DEBUG: Check user OAuth status
                console.log('🔍 [DEBUG] OAuth Status:');
                console.log('   - oauth_provider:', user.oauth_provider);
                console.log('   - google_access_token:', user.google_access_token ? 'EXISTS' : 'NULL');
                console.log('   - google_refresh_token:', user.google_refresh_token ? 'EXISTS' : 'NULL');
                console.log('   - microsoft_access_token:', user.microsoft_access_token ? 'EXISTS' : 'NULL');

                // Priority 1: Try Microsoft Graph API if user logged in with Microsoft OAuth
                let emailSentViaOAuth = false;
                if (user.oauth_provider === 'microsoft' && user.microsoft_access_token) {
                    try {
                        console.log('📧 Sending via Microsoft Graph API (OAuth)...');
                        
                        await sendEmailViaMicrosoft(
                            user,
                            recipient.email,
                            subject,
                            emailBody,
                            resumePath,
                            coverLetterPdfBuffer
                        );

                        console.log(`✅ Email sent via Microsoft to ${recipient.email}`);
                        emailSentViaOAuth = true;

                    } catch (microsoftError) {
                        console.error('❌ Microsoft Graph API error:', microsoftError.message);
                        console.log('⚠️ Microsoft Graph API failed, will try SMTP fallback...');
                        // Fall through to SMTP
                    }
                }

                // Priority 2: Try Gmail API if user logged in with Google OAuth
                if (!emailSentViaOAuth && user.oauth_provider === 'google' && user.google_access_token) {
                    try {
                        console.log('📧 Sending via Gmail API (OAuth)...');
                        
                        await sendEmailViaGmail(
                            user,
                            recipient.email,
                            subject,
                            emailBody,
                            resumePath,
                            coverLetterPdfBuffer
                        );

                        console.log(`✅ Email sent via Gmail to ${recipient.email}`);
                        emailSentViaOAuth = true;

                    } catch (gmailError) {
                        console.error('❌ Gmail API error:', gmailError.message);
                        console.log('⚠️ Gmail API failed, will try SMTP fallback...');
                        // Fall through to SMTP
                    }
                }

                // Priority 3: Use SMTP if OAuth not available or failed
                if (!emailSentViaOAuth) {
                    console.log('📧 Sending via SMTP...');
                    
                    // Use plus addressing for Reply-To: cv+email.dob@cvapplyr.com routes to cv@cvapplyr.com but tracks user
                    const emailUsername = user.email.split('@')[0];
                    const dobFormatted = formatDOBForEmail(user.date_of_birth);
                    const replyToEmail = dobFormatted 
                        ? `${emailSettings.email.split('@')[0]}+${emailUsername}.${dobFormatted}@${emailSettings.email.split('@')[1]}`
                        : emailSettings.email; // Fallback if no DOB
                    const mailOptions = {
                        from: `${emailSettings.name} <${emailSettings.email}>`,
                        to: recipient.email,
                        replyTo: replyToEmail, // e.g., cv+user1@cvapplyr.com
                        subject: subject,
                        // Anti-spam headers
                        headers: {
                            'X-Mailer': 'Lettrico Job Application System',
                            'X-Priority': '3',
                            'Importance': 'Normal',
                            'List-Unsubscribe': `<mailto:${emailSettings.email}?subject=unsubscribe>`,
                        },
                        text: `Dear Hiring Manager at ${companyName},\n\nI'm excited to submit my application for the ${position} role. Please find attached my personalized cover letter and resume.\n\nI believe my background and skills align well with what ${companyName} is looking for.\n\nDirect Contact Information:\nEmail: ${user.email}\n${user.phone_number ? `Phone: ${user.phone_number}\n` : ''}${user.city && user.country ? `Location: ${user.city}, ${user.country}\n` : ''}\n\nPlease feel free to reach me directly at ${user.email} for any questions or to schedule an interview.\n\nI'm looking forward to hearing from you!\n\nBest regards,\n${userData.fullName}\n${user.email}`,
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
                                        📧 <strong>Direct Email:</strong> <a href="mailto:${user.email}" style="color: #3498db; text-decoration: none;">${user.email}</a><br>
                                        ${user.phone_number ? `📱 <strong>Phone:</strong> ${user.phone_number}<br>` : ''}
                                        ${user.city && user.country ? `📍 <strong>Location:</strong> ${user.city}, ${user.country}` : ''}
                                    </p>
                                </div>
                                
                                <p style="font-size: 16px; margin: 20px 0;">
                                    Please feel free to reach me directly at <a href="mailto:${user.email}" style="color: #3498db; text-decoration: none;">${user.email}</a> for any questions or to schedule an interview.
                                </p>
                                
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

                    await sendEmailWithTimeout(transporter, mailOptions);
                    console.log(`✅ Email sent via SMTP to ${recipient.email}`);
                }

                // Clean up temp PDF
                await fs.unlink(filePath);

                // Update counter only (history is managed by web app locally)
                // Web app doesn't sync to backend like mobile, but we still track counter
                await dbConfig.run(
                    'UPDATE users SET total_sent = total_sent + 1 WHERE id = ?',
                    [userId]
                );

                // Record in application_history for usage stats (web sends need this)
                try {
                    await dbConfig.run(
                        'INSERT INTO application_history (user_id, company_name, position, recipient_email, sent_date, reply_received, reply_date) VALUES (?, ?, ?, ?, ?, ?, ?)',
                        [userId, companyName || '', position || '', recipient.email || '', new Date().toISOString(), 0, null]
                    );
                } catch (historyError) {
                    console.error('Failed to save to application_history:', historyError);
                }

                // Create notification for sent email
                try {
                    await notifyEmailSent(userId, companyName, recipient.email, position, subject);
                } catch (notifError) {
                    console.error('Failed to create notification:', notifError);
                }

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

    console.log('\n=== SEND SINGLE APPLICATION DEBUG ===');
    console.log('User ID:', userId);
    console.log('Recipient:', recipientEmail);
    console.log('Company:', companyName);
    console.log('Company Address:', companyAddress);
    console.log('Cover Letter Length:', coverLetterText?.length);
    console.log('Cover Letter (first 200 chars):', coverLetterText?.substring(0, 200));

    try {
        // CRITICAL VALIDATION: Ensure cover letter text is not empty or generic
        if (!coverLetterText || coverLetterText.trim().length < 100) {
            console.error('❌ CRITICAL: Cover letter text is missing or too short!');
            return res.status(400).json({ error: 'Cover letter is required. Please generate a cover letter first.' });
        }

        // CRITICAL VALIDATION: Check for generic/template content that indicates generation failure
        const bannedPhrases = [
            'I am writing to express my profound interest',
            'How My Experience Directly Matches Your Requirements',
            'My Value Proposition to',
            '0 years of dedicated experience',
            'With over 0 years'
        ];
        
        for (const phrase of bannedPhrases) {
            if (coverLetterText.toLowerCase().includes(phrase.toLowerCase())) {
                console.error(`❌ CRITICAL: Cover letter contains banned generic phrase: "${phrase}"`);
                console.error('This indicates AI generation failed and fell back to a template.');
                return res.status(400).json({ 
                    error: `Cover letter quality check failed. The letter appears to be generated from a template rather than personalized AI content. Please regenerate the cover letter. Detected phrase: "${phrase}"` 
                });
            }
        }

        // Get user profile
        const user = await dbConfig.get('SELECT * FROM users WHERE id = ?', [userId]);
        
        console.log('User found:', !!user);
        console.log('User OAuth provider:', user?.oauth_provider);
        console.log('User has Google access token:', !!user?.google_access_token);
        console.log('User has SMTP email:', !!user?.smtp_email);
        console.log('User has SMTP password:', !!user?.smtp_password);
        console.log('ENV SMTP_USER:', process.env.SMTP_USER ? 'SET' : 'NOT SET');
        console.log('ENV SMTP_PASS:', process.env.SMTP_PASS ? 'SET' : 'NOT SET');
        console.log('=====================================\n');
        
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        if (!user.resume_path || user.resume_path.trim() === '') {
            // Create notification for missing resume
            await notifyError(
                userId,
                'Resume Required',
                'Please upload your resume before sending applications. Go to Profile (top right) to upload your resume.',
                'upload_resume'
            );
            
            return res.status(400).json({ 
                error: 'Resume required',
                message: 'Please upload your resume before sending applications. Go to Profile (top right) to upload your resume.',
                action: 'upload_resume'
            });
        }

        // Generate PDF
        console.log('📄 Generating PDF with address:', companyAddress || 'NO ADDRESS PROVIDED');
        const { filePath, fileName } = await generateCoverLetterPDF(
            user,
            coverLetterText,
            companyName,
            companyAddress
        );
        console.log('✅ PDF generated:', fileName);

        const resumePath = path.join(__dirname, '../../', user.resume_path);
        const coverLetterPdfBuffer = await fs.readFile(filePath);

        // Generate email body and subject
        const emailBody = generateEmailBody(position, companyName, user.full_name);
        const subject = `Application for ${position} - ${user.full_name}`;

        // Priority 1: Try Microsoft Graph API if user logged in with Microsoft OAuth
        if (user.oauth_provider === 'microsoft' && user.microsoft_access_token) {
            try {
                console.log('📧 Sending via Microsoft Graph API (OAuth)...');
                
                await sendEmailViaMicrosoft(
                    user,
                    recipientEmail,
                    subject,
                    emailBody,
                    resumePath,
                    coverLetterPdfBuffer
                );

                console.log(`✅ Application sent via Microsoft to ${recipientEmail}`);
                
                // Update counter only (history is managed by mobile app)
                await dbConfig.run(
                    'UPDATE users SET total_sent = total_sent + 1 WHERE id = ?',
                    [userId]
                );

                // Record in application_history for usage stats
                try {
                    await dbConfig.run(
                        'INSERT INTO application_history (user_id, company_name, position, recipient_email, sent_date, reply_received, reply_date) VALUES (?, ?, ?, ?, ?, ?, ?)',
                        [userId, companyName || '', position || '', recipientEmail || '', new Date().toISOString(), 0, null]
                    );
                } catch (historyError) {
                    console.error('Failed to save to application_history:', historyError);
                }

                // Create notification for sent email
                try {
                    await notifyEmailSent(userId, companyName, recipientEmail, position, subject);
                } catch (notifError) {
                    console.error('Failed to create notification:', notifError);
                }

                // Clean up
                await fs.unlink(filePath);

                return res.json({ 
                    success: true, 
                    message: 'Application sent successfully via Microsoft',
                    method: 'microsoft'
                });

            } catch (microsoftError) {
                console.error('❌ Microsoft Graph API error:', microsoftError.message);
                console.log('⚠️ Microsoft Graph API failed, will try SMTP fallback...');
                
                // Don't return error here - let it fall through to SMTP
                // Only return if it's specifically asking for re-auth
                if (microsoftError.message.includes('OAuth token expired')) {
                    console.log('⚠️ Microsoft OAuth tokens expired, attempting SMTP fallback...');
                }
                // Fall through to next priority (Gmail or SMTP)
            }
        }

        // Priority 2: Try Gmail API if user logged in with OAuth
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
                
                // Update counter only (history is managed by mobile app)
                await dbConfig.run(
                    'UPDATE users SET total_sent = total_sent + 1 WHERE id = ?',
                    [userId]
                );

                // Record in application_history for usage stats (web sends need this)
                try {
                    await dbConfig.run(
                        'INSERT INTO application_history (user_id, company_name, position, recipient_email, sent_date, reply_received, reply_date) VALUES (?, ?, ?, ?, ?, ?, ?)',
                        [userId, companyName || '', position || '', recipientEmail || '', new Date().toISOString(), 0, null]
                    );
                } catch (historyError) {
                    console.error('Failed to save to application_history:', historyError);
                }

                // Create notification for sent email
                try {
                    await notifyEmailSent(userId, companyName, recipientEmail, position, subject);
                } catch (notifError) {
                    console.error('Failed to create notification:', notifError);
                }

                // Clean up
                await fs.unlink(filePath);

                return res.json({ 
                    success: true, 
                    message: 'Application sent successfully via Gmail',
                    method: 'gmail'
                });

            } catch (gmailError) {
                console.error('❌ Gmail API error:', gmailError.message);
                console.log('⚠️ Gmail API failed, will try SMTP fallback...');
                
                // Don't return error here - let it fall through to SMTP
                // Only return if it's specifically asking for re-auth
                if (gmailError.message.includes('invalid_grant') || gmailError.message.includes('OAuth token expired')) {
                    console.log('⚠️ OAuth tokens expired, attempting SMTP fallback...');
                }
                // Fall through to SMTP instead of throwing error
            }
        }

        // Priority 2: Use SMTP if configured
        if (user.smtp_email && user.smtp_password) {
            try {
                console.log('📧 Sending via SMTP...');
                
                const smtpPassword = decryptData(user.smtp_password);
                const transporter = createTransporter(user.smtp_email, smtpPassword);

                // Use plus addressing for Reply-To tracking
                const emailUsername = user.email.split('@')[0];
                const dobFormatted = formatDOBForEmail(user.date_of_birth);
                const replyToEmail = dobFormatted 
                    ? `${user.smtp_email.split('@')[0]}+${emailUsername}.${dobFormatted}@${user.smtp_email.split('@')[1]}`
                    : user.smtp_email; // Fallback if no DOB
                const mailOptions = {
                    from: `${user.sender_name || user.full_name} <${user.smtp_email}>`,
                    to: recipientEmail,
                    replyTo: replyToEmail, // e.g., cv+user1@cvapplyr.com
                    subject: subject,
                    // Anti-spam headers
                    headers: {
                        'X-Mailer': 'Lettrico Job Application System',
                        'X-Priority': '3',
                        'Importance': 'Normal',
                        'List-Unsubscribe': `<mailto:${user.smtp_email}?subject=unsubscribe>`,
                    },
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

                await sendEmailWithTimeout(transporter, mailOptions);

                // Update counter only (history is managed by mobile app)
                await dbConfig.run(
                    'UPDATE users SET total_sent = total_sent + 1 WHERE id = ?',
                    [userId]
                );

                // Record in application_history for usage stats (web sends need this)
                try {
                    await dbConfig.run(
                        'INSERT INTO application_history (user_id, company_name, position, recipient_email, sent_date, reply_received, reply_date) VALUES (?, ?, ?, ?, ?, ?, ?)',
                        [userId, companyName || '', position || '', recipientEmail || '', new Date().toISOString(), 0, null]
                    );
                } catch (historyError) {
                    console.error('Failed to save to application_history:', historyError);
                }

                // Create notification for sent email
                try {
                    await notifyEmailSent(userId, companyName, recipientEmail, position, subject);
                } catch (notifError) {
                    console.error('Failed to create notification:', notifError);
                }

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

        // Priority 3: Use default SMTP from .env if configured
        if (process.env.SMTP_USER && process.env.SMTP_PASS) {
            try {
                console.log('📧 Sending via default SMTP (.env)...');
                
                const transporter = createTransporter(process.env.SMTP_USER, process.env.SMTP_PASS);

                // Use plus addressing for Reply-To tracking
                const emailUsername = user.email.split('@')[0];
                const dobFormatted = formatDOBForEmail(user.date_of_birth);
                const replyToEmail = dobFormatted 
                    ? `${process.env.SMTP_USER.split('@')[0]}+${emailUsername}.${dobFormatted}@${process.env.SMTP_USER.split('@')[1]}`
                    : process.env.SMTP_USER; // Fallback if no DOB
                const mailOptions = {
                    from: `${user.sender_name || user.full_name} <${process.env.SMTP_USER}>`,
                    to: recipientEmail,
                    replyTo: replyToEmail, // e.g., cv+user1@cvapplyr.com
                    subject: subject,
                    // Anti-spam headers
                    headers: {
                        'X-Mailer': 'Lettrico Job Application System',
                        'X-Priority': '3',
                        'Importance': 'Normal',
                        'List-Unsubscribe': `<mailto:${process.env.SMTP_USER}?subject=unsubscribe>`,
                    },
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

                await sendEmailWithTimeout(transporter, mailOptions);

                // Update counter only (history is managed by mobile app)
                await dbConfig.run(
                    'UPDATE users SET total_sent = total_sent + 1 WHERE id = ?',
                    [userId]
                );

                // Record in application_history for usage stats (web sends need this)
                try {
                    await dbConfig.run(
                        'INSERT INTO application_history (user_id, company_name, position, recipient_email, sent_date, reply_received, reply_date) VALUES (?, ?, ?, ?, ?, ?, ?)',
                        [userId, companyName || '', position || '', recipientEmail || '', new Date().toISOString(), 0, null]
                    );
                } catch (historyError) {
                    console.error('Failed to save to application_history:', historyError);
                }

                // Create notification for sent email
                try {
                    await notifyEmailSent(userId, companyName, recipientEmail, position, subject);
                } catch (notifError) {
                    console.error('Failed to create notification:', notifError);
                }

                // Clean up
                await fs.unlink(filePath);

                return res.json({ 
                    success: true, 
                    message: 'Application sent successfully via default SMTP',
                    method: 'smtp-default'
                });

            } catch (smtpError) {
                console.error('Default SMTP error:', smtpError.message);
                console.error('SMTP Error Code:', smtpError.code);
                
                // Don't fail immediately - try ZeptoMail next
                console.log('⚠️ SMTP failed, will try ZeptoMail API...');
            }
        }

        // Priority 4: Use ZeptoMail API (Zoho's transactional email service)
        if (process.env.ZEPTOMAIL_TOKEN) {
            try {
                console.log('📧 Sending via ZeptoMail API...');
                
                // Read files and convert to base64
                const coverLetterBuffer = await fs.readFile(filePath);
                const resumeBuffer = await fs.readFile(resumePath);
                
                const fileName = `CoverLetter_${companyName.replace(/[^a-zA-Z0-9]/g, '_')}_${position.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
                
                // Use plus addressing for Reply-To tracking
                const emailUsername = user.email.split('@')[0];
                const dobFormatted = formatDOBForEmail(user.date_of_birth);
                const replyToEmail = dobFormatted 
                    ? `${process.env.SMTP_USER.split('@')[0]}+${emailUsername}.${dobFormatted}@${process.env.SMTP_USER.split('@')[1]}`
                    : process.env.SMTP_USER;

                await sendEmailViaZeptoMail({
                    fromEmail: process.env.SMTP_USER || 'cv@cvapplyr.com',
                    fromName: user.sender_name || user.full_name,
                    toEmail: recipientEmail,
                    replyTo: replyToEmail,
                    subject: subject,
                    textBody: emailBody,
                    attachments: [
                        {
                            filename: fileName,
                            content: coverLetterBuffer.toString('base64'),
                            contentType: 'application/pdf'
                        },
                        {
                            filename: path.basename(resumePath),
                            content: resumeBuffer.toString('base64'),
                            contentType: 'application/pdf'
                        }
                    ]
                });

                // Update counter only (history is managed by mobile app)
                await dbConfig.run(
                    'UPDATE users SET total_sent = total_sent + 1 WHERE id = ?',
                    [userId]
                );

                // Record in application_history for usage stats (web sends need this)
                try {
                    await dbConfig.run(
                        'INSERT INTO application_history (user_id, company_name, position, recipient_email, sent_date, reply_received, reply_date) VALUES (?, ?, ?, ?, ?, ?, ?)',
                        [userId, companyName || '', position || '', recipientEmail || '', new Date().toISOString(), 0, null]
                    );
                } catch (historyError) {
                    console.error('Failed to save to application_history:', historyError);
                }

                // Create notification for sent email
                try {
                    await notifyEmailSent(userId, companyName, recipientEmail, position, subject);
                } catch (notifError) {
                    console.error('Failed to create notification:', notifError);
                }

                // Clean up
                await fs.unlink(filePath);

                return res.json({ 
                    success: true, 
                    message: 'Application sent successfully via ZeptoMail',
                    method: 'zeptomail'
                });

            } catch (zeptoError) {
                console.error('ZeptoMail error:', zeptoError.message);
                // Fall through to error message
            }
        }

        // No sending method available
        return res.status(400).json({ 
            error: 'No email sending method configured. Please log in with Google to send emails.' 
        });

    } catch (error) {
        console.error('Send single application error:', error);
        
        // Return helpful error messages
        if (error.code === 'ETIMEDOUT') {
            return res.status(503).json({ 
                error: 'Unable to connect to email server. Please try logging in with Google instead.',
                details: error.message
            });
        }
        
        res.status(500).json({ error: error.message || 'Failed to send application' });
    }
};

// Check for email replies
const checkEmailReplies = async (req, res) => {
    try {
        const userId = req.user.id;
        
        console.log('\n📬 ============ CHECK EMAIL REPLIES START ============');
        console.log('📬 [CHECK] Timestamp:', new Date().toISOString());
        console.log('📬 [CHECK] User ID:', userId);
        console.log('📬 [CHECK] Request headers:', JSON.stringify(req.headers, null, 2));

        // Get user with OAuth tokens
        const user = await dbConfig.get('SELECT * FROM users WHERE id = ?', [userId]);
        
        if (!user) {
            console.error('❌ [CHECK] User not found in database');
            return res.status(404).json({ error: 'User not found' });
        }

        console.log('📬 [CHECK] User found:', {
            id: user.id,
            email: user.email,
            fullName: user.full_name,
            oauthProvider: user.oauth_provider
        });
        console.log('📬 [CHECK] OAuth Provider:', user.oauth_provider);
        console.log('📬 [CHECK] Has Microsoft token:', !!user.microsoft_access_token);
        console.log('📬 [CHECK] Has Google token:', !!user.google_access_token);
        if (user.microsoft_access_token) {
            console.log('📬 [CHECK] Microsoft token (first 20 chars):', user.microsoft_access_token.substring(0, 20) + '...');
        }
        if (user.google_access_token) {
            console.log('📬 [CHECK] Google token (first 20 chars):', user.google_access_token.substring(0, 20) + '...');
        }

        // Check if user has OAuth provider
        if (!user.oauth_provider || (user.oauth_provider !== 'google' && user.oauth_provider !== 'microsoft')) {
            console.error('❌ [CHECK] Invalid OAuth provider:', user.oauth_provider);
            return res.status(400).json({ 
                error: 'Email reply checking is only available for Google and Microsoft accounts',
                message: 'Please log in with Google or Microsoft to check for email replies'
            });
        }

        // Get all applications to check for replies (including those that already have replies)
        console.log('📬 [CHECK] Fetching applications to check for replies...');
        const pendingApps = await dbConfig.query(
            'SELECT * FROM application_history WHERE user_id = ? ORDER BY sent_date DESC LIMIT 50',
            [userId]
        );

        console.log('📬 [CHECK] Applications found:', pendingApps.length);
        if (pendingApps.length > 0) {
            console.log('📬 [CHECK] First 3 apps:', pendingApps.slice(0, 3).map(app => ({
                id: app.id,
                company: app.company_name,
                email: app.recipient_email,
                sentDate: app.sent_date,
                replyReceived: app.reply_received
            })));
        }

        if (pendingApps.length === 0) {
            return res.json({ 
                success: true, 
                message: 'No applications to check',
                repliesFound: 0,
                updatedApplications: []
            });
        }

        let repliesFound = 0;
        const updatedApplications = [];

        // Check emails based on OAuth provider
        if (user.oauth_provider === 'microsoft' && user.microsoft_access_token) {
            console.log('📬 [CHECK] Checking Microsoft emails...');
            console.log('📬 [CHECK] Microsoft access token length:', user.microsoft_access_token.length);
            
            try {
                const apiUrl = 'https://graph.microsoft.com/v1.0/me/messages?$top=50&$orderby=receivedDateTime desc';
                console.log('📬 [CHECK] Microsoft API URL:', apiUrl);
                console.log('📬 [CHECK] Making request to Microsoft Graph API...');
                
                // Microsoft Graph API: Get recent emails
                const response = await fetch(apiUrl, {
                    headers: {
                        'Authorization': `Bearer ${user.microsoft_access_token}`,
                        'Content-Type': 'application/json'
                    }
                });

                console.log('📬 [CHECK] Microsoft API Response Status:', response.status);
                console.log('📬 [CHECK] Microsoft API Response Status Text:', response.statusText);
                console.log('📬 [CHECK] Microsoft API Response Headers:', JSON.stringify([...response.headers.entries()], null, 2));

                if (!response.ok) {
                    const errorText = await response.text();
                    console.error('❌ [CHECK] Microsoft API Error Response:', errorText);
                    throw new Error(`Failed to fetch Microsoft emails: ${response.status} ${response.statusText} - ${errorText}`);
                }

                const data = await response.json();
                const emails = data.value || [];

                console.log('📬 [CHECK] Found', emails.length, 'Microsoft emails');
                if (emails.length > 0) {
                    console.log('📬 [CHECK] First email sample:', {
                        from: emails[0].from?.emailAddress?.address,
                        subject: emails[0].subject,
                        receivedDateTime: emails[0].receivedDateTime
                    });
                }

                // Match emails to applications
                console.log('📬 [CHECK] Starting to match emails with pending applications...');
                console.log('📬 [CHECK] User email (to exclude from replies):', user.email);
                
                for (const app of pendingApps) {
                    const companyEmail = app.recipient_email.toLowerCase();
                    console.log(`📬 [CHECK] Checking app #${app.id} - ${app.company_name} (${companyEmail})`);
                    
                    for (const email of emails) {
                        const fromEmail = email.from?.emailAddress?.address?.toLowerCase() || '';
                        const subject = email.subject || '(No Subject)';
                        const emailDate = new Date(email.receivedDateTime);
                        const sentDate = new Date(app.sent_date);

                        console.log(`   📧 Checking message from: ${fromEmail}, date: ${emailDate.toISOString()}`);

                        // CRITICAL FIX: Exclude user's own emails (test case handling)
                        // Check if:
                        // 1. Email is from company email
                        // 2. Email is NOT from user's own email (avoid matching sent emails in test cases)
                        // 3. Email was received after we sent the application
                        const isFromCompany = fromEmail.includes(companyEmail);
                        const isNotFromUser = !fromEmail.includes(user.email.toLowerCase());
                        const isAfterSent = emailDate > sentDate;

                        if (isFromCompany && isNotFromUser && isAfterSent) {
                            console.log(`✅ [CHECK] MATCH FOUND! Reply from ${companyEmail} for ${app.company_name}`);
                            console.log(`✅ [CHECK] Email date: ${emailDate}, Sent date: ${sentDate}`);
                            console.log(`✅ [CHECK] From email: ${fromEmail}`);
                            console.log(`✅ [CHECK] Subject: ${subject}`);
                            
                            // Extract full email body (not just preview)
                            let emailBody = email.body?.content || email.bodyPreview || '';
                            
                            // Convert block-level HTML elements to newlines before stripping tags
                            emailBody = emailBody
                                .replace(/<br\s*\/?>/gi, '\n')
                                .replace(/<\/p>/gi, '\n')
                                .replace(/<\/div>/gi, '\n')
                                .replace(/<\/tr>/gi, '\n')
                                .replace(/<\/li>/gi, '\n')
                                .replace(/&nbsp;/gi, ' ')
                                .replace(/&amp;/gi, '&')
                                .replace(/&lt;/gi, '<')
                                .replace(/&gt;/gi, '>')
                                .replace(/&#13;/gi, '\n');
                            // Strip remaining HTML tags
                            emailBody = emailBody.replace(/<[^>]*>/g, '');
                            // Collapse multiple spaces on same line but preserve line breaks
                            emailBody = emailBody.replace(/[ \t]+/g, ' ').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
                            
                            console.log(`✅ [CHECK] Extracted body length: ${emailBody.length} characters`);
                            console.log(`✅ [CHECK] Full extracted body: ${emailBody.substring(0, 500)}`);
                            
                            // Remove quoted text - look for common reply separators
                            const quotePatterns = [
                                /[\r\n]+\s*On\s+(Mon|Tue|Wed|Thu|Fri|Sat|Sun|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|\d{1,2}\s+\w+\s+\d{4})[^\r\n]+[\r\n]+wrote:/is,  // Email reply header
                                /-----Original Message-----/i,
                                /From:.+?Sent:.+?To:/si,    // Outlook-style headers
                                /_+\s*From:/i,               // "___ From:"
                            ];
                            
                            let cleanedBody = emailBody;
                            for (const pattern of quotePatterns) {
                                const match = cleanedBody.match(pattern);
                                if (match) {
                                    console.log(`🔍 [CHECK] Matched pattern at index ${match.index}: "${match[0].substring(0, 100)}"`);
                                    // Extract only the text before the quoted part
                                    cleanedBody = cleanedBody.substring(0, match.index).trim();
                                    break;
                                }
                            }
                            
                            // Store the full cleaned body (no character limit for storage)
                            const fullBody = cleanedBody.trim() || '(Reply received - content not available)';
                            
                            console.log(`✅ [CHECK] Cleaned body length: ${fullBody.length} characters`);
                            console.log(`✅ [CHECK] Body preview: ${fullBody.substring(0, 200)}...`);
                            
                            // Check if this exact reply already exists in history (avoid duplicates)
                            const existingReply = await dbConfig.get(
                                'SELECT id FROM application_reply_history WHERE application_id = ? AND reply_date = ? AND reply_subject = ?',
                                [app.id, email.receivedDateTime, subject]
                            );
                            
                            if (!existingReply) {
                                console.log(`💾 [CHECK] Saving NEW reply to history for app #${app.id}`);
                                
                                // Insert into reply history table
                                await dbConfig.run(
                                    'INSERT INTO application_reply_history (application_id, reply_date, reply_subject, reply_snippet, reply_from_email) VALUES (?, ?, ?, ?, ?)',
                                    [app.id, email.receivedDateTime, subject, fullBody, fromEmail]
                                );
                            } else {
                                console.log(`🔄 [CHECK] Updating existing reply body for app #${app.id}`);
                                await dbConfig.run(
                                    'UPDATE application_reply_history SET reply_snippet = ? WHERE id = ?',
                                    [fullBody, existingReply.id]
                                );
                            }

                            // Always update main application table with latest reply info
                            await dbConfig.run(
                                'UPDATE application_history SET reply_received = 1, reply_date = ?, reply_subject = ?, reply_snippet = ?, reply_from_email = ? WHERE id = ?',
                                [email.receivedDateTime, subject, fullBody, fromEmail, app.id]
                            );

                            repliesFound++;
                            updatedApplications.push({
                                id: app.id,
                                companyName: app.company_name,
                                replyDate: email.receivedDateTime,
                                replySubject: subject,
                                replySnippet: fullBody,
                                replyFromEmail: fromEmail
                            });
                            
                            // Continue checking for more replies (don't break - there may be multiple replies)
                        } else {
                            // Log why it didn't match
                            if (!isFromCompany || !isNotFromUser || !isAfterSent) {
                                console.log(`   ❌ No match: fromCompany=${isFromCompany}, notFromUser=${isNotFromUser}, afterSent=${isAfterSent}`);
                            }
                        }
                    }
                }

            } catch (error) {
                console.error('❌ [CHECK] Microsoft email check error:', error);
                console.error('❌ [CHECK] Microsoft error stack:', error.stack);
                console.error('❌ [CHECK] Microsoft error name:', error.name);
                console.error('❌ [CHECK] Microsoft error message:', error.message);
                // Continue to return partial results
            }

        } else if (user.oauth_provider === 'google' && user.google_access_token) {
            console.log('📬 [CHECK] Checking Gmail...');
            console.log('📬 [CHECK] Google access token length:', user.google_access_token.length);
            console.log('📬 [CHECK] Google refresh token exists:', !!user.google_refresh_token);
            
            try {
                console.log('📬 [CHECK] Creating OAuth2 client...');
                const oauth2Client = createOAuth2Client(user);
                const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

                console.log('📬 [CHECK] Fetching Gmail messages...');
                // Get recent emails (both read and unread)
                const messagesResponse = await gmail.users.messages.list({
                    userId: 'me',
                    maxResults: 50,
                    q: 'newer_than:30d' // All emails from last 30 days (read or unread)
                });

                const messages = messagesResponse.data.messages || [];
                console.log('📬 [CHECK] Found', messages.length, 'Gmail messages from last 30 days');
                if (messages.length > 0) {
                    console.log('📬 [CHECK] First message ID:', messages[0].id);
                }

                // Match emails to applications
                console.log('📬 [CHECK] Starting to match Gmail messages with pending applications...');
                console.log('📬 [CHECK] User email (to exclude from replies):', user.email);
                
                for (const app of pendingApps) {
                    const companyEmail = app.recipient_email.toLowerCase();
                    console.log(`📬 [CHECK] Checking app #${app.id} - ${app.company_name} (${companyEmail})`);
                    
                    for (const message of messages) {
                        try {
                            // Get full message details including body
                            const msg = await gmail.users.messages.get({
                                userId: 'me',
                                id: message.id,
                                format: 'full'
                            });

                            const headers = msg.data.payload.headers;
                            const fromHeader = headers.find(h => h.name === 'From');
                            const dateHeader = headers.find(h => h.name === 'Date');
                            const subjectHeader = headers.find(h => h.name === 'Subject');
                            
                            const fromEmail = fromHeader?.value?.match(/<(.+?)>/)?.[1]?.toLowerCase() || 
                                            fromHeader?.value?.toLowerCase() || '';
                            const subject = subjectHeader?.value || '(No Subject)';
                            
                            const emailDate = new Date(dateHeader?.value || msg.data.internalDate);
                            const sentDate = new Date(app.sent_date);

                            console.log(`   📧 Checking message from: ${fromEmail}, date: ${emailDate.toISOString()}`);
                            
                            // CRITICAL FIX: Exclude user's own emails (test case handling)
                            // Check if:
                            // 1. Email is from company email
                            // 2. Email is NOT from user's own email (avoid matching sent emails in test cases)
                            // 3. Email was received after we sent the application
                            const isFromCompany = fromEmail.includes(companyEmail);
                            const isNotFromUser = !fromEmail.includes(user.email.toLowerCase());
                            const isAfterSent = emailDate > sentDate;
                            
                            console.log(`   🔍 From: ${fromEmail}`);
                            console.log(`   🔍 Company: ${companyEmail}, Match: ${isFromCompany}`);
                            console.log(`   🔍 User: ${user.email.toLowerCase()}, Not from user: ${isNotFromUser}`);
                            console.log(`   🔍 Email date: ${emailDate.toISOString()}, Sent: ${sentDate.toISOString()}, After sent: ${isAfterSent}`);
                            console.log(`   🔍 Subject: ${subject}`);
                            
                            if (isFromCompany && isNotFromUser && isAfterSent) {
                                console.log(`✅ [CHECK] MATCH FOUND! Reply from ${companyEmail} for ${app.company_name}`);
                                console.log(`✅ [CHECK] Email date: ${emailDate}, Sent date: ${sentDate}`);
                                console.log(`✅ [CHECK] From email: ${fromEmail}`);
                                console.log(`✅ [CHECK] Subject: ${subject}`);
                                
                                // Extract full email body (not just snippet)
                                let emailBody = '';
                                
                                // Function to decode base64url encoded body
                                const decodeBody = (data) => {
                                    if (!data) return '';
                                    try {
                                        return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
                                    } catch (err) {
                                        console.error('Error decoding email body:', err);
                                        return '';
                                    }
                                };
                                
                                // Function to extract body from parts recursively
                                const extractBodyFromParts = (parts) => {
                                    if (!parts) return '';
                                    
                                    for (const part of parts) {
                                        // Prefer text/plain, but fall back to text/html
                                        if (part.mimeType === 'text/plain' && part.body && part.body.data) {
                                            return decodeBody(part.body.data);
                                        }
                                        
                                        // If it's multipart, recurse into parts
                                        if (part.parts) {
                                            const bodyFromSubParts = extractBodyFromParts(part.parts);
                                            if (bodyFromSubParts) return bodyFromSubParts;
                                        }
                                    }
                                    
                                    // If no text/plain found, try text/html
                                    for (const part of parts) {
                                        if (part.mimeType === 'text/html' && part.body && part.body.data) {
                                            const htmlBody = decodeBody(part.body.data);
                                            // Basic HTML to text conversion (remove tags)
                                            // Collapse multiple spaces on same line but preserve line breaks
                                            return htmlBody.replace(/<[^>]*>/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
                                        }
                                    }
                                    
                                    return '';
                                };
                                
                                // Extract body from message
                                if (msg.data.payload.body && msg.data.payload.body.data) {
                                    // Simple message with body directly in payload
                                    emailBody = decodeBody(msg.data.payload.body.data);
                                } else if (msg.data.payload.parts) {
                                    // Multipart message
                                    emailBody = extractBodyFromParts(msg.data.payload.parts);
                                }
                                
                                // Fallback to snippet if body extraction failed
                                if (!emailBody || emailBody.trim().length === 0) {
                                    emailBody = msg.data.snippet || '';
                                }
                                
                                console.log(`✅ [CHECK] Extracted body length: ${emailBody.length} characters`);
                                console.log(`✅ [CHECK] Full extracted body: ${emailBody.substring(0, 500)}`);
                                
                                // Remove quoted text - look for common reply separators
                                const quotePatterns = [
                                    /[\r\n]+\s*On\s+(Mon|Tue|Wed|Thu|Fri|Sat|Sun|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|\d{1,2}\s+\w+\s+\d{4})[^\r\n]+[\r\n]+wrote:/is,  // Email reply header
                                    /-----Original Message-----/i,
                                    /From:.+?Sent:.+?To:/si,    // Outlook-style headers
                                    /_+\s*From:/i,               // "___ From:"
                                ];
                                
                                let cleanedBody = emailBody;
                                for (const pattern of quotePatterns) {
                                    const match = cleanedBody.match(pattern);
                                    if (match) {
                                        console.log(`🔍 [CHECK] Matched pattern at index ${match.index}: "${match[0].substring(0, 100)}"`);
                                        // Extract only the text before the quoted part
                                        cleanedBody = cleanedBody.substring(0, match.index).trim();
                                        break;
                                    }
                                }
                                
                                // Store the full cleaned body (no character limit for storage)
                                const fullBody = cleanedBody.trim() || '(Reply received - content not available)';
                                
                                console.log(`✅ [CHECK] Cleaned body length: ${fullBody.length} characters`);
                                console.log(`✅ [CHECK] Body preview: ${fullBody.substring(0, 200)}...`);
                                
                                // Check if this exact reply already exists in history (avoid duplicates)
                                const existingReply = await dbConfig.get(
                                    'SELECT id FROM application_reply_history WHERE application_id = ? AND reply_date = ? AND reply_subject = ?',
                                    [app.id, emailDate.toISOString(), subject]
                                );
                                
                                if (!existingReply) {
                                    console.log(`💾 [CHECK] Saving NEW reply to history for app #${app.id}`);
                                    
                                    // Insert into reply history table
                                    await dbConfig.run(
                                        'INSERT INTO application_reply_history (application_id, reply_date, reply_subject, reply_snippet, reply_from_email) VALUES (?, ?, ?, ?, ?)',
                                        [app.id, emailDate.toISOString(), subject, fullBody, fromEmail]
                                    );
                                } else {
                                    console.log(`🔄 [CHECK] Updating existing reply body for app #${app.id}`);
                                    await dbConfig.run(
                                        'UPDATE application_reply_history SET reply_snippet = ? WHERE id = ?',
                                        [fullBody, existingReply.id]
                                    );
                                }

                                // Always update main application table with latest reply info
                                await dbConfig.run(
                                    'UPDATE application_history SET reply_received = 1, reply_date = ?, reply_subject = ?, reply_snippet = ?, reply_from_email = ? WHERE id = ?',
                                    [emailDate.toISOString(), subject, fullBody, fromEmail, app.id]
                                );

                                repliesFound++;
                                updatedApplications.push({
                                    id: app.id,
                                    companyName: app.company_name,
                                    replyDate: emailDate.toISOString(),
                                    replySubject: subject,
                                    replySnippet: fullBody,
                                    replyFromEmail: fromEmail
                                });
                                
                                // Continue checking for more replies (don't break - there may be multiple replies)
                            } else {
                                // Log why it didn't match
                                if (!isFromCompany || !isNotFromUser || !isAfterSent) {
                                    console.log(`   ❌ No match: fromCompany=${isFromCompany}, notFromUser=${isNotFromUser}, afterSent=${isAfterSent}`);
                                }
                            }

                        } catch (msgError) {
                            console.error('❌ [CHECK] Error fetching Gmail message:', msgError.message);
                            // Continue to next message
                        }
                    }
                }

            } catch (error) {
                console.error('❌ [CHECK] Gmail check error:', error);
                console.error('❌ [CHECK] Gmail error stack:', error.stack);
                console.error('❌ [CHECK] Gmail error name:', error.name);
                console.error('❌ [CHECK] Gmail error message:', error.message);
                if (error.response) {
                    console.error('❌ [CHECK] Gmail API response:', JSON.stringify(error.response.data, null, 2));
                }
                // Continue to return partial results
            }
        } else {
            console.warn('⚠️ [CHECK] No valid OAuth provider or token found');
            console.warn('⚠️ [CHECK] Provider:', user.oauth_provider);
            console.warn('⚠️ [CHECK] Has Microsoft token:', !!user.microsoft_access_token);
            console.warn('⚠️ [CHECK] Has Google token:', !!user.google_access_token);
        }

        console.log(`📬 [CHECK] Total replies found: ${repliesFound}`);
        console.log('📬 [CHECK] Updated applications:', updatedApplications);
        console.log('📬 [CHECK] Sending response to client...');
        console.log('📬 ============ CHECK EMAIL REPLIES END ============\n');

        res.json({
            success: true,
            message: repliesFound > 0 
                ? `Found ${repliesFound} new ${repliesFound === 1 ? 'reply' : 'replies'}!`
                : 'No new replies found',
            repliesFound,
            updatedApplications
        });

    } catch (error) {
        console.error('\n❌ ============ CHECK EMAIL REPLIES ERROR ============');
        console.error('❌ [ERROR] Timestamp:', new Date().toISOString());
        console.error('❌ [ERROR] Error name:', error.name);
        console.error('❌ [ERROR] Error message:', error.message);
        console.error('❌ [ERROR] Error stack:', error.stack);
        if (error.response) {
            console.error('❌ [ERROR] API Response:', JSON.stringify(error.response.data, null, 2));
        }
        console.error('❌ ============ CHECK EMAIL REPLIES ERROR END ============\n');
        
        res.status(500).json({ 
            error: error.message || 'Failed to check email replies',
            message: 'An error occurred while checking for replies'
        });
    }
};

module.exports = {
    sendApplications,
    sendSingleApplication,
    checkEmailReplies
};
