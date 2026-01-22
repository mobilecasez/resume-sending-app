# 🔧 FINAL SERVER STARTUP PROMPT (UPDATED - WORKING)

## **Use this exact instruction next time to start servers:**

---

### **THE CORRECT WAY TO START BOTH SERVERS:**

```bash
# Step 1: Kill any old processes
pkill -9 node && sleep 1

# Step 2: Get your current IP address
export MY_IP=$(ifconfig | grep "inet " | grep -v 127.0.0.1 | awk '{print $2}' | head -1)
echo "🌐 Your IP Address: $MY_IP"

# Step 3: Update App.js with current IP address
cd /Users/rishisamadhiya/Desktop/Files/Personal/Shopify\ Apps/resume-sending-app/MobileApp
sed -i '' "s|const API_BASE = 'http://[0-9.]*:3000/api';|const API_BASE = 'http://$MY_IP:3000/api';|g" App.js
echo "✅ Updated API_BASE to: http://$MY_IP:3000/api"

# Step 4: Start Backend (in BACKGROUND)
cd /Users/rishisamadhiya/Desktop/Files/Personal/Shopify\ Apps/resume-sending-app
node server.js &
sleep 3

# Step 5: Start Expo (in FOREGROUND - NO & at the end)
cd MobileApp
npx expo start
```

**OR USE THIS ONE-LINER:**

```bash
pkill -9 node && sleep 1 && export MY_IP=$(ifconfig | grep "inet " | grep -v 127.0.0.1 | awk '{print $2}' | head -1) && echo "🌐 Your IP: $MY_IP" && cd /Users/rishisamadhiya/Desktop/Files/Personal/Shopify\ Apps/resume-sending-app/MobileApp && sed -i '' "s|const API_BASE = 'http://[0-9.]*:3000/api';|const API_BASE = 'http://$MY_IP:3000/api';|g" App.js && echo "✅ Updated API_BASE" && cd .. && node server.js & sleep 3 && cd MobileApp && npx expo start
```

**CRITICAL CHANGES FROM OLD VERSION:**
- ✅ **Automatically detects your current IP address** (fixes IP mismatch issues)
- ✅ **Updates App.js API_BASE before starting servers** (prevents network request failed errors)
- ✅ Backend runs in background with `&`
- ✅ Expo runs in foreground (NO `&`)
- ✅ No flags like `--tunnel` or `--localhost`

---

### **WHY THIS WORKS:**

1. **Dynamic IP Detection**: Your Mac's IP can change (192.168.1.14 → 192.168.1.21). This automatically detects it.
2. **Auto-Update App.js**: Updates the `API_BASE` constant to match your current IP.
3. **Backend on 0.0.0.0**: Server listens on all interfaces, accessible from any device.
4. **Expo on Same Network**: Both backend and Expo use the same IP, ensuring connectivity.

---

### **WAIT FOR THESE SIGNS:**

1. **IP Address Displayed**
   ```
   🌐 Your IP Address: 192.168.1.21
   ```

2. **API_BASE Updated**
   ```
   ✅ Updated API_BASE to: http://192.168.1.21:3000/api
   ```

3. **Backend Server Running**
   ```
   🌐 Server: http://0.0.0.0:3000
   🌐 Local: http://localhost:3000
   🌐 Network: http://192.168.1.21:3000
   Connected to SQLite database
   ```

4. **Metro Bundler Complete** (~20-30 seconds)
   ```
   iOS Bundled 466ms node_modules/expo-router/entry.js
   ```

5. **QR Code Displayed**
   ```
   ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
   █ ▄▄▄▄▄ █   █▄ ▀▄██ ▄▄▄▄▄ █
   ... (full QR code)
   ```

6. **Interactive Menu Appears**
   ```
   › Metro waiting on exp://192.168.1.21:8081
   › Press s │ switch to development build
   › Press a │ open Android
   › Press i │ open iOS simulator
   ```

---

### **ON YOUR PHONE:**

1. Open **Expo Go** app
2. **Scan the QR code** from the terminal
3. App should connect to `exp://192.168.1.21:8081`
4. Login should work without "network request failed" error

---

## ❌ COMMON MISTAKES (DO NOT DO THESE)

| Mistake | Problem | Fix |
|---------|---------|-----|
| Hardcoded IP in App.js | IP changes, app can't connect | **Use dynamic IP detection** |
| Backend shows different IP than Expo | Network request failed | **Ensure both use same IP** |
| `npx expo start &` | No QR code visible | **Remove the `&`** |
| `npx expo start --tunnel` | Endpoint goes offline | Use default mode |
| Started without killing old processes | Port conflicts | Run `pkill -9 node` first |
| Didn't wait for Metro bundler | App not ready | **Wait 20-30 seconds** |

---

## ✅ VERIFICATION CHECKLIST

Before scanning QR code, verify:

- [ ] IP address detected and displayed
- [ ] App.js updated with correct IP
- [ ] Backend running: `curl http://YOUR_IP:3000` returns HTML
- [ ] Expo showing QR code in terminal
- [ ] Expo showing interactive menu (Press s, a, i, w, etc.)
- [ ] Both showing same IP address (e.g., 192.168.1.21)
- [ ] Phone on same Wi-Fi as computer (192.168.1.x)

---

## 🔄 IF STILL NOT WORKING:

1. **Verify IP Address Match:**
   ```bash
   # Check what IP the backend shows
   # Check what IP Expo shows  
   # Check what IP is in App.js
   grep "API_BASE" /Users/rishisamadhiya/Desktop/Files/Personal/Shopify\ Apps/resume-sending-app/MobileApp/App.js
   ```

2. **Test Backend Connectivity:**
   ```bash
   curl http://YOUR_IP:3000
   # Should return HTML, not "Connection refused"
   ```

3. **Fresh Start with Cache Clear:**
   ```bash
   pkill -9 node
   rm -rf /Users/rishisamadhiya/Desktop/Files/Personal/Shopify\ Apps/resume-sending-app/MobileApp/.expo
   # Then run the one-liner command above
   ```

---

## 📋 QUICK REFERENCE (Copy & Paste)

**One-Liner Command:**
```bash
pkill -9 node && sleep 1 && export MY_IP=$(ifconfig | grep "inet " | grep -v 127.0.0.1 | awk '{print $2}' | head -1) && echo "🌐 Your IP: $MY_IP" && cd /Users/rishisamadhiya/Desktop/Files/Personal/Shopify\ Apps/resume-sending-app/MobileApp && sed -i '' "s|const API_BASE = 'http://[0-9.]*:3000/api';|const API_BASE = 'http://$MY_IP:3000/api';|g" App.js && echo "✅ Updated API_BASE" && cd .. && node server.js & sleep 3 && cd MobileApp && npx expo start
```

---

## 🎯 KEY RULES (NEVER BREAK THESE)

| Rule | Reason |
|------|--------|
| ✅ Auto-detect IP address | IP can change between restarts |
| ✅ Update App.js before starting | Prevents network request failed |
| ✅ Backend listens on 0.0.0.0 | Accessible from all devices |
| ✅ Backend in background | Doesn't need interaction |
| ❌ Expo NOT in background | Need to see QR code & menu |
| ✅ Use same IP for both servers | Ensures connectivity |
| ✅ Wait 20-30 seconds | Metro bundler takes time |
| ❌ Don't add flags to Expo | Keep it simple |

---

**Created:** 4 January 2026  
**Last Updated:** 14 January 2026  
**Status:** ✅ Tested and Working (IP Auto-Detection Added)
   curl http://192.168.1.11:3000
   ```
4. **If still stuck, do a fresh start:**
   ```bash
   pkill -9 node
   rm -rf /Users/rishisamadhiya/Desktop/Files/Personal/Shopify\ Apps/resume-sending-app/MobileApp/.expo
   sleep 2
   # Then restart from "Step 1" above
   ```

---

## 📋 QUICK REFERENCE (Copy & Paste)

```bash
pkill -9 node && sleep 1 && cd /Users/rishisamadhiya/Desktop/Files/Personal/Shopify\ Apps/resume-sending-app && node server.js & sleep 3 && cd MobileApp && npx expo start
```

---

## 🎯 KEY RULES (NEVER BREAK THESE)

| Rule | Reason |
|------|--------|
| ✅ Backend in background | Doesn't need interaction |
| ❌ Expo NOT in background | Need to see QR code & menu |
| ✅ Use 192.168.1.11 | Phone is different device |
| ❌ Never use localhost from phone | Only works on same machine |
| ✅ Wait 20-30 seconds | Metro bundler takes time |
| ❌ Don't redirect Expo output | Need to see everything |
| ✅ Kill old processes first | Avoid port conflicts |
| ❌ Don't add flags to Expo start | Keep it simple and default |

---

**Created:** 4 January 2026  
**Last Updated:** 4 January 2026  
**Status:** ✅ Tested and Working
