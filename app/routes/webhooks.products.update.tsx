import type { ActionFunctionArgs } from "react-router";
import { authenticate, unauthenticated } from "../shopify.server";
import prisma from "../db.server";
import { checkAndRemediateProductVisibility } from "../services/productVisibility.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, topic, admin: webhookAdmin } = await authenticate.webhook(request);

  console.log(`[Webhook:${topic}] Received product update for shop: ${shop}`);

  try {
    const shopRecord = await prisma.shop.findUnique({
      where: { shopDomain: shop },
    });

    if (!shopRecord) {
      console.warn(`[Webhook:${topic}] Shop record not found for domain: ${shop}`);
      return new Response("Shop not found", { status: 200 });
    }

    const payloadObj = (payload || {}) as Record<string, unknown>;
    const rawId = payloadObj.id;
    const adminGraphqlApiId = payloadObj.admin_graphql_api_id;
    const productGid =
      (typeof adminGraphqlApiId === "string" ? adminGraphqlApiId : null) ||
      (rawId ? `gid://shopify/Product/${rawId}` : null);

    if (!productGid) {
      console.warn(`[Webhook:${topic}] No product GID found in payload.`);
      return new Response("Missing product GID", { status: 200 });
    }

    // Check if this product is part of any active draws
    const activeDraws = await prisma.draw.findMany({
      where: {
        shopId: shopRecord.id,
        status: { in: ["SCHEDULED", "OPEN", "FULFILLING"] },
        variants: {
          some: { productGid },
        },
      },
      select: { id: true, title: true },
    });

    if (activeDraws.length === 0) {
      // Not a raffle product in an active drop; ignore
      return new Response("Product not in active raffle", { status: 200 });
    }

    console.log(
      `[Webhook:${topic}] Product ${productGid} is assigned to ${activeDraws.length} active draw(s). Checking publication status...`
    );

    // Ensure we have an admin GraphQL client
    let admin = webhookAdmin;
    if (!admin) {
      const client = await unauthenticated.admin(shop);
      admin = client.admin;
    }

    const remediation = await checkAndRemediateProductVisibility({
      admin,
      productGid,
      shopId: shopRecord.id,
      triggerSource: "webhook",
    });

    if (remediation.breached) {
      console.warn(
        `[Webhook:${topic}] CRITICAL: Product ${productGid} was re-published on [${remediation.publishedChannels.join(
          ", "
        )}]. Remediated: ${remediation.remediated}.`
      );
    } else {
      console.log(`[Webhook:${topic}] Product ${productGid} verified unpublished.`);
    }

    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error(`[Webhook:${topic}] Failed to process product update webhook:`, error);
    return new Response("Internal Error", { status: 500 });
  }
};
