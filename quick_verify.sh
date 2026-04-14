#!/bin/bash
# Quick verification after re-login

echo "🔍 Checking security implementation after fresh login..."
echo ""

# Check token encryption
echo "1️⃣ Token Encryption Status:"
psql postgresql://rishisamadhiya@localhost:5432/cvapplyr_dev -c \
"SELECT id, email, 
 CASE 
   WHEN google_access_token LIKE 'ya29.%' THEN '❌ UNENCRYPTED'
   WHEN google_access_token LIKE 'U2Fsd%' THEN '✅ ENCRYPTED'
   ELSE '⚠️  OTHER'
 END as encryption_status
FROM users WHERE id = 15;"
echo ""

# Check expiration tracking
echo "2️⃣ Token Expiration Tracking:"
psql postgresql://rishisamadhiya@localhost:5432/cvapplyr_dev -c \
"SELECT id, email, 
 google_token_issued_at,
 google_token_expires_at,
 CASE 
   WHEN google_token_expires_at IS NULL THEN '❌ NO TRACKING'
   WHEN google_token_expires_at > NOW() THEN '✅ VALID (' || ROUND(EXTRACT(EPOCH FROM (google_token_expires_at - NOW())) / 60) || ' min left)'
   ELSE '⚠️  EXPIRED'
 END as status
FROM users WHERE id = 15;"
echo ""

# Check security audit log
echo "3️⃣ Security Audit Log:"
psql postgresql://rishisamadhiya@localhost:5432/cvapplyr_dev -c \
"SELECT 
 id,
 event_type, 
 event_category,
 details->>'provider' as provider,
 details->>'flow' as flow,
 success,
 created_at
FROM security_audit_log 
WHERE user_id = 15
ORDER BY created_at DESC 
LIMIT 5;"
echo ""

# Summary  
echo "📊 Summary:"
psql postgresql://rishisamadhiya@localhost:5432/cvapplyr_dev -c \
"SELECT 
CASE 
  WHEN google_access_token NOT LIKE 'ya29.%' AND google_access_token IS NOT NULL 
    THEN '✅' 
  ELSE '❌' 
END || ' Token Encrypted' as feature_1,
CASE 
  WHEN google_token_expires_at IS NOT NULL 
    THEN '✅' 
  ELSE '❌' 
END || ' Expiration Tracked' as feature_2,
CASE 
  WHEN EXISTS (SELECT 1 FROM security_audit_log WHERE user_id = 15) 
    THEN '✅ (' || (SELECT COUNT(*)::text FROM security_audit_log WHERE user_id = 15) || ' events)'
  ELSE '❌' 
END || ' Audit Logged' as feature_3
FROM users WHERE id = 15;"
