#!/bin/bash

# Test the Google OAuth endpoint
# This will help us debug the 400 error

echo "Testing POST /api/auth/google endpoint..."
echo ""

# Test 1: Empty body (should get 400)
echo "Test 1: Empty body request"
curl -X POST http://192.168.1.14:3000/api/auth/google \
  -H "Content-Type: application/json" \
  -d "{}" \
  -w "\nStatus: %{http_code}\n\n"

# Test 2: With fake token (should get 401 from Google)
echo "Test 2: With fake access token"
curl -X POST http://192.168.1.14:3000/api/auth/google \
  -H "Content-Type: application/json" \
  -d '{"accessToken": "fake_token_for_testing"}' \
  -w "\nStatus: %{http_code}\n\n"

# Test 3: Test with correct payload format
echo "Test 3: Checking request format"
curl -X POST http://192.168.1.14:3000/api/auth/google \
  -H "Content-Type: application/json" \
  -d '{"accessToken": "test"}' \
  -v 2>&1 | grep -A 5 "request body"
