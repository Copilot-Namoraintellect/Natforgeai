// ─── R5-X5 acceptance — integrated provider capability + eligibility rule ───
//
// Proves the one truthful integrated capability view and the four-leg
// eligibility rule:
//   policy allows AND transport supports AND binding valid AND transport
//   enabled → eligible; every other combination fails closed.
//
// Focus: mismatches between POLICY-side capability (R5-E action vocabulary /
// policy config) and REAL transport capability (R5-C seams). The execution-
// level enforcement of the transport gate lives in the C stream (r5-c
// acceptance C9.22: capability assert + planning both fail closed with zero
// external attempts); these tests lock the composed rule and the matrix so
// the two can never drift apart.

import { describe, it, expect } from "vitest";
import {
  describeListeningCapability,
  describeEngagementExecutionCapability,
  isListeningSupported,
  isEngagementExecutionSupported,
  evaluateEngagementEligibility,
} from "./lib/engagement/provider-capability-matrix";
import { MARKETING_ACTION_TYPES, requiresProviderCapability } from "./lib/policy/action-request";
import {
  ENGAGEMENT_PROVIDER_CAPABILITIES,
  assertEngagementCapabilitySupported,
} from "./lib/engagement/provider-boundary";

describe("R5-X5 listening capability view (derived from R5-A)", () => {
  it("Meta webhook listening is supported on facebook/instagram/whatsapp", () => {
    for (const platform of ["facebook", "instagram", "whatsapp"]) {
      const resolved = describeListeningCapability("meta", platform);
      expect(resolved.kind).toBe("supported");
      if (resolved.kind === "supported") {
        expect(resolved.capability.webhook).toBe("supported");
      }
    }
  });

  it("LinkedIn exposes a polling seam only (no webhook verifier)", () => {
    const resolved = describeListeningCapability("linkedin", "linkedin");
    expect(resolved.kind).toBe("supported");
    if (resolved.kind === "supported") {
      expect(resolved.capability.webhook).toBe("unsupported");
      expect(resolved.capability.polling).toBe("supported");
    }
  });

  it("Twitter/TikTok have no listening adapter and report unsupported", () => {
    expect(isListeningSupported("twitter", "twitter")).toBe(false);
    expect(isListeningSupported("tiktok", "tiktok")).toBe(false);
    const tw = describeListeningCapability("twitter", "twitter");
    expect(tw.kind).toBe("unsupported");
  });
});

describe("R5-X5 engagement execution capability view (derived from R5-C)", () => {
  it("public reply has a transport seam on facebook and instagram only", () => {
    expect(describeEngagementExecutionCapability("reply_publicly", "facebook")?.transportId).toBe(
      "meta_comment_reply"
    );
    expect(describeEngagementExecutionCapability("reply_publicly", "instagram")?.transportId).toBe(
      "meta_comment_reply"
    );
    for (const platform of ["linkedin", "twitter", "tiktok", "whatsapp"]) {
      expect(describeEngagementExecutionCapability("reply_publicly", platform)).toBeNull();
    }
  });

  it("reactions and private messages have no transport seam", () => {
    for (const actionType of ["react", "reply_privately"]) {
      for (const platform of ["facebook", "instagram", "linkedin"]) {
        expect(describeEngagementExecutionCapability(actionType, platform)).toBeNull();
      }
    }
  });
});

describe("R5-X5 policy-side vocabulary is NOT a capability source", () => {
  it("governed provider-action types exist in the policy vocabulary", () => {
    for (const actionType of ["react", "reply_privately", "nurture_candidate"] as const) {
      expect(MARKETING_ACTION_TYPES).toContain(actionType);
      // Policy marks them as requiring provider capability — governance only.
      expect(requiresProviderCapability(actionType)).toBe(true);
    }
  });

  it("policy-side existence without a transport seam is ineligible (the mismatch)", () => {
    for (const actionType of ["react", "reply_privately", "nurture_candidate"]) {
      const verdict = evaluateEngagementEligibility({
        policyAllows: true, // policy-side would permit it
        actionType,
        platform: "facebook",
        bindingVerified: true,
        transportEnabled: true,
      });
      expect(verdict).toEqual({ eligible: false, reason: "TRANSPORT_UNSUPPORTED" });
    }
    // Transport matrix agrees (C9.22 proves the execution-level gate too).
    expect(() => assertEngagementCapabilitySupported({ actionType: "react", platform: "facebook" })).toThrow(
      /UNSUPPORTED_PROVIDER_CAPABILITY/
    );
  });

  it("the transport matrix is exactly the two real seams — nothing faked", () => {
    expect(ENGAGEMENT_PROVIDER_CAPABILITIES).toHaveLength(2);
  });
});

describe("R5-X5 four-leg eligibility rule", () => {
  const base = {
    policyAllows: true,
    actionType: "reply_publicly",
    platform: "facebook",
    bindingVerified: true,
    transportEnabled: true,
  };

  it("all four legs → eligible", () => {
    expect(evaluateEngagementEligibility(base)).toEqual({ eligible: true });
  });

  it("policy DENY is never eligible", () => {
    expect(evaluateEngagementEligibility({ ...base, policyAllows: false })).toEqual({
      eligible: false,
      reason: "POLICY_NOT_ALLOWED",
    });
  });

  it("policy ESCALATE-style (not allowed) is never eligible", () => {
    // ESCALATE reaches the same gate as DENY: policyAllows=false.
    expect(evaluateEngagementEligibility({ ...base, policyAllows: false }).eligible).toBe(false);
  });

  it("unsupported platform is ineligible even when policy allows", () => {
    expect(evaluateEngagementEligibility({ ...base, platform: "linkedin" })).toEqual({
      eligible: false,
      reason: "TRANSPORT_UNSUPPORTED",
    });
  });

  it("invalid binding is ineligible", () => {
    expect(evaluateEngagementEligibility({ ...base, bindingVerified: false })).toEqual({
      eligible: false,
      reason: "BINDING_INVALID",
    });
  });

  it("transport not operator-enabled is ineligible", () => {
    expect(evaluateEngagementEligibility({ ...base, transportEnabled: false })).toEqual({
      eligible: false,
      reason: "TRANSPORT_DISABLED",
    });
  });

  it("first failing leg wins in policy→capability→binding→transport order", () => {
    const reasonFor = (input: Parameters<typeof evaluateEngagementEligibility>[0]) => {
      const verdict = evaluateEngagementEligibility(input);
      expect(verdict.eligible).toBe(false);
      return verdict.eligible ? null : verdict.reason;
    };
    expect(reasonFor({ ...base, policyAllows: false, platform: "linkedin" })).toBe("POLICY_NOT_ALLOWED");
    expect(reasonFor({ ...base, platform: "linkedin", bindingVerified: false })).toBe("TRANSPORT_UNSUPPORTED");
    expect(reasonFor({ ...base, bindingVerified: false, transportEnabled: false })).toBe("BINDING_INVALID");
  });
});
