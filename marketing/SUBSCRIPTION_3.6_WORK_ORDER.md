# CVApplyr 3.6 — subscription migration: exact state and the work left

Written 2026-08-06. Everything here is VERIFIED against the live stores/DB, not assumed.
Start a fresh session with this file and the ordered list below is directly executable.

## DONE

- **Apple subscription group `22290874` "CVApplyr Plans"** created, with five auto-renewable products:
  `com.cvapplyr.mobile.sub.{starter,plus,pro,power,max}` — $4.99 / 9.99 / 14.99 / 24.99 / 49.99, ONE_MONTH.
  ⚠️ These ids are PERMANENT. The `.sub.` namespace exists because the four old CONSUMABLES already
  own `com.cvapplyr.mobile.<name>`. `entitlements.js` must be aligned to THESE ids — do not adopt the
  `com.cvapplyr.sub.*` ids the audit proposed, they do not exist.
- Duration, prices, localizations, review screenshots: set by the account holder.
  State at handover: 4 × READY_TO_SUBMIT, `pro` still MISSING_METADATA (cause not visible via API —
  localization, 5 prices and screenshot all read identical to `plus`; resolve in the console).
- **Paid Apps agreement Active**, HDFC bank Active, W-8BEN-E + foreign-status forms Active, DSA Active.
- **App Store Server Notifications** production URL live: `https://cvapplyr.com/api/webhooks/apple-notifications`
  → verified HTTP 200 on both cvapplyr.com and the Railway host. Route: `server/routes/analyticsRoutes.js:10`.
- Review screenshots ready: `marketing/iap-review/cvapplyr-iap-review-1024-list.png` (1024×1024).
- iOS builds 148 + 149 VALID in TestFlight (Auto Fill retry fix; in-app browser search fix).
- `gj_` notification resolver fixed and deployed (was capped at 60k of 163k jobs).

## NOT DONE — in the order it must happen

### 1. Live money bugs (fix BEFORE anything else; #1 is exploitable today)
1. `server/controllers/paymentController.js:584-589` — the no-receipt branch trusts a client-supplied
   `productId`. This is the branch production takes. Any valid JWT mints credits. Replace with App
   Store Server API `getTransactionInfo`.
2. `MobileApp/App.js:1131-1138` — on a network failure during `/payment/verify-apple` the card is
   charged, the user is told "credits will be added shortly", `finishTransaction` is never called and
   the txId is never cleared from `processedTransactionsRef`. Recovery is dead because
   `getAvailablePurchases` / `getReceiptIOS` / `purchaseErrorListener` are UNDECLARED
   (`App.js:1161`, `:1373`, `:1061`) → ReferenceError. Mirror the working path at `:1072`.
3. `MobileApp/App.js:95` — `iap.getProducts` does not exist in react-native-iap 15.3.1 → `fetchProducts`.
   Because of this `iapProducts` is always `[]`, so `App.js:6502-6521` shows raw USD instead of Apple's
   localized price. Non-US users see a different price than they are charged — an Apple rejection.
4. UNVERIFIED, on the money path: does `appleNotifications` verify Apple's JWS signature? It returns
   200 to a junk payload (correct for delivery ack, but says nothing about whether it acts on it).
   If it does not verify, a forged "renewed" notification grants a plan. READ THIS FIRST.

### 2. Schema + grant path
5. Migration in `db-init.js`: `user_subscriptions` needs `original_transaction_id`, `purchase_token`,
   `store`, and a UNIQUE index on `(store, original_transaction_id)` — today a replayed webhook stacks
   duplicate active rows.
6. `entitlements.js` — add `storeSetSubscription({...})` upserting on that index.
   ⚠️ `period_end` MUST come from the store's expiry. Do NOT reuse `adminSetSubscription`'s hardcoded
   `NOW() + INTERVAL '30 days'`, or paying users lose or keep access on the wrong date.
7. Keep `canConsumeMany` order as-is (`entitlements.js:176-214`): plan → trial → legacy credits.
   19 payment_orders / $476.81 exist under the old model; those balances must keep working.

### 3. Client
8. Wire `plans.tsx:30-37` to a real purchase; render price from the store object's `displayPrice`,
   never `p.priceUsd`.
9. Android: `App.js:1142` returns early on non-iOS. Wire `requestSubscription` with
   `subscriptionOfferDetails[].offerToken`.
10. ⚠️ REMOVE Razorpay from the Android digital-goods path (`App.js:1473`) — selling in-app content
    outside Play Billing is a Play Payments violation and risks the listing.

### 4. Blocked on the account holder
- **Play**: merchant/payments profile (owner-only), and grant `eas-submit@cvapplyr.iam.gserviceaccount.com`
  the "Manage store presence" permission. Play has ZERO subscriptions today. User is doing this.
- **Apple**: resolve `pro`'s MISSING_METADATA in the console.

### 5. Release
- Cancel the two Apple `reviewSubmissions` stuck in READY_FOR_REVIEW (`0a1dbf44-…`, `23386668-…`).
  ASC allows one open submission per app; they will collide with 3.6. Cancellable by API.
- Bump `expo.version` to 3.6, build from `~/cvapplyr-build` (see project_ios_build_desktop_tcc),
  submit with the subscriptions attached, promote on Play.

## Also pending, unrelated to money
- Translation speed: measured, root-caused. The AI is 1.7–3.9s; the 10–15s is a **4.8s blind wait**
  (16 × 300ms) for Google's widget. The instant failure signal exists (`sc.onerror` → `TRANSLATE_FAIL`)
  and NOTHING in the app handles it; `XLATE_WIDGET_DEAD` has no handler either. Wire a receiver.
- The video push (youtube.com/shorts/Di7LwQUDnT8): needs a `url` route in `MobileApp/services/pushRouting.ts`
  — it has no URL case and no Linking import, so a tap currently goes nowhere. Copy approved by the user:
  "See CVApplyr in 60 seconds 🎬 / Watch how to find jobs, auto-fill applications and send your CV —
  a quick video walkthrough." Send to the founder's account FIRST, then to all.
