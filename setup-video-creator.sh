#!/bin/bash

echo "🎬 Setting up OAuth Demo Video Creator"
echo "======================================"
echo ""

# Install required packages
echo "📦 Installing required packages..."
npm install --save-dev puppeteer puppeteer-screen-recorder

echo ""
echo "✅ Setup complete!"
echo ""
echo "📋 Next steps:"
echo ""
echo "1. Create a test Google account (don't use your personal account)"
echo "   Visit: https://accounts.google.com/signup"
echo ""
echo "2. Set environment variables:"
echo "   export TEST_GOOGLE_EMAIL='your-test@gmail.com'"
echo "   export TEST_GOOGLE_PASSWORD='your-test-password'"
echo ""
echo "3. Run the video creator:"
echo "   node create-oauth-demo-video.js"
echo ""
echo "4. The video will be saved as 'oauth-demo-video.mp4'"
echo ""
echo "5. Upload to YouTube as 'Unlisted' and submit URL to Google"
echo ""
