const dbConfig = require('./db-config');
const { initializeAdminUser } = require('./scripts/init-admin');
const fs = require('fs').promises;
const path = require('path');

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
    
    const db = dbConfig.rawDb();
    const schemaPath = path.join(__dirname, 'database', 'postgres-schema.sql');

    let schema;
    try {
        schema = await fs.readFile(schemaPath, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.warn(`⚠️ PostgreSQL schema file not found at ${schemaPath}. Skipping schema creation and continuing with migrations only.`);
            await runPostgresMigrations(db);
            return;
        }
        throw error;
    }
    
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

        // Migration: Add Apple Sign-In columns to users table if they don't exist
        await db.query(`
            DO $$ 
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='users' AND column_name='apple_user_id') THEN
                    ALTER TABLE users ADD COLUMN apple_user_id TEXT;
                    RAISE NOTICE 'Added apple_user_id column to users table';
                END IF;

                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='users' AND column_name='apple_identity_token') THEN
                    ALTER TABLE users ADD COLUMN apple_identity_token TEXT;
                    RAISE NOTICE 'Added apple_identity_token column to users table';
                END IF;

                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='users' AND column_name='apple_token_issued_at') THEN
                    ALTER TABLE users ADD COLUMN apple_token_issued_at TIMESTAMP;
                    RAISE NOTICE 'Added apple_token_issued_at column to users table';
                END IF;

                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='users' AND column_name='apple_token_expires_at') THEN
                    ALTER TABLE users ADD COLUMN apple_token_expires_at TIMESTAMP;
                    RAISE NOTICE 'Added apple_token_expires_at column to users table';
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

        // Migration: Add soft-delete columns (deleted_at, deleted_by) to all tables
        await db.query(`
            DO $$
            DECLARE
                tbl TEXT;
            BEGIN
                FOREACH tbl IN ARRAY ARRAY['recipients','application_history','review_cover_letters',
                    'plans','notifications','users','credit_transactions','user_credits','payment_orders']
                LOOP
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                                   WHERE table_name = tbl AND column_name = 'deleted_at') THEN
                        EXECUTE format('ALTER TABLE %I ADD COLUMN deleted_at TIMESTAMP DEFAULT NULL', tbl);
                        RAISE NOTICE 'Added deleted_at to %', tbl;
                    END IF;
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                                   WHERE table_name = tbl AND column_name = 'deleted_by') THEN
                        EXECUTE format('ALTER TABLE %I ADD COLUMN deleted_by INTEGER DEFAULT NULL', tbl);
                        RAISE NOTICE 'Added deleted_by to %', tbl;
                    END IF;
                END LOOP;
            END $$;
        `);

        // SECURITY FIX: Add OAuth token expiration tracking columns
        await db.query(`
            DO $$ 
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='users' AND column_name='google_token_expires_at') THEN
                    ALTER TABLE users ADD COLUMN google_token_expires_at TIMESTAMP DEFAULT NULL;
                    RAISE NOTICE 'Added google_token_expires_at column to users table';
                END IF;
                
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='users' AND column_name='microsoft_token_expires_at') THEN
                    ALTER TABLE users ADD COLUMN microsoft_token_expires_at TIMESTAMP DEFAULT NULL;
                    RAISE NOTICE 'Added microsoft_token_expires_at column to users table';
                END IF;

                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='users' AND column_name='google_token_issued_at') THEN
                    ALTER TABLE users ADD COLUMN google_token_issued_at TIMESTAMP DEFAULT NULL;
                    RAISE NOTICE 'Added google_token_issued_at column to users table';
                END IF;
                
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                              WHERE table_name='users' AND column_name='microsoft_token_issued_at') THEN
                    ALTER TABLE users ADD COLUMN microsoft_token_issued_at TIMESTAMP DEFAULT NULL;
                    RAISE NOTICE 'Added microsoft_token_issued_at column to users table';
                END IF;

                -- Optional self-declared gender ('Male' | 'Female' | 'Prefer Not to Say').
                -- Used WITH the user's consent to auto-fill pronoun/gender questions on job forms.
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                              WHERE table_name='users' AND column_name='gender') THEN
                    ALTER TABLE users ADD COLUMN gender TEXT DEFAULT NULL;
                    RAISE NOTICE 'Added gender column to users table';
                END IF;
            END $$;
        `);

        // SECURITY FIX: Create security_audit_log table for CASA Tier 2 compliance
        await db.query(`
            CREATE TABLE IF NOT EXISTS security_audit_log (
                id SERIAL PRIMARY KEY,
                user_id INTEGER,
                event_type VARCHAR(100) NOT NULL,
                event_category VARCHAR(50) NOT NULL,
                ip_address VARCHAR(45),
                user_agent TEXT,
                details JSONB,
                success BOOLEAN DEFAULT TRUE,
                error_message TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
            );
            
            -- Indexes for efficient querying
            CREATE INDEX IF NOT EXISTS idx_security_audit_user_id ON security_audit_log(user_id);
            CREATE INDEX IF NOT EXISTS idx_security_audit_event_type ON security_audit_log(event_type);
            CREATE INDEX IF NOT EXISTS idx_security_audit_created_at ON security_audit_log(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_security_audit_category ON security_audit_log(event_category);
        `);

        // Async jobs table for background processing
        await db.query(`
            CREATE TABLE IF NOT EXISTS async_jobs (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id INTEGER NOT NULL,
                type TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                progress INTEGER DEFAULT 0,
                input JSONB,
                result JSONB,
                error TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_async_jobs_user_id ON async_jobs(user_id);
            CREATE INDEX IF NOT EXISTS idx_async_jobs_status ON async_jobs(status);
        `);

        // Migration: Create resume_metadata table for background resume parsing
        await db.query(`
            CREATE TABLE IF NOT EXISTS resume_metadata (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL UNIQUE,
                raw_text TEXT,
                summary TEXT,
                skills TEXT[],
                technical_skills JSONB,
                soft_skills TEXT[],
                experience_years NUMERIC(4,1),
                experience_summary TEXT,
                education JSONB,
                certifications JSONB,
                languages TEXT[],
                job_titles TEXT[],
                industries TEXT[],
                parse_status TEXT NOT NULL DEFAULT 'pending',
                parse_error TEXT,
                parsed_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_resume_metadata_user_id ON resume_metadata(user_id);
            CREATE INDEX IF NOT EXISTS idx_resume_metadata_parse_status ON resume_metadata(parse_status);
        `);

        // AI Hub Job Portal Tables
        await db.query(`
            CREATE TABLE IF NOT EXISTS employers (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                domain VARCHAR(255) UNIQUE NOT NULL,
                name VARCHAR(255) NOT NULL,
                sub_info VARCHAR(255),
                logo_color JSONB,
                logo_initial VARCHAR(10),
                last_scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS locations (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                area VARCHAR(255),
                city VARCHAR(255),
                state VARCHAR(255),
                country VARCHAR(255),
                zip VARCHAR(50),
                raw_text VARCHAR(255) UNIQUE NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS jobs (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                employer_id UUID NOT NULL REFERENCES employers(id) ON DELETE CASCADE,
                location_id UUID REFERENCES locations(id) ON DELETE SET NULL,
                title VARCHAR(255) NOT NULL,
                job_url VARCHAR(2000) UNIQUE NOT NULL,
                experience VARCHAR(255),
                salary VARCHAR(255),
                job_type VARCHAR(255),
                urgent BOOLEAN DEFAULT FALSE,
                responsibilities JSONB,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_jobs_employer_id ON jobs(employer_id);

            CREATE TABLE IF NOT EXISTS skills (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                name VARCHAR(255) UNIQUE NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS job_skills (
                job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
                skill_id UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
                PRIMARY KEY (job_id, skill_id)
            );

            CREATE TABLE IF NOT EXISTS user_skills (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                skill_id UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
                PRIMARY KEY (user_id, skill_id)
            );

            CREATE TABLE IF NOT EXISTS job_contacts (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
                name VARCHAR(255),
                role VARCHAR(255),
                email VARCHAR(255),
                phone VARCHAR(255),
                avatar_url VARCHAR(1000),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS user_tracked_employers (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                employer_id UUID NOT NULL REFERENCES employers(id) ON DELETE CASCADE,
                status VARCHAR(50) DEFAULT 'watching',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, employer_id)
            );

            CREATE TABLE IF NOT EXISTS user_job_matches (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
                match_score INTEGER DEFAULT 0,
                status VARCHAR(50) DEFAULT 'new',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, job_id)
            );

            -- Core employer identity (one row per employer website)
            CREATE TABLE IF NOT EXISTS employer_profiles (
                website_url TEXT PRIMARY KEY,
                employer_name TEXT,
                founded_year INTEGER,
                company_size TEXT,
                industry TEXT,
                mission TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Brand color + font extracted from employer website
            CREATE TABLE IF NOT EXISTS employer_brand_profiles (
                website_url TEXT PRIMARY KEY REFERENCES employer_profiles(website_url) ON DELETE CASCADE,
                brand_color VARCHAR(7) NOT NULL DEFAULT '#262633',
                font_name VARCHAR(100) NOT NULL DEFAULT 'Lato',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Products, platforms, tech stack, languages, frameworks, cloud providers
            CREATE TABLE IF NOT EXISTS employer_technologies (
                id SERIAL PRIMARY KEY,
                website_url TEXT NOT NULL REFERENCES employer_profiles(website_url) ON DELETE CASCADE,
                name TEXT NOT NULL,
                category TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Named clients, industries served, enterprise deals, government contracts
            CREATE TABLE IF NOT EXISTS employer_clients (
                id SERIAL PRIMARY KEY,
                website_url TEXT NOT NULL REFERENCES employer_profiles(website_url) ON DELETE CASCADE,
                client_name TEXT NOT NULL,
                industry TEXT,
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Recent news: launches, partnerships, funding, awards, expansions
            CREATE TABLE IF NOT EXISTS employer_recent_activity (
                id SERIAL PRIMARY KEY,
                website_url TEXT NOT NULL REFERENCES employer_profiles(website_url) ON DELETE CASCADE,
                activity_type TEXT,
                description TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Office locations extracted during research
            CREATE TABLE IF NOT EXISTS employer_locations (
                id SERIAL PRIMARY KEY,
                website_url TEXT NOT NULL REFERENCES employer_profiles(website_url) ON DELETE CASCADE,
                address TEXT NOT NULL,
                is_headquarters BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Key team members, hiring managers, leadership found during research
            CREATE TABLE IF NOT EXISTS employer_contacts (
                id SERIAL PRIMARY KEY,
                website_url TEXT NOT NULL REFERENCES employer_profiles(website_url) ON DELETE CASCADE,
                name TEXT,
                role TEXT,
                source TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Each ALTER TABLE is a separate await — pg only reliably runs one statement per query() call
        const col = async (sql) => { try { await db.query(sql); } catch(e) { if (!e.message.includes('already exists')) console.warn('migration:', e.message); } };

        // users — IP tracking
        await col(`ALTER TABLE users ADD COLUMN IF NOT EXISTS registration_ip TEXT DEFAULT NULL`);
        await col(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_ip TEXT DEFAULT NULL`);
        await col(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP DEFAULT NULL`);
        await col(`CREATE INDEX IF NOT EXISTS idx_users_registration_ip ON users(registration_ip)`);
        console.log('✅ Migration 004: IP tracking columns done');

        // users — Google OAuth token metadata
        await col(`ALTER TABLE users ADD COLUMN IF NOT EXISTS used_pkce BOOLEAN DEFAULT FALSE`);
        await col(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_token_issued_at TIMESTAMP DEFAULT NULL`);
        await col(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_token_expires_at TIMESTAMP DEFAULT NULL`);
        await col(`ALTER TABLE users ADD COLUMN IF NOT EXISTS total_replied INTEGER DEFAULT 0`);
        await col(`ALTER TABLE users ADD COLUMN IF NOT EXISTS city TEXT DEFAULT NULL`);
        await col(`ALTER TABLE users ADD COLUMN IF NOT EXISTS country TEXT DEFAULT NULL`);
        console.log('✅ Migration 004b: Google token metadata columns done');

        // users — Microsoft OAuth
        await col(`ALTER TABLE users ADD COLUMN IF NOT EXISTS microsoft_access_token TEXT DEFAULT NULL`);
        await col(`ALTER TABLE users ADD COLUMN IF NOT EXISTS microsoft_refresh_token TEXT DEFAULT NULL`);
        await col(`ALTER TABLE users ADD COLUMN IF NOT EXISTS microsoft_id TEXT DEFAULT NULL`);
        await col(`ALTER TABLE users ADD COLUMN IF NOT EXISTS microsoft_token_issued_at TIMESTAMP DEFAULT NULL`);
        await col(`ALTER TABLE users ADD COLUMN IF NOT EXISTS microsoft_token_expires_at TIMESTAMP DEFAULT NULL`);
        console.log('✅ Migration 005: Microsoft OAuth columns done');

        // AI Job Hub — async-job tracking column. Referenced in code
        // (processJobSearch links each search's async_jobs.id here) but never had
        // a migration, so production was missing it → every job search threw
        // "column async_job_id does not exist". async_jobs.id is UUID.
        await col(`ALTER TABLE user_tracked_employers ADD COLUMN IF NOT EXISTS async_job_id UUID DEFAULT NULL`);
        console.log('✅ Migration 005b: user_tracked_employers.async_job_id done');

        // AI Job Hub — jobs.responsibilities. upsertJob() inserts this column but it
        // was never in the jobs CREATE nor a migration, so EVERY job insert threw
        // "column responsibilities does not exist" → 0 jobs persisted (they streamed
        // to the UI but vanished on reload). JSONB array of responsibility strings.
        await col(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS responsibilities JSONB`);
        console.log('✅ Migration 005c: jobs.responsibilities done');

        // users — Apple OAuth
        await col(`ALTER TABLE users ADD COLUMN IF NOT EXISTS apple_user_id TEXT DEFAULT NULL`);
        await col(`ALTER TABLE users ADD COLUMN IF NOT EXISTS apple_identity_token TEXT DEFAULT NULL`);
        await col(`ALTER TABLE users ADD COLUMN IF NOT EXISTS apple_token_issued_at TIMESTAMP DEFAULT NULL`);
        await col(`ALTER TABLE users ADD COLUMN IF NOT EXISTS apple_token_expires_at TIMESTAMP DEFAULT NULL`);
        console.log('✅ Migration 005b: Apple OAuth columns done');

        // users — soft-delete
        await col(`ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP DEFAULT NULL`);
        await col(`ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_by INTEGER DEFAULT NULL`);
        console.log('✅ Migration 006: Soft-delete columns done');

        // review_cover_letters — branding + soft-delete
        await col(`ALTER TABLE review_cover_letters ADD COLUMN IF NOT EXISTS brand_color TEXT DEFAULT NULL`);
        await col(`ALTER TABLE review_cover_letters ADD COLUMN IF NOT EXISTS font_name TEXT DEFAULT NULL`);
        await col(`ALTER TABLE review_cover_letters ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP DEFAULT NULL`);
        console.log('✅ Migration 007: review_cover_letters branding columns done');

        console.log('✅ PostgreSQL migrations completed successfully');
    } catch (error) {
        console.error('⚠️ Migration warning:', error.message);
        // Don't fail if migrations have issues, just warn
    }
}

module.exports = { initializeDatabase };
