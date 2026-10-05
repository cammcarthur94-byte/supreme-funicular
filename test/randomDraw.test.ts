import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import prisma from "../app/db.server";
import {
  secureFisherYatesShuffle,
  computeCommitmentHash,
  executeRandomDraw,
} from "../app/services/randomDraw.server";

describe("Random Draw Service (Phase 8)", () => {
  describe("Cryptographically Secure Fisher-Yates Shuffle", () => {
    it("uses CSPRNG (calls randomInt with expected upper bounds in sequence)", () => {
      const mockCalls: number[] = [];
      const mockRandomInt = vi.fn((max: number) => {
        mockCalls.push(max);
        return 0; // Deterministic selection of 0 for testing call contract
      });

      const items = ["a", "b", "c", "d", "e"];
      secureFisherYatesShuffle(items, mockRandomInt);

      // For an array of 5 elements, it should iterate from i = 4 down to 1
      // and call randomInt with i + 1 (i.e. bounds 5, 4, 3, 2)
      expect(mockRandomInt).toHaveBeenCalledTimes(4);
      expect(mockCalls).toEqual([5, 4, 3, 2]);
    });

    it("does not call Math.random", () => {
      const mathRandomSpy = vi.spyOn(Math, "random");
      const items = [1, 2, 3, 4, 5];
      secureFisherYatesShuffle(items);
      expect(mathRandomSpy).not.toHaveBeenCalled();
      mathRandomSpy.mockRestore();
    });

    it("correctly permutes elements deterministically given mock randomInt indices", () => {
      // Mock returns specific indices:
      // i = 3, max = 4 -> return 1 (swaps items[3] with items[1])
      // i = 2, max = 3 -> return 0 (swaps items[2] with items[0])
      // i = 1, max = 2 -> return 1 (swaps items[1] with items[1])
      const mockRandomInt = vi.fn()
        .mockReturnValueOnce(1)
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(1);

      const items = ["A", "B", "C", "D"];
      const shuffled = secureFisherYatesShuffle(items, mockRandomInt);

      // Trace:
      // Start: [A, B, C, D]
      // i=3: swap items[3](D) with items[1](B) -> [A, D, C, B]
      // i=2: swap items[2](C) with items[0](A) -> [C, D, A, B]
      // i=1: swap items[1](D) with items[1](D) -> [C, D, A, B]
      expect(shuffled).toEqual(["C", "D", "A", "B"]);
      // Original array remains unmodified (pure function)
      expect(items).toEqual(["A", "B", "C", "D"]);
    });

    it("handles 0 and 1 element arrays gracefully", () => {
      expect(secureFisherYatesShuffle([])).toEqual([]);
      expect(secureFisherYatesShuffle(["single"])).toEqual(["single"]);
    });

    it("throws RangeError if randomIntFn returns out-of-range index", () => {
      const badRandomInt = () => 999;
      expect(() => secureFisherYatesShuffle([1, 2, 3], badRandomInt)).toThrow(RangeError);
    });
  });

  describe("Commitment Hash", () => {
    it("produces deterministic SHA-256 hex string regardless of input order", () => {
      const idsOrder1 = ["entry-3", "entry-1", "entry-2"];
      const idsOrder2 = ["entry-1", "entry-2", "entry-3"];
      const idsOrder3 = ["entry-2", "entry-3", "entry-1"];

      const hash1 = computeCommitmentHash(idsOrder1);
      const hash2 = computeCommitmentHash(idsOrder2);
      const hash3 = computeCommitmentHash(idsOrder3);

      expect(hash1).toHaveLength(64);
      expect(hash1).toBe(hash2);
      expect(hash2).toBe(hash3);
    });

    it("changes output hash if entry IDs change", () => {
      const hashA = computeCommitmentHash(["entry-1", "entry-2"]);
      const hashB = computeCommitmentHash(["entry-1", "entry-3"]);
      expect(hashA).not.toBe(hashB);
    });
  });

  describe("Database Integration & Acceptance Suite", () => {
    let testShopId: string;
    const testDomain = `test-draw-${Date.now()}.myshopify.com`;

    beforeAll(async () => {
      const shop = await prisma.shop.create({
        data: {
          shopDomain: testDomain,
          accessToken: "shp_test_token",
        },
      });
      testShopId = shop.id;
    });

    afterAll(async () => {
      await prisma.shop.delete({ where: { id: testShopId } }).catch(() => {});
    });

    it("ACCEPTANCE: runs draw with 100 fake entries, allocating exactly 25 winners and 75 waitlist", async () => {
      const pastTime = new Date(Date.now() - 3600000); // 1 hour ago
      const draw = await prisma.draw.create({
        data: {
          shopId: testShopId,
          title: "Acceptance Test Draw 100",
          status: "CLOSED",
          entryOpensAt: new Date(pastTime.getTime() - 7200000),
          entryClosesAt: new Date(pastTime.getTime() - 3600000),
          drawAt: pastTime,
          claimWindowMinutes: 60,
          unitsAvailable: 25,
        },
      });

      // Insert 100 entries
      const entryData = Array.from({ length: 100 }, (_, i) => ({
        shopId: testShopId,
        drawId: draw.id,
        customerGid: `gid://shopify/Customer/10000${i}`,
        normalizedEmailHash: crypto.createHash("sha256").update(`user${i}@example.com`).digest("hex"),
        emailEncrypted: `encrypted_email_${i}`,
        status: "VALID" as const,
      }));

      await prisma.entry.createMany({ data: entryData });

      // Execute random draw
      const result = await executeRandomDraw(draw.id, { now: new Date() });

      expect(result.status).toBe("drawn");
      expect(result.totalEligible).toBe(100);
      expect(result.winnersCount).toBe(25);
      expect(result.waitlistCount).toBe(75);
      expect(result.unsoldUnits).toBe(0);
      expect(result.commitmentHash).toBeDefined();
      expect(result.commitmentHash).toHaveLength(64);

      // Verify Draw in DB
      const updatedDraw = await prisma.draw.findUniqueOrThrow({ where: { id: draw.id } });
      expect(updatedDraw.status).toBe("DRAWN");
      expect(updatedDraw.commitmentHash).toBe(result.commitmentHash);

      // Verify Entries in DB
      const entries = await prisma.entry.findMany({
        where: { drawId: draw.id },
        select: { id: true, rank: true },
      });

      expect(entries).toHaveLength(100);
      const ranks = entries.map((e) => e.rank);

      // Every entry must receive a non-null rank
      expect(ranks.every((r) => typeof r === "number")).toBe(true);

      // Every entry must receive a UNIQUE rank from 1 to 100
      const uniqueRanks = new Set(ranks);
      expect(uniqueRanks.size).toBe(100);
      expect(Math.min(...(ranks as number[]))).toBe(1);
      expect(Math.max(...(ranks as number[]))).toBe(100);

      // Exactly 25 winners (ranks 1..25)
      const winners = entries.filter((e) => (e.rank as number) <= 25);
      expect(winners).toHaveLength(25);

      // Exactly 75 waitlist (ranks 26..100)
      const waitlist = entries.filter((e) => (e.rank as number) > 25);
      expect(waitlist).toHaveLength(75);

      // Verify AuditLogs
      const auditLogs = await prisma.auditLog.findMany({
        where: { drawId: draw.id },
      });
      const eventTypes = auditLogs.map((l) => l.eventType);
      expect(eventTypes).toContain("DRAW_COMMITMENT_RECORDED");
      expect(eventTypes).toContain("DRAW_EXECUTED");
    });

    it("IDEMPOTENCY: running the draw job twice does not re-shuffle or modify ranks", async () => {
      const pastTime = new Date(Date.now() - 3600000);
      const draw = await prisma.draw.create({
        data: {
          shopId: testShopId,
          title: "Idempotency Test Draw",
          status: "CLOSED",
          entryOpensAt: new Date(pastTime.getTime() - 7200000),
          entryClosesAt: new Date(pastTime.getTime() - 3600000),
          drawAt: pastTime,
          claimWindowMinutes: 30,
          unitsAvailable: 2,
        },
      });

      await prisma.entry.createMany({
        data: [
          {
            shopId: testShopId,
            drawId: draw.id,
            customerGid: "gid://shopify/Customer/idemp1",
            normalizedEmailHash: "hash_idemp1",
            emailEncrypted: "enc_idemp1",
            status: "VALID",
          },
          {
            shopId: testShopId,
            drawId: draw.id,
            customerGid: "gid://shopify/Customer/idemp2",
            normalizedEmailHash: "hash_idemp2",
            emailEncrypted: "enc_idemp2",
            status: "VALID",
          },
          {
            shopId: testShopId,
            drawId: draw.id,
            customerGid: "gid://shopify/Customer/idemp3",
            normalizedEmailHash: "hash_idemp3",
            emailEncrypted: "enc_idemp3",
            status: "VALID",
          },
        ],
      });

      // First run
      const firstRun = await executeRandomDraw(draw.id, { now: new Date() });
      expect(firstRun.status).toBe("drawn");

      const entriesAfterFirstRun = await prisma.entry.findMany({
        where: { drawId: draw.id },
        select: { id: true, rank: true },
        orderBy: { id: "asc" },
      });

      // Second run (simulating duplicate webhook / QStash retry)
      const secondRun = await executeRandomDraw(draw.id, { now: new Date() });
      expect(secondRun.status).toBe("already_drawn");

      const entriesAfterSecondRun = await prisma.entry.findMany({
        where: { drawId: draw.id },
        select: { id: true, rank: true },
        orderBy: { id: "asc" },
      });

      // Ranks must be completely untouched
      expect(entriesAfterSecondRun).toEqual(entriesAfterFirstRun);
    });

    it("EDGE CASE: fewer entries than units (allocates all entries as winners and flags unsold units)", async () => {
      const pastTime = new Date(Date.now() - 3600000);
      const draw = await prisma.draw.create({
        data: {
          shopId: testShopId,
          title: "Fewer Entries Draw",
          status: "CLOSED",
          entryOpensAt: new Date(pastTime.getTime() - 7200000),
          entryClosesAt: new Date(pastTime.getTime() - 3600000),
          drawAt: pastTime,
          claimWindowMinutes: 30,
          unitsAvailable: 10, // 10 units available
        },
      });

      // Only 3 entries exist
      await prisma.entry.createMany({
        data: [
          {
            shopId: testShopId,
            drawId: draw.id,
            customerGid: "gid://shopify/Customer/few1",
            normalizedEmailHash: "hash_few1",
            emailEncrypted: "enc_few1",
            status: "VALID",
          },
          {
            shopId: testShopId,
            drawId: draw.id,
            customerGid: "gid://shopify/Customer/few2",
            normalizedEmailHash: "hash_few2",
            emailEncrypted: "enc_few2",
            status: "VALID",
          },
          {
            shopId: testShopId,
            drawId: draw.id,
            customerGid: "gid://shopify/Customer/few3",
            normalizedEmailHash: "hash_few3",
            emailEncrypted: "enc_few3",
            status: "VALID",
          },
        ],
      });

      const result = await executeRandomDraw(draw.id, { now: new Date() });
      expect(result.status).toBe("drawn");
      expect(result.totalEligible).toBe(3);
      expect(result.winnersCount).toBe(3);
      expect(result.waitlistCount).toBe(0);
      expect(result.unsoldUnits).toBe(7); // 10 - 3 = 7 unsold units

      // All 3 receive ranks 1..3
      const entries = await prisma.entry.findMany({ where: { drawId: draw.id } });
      const ranks = entries.map((e) => e.rank).sort();
      expect(ranks).toEqual([1, 2, 3]);

      // Unsold units audit log created
      const auditLog = await prisma.auditLog.findFirst({
        where: { drawId: draw.id, eventType: "DRAW_UNSOLD_UNITS_FLAGGED" },
      });
      expect(auditLog).toBeDefined();
      expect((auditLog?.metadata as Record<string, unknown>)?.unsoldUnits).toBe(7);
    });

    it("EDGE CASE: zero entries (transitions directly to COMPLETED and records audit log)", async () => {
      const pastTime = new Date(Date.now() - 3600000);
      const draw = await prisma.draw.create({
        data: {
          shopId: testShopId,
          title: "Zero Entries Draw",
          status: "CLOSED",
          entryOpensAt: new Date(pastTime.getTime() - 7200000),
          entryClosesAt: new Date(pastTime.getTime() - 3600000),
          drawAt: pastTime,
          claimWindowMinutes: 30,
          unitsAvailable: 5,
        },
      });

      const result = await executeRandomDraw(draw.id, { now: new Date() });
      expect(result.status).toBe("completed_zero_entries");
      expect(result.totalEligible).toBe(0);
      expect(result.winnersCount).toBe(0);
      expect(result.unsoldUnits).toBe(5);

      const updatedDraw = await prisma.draw.findUniqueOrThrow({ where: { id: draw.id } });
      expect(updatedDraw.status).toBe("COMPLETED");

      const auditLog = await prisma.auditLog.findFirst({
        where: { drawId: draw.id, eventType: "DRAW_COMPLETED_ZERO_ENTRIES" },
      });
      expect(auditLog).toBeDefined();
    });

    it("TIMING GUARD: returns not_due if scheduled drawAt has not arrived", async () => {
      const futureTime = new Date(Date.now() + 3600000); // 1 hour in future
      const draw = await prisma.draw.create({
        data: {
          shopId: testShopId,
          title: "Future Draw",
          status: "CLOSED",
          entryOpensAt: new Date(Date.now() - 7200000),
          entryClosesAt: new Date(Date.now() - 3600000),
          drawAt: futureTime,
          claimWindowMinutes: 30,
          unitsAvailable: 5,
        },
      });

      const result = await executeRandomDraw(draw.id, { now: new Date() });
      expect(result.status).toBe("not_due");

      const drawCheck = await prisma.draw.findUniqueOrThrow({ where: { id: draw.id } });
      expect(drawCheck.status).toBe("CLOSED");
    });

    it("ELIGIBILITY FILTERING: only ranks VALID and merchant-approved FLAGGED entries", async () => {
      const pastTime = new Date(Date.now() - 3600000);
      const draw = await prisma.draw.create({
        data: {
          shopId: testShopId,
          title: "Filtering Test Draw",
          status: "CLOSED",
          entryOpensAt: new Date(pastTime.getTime() - 7200000),
          entryClosesAt: new Date(pastTime.getTime() - 3600000),
          drawAt: pastTime,
          claimWindowMinutes: 30,
          unitsAvailable: 5,
        },
      });

      await prisma.entry.createMany({
        data: [
          {
            shopId: testShopId,
            drawId: draw.id,
            customerGid: "gid://shopify/Customer/f1",
            normalizedEmailHash: "h1",
            emailEncrypted: "e1",
            status: "VALID",
          },
          {
            shopId: testShopId,
            drawId: draw.id,
            customerGid: "gid://shopify/Customer/f2",
            normalizedEmailHash: "h2",
            emailEncrypted: "e2",
            status: "FLAGGED",
            riskFlags: ["MERCHANT_APPROVED"],
          },
          {
            shopId: testShopId,
            drawId: draw.id,
            customerGid: "gid://shopify/Customer/f3",
            normalizedEmailHash: "h3",
            emailEncrypted: "e3",
            status: "FLAGGED",
            riskFlags: ["GEO_IP_MISMATCH"], // NOT approved
          },
          {
            shopId: testShopId,
            drawId: draw.id,
            customerGid: "gid://shopify/Customer/f4",
            normalizedEmailHash: "h4",
            emailEncrypted: "e4",
            status: "DISQUALIFIED",
          },
          {
            shopId: testShopId,
            drawId: draw.id,
            customerGid: "gid://shopify/Customer/f5",
            normalizedEmailHash: "h5",
            emailEncrypted: "e5",
            status: "REJECTED",
          },
        ],
      });

      const result = await executeRandomDraw(draw.id, { now: new Date() });
      expect(result.status).toBe("drawn");
      expect(result.totalEligible).toBe(2); // Only f1 and f2
      expect(result.winnersCount).toBe(2);

      // Verify unapproved/disqualified entries have null rank
      const f3 = await prisma.entry.findFirst({ where: { drawId: draw.id, customerGid: "gid://shopify/Customer/f3" } });
      const f4 = await prisma.entry.findFirst({ where: { drawId: draw.id, customerGid: "gid://shopify/Customer/f4" } });
      const f5 = await prisma.entry.findFirst({ where: { drawId: draw.id, customerGid: "gid://shopify/Customer/f5" } });
      expect(f3?.rank).toBeNull();
      expect(f4?.rank).toBeNull();
      expect(f5?.rank).toBeNull();
    });
  });
});
