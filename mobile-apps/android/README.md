# Lettrico Android App

Modern Android application for Lettrico - "Turn applications into opportunities"

## Overview

The Lettrico Android app is built with Kotlin and Jetpack Compose, providing a modern, declarative UI experience for generating and managing cover letters on Android devices.

## Features

✅ **Modern Authentication**
- Login with email and password
- User registration
- Secure token storage using DataStore
- Session persistence

✅ **Cover Letter Generation**
- Generate custom cover letters
- Company research integration
- AI-powered content creation
- Multiple export options

✅ **Profile Management**
- View and edit user profile
- Manage resume and documents
- Track applications

✅ **Dashboard**
- View statistics
- Track generated letters
- Monitor sent applications

## Technology Stack

- **Language**: Kotlin
- **UI Framework**: Jetpack Compose
- **Architecture**: MVVM with Clean Architecture
- **Networking**: Retrofit + OkHttp
- **Serialization**: Kotlinx Serialization
- **Dependency Injection**: Koin
- **Database**: Room Database + DataStore
- **Async**: Coroutines + Flow
- **Minimum Android Version**: Android 7.0 (API 24)
- **Target Android Version**: Android 14 (API 34)

## Project Structure

```
android/
├── src/main/
│   ├── java/com/lettrico/app/
│   │   ├── MainActivity.kt                    # App entry point
│   │   ├── AppModule.kt                       # Dependency injection
│   │   ├── data/
│   │   │   ├── api/
│   │   │   │   ├── ApiClient.kt              # Retrofit configuration
│   │   │   │   ├── ApiService.kt             # API endpoints
│   │   │   │   └── Models.kt                 # Data classes
│   │   │   └── repository/
│   │   │       ├── AuthRepository.kt         # Auth operations
│   │   │       └── CoverLetterRepository.kt  # Cover letter operations
│   │   ├── domain/
│   │   │   └── usecase/
│   │   │       └── UseCases.kt               # Business logic
│   │   └── presentation/
│   │       ├── viewmodel/
│   │       │   └── ViewModels.kt             # State management
│   │       └── ui/
│   │           ├── screens/
│   │           │   └── Screens.kt            # Composables
│   │           ├── navigation/
│   │           │   └── NavGraph.kt           # Navigation
│   │           └── theme/
│   │               ├── Theme.kt              # Color scheme
│   │               └── Typography.kt         # Text styles
│   └── AndroidManifest.xml
├── build.gradle                              # Dependencies
└── README.md
```

## Setup Instructions

### Prerequisites
- Android Studio 2022.1 or later
- JDK 17+
- Android SDK 24+ installed
- Minimum Android device/emulator: Android 7.0

### Installation

1. Open the project in Android Studio
2. Sync Gradle files (File > Sync Now)
3. Build the project (Build > Make Project)
4. Run on emulator or physical device (Run > Run 'app')

### Configuration

Update the API base URL in `ApiClient.kt`:
```kotlin
private const val BASE_URL = "http://localhost:3000"  // Change for production
```

For physical device testing, replace `localhost` with your backend server's IP address.

## API Integration

The app communicates with the Lettrico backend API:
- Login/Register endpoints
- Cover letter generation
- User profile management

All requests include proper error handling and loading states using Kotlin Flow and StateFlow.

## Design Highlights

✨ **Modern UI/UX with Jetpack Compose**
- Gradient backgrounds matching web app
- Material 3 components and design system
- Smooth animations and transitions
- Responsive layouts for various screen sizes

🎨 **Color Scheme (Material 3)**
- Primary: Blue (#1E40AF)
- Secondary: Green (#059669)
- Tertiary: Light Blue (#3B82F6)
- Light/Dark mode support

## Development Guide

### Adding New Features

1. Create API endpoints in `ApiService.kt`
2. Add repository methods in `Repository.kt`
3. Create use case in `domain/usecase/`
4. Add ViewModel in `presentation/viewmodel/`
5. Create Composable screens in `ui/screens/`
6. Update navigation in `NavGraph.kt`

### State Management

Uses `MutableStateFlow` and `StateFlow` for reactive data management with proper lifecycle awareness through `ViewModel`.

### Async Operations

All network calls use Kotlin Coroutines with `viewModelScope` for proper lifecycle management.

## Build & Run

### Debug Build
```bash
./gradlew assembleDebug
```

### Release Build
```bash
./gradlew assembleRelease
```

### Run Tests
```bash
./gradlew test
./gradlew connectedAndroidTest
```

## Deployment

### Requirements
- Signed keystore for app signing
- Google Play Developer account
- App bundle or APK

### Steps
1. Create signed app bundle: Build > Generate Signed Bundle / APK
2. Upload to Google Play Console
3. Complete store listing and submit for review

## Security Considerations

✅ Credentials stored in DataStore (encrypted)
✅ HTTPS enforced for API calls (configure for production)
✅ Token validation on every request
✅ Secure session management with expiration
✅ No sensitive data in logs (except debug builds)

## Future Enhancements

- Push notifications with FCM
- Biometric authentication (fingerprint/face)
- Offline support with local sync
- Cloud backup functionality
- Share cover letters via social media
- Document scanning with ML Kit
- Advanced analytics

## Troubleshooting

### API Connection Issues
- Verify API base URL is correct
- Check firewall/network settings
- Ensure backend server is running

### Gradle Sync Issues
- Clear Gradle cache: File > Invalidate Caches
- Update Android Studio to latest version
- Check internet connection

### Build Errors
- Clean and rebuild: Build > Clean Project, then Build > Rebuild Project
- Check JDK version (should be 17+)
- Verify all dependencies in build.gradle

## Support

For issues or questions, refer to the main Lettrico documentation or contact support.

## License

MIT License - See main project LICENSE file
