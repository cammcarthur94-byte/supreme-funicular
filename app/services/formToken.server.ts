import crypto from "node:crypto";

export interface FormTokenPayload {
  drawId: string;
  customerId: string;
  issuedAt: number;
  nonce: string;
}

export type FormTokenValidationResult =
  | { valid: true; payload: FormTokenPayload; fillTimeMs: number }
  | { valid: false; reason: "MISSING" | "EXPIRED" | "TOO_FAST" | "REUSED" | "INVALID_SIGNATURE" | "MISMATCH"; message: string };

const CONSUMED_NONCES = new Map<string, number>();

export function resetConsumedFormTokens() {
  CONSUMED_NONCES.clear();
}

/**
 * Periodically purge expired nonces older than 35 minutes to prevent unbounded memory growth.
 */
function cleanupConsumedNonces(now: number) {
  const maxAgeMs = 35 * 60 * 1000;
  for (const [nonce, timestamp] of CONSUMED_NONCES.entries()) {
    if (now - timestamp > maxAgeMs) {
      CONSUMED_NONCES.delete(nonce);
    }
  }
}

/**
 * Generates an HMAC-signed, tamper-proof form token with a unique nonce and timestamp.
 */
export function issueFormToken(params: {
  drawId: string;
  customerId: string;
  now?: number;
  issuedAt?: number;
  secret?: string;
  minSubmitSeconds?: number;
}): string {
  const secret = params.secret || process.env.SHOPIFY_API_SECRET || "default_form_secret";
  const issuedAt = params.issuedAt ?? params.now ?? Date.now();
  const nonce = crypto.randomBytes(16).toString("hex");

  const payload: FormTokenPayload = {
    drawId: params.drawId,
    customerId: params.customerId,
    issuedAt,
    nonce,
  };

  const serialized = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(serialized).digest("base64url");
  return `${serialized}.${signature}`;
}

/**
 * Validates a form token on submission:
 * - Checks HMAC signature integrity
 * - Checks drawId and customerId match
 * - Enforces minimum fill time (e.g. >= 3,000ms)
 * - Enforces maximum expiration window (<= 30 minutes)
 * - Enforces single-use replay protection
 */
export function validateFormToken(params: {
  rawToken?: string | null;
  drawId: string;
  customerId: string;
  now?: number;
  secret?: string;
  minFillTimeMs?: number;
  minSubmitSeconds?: number;
  maxAgeMs?: number;
  maxAgeMinutes?: number;
}): FormTokenValidationResult {
  const now = params.now ?? Date.now();
  cleanupConsumedNonces(now);

  if (!params.rawToken || typeof params.rawToken !== "string") {
    return { valid: false, reason: "MISSING", message: "Form token is missing. Please refresh and try again." };
  }

  const parts = params.rawToken.split(".");
  if (parts.length !== 2) {
    return { valid: false, reason: "INVALID_SIGNATURE", message: "Invalid form token structure." };
  }

  const [serialized, providedSig] = parts;
  const secret = params.secret || process.env.SHOPIFY_API_SECRET || "default_form_secret";
  const expectedSig = crypto.createHmac("sha256", secret).update(serialized).digest("base64url");

  const providedBuf = Buffer.from(providedSig);
  const expectedBuf = Buffer.from(expectedSig);
  if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
    return { valid: false, reason: "INVALID_SIGNATURE", message: "Form token signature verification failed." };
  }

  let payload: FormTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(serialized, "base64url").toString("utf-8")) as FormTokenPayload;
  } catch {
    return { valid: false, reason: "INVALID_SIGNATURE", message: "Malformed form token payload." };
  }

  if (payload.drawId !== params.drawId || payload.customerId !== params.customerId) {
    return { valid: false, reason: "MISMATCH", message: "Form token does not match the active draw or customer account." };
  }

  const maxAge = params.maxAgeMs ?? (params.maxAgeMinutes ? params.maxAgeMinutes * 60 * 1000 : 30 * 60 * 1000); // 30 minutes
  if (now - payload.issuedAt > maxAge) {
    return { valid: false, reason: "EXPIRED", message: "Form session expired. Please refresh the page to try again." };
  }

  const minFillTime = params.minFillTimeMs ?? (params.minSubmitSeconds ? params.minSubmitSeconds * 1000 : 3000); // 3 seconds
  const fillTimeMs = now - payload.issuedAt;
  if (fillTimeMs < minFillTime) {
    return { valid: false, reason: "TOO_FAST", message: "Submission completed suspiciously fast. Please take your time." };
  }

  if (CONSUMED_NONCES.has(payload.nonce)) {
    return { valid: false, reason: "REUSED", message: "This form token has already been used. Please refresh the page." };
  }

  CONSUMED_NONCES.set(payload.nonce, now);
  return { valid: true, payload, fillTimeMs };
}
