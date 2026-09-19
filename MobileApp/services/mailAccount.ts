// AI Hub — new feature. Safe to delete without affecting existing app.
//
// CONNECT GMAIL / OUTLOOK FROM OUTSIDE App.js (2026-09-19) — for the letter's Send page (app/(cover-letter)/send.tsx).
//
// The account-linking flows live inside the App component in App.js (handleLinkGoogle / handleLinkMicrosoft), which
// must not be modified and cannot be imported. This hook is the SAME flow, step for step: the same OAuth clients, the
// same scopes, the same PKCE, posted to the same server endpoints (/auth/link-google, /auth/link-microsoft — they write
// the tokens and set users.oauth_provider). Nothing about how an account is linked changed; only where it can be
// started from.
//
// ⚠️ THESE IDS AND SCOPES MUST STAY IN STEP WITH App.js (GOOGLE_CLIENT_ID_IOS / _ANDROID / _WEB, MICROSOFT_CLIENT_ID,
// the Google.useAuthRequest scopes and the Microsoft scope string). A client id that differs here links an account
// whose refresh token the server's refresh path (emailController.refreshGoogleToken) was never configured for.
// ⚠️ gmail.send ONLY, like App.js: gmail.readonly stays off until the CASA assessment (see App.js).
import { useCallback } from 'react';
import { Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import * as Google from 'expo-auth-session/providers/google';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { API_BASE } from '../config';

const GOOGLE_CLIENT_ID_IOS = '151384459549-3rm4atu5eu3ekh9h4rhds6gbd9ecgeb6.apps.googleusercontent.com';
const GOOGLE_CLIENT_ID_ANDROID = '151384459549-ro8tqemri24dc3n2lh7ak5t3fjr365nl.apps.googleusercontent.com';
const GOOGLE_CLIENT_ID_WEB = '151384459549-ujnpfbck9e0q2jkmt2q4l0lv1s41lp04.apps.googleusercontent.com';
const MICROSOFT_CLIENT_ID = '9205782b-1a57-4c2f-bbfd-8136b5378e96';
const MICROSOFT_REDIRECT = 'msauth://com.cvapplyr.app/callback';
const MICROSOFT_SCOPE = 'user.read Mail.Read Mail.Send offline_access';

WebBrowser.maybeCompleteAuthSession();

export type LinkResult =
  | { ok: true; address: string | null; message: string }
  | { ok: false; cancelled?: boolean; message: string };

async function token(): Promise<string | undefined> {
  try {
    const raw = await SecureStore.getItemAsync('userSession');
    return JSON.parse(raw || '{}')?.token;
  } catch { return undefined; }
}

/** The `code` query parameter of a redirect URL (no URL polyfill needed). */
export function codeOf(url: string): string | null {
  const m = /[?&]code=([^&#]+)/.exec(String(url || ''));
  return m ? decodeURIComponent(m[1]) : null;
}

/** App.js generatePKCE, verbatim in behaviour: 32 random bytes → base64url verifier, S256 challenge. */
async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const bytes = await Crypto.getRandomBytesAsync(32);
  const verifier = btoa(String.fromCharCode(...Array.from(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, { encoding: Crypto.CryptoEncoding.BASE64 });
  return { verifier, challenge: digest.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') };
}

async function postLink(path: string, body: any): Promise<LinkResult> {
  const t = await token();
  if (!t) return { ok: false, message: 'Please sign in again.' };
  try {
    const r = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && !j.error) return { ok: true, address: typeof j.linkedEmail === 'string' ? j.linkedEmail : null, message: j.message || 'Connected.' };
    return { ok: false, message: (typeof j.error === 'string' && j.error) || 'That account could not be connected. Please try again.' };
  } catch {
    return { ok: false, message: 'We could not reach the server. Check your connection and try again.' };
  }
}

/** Link Gmail / Outlook to the signed-in user. Each returns what happened; nothing here shows an alert itself. */
export function useMailLink() {
  const iosRedirectUri = `com.googleusercontent.apps.${GOOGLE_CLIENT_ID_IOS.split('.apps.googleusercontent.com')[0]}:/oauth2redirect/google`;
  const [request] = Google.useAuthRequest({
    iosClientId: GOOGLE_CLIENT_ID_IOS,
    androidClientId: GOOGLE_CLIENT_ID_ANDROID,
    webClientId: GOOGLE_CLIENT_ID_WEB,
    redirectUri: Platform.OS === 'ios' ? iosRedirectUri : undefined,
    scopes: ['profile', 'email', 'https://www.googleapis.com/auth/gmail.send'],
    extraParams: { access_type: 'offline', prompt: 'consent' },   // a refresh token, so sending keeps working
  });

  const linkGoogle = useCallback(async (): Promise<LinkResult> => {
    if (!request) return { ok: false, message: 'Google sign-in is still starting. Try again in a moment.' };
    try {
      const authUrl = request.url || await request.makeAuthUrlAsync({ authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth' });
      const result = await WebBrowser.openAuthSessionAsync(authUrl, request.redirectUri);
      if (result.type !== 'success' || !('url' in result) || !result.url) return { ok: false, cancelled: true, message: 'Cancelled.' };
      const code = codeOf(result.url);
      if (!code) return { ok: false, message: 'Google did not return a sign-in code. Please try again.' };
      return postLink('/auth/link-google', { code, codeVerifier: request.codeVerifier, redirectUri: request.redirectUri, platform: Platform.OS });
    } catch (e: any) {
      return { ok: false, message: e?.message || 'Could not connect Google.' };
    }
  }, [request]);

  const linkMicrosoft = useCallback(async (): Promise<LinkResult> => {
    try {
      const p = await pkce();
      const authUrl = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?'
        + `client_id=${MICROSOFT_CLIENT_ID}`
        + '&response_type=code'
        + `&redirect_uri=${encodeURIComponent(MICROSOFT_REDIRECT)}`
        + `&scope=${encodeURIComponent(MICROSOFT_SCOPE)}`
        + '&response_mode=query'
        + '&prompt=select_account'
        + `&code_challenge=${p.challenge}`
        + '&code_challenge_method=S256';
      const result = await WebBrowser.openAuthSessionAsync(authUrl, MICROSOFT_REDIRECT);
      if (result.type !== 'success' || !('url' in result) || !result.url) return { ok: false, cancelled: true, message: 'Cancelled.' };
      const code = codeOf(result.url);
      if (!code) return { ok: false, message: 'Microsoft did not return a sign-in code. Please try again.' };
      return postLink('/auth/link-microsoft', { code, codeVerifier: p.verifier, redirectUri: MICROSOFT_REDIRECT });
    } catch (e: any) {
      return { ok: false, message: e?.message || 'Could not connect Outlook.' };
    }
  }, []);

  return { linkGoogle, linkMicrosoft, googleReady: !!request };
}
