require('dotenv').config();
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const nodemailer = require('nodemailer');
const fs = require('fs').promises;
const path = require('path');
const pdfParse = require('pdf-parse');

// --- CONFIGURATION ---
const RESUME_PATH = process.env.RESUME_PATH || 'your_resume.pdf';
const COVER_LETTER_TEMPLATE_PATH = process.env.COVER_LETTER_PATH || 'Cover_Letter_Rishi_Samadhiya.pdf';

// Email configuration
const SMTP_CONFIG = {
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === 'true' || false,
  auth: {
    user: process.env.SMTP_USER || 'your_email@gmail.com',
    pass: process.env.SMTP_PASS || 'your_app_password',
  },
};

// Application-specific details (customize for each company)
const APPLICATION_DETAILS = {
  companyName: process.env.COMPANY_NAME || 'ABC Corporation',
  position: process.env.POSITION || 'Software Engineer',
  recipientName: process.env.RECIPIENT_NAME || 'Hiring Manager',
  recipientEmail: process.env.RECIPIENT_EMAIL || 'employer@example.com',
  
  // Custom paragraph about why you're interested in this specific company
  companySpecificParagraph: process.env.COMPANY_PARAGRAPH || 
    'I am particularly excited about this opportunity because of your company\'s innovative approach to technology and commitment to excellence.',
  
  // Skills/requirements to highlight for this specific job
  relevantSkills: process.env.RELEVANT_SKILLS || 
    'JavaScript, React, Node.js, and cloud technologies',
};

const EMAIL_SUBJECT = process.env.EMAIL_SUBJECT || 
  `Application for ${APPLICATION_DETAILS.position} - Rishi Samadhiya`;

// ---------------------

/**
 * Analyzes the template cover letter to understand its structure
 */
async function analyzeCoverLetterTemplate(templatePath) {
  try {
    const dataBuffer = await fs.readFile(templatePath);
    const pdfData = await pdfParse(dataBuffer);
    
    console.log('📄 Template Analysis:');
    console.log(`  Pages: ${pdfData.numpages}`);
    console.log(`  Text length: ${pdfData.text.length} characters`);
    
    return {
      text: pdfData.text,
      numPages: pdfData.numpages,
      metadata: pdfData.info,
    };
  } catch (error) {
    console.error('Error analyzing template:', error);
    throw error;
  }
}

/**
 * Creates a new cover letter PDF with customized content while preserving formatting
 */
async function createCustomCoverLetter(templatePath, applicationDetails) {
  try {
    // Load the original template to get dimensions and styling
    const templateBytes = await fs.readFile(templatePath);
    const templateDoc = await PDFDocument.load(templateBytes);
    const templatePages = templateDoc.getPages();
    const firstTemplatePage = templatePages[0];
    const { width, height } = firstTemplatePage.getSize();
    
    console.log('🎨 Creating new cover letter...');
    console.log(`  Page size: ${width}x${height}`);
    
    // Create a new PDF document
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([width, height]);
    
    // Embed fonts
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const regularFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
    
    // Define layout constants (adjust these to match your template)
    const margin = 60;
    const lineHeight = 15;
    let yPosition = height - margin;
    
    // Header - Your contact information
    const headerSize = 11;
    const nameSize = 14;
    
    // Name
    page.drawText('Rishi Samadhiya', {
      x: margin,
      y: yPosition,
      size: nameSize,
      font: boldFont,
      color: rgb(0, 0, 0),
    });
    yPosition -= lineHeight * 1.5;
    
    // Contact info (update with your actual details)
    const contactInfo = [
      'Email: rishi.samadhiya@example.com | Phone: (123) 456-7890',
      'LinkedIn: linkedin.com/in/rishisamadhiya | Portfolio: rishisamadhiya.com',
    ];
    
    contactInfo.forEach(line => {
      page.drawText(line, {
        x: margin,
        y: yPosition,
        size: 9,
        font: regularFont,
        color: rgb(0.2, 0.2, 0.2),
      });
      yPosition -= lineHeight;
    });
    
    yPosition -= lineHeight; // Extra space after header
    
    // Date
    const currentDate = new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
    
    page.drawText(currentDate, {
      x: margin,
      y: yPosition,
      size: headerSize,
      font: regularFont,
      color: rgb(0, 0, 0),
    });
    yPosition -= lineHeight * 2;
    
    // Recipient information
    page.drawText(applicationDetails.recipientName, {
      x: margin,
      y: yPosition,
      size: headerSize,
      font: regularFont,
      color: rgb(0, 0, 0),
    });
    yPosition -= lineHeight;
    
    page.drawText(applicationDetails.companyName, {
      x: margin,
      y: yPosition,
      size: headerSize,
      font: regularFont,
      color: rgb(0, 0, 0),
    });
    yPosition -= lineHeight * 2;
    
    // Salutation
    page.drawText(`Dear ${applicationDetails.recipientName},`, {
      x: margin,
      y: yPosition,
      size: headerSize,
      font: regularFont,
      color: rgb(0, 0, 0),
    });
    yPosition -= lineHeight * 1.5;
    
    // Body paragraphs - Customize these for each application
    const paragraphs = [
      // Opening paragraph
      `I am writing to express my strong interest in the ${applicationDetails.position} position at ${applicationDetails.companyName}. With my background in software development and passion for creating innovative solutions, I am confident that I would be a valuable addition to your team.`,
      
      // Company-specific paragraph (why this company)
      applicationDetails.companySpecificParagraph,
      
      // Skills and experience paragraph
      `My technical expertise includes ${applicationDetails.relevantSkills}, which align perfectly with the requirements for this role. Throughout my career, I have demonstrated the ability to quickly learn new technologies, collaborate effectively with cross-functional teams, and deliver high-quality solutions that meet business objectives.`,
      
      // Closing paragraph
      `I am excited about the opportunity to contribute to ${applicationDetails.companyName}'s continued success and would welcome the chance to discuss how my skills and experience align with your team's needs. Thank you for considering my application. I look forward to hearing from you.`,
    ];
    
    // Draw each paragraph with word wrapping
    const maxWidth = width - (margin * 2);
    const fontSize = 11;
    
    paragraphs.forEach((paragraph, index) => {
      const lines = wrapText(paragraph, maxWidth, fontSize, regularFont);
      
      lines.forEach(line => {
        if (yPosition < margin + 50) { // If running out of space
          console.log('⚠️  Warning: Content may be too long for one page');
        }
        
        page.drawText(line, {
          x: margin,
          y: yPosition,
          size: fontSize,
          font: regularFont,
          color: rgb(0, 0, 0),
        });
        yPosition -= lineHeight;
      });
      
      yPosition -= lineHeight * 0.5; // Space between paragraphs
    });
    
    // Closing
    yPosition -= lineHeight;
    page.drawText('Sincerely,', {
      x: margin,
      y: yPosition,
      size: fontSize,
      font: regularFont,
      color: rgb(0, 0, 0),
    });
    yPosition -= lineHeight * 2;
    
    page.drawText('Rishi Samadhiya', {
      x: margin,
      y: yPosition,
      size: fontSize,
      font: regularFont,
      color: rgb(0, 0, 0),
    });
    
    // Save the PDF
    const pdfBytes = await pdfDoc.save();
    console.log('✓ Custom cover letter created successfully');
    
    return pdfBytes;
    
  } catch (error) {
    console.error('Error creating custom cover letter:', error);
    throw error;
  }
}

/**
 * Simple word wrapping function
 */
function wrapText(text, maxWidth, fontSize, font) {
  const words = text.split(' ');
  const lines = [];
  let currentLine = '';
  
  // Approximate character width (adjust based on font)
  const avgCharWidth = fontSize * 0.5;
  const maxCharsPerLine = Math.floor(maxWidth / avgCharWidth);
  
  words.forEach(word => {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    
    if (testLine.length <= maxCharsPerLine) {
      currentLine = testLine;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  });
  
  if (currentLine) lines.push(currentLine);
  
  return lines;
}

/**
 * Modifies a PDF document while preserving its original formatting
 * @param {Buffer} pdfBytes - The original PDF as a buffer
 * @returns {Promise<Uint8Array>} - The modified PDF bytes
 */
async function modifyPdfPreservingFormat(pdfBytes) {
  try {
    // Load the existing PDF
    const pdfDoc = await PDFDocument.load(pdfBytes);
    
    // Get all pages
    const pages = pdfDoc.getPages();
    const firstPage = pages[0];
    const { height, width } = firstPage.getSize();
    
    // Embed a standard font (won't disrupt existing formatting)
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    
    // Optional: Add date stamp in small text at bottom
    if (ADD_DATE_STAMP) {
      const currentDate = new Date().toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
      
      firstPage.drawText(`Submitted: ${currentDate}`, {
        x: 30,
        y: 20,
        size: 8,
        font: font,
        color: rgb(0.5, 0.5, 0.5), // Gray color
      });
    }
    
    // Optional: Add custom text if provided
    if (ADD_CUSTOM_TEXT && ADD_CUSTOM_TEXT.trim() !== '') {
      firstPage.drawText(ADD_CUSTOM_TEXT, {
        x: 30,
        y: height - 30,
        size: 10,
        font: font,
        color: rgb(0, 0, 0),
      });
    }
    
    // Save and return the modified PDF
    const modifiedPdfBytes = await pdfDoc.save();
    console.log('✓ PDF modified successfully while preserving formatting');
    
    return modifiedPdfBytes;
  } catch (error) {
    console.error('Error modifying PDF:', error);
    throw error;
  }
}

/**
 * Sends an email with resume and custom cover letter
 */
async function sendEmail(resumePath, coverLetterPath, applicationDetails) {
  try {
    const transporter = nodemailer.createTransport(SMTP_CONFIG);
    
    await transporter.verify();
    console.log('✓ SMTP connection verified');
    
    const mailOptions = {
      from: `"Rishi Samadhiya" <${SMTP_CONFIG.auth.user}>`,
      to: applicationDetails.recipientEmail,
      subject: EMAIL_SUBJECT,
      text: `Dear ${applicationDetails.recipientName},\n\nPlease find attached my resume and cover letter for the ${applicationDetails.position} position at ${applicationDetails.companyName}.\n\nBest regards,\nRishi Samadhiya`,
      html: `<p>Dear ${applicationDetails.recipientName},</p><p>Please find attached my resume and cover letter for the ${applicationDetails.position} position at ${applicationDetails.companyName}.</p><p>Best regards,<br>Rishi Samadhiya</p>`,
      attachments: [
        {
          filename: `Rishi_Samadhiya_Resume.pdf`,
          path: resumePath,
        },
        {
          filename: `Rishi_Samadhiya_Cover_Letter_${applicationDetails.companyName.replace(/\s+/g, '_')}.pdf`,
          path: coverLetterPath,
        },
      ],
    };
    
    const info = await transporter.sendMail(mailOptions);
    console.log('✓ Email sent successfully!');
    console.log('  Message ID:', info.messageId);
    console.log('  Recipient:', applicationDetails.recipientEmail);
    
    return info;
  } catch (error) {
    console.error('Error sending email:', error);
    throw error;
  }
}

/**
 * Main function
 */
async function main() {
  console.log('\n=== Custom Cover Letter Generator & Resume Sender ===\n');
  
  try {
    // 1. Analyze the template (optional - for understanding structure)
    console.log('📋 Analyzing template cover letter...');
    await analyzeCoverLetterTemplate(COVER_LETTER_TEMPLATE_PATH);
    
    // 2. Generate custom cover letter
    console.log(`\n🏢 Generating cover letter for ${APPLICATION_DETAILS.companyName}...`);
    console.log(`   Position: ${APPLICATION_DETAILS.position}`);
    
    const customCoverLetterBytes = await createCustomCoverLetter(
      COVER_LETTER_TEMPLATE_PATH,
      APPLICATION_DETAILS
    );
    
    // 3. Save custom cover letter
    const customCoverLetterPath = path.join(
      __dirname,
      `Cover_Letter_${APPLICATION_DETAILS.companyName.replace(/\s+/g, '_')}.pdf`
    );
    
    await fs.writeFile(customCoverLetterPath, customCoverLetterBytes);
    console.log(`✓ Custom cover letter saved: ${path.basename(customCoverLetterPath)}`);
    
    // 4. Verify resume exists
    const resumeExists = await fs.access(RESUME_PATH).then(() => true).catch(() => false);
    if (!resumeExists) {
      throw new Error(`Resume file not found at: ${RESUME_PATH}`);
    }
    console.log('✓ Resume file found');
    
    // 5. Send email
    console.log('\n📧 Sending application email...');
    await sendEmail(RESUME_PATH, customCoverLetterPath, APPLICATION_DETAILS);
    
    // 6. Option to keep or delete the generated cover letter
    if (process.env.KEEP_GENERATED_FILES !== 'true') {
      await fs.unlink(customCoverLetterPath);
      console.log('✓ Temporary cover letter file cleaned up');
    } else {
      console.log(`✓ Cover letter saved for your records: ${customCoverLetterPath}`);
    }
    
    console.log('\n✅ Application sent successfully!\n');
    
  } catch (error) {
    console.error('\n❌ An error occurred:', error.message);
    
    if (error.code === 'ENOENT') {
      console.error('\n💡 TIP: Make sure all file paths are correct.');
    } else if (error.code === 'EAUTH' || error.responseCode === 535) {
      console.error('\n💡 TIP: Check your email credentials. For Gmail, use an App Password.');
    }
    
    process.exit(1);
  }
}

// Run the application
if (require.main === module) {
  main();
}

module.exports = { createCustomCoverLetter, analyzeCoverLetterTemplate, sendEmail, main };
