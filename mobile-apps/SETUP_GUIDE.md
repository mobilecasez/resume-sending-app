# Mobile Apps Setup Guide

This guide covers the iOS and Android development setup for the Lettrico mobile applications.

## Overview

Lettrico has two native mobile applications built with modern technologies:
- **iOS**: Built with Swift and SwiftUI
- **Android**: Built with Kotlin and Jetpack Compose

Both apps provide feature parity with the web application, including user authentication, cover letter generation, and profile management.

## Directory Structure

```
mobile-apps/
├── ios/
│   ├── Lettrico.xcodeproj/          # Xcode project
│   ├── Lettrico/
│   │   ├── App/
│   │   ├── Models/
│   │   ├── Services/
│   │   └── Views/
│   └── README.md
│
└── android/
    ├── build.gradle                  # Gradle configuration
    ├── src/
    │   └── main/
    │       ├── java/com/lettrico/app/
    │       │   ├── data/
    │       │   ├── domain/
    │       │   ├── presentation/
    │       │   └── ui/
    │       └── AndroidManifest.xml
    └── README.md
```

## iOS Setup

### Prerequisites
- macOS 12.0 or later
- Xcode 14.0+
- iOS 15.0+ compatible device or simulator

### Installation Steps

1. **Navigate to iOS directory**
   ```bash
   cd mobile-apps/ios
   ```

2. **Open project in Xcode**
   ```bash
   open Lettrico.xcodeproj
   ```

3. **Configure signing** (for deployment)
   - Select the project in Xcode
   - Choose the target
   - Go to Signing & Capabilities
   - Select your development team

4. **Build and run**
   - Select target device/simulator
   - Press Cmd + R or click Run

### Development

**Key directories:**
- `Lettrico/App/` - Application entry point and configuration
- `Lettrico/Models/` - Data models and API response types
- `Lettrico/Services/` - API client and authentication manager
- `Lettrico/Views/` - SwiftUI components and screens

**Project architecture:**
- **Model**: Data structures (User, CoverLetter, etc.)
- **View**: SwiftUI components for UI
- **ViewModel**: ObservableObject for state management
- **Service**: API communication and data persistence

### API Configuration

Edit `Lettrico/Services/APIClient.swift` to change the backend URL:

```swift
private let baseURL = "http://localhost:3000"
// For production:
// private let baseURL = "https://api.lettrico.com"
```

### Testing

Run tests using Xcode:
- Product > Test (Cmd + U)
- Or run specific test file

### Common Issues

**Build Failures**
- Clean Build Folder: Cmd + Shift + K
- Delete Derived Data: ~/Library/Developer/Xcode/DerivedData
- Update Xcode command line tools: xcode-select --install

**Simulator Issues**
- Reset simulator: xcrun simctl erase all
- Restart Xcode and simulator

## Android Setup

### Prerequisites
- Android Studio 2022.1 or later
- JDK 17+
- Android SDK 24+ (Android 7.0)
- Emulator or physical device

### Installation Steps

1. **Navigate to Android directory**
   ```bash
   cd mobile-apps/android
   ```

2. **Open project in Android Studio**
   - File > Open > Select android directory
   - Wait for Gradle sync to complete

3. **Configure SDK (if needed)**
   - Tools > SDK Manager
   - Install Android SDK 34+ (latest)
   - Install Android Emulator

4. **Run on emulator**
   - AVD Manager > Create or select device
   - Click Run (Shift + F10) or use Run menu

5. **Run on physical device**
   - Enable Developer Mode: Settings > About > tap Build Number 7 times
   - Enable USB Debugging: Developer options > USB Debugging
   - Connect via USB
   - Click Run in Android Studio

### Development

**Key directories:**
- `src/main/java/com/lettrico/app/` - Main application code
- `data/` - API clients and repositories
- `domain/` - Business logic and use cases
- `presentation/` - ViewModels and UI state
- `ui/` - Composable screens and themes

**Project architecture (Clean + MVVM):**
- **Data Layer**: API communication, repository pattern
- **Domain Layer**: Use cases and business logic
- **Presentation Layer**: ViewModels for state
- **UI Layer**: Jetpack Compose components

### API Configuration

Edit `src/main/java/com/lettrico/app/data/api/ApiClient.kt`:

```kotlin
private const val BASE_URL = "http://localhost:3000"
// For production:
// private const val BASE_URL = "https://api.lettrico.com"

// For physical device on local network:
// private const val BASE_URL = "http://192.168.1.100:3000"
```

### Build & Run

**Debug build:**
```bash
./gradlew assembleDebug
```

**Run on device:**
```bash
./gradlew installDebug
adb shell am start -n com.lettrico.app/.MainActivity
```

**View logs:**
```bash
adb logcat
```

### Common Issues

**Gradle Sync Failures**
- File > Invalidate Caches > Invalidate and Restart
- Delete .gradle folder: rm -rf ~/.gradle
- Run: ./gradlew clean

**Build Errors**
- Check JDK version: javac -version (should be 17+)
- Update Gradle wrapper: ./gradlew wrapper --gradle-version=latest

**Emulator Issues**
- Increase RAM: AVD Manager > Device > Edit > Memory (2GB+)
- Enable hardware acceleration if available
- Restart emulator: AVD Manager > Cold Boot

## Local Development Setup

### Backend Connection (Localhost)

**iOS - Simulator:**
```swift
// Uses http://localhost:3000 by default
// Simulator can reach host machine's localhost
```

**Android - Emulator:**
```kotlin
// Update to reach host machine:
private const val BASE_URL = "http://10.0.2.2:3000"
```

**Android - Physical Device:**
```kotlin
// Replace with your computer's IP:
private const val BASE_URL = "http://192.168.1.100:3000"
```

Find your IP:
```bash
# macOS/Linux
ifconfig | grep "inet "

# Windows
ipconfig
```

## Authentication Testing

Both apps support:
1. **Email/Password Login**
   - Test account: test@example.com / password123
   - Or create new account

2. **OAuth** (Web only for now)
   - Mobile apps have email/password auth
   - Can be extended with OAuth later

## Deployment Checklist

### iOS Deployment
- [ ] Update version number in Xcode
- [ ] Test on multiple iOS versions
- [ ] Create App Store Connect account
- [ ] Generate signing certificate
- [ ] Create provisioning profiles
- [ ] Build archive and validate
- [ ] Submit to App Store Review
- [ ] Complete App Store listing
- [ ] Set release date

### Android Deployment
- [ ] Update version code and name
- [ ] Test on multiple Android versions
- [ ] Create Google Play Developer account
- [ ] Generate release keystore
- [ ] Sign APK or AAB
- [ ] Create Play Store listing
- [ ] Upload app bundle
- [ ] Set rating and content
- [ ] Submit for review

## Debugging

### iOS Debugging
- Use Xcode debugger: Debug > Attach to Process
- View console output: View > Debug Area > Show Console
- Network debugging: Product > Scheme > Edit Scheme > Logging

### Android Debugging
- Android Studio Logcat: View > Tool Windows > Logcat
- Layout inspector: Tools > Layout Inspector
- Network traffic: Tools > App Inspection

## Performance Optimization

### iOS
- Use Instruments for profiling: Xcode > Product > Profile
- Monitor memory usage
- Optimize image loading
- Profile network calls

### Android
- Android Studio Profiler: View > Tool Windows > Profiler
- Monitor CPU, memory, network
- Use LeakCanary for memory leaks
- Profile rendering performance

## API Documentation

### Authentication Endpoints
```
POST /api/auth/login
POST /api/auth/register
```

### User Endpoints
```
GET /api/user/profile
PUT /api/user/profile
```

### Cover Letter Endpoints
```
POST /api/cover-letter/generate
GET /api/cover-letter/list
DELETE /api/cover-letter/:id
```

Full API documentation available in main project README.

## Version Control

**.gitignore** entries for mobile apps:
```
# iOS
ios/Lettrico.xcodeproj/xcuserdata/
ios/Lettrico.xcodeproj/project.xcworkspace/xcuserdata/
ios/Lettrico/xcuserdata/
ios/Pods/

# Android
android/.gradle/
android/build/
android/.idea/
android/local.properties
android/gradle.properties
```

## Support & Resources

- [iOS SwiftUI Documentation](https://developer.apple.com/xcode/swiftui/)
- [Android Jetpack Compose Documentation](https://developer.android.com/jetpack/compose)
- [Retrofit Documentation](https://square.github.io/retrofit/)
- [Koin Dependency Injection](https://insert-koin.io/)

## Next Steps

1. **Complete the mobile apps:**
   - Implement cover letter generation screen
   - Add profile editing functionality
   - Implement settings and preferences
   - Add document upload/storage

2. **Advanced features:**
   - Implement caching strategy
   - Add offline support
   - Push notifications setup
   - Biometric authentication

3. **Testing:**
   - Unit tests for ViewModels
   - Integration tests for API
   - UI tests for screens

4. **Deployment:**
   - Setup CI/CD pipeline
   - Automated testing
   - App Store/Play Store submission

## Troubleshooting Checklist

| Issue | iOS | Android |
|-------|-----|---------|
| API Connection | Check base URL | Check emulator IP or device IP |
| Build Fails | Clean DerivedData | ./gradlew clean |
| Simulator/Emulator Slow | Increase RAM | Enable hardware acceleration |
| Login Fails | Check credentials | Check token storage |
| Network Error | Check firewall | Check app permissions |

---

**Last Updated:** 2024
**Version:** 1.0.0
**Status:** Ready for Development
