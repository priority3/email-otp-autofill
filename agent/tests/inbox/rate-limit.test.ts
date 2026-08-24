import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "../../src/inbox/rate-limit.js";

describe("RateLimiter", () => {
  const t0 = 1_750_000_000_000;

  it("allows up to capacity then rejects", () => {
    const rl = new RateLimiter(3);
    assert.equal(rl.take("k", t0), true);
    assert.equal(rl.take("k", t0), true);
    assert.equal(rl.take("k", t0), true);
    assert.equal(rl.take("k", t0), false);
  });

  it("keys are independent", () => {
    const rl = new RateLimiter(1);
    assert.equal(rl.take("a", t0), true);
    assert.equal(rl.take("a", t0), false);
    assert.equal(rl.take("b", t0), true);
  });

  it("refills over time", () => {
    const rl = new RateLimiter(60); // 60 per minute => 1 per second
    for (let i = 0; i < 60; i++) rl.take("k", t0);
    assert.equal(rl.take("k", t0), false);
    assert.equal(rl.take("k", t0 + 1000), true);
  });

  it("does not refill beyond capacity", () => {
    const rl = new RateLimiter(2);
    rl.take("k", t0);
    // A long idle gap must not bank extra tokens.
    assert.equal(rl.take("k", t0 + 3_600_000), true);
    assert.equal(rl.take("k", t0 + 3_600_000), true);
    assert.equal(rl.take("k", t0 + 3_600_000), false);
  });

  it("sweep drops fully-refilled buckets so the map stays bounded", () => {
    const rl = new RateLimiter(60);
    rl.take("a", t0);
    rl.take("b", t0);
    assert.equal(rl.size(), 2);
    rl.sweep(t0 + 1000);
    assert.equal(rl.size(), 2, "still refilling — must be kept");
    rl.sweep(t0 + 60_000);
    assert.equal(rl.size(), 0);
  });
});
