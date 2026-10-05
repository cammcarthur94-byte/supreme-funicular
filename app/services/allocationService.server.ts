import crypto from "node:crypto";
import prisma from "../db.server";
import { decrypt } from "./encryption";
import { getEmailProvider, renderWinnerEmail } from "./emailService.server";
import { getQStashClient } from "./qstash.server";

export interface GeneratedClaimToken {
  token: string;
  claimTokenHash: string;
}

/**
 * Generates a 32-byte cryptographically secure base64url claim token
 * and its deterministic SHA-256 hash for database storage.
 */
export function generateClaimToken(): GeneratedClaimToken {
  const token = crypto.randomBytes(32).toString("base64url");
  const claimTokenHash = crypto.createHash("sha256").update(token).digest("hex");
  return { token, claimTokenHash };
}

export interface DraftOrderCreateResult {
  draftOrderGid: string;
  invoiceUrl: string;
}

const DRAFT_ORDER_CREATE_MUTATION = `#graphql
  mutation draftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id
        invoiceUrl
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export interface ShopifyAdminClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> }
  ) => Promise<{ json: () => Promise<unknown> }>;
}

/**
 * Creates a single-use, MSRP-locked, inventory-reserved Draft Order via Admin GraphQL API.
 */
export async function createDraftOrderForWinner(params: {
  admin: ShopifyAdminClient;
  variantGid: string;
  msrpPrice: string | number;
  customerGid: string;
  email: string;
  drawId: string;
  entryId: string;
  deadlineAt: Date;
}): Promise<DraftOrderCreateResult> {
  const input = {
    customerId: params.customerGid.startsWith("gid://")
      ? params.customerGid
      : `gid://shopify/Customer/${params.customerGid}`,
    email: params.email,
    tags: ["raffle", `raffle:${params.drawId}`, `entry:${params.entryId}`],
    note: `Fairdrops Raffle Win - Draw #${params.drawId}`,
    reserveInventoryUntil: params.deadlineAt.toISOString(),
    lineItems: [
      {
        variantId: params.variantGid,
        quantity: 1,
        originalUnitPrice: String(params.msrpPrice),
      },
    ],
  };

  const response = await params.admin.graphql(DRAFT_ORDER_CREATE_MUTATION, {
    variables: { input },
  });

  const json = (await response.json()) as {
    data?: {
      draftOrderCreate?: {
        draftOrder?: { id?: string; invoiceUrl?: string };
        userErrors?: Array<{ message?: string }>;
      };
    };
  };
  const userErrors = json?.data?.draftOrderCreate?.userErrors || [];
  if (userErrors.length > 0) {
    throw new Error(
      `Shopify draftOrderCreate error: ${userErrors.map((e) => e.message || "Unknown error").join(", ")}`
    );
  }

  const draftOrder = json?.data?.draftOrderCreate?.draftOrder;
  if (!draftOrder?.id || !draftOrder?.invoiceUrl) {
    throw new Error("Shopify draftOrderCreate failed: missing draft order ID or invoiceUrl in response.");
  }

  return {
    draftOrderGid: draftOrder.id,
    invoiceUrl: draftOrder.invoiceUrl,
  };
}

export interface IssueAllocationsOptions {
  now?: Date;
  mockAdmin?: ShopifyAdminClient;
}

export interface AllocationIssueResult {
  drawId: string;
  allocatedCount: number;
  allocations: Array<{
    id: string;
    entryId: string;
    rank: number;
    claimToken: string;
    draftOrderGid: string;
  }>;
}

/**
 * Issues allocations for winning entries of a DRAWN draw.
 * Adheres to unitsAvailable, handles multi-unit address prevention, creates draft orders,
 * generates claim tokens, sends transactional emails, and transitions draw to FULFILLING.
 */
export async function issueAllocationsForDraw(
  drawId: string,
  admin?: ShopifyAdminClient,
  options?: IssueAllocationsOptions
): Promise<AllocationIssueResult> {
  const now = options?.now ?? new Date();

  // 1. Fetch draw and variants
  const draw = await prisma.draw.findUniqueOrThrow({
    where: { id: drawId },
    include: {
      variants: true,
      shop: true,
    },
  });

  if (draw.status !== "DRAWN" && draw.status !== "CLOSED") {
    throw new Error(`Cannot issue allocations: draw status must be DRAWN or CLOSED, but is ${draw.status}`);
  }

  if (draw.variants.length === 0) {
    throw new Error("Cannot issue allocations: draw has no variants configured.");
  }

  const primaryVariant = draw.variants[0];
  const deadlineAt = new Date(now.getTime() + draw.claimWindowMinutes * 60 * 1000);

  // 2. Fetch existing allocations to know how many have been issued and which entries won
  const existingAllocations = await prisma.allocation.findMany({
    where: { drawId },
    select: { entryId: true, rank: true },
  });
  const alreadyAllocatedEntryIds = new Set(existingAllocations.map((a) => a.entryId));
  const remainingSlots = Math.max(0, draw.unitsAvailable - existingAllocations.length);

  if (remainingSlots === 0) {
    return { drawId, allocatedCount: 0, allocations: [] };
  }

  // 3. Fetch ranked entries
  const candidateEntries = await prisma.entry.findMany({
    where: {
      drawId,
      rank: { not: null },
      status: { in: ["VALID", "FLAGGED"] },
      id: { notIn: Array.from(alreadyAllocatedEntryIds) },
    },
    orderBy: { rank: "asc" },
  });

  const rules = (draw.rules as Record<string, unknown>) || {};
  const allowMultipleUnitsPerAddress = Boolean(rules.allowMultipleUnitsPerAddress);

  // 4. Filter winners respecting address uniqueness
  const selectedEntries = [];
  const seenAddressHashes = new Set<string>();

  // Collect addresses from already allocated entries if address uniqueness is enforced
  if (!allowMultipleUnitsPerAddress) {
    const priorEntries = await prisma.entry.findMany({
      where: { id: { in: Array.from(alreadyAllocatedEntryIds) }, addressHash: { not: null } },
      select: { addressHash: true },
    });
    for (const p of priorEntries) {
      if (p.addressHash) seenAddressHashes.add(p.addressHash);
    }
  }

  for (const entry of candidateEntries) {
    if (selectedEntries.length >= remainingSlots) break;

    if (!allowMultipleUnitsPerAddress && entry.addressHash) {
      if (seenAddressHashes.has(entry.addressHash)) {
        continue; // Skip address collision
      }
      seenAddressHashes.add(entry.addressHash);
    }

    selectedEntries.push(entry);
  }

  const createdAllocations: Array<{
    id: string;
    entryId: string;
    rank: number;
    claimToken: string;
    draftOrderGid: string;
  }> = [];

  const emailProvider = getEmailProvider();
  const shopDomain = draw.shop.shopDomain;
  const storeName = ((draw.shop.settings as Record<string, unknown>)?.storeName as string) || shopDomain;

  // 5. Issue each allocation
  for (const entry of selectedEntries) {
    const { token, claimTokenHash } = generateClaimToken();
    const decryptedEmail = decrypt(entry.emailEncrypted);

    let draftOrderGid = `gid://shopify/DraftOrder/mock-${Date.now()}-${entry.rank}`;
    let invoiceUrl = `https://${shopDomain}/checkouts/do/mock-${Date.now()}`;

    if (admin) {
      const draftResult = await createDraftOrderForWinner({
        admin,
        variantGid: primaryVariant.variantGid,
        msrpPrice: primaryVariant.msrpPrice.toString(),
        customerGid: entry.customerGid,
        email: decryptedEmail,
        drawId: draw.id,
        entryId: entry.id,
        deadlineAt,
      });
      draftOrderGid = draftResult.draftOrderGid;
      invoiceUrl = draftResult.invoiceUrl;
    }

    const allocation = await prisma.allocation.create({
      data: {
        shopId: draw.shopId,
        drawId: draw.id,
        entryId: entry.id,
        variantGid: primaryVariant.variantGid,
        rank: entry.rank!,
        claimTokenHash,
        draftOrderGid,
        invoiceUrl,
        deadlineAt,
        status: "ISSUED",
      },
    });

    createdAllocations.push({
      id: allocation.id,
      entryId: entry.id,
      rank: entry.rank!,
      claimToken: token,
      draftOrderGid,
    });

    // Send Winner Email
    const claimUrl = `https://${shopDomain}/apps/raffle/claim/${token}`;
    const emailContent = renderWinnerEmail({
      storeName,
      productTitle: draw.title,
      claimUrl,
      deadline: deadlineAt,
    });

    await emailProvider.sendEmail({
      to: decryptedEmail,
      from: `Fairdrops Raffle <raffles@${shopDomain}>`,
      replyTo: `support@${shopDomain}`,
      subject: `🎉 You Won! Claim your item: ${draw.title}`,
      html: emailContent.html,
      text: emailContent.text,
    });

    // Schedule QStash delayed message for deadlineAt (Phase 10 expiry)
    const qstashClient = getQStashClient();
    const baseUrl = process.env.SHOPIFY_APP_URL;
    if (qstashClient && baseUrl) {
      const delaySeconds = Math.max(0, Math.ceil((deadlineAt.getTime() - Date.now()) / 1000));
      await qstashClient
        .publishJSON({
          url: `${baseUrl.replace(/\/$/, "")}/api/qstash/allocation-expiry`,
          delay: delaySeconds,
          deduplicationId: `allocation:expiry:${allocation.id}`,
          body: { allocationId: allocation.id, drawId: draw.id },
        })
        .catch((err) => console.error("[QStash] Failed to schedule allocation expiry:", err));
    }
  }

  // 6. Transition draw to FULFILLING
  await prisma.draw.update({
    where: { id: drawId },
    data: { status: "FULFILLING" },
  });

  await prisma.auditLog.create({
    data: {
      shopId: draw.shopId,
      drawId: draw.id,
      eventType: "ALLOCATIONS_ISSUED",
      actor: "system",
      metadata: {
        allocatedCount: createdAllocations.length,
        deadlineAt: deadlineAt.toISOString(),
      },
    },
  });

  return {
    drawId,
    allocatedCount: createdAllocations.length,
    allocations: createdAllocations,
  };
}
