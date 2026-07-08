import crypto from "node:crypto";

/*
 * Short-lived, one-time state tokens for the browser-redirect OAuth flow
 * (Gmail "Web application" sign-in). The OAuth callback is hit by the user's
 * browser without the extension's Authorization header, so we cannot trust it
 * to say who is authorizing. Instead, the authenticated /auth/url endpoint mints
 * a random `state` bound to the userId (and the exact redirect_uri used), and the
 * callback looks it up. This gives CSRF protection and keeps the long-lived
 * session token out of the URL / browser history / Google's logs.
 *
 * In-memory by design: the two requests (mint → callback) happen within one
 * short flow in the same process. A restart mid-flow just means the user retries.
 */

type StateEntry = { userId: string; redirectUri: string; expiresAt: number };

const states = new Map<string, StateEntry>();
const TTL_MS = 10 * 60 * 1000; // 10 minutes to complete the consent screen

function prune(now: number): void {
  for (const [k, v] of states) {
    if (now > v.expiresAt) states.delete(k);
  }
}

// Mint a state token bound to the user and the redirect_uri that will be used.
// Storing the redirect_uri guarantees the token exchange uses the identical
// value (OAuth requires authorize-time and exchange-time redirect_uri to match).
export function createOAuthState(userId: string, redirectUri: string): string {
  const now = Date.now();
  prune(now);
  const state = crypto.randomBytes(32).toString("base64url");
  states.set(state, { userId, redirectUri, expiresAt: now + TTL_MS });
  return state;
}

// Look up and consume (one-time) a state token. Returns null if unknown/expired.
export function consumeOAuthState(state: string): { userId: string; redirectUri: string } | null {
  const entry = states.get(state);
  if (!entry) return null;
  states.delete(state); // one-time use, even on expiry
  if (Date.now() > entry.expiresAt) return null;
  return { userId: entry.userId, redirectUri: entry.redirectUri };
}
