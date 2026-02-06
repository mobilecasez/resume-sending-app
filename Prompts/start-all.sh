#!/bin/bash

echo "🔄 Starting Resume Sending App Servers..."
echo ""

# Kill existing processes
echo "🛑 Stopping existing servers..."
pkill -9 node 2>/dev/null
pkill -9 expo 2>/dev/null
pkill -f "expo start" 2>/dev/null
sleep 3

# Detect local IP automatically
echo "🔍 Detecting local IP address..."
LOCAL_IP=$(ifconfig | grep "inet " | grep -v 127.0.0.1 | awk '{print $2}' | head -n 1)

if [ -z "$LOCAL_IP" ]; then
    echo "❌ Could not detect local IP address"
    exit 1
fi

echo "✅ Detected IP: $LOCAL_IP"
echo ""

# Get the project root directory (parent of prompts folder)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Update config file with detected IP
echo "📝 Updating MobileApp config..."
CONFIG_FILE="$PROJECT_ROOT/MobileApp/config.js"
cat > "$CONFIG_FILE" << EOF
// Auto-generated config - DO NOT EDIT MANUALLY
// This file is updated automatically by start-all.sh

const LOCAL_API_URL = 'http://${LOCAL_IP}:3000/api';
const PRODUCTION_API_URL = 'https://your-production-domain.com/api';

const API_BASE = __DEV__ ? LOCAL_API_URL : PRODUCTION_API_URL;

export default { API_BASE_URL: API_BASE };
export { API_BASE, LOCAL_API_URL, PRODUCTION_API_URL };
EOF

echo "✅ Config updated with IP: $LOCAL_IP"
echo ""

# Start backend server
echo "🚀 Starting backend server on $LOCAL_IP:3000..."
cd "$PROJECT_ROOT"
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
cd "$PROJECT_ROOT/MobileApp"
npx expo start --clear --lan &
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
