import { describe, it } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

import { ImapOtpWatcher } from "../../src/providers/imap.js";
import { retryDelay } from "../../src/providers/manager.js";
import { OtpStore } from "../../src/otp/store.js";

// A socket that accepts then immediately hangs up, so connect() fails fast
// without needing a real IMAP server or a network round trip.
async function deadServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function makeWatcher(port: number): ImapOtpWatcher {
  return new ImapOtpWatcher({
    providerId: "qq",
    userId: "u1",
    host: "127.0.0.1",
    port,
    secure: false,
    auth: { user: "someone@example.com", pass: "nope" },
    store: new OtpStore(),
  });
}

describe("ImapOtpWatcher lifecycle", () => {
  it("reports running=false once start() has settled", async () => {
    // Regression: `running` was set true in start() and only ever cleared by
    // stop(). A watcher that died therefore kept reporting itself as running,
    // so the supervisor and /v1/status both believed a dead mailbox was live.
    const server = await deadServer();
    try {
      const w = makeWatcher(server.port);
      assert.equal(w.status().running, false, "not running before start");

      await assert.rejects(() => w.start(), "connecting to a dead socket must reject");
      assert.equal(w.status().running, false, "must not still claim to be running");
      assert.ok(w.status().lastError, "the failure reason must be retained");
    } finally {
      await server.close();
    }
  });

  it("can be started again after a failure", async () => {
    // Regression: the watcher held a single ImapFlow instance for its whole
    // life. A second connect() on it threw "Can not re-use ImapFlow instance",
    // which is what made the failure permanent. Restarting must now get past
    // the reuse guard and fail on the connection itself instead.
    const server = await deadServer();
    try {
      const w = makeWatcher(server.port);
      await assert.rejects(() => w.start());
      const first = w.status().lastError;

      await assert.rejects(() => w.start());
      const second = w.status().lastError;

      for (const err of [first, second]) {
        assert.doesNotMatch(
          String(err),
          /re-use ImapFlow instance/i,
          "must not fail because the client instance was reused"
        );
      }
    } finally {
      await server.close();
    }
  });

  it("stop() before start() leaves it not running", async () => {
    const server = await deadServer();
    try {
      const w = makeWatcher(server.port);
      w.stop();
      assert.equal(w.status().running, false);
    } finally {
      await server.close();
    }
  });
});

describe("retryDelay", () => {
  it("starts at 5s and doubles", () => {
    assert.equal(retryDelay(0), 5_000);
    assert.equal(retryDelay(1), 10_000);
    assert.equal(retryDelay(2), 20_000);
    assert.equal(retryDelay(3), 40_000);
  });

  it("caps at 60s instead of growing without bound", () => {
    assert.equal(retryDelay(4), 60_000);
    assert.equal(retryDelay(10), 60_000);
    assert.equal(retryDelay(100), 60_000);
  });

  it("never returns a value that would busy-loop", () => {
    for (let i = 0; i < 20; i++) assert.ok(retryDelay(i) >= 5_000);
  });
});
