import crypto from "node:crypto";

import { db } from "./db.js";

/*
 * Invite codes (one-time, single-use). When the "require invite" setting is on,
 * registration must present an unused code, which is then bound to the new user.
 */

export type Invite = {
  code: string;
  createdAt: number;
  usedBy: string | null;
  usedAt: number | null;
  note: string | null;
};

type InviteRow = {
  code: string;
  created_at: number;
  used_by: string | null;
  used_at: number | null;
  note: string | null;
};

// Crockford-ish base32 alphabet (no 0/O/1/I/L to avoid confusion).
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function genCode(len = 10): string {
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

function rowToInvite(r: InviteRow): Invite {
  return { code: r.code, createdAt: r.created_at, usedBy: r.used_by, usedAt: r.used_at, note: r.note };
}

// Generate `count` fresh codes; retries on the rare PK collision.
export function createInvites(count: number, note?: string): Invite[] {
  const n = Math.max(1, Math.min(100, Math.floor(count) || 1));
  const ins = db.prepare(
    "INSERT INTO invites (code, created_at, used_by, used_at, note) VALUES (?, ?, NULL, NULL, ?)"
  );
  const now = Date.now();
  const made: Invite[] = [];
  for (let i = 0; i < n; i++) {
    let code = genCode();
    for (let tries = 0; tries < 5; tries++) {
      try {
        ins.run(code, now, note ?? null);
        break;
      } catch {
        code = genCode(); // collision — regenerate
      }
    }
    made.push({ code, createdAt: now, usedBy: null, usedAt: null, note: note ?? null });
  }
  return made;
}

export function listInvites(): Invite[] {
  const rows = db.prepare("SELECT * FROM invites ORDER BY created_at DESC").all() as InviteRow[];
  return rows.map(rowToInvite);
}

// Atomically claim an unused code for a user. Returns true only if this call
// is the one that consumed it (used_by was NULL).
export function consumeInvite(code: string, userId: string): boolean {
  const res = db
    .prepare("UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL")
    .run(userId, Date.now(), code);
  return res.changes === 1;
}

// True if the code exists and is still unused (pre-check before registration).
export function isInviteUsable(code: string): boolean {
  const row = db.prepare("SELECT used_by FROM invites WHERE code = ?").get(code) as
    | { used_by: string | null }
    | undefined;
  return !!row && row.used_by === null;
}

// Revoke (delete) an unused code. Returns true if a code was removed.
export function revokeInvite(code: string): boolean {
  const res = db.prepare("DELETE FROM invites WHERE code = ? AND used_by IS NULL").run(code);
  return res.changes === 1;
}

export function inviteStats(): { total: number; used: number; unused: number } {
  const total = (db.prepare("SELECT COUNT(*) AS n FROM invites").get() as { n: number }).n;
  const used = (db.prepare("SELECT COUNT(*) AS n FROM invites WHERE used_by IS NOT NULL").get() as { n: number }).n;
  return { total, used, unused: total - used };
}
