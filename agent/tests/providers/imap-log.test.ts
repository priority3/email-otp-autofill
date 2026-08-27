import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describeLogEntry } from "../../src/providers/imap.js";

describe("describeLogEntry", () => {
  it("renders the message ImapFlow uses when a dropped IDLE cannot be recovered", () => {
    const line = describeLogEntry({
      msg: "IDLE recovery failed after timeout",
      err: { message: "Socket timeout", code: "ETIMEOUT" },
      cid: "abc",
    });
    assert.match(line, /IDLE recovery failed after timeout/);
    assert.match(line, /Socket timeout/);
    assert.match(line, /code=ETIMEOUT/);
  });

  it("never echoes an executed command", () => {
    // ImapFlow attaches `executedCommand` to command failures. For a failed
    // LOGIN that string contains the account password, so it must not reach the
    // logs no matter what else the entry carries.
    const line = describeLogEntry({
      msg: "Command failed",
      err: {
        message: "Authentication failed",
        responseStatus: "NO",
        executedCommand: 'a1 LOGIN user@qq.com "hunter2-secret-authcode"',
      },
    });
    assert.doesNotMatch(line, /hunter2/);
    assert.doesNotMatch(line, /LOGIN/);
    assert.match(line, /Authentication failed/);
    assert.match(line, /status=NO/);
  });

  it("ignores unknown fields entirely", () => {
    const line = describeLogEntry({ msg: "hi", secret: "do-not-print", auth: { pass: "nope" } });
    assert.equal(line, "hi");
  });

  it("survives odd inputs", () => {
    assert.equal(describeLogEntry("plain string"), "plain string");
    assert.equal(describeLogEntry({}), "(no detail)");
    assert.equal(describeLogEntry(null), "null");
    assert.equal(describeLogEntry(undefined), "undefined");
  });
});
