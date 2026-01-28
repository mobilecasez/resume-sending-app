# 💳 Razorpay Payment Gateway - Testing Guide

## ✅ Setup Complete!

Your Razorpay payment integration is now ready for testing with the following test credentials:

```
Test Key ID: rzp_test_S9PR879EO7KgGN
Test Key Secret: JkH5ini01rivkLqTXnjRR3vI
```

These credentials are stored in `.env.razorpay` (gitignored for security).

---

## 🧪 How to Test Payments

### 1. **Access Packages Page**
- Start the server: `npm start`
- Navigate to: http://localhost:3000/packages.html
- Login with your test account

### 2. **Make a Test Purchase**
- Click on any package's "💳 Buy Plan" button
- Razorpay checkout modal will open

### 3. **Use Test Cards**

**✅ Successful Payment:**
- Card Number: `4111 1111 1111 1111`
- CVV: Any 3 digits (e.g., `123`)
- Expiry: Any future date (e.g., `12/25`)
- Cardholder Name: Any name

**❌ Failed Payment (for testing failures):**
- Card Number: `4111 1111 1111 1112`
- CVV: Any 3 digits
- Expiry: Any future date

**📱 More Test Cards:** https://razorpay.com/docs/payments/payments/test-card-upi-details/

### 4. **Verify Credits**
After successful payment:
- Credits should be added to your account
- Check top-right credits badge
- Visit usage page to see transaction history
- Check your Razorpay Dashboard: https://dashboard.razorpay.com/app/payments

---

## 📊 Available API Endpoints

### Create Payment Order
```bash
POST /api/payment/create-order
Authorization: Bearer YOUR_TOKEN
Body: {
  "packageId": 1,
  "amount": 99
}
```

### Verify Payment
```bash
POST /api/payment/verify
Authorization: Bearer YOUR_TOKEN
Body: {
  "razorpay_order_id": "order_xxx",
  "razorpay_payment_id": "pay_xxx",
  "razorpay_signature": "xxx"
}
```

### Get Payment History
```bash
GET /api/payment/history
Authorization: Bearer YOUR_TOKEN
```

### Get Razorpay Config
```bash
GET /api/payment/config
```

---

## 🔍 Server Console Messages

When server starts, you should see:
```
✅ Razorpay initialized successfully
```

If credentials are missing:
```
⚠️  Razorpay credentials not found. Payment endpoints will not work.
```

---

## 🗄️ Database Tables

The following tables are used for payment tracking:

### `payment_orders`
```sql
- order_id (Razorpay order ID)
- user_id
- package_id
- amount
- currency
- status (created/completed/failed)
- payment_id (after successful payment)
- signature
- created_at
- updated_at
```

### `credit_transactions`
```sql
- user_id
- transaction_type (purchase/usage/refund)
- credits_change
- description
- balance_after
- created_at
```

---

## 🚀 Going to Production

### Step 1: Get Live Credentials
1. Complete KYC on Razorpay Dashboard
2. Activate Live Mode
3. Generate Live API Keys from: https://dashboard.razorpay.com/app/website-app-settings/api-keys

### Step 2: Update `.env.razorpay`
```env
# Comment out test credentials
# RAZORPAY_KEY_ID=rzp_test_S9PR879EO7KgGN
# RAZORPAY_KEY_SECRET=JkH5ini01rivkLqTXnjRR3vI

# Add live credentials
RAZORPAY_KEY_ID=rzp_live_YOUR_LIVE_KEY_ID
RAZORPAY_KEY_SECRET=YOUR_LIVE_KEY_SECRET
```

### Step 3: Railway Deployment
Set these environment variables in Railway Dashboard:
```
RAZORPAY_KEY_ID=rzp_live_YOUR_LIVE_KEY_ID
RAZORPAY_KEY_SECRET=YOUR_LIVE_KEY_SECRET
```

### Step 4: Test in Production
- Use real card details
- Verify payment appears in Razorpay Live Dashboard
- Check credits are added correctly

---

## 🛡️ Security Features

✅ **Payment signature verification** - Prevents tampering
✅ **Server-side validation** - Amount & package verification
✅ **Secure credential storage** - Environment variables only
✅ **Transaction logging** - Full audit trail
✅ **HTTPS encryption** - Razorpay handles PCI compliance

---

## 🐛 Troubleshooting

### Payment Modal Not Opening?
- Check browser console for errors
- Verify Razorpay script is loaded: `<script src="https://checkout.razorpay.com/v1/checkout.js"></script>`
- Ensure user is logged in (check localStorage for authToken)

### "Payment service not configured" Error?
- Check `.env.razorpay` file exists
- Verify credentials are correct
- Restart server after updating credentials

### Credits Not Added After Payment?
- Check `/api/payment/verify` endpoint response
- Verify signature validation passed
- Check `payment_orders` table for status
- Check `credit_transactions` table for entry

### Server Console Shows Warning?
```
⚠️  Razorpay credentials not found
```
**Solution:** Create `.env.razorpay` file with credentials and restart

---

## 📞 Support & Documentation

- **Razorpay Docs:** https://razorpay.com/docs/
- **Test Cards:** https://razorpay.com/docs/payments/payments/test-card-upi-details/
- **Dashboard:** https://dashboard.razorpay.com/
- **Integration Guide:** https://razorpay.com/docs/payment-gateway/web-integration/standard/

---

## ✨ Testing Checklist

- [ ] Server starts with "✅ Razorpay initialized successfully"
- [ ] Packages page loads with all plans
- [ ] Click "Buy Plan" opens Razorpay modal
- [ ] Test card payment succeeds
- [ ] Credits added to account immediately
- [ ] Transaction appears in payment history
- [ ] Failed payment shows error message
- [ ] Payment cancellation works correctly
- [ ] Razorpay Dashboard shows test payment

---

**🎉 Ready to Test!**

Visit: http://localhost:3000/packages.html

Use test card: `4111 1111 1111 1111` with any CVV and future expiry date.

---

*Last Updated: 29 January 2026*
