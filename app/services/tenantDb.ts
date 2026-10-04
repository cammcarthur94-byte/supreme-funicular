import prisma from "../db.server";
import type { Prisma } from "@prisma/client";

export class TenantSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantSecurityError";
  }
}

/**
 * Tenant-scoped data access client.
 * Enforces that every query across tenant tables is strictly isolated by `shopId`.
 */
export function forShop(shopId: string) {
  if (!shopId || typeof shopId !== "string" || shopId.trim().length === 0) {
    throw new TenantSecurityError("A valid, non-empty shopId is required for tenant data access.");
  }

  const cleanShopId = shopId.trim();

  return {
    shopId: cleanShopId,

    draw: {
      findMany: <T extends Prisma.DrawFindManyArgs>(
        args?: Prisma.SelectSubset<T, Prisma.DrawFindManyArgs>
      ): Promise<Array<Prisma.DrawGetPayload<T>>> => {
        const baseArgs = (args || {}) as Prisma.DrawFindManyArgs;
        return prisma.draw.findMany({
          ...baseArgs,
          where: Object.assign({}, baseArgs.where, { shopId: cleanShopId }),
        }) as unknown as Promise<Array<Prisma.DrawGetPayload<T>>>;
      },

      findFirst: <T extends Prisma.DrawFindFirstArgs>(
        args?: Prisma.SelectSubset<T, Prisma.DrawFindFirstArgs>
      ): Promise<Prisma.DrawGetPayload<T> | null> => {
        const baseArgs = (args || {}) as Prisma.DrawFindFirstArgs;
        return prisma.draw.findFirst({
          ...baseArgs,
          where: Object.assign({}, baseArgs.where, { shopId: cleanShopId }),
        }) as unknown as Promise<Prisma.DrawGetPayload<T> | null>;
      },

      findUnique: <T extends Omit<Prisma.DrawFindFirstArgs, "where">>(
        args: { where: { id: string } } & Prisma.SelectSubset<T, Omit<Prisma.DrawFindFirstArgs, "where">>
      ): Promise<Prisma.DrawGetPayload<T> | null> => {
        const baseArgs = args as { where: { id: string } } & Record<string, unknown>;
        const { where, ...rest } = baseArgs;
        return prisma.draw.findFirst({
          ...rest,
          where: { id: where.id, shopId: cleanShopId },
        }) as unknown as Promise<Prisma.DrawGetPayload<T> | null>;
      },

      create: (args: Prisma.DrawCreateArgs) => {
        return prisma.draw.create({
          ...args,
          data: {
            ...args.data,
            shop: { connect: { id: cleanShopId } },
          } as Prisma.DrawCreateInput,
        });
      },

      update: (args: Prisma.DrawUpdateArgs & { where: { id: string } }) => {
        return prisma.draw.update({
          ...args,
          where: { id: args.where.id, shopId: cleanShopId },
        });
      },

      delete: (args: Prisma.DrawDeleteArgs & { where: { id: string } }) => {
        return prisma.draw.delete({
          ...args,
          where: { id: args.where.id, shopId: cleanShopId },
        });
      },

      count: (args?: Prisma.DrawCountArgs) => {
        return prisma.draw.count({
          ...args,
          where: { ...args?.where, shopId: cleanShopId },
        });
      },
    },

    entry: {
      findMany: (args?: Prisma.EntryFindManyArgs) => {
        return prisma.entry.findMany({
          ...args,
          where: { ...args?.where, shopId: cleanShopId },
        });
      },

      findFirst: (args?: Prisma.EntryFindFirstArgs) => {
        return prisma.entry.findFirst({
          ...args,
          where: { ...args?.where, shopId: cleanShopId },
        });
      },

      create: (args: Prisma.EntryCreateArgs) => {
        return prisma.entry.create({
          ...args,
          data: {
            ...args.data,
            shop: { connect: { id: cleanShopId } },
          } as Prisma.EntryCreateInput,
        });
      },

      count: (args?: Prisma.EntryCountArgs) => {
        return prisma.entry.count({
          ...args,
          where: { ...args?.where, shopId: cleanShopId },
        });
      },
    },

    allocation: {
      findMany: (args?: Prisma.AllocationFindManyArgs) => {
        return prisma.allocation.findMany({
          ...args,
          where: { ...args?.where, shopId: cleanShopId },
        });
      },

      findFirst: (args?: Prisma.AllocationFindFirstArgs) => {
        return prisma.allocation.findFirst({
          ...args,
          where: { ...args?.where, shopId: cleanShopId },
        });
      },

      create: (args: Prisma.AllocationCreateArgs) => {
        return prisma.allocation.create({
          ...args,
          data: {
            ...args.data,
            shop: { connect: { id: cleanShopId } },
          } as Prisma.AllocationCreateInput,
        });
      },

      count: (args?: Prisma.AllocationCountArgs) => {
        return prisma.allocation.count({
          ...args,
          where: { ...args?.where, shopId: cleanShopId },
        });
      },
    },

    auditLog: {
      create: (args: { drawId?: string; eventType: string; actor: string; metadata?: Prisma.InputJsonValue }) => {
        return prisma.auditLog.create({
          data: {
            shopId: cleanShopId,
            drawId: args.drawId,
            eventType: args.eventType,
            actor: args.actor,
            metadata: args.metadata ?? {},
          },
        });
      },

      findMany: (args?: Prisma.AuditLogFindManyArgs) => {
        return prisma.auditLog.findMany({
          ...args,
          where: { ...args?.where, shopId: cleanShopId },
        });
      },
    },

    webhookEvent: {
      hasProcessed: async (eventId: string): Promise<boolean> => {
        const found = await prisma.webhookEvent.findFirst({
          where: { eventId, shopId: cleanShopId },
        });
        return Boolean(found);
      },

      record: (eventId: string, topic: string) => {
        return prisma.webhookEvent.create({
          data: {
            eventId,
            topic,
            shopId: cleanShopId,
          },
        });
      },
    },
  };
}
