# Activity Graph Debug - Summary and Instructions

## 🔍 Current Status

### ✅ What's Working
1. **Backend server is running** on port 3000
2. **Database has activity data** - Found records for users 1 and 10
3. **Database recording is implemented** in `/api/send-applications` endpoint
4. **Logging has been added** to track data flow

### 📊 Database State
```
👥 Users with activity:
   - User ID 1 (samrishi24@gmail.com): 88 generated, 36 sent
   - User ID 10 (samrishi242@gmail.com): 85 generated, 36 sent

📧 Application History Records:
   - User 1: 10 records (last activity: Jan 19, 2026)
   - User 10: 10 records (last activity: Jan 22, 2026)

📅 Activity by date:
   - Jan 19, 2026: User 1 sent 10 applications
   - Jan 22, 2026: User 10 sent 10 applications
```

### ⚠️ The Issue
The activity data exists but is from **January 19-22**, which is 15+ days ago. However, the 7-day activity graph is looking for activity in the **last 7 days** from today (Feb 6).

## 🔧 Enhanced Logging Added

### Backend (creditsController.js)
- ✅ Logs when `/user/usage-stats` endpoint is called
- ✅ Shows database query for application_history
- ✅ Displays query results and merged data
- ✅ Shows final dateWiseActivity array before sending to mobile

### Mobile App (App.js)
- ✅ Logs when fetching usage data
- ✅ Shows response data structure
- ✅ Displays sample data for first 3 and last 7 days
- ✅ Logs chart rendering with actual data values

### Send Applications Endpoint (server.js)
- ✅ Logs when applications are being sent
- ✅ Shows database insert attempts
- ✅ Verifies inserts with query
- ✅ Logs counter updates

## 🧪 Testing Instructions

### Step 1: Open Mobile App Usage Screen
1. Open your mobile app (Expo Go)
2. Navigate to the **Usage** screen
3. Watch the **console logs** in Expo terminal

### Step 2: Check Console Logs
You should see logs like:
```
📱 [USAGE] Fetching usage data from: http://192.168.1.8:3000/user/usage-stats
📱 [USAGE] Response status: 200 OK
📱 [USAGE] dateWiseActivity length: 30
📱 [USAGE] Days with non-zero activity: X
📱 [USAGE] Sample data (last 7 days): [...]
```

### Step 3: Check Backend Logs
Run this command to see backend logs:
```bash
tail -f /tmp/backend.log | grep -E "(USAGE|DB|SEND)"
```

You should see:
```
📊 ============ USAGE STATS REQUEST START ============
📊 [USAGE STATS] User ID: 1
📊 [DB CHECK] Application history records for user: 10
🔍 [USAGE STATS] Querying application_history...
📊 [USAGE STATS] Application history query result: [...]
📤 [USAGE STATS] Sending response with dateWiseActivity count: 30
```

### Step 4: Send a Test Application
1. Go to **Review** screen in mobile app
2. Add a test recipient
3. Send an application
4. Watch for these logs:

**Backend:**
```
📧 ============ SEND APPLICATIONS START ============
📧 [SEND] User ID: 1
📧 [SEND] Recipients count: 1
💾 [DB INSERT] Attempting to save to application_history...
✅ [DB INSERT] Saved to application history
```

**Mobile:**
```
🟢 Application sent successfully
```

### Step 5: Verify Data Shows in Graph
1. Go back to **Usage** screen
2. The graph should now show activity for today
3. Check console logs for:
```
📊 [CHART] Rendering chart with data: [...]
📊 [CHART] Max value for chart: X
```

## 🐛 Troubleshooting

### If Graph Still Shows No Data:

#### Check 1: Is the endpoint being called?
```bash
tail -f /tmp/backend.log | grep "USAGE STATS"
```
If you don't see this log, the mobile app isn't calling the endpoint.

#### Check 2: Is data being returned?
In mobile console, look for:
```
📱 [USAGE] Days with non-zero activity: 0
```
If it's 0, check the backend logs for the query results.

#### Check 3: Is database insert failing?
When you send an application, check for:
```
❌ [DB INSERT] Failed to save to history
```

#### Check 4: Date format issues
The mobile app filters by:
```javascript
.filter(day => day.generated > 0 || day.sent > 0 || day.creditsUsed > 0)
```
Check if values are actually > 0 in the console logs.

## 📝 Log Output Reference

### Normal Flow (Working)
```
📊 ============ USAGE STATS REQUEST START ============
📊 [USAGE STATS] User ID: 1
📊 [DB CHECK] Application history records for user: 10
🔍 [USAGE STATS] Querying application_history for user: 1
📊 [USAGE STATS] Number of records found: 2
✅ [USAGE STATS] Merging app stats into dateWiseData
   - Date: 2026-02-05, Sent: 3, Index: 28
   - Date: 2026-02-06, Sent: 2, Index: 29
📤 [USAGE STATS] Days with activity (non-zero): 2
📤 [USAGE STATS] Sample activity days: [{"date":"2026-02-05","sent":3}...]
```

### Problem Flow (No Data)
```
📊 ============ USAGE STATS REQUEST START ============
📊 [DB CHECK] Application history records for user: 0
⚠️ [DB CHECK] No application_history records found for this user!
📊 [USAGE STATS] Number of records found: 0
⚠️ [USAGE STATS] No application history data found!
```

## 🎯 Next Steps

1. **Open the mobile app** and go to Usage screen
2. **Check console logs** - share any errors you see
3. **Send a test application** to create fresh activity
4. **Go back to Usage screen** to see if today's activity shows up

## 📞 Need Help?

Share these logs with me:
1. Mobile console output from Usage screen
2. Backend log output: `tail -100 /tmp/backend.log`
3. Result of: `node test-activity-debug.js`
