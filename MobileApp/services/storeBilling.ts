// AI Hub — new feature. Safe to delete without affecting existing app.
//
// The ONE place the app talks to StoreKit / Google Play Billing about SUBSCRIPTIONS.
//
// Everything here is deliberately defensive, because this module is the only code path in the app
// that can take money:
//
//   • `react-native-iap` is loaded through require() inside a try/catch. It is a NATIVE module, so
//     it does not exist in Expo Go and it does not exist in a build where the pod failed. Every
//     export below degrades to "the store is unavailable" instead of throwing — the caller then
//     renders the honest no-purchase state rather than a price nobody can buy.
//   • A transaction is NEVER finished here. `finishSubscription()` exists as a separate call so the
//     caller can only reach it after the SERVER has confirmed the entitlement. Finishing early is
//     how you take someone's money and deliver nothing.
//   • Prices are never computed. Whatever the store hands back in `displayPrice` is what the user
//     is charged, in their currency, and that string is what the UI must show.
//
// ⚠️ App.js keeps its OWN global purchaseUpdatedListener for the legacy CONSUMABLE credit packs.
// It fires for every transaction, including the subscriptions bought here. See the note in
// App.js next to IAP_SUBSCRIPTION_PREFIX.
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import type { Purchase, PurchaseError, ProductSubscription } from 'react-native-iap';

/** A subscription product as the STORE describes it. `displayPrice` is the localized truth. */
export type StoreSubscriptionProduct = {
  sku: string;
  /** Localized, store-formatted price — e.g. "$4.99", "4,99 €", "₹449". Never build this yourself. */
  displayPrice: string;
  currency: string | null;
  title: string | null;
  /** Google Play base-plan offer token. Required to buy on Android; always null on iOS. */
  offerToken: string | null;
};

export type PurchaseOutcome =
  /** The store says the purchase completed. NOT yet an entitlement — the server still has to agree. */
  | { status: 'purchased'; purchase: Purchase }
  /** Android deferred/slow payment (e.g. cash). No money yet, no entitlement, nothing to finish. */
  | { status: 'pending' }
  /** The user backed out. Say nothing. */
  | { status: 'cancelled' }
  /** Store billing is not usable on this build/device at all. */
  | { status: 'unavailable' }
  /** The store refused, or we never heard back. */
  | { status: 'failed'; message: string };

/**
 * Google Play `replacementMode` — how Play settles the money when one subscription replaces another.
 *
 * ⚠️ ONLY THESE TWO ARE SAFE FOR THIS PRICING LADDER, and the reason is that every plan we sell is a
 * QUOTA (30 letters, 100, 1000…) metered over the billing period, not a feature flag. Any mode that
 * moves the renewal date therefore also moves the quota window, and the server counts usage from the
 * start of that window:
 *
 *   1 WITH_TIME_PRORATION  ❌ — what this file used to hardcode. Charges $0 today and converts the
 *       unused value into TIME on the new plan. Upgrading shortens the term, downgrading can extend
 *       it enormously (25 days of Max ≈ 8 months of Starter). Either way the user gets a different
 *       tier's allowance without a payment, which is exactly the free-quota hole this replaces.
 *   3 WITHOUT_PRORATION    ❌ — new tier immediately, no charge, no credit. A free upgrade.
 *   5 CHARGE_FULL_PRICE    ❌ — bills a whole new month on the spot and throws away the days the
 *       user already paid for. Defensible for a feature upgrade, indefensible mid-cycle here.
 *   2 CHARGE_PRORATED_PRICE ✅ UPGRADES. Bills the difference for the remainder of the cycle NOW and
 *       leaves the renewal date alone — so the window is untouched, the allowance simply gets bigger
 *       and what has already been spent still counts against it. (Play rejects this for downgrades.)
 *   6 DEFERRED             ✅ DOWNGRADES. Nothing is charged and nothing changes until the renewal
 *       date the user has already paid for; the cheaper tier starts then. The only downgrade mode
 *       that neither refunds money we cannot claw back nor hands over free time.
 */
export const PLAY_REPLACEMENT = {
  CHARGE_PRORATED_PRICE: 2,
  DEFERRED: 6,
} as const;

export type PlayReplacementMode = (typeof PLAY_REPLACEMENT)[keyof typeof PLAY_REPLACEMENT];

type IapModule = typeof import('react-native-iap');

const isExpoGo = Constants.appOwnership === 'expo';

let iapModule: IapModule | null = null;
let loadTried = false;

function iap(): IapModule | null {
  if (loadTried) return iapModule;
  loadTried = true;
  if (isExpoGo) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    iapModule = require('react-native-iap') as IapModule;
  } catch {
    iapModule = null;   // Expo Go, or a build without the pod. Not an error — just no store.
  }
  return iapModule;
}

/** Cheap synchronous check the UI can call before it decides what to render. */
export function isStoreBillingAvailable(): boolean {
  return iap() !== null && (Platform.OS === 'ios' || Platform.OS === 'android');
}

// initConnection() is shared process-wide (App.js also calls it on iOS for the credit packs), so
// hold onto the first promise and reuse it rather than opening a second billing client.
let connectPromise: Promise<boolean> | null = null;

export function initStoreBilling(): Promise<boolean> {
  if (connectPromise) return connectPromise;
  const m = iap();
  if (!m) return Promise.resolve(false);
  connectPromise = (async () => {
    try {
      await m.initConnection();
      return true;
    } catch (e: any) {
      connectPromise = null;   // transient (Play Services updating) — let a later attempt retry
      console.log('[storeBilling] initConnection failed:', e?.message || e);
      return false;
    }
  })();
  return connectPromise;
}

// NOTE: endConnection() is never called. App.js documents why (v15 races if the connection is torn
// down while a transaction is in flight), and the OS reclaims it when the process dies anyway.

/**
 * Ask the store which of `skus` actually exist and what they cost HERE.
 *
 * A sku missing from the result is the normal, expected case while the products are still being
 * created/reviewed, or in a territory with no price. The caller must treat "missing" as
 * "not purchasable" — never as "show the USD list price".
 */
export async function fetchSubscriptionProducts(skus: string[]): Promise<StoreSubscriptionProduct[]> {
  const m = iap();
  if (!m || skus.length === 0) return [];
  if (!(await initStoreBilling())) return [];
  try {
    const raw = (await m.fetchProducts({ skus, type: 'subs' })) || [];
    const want = new Set(skus);
    const out: StoreSubscriptionProduct[] = [];
    for (const item of raw) {
      const p = item as ProductSubscription;
      // The sku allowlist is the real guard — `skus` comes from the server's plan catalog, which is
      // the same source of truth as storeProducts.js, so a consumable id can never appear in it.
      // `p.type` is NOT used to reject: it is set from a native string the library itself only warns
      // about when it disagrees (convertProductToProductSubscription), and a single mislabelled
      // product would silently make the whole paywall unbuyable. Log the disagreement, keep the row.
      if (!p || !p.id || !want.has(p.id) || !p.displayPrice) continue;
      if (p.type !== 'subs') console.log('[storeBilling] store reported type', p.type, 'for', p.id);

      const offerToken = androidOfferToken(p);
      // Google Play will not open a purchase sheet for a subscription without an offer token, and a
      // base plan that was created but never ACTIVATED returns none. Dropping the product here is
      // what makes the UI render the honest "not on sale yet" row; keeping it would show a real
      // localized price behind a Subscribe button that can only ever fail.
      if (Platform.OS === 'android' && !offerToken) {
        console.log('[storeBilling] no offer token for', p.id, '— not purchasable');
        continue;
      }

      out.push({
        sku: p.id,
        displayPrice: p.displayPrice,
        currency: p.currency ?? null,
        title: p.title ?? p.displayName ?? null,
        offerToken,
      });
    }
    return out;
  } catch (e: any) {
    console.log('[storeBilling] fetchProducts failed:', e?.message || e);
    return [];
  }
}

/** The Play base-plan offer token, or null when Play offered none (see the caller). */
function androidOfferToken(p: ProductSubscription): string | null {
  if (Platform.OS !== 'android') return null;
  const anyP = p as any;
  const offers: any[] = anyP.subscriptionOfferDetailsAndroid || anyP.subscriptionOffers || [];
  if (!Array.isArray(offers) || offers.length === 0) return null;
  // Prefer the plain `monthly` base plan with no promotional offerId; otherwise take the first.
  const base = offers.find((o) => o && !o.offerId && (o.offerToken || o.offerTokenAndroid));
  const chosen = base || offers[0];
  return chosen?.offerToken || chosen?.offerTokenAndroid || null;
}

/**
 * The sku whose purchase sheet is open right now, or null.
 *
 * App.js keeps a GLOBAL purchaseErrorListener for the legacy consumable credit packs, and StoreKit
 * delivers subscription errors to it too. Its errors do not always carry a productId, so the prefix
 * check alone cannot tell whose failure it is — and the result was a second, generic "Purchase
 * Error" alert stacked on top of the paywall's own honest message. App.js reads this to stay out of
 * the way while the subscription screen owns a transaction.
 */
let inFlightSku: string | null = null;
export function subscriptionPurchaseInFlight(): string | null {
  return inFlightSku;
}

/**
 * Run the store purchase sheet.
 *
 * Resolves only once the store has told us something. It does NOT verify, does NOT grant anything
 * and does NOT finish the transaction — the caller owns that order.
 */
export async function purchaseSubscription(opts: {
  sku: string;
  /** Android only, from fetchSubscriptionProducts(). Missing token = unbuyable, we refuse early. */
  offerToken?: string | null;
  /** Apple: UUID that lets the server attribute a later renewal webhook to this user. */
  appAccountToken?: string | null;
  /** Play: same purpose, any opaque stable string. */
  obfuscatedAccountId?: string | null;
  /** Play upgrade/downgrade: the token of the subscription being replaced. */
  replacePurchaseToken?: string | null;
  /**
   * REQUIRED whenever `replacePurchaseToken` is set — see PLAY_REPLACEMENT. There is deliberately no
   * default: the caller is the only code that knows whether this is an upgrade or a downgrade, and
   * guessing costs real money in both directions.
   */
  replacementMode?: PlayReplacementMode | null;
  /**
   * The sku being replaced. A DEFERRED change reports the OLD product back (the current purchase is
   * what stays live until renewal), so without this the result is filtered out as "not ours" and the
   * caller waits out the full timeout on a change the store actually accepted.
   */
  replacedSku?: string | null;
}): Promise<PurchaseOutcome> {
  const m = iap();
  if (!m) return { status: 'unavailable' };
  if (!(await initStoreBilling())) return { status: 'unavailable' };

  if (Platform.OS === 'android' && !opts.offerToken) {
    // Base plan not activated, or the user is eligible for no offer. Do not open a sheet that fails.
    return { status: 'failed', message: 'This plan is not on sale on Google Play yet.' };
  }
  // Fail closed. Opening the sheet without a mode is what made Play fall back to WITH_TIME_PRORATION,
  // and no purchase at all is cheaper than one settled on the wrong terms.
  if (opts.replacePurchaseToken && !opts.replacementMode) {
    console.log('[storeBilling] refusing a replacement with no replacementMode for', opts.sku);
    return { status: 'failed', message: 'We could not work out how to switch this plan. Please manage it in Google Play.' };
  }

  // Race the listener against the direct return: iOS StoreKit 2 usually resolves requestPurchase
  // with the Purchase, Android usually delivers it only through the listener.
  let settled = false;
  let resolveRace: (o: PurchaseOutcome) => void = () => {};
  const race = new Promise<PurchaseOutcome>((res) => { resolveRace = res; });
  const settle = (o: PurchaseOutcome) => { if (!settled) { settled = true; resolveRace(o); } };

  // Both skus count as "ours": on a DEFERRED downgrade Play hands back the purchase that is still
  // live (the one being replaced), which is the confirmation that the change was accepted.
  const ours = (productId?: string) =>
    !!productId && (productId === opts.sku || (!!opts.replacedSku && productId === opts.replacedSku));

  inFlightSku = opts.sku;
  const subs: { remove(): void }[] = [];
  try {
    subs.push(m.purchaseUpdatedListener((purchase: Purchase) => {
      if (!ours(purchase?.productId)) return;   // not ours — App.js's listener owns credit packs
      settle(classify(purchase));
    }));
    subs.push(m.purchaseErrorListener((err: PurchaseError) => {
      if (err?.productId && !ours(err.productId)) return;
      settle(fromError(err));
    }));
  } catch (e: any) {
    // Listener registration itself failed — we would have no way to observe the result.
    subs.forEach((s) => { try { s.remove(); } catch {} });
    inFlightSku = null;
    return { status: 'failed', message: e?.message || 'Could not start the purchase.' };
  }

  try {
    const direct = await m.requestPurchase({
      type: 'subs',
      request: {
        apple: {
          sku: opts.sku,
          ...(opts.appAccountToken ? { appAccountToken: opts.appAccountToken } : {}),
          // Never let the library auto-finish: the server has not confirmed anything yet.
          andDangerouslyFinishTransactionAutomatically: false,
        },
        google: {
          skus: [opts.sku],
          subscriptionOffers: opts.offerToken ? [{ sku: opts.sku, offerToken: opts.offerToken }] : [],
          ...(opts.obfuscatedAccountId ? { obfuscatedAccountId: opts.obfuscatedAccountId } : {}),
          ...(opts.replacePurchaseToken && opts.replacementMode
            ? {
                purchaseToken: opts.replacePurchaseToken,
                // Never hardcoded. See PLAY_REPLACEMENT: 2 for an upgrade (bill the difference now,
                // keep the renewal date and therefore the quota window), 6 for a downgrade (change
                // nothing until the period the user already paid for runs out).
                replacementMode: opts.replacementMode,
              }
            : {}),
        },
      },
    });
    const one = firstPurchase(direct);
    if (one && ours(one.productId)) settle(classify(one));
  } catch (e: any) {
    settle(fromError(e));
  }

  // If neither path has produced anything the transaction is genuinely in limbo. Report that
  // honestly rather than guessing — nothing is finished, so a relaunch can still recover it.
  const timeout = new Promise<PurchaseOutcome>((res) =>
    setTimeout(() => res({ status: 'failed', message: 'The store did not confirm this purchase.' }), 180000)
  );
  const outcome = await Promise.race([race, timeout]);
  subs.forEach((s) => { try { s.remove(); } catch {} });
  inFlightSku = null;
  return outcome;
}

function firstPurchase(v: unknown): Purchase | null {
  if (!v) return null;
  if (Array.isArray(v)) return (v[0] as Purchase) || null;
  return v as Purchase;
}

function classify(purchase: Purchase): PurchaseOutcome {
  // Android PENDING (slow card, cash at a store): money has NOT moved. Granting here would give away
  // a plan for a payment that may never arrive.
  if (purchase.purchaseState === 'pending') return { status: 'pending' };
  return { status: 'purchased', purchase };
}

function fromError(err: PurchaseError | (Error & { code?: string })): PurchaseOutcome {
  const code = String((err as any)?.code || '');
  if (code === 'user-cancelled' || code === 'E_USER_CANCELLED' || /cancel/i.test(code)) {
    return { status: 'cancelled' };
  }
  if (code === 'deferred-payment' || code === 'E_DEFERRED_PAYMENT') return { status: 'pending' };
  return { status: 'failed', message: (err as any)?.message || 'The purchase could not be completed.' };
}

/**
 * Hand the transaction back to the store. Call this ONLY after the server has written the
 * entitlement — on Android this is also the Play acknowledgement, and an unacknowledged purchase is
 * auto-refunded and revoked after 3 days.
 */
export async function finishSubscription(purchase: Purchase): Promise<boolean> {
  const m = iap();
  if (!m) return false;
  try {
    await m.finishTransaction({ purchase, isConsumable: false });
    return true;
  } catch (e: any) {
    console.log('[storeBilling] finishTransaction failed:', e?.message || e);
    return false;
  }
}

/**
 * Everything the store still considers owned by this Apple ID / Google account.
 *
 * `alsoPublishToEventListenerIOS: false` matters: it keeps these from being re-broadcast into
 * App.js's global consumable listener.
 */
export async function getOwnedSubscriptions(skus: string[]): Promise<Purchase[]> {
  const m = iap();
  if (!m) return [];
  if (!(await initStoreBilling())) return [];
  try {
    const all = (await m.getAvailablePurchases({
      alsoPublishToEventListenerIOS: false,
      onlyIncludeActiveItemsIOS: true,
    })) || [];
    const want = new Set(skus);
    return (all as Purchase[]).filter((p) => p && want.has(p.productId) && p.purchaseState !== 'pending');
  } catch (e: any) {
    console.log('[storeBilling] getAvailablePurchases failed:', e?.message || e);
    return [];
  }
}

/** Open the OS subscription manager. Apple requires a route to cancel/manage from inside the app. */
export async function openManageSubscriptions(): Promise<boolean> {
  const m = iap();
  if (!m) return false;
  try {
    await m.deepLinkToSubscriptions({});
    return true;
  } catch (e: any) {
    console.log('[storeBilling] deepLinkToSubscriptions failed:', e?.message || e);
    return false;
  }
}
