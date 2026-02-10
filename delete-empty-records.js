require('dotenv').config(); // Load environment variables
const dbConfig = require('./db-config');

// Initialize database connection
dbConfig.initializeConnection();

async function deleteEmptyRecords() {
    try {
        // Wait a bit for connection to establish
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        console.log('Deleting empty records from review_cover_letters...');
        const result = await dbConfig.query(
            "DELETE FROM review_cover_letters WHERE cover_letter_html IS NULL OR cover_letter_html = ''"
        );
        console.log('✅ Deleted empty cover letter records');
        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

deleteEmptyRecords();
