import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { runVisibilityGuardScan } from "../services/guardScanner.server";

async function handleCronRequest(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    console.error("[api.cron.guard] Unauthorized backstop cron execution attempt.");
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const result = await runVisibilityGuardScan("cron");
    return Response.json({
      success: true,
      timestamp: new Date().toISOString(),
      ...result,
    });
  } catch (error) {
    console.error("[api.cron.guard] Backstop cron execution failed:", error);
    return Response.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return handleCronRequest(request);
};

export const action = async ({ request }: ActionFunctionArgs) => {
  return handleCronRequest(request);
};
