-- PostgreSQL Schema for CV Applyr
-- This schema is PostgreSQL-compatible version of the SQLite schema

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
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
    microsoft_access_token TEXT,
    microsoft_refresh_token TEXT,
    used_pkce BOOLEAN DEFAULT FALSE,
    total_generated INTEGER DEFAULT 0,
    total_sent INTEGER DEFAULT 0,
    role TEXT DEFAULT 'user',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Recipients table
CREATE TABLE IF NOT EXISTS recipients (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    email TEXT NOT NULL,
    website TEXT NOT NULL,
    position TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, email)
);

-- Application history table
CREATE TABLE IF NOT EXISTS application_history (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    company_name TEXT NOT NULL,
    position TEXT NOT NULL,
    recipient_email TEXT NOT NULL,
    sent_date TIMESTAMP NOT NULL,
    reply_received INTEGER DEFAULT 0,
    reply_date TIMESTAMP,
    reply_subject TEXT,
    reply_snippet TEXT,
    reply_from_email TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Application reply history table (stores each individual reply)
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

-- Review cover letters table
CREATE TABLE IF NOT EXISTS review_cover_letters (
    id SERIAL PRIMARY KEY,
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
    sent_date TIMESTAMP,
    stored_recipient_email TEXT,
    stored_recipient_website TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, letter_key)
);

-- Plans table
CREATE TABLE IF NOT EXISTS plans (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    credits INTEGER NOT NULL,
    price DECIMAL(10,2) NOT NULL,
    validity_days INTEGER NOT NULL,
    description TEXT,
    features TEXT,
    is_active INTEGER DEFAULT 1,
    is_popular INTEGER DEFAULT 0,
    display_order INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- User credits table
CREATE TABLE IF NOT EXISTS user_credits (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL UNIQUE,
    credits_remaining INTEGER DEFAULT 0,
    credits_total INTEGER DEFAULT 0,
    last_purchase_date TIMESTAMP,
    expiry_date TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Credit transactions table
CREATE TABLE IF NOT EXISTS credit_transactions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    transaction_type TEXT NOT NULL,
    credits_change INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    description TEXT,
    metadata TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Payment orders table for Razorpay transactions
CREATE TABLE IF NOT EXISTS payment_orders (
    id SERIAL PRIMARY KEY,
    order_id TEXT NOT NULL UNIQUE,
    payment_id TEXT,
    signature TEXT,
    user_id INTEGER NOT NULL,
    package_id INTEGER NOT NULL,
    plan_id INTEGER,
    amount NUMERIC(10, 2) NOT NULL,
    currency TEXT DEFAULT 'INR',
    status TEXT DEFAULT 'created',
    razorpay_order_id TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (package_id) REFERENCES plans(id) ON DELETE CASCADE
);

-- Monthly usage stats table
CREATE TABLE IF NOT EXISTS monthly_usage_stats (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    month INTEGER NOT NULL,
    year INTEGER NOT NULL,
    credits_used INTEGER DEFAULT 0,
    letters_generated INTEGER DEFAULT 0,
    letters_sent INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, month, year)
);

-- Credit usage history table
CREATE TABLE IF NOT EXISTS credit_usage_history (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    credits_used INTEGER DEFAULT 1,
    action_type TEXT NOT NULL,
    company_name TEXT,
    position TEXT,
    recipient_email TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Notifications table
CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    type VARCHAR(50) NOT NULL,
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    details TEXT,
    metadata TEXT,
    is_read INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Insert default plans
INSERT INTO plans (name, credits, price, validity_days, description, features)
VALUES 
    ('Starter', 10, 4.99, 30, 'Perfect for getting started', '["10 cover letters", "30 days validity", "AI-powered generation", "Email support"]'),
    ('Professional', 30, 12.99, 30, 'Best for active job seekers', '["30 cover letters", "30 days validity", "AI-powered generation", "Priority support", "Advanced customization"]'),
    ('Premium', 100, 34.99, 90, 'Maximum value for serious professionals', '["100 cover letters", "90 days validity", "AI-powered generation", "Priority support", "Advanced customization", "Extended validity"]'),
    ('Enterprise', 500, 149.99, 365, 'Ultimate plan for power users', '["500 cover letters", "365 days validity", "AI-powered generation", "Dedicated support", "All features included", "Annual validity"]')
ON CONFLICT (name) DO NOTHING;

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_recipients_user_id ON recipients(user_id);
CREATE INDEX IF NOT EXISTS idx_application_history_user_id ON application_history(user_id);
CREATE INDEX IF NOT EXISTS idx_review_cover_letters_user_id ON review_cover_letters(user_id);
CREATE INDEX IF NOT EXISTS idx_credit_transactions_user_id ON credit_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_orders_user_id ON payment_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_orders_order_id ON payment_orders(order_id);
CREATE INDEX IF NOT EXISTS idx_monthly_usage_stats_user_id ON monthly_usage_stats(user_id);
CREATE INDEX IF NOT EXISTS idx_credit_usage_history_user_id ON credit_usage_history(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);
