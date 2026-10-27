import { describe, expect, it } from "vitest";
import { validateScorePayload } from "./qualification-scoring-seam";
import { deriveScoreContentHash } from "./qualification-contract";

const H64 = "ab".repeat(32);
const G64 = "cd".repeat(32);
const LEAD_ID = `lid1:${H64}`;
const OTHER_LEAD_ID = `lid1:${G64}`;
const SCORE_ID = `lsc1:${H64}`;
const SNAPSHOT_ID = `lss1:${G64}`;
const NOW = "2026-06-28T12:00:00.000Z";
const FRESH = "2026-06-28T10:00:00.000Z";

function baseScore(): Record<string, unknown> {
  return {
    leadScoreId: SCORE_ID,
    leadId: LEAD_ID,
    leadIdentityVersion: "lead-identity/v1",
    scoringVersion: "lead-scoring-engine/v1",
    featureVersion: "lead-scoring-features/v1",
    scoreContractVersion: "lead-scoring/v1",
    evidenceSnapshotId: SNAPSHOT_ID,
    evidenceSnapshotHash: G64,
    overallScore: 75,
    scoreBand: "HIGH",
    scoreConfidence: "HIGH",
    fitScore: 60,
    intentScore: 60,
    engagementScore: 10,
    recencyScore: 80,
    opportunityScore: 20,
    componentWeights: { fit: 0.2, intent: 0.2, engagement: 0.2, recency: 0.2, opportunity: 0.2 },
    reasonCodes: ["CAMPAIGN_ALIGNED", "RECENT_EVIDENCE"],
    evidenceFreshness: { latestObservedAt: FRESH, computedAt: NOW },
    computedAt: NOW,
    createdAt: NOW,
    businessId: 3,
    userId: 7,
    duplicateClassification: "none",
  };
}

function contentHashOf(payload: Record<string, unknown>): string {
  return deriveScoreContentHash({
    leadScoreId: payload.leadScoreId as string,
    scoringVersion: payload.scoringVersion as string,
    featureVersion: payload.featureVersion as string,
    scoreContractVersion: payload.scoreContractVersion as string,
    leadIdentityVersion: payload.leadIdentityVersion as string,
    leadId: payload.leadId as string,
    businessId: payload.businessId as number | null,
    overallScore: payload.overallScore as number,
    scoreBand: payload.scoreBand as string,
    scoreConfidence: payload.scoreConfidence as string,
    fitScore: payload.fitScore as number,
    intentScore: payload.intentScore as number,
    engagementScore: payload.engagementScore as number,
    recencyScore: payload.recencyScore as number,
    opportunityScore: payload.opportunityScore as number,
    reasonCodes: [...(payload.reasonCodes as string[])].sort(),
    evidenceSnapshotHash: payload.evidenceSnapshotHash as string,
    evidenceFreshness: payload.evidenceFreshness as {
      latestObservedAt: string | null;
      computedAt: string;
    },
  });
}

/** Valid fixture; recomputes the tamper-guard hash after applying overrides. */
function scoreFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const merged = { ...baseScore(), ...overrides };
  if (!("scoreContentHash" in overrides)) {
    merged.scoreContentHash = contentHashOf(merged);
  }
  return merged;
}

describe("validateScorePayload — round trip", () => {
  it("accepts a valid payload and exposes the recomputed content binding", () => {
    const payload = scoreFixture();
    const evidence = validateScorePayload(payload);
    expect(evidence.leadScoreId).toBe(SCORE_ID);
    expect(evidence.scoringVersion).toBe("lead-scoring-engine/v1");
    expect(evidence.overallScore).toBe(75);
    expect(evidence.scoreBand).toBe("HIGH");
    expect(evidence.scoreConfidence).toBe("HIGH");
    expect(evidence.scoreContentHash).toBe(contentHashOf(payload));
    expect(evidence.reasonCodes).toEqual(["CAMPAIGN_ALIGNED", "RECENT_EVIDENCE"]);
    expect(evidence.latestObservedAt).toBe(FRESH);
    expect(evidence.computedAt).toBe(NOW);
    expect(evidence.leadId).toBe(LEAD_ID);
    expect(evidence.businessId).toBe(3);
    expect(evidence.userId).toBe(7);
    expect(evidence.leadIdentityVersion).toBe("lead-identity/v1");
  });

  it("sorts reasonCodes ascending regardless of wire order", () => {
    const evidence = validateScorePayload(
      scoreFixture({ reasonCodes: ["RECENT_EVIDENCE", "CAMPAIGN_ALIGNED"] })
    );
    expect(evidence.reasonCodes).toEqual(["CAMPAIGN_ALIGNED", "RECENT_EVIDENCE"]);
  });

  it("adopts the recomputed hash when the guard is absent and accepts a correct guard", () => {
    const { scoreContentHash: _guard, ...unguarded } = scoreFixture();
    const evidence = validateScorePayload(unguarded);
    expect(evidence.scoreContentHash).toBe(contentHashOf(scoreFixture()));
    expect(validateScorePayload(scoreFixture()).scoreContentHash).toBe(evidence.scoreContentHash);
  });

  it("allows null businessId and null latestObservedAt", () => {
    const evidence = validateScorePayload(
      scoreFixture({ businessId: null, evidenceFreshness: { latestObservedAt: null, computedAt: NOW } })
    );
    expect(evidence.businessId).toBeNull();
    expect(evidence.latestObservedAt).toBeNull();
  });

  it("accepts the seam identity version allow-list", () => {
    const seamVersion = `lead-identity-seam/v1:${G64}`;
    const evidence = validateScorePayload(scoreFixture({ leadIdentityVersion: seamVersion }));
    expect(evidence.leadIdentityVersion).toBe(seamVersion);
  });
});

describe("validateScorePayload — corruption classes", () => {
  it("rejects non-objects and key drift", () => {
    for (const bad of [null, undefined, "score", 7, [1]]) {
      expect(() => validateScorePayload(bad)).toThrowError(
        expect.objectContaining({ name: "QualificationValidationError", code: "INVALID_SCORE_PAYLOAD" })
      );
    }
    expect(() => validateScorePayload({ ...scoreFixture(), authority: "QUALIFIED" })).toThrowError(
      expect.objectContaining({ code: "INVALID_SCORE_PAYLOAD" })
    );
    const { createdAt: _omitted, ...incomplete } = scoreFixture();
    expect(() => validateScorePayload(incomplete)).toThrowError(
      expect.objectContaining({ code: "INVALID_SCORE_PAYLOAD" })
    );
  });

  it("rejects malformed anchors", () => {
    expect(() => validateScorePayload(scoreFixture({ leadScoreId: "lsc1:nope" }))).toThrowError(
      expect.objectContaining({ code: "INVALID_SCORE_PAYLOAD" })
    );
    expect(() => validateScorePayload(scoreFixture({ leadId: OTHER_LEAD_ID.slice(0, 10) }))).toThrowError(
      expect.objectContaining({ code: "INVALID_SCORE_PAYLOAD" })
    );
    expect(() => validateScorePayload(scoreFixture({ evidenceSnapshotId: "lss1:bad" }))).toThrowError(
      expect.objectContaining({ code: "INVALID_SCORE_PAYLOAD" })
    );
    expect(() => validateScorePayload(scoreFixture({ evidenceSnapshotHash: "not-hex" }))).toThrowError(
      expect.objectContaining({ code: "INVALID_SCORE_PAYLOAD" })
    );
  });

  it("rejects unknown versions with UNKNOWN_SCORE_VERSION", () => {
    expect(() => validateScorePayload(scoreFixture({ scoringVersion: "lead-scoring-engine/v2" }))).toThrowError(
      expect.objectContaining({ name: "QualificationInputError", code: "UNKNOWN_SCORE_VERSION" })
    );
    expect(() => validateScorePayload(scoreFixture({ featureVersion: "lead-scoring-features/v2" }))).toThrowError(
      expect.objectContaining({ code: "UNKNOWN_SCORE_VERSION" })
    );
    expect(() =>
      validateScorePayload(scoreFixture({ scoreContractVersion: "lead-scoring/v2" }))
    ).toThrowError(expect.objectContaining({ code: "UNKNOWN_SCORE_VERSION" }));
    expect(() =>
      validateScorePayload(scoreFixture({ leadIdentityVersion: "lead-identity/v9" }))
    ).toThrowError(expect.objectContaining({ code: "IDENTITY_VERSION_UNKNOWN" }));
  });

  it("rejects malformed scores with INVALID_SCORE", () => {
    for (const overallScore of [75.5, -1, 101, "75"]) {
      expect(() => validateScorePayload(scoreFixture({ overallScore }))).toThrowError(
        expect.objectContaining({ code: "INVALID_SCORE" })
      );
    }
    for (const fitScore of [0.5, 101, -3]) {
      expect(() => validateScorePayload(scoreFixture({ fitScore }))).toThrowError(
        expect.objectContaining({ code: "INVALID_SCORE" })
      );
    }
    expect(() =>
      validateScorePayload(scoreFixture({ scoreConfidence: "MAYBE" }))
    ).toThrowError(expect.objectContaining({ code: "INVALID_SCORE" }));
  });

  it("rejects an unknown band with SCORE_BAND_UNKNOWN", () => {
    expect(() => validateScorePayload(scoreFixture({ scoreBand: "EXTREME" }))).toThrowError(
      expect.objectContaining({ code: "SCORE_BAND_UNKNOWN" })
    );
  });

  it("rejects a band/score mismatch as SCORE_TAMPERED", () => {
    expect(() =>
      validateScorePayload(scoreFixture({ overallScore: 75, scoreBand: "MEDIUM" }))
    ).toThrowError(expect.objectContaining({ name: "QualificationTamperError", code: "SCORE_TAMPERED" }));
    expect(() =>
      validateScorePayload(scoreFixture({ overallScore: 10, scoreBand: "VERY_HIGH" }))
    ).toThrowError(expect.objectContaining({ name: "QualificationTamperError", code: "SCORE_TAMPERED" }));
  });

  it("enforces componentWeights shape, bounds and sum", () => {
    expect(() =>
      validateScorePayload(
        scoreFixture({ componentWeights: { fit: 1, intent: 0, engagement: 0, recency: 0 } })
      )
    ).toThrowError(expect.objectContaining({ code: "INVALID_SCORE" }));
    expect(() =>
      validateScorePayload(
        scoreFixture({
          componentWeights: { fit: 0.5, intent: 0.5, engagement: 0, recency: 0, opportunity: 0.1 },
        })
      )
    ).toThrowError(expect.objectContaining({ code: "INVALID_SCORE" }));
    expect(() =>
      validateScorePayload(
        scoreFixture({
          componentWeights: { fit: 0.2, intent: 0.2, engagement: 0.2, recency: 0.2, opportunity: 1.4 },
        })
      )
    ).toThrowError(expect.objectContaining({ code: "INVALID_SCORE" }));
    expect(() =>
      validateScorePayload(
        scoreFixture({
          componentWeights: { fit: 0.2, intent: 0.2, engagement: 0.2, recency: 0.2, opportunity: Number.NaN },
        })
      )
    ).toThrowError(expect.objectContaining({ code: "INVALID_SCORE" }));
  });

  it("rejects reason-code drift with INVALID_REASON_CODE", () => {
    expect(() =>
      validateScorePayload(scoreFixture({ reasonCodes: ["MADE_UP"] }))
    ).toThrowError(expect.objectContaining({ code: "INVALID_REASON_CODE" }));
    expect(() =>
      validateScorePayload(scoreFixture({ reasonCodes: Array(9).fill("RECENT_EVIDENCE") }))
    ).toThrowError(expect.objectContaining({ code: "INVALID_REASON_CODE" }));
    expect(() => validateScorePayload(scoreFixture({ reasonCodes: [7] }))).toThrowError(
      expect.objectContaining({ code: "INVALID_REASON_CODE" })
    );
    expect(() => validateScorePayload(scoreFixture({ reasonCodes: "RECENT_EVIDENCE" }))).toThrowError(
      expect.objectContaining({ code: "INVALID_REASON_CODE" })
    );
  });

  it("rejects freshness/timestamp/scope drift with INVALID_SCORE_PAYLOAD", () => {
    expect(() =>
      validateScorePayload(scoreFixture({ evidenceFreshness: { computedAt: NOW } }))
    ).toThrowError(expect.objectContaining({ code: "INVALID_SCORE_PAYLOAD" }));
    expect(() =>
      validateScorePayload(scoreFixture({ evidenceFreshness: { latestObservedAt: "old", computedAt: NOW, extra: 1 } }))
    ).toThrowError(expect.objectContaining({ code: "INVALID_SCORE_PAYLOAD" }));
    expect(() => validateScorePayload(scoreFixture({ computedAt: "noon" }))).toThrowError(
      expect.objectContaining({ code: "INVALID_SCORE_PAYLOAD" })
    );
    expect(() => validateScorePayload(scoreFixture({ createdAt: 123 }))).toThrowError(
      expect.objectContaining({ code: "INVALID_SCORE_PAYLOAD" })
    );
    expect(() => validateScorePayload(scoreFixture({ businessId: 0 }))).toThrowError(
      expect.objectContaining({ code: "INVALID_SCORE_PAYLOAD" })
    );
    expect(() => validateScorePayload(scoreFixture({ userId: -7 }))).toThrowError(
      expect.objectContaining({ code: "INVALID_SCORE_PAYLOAD" })
    );
    expect(() =>
      validateScorePayload(scoreFixture({ duplicateClassification: "replay" }))
    ).toThrowError(expect.objectContaining({ code: "INVALID_SCORE_PAYLOAD" }));
  });

  it("rejects a tampered scoreContentHash as SCORE_TAMPERED", () => {
    const tampered = scoreFixture({ scoreContentHash: H64 });
    expect(H64).not.toBe(contentHashOf(tampered));
    expect(() => validateScorePayload(tampered)).toThrowError(
      expect.objectContaining({ name: "QualificationTamperError", code: "SCORE_TAMPERED" })
    );
  });

  it("rejects a malformed scoreContentHash as INVALID_SCORE_PAYLOAD", () => {
    expect(() => validateScorePayload(scoreFixture({ scoreContentHash: "zzz" }))).toThrowError(
      expect.objectContaining({ code: "INVALID_SCORE_PAYLOAD" })
    );
  });
});
