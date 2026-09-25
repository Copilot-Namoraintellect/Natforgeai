import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";
import { getDb } from "../../queries/connection";
import { evaluateCampaignLearning } from "./learning-service";
import { LEARNING_EVALUATION_VERSION } from "./contracts/learning-config";

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as
    | string
    | undefined;
}

interface MockOptions {
  campaign?: any;
  analyticsRows?: any[];
  learningRows?: any[];
  failInsertWithDupKey?: boolean;
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
  failInsertWithDupKey = false,
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
          if (failInsertWithDupKey) {
            // Simulate a concurrent evaluation winning the unique key.
            learningRows.push({ ...row, id: 999 });
            const err: any = new Error(
              "Duplicate entry 'lr:7:learning-v1:2026-05-01:2026-05-31' for key 'lr_idempotency_key_idx'"
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

const richAnalyticsRows = [
  { id: 1, metricType: "impressions", platform: "instagram", value: 100_000, date: "2026-05-01" },
  { id: 2, metricType: "impressions", platform: "tiktok", value: 100_000, date: "2026-05-20" },
  { id: 3, metricType: "clicks", platform: "instagram", value: 2000, date: "2026-05-01" },
  { id: 4, metricType: "clicks", platform: "tiktok", value: 2000, date: "2026-05-20" },
  { id: 5, metricType: "conversions", platform: "instagram", value: 60, date: "2026-05-01" },
  { id: 6, metricType: "conversions", platform: "tiktok", value: 60, date: "2026-05-20" },
];

describe("evaluateCampaignLearning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists a full learning record with lineage on first execution", async () => {
    const db = createMockDb({ analyticsRows: richAnalyticsRows });
    vi.mocked(getDb).mockReturnValue(db);

    const result = await evaluateCampaignLearning({ userId: 22, campaignId: 7 });

    expect(result.status).toBe("recorded");
    if (result.status !== "recorded") return;
    expect(result.idempotentReplay).toBe(false);

    const record = result.record;
    // Lineage: campaign, version, window, timestamps, provenance
    expect(record.campaignId).toBe(7);
    expect(record.evaluationVersion).toBe(LEARNING_EVALUATION_VERSION);
    expect(record.windowStart).toBe("2026-05-01");
    expect(record.windowEnd).toBe("2026-05-31");
    expect(record.evaluatedAt).toBeTruthy();
    expect(record.provenance.engine).toBe("learning-engine");
    expect(record.provenance.engineVersion).toBe(LEARNING_EVALUATION_VERSION);
    expect(record.provenance.inputDigest).toMatch(/^[0-9a-f]{64}$/);
    // Source observations persisted and grounded
    expect(record.sourceObservations).toHaveLength(6);
    expect(record.sourceObservations.map((o) => o.id)).toContain("ao:1");
    expect("kpis" in record.kpiAssessment && record.kpiAssessment.kpis.length).toBeGreaterThan(0);
    expect(record.objectiveSummary).toContain("conversions");
    // Governance
    expect(record.governance.autoApply).toBe(false);
    expect(record.governance.requiresApproval).toBe(true);
    for (const rec of record.recommendedAdjustments) {
      expect(rec.governance.autoApply).toBe(false);
    }

    // The deterministic idempotency key is what the unique index guards.
    const inserted = db.state.insertedRows[0];
    expect(inserted.idempotencyKey).toBe(
      `lr:7:${LEARNING_EVALUATION_VERSION}:2026-05-01:2026-05-31`
    );
    expect(db.state.insertTables).toEqual(["learning_records"]);
  });

  it("is idempotent: a second run for the same window/version replays the persisted record", async () => {
    const db = createMockDb({ analyticsRows: richAnalyticsRows });
    vi.mocked(getDb).mockReturnValue(db);

    const first = await evaluateCampaignLearning({ userId: 22, campaignId: 7 });
    const second = await evaluateCampaignLearning({ userId: 22, campaignId: 7 });

    expect(first.status).toBe("recorded");
    expect(second.status).toBe("recorded");
    if (first.status !== "recorded" || second.status !== "recorded") return;
    expect(first.idempotentReplay).toBe(false);
    expect(second.idempotentReplay).toBe(true);
    expect(second.record.provenance.inputDigest).toBe(first.record.provenance.inputDigest);
    // Exactly one insert across both executions
    expect(db.state.insertedRows).toHaveLength(1);
  });

  it("resolves a concurrent duplicate insert by replaying the winning record", async () => {
    const db = createMockDb({
      analyticsRows: richAnalyticsRows,
      failInsertWithDupKey: true,
    });
    vi.mocked(getDb).mockReturnValue(db);

    const result = await evaluateCampaignLearning({ userId: 22, campaignId: 7 });

    expect(result.status).toBe("recorded");
    if (result.status !== "recorded") return;
    expect(result.idempotentReplay).toBe(true);
    expect(result.record.id).toBe(999);
  });

  it("never mutates Strategy, Creative or Distribution state", async () => {
    const db = createMockDb({ analyticsRows: richAnalyticsRows });
    vi.mocked(getDb).mockReturnValue(db);

    await evaluateCampaignLearning({ userId: 22, campaignId: 7 });

    expect(db.state.insertTables).toEqual(["learning_records"]);
    expect(db.state.updateTables).toEqual([]);
    expect(db.state.deleteTables).toEqual([]);
  });

  it("returns insufficient_data without persisting when the window has no observations", async () => {
    const db = createMockDb({ analyticsRows: [] });
    vi.mocked(getDb).mockReturnValue(db);

    const result = await evaluateCampaignLearning({
      userId: 22,
      campaignId: 7,
      windowStart: "2026-05-01",
      windowEnd: "2026-05-31",
    });

    expect(result.status).toBe("insufficient_data");
    expect(db.state.insertedRows).toHaveLength(0);
  });

  it("throws NOT_FOUND when the campaign does not belong to the user", async () => {
    const db = createMockDb({ campaign: null });
    vi.mocked(getDb).mockReturnValue(db);

    await expect(
      evaluateCampaignLearning({ userId: 22, campaignId: 7 })
    ).rejects.toMatchObject({ code: "NOT_FOUND" satisfies TRPCError["code"] });
    expect(db.state.insertedRows).toHaveLength(0);
  });

  it("rejects an inverted evaluation window", async () => {
    const db = createMockDb({ analyticsRows: richAnalyticsRows });
    vi.mocked(getDb).mockReturnValue(db);

    await expect(
      evaluateCampaignLearning({
        userId: 22,
        campaignId: 7,
        windowStart: "2026-05-31",
        windowEnd: "2026-05-01",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.state.insertedRows).toHaveLength(0);
  });

  it("scopes a different evaluation window to its own idempotency key", async () => {
    const db = createMockDb({ analyticsRows: richAnalyticsRows });
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

    expect(may.status).toBe("recorded");
    expect(june.status).toBe("recorded");
    if (may.status !== "recorded" || june.status !== "recorded") return;
    expect(may.record.windowEnd).toBe("2026-05-15");
    expect(june.record.windowEnd).toBe("2026-05-31");
    expect(db.state.insertedRows).toHaveLength(2);
    expect(db.state.insertedRows[0].idempotencyKey).not.toBe(
      db.state.insertedRows[1].idempotencyKey
    );
  });
});
