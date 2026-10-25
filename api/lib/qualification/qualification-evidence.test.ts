import { describe, it, expect } from "vitest";
import {
  assertAllowedEvidenceCategory,
  assertEvidenceEntry,
  buildEvidenceSnapshot,
  FORBIDDEN_EVIDENCE_CATEGORY_VALUES,
  MAX_EVIDENCE_DETAIL_LENGTH,
} from "./qualification-evidence";
import { deriveEvidenceSnapshotHash } from "./qualification-contract";
import { DEFAULT_QUALIFICATION_POLICY, type QualificationPolicy } from "./qualification-policy";
import type {
  NormalizedIdentityEvidence,
  NormalizedPrivacyState,
  NormalizedScoreEvidence,
  QualificationEvidenceCategory,
} from "./qualification-contract";

const HOUR_MS = 60 * 60 * 1000;
const NOW = new Date("2026-06-28T12:00:00.000Z");
const H64 = "ab".repeat(32);
const LEAD_ID = `lid1:${H64}`;
const SCORE_ID = `lsc1:${H64}`;

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

const PRIVACY_ACTIONABLE: NormalizedPrivacyState = {
  state: "ACTIVE",
  actionable: true,
  blockedReason: null,
};

function build(overrides: {
  identity?: Partial<NormalizedIdentityEvidence>;
  score?: Partial<NormalizedScoreEvidence>;
  policy?: QualificationPolicy;
  privacy?: NormalizedPrivacyState;
  now?: Date;
} = {}) {
  return buildEvidenceSnapshot({
    identity: identity(overrides.identity),
    score: score(overrides.score),
    policy: overrides.policy ?? DEFAULT_QUALIFICATION_POLICY,
    privacy: overrides.privacy ?? PRIVACY_ACTIONABLE,
    now: overrides.now ?? NOW,
  });
}

function entryOf(result: ReturnType<typeof build>, category: QualificationEvidenceCategory) {
  const found = result.entries.find((e) => e.category === category);
  expect(found, `entry ${category} must exist`).toBeDefined();
  return found!;
}

describe("qualification evidence — snapshot assembly", () => {
  it("is deterministic for identical inputs and binds the snapshot hash", () => {
    const a = build();
    const b = build();
    expect(a.snapshotHash).toBe(b.snapshotHash);
    expect(a.snapshot).toEqual(b.snapshot);
    expect(a.snapshotHash).toBe(deriveEvidenceSnapshotHash(a.snapshot));
  });

  it("changes the hash when any evidence input changes", () => {
    const base = build();
    expect(build({ score: { fitScore: 10 } }).snapshotHash).not.toBe(base.snapshotHash);
    expect(build({ identity: { identityStatus: "conflicting" } }).snapshotHash).not.toBe(base.snapshotHash);
    expect(build({ privacy: { state: "SUPPRESSED", actionable: false, blockedReason: "PRIVACY_SUPPRESSED" } }).snapshotHash).not.toBe(
      base.snapshotHash
    );
    expect(build({ policy: { ...DEFAULT_QUALIFICATION_POLICY, policyVersion: "lead-qualification-policy/v2" } as QualificationPolicy }).snapshotHash).not.toBe(
      base.snapshotHash
    );
    expect(build({ now: new Date(NOW.getTime() + HOUR_MS) }).snapshotHash).not.toBe(base.snapshotHash);
  });

  it("emits entries in the fixed category order", () => {
    const { entries } = build();
    expect(entries.map((e) => e.category)).toEqual([
      "identity_validity",
      "lead_score",
      "business_fit",
      "demonstrated_intent",
      "engagement_evidence",
      "recency",
      "source_quality",
      "opportunity_evidence",
      "eligibility_restrictions",
      "privacy_status",
    ]);
  });

  it("derives the default-policy entry matrix", () => {
    const result = build();
    expect(entryOf(result, "identity_validity")).toEqual({
      category: "identity_validity",
      status: "present",
      detail: "IDENTITY_STATUS:active",
    });
    expect(entryOf(result, "lead_score")).toEqual({
      category: "lead_score",
      status: "present",
      detail: "SCORE_BAND:HIGH",
    });
    expect(entryOf(result, "business_fit")).toEqual({
      category: "business_fit",
      status: "present",
      detail: "FIT_COMPONENT:60",
    });
    expect(entryOf(result, "demonstrated_intent")).toEqual({
      category: "demonstrated_intent",
      status: "present",
      detail: "INTENT_COMPONENT:60",
    });
    expect(entryOf(result, "engagement_evidence")).toEqual({
      category: "engagement_evidence",
      status: "present",
      detail: "ENGAGEMENT_COMPONENT:10",
    });
    expect(entryOf(result, "recency")).toEqual({
      category: "recency",
      status: "present",
      detail: `LATEST_OBSERVED_AT:${new Date(NOW.getTime() - HOUR_MS).toISOString()}`,
    });
    expect(entryOf(result, "source_quality")).toEqual({
      category: "source_quality",
      status: "present",
      detail: "SOURCE_QUALITY:SUFFICIENT",
    });
    expect(entryOf(result, "opportunity_evidence")).toEqual({
      category: "opportunity_evidence",
      status: "present",
      detail: "OPPORTUNITY_COMPONENT:20",
    });
    expect(entryOf(result, "eligibility_restrictions")).toEqual({
      category: "eligibility_restrictions",
      status: "present",
      detail: "NO_DISQUALIFIER",
    });
    expect(entryOf(result, "privacy_status")).toEqual({
      category: "privacy_status",
      status: "present",
      detail: "PRIVACY_STATE:ACTIVE",
    });
  });

  it("marks business_fit missing below the policy threshold", () => {
    const result = build({ score: { fitScore: 10 } });
    expect(entryOf(result, "business_fit")).toEqual({
      category: "business_fit",
      status: "missing",
      detail: "FIT_COMPONENT:10",
    });
    expect(entryOf(result, "demonstrated_intent").status).toBe("present");
  });

  it("honours requireEngagementEvidence", () => {
    const policy = { ...DEFAULT_QUALIFICATION_POLICY, requireEngagementEvidence: true };
    const missing = build({ score: { engagementScore: 0 }, policy });
    expect(entryOf(missing, "engagement_evidence")).toEqual({
      category: "engagement_evidence",
      status: "missing",
      detail: "ENGAGEMENT_COMPONENT:0",
    });
    const notRequired = build({ score: { engagementScore: 0 } });
    expect(entryOf(notRequired, "engagement_evidence").status).toBe("not_required");
    const present = build({ score: { engagementScore: 5 }, policy });
    expect(entryOf(present, "engagement_evidence").status).toBe("present");
  });

  it("marks recency stale beyond maximumEvidenceAgeMs or when unobserved", () => {
    const stale = build({ score: { latestObservedAt: new Date(NOW.getTime() - 400 * HOUR_MS).toISOString() } });
    expect(entryOf(stale, "recency").status).toBe("stale");
    expect(entryOf(stale, "recency").detail).toBe(
      `LATEST_OBSERVED_AT:${new Date(NOW.getTime() - 400 * HOUR_MS).toISOString()}`
    );
    const unobserved = build({ score: { latestObservedAt: null } });
    expect(entryOf(unobserved, "recency")).toEqual({
      category: "recency",
      status: "stale",
      detail: "LATEST_OBSERVED_AT:null",
    });
  });

  it("derives source_quality from score reason codes", () => {
    expect(entryOf(build({ score: { reasonCodes: ["CONTRADICTING_EVIDENCE"] } }), "source_quality")).toEqual({
      category: "source_quality",
      status: "contradicted",
      detail: "SOURCE_QUALITY:CONTRADICTING",
    });
    expect(entryOf(build({ score: { reasonCodes: ["SINGLE_EVIDENCE_SOURCE"] } }), "source_quality")).toEqual({
      category: "source_quality",
      status: "missing",
      detail: "SOURCE_QUALITY:SINGLE_SOURCE",
    });
    expect(entryOf(build({ score: { reasonCodes: ["LOW_EVIDENCE_STRENGTH"] } }), "source_quality")).toEqual({
      category: "source_quality",
      status: "missing",
      detail: "SOURCE_QUALITY:LOW_STRENGTH",
    });
  });

  it("blocks eligibility_restrictions on the first policy-listed disqualifier", () => {
    const policy = {
      ...DEFAULT_QUALIFICATION_POLICY,
      disqualifyingScoreReasonCodes: ["CONTRADICTING_EVIDENCE", "UNRESOLVED_COMPLAINT_SIGNAL"],
    };
    const result = build({ score: { reasonCodes: ["UNRESOLVED_COMPLAINT_SIGNAL"] }, policy });
    expect(entryOf(result, "eligibility_restrictions")).toEqual({
      category: "eligibility_restrictions",
      status: "blocked",
      detail: "DISQUALIFIER:UNRESOLVED_COMPLAINT_SIGNAL",
    });
  });

  it("marks identity_validity contradicted for conflicting identities", () => {
    const result = build({ identity: { identityStatus: "conflicting" } });
    expect(entryOf(result, "identity_validity")).toEqual({
      category: "identity_validity",
      status: "contradicted",
      detail: "IDENTITY_STATUS:conflicting",
    });
  });

  it("marks privacy_status blocked when the privacy gate is not actionable", () => {
    const result = build({
      privacy: { state: "SUPPRESSED", actionable: false, blockedReason: "PRIVACY_SUPPRESSED" },
    });
    expect(entryOf(result, "privacy_status")).toEqual({
      category: "privacy_status",
      status: "blocked",
      detail: "PRIVACY_STATE:SUPPRESSED",
    });
  });
});

describe("qualification evidence — boundary checks", () => {
  it("rejects forbidden evidence categories", () => {
    for (const category of ["income", "age", "race", "speculative_demographic_proxy"] as const) {
      let caught: unknown;
      try {
        assertAllowedEvidenceCategory(category);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as { code: string }).code).toBe("FORBIDDEN_EVIDENCE");
    }
    expect(FORBIDDEN_EVIDENCE_CATEGORY_VALUES).toContain("income");
  });

  it("rejects unknown evidence categories with INVALID_REASON_CODE", () => {
    let caught: unknown;
    try {
      assertAllowedEvidenceCategory("random_category");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code: string }).code).toBe("INVALID_REASON_CODE");
  });

  it("accepts closed categories", () => {
    expect(() => assertAllowedEvidenceCategory("business_fit")).not.toThrow();
    expect(() => assertAllowedEvidenceCategory("privacy_status")).not.toThrow();
  });

  it("enforces the detail length bound", () => {
    expect(() =>
      assertEvidenceEntry({ category: "lead_score", status: "present", detail: "x".repeat(64) })
    ).not.toThrow();
    let caught: unknown;
    try {
      assertEvidenceEntry({ category: "lead_score", status: "present", detail: "x".repeat(65) });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code: string }).code).toBe("INVALID_DECISION");
    expect(MAX_EVIDENCE_DETAIL_LENGTH).toBe(64);
  });
});
