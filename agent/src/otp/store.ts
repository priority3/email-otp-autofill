import crypto from "node:crypto";

export type ProviderId = "qq" | "outlook";

export type OtpItem = {
  id: string;
  provider: ProviderId;
  code: string;
  receivedAt: number; // epoch ms
  from?: string;
  subject?: string;
  messageId?: string;
  consumedAt?: number;
};

export type LatestQuery = {
  providers?: ProviderId[];
  maxAgeMs: number;
  domain?: string;
};

export class OtpStore {
  private items: OtpItem[] = [];
  private seenMessageKeys = new Set<string>();

  add(input: Omit<OtpItem, "id">): OtpItem {
    const messageKey = input.messageId
      ? `${input.provider}:${input.messageId}`
      : `${input.provider}:${input.code}:${input.receivedAt}`;
    if (this.seenMessageKeys.has(messageKey)) {
      return this.items.find((x) => x.messageId && `${x.provider}:${x.messageId}` === messageKey) ?? {
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

  consume(id: string): boolean {
    const it = this.items.find((x) => x.id === id);
    if (!it) return false;
    if (it.consumedAt) return true;
    it.consumedAt = Date.now();
    return true;
  }

  list(limit = 20): OtpItem[] {
    return this.items.slice(0, limit);
  }

  latest(q: LatestQuery): OtpItem | null {
    const now = Date.now();
    const providers = q.providers?.length ? new Set(q.providers) : null;
    const domain = q.domain?.toLowerCase();

    let best: { item: OtpItem; score: number } | null = null;
    for (const it of this.items) {
      if (providers && !providers.has(it.provider)) continue;
      if (it.consumedAt) continue;
      if (now - it.receivedAt > q.maxAgeMs) continue;

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

      if (!best || score > best.score) best = { item: it, score };
    }
    return best?.item ?? null;
  }
}

