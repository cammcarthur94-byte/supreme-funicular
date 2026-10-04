import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit recommended for GCM
const TAG_LENGTH = 16; // 128-bit authentication tag
const KEY_LENGTH = 32; // 256-bit key

/**
 * Derives a 32-byte Buffer key from a string or Buffer.
 * Supports base64 or raw 32-byte strings.
 */
function normalizeKey(keyInput?: string | Buffer): Buffer {
  if (Buffer.isBuffer(keyInput)) {
    if (keyInput.length !== KEY_LENGTH) {
      throw new Error(`Invalid encryption key length: expected ${KEY_LENGTH} bytes, got ${keyInput.length}`);
    }
    return keyInput;
  }

  const envKey = keyInput || process.env.ENCRYPTION_MASTER_KEY;
  if (!envKey) {
    throw new Error(
      "Missing encryption key. Provide a key or configure ENCRYPTION_MASTER_KEY in environment variables."
    );
  }

  // Attempt base64 decoding first
  try {
    const fromBase64 = Buffer.from(envKey, "base64");
    if (fromBase64.length === KEY_LENGTH) {
      return fromBase64;
    }
  } catch {
    // Continue to utf-8 check
  }

  const fromUtf8 = Buffer.from(envKey, "utf-8");
  if (fromUtf8.length === KEY_LENGTH) {
    return fromUtf8;
  }

  // If neither, derive a deterministic 32-byte key via SHA-256
  return crypto.createHash("sha256").update(envKey).digest();
}

/**
 * Encrypts plaintext using AES-256-GCM with a freshly generated CSPRNG IV.
 * Returns payload in the format: "ivHex:tagHex:cipherHex"
 */
export function encrypt(plaintext: string, keyInput?: string | Buffer): string {
  const key = normalizeKey(keyInput);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: TAG_LENGTH,
  });

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");

  const tag = cipher.getAuthTag();

  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted}`;
}

/**
 * Decrypts an AES-256-GCM payload in format "ivHex:tagHex:cipherHex".
 * Validates the authentication tag and throws if ciphertext was altered.
 */
export function decrypt(payload: string, keyInput?: string | Buffer): string {
  const key = normalizeKey(keyInput);
  const parts = payload.split(":");

  if (parts.length !== 3) {
    throw new Error("Invalid encrypted payload format. Expected 'iv:tag:ciphertext'.");
  }

  const [ivHex, tagHex, cipherHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");

  if (iv.length !== IV_LENGTH) {
    throw new Error(`Invalid IV length: expected ${IV_LENGTH} bytes.`);
  }

  if (tag.length !== TAG_LENGTH) {
    throw new Error(`Invalid authentication tag length: expected ${TAG_LENGTH} bytes.`);
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: TAG_LENGTH,
  });

  decipher.setAuthTag(tag);

  let decrypted = decipher.update(cipherHex, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

/**
 * Generates a fresh 256-bit random key for per-draw crypto-shredding.
 * Returns the raw key (base64) and the master-key-encrypted wrapped key.
 */
export function generateDrawKey(masterKeyInput?: string | Buffer): {
  rawKey: string;
  encryptedKey: string;
} {
  const randomKeyBuffer = crypto.randomBytes(KEY_LENGTH);
  const rawKey = randomKeyBuffer.toString("base64");
  const encryptedKey = encrypt(rawKey, masterKeyInput);

  return { rawKey, encryptedKey };
}

/**
 * Computes a SHA-256 hex hash of a string (for normalized emails, claim tokens, device signals).
 */
export function hashIdentifier(value: string): string {
  return crypto.createHash("sha256").update(value.trim()).digest("hex");
}
