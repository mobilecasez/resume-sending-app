# API Configuration Guide

## How It Works

The app automatically detects the API URL based on the environment:

### Development Mode (`__DEV__ = true`)
- **Automatically detects** the Metro bundler host IP
- Uses `Constants.manifest.debuggerHost` to get your computer's IP
- Constructs API URL as: `http://{your-ip}:3000/api`
- **No manual configuration needed!**

### Production Mode
- Reads `apiUrl` from `app.json` → `extra.apiUrl`
- Or set via environment variable during build
- Example: `https://api.yourdomain.com/api`

## Configuration

### For Development (Local Testing)
**No configuration needed!** The app will automatically use your computer's IP.

Just run:
```bash
npx expo start
```

The app will automatically connect to your backend at `http://{your-ip}:3000/api`

### For Production Deployment

1. **Option A: Edit app.json**
   ```json
   {
     "expo": {
       "extra": {
         "apiUrl": "https://api.yourdomain.com/api"
       }
     }
   }
   ```

2. **Option B: Use environment variables** (recommended)
   - Create `.env` file:
     ```
     API_URL=https://api.yourdomain.com/api
     ```
   - Install `expo-constants` (already included)
   - The app will read from `Constants.expoConfig.extra.apiUrl`

## Testing

To verify the API URL being used:
1. Open the app
2. Check the console logs
3. Look for: `🌐 API_BASE: http://...`

## Troubleshooting

**Can't connect to API in development?**
- Make sure your backend is running: `node server.js`
- Make sure your phone/emulator is on the same WiFi network
- Check firewall settings aren't blocking port 3000

**Production build not connecting?**
- Verify `apiUrl` is set in `app.json` → `extra.apiUrl`
- Check that your production API is accessible
- Ensure HTTPS is configured correctly

## Backend Configuration

Your backend should allow CORS for both development and production origins:

```javascript
// In server.js
const cors = require('cors');

const allowedOrigins = [
  'http://localhost:3000',
  'https://yourdomain.com',
  // Add more as needed
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.some(allowed => origin.startsWith(allowed))) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }
}));
```

## Port Configuration

If you change the backend port from 3000:
1. **Development:** No changes needed (auto-detects)
2. **Production:** Update `apiUrl` in `app.json`

## Best Practices

✅ **DO:**
- Use environment-based configuration
- Keep production URL in `app.json` or environment variables
- Test on both development and production builds
- Use HTTPS in production

❌ **DON'T:**
- Hardcode IP addresses
- Commit production API URLs to public repos
- Use HTTP in production
- Skip CORS configuration
