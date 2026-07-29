import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encrypt, decrypt, isEncrypted } from "../../src/storage/crypto.js";

const KEY = "unit-test-master-key";

describe("crypto encrypt/decrypt", () => {
  it("round-trips a secret", () => {
    const token = encrypt("qq-auth-code-123", KEY);
    assert.equal(decrypt(token, KEY), "qq-auth-code-123");
  });

  it("round-trips unicode and empty-ish plaintexts", () => {
    for (const plain of ["密码🔑", " ", "a"]) {
      assert.equal(decrypt(encrypt(plain, KEY), KEY), plain);
    }
  });

  it("produces a v1-prefixed token recognised by isEncrypted", () => {
    const token = encrypt("secret", KEY);
    assert.ok(token.startsWith("v1:"));
    assert.equal(isEncrypted(token), true);
    assert.equal(isEncrypted("plaintext-value"), false);
  });

  it("uses random salt/iv so equal plaintexts encrypt differently", () => {
    assert.notEqual(encrypt("same", KEY), encrypt("same", KEY));
  });

  it("rejects decryption with the wrong master key", () => {
    const token = encrypt("secret", KEY);
    assert.throws(() => decrypt(token, "another-key"));
  });

  it("rejects tampered ciphertext (GCM auth tag)", () => {
    const token = encrypt("secret", KEY);
    const packed = Buffer.from(token.slice("v1:".length), "base64");
    // Flip one bit in the last byte (inside the ciphertext section).
    packed[packed.length - 1] = packed[packed.length - 1]! ^ 0x01;
    const tampered = `v1:${packed.toString("base64")}`;
    assert.throws(() => decrypt(tampered, KEY));
  });

  it("requires a master key on both sides", () => {
    assert.throws(() => encrypt("secret", ""), /master_key_required/);
    assert.throws(() => decrypt("v1:abcd", ""), /master_key_required/);
  });

  it("rejects values that are not our token format", () => {
    assert.throws(() => decrypt("plaintext-value", KEY), /not_encrypted/);
  });

  it("rejects truncated tokens", () => {
    const short = `v1:${Buffer.alloc(8).toString("base64")}`;
    assert.throws(() => decrypt(short, KEY), /ciphertext_too_short/);
  });
});
