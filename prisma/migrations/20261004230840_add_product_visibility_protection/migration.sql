-- AlterTable
ALTER TABLE "raffle"."Draw" ADD COLUMN     "hasVisibilityWarning" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "visibilityWarning" TEXT;

-- CreateTable
CREATE TABLE "raffle"."ProductVisibilitySnapshot" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "drawId" TEXT NOT NULL,
    "productGid" TEXT NOT NULL,
    "snapshotData" JSONB NOT NULL,
    "unpublishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVisibilitySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductVisibilitySnapshot_shopId_idx" ON "raffle"."ProductVisibilitySnapshot"("shopId");

-- CreateIndex
CREATE INDEX "ProductVisibilitySnapshot_drawId_idx" ON "raffle"."ProductVisibilitySnapshot"("drawId");

-- CreateIndex
CREATE INDEX "ProductVisibilitySnapshot_productGid_idx" ON "raffle"."ProductVisibilitySnapshot"("productGid");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVisibilitySnapshot_drawId_productGid_key" ON "raffle"."ProductVisibilitySnapshot"("drawId", "productGid");

-- AddForeignKey
ALTER TABLE "raffle"."ProductVisibilitySnapshot" ADD CONSTRAINT "ProductVisibilitySnapshot_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "raffle"."Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raffle"."ProductVisibilitySnapshot" ADD CONSTRAINT "ProductVisibilitySnapshot_drawId_fkey" FOREIGN KEY ("drawId") REFERENCES "raffle"."Draw"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Enable Row Level Security (RLS) with zero policies (deny all for anon/authenticated PostgREST roles)
ALTER TABLE "raffle"."ProductVisibilitySnapshot" ENABLE ROW LEVEL SECURITY;

