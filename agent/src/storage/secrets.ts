import os from "node:os";

import { MASTER_KEY, MULTI_TENANT } from "../constants.js";
import { decrypt, encrypt, isEncrypted } from "./crypto.js";
import { db } from "./db.js";
import { keychainDelete, keychainGet, keychainSet } from "./keychain.js";

/*
 * Secret storage for email credentials.
 *  - macOS single-tenant: macOS Keychain (most secure for local dev).
 *  - everything else (Linux / Docker / multi-tenant): SQLite `secrets` table,
 *    values encrypted at rest with AES-256-GCM (master key from env).
 */

function shouldUseKeychain(): boolean {
  // macOS Keychain is for the local single-user setup only. A multi-tenant
  // server holds many users' secrets and must use the encrypted DB store
  // (the login Keychain is single-user and unavailable on Linux anyway).
  return os.platform() === "darwin" && !MULTI_TENANT;
}

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
  if (shouldUseKeychain()) {
    try {
      return await keychainGet(key);
    } catch {
      // Fall back to DB store if keychain isn't available in this runtime.
    }
  }
  const stored = dbGet(key);
  if (stored == null) return null;
  return decodeStored(stored, key);
}

// Decode a stored value: decrypt if it's an encrypted token, else return the
// plaintext as-is (backward compatible with pre-encryption rows).
function decodeStored(stored: string, key: string): string | null {
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
  if (shouldUseKeychain()) {
    try {
      await keychainSet(key, value);
      return;
    } catch {
      // Fall back to DB store if keychain isn't available in this runtime.
    }
  }
  // Encrypt at rest when a master key is configured; otherwise store plaintext
  // (local dev convenience — startup prints a warning in that case).
  dbSet(key, MASTER_KEY ? encrypt(value, MASTER_KEY) : value);
}

export async function secretDelete(key: string): Promise<void> {
  if (shouldUseKeychain()) {
    try {
      await keychainDelete(key);
      return;
    } catch {
      // Fall back to DB store if keychain isn't available in this runtime.
    }
  }
  dbDelete(key);
}

// One-time upgrade: when a master key is configured and the DB holds legacy
// plaintext values, re-encrypt them in place. Safe to call on every startup —
// only writes rows that actually change. No-op on the Keychain path / no key.
export async function migratePlaintextSecrets(): Promise<void> {
  if (shouldUseKeychain() || !MASTER_KEY) return;

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
