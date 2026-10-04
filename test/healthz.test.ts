import { describe, it, expect } from "vitest";
import { loader } from "../app/routes/healthz";

describe("Health check endpoint (/healthz)", () => {
  it("returns HTTP 200 with status ok and service name", async () => {
    const response = await loader();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(response.headers.get("Cache-Control")).toBe("no-store, no-cache, must-revalidate");

    const data = await response.json();
    expect(data.status).toBe("ok");
    expect(data.service).toBe("fairdrops-raffle");
    expect(typeof data.timestamp).toBe("string");
    expect(typeof data.uptime).toBe("number");
  });
});
