import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OtpStore, type OtpItem } from "../../src/otp/store.js";

// Minimal valid item; override per test.
function makeInput(overrides: Partial<Omit<OtpItem, "id">> = {}): Omit<OtpItem, "id"> {
  return {
    provider: "qq",
    code: "123456",
    receivedAt: Date.now(),
    ...overrides,
  };
}

const MAX_AGE = 120_000;

describe("OtpStore.add", () => {
  it("stores an item and returns it via latest()", () => {
    const store = new OtpStore();
    const added = store.add(makeInput());
    const latest = store.latest({ maxAgeMs: MAX_AGE });
    assert.equal(latest?.id, added.id);
    assert.equal(latest?.code, "123456");
  });

  it("de-dupes the same messageId for the same user/account", () => {
    const store = new OtpStore();
    const first = store.add(makeInput({ messageId: "<m1>" }));
    const again = store.add(makeInput({ messageId: "<m1>" }));
    assert.equal(again.id, first.id);
    assert.equal(store.list(50).length, 1);
  });

  it("does NOT collapse the same messageId across different users", () => {
    const store = new OtpStore();
    store.add(makeInput({ messageId: "<m1>", userId: "alice" }));
    store.add(makeInput({ messageId: "<m1>", userId: "bob" }));
    assert.equal(store.list(50, "alice").length, 1);
    assert.equal(store.list(50, "bob").length, 1);
  });

  it("caps stored items at 100", () => {
    const store = new OtpStore();
    for (let i = 0; i < 105; i++) {
      store.add(makeInput({ code: String(100000 + i), receivedAt: Date.now() - i }));
    }
    assert.equal(store.list(500).length, 100);
  });
});

describe("OtpStore multi-tenant isolation", () => {
  it("list() and latest() only see the requesting user's items", () => {
    const store = new OtpStore();
    store.add(makeInput({ userId: "alice", code: "111111" }));
    store.add(makeInput({ userId: "bob", code: "222222" }));

    assert.deepEqual(store.list(50, "alice").map((x) => x.code), ["111111"]);
    assert.equal(store.latest({ userId: "bob", maxAgeMs: MAX_AGE })?.code, "222222");
    assert.equal(store.latest({ userId: "nobody", maxAgeMs: MAX_AGE }), null);
  });

  it("consume() refuses another user's item", () => {
    const store = new OtpStore();
    const item = store.add(makeInput({ userId: "alice" }));
    assert.equal(store.consume(item.id, "bob"), false);
    assert.equal(store.consume(item.id, "alice"), true);
    // Idempotent for the owner once consumed.
    assert.equal(store.consume(item.id, "alice"), true);
  });
});

describe("OtpStore.validList / latest", () => {
  it("excludes consumed items", () => {
    const store = new OtpStore();
    const item = store.add(makeInput());
    store.consume(item.id);
    assert.equal(store.latest({ maxAgeMs: MAX_AGE }), null);
  });

  it("excludes items older than maxAgeMs", () => {
    const store = new OtpStore();
    store.add(makeInput({ receivedAt: Date.now() - MAX_AGE - 1000 }));
    assert.equal(store.latest({ maxAgeMs: MAX_AGE }), null);
  });

  it("lets an email-stated ttlSec override the caller's maxAgeMs", () => {
    const store = new OtpStore();
    // 200s old: outside the 120s default window, but inside its own 300s TTL.
    store.add(makeInput({ receivedAt: Date.now() - 200_000, ttlSec: 300, code: "555555" }));
    store.add(makeInput({ receivedAt: Date.now() - 200_000, code: "666666" }));
    const valid = store.validList({ maxAgeMs: MAX_AGE });
    assert.deepEqual(valid.map((x) => x.code), ["555555"]);
  });

  it("filters by provider and account", () => {
    const store = new OtpStore();
    store.add(makeInput({ provider: "qq", account: "a@qq.com", code: "111111" }));
    store.add(makeInput({ provider: "outlook", account: "b@outlook.com", code: "222222" }));

    assert.equal(store.latest({ providers: ["outlook"], maxAgeMs: MAX_AGE })?.code, "222222");
    assert.equal(store.latest({ account: "A@QQ.com", maxAgeMs: MAX_AGE })?.code, "111111");
    assert.equal(store.latest({ providers: ["gmail"], maxAgeMs: MAX_AGE }), null);
  });

  it("prefers a domain match over a newer unrelated code", () => {
    const store = new OtpStore();
    store.add(makeInput({ code: "111111", receivedAt: Date.now() - 60_000, from: "no-reply@github.com" }));
    store.add(makeInput({ code: "222222", receivedAt: Date.now(), from: "no-reply@example.com" }));
    assert.equal(store.latest({ domain: "github.com", maxAgeMs: MAX_AGE })?.code, "111111");
  });

  it("matches the registrable root of a subdomain", () => {
    const store = new OtpStore();
    store.add(makeInput({ code: "111111", from: "security@accounts.github.com" }));
    assert.equal(store.latest({ domain: "gist.github.com", maxAgeMs: MAX_AGE })?.code, "111111");
  });

  it("orders newest-first when nothing else differs", () => {
    const store = new OtpStore();
    store.add(makeInput({ code: "111111", receivedAt: Date.now() - 60_000 }));
    store.add(makeInput({ code: "222222", receivedAt: Date.now() }));
    const valid = store.validList({ maxAgeMs: MAX_AGE });
    assert.deepEqual(valid.map((x) => x.code), ["222222", "111111"]);
  });
});
