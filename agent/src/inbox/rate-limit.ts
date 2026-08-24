/*
 * Token-bucket rate limiter for the inbound webhook.
 *
 * In-memory and dependency-free by design: the agent is a single process and
 * this only needs to blunt abuse of a public endpoint, not coordinate across
 * replicas.
 */

type Bucket = { tokens: number; updatedAt: number };

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerMs: number;

  constructor(capacity: number, perMs = 60_000) {
    this.capacity = capacity;
    this.refillPerMs = capacity / perMs;
  }

  /*
   * Consume one token for `key`. Returns false when the bucket is empty, which
   * the caller turns into a 429.
   *
   * `now` is injectable so tests do not have to sleep.
   */
  take(key: string, now = Date.now()): boolean {
    const bucket = this.buckets.get(key);
    if (!bucket) {
      this.buckets.set(key, { tokens: this.capacity - 1, updatedAt: now });
      return true;
    }
    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerMs);
    bucket.updatedAt = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /*
   * Drop buckets that have refilled completely — they carry no state worth
   * keeping. Without this the Map grows once per distinct IP, forever.
   */
  sweep(now = Date.now()): void {
    const fullAfterMs = this.capacity / this.refillPerMs;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt >= fullAfterMs) this.buckets.delete(key);
    }
  }

  size(): number {
    return this.buckets.size;
  }
}

// Per-IP is checked before the token lookup so enumeration attempts never reach
// the database; per-token is the tighter limit for a correctly configured source.
export const PER_IP_PER_MIN = 120;
export const PER_TOKEN_PER_MIN = 60;
