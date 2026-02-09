const dbConfig = require('../../db-config');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const TemplateCoverLetterGenerator = require('../../template-cover-letter-generator');
const PDFKit = require('pdfkit');
const cheerio = require('cheerio');

// Helper function to format DOB as YYYYMMDD for Reply-To email
function formatDOBForEmail(dateOfBirth) {
    if (!dateOfBirth) return null;
    const date = new Date(dateOfBirth);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
}

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
        // Anti-spam settings
        tls: {
            rejectUnauthorized: true,
            minVersion: 'TLSv1.2'
        },
        pool: true, // Use connection pool for better reputation
        maxConnections: 5,
        maxMessages: 100,
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
                    subject: `Application for ${position} - ${userData.fullName}`,
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

    console.log('\n=== SEND SINGLE APPLICATION DEBUG ===');
    console.log('User ID:', userId);
    console.log('Recipient:', recipientEmail);
    console.log('Company:', companyName);

    try {
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
        
        if (!user || !user.resume_path) {
            return res.status(400).json({ error: 'Resume is required' });
        }

        // Generate PDF
        console.log('📄 Generating PDF...');
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
                    message: 'Application sent successfully via default SMTP',
                    method: 'smtp-default'
                });

            } catch (smtpError) {
                console.error('Default SMTP error:', smtpError.message);
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
