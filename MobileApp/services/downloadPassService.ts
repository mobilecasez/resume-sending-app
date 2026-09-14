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
//
// ⚠️ BUT "NOT GRANTED YET" IS NOT "NOT PAID" (contract C1). A store transaction that COMPLETED and a
// server that has not shown the pass yet is money already taken — every failure this file returns after
// the store said yes carries `paid: true`, and a deferred/Ask-to-Buy one carries `pending: true`. A
// caller that offers a second Buy on either of those sells the same need twice.
//
// ⚠️ EVERY READ IS BOUNDED. fetchDownloadState aborts at STATE_READ_MS and waitForPass gives its whole
// poll WAIT_FOR_PASS_MS: a stalled network used to leave the screen that is waiting for a pass locked
// for minutes on fetches with no deadline of their own.
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { API_BASE } from '../config';
import {
  fetchOneTimeProducts, purchaseOneTime, finishOneTime, isStoreBillingAvailable, getOwnedSubscriptions,
} from './storeBilling';
import { rememberStoreEnv, storeEnvHeader } from './storeEnv';

export const PASS_SKU = 'com.cvapplyr.mobile.download.single';

/** How long ONE state read may take. Past it the read is aborted and fails closed, like any other failure. */
const STATE_READ_MS = 8000;
/**
 * How long the whole post-purchase poll may take. ⚠️ It bounds the WAIT, not the purchase: past it the answer
 * is "paid, not visible yet" (paid:true), which every caller already has to handle — never a second sale.
 * Comfortably longer than the poll's own sleeps, so a healthy network always finishes its reads.
 */
const WAIT_FOR_PASS_MS = 30000;

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
export async function fetchDownloadState(employer?: string | null, forceEnv?: 'Sandbox'): Promise<DownloadState> {
  const t = await token();
  if (!t) return LOCKED;
  try {
    const q = employer ? `?employer=${encodeURIComponent(employer)}` : '';
    // The environment is named on the request itself rather than left to storeEnv's fetch patch, which
    // reads a value that may still be loading (storeEnvHeader awaits it). `forceEnv` is the Sandbox probe
    // below and always wins.
    const headers: Record<string, string> = { Authorization: `Bearer ${t}`, ...(await storeEnvHeader()) };
    if (forceEnv) headers['x-store-env'] = forceEnv;
    // ⚠️ BOUNDED. Without a deadline a stalled connection holds this read for as long as the OS allows,
    // and the sheet waiting on waitForPass stays locked behind it.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), STATE_READ_MS);
    let r: Response;
    try { r = await fetch(`${API_BASE}/downloads/state${q}`, { headers, signal: ctl.signal }); }
    finally { clearTimeout(timer); }
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

/**
 * ⚠️ `ok: false` DOES NOT MEAN "NOT CHARGED" (contract C1).
 *   paid      — the store transaction COMPLETED: the user has been charged, and only the server's record of
 *               it is missing (a verification we could not finish, a pass that has not surfaced yet).
 *   pending   — deferred / Ask-to-Buy: nothing charged yet, but approving it later charges them.
 *   cancelled — they backed out of the store sheet. Never paid, never pending.
 * A caller must never offer another purchase while `paid` or `pending`: it may only re-read the state
 * (fetchDownloadState) until the pass appears.
 */
export type BuyResult =
  | { ok: true; employerUnlocked: boolean }
  | { ok: false; cancelled?: boolean; pending?: boolean; paid?: boolean; message?: string };

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

  // ⚠️ BEFORE ANYTHING ELSE, HONOUR WHAT THEY ALREADY PAID FOR. On Android an unconsumed purchase
  // makes Play answer ITEM_ALREADY_OWNED for the next Buy, so a stranded pass does not merely sit
  // there — it blocks the user from even paying again. This has to run ahead of purchaseOneTime.
  if (await recoverStrandedPasses()) {
    const s = await waitForPass(employer);
    if (s) return { ok: true, employerUnlocked: s.ownsEmployer || s.passes > 0 };
    // ⚠️ A RECOVERED PASS IS A PAID PASS. recoverStrandedPasses() returning true means the store's own
    // receipt verified and the SERVER GRANTED it — only our read of it has not come back (the poll is
    // bounded, so a stalled network lands here). Falling through to purchaseOneTime here opened the
    // store sheet for a SECOND pass. Say "paid, not visible yet" instead; the caller may only re-read.
    return { ok: false, paid: true, message: 'Your payment went through — we are still applying your one-time pass. Please try again in a moment; you won’t be charged twice.' };
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

  // ⚠️ FROM HERE THE STORE HAS CHARGED THEM. Every way out of this block says so (paid: true), including
  // one that throws: a caller told "that didn't go through" would sell the same pass again.
  try {
    // Android: we hold the receipt, so verify it and only then finish (finishing IS the Play
    // acknowledgement, and an unacknowledged purchase is auto-refunded after three days).
    if (!outcome.settledElsewhere && outcome.purchase) {
      const p: any = outcome.purchase;
      const purchaseToken = p.purchaseToken || p.purchaseTokenAndroid || p.transactionReceipt;
      const verified = await verifyGooglePass(purchaseToken);
      if (!verified.ok) {
        // ⚠️ Do NOT finish. Unfinished, the purchase is replayed on the next launch and can still be
        // honoured; finished, it is gone and the user has paid for nothing.
        return { ok: false, paid: true, message: verified.message || 'We could not confirm the purchase yet. It will be applied automatically.' };
      }
      await finishOneTime(outcome.purchase);
    }

    const state = await waitForPass(employer);
    if (!state) {
      return { ok: false, paid: true, message: 'Payment went through — we are still applying it. It will be ready in a moment.' };
    }
    return { ok: true, employerUnlocked: state.ownsEmployer || state.passes > 0 };
  } catch {
    // Whatever broke after the store said yes, the charge stands — and the sentence is about the money, not
    // about the exception (a raw "Network request failed" reads like the purchase never happened).
    return { ok: false, paid: true, message: 'Payment went through — we are still applying it. It will be ready in a moment.' };
  }
}

/**
 * Android only. Anything Play still holds unconsumed is money we took and never honoured.
 *
 * ⚠️ THERE IS NO OTHER RECOVERY PATH ON ANDROID. iOS replays unfinished transactions on every
 * launch (App.js's drainUnfinishedApplePurchases); the Android half of that effect is hard-gated to
 * iOS, and the only other purchase query filters to subscription skus, so a pass whose verification
 * 503'd — or that was interrupted by the app being killed — was stranded forever. Verify it, and
 * only then consume it. Idempotent: the server dedupes on the store transaction's unique index, so
 * re-verifying an already-granted token simply grants nothing again.
 */
export async function recoverStrandedPasses(): Promise<boolean> {
  if (Platform.OS !== 'android' || !isStoreBillingAvailable()) return false;
  let recovered = false;
  try {
    for (const p of await getOwnedSubscriptions([PASS_SKU])) {
      const tok = (p as any).purchaseToken || (p as any).purchaseTokenAndroid;
      if (!tok) continue;
      if ((await verifyGooglePass(tok)).ok) {
        await finishOneTime(p);          // the CONSUME — also Play's required acknowledgement
        recovered = true;
      }
    }
  } catch { /* recovery is best-effort; a failure here must not block a fresh purchase */ }
  return recovered;
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
    // The server reports which environment the store said this purchase was in. A TestFlight/
    // internal-test build must adopt it, or the pass it just wrote in Sandbox is invisible to every
    // later read (which defaults to Production) and the download stays locked forever.
    if (r.ok && j.success) { await rememberStoreEnv(j.environment); return { ok: true }; }
    return { ok: false, message: j.error };
  } catch (e: any) {
    return { ok: false, message: e?.message };
  }
}

/** The pass is written by the SERVER, so poll for it rather than assuming the purchase landed. */
async function waitForPass(employer?: string | null): Promise<DownloadState | null> {
  // ⚠️ Each read is bounded by fetchDownloadState AND the poll as a whole by WAIT_FOR_PASS_MS: eight reads
  // that each sat at their own deadline was over a minute of a locked screen on a stalled network.
  const until = Date.now() + WAIT_FOR_PASS_MS;
  for (let i = 0; i < 8 && Date.now() < until; i++) {
    const s = await fetchDownloadState(employer);
    if (s.passes > 0 || s.ownsEmployer) return s;
    await new Promise((r) => setTimeout(r, i < 3 ? 700 : 1500));
  }

  // ⚠️ LAST RESORT: WE MAY BE A SANDBOX BUILD THAT DOES NOT KNOW IT YET. On iOS App.js owns the
  // verify response, so this module never sees the environment the server reported — a TestFlight
  // tester's pass is written in Sandbox and every poll above, defaulting to Production, reads 0.
  // Ask once in Sandbox; adopt it ONLY if a pass demonstrably exists there. That is the same threat
  // model the header already assumes — an App Store build's StoreKit cannot mint a sandbox purchase
  // in the first place, so claiming Sandbox without one only hides your own production plan.
  try {
    const sb = await fetchDownloadState(employer, 'Sandbox');
    if (sb.passes > 0 || sb.ownsEmployer) {
      await rememberStoreEnv('Sandbox');
      return sb;
    }
  } catch { /* fall through to the honest "still applying it" message */ }
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
