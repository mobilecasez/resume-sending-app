// AI Hub — new feature. Safe to delete without affecting existing app.
//
// Buying a single download, and knowing whether one is needed.
//
// A pass buys an EMPLOYER: once it is spent on a company, every resume design, every format and
// that company's cover letter are all unlocked. The server owns that rule — this file only starts
// the purchase and then asks the server what the truth is.
//
// ⚠️ WE NEVER GRANT ANYTHING FROM THE CLIENT. The app hands the store's receipt to the server and
// re-reads the state; it never decides for itself that a purchase succeeded. A client that could
// unlock a download is a client that can be made to unlock one for free.
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { API_BASE } from '../config';
import {
  fetchOneTimeProducts, purchaseOneTime, finishOneTime, isStoreBillingAvailable,
} from './storeBilling';

export const PASS_SKU = 'com.cvapplyr.mobile.download.single';

export type DownloadState = {
  /** True once plan downloads are metered. While false, a plan means unlimited. */
  metered: boolean;
  paid: boolean;
  unlimited: boolean;
  /** Downloads left this month on the plan; null when not metered. */
  remaining: number | null;
  /** Unspent passes, not yet attached to an employer. */
  passes: number;
  /** A pass has already been spent on THIS employer — everything for them is unlocked. */
  ownsEmployer: boolean;
  employer: string | null;
};

const LOCKED: DownloadState = {
  metered: false, paid: false, unlimited: false, remaining: 0,
  passes: 0, ownsEmployer: false, employer: null,
};

async function token(): Promise<string | undefined> {
  try {
    const raw = await SecureStore.getItemAsync('userSession');
    return JSON.parse(raw || '{}')?.token;
  } catch { return undefined; }
}

/** What a download costs this user right now. Fails CLOSED — an unreadable state is a locked one. */
export async function fetchDownloadState(employer?: string | null): Promise<DownloadState> {
  const t = await token();
  if (!t) return LOCKED;
  try {
    const q = employer ? `?employer=${encodeURIComponent(employer)}` : '';
    const r = await fetch(`${API_BASE}/downloads/state${q}`, { headers: { Authorization: `Bearer ${t}` } });
    if (!r.ok) return LOCKED;
    const j = await r.json();
    return {
      metered: !!j.metered,
      paid: !!j.paid,
      unlimited: !!j.unlimited,
      remaining: typeof j.remaining === 'number' ? j.remaining : null,
      passes: j.passes || 0,
      ownsEmployer: !!j.ownsEmployer,
      employer: j.employer ?? null,
    };
  } catch { return LOCKED; }
}

/** The store's own localised price string — ₹99 in India, $0.99 in the US. Null = not on sale. */
export async function fetchPassPrice(): Promise<string | null> {
  if (!isStoreBillingAvailable()) return null;
  const products = await fetchOneTimeProducts([PASS_SKU]);
  return products.length ? products[0].displayPrice : null;
}

export type BuyResult =
  | { ok: true; employerUnlocked: boolean }
  | { ok: false; cancelled?: boolean; pending?: boolean; message?: string };

/**
 * Buy one pass.
 *
 * iOS settles through App.js's global purchase listener (see storeBilling.purchaseOneTime for why
 * a second listener there would race it), so afterwards we poll the server until the pass shows up
 * rather than trusting the store callback we never saw.
 */
export async function buyDownloadPass(employer?: string | null): Promise<BuyResult> {
  if (!isStoreBillingAvailable()) {
    return { ok: false, message: 'In-app purchases are not available in this build.' };
  }
  const priced = await fetchOneTimeProducts([PASS_SKU]);
  if (!priced.length) {
    return { ok: false, message: 'This is not on sale yet. Please try again shortly.' };
  }

  const outcome = await purchaseOneTime(PASS_SKU);
  if (outcome.status === 'cancelled') return { ok: false, cancelled: true };
  if (outcome.status === 'pending') {
    return { ok: false, pending: true, message: 'Your payment is still being confirmed. We will unlock this as soon as it clears.' };
  }
  if (outcome.status === 'failed') return { ok: false, message: outcome.message };

  // Android: we hold the receipt, so verify it and only then finish (finishing IS the Play
  // acknowledgement, and an unacknowledged purchase is auto-refunded after three days).
  if (!outcome.settledElsewhere && outcome.purchase) {
    const p: any = outcome.purchase;
    const purchaseToken = p.purchaseToken || p.purchaseTokenAndroid || p.transactionReceipt;
    const verified = await verifyGooglePass(purchaseToken);
    if (!verified.ok) {
      // ⚠️ Do NOT finish. Unfinished, the purchase is replayed on the next launch and can still be
      // honoured; finished, it is gone and the user has paid for nothing.
      return { ok: false, message: verified.message || 'We could not confirm the purchase yet. It will be applied automatically.' };
    }
    await finishOneTime(outcome.purchase);
  }

  const state = await waitForPass(employer);
  if (!state) {
    return { ok: false, message: 'Payment went through — we are still applying it. Please try the download again in a moment.' };
  }
  return { ok: true, employerUnlocked: state.ownsEmployer || state.passes > 0 };
}

async function verifyGooglePass(purchaseToken?: string): Promise<{ ok: boolean; message?: string }> {
  if (!purchaseToken) return { ok: false, message: 'The store did not return a purchase token.' };
  const t = await token();
  if (!t) return { ok: false, message: 'Please sign in again.' };
  try {
    const r = await fetch(`${API_BASE}/payment/verify-google-product`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
      body: JSON.stringify({ productId: PASS_SKU, purchaseToken }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.success) return { ok: true };
    return { ok: false, message: j.error };
  } catch (e: any) {
    return { ok: false, message: e?.message };
  }
}

/** The pass is written by the SERVER, so poll for it rather than assuming the purchase landed. */
async function waitForPass(employer?: string | null): Promise<DownloadState | null> {
  for (let i = 0; i < 8; i++) {
    const s = await fetchDownloadState(employer);
    if (s.passes > 0 || s.ownsEmployer) return s;
    await new Promise((r) => setTimeout(r, i < 3 ? 700 : 1500));
  }
  return null;
}

/** What the download button should say. */
export function downloadButtonLabel(state: DownloadState): { label: string; locked: boolean } {
  if (state.ownsEmployer) return { label: 'Download', locked: false };
  if (state.passes > 0) return { label: 'Download', locked: false };
  if (state.unlimited) return { label: 'Download', locked: false };
  if (state.paid && state.metered) {
    const n = state.remaining ?? 0;
    return n > 0
      ? { label: `Download · ${n} left`, locked: false }
      : { label: 'Download', locked: true };
  }
  return { label: 'Download', locked: true };
}

export const isIos = Platform.OS === 'ios';
