# Lettrico iOS App

Modern iOS application for Lettrico - "Turn applications into opportunities"

## Overview

The Lettrico iOS app is built with SwiftUI, Apple's modern UI framework, providing a seamless experience for generating and managing cover letters on iOS devices.

## Features

✅ **Modern Authentication**
- Login with email and password
- User registration
- Secure token storage using Keychain
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

- **Language**: Swift
- **UI Framework**: SwiftUI
- **Architecture**: MVVM with ObservableObject
- **Networking**: URLSession with async/await
- **Storage**: Keychain (secure), UserDefaults
- **Minimum iOS Version**: iOS 15.0+

## Project Structure

```
ios/
├── Lettrico.xcodeproj/
├── Lettrico/
│   ├── App/
│   │   └── LettricoApp.swift          # App entry point
│   ├── Models/
│   │   └── User.swift                 # Data models
│   ├── Services/
│   │   ├── APIClient.swift            # Backend API communication
│   │   └── AuthManager.swift          # Authentication logic
│   └── Views/
│       ├── LoginView.swift            # Login screen
│       ├── RegisterView.swift         # Registration screen
│       └── MainTabView.swift          # Main app navigation
└── README.md
```

## Setup Instructions

### Prerequisites
- Xcode 14.0+
- iOS 15.0+
- Apple Developer Account (for deployment)

### Installation

1. Open `Lettrico.xcodeproj` in Xcode
2. Select the target device or simulator
3. Press Cmd + R to build and run

### Configuration

Update the API base URL in `APIClient.swift`:
```swift
private let baseURL = "http://localhost:3000"  // Change for production
```

## API Integration

The app communicates with the Lettrico backend API:
- Login/Register endpoints
- Cover letter generation
- User profile management

All requests include proper error handling and loading states.

## Design Highlights

✨ **Modern UI/UX**
- Gradient backgrounds matching web app
- SwiftUI native components
- Smooth animations and transitions
- Responsive layouts

🎨 **Color Scheme**
- Primary: Blue (#1E40AF)
- Secondary: Green (#059669)
- Accent: Light Blue (#3B82F6)

## Development Guide

### Adding New Features

1. Create model in `Models/`
2. Add API methods in `APIClient.swift`
3. Create view in `Views/`
4. Update `AuthManager` if needed for state management

### State Management

Uses `@StateObject`, `@EnvironmentObject`, and `@Published` properties for reactive updates.

## Testing

- Test on multiple iOS versions
- Test on different device sizes
- Verify API connectivity
- Test offline scenarios

## Deployment

### Requirements
- Apple Developer Program membership
- App signing certificates
- Provisioning profiles

### Steps
1. Archive the app (Product > Archive)
2. Validate content
3. Upload to App Store Connect
4. Submit for review

## Security Considerations

✅ Credentials stored in Keychain (not UserDefaults)
✅ HTTPS for all API calls (configure for production)
✅ Token validation on every request
✅ Session timeout handling

## Future Enhancements

- Push notifications
- Biometric authentication
- Offline support with local caching
- Widget support
- Photo/document scanning
- Share functionality

## Support

For issues or questions, refer to the main Lettrico documentation or contact support.

## License

MIT License - See main project LICENSE file
