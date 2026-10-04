import dotenv from "dotenv";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_PUBLISHABLE_KEY;

const TABLES = [
  "Shop",
  "Draw",
  "DrawVariant",
  "Entry",
  "Allocation",
  "AuditLog",
  "WebhookEvent",
  "Session",
  "ProductVisibilitySnapshot",
];

async function testTableAccess(tableName: string): Promise<{ success: boolean; status: number; message: string }> {
  if (!supabaseUrl || !anonKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY in environment.");
  }

  // 1. Attempt access via default REST endpoint
  const url = `${supabaseUrl.replace(/\/$/, "")}/rest/v1/${tableName}?select=*`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      "Content-Type": "application/json",
    },
  });

  // Safe statuses: 404 (table not exposed in PostgREST public schema), 401/403 (forbidden/unauthorized)
  // An empty array or 200 with data would mean the table is readable by anon!
  if (response.status === 404 || response.status === 401 || response.status === 403) {
    return {
      success: true,
      status: response.status,
      message: `Table '${tableName}' is completely blocked from anon PostgREST access (HTTP ${response.status}).`,
    };
  }

  if (response.ok) {
    const data = await response.json();
    return {
      success: false,
      status: response.status,
      message: `SECURITY RISK: Table '${tableName}' returned HTTP ${response.status} with payload: ${JSON.stringify(data)}`,
    };
  }

  return {
    success: true,
    status: response.status,
    message: `Table '${tableName}' denied with HTTP ${response.status}.`,
  };
}

async function main() {
  console.log("==================================================");
  console.log("Supabase Row Level Security (RLS) & Anon Key Audit");
  console.log("==================================================");
  console.log(`Supabase URL: ${supabaseUrl}`);
  console.log(`Testing PostgREST exposure for ${TABLES.length} raffle tables...\n`);

  let allSecure = true;

  for (const table of TABLES) {
    try {
      const result = await testTableAccess(table);
      if (result.success) {
        console.log(`[SECURE] ${result.message}`);
      } else {
        console.error(`[VULNERABLE] ${result.message}`);
        allSecure = false;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ERROR] Failed to query '${table}': ${message}`);
      allSecure = false;
    }
  }

  console.log("\n--------------------------------------------------");
  if (allSecure) {
    console.log("[VERIFIED] All application tables are shielded from Supabase public anon access.");
    process.exit(0);
  } else {
    console.error("[ALERT] One or more tables are exposed to the public anon key!");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Audit script failed:", err);
  process.exit(1);
});
