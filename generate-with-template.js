require('dotenv').config();
const fs = require('fs').promises;
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { exec } = require('child_process');

const CONFIG = {
  companyName: process.env.COMPANY_NAME || 'Google',
  position: process.env.POSITION || 'Senior Software Engineer', 
  recipientName: process.env.RECIPIENT_NAME || 'Hiring Manager',
  country: process.env.COUNTRY || 'United States (US)',
  relevantSkills: process.env.RELEVANT_SKILLS || 'JavaScript, React, Node.js',
  companyParagraph: process.env.COMPANY_PARAGRAPH || null,
};

const currentDate = new Date().toLocaleDateString('en-US', {
  month: 'short', day: '2-digit', year: 'numeric'
});

function wrapText(text, maxWidth, fontSize = 10) {
  const avgCharWidth = fontSize * 0.5;
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

async function generate() {
  try {
    console.log('\n=== Generating Custom Cover Letter ===\n');
    
    const templateBytes = await fs.readFile('Cover_Letter_Rishi_Samadhiya.pdf');
    const templateDoc = await PDFDocument.load(templateBytes);
    const pdfDoc = await PDFDocument.create();
    const [templatePage] = await pdfDoc.copyPages(templateDoc, [0]);
    pdfDoc.addPage(templatePage);
    
    const page = pdfDoc.getPages()[0];
    const { width, height } = page.getSize();
    
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    
    // Cover and replace company name
    page.drawRectangle({ x: 40, y: height - 100, width: 250, height: 25, color: rgb(1, 1, 1) });
    page.drawText(CONFIG.companyName.toUpperCase(), { x: 40, y: height - 92, size: 14, font: boldFont, color: rgb(0, 0, 0) });
    
    // Cover and replace country
    page.drawRectangle({ x: 40, y: height - 122, width: 200, height: 15, color: rgb(1, 1, 1) });
    page.drawText(CONFIG.country, { x: 40, y: height - 119, size: 10, font: font, color: rgb(0.3, 0.3, 0.3) });
    
    // Cover and replace date
    page.drawRectangle({ x: 40, y: height - 215, width: 150, height: 15, color: rgb(1, 1, 1) });
    page.drawText(currentDate, { x: 40, y: height - 212, size: 10, font: font, color: rgb(0, 0, 0) });
    
    // Cover main content
    page.drawRectangle({ x: 40, y: height - 850, width: 515, height: 600, color: rgb(1, 1, 1) });
    
    let y = height - 255;
    const lh = 12;
    
    page.drawText(`Dear ${CONFIG.recipientName}`, { x: 40, y, size: 10, font: boldFont, color: rgb(0, 0, 0) });
    y -= lh * 2;
    
    const p1 = `I am writing to express my strong interest in the ${CONFIG.position} position at ${CONFIG.companyName}. With over 14 years of experience in software development and delivery leadership, I have a proven ability to lead high-performing teams, manage complex projects, and deliver exceptional results. My technical expertise in ${CONFIG.relevantSkills} aligns well with your technical requirements.`;
    wrapText(p1, 515, 10).forEach(line => { page.drawText(line, { x: 40, y, size: 10, font, color: rgb(0, 0, 0) }); y -= lh; });
    y -= lh * 0.5;
    
    const p2 = `My approach is rooted in Agile methodologies and a commitment to coaching and mentoring developers. I am skilled at balancing architectural vision with business value, and I have a track record of actively promoting the reduction of technical debt. I have extensive experience with different technology stacks and leading cross-functional teams, ensuring seamless collaboration and project success.`;
    wrapText(p2, 515, 10).forEach(line => { page.drawText(line, { x: 40, y, size: 10, font, color: rgb(0, 0, 0) }); y -= lh; });
    y -= lh * 0.5;
    
    page.drawText(`Why ${CONFIG.companyName.toUpperCase()}?`, { x: 40, y, size: 11, font: boldFont, color: rgb(0, 0, 0) });
    y -= lh * 1.5;
    
    const p3 = CONFIG.companyParagraph || `I am particularly impressed by ${CONFIG.companyName}'s innovative approach and commitment to excellence. My experience in managing web, mobile, and enterprise platforms directly aligns with your technology-driven operations. I am eager to apply my skills to a company that prioritizes innovation and uses technology to enhance every aspect of the business.`;
    wrapText(p3, 515, 10).forEach(line => { page.drawText(line, { x: 40, y, size: 10, font, color: rgb(0, 0, 0) }); y -= lh; });
    y -= lh * 0.5;
    
    const p4 = `I am a results-oriented leader seeking an impactful role within an innovative organization. Thank you for your consideration, and I look forward to discussing how my experience can contribute to ${CONFIG.companyName}'s continued success.`;
    wrapText(p4, 515, 10).forEach(line => { page.drawText(line, { x: 40, y, size: 10, font, color: rgb(0, 0, 0) }); y -= lh; });
    y -= lh * 1.5;
    
    page.drawText('Regards,', { x: 40, y, size: 10, font, color: rgb(0, 0, 0) });
    y -= lh * 1.5;
    page.drawText('Rishi Samadhiya', { x: 40, y, size: 11, font: boldFont, color: rgb(0, 0, 0) });
    
    const pdfBytes = await pdfDoc.save();
    const output = `Cover_Letter_${CONFIG.companyName.replace(/\s+/g, '_')}_Custom.pdf`;
    await fs.writeFile(output, pdfBytes);
    
    console.log(`✅ Generated: ${output}\n`);
    exec(`open "${output}"`);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

generate();
