#!/bin/bash

echo "🔄 Starting Resume Sending App Servers..."
echo ""

# Kill existing processes
echo "🛑 Stopping existing servers..."
pkill -9 node 2>/dev/null
pkill -9 expo 2>/dev/null
pkill -f "expo start" 2>/dev/null
sleep 3

# Detect local IP — pick the IP that can actually reach the internet
# (en0 = WiFi on Mac, which is what the phone uses on the same network)
echo "🔍 Detecting local IP address..."
LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null)
# Fallback: first non-loopback IP
if [ -z "$LOCAL_IP" ]; then
  LOCAL_IP=$(ifconfig | grep "inet " | grep -v 127.0.0.1 | awk '{print $2}' | head -n 1)
fi

if [ -z "$LOCAL_IP" ]; then
    echo "❌ Could not detect local IP address"
    exit 1
fi

echo "✅ Detected IP: $LOCAL_IP"
echo ""

# Update only the LOCAL_API_URL line in config.js (preserves production URL and apiFetch)
echo "📝 Updating MobileApp config with local IP..."
CONFIG_FILE="MobileApp/config.js"
sed -i '' "s|const LOCAL_API_URL = '.*';|const LOCAL_API_URL = 'http://${LOCAL_IP}:3000/api';|" "$CONFIG_FILE"

echo "✅ Config updated with IP: $LOCAL_IP"
echo ""

# Start backend server
echo "🚀 Starting backend server on $LOCAL_IP:3000..."
cd "$(dirname "$0")"
node server.js > /tmp/backend.log 2>&1 &
BACKEND_PID=$!
echo "✅ Backend started (PID: $BACKEND_PID)"
echo ""

# Wait for backend to be ready
echo "⏳ Waiting for backend to be ready..."
sleep 4

# Check if backend is responding
if curl -s "http://${LOCAL_IP}:3000/api/health" > /dev/null 2>&1; then
    echo "✅ Backend is healthy and responding"
else
    echo "⚠️  Backend might not be ready yet, but continuing..."
fi
echo ""

# Start Expo with the same IP
echo "🚀 Starting Expo on $LOCAL_IP:8081..."
cd MobileApp
npx expo start --clear --host lan &
EXPO_PID=$!
echo "✅ Expo started (PID: $EXPO_PID)"
echo ""

echo "========================================="
echo "✅ ALL SERVERS STARTED SUCCESSFULLY!"
echo "========================================="
echo ""
echo "📱 Backend API: http://${LOCAL_IP}:3000"
echo "📱 Expo Metro: exp://${LOCAL_IP}:8081"
echo ""
echo "📋 Backend PID: $BACKEND_PID"
echo "📋 Expo PID: $EXPO_PID"
echo ""
echo "📝 Logs:"
echo "   Backend: tail -f /tmp/backend.log"
echo "   Expo: (shown in terminal)"
echo ""
echo "🛑 To stop servers: pkill -9 node; pkill -9 expo"
echo "========================================="
