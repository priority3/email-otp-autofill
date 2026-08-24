/*
 * Recipient allow-listing and timestamp sanity for the inbound webhook.
 *
 * Pure functions on purpose — this is the only layer that can be unit-tested in
 * this repo (no HTTP test harness), and these two rules are the ones with real
 * security consequences.
 */

// Same window the Outlook poller uses when deciding a message is stale.
export const MAX_AGE_MS = 10 * 60 * 1000;

export type Allowlist = {
  allowedDomains: string[];
  allowedPrefixes: string[];
};

function splitAddress(address: string): { local: string; domain: string } | null {
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return null;
  return {
    local: address.slice(0, at).toLowerCase(),
    domain: address.slice(at + 1).toLowerCase(),
  };
}

function normalizeList(values: string[]): string[] {
  return values.map((v) => String(v).trim().toLowerCase()).filter(Boolean);
}

/*
 * Pick the first recipient that satisfies the allow-list, or null if none does.
 *
 * Both lists empty means accept anything — that is the default, and it is why a
 * catch-all domain needs this configured: anyone can send to any address under
 * it, including forged verification codes.
 *
 * A non-empty list is a requirement, not a hint: allowedDomains non-empty means
 * the domain MUST match one of them, and likewise for prefixes on the local part.
 */
export function matchRecipient(recipients: string[], allow: Allowlist): string | null {
  const domains = normalizeList(allow.allowedDomains);
  const prefixes = normalizeList(allow.allowedPrefixes);

  for (const raw of recipients) {
    const address = String(raw).trim().toLowerCase();
    const parts = splitAddress(address);
    if (!parts) continue;
    if (domains.length && !domains.includes(parts.domain)) continue;
    if (prefixes.length && !prefixes.some((p) => parts.local.startsWith(p))) continue;
    return address;
  }
  return null;
}

/*
 * Clamp the message's self-reported timestamp to "not in the future".
 *
 * Reason: the Date header is attacker-controlled. Without this, a message dated
 * next year would produce an OTP whose validity window never expires, because
 * OtpStore compares `now - receivedAt` against the TTL.
 */
export function clampReceivedAt(headerDate: number | undefined, now: number): number {
  if (headerDate === undefined || !Number.isFinite(headerDate)) return now;
  return Math.min(headerDate, now);
}

export function isTooOld(receivedAt: number, now: number, maxAgeMs = MAX_AGE_MS): boolean {
  return now - receivedAt > maxAgeMs;
}
