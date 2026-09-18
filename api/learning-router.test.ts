import { describe, it, expect, vi, beforeEach } from "vitest";
import { getDb } from "./queries/connection";
import { learningRouter } from "./learning-router";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("./lib/rate-limiter", () => ({
  rateLimitUser: vi.fn().mockResolvedValue(undefined),
  rateLimitPublic: vi.fn().mockResolvedValue(undefined),
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, limit: 100, remaining: 99, resetAt: Date.now() + 60 * 60 * 1000 }),
  clearRateLimitStateForTests: vi.fn(),
}));

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

function createMockDb({
  campaign = {
    id: 7,
    userId: 22,
    goal: "Drive online bookings",
    primaryOutcome: "drive online bookings",
    budget: 5000,
    platforms: "instagram",
    startDate: "2026-05-01",
    endDate: "2026-05-31",
  },
  analyticsRows = [
    { id: 1, metricType: "impressions", platform: "instagram", value: 100_000, date: "2026-05-01" },
    { id: 2, metricType: "clicks", platform: "instagram", value: 2000, date: "2026-05-01" },
    { id: 3, metricType: "conversions", platform: "instagram", value: 10, date: "2026-05-01" },
  ] as any[],
  learningRows = [] as any[],
} = {}) {
  const state = { insertTables: [] as string[], insertedRows: [] as any[] };
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
      state.insertTables.push(getTableName(table) ?? "unknown");
      return {
        values: vi.fn(async (row: any) => {
          state.insertedRows.push(row);
          learningRows.push({ ...row, id: 501 });
          return [{ insertId: 501, affectedRows: 1 }];
        }),
      };
    }),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => []) })) })),
    delete: vi.fn(() => ({ where: vi.fn(async () => []) })),
  };
  return db as any;
}

function buildCtx() {
  return {
    resHeaders: new Headers(),
    user: { id: 22, tierSlug: "startup" },
    session: { verified: true },
  } as any;
}

describe("learningRouter contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("evaluate runs the full pipeline and returns a governed, persisted record", async () => {
    const db = createMockDb({});
    vi.mocked(getDb).mockReturnValue(db);

    const caller = learningRouter.createCaller(buildCtx());
    const result = await caller.evaluate({ campaignId: 7 });

    expect(result.status).toBe("recorded");
    if (result.status !== "recorded") return;
    expect(result.record.governance.autoApply).toBe(false);
    expect(result.record.governance.requiresApproval).toBe(true);
    expect(result.record.recommendedAdjustments.every((r) => r.governance.autoApply === false)).toBe(
      true
    );
    expect(result.record.evaluationVersion).toBe("learning-v1");
    expect(result.record.provenance.trigger).toBe("manual");
    // Only the learning_records table is written.
    expect(db.state.insertTables).toEqual(["learning_records"]);
  });

  it("evaluate is idempotent across identical calls", async () => {
    const db = createMockDb({});
    vi.mocked(getDb).mockReturnValue(db);

    const caller = learningRouter.createCaller(buildCtx());
    const first = await caller.evaluate({ campaignId: 7 });
    const second = await caller.evaluate({ campaignId: 7 });

    expect(first.status).toBe("recorded");
    expect(second.status).toBe("recorded");
    if (first.status !== "recorded" || second.status !== "recorded") return;
    expect(first.idempotentReplay).toBe(false);
    expect(second.idempotentReplay).toBe(true);
    expect(db.state.insertedRows).toHaveLength(1);
  });

  it("records.list returns lineage views for the campaign", async () => {
    const db = createMockDb({
      learningRows: [
        {
          id: 501,
          userId: 22,
          campaignId: 7,
          evaluationVersion: "learning-v1",
          windowStart: "2026-05-01",
          windowEnd: "2026-05-31",
          idempotencyKey: "lr:7:learning-v1:2026-05-01:2026-05-31",
          objectiveSummary: "summary",
          kpiAssessment: { kpis: [] },
          performanceFacts: [],
          positivePatterns: [],
          negativePatterns: [],
          confidence: "medium",
          evidence: [],
          recommendedAdjustments: [],
          governance: { autoApply: false, requiresApproval: true, phase: 1 },
          sourceObservations: [],
          provenance: { engine: "learning-engine", engineVersion: "learning-v1", trigger: "manual", inputDigest: "abc", evaluatedAt: "2026-05-31T00:00:00.000Z" },
          status: "recorded",
          evaluatedAt: new Date("2026-05-31T00:00:00Z"),
          createdAt: new Date("2026-05-31T00:00:00Z"),
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(db);

    const caller = learningRouter.createCaller(buildCtx());
    const records = await caller.records({ campaignId: 7 });

    expect(records).toHaveLength(1);
    expect(records[0].id).toBe(501);
    expect(records[0].windowStart).toBe("2026-05-01");
  });

  it("record.get returns NOT_FOUND for records owned by another user", async () => {
    const db = createMockDb({});
    vi.mocked(getDb).mockReturnValue(db);

    const caller = learningRouter.createCaller(buildCtx());
    await expect(caller.record({ id: 123 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects unauthenticated callers", async () => {
    const db = createMockDb({});
    vi.mocked(getDb).mockReturnValue(db);

    const caller = learningRouter.createCaller({
      resHeaders: new Headers(),
      user: undefined,
      session: undefined,
    } as any);

    await expect(caller.evaluate({ campaignId: 7 })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(caller.records({ campaignId: 7 })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("rejects malformed evaluation windows at the input boundary", async () => {
    const db = createMockDb({});
    vi.mocked(getDb).mockReturnValue(db);

    const caller = learningRouter.createCaller(buildCtx());
    await expect(
      caller.evaluate({ campaignId: 7, windowStart: "05/01/2026", windowEnd: "2026-05-31" })
    ).rejects.toThrow();
    expect(db.state.insertedRows).toHaveLength(0);
  });
});
