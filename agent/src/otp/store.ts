import crypto from "node:crypto";

export type ProviderId = "qq" | "outlook" | "gmail";

export type OtpItem = {
  id: string;
  userId?: string; // owning user (multi-tenant); defaults to "local"
  provider: ProviderId;
  account?: string; // the mailbox that received this code (multi-account)
  code: string;
  receivedAt: number; // epoch ms
  ttlSec?: number; // validity window parsed from the email body, if stated
  from?: string;
  subject?: string;
  messageId?: string;
  consumedAt?: number;
};

export type LatestQuery = {
  userId?: string; // restrict to one user's items (multi-tenant)
  providers?: ProviderId[];
  account?: string; // optional exact-match on the receiving mailbox
  maxAgeMs: number;
  domain?: string;
};

export class OtpStore {
  private items: OtpItem[] = [];
  private seenMessageKeys = new Set<string>();

  add(input: Omit<OtpItem, "id">): OtpItem {
    // Reason: include user + account so the same message id arriving for two
    // different users/mailboxes is not collapsed into one.
    const uid = input.userId ?? "local";
    const acct = input.account ?? "";
    const messageKey = input.messageId
      ? `${uid}:${input.provider}:${acct}:${input.messageId}`
      : `${uid}:${input.provider}:${acct}:${input.code}:${input.receivedAt}`;
    if (this.seenMessageKeys.has(messageKey)) {
      return this.items.find((x) => x.messageId && `${x.userId ?? "local"}:${x.provider}:${x.account ?? ""}:${x.messageId}` === messageKey) ?? {
        ...input,
        id: crypto.randomUUID(),
      };
    }
    this.seenMessageKeys.add(messageKey);

    const item: OtpItem = { ...input, id: crypto.randomUUID() };
    this.items.unshift(item);
    if (this.items.length > 100) this.items = this.items.slice(0, 100);
    if (this.seenMessageKeys.size > 500) {
      // prevent unbounded growth; allow re-processing old messages after a while
      this.seenMessageKeys = new Set([...this.seenMessageKeys].slice(-300));
    }
    return item;
  }

  consume(id: string, userId?: string): boolean {
    const it = this.items.find((x) => x.id === id);
    if (!it) return false;
    // In multi-tenant mode, only the owning user may consume their item.
    if (userId && (it.userId ?? "local") !== userId) return false;
    if (it.consumedAt) return true;
    it.consumedAt = Date.now();
    return true;
  }

  list(limit = 20, userId?: string): OtpItem[] {
    const items = userId ? this.items.filter((it) => (it.userId ?? "local") === userId) : this.items;
    return items.slice(0, limit);
  }

  // All currently-valid OTPs matching the query, best match first. Shares its
  // filtering + scoring with latest() so the popup's "next code" navigation
  // walks the exact same candidate set the autofill would pick from.
  validList(q: LatestQuery): OtpItem[] {
    const now = Date.now();
    const providers = q.providers?.length ? new Set(q.providers) : null;
    const domain = q.domain?.toLowerCase();
    const account = q.account?.toLowerCase();

    const scored: { item: OtpItem; score: number }[] = [];
    for (const it of this.items) {
      if (q.userId && (it.userId ?? "local") !== q.userId) continue;
      if (providers && !providers.has(it.provider)) continue;
      if (account && (it.account ?? "").toLowerCase() !== account) continue;
      if (it.consumedAt) continue;
      // Validity window: the email-stated TTL wins; otherwise the caller's
      // maxAgeMs applies. Keeps a 5-minute code available for its full window.
      const windowMs = it.ttlSec && it.ttlSec > 0 ? it.ttlSec * 1000 : q.maxAgeMs;
      if (now - it.receivedAt > windowMs) continue;

      let score = 0;
      // newer is better
      score += Math.max(0, 1000 - Math.floor((now - it.receivedAt) / 100));
      if (domain) {
        const hay = `${it.subject ?? ""} ${it.from ?? ""}`.toLowerCase();
        if (hay.includes(domain)) score += 2000;
        const root = domain.split(".").slice(-2).join(".");
        if (root && root !== domain && hay.includes(root)) score += 1000;
      }
      // prefer 6-digit in general
      if (it.code.length === 6) score += 30;

      scored.push({ item: it, score });
    }
    // Reason: stable highest-score-first order so index 0 == latest()'s pick.
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.item);
  }

  latest(q: LatestQuery): OtpItem | null {
    return this.validList(q)[0] ?? null;
  }
}

