const Imap = require('imap');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const dbConfig = require('../../db-config');

class EmailForwardingService {
    constructor() {
        this.imap = null;
        this.isRunning = false;
        this.checkInterval = 2 * 60 * 1000; // Check every 2 minutes
    }

    // Initialize IMAP connection
    connect() {
        if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
            console.log('⚠️ Email forwarding disabled: SMTP credentials not configured');
            return;
        }

        this.imap = new Imap({
            user: process.env.SMTP_USER,
            password: process.env.SMTP_PASS,
            host: process.env.IMAP_HOST || 'imap.zoho.com',
            port: parseInt(process.env.IMAP_PORT || '993'),
            tls: true,
            tlsOptions: { rejectUnauthorized: false }
        });

        this.imap.once('ready', () => {
            console.log('✅ Email forwarding service connected to IMAP');
            this.isRunning = true;
            this.checkForReplies();
        });

        this.imap.once('error', (err) => {
            console.error('❌ IMAP connection error:', err.message);
            this.isRunning = false;
        });

        this.imap.once('end', () => {
            console.log('📭 IMAP connection ended');
            this.isRunning = false;
        });

        this.imap.connect();
    }

    // Extract user info from email address (cv+email.YYYYMMDD@domain.com -> {emailUsername, dob})
    extractUserInfo(emailAddress) {
        // Match pattern: +email.YYYYMMDD@
        const match = emailAddress.match(/\+([^.]+)\.(\d{8})@/);
        if (!match) return null;
        return { 
            emailUsername: match[1], 
            dob: match[2] // YYYYMMDD format
        };
    }

    // Check for new replies and forward them
    async checkForReplies() {
        if (!this.isRunning) return;

        try {
            this.imap.openBox('INBOX', false, async (err, box) => {
                if (err) {
                    console.error('Error opening inbox:', err);
                    return;
                }

                // Search for unseen emails with + in To: field (matches cv+anything@domain.com)
                this.imap.search(['UNSEEN', ['HEADER', 'TO', '+@']], async (err, results) => {
                    if (err) {
                        console.error('Error searching emails:', err);
                        return;
                    }

                    if (!results || results.length === 0) {
                        console.log('📬 No new replies to forward');
                        this.scheduleNextCheck();
                        return;
                    }

                    console.log(`📨 Found ${results.length} replies to process`);

                    const fetch = this.imap.fetch(results, { bodies: '', markSeen: true });

                    fetch.on('message', (msg, seqno) => {
                        msg.on('body', async (stream, info) => {
                            const parsed = await simpleParser(stream);
                            await this.forwardEmail(parsed);
                        });
                    });

                    fetch.once('end', () => {
                        console.log('✅ Finished processing replies');
                        this.scheduleNextCheck();
                    });
                });
            });
        } catch (error) {
            console.error('Error checking replies:', error);
            this.scheduleNextCheck();
        }
    }

    // Forward email to the correct user
    async forwardEmail(parsedEmail) {
        try {
            // Extract user info from To: header
            const toHeader = parsedEmail.to.text || parsedEmail.to.value[0]?.address || '';
            const userInfo = this.extractUserInfo(toHeader);

            if (!userInfo) {
                console.log('⚠️ Could not extract user info from:', toHeader);
                return;
            }

            // Parse DOB from YYYYMMDD format to YYYY-MM-DD
            const dobFormatted = `${userInfo.dob.slice(0,4)}-${userInfo.dob.slice(4,6)}-${userInfo.dob.slice(6,8)}`;

            // Get user from database by matching email username and DOB
            const user = await dbConfig.get(
                `SELECT * FROM users WHERE email LIKE ? AND date_of_birth = ?`, 
                [`%${userInfo.emailUsername}%`, dobFormatted]
            );

            if (!user || !user.email) {
                console.log(`⚠️ User ${userId} not found or no email configured`);
                return;
            }

            console.log(`📧 Forwarding reply to user ${userId} (${user.email})`);

            // Create transporter for forwarding
            const transporter = nodemailer.createTransport({
                host: process.env.SMTP_HOST || 'smtp.zoho.com',
                port: parseInt(process.env.SMTP_PORT || '465'),
                secure: true,
                auth: {
                    user: process.env.SMTP_USER,
                    pass: process.env.SMTP_PASS
                }
            });

            // Forward the email
            const mailOptions = {
                from: `${process.env.SMTP_USER}`,
                to: user.email,
                subject: `FWD: ${parsedEmail.subject}`,
                text: `
=== Forwarded Message ===
From: ${parsedEmail.from.text}
Date: ${parsedEmail.date}
Subject: ${parsedEmail.subject}

${parsedEmail.text}
                `,
                html: `
                    <div style="border-left: 4px solid #3498db; padding-left: 15px; margin: 20px 0;">
                        <p style="color: #666; margin: 5px 0;"><strong>From:</strong> ${parsedEmail.from.text}</p>
                        <p style="color: #666; margin: 5px 0;"><strong>Date:</strong> ${parsedEmail.date}</p>
                        <p style="color: #666; margin: 5px 0;"><strong>Subject:</strong> ${parsedEmail.subject}</p>
                    </div>
                    <hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0;">
                    ${parsedEmail.html || parsedEmail.textAsHtml || parsedEmail.text}
                `,
                replyTo: parsedEmail.from.text
            };

            await transporter.sendMail(mailOptions);
            console.log(`✅ Reply forwarded to ${user.email}`);

            // Log to database
            await dbConfig.run(
                'INSERT INTO email_forwards (user_id, from_email, subject, forwarded_at) VALUES (?, ?, ?, ?)',
                [userId, parsedEmail.from.text, parsedEmail.subject, new Date().toISOString()]
            );

        } catch (error) {
            console.error('Error forwarding email:', error);
        }
    }

    // Schedule next check
    scheduleNextCheck() {
        setTimeout(() => {
            this.checkForReplies();
        }, this.checkInterval);
    }

    // Start the service
    start() {
        console.log('🚀 Starting email forwarding service...');
        this.connect();
    }

    // Stop the service
    stop() {
        console.log('🛑 Stopping email forwarding service...');
        this.isRunning = false;
        if (this.imap) {
            this.imap.end();
        }
    }
}

module.exports = EmailForwardingService;
