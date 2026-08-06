// AI Hub — new feature. Safe to delete without affecting existing app.
//
// The plan catalog: the 7-day free trial and five monthly tiers, wired to real store subscriptions.
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
  foreignStoreFor, purchaseBlock,
  type SubscriptionStatus, type Plan,
} from '../../services/subscriptionService';
import {
  isStoreBillingAvailable, fetchSubscriptionProducts, purchaseSubscription, finishSubscription,
  getOwnedSubscriptions, openManageSubscriptions, PLAY_REPLACEMENT,
  type StoreSubscriptionProduct, type PlayReplacementMode,
} from '../../services/storeBilling';
import type { Purchase } from 'react-native-iap';

const T = {
  bg: '#F0F4FA', card: '#FFFFFF', ink: '#0B0F22', muted: '#5B6B8A', faint: '#8896B0',
  line: 'rgba(11,15,34,0.06)', blue: '#2563EB', cyan: '#06B6D4', emerald: '#10B981',
};
// The middle tier is what most people should pick — flag it.
const POPULAR_KEY = 'plus';

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

  const storeUsable = isStoreBillingAvailable();
  // Declared up here, not next to the JSX that also uses it: `choose` closes over it, and anything
  // declared after the `if (loading) return` is in the temporal dead zone on the loading render.
  const storeName = Platform.OS === 'ios' ? 'the App Store' : 'Google Play';

  const loadStatus = useCallback(async (): Promise<SubscriptionStatus | null> => {
    try {
      const s = await fetchSubscriptionStatus();
      if (alive.current) setStatus(s);
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
          ? `${storeName} is not offering this plan yet, so it cannot be bought. Your free trial and any credits keep working.`
          : 'Purchasing opens in the next update. Your free trial and any credits keep working until then.'),
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

  if (loading) return <View style={s.center}><ActivityIndicator size="large" color={T.blue} /></View>;

  const current = status?.subscription?.planKey || null;
  const source = status?.subscription?.source || null;
  const trial = status?.trialState;
  const trialActive = !current && trial?.active;
  const busy = !!busyKey || restoring;

  // A subscription bought on the other store cannot be changed from here — Apple and Google each
  // only manage their own. Showing buy buttons anyway is how someone ends up paying twice.
  const otherStore = foreignStoreFor(source);

  // The store answered and offered NOTHING. That is the app's state until the products pass review
  // (Play has none created at all yet), and it has to be said in one sentence at the top rather than
  // left to be inferred from five greyed-out rows.
  const nothingOnSale = storeChecked && Object.keys(store).length === 0;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: T.bg }} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
      {/* ── Trial card ── */}
      <View style={[s.trialCard, trialActive ? s.trialOn : null]}>
        <View style={s.trialHead}>
          <Ionicons name={trialActive ? 'checkmark-circle' : trial?.blocked ? 'close-circle-outline' : 'time-outline'} size={20} color={trialActive ? T.emerald : T.faint} />
          <Text style={s.trialTitle}>7-day free trial</Text>
        </View>
        <Text style={s.trialBody}>
          {trialActive
            ? `Active — ${Math.max(0, (status?.trial.letters || 5) - (trial?.used?.letters || 0))} cover letters and ${Math.max(0, (status?.trial.resumes || 2) - (trial?.used?.resumes || 0))} resume generations left.`
            : trial?.blocked === 'device_trial_used'
              ? 'This device has already used its free trial.'
              : 'Every new account starts with 5 cover letters + 2 resume generations, free for 7 days.'}
        </Text>
      </View>

      <Text style={s.freeNote}>
        <Ionicons name="gift-outline" size={13} color={T.emerald} />  Searching, fetching jobs, Auto Fill, translate, applying and downloads stay free on every plan.
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
            own store’s local price. Your free trial and any credits keep working.
          </Text>
        </View>
      ) : null}

      {/* ── Plans ── */}
      {(status?.plans || []).map((p) => {
        const isCurrent = current === p.key;
        const popular = p.key === POPULAR_KEY;
        const prod = store[p.key];
        const buyable = !!prod && !otherStore && !isCurrent;
        const thisBusy = busyKey === p.key;
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
                <Text style={s.planName}>{p.label}{isCurrent ? '  ·  current' : ''}</Text>
                <Text style={s.planQuota}>{p.letters} cover letters / month</Text>
                <Text style={s.planQuota}>{p.resumes} resume generations / month</Text>
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
            {buyable ? (
              <View style={s.buyRow}>
                <Text style={s.buyText}>Subscribe</Text>
                <Ionicons name="arrow-forward" size={14} color={T.blue} />
              </View>
            ) : !prod ? (
              <Text style={s.unavailable}>{storeChecked ? 'Not on sale yet' : 'Checking the store…'}</Text>
            ) : null}
          </TouchableOpacity>
        );
      })}

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
        Deductions happen only after a generation succeeds — a failed attempt never counts. Full history in Plans & Usage.
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

const s = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: T.bg },
  trialCard: { backgroundColor: T.card, borderRadius: 18, borderWidth: 1, borderColor: T.line, padding: 15, marginBottom: 12 },
  trialOn: { borderColor: 'rgba(16,185,129,0.4)', backgroundColor: '#F2FDF8' },
  trialHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  trialTitle: { fontSize: 15, fontWeight: '800', color: T.ink },
  trialBody: { fontSize: 12.5, color: T.muted, lineHeight: 18 },
  freeNote: { fontSize: 12, color: '#047857', fontWeight: '600', lineHeight: 18, marginBottom: 14, marginLeft: 2 },

  noticeCard: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', backgroundColor: 'rgba(37,99,235,0.07)', borderRadius: 14, padding: 12, marginBottom: 12 },
  noticeText: { flex: 1, fontSize: 12, color: T.muted, lineHeight: 17, fontWeight: '600' },

  plan: { backgroundColor: T.card, borderRadius: 20, borderWidth: 1.5, borderColor: T.line, padding: 16, marginBottom: 11, overflow: 'hidden' },
  planPopular: { borderColor: T.cyan },
  planCurrent: { borderColor: T.emerald, backgroundColor: '#F6FEFA' },
  planDim: { opacity: 0.5 },
  popularTag: { position: 'absolute', top: 0, right: 0, borderBottomLeftRadius: 12, paddingHorizontal: 10, paddingVertical: 4 },
  popularText: { color: '#fff', fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  planRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  planName: { fontSize: 16.5, fontWeight: '800', color: T.ink, marginBottom: 5, letterSpacing: -0.2 },
  planQuota: { fontSize: 12.5, color: T.muted, fontWeight: '600', marginTop: 1 },
  priceBox: { alignItems: 'flex-end', minWidth: 74 },
  price: { fontSize: 21, fontWeight: '800', color: T.ink, letterSpacing: -0.5 },
  priceStub: { color: T.faint },
  per: { fontSize: 11, color: T.faint, fontWeight: '600' },
  buyRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 11, paddingTop: 10, borderTopWidth: 1, borderTopColor: T.line },
  buyText: { fontSize: 13, fontWeight: '800', color: T.blue },
  unavailable: { fontSize: 11.5, color: T.faint, fontWeight: '600', marginTop: 10 },

  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 9, marginTop: 4, marginBottom: 6 },
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: T.card, borderRadius: 14, borderWidth: 1, borderColor: T.line, paddingVertical: 11, paddingHorizontal: 14 },
  actionText: { fontSize: 13, fontWeight: '700', color: T.blue },

  fine: { fontSize: 11, color: T.faint, lineHeight: 16, marginTop: 8, marginLeft: 2 },
  links: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10, marginLeft: 2 },
  link: { fontSize: 11.5, color: T.blue, fontWeight: '700' },
  linkDot: { fontSize: 11.5, color: T.faint },
});
