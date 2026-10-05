import crypto from "node:crypto";

export interface VerifiedProxyRequest {
  shop: string;
  customerId: string | null;
  params: URLSearchParams;
}

/** Shopify app proxy signature: sort parameter keys, comma-join duplicate values, and HMAC the concatenated pairs. */
export function verifyAppProxyRequest(
  request: Request,
  secret = process.env.SHOPIFY_API_SECRET
): VerifiedProxyRequest | null {
  if (!secret) return null;

  const url = new URL(request.url);
  const params = new URLSearchParams(url.search);
  const signatures = params.getAll("signature");
  if (signatures.length !== 1 || !/^[a-f\d]{64}$/i.test(signatures[0])) return null;

  const timestampValues = params.getAll("timestamp");
  const shopValues = params.getAll("shop");
  const customerValues = params.getAll("logged_in_customer_id");
  if (timestampValues.length !== 1 || shopValues.length !== 1) return null;
  if (customerValues.length > 1) return null;

  const timestamp = Number(timestampValues[0]);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(timestamp) || timestamp > nowSeconds + 60 || nowSeconds - timestamp > 86400) return null;

  const shop = shopValues[0].toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) return null;

  params.delete("signature");
  const signedMessage = [...new Set([...params.keys()])]
    .sort()
    .map((key) => `${key}=${params.getAll(key).join(",")}`)
    .join("");
  const expected = crypto.createHmac("sha256", secret).update(signedMessage).digest();
  const supplied = Buffer.from(signatures[0], "hex");
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;

  const rawCustomer = customerValues[0]?.trim();
  const customerId = rawCustomer && rawCustomer.length > 0 ? rawCustomer : null;
  if (customerId !== null && !/^\d+$/.test(customerId)) return null;
  return { shop, customerId, params };
}

export function proxyJson(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
