CREATE TABLE users (
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
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        , date_of_birth DATE, phone_number TEXT, address TEXT, city TEXT, country TEXT, zipcode TEXT, notifications_enabled INTEGER DEFAULT 1, data_collection_enabled INTEGER DEFAULT 0, oauth_provider TEXT, google_access_token TEXT, google_refresh_token TEXT, total_generated INTEGER DEFAULT 0, total_sent INTEGER DEFAULT 0, role TEXT DEFAULT 'user');
CREATE TABLE sqlite_sequence(name,seq);
CREATE TABLE recipients (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            email TEXT NOT NULL,
            website TEXT NOT NULL,
            position TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            UNIQUE(user_id, email)
        );
CREATE TABLE application_history (
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
        );
CREATE TABLE review_cover_letters (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            letter_key TEXT NOT NULL,
            company_name TEXT,
            recipient_email TEXT,
            cover_letter_html TEXT,
            generated INTEGER DEFAULT 0,
            sent INTEGER DEFAULT 0,
            sent_date DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, subject TEXT, address TEXT, date TEXT, position TEXT, locations TEXT, stored_recipient_email TEXT, stored_recipient_website TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            UNIQUE(user_id, letter_key)
        );
CREATE TABLE credit_usage_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            credits_used INTEGER DEFAULT 1,
            action_type TEXT NOT NULL,
            company_name TEXT,
            position TEXT,
            recipient_email TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
CREATE TABLE monthly_usage_stats (
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
        );
CREATE TABLE plans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            credits INTEGER NOT NULL,
            price REAL NOT NULL,
            validity_days INTEGER NOT NULL,
            description TEXT,
            features TEXT,
            is_active INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
CREATE TABLE user_credits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL UNIQUE,
            credits_remaining INTEGER DEFAULT 0,
            credits_total INTEGER DEFAULT 0,
            last_purchase_date DATETIME,
            expiry_date DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
CREATE TABLE credit_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    transaction_type TEXT NOT NULL,
    credits_change INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    description TEXT,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE TABLE credit_packages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    amount REAL NOT NULL,
    credits INTEGER NOT NULL,
    validity_days INTEGER NOT NULL,
    description TEXT,
    currency TEXT DEFAULT 'USD',
    is_active INTEGER DEFAULT 1,
    is_popular INTEGER DEFAULT 0,
    display_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
