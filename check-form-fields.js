const { PDFDocument } = require('pdf-lib');
const fs = require('fs').promises;

async function checkFormFields() {
  try {
    console.log('\n=== Checking PDF for Form Fields ===\n');
    
    const pdfBytes = await fs.readFile('Cover_Letter_Rishi_Samadhiya.pdf');
    const pdfDoc = await PDFDocument.load(pdfBytes);
    
    const form = pdfDoc.getForm();
    const fields = form.getFields();
    
    console.log(`Total form fields found: ${fields.length}\n`);
    
    if (fields.length === 0) {
      console.log('❌ No form fields found in this PDF.');
      console.log('\nThis means the PDF does not have editable fields.');
      console.log('You need to either:');
      console.log('1. Convert it to a fillable PDF form using Adobe Acrobat');
      console.log('2. Provide the original Word/Google Docs file');
      console.log('3. Let me recreate the design from scratch');
      console.log('\nSee PDF_TEMPLATE_GUIDE.md for detailed instructions.\n');
    } else {
      console.log('✅ Form fields found:\n');
      fields.forEach((field, index) => {
        const name = field.getName();
        const type = field.constructor.name;
        console.log(`${index + 1}. ${name} (${type})`);
      });
      console.log('\n✅ This PDF can be filled programmatically!\n');
    }
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

checkFormFields();
