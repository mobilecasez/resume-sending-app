const dbConfig = require('./db-config');
const { initializeAdminUser } = require('./scripts/init-admin');
const fs = require('fs').promises;

/**
 * Initialize PostgreSQL database schema
 */
async function initializeDatabase() {
    console.log(`\n🔧 Initializing PostgreSQL database schema...\n`);
    
    try {
        // PostgreSQL initialization only
        await initializePostgres();
        
        console.log('\n✅ Database initialization complete\n');
        
        // Initialize admin user after schema is ready
        await initializeAdminUser();
        
    } catch (error) {
        console.error('❌ Database initialization failed:', error);
        throw error;
    }
}


/**
 * Initialize PostgreSQL database
 */
async function initializePostgres() {
    console.log('📋 Creating PostgreSQL tables...');
    
    const schema = await fs.readFile('./database/postgres-schema.sql', 'utf8');
    const db = dbConfig.rawDb();
    
    // Execute schema
    await db.query(schema);
    
    console.log('✅ PostgreSQL schema created successfully');
    
    // Run migrations for existing databases
    await runPostgresMigrations(db);
}

/**
 * Run migrations for existing PostgreSQL databases
 */
async function runPostgresMigrations(db) {
    console.log('🔄 Running PostgreSQL migrations...');
    
    try {
        // Migration: Add is_popular and display_order columns to plans table if they don't exist
        await db.query(`
            DO $$ 
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='plans' AND column_name='is_popular') THEN
                    ALTER TABLE plans ADD COLUMN is_popular INTEGER DEFAULT 0;
                    RAISE NOTICE 'Added is_popular column to plans table';
                END IF;
                
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='plans' AND column_name='display_order') THEN
                    ALTER TABLE plans ADD COLUMN display_order INTEGER DEFAULT 0;
                    RAISE NOTICE 'Added display_order column to plans table';
                END IF;
            END $$;
        `);
        
        // Migration: Create payment_orders table if it doesn't exist
        await db.query(`
            CREATE TABLE IF NOT EXISTS payment_orders (
                id SERIAL PRIMARY KEY,
                order_id TEXT NOT NULL UNIQUE,
                payment_id TEXT,
                signature TEXT,
                user_id INTEGER NOT NULL,
                package_id INTEGER NOT NULL,
                amount NUMERIC(10, 2) NOT NULL,
                currency TEXT DEFAULT 'INR',
                status TEXT DEFAULT 'created',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (package_id) REFERENCES plans(id) ON DELETE CASCADE
            );
            
            CREATE INDEX IF NOT EXISTS idx_payment_orders_user_id ON payment_orders(user_id);
            CREATE INDEX IF NOT EXISTS idx_payment_orders_order_id ON payment_orders(order_id);
        `);
        
        // Migration: Add plan_id and razorpay_order_id columns to payment_orders if they don't exist
        await db.query(`
            DO $$ 
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='payment_orders' AND column_name='plan_id') THEN
                    ALTER TABLE payment_orders ADD COLUMN plan_id INTEGER;
                    RAISE NOTICE 'Added plan_id column to payment_orders table';
                END IF;
                
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='payment_orders' AND column_name='razorpay_order_id') THEN
                    ALTER TABLE payment_orders ADD COLUMN razorpay_order_id TEXT;
                    RAISE NOTICE 'Added razorpay_order_id column to payment_orders table';
                END IF;
            END $$;
        `);
        
        // Migration: Add Microsoft OAuth columns to users table if they don't exist
        await db.query(`
            DO $$ 
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='users' AND column_name='microsoft_access_token') THEN
                    ALTER TABLE users ADD COLUMN microsoft_access_token TEXT;
                    RAISE NOTICE 'Added microsoft_access_token column to users table';
                END IF;
                
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='users' AND column_name='microsoft_refresh_token') THEN
                    ALTER TABLE users ADD COLUMN microsoft_refresh_token TEXT;
                    RAISE NOTICE 'Added microsoft_refresh_token column to users table';
                END IF;

                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='users' AND column_name='used_pkce') THEN
                    ALTER TABLE users ADD COLUMN used_pkce BOOLEAN DEFAULT FALSE;
                    RAISE NOTICE 'Added used_pkce column to users table';
                END IF;
            END $$;
        `);

        // Migration: Add reply columns to application_history if missing
        await db.query(`
            DO $$ 
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='application_history' AND column_name='reply_subject') THEN
                    ALTER TABLE application_history ADD COLUMN reply_subject TEXT;
                    RAISE NOTICE 'Added reply_subject column to application_history';
                END IF;

                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='application_history' AND column_name='reply_snippet') THEN
                    ALTER TABLE application_history ADD COLUMN reply_snippet TEXT;
                    RAISE NOTICE 'Added reply_snippet column to application_history';
                END IF;

                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='application_history' AND column_name='reply_from_email') THEN
                    ALTER TABLE application_history ADD COLUMN reply_from_email TEXT;
                    RAISE NOTICE 'Added reply_from_email column to application_history';
                END IF;
            END $$;
        `);

        // Migration: Create application_reply_history table if it doesn't exist
        await db.query(`
            CREATE TABLE IF NOT EXISTS application_reply_history (
                id SERIAL PRIMARY KEY,
                application_id INTEGER NOT NULL,
                reply_date TIMESTAMP NOT NULL,
                reply_subject TEXT,
                reply_snippet TEXT,
                reply_from_email TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (application_id) REFERENCES application_history(id) ON DELETE CASCADE
            );
        `);
        
        console.log('✅ PostgreSQL migrations completed successfully');
    } catch (error) {
        console.error('⚠️ Migration warning:', error.message);
        // Don't fail if migrations have issues, just warn
    }
}

module.exports = { initializeDatabase };
