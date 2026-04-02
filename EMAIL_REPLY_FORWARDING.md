# Email Reply Forwarding Setup

## How It Works Now

Each user gets a unique Reply-To address using **plus addressing** (email subaddressing):

- User 1: `cv+user1@cvapplyr.com`
- User 2: `cv+user2@cvapplyr.com`
- User 3: `cv+user3@cvapplyr.com`

**Benefits:**
- ✅ No spam penalty (uses domain email)
- ✅ Unique address per user (trackable)
- ✅ All emails still arrive at `cv@cvapplyr.com`
- ✅ Can set up automatic forwarding per user

---

## Option 1: Basic Forwarding (All Users)

Forward all emails from `cv@cvapplyr.com` to your main email.

### Setup in Zoho:

1. Go to **Zoho Mail** → **Settings** (gear icon)
2. Click **Mail Accounts** → **Email Forwarding**
3. Add forwarding address (your Gmail)
4. Zoho will send verification email
5. Click verification link
6. Enable forwarding

**Result**: All replies go to one inbox (you manually forward to users)

---

## Option 2: Smart Forwarding (Recommended)

Set up filters to forward based on the +userX part.

### Setup Email Filters in Zoho:

1. Go to **Settings** → **Filters**
2. Click **Add Filter**

**For Each User:**

**Filter Name**: Forward to User 1
**Condition**: 
- If **To** contains `+user1`
- Action: **Forward to** → `samrishi24@gmail.com`

**Filter Name**: Forward to User 2
**Condition**:
- If **To** contains `+user2`
- Action: **Forward to** → `user2email@gmail.com`

Repeat for each user.

### Automated Setup (If you have many users):

1. Store user email in database (already have user.email)
2. When user registers, create Zoho filter via API
3. Or use a catch-all and process in your backend

---

## Option 3: Backend Processing (Advanced)

Instead of Zoho filters, process in your application:

### Step 1: Set Up IMAP in Your Backend

```javascript
// Check cv@cvapplyr.com inbox periodically
// Parse +userX from To: header
// Forward to correct user's email
```

### Step 2: Add to server.js

```javascript
// Check inbox every 5 minutes
setInterval(async () => {
    const emails = await checkInbox();
    for (const email of emails) {
        const userId = extractUserIdFromEmail(email.to); // Extract from cv+user1@...
        const user = await getUserById(userId);
        if (user) {
            await forwardEmail(email, user.email);
        }
    }
}, 5 * 60 * 1000);
```

---

## Option 4: Catch-All with Manual Check

### Setup:

1. Keep `cv@cvapplyr.com` as Reply-To
2. Check inbox daily
3. Look at which application (by subject line)
4. Forward to correct user

**Pros**: Simple, no code needed
**Cons**: Manual work required

---

## Recommended Setup (For Your Use Case)

Since you have a small number of active users sending applications:

### Quick Solution:

1. **For now**: Employers see applicant's direct email prominently in email body
   - Most will click the email link to respond directly
   - No forwarding needed

2. **For Reply button users**: 
   - Emails go to `cv+user1@cvapplyr.com`
   - You check cv@cvapplyr.com periodically
   - Forward manually (or set up basic filter)

### Long-term Solution (When you have many users):

1. Build IMAP email checking in your backend
2. Auto-forward based on +userX tag
3. Or use Zoho API to create filters programmatically

---

## Testing

Send test email to `cv+user1@cvapplyr.com`:

```bash
echo "Test reply" | mail -s "Test Subject" cv+user1@cvapplyr.com
```

Check:
- ✅ Email arrives at `cv@cvapplyr.com`
- ✅ You can see `+user1` in To: field
- ✅ Filter forwards to correct user (if set up)

---

## Important Notes

### Plus Addressing Support

- ✅ Zoho: Supported
- ✅ Gmail: Supported
- ✅ Most email providers: Supported
- ⚠️ Some old systems may not support it

### Spam Score Impact

- ✅ `cv+user1@cvapplyr.com` = Same as `cv@cvapplyr.com`
- ✅ No spam penalty (uses domain email)
- ✅ Much better than `samrishi24@gmail.com` in Reply-To

### Database Tracking

You can track which user sent which application:
- Extract user ID from Reply-To
- Match with application_history table
- Know exactly who needs the reply

---

## Need Help Setting Up?

Let me know which option you prefer and I can:
1. Create the IMAP email checker backend code
2. Generate Zoho filter configurations
3. Set up a webhook-based solution

**Current Status**: 
- ✅ Code updated to use plus addressing
- ⏳ Choose forwarding method (Option 1, 2, 3, or 4)
- ⏳ Set up forwarding in Zoho
