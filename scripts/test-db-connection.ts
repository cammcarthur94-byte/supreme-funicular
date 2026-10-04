import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

// Load local environment variables from .env
dotenv.config();

function maskConnectionString(urlStr?: string): string {
  if (!urlStr) return "<NOT SET>";
  try {
    const parsed = new URL(urlStr);
    const host = parsed.host;
    const protocol = parsed.protocol;
    const pathname = parsed.pathname;
    return `${protocol}//*****@${host}${pathname}`;
  } catch {
    return "[MALFORMED URL]";
  }
}

function sanitizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    let msg = error.message;
    // Strip any password patterns from error strings
    msg = msg.replace(/:([^\s:@/]+)@/g, ":*****@");
    return msg;
  }
  return String(error);
}

async function main() {
  console.log("==================================================");
  console.log("Supabase PostgreSQL Connection Test");
  console.log("==================================================");

  const databaseUrl = process.env.DATABASE_URL;
  const directUrl = process.env.DIRECT_URL;

  if (!databaseUrl && !directUrl) {
    console.error("[ERROR] Missing database environment variables.");
    console.error("Please configure DATABASE_URL and DIRECT_URL in your local .env file.");
    process.exit(1);
  }

  console.log(`Pooled URL (DATABASE_URL): ${maskConnectionString(databaseUrl)}`);
  console.log(`Direct URL (DIRECT_URL):   ${maskConnectionString(directUrl)}`);
  console.log("Attempting database connection via Prisma...\n");

  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: databaseUrl || directUrl,
      },
    },
  });

  try {
    const result = await prisma.$queryRaw<Array<{ connected: number }>>`SELECT 1 as connected;`;
    if (result && result.length > 0) {
      console.log("[SUCCESS] Database connection verified successfully!");
      console.log("[SUCCESS] PostgreSQL server responded to query.");
    } else {
      console.warn("[WARN] Query returned unexpected result.");
    }
  } catch (err) {
    console.error("[FAILURE] Database connection failed.");
    console.error(`Reason: ${sanitizeErrorMessage(err)}`);
    console.error("Check your credentials, Supabase project status, and pooler settings.");
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(`[FATAL] Unexpected error: ${sanitizeErrorMessage(err)}`);
  process.exit(1);
});
