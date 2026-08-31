import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { summarizeApiError } from "../../src/providers/gmail-oauth.js";

// The exact body the production agent received 19,109 times. Pretty-printed it
// is ~26 lines; every one of those was going to the log, 5 seconds apart.
const REAL_403 = JSON.stringify(
  {
    error: {
      code: 403,
      message: "Request had insufficient authentication scopes.",
      errors: [{ message: "Insufficient Permission", domain: "global", reason: "insufficientPermissions" }],
      status: "PERMISSION_DENIED",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
          domain: "googleapis.com",
          metadata: { service: "gmail.googleapis.com", method: "caribou.api.proto.MailboxService.ListMessages" },
        },
      ],
    },
  },
  null,
  2
);

describe("summarizeApiError", () => {
  it("reduces the production 403 to a single line that keeps the actionable reason", () => {
    const line = summarizeApiError(REAL_403);
    assert.equal(line.includes("\n"), false, "must be one line");
    assert.match(line, /PERMISSION_DENIED/);
    assert.match(line, /insufficient authentication scopes/);
    assert.match(line, /reason=ACCESS_TOKEN_SCOPE_INSUFFICIENT/);
    // The whole point: far shorter than the body it replaces.
    assert.ok(line.length < 200, `expected a short line, got ${line.length} chars`);
    assert.ok(REAL_403.length > 600, "sanity: the original really is large");
  });

  it("falls back to the older errors[].reason shape", () => {
    const line = summarizeApiError(
      JSON.stringify({ error: { code: 401, message: "Invalid Credentials", errors: [{ reason: "authError" }] } })
    );
    assert.match(line, /Invalid Credentials/);
    assert.match(line, /reason=authError/);
  });

  it("bounds a non-JSON body instead of dumping a whole page", () => {
    const html = "<html>" + "x".repeat(5000) + "</html>";
    const line = summarizeApiError(html);
    assert.ok(line.length <= 200);
    assert.equal(line.includes("\n"), false);
  });

  it("collapses whitespace so a multi-line non-JSON body stays on one line", () => {
    assert.equal(summarizeApiError("line one\n  line two\n\tline three"), "line one line two line three");
  });

  it("handles an empty body", () => {
    assert.equal(summarizeApiError(""), "(no body)");
    assert.equal(summarizeApiError("   "), "(no body)");
  });
});
