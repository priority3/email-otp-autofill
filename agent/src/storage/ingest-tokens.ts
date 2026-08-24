import crypto from "node:crypto";

import { db } from "./db.js";

/*
 * Ingest tokens for the inbound webhook channel (POST /v1/inbox/hook).
 *
 * One token per user, stored in users.ingest_token. Stored in PLAINTEXT, which
 * matches how sessions.token is stored: it is a token this agent issues (not a
 * third-party credential), and the settings page must be able to show the full
 * webhook URL so the user can paste it into their mail source. A leaked
 * database therefore means the ingest channel must be rotated — documented in
 * docs/inbound-webhook.md.
 */

// 256 bits of randomness. Enumeration is infeasible, which is what lets
// resolveToken() get away with a plain SQL equality lookup (see below).
const TOKEN_BYTES = 32;

export function issueToken(userId: string): string {
  const token = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
  db.prepare("UPDATE users SET ingest_token = ? WHERE id = ?").run(token, userId);
  return token;
}

export function getToken(userId: string): string | null {
  const row = db.prepare("SELECT ingest_token FROM users WHERE id = ?").get(userId) as
    | { ingest_token: string | null }
    | undefined;
  return row?.ingest_token ?? null;
}

export function clearToken(userId: string): void {
  db.prepare("UPDATE users SET ingest_token = NULL WHERE id = ?").run(userId);
}

/*
 * Resolve a token to its owning userId, or null.
 *
 * Reason: a disabled user's token must stop working immediately, so the
 * disabled check lives in the WHERE clause rather than in a second query.
 * `disabled` was added by a later migration, so existing rows can hold NULL
 * rather than 0 — both mean "not disabled".
 *
 * Reason: this is a lookup BY token, so crypto.timingSafeEqual does not apply
 * (there is no known value to compare against). SQL equality is not
 * constant-time, but with a 256-bit random token the timing signal is not
 * exploitable, and the endpoint is rate-limited per IP before it gets here.
 */
export function resolveToken(token: string): string | null {
  if (!token) return null;
  const row = db
    .prepare("SELECT id FROM users WHERE ingest_token = ? AND (disabled IS NULL OR disabled = 0)")
    .get(token) as { id: string } | undefined;
  return row?.id ?? null;
}
