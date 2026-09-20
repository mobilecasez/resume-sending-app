// AI Hub — new feature. Safe to delete without affecting existing app.
//
// The plan catalog: the Free plan, the monthly tiers (wired to real store subscriptions) and the
// one-time pass ("Just need one?"). Every allowance number on a card — resumes, cover letters,
// downloads — is READ from the server's plan list, never written here.
//
// ── The rule this screen is built around ─────────────────────────────────────────────────────
// A plan gets a BUY button only if the store returned a product for it, and its price is the
// store's own localized string. If the store returns nothing for a plan — products not created
// yet, still in review, Play base plan not activated, no price in this territory, Expo Go, a build
// without the pod — that plan falls back to the honest "not on sale yet" state with no purchase.
//
// That is structural, not a checklist item, and it buys two things:
//   • This screen is safe to ship at ANY point while the store products are being provisioned.
//     Before they exist it simply behaves the way it did before purchases were wired.
//   • Nobody is ever shown a price they cannot be charged, or a price that differs from the one
//     the store will actually charge them (the #1 way a paywall gets rejected AND the #1 way a
//     non-US user gets a nasty surprise).
//
// ── The other rule ───────────────────────────────────────────────────────────────────────────
// "Subscribed" is a fact the SERVER states, never one this screen infers. The store saying
// "purchased" only means money moved. The entitlement exists when /subscription/status says it
// does, and the transaction is not finished with the store until then — an unfinished transaction
// is recoverable on the next launch or via Restore; a finished, unverified one is money taken for
// nothing.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Alert, Platform, Linking,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import {
  fetchSubscriptionStatus, storeAccountToken, verifyStoreSubscription,
  foreignStoreFor, purchaseBlock, markEntitlementsChanged,
  type SubscriptionStatus, type Plan,
} from '../../services/subscriptionService';
import {
  isStoreBillingAvailable, fetchSubscriptionProducts, purchaseSubscription, finishSubscription,
  getOwnedSubscriptions, openManageSubscriptions, PLAY_REPLACEMENT,
  type StoreSubscriptionProduct, type PlayReplacementMode,
} from '../../services/storeBilling';
import type { Purchase } from 'react-native-iap';
import {
  buyDownloadPass, fetchPassPrice, fetchDownloadState, type DownloadState,
} from '../../services/downloadPassService';

const T = {
  bg: '#F0F4FA', card: '#FFFFFF', ink: '#0B0F22', muted: '#5B6B8A', faint: '#8896B0',
  line: 'rgba(11,15,34,0.06)', blue: '#2563EB', cyan: '#06B6D4', emerald: '#10B981', amber: '#D97706',
};
// The middle tier is what most people should pick — flag it.
const POPULAR_KEY = 'plus';

/**
 * The server's PLANS rows carry `downloads` (the monthly download allowance) but the shared `Plan`
 * type does not declare it yet. Read it defensively: a number or nothing, never a default — a
 * download count this screen invented is a count the paywall would later contradict.
 */
function downloadsOf(p: Plan): number | null {
  const n = (p as Plan & { downloads?: unknown }).downloads;
  return typeof n === 'number' && n >= 0 ? n : null;
}

/** Shared by every card: every generation researches the employer first (employerResearch.js),
 *  on the Free plan and the one-time pass as much as on a paid plan — it is not a paid-only perk. */
const RESEARCH_LINE = 'Every employer researched · designs ranked by fit';

/**
 * A pass purchase that MONEY HAS MOVED ON (or may still move on) but the server has not shown yet.
 *   paid    — the store transaction completed: the user is charged, the pass is just not visible.
 *   pending — deferred / Ask-to-Buy: no charge yet, but approving it later charges them.
 * ⚠️ Either way the Buy button must NOT come back. It used to: buyDownloadPass returned ok:false
 * with a note, the button re-enabled, and a second tap bought a second pass for the same need.
 * `baseline` is the unused-pass count BEFORE the purchase, so "confirmed" means the count went UP —
 * an older unused pass is not proof that THIS payment landed.
 * Module scope, not component state: leaving Plans and coming back must not resurrect the button
 * for the rest of this app session (a relaunch is covered by the stranded-purchase recovery that
 * buyDownloadPass runs before it ever opens the store sheet).
 */
type PassSettling = { kind: 'paid' | 'pending'; baseline: number };
let passSettlingMemo: PassSettling | null = null;

/**
 * Whether a failed buyDownloadPass result still means the store CHARGED them (contract C1 adds
 * `paid`). Until every build of the service carries it, read the service's own wording too: its
 * "payment went through" and "could not confirm … applied automatically" branches both come AFTER
 * the store transaction completed. Cancelled is never paid.
 */
function passResultPaid(r: { cancelled?: boolean; message?: string } & { paid?: boolean }): boolean {
  if (r.cancelled) return false;
  if (r.paid === true) return true;
  const m = (r.message || '').toLowerCase();
  return /payment went through|still applying it|applied automatically|could not confirm the purchase/.test(m);
}

/**
 * What the SERVER decided about a store purchase.
 *   confirmed — the entitlement row exists. The only state that may be called "subscribed".
 *   retry     — we could not ask (offline, 5xx, endpoint not deployed). Money may have moved; the
 *               transaction stays unfinished so the next launch or Restore finishes the job.
 *   rejected  — a definitive no. `reason` is the server's own error code/message, and it is shown,
 *               because "already linked to another account" needs a different answer from the user
 *               than "we could not verify this".
 */
type Settlement = { result: 'confirmed' | 'retry' | 'rejected'; reason: string | null };

/** Server error codes worth explaining in the user's own terms. */
function rejectionText(reason: string | null): string {
  if (reason === 'already_linked') {
    return 'This subscription is already active on another cvApplyr account. Sign in with that account, '
      + 'or contact support and we will move it across. You have not been charged twice.';
  }
  if (reason === 'transaction_unknown_to_apple' || reason === 'token_unknown_to_google') {
    return 'The store does not recognise this purchase, so we cannot switch the plan on. If you were '
      + 'charged, please contact support with your store receipt — do not buy again.';
  }
  return 'Your store purchase was not accepted by our server, so it has not been finalised. Please '
    + 'contact support and we will sort it out — do not buy again.';
}

const TERMS_URL = 'https://cvapplyr.com/terms-of-service';
const PRIVACY_URL = 'https://cvapplyr.com/privacy-policy';

/** The store product id for this plan on THIS platform. */
function skuFor(p: Plan): string | null {
  const sku = Platform.OS === 'ios' ? p.productIos : Platform.OS === 'android' ? p.productAndroid : null;
  return sku || null;
}

/**
 * What it takes to move a Play user from the subscription they already own onto a new one:
 * which purchase is being replaced, and on what terms (`mode` — see PLAY_REPLACEMENT).
 */
type Replacement = { token: string; sku: string; mode: PlayReplacementMode };

/** A store expiry as a plain date — never a phrase that pretends to know one we do not have. */
function whenText(iso?: string | null): string {
  if (!iso) return 'your renewal date';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'your renewal date';
  try { return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }); }
  catch { return d.toDateString(); }
}

export default function PlansScreen() {
  const [status, setStatus] = useState<SubscriptionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  /** Keyed by plan key. A key present here === that plan is genuinely purchasable right now. */
  const [store, setStore] = useState<Record<string, StoreSubscriptionProduct>>({});
  /**
   * Whether the store has been ASKED yet. Without this the screen renders "Not on sale yet" on
   * every row for the second or two `fetchProducts` takes, which reads as a hard no rather than a
   * pending answer — and is what the user sees first.
   */
  const [storeChecked, setStoreChecked] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const alive = useRef(true);
  const recovered = useRef(false);
  /**
   * The one-time pass ("Just need one?"). `passPrice` is the STORE's localized string or null — the
   * same rule as the plans: no store price, no Buy button (the card then explains that the option is
   * offered right on the resume when you tailor it). `dl` also tells the plan cards whether downloads
   * are metered yet: unmetered, a subscriber's downloads are not counted, so a "/ month" figure would
   * be a limit that does not exist.
   */
  const [passPrice, setPassPrice] = useState<string | null>(null);
  const [dl, setDl] = useState<DownloadState | null>(null);
  const [passBusy, setPassBusy] = useState(false);
  const [passNote, setPassNote] = useState<string | null>(null);
  /** See PassSettling. Seeded from the module memo so a remount keeps the Buy button away. */
  const [passSettling, setPassSettlingState] = useState<PassSettling | null>(passSettlingMemo);
  const [passChecking, setPassChecking] = useState(false);
  const setPassSettling = useCallback((v: PassSettling | null) => {
    passSettlingMemo = v;
    if (alive.current) setPassSettlingState(v);
  }, []);

  const storeUsable = isStoreBillingAvailable();
  // Declared up here, not next to the JSX that also uses it: `choose` closes over it, and anything
  // declared after the `if (loading) return` is in the temporal dead zone on the loading render.
  const storeName = Platform.OS === 'ios' ? 'the App Store' : 'Google Play';

  // ⚠️ A plan this screen SEES for the first time is news for the screen underneath it (2026-09-20). The wizard
  // that sent the user here is still mounted with its "no allowance" refusal on it, and the plan may have arrived
  // with no purchase this app performed at all — an admin grant, a store webhook, a second device. This fires only
  // on the transition none → a plan, so a re-read that finds what it already knew tells nobody anything.
  const sawPlan = useRef(false);
  const loadStatus = useCallback(async (): Promise<SubscriptionStatus | null> => {
    try {
      const s = await fetchSubscriptionStatus();
      if (alive.current) setStatus(s);
      const has = !!(s && s.subscription);
      if (has && !sawPlan.current) markEntitlementsChanged();
      sawPlan.current = has;
      return s;
    } catch { return null; }
  }, []);

  /**
   * The one place a store purchase turns into an entitlement.
   * Verify first, finish second, and never in the other order.
   */
  const settleOne = useCallback(async (purchase: Purchase): Promise<Settlement> => {
    const res = await verifyStoreSubscription({
      productId: purchase.productId,
      purchaseToken: purchase.purchaseToken ?? null,
      transactionId: (purchase as any).transactionId ?? purchase.id ?? null,
      accountToken: await storeAccountToken(),
    });
    if (res.confirmed) {
      // Only now. On Android this is also the Play acknowledgement — Google auto-refunds and
      // revokes anything unacknowledged after 3 days, so it must not happen any earlier or later.
      await finishSubscription(purchase);
      return { result: 'confirmed', reason: null };
    }
    // Left UNFINISHED on purpose: the store will hand it back on the next launch or Restore.
    return { result: res.retryable ? 'retry' : 'rejected', reason: res.message };
  }, []);

  /** Tally, not a boolean: "3 confirmed" and "3 we could not ask about" need different words. */
  const settleAll = useCallback(async (purchases: Purchase[]) => {
    const tally = { confirmed: 0, retry: 0, rejected: 0, reason: null as string | null };
    for (const p of purchases) {
      const { result, reason } = await settleOne(p);
      tally[result] += 1;
      if (result === 'rejected' && !tally.reason) tally.reason = reason;
    }
    return tally;
  }, [settleOne]);

  // Independent of the subscription load: a slow or missing pass product must never hold up the
  // plan list, and a failure here just leaves the card in its "offered when you tailor" state.
  useEffect(() => {
    let on = true;
    fetchPassPrice().then((p) => { if (on) setPassPrice(p); }).catch(() => {});
    fetchDownloadState().then((d) => {
      if (!on) return;
      setDl(d);
      // Came back to Plans after the payment landed elsewhere (App.js's listener, recovery): the
      // count is up, so the settling card has nothing left to wait for.
      const memo = passSettlingMemo;
      if (memo && d.passes > memo.baseline) { passSettlingMemo = null; setPassSettlingState(null); }
    }).catch(() => {});
    return () => { on = false; };
  }, []);

  useEffect(() => {
    alive.current = true;
    (async () => {
      const s = await loadStatus();
      if (!alive.current) return;
      setLoading(false);

      if (!storeUsable || !s?.plans?.length) { setStoreChecked(true); return; }
      const skus = s.plans.map(skuFor).filter((x): x is string => !!x);
      const products = await fetchSubscriptionProducts(skus);
      if (!alive.current) return;

      const bySku = new Map(products.map((p) => [p.sku, p]));
      const map: Record<string, StoreSubscriptionProduct> = {};
      for (const plan of s.plans) {
        const sku = skuFor(plan);
        const prod = sku ? bySku.get(sku) : undefined;
        if (prod) map[plan.key] = prod;
      }
      setStore(map);
      setStoreChecked(true);

      // A purchase that was paid for but never confirmed (server down, app killed mid-verify) is
      // still sitting unfinished with the store. Quietly try again — no alerts, no interruption.
      if (!recovered.current) {
        recovered.current = true;
        const owned = await getOwnedSubscriptions(skus);
        if (owned.length && alive.current) {
          const n = await settleAll(owned);
          if (n.confirmed > 0 && alive.current) await loadStatus();
        }
      }
    })();
    return () => { alive.current = false; };
  }, [loadStatus, storeUsable, settleAll]);

  /**
   * Android only: the subscription this purchase must REPLACE, and on what terms.
   *
   * ⚠️ The terms are the whole point. Play settles a replacement according to `replacementMode`, and
   * the wrong mode either gives the new tier's monthly quota away for $0 or takes money for days the
   * user already owns. Which one is correct depends entirely on the DIRECTION of the move, so this
   * places both ends on the server's plan ladder (`status.plans`, cheapest first) and picks:
   *   upgrade   → CHARGE_PRORATED_PRICE — bill the difference for the rest of the cycle, renewal
   *               date (and therefore the quota window) untouched.
   *   downgrade → DEFERRED — charge nothing, change nothing until the paid period ends.
   *
   * `{ ok: false }` means we could not place one of the two on the ladder. That is not a case to
   * paper over with a default: no purchase at all is cheaper than one settled on guessed terms.
   */
  const replacementFor = useCallback(async (
    target: Plan, targetSku: string,
  ): Promise<{ ok: true; replacement: Replacement | null } | { ok: false }> => {
    const plans = status?.plans || [];
    if (Platform.OS !== 'android' || !plans.length) return { ok: true, replacement: null };
    const skus = plans.map(skuFor).filter((x): x is string => !!x);
    const owned = await getOwnedSubscriptions(skus);
    const other = owned.find((p) => p.productId !== targetSku && p.purchaseToken);
    const token = other?.purchaseToken;
    if (!other || !token) return { ok: true, replacement: null };   // nothing to replace: a fresh buy

    const fromIdx = plans.findIndex((p) => skuFor(p) === other.productId);
    const toIdx = plans.findIndex((p) => p.key === target.key);
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return { ok: false };

    const upgrade = toIdx > fromIdx;
    return {
      ok: true,
      replacement: {
        token,
        sku: other.productId,
        mode: upgrade ? PLAY_REPLACEMENT.CHARGE_PRORATED_PRICE : PLAY_REPLACEMENT.DEFERRED,
      },
    };
  }, [status]);

  const choose = useCallback(async (p: Plan) => {
    if (busyKey || restoring) return;
    const prod = store[p.key];

    // ⚠️ THE DOUBLE-CHARGE GUARD (subscriptionService.purchaseBlock). The row's buy affordance is
    // hidden in these cases, but the whole card is the touch target, so the render-time `buyable`
    // flag alone never prevented the purchase — it only stopped advertising it.
    const blocked = purchaseBlock(status, p.key);
    if (blocked) {
      Alert.alert(blocked.title, blocked.body);
      return;
    }

    // No store product → the honest stub. Same behaviour this screen had before purchases existed.
    if (!prod) {
      Alert.alert(
        // "US list" because this is the catalog price, not a quote: the store has not told us what
        // this user would actually be charged, and inventing a local figure is the exact thing this
        // screen exists to avoid.
        `${p.label} — $${p.priceUsd.toFixed(2)}/month (US list)`,
        `${p.letters} cover letters + ${p.resumes} resume generations every month.\n\n` +
        (storeUsable
          // ⚠️ No "and any credits keep working": credits stopped paying for generation on
          // 2026-09-13, so that sentence would promise a fallback that no longer exists.
          ? `${storeName} is not offering this plan yet, so it cannot be bought. Whatever is left of your Free plan is unaffected.`
          : 'Purchasing opens in the next update. Whatever is left of your Free plan is unaffected until then.'),
        [{ text: 'OK' }]
      );
      return;
    }

    setBusyKey(p.key);
    try {
      // Same token on both stores: it is what lets a later renewal/refund webhook be attributed to
      // this user instead of landing with a NULL user_id like every store_notifications row today.
      const account = await storeAccountToken();

      // Android only: switching plans must REPLACE the old subscription, not stack a second one —
      // and the settlement terms are a money decision, so they are computed, never defaulted.
      // Apple handles all of this itself through the subscription group (upgrade takes effect now,
      // downgrade at the next renewal), which is why there is nothing to pass on iOS.
      const rep = await replacementFor(p, prod.sku);
      if (!rep.ok) {
        Alert.alert(
          'Change this in Google Play',
          'We could not tell how your current subscription relates to this one, and we will not guess '
          + 'when a charge depends on it. Use Manage subscription to change plans, or contact support '
          + '— you have not been charged.'
        );
        return;
      }
      const swap = rep.replacement;

      const outcome = await purchaseSubscription({
        sku: prod.sku,
        offerToken: prod.offerToken,
        appAccountToken: account,
        obfuscatedAccountId: account,
        replacePurchaseToken: swap?.token ?? null,
        replacementMode: swap?.mode ?? null,
        replacedSku: swap?.sku ?? null,
        // ⚠️ What un-sticks an iOS plan change. Apple settles a move inside the subscription group
        // itself and reports back the product that is STILL LIVE — on a downgrade that is the old
        // one, because the change is deferred to the next renewal. `swap` is Android-only, so
        // without the group list that answer is discarded as "not ours" and the row spins for the
        // full store timeout even though the change went through.
        groupSkus: (status?.plans || []).map(skuFor).filter((x): x is string => !!x),
      });

      if (outcome.status === 'cancelled') return;             // the user said no. Say nothing.

      if (outcome.status === 'unavailable') {
        Alert.alert('Not available', 'In-app purchases are not available on this device.');
        return;
      }

      if (outcome.status === 'pending') {
        // Android deferred payment. Nothing has been charged and nothing is owed yet.
        await loadStatus();
        Alert.alert(
          'Waiting on your payment',
          'Google is still processing this payment. Nothing has been charged yet — your plan starts automatically as soon as it clears.'
        );
        return;
      }

      if (outcome.status === 'failed') {
        Alert.alert('Purchase not completed', outcome.message);
        return;
      }

      const { result, reason } = await settleOne(outcome.purchase);
      const fresh = await loadStatus();

      if (result === 'confirmed') {
        // What the user is on is the SERVER's answer, not the plan they tapped. A downgrade is
        // deferred by both stores — the tier they paid for runs to the end of its period and the
        // cheaper one starts after — so "You're on Starter" would be a lie they could check, and it
        // would promise a monthly allowance that has not started yet.
        const activeKey = fresh?.subscription?.planKey ?? null;
        if (activeKey === p.key) {
          const label = fresh?.subscription?.label || p.label;
          Alert.alert('You’re on ' + label, `${p.letters} cover letters and ${p.resumes} resume generations are available every month.`);
        } else if (fresh?.subscription) {
          Alert.alert(
            'Plan change scheduled',
            `You keep ${fresh.subscription.label} and its full monthly allowance until `
            + `${whenText(fresh.subscription.periodEnd)}. ${p.label} starts then — nothing has been charged today.`
          );
        } else {
          Alert.alert(
            'Purchase complete',
            'Your purchase went through. Your plan will appear here in a moment — reopen this screen if it does not.'
          );
        }
      } else if (result === 'retry') {
        // Paid, not yet activated. Do not claim a subscription that the server has not written.
        Alert.alert(
          'Payment received — activating',
          'Your payment went through but we could not reach our server to switch the plan on. Nothing is lost: reopen this screen or tap Restore Purchases and it will finish.'
        );
      } else {
        Alert.alert('We could not activate this', rejectionText(reason));
      }
    } finally {
      if (alive.current) setBusyKey(null);
    }
  }, [busyKey, restoring, store, storeUsable, storeName, status, settleOne, loadStatus, replacementFor]);

  const restore = useCallback(async () => {
    if (busyKey || restoring) return;
    setRestoring(true);
    try {
      const skus = (status?.plans || []).map(skuFor).filter((x): x is string => !!x);
      const owned = await getOwnedSubscriptions(skus);
      const tally = owned.length
        ? await settleAll(owned)
        : { confirmed: 0, retry: 0, rejected: 0, reason: null as string | null };
      const fresh = await loadStatus();

      if (tally.confirmed > 0 || fresh?.subscription) {
        Alert.alert('Restored', fresh?.subscription
          ? `Your ${fresh.subscription.label} plan is active.`
          : 'Your subscription is active again.');
      } else if (tally.retry > 0) {
        // We never got an answer. The purchases are still unfinished with the store, so this is
        // genuinely worth retrying — unlike the rejected case below.
        Alert.alert(
          'Almost there',
          'We found your purchase but could not reach our server to activate it. Please check your connection and try again — nothing is lost.'
        );
      } else if (tally.rejected > 0) {
        Alert.alert('We could not activate this', rejectionText(tally.reason));
      } else {
        Alert.alert('Nothing to restore', 'No previous subscription was found for this store account.');
      }
    } finally {
      if (alive.current) setRestoring(false);
    }
  }, [busyKey, restoring, status, settleAll, loadStatus]);

  /**
   * Buy the one-time pass WITHOUT an employer. downloadPassService supports it (the server holds it
   * unbound, and the first generation or download binds it — downloads.passCoversGeneration), so
   * the pass lands on whichever employer the user tailors for next. The store's own sheet is the
   * confirmation; nothing is granted here — buyDownloadPass waits for the SERVER to show the pass.
   */
  const buyPass = useCallback(async () => {
    // A paid or pending purchase is still settling: never open the store sheet again (see PassSettling).
    if (passBusy || busyKey || restoring || passSettlingMemo) return;
    setPassBusy(true); setPassNote(null);
    // The count BEFORE this purchase — the settling card only clears once it goes above this.
    const baseline = dl?.passes || 0;
    try {
      const r = await buyDownloadPass(null);
      if (r.ok) {
        setPassSettling(null);
        const fresh = await fetchDownloadState().catch(() => null);
        if (alive.current && fresh) setDl(fresh);
        Alert.alert(
          'Your one-time pass is ready',
          'It attaches to the first employer you use it on: one tailored resume and one cover letter '
          + 'for that employer, plus their downloads. Add the employer on Home and tap Tailor.'
        );
        return;
      }
      if (r.cancelled) return;                      // they changed their mind; say nothing
      // Charged (or awaiting approval) but not yet visible on the server: lock the Buy button and
      // hand them a refresh instead. Our own copy, not r.message — the service's wording is written
      // for the resume screen ("try the download again"), and there is no download on this screen.
      const paid = passResultPaid(r as typeof r & { paid?: boolean });
      if (paid || r.pending) {
        setPassSettling({ kind: paid ? 'paid' : 'pending', baseline });
        return;
      }
      if (alive.current) setPassNote(r.message || 'That did not go through. You have not been charged.');
    } finally {
      if (alive.current) setPassBusy(false);
    }
  }, [passBusy, busyKey, restoring, dl, setPassSettling]);

  /**
   * "Refresh" on the settling card. It only RE-READS the server — it never buys, never opens the
   * store sheet. The card clears once the unused-pass count rises above the pre-purchase baseline.
   */
  const recheckPass = useCallback(async () => {
    if (passChecking) return;
    setPassChecking(true);
    try {
      const fresh = await fetchDownloadState().catch(() => null);
      if (!alive.current || !fresh) return;
      setDl(fresh);
      const memo = passSettlingMemo;
      if (memo && fresh.passes > memo.baseline) setPassSettling(null);
    } finally {
      if (alive.current) setPassChecking(false);
    }
  }, [passChecking, setPassSettling]);

  if (loading) return <View style={s.center}><ActivityIndicator size="large" color={T.blue} /></View>;

  const current = status?.subscription?.planKey || null;
  // A change the user has ALREADY made that has not started yet — a downgrade is deferred by both
  // stores to the renewal date. It is neither the current plan nor something to sell again, and
  // saying nothing about it is what makes a completed change look like it silently failed.
  const pendingKey = status?.subscription?.pendingPlanKey || null;
  const source = status?.subscription?.source || null;
  const trial = status?.trialState;
  // ⚠️ THE FREE PLAN IS ONE-TIME (2026-09-13). There is no refill date and no expiry — the server
  // sends renewsAt/endsAt as null — so this card renders NO date at all. It used to say "refilling
  // on <date>", and any fallback to endsAt would resurrect exactly that promise.
  const freeOffer = status?.trial || null;
  const oneTime = !!(freeOffer?.oneTime || trial?.oneTime);
  // `current` is a plan KEY, not the plan object — resolve it for display.
  const currentLabel = (status?.plans || []).find((p: any) => p.key === current)?.label || current || 'a paid plan';
  const trialActive = !current && trial?.active;
  // What is LEFT: the server's `remaining` when it is answering for the Free plan (it includes any
  // quota_grants bonus); otherwise the offer minus what trialState says was used.
  const freeLeft = (() => {
    if (!freeOffer || !trialActive) return null;
    if (status?.via === 'free' || status?.via === 'trial') return status.remaining;
    return {
      letters: Math.max(0, freeOffer.letters - (trial?.used?.letters || 0)),
      resumes: Math.max(0, freeOffer.resumes - (trial?.used?.resumes || 0)),
    };
  })();
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  // "Tailored resume", not "resume generation": since 2026-09-14 every generation is built for ONE
  // employer (research → ranked designs → their conventions), and that is what the allowance buys.
  const offerText = freeOffer
    ? `${plural(freeOffer.resumes, 'tailored resume', 'tailored resumes')} + ${plural(freeOffer.letters, 'cover letter', 'cover letters')}`
    : '';
  const busy = !!busyKey || restoring || passBusy;

  // A subscription bought on the other store cannot be changed from here — Apple and Google each
  // only manage their own. Showing buy buttons anyway is how someone ends up paying twice.
  const otherStore = foreignStoreFor(source);

  // The store answered and offered NOTHING. That is the app's state until the products pass review
  // (Play has none created at all yet), and it has to be said in one sentence at the top rather than
  // left to be inferred from five greyed-out rows.
  const nothingOnSale = storeChecked && Object.keys(store).length === 0;

  // The hero's one-line answer to "where am I?". Read from the same server fields as the cards below,
  // so the two can never disagree.
  const heroStatus = current
    ? `You're on ${currentLabel}`
    : trialActive && freeLeft
      ? (freeLeft.resumes + freeLeft.letters === 0
        ? 'Your free allowance is used up'
        : `Free plan · ${plural(freeLeft.resumes, 'resume', 'resumes')} + ${plural(freeLeft.letters, 'letter', 'letters')} left`)
      : 'Pick a plan to keep generating';

  const unusedPasses = dl?.passes || 0;
  // The pass Buy button follows the plans' rule: a real store price or no button at all.
  const passBuyable = storeUsable && !!passPrice;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: T.bg }} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
      {/* ── Hero ── what every plan (and the Free plan, and the pass) actually buys. No numbers in
          here: they live on the cards, read from the server. */}
      <View style={s.hero}>
        <LinearGradient colors={['#0B0F22', '#13205A', '#0B0F22']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFillObject} />
        <Text style={s.heroEyebrow}>PLANS</Text>
        <Text style={s.heroTitle}>Every application, tailored to the employer</Text>
        <Text style={s.heroBody}>
          We research each employer — its country, sector and hiring system — rank resume designs by fit,
          and shape your resume and cover letter to what they expect.
        </Text>
        <View style={s.heroChip}>
          <Ionicons name={current ? 'diamond-outline' : trialActive ? 'gift-outline' : 'lock-closed-outline'} size={13} color="#22D3EE" />
          <Text style={s.heroChipText} numberOfLines={1}>{heroStatus}</Text>
        </View>
      </View>

      {/* ── Free plan card ──
          ⚠️ EVERY NUMBER AND THE NAME COME FROM THE SERVER (`status.trial`, which now carries the
          Free plan). This card used to hard-code "7-day free trial / 5 + 2", so when the server
          moved to the Free plan the app kept advertising a trial that no longer existed. Nothing
          about the offer may be written in here again (the numbers are read, never defaulted). */}
      <View style={[s.trialCard, trialActive ? s.trialOn : null]}>
        <View style={s.trialHead}>
          {/* ⚠️ PLAN FIRST, like heroStatus and trialActive right above (2026-09-20). `blocked` is a fact about the
              FREE allowance ("this phone's went to another account"), never about whether this user may generate —
              a plan beats a claimed device everywhere (server/services/entitlements.js canConsumeMany reads the
              subscription first). A known plan short-circuits getStatus before the free lane is read, so on the
              common path trialState is absent; one whose plan_key this build does not know falls past that return
              and reports both, and then this card would show a paying subscriber a red cross and "Free allowance
              already used on this device" — on the very screen they had just bought from. usage.tsx (`sub ?
              sub.label : …`) is the precedent. */}
          <Ionicons name={trialActive ? 'checkmark-circle' : !current && trial?.blocked ? 'close-circle-outline' : 'gift-outline'} size={20} color={trialActive ? T.emerald : T.faint} />
          <Text style={s.trialTitle}>{status?.trial?.label || 'Free plan'}</Text>
          <View style={{ flex: 1 }} />
          {freeOffer && oneTime ? <View style={s.pillMuted}><Text style={s.pillMutedText}>ONE TIME</Text></View> : null}
          {trialActive ? <View style={s.pillOn}><Text style={s.pillOnText}>ACTIVE</Text></View> : null}
        </View>
        {freeOffer ? (
          <Text style={s.freeOffer}>
            {offerText}{oneTime ? ', one time' : ` every ${freeOffer.days ?? 30} days`}
          </Text>
        ) : null}
        {trialActive && freeLeft ? (
          <View style={s.leftRow}>
            <View style={s.leftChip}>
              <Ionicons name="document-text-outline" size={13} color="#7C6BFF" />
              <Text style={s.leftText}>{plural(freeLeft.resumes, 'resume', 'resumes')} left</Text>
            </View>
            <View style={s.leftChip}>
              <Ionicons name="mail-outline" size={13} color={T.cyan} />
              <Text style={s.leftText}>{plural(freeLeft.letters, 'cover letter', 'cover letters')} left</Text>
            </View>
          </View>
        ) : null}
        <Text style={s.trialBody}>
          {/* ⚠️ …AND THE SAME HERE: "Start a plan below to keep generating" would tell a paying subscriber to buy
              the thing they had just bought. With a plan this falls through to the sentences below, which say what
              the Free plan means for someone who is on a paid one. */}
          {!current && trial?.blocked === 'device_trial_used'
            ? 'Free allowance already used on this device. Start a plan below to keep generating.'
            : !freeOffer
              ? 'Searching, Auto Fill, translating and applying are always unlimited.'
              : trialActive && freeLeft
                ? (freeLeft.resumes + freeLeft.letters === 0
                  ? `You have used your ${offerText}${oneTime ? ' — a one-time allowance, it does not refill' : ''}. Start a plan below, or use the one-time option, to keep generating.`
                  : `${oneTime ? 'A one-time allowance — it does not refill. ' : ''}Searching, Auto Fill, translating and applying are always unlimited.`)
                : oneTime
                  ? 'Free — one time per device, it does not refill. Searching, Auto Fill, translating and applying are always unlimited.'
                  : 'Searching, Auto Fill, translating and applying are always unlimited.'}
        </Text>
        {freeOffer ? (
          <View style={s.features}>
            <Feature icon="sparkles-outline" text={RESEARCH_LINE} />
            {/* FREE.downloads is 0 on the server — see the note under this card. */}
            <Feature icon="download-outline" text="Downloads not included — a plan or the one-time option adds them" muted />
          </View>
        ) : null}
        {/* ⚠️ A PAID PLAN HIDES NOTHING. The Free plan stays on this screen whatever you are on,
            because a subscriber has to be able to SEE the thing they can fall back to. What a paid
            plan changes is only which allowance is in EFFECT — so when one is active this says how
            to get back rather than pretending the free tier stopped existing. You cannot "buy"
            free: the store owns the subscription, so the honest instruction is to cancel there. */}
        {current && !trialActive ? (
          <Text style={s.trialFallback}>
            You are on {currentLabel}. Cancel in your {storeName} account settings and you return to
            the Free plan (whatever is left of its {oneTime ? 'one-time ' : ''}allowance) when the period you
            have paid for ends — nothing is lost in between.
          </Text>
        ) : null}
      </View>

      {/* ⚠️ DOWNLOADS ARE NOT FREE, and never were: each plan includes a number of them, and without one
          a file comes with the one-time pass (server/services/entitlements.js — FREE.downloads is 0).
          This note used to list downloads among the free things, promising a file the paywall then asked
          money for. The Free plan is also one time PER DEVICE: a second account on the same phone gets
          no new Free plan. */}
      <Text style={s.freeNote}>
        <Ionicons name="gift-outline" size={13} color={T.emerald} />  Searching, fetching jobs, Auto Fill, translate and applying stay free on every plan. Downloads come with a paid plan, or with the one-time option below.
      </Text>

      {otherStore ? (
        <View style={s.noticeCard}>
          <Ionicons name="information-circle-outline" size={16} color={T.blue} />
          <Text style={s.noticeText}>Your plan was bought through {otherStore}. Manage or change it there — buying again here would charge you twice.</Text>
        </View>
      ) : null}

      {nothingOnSale && !otherStore ? (
        <View style={s.noticeCard}>
          <Ionicons name="information-circle-outline" size={16} color={T.faint} />
          <Text style={s.noticeText}>
            {storeUsable
              ? `Monthly plans are not on sale on ${storeName} yet, so nothing below can be purchased. `
              : 'Purchasing is not available in this build, so nothing below can be purchased. '}
            The amounts shown are the US list prices for reference only — you would be charged your
            own store’s local price. Whatever is left of your Free plan is unaffected.
          </Text>
        </View>
      ) : null}

      <Text style={s.sectionTitle}>Monthly plans</Text>

      {/* ── Plans ── */}
      {(status?.plans || []).map((p) => {
        const isCurrent = current === p.key;
        const isPending = !isCurrent && pendingKey === p.key;
        const popular = p.key === POPULAR_KEY;
        const prod = store[p.key];
        // Not buyable while it is already scheduled: the store would just re-accept the same change,
        // and offering a Buy button for a plan the user has bought reads as though the first tap
        // did nothing.
        const buyable = !!prod && !otherStore && !isCurrent && !isPending;
        const thisBusy = busyKey === p.key;
        const downloads = downloadsOf(p);
        return (
          <TouchableOpacity
            key={p.key}
            activeOpacity={0.9}
            disabled={busy}
            onPress={() => choose(p)}
            style={[s.plan, popular && s.planPopular, isCurrent && s.planCurrent, busy && !thisBusy && s.planDim]}
          >
            {popular && (
              <LinearGradient colors={['#06B6D4', '#3B82F6']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={s.popularTag}>
                <Text style={s.popularText}>MOST POPULAR</Text>
              </LinearGradient>
            )}
            <View style={s.planRow}>
              <View style={{ flex: 1 }}>
                <Text style={s.planName}>{p.label}</Text>
                {isCurrent || isPending ? (
                  <View style={s.tagRow}>
                    {isCurrent ? <View style={s.pillOn}><Text style={s.pillOnText}>CURRENT PLAN</Text></View> : null}
                    {isPending ? (
                      <View style={s.pillMuted}><Text style={s.pillMutedText}>STARTS {whenText(status?.subscription?.periodEnd).toUpperCase()}</Text></View>
                    ) : null}
                  </View>
                ) : null}
              </View>
              <View style={s.priceBox}>
                {thisBusy ? (
                  <ActivityIndicator size="small" color={T.blue} />
                ) : (
                  <>
                    {/* Store price when the store gave us one; the USD list price is a greyed-out
                        placeholder for the not-yet-purchasable state only, and is labelled as such
                        so it can never be read as the amount this user would be charged. */}
                    <Text style={[s.price, !prod && s.priceStub]}>{prod ? prod.displayPrice : `$${p.priceUsd.toFixed(2)}`}</Text>
                    <Text style={s.per}>{prod ? '/month' : '/month · US list'}</Text>
                  </>
                )}
              </View>
            </View>
            <View style={s.features}>
              <Feature icon="document-text-outline" text={`${plural(p.resumes, 'tailored resume', 'tailored resumes')} / month`} strong />
              <Feature icon="mail-outline" text={`${plural(p.letters, 'cover letter', 'cover letters')} / month`} strong />
              {/* A count only once downloads are METERED (downloads.js DOWNLOADS_METERED). Until then a
                  subscriber's downloads are not counted, and "/ month" would advertise a cap that the
                  server does not enforce — or, worse, one it later starts enforcing differently. */}
              <Feature
                icon="download-outline"
                text={dl?.metered && downloads !== null
                  ? `${plural(downloads, 'PDF & Word download', 'PDF & Word downloads')} / month`
                  : 'PDF & Word downloads'}
              />
              <Feature icon="sparkles-outline" text={RESEARCH_LINE} />
            </View>
            {buyable ? (
              <View style={[s.buyBtn, popular && s.buyBtnPopular]}>
                <Text style={[s.buyText, popular && s.buyTextPopular]}>Subscribe</Text>
                <Ionicons name="arrow-forward" size={14} color={popular ? '#FFFFFF' : T.blue} />
              </View>
            ) : !prod ? (
              <Text style={s.unavailable}>{storeChecked ? 'Not on sale yet' : 'Checking the store…'}</Text>
            ) : null}
          </TouchableOpacity>
        );
      })}

      {/* ── Just need one? ── the one-time pass (com.cvapplyr.mobile.download.single). It covers ONE
          employer: one tailored resume + one cover letter + that employer's downloads
          (downloads.passCoversGeneration / claimGeneration). The price is the store's own string
          or nothing — the same rule as the plans above. Without a store price the card still
          explains the option, because the confirm sheet offers it right on the resume. */}
      <View style={s.passCard}>
        <View style={s.trialHead}>
          <Ionicons name="flash-outline" size={20} color={T.amber} />
          <Text style={s.trialTitle}>Just need one?</Text>
          <View style={{ flex: 1 }} />
          <View style={s.pillAmber}><Text style={s.pillAmberText}>ONE TIME</Text></View>
        </View>
        <Text style={s.trialBody}>
          Applying to a single employer? Pay once, no subscription. It covers one employer, fully:
        </Text>
        <View style={s.features}>
          <Feature icon="document-text-outline" text="One tailored resume" strong />
          <Feature icon="mail-outline" text="One cover letter" strong />
          <Feature icon="download-outline" text="Their PDF & Word downloads" />
          <Feature icon="sparkles-outline" text={RESEARCH_LINE} />
        </View>
        {unusedPasses > 0 ? (
          <View style={s.passOwned}>
            <Ionicons name="checkmark-circle" size={15} color={T.emerald} />
            <Text style={s.passOwnedText}>
              You have {unusedPasses === 1 ? 'an unused pass' : `${unusedPasses} unused passes`} — it attaches to the next employer you tailor for.
            </Text>
          </View>
        ) : null}
        {passSettling ? (
          // Replaces the Buy button while a paid/pending purchase settles — there is deliberately no
          // way to start a second purchase from here. Refresh only re-reads fetchDownloadState.
          <View style={s.passSettling}>
            <View style={s.passSettlingHead}>
              <Ionicons name={passSettling.kind === 'paid' ? 'time-outline' : 'hourglass-outline'} size={15} color={T.amber} />
              <Text style={s.passSettlingTitle}>
                {passSettling.kind === 'paid' ? 'Your payment is being applied' : 'Checking your payment…'}
              </Text>
            </View>
            <Text style={s.passSettlingBody}>
              {passSettling.kind === 'paid'
                ? `Your payment went through. Your pass will appear here in a moment — you will not be charged again. Unused passes right now: ${unusedPasses}.`
                : `${storeName} is still confirming this payment (it may be waiting for approval). Nothing more to do — your pass appears here once it clears. Unused passes right now: ${unusedPasses}.`}
            </Text>
            <TouchableOpacity style={[s.actionBtn, s.passSettlingBtn]} disabled={passChecking} onPress={recheckPass} activeOpacity={0.8}>
              {passChecking ? <ActivityIndicator size="small" color={T.blue} /> : <Ionicons name="refresh-outline" size={16} color={T.blue} />}
              <Text style={s.actionText}>Refresh</Text>
            </TouchableOpacity>
          </View>
        ) : passBuyable ? (
          <>
            <TouchableOpacity style={[s.passBtn, busy && !passBusy && s.planDim]} activeOpacity={0.9} disabled={busy} onPress={buyPass}>
              {passBusy
                ? <ActivityIndicator size="small" color="#FFFFFF" />
                : <Text style={s.passBtnText}>Generate once — {passPrice}</Text>}
            </TouchableOpacity>
            <Text style={s.passHint}>
              A one-time purchase. It attaches to the first employer you use it on — or buy it right on the resume when you tailor it, and it covers exactly that employer.
            </Text>
          </>
        ) : (
          <Text style={s.passHint}>
            It is offered right on the resume when you tailor it for an employer — pick the employer on Home, tap Tailor, and choose Generate once.
          </Text>
        )}
        {passNote ? <Text style={s.passErr}>{passNote}</Text> : null}
      </View>

      {/* ── Store actions ── */}
      {storeUsable ? (
        <View style={s.actions}>
          <TouchableOpacity style={s.actionBtn} disabled={busy} onPress={restore} activeOpacity={0.8}>
            {restoring ? <ActivityIndicator size="small" color={T.blue} /> : <Ionicons name="refresh-outline" size={16} color={T.blue} />}
            <Text style={s.actionText}>Restore Purchases</Text>
          </TouchableOpacity>
          {source === 'apple' || source === 'google' ? (
            <TouchableOpacity style={s.actionBtn} disabled={busy} onPress={() => { openManageSubscriptions(); }} activeOpacity={0.8}>
              <Ionicons name="settings-outline" size={16} color={T.blue} />
              <Text style={s.actionText}>Manage subscription</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}

      <Text style={s.fine}>
        Deductions happen only after a generation succeeds — a failed attempt never counts, and re-opening a document you already have is free. Full history in Plans & Usage.
      </Text>

      {/* Required disclosure — Apple and Google both reject a paywall without it. */}
      <Text style={s.fine}>
        Plans renew automatically every month and are charged to your {Platform.OS === 'ios' ? 'Apple' : 'Google Play'} account.
        Cancel any time from your store account settings; cancelling stops the next renewal and keeps the current month.
      </Text>
      <View style={s.links}>
        <Text style={s.link} onPress={() => Linking.openURL(TERMS_URL)}>Terms of Service</Text>
        <Text style={s.linkDot}>·</Text>
        <Text style={s.link} onPress={() => Linking.openURL(PRIVACY_URL)}>Privacy Policy</Text>
      </View>
    </ScrollView>
  );
}

/** One benefit line on a card. Static — no animation, so nothing here competes for a driver. */
function Feature({ icon, text, strong, muted }: {
  icon: React.ComponentProps<typeof Ionicons>['name']; text: string; strong?: boolean; muted?: boolean;
}) {
  return (
    <View style={s.feature}>
      <View style={[s.featureIcon, muted && s.featureIconMuted]}>
        <Ionicons name={icon} size={12} color={muted ? T.faint : T.blue} />
      </View>
      <Text style={[s.featureText, strong && s.featureStrong, muted && s.featureMuted]}>{text}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: T.bg },

  hero: { borderRadius: 24, overflow: 'hidden', padding: 18, marginBottom: 14 },
  heroEyebrow: { color: '#22D3EE', fontSize: 10, fontWeight: '800', letterSpacing: 1.4 },
  heroTitle: { color: '#FFFFFF', fontSize: 21, fontWeight: '800', marginTop: 5, letterSpacing: -0.4, lineHeight: 26 },
  heroBody: { color: 'rgba(255,255,255,0.72)', fontSize: 12.5, lineHeight: 18, marginTop: 7, fontWeight: '500' },
  heroChip: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 6, marginTop: 13, backgroundColor: 'rgba(34,211,238,0.12)', borderWidth: 1, borderColor: 'rgba(34,211,238,0.35)', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 5, maxWidth: '100%' },
  heroChipText: { color: '#E0FBFF', fontSize: 12, fontWeight: '700', flexShrink: 1 },

  trialCard: { backgroundColor: T.card, borderRadius: 18, borderWidth: 1, borderColor: T.line, padding: 15, marginBottom: 12 },
  trialOn: { borderColor: 'rgba(16,185,129,0.4)', backgroundColor: '#F2FDF8' },
  trialHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  trialTitle: { fontSize: 15, fontWeight: '800', color: T.ink },
  trialBody: { fontSize: 12.5, color: T.muted, lineHeight: 18 },
  trialFallback: { color: '#94A3B8', fontSize: 12.5, lineHeight: 18, marginTop: 8, fontStyle: 'italic' },
  freeOffer: { fontSize: 14.5, fontWeight: '800', color: T.ink, marginBottom: 6, letterSpacing: -0.2 },
  leftRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginBottom: 8 },
  leftChip: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: T.card, borderWidth: 1, borderColor: T.line, borderRadius: 10, paddingHorizontal: 9, paddingVertical: 4 },
  leftText: { fontSize: 12, fontWeight: '700', color: T.ink },
  freeNote: { fontSize: 12, color: '#047857', fontWeight: '600', lineHeight: 18, marginBottom: 14, marginLeft: 2 },

  pillOn: { backgroundColor: 'rgba(16,185,129,0.14)', borderRadius: 8, paddingHorizontal: 7, paddingVertical: 3 },
  pillOnText: { color: '#047857', fontSize: 9.5, fontWeight: '800', letterSpacing: 0.8 },
  pillMuted: { backgroundColor: 'rgba(91,107,138,0.12)', borderRadius: 8, paddingHorizontal: 7, paddingVertical: 3 },
  pillMutedText: { color: T.muted, fontSize: 9.5, fontWeight: '800', letterSpacing: 0.8 },
  pillAmber: { backgroundColor: 'rgba(217,119,6,0.12)', borderRadius: 8, paddingHorizontal: 7, paddingVertical: 3 },
  pillAmberText: { color: T.amber, fontSize: 9.5, fontWeight: '800', letterSpacing: 0.8 },

  noticeCard: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', backgroundColor: 'rgba(37,99,235,0.07)', borderRadius: 14, padding: 12, marginBottom: 12 },
  noticeText: { flex: 1, fontSize: 12, color: T.muted, lineHeight: 17, fontWeight: '600' },

  sectionTitle: { fontSize: 15, fontWeight: '800', color: T.ink, marginBottom: 10, marginLeft: 2, letterSpacing: -0.2 },

  plan: { backgroundColor: T.card, borderRadius: 20, borderWidth: 1.5, borderColor: T.line, padding: 16, marginBottom: 11, overflow: 'hidden' },
  planPopular: { borderColor: T.cyan, paddingTop: 24 },
  planCurrent: { borderColor: T.emerald, backgroundColor: '#F6FEFA' },
  planDim: { opacity: 0.5 },
  popularTag: { position: 'absolute', top: 0, right: 0, borderBottomLeftRadius: 12, paddingHorizontal: 10, paddingVertical: 4 },
  popularText: { color: '#fff', fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  planRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  planName: { fontSize: 18, fontWeight: '800', color: T.ink, letterSpacing: -0.3 },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 5 },
  priceBox: { alignItems: 'flex-end', minWidth: 74 },
  price: { fontSize: 21, fontWeight: '800', color: T.ink, letterSpacing: -0.5 },
  priceStub: { color: T.faint },
  per: { fontSize: 11, color: T.faint, fontWeight: '600' },

  features: { marginTop: 10, gap: 6 },
  feature: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  featureIcon: { width: 20, height: 20, borderRadius: 7, backgroundColor: 'rgba(37,99,235,0.09)', alignItems: 'center', justifyContent: 'center' },
  featureIconMuted: { backgroundColor: 'rgba(91,107,138,0.09)' },
  featureText: { flex: 1, fontSize: 12.5, color: T.muted, fontWeight: '600', lineHeight: 18, paddingTop: 1 },
  featureStrong: { color: T.ink, fontWeight: '700' },
  featureMuted: { color: T.faint },

  buyBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 13, height: 42, borderRadius: 13, borderWidth: 1.5, borderColor: 'rgba(37,99,235,0.35)' },
  buyBtnPopular: { backgroundColor: T.blue, borderColor: T.blue },
  buyText: { fontSize: 13.5, fontWeight: '800', color: T.blue },
  buyTextPopular: { color: '#FFFFFF' },
  unavailable: { fontSize: 11.5, color: T.faint, fontWeight: '600', marginTop: 10 },

  passCard: { backgroundColor: '#FFFBF3', borderRadius: 20, borderWidth: 1.5, borderColor: 'rgba(217,119,6,0.28)', padding: 16, marginTop: 4, marginBottom: 14 },
  passOwned: { flexDirection: 'row', alignItems: 'flex-start', gap: 7, backgroundColor: '#ECFDF5', borderRadius: 12, padding: 10, marginTop: 12 },
  passOwnedText: { flex: 1, fontSize: 12, color: '#047857', fontWeight: '700', lineHeight: 17 },
  passBtn: { alignItems: 'center', justifyContent: 'center', height: 46, borderRadius: 14, backgroundColor: T.ink, marginTop: 13 },
  passBtnText: { color: '#FFFFFF', fontSize: 14.5, fontWeight: '800' },
  passHint: { fontSize: 11.5, color: T.muted, lineHeight: 17, marginTop: 9, fontWeight: '500' },
  passSettling: { backgroundColor: '#FFFBEB', borderRadius: 12, padding: 11, marginTop: 12 },
  passSettlingHead: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  passSettlingTitle: { flex: 1, fontSize: 13, fontWeight: '800', color: '#92400E' },
  passSettlingBody: { fontSize: 12, color: '#92400E', lineHeight: 17, marginTop: 5, fontWeight: '500' },
  passSettlingBtn: { alignSelf: 'flex-start', marginTop: 9 },
  passErr: { fontSize: 12, color: '#B42318', fontWeight: '700', marginTop: 8, lineHeight: 17 },

  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 9, marginTop: 4, marginBottom: 6 },
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: T.card, borderRadius: 14, borderWidth: 1, borderColor: T.line, paddingVertical: 11, paddingHorizontal: 14 },
  actionText: { fontSize: 13, fontWeight: '700', color: T.blue },

  fine: { fontSize: 11, color: T.faint, lineHeight: 16, marginTop: 8, marginLeft: 2 },
  links: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10, marginLeft: 2 },
  link: { fontSize: 11.5, color: T.blue, fontWeight: '700' },
  linkDot: { fontSize: 11.5, color: T.faint },
});
