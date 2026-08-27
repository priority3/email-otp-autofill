import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PollLogger, describeError, type LogSink } from "../../src/providers/poll-log.js";

function recorder() {
  const lines: string[] = [];
  const sink: LogSink = { info: (m) => lines.push(`INFO ${m}`), error: (m) => lines.push(`ERR ${m}`) };
  return { lines, sink };
}

describe("describeError", () => {
  it("surfaces the cause code that fetch() hides", () => {
    // Reason: `fetch failed` alone cannot distinguish a dead proxy from a
    // timeout; the whole point of the helper is to recover that detail.
    const err = Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    assert.equal(describeError(err), "fetch failed (ECONNREFUSED)");
  });

  it("does not repeat a detail already present in the message", () => {
    const err = Object.assign(new Error("connect ETIMEDOUT"), { cause: { code: "ETIMEDOUT" } });
    assert.equal(describeError(err), "connect ETIMEDOUT");
  });

  it("handles a plain error and a non-error", () => {
    assert.equal(describeError(new Error("boom")), "boom");
    assert.equal(describeError("boom"), "boom");
    assert.equal(describeError(undefined), "unknown error");
  });
});

describe("PollLogger", () => {
  it("logs a fault once instead of on every poll", () => {
    const { lines, sink } = recorder();
    const log = new PollLogger("[x]", 60, sink);

    for (let i = 0; i < 30; i++) log.fail(new Error("graph_list_inbox_failed:503"));

    assert.deepEqual(lines, ["ERR [x] error: graph_list_inbox_failed:503"]);
  });

  it("re-states a persistent fault so it cannot look resolved", () => {
    const { lines, sink } = recorder();
    const log = new PollLogger("[x]", 5, sink);

    for (let i = 0; i < 11; i++) log.fail(new Error("down"));

    assert.deepEqual(lines, [
      "ERR [x] error: down",
      "ERR [x] error: down (still failing, 6 consecutive)",
      "ERR [x] error: down (still failing, 11 consecutive)",
    ]);
  });

  it("logs a different fault immediately", () => {
    const { lines, sink } = recorder();
    const log = new PollLogger("[x]", 60, sink);

    log.fail(new Error("first"));
    log.fail(new Error("first"));
    log.fail(new Error("second"));

    assert.deepEqual(lines, ["ERR [x] error: first", "ERR [x] error: second"]);
  });

  it("reports recovery, but stays silent while healthy", () => {
    const { lines, sink } = recorder();
    const log = new PollLogger("[x]", 60, sink);

    log.ok();
    log.ok();
    assert.deepEqual(lines, [], "a healthy poller must not emit a line per poll");

    log.fail(new Error("down"));
    log.ok();
    log.ok();

    assert.deepEqual(lines, ["ERR [x] error: down", "INFO [x] recovered"]);
  });

  it("recovers even when the very first poll failed", () => {
    // Reason: an agent that starts broken and then heals is the common restart
    // case; suppressing that line would leave the fault looking permanent.
    const { lines, sink } = recorder();
    const log = new PollLogger("[x]", 60, sink);

    log.fail(new Error("down"));
    log.ok();

    assert.deepEqual(lines, ["ERR [x] error: down", "INFO [x] recovered"]);
  });

  it("states a configuration note once, and again only if it changes", () => {
    const { lines, sink } = recorder();
    const log = new PollLogger("[x]", 60, sink);

    log.note("skipped: not connected");
    log.note("skipped: not connected");
    log.note("skipped: no client id");
    log.note("skipped: not connected");

    assert.deepEqual(lines, [
      "INFO [x] skipped: not connected",
      "INFO [x] skipped: no client id",
      "INFO [x] skipped: not connected",
    ]);
  });

  it("treats a note as clearable state, so a later fault still logs", () => {
    const { lines, sink } = recorder();
    const log = new PollLogger("[x]", 60, sink);

    log.note("skipped: not connected");
    log.fail(new Error("down"));

    assert.deepEqual(lines, ["INFO [x] skipped: not connected", "ERR [x] error: down"]);
  });
});
