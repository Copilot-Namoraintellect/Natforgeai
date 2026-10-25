import { describe, expect, it } from "vitest";
import {
  LEAD_BLOCKER_CLASSES,
  LEAD_BLOCKER_CLASS_POLICY,
  LEAD_RECOVERY_CLASSES,
  isLeadBlockerClass,
  isLeadSystemRetryAllowed,
  leadHealthImpactFor,
  leadRecoveryClassFor,
  mapLeadFailureCodeToBlockerClass,
} from "./lead-blocker-taxonomy";

describe("lead blocker taxonomy (F2)", () => {
  it("exposes a closed 16-class vocabulary", () => {
    expect(LEAD_BLOCKER_CLASSES).toHaveLength(16);
    expect(new Set(LEAD_BLOCKER_CLASSES).size).toBe(16);
    expect(LEAD_RECOVERY_CLASSES).toEqual([
      "AUTO_RECOVER",
      "OPERATOR_ACTION",
      "FAIL_CLOSED",
      "GOVERNANCE_APPROVAL",
    ]);
  });

  it("every blocker class has a normative policy entry", () => {
    for (const cls of LEAD_BLOCKER_CLASSES) {
      const policy = LEAD_BLOCKER_CLASS_POLICY[cls];
      expect(policy, cls).toBeDefined();
      expect(policy.rationale.length, cls).toBeGreaterThan(20);
      expect(LEAD_RECOVERY_CLASSES).toContain(policy.recoveryClass);
      // systemRetryAllowed is true only for AUTO_RECOVER classes.
      expect(policy.systemRetryAllowed, cls).toBe(policy.recoveryClass === "AUTO_RECOVER");
    }
  });

  it("never invents auto-recovery for human-decision classes", () => {
    const humanOnly: (keyof typeof LEAD_BLOCKER_CLASS_POLICY)[] = [
      "IDENTITY_CONFLICT",
      "QUALIFICATION_REQUIRES_REVIEW",
      "QUALIFICATION_BLOCKED",
      "NURTURE_POLICY_BLOCKED",
      "PRIVACY_SUPPRESSED",
      "RETENTION_EXPIRED",
      "CROSS_TENANT_REJECTION",
      "SECURITY_REJECTION",
    ];
    for (const cls of humanOnly) {
      expect(LEAD_BLOCKER_CLASS_POLICY[cls].systemRetryAllowed, cls).toBe(false);
      expect(["OPERATOR_ACTION", "GOVERNANCE_APPROVAL", "FAIL_CLOSED"]).toContain(
        LEAD_BLOCKER_CLASS_POLICY[cls].recoveryClass
      );
    }
  });

  it("security/tenant classes fail closed with fail_closed health impact", () => {
    for (const cls of ["CROSS_TENANT_REJECTION", "SECURITY_REJECTION"] as const) {
      expect(leadRecoveryClassFor(cls)).toBe("FAIL_CLOSED");
      expect(leadHealthImpactFor(cls)).toBe("fail_closed");
    }
  });

  it("transient classes are auto-recoverable", () => {
    for (const cls of ["SCORE_STALE", "SALES_HANDOFF_FAILED", "CRM_UNAVAILABLE", "IDENTITY_INSUFFICIENT_EVIDENCE"] as const) {
      expect(leadRecoveryClassFor(cls), cls).toBe("AUTO_RECOVER");
      expect(isLeadSystemRetryAllowed(cls), cls).toBe(true);
    }
  });

  it("classifies bounded failure codes without guessing", () => {
    expect(mapLeadFailureCodeToBlockerClass("cross_tenant_reference")).toBe("CROSS_TENANT_REJECTION");
    expect(mapLeadFailureCodeToBlockerClass("policy_deny")).toBe("SECURITY_REJECTION");
    expect(mapLeadFailureCodeToBlockerClass("suppressed")).toBe("PRIVACY_SUPPRESSED");
    expect(mapLeadFailureCodeToBlockerClass("score_stale")).toBe("SCORE_STALE");
    expect(mapLeadFailureCodeToBlockerClass("handoff_transport_timeout")).toBe("SALES_HANDOFF_FAILED");
    expect(mapLeadFailureCodeToBlockerClass("totally_unknown_thing")).toBeNull();
    expect(mapLeadFailureCodeToBlockerClass(null)).toBeNull();
    expect(mapLeadFailureCodeToBlockerClass("")).toBeNull();
  });

  it("type guard accepts only closed vocabulary", () => {
    expect(isLeadBlockerClass("PRIVACY_SUPPRESSED")).toBe(true);
    expect(isLeadBlockerClass("FORCE_MERGE")).toBe(false);
    expect(isLeadBlockerClass("score_stale")).toBe(false);
  });
});
