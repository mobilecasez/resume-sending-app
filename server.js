const express = require('express');
const path = require('path');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const CryptoJS = require('crypto-js');
const sqlite3 = require('sqlite3').verbose();
const session = require('express-session');
const cookieParser = require('cookie-parser');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const LinkedInStrategy = require('passport-linkedin-oauth2').Strategy;
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const PDFKit = require('pdfkit');
const nodemailer = require('nodemailer');
const fs = require('fs').promises;
const fsSync = require('fs');
const sharp = require('sharp');
const cheerio = require('cheerio');
const AICoverLetterGenerator = require('./ai-cover-letter-generator');
const TemplateCoverLetterGenerator = require('./template-cover-letter-generator');
require('dotenv').config();

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

// Initialize SQLite database
const db = new sqlite3.Database('./database.db', (err) => {
    if (err) {
        console.error('Error opening database:', err);
    } else {
        console.log('Connected to SQLite database');
        initializeDatabase();
    }
});

// Create tables
function initializeDatabase() {
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            full_name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            smtp_email TEXT,
            smtp_password TEXT,
            sender_name TEXT,
            resume_path TEXT,
            photo_path TEXT,
            signature_path TEXT,
            date_of_birth DATE,
            phone_number TEXT,
            address TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `, (err) => {
        if (err) {
            console.error('Error creating users table:', err);
        } else {
            console.log('Users table ready');
        }
    });

    // Create recipients table for storing user's recipient list
    db.run(`
        CREATE TABLE IF NOT EXISTS recipients (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            email TEXT NOT NULL,
            website TEXT NOT NULL,
            position TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            UNIQUE(user_id, email)
        )
    `, (err) => {
        if (err) {
            console.error('Error creating recipients table:', err);
        } else {
            console.log('Recipients table ready');
        }
    });
}

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
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Passport Google OAuth Configuration
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID || 'your-google-client-id',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'your-google-client-secret',
    callbackURL: 'http://localhost:3000/auth/google/callback'
}, (accessToken, refreshToken, profile, done) => {
    // Handle Google OAuth callback
    handleOAuthUser(profile, 'google', done);
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

passport.deserializeUser((id, done) => {
    db.get('SELECT * FROM users WHERE id = ?', [id], (err, user) => {
        done(err, user);
    });
});

// OAuth user handler function
function handleOAuthUser(profile, provider, callback) {
    const email = profile.emails && profile.emails[0] ? profile.emails[0].value : null;
    const fullName = profile.displayName;
    
    if (!email) {
        return callback(new Error('No email found in OAuth profile'));
    }

    // Check if user exists
    db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
        if (err) {
            return callback(err);
        }

        if (user) {
            // User exists, return it
            return callback(null, user);
        }

        // Create new user
        const hashedPassword = jwt.sign({ provider, email }, JWT_SECRET); // Use JWT as placeholder password for OAuth users
        db.run(
            'INSERT INTO users (full_name, email, password) VALUES (?, ?, ?)',
            [fullName, email, hashedPassword],
            function(err) {
                if (err) {
                    return callback(err);
                }
                
                db.get('SELECT * FROM users WHERE id = ?', [this.lastID], (err, newUser) => {
                    callback(err, newUser);
                });
            }
        );
    });
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

// Authentication middleware
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    console.log('Auth check - Header present:', !!authHeader);
    console.log('Auth check - Token present:', !!token);

    if (!token) {
        console.log('Auth failed: No token provided');
        return res.status(401).json({ error: 'Access denied. No token provided.' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            console.log('Auth failed: Token verification error:', err.message);
            return res.status(403).json({ error: 'Invalid or expired token. Please login again.' });
        }
        console.log('Auth success for user:', user.id);
        req.user = user;
        next();
    });
}

// Auth endpoints
app.post('/api/auth/register', async (req, res) => {
    try {
        const { fullName, email, password } = req.body;

        if (!fullName || !email || !password) {
            return res.status(400).json({ error: 'All fields are required' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        // Check if user already exists
        db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
            if (err) {
                return res.status(500).json({ error: 'Database error' });
            }

            if (user) {
                return res.status(400).json({ error: 'Email already registered' });
            }

            // Hash password
            const hashedPassword = await bcrypt.hash(password, 10);

            // Insert user
            db.run(
                'INSERT INTO users (full_name, email, password) VALUES (?, ?, ?)',
                [fullName, email, hashedPassword],
                function(err) {
                    if (err) {
                        return res.status(500).json({ error: 'Failed to create user' });
                    }

                    res.json({ 
                        success: true, 
                        message: 'User created successfully',
                        userId: this.lastID 
                    });
                }
            );
        });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
            if (err) {
                return res.status(500).json({ error: 'Database error' });
            }

            if (!user) {
                return res.status(401).json({ error: 'Invalid email or password' });
            }

            // Verify password
            const validPassword = await bcrypt.compare(password, user.password);
            if (!validPassword) {
                return res.status(401).json({ error: 'Invalid email or password' });
            }

            // Generate JWT
            const token = jwt.sign(
                { id: user.id, email: user.email },
                JWT_SECRET,
                { expiresIn: '24h' }
            );

            res.json({
                success: true,
                token,
                user: {
                    id: user.id,
                    fullName: user.full_name,
                    email: user.email
                }
            });
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// OAuth Routes
// Google OAuth
app.get('/auth/google', passport.authenticate('google', {
    scope: ['profile', 'email']
}));

// Google OAuth callback - Web/Desktop version (redirects to HTML)
app.get('/auth/google/callback', passport.authenticate('google', {
    failureRedirect: '/login.html'
}), (req, res) => {
    // Check if this is a mobile request
    const isMobile = req.query.mobile === 'true' || req.headers['user-agent']?.includes('Expo');
    
    // Generate JWT token for the user
    const token = jwt.sign(
        { id: req.user.id, email: req.user.email },
        JWT_SECRET,
        { expiresIn: '24h' }
    );

    const userData = {
        id: req.user.id,
        fullName: req.user.full_name,
        email: req.user.email
    };

    // For mobile apps, return JSON instead of HTML redirect
    if (isMobile) {
        res.json({
            success: true,
            token,
            user: userData
        });
    } else {
        // For web, redirect to success page
        res.redirect(`/auth-success.html?token=${token}&user=${encodeURIComponent(JSON.stringify(userData))}`);
    }
});

// Google OAuth API endpoint for mobile (returns JSON)
app.post('/api/auth/google', async (req, res) => {
    try {
        console.log('Google OAuth Request Body:', req.body);
        const { accessToken } = req.body;
        
        if (!accessToken) {
            console.log('Missing accessToken in request');
            return res.status(400).json({ error: 'Access token is required' });
        }

        console.log('Verifying access token with Google API...');
        // Get user info from Google
        const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v1/userinfo', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        if (!userInfoResponse.ok) {
            console.error('Google API Error:', userInfoResponse.status, userInfoResponse.statusText);
            return res.status(401).json({ error: 'Failed to get user info from Google', googleStatus: userInfoResponse.status });
        }

        const googleUser = await userInfoResponse.json();
        console.log('Google User Info:', { email: googleUser.email, name: googleUser.name });
        
        // Find or create user in database
        db.get('SELECT * FROM users WHERE email = ?', [googleUser.email], async (err, user) => {
            if (err) {
                console.error('Database error:', err);
                return res.status(500).json({ error: 'Database error' });
            }

            if (!user) {
                // Create new user from Google data
                const hashedPassword = await bcrypt.hash('google-oauth-' + googleUser.id, 10);
                db.run(
                    'INSERT INTO users (email, full_name, password) VALUES (?, ?, ?)',
                    [googleUser.email, googleUser.name, hashedPassword],
                    function(insertErr) {
                        if (insertErr) {
                            return res.status(500).json({ error: 'Failed to create user' });
                        }

                        // Generate JWT
                        const token = jwt.sign(
                            { id: this.lastID, email: googleUser.email },
                            JWT_SECRET,
                            { expiresIn: '24h' }
                        );

                        res.json({
                            success: true,
                            token,
                            user: {
                                id: this.lastID,
                                fullName: googleUser.name,
                                email: googleUser.email
                            }
                        });
                    }
                );
            } else {
                // User exists, generate JWT
                const token = jwt.sign(
                    { id: user.id, email: user.email },
                    JWT_SECRET,
                    { expiresIn: '24h' }
                );

                res.json({
                    success: true,
                    token,
                    user: {
                        id: user.id,
                        fullName: user.full_name,
                        email: user.email
                    }
                });
            }
        });
    } catch (error) {
        console.error('Google OAuth error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// LinkedIn OAuth (Disabled due to API compatibility issues)
/*
app.get('/auth/linkedin', passport.authenticate('linkedin', {
    scope: ['profile', 'email']
}));

app.get('/auth/linkedin/callback', passport.authenticate('linkedin', {
    failureRedirect: '/login.html'
}), (req, res) => {
    // Generate JWT token for the user
    const token = jwt.sign(
        { id: req.user.id, email: req.user.email },
        JWT_SECRET,
        { expiresIn: '24h' }
    );

    res.redirect(`/auth-success.html?token=${token}&user=${encodeURIComponent(JSON.stringify({
        id: req.user.id,
        fullName: req.user.full_name,
        email: req.user.email
    }))}`);
});
*/

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

            db.run(sql, params, function(err) {
                if (err) {
                    console.error('Database update error:', err);
                    return res.status(500).json({ error: 'Failed to save file information' });
                }

                res.json({
                    success: true,
                    message: 'Files uploaded successfully',
                    files,
                });
            });
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

// Mobile API: Get user profile data
app.get('/api/users/profile', authenticateToken, (req, res) => {
    const userId = req.user.id;
    
    db.get('SELECT full_name, email, resume_path, photo_path, signature_path, phone_number, address, date_of_birth, created_at FROM users WHERE id = ?', [userId], (err, user) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        res.json({
            fullName: user.full_name,
            email: user.email,
            phone: user.phone_number,
            address: user.address,
            dateOfBirth: user.date_of_birth,
            profileImage: user.photo_path ? `http://${req.get('host')}/${user.photo_path}` : null,
            resume: user.resume_path ? `http://${req.get('host')}/${user.resume_path}` : null,
            signature: user.signature_path ? `http://${req.get('host')}/${user.signature_path}` : null,
            createdAt: user.created_at
        });
    });
});

// Mobile API: Upload profile image
app.post('/api/users/profile/image', authenticateToken, upload.single('profileImage'), async (req, res) => {
    try {
        const userId = req.user.id;
        
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        const filePath = req.file.path.replace(__dirname + '/', '');
        
        db.run('UPDATE users SET photo_path = ? WHERE id = ?', [filePath, userId], (err) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            
            res.json({
                success: true,
                message: 'Profile image uploaded successfully',
                path: `http://${req.get('host')}/${filePath}`
            });
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Mobile API: Upload resume
app.post('/api/users/profile/resume', authenticateToken, upload.single('resume'), async (req, res) => {
    try {
        const userId = req.user.id;
        
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        const filePath = req.file.path.replace(__dirname + '/', '');
        
        db.run('UPDATE users SET resume_path = ? WHERE id = ?', [filePath, userId], (err) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            
            res.json({
                success: true,
                message: 'Resume uploaded successfully',
                path: `http://${req.get('host')}/${filePath}`
            });
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Mobile API: Upload signature
app.post('/api/users/profile/signature', authenticateToken, upload.single('signature'), async (req, res) => {
    try {
        const userId = req.user.id;
        
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        const filePath = req.file.path.replace(__dirname + '/', '');
        
        db.run('UPDATE users SET signature_path = ? WHERE id = ?', [filePath, userId], (err) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            
            res.json({
                success: true,
                message: 'Signature uploaded successfully',
                path: `http://${req.get('host')}/${filePath}`
            });
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Mobile API: Update user profile data
app.post('/api/users/profile/update', authenticateToken, (req, res) => {
    try {
        const userId = req.user.id;
        const { fullName, phone, address, dateOfBirth } = req.body;

        const updates = [];
        const params = [];

        if (fullName) {
            updates.push('full_name = ?');
            params.push(fullName);
        }
        if (phone) {
            updates.push('phone_number = ?');
            params.push(phone);
        }
        if (address) {
            updates.push('address = ?');
            params.push(address);
        }
        if (dateOfBirth) {
            updates.push('date_of_birth = ?');
            params.push(dateOfBirth);
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        params.push(userId);
        const sql = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;

        db.run(sql, params, function(err) {
            if (err) {
                console.error('Update error:', err);
                return res.status(500).json({ error: err.message });
            }

            res.json({
                success: true,
                message: 'Profile updated successfully'
            });
        });
    } catch (error) {
        console.error('Update error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Change password endpoint
app.post('/api/auth/change-password', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Current and new password are required' });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({ error: 'New password must be at least 6 characters' });
        }

        // Get user from database
        db.get('SELECT password FROM users WHERE id = ?', [userId], async (err, user) => {
            if (err) {
                return res.status(500).json({ error: 'Database error' });
            }

            if (!user) {
                return res.status(404).json({ error: 'User not found' });
            }

            // Verify current password
            const validPassword = await bcrypt.compare(currentPassword, user.password);
            if (!validPassword) {
                return res.status(401).json({ error: 'Current password is incorrect' });
            }

            // Hash new password
            const hashedPassword = await bcrypt.hash(newPassword, 10);

            // Update password in database
            db.run('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, userId], function(err) {
                if (err) {
                    console.error('Password update error:', err);
                    return res.status(500).json({ error: 'Failed to update password' });
                }

                res.json({
                    success: true,
                    message: 'Password changed successfully'
                });
            });
        });
    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Privacy settings endpoint
app.post('/api/users/privacy-settings', authenticateToken, (req, res) => {
    try {
        const userId = req.user.id;
        const { emailNotifications, smsNotifications, profilePublic } = req.body;

        // Store privacy settings as JSON in the database
        // For now, we'll just return success as these settings can be stored in a future update
        const privacySettings = {
            emailNotifications,
            smsNotifications,
            profilePublic
        };

        // In the future, add a privacy_settings column to users table and save there
        // For now, just acknowledge receipt and store in session/memory if needed
        res.json({
            success: true,
            message: 'Privacy settings updated successfully',
            privacySettings: privacySettings
        });
    } catch (error) {
        console.error('Privacy settings error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Save/Update recipients for a user
app.post('/api/users/recipients', authenticateToken, (req, res) => {
    try {
        const userId = req.user.id;
        const { recipients } = req.body;

        if (!recipients || !Array.isArray(recipients)) {
            return res.status(400).json({ error: 'Recipients must be an array' });
        }

        // Clear existing recipients for this user
        db.run('DELETE FROM recipients WHERE user_id = ?', [userId], (err) => {
            if (err) {
                console.error('Error clearing recipients:', err);
                return res.status(500).json({ error: 'Database error' });
            }

            // Insert new recipients
            const validRecipients = recipients.filter(r => r.email && r.website);
            
            if (validRecipients.length === 0) {
                return res.json({
                    success: true,
                    message: 'Recipients cleared successfully',
                    recipientsCount: 0
                });
            }

            let insertedCount = 0;
            let errorOccurred = false;

            validRecipients.forEach((recipient, index) => {
                db.run(
                    'INSERT INTO recipients (user_id, email, website, position) VALUES (?, ?, ?, ?)',
                    [userId, recipient.email, recipient.website, recipient.position || ''],
                    function(err) {
                        if (err) {
                            console.error('Error inserting recipient:', err);
                            errorOccurred = true;
                        } else {
                            insertedCount++;
                        }

                        // Send response after last insert
                        if (index === validRecipients.length - 1) {
                            if (errorOccurred && insertedCount === 0) {
                                return res.status(500).json({ error: 'Failed to save recipients' });
                            }
                            res.json({
                                success: true,
                                message: `Successfully saved ${insertedCount} recipients`,
                                recipientsCount: insertedCount
                            });
                        }
                    }
                );
            });
        });
    } catch (error) {
        console.error('Save recipients error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get recipients for a user
app.get('/api/users/recipients', authenticateToken, (req, res) => {
    try {
        const userId = req.user.id;

        db.all(
            'SELECT id, email, website, position FROM recipients WHERE user_id = ? ORDER BY created_at ASC',
            [userId],
            (err, recipients) => {
                if (err) {
                    console.error('Error fetching recipients:', err);
                    return res.status(500).json({ error: 'Database error' });
                }

                res.json({
                    success: true,
                    recipients: recipients || [],
                    count: (recipients || []).length
                });
            }
        );
    } catch (error) {
        console.error('Get recipients error:', error);
        res.status(500).json({ error: error.message });
    }
});

// API endpoint to get user profile data (protected)
app.get('/api/user-profile', authenticateToken, (req, res) => {
    const userId = req.user.id;

    db.get('SELECT full_name, email, resume_path, photo_path, signature_path, smtp_email, smtp_password, sender_name, date_of_birth, phone_number, address, city, country, zipcode, created_at FROM users WHERE id = ?', [userId], (err, user) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Decrypt SMTP password before sending (only send masked version to frontend)
        const decryptedPassword = user.smtp_password ? '********' : '';

        res.json({
            success: true,
            profile: {
                fullName: user.full_name,
                email: user.email,
                resumePath: user.resume_path,
                photoPath: user.photo_path,
                signaturePath: user.signature_path,
                smtpEmail: user.smtp_email,
                smtpPassword: decryptedPassword, // Send masked password
                senderName: user.sender_name,
                dateOfBirth: user.date_of_birth,
                phoneNumber: user.phone_number,
                address: user.address,
                city: user.city,
                country: user.country,
                zipcode: user.zipcode,
                createdAt: user.created_at,
            }
        });
    });
});

// API endpoint to save email settings (protected)
app.post('/api/save-settings', authenticateToken, (req, res) => {
    const userId = req.user.id;
    const { email, password, name } = req.body;

    if (!email || !password || !name) {
        return res.status(400).json({ error: 'All fields are required' });
    }

    // Encrypt SMTP password before storing
    const encryptedPassword = encryptData(password);

    db.run(
        'UPDATE users SET smtp_email = ?, smtp_password = ?, sender_name = ? WHERE id = ?',
        [email, encryptedPassword, name, userId],
        function(err) {
            if (err) {
                console.error('Settings update error:', err);
                return res.status(500).json({ error: 'Failed to save settings' });
            }

            res.json({
                success: true,
                message: 'Settings saved successfully'
            });
        }
    );
});

// API endpoint to update user personal details (protected)
app.post('/api/update-user-details', authenticateToken, (req, res) => {
    const userId = req.user.id;
    const { fullName, dateOfBirth, phoneNumber, address, city, country, zipcode } = req.body;

    if (!fullName) {
        return res.status(400).json({ error: 'Full name is required' });
    }

    db.run(
        'UPDATE users SET full_name = ?, date_of_birth = ?, phone_number = ?, address = ?, city = ?, country = ?, zipcode = ? WHERE id = ?',
        [fullName, dateOfBirth || null, phoneNumber || null, address || null, city || null, country || null, zipcode || null, userId],
        function(err) {
            if (err) {
                console.error('User details update error:', err);
                return res.status(500).json({ error: 'Failed to update user details' });
            }

            res.json({
                success: true,
                message: 'User details updated successfully'
            });
        }
    );
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
    return new Promise(async (resolve, reject) => {
        try {
            const currentDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
            const sanitizedCompanyName = companyName.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
            const fileName = `Cover_Letter_${currentDate}_${sanitizedCompanyName}.pdf`;
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
                        
                        const wordWidth = doc.widthOfString(word);
                        
                        // Check if word fits on current line
                        if (currentX + wordWidth > maxX && currentX > contentX) {
                            // Move to next line
                            currentX = contentX;
                            lineStartY += lineHeight;
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

// API endpoint to generate cover letters only (no sending)
app.post('/api/generate-cover-letters', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { recipients } = req.body;

        if (!recipients || recipients.length === 0) {
            return res.status(400).json({ error: 'No recipients provided' });
        }

        // Get user's complete profile and files from database
        db.get('SELECT full_name, email, phone_number, city, country, resume_path, photo_path, signature_path FROM users WHERE id = ?', 
            [userId], async (err, user) => {
                if (err) {
                    return res.status(500).json({ error: 'Database error' });
                }

                if (!user.resume_path) {
                    return res.status(400).json({ 
                        error: 'Resume is required. Please upload your resume in the Profile page.' 
                    });
                }

                const results = [];

                // Prepare user data for AI generation
                const userData = {
                    fullName: user.full_name,
                    email: user.email,
                    phoneNumber: user.phone_number,
                    city: user.city,
                    country: user.country
                };

                const resumePath = path.join(__dirname, user.resume_path);
                const photoPath = user.photo_path ? path.join(__dirname, user.photo_path) : null;
                const signaturePath = user.signature_path ? path.join(__dirname, user.signature_path) : null;

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

                        // Use the EXISTING PDF generator (the one that works perfectly!)
                        const { filePath, fileName } = await createCoverLetterPDF(
                            userData,
                            coverLetterText,
                            companyName,
                            photoPath,
                            signaturePath
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
                
                console.log(`\n✅ Generated: ${successCount}/${recipients.length} cover letters`);
                
                res.json({
                    success: true,
                    message: `Generated ${successCount}/${recipients.length} cover letters`,
                    results,
                });
        });
    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({ error: error.message });
    }
});

// API endpoint to generate cover letter details with AI for review page
app.post('/api/generate-cover-letter-details', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { recipientEmail, websiteUrl, position } = req.body;

        console.log('Generate cover letter details request:', { userId, recipientEmail, websiteUrl, position });

        // Get user profile
        db.get('SELECT * FROM users WHERE id = ?', [userId], async (err, user) => {
            if (err) {
                console.error('Database error:', err);
                return res.status(500).json({ error: 'Failed to load user profile' });
            }
            
            if (!user) {
                console.error('User not found:', userId);
                return res.status(500).json({ error: 'User not found' });
            }

            if (!user.resume_path) {
                console.error('Resume not found for user:', userId);
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
                console.log('Resume path:', resumePath);
                
                // Generate cover letter with AI
                const generator = new TemplateCoverLetterGenerator();
                console.log('Generating cover letter...');
                
                const result = await generator.generateCoverLetter(
                    userData,
                    resumePath,
                    recipientEmail,
                    websiteUrl,
                    position
                );

                console.log('Cover letter generation result:', result.success);

                if (!result.success) {
                    console.error('Cover letter generation failed');
                    return res.status(500).json({ error: 'Failed to generate cover letter' });
                }

                // Format cover letter with HTML (bold key points)
                const coverLetterHtml = formatCoverLetterWithHTML(result.coverLetter, result.metadata);

                // Generate hiring manager name, all locations, and subject using AI
                console.log('Generating additional details...');
                const { hiringManager, locations, subject } = await generateAdditionalDetails(websiteUrl, result.companyName, position);
                console.log('Generated locations:', locations.length);
                console.log('Generated subject:', subject);

                res.json({
                    success: true,
                    companyName: result.companyName,
                    hiringManager: hiringManager,
                    subject: subject,
                    locations: locations,
                    coverLetterHtml: coverLetterHtml,
                    metadata: result.metadata
                });

            } catch (error) {
                console.error('Error generating cover letter details:', error);
                console.error('Error stack:', error.stack);
                return res.status(500).json({ error: error.message || 'Failed to generate cover letter' });
            }
        });
    } catch (error) {
        console.error('Server error:', error);
        console.error('Server error stack:', error.stack);
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
        db.get('SELECT * FROM users WHERE id = ?', [userId], async (err, user) => {
            if (err) {
                console.error('Database error:', err);
                return res.status(500).json({ error: 'Failed to load user profile' });
            }
            
            if (!user) {
                console.error('User not found:', userId);
                return res.status(500).json({ error: 'User not found' });
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

                // Get photo and signature paths if they exist
                const photoPath = user.photo_path ? path.join(__dirname, user.photo_path) : null;
                const signaturePath = user.signature_path ? path.join(__dirname, user.signature_path) : null;

                // Generate PDF using existing logic with HTML content
                const { filePath, fileName } = await createCoverLetterPDFFromHTML(
                    userData,
                    coverLetterHtml,
                    companyName,
                    companyAddress || '',
                    photoPath,
                    signaturePath
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
        });
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
        
        // Bold important keywords
        let formattedPara = para;
        
        // Bold skills if mentioned
        if (metadata.techMatches && metadata.techMatches.length > 0) {
            metadata.techMatches.forEach(skill => {
                const regex = new RegExp(`\\b${skill}\\b`, 'gi');
                formattedPara = formattedPara.replace(regex, `<strong>${skill}</strong>`);
            });
        }
        
        // Bold years of experience
        formattedPara = formattedPara.replace(/(\d+[\+]?\s+years?)/gi, '<strong>$1</strong>');
        
        // Bold company name
        formattedPara = formattedPara.replace(/(\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*'s)/g, '<strong>$1</strong>');
        
        // Bold action verbs at sentence start
        const actionVerbs = ['Led', 'Managed', 'Developed', 'Built', 'Created', 'Implemented', 'Designed', 'Achieved', 'Delivered'];
        actionVerbs.forEach(verb => {
            const regex = new RegExp(`^${verb}\\b`, 'g');
            formattedPara = formattedPara.replace(regex, `<strong>${verb}</strong>`);
        });
        
        html += `<p>${formattedPara}</p>`;
    });
    
    return html;
}

// Helper function to generate hiring manager name and all company locations using AI
async function generateAdditionalDetails(websiteUrl, companyName, position = 'Position') {
    const geminiKey = process.env.GEMINI_API_KEY;
    
    if (!geminiKey) {
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

    try {
        const { GoogleGenerativeAI } = require('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(geminiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-pro' });

        const prompt = `You are a research assistant. Find ALL office locations and addresses for the company "${companyName}" (website: ${websiteUrl}).

TASK:
1. Search for ALL physical office locations including: current headquarters, historical/previous addresses, branch offices, regional offices
2. For Comparis specifically, look for BOTH: Birmensdorferstrasse 108 AND Stampfenbachstrasse 48 addresses
3. Check: contact pages, about us pages, impressum, legal notices, company registry
4. Generate a realistic hiring manager name based on the company's country/region
5. Generate a professional email subject line for the position: "${position}"

REQUIRED OUTPUT (JSON format only):
{
    "hiringManager": "Realistic Full Name",
    "subject": "Professional Email Subject Line for Application",
    "locations": [
        {
            "country": "Full Country Name",
            "city": "City Name",
            "address": "Complete Street Address with Postal/ZIP Code",
            "isHeadquarters": true
        },
        {
            "country": "Full Country Name",
            "city": "City Name",
            "address": "Complete Street Address with Postal/ZIP Code",
            "isHeadquarters": false
        }
    ]
}

IMPORTANT RULES:
- Find ALL real addresses (current AND historical/alternative addresses)
- For Swiss companies, use format: "Street Number, CH-PostalCode City"
- Include postal/ZIP codes in the address
- If company has multiple locations, list ALL of them
- Mark the main/current office with "isHeadquarters": true
- Generate a professional Swiss name for hiring manager (e.g., Lukas Schmidt, Hans Mueller)
- Subject line should be formal and professional (e.g., "Application for ${position} Position at ${companyName}")
- Return ONLY valid JSON, no additional text

Example for Comparis:
{
    "hiringManager": "Hans Mueller",
    "subject": "Application for Solution Architect Position at Comparis",
    "locations": [
        {
            "country": "Switzerland",
            "city": "Zürich",
            "address": "Birmensdorferstrasse 108, CH-8003 Zürich",
            "isHeadquarters": true
        },
        {
            "country": "Switzerland",
            "city": "Zürich",
            "address": "Stampfenbachstrasse 48, CH-8006 Zürich",
            "isHeadquarters": false
        }
    ]
}`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        
        console.log('Gemini AI response for locations:', text.substring(0, 200));
        
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

        if (!recipients || recipients.length === 0) {
            return res.status(400).json({ error: 'No recipients provided' });
        }

        // Get user's complete profile and files from database
        db.get('SELECT full_name, email, phone_number, city, country, smtp_email, smtp_password, sender_name, resume_path, photo_path, signature_path FROM users WHERE id = ?', 
            [userId], async (err, user) => {
                if (err) {
                    return res.status(500).json({ error: 'Database error' });
                }

                if (!user || !user.smtp_email || !user.smtp_password) {
                    return res.status(400).json({ 
                        error: 'Email settings are required. Please configure your email in Settings.' 
                    });
                }

                if (!user.resume_path) {
                    return res.status(400).json({ 
                        error: 'Resume is required. Please upload your resume in the Profile page.' 
                    });
                }

                // Decrypt SMTP password
                const decryptedPassword = decryptData(user.smtp_password);

                // Create transporter with user's credentials
                const transporter = createTransporter(user.smtp_email, decryptedPassword);
                
                const results = [];
                const emailSettings = {
                    email: user.smtp_email,
                    name: user.sender_name || user.full_name || user.smtp_email.split('@')[0]
                };

                // Prepare user data for AI generation
                const userData = {
                    fullName: user.full_name,
                    email: user.email,
                    phoneNumber: user.phone_number,
                    city: user.city,
                    country: user.country
                };

                const resumePath = path.join(__dirname, user.resume_path);
                const photoPath = user.photo_path ? path.join(__dirname, user.photo_path) : null;
                const signaturePath = user.signature_path ? path.join(__dirname, user.signature_path) : null;

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

                            // Use existing PDF generator
                            const pdfResult = await createCoverLetterPDF(
                                userData,
                                coverLetterText,
                                companyName,
                                photoPath,
                                signaturePath
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
                            replyTo: emailSettings.email,
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
                
                console.log(`\n✅ Completed: ${successCount}/${recipients.length} successful`);
                
                res.json({
                    success: true,
                    message: `Sent to ${successCount}/${recipients.length} recipients`,
                    results,
                });
        });
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
    try {
        const userId = req.user.id;
        const { recipientEmail, websiteUrl, position, coverLetterText, companyName } = req.body;

        // Get user profile
        db.get('SELECT * FROM users WHERE id = ?', [userId], async (err, user) => {
            if (err || !user) {
                return res.status(500).json({ error: 'Failed to load user profile' });
            }

            if (!user.smtp_email || !user.smtp_password) {
                return res.status(400).json({ error: 'Please configure SMTP settings in Settings' });
            }

            if (!user.resume_path) {
                return res.status(400).json({ error: 'Resume is required' });
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
                const photoPath = user.photo_path ? path.join(__dirname, user.photo_path) : null;
                const signaturePath = user.signature_path ? path.join(__dirname, user.signature_path) : null;

                // Generate PDF from the cover letter text
                const { filePath, fileName } = await createCoverLetterPDF(
                    userData,
                    coverLetterText,
                    companyName,
                    photoPath,
                    signaturePath
                );

                // Decrypt SMTP password
                const decryptedPassword = decryptData(user.smtp_password);

                // Create transporter
                const transporter = createTransporter(user.smtp_email, decryptedPassword);

                // Send email
                const senderName = user.sender_name || user.full_name || user.smtp_email.split('@')[0];
                const subject = `Application for ${position} - ${user.full_name}`;

                await transporter.sendMail({
                    from: `"${senderName}" <${user.smtp_email}>`,
                    to: recipientEmail,
                    subject: subject,
                    html: `
                        <p>Dear Hiring Manager,</p>
                        <p>Please find attached my application for the ${position} position.</p>
                        <p>Best regards,<br>${user.full_name}</p>
                    `,
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

                console.log(`✅ Application sent to ${recipientEmail}`);

                res.json({
                    success: true,
                    message: 'Application sent successfully'
                });

            } catch (error) {
                console.error('Error sending application:', error);
                res.status(500).json({ error: error.message });
            }
        });
    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════╗
║        Resume Sender App - Server Running            ║
╚═══════════════════════════════════════════════════════╝

🌐 Server: http://localhost:${PORT}
📧 Configure your email in Settings

Open your browser and visit: http://localhost:${PORT}
    `);
});
