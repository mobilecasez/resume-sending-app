// Auto-generated config - DO NOT EDIT MANUALLY
// This file is updated automatically by start-all.sh

const LOCAL_API_URL = 'http://192.168.1.16:3000/api';
const PRODUCTION_API_URL = 'https://cvapplyr-website-production.up.railway.app/api';

// The COMPILE-TIME default: a dev build talks to your local backend, a release build to production.
// This is what every normal user gets, always — there is no way for them to end up anywhere else.
const DEFAULT_API_BASE = __DEV__ ? LOCAL_API_URL : PRODUCTION_API_URL;

// ── Admin environment override ────────────────────────────────────────────────
// An admin can point THEIR OWN device at a different backend (see app/(admin)/environment.tsx).
// Three things make that safe for everyone else:
//   1. it is stored on that one device only — nothing about it is shared or server-side;
//   2. it is applied once at startup, before any screen renders, and never mid-session, because
//      a session token from one database is meaningless in another;
//   3. `resolveApiBase()` refuses anything that is not in the known ENVIRONMENTS list, so a corrupt
//      or tampered stored value falls back to the compile-time default rather than to an attacker's
//      host.
//
// ⚠️ `API_BASE` is exported as `let` ON PURPOSE. Callers do `${API_BASE}` at request time and ES
// module live bindings mean they see the current value. Do NOT snapshot it into another const at
// module load (`const X = API_BASE`) — that captures the pre-switch value and would send some
// requests to one database and some to another, which is far worse than not switching at all.
export const ENVIRONMENTS = [
  { key: 'production', label: 'Production', url: PRODUCTION_API_URL, danger: true },
  { key: 'local', label: 'Local (LAN)', url: LOCAL_API_URL, danger: false },
];

let API_BASE = DEFAULT_API_BASE;

/** The url for a known environment key, or null. Never returns an arbitrary caller-supplied host. */
export function urlForEnvironment(key) {
  const hit = ENVIRONMENTS.find((e) => e.key === key);
  return hit ? hit.url : null;
}

/** Which environment we are currently pointed at. */
export function currentEnvironmentKey() {
  const hit = ENVIRONMENTS.find((e) => e.url === API_BASE);
  return hit ? hit.key : 'custom';
}

/** The environment this build defaults to with no override. */
export function defaultEnvironmentKey() {
  const hit = ENVIRONMENTS.find((e) => e.url === DEFAULT_API_BASE);
  return hit ? hit.key : 'production';
}

/**
 * Apply a stored override at startup. Called ONCE from the root layout before anything renders.
 * Returns the key actually applied, so the caller can show it. An unknown key is ignored.
 */
export function applyEnvironmentOverride(key) {
  const url = urlForEnvironment(key);
  if (!url) return defaultEnvironmentKey();
  API_BASE = url;
  return key;
}

export default { get API_BASE_URL() { return API_BASE; } };
export { API_BASE, LOCAL_API_URL, PRODUCTION_API_URL, DEFAULT_API_BASE };
