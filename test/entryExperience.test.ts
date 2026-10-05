import { beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { verifyAppProxyRequest } from "../app/services/appProxy.server";
import { isEntryWindowOpen } from "../app/services/entryWindow";
import { applyDrawLifecycleAction } from "../app/services/drawLifecycle.server";
import prisma from "../app/db.server";
import dotenv from "dotenv";

dotenv.config();

function signedProxyUrl(query: Record<string, string>, secret: string) {
  const params = new URLSearchParams(query);
  const message = [...params.keys()].sort().map((key) => `${key}=${params.getAll(key).join(",")}`).join("");
  params.set("signature", crypto.createHmac("sha256", secret).update(message).digest("hex"));
  return `https://app.example.test/apps/raffle/draw/abc?${params.toString()}`;
}

describe("customer entry experience", () => {
  const secret = "proxy-test-secret";
  const closesAt = new Date("2026-10-04T12:00:00.000Z");
  const opensAt = new Date("2026-10-04T11:00:00.000Z");

  beforeEach(() => {
    process.env.SHOPIFY_API_SECRET = secret;
    vi.restoreAllMocks();
  });

  it("allows an entry at closesAt - 1ms and rejects at closesAt", () => {
    expect(isEntryWindowOpen("OPEN", new Date(closesAt.getTime() - 1), opensAt, closesAt)).toBe(true);
    expect(isEntryWindowOpen("OPEN", closesAt, opensAt, closesAt)).toBe(false);
  });

  it("rejects unsigned or modified proxy requests", () => {
    const base = {
      shop: "example.myshopify.com",
      logged_in_customer_id: "12345",
      path_prefix: "/apps/raffle",
      timestamp: String(Math.floor(Date.now() / 1000)),
    };
    expect(verifyAppProxyRequest(new Request("https://app.example.test/apps/raffle/draw/abc"))).toBeNull();
    const signed = signedProxyUrl(base, secret);
    expect(verifyAppProxyRequest(new Request(signed))?.customerId).toBe("12345");
    const changed = new URL(signed);
    changed.searchParams.set("logged_in_customer_id", "99999");
    expect(verifyAppProxyRequest(new Request(changed))).toBeNull();
  });

  it("opens a scheduled draw based on server time after a delayed job", async () => {
    const drawId = "a4ee8c10-8c50-4d8f-8b8f-e51bf95387bd";
    const update = vi.spyOn(prisma.draw, "update").mockResolvedValue({} as never);
    const rawQuery = vi.fn(async (strings: TemplateStringsArray) => {
      if (strings[0].includes('SELECT "id"')) {
        return [{ id: drawId, status: "SCHEDULED", entryOpensAt: opensAt, entryClosesAt: closesAt }];
      }
      return [{ now: new Date(opensAt.getTime() + 1) }];
    });
    vi.spyOn(prisma, "$transaction").mockImplementation((async (callback: (tx: unknown) => Promise<unknown>) =>
      (callback as (tx: unknown) => Promise<unknown>)({ $queryRaw: rawQuery, draw: { update } })) as never);

    expect(await applyDrawLifecycleAction(drawId, "open", opensAt)).toBe("updated");
    expect(update).toHaveBeenCalledWith({ where: { id: drawId }, data: { status: "OPEN" } });
  });

  it.runIf(Boolean(process.env.DATABASE_URL))("allows only one entry for concurrent transactions", async () => {
    const shopDomain = `phase5-${crypto.randomUUID()}.myshopify.com`;
    const shop = await prisma.shop.create({ data: { shopDomain, accessToken: "phase5-test-token" } });
    let drawId: string | undefined;
    try {
      const now = new Date();
      const draw = await prisma.draw.create({
        data: {
          shopId: shop.id,
          title: "Phase 5 concurrency test",
          status: "OPEN",
          entryOpensAt: new Date(now.getTime() - 60_000),
          entryClosesAt: new Date(now.getTime() + 60_000),
          drawAt: new Date(now.getTime() + 120_000),
          claimWindowMinutes: 30,
          unitsAvailable: 1,
          rules: {},
        },
      });
      drawId = draw.id;
      const createEntry = () => prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "raffle"."Draw" WHERE "id" = ${draw.id} FOR UPDATE`;
        const [dbTime] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
        if (dbTime.now >= draw.entryClosesAt) throw new Error("test draw unexpectedly closed");
        return tx.entry.create({
          data: {
            shopId: shop.id,
            drawId: draw.id,
            customerGid: "gid://shopify/Customer/987654321",
            normalizedEmailHash: "phase5-concurrent-email",
            emailEncrypted: "test-only-ciphertext",
          },
        });
      });
      const outcomes = await Promise.allSettled([createEntry(), createEntry()]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === "rejected" && outcome.reason?.code === "P2002")).toHaveLength(1);
      expect(await prisma.entry.count({ where: { drawId: draw.id } })).toBe(1);
    } finally {
      if (drawId) await prisma.draw.deleteMany({ where: { id: drawId } });
      await prisma.shop.delete({ where: { id: shop.id } });
    }
  });

  it("applies the row-locked lifecycle action once for concurrent deliveries", async () => {
    const drawId = "a4ee8c10-8c50-4d8f-8b8f-e51bf95387bd";
    let status = "OPEN";
    let lockTail = Promise.resolve();
    const update = vi.fn(async () => { status = "CLOSED"; return {} as never; });
    const transaction = vi.spyOn(prisma, "$transaction").mockImplementation((async (callback: (tx: unknown) => Promise<unknown>) => {
      let release!: () => void;
      const prior = lockTail;
      lockTail = new Promise<void>((resolve) => { release = resolve; });
      await prior;
      try {
        const rawQuery = async (strings: TemplateStringsArray) => {
          if (strings[0].includes('SELECT "id"')) {
            return [{ id: drawId, status, entryOpensAt: opensAt, entryClosesAt: closesAt }];
          }
          return [{ now: closesAt }];
        };
        return await callback({ $queryRaw: rawQuery, draw: { update } });
      } finally {
        release();
      }
    }) as never);

    const results = await Promise.all([
      applyDrawLifecycleAction(drawId, "close", closesAt),
      applyDrawLifecycleAction(drawId, "close", closesAt),
    ]);
    expect(results).toEqual(["updated", "unchanged"]);
    expect(update).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledTimes(2);
  });
});
