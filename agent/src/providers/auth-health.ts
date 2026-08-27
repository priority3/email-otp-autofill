/*
 * Classify OAuth failures into "the user must re-authorize" vs "try again later".
 *
 * The distinction matters because the two mistakes are not symmetric. Missing a
 * real re-auth need leaves the mailbox silently deaf — the user keeps waiting
 * for codes that will never arrive. Crying wolf sends them through an OAuth
 * dance that fixes nothing and teaches them to ignore the warning.
 *
 * So this only reports needsReauth on signals where the provider explicitly
 * told us the credential is no longer usable. Rate limits, 5xx and network
 * errors are deliberately NOT re-auth: they resolve on their own.
 */

export type ReauthCode =
  | "scope_insufficient" // consent doesn't cover the scopes we ask for
  | "token_revoked" // refresh token withdrawn or expired
  | "unauthorized"; // credential rejected outright

export type AuthHealth = {
  needsReauth: boolean;
  code: ReauthCode | null;
};

export const HEALTHY: AuthHealth = { needsReauth: false, code: null };

/*
 * Returns a ReauthCode when the response means the credential itself is bad,
 * or null when the failure is transient.
 *
 * `body` is the raw response text; both Google and Microsoft put the decisive
 * marker in the body rather than the status, and a 400 can mean either thing.
 */
export function classifyAuthFailure(status: number, body: string): ReauthCode | null {
  const text = String(body || "");

  // Explicitly transient — check first so a rate-limit body mentioning "scope"
  // can never be misread as a credential problem.
  if (status === 429) return null;
  if (status >= 500) return null;

  // Google: 403 + ACCESS_TOKEN_SCOPE_INSUFFICIENT / insufficientPermissions.
  if (status === 403 && /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions/i.test(text)) {
    return "scope_insufficient";
  }

  // Both providers use invalid_grant for a withdrawn or expired refresh token.
  if (/"?\binvalid_grant\b"?/i.test(text)) return "token_revoked";

  // Microsoft spells revocation out in the AADSTS code range.
  if (/AADSTS(?:50173|700082|50078|54005)\b/.test(text)) return "token_revoked";

  if (status === 401) return "unauthorized";

  return null;
}

export function healthFromFailure(status: number, body: string): AuthHealth {
  const code = classifyAuthFailure(status, body);
  return code ? { needsReauth: true, code } : HEALTHY;
}
