# Fairdrops - Multi-Tenant Shopify Raffle / Draw App

Fairdrops is a production-grade, multi-tenant Shopify application that enables merchants to conduct high-demand, bot-protected product drops and raffles at MSRP for randomly selected customers.

---

## 🏗️ Architecture & Security Principles

- **Framework**: Official Shopify App template using React Router v7 / Remix and TypeScript.
- **Database**: PostgreSQL hosted on Supabase, managed via Prisma. All application tables reside in a dedicated `raffle` PostgreSQL schema with Row Level Security (RLS) enabled, completely shielding them from Supabase's auto-generated PostgREST APIs.
- **Serverless Hosting**: Designed for Vercel Serverless Functions. Stateless endpoints with zero long-running node processes or in-memory timers.
- **Background Jobs & Sweepers**: Upstash QStash for delayed, idempotent execution (close entries, draw winners, expire claims) with a self-scheduling sweeper architecture tailored for Vercel Hobby/Pro tiers.
- **Hidden Inventory**: Raffle products are unpublished from all storefront sales channels; winning customers purchase exclusively via single-use, server-generated Shopify Draft Orders.
- **Fairness & Privacy**: Cryptographic Fisher-Yates draw shuffle (`crypto.randomInt`), SHA-256 commitment hashing, crypto-shredding on purge, and mandatory Shopify privacy webhooks.
- **Public Multi-Tenant Distribution**: Native multi-store OAuth, Prisma session storage in Postgres, automatic `Shop` record management on install, and full cross-tenant data isolation.

---

## 🚀 Local Development Setup

### 1. Prerequisites
- Node.js >= 22.12
- npm >= 10
- Shopify CLI >= 3.60 (`@shopify/cli`)
- A Shopify Partner account and Development Store

### 2. Environment Configuration
Copy the template configuration into a local, gitignored `.env` file:
```bash
cp .env.example .env
```

Open `.env` and fill in your Supabase database credentials:
- `DIRECT_URL`: Supabase direct connection string (port 5432) used for Prisma migrations.
- `DATABASE_URL`: Supabase pooled connection string (port 6543) with `?pgbouncer=true&connection_limit=1` used at runtime.
- `SHOPIFY_API_SECRET`: Your Shopify App Client Secret from the Partner Dashboard.

*(Note: Never commit `.env` or paste database passwords or client secrets into git or chat).*

### 3. Verify Database Connectivity
Run the sanitized connection test script to confirm PostgreSQL connectivity:
```bash
npm run test:db
```
This tests your connection to Supabase and verifies the database responds to queries without ever logging your credentials or connection string.

### 4. Run Tests & Validation
```bash
# Run unit test suite (Vitest)
npm test

# Run TypeScript typecheck
npm run typecheck

# Run ESLint
npm run lint
```

---

## 🔗 Connecting to Shopify Partners & Development Store

Follow these exact steps to connect Fairdrops to your Shopify Partner account and launch it on your dev store:

### Step 1: Log in to Shopify CLI
In your terminal, run:
```bash
npx shopify auth login
```
This will open your browser to authenticate your Shopify Partner account.

### Step 2: Link App Configuration
Our repository is configured with client ID `5659eb40af5e9670a92743f7c578e2fe`. Link your local workspace:
```bash
npx shopify app config link
```
Select your partner organization and the **Fairdrops** app when prompted.

### Step 3: Start Local Development Tunnel
Start the development server:
```bash
npm run dev
```
*(or `npx shopify app dev`)*

When prompted:
1. Select your target **development store**.
2. Shopify CLI will generate a secure Cloudflare/localtunnel URL and update your app's URLs and redirect endpoints automatically.
3. Follow the generated installation URL in the console to install the app on your dev store.

---

## 🔒 Access Scopes & Justification

The app declares the minimum necessary access scopes in `shopify.app.toml`:

| Scope | Justification |
|---|---|
| `read_products` | Queries raffle products and variants (titles, images, MSRP prices) to display in the merchant drop builder and storefront draw blocks. |
| `write_products` | Unpublishes raffle products from all storefront sales channels (Online Store, POS, Shop app) to ensure hidden inventory cannot be purchased directly. |
| `read_customers` | Validates entrant eligibility rules (account creation age, verified email status, default shipping address). |
| `write_draft_orders` | Generates private, MSRP-locked, single-use Draft Orders with `reserveInventoryUntil` for confirmed winners. |
| `read_orders` | Listens to `orders/create` and `orders/paid` webhooks to verify completed purchases and enforce region lock at checkout. |
| `read_locations` | Inspects merchant fulfillment locations to support segregated raffle inventory warehousing. |
| `read_inventory` | Verifies available inventory quantities for selected raffle variants before scheduling and executing draws. |

---

## 🏢 Multi-Tenant & App Store Architecture

Fairdrops is designed as a **public multi-merchant application** intended for distribution on the Shopify App Store:

1. **OAuth Flow**: Standard embedded OAuth starting immediately on install without pre-install forms or third-party login barriers.
2. **Session Storage**: Sessions are persisted in PostgreSQL via `@shopify/shopify-app-session-storage-prisma` in the isolated `raffle` database schema.
3. **Tenant Lifecycle**: The `afterAuth` hook in `app/shopify.server.ts` automatically provisions or updates a tenant `Shop` record upon installation and registers webhooks.
4. **App Bridge & Embedded UI**: The merchant administration interface uses Shopify App Bridge and Polaris with session token authentication (no deprecated cookie redirects).
5. **Storefront Integration**: Customer entry UI is provided strictly via a **Theme App Extension** (app block), leaving merchant theme liquid code untouched and guaranteeing zero storefront performance degradation.
6. **Mandatory Privacy Webhooks**: Webhook endpoints for `customers/data_request`, `customers/redact`, and `shop/redact` are pre-wired for GDPR/Shopify compliance.
7. **Cross-Tenant Isolation**: Every database table includes `shopId` foreign keys, and all data queries must be tenant-scoped.

---

## 🛡️ Product Visibility Protection & Storefront Blackout

Raffle drop products must **never be purchasable or discoverable** through standard storefront channels. Fairdrops deploys a multi-layered automated defense combined with operational safeguards:

### 1. Automated GraphQL Unpublishing & Snapshots
When a drop is created or updated, Fairdrops:
- Calls `resourcePublicationsV2` to inspect the product's sales channel status.
- Stores a `ProductVisibilitySnapshot` recording the product's pre-drop channel configuration in the database.
- Executes `publishableUnpublish` to remove the product from all channels (Online Store, POS, Shop App, Google & YouTube, etc.).

### 2. Three-Tier Visibility Guard
- **Reactive Layer (Webhooks)**: Subscribes to `products/update`. If a merchant or automated catalog sync re-publishes a raffle product while a drop is `SCHEDULED`, `OPEN`, or `FULFILLING`, Fairdrops immediately auto-unpublishes it, records a `PRODUCT_VISIBILITY_BREACH_DETECTED` audit log, and raises a visible **Visibility Alert** warning flag in the admin UI.
- **Active Layer (QStash Self-Scheduling Sweeper)**: Self-schedules every 20 minutes (within 15–30m requirement) via Upstash QStash only while drops are active, scanning active products across all channels and standing down when drops conclude.
- **Backstop Layer (Vercel Cron)**: Configured via `vercel.json` to execute `/api/cron/guard` daily at 02:00 UTC, authenticated via `Bearer ${CRON_SECRET}`.

### 3. Merchant Setup Checklist & Dedicated Inventory Location
While Fairdrops handles channel unpublishing automatically, merchants must follow two operational setup steps:
1. **Manual Channel Confirmation**: Check *Shopify Admin > Products > [Product] > Publishing* and confirm 0 channels are selected.
2. **Dedicated Fulfillment Location (Recommended)**:
   - Create a dedicated location in *Settings > Locations* (e.g., "Raffle Vault") and assign raffle inventory there.
   - Uncheck *"Fulfill online orders from this location"*. This physically prevents the storefront checkout engine from drawing from this stock pool even if direct cart links are constructed.
   - **⚠️ CRITICAL: Dev Store Testing Required**: Shopify location routing rules vary depending on multi-location shipping profiles. **You MUST test draft order creation and checkout allocation from this location on your development store** to ensure winners can complete their purchase before running a live drop.

### 4. Dev Store Storefront Blackout Test Plan
Before launching a live drop, verify complete product invisibility on your development store:

1. **Direct Handle URL**:
   Navigate to `https://[your-store].myshopify.com/products/[product-handle]`.
   - **Expected Result**: HTTP 404 Page Not Found.

2. **Public Catalog JSON**:
   Navigate to `https://[your-store].myshopify.com/products.json`.
   - Search the JSON document for the product handle or title.
   - **Expected Result**: Product is omitted from the JSON catalog.

3. **Storefront Search**:
   Use your storefront search bar and search for the exact product title.
   - **Expected Result**: 0 results returned.

4. **Storefront GraphQL API**:
   Query your storefront endpoint with:
   ```graphql
   query {
     products(first: 10, query: "title:[Product Title]") {
       edges {
         node {
           id
           title
         }
       }
     }
   }
   ```
   - **Expected Result**: Empty `edges` array (`[]`).


---

## 🤖 Anti-Bot & Fraud Controls (Phase 7)

Fairdrops implements a multi-layered defense to prevent bot syndicates, scripted entries, and mass form submission from monopolizing raffle drops:

### 1. Security Architecture
- **Cloudflare Turnstile**: Embedded widget in the storefront theme block. Server-side token verification against `challenges.cloudflare.com` on every submission. Fails closed if verification fails or the service is unreachable.
- **Signed Short-Lived Form Tokens**: HMAC-SHA256 signed session tokens bound to `drawId`, `customerId`, and `issuedAt`. Rejects expired tokens (> 30 minutes), replayed tokens (single-use nonce cache), and submissions faster than a minimum human fill time (default: 3 seconds).
- **Honeypot Trap**: Invisible field positioned off-screen. Automated form fillers populating this field trigger an immediate silent rejection with audit logging (`HONEYPOT_BLOCKED`).
- **Sliding-Window Rate Limiting**: Managed Redis (Upstash) with in-memory fallback. Limits requests per IP (10/min), per customer (5/min), and per draw (60/min), returning HTTP 429 when exceeded.
- **Device & Browser Fingerprinting**: Lightweight client signal (hash of user agent, screen geometry, timezone offset, hardware concurrency) stored as a SHA-256 hash. Counts duplicate entries per fingerprint and per IP hash per draw.
- **Dynamic Risk Scoring (`riskScore.ts`)**: Combines 8 fraud signals (fingerprint reuse, IP reuse, datacenter/VPN ASN, disposable email, new accounts, fast submission, geo mismatch, shared address hash) into a normalized 0–100 score.
  - Score >= `rejectScore` (default 80): Hard rejection.
  - `flagScore` <= Score < `rejectScore` (default 40–79): Accepted but marked `FLAGGED`. Flagged entries are automatically excluded from the draw unless reviewed and approved by the merchant.
  - Score < `flagScore`: Marked `VALID` and eligible for draw selection.
  - **No Hard-Block on IP Alone**: Households, universities, and mobile carriers legitimately share IP addresses. IP reuse adds weighted risk score rather than an immediate gate.
- **Merchant Review UI**: Dedicated "Flagged entries" table on the Draw details page showing risk scores and reason codes without exposing raw PII, with one-click Approve and Reject actions logged to the `AuditLog`.
- **Configurable Per-Draw Thresholds**: Merchants can adjust `flagScore`, `rejectScore`, `maxEntriesPerIp`, `maxEntriesPerFingerprint`, and `minSubmitSeconds` in the draw rules.

### 2. Known Limitations & Honest Threat Model
> [!IMPORTANT]
> **No entry-stage security system can stop a determined person with multiple real identities.**
> If an attacker uses multiple distinct devices, real family/friend identities, separate authentic payment methods, and distinct residential IP connections, their submissions appear indistinguishable from legitimate human customers at entry time.
>
> Fairdrops therefore enforces its second line of defense at the **claim and order stage**:
> 1. **Address Normalization & Multi-Unit Restrictions**: Detects duplicate street addresses across winners and blocks multiple units from being shipped to the same physical location (configurable by merchant).
> 2. **Shopify Native Order Risk**: Evaluates checkout risk via Shopify's machine-learning fraud analysis on the resulting draft order checkout.
> 3. **Post-Checkout Order Cancellation & Waitlist Reallocation**: Merchants can cancel and refund suspicious or reseller orders with a single click, which automatically invalidates the allocation and releases the unit to the next eligible entrant on the waitlist.

---

## 🎲 Cryptographic Random Draw Engine (Phase 8)

Fairdrops guarantees verifiable mathematical fairness and transparency through an audited, serverless-optimized draw execution engine:

### 1. Cryptographic Shuffle & Non-Manipulability
- **CSPRNG Fisher-Yates**: Shuffling executes exactly once using Node's cryptographically secure pseudo-random number generator (`crypto.randomInt`), strictly avoiding predictable pseudo-random algorithms like `Math.random()`.
- **Pre-Draw Commitment Hash**: Before the shuffle begins, a deterministic SHA-256 hash is computed over the lexicographically sorted list of eligible entry IDs (`computeCommitmentHash`). This commitment is stored in the database and logged to the immutable `AuditLog`, providing cryptographic proof that the entrant pool was fixed prior to winner selection. Merchants can optionally publish this hash before the draw.
- **Rank Order Secrecy**: Entrant rank ordering is strictly confidential to prevent extortion or gaming. It is stored exclusively within the secure database and is never exposed in API responses or plain text logs to storefront customers.

### 2. Idempotency & High-Volume Batch Architecture
- **Row-Locked Transaction**: The draw runs inside a single database transaction with a PostgreSQL row lock (`SELECT ... FOR UPDATE`), preventing race conditions, concurrent webhook invocations, or double-draws.
- **Strict Idempotency**: If the draw status is already `DRAWN`, `FULFILLING`, or later, the engine immediately aborts and returns the existing state without re-shuffling or modifying assigned ranks.
- **Chunked Bulk Persistence**: Ranks are written using parameterized PostgreSQL bulk `VALUES` update joins in batches (default: 2,000 entries per batch), allowing 100k+ entrants to be ranked in seconds well within serverless function execution limits.
- **Automated QStash Scheduling**: When a draw is scheduled, a delayed message is published to Upstash QStash set for `drawAt`. The incoming request to `/api/qstash/draw-lifecycle` is cryptographically signature-verified via QStash keys before execution.

### 3. Edge Case Handling
- **Fewer Entries Than Units**: When eligible entrants are fewer than the available units, every entrant is assigned a winning rank (1..N). Leftover units are recorded as unsold in an audit event (`DRAW_UNSOLD_UNITS_FLAGGED`), alerting the merchant to unallocated stock.
- **Zero Entries**: If no eligible entries exist when the draw executes, the drop transitions directly to `COMPLETED` and records `DRAW_COMPLETED_ZERO_ENTRIES`, triggering the data purge schedule without failing.
- **Eligibility Filtering**: Only entries with status `VALID` (or `FLAGGED` with merchant approval) are included in the draw pool. Flagged or disqualified entries are completely excluded.

---

## 🎟️ Winner Allocation, Secure Claim Links & Draft Orders (Phase 9)

Fairdrops manages high-security, one-time checkout allocations for winners without exposing bearer links or allowing unauthorized access:

### 1. Draft Order Creation & Stock Reservation
- For each selected winner, Fairdrops generates a private Shopify Draft Order via Admin GraphQL (`draftOrderCreate`).
- **Configuration**:
  - Quantity: 1
  - Price: MSRP (strictly zero discounts applied)
  - Customer Binding: Winner's `customerId` and verified email
  - Tags & Notes: Tagged with `raffle:<drawId>` and `entry:<entryId>` for webhook identification
  - **Inventory Reservation**: The `reserveInventoryUntil` timestamp is set to `deadlineAt`, automatically reserving the variant stock in Shopify and releasing it if the deadline lapses.

### 2. Claim Token Security & Bearer Link Protection
- **No Invoice URLs in Email**: The Draft Order's `invoiceUrl` is a sensitive bearer link that directly bypasses authentication. It is never included in emails or exposed to third parties.
- **High-Entropy Claim Tokens**: A 32-byte cryptographic random token (`crypto.randomBytes(32).toString("base64url")`) is generated. Only its deterministic SHA-256 hash is saved in `Allocation.claimTokenHash`.
- **Claim Link Routing**: Winners receive a personalized link to `https://<shop-domain>/apps/raffle/claim/<token>`.

### 3. Claim Endpoint Gating & Verification
- Hosted via Shopify App Proxy with signature verification (`verifyAppProxyRequest`).
- **Customer Identity Verification**: Requires `logged_in_customer_id` matching the allocation's `customerGid`. If logged out, redirects to the store's login page with a return URL. If logged in as an account other than the winner, rejects the request.
- **State & Timing Guards**: Requires allocation status `ISSUED` or `OPENED`, `now < deadlineAt`, and draw status not `CANCELLED`.
- **Single-Use Transition & Redirection**: Transitions status to `OPENED`, records `openedAt`, and returns a `302` redirect to the draft order `invoiceUrl` with strict privacy headers:
  - `Cache-Control: no-store`
  - `Referrer-Policy: no-referrer`
- **Zero Information Leakage**: Any failure (unknown token, expired link, mismatched customer, cancelled drop) returns a uniform generic response: `Link is invalid or has expired.` with HTTP 404.

### 4. Post-Checkout Region Check & Anti-Circumvention
- Storefront checkouts cannot reliably block shipping country spoofing when customer accounts have international addresses.
- **Server-Side Backstop**: When the `orders/create` webhook fires for a raffle draft order, Fairdrops verifies the shipping address country against the draw's `allowedCountries`.
- If a region violation is detected, Fairdrops immediately calls Admin GraphQL `orderCancel` with `refund: true`, marks the allocation `CANCELLED`, and logs `ALLOCATION_REGION_VIOLATION_CANCELLED` to the `AuditLog`.

### 5. Multi-Unit & Household Prevention
- Enforces strict one-unit-per-winner limits.
- When `allowMultipleUnitsPerAddress` is disabled (default), duplicate address hashes across entrants are automatically bypassed during allocation issuance, preventing household hoarding.

### 6. Multi-Merchant Email Architecture & Sender Domains
Winner notifications are dispatched via a transactional provider (`EmailProvider` interface supporting Resend, Postmark, and local test mocks).

#### Multi-Merchant Sender Domain Configuration Options:
1. **Shared App Subdomain (Zero-Config, Recommended for Small Merchants)**:
   - Emails sent from `Fairdrops <drops@mail.fairdrops.app>`.
   - The merchant's customer support email (e.g. `support@merchantstore.com`) is injected into the `Reply-To` header.
   - Requires zero DNS setup by the merchant; SPF, DKIM, and DMARC are fully maintained by the Fairdrops platform domain.
2. **Dedicated Merchant Custom Domain (Enterprise / White-Label)**:
   - Emails sent from `drops@merchantstore.com`.
   - The merchant adds three DNS records (supplied in app settings) to their domain registrar:
     - **SPF**: `v=spf1 include:send.fairdrops.app ~all`
     - **DKIM**: CNAME record pointing to Fairdrops' Postmark/Resend public key
     - **DMARC**: `v=DMARC1; p=none; rua=mailto:dmarc-reports@merchantstore.com`
3. **Bring-Your-Own (BYO) Provider**:
   - Merchants can configure their own Resend or Postmark API key directly in Fairdrops Settings, routing notifications through their existing corporate email infrastructure.

---

## ⏳ Automatic Expiry & Waitlist Promotion (Phase 10)

Fairdrops manages the automated lifecycle of claim windows, handling expired allocations, next-winner waitlist promotions, payment-at-deadline races, and draw completion:

### 1. Dual-Tier Scheduling Architecture: QStash Delayed Messages + Sweeper Safety Net
- **Direct Delayed Message**: When an allocation is issued, a delayed message is dispatched to Upstash QStash set for its exact `deadlineAt` timestamp, targeting the signature-verified `/api/qstash/allocation-expiry` endpoint.
- **Self-Scheduling Sweeper Safety Net**: To protect against any lost network messages without exceeding Vercel Hobby-tier cron limits (which are limited to once per day), Fairdrops employs a self-scheduling sweeper pattern (`runClaimExpirySweeper`). When active allocations exist, the sweeper evaluates overdue allocations and self-schedules its next check 5 minutes later via QStash. Once all allocations are settled, the sweeper gracefully goes idle.

### 2. Idempotent Expiry & Atomic Promotion Engine
- **PostgreSQL Row Locks**: Expiry evaluations run inside a database transaction with a row lock (`SELECT ... FOR UPDATE` on `Allocation`), guaranteeing that concurrent invocations or webhook arrivals do not cause double promotions.
- **Shopify Draft Order Cleanup**: If unpaid at the deadline, Fairdrops calls Admin GraphQL `draftOrderDelete`, releasing the variant's reserved inventory back to the merchant's store.
- **Atomic Waitlist Promotion**: Fairdrops selects the next eligible entrant (lowest rank value where `status = VALID` or merchant-approved `FLAGGED`) using `SELECT ... FOR UPDATE SKIP LOCKED` on `Entry`. Entrants who have previously received an allocation in this draw are strictly excluded (`NOT EXISTS` check), ensuring no one is promoted twice.
- **Instant Allocation & Dispatch**: The promoted entrant is immediately issued a new Draft Order with `reserveInventoryUntil`, an unguessable claim token is hashed and stored, their winner email is dispatched, and a new QStash delayed message is scheduled for their claim window.

### 3. Edge Case Handling: Payment-at-Deadline Race Condition
- If a customer completes their checkout right as their claim deadline arrives, an automated draft order deletion could orphan an authorized order.
- Before deleting any draft order or marking an allocation expired, Fairdrops queries Shopify Admin GraphQL (`getDraftOrder`).
- If Shopify reports the draft order `COMPLETED` or `displayFinancialStatus === "PAID"`, the **payment wins the race**: the draft order is preserved, the allocation transitions to `PURCHASED`, and an audit event (`ALLOCATION_PURCHASED_AT_DEADLINE_RACE`) is logged.

### 4. Waitlist Exhaustion & Draw Completion
- **Waitlist Exhaustion**: When an allocation expires and no eligible entries remain on the waitlist, remaining units are recorded as unsold in the `AuditLog` (`DRAW_WAITLIST_EXHAUSTED`), and the merchant is alerted.
- **Draw Completion**: When all units have been claimed and paid, or all active allocations have concluded with an exhausted waitlist, the drop automatically transitions to `COMPLETED` and logs `DRAW_COMPLETED`.

### 5. Webhook Idempotency & Order Reconciliation
- **Webhook Handlers**: Fairdrops listens to `orders/paid` and `orders/create` to reconcile purchases.
- **Idempotency Storage**: Every processed Shopify webhook ID (`X-Shopify-Webhook-Id`) is persisted in the `WebhookEvent` table with a unique constraint. Duplicate webhook retries from Shopify are acknowledged with HTTP 200 without re-processing state or creating duplicate audit logs.

