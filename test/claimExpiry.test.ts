import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import prisma from "../app/db.server";
import { encrypt } from "../app/services/encryption";
import { generateClaimToken, type ShopifyAdminClient } from "../app/services/allocationService.server";
import {
  expireAllocationAndPromoteNext,
  recordAllocationPurchase,
  runClaimExpirySweeper,
} from "../app/services/claimExpiry.server";

describe("Automatic Expiry and Waitlist Promotion (Phase 10)", { timeout: 30000 }, () => {
  let testShopId: string;
  const testShopDomain = `expiry-test-${Date.now()}.myshopify.com`;

  beforeAll(async () => {
    process.env.ENCRYPTION_MASTER_KEY = crypto.randomBytes(32).toString("base64");
    process.env.SHOPIFY_API_SECRET = "test_secret_for_expiry";

    const shop = await prisma.shop.create({
      data: {
        shopDomain: testShopDomain,
        accessToken: "shp_test_token_expiry",
      },
    });
    testShopId = shop.id;
  });

  afterAll(async () => {
    await prisma.shop.delete({ where: { id: testShopId } }).catch(() => {});
  });

  describe("Simulate Expiry Chain", () => {
    it("progresses Winner 1 expires -> Winner 2 promoted and expires -> Winner 3 promoted and buys", async () => {
      // 1. Create a draw with 1 unit available
      const draw = await prisma.draw.create({
        data: {
          shopId: testShopId,
          title: "Expiry Chain Draw",
          status: "FULFILLING",
          entryOpensAt: new Date(Date.now() - 3600000),
          entryClosesAt: new Date(Date.now() - 1800000),
          drawAt: new Date(Date.now() - 900000),
          claimWindowMinutes: 30,
          unitsAvailable: 1,
          variants: {
            create: {
              shopId: testShopId,
              productGid: "gid://shopify/Product/chain_prod",
              variantGid: "gid://shopify/ProductVariant/chain_var",
              msrpPrice: 150.0,
              quantity: 1,
            },
          },
        },
      });

      // 2. Create 3 ranked entries (Rank 1, Rank 2, Rank 3)
      const entry1 = await prisma.entry.create({
        data: {
          shopId: testShopId,
          drawId: draw.id,
          customerGid: "gid://shopify/Customer/chain_1",
          normalizedEmailHash: "h_chain_1",
          emailEncrypted: encrypt("winner1@example.com"),
          status: "VALID",
          rank: 1,
        },
      });

      const entry2 = await prisma.entry.create({
        data: {
          shopId: testShopId,
          drawId: draw.id,
          customerGid: "gid://shopify/Customer/chain_2",
          normalizedEmailHash: "h_chain_2",
          emailEncrypted: encrypt("winner2@example.com"),
          status: "VALID",
          rank: 2,
        },
      });

      const entry3 = await prisma.entry.create({
        data: {
          shopId: testShopId,
          drawId: draw.id,
          customerGid: "gid://shopify/Customer/chain_3",
          normalizedEmailHash: "h_chain_3",
          emailEncrypted: encrypt("winner3@example.com"),
          status: "VALID",
          rank: 3,
        },
      });

      // Initial allocation for Winner 1 with deadline in past
      const { claimTokenHash: tokenHash1 } = generateClaimToken();
      const alloc1 = await prisma.allocation.create({
        data: {
          shopId: testShopId,
          drawId: draw.id,
          entryId: entry1.id,
          variantGid: "gid://shopify/ProductVariant/chain_var",
          rank: 1,
          claimTokenHash: tokenHash1,
          deadlineAt: new Date(Date.now() - 5000), // expired 5s ago
          status: "ISSUED",
        },
      });

      // STEP 1: Winner 1 expires -> Winner 2 promoted
      const expire1Result = await expireAllocationAndPromoteNext(alloc1.id);
      expect(expire1Result.status).toBe("expired_and_promoted");
      expect(expire1Result.promotedRank).toBe(2);
      expect(expire1Result.promotedEntryId).toBe(entry2.id);

      // Verify alloc1 is EXPIRED in DB
      const updatedAlloc1 = await prisma.allocation.findUniqueOrThrow({ where: { id: alloc1.id } });
      expect(updatedAlloc1.status).toBe("EXPIRED");

      // Verify alloc2 is ISSUED for entry2
      const alloc2Id = expire1Result.promotedAllocationId!;
      const alloc2 = await prisma.allocation.findUniqueOrThrow({ where: { id: alloc2Id } });
      expect(alloc2.status).toBe("ISSUED");
      expect(alloc2.entryId).toBe(entry2.id);
      expect(alloc2.rank).toBe(2);

      // STEP 2: Winner 2 does not pay -> deadline arrives -> Winner 2 expires -> Winner 3 promoted
      await prisma.allocation.update({
        where: { id: alloc2Id },
        data: { deadlineAt: new Date(Date.now() - 5000) },
      });

      const expire2Result = await expireAllocationAndPromoteNext(alloc2Id);
      expect(expire2Result.status).toBe("expired_and_promoted");
      expect(expire2Result.promotedRank).toBe(3);
      expect(expire2Result.promotedEntryId).toBe(entry3.id);

      const updatedAlloc2 = await prisma.allocation.findUniqueOrThrow({ where: { id: alloc2Id } });
      expect(updatedAlloc2.status).toBe("EXPIRED");

      const alloc3Id = expire2Result.promotedAllocationId!;
      const alloc3 = await prisma.allocation.findUniqueOrThrow({ where: { id: alloc3Id } });
      expect(alloc3.status).toBe("ISSUED");
      expect(alloc3.entryId).toBe(entry3.id);
      expect(alloc3.rank).toBe(3);

      // STEP 3: Winner 3 purchases!
      const purchaseResult = await recordAllocationPurchase({
        shopDomain: testShopDomain,
        orderId: "gid://shopify/Order/order_chain_winner_3",
        tags: `raffle:${draw.id} entry:${entry3.id}`,
        customerId: "chain_3",
      });

      expect(purchaseResult.success).toBe(true);
      expect(purchaseResult.status).toBe("purchased");
      expect(purchaseResult.allocationId).toBe(alloc3Id);
      expect(purchaseResult.drawCompleted).toBe(true);

      // Verify alloc3 is PURCHASED
      const updatedAlloc3 = await prisma.allocation.findUniqueOrThrow({ where: { id: alloc3Id } });
      expect(updatedAlloc3.status).toBe("PURCHASED");
      expect(updatedAlloc3.purchasedAt).toBeDefined();

      // Verify Draw transitioned to COMPLETED
      const completedDraw = await prisma.draw.findUniqueOrThrow({ where: { id: draw.id } });
      expect(completedDraw.status).toBe("COMPLETED");

      // Verify audit logs for the full chain
      const auditLogs = await prisma.auditLog.findMany({
        where: { drawId: draw.id },
        orderBy: { createdAt: "asc" },
      });
      const eventTypes = auditLogs.map((l) => l.eventType);
      expect(eventTypes).toContain("ALLOCATION_EXPIRED");
      expect(eventTypes).toContain("ALLOCATION_PROMOTED_FROM_WAITLIST");
      expect(eventTypes).toContain("ALLOCATION_PURCHASED");
      expect(eventTypes).toContain("DRAW_COMPLETED");
    });
  });

  describe("Concurrency & Race Conditions", () => {
    it("two concurrent invocations promote exactly one person", async () => {
      const draw = await prisma.draw.create({
        data: {
          shopId: testShopId,
          title: "Concurrent Expiry Draw",
          status: "FULFILLING",
          entryOpensAt: new Date(Date.now() - 3600000),
          entryClosesAt: new Date(Date.now() - 1800000),
          drawAt: new Date(Date.now() - 900000),
          claimWindowMinutes: 30,
          unitsAvailable: 1,
          variants: {
            create: {
              shopId: testShopId,
              productGid: "gid://shopify/Product/concurrent_prod",
              variantGid: "gid://shopify/ProductVariant/concurrent_var",
              msrpPrice: 200.0,
              quantity: 1,
            },
          },
        },
      });

      const entry1 = await prisma.entry.create({
        data: {
          shopId: testShopId,
          drawId: draw.id,
          customerGid: "gid://shopify/Customer/conc_1",
          normalizedEmailHash: "h_conc_1",
          emailEncrypted: encrypt("conc1@example.com"),
          status: "VALID",
          rank: 1,
        },
      });

      await prisma.entry.create({
        data: {
          shopId: testShopId,
          drawId: draw.id,
          customerGid: "gid://shopify/Customer/conc_2",
          normalizedEmailHash: "h_conc_2",
          emailEncrypted: encrypt("conc2@example.com"),
          status: "VALID",
          rank: 2,
        },
      });

      await prisma.entry.create({
        data: {
          shopId: testShopId,
          drawId: draw.id,
          customerGid: "gid://shopify/Customer/conc_3",
          normalizedEmailHash: "h_conc_3",
          emailEncrypted: encrypt("conc3@example.com"),
          status: "VALID",
          rank: 3,
        },
      });

      const { claimTokenHash } = generateClaimToken();
      const alloc1 = await prisma.allocation.create({
        data: {
          shopId: testShopId,
          drawId: draw.id,
          entryId: entry1.id,
          variantGid: "gid://shopify/ProductVariant/concurrent_var",
          rank: 1,
          claimTokenHash,
          deadlineAt: new Date(Date.now() - 5000),
          status: "ISSUED",
        },
      });

      // Fire two concurrent expiry operations on alloc1
      const [res1, res2] = await Promise.all([
        expireAllocationAndPromoteNext(alloc1.id),
        expireAllocationAndPromoteNext(alloc1.id),
      ]);

      const statuses = [res1.status, res2.status];
      expect(statuses).toContain("expired_and_promoted");
      expect(statuses).toContain("already_resolved");

      // Verify that EXACTLY 1 new allocation was issued (total allocations = 2)
      const totalAllocations = await prisma.allocation.findMany({
        where: { drawId: draw.id },
      });
      expect(totalAllocations).toHaveLength(2);

      const promotedAlloc = totalAllocations.find((a) => a.id !== alloc1.id)!;
      expect(promotedAlloc.rank).toBe(2);
      expect(promotedAlloc.status).toBe("ISSUED");
    });

    it("someone who already won is never promoted again", async () => {
      const draw = await prisma.draw.create({
        data: {
          shopId: testShopId,
          title: "Never Re-promote Draw",
          status: "FULFILLING",
          entryOpensAt: new Date(Date.now() - 3600000),
          entryClosesAt: new Date(Date.now() - 1800000),
          drawAt: new Date(Date.now() - 900000),
          claimWindowMinutes: 30,
          unitsAvailable: 1,
          variants: {
            create: {
              shopId: testShopId,
              productGid: "gid://shopify/Product/reprom_prod",
              variantGid: "gid://shopify/ProductVariant/reprom_var",
              msrpPrice: 120.0,
              quantity: 1,
            },
          },
        },
      });

      const entry1 = await prisma.entry.create({
        data: {
          shopId: testShopId,
          drawId: draw.id,
          customerGid: "gid://shopify/Customer/reprom_1",
          normalizedEmailHash: "h_reprom_1",
          emailEncrypted: encrypt("reprom1@example.com"),
          status: "VALID",
          rank: 1,
        },
      });

      const entry2 = await prisma.entry.create({
        data: {
          shopId: testShopId,
          drawId: draw.id,
          customerGid: "gid://shopify/Customer/reprom_2",
          normalizedEmailHash: "h_reprom_2",
          emailEncrypted: encrypt("reprom2@example.com"),
          status: "VALID",
          rank: 2,
        },
      });

      const { claimTokenHash: th1 } = generateClaimToken();
      const alloc1 = await prisma.allocation.create({
        data: {
          shopId: testShopId,
          drawId: draw.id,
          entryId: entry1.id,
          variantGid: "gid://shopify/ProductVariant/reprom_var",
          rank: 1,
          claimTokenHash: th1,
          deadlineAt: new Date(Date.now() - 5000),
          status: "ISSUED",
        },
      });

      // Expire Winner 1 -> Winner 2 promoted
      const res1 = await expireAllocationAndPromoteNext(alloc1.id);
      expect(res1.status).toBe("expired_and_promoted");
      expect(res1.promotedEntryId).toBe(entry2.id);

      // Now expire Winner 2 -> Winner 1 must NOT be promoted; waitlist is exhausted
      const alloc2Id = res1.promotedAllocationId!;
      await prisma.allocation.update({
        where: { id: alloc2Id },
        data: { deadlineAt: new Date(Date.now() - 5000) },
      });

      const res2 = await expireAllocationAndPromoteNext(alloc2Id);
      expect(res2.status).toBe("expired_waitlist_exhausted");

      // Verify no allocation was created for entry1 again
      const entry1Allocs = await prisma.allocation.findMany({
        where: { drawId: draw.id, entryId: entry1.id },
      });
      expect(entry1Allocs).toHaveLength(1);
    });

    it("payment-at-deadline race condition: completed draft order preserves purchase over expiry", async () => {
      const draw = await prisma.draw.create({
        data: {
          shopId: testShopId,
          title: "Payment Race Draw",
          status: "FULFILLING",
          entryOpensAt: new Date(Date.now() - 3600000),
          entryClosesAt: new Date(Date.now() - 1800000),
          drawAt: new Date(Date.now() - 900000),
          claimWindowMinutes: 30,
          unitsAvailable: 1,
          variants: {
            create: {
              shopId: testShopId,
              productGid: "gid://shopify/Product/race_prod",
              variantGid: "gid://shopify/ProductVariant/race_var",
              msrpPrice: 199.99,
              quantity: 1,
            },
          },
        },
      });

      const entry1 = await prisma.entry.create({
        data: {
          shopId: testShopId,
          drawId: draw.id,
          customerGid: "gid://shopify/Customer/race_1",
          normalizedEmailHash: "h_race_1",
          emailEncrypted: encrypt("race1@example.com"),
          status: "VALID",
          rank: 1,
        },
      });

      const { claimTokenHash } = generateClaimToken();
      const alloc1 = await prisma.allocation.create({
        data: {
          shopId: testShopId,
          drawId: draw.id,
          entryId: entry1.id,
          variantGid: "gid://shopify/ProductVariant/race_var",
          rank: 1,
          claimTokenHash,
          draftOrderGid: "gid://shopify/DraftOrder/real-12345",
          deadlineAt: new Date(Date.now() - 1000),
          status: "ISSUED",
        },
      });

      // Mock admin client where Shopify reports draft order was paid right at the deadline
      let draftOrderDeleteCalled = false;
      const mockAdmin = {
        graphql: async (query: string) => {
          if (query.includes("getDraftOrder")) {
            return {
              json: async () => ({
                data: {
                  draftOrder: {
                    id: "gid://shopify/DraftOrder/real-12345",
                    status: "COMPLETED",
                    order: {
                      id: "gid://shopify/Order/just-paid-123",
                      displayFinancialStatus: "PAID",
                    },
                  },
                },
              }),
            };
          }
          if (query.includes("draftOrderDelete")) {
            draftOrderDeleteCalled = true;
            return { json: async () => ({ data: { draftOrderDelete: { deletedId: "real-12345" } } }) };
          }
          return { json: async () => ({}) };
        },
      };

      const result = await expireAllocationAndPromoteNext(alloc1.id, {
        admin: mockAdmin as unknown as ShopifyAdminClient,
      });

      // Payment won race!
      expect(result.status).toBe("payment_won_race");
      // Draft order must NOT have been deleted
      expect(draftOrderDeleteCalled).toBe(false);

      // Allocation must be marked PURCHASED
      const updatedAlloc = await prisma.allocation.findUniqueOrThrow({ where: { id: alloc1.id } });
      expect(updatedAlloc.status).toBe("PURCHASED");

      // Draw should now be COMPLETED because the single unit was claimed
      const updatedDraw = await prisma.draw.findUniqueOrThrow({ where: { id: draw.id } });
      expect(updatedDraw.status).toBe("COMPLETED");

      // Audit log must record the payment race event
      const auditLog = await prisma.auditLog.findFirst({
        where: { drawId: draw.id, eventType: "ALLOCATION_PURCHASED_AT_DEADLINE_RACE" },
      });
      expect(auditLog).toBeDefined();
    });
  });

  describe("Waitlist Exhaustion Edge Case", () => {
    it("marks remaining units unsold and transitions draw to COMPLETED when waitlist exhausts", async () => {
      const draw = await prisma.draw.create({
        data: {
          shopId: testShopId,
          title: "Waitlist Exhaustion Draw",
          status: "FULFILLING",
          entryOpensAt: new Date(Date.now() - 3600000),
          entryClosesAt: new Date(Date.now() - 1800000),
          drawAt: new Date(Date.now() - 900000),
          claimWindowMinutes: 30,
          unitsAvailable: 2, // 2 units available, but only 1 entry total
          variants: {
            create: {
              shopId: testShopId,
              productGid: "gid://shopify/Product/exhaust_prod",
              variantGid: "gid://shopify/ProductVariant/exhaust_var",
              msrpPrice: 100.0,
              quantity: 2,
            },
          },
        },
      });

      const entry1 = await prisma.entry.create({
        data: {
          shopId: testShopId,
          drawId: draw.id,
          customerGid: "gid://shopify/Customer/exhaust_1",
          normalizedEmailHash: "h_exhaust_1",
          emailEncrypted: encrypt("exhaust1@example.com"),
          status: "VALID",
          rank: 1,
        },
      });

      const { claimTokenHash } = generateClaimToken();
      const alloc1 = await prisma.allocation.create({
        data: {
          shopId: testShopId,
          drawId: draw.id,
          entryId: entry1.id,
          variantGid: "gid://shopify/ProductVariant/exhaust_var",
          rank: 1,
          claimTokenHash,
          deadlineAt: new Date(Date.now() - 5000),
          status: "ISSUED",
        },
      });

      const result = await expireAllocationAndPromoteNext(alloc1.id);
      expect(result.status).toBe("expired_waitlist_exhausted");

      const updatedDraw = await prisma.draw.findUniqueOrThrow({ where: { id: draw.id } });
      expect(updatedDraw.status).toBe("COMPLETED");

      const auditLog = await prisma.auditLog.findFirst({
        where: { drawId: draw.id, eventType: "DRAW_WAITLIST_EXHAUSTED" },
      });
      expect(auditLog).toBeDefined();
      expect((auditLog?.metadata as Record<string, unknown>)?.unsoldUnits).toBe(2);
    });
  });

  describe("Webhook Idempotency", () => {
    it("stores webhook event ID and rejects duplicate webhooks idempotently", async () => {
      const draw = await prisma.draw.create({
        data: {
          shopId: testShopId,
          title: "Webhook Idempotency Draw",
          status: "FULFILLING",
          entryOpensAt: new Date(Date.now() - 3600000),
          entryClosesAt: new Date(Date.now() - 1800000),
          drawAt: new Date(Date.now() - 900000),
          claimWindowMinutes: 30,
          unitsAvailable: 1,
        },
      });

      const entry = await prisma.entry.create({
        data: {
          shopId: testShopId,
          drawId: draw.id,
          customerGid: "gid://shopify/Customer/wh_idemp_1",
          normalizedEmailHash: "h_wh_idemp_1",
          emailEncrypted: encrypt("wh1@example.com"),
          status: "VALID",
          rank: 1,
        },
      });

      const { claimTokenHash } = generateClaimToken();
      await prisma.allocation.create({
        data: {
          shopId: testShopId,
          drawId: draw.id,
          entryId: entry.id,
          variantGid: "gid://shopify/ProductVariant/wh_var",
          rank: 1,
          claimTokenHash,
          deadlineAt: new Date(Date.now() + 3600000),
          status: "OPENED",
        },
      });

      const eventId = `test_wh_event_${Date.now()}`;

      // First webhook delivery
      const res1 = await recordAllocationPurchase({
        shopDomain: testShopDomain,
        orderId: "gid://shopify/Order/wh_order_100",
        tags: `raffle:${draw.id} entry:${entry.id}`,
        webhookEventId: eventId,
        topic: "orders/paid",
        customerId: "wh_idemp_1",
      });

      expect(res1.success).toBe(true);
      expect(res1.status).toBe("purchased");

      // Second webhook delivery with SAME eventId (Shopify retry or duplicate)
      const res2 = await recordAllocationPurchase({
        shopDomain: testShopDomain,
        orderId: "gid://shopify/Order/wh_order_100",
        tags: `raffle:${draw.id} entry:${entry.id}`,
        webhookEventId: eventId,
        topic: "orders/paid",
        customerId: "wh_idemp_1",
      });

      expect(res2.success).toBe(true);
      expect(res2.status).toBe("duplicate_webhook");

      // Verify only 1 WebhookEvent record exists in DB
      const webhookEvents = await prisma.webhookEvent.findMany({
        where: { eventId },
      });
      expect(webhookEvents).toHaveLength(1);

      // Verify only 1 ALLOCATION_PURCHASED audit log exists
      const purchaseLogs = await prisma.auditLog.findMany({
        where: { drawId: draw.id, eventType: "ALLOCATION_PURCHASED" },
      });
      expect(purchaseLogs).toHaveLength(1);
    });
  });

  describe("Self-Scheduling Sweeper", () => {
    it("sweeps and expires overdue allocations across all active draws", async () => {
      const draw = await prisma.draw.create({
        data: {
          shopId: testShopId,
          title: "Sweeper Test Draw",
          status: "FULFILLING",
          entryOpensAt: new Date(Date.now() - 3600000),
          entryClosesAt: new Date(Date.now() - 1800000),
          drawAt: new Date(Date.now() - 900000),
          claimWindowMinutes: 30,
          unitsAvailable: 1,
          variants: {
            create: {
              shopId: testShopId,
              productGid: "gid://shopify/Product/sweep_prod",
              variantGid: "gid://shopify/ProductVariant/sweep_var",
              msrpPrice: 75.0,
              quantity: 1,
            },
          },
        },
      });

      const entry1 = await prisma.entry.create({
        data: {
          shopId: testShopId,
          drawId: draw.id,
          customerGid: "gid://shopify/Customer/sweep_1",
          normalizedEmailHash: "h_sweep_1",
          emailEncrypted: encrypt("sweep1@example.com"),
          status: "VALID",
          rank: 1,
        },
      });

      const entry2 = await prisma.entry.create({
        data: {
          shopId: testShopId,
          drawId: draw.id,
          customerGid: "gid://shopify/Customer/sweep_2",
          normalizedEmailHash: "h_sweep_2",
          emailEncrypted: encrypt("sweep2@example.com"),
          status: "VALID",
          rank: 2,
        },
      });

      const { claimTokenHash } = generateClaimToken();
      await prisma.allocation.create({
        data: {
          shopId: testShopId,
          drawId: draw.id,
          entryId: entry1.id,
          variantGid: "gid://shopify/ProductVariant/sweep_var",
          rank: 1,
          claimTokenHash,
          deadlineAt: new Date(Date.now() - 10000), // Overdue by 10 seconds
          status: "ISSUED",
        },
      });

      const sweepResult = await runClaimExpirySweeper();
      expect(sweepResult.expiredCount).toBeGreaterThanOrEqual(1);
      expect(sweepResult.promotedCount).toBeGreaterThanOrEqual(1);

      // Verify entry2 now has an allocation
      const promotedAlloc = await prisma.allocation.findFirst({
        where: { drawId: draw.id, entryId: entry2.id },
      });
      expect(promotedAlloc).toBeDefined();
      expect(promotedAlloc?.status).toBe("ISSUED");
    });
  });
});
