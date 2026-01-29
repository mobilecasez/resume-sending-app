# 🚀 Quick Start Guide - Admin Package Management

## Getting Started

### 1. Server Status
✅ **Server is running** on http://localhost:3000

### 2. Admin Access

**Admin User:** `samrishi24@gmail.com`  
**Admin URL:** http://localhost:3000/admin-packages.html

### 3. Pre-Created Packages

Three sample packages are already created and active:

| Package | Price | Credits | Validity | Popular |
|---------|-------|---------|----------|---------|
| Starter Pack | $9.99 | 50 | 30 days | No |
| Professional Pack | $24.99 | 150 | 60 days | Yes ⭐ |
| Premium Pack | $49.99 | 350 | 90 days | No |

## How to Access Admin Panel

### Method 1: From Dashboard
1. Login as `samrishi24@gmail.com`
2. Go to http://localhost:3000/index.html
3. Look for the **shield icon (🛡️)** in the navigation bar
4. Click it to access Package Management

### Method 2: Direct URL
1. Login as `samrishi24@gmail.com`
2. Navigate directly to: http://localhost:3000/admin-packages.html

## Testing the System

### Test 1: View Packages (Public API)
```bash
curl http://localhost:3000/api/packages
```
This returns all active packages (anyone can view)

### Test 2: Check Admin Status (Requires Login)
1. Login as samrishi24@gmail.com
2. Get auth token from localStorage
3. Test:
```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:3000/api/user/is-admin
```
Should return: `{"isAdmin":true}`

### Test 3: Create New Package
1. Go to admin panel
2. Click "+ Create Package"
3. Fill in:
   - Name: "Trial Pack"
   - Amount: 4.99
   - Credits: 25
   - Validity: 15
   - Description: "Try before you buy!"
4. Click "Save Package"

## Package Management Operations

### ➕ Create Package
- Click "+ Create Package" button
- Fill required fields (Name, Amount, Credits, Validity)
- Optional: Add description, change currency, mark as popular
- Click "Save Package"

### ✏️ Edit Package
- Click "Edit" button on package card
- Modify any fields
- Click "Save Package"

### 🗑️ Delete Package
- Click "Delete" button
- Confirm deletion
- Package removed permanently

### 🔄 Toggle Active/Inactive
- Click "Activate" or "Deactivate" button
- Inactive packages hidden from users but visible in admin panel

## Package Display Order

Packages are sorted by `display_order` (ascending):
- Lower numbers appear first
- Same number sorted by ID
- Use for controlling which packages users see first

Example:
- Starter: display_order = 1 (shows first)
- Professional: display_order = 2 (shows second)
- Premium: display_order = 3 (shows third)

## Popular Badge

Mark a package as "Popular" to show a ⭐ badge:
- Check "Mark as Popular" when creating/editing
- Usually used for middle-tier "best value" packages
- Guides users toward recommended choice

## API Endpoints Summary

### Public (No Auth Required):
- `GET /api/packages` - Get all active packages

### Admin Only (Requires Admin Token):
- `GET /api/admin/packages` - Get all packages
- `GET /api/admin/packages/:id` - Get single package
- `POST /api/admin/packages` - Create package
- `PUT /api/admin/packages/:id` - Update package
- `DELETE /api/admin/packages/:id` - Delete package
- `PATCH /api/admin/packages/:id/toggle-active` - Toggle status

### User Auth:
- `GET /api/user/is-admin` - Check admin status

## Database Structure

### credit_packages table:
```
id, name, amount, credits, validity_days, 
description, currency, is_active, is_popular, 
display_order, created_at, updated_at
```

### users table (updated):
```
... existing fields ...
role (TEXT DEFAULT 'user')
```

## Security Notes

🔒 **Access Control:**
- Only `samrishi24@gmail.com` has admin role
- Other users get 403 Forbidden on admin endpoints
- Admin button only visible to admin users

🔐 **Adding More Admins:**
```sql
-- To make another user admin
UPDATE users 
SET role = 'admin' 
WHERE email = 'another@email.com';
```

## Troubleshooting

### Admin button not showing?
- Ensure you're logged in as samrishi24@gmail.com
- Clear browser cache and refresh
- Check console for errors

### Can't access admin page?
- Verify you're logged in (check localStorage for authToken)
- Ensure server is running on port 3000
- Check browser console for API errors

### Packages not loading?
- Check server console for database errors
- Verify credit_packages table exists
- Test API: `curl http://localhost:3000/api/packages`

## Next Steps

1. **Test the System:**
   - Login as admin
   - Create a test package
   - Edit it, toggle status, delete it

2. **Customize Packages:**
   - Update sample packages with real pricing
   - Add better descriptions
   - Set appropriate validity periods

3. **Integration:**
   - Connect packages to payment gateway (future)
   - Implement credit expiry tracking (future)
   - Add mobile admin screen (future)

## Quick Commands

```bash
# Check server status
ps aux | grep "node server.js" | grep -v grep

# Start server
cd "/Users/rishisamadhiya/Desktop/Files/Personal/Shopify Apps/resume-sending-app"
node server.js

# Test packages API
curl http://localhost:3000/api/packages

# View database
sqlite3 database.db "SELECT * FROM credit_packages;"

# Check admin users
sqlite3 database.db "SELECT email, role FROM users WHERE role = 'admin';"
```

---

**Status:** ✅ System Ready
**Admin User:** samrishi24@gmail.com
**Admin URL:** http://localhost:3000/admin-packages.html
