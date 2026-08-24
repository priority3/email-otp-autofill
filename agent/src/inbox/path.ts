/*
 * Path matcher for the inbound mail hook, shared by every middleware that has
 * to exempt it (raw body, client-header guard, session gate).
 *
 * Reason: the hook accepts its token either as a header on /v1/inbox/hook or in
 * the path as /v1/inbox/hook/<token>. The other public endpoints are matched
 * with `req.path === "..."`; copying that here would silently break the
 * path-token form, since its path is variable-length.
 */
export const INBOX_HOOK_PATH = "/v1/inbox/hook";

export function isInboxHookPath(p: string): boolean {
  // Exact, or one path segment deeper — not a prefix match, so /v1/inbox/hookfoo
  // does not slip through the exemptions.
  return p === INBOX_HOOK_PATH || p.startsWith(`${INBOX_HOOK_PATH}/`);
}
