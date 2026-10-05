import type { ActionFunctionArgs } from "react-router";
import { verifySignedQStashRequest } from "../services/drawLifecycle.server";
import { expireAllocationAndPromoteNext, runClaimExpirySweeper } from "../services/claimExpiry.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const rawBody = await request.text();
  if (!(await verifySignedQStashRequest(request, rawBody))) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const payload = JSON.parse(rawBody) as {
      allocationId?: string;
      drawId?: string;
      action?: string;
    };

    if (payload.action === "sweep") {
      const sweepResult = await runClaimExpirySweeper();
      return Response.json({ success: true, sweepResult });
    }

    if (!payload.allocationId || typeof payload.allocationId !== "string") {
      return Response.json({ error: "Missing allocationId" }, { status: 400 });
    }

    const result = await expireAllocationAndPromoteNext(payload.allocationId);
    return Response.json({ success: true, result });
  } catch (error) {
    console.error("[allocation-expiry] Error processing QStash expiry task:", error);
    return Response.json({ error: "Failed to process allocation expiry" }, { status: 500 });
  }
};
