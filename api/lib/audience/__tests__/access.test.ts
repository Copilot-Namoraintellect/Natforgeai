import { describe, it, expect, vi, beforeEach } from "vitest";
import { canUseAudienceAgent, checkAudienceAgentAccess } from "../access";

vi.mock("../../subscription", () => ({
  getUserTier: vi.fn(),
}));

import { getUserTier } from "../../subscription";

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

describe("checkAudienceAgentAccess (WBS-R4 C0.1 hard-coded bypass removal)", () => {
  beforeEach(() => {
    vi.mocked(getUserTier).mockReset();
  });

  it("evaluates the former bypass account (userId 14) through authoritative tier eligibility", async () => {
    // The temporary hard-coded test-account bypass is removed: the account is
    // subject to the same tier gate as every other user. Fail closed when the
    // tier does not grant the audience agent.
    vi.mocked(getUserTier).mockResolvedValue(makeTier(false) as never);
    const denied = await checkAudienceAgentAccess(14, "user");
    expect(denied.allowed).toBe(false);

    vi.mocked(getUserTier).mockResolvedValue(makeTier(true) as never);
    const allowed = await checkAudienceAgentAccess(14, "user");
    expect(allowed.allowed).toBe(true);
    expect(getUserTier).toHaveBeenCalledWith(14);
  });

  it("keeps the admin path authoritative without any user-id allowlist", async () => {
    vi.mocked(getUserTier).mockResolvedValue(null as never);
    const result = await checkAudienceAgentAccess(14, "admin");
    expect(result.allowed).toBe(true);
  });

  it("source contains no hard-coded user-id allowlist", async () => {
    // Adversarial guard: re-introducing a hard-coded production user-id bypass
    // must fail this suite. Eligibility is tier/role authority only.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(
      fileURLToPath(new URL("../access.ts", import.meta.url)),
      "utf8"
    );
    expect(source).not.toContain("TEMP_AUDIENCE_INTELLIGENCE_USER_IDS");
    expect(source).not.toMatch(/new Set<number>\(\s*\[\s*14/);
  });
});
