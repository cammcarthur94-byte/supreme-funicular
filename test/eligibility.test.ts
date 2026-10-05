import { describe, it, expect } from "vitest";
import {
  normalizeEmail,
  hashNormalizedEmail,
  isDisposableEmail,
  evaluateEligibility,
  type EligibilityCustomer,
  type EligibilityRequestContext,
} from "../app/services/eligibility";
import type { EligibilityRules } from "../app/validation/drawValidation";

describe("Eligibility Module", () => {
  describe("Email Normalization & Hashing", () => {
    const normalizationTestCases = [
      {
        description: "lowercases uppercase email",
        input: "USER@EXAMPLE.COM",
        expected: "user@example.com",
      },
      {
        description: "trims leading and trailing whitespace",
        input: "  user@example.com  ",
        expected: "user@example.com",
      },
      {
        description: "strips plus tags for generic provider",
        input: "user+raffle2026@outlook.com",
        expected: "user@outlook.com",
      },
      {
        description: "removes dots for Gmail accounts",
        input: "j.o.h.n.d.o.e@gmail.com",
        expected: "johndoe@gmail.com",
      },
      {
        description: "removes dots AND strips plus tag for Gmail accounts",
        input: "John.Doe+drop123@gmail.com",
        expected: "johndoe@gmail.com",
      },
      {
        description: "normalizes googlemail.com to gmail.com and strips dots and tags",
        input: "J.O.H.N+hype@googlemail.com",
        expected: "john@gmail.com",
      },
      {
        description: "preserves dots for non-Gmail domains while stripping plus tag",
        input: "first.last+entry@customdomain.org",
        expected: "first.last@customdomain.org",
      },
      {
        description: "handles multiple plus signs in local part",
        input: "user+drop+extra@example.com",
        expected: "user@example.com",
      },
    ];

    normalizationTestCases.forEach(({ description, input, expected }) => {
      it(description, () => {
        expect(normalizeEmail(input)).toBe(expected);
      });
    });

    it("generates identical hashes for dot and plus variants of the same Gmail inbox", () => {
      const canonical = "sneakerhead@gmail.com";
      const variant1 = "sneaker.head@gmail.com";
      const variant2 = "s.n.e.a.k.e.r.h.e.a.d+drop2026@gmail.com";
      const variant3 = "SneakerHead+win@googlemail.com";

      const canonicalHash = hashNormalizedEmail(canonical);
      expect(hashNormalizedEmail(variant1)).toBe(canonicalHash);
      expect(hashNormalizedEmail(variant2)).toBe(canonicalHash);
      expect(hashNormalizedEmail(variant3)).toBe(canonicalHash);
    });
  });

  describe("Disposable Email Detection", () => {
    const blockedEmails = [
      "user@mailinator.com",
      "test@guerrillamail.com",
      "hacker@sharklasers.com",
      "bot@tempmail.com",
      "entry@10minutemail.com",
      "throwaway@trashmail.com",
      "anon@yopmail.com",
      "sub@subdomain.mailinator.com",
    ];

    blockedEmails.forEach((email) => {
      it(`flags disposable domain for ${email}`, () => {
        expect(isDisposableEmail(email)).toBe(true);
      });
    });

    const allowedEmails = [
      "customer@gmail.com",
      "shopper@outlook.com",
      "collector@yahoo.com",
      "buyer@icloud.com",
      "support@shopify.com",
      "user@mycustomcompany.ca",
    ];

    allowedEmails.forEach((email) => {
      it(`permits legitimate email domain for ${email}`, () => {
        expect(isDisposableEmail(email)).toBe(false);
      });
    });
  });

  describe("Table-Driven Eligibility Rule Evaluation", () => {
    const now = new Date("2026-10-04T12:00:00.000Z");
    const baselineCustomer: EligibilityCustomer = {
      customerId: "gid://shopify/Customer/123456",
      email: "valid.customer@gmail.com",
      verifiedEmail: true,
      createdAt: new Date("2026-09-01T00:00:00.000Z"), // ~33 days old
      countryCode: "CA",
      phone: "+15551234567",
    };

    const baselineRules: EligibilityRules = {
      requireAccount: true,
      requireVerifiedEmail: true,
      allowedCountries: ["CA", "US"],
      minAccountAgeDays: 7,
      requirePhone: true,
    };

    const baselineContext: EligibilityRequestContext = {
      now,
      clientIp: "24.114.50.1",
      geoCountry: "CA",
    };

    interface TestCase {
      name: string;
      rules: Partial<EligibilityRules>;
      customer: Partial<EligibilityCustomer> | null;
      context?: Partial<EligibilityRequestContext>;
      expectedEligible: boolean;
      expectedReasonCode: string;
      expectedGeoIpMismatch?: boolean;
    }

    const testCases: TestCase[] = [
      {
        name: "fully compliant customer passes all checks",
        rules: baselineRules,
        customer: baselineCustomer,
        expectedEligible: true,
        expectedReasonCode: "ELIGIBLE",
      },
      {
        name: "rejects anonymous entry when requireAccount is true",
        rules: { ...baselineRules, requireAccount: true },
        customer: { ...baselineCustomer, customerId: null },
        expectedEligible: false,
        expectedReasonCode: "ACCOUNT_REQUIRED",
      },
      {
        name: "rejects missing customer object when requireAccount is true",
        rules: { ...baselineRules, requireAccount: true },
        customer: null,
        expectedEligible: false,
        expectedReasonCode: "ACCOUNT_REQUIRED",
      },
      {
        name: "rejects invalid or missing email",
        rules: baselineRules,
        customer: { ...baselineCustomer, email: "not-an-email" },
        expectedEligible: false,
        expectedReasonCode: "INVALID_EMAIL",
      },
      {
        name: "rejects disposable email address",
        rules: baselineRules,
        customer: { ...baselineCustomer, email: "bot123@mailinator.com" },
        expectedEligible: false,
        expectedReasonCode: "DISPOSABLE_EMAIL",
      },
      {
        name: "rejects unverified email when requireVerifiedEmail is true",
        rules: { ...baselineRules, requireVerifiedEmail: true },
        customer: { ...baselineCustomer, verifiedEmail: false },
        expectedEligible: false,
        expectedReasonCode: "EMAIL_NOT_VERIFIED",
      },
      {
        name: "allows unverified email when requireVerifiedEmail is false",
        rules: { ...baselineRules, requireVerifiedEmail: false },
        customer: { ...baselineCustomer, verifiedEmail: false },
        expectedEligible: true,
        expectedReasonCode: "ELIGIBLE",
      },
      {
        name: "rejects customer with no default address country when region lock is active",
        rules: { ...baselineRules, allowedCountries: ["CA", "US"] },
        customer: { ...baselineCustomer, countryCode: null },
        expectedEligible: false,
        expectedReasonCode: "COUNTRY_NOT_ALLOWED",
      },
      {
        name: "rejects customer with unlisted default shipping country (GB)",
        rules: { ...baselineRules, allowedCountries: ["CA", "US"] },
        customer: { ...baselineCustomer, countryCode: "GB" },
        expectedEligible: false,
        expectedReasonCode: "COUNTRY_NOT_ALLOWED",
      },
      {
        name: "accepts customer shipping country case-insensitively (ca -> CA)",
        rules: { ...baselineRules, allowedCountries: ["CA", "US"] },
        customer: { ...baselineCustomer, countryCode: "ca" },
        expectedEligible: true,
        expectedReasonCode: "ELIGIBLE",
      },
      {
        name: "allows any country when allowedCountries is empty (Worldwide)",
        rules: { ...baselineRules, allowedCountries: [] },
        customer: { ...baselineCustomer, countryCode: "JP" },
        expectedEligible: true,
        expectedReasonCode: "ELIGIBLE",
      },
      {
        name: "allows customer without address when allowedCountries is empty",
        rules: { ...baselineRules, allowedCountries: [] },
        customer: { ...baselineCustomer, countryCode: null },
        expectedEligible: true,
        expectedReasonCode: "ELIGIBLE",
      },
      {
        name: "soft geo-IP signal: permits entry on geo-IP mismatch but records risk flag",
        rules: baselineRules,
        customer: { ...baselineCustomer, countryCode: "CA" },
        context: { ...baselineContext, geoCountry: "FR" },
        expectedEligible: true,
        expectedReasonCode: "ELIGIBLE",
        expectedGeoIpMismatch: true,
      },
      {
        name: "rejects account created more recently than minAccountAgeDays",
        rules: { ...baselineRules, minAccountAgeDays: 7 },
        customer: {
          ...baselineCustomer,
          createdAt: new Date("2026-10-02T12:00:00.000Z"), // 2 days old, requires 7
        },
        expectedEligible: false,
        expectedReasonCode: "ACCOUNT_TOO_NEW",
      },
      {
        name: "accepts account created exactly at the age threshold",
        rules: { ...baselineRules, minAccountAgeDays: 7 },
        customer: {
          ...baselineCustomer,
          createdAt: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), // Exactly 7 days old
        },
        expectedEligible: true,
        expectedReasonCode: "ELIGIBLE",
      },
      {
        name: "rejects account created 1ms after the age threshold (too young)",
        rules: { ...baselineRules, minAccountAgeDays: 7 },
        customer: {
          ...baselineCustomer,
          createdAt: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000 + 1), // 1ms too young
        },
        expectedEligible: false,
        expectedReasonCode: "ACCOUNT_TOO_NEW",
      },
      {
        name: "rejects missing createdAt when minAccountAgeDays > 0",
        rules: { ...baselineRules, minAccountAgeDays: 7 },
        customer: { ...baselineCustomer, createdAt: null },
        expectedEligible: false,
        expectedReasonCode: "ACCOUNT_TOO_NEW",
      },
      {
        name: "accepts new account when minAccountAgeDays is 0",
        rules: { ...baselineRules, minAccountAgeDays: 0 },
        customer: { ...baselineCustomer, createdAt: now },
        expectedEligible: true,
        expectedReasonCode: "ELIGIBLE",
      },
      {
        name: "rejects missing phone when requirePhone is true",
        rules: { ...baselineRules, requirePhone: true },
        customer: { ...baselineCustomer, phone: null },
        expectedEligible: false,
        expectedReasonCode: "PHONE_REQUIRED",
      },
      {
        name: "rejects blank whitespace phone when requirePhone is true",
        rules: { ...baselineRules, requirePhone: true },
        customer: { ...baselineCustomer, phone: "   " },
        expectedEligible: false,
        expectedReasonCode: "PHONE_REQUIRED",
      },
      {
        name: "allows missing phone when requirePhone is false",
        rules: { ...baselineRules, requirePhone: false },
        customer: { ...baselineCustomer, phone: null },
        expectedEligible: true,
        expectedReasonCode: "ELIGIBLE",
      },
    ];

    testCases.forEach((tc) => {
      it(tc.name, () => {
        const rules = { ...baselineRules, ...tc.rules };
        const customer = tc.customer ? ({ ...baselineCustomer, ...tc.customer } as EligibilityCustomer) : null;
        const context = { ...baselineContext, ...tc.context };

        const result = evaluateEligibility(rules, customer, context);

        expect(result.eligible).toBe(tc.expectedEligible);
        expect(result.reasonCode).toBe(tc.expectedReasonCode);
        expect(result.userMessage).toBeTruthy();

        if (tc.expectedGeoIpMismatch !== undefined) {
          expect(Boolean(result.riskSignals?.geoIpMismatch)).toBe(tc.expectedGeoIpMismatch);
        }

        if (result.eligible) {
          expect(result.normalizedEmail).toBeDefined();
          expect(result.normalizedEmailHash).toBeDefined();
        }
      });
    });
  });
});
