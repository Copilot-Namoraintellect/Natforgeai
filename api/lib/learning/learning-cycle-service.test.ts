import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";
import { getDb } from "../../queries/connection";
import {
  runGovernedLearningCycle,
  listGovernedLearningRecords,
} from "./learning-cycle-service";
import { loadCampaignPerformanceDataset } from "./performance/loader";
import { listLearningRecords } from "./learning-service";
import { LEARNING_CYCLE_EVALUATION_VERSION } from "./contracts/learning-config";

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as
    | string
    | undefined;
}

const HASH_A = "a".repeat(64);

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
  strategySnapshots?: any[];
  approvalRequests?: any[];
  learningRows?: any[];
  failInsertWithDupKey?: boolean;
}

function campaignFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    userId: 22,
    businessId: 5,
    name: "Bookings campaign",
    goal: "Drive online bookings",
    primaryOutcome: "drive online bookings",
    budget: 5000,
    platforms: "instagram,tiktok",
    startDate: "2026-05-01",
    endDate: "2026-05-31",
    status: "active",
    workflowContext: {
      strategyApprovalLineage: {
        status: "approved",
        creativeBriefFingerprint: "fp-brief",
        strategyRunId: 11,
        strategySnapshotId: "strategy_abc",
        strategyVersion: 1,
        businessDnaSnapshotId: "bdna_1",
        strategyHashSha256: HASH_A,
        approvalRequestId: 33,
      },
    },
    ...overrides,
  };
}

function strategySnapshotFixture() {
  return {
    id: 1,
    snapshotId: "strategy_abc",
    userId: 22,
    campaignId: 7,
    businessId: 5,
    strategyRunId: 11,
    businessDnaSnapshotId: "bdna_1",
    version: 1,
    creativeBriefFingerprint: "fp-brief",
    strategyHashSha256: HASH_A,
    snapshot: {
      funnelStages: [
        { stage: "awareness", goal: "be seen", tactics: [], metrics: ["impressions"] },
        { stage: "conversion", goal: "convert", tactics: [], metrics: ["conversions"] },
      ],
    },
    capturedAt: new Date("2026-04-15T00:00:00.000Z"),
    createdAt: new Date("2026-04-15T00:00:00.000Z"),
  };
}

const analyticsFixture = [
  { id: 1, userId: 22, campaignId: 7, metricType: "impressions", platform: "instagram", value: 80_000, date: "2026-05-01" },
  { id: 2, userId: 22, campaignId: 7, metricType: "impressions", platform: "tiktok", value: 60_000, date: "2026-05-02" },
  { id: 3, userId: 22, campaignId: 7, metricType: "clicks", platform: "instagram", value: 900, date: "2026-05-01" },
  { id: 4, userId: 22, campaignId: 7, metricType: "clicks", platform: "tiktok", value: 700, date: "2026-05-02" },
  { id: 5, userId: 22, campaignId: 7, metricType: "conversions", platform: "instagram", value: 30, date: "2026-05-01" },
  { id: 6, userId: 22, campaignId: 7, metricType: "conversions", platform: "tiktok", value: 20, date: "2026-05-02" },
];

function learningRecordV1Row() {
  return {
    id: 400,
    userId: 22,
    campaignId: 7,
    evaluationVersion: "learning-v1",
    windowStart: new Date("2026-05-01T00:00:00.000Z"),
    windowEnd: new Date("2026-05-31T00:00:00.000Z"),
    idempotencyKey: "lr:7:learning-v1:2026-05-01:2026-05-31",
    objectiveSummary: "Phase 1 record.",
    kpiAssessment: { kpis: [] },
    performanceFacts: [],
    positivePatterns: [],
    negativePatterns: [],
    confidence: "medium",
    evidence: [],
    recommendedAdjustments: [],
    governance: { autoApply: false, requiresApproval: true, phase: 1 },
    sourceObservations: [],
    provenance: {
      engine: "learning-engine",
      engineVersion: "learning-v1",
      trigger: "manual",
      inputDigest: "digest-v1",
      evaluatedAt: "2026-06-01T00:00:00.000Z",
    },
    status: "recorded",
    evaluatedAt: new Date("2026-06-01T00:00:00.000Z"),
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
  };
}

function createMockDb({
  campaign = campaignFixture(),
  analyticsRows = analyticsFixture,
  strategySnapshots = [strategySnapshotFixture()],
  approvalRequests = [
    {
      id: 33,
      userId: 22,
      campaignId: 7,
      approvalType: "strategy_review",
      title: "Strategy review",
      description: null,
      aiRecommendation: null,
      riskLevel: "medium",
      status: "approved",
      approvedAt: new Date("2026-04-16T00:00:00.000Z"),
      rejectedAt: null,
      idempotencyKey: null,
      context: null,
      createdAt: new Date("2026-04-16T00:00:00.000Z"),
    },
  ],
  learningRows = [] as any[],
  failInsertWithDupKey = false,
}: MockOptions = {}) {
  const state = {
    insertTables: [] as string[],
    updateTables: [] as string[],
    deleteTables: [] as string[],
    insertedRows: [] as any[],
    insertCount: 0,
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
              : name === "strategy_snapshots"
                ? strategySnapshots
                : name === "approval_requests"
                  ? approvalRequests
                  : name === "learning_records"
                    ? learningRows
                    : name === "publishing_queue"
                      ? []
                      : name === "audit_events"
                        ? []
                        : name === "content_posts"
                          ? []
                          : name === "social_engagement_events"
                            ? []
                            : name === "leads"
                              ? []
                              : name === "ai_usage"
                                ? []
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
              orderBy: vi.fn(() => ({
                limit: vi.fn(async () => filtered.slice(0, 1)),
                then: (resolve: any, reject: any) =>
                  Promise.resolve(filtered).then(resolve, reject),
              })),
              then: (resolve: any, reject: any) =>
                Promise.resolve(filtered).then(resolve, reject),
            };
            return chain;
          }),
          orderBy: vi.fn(() => ({
            limit: vi.fn(async () => result.slice(0, 1)),
            then: (resolve: any, reject: any) =>
              Promise.resolve(result).then(resolve, reject),
          })),
          limit: vi.fn(async () => result.slice(0, 1)),
        };
      }),
    })),
    insert: vi.fn((table: unknown) => {
      const name = getTableName(table);
      state.insertTables.push(name ?? "unknown");
      return {
        values: vi.fn(async (row: any) => {
          state.insertCount += 1;
          if (failInsertWithDupKey) {
            learningRows.push({ ...row, id: 999 });
            const err: any = new Error(
              "Duplicate entry 'lr:7:learning-v2:2026-05-01:2026-05-31' for key 'lr_idempotency_key_idx'"
            );
            err.code = "ER_DUP_ENTRY";
            err.errno = 1062;
            throw err;
          }
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

describe("runGovernedLearningCycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs the closed cycle and binds the WBS15 authority lineage into the record", async () => {
    const mockDb = createMockDb();
    vi.mocked(getDb).mockReturnValue(mockDb);

    const result = await runGovernedLearningCycle({
      userId: 22,
      campaignId: 7,
      trigger: "manual",
    });

    expect(result.status).toBe("recorded");
    if (result.status !== "recorded") return;
    expect(result.idempotentReplay).toBe(false);
    const record = result.record;
    expect(record.evaluationVersion).toBe(LEARNING_CYCLE_EVALUATION_VERSION);
    expect(record.evaluationVersion).toBe("learning-v2");

    // The canonical Stream 1 dataset was consumed: the bound fingerprint
    // equals a fresh load of the same persisted inputs.
    const dataset = await loadCampaignPerformanceDataset({ userId: 22, campaignId: 7 });
    expect(record.provenance.wbs15?.datasetFingerprint).toBe(dataset.identity.fingerprint);
    expect(record.provenance.wbs15?.datasetFingerprint).toMatch(/^[0-9a-f]{64}$/);

    // Strategy snapshot/version/hash coordinates are bound.
    expect(record.provenance.wbs15?.strategyAuthority).toMatchObject({
      snapshotId: "strategy_abc",
      strategyRunId: 11,
      strategyVersion: 1,
      strategyHashSha256: HASH_A,
      businessDnaSnapshotId: "bdna_1",
      creativeBriefFingerprint: "fp-brief",
      approvalRequestId: 33,
      lineageStatus: "approved",
    });

    // Stream 2 KPI evaluation lineage is bound (budget assumption engaged:
    // 5000 / 50 = 100 target vs 50 observed conversions → ratio 0.5 → partial).
    expect(record.provenance.wbs15?.strategyKpiEvaluation.overallStatus).toBe("partial");
    expect(record.provenance.wbs15?.strategyKpiEvaluation.results.length).toBe(2);
    const conversionsLineage = record.provenance.wbs15?.strategyKpiEvaluation.results.find(
      (r) => r.metric === "conversions"
    )!;
    expect(conversionsLineage.targetBasis).toBe("budget_assumption");
    expect(conversionsLineage.target).toBe(100);
    expect(conversionsLineage.actual).toBe(50);

    // Stream 3 variant analysis lineage is bound; unsupported dimensions are
    // recorded as explicit governed skips.
    expect(record.provenance.wbs15?.variantAnalysis.dimension).toBe("platform");
    expect(record.provenance.wbs15?.variantAnalysis.comparability).toBe("non_comparable");
    expect(record.provenance.wbs15?.variantDimensionsSkipped.map((s) => s.dimension)).toEqual([
      "message_copy",
      "caption",
      "creative",
      "format",
    ]);

    // Deterministic record fingerprint + observation identities are bound.
    expect(record.provenance.wbs15?.recordFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(record.sourceObservations.map((o) => o.id)).toEqual(dataset.outcomes.observations.map((o) => o.id));

    // Governed recommendation semantics are preserved.
    expect(record.governance).toEqual({ autoApply: false, requiresApproval: true, phase: 2 });
    expect(record.recommendedAdjustments.length).toBeGreaterThan(0);
    for (const rec of record.recommendedAdjustments) {
      expect(rec.governance).toEqual({ autoApply: false, requiresApproval: true });
    }

    // No uncontrolled self-modification: only learning_records is written.
    expect(mockDb.state.insertTables).toEqual(["learning_records"]);
    expect(mockDb.state.updateTables).toEqual([]);
    expect(mockDb.state.deleteTables).toEqual([]);
  });

  it("replays the same evaluation idempotently without duplicating the record", async () => {
    const mockDb = createMockDb();
    vi.mocked(getDb).mockReturnValue(mockDb);

    const first = await runGovernedLearningCycle({ userId: 22, campaignId: 7, trigger: "api" });
    const second = await runGovernedLearningCycle({ userId: 22, campaignId: 7, trigger: "api" });

    expect(first.status).toBe("recorded");
    expect(second.status).toBe("recorded");
    if (first.status !== "recorded" || second.status !== "recorded") return;
    expect(first.idempotentReplay).toBe(false);
    expect(second.idempotentReplay).toBe(true);
    expect(second.record.id).toBe(first.record.id);
    expect(second.record.provenance.inputDigest).toBe(first.record.provenance.inputDigest);
    expect(second.record.provenance.wbs15?.recordFingerprint).toBe(
      first.record.provenance.wbs15?.recordFingerprint
    );
    expect(mockDb.state.insertCount).toBe(1);
  });

  it("resolves a concurrent duplicate insert by replaying the winner", async () => {
    const mockDb = createMockDb({ failInsertWithDupKey: true });
    vi.mocked(getDb).mockReturnValue(mockDb);

    const result = await runGovernedLearningCycle({ userId: 22, campaignId: 7 });
    expect(result.status).toBe("recorded");
    if (result.status !== "recorded") return;
    expect(result.idempotentReplay).toBe(true);
    expect(result.record.evaluationVersion).toBe("learning-v2");
  });

  it("fails closed when the required Strategy authority is missing", async () => {
    const mockDb = createMockDb({ strategySnapshots: [], approvalRequests: [] });
    vi.mocked(getDb).mockReturnValue(mockDb);

    const result = await runGovernedLearningCycle({ userId: 22, campaignId: 7 });
    expect(result.status).toBe("authority_missing");
    if (result.status !== "authority_missing") return;
    expect(result.readinessStatus).toBe("authority_missing");
    expect(result.requiredIssues.map((i) => i.code)).toContain("strategy_authority_missing");
    // Nothing may be fabricated.
    expect(mockDb.state.insertTables).toEqual([]);
  });

  it("reports insufficient_data and writes nothing when no factual observations exist", async () => {
    const mockDb = createMockDb({ analyticsRows: [] });
    vi.mocked(getDb).mockReturnValue(mockDb);

    const result = await runGovernedLearningCycle({ userId: 22, campaignId: 7 });
    expect(result.status).toBe("insufficient_data");
    expect(mockDb.state.insertTables).toEqual([]);
  });

  it("throws NOT_FOUND for a campaign owned by another user", async () => {
    const mockDb = createMockDb({ campaign: null });
    vi.mocked(getDb).mockReturnValue(mockDb);

    await expect(
      runGovernedLearningCycle({ userId: 22, campaignId: 7 })
    ).rejects.toThrow(TRPCError);
  });

  it("keeps learning-v1 history readable and untouched alongside learning-v2", async () => {
    const v1Row = learningRecordV1Row();
    const mockDb = createMockDb({ learningRows: [v1Row] });
    vi.mocked(getDb).mockReturnValue(mockDb);

    const result = await runGovernedLearningCycle({ userId: 22, campaignId: 7 });
    expect(result.status).toBe("recorded");

    // The Phase 1 list API still reads both versions; the v1 row is unchanged.
    const viaPhase1 = await listLearningRecords({ userId: 22, campaignId: 7 });
    const viaCycle = await listGovernedLearningRecords({ userId: 22, campaignId: 7 });
    for (const list of [viaPhase1, viaCycle]) {
      expect(list.map((r) => r.evaluationVersion).sort()).toEqual(["learning-v1", "learning-v2"]);
    }
    const v1 = viaPhase1.find((r) => r.evaluationVersion === "learning-v1")!;
    expect(v1.id).toBe(400);
    expect(v1.provenance.inputDigest).toBe("digest-v1");
    expect(v1.recommendedAdjustments).toEqual([]);
    // The historical v1 row in the store was not rewritten.
    expect(mockDb.state.updateTables).toEqual([]);
  });
});
