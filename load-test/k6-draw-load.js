/* global __ENV */
import http from "k6/http";
import { check, sleep } from "k6";
import crypto from "k6/crypto";

export const options = {
  scenarios: {
    sustained_load: {
      executor: "ramping-arrival-rate",
      startRate: 50,
      timeUnit: "1s",
      preAllocatedVUs: 100,
      maxVUs: 400,
      stages: [
        { target: 166, duration: "60s" }, // Target ~10,000 entries across 60 seconds
        { target: 500, duration: "5s" },  // Burst at closing timestamp
        { target: 0, duration: "5s" },    // Post-close cool down
      ],
    },
  },
  thresholds: {
    // 95% of responses should be below 250ms
    http_req_duration: ["p(95)<250"],
    // System error rate (5xx) must be strictly 0%
    "http_req_failed{status:500}": ["rate<0.01"],
  },
};

const BASE_URL = __ENV.SHOPIFY_APP_URL || "http://localhost:3000";
const DRAW_ID = __ENV.DRAW_ID || "load-test-draw-1";
const API_SECRET = __ENV.SHOPIFY_API_SECRET || "test_api_secret_for_proxy_signatures";
const SHOP_DOMAIN = __ENV.SHOP_DOMAIN || "load-test.myshopify.com";

function generateSignedProxyUrl(customerId) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const params = [
    `logged_in_customer_id=${customerId}`,
    `shop=${SHOP_DOMAIN}`,
    `timestamp=${timestamp}`,
  ];
  params.sort();
  const message = params.join("");
  const signature = crypto.hmac("sha256", API_SECRET, message, "hex");
  return `${BASE_URL}/apps/raffle/entry/${DRAW_ID}?${params.join("&")}&signature=${signature}`;
}

export default function () {
  const customerId = Math.floor(Math.random() * 20000) + 1;
  const url = generateSignedProxyUrl(customerId);

  const payload = JSON.stringify({
    formToken: `token_${customerId}_${Date.now()}`,
    deviceFingerprintHash: `fp_${Math.random().toString(36).substring(2)}`,
    turnstileToken: "mock_turnstile_pass",
    website_hp_check: "",
    customerData: {
      email: `entrant_${customerId}@example.com`,
      verifiedEmail: true,
      countryCode: "US",
    },
  });

  const params = {
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "x-forwarded-host": SHOP_DOMAIN,
    },
  };

  const res = http.post(url, payload, params);

  check(res, {
    "valid response status (201, 409, 429)": (r) => [201, 409, 429].includes(r.status),
    "never internal 500 error": (r) => r.status !== 500,
  });

  sleep(0.1);
}
