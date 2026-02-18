const dbConfig = require('./db-config');
const { initializeAdminUser } = require('./scripts/init-admin');
const fs = require('fs').promises;

/**
 * Initialize database schema for both SQLite and PostgreSQL
 */
async function initializeDatabase() {
    const dbType = dbConfig.getDbType();
    console.log(`\n🔧 Initializing ${dbType.toUpperCase()} database schema...\n`);
    
    try {
        if (dbType === 'postgres') {
            // PostgreSQL initialization
            await initializePostgres();
        } else {
            // SQLite initialization
            await initializeSQLite();
        }
        
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
        
        console.log('✅ PostgreSQL migrations completed successfully');
    } catch (error) {
        console.error('⚠️ Migration warning:', error.message);
        // Don't fail if migrations have issues, just warn
    }
}

/**
 * Initialize SQLite database
 */
async function initializeSQLite() {
    const db = dbConfig.rawDb();
    
    return new Promise((resolve, reject) => {
        // Users table
        db.run(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                full_name TEXT NOT NULL,
                email TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                smtp_email TEXT,
                smtp_password TEXT,
                sender_name TEXT,
                resume_path TEXT,
                photo_path TEXT,
                signature_path TEXT,
                date_of_birth DATE,
                phone_number TEXT,
                address TEXT,
                oauth_provider TEXT,
                google_access_token TEXT,
                google_refresh_token TEXT,
                total_generated INTEGER DEFAULT 0,
                total_sent INTEGER DEFAULT 0,
                role TEXT DEFAULT 'user',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `, async (err) => {
            if (err) {
                console.error('Error creating users table:', err);
                reject(err);
                return;
            }
            console.log('✅ Users table ready');
            await addOAuthColumnsIfNeeded(db);
        });

        // Recipients table
        db.run(`
            CREATE TABLE IF NOT EXISTS recipients (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                email TEXT NOT NULL,
                website TEXT NOT NULL,
                position TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE(user_id, email)
            )
        `, (err) => {
            if (err) console.error('Error creating recipients table:', err);
            else console.log('✅ Recipients table ready');
        });

        // Application history table
        db.run(`
            CREATE TABLE IF NOT EXISTS application_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                company_name TEXT NOT NULL,
                position TEXT NOT NULL,
                recipient_email TEXT NOT NULL,
                sent_date DATETIME NOT NULL,
                reply_received INTEGER DEFAULT 0,
                reply_date DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `, (err) => {
            if (err) console.error('Error creating application_history table:', err);
            else console.log('✅ Application history table ready');
        });

        // Review cover letters table
        db.run(`
            CREATE TABLE IF NOT EXISTS review_cover_letters (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                letter_key TEXT NOT NULL,
                company_name TEXT,
                recipient_email TEXT,
                cover_letter_html TEXT,
                subject TEXT,
                address TEXT,
                date TEXT,
                position TEXT,
                locations TEXT,
                generated INTEGER DEFAULT 0,
                sent INTEGER DEFAULT 0,
                sent_date DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE(user_id, letter_key)
            )
        `, (err) => {
            if (err) {
                console.error('Error creating review_cover_letters table:', err);
            } else {
                console.log('✅ Review cover letters table ready');
                
                // Add columns if they don't exist
                db.all("PRAGMA table_info(review_cover_letters)", (err, columns) => {
                    if (err) {
                        console.error('Error checking review_cover_letters schema:', err);
                        return;
                    }
                    
                    const hasStoredEmail = columns.some(col => col.name === 'stored_recipient_email');
                    const hasStoredWebsite = columns.some(col => col.name === 'stored_recipient_website');
                    
                    if (!hasStoredEmail) {
                        db.run('ALTER TABLE review_cover_letters ADD COLUMN stored_recipient_email TEXT', (err) => {
                            if (err) console.error('Error adding stored_recipient_email column:', err);
                            else console.log('✅ Added stored_recipient_email column');
                        });
                    }
                    
                    if (!hasStoredWebsite) {
                        db.run('ALTER TABLE review_cover_letters ADD COLUMN stored_recipient_website TEXT', (err) => {
                            if (err) console.error('Error adding stored_recipient_website column:', err);
                            else console.log('✅ Added stored_recipient_website column');
                        });
                    }
                });
            }
        });

        // Plans table
        db.run(`
            CREATE TABLE IF NOT EXISTS plans (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                credits INTEGER NOT NULL,
                price REAL NOT NULL,
                validity_days INTEGER NOT NULL,
                description TEXT,
                features TEXT,
                is_active INTEGER DEFAULT 1,
                is_popular INTEGER DEFAULT 0,
                display_order INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `, (err) => {
            if (err) {
                console.error('Error creating plans table:', err);
            } else {
                console.log('✅ Plans table ready');
                // Insert default plans
                db.get('SELECT COUNT(*) as count FROM plans', (err, row) => {
                    if (!err && row.count === 0) {
                        const defaultPlans = [
                            { name: 'Starter', credits: 10, price: 4.99, validity_days: 30, description: 'Perfect for getting started', features: JSON.stringify(['10 cover letters', '30 days validity', 'AI-powered generation', 'Email support']) },
                            { name: 'Professional', credits: 30, price: 12.99, validity_days: 30, description: 'Best for active job seekers', features: JSON.stringify(['30 cover letters', '30 days validity', 'AI-powered generation', 'Priority support', 'Advanced customization']) },
                            { name: 'Premium', credits: 100, price: 34.99, validity_days: 90, description: 'Maximum value for serious professionals', features: JSON.stringify(['100 cover letters', '90 days validity', 'AI-powered generation', 'Priority support', 'Advanced customization', 'Extended validity']) },
                            { name: 'Enterprise', credits: 500, price: 149.99, validity_days: 365, description: 'Ultimate plan for power users', features: JSON.stringify(['500 cover letters', '365 days validity', 'AI-powered generation', 'Dedicated support', 'All features included', 'Annual validity']) }
                        ];
                        
                        const stmt = db.prepare('INSERT INTO plans (name, credits, price, validity_days, description, features) VALUES (?, ?, ?, ?, ?, ?)');
                        defaultPlans.forEach(plan => {
                            stmt.run(plan.name, plan.credits, plan.price, plan.validity_days, plan.description, plan.features);
                        });
                        stmt.finalize(() => {
                            console.log('✅ Default plans inserted');
                        });
                    }
                });
            }
        });

        // User credits table
        db.run(`
            CREATE TABLE IF NOT EXISTS user_credits (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL UNIQUE,
                credits_remaining INTEGER DEFAULT 0,
                credits_total INTEGER DEFAULT 0,
                last_purchase_date DATETIME,
                expiry_date DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `, (err) => {
            if (err) console.error('Error creating user_credits table:', err);
            else console.log('✅ User credits table ready');
        });

        // Credit transactions table
        db.run(`
            CREATE TABLE IF NOT EXISTS credit_transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                transaction_type TEXT NOT NULL,
                credits_change INTEGER NOT NULL,
                balance_after INTEGER NOT NULL,
                description TEXT,
                metadata TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `, (err) => {
            if (err) console.error('Error creating credit_transactions table:', err);
            else console.log('✅ Credit transactions table ready');
        });

        // Payment orders table for Razorpay transactions
        db.run(`
            CREATE TABLE IF NOT EXISTS payment_orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                order_id TEXT NOT NULL UNIQUE,
                payment_id TEXT,
                signature TEXT,
                user_id INTEGER NOT NULL,
                package_id INTEGER NOT NULL,
                amount REAL NOT NULL,
                currency TEXT DEFAULT 'INR',
                status TEXT DEFAULT 'created',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (package_id) REFERENCES plans(id) ON DELETE CASCADE
            )
        `, (err) => {
            if (err) console.error('Error creating payment_orders table:', err);
            else console.log('✅ Payment orders table ready');
        });

        // Monthly usage stats table
        db.run(`
            CREATE TABLE IF NOT EXISTS monthly_usage_stats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                month INTEGER NOT NULL,
                year INTEGER NOT NULL,
                credits_used INTEGER DEFAULT 0,
                letters_generated INTEGER DEFAULT 0,
                letters_sent INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE(user_id, month, year)
            )
        `, (err) => {
            if (err) console.error('Error creating monthly_usage_stats table:', err);
            else console.log('✅ Monthly usage stats table ready');
        });

        // Notifications table
        db.run(`
            CREATE TABLE IF NOT EXISTS notifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                type VARCHAR(50) NOT NULL,
                title VARCHAR(255) NOT NULL,
                message TEXT NOT NULL,
                details TEXT,
                metadata TEXT,
                is_read INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `, (err) => {
            if (err) console.error('Error creating notifications table:', err);
            else console.log('✅ Notifications table ready');
        });

        // Create index for notifications
        db.run(`CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id)`, (err) => {
            if (err) console.error('Error creating notifications user_id index:', err);
        });

        db.run(`CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC)`, (err) => {
            if (err) console.error('Error creating notifications created_at index:', err);
        });

        // Credit usage history table
        db.run(`
            CREATE TABLE IF NOT EXISTS credit_usage_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                credits_used INTEGER DEFAULT 1,
                action_type TEXT NOT NULL,
                company_name TEXT,
                position TEXT,
                recipient_email TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `, (err) => {
            if (err) {
                console.error('Error creating credit_usage_history table:', err);
                reject(err);
            } else {
                console.log('✅ Credit usage history table ready');
                resolve();
            }
        });
    });
}

/**
 * Add OAuth columns to existing SQLite users table if needed
 */
async function addOAuthColumnsIfNeeded(db) {
    return new Promise((resolve) => {
        db.all("PRAGMA table_info(users)", (err, columns) => {
            if (err) {
                console.error('Error checking table schema:', err);
                resolve();
                return;
            }
            
            const hasOAuthProvider = columns.some(col => col.name === 'oauth_provider');
            const hasGoogleAccessToken = columns.some(col => col.name === 'google_access_token');
            const hasGoogleRefreshToken = columns.some(col => col.name === 'google_refresh_token');
            const hasTotalGenerated = columns.some(col => col.name === 'total_generated');
            const hasTotalSent = columns.some(col => col.name === 'total_sent');
            const hasRole = columns.some(col => col.name === 'role');
            
            const alterations = [];
            
            if (!hasOAuthProvider) alterations.push('ALTER TABLE users ADD COLUMN oauth_provider TEXT');
            if (!hasGoogleAccessToken) alterations.push('ALTER TABLE users ADD COLUMN google_access_token TEXT');
            if (!hasGoogleRefreshToken) alterations.push('ALTER TABLE users ADD COLUMN google_refresh_token TEXT');
            if (!hasTotalGenerated) alterations.push('ALTER TABLE users ADD COLUMN total_generated INTEGER DEFAULT 0');
            if (!hasTotalSent) alterations.push('ALTER TABLE users ADD COLUMN total_sent INTEGER DEFAULT 0');
            if (!hasRole) alterations.push("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'");
            
            let completed = 0;
            if (alterations.length === 0) {
                resolve();
                return;
            }
            
            alterations.forEach((sql, index) => {
                db.run(sql, (err) => {
                    if (err) console.error(`Error adding column:`, err);
                    else console.log(`✅ Added column ${index + 1}/${alterations.length}`);
                    
                    completed++;
                    if (completed === alterations.length) {
                        resolve();
                    }
                });
            });
        });
    });
}

module.exports = { initializeDatabase };
