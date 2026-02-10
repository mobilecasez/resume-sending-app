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
        const imapUser = process.env.IMAP_USER || process.env.SMTP_USER;
        const imapPass = process.env.IMAP_PASS || process.env.SMTP_PASS;
        
        if (!imapUser || !imapPass) {
            console.log('⚠️ Email forwarding disabled: IMAP credentials not configured');
            return;
        }

        console.log(`🔐 Connecting to IMAP as: ${imapUser}`);
        
        this.imap = new Imap({
            user: imapUser,
            password: imapPass,
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

                console.log(`📥 Checking inbox (${box.messages.total} total, ${box.messages.new} new)`);

                // Search for unseen emails with + in To: field (matches cv+anything@domain.com)
                this.imap.search(['UNSEEN', ['HEADER', 'TO', 'cv+']], async (err, results) => {
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
            // Try multiple headers to find the plus address
            let toAddress = '';
            
            // Helper to extract string from header value
            const getHeaderString = (headerValue) => {
                if (!headerValue) return '';
                if (typeof headerValue === 'string') return headerValue;
                if (headerValue.value) return headerValue.value;
                if (headerValue.text) return headerValue.text;
                return String(headerValue);
            };
            
            // Check envelope first (most reliable)
            const deliveredTo = getHeaderString(parsedEmail.headers.get('delivered-to'));
            const originalTo = getHeaderString(parsedEmail.headers.get('x-original-to'));
            const toText = parsedEmail.to?.text || parsedEmail.to?.value?.[0]?.address || '';
            
            if (deliveredTo && deliveredTo.includes('+')) {
                toAddress = deliveredTo;
            } else if (originalTo && originalTo.includes('+')) {
                toAddress = originalTo;
            } else if (toText && toText.includes('+')) {
                toAddress = toText;
            }
            
            console.log(`📧 Processing reply - To: ${toText}`);
            console.log(`📧 Delivered-To: ${deliveredTo || 'none'}`);
            console.log(`📧 X-Original-To: ${originalTo || 'none'}`);
            console.log(`📧 Using address: ${toAddress}`);
            
            const userInfo = this.extractUserInfo(toAddress);

            if (!userInfo) {
                console.log('⚠️ Could not extract user info from:', toAddress);
                return;
            }

            console.log(`👤 Extracted user info: ${userInfo.emailUsername}, DOB: ${userInfo.dob}`);

            // Parse DOB from YYYYMMDD format to YYYY-MM-DD
            const dobFormatted = `${userInfo.dob.slice(0,4)}-${userInfo.dob.slice(4,6)}-${userInfo.dob.slice(6,8)}`;

            // Get user from database by matching email username and DOB
            const user = await dbConfig.get(
                `SELECT * FROM users WHERE email LIKE ? AND date_of_birth = ?`, 
                [`%${userInfo.emailUsername}%`, dobFormatted]
            );

            if (!user || !user.email) {
                console.log(`⚠️ User not found for email:${userInfo.emailUsername}, DOB:${dobFormatted}`);
                return;
            }

            console.log(`📧 Forwarding reply to user ${user.id} (${user.email})`);

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

            // Extract employer email and name
            const employerEmail = parsedEmail.from.value?.[0]?.address || parsedEmail.from.text;
            const employerName = parsedEmail.from.value?.[0]?.name || parsedEmail.from.text;

            // Prepare mailto link with pre-filled subject and body
            const originalSubject = parsedEmail.subject || '';
            const replySubject = originalSubject.startsWith('Re:') ? originalSubject : `Re: ${originalSubject}`;
            
            // Clean up the email text - remove quote markers and extra formatting
            let cleanText = parsedEmail.text || '';
            // Remove > quote markers from forwarded emails
            cleanText = cleanText.split('\n').map(line => line.replace(/^>\s*/g, '')).join('\n');
            // Remove excessive newlines
            cleanText = cleanText.replace(/\n{3,}/g, '\n\n');
            // Convert all \n to \r\n for mobile compatibility
            cleanText = cleanText.replace(/\n/g, '\r\n');
            
            // Build conversation body for reply - professionally formatted plain text
            // Use \r\n for better mobile compatibility
            const conversationBody = [
                '',
                '',
                '',
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                'Original Conversation',
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                '',
                `From: ${employerName}`,
                `Date: ${new Date(parsedEmail.date).toLocaleString('en-US', { 
                    weekday: 'short', 
                    year: 'numeric', 
                    month: 'short', 
                    day: 'numeric', 
                    hour: '2-digit', 
                    minute: '2-digit' 
                })}`,
                `Subject: ${originalSubject}`,
                '',
                cleanText.trim(),
                '',
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                ''
            ].join('\r\n');

            // URL encode the mailto parameters
            const mailtoLink = `mailto:${employerEmail}?subject=${encodeURIComponent(replySubject)}&body=${encodeURIComponent(conversationBody)}`;

            // Send notification email (not forwarded - breaks the chain)
            const mailOptions = {
                from: `CVApplyr <${process.env.SMTP_USER}>`,
                to: user.email,
                subject: `📬 Reply from ${employerName}`,
                text: `
Hi,

You received a reply to your job application!

From: ${employerName} <${employerEmail}>
Date: ${parsedEmail.date}
Subject: ${parsedEmail.subject}

Their Message:
${parsedEmail.text}

---
NEXT STEPS:
In order to continue the conversation with the employer, please message them directly at ${employerEmail} from your registered email address (${user.email}).

Important: Do not reply to this notification email as it will not reach the employer.

Good luck!
CVApplyr Team
                `,
                html: `<div style="max-width:600px;margin:0 auto;padding:20px;font-family:Arial,sans-serif;"><h2 style="color:#2c3e50;margin:0 0 15px;">📬 Job Application Reply!</h2><div style="background:#f8f9fa;border-left:4px solid #28a745;padding:12px;margin:10px 0;border-radius:4px;"><p style="margin:4px 0;"><strong>From:</strong> ${employerName}</p><p style="margin:4px 0;"><strong>Email:</strong> ${employerEmail}</p><p style="margin:4px 0;"><strong>Subject:</strong> ${parsedEmail.subject}</p></div><div style="border:1px solid #ddd;padding:12px;border-radius:4px;margin:10px 0;"><strong>Message:</strong><div style="margin-top:8px;">${parsedEmail.html || parsedEmail.text || ''}</div></div><div style="background:#e7f3ff;border:2px solid #2196F3;padding:12px;border-radius:4px;margin:10px 0;text-align:center;"><strong style="color:#1976D2;">Next Steps</strong><p style="margin:8px 0;">Reply from: <strong>${user.email}</strong></p><p style="margin:10px 0;"><a href="${mailtoLink}" style="background:#2196F3;color:#fff;padding:10px 20px;text-decoration:none;border-radius:4px;display:inline-block;font-weight:bold;">✉️ Email ${employerName}</a></p></div><p style="color:#999;font-size:11px;margin:15px 0;text-align:center;">CVApplyr 🍀</p></div>`
            };

            await transporter.sendMail(mailOptions);
            console.log(`✅ Reply forwarded to ${user.email}`);

            // Log to database
            await dbConfig.run(
                'INSERT INTO email_forwards (user_id, from_email, subject, forwarded_at) VALUES (?, ?, ?, ?)',
                [user.id, parsedEmail.from.text, parsedEmail.subject, new Date().toISOString()]
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
