require('dotenv').config();

const path = require('path');
const fsSync = require('fs');

// Load Razorpay credentials FIRST before any other imports
const razorpayEnvPath = path.join(__dirname, '.env.razorpay');
if (fsSync.existsSync(razorpayEnvPath)) {
    require('dotenv').config({ path: razorpayEnvPath });
}

// Environment configuration
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const express = require('express');
const rateLimit = require('express-rate-limit');
const validator = require('validator');
const axios = require('axios');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const CryptoJS = require('crypto-js');
const { Pool } = require('pg');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const compression = require('compression');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const MicrosoftStrategy = require('passport-microsoft').Strategy;
const { google } = require('googleapis');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const PDFKit = require('pdfkit');
const nodemailer = require('nodemailer');
const fs = require('fs').promises;
const sharp = require('sharp');
const cheerio = require('cheerio');
const AICoverLetterGenerator = require('./ai-cover-letter-generator');
const TemplateCoverLetterGenerator = require('./template-cover-letter-generator');
const dbConfig = require('./db-config');
const { initializeDatabase } = require('./db-init');
const Razorpay = require('razorpay');

const { triggerResumeParsingBackground } = require('./services/resumeParserService');

// Import modular routes
const paymentRoutes = require('./server/routes/payment');
const authRoutes = require('./server/routes/authRoutes');
const profileRoutes = require('./server/routes/profileRoutes');
const userDataRoutes = require('./server/routes/userDataRoutes');
const creditsRoutes = require('./server/routes/creditsRoutes');
const adminPackagesRoutes = require('./server/routes/adminPackagesRoutes');
const aiEventCostsRoutes = require('./server/routes/aiEventCostsRoutes');
const rewardsRoutes = require('./server/routes/rewardsRoutes');
const feedbackRoutes = require('./server/routes/feedbackRoutes');
const adminUsersRoutes = require('./server/routes/adminUsersRoutes');
const employerFixRoutes = require('./server/routes/employerFixRoutes');
const adminStoreAnalyticsRoutes = require('./server/routes/adminStoreAnalyticsRoutes');
const adminNotifyRoutes = require('./server/routes/adminNotifyRoutes');
const adminUserOpsRoutes = require('./server/routes/adminUserOpsRoutes');
const adminGlobalJobsRoutes = require('./server/routes/adminGlobalJobsRoutes');
const discoverRoutes = require('./server/routes/discoverRoutes');
const analyticsRoutes = require('./server/routes/analyticsRoutes');
const coverLetterRoutes = require('./server/routes/coverLetterRoutes');
const emailRoutes = require('./server/routes/emailRoutes');
const notificationsRoutes = require('./server/routes/notificationsRoutes');
const usageRoutes = require('./server/routes/usageRoutes');
const jobRoutes = require('./server/routes/jobRoutes');
const aiHubRoutes = require('./server/routes/aiHub');
const resumeBuilderRoutes = require('./server/routes/resumeBuilder');
const featureFlagsRoutes = require('./server/routes/featureFlagsRoutes');

// Import authentication middleware
const { authenticateToken, authenticateAdmin } = require('./server/middleware/auth');

const app = express();
// Trust Railway's reverse proxy for rate limiting and IP detection
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// Security headers
app.use(helmet({
  contentSecurityPolicy: false, // Disabled because inline scripts are used in HTML pages
  crossOriginEmbedderPolicy: false,
}));
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this-in-production';

// Apple Sign in with Apple (Web) configuration
const APPLE_SERVICE_ID = process.env.APPLE_SERVICE_ID; // e.g., com.cvapplyr.web
const APPLE_REDIRECT_URI = process.env.NODE_ENV === 'production'
    ? 'https://cvapplyr.com/auth/apple/callback'
    : 'http://localhost:3000/auth/apple/callback';

// SECURITY: Encryption key is REQUIRED - no fallback allowed
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length < 32) {
    console.error('❌ CRITICAL SECURITY ERROR: ENCRYPTION_KEY environment variable must be set and at least 32 characters long');
    console.error('   Current length:', ENCRYPTION_KEY ? ENCRYPTION_KEY.length : 0);
    console.error('   Set ENCRYPTION_KEY in your environment variables or .env file');
    process.exit(1);
}

// Initialize Cover Letter Generators
const aiGenerator = new AICoverLetterGenerator();
const templateGenerator = new TemplateCoverLetterGenerator();

// Encryption/Decryption functions for SMTP credentials
function encryptData(text) {
    return CryptoJS.AES.encrypt(text, ENCRYPTION_KEY).toString();
}

function decryptData(ciphertext) {
    const bytes = CryptoJS.AES.decrypt(ciphertext, ENCRYPTION_KEY);
    return bytes.toString(CryptoJS.enc.Utf8);
}

// SECURITY: OAuth token encryption functions
function encryptOAuthToken(token) {
    if (!token) return null;
    try {
        return CryptoJS.AES.encrypt(token, ENCRYPTION_KEY).toString();
    } catch (error) {
        console.error('OAuth token encryption error:', error);
        return null;
    }
}

function decryptOAuthToken(encryptedToken) {
    if (!encryptedToken) return null;
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
        return decrypted || null;
    } catch (error) {
        console.error('OAuth token decryption error:', error);
        // If decryption fails, token might be plain text - return it
        return encryptedToken;
    }
}

// Gmail API Helper Functions
function createOAuth2Client(user) {
    const callbackUrl = process.env.NODE_ENV === 'production' 
        ? 'https://cvapplyr.com/auth/google/callback'
        : 'http://localhost:3000/auth/google/callback';
    
    const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        callbackUrl
    );
    
    // Set credentials (decrypt tokens from database)
    oauth2Client.setCredentials({
        access_token: decryptOAuthToken(user.google_access_token),
        refresh_token: decryptOAuthToken(user.google_refresh_token)
    });
    
    return oauth2Client;
}

// SECURITY: Security audit logging function
async function logSecurityEvent(userId, eventType, eventCategory, details = {}, req = null, success = true, errorMessage = null) {
    try {
        const ipAddress = req ? (req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress) : null;
        const userAgent = req ? req.headers['user-agent'] : null;
        
        await dbConfig.run(
            `INSERT INTO security_audit_log 
            (user_id, event_type, event_category, ip_address, user_agent, details, success, error_message) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [userId, eventType, eventCategory, ipAddress, userAgent, JSON.stringify(details), success, errorMessage]
        );
        
        console.log(`🔒 Security Event: [${eventCategory}] ${eventType} - User: ${userId || 'N/A'} - Success: ${success}`);
    } catch (error) {
        // Don't fail the main operation if logging fails
        console.error('⚠️ Failed to log security event:', error.message);
    }
}

// SECURITY: Token lifecycle - Check if token is expired
function isTokenExpired(expiresAt) {
    if (!expiresAt) return true; // No expiration date = assume expired for safety
    const now = new Date();
    const expiration = new Date(expiresAt);
    // Add 5 minute buffer to refresh before actual expiration
    const bufferMs = 5 * 60 * 1000;
    return now >= new Date(expiration.getTime() - bufferMs);
}

// SECURITY: Token lifecycle - Refresh Google OAuth token
async function refreshGoogleToken(user) {
    try {
        console.log(`🔄 Refreshing Google OAuth token for user ${user.id}`);
        
        const oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            process.env.NODE_ENV === 'production' 
                ? 'https://cvapplyr.com/auth/google/callback'
                : 'http://localhost:3000/auth/google/callback'
        );
        
        // Set refresh token (decrypt it first)
        const refreshToken = decryptOAuthToken(user.google_refresh_token);
        if (!refreshToken) {
            throw new Error('No refresh token available');
        }
        
        oauth2Client.setCredentials({
            refresh_token: refreshToken
        });
        
        // Request new access token
        const { credentials } = await oauth2Client.refreshAccessToken();
        
        // Calculate expiration time (default 3600 seconds = 1 hour)
        const expiresIn = credentials.expiry_date 
            ? Math.floor((credentials.expiry_date - Date.now()) / 1000)
            : 3600;
        const expiresAt = new Date(Date.now() + expiresIn * 1000);
        
        // Encrypt and store new access token
        await dbConfig.run(
            `UPDATE users 
            SET google_access_token = ?, 
                google_token_expires_at = ?, 
                google_token_issued_at = CURRENT_TIMESTAMP 
            WHERE id = ?`,
            [encryptOAuthToken(credentials.access_token), expiresAt, user.id]
        );
        
        // Log the refresh event
        await logSecurityEvent(user.id, 'OAUTH_TOKEN_REFRESHED', 'oauth', {
            provider: 'google',
            expires_at: expiresAt.toISOString()
        });
        
        console.log(`✅ Google token refreshed successfully for user ${user.id}, expires at ${expiresAt}`);
        
        return credentials.access_token;
    } catch (error) {
        console.error('❌ Failed to refresh Google token:', error.message);
        
        // Log the failed refresh
        await logSecurityEvent(user.id, 'OAUTH_TOKEN_REFRESH_FAILED', 'oauth', {
            provider: 'google',
            error: error.message
        }, null, false, error.message);
        
        throw error;
    }
}

// SECURITY: Token lifecycle - Get valid Google access token (refreshes if needed)
async function getValidGoogleAccessToken(user) {
    try {
        // Check if token is expired or missing
        if (!user.google_access_token || isTokenExpired(user.google_token_expires_at)) {
            console.log(`⏰ Google token expired or missing for user ${user.id}, refreshing...`);
            return await refreshGoogleToken(user);
        }
        
        // Token is still valid, decrypt and return
        return decryptOAuthToken(user.google_access_token);
    } catch (error) {
        console.error('❌ Failed to get valid Google token:', error.message);
        throw new Error('OAuth token expired. Please log out and log in again with Google.');
    }
}

// Function to generate professional email body
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
                text = text.split(/\n\n+/).map(para => {
                    const lines = para.split('\n');
                    if (lines.length === 1) return para;
                    if (lines.length <= 2 && lines[0].length < 30) return para;
                    return lines.join(' ');
                }).join('\n\n');
                // Ensure blank line after greeting
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

// Helper function: Sanitize name for PDF attachment filenames
function sanitizeName(name) {
    return (name || 'Applicant').replace(/[^a-zA-Z0-9\s]/g, '').trim().replace(/\s+/g, '_');
}

// Helper: Convert plain text email body to simple HTML
function textToHtml(text) {
    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return escaped
        .split(/\n\n+/)
        .map(para => `<p style="margin: 0 0 12px 0; line-height: 1.6;">${para.replace(/\n/g, '<br>')}</p>`)
        .join('\n');
}

// Function to send email via Gmail API
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
        'Content-Disposition: attachment; filename="' + sanitizeName(user.full_name) + '_Cover_Letter.pdf"',
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

// Initialize database (PostgreSQL only)
const db = dbConfig.initializeConnection();

// Initialize database schema
initializeDatabase().catch(err => {
    console.error('Fatal error initializing database:', err);
    process.exit(1);
});

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        // Create user-specific upload directory
        const userId = req.user ? req.user.id : 'temp';
        const uploadDir = path.join(__dirname, 'uploads', `user_${userId}`);
        await fs.mkdir(uploadDir, { recursive: true });
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const sanitizedFilename = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
        cb(null, file.fieldname + '-' + uniqueSuffix + '-' + sanitizedFilename);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Middleware
app.use(compression());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser());

// CORS Middleware - Allow requests from localhost variants and IP address
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowedOrigins = [
    'http://localhost:8081',
    'http://127.0.0.1:8081',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://192.168.1.14:8081',
    'http://192.168.1.14:3000'
  ];
  
  // Always set CORS headers (don't check origin for now to debug)
  res.header('Access-Control-Allow-Origin', origin || '*');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(session({
    secret: JWT_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));
app.use(passport.initialize());
app.use(passport.session());

// ============================================
// SECURITY: Rate Limiting (CASA Tier 2 Compliance)
// ============================================

// Strict rate limiter for authentication endpoints (prevent brute force)
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // 5 attempts per window
    message: 'Too many authentication attempts. Please try again in 15 minutes.',
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: false, // Count all attempts
    skip: (req) => {
        // Don't rate-limit OAuth GET requests — they are provider redirects, not user attempts
        // Only POST requests (login, register, token exchange) should be rate-limited
        return req.method === 'GET' && (
            req.path.includes('/callback') || req.path.includes('/mobile-callback') ||
            req.path.includes('/google') || req.path.includes('/microsoft')
        );
    },
    handler: async (req, res) => {
        // Log failed rate limit attempt
        console.warn('⚠️ Rate limit exceeded:', {
            ip: req.ip,
            path: req.path,
            headers: req.headers['user-agent']
        });
        res.status(429).json({ 
            error: 'Too many attempts. Please try again in 15 minutes.',
            retryAfter: 900 // seconds
        });
    }
});

// Moderate rate limiter for API endpoints
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // 100 requests per window
    message: 'Too many requests. Please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true // Don't count successful requests
});

// Strict rate limiter for sensitive operations
const sensitiveLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 3, // 3 attempts per hour
    message: 'Too many sensitive operations. Please try again in 1 hour.',
    standardHeaders: true,
    legacyHeaders: false
});

// ============================================
// SECURITY: Input Validation Middleware (CASA Tier 2 Compliance)
// ============================================

// Validation helper functions
const validateEmail = (email) => {
    if (!email || typeof email !== 'string') return false;
    return validator.isEmail(email) && email.length <= 255;
};

const validatePassword = (password) => {
    if (!password || typeof password !== 'string') return false;
    // At least 8 characters, 1 uppercase, 1 lowercase, 1 number
    return password.length >= 8 && password.length <= 128 &&
           /[A-Z]/.test(password) &&
           /[a-z]/.test(password) &&
           /[0-9]/.test(password);
};

const validateString = (str, minLength = 1, maxLength = 1000) => {
    if (!str || typeof str !== 'string') return false;
    const trimmed = str.trim();
    return trimmed.length >= minLength && trimmed.length <= maxLength;
};

const sanitizeString = (str) => {
    if (!str || typeof str !== 'string') return '';
    // Remove potentially dangerous characters
    return validator.escape(str.trim());
};

const validateUrl = (url) => {
    if (!url || typeof url !== 'string') return false;
    return validator.isURL(url, { protocols: ['http', 'https'], require_protocol: true });
};

const validateFileName = (filename) => {
    if (!filename || typeof filename !== 'string') return false;
    // Only allow safe characters in filenames
    return /^[a-zA-Z0-9._-]+$/.test(filename) && filename.length <= 255;
};

// Validation middleware for registration
const validateRegistration = (req, res, next) => {
    const { email, password, fullName } = req.body;
    
    if (!validateEmail(email)) {
        return res.status(400).json({ error: 'Invalid email address' });
    }
    
    if (!validatePassword(password)) {
        return res.status(400).json({ 
            error: 'Password must be 8-128 characters with at least 1 uppercase, 1 lowercase, and 1 number' 
        });
    }
    
    if (!validateString(fullName, 2, 100)) {
        return res.status(400).json({ error: 'Full name must be 2-100 characters' });
    }
    
    // Sanitize inputs
    req.body.email = email.toLowerCase().trim();
    req.body.fullName = sanitizeString(fullName);
    
    next();
};

// Validation middleware for login
const validateLogin = (req, res, next) => {
    const { email, password } = req.body;
    
    if (!validateEmail(email)) {
        return res.status(400).json({ error: 'Invalid email address' });
    }
    
    if (!password || typeof password !== 'string' || password.length > 128) {
        return res.status(400).json({ error: 'Invalid password' });
    }
    
    req.body.email = email.toLowerCase().trim();
    
    next();
};

// Validation middleware for email sending
const validateEmailData = (req, res, next) => {
    const { recipientEmail, companyName, position } = req.body;
    
    if (recipientEmail && !validateEmail(recipientEmail)) {
        return res.status(400).json({ error: 'Invalid recipient email address' });
    }
    
    if (companyName && !validateString(companyName, 1, 200)) {
        return res.status(400).json({ error: 'Company name must be 1-200 characters' });
    }
    
    if (position && !validateString(position, 1, 200)) {
        return res.status(400).json({ error: 'Position must be 1-200 characters' });
    }
    
    // Sanitize inputs
    if (companyName) req.body.companyName = sanitizeString(companyName);
    if (position) req.body.position = sanitizeString(position);
    
    next();
};

console.log('✅ Rate limiting and input validation configured');

// Protected admin pages - MUST come before express.static
app.get('/admin-packages.html', serveAdminPageOnly, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin-packages.html'));
});

// Additional admin pages (AI event costs, user credits, employer fix requests)
// are served by the clean-URL middleware + express.static below, exactly like
// the /admin-packages clean URL. Access is enforced by (1) the admin-only menu
// reveal, (2) each page's client-side Access-Denied handling, and (3) the
// admin-gated APIs (authenticateAdmin) they call — the same model the existing
// admin page relies on (no authToken cookie is set, so cookie-gating the HTML
// would lock out the real admin too).

// Middleware to handle clean URLs without .html extension
app.use((req, res, next) => {
    // Skip if URL already has .html extension
    if (req.path.endsWith('.html')) {
        return next();
    }
    
    // Skip if URL has a file extension (css, js, png, etc.)
    if (path.extname(req.path) !== '') {
        return next();
    }
    
    // Skip API routes
    if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) {
        return next();
    }
    
    // Try to serve the .html version of the requested path
    const htmlPath = path.join(__dirname, 'public', req.path + '.html');
    fsSync.access(htmlPath, fsSync.constants.F_OK, (err) => {
        if (!err) {
            res.sendFile(htmlPath);
        } else {
            next();
        }
    });
});

// Clean URL route for admin-packages (without .html)
app.get('/admin-packages', serveAdminPageOnly, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin-packages.html'));
});

// Favicon route with proper headers
app.get('/favicon.ico', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=31536000'); // 1 year cache
    res.setHeader('Content-Type', 'image/x-icon');
    res.sendFile(path.join(__dirname, 'public', 'favicon.ico'));
});

// ── Smart app-store redirect (for ads / "Download" links) ────────────────────
// cvapplyr.com/download (also /get and /app) → detects the device from the User-Agent and 302s to
// the right store; desktop → website. Every hit is logged (platform, UA, referrer, UTM, IP) so we
// can measure ad clicks. Server-side (not client JS) so it's instant, JS-free, and reliably tracked.
const APP_LINKS = {
    ios: 'https://apps.apple.com/in/app/cvapplyr/id6762126502',
    android: 'https://play.google.com/store/apps/details?id=com.cvapplyr.mobile',
    web: 'https://cvapplyr.com',
};
app.get(['/download', '/get', '/app'], async (req, res) => {
    const ua = req.get('user-agent') || '';
    const platform = (/iPad|iPhone|iPod/i.test(ua) && !/Windows Phone/i.test(ua)) ? 'ios'
        : /Android/i.test(ua) ? 'android' : 'desktop';
    let dest = platform === 'ios' ? APP_LINKS.ios : platform === 'android' ? APP_LINKS.android : APP_LINKS.web;
    // Forward Play Store install-referrer for Google Play Console attribution.
    if (platform === 'android') {
        const ref = `utm_source=${req.query.utm_source || 'cvapplyr'}&utm_medium=${req.query.utm_medium || 'redirect'}&utm_campaign=${req.query.utm_campaign || 'app_redirect'}`;
        dest += `&referrer=${encodeURIComponent(ref)}`;
    }
    try {
        await dbConfig.run(
            `INSERT INTO app_redirect_clicks (platform, user_agent, referer, utm_source, utm_medium, utm_campaign, ip)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [platform, ua.slice(0, 500), (req.get('referer') || '').slice(0, 500),
             req.query.utm_source || null, req.query.utm_medium || null, req.query.utm_campaign || null,
             String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim()]
        );
    } catch (e) { console.error('[app-redirect] log failed:', e.message); }
    res.redirect(302, dest);
});
// Admin: redirect/click stats — total, by platform, recent windows, by-campaign.
app.get('/api/admin/app-clicks', authenticateAdmin, async (req, res) => {
    try {
        const total = await dbConfig.get('SELECT count(*)::int AS n FROM app_redirect_clicks');
        const byPlatform = await dbConfig.query('SELECT platform, count(*)::int AS n FROM app_redirect_clicks GROUP BY platform ORDER BY n DESC');
        const last7 = await dbConfig.get("SELECT count(*)::int AS n FROM app_redirect_clicks WHERE created_at > NOW() - INTERVAL '7 days'");
        const last30 = await dbConfig.get("SELECT count(*)::int AS n FROM app_redirect_clicks WHERE created_at > NOW() - INTERVAL '30 days'");
        const byCampaign = await dbConfig.query("SELECT COALESCE(utm_campaign,'(none)') AS campaign, count(*)::int AS n FROM app_redirect_clicks GROUP BY 1 ORDER BY n DESC LIMIT 20");
        res.json({ total: total?.n || 0, last7days: last7?.n || 0, last30days: last30?.n || 0, byPlatform: byPlatform || [], byCampaign: byCampaign || [] });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Register a device's Expo push token (so we can notify when a slow job search finishes).
app.post('/api/user/push-token', authenticateToken, async (req, res) => {
    try {
        const token = String((req.body && req.body.token) || '').trim();
        if (!token || !/^Expo(nent)?PushToken\[/.test(token)) return res.status(400).json({ error: 'valid expo push token required' });
        await dbConfig.run('UPDATE users SET expo_push_token = ? WHERE id = ?', [token.slice(0, 300), req.user.id]);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Root route - serve landing page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Auth pages
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/register', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

// About page route
app.get('/about', (req, res) => {
    res.sendFile(path.join(__dirname, 'about.html'));
});

// Dashboard route
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Legal pages routes
app.get('/privacy', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'privacy-policy.html'));
});

app.get('/privacy-policy', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'privacy-policy.html'));
});

app.get('/terms', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'terms-of-service.html'));
});

app.get('/terms-of-service', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'terms-of-service.html'));
});

app.get('/support', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'support.html'));
});

app.get('/refund', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'refund-policy.html'));
});

app.get('/refund-policy', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'refund-policy.html'));
});

// ── SEO article hub (clean URLs: /articles and /articles/<slug>) ──
app.get('/articles', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'articles', 'index.html'));
});
app.get('/articles/:slug', (req, res) => {
    const slug = String(req.params.slug || '').replace(/[^a-z0-9-]/gi, '');   // no path traversal
    const file = path.join(__dirname, 'public', 'articles', slug + '.html');
    res.sendFile(file, (err) => {
        if (err) res.status(404).sendFile(path.join(__dirname, 'public', 'articles', 'index.html'));
    });
});

// Always serve the shared header JS fresh so menu changes (e.g. new admin links like
// Store Analytics) show up immediately instead of being stuck behind the 1-day static cache.
app.get('/js/app-header.js', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'js', 'app-header.js'));
});

// Static files for landing page resources
const staticOptions = { maxAge: '7d', etag: true };
app.use('/bootstrap-4.1.1-dist', express.static('bootstrap-4.1.1-dist', staticOptions));
app.use('/css', express.static('css', staticOptions));
app.use('/js', express.static('js', staticOptions));
app.use('/imgs', express.static('imgs', staticOptions));
app.use('/Screenshots', express.static('Screenshots', staticOptions));

// Serve .well-known directory for domain verification (Microsoft, Apple, etc.)
app.use('/.well-known', express.static('.well-known'));

// Static files for public access
app.use(express.static('public', { maxAge: '1d', etag: true }));
app.use('/uploads', express.static('uploads', { maxAge: '7d', etag: true }));

// Passport Google OAuth Configuration
// Mobile flow always uses production callback so Chrome on Android emulator can reach it.
const CALLBACK_URL = process.env.NODE_ENV === 'production'
    ? 'https://cvapplyr.com/auth/google/callback'
    : 'http://localhost:3000/auth/google/callback';

const MOBILE_CALLBACK_URL = process.env.NODE_ENV === 'production'
    ? 'https://cvapplyr.com/auth/google/mobile-callback'
    : 'http://localhost:3000/auth/google/mobile-callback';

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_WEB_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || 'your-google-client-id',
    clientSecret: process.env.GOOGLE_WEB_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || 'your-google-client-secret',
    callbackURL: CALLBACK_URL,
    scope: [
        'profile', 
        'email', 
        'https://www.googleapis.com/auth/gmail.send',
        // TODO: Re-enable after CASA Tier 2 approval
        // 'https://www.googleapis.com/auth/gmail.metadata'  // Requires CASA — reply detection (labels/headers)
    ],
    accessType: 'offline', // Request refresh token
    prompt: 'consent' // Force consent screen to get refresh token
}, (accessToken, refreshToken, profile, done) => {
    // Handle Google OAuth callback with tokens
    handleOAuthUser(profile, 'google', accessToken, refreshToken, done);
}));

// Second Google strategy for mobile deep-link flow
passport.use('google-mobile', new GoogleStrategy({
    clientID: process.env.GOOGLE_WEB_CLIENT_ID || process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_WEB_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: MOBILE_CALLBACK_URL,
    scope: ['profile', 'email', 'https://www.googleapis.com/auth/gmail.send'],
    // TODO: Re-enable after CASA Tier 2 approval
    // 'https://www.googleapis.com/auth/gmail.readonly' — removed to avoid CASA requirement
    accessType: 'offline',
    prompt: 'consent',
}, (accessToken, refreshToken, profile, done) => {
    handleOAuthUser(profile, 'google', accessToken, refreshToken, done);
}));

// Microsoft OAuth Configuration
const MICROSOFT_CALLBACK_URL = IS_PRODUCTION
    ? 'https://cvapplyr.com/auth/microsoft/callback'
    : 'http://localhost:3000/auth/microsoft/callback';

passport.use(new MicrosoftStrategy({
    clientID: process.env.MICROSOFT_CLIENT_ID || 'your-microsoft-client-id',
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET || 'your-microsoft-client-secret',
    callbackURL: MICROSOFT_CALLBACK_URL,
    scope: [
        'user.read',
        'Mail.Read',      // Added for reply detection
        'Mail.Send',      // Fixed capitalization
        'offline_access'
    ],
    tenant: 'common' // Supports personal Microsoft accounts and work/school accounts
}, (accessToken, refreshToken, profile, done) => {
    // Handle Microsoft OAuth callback with tokens
    handleOAuthUser(profile, 'microsoft', accessToken, refreshToken, done);
}));

// Passport LinkedIn OAuth Configuration (Disabled due to API compatibility)
// Uncomment and update when a compatible LinkedIn strategy is available
/*
passport.use(new LinkedInStrategy({
    clientID: process.env.LINKEDIN_CLIENT_ID || 'your-linkedin-client-id',
    clientSecret: process.env.LINKEDIN_CLIENT_SECRET || 'your-linkedin-client-secret',
    callbackURL: 'http://localhost:3000/auth/linkedin/callback',
    scope: ['profile', 'email']
}, (accessToken, refreshToken, profile, done) => {
    // Handle LinkedIn OAuth callback
    handleOAuthUser(profile, 'linkedin', done);
}));
*/

// Serialize and deserialize user for session management
passport.serializeUser((user, done) => {
    done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
    try {
        const user = await dbConfig.get('SELECT * FROM users WHERE id = ?', [id]);
        done(null, user);
    } catch (err) {
        done(err);
    }
});

// OAuth user handler function
async function handleOAuthUser(profile, provider, accessToken, refreshToken, callback) {
    try {
        const email = profile.emails && profile.emails[0] ? profile.emails[0].value : null;
        const fullName = profile.displayName;
        
        if (!email) {
            return callback(new Error('No email found in OAuth profile'));
        }

        // Check if user exists
        const user = await dbConfig.get('SELECT * FROM users WHERE email = ?', [email]);

        if (user) {
            // User exists, update OAuth tokens (ENCRYPTED for security) and track expiration
            if (provider === 'google') {
                // Calculate token expiration (Google tokens typically expire in 1 hour = 3600 seconds)
                const expiresAt = new Date(Date.now() + 3600 * 1000);
                
                // Passport-based OAuth is standard flow (not PKCE), so used_pkce=false
                await dbConfig.run(
                    `UPDATE users 
                    SET oauth_provider = ?, 
                        google_access_token = ?, 
                        google_refresh_token = ?, 
                        google_token_expires_at = ?,
                        google_token_issued_at = CURRENT_TIMESTAMP,
                        used_pkce = ? 
                    WHERE id = ?`,
                    [provider, encryptOAuthToken(accessToken), encryptOAuthToken(refreshToken), expiresAt, false, user.id]
                );
                
                // Log OAuth token grant
                await logSecurityEvent(user.id, 'OAUTH_TOKEN_GRANTED', 'oauth', {
                    provider: 'google',
                    flow: 'passport',
                    expires_at: expiresAt.toISOString()
                });
            } else if (provider === 'microsoft') {
                // Microsoft tokens typically expire in 1 hour as well
                const expiresAt = new Date(Date.now() + 3600 * 1000);
                
                await dbConfig.run(
                    `UPDATE users 
                    SET oauth_provider = ?, 
                        microsoft_access_token = ?, 
                        microsoft_refresh_token = ?,
                        microsoft_token_expires_at = ?,
                        microsoft_token_issued_at = CURRENT_TIMESTAMP
                    WHERE id = ?`,
                    [provider, encryptOAuthToken(accessToken), encryptOAuthToken(refreshToken), expiresAt, user.id]
                );
                
                // Log OAuth token grant
                await logSecurityEvent(user.id, 'OAUTH_TOKEN_GRANTED', 'oauth', {
                    provider: 'microsoft',
                    flow: 'passport',
                    expires_at: expiresAt.toISOString()
                });
            }
            return callback(null, user);
        } else {
            // Create new user (with ENCRYPTED OAuth tokens for security) and track expiration
            const hashedPassword = jwt.sign({ provider, email }, JWT_SECRET);
            let result;
            if (provider === 'google') {
                const expiresAt = new Date(Date.now() + 3600 * 1000);
                
                // Passport-based OAuth is standard flow (not PKCE), so used_pkce=false
                result = await dbConfig.run(
                    `INSERT INTO users 
                    (full_name, email, password, oauth_provider, google_access_token, google_refresh_token, 
                     google_token_expires_at, google_token_issued_at, used_pkce) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
                    [fullName, email, hashedPassword, provider, encryptOAuthToken(accessToken), encryptOAuthToken(refreshToken), expiresAt, false]
                );
                
                const newUserId = result.lastID || result.id;
                
                // Log new user registration via OAuth
                await logSecurityEvent(newUserId, 'USER_REGISTERED', 'auth', {
                    provider: 'google',
                    method: 'oauth'
                });
                
                // Log OAuth token grant
                await logSecurityEvent(newUserId, 'OAUTH_TOKEN_GRANTED', 'oauth', {
                    provider: 'google',
                    flow: 'passport',
                    expires_at: expiresAt.toISOString()
                });
            } else if (provider === 'microsoft') {
                const expiresAt = new Date(Date.now() + 3600 * 1000);
                
                result = await dbConfig.run(
                    `INSERT INTO users 
                    (full_name, email, password, oauth_provider, microsoft_access_token, microsoft_refresh_token,
                     microsoft_token_expires_at, microsoft_token_issued_at) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                    [fullName, email, hashedPassword, provider, encryptOAuthToken(accessToken), encryptOAuthToken(refreshToken), expiresAt]
                );
                
                const newUserId = result.lastID || result.id;
                
                // Log new user registration via OAuth
                await logSecurityEvent(newUserId, 'USER_REGISTERED', 'auth', {
                    provider: 'microsoft',
                    method: 'oauth'
                });
                
                // Log OAuth token grant
                await logSecurityEvent(newUserId, 'OAUTH_TOKEN_GRANTED', 'oauth', {
                    provider: 'microsoft',
                    flow: 'passport',
                    expires_at: expiresAt.toISOString()
                });
            }
            
            const newUser = await dbConfig.get('SELECT * FROM users WHERE id = ?', [result.lastID || result.id]);

            // Welcome credits — grant the same 5 free credits the email / API-OAuth signup
            // paths give (authController.js). This Passport path (Google web + Google mobile
            // deep-link + Microsoft web) previously created NO user_credits row, so those new
            // users silently got 0. Only granted to genuinely-new users (no existing row).
            try {
                if (newUser && newUser.id) {
                    const existingCredits = await dbConfig.get('SELECT user_id FROM user_credits WHERE user_id = ?', [newUser.id]);
                    if (!existingCredits) {
                        await dbConfig.run(
                            'INSERT INTO user_credits (user_id, credits_remaining, credits_total) VALUES (?, ?, ?)',
                            [newUser.id, 5, 5]
                        );
                        await dbConfig.run(
                            `INSERT INTO credit_transactions (user_id, transaction_type, credits_change, balance_after, description) VALUES (?, ?, ?, ?, ?)`,
                            [newUser.id, 'purchase', 5, 5, 'Welcome bonus - Free credits']
                        );
                        console.log(`🎁 Gave 5 free welcome credits to new ${provider} (passport) user ${email}`);
                    }
                }
            } catch (creditErr) {
                console.error('[handleOAuthUser] welcome credit grant failed:', creditErr.message);
            }

            return callback(null, newUser);
        }
    } catch (err) {
        return callback(err);
    }
}

// Secure file serving endpoint - only allow users to access their own files
app.get('/uploads/:userId/:filename', authenticateToken, async (req, res) => {
    try {
        const requestedUserId = req.params.userId.replace('user_', '');
        const filename = req.params.filename;
        
        // Verify user can only access their own files
        if (parseInt(requestedUserId) !== req.user.id) {
            return res.status(403).json({ error: 'Access denied' });
        }
        
        const filePath = path.join(__dirname, 'uploads', `user_${requestedUserId}`, filename);
        
        // Check if file exists
        try {
            await fs.access(filePath);
            res.sendFile(filePath);
        } catch (err) {
            res.status(404).json({ error: 'File not found' });
        }
    } catch (error) {
        console.error('File access error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Server-side HTML page protection middleware
function serveAdminPageOnly(req, res, next) {
    // Check if there's an auth token in cookie
    const token = req.cookies?.authToken;
    
    if (!token) {
        // No token, redirect to login
        return res.redirect('/login.html?error=admin_required');
    }

    jwt.verify(token, JWT_SECRET, async (err, user) => {
        if (err) {
            return res.redirect('/login.html?error=session_expired');
        }
        
        // Check if user is admin
        try {
            const row = await dbConfig.get('SELECT role FROM users WHERE id = ?', [user.id]);
            if (!row || row.role !== 'admin') {
        return res.status(403).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Access Denied</title>
                <style>
                    body { 
                        font-family: Arial, sans-serif; 
                        display: flex; 
                        justify-content: center; 
                        align-items: center; 
                        height: 100vh; 
                        margin: 0;
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    }
                    .container {
                        background: white;
                        padding: 40px;
                        border-radius: 12px;
                        text-align: center;
                        box-shadow: 0 4px 12px rgba(0,0,0,0.2);
                        max-width: 500px;
                    }
                    h1 { color: #EF4444; margin-bottom: 16px; }
                    p { color: #6B7280; margin-bottom: 24px; }
                    a { 
                        display: inline-block;
                        padding: 12px 24px;
                        background: #6366F1;
                        color: white;
                        text-decoration: none;
                        border-radius: 8px;
                        font-weight: 600;
                    }
                    .icon { font-size: 48px; margin-bottom: 16px; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="icon">🔒</div>
                    <h1>Access Denied</h1>
                    <p>This page requires administrator privileges. You do not have permission to access this resource.</p>
                    <a href="/index.html">← Return to Dashboard</a>
                </div>
            </body>
            </html>
        `);
            }
            // User is admin, serve the page
            next();
        } catch (error) {
            console.error('Admin check error:', error);
            return res.status(403).send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Access Denied</title>
        </head>
        <body>
            <div class="container">
                <h1>Access Denied</h1>
                <p>Error checking admin privileges.</p>
            </div>
        </body>
        </html>
            `);
        }
    });
}

// ============================================
// CREDITS MANAGEMENT HELPER FUNCTIONS
// ============================================

// Helper function to check if user has sufficient credits
async function checkUserCredits(userId, creditsRequired = 1) {
    try {
        const credits = await dbConfig.get(`
            SELECT credits_remaining as "creditsRemaining", expiry_date as "expiryDate"
            FROM user_credits
            WHERE user_id = ?
        `, [userId]);
            
            if (!credits) {
        return {
            hasCredits: false,
            remaining: 0,
            message: 'No credits available. Please purchase a plan to continue.'
        };
            }
            
        // Check if credits are expired
        const now = new Date();
        const expiryDate = credits.expiryDate ? new Date(credits.expiryDate) : null;
        const isExpired = expiryDate && expiryDate < now;
        
        if (isExpired) {
            return {
        hasCredits: false,
        remaining: 0,
        message: 'Your credits have expired. Please purchase a new plan.'
            };
        }
        
        if (credits.creditsRemaining < creditsRequired) {
            return {
        hasCredits: false,
        remaining: credits.creditsRemaining,
        message: `Insufficient credits. You need ${creditsRequired} credit(s) but have ${credits.creditsRemaining}.`
            };
        }
        
        return {
            hasCredits: true,
            remaining: credits.creditsRemaining,
            message: 'Credits available'
        };
    } catch (error) {
        console.error('Credit check error:', error);
        throw new Error('Failed to check credit balance');
    }
}

// Helper function to deduct credits from user account
async function deductCredits(userId, creditsToDeduct = 1, actionType = 'cover_letter_generation', metadata = {}) {
    try {
        // Deduct from user_credits
        await dbConfig.run(`
            UPDATE user_credits
            SET credits_remaining = credits_remaining - ?,
        updated_at = CURRENT_TIMESTAMP
            WHERE user_id = ?
        `, [creditsToDeduct, userId]);
        
        // Record in credit_usage_history
        await dbConfig.run(`
            INSERT INTO credit_usage_history
            (user_id, credits_used, action_type, company_name, position, recipient_email)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [
            userId, 
            creditsToDeduct, 
            actionType, 
            metadata.companyName || null, 
            metadata.position || null, 
            metadata.recipientEmail || null
        ]);
        
        // Update monthly stats
        const now = new Date();
        const month = now.getMonth() + 1; // 1-12
        const year = now.getFullYear();
        
        await dbConfig.run(`
            INSERT INTO monthly_usage_stats (user_id, month, year, credits_used, letters_generated)
            VALUES (?, ?, ?, ?, 1)
            ON CONFLICT(user_id, month, year) DO UPDATE SET
        credits_used = monthly_usage_stats.credits_used + ?,
        letters_generated = monthly_usage_stats.letters_generated + 1,
        updated_at = CURRENT_TIMESTAMP
        `, [userId, month, year, creditsToDeduct, creditsToDeduct]);
        
        // Get updated balance
        const result = await dbConfig.get('SELECT credits_remaining as "creditsRemaining" FROM user_credits WHERE user_id = ?', [userId]);

        // Nudge once when the balance CROSSES into "low" territory (or hits zero) — not on every spend.
        try {
            const newBal = result ? result.creditsRemaining : 0;
            const prevBal = newBal + creditsToDeduct;
            const LOW = 2;
            if ((prevBal > LOW && newBal <= LOW) || (prevBal > 0 && newBal <= 0)) {
                require('./server/controllers/notificationsController').notifyLowCredits(userId, Math.max(0, newBal)).catch(() => {});
            }
        } catch (_) {}

        return {
            success: true,
            remainingCredits: result ? result.creditsRemaining : 0
        };
    } catch (error) {
        console.error('Deduct credits error:', error);
        throw new Error('Failed to deduct credits: ' + error.message);
    }
}

// Helper function to update monthly sent counter
async function updateMonthlySent(userId) {
    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();
    
    try {
        await dbConfig.run(`
            INSERT INTO monthly_usage_stats (user_id, month, year, letters_sent)
            VALUES (?, ?, ?, 1)
            ON CONFLICT(user_id, month, year) DO UPDATE SET
        letters_sent = letters_sent + 1,
        updated_at = CURRENT_TIMESTAMP
        `, [userId, month, year]);
        return { success: true };
    } catch (error) {
        console.error('Update monthly sent error:', error);
        throw new Error('Failed to update monthly sent counter');
    }
}

// ============================================
// END CREDITS MANAGEMENT HELPER FUNCTIONS
// ============================================

// Auth endpoints
// Email configuration
function createTransporter(smtpUser, smtpPass) {
    return nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtppro.zoho.in',
        port: parseInt(process.env.SMTP_PORT) || 465,
        secure: true, // SSL
        auth: {
            user: smtpUser,
            pass: smtpPass,
        },
    });
}

// API endpoint for file uploads (protected)
app.post('/api/upload-profile', authenticateToken, upload.fields([
    { name: 'resume', maxCount: 1 },
    { name: 'photo', maxCount: 1 },
    { name: 'signature', maxCount: 1 }
]), async (req, res) => {
    try {
        const userId = req.user.id;
        
        console.log('Upload request from user:', userId);
        console.log('Files received:', req.files);
        
        // Process photo to circular format if uploaded
        if (req.files['photo']) {
            try {
        const photoFile = req.files['photo'][0];
        const size = 500; // Output size in pixels
        
        // Read the uploaded image
        const imageBuffer = await fs.readFile(photoFile.path);
        
        // Create circular mask
        const circularMask = Buffer.from(
            `<svg width="${size}" height="${size}">
                <circle cx="${size/2}" cy="${size/2}" r="${size/2}" fill="white"/>
            </svg>`
        );
        
        // Process image: resize, composite with circular mask
        const circularImage = await sharp(imageBuffer)
            .resize(size, size, { 
                fit: 'cover',
                position: 'center'
            })
            .composite([{
                input: circularMask,
                blend: 'dest-in'
            }])
            .png()
            .toBuffer();
        
        // Save the circular image
        await fs.writeFile(photoFile.path, circularImage);
        console.log('✅ Converted photo to circular format');
        
            } catch (error) {
        console.error('Error converting photo to circular:', error);
        // Continue anyway - the upload still works
            }
        }
        
        // Convert absolute paths to relative paths for database storage
        const files = {
            resume: req.files['resume'] ? req.files['resume'][0].path.replace(__dirname + '/', '') : null,
            photo: req.files['photo'] ? req.files['photo'][0].path.replace(__dirname + '/', '') : null,
            signature: req.files['signature'] ? req.files['signature'][0].path.replace(__dirname + '/', '') : null,
        };
        
        console.log('File paths (relative):', files);

        // Update user's file paths in database
        const updates = [];
        const params = [];

        if (files.resume) {
            updates.push('resume_path = ?');
            params.push(files.resume);
        }
        const resumeUploaded = !!files.resume;
        if (files.photo) {
            updates.push('photo_path = ?');
            params.push(files.photo);
        }
        if (files.signature) {
            updates.push('signature_path = ?');
            params.push(files.signature);
        }

        if (updates.length > 0) {
            params.push(userId);
            const sql = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;

            try {
        await dbConfig.run(sql, params);

        // Trigger background resume metadata extraction (fire-and-forget)
        if (resumeUploaded) {
            triggerResumeParsingBackground(userId, files.resume);
        }

        res.json({
            success: true,
            message: 'Files uploaded successfully',
            files,
        });
            } catch (err) {
        console.error('Database update error:', err);
        return res.status(500).json({ error: 'Failed to save file information' });
            }
        } else {
            res.json({
        success: true,
        message: 'No files to upload',
            });
        }
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Save/Update recipients for a user
// ============================================
// CREDITS MANAGEMENT API ENDPOINTS
// ============================================

// API endpoint to get all available plans
// ============================================
// CREDITS AND USAGE - Now in server/controllers/creditsController.js
// ============================================

// API endpoint to get user profile data (protected)
app.get('/api/user-profile', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;

        const user = await dbConfig.get('SELECT full_name as "fullName", email, resume_path as "resumePath", photo_path as "photoPath", signature_path as "signaturePath", smtp_email as "smtpEmail", smtp_password as "smtpPassword", sender_name as "senderName", date_of_birth as "dateOfBirth", phone_number as "phoneNumber", address, gender, created_at as "createdAt", oauth_provider as "oauthProvider" FROM users WHERE id = ?', [userId]);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Decrypt SMTP password before sending (only send masked version to frontend)
        const decryptedPassword = user.smtpPassword ? '********' : '';

        // Format DOB as date-only string using toLocaleDateString to avoid timezone shifts
        let formattedDOB = null;
        if (user.dateOfBirth) {
            const date = new Date(user.dateOfBirth);
            // 'en-CA' gives YYYY-MM-DD format without timezone conversion
            formattedDOB = date.toLocaleDateString('en-CA');
        }

        res.json({
            success: true,
            profile: {
        fullName: user.fullName,
        email: user.email,
        resumePath: user.resumePath,
        photoPath: user.photoPath,
        signaturePath: user.signaturePath,
        smtpEmail: user.smtpEmail,
        smtpPassword: decryptedPassword, // Send masked password
        senderName: user.senderName,
        dateOfBirth: formattedDOB,
        phoneNumber: user.phoneNumber,
        address: user.address,
        gender: user.gender || '',
        createdAt: user.createdAt,
        oauthProvider: user.oauthProvider || null,
            }
        });
    } catch (error) {
        console.error('Profile fetch error:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// API endpoint to save email settings (protected)
app.post('/api/save-settings', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { email, password, name } = req.body;

        if (!email || !password || !name) {
            return res.status(400).json({ error: 'All fields are required' });
        }

        // Encrypt SMTP password before storing
        const encryptedPassword = encryptData(password);

        await dbConfig.run(
            'UPDATE users SET smtp_email = ?, smtp_password = ?, sender_name = ? WHERE id = ?',
            [email, encryptedPassword, name, userId]
        );

        res.json({
            success: true,
            message: 'Settings saved successfully'
        });
    } catch (error) {
        console.error('Settings update error:', error);
        res.status(500).json({ error: 'Failed to save settings' });
    }
});

// API endpoint to update user personal details (protected)
app.post('/api/update-user-details', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { fullName, dateOfBirth, phoneNumber, address, city, country, zipcode, gender } = req.body;

        if (!fullName) {
            return res.status(400).json({ error: 'Full name is required' });
        }

        // Optional self-declared gender (consent-based, used to auto-fill pronoun/gender questions).
        // Only three allowed values; '' clears it. `undefined` = field not sent → leave unchanged.
        let genderValue;
        if (gender !== undefined) {
            const allowed = ['Male', 'Female', 'Prefer Not to Say', ''];
            if (!allowed.includes(gender)) {
                return res.status(400).json({ error: 'Invalid gender value' });
            }
            genderValue = gender === '' ? null : gender;
        }

        // THE NOON TRICK: Set time to 12:00 PM to prevent midnight timezone shifts
        let dateOnly = null;
        if (dateOfBirth) {
            const date = new Date(dateOfBirth);
            date.setHours(12, 0, 0, 0);

            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            dateOnly = `${year}-${month}-${day}`;
        }

        if (gender !== undefined) {
            await dbConfig.run(
                'UPDATE users SET full_name = ?, date_of_birth = ?, phone_number = ?, address = ?, gender = ? WHERE id = ?',
                [fullName, dateOnly, phoneNumber || null, address || null, genderValue, userId]
            );
        } else {
            await dbConfig.run(
                'UPDATE users SET full_name = ?, date_of_birth = ?, phone_number = ?, address = ? WHERE id = ?',
                [fullName, dateOnly, phoneNumber || null, address || null, userId]
            );
        }

        res.json({
            success: true,
            message: 'User details updated successfully'
        });
    } catch (error) {
        console.error('User details update error:', error);
        res.status(500).json({ error: 'Failed to update user details' });
    }
});

// API endpoint to change password (protected)
app.post('/api/auth/change-password', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { currentPassword, newPassword } = req.body;

        if (!newPassword) {
            return res.status(400).json({ error: 'New password is required' });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({ error: 'New password must be at least 6 characters long' });
        }

        // Get current user from database
        const user = await dbConfig.get('SELECT password, oauth_provider FROM users WHERE id = ?', [userId]);
        
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // OAuth users can set a password without providing current password
        // (their password field contains a JWT placeholder, not a real password)
        if (!user.oauth_provider) {
            if (!currentPassword) {
                return res.status(400).json({ error: 'Current password is required' });
            }
            const isValidPassword = await bcrypt.compare(currentPassword, user.password);
            if (!isValidPassword) {
                return res.status(401).json({ error: 'Current password is incorrect' });
            }
        }

        // Hash new password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);

        // Update password in database
        await dbConfig.run(
            'UPDATE users SET password = ? WHERE id = ?',
            [hashedPassword, userId]
        );

        console.log(`✅ Password changed successfully for user ${userId}`);

        res.json({
            success: true,
            message: 'Password changed successfully'
        });
    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({ error: 'Failed to change password' });
    }
});

// API endpoint to update privacy settings (protected)
app.post('/api/users/privacy-settings', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { emailNotifications, smsNotifications, profilePublic } = req.body;

        // Store privacy settings as JSON
        const privacySettings = {
            emailNotifications: emailNotifications !== false,  // Default true
            smsNotifications: smsNotifications === true,       // Default false
            profilePublic: profilePublic === true              // Default false
        };

        // In future, add privacy_settings column to users table
        // For now, just return success (settings handled client-side)
        
        console.log(`✅ Privacy settings updated for user ${userId}:`, privacySettings);

        res.json({
            success: true,
            message: 'Privacy settings updated successfully',
            privacySettings: privacySettings
        });
    } catch (error) {
        console.error('Privacy settings error:', error);
        res.status(500).json({ error: 'Failed to update privacy settings' });
    }
});

// Helper function to create cover letter (from create-cover-letter.js)
async function createCoverLetter(companyName, position, recipientEmail) {
    const CONFIG = {
        companyName: companyName,
        position: position,
        recipientName: 'Hiring Manager',
        country: 'India',
        relevantSkills: process.env.RELEVANT_SKILLS || 'JavaScript, React, Node.js',
        companyParagraph: process.env.COMPANY_PARAGRAPH || `I am particularly drawn to ${companyName}'s innovative approach and commitment to excellence.`,
    };

    const pdfDoc = await PDFDocument.create();
    pdfDoc.registerFontkit(fontkit);
    const pageWidth = 595;
    const pageHeight = 1067;
    const page = pdfDoc.addPage([pageWidth, pageHeight]);

    // Embed Lato font
    const latoRegularBytes = await fs.readFile(path.join(__dirname, 'fonts', 'Lato-Regular.ttf'));
    const latoBoldBytes = await fs.readFile(path.join(__dirname, 'fonts', 'Lato-Bold.ttf'));
    const helvetica = await pdfDoc.embedFont(latoRegularBytes);
    const helveticaBold = await pdfDoc.embedFont(latoBoldBytes);

    // Helper function for text wrapping - preserves sentence structure
    function wrapText(text, maxWidth, font, fontSize) {
        const lines = [];
        
        // Split by sentences first (better readability)
        const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
        
        for (const sentence of sentences) {
            const sentenceWidth = font.widthOfTextAtSize(sentence.trim(), fontSize);
            
            // If sentence fits on one line, add it
            if (sentenceWidth <= maxWidth) {
        lines.push(sentence.trim());
            } else {
        // If sentence is too long, wrap by words
        const words = sentence.trim().split(' ');
        let currentLine = '';
        
        for (const word of words) {
            const testLine = currentLine ? `${currentLine} ${word}` : word;
            const testWidth = font.widthOfTextAtSize(testLine, fontSize);
            
            if (testWidth > maxWidth && currentLine) {
                lines.push(currentLine);
                currentLine = word;
            } else {
                currentLine = testLine;
            }
        }
        
        if (currentLine) {
            lines.push(currentLine);
        }
            }
        }
        
        return lines;
    }

    // LEFT SIDEBAR (dark background)
    const sidebarWidth = 180;
    page.drawRectangle({
        x: 0,
        y: 0,
        width: sidebarWidth,
        height: pageHeight,
        color: rgb(0.15, 0.15, 0.2),
    });

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
            doc.font('Lato-Bold').fontSize(24).fillColor('#ffffff');
            doc.text(initials, photoX - 20, photoY - 12, { width: 40, align: 'center' });
        }
    } else {
        // No photo - draw circle with initials
        doc.circle(photoX, photoY, photoSize/2).lineWidth(2).stroke('#ffffff');
        const initials = userData.fullName ? userData.fullName.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) : 'RS';
        doc.font('Lato-Bold').fontSize(24).fillColor('#ffffff');
        doc.text(initials, photoX - 20, photoY - 12, { width: 40, align: 'center' });
    }

    // Sidebar sections - START LOWER (gap after photo)
    let sidebarY = photoY + photoSize/2 + 40;
    
    // TO section
    doc.font('Lato-Bold').fontSize(11).fillColor('#ffffff');
    doc.text('TO', 20, sidebarY);
    sidebarY += 20;
    
    doc.font('Lato').fontSize(10).fillColor('#ffffff');
    doc.text('Hiring Manager,', 20, sidebarY);
    sidebarY += 16;
    
    // Wrap company name if too long
    const companyNameLines = wrapText(companyName, maxSidebarWidth, helvetica, 10);
    for (const line of companyNameLines) {
        doc.text(line, {
            x: 20,
            y: sidebarY,
            size: 10,
            font: helvetica,
            color: rgb(1, 1, 1),
        });
        sidebarY -= 16;
    }

    sidebarY -= 4;
    
    // Separator line after TO section
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
    
    // Separator line after FROM section
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
    
    // Contact info at bottom of sidebar
    const contactY = 100;
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
    
    // Header with name (LEFT) and contact details (RIGHT) on SAME ROW
    const headerY = contentY;
    const nameText = (userData.fullName || 'APPLICANT').toUpperCase().trim();
    
    // Name on left - adjusted 1px left to align with designation
    page.drawText(nameText, {
        x: contentX - 1,
        y: headerY,
        size: 18,
        font: helveticaBold,
        color: rgb(0, 0, 0),
    });
    
    // Contact details on right (moved up by 8px)
    const rightAlignX = pageWidth - 40;
    const contactFontSize = 9;
    const contactStartY = headerY + 10; // Moved up by 8px
    
    if (userData.city && userData.country) {
        const locationText = `${userData.city}, ${userData.country}`;
        const locationWidth = helvetica.widthOfTextAtSize(locationText, contactFontSize);
        page.drawText(locationText, {
            x: rightAlignX - locationWidth,
            y: contactStartY,
            size: contactFontSize,
            font: helvetica,
            color: rgb(0.3, 0.3, 0.3),
        });
    }
    
    if (userData.phoneNumber) {
        const phoneWidth = helvetica.widthOfTextAtSize(userData.phoneNumber, contactFontSize);
        page.drawText(userData.phoneNumber, {
            x: rightAlignX - phoneWidth,
            y: contactStartY - 15,
            size: contactFontSize,
            font: helvetica,
            color: rgb(0.3, 0.3, 0.3),
        });
    }
    
    if (userData.email) {
        const emailWidth = helvetica.widthOfTextAtSize(userData.email, contactFontSize);
        page.drawText(userData.email, {
            x: rightAlignX - emailWidth,
            y: contactStartY - 30,
            size: contactFontSize,
            font: helvetica,
            color: rgb(0.3, 0.3, 0.3),
        });
    }
    
    // Move down for designation (below name) - reduced gap by 5px
    contentY = headerY - 15;
    
    // Designation below name - EXACTLY at contentX (same as name)
    const designation = userData.designation || 'Applicant';
    page.drawText(designation, {
        x: contentX,
        y: contentY,
        size: 11,
        font: helvetica,
        color: rgb(0.4, 0.4, 0.4),
    });

    contentY -= 20; // Space before separator line

    // Separator line
    page.drawLine({
        start: { x: contentX, y: contentY },
        end: { x: pageWidth - 40, y: contentY },
        thickness: 1,
        color: rgb(0.8, 0.8, 0.8),
    });

    contentY -= 45; // Space before Cover Letter heading (increased by 20px)
    
    // "Cover Letter" heading
    page.drawText('Cover Letter', {
        x: contentX,
        y: contentY,
        size: 14,
        font: helveticaBold,
        color: rgb(0.2, 0.2, 0.2),
    });

    contentY -= 40; // Space before body (increased by 10px)

    // Cover letter body
    const paragraphs = ['Dear Hiring Manager,', ...coverLetterText.split('\n').filter(p => p.trim())];

    const paragraphFontSize = 10;
    const lineHeight = 16;

    for (const para of paragraphs) {
        const lines = wrapText(para, contentWidth, helvetica, paragraphFontSize);
        for (const line of lines) {
            if (contentY < 150) {
        // Would need new page - for now just stop
        break;
            }
            
            page.drawText(line, {
        x: contentX,
        y: contentY,
        size: paragraphFontSize,
        font: helvetica,
        color: rgb(0, 0, 0),
            });
            contentY -= lineHeight;
        }
        contentY -= 10;
    }

    // Closing
    contentY -= 20;
    page.drawText('Best regards,', {
        x: contentX,
        y: contentY,
        size: 10,
        font: helvetica,
        color: rgb(0, 0, 0),
    });
    
    contentY -= 30;

    // Add signature if provided
    if (signaturePath) {
        try {
            const signatureBytes = await fs.readFile(signaturePath);
            const signatureImage = await pdfDoc.embedPng(signatureBytes);
            page.drawImage(signatureImage, {
        x: contentX,
        y: contentY - 30,
        width: 120,
        height: 40,
            });
            contentY -= 50;
        } catch (error) {
            console.log('Could not embed signature');
        }
    }

    page.drawText((userData.fullName || 'APPLICANT').toUpperCase(), {
        x: contentX,
        y: contentY,
        size: 10,
        font: helveticaBold,
        color: rgb(0, 0, 0),
    });

    const pdfBytes = await pdfDoc.save();
    const currentDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
    const sanitizedCompanyName = companyName.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
    const fileName = `Cover_Letter_${currentDate}_${sanitizedCompanyName}.pdf`;
    const filePath = path.join(__dirname, 'temp', fileName);

    await fs.mkdir(path.join(__dirname, 'temp'), { recursive: true });
    await fs.writeFile(filePath, pdfBytes);
    
    console.log(`✅ PDF created: ${fileName} (${(pdfBytes.length / 1024).toFixed(2)} KB)`);

    return { filePath, fileName };
}

// NEW: PDF generator using PDFKit - much better font support
// Creates two-column cover letter with proper text rendering and bold support
// Single page with dynamic height based on content
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
            const filePath = path.join(__dirname, 'temp', fileName);
            
            await fs.mkdir(path.join(__dirname, 'temp'), { recursive: true });
            
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
            const latoRegularPath = path.join(__dirname, 'fonts', 'Lato-Regular.ttf');
            const latoBoldPath = path.join(__dirname, 'fonts', 'Lato-Bold.ttf');
            
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
                    doc.font('Lato-Bold').fontSize(24).fillColor('#ffffff');
                    doc.text(initials, photoX - 20, photoY - 12, { width: 40, align: 'center' });
                }
            } else {
                // No photo - draw circle with initials
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
            
            // Company name (PDFKit auto-wraps with width option)
            doc.text(companyName, 20, sidebarY, { width: sidebarWidth - 40 });
            sidebarY = doc.y + 4;
            
            // Separator line after TO section
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
            
            // Separator line after FROM section
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
            
            // Contact info at bottom of sidebar
            const contactY = 100;
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
            
            // Header with name (LEFT) and contact details (RIGHT) on SAME ROW
            const headerY = contentY;
            const nameText = (userData.fullName || 'APPLICANT').toUpperCase().trim();
            
            // Name on left (bold, 18pt)
            doc.font('Lato-Bold').fontSize(18).fillColor('#000000');
            doc.text(nameText, contentX - 1, headerY, { lineBreak: false });

            // Contact details on right
            const rightContentWidth = pageWidth - 40 - contentX;
            doc.font('Lato').fontSize(9).fillColor('#444444');
            let contactPosY = headerY - 2;
            if (userData.city && userData.country) {
                doc.text(`${userData.city}, ${userData.country}`, contentX, contactPosY, {
                    align: 'right', width: rightContentWidth, lineBreak: false
                });
                contactPosY += 13;
            }
            if (userData.phoneNumber) {
                doc.text(userData.phoneNumber, contentX, contactPosY, {
                    align: 'right', width: rightContentWidth, lineBreak: false
                });
                contactPosY += 13;
            }
            if (userData.email) {
                doc.text(userData.email, contentX, contactPosY, {
                    align: 'right', width: rightContentWidth, lineBreak: false
                });
            }

            // Designation below name
            contentY = headerY + 22;
            doc.font('Lato').fontSize(11).fillColor('#666666');
            const designation = userData.designation || 'Applicant';
            doc.text(designation, contentX, contentY, { lineBreak: false });

            contentY += 25;

            // Separator line
            doc.moveTo(contentX, contentY).lineTo(pageWidth - 40, contentY).lineWidth(1).stroke('#cccccc');

            contentY += 45;

            // Cover Letter heading
            doc.font('Lato-Bold').fontSize(14).fillColor('#333333');
            doc.text('Cover Letter', contentX, contentY, { lineBreak: false });

            contentY += 40;

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
            
            // Process paragraphs for rendering
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
            contentY += 12;
            doc.font('Lato').fontSize(10).fillColor('#000000');
            doc.text('Best regards,', contentX, contentY, { lineBreak: false });

            contentY += 30;

            // Signature if provided
            if (signaturePath) {
                try {
                    doc.image(signaturePath, contentX, contentY, { width: 120, height: 40 });
                    contentY += 50;
                } catch (sigError) {
                    console.log('Could not embed signature');
                }
            }

            // Applicant name
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
async function createCoverLetterPDF(userData, coverLetterText, companyName, photoPath, signaturePath) {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.registerFontkit(fontkit);
    const pageWidth = 595;
    const pageHeight = 1067;
    const page = pdfDoc.addPage([pageWidth, pageHeight]);

    // Embed Lato font
    const latoRegularBytes = await fs.readFile(path.join(__dirname, 'fonts', 'Lato-Regular.ttf'));
    const latoBoldBytes = await fs.readFile(path.join(__dirname, 'fonts', 'Lato-Bold.ttf'));
    const helvetica = await pdfDoc.embedFont(latoRegularBytes);
    const helveticaBold = await pdfDoc.embedFont(latoBoldBytes);

    // Helper function for text wrapping - preserves sentence structure
    function wrapText(text, maxWidth, font, fontSize) {
        const lines = [];
        
        // Split by sentences first (better readability)
        const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
        
        for (const sentence of sentences) {
            const sentenceWidth = font.widthOfTextAtSize(sentence.trim(), fontSize);
            
            // If sentence fits on one line, add it
            if (sentenceWidth <= maxWidth) {
        lines.push(sentence.trim());
            } else {
        // If sentence is too long, wrap by words
        const words = sentence.trim().split(' ');
        let currentLine = '';
        
        for (const word of words) {
            const testLine = currentLine ? `${currentLine} ${word}` : word;
            const testWidth = font.widthOfTextAtSize(testLine, fontSize);
            
            if (testWidth > maxWidth && currentLine) {
                lines.push(currentLine);
                currentLine = word;
            } else {
                currentLine = testLine;
            }
        }
        
        if (currentLine) {
            lines.push(currentLine);
        }
            }
        }
        
        return lines;
    }

    // LEFT SIDEBAR (dark background)
    const sidebarWidth = 180;
    page.drawRectangle({
        x: 0,
        y: 0,
        width: sidebarWidth,
        height: pageHeight,
        color: rgb(0.15, 0.15, 0.2),
    });

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
            doc.font('Lato-Bold').fontSize(24).fillColor('#ffffff');
            doc.text(initials, photoX - 20, photoY - 12, { width: 40, align: 'center' });
        }
    } else {
        // No photo - draw circle with initials
        doc.circle(photoX, photoY, photoSize/2).lineWidth(2).stroke('#ffffff');
        const initials = userData.fullName ? userData.fullName.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) : 'RS';
        doc.font('Lato-Bold').fontSize(24).fillColor('#ffffff');
        doc.text(initials, photoX - 20, photoY - 12, { width: 40, align: 'center' });
    }

    // Sidebar sections - START LOWER (gap after photo)
    let sidebarY = photoY + photoSize/2 + 40;
    
    // TO section
    doc.font('Lato-Bold').fontSize(11).fillColor('#ffffff');
    doc.text('TO', 20, sidebarY);
    sidebarY += 20;
    
    doc.font('Lato').fontSize(10).fillColor('#ffffff');
    doc.text('Hiring Manager,', 20, sidebarY);
    sidebarY += 16;
    
    // Wrap company name if too long
    const companyNameLines = wrapText(companyName, maxSidebarWidth, helvetica, 10);
    for (const line of companyNameLines) {
        doc.text(line, {
            x: 20,
            y: sidebarY,
            size: 10,
            font: helvetica,
            color: rgb(1, 1, 1),
        });
        sidebarY -= 16;
    }

    sidebarY -= 4;
    
    // Separator line after TO section
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
    
    // Separator line after FROM section
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
    
    // Contact info at bottom of sidebar
    const contactY = 100;
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
    
    // Header with name (LEFT) and contact details (RIGHT) on SAME ROW
    const headerY = contentY;
    const nameText = (userData.fullName || 'APPLICANT').toUpperCase().trim();
    
    // Name on left - adjusted 1px left to align with designation
    page.drawText(nameText, {
        x: contentX - 1,
        y: headerY,
        size: 18,
        font: helveticaBold,
        color: rgb(0, 0, 0),
    });
    
    // Contact details on right (moved up by 8px)
    const rightAlignX = pageWidth - 40;
    const contactFontSize = 9;
    const contactStartY = headerY + 10; // Moved up by 8px
    
    if (userData.city && userData.country) {
        const locationText = `${userData.city}, ${userData.country}`;
        const locationWidth = helvetica.widthOfTextAtSize(locationText, contactFontSize);
        page.drawText(locationText, {
            x: rightAlignX - locationWidth,
            y: contactStartY,
            size: contactFontSize,
            font: helvetica,
            color: rgb(0.3, 0.3, 0.3),
        });
    }
    
    if (userData.phoneNumber) {
        const phoneWidth = helvetica.widthOfTextAtSize(userData.phoneNumber, contactFontSize);
        page.drawText(userData.phoneNumber, {
            x: rightAlignX - phoneWidth,
            y: contactStartY - 15,
            size: contactFontSize,
            font: helvetica,
            color: rgb(0.3, 0.3, 0.3),
        });
    }
    
    if (userData.email) {
        const emailWidth = helvetica.widthOfTextAtSize(userData.email, contactFontSize);
        page.drawText(userData.email, {
            x: rightAlignX - emailWidth,
            y: contactStartY - 30,
            size: contactFontSize,
            font: helvetica,
            color: rgb(0.3, 0.3, 0.3),
        });
    }
    
    // Move down for designation (below name) - reduced gap by 5px
    contentY = headerY - 15;
    
    // Designation below name - EXACTLY at contentX (same as name)
    const designation = userData.designation || 'Applicant';
    page.drawText(designation, {
        x: contentX,
        y: contentY,
        size: 11,
        font: helvetica,
        color: rgb(0.4, 0.4, 0.4),
    });

    contentY -= 20; // Space before separator line

    // Separator line
    page.drawLine({
        start: { x: contentX, y: contentY },
        end: { x: pageWidth - 40, y: contentY },
        thickness: 1,
        color: rgb(0.8, 0.8, 0.8),
    });

    contentY -= 45; // Space before Cover Letter heading (increased by 20px)
    
    // "Cover Letter" heading
    page.drawText('Cover Letter', {
        x: contentX,
        y: contentY,
        size: 14,
        font: helveticaBold,
        color: rgb(0.2, 0.2, 0.2),
    });

    contentY -= 40; // Space before body (increased by 10px)

    // Cover letter body
    const paragraphs = ['Dear Hiring Manager,', ...coverLetterText.split('\n').filter(p => p.trim())];

    const paragraphFontSize = 10;
    const lineHeight = 16;

    for (const para of paragraphs) {
        const lines = wrapText(para, contentWidth, helvetica, paragraphFontSize);
        for (const line of lines) {
            if (contentY < 150) {
        // Would need new page - for now just stop
        break;
            }
            
            page.drawText(line, {
        x: contentX,
        y: contentY,
        size: paragraphFontSize,
        font: helvetica,
        color: rgb(0, 0, 0),
            });
            contentY -= lineHeight;
        }
        contentY -= 10;
    }

    // Closing
    contentY -= 20;
    page.drawText('Best regards,', {
        x: contentX,
        y: contentY,
        size: 10,
        font: helvetica,
        color: rgb(0, 0, 0),
    });
    
    contentY -= 30;

    // Add signature if provided
    if (signaturePath) {
        try {
            const signatureBytes = await fs.readFile(signaturePath);
            const signatureImage = await pdfDoc.embedPng(signatureBytes);
            page.drawImage(signatureImage, {
        x: contentX,
        y: contentY - 30,
        width: 120,
        height: 40,
            });
            contentY -= 50;
        } catch (error) {
            console.log('Could not embed signature');
        }
    }

    page.drawText((userData.fullName || 'APPLICANT').toUpperCase(), {
        x: contentX,
        y: contentY,
        size: 10,
        font: helveticaBold,
        color: rgb(0, 0, 0),
    });

    const pdfBytes = await pdfDoc.save();
    const currentDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
    const sanitizedCompanyName = companyName.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
    const fileName = `Cover_Letter_${currentDate}_${sanitizedCompanyName}.pdf`;
    const filePath = path.join(__dirname, 'temp', fileName);

    await fs.mkdir(path.join(__dirname, 'temp'), { recursive: true });
    await fs.writeFile(filePath, pdfBytes);
    
    console.log(`✅ PDF created: ${fileName} (${(pdfBytes.length / 1024).toFixed(2)} KB)`);

    return { filePath, fileName };
}

// LEGACY: Old bulk-generate endpoint (now handled by batch routes and cover letter controller)
// Renamed from GET /api/download-cover-letter/:filename to avoid shadowing the actual download route
app.post('/api/generate-cover-letters-bulk', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { recipients } = req.body;

        if (!recipients || recipients.length === 0) {
            return res.status(400).json({ error: 'No recipients provided' });
        }

        // CHECK CREDITS - Each recipient requires 1 credit
        const creditsRequired = recipients.length;
        try {
            const creditCheck = await checkUserCredits(userId, creditsRequired);
            if (!creditCheck.hasCredits) {
        return res.status(402).json({ 
            error: creditCheck.message,
            remainingCredits: creditCheck.remaining,
            creditsRequired: creditsRequired
        });
            }
        } catch (error) {
            console.error('Credit check error:', error);
            return res.status(500).json({ error: 'Failed to check credit balance' });
        }

        // Get user's complete profile and files from database
        try {
            const user = await dbConfig.get('SELECT full_name as "fullName", email, phone_number as "phoneNumber", city, country, resume_path as "resumePath", photo_path as "photoPath", signature_path as "signaturePath" FROM users WHERE id = ?', [userId]);
            
            if (!user) {
        return res.status(404).json({ error: 'User not found' });
            }

            if (!user.resumePath) {
        return res.status(400).json({ 
            error: 'Resume is required. Please upload your resume in the Profile page.' 
        });
            }

            const results = [];
            let creditsDeducted = 0;

            // Prepare user data for AI generation
            const userData = {
        fullName: user.fullName,
        email: user.email,
        phoneNumber: user.phoneNumber,
        city: user.city,
        country: user.country
            };

            const resumePath = path.join(__dirname, user.resumePath);
            const photoPath = user.photoPath ? path.join(__dirname, user.photoPath) : null;
            const signaturePath = user.signaturePath ? path.join(__dirname, user.signaturePath) : null;

        console.log('\n📝 Generating cover letters...');
        console.log(`📧 Generating for ${recipients.length} recipient(s)`);

        for (const recipient of recipients) {
            try {
                console.log(`\n📤 Processing: ${recipient.email}`);

                // Use template generator for DEEP RESEARCH, returns TEXT
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

                const companyName = coverLetterResult.companyName;
                const coverLetterText = coverLetterResult.coverLetter; // This is TEXT now
                
                console.log(`✅ Generated personalized cover letter for ${companyName}`);
                console.log(`📊 Metadata:`, coverLetterResult.metadata);

                // DEDUCT CREDIT for successful generation
                try {
                    await deductCredits(userId, 1, 'cover_letter_generation', {
                        companyName: companyName,
                        position: recipient.position,
                        recipientEmail: recipient.email
                    });
                    creditsDeducted++;
                    console.log(`💳 Deducted 1 credit (${creditsDeducted}/${recipients.length})`);
                } catch (creditError) {
                    console.error('Failed to deduct credit:', creditError);
                    // Continue anyway - letter was generated
                }

                // Format cover letter with HTML (bold key points) - same as mobile
                const coverLetterHtml = formatCoverLetterWithHTML(coverLetterText, coverLetterResult.metadata);
                console.log(`📝 HTML formatted for PDF generation`);

                // Use common PDF generation function (same as mobile)
                const { filePath, fileName } = await generateCoverLetterPDF(
                    user,
                    coverLetterHtml,
                    companyName,
                    recipientEmail
                );

                console.log(`📄 Created PDF: ${fileName}`);

                // Generate download URL
                const downloadUrl = `/api/download-cover-letter/${encodeURIComponent(fileName)}`;

                results.push({
                    email: recipient.email,
                    company: companyName,
                    position: recipient.position || 'Position',
                    website: recipient.website,
                    fileName: fileName,
                    downloadUrl: downloadUrl,
                    status: 'generated',
                    metadata: coverLetterResult.metadata
                });

                console.log(`✅ Cover letter ready for ${recipient.email}`);

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
            try {
                await dbConfig.run(
                    'UPDATE users SET total_generated = total_generated + ? WHERE id = ?',
                    [successCount, userId]
                );
                console.log(`📊 Updated total_generated counter: +${successCount}`);
            } catch (error) {
                console.error('⚠️ Failed to update counter:', error.message);
            }
        }
        
        console.log(`\n✅ Generated: ${successCount}/${recipients.length} cover letters`);
        console.log(`💳 Total credits deducted: ${creditsDeducted}`);
        
        // Get updated credit balance
        try {
            const creditCheck = await checkUserCredits(userId, 0);
            res.json({
                success: true,
                message: `Generated ${successCount}/${recipients.length} cover letters`,
                results,
                creditsUsed: creditsDeducted,
                creditsRemaining: creditCheck.remaining
            });
        } catch {
            res.json({
                success: true,
                message: `Generated ${successCount}/${recipients.length} cover letters`,
                results,
                creditsUsed: creditsDeducted
            });
        }
        } catch (error) {
            console.error('Database error:', error);
            return res.status(500).json({ error: 'Failed to load user profile' });
        }
    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================================
// COVER LETTER & EMAIL MODULES - Now properly separated into controllers
// ============================================================================
// All cover letter generation endpoints are now in:
//   - server/controllers/coverLetterController.js
//   - server/routes/coverLetterRoutes.js (mounted below)
//
// All email/application sending endpoints are now in:
//   - server/controllers/emailController.js  
//   - server/routes/emailRoutes.js (mounted below)
//
// These routes are mounted at lines ~3206-3207 with:
//   app.use('/api', coverLetterRoutes);
//   app.use('/api', emailRoutes);
// ============================================================================
// NOTE: The following lines are for debugging and should be removed in production

// Debug endpoint to test cover letter generation
app.post('/api/test-cover-letter', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { companyName, position, recipientEmail } = req.body;

        if (!companyName || !position || !recipientEmail) {
            return res.status(400).json({ error: 'All fields are required' });
        }

        // Get user profile
        try {
            const user = await dbConfig.get('SELECT * FROM users WHERE id = ?', [userId]);
            
            if (!user) {
        console.error('User not found:', userId);
        return res.status(500).json({ error: 'User not found' });
            }

            try {
        // Use common PDF generation function
        const { filePath, fileName } = await generateCoverLetterPDF(
            user,
            formatCoverLetterWithHTML('Dear Hiring Manager, I am writing to express my strong interest in the ${position} position at ${companyName}. With my extensive experience in ${RELEVANT_SKILLS}, I am confident that I would be a valuable addition to your team.', companyName),
            companyName,
            recipientEmail
        );

        console.log(`📄 Generated PDF: ${fileName}`);

        res.json({
            success: true,
            downloadUrl: `/api/download-cover-letter/${encodeURIComponent(fileName)}`,
            fileName: fileName
        });

            } catch (error) {
        console.error('Error generating PDF:', error);
        console.error('Error stack:', error.stack);
        return res.status(500).json({ error: error.message || 'Failed to generate PDF' });
            }
        } catch (error) {
            console.error('Database error:', error);
            return res.status(500).json({ error: 'Failed to load user profile' });
        }
    } catch (error) {
        console.error('Server error:', error);
        console.error('Server error stack:', error.stack);
        return res.status(500).json({ error: error.message || 'Server error' });
    }
});

// ============================================================================
// ADMIN - CREDIT PACKAGE MANAGEMENT
// ============================================
// Note: Admin package management endpoints would go here
// The is-admin check endpoint is defined later in the file

// Skipped duplicate/incorrect cover letter generation endpoint
// (was mislabeled as /api/generate-cover-letter-pdf but had different implementation)

/* COMMENTED OUT DUPLICATE ENDPOINT - START
// API endpoint to generate cover letter PDF for download
app.post('/api/generate-cover-letter-pdf', authenticateToken, async (req, res) => {
    try {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📨 [${requestId}] REQUEST RECEIVED at ${new Date().toISOString()}`);
    console.log(`   IP: ${req.ip}, UserAgent: ${req.get('user-agent')?.substring(0, 50)}...`);
    console.log(`🔑 [${requestId}] GEMINI_API_KEY STATUS: ${process.env.GEMINI_API_KEY ? 'LOADED (length: ' + process.env.GEMINI_API_KEY.length + ')' : '❌ MISSING'}`);
    
    try {
        const userId = req.user.id;
        let { recipientEmail, websiteUrl, position } = req.body;

        // Normalize website URL - auto-prepend https:// if missing
        if (websiteUrl && !websiteUrl.match(/^https?:\/\//)) {
            websiteUrl = 'https://' + websiteUrl;
        }

        console.log(`🔍 [${requestId}] Parsing request body:`, { userId, recipientEmail, websiteUrl, position });

        // CHECK CREDITS - 1 credit required for generation
        try {
            const creditCheck = await checkUserCredits(userId, 1);
            if (!creditCheck.hasCredits) {
        console.warn(`⚠️ [${requestId}] Insufficient credits:`, creditCheck.message);
        return res.status(402).json({ 
            error: creditCheck.message,
            remainingCredits: creditCheck.remaining,
            creditsRequired: 1
        });
            }
            console.log(`✅ [${requestId}] Credits available: ${creditCheck.remaining}`);
        } catch (error) {
            console.error(`❌ [${requestId}] Credit check error:`, error);
            return res.status(500).json({ error: 'Failed to check credit balance' });
        }

        // Get user profile
        try {
            const user = await dbConfig.get('SELECT * FROM users WHERE id = ?', [userId]);
            
            if (!user) {
        console.error(`❌ [${requestId}] User not found:`, userId);
        return res.status(500).json({ error: 'User not found' });
            }

            console.log(`✅ [${requestId}] User loaded: ${user.email}`);

            if (!user.resume_path) {
        console.error(`❌ [${requestId}] Resume not found for user:`, userId);
        return res.status(400).json({ error: 'Resume is required. Please upload your resume first.' });
            }

            try {
        // Prepare user data
        const userData = {
            fullName: user.full_name,
            email: user.email,
            phoneNumber: user.phone_number,
            city: user.city,
            country: user.country
        };

        const resumePath = path.join(__dirname, user.resume_path);
        console.log(`📂 [${requestId}] Resume path:`, resumePath);
        
        // First, generate hiring manager name, all locations, and subject using AI
        console.log(`⏳ [${requestId}] Generating additional details (calling Gemini AI - may take 30-60 seconds)...`);
        // Extract company name from URL for initial lookup (handles subdomains like career.limeflight.com)
        let urlCompanyName;
        try {
            const parsedUrl = new URL(websiteUrl.startsWith('http') ? websiteUrl : `https://${websiteUrl}`);
            const hostname = parsedUrl.hostname.replace('www.', '').toLowerCase();
            const hostParts = hostname.split('.');
            const genericSubdomains = ['career', 'careers', 'jobs', 'job', 'hiring', 'recruit', 'recruiting', 'recruitment', 'talent', 'join', 'work', 'apply', 'opportunities', 'portal', 'app', 'hr', 'people', 'team', 'boards', 'board'];
            urlCompanyName = hostParts[0];
            if (genericSubdomains.includes(urlCompanyName) && hostParts.length >= 3) {
                urlCompanyName = hostParts[1];
            }
        } catch {
            urlCompanyName = websiteUrl.replace(/^https?:\/\/(www\.)?/, '').split('/')[0].split('.')[0];
        }
        const initialCompanyName = urlCompanyName.charAt(0).toUpperCase() + urlCompanyName.slice(1);
        const { hiringManager, locations, subject } = await generateAdditionalDetails(websiteUrl, initialCompanyName, position);
        const additionalDetailsDuration = Date.now() - additionalDetailsStart;
        console.log(`✅ [${requestId}] Generated additional details in ${additionalDetailsDuration}ms`);
        console.log(`   Locations: ${locations.length}, Headquarters: ${locations.find(l => l.isHeadquarters)?.country || 'Unknown'}`);
        console.log(`   Subject: ${subject.substring(0, 50)}...`);
        
        // Generate cover letter with AI (pass locations for dynamic relocation text)
        const generator = new TemplateCoverLetterGenerator();
        console.log(`⏳ [${requestId}] Generating cover letter with location context...`);
        
        const result = await generator.generateCoverLetter(
            userData,
            resumePath,
            recipientEmail,
            websiteUrl,
            position,
            locations
        );

        console.log(`✅ [${requestId}] Cover letter generated successfully:`, result.success);

        if (!result.success) {
            console.error(`❌ [${requestId}] Cover letter generation failed`);
            return res.status(500).json({ error: 'Failed to generate cover letter' });
        }

        // DEDUCT CREDIT for successful generation
        try {
            await deductCredits(userId, 1, 'cover_letter_generation', {
                companyName: result.companyName,
                position: position,
                recipientEmail: recipientEmail
            });
            // Update total_generated counter
            await dbConfig.run(
                'UPDATE users SET total_generated = total_generated + 1 WHERE id = ?',
                [userId]
            );
            console.log(`💳 [${requestId}] Deducted 1 credit and updated counter`);
        } catch (creditError) {
            console.error(`❌ [${requestId}] Failed to deduct credit:`, creditError);
            // Continue anyway - letter was generated
        }

        // Format cover letter with HTML (bold key points)
        const coverLetterHtml = formatCoverLetterWithHTML(result.coverLetter, result.metadata);
        console.log(`📝 [${requestId}] HTML formatted, length: ${coverLetterHtml.length}`);

        // Get updated credit balance
        let creditsRemaining = null;
        try {
            const creditCheck = await checkUserCredits(userId, 0);
            creditsRemaining = creditCheck.remaining;
        } catch (error) {
            console.error(`❌ [${requestId}] Failed to fetch updated credits:`, error);
        }

        const responseData = {
            success: true,
            companyName: result.companyName,
            hiringManager: hiringManager,
            subject: subject,
            locations: locations,
            coverLetterHtml: coverLetterHtml,
            metadata: result.metadata,
            creditsUsed: 1,
            creditsRemaining: creditsRemaining
        };

        console.log(`📤 [${requestId}] Preparing response... data keys:`, Object.keys(responseData));
        console.log(`📤 [${requestId}] Response size: ${JSON.stringify(responseData).length} bytes`);
        console.log(`💳 [${requestId}] Credits remaining: ${creditsRemaining}`);
        
        // Log response before sending
        console.log(`📤 [${requestId}] Setting response headers...`);
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Connection', 'keep-alive');
        
        console.log(`📤 [${requestId}] Calling res.json()...`);
        res.json(responseData);
        
        const duration = Date.now() - startTime;
        console.log(`✅ [${requestId}] RESPONSE SENT successfully in ${duration}ms`);
        console.log(`${'='.repeat(60)}\n`);

            } catch (error) {
        const duration = Date.now() - startTime;
        console.error(`❌ [${requestId}] Error generating cover letter details (after ${duration}ms):`, error.message);
        console.error(`❌ [${requestId}] Error stack:`, error.stack);
        return res.status(500).json({ error: error.message || 'Failed to generate cover letter' });
            }
        } catch (error) {
            console.error('Database error:', error);
            return res.status(500).json({ error: 'Failed to load user profile' });
        }
    } catch (error) {
        const duration = Date.now() - startTime;
        console.error(`❌ [${requestId}] Server error (after ${duration}ms):`, error.message);
        console.error(`❌ [${requestId}] Server error stack:`, error.stack);
        return res.status(500).json({ error: error.message || 'Server error' });
    }
});
COMMENTED OUT DUPLICATE ENDPOINT - END */

// API endpoint to generate cover letter PDF for download
app.post('/api/generate-cover-letter-pdf', authenticateToken, async (req, res) => {
    // REDIRECT to coverLetterController to ensure we use the same refined logic as the send-flow
    const coverLetterController = require('./server/controllers/coverLetterController');
    return coverLetterController.generateCoverLetterPdf(req, res);
});

// Helper function to format cover letter with HTML highlighting
function formatCoverLetterWithHTML(coverLetterText, metadata) {
    let html = '';
    const paragraphs = coverLetterText.split('\n\n');
    
    paragraphs.forEach(para => {
        if (!para.trim()) return;
        
        // FIRST: Convert markdown bold (**text**) to HTML bold (<strong>text</strong>)
        // This is critical because AI generates cover letters with **Product Name** markdown syntax
        let formattedPara = para.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        
        // Bold skills if mentioned (but avoid double-bolding if already bolded by markdown)
        if (metadata.techMatches && metadata.techMatches.length > 0) {
            metadata.techMatches.forEach(skill => {
        // Only bold if not already inside <strong> tags
        const regex = new RegExp(`(?!<strong>)\\b${skill}\\b(?![^<]*<\/strong>)`, 'gi');
        formattedPara = formattedPara.replace(regex, `<strong>${skill}</strong>`);
            });
        }
        
        // Bold years of experience (avoid double-bolding)
        formattedPara = formattedPara.replace(/(?!<strong>)(\d+[\+]?\s+years?)(?![^<]*<\/strong>)/gi, '<strong>$1</strong>');
        
        // Bold company name (avoid double-bolding)
        formattedPara = formattedPara.replace(/(?!<strong>)(\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*'s)(?![^<]*<\/strong>)/g, '<strong>$1</strong>');
        
        // Bold action verbs at sentence start (avoid double-bolding)
        const actionVerbs = ['Led', 'Managed', 'Developed', 'Built', 'Created', 'Implemented', 'Designed', 'Achieved', 'Delivered'];
        actionVerbs.forEach(verb => {
            const regex = new RegExp(`^${verb}\\b`, 'g');
            if (!formattedPara.startsWith('<strong>')) {
        formattedPara = formattedPara.replace(regex, `<strong>${verb}</strong>`);
            }
        });
        
        html += `<p>${formattedPara}</p>`;
    });
    
    return html;
}

// ============================================================================
// COMMON PDF GENERATION FUNCTION - Used by both Web and Mobile
// This function encapsulates the EXACT logic from the working mobile version
// ============================================================================
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
    const photoPath = user.photo_path ? path.join(__dirname, user.photo_path) : null;
    const signaturePath = user.signature_path ? path.join(__dirname, user.signature_path) : null;

    // Normalise cover letter to <p>-based HTML for consistent PDF rendering.
    // Three possible input formats:
    //   1. Plain text with **markdown** and \n\n paragraph breaks (mobile / send-flow)
    //   2. HTML with <br> line-breaks and <strong> bold but NO <p>/<div> (web innerHTML)
    //   3. Proper HTML already wrapped in <p> or <div> tags
    let coverLetterHtml = coverLetterHtmlOrText;

    if (!coverLetterHtml.includes('<p') && !coverLetterHtml.includes('<div')) {
        if (coverLetterHtml.includes('<br') || coverLetterHtml.includes('<strong')) {
            // Format 2: web innerHTML — double-<br> = paragraph break, single <br> = space
            console.log('  📝 Normalising <br>-based HTML to <p> paragraphs...');
            coverLetterHtml = coverLetterHtml
                .replace(/(<br\s*\/?>){2,}/gi, '|||PARA|||')
                .replace(/<br\s*\/?>/gi, ' ')
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
        signaturePath
    );

    console.log(`✅ [COMMON] PDF generated: ${fileName} at ${filePath}\n`);
    
    return { filePath, fileName };
}

// Helper function to generate hiring manager name and all company locations using AI
async function generateAdditionalDetails(websiteUrl, companyName, position = 'Position') {
    console.log(`\n🤖 [GEMINI] Starting location and hiring manager generation for ${companyName}...`);
    console.log(`🔑 [GEMINI] API Key Status: ${process.env.GEMINI_API_KEY ? '✅ LOADED (starts with: ' + process.env.GEMINI_API_KEY.substring(0, 10) + '...)' : '❌ MISSING'}`);
    const startTime = Date.now();
    const geminiKey = process.env.GEMINI_API_KEY;
    
    if (!geminiKey || geminiKey === 'your_gemini_api_key_here') {
        console.log(`❌ [GEMINI] API key not found or is placeholder, returning GENERIC defaults`);
        console.log(`⚠️  [GEMINI] This is why you're getting generic content in 175ms!`);
        return {
            hiringManager: 'Hiring Manager',
            subject: `Application for ${position}`,
            locations: [{
        country: 'N/A',
        city: 'N/A',
        address: 'N/A',
        isHeadquarters: true
            }]
        };
    }
    
    console.log(`✅ [GEMINI] Valid API key detected, proceeding with AI generation...`);

    try {
        console.log(`📦 [GEMINI] Loading GoogleGenerativeAI package...`);
        const { GoogleGenerativeAI } = require('@google/generative-ai');
        console.log(`🔧 [GEMINI] Initializing Gemini with key: ${geminiKey.substring(0, 15)}...`);
        const genAI = new GoogleGenerativeAI(geminiKey);
        const model = genAI.getGenerativeModel({ 
            model: 'gemini-2.5-flash'
        });
        console.log(`✅ [GEMINI] Model initialized, preparing prompt...`);

        const prompt = `You are a research assistant. Find the ACTUAL headquarters location and address for the company "${companyName}" (website: ${websiteUrl}).

ABSOLUTELY CRITICAL - DOMAIN ACCURACY:
You MUST research the EXACT domain "${websiteUrl}" — NOT any similar-sounding domain.
- The TLD matters: .ch is NOT .com, .co.uk is NOT .com, .de is NOT .com
- For example, if given "icmag.ch", research ONLY icmag.ch (a Swiss company), NOT icmag.com (a completely different company)
- NEVER substitute or guess a different domain. The user provided this exact URL for a reason.
- If you cannot find information about the exact domain, state what you can determine from the URL alone — do NOT return information about a different company.

CRITICAL INSTRUCTIONS:
1. Visit the company's ACTUAL website at ${websiteUrl}
2. Look SPECIFICALLY at: Contact page, About Us page, Impressum/Legal Notice, Company Registry information
3. Find the PRIMARY headquarters (main office) - NOT branch offices or historical addresses
4. Verify the address is CURRENT and ACTIVE
5. If company has multiple offices, identify which one is the TRUE headquarters
6. Double-check country is CORRECT - do not guess or assume

IMPORTANT: Many companies may MENTION other countries in their content (clients, partners, expansion plans) - ignore those references. Find the ACTUAL physical headquarters where the company is registered and operates from.

FOR US COMPANIES: Look for addresses in format "1234 Street Name, City, State ZIP, USA" or "City, State ZIP"
FOR SWISS COMPANIES: Look for addresses in format "Street Number, CH-PostalCode City"
FOR OTHER COUNTRIES: Use the country's standard address format

Generate a realistic hiring manager name based on the company's headquarters country/culture.

REQUIRED OUTPUT (JSON format only):
{
    "hiringManager": "Realistic Full Name (culturally appropriate for headquarters country)",
    "subject": "Professional Email Subject Line for Application",
    "locations": [
        {
            "country": "Full Country Name (e.g., 'United States', 'Switzerland', 'Germany')",
            "city": "City Name",
            "address": "Complete Street Address with Postal/ZIP Code",
            "isHeadquarters": true
        }
    ]
}

VALIDATION CHECKLIST:
- Is the country CORRECT? (Double-check website's actual location, not just mentioned countries)
- Is this the PRIMARY headquarters, not a branch office?
- Is the address CURRENT and COMPLETE?
- Does the hiring manager name match the headquarters country's culture?

Example for US company in Florida:
{
    "hiringManager": "Michael Johnson",
    "subject": "Application for ${position} Position at ${companyName}",
    "locations": [
        {
            "country": "United States",
            "city": "Miami",
            "address": "1234 Brickell Avenue, Miami, FL 33131, USA",
            "isHeadquarters": true
        }
    ]
}

Example for Swiss company:
{
    "hiringManager": "Hans Mueller",
    "subject": "Application for ${position} Position at ${companyName}",
    "locations": [
        {
            "country": "Switzerland",
            "city": "Zürich",
            "address": "Birmensdorferstrasse 108, CH-8003 Zürich",
            "isHeadquarters": true
        }
    ]
}

Return ONLY valid JSON, no additional text.`;

        console.log(`🤖 Calling Gemini API for ${companyName}...`);
        const geminiStart = Date.now();
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        const geminiDuration = Date.now() - geminiStart;
        console.log(`✅ Gemini response received in ${geminiDuration}ms`);
        console.log('📝 Gemini response (first 200 chars):', text.substring(0, 200));
        
        // Try to extract JSON from the response
        let jsonMatch = text.match(/\{[\s\S]*\}/);
        
        // If no match, try to clean the response
        if (!jsonMatch) {
            // Remove markdown code blocks if present
            const cleanedText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '');
            jsonMatch = cleanedText.match(/\{[\s\S]*\}/);
        }
        
        if (jsonMatch) {
            try {
        const data = JSON.parse(jsonMatch[0]);
        console.log('Parsed location data:', JSON.stringify(data, null, 2));
        
        return {
            hiringManager: data.hiringManager || 'Hiring Manager',
            subject: data.subject || `Application for ${position}`,
            locations: data.locations && data.locations.length > 0 ? data.locations.map(loc => ({
                country: loc.country || 'N/A',
                city: loc.city || 'N/A',
                address: loc.address || `${loc.city || 'N/A'}, ${loc.country || 'N/A'}`,
                isHeadquarters: loc.isHeadquarters !== undefined ? loc.isHeadquarters : true
            })) : [{
                country: 'N/A',
                city: 'N/A',
                address: 'N/A',
                isHeadquarters: true
            }]
        };
            } catch (parseError) {
        console.error('JSON parse error:', parseError.message);
        console.error('Attempted to parse:', jsonMatch[0].substring(0, 200));
            }
        } else {
            console.error('No JSON found in Gemini response');
        }
    } catch (error) {
        console.error('Error generating additional details:', error.message);
        if (error.stack) {
            console.error('Error stack:', error.stack);
        }
    }

    return {
        hiringManager: 'Hiring Manager',
        subject: `Application for ${position}`,
        locations: [{
            country: 'N/A',
            city: 'N/A',
            address: 'N/A',
            isHeadquarters: true
        }]
    };
}

// API endpoint to download generated cover letter
app.get('/api/download-cover-letter/:filename', authenticateToken, async (req, res) => {
    try {
        const filename = req.params.filename;
        const filePath = path.join(__dirname, 'temp', filename);

        // Check if file exists
        try {
            await fs.access(filePath);
        } catch {
            return res.status(404).json({ error: 'Cover letter not found' });
        }

        res.download(filePath, filename);
    } catch (error) {
        console.error('Download error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Resume PDF download
app.get('/api/download-resume/:filename', authenticateToken, async (req, res) => {
    try {
        const filename = req.params.filename;
        const filePath = path.join(__dirname, 'temp', filename);
        try { await fs.access(filePath); } catch {
            return res.status(404).json({ error: 'Resume PDF not found or expired.' });
        }
        res.download(filePath, filename);
    } catch (error) {
        console.error('Resume download error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Word (.docx) downloads — mirror the PDF download routes (same auth + temp dir).
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
app.get('/api/download-cover-letter-docx/:filename', authenticateToken, async (req, res) => {
    try {
        const filename = req.params.filename;
        const filePath = path.join(__dirname, 'temp', filename);
        try { await fs.access(filePath); } catch {
            return res.status(404).json({ error: 'Cover letter not found' });
        }
        res.setHeader('Content-Type', DOCX_MIME);
        res.download(filePath, filename);
    } catch (error) {
        console.error('CL docx download error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/download-resume-docx/:filename', authenticateToken, async (req, res) => {
    try {
        const filename = req.params.filename;
        const filePath = path.join(__dirname, 'temp', filename);
        try { await fs.access(filePath); } catch {
            return res.status(404).json({ error: 'Resume Word document not found or expired.' });
        }
        res.setHeader('Content-Type', DOCX_MIME);
        res.download(filePath, filename);
    } catch (error) {
        console.error('Resume docx download error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// EMAIL SENDING ENDPOINTS - NOW USING REFACTORED CONTROLLERS
// Endpoints: /api/send-applications, /api/send-single-application
// Location: server/controllers/emailController.js
// Routes: server/routes/emailRoutes.js (mounted at bottom of this file)
// ============================================

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok',
        message: 'Server is running. Configure your email settings to send applications.',
    });
});

// ============================================
// ADMIN - CREDIT PACKAGE MANAGEMENT
// ============================================

// Get all packages (public - for users to see available packages)
// Check if user is admin
app.get('/api/user/is-admin', authenticateToken, async (req, res) => {
    try {
        const row = await dbConfig.get('SELECT role FROM users WHERE id = ?', [req.user.id]);
        res.json({ isAdmin: row && row.role === 'admin' });
    } catch (error) {
        res.status(500).json({ error: 'Database error' });
    }
});

// ============================================
// ============================================
// PAYMENT ENDPOINTS - Now Modularized
// ============================================
// Payment routes are now in server/routes/payment.js
// Payment controllers are in server/controllers/paymentController.js
// Auth middleware is in server/middleware/auth.js

// Set up payment routes with dbConfig access
paymentRoutes.setDbConfig(dbConfig);
app.use('/api/payment', paymentRoutes.router);

// First-party article comments (for the /articles blog)
const articleComments = require('./server/articleComments');
articleComments.ensureTable()
  .then(() => console.log('✅ article_comments table ready'))
  .catch((e) => console.error('article_comments ensure failed:', e.message));
app.use('/api/article-comments', articleComments.router);

// Diagnostic endpoint to verify deployment version
app.get('/api/relay-test', (req, res) => {
    res.json({ relay: 'v2', timestamp: new Date().toISOString() });
});

// Android OAuth relay endpoints — receives code from Google/Microsoft via HTTPS callback,
// then redirects to cvapplyr:// deep link so the app can extract the code.
// These are placed BEFORE the rate-limited auth routes so they're not blocked.
app.get('/auth/google/mobile-callback', (req, res, next) => {
    if (req.query.state === 'android-relay') {
        const code = req.query.code;
        const error = req.query.error;
        console.log('Google Android relay hit:', { code: code ? 'present' : 'missing', error });
        try {
            if (error) {
                console.log('Google Android relay error:', error);
                return res.redirect(`cvapplyr://oauth-error?error=${encodeURIComponent(error)}&provider=google`);
            }
            if (!code) {
                return res.redirect('cvapplyr://oauth-error?error=no_code&provider=google');
            }
            console.log('Google Android relay: forwarding code to app via deep link');
            // Use manual 302 instead of res.redirect() in case Railway edge doesn't like custom schemes
            res.writeHead(302, { 'Location': `cvapplyr://oauth-callback?code=${encodeURIComponent(code)}&provider=google` });
            return res.end();
        } catch (e) {
            console.error('Google Android relay CRASH:', e);
            return res.status(500).json({ error: 'Relay failed', details: e.message });
        }
    }
    next();
});

app.get('/auth/microsoft/callback', (req, res, next) => {
    if (req.query.state === 'android-relay') {
        const code = req.query.code;
        const error = req.query.error;
        console.log('Microsoft Android relay hit:', { code: code ? 'present' : 'missing', error });
        try {
            if (error) {
                console.log('Microsoft Android relay error:', error);
                return res.redirect(`cvapplyr://oauth-error?error=${encodeURIComponent(error)}&provider=microsoft`);
            }
            if (!code) {
                return res.redirect('cvapplyr://oauth-error?error=no_code&provider=microsoft');
            }
            console.log('Microsoft Android relay: forwarding code to app via deep link');
            res.writeHead(302, { 'Location': `cvapplyr://oauth-callback?code=${encodeURIComponent(code)}&provider=microsoft` });
            return res.end();
        } catch (e) {
            console.error('Microsoft Android relay CRASH:', e);
            return res.status(500).json({ error: 'Relay failed', details: e.message });
        }
    }
    next();
});

// Set up auth routes with rate limiting
app.use('/api/auth', authLimiter, authRoutes);
app.use('/auth', authLimiter, authRoutes);

// Account deletion endpoint (GDPR/CCPA compliance) with OAuth revocation
app.delete('/api/account/delete', authenticateToken, sensitiveLimiter, async (req, res) => {
    try {
        const userId = req.user.id;
        const { confirmText } = req.body;

        // Require explicit confirmation
        if (confirmText !== 'DELETE') {
            await logSecurityEvent('account', 'ACCOUNT_DELETE_FAILED', userId, false, {
                reason: 'Invalid confirmation'
            });
            return res.status(400).json({ 
                error: 'Invalid confirmation. Please type DELETE to confirm.' 
            });
        }

        console.log(`🗑️ [ACCOUNT DELETE] Starting deletion process for user ${userId}`);

        // Get user data before deletion for logging
        const user = await dbConfig.get('SELECT * FROM users WHERE id = ?', [userId]);
        
        if (!user) {
            await logSecurityEvent('account', 'ACCOUNT_DELETE_FAILED', userId, false, {
                reason: 'User not found'
            });
            return res.status(404).json({ error: 'User not found' });
        }

        // Revoke OAuth tokens with providers (CASA Tier 2 requirement)
        const revokeResults = { google: 'skipped', microsoft: 'skipped', apple: 'skipped' };
        
        // Revoke Google OAuth token
        if (user.google_access_token) {
            try {
                const tokenToRevoke = decryptOAuthToken(user.google_access_token) || user.google_access_token;
                const revokeResponse = await axios.post('https://oauth2.googleapis.com/revoke', null, {
                    params: { token: tokenToRevoke },
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                });
                revokeResults.google = 'success';
                console.log(`🔒 [ACCOUNT DELETE] Revoked Google OAuth token for user ${userId}`);
            } catch (error) {
                // Token might already be invalid, continue with deletion
                revokeResults.google = 'failed: ' + (error.response?.data?.error || error.message);
                console.error(`⚠️ [ACCOUNT DELETE] Failed to revoke Google token:`, error.message);
            }
        }

        // Revoke Microsoft OAuth token
        if (user.microsoft_access_token) {
            try {
                const tokenToRevoke = decryptOAuthToken(user.microsoft_access_token) || user.microsoft_access_token;
                const revokeResponse = await axios.post(
                    'https://graph.microsoft.com/v1.0/me/revokeSignInSessions',
                    {},
                    { headers: { 'Authorization': `Bearer ${tokenToRevoke}` } }
                );
                revokeResults.microsoft = 'success';
                console.log(`🔒 [ACCOUNT DELETE] Revoked Microsoft OAuth token for user ${userId}`);
            } catch (error) {
                // Token might already be invalid, continue with deletion
                revokeResults.microsoft = 'failed: ' + (error.response?.data?.error?.message || error.message);
                console.error(`⚠️ [ACCOUNT DELETE] Failed to revoke Microsoft token:`, error.message);
            }
        }

        // Note Apple token cleanup (Apple doesn't provide a simple revocation endpoint for server-side)
        if (user.apple_user_id) {
            revokeResults.apple = 'token_cleared';
            console.log(`🔒 [ACCOUNT DELETE] Cleared Apple credentials for user ${userId}`);
        }

        const now = new Date().toISOString();

        // Soft-delete associated data (keep rows, just mark deleted)
        await dbConfig.run(
            'UPDATE notifications SET deleted_at = ?, deleted_by = ? WHERE user_id = ? AND deleted_at IS NULL',
            [now, userId, userId]
        );
        console.log(`🗑️ [ACCOUNT DELETE] Soft-deleted notifications for user ${userId}`);

        await dbConfig.run(
            'UPDATE application_history SET deleted_at = ?, deleted_by = ? WHERE user_id = ? AND deleted_at IS NULL',
            [now, userId, userId]
        );
        console.log(`🗑️ [ACCOUNT DELETE] Soft-deleted applications for user ${userId}`);

        await dbConfig.run(
            'UPDATE payment_orders SET deleted_at = ?, deleted_by = ? WHERE user_id = ? AND deleted_at IS NULL',
            [now, userId, userId]
        );
        console.log(`🗑️ [ACCOUNT DELETE] Soft-deleted payments for user ${userId}`);

        await dbConfig.run(
            'UPDATE review_cover_letters SET deleted_at = ?, deleted_by = ? WHERE user_id = ? AND deleted_at IS NULL',
            [now, userId, userId]
        );
        console.log(`🗑️ [ACCOUNT DELETE] Soft-deleted cover letters for user ${userId}`);

        // Delete user files from disk (actual file cleanup is fine — content can't be recovered anyway)
        const userUploadPath = path.join(__dirname, 'uploads', `user_${userId}`);
        try {
            await fs.rm(userUploadPath, { recursive: true, force: true });
            console.log(`🗑️ [ACCOUNT DELETE] Deleted user files at ${userUploadPath}`);
        } catch (err) {
            console.error('Error deleting user files:', err);
        }

        // Log account deletion event
        await logSecurityEvent('account', 'ACCOUNT_DELETED', userId, true, {
            email: user.email,
            oauth_revoked: revokeResults,
            soft_delete: true
        });

        // Soft-delete the user record — preserve email/ip so re-registration can be detected
        // Clear sensitive OAuth tokens but keep the row
        //
        // ⚠️ THE THREE PATH COLUMNS MUST BE CLEARED HERE. The rm above deletes the files, but the row
        // survives a soft delete, and signing back in reactivates it (authController sets deleted_at
        // = NULL and touches nothing else). Leaving the paths set produced live users whose profile
        // pointed at files that had been deleted minutes earlier: a permanently broken photo in the
        // app and "recorded in the database but missing on disk" in the admin file viewer. Three real
        // users were in that state before this was fixed. If the files go, the paths go with them.
        await dbConfig.run(
            `UPDATE users SET
                deleted_at = ?,
                deleted_by = ?,
                password = NULL,
                photo_path = NULL,
                resume_path = NULL,
                signature_path = NULL,
                google_access_token = NULL,
                google_refresh_token = NULL,
                microsoft_access_token = NULL,
                microsoft_refresh_token = NULL,
                apple_user_id = NULL
            WHERE id = ?`,
            [now, userId, userId]
        );
        console.log(`🗑️ [ACCOUNT DELETE] Soft-deleted user account ${userId} (${user.email})`);

        // Clear auth cookie if it exists
        res.clearCookie('authToken');

        res.json({
            success: true,
            message: 'Your account has been successfully deleted.',
            oauth_revocation: revokeResults
        });

        console.log(`✅ [ACCOUNT DELETE] Successfully soft-deleted user ${userId} (${user.email})`);

    } catch (error) {
        console.error('❌ [ACCOUNT DELETE] Error:', error);
        await logSecurityEvent('account', 'ACCOUNT_DELETE_FAILED', req.user?.id, false, {
            error: error.message
        });
        res.status(500).json({ 
            error: 'Failed to delete account. Please contact support if the issue persists.',
            details: error.message 
        });
    }
});

// GDPR Data Export endpoint (CASA Tier 2 requirement)
app.get('/api/account/export', authenticateToken, sensitiveLimiter, async (req, res) => {
    try {
        const userId = req.user.id;

        console.log(`📦 [DATA EXPORT] Starting export for user ${userId}`);

        // Get user data
        const user = await dbConfig.get('SELECT * FROM users WHERE id = ?', [userId]);
        
        if (!user) {
            await logSecurityEvent('account', 'DATA_EXPORT_FAILED', userId, false, {
                reason: 'User not found'
            });
            return res.status(404).json({ error: 'User not found' });
        }

        // Get all related data (using correct table names)
        const [applications, coverLetters, payments, notifications, auditLogs] = await Promise.all([
            dbConfig.query('SELECT * FROM application_history WHERE user_id = ?', [userId]),
            dbConfig.query('SELECT * FROM review_cover_letters WHERE user_id = ?', [userId]),
            dbConfig.query('SELECT * FROM payment_orders WHERE user_id = ?', [userId]),
            dbConfig.query('SELECT * FROM notifications WHERE user_id = ?', [userId]),
            dbConfig.query('SELECT * FROM security_audit_log WHERE user_id = ?', [userId])
        ]);

        // Remove sensitive encrypted tokens from export (keep only metadata)
        const exportData = {
            export_date: new Date().toISOString(),
            user_data: {
                id: user.id,
                email: user.email,
                full_name: user.full_name,
                phone: user.phone,
                created_at: user.created_at,
                oauth_providers: {
                    google: {
                        connected: !!user.google_access_token,
                        email: user.google_email,
                        token_issued_at: user.google_token_issued_at,
                        token_expires_at: user.google_token_expires_at
                    },
                    microsoft: {
                        connected: !!user.microsoft_access_token,
                        email: user.microsoft_email,
                        token_issued_at: user.microsoft_token_issued_at,
                        token_expires_at: user.microsoft_token_expires_at
                    },
                    apple: {
                        connected: !!user.apple_user_id,
                        token_issued_at: user.apple_token_issued_at,
                        token_expires_at: user.apple_token_expires_at
                    }
                },
                credits: {
                    total_credits: user.total_credits,
                    used_credits: user.used_credits,
                    remaining_credits: (user.total_credits || 0) - (user.used_credits || 0)
                },
                subscription: {
                    package_id: user.package_id,
                    package_name: user.package_name,
                    package_start_date: user.package_start_date,
                    package_end_date: user.package_end_date,
                    auto_renew: user.auto_renew
                }
            },
            applications: applications.map(app => ({
                id: app.id,
                company_name: app.company_name,
                position: app.position,
                recipient_email: app.recipient_email,
                status: app.status,
                sent_at: app.sent_at,
                created_at: app.created_at
            })),
            cover_letters: coverLetters.map(cl => ({
                id: cl.id,
                company_name: cl.company_name,
                position: cl.position,
                content: cl.content,
                model_used: cl.model_used,
                created_at: cl.created_at
            })),
            payments: payments.map(payment => ({
                id: payment.id,
                amount: payment.amount,
                currency: payment.currency,
                status: payment.status,
                package_id: payment.package_id,
                package_name: payment.package_name,
                razorpay_order_id: payment.razorpay_order_id,
                razorpay_payment_id: payment.razorpay_payment_id,
                created_at: payment.created_at
            })),
            notifications: notifications.map(notif => ({
                id: notif.id,
                type: notif.type,
                title: notif.title,
                message: notif.message,
                read: notif.read,
                created_at: notif.created_at
            })),
            security_audit_logs: auditLogs.map(log => ({
                id: log.id,
                event_type: log.event_type,
                event_category: log.event_category,
                success: log.success,
                ip_address: log.ip_address,
                user_agent: log.user_agent,
                metadata: log.metadata,
                created_at: log.created_at
            }))
        };

        // Log export event
        await logSecurityEvent('account', 'DATA_EXPORTED', userId, true, {
            email: user.email,
            records_count: {
                applications: applications.length,
                cover_letters: coverLetters.length,
                payments: payments.length,
                notifications: notifications.length,
                audit_logs: auditLogs.length
            }
        });

        console.log(`✅ [DATA EXPORT] Successfully exported data for user ${userId}`);

        // Set headers for file download
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="account-data-${userId}-${Date.now()}.json"`);
        res.json(exportData);

    } catch (error) {
        console.error('❌ [DATA EXPORT] Error:', error);
        await logSecurityEvent('account', 'DATA_EXPORT_FAILED', req.user?.id, false, {
            error: error.message
        });
        res.status(500).json({ 
            error: 'Failed to export account data. Please contact support if the issue persists.',
            details: error.message 
        });
    }
});

// Set up profile routes with authentication
app.use('/api/users', authenticateToken, profileRoutes);

// Set up user data routes (both /api/users and /users for backward compatibility)
app.use('/api/users', userDataRoutes);
app.use('/users', userDataRoutes);
// app.use('/api/user', usageRoutes);  // Commented out - using creditsRoutes instead for /api/user/usage-stats
app.use('/api', creditsRoutes);
app.use('/api', adminPackagesRoutes);
app.use('/api', aiEventCostsRoutes);
app.use('/api', rewardsRoutes);
app.use('/api', feedbackRoutes);
app.use('/api', adminUsersRoutes);
app.use('/api', employerFixRoutes);
app.use('/api', adminStoreAnalyticsRoutes);
app.use('/api', adminNotifyRoutes);
app.use('/api', adminUserOpsRoutes);
// In-app support: user issue reports + 1:1 chat with staff. User routes are scoped to the caller's
// own threads inside the service; admin routes are authenticateAdmin. See supportRoutes.js.
app.use('/api', require('./server/routes/supportRoutes'));

// Subscription plans + 7-day trial + usage ledger (Migration 028). Quota gates live inside the
// cover-letter and resume controllers; these routes are status/usage/device/admin-assign.
app.use('/api', require('./server/routes/subscriptionRoutes'));

// Location-based job interests (Migration 029) — the redesigned Jobs tab cards.
app.use('/api', require('./server/routes/interestRoutes'));
app.use('/api', adminGlobalJobsRoutes);
app.use('/api', require('./server/routes/adminRoutinesRoutes'));   // admin Routines view (system_schedule + run-now)
app.use('/api', discoverRoutes);
app.use('/api', require('./server/routes/appConfigRoutes'));
app.use('/api', analyticsRoutes);

// LinkedIn job extraction — SEPARATE pipeline (hidden on-device WebView innerText → AI JSON + store).
const linkedinRoutes = require('./server/routes/linkedinRoutes');
require('./server/services/linkedinJobStore').ensureTable()
  .then(() => console.log('✅ linkedin_jobs table ready'))
  .catch((e) => console.error('linkedin_jobs ensure failed:', e.message));
app.use('/api', linkedinRoutes);

app.use('/api', coverLetterRoutes);
app.use('/api', emailRoutes);
app.use('/api', notificationsRoutes);
app.use('/api', jobRoutes);
app.use('/api/ai-hub', aiHubRoutes);
app.use('/api/resume-builder', resumeBuilderRoutes);
app.use('/api', featureFlagsRoutes);
const batchRoutes = require('./server/routes/batchRoutes');
app.use('/api', batchRoutes);

// Async job startup maintenance (runs after DB is ready via app.listen)
const { requeueStuckJobs, cleanupOldJobs } = require('./server/services/jobService');
// Clean up old jobs every hour
setInterval(() => cleanupOldJobs().catch(console.error), 60 * 60 * 1000);

// Start email forwarding service
const EmailForwardingService = require('./server/services/emailForwardingService');
const emailForwarder = new EmailForwardingService();
emailForwarder.start();

// Daily employer fix-queue agent — re-investigates employers that returned 0 jobs (auto-queued
// in employer_fix_requests) and self-heals them with verified per-domain overrides. Persisted
// last-run timestamp gates it to ~once/day across restarts. Disable with FIX_QUEUE_DISABLED=1.
try { require('./server/services/fixQueueRunner').startFixQueueScheduler(); }
catch (e) { console.error('[fixQueue] failed to start:', e.message); }

// Background reply poller — detects replies to sent applications for Microsoft/Outlook users even
// when the app is closed (the on-demand /check-replies only runs while the app is open), then fires
// an in-app notification + device push. Every ~20 min. Disable with REPLY_POLL_DISABLED=1.
try { require('./server/services/replyPoller').startReplyPoller(); }
catch (e) { console.error('[replyPoll] failed to start:', e.message); }

// Engagement notifications — daily follow-up reminders + credit-expiry warnings, weekly activity
// digest. Preference-gated (notification_preferences). Disable with ENGAGEMENT_DISABLED=1.
try { require('./server/services/engagementScheduler').startEngagementScheduler(); }
catch (e) { console.error('[engagement] failed to start:', e.message); }

// Lifecycle nudges — works out where each user is stuck (no résumé, no photo, saved but never
// applied, trial closing) and sends ONE fitting nudge, with bonus quota paid out when they finish
// the step. Every send passes through nudgeGate: max one automated push per 20h, three per week,
// three attempts per nudge, then it stops. Disable with LIFECYCLE_NUDGES_DISABLED=1.
try { require('./server/services/lifecycleNudges').startLifecycleNudges(); }
catch (e) { console.error('[lifecycle] failed to start:', e.message); }

// Résumé re-parse sweeper. A transient model failure (503 "high demand") used to be written as a
// PERMANENT parse error that nothing ever retried, leaving the user's résumé unusable while the app
// told them to "wait and try again". The parser now marks those retryable; this picks them up, plus
// the rows the old code had already written off. Small and slow on purpose — it shares model quota
// with live traffic, and a thundering retry during an outage turns a blip into an incident.
// Disable with RESUME_SWEEPER_DISABLED=1.
if (process.env.RESUME_SWEEPER_DISABLED !== '1') {
    // ⚠️ LOG EVERY RUN, including the boring ones. The first version of this scheduled itself
    // silently and logged only when it repaired something — so when the stuck rows did not move
    // there was no way to tell "it ran and found nothing" from "it never ran", and the only
    // remaining move was to wait another half hour and look again. Every other scheduler in this
    // file announces itself at boot; this one now does too, and reports each sweep either way.
    const sweep = async (why) => {
        try {
            const r = await require('./services/resumeParserService').retryStuckResumes({ limit: 5 });
            console.log(`[resumeParser] sweep (${why}): considered ${r.considered}, retried ${r.retried}`
                + (r.retried ? ` → users ${r.users.join(', ')}` : ''));
        } catch (e) { console.error(`[resumeParser] sweep (${why}) failed:`, e.message); }
    };
    setTimeout(() => sweep('boot'), 3 * 60 * 1000);
    setInterval(() => sweep('interval'), 30 * 60 * 1000);
    console.log('📄 Résumé re-parse sweeper: scheduled (3m after boot, then every 30m)');
}

// Global job firehose — populate the isolated global_jobs feed from public company ATS boards every
// few hours (no AI, no keys). Disable with GLOBAL_JOB_FIREHOSE_ENABLED=0.
// Demand-driven research — twice a day, researches the live web for the skills+locations users
// saved as interests, feeds global_jobs, and pushes "new matching jobs" to affected users.
try { require('./server/services/demandResearch').startDemandResearch(); }
catch (e) { console.error('[demandResearch] failed to start:', e.message); }

try { require('./server/services/globalJobFirehose').startGlobalJobFirehose(); }
catch (e) { console.error('[firehose] failed to start:', e.message); }

// Start server
const HOST = process.env.HOST || '0.0.0.0';
// Push receipt poller. A READER — it asks Expo what became of messages we already sent and writes
// the answer onto push_sends. It sends nothing, so the "ship schedulers disarmed" rule for anything
// that can push to users does not apply; PUSH_RECEIPT_POLL_DISABLED=1 stops it regardless.
try { require('./server/services/pushLog').startReceiptPoller(); }
catch (e) { console.warn('[push] receipt poller not started:', e.message); }

app.listen(PORT, HOST, () => {
    console.log(`
╔═══════════════════════════════════════════════════════╗
║        Resume Sender App - Server Running            ║
╚═══════════════════════════════════════════════════════╝

🌐 Server: http://${HOST}:${PORT}
🌐 Local: http://localhost:${PORT}
🌐 Network: http://192.168.1.14:${PORT}
📧 Configure your email in Settings
📬 Email forwarding: Active

Open your browser and visit any of the above URLs
    `);
    
    // Run async job maintenance after server (and DB) is ready
    requeueStuckJobs().catch(err => console.error('Failed to requeue stuck jobs:', err));
    cleanupOldJobs().catch(err => console.error('Failed to cleanup old jobs:', err));
});
