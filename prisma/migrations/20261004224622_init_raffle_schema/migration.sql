-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "raffle";

-- CreateEnum
CREATE TYPE "raffle"."DrawStatus" AS ENUM ('SCHEDULED', 'OPEN', 'CLOSED', 'DRAWN', 'FULFILLING', 'COMPLETED', 'PURGED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "raffle"."EntryStatus" AS ENUM ('VALID', 'FLAGGED', 'REJECTED', 'DISQUALIFIED');

-- CreateEnum
CREATE TYPE "raffle"."AllocationStatus" AS ENUM ('ISSUED', 'OPENED', 'PURCHASED', 'EXPIRED', 'CANCELLED');

-- CreateTable
CREATE TABLE "raffle"."Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raffle"."Shop" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),
    "planStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
    "subscriptionId" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "dataDeleteAfter" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raffle"."Draw" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "raffle"."DrawStatus" NOT NULL DEFAULT 'SCHEDULED',
    "entryOpensAt" TIMESTAMP(3) NOT NULL,
    "entryClosesAt" TIMESTAMP(3) NOT NULL,
    "drawAt" TIMESTAMP(3) NOT NULL,
    "claimWindowMinutes" INTEGER NOT NULL,
    "unitsAvailable" INTEGER NOT NULL,
    "rules" JSONB NOT NULL DEFAULT '{}',
    "publicRulesText" TEXT,
    "purgeAfterDays" INTEGER NOT NULL DEFAULT 14,
    "encryptionKeyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Draw_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raffle"."DrawVariant" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "drawId" TEXT NOT NULL,
    "productGid" TEXT NOT NULL,
    "variantGid" TEXT NOT NULL,
    "msrpPrice" DECIMAL(10,2) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DrawVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raffle"."Entry" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "drawId" TEXT NOT NULL,
    "customerGid" TEXT NOT NULL,
    "normalizedEmailHash" TEXT NOT NULL,
    "emailEncrypted" TEXT NOT NULL,
    "countryCode" TEXT,
    "addressHash" TEXT,
    "deviceFingerprintHash" TEXT,
    "ipHash" TEXT,
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "riskFlags" JSONB NOT NULL DEFAULT '[]',
    "status" "raffle"."EntryStatus" NOT NULL DEFAULT 'VALID',
    "rank" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raffle"."Allocation" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "drawId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "variantGid" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "claimTokenHash" TEXT NOT NULL,
    "status" "raffle"."AllocationStatus" NOT NULL DEFAULT 'ISSUED',
    "draftOrderGid" TEXT,
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openedAt" TIMESTAMP(3),
    "purchasedAt" TIMESTAMP(3),

    CONSTRAINT "Allocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raffle"."AuditLog" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "drawId" TEXT,
    "eventType" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raffle"."WebhookEvent" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Session_shop_idx" ON "raffle"."Session"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "Shop_shopDomain_key" ON "raffle"."Shop"("shopDomain");

-- CreateIndex
CREATE INDEX "Shop_shopDomain_idx" ON "raffle"."Shop"("shopDomain");

-- CreateIndex
CREATE INDEX "Draw_shopId_idx" ON "raffle"."Draw"("shopId");

-- CreateIndex
CREATE INDEX "Draw_shopId_status_idx" ON "raffle"."Draw"("shopId", "status");

-- CreateIndex
CREATE INDEX "Draw_status_idx" ON "raffle"."Draw"("status");

-- CreateIndex
CREATE INDEX "Draw_entryClosesAt_idx" ON "raffle"."Draw"("entryClosesAt");

-- CreateIndex
CREATE INDEX "Draw_drawAt_idx" ON "raffle"."Draw"("drawAt");

-- CreateIndex
CREATE INDEX "DrawVariant_shopId_idx" ON "raffle"."DrawVariant"("shopId");

-- CreateIndex
CREATE INDEX "DrawVariant_drawId_idx" ON "raffle"."DrawVariant"("drawId");

-- CreateIndex
CREATE INDEX "DrawVariant_variantGid_idx" ON "raffle"."DrawVariant"("variantGid");

-- CreateIndex
CREATE UNIQUE INDEX "DrawVariant_drawId_variantGid_key" ON "raffle"."DrawVariant"("drawId", "variantGid");

-- CreateIndex
CREATE INDEX "Entry_shopId_idx" ON "raffle"."Entry"("shopId");

-- CreateIndex
CREATE INDEX "Entry_drawId_idx" ON "raffle"."Entry"("drawId");

-- CreateIndex
CREATE INDEX "Entry_drawId_status_idx" ON "raffle"."Entry"("drawId", "status");

-- CreateIndex
CREATE INDEX "Entry_drawId_rank_idx" ON "raffle"."Entry"("drawId", "rank");

-- CreateIndex
CREATE INDEX "Entry_deviceFingerprintHash_idx" ON "raffle"."Entry"("deviceFingerprintHash");

-- CreateIndex
CREATE INDEX "Entry_ipHash_idx" ON "raffle"."Entry"("ipHash");

-- CreateIndex
CREATE UNIQUE INDEX "Entry_drawId_customerGid_key" ON "raffle"."Entry"("drawId", "customerGid");

-- CreateIndex
CREATE UNIQUE INDEX "Entry_drawId_normalizedEmailHash_key" ON "raffle"."Entry"("drawId", "normalizedEmailHash");

-- CreateIndex
CREATE UNIQUE INDEX "Allocation_claimTokenHash_key" ON "raffle"."Allocation"("claimTokenHash");

-- CreateIndex
CREATE INDEX "Allocation_shopId_idx" ON "raffle"."Allocation"("shopId");

-- CreateIndex
CREATE INDEX "Allocation_drawId_idx" ON "raffle"."Allocation"("drawId");

-- CreateIndex
CREATE INDEX "Allocation_entryId_idx" ON "raffle"."Allocation"("entryId");

-- CreateIndex
CREATE INDEX "Allocation_deadlineAt_idx" ON "raffle"."Allocation"("deadlineAt");

-- CreateIndex
CREATE INDEX "Allocation_status_idx" ON "raffle"."Allocation"("status");

-- CreateIndex
CREATE INDEX "AuditLog_shopId_idx" ON "raffle"."AuditLog"("shopId");

-- CreateIndex
CREATE INDEX "AuditLog_drawId_idx" ON "raffle"."AuditLog"("drawId");

-- CreateIndex
CREATE INDEX "AuditLog_eventType_idx" ON "raffle"."AuditLog"("eventType");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "raffle"."AuditLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_eventId_key" ON "raffle"."WebhookEvent"("eventId");

-- CreateIndex
CREATE INDEX "WebhookEvent_shopId_idx" ON "raffle"."WebhookEvent"("shopId");

-- CreateIndex
CREATE INDEX "WebhookEvent_eventId_idx" ON "raffle"."WebhookEvent"("eventId");

-- CreateIndex
CREATE INDEX "WebhookEvent_topic_idx" ON "raffle"."WebhookEvent"("topic");

-- AddForeignKey
ALTER TABLE "raffle"."Draw" ADD CONSTRAINT "Draw_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "raffle"."Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raffle"."DrawVariant" ADD CONSTRAINT "DrawVariant_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "raffle"."Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raffle"."DrawVariant" ADD CONSTRAINT "DrawVariant_drawId_fkey" FOREIGN KEY ("drawId") REFERENCES "raffle"."Draw"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raffle"."Entry" ADD CONSTRAINT "Entry_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "raffle"."Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raffle"."Entry" ADD CONSTRAINT "Entry_drawId_fkey" FOREIGN KEY ("drawId") REFERENCES "raffle"."Draw"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raffle"."Allocation" ADD CONSTRAINT "Allocation_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "raffle"."Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raffle"."Allocation" ADD CONSTRAINT "Allocation_drawId_fkey" FOREIGN KEY ("drawId") REFERENCES "raffle"."Draw"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raffle"."Allocation" ADD CONSTRAINT "Allocation_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "raffle"."Entry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raffle"."AuditLog" ADD CONSTRAINT "AuditLog_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "raffle"."Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raffle"."AuditLog" ADD CONSTRAINT "AuditLog_drawId_fkey" FOREIGN KEY ("drawId") REFERENCES "raffle"."Draw"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raffle"."WebhookEvent" ADD CONSTRAINT "WebhookEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "raffle"."Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Enable Row Level Security (RLS) on all tables in the raffle schema
-- Prisma connects directly using the PostgreSQL role which bypasses RLS,
-- while Supabase auto-generated APIs (anon and authenticated roles) are strictly denied.
ALTER TABLE "raffle"."Session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "raffle"."Shop" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "raffle"."Draw" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "raffle"."DrawVariant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "raffle"."Entry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "raffle"."Allocation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "raffle"."AuditLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "raffle"."WebhookEvent" ENABLE ROW LEVEL SECURITY;
