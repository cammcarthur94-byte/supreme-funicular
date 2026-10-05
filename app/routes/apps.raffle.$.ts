import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { decrypt, encrypt } from "../services/encryption";
import { evaluateEligibility, hashNormalizedEmail } from "../services/eligibility";
import { proxyJson, verifyAppProxyRequest } from "../services/appProxy.server";
import { unauthenticated } from "../shopify.server";
import { eligibilityRulesSchema } from "../validation/drawValidation";
import { isEntryWindowOpen } from "../services/entryWindow";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const proxy = verifyAppProxyRequest(request);
  if (!proxy) return proxyJson({ error: "Forbidden" }, 403);
  if (request.method !== "GET") return proxyJson({ error: "Method not allowed" }, 405);

  const [resource, identifier] = (params["*"] ?? "").split("/");

  // Single-use, customer-gated claim endpoint (Phase 9)
  if (resource === "claim" && identifier) {
    const rawToken = identifier;
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

    const allocation = await prisma.allocation.findUnique({
      where: { claimTokenHash: tokenHash },
      include: {
        draw: { select: { id: true, status: true } },
        entry: { select: { id: true, customerGid: true } },
      },
    });

    const GENERIC_EXPIRED_RESPONSE = new Response("Link is invalid or has expired.", {
      status: 404,
      headers: {
        "Content-Type": "text/plain",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });

    if (!allocation) {
      return GENERIC_EXPIRED_RESPONSE;
    }

    // Must be logged into the store
    if (!proxy.customerId) {
      const requestUrl = new URL(request.url);
      const returnUrl = encodeURIComponent(requestUrl.pathname + requestUrl.search);
      return new Response(null, {
        status: 302,
        headers: {
          Location: `https://${proxy.shop}/account/login?return_url=${returnUrl}`,
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      });
    }

    // Must match the winning customer's ID
    const expectedId = allocation.entry.customerGid.replace("gid://shopify/Customer/", "");
    const actualId = proxy.customerId.replace("gid://shopify/Customer/", "");
    if (actualId !== expectedId) {
      return GENERIC_EXPIRED_RESPONSE;
    }

    const now = new Date();
    const isStatusValid = allocation.status === "ISSUED" || allocation.status === "OPENED";
    const isWithinDeadline = now < allocation.deadlineAt;
    const isDrawActive = allocation.draw.status !== "CANCELLED";

    if (!isStatusValid || !isWithinDeadline || !isDrawActive) {
      return GENERIC_EXPIRED_RESPONSE;
    }

    if (allocation.status === "ISSUED") {
      await prisma.allocation.update({
        where: { id: allocation.id },
        data: {
          status: "OPENED",
          openedAt: now,
        },
      });

      await prisma.auditLog.create({
        data: {
          shopId: allocation.shopId,
          drawId: allocation.drawId,
          eventType: "ALLOCATION_CLAIM_LINK_OPENED",
          actor: `customer:${expectedId}`,
          metadata: {
            allocationId: allocation.id,
            openedAt: now.toISOString(),
          },
        },
      });
    }

    return new Response(null, {
      status: 302,
      headers: {
        Location: allocation.invoiceUrl || `https://${proxy.shop}/`,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  }

  // Support /apps/raffle, /apps/raffle/drop, /apps/raffle/draw/:id, and /apps/raffle/draws
  const isDrawRequest = !resource || resource === "drop" || resource === "draw" || resource === "draws";
  if (!isDrawRequest) return proxyJson({ error: "Not found" }, 404);

  const shop = await prisma.shop.findUnique({ where: { shopDomain: proxy.shop }, select: { id: true } });
  if (!shop) return proxyJson({ error: "Draw unavailable" }, 404);

  // Return list of all active/scheduled draws for the multi-raffle selector
  if (resource === "draws") {
    let draws = await prisma.draw.findMany({
      where: {
        shopId: shop.id,
        status: { in: ["SCHEDULED", "OPEN"] },
      },
      orderBy: { entryOpensAt: "asc" },
      select: {
        id: true,
        title: true,
        status: true,
        entryOpensAt: true,
        entryClosesAt: true,
        publicRulesText: true,
        rules: true,
      },
    });

    if (draws.length === 0) {
      draws = await prisma.draw.findMany({
        where: { shopId: shop.id },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          id: true,
          title: true,
          status: true,
          entryOpensAt: true,
          entryClosesAt: true,
          publicRulesText: true,
          rules: true,
        },
      });
    }

    const formattedDraws = draws.map((d) => {
      const rules = eligibilityRulesSchema.safeParse(d.rules);
      return {
        id: d.id,
        title: d.title,
        status: d.status,
        entryOpensAt: d.entryOpensAt,
        entryClosesAt: d.entryClosesAt,
        publicRulesText: d.publicRulesText,
        requireAccount: rules.success ? (rules.data.requireAccount !== false) : true,
        eligibility: rules.success
          ? {
              requireVerifiedEmail: rules.data.requireVerifiedEmail,
              allowedCountries: rules.data.allowedCountries,
              minAccountAgeDays: rules.data.minAccountAgeDays,
              requirePhone: rules.data.requirePhone,
            }
          : null,
      };
    });

    return proxyJson({
      draws: formattedDraws,
      customerId: proxy.customerId,
    });
  }

  const drawId = identifier;
  const draw = (!drawId || drawId === "latest")
    ? await prisma.draw.findFirst({
        where: { shopId: shop.id },
        orderBy: { createdAt: "desc" },
        select: { id: true, title: true, status: true, entryOpensAt: true, entryClosesAt: true, publicRulesText: true, rules: true },
      })
    : await prisma.draw.findFirst({
        where: { id: drawId, shopId: shop.id },
        select: { id: true, title: true, status: true, entryOpensAt: true, entryClosesAt: true, publicRulesText: true, rules: true },
      });

  if (!draw) return proxyJson({ error: "Draw unavailable" }, 404);

  const isHtml = !resource || request.headers.get("accept")?.includes("text/html");
  if (isHtml) {
    return new Response(renderRafflePageLiquid({ draw, customerId: proxy.customerId }), {
      status: 200,
      headers: { "Content-Type": "application/liquid" },
    });
  }

  const rules = eligibilityRulesSchema.safeParse(draw.rules);
  return proxyJson({
    draw: {
      id: draw.id,
      title: draw.title,
      status: draw.status,
      entryOpensAt: draw.entryOpensAt,
      entryClosesAt: draw.entryClosesAt,
      publicRulesText: draw.publicRulesText,
      requireAccount: rules.success ? (rules.data.requireAccount !== false) : true,
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

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderRafflePageLiquid(params: {
  draw: {
    id: string;
    title: string;
    status: string;
    entryOpensAt: Date;
    entryClosesAt: Date;
    publicRulesText: string | null;
    rules: unknown;
  };
  customerId: string | null;
}) {
  const rules = eligibilityRulesSchema.safeParse(params.draw.rules);
  const requirementList: string[] = [];
  if (rules.success) {
    if (rules.data.requireVerifiedEmail) requirementList.push("Verified email required");
    if (rules.data.requirePhone) requirementList.push("Phone number required");
    if (rules.data.minAccountAgeDays && rules.data.minAccountAgeDays > 0) {
      requirementList.push(`Account must be at least ${rules.data.minAccountAgeDays} days old`);
    }
    if (rules.data.allowedCountries && rules.data.allowedCountries.length > 0) {
      requirementList.push(`Eligible shipping countries: ${rules.data.allowedCountries.join(", ")}`);
    }
  }

  return `
<div class="fairdrops-storefront-wrapper" style="max-width: 680px; margin: 40px auto; padding: 0 16px; font-family: inherit;">
  <div style="background: #ffffff; border: 1px solid #e1e3e5; border-radius: 12px; padding: 32px; box-shadow: 0 4px 16px rgba(0,0,0,0.06);">
    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;">
      <span style="display: inline-block; background: #e4f0d5; color: #23541a; font-size: 13px; font-weight: 600; padding: 4px 12px; border-radius: 16px; text-transform: uppercase;">
        ${escapeHtml(params.draw.status)}
      </span>
      <span id="fairdrops-countdown" style="font-size: 14px; color: #5c5f62; font-weight: 600;">Calculating...</span>
    </div>

    <h1 style="font-size: 28px; font-weight: 700; margin: 0 0 16px 0; color: #202223; line-height: 1.2;">
      ${escapeHtml(params.draw.title)}
    </h1>

    <div style="margin-bottom: 24px;">
      <h3 style="font-size: 15px; font-weight: 600; color: #202223; margin: 0 0 8px 0;">Eligibility Requirements</h3>
      <ul style="margin: 0; padding-left: 20px; color: #44474a; line-height: 1.6; font-size: 14px;">
        ${requirementList.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}
      </ul>
      ${
        params.draw.publicRulesText
          ? `<p style="margin-top: 12px; font-size: 13px; color: #6d7175; font-style: italic;">${escapeHtml(params.draw.publicRulesText)}</p>`
          : ""
      }
    </div>

    <div id="fairdrops-entry-box" style="border-top: 1px solid #e1e3e5; padding-top: 24px;">
      ${
        params.customerId
          ? `
        <button id="fairdrops-submit-btn" style="width: 100%; background: #008060; color: #ffffff; border: none; padding: 14px 24px; font-size: 16px; font-weight: 600; border-radius: 8px; cursor: pointer;">
          Enter This Draw
        </button>
        <p id="fairdrops-entry-msg" style="margin-top: 12px; font-size: 14px; text-align: center; display: none;"></p>
      `
          : `
        <div style="text-align: center;">
          <p style="margin-bottom: 16px; color: #5c5f62; font-size: 14px;">You must be signed in to your customer account to enter.</p>
          <a href="/account/login?return_url={{ request.path | url_encode }}" style="display: inline-block; background: #202223; color: #ffffff; text-decoration: none; padding: 12px 24px; font-size: 15px; font-weight: 600; border-radius: 8px;">
            Log in / Create account to enter
          </a>
        </div>
      `
      }
    </div>
  </div>
</div>

<script>
(() => {
  const opensAt = new Date("${params.draw.entryOpensAt.toISOString()}").getTime();
  const closesAt = new Date("${params.draw.entryClosesAt.toISOString()}").getTime();
  const countdownEl = document.getElementById("fairdrops-countdown");
  const btn = document.getElementById("fairdrops-submit-btn");
  const msgEl = document.getElementById("fairdrops-entry-msg");

  function fmt(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return (d > 0 ? d + "d " : "") + h + "h " + m + "m " + sec + "s";
  }

  function update() {
    const now = Date.now();
    if (now < opensAt) {
      countdownEl.textContent = "Entries open in " + fmt(opensAt - now);
      if (btn) btn.disabled = true;
    } else if (now < closesAt) {
      countdownEl.textContent = "Entries close in " + fmt(closesAt - now);
      if (btn) btn.disabled = false;
    } else {
      countdownEl.textContent = "Entries are closed";
      if (btn) btn.disabled = true;
    }
  }
  update();
  setInterval(update, 1000);

  if (btn) {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Submitting entry...";
      try {
        const res = await fetch("/apps/raffle/entry/${params.draw.id}", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin"
        });
        const data = await res.json();
        msgEl.style.display = "block";
        if (res.ok && data.success) {
          msgEl.style.color = "#008060";
          msgEl.textContent = "🎉 You're entered! Check your email when the draw completes.";
          btn.style.display = "none";
        } else {
          msgEl.style.color = "#d72c0d";
          msgEl.textContent = data.userMessage || data.error || "Entry failed. Please check requirements.";
          btn.disabled = false;
          btn.textContent = "Enter This Draw";
        }
      } catch (err) {
        msgEl.style.display = "block";
        msgEl.style.color = "#d72c0d";
        msgEl.textContent = "Error submitting entry. Please try again.";
        btn.disabled = false;
        btn.textContent = "Enter This Draw";
      }
    });
  }
})();
</script>
`;
}

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const proxy = verifyAppProxyRequest(request);
  if (!proxy) return proxyJson({ error: "Forbidden" }, 403);
  if (request.method !== "POST") return proxyJson({ error: "Method not allowed" }, 405);

  const [resource, rawDrawId] = (params["*"] ?? "").split("/");
  if (resource !== "entry" || !rawDrawId) return proxyJson({ error: "Not found" }, 404);
  const shop = await prisma.shop.findUnique({ where: { shopDomain: proxy.shop }, select: { id: true } });
  if (!shop) return proxyJson({ error: "Draw unavailable" }, 404);

  let drawId = rawDrawId;
  if (drawId === "latest") {
    const latest = await prisma.draw.findFirst({
      where: { shopId: shop.id },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (!latest) return proxyJson({ error: "Draw unavailable" }, 404);
    drawId = latest.id;
  }

  if (!proxy.customerId) return proxyJson({ error: "Log in to your customer account to enter." }, 401);

  const body = (await request.clone().json().catch(() => ({}))) as Record<string, unknown>;
  const fallback = (body.customerData as Record<string, unknown>) || {};

  let email = typeof fallback.email === "string" && fallback.email.includes("@") ? fallback.email : undefined;
  const verifiedEmail = fallback.verifiedEmail !== false;
  let countryCode = typeof fallback.countryCode === "string" && fallback.countryCode.trim() !== "" ? fallback.countryCode.trim().toUpperCase() : null;
  let createdAt = typeof fallback.createdAt === "string" ? fallback.createdAt : new Date(Date.now() - 30 * 86400000).toISOString();
  let phone = typeof fallback.phone === "string" ? fallback.phone : null;

  // Only attempt Admin GraphQL if email was not supplied by authenticated storefront session
  if (!email && proxy.customerId) {
    try {
      const { admin } = await unauthenticated.admin(proxy.shop);
      const response = await admin.graphql(
        `#graphql
          query RaffleEntryCustomer($id: ID!) {
            customer(id: $id) {
              id
              email
              createdAt
              phone
              defaultAddress { countryCodeV2 }
            }
          }
        `,
        { variables: { id: `gid://shopify/Customer/${proxy.customerId}` } }
      );
      const payload = (await response.json()) as {
        data?: {
          customer?: {
            id: string;
            email?: string | null;
            createdAt: string;
            phone?: string | null;
            defaultAddress?: { countryCodeV2: string } | null;
          } | null;
        };
      };
      const customer = payload.data?.customer;
      if (customer?.email) {
        email = customer.email;
        countryCode = countryCode || customer.defaultAddress?.countryCodeV2 || null;
        createdAt = customer.createdAt;
        phone = phone || customer.phone || null;
      }
    } catch (err) {
      console.warn("[entry] Admin GraphQL customer query skipped/failed:", err);
    }
  }

  if (!email && proxy.customerId) {
    email = `customer_${proxy.customerId}@store.customer`;
  }

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
      if (!lockedDraw.encryptionKeyId) {
        console.error(`[entry] Missing draw encryption key for ${drawId}`);
        return { status: 500 as const, body: { error: "We couldn't process your entry. Please try again." } };
      }

      const parsedRules = eligibilityRulesSchema.safeParse(lockedDraw.rules);
      if (!parsedRules.success) throw new Error("Draw eligibility configuration is invalid");

      if (!countryCode) {
        countryCode = typeof fallback.countryCode === "string" && fallback.countryCode.trim() !== ""
          ? fallback.countryCode.trim().toUpperCase()
          : (parsedRules.data.allowedCountries?.[0] ?? "CA");
      }

      const geoCountry = request.headers.get("x-country-code") || request.headers.get("cf-ipcountry");
      const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();

      const evaluation = evaluateEligibility(
        parsedRules.data,
        {
          customerId: proxy.customerId,
          email,
          verifiedEmail,
          countryCode,
          createdAt,
          phone,
        },
        { now, geoCountry, clientIp }
      );

      if (!evaluation.eligible) {
        return {
          status: 422 as const,
          body: { error: evaluation.userMessage, reasonCode: evaluation.reasonCode },
        };
      }

      const customerEmail = email || `customer_${proxy.customerId}@store.customer`;
      const normalizedEmail = evaluation.normalizedEmail || customerEmail.trim().toLowerCase();
      const normalizedEmailHash = evaluation.normalizedEmailHash || hashNormalizedEmail(customerEmail);
      const rawDrawKey = decrypt(lockedDraw.encryptionKeyId);

      const riskFlags: string[] = [];
      if (evaluation.riskSignals?.geoIpMismatch) {
        riskFlags.push("GEO_IP_MISMATCH");
      }

      await tx.entry.create({
        data: {
          shopId: shop.id,
          drawId: lockedDraw.id,
          customerGid: `gid://shopify/Customer/${proxy.customerId}`,
          normalizedEmailHash,
          emailEncrypted: encrypt(normalizedEmail, Buffer.from(rawDrawKey, "base64")),
          countryCode: countryCode ?? null,
          riskFlags,
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
