// AI Hub — new feature. Safe to delete without affecting existing app.
//
// Client for the subscription/quota backend: plan catalog + the user's entitlement picture,
// the detailed usage ledger, and the once-per-launch device report (trial dedupe).
import axios from 'axios';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { API_BASE } from '../config';
import { deviceHeader, getDeviceId } from './deviceId';

async function session(): Promise<any | null> {
  try {
    const raw = await SecureStore.getItemAsync('userSession');
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function authHeader(): Promise<Record<string, string>> {
  const s = await session();
  if (s?.token) return { Authorization: `Bearer ${s.token}` };
  return {};
}

export type Plan = {
  key: string; label: string; priceUsd: number; letters: number; resumes: number;
  productIos?: string; productAndroid?: string;
};
export type SubscriptionStatus = {
  plans: Plan[];
  trial: { key: string; label: string; days: number; letters: number; resumes: number };
  subscription: { planKey: string; label: string; periodEnd: string; source: string } | null;
  trialState?: { active: boolean; startedAt?: string; endsAt?: string; blocked?: string; used?: { letters: number; resumes: number } };
  remaining: { letters: number; resumes: number };
  used: { letters: number; resumes: number };
  via: 'plan' | 'trial' | null;
  legacyCredits?: number;
};
/**
 * The store that manages the user's CURRENT subscription, when it is not the store this build runs
 * on. Apple and Google each manage only their own: a plan bought on one is invisible and
 * uncancellable from the other.
 */
export function foreignStoreFor(source: string | null | undefined): string | null {
  if (source === 'apple' && Platform.OS === 'android') return 'the App Store';
  if (source === 'google' && Platform.OS === 'ios') return 'Google Play';
  return null;
}

/**
 * ⚠️ THE DOUBLE-CHARGE GUARD. Returns the reason a purchase must NOT be started, or null.
 *
 * It lives here, not in the screen, because it is the rule that decides whether money moves and it
 * has to be testable without rendering. The paywall hides the buy affordance in both of these
 * cases, but the whole plan card is the touch target — a hidden button never actually prevented
 * anything, it only stopped advertising it.
 *
 *   • Foreign store: buying here opens a SECOND, independent subscription. Both stores bill,
 *     neither can cancel the other, and refunding is a manual support job on two platforms.
 *   • Same plan again: on Apple the store refuses with a confusing error; on Play it re-enters the
 *     replace flow for a plan the user already has.
 */
export function purchaseBlock(
  status: SubscriptionStatus | null,
  planKey: string,
): { title: string; body: string } | null {
  const foreign = foreignStoreFor(status?.subscription?.source);
  if (foreign) {
    return {
      title: `Managed by ${foreign}`,
      body: `Your plan was bought through ${foreign}. Change or cancel it there — buying here would `
        + 'start a second subscription and you would be charged by both stores.',
    };
  }
  if (status?.subscription && status.subscription.planKey === planKey) {
    return {
      title: `You're already on ${status.subscription.label}`,
      body: 'This is your current plan. Use Manage subscription to change or cancel it.',
    };
  }
  return null;
}

export type UsageItem = {
  id: number; kind: 'cover_letter' | 'resume'; source: 'plan' | 'trial' | 'credits';
  planKey: string | null; detail: Record<string, any>; createdAt: string;
};

export async function fetchSubscriptionStatus(): Promise<SubscriptionStatus> {
  const headers = { ...(await authHeader()), ...(await deviceHeader()) };
  const { data } = await axios.get(`${API_BASE}/subscription/status`, { headers, timeout: 20000 });
  return data as SubscriptionStatus;
}

export async function fetchUsage(limit = 100): Promise<UsageItem[]> {
  const headers = await authHeader();
  const { data } = await axios.get(`${API_BASE}/subscription/usage?limit=${limit}`, { headers, timeout: 20000 });
  return (data?.items ?? []) as UsageItem[];
}

/** Fire-and-forget device report; the server uses it to enforce one-trial-per-device. */
export async function reportDeviceOnce(): Promise<void> {
  try {
    const auth = await authHeader();
    if (!auth.Authorization) return;
    const deviceId = await getDeviceId();
    if (!deviceId) return;
    await axios.post(`${API_BASE}/subscription/device`, { deviceId }, { headers: auth, timeout: 15000 });
  } catch { /* never block launch on this */ }
}

// ── Store purchases ───────────────────────────────────────────────────────────────────────────
//
// The client's job in a store purchase is small and strictly ordered: buy → send the receipt here →
// let the SERVER decide whether an entitlement exists. Nothing below ever grants anything locally.

/**
 * A stable per-user UUID handed to the store at purchase time (Apple `appAccountToken`,
 * Play `obfuscatedExternalAccountId`). It is what lets a renewal/refund webhook be traced back to
 * an account — which is why every existing `store_notifications` row has a NULL user_id.
 *
 * ⚠️ THE SERVER ISSUES IT. This used to be derived locally as
 * `sha256("cvapplyr:store-account:" + userId)` formatted as a UUID, and that was broken twice over:
 *
 *   1. It never matched. The server mints `crypto.randomUUID()` into `user_store_tokens`
 *      (services/storeSubscriptions.js accountTokenFor) and resolves a webhook by looking the
 *      received token up in that table. A locally hashed value is not in it, so every lookup missed
 *      and the purchase came back `unattributed`.
 *   2. It was guessable. User ids are small integers and the formula was in the shipped bundle, so
 *      anyone could compute another user's token, attach it to their OWN subscription, and have the
 *      server attribute that subscription to the victim. The victim's real row is then marked
 *      'superseded' (one active entitlement per user) — and a refund on the attacker's side would
 *      leave the paying victim with no access at all.
 *
 * Cached because it never changes for a user. On failure we return null rather than a guess: a
 * purchase with no account token is still recoverable (the verify call welds it to this account),
 * a purchase with the WRONG one is not.
 */
let cachedAccountToken: { userId: any; token: string } | null = null;

export async function storeAccountToken(): Promise<string | null> {
  const s = await session();
  const id = s?.id;
  if (id === undefined || id === null || !s?.token) return null;
  if (cachedAccountToken && cachedAccountToken.userId === id) return cachedAccountToken.token;

  const key = `storeAccountToken:${id}`;
  try {
    const saved = await SecureStore.getItemAsync(key);
    if (saved) { cachedAccountToken = { userId: id, token: saved }; return saved; }
  } catch { /* fall through to the network */ }

  try {
    const { data } = await axios.get(`${API_BASE}/payment/account-token`, {
      headers: { Authorization: `Bearer ${s.token}` }, timeout: 15000,
    });
    const token = typeof data?.accountToken === 'string' ? data.accountToken : null;
    if (!token) return null;
    cachedAccountToken = { userId: id, token };
    try { await SecureStore.setItemAsync(key, token); } catch { /* cache is an optimisation */ }
    return token;
  } catch { return null; }
}

export type StoreVerifyResult = {
  /** True only when the SERVER says an entitlement row now exists. The only signal worth trusting. */
  confirmed: boolean;
  planKey: string | null;
  /** The store's own expiry. Never a locally guessed "+30 days". */
  periodEnd: string | null;
  /**
   * Whether it is worth trying again later. Network failures, 5xx, and a not-yet-deployed endpoint
   * are retryable — the transaction must stay UNFINISHED so the next launch or Restore can recover
   * it. A definitive rejection is not.
   */
  retryable: boolean;
  message: string | null;
};

/**
 * Send a store receipt to the backend and report back what the backend decided.
 *
 * ⚠️ These endpoints are the SERVER half of the subscription work and may not exist in the
 * deployed backend yet. A 404 is treated as retryable on purpose: the user has paid, so the
 * purchase is held open rather than thrown away.
 */
export async function verifyStoreSubscription(input: {
  productId: string;
  /** iOS: the StoreKit 2 JWS. Android: the Play purchaseToken. */
  purchaseToken: string | null;
  transactionId: string | null;
  accountToken: string | null;
}): Promise<StoreVerifyResult> {
  const path = Platform.OS === 'ios' ? '/payment/verify-apple-sub' : '/payment/verify-google';
  const fail = (retryable: boolean, message: string): StoreVerifyResult =>
    ({ confirmed: false, planKey: null, periodEnd: null, retryable, message });

  const headers = { ...(await authHeader()), ...(await deviceHeader()) };
  if (!headers.Authorization) return fail(true, 'Please sign in so we can attach this to your account.');

  try {
    const { data } = await axios.post(`${API_BASE}${path}`, {
      productId: input.productId,
      purchaseToken: input.purchaseToken,
      transactionId: input.transactionId,
      accountToken: input.accountToken,
      packageName: Platform.OS === 'android' ? 'com.cvapplyr.mobile' : undefined,
    }, { headers, timeout: 30000 });

    if (data?.success) {
      return {
        confirmed: true,
        planKey: data.planKey ?? null,
        periodEnd: data.periodEnd ?? null,
        retryable: false,
        message: null,
      };
    }
    return fail(false, data?.error || 'The store purchase could not be verified.');
  } catch (e: any) {
    const st = e?.response?.status;
    if (st === 404 || st === 501) return fail(true, 'not_deployed');
    if (st && st >= 400 && st < 500 && st !== 408 && st !== 429) {
      return fail(false, e?.response?.data?.error || 'The store purchase was rejected.');
    }
    return fail(true, 'Could not reach the server.');   // offline / 5xx / timeout
  }
}

/** Admin-only: assign/clear a plan for a user (testing until store products exist). */
export async function adminSetSubscription(userId: number, planKey: string | null): Promise<boolean> {
  try {
    const headers = await authHeader();
    const { data } = await axios.post(`${API_BASE}/admin/set-subscription`, { userId, planKey }, { headers, timeout: 15000 });
    return !!data?.success;
  } catch { return false; }
}
