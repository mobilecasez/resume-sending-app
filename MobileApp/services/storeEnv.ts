// AI Hub — new feature. Safe to delete without affecting existing app.
//
// WHICH APP STORE ENVIRONMENT IS THIS BUILD IN? — the client half of per-environment entitlement.
// Read server/services/storeEnvironment.js first; it holds the whole model and the threat analysis.
//
// The problem in one line: TestFlight StoreKit is ALWAYS Sandbox, so a tester's $0 purchase verifies
// perfectly at Apple and, before this change, was written as a real production plan. The server now
// stamps every entitlement with the environment it was earned in and refuses to let a Sandbox one
// satisfy a Production check. For that to be usable rather than merely safe, a request has to say
// which environment it belongs to — that is the `x-store-env` header this module manages.
//
// ⚠️ THE APP NEVER GUESSES. There is no reliable, dependency-free way for a React Native build to
// know whether it was installed from TestFlight or the App Store, and a wrong guess in either
// direction is bad (a tester who cannot test, or — far worse — a build that claims Sandbox and hides
// a paying customer's plan from them). So the value is not inferred at all: it is whatever the
// SERVER reported on a verify/restore call, where it came from Apple's or Google's own answer about
// a purchase this build's StoreKit actually made. Until that happens the app is Production, which is
// the fail-closed default and what every existing 3.5 build already effectively sends (nothing).
//
// Why it is safe for the client to declare this at all: the header is a SELECTOR, not a grant.
// Claiming "Sandbox" without a sandbox purchase just hides your own production plan from you;
// claiming "Production" with only a sandbox purchase is denied. Either way you can only ever see an
// entitlement you already own IN THAT ENVIRONMENT, and a Sandbox one can only be created by a
// transaction Apple's sandbox API recognises — which an App Store build's StoreKit cannot produce.
import axios from 'axios';
import * as SecureStore from 'expo-secure-store';

export type StoreEnvironment = 'Production' | 'Sandbox';

const KEY = 'cvapplyr_store_env_v1';
const HEADER = 'x-store-env';

/** Fail-closed default. Production is what the server assumes for any request that says nothing. */
let cached: StoreEnvironment = 'Production';
let primed: Promise<StoreEnvironment> | null = null;

function normalize(v: unknown): StoreEnvironment | null {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'sandbox' || s === 'xcode' || s === 'test') return 'Sandbox';
  if (s === 'production' || s === 'prod' || s === 'live') return 'Production';
  return null;
}

/**
 * Install/remove the global axios default header.
 *
 * ⚠️ Production sets NOTHING. The whole point is that a real customer's build is byte-for-byte
 * unchanged in its request headers by this feature — the server already defaults to Production, so
 * announcing it would be noise on every request the app makes, including ones to third parties.
 * Only the rare Sandbox build ever adds a header.
 *
 * It is set as an axios DEFAULT rather than passed per call because the requests that matter most
 * are the quota-gated ones (cover-letter and resume generation), and those are issued from App.js —
 * which must not be modified. A default reaches them without touching that file. There is no
 * axios.create() anywhere in this app, so the default applies everywhere.
 */
function applyHeader(env: StoreEnvironment): void {
  const common = axios.defaults.headers.common as Record<string, unknown>;
  if (env === 'Sandbox') common[HEADER] = 'Sandbox';
  else delete common[HEADER];
}

/** Load the persisted environment and install the header. Idempotent; safe to call repeatedly. */
export function primeStoreEnv(): Promise<StoreEnvironment> {
  if (primed) return primed;
  primed = (async () => {
    try {
      const saved = normalize(await SecureStore.getItemAsync(KEY));
      if (saved) cached = saved;
    } catch { /* SecureStore unavailable → stay Production, which is the safe answer */ }
    applyHeader(cached);
    return cached;
  })();
  return primed;
}

/** What this build believes it is. Production until a store purchase proves otherwise. */
export async function getStoreEnv(): Promise<StoreEnvironment> {
  return primeStoreEnv();
}

/**
 * Adopt the environment the SERVER reported for a purchase it just verified with Apple/Google.
 *
 * This is the ONLY way the app ever becomes Sandbox. In particular it is deliberately NOT called
 * from the /subscription/status response: that endpoint echoes back the environment it was ASKED
 * in, so feeding it in here would be a loop, and the `otherEnvironmentSubscription` hint it returns
 * is diagnostic only — adopting an environment because a row exists in it would re-open the exact
 * crossover this design closes.
 *
 * Ignores anything unrecognised, so a partial or errored response can never flip a paying customer
 * out of Production.
 */
export async function rememberStoreEnv(reported: unknown): Promise<void> {
  const env = normalize(reported);
  if (!env || env === cached) return;
  cached = env;
  applyHeader(env);
  try { await SecureStore.setItemAsync(KEY, env); } catch { /* header still set for this session */ }
}

/** Header fragment for calls that build their headers explicitly (avoids racing primeStoreEnv). */
export async function storeEnvHeader(): Promise<Record<string, string>> {
  const env = await getStoreEnv();
  return env === 'Sandbox' ? { [HEADER]: 'Sandbox' } : {};
}

// Install the header as early as the module is first imported — services/subscriptionService.ts
// imports this, and app/_layout.tsx loads that at startup, so it is in place before the first
// quota-gated request. A slow SecureStore read only ever means "Production for another moment",
// which is the default the server would have used anyway.
void primeStoreEnv();
