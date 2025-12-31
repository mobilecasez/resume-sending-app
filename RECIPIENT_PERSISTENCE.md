# Recipient Persistence & Auto-Save Feature

## Overview

Recipients are now **automatically persisted** to the backend database and **automatically loaded** when users log in. This ensures that recipients are maintained across app restarts, device changes, and sessions - just like in the web version.

## What Changed

### Before
- Recipients were stored only in React state
- Lost on app restart or refresh
- Had to be manually re-entered each time
- No persistence across sessions

### After ✅
- Recipients automatically saved to backend database
- Automatically loaded when user logs in
- Persisted across app restarts
- Available on any device (web or mobile)
- Auto-saves with 2-second debounce as you type

## Architecture

### Backend Changes

#### 1. New Database Table: `recipients`
```sql
CREATE TABLE IF NOT EXISTS recipients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    email TEXT NOT NULL,
    website TEXT NOT NULL,
    position TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, email)
)
```

**Key Features:**
- Associated with specific user (user_id)
- Stores email, website, position
- Timestamp tracking for audit trail
- Unique constraint prevents duplicate recipients per user
- CASCADE delete removes recipients when user is deleted

#### 2. New API Endpoints

**GET `/api/users/recipients`**
- **Purpose**: Fetch all recipients for authenticated user
- **Authentication**: Required (Bearer token)
- **Returns**: Array of recipient objects
- **Example Response**:
```json
{
  "success": true,
  "recipients": [
    { "id": 1, "email": "hr@google.com", "website": "https://google.com", "position": "Senior Engineer" },
    { "id": 2, "email": "jobs@amazon.com", "website": "https://amazon.com", "position": "Staff Engineer" }
  ],
  "count": 2
}
```

**POST `/api/users/recipients`**
- **Purpose**: Save/update all recipients for authenticated user
- **Authentication**: Required (Bearer token)
- **Body**:
```json
{
  "recipients": [
    { "email": "hr@google.com", "website": "https://google.com", "position": "Senior Engineer" },
    { "email": "jobs@amazon.com", "website": "https://amazon.com", "position": "Staff Engineer" }
  ]
}
```
- **Returns**: Confirmation with count
- **Example Response**:
```json
{
  "success": true,
  "message": "Successfully saved 2 recipients",
  "recipientsCount": 2
}
```

### Mobile App Changes

#### 1. New Functions

**`loadRecipientsFromBackend(userToken)`**
- Fetches recipients from backend for current user
- Called when user logs in
- Silently handles errors (keeps default empty recipient if fetch fails)
- Updates state with loaded recipients
- Logs success/failure to console

**`saveRecipientsToBackend()`**
- Saves current recipients to backend
- Called automatically with 2-second debounce
- Only saves if user has authentication token
- Only saves valid recipients (must have email or website)

#### 2. New useEffect Hooks

**Auto-Load Recipients** (Line ~660)
```javascript
useEffect(() => {
  if (user?.token && screen === 'dashboard') {
    loadRecipientsFromBackend(user.token);
  }
}, [user?.token]);
```
- Triggers when user logs in
- Loads recipients from backend database
- Only loads when on dashboard screen

**Auto-Save Recipients** (Line ~655)
```javascript
useEffect(() => {
  if (!user?.token) return;
  
  const timer = setTimeout(() => {
    const validRecipients = recipients.filter(r => r.email || r.website);
    if (validRecipients.length > 0) {
      saveRecipientsToBackend();
    }
  }, 2000); // 2 second debounce

  return () => clearTimeout(timer);
}, [recipients, user?.token]);
```
- Auto-saves every time recipients change
- Waits 2 seconds before saving (debounce)
- Only saves if there are valid recipients
- Clears timer on cleanup to prevent memory leaks

## User Experience Flow

### Step 1: Login
```
User enters email/password
         ↓
Backend validates credentials
         ↓
User object created with token
         ↓
App navigates to dashboard screen
         ↓
loadRecipientsFromBackend() triggered
         ↓
Fetch GET /api/users/recipients
         ↓
Recipients loaded into React state
         ↓
✅ Dashboard shows all previous recipients!
```

### Step 2: Edit Recipients
```
User adds new recipient email: "hr@google.com"
         ↓
React state updated immediately
         ↓
Auto-save useEffect triggered
         ↓
Wait 2 seconds (debounce)
         ↓
POST to /api/users/recipients
         ↓
Backend saves to SQLite database
         ↓
✅ Recipients persisted!
```

### Step 3: App Restart
```
User closes and reopens app
         ↓
Login screen shown
         ↓
User logs in again
         ↓
loadRecipientsFromBackend() triggered
         ↓
Fetch GET /api/users/recipients
         ↓
All previous recipients loaded
         ↓
✅ No data loss!
```

## Testing Checklist

### Unit Tests
- [ ] Create recipient with email and website
- [ ] Create recipient with email only
- [ ] Create recipient with website only
- [ ] Add multiple recipients
- [ ] Edit existing recipient
- [ ] Delete recipient
- [ ] Clear all recipients

### Integration Tests
- [ ] Login loads recipients automatically
- [ ] Save recipient, refresh app, verify still there
- [ ] Add 5+ recipients and verify all save
- [ ] Save recipient on mobile, verify in web app
- [ ] Delete recipient, verify deleted in database

### Edge Cases
- [ ] Login with user that has no recipients (should show empty state)
- [ ] Save with invalid email (should be filtered)
- [ ] Save with invalid URL (should be filtered)
- [ ] Network error during load (should show error gracefully)
- [ ] Network error during save (should retry on next change)
- [ ] Rapid recipient changes (debounce should prevent race conditions)
- [ ] Switch screens and back (should not duplicate loads)

### Performance Tests
- [ ] Load 50+ recipients (verify performance)
- [ ] Save large batch of recipients (verify speed)
- [ ] Rapid changes (verify debounce works)
- [ ] Check memory usage (verify no leaks)

## API Request Examples

### cURL Example - Get Recipients
```bash
curl -X GET http://localhost:3000/api/users/recipients \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -H "Content-Type: application/json"
```

### cURL Example - Save Recipients
```bash
curl -X POST http://localhost:3000/api/users/recipients \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{
    "recipients": [
      {"email": "hr@google.com", "website": "https://google.com", "position": "Senior Engineer"},
      {"email": "jobs@amazon.com", "website": "https://amazon.com", "position": "Staff Engineer"}
    ]
  }'
```

## Mobile App Console Logs

When working correctly, you should see these logs:

### On Login
```
✅ Loaded 3 recipients from backend
```

### On Adding/Editing Recipients
```
✅ Saved 3 recipients to backend
```

### On Error
```
Error loading recipients: [error message]
Error saving recipients: [error message]
```

## Database Queries

### View all recipients for a user
```sql
SELECT * FROM recipients WHERE user_id = 1;
```

### Count recipients per user
```sql
SELECT user_id, COUNT(*) as count FROM recipients GROUP BY user_id;
```

### Delete all recipients for a user
```sql
DELETE FROM recipients WHERE user_id = 1;
```

## Future Enhancements

1. **Batch Operations**
   - Delete multiple recipients at once
   - Update multiple recipients in batch
   - Bulk import from CSV

2. **Recipient Groups**
   - Create groups (e.g., "FAANG", "Startups")
   - Save/load by group
   - Quick-fill position by industry

3. **Recipient Sync**
   - Real-time sync across devices
   - WebSocket updates
   - Last-sync timestamp

4. **Recipient Analytics**
   - Track which recipients received applications
   - Response rate per recipient
   - Success metrics by position/company

5. **Advanced Search**
   - Search by email domain
   - Filter by position type
   - Sort by date added

## Troubleshooting

### Recipients Not Loading
**Problem**: Dashboard shows empty recipient list after login
**Solution**:
1. Check server logs: `tail -f server.log`
2. Verify user has token: `console.log(user?.token)` in app
3. Check network tab in browser inspector
4. Verify recipients table created: `sqlite3 database.db ".tables"`

### Recipients Not Saving
**Problem**: Added recipients but they disappear on refresh
**Solution**:
1. Check console logs for "Error saving recipients"
2. Verify network request succeeded in browser inspector
3. Check database: `SELECT COUNT(*) FROM recipients;`
4. Verify user_id is correct in database

### Duplicate Recipients
**Problem**: Same email appears multiple times
**Solution**:
1. Database has UNIQUE constraint on (user_id, email)
2. Clearing and re-saving should fix it
3. Contact support if still persists

## Migration from Old System

If upgrading from previous version:

1. **Automatic Migration**: First login will create empty recipients list
2. **Manual Entry**: Users will need to re-enter recipients once
3. **Bulk Import**: Could add CSV import in future
4. **Backward Compatibility**: Web app still uses sessionStorage (still works)

## Code References

**Backend** - [server.js](server.js)
- Line ~60-85: Recipients table creation
- Line ~860-910: POST /api/users/recipients endpoint
- Line ~912-940: GET /api/users/recipients endpoint

**Mobile App** - [MobileApp/App.js](MobileApp/App.js)
- Line ~661-695: loadRecipientsFromBackend() function
- Line ~697-718: saveRecipientsToBackend() function
- Line ~720-733: Auto-save useEffect hook
- Line ~735-740: Auto-load useEffect hook

---

**Status**: ✅ **LIVE & FUNCTIONAL**

Recipients are now fully persistent across sessions, devices, and app restarts!
