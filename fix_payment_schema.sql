-- Fix payment_orders table schema
-- Ensures all columns exist with correct names

-- 1. Create table if it doesn't exist
CREATE TABLE IF NOT EXISTS payment_orders (
    id SERIAL PRIMARY KEY,
    order_id VARCHAR(255) UNIQUE NOT NULL,
    user_id INTEGER REFERENCES users(id),
    plan_id INTEGER REFERENCES plans(id),
    amount DECIMAL(10,2),
    currency VARCHAR(10) DEFAULT 'USD',
    status VARCHAR(50) DEFAULT 'created',
    payment_id VARCHAR(255),
    razorpay_order_id VARCHAR(255),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 2. Add missing columns if they don't exist
ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS plan_id INTEGER;
ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS razorpay_order_id VARCHAR(255);
ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

-- 3. Show current schema
SELECT column_name, data_type, is_nullable 
FROM information_schema.columns 
WHERE table_name = 'payment_orders' 
ORDER BY ordinal_position;
