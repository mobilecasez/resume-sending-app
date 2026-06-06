#!/bin/bash
# ============================================================
#  CVApplyr — Local iOS Release Build
#  Replicates exactly what EAS does on its build servers.
#
#  Usage:
#    chmod +x build-ios.sh
#    ./build-ios.sh
#
#  What this does (same as EAS):
#    1. expo prebuild --clean  → regenerates ios/ from app.json + all plugins
#    2. Applies the local machine fix for space in "Shopify Apps" path
#    3. xcodebuild archive     → compiles + signs with distribution cert
#    4. xcodebuild export      → produces a signed .ipa
#    5. altool upload          → submits to App Store Connect
# ============================================================

set -e  # Exit on any error

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# --- Config ---
SCHEME="CVApplyr"
TEAM_ID="P38822Z963"
ASC_API_KEY="33Y3J5248R"
ASC_ISSUER="bc162399-5ecc-4cdd-baf4-a143d5b1eb65"
ARCHIVE_PATH="$SCRIPT_DIR/build/CVApplyr.xcarchive"
EXPORT_PATH="$SCRIPT_DIR/build/export"
WORKSPACE="ios/CVApplyr.xcworkspace"

echo ""
echo "========================================"
echo "  CVApplyr iOS Release Build"
echo "========================================"
echo ""

# ── STEP 1: expo prebuild --clean ──────────────────────────
# This is the step EAS runs first. It:
#  - Wipes ios/ and regenerates it from app.json
#  - Applies all plugins: splash screen, icons, permissions,
#    URL schemes, Apple Sign-In, Razorpay, etc.
#  - Runs pod install at the end
echo "STEP 1/5 — expo prebuild --clean (regenerating ios/ from app.json)..."
npx expo prebuild --clean --platform ios --npm --no-install
# pod install must use UTF-8 locale (Ruby 4 + path with space breaks otherwise)
cd ios && LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 RUBYOPT="-E UTF-8" pod install && cd ..
# Restore correct NODE_BINARY (prebuild overwrites .xcode.env.local with Homebrew Node 24)
echo "export NODE_BINARY=/Users/rishisamadhiya/.nvm/versions/node/v22.22.2/bin/node" > ios/.xcode.env.local
echo "✅ prebuild done"
echo ""

# ── STEP 2: Fix bash word-split (space in "Shopify Apps" path) ──
# CocoaPods generates a script that uses 'bash -l -c "..."'
# This breaks when the project path contains a space.
# pod install wipes this fix every time, so we re-apply it here.
echo "STEP 2/5 — Applying bash word-split fix for path with space..."
PODS_PBXPROJ="ios/Pods/Pods.xcodeproj/project.pbxproj"
if grep -q 'bash -l -c' "$PODS_PBXPROJ" 2>/dev/null; then
  # Remove the -l -c flags so bash doesn't word-split the path
  sed -i '' 's|bash -l -c "\$PODS_TARGET_SRCROOT|bash "\$PODS_TARGET_SRCROOT|g' "$PODS_PBXPROJ"
  echo "✅ bash fix applied"
else
  echo "✅ bash fix already applied or not needed"
fi
echo ""

# ── STEP 3: Archive ─────────────────────────────────────────
echo "STEP 3/5 — xcodebuild archive..."
rm -rf "$ARCHIVE_PATH"
xcodebuild \
  -workspace "$WORKSPACE" \
  -scheme "$SCHEME" \
  -configuration Release \
  -archivePath "$ARCHIVE_PATH" \
  -allowProvisioningUpdates \
  -destination "generic/platform=iOS" \
  archive | grep -E "error:|warning: CVApplyr|ARCHIVE SUCCEEDED|ARCHIVE FAILED"
echo "✅ archive done → $ARCHIVE_PATH"
echo ""

# ── STEP 4: Export IPA ──────────────────────────────────────
echo "STEP 4/5 — exporting IPA..."
rm -rf "$EXPORT_PATH"

# ExportOptions.plist — app-store-connect + automatic signing
cat > /tmp/CVApplyrExportOptions.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>app-store-connect</string>
    <key>teamID</key>
    <string>P38822Z963</string>
    <key>signingStyle</key>
    <string>automatic</string>
    <key>uploadSymbols</key>
    <true/>
    <key>compileBitcode</key>
    <false/>
</dict>
</plist>
EOF

xcodebuild -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportPath "$EXPORT_PATH" \
  -exportOptionsPlist /tmp/CVApplyrExportOptions.plist \
  -allowProvisioningUpdates 2>&1 | tail -5

IPA_PATH=$(find "$EXPORT_PATH" -name "*.ipa" | head -1)
echo "✅ IPA exported → $IPA_PATH"
echo ""

# ── STEP 5: Upload to App Store Connect ─────────────────────
echo "STEP 5/5 — uploading to App Store Connect..."
xcrun altool --upload-app \
  --type ios \
  --file "$IPA_PATH" \
  --apiKey "$ASC_API_KEY" \
  --apiIssuer "$ASC_ISSUER"

echo ""
echo "========================================"
echo "  ✅ iOS build complete and uploaded!"
echo "========================================"
