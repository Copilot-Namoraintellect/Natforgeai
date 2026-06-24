import { describe, it, expect } from "vitest";
import { canUseAudienceAgent } from "../access";

function makeTier(audienceAgent: boolean | null) {
  return { audienceAgent };
}

describe("canUseAudienceAgent", () => {
  it("allows admin users regardless of tier", () => {
    const result = canUseAudienceAgent(makeTier(false), "admin");
    expect(result.allowed).toBe(true);
  });

  it("allows users with audienceAgent enabled in their tier", () => {
    const result = canUseAudienceAgent(makeTier(true), "user");
    expect(result.allowed).toBe(true);
  });

  it("denies users when tier has audienceAgent disabled", () => {
    const result = canUseAudienceAgent(makeTier(false), "user");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Growth and Enterprise");
  });

  it("denies users when no tier is provided", () => {
    const result = canUseAudienceAgent(null, "user");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("No active subscription");
  });

  it("denies users when audienceAgent is null", () => {
    const result = canUseAudienceAgent(makeTier(null), "user");
    expect(result.allowed).toBe(false);
  });
});
