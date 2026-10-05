import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { recordAllocationPurchase } from "../services/claimExpiry.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, topic } = await authenticate.webhook(request);

  console.log(`[Webhook:${topic}] Processing paid order for shop: ${shop}`);

  try {
    const payloadObj = (payload || {}) as Record<string, unknown>;
    const tags = String(payloadObj.tags || "");
    const note = String(payloadObj.note || "");
    const orderId = payloadObj.admin_graphql_api_id || `gid://shopify/Order/${payloadObj.id}`;
    const shippingAddress = (payloadObj.shipping_address as Record<string, unknown>) || {};
    const shippingCountryCode = String(shippingAddress.country_code || "").toUpperCase();
    const customerObj = (payloadObj.customer as Record<string, unknown>) || {};
    const webhookEventId = request.headers.get("x-shopify-webhook-id") || undefined;

    const result = await recordAllocationPurchase({
      shopDomain: shop,
      orderId: String(orderId),
      tags,
      note,
      webhookEventId,
      topic,
      customerId: customerObj.id ? String(customerObj.id) : undefined,
      shippingCountryCode,
    });

    console.log(`[Webhook:${topic}] Result:`, result);
    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error(`[Webhook:${topic}] Error processing paid order webhook:`, err);
    return new Response("Internal Error", { status: 500 });
  }
};
