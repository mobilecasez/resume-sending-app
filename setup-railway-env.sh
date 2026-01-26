#!/bin/bash

# Railway Environment Variables Setup Script
# Run this after linking your Railway project

echo "🚀 Setting up Railway Environment Variables..."

# Generate secure keys
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

echo ""
echo "📝 Copy these environment variables to Railway Dashboard:"
echo "=========================================================="
echo ""
echo "JWT_SECRET=$JWT_SECRET"
echo "ENCRYPTION_KEY=$ENCRYPTION_KEY"
echo "PORT=3000"
echo "NODE_ENV=production"
echo ""
echo "# Update these with your actual values:"
echo "GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com"
echo "GOOGLE_CLIENT_SECRET=your-google-client-secret"
echo "GOOGLE_CALLBACK_URL=https://YOUR-RAILWAY-DOMAIN.railway.app/auth/google/callback"
echo ""
echo "=========================================================="
echo ""
echo "📋 To set these in Railway:"
echo "1. Go to: https://railway.app/project/f7e266ad-cd6e-4d4e-b1d5-9a5470afa014"
echo "2. Click on your service"
echo "3. Go to 'Variables' tab"
echo "4. Click 'New Variable' and paste each line above"
echo ""
echo "🔐 Admin Login (auto-created on first deployment):"
echo "   Email: samrishi24@gmail.com"
echo "   Password: admin123"
echo "   ⚠️  CHANGE PASSWORD AFTER FIRST LOGIN!"
echo ""
