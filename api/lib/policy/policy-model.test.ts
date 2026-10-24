/**
 * WBS-R5-E2 — Versioned business policy model acceptance.
 */
import { describe, it, expect } from "vitest";
import {
  buildBusinessPolicyConfig,
  buildDefaultPolicyConfig,
  buildVersionedPolicy,
  buildPolicyId,
  buildPolicyVersion,
  classifyActionCeiling,
  PolicyModelError,
  type BusinessPolicyConfig,
} from "./policy-model";
import type { MarketingActionType } from "./action-request";

function autonomousConfig(overrides: Partial<BusinessPolicyConfig> = {}): BusinessPolicyConfig {
  const base = buildDefaultPolicyConfig();
  return buildBusinessPolicyConfig({
    ...base,
    actions: {
      autonomous: ["react", "observe_only"],
      requireApproval: ["reply_publicly"],
      prohibited: ["nurture_candidate"],
    },
    ...overrides,
  } as unknown as BusinessPolicyConfig);
}

describe("E2 policy model", () => {
  it("accepts the conservative default config", () => {
    const config = buildBusinessPolicyConfig(buildDefaultPolicyConfig());
    expect(config.defaultActionDisposition).toBe("require_approval");
    expect(config.actions.autonomous).toEqual([]);
    expect(config.riskDispositions.critical).toBe("ESCALATE");
  });

  it("accepts a valid typed config and freezes it", () => {
    const config = autonomousConfig();
    expect(config.actions.autonomous).toContain("react");
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("rejects unknown action types in disposition lists", () => {
    expect(() =>
      buildBusinessPolicyConfig({
        ...buildDefaultPolicyConfig(),
        actions: { autonomous: ["launch_nukes"], requireApproval: [], prohibited: [] },
      } as unknown as BusinessPolicyConfig)
    ).toThrowError(PolicyModelError);
  });

  it("rejects action types listed in two disposition lists", () => {
    expect(() =>
      buildBusinessPolicyConfig({
        ...buildDefaultPolicyConfig(),
        actions: { autonomous: ["react"], requireApproval: ["react"], prohibited: [] },
      } as unknown as BusinessPolicyConfig)
    ).toThrowError(/more than one disposition list/);
  });

  it("rejects a non-monotone risk disposition mapping (higher risk expanding autonomy)", () => {
    expect(() =>
      buildBusinessPolicyConfig({
        ...buildDefaultPolicyConfig(),
        riskDispositions: {
          low: "REQUIRE_APPROVAL",
          medium: "ALLOW_AUTONOMOUS",
          high: "ESCALATE",
          critical: "ESCALATE",
        },
      } as unknown as BusinessPolicyConfig)
    ).toThrowError(/higher risk can only reduce autonomy/);
  });

  it("rejects critical risk mapped to approval or autonomy", () => {
    expect(() =>
      buildBusinessPolicyConfig({
        ...buildDefaultPolicyConfig(),
        riskDispositions: {
          low: "ALLOW_AUTONOMOUS",
          medium: "REQUIRE_APPROVAL",
          high: "REQUIRE_APPROVAL",
          critical: "REQUIRE_APPROVAL",
        },
      } as unknown as BusinessPolicyConfig)
    ).toThrowError(/riskDispositions.critical/);
  });

  it("rejects an invalid default disposition", () => {
    expect(() =>
      buildBusinessPolicyConfig({
        ...buildDefaultPolicyConfig(),
        defaultActionDisposition: "allow_autonomous",
      } as unknown as BusinessPolicyConfig)
    ).toThrowError(/defaultActionDisposition/);
  });

  it("rejects a platform both allowed and prohibited", () => {
    expect(() =>
      buildBusinessPolicyConfig({
        ...buildDefaultPolicyConfig(),
        allowedPlatforms: ["instagram"],
        prohibitedPlatforms: ["instagram"],
      } as unknown as BusinessPolicyConfig)
    ).toThrowError(/both allowed and prohibited/);
  });

  it("rejects unsupported platforms", () => {
    expect(() =>
      buildBusinessPolicyConfig({
        ...buildDefaultPolicyConfig(),
        prohibitedPlatforms: ["myspace"],
      } as unknown as BusinessPolicyConfig)
    ).toThrowError(/unsupported platform/);
  });

  it("rejects malformed business-hour windows", () => {
    expect(() =>
      buildBusinessPolicyConfig({
        ...buildDefaultPolicyConfig(),
        businessHours: { enabled: true, windows: [{ start: "8am", end: "18:00" }] },
      } as unknown as BusinessPolicyConfig)
    ).toThrowError(/HH:MM/);
  });

  it("rejects non-positive or absurd caps", () => {
    expect(() =>
      buildBusinessPolicyConfig({
        ...buildDefaultPolicyConfig(),
        spend: { maxAutonomousCreditsPerDay: 0, maxActionCredits: 20 },
      } as unknown as BusinessPolicyConfig)
    ).toThrowError(/maxAutonomousCreditsPerDay/);
    expect(() =>
      buildBusinessPolicyConfig({
        ...buildDefaultPolicyConfig(),
        volume: { maxActionsPerDay: 10, maxActionsPerChannelPerDay: -1 },
      } as unknown as BusinessPolicyConfig)
    ).toThrowError(/maxActionsPerChannelPerDay/);
  });

  it("rejects confidence outside [0,1]", () => {
    expect(() =>
      buildBusinessPolicyConfig({
        ...buildDefaultPolicyConfig(),
        minAutonomousConfidence: 1.5,
      } as unknown as BusinessPolicyConfig)
    ).toThrowError(/minAutonomousConfidence/);
  });

  it("produces a deterministic policyId per business", () => {
    expect(buildPolicyId(10)).toBe(buildPolicyId(10));
    expect(buildPolicyId(10)).not.toBe(buildPolicyId(11));
    expect(buildPolicyId(10)).toMatch(/^pol_[0-9a-f]{16}$/);
  });

  it("any config change produces a new policyVersion", () => {
    const config = buildBusinessPolicyConfig(buildDefaultPolicyConfig());
    const v1 = buildPolicyVersion(config, 1);
    const v2 = buildPolicyVersion(config, 2);
    expect(v1).not.toBe(v2);
    const changed = buildBusinessPolicyConfig({
      ...buildDefaultPolicyConfig(),
      volume: { maxActionsPerDay: 51, maxActionsPerChannelPerDay: 20 },
    } as unknown as BusinessPolicyConfig);
    expect(buildPolicyVersion(changed, 1)).not.toBe(v1);
  });

  it("builds a versioned policy with stable identity", () => {
    const policy = buildVersionedPolicy(10, 1, buildBusinessPolicyConfig(buildDefaultPolicyConfig()));
    expect(policy.policyVersion).toMatch(/^v1-[0-9a-f]{12}$/);
    expect(policy.policyId).toBe(buildPolicyId(10));
  });

  it("classifies action disposition ceilings", () => {
    const config = autonomousConfig();
    expect(classifyActionCeiling(config, "react" as MarketingActionType)).toBe("autonomous");
    expect(classifyActionCeiling(config, "reply_publicly")).toBe("require_approval");
    expect(classifyActionCeiling(config, "nurture_candidate")).toBe("prohibited");
    expect(classifyActionCeiling(config, "classify")).toBe("unlisted");
  });
});
