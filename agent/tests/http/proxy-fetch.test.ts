import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { errorCode, isRetryable, bodyIsReplayable, withConnectRetry } from "../../src/http/proxy-fetch.js";

/*
 * The shape undici actually throws: a bare TypeError whose `cause` carries the
 * transport error. Getting this wrong is the whole risk of the change — a
 * retry policy that never recognises the production error retries nothing.
 */
function undiciError(code: string, depth = 1): Error {
  let inner: any = Object.assign(new Error(code), { code });
  for (let i = 1; i < depth; i++) inner = Object.assign(new Error("wrapped"), { cause: inner });
  return Object.assign(new TypeError("fetch failed"), { cause: inner });
}

describe("errorCode", () => {
  it("digs the code out of the TypeError/cause shape undici throws", () => {
    assert.equal(errorCode(undiciError("UND_ERR_CONNECT_TIMEOUT")), "UND_ERR_CONNECT_TIMEOUT");
  });

  it("walks more than one level of cause", () => {
    assert.equal(errorCode(undiciError("ECONNRESET", 3)), "ECONNRESET");
  });

  it("reads a code off the error itself", () => {
    assert.equal(errorCode(Object.assign(new Error("x"), { code: "ENOTFOUND" })), "ENOTFOUND");
  });

  it("returns null when nothing in the chain has a code", () => {
    assert.equal(errorCode(new Error("plain")), null);
    assert.equal(errorCode(undefined), null);
    assert.equal(errorCode("a string"), null);
  });

  it("does not loop forever on a self-referential cause", () => {
    const e: any = new Error("loop");
    e.cause = e;
    assert.equal(errorCode(e), null);
  });
});

describe("isRetryable", () => {
  it("retries the production failure regardless of method", () => {
    // 1274 of these in 22h; the token refresh that hits it is a POST.
    assert.equal(isRetryable(undiciError("UND_ERR_CONNECT_TIMEOUT"), "POST"), true);
    assert.equal(isRetryable(undiciError("UND_ERR_CONNECT_TIMEOUT"), "GET"), true);
  });

  it("retries other pre-request failures on any method", () => {
    for (const code of ["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN", "ENOTFOUND"]) {
      assert.equal(isRetryable(undiciError(code), "POST"), true, code);
    }
  });

  it("retries an ambiguous failure only when the method is idempotent", () => {
    // ECONNRESET can land after the request was sent, so replaying a POST
    // could duplicate a side effect.
    assert.equal(isRetryable(undiciError("ECONNRESET"), "GET"), true);
    assert.equal(isRetryable(undiciError("ECONNRESET"), "post"), false);
    assert.equal(isRetryable(undiciError("ETIMEDOUT"), "PUT"), true);
    assert.equal(isRetryable(undiciError("UND_ERR_SOCKET"), "PATCH"), false);
  });

  it("ignores case when matching the method", () => {
    assert.equal(isRetryable(undiciError("ECONNRESET"), "get"), true);
  });

  it("does not retry an abort", () => {
    assert.equal(isRetryable(undiciError("ABORT_ERR"), "GET"), false);
  });

  it("does not retry an error with no transport code", () => {
    // An HTTP error response never reaches here, but a bug in our own code might.
    assert.equal(isRetryable(new Error("graph_list_inbox_failed:403"), "GET"), false);
  });
});

describe("bodyIsReplayable", () => {
  it("accepts the body shapes the OAuth callers actually send", () => {
    assert.equal(bodyIsReplayable(undefined), true);
    assert.equal(bodyIsReplayable({}), true);
    assert.equal(bodyIsReplayable({ body: "grant_type=refresh_token" }), true);
    assert.equal(bodyIsReplayable({ body: new URLSearchParams({ a: "1" }) } as never), true);
    assert.equal(bodyIsReplayable({ body: new Uint8Array([1, 2, 3]) } as never), true);
    assert.equal(bodyIsReplayable({ body: new ArrayBuffer(4) } as never), true);
  });

  it("refuses a body that the failed attempt already consumed", () => {
    const stream = new ReadableStream();
    assert.equal(bodyIsReplayable({ body: stream } as never), false);
    assert.equal(bodyIsReplayable({ body: new FormData() } as never), false);
  });
});

describe("withConnectRetry", () => {
  const noSleep = async () => {};
  const base = { method: "GET", replayable: true, sleep: noSleep };

  it("returns the first success without retrying", async () => {
    let calls = 0;
    const out = await withConnectRetry(async () => (calls++, "ok"), base);
    assert.equal(out, "ok");
    assert.equal(calls, 1);
  });

  it("recovers when a later attempt succeeds", async () => {
    let calls = 0;
    const out = await withConnectRetry(async () => {
      if (++calls < 3) throw undiciError("UND_ERR_CONNECT_TIMEOUT");
      return "ok";
    }, base);
    assert.equal(out, "ok");
    assert.equal(calls, 3);
  });

  it("stops at maxAttempts and rethrows the last error", async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        withConnectRetry(async () => {
          calls++;
          throw undiciError("UND_ERR_CONNECT_TIMEOUT");
        }, base),
      /fetch failed/
    );
    assert.equal(calls, 3, "default budget is 3 attempts, not unbounded");
  });

  it("honours a custom attempt budget", async () => {
    let calls = 0;
    await assert.rejects(() =>
      withConnectRetry(
        async () => {
          calls++;
          throw undiciError("ECONNREFUSED");
        },
        { ...base, maxAttempts: 5 }
      )
    );
    assert.equal(calls, 5);
  });

  it("does not retry an error outside the policy", async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        withConnectRetry(async () => {
          calls++;
          throw new Error("boom");
        }, base),
      /boom/
    );
    assert.equal(calls, 1);
  });

  it("does not retry when the body cannot be replayed", async () => {
    let calls = 0;
    await assert.rejects(() =>
      withConnectRetry(
        async () => {
          calls++;
          throw undiciError("UND_ERR_CONNECT_TIMEOUT");
        },
        { ...base, replayable: false }
      )
    );
    assert.equal(calls, 1, "replaying a consumed body would send a truncated request");
  });

  it("does not retry an ambiguous error on a non-idempotent method", async () => {
    let calls = 0;
    await assert.rejects(() =>
      withConnectRetry(
        async () => {
          calls++;
          throw undiciError("ECONNRESET");
        },
        { ...base, method: "POST" }
      )
    );
    assert.equal(calls, 1);
  });

  it("waits the configured delays, in order, between attempts", async () => {
    const waited: number[] = [];
    let calls = 0;
    await assert.rejects(() =>
      withConnectRetry(
        async () => {
          calls++;
          throw undiciError("UND_ERR_CONNECT_TIMEOUT");
        },
        {
          method: "GET",
          replayable: true,
          delaysMs: [10, 20],
          sleep: async (ms) => void waited.push(ms),
        }
      )
    );
    assert.deepEqual(waited, [10, 20], "one sleep per retry, none after the final failure");
    assert.equal(calls, 3);
  });

  it("reuses the last delay when the budget outruns the delay list", async () => {
    const waited: number[] = [];
    await assert.rejects(() =>
      withConnectRetry(
        async () => {
          throw undiciError("ECONNREFUSED");
        },
        {
          method: "GET",
          replayable: true,
          maxAttempts: 4,
          delaysMs: [5],
          sleep: async (ms) => void waited.push(ms),
        }
      )
    );
    assert.deepEqual(waited, [5, 5, 5]);
  });
});
