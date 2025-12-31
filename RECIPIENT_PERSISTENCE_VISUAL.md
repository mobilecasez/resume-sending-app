# Recipient Persistence - Visual Flow & Architecture

## 🎯 Data Flow Diagram

### Before Implementation
```
┌─────────────────────────────────────────────────────┐
│  MOBILE APP                                          │
│                                                     │
│  ┌─────────────────────┐                            │
│  │  React State        │                            │
│  │  recipients: []     │ ← Stored only in memory   │
│  └─────────────────────┘                            │
│         ↓                                            │
│    Lost on refresh!                                 │
│         ↓                                            │
│  ┌─────────────────────┐                            │
│  │  User loses all     │                            │
│  │  recipient data     │                            │
│  │  Must re-enter      │                            │
│  └─────────────────────┘                            │
└─────────────────────────────────────────────────────┘

❌ PROBLEM: Data not persisted
```

### After Implementation
```
┌──────────────────────────────────────────────────────┐
│  MOBILE APP (React State)                            │
│                                                      │
│  ┌──────────────────────────┐                        │
│  │  recipients: [           │ ← User sees this      │
│  │    { email, website,... }│   on dashboard        │
│  │  ]                       │                        │
│  └──────────────────────────┘                        │
│         ↕ (useEffect hook)                           │
│  ┌──────────────────────────────────────┐            │
│  │  Auto-save every 2 seconds when      │            │
│  │  recipients change (debounced)       │            │
│  │                                      │            │
│  │  POST /api/users/recipients          │            │
│  └──────────────────────┬───────────────┘            │
│                         ↓                            │
│                   [NETWORK]                          │
│                         ↓                            │
├─────────────────────────────────────────────────────┤
│  BACKEND (Node.js/Express)                          │
│                                                      │
│  ┌──────────────────────────────────────┐            │
│  │  API Endpoint Handler                │            │
│  │  POST /api/users/recipients          │            │
│  │  GET  /api/users/recipients          │            │
│  └──────────────────────┬───────────────┘            │
│                         ↓                            │
│  ┌──────────────────────────────────────┐            │
│  │  User Authentication Check           │            │
│  │  (Verify JWT token, user_id)         │            │
│  └──────────────────────┬───────────────┘            │
│                         ↓                            │
│  ┌──────────────────────────────────────┐            │
│  │  Database Query                      │            │
│  │  INSERT/UPDATE recipients            │            │
│  │  WHERE user_id = authenticated_user  │            │
│  └──────────────────────┬───────────────┘            │
│                         ↓                            │
├─────────────────────────────────────────────────────┤
│  DATABASE (SQLite)                                  │
│                                                      │
│  ┌──────────────────────────────────────┐            │
│  │  recipients table                    │            │
│  │  ┌──────────────────────────────────┐│            │
│  │  │ id │ user_id │ email │ website │ ││ ← Stored  │
│  │  │ 1  │ 5       │ hr@.. │ http:.. │ ││   here!  │
│  │  │ 2  │ 5       │ jobs..│ http:.. │ ││           │
│  │  └──────────────────────────────────┘│            │
│  │  Persists indefinitely               │            │
│  └──────────────────────────────────────┘            │
└──────────────────────────────────────────────────────┘

✅ SOLUTION: Data persisted in database!
```

## 🔄 Recipient Loading Flow

### On App Startup & Login
```
┌─────────────────────────────────────────────┐
│ 1. User Logs In                             │
│    ├─ Email: user@gmail.com                 │
│    └─ Password: ****                        │
└─────────────┬───────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────┐
│ 2. Backend Validates Credentials            │
│    ├─ Check users table                     │
│    ├─ Verify password hash                  │
│    └─ Return JWT token                      │
└─────────────┬───────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────┐
│ 3. Mobile App Receives Token                │
│    ├─ user.token = "eyJhbGc..."            │
│    ├─ user.id = 5                           │
│    └─ Navigate to dashboard screen          │
└─────────────┬───────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────┐
│ 4. useEffect Hook Triggered                 │
│    ├─ Condition: user?.token exists         │
│    ├─ Condition: screen === 'dashboard'     │
│    └─ Call: loadRecipientsFromBackend()     │
└─────────────┬───────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────┐
│ 5. API Request Sent                         │
│    ├─ GET /api/users/recipients             │
│    ├─ Header: Authorization: Bearer TOKEN   │
│    └─ Await response...                     │
└─────────────┬───────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────┐
│ 6. Backend Processes Request                │
│    ├─ Extract user_id from JWT              │
│    ├─ Query: SELECT * FROM recipients       │
│    │         WHERE user_id = ?              │
│    └─ Return: JSON array of recipients      │
└─────────────┬───────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────┐
│ 7. Mobile Receives Response                 │
│    ├─ Parse JSON data                       │
│    ├─ setRecipients(loadedRecipients)       │
│    └─ Update React state                    │
└─────────────┬───────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────┐
│ 8. Dashboard Renders                        │
│    ├─ recipients.map((r) => ...)           │
│    ├─ Show all 3+ recipients                │
│    ├─ No blank fields!                      │
│    └─ ✅ SUCCESS!                           │
└─────────────────────────────────────────────┘
```

## 💾 Recipient Saving Flow

### When User Edits Recipients
```
┌──────────────────────────────────────────────┐
│ 1. User Changes Recipient                    │
│    ├─ Taps email input field                 │
│    ├─ Types: "hr@google.com"                 │
│    └─ Triggers: onChangeText handler         │
└──────────────┬───────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────┐
│ 2. updateRecipient() Called                  │
│    ├─ id: 1 (recipient ID)                   │
│    ├─ field: 'email'                         │
│    ├─ value: 'hr@google.com'                 │
│    └─ setRecipients([...updated])            │
└──────────────┬───────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────┐
│ 3. React State Updated Immediately           │
│    ├─ recipients[0].email = "hr@google.com"  │
│    ├─ Component re-renders                   │
│    └─ User sees change in 10ms               │
└──────────────┬───────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────┐
│ 4. Auto-save useEffect Triggered             │
│    ├─ Dependency: recipients (changed)       │
│    ├─ Check: user?.token exists              │
│    ├─ Start timer: setTimeout(2000ms)        │
│    └─ Cancel if user keeps editing...        │
└──────────────┬───────────────────────────────┘
               │
               ▼
     USER CONTINUES EDITING? 
               │
       ┌───────┴────────┐
       │ YES            │ NO
       ▼                ▼
    TIMER RESETS    TIMER COMPLETES
       │                │
       └───────┬────────┘
               ▼
┌──────────────────────────────────────────────┐
│ 5. 2 Seconds Elapsed                         │
│    ├─ No new changes detected                │
│    ├─ Timer completes                        │
│    ├─ Call: saveRecipientsToBackend()        │
│    └─ (Only if timer completes)              │
└──────────────┬───────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────┐
│ 6. API Request Sent to Backend               │
│    ├─ POST /api/users/recipients             │
│    ├─ Header: Authorization: Bearer TOKEN    │
│    ├─ Body: { recipients: [array] }          │
│    └─ Await response...                      │
└──────────────┬───────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────┐
│ 7. Backend Processes Save Request            │
│    ├─ Extract user_id from JWT               │
│    ├─ DELETE old recipients (user_id)        │
│    ├─ INSERT new recipients from request     │
│    ├─ INSERT recipients (user_id, email...)  │
│    └─ Return: { success: true, count: 1 }    │
└──────────────┬───────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────┐
│ 8. Mobile Receives Response                  │
│    ├─ response.ok ✓                          │
│    ├─ data.recipientsCount = 1               │
│    ├─ Log: "✅ Saved 1 recipients to backend" │
│    └─ (Silent success - no alert)            │
└──────────────┬───────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────┐
│ 9. Database Updated                          │
│    ├─ recipients table now has new entry     │
│    ├─ Persisted indefinitely                 │
│    └─ Ready for app restart                  │
└──────────────────────────────────────────────┘
```

## 🗂️ Database Architecture

### Table: recipients
```
┌─────────────────────────────────────────────────┐
│ recipients                                      │
├────┬─────────┬──────────────┬─────────────┬────┤
│ id │ user_id │ email        │ website     │ .. │
├────┼─────────┼──────────────┼─────────────┼────┤
│ 1  │ 5       │ hr@google    │ google.com  │    │ ← User 5
│ 2  │ 5       │ jobs@amazon  │ amazon.com  │    │   (2 recipients)
│ 3  │ 8       │ careers@meta │ meta.com    │    │ ← User 8
│ 4  │ 8       │ hire@apple   │ apple.com   │    │   (2 recipients)
└────┴─────────┴──────────────┴─────────────┴────┘

FOREIGN KEY: user_id → users.id
- Deletes recipients when user is deleted
- Isolates data per user

UNIQUE CONSTRAINT: (user_id, email)
- Prevents duplicate recipients
- Ensures data integrity
```

### Relationship: users ↔ recipients
```
┌─────────────────────────────────────────────┐
│ users table                                 │
│                                             │
│ id | full_name | email | password | ...    │
│ 5  | John Doe  | ...   | ...      | ...    │
│ 8  | Jane Smith| ...   | ...      | ...    │
└──────┬────────────────────────────┬─────────┘
       │ (user_id=5)    (user_id=8) │
       ▼                            ▼
┌──────────────────────┐    ┌──────────────────────┐
│ John's Recipients    │    │ Jane's Recipients    │
│ ├─ hr@google.com     │    │ ├─ careers@meta      │
│ └─ jobs@amazon.com   │    │ └─ hire@apple.com    │
└──────────────────────┘    └──────────────────────┘

Each user has isolated recipients!
```

## 📡 API Communication

### GET /api/users/recipients
```
REQUEST:
┌────────────────────────────────────────────┐
│ GET /api/users/recipients                  │
│ Headers:                                   │
│   Authorization: Bearer eyJhbGc...         │
│   Content-Type: application/json           │
└────────────────────────────────────────────┘
         ↓ [sent to backend] ↓

BACKEND PROCESSING:
┌────────────────────────────────────────────┐
│ 1. Verify JWT token in header               │
│ 2. Extract user_id = 5 from token          │
│ 3. Query: SELECT * FROM recipients         │
│          WHERE user_id = 5                 │
│ 4. Get results: [2 recipients]             │
│ 5. Format as JSON                          │
└────────────────────────────────────────────┘
         ↓ [sent to mobile] ↓

RESPONSE:
┌────────────────────────────────────────────┐
│ {                                          │
│   "success": true,                         │
│   "recipients": [                          │
│     {                                      │
│       "id": 1,                             │
│       "email": "hr@google.com",            │
│       "website": "https://google.com",     │
│       "position": "Senior Engineer"        │
│     },                                     │
│     {                                      │
│       "id": 2,                             │
│       "email": "jobs@amazon.com",          │
│       "website": "https://amazon.com",     │
│       "position": "Staff Engineer"         │
│     }                                      │
│   ],                                       │
│   "count": 2                               │
│ }                                          │
└────────────────────────────────────────────┘
```

### POST /api/users/recipients
```
REQUEST:
┌────────────────────────────────────────────┐
│ POST /api/users/recipients                 │
│ Headers:                                   │
│   Authorization: Bearer eyJhbGc...         │
│   Content-Type: application/json           │
│ Body:                                      │
│ {                                          │
│   "recipients": [                          │
│     {                                      │
│       "email": "hr@google.com",            │
│       "website": "https://google.com",     │
│       "position": "Senior Engineer"        │
│     },                                     │
│     {                                      │
│       "email": "jobs@amazon.com",          │
│       "website": "https://amazon.com",     │
│       "position": "Staff Engineer"         │
│     }                                      │
│   ]                                        │
│ }                                          │
└────────────────────────────────────────────┘
         ↓ [sent to backend] ↓

BACKEND PROCESSING:
┌────────────────────────────────────────────┐
│ 1. Verify JWT token in header               │
│ 2. Extract user_id = 5 from token          │
│ 3. DELETE FROM recipients WHERE user_id=5  │
│ 4. INSERT new recipients (2 rows)          │
│ 5. Format response                         │
└────────────────────────────────────────────┘
         ↓ [sent to mobile] ↓

RESPONSE:
┌────────────────────────────────────────────┐
│ {                                          │
│   "success": true,                         │
│   "message": "Successfully saved 2         │
│               recipients",                 │
│   "recipientsCount": 2                     │
│ }                                          │
└────────────────────────────────────────────┘
```

## ⏱️ Timeline Diagram

### Typical User Session
```
TIME    EVENT                           STATE
────────────────────────────────────────────────────
0:00    App opened, login shown
        └─ recipients: []               (default empty)

0:05    User enters credentials
        └─ Email/password shown         (user typing)

0:10    Login button pressed
        └─ API request sent             (authenticating)

0:11    Server validates, returns token
        └─ user.token received          (authenticated)

0:12    Dashboard screen shown
        └─ useEffect triggered          (auto-load hook)

0:13    GET /api/users/recipients
        └─ API request sent             (fetching)

0:14    Backend queries database
        └─ 3 recipients found           (database query)

0:15    Response received
        └─ Recipients loaded            (setRecipients called)

0:16    Dashboard rendered
        └─ All 3 recipients shown       ✅ LOADED!

0:20    User adds new recipient
        └─ Email typed: "hr@google"     (editing)

0:23    User waits 2 seconds
        └─ No more changes              (debounce counting)

0:25    2 seconds elapsed
        └─ POST /api/users/recipients   (auto-save triggered)

0:26    Backend saves to database
        └─ 4 recipients now stored      (database updated)

0:27    Response received
        └─ Log: "✅ Saved 4 recipients" ✅ SAVED!

0:30    User closes app
        └─ App terminated               (session ends)

────────────────────────────────────────────────────

NEXT DAY:

10:00   App reopened
        └─ Login screen shown           (fresh start)

10:05   User logs in again
        └─ Same credentials             (same user)

10:06   Dashboard shown
        └─ useEffect triggered          (auto-load again)

10:07   GET /api/users/recipients
        └─ API request sent             (fetching)

10:08   Response received
        └─ All 4 recipients loaded      ✅ NO DATA LOSS!

10:09   Dashboard rendered
        └─ Shows exactly what was there
           yesterday!                   ✅ PERSISTENCE WORKS!
```

## 🎯 State Diagram

### Recipients Lifecycle
```
             [INITIAL]
                │
                ▼
    ┌──────────────────────┐
    │  Waiting for Login   │
    │  recipients: []      │
    └──────────┬───────────┘
               │
          [User logs in]
               │
               ▼
    ┌──────────────────────┐
    │  Loading Recipients  │
    │  (fetching from DB)  │
    └──────────┬───────────┘
               │
        [API Response]
               │
               ▼
    ┌──────────────────────┐
    │  Recipients Loaded   │
    │  [user1, user2, ...] │
    └──────────┬───────────┘
               │
          [User Edits]
               │
               ▼
    ┌──────────────────────┐
    │  Saving Recipients   │
    │  (posting to API)    │
    └──────────┬───────────┘
               │
        [API Response]
               │
               ▼
    ┌──────────────────────┐
    │  Recipients Saved    │
    │  (persisted to DB)   │
    └──────────────────────┘
               │
          [Continue editing]
               └─→ [Back to Saving state]
```

---

**Visual Architecture Complete!** 

All flows, diagrams, and communications documented for easy understanding.
