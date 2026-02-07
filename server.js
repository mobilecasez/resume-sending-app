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
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const CryptoJS = require('crypto-js');
const sqlite3 = require('sqlite3').verbose();
const { Pool } = require('pg');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
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

// Import modular routes
const paymentRoutes = require('./server/routes/payment');
const authRoutes = require('./server/routes/authRoutes');
const profileRoutes = require('./server/routes/profileRoutes');
const userDataRoutes = require('./server/routes/userDataRoutes');
const creditsRoutes = require('./server/routes/creditsRoutes');
const adminPackagesRoutes = require('./server/routes/adminPackagesRoutes');
const coverLetterRoutes = require('./server/routes/coverLetterRoutes');
const emailRoutes = require('./server/routes/emailRoutes');

// Import authentication middleware
const { authenticateToken, authenticateAdmin } = require('./server/middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this-in-production';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'your-encryption-key-change-this-in-production-min-32-chars';

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
    
    // Set credentials
    oauth2Client.setCredentials({
        access_token: user.google_access_token,
        refresh_token: user.google_refresh_token
    });
    
    return oauth2Client;
}

// Function to generate professional email body
function generateEmailBody(position, companyName, userFullName) {
    return `Dear Hiring Manager,

I hope this email finds you well. I am writing to express my strong interest in the ${position} position at ${companyName}.

I have attached my resume and cover letter for your review. I believe my skills and experience make me a strong candidate for this role, and I would welcome the opportunity to discuss how I can contribute to your team.

Thank you for considering my application. I look forward to hearing from you.

Best regards,
${userFullName}`;
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

// Initialize database (supports both SQLite and PostgreSQL)
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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));
app.use(passport.initialize());
app.use(passport.session());

// Protected admin pages - MUST come before express.static
app.get('/admin-packages.html', serveAdminPageOnly, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin-packages.html'));
});

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

// Static files for public access
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Passport Google OAuth Configuration
const CALLBACK_URL = process.env.NODE_ENV === 'production' 
    ? 'https://cvapplyr.com/auth/google/callback'
    : 'http://localhost:3000/auth/google/callback';

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID || 'your-google-client-id',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'your-google-client-secret',
    callbackURL: CALLBACK_URL,
    scope: ['profile', 'email', 'https://www.googleapis.com/auth/gmail.send'],
    accessType: 'offline', // Request refresh token
    prompt: 'consent' // Force consent screen to get refresh token
}, (accessToken, refreshToken, profile, done) => {
    // Handle Google OAuth callback with tokens
    handleOAuthUser(profile, 'google', accessToken, refreshToken, done);
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
            // User exists, update OAuth tokens
            await dbConfig.run(
        'UPDATE users SET oauth_provider = ?, google_access_token = ?, google_refresh_token = ? WHERE id = ?',
        [provider, accessToken, refreshToken, user.id]
            );
            return callback(null, user);
        } else {
            // Create new user
            const hashedPassword = jwt.sign({ provider, email }, JWT_SECRET);
            const result = await dbConfig.run(
        'INSERT INTO users (full_name, email, password, oauth_provider, google_access_token, google_refresh_token) VALUES (?, ?, ?, ?, ?, ?)',
        [fullName, email, hashedPassword, provider, accessToken, refreshToken]
            );
            
            const newUser = await dbConfig.get('SELECT * FROM users WHERE id = ?', [result.lastID || result.id]);
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
        return resolve({ 
            hasCredits: false, 
            remaining: 0, 
            message: 'No credits available. Please purchase a plan to continue.' 
        });
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
        service: 'gmail',
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

        const user = await dbConfig.get('SELECT full_name as "fullName", email, resume_path as "resumePath", photo_path as "photoPath", signature_path as "signaturePath", smtp_email as "smtpEmail", smtp_password as "smtpPassword", sender_name as "senderName", date_of_birth as "dateOfBirth", phone_number as "phoneNumber", address, created_at as "createdAt" FROM users WHERE id = ?', [userId]);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Decrypt SMTP password before sending (only send masked version to frontend)
        const decryptedPassword = user.smtpPassword ? '********' : '';

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
        dateOfBirth: user.dateOfBirth,
        phoneNumber: user.phoneNumber,
        address: user.address,
        createdAt: user.createdAt,
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
        const { fullName, dateOfBirth, phoneNumber, address, city, country, zipcode } = req.body;

        if (!fullName) {
            return res.status(400).json({ error: 'Full name is required' });
        }

        await dbConfig.run(
            'UPDATE users SET full_name = ?, date_of_birth = ?, phone_number = ?, address = ? WHERE id = ?',
            [fullName, dateOfBirth || null, phoneNumber || null, address || null, userId]
        );

        res.json({
            success: true,
            message: 'User details updated successfully'
        });
    } catch (error) {
        console.error('User details update error:', error);
        res.status(500).json({ error: 'Failed to update user details' });
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

    // Sidebar
    const sidebarWidth = 180;
    page.drawRectangle({
        x: 0,
        y: 0,
        width: sidebarWidth,
        height: pageHeight,
        color: rgb(0.15, 0.15, 0.2),
    });

    // Photo circle
    const photoSize = 100;
    const photoX = sidebarWidth / 2;
    const photoY = pageHeight - 120;

    page.drawCircle({
        x: photoX,
        y: photoY + photoSize / 2,
        size: photoSize / 2,
        color: rgb(1, 1, 1),
        borderColor: rgb(1, 1, 1),
        borderWidth: 3,
    });

    const initials = 'RS';
    const initialsSize = 24;
    const initialsWidth = helveticaBold.widthOfTextAtSize(initials, initialsSize);
    page.drawText(initials, {
        x: photoX - initialsWidth / 2,
        y: photoY + photoSize / 2 - 8,
        size: initialsSize,
        font: helveticaBold,
        color: rgb(0.15, 0.15, 0.2),
    });

    // Sidebar sections
    let sidebarY = photoY - 40;
    const sectionGap = 80;

    // TO section
    page.drawText('TO', {
        x: 20,
        y: sidebarY,
        size: 10,
        font: helveticaBold,
        color: rgb(1, 1, 1),
    });
    sidebarY -= 20;
    page.drawText(CONFIG.recipientName, {
        x: 20,
        y: sidebarY,
        size: 9,
        font: helvetica,
        color: rgb(1, 1, 1),
    });
    sidebarY -= 15;
    page.drawText(CONFIG.companyName, {
        x: 20,
        y: sidebarY,
        size: 9,
        font: helvetica,
        color: rgb(1, 1, 1),
    });
    sidebarY -= 15;
    page.drawText(CONFIG.country, {
        x: 20,
        y: sidebarY,
        size: 9,
        font: helvetica,
        color: rgb(1, 1, 1),
    });

    sidebarY -= sectionGap;

    // FROM section
    page.drawText('FROM', {
        x: 20,
        y: sidebarY,
        size: 10,
        font: helveticaBold,
        color: rgb(1, 1, 1),
    });
    sidebarY -= 20;
    page.drawText('RISHI SAMADHIYA', {
        x: 20,
        y: sidebarY,
        size: 9,
        font: helvetica,
        color: rgb(1, 1, 1),
    });
    sidebarY -= 15;
    page.drawText('Project Manager', {
        x: 20,
        y: sidebarY,
        size: 9,
        font: helvetica,
        color: rgb(1, 1, 1),
    });

    sidebarY -= sectionGap;

    // DATE section
    const today = new Date();
    const dateStr = today.toLocaleDateString('en-US', { 
        month: 'short', 
        day: '2-digit', 
        year: 'numeric' 
    }).replace(',', '');

    page.drawText('DATE', {
        x: 20,
        y: sidebarY,
        size: 10,
        font: helveticaBold,
        color: rgb(1, 1, 1),
    });
    sidebarY -= 20;
    page.drawText(dateStr, {
        x: 20,
        y: sidebarY,
        size: 9,
        font: helvetica,
        color: rgb(1, 1, 1),
    });

    // Contact info at bottom of sidebar
    const contactY = 100;
    page.drawText('samrishi24@gmail.com', {
        x: 20,
        y: contactY,
        size: 7,
        font: helvetica,
        color: rgb(1, 1, 1),
    });
    page.drawText('+91 9970020596', {
        x: 20,
        y: contactY - 15,
        size: 7,
        font: helvetica,
        color: rgb(1, 1, 1),
    });
    page.drawText('Gurgaon, Haryana', {
        x: 20,
        y: contactY - 30,
        size: 7,
        font: helvetica,
        color: rgb(1, 1, 1),
    });
    page.drawText('India', {
        x: 20,
        y: contactY - 45,
        size: 7,
        font: helvetica,
        color: rgb(1, 1, 1),
    });

    // Main content area
    const contentX = sidebarWidth + 40;
    const contentWidth = pageWidth - sidebarWidth - 80;
    let contentY = pageHeight - 80;

    // Header
    page.drawText('RISHI SAMADHIYA', {
        x: contentX,
        y: contentY,
        size: 18,
        font: helveticaBold,
        color: rgb(0, 0, 0),
    });
    contentY -= 22;
    page.drawText('Project Manager', {
        x: contentX,
        y: contentY,
        size: 11,
        font: helvetica,
        color: rgb(0.3, 0.3, 0.3),
    });

    // Contact details (right-aligned)
    const headerContactY = contentY;
    const rightAlignX = pageWidth - 40;
    const contactFontSize = 9;

    const emailText = 'samrishi24@gmail.com';
    const phoneText = '+91 9970020596';
    const locationText = 'Gurgaon, Haryana, India';

    const emailWidth = helvetica.widthOfTextAtSize(emailText, contactFontSize);
    const phoneWidth = helvetica.widthOfTextAtSize(phoneText, contactFontSize);
    const locationWidth = helvetica.widthOfTextAtSize(locationText, contactFontSize);

    page.drawText(emailText, {
        x: rightAlignX - emailWidth,
        y: headerContactY,
        size: contactFontSize,
        font: helvetica,
        color: rgb(0.3, 0.3, 0.3),
    });
    page.drawText(phoneText, {
        x: rightAlignX - phoneWidth,
        y: headerContactY - 15,
        size: contactFontSize,
        font: helvetica,
        color: rgb(0.3, 0.3, 0.3),
    });
    page.drawText(locationText, {
        x: rightAlignX - locationWidth,
        y: headerContactY - 30,
        size: contactFontSize,
        font: helvetica,
        color: rgb(0.3, 0.3, 0.3),
    });

    contentY -= 50;

    // Separator line
    page.drawLine({
        start: { x: contentX, y: contentY },
        end: { x: pageWidth - 40, y: contentY },
        thickness: 1,
        color: rgb(0.8, 0.8, 0.8),
    });

    contentY -= 40;

    // Letter body
    const paragraphs = [
        `Dear Hiring Manager,`,
        `I am writing to express my strong interest in the ${CONFIG.position} position at ${CONFIG.companyName}. With my extensive experience in ${CONFIG.relevantSkills}, I am confident that I would be a valuable addition to your team.`,
        CONFIG.companyParagraph,
        `Throughout my career, I have consistently demonstrated the ability to lead cross-functional teams, deliver complex projects on time and within budget, and drive continuous improvement initiatives. I am excited about the opportunity to bring my skills and experience to ${CONFIG.companyName} and contribute to your continued success.`,
        `Thank you for considering my application. I look forward to the opportunity to discuss how I can contribute to your team.`,
    ];

    function wrapText(text, maxWidth, font, fontSize) {
        const words = text.split(' ');
        const lines = [];
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

        return lines;
    }

    const paragraphFontSize = 10;
    const lineHeight = 16;

    for (const para of paragraphs) {
        const lines = wrapText(para, contentWidth, helvetica, paragraphFontSize);
        for (const line of lines) {
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

    // Signature
    contentY -= 20;
    page.drawText('Regards,', {
        x: contentX,
        y: contentY,
        size: 10,
        font: helvetica,
        color: rgb(0, 0, 0),
    });
    contentY -= 30;
    page.drawLine({
        start: { x: contentX, y: contentY },
        end: { x: contentX + 150, y: contentY },
        thickness: 1,
        color: rgb(0, 0, 0),
    });
    contentY -= 20;
    page.drawText('RISHI SAMADHIYA', {
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

    // Photo circle at top (centered in sidebar)
    const photoSize = 100;
    const photoX = sidebarWidth / 2;
    const photoY = pageHeight - 120;

    // Add user photo (already circular from upload)
    if (photoPath) {
        try {
            const photoBytes = await fs.readFile(photoPath);
            let photoImage;
            
            // Try to embed as PNG (circular images are saved as PNG)
            try {
        photoImage = await pdfDoc.embedPng(photoBytes);
            } catch (pngError) {
        try {
            photoImage = await pdfDoc.embedJpg(photoBytes);
        } catch (jpgError) {
            console.error('Could not embed photo:', jpgError);
        }
            }
            
            if (photoImage) {
        // Simply draw the circular image - no masking needed
        page.drawImage(photoImage, {
            x: photoX - photoSize / 2,
            y: photoY,
            width: photoSize,
            height: photoSize,
        });
            } else {
        throw new Error('Could not load photo');
            }
        } catch (error) {
            console.error('Error loading photo, using initials:', error.message);
            // Fallback: Draw circle with initials
            page.drawCircle({
        x: photoX,
        y: photoY + photoSize / 2,
        size: photoSize / 2,
        borderColor: rgb(1, 1, 1),
        borderWidth: 2,
        color: rgb(0.25, 0.25, 0.3),
            });
            
            const initials = userData.fullName ? userData.fullName.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) : 'RS';
            const initialsWidth = helveticaBold.widthOfTextAtSize(initials, 24);
            page.drawText(initials, {
        x: photoX - initialsWidth / 2,
        y: photoY + photoSize / 2 - 8,
        size: 24,
        font: helveticaBold,
        color: rgb(1, 1, 1),
            });
        }
    } else {
        // No photo - draw circle with initials
        page.drawCircle({
            x: photoX,
            y: photoY + photoSize / 2,
            size: photoSize / 2,
            borderColor: rgb(1, 1, 1),
            borderWidth: 2,
            color: rgb(0.25, 0.25, 0.3),
        });
        
        const initials = userData.fullName ? userData.fullName.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) : 'RS';
        const initialsWidth = helveticaBold.widthOfTextAtSize(initials, 24);
        page.drawText(initials, {
            x: photoX - initialsWidth / 2,
            y: photoY + photoSize / 2 - 8,
            size: 24,
            font: helveticaBold,
            color: rgb(1, 1, 1),
        });
    }

    // Sidebar sections - START LOWER (gap after photo)
    let sidebarY = photoY - 40;
    const maxSidebarWidth = sidebarWidth - 40;

    // TO section
    page.drawText('TO', {
        x: 20,
        y: sidebarY,
        size: 11,
        font: helveticaBold,
        color: rgb(1, 1, 1),
    });
    sidebarY -= 22;
    page.drawText('Hiring Manager', {
        x: 20,
        y: sidebarY,
        size: 10,
        font: helvetica,
        color: rgb(1, 1, 1),
    });
    sidebarY -= 16;
    
    // Wrap company name if too long
    const companyNameLines = wrapText(companyName, maxSidebarWidth, helvetica, 10);
    for (const line of companyNameLines) {
        page.drawText(line, {
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
    page.drawLine({
        start: { x: 20, y: sidebarY },
        end: { x: sidebarWidth - 20, y: sidebarY },
        thickness: 0.5,
        color: rgb(0.5, 0.5, 0.5),
    });

    sidebarY -= 25;

    // FROM section
    page.drawText('FROM', {
        x: 20,
        y: sidebarY,
        size: 11,
        font: helveticaBold,
        color: rgb(1, 1, 1),
    });
    sidebarY -= 22;
    
    const nameLines = wrapText(userData.fullName || 'Applicant', maxSidebarWidth, helvetica, 10);
    for (const line of nameLines) {
        page.drawText(line.toUpperCase(), {
            x: 20,
            y: sidebarY,
            size: 10,
            font: helvetica,
            color: rgb(1, 1, 1),
        });
        sidebarY -= 16;
    }

    sidebarY -= 20;
    
    // Separator line after FROM section
    page.drawLine({
        start: { x: 20, y: sidebarY },
        end: { x: sidebarWidth - 20, y: sidebarY },
        thickness: 0.5,
        color: rgb(0.5, 0.5, 0.5),
    });

    sidebarY -= 25;

    // DATE section
    const today = new Date();
    const dateStr = today.toLocaleDateString('en-US', { 
        month: 'short', 
        day: '2-digit', 
        year: 'numeric' 
    }).replace(',', '');

    page.drawText('DATE', {
        x: 20,
        y: sidebarY,
        size: 11,
        font: helveticaBold,
        color: rgb(1, 1, 1),
    });
    sidebarY -= 22;
    page.drawText(dateStr, {
        x: 20,
        y: sidebarY,
        size: 10,
        font: helvetica,
        color: rgb(1, 1, 1),
    });

    // Contact info at bottom of sidebar
    const contactY = 100;
    if (userData.email) {
        page.drawText(userData.email, {
            x: 20,
            y: contactY,
            size: 8,
            font: helvetica,
            color: rgb(1, 1, 1),
        });
    }
    if (userData.phoneNumber) {
        page.drawText(userData.phoneNumber, {
            x: 20,
            y: contactY - 15,
            size: 8,
            font: helvetica,
            color: rgb(1, 1, 1),
        });
    }
    if (userData.city) {
        page.drawText(userData.city, {
            x: 20,
            y: contactY - 30,
            size: 8,
            font: helvetica,
            color: rgb(1, 1, 1),
        });
    }
    if (userData.country) {
        page.drawText(userData.country, {
            x: 20,
            y: contactY - 45,
            size: 8,
            font: helvetica,
            color: rgb(1, 1, 1),
        });
    }

    // RIGHT CONTENT AREA
    const contentX = sidebarWidth + 40;
    const contentWidth = pageWidth - sidebarWidth - 80;
    let contentY = pageHeight - 80;

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
    const designation = 'Project Manager';
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

// API endpoint to download generated cover letter
app.get('/api/download-cover-letter/:filename', authenticateToken, async (req, res) => {
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
                    '' // no specific address from bulk generation
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

// API endpoint to generate cover letter details with AI for review page
app.post('/api/generate-cover-letter-details', authenticateToken, async (req, res) => {
    const requestId = Date.now();
    const startTime = Date.now();
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📨 [${requestId}] REQUEST RECEIVED at ${new Date().toISOString()}`);
    console.log(`   IP: ${req.ip}, UserAgent: ${req.get('user-agent')?.substring(0, 50)}...`);
    console.log(`🔑 [${requestId}] GEMINI_API_KEY STATUS: ${process.env.GEMINI_API_KEY ? 'LOADED (length: ' + process.env.GEMINI_API_KEY.length + ')' : '❌ MISSING'}`);
    
    try {
        const userId = req.user.id;
        const { recipientEmail, websiteUrl, position } = req.body;

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
        const additionalDetailsStart = Date.now();
        // Extract company name from URL for initial lookup
        const urlCompanyName = websiteUrl.replace(/^https?:\/\/(www\.)?/, '').split('/')[0].split('.')[0];
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

// API endpoint to generate cover letter PDF for download
app.post('/api/generate-cover-letter-pdf', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { coverLetterHtml, companyName, companyAddress } = req.body;

        console.log('Generate PDF request:', { userId, companyName, companyAddress });

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
            coverLetterHtml,
            companyName,
            companyAddress
        );

        console.log(`📄 Generated PDF: ${fileName}`);

        // Generate download URL
        const downloadUrl = `/api/download-cover-letter/${encodeURIComponent(fileName)}`;

        res.json({
            success: true,
            downloadUrl: downloadUrl,
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
            model: 'gemini-1.5-flash'
        });
        console.log(`✅ [GEMINI] Model initialized, preparing prompt...`);

        const prompt = `You are a research assistant. Find the ACTUAL headquarters location and address for the company "${companyName}" (website: ${websiteUrl}).

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
            locations: data.locations && data.locations.length > 0 ? data.locations : [{
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

// API endpoint to send applications (protected)
app.post('/api/send-applications', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { recipients } = req.body;

        console.log('\n📧 ============ SEND APPLICATIONS START ============');
        console.log('📧 [SEND] User ID:', userId);
        console.log('📧 [SEND] Recipients count:', recipients?.length || 0);
        console.log('📧 [SEND] Timestamp:', new Date().toISOString());

        if (!recipients || recipients.length === 0) {
            return res.status(400).json({ error: 'No recipients provided' });
        }

        // Get user's complete profile and files from database
        try {
            const user = await dbConfig.get('SELECT full_name as "fullName", email, phone_number as "phoneNumber", city, country, smtp_email as "smtpEmail", smtp_password as "smtpPassword", sender_name as "senderName", resume_path as "resumePath", photo_path as "photoPath", signature_path as "signaturePath" FROM users WHERE id = ?', [userId]);
            
            if (!user) {
        return res.status(404).json({ error: 'User not found' });
            }

            // Check if user has personal SMTP or use default from .env
            let smtpEmail, smtpPassword;
            
            if (user.smtpEmail && user.smtpPassword) {
        // Use user's personal SMTP credentials
        console.log('📧 Using user SMTP credentials...');
        smtpEmail = user.smtpEmail;
        smtpPassword = decryptData(user.smtpPassword);
            } else if (process.env.SMTP_USER && process.env.SMTP_PASS) {
        // Use default SMTP credentials from .env
        console.log('📧 Using default SMTP credentials (.env)...');
        smtpEmail = process.env.SMTP_USER;
        smtpPassword = process.env.SMTP_PASS;
            } else {
        return res.status(400).json({ 
            error: 'Email settings are required. Please configure your email in Settings or log in with Google OAuth.' 
        });
            }

            if (!user.resumePath) {
        return res.status(400).json({ 
            error: 'Resume is required. Please upload your resume in the Profile page.' 
        });
            }

            // Create transporter with credentials
            const transporter = createTransporter(smtpEmail, smtpPassword);
            
            const results = [];
            const emailSettings = {
        email: smtpEmail,
        name: user.senderName || user.fullName || smtpEmail.split('@')[0]
            };

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

        console.log('\n🚀 Starting application sending process...');
        console.log(`📧 Sending to ${recipients.length} recipient(s)`);

        for (const recipient of recipients) {
            try {
                console.log(`\n📤 Processing: ${recipient.email}`);

                let filePath, fileName, companyName;

                // Check if cover letter was pre-generated (fileName provided)
                if (recipient.fileName) {
                    // Use pre-generated cover letter from temp folder
                    fileName = recipient.fileName;
                    filePath = path.join(__dirname, 'temp', fileName);
                    companyName = fileName.split('_')[2] || 'Company'; // Extract from filename
                    
                    // Verify file exists
                    try {
                        await fs.access(filePath);
                        console.log(`✅ Using pre-generated cover letter: ${fileName}`);
                    } catch {
                        throw new Error('Pre-generated cover letter not found. Please regenerate.');
                    }
                } else {
                    // Generate cover letter on the fly (fallback for backward compatibility)
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
                    const coverLetterText = coverLetterResult.coverLetter; // TEXT format
                    
                    console.log(`✅ Generated personalized cover letter for ${companyName}`);

                    // Format cover letter with HTML (bold key points) - same as mobile
                    const coverLetterHtml = formatCoverLetterWithHTML(coverLetterText, coverLetterResult.metadata);
                    console.log(`📝 HTML formatted for PDF generation`);

                    // Use common PDF generation function (same as mobile)
                    const pdfResult = await generateCoverLetterPDF(
                        user,
                        coverLetterHtml,
                        companyName,
                        '' // no specific address
                    );
                    
                    filePath = pdfResult.filePath;
                    fileName = pdfResult.fileName;
                    
                    console.log(`📄 Created PDF: ${fileName}`);
                }

                console.log(`📎 Attaching cover letter: ${fileName}`);

                // Position from recipient or default
                const position = recipient.position || 'Position at your company';

                // Send email with personalized content
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
                                I believe my background and skills align well with what ${companyName} is looking for, 
                                and I'd love the opportunity to discuss how I can contribute to your team's success.
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

                // Clean up temp PDF file
                await fs.unlink(filePath);

                // Save to application history
                console.log(`💾 [DB INSERT] Attempting to save to application_history...`);
                console.log(`💾 [DB INSERT] Data: userId=${userId}, company=${companyName}, position=${position}, email=${recipient.email}`);
                try {
                    const insertResult = await dbConfig.run(
                        'INSERT INTO application_history (user_id, company_name, position, recipient_email, sent_date) VALUES (?, ?, ?, ?, ?)',
                        [userId, companyName, position, recipient.email, new Date().toISOString()]
                    );
                    console.log(`✅ [DB INSERT] Saved to application history, result:`, insertResult);
                    
                    // Verify the insert
                    const verify = await dbConfig.get('SELECT * FROM application_history WHERE user_id = ? ORDER BY sent_date DESC LIMIT 1', [userId]);
                    console.log(`✅ [DB INSERT] Verification - Last record:`, verify);
                } catch (dbError) {
                    console.error(`❌ [DB INSERT] Failed to save to history:`, dbError.message);
                    console.error(`❌ [DB INSERT] Error stack:`, dbError.stack);
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
            try {
                await dbConfig.run(
                    'UPDATE users SET total_sent = total_sent + ? WHERE id = ?',
                    [successCount, userId]
                );
                console.log(`📊 Updated total_sent counter: +${successCount}`);
            } catch (error) {
                console.error('⚠️ Failed to update counter:', error.message);
            }
        }
        
        console.log(`\n✅ Completed: ${successCount}/${recipients.length} successful`);
        
        res.json({
            success: true,
            message: `Sent to ${successCount}/${recipients.length} recipients`,
            results,
        });
        } catch (error) {
            console.error('Database error:', error);
            return res.status(500).json({ error: 'Failed to load user profile' });
        }
    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok',
        message: 'Server is running. Configure your email settings to send applications.',
    });
});

// API endpoint to send single application from review page
app.post('/api/send-single-application', authenticateToken, async (req, res) => {
    console.log('\n=== SEND APPLICATION REQUEST RECEIVED ===');
    console.log('Request body:', JSON.stringify(req.body, null, 2));
    console.log('User from token:', req.user);
    console.log('==========================================\n');
    
    const userId = req.user.id;
    const { recipientEmail, websiteUrl, position, coverLetterText, companyName, companyAddress } = req.body;
    
    console.log('\n🔍 EXTRACTED FROM REQUEST:');
    console.log('  companyName:', companyName);
    console.log('  companyAddress:', companyAddress);
    console.log('  coverLetterText type:', typeof coverLetterText);
    console.log('  coverLetterText is HTML:', coverLetterText?.includes('<'));
    console.log('  coverLetterText length:', coverLetterText?.length);
    console.log('\n');

    // Get user profile
    try {
        const user = await dbConfig.get('SELECT * FROM users WHERE id = ?', [userId]);
        
        console.log('\n=== DATABASE USER QUERY ===');
        console.log('User found:', !!user);
        if (user) {
            console.log('User data:', {
        id: user.id,
        email: user.email,
        oauth_provider: user.oauth_provider,
        has_google_access_token: !!user.google_access_token,
        has_smtp_email: !!user.smtp_email,
        has_smtp_password: !!user.smtp_password
            });
        }
        console.log('===========================\n');
        
        if (!user) {
            return res.status(500).json({ error: 'Failed to load user profile' });
        }

        // Check if resume exists
        if (!user.resume_path) {
            return res.status(400).json({ error: 'Resume is required' });
        }

        // Use common PDF generation function (mobile version logic)
        const { filePath, fileName } = await generateCoverLetterPDF(
            user,
            coverLetterText,  // coverLetterText contains HTML from mobile
            companyName,
            companyAddress
        );

        console.log(`📄 Generated PDF for email: ${fileName} at ${filePath}`);

        // STEP 2: Read the generated PDF file
        const resumePath = path.join(__dirname, user.resume_path);
        const coverLetterPdfBuffer = await fs.readFile(filePath);

        // Generate professional email body
        const emailBody = generateEmailBody(position, companyName, user.full_name);
        const subject = `Application for ${position} - ${user.full_name}`;

        // Debug: Log user OAuth status
        console.log('=== USER OAUTH STATUS ===');
        console.log('User ID:', user.id);
        console.log('User Email:', user.email);
        console.log('OAuth Provider:', user.oauth_provider || 'NOT SET');
        console.log('Has Google Access Token:', !!user.google_access_token);
        console.log('Has Google Refresh Token:', !!user.google_refresh_token);
        console.log('Has SMTP Email:', !!user.smtp_email);
        console.log('Has SMTP Password:', !!user.smtp_password);
        console.log('=========================');

        // Priority 1: Try Gmail API if user logged in with OAuth
        if (user.oauth_provider === 'google' && user.google_access_token) {
            try {
                console.log('📧 Sending email via Gmail API (OAuth)...');
                console.log('OAuth User:', { id: user.id, email: user.email, provider: user.oauth_provider });
                console.log('Recipient:', recipientEmail);
                console.log('Subject:', subject);
                
                const result = await sendEmailViaGmail(
                    user,
                    recipientEmail,
                    subject,
                    emailBody,
                    resumePath,
                    coverLetterPdfBuffer
                );

                console.log(`✅ Application sent via Gmail to ${recipientEmail}`);
                
                // Save to application history
                try {
                    await dbConfig.run(
                        'INSERT INTO application_history (user_id, company_name, position, recipient_email, sent_date) VALUES (?, ?, ?, ?, ?)',
                        [userId, companyName, position, recipientEmail, new Date().toISOString()]
                    );
                    await dbConfig.run(
                        'UPDATE users SET total_sent = total_sent + 1 WHERE id = ?',
                        [userId]
                    );
                    console.log(`💾 Saved to application history and updated counters`);
                } catch (dbError) {
                    console.error(`⚠️ Failed to save to history:`, dbError.message);
                }
                
                return res.json({
                    success: true,
                    message: 'Application sent successfully via Gmail',
                    method: 'gmail-api'
                });

            } catch (gmailError) {
                console.error('❌ Gmail API error:', gmailError.message);
                console.error('Error details:', gmailError);
                console.error('Error stack:', gmailError.stack);
                
                // If OAuth token expired, inform user
                if (gmailError.message?.includes('OAuth token expired')) {
                    return res.status(401).json({
                        error: 'Your Google authentication has expired. Please log out and log in again with Google.',
                        requiresReauth: true
                    });
                }
                
                // Otherwise, fall through to SMTP
                console.log('⚠️ Gmail API failed, falling back to SMTP...');
            }
        }

        // Priority 2: Fall back to SMTP
        // Check if user has personal SMTP or use default from .env
        let smtpEmail, smtpPassword;
        
        if (user.smtp_email && user.smtp_password) {
            // Use user's personal SMTP credentials
            console.log('📧 Sending email via user SMTP credentials...');
            smtpEmail = user.smtp_email;
            smtpPassword = decryptData(user.smtp_password);
        } else if (process.env.SMTP_USER && process.env.SMTP_PASS) {
            // Use default SMTP credentials from .env
            console.log('📧 Sending email via default SMTP credentials (.env)...');
            smtpEmail = process.env.SMTP_USER;
            smtpPassword = process.env.SMTP_PASS;
            console.log('SMTP_USER from .env:', process.env.SMTP_USER);
            console.log('SMTP_PASS length:', process.env.SMTP_PASS?.length);
            console.log('SMTP_PASS first 4 chars:', process.env.SMTP_PASS?.substring(0, 4));
        } else {
            console.error('❌ No SMTP credentials available');
            console.error('User SMTP email:', user.smtp_email ? 'Set' : 'Not set');
            console.error('User SMTP password:', user.smtp_password ? 'Set' : 'Not set');
            console.error('Default SMTP email:', process.env.SMTP_USER ? 'Set' : 'Not set');
            console.error('Default SMTP password:', process.env.SMTP_PASS ? 'Set' : 'Not set');
            return res.status(400).json({ 
                error: 'Email sending failed. Please configure SMTP settings in Settings or log in with Google OAuth.' 
            });
        }

        console.log('SMTP User:', { id: user.id, email: user.email, smtp_email: smtpEmail });
        console.log('Recipient:', recipientEmail);
        console.log('Subject:', subject);

        // Create transporter
        const transporter = createTransporter(smtpEmail, smtpPassword);

        // Send email via SMTP
        const senderName = user.sender_name || user.full_name || smtpEmail.split('@')[0];

        await transporter.sendMail({
            from: `"${senderName}" <${smtpEmail}>`,
            replyTo: user.email,
            to: recipientEmail,
            subject: subject,
            text: emailBody,
            attachments: [
                {
                    filename: fileName,
                    path: filePath,
                },
                {
                    filename: path.basename(resumePath),
                    path: resumePath,
                },
            ],
        });

        console.log(`✅ Application sent via SMTP to ${recipientEmail}`);

        // Save to application history
        try {
            await dbConfig.run(
                'INSERT INTO application_history (user_id, company_name, position, recipient_email, sent_date) VALUES (?, ?, ?, ?, ?)',
                [userId, companyName, position, recipientEmail, new Date().toISOString()]
            );
            await dbConfig.run(
                'UPDATE users SET total_sent = total_sent + 1 WHERE id = ?',
                [userId]
            );
            console.log(`💾 Saved to application history and updated counters`);
        } catch (dbError) {
            console.error(`⚠️ Failed to save to history:`, dbError.message);
        }

        res.json({
            success: true,
            message: 'Application sent successfully via SMTP',
            method: 'smtp'
        });

    } catch (error) {
        console.error('Database error:', error);
        return res.status(500).json({ error: 'Failed to load user profile' });
    }
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

// Set up auth routes
app.use('/api/auth', authRoutes);
app.use('/auth', authRoutes);

// Set up profile routes with authentication
app.use('/api/users', authenticateToken, profileRoutes);

// Set up user data routes
app.use('/api/users', userDataRoutes);
app.use('/api', creditsRoutes);
app.use('/api', adminPackagesRoutes);
app.use('/api', coverLetterRoutes);
app.use('/api', emailRoutes);

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔═══════════════════════════════════════════════════════╗
║        Resume Sender App - Server Running            ║
╚═══════════════════════════════════════════════════════╝

🌐 Server: http://0.0.0.0:${PORT}
🌐 Local: http://localhost:${PORT}
🌐 Network: http://192.168.1.14:${PORT}
📧 Configure your email in Settings

Open your browser and visit any of the above URLs
    `);
});
