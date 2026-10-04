import { describe, it, expect, vi, beforeEach } from "vitest";
import prisma from "../app/db.server";
import {
  getProductPublicationState,
  unpublishProductFromAllChannels,
  checkAndRemediateProductVisibility,
  type AdminGraphQLClient,
} from "../app/services/productVisibility.server";
import { scheduleVisibilityGuardCheck } from "../app/services/qstash.server";

describe("Product Visibility Protection Suite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getProductPublicationState", () => {
    it("returns null if product is not found in Shopify", async () => {
      const mockAdmin: AdminGraphQLClient = {
        graphql: vi.fn().mockResolvedValue({
          json: async () => ({ data: { product: null } }),
        }),
      };

      const result = await getProductPublicationState(
        mockAdmin,
        "gid://shopify/Product/999"
      );
      expect(result).toBeNull();
    });

    it("parses publications correctly into active and inactive channels", async () => {
      const mockAdmin: AdminGraphQLClient = {
        graphql: vi.fn().mockResolvedValue({
          json: async () => ({
            data: {
              product: {
                id: "gid://shopify/Product/123",
                title: "Nike Travis Scott Dunk",
                status: "ACTIVE",
                resourcePublicationsV2: {
                  edges: [
                    {
                      node: {
                        isPublished: true,
                        publishDate: "2026-10-01T00:00:00Z",
                        publication: {
                          id: "gid://shopify/Publication/1",
                          name: "Online Store",
                        },
                      },
                    },
                    {
                      node: {
                        isPublished: false,
                        publishDate: null,
                        publication: {
                          id: "gid://shopify/Publication/2",
                          name: "Point of Sale",
                        },
                      },
                    },
                    {
                      node: {
                        isPublished: true,
                        publishDate: "2026-10-01T00:00:00Z",
                        publication: {
                          id: "gid://shopify/Publication/3",
                          name: "Shop App",
                        },
                      },
                    },
                  ],
                },
              },
            },
          }),
        }),
      };

      const result = await getProductPublicationState(
        mockAdmin,
        "gid://shopify/Product/123"
      );

      expect(result).not.toBeNull();
      expect(result?.productGid).toBe("gid://shopify/Product/123");
      expect(result?.title).toBe("Nike Travis Scott Dunk");
      expect(result?.activePublicationIds).toEqual([
        "gid://shopify/Publication/1",
        "gid://shopify/Publication/3",
      ]);
      expect(result?.activePublicationNames).toEqual(["Online Store", "Shop App"]);
    });
  });

  describe("unpublishProductFromAllChannels", () => {
    it("takes a visibility snapshot and unpublishes product from all channels", async () => {
      const mockAdmin: AdminGraphQLClient = {
        graphql: vi
          .fn()
          // First call: query product publications
          .mockResolvedValueOnce({
            json: async () => ({
              data: {
                product: {
                  id: "gid://shopify/Product/123",
                  title: "Rare Drop Sneaker",
                  status: "ACTIVE",
                  resourcePublicationsV2: {
                    edges: [
                      {
                        node: {
                          isPublished: true,
                          publication: {
                            id: "gid://shopify/Publication/1",
                            name: "Online Store",
                          },
                        },
                      },
                    ],
                  },
                },
              },
            }),
          })
          // Second call: publishableUnpublish mutation
          .mockResolvedValueOnce({
            json: async () => ({
              data: {
                publishableUnpublish: {
                  userErrors: [],
                },
              },
            }),
          }),
      };

      const upsertSnapshotSpy = vi
        .spyOn(prisma.productVisibilitySnapshot, "upsert")
        .mockResolvedValue({} as never);

      const createAuditSpy = vi
        .spyOn(prisma.auditLog, "create")
        .mockResolvedValue({} as never);

      const result = await unpublishProductFromAllChannels({
        admin: mockAdmin,
        productGid: "gid://shopify/Product/123",
        drawId: "draw-abc-123",
        shopId: "shop-xyz-789",
      });

      expect(result.snapshotSaved).toBe(true);
      expect(result.unpublishedCount).toBe(1);
      expect(upsertSnapshotSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            drawId_productGid: {
              drawId: "draw-abc-123",
              productGid: "gid://shopify/Product/123",
            },
          },
        })
      );
      expect(mockAdmin.graphql).toHaveBeenCalledTimes(2);
      expect(createAuditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            eventType: "PRODUCT_UNPUBLISHED",
          }),
        })
      );
    });

    it("handles already unpublished products gracefully", async () => {
      const mockAdmin: AdminGraphQLClient = {
        graphql: vi.fn().mockResolvedValueOnce({
          json: async () => ({
            data: {
              product: {
                id: "gid://shopify/Product/123",
                title: "Hidden Sneaker",
                status: "ACTIVE",
                resourcePublicationsV2: {
                  edges: [],
                },
              },
            },
          }),
        }),
      };

      vi.spyOn(prisma.productVisibilitySnapshot, "upsert").mockResolvedValue({} as never);

      const result = await unpublishProductFromAllChannels({
        admin: mockAdmin,
        productGid: "gid://shopify/Product/123",
        drawId: "draw-abc-123",
        shopId: "shop-xyz-789",
      });

      expect(result.snapshotSaved).toBe(true);
      expect(result.unpublishedCount).toBe(0);
      // publishableUnpublish mutation should NOT be called if already 0 published
      expect(mockAdmin.graphql).toHaveBeenCalledTimes(1);
    });
  });

  describe("checkAndRemediateProductVisibility", () => {
    it("does nothing if product is not in any active draw", async () => {
      const mockAdmin: AdminGraphQLClient = {
        graphql: vi.fn(),
      };

      vi.spyOn(prisma.draw, "findMany").mockResolvedValueOnce([]);

      const result = await checkAndRemediateProductVisibility({
        admin: mockAdmin,
        productGid: "gid://shopify/Product/not-in-draw",
        shopId: "shop-1",
        triggerSource: "webhook",
      });

      expect(result.breached).toBe(false);
      expect(mockAdmin.graphql).not.toHaveBeenCalled();
    });

    it("detects breach, auto-unpublishes, sets warning flag, and writes audit log", async () => {
      vi.spyOn(prisma.draw, "findMany").mockResolvedValueOnce([
        { id: "draw-active-1", title: "Travis Scott Drop" } as never,
      ]);

      const mockAdmin: AdminGraphQLClient = {
        graphql: vi
          .fn()
          // Check query: product is published on Online Store!
          .mockResolvedValueOnce({
            json: async () => ({
              data: {
                product: {
                  id: "gid://shopify/Product/123",
                  title: "Travis Scott Drop",
                  status: "ACTIVE",
                  resourcePublicationsV2: {
                    edges: [
                      {
                        node: {
                          isPublished: true,
                          publication: {
                            id: "gid://shopify/Publication/online-store",
                            name: "Online Store",
                          },
                        },
                      },
                    ],
                  },
                },
              },
            }),
          })
          // Unpublish mutation response
          .mockResolvedValueOnce({
            json: async () => ({
              data: {
                publishableUnpublish: {
                  userErrors: [],
                },
              },
            }),
          }),
      };

      const updateDrawSpy = vi
        .spyOn(prisma.draw, "update")
        .mockResolvedValue({} as never);

      const auditLogSpy = vi
        .spyOn(prisma.auditLog, "create")
        .mockResolvedValue({} as never);

      const result = await checkAndRemediateProductVisibility({
        admin: mockAdmin,
        productGid: "gid://shopify/Product/123",
        shopId: "shop-1",
        triggerSource: "qstash",
      });

      expect(result.breached).toBe(true);
      expect(result.remediated).toBe(true);
      expect(result.publishedChannels).toEqual(["Online Store"]);

      // Verify draw flag was set
      expect(updateDrawSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "draw-active-1", shopId: "shop-1" },
          data: expect.objectContaining({
            hasVisibilityWarning: true,
            visibilityWarning: expect.stringContaining("CRITICAL"),
          }),
        })
      );

      // Verify audit log was recorded
      expect(auditLogSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            drawId: "draw-active-1",
            eventType: "PRODUCT_VISIBILITY_BREACH_DETECTED",
            actor: "guard_qstash",
          }),
        })
      );
    });
  });

  describe("scheduleVisibilityGuardCheck", () => {
    it("handles missing QSTASH_TOKEN gracefully without throwing", async () => {
      const originalToken = process.env.QSTASH_TOKEN;
      delete process.env.QSTASH_TOKEN;

      const result = await scheduleVisibilityGuardCheck({ delaySeconds: 1200 });
      expect(result.scheduled).toBe(false);
      expect(result.reason).toBe("MISSING_TOKEN");

      process.env.QSTASH_TOKEN = originalToken;
    });
  });
});
