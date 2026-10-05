import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { decrypt, encrypt, hashIdentifier } from "../services/encryption";
import { checkEntryEligibility, getAccountEligibility } from "../services/eligibility.server";
import { proxyJson, verifyAppProxyRequest } from "../services/appProxy.server";
import { unauthenticated } from "../shopify.server";
import { eligibilityRulesSchema } from "../validation/drawValidation";
import { isEntryWindowOpen } from "../services/entryWindow";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const proxy = verifyAppProxyRequest(request);
  if (!proxy) return proxyJson({ error: "Forbidden" }, 403);
  if (request.method !== "GET") return proxyJson({ error: "Method not allowed" }, 405);

  const [resource, drawId] = (params["*"] ?? "").split("/");
  if (resource !== "draw" || !drawId) return proxyJson({ error: "Not found" }, 404);
  const shop = await prisma.shop.findUnique({ where: { shopDomain: proxy.shop }, select: { id: true } });
  if (!shop) return proxyJson({ error: "Draw unavailable" }, 404);
  const draw = await prisma.draw.findFirst({
    where: { id: drawId, shopId: shop.id },
    select: { id: true, title: true, status: true, entryOpensAt: true, entryClosesAt: true, publicRulesText: true, rules: true },
  });
  if (!draw) return proxyJson({ error: "Draw unavailable" }, 404);

  const rules = eligibilityRulesSchema.safeParse(draw.rules);
  return proxyJson({
    draw: {
      id: draw.id,
      title: draw.title,
      status: draw.status,
      entryOpensAt: draw.entryOpensAt,
      entryClosesAt: draw.entryClosesAt,
      publicRulesText: draw.publicRulesText,
      requireAccount: getAccountEligibility(),
      eligibility: rules.success ? {
        requireVerifiedEmail: rules.data.requireVerifiedEmail,
        allowedCountries: rules.data.allowedCountries,
        minAccountAgeDays: rules.data.minAccountAgeDays,
        requirePhone: rules.data.requirePhone,
      } : null,
    },
    customerId: proxy.customerId,
  });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const proxy = verifyAppProxyRequest(request);
  if (!proxy) return proxyJson({ error: "Forbidden" }, 403);
  if (request.method !== "POST") return proxyJson({ error: "Method not allowed" }, 405);

  const [resource, drawId] = (params["*"] ?? "").split("/");
  if (resource !== "entry" || !drawId) return proxyJson({ error: "Not found" }, 404);
  const shop = await prisma.shop.findUnique({ where: { shopDomain: proxy.shop }, select: { id: true } });
  if (!shop) return proxyJson({ error: "Draw unavailable" }, 404);

  try {
    const result = await prisma.$transaction(async (tx) => {
      const [lockedDraw] = await tx.$queryRaw<Array<{
        id: string;
        shopId: string;
        status: string;
        entryOpensAt: Date;
        entryClosesAt: Date;
        rules: unknown;
        encryptionKeyId: string | null;
      }>>`SELECT "id", "shopId", "status", "entryOpensAt", "entryClosesAt", "rules", "encryptionKeyId" FROM "raffle"."Draw" WHERE "id" = ${drawId} AND "shopId" = ${shop.id} FOR UPDATE`;
      if (!lockedDraw) return { status: 404 as const, body: { error: "Draw unavailable" } };

      const dbNowResult = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
      const now = dbNowResult[0]?.now ?? new Date();
      let drawStatus = lockedDraw.status;
      // Promote due draws here too, so a delayed QStash open message cannot block valid entries.
      if (drawStatus === "SCHEDULED" && now >= lockedDraw.entryClosesAt) {
        await tx.draw.update({ where: { id: drawId }, data: { status: "CLOSED" } });
        drawStatus = "CLOSED";
      } else if (drawStatus === "SCHEDULED" && isEntryWindowOpen("OPEN", now, lockedDraw.entryOpensAt, lockedDraw.entryClosesAt)) {
        await tx.draw.update({ where: { id: drawId }, data: { status: "OPEN" } });
        drawStatus = "OPEN";
      }
      if (!isEntryWindowOpen(drawStatus, now, lockedDraw.entryOpensAt, lockedDraw.entryClosesAt)) {
        return { status: 409 as const, body: { error: "Entries are closed for this draw." } };
      }
      if (!proxy.customerId) return { status: 401 as const, body: { error: "Log in to your customer account to enter." } };
      if (!lockedDraw.encryptionKeyId) {
        console.error(`[entry] Missing draw encryption key for ${drawId}`);
        return { status: 500 as const, body: { error: "We couldn't process your entry. Please try again." } };
      }

      // Never read identity from the body: use only Shopify's signed logged_in_customer_id.
      const { admin } = await unauthenticated.admin(proxy.shop);
      const response = await admin.graphql(
        `#graphql
          query RaffleEntryCustomer($id: ID!) {
            customer(id: $id) {
              id
              defaultEmailAddress { emailAddress }
              verifiedEmail
              createdAt
              defaultPhoneNumber { phoneNumber }
              defaultAddress { countryCodeV2 }
            }
          }
        `,
        { variables: { id: `gid://shopify/Customer/${proxy.customerId}` } }
      );
      const payload = await response.json() as {
        data?: { customer?: {
          id: string;
          defaultEmailAddress?: { emailAddress: string } | null;
          verifiedEmail: boolean;
          createdAt: string;
          defaultPhoneNumber?: { phoneNumber: string } | null;
          defaultAddress?: { countryCodeV2: string } | null;
        } | null };
        errors?: unknown;
      };
      const customer = payload.data?.customer;
      const email = customer?.defaultEmailAddress?.emailAddress;
      if (payload.errors || !customer || !email || customer.id !== `gid://shopify/Customer/${proxy.customerId}`) {
        throw new Error("Customer lookup failed");
      }

      const parsedRules = eligibilityRulesSchema.safeParse(lockedDraw.rules);
      if (!parsedRules.success) throw new Error("Draw eligibility configuration is invalid");
      const eligibility = checkEntryEligibility(parsedRules.data, {
        email,
        emailVerified: customer.verifiedEmail,
        countryCode: customer.defaultAddress?.countryCodeV2 ?? null,
        createdAt: new Date(customer.createdAt),
        phone: customer.defaultPhoneNumber?.phoneNumber ?? null,
      }, now);
      if (!eligibility.eligible) return { status: 422 as const, body: { error: eligibility.message } };

      const normalizedEmail = email.trim().toLowerCase();
      const rawDrawKey = decrypt(lockedDraw.encryptionKeyId);
      await tx.entry.create({
        data: {
          shopId: shop.id,
          drawId: lockedDraw.id,
          customerGid: customer.id,
          normalizedEmailHash: hashIdentifier(normalizedEmail),
          emailEncrypted: encrypt(normalizedEmail, Buffer.from(rawDrawKey, "base64")),
          countryCode: customer.defaultAddress?.countryCodeV2 ?? null,
        },
      });
      return { status: 201 as const, body: { success: true, message: "Your entry has been submitted." } };
    }, { maxWait: 10_000, timeout: 30_000 });

    return proxyJson(result.body, result.status);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return proxyJson({ error: "You've already entered this draw." }, 409);
    }
    console.error("[entry] Entry submission failed:", error);
    return proxyJson({ error: "We couldn't process your entry. Please try again." }, 500);
  }
};
