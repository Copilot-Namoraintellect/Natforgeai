import { describe, it, expect } from "vitest";
import {
  assertKnownFields,
  assertScoreBandConsistent,
  DEFAULT_QUALIFICATION_POLICY_VERSION,
  deriveDecisionBindingHash,
  deriveEvidenceSnapshotHash,
  deriveIdentityReference,
  deriveQualificationId,
  deriveReviewId,
  deriveScoreContentHash,
  EvaluateQualificationInputSchema,
  GetQualificationHandoffInputSchema,
  GetQualificationInputSchema,
  isAllowedLeadIdentityVersion,
  isIsoUtc,
  LEAD_QUALIFICATION_CONTRACT_VERSION,
  ListQualificationHistoryInputSchema,
  ListQualificationReviewsInputSchema,
  QUALIFICATION_ENGINE_VERSION,
  QUALIFICATION_ID_PATTERN,
  QualificationError,
  QualificationInputError,
  QualificationOwnershipError,
  QualificationStateConflictError,
  QualificationTamperError,
  QualificationValidationError,
  ResolveQualificationReviewInputSchema,
  REVIEW_ID_PATTERN,
  scoreBandFor,
} from "./qualification-contract";

const H64 = "ab".repeat(32);
const LEAD_ID = `lid1:${H64}`;
const SCORE_ID = `lsc1:${H64}`;
const QUALIFICATION_ID = `lqu1:${H64}`;
const REVIEW_ID = `lqr1:${H64}`;

function qualificationIdInput(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: LEAD_QUALIFICATION_CONTRACT_VERSION,
    userId: 7,
    businessId: 3,
    leadId: LEAD_ID,
    leadIdentityVersion: "lead-identity/v1",
    identityReference: "cd".repeat(32),
    leadScoreId: SCORE_ID,
    scoringVersion: "lead-scoring-engine/v1",
    scoreContentHash: "ef".repeat(32),
    qualificationPolicyVersion: DEFAULT_QUALIFICATION_POLICY_VERSION,
    evidenceSnapshotHash: "12".repeat(32),
    engineVersion: QUALIFICATION_ENGINE_VERSION,
    ...overrides,
  };
}

function identityReferenceInput(overrides: Record<string, unknown> = {}) {
  return {
    leadId: LEAD_ID,
    businessId: 3,
    leadIdentityVersion: "lead-identity/v1",
    identityStatus: "active",
    identityConfidence: "high",
    primaryIdentityType: "email_hash",
    externalActorReferenceHash: null,
    provider: "meta",
    canonicalLeadId: null,
    firstObservedAt: "2026-06-01T10:00:00Z",
    lastObservedAt: "2026-06-28T10:00:00Z",
    provenance: [],
    ...overrides,
  };
}

function scoreContentHashInput(overrides: Record<string, unknown> = {}) {
  return {
    leadScoreId: SCORE_ID,
    scoringVersion: "lead-scoring-engine/v1",
    featureVersion: "lead-scoring-features/v1",
    scoreContractVersion: "lead-scoring/v1",
    leadIdentityVersion: "lead-identity/v1",
    leadId: LEAD_ID,
    businessId: 3,
    overallScore: 75,
    scoreBand: "HIGH",
    scoreConfidence: "HIGH",
    fitScore: 60,
    intentScore: 60,
    engagementScore: 10,
    recencyScore: 80,
    opportunityScore: 20,
    reasonCodes: ["RECENT_EVIDENCE", "CAMPAIGN_ALIGNED"],
    evidenceSnapshotHash: "34".repeat(32),
    evidenceFreshness: { latestObservedAt: "2026-06-28T09:00:00Z", computedAt: "2026-06-28T10:00:00Z" },
    ...overrides,
  };
}

function evidenceSnapshotHashInput(overrides: Record<string, unknown> = {}) {
  return {
    assembledAt: "2026-06-28T10:00:00Z",
    identity: {
      leadId: LEAD_ID,
      leadIdentityVersion: "lead-identity/v1",
      identityReference: "cd".repeat(32),
      identityStatus: "active",
      identityConfidence: "high",
    },
    score: {
      leadScoreId: SCORE_ID,
      scoringVersion: "lead-scoring-engine/v1",
      scoreContentHash: "ef".repeat(32),
      scoreBand: "HIGH",
      scoreConfidence: "HIGH",
    },
    policy: { qualificationPolicyVersion: DEFAULT_QUALIFICATION_POLICY_VERSION },
    entries: [
      { category: "business_fit", status: "present", detail: "FIT_COMPONENT:60" },
      { category: "demonstrated_intent", status: "present", detail: "INTENT_COMPONENT:60" },
    ],
    ...overrides,
  };
}

function decisionBindingHashInput(overrides: Record<string, unknown> = {}) {
  return {
    qualificationId: QUALIFICATION_ID,
    decision: "QUALIFIED",
    reasonCodes: ["POLICY_REQUIREMENTS_MET", "IDENTITY_CURRENT"],
    identityReference: "cd".repeat(32),
    scoreContentHash: "ef".repeat(32),
    evidenceSnapshotHash: "12".repeat(32),
    qualificationPolicyVersion: DEFAULT_QUALIFICATION_POLICY_VERSION,
    engineVersion: QUALIFICATION_ENGINE_VERSION,
    ...overrides,
  };
}

describe("qualification contract — version identities", () => {
  it("exposes the canonical version constants", () => {
    expect(LEAD_QUALIFICATION_CONTRACT_VERSION).toBe("lead-qualification/v1");
    expect(QUALIFICATION_ENGINE_VERSION).toBe("lead-qualification-engine/v1");
    expect(DEFAULT_QUALIFICATION_POLICY_VERSION).toBe("lead-qualification-policy/v1");
  });

  it("accepts canonical and seam identity versions, rejects junk", () => {
    expect(isAllowedLeadIdentityVersion("lead-identity/v1")).toBe(true);
    expect(isAllowedLeadIdentityVersion(`lead-identity-seam/v1:${H64}`)).toBe(true);
    expect(isAllowedLeadIdentityVersion("lead-identity/v2")).toBe(false);
    expect(isAllowedLeadIdentityVersion("lead-identity-seam/v1:zz")).toBe(false);
    expect(isAllowedLeadIdentityVersion("junk")).toBe(false);
  });

  it("validates strict ISO-UTC datetime strings", () => {
    expect(isIsoUtc("2026-06-28T12:00:00Z")).toBe(true);
    expect(isIsoUtc("2026-06-28T12:00:00.123Z")).toBe(true);
    expect(isIsoUtc("2026-06-28T12:00:00.1234Z")).toBe(false);
    expect(isIsoUtc("2026-06-28")).toBe(false);
    expect(isIsoUtc("2026-06-28 12:00:00")).toBe(false);
  });
});

describe("qualification contract — score band helpers", () => {
  it("maps score ranges to bands", () => {
    expect(scoreBandFor(0)).toBe("VERY_LOW");
    expect(scoreBandFor(19.9)).toBe("VERY_LOW");
    expect(scoreBandFor(20)).toBe("LOW");
    expect(scoreBandFor(39)).toBe("LOW");
    expect(scoreBandFor(40)).toBe("MEDIUM");
    expect(scoreBandFor(59)).toBe("MEDIUM");
    expect(scoreBandFor(60)).toBe("HIGH");
    expect(scoreBandFor(79)).toBe("HIGH");
    expect(scoreBandFor(80)).toBe("VERY_HIGH");
    expect(scoreBandFor(100)).toBe("VERY_HIGH");
  });

  it("rejects out-of-range scores", () => {
    expect(() => scoreBandFor(-1)).toThrow(QualificationValidationError);
    expect(() => scoreBandFor(101)).toThrow(QualificationValidationError);
    expect(() => scoreBandFor(Number.NaN)).toThrow(QualificationValidationError);
  });

  it("asserts score/band consistency", () => {
    expect(() => assertScoreBandConsistent(75, "HIGH")).not.toThrow();
    let caught: unknown;
    try {
      assertScoreBandConsistent(75, "LOW");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(QualificationValidationError);
    expect((caught as QualificationValidationError).code).toBe("SCORE_BAND_UNKNOWN");
  });
});

describe("qualification contract — deterministic derivations", () => {
  it("deriveIdentityReference is deterministic and input-sensitive", () => {
    const a = deriveIdentityReference(identityReferenceInput());
    expect(deriveIdentityReference(identityReferenceInput())).toBe(a);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(deriveIdentityReference(identityReferenceInput({ identityStatus: "archived" }))).not.toBe(a);
    expect(deriveIdentityReference(identityReferenceInput({ businessId: null }))).not.toBe(a);
    expect(deriveIdentityReference(identityReferenceInput({ lastObservedAt: "2026-06-29T10:00:00Z" }))).not.toBe(a);
  });

  it("deriveScoreContentHash sorts reason codes and is input-sensitive", () => {
    const a = deriveScoreContentHash(scoreContentHashInput());
    expect(deriveScoreContentHash(scoreContentHashInput())).toBe(a);
    expect(
      deriveScoreContentHash(
        scoreContentHashInput({ reasonCodes: ["CAMPAIGN_ALIGNED", "RECENT_EVIDENCE"] })
      )
    ).toBe(a);
    expect(deriveScoreContentHash(scoreContentHashInput({ overallScore: 76 }))).not.toBe(a);
    expect(
      deriveScoreContentHash(
        scoreContentHashInput({ evidenceFreshness: { latestObservedAt: null, computedAt: "2026-06-28T10:00:00Z" } })
      )
    ).not.toBe(a);
  });

  it("deriveEvidenceSnapshotHash is deterministic and input-sensitive", () => {
    const a = deriveEvidenceSnapshotHash(evidenceSnapshotHashInput());
    expect(deriveEvidenceSnapshotHash(evidenceSnapshotHashInput())).toBe(a);
    expect(
      deriveEvidenceSnapshotHash(
        evidenceSnapshotHashInput({ entries: [{ category: "business_fit", status: "missing", detail: "FIT_COMPONENT:10" }] })
      )
    ).not.toBe(a);
    expect(
      deriveEvidenceSnapshotHash(evidenceSnapshotHashInput({ assembledAt: "2026-06-28T11:00:00Z" }))
    ).not.toBe(a);
  });

  it("deriveQualificationId is deterministic and sensitive to every binding", () => {
    const base = qualificationIdInput();
    const id = deriveQualificationId(base);
    expect(deriveQualificationId(qualificationIdInput())).toBe(id);
    expect(QUALIFICATION_ID_PATTERN.test(id)).toBe(true);
    for (const key of Object.keys(base)) {
      const mutated = { ...base, [key]: key === "userId" ? 8 : key === "businessId" ? null : `${base[key as keyof typeof base]}x` };
      expect(deriveQualificationId(mutated)).not.toBe(id);
    }
  });

  it("deriveDecisionBindingHash is deterministic and decision-sensitive", () => {
    const a = deriveDecisionBindingHash(decisionBindingHashInput());
    expect(deriveDecisionBindingHash(decisionBindingHashInput())).toBe(a);
    expect(deriveDecisionBindingHash(decisionBindingHashInput({ decision: "REVIEW_REQUIRED" }))).not.toBe(a);
    expect(
      deriveDecisionBindingHash(decisionBindingHashInput({ reasonCodes: ["POLICY_REQUIREMENTS_MET"] }))
    ).not.toBe(a);
  });

  it("deriveReviewId is deterministic and pattern-conformant", () => {
    const input = { userId: 7, qualificationId: QUALIFICATION_ID, decisionBindingHash: H64 };
    const id = deriveReviewId(input);
    expect(deriveReviewId(input)).toBe(id);
    expect(REVIEW_ID_PATTERN.test(id)).toBe(true);
    expect(deriveReviewId({ ...input, userId: 8 })).not.toBe(id);
    expect(deriveReviewId({ ...input, qualificationId: `lqu1:${"cd".repeat(32)}` })).not.toBe(id);
  });
});

describe("qualification contract — error taxonomy", () => {
  it("carries stable codes and extends the base class", () => {
    const cases: [QualificationError, string][] = [
      [new QualificationInputError("LEAD_NOT_FOUND", "x"), "LEAD_NOT_FOUND"],
      [new QualificationValidationError("INVALID_SCORE", "x"), "INVALID_SCORE"],
      [new QualificationOwnershipError("OWNERSHIP_MISMATCH", "x"), "OWNERSHIP_MISMATCH"],
      [new QualificationTamperError("SCORE_TAMPERED", "x"), "SCORE_TAMPERED"],
      [new QualificationStateConflictError("POLICY_VERSION_CONFLICT", "x"), "POLICY_VERSION_CONFLICT"],
    ];
    for (const [error, code] of cases) {
      expect(error).toBeInstanceOf(QualificationError);
      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe(code);
      expect(error.message).toBe("x");
    }
    expect(new QualificationValidationError("INVALID_SCORE", "x").name).toBe(
      "QualificationValidationError"
    );
  });
});

describe("qualification contract — router input schemas", () => {
  it("EvaluateQualificationInputSchema accepts valid input", () => {
    expect(
      EvaluateQualificationInputSchema.parse({ leadId: LEAD_ID, leadScoreId: SCORE_ID })
    ).toEqual({ leadId: LEAD_ID, leadScoreId: SCORE_ID });
    expect(
      EvaluateQualificationInputSchema.parse({
        leadId: LEAD_ID,
        leadScoreId: SCORE_ID,
        businessId: 3,
        policyVersion: "lead-qualification-policy/v1",
      }).businessId
    ).toBe(3);
  });

  it("EvaluateQualificationInputSchema rejects client-supplied authority fields", () => {
    expect(() =>
      EvaluateQualificationInputSchema.parse({
        leadId: LEAD_ID,
        leadScoreId: SCORE_ID,
        decision: "QUALIFIED",
      })
    ).toThrow();
    expect(() =>
      EvaluateQualificationInputSchema.parse({
        leadId: LEAD_ID,
        leadScoreId: SCORE_ID,
        reasonCodes: ["POLICY_REQUIREMENTS_MET"],
      })
    ).toThrow();
  });

  it("rejects malformed ids and malformed optional fields", () => {
    expect(() =>
      EvaluateQualificationInputSchema.parse({ leadId: "lid1:zzz", leadScoreId: SCORE_ID })
    ).toThrow();
    expect(() =>
      EvaluateQualificationInputSchema.parse({ leadId: LEAD_ID, leadScoreId: "lsc1:zzz" })
    ).toThrow();
    expect(() =>
      EvaluateQualificationInputSchema.parse({
        leadId: LEAD_ID,
        leadScoreId: SCORE_ID,
        businessId: 1.5,
      })
    ).toThrow();
    expect(() =>
      EvaluateQualificationInputSchema.parse({
        leadId: LEAD_ID,
        leadScoreId: SCORE_ID,
        policyVersion: "",
      })
    ).toThrow();
  });

  it("GetQualificationInputSchema validates qualification ids strictly", () => {
    expect(GetQualificationInputSchema.parse({ qualificationId: QUALIFICATION_ID })).toEqual({
      qualificationId: QUALIFICATION_ID,
    });
    expect(() => GetQualificationInputSchema.parse({ qualificationId: QUALIFICATION_ID, extra: 1 })).toThrow();
    expect(() => GetQualificationInputSchema.parse({ qualificationId: "lqu1:zzz" })).toThrow();
  });

  it("ListQualificationHistoryInputSchema validates lead ids strictly", () => {
    expect(ListQualificationHistoryInputSchema.parse({ leadId: LEAD_ID })).toEqual({ leadId: LEAD_ID });
    expect(() => ListQualificationHistoryInputSchema.parse({ leadId: "nope" })).toThrow();
    expect(() => ListQualificationHistoryInputSchema.parse({ leadId: LEAD_ID, extra: 1 })).toThrow();
  });

  it("ListQualificationReviewsInputSchema validates closed status vocabulary", () => {
    expect(ListQualificationReviewsInputSchema.parse({})).toEqual({});
    expect(ListQualificationReviewsInputSchema.parse({ status: "pending" }).status).toBe("pending");
    expect(ListQualificationReviewsInputSchema.parse({ leadId: LEAD_ID, status: "progress_authorized" }).status).toBe(
      "progress_authorized"
    );
    expect(() => ListQualificationReviewsInputSchema.parse({ status: "nope" })).toThrow();
    expect(() => ListQualificationReviewsInputSchema.parse({ leadId: "junk" })).toThrow();
    expect(() => ListQualificationReviewsInputSchema.parse({ status: "pending", extra: 1 })).toThrow();
  });

  it("ResolveQualificationReviewInputSchema validates outcome and reason", () => {
    const valid = { reviewId: REVIEW_ID, outcome: "progress_authorized", reason: "human override" };
    expect(ResolveQualificationReviewInputSchema.parse(valid).outcome).toBe("progress_authorized");
    expect(() =>
      ResolveQualificationReviewInputSchema.parse({ ...valid, outcome: "approved" })
    ).toThrow();
    expect(() => ResolveQualificationReviewInputSchema.parse({ ...valid, reason: "" })).toThrow();
    expect(() => ResolveQualificationReviewInputSchema.parse({ ...valid, reason: "x".repeat(501) })).toThrow();
    expect(() => ResolveQualificationReviewInputSchema.parse({ ...valid, reviewId: "lqr1:zzz" })).toThrow();
    expect(() => ResolveQualificationReviewInputSchema.parse({ ...valid, actor: "admin" })).toThrow();
  });

  it("GetQualificationHandoffInputSchema validates qualification ids strictly", () => {
    expect(GetQualificationHandoffInputSchema.parse({ qualificationId: QUALIFICATION_ID })).toEqual({
      qualificationId: QUALIFICATION_ID,
    });
    expect(() => GetQualificationHandoffInputSchema.parse({ qualificationId: "lqu1:zzz" })).toThrow();
  });
});

describe("qualification contract — strict-shape discipline", () => {
  it("assertKnownFields rejects extra keys and accepts closed sets", () => {
    expect(() =>
      assertKnownFields({ a: 1, b: 2 }, new Set(["a", "b"]), "LEAD_NOT_FOUND")
    ).not.toThrow();
    expect(() => assertKnownFields({ a: 1, c: 3 }, new Set(["a", "b"]), "LEAD_NOT_FOUND")).toThrow(
      QualificationValidationError
    );
    expect(() => assertKnownFields("nope", new Set(["a"]), "LEAD_NOT_FOUND")).toThrow(
      QualificationInputError
    );
    expect(() => assertKnownFields(null, new Set(["a"]), "LEAD_NOT_FOUND")).toThrow(
      QualificationInputError
    );
  });
});
