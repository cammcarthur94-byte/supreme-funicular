import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

export interface RateLimitCheckResult {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number;
  dimension?: "ip" | "customer" | "draw";
}

// In-memory sliding window fallback for local testing and dev without Upstash Redis
class InMemorySlidingWindowLimiter {
  private windows = new Map<string, number[]>();

  async check(key: string, limit: number, windowMs: number): Promise<{ success: boolean; limit: number; remaining: number; reset: number }> {
    const now = Date.now();
    const windowStart = now - windowMs;
    const timestamps = (this.windows.get(key) || []).filter((t) => t > windowStart);

    if (timestamps.length >= limit) {
      const oldest = timestamps[0];
      const reset = Math.ceil((oldest + windowMs - now) / 1000);
      return { success: false, limit, remaining: 0, reset: Math.max(1, reset) };
    }

    timestamps.push(now);
    this.windows.set(key, timestamps);
    return {
      success: true,
      limit,
      remaining: limit - timestamps.length,
      reset: Math.ceil(windowMs / 1000),
    };
  }

  clear() {
    this.windows.clear();
  }
}

const memoryFallback = new InMemorySlidingWindowLimiter();

export function resetRateLimits() {
  memoryFallback.clear();
}

let redisClient: Redis | null = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  try {
    redisClient = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  } catch (err) {
    console.warn("[rateLimiter] Failed to initialize Upstash Redis client; falling back to memory:", err);
  }
}

// Configurable sliding window limits
export const RATE_LIMIT_CONFIG = {
  ip: { limit: 10, windowSeconds: 60 },        // Max 10 submissions / min per IP
  customer: { limit: 5, windowSeconds: 60 },   // Max 5 submissions / min per Customer
  draw: { limit: 60, windowSeconds: 60 },       // Max 60 submissions / min per Draw
};

/**
 * Checks sliding window rate limits across IP, customer, and draw dimensions.
 * Returns { success: false, dimension: ... } if any dimension is throttled.
 */
export async function checkEntryRateLimit(params: {
  ip: string;
  customerId: string;
  drawId: string;
}): Promise<RateLimitCheckResult> {
  const dimensions: Array<{
    name: "ip" | "customer" | "draw";
    key: string;
    limit: number;
    windowSeconds: number;
  }> = [
    {
      name: "ip",
      key: `ratelimit:entry:ip:${params.ip}`,
      limit: RATE_LIMIT_CONFIG.ip.limit,
      windowSeconds: RATE_LIMIT_CONFIG.ip.windowSeconds,
    },
    {
      name: "customer",
      key: `ratelimit:entry:customer:${params.customerId}`,
      limit: RATE_LIMIT_CONFIG.customer.limit,
      windowSeconds: RATE_LIMIT_CONFIG.customer.windowSeconds,
    },
    {
      name: "draw",
      key: `ratelimit:entry:draw:${params.drawId}`,
      limit: RATE_LIMIT_CONFIG.draw.limit,
      windowSeconds: RATE_LIMIT_CONFIG.draw.windowSeconds,
    },
  ];

  for (const dim of dimensions) {
    if (redisClient) {
      try {
        const limiter = new Ratelimit({
          redis: redisClient,
          limiter: Ratelimit.slidingWindow(dim.limit, `${dim.windowSeconds} s`),
          analytics: false,
          prefix: "fairdrops",
        });
        const res = await limiter.limit(dim.key);
        if (!res.success) {
          return {
            success: false,
            limit: res.limit,
            remaining: res.remaining,
            reset: res.reset,
            dimension: dim.name,
          };
        }
      } catch (err) {
        console.warn(`[rateLimiter] Redis error on ${dim.name}, checking memory fallback:`, err);
        const memRes = await memoryFallback.check(dim.key, dim.limit, dim.windowSeconds * 1000);
        if (!memRes.success) {
          return { ...memRes, dimension: dim.name };
        }
      }
    } else {
      const memRes = await memoryFallback.check(dim.key, dim.limit, dim.windowSeconds * 1000);
      if (!memRes.success) {
        return { ...memRes, dimension: dim.name };
      }
    }
  }

  return {
    success: true,
    limit: RATE_LIMIT_CONFIG.ip.limit,
    remaining: RATE_LIMIT_CONFIG.ip.limit - 1,
    reset: 60,
  };
}
