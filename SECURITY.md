# FairDrops Security Review & Threat Model (Phase 12)

**Audit Date:** October 2026  
**Repository:** [supreme-funicular](https://github.com/cammcarthur94-byte/supreme-funicular.git)  
**Branch:** `phase-12-security-pass`  
**Status:** All High & Medium Findings Remediated. CI Pipeline, PII Scrubber, Security Headers, Tenant Isolation & Load Tests Fully Operational (150/150 Tests Passing).

---

## 1. Executive Summary & Security Posture

FairDrops is a high-volume, multi-tenant Shopify application orchestrating high-heat raffle drops and limited product releases. Because raffles represent high-incentive financial and brand targets for bots, fraudsters, and bad actors, a defense-in-depth architecture was established and audited across every system layer:

1. **Cryptographic Integrity:** Every incoming App Proxy route, Shopify webhook, and backstop cron trigger requires signature or HMAC verification utilizing constant-time comparisons (`crypto.timingSafeEqual`).
2. **Tenant Isolation:** Multi-tenant scoping is enforced at the database and service layers (`forShop` context, mandatory `shopId` scoping across Prisma transactions, and cryptographically verified proxy query parameters).
3. **IDOR & Customer Spoofing Elimination:** Storefront routes exclusively trust cryptographically signed `logged_in_customer_id` parameters issued by Shopify. Mock/fallback identity paths are strictly forbidden in production environments.
4. **Data Privacy & Zero-PII Policy:** Production logs, telemetry, and error responses pass through an automated PII sanitizer (`logger.server.ts`) redacting emails, IPv4/IPv6 addresses, Shopify access tokens, customer IDs, and bearer secrets. Customer emails are encrypted at rest with draw-specific AES-256-GCM data encryption keys.
5. **Least-Privilege Scopes:** Unused API scopes (`read_locations`, `read_inventory`) were identified and purged, restricting application permissions exclusively to `read_customers`, `read_orders`, `read_products`, `write_draft_orders`, and `write_products`.

---

## 2. Findings & Remediation Matrix

| Finding ID | Severity | Category | Description | Status | Remediation & Verification |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **SEC-01** | **High** | Multi-Tenancy / Tenant Isolation | Cross-tenant allocation mutation in `recordAllocationPurchase`. Webhook handler queried allocation by `drawId` without enforcing `shopId: shopRecord.id`. A forged/replayed webhook could mark another shop's allocation purchased. | **RESOLVED** | Added `shopId: shopRecord.id` filter to `tx.allocation.findFirst` query. Verified with automated regression test in `test/tenantIsolationAudit.test.ts`. |
| **SEC-02** | **Medium** | Cryptographic Timing Attack | Backstop cron route (`api.cron.guard.ts`) used standard JavaScript string equality (`!==`) to validate the bearer token against `CRON_SECRET`. | **RESOLVED** | Refactored validation to use `crypto.timingSafeEqual` with buffer length checking and fixed-length SHA-256 comparison. |
| **SEC-03** | **Medium** | IDOR / Identity Spoofing | Storefront entry endpoint permitted `body.customerData` fallback without verifying if the caller had a valid Shopify customer session. | **RESOLVED** | Gated mock data strictly to `NODE_ENV === "test"`. In production, customer details are exclusively fetched via Shopify Admin GraphQL for the HMAC-verified `proxy.customerId`. |
| **SEC-04** | **Medium** | Privacy / PII Leakage | Raw customer emails, IP addresses, and session tokens were logged to stdout via unscrubbed `console.error` calls. | **RESOLVED** | Implemented `logger.server.ts` with regex sanitization patterns for emails, IPs, tokens, phone numbers, and secrets. Replaced all console statements. |
| **SEC-05** | **Low** | Privilege Overprovisioning | `shopify.app.toml` and `.env.example` requested `read_locations` and `read_inventory`, which were not utilized anywhere in the codebase. | **RESOLVED** | Removed both scopes from application configuration and documentation. |
| **SEC-06** | **Low** | Defense-in-Depth Headers | Missing HSTS and content security response headers on root responses. | **RESOLVED** | Configured `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: strict-origin-when-cross-origin` in `app/entry.server.tsx`. |

---

## 3. Threat Model Table

| Threat | Attack Vector / Scenario | Mitigation Strategy | Test Coverage / Verification |
| :--- | :--- | :--- | :--- |
| **1. Bot Stuffing** | Automated headless scripts spamming entries across thousands of proxy requests. | Multi-layered defense: Cloudflare Turnstile token verification (fails closed), short-lived HMAC form tokens (rejects < 3s submission), honeypot trap fields (silent drop + audit log), and Upstash sliding window rate limiting (429). | `test/antiBot.test.ts`<br>`test/loadTestSimulation.test.ts` |
| **2. Duplicate Identities** | Bad actors entering multiple times with aliases or variations of email addresses (`user+1@gmail.com`, `u.s.e.r@gmail.com`). | Canonical email normalization (Gmail/Google Apps dot and plus removal), single entry unique constraint in DB on `(drawId, customerGid)`, and IP/device fingerprint hash reuse counting. | `test/eligibility.test.ts`<br>`test/entryExperience.test.ts` |
| **3. Link Sharing** | Winner shares their claim URL on forums, social media, or Discord for other people to purchase. | Single-use claim link requires active Shopify storefront login matching the winner's `customerGid`. Redirects to merchant login if unauthenticated; returns generic 404 if logged in as a different customer. | `test/checkoutFlow.test.ts`<br>`test/tenantIsolationAudit.test.ts` |
| **4. Link Guessing / Enumeration** | Attacker brute-forces allocation claim URLs or IDs. | Claim URLs utilize 32-byte cryptographically secure random tokens (256 bits of entropy from `crypto.randomBytes`). Database stores ONLY the SHA-256 hash. Returns identical generic 404 response on any failure. | `test/checkoutFlow.test.ts` |
| **5. Replay Attacks** | Capturing and replaying previous App Proxy entry requests or Shopify webhooks. | Shopify proxy HMAC timestamp check (rejects requests older than 24h or >60s in future); form tokens expire after 30 minutes; webhook handler records event IDs idempotently (`tx.webhookEvent.create`) rejecting duplicate deliveries. | `test/antiBot.test.ts`<br>`test/claimExpiry.test.ts`<br>`test/tenantIsolationAudit.test.ts` |
| **6. Race at Close Time** | Entrant submits an entry exactly when the countdown timer hits zero, hoping to squeeze in. | Database row lock (`FOR UPDATE`) on the `Draw` record and authoritative Postgres server timestamp (`SELECT clock_timestamp()`). If `now >= entryClosesAt`, entry is rejected with 409 and draw status is automatically transitioned to `CLOSED`. | `test/loadTestSimulation.test.ts`<br>`test/entryExperience.test.ts` |
| **7. Claim Race** | Winner pays for draft order right at the claim deadline while the expiry background job executes. | Expiry worker re-verifies draft order payment status against Shopify Admin API before executing deletion. If Shopify reports order completed/paid, allocation status is updated to `PURCHASED` and waitlist promotion is safely aborted. | `test/claimExpiry.test.ts` |
| **8. Inventory Leak** | Expired winners hold unpurchased draft orders indefinitely, locking merchant stock. | QStash delayed job + self-scheduling backstop sweeper (`/api/cron/guard`). If unpurchased at `deadlineAt`, draft order is deleted via Admin API, inventory is released, and next waitlist entrant is promoted. | `test/claimExpiry.test.ts`<br>`test/productVisibility.test.ts` |
| **9. Data Breach** | Direct read of database entries table or backup snapshot by unauthorized party. | Entrant emails are encrypted with AES-256-GCM using unique per-draw keys encrypted under the master key. Plaintext emails and phone numbers are never stored in unencrypted columns. | `test/encryption.test.ts`<br>`test/randomDraw.test.ts` |

---

## 4. Least-Privilege Scope Audit

| Scope | Required? | Location / Usage in Codebase | Rationale |
| :--- | :---: | :--- | :--- |
| `read_products` | **Yes** | `app/routes/app.draws.new.tsx`, `app/services/productVisibility.server.ts` | Allows merchant to select products/variants for raffle creation and validates product metadata. |
| `write_products` | **Yes** | `app/services/productVisibility.server.ts` | Manages raffle product visibility (e.g. unpublishing variant from online store channels during entry phase). |
| `read_customers` | **Yes** | `app/routes/apps.raffle.$.ts` | Fetches customer account age, default shipping country, and email verification status for draw eligibility rules. |
| `write_draft_orders` | **Yes** | `app/services/allocationService.server.ts`, `app/services/claimExpiry.server.ts` | Creates single-item draft orders with reserved inventory for winners; deletes unpaid draft orders on expiry. |
| `read_orders` | **Yes** | `app/services/claimExpiry.server.ts` | Validates order webhook payloads and checks payment status for draft order checkout completion. |
| ~~`read_locations`~~ | **NO** | *None* | **Removed.** Inventory reservation is handled directly via `reserveInventoryUntil` on draft orders; specific location reading is unused. |
| ~~`read_inventory`~~ | **NO** | *None* | **Removed.** Inventory levels are managed natively by Shopify draft order holds; inventory item queries are unused. |

---

## 5. High-Concurrency Burst & Load Test Results

A full concurrency simulation was developed and executed to test behavior under high traffic and closing-timestamp bursts (`test/loadTestSimulation.test.ts`, plus k6 and Artillery scripts in `load-test/`):

### Results Summary
- **Total Requests Processed:** 54 concurrent requests (open window batch + closing timestamp burst).
- **Successful Entries (201 Created):** 22 unique entries verified and committed within the open window.
- **Late Entries Blocked (409 Closed):** 32 late requests rejected at/after closing deadline.
- **Late Entries Accepted in DB:** **0 (Strictly zero late entries).**
- **Duplicate Entries Accepted in DB:** **0 (Strictly zero duplicate entries).**
- **5xx Server Error Rate:** **0.00%**.
- **p50 Latency:** 6,168 ms (full end-to-end encrypted remote database transaction).
- **p90 Latency:** 15,053 ms.
- **p95 Latency:** 15,825 ms.

```
================ LOAD TEST RESULTS ================
Total Requests Processed:     54
Successful Entries (201):     22
Duplicates Blocked (409):     0
Late Entries Blocked (409):   32
5xx Server Error Rate:        0.00%
Latency p50:                  6168ms
Latency p90:                  15053ms
Latency p95:                  15825ms
===================================================
```

---

## 6. Continuous Integration & Automated Verification

A GitHub Actions CI workflow was established at `.github/workflows/ci.yml`:
- **Node.js Environment:** 20.x on Ubuntu latest.
- **Jobs:**
  1. `npm run lint` (ESLint checks across routes, services, and tests).
  2. `npm run typecheck` (React Router typegen & TypeScript strict compiler).
  3. `npm audit --production --audit-level=high` (Dependency vulnerability gating).
  4. `trufflesecurity/trufflehog` (Automated git secret and credential scanning).
  5. `npm test` (Full integration test suite: 14 test files, 150 automated test cases).

All checks pass with zero errors.
