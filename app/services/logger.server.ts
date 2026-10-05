/**
 * Zero-PII Log Scrubber Service.
 * Ensures no Personally Identifiable Information (PII), customer identifiers,
 * bearer tokens, or secret credentials are leaked into console logs or analytics.
 */

const PII_PATTERNS: Array<{ regex: RegExp; replacement: string }> = [
  // Email addresses
  {
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    replacement: "[REDACTED_EMAIL]",
  },
  // IPv4 Addresses
  {
    regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    replacement: "[REDACTED_IP]",
  },
  // Shopify Private/Custom App Access Tokens
  {
    regex: /\b(?:shpat|shpua|shpca|shpss)_[a-fA-F0-9]{32,}\b/g,
    replacement: "[REDACTED_SHOPIFY_TOKEN]",
  },
  // Bearer authentication tokens
  {
    regex: /\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/gi,
    replacement: "Bearer [REDACTED_TOKEN]",
  },
  // Customer GraphQL IDs (replaces numeric ID)
  {
    regex: /\bgid:\/\/shopify\/Customer\/\d+\b/g,
    replacement: "gid://shopify/Customer/[REDACTED_ID]",
  },
  // Customer numeric ID patterns in query/logs
  {
    regex: /\b(?:customer|customerId|logged_in_customer_id)[=:\s]+(\d{5,})\b/gi,
    replacement: "customerId=[REDACTED_ID]",
  },
  // Phone numbers (E.164 and international format)
  {
    regex: /(?:\+|00)[1-9]\d{1,14}\b/g,
    replacement: "[REDACTED_PHONE]",
  },
];

/**
 * Scrubs string data of any known PII or secrets.
 */
export function scrubText(text: string): string {
  if (!text || typeof text !== "string") return text;
  let scrubbed = text;
  for (const { regex, replacement } of PII_PATTERNS) {
    scrubbed = scrubbed.replace(regex, replacement);
  }
  return scrubbed;
}

/**
 * Recursively traverses objects/arrays to sanitize any embedded PII.
 */
export function scrubData<T>(data: T): T {
  if (data === null || data === undefined) return data;

  if (typeof data === "string") {
    return scrubText(data) as unknown as T;
  }

  if (Array.isArray(data)) {
    return data.map((item) => scrubData(item)) as unknown as T;
  }

  if (typeof data === "object") {
    // Keep Error instances readable while scrubbing message
    if (data instanceof Error) {
      const scrubbedError = new Error(scrubText(data.message));
      scrubbedError.name = data.name;
      if (data.stack) scrubbedError.stack = scrubText(data.stack);
      return scrubbedError as unknown as T;
    }

    const cleanObj: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      // Sensitive field names completely blanked
      const lowerKey = key.toLowerCase();
      if (
        lowerKey.includes("password") ||
        lowerKey.includes("secret") ||
        lowerKey.includes("token") ||
        lowerKey.includes("apikey") ||
        lowerKey.includes("authorization")
      ) {
        cleanObj[key] = "[REDACTED_SECRET]";
      } else if (
        lowerKey.includes("email") ||
        lowerKey.includes("phone") ||
        lowerKey.includes("address")
      ) {
        cleanObj[key] = typeof value === "string" ? scrubText(value) : "[REDACTED_PII]";
      } else {
        cleanObj[key] = scrubData(value);
      }
    }
    return cleanObj as unknown as T;
  }

  return data;
}

/**
 * Production-ready zero-PII logger.
 */
export const logger = {
  info(message: string, ...args: unknown[]) {
    console.log(scrubText(message), ...args.map(scrubData));
  },
  warn(message: string, ...args: unknown[]) {
    console.warn(scrubText(message), ...args.map(scrubData));
  },
  error(message: string, ...args: unknown[]) {
    console.error(scrubText(message), ...args.map(scrubData));
  },
  debug(message: string, ...args: unknown[]) {
    if (process.env.NODE_ENV !== "production") {
      console.debug(scrubText(message), ...args.map(scrubData));
    }
  },
};
