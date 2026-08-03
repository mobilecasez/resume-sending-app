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

        // AI Job Hub — per-user job match % is computed lazily in the background
        // (semantic skill match via Gemini). `scored_at` distinguishes "not yet
        // scored" (NULL → the card shows "Evaluating…") from a real score (0–100).
        // Existing rows have scored_at NULL, so each gets scored exactly once.
        await col(`ALTER TABLE user_job_matches ADD COLUMN IF NOT EXISTS scored_at TIMESTAMP DEFAULT NULL`);
        console.log('✅ Migration 005e: user_job_matches.scored_at done');

        // AI Job Hub — job_contacts: addJobContact() inserts linkedin_url + image_url and
        // upserts ON CONFLICT (job_id, email), but the job_contacts CREATE only ever had the
        // base columns (no linkedin_url / image_url / updated_at, no (job_id,email) unique index).
        // So in production EVERY contact insert threw "column linkedin_url does not exist" → 0
        // contacts ever persisted (they showed in the app's optimistic UI but vanished on reload).
        // SAME class as 005c (jobs.responsibilities). Purely additive — never touches existing rows.
        await col(`ALTER TABLE job_contacts ADD COLUMN IF NOT EXISTS linkedin_url VARCHAR(1000)`);
        await col(`ALTER TABLE job_contacts ADD COLUMN IF NOT EXISTS image_url VARCHAR(1000)`);
        await col(`ALTER TABLE job_contacts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`);
        await col(`CREATE UNIQUE INDEX IF NOT EXISTS job_contacts_job_email_uniq ON job_contacts (job_id, email)`);
        console.log('✅ Migration 005f: job_contacts linkedin_url/image_url/updated_at + (job_id,email) unique done');

        // First-party real-time analytics — app_events captures opens/events the app reports live
        // (active-users pulse), bypassing the 1–3 day store-report delay. Append-only, additive.
        await col(`CREATE TABLE IF NOT EXISTS app_events (
            id BIGSERIAL PRIMARY KEY,
            user_id INTEGER,
            anon_id TEXT,
            platform TEXT,
            event TEXT NOT NULL,
            props JSONB,
            app_version TEXT,
            country TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        await col(`CREATE INDEX IF NOT EXISTS idx_app_events_created ON app_events(created_at DESC)`);
        await col(`CREATE INDEX IF NOT EXISTS idx_app_events_event ON app_events(event)`);
        // Server-to-server purchase notifications (Apple App Store Server Notifications V2 + Google RTDN).
        await col(`CREATE TABLE IF NOT EXISTS store_notifications (
            id BIGSERIAL PRIMARY KEY,
            store TEXT NOT NULL,
            notification_type TEXT,
            subtype TEXT,
            transaction_id TEXT,
            original_transaction_id TEXT,
            product_id TEXT,
            user_id INTEGER,
            payload JSONB,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        await col(`CREATE INDEX IF NOT EXISTS idx_store_notifications_created ON store_notifications(created_at DESC)`);
        console.log('✅ Migration 005g: app_events + store_notifications tables done');

        // Migration 005h — store-lifecycle logging. Rich columns on store_notifications so Apple V2 /
        // Google RTDN events carry a clean lifecycle `event` (subscription_started/renewed/canceled/
        // expired/refund/purchase/...), price/currency, and environment (Sandbox vs Production).
        await col(`ALTER TABLE store_notifications ADD COLUMN IF NOT EXISTS event TEXT`);
        await col(`ALTER TABLE store_notifications ADD COLUMN IF NOT EXISTS price NUMERIC`);
        await col(`ALTER TABLE store_notifications ADD COLUMN IF NOT EXISTS currency TEXT`);
        await col(`ALTER TABLE store_notifications ADD COLUMN IF NOT EXISTS environment TEXT`);
        await col(`ALTER TABLE store_notifications ADD COLUMN IF NOT EXISTS dedupe_key TEXT`);
        await col(`CREATE UNIQUE INDEX IF NOT EXISTS uq_store_notifications_dedupe ON store_notifications(dedupe_key) WHERE dedupe_key IS NOT NULL`);
        await col(`CREATE INDEX IF NOT EXISTS idx_store_notifications_store_event ON store_notifications(store, event, created_at DESC)`);
        // Uninstall events are logged into app_events (event='uninstall') by the push-receipt detector,
        // so installs vs uninstalls vs net all derive from one table. Index already covers (event).
        console.log('✅ Migration 005h: store_notifications lifecycle columns done');

        // AI Job Hub — per-job English translation cache (Translate-to-English
        // toggle on job cards). ATS jobs are parsed from HTML in their original
        // language; this caches the Gemini English translation once per job.
        await col(`
            CREATE TABLE IF NOT EXISTS job_translations (
                job_id UUID NOT NULL,
                target_lang VARCHAR(8) NOT NULL DEFAULT 'en',
                source_lang VARCHAR(16),
                payload JSONB NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (job_id, target_lang)
            )
        `);
        console.log('✅ Migration 005d: job_translations table done');

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

        // ai_event_costs — admin-configurable credit cost per AI event (see
        // server/services/eventCosts.js). Seeded from the canonical CATALOG;
        // re-seed updates labels/descriptions but PRESERVES admin-edited credits + is_active.
        await col(`
            CREATE TABLE IF NOT EXISTS ai_event_costs (
                id SERIAL PRIMARY KEY,
                event_key TEXT UNIQUE NOT NULL,
                label TEXT NOT NULL,
                description TEXT,
                category TEXT DEFAULT 'paid',
                direction TEXT NOT NULL DEFAULT 'debit',
                credits INTEGER NOT NULL DEFAULT 0,
                is_active INTEGER NOT NULL DEFAULT 1,
                sort_order INTEGER DEFAULT 0,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        // direction: 'credit' = a REWARD (credits granted), 'debit' = a COST (credits charged). Split into
        // two tabs on the admin credits screen. Added after the original table → migrate existing rows.
        await col(`ALTER TABLE ai_event_costs ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'debit'`);
        try {
            const { CATALOG } = require('./server/services/eventCosts');
            for (const e of CATALOG) {
                await db.query(
                    `INSERT INTO ai_event_costs (event_key, label, description, category, direction, credits, is_active, sort_order)
                     VALUES ($1, $2, $3, $4, $5, $6, 1, $7)
                     ON CONFLICT (event_key) DO UPDATE SET
                        label = EXCLUDED.label,
                        description = EXCLUDED.description,
                        category = EXCLUDED.category,
                        direction = EXCLUDED.direction,
                        sort_order = EXCLUDED.sort_order`,
                    [e.key, e.label, e.description, e.category, e.direction || 'debit', e.credits, e.sort]
                );
            }
            console.log('✅ Migration 008: ai_event_costs table + seed done');
        } catch (seedErr) {
            console.warn('⚠️ ai_event_costs seed warning:', seedErr.message);
        }

        // user_reward_grants — idempotent ledger of credits GRANTED to users (activation rewards + referrals).
        // idem_key makes each grant one-shot: one-time rewards use the event_key; referral uses
        // 'reward_referral:<referredUserId>' so each invited friend pays out at most once.
        await col(`
            CREATE TABLE IF NOT EXISTS user_reward_grants (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                event_key TEXT NOT NULL,
                idem_key TEXT NOT NULL,
                credits INTEGER NOT NULL DEFAULT 0,
                note TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (user_id, idem_key)
            )
        `);
        await col(`CREATE INDEX IF NOT EXISTS idx_user_reward_grants_user ON user_reward_grants(user_id, created_at DESC)`);
        console.log('✅ Migration 008b: user_reward_grants ledger done');

        // app_feedback — private in-app feedback (low ratings + messages). Happy users
        // go to the native store review instead; only 1–3★ / written feedback lands here.
        await col(`
            CREATE TABLE IF NOT EXISTS app_feedback (
                id SERIAL PRIMARY KEY,
                user_id INTEGER,
                rating INTEGER,
                message TEXT,
                trigger TEXT,
                platform TEXT,
                app_version TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ Migration 009: app_feedback table done');

        // employer_fix_requests — a user-submitted "we couldn't fetch this employer's
        // jobs, please add support" request. Feeds the self-improving fix loop.
        await col(`
            CREATE TABLE IF NOT EXISTS employer_fix_requests (
                id SERIAL PRIMARY KEY,
                user_id INTEGER,
                email TEXT,
                employer_input TEXT NOT NULL,
                domain TEXT,
                detected_ats TEXT,
                job_count INTEGER DEFAULT 0,
                status TEXT DEFAULT 'pending',          -- pending|investigating|fixed|no_jobs|failed
                diagnosis JSONB,
                attempts INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                resolved_at TIMESTAMP
            )
        `);
        await col(`CREATE INDEX IF NOT EXISTS idx_efr_domain ON employer_fix_requests(domain)`);
        await col(`CREATE INDEX IF NOT EXISTS idx_efr_status ON employer_fix_requests(status)`);

        // employer_overrides — the VERSIONED per-employer fix the agent produces. The
        // discovery pipeline checks the active override (by domain) first and applies it.
        // History is kept (every version is a row) so a rolled-back fix can be re-applied.
        await col(`
            CREATE TABLE IF NOT EXISTS employer_overrides (
                id SERIAL PRIMARY KEY,
                domain TEXT NOT NULL,
                request_id INTEGER,
                fix_config JSONB NOT NULL,
                verified BOOLEAN DEFAULT FALSE,
                verify_job_count INTEGER DEFAULT 0,
                verify_sample JSONB,
                active BOOLEAN DEFAULT FALSE,
                version INTEGER DEFAULT 1,
                created_by TEXT DEFAULT 'agent',
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await col(`CREATE INDEX IF NOT EXISTS idx_eo_domain ON employer_overrides(domain)`);
        await col(`CREATE INDEX IF NOT EXISTS idx_eo_active ON employer_overrides(domain, active)`);
        console.log('✅ Migration 010: employer_fix_requests + employer_overrides done');

        // ── Migration 011: employer_detail_recipes ────────────────────────────
        // Per-employer "how to extract a job DETAIL page" recipe, LEARNED by the agent
        // from 1-2 sample jobs when the generic parser comes up short, then applied
        // deterministically (no AI) to all of that employer's jobs.
        await col(`
            CREATE TABLE IF NOT EXISTS employer_detail_recipes (
                id SERIAL PRIMARY KEY,
                domain TEXT NOT NULL UNIQUE,
                recipe JSONB NOT NULL,
                verified BOOLEAN DEFAULT FALSE,
                fields_recovered TEXT,
                sample_url TEXT,
                created_by TEXT DEFAULT 'agent',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`);
        await col(`CREATE INDEX IF NOT EXISTS idx_edr_domain ON employer_detail_recipes(domain)`);
        console.log('✅ Migration 011: employer_detail_recipes done');

        // ── Migration 012: jobs.work_mode ─────────────────────────────────────
        // Separates WORK MODE (Remote/Hybrid/Office) from job_type (employment type:
        // Full-time/Part-time/…). Previously the AI extractor's "Type of Job" work-mode
        // value was stuffed into job_type, conflating two distinct concepts. Nullable;
        // legacy rows stay NULL and the UI simply omits the chip. ATS jobs have no work
        // mode → NULL (correct).
        await col(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS work_mode VARCHAR(255) DEFAULT NULL`);
        console.log('✅ Migration 012: jobs.work_mode done');

        // ── Migration 013: user_job_portal_details ────────────────────────────
        // Self-learning autofill memory. The `users` table holds ONLY the core profile
        // (name/email/phone/city/country/address/nationality…). Every OTHER thing we learn from
        // the forms the user fills (visa sponsorship, notice period, "how did you hear", and any
        // ad-hoc portal question) is stored here as a simple QUESTION → ANSWER row — no new
        // column per field. Keyed by a normalized question so the SAME question on ANY future
        // portal auto-fills. Loaded alongside the user's details when auto-filling a form.
        await db.query(`DROP TABLE IF EXISTS user_autofill_memory`);   // superseded by the Q&A table below
        await db.query(`
            CREATE TABLE IF NOT EXISTS user_job_portal_details (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                q_key TEXT NOT NULL,          -- normalized question (the match key)
                question TEXT NOT NULL,       -- the original question / field label
                answer TEXT NOT NULL,
                field_type TEXT,
                use_count INTEGER DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (user_id, q_key)
            );
            CREATE INDEX IF NOT EXISTS idx_ujpd_user ON user_job_portal_details(user_id);
        `);
        console.log('✅ Migration 013: user_job_portal_details done');

        // ── Migration 014: users.nationality ──────────────────────────────────
        // The autofill profile queries already SELECT `nationality`, but the column was never
        // created — so those queries silently failed (smart-fill-data returned no profile). Add
        // it so learned/entered nationality is stored properly alongside city/country/address.
        await col(`ALTER TABLE users ADD COLUMN IF NOT EXISTS nationality VARCHAR(120) DEFAULT NULL`);
        console.log('✅ Migration 014: users.nationality done');

        // ── Migration 015: user_motivation_lines ──────────────────────────────
        // Personalized, résumé-aware encouragement shown while a search is processing. Generated
        // ONCE per user (AI reads their skills/titles/experience), then cached here and reused —
        // never re-generated per search. The generic 500-line tip library is bundled in the app.
        await db.query(`
            CREATE TABLE IF NOT EXISTS user_motivation_lines (
                user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                lines JSONB NOT NULL,
                source TEXT,                  -- 'ai' (cacheable) vs 'fallback' (not cached)
                generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ Migration 015: user_motivation_lines done');

        // ── Migration 016: system_schedule ────────────────────────────────────
        // Persisted last-run timestamps for background maintenance jobs (e.g. the daily
        // employer fix-queue agent), so "run once a day" survives frequent server restarts /
        // deploys instead of resetting a setInterval each boot.
        await db.query(`
            CREATE TABLE IF NOT EXISTS system_schedule (
                job_key TEXT PRIMARY KEY,
                last_run_at TIMESTAMP,
                last_summary TEXT
            );
        `);
        console.log('✅ Migration 016: system_schedule done');

        // ── Migration 017: app_redirect_clicks ────────────────────────────────
        // Tracks every hit on the smart app-store redirect (/download, /get, /app) — platform,
        // UA, referrer, UTM params, IP — so we can measure ad clicks / install intent.
        await db.query(`
            CREATE TABLE IF NOT EXISTS app_redirect_clicks (
                id SERIAL PRIMARY KEY,
                platform TEXT,                 -- ios | android | desktop
                user_agent TEXT,
                referer TEXT,
                utm_source TEXT,
                utm_medium TEXT,
                utm_campaign TEXT,
                ip TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await db.query(`CREATE INDEX IF NOT EXISTS idx_app_redirect_clicks_created ON app_redirect_clicks (created_at);`);
        console.log('✅ Migration 017: app_redirect_clicks done');

        // ── Migration 018: user_job_url_overrides + users.expo_push_token ──────
        // (a) Per-user manual correction of a job's apply URL (some AI/scraped URLs are wrong or
        //     missing — the user can fix THEIR apply link without overwriting it for everyone).
        // (b) Per-user Expo push token, so we can notify when a slow job search finishes.
        await db.query(`
            CREATE TABLE IF NOT EXISTS user_job_url_overrides (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                job_id  UUID    NOT NULL REFERENCES jobs(id)  ON DELETE CASCADE,
                url     TEXT    NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, job_id)
            );
        `);
        await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS expo_push_token TEXT`);
        console.log('✅ Migration 018: user_job_url_overrides + users.expo_push_token done');

        // ── Migration 019: notifications v2 — per-category prefs + reminder/expiry dedup ──────
        // (a) notification_preferences: per-user opt-out per category (default all ON) — gates PUSH.
        // (b) application_history.follow_up_reminded_at: so the daily follow-up reminder fires once.
        // (c) user_credits.expiry_warned_at: so the credit-expiry warning fires once per expiry.
        await db.query(`
            CREATE TABLE IF NOT EXISTS notification_preferences (
                user_id INTEGER PRIMARY KEY,
                replies BOOLEAN DEFAULT TRUE,
                application_updates BOOLEAN DEFAULT TRUE,
                reminders BOOLEAN DEFAULT TRUE,
                digest BOOLEAN DEFAULT TRUE,
                marketing BOOLEAN DEFAULT TRUE,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await col(`ALTER TABLE application_history ADD COLUMN IF NOT EXISTS follow_up_reminded_at TIMESTAMP`);
        await col(`ALTER TABLE user_credits ADD COLUMN IF NOT EXISTS expiry_warned_at TIMESTAMP`);
        console.log('✅ Migration 019: notification_preferences + follow_up/expiry dedup columns done');

        // ── Migration 020: app_events.ip_hash — hashed client IP for install dedup (same person
        //    reinstalling on the same network counts as ONE install). Never stores the raw IP.
        await col(`ALTER TABLE app_events ADD COLUMN IF NOT EXISTS ip_hash TEXT`);
        console.log('✅ Migration 020: app_events.ip_hash done');

        // ── Migration 021: ai_grounding_cache — persistent cache for the PAID Google-Search-grounded
        //    Gemini calls (enumerate + per-job detail enrichment + per-job URL resolution). A cache
        //    HIT returns the EXACT payload a prior grounded call produced, so retries / duplicate runs /
        //    re-searches of the same employer reuse it instead of re-paying the grounding surcharge.
        //    Zero result impact: keyed on the same inputs, TTL'd; a miss just falls through to the live
        //    call. This is what protects the budget from a repeat of the July-2 bulk-load spend.
        await db.query(`
            CREATE TABLE IF NOT EXISTS ai_grounding_cache (
                cache_key TEXT PRIMARY KEY,
                kind TEXT,
                payload JSONB NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                expires_at TIMESTAMPTZ NOT NULL
            );
        `);
        await col(`CREATE INDEX IF NOT EXISTS idx_grounding_cache_expires ON ai_grounding_cache(expires_at)`);
        console.log('✅ Migration 021: ai_grounding_cache done');

        // ── Migration 022: admin_notification_settings — admin-only push alerts (new install /
        //    new registration / new purchase), each independently toggleable. Single-row config (id=1).
        await db.query(`
            CREATE TABLE IF NOT EXISTS admin_notification_settings (
                id INTEGER PRIMARY KEY DEFAULT 1,
                installs BOOLEAN DEFAULT TRUE,
                registrations BOOLEAN DEFAULT TRUE,
                purchases BOOLEAN DEFAULT TRUE,
                updated_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        await db.query(`INSERT INTO admin_notification_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
        console.log('✅ Migration 022: admin_notification_settings done');

        // ── Migration 023: global_jobs — a WORLD job feed populated by a background firehose from public
        //    company ATS boards (Greenhouse/Lever/Ashby/…). ISOLATED from the per-user `jobs` table so it
        //    can NEVER leak into a user's personalized Job Hub; a later phase surfaces it as a browse feed.
        //    Same rich shape as a native CVApplyr job. Upsert on job_url (last_seen refreshes on re-crawl).
        await db.query(`
            CREATE TABLE IF NOT EXISTS global_jobs (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                job_url VARCHAR(2000) UNIQUE NOT NULL,
                title VARCHAR(500) NOT NULL,
                employer_name VARCHAR(300),
                employer_domain VARCHAR(255),
                location VARCHAR(500),
                work_mode VARCHAR(50),
                job_type VARCHAR(120),
                salary VARCHAR(255),
                experience VARCHAR(255),
                responsibilities JSONB,
                skills JSONB,
                source VARCHAR(60),
                country VARCHAR(80),
                is_active BOOLEAN DEFAULT TRUE,
                first_seen TIMESTAMPTZ DEFAULT NOW(),
                last_seen TIMESTAMPTZ DEFAULT NOW(),
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        await col(`CREATE INDEX IF NOT EXISTS idx_global_jobs_last_seen ON global_jobs(last_seen DESC)`);
        await col(`CREATE INDEX IF NOT EXISTS idx_global_jobs_employer ON global_jobs(employer_name)`);
        await col(`CREATE INDEX IF NOT EXISTS idx_global_jobs_active ON global_jobs(is_active)`);
        console.log('✅ Migration 023: global_jobs done');

        // ── Migration 024: job taxonomy on global_jobs (deterministic field / role / seniority) ──
        // Lets the Explore feed scope to a user's field, filter by role category, and stay diverse.
        await col(`ALTER TABLE global_jobs ADD COLUMN IF NOT EXISTS field VARCHAR(60)`);
        await col(`ALTER TABLE global_jobs ADD COLUMN IF NOT EXISTS role_category VARCHAR(90)`);
        await col(`ALTER TABLE global_jobs ADD COLUMN IF NOT EXISTS seniority VARCHAR(30)`);
        await col(`CREATE INDEX IF NOT EXISTS idx_global_jobs_field ON global_jobs(field)`);
        await col(`CREATE INDEX IF NOT EXISTS idx_global_jobs_role_cat ON global_jobs(role_category)`);
        console.log('✅ Migration 024: global_jobs taxonomy done');

        // ── Migration 025: user_job_url_overrides.job_id UUID → TEXT (+ drop the jobs FK) ──────
        // Saved/live-search jobs use synthetic TEXT ids ("gj_…") that aren't rows in `jobs`, so the
        // UUID column + FK made URL overrides silently impossible for exactly the jobs that need a
        // corrected link most (e.g. a LinkedIn job's real company-portal apply URL). Same class of
        // bug as the job_cover_letters.job_id UUID fix.
        await col(`ALTER TABLE user_job_url_overrides DROP CONSTRAINT IF EXISTS user_job_url_overrides_job_id_fkey`);
        await col(`ALTER TABLE user_job_url_overrides ALTER COLUMN job_id TYPE TEXT USING job_id::text`);
        console.log('✅ Migration 025: user_job_url_overrides synthetic-id support done');

        // ── Migration 026: admin_notification_log — audit trail for admin-triggered notifications ──
        // Every push an admin fires (at one user or a whole segment) is written here BEFORE it can be
        // repeated: the 72h "never send the same template to the same user twice" rule reads this table,
        // and so does the per-user "what have we already sent them" panel. Skipped sends are logged too
        // (push_ok = FALSE + push_error = 'opted_out' | 'no_token' | 'stale_token' | 'send_failed') so a
        // silent non-delivery is impossible to miss. `params` also carries the deep-link jobUrl, which is
        // the cheap way back from a synthetic 'gj_…' job id to its global_jobs row.
        await col(`CREATE TABLE IF NOT EXISTS admin_notification_log (
            id SERIAL PRIMARY KEY,
            user_id INTEGER,
            template_key VARCHAR(60),
            title TEXT,
            body TEXT,
            route VARCHAR(80),
            params JSONB,
            sent_by INTEGER,
            batch_id VARCHAR(40),
            push_ok BOOLEAN,
            push_error TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )`);
        await col(`CREATE INDEX IF NOT EXISTS idx_admin_notif_log_user_tpl ON admin_notification_log(user_id, template_key, created_at DESC)`);
        await col(`CREATE INDEX IF NOT EXISTS idx_admin_notif_log_batch ON admin_notification_log(batch_id)`);
        // The 72h dedupe is a RESERVATION, not a check-then-act: adminUserOps.reserveSend inserts the
        // row with push_ok NULL ("in flight") BEFORE the push leaves, so two overlapping admin clicks
        // race on THIS index and exactly one of them wins — WHERE NOT EXISTS alone cannot decide it,
        // because both READ COMMITTED snapshots can see an empty table. The window itself cannot live
        // in the index (predicates must be IMMUTABLE, so NOW() is not allowed); the in-flight NULL
        // state is what makes the race decidable, and reserveSend expires abandoned reservations.
        await col(`CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_notif_log_inflight
                     ON admin_notification_log(user_id, template_key) WHERE push_ok IS NULL`);
        console.log('✅ Migration 026: admin_notification_log done');

        // ── Migration 027: in-app support (issue reports + 1:1 chat with staff) ──
        // A user picks what is going wrong from a short list of cards, optionally adds detail, and
        // that opens a thread. Admins get an instant push and answer in the same thread.
        //
        // Two columns exist purely to keep the hot queries cheap: last_message_at (so both inboxes
        // sort without touching support_messages) and the two unread counters (so a badge is a
        // column read, not a COUNT over every message ever sent). They are maintained on write.
        //
        // ON DELETE CASCADE on user_id is deliberate: when an account is really deleted, their
        // support history goes with it. Keeping a stranger's complaint after they have gone is not
        // a feature.
        await col(`CREATE TABLE IF NOT EXISTS support_threads (
            id               SERIAL PRIMARY KEY,
            user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            issue_key        VARCHAR(60) NOT NULL,
            subject          VARCHAR(200),
            status           VARCHAR(20) NOT NULL DEFAULT 'open',
            last_message_at  TIMESTAMPTZ DEFAULT NOW(),
            last_sender      VARCHAR(10),
            last_body        TEXT,
            user_unread      INTEGER NOT NULL DEFAULT 0,
            admin_unread     INTEGER NOT NULL DEFAULT 0,
            user_muted       BOOLEAN NOT NULL DEFAULT FALSE,
            created_at       TIMESTAMPTZ DEFAULT NOW(),
            updated_at       TIMESTAMPTZ DEFAULT NOW()
        )`);
        await col(`CREATE TABLE IF NOT EXISTS support_messages (
            id             BIGSERIAL PRIMARY KEY,
            thread_id      INTEGER NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
            sender         VARCHAR(10) NOT NULL,
            sender_user_id INTEGER,
            body           TEXT NOT NULL,
            created_at     TIMESTAMPTZ DEFAULT NOW()
        )`);
        // The user's own list, and the admin inbox. Both sort on last_message_at so neither has to
        // aggregate support_messages — the admin inbox query in particular must not be O(all
        // messages) on every paint.
        await col(`CREATE INDEX IF NOT EXISTS idx_support_threads_user
                     ON support_threads(user_id, last_message_at DESC)`);
        await col(`CREATE INDEX IF NOT EXISTS idx_support_threads_inbox
                     ON support_threads(status, last_message_at DESC)`);
        // Newest-first paging within one thread.
        await col(`CREATE INDEX IF NOT EXISTS idx_support_messages_thread
                     ON support_messages(thread_id, id DESC)`);
        // One OPEN thread per user per issue, so tapping the same card twice continues the
        // conversation instead of starting a second one an admin has to notice separately.
        await col(`CREATE UNIQUE INDEX IF NOT EXISTS uq_support_open_thread
                     ON support_threads(user_id, issue_key) WHERE status = 'open'`);
        console.log('✅ Migration 027: support_threads + support_messages done');

        // ── Migration 028: subscription plans + 7-day trial + usage ledger ──
        // Quota-based monetisation for the two paid AI features (cover letters, resume generation);
        // everything else becomes free. Legacy credit balances keep working as a fallback pool, so
        // this migration breaks nothing for existing users. Trial is ONE PER DEVICE: the app sends
        // a keychain-persisted device id, and trial_devices remembers which device already used its
        // trial — re-registering with a fresh email on the same phone does not reset it.
        await col(`CREATE TABLE IF NOT EXISTS user_subscriptions (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            plan_key TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            source TEXT NOT NULL DEFAULT 'admin',
            product_id TEXT,
            period_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            period_end TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
        await col(`CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user
                     ON user_subscriptions(user_id, status, period_end DESC)`);
        await col(`CREATE TABLE IF NOT EXISTS usage_ledger (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            source TEXT NOT NULL,
            plan_key TEXT,
            detail JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
        await col(`CREATE INDEX IF NOT EXISTS idx_usage_ledger_user
                     ON usage_ledger(user_id, kind, source, created_at DESC)`);
        await col(`CREATE TABLE IF NOT EXISTS user_trials (
            user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            device_id TEXT,
            started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            ends_at TIMESTAMPTZ NOT NULL
        )`);
        await col(`CREATE TABLE IF NOT EXISTS trial_devices (
            device_id TEXT PRIMARY KEY,
            first_user_id INTEGER,
            ip_hash TEXT,
            trial_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
        await col(`CREATE TABLE IF NOT EXISTS user_devices (
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            device_id TEXT NOT NULL,
            ip_hash TEXT,
            first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (user_id, device_id)
        )`);
        // Everything except the two gated generations becomes free. TRULY one-time: a marker row
        // (is_active=0, never shown as a cost) records that the flip ran, so an admin who later
        // re-prices any of these keeps their value on every subsequent boot.
        await col(`UPDATE ai_event_costs SET credits = 0
                     WHERE event_key IN ('company_search','ai_search','live_fetch',
                                         'cover_letter_download','resume_download',
                                         'find_recruiters','find_recruiter_emails')
                       AND NOT EXISTS (SELECT 1 FROM ai_event_costs WHERE event_key = 'm028_free_flip_done')`);
        await col(`INSERT INTO ai_event_costs (event_key, label, credits, category, sort_order, description, is_active)
                     VALUES ('m028_free_flip_done', 'migration marker', 0, 'free', 999, 'Migration 028 free-flip already applied — do not delete.', 0)
                     ON CONFLICT (event_key) DO NOTHING`);
        console.log('✅ Migration 028: subscriptions + trial + usage ledger done');

        // ── Migration 029: location-based job interests (the redesigned Jobs tab) ──
        // A card = a place + skills the user cares about. The demand-research routine walks these
        // twice a day to research the live web for exactly this demand and feed global_jobs.
        await col(`CREATE TABLE IF NOT EXISTS user_job_interests (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            label TEXT,
            country TEXT NOT NULL,
            city TEXT,
            skills JSONB NOT NULL DEFAULT '[]'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
        await col(`CREATE INDEX IF NOT EXISTS idx_user_job_interests_user
                     ON user_job_interests(user_id, created_at DESC)`);
        console.log('✅ Migration 029: user_job_interests done');

        // ── Migration 030: exact-job URL on interests ──
        // An interest can carry a specific posting URL ("fetch just this job"): the URL is ingested
        // into global_jobs once and always tops that interest's card. URL-only interests exist too,
        // so country loosens to nullable (the research routine already skips skill-less rows).
        await col(`ALTER TABLE user_job_interests ADD COLUMN IF NOT EXISTS job_url TEXT`);
        await col(`ALTER TABLE user_job_interests ALTER COLUMN country DROP NOT NULL`);
        console.log('✅ Migration 030: interest job_url done');

        // ── Migration 031: admin kill switches for user-facing scheduled pushes ──
        // Keyed, not fixed-column: new notification categories only need a registry entry in
        // notifSwitch.js. A missing row = ON.
        await col(`CREATE TABLE IF NOT EXISTS user_notification_switches (
            key TEXT PRIMARY KEY,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
        console.log('✅ Migration 031: user_notification_switches done');

        // ── Migration 032: lifecycle nudges — the shared send ledger + bonus quota ──
        // user_nudge_log is the ONE place every automated nudge records itself. Before this there
        // were three incompatible dedupe mechanisms (a flag column on the domain row, a 20h window
        // over `notifications`, and rewardNudges' own table), so nothing could answer "has this
        // person had enough notifications this week?" — which is exactly the question that keeps us
        // from irritating people. `attempt` drives the escalating backoff and `responded_at` records
        // whether the user actually opened the app afterwards, so a silent user gets left alone.
        await col(`CREATE TABLE IF NOT EXISTS user_nudge_log (
            id BIGSERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL,
            nudge_key TEXT NOT NULL,
            attempt INTEGER NOT NULL DEFAULT 1,
            sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            push_ok BOOLEAN,
            skipped TEXT,
            incentive TEXT,
            responded_at TIMESTAMPTZ
        )`);
        await col(`CREATE INDEX IF NOT EXISTS idx_user_nudge_log_user ON user_nudge_log(user_id, sent_at DESC)`);
        await col(`CREATE INDEX IF NOT EXISTS idx_user_nudge_log_key ON user_nudge_log(user_id, nudge_key, sent_at DESC)`);

        // quota_grants — the missing half of "here are 3 free cover letters". usage_ledger counts
        // CONSUMPTION only (one row = one unit used, no amount column), and the trial/plan allowances
        // are constants in entitlements.js, so until now there was literally nowhere to put a bonus.
        // kind 'trial_days' records an ends_at extension so the same idem_key guard covers it.
        await col(`CREATE TABLE IF NOT EXISTS quota_grants (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            amount INTEGER NOT NULL,
            source TEXT NOT NULL DEFAULT 'nudge',
            idem_key TEXT NOT NULL,
            note TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (user_id, idem_key)
        )`);
        await col(`CREATE INDEX IF NOT EXISTS idx_quota_grants_user ON quota_grants(user_id, kind, created_at DESC)`);

        // The per-user frequency cap reads `notifications` by (user_id, type, created_at) on every
        // candidate. Only (user_id) and (created_at DESC) existed, so that was a scan per user.
        await col(`CREATE INDEX IF NOT EXISTS idx_notifications_user_type_created
                     ON notifications(user_id, type, created_at DESC)`);
        console.log('✅ Migration 032: user_nudge_log + quota_grants done');

        console.log('✅ PostgreSQL migrations completed successfully');
    } catch (error) {
        console.error('⚠️ Migration warning:', error.message);
        // Don't fail if migrations have issues, just warn
    }
}

module.exports = { initializeDatabase };
