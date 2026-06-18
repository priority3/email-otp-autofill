import crypto from "node:crypto";

/*
 * Authenticated encryption for at-rest secrets (email auth codes / app
 * passwords) when the file store is used (non-macOS / Docker). The master key
 * comes from the OTP_AGENT_MASTER_KEY env var and is NEVER written to disk, so
 * a leaked secrets.json is useless without it.
 *
 * Token format (string):  v1:base64( salt[16] | iv[12] | authTag[16] | ciphertext )
 *   - per-secret random salt → scrypt key derivation (not the raw master key)
 *   - per-secret random 12-byte IV (GCM standard)
 *   - 16-byte GCM auth tag → tamper detection on decrypt
 */

const VERSION = "v1";
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32; // AES-256

// scrypt is CPU-hard; defaults are fine for the small number of secrets here.
function deriveKey(masterKey: string, salt: Buffer): Buffer {
  return crypto.scryptSync(masterKey, salt, KEY_LEN);
}

// True if a stored value is one of our encrypted tokens.
export function isEncrypted(value: string): boolean {
  return typeof value === "string" && value.startsWith(`${VERSION}:`);
}

export function encrypt(plaintext: string, masterKey: string): string {
  if (!masterKey) throw new Error("master_key_required");
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = deriveKey(masterKey, salt);

  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const packed = Buffer.concat([salt, iv, authTag, ciphertext]);
  return `${VERSION}:${packed.toString("base64")}`;
}

export function decrypt(token: string, masterKey: string): string {
  if (!masterKey) throw new Error("master_key_required");
  if (!isEncrypted(token)) throw new Error("not_encrypted");

  const packed = Buffer.from(token.slice(VERSION.length + 1), "base64");
  if (packed.length < SALT_LEN + IV_LEN + TAG_LEN) throw new Error("ciphertext_too_short");

  const salt = packed.subarray(0, SALT_LEN);
  const iv = packed.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const authTag = packed.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN);
  const ciphertext = packed.subarray(SALT_LEN + IV_LEN + TAG_LEN);

  const key = deriveKey(masterKey, salt);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  // .final() throws if the auth tag does not match (wrong key or tampering).
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
