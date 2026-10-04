import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { forShop } from "./tenantDb";

export const GET_PRODUCT_PUBLICATIONS_QUERY = `#graphql
  query GetProductPublications($id: ID!) {
    product(id: $id) {
      id
      title
      status
      resourcePublicationsV2(first: 50) {
        edges {
          node {
            isPublished
            publishDate
            publication {
              id
              name
            }
          }
        }
      }
    }
  }
`;

export const UNPUBLISH_PRODUCT_MUTATION = `#graphql
  mutation UnpublishProduct($id: ID!, $input: [PublicationInput!]!) {
    publishableUnpublish(id: $id, input: $input) {
      publishable {
        availablePublicationCount
        publicationCount
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export interface PublicationItem {
  publicationId: string;
  name: string;
  isPublished: boolean;
  publishDate?: string | null;
}

export interface ProductPublicationState {
  productGid: string;
  title: string;
  status: string;
  publications: PublicationItem[];
  activePublicationIds: string[];
  activePublicationNames: string[];
}

export interface GraphQLPublicationEdge {
  node: {
    isPublished: boolean;
    publishDate?: string | null;
    publication: {
      id: string;
      name: string;
    };
  };
}

export interface GraphQLUserError {
  field?: string[];
  message: string;
}

export interface AdminGraphQLClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> }
  ) => Promise<{ json: () => Promise<unknown> }>;
}

/**
 * Inspects a product's current publication status across all channels.
 */
export async function getProductPublicationState(
  admin: AdminGraphQLClient,
  productGid: string
): Promise<ProductPublicationState | null> {
  const response = await admin.graphql(GET_PRODUCT_PUBLICATIONS_QUERY, {
    variables: { id: productGid },
  });
  const data = (await response.json()) as {
    data?: {
      product?: {
        title: string;
        status: string;
        resourcePublicationsV2?: {
          edges: GraphQLPublicationEdge[];
        };
      };
    };
  };
  const product = data?.data?.product;

  if (!product) {
    return null;
  }

  const publications: PublicationItem[] = (
    product.resourcePublicationsV2?.edges || []
  ).map((edge) => ({
    publicationId: edge.node.publication.id,
    name: edge.node.publication.name,
    isPublished: Boolean(edge.node.isPublished),
    publishDate: edge.node.publishDate,
  }));

  const activePublications = publications.filter((p) => p.isPublished);

  return {
    productGid,
    title: product.title,
    status: product.status,
    publications,
    activePublicationIds: activePublications.map((p) => p.publicationId),
    activePublicationNames: activePublications.map((p) => p.name),
  };
}

/**
 * Takes a visibility snapshot and unpublishes the product from all channels.
 * Called upon Draw creation or modification.
 */
export async function unpublishProductFromAllChannels({
  admin,
  productGid,
  drawId,
  shopId,
}: {
  admin: AdminGraphQLClient;
  productGid: string;
  drawId: string;
  shopId: string;
}): Promise<{
  snapshotSaved: boolean;
  unpublishedCount: number;
  errors?: string[];
}> {
  const tenant = forShop(shopId);
  const state = await getProductPublicationState(admin, productGid);

  if (!state) {
    return {
      snapshotSaved: false,
      unpublishedCount: 0,
      errors: [`Product with GID ${productGid} not found in Shopify.`],
    };
  }

  // 1. Save or update the visibility snapshot
  await tenant.productVisibilitySnapshot.upsert({
    drawId,
    productGid,
    snapshotData: {
      title: state.title,
      status: state.status,
      publications: state.publications,
      activePublicationCount: state.activePublicationIds.length,
      snapshottedAt: new Date().toISOString(),
    } as unknown as Prisma.InputJsonValue,
  });

  // 2. If published on any channels, unpublish immediately
  if (state.activePublicationIds.length > 0) {
    const input = state.activePublicationIds.map((publicationId) => ({
      publicationId,
    }));

    const unpublishResp = await admin.graphql(UNPUBLISH_PRODUCT_MUTATION, {
      variables: {
        id: productGid,
        input,
      },
    });

    const unpublishData = (await unpublishResp.json()) as {
      data?: {
        publishableUnpublish?: {
          userErrors?: GraphQLUserError[];
        };
      };
    };
    const userErrors = unpublishData?.data?.publishableUnpublish?.userErrors || [];

    if (userErrors.length > 0) {
      const errorMsgs = userErrors.map(
        (e) => `${(e.field || []).join(".")}: ${e.message}`
      );
      await tenant.auditLog.create({
        drawId,
        eventType: "PRODUCT_UNPUBLISH_FAILED",
        actor: "system",
        metadata: {
          productGid,
          errors: errorMsgs,
        },
      });
      return {
        snapshotSaved: true,
        unpublishedCount: 0,
        errors: errorMsgs,
      };
    }

    await tenant.auditLog.create({
      drawId,
      eventType: "PRODUCT_UNPUBLISHED",
      actor: "system",
      metadata: {
        productGid,
        channels: state.activePublicationNames,
        channelsCount: state.activePublicationIds.length,
      },
    });

    return {
      snapshotSaved: true,
      unpublishedCount: state.activePublicationIds.length,
    };
  }

  return {
    snapshotSaved: true,
    unpublishedCount: 0,
  };
}

/**
 * Checks a product's publication status and remediates immediately if published.
 * Used by the Webhook, QStash guard, and Vercel Cron backstop.
 */
export async function checkAndRemediateProductVisibility({
  admin,
  productGid,
  shopId,
  drawId,
  triggerSource,
}: {
  admin: AdminGraphQLClient;
  productGid: string;
  shopId: string;
  drawId?: string;
  triggerSource: "webhook" | "qstash" | "cron";
}): Promise<{
  breached: boolean;
  remediated: boolean;
  publishedChannels: string[];
}> {
  const tenant = forShop(shopId);

  // 1. Identify active draws containing this product
  const activeDraws = await prisma.draw.findMany({
    where: {
      shopId,
      ...(drawId ? { id: drawId } : {}),
      status: { in: ["SCHEDULED", "OPEN", "FULFILLING"] },
      variants: {
        some: { productGid },
      },
    },
    select: { id: true, title: true },
  });

  if (activeDraws.length === 0) {
    return { breached: false, remediated: false, publishedChannels: [] };
  }

  // 2. Fetch current publication state from Shopify GraphQL
  const state = await getProductPublicationState(admin, productGid);
  if (!state || state.activePublicationIds.length === 0) {
    return { breached: false, remediated: false, publishedChannels: [] };
  }

  // 3. Product is published while assigned to an active drop! BREACH DETECTED.
  const input = state.activePublicationIds.map((publicationId) => ({
    publicationId,
  }));

  const unpublishResp = await admin.graphql(UNPUBLISH_PRODUCT_MUTATION, {
    variables: {
      id: productGid,
      input,
    },
  });

  const unpublishData = (await unpublishResp.json()) as {
    data?: {
      publishableUnpublish?: {
        userErrors?: GraphQLUserError[];
      };
    };
  };
  const userErrors = unpublishData?.data?.publishableUnpublish?.userErrors || [];
  const remediated = userErrors.length === 0;

  // 4. Update each active draw with warning flag and audit log
  const channelList = state.activePublicationNames.join(", ");
  const warningMessage = `CRITICAL: Raffle product "${state.title}" was detected as published on [${channelList}] via ${triggerSource} at ${new Date().toISOString()}. Fairdrops automatically unpublished it to prevent unauthorized storefront purchases.`;

  for (const draw of activeDraws) {
    await tenant.draw.update({
      where: { id: draw.id },
      data: {
        hasVisibilityWarning: true,
        visibilityWarning: warningMessage,
      },
    });

    await tenant.auditLog.create({
      drawId: draw.id,
      eventType: "PRODUCT_VISIBILITY_BREACH_DETECTED",
      actor: `guard_${triggerSource}`,
      metadata: {
        productGid,
        triggerSource,
        publishedChannels: state.activePublicationNames,
        remediated,
        userErrors,
      } as unknown as Prisma.InputJsonValue,
    });
  }

  return {
    breached: true,
    remediated,
    publishedChannels: state.activePublicationNames,
  };
}
