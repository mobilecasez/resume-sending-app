# Payment Issue - Technical Overview for Gemini AI

## 🎯 Problem Statement

**Issue**: Payment flow creates Razorpay order successfully, but then returns 404 "Order not found" when checking status.

**Error Logs from Latest Test**:
```
✅ Payment initiated successfully
✅ Razorpay order created: order_SA3UYMc8h9q9Oy
✅ Checkout opened
❌ Status check fails: 404 {"error":"Order not found"}
```

**Chronology**:
1. User clicks "Buy Plan" button
2. ✅ Order created in Razorpay: `order_SA3UYMc8h9q9Oy`
3. ✅ Razorpay checkout opens
4. ✅ User completes payment
5. ✅ User closes browser
6. ❌ App checks status: `GET /api/payment/status/order_SA3UYMc8h9q9Oy`
7. ❌ Backend returns: `404 Order not found`

**Critical Finding**: Order exists in Razorpay but NOT in local PostgreSQL database

---

## 🏗️ Technology Stack

### Backend
- **Framework**: Node.js with Express.js
- **Server File**: `server.js` (main application, ~8600 lines)
- **Port**: 3000
- **Current IP**: 192.168.1.22:3000
- **Database**: PostgreSQL
  - Database: `lettrico`
  - User: `rishi`
  - Password: `postgres`
  - Key Tables: `users`, `plans`, `payment_orders`, `credit_transactions`

### Mobile App
- **Framework**: React Native with Expo SDK 54
- **Main File**: `MobileApp/App.js` (8331 lines, single-file architecture)
- **Port**: 8081 (Expo Metro Bundler)
- **Expo URL**: `exp://192.168.1.22:8081`

### Payment Gateway
- **Provider**: Razorpay
- **Mode**: Test Mode
- **Test Key ID**: `rzp_test_S9PR879EO7KgGN`
- **Test Secret**: `Mvoa8ygGWxcU21cPxKdpMXJ4` (stored in `.env.razorpay`)
- **Currency Limitation**: Test mode only supports INR
- **Solution**: Display USD in UI, convert to INR (rate 83:1) server-side

---

## 💻 Current Code Implementation

### Mobile App - Create Order Request

**File**: `MobileApp/App.js` (Lines ~3478-3520)

```javascript
// Step 1: Fetch user profile for email/phone
await fetchProfileData();
const userEmail = profileData?.email || user?.email;
const userPhone = profileData?.phone?.replace(/[^0-9]/g, '');

console.log('🔍 Payment initiated - Email:', userEmail, 'Phone:', userPhone);

// Step 2: Create payment order via backend
const response = await fetch(`${API_BASE}/payment/create-order`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${user.token}`
  },
  body: JSON.stringify({
    planId: pkg.id,           // Changed from packageId to planId (recent fix)
    amount: parseFloat(pkg.amount),
    currency: pkg.currency || 'USD'
  })
});

if (!response.ok) {
  const error = await response.json();
  throw new Error(error.error || 'Failed to create order');
}

const orderData = await response.json();
console.log('✅ Order created:', orderData);

// Step 3: Open Razorpay checkout
const razorpayUrl = orderData.razorpayUrl;
const result = await WebBrowser.openBrowserAsync(razorpayUrl);

// Step 4: Check payment status after browser closes
if (result.type === 'dismiss' || result.type === 'cancel') {
  await checkPaymentStatus(orderData.orderId);
}
```

**Recent Logs**:
```
LOG  🔍 Payment initiated - Email: samrishi24@gmail.com Phone: 919970020596
LOG  💳 Opening checkout - Email: samrishi24@gmail.com | Phone: 919970020596
LOG  🔍 Checking payment status for order: order_SA3UYMc8h9q9Oy
ERROR ❌ Status endpoint error: 404 {"error":"Order not found"}
```

---

### Backend - Create Order Endpoint

**File**: `server.js` (Lines 4510-4595)

```javascript
app.post('/api/payment/create-order', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { planId, amount, currency } = req.body;

    console.log('💳 Create Order Request:', { userId, planId, amount, currency });

    // Query database for plan
    const result = await dbConfig.query(
      'SELECT * FROM plans WHERE id = $1 AND is_active = true',
      [planId]
    );

    if (result.rows.length === 0) {
      console.error('❌ Plan not found:', planId);
      return res.status(404).json({ error: 'Package not found or inactive' });
    }

    const actualPlan = result.rows[0];
    console.log('✅ Found plan:', actualPlan.name);

    // Convert USD to INR (Razorpay test mode requirement)
    const USD_TO_INR_RATE = 83;
    const amountInINR = currency === 'USD' 
      ? Math.round(amount * USD_TO_INR_RATE) 
      : amount;

    console.log('💰 Amount conversion:', { 
      original: amount, 
      currency, 
      inr: amountInINR 
    });

    // Create Razorpay order
    const razorpayOrder = await razorpayInstance.orders.create({
      amount: amountInINR * 100,  // Razorpay uses paise
      currency: 'INR',
      receipt: `receipt_${userId}_${Date.now()}`,
      notes: {
        userId: userId,
        planId: planId,
        originalAmount: amount,
        originalCurrency: currency
      }
    });

    console.log('✅ Razorpay order created:', razorpayOrder.id);

    // ⚠️ CRITICAL: Store order in database
    const insertResult = await dbConfig.query(
      `INSERT INTO payment_orders 
       (order_id, user_id, plan_id, amount, currency, status, razorpay_order_id, created_at) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) 
       RETURNING *`,
      [
        razorpayOrder.id,
        userId,
        planId,
        amount,
        currency || 'USD',
        'created',
        razorpayOrder.id
      ]
    );

    console.log('✅ Order saved to database:', insertResult.rows[0]);

    // Build Razorpay checkout URL with prefilled data
    const razorpayUrl = `https://api.razorpay.com/v1/checkout/embedded?
key_id=${razorpayKeyId}&
order_id=${razorpayOrder.id}&
name=Resume App&
prefill[name]=${encodeURIComponent(req.user.fullName || 'User')}&
prefill[email]=${encodeURIComponent(userEmail || '')}&
prefill[contact]=${encodeURIComponent(userPhone || '')}`.replace(/\s+/g, '');

    res.json({
      success: true,
      orderId: razorpayOrder.id,
      amount: amountInINR,
      currency: 'INR',
      razorpayUrl: razorpayUrl
    });

  } catch (error) {
    console.error('❌ Create order error:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to create payment order' 
    });
  }
});
```

---

### Backend - Payment Status Endpoint

**File**: `server.js` (Lines 4710-4820)

```javascript
app.get('/api/payment/status/:orderId', authenticateToken, async (req, res) => {
  try {
    const { orderId } = req.params;
    const userId = req.user.id;

    console.log('🔍 Checking payment status:', { orderId, userId });

    // Query database for order
    const result = await dbConfig.query(
      'SELECT * FROM payment_orders WHERE order_id = $1 AND user_id = $2',
      [orderId, userId]
    );

    // ❌ THIS IS WHERE IT FAILS - No rows found
    if (result.rows.length === 0) {
      console.error('❌ Order not found in database:', orderId);
      return res.status(404).json({ error: 'Order not found' });
    }

    const dbOrder = result.rows[0];
    console.log('✅ Found order in database:', dbOrder);

    // If already completed, return immediately
    if (dbOrder.status === 'completed') {
      return res.json({
        status: 'completed',
        credits: dbOrder.credits_added,
        message: 'Payment already verified'
      });
    }

    // Query Razorpay API for payment details
    if (razorpayInstance) {
      try {
        const razorpayOrder = await razorpayInstance.orders.fetch(orderId);
        console.log('📊 Razorpay order status:', razorpayOrder.status);

        // Check if payment was captured
        if (razorpayOrder.status === 'paid' || razorpayOrder.amount_paid > 0) {
          const payments = await razorpayInstance.orders.fetchPayments(orderId);
          const successfulPayment = payments.items.find(p => p.status === 'captured');

          if (successfulPayment) {
            console.log('✅ Payment captured, auto-verifying...');

            // Update database
            await dbConfig.query(
              `UPDATE payment_orders 
               SET status = 'completed', 
                   payment_id = $1, 
                   updated_at = NOW() 
               WHERE order_id = $2`,
              [successfulPayment.id, orderId]
            );

            // Add credits to user
            const credits = dbOrder.plan_id === 1 ? 10 
                          : dbOrder.plan_id === 2 ? 30 
                          : dbOrder.plan_id === 3 ? 100 
                          : dbOrder.plan_id === 4 ? 500 
                          : 0;

            await dbConfig.query(
              'UPDATE users SET credits = credits + $1 WHERE id = $2',
              [credits, userId]
            );

            // Record transaction
            await dbConfig.query(
              `INSERT INTO credit_transactions 
               (user_id, credits, transaction_type, reference_id, created_at) 
               VALUES ($1, $2, 'purchase', $3, NOW())`,
              [userId, credits, orderId]
            );

            console.log(`✅ Added ${credits} credits to user ${userId}`);

            return res.json({
              status: 'completed',
              credits: credits,
              auto_verified: true,
              message: 'Payment verified and credits added'
            });
          }
        }
      } catch (razorpayError) {
        console.error('⚠️ Razorpay API error:', razorpayError);
      }
    }

    // Return current status if not verified
    res.json({
      status: dbOrder.status,
      message: 'Payment pending verification'
    });

  } catch (error) {
    console.error('❌ Status check error:', error);
    res.status(500).json({ error: error.message });
  }
});
```

---

## 🔍 Root Cause Analysis

### The Problem

1. **Mobile app receives order ID** from create-order endpoint: `order_SA3UYMc8h9q9Oy`
2. **This order exists in Razorpay** (confirmed by the ID format and checkout opening)
3. **But database query returns 0 rows** when checking `payment_orders` table
4. **Therefore**: Order is NOT being inserted into database during creation

### Why Order Insert Might Fail

#### Theory 1: Database Insert Fails Silently
```javascript
const insertResult = await dbConfig.query(
  `INSERT INTO payment_orders (...) VALUES (...) RETURNING *`,
  [razorpayOrder.id, userId, planId, amount, currency, 'created', razorpayOrder.id]
);
```

**Possible causes**:
- Database constraint violation (unique key, foreign key)
- Column type mismatch
- NULL constraint violation
- Transaction rollback

**Missing**: No try-catch around database insert, errors might be swallowed

#### Theory 2: Response Sent Before Database Commit
```javascript
// Insert into database
await dbConfig.query('INSERT INTO payment_orders ...');

// Immediately return response
res.json({ orderId: razorpayOrder.id });
```

If database uses transactions, commit might not have happened before response is sent.

#### Theory 3: Database Connection Issue
- `dbConfig` might not be properly configured
- Connection pool exhausted
- Database not accessible from backend

---

## 🔧 Diagnostic Steps Needed

### 1. Add Comprehensive Logging to Create Order

```javascript
app.post('/api/payment/create-order', authenticateToken, async (req, res) => {
  try {
    // ... existing code ...

    // Log BEFORE database insert
    console.log('📝 About to insert into database:', {
      orderId: razorpayOrder.id,
      userId,
      planId,
      amount,
      currency
    });

    try {
      const insertResult = await dbConfig.query(
        `INSERT INTO payment_orders 
         (order_id, user_id, plan_id, amount, currency, status, razorpay_order_id) 
         VALUES ($1, $2, $3, $4, $5, $6, $7) 
         RETURNING *`,
        [razorpayOrder.id, userId, planId, amount, currency, 'created', razorpayOrder.id]
      );
      
      console.log('✅ Database insert successful:', insertResult.rows[0]);
      console.log('✅ Inserted rows:', insertResult.rowCount);
      
    } catch (dbError) {
      console.error('❌ DATABASE INSERT FAILED:', dbError);
      console.error('   Error code:', dbError.code);
      console.error('   Error detail:', dbError.detail);
      console.error('   Error constraint:', dbError.constraint);
      throw dbError;  // Re-throw to be caught by outer catch
    }

    // ... rest of code ...
  } catch (error) {
    console.error('❌ FULL ERROR:', error);
    res.status(500).json({ error: error.message });
  }
});
```

### 2. Verify Database Schema

Check `payment_orders` table structure:

```sql
-- Show table structure
\d payment_orders

-- Check constraints
SELECT conname, contype, pg_get_constraintdef(oid) 
FROM pg_constraint 
WHERE conrelid = 'payment_orders'::regclass;

-- Check if table exists
SELECT EXISTS (
  SELECT FROM information_schema.tables 
  WHERE table_name = 'payment_orders'
);
```

### 3. Check Database Permissions

```sql
-- Check user permissions
SELECT has_table_privilege('rishi', 'payment_orders', 'INSERT');
SELECT has_table_privilege('rishi', 'payment_orders', 'SELECT');
```

### 4. Verify Database Connection

Add to server startup:

```javascript
// Test database connection on startup
dbConfig.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('❌ Database connection failed:', err);
  } else {
    console.log('✅ Database connected at:', res.rows[0].now);
  }
});

// Test payment_orders table
dbConfig.query('SELECT COUNT(*) FROM payment_orders', (err, res) => {
  if (err) {
    console.error('❌ Cannot access payment_orders table:', err);
  } else {
    console.log('✅ payment_orders table has', res.rows[0].count, 'rows');
  }
});
```

### 5. Manual Database Insert Test

Try manually inserting an order:

```sql
INSERT INTO payment_orders 
(order_id, user_id, plan_id, amount, currency, status, razorpay_order_id, created_at) 
VALUES 
('test_order_123', 1, 1, 4.99, 'USD', 'created', 'test_order_123', NOW());

-- Check if it was inserted
SELECT * FROM payment_orders WHERE order_id = 'test_order_123';
```

---

## 📊 Database Schema

### payment_orders Table (Expected Structure)

```sql
CREATE TABLE payment_orders (
  id SERIAL PRIMARY KEY,
  order_id VARCHAR(255) UNIQUE NOT NULL,  -- Razorpay order ID
  user_id INTEGER REFERENCES users(id),
  plan_id INTEGER REFERENCES plans(id),
  amount DECIMAL(10,2) NOT NULL,
  currency VARCHAR(3) DEFAULT 'USD',
  status VARCHAR(50) DEFAULT 'created',  -- created, completed, failed
  payment_id VARCHAR(255),  -- Razorpay payment ID (after capture)
  razorpay_order_id VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

### plans Table (Confirmed Data)

```sql
-- Verified existing plans
id | name         | credits | price  | is_active
---|--------------|---------|--------|----------
1  | Starter      | 10      | 4.99   | true
2  | Professional | 30      | 12.99  | true
3  | Premium      | 100     | 34.99  | true
4  | Enterprise   | 500     | 149.99 | true
```

---

## 🚨 Recent Fixes Applied

### Fix #1: Parameter Name Mismatch (COMPLETED ✅)
**Issue**: Mobile sent `packageId`, backend expected `planId`
**Solution**: Changed `MobileApp/App.js` line 3490 from `packageId` to `planId`
**Status**: Fixed, verified in logs

### Fix #2: Missing Currency Parameter (COMPLETED ✅)
**Issue**: Currency not being sent to backend
**Solution**: Added `currency: pkg.currency || 'USD'` to request body
**Status**: Fixed

### Fix #3: Backend Consistency (COMPLETED ✅)
**Issue**: Backend had mixed parameter names
**Solution**: Standardized to use `planId` throughout
**Status**: Fixed, servers restarted

---

## ❓ Questions for Gemini

1. **Why would database insert fail silently?**
   - Order ID is returned successfully
   - No error in console logs
   - But order not in database

2. **Should we add transaction handling?**
   ```javascript
   await dbConfig.query('BEGIN');
   try {
     await dbConfig.query('INSERT INTO payment_orders ...');
     await dbConfig.query('COMMIT');
   } catch (error) {
     await dbConfig.query('ROLLBACK');
     throw error;
   }
   ```

3. **Is there a better pattern for this flow?**
   - Create database record FIRST
   - Then create Razorpay order
   - Update database with Razorpay details
   - This ensures database always has record

4. **How to debug PostgreSQL INSERT failures?**
   - What logging should be added?
   - How to check for constraint violations?
   - How to ensure transaction commits?

5. **Alternative approaches?**
   - Use Razorpay webhooks instead of polling?
   - Store orders in Razorpay only, query their API?
   - Different database strategy?

---

## 🎯 Desired Solution

**Goal**: When user completes payment, credits should be automatically added.

**Current Flow (Broken)**:
1. Create order in Razorpay ✅
2. Store order in database ❌ (Fails silently)
3. Open checkout ✅
4. User pays ✅
5. Check status ❌ (404 because no database record)

**Expected Flow**:
1. Create order in Razorpay ✅
2. Store order in database ✅
3. Open checkout ✅
4. User pays ✅
5. Check status ✅ (Found in database)
6. Query Razorpay API ✅
7. Verify payment ✅
8. Add credits ✅
9. Show success ✅

---

## 📁 Files to Review

### Critical Files
1. **server.js** (Lines 4510-4820) - Payment endpoints
2. **MobileApp/App.js** (Lines 3470-3650) - Mobile payment flow
3. **Database schema** - payment_orders table structure

### Configuration Files
1. **.env.razorpay** - Razorpay credentials
2. **server.js** - Database configuration (dbConfig)
3. **MobileApp/app.json** - API URL configuration

---

## 🔗 Additional Context

### Network Configuration
- Backend accessible at: `http://192.168.1.22:3000`
- Mobile API configured: `http://192.168.1.22:3000/api`
- Both on same network, connectivity verified

### Test User
- Email: samrishi24@gmail.com
- User ID: 1
- Current credits: 0

### Razorpay Test Card
- Card: 4111 1111 1111 1111
- CVV: Any 3 digits
- Expiry: Any future date
- Always succeeds in test mode

---

## 💡 Immediate Help Needed

**Primary Question**: Why is the database INSERT not working despite no visible errors?

**Secondary Questions**:
1. How to add proper error handling for database operations?
2. Should we use transactions for this flow?
3. Is there a race condition between response and database commit?
4. How to ensure database operations complete before returning response?

**What We Need**:
- Identify why INSERT fails silently
- Add proper error handling
- Ensure orders are stored in database
- Make payment verification work end-to-end

Thank you! 🙏
