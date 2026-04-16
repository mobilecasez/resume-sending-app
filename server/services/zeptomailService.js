const { SendMailClient } = require('zeptomail');

/**
 * Send email using Zoho ZeptoMail API
 * Replaces SMTP with API-based sending (no port blocking issues)
 */
async function sendEmailViaZeptoMail(options) {
    const {
        fromEmail,
        fromName,
        toEmail,
        replyTo,
        subject,
        textBody,
        htmlBody,
        attachments = []
    } = options;

    // Validate API token
    if (!process.env.ZEPTOMAIL_TOKEN) {
        throw new Error('ZEPTOMAIL_TOKEN not configured');
    }

    const url = 'api.zeptomail.in/';
    const token = process.env.ZEPTOMAIL_TOKEN;

    let client = new SendMailClient({ url, token });

    // Prepare attachments in ZeptoMail format
    const zeptoAttachments = attachments.map(att => ({
        content: att.content, // Base64 encoded file content
        mime_type: att.contentType || 'application/pdf',
        name: att.filename
    }));

    const emailData = {
        from: {
            address: fromEmail,
            name: fromName
        },
        to: [
            {
                email_address: {
                    address: toEmail,
                    name: toEmail.split('@')[0]
                }
            }
        ],
        subject: subject,
        htmlbody: htmlBody || undefined,
        textbody: textBody,
        reply_to: [
            {
                address: replyTo || fromEmail,
                name: fromName
            }
        ]
    };

    // Add attachments if present
    if (zeptoAttachments.length > 0) {
        emailData.attachments = zeptoAttachments;
    }

    try {
        console.log('📧 Sending email via ZeptoMail API...');
        console.log('   From:', fromEmail);
        console.log('   To:', toEmail);
        console.log('   Subject:', subject);
        
        const response = await client.sendMail(emailData);
        
        console.log('✅ Email sent successfully via ZeptoMail');
        console.log('   Message ID:', response.data?.[0]?.message_id);
        
        return {
            success: true,
            messageId: response.data?.[0]?.message_id,
            method: 'zeptomail'
        };
    } catch (error) {
        console.error('❌ ZeptoMail error:', error.message);
        console.error('   Error details:', error.error?.details);
        throw new Error(`ZeptoMail API error: ${error.message}`);
    }
}

module.exports = {
    sendEmailViaZeptoMail
};
