#!/bin/bash
# ============================================================
#  CVApplyr — Local Android Release Build
#  Replicates exactly what EAS does on its build servers.
#
#  Usage:
#    chmod +x build-android.sh
#    ./build-android.sh
#
#  What this does (same as EAS):
#    1. expo prebuild --clean  → regenerates android/ from app.json + plugins
#    2. Injects release signing config into build.gradle
#    3. ./gradlew bundleRelease → builds signed .aab
#    4. eas submit             → uploads to Google Play internal track
# ============================================================

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# --- Signing credentials (EAS keystore) ---
KEYSTORE_PATH="$SCRIPT_DIR/../@zsellr__cvapplyr-mobile.jks"
KEYSTORE_PASSWORD="a072dfd54860b12edcc6d907e721fc81"
KEY_ALIAS="5ea6506c90f0e66322bb96824e774da1"
KEY_PASSWORD="25099f2cd7c601d4c70511e446b7bb65"

echo ""
echo "========================================"
echo "  CVApplyr Android Release Build"
echo "========================================"
echo ""

# ── STEP 1: expo prebuild --clean ──────────────────────────
echo "STEP 1/3 — expo prebuild --clean (regenerating android/ from app.json)..."
npx expo prebuild --clean --platform android --npm
echo "✅ prebuild done"
echo ""

# ── STEP 2: Inject release signing config ──────────────────
# expo prebuild generates android/app/build.gradle but doesn't
# include the release keystore (EAS handles that server-side).
# We patch it here for local builds.
echo "STEP 2/3 — injecting release signing config..."

BUILD_GRADLE="android/app/build.gradle"

# Add signingConfigs.release block (after the debug block)
python3 - << PYEOF
import re

with open('$BUILD_GRADLE', 'r') as f:
    content = f.read()

# Check if release signing already patched
if 'storeFile file' in content and 'zsellr' in content:
    print('  signing config already present, skipping')
else:
    # Inject release signing config after the debug block
    debug_block = '''        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }'''
    release_block = debug_block + '''
        release {
            storeFile file('../../@zsellr__cvapplyr-mobile.jks')
            storePassword '$KEYSTORE_PASSWORD'
            keyAlias '$KEY_ALIAS'
            keyPassword '$KEY_PASSWORD'
        }'''
    content = content.replace(debug_block, release_block)

    # Make release buildType use the release signingConfig
    content = content.replace(
        'buildTypes {\n        release {',
        'buildTypes {\n        release {\n            signingConfig signingConfigs.release'
    )

    with open('$BUILD_GRADLE', 'w') as f:
        f.write(content)
    print('  ✅ signing config injected')

PYEOF

# Set local.properties for Android SDK
echo "sdk.dir=$HOME/Library/Android/sdk" > android/local.properties
echo "✅ signing config done"
echo ""

# ── STEP 3: Build AAB ──────────────────────────────────────
echo "STEP 3/3 — building release AAB..."
cd android
./gradlew bundleRelease --no-daemon 2>&1 | grep -E "BUILD|error:|FAILURE|AAB"
cd ..

AAB_PATH="android/app/build/outputs/bundle/release/app-release.aab"
echo "✅ AAB built → $AAB_PATH"
echo ""

echo "Submitting to Google Play..."
npx eas submit --platform android \
  --path "$AAB_PATH" \
  --profile production \
  --non-interactive

echo ""
echo "========================================"
echo "  ✅ Android build complete and submitted!"
echo "========================================"
