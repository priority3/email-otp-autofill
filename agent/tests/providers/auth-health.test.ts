import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyAuthFailure, healthFromFailure } from "../../src/providers/auth-health.js";

// Captured verbatim from the production agent's logs, not hand-written.
const REAL_GMAIL_403 = JSON.stringify({
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
});

const GOOGLE_INVALID_GRANT = JSON.stringify({
  error: "invalid_grant",
  error_description: "Token has been expired or revoked.",
});

const MS_INVALID_GRANT = JSON.stringify({
  error: "invalid_grant",
  error_description: "AADSTS50173: The provided grant has expired due to it being revoked.",
});

describe("classifyAuthFailure — must ask the user to re-authorize", () => {
  it("recognises the real Gmail 403 from production", () => {
    assert.equal(classifyAuthFailure(403, REAL_GMAIL_403), "scope_insufficient");
  });

  it("recognises a revoked Google refresh token", () => {
    assert.equal(classifyAuthFailure(400, GOOGLE_INVALID_GRANT), "token_revoked");
  });

  it("recognises a revoked Microsoft refresh token", () => {
    assert.equal(classifyAuthFailure(400, MS_INVALID_GRANT), "token_revoked");
  });

  it("treats a bare 401 as a credential problem", () => {
    assert.equal(classifyAuthFailure(401, ""), "unauthorized");
  });
});

describe("classifyAuthFailure — must NOT nag the user", () => {
  it("ignores rate limiting", () => {
    assert.equal(classifyAuthFailure(429, "Rate Limit Exceeded"), null);
  });

  it("ignores server errors", () => {
    assert.equal(classifyAuthFailure(500, "Internal Error"), null);
    assert.equal(classifyAuthFailure(503, "Backend Error"), null);
  });

  it("ignores an empty or unrelated 400", () => {
    assert.equal(classifyAuthFailure(400, "Bad Request"), null);
    assert.equal(classifyAuthFailure(404, "Not Found"), null);
  });

  it("does not let a rate-limit body mentioning scopes trip the scope rule", () => {
    // 429 is checked before any body matching, so wording cannot override it.
    assert.equal(classifyAuthFailure(429, "quota exceeded for ACCESS_TOKEN_SCOPE_INSUFFICIENT"), null);
  });

  it("does not let a 5xx body mentioning invalid_grant trip the revoke rule", () => {
    assert.equal(classifyAuthFailure(502, '{"error":"invalid_grant"}'), null);
  });
});

describe("healthFromFailure", () => {
  it("flags re-auth with the code attached", () => {
    assert.deepEqual(healthFromFailure(403, REAL_GMAIL_403), {
      needsReauth: true,
      code: "scope_insufficient",
    });
  });

  it("reports healthy for transient failures, so a blip clears the warning", () => {
    assert.deepEqual(healthFromFailure(429, "slow down"), { needsReauth: false, code: null });
  });
});
