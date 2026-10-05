import { describe, it, expect, beforeEach } from "vitest";
import crypto from "node:crypto";
import {
  encrypt,
  decrypt,
  generateDrawKey,
  hashIdentifier,
} from "../app/services/encryption";

describe("Encryption Service (AES-256-GCM)", () => {
  const testMasterKey = crypto.randomBytes(32).toString("base64");

  beforeEach(() => {
    process.env.ENCRYPTION_MASTER_KEY = testMasterKey;
  });

  it("successfully performs round-trip encryption and decryption", () => {
    const secretMessage = "customer@example.com";
    const encrypted = encrypt(secretMessage);

    expect(encrypted).not.toBe(secretMessage);
    expect(encrypted.split(":")).toHaveLength(3);

    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(secretMessage);
  });

  it("generates different ciphertexts for the same plaintext due to random IV", () => {
    const plaintext = "shpat_abc123secrettoken";
    const enc1 = encrypt(plaintext);
    const enc2 = encrypt(plaintext);

    expect(enc1).not.toBe(enc2);
    expect(decrypt(enc1)).toBe(plaintext);
    expect(decrypt(enc2)).toBe(plaintext);
  });

  it("supports explicit custom key buffers and strings", () => {
    const customKey = crypto.randomBytes(32);
    const plaintext = "sensitive-offline-token";

    const encrypted = encrypt(plaintext, customKey);
    const decrypted = decrypt(encrypted, customKey);

    expect(decrypted).toBe(plaintext);
  });

  it("fails decryption when ciphertext is tampered with", () => {
    const plaintext = "original data";
    const encrypted = encrypt(plaintext);
    const [iv, tag, cipher] = encrypted.split(":");

    // Flip bits in cipher
    const tamperedCipher =
      cipher.slice(0, -2) + (cipher.slice(-2) === "aa" ? "bb" : "aa");
    const tamperedPayload = `${iv}:${tag}:${tamperedCipher}`;

    expect(() => decrypt(tamperedPayload)).toThrow();
  });

  it("fails decryption when authentication tag is tampered with", () => {
    const plaintext = "original data";
    const encrypted = encrypt(plaintext);
    const [iv, tag, cipher] = encrypted.split(":");

    const tamperedTag =
      tag.slice(0, -2) + (tag.slice(-2) === "00" ? "ff" : "00");
    const tamperedPayload = `${iv}:${tamperedTag}:${cipher}`;

    expect(() => decrypt(tamperedPayload)).toThrow();
  });

  it("fails decryption when an incorrect key is provided", () => {
    const plaintext = "top secret";
    const keyA = crypto.randomBytes(32);
    const keyB = crypto.randomBytes(32);

    const encrypted = encrypt(plaintext, keyA);
    expect(() => decrypt(encrypted, keyB)).toThrow();
  });

  it("supports per-draw crypto-shredding keys with wrapped key round-trip", () => {
    const { rawKey, encryptedKey } = generateDrawKey();

    // Verify rawKey can be recovered by decrypting encryptedKey with master key
    const decryptedKey = decrypt(encryptedKey);
    expect(decryptedKey).toBe(rawKey);

    // Verify rawKey works for encrypting and decrypting draw entries
    const customerEmail = "winner@shopify.com";
    const entryEncrypted = encrypt(customerEmail, rawKey);
    const entryDecrypted = decrypt(entryEncrypted, rawKey);
    expect(entryDecrypted).toBe(customerEmail);
  });

  it("computes deterministic SHA-256 identifier hashes", () => {
    const email = "user@test.com";
    const hash1 = hashIdentifier(email);
    const hash2 = hashIdentifier("  user@test.com  "); // with trimming

    expect(hash1).toHaveLength(64);
    expect(hash1).toBe(hash2);
    expect(hashIdentifier("other@test.com")).not.toBe(hash1);
  });

  it("falls back to SHOPIFY_API_SECRET if ENCRYPTION_MASTER_KEY is missing", () => {
    delete process.env.ENCRYPTION_MASTER_KEY;
    process.env.SHOPIFY_API_SECRET = "test-api-secret-12345";

    const plaintext = "fallback-test-message";
    const encrypted = encrypt(plaintext);
    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(plaintext);
  });
});
