#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# FIX iOS PUSH NOTIFICATIONS — run this in your Terminal:
#
#     bash "/Users/rishisamadhiya/Desktop/Files/Personal/Shopify Apps/resume-sending-app/fix-ios-push.sh"
#
# WHY: the Expo project moved to @zsellr02s-team on 2026-07-18 and the APNs key never came with it.
# Expo now rejects EVERY iOS push with:
#     "Could not find APNs credentials for com.cvapplyr.mobile (@zsellr02s-team/cvapplyr)"
# Nothing is delivered — not the admin install/sign-up alerts, and not the reply, follow-up or
# digest notifications the 35 users with a registered device should be getting.
#
# WHY YOU HAVE TO RUN IT: minting an APNs key needs a real Apple ID login + 2FA. The App Store
# Connect API key is enough to build and submit, but Apple will not let it create a push key —
# verified: the automated run stops at an "Apple ID:" prompt.
#
# WHAT IT DOES (~2 minutes, no build is consumed):
#   1. temporarily turns push-credential setup ON in eas.json
#   2. starts an interactive EAS build so Expo provisions credentials
#   3. Apple asks for your Apple ID + password + a 2FA code -> enter them
#   4. answer  Y  to "...set up Push Notifications for your project?"
#   5. answer  Y  to "...generate a new Apple Push Notifications service key?"
#   6. once the key is created, press Ctrl-C — the key is already uploaded to Expo and the
#      build itself is not needed
#   7. eas.json is put back the way it was, automatically
#
# WARNING: if it ever asks about the DISTRIBUTION CERTIFICATE or the PROVISIONING PROFILE, press
# Ctrl-C and tell me. Those are already correct, and regenerating one can break signing for future
# builds (Apple caps distribution certificates at 3 per account).
#
# NO REBUILD IS NEEDED AFTERWARDS. The key lives on Expo's servers, so phones already out there —
# including yours — start receiving pushes as soon as it is uploaded. Tell me when it's done and
# I'll send a test push and read Apple's delivery receipt back to confirm it actually landed.
# ─────────────────────────────────────────────────────────────────────────────
set -e
ROOT="/Users/rishisamadhiya/Desktop/Files/Personal/Shopify Apps/resume-sending-app"
cd "$ROOT/MobileApp"

export PATH="/Users/rishisamadhiya/.nvm/versions/node/v22.22.2/bin:$PATH"
export EXPO_TOKEN="m8Qsqq3NNv7QUONeRTLlJ2dkVVl0C8nQH--DJpPL"
export EXPO_APPLE_TEAM_ID="P38822Z963"
export EXPO_APPLE_TEAM_TYPE="COMPANY_OR_ORGANIZATION"
# NOTE: EXPO_ASC_API_KEY_PATH is deliberately NOT set. With the API-key session Apple refuses to
# create a push key; leaving it unset makes EAS use the Apple ID cookie login, which can.

restore() { sed -i '' 's/"promptToConfigurePushNotifications": true/"promptToConfigurePushNotifications": false/' eas.json 2>/dev/null || true; }
trap restore EXIT

sed -i '' 's/"promptToConfigurePushNotifications": false/"promptToConfigurePushNotifications": true/' eas.json

echo ""
echo "→ Provisioning the APNs push key for @zsellr02s-team/cvapplyr"
echo "→ Answer Y to the two Push Notifications questions."
echo "→ Press Ctrl-C once the push key is created — the build does NOT need to finish."
echo ""

/opt/homebrew/bin/eas build --platform ios --profile production --no-wait || true
