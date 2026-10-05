import type { ActionFunctionArgs } from "react-router";
import { authenticate, unauthenticated } from "../shopify.server";
import prisma from "../db.server";

const ORDER_CANCEL_MUTATION = `#graphql
  mutation orderCancel($orderId: ID!, $reason: OrderCancelReason!, $refund: Boolean!) {
    orderCancel(orderId: $orderId, reason: $reason, refund: $refund) {
      job {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, topic, admin: webhookAdmin } = await authenticate.webhook(request);

  console.log(`[Webhook:${topic}] Processing order creation for shop: ${shop}`);

  try {
    const shopRecord = await prisma.shop.findUnique({
      where: { shopDomain: shop },
    });

    if (!shopRecord) {
      console.warn(`[Webhook:${topic}] Shop record not found for domain: ${shop}`);
      return new Response("Shop not found", { status: 200 });
    }

    const payloadObj = (payload || {}) as Record<string, unknown>;
    const tags = String(payloadObj.tags || "");
    const note = String(payloadObj.note || "");
    const orderId = payloadObj.admin_graphql_api_id || `gid://shopify/Order/${payloadObj.id}`;
    const shippingAddress = (payloadObj.shipping_address as Record<string, unknown>) || {};
    const shippingCountryCode = String(shippingAddress.country_code || "").toUpperCase();

    // Check if order originates from a Fairdrops raffle
    const drawMatch = tags.match(/raffle:([a-f\d-]{36})/i) || note.match(/raffle.*?([a-f\d-]{36})/i);
    const entryMatch = tags.match(/entry:([a-f\d-]{36})/i);

    if (!drawMatch) {
      // Normal store order, not a raffle checkout
      return new Response("Not a raffle order", { status: 200 });
    }

    const drawId = drawMatch[1];
    const entryId = entryMatch ? entryMatch[1] : undefined;

    // Look up the corresponding allocation
    const allocation = await prisma.allocation.findFirst({
      where: {
        drawId,
        ...(entryId ? { entryId } : {}),
      },
      include: {
        draw: true,
      },
    });

    if (!allocation) {
      console.warn(`[Webhook:${topic}] No allocation found for draw: ${drawId}, entry: ${entryId}`);
      return new Response("Allocation not found", { status: 200 });
    }

    const rules = (allocation.draw.rules as Record<string, unknown>) || {};
    const allowedCountries = Array.isArray(rules.allowedCountries)
      ? (rules.allowedCountries as unknown[]).map((c) => String(c).toUpperCase())
      : [];

    // Verify shipping country against draw eligibility rules (Requirement 5)
    if (allowedCountries.length > 0 && (!shippingCountryCode || !allowedCountries.includes(shippingCountryCode))) {
      console.warn(
        `[Webhook:${topic}] REGION VIOLATION: Order ${orderId} shipping to ${shippingCountryCode}, but allowed countries are [${allowedCountries.join(
          ", "
        )}]. Auto-cancelling and refunding...`
      );

      // Auto-cancel and refund order via Admin GraphQL API
      let admin = webhookAdmin;
      if (!admin) {
        const client = await unauthenticated.admin(shop);
        admin = client.admin;
      }

      try {
        const cancelResponse = await admin.graphql(ORDER_CANCEL_MUTATION, {
          variables: {
            orderId,
            reason: "OTHER",
            refund: true,
          },
        });
        const cancelJson = await cancelResponse.json();
        const userErrors = cancelJson?.data?.orderCancel?.userErrors || [];
        if (userErrors.length > 0) {
          console.error(`[Webhook:${topic}] Order cancellation user errors:`, userErrors);
        }
      } catch (cancelErr) {
        console.error(`[Webhook:${topic}] Failed to auto-cancel order:`, cancelErr);
      }

      // Mark allocation CANCELLED
      await prisma.allocation.update({
        where: { id: allocation.id },
        data: { status: "CANCELLED" },
      });

      await prisma.auditLog.create({
        data: {
          shopId: shopRecord.id,
          drawId: allocation.drawId,
          eventType: "ALLOCATION_REGION_VIOLATION_CANCELLED",
          actor: "system",
          metadata: {
            allocationId: allocation.id,
            orderId,
            shippingCountryCode,
            allowedCountries,
            message: `Order auto-cancelled and refunded: shipping country ${shippingCountryCode} violated allowed countries.`,
          },
        },
      });

      return new Response("Order cancelled for region violation", { status: 200 });
    }

    // Valid purchase! Update allocation status to PURCHASED
    await prisma.allocation.update({
      where: { id: allocation.id },
      data: {
        status: "PURCHASED",
        purchasedAt: new Date(),
      },
    });

    const customerObj = (payloadObj.customer as Record<string, unknown>) || {};
    await prisma.auditLog.create({
      data: {
        shopId: shopRecord.id,
        drawId: allocation.drawId,
        eventType: "ALLOCATION_PURCHASED",
        actor: `customer:${customerObj.id || "unknown"}`,
        metadata: {
          allocationId: allocation.id,
          orderId,
          shippingCountryCode,
        },
      },
    });

    console.log(`[Webhook:${topic}] Allocation ${allocation.id} successfully marked PURCHASED.`);
    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error(`[Webhook:${topic}] Error processing order webhook:`, err);
    return new Response("Internal Error", { status: 500 });
  }
};
