import crypto from "node:crypto";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { runVisibilityGuardScan } from "../services/guardScanner.server";

function isTimingSafeEqual(supplied: string | null, expected: string): boolean {
  if (!supplied) return false;
  const suppliedBuf = Buffer.from(supplied);
  const expectedBuf = Buffer.from(expected);
  if (suppliedBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(suppliedBuf, expectedBuf);
}

async function handleCronRequest(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");

  if (!cronSecret || !isTimingSafeEqual(authHeader, `Bearer ${cronSecret}`)) {
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
