import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { decrypt } from "./encryption";
import { getEmailProvider, renderWinnerEmail } from "./emailService.server";
import {
  createDraftOrderForWinner,
  generateClaimToken,
  type ShopifyAdminClient,
} from "./allocationService.server";
import { getQStashClient } from "./qstash.server";

export interface ExpireAllocationOptions {
  now?: Date;
  admin?: ShopifyAdminClient;
}

export interface ExpireAllocationResult {
  status:
    | "expired_and_promoted"
    | "expired_waitlist_exhausted"
    | "payment_won_race"
    | "already_resolved"
    | "not_due"
    | "not_found";
  allocationId: string;
  promotedAllocationId?: string;
  promotedEntryId?: string;
  promotedRank?: number;
  message?: string;
}

const DRAFT_ORDER_QUERY = `#graphql
  query getDraftOrder($id: ID!) {
    draftOrder(id: $id) {
      id
      status
      order {
        id
        displayFinancialStatus
      }
    }
  }
`;

const DRAFT_ORDER_DELETE_MUTATION = `#graphql
  mutation draftOrderDelete($input: DraftOrderDeleteInput!) {
    draftOrderDelete(input: $input) {
      deletedId
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * Checks Shopify to see if the draft order was paid or completed right at the deadline.
 * Guards against the race where payment succeeds just as the expiry job triggers.
 */
async function checkDraftOrderPaidStatus(
  admin: ShopifyAdminClient | undefined,
  draftOrderGid: string | null
): Promise<boolean> {
  if (!admin || !draftOrderGid || draftOrderGid.startsWith("gid://shopify/DraftOrder/mock-")) {
    return false;
  }

  try {
    const response = await admin.graphql(DRAFT_ORDER_QUERY, {
      variables: { id: draftOrderGid },
    });
    const json = (await response.json()) as {
      data?: {
        draftOrder?: {
          id: string;
          status: string;
          order?: { id: string; displayFinancialStatus?: string } | null;
        } | null;
      };
    };
    const draft = json?.data?.draftOrder;
    if (draft?.status === "COMPLETED" || draft?.order?.displayFinancialStatus === "PAID") {
      return true;
    }
    return false;
  } catch (err) {
    console.warn("[claimExpiry] Error checking draft order status in Shopify:", err);
    return false;
  }
}

/**
 * Deletes the Shopify Draft Order to release reserved inventory.
 */
async function deleteDraftOrder(
  admin: ShopifyAdminClient | undefined,
  draftOrderGid: string | null
): Promise<void> {
  if (!admin || !draftOrderGid || draftOrderGid.startsWith("gid://shopify/DraftOrder/mock-")) {
    return;
  }

  try {
    await admin.graphql(DRAFT_ORDER_DELETE_MUTATION, {
      variables: { input: { id: draftOrderGid } },
    });
  } catch (err) {
    console.warn("[claimExpiry] Error deleting draft order in Shopify:", err);
  }
}

/**
 * Evaluates an allocation at its claim deadline:
 * 1. Re-reads allocation with row lock.
 * 2. If status is already PURCHASED, EXPIRED, or CANCELLED, exits immediately (idempotent).
 * 3. Confirms with Shopify if payment was completed right at the deadline (payment wins race).
 * 4. If unpaid: deletes draft order, marks allocation EXPIRED, writes AuditLog.
 * 5. Promotes the next lowest-ranked eligible entrant in this draw that has NEVER won.
 *    Uses `SELECT ... FOR UPDATE SKIP LOCKED` for concurrent concurrency safety.
 * 6. If waitlist exhausted, marks remaining units unsold and moves draw toward COMPLETED.
 */
export async function expireAllocationAndPromoteNext(
  allocationId: string,
  options?: ExpireAllocationOptions
): Promise<ExpireAllocationResult> {
  const now = options?.now ?? new Date();

  return prisma.$transaction(
    async (tx) => {
    // 1. Row-lock the Allocation record
    const [lockedAllocation] = await tx.$queryRaw<Array<{
      id: string;
      shopId: string;
      drawId: string;
      entryId: string;
      status: string;
      variantGid: string;
      rank: number;
      deadlineAt: Date;
      draftOrderGid: string | null;
    }>>`SELECT id, "shopId", "drawId", "entryId", status, "variantGid", rank, "deadlineAt", "draftOrderGid"
        FROM "raffle"."Allocation"
        WHERE id = ${allocationId}
        FOR UPDATE`;

    if (!lockedAllocation) {
      return { status: "not_found", allocationId, message: "Allocation not found." };
    }

    // 2. Idempotency: exit if already settled
    if (["PURCHASED", "EXPIRED", "CANCELLED"].includes(lockedAllocation.status)) {
      return {
        status: "already_resolved",
        allocationId,
        message: `Allocation is already resolved in status ${lockedAllocation.status}.`,
      };
    }

    // Check if deadline has actually arrived
    if (now < lockedAllocation.deadlineAt) {
      return {
        status: "not_due",
        allocationId,
        message: "Allocation claim deadline has not arrived yet.",
      };
    }

    // Load parent Draw details
    const draw = await tx.draw.findUniqueOrThrow({
      where: { id: lockedAllocation.drawId },
      include: {
        shop: true,
        variants: true,
      },
    });

    // 3. Payment-at-deadline race check
    const isPaid = await checkDraftOrderPaidStatus(options?.admin, lockedAllocation.draftOrderGid);
    if (isPaid) {
      await tx.allocation.update({
        where: { id: lockedAllocation.id },
        data: {
          status: "PURCHASED",
          purchasedAt: now,
        },
      });

      await tx.auditLog.create({
        data: {
          shopId: lockedAllocation.shopId,
          drawId: lockedAllocation.drawId,
          eventType: "ALLOCATION_PURCHASED_AT_DEADLINE_RACE",
          actor: "system",
          metadata: {
            allocationId: lockedAllocation.id,
            rank: lockedAllocation.rank,
            message: "Payment confirmed right at the deadline; payment won race over expiry.",
          },
        },
      });

      // Check if this payment completes the draw
      await checkAndCompleteDrawIfFinished(
        tx,
        draw.id,
        draw.shopId,
        draw.unitsAvailable
      );

      return {
        status: "payment_won_race",
        allocationId,
        message: "Winner completed purchase right at deadline. Marked PURCHASED.",
      };
    }

    // 4. Unpaid: Delete draft order and mark EXPIRED
    await deleteDraftOrder(options?.admin, lockedAllocation.draftOrderGid);

    await tx.allocation.update({
      where: { id: lockedAllocation.id },
      data: { status: "EXPIRED" },
    });

    await tx.auditLog.create({
      data: {
        shopId: lockedAllocation.shopId,
        drawId: lockedAllocation.drawId,
        eventType: "ALLOCATION_EXPIRED",
        actor: "system",
        metadata: {
          allocationId: lockedAllocation.id,
          rank: lockedAllocation.rank,
          expiredAt: now.toISOString(),
        },
      },
    });

    // 5. Promote the next entrant (lowest rank that has NEVER had an allocation in this draw)
    // Using `SELECT ... FOR UPDATE SKIP LOCKED` prevents concurrent workers from selecting the same person
    const rules = (draw.rules as Record<string, unknown>) || {};
    const allowMultipleUnitsPerAddress = rules.allowMultipleUnitsPerAddress === true;

    const candidateEntries = await tx.$queryRaw<Array<{
      id: string;
      shopId: string;
      drawId: string;
      customerGid: string;
      emailEncrypted: string;
      addressHash: string | null;
      rank: number;
      status: string;
      riskFlags: unknown;
    }>>`
      SELECT e.id, e."shopId", e."drawId", e."customerGid", e."emailEncrypted", e."addressHash", e."rank", e.status, e."riskFlags"
      FROM "raffle"."Entry" e
      WHERE e."drawId" = ${draw.id}
        AND e."rank" IS NOT NULL
        AND (
          e.status = 'VALID'
          OR (e.status = 'FLAGGED' AND e."riskFlags"::text LIKE '%MERCHANT_APPROVED%')
        )
        AND NOT EXISTS (
          SELECT 1 FROM "raffle"."Allocation" a
          WHERE a."entryId" = e.id AND a."drawId" = e."drawId"
        )
      ORDER BY e."rank" ASC
      LIMIT 10
      FOR UPDATE SKIP LOCKED
    `;

    // Filter candidate for address hash collision if needed
    let nextEntry: (typeof candidateEntries)[0] | null = null;
    if (!allowMultipleUnitsPerAddress) {
      // Find all address hashes of currently active or purchased allocations in this draw
      const activeAllocations = await tx.allocation.findMany({
        where: {
          drawId: draw.id,
          status: { in: ["ISSUED", "OPENED", "PURCHASED"] },
        },
        include: { entry: { select: { addressHash: true } } },
      });
      const activeAddressHashes = new Set(
        activeAllocations.map((a) => a.entry.addressHash).filter(Boolean)
      );

      for (const candidate of candidateEntries) {
        if (!candidate.addressHash || !activeAddressHashes.has(candidate.addressHash)) {
          nextEntry = candidate;
          break;
        }
      }
    } else {
      nextEntry = candidateEntries[0] || null;
    }

    // 6. Handle Waitlist Exhaustion
    if (!nextEntry) {
      const activeOrPurchasedCount = await tx.allocation.count({
        where: {
          drawId: draw.id,
          status: { in: ["ISSUED", "OPENED", "PURCHASED"] },
        },
      });
      const unsoldUnits = Math.max(0, draw.unitsAvailable - activeOrPurchasedCount);

      await tx.auditLog.create({
        data: {
          shopId: draw.shopId,
          drawId: draw.id,
          eventType: "DRAW_WAITLIST_EXHAUSTED",
          actor: "system",
          metadata: {
            message: "No further eligible waitlist entrants available. Unit left unsold.",
            unsoldUnits,
          },
        },
      });

      // Check if draw is fully settled
      const activeRemaining = await tx.allocation.count({
        where: {
          drawId: draw.id,
          status: { in: ["ISSUED", "OPENED"] },
        },
      });

      if (activeRemaining === 0) {
        await tx.draw.update({
          where: { id: draw.id },
          data: { status: "COMPLETED" },
        });

        await tx.auditLog.create({
          data: {
            shopId: draw.shopId,
            drawId: draw.id,
            eventType: "DRAW_COMPLETED",
            actor: "system",
            metadata: {
              message: "All allocations expired or purchased; waitlist exhausted. Drop completed.",
            },
          },
        });
      }

      return {
        status: "expired_waitlist_exhausted",
        allocationId,
        message: "Allocation expired; waitlist exhausted.",
      };
    }

    // 7. Issue allocation to the promoted entrant
    const { token, claimTokenHash } = generateClaimToken();
    const newDeadlineAt = new Date(now.getTime() + draw.claimWindowMinutes * 60 * 1000);
    const decryptedEmail = decrypt(nextEntry.emailEncrypted);

    const primaryVariant = draw.variants.find((v) => v.variantGid === lockedAllocation.variantGid) || draw.variants[0];
    const msrpPrice = primaryVariant ? primaryVariant.msrpPrice.toString() : "0.00";

    let draftOrderGid = `gid://shopify/DraftOrder/mock-${Date.now()}-${nextEntry.rank}`;
    let invoiceUrl = `https://${draw.shop.shopDomain}/checkouts/do/mock-${Date.now()}`;

    if (options?.admin) {
      const draftResult = await createDraftOrderForWinner({
        admin: options.admin,
        variantGid: lockedAllocation.variantGid,
        msrpPrice,
        customerGid: nextEntry.customerGid,
        email: decryptedEmail,
        drawId: draw.id,
        entryId: nextEntry.id,
        deadlineAt: newDeadlineAt,
      });
      draftOrderGid = draftResult.draftOrderGid;
      invoiceUrl = draftResult.invoiceUrl;
    }

    const promotedAllocation = await tx.allocation.create({
      data: {
        shopId: draw.shopId,
        drawId: draw.id,
        entryId: nextEntry.id,
        variantGid: lockedAllocation.variantGid,
        rank: nextEntry.rank,
        claimTokenHash,
        draftOrderGid,
        invoiceUrl,
        deadlineAt: newDeadlineAt,
        status: "ISSUED",
      },
    });

    await tx.auditLog.create({
      data: {
        shopId: draw.shopId,
        drawId: draw.id,
        eventType: "ALLOCATION_PROMOTED_FROM_WAITLIST",
        actor: "system",
        metadata: {
          previousAllocationId: lockedAllocation.id,
          newAllocationId: promotedAllocation.id,
          entryId: nextEntry.id,
          rank: nextEntry.rank,
          deadlineAt: newDeadlineAt.toISOString(),
        },
      },
    });

    // 8. Send Winner Email
    const emailProvider = getEmailProvider();
    const shopDomain = draw.shop.shopDomain;
    const storeName = ((draw.shop.settings as Record<string, unknown>)?.storeName as string) || shopDomain;
    const claimUrl = `https://${shopDomain}/apps/raffle/claim/${token}`;

    const emailContent = renderWinnerEmail({
      storeName,
      productTitle: draw.title,
      claimUrl,
      deadline: newDeadlineAt,
    });

    await emailProvider.sendEmail({
      to: decryptedEmail,
      from: `Fairdrops Raffle <raffles@${shopDomain}>`,
      replyTo: `support@${shopDomain}`,
      subject: `🎉 You Won! Claim your item: ${draw.title}`,
      html: emailContent.html,
      text: emailContent.text,
    });

    // 9. Schedule QStash delayed message for new allocation expiry
    const qstashClient = getQStashClient();
    const baseUrl = process.env.SHOPIFY_APP_URL;
    if (qstashClient && baseUrl) {
      const delaySeconds = Math.max(0, Math.ceil((newDeadlineAt.getTime() - Date.now()) / 1000));
      await qstashClient
        .publishJSON({
          url: `${baseUrl.replace(/\/$/, "")}/api/qstash/allocation-expiry`,
          delay: delaySeconds,
          deduplicationId: `allocation:expiry:${promotedAllocation.id}`,
          body: { allocationId: promotedAllocation.id, drawId: draw.id },
        })
        .catch((err) => console.error("[QStash] Failed to schedule expiry for promoted allocation:", err));
    }

    return {
      status: "expired_and_promoted",
      allocationId: lockedAllocation.id,
      promotedAllocationId: promotedAllocation.id,
      promotedEntryId: nextEntry.id,
      promotedRank: nextEntry.rank,
    };
  },
  { maxWait: 15000, timeout: 20000 }
  );
}

/**
 * Self-scheduling QStash sweeper for claim expiry safety net.
 * Scans all active draws for expired allocations that may have missed a delayed QStash message.
 */
export async function runClaimExpirySweeper(now = new Date()): Promise<{
  expiredCount: number;
  promotedCount: number;
}> {
  const expiredAllocations = await prisma.allocation.findMany({
    where: {
      status: { in: ["ISSUED", "OPENED"] },
      deadlineAt: { lte: now },
    },
    select: { id: true },
  });

  let expiredCount = 0;
  let promotedCount = 0;

  for (const item of expiredAllocations) {
    const res = await expireAllocationAndPromoteNext(item.id, { now });
    if (res.status === "expired_and_promoted") {
      expiredCount++;
      promotedCount++;
    } else if (res.status === "expired_waitlist_exhausted") {
      expiredCount++;
    }
  }

  // Self-schedule next check if active allocations remain
  const remainingActive = await prisma.allocation.count({
    where: { status: { in: ["ISSUED", "OPENED"] } },
  });

  if (remainingActive > 0) {
    const qstashClient = getQStashClient();
    const baseUrl = process.env.SHOPIFY_APP_URL;
    if (qstashClient && baseUrl) {
      await qstashClient
        .publishJSON({
          url: `${baseUrl.replace(/\/$/, "")}/api/qstash/allocation-expiry`,
          delay: 300, // 5 minutes
          deduplicationId: `allocation:sweeper:${Math.floor(Date.now() / 300000)}`,
          body: { action: "sweep" },
        })
        .catch(() => {});
    }
  }

  return { expiredCount, promotedCount };
}

/**
 * Checks if a draw has fulfilled all available units or if all active allocations are resolved and waitlist is exhausted.
 * If so, transitions Draw to COMPLETED.
 */
export async function checkAndCompleteDrawIfFinished(
  tx: Prisma.TransactionClient,
  drawId: string,
  shopId: string,
  unitsAvailable: number
): Promise<{ completed: boolean; unsoldUnits: number }> {
  const purchasedCount = await tx.allocation.count({
    where: { drawId, status: "PURCHASED" },
  });
  const activeCount = await tx.allocation.count({
    where: { drawId, status: { in: ["ISSUED", "OPENED"] } },
  });

  const remainingEntries = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT e.id FROM "raffle"."Entry" e
    WHERE e."drawId" = ${drawId}
      AND e."rank" IS NOT NULL
      AND (
        e.status = 'VALID'
        OR (e.status = 'FLAGGED' AND e."riskFlags"::text LIKE '%MERCHANT_APPROVED%')
      )
      AND NOT EXISTS (
        SELECT 1 FROM "raffle"."Allocation" a
        WHERE a."entryId" = e.id AND a."drawId" = e."drawId"
      )
    LIMIT 1
  `;

  if (purchasedCount >= unitsAvailable || (activeCount === 0 && remainingEntries.length === 0)) {
    const unsoldUnits = Math.max(0, unitsAvailable - purchasedCount);
    await tx.draw.update({
      where: { id: drawId },
      data: { status: "COMPLETED" },
    });

    const drawRecord = await tx.draw.findUniqueOrThrow({
      where: { id: drawId },
      select: { purgeAfterDays: true },
    });
    const purgeDelaySeconds = (drawRecord.purgeAfterDays || 14) * 24 * 60 * 60;
    const purgeScheduledAt = new Date(Date.now() + purgeDelaySeconds * 1000);

    const qstashClient = getQStashClient();
    const baseUrl = process.env.SHOPIFY_APP_URL;
    if (qstashClient && baseUrl) {
      await qstashClient
        .publishJSON({
          url: `${baseUrl.replace(/\/$/, "")}/api/qstash/draw-purge`,
          delay: purgeDelaySeconds,
          deduplicationId: `draw:purge:${drawId}`,
          body: { drawId, shopId },
        })
        .catch((err) => console.error("[QStash] Failed to schedule purge:", err));
    }

    await tx.auditLog.create({
      data: {
        shopId,
        drawId,
        eventType: "DRAW_COMPLETED",
        actor: "system",
        metadata: {
          purchasedCount,
          unsoldUnits,
          unitsAvailable,
          purgeScheduledAt: purgeScheduledAt.toISOString(),
          message: `Draw completed. ${purchasedCount} purchased, ${unsoldUnits} unsold. Purge scheduled for ${purgeScheduledAt.toISOString()}.`,
        },
      },
    });

    return { completed: true, unsoldUnits };
  }

  return { completed: false, unsoldUnits: 0 };
}

export interface RecordPurchaseParams {
  shopDomain: string;
  orderId: string;
  draftOrderGid?: string;
  tags?: string;
  note?: string;
  webhookEventId?: string;
  topic?: string;
  customerId?: string;
  shippingCountryCode?: string;
  now?: Date;
}

export interface RecordPurchaseResult {
  success: boolean;
  status:
    | "purchased"
    | "already_purchased"
    | "duplicate_webhook"
    | "not_raffle_order"
    | "allocation_not_found";
  allocationId?: string;
  drawId?: string;
  drawCompleted?: boolean;
  unsoldUnits?: number;
}

/**
 * Handles order payment webhook (orders/paid, draft_orders/update, or orders/create paid):
 * 1. Checks webhook idempotency via WebhookEvent.
 * 2. Parses drawId, entryId, or draftOrderGid.
 * 3. In a transaction, updates allocation status to PURCHASED and writes AuditLog.
 * 4. Deducts from remaining units and transitions Draw to COMPLETED if all units claimed/exhausted.
 * 5. Schedules purge delayed message for purgeAfterDays (Phase 11).
 */
export async function recordAllocationPurchase(
  params: RecordPurchaseParams
): Promise<RecordPurchaseResult> {
  const shopRecord = await prisma.shop.findUnique({
    where: { shopDomain: params.shopDomain },
  });

  if (!shopRecord) {
    return { success: false, status: "allocation_not_found" };
  }

  // Idempotency: store processed Shopify webhook IDs, reject duplicates
  if (params.webhookEventId) {
    const existingEvent = await prisma.webhookEvent.findUnique({
      where: { eventId: params.webhookEventId },
    });
    if (existingEvent) {
      return { success: true, status: "duplicate_webhook" };
    }

    try {
      await prisma.webhookEvent.create({
        data: {
          shopId: shopRecord.id,
          eventId: params.webhookEventId,
          topic: params.topic || "orders/paid",
        },
      });
    } catch {
      // Caught concurrent duplicate insertion
      return { success: true, status: "duplicate_webhook" };
    }
  }

  const tags = params.tags || "";
  const note = params.note || "";
  const drawMatch = tags.match(/raffle:([a-f\d-]{36})/i) || note.match(/raffle.*?([a-f\d-]{36})/i);
  const entryMatch = tags.match(/entry:([a-f\d-]{36})/i);

  if (!drawMatch && !params.draftOrderGid) {
    return { success: true, status: "not_raffle_order" };
  }

  const drawId = drawMatch ? drawMatch[1] : undefined;
  const entryId = entryMatch ? entryMatch[1] : undefined;
  const now = params.now ?? new Date();

  return prisma.$transaction(async (tx) => {
    let allocation:
      | (Prisma.AllocationGetPayload<{ include: { draw: true } }>)
      | null = null;

    if (params.draftOrderGid) {
      allocation = await tx.allocation.findFirst({
        where: {
          draftOrderGid: params.draftOrderGid,
          shopId: shopRecord.id,
        },
        include: { draw: true },
      });
    }

    if (!allocation && drawId) {
      allocation = await tx.allocation.findFirst({
        where: {
          drawId,
          shopId: shopRecord.id,
          ...(entryId ? { entryId } : {}),
        },
        include: { draw: true },
      });
    }

    if (!allocation) {
      return { success: false, status: "allocation_not_found" };
    }

    if (allocation.status === "PURCHASED") {
      return {
        success: true,
        status: "already_purchased",
        allocationId: allocation.id,
        drawId: allocation.drawId,
      };
    }

    await tx.allocation.update({
      where: { id: allocation.id },
      data: {
        status: "PURCHASED",
        purchasedAt: now,
      },
    });

    await tx.auditLog.create({
      data: {
        shopId: shopRecord.id,
        drawId: allocation.drawId,
        eventType: "ALLOCATION_PURCHASED",
        actor: params.customerId ? `customer:${params.customerId}` : "system:webhook",
        metadata: {
          allocationId: allocation.id,
          orderId: params.orderId,
          shippingCountryCode: params.shippingCountryCode,
        },
      },
    });

    const completionResult = await checkAndCompleteDrawIfFinished(
      tx,
      allocation.drawId,
      shopRecord.id,
      allocation.draw.unitsAvailable
    );

    return {
      success: true,
      status: "purchased",
      allocationId: allocation.id,
      drawId: allocation.drawId,
      drawCompleted: completionResult.completed,
      unsoldUnits: completionResult.unsoldUnits,
    };
  },
  { maxWait: 15000, timeout: 20000 }
  );
}

