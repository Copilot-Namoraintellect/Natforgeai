import { describe, it, expect } from "vitest";
import {
  assertQualificationPolicy,
  DEFAULT_QUALIFICATION_POLICY,
  getQualificationPolicy,
  listQualificationPolicies,
  registerQualificationPolicy,
  type QualificationPolicy,
} from "./qualification-policy";
import {
  QualificationInputError,
  QualificationStateConflictError,
  QualificationValidationError,
} from "./qualification-contract";

function policyV2(overrides: Partial<QualificationPolicy> = {}): QualificationPolicy {
  return {
    ...DEFAULT_QUALIFICATION_POLICY,
    policyVersion: "lead-qualification-policy/v2",
    minimumConfidence: 5000,
    ...overrides,
  };
}

describe("qualification policy — default artefact", () => {
  it("passes validation", () => {
    expect(() => assertQualificationPolicy(DEFAULT_QUALIFICATION_POLICY)).not.toThrow();
  });

  it("carries the conservative defaults", () => {
    expect(DEFAULT_QUALIFICATION_POLICY.policyVersion).toBe("lead-qualification-policy/v1");
    expect(DEFAULT_QUALIFICATION_POLICY.minimumScoreBand).toBe("HIGH");
    expect(DEFAULT_QUALIFICATION_POLICY.minimumScoreConfidence).toBe("LOW");
    expect(DEFAULT_QUALIFICATION_POLICY.fitEvidenceThreshold).toBe(40);
    expect(DEFAULT_QUALIFICATION_POLICY.intentEvidenceThreshold).toBe(40);
    expect(DEFAULT_QUALIFICATION_POLICY.engagementEvidenceThreshold).toBe(0);
    expect(DEFAULT_QUALIFICATION_POLICY.requireEngagementEvidence).toBe(false);
    expect(DEFAULT_QUALIFICATION_POLICY.maximumEvidenceAgeMs).toBe(336 * 60 * 60 * 1000);
    expect(DEFAULT_QUALIFICATION_POLICY.staleIdentityMs).toBe(336 * 60 * 60 * 1000);
    expect(DEFAULT_QUALIFICATION_POLICY.validityMs).toBe(168 * 60 * 60 * 1000);
    expect(DEFAULT_QUALIFICATION_POLICY.disqualifyingScoreReasonCodes).toEqual([
      "UNRESOLVED_COMPLAINT_SIGNAL",
    ]);
    expect(DEFAULT_QUALIFICATION_POLICY.reviewTriggerReasonCodes).toEqual(["CONTRADICTING_EVIDENCE"]);
    expect(DEFAULT_QUALIFICATION_POLICY.minimumConfidence).toBe(4000);
    expect(DEFAULT_QUALIFICATION_POLICY.minimumIdentityConfidenceForAutonomy).toBe("low");
  });

  it("resolves undefined to the default and the default version explicitly", () => {
    expect(getQualificationPolicy()).toBe(DEFAULT_QUALIFICATION_POLICY);
    expect(getQualificationPolicy("lead-qualification-policy/v1")).toBe(DEFAULT_QUALIFICATION_POLICY);
  });
});

describe("qualification policy — registry", () => {
  it("registers and resolves a new policy version", () => {
    const policy = policyV2();
    registerQualificationPolicy(policy);
    expect(getQualificationPolicy("lead-qualification-policy/v2")).toEqual(policy);
    expect(
      listQualificationPolicies().some((p) => p.policyVersion === "lead-qualification-policy/v2")
    ).toBe(true);
  });

  it("registration is idempotent for identical content", () => {
    registerQualificationPolicy(policyV2());
    expect(() => registerQualificationPolicy(policyV2())).not.toThrow();
    expect(getQualificationPolicy("lead-qualification-policy/v2")).toEqual(policyV2());
  });

  it("rejects same-version different content with POLICY_VERSION_CONFLICT", () => {
    registerQualificationPolicy(policyV2());
    let caught: unknown;
    try {
      registerQualificationPolicy(policyV2({ minimumConfidence: 6000 }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(QualificationStateConflictError);
    expect((caught as QualificationStateConflictError).code).toBe("POLICY_VERSION_CONFLICT");
  });

  it("rejects unknown versions with UNKNOWN_POLICY_VERSION", () => {
    let caught: unknown;
    try {
      getQualificationPolicy("lead-qualification-policy/v99");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(QualificationInputError);
    expect((caught as QualificationInputError).code).toBe("UNKNOWN_POLICY_VERSION");
  });

  it("lists the default first", () => {
    expect(listQualificationPolicies()[0]).toBe(DEFAULT_QUALIFICATION_POLICY);
  });
});

describe("qualification policy — validation", () => {
  it("rejects out-of-range component thresholds", () => {
    for (const threshold of ["fitEvidenceThreshold", "intentEvidenceThreshold", "engagementEvidenceThreshold"] as const) {
      let caught: unknown;
      try {
        assertQualificationPolicy({ ...policyV2(), [threshold]: 101 });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(QualificationValidationError);
      expect((caught as QualificationValidationError).code).toBe("INVALID_POLICY");
    }
  });

  it("rejects out-of-range minimumConfidence", () => {
    for (const minimumConfidence of [-1, 10001, 4000.5]) {
      let caught: unknown;
      try {
        assertQualificationPolicy({ ...policyV2(), minimumConfidence });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(QualificationValidationError);
      expect((caught as QualificationValidationError).code).toBe("INVALID_POLICY");
    }
  });

  it("rejects non-positive ms windows", () => {
    for (const key of ["maximumEvidenceAgeMs", "staleIdentityMs", "validityMs"] as const) {
      let caught: unknown;
      try {
        assertQualificationPolicy({ ...policyV2(), [key]: 0 });
      } catch (error) {
        caught = error;
      }
      expect((caught as QualificationValidationError).code).toBe("INVALID_POLICY");
    }
  });

  it("rejects malformed policy versions", () => {
    for (const policyVersion of ["Bad Version", "lead-qualification-policy", "lead-qualification-policy/vx", "x".repeat(97)]) {
      let caught: unknown;
      try {
        assertQualificationPolicy({ ...policyV2(), policyVersion });
      } catch (error) {
        caught = error;
      }
      expect((caught as QualificationValidationError).code).toBe("INVALID_POLICY");
    }
  });

  it("rejects reason codes outside the closed score-reason vocabulary", () => {
    for (const key of ["disqualifyingScoreReasonCodes", "reviewTriggerReasonCodes"] as const) {
      let caught: unknown;
      try {
        assertQualificationPolicy({ ...policyV2(), [key]: ["NOT_A_SCORE_CODE"] });
      } catch (error) {
        caught = error;
      }
      expect((caught as QualificationValidationError).code).toBe("INVALID_POLICY");
    }
  });

  it("accepts closed score-reason codes", () => {
    expect(() =>
      assertQualificationPolicy({
        ...policyV2(),
        disqualifyingScoreReasonCodes: ["UNRESOLVED_COMPLAINT_SIGNAL", "COMPLAINT_ONLY_EVIDENCE"],
        reviewTriggerReasonCodes: ["CONTRADICTING_EVIDENCE", "SINGLE_EVIDENCE_SOURCE"],
      })
    ).not.toThrow();
  });

  it("rejects invalid closed-set members", () => {
    for (const override of [
      { minimumScoreBand: "SUPER_HIGH" },
      { minimumScoreConfidence: "CERTAIN" },
      { minimumIdentityConfidenceForAutonomy: "superhuman" },
    ] as Record<string, unknown>[]) {
      let caught: unknown;
      try {
        assertQualificationPolicy({ ...policyV2(), ...override } as QualificationPolicy);
      } catch (error) {
        caught = error;
      }
      expect((caught as QualificationValidationError).code).toBe("INVALID_POLICY");
    }
  });
});
