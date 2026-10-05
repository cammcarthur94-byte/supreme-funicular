import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueFormToken, validateFormToken, resetConsumedFormTokens } from "../app/services/formToken.server";
import { verifyTurnstileToken } from "../app/services/turnstile.server";
import { checkEntryRateLimit, resetRateLimits } from "../app/services/rateLimiter.server";
import { calculateRiskScore } from "../app/services/riskScore";

describe("Phase 7: Anti-bot and fraud controls", () => {
  const drawId = "test-draw-123";
  const customerId = "cust-456";

  beforeEach(() => {
    resetConsumedFormTokens();
    resetRateLimits();
    vi.restoreAllMocks();
  });

  describe("Signed Short-Lived Form Token", () => {
    it("validates a legitimate token after minimum fill time", () => {
      // Issued 4 seconds ago
      const token = issueFormToken({
        drawId,
        customerId,
        issuedAt: Date.now() - 4000,
        minSubmitSeconds: 3,
      });

      const result = validateFormToken({ rawToken: token, drawId, customerId, minSubmitSeconds: 3 });
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.fillTimeMs).toBeGreaterThanOrEqual(4000);
      }
    });

    it("rejects a replayed token (token reuse)", () => {
      const token = issueFormToken({
        drawId,
        customerId,
        issuedAt: Date.now() - 5000,
      });

      const firstValidation = validateFormToken({ rawToken: token, drawId, customerId });
      expect(firstValidation.valid).toBe(true);

      const replayValidation = validateFormToken({ rawToken: token, drawId, customerId });
      expect(replayValidation.valid).toBe(false);
      if (!replayValidation.valid) {
        expect(replayValidation.reason).toBe("REUSED");
        expect(replayValidation.message).toContain("already been used");
      }
    });

    it("rejects submissions that are too fast (< minimum fill time)", () => {
      // Issued 1 second ago (minimum is 3 seconds)
      const token = issueFormToken({
        drawId,
        customerId,
        issuedAt: Date.now() - 1000,
        minSubmitSeconds: 3,
      });

      const result = validateFormToken({ rawToken: token, drawId, customerId, minSubmitSeconds: 3 });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("TOO_FAST");
        expect(result.message).toContain("suspiciously fast");
      }
    });

    it("rejects expired tokens (> 30 minutes)", () => {
      // Issued 31 minutes ago
      const token = issueFormToken({
        drawId,
        customerId,
        issuedAt: Date.now() - 31 * 60 * 1000,
      });

      const result = validateFormToken({ rawToken: token, drawId, customerId, maxAgeMinutes: 30 });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("EXPIRED");
        expect(result.message).toContain("expired");
      }
    });

    it("rejects tokens with mismatched drawId or customerId", () => {
      const token = issueFormToken({
        drawId,
        customerId,
        issuedAt: Date.now() - 4000,
      });

      const badCustomer = validateFormToken({ rawToken: token, drawId, customerId: "other-customer" });
      expect(badCustomer.valid).toBe(false);
      if (!badCustomer.valid) {
        expect(badCustomer.reason).toBe("MISMATCH");
      }

      const badDraw = validateFormToken({ rawToken: token, drawId: "other-draw", customerId });
      expect(badDraw.valid).toBe(false);
      if (!badDraw.valid) {
        expect(badDraw.reason).toBe("MISMATCH");
      }
    });

    it("rejects tampered signatures", () => {
      const token = issueFormToken({ drawId, customerId, issuedAt: Date.now() - 4000 });
      const [payload, sig] = token.split(".");
      const tampered = `${payload}.${sig.slice(0, -4)}abcd`;

      const result = validateFormToken({ rawToken: tampered, drawId, customerId });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("INVALID_SIGNATURE");
      }
    });
  });

  describe("Cloudflare Turnstile Verification", () => {
    it("accepts valid official test token in test mode", async () => {
      const result = await verifyTurnstileToken({
        token: "test_valid_turnstile_token",
        remoteIp: "127.0.0.1",
      });
      expect(result.success).toBe(true);
    });

    it("rejects empty token", async () => {
      const result = await verifyTurnstileToken({
        token: "",
        remoteIp: "127.0.0.1",
      });
      expect(result.success).toBe(false);
      expect(result.errorCodes).toContain("missing-input-response");
    });

    it("rejects explicit failure test token", async () => {
      const result = await verifyTurnstileToken({
        token: "invalid_turnstile_token",
        remoteIp: "127.0.0.1",
      });
      expect(result.success).toBe(false);
      expect(result.errorCodes).toContain("invalid-input-response");
    });

    it("fails closed when verification network call fails", async () => {
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockRejectedValue(new Error("Network timeout or unreachable"));

      const result = await verifyTurnstileToken({
        token: "real_token_attempt",
        remoteIp: "127.0.0.1",
        secretKey: "real_secret_triggers_network_call",
      });

      expect(result.success).toBe(false);
      expect(result.errorCodes).toContain("service-unreachable");

      global.fetch = originalFetch;
    });
  });

  describe("Rate Limiting (Sliding Window)", () => {
    it("allows requests under the rate limit", async () => {
      const result = await checkEntryRateLimit({
        ip: "192.168.1.1",
        customerId: "cust-rate-1",
        drawId: "draw-rate-1",
      });
      expect(result.success).toBe(true);
    });

    it("triggers 429 when per-customer rate limit is exceeded", async () => {
      const cId = "cust-spammer";
      for (let i = 0; i < 5; i++) {
        const res = await checkEntryRateLimit({
          ip: `192.168.1.${i + 10}`,
          customerId: cId,
          drawId: "draw-many",
        });
        expect(res.success).toBe(true);
      }

      // 6th attempt should trigger rate limit (max 5 per minute)
      const blocked = await checkEntryRateLimit({
        ip: "192.168.1.99",
        customerId: cId,
        drawId: "draw-many",
      });
      expect(blocked.success).toBe(false);
      expect(blocked.dimension).toBe("customer");
    });

    it("triggers 429 when per-IP rate limit is exceeded", async () => {
      const targetIp = "203.0.113.42";
      for (let i = 0; i < 10; i++) {
        const res = await checkEntryRateLimit({
          ip: targetIp,
          customerId: `customer-${i}`,
          drawId: "draw-ip-test",
        });
        expect(res.success).toBe(true);
      }

      // 11th attempt from same IP triggers rate limit (max 10 per minute)
      const blocked = await checkEntryRateLimit({
        ip: targetIp,
        customerId: "customer-new",
        drawId: "draw-ip-test",
      });
      expect(blocked.success).toBe(false);
      expect(blocked.dimension).toBe("ip");
    });
  });

  describe("Risk Scoring Engine (riskScore.ts)", () => {
    it("scores clean entry as 0 and VALID", () => {
      const result = calculateRiskScore({
        fingerprintCountInDraw: 0,
        ipCountInDraw: 0,
        isDatacenterOrVpn: false,
        isDisposableEmail: false,
        accountAgeHours: 500,
        submitDurationSeconds: 12,
        geoCountryMismatch: false,
        addressReuseCountInDraw: 0,
      });

      expect(result.score).toBe(0);
      expect(result.flags).toHaveLength(0);
      expect(result.status).toBe("VALID");
    });

    it("flags disposable email domains", () => {
      const result = calculateRiskScore({
        isDisposableEmail: true,
        accountAgeHours: 500,
        submitDurationSeconds: 10,
        fingerprintCountInDraw: 0,
        ipCountInDraw: 0,
      });

      expect(result.flags).toContain("DISPOSABLE_EMAIL");
      expect(result.score).toBeGreaterThanOrEqual(50);
    });

    it("flags geo mismatch between IP country and shipping country", () => {
      const result = calculateRiskScore({
        geoCountryMismatch: true,
        accountAgeHours: 500,
        submitDurationSeconds: 8,
        fingerprintCountInDraw: 0,
        ipCountInDraw: 0,
      });

      expect(result.flags).toContain("GEO_IP_MISMATCH");
      expect(result.score).toBeGreaterThanOrEqual(20);
    });

    it("flags shared device fingerprint above threshold", () => {
      const result = calculateRiskScore({
        fingerprintCountInDraw: 1, // Threshold is 1 (reused)
        ipCountInDraw: 0,
        accountAgeHours: 500,
        submitDurationSeconds: 8,
      });

      expect(result.flags).toContain("FINGERPRINT_REUSE");
      expect(result.score).toBeGreaterThanOrEqual(45);
    });

    it("assigns FLAGGED status when score is between flagScore (40) and rejectScore (80)", () => {
      // Fingerprint reuse (45) alone or geo (20) + new account (25) = 45 -> FLAGGED
      const result = calculateRiskScore({
        geoCountryMismatch: true, // 20
        accountAgeHours: 12, // 25 (new account)
        submitDurationSeconds: 6,
        fingerprintCountInDraw: 0,
        ipCountInDraw: 0,
      });

      expect(result.score).toBe(45);
      expect(result.score).toBeGreaterThanOrEqual(40);
      expect(result.score).toBeLessThan(80);
      expect(result.status).toBe("FLAGGED");
    });

    it("assigns REJECTED status when score exceeds rejectScore (80)", () => {
      // Fingerprint reuse (45) + Datacenter IP (40) = 85 -> REJECTED
      const result = calculateRiskScore({
        fingerprintCountInDraw: 2,
        isDatacenterOrVpn: true,
        accountAgeHours: 100,
        submitDurationSeconds: 10,
      });

      expect(result.score).toBeGreaterThanOrEqual(80);
      expect(result.status).toBe("REJECTED");
    });

    it("respects custom per-draw risk thresholds", () => {
      // Moderate risk (score 45) with custom strict threshold (flagScore 30, rejectScore 40)
      const customRules = {
        flagScore: 30,
        rejectScore: 40,
      };

      const result = calculateRiskScore(
        {
          fingerprintCountInDraw: 1, // 45
        },
        customRules
      );

      expect(result.score).toBe(45);
      expect(result.status).toBe("REJECTED"); // 45 >= custom rejectScore 40
    });

    it("does not hard-block on IP alone (evaluates as weighted signal)", () => {
      // Shared household or university IP (e.g., 6 entries) but otherwise completely legitimate
      const result = calculateRiskScore({
        ipCountInDraw: 6, // Above default IP threshold of 5 (adds 25)
        fingerprintCountInDraw: 0,
        accountAgeHours: 500,
        submitDurationSeconds: 15,
        geoCountryMismatch: false,
        isDatacenterOrVpn: false,
      });

      expect(result.score).toBe(25);
      expect(result.status).toBe("VALID"); // 25 is below default flagScore 40
      expect(result.flags).toContain("IP_REUSE");
    });
  });

  describe("Acceptance: Bot attack mitigation vs normal user flow", () => {
    it("blocks a scripted bot hitting repeatedly with 429 rate limit", async () => {
      const botIp = "45.33.32.156";
      const botCustomer = "bot-account-999";
      const targetDraw = "draw-popular-drop";

      let blocked = false;
      let blockedAttempt = -1;

      for (let attempt = 1; attempt <= 15; attempt++) {
        const rateCheck = await checkEntryRateLimit({
          ip: botIp,
          customerId: botCustomer,
          drawId: targetDraw,
        });

        if (!rateCheck.success) {
          blocked = true;
          blockedAttempt = attempt;
          break;
        }
      }

      expect(blocked).toBe(true);
      expect(blockedAttempt).toBeLessThanOrEqual(6); // Customer limit is 5
    });

    it("accepts a normal user flow through all anti-bot layers", async () => {
      const userIp = "198.51.100.25";
      const userCustomer = "legit-customer-001";
      const legitDraw = "draw-popular-drop";

      // 1. Rate limiter passes
      const rateCheck = await checkEntryRateLimit({
        ip: userIp,
        customerId: userCustomer,
        drawId: legitDraw,
      });
      expect(rateCheck.success).toBe(true);

      // 2. Form token generated on load and submitted after normal fill time (6s)
      const token = issueFormToken({
        drawId: legitDraw,
        customerId: userCustomer,
        issuedAt: Date.now() - 6000,
      });

      const tokenCheck = validateFormToken({
        rawToken: token,
        drawId: legitDraw,
        customerId: userCustomer,
      });
      expect(tokenCheck.valid).toBe(true);

      // 3. Turnstile check passes
      const turnstileCheck = await verifyTurnstileToken({
        token: "test_valid_turnstile_token",
        remoteIp: userIp,
      });
      expect(turnstileCheck.success).toBe(true);

      // 4. Risk score evaluates as VALID
      const risk = calculateRiskScore({
        fingerprintCountInDraw: 0,
        ipCountInDraw: 0,
        accountAgeHours: 720,
        submitDurationSeconds: 6,
        geoCountryMismatch: false,
        isDatacenterOrVpn: false,
        isDisposableEmail: false,
      });
      expect(risk.status).toBe("VALID");
      expect(risk.action).toBe("ACCEPT");
    });
  });
});
