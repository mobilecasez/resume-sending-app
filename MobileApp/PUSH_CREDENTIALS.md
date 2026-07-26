# iOS push credentials — do not turn this off

`eas.json` sets:

```json
"cli": { "promptToConfigurePushNotifications": true }
```

**Keep it `true`.**

It was `false` for months. When the Expo project moved to `@zsellr02s-team` on 2026-07-18, no APNs
key came with it, and because this flag was `false` every build since then *silently skipped*
push-credential setup. The result: from 18 to 26 July 2026 **every** iOS push was rejected by Expo
with `InvalidCredentials`, for all 35 users with a registered device — no reply notifications, no
follow-up reminders, no digests, and no admin install/sign-up alerts. Nothing reported it, because
the sender only checked whether Expo *accepted* the message, never whether Apple *delivered* it.

With `true`, a build that has no push credentials fails loudly instead of shipping a binary whose
notifications can never work. It does **not** prompt while a key exists — non-interactive builds run
normally.

> ⚠️ The explanation cannot live in `eas.json`: it is validated strictly and rejects unknown keys —
> adding a `"_promptToConfigurePushNotifications"` note key breaks every build with
> `eas.json is not valid`.

## If push ever breaks again

1. Check the real state — this reads Apple's delivery **receipt**, not just Expo's ticket:
   `GET /api/admin/push-health`, or the admin "Send test" button (it now returns `delivered`).
2. If the error says `InvalidCredentials`, the project has no APNs key. Run:
   `bash fix-ios-push.sh` → `Push Notifications: Manage your Apple Push Notifications Key`
   → `Set up your project to use Push Notifications` → Apple ID + 2FA → `Y`.
3. No rebuild is needed — the key lives on Expo's servers, so existing installs recover immediately.
