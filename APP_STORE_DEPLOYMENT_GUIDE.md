# App Store & Play Store Deployment Guide

## 🚨 CRITICAL ISSUES TO FIX BEFORE SUBMISSION

### 1. **PRODUCTION API URL** ⚠️ BLOCKER
**File:** `MobileApp/config.js` (Line 5)
```javascript
const PRODUCTION_API_URL = 'https://your-production-domain.com/api';
```
**Issue:** Still using placeholder URL
**Fix:** Replace with your actual production server URL (e.g., `https://cvapplyr.com/api`)

### 2. **Android Package Name Missing** ⚠️ BLOCKER
**File:** `MobileApp/app.json`
**Issue:** Missing `package` field in android config
**Fix:** Add this to the android section:
```json
"android": {
  "package": "com.cvapplyr.mobile",
  "versionCode": 1,
  "adaptiveIcon": { ... }
}
```

### 3. **Privacy Policy & Terms Required** ⚠️ BLOCKER
**Both stores require:**
- Privacy Policy URL
- Terms of Service URL

**Files exist but not configured:**
- `/public/privacy-policy.html`
- `/public/terms-of-service.html`

**Action:** Add these URLs to app.json:
```json
"extra": {
  "privacyPolicyUrl": "https://cvapplyr.com/privacy-policy.html",
  "termsOfServiceUrl": "https://cvapplyr.com/terms-of-service.html"
}
```

### 4. **Remove Console.log Statements** ⚠️ WARNING
**Found:** 100+ console.log statements in App.js
**Impact:** Performance degradation, potential data leaks
**Fix:** Remove or wrap in __DEV__ check:
```javascript
if (__DEV__) console.log('Debug info');
```

### 5. **App Icon Issues** ⚠️ WARNING
**Current:** Generic icons in `/assets/images/`
**Required:**
- iOS: icon.png (1024x1024)
- Android: Adaptive icon with foreground/background/monochrome
**Status:** Icons exist but need verification for branding

### 6. **Permissions Declaration** ⚠️ REQUIRED
**Missing in app.json:**
```json
"ios": {
  "infoPlist": {
    "NSCameraUsageDescription": "This app uses camera to capture profile photos",
    "NSPhotoLibraryUsageDescription": "This app accesses photo library to select images",
    "NSDocumentsFolderUsageDescription": "This app needs to access documents for resume uploads"
  }
},
"android": {
  "permissions": [
    "CAMERA",
    "READ_EXTERNAL_STORAGE",
    "WRITE_EXTERNAL_STORAGE"
  ]
}
```

---

## 📱 GOOGLE PLAY STORE DEPLOYMENT

### Prerequisites
1. **Google Play Console Account** ($25 one-time fee)
2. **Production Server** deployed and accessible via HTTPS
3. **Signing Key** for Android app

### Step 1: Prepare App Configuration

**Update `MobileApp/app.json`:**
```json
{
  "expo": {
    "name": "CVApplyr",
    "slug": "cvapplyr-mobile",
    "version": "1.0.0",
    "android": {
      "package": "com.cvapplyr.mobile",
      "versionCode": 1,
      "permissions": ["CAMERA", "READ_EXTERNAL_STORAGE", "WRITE_EXTERNAL_STORAGE"],
      "adaptiveIcon": {
        "backgroundColor": "#E6F4FE",
        "foregroundImage": "./assets/images/android-icon-foreground.png"
      }
    }
  }
}
```

### Step 2: Build Production APK/AAB

```bash
# Install EAS CLI
npm install -g eas-cli

# Login to Expo account
eas login

# Configure EAS build
cd MobileApp
eas build:configure

# Build for Android (AAB for Play Store)
eas build --platform android --profile production
```

**Or without EAS (local build):**
```bash
cd MobileApp
npx expo prebuild
cd android
./gradlew assembleRelease
# APK will be at: android/app/build/outputs/apk/release/app-release.apk
```

### Step 3: Google Play Console Setup

1. **Create App**
   - Go to: https://play.google.com/console
   - Click "Create App"
   - Fill in app details:
     - App name: CVApplyr
     - Default language: English (US)
     - App/Game: App
     - Free/Paid: Free

2. **Store Listing**
   - App name: CVApplyr
   - Short description: AI-powered cover letter generator and job application manager
   - Full description: Write compelling cover letters with AI assistance...
   - App icon: 512x512 PNG
   - Screenshots: Minimum 2 (1080x1920 recommended)
   - Feature graphic: 1024x500
   - Category: Business / Productivity
   - Email: cv@cvapplyr.com
   - Privacy Policy URL: https://cvapplyr.com/privacy-policy.html

3. **Content Rating**
   - Fill out questionnaire
   - Your app: No violence, no offensive content
   - Rating: Everyone

4. **Target Audience**
   - Age: 18+
   - Declare if app is designed for children: No

5. **App Content**
   - Privacy Policy: Provide URL
   - Ads: Select if you have ads
   - Permissions: Explain why you need camera/storage
   - Data Safety: Fill out what data you collect
     - Collect: Email, Name, Phone, Resume, Cover Letters
     - Encryption: In transit using HTTPS
     - Can users request deletion: Yes

6. **Upload AAB**
   - Go to "Production" → "Create new release"
   - Upload AAB file from EAS build
   - Release name: 1.0.0
   - Release notes: "Initial release"
   - Review and roll out

### Step 4: Review Process
- **Timeline:** 3-7 days typically
- **Common rejections:**
  - Missing privacy policy
  - Inappropriate permissions
  - Crashes on test devices
  - Metadata violations

---

## 🍎 APPLE APP STORE DEPLOYMENT

### Prerequisites
1. **Apple Developer Account** ($99/year)
2. **Mac computer** with Xcode installed
3. **Production server** with HTTPS

### Step 1: App Store Connect Setup

1. **Create App ID**
   - Go to: https://developer.apple.com/account
   - Certificates, IDs & Profiles → Identifiers
   - Click + to create new App ID
   - Bundle ID: `com.cvapplyr.mobile`

2. **Create App in App Store Connect**
   - Go to: https://appstoreconnect.apple.com
   - My Apps → + → New App
   - Platform: iOS
   - Name: CVApplyr
   - Bundle ID: com.cvapplyr.mobile
   - SKU: cvapplyr-001
   - User Access: Full Access

### Step 2: Build iOS App

```bash
cd MobileApp

# Build with EAS (recommended)
eas build --platform ios --profile production

# Or local build (requires Mac + Xcode)
npx expo prebuild
cd ios
pod install
xcodebuild -workspace CVApplyr.xcworkspace -scheme CVApplyr -configuration Release
```

### Step 3: App Information

1. **App Information**
   - Subtitle: AI Cover Letter Generator
   - Category: Business
   - Secondary Category: Productivity
   - Content Rights: Provide content license info

2. **Pricing and Availability**
   - Price: Free
   - Availability: All countries

3. **Privacy**
   - Privacy Policy URL: https://cvapplyr.com/privacy-policy.html
   - Privacy practices: Fill out data collection questionnaire

4. **App Privacy**
   - Data types collected:
     - Contact Info: Email, Name, Phone
     - User Content: Cover Letters, Resumes
     - Identifiers: User ID
   - Data usage: App functionality
   - Linked to user: Yes
   - Tracking: No

### Step 4: Version Information

1. **Screenshots** (Required for all device sizes)
   - iPhone 6.7": 1290x2796 (3 minimum)
   - iPhone 6.5": 1242x2688
   - iPhone 5.5": 1242x2208
   - iPad Pro 12.9": 2048x2732

2. **App Preview** (Optional but recommended)
   - 15-30 second video showing app features

3. **Promotional Text**
   "Create professional cover letters in minutes with AI assistance"

4. **Description**
   ```
   CVApplyr helps job seekers create compelling cover letters and manage job applications efficiently.
   
   FEATURES:
   • AI-powered cover letter generation
   • Template-based customization
   • Email integration
   • Application tracking
   • Credit-based system
   
   Perfect for professionals looking to streamline their job search.
   ```

5. **Keywords**
   "cover letter, resume, job application, AI, career, employment"

6. **Support URL**
   https://cvapplyr.com/contact.html

7. **Marketing URL** (Optional)
   https://cvapplyr.com

8. **Build**
   - Upload IPA file from EAS build
   - Or use Xcode → Archive → Distribute App

### Step 5: Submit for Review

1. **Export Compliance**
   - Your app uses encryption: Yes (HTTPS)
   - Exempt from regulations: Yes (standard encryption)

2. **Content Rights**
   - Confirm you have rights to all content

3. **Advertising Identifier**
   - Does your app use IDFA: No (unless you have ads)

4. **Submit**
   - Review your information
   - Click "Submit for Review"

### Step 6: Review Process
- **Timeline:** 24-48 hours typically
- **Common rejections:**
  - Crashes during testing
  - Missing functionality
  - Guideline violations
  - Incomplete metadata

---

## 🔧 PRE-SUBMISSION CHECKLIST

### Code Quality
- [ ] Remove all console.log statements (or wrap in __DEV__)
- [ ] Update PRODUCTION_API_URL in config.js
- [ ] Test app thoroughly on physical devices
- [ ] Verify all API endpoints work with production server
- [ ] Check app doesn't crash on network errors
- [ ] Implement proper error handling

### Configuration
- [ ] Update app.json with correct package name (Android)
- [ ] Set correct bundleIdentifier (iOS)
- [ ] Update version numbers
- [ ] Configure proper app icons (1024x1024 for iOS, adaptive for Android)
- [ ] Add splash screen
- [ ] Configure deep linking if needed

### Privacy & Security
- [ ] Privacy Policy accessible and complete
- [ ] Terms of Service accessible
- [ ] Implement data encryption for sensitive data
- [ ] Add permission descriptions (camera, storage, etc.)
- [ ] HTTPS for all API calls
- [ ] Secure token storage (AsyncStorage with encryption)

### Store Assets
- [ ] App icon (all required sizes)
- [ ] Screenshots (all device sizes)
- [ ] App description (compelling and accurate)
- [ ] Keywords for ASO (App Store Optimization)
- [ ] Feature graphic (Play Store)
- [ ] Promo video (optional but recommended)

### Legal
- [ ] Privacy Policy URL
- [ ] Terms of Service URL
- [ ] Age rating appropriate
- [ ] Content rating questionnaire completed
- [ ] Export compliance (for encryption)

### Testing
- [ ] Test on multiple devices (iOS + Android)
- [ ] Test different screen sizes
- [ ] Test offline behavior
- [ ] Test payment flow (if applicable)
- [ ] Test all user flows (login, register, profile, etc.)
- [ ] Test with low network connectivity
- [ ] Memory leak testing

---

## 🚀 QUICK START COMMANDS

### Production Build (Android)
```bash
cd MobileApp
eas build --platform android --profile production
```

### Production Build (iOS)
```bash
cd MobileApp
eas build --platform ios --profile production
```

### Update Version
```bash
# Update app.json
"version": "1.0.1",  # Semantic version
"android": { "versionCode": 2 },  # Integer, increment each release
"ios": { "buildNumber": "2" }     # String, increment each release
```

---

## 📊 POST-LAUNCH CHECKLIST

### Monitoring
- [ ] Set up crash reporting (Sentry, Firebase Crashlytics)
- [ ] Set up analytics (Firebase Analytics, Mixpanel)
- [ ] Monitor app store reviews
- [ ] Track download numbers
- [ ] Monitor API server performance

### Marketing
- [ ] Announce on social media
- [ ] Email existing users
- [ ] Submit to app review sites
- [ ] Create landing page
- [ ] ASO optimization (keywords, screenshots)

### Maintenance
- [ ] Plan update schedule
- [ ] Bug fix priority system
- [ ] User feedback collection
- [ ] Feature roadmap

---

## 📞 SUPPORT RESOURCES

- **Expo Documentation:** https://docs.expo.dev
- **Google Play Console Help:** https://support.google.com/googleplay/android-developer
- **App Store Connect Help:** https://developer.apple.com/support/app-store-connect/
- **EAS Build:** https://docs.expo.dev/build/introduction/

---

## ⚠️ CRITICAL WARNINGS

1. **Never commit API keys or secrets to git**
2. **Always test payment flow in sandbox first**
3. **Backup your signing keys securely**
4. **Keep production API separate from development**
5. **Monitor server costs after launch**
6. **Have rollback plan ready**
7. **Test app on clean devices (not developer devices)**
