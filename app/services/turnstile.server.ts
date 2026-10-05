export interface TurnstileVerificationResult {
  success: boolean;
  errorCodes?: string[];
  hostname?: string;
  action?: string;
}

/**
 * Cloudflare Turnstile Server-Side Verification
 * Verifies the turnstile token against challenges.cloudflare.com/turnstile/v0/siteverify.
 * Fails closed if verification fails or the service is unreachable.
 */
export async function verifyTurnstileToken(params: {
  token: string;
  remoteIp?: string | null;
  secretKey?: string;
}): Promise<TurnstileVerificationResult> {
  if (!params.token || typeof params.token !== "string" || params.token.trim() === "") {
    return { success: false, errorCodes: ["missing-input-response"] };
  }

  const secret = params.secretKey || process.env.TURNSTILE_SECRET_KEY;

  // In test or local dev without a configured key, allow Cloudflare test key or mock bypass
  if (!secret) {
    if (process.env.NODE_ENV === "test") {
      // In test mode without explicit secret, pass unless test dummy "fail" token provided
      if (params.token === "invalid_turnstile_token" || params.token === "always_fail_token") {
        return { success: false, errorCodes: ["invalid-input-response"] };
      }
      return { success: true };
    }
    // Fail closed in production if secret is missing
    console.error("[turnstile] Missing TURNSTILE_SECRET_KEY; failing closed.");
    return { success: false, errorCodes: ["missing-secret-key"] };
  }

  // Cloudflare official dummy test keys support:
  // Secret: 1x0000000000000000000000000000000AA -> always passes
  // Secret: 2x0000000000000000000000000000000AB -> always blocks
  if (secret === "1x0000000000000000000000000000000AA") {
    if (params.token === "fail_token" || params.token === "invalid_turnstile_token") {
      return { success: false, errorCodes: ["invalid-input-response"] };
    }
    return { success: true, hostname: "test.local" };
  }
  if (secret === "2x0000000000000000000000000000000AB") {
    return { success: false, errorCodes: ["invalid-input-response"] };
  }

  try {
    const formData = new URLSearchParams();
    formData.append("secret", secret);
    formData.append("response", params.token);
    if (params.remoteIp) {
      formData.append("remoteip", params.remoteIp);
    }

    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: formData,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      signal: AbortSignal.timeout(5000), // 5 second timeout
    });

    if (!response.ok) {
      console.error(`[turnstile] Siteverify returned HTTP ${response.status}`);
      return { success: false, errorCodes: [`http-${response.status}`] };
    }

    const outcome = (await response.json()) as {
      success: boolean;
      "error-codes"?: string[];
      hostname?: string;
      action?: string;
    };

    return {
      success: outcome.success === true,
      errorCodes: outcome["error-codes"],
      hostname: outcome.hostname,
      action: outcome.action,
    };
  } catch (err) {
    // Fail closed if network error or timeout
    console.error("[turnstile] Verification service unreachable:", err);
    return { success: false, errorCodes: ["service-unreachable"] };
  }
}
