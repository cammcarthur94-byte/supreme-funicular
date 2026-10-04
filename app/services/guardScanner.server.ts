import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { checkAndRemediateProductVisibility } from "./productVisibility.server";
import { scheduleVisibilityGuardCheck } from "./qstash.server";

export interface GuardScanResult {
  totalActiveDraws: number;
  totalProductsChecked: number;
  breachesFound: number;
  remediatedCount: number;
  rescheduled: boolean;
}

/**
 * Runs a visibility scan across all currently active draws (SCHEDULED, OPEN, FULFILLING).
 * Automatically remediates any published products and reschedules via QStash if draws remain active.
 */
export async function runVisibilityGuardScan(
  triggerSource: "qstash" | "cron"
): Promise<GuardScanResult> {
  const activeDraws = await prisma.draw.findMany({
    where: {
      status: { in: ["SCHEDULED", "OPEN", "FULFILLING"] },
    },
    include: {
      shop: true,
      variants: true,
    },
  });

  if (activeDraws.length === 0) {
    console.log(`[GuardScanner:${triggerSource}] No active draws found. Standing down.`);
    return {
      totalActiveDraws: 0,
      totalProductsChecked: 0,
      breachesFound: 0,
      remediatedCount: 0,
      rescheduled: false,
    };
  }

  console.log(
    `[GuardScanner:${triggerSource}] Scanning ${activeDraws.length} active draw(s) across stores...`
  );

  // Group draws and unique product GIDs by shop
  const shopMap = new Map<
    string,
    { shopDomain: string; shopId: string; productGids: Set<string> }
  >();

  for (const draw of activeDraws) {
    if (!shopMap.has(draw.shopId)) {
      shopMap.set(draw.shopId, {
        shopDomain: draw.shop.shopDomain,
        shopId: draw.shop.id,
        productGids: new Set<string>(),
      });
    }

    const shopEntry = shopMap.get(draw.shopId)!;
    for (const v of draw.variants) {
      shopEntry.productGids.add(v.productGid);
    }
  }

  let totalProductsChecked = 0;
  let breachesFound = 0;
  let remediatedCount = 0;

  for (const [, shopData] of shopMap) {
    try {
      // Use offline session admin client for background execution
      const { admin } = await unauthenticated.admin(shopData.shopDomain);

      for (const productGid of shopData.productGids) {
        totalProductsChecked++;
        const checkResult = await checkAndRemediateProductVisibility({
          admin,
          productGid,
          shopId: shopData.shopId,
          triggerSource,
        });

        if (checkResult.breached) {
          breachesFound++;
          if (checkResult.remediated) {
            remediatedCount++;
          }
        }
      }
    } catch (error) {
      console.error(
        `[GuardScanner:${triggerSource}] Failed to scan shop ${shopData.shopDomain}:`,
        error
      );
    }
  }

  // Self-scheduling loop: if active draws remain, schedule next check in 20 minutes (1200 seconds)
  let rescheduled = false;
  if (triggerSource === "qstash" || triggerSource === "cron") {
    const scheduleRes = await scheduleVisibilityGuardCheck({ delaySeconds: 1200 });
    rescheduled = scheduleRes.scheduled;
  }

  return {
    totalActiveDraws: activeDraws.length,
    totalProductsChecked,
    breachesFound,
    remediatedCount,
    rescheduled,
  };
}
