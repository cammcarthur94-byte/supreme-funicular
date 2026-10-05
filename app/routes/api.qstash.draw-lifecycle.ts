import type { ActionFunctionArgs } from "react-router";
import { applyDrawLifecycleAction, rescheduleDrawLifecycleAction, verifySignedQStashRequest } from "../services/drawLifecycle.server";
import prisma from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const rawBody = await request.text();
  if (!(await verifySignedQStashRequest(request, rawBody))) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const payload = JSON.parse(rawBody) as { drawId?: unknown; action?: unknown; attempt?: unknown };
    if (typeof payload.drawId !== "string" || !/^[a-f\d-]{36}$/i.test(payload.drawId) || (payload.action !== "open" && payload.action !== "close") || (payload.attempt !== undefined && (!Number.isInteger(payload.attempt) || Number(payload.attempt) < 0))) {
      return Response.json({ error: "Invalid lifecycle message" }, { status: 400 });
    }
    const result = await applyDrawLifecycleAction(payload.drawId, payload.action);
    if (result === "not_due") {
      const draw = await prisma.draw.findUnique({
        where: { id: payload.drawId },
        select: { entryOpensAt: true, entryClosesAt: true },
      });
      if (draw) {
        const targetAt = payload.action === "open" ? draw.entryOpensAt : draw.entryClosesAt;
        const attempt = Number(payload.attempt ?? 0) + 1;
        if (attempt <= 100) await rescheduleDrawLifecycleAction(payload.drawId, payload.action, targetAt, attempt);
      }
    } else if (result === "expired" && payload.action === "open") {
      const draw = await prisma.draw.findUnique({
        where: { id: payload.drawId },
        select: { entryClosesAt: true },
      });
      if (draw) await rescheduleDrawLifecycleAction(payload.drawId, "close", draw.entryClosesAt, Number(payload.attempt ?? 0) + 1);
    }
    return Response.json({ success: true, result });
  } catch (error) {
    console.error("[draw-lifecycle] Signed QStash task failed:", error);
    return Response.json({ error: "Lifecycle task failed" }, { status: 500 });
  }
};
