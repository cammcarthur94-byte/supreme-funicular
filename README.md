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
