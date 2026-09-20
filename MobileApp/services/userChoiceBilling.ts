// AI Hub — new feature. Safe to delete without affecting existing app.
//
// PAYING US DIRECTLY, ON ANDROID, IN INDIA — Google Play's "user choice billing".
//
// HOW THE FLOW ACTUALLY GOES, because it is not the usual one:
//   1. The billing connection must be opened in 'user-choice' mode (services/storeBilling.ts). That
//      is decided ONCE, when the connection opens, so this module's answer has to be known first —
//      hence the cached flag below, written on the previous run.
//   2. The user taps a plan and we call requestPurchase exactly as before. GOOGLE shows the chooser.
//   3. If they pick Google Play, nothing here happens: the normal purchase listener settles it.
//   4. If they pick us, Google fires userChoiceBillingAndroid with an externalTransactionToken.
//      That token is the permission slip — we never mint it, and without it there is no legal way
//      to take the payment.
//   5. We ask our server for a gateway order, run the gateway's checkout, and tell the server. The
//      server grants the plan and reports the payment to Google within its 24-hour window.
//
// ⚠️ iOS NEVER TOUCHES THIS. Apple's guideline 3.1.1 requires in-app purchase for digital content;
// offering our own checkout there is a removal, not a saving. Every entry point below is
// Android-gated, and the server refuses a non-Android caller as well.
//
// ⚠️ IT IS OFF UNTIL THE SERVER SAYS OTHERWISE. The server's answer depends on the Play Console
// enrolment, live gateway keys and real INR prices — none of which the app can know — so "off" is
// the default in every path here, including when the config call fails.
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { API_BASE } from '../config';

const FLAG_KEY = 'ucb_enabled_v1';      // last known answer, read before the connection opens

/** The session token, read the way every other service here reads it. */
async function authHeaders(): Promise<Record<string, string>> {
  try {
    const raw = await SecureStore.getItemAsync('userSession');
    const t = JSON.parse(raw || '{}')?.token;
    return t ? { Authorization: `Bearer ${t}` } : {};
  } catch { return {}; }
}

export type UcbConfig = {
  enabled: boolean;
  reason: string | null;
  provider: string;
  publicKey: string | null;
  currency: string;
  region: string;
  taxPercent: number;
  periodDays: number;
  prices: Record<string, number>;       // plan key → paise
};

export type UcbOrder = {
  transactionId: string;
  orderId: string;
  provider: string;
  publicKey: string | null;
  amountMinor: number;
  currency: string;
  planKey: string;
  planLabel: string;
};

const OFF: UcbConfig = {
  enabled: false, reason: 'unknown', provider: 'razorpay', publicKey: null,
  currency: 'INR', region: 'IN', taxPercent: 0, periodDays: 30, prices: {},
};

/** What the LAST run learned, available synchronously-ish before the billing connection opens.
 *  A wrong "true" costs nothing: Google simply never shows the chooser, and the normal Play flow
 *  runs. A wrong "false" costs the user nothing either — they just pay through Play. */
export async function userChoiceModeWanted(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  try { return (await AsyncStorage.getItem(FLAG_KEY)) === '1'; } catch { return false; }
}

export async function fetchUcbConfig(country?: string | null): Promise<UcbConfig> {
  if (Platform.OS !== 'android') return { ...OFF, reason: 'not_android' };
  try {
    const headers = await authHeaders();
    const q = `platform=android${country ? `&country=${encodeURIComponent(country)}` : ''}`;
    const res = await fetch(`${API_BASE}/payment/ucb/config?${q}`, { headers });
    if (!res.ok) return { ...OFF, reason: 'unreachable' };
    const d = await res.json();
    const cfg: UcbConfig = {
      enabled: !!d.enabled,
      reason: d.reason ?? null,
      provider: String(d.provider || 'razorpay'),
      publicKey: d.publicKey ?? null,
      currency: String(d.currency || 'INR'),
      region: String(d.region || 'IN'),
      taxPercent: Number(d.taxPercent) || 0,
      periodDays: Number(d.periodDays) || 30,
      prices: (d.prices && typeof d.prices === 'object') ? d.prices : {},
    };
    try { await AsyncStorage.setItem(FLAG_KEY, cfg.enabled ? '1' : '0'); } catch { /* a cache, not a source */ }
    return cfg;
  } catch {
    return { ...OFF, reason: 'unreachable' };
  }
}

/** Step 5a — trade Google's token for a gateway order. */
export async function createUcbOrder(planKey: string, externalTransactionToken: string, country?: string | null)
  : Promise<{ ok: true; order: UcbOrder } | { ok: false; reason: string }> {
  try {
    const headers = { ...(await authHeaders()), 'Content-Type': 'application/json' };
    const res = await fetch(`${API_BASE}/payment/ucb/order`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ planKey, externalTransactionToken, platform: 'android', country: country || undefined }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || !d.success) return { ok: false, reason: String(d.reason || 'order_failed') };
    return { ok: true, order: d as UcbOrder };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

/** Step 5b — the gateway says it is paid. The server verifies the signature itself; nothing the
 *  phone says is trusted, so a failure here is never "paid" until the server agrees. */
export async function verifyUcbPayment(args: { transactionId: string; paymentId: string; signature: string })
  : Promise<{ ok: true; planKey: string; periodEnd?: string; reported?: boolean } | { ok: false; reason: string; paid?: boolean }> {
  try {
    const headers = { ...(await authHeaders()), 'Content-Type': 'application/json' };
    const res = await fetch(`${API_BASE}/payment/ucb/verify`, {
      method: 'POST', headers, body: JSON.stringify(args),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || !d.success) return { ok: false, reason: String(d.reason || 'verify_failed'), paid: !!d.paid };
    return { ok: true, planKey: String(d.planKey || ''), periodEnd: d.periodEnd, reported: !!d.reported };
  } catch {
    // The money may well have moved. Say so honestly upstream rather than "failed".
    return { ok: false, reason: 'unreachable', paid: true };
  }
}

/** The gateway's own checkout sheet. Razorpay today; the module is loaded lazily so a build without
 *  it (or iOS) degrades to "unavailable" instead of failing to start. */
export async function openGatewayCheckout(order: UcbOrder, who: { email?: string | null; name?: string | null; phone?: string | null })
  : Promise<{ ok: true; paymentId: string; signature: string } | { ok: false; cancelled?: boolean; reason: string }> {
  if (Platform.OS !== 'android') return { ok: false, reason: 'not_android' };
  if (order.provider !== 'razorpay') return { ok: false, reason: 'unsupported_gateway' };
  let Checkout: any = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    Checkout = require('react-native-razorpay').default || require('react-native-razorpay');
  } catch {
    return { ok: false, reason: 'gateway_missing' };
  }
  if (!Checkout || typeof Checkout.open !== 'function') return { ok: false, reason: 'gateway_missing' };

  try {
    const data = await Checkout.open({
      key: order.publicKey,
      order_id: order.orderId,
      amount: order.amountMinor,
      currency: order.currency,
      name: 'CVApplyr',
      description: `${order.planLabel} — ${order.planKey}`,
      prefill: {
        email: who.email || undefined,
        name: who.name || undefined,
        contact: who.phone || undefined,
      },
      theme: { color: '#2563EB' },
    });
    const paymentId = data?.razorpay_payment_id;
    const signature = data?.razorpay_signature;
    if (!paymentId || !signature) return { ok: false, reason: 'gateway_incomplete' };
    return { ok: true, paymentId, signature };
  } catch (e: any) {
    // Razorpay reports a user dismissal as an error with code 0/2. That is not a failure to report.
    const code = e?.code;
    const cancelled = code === 0 || code === 2 || /cancel/i.test(String(e?.description || e?.message || ''));
    return { ok: false, cancelled, reason: cancelled ? 'cancelled' : String(e?.description || e?.message || 'gateway_failed') };
  }
}

/** The whole of step 5, in the order it has to happen, so a screen only has to hand over the token.
 *  Returns what the user should be told — never a claim that a plan started unless the SERVER said so. */
export async function payWithOurGateway(args: {
  planKey: string;
  externalTransactionToken: string;
  country?: string | null;
  who?: { email?: string | null; name?: string | null; phone?: string | null };
}): Promise<
  | { status: 'done'; planKey: string; periodEnd?: string }
  | { status: 'cancelled' }
  | { status: 'paid_unconfirmed'; reason: string }
  | { status: 'failed'; reason: string }
> {
  const made = await createUcbOrder(args.planKey, args.externalTransactionToken, args.country);
  if (!made.ok) return { status: 'failed', reason: made.reason };

  const paid = await openGatewayCheckout(made.order, args.who || {});
  if (!paid.ok) return paid.cancelled ? { status: 'cancelled' } : { status: 'failed', reason: paid.reason };

  const confirmed = await verifyUcbPayment({
    transactionId: made.order.transactionId,
    paymentId: paid.paymentId,
    signature: paid.signature,
  });
  if (confirmed.ok) return { status: 'done', planKey: confirmed.planKey, periodEnd: confirmed.periodEnd };
  // Money moved but our server has not confirmed it. Say exactly that: it is recoverable, and
  // pretending otherwise in either direction is how a paying user is told they did not pay.
  return confirmed.paid ? { status: 'paid_unconfirmed', reason: confirmed.reason } : { status: 'failed', reason: confirmed.reason };
}
