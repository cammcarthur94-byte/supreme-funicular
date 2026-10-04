import { describe, it, expect, vi } from "vitest";
import { forShop, TenantSecurityError } from "../app/services/tenantDb";
import prisma from "../app/db.server";

describe("Tenant Data Access Isolation (forShop)", () => {
  it("rejects empty, null, or undefined shopId", () => {
    // @ts-expect-error test invalid inputs
    expect(() => forShop(null)).toThrow(TenantSecurityError);
    // @ts-expect-error test invalid inputs
    expect(() => forShop(undefined)).toThrow(TenantSecurityError);
    expect(() => forShop("")).toThrow(TenantSecurityError);
    expect(() => forShop("   ")).toThrow(TenantSecurityError);
  });

  it("returns tenant client containing normalized shopId", () => {
    const tenant = forShop("shop-12345");
    expect(tenant.shopId).toBe("shop-12345");
    expect(tenant.draw).toBeDefined();
    expect(tenant.entry).toBeDefined();
    expect(tenant.allocation).toBeDefined();
    expect(tenant.auditLog).toBeDefined();
    expect(tenant.webhookEvent).toBeDefined();
  });

  it("injects shopId into draw findMany queries", async () => {
    const findManySpy = vi.spyOn(prisma.draw, "findMany").mockResolvedValueOnce([] as never);

    const tenant = forShop("tenant-store-abc");
    await tenant.draw.findMany({ where: { status: "OPEN" } });

    expect(findManySpy).toHaveBeenCalledWith({
      where: {
        status: "OPEN",
        shopId: "tenant-store-abc",
      },
    });

    findManySpy.mockRestore();
  });

  it("injects shopId into draw findUnique/findFirst queries", async () => {
    const findFirstSpy = vi.spyOn(prisma.draw, "findFirst").mockResolvedValueOnce(null);

    const tenant = forShop("tenant-store-xyz");
    await tenant.draw.findUnique({ where: { id: "draw-999" } });

    expect(findFirstSpy).toHaveBeenCalledWith({
      where: {
        id: "draw-999",
        shopId: "tenant-store-xyz",
      },
    });

    findFirstSpy.mockRestore();
  });

  it("injects shopId connection into draw create calls", async () => {
    const createSpy = vi.spyOn(prisma.draw, "create").mockResolvedValueOnce({ id: "draw-1" } as never);

    const tenant = forShop("tenant-store-create");
    await tenant.draw.create({
      data: {
        title: "Test Drop",
        entryOpensAt: new Date(),
        entryClosesAt: new Date(),
        drawAt: new Date(),
        claimWindowMinutes: 10,
        unitsAvailable: 5,
      } as unknown as Parameters<typeof tenant.draw.create>[0]["data"],
    });

    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: "Test Drop",
          shop: { connect: { id: "tenant-store-create" } },
        }),
      })
    );

    createSpy.mockRestore();
  });

  it("scopes webhook event lookups to current shop", async () => {
    const findFirstSpy = vi.spyOn(prisma.webhookEvent, "findFirst").mockResolvedValueOnce(null);

    const tenant = forShop("tenant-shop-webhook");
    const processed = await tenant.webhookEvent.hasProcessed("evt-unique-123");

    expect(processed).toBe(false);
    expect(findFirstSpy).toHaveBeenCalledWith({
      where: {
        eventId: "evt-unique-123",
        shopId: "tenant-shop-webhook",
      },
    });

    findFirstSpy.mockRestore();
  });
});
