# Lettrico Mobile App - File Structure Guide

Complete guide to understanding and navigating the mobile app codebase.

## Directory Structure

```
MobileApp/
├── src/
│   ├── screens/                         # Individual screen components
│   │   ├── LoginScreen.js               # User login & authentication
│   │   ├── RegisterScreen.js            # New user registration
│   │   ├── DashboardScreen.js           # Main dashboard with stats
│   │   ├── ApplicationsScreen.js        # View & manage applications
│   │   ├── ProfileScreen.js             # User profile management
│   │   └── GenerateCoverLetterScreen.js # AI cover letter generation
│   │
│   ├── services/                        # API & external services
│   │   └── api.js                       # Axios instance & API endpoints
│   │
│   ├── utils/                           # Utility & helper functions
│   │   └── helpers.js                   # Common helper functions
│   │
│   └── config.js                        # Central configuration file
│
├── public/                              # Static assets (if used)
├── node_modules/                        # npm packages (auto-generated)
│
├── App.js                               # Root application file
├── app.json                             # Expo configuration
├── package.json                         # npm dependencies & scripts
├── package-lock.json                    # Locked dependencies
├── .env                                 # Environment variables
├── .gitignore                           # Git ignore rules
│
├── README.md                            # Full documentation
├── QUICKSTART.md                        # Quick start guide
├── DEPLOYMENT_GUIDE.md                  # App store deployment
├── DEPLOYMENT_CHECKLIST.md              # Pre-launch checklist
├── IMPLEMENTATION_SUMMARY.md            # Complete overview
└── FILE_STRUCTURE.md                    # This file
```

## File-by-File Explanation

### 🎯 Root Level Files

#### App.js (138 lines)
**Purpose:** Root application file with navigation setup
**Key Components:**
- `AuthStack()` - Navigation for unauthenticated users
- `AppStack()` - Tab navigation for authenticated users
- `RootNavigator()` - Token checking and route switching
- `App()` - Main export with StatusBar

**Key Features:**
- Token persistence checking
- Auth/App stack switching
- Tab navigator with 4 screens
- Material Icons for tab icons
- Loading state handling

**When to modify:** Adding new screens, changing navigation structure

#### app.json (43 lines)
**Purpose:** Expo and app configuration
**Contains:**
- App name, version, slug
- Icon and splash screen paths
- iOS bundle identifier (com.lettrico.mobile)
- Android package (com.lettrico.mobile)
- Platforms supported
- Permissions required
- Build configuration
- Adaptive icon settings

**When to modify:** App versioning, adding permissions, changing bundle IDs

#### package.json
**Purpose:** npm package management and scripts
**Contains:**
- Project name, version, description
- Dependencies list
- Dev dependencies
- npm scripts (start, build, etc.)
- Expo configuration

**Key Dependencies:**
- expo - Expo framework
- react-native - React Native core
- react-navigation - Navigation library
- axios - HTTP client
- expo-secure-store - Secure storage
- Material Icons - Icon library

**When to modify:** Adding new packages, changing scripts

#### .env (Example)
**Purpose:** Environment variables (never commit to git)
**Contains:**
- API_BASE_URL
- Google OAuth credentials
- Feature flags
- API keys and secrets

**Security:** Always in .gitignore, never version controlled

---

### 🖥️ Screen Components (src/screens/)

#### LoginScreen.js (~160 lines)
**Purpose:** User login and authentication
**Exports:** LoginScreen component

**Props Received:**
- `navigation` - Navigation object from React Navigation

**State Variables:**
- `email` - User email input
- `password` - User password input
- `loading` - Loading state during login

**Functions:**
- `handleLogin()` - Authenticate user with email/password
- `handleGoogleLogin()` - Google OAuth (placeholder)

**API Calls:**
- POST `/api/auth/login`

**Features:**
- Email validation
- Password requirements (min 6 chars)
- Secure token storage
- Error handling with alerts
- Google OAuth button
- Link to registration
- Loading indicator

**When to modify:** Changing login UI, adding OAuth providers, changing validation rules

---

#### RegisterScreen.js (~180 lines)
**Purpose:** User registration and account creation
**Exports:** RegisterScreen component

**State Variables:**
- `name` - User full name
- `email` - User email
- `password` - User password
- `confirmPassword` - Password confirmation
- `loading` - Loading state

**Functions:**
- `handleRegister()` - Create new user account
- Password validation logic
- Form submission handler

**API Calls:**
- POST `/api/auth/register`

**Features:**
- Name, email, password inputs
- Password confirmation matching
- Password length validation (min 6)
- Error messages for validation
- Auto-login after registration
- Back button to login
- Loading state

**When to modify:** Adding more registration fields, changing validation, adding terms acceptance

---

#### DashboardScreen.js (~140 lines)
**Purpose:** Main dashboard with application statistics
**Exports:** DashboardScreen component

**State Variables:**
- `user` - Current user data
- `stats` - Application statistics
- `loading` - Loading state
- `refreshing` - Pull-to-refresh state

**Functions:**
- `loadDashboard()` - Fetch user data and stats
- `onRefresh()` - Handle pull-to-refresh
- `handleLogout()` - Logout user

**API Calls:**
- GET `/api/dashboard/stats`

**Features:**
- Personalized greeting
- Statistics cards (total, covered, pending)
- Quick action buttons
- Pull-to-refresh support
- Logout with confirmation
- Loading state

**When to modify:** Adding more stats, changing action buttons, adding widgets

---

#### GenerateCoverLetterScreen.js (~200 lines)
**Purpose:** AI-powered cover letter generation
**Exports:** GenerateCoverLetterScreen component

**State Variables:**
- `formData` - Form inputs (company, position, etc.)
- `loading` - Loading state
- `generatedLetter` - Generated letter content

**Functions:**
- `handleInputChange()` - Update form fields
- `handleGenerate()` - Call AI generation API
- `handleSaveLetter()` - Save letter to database

**API Calls:**
- POST `/api/generate-cover-letter`
- POST `/api/save-cover-letter`

**Features:**
- Multi-field form inputs
- AI generation button
- Letter preview
- Save and edit options
- Error handling
- Loading states
- Multiline text areas

**When to modify:** Adding form fields, changing generation logic, adding letter templates

---

#### ApplicationsScreen.js (~190 lines)
**Purpose:** View and manage job applications
**Exports:** ApplicationsScreen component

**State Variables:**
- `applications` - List of applications
- `loading` - Loading state
- `refreshing` - Pull-to-refresh state

**Functions:**
- `loadApplications()` - Fetch applications list
- `onRefresh()` - Handle pull-to-refresh
- `handleDeleteApplication()` - Delete an application
- `renderApplicationItem()` - Render each application card

**API Calls:**
- GET `/api/applications`
- DELETE `/api/applications/:id`

**Features:**
- FlatList for efficient rendering
- Application cards with status badges
- Delete confirmation dialog
- Pull-to-refresh
- Empty state message
- Status indicators
- Date formatting

**When to modify:** Adding filters, changing card layout, adding sorting, adding search

---

#### ProfileScreen.js (~210 lines)
**Purpose:** User profile management
**Exports:** ProfileScreen component

**State Variables:**
- `user` - User data
- `formData` - Editable profile fields
- `loading` - Loading state
- `saving` - Save state

**Functions:**
- `loadProfile()` - Fetch user profile
- `handleSaveProfile()` - Save profile changes

**API Calls:**
- GET `/api/profile`
- PUT `/api/profile`

**Features:**
- Editable profile fields
- Form validation
- Save changes button
- Account settings section
- Password change option
- Privacy settings
- Connected apps management
- Loading states

**When to modify:** Adding profile fields, changing layout, adding new settings options

---

### 🔌 Services (src/services/)

#### api.js (~200 lines)
**Purpose:** API integration layer with axios
**Exports:** Multiple API endpoint objects

**Main Components:**
- Axios instance creation with base configuration
- Request interceptor (adds auth token)
- Response interceptor (handles 401 errors)
- API endpoint groups:
  - `authAPI` - Login, register, logout
  - `profileAPI` - Profile operations
  - `applicationsAPI` - Application CRUD
  - `coverLetterAPI` - Cover letter operations
  - `dashboardAPI` - Dashboard data

**Key Features:**
- Automatic token injection
- Error handling
- Timeout configuration
- Organized endpoint groups
- Consistent error responses

**API Endpoint Groups:**

```javascript
authAPI: {
  login(email, password),
  register(name, email, password),
  googleLogin(idToken),
  logout()
}

profileAPI: {
  getProfile(),
  updateProfile(data),
  changePassword(old, new)
}

applicationsAPI: {
  getAll(),
  getById(id),
  create(data),
  update(id, data),
  delete(id),
  getStats()
}

coverLetterAPI: {
  generate(data),
  save(data),
  getByApplicationId(id),
  update(id, content),
  delete(id)
}

dashboardAPI: {
  getStats(),
  getRecentApplications(limit),
  getUpcomingDeadlines()
}
```

**When to modify:** Adding new API endpoints, changing base URL, adding authentication methods

---

### 🛠️ Utilities (src/utils/)

#### helpers.js (~400 lines)
**Purpose:** Reusable utility functions
**Exports:** Multiple utility objects and functions

**Utility Groups:**

1. **tokenUtils**
   - `saveToken()` - Store auth token
   - `getToken()` - Retrieve auth token
   - `removeToken()` - Delete auth token
   - `isTokenValid()` - Check token validity

2. **userUtils**
   - `saveUserData()` - Store user info
   - `getUserData()` - Get user info
   - `clearUserData()` - Delete user info
   - `logout()` - Complete logout

3. **validationUtils**
   - `isValidEmail()` - Email validation
   - `isValidPassword()` - Password validation
   - `isValidPhoneNumber()` - Phone validation
   - `isValidUrl()` - URL validation
   - `getPasswordStrength()` - Strength indicator

4. **dateUtils**
   - `formatDate()` - Format dates
   - `isDateInPast()` - Check if past date
   - `isDateToday()` - Check if today
   - `getDaysUntil()` - Calculate days
   - `getRelativeTime()` - Get relative time string

5. **stringUtils**
   - `truncate()` - Truncate long strings
   - `capitalize()` - Capitalize first letter
   - `capitalizeWords()` - Capitalize all words
   - `slugify()` - Convert to URL slug
   - `highlightText()` - Highlight search term

6. **numberUtils**
   - `formatCurrency()` - Format currency values
   - `formatNumber()` - Format numbers
   - `percentageChange()` - Calculate percentage change

7. **errorUtils**
   - `getErrorMessage()` - Extract error message
   - `getErrorCode()` - Get HTTP error code
   - `isNetworkError()` - Check if network error
   - Various error type checkers

8. **storageUtils**
   - `set()` - Store data securely
   - `get()` - Retrieve data
   - `remove()` - Delete data
   - `clear()` - Clear all storage

**When to modify:** Adding new utility functions, extending existing utilities

---

### ⚙️ Configuration (src/config.js)

**Purpose:** Centralized application configuration
**Exports:** `config` object, individual exports

**Configuration Sections:**

1. **App Information**
   - Name, version, description

2. **API Configuration**
   - Base URL (dev/production)
   - Timeouts

3. **OAuth Configuration**
   - Google Client ID
   - OAuth scopes

4. **Session Management**
   - Timeout duration
   - Auto-logout warning

5. **Pagination**
   - Default page size

6. **File Upload**
   - Max file size
   - Allowed file types

7. **Color Scheme**
   - Primary, secondary, error colors
   - Text colors
   - Background colors

8. **Typography**
   - Font sizes
   - Font weights

9. **Spacing**
   - Spacing units (xs-2xl)

10. **Border Radius**
    - Radius values

11. **Business Logic**
    - Cover letter settings
    - Application statuses
    - Validation rules
    - Feature flags

12. **Security**
    - Biometric option
    - PIN requirements

13. **External Links**
    - Privacy policy, terms, support

14. **Notifications**
    - Push, email, SMS settings

**When to modify:** Changing API endpoints, updating colors, adding features, adjusting timeouts

---

## Coding Patterns Used

### Pattern 1: API Calls with Error Handling
```javascript
try {
  const response = await authAPI.login(email, password);
  // Handle success
} catch (error) {
  Alert.alert('Error', error.response?.data?.error);
}
```

### Pattern 2: Secure Token Storage
```javascript
// Save
await SecureStore.setItemAsync('authToken', token);
// Retrieve
const token = await SecureStore.getItemAsync('authToken');
// Delete
await SecureStore.deleteItemAsync('authToken');
```

### Pattern 3: State Management
```javascript
const [data, setData] = useState(null);
const [loading, setLoading] = useState(true);

useEffect(() => {
  loadData();
}, []);

const loadData = async () => {
  setLoading(true);
  try {
    // Fetch data
  } finally {
    setLoading(false);
  }
};
```

### Pattern 4: Navigation
```javascript
// Navigate to screen
navigation.navigate('ScreenName');

// Navigate with params
navigation.navigate('ScreenName', { param: value });

// Reset navigation (logout)
navigation.reset({
  index: 0,
  routes: [{ name: 'Login' }],
});
```

---

## Adding New Features

### Adding a New Screen

1. Create file: `src/screens/NewScreen.js`
2. Export component that accepts `navigation` prop
3. Import in `App.js`
4. Add to appropriate navigator (AuthStack or AppStack)

### Adding a New API Endpoint

1. Add function to `src/services/api.js`
2. Use the `api` instance to make calls
3. Include authorization header if needed
4. Handle errors appropriately

### Adding a New Utility Function

1. Add to appropriate group in `src/utils/helpers.js`
2. Include JSDoc comments
3. Export from the file
4. Import where needed

### Modifying Configuration

1. Edit `src/config.js`
2. Update relevant section
3. Update type definitions if using TypeScript
4. Test changes in dependent files

---

## Best Practices

✅ **Do:**
- Keep components focused and small
- Use utility functions for common logic
- Handle all error cases
- Add loading states
- Validate user input
- Use secure storage for sensitive data
- Document complex logic
- Keep config values centralized

❌ **Don't:**
- Put API logic directly in components
- Hardcode values
- Ignore error cases
- Store sensitive data in localStorage
- Create deeply nested components
- Use inline styles (use StyleSheet)
- Commit .env files
- Ignore loading states

---

## Common Tasks

### Make an API Call
See `src/services/api.js` for endpoint examples

### Store Data Securely
Use `storageUtils.set()` and `.get()` from helpers

### Format a Date
Use `dateUtils.formatDate()` from helpers

### Validate Input
Use `validationUtils` functions from helpers

### Navigate Between Screens
Use `navigation.navigate()` or `navigation.reset()`

### Handle Errors
Use `errorUtils` functions from helpers

---

## Development Workflow

1. **Understand the requirement**
2. **Check if related file exists**
3. **Make changes in appropriate file**
4. **Import new dependencies if needed**
5. **Test on simulator/device**
6. **Check for console warnings/errors**
7. **Commit changes**

---

## File Size Reference

- LoginScreen.js - ~160 lines
- RegisterScreen.js - ~180 lines
- DashboardScreen.js - ~140 lines
- ApplicationsScreen.js - ~190 lines
- ProfileScreen.js - ~210 lines
- GenerateCoverLetterScreen.js - ~200 lines
- api.js - ~200 lines
- helpers.js - ~400 lines
- config.js - ~250 lines
- App.js - ~140 lines

**Total:** ~2000+ lines of production code

---

## Quick Reference

| Task | File | Function |
|------|------|----------|
| User login | LoginScreen.js | handleLogin() |
| API calls | api.js | authAPI, profileAPI, etc. |
| Token storage | helpers.js | tokenUtils |
| Date formatting | helpers.js | dateUtils.formatDate() |
| Configuration | config.js | config object |
| Navigation | App.js | RootNavigator() |
| Profile edit | ProfileScreen.js | handleSaveProfile() |
| Dashboard | DashboardScreen.js | loadDashboard() |

---

This structure keeps the codebase organized, maintainable, and scalable.

For more information, see:
- [README.md](./README.md) - Full documentation
- [QUICKSTART.md](./QUICKSTART.md) - Quick start guide
- [IMPLEMENTATION_SUMMARY.md](./IMPLEMENTATION_SUMMARY.md) - Complete overview

---

**Last Updated:** 2024  
**Version:** 1.0.0
