import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { singleFlight } from "../../src/providers/single-flight.js";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");

/** A promise plus the handles to settle it from the test. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("singleFlight", () => {
  it("drops calls that arrive while one is still running", async () => {
    const gate = deferred();
    let started = 0;
    const run = singleFlight(async () => {
      started++;
      await gate.promise;
      return "done";
    });

    const first = run();
    const second = run();
    const third = run();

    assert.equal(started, 1, "only the first call may enter fn");
    assert.equal(await second, undefined, "a dropped call resolves to undefined");
    assert.equal(await third, undefined);

    gate.resolve();
    assert.equal(await first, "done");
  });

  it("accepts the next call once the previous one finished", async () => {
    let started = 0;
    const run = singleFlight(async () => {
      started++;
    });

    await run();
    await run();
    await run();
    assert.equal(started, 3, "sequential calls are not throttled");
  });

  it("releases the lock when fn throws, so the poller is not wedged forever", async () => {
    // The whole point is resilience during a bad network window. If a rejected
    // poll left the flag set, polling would stop permanently.
    let started = 0;
    const run = singleFlight(async () => {
      started++;
      throw new Error("boom");
    });

    await assert.rejects(run, /boom/);
    await assert.rejects(run, /boom/);
    assert.equal(started, 2);
  });

  it("releases the lock even when the in-flight call rejects late", async () => {
    const gate = deferred();
    let started = 0;
    let stallOnGate = true;
    const run = singleFlight(async () => {
      started++;
      if (stallOnGate) await gate.promise;
    });

    const first = run();
    // Attach the rejection handler before settling the gate, otherwise the
    // rejection lands on an unwatched promise and Node reports it as unhandled.
    const firstSettled = assert.rejects(() => first, /late failure/);
    assert.equal(await run(), undefined, "dropped while in flight");
    gate.reject(new Error("late failure"));
    await firstSettled;

    stallOnGate = false; // the gate is spent; a later poll must not re-await it
    await run();
    assert.equal(started, 2, "a later call runs normally after the failure");
  });

  it("keeps separate wrappers independent", async () => {
    const gate = deferred();
    let a = 0;
    let b = 0;
    const runA = singleFlight(async () => {
      a++;
      await gate.promise;
    });
    const runB = singleFlight(async () => {
      b++;
    });

    void runA();
    await runB();
    assert.equal(a, 1);
    assert.equal(b, 1, "one poller stalling must not block the other");
    gate.resolve();
  });
});

/*
 * Both pollers are driven by setInterval, which fires regardless of whether the
 * previous tick finished. With connect retries a stalled poll can outlast the
 * 5s default interval, so the guard has to be present on both — a runtime test
 * would need a real stalled network, so the shape is enforced at source level.
 */
describe("pollers drop overlapping ticks", () => {
  for (const rel of ["providers/outlook-oauth.ts", "providers/gmail-oauth.ts"]) {
    it(`${rel} wraps runPoll in singleFlight`, () => {
      const src = readFileSync(path.join(SRC, rel), "utf8");
      assert.match(src, /import \{ singleFlight \} from "\.\/single-flight\.js";/);
      assert.match(src, /runPoll = singleFlight\(/, "runPoll must be the guarded wrapper, not a bare method");
      assert.doesNotMatch(src, /private async runPoll\(/, "a bare runPoll method would bypass the guard");
    });
  }
});
