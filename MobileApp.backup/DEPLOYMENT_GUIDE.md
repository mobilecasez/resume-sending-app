# Mobile App Setup & Deployment Guide

## Complete Setup Instructions

### Step 1: Backend Prerequisites

Your Node.js backend must have the following endpoints:

```javascript
// Authentication endpoints
POST /api/auth/login
POST /api/auth/register

// User endpoints
GET /api/profile
PUT /api/profile

// Application endpoints
GET /api/applications
POST /api/applications
DELETE /api/applications/:id

// Dashboard endpoints
GET /api/dashboard/stats

// Cover letter endpoints
POST /api/generate-cover-letter
POST /api/save-cover-letter
```

### Step 2: Configure Environment Variables

Create `.env` file in MobileApp directory:

```env
# API Configuration
API_BASE_URL=http://localhost:3000

# Google OAuth (Get from Google Cloud Console)
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret

# App Configuration
APP_NAME=Lettrico
APP_VERSION=1.0.0
```

### Step 3: Development Setup

#### macOS & iOS Development

1. **Install Xcode:**
   ```bash
   xcode-select --install
   ```

2. **Install CocoaPods:**
   ```bash
   sudo gem install cocoapods
   ```

3. **Install development dependencies:**
   ```bash
   npm install
   npx pod-install
   ```

4. **Run on iOS Simulator:**
   ```bash
   npx expo start --ios
   ```

#### Android Development

1. **Install Android Studio:**
   - Download from [android.com/studio](https://android.com/studio)
   - Install and configure SDK

2. **Set Android SDK path:**
   ```bash
   export ANDROID_SDK_ROOT=$HOME/Library/Android/sdk
   export PATH=$PATH:$ANDROID_SDK_ROOT/tools
   ```

3. **Run on Android Emulator:**
   ```bash
   npx expo start --android
   ```

### Step 4: Test Authentication Flow

1. **Start backend server:**
   ```bash
   cd ..
   npm start
   ```

2. **Start mobile app:**
   ```bash
   cd MobileApp
   npx expo start
   ```

3. **Test login with test credentials:**
   - Email: test@example.com
   - Password: test123456

### Step 5: Configure App Icons & Splash Screen

Replace placeholder assets:

```
MobileApp/
├── assets/
│   ├── icon.png (1024x1024px)
│   ├── splash.png (1242x2436px)
│   └── favicon.png (32x32px)
```

Update app.json:
```json
{
  "icon": "./assets/icon.png",
  "splash": {
    "image": "./assets/splash.png"
  }
}
```

## iOS App Store Deployment

### Prerequisites
- Apple Developer Account ($99/year)
- Xcode installed
- Mac with latest macOS

### Step 1: Create App in App Store Connect

1. Go to [appstoreconnect.apple.com](https://appstoreconnect.apple.com)
2. Click "My Apps" → "+" → "New App"
3. Select platform: iOS
4. Fill in details:
   - App Name: Lettrico
   - Bundle ID: com.lettrico.mobile
   - SKU: com.lettrico
   - User Access: Full Access

### Step 2: Generate Signing Certificate

1. Go to Apple Developer Portal
2. Certificates, Identifiers & Profiles → Certificates
3. Create new certificate:
   - Click "+"
   - Select "iOS App Development"
   - Follow CSR generation steps
   - Download certificate

### Step 3: Build with EAS

1. **Install EAS CLI:**
   ```bash
   npm install -g eas-cli
   ```

2. **Login to Expo:**
   ```bash
   eas login
   ```

3. **Configure EAS for iOS:**
   ```bash
   eas build:configure
   ```

4. **Build for iOS:**
   ```bash
   eas build --platform ios
   ```

### Step 4: Upload to App Store

1. After build completes, download .ipa file
2. Use Transporter to upload:
   ```bash
   xcrun altool --upload-app -f app.ipa -t ios -u apple_id@example.com -p app_password
   ```

Or use App Store Connect:
1. Go to app in App Store Connect
2. TestFlight → iOS Builds
3. Upload build via Transporter
4. Fill in app information
5. Submit for review

## Android Play Store Deployment

### Prerequisites
- Google Play Developer Account ($25 one-time fee)
- Android SDK tools
- Keystore file for signing

### Step 1: Create App in Google Play Console

1. Go to [play.google.com/console](https://play.google.com/console)
2. Click "Create app"
3. Fill in:
   - App name: Lettrico
   - Default language: English
   - Select categories
   - App or game: App

### Step 2: Create Signing Key

```bash
# Generate keystore (run once)
keytool -genkey -v -keystore ~/lettrico-key.keystore \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -alias lettrico-key

# Store password safely
# Remember the keystore password and alias password
```

### Step 3: Configure App Signing

Update `eas.json`:
```json
{
  "build": {
    "production": {
      "android": {
        "buildType": "app-bundle"
      }
    }
  }
}
```

### Step 4: Build for Android

```bash
eas build --platform android --release-channel production
```

### Step 5: Upload to Play Store

1. Complete Google Play form:
   - Content rating
   - Target audience
   - Privacy policy
   - Permissions justification

2. Upload build to Google Play Console:
   - Internal Testing → Upload AAB file
   - Review and test
   - Move to Production

3. Fill in store listing:
   - App title
   - Short description (80 chars)
   - Full description
   - Screenshots (5 required)
   - Feature graphic (1024x500px)
   - Icon (512x512px)

4. Set pricing and distribution:
   - Countries
   - Pricing
   - Content rating

5. Submit for review

## App Store Submission Checklist

### iOS
- [ ] App name matches brand guidelines
- [ ] Unique app icon (no transparency)
- [ ] Privacy policy URL provided
- [ ] Terms of service URL provided
- [ ] Contact support info provided
- [ ] Age rating selected
- [ ] Screenshots in 6.5" size
- [ ] Preview text provided
- [ ] Keywords entered (max 100 chars)
- [ ] Support URL provided
- [ ] Test account credentials if needed
- [ ] All features documented
- [ ] No placeholder text
- [ ] Compliant with App Store Review Guidelines

### Android
- [ ] App title (50 chars max)
- [ ] Short description (80 chars)
- [ ] Full description (4000 chars max)
- [ ] App icon (512x512px, 32-bit PNG)
- [ ] Feature graphic (1024x500px)
- [ ] Screenshots (2-8 required, 1080x1920 minimum)
- [ ] Privacy policy URL
- [ ] Target audience selected
- [ ] Content rating completed
- [ ] Pricing and distribution set
- [ ] Contact info provided
- [ ] Permissions justified
- [ ] No placeholder content

## App Store Optimization Tips

### Keywords & Description
- Include relevant job search terms
- Mention AI-powered features
- Highlight cover letter generation
- Use action words (Generate, Create, Manage)

### Screenshots
- Show key features (login, generate, dashboard)
- Include text overlays
- Use consistent design
- Highlight unique selling points

### Support Resources
- Prepare FAQ
- Create support email
- Document known issues
- Plan update schedule

## Post-Launch Maintenance

### Monitoring
- Track crash reports in Xcode/Google Play
- Monitor user reviews
- Track download metrics
- Monitor ratings trends

### Updates
- Bug fixes (priority)
- Feature additions (quarterly)
- Performance improvements
- Security patches (immediate)

### Version Updates

**Semantic Versioning:** MAJOR.MINOR.PATCH

```
1.0.0 - Initial release
1.1.0 - New feature (cover letter templates)
1.1.1 - Bug fix
2.0.0 - Major rewrite
```

## Troubleshooting Deployment

### Build Failures
```bash
# Clear build cache
eas build:cache --platform ios --clear
eas build:cache --platform android --clear

# Rebuild
eas build --platform ios
```

### Code Signing Issues
```bash
# Reset certificates
eas credentials
# Select "Remove" and regenerate
```

### Store Rejection

**Common iOS Rejections:**
- Missing privacy policy
- Cryptic error messages
- Unclear app purpose
- Placeholder content

**Common Android Rejections:**
- Misleading description
- Policy violations
- Malware detection
- Permission misuse

## Resources

- [Expo Documentation](https://docs.expo.dev)
- [React Native Docs](https://reactnative.dev)
- [Apple App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines)
- [Google Play Policies](https://play.google.com/about/developer-content-policy)
- [EAS Build Documentation](https://docs.expo.dev/eas/build)

## Support

For deployment issues:
1. Check Expo build logs
2. Review store rejection reasons
3. Consult documentation
4. Contact support teams

---

**Last Updated:** 2024  
**Version:** 1.0.0
