# CVApplyr — Deployment Guide

## Quick Deploy (both stores)

```bash
# 1. Bump versions in app.json first:
#    version: 1.0.x → 1.0.x+1
#    ios buildNumber: N → N+1
#    android versionCode: N → N+1

# 2. Build on EAS cloud
cd MobileApp
eas build --platform all --profile production --non-interactive

# 3. Submit to both stores
eas submit --platform all --profile production --latest --non-interactive
```

## Local Build (faster, no queue)

```bash
cd MobileApp
eas build --platform all --profile production --local
```

## Apple Credentials

| Field | Value |
|---|---|
| Apple ID | zsellr.in@gmail.com |
| Team ID | P38822Z963 |
| App Bundle ID | com.cvapplyr.mobile |
| App Store Connect App ID | 6762126502 |
| API Key ID | 33Y3J5248R |
| Issuer ID | bc162399-5ecc-4cdd-baf4-a143d5b1eb65 |
| API Key File | Keys/AuthKey_33Y3J5248R.p8 |

> The API key bypasses 2FA for all fastlane and EAS operations.

## Android Credentials

| Field | Value |
|---|---|
| Package | com.cvapplyr.mobile |
| Keystore | MobileApp/@zsellr__cvapplyr-mobile.jks |
| Service Account Key | Keys/cvapplyr-e46cebab373e.json |
| Play Store Track | internal |

## App Store Connect

- App: [App Store Connect](https://appstoreconnect.apple.com/apps/6762126502)
- Company: zSellr (OPC) Private Limited

## EAS Build Links (latest)

- Android: https://expo.dev/artifacts/eas/bcMG9bnvEiqpLcjUYVmJQL.aab
- iOS: https://expo.dev/artifacts/eas/6fEdijimukB8ZAPvMgjYgT.ipa

## Notes

- `.easignore` is configured — build archive is ~50-70 MB (not 670 MB)
- EAS project ID: 992a6de3-e46e-4788-953d-f799671672eb
- EAS account: zsellr
- `ANDROID_HOME` is set in `~/.zshrc`
