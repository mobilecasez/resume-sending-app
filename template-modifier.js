const fs = require('fs').promises;
const { PDFDocument, PDFName, PDFString } = require('pdf-lib');

async function createCoverLetterFromTemplate() {
  try {
    console.log('\n=== Custom Cover Letter Generator (Template-Based) ===\n');
    
    // Load the template
    const templateBytes = await fs.readFile('Cover_Letter_Rishi_Samadhiya.pdf');
    const pdfDoc = await PDFDocument.load(templateBytes);
    
    console.log('✓ Template loaded successfully');
    
    // Get the form or use text replacement approach
    const form = pdfDoc.getForm();
    const pages = pdfDoc.getPages();
    
    console.log(`Pages: ${pages.length}`);
    
    // Since the template has specific text, we need to use a different approach
    // We'll copy the template and overlay new text
    
    // Configuration from environment
    const companyName = process.env.COMPANY_NAME || 'Google';
    const position = process.env.POSITION || 'Senior Software Engineer';
    const recipientName = process.env.RECIPIENT_NAME || 'Hiring Manager';
    const companyParagraph = process.env.COMPANY_PARAGRAPH || 'I am excited about this opportunity.';
    const relevantSkills = process.env.RELEVANT_SKILLS || 'JavaScript, React, Node.js';
    const country = process.env.COUNTRY || 'United States';
    
    const currentDate = new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: '2-digit'
    });
    
    console.log(`\nGenerating cover letter for: ${companyName}`);
    console.log(`Position: ${position}\n`);
    
    // For now, let's save a copy and note what needs to be changed
    // The PDF has text embedded, so we need to use pdf-lib's text replacement
    // or create a new document with the same styling
    
    // Since pdf-lib doesn't support direct text replacement in existing content,
    // we'll need to use a different library or approach
    
    console.log('⚠️  PDF text replacement requires advanced techniques.');
    console.log('Recommended approach: Use a PDF editing tool or create template with form fields.\n');
    
    // Alternative: Save the template as-is with a note
    const modifiedBytes = await pdfDoc.save();
    const outputPath = `Cover_Letter_${companyName.replace(/\s+/g, '_')}_FromTemplate.pdf`;
    await fs.writeFile(outputPath, modifiedBytes);
    
    console.log(`✓ Template copied to: ${outputPath}`);
    console.log('\n📝 To customize this template, you need to:');
    console.log('1. Use a tool like Adobe Acrobat to add form fields');
    console.log('2. Or use a different approach like pdf-lib with text overlay');
    console.log('3. Or convert to editable format and rebuild\n');
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

createCoverLetterFromTemplate();
