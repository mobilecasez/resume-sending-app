const dbConfig = require('../../db-config');

async function up() {
    try {
        console.log('Creating feature_flags table...');

        await dbConfig.run(`
            CREATE TABLE IF NOT EXISTS feature_flags (
                page_key    VARCHAR(100) PRIMARY KEY,
                status      VARCHAR(50)  NOT NULL DEFAULT 'active',
                title       VARCHAR(255),
                message     TEXT,
                updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Seed default flags — set status to 'under_construction' to show the overlay,
        // 'active' to hide it.
        const defaults = [
            {
                page_key: 'jobs_dashboard',
                status:   'under_construction',
                title:    'AI Job Hub',
                message:  "We're building something powerful — AI will automatically research companies, match jobs to your resume, and surface verified hiring contacts.",
            },
        ];

        for (const row of defaults) {
            await dbConfig.run(
                `INSERT INTO feature_flags (page_key, status, title, message)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (page_key) DO NOTHING`,
                [row.page_key, row.status, row.title, row.message]
            );
        }

        console.log('✅ feature_flags table created and seeded');
    } catch (error) {
        console.error('❌ Error creating feature_flags table:', error);
        throw error;
    }
}

async function down() {
    try {
        await dbConfig.run('DROP TABLE IF EXISTS feature_flags');
        console.log('✅ feature_flags table dropped');
    } catch (error) {
        console.error('❌ Error dropping feature_flags table:', error);
        throw error;
    }
}

module.exports = { up, down };
