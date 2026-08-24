import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_AGE_MS, clampReceivedAt, isTooOld, matchRecipient } from "../../src/inbox/filter.js";

const OPEN = { allowedDomains: [], allowedPrefixes: [] };

describe("matchRecipient — allow-list", () => {
  it("accepts anything when both lists are empty", () => {
    assert.equal(matchRecipient(["anyone@whatever.com"], OPEN), "anyone@whatever.com");
  });

  it("requires the domain to match when allowedDomains is set", () => {
    const allow = { allowedDomains: ["d.com"], allowedPrefixes: [] };
    assert.equal(matchRecipient(["x@d.com"], allow), "x@d.com");
    assert.equal(matchRecipient(["x@other.com"], allow), null);
  });

  it("requires the local part to match a prefix when allowedPrefixes is set", () => {
    const allow = { allowedDomains: [], allowedPrefixes: ["otp-"] };
    assert.equal(matchRecipient(["otp-grok@d.com"], allow), "otp-grok@d.com");
    assert.equal(matchRecipient(["news@d.com"], allow), null);
  });

  it("requires BOTH when both lists are set", () => {
    const allow = { allowedDomains: ["d.com"], allowedPrefixes: ["otp-"] };
    assert.equal(matchRecipient(["otp-a@d.com"], allow), "otp-a@d.com");
    assert.equal(matchRecipient(["otp-a@other.com"], allow), null);
    assert.equal(matchRecipient(["news@d.com"], allow), null);
  });

  it("returns the recipient that matched, not the first one", () => {
    const allow = { allowedDomains: ["d.com"], allowedPrefixes: [] };
    assert.equal(matchRecipient(["spam@other.com", "real@d.com"], allow), "real@d.com");
  });

  it("is case-insensitive on both the address and the lists", () => {
    const allow = { allowedDomains: ["D.com"], allowedPrefixes: ["OTP-"] };
    assert.equal(matchRecipient(["OTP-A@d.COM"], allow), "otp-a@d.com");
  });

  it("tolerates whitespace in the configured lists", () => {
    const allow = { allowedDomains: [" d.com "], allowedPrefixes: [] };
    assert.equal(matchRecipient(["x@d.com"], allow), "x@d.com");
  });

  it("ignores empty entries instead of treating them as a wildcard prefix", () => {
    // Reason: a trailing comma in the UI would otherwise produce [""] and make
    // every local part match, silently disabling the prefix filter.
    const allow = { allowedDomains: [], allowedPrefixes: ["otp-", "  "] };
    assert.equal(matchRecipient(["news@d.com"], allow), null);
  });

  it("rejects malformed addresses", () => {
    assert.equal(matchRecipient(["no-at-sign"], OPEN), null);
    assert.equal(matchRecipient(["@d.com"], OPEN), null);
    assert.equal(matchRecipient(["x@"], OPEN), null);
  });

  it("returns null for an empty recipient list", () => {
    assert.equal(matchRecipient([], OPEN), null);
  });

  it("uses the last @ so quoted local parts do not break domain matching", () => {
    const allow = { allowedDomains: ["d.com"], allowedPrefixes: [] };
    assert.equal(matchRecipient(['"weird@local"@d.com'], allow), '"weird@local"@d.com');
  });
});

describe("clampReceivedAt", () => {
  const now = 1_750_000_000_000;

  it("falls back to now when the header date is missing", () => {
    assert.equal(clampReceivedAt(undefined, now), now);
  });

  it("keeps a past timestamp as-is", () => {
    assert.equal(clampReceivedAt(now - 30_000, now), now - 30_000);
  });

  it("clamps a future timestamp to now", () => {
    // Reason: the Date header is attacker-controlled; a future date would make
    // the OTP's validity window never expire.
    assert.equal(clampReceivedAt(now + 86_400_000, now), now);
  });

  it("falls back to now for NaN", () => {
    assert.equal(clampReceivedAt(Number.NaN, now), now);
  });
});

describe("isTooOld", () => {
  const now = 1_750_000_000_000;

  it("accepts a fresh message", () => {
    assert.equal(isTooOld(now - 1000, now), false);
  });

  it("rejects a message older than the window", () => {
    assert.equal(isTooOld(now - MAX_AGE_MS - 1, now), true);
  });

  it("accepts a message exactly at the boundary", () => {
    assert.equal(isTooOld(now - MAX_AGE_MS, now), false);
  });
});
