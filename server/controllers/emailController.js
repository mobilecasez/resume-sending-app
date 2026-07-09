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
const { notifyEmailSent, notifyError, notifyEmailReply } = require('./notificationsController');
const CryptoJS = require('crypto-js');
const jobService = require('../services/jobService');

// SECURITY: Get encryption key (same as server.js)
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY) {
    console.error('⚠️ WARNING: ENCRYPTION_KEY not set in emailController');
}

// OAuth token decryption helper with backward compatibility
function decryptOAuthToken(encryptedToken) {
    if (!encryptedToken) return null;
    if (!ENCRYPTION_KEY) {
        console.error('⚠️ ENCRYPTION_KEY not available for decryption!');
        return encryptedToken;
    }
    try {
        // BACKWARD COMPATIBILITY: Check if token is already decrypted (starts with 'ya29.' for Google)
        // This handles existing unencrypted tokens in the database from before this security fix
        if (encryptedToken.startsWith('ya29.') || encryptedToken.startsWith('EwB') || encryptedToken.startsWith('eyJ')) {
            // Token appears to be in plain text (Google tokens start with 'ya29.', Microsoft with 'EwB' or 'eyJ')
            console.log('⚠️ Found unencrypted OAuth token - using as-is (will be encrypted on next login)');
            return encryptedToken;
        }
        
        const bytes = CryptoJS.AES.decrypt(encryptedToken, ENCRYPTION_KEY);
        const decrypted = bytes.toString(CryptoJS.enc.Utf8);
        
        if (!decrypted) {
            console.error('⚠️ Decryption produced empty result! Encrypted token starts with:', encryptedToken.substring(0, 20));
            console.error('⚠️ ENCRYPTION_KEY length:', ENCRYPTION_KEY.length, 'first 4 chars:', ENCRYPTION_KEY.substring(0, 4));
            return encryptedToken;
        }
        
        // Validate the decrypted token looks reasonable (should contain dots for JWTs or start with known prefixes)
        console.log('🔑 Decrypted token starts with:', decrypted.substring(0, 10), 'length:', decrypted.length, 'has dots:', decrypted.includes('.'));
        
        return decrypted;
    } catch (error) {
        console.error('OAuth token decryption error:', error);
        // If decryption fails, token might be plain text - return it
        return encryptedToken;
    }
}

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

// Helper function to encrypt OAuth token (AES-256)
function encryptOAuthToken(token) {
    if (!token) return null;
    if (!ENCRYPTION_KEY) {
        console.error('⚠️ WARNING: Cannot encrypt token - ENCRYPTION_KEY not set');
        return token;
    }
    try {
        const encrypted = CryptoJS.AES.encrypt(token, ENCRYPTION_KEY).toString();
        return encrypted;
    } catch (error) {
        console.error('OAuth token encryption error:', error);
        return token;
    }
}

// Check if token is expired (with 5-minute buffer)
function isTokenExpired(expiresAt) {
    if (!expiresAt) return true; // If no expiration date, consider it expired
    const expiryTime = new Date(expiresAt).getTime();
    const currentTime = Date.now();
    const bufferTime = 5 * 60 * 1000; // 5 minutes in milliseconds
    return currentTime >= (expiryTime - bufferTime);
}

// Refresh Microsoft OAuth token using refresh_token
async function refreshMicrosoftToken(user) {
    try {
        console.log('\n🔄 Refreshing Microsoft OAuth token for user', user.id);
        
        const refreshToken = decryptOAuthToken(user.microsoft_refresh_token);
        if (!refreshToken) {
            throw new Error('No Microsoft refresh token available');
        }
        
        const tokenParams = new URLSearchParams({
            client_id: process.env.MICROSOFT_CLIENT_ID,
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            scope: 'user.read Mail.Read Mail.Send offline_access',
        });
        
        const tokenResponse = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: tokenParams
        });
        
        if (!tokenResponse.ok) {
            const errorData = await tokenResponse.json();
            console.error('❌ Microsoft token refresh failed:', errorData);
            throw new Error('Microsoft token refresh failed: ' + (errorData.error_description || errorData.error));
        }
        
        const tokenData = await tokenResponse.json();
        const newAccessToken = tokenData.access_token;
        const newRefreshToken = tokenData.refresh_token; // Microsoft may rotate refresh tokens
        
        const issuedAt = new Date();
        const expiresAt = new Date(issuedAt.getTime() + 3600 * 1000);
        
        // Update database with new tokens
        const updateFields = [
            'microsoft_access_token = ?',
            'microsoft_token_issued_at = ?',
            'microsoft_token_expires_at = ?'
        ];
        const updateParams = [
            encryptOAuthToken(newAccessToken),
            issuedAt.toISOString(),
            expiresAt.toISOString()
        ];
        
        if (newRefreshToken) {
            updateFields.push('microsoft_refresh_token = ?');
            updateParams.push(encryptOAuthToken(newRefreshToken));
        }
        
        updateParams.push(user.id);
        await dbConfig.run(
            `UPDATE users SET ${updateFields.join(', ')} WHERE id = ?`,
            updateParams
        );
        
        console.log('✅ Microsoft token refreshed successfully, expires at:', expiresAt.toISOString());
        
        return {
            ...user,
            microsoft_access_token: encryptOAuthToken(newAccessToken),
            microsoft_refresh_token: newRefreshToken ? encryptOAuthToken(newRefreshToken) : user.microsoft_refresh_token,
            microsoft_token_issued_at: issuedAt.toISOString(),
            microsoft_token_expires_at: expiresAt.toISOString()
        };
    } catch (error) {
        console.error('❌ Failed to refresh Microsoft token:', error);
        throw error;
    }
}

// Get valid Microsoft access token (auto-refreshes if expired)
async function getValidMicrosoftAccessToken(user) {
    if (isTokenExpired(user.microsoft_token_expires_at)) {
        console.log('⏰ Microsoft token expired, refreshing...');
        const updatedUser = await refreshMicrosoftToken(user);
        return decryptOAuthToken(updatedUser.microsoft_access_token);
    }
    return decryptOAuthToken(user.microsoft_access_token);
}

// Refresh Google OAuth token using refresh_token
// Tries multiple client IDs since the refresh token is bound to the client that issued it
async function refreshGoogleToken(user) {
    console.log('\n🔄 Refreshing Google OAuth token for user', user.id);
    
    const refreshToken = decryptOAuthToken(user.google_refresh_token);
    
    // Build list of client configs to try — the refresh token is bound to whichever
    // client ID was used during the original auth (web, iOS, or Android)
    const clientConfigs = [];
    
    // iOS client (native — no secret needed)
    if (process.env.GOOGLE_IOS_CLIENT_ID) {
        clientConfigs.push({
            clientId: process.env.GOOGLE_IOS_CLIENT_ID,
            clientSecret: undefined,
            label: 'iOS'
        });
    }
    
    // Web client (needs secret)
    const webClientId = process.env.GOOGLE_WEB_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
    const webClientSecret = process.env.GOOGLE_WEB_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
    if (webClientId && webClientSecret) {
        clientConfigs.push({
            clientId: webClientId,
            clientSecret: webClientSecret,
            label: 'Web'
        });
    }
    
    // Android client (native — no secret needed)
    if (process.env.GOOGLE_ANDROID_CLIENT_ID) {
        clientConfigs.push({
            clientId: process.env.GOOGLE_ANDROID_CLIENT_ID,
            clientSecret: undefined,
            label: 'Android'
        });
    }
    
    let lastError;
    for (const config of clientConfigs) {
        try {
            console.log(`   Trying ${config.label} client (${config.clientId?.substring(0, 20)}...) secret: ${!!config.clientSecret}`);
            
            const oauth2Client = new google.auth.OAuth2(config.clientId, config.clientSecret);
            oauth2Client.setCredentials({ refresh_token: refreshToken });
            
            const { credentials } = await oauth2Client.refreshAccessToken();
            const newAccessToken = credentials.access_token;
            
            // Success — update database
            const issuedAt = new Date();
            const expiresAt = new Date(issuedAt.getTime() + 3600 * 1000);
            
            await dbConfig.run(
                `UPDATE users SET 
                    google_access_token = ?,
                    google_token_issued_at = ?,
                    google_token_expires_at = ?
                WHERE id = ?`,
                [encryptOAuthToken(newAccessToken), issuedAt.toISOString(), expiresAt.toISOString(), user.id]
            );
            
            console.log(`✅ Token refreshed via ${config.label} client, expires at:`, expiresAt.toISOString());
            
            return {
                ...user,
                google_access_token: encryptOAuthToken(newAccessToken),
                google_token_issued_at: issuedAt.toISOString(),
                google_token_expires_at: expiresAt.toISOString()
            };
        } catch (err) {
            console.log(`   ❌ ${config.label} refresh failed: ${err.message}`);
            lastError = err;
        }
    }
    
    console.error('❌ All client IDs failed to refresh token');
    throw new Error('Token refresh failed with all clients: ' + (lastError?.message || 'unknown'));
}

// Get valid Google access token (auto-refreshes if expired)
async function getValidGoogleAccessToken(user) {
    if (isTokenExpired(user.google_token_expires_at)) {
        console.log('⏰ Token expired, refreshing...');
        const updatedUser = await refreshGoogleToken(user);
        return decryptOAuthToken(updatedUser.google_access_token);
    }
    return decryptOAuthToken(user.google_access_token);
}

const templateGenerator = new TemplateCoverLetterGenerator();
const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-key';

// Helper function: Create OAuth2 Client with auto-refresh
async function createOAuth2Client(user) {
    // Support both PKCE (mobile) and standard OAuth (web) flows
    // PKCE: No client secret, uses iOS OAuth client
    // Always use web client ID + secret for API calls and token refresh
    // PKCE only applies to initial auth code exchange, not subsequent API usage
    const clientId = process.env.GOOGLE_WEB_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_WEB_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
    
    console.log('🔧 Creating OAuth2 client');
    console.log('   - Client ID:', clientId);
    console.log('   - Has client secret:', !!clientSecret);
    console.log('   - User ID:', user.id);
    console.log('   - Has access token:', !!user.google_access_token);
    console.log('   - Has refresh token:', !!user.google_refresh_token);
    console.log('   - Token expires at:', user.google_token_expires_at);
    
    const oauth2Client = new google.auth.OAuth2(
        clientId,
        clientSecret,
        process.env.NODE_ENV === 'production' 
            ? 'https://cvapplyr.com/auth/google/callback'
            : 'http://localhost:3000/auth/google/callback'
    );

    // SECURITY: Get valid access token (auto-refreshes if expired) and decrypt
    const accessToken = await getValidGoogleAccessToken(user);
    
    oauth2Client.setCredentials({
        access_token: accessToken,
        refresh_token: decryptOAuthToken(user.google_refresh_token)
    });

    return oauth2Client;
}

// Helper function: Sanitize name for PDF attachment filenames
function sanitizeName(name) {
    return (name || 'Applicant').replace(/[^a-zA-Z0-9\s]/g, '').trim().replace(/\s+/g, '_');
}

// Helper function: Generate professional email body using AI (unique every time)
async function generateEmailBody(position, companyName, userFullName) {
    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey) {
        try {
            const { GoogleGenerativeAI } = require('@google/generative-ai');
            const genAI = new GoogleGenerativeAI(geminiKey);
            const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

            const prompt = `Write a short, professional email body for a job application. The applicant's name is "${userFullName}", applying for the "${position}" position at "${companyName}".

Rules:
- Write ONLY the email body text, no subject line
- Start with a greeting like "Dear Hiring Manager," or "Dear Hiring Team," followed by a BLANK LINE before the body
- Keep the body to 3-5 sentences maximum
- Sound natural and human-written, not robotic or templated
- Mention that resume and cover letter are attached
- Be unique — vary sentence structure, tone, and phrasing each time
- Do NOT use phrases like "I hope this email finds you well" or "I am writing to express my interest"
- Use a professional but warm, conversational tone
- End with a closing like "Best regards," or "Kind regards," followed by a new line with the applicant's name
- Do NOT include any markdown formatting, asterisks, bold, or special characters
- Use proper paragraph spacing — separate the greeting, body paragraphs, and sign-off with blank lines
- Output plain text only, no HTML
- Do NOT wrap or break lines at any character width — each paragraph should be one continuous line of text`;

            const result = await model.generateContent(prompt);
            let text = result.response.text().trim();
            if (text && text.length > 30) {
                // Normalize line breaks
                text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
                // Unwrap word-wrapped lines: join lines within the same paragraph
                // Split by double newlines (paragraph breaks), unwrap each paragraph, rejoin
                text = text.split(/\n\n+/).map(para => {
                    // Don't unwrap greeting lines or sign-off lines (short lines ending with comma or just a name)
                    const lines = para.split('\n');
                    if (lines.length === 1) return para;
                    // If it looks like a sign-off block (e.g. "Best regards,\nName"), keep as-is
                    if (lines.length <= 2 && lines[0].length < 30) return para;
                    // Join wrapped lines into a single paragraph
                    return lines.join(' ');
                }).join('\n\n');
                // Ensure blank line after greeting (Dear ...,)
                text = text.replace(/^(Dear[^\n]*,)\n(?!\n)/m, '$1\n\n');
                return text;
            }
        } catch (aiError) {
            console.error('⚠️ AI email body generation failed, using fallback:', aiError.message);
        }
    }

    // Fallback: static template
    return `Dear Hiring Manager,

I am excited to submit my application for the ${position} role at ${companyName}. Please find my resume and cover letter attached for your consideration.

I would love the opportunity to discuss how my background and skills align with your team's needs. Please feel free to reach out at your convenience.

Thank you for your time.

Best regards,
${userFullName}`;
}

// Helper: Convert plain text email body to simple HTML
function textToHtml(text) {
    // Escape HTML entities
    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Split into paragraphs by double newlines, wrap each in <p>
    return escaped
        .split(/\n\n+/)
        .map(para => `<p style="margin: 0 0 12px 0; line-height: 1.6;">${para.replace(/\n/g, '<br>')}</p>`)
        .join('\n');
}

// Helper function: Send email via Gmail API
async function sendEmailViaGmail(user, recipientEmail, subject, emailBody, resumePath, coverLetterPdfBuffer) {
    try {
        const oauth2Client = await createOAuth2Client(user);
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
            'Content-Type: text/html; charset="UTF-8"',
            'Content-Transfer-Encoding: 7bit',
            '',
            textToHtml(emailBody),
            ''
        ].join(nl);
        
        // Attach resume if exists
        if (resumePath && fsSync.existsSync(resumePath)) {
            const resumeBuffer = await fs.readFile(resumePath);
            const resumeBase64 = resumeBuffer.toString('base64');
            const resumeFilename = `${sanitizeName(user.full_name)}_Resume.pdf`;
            
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
                `Content-Disposition: attachment; filename="${sanitizeName(user.full_name)}_Cover_Letter.pdf"`,
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
        // SECURITY: Get valid Microsoft access token (auto-refreshes if expired)
        const accessToken = await getValidMicrosoftAccessToken(user);
        
        if (!accessToken) {
            throw new Error('No Microsoft access token available');
        }

        // Read and encode attachments
        const attachments = [];
        
        // Attach resume if exists
        if (resumePath && fsSync.existsSync(resumePath)) {
            const resumeBuffer = await fs.readFile(resumePath);
            const resumeBase64 = resumeBuffer.toString('base64');
            const resumeFilename = `${sanitizeName(user.full_name)}_Resume.pdf`;
            
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
                name: `${sanitizeName(user.full_name)}_Cover_Letter.pdf`,
                contentType: 'application/pdf',
                contentBytes: coverLetterBase64
            });
        }

        // Prepare email message for Microsoft Graph API
        const message = {
            message: {
                subject: subject,
                body: {
                    contentType: 'HTML',
                    content: textToHtml(emailBody)
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

// Darkens a brand hex to a target luminance (0–1).
// Returns a very dark shade that still carries the hue.
function sidebarColorFromBrand(hex, targetLum = 0.05) {
    if (!hex || !/^#[0-9A-Fa-f]{6}$/.test(hex)) return '#1c1c2e';
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    const factor = Math.min(1, targetLum / Math.max(lum, 0.001));
    const dr = Math.round(r * factor);
    const dg = Math.round(g * factor);
    const db = Math.round(b * factor);
    return '#' + [dr, dg, db].map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
}

// Darkens a hex color by `amount` (0–1 scale)
function darkenHex(hex, amount) {
    if (!hex || !/^#[0-9A-Fa-f]{6}$/.test(hex)) return hex || '#1a1a22';
    const r = Math.round(parseInt(hex.slice(1, 3), 16) * (1 - amount));
    const g = Math.round(parseInt(hex.slice(3, 5), 16) * (1 - amount));
    const b = Math.round(parseInt(hex.slice(5, 7), 16) * (1 - amount));
    return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
}

// Resolves a font TTF path by name. Downloads from Google Fonts on first use and caches locally.
// Falls back to Lato if download fails or font is not found.
const https = require('https');
const fontsDir = path.join(__dirname, '../../fonts');

async function resolveFontPaths(fontName) {
    const latoRegular = path.join(fontsDir, 'Lato-Regular.ttf');
    const latoBold    = path.join(fontsDir, 'Lato-Bold.ttf');
    const fallback = { regular: latoRegular, bold: latoBold, name: 'Lato', boldName: 'Lato-Bold' };

    if (!fontName || fontName.toLowerCase() === 'lato') return fallback;

    const safeName = fontName.replace(/[^a-zA-Z0-9]/g, '');
    const regularCached = path.join(fontsDir, `${safeName}-Regular.ttf`);
    const boldCached    = path.join(fontsDir, `${safeName}-Bold.ttf`);

    // Return cached copy if already downloaded
    if (fsSync.existsSync(regularCached)) {
        const hasBold = fsSync.existsSync(boldCached);
        return { regular: regularCached, bold: hasBold ? boldCached : regularCached, name: safeName, boldName: hasBold ? `${safeName}-Bold` : safeName };
    }

    try {
        // Fetch font CSS from Google Fonts
        const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontName)}:wght@400;700&display=swap`;
        const css = await new Promise((resolve, reject) => {
            const req = https.get(cssUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve(data));
            });
            req.on('error', reject);
            req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
        });

        // Extract TTF/WOFF2 URLs — prefer ttf, fall back to woff2
        const urlMatches = [...css.matchAll(/src:\s*url\(([^)]+)\)\s*format\(['"]?(truetype|woff2)['"]?\)/g)];
        const w400 = urlMatches.find(m => css.slice(0, m.index).includes('weight: 400') || !css.slice(0, m.index).includes('weight:'));
        const w700 = urlMatches.find(m => css.slice(0, m.index).includes('weight: 700'));

        async function downloadFont(url, dest) {
            return new Promise((resolve, reject) => {
                const file = fsSync.createWriteStream(dest);
                https.get(url, res => {
                    res.pipe(file);
                    file.on('finish', () => { file.close(); resolve(); });
                }).on('error', err => { fsSync.unlink(dest, () => {}); reject(err); });
            });
        }

        if (w400) {
            await downloadFont(w400[1], regularCached);
            console.log(`🔤 [font] Downloaded ${fontName} Regular → ${regularCached}`);
        } else {
            return fallback;
        }

        if (w700) {
            await downloadFont(w700[1], boldCached);
            console.log(`🔤 [font] Downloaded ${fontName} Bold → ${boldCached}`);
        }

        const hasBold = fsSync.existsSync(boldCached);
        return { regular: regularCached, bold: hasBold ? boldCached : regularCached, name: safeName, boldName: hasBold ? `${safeName}-Bold` : safeName };

    } catch (err) {
        console.warn(`🔤 [font] Could not download "${fontName}": ${err.message} — using Lato`);
        return fallback;
    }
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

async function createCoverLetterPDFFromHTML(userData, coverLetterHtml, companyName, companyAddress, photoPath, signaturePath, brandColor = null, fontName = null) {
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
            // Extract each <p> block as a paragraph; fall back to <br>-split for legacy plain HTML
            const pTags = $('p');
            const paragraphs = pTags.length > 0
                ? pTags.toArray().map(el => $.html(el))
                : ($('body').html() || coverLetterHtml).split(/<br\s*\/?>/gi);
            
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
            
            // Resolve fonts BEFORE creating the PDFKit document so we can set the
            // active font immediately — this prevents pdfkit from ever trying to load
            // its built-in Helvetica AFM file (which fails when paths contain spaces).
            const resolvedFont = await resolveFontPaths(fontName);

            // Create PDF with calculated size - autoFirstPage false to control page creation
            const doc = new PDFKit({
                size: [pageWidth, pageHeight],
                margins: { top: 0, bottom: 0, left: 0, right: 0 },
                autoFirstPage: false,
                // Supply explicit font so pdfkit never defaults to Helvetica
                font: resolvedFont.regular,
            });

            // Register named aliases right after doc creation, before addPage()
            doc.registerFont(resolvedFont.name, resolvedFont.regular);
            doc.registerFont(resolvedFont.boldName, resolvedFont.bold);
            // Always register Lato as fallback alias too (used in some inline references)
            if (resolvedFont.name !== 'Lato') {
                doc.registerFont('Lato', path.join(fontsDir, 'Lato-Regular.ttf'));
                doc.registerFont('Lato-Bold', path.join(fontsDir, 'Lato-Bold.ttf'));
            } else {
                doc.registerFont('Lato', resolvedFont.regular);
                doc.registerFont('Lato-Bold', resolvedFont.bold);
            }
            // Set current font now so the page inherits it (avoids Helvetica default)
            doc.font(resolvedFont.name);

            // Convenience aliases so all downstream .font('Lato') calls use brand font
            const F  = resolvedFont.name;      // regular
            const FB = resolvedFont.boldName;  // bold
            console.log(`🔤 [PDF] font: ${F} / ${FB}`);

            // Add single page with exact size
            doc.addPage({ size: [pageWidth, pageHeight], margins: { top: 0, bottom: 0, left: 0, right: 0 } });

            const writeStream = fsSync.createWriteStream(filePath);
            doc.pipe(writeStream);

            // Sidebar colors: top = near-black with brand hue, bottom = dark brand shade
            const sidebarColorBottom = sidebarColorFromBrand(brandColor, 0.06); // dark brand shade
            const sidebarColorTop    = sidebarColorFromBrand(brandColor, 0.015); // near-black with hue
            console.log(`🎨 [PDF] sidebar gradient: ${sidebarColorTop} → ${sidebarColorBottom} (brand: ${brandColor || 'none'})`);

            // LEFT SIDEBAR — pronounced top-to-bottom gradient
            const sidebarGrad = doc.linearGradient(0, 0, 0, pageHeight);
            sidebarGrad.stop(0,   sidebarColorTop);
            sidebarGrad.stop(0.5, sidebarColorFromBrand(brandColor, 0.035));
            sidebarGrad.stop(1,   sidebarColorBottom);
            doc.rect(0, 0, sidebarWidth, pageHeight).fill(sidebarGrad);

            // — Decorative vector shapes — seeded random per company+user so every PDF is unique —
            // Seed from company name + user name (deterministic but varies across PDFs)
            const seedStr = (companyName || '') + (userData.fullName || '') + (brandColor || '');
            let _seed = seedStr.split('').reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) | 0, 0x12345678);
            function seededRand() {
                _seed = (_seed ^ (_seed << 13)) | 0;
                _seed = (_seed ^ (_seed >> 17)) | 0;
                _seed = (_seed ^ (_seed << 5))  | 0;
                return ((_seed >>> 0) / 0xFFFFFFFF);
            }
            // Convenience: random float in [min, max]
            const sr = (min, max) => min + seededRand() * (max - min);
            // Random int in [min, max]
            const sri = (min, max) => Math.floor(sr(min, max + 1));

            doc.save();

            // Shape style pool — pick a style set so each PDF has a different visual language
            const styleSet = sri(0, 4); // 0=hexagons, 1=circles, 2=triangles, 3=diamonds, 4=mixed

            function drawHexR(cx, cy, size) {
                const pts = Array.from({ length: 6 }, (_, i) => {
                    const a = Math.PI / 180 * (60 * i - 30);
                    return [cx + size * Math.cos(a), cy + size * Math.sin(a)];
                });
                doc.moveTo(pts[0][0], pts[0][1]);
                pts.slice(1).forEach(p => doc.lineTo(p[0], p[1]));
                doc.closePath();
            }
            function drawTriR(cx, cy, size, rot = 0) {
                const pts = Array.from({ length: 3 }, (_, i) => {
                    const a = Math.PI / 180 * (120 * i + rot);
                    return [cx + size * Math.cos(a), cy + size * Math.sin(a)];
                });
                doc.moveTo(pts[0][0], pts[0][1]);
                pts.slice(1).forEach(p => doc.lineTo(p[0], p[1]));
                doc.closePath();
            }
            function drawDiamondR(cx, cy, w, h) {
                doc.moveTo(cx, cy - h).lineTo(cx + w, cy).lineTo(cx, cy + h).lineTo(cx - w, cy).closePath();
            }

            // Large anchor shape in top-right corner (always present, style varies)
            doc.opacity(0.06);
            if (styleSet === 1) {
                // Large circle arc
                doc.circle(sidebarWidth, sr(30, 70), sr(70, 110)).stroke('#ffffff').lineWidth(sr(14, 22));
            } else if (styleSet === 2) {
                // Large triangle
                drawTriR(sidebarWidth - 10, sr(20, 60), sr(65, 95), sr(0, 60));
                doc.stroke('#ffffff').lineWidth(sr(12, 18));
            } else if (styleSet === 3) {
                // Large diamond
                drawDiamondR(sidebarWidth - 20, sr(30, 70), sr(50, 75), sr(60, 90));
                doc.stroke('#ffffff').lineWidth(sr(10, 16));
            } else {
                // Large hexagon (styles 0 and 4)
                drawHexR(sidebarWidth - 10, sr(30, 70), sr(65, 95));
                doc.stroke('#ffffff').lineWidth(sr(12, 18));
            }

            // Secondary anchor shape — lower portion
            doc.opacity(0.05);
            const lowerY = sr(pageHeight * 0.55, pageHeight * 0.70);
            if (styleSet === 0 || styleSet === 4) {
                doc.circle(sr(-10, 20), lowerY, sr(45, 70)).stroke('#ffffff').lineWidth(sr(10, 16));
            } else if (styleSet === 1) {
                drawHexR(sr(-10, 20), lowerY, sr(40, 60));
                doc.stroke('#ffffff').lineWidth(sr(8, 14));
            } else {
                drawTriR(sr(0, 30), lowerY, sr(40, 60), sr(0, 90));
                doc.stroke('#ffffff').lineWidth(sr(8, 14));
            }

            // 4–6 scattered small shapes
            doc.opacity(0.065);
            const numSmall = sri(4, 6);
            const usedZones = []; // avoid overlapping photo area (top 150px)
            for (let i = 0; i < numSmall; i++) {
                let cx, cy;
                let attempts = 0;
                do {
                    cx = sr(8, sidebarWidth - 8);
                    cy = sr(pageHeight * 0.28, pageHeight * 0.92);
                    attempts++;
                } while (attempts < 8 && usedZones.some(([ux, uy]) => Math.abs(cx - ux) < 22 && Math.abs(cy - uy) < 22));
                usedZones.push([cx, cy]);

                const shapeKind = (styleSet === 4) ? sri(0, 2) : styleSet % 3;
                const size = sr(7, 15);
                if (shapeKind === 0) { drawHexR(cx, cy, size); doc.stroke('#ffffff').lineWidth(1.2); }
                else if (shapeKind === 1) { doc.circle(cx, cy, size).stroke('#ffffff').lineWidth(1.2); }
                else { drawTriR(cx, cy, size, sr(0, 120)); doc.stroke('#ffffff').lineWidth(1.2); }
            }

            // Dot cluster — random position and count
            doc.opacity(0.08);
            const dotBaseX = sr(10, sidebarWidth - 30);
            const dotBaseY = sr(pageHeight * 0.30, pageHeight * 0.50);
            const numDots = sri(4, 7);
            for (let i = 0; i < numDots; i++) {
                doc.circle(dotBaseX + sr(-18, 18), dotBaseY + sr(-18, 18), sr(1.5, 3)).fill('#ffffff');
            }

            // Accent lines — random angle/position (2–4 lines)
            doc.opacity(0.06);
            const numLines = sri(2, 4);
            for (let i = 0; i < numLines; i++) {
                const y1 = sr(pageHeight * 0.80, pageHeight * 0.98);
                const x2 = sr(20, 80);
                doc.moveTo(0, y1).lineTo(x2, pageHeight * sr(0.94, 1.02)).lineWidth(sr(0.8, 1.5)).stroke('#ffffff');
            }

            doc.restore();
            
            // Photo/Initials circle at top
            const photoX = sidebarWidth / 2;
            const photoY = 70;
            const photoSize = 80;
            
            if (photoPath) {
                try {
                    // Clip to circle for circular profile photo
                    doc.save();
                    doc.circle(photoX, photoY, photoSize/2).clip();
                    doc.image(photoPath, photoX - photoSize/2, photoY - photoSize/2, {
                        width: photoSize,
                        height: photoSize
                    });
                    doc.restore();
                } catch (e) {
                    // Draw initials circle if photo fails
                    doc.circle(photoX, photoY, photoSize/2).stroke('#ffffff');
                    const initials = userData.fullName ? userData.fullName.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) : 'RS';
                    doc.font(FB).fontSize(24).fillColor('#ffffff');
                    doc.text(initials, photoX - 20, photoY - 12, { width: 40, align: 'center' });
                }
            } else {
                doc.circle(photoX, photoY, photoSize/2).lineWidth(2).stroke('#ffffff');
                const initials = userData.fullName ? userData.fullName.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) : 'RS';
                doc.font(FB).fontSize(24).fillColor('#ffffff');
                doc.text(initials, photoX - 20, photoY - 12, { width: 40, align: 'center' });
            }

            let sidebarY = photoY + photoSize/2 + 40;

            // TO section
            doc.font(FB).fontSize(11).fillColor('#ffffff');
            doc.text('TO', 20, sidebarY);
            sidebarY += 20;

            doc.font(F).fontSize(10).fillColor('#ffffff');
            doc.text('Hiring Manager,', 20, sidebarY);
            sidebarY += 16;

            // Company name (bold)
            doc.font(FB).fontSize(11).fillColor('#ffffff');
            doc.text(companyName, 20, sidebarY, { width: sidebarWidth - 40 });
            sidebarY += doc.heightOfString(companyName, { width: sidebarWidth - 40 }) + 4;

            // Company address
            if (companyAddress) {
                doc.font(F).fontSize(10).fillColor('#ffffff');
                doc.text(companyAddress, 20, sidebarY, { width: sidebarWidth - 40 });
                sidebarY += doc.heightOfString(companyAddress, { width: sidebarWidth - 40 }) + 4;
            }

            sidebarY += 10;

            // Separator line
            doc.moveTo(20, sidebarY).lineTo(sidebarWidth - 20, sidebarY).lineWidth(0.5).stroke('#808080');
            sidebarY += 20;

            // FROM section
            doc.font(FB).fontSize(11).fillColor('#ffffff');
            doc.text('FROM', 20, sidebarY);
            sidebarY += 20;

            doc.font(F).fontSize(10).fillColor('#ffffff');
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

            doc.font(FB).fontSize(11).fillColor('#ffffff');
            doc.text('DATE', 20, sidebarY);
            sidebarY += 20;

            doc.font(F).fontSize(10).fillColor('#ffffff');
            doc.text(dateStr, 20, sidebarY);

            // Contact info at bottom of sidebar (positioned relative to page height)
            const contactY = pageHeight - 80;
            doc.font(F).fontSize(8).fillColor('#ffffff');
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
            doc.font(FB).fontSize(18).fillColor('#000000');
            doc.text((userData.fullName || 'APPLICANT').toUpperCase(), contentX, contentY, { lineBreak: false });

            // Contact details on right
            doc.font(F).fontSize(9).fillColor('#4d4d4d');
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
            doc.font(F).fontSize(11).fillColor('#666666');
            const designation = userData.designation || 'Applicant';
            doc.text(designation, contentX, contentY, { lineBreak: false });
            
            contentY += 25;
            
            // Separator line
            doc.moveTo(contentX, contentY).lineTo(pageWidth - 40, contentY).lineWidth(1).stroke('#cccccc');
            
            contentY += 30;
            
            // "Cover Letter" heading
            doc.font(FB).fontSize(14).fillColor('#333333');
            doc.text('Cover Letter', contentX, contentY, { lineBreak: false });

            contentY += 30;

            // Opening
            doc.font(F).fontSize(10).fillColor('#000000');
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
                const $para = cheerio.load(`<div>${paraHtml.replace(/<\/?p[^>]*>/gi, '')}</div>`);  // strip <p> wrapper, keep inner HTML
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
                    const segFont = segment.bold ? FB : F;
                    doc.font(segFont).fontSize(10).fillColor('#000000');
                    
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
            doc.font(F).fontSize(10).fillColor('#000000');
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
            doc.font(FB).fontSize(10).fillColor('#000000');
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
async function generateCoverLetterPDF(user, coverLetterHtmlOrText, companyName, companyAddress = '', brandColor = null, fontName = null) {
    console.log('\n📄 [COMMON] Generating PDF with:');
    console.log('  User:', user.email);
    console.log('  Company:', companyName);
    console.log('  Address:', companyAddress);
    console.log('  Content length:', coverLetterHtmlOrText?.length);
    console.log('  Content type:', coverLetterHtmlOrText?.includes('<') ? 'HTML' : 'TEXT');
    
    // Fetch current designation from resume_metadata (job_titles[0])
    let designation = null;
    try {
        const resumeMeta = await dbConfig.get(
            'SELECT job_titles, current_role FROM resume_metadata WHERE user_id = ? AND parse_status = ? LIMIT 1',
            [user.id, 'done']
        );
        if (resumeMeta?.job_titles) {
            const titles = typeof resumeMeta.job_titles === 'string'
                ? JSON.parse(resumeMeta.job_titles)
                : resumeMeta.job_titles;
            designation = Array.isArray(titles) && titles.length > 0 ? titles[0] : null;
        }
    } catch (e) { /* fallback gracefully */ }

    // Prepare user data
    const userData = {
        fullName: user.full_name,
        email: user.email,
        phoneNumber: user.phone_number,
        city: user.city,
        country: user.country,
        designation: designation
    };

    // Get photo and signature paths
    const photoPath = user.photo_path ? path.join(__dirname, '../..', user.photo_path) : null;
    const signaturePath = user.signature_path ? path.join(__dirname, '../..', user.signature_path) : null;

    // Normalise cover letter to <p>-based HTML for consistent PDF rendering.
    // Three possible input formats:
    //   1. Plain text with **markdown** and \n\n paragraph breaks (sent by mobile / send-flow)
    //   2. HTML with <br> line-breaks and <strong> bold but NO <p>/<div> (sent by web innerHTML)
    //   3. Proper HTML already wrapped in <p> or <div> tags
    let coverLetterHtml = coverLetterHtmlOrText;

    if (!coverLetterHtml.includes('<p') && !coverLetterHtml.includes('<div')) {
        if (coverLetterHtml.includes('<br') || coverLetterHtml.includes('<strong')) {
            // Format 2: web innerHTML — split on double-<br> for paragraphs,
            // treat single <br> as a space so lines within a paragraph merge cleanly
            console.log('  📝 Normalising <br>-based HTML to <p> paragraphs...');
            coverLetterHtml = coverLetterHtml
                // Double <br> (paragraph break) → paragraph separator sentinel
                .replace(/(<br\s*\/?>){2,}/gi, '|||PARA|||')
                // Single remaining <br> → space
                .replace(/<br\s*\/?>/gi, ' ')
                // Split on sentinels and wrap each block in <p>
                .split('|||PARA|||')
                .map(p => p.trim())
                .filter(Boolean)
                .map(p => `<p>${p}</p>`)
                .join('');
            console.log('  ✅ Converted <br>-HTML to <p> paragraphs');
        } else {
            // Format 1: plain text with **markdown** and \n\n paragraph breaks
            console.log('  📝 Converting plain text with markdown to HTML...');
            const paragraphs = coverLetterHtml.split('\n\n').filter(p => p.trim());
            coverLetterHtml = paragraphs.map(para => {
                let formatted = para.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
                return `<p>${formatted}</p>`;
            }).join('');
            console.log('  ✅ Converted to HTML with bold tags');
        }
    } else {
        console.log('  ✅ Already <p>-based HTML format');
    }

    // Generate PDF using HTML-based method (supports bold formatting)
    const { filePath, fileName } = await createCoverLetterPDFFromHTML(
        userData,
        coverLetterHtml,
        companyName,
        companyAddress || '',
        photoPath,
        signaturePath,
        brandColor,
        fontName
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
                const emailBody = await generateEmailBody(position, companyName, user.full_name);

                // Read cover letter PDF buffer (needed for OAuth APIs)
                const coverLetterPdfBuffer = await fs.readFile(filePath);

                // DEBUG: Check user OAuth status
                console.log('🔍 [DEBUG] OAuth Status:');
                console.log('   - oauth_provider:', user.oauth_provider);
                console.log('   - google_access_token:', user.google_access_token ? 'EXISTS' : 'NULL');
                console.log('   - google_refresh_token:', user.google_refresh_token ? 'EXISTS' : 'NULL');
                console.log('   - microsoft_access_token:', user.microsoft_access_token ? 'EXISTS' : 'NULL');

                // Priority 1: Try Microsoft Graph API if Microsoft tokens are available
                let emailSentViaOAuth = false;
                if (user.microsoft_access_token) {
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

                // Priority 2: Try Gmail API if Google tokens are available
                if (!emailSentViaOAuth && user.google_access_token) {
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
                                filename: `${sanitizeName(user.full_name)}_Cover_Letter.pdf`,
                                path: filePath,
                            },
                            {
                                filename: `${sanitizeName(user.full_name)}_Resume.pdf`,
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
    const { recipientEmail, websiteUrl, position, coverLetterText, companyName, companyAddress, brandColor, fontName, coverLetterRegion, resumeRegion, includeResume = true, includeCoverLetter = true } = req.body;
    const useAsync = process.env.USE_ASYNC_JOBS !== 'false';

    console.log(`\n=== SEND SINGLE APPLICATION DEBUG (${useAsync ? 'ASYNC' : 'SYNC'}) ===`);
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
                return res.status(400).json({ 
                    error: `Cover letter quality check failed. Please regenerate the cover letter. Detected phrase: "${phrase}"` 
                });
            }
        }

        // Get user profile (fast DB check)
        const user = await dbConfig.get('SELECT * FROM users WHERE id = ?', [userId]);
        
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Only require an uploaded resume when the resume is actually being attached.
        if (includeResume !== false && (!user.resume_path || user.resume_path.trim() === '')) {
            await notifyError(userId, 'Resume Required',
                'Please upload your resume before sending applications. Go to Profile (top right) to upload your resume.',
                'upload_resume');
            return res.status(400).json({
                error: 'Resume required',
                message: 'Please upload your resume before sending applications.',
                action: 'upload_resume'
            });
        }

        if (useAsync) {
            // ASYNC MODE: Create job and return immediately
            const jobId = await jobService.createJob(userId, 'send_application', {
                recipientEmail, websiteUrl, position, coverLetterText, companyName, companyAddress, coverLetterRegion, resumeRegion, includeResume, includeCoverLetter
            });
            console.log(`🚀 Async send job created: ${jobId}`);

            res.status(202).json({ jobId, status: 'pending' });

            // Fire and forget
            jobService.startJob(jobId).then(() => {
                return executeSendWork(userId, { recipientEmail, websiteUrl, position, coverLetterText, companyName, companyAddress, brandColor, fontName, coverLetterRegion, resumeRegion, includeResume, includeCoverLetter });
            })
                .then(result => jobService.completeJob(jobId, result))
                .catch(err => {
                    console.error(`❌ Async send job ${jobId} failed:`, err.message);
                    jobService.failJob(jobId, err.message).catch(console.error);
                });
        } else {
            // SYNC MODE: Original behavior
            const result = await executeSendWork(userId, { recipientEmail, websiteUrl, position, coverLetterText, companyName, companyAddress, brandColor, fontName, coverLetterRegion, resumeRegion, includeResume, includeCoverLetter });
            res.json(result);
        }

    } catch (error) {
        console.error('Send single application error:', error);
        if (error.code === 'ETIMEDOUT') {
            return res.status(503).json({ error: 'Unable to connect to email server.', details: error.message });
        }
        res.status(500).json({ error: error.message || 'Failed to send application' });
    }
};

/**
 * Execute the actual email send work — used by both sync and async modes
 */
async function executeSendWork(userId, { recipientEmail, websiteUrl, position, coverLetterText, companyName, companyAddress, brandColor, fontName, coverLetterRegion, resumeRegion, includeResume = true, includeCoverLetter = true }) {
    const user = await dbConfig.get('SELECT * FROM users WHERE id = ?', [userId]);

    console.log('User found:', !!user);
    console.log('User OAuth provider:', user?.oauth_provider);
    console.log('User has Google access token:', !!user?.google_access_token);
    console.log('User has SMTP email:', !!user?.smtp_email);
    console.log('User has SMTP password:', !!user?.smtp_password);
    console.log('ENV SMTP_USER:', process.env.SMTP_USER ? 'SET' : 'NOT SET');
    console.log('ENV SMTP_PASS:', process.env.SMTP_PASS ? 'SET' : 'NOT SET');
    console.log('=====================================\n');

    // Resolve brand from cache if not provided by client
    if (!brandColor || !fontName) {
        // Step 1: direct URL lookup
        let lookupUrl = websiteUrl;
        if (lookupUrl && !lookupUrl.startsWith('http')) lookupUrl = 'https://' + lookupUrl;
        if (lookupUrl) {
            const cached = await dbConfig.get('SELECT brand_color, font_name FROM employer_brand_profiles WHERE website_url = ?', [lookupUrl]);
            if (cached) { brandColor = brandColor || cached.brand_color; fontName = fontName || cached.font_name; }
        }
        // Step 2: lookup via user's saved cover letter website
        if (!brandColor && companyName) {
            const firstWord = companyName.split(/\s+/)[0];
            const rclRow = await dbConfig.get(
                `SELECT stored_recipient_website FROM review_cover_letters
                 WHERE user_id = ? AND stored_recipient_website IS NOT NULL AND stored_recipient_website <> ''
                 AND company_name ILIKE ? LIMIT 1`,
                [userId, `%${firstWord}%`]
            );
            if (rclRow?.stored_recipient_website) {
                let u = rclRow.stored_recipient_website;
                if (!u.startsWith('http')) u = 'https://' + u;
                const cached = await dbConfig.get('SELECT brand_color, font_name FROM employer_brand_profiles WHERE website_url = ?', [u]);
                if (cached) { brandColor = brandColor || cached.brand_color; fontName = fontName || cached.font_name; }
            }
        }
        // Step 3: fuzzy name match
        if (!brandColor && companyName) {
            const firstWord = companyName.split(/\s+/)[0];
            const byName = await dbConfig.get(
                `SELECT ebp.brand_color, ebp.font_name FROM employer_brand_profiles ebp
                 JOIN employer_profiles ep ON ep.website_url = ebp.website_url
                 WHERE ep.employer_name ILIKE ? LIMIT 1`,
                [`%${firstWord}%`]
            );
            if (byName) { brandColor = brandColor || byName.brand_color; fontName = fontName || byName.font_name; }
        }
        console.log(`🎨 [SEND] brand resolved: color=${brandColor || 'default'}, font=${fontName || 'default'}`);
    }

    // ── Cover letter PDF: region-aware (point 3). Generic = the exact original branded letter. ──
    console.log('📄 Generating cover-letter PDF with address:', companyAddress || 'NO ADDRESS PROVIDED', '| region:', coverLetterRegion || 'generic');
        let filePath, fileName;
        const clRegion = coverLetterRegion || 'generic';
        if (clRegion === 'generic') {
            const r = await generateCoverLetterPDF(user, coverLetterText, companyName, companyAddress, brandColor || null, fontName || null);
            filePath = r.filePath; fileName = r.fileName;
        } else {
            try {
                const r = await require('./coverLetterController').buildCoverLetterPdfForRegion(userId, {
                    region: clRegion, coverLetterHtml: coverLetterText, companyName, companyAddress,
                    brandColor: brandColor || null, websiteUrl, mode: 'onepage' // emails always go out as a single page
                });
                filePath = r.filePath; fileName = r.fileName;
            } catch (e) {
                console.warn('⚠️ Region cover-letter render failed, falling back to original letter:', e.message);
                const r = await generateCoverLetterPDF(user, coverLetterText, companyName, companyAddress, brandColor || null, fontName || null);
                filePath = r.filePath; fileName = r.fileName;
            }
        }
        console.log('✅ Cover-letter PDF generated:', fileName);

        // ── Resume attachment: region-formatted Builder resume if available, else uploaded profile PDF (point 4). ──
        // Null-safe: a user who removed the resume attachment may not have an uploaded resume_path.
        let resumePath = user.resume_path ? path.join(__dirname, '../../', user.resume_path) : null;
        try {
            const rr = await require('./resumeBuilderController').buildResumePdfForRegion(userId, resumeRegion || 'generic', 'onepage'); // emails always go out as a single page
            if (rr && rr.filePath) {
                resumePath = rr.filePath;
                console.log('✅ Region resume PDF generated:', rr.fileName, '| region:', resumeRegion || 'generic');
            } else {
                console.log('ℹ️ No Builder resume found — attaching uploaded profile resume.');
            }
        } catch (e) {
            console.warn('⚠️ Region resume render failed, using uploaded resume:', e.message);
        }

        const coverLetterPdfBuffer = await fs.readFile(filePath);

        // Which attachments to actually include (the AI-Hub mail flow lets the user remove either).
        // Defaults to BOTH, so every existing caller is unchanged.
        const incCL  = includeCoverLetter !== false;
        const incRes = includeResume !== false;
        // Path-based attachment list (used by the SMTP transports).
        const pathAttachments = [
            ...(incCL  ? [{ filename: `${sanitizeName(user.full_name)}_Cover_Letter.pdf`, path: filePath }]   : []),
            ...(incRes ? [{ filename: `${sanitizeName(user.full_name)}_Resume.pdf`,       path: resumePath }] : []),
        ];

        // Generate email body and subject
        const emailBody = await generateEmailBody(position, companyName, user.full_name);
        const subject = `Application for ${position} - ${user.full_name}`;

        // Priority 1: Try Microsoft Graph API if Microsoft tokens are available
        if (user.microsoft_access_token) {
            try {
                console.log('📧 Sending via Microsoft Graph API (OAuth)...');
                
                await sendEmailViaMicrosoft(
                    user,
                    recipientEmail,
                    subject,
                    emailBody,
                    incRes ? resumePath : null,
                    incCL ? coverLetterPdfBuffer : null
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

                return { 
                    success: true, 
                    message: 'Application sent successfully via Microsoft',
                    method: 'microsoft'
                };

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

        // Priority 2: Try Gmail API if Google tokens are available
        if (user.google_access_token) {
            try {
                console.log('📧 Sending via Gmail API (OAuth)...');
                
                await sendEmailViaGmail(
                    user,
                    recipientEmail,
                    subject,
                    emailBody,
                    incRes ? resumePath : null,
                    incCL ? coverLetterPdfBuffer : null
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

                return { 
                    success: true, 
                    message: 'Application sent successfully via Gmail',
                    method: 'gmail'
                };

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
                    html: textToHtml(emailBody),
                    text: emailBody,
                    attachments: pathAttachments
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

                return {
                    success: true,
                    message: 'Application sent successfully via SMTP',
                    method: 'smtp'
                };

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
                    html: textToHtml(emailBody),
                    text: emailBody,
                    attachments: pathAttachments
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

                return { 
                    success: true, 
                    message: 'Application sent successfully via default SMTP',
                    method: 'smtp-default'
                };

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
                
                // Read files and convert to base64 (only the attachments the user kept)
                const coverLetterBuffer = incCL  ? await fs.readFile(filePath)   : null;
                const resumeBuffer      = incRes ? await fs.readFile(resumePath) : null;

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
                    htmlBody: textToHtml(emailBody),
                    attachments: [
                        ...(incCL  ? [{ filename: `${sanitizeName(user.full_name)}_Cover_Letter.pdf`, content: coverLetterBuffer.toString('base64'), contentType: 'application/pdf' }] : []),
                        ...(incRes ? [{ filename: `${sanitizeName(user.full_name)}_Resume.pdf`,       content: resumeBuffer.toString('base64'),      contentType: 'application/pdf' }] : []),
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

                return { 
                    success: true, 
                    message: 'Application sent successfully via ZeptoMail',
                    method: 'zeptomail'
                };

            } catch (zeptoError) {
                console.error('ZeptoMail error:', zeptoError.message);
                // Fall through to error message
            }
        }

    // No sending method available
    throw new Error('No email sending method configured. Please log in with Google to send emails.');
}

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

        // Gmail auto-reply checking is disabled until CASA Tier 2 approval (requires gmail.readonly/metadata scope)
        // For Gmail users, replies must be tracked manually via the app
        if (user.oauth_provider === 'google') {
            console.log('📬 [CHECK] Gmail auto-reply check is disabled (CASA not yet approved). Use manual reply tracking.');
            return res.json({
                success: true,
                message: 'Automatic reply checking for Gmail is coming soon. Please mark replies manually.',
                repliesFound: 0,
                updatedApplications: [],
                gmailAutoCheckDisabled: true
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
            
            // Use getValidMicrosoftAccessToken which handles decryption + auto-refresh
            let microsoftAccessToken;
            try {
                microsoftAccessToken = await getValidMicrosoftAccessToken(user);
                console.log('📬 [CHECK] Decrypted token starts with:', microsoftAccessToken?.substring(0, 10) + '...');
                console.log('📬 [CHECK] Decrypted token has dots:', microsoftAccessToken?.includes('.'));
                console.log('📬 [CHECK] Decrypted token length:', microsoftAccessToken?.length);
            } catch (refreshError) {
                console.error('❌ [CHECK] Failed to get valid Microsoft token:', refreshError.message);
                return res.status(401).json({ 
                    error: 'Microsoft token expired',
                    message: 'Please reconnect your Microsoft account (revoke and re-link)'
                });
            }
            
            try {
                const apiUrl = 'https://graph.microsoft.com/v1.0/me/messages?$top=50&$orderby=receivedDateTime desc';
                console.log('📬 [CHECK] Microsoft API URL:', apiUrl);
                console.log('📬 [CHECK] Making request to Microsoft Graph API...');
                
                // Microsoft Graph API: Get recent emails
                const response = await fetch(apiUrl, {
                    headers: {
                        'Authorization': `Bearer ${microsoftAccessToken}`,
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

                        // Match by exact email for generic providers, by domain for company domains
                        const companyDomain = companyEmail.split('@')[1];
                        const fromDomain = fromEmail.split('@')[1];
                        
                        // Generic email providers where domain matching would be wrong
                        const genericProviders = ['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'live.com', 'icloud.com', 'aol.com', 'protonmail.com', 'mail.com', 'zoho.com'];
                        const isGenericProvider = genericProviders.includes(companyDomain);
                        
                        // For generic providers: exact email match only
                        // For company domains: any email from the same domain counts
                        const isFromCompany = isGenericProvider
                            ? (fromEmail === companyEmail)
                            : (fromDomain === companyDomain);
                        const isNotFromUser = fromEmail !== user.email.toLowerCase();
                        const isAfterSent = emailDate > sentDate;

                        if (!isFromCompany || !isNotFromUser || !isAfterSent) {
                            // Only log first few non-matches to avoid spam
                            if (emails.indexOf(email) < 3) {
                                console.log(`   ❌ No match: from=${fromEmail} (domain=${fromDomain}), companyEmail=${companyEmail}, generic=${isGenericProvider}, fromCompany=${isFromCompany}, notFromUser=${isNotFromUser}, afterSent=${isAfterSent}`);
                            }
                        }

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

                                // Create notification for the new reply
                                try {
                                    await notifyEmailReply(userId, app.company_name, subject);
                                } catch (notifError) {
                                    console.error('Failed to create reply notification:', notifError);
                                }
                            } else {
                                console.log(`🔄 [CHECK] Reply already recorded for app #${app.id}, skipping`);
                            }
                            
                            // Continue checking for more replies (don't break - there may be multiple replies)
                        }
                    }
                }

            } catch (error) {
                console.error('❌ [CHECK] Microsoft email check error:', error);
                console.error('❌ [CHECK] Microsoft error stack:', error.stack);
                console.error('❌ [CHECK] Microsoft error name:', error.name);
                console.error('❌ [CHECK] Microsoft error message:', error.message);
                // Return error to client instead of swallowing it
                if (error.message?.includes('401') || error.message?.includes('InvalidAuthenticationToken') || error.message?.includes('refresh')) {
                    return res.status(401).json({
                        error: 'Microsoft token expired or invalid',
                        message: 'Please revoke and reconnect your Microsoft account to refresh the connection.'
                    });
                }
            }

        } else if (user.oauth_provider === 'google' && user.google_access_token) {
            console.log('📬 [CHECK] Checking Gmail...');
            console.log('📬 [CHECK] Google access token length:', user.google_access_token.length);
            console.log('📬 [CHECK] Google refresh token exists:', !!user.google_refresh_token);
            
            try {
                console.log('📬 [CHECK] Creating OAuth2 client...');
                const oauth2Client = await createOAuth2Client(user);
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
                            // Get message metadata (headers + snippet) — works with gmail.metadata scope
                            const msg = await gmail.users.messages.get({
                                userId: 'me',
                                id: message.id,
                                format: 'metadata',
                                metadataHeaders: ['From', 'Date', 'Subject']
                            });

                            const headers = msg.data.payload?.headers || [];
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
                                
                                // Use snippet (available with gmail.metadata scope) as reply content
                                const fullBody = msg.data.snippet || '(Reply received - content not available)';
                                
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

                                    // Create notification for the new reply
                                    try {
                                        await notifyEmailReply(userId, app.company_name, subject);
                                    } catch (notifError) {
                                        console.error('Failed to create reply notification:', notifError);
                                    }
                                } else {
                                    console.log(`🔄 [CHECK] Reply already recorded for app #${app.id}, skipping`);
                                }
                                
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

        // Backfill notifications for any reply records that don't have one yet
        // This handles replies found before notifyEmailReply was added
        let notificationsCreated = 0;
        try {
            const repliesNeedingNotif = await dbConfig.query(`
                SELECT DISTINCT arh.application_id, ah.company_name, arh.reply_subject
                FROM application_reply_history arh
                JOIN application_history ah ON ah.id = arh.application_id
                WHERE ah.user_id = ?
                AND ah.deleted_at IS NULL
                AND arh.deleted_at IS NULL
                AND NOT EXISTS (
                    SELECT 1 FROM notifications n
                    WHERE n.user_id = ?
                    AND n.type = 'email'
                    AND n.title = 'Reply Received!'
                    AND (n.deleted_at IS NULL)
                    AND POSITION(ah.company_name IN n.message) > 0
                )
            `, [userId, userId]);

            for (const reply of repliesNeedingNotif) {
                try {
                    await notifyEmailReply(userId, reply.company_name, reply.reply_subject);
                    notificationsCreated++;
                } catch (e) {
                    console.error('Failed to backfill reply notification:', e);
                }
            }
            if (notificationsCreated > 0) {
                console.log(`📢 [CHECK] Backfilled ${notificationsCreated} reply notification(s)`);
            }
        } catch (backfillErr) {
            console.error('❌ [CHECK] Backfill notification error:', backfillErr);
        }

        console.log('📬 [CHECK] Updated applications:', updatedApplications);
        console.log('📬 [CHECK] Sending response to client...');
        console.log('📬 ============ CHECK EMAIL REPLIES END ============\n');

        const totalNew = repliesFound + notificationsCreated;
        res.json({
            success: true,
            message: totalNew > 0
                ? `Found ${repliesFound} new ${repliesFound === 1 ? 'reply' : 'replies'}!`
                : 'No new replies found',
            repliesFound,
            notificationsCreated,
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

// Send a reply email from inside the app (no attachments — plain reply)
const sendReply = async (req, res) => {
    try {
        const userId = req.user.id;
        const { applicationId, to, subject, body } = req.body;

        if (!to || !subject || !body) {
            return res.status(400).json({ error: 'to, subject, and body are required' });
        }

        // Load full user (need OAuth tokens)
        const user = await dbConfig.get('SELECT * FROM users WHERE id = ?', [userId]);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const provider = user.oauth_provider || user.provider;

        if (provider === 'microsoft') {
            // Send via Microsoft Graph API
            const accessToken = await getValidMicrosoftAccessToken(user);
            if (!accessToken) throw new Error('No valid Microsoft access token');

            const message = {
                message: {
                    subject,
                    body: { contentType: 'HTML', content: textToHtml(body) },
                    toRecipients: [{ emailAddress: { address: to } }]
                },
                saveToSentItems: true
            };

            const response = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(message)
            });

            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(err.error?.message || `Microsoft Graph error ${response.status}`);
            }

        } else if (provider === 'google') {
            // Send via Gmail API
            const oauth2Client = await createOAuth2Client(user);
            const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

            const nl = '\r\n';
            const rawMessage = [
                `To: ${to}`,
                `From: ${user.email}`,
                `Subject: ${subject}`,
                'MIME-Version: 1.0',
                'Content-Type: text/html; charset="UTF-8"',
                '',
                textToHtml(body)
            ].join(nl);

            const encoded = Buffer.from(rawMessage).toString('base64')
                .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

            await gmail.users.messages.send({
                userId: 'me',
                requestBody: { raw: encoded }
            });

        } else {
            return res.status(400).json({ error: 'Reply sending requires a Microsoft or Google connected account' });
        }

        // Log notification
        await notifyEmailSent(userId, to, to, req.body.companyName || to, subject);

        res.json({ success: true, message: 'Reply sent successfully' });

    } catch (error) {
        console.error('❌ sendReply error:', error);
        res.status(500).json({ error: error.message || 'Failed to send reply' });
    }
};

module.exports = {
    sendApplications,
    sendSingleApplication,
    checkEmailReplies,
    executeSendWork,
    createCoverLetterPDFFromHTML,
    generateCoverLetterPDF,
    sendReply,
    getValidMicrosoftAccessToken   // reused by the background reply poller
};
