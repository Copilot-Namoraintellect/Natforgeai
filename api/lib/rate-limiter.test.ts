import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  rateLimitUser,
  TIER_RATE_LIMITS,
  clearRateLimitStateForTests,
} from "./rate-limiter";
import { env } from "./env";
import * as logger from "./logger";

vi.mock("./redis", () => ({
  connectRedis: vi.fn(),
  isRedisConfigured: vi.fn(() => false),
}));

function buildCtx(role: "user" | "admin" = "user") {
  return {
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
    user: {
      id: 42,
      tierSlug: "free",
      role,
    } as any,
  };
}

describe("rateLimitUser admin AI bypass", () => {
  const originalFreeLimits = { ...TIER_RATE_LIMITS.free };

  beforeEach(() => {
    clearRateLimitStateForTests();
    TIER_RATE_LIMITS.free = { ...originalFreeLimits, aiPerDay: 2 };
    env.enableAdminRateLimitBypass = false;
  });

  afterEach(() => {
    clearRateLimitStateForTests();
    TIER_RATE_LIMITS.free = { ...originalFreeLimits };
    env.enableAdminRateLimitBypass = false;
  });

  it("rate limits normal users", async () => {
    const ctx = buildCtx("user");

    await rateLimitUser(ctx, "ai", "content.generateForCampaign");
    await rateLimitUser(ctx, "ai", "content.generateForCampaign");

    await expect(
      rateLimitUser(ctx, "ai", "content.generateForCampaign")
    ).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      message: expect.stringContaining("Rate limit reached"),
    });
  });

  it("allows admin to bypass AI rate limits only when the env flag is enabled", async () => {
    env.enableAdminRateLimitBypass = true;
    const logSpy = vi.spyOn(logger, "logInfo").mockReturnValue(undefined);
    const ctx = buildCtx("admin");

    // The free tier limit is 2, but the admin should bypass it entirely.
    await rateLimitUser(ctx, "ai", "content.generateForCampaign");
    await rateLimitUser(ctx, "ai", "content.generateForCampaign");
    await rateLimitUser(ctx, "ai", "content.generateForCampaign");
    await rateLimitUser(ctx, "ai", "image.generatePremiumLeaflet");

    expect(logSpy).toHaveBeenCalledTimes(4);
    expect(logSpy).toHaveBeenLastCalledWith(
      "[rate-limiter] admin AI rate limit bypass",
      expect.objectContaining({
        userId: 42,
        role: "admin",
        route: "image.generatePremiumLeaflet",
        reason: "admin_rate_limit_bypass",
      })
    );

    logSpy.mockRestore();
  });

  it("rate limits admin users when the bypass flag is disabled", async () => {
    env.enableAdminRateLimitBypass = false;
    const ctx = buildCtx("admin");

    await rateLimitUser(ctx, "ai", "content.generateForCampaign");
    await rateLimitUser(ctx, "ai", "content.generateForCampaign");

    await expect(
      rateLimitUser(ctx, "ai", "content.generateForCampaign")
    ).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      message: expect.stringContaining("Rate limit reached"),
    });
  });

  it("does not bypass non-AI rate limits for admins", async () => {
    env.enableAdminRateLimitBypass = true;
    TIER_RATE_LIMITS.free = { ...originalFreeLimits, apiPerHour: 1 };
    const ctx = buildCtx("admin");

    await rateLimitUser(ctx, "api", "content.list");

    await expect(rateLimitUser(ctx, "api", "content.list")).rejects.toMatchObject(
      {
        code: "TOO_MANY_REQUESTS",
        message: expect.stringContaining("Rate limit reached"),
      }
    );
  });
});
