import prisma from "../db.server";
import { getQStashClient, getQStashReceiver } from "./qstash.server";

const MAX_QSTASH_DELAY_SECONDS = 6 * 24 * 60 * 60;

async function scheduleDrawLifecycleAction(
  drawId: string,
  action: "open" | "close",
  targetAt: Date,
  attempt = 0
): Promise<boolean> {
  const client = getQStashClient();
  const baseUrl = process.env.SHOPIFY_APP_URL;
  if (!client || !baseUrl) {
    console.error("[QStash] Draw lifecycle scheduling requires QSTASH_TOKEN and SHOPIFY_APP_URL.");
    return false;
  }

  try {
    const delay = Math.ceil((targetAt.getTime() - Date.now()) / 1000);
    if (delay < 0) return true;
    await client.publishJSON({
      url: `${baseUrl.replace(/\/$/, "")}/api/qstash/draw-lifecycle`,
      delay: Math.min(MAX_QSTASH_DELAY_SECONDS, delay),
      deduplicationId: `draw:${drawId}:${action}:${targetAt.getTime()}:${attempt}`,
      body: { drawId, action, attempt },
    });
    return true;
  } catch (error) {
    console.error("[QStash] Could not schedule draw lifecycle message:", error);
    return false;
  }
}

export async function scheduleDrawLifecycle(input: {
  drawId: string;
  entryOpensAt: Date;
  entryClosesAt: Date;
}): Promise<{ scheduled: boolean }> {
  const [openScheduled, closeScheduled] = await Promise.all([
    scheduleDrawLifecycleAction(input.drawId, "open", input.entryOpensAt),
    scheduleDrawLifecycleAction(input.drawId, "close", input.entryClosesAt),
  ]);
  return { scheduled: openScheduled && closeScheduled };
}

export async function rescheduleDrawLifecycleAction(
  drawId: string,
  action: "open" | "close",
  targetAt: Date,
  attempt: number
): Promise<boolean> {
  return scheduleDrawLifecycleAction(drawId, action, targetAt, attempt);
}

export async function verifySignedQStashRequest(request: Request, rawBody: string): Promise<boolean> {
  const receiver = getQStashReceiver();
  const signature = request.headers.get("upstash-signature");
  if (!receiver || !signature) return false;
  try {
    return await receiver.verify({ signature, body: rawBody });
  } catch {
    return false;
  }
}

export async function applyDrawLifecycleAction(
  drawId: string,
  action: "open" | "close",
  now = new Date()
): Promise<"updated" | "not_due" | "expired" | "unchanged" | "not_found"> {
  return prisma.$transaction(async (tx) => {
    const [draw] = await tx.$queryRaw<Array<{
      id: string;
      status: string;
      entryOpensAt: Date;
      entryClosesAt: Date;
    }>>`SELECT "id", "status", "entryOpensAt", "entryClosesAt" FROM "raffle"."Draw" WHERE "id" = ${drawId} FOR UPDATE`;
    if (!draw) return "not_found";

    const databaseNow = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
    const checkedAt = databaseNow[0]?.now ?? now;
    if (action === "open") {
      if (draw.status !== "SCHEDULED") return "unchanged";
      if (checkedAt >= draw.entryClosesAt) return "expired";
      if (checkedAt < draw.entryOpensAt) return "not_due";
      await tx.draw.update({ where: { id: drawId }, data: { status: "OPEN" } });
      return "updated";
    }

    if (draw.status !== "OPEN" && draw.status !== "SCHEDULED") return "unchanged";
    if (checkedAt < draw.entryClosesAt) return "not_due";
    await tx.draw.update({ where: { id: drawId }, data: { status: "CLOSED" } });
    return "updated";
  });
}
