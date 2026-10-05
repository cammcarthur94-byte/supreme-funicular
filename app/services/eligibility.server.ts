import type { EligibilityRules } from "../validation/drawValidation";

export interface EntryCustomer {
  email: string;
  emailVerified: boolean;
  countryCode: string | null;
  createdAt: Date;
  phone: string | null;
}

export function getAccountEligibility(): boolean {
  // Entry identity and eligibility attributes come from Shopify's Admin customer record.
  return true;
}

export type EligibilityResult =
  | { eligible: true }
  | { eligible: false; message: string };

export function checkEntryEligibility(
  rules: EligibilityRules,
  customer: EntryCustomer,
  now: Date
): EligibilityResult {
  if (rules.requireVerifiedEmail && !customer.emailVerified) {
    return { eligible: false, message: "Please verify your email address before entering." };
  }
  if (rules.requirePhone && !customer.phone) {
    return { eligible: false, message: "Add a phone number to your customer account before entering." };
  }
  if (rules.allowedCountries.length > 0 && (!customer.countryCode || !rules.allowedCountries.includes(customer.countryCode))) {
    return { eligible: false, message: "This draw is not available in your shipping country." };
  }
  const minimumCreatedAt = now.getTime() - rules.minAccountAgeDays * 24 * 60 * 60 * 1000;
  if (customer.createdAt.getTime() > minimumCreatedAt) {
    return { eligible: false, message: "Your customer account does not yet meet this draw's age requirement." };
  }
  return { eligible: true };
}
