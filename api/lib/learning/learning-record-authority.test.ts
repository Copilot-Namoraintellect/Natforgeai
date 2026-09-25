import { describe, it, expect, vi, beforeEach } from "vitest";
import { getDb } from "../../queries/connection";
import { evaluateCampaignLearning, type LearningRecordView } from "./learning-service";
import { LEARNING_EVALUATION_VERSION } from "./contracts/learning-config";
import {
  deriveLearning,
  type RecommendedAdjustment,
} from "./contracts/learning-derivation";
import { evaluateKpiAssessment } from "./contracts/kpi-assessment";
import {
  normaliseObservations,
  type CampaignFacts,
} from "./contracts/observation";
import {
  assessPromotionReadiness,
  buildRecordLineage,
  computeEvidenceFingerprint,
  computeRecordFingerprint,
  deriveRecommendationAuthorities,
  detectEvidenceDrift,
  isSuperseded,
  INSUFFICIENT_EVIDENCE_ADJUSTMENT,
  RECORD_FINGERPRINT_SCHEMA,
} from "./learning-record-authority";

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

// ─── Mock database harness (same contract as learning-service.test.ts) ───

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as
    | string
    | undefined;
}

function deepFindIdempotencyKey(obj: unknown, depth = 0): string | null {
  if (depth > 6 || obj === null || obj === undefined) return null;
  if (typeof obj === "string" && obj.startsWith("lr:")) return obj;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = deepFindIdempotencyKey(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof obj === "object") {
    for (const value of Object.values(obj)) {
      const found = deepFindIdempotencyKey(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

interface MockOptions {
  campaign?: any;
  analyticsRows?: any[];
  learningRows?: any[];
}

function createMockDb({
  campaign = {
    id: 7,
    userId: 22,
    goal: "Drive online bookings",
    primaryOutcome: "drive online bookings",
    budget: 5000,
    platforms: "instagram,tiktok",
    startDate: "2026-05-01",
    endDate: "2026-05-31",
  },
  analyticsRows = [] as any[],
  learningRows = [] as any[],
}: MockOptions = {}) {
  const state = {
    insertTables: [] as string[],
    updateTables: [] as string[],
    deleteTables: [] as string[],
    insertedRows: [] as any[],
  };

  const db = {
    state,
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        const name = getTableName(table);
        const result =
          name === "campaigns"
            ? campaign
              ? [campaign]
              : []
            : name === "analytics"
              ? analyticsRows
              : name === "learning_records"
                ? learningRows
                : [];
        return {
          where: vi.fn((...conds: unknown[]) => {
            const key =
              name === "learning_records"
                ? conds.map((c) => deepFindIdempotencyKey(c)).find((k) => k !== null) ?? null
                : null;
            const filtered = key
              ? result.filter((r: any) => r.idempotencyKey === key)
              : result;
            const chain: any = {
              limit: vi.fn(async () => filtered.slice(0, 1)),
              orderBy: vi.fn(async () => filtered),
              then: (resolve: any, reject: any) =>
                Promise.resolve(filtered).then(resolve, reject),
            };
            return chain;
          }),
          orderBy: vi.fn(async () => result),
        };
      }),
    })),
    insert: vi.fn((table: unknown) => {
      const name = getTableName(table);
      state.insertTables.push(name ?? "unknown");
      return {
        values: vi.fn(async (row: any) => {
          state.insertedRows.push(row);
          learningRows.push({ ...row, id: 501 });
          return [{ insertId: 501, affectedRows: 1 }];
        }),
      };
    }),
    update: vi.fn((table: unknown) => {
      state.updateTables.push(getTableName(table) ?? "unknown");
      return { set: vi.fn(() => ({ where: vi.fn(async () => []) })) };
    }),
    delete: vi.fn((table: unknown) => {
      state.deleteTables.push(getTableName(table) ?? "unknown");
      return { where: vi.fn(async () => []) };
    }),
  };

  return db as any;
}

// Two-platform dataset that fires weak-CTR and not-converting patterns,
// producing two actionable evidence-backed recommendations.
const weakAnalyticsRows = [
  { id: 1, metricType: "impressions", platform: "instagram", value: 100_000, date: "2026-05-01" },
  { id: 2, metricType: "impressions", platform: "tiktok", value: 100_000, date: "2026-05-20" },
  { id: 3, metricType: "clicks", platform: "instagram", value: 200, date: "2026-05-01" },
  { id: 4, metricType: "clicks", platform: "tiktok", value: 200, date: "2026-05-20" },
  { id: 5, metricType: "conversions", platform: "instagram", value: 1, date: "2026-05-01" },
  { id: 6, metricType: "conversions", platform: "tiktok", value: 1, date: "2026-05-20" },
];

// Thin dataset: only the explicit insufficient-evidence recommendation.
const thinAnalyticsRows = [
  { id: 1, metricType: "impressions", platform: "instagram", value: 10, date: "2026-05-01" },
];

function deriveRecordFromRows(
  rows: Parameters<typeof normaliseObservations>[0],
  windowStart = "2026-05-01",
  windowEnd = "2026-05-31"
): LearningRecordView {
  const { observations } = normaliseObservations(rows, windowStart, windowEnd);
  const campaign: CampaignFacts = {
    id: 7,
    goal: "Drive online bookings",
    primaryOutcome: "drive online bookings",
    budget: 5000,
    platforms: "instagram,tiktok",
    startDate: "2026-05-01",
    endDate: "2026-05-31",
  };
  const assessment = evaluateKpiAssessment({ campaign, observations, windowStart, windowEnd });
  const derivation = deriveLearning({ assessment, observations });
  return {
    id: 501,
    userId: 22,
    campaignId: 7,
    evaluationVersion: LEARNING_EVALUATION_VERSION,
    windowStart,
    windowEnd,
    objectiveSummary: derivation.objectiveSummary,
    kpiAssessment: assessment,
    performanceFacts: derivation.performanceFacts,
    positivePatterns: derivation.positivePatterns,
    negativePatterns: derivation.negativePatterns,
    confidence: derivation.confidence,
    evidence: derivation.evidence,
    recommendedAdjustments: derivation.recommendedAdjustments,
    governance: { autoApply: false, requiresApproval: true, phase: 1 },
    sourceObservations: observations,
    normalisationIssues: [],
    provenance: {
      engine: "learning-engine",
      engineVersion: LEARNING_EVALUATION_VERSION,
      trigger: "manual",
      inputDigest: "placeholder",
      evaluatedAt: "2026-05-31T00:00:00.000Z",
    },
    status: "recorded",
    evaluatedAt: "2026-05-31T00:00:00.000Z",
    createdAt: "2026-05-31T00:00:00.000Z",
  };
}

/** Deep clone with recursively reversed object key order (DB JSON round-trip). */
function scrambleKeyOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrambleKeyOrder);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .reverse()) {
      out[key] = scrambleKeyOrder(entry);
    }
    return out;
  }
  return value;
}

describe("learning-record-authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("record fingerprint (WBS15.5)", () => {
    it("is deterministic across repeated computations", () => {
      const record = deriveRecordFromRows(weakAnalyticsRows);
      const a = computeRecordFingerprint(record);
      const b = computeRecordFingerprint(record);
      expect(a).toMatch(/^[0-9a-f]{64}$/);
      expect(a).toBe(b);
    });

    it("is stable across a JSON round-trip with reordered keys", () => {
      const record = deriveRecordFromRows(weakAnalyticsRows);
      const original = computeRecordFingerprint(record);
      const roundTripped = JSON.parse(JSON.stringify(scrambleKeyOrder(record)));
      expect(computeRecordFingerprint(roundTripped as LearningRecordView)).toBe(original);
    });

    it("differs when the evaluation version differs", () => {
      const record = deriveRecordFromRows(weakAnalyticsRows);
      const base = computeRecordFingerprint(record);
      const bumped = computeRecordFingerprint({
        ...record,
        evaluationVersion: "learning-v2",
      });
      expect(bumped).not.toBe(base);
    });

    it("differs when the governed content differs, not only the coordinates", () => {
      const record = deriveRecordFromRows(weakAnalyticsRows);
      const base = computeRecordFingerprint(record);
      const tampered = deriveRecordFromRows(weakAnalyticsRows);
      tampered.recommendedAdjustments = [
        ...tampered.recommendedAdjustments,
        {
          id: "rec_forged",
          targetEngine: "strategy",
          adjustmentType: "forged",
          summary: "forged",
          rationale: "forged",
          evidenceRefs: ["ao:1"],
          governance: { autoApply: false, requiresApproval: true },
        } satisfies RecommendedAdjustment,
      ];
      expect(computeRecordFingerprint(tampered)).not.toBe(base);
      // Coordinates-only change is also detected.
      expect(
        computeRecordFingerprint({ ...record, windowEnd: "2026-06-30" })
      ).not.toBe(base);
    });

    it("evidence fingerprint binds the sorted observation identity", () => {
      const record = deriveRecordFromRows(weakAnalyticsRows);
      const ids = record.sourceObservations.map((o) => o.id);
      expect(computeEvidenceFingerprint(ids)).toBe(computeEvidenceFingerprint([...ids].reverse()));
      expect(computeEvidenceFingerprint(ids)).not.toBe(
        computeEvidenceFingerprint([...ids, "ao:999"])
      );
    });
  });

  describe("record lineage (WBS15.5)", () => {
    it("carries stable promotion coordinates", () => {
      const record = deriveRecordFromRows(weakAnalyticsRows);
      const lineage = buildRecordLineage(record);
      expect(lineage.learningRecordId).toBe(501);
      expect(lineage.campaignId).toBe(7);
      expect(lineage.evaluationVersion).toBe(LEARNING_EVALUATION_VERSION);
      expect(lineage.windowStart).toBe("2026-05-01");
      expect(lineage.windowEnd).toBe("2026-05-31");
      expect(lineage.recordFingerprint).toBe(computeRecordFingerprint(record));
      expect(lineage.evidenceFingerprint).toBe(
        computeEvidenceFingerprint(record.sourceObservations.map((o) => o.id))
      );
      expect(RECORD_FINGERPRINT_SCHEMA).toBe(1);
    });
  });

  describe("recommendation identity (WBS15.4)", () => {
    it("derives deterministic identities and preserves existing recommendation ids", () => {
      const record = deriveRecordFromRows(weakAnalyticsRows);
      expect(record.recommendedAdjustments.length).toBeGreaterThanOrEqual(2);
      const first = deriveRecommendationAuthorities(record);
      const second = deriveRecommendationAuthorities(record);
      expect(first).toEqual(second);
      for (const auth of first) {
        expect(auth.identity).toMatch(/^lri:[0-9a-f]{64}$/);
        expect(auth.recommendationId).toMatch(/^rec_/);
      }
      // Identities are distinct per recommendation.
      const identities = first.map((a) => a.identity);
      expect(new Set(identities).size).toBe(identities.length);
    });

    it("scopes identities to record coordinates: same rule id, different window", () => {
      const may = deriveRecordFromRows(weakAnalyticsRows, "2026-05-01", "2026-05-15");
      const june = deriveRecordFromRows(weakAnalyticsRows, "2026-05-16", "2026-05-31");
      const mayIds = deriveRecommendationAuthorities(may)
        .filter((a) => a.recommendationId === "rec_improve_hook_ctr")
        .map((a) => a.identity);
      const juneIds = deriveRecommendationAuthorities(june)
        .filter((a) => a.recommendationId === "rec_improve_hook_ctr")
        .map((a) => a.identity);
      expect(mayIds).toHaveLength(1);
      expect(juneIds).toHaveLength(1);
      expect(mayIds[0]).not.toBe(juneIds[0]);
    });

    it("marks every actionable recommendation evidence-bound; explicit insufficient-evidence recommendation is valid with no refs", () => {
      const actionable = deriveRecordFromRows(weakAnalyticsRows);
      for (const auth of deriveRecommendationAuthorities(actionable)) {
        expect(auth.adjustmentType).not.toBe(INSUFFICIENT_EVIDENCE_ADJUSTMENT);
        expect(auth.actionable).toBe(true);
        expect(auth.evidenceBound).toBe(true);
        expect(auth.evidenceRefs.length).toBeGreaterThan(0);
      }

      const thin = deriveRecordFromRows(thinAnalyticsRows);
      const insufficient = deriveRecommendationAuthorities(thin).find(
        (a) => a.adjustmentType === INSUFFICIENT_EVIDENCE_ADJUSTMENT
      );
      expect(insufficient).toBeDefined();
      expect(insufficient?.actionable).toBe(false);
      expect(insufficient?.evidenceBound).toBe(true);
      expect(insufficient?.evidenceRefs).toEqual([]);
    });
  });

  describe("promotion readiness (WBS15.4) — pure assessment", () => {
    it("assesses a healthy recorded record as eligible and approval-gated", () => {
      const record = deriveRecordFromRows(weakAnalyticsRows);
      const readiness = assessPromotionReadiness(record, []);
      expect(readiness.eligible).toBe(true);
      expect(readiness.reasons).toEqual([]);
      expect(readiness.checks).toEqual({
        recordExists: true,
        approvalGated: true,
        evidenceBound: true,
        recordCurrent: true,
      });
      // Lineage and recommendation authorities ride along for downstream use.
      expect(readiness.lineage.recordFingerprint).toBe(computeRecordFingerprint(record));
      expect(readiness.recommendations.length).toBe(record.recommendedAdjustments.length);
    });

    it("refuses when an actionable recommendation has no evidence", () => {
      const record = deriveRecordFromRows(weakAnalyticsRows);
      record.recommendedAdjustments = [
        {
          id: "rec_evidenceless",
          targetEngine: "strategy",
          adjustmentType: "improve_offer_conversion_alignment",
          summary: "no evidence",
          rationale: "no evidence",
          evidenceRefs: [],
          governance: { autoApply: false, requiresApproval: true },
        },
      ];
      const readiness = assessPromotionReadiness(record, []);
      expect(readiness.eligible).toBe(false);
      expect(readiness.checks.evidenceBound).toBe(false);
      expect(readiness.reasons.join(" ")).toContain("no evidence");
    });

    it("refuses when governance is not approval-gated (autoApply must stay false)", () => {
      const record = deriveRecordFromRows(weakAnalyticsRows);
      // Deliberate governance tamper: the view type pins approval-gating
      // literals, so the hostile value is cast back onto the view type.
      record.governance = {
        autoApply: true,
        requiresApproval: false,
        phase: 1,
      } as unknown as LearningRecordView["governance"];
      const readiness = assessPromotionReadiness(record, []);
      expect(readiness.eligible).toBe(false);
      expect(readiness.checks.approvalGated).toBe(false);
    });

    it("does not mutate the record or peers and is repeatable", () => {
      const record = deriveRecordFromRows(weakAnalyticsRows);
      const peer = {
        ...deriveRecordFromRows(weakAnalyticsRows, "2026-06-01", "2026-06-30"),
        id: 502,
      };
      const fingerprintBefore = computeRecordFingerprint(record);
      Object.freeze(record);
      Object.freeze(peer);

      const first = assessPromotionReadiness(record, [peer]);
      const second = assessPromotionReadiness(record, [peer]);
      expect(first).toEqual(second);
      expect(computeRecordFingerprint(record)).toBe(fingerprintBefore);
    });

    it("marks a record superseded by a newer-version or newer-window sibling", () => {
      const may = {
        ...deriveRecordFromRows(weakAnalyticsRows, "2026-05-01", "2026-05-31"),
        id: 1,
      };
      const june = {
        ...deriveRecordFromRows(weakAnalyticsRows, "2026-06-01", "2026-06-30"),
        id: 2,
      };
      const nextVersion = {
        ...deriveRecordFromRows(weakAnalyticsRows),
        id: 3,
        evaluationVersion: "learning-v2",
      };

      expect(isSuperseded(may, [may, june])).toBe(true);
      expect(isSuperseded(june, [may, june])).toBe(false);
      expect(isSuperseded(may, [may, nextVersion])).toBe(true);
      // Records for other campaigns never supersede.
      expect(isSuperseded(may, [{ ...june, campaignId: 99 }])).toBe(false);

      const staleReadiness = assessPromotionReadiness(may, [may, june]);
      expect(staleReadiness.eligible).toBe(false);
      expect(staleReadiness.checks.recordCurrent).toBe(false);
      const currentReadiness = assessPromotionReadiness(june, [may, june]);
      expect(currentReadiness.eligible).toBe(true);
    });
  });

  describe("service-backed authority behavior", () => {
    it("replay retains identical authority and the record stays immutable", async () => {
      const db = createMockDb({ analyticsRows: [...weakAnalyticsRows] });
      vi.mocked(getDb).mockReturnValue(db);

      const first = await evaluateCampaignLearning({ userId: 22, campaignId: 7 });
      const second = await evaluateCampaignLearning({ userId: 22, campaignId: 7 });

      expect(first.status).toBe("recorded");
      expect(second.status).toBe("recorded");
      if (first.status !== "recorded" || second.status !== "recorded") return;
      expect(first.idempotentReplay).toBe(false);
      expect(second.idempotentReplay).toBe(true);

      // Same persisted authority on replay: one insert, same fingerprint/lineage.
      expect(db.state.insertedRows).toHaveLength(1);
      expect(computeRecordFingerprint(second.record)).toBe(
        computeRecordFingerprint(first.record)
      );
      expect(buildRecordLineage(second.record)).toEqual(buildRecordLineage(first.record));
      expect(deriveRecommendationAuthorities(second.record)).toEqual(
        deriveRecommendationAuthorities(first.record)
      );
    });

    it("different windows produce distinct authority and distinct recommendation identities", async () => {
      const db = createMockDb({ analyticsRows: [...weakAnalyticsRows] });
      vi.mocked(getDb).mockReturnValue(db);

      const may = await evaluateCampaignLearning({
        userId: 22,
        campaignId: 7,
        windowStart: "2026-05-01",
        windowEnd: "2026-05-15",
      });
      const june = await evaluateCampaignLearning({
        userId: 22,
        campaignId: 7,
        windowStart: "2026-05-16",
        windowEnd: "2026-05-31",
      });

      if (may.status !== "recorded" || june.status !== "recorded") return;
      expect(computeRecordFingerprint(may.record)).not.toBe(
        computeRecordFingerprint(june.record)
      );
      const mayId = deriveRecommendationAuthorities(may.record)[0].identity;
      const juneId = deriveRecommendationAuthorities(june.record)[0].identity;
      expect(mayId).not.toBe(juneId);
    });

    it("historical record is not rewritten when new evidence arrives for the same immutable key; drift is surfaced instead", async () => {
      const rows = [...weakAnalyticsRows];
      const db = createMockDb({ analyticsRows: rows });
      vi.mocked(getDb).mockReturnValue(db);

      const first = await evaluateCampaignLearning({ userId: 22, campaignId: 7 });
      expect(first.status).toBe("recorded");
      if (first.status !== "recorded") return;
      const fingerprintAtInsert = computeRecordFingerprint(first.record);

      // New underlying evidence lands inside the same evaluation window/key.
      rows.push({ id: 7, metricType: "clicks", platform: "instagram", value: 5, date: "2026-05-10" });

      const replay = await evaluateCampaignLearning({ userId: 22, campaignId: 7 });
      expect(replay.status).toBe("recorded");
      if (replay.status !== "recorded") return;
      // Replay, not rewrite: same id, same persisted authority, still one insert.
      expect(replay.idempotentReplay).toBe(true);
      expect(replay.record.id).toBe(first.record.id);
      expect(db.state.insertedRows).toHaveLength(1);
      expect(computeRecordFingerprint(replay.record)).toBe(fingerprintAtInsert);

      // The drift is now detectable rather than silently invisible.
      const { observations } = normaliseObservations(rows, "2026-05-01", "2026-05-31");
      const drift = detectEvidenceDrift(replay.record, observations);
      expect(drift.drifted).toBe(true);
      expect(drift.recomputedDigest).not.toBe(drift.storedDigest);
      // Without new evidence there is no drift.
      const { observations: originalObs } = normaliseObservations(
        weakAnalyticsRows,
        "2026-05-01",
        "2026-05-31"
      );
      expect(detectEvidenceDrift(first.record, originalObs).drifted).toBe(false);
    });

    it("writes only learning_records: no Strategy/Creative/Distribution mutation", async () => {
      const db = createMockDb({ analyticsRows: [...weakAnalyticsRows] });
      vi.mocked(getDb).mockReturnValue(db);

      const result = await evaluateCampaignLearning({ userId: 22, campaignId: 7 });
      expect(result.status).toBe("recorded");
      assessPromotionReadiness(
        result.status === "recorded" ? result.record : ({} as LearningRecordView),
        []
      );

      expect(db.state.insertTables).toEqual(["learning_records"]);
      expect(db.state.updateTables).toEqual([]);
      expect(db.state.deleteTables).toEqual([]);
    });

    it("promotion readiness of a service-recorded record is approval-gated and evidence-backed", async () => {
      const db = createMockDb({ analyticsRows: [...weakAnalyticsRows] });
      vi.mocked(getDb).mockReturnValue(db);

      const result = await evaluateCampaignLearning({ userId: 22, campaignId: 7 });
      if (result.status !== "recorded") throw new Error("expected recorded");

      expect(result.record.governance.autoApply).toBe(false);
      const readiness = assessPromotionReadiness(result.record, []);
      expect(readiness.checks.approvalGated).toBe(true);
      expect(readiness.checks.evidenceBound).toBe(true);
      expect(readiness.eligible).toBe(true);
      for (const auth of readiness.recommendations) {
        expect(auth.actionable).toBe(true);
        expect(auth.evidenceRefs.length).toBeGreaterThan(0);
      }
    });
  });
});
