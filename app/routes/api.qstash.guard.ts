import type { ActionFunctionArgs } from "react-router";
import { verifyQStashRequest } from "../services/qstash.server";
import { runVisibilityGuardScan } from "../services/guardScanner.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const rawBody = await request.text();
  const isValid = await verifyQStashRequest(request, rawBody);

  if (!isValid) {
    console.error("[api.qstash.guard] Unauthorized QStash request signature.");
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const result = await runVisibilityGuardScan("qstash");
    return Response.json({
      success: true,
      timestamp: new Date().toISOString(),
      ...result,
    });
  } catch (error) {
    console.error("[api.qstash.guard] Execution failed:", error);
    return Response.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
};
