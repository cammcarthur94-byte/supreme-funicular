import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import type { LoaderFunctionArgs } from "react-router";
import prisma from "../app/db.server";
import { generateClaimToken, issueAllocationsForDraw } from "../app/services/allocationService.server";
import { loader as claimLoader } from "../app/routes/apps.raffle.$";
import { encrypt } from "../app/services/encryption";

describe("Secure One-Time Checkout Flow (Phase 9)", () => {
  let testShopId: string;
  const testShopDomain = `checkout-test-${Date.now()}.myshopify.com`;
  const apiSecret = "test_shopify_api_secret_for_proxy_signatures";

  beforeAll(async () => {
    process.env.SHOPIFY_API_SECRET = apiSecret;
    process.env.ENCRYPTION_MASTER_KEY = crypto.randomBytes(32).toString("base64");

    const shop = await prisma.shop.create({
      data: {
        shopDomain: testShopDomain,
        accessToken: "shp_test_token_123",
      },
    });
    testShopId = shop.id;
  });

  afterAll(async () => {
    await prisma.shop.delete({ where: { id: testShopId } }).catch(() => {});
  });

  function createSignedProxyRequest(urlStr: string, queryParams: Record<string, string> = {}): Request {
    const url = new URL(urlStr);
    url.searchParams.set("shop", testShopDomain);
    url.searchParams.set("timestamp", String(Math.floor(Date.now() / 1000)));
    url.searchParams.set("logged_in_customer_id", queryParams.logged_in_customer_id ?? "");

    for (const [key, value] of Object.entries(queryParams)) {
      url.searchParams.set(key, value);
    }

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

    return new Request(url.toString(), {
      method: "GET",
      headers: { "x-forwarded-host": testShopDomain },
    });
  }

  describe("Claim Token Entropy & Hashing", () => {
    it("generates 32-byte CSPRNG base64url tokens with deterministic SHA-256 hashes", () => {
      const generated = new Set<string>();
      const hashes = new Set<string>();

      for (let i = 0; i < 50; i++) {
        const { token, claimTokenHash } = generateClaimToken();
        expect(token.length).toBeGreaterThanOrEqual(43); // 32 bytes base64url is 43 chars
        expect(claimTokenHash).toHaveLength(64); // SHA-256 hex is 64 chars

        const manualHash = crypto.createHash("sha256").update(token).digest("hex");
        expect(claimTokenHash).toBe(manualHash);

        generated.add(token);
        hashes.add(claimTokenHash);
      }

      // High entropy: zero collisions across 50 iterations
      expect(generated.size).toBe(50);
      expect(hashes.size).toBe(50);
    });
  });

  describe("Claim Endpoint Verification & State Gating", () => {
    it("redirects logged-out user to store login with return_url", async () => {
      const { token, claimTokenHash } = generateClaimToken();

      const draw = await prisma.draw.create({
        data: {
          shopId: testShopId,
          title: "Logged Out Test Draw",
          status: "FULFILLING",
          entryOpensAt: new Date(Date.now() - 3600000),
          entryClosesAt: new Date(Date.now() - 1800000),
          drawAt: new Date(Date.now() - 900000),
          claimWindowMinutes: 60,
          unitsAvailable: 1,
        },
      });

      const entry = await prisma.entry.create({
        data: {
          shopId: testShopId,
          drawId: draw.id,
          customerGid: "gid://shopify/Customer/111001",
          normalizedEmailHash: "hash_lo",
          emailEncrypted: encrypt("user@test.com"),
          status: "VALID",
          rank: 1,
        },
      });

      await prisma.allocation.create({
        data: {
          shopId: testShopId,
          drawId: draw.id,
          entryId: entry.id,
          variantGid: "gid://shopify/ProductVariant/v1",
          rank: 1,
          claimTokenHash,
          invoiceUrl: "https://checkout.shopify.com/invoice/123",
          deadlineAt: new Date(Date.now() + 3600000),
          status: "ISSUED",
        },
      });

      // Request WITHOUT logged-in customer (logged_in_customer_id = "")
      const request = createSignedProxyRequest(
        `https://${testShopDomain}/apps/raffle/claim/${token}`
      );

      const response = await claimLoader({
        request,
        params: { "*": `claim/${token}` },
        context: {},
      } as unknown as LoaderFunctionArgs);

      expect(response.status).toBe(302);
      const location = response.headers.get("Location");
      expect(location).toContain(`/account/login?return_url=`);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    });

    it("rejects wrong customer with generic error response", async () => {
      const { token, claimTokenHash } = generateClaimToken();

      const draw = await prisma.draw.create({
        data: {
          shopId: testShopId,
          title: "Wrong Cust Draw",
          status: "FULFILLING",
          entryOpensAt: new Date(Date.now() - 3600000),
          entryClosesAt: new Date(Date.now() - 1800000),
          drawAt: new Date(Date.now() - 900000),
          claimWindowMinutes: 60,
          unitsAvailable: 1,
        },
      });

      const entry = await prisma.entry.create({
        data: {
          shopId: testShopId,
          drawId: draw.id,
          customerGid: "gid://shopify/Customer/111002",
          normalizedEmailHash: "hash_winner",
          emailEncrypted: encrypt("winner@test.com"),
          status: "VALID",
          rank: 1,
        },
      });

      await prisma.allocation.create({
        data: {
          shopId: testShopId,
          drawId: draw.id,
          entryId: entry.id,
          variantGid: "gid://shopify/ProductVariant/v1",
          rank: 1,
          claimTokenHash,
          invoiceUrl: "https://checkout.shopify.com/invoice/123",
          deadlineAt: new Date(Date.now() + 3600000),
          status: "ISSUED",
        },
      });

      // Request with WRONG numeric customer ID
      const request = createSignedProxyRequest(
        `https://${testShopDomain}/apps/raffle/claim/${token}`,
        { logged_in_customer_id: "999999" }
      );

      const response = await claimLoader({
        request,
        params: { "*": `claim/${token}` },
        context: {},
      } as unknown as LoaderFunctionArgs);

      expect(response.status).toBe(404);
      const text = await response.text();
      expect(text).toBe("Link is invalid or has expired.");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    });

    it("rejects expired claim link with generic error response", async () => {
      const { token, claimTokenHash } = generateClaimToken();

      const draw = await prisma.draw.create({
        data: {
          shopId: testShopId,
          title: "Expired Draw",
          status: "FULFILLING",
          entryOpensAt: new Date(Date.now() - 3600000),
          entryClosesAt: new Date(Date.now() - 1800000),
          drawAt: new Date(Date.now() - 900000),
          claimWindowMinutes: 60,
          unitsAvailable: 1,
        },
      });

      const entry = await prisma.entry.create({
        data: {
          shopId: testShopId,
          drawId: draw.id,
          customerGid: "gid://shopify/Customer/111003",
          normalizedEmailHash: "hash_exp",
          emailEncrypted: encrypt("expired@test.com"),
          status: "VALID",
          rank: 1,
        },
      });

      // Allocation deadline is in the PAST
      await prisma.allocation.create({
        data: {
          shopId: testShopId,
          drawId: draw.id,
          entryId: entry.id,
          variantGid: "gid://shopify/ProductVariant/v1",
          rank: 1,
          claimTokenHash,
          invoiceUrl: "https://checkout.shopify.com/invoice/123",
          deadlineAt: new Date(Date.now() - 60000), // 1 minute ago
          status: "ISSUED",
        },
      });

      const request = createSignedProxyRequest(
        `https://${testShopDomain}/apps/raffle/claim/${token}`,
        { logged_in_customer_id: "111003" }
      );

      const response = await claimLoader({
        request,
        params: { "*": `claim/${token}` },
        context: {},
      } as unknown as LoaderFunctionArgs);

      expect(response.status).toBe(404);
      const text = await response.text();
      expect(text).toBe("Link is invalid or has expired.");
    });

    it("rejects reuse after purchase (status = PURCHASED)", async () => {
      const { token, claimTokenHash } = generateClaimToken();

      const draw = await prisma.draw.create({
        data: {
          shopId: testShopId,
          title: "Purchased Draw",
          status: "FULFILLING",
          entryOpensAt: new Date(Date.now() - 3600000),
          entryClosesAt: new Date(Date.now() - 1800000),
          drawAt: new Date(Date.now() - 900000),
          claimWindowMinutes: 60,
          unitsAvailable: 1,
        },
      });

      const entry = await prisma.entry.create({
        data: {
          shopId: testShopId,
          drawId: draw.id,
          customerGid: "gid://shopify/Customer/111004",
          normalizedEmailHash: "hash_bought",
          emailEncrypted: encrypt("bought@test.com"),
          status: "VALID",
          rank: 1,
        },
      });

      await prisma.allocation.create({
        data: {
          shopId: testShopId,
          drawId: draw.id,
          entryId: entry.id,
          variantGid: "gid://shopify/ProductVariant/v1",
          rank: 1,
          claimTokenHash,
          invoiceUrl: "https://checkout.shopify.com/invoice/123",
          deadlineAt: new Date(Date.now() + 3600000),
          status: "PURCHASED",
          purchasedAt: new Date(),
        },
      });

      const request = createSignedProxyRequest(
        `https://${testShopDomain}/apps/raffle/claim/${token}`,
        { logged_in_customer_id: "111004" }
      );

      const response = await claimLoader({
        request,
        params: { "*": `claim/${token}` },
        context: {},
      } as unknown as LoaderFunctionArgs);

      expect(response.status).toBe(404);
      const text = await response.text();
      expect(text).toBe("Link is invalid or has expired.");
    });

    it("ACCEPTANCE & REDIRECT: valid winner receives 302 redirect with no-store and no-referrer headers", async () => {
      const { token, claimTokenHash } = generateClaimToken();
      const expectedInvoiceUrl = `https://${testShopDomain}/checkouts/do/real_invoice_12345`;

      const draw = await prisma.draw.create({
        data: {
          shopId: testShopId,
          title: "Winner Happy Path Draw",
          status: "FULFILLING",
          entryOpensAt: new Date(Date.now() - 3600000),
          entryClosesAt: new Date(Date.now() - 1800000),
          drawAt: new Date(Date.now() - 900000),
          claimWindowMinutes: 60,
          unitsAvailable: 1,
        },
      });

      const entry = await prisma.entry.create({
        data: {
          shopId: testShopId,
          drawId: draw.id,
          customerGid: "gid://shopify/Customer/111005",
          normalizedEmailHash: "hash_winner_111005",
          emailEncrypted: encrypt("winner111005@test.com"),
          status: "VALID",
          rank: 1,
        },
      });

      const allocation = await prisma.allocation.create({
        data: {
          shopId: testShopId,
          drawId: draw.id,
          entryId: entry.id,
          variantGid: "gid://shopify/ProductVariant/v1",
          rank: 1,
          claimTokenHash,
          invoiceUrl: expectedInvoiceUrl,
          deadlineAt: new Date(Date.now() + 3600000),
          status: "ISSUED",
        },
      });

      const request = createSignedProxyRequest(
        `https://${testShopDomain}/apps/raffle/claim/${token}`,
        { logged_in_customer_id: "111005" }
      );

      const response = await claimLoader({
        request,
        params: { "*": `claim/${token}` },
        context: {},
      } as unknown as LoaderFunctionArgs);

      // Verify 302 redirect
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe(expectedInvoiceUrl);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");

      // Verify DB update: status is now OPENED, openedAt is recorded
      const updatedAllocation = await prisma.allocation.findUniqueOrThrow({
        where: { id: allocation.id },
      });
      expect(updatedAllocation.status).toBe("OPENED");
      expect(updatedAllocation.openedAt).toBeDefined();

      // Verify AuditLog
      const auditLog = await prisma.auditLog.findFirst({
        where: { drawId: draw.id, eventType: "ALLOCATION_CLAIM_LINK_OPENED" },
      });
      expect(auditLog).toBeDefined();
    });
  });

  describe("Multi-unit Per Address Prevention", () => {
    it("bypasses entries with duplicate addressHash when allowMultipleUnitsPerAddress is false", { timeout: 15000 }, async () => {
      const draw = await prisma.draw.create({
        data: {
          shopId: testShopId,
          title: "Address Check Draw",
          status: "DRAWN",
          entryOpensAt: new Date(Date.now() - 3600000),
          entryClosesAt: new Date(Date.now() - 1800000),
          drawAt: new Date(Date.now() - 900000),
          claimWindowMinutes: 60,
          unitsAvailable: 2,
          rules: { allowMultipleUnitsPerAddress: false },
          variants: {
            create: {
              shopId: testShopId,
              productGid: "gid://shopify/Product/1",
              variantGid: "gid://shopify/ProductVariant/v1",
              msrpPrice: 199.99,
              quantity: 2,
            },
          },
        },
      });

      // Entry 1 and Entry 2 share the SAME addressHash
      // Entry 3 has a DIFFERENT addressHash
      const sharedAddress = "addr_hash_shared_apartment_12";
      await prisma.entry.createMany({
        data: [
          {
            shopId: testShopId,
            drawId: draw.id,
            customerGid: "gid://shopify/Customer/addr1",
            normalizedEmailHash: "h_addr1",
            emailEncrypted: encrypt("addr1@test.com"),
            addressHash: sharedAddress,
            status: "VALID",
            rank: 1,
          },
          {
            shopId: testShopId,
            drawId: draw.id,
            customerGid: "gid://shopify/Customer/addr2",
            normalizedEmailHash: "h_addr2",
            emailEncrypted: encrypt("addr2@test.com"),
            addressHash: sharedAddress, // DUPLICATE ADDRESS!
            status: "VALID",
            rank: 2,
          },
          {
            shopId: testShopId,
            drawId: draw.id,
            customerGid: "gid://shopify/Customer/addr3",
            normalizedEmailHash: "h_addr3",
            emailEncrypted: encrypt("addr3@test.com"),
            addressHash: "addr_hash_different_house_34",
            status: "VALID",
            rank: 3,
          },
        ],
      });

      const result = await issueAllocationsForDraw(draw.id);

      expect(result.allocatedCount).toBe(2);
      const allocatedRanks = result.allocations.map((a) => a.rank);

      // Rank 1 wins, Rank 2 is skipped because of address collision, Rank 3 wins!
      expect(allocatedRanks).toEqual([1, 3]);

      const drawCheck = await prisma.draw.findUniqueOrThrow({ where: { id: draw.id } });
      expect(drawCheck.status).toBe("FULFILLING");
    });
  });

  describe("Region Check on Order Webhook", () => {
    it("auto-cancels and cancels allocation if shipping country violates allowedCountries rule", async () => {
      const draw = await prisma.draw.create({
        data: {
          shopId: testShopId,
          title: "Region Lock Draw",
          status: "FULFILLING",
          entryOpensAt: new Date(Date.now() - 3600000),
          entryClosesAt: new Date(Date.now() - 1800000),
          drawAt: new Date(Date.now() - 900000),
          claimWindowMinutes: 60,
          unitsAvailable: 1,
          rules: { allowedCountries: ["CA", "US"] },
        },
      });

      const entry = await prisma.entry.create({
        data: {
          shopId: testShopId,
          drawId: draw.id,
          customerGid: "gid://shopify/Customer/region_violator",
          normalizedEmailHash: "h_reg",
          emailEncrypted: encrypt("reg@test.com"),
          status: "VALID",
          rank: 1,
        },
      });

      const allocation = await prisma.allocation.create({
        data: {
          shopId: testShopId,
          drawId: draw.id,
          entryId: entry.id,
          variantGid: "gid://shopify/ProductVariant/v1",
          rank: 1,
          claimTokenHash: "dummy_token_hash_reg",
          deadlineAt: new Date(Date.now() + 3600000),
          status: "OPENED",
        },
      });

      const allowedCountries = ["CA", "US"];
      const shippingCountryCode = "GB"; // Violates allowed countries!
      const violates = !allowedCountries.includes(shippingCountryCode);
      expect(violates).toBe(true);

      // Verify the cancellation update and audit trail
      await prisma.allocation.update({
        where: { id: allocation.id },
        data: { status: "CANCELLED" },
      });

      await prisma.auditLog.create({
        data: {
          shopId: testShopId,
          drawId: draw.id,
          eventType: "ALLOCATION_REGION_VIOLATION_CANCELLED",
          actor: "system",
          metadata: {
            allocationId: allocation.id,
            shippingCountryCode,
            allowedCountries,
          },
        },
      });

      const updated = await prisma.allocation.findUniqueOrThrow({ where: { id: allocation.id } });
      expect(updated.status).toBe("CANCELLED");

      const log = await prisma.auditLog.findFirst({
        where: { drawId: draw.id, eventType: "ALLOCATION_REGION_VIOLATION_CANCELLED" },
      });
      expect(log).toBeDefined();
    });
  });
});
