# Credits & Subscription System Implementation Guide

## Overview
This document provides a complete guide to the newly implemented credits-based subscription system for the Lettrico mobile application. This system replaces the unlimited generation model with a credit-based approach suitable for monetization.

---

## System Architecture

### Credits Model
- **1 Credit = 1 Cover Letter Generation**
- Credits are purchased through subscription plans
- Each plan has a validity period (30, 90, or 365 days)
- Unused credits expire at the end of the validity period
- Credits are deducted only after successful generation

### Database Schema

#### 1. `plans` Table
Stores available subscription plans.

```sql
CREATE TABLE plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    credits INTEGER NOT NULL,
    price REAL NOT NULL,
    validity_days INTEGER NOT NULL,
    description TEXT,
    features TEXT,  -- JSON array of features
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

**Default Plans:**
- **Starter**: 10 credits, $4.99, 30 days
- **Professional**: 30 credits, $12.99, 30 days (Most Popular)
- **Premium**: 100 credits, $34.99, 90 days
- **Enterprise**: 500 credits, $149.99, 365 days

#### 2. `user_credits` Table
Tracks each user's current credit balance.

```sql
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
)
```

#### 3. `credit_transactions` Table
Stores all credit purchase transactions.

```sql
CREATE TABLE credit_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    plan_id INTEGER NOT NULL,
    credits_purchased INTEGER NOT NULL,
    amount_paid REAL NOT NULL,
    transaction_status TEXT DEFAULT 'completed',
    transaction_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    valid_from DATETIME NOT NULL,
    valid_until DATETIME NOT NULL,
    payment_method TEXT,
    transaction_id TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (plan_id) REFERENCES plans(id)
)
```

#### 4. `monthly_usage_stats` Table
Tracks monthly usage statistics per user.

```sql
CREATE TABLE monthly_usage_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    month INTEGER NOT NULL,  -- 1-12
    year INTEGER NOT NULL,
    credits_used INTEGER DEFAULT 0,
    letters_generated INTEGER DEFAULT 0,
    letters_sent INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, month, year)
)
```

#### 5. `credit_usage_history` Table
Detailed log of every credit usage.

```sql
CREATE TABLE credit_usage_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    credits_used INTEGER DEFAULT 1,
    action_type TEXT NOT NULL,  -- 'cover_letter_generation'
    company_name TEXT,
    position TEXT,
    recipient_email TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
)
```

---

## Backend API Endpoints

### 1. Get Available Plans
**GET** `/api/plans`

Returns all active subscription plans.

**Response:**
```json
{
  "success": true,
  "plans": [
    {
      "id": 1,
      "name": "Starter",
      "credits": 10,
      "price": 4.99,
      "validity_days": 30,
      "description": "Perfect for getting started",
      "features": ["10 cover letters", "30 days validity", "AI-powered generation"],
      "is_active": 1
    }
  ]
}
```

### 2. Get User Credit Balance
**GET** `/api/user/credits`

Returns user's current credit balance and expiry information.

**Headers:**
- `Authorization: Bearer <token>`

**Response:**
```json
{
  "success": true,
  "credits": {
    "remaining": 25,
    "total": 30,
    "lastPurchaseDate": "2026-01-20T10:00:00.000Z",
    "expiryDate": "2026-02-20T10:00:00.000Z",
    "isExpired": false
  }
}
```

### 3. Purchase Credits
**POST** `/api/purchase-credits`

Purchase a subscription plan (currently simulated).

**Headers:**
- `Authorization: Bearer <token>`

**Body:**
```json
{
  "planId": 2,
  "paymentMethod": "simulated",
  "transactionId": "TXN-1234567890"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Credits purchased successfully",
  "credits": {
    "remaining": 30,
    "total": 30,
    "expiryDate": "2026-02-20T10:00:00.000Z"
  }
}
```

### 4. Get Usage Statistics
**GET** `/api/user/usage-stats?months=6`

Returns monthly usage statistics.

**Headers:**
- `Authorization: Bearer <token>`

**Query Parameters:**
- `months` (optional): Number of months to retrieve (default: 6)

**Response:**
```json
{
  "success": true,
  "currentMonth": {
    "month": 1,
    "year": 2026,
    "creditsUsed": 5,
    "lettersGenerated": 5,
    "lettersSent": 3
  },
  "credits": {
    "remaining": 25,
    "total": 30,
    "expiryDate": "2026-02-20T10:00:00.000Z"
  },
  "history": [
    {
      "month": 12,
      "year": 2025,
      "credits_used": 10,
      "letters_generated": 10,
      "letters_sent": 8
    }
  ]
}
```

### 5. Get Credit Usage History
**GET** `/api/user/credit-history?limit=50`

Returns detailed credit usage history.

**Headers:**
- `Authorization: Bearer <token>`

**Query Parameters:**
- `limit` (optional): Number of records (default: 50)

**Response:**
```json
{
  "success": true,
  "history": [
    {
      "id": 1,
      "credits_used": 1,
      "action_type": "cover_letter_generation",
      "company_name": "Google",
      "position": "Software Engineer",
      "recipient_email": "hr@google.com",
      "created_at": "2026-01-22T14:30:00.000Z"
    }
  ]
}
```

### 6. Get Purchase History
**GET** `/api/user/purchase-history`

Returns all credit purchase transactions.

**Headers:**
- `Authorization: Bearer <token>`

**Response:**
```json
{
  "success": true,
  "transactions": [
    {
      "id": 1,
      "credits_purchased": 30,
      "amount_paid": 12.99,
      "transaction_status": "completed",
      "transaction_date": "2026-01-20T10:00:00.000Z",
      "valid_from": "2026-01-20T10:00:00.000Z",
      "valid_until": "2026-02-20T10:00:00.000Z",
      "payment_method": "simulated",
      "transaction_id": "TXN-1234567890",
      "plan_name": "Professional"
    }
  ]
}
```

---

## Backend Helper Functions

### checkUserCredits(userId, creditsRequired)
Checks if user has sufficient credits.

**Returns:**
```javascript
{
  hasCredits: true|false,
  remaining: 25,
  message: "Credits available" | "Insufficient credits" | "Credits expired"
}
```

### deductCredits(userId, creditsToDeduct, actionType, metadata)
Deducts credits from user account and records usage.

**Parameters:**
- `userId`: User ID
- `creditsToDeduct`: Number of credits (default: 1)
- `actionType`: Type of action (e.g., 'cover_letter_generation')
- `metadata`: Object with `companyName`, `position`, `recipientEmail`

**Returns:**
```javascript
{
  success: true,
  remainingCredits: 24
}
```

### updateMonthlySent(userId)
Updates monthly sent counter when email is sent.

---

## Credit Validation Flow

### Cover Letter Generation

1. **Pre-generation Check:**
   ```javascript
   const creditCheck = await checkUserCredits(userId, 1);
   if (!creditCheck.hasCredits) {
       return res.status(402).json({ 
           error: creditCheck.message,
           remainingCredits: creditCheck.remaining
       });
   }
   ```

2. **Generation:**
   - AI generates cover letter
   - If successful, proceed to deduction

3. **Post-generation Deduction:**
   ```javascript
   await deductCredits(userId, 1, 'cover_letter_generation', {
       companyName: result.companyName,
       position: position,
       recipientEmail: recipientEmail
   });
   ```

4. **Response includes:**
   - Generated content
   - Credits used
   - Remaining credits

### Modified Endpoints

#### `/api/generate-cover-letters`
- Checks credits for all recipients before generation
- Returns 402 error if insufficient credits
- Deducts 1 credit per successful generation
- Returns `creditsUsed` and `creditsRemaining` in response

#### `/api/generate-cover-letter-details`
- Checks credits before generation
- Returns 402 error if insufficient
- Deducts 1 credit after successful generation
- Includes credit info in response

---

## Mobile App Integration

### New Screens Created

#### 1. UsageScreen.js
**Location:** `MobileApp.backup/src/screens/UsageScreen.js`

**Features:**
- Credit balance display with large numbers
- Expiry date with visual warnings
- Current month usage with progress bars
- Historical usage statistics
- Quick links to purchase plans

**Key Components:**
- Progress bars showing credits used vs total
- Warning badges for low credits or expiring soon
- Monthly stats (generated vs sent)
- Historical usage by month
- Refresh capability

#### 2. PlansScreen.js
**Location:** `MobileApp.backup/src/screens/PlansScreen.js`

**Features:**
- All available plans displayed as cards
- Most popular plan highlighted
- Feature list for each plan
- Current credit balance badge at top
- Simulated purchase flow

**Key Components:**
- Plan cards with pricing
- "Most Popular" badge
- Features with checkmarks
- Price per credit calculation
- Purchase confirmation dialog

#### 3. PurchaseHistoryScreen.js
**Location:** `MobileApp.backup/src/screens/PurchaseHistoryScreen.js`

**Features:**
- List of all transactions
- Transaction details (date, amount, credits, validity)
- Status indicators (completed, pending, failed)
- Transaction IDs for reference

---

## Navigation Integration

### Add to App Navigation

```javascript
// In your navigation file (e.g., App.js or navigation/index.js)
import UsageScreen from './src/screens/UsageScreen';
import PlansScreen from './src/screens/PlansScreen';
import PurchaseHistoryScreen from './src/screens/PurchaseHistoryScreen';

// Add to Stack Navigator
<Stack.Screen 
  name="Usage" 
  component={UsageScreen} 
  options={{ title: 'Usage & Credits' }}
/>
<Stack.Screen 
  name="Plans" 
  component={PlansScreen} 
  options={{ title: 'Choose Your Plan' }}
/>
<Stack.Screen 
  name="PurchaseHistory" 
  component={PurchaseHistoryScreen} 
  options={{ title: 'Purchase History' }}
/>

// Add to Settings/Dashboard menu
<TouchableOpacity onPress={() => navigation.navigate('Usage')}>
  <Text>Usage & Credits</Text>
</TouchableOpacity>
```

---

## Testing Checklist

### Database Tests
- [ ] Tables created successfully on server start
- [ ] Default plans inserted
- [ ] User credits record created on first access

### API Endpoint Tests
- [ ] GET /api/plans returns all plans
- [ ] GET /api/user/credits returns user balance
- [ ] POST /api/purchase-credits creates transaction and updates credits
- [ ] GET /api/user/usage-stats returns current month and history
- [ ] GET /api/user/credit-history returns detailed usage
- [ ] GET /api/user/purchase-history returns transactions

### Credit Validation Tests
- [ ] Cover letter generation blocked when no credits
- [ ] Cover letter generation blocked when credits expired
- [ ] Credits deducted only after successful generation
- [ ] Monthly stats updated correctly
- [ ] Usage history recorded properly

### Mobile App Tests
- [ ] UsageScreen displays credit balance correctly
- [ ] PlansScreen shows all available plans
- [ ] Purchase flow works (simulated)
- [ ] PurchaseHistoryScreen shows transactions
- [ ] Navigation between screens works
- [ ] Refresh functionality works on all screens

### Edge Cases
- [ ] User with 0 credits cannot generate
- [ ] Expired credits show as 0 remaining
- [ ] Bulk generation stops if credits run out mid-process
- [ ] Credits from multiple purchases stack correctly
- [ ] Expiry date extends properly with new purchases

---

## Error Handling

### Common Error Codes

**402 Payment Required**
- Insufficient credits
- Expired credits
- Response includes remaining credits and required amount

**Example:**
```json
{
  "error": "Insufficient credits. You need 1 credit(s) but only have 0 remaining.",
  "remainingCredits": 0,
  "creditsRequired": 1
}
```

### Mobile App Error Handling

```javascript
if (response.status === 402) {
  Alert.alert(
    'Insufficient Credits',
    data.error || 'You need more credits to generate cover letters.',
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Buy Credits', onPress: () => navigation.navigate('Plans') }
    ]
  );
}
```

---

## Future Enhancements

### Payment Integration
Currently uses simulated purchases. To integrate real payments:

1. **Stripe Integration:**
   ```javascript
   // Install: npm install @stripe/stripe-react-native
   // Add Stripe publishable key
   // Replace simulated purchase with Stripe payment flow
   ```

2. **Apple In-App Purchase:**
   ```javascript
   // Install: npm install react-native-iap
   // Configure products in App Store Connect
   // Implement purchase flow with receipt validation
   ```

3. **Google Play Billing:**
   ```javascript
   // Install: npm install react-native-iap
   // Configure products in Google Play Console
   // Implement purchase flow with receipt validation
   ```

### Additional Features
- **Credits Gift System**: Allow users to gift credits
- **Referral Program**: Earn credits by referring friends
- **Subscription Auto-Renewal**: Automatic credit renewal
- **Usage Analytics**: Detailed breakdown of credit usage
- **Credit Rollover**: Option to roll unused credits to next period
- **Bundle Discounts**: Buy more, save more pricing tiers

---

## Configuration

### Environment Variables
No additional environment variables needed. System uses existing database configuration.

### Modifying Plans
To add/modify plans, update the default plans in server.js:

```javascript
const defaultPlans = [
  { 
    name: 'Custom Plan', 
    credits: 50, 
    price: 19.99, 
    validity_days: 60, 
    description: 'Custom description',
    features: JSON.stringify(['Feature 1', 'Feature 2'])
  }
];
```

---

## Deployment Notes

### Server Restart Required
The database schema changes require a server restart:
```bash
pkill -9 node && node server.js
```

### Migration for Existing Users
Existing users will automatically get a `user_credits` record with 0 credits on first API call. Consider:
- Giving existing users welcome bonus credits
- Running a migration script to assign initial credits

```javascript
// Migration script (run once)
db.all('SELECT id FROM users', (err, users) => {
  users.forEach(user => {
    db.run(`
      INSERT OR IGNORE INTO user_credits (user_id, credits_remaining, credits_total)
      VALUES (?, 10, 10)
    `, [user.id]);
  });
});
```

---

## Support & Maintenance

### Monitoring
Key metrics to monitor:
- Total credits purchased per day/month
- Average credits used per user
- Credit expiry rate
- Popular plans
- Failed transactions

### Database Maintenance
```sql
-- Clear expired credits (run monthly)
UPDATE user_credits 
SET credits_remaining = 0 
WHERE expiry_date < datetime('now') AND credits_remaining > 0;

-- Archive old transactions (run quarterly)
-- Consider moving old records to archive table
```

---

## API Response Status Codes

- **200**: Success
- **400**: Bad request (missing parameters)
- **401**: Unauthorized (no token or invalid token)
- **402**: Payment required (insufficient credits)
- **403**: Forbidden
- **404**: Not found
- **500**: Server error

---

## Contact & Support

For questions or issues with the credits system:
- Check server logs for detailed error messages
- Verify database tables were created correctly
- Ensure API endpoints are accessible
- Test with Postman/Insomnia before mobile integration

---

## Version History

**v1.0.0** - January 22, 2026
- Initial implementation
- 4 default plans (Starter, Professional, Premium, Enterprise)
- Credit-based generation system
- Monthly usage tracking
- Mobile app screens (Usage, Plans, Purchase History)
- Simulated purchase flow

---

## Summary

This credits system provides:
✅ Monetization model for the application
✅ Fair usage tracking per user
✅ Flexible subscription plans
✅ Comprehensive usage statistics
✅ Mobile-first user experience
✅ Foundation for payment gateway integration

The system is production-ready except for payment gateway integration, which should be added before public launch.
