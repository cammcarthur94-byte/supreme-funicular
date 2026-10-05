import crypto from "node:crypto";
import type { EligibilityRules } from "../validation/drawValidation";

/**
 * Common disposable and burner email domains blocklist.
 * Prevents automated syringe attacks and throwaway multi-accounting.
 */
export const DISPOSABLE_EMAIL_DOMAINS = new Set<string>([
  "mailinator.com",
  "guerrillamail.com",
  "guerrillamailblock.com",
  "sharklasers.com",
  "grr.la",
  "guerrillamail.info",
  "guerrillamail.biz",
  "guerrillamail.de",
  "guerrillamail.net",
  "guerrillamail.org",
  "tempmail.com",
  "temp-mail.org",
  "tempmailo.com",
  "10minutemail.com",
  "10minutemail.net",
  "trashmail.com",
  "trashmail.net",
  "trashmail.me",
  "yopmail.com",
  "yopmail.fr",
  "yopmail.net",
  "dispostable.com",
  "maildrop.cc",
  "getairmail.com",
  "throwawaymail.com",
  "fakemailgenerator.com",
  "generator.email",
  "mohmal.com",
  "burnermail.io",
  "inboxkitten.com",
  "nada.ltd",
  "getnada.com",
  "emailondeck.com",
  "crazymailing.com",
  "mytemp.email",
  "zillamail.com",
  "discard.email",
  "mailcatch.com",
  "harakirimail.com",
  "fakeinbox.com",
  "mytempemail.com",
  "armyspy.com",
  "cuvox.de",
  "dayrep.com",
  "fleckens.hu",
  "gustr.com",
  "jourrapide.com",
  "rhyta.com",
  "superrito.com",
  "teleworm.us",
  "tinemail.com",
  "dropmail.me",
  "eyepaste.com",
  "getmymap.org",
  "incognitomail.org",
  "meltmail.com",
  "mytempemail.com",
  "safetymail.info",
  "trashymail.com",
]);

/**
 * Normalizes an email address for fraud prevention:
 * 1. Lowercases the entire address.
 * 2. Normalizes domain aliases (e.g. googlemail.com -> gmail.com).
 * 3. Strips plus-tags/subaddresses (+tag) across all providers.
 * 4. Removes dots in local-part for Gmail and Googlemail accounts.
 */
export function normalizeEmail(email: string): string {
  if (!email || typeof email !== "string") {
    return "";
  }

  const trimmed = email.trim().toLowerCase();
  const atIndex = trimmed.lastIndexOf("@");
  if (atIndex === -1 || atIndex === 0 || atIndex === trimmed.length - 1) {
    return trimmed;
  }

  let localPart = trimmed.slice(0, atIndex);
  let domain = trimmed.slice(atIndex + 1);

  // Normalize Google domain alias
  if (domain === "googlemail.com") {
    domain = "gmail.com";
  }

  // Strip sub-addressing (+tag)
  const plusIndex = localPart.indexOf("+");
  if (plusIndex !== -1) {
    localPart = localPart.slice(0, plusIndex);
  }

  // Remove dots for Gmail/Googlemail (Gmail treats john.doe and johndoe identically)
  if (domain === "gmail.com") {
    localPart = localPart.replace(/\./g, "");
  }

  return `${localPart}@${domain}`;
}

/**
 * Computes a SHA-256 hash of a normalized email address.
 * Used for database uniqueness constraints without storing raw normalized strings.
 */
export function hashNormalizedEmail(email: string): string {
  const normalized = normalizeEmail(email);
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

/**
 * Checks if the given email domain belongs to the disposable domain blocklist.
 */
export function isDisposableEmail(email: string): boolean {
  if (!email || typeof email !== "string") {
    return false;
  }

  const trimmed = email.trim().toLowerCase();
  const atIndex = trimmed.lastIndexOf("@");
  if (atIndex === -1 || atIndex === trimmed.length - 1) {
    return false;
  }

  const domain = trimmed.slice(atIndex + 1);

  // Exact match
  if (DISPOSABLE_EMAIL_DOMAINS.has(domain)) {
    return true;
  }

  // Check subdomains (e.g. mail.mailinator.com)
  for (const blocked of DISPOSABLE_EMAIL_DOMAINS) {
    if (domain.endsWith(`.${blocked}`)) {
      return true;
    }
  }

  return false;
}

export type EligibilityReasonCode =
  | "ELIGIBLE"
  | "ACCOUNT_REQUIRED"
  | "INVALID_EMAIL"
  | "DISPOSABLE_EMAIL"
  | "EMAIL_NOT_VERIFIED"
  | "COUNTRY_NOT_ALLOWED"
  | "ACCOUNT_TOO_NEW"
  | "PHONE_REQUIRED";

export interface EligibilityCustomer {
  customerId?: string | null;
  email?: string | null;
  verifiedEmail?: boolean | null;
  createdAt?: Date | string | null;
  countryCode?: string | null;
  phone?: string | null;
}

export interface EligibilityRequestContext {
  now?: Date;
  clientIp?: string | null;
  geoCountry?: string | null;
}

export interface EligibilityEvaluation {
  eligible: boolean;
  reasonCode: EligibilityReasonCode;
  userMessage: string;
  normalizedEmail?: string;
  normalizedEmailHash?: string;
  riskSignals?: {
    geoIpMismatch?: boolean;
    disposableEmail?: boolean;
  };
}

/**
 * Pure eligibility rule evaluation engine.
 * Evaluates draw eligibility rules against customer and request context.
 * Returns a typed evaluation with reasonCode and user-facing actionable messages.
 */
export function evaluateEligibility(
  rules: EligibilityRules,
  customer?: EligibilityCustomer | null,
  requestContext?: EligibilityRequestContext | null
): EligibilityEvaluation {
  const now = requestContext?.now ?? new Date();
  const riskSignals: { geoIpMismatch?: boolean; disposableEmail?: boolean } = {};

  // Rule 1: requireAccount
  const requireAccount = rules.requireAccount !== false;
  if (requireAccount && (!customer || !customer.customerId)) {
    return {
      eligible: false,
      reasonCode: "ACCOUNT_REQUIRED",
      userMessage: "Please log in or create an account to enter this drop.",
      riskSignals,
    };
  }

  // Validate customer email presence
  const rawEmail = customer?.email?.trim();
  if (!rawEmail || !rawEmail.includes("@")) {
    return {
      eligible: false,
      reasonCode: "INVALID_EMAIL",
      userMessage: "A valid email address associated with your customer account is required.",
      riskSignals,
    };
  }

  // Rule 2: Disposable email blocklist
  if (isDisposableEmail(rawEmail)) {
    riskSignals.disposableEmail = true;
    return {
      eligible: false,
      reasonCode: "DISPOSABLE_EMAIL",
      userMessage: "Disposable or temporary email addresses are not permitted.",
      riskSignals,
    };
  }

  // Calculate normalized email and hash
  const normalizedEmail = normalizeEmail(rawEmail);
  const normalizedEmailHash = hashNormalizedEmail(rawEmail);

  // Rule 3: requireVerifiedEmail
  if (rules.requireVerifiedEmail && !customer?.verifiedEmail) {
    return {
      eligible: false,
      reasonCode: "EMAIL_NOT_VERIFIED",
      userMessage: "Please verify your email address on your store account before entering.",
      normalizedEmail,
      normalizedEmailHash,
      riskSignals,
    };
  }

  // Rule 4: allowedCountries (shipping country restriction)
  // Note: Customer's default shipping address country is the deciding check.
  // Geo-IP is used ONLY as a soft risk signal (never as the hard deciding check).
  if (rules.allowedCountries && rules.allowedCountries.length > 0) {
    const customerCountry = customer?.countryCode?.trim().toUpperCase();
    const allowedSet = new Set(rules.allowedCountries.map((c) => c.trim().toUpperCase()));

    if (!customerCountry) {
      return {
        eligible: false,
        reasonCode: "COUNTRY_NOT_ALLOWED",
        userMessage: "Please add a default shipping address to your customer account to verify country eligibility.",
        normalizedEmail,
        normalizedEmailHash,
        riskSignals,
      };
    }

    if (!allowedSet.has(customerCountry)) {
      return {
        eligible: false,
        reasonCode: "COUNTRY_NOT_ALLOWED",
        userMessage: `This drop is restricted to customers with a default shipping address in: ${rules.allowedCountries.join(
          ", "
        )}.`,
        normalizedEmail,
        normalizedEmailHash,
        riskSignals,
      };
    }

    // Check soft geo-IP signal
    if (requestContext?.geoCountry) {
      const geo = requestContext.geoCountry.trim().toUpperCase();
      if (geo && geo !== customerCountry) {
        riskSignals.geoIpMismatch = true;
      }
    }
  }

  // Rule 5: minAccountAgeDays
  if (rules.minAccountAgeDays && rules.minAccountAgeDays > 0) {
    if (!customer?.createdAt) {
      return {
        eligible: false,
        reasonCode: "ACCOUNT_TOO_NEW",
        userMessage: "Account creation date could not be verified.",
        normalizedEmail,
        normalizedEmailHash,
        riskSignals,
      };
    }

    const createdTime = new Date(customer.createdAt).getTime();
    const ageThresholdMs = rules.minAccountAgeDays * 24 * 60 * 60 * 1000;
    const requiredBeforeTime = now.getTime() - ageThresholdMs;

    if (createdTime > requiredBeforeTime) {
      return {
        eligible: false,
        reasonCode: "ACCOUNT_TOO_NEW",
        userMessage: `Your store account must be at least ${rules.minAccountAgeDays} day(s) old to qualify for this drop.`,
        normalizedEmail,
        normalizedEmailHash,
        riskSignals,
      };
    }
  }

  // Rule 6: requirePhone (optional)
  if (rules.requirePhone) {
    const phone = customer?.phone?.trim();
    if (!phone || phone.length === 0) {
      return {
        eligible: false,
        reasonCode: "PHONE_REQUIRED",
        userMessage: "A phone number must be added to your customer account to enter this drop.",
        normalizedEmail,
        normalizedEmailHash,
        riskSignals,
      };
    }
  }

  return {
    eligible: true,
    reasonCode: "ELIGIBLE",
    userMessage: "Eligible to enter.",
    normalizedEmail,
    normalizedEmailHash,
    riskSignals,
  };
}
