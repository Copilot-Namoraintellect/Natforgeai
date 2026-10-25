import { describe, it, expect } from "vitest";
import { evaluateQualification, isIdentityActionableStatus } from "./qualification-engine";
import { buildEvidenceSnapshot } from "./qualification-evidence";
import {
  DEFAULT_QUALIFICATION_POLICY,
  type QualificationPolicy,
} from "./qualification-policy";
import {
  QUALIFICATION_REASON_CODE_VALUES,
  type NormalizedIdentityEvidence,
  type NormalizedPrivacyState,
  type NormalizedScoreEvidence,
} from "./qualification-contract";

const HOUR_MS = 60 * 60 * 1000;
const NOW = new Date("2026-06-28T12:00:00.000Z");
const H64 = "ab".repeat(32);
const LEAD_ID = `lid1:${H64}`;
const SCORE_ID = `lsc1:${H64}`;

const PRIVACY_ACTIONABLE: NormalizedPrivacyState = {
  state: "ACTIVE",
  actionable: true,
  blockedReason: null,
};

function identity(overrides: Partial<NormalizedIdentityEvidence> = {}): NormalizedIdentityEvidence {
  return {
    leadId: LEAD_ID,
    businessId: 3,
    leadIdentityVersion: "lead-identity/v1",
    identityStatus: "active",
    identityConfidence: "high",
    lastObservedAt: new Date(NOW.getTime() - HOUR_MS).toISOString(),
    identityReference: "cd".repeat(32),
    ...overrides,
  };
}

function score(overrides: Partial<NormalizedScoreEvidence> = {}): NormalizedScoreEvidence {
  return {
    leadScoreId: SCORE_ID,
    scoringVersion: "lead-scoring-engine/v1",
    scoreContentHash: "ef".repeat(32),
    overallScore: 75,
    scoreBand: "HIGH",
    scoreConfidence: "HIGH",
    fitScore: 60,
    intentScore: 60,
    engagementScore: 10,
    recencyScore: 80,
    opportunityScore: 20,
    reasonCodes: [],
    latestObservedAt: new Date(NOW.getTime() - HOUR_MS).toISOString(),
    computedAt: NOW.toISOString(),
    ...overrides,
  };
}

function evaluate(overrides: {
  identity?: Partial<NormalizedIdentityEvidence>;
  score?: Partial<NormalizedScoreEvidence>;
  policy?: QualificationPolicy;
  privacy?: NormalizedPrivacyState;
} = {}) {
  const resolvedIdentity = identity(overrides.identity);
  const resolvedScore = score(overrides.score);
  const policy = overrides.policy ?? DEFAULT_QUALIFICATION_POLICY;
  const privacy = overrides.privacy ?? PRIVACY_ACTIONABLE;
  const { entries } = buildEvidenceSnapshot({
    identity: resolvedIdentity,
    score: resolvedScore,
    policy,
    privacy,
    now: NOW,
  });
  return evaluateQualification({
    identity: resolvedIdentity,
    score: resolvedScore,
    policy,
    entries,
    privacy,
    now: NOW,
  });
}

describe("qualification engine — decision matrix", () => {
  it("qualified happy path: sufficient evidence and policy authorization", () => {
    const result = evaluate();
    expect(result.decision).toBe("QUALIFIED");
    expect(result.reviewRequired).toBe(false);
    expect(result.confidenceScore).toBe(10000);
    expect(result.reasonCodes).toEqual([
      "POLICY_REQUIREMENTS_MET",
      "IDENTITY_CURRENT",
      "SCORE_BAND_SUFFICIENT",
      "FIT_EVIDENCE_PRESENT",
      "INTENT_EVIDENCE_PRESENT",
      "RECENCY_WITHIN_POLICY",
      "CONFIDENCE_SUFFICIENT",
    ]);
  });

  it("score alone cannot qualify: high score without fit/intent evidence", () => {
    const result = evaluate({
      score: { overallScore: 95, scoreBand: "VERY_HIGH", fitScore: 0, intentScore: 0 },
    });
    expect(result.decision).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.reviewRequired).toBe(false);
    expect(result.reasonCodes).toContain("MISSING_FIT_EVIDENCE");
    expect(result.reasonCodes).toContain("MISSING_INTENT_EVIDENCE");
    expect(result.reasonCodes).toContain("IDENTITY_CURRENT");
    expect(result.reasonCodes).not.toContain("SCORE_BAND_SUFFICIENT");
  });

  it("missing fit evidence only", () => {
    const result = evaluate({ score: { fitScore: 0, overallScore: 60, scoreBand: "HIGH" } });
    expect(result.decision).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.reasonCodes).toContain("MISSING_FIT_EVIDENCE");
    expect(result.reasonCodes).not.toContain("MISSING_INTENT_EVIDENCE");
  });

  it("disqualifier blocks progression", () => {
    const result = evaluate({ score: { reasonCodes: ["UNRESOLVED_COMPLAINT_SIGNAL"] } });
    expect(result.decision).toBe("NOT_QUALIFIED");
    expect(result.reasonCodes).toEqual(["DISQUALIFYING_EVIDENCE"]);
  });

  it("score band below the policy floor", () => {
    const result = evaluate({ score: { overallScore: 50, scoreBand: "MEDIUM" } });
    expect(result.decision).toBe("NOT_QUALIFIED");
    expect(result.reasonCodes).toEqual(["SCORE_BELOW_THRESHOLD"]);
  });

  it("policy review trigger forces review", () => {
    const result = evaluate({ score: { reasonCodes: ["CONTRADICTING_EVIDENCE"] } });
    expect(result.decision).toBe("REVIEW_REQUIRED");
    expect(result.reviewRequired).toBe(true);
    expect(result.reasonCodes).toEqual(["REVIEW_TRIGGERED_BY_POLICY", "CONTRADICTING_EVIDENCE"]);
  });

  it("unknown score confidence forces review", () => {
    const result = evaluate({ score: { scoreConfidence: "UNKNOWN" } });
    expect(result.decision).toBe("REVIEW_REQUIRED");
    expect(result.reasonCodes).toContain("LOW_SCORE_CONFIDENCE");
    expect(result.reasonCodes).not.toContain("REVIEW_TRIGGERED_BY_POLICY");
  });

  it("unknown identity confidence below the autonomy floor forces review", () => {
    const result = evaluate({ identity: { identityConfidence: "unknown" } });
    expect(result.decision).toBe("REVIEW_REQUIRED");
    expect(result.reasonCodes).toEqual(["IDENTITY_CONFIDENCE_UNKNOWN"]);
  });

  it("suppressed privacy state blocks evaluation", () => {
    const result = evaluate({
      privacy: { state: "SUPPRESSED", actionable: false, blockedReason: "PRIVACY_SUPPRESSED" },
    });
    expect(result.decision).toBe("BLOCKED");
    expect(result.reasonCodes).toEqual(["PRIVACY_SUPPRESSED"]);
  });

  it("expired retention blocks evaluation", () => {
    const result = evaluate({
      privacy: { state: "RETENTION_EXPIRED", actionable: false, blockedReason: "RETENTION_EXPIRED" },
    });
    expect(result.decision).toBe("BLOCKED");
    expect(result.reasonCodes).toEqual(["RETENTION_EXPIRED"]);
  });

  it("non-actionable identity statuses block evaluation", () => {
    for (const identityStatus of ["archived", "conflicting", "suppressed"] as const) {
      const result = evaluate({ identity: { identityStatus } });
      expect(result.decision).toBe("BLOCKED");
      expect(result.reasonCodes).toEqual(["IDENTITY_NOT_ACTIONABLE"]);
    }
  });

  it("confidence below the policy floor forces review", () => {
    const policy: QualificationPolicy = {
      ...DEFAULT_QUALIFICATION_POLICY,
      policyVersion: "lead-qualification-policy/v2",
      minimumConfidence: 9500,
    };
    const result = evaluate({
      identity: { identityConfidence: "low" },
      score: { scoreConfidence: "LOW" },
      policy,
    });
    expect(result.decision).toBe("REVIEW_REQUIRED");
    expect(result.reasonCodes).toEqual(["CONFIDENCE_BELOW_THRESHOLD"]);
    expect(result.confidenceScore).toBeLessThan(9500);
  });
});

describe("qualification engine — invariants", () => {
  it("is deterministic: identical inputs produce deep-equal results", () => {
    const a = evaluate();
    const b = evaluate();
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("keeps every emitted reason code inside the closed vocabulary, ≤ 8", () => {
    const allowed = new Set<string>(QUALIFICATION_REASON_CODE_VALUES);
    const cases = [
      evaluate(),
      evaluate({ score: { fitScore: 0, overallScore: 95, scoreBand: "VERY_HIGH" } }),
      evaluate({ score: { reasonCodes: ["CONTRADICTING_EVIDENCE"] } }),
      evaluate({ score: { scoreConfidence: "UNKNOWN" }, identity: { identityConfidence: "unknown" } }),
      evaluate({
        privacy: { state: "SUPPRESSED", actionable: false, blockedReason: "PRIVACY_SUPPRESSED" },
      }),
      evaluate({ score: { reasonCodes: ["UNRESOLVED_COMPLAINT_SIGNAL"] } }),
    ];
    for (const result of cases) {
      expect(result.reasonCodes.length).toBeLessThanOrEqual(8);
      for (const code of result.reasonCodes) {
        expect(allowed.has(code)).toBe(true);
      }
      expect(result.confidenceScore).toBeGreaterThanOrEqual(0);
      expect(result.confidenceScore).toBeLessThanOrEqual(10000);
      expect(Number.isInteger(result.confidenceScore)).toBe(true);
    }
  });

  it("reviewRequired is derived solely from the decision", () => {
    expect(evaluate().reviewRequired).toBe(false);
    expect(evaluate({ score: { scoreConfidence: "UNKNOWN" } }).reviewRequired).toBe(true);
    expect(evaluate({ identity: { identityStatus: "archived" } }).reviewRequired).toBe(false);
  });
});

describe("qualification engine — identity actionability helper", () => {
  it("classifies actionable and non-actionable identity statuses", () => {
    expect(isIdentityActionableStatus("active")).toBe(true);
    expect(isIdentityActionableStatus("resolved")).toBe(true);
    expect(isIdentityActionableStatus("merged")).toBe(true);
    expect(isIdentityActionableStatus("archived")).toBe(false);
    expect(isIdentityActionableStatus("conflicting")).toBe(false);
    expect(isIdentityActionableStatus("suppressed")).toBe(false);
  });
});
