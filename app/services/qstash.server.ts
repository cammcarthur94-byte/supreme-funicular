import { Client, Receiver } from "@upstash/qstash";

const qstashToken = process.env.QSTASH_TOKEN;
const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;

export function getQStashClient(): Client | null {
  if (!qstashToken) {
    return null;
  }
  return new Client({ token: qstashToken });
}

export function getQStashReceiver(): Receiver | null {
  if (!currentSigningKey || !nextSigningKey) {
    return null;
  }
  return new Receiver({
    currentSigningKey,
    nextSigningKey,
  });
}

/**
 * Publishes a self-scheduling visibility check to QStash.
 */
export async function scheduleVisibilityGuardCheck({
  delaySeconds = 1200, // Default 20 minutes (within 15-30m requirement)
  appUrl = process.env.SHOPIFY_APP_URL,
}: {
  delaySeconds?: number;
  appUrl?: string;
} = {}): Promise<{ scheduled: boolean; messageId?: string; reason?: string }> {
  const client = getQStashClient();
  if (!client) {
    console.warn("[QStash] QSTASH_TOKEN not configured; skipping background schedule.");
    return { scheduled: false, reason: "MISSING_TOKEN" };
  }

  const baseUrl = appUrl || process.env.SHOPIFY_APP_URL;
  if (!baseUrl) {
    console.warn("[QStash] SHOPIFY_APP_URL not configured; skipping background schedule.");
    return { scheduled: false, reason: "MISSING_APP_URL" };
  }

  const destinationUrl = `${baseUrl.replace(/\/$/, "")}/api/qstash/guard`;

  try {
    const res = await client.publishJSON({
      url: destinationUrl,
      delay: delaySeconds,
      body: {
        enqueuedAt: new Date().toISOString(),
        delaySeconds,
      },
    });

    console.log(`[QStash] Scheduled guard check for ${destinationUrl} in ${delaySeconds}s (id: ${res.messageId})`);
    return { scheduled: true, messageId: res.messageId };
  } catch (error) {
    console.error("[QStash] Failed to schedule guard job:", error);
    return { scheduled: false, reason: String(error) };
  }
}

/**
 * Validates the QStash HTTP request signature.
 */
export async function verifyQStashRequest(
  request: Request,
  rawBody: string
): Promise<boolean> {
  const receiver = getQStashReceiver();
  if (!receiver) {
    // If keys are not configured (local dev or staging without QStash), allow with warning
    if (process.env.NODE_ENV !== "production") {
      console.warn("[QStash] QStash signing keys not configured. Allowing in non-production.");
      return true;
    }
    return false;
  }

  const signature = request.headers.get("upstash-signature");
  if (!signature) {
    return false;
  }

  try {
    const isValid = await receiver.verify({
      signature,
      body: rawBody,
    });
    return isValid;
  } catch (error) {
    console.error("[QStash] Signature verification failed:", error);
    return false;
  }
}
