import { TRPCError } from "@trpc/server";
import { connectRedis, isRedisConfigured } from "./redis";
import type { TrpcContext } from "../context";

// Tier-based rate limits
export const TIER_RATE_LIMITS: Record<
  string,
  { aiPerDay: number; apiPerHour: number; publishPerHour: number }
> = {
  free: { aiPerDay: 20, apiPerHour: 100, publishPerHour: 10 },
  startup: { aiPerDay: 200, apiPerHour: 1000, publishPerHour: 100 },
  growth: { aiPerDay: 2000, apiPerHour: 5000, publishPerHour: 500 },
  enterprise: { aiPerDay: 20000, apiPerHour: 20000, publishPerHour: 2000 },
};

// Default limits for unknown tiers
const DEFAULT_LIMITS = TIER_RATE_LIMITS.free;

interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
}

// In-memory fallback for development
const devCounters = new Map<string, { count: number; resetAt: number }>();

function getClientIP(ctx: TrpcContext): string {
  const forwarded = ctx.req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  const realIp = ctx.req.headers.get("x-real-ip");
  if (realIp) return realIp;
  return "unknown";
}

async function getCounter(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
  if (isRedisConfigured()) {
    const redis = await connectRedis();
    const now = Date.now();
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const redisKey = `${key}:${windowStart}`;

    const count = await redis.incr(redisKey);
    if (count === 1) {
      await redis.pExpire(redisKey, windowMs);
    }

    return { count, resetAt: windowStart + windowMs };
  }

  // Dev fallback: in-memory counter
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const devKey = `${key}:${windowStart}`;

  const existing = devCounters.get(devKey);
  if (existing && existing.resetAt > now) {
    existing.count++;
    return existing;
  }

  const entry = { count: 1, resetAt: windowStart + windowMs };
  devCounters.set(devKey, entry);
  return entry;
}

export async function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number
): Promise<RateLimitResult> {
  const { count, resetAt } = await getCounter(key, windowMs);
  return {
    allowed: count <= limit,
    limit,
    remaining: Math.max(0, limit - count),
    resetAt,
  };
}

// Middleware for public routes (per-IP)
export async function rateLimitPublic(
  ctx: TrpcContext,
  limit = 60,
  windowMs = 60_000
): Promise<void> {
  const ip = getClientIP(ctx);
  const result = await checkRateLimit(`rate:ip:${ip}:public`, limit, windowMs);
  if (!result.allowed) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `Rate limit reached. Please wait or upgrade your plan.`,
    });
  }
}

// Middleware for authenticated routes (per-user, tier-based)
export async function rateLimitUser(
  ctx: TrpcContext,
  type: "api" | "ai" | "publish"
): Promise<void> {
  if (!ctx.user) return;

  const tierSlug = (ctx.user as any).tierSlug ?? "free";
  const limits = TIER_RATE_LIMITS[tierSlug] ?? DEFAULT_LIMITS;

  let limit: number;
  let windowMs: number;

  switch (type) {
    case "ai":
      limit = limits.aiPerDay;
      windowMs = 24 * 60 * 60 * 1000;
      break;
    case "publish":
      limit = limits.publishPerHour;
      windowMs = 60 * 60 * 1000;
      break;
    case "api":
    default:
      limit = limits.apiPerHour;
      windowMs = 60 * 60 * 1000;
      break;
  }

  const result = await checkRateLimit(
    `rate:user:${ctx.user.id}:${type}`,
    limit,
    windowMs
  );

  if (!result.allowed) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `Rate limit reached. Please wait or upgrade your plan.`,
    });
  }
}
