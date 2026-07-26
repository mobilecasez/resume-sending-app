#!/bin/bash
# ═════════════════════════════════════════════════════════════════════════════
#  FIX iOS PUSH NOTIFICATIONS   —   run this in Terminal:
#
#      bash "/Users/rishisamadhiya/Desktop/Files/Personal/Shopify Apps/resume-sending-app/fix-ios-push.sh"
#
#  Takes about 2 minutes. No build is produced and no build quota is used.
# ═════════════════════════════════════════════════════════════════════════════
#
#  THE PROBLEM
#  Expo rejects every iOS push with:
#      "Could not find APNs credentials for com.cvapplyr.mobile (@zsellr02s-team/cvapplyr)"
#  The Expo project moved to @zsellr02s-team on 18 July and no APNs key was ever created on it.
#  I checked every Expo account we have (zsellr02s-team, zsellr, zsellr01, zsellr_01) — none holds
#  a push key that could be copied over, so a new one has to be made at Apple.
#
#  WHY YOU HAVE TO DO IT
#  Apple only lets a real Apple ID session (with 2FA) create a push key. The App Store Connect API
#  key builds and submits fine but is refused for this — the automated attempt stops at "Apple ID:".
#
#  WHAT TO DO WHEN IT OPENS  (use arrow keys + Enter)
#     1.  "What do you want to do?"        →  Build Credentials: Manage everything needed to build
#     2.  Apple asks for your Apple ID, password, and a 2FA code  →  enter them
#     3.  "What do you want to do?"        →  Push Notifications: Manage your Apple Push Notifications Key
#     4.  choose                            →  Set up a new push key
#     5.  "Generate a new Apple Push Notifications Key?"  →  Y
#     6.  when it shows the new Key ID, press  Ctrl-C  — you are done
#
#  ⚠️  Do NOT pick any "Distribution Certificate" or "Provisioning Profile" option. Those are
#      already correct; changing one can break signing for every future build.
#
#  AFTER
#  No rebuild is needed. The key lives on Expo's servers, so every phone already out there —
#  including yours — can receive pushes as soon as it exists. Tell me and I'll fire a real push and
#  read Apple's delivery receipt back to prove it landed.
# ═════════════════════════════════════════════════════════════════════════════
set -e
ROOT="/Users/rishisamadhiya/Desktop/Files/Personal/Shopify Apps/resume-sending-app"
cd "$ROOT/MobileApp"

export PATH="/Users/rishisamadhiya/.nvm/versions/node/v22.22.2/bin:$PATH"
export EXPO_TOKEN="m8Qsqq3NNv7QUONeRTLlJ2dkVVl0C8nQH--DJpPL"
export EXPO_APPLE_TEAM_ID="P38822Z963"
export EXPO_APPLE_TEAM_TYPE="COMPANY_OR_ORGANIZATION"
# EXPO_ASC_API_KEY_PATH is deliberately NOT set: with the API-key session Apple refuses to create a
# push key. Unset, EAS falls back to the Apple ID cookie login, which is allowed to.

# The push options are hidden unless this is on; put it back however the script exits.
restore() { sed -i '' 's/"promptToConfigurePushNotifications": true/"promptToConfigurePushNotifications": false/' eas.json 2>/dev/null || true; }
trap restore EXIT
sed -i '' 's/"promptToConfigurePushNotifications": false/"promptToConfigurePushNotifications": true/' eas.json

cat <<'GUIDE'

  ┌──────────────────────────────────────────────────────────────────────┐
  │  1. Build Credentials: Manage everything needed to build             │
  │  2. sign in with your Apple ID + 2FA when asked                      │
  │  3. Push Notifications: Manage your Apple Push Notifications Key     │
  │  4. Set up a new push key                                            │
  │  5. answer  Y                                                        │
  │  6. Ctrl-C once it prints the new Key ID                             │
  │                                                                      │
  │  Do NOT touch Distribution Certificate / Provisioning Profile.       │
  └──────────────────────────────────────────────────────────────────────┘

GUIDE

/opt/homebrew/bin/eas credentials -p ios || true
