// WBS-R6-D — policy model acceptance (contract §6, §13; default policy).
import { describe, it, expect } from "vitest";
import {
  buildDefaultNurturePolicyConfig,
  buildNurtureHandoffPolicy,
  NurtureHandoffPolicyConfigSchema,
  NURTURE_POLICY_CONTRACT_VERSION,
  derivePolicyVersion,
  hashNurturePolicyConfig,
  isChannelAllowed,
  doesChannelRequireApproval,
  deriveDecisionValidity,
} from "./nurture-policy";

describe("default policy", () => {
  it("is valid, deterministic, and conservative", () => {
    const a = buildDefaultNurturePolicyConfig();
    const b = buildDefaultNurturePolicyConfig();
    expect(a).toEqual(b);
    expect(a.stopOnAuthoritativeConversion).toBe(true);
    expect(a.handoffRequiresApproval).toBe(true);
    expect(a.channelsRequiringApproval).toContain("sms");
    expect(a.nurtureCadence.minIntervalHours).toBeGreaterThan(0);
    expect(NurtureHandoffPolicyConfigSchema.parse(a)).toEqual(a);
  });

  it("default config hashes to the contract version itself", () => {
    const policy = buildNurtureHandoffPolicy(buildDefaultNurturePolicyConfig());
    expect(policy.policyVersion).toBe(NURTURE_POLICY_CONTRACT_VERSION);
    expect(policy.configHash).toBe(hashNurturePolicyConfig(buildDefaultNurturePolicyConfig()));
  });

  it("any config change produces a visibly different version", () => {
    const modified = buildNurtureHandoffPolicy({
      ...buildDefaultNurturePolicyConfig(),
      decisionTtlHours: 48,
    });
    expect(modified.policyVersion).not.toBe(NURTURE_POLICY_CONTRACT_VERSION);
    expect(modified.policyVersion.startsWith(`${NURTURE_POLICY_CONTRACT_VERSION}+`)).toBe(true);
    expect(derivePolicyVersion(modified.config, modified.configHash)).toBe(modified.policyVersion);
  });

  it("rejects out-of-bounds config", () => {
    expect(() =>
      NurtureHandoffPolicyConfigSchema.parse({
        ...buildDefaultNurturePolicyConfig(),
        allowedChannels: ["smoke-signal"],
      })
    ).toThrow();
    expect(() =>
      NurtureHandoffPolicyConfigSchema.parse({
        ...buildDefaultNurturePolicyConfig(),
        nurtureCadence: { minIntervalHours: -1, windowDays: 30, maxTouchesPerWindow: 4 },
      })
    ).toThrow();
  });
});

describe("policy helpers", () => {
  const policy = buildNurtureHandoffPolicy(buildDefaultNurturePolicyConfig());

  it("channel allow-list and approval escalation", () => {
    expect(isChannelAllowed(policy, "email")).toBe(true);
    expect(doesChannelRequireApproval(policy, "sms")).toBe(true);
    expect(doesChannelRequireApproval(policy, "email")).toBe(false);
  });

  it("decision validity derives from TTL", () => {
    const now = new Date("2026-06-28T12:00:00.000Z");
    expect(deriveDecisionValidity(policy, now)).toBe("2026-06-29T12:00:00.000Z");
  });
});
