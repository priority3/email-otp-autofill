import { MASTER_KEY } from "../constants.js";
import { decrypt, encrypt, isEncrypted } from "./crypto.js";
import { db } from "./db.js";

/*
 * Secret storage for email credentials, in the SQLite `secrets` table. Values
 * are encrypted at rest with AES-256-GCM using the master key (from env). The
 * master key is never written to disk — a leaked database is useless without it.
 */

function dbGet(key: string): string | null {
  const row = db.prepare("SELECT value FROM secrets WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

function dbSet(key: string, value: string): void {
  db.prepare(
    "INSERT INTO secrets (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

function dbDelete(key: string): void {
  db.prepare("DELETE FROM secrets WHERE key = ?").run(key);
}

export async function secretGet(key: string): Promise<string | null> {
  const stored = dbGet(key);
  if (stored == null) return null;
  if (!isEncrypted(stored)) return stored; // legacy plaintext
  if (!MASTER_KEY) {
    console.error(`[otp-agent] secret "${key}" is encrypted but OTP_AGENT_MASTER_KEY is not set`);
    return null;
  }
  try {
    return decrypt(stored, MASTER_KEY);
  } catch {
    console.error(`[otp-agent] failed to decrypt secret "${key}" (wrong master key or corrupted data)`);
    return null;
  }
}

export async function secretSet(key: string, value: string): Promise<void> {
  // Encrypt at rest when a master key is configured; otherwise store plaintext
  // (startup prints a warning in that case).
  dbSet(key, MASTER_KEY ? encrypt(value, MASTER_KEY) : value);
}

export async function secretDelete(key: string): Promise<void> {
  dbDelete(key);
}

// One-time upgrade: when a master key is configured and the DB holds legacy
// plaintext values, re-encrypt them in place. Safe to call on every startup.
export async function migratePlaintextSecrets(): Promise<void> {
  if (!MASTER_KEY) return;
  const rows = db.prepare("SELECT key, value FROM secrets").all() as { key: string; value: string }[];
  let changed = 0;
  for (const { key, value } of rows) {
    if (!isEncrypted(value)) {
      dbSet(key, encrypt(value, MASTER_KEY));
      changed++;
    }
  }
  if (changed) console.log(`[otp-agent] migrated ${changed} plaintext secret(s) to encrypted at rest`);
}
