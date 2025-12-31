# Lettrico Mobile App - Quick Start Guide

Get up and running with Lettrico mobile app in 5 minutes!

## 🚀 Quick Setup

### 1. Install Dependencies

```bash
# Navigate to mobile app directory
cd MobileApp

# Install npm packages
npm install
```

### 2. Configure Environment

Create `.env` file in `MobileApp/` directory:

```env
API_BASE_URL=http://localhost:3000
```

### 3. Start Development Server

**Terminal 1 - Backend:**
```bash
cd ..
npm start
# Backend runs on http://localhost:3000
```

**Terminal 2 - Mobile App:**
```bash
cd MobileApp
npx expo start
```

### 4. Run on Simulator/Device

**iOS Simulator:**
```bash
# Press 'i' in Expo CLI
# Or: npx expo start --ios
```

**Android Emulator:**
```bash
# Press 'a' in Expo CLI
# Or: npx expo start --android
```

**Physical Device:**
- Install "Expo Go" app from App Store or Play Store
- Scan QR code shown in terminal

## 📁 Project Structure

```
MobileApp/
├── src/
│   ├── screens/              # All screen components
│   │   ├── LoginScreen.js
│   │   ├── RegisterScreen.js
│   │   ├── DashboardScreen.js
│   │   ├── ApplicationsScreen.js
│   │   ├── ProfileScreen.js
│   │   └── GenerateCoverLetterScreen.js
│   ├── services/             # API services
│   │   └── api.js            # Axios instance & API calls
│   ├── utils/                # Helper functions
│   │   └── helpers.js        # Common utilities
│   └── config.js             # App configuration
├── App.js                     # Root navigator
├── app.json                   # Expo configuration
├── package.json               # Dependencies
├── README.md                  # Full documentation
├── DEPLOYMENT_GUIDE.md        # App store guides
└── .env                       # Environment variables
```

## 🎯 Key Files Explained

### App.js
Root navigation component. Handles:
- Authentication flow (AuthStack vs AppStack)
- Token checking
- Tab navigation for main app

### src/config.js
Centralized configuration including:
- API endpoints
- Color scheme
- Feature flags
- Validation rules

### src/services/api.js
Axios wrapper with:
- Base URL configuration
- Token injection via interceptors
- Error handling
- Organized API endpoints

### src/screens/*.js
Individual screen components with:
- Form handling
- API integration
- Navigation
- Error handling

## 🔑 Key Features

### Authentication
- Email/Password login & registration
- Google OAuth (ready to integrate)
- Secure token storage
- Auto-logout on token expiration

### Cover Letter Generation
- AI-powered generation via backend
- Save generated letters
- Edit and regenerate
- Track letter status

### Application Management
- Add new job applications
- View application list
- Track cover letter status
- Delete applications
- View application statistics

### Profile Management
- Edit personal information
- Update contact details
- Manage account settings
- Change password

## 🔌 API Integration

All API calls use the configured axios instance in `api.js`:

```javascript
// Example: Login
import { authAPI } from './src/services/api';

const response = await authAPI.login(email, password);
// Returns: { success, token, user }

// Example: Get dashboard stats
import { applicationsAPI } from './src/services/api';

const stats = await applicationsAPI.getStats();
// Returns: { totalApplications, coveredApplications, pendingApplications }
```

## 🛠️ Common Tasks

### Add a New Screen

1. Create component in `src/screens/MyScreen.js`
2. Add to navigator in `App.js`
3. Import in App.js

```javascript
// App.js
import MyScreen from './src/screens/MyScreen';

// In AppStack or AuthStack:
<Stack.Screen name="MyScreen" component={MyScreen} />
```

### Call an API Endpoint

```javascript
import { authAPI } from '../services/api';

const handleLogin = async () => {
  try {
    const response = await authAPI.login(email, password);
    // Handle success
  } catch (error) {
    // Handle error
  }
};
```

### Store Data Securely

```javascript
import { storageUtils } from '../utils/helpers';

// Save token
await storageUtils.set('authToken', token);

// Get token
const token = await storageUtils.get('authToken');

// Delete token
await storageUtils.remove('authToken');
```

### Format Dates

```javascript
import { dateUtils } from '../utils/helpers';

// Format date
dateUtils.formatDate('2024-01-15'); // "Jan 15, 2024"

// Get relative time
dateUtils.getRelativeTime('2024-01-15'); // "2d ago"

// Get days until
dateUtils.getDaysUntil('2024-12-25'); // Days until date
```

## 🎨 Styling

App uses consistent color scheme defined in `src/config.js`:

```javascript
import { config } from './src/config';

// In StyleSheet
backgroundColor: config.COLORS.primary      // #1e40af
color: config.COLORS.text.primary          // #1f2937
borderColor: config.COLORS.border          // #e2e8f0
```

## 🧪 Testing Credentials

**Test Account (Development):**
- Email: test@example.com
- Password: test123456

First create account via Register screen with above credentials.

## 📱 Screen Navigation

```
Login Screen
  └─ Register Screen
     └─ Dashboard (Authenticated)
        ├─ Dashboard
        ├─ Generate Cover Letter
        ├─ Applications
        └─ Profile
```

## 🔍 Debugging

### View Console Logs
```bash
# In Expo CLI terminal, press 'j' to open debugger
```

### Check API Calls
Enable logging in `src/services/api.js`:
```javascript
api.interceptors.request.use((config) => {
  console.log('API Request:', config.url, config.data);
  return config;
});
```

### Clear Cache
```bash
npx expo start --clear
```

## 📦 Building

### Development Build
```bash
eas build --platform ios --profile preview
eas build --platform android --profile preview
```

### Production Build
```bash
eas build --platform ios
eas build --platform android
```

See `DEPLOYMENT_GUIDE.md` for detailed instructions.

## ⚙️ Environment Variables

Create `.env` file with:

```env
# API Configuration
API_BASE_URL=http://localhost:3000

# Google OAuth (Optional)
GOOGLE_CLIENT_ID=your_client_id

# Feature Flags
ENABLE_GOOGLE_LOGIN=true
ENABLE_COVER_LETTER_AI=true
```

## 🚨 Common Issues

**Port 3000 already in use:**
```bash
lsof -i :3000
kill -9 <PID>
```

**App keeps reloading:**
```bash
npx expo start --clear
```

**Token not being saved:**
Check that `expo-secure-store` is properly installed.

**API calls failing:**
- Ensure backend is running on http://localhost:3000
- Check .env API_BASE_URL
- Check network connectivity

## 📚 Next Steps

1. ✅ Install and run locally
2. ✅ Test login/registration
3. ✅ Test all screen navigation
4. ✅ Test API integration
5. Configure Google OAuth
6. Set up Expo EAS build
7. Prepare App Store accounts
8. Build and deploy

## 📖 Documentation

- [README.md](./README.md) - Full documentation
- [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md) - App store deployment
- [Expo Docs](https://docs.expo.dev)
- [React Native Docs](https://reactnative.dev)

## 💬 Support

For issues:
1. Check the troubleshooting section
2. Review console logs in Expo
3. Check backend API logs
4. Verify configuration

## 📝 Notes

- Mobile app requires backend running
- All API endpoints need Bearer token authentication
- Tokens stored securely using expo-secure-store
- Auto-logout after 24 hours of inactivity

---

**Happy Coding! 🎉**

Questions? Check the full README.md or DEPLOYMENT_GUIDE.md for more details.
