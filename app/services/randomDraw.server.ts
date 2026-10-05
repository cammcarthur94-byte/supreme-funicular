import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import prisma from "../db.server";

export type RandomIntFn = (max: number) => number;

/**
 * Pure, cryptographically secure Fisher-Yates shuffle.
 * Uses crypto.randomInt (CSPRNG) by default, strictly never Math.random().
 * Accepts an optional randomIntFn parameter for dependency injection and testing.
 */
export function secureFisherYatesShuffle<T>(
  items: readonly T[],
  randomIntFn: RandomIntFn = (max) => crypto.randomInt(max)
): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    // Pick an integer j in [0, i] (i.e. randomInt(i + 1))
    const j = randomIntFn(i + 1);
    if (j < 0 || j > i) {
      throw new RangeError(`randomIntFn returned out-of-range index ${j} for bound ${i + 1}`);
    }
    const temp = result[i];
    result[i] = result[j];
    result[j] = temp;
  }
  return result;
}

/**
 * Computes SHA-256 commitment hash over sorted entry IDs BEFORE shuffling.
 * Guarantees deterministic, reproducible commitment for transparency.
 */
export function computeCommitmentHash(entryIds: readonly string[]): string {
  const sorted = [...entryIds].sort();
  return crypto.createHash("sha256").update(sorted.join("\n")).digest("hex");
}

/**
 * Persists entry ranks in batches using PostgreSQL bulk VALUES joins
 * to safely handle large draws (100k+ entries) well within execution time limits.
 */
export async function persistEntryRanksInChunks(
  tx: Prisma.TransactionClient,
  rankedEntries: Array<{ id: string; rank: number }>,
  chunkSize = 2000
): Promise<void> {
  for (let i = 0; i < rankedEntries.length; i += chunkSize) {
    const chunk = rankedEntries.slice(i, i + chunkSize);
    if (chunk.length === 0) continue;

    const valueClauses = chunk.map((_, idx) => `($${idx * 2 + 1}::text, $${idx * 2 + 2}::int)`).join(", ");
    const params: Array<string | number> = [];
    for (const item of chunk) {
      params.push(item.id, item.rank);
    }

    const sql = `UPDATE "raffle"."Entry" AS e
      SET "rank" = v.rank::int
      FROM (VALUES ${valueClauses}) AS v(id, rank)
      WHERE e.id = v.id::text`;

    await tx.$executeRawUnsafe(sql, ...params);
  }
}

export interface ExecuteDrawOptions {
  randomIntFn?: RandomIntFn;
  now?: Date;
}

export interface ExecuteDrawResult {
  status:
    | "drawn"
    | "completed_zero_entries"
    | "already_drawn"
    | "not_due"
    | "invalid_state"
    | "not_found";
  drawId: string;
  totalEligible: number;
  winnersCount: number;
  waitlistCount: number;
  unsoldUnits: number;
  commitmentHash?: string;
  message?: string;
}

/**
 * Executes the random draw within a single database transaction with a row lock.
 * Idempotent: returns immediately if draw is already DRAWN or later.
 * Assigns ranks 1..N to winners and N+1..M to waitlist.
 */
export async function executeRandomDraw(
  drawId: string,
  options?: ExecuteDrawOptions
): Promise<ExecuteDrawResult> {
  return prisma.$transaction(async (tx) => {
    // 1. Row lock on the Draw record
    const [draw] = await tx.$queryRaw<Array<{
      id: string;
      shopId: string;
      status: string;
      entryOpensAt: Date;
      entryClosesAt: Date;
      drawAt: Date;
      unitsAvailable: number;
      purgeAfterDays: number;
      commitmentHash: string | null;
    }>>`SELECT "id", "shopId", "status", "entryOpensAt", "entryClosesAt", "drawAt", "unitsAvailable", "purgeAfterDays", "commitmentHash"
       FROM "raffle"."Draw"
       WHERE "id" = ${drawId}
       FOR UPDATE`;

    if (!draw) {
      return {
        status: "not_found",
        drawId,
        totalEligible: 0,
        winnersCount: 0,
        waitlistCount: 0,
        unsoldUnits: 0,
        message: "Draw not found.",
      };
    }

    // 2. Idempotency: if already DRAWN or later, do nothing
    if (["DRAWN", "FULFILLING", "COMPLETED", "PURGED"].includes(draw.status)) {
      return {
        status: "already_drawn",
        drawId,
        totalEligible: 0,
        winnersCount: 0,
        waitlistCount: 0,
        unsoldUnits: 0,
        commitmentHash: draw.commitmentHash ?? undefined,
        message: `Draw is already in ${draw.status} state. No operation performed.`,
      };
    }

    if (draw.status === "CANCELLED") {
      return {
        status: "invalid_state",
        drawId,
        totalEligible: 0,
        winnersCount: 0,
        waitlistCount: 0,
        unsoldUnits: 0,
        message: "Cannot run draw: draw has been cancelled.",
      };
    }

    // 3. Confirm timing and status
    const dbNowRes = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
    const now = options?.now ?? dbNowRes[0]?.now ?? new Date();

    if (draw.status === "OPEN") {
      if (now >= draw.entryClosesAt) {
        await tx.draw.update({ where: { id: drawId }, data: { status: "CLOSED" } });
        draw.status = "CLOSED";
      } else {
        return {
          status: "invalid_state",
          drawId,
          totalEligible: 0,
          winnersCount: 0,
          waitlistCount: 0,
          unsoldUnits: 0,
          message: "Cannot run draw: entries are still open.",
        };
      }
    }

    if (draw.status !== "CLOSED") {
      return {
        status: "invalid_state",
        drawId,
        totalEligible: 0,
        winnersCount: 0,
        waitlistCount: 0,
        unsoldUnits: 0,
        message: `Cannot run draw: status must be CLOSED, but is ${draw.status}.`,
      };
    }

    if (now < draw.drawAt) {
      return {
        status: "not_due",
        drawId,
        totalEligible: 0,
        winnersCount: 0,
        waitlistCount: 0,
        unsoldUnits: 0,
        message: "Scheduled draw time has not arrived yet.",
      };
    }

    // 4. Select all eligible entries: status VALID or (FLAGGED with MERCHANT_APPROVED)
    const candidateEntries = await tx.entry.findMany({
      where: {
        drawId,
        status: { in: ["VALID", "FLAGGED"] },
      },
      select: { id: true, status: true, riskFlags: true },
    });

    const eligibleEntries = candidateEntries.filter((entry) => {
      if (entry.status === "VALID") return true;
      if (entry.status === "FLAGGED") {
        const flags = Array.isArray(entry.riskFlags) ? entry.riskFlags : [];
        return flags.includes("MERCHANT_APPROVED");
      }
      return false;
    });

    const totalEligible = eligibleEntries.length;
    const unitsAvailable = draw.unitsAvailable;

    // 5. Edge case: ZERO entries
    if (totalEligible === 0) {
      await tx.draw.update({
        where: { id: drawId },
        data: { status: "COMPLETED" },
      });

      await tx.auditLog.create({
        data: {
          shopId: draw.shopId,
          drawId,
          eventType: "DRAW_COMPLETED_ZERO_ENTRIES",
          actor: "system",
          metadata: {
            message: "Draw closed with 0 eligible entries. Transitioned directly to COMPLETED.",
            unitsAvailable,
            unsoldUnits: unitsAvailable,
            purgeAfterDays: draw.purgeAfterDays,
          },
        },
      });

      return {
        status: "completed_zero_entries",
        drawId,
        totalEligible: 0,
        winnersCount: 0,
        waitlistCount: 0,
        unsoldUnits: unitsAvailable,
        message: "Draw completed with 0 entries.",
      };
    }

    // 6. Compute commitment hash BEFORE shuffling
    const sortedEntryIds = eligibleEntries.map((e) => e.id).sort();
    const commitmentHash = computeCommitmentHash(sortedEntryIds);

    await tx.auditLog.create({
      data: {
        shopId: draw.shopId,
        drawId,
        eventType: "DRAW_COMMITMENT_RECORDED",
        actor: "system",
        metadata: {
          commitmentHash,
          totalEligibleEntries: totalEligible,
        },
      },
    });

    // 7. Shuffle ONCE using cryptographically secure Fisher-Yates
    const shuffledIds = secureFisherYatesShuffle(sortedEntryIds, options?.randomIntFn);
    const rankedItems = shuffledIds.map((id, index) => ({
      id,
      rank: index + 1, // 1-indexed rank
    }));

    // 8. Batch persist ranks
    await persistEntryRanksInChunks(tx, rankedItems);

    const winnersCount = Math.min(unitsAvailable, totalEligible);
    const waitlistCount = Math.max(0, totalEligible - unitsAvailable);
    const unsoldUnits = Math.max(0, unitsAvailable - totalEligible);

    // 9. Edge case: Fewer entries than units
    if (unsoldUnits > 0) {
      await tx.auditLog.create({
        data: {
          shopId: draw.shopId,
          drawId,
          eventType: "DRAW_UNSOLD_UNITS_FLAGGED",
          actor: "system",
          metadata: {
            unitsAvailable,
            totalEligible,
            winnersCount,
            unsoldUnits,
            message: `${unsoldUnits} units left unsold due to fewer entries than available units.`,
          },
        },
      });
    }

    // 10. Update Draw status to DRAWN and save commitmentHash
    await tx.draw.update({
      where: { id: drawId },
      data: {
        status: "DRAWN",
        commitmentHash,
      },
    });

    await tx.auditLog.create({
      data: {
        shopId: draw.shopId,
        drawId,
        eventType: "DRAW_EXECUTED",
        actor: "system",
        metadata: {
          totalEligible,
          winnersCount,
          waitlistCount,
          unsoldUnits,
          commitmentHash,
        },
      },
    });

    return {
      status: "drawn",
      drawId,
      totalEligible,
      winnersCount,
      waitlistCount,
      unsoldUnits,
      commitmentHash,
    };
  });
}
