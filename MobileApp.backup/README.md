# Lettrico Mobile App

A React Native mobile application for Lettrico - the AI-powered cover letter generation platform. Built with Expo for easy iOS and Android deployment.

## Features

✨ **AI-Powered Cover Letter Generation** - Generate personalized cover letters instantly  
📋 **Application Tracking** - Keep track of all your job applications  
📱 **Cross-Platform** - Works seamlessly on iOS and Android  
🔐 **Secure Authentication** - Google OAuth and email/password login  
👤 **Profile Management** - Manage your profile information  
🎨 **Beautiful UI** - Clean, modern interface optimized for mobile

## Prerequisites

- Node.js 16+ and npm/yarn
- Expo CLI: `npm install -g expo-cli`
- iOS development:
  - Xcode (for iOS simulator or device testing)
  - Apple Developer Account ($99/year) for App Store deployment
- Android development:
  - Android Studio (for Android emulator or device testing)
  - Google Play Developer Account ($25 one-time) for Play Store deployment

## Installation

1. **Install dependencies:**
```bash
npm install
# or
yarn install
```

2. **Create .env file in MobileApp directory:**
```
API_BASE_URL=http://localhost:3000
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
```

3. **Start the development server:**
```bash
npx expo start
```

## Development

### Run on iOS Simulator
```bash
npx expo start --ios
```

### Run on Android Emulator
```bash
npx expo start --android
```

### Run on Physical Device
1. Install Expo Go app from App Store or Play Store
2. Scan QR code displayed in terminal with your device camera
3. App will open in Expo Go

## Project Structure

```
MobileApp/
├── src/
│   └── screens/
│       ├── LoginScreen.js           # Login & Google OAuth
│       ├── RegisterScreen.js        # User registration
│       ├── DashboardScreen.js       # Main dashboard
│       ├── ApplicationsScreen.js    # View applications
│       ├── ProfileScreen.js         # Profile management
│       └── GenerateCoverLetterScreen.js  # AI cover letter generation
├── App.js                           # Root navigator & auth flow
├── app.json                         # Expo configuration
├── package.json                     # Dependencies
└── README.md
```

## Screen Components

### LoginScreen
- Email/Password login
- Google OAuth login
- Link to registration

### RegisterScreen
- User registration form
- Password validation
- Auto-login after registration

### DashboardScreen
- Welcome greeting
- Application statistics
- Quick action buttons
- Logout functionality

### ApplicationsScreen
- List all job applications
- View application details
- Delete applications
- Cover letter status indicator

### ProfileScreen
- Edit profile information (name, email, phone, location, bio)
- Account settings
- Privacy and security options

### GenerateCoverLetterScreen
- Input company and position details
- AI-powered cover letter generation
- Save generated letters
- Edit and regenerate options

## Building for Production

### iOS App Store

1. **Install Apple Developer Certificate**
   - Create certificate in Apple Developer Portal
   - Download and install locally

2. **Configure signing credentials in app.json:**
```json
{
  "ios": {
    "bundleIdentifier": "com.lettrico.mobile",
    "team": "YOUR_TEAM_ID"
  }
}
```

3. **Build for iOS:**
```bash
eas build --platform ios
```

4. **Upload to App Store Connect**
   - Use Transporter app to upload the build
   - Submit for review

### Android Play Store

1. **Generate signing key:**
```bash
eas credentials
```

2. **Build for Android:**
```bash
eas build --platform android
```

3. **Upload to Google Play Console**
   - Go to Play Console
   - Select your app
   - Navigate to Release > Production
   - Upload APK/AAB file

## API Endpoints

The app communicates with the backend using these endpoints:

- **POST** `/api/auth/login` - Email/password login
- **POST** `/api/auth/register` - User registration
- **GET** `/api/profile` - Fetch user profile
- **PUT** `/api/profile` - Update user profile
- **GET** `/api/dashboard/stats` - Get application statistics
- **GET** `/api/applications` - List all applications
- **POST** `/api/applications` - Create new application
- **DELETE** `/api/applications/:id` - Delete application
- **POST** `/api/generate-cover-letter` - Generate cover letter
- **POST** `/api/save-cover-letter` - Save generated cover letter

## Security

- Tokens stored securely using `expo-secure-store`
- All API calls require Bearer token authentication
- SSL/TLS for production API communication
- HTTPS redirect required for OAuth callbacks

## Troubleshooting

### Port Already in Use
If port 3000 is already in use:
```bash
lsof -i :3000
kill -9 <PID>
```

### Clear Cache
```bash
npx expo start --clear
```

### Rebuild Node Modules
```bash
rm -rf node_modules
npm install
```

### OAuth Not Working
- Verify Google OAuth credentials in .env
- Check redirect URI matches app.json bundleIdentifier
- Ensure backend server is running

## Configuration Files

### app.json
Contains Expo configuration including:
- App name and version
- Bundle identifiers (iOS/Android)
- Splash screen and icons
- Permissions
- API endpoints

### package.json
Contains npm dependencies and build scripts

## Support

For issues or questions:
1. Check the troubleshooting section
2. Review logs in Expo CLI
3. Check backend server logs
4. Review API endpoint availability

## License

MIT

## Next Steps

1. Update backend API endpoint in .env
2. Add Google OAuth credentials
3. Configure database with running backend
4. Test on iOS simulator/Android emulator
5. Build and deploy to app stores

---

**Version**: 1.0.0  
**Last Updated**: 2024
