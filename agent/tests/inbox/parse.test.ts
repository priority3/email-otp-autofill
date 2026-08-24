import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeAddresses, parseInbound } from "../../src/inbox/parse.js";

const JSON_CT = "application/json";
const RFC_CT = "message/rfc822";

function rfc822(lines: Record<string, string>, body: string): Buffer {
  const headers = Object.entries(lines)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n");
  return Buffer.from(`${headers}\r\n\r\n${body}\r\n`, "utf8");
}

describe("normalizeAddresses", () => {
  it("accepts a bare address", () => {
    assert.deepEqual(normalizeAddresses("A@B.com"), ["a@b.com"]);
  });

  it("extracts the address from a display-name form", () => {
    assert.deepEqual(normalizeAddresses("Probe User <probe@d.com>"), ["probe@d.com"]);
  });

  it("splits a comma-separated string", () => {
    assert.deepEqual(normalizeAddresses("a@d.com, b@d.com"), ["a@d.com", "b@d.com"]);
  });

  it("accepts an array and de-dupes", () => {
    assert.deepEqual(normalizeAddresses(["a@d.com", "A@d.com"]), ["a@d.com"]);
  });

  it("drops tokens that are not address-shaped", () => {
    assert.deepEqual(normalizeAddresses(["not-an-address", "ok@d.com"]), ["ok@d.com"]);
  });

  it("returns [] for undefined", () => {
    assert.deepEqual(normalizeAddresses(undefined), []);
  });
});

describe("parseInbound — JSON body", () => {
  it("maps canonical fields", async () => {
    const body = Buffer.from(
      JSON.stringify({
        to: "probe@d.com",
        from: "no-reply@x.com",
        subject: "Your code",
        text: "Your verification code is 481920",
        messageId: "<m1@x>",
      })
    );
    const msg = await parseInbound(body, JSON_CT);
    assert.ok(msg);
    assert.deepEqual(msg.to, ["probe@d.com"]);
    assert.equal(msg.from, "no-reply@x.com");
    assert.equal(msg.subject, "Your code");
    assert.equal(msg.messageId, "<m1@x>");
  });

  it("accepts `to` as an array", async () => {
    const body = Buffer.from(JSON.stringify({ to: ["a@d.com", "b@d.com"], text: "code 123456" }));
    const msg = await parseInbound(body, JSON_CT);
    assert.deepEqual(msg?.to, ["a@d.com", "b@d.com"]);
  });

  it("parses receivedAt from epoch ms and from a date string", async () => {
    const epoch = 1_750_000_000_000;
    const a = await parseInbound(Buffer.from(JSON.stringify({ receivedAt: epoch })), JSON_CT);
    assert.equal(a?.receivedAt, epoch);

    const b = await parseInbound(
      Buffer.from(JSON.stringify({ receivedAt: "2026-08-24T10:00:00Z" })),
      JSON_CT
    );
    assert.equal(b?.receivedAt, Date.parse("2026-08-24T10:00:00Z"));
  });

  it("leaves receivedAt undefined when unparseable", async () => {
    const msg = await parseInbound(Buffer.from(JSON.stringify({ receivedAt: "not-a-date" })), JSON_CT);
    assert.equal(msg?.receivedAt, undefined);
  });

  it("returns null on malformed JSON", async () => {
    assert.equal(await parseInbound(Buffer.from("{not json"), JSON_CT), null);
  });

  it("returns an empty recipient list when `to` is missing", async () => {
    const msg = await parseInbound(Buffer.from(JSON.stringify({ text: "code 123456" })), JSON_CT);
    assert.deepEqual(msg?.to, []);
  });
});

describe("parseInbound — rfc822 body", () => {
  it("extracts recipient, sender, subject, body and date", async () => {
    const date = new Date("2026-08-24T10:00:00Z");
    const raw = rfc822(
      {
        From: "Sender <no-reply@x.com>",
        To: "Probe <probe@d.com>",
        Subject: "Your code",
        Date: date.toUTCString(),
        "Message-ID": "<m2@x>",
      },
      "Your verification code is 481920, valid for 5 minutes."
    );
    const msg = await parseInbound(raw, RFC_CT);
    assert.ok(msg);
    assert.deepEqual(msg.to, ["probe@d.com"]);
    assert.equal(msg.from, "no-reply@x.com");
    assert.equal(msg.subject, "Your code");
    assert.equal(msg.messageId, "<m2@x>");
    assert.equal(msg.receivedAt, date.getTime());
    assert.match(String(msg.text), /481920/);
  });

  it("collects every To: recipient", async () => {
    const raw = rfc822({ To: "a@d.com, b@d.com", Subject: "s" }, "code 123456");
    const msg = await parseInbound(raw, RFC_CT);
    assert.deepEqual(msg?.to, ["a@d.com", "b@d.com"]);
  });

  it("falls back to Delivered-To when To: has no address", async () => {
    // Reason: catch-all forwarders often rewrite To: and leave the original
    // recipient only in Delivered-To.
    const raw = rfc822(
      { To: "undisclosed-recipients:;", "Delivered-To": "real@d.com", Subject: "s" },
      "code 123456"
    );
    const msg = await parseInbound(raw, RFC_CT);
    assert.deepEqual(msg?.to, ["real@d.com"]);
  });

  it("falls back to X-Original-To", async () => {
    const raw = rfc822({ "X-Original-To": "orig@d.com", Subject: "s" }, "code 123456");
    const msg = await parseInbound(raw, RFC_CT);
    assert.deepEqual(msg?.to, ["orig@d.com"]);
  });

  it("prefers To: over the fallback headers", async () => {
    const raw = rfc822({ To: "main@d.com", "Delivered-To": "other@d.com" }, "code 123456");
    const msg = await parseInbound(raw, RFC_CT);
    assert.deepEqual(msg?.to, ["main@d.com"]);
  });

  it("treats an unknown content-type as rfc822", async () => {
    const raw = rfc822({ To: "probe@d.com", Subject: "s" }, "code 123456");
    const msg = await parseInbound(raw, "text/plain");
    assert.deepEqual(msg?.to, ["probe@d.com"]);
  });

  it("keeps html so the caller can strip it", async () => {
    const raw = rfc822(
      { To: "probe@d.com", "Content-Type": 'text/html; charset="utf-8"' },
      "<p>code <b>481920</b></p>"
    );
    const msg = await parseInbound(raw, RFC_CT);
    assert.match(String(msg?.html), /481920/);
  });
});
