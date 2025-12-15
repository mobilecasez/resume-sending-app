const express = require('express');
const path = require('path');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const CryptoJS = require('crypto-js');
const sqlite3 = require('sqlite3').verbose();
const session = require('express-session');
const cookieParser = require('cookie-parser');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const nodemailer = require('nodemailer');
const fs = require('fs').promises;
const sharp = require('sharp');
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
app.use(cookieParser());
app.use(session({
    secret: JWT_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

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

    if (!token) {
        return res.status(401).json({ error: 'Access denied. No token provided.' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid or expired token' });
        }
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
        recipientName: 'Hiring Team',
        country: 'India',
        relevantSkills: process.env.RELEVANT_SKILLS || 'JavaScript, React, Node.js',
        companyParagraph: process.env.COMPANY_PARAGRAPH || `I am particularly drawn to ${companyName}'s innovative approach and commitment to excellence.`,
    };

    const pdfDoc = await PDFDocument.create();
    const pageWidth = 595;
    const pageHeight = 1067;
    const page = pdfDoc.addPage([pageWidth, pageHeight]);

    const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

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
        `Dear Hiring Team,`,
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
    const fileName = `Cover_Letter_${companyName.replace(/\s+/g, '_')}.pdf`;
    const filePath = path.join(__dirname, 'temp', fileName);

    await fs.mkdir(path.join(__dirname, 'temp'), { recursive: true });
    await fs.writeFile(filePath, pdfBytes);

    return { filePath, fileName };
}

// TWO-COLUMN cover letter PDF generator (like Cover_Letter_Google_New.pdf from Dec 4)
async function createCoverLetterPDF(userData, coverLetterText, companyName, photoPath, signaturePath) {
    const pdfDoc = await PDFDocument.create();
    const pageWidth = 595;
    const pageHeight = 1067;
    const page = pdfDoc.addPage([pageWidth, pageHeight]);

    const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

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
    page.drawText('Hiring Team', {
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
    
    page.drawText(userData.country || 'India', {
        x: 20,
        y: sidebarY,
        size: 10,
        font: helvetica,
        color: rgb(1, 1, 1),
    });

    sidebarY -= 20;
    
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
    const paragraphs = ['Dear Hiring Team,', ...coverLetterText.split('\n').filter(p => p.trim())];

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
    const fileName = `CoverLetter_${Date.now()}_${companyName.replace(/\s+/g, '_')}.pdf`;
    const filePath = path.join(__dirname, 'temp', fileName);

    await fs.mkdir(path.join(__dirname, 'temp'), { recursive: true });
    await fs.writeFile(filePath, pdfBytes);

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
                                    <h2 style="color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 10px;">Dear Hiring Team at ${companyName},</h2>
                                    
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
