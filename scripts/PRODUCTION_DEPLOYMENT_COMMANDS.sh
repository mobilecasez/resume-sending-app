#!/bin/bash
# Production Deployment Commands for CVApplyr
# Run these commands to configure Railway for production

cd /Users/rishisamadhiya/Desktop/Files/Personal/Shopify\ Apps/resume-sending-app

echo "🚀 Setting up Railway environment variables for Production..."

# ============================================
# GOOGLE OAUTH CREDENTIALS
# ============================================
echo ""
echo "📝 Step 1: Google OAuth Configuration"
echo "-------------------------------------------"

# Get your Google Client Secret from: https://console.cloud.google.com/apis/credentials
# Then run:
# railway variables --set "GOOGLE_CLIENT_ID=832256639733-f3931pli3e13dijpkpehm799pkqll5sq.apps.googleusercontent.com"
# railway variables --set "GOOGLE_CLIENT_SECRET=YOUR_ACTUAL_CLIENT_SECRET_HERE"

echo "⚠️  You need to:"
echo "   1. Go to https://console.cloud.google.com/apis/credentials"
echo "   2. Click on your OAuth 2.0 Client ID"
echo "   3. Copy the 'Client Secret' value"
echo "   4. Run the command above with your actual secret"
echo ""

# ============================================
# RAZORPAY CREDENTIALS (From .env.razorpay)
# ============================================
echo "📝 Step 2: Razorpay Payment Gateway Configuration"
echo "-------------------------------------------"
echo "⚠️  Update .env.razorpay with your REAL credentials from https://dashboard.razorpay.com/"
echo ""
echo "For TEST mode (recommended first):"
echo "  - Get Test API Key from: https://dashboard.razorpay.com/app/keys"
echo "  - These start with 'rzp_test_'"
echo ""
echo "After updating .env.razorpay, run:"
echo "  source .env.razorpay"
echo '  railway variables --set "RAZORPAY_KEY_ID=$RAZORPAY_KEY_ID"'
echo '  railway variables --set "RAZORPAY_KEY_SECRET=$RAZORPAY_KEY_SECRET"'
echo '  railway variables --set "RAZORPAY_WEBHOOK_SECRET=$RAZORPAY_WEBHOOK_SECRET"'
echo ""

# ============================================
# VERIFY EXISTING VARIABLES
# ============================================
echo "📝 Step 3: Verify Existing Configuration"
echo "-------------------------------------------"
echo "Current Railway variables:"
railway variables 2>&1 | grep -E "PORT|DATABASE_URL|JWT_SECRET|ENCRYPTION_KEY|NODE_ENV|GOOGLE|RAZORPAY" || echo "No variables found"
echo ""

# ============================================
# DEPLOY TO RAILWAY
# ============================================
echo "📝 Step 4: Deploy to Production"
echo "-------------------------------------------"
echo "After setting all variables, deploy with:"
echo "  railway up"
echo ""

# ============================================
# VERIFY DEPLOYMENT
# ============================================
echo "📝 Step 5: Verify Deployment"
echo "-------------------------------------------"
echo "Check deployment status:"
echo "  railway logs"
echo ""
echo "Test your website:"
echo "  curl -I https://cvapplyr.com/"
echo ""
echo "Test API:"
echo "  curl https://cvapplyr.com/api/packages"
echo ""

# ============================================
# GOOGLE OAUTH CONFIGURATION CHECKLIST
# ============================================
echo "📝 Step 6: Google Cloud Console Configuration"
echo "-------------------------------------------"
echo "Go to: https://console.cloud.google.com/apis/credentials"
echo ""
echo "Add these Authorized JavaScript Origins:"
echo "  ✓ https://cvapplyr.com"
echo "  ✓ https://www.cvapplyr.com"
echo "  ✓ https://cvapplyr-website-production.up.railway.app"
echo ""
echo "Add these Authorized Redirect URIs:"
echo "  ✓ https://cvapplyr.com/auth/google/callback"
echo "  ✓ https://www.cvapplyr.com/auth/google/callback"
echo "  ✓ https://cvapplyr-website-production.up.railway.app/auth/google/callback"
echo "  ✓ https://cvapplyr.com/auth-success.html"
echo "  ✓ https://www.cvapplyr.com/auth-success.html"
echo ""
echo "Configure OAuth Consent Screen:"
echo "  ✓ Status: In Production"
echo "  ✓ App name: CVApplyr"
echo "  ✓ Homepage: https://cvapplyr.com"
echo "  ✓ Privacy Policy: https://cvapplyr.com/privacy.html"
echo "  ✓ Terms of Service: https://cvapplyr.com/terms.html"
echo ""
echo "Add Authorized Domains:"
echo "  ✓ cvapplyr.com"
echo "  ✓ railway.app"
echo ""

# ============================================
# RAZORPAY CONFIGURATION CHECKLIST
# ============================================
echo "📝 Step 7: Razorpay Dashboard Configuration"
echo "-------------------------------------------"
echo "Go to: https://dashboard.razorpay.com/"
echo ""
echo "1. Get API Keys:"
echo "   - Navigate to Settings > API Keys"
echo "   - For TESTING: Use 'Test Mode' keys (rzp_test_...)"
echo "   - For PRODUCTION: Use 'Live Mode' keys (rzp_live_...)"
echo ""
echo "2. Configure Webhook:"
echo "   - Navigate to Settings > Webhooks"
echo "   - Add webhook URL: https://cvapplyr.com/api/payment/webhook"
echo "   - Active Events: payment.captured, payment.failed"
echo "   - Copy webhook secret and add to .env.razorpay"
echo ""
echo "3. Test Payment Flow:"
echo "   - Login to https://cvapplyr.com/login.html"
echo "   - Go to Packages page"
echo "   - Select a plan and test payment"
echo "   - Use Test Cards: https://razorpay.com/docs/payments/payments/test-card-details/"
echo ""

# ============================================
# DOMAIN CONFIGURATION
# ============================================
echo "📝 Step 8: Domain Configuration (GoDaddy)"
echo "-------------------------------------------"
echo "DNS Records for cvapplyr.com:"
echo ""
echo "1. Root domain (cvapplyr.com):"
echo "   Type: A or Forwarding"
echo "   Points to: Railway IP or forwards to www"
echo ""
echo "2. WWW subdomain:"
echo "   Type: CNAME"
echo "   Name: www"
echo "   Value: 4gce51gj.up.railway.app"
echo "   TTL: 1 Hour"
echo ""
echo "3. Google Verification (if required):"
echo "   Type: TXT"
echo "   Name: @"
echo "   Value: google-site-verification=XXXXX"
echo "   TTL: 1 Hour"
echo ""

echo "✅ Configuration guide complete!"
echo ""
echo "📖 For detailed instructions, see: GOOGLE_OAUTH_PRODUCTION_SETUP.md"
echo "💳 For Razorpay setup, see: RAZORPAY_PAYMENT_SETUP.md"
