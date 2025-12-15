require('dotenv').config();
const fs = require('fs').promises;
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

// Text replacements based on your template analysis
const REPLACEMENTS = {
  // TO section
  recipientName: process.env.RECIPIENT_NAME || 'Hiring Manager',
  companyName: process.env.COMPANY_NAME || 'Google',
  country: process.env.COUNTRY || 'United States',
  
  // DATE section
  date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' }),
  
  // Position
  position: process.env.POSITION || 'Senior Software Engineer',
  
  // Content paragraphs
  openingParagraph: process.env.OPENING_PARAGRAPH || 
    `I am writing to express my strong interest in the ${process.env.POSITION || 'Senior Software Engineer'} position at ${process.env.COMPANY_NAME || 'Google'}. With over 14 years of experience in software development and delivery leadership, I have a proven ability to lead high-performing teams, manage complex projects, and deliver exceptional results. My technical expertise in ${process.env.RELEVANT_SKILLS || 'modern web technologies'} aligns well with your technical requirements.`,
  
  leadershipParagraph: process.env.LEADERSHIP_PARAGRAPH ||
    `My approach is rooted in Agile methodologies and a commitment to coaching and mentoring developers. I am skilled at balancing architectural vision with business value, and I have a track record of actively promoting the reduction of technical debt. I have extensive experience with different technology stacks and leading cross-functional teams, ensuring seamless collaboration and project success.`,
  
  whyCompanyParagraph: process.env.COMPANY_PARAGRAPH ||
    `I am particularly impressed by ${process.env.COMPANY_NAME || 'Google'}'s innovative approach and commitment to excellence. My experience in managing web, mobile, and enterprise platforms directly aligns with your technology-driven operations. I am eager to apply my skills to a company that prioritizes innovation and uses technology to enhance every aspect of the business.`,
  
  closingParagraph: process.env.CLOSING_PARAGRAPH ||
    `I am a results-oriented leader seeking an impactful role within an innovative organization. Thank you for your consideration, and I look forward to discussing how my experience can contribute to ${process.env.COMPANY_NAME || 'Google'}'s continued success.`,
};

async function createCoverLetterWithTemplate() {
  try {
    console.log('\n=== Cover Letter Generator (Copying Template Style) ===\n');
    
    // Load template to copy the first page with all its styling
    const templateBytes = await fs.readFile('Cover_Letter_Rishi_Samadhiya.pdf');
    const templateDoc = await PDFDocument.load(templateBytes);
    
    // Create new document and copy the template page
    const newDoc = await PDFDocument.create();
    const [copiedPage] = await newDoc.copyPages(templateDoc, [0]);
    newDoc.addPage(copiedPage);
    
    console.log('✓ Template page copied with all formatting\n');
    
    // Get the page
    const pages = newDoc.getPages();
    const page = pages[0];
    const { width, height } = page.getSize();
    
    // Embed fonts
    const font = await newDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await newDoc.embedFont(StandardFonts.HelveticaBold);
    
    // Now overlay white rectangles and new text at specific positions
    // Based on the extracted text positions (you'll need to adjust these coordinates)
    
    // Cover "CoolBlue" with white and add new company
    page.drawRectangle({
      x: 40,
      y: height - 120,
      width: 200,
      height: 40,
      color: rgb(1, 1, 1),
    });
    
    page.drawText(REPLACEMENTS.companyName.toUpperCase(), {
      x: 40,
      y: height - 105,
      size: 12,
      font: boldFont,
      color: rgb(0, 0, 0),
    });
    
    // Cover "Nederlands (NL)" with new country
    page.drawRectangle({
      x: 40,
      y: height - 140,
      width: 200,
      height: 15,
      color: rgb(1, 1, 1),
    });
    
    page.drawText(REPLACEMENTS.country, {
      x: 40,
      y: height - 135,
      size: 10,
      font: font,
      color: rgb(0, 0, 0),
    });
    
    // Cover date
    page.drawRectangle({
      x: 40,
      y: height - 230,
      width: 150,
      height: 15,
      color: rgb(1, 1, 1),
    });
    
    page.drawText(REPLACEMENTS.date, {
      x: 40,
      y: height - 225,
      size: 10,
      font: font,
      color: rgb(0, 0, 0),
    });
    
    console.log(`✓ Updated company: ${REPLACEMENTS.companyName}`);
    console.log(`✓ Updated date: ${REPLACEMENTS.date}`);
    console.log(`✓ Updated country: ${REPLACEMENTS.country}\n`);
    
    // Save the modified PDF
    const pdfBytes = await newDoc.save();
    const outputPath = `Cover_Letter_${REPLACEMENTS.companyName.replace(/\s+/g, '_')}.pdf`;
    await fs.writeFile(outputPath, pdfBytes);
    
    console.log(`✅ Cover letter generated: ${outputPath}\n`);
    
    return outputPath;
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  }
}

if (require.main === module) {
  createCoverLetterWithTemplate();
}

module.exports = { createCoverLetterWithTemplate };
