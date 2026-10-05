import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import type { ActionFunctionArgs } from "react-router";
import prisma from "../app/db.server";
import { encrypt } from "../app/services/encryption";
import { action as proxyAction } from "../app/routes/apps.raffle.$";

import { resetRateLimits, RATE_LIMIT_CONFIG } from "../app/services/rateLimiter.server";

describe("Load Testing & High-Concurrency Burst Simulation (Item 9)", { timeout: 60000 }, () => {
  let testShopId: string;
  const testShopDomain = `load-sim-${Date.now()}.myshopify.com`;
  const apiSecret = "test_api_secret_for_proxy_signatures";

  beforeAll(async () => {
    process.env.SHOPIFY_API_SECRET = apiSecret;
    process.env.ENCRYPTION_MASTER_KEY = crypto.randomBytes(32).toString("base64");
    resetRateLimits();
    // Allow high concurrency for the draw during simulation
    RATE_LIMIT_CONFIG.draw.limit = 1000;
    RATE_LIMIT_CONFIG.ip.limit = 100;

    const shop = await prisma.shop.create({
      data: {
        shopDomain: testShopDomain,
        accessToken: "shp_test_token_load_sim",
      },
    });
    testShopId = shop.id;
  });

  afterAll(async () => {
    RATE_LIMIT_CONFIG.draw.limit = 60;
    RATE_LIMIT_CONFIG.ip.limit = 10;
    await prisma.shop.delete({ where: { id: testShopId } }).catch(() => {});
  });

  function createSignedEntryRequest(drawId: string, customerId: string, email: string): Request {
    const url = new URL(`https://${testShopDomain}/apps/raffle/entry/${drawId}`);
    url.searchParams.set("shop", testShopDomain);
    url.searchParams.set("timestamp", String(Math.floor(Date.now() / 1000)));
    url.searchParams.set("logged_in_customer_id", customerId);

    const signedMessage = [...new Set([...url.searchParams.keys()])]
      .filter((k) => k !== "signature" && k !== "hmac")
      .sort()
      .map((key) => `${key}=${url.searchParams.getAll(key).join(",")}`)
      .join("");

    const signature = crypto
      .createHmac("sha256", apiSecret)
      .update(signedMessage)
      .digest("hex");

    url.searchParams.set("signature", signature);

    const body = JSON.stringify({
      customerData: {
        email,
        verifiedEmail: true,
        countryCode: "US",
        createdAt: new Date(Date.now() - 365 * 86400000).toISOString(),
      },
    });

    const clientIp = `198.51.100.${(Number(customerId) % 200) + 1}`;

    return new Request(url.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-host": testShopDomain,
        "x-forwarded-for": clientIp,
      },
      body,
    });
  }

  it("burst at close time: zero late entries and zero duplicate entries under concurrent traffic", async () => {
    // 1. Create a draw closing in 15000ms (15 seconds) to allow open-window traffic to complete
    const closeWindowMs = 15000;
    const entryOpensAt = new Date(Date.now() - 30000);
    const entryClosesAt = new Date(Date.now() + closeWindowMs);

    const draw = await prisma.draw.create({
      data: {
        shopId: testShopId,
        title: "Closing Burst Test Draw",
        status: "OPEN",
        entryOpensAt,
        entryClosesAt,
        drawAt: new Date(Date.now() + 60000),
        claimWindowMinutes: 30,
        unitsAvailable: 10,
        encryptionKeyId: encrypt(crypto.randomBytes(32).toString("base64")),
      },
    });

    const latencies: number[] = [];
    let successCount = 0;
    let duplicateRejectedCount = 0;
    let lateRejectedCount = 0;
    let error5xxCount = 0;

    // Concurrently execute requests before, during, and right after close time
    const promises: Array<Promise<void>> = [];

    // Helper to send request and record metrics
    const sendRequest = async (customerId: string, email: string) => {
      const start = Date.now();
      const request = createSignedEntryRequest(draw.id, customerId, email);

      try {
        const response = await proxyAction({
          request,
          params: { "*": `entry/${draw.id}` },
          context: {},
        } as unknown as ActionFunctionArgs);

        const latency = Date.now() - start;
        latencies.push(latency);

        if (response.status === 201) {
          successCount++;
        } else if (response.status === 409) {
          const json = await response.json();
          if (json.error?.includes("closed")) {
            lateRejectedCount++;
          } else {
            duplicateRejectedCount++;
          }
        } else if (response.status >= 500) {
          error5xxCount++;
        } else {
          const text = await response.text();
          console.log(`Unexpected status: ${response.status}`, text);
        }
      } catch (e) {
        console.error("sendRequest exception:", e);
        error5xxCount++;
      }
    };

    // Dispatch batch 1: valid unique entries immediately (open window)
    for (let i = 1; i <= 25; i++) {
      promises.push(sendRequest(String(10000 + i), `user_${i}@example.com`));
    }

    // Dispatch batch 2: intentional duplicate submissions for 10001 and 10002
    for (let i = 0; i < 2; i++) {
      promises.push(sendRequest("10001", "user_1@example.com"));
      promises.push(sendRequest("10002", "user_2@example.com"));
    }

    // Await first wave
    await Promise.all(promises);

    // Wait until close time arrives
    const timeRemaining = entryClosesAt.getTime() - Date.now();
    if (timeRemaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, timeRemaining + 100));
    }

    // Dispatch batch 3: burst of late requests submitted after entryClosesAt
    const latePromises: Array<Promise<void>> = [];
    for (let i = 26; i <= 50; i++) {
      latePromises.push(sendRequest(String(20000 + i), `user_late_${i}@example.com`));
    }
    await Promise.all(latePromises);

    // 2. Metrics calculation
    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
    const p90 = latencies[Math.floor(latencies.length * 0.9)] || 0;
    const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
    const errorRate = ((error5xxCount / latencies.length) * 100).toFixed(2);

    console.log("================ LOAD TEST RESULTS ================");
    console.log(`Total Requests Processed:     ${latencies.length}`);
    console.log(`Successful Entries (201):     ${successCount}`);
    console.log(`Duplicates Blocked (409):     ${duplicateRejectedCount}`);
    console.log(`Late Entries Blocked (409):   ${lateRejectedCount}`);
    console.log(`5xx Server Error Rate:        ${errorRate}%`);
    console.log(`Latency p50:                  ${p50}ms`);
    console.log(`Latency p90:                  ${p90}ms`);
    console.log(`Latency p95:                  ${p95}ms`);
    console.log("===================================================");

    // 3. Acceptance Assertions
    // Strictly zero 5xx server errors
    expect(error5xxCount).toBe(0);

    // Strictly zero duplicate entries in database
    const dbEntries = await prisma.entry.findMany({
      where: { drawId: draw.id },
    });
    const uniqueCustomerIds = new Set(dbEntries.map((e) => e.customerGid));
    expect(dbEntries.length).toBe(uniqueCustomerIds.size);

    // Strictly zero late entries in database
    const lateEntries = dbEntries.filter((e) => e.createdAt > draw.entryClosesAt);
    expect(lateEntries).toHaveLength(0);

    // All late requests must have been cleanly rejected
    expect(lateRejectedCount).toBeGreaterThanOrEqual(25);
  });
});
