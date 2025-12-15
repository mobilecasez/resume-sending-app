require('dotenv').config();
const { PDFDocument, rgb, StandardFonts, PDFFont } = require('pdf-lib');
const fs = require('fs').promises;

// Configuration
const CONFIG = {
  companyName: process.env.COMPANY_NAME || 'Google',
  position: process.env.POSITION || 'Senior Software Engineer',
  recipientName: process.env.RECIPIENT_NAME || 'Hiring Manager',
  country: process.env.COUNTRY || 'United States (US)',
  relevantSkills: process.env.RELEVANT_SKILLS || 'JavaScript, TypeScript, React, Node.js, Python, distributed systems, and cloud technologies',
  companyParagraph: process.env.COMPANY_PARAGRAPH || null,
  location: process.env.LOCATION || 'San Francisco, CA',
};

const currentDate = new Date().toLocaleDateString('en-US', {
  month: 'short',
  day: '2-digit',
  year: 'numeric'
});

// Helper to wrap text
function wrapText(text, maxWidth, fontSize = 10) {
  const avgCharWidth = fontSize * 0.52;
  const maxCharsPerLine = Math.floor(maxWidth / avgCharWidth);
  const words = text.split(' ');
  const lines = [];
  let currentLine = '';
  
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

async function createCoverLetter() {
  try {
    console.log('\n╔═══════════════════════════════════════════════════════╗');
    console.log('║        Recreating Cover Letter Design                ║');
    console.log('╚═══════════════════════════════════════════════════════╝\n');
    console.log(`🏢 Company: ${CONFIG.companyName}`);
    console.log(`💼 Position: ${CONFIG.position}`);
    console.log(`📅 Date: ${currentDate}\n`);
    
    // Create new PDF with custom dimensions (matching template: 595x1067)
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595, 1067]);
    const { width, height } = page.getSize();
    
    // Embed fonts
    const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    
    // ========== LEFT SIDEBAR (Dark background) ==========
    const sidebarWidth = 180;
    const sidebarColor = rgb(0.15, 0.15, 0.2); // Dark blue-gray
    
    page.drawRectangle({
      x: 0,
      y: 0,
      width: sidebarWidth,
      height: height,
      color: sidebarColor,
    });
    
    // Photo placeholder in sidebar (top)
    const photoSize = 100;
    const photoX = sidebarWidth / 2; // Center X position
    const photoY = height - 120;
    
    // Draw circle for photo placeholder (centered)
    page.drawCircle({
      x: photoX,
      y: photoY + photoSize / 2,
      size: photoSize / 2,
      borderColor: rgb(1, 1, 1),
      borderWidth: 2,
      color: rgb(0.25, 0.25, 0.3),
    });
    
    // Add text in circle (initials) - centered
    const initialsText = 'RS';
    const initialsWidth = 28; // Approximate width for 'RS' at size 24
    page.drawText(initialsText, {
      x: photoX - initialsWidth / 2,
      y: photoY + 42,
      size: 24,
      font: helveticaBold,
      color: rgb(1, 1, 1),
    });
    
    // Sidebar content
    let sidebarY = photoY - 40;
    
    // TO section
    page.drawText('TO', {
      x: 30,
      y: sidebarY,
      size: 9,
      font: helveticaBold,
      color: rgb(0.6, 0.6, 0.6),
    });
    sidebarY -= 20;
    
    page.drawText(CONFIG.recipientName, {
      x: 30,
      y: sidebarY,
      size: 10,
      font: helveticaBold,
      color: rgb(1, 1, 1),
    });
    sidebarY -= 15;
    
    const companyLines = wrapText(CONFIG.companyName, 120, 10);
    companyLines.forEach(line => {
      page.drawText(line, {
        x: 30,
        y: sidebarY,
        size: 10,
        font: helveticaBold,
        color: rgb(1, 1, 1),
      });
      sidebarY -= 12;
    });
    
    page.drawText(CONFIG.country, {
      x: 30,
      y: sidebarY,
      size: 9,
      font: helvetica,
      color: rgb(0.7, 0.7, 0.7),
    });
    sidebarY -= 40;
    
    // FROM section
    page.drawText('FROM', {
      x: 30,
      y: sidebarY,
      size: 9,
      font: helveticaBold,
      color: rgb(0.6, 0.6, 0.6),
    });
    sidebarY -= 20;
    
    page.drawText('RISHI SAMADHIYA', {
      x: 30,
      y: sidebarY,
      size: 10,
      font: helveticaBold,
      color: rgb(1, 1, 1),
    });
    sidebarY -= 15;
    
    page.drawText('Project Manager', {
      x: 30,
      y: sidebarY,
      size: 9,
      font: helvetica,
      color: rgb(0.7, 0.7, 0.7),
    });
    sidebarY -= 40;
    
    // DATE section
    page.drawText('DATE', {
      x: 30,
      y: sidebarY,
      size: 9,
      font: helveticaBold,
      color: rgb(0.6, 0.6, 0.6),
    });
    sidebarY -= 20;
    
    page.drawText(currentDate, {
      x: 30,
      y: sidebarY,
      size: 10,
      font: helvetica,
      color: rgb(1, 1, 1),
    });
    
    // Bottom contact info in sidebar
    const bottomY = 120;
    page.drawText('RISHI SAMADHIYA', {
      x: 30,
      y: bottomY + 60,
      size: 10,
      font: helveticaBold,
      color: rgb(1, 1, 1),
    });
    
    page.drawText('PROJECT MANAGER', {
      x: 30,
      y: bottomY + 45,
      size: 8,
      font: helvetica,
      color: rgb(0.6, 0.6, 0.6),
    });
    
    const contactLines = [
      'Gurgaon, Haryana,',
      'India, 122001',
      '+91 9970020596',
      'samrishi24@gmail.com'
    ];
    
    let contactY = bottomY + 20;
    contactLines.forEach(line => {
      page.drawText(line, {
        x: 30,
        y: contactY,
        size: 7,
        font: helvetica,
        color: rgb(0.7, 0.7, 0.7),
      });
      contactY -= 10;
    });
    
    // ========== MAIN CONTENT AREA ==========
    const contentX = sidebarWidth + 40;
    const contentWidth = width - sidebarWidth - 80;
    let contentY = height - 60;
    
    // TOP HEADER: Name/Designation (LEFT) and Contact Details (RIGHT)
    const headerY = contentY;
    
    // LEFT: Name and Designation
    page.drawText('RISHI SAMADHIYA', {
      x: contentX,
      y: headerY,
      size: 16,
      font: helveticaBold,
      color: rgb(0, 0, 0),
    });
    
    page.drawText('PROJECT MANAGER', {
      x: contentX,
      y: headerY - 16,
      size: 10,
      font: helvetica,
      color: rgb(0.4, 0.4, 0.4),
    });
    
    // RIGHT: Contact details (right-aligned)
    const rightAlignX = width - 40;
    const headerContactY = headerY;
    const contactFontSize = 9;
    
    // Email with label
    const emailText = 'samrishi24@gmail.com';
    const emailWidth = helvetica.widthOfTextAtSize(emailText, contactFontSize);
    page.drawText(emailText, {
      x: rightAlignX - emailWidth,
      y: headerContactY,
      size: contactFontSize,
      font: helvetica,
      color: rgb(0.3, 0.3, 0.3),
    });
    
    // Phone with label
    const phoneText = '+91 9970020596';
    const phoneWidth = helvetica.widthOfTextAtSize(phoneText, contactFontSize);
    page.drawText(phoneText, {
      x: rightAlignX - phoneWidth,
      y: headerContactY - 12,
      size: contactFontSize,
      font: helvetica,
      color: rgb(0.3, 0.3, 0.3),
    });
    
    // Location
    const locationText = 'Gurgaon, Haryana, India';
    const locationWidth = helvetica.widthOfTextAtSize(locationText, contactFontSize);
    page.drawText(locationText, {
      x: rightAlignX - locationWidth,
      y: headerContactY - 24,
      size: contactFontSize,
      font: helvetica,
      color: rgb(0.3, 0.3, 0.3),
    });
    
    // Add a horizontal line separator
    page.drawLine({
      start: { x: contentX, y: headerY - 45 },
      end: { x: width - 40, y: headerY - 45 },
      thickness: 1,
      color: rgb(0.8, 0.8, 0.8),
    });
    
    // Reset contentY for main content
    contentY = headerY - 70;
    
    // Main heading
    page.drawText('COVER LETTER', {
      x: contentX,
      y: contentY,
      size: 20,
      font: helveticaBold,
      color: rgb(0, 0, 0),
    });
    contentY -= 40;
    
    // Salutation
    page.drawText(`Dear ${CONFIG.recipientName}`, {
      x: contentX,
      y: contentY,
      size: 11,
      font: helveticaBold,
      color: rgb(0, 0, 0),
    });
    contentY -= 25;
    
    // Paragraph 1: Opening
    const para1 = `I am writing to express my strong interest in the ${CONFIG.position} position at ${CONFIG.companyName}. With over 14 years of experience in software development and delivery leadership, I have a proven ability to lead high-performing teams, manage complex projects, and deliver exceptional results. My background in C# development, along with hands-on experience in .NET Core, ASP.NET, and SQL Server, aligns well with your technical requirements.`;
    
    const para1Lines = wrapText(para1, contentWidth, 10);
    para1Lines.forEach(line => {
      page.drawText(line, {
        x: contentX,
        y: contentY,
        size: 10,
        font: helvetica,
        color: rgb(0, 0, 0),
      });
      contentY -= 13;
    });
    contentY -= 8;
    
    // Paragraph 2: Leadership/Skills
    const para2 = `My leadership approach is rooted in Agile methodologies and a commitment to coaching and mentoring developers. I am skilled at balancing architectural vision with business value, and I have a track record of actively promoting the reduction of technical debt. I have extensive experience with different data stores and leading cross-national teams, ensuring seamless collaboration and project success.`;
    
    const para2Lines = wrapText(para2, contentWidth, 10);
    para2Lines.forEach(line => {
      page.drawText(line, {
        x: contentX,
        y: contentY,
        size: 10,
        font: helvetica,
        color: rgb(0, 0, 0),
      });
      contentY -= 13;
    });
    contentY -= 15;
    
    // "Why COMPANY?" section (highlighted)
    page.drawText(`Why ${CONFIG.companyName.toUpperCase()}?`, {
      x: contentX,
      y: contentY,
      size: 12,
      font: helveticaBold,
      color: rgb(0, 0, 0),
    });
    contentY -= 20;
    
    const whyCompanyText = CONFIG.companyParagraph || 
      `I am particularly impressed by your unique omnichannel approach and your commitment to building a comprehensive digital and physical infrastructure to deliver a "smile." My experience in managing web, mobile, and e-commerce platforms, including my hands-on work with digital marketing through Google and Meta, directly aligns with your technology-driven operations. I am eager to apply my skills to a company that prioritizes innovation and uses technology to enhance every step of the customer journey, from online ordering to in-person service and delivery.`;
    
    const para3Lines = wrapText(whyCompanyText, contentWidth, 10);
    para3Lines.forEach(line => {
      page.drawText(line, {
        x: contentX,
        y: contentY,
        size: 10,
        font: helvetica,
        color: rgb(0, 0, 0),
      });
      contentY -= 13;
    });
    contentY -= 8;
    
    // Paragraph 4: Closing
    const para4 = `I am a results-oriented leader seeking an impactful role within an innovative organization. Thank you for your consideration, and I look forward to discussing how my experience can contribute to ${CONFIG.companyName}'s continued success.`;
    
    const para4Lines = wrapText(para4, contentWidth, 10);
    para4Lines.forEach(line => {
      page.drawText(line, {
        x: contentX,
        y: contentY,
        size: 10,
        font: helvetica,
        color: rgb(0, 0, 0),
      });
      contentY -= 13;
    });
    contentY -= 20;
    
    // Optional: Interest section (if relevant)
    if (CONFIG.country !== 'United States (US)') {
      page.drawText(`Interest in ${CONFIG.country.split('(')[0].trim()}`, {
        x: contentX,
        y: contentY,
        size: 11,
        font: helveticaBold,
        color: rgb(0, 0, 0),
      });
      contentY -= 18;
      
      const interestText = `My interest in relocating is further fueled by personal connections and recent visits to the region, which have reinforced my enthusiasm for contributing to your organization.`;
      
      const interestLines = wrapText(interestText, contentWidth, 10);
      interestLines.forEach(line => {
        page.drawText(line, {
          x: contentX,
          y: contentY,
          size: 10,
          font: helvetica,
          color: rgb(0, 0, 0),
        });
        contentY -= 13;
      });
      contentY -= 8;
    }
    
    // Final closing
    const finalText = `I would be honored to contribute to your team and am happy to discuss how my experience aligns with your goals. Thank you for your time and consideration—I look forward to the possibility of collaborating.`;
    
    const finalLines = wrapText(finalText, contentWidth, 10);
    finalLines.forEach(line => {
      page.drawText(line, {
        x: contentX,
        y: contentY,
        size: 10,
        font: helvetica,
        color: rgb(0, 0, 0),
      });
      contentY -= 13;
    });
    contentY -= 20;
    
    // Signature
    page.drawText('Regards,', {
      x: contentX,
      y: contentY,
      size: 10,
      font: helvetica,
      color: rgb(0, 0, 0),
    });
    contentY -= 40; // Space for handwritten signature
    
    // Add a line for signature
    page.drawLine({
      start: { x: contentX, y: contentY + 5 },
      end: { x: contentX + 150, y: contentY + 5 },
      thickness: 0.5,
      color: rgb(0.5, 0.5, 0.5),
    });
    
    contentY -= 10;
    
    // Name below signature line
    page.drawText('Rishi Samadhiya', {
      x: contentX,
      y: contentY,
      size: 11,
      font: helveticaBold,
      color: rgb(0, 0, 0),
    });
    
    // Save PDF
    const pdfBytes = await pdfDoc.save();
    const outputPath = `Cover_Letter_${CONFIG.companyName.replace(/\s+/g, '_')}_New.pdf`;
    await fs.writeFile(outputPath, pdfBytes);
    
    console.log('\n✅ Cover letter created successfully!');
    console.log(`📄 File: ${outputPath}\n`);
    
    // Open the PDF
    require('child_process').exec(`open "${outputPath}"`);
    
    return outputPath;
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error(error.stack);
  }
}

if (require.main === module) {
  createCoverLetter();
}

module.exports = { createCoverLetter };
