const fs = require('fs');
const pdfParse = require('pdf-parse');
const { PDFDocument } = require('pdf-lib');

async function analyzePDF() {
  try {
    const dataBuffer = fs.readFileSync('Cover_Letter_Rishi_Samadhiya.pdf');
    
    // Parse text content
    const data = await pdfParse(dataBuffer);
    
    console.log('\n=== PDF Analysis ===\n');
    console.log('Pages:', data.numpages);
    console.log('Text length:', data.text.length);
    console.log('\n=== Extracted Text ===\n');
    console.log(data.text);
    console.log('\n=== Metadata ===\n');
    console.log(data.info);
    
    // Load with pdf-lib to get detailed info
    const pdfDoc = await PDFDocument.load(dataBuffer);
    const pages = pdfDoc.getPages();
    const firstPage = pages[0];
    const { width, height } = firstPage.getSize();
    
    console.log('\n=== Page Dimensions ===\n');
    console.log(`Width: ${width}`);
    console.log(`Height: ${height}`);
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

analyzePDF();
