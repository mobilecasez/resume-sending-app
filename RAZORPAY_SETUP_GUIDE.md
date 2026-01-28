# Razorpay Payment Integration Setup Guide

## 📋 Overview
CVApplyr now supports payment processing through Razorpay! Users can purchase credit packages directly through the application.

---

## 🚀 Quick Setup

### 1. Get Your Razorpay Credentials

1. **Sign up for Razorpay**
   - Visit https://razorpay.com
   - Create a free account
   - Complete KYC verification (for live mode)

2. **Get API Keys**
   - Go to Dashboard → Settings → API Keys
   - URL: https://dashboard.razorpay.com/app/website-app-settings/api-keys
   - Generate **Test Mode** keys for development
   - Generate **Live Mode** keys for production (after KYC)

3. **Copy Your Keys**
   ```
   Key ID: rzp_test_xxxxxxxxxxxxx (for test mode)
   Key Secret: xxxxxxxxxxxxxxxxxxxxx
   ```

### 2. Configure the Application

1. **Open `.env.razorpay` file** in the project root
   ```bash
   nano .env.razorpay
   # or
   code .env.razorpay
   ```

2. **Update with your keys**
   ```bash
   # Test Mode (for development)
   RAZORPAY_KEY_ID=rzp_test_YOUR_KEY_ID_HERE
   RAZORPAY_KEY_SECRET=YOUR_KEY_SECRET_HERE
   
   # Production Mode (comment out test keys and uncomment these)
   # RAZORPAY_KEY_ID=rzp_live_YOUR_LIVE_KEY_ID_HERE
   # RAZORPAY_KEY_SECRET=YOUR_LIVE_KEY_SECRET_HERE
   ```

3. **Save the file** (Ctrl+S or ⌘+S)

### 3. Test the Integration

1. **Restart your server** (if running)
   ```bash
   npm start
   ```

2. **Navigate to Packages page**
   - Login to your account
   - Go to http://localhost:3000/packages.html

3. **Test payment with Razorpay test cards**
   ```
   Card Number: 4111 1111 1111 1111
   CVV: Any 3 digits
   Expiry: Any future date
   ```

4. **Check payment was processed**
   - Credits should be added to your account
   - Payment should appear in transaction history

---

## 💳 Payment Flow

### User Journey
1. User views available credit packages
2. Clicks "Buy Plan" button
3. Razorpay checkout modal opens
4. User enters payment details
5. Payment is processed
6. Credits are automatically added to user account
7. Transaction is recorded in database

### Technical Flow
```
Frontend (packages.html)
    ↓
POST /api/payment/create-order
    ↓
Razorpay Order Created
    ↓
Razorpay Checkout Modal
    ↓
User Completes Payment
    ↓
POST /api/payment/verify
    ↓
Payment Verified & Credits Added
```

---

## 🗄️ Database Tables

### `payment_orders`
Stores all payment orders and their status.
```sql
- order_id: Razorpay order ID
- payment_id: Razorpay payment ID (after successful payment)
- user_id: User who made the payment
- package_id: Package purchased
- amount: Payment amount
- status: created | completed | failed
```

### `credit_transactions`
Records all credit changes.
```sql
- user_id: User ID
- transaction_type: 'purchase' | 'usage' | 'refund'
- credits_change: Number of credits added/removed
- balance_after: User's balance after transaction
- description: Transaction description
```

---

## 🔐 Security Features

✅ **Signature Verification**: All payments are verified using Razorpay signature
✅ **Amount Validation**: Backend validates package prices
✅ **Transaction Atomicity**: Database transactions ensure consistency
✅ **Credentials Isolation**: Razorpay keys stored in separate `.env.razorpay` file
✅ **Git Ignored**: `.env.razorpay` excluded from version control

---

## 🧪 Testing with Razorpay

### Test Cards (Test Mode Only)

**Successful Payment**
```
Card: 4111 1111 1111 1111
CVV: 123
Expiry: 12/25
```

**Payment Failure**
```
Card: 4000 0000 0000 0002
CVV: 123
Expiry: 12/25
```

**Insufficient Funds**
```
Card: 4000 0000 0000 9995
CVV: 123
Expiry: 12/25
```

### Test UPI (Test Mode)
- Use any UPI ID format: `test@upi`
- All test UPI payments will succeed

---

## 📊 API Endpoints

### `POST /api/payment/create-order`
Creates a new Razorpay order.

**Request:**
```json
{
  "packageId": 1,
  "amount": 4.99
}
```

**Response:**
```json
{
  "success": true,
  "orderId": "order_xxxxxxxxxxxxx",
  "amount": 499,
  "currency": "INR",
  "keyId": "rzp_test_xxxxx"
}
```

### `POST /api/payment/verify`
Verifies payment and adds credits.

**Request:**
```json
{
  "razorpay_order_id": "order_xxxxx",
  "razorpay_payment_id": "pay_xxxxx",
  "razorpay_signature": "signature_xxxxx"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Payment successful!",
  "credits": 110,
  "creditsAdded": 10
}
```

### `GET /api/payment/history`
Get user's payment history.

**Response:**
```json
{
  "success": true,
  "payments": [
    {
      "order_id": "order_xxxxx",
      "payment_id": "pay_xxxxx",
      "amount": 4.99,
      "status": "completed",
      "package_name": "Starter",
      "credits": 10,
      "created_at": "2024-01-27T10:30:00Z"
    }
  ]
}
```

### `GET /api/payment/config`
Get Razorpay public key for frontend.

**Response:**
```json
{
  "keyId": "rzp_test_xxxxx"
}
```

---

## 🚀 Deploying to Production (Railway)

### 1. Set Environment Variables in Railway

```bash
railway variables --set "RAZORPAY_KEY_ID=rzp_live_YOUR_LIVE_KEY"
railway variables --set "RAZORPAY_KEY_SECRET=YOUR_LIVE_SECRET"
```

Or via Railway Dashboard:
1. Go to your project
2. Navigate to Variables tab
3. Add:
   - `RAZORPAY_KEY_ID`
   - `RAZORPAY_KEY_SECRET`

### 2. Deploy
```bash
railway up
```

### 3. Verify Payment Service
Check server logs for:
```
✅ Razorpay initialized successfully
```

---

## ⚠️ Important Notes

### Test vs Live Mode
- **Test Mode**: Use for development/testing. No real money is charged.
- **Live Mode**: Use for production. Real money transactions.
- **Never mix test and live keys!**

### Webhooks (Optional)
For advanced features like automatic refunds or payment status updates:
1. Go to Dashboard → Webhooks
2. Add webhook URL: `https://yourdomain.com/api/payment/webhook`
3. Select events to listen to
4. Update webhook secret in `.env.razorpay`

### Currency Support
- Currently configured for **INR (Indian Rupees)**
- To support other currencies, update the payment endpoints
- Razorpay supports 100+ currencies

### Compliance
- Complete KYC verification for live mode
- Ensure compliance with local regulations
- Add proper refund policy
- Display payment gateway charges if applicable

---

## 🐛 Troubleshooting

### Payment service not configured
**Error:** "Payment service not configured"
**Solution:** 
- Check if `.env.razorpay` file exists
- Verify `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` are set
- Restart server after adding credentials

### Payment verification failed
**Error:** "Payment verification failed"
**Solution:**
- Ensure `RAZORPAY_KEY_SECRET` is correct
- Check server logs for detailed error
- Verify signature calculation is correct

### Credits not added after payment
**Issue:** Payment successful but credits not updated
**Solution:**
- Check database connection
- Look for errors in server logs
- Verify `payment_orders` and `credit_transactions` tables exist
- Check transaction rollback logs

### Razorpay checkout not opening
**Issue:** Clicking "Buy Plan" does nothing
**Solution:**
- Check browser console for errors
- Ensure Razorpay SDK script is loaded
- Verify `/api/payment/config` endpoint returns key ID
- Check if `authToken` is present in localStorage

---

## 📞 Support

### Razorpay Support
- Email: support@razorpay.com
- Docs: https://razorpay.com/docs
- Dashboard: https://dashboard.razorpay.com

### CVApplyr Support
- Check application logs: `railway logs` or `npm start`
- Review payment history: GET `/api/payment/history`
- Database queries: Check `payment_orders` and `credit_transactions` tables

---

## ✅ Checklist

Before going live:
- [ ] KYC verification completed on Razorpay
- [ ] Live API keys generated
- [ ] `.env.razorpay` updated with live keys
- [ ] Test successful payment with live keys in staging
- [ ] Verify credits are added correctly
- [ ] Test payment failure scenarios
- [ ] Payment history displays correctly
- [ ] Refund policy page updated
- [ ] Terms & conditions updated
- [ ] Privacy policy updated (mention payment processing)
- [ ] SSL certificate active (HTTPS)
- [ ] Backup database before going live

---

## 📚 Additional Resources

- [Razorpay Documentation](https://razorpay.com/docs)
- [Razorpay Test Cards](https://razorpay.com/docs/payments/payments/test-card-details)
- [Razorpay Integration Checklist](https://razorpay.com/docs/payment-gateway/web-integration/standard/integration-checklist)
- [Razorpay Webhooks](https://razorpay.com/docs/webhooks)
- [Payment Gateway Best Practices](https://razorpay.com/docs/payment-gateway/web-integration/standard/security-features)

---

**Last Updated:** January 2026
**Version:** 1.0.0
