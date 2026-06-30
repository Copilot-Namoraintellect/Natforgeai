import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TRPCError } from "@trpc/server";
import {
  rateLimitUser,
  TIER_RATE_LIMITS,
  clearRateLimitStateForTests,
} from "./rate-limiter";
import { env } from "./env";
import * as logger from "./logger";

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
    // Use a tiny AI limit so we can trigger rate limiting quickly.
    TIER_RATE_LIMITS.free = { ...originalFreeLimits, aiPerDay: 2 };
  });

  afterEach(() => {
    TIER_RATE_LIMITS.free = { ...originalFreeLimits };
    env.enableAdminRateLimitBypass = false;
  });

  it("rate limits normal users", async () => {
    const ctx = buildCtx("user");
    await rateLimitUser(ctx, "ai", "content.generateForCampaign");
    await rateLimitUser(ctx, "ai", "content.generateForCampaign");
    await expect(
      rateLimitUser(ctx, "ai", "content.generateForCampaign")
    ).rejects.toThrow(TRPCError);
    try {
      await rateLimitUser(ctx, "ai", "content.generateForCampaign");
    } catch (err) {
      expect(err).toBeInstanceOf(TRPCError);
      expect((err as TRPCError).code).toBe("TOO_MANY_REQUESTS");
      expect((err as TRPCError).message).toContain("Rate limit reached");
    }
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
    ).rejects.toThrow(TRPCError);
  });

  it("does not bypass non-AI rate limits for admins", async () => {
    env.enableAdminRateLimitBypass = true;
    TIER_RATE_LIMITS.free = { ...originalFreeLimits, apiPerHour: 1 };
    const ctx = buildCtx("admin");

    await rateLimitUser(ctx, "api", "content.list");
    await expect(rateLimitUser(ctx, "api", "content.list")).rejects.toThrow(
      TRPCError
    );
  });
});
