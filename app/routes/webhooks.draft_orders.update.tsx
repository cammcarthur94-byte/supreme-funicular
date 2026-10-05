import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { recordAllocationPurchase } from "../services/claimExpiry.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, topic } = await authenticate.webhook(request);

  console.log(`[Webhook:${topic}] Processing draft order update for shop: ${shop}`);

  try {
    const payloadObj = (payload || {}) as Record<string, unknown>;
    const status = String(payloadObj.status || "").toLowerCase();
    const orderId = payloadObj.order_id ? `gid://shopify/Order/${payloadObj.order_id}` : undefined;

    // Only process when draft order is completed / converted to an order
    if (status !== "completed" && !orderId) {
      return new Response("Draft order not completed", { status: 200 });
    }

    const tags = String(payloadObj.tags || "");
    const note = String(payloadObj.note || "");
    const draftOrderId = payloadObj.admin_graphql_api_id || `gid://shopify/DraftOrder/${payloadObj.id}`;
    const customerObj = (payloadObj.customer as Record<string, unknown>) || {};
    const webhookEventId = request.headers.get("x-shopify-webhook-id") || undefined;

    const result = await recordAllocationPurchase({
      shopDomain: shop,
      orderId: orderId || String(draftOrderId),
      draftOrderGid: String(draftOrderId),
      tags,
      note,
      webhookEventId,
      topic,
      customerId: customerObj.id ? String(customerObj.id) : undefined,
    });

    console.log(`[Webhook:${topic}] Result:`, result);
    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error(`[Webhook:${topic}] Error processing draft order update webhook:`, err);
    return new Response("Internal Error", { status: 500 });
  }
};
