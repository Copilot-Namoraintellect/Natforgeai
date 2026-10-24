import { describe, it, expect, vi, beforeEach } from "vitest";
import { getDb } from "./queries/connection";
import { intelligenceRouter } from "./intelligence-router";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("./lib/rate-limiter", () => ({
  rateLimitUser: vi.fn().mockResolvedValue(undefined),
  rateLimitPublic: vi.fn().mockResolvedValue(undefined),
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, limit: 100, remaining: 99, resetAt: Date.now() + 60 * 60 * 1000 }),
  clearRateLimitStateForTests: vi.fn(),
}));

vi.mock("./lib/agents/runner", () => ({
  runAgent: vi.fn(),
}));

import { runAgent } from "./lib/agents/runner";

const runAgentMock = vi.mocked(runAgent);

const MODEL_OUTPUT = {
  intent: "purchase_interest",
  sentiment: "positive",
  urgency: "normal",
  modelConfidence: "high",
  relevanceHint: "relevant",
  topics: ["pricing"],
  riskHints: [],
  opportunityHints: ["purchase_intent_detected"],
  evidence: ["asks about price"],
  explanation: "The signal asks about purchasing.",
};

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as
    | string
    | undefined;
}

/** Extract primitive predicate values from drizzle eq()/and() SQL objects. */
function collectPredicateValues(conds: unknown[]): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<object>();
  const walk = (value: unknown): void => {
    if (value === null || value === undefined) return;
    if (typeof value === "number") {
      out.push(value);
      return;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed || /^[=<>!\s&|]+$/.test(trimmed) || /^(and|or)$/i.test(trimmed)) return;
      out.push(value);
      return;
    }
    if (typeof value !== "object") return;
    if (seen.has(value as object)) return;
    seen.add(value as object);
    const rec = value as Record<string, unknown>;
    if ("name" in rec && "table" in rec) return;
    if (Array.isArray(rec.value) && !("queryChunks" in rec)) return;
    if ("queryChunks" in rec) {
      for (const chunk of rec.queryChunks as unknown[]) walk(chunk);
      return;
    }
    for (const nested of Object.values(rec)) walk(nested);
  };
  for (const cond of conds) walk(cond);
  return out;
}

function createMockDb({
  businessesRows = [{ id: 7, userId: 22 }],
  dnaRows = [] as any[],
  interpretationRows = [] as any[],
} = {}) {
  const state = {
    insertTables: [] as string[],
    insertedRows: [] as any[],
  };
  const baseFor = (name: string | undefined): any[] =>
    name === "businesses"
      ? businessesRows
      : name === "business_dna_snapshots"
        ? dnaRows
        : name === "social_interpretations"
          ? interpretationRows
          : [];
  const db: any = {
    state,
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        const name = getTableName(table);
        const base = baseFor(name);
        return {
          where: vi.fn((...conds: unknown[]) => {
            const wanted = collectPredicateValues(conds);
            const filtered = base.filter((r) =>
              wanted.every((v) => Object.values(r).includes(v))
            );
            const chain: any = {
              limit: vi.fn(async () => filtered.slice(0, 1)),
              orderBy: vi.fn(() => chain),
              then: (resolve: any, reject: any) =>
                Promise.resolve(filtered).then(resolve, reject),
            };
            return chain;
          }),
          orderBy: vi.fn(async () => base),
        };
      }),
    })),
    insert: vi.fn((table: unknown) => {
      const name = getTableName(table) ?? "unknown";
      state.insertTables.push(name);
      return {
        values: vi.fn(async (row: any) => {
          if (name === "social_interpretations") {
            const dup =
              interpretationRows.some((r) => r.interpretationId === row.interpretationId) ||
              interpretationRows.some(
                (r) =>
                  r.businessId === row.businessId &&
                  r.signalId === row.signalId &&
                  r.signalVersion === row.signalVersion &&
                  r.classifierVersion === row.classifierVersion
              );
            if (dup) {
              const error: any = new Error("Duplicate entry");
              error.code = "ER_DUP_ENTRY";
              error.errno = 1062;
              throw error;
            }
            interpretationRows.push(row);
          }
          state.insertedRows.push({ table: name, row });
          return [{ insertId: 1000 + state.insertedRows.length, affectedRows: 1 }];
        }),
      };
    }),
  };
  return db;
}

function buildCtx(user: { id: number } | null = { id: 22 }) {
  return {
    resHeaders: new Headers(),
    user: user ?? undefined,
    session: user ? { verified: true } : undefined,
  } as any;
}

const SPAM_SIGNAL = {
  signalId: "sig-router-1",
  signalVersion: 1,
  signalType: "comment" as const,
  provider: "meta" as const,
  platform: "instagram" as const,
  attributionType: "unattributed" as const,
  contentText: "Double your Bitcoin, claim your airdrop now",
};

const AMBIGUOUS_SIGNAL = {
  signalId: "sig-router-2",
  signalVersion: 1,
  signalType: "inbound_message" as const,
  provider: "meta" as const,
  platform: "instagram" as const,
  attributionType: "business" as const,
  actorDisplayName: "@curious",
  contentText: "Do you deliver on weekends?",
  providerEvidenceHash: "a".repeat(64),
};

describe("intelligenceRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runAgentMock.mockReset();
    runAgentMock.mockResolvedValue({
      runId: 55,
      output: MODEL_OUTPUT,
    } as Awaited<ReturnType<typeof runAgent>>);
  });

  it("interpret (rules path) returns an accepted RULE record and persists row + audit", async () => {
    const db = createMockDb({});
    vi.mocked(getDb).mockReturnValue(db);

    const caller = intelligenceRouter.createCaller(buildCtx());
    const result = await caller.interpret({ businessId: 7, signal: SPAM_SIGNAL });

    expect(result.replayed).toBe(false);
    expect(result.record.source).toBe("RULE");
    expect(result.record.billingIdentity).toBeNull();
    expect(result.record.intent).toBe("spam");
    expect(db.state.insertTables).toContain("social_interpretations");
    expect(db.state.insertTables).toContain("audit_events");
    expect(runAgentMock).not.toHaveBeenCalled();
  });

  it("interpret (model path) runs the governed runner once and returns a MODEL record", async () => {
    const db = createMockDb({});
    vi.mocked(getDb).mockReturnValue(db);

    const caller = intelligenceRouter.createCaller(buildCtx());
    const result = await caller.interpret({ businessId: 7, signal: AMBIGUOUS_SIGNAL });

    expect(runAgentMock).toHaveBeenCalledTimes(1);
    const call = runAgentMock.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(call.agentType).toBe("interpretation");
    expect(String(call.billingIdempotencyKey)).toMatch(/^interpretation:[a-f0-9]{64}$/);

    expect(result.replayed).toBe(false);
    expect(result.record.source).toBe("MODEL");
    expect(result.record.billingIdentity).toBe(call.billingIdempotencyKey);
    expect(result.record.businessDnaSnapshotId).toBeNull();
  });

  it("interpret without businessId is tenant-scoped and accepts an unattributed record", async () => {
    const db = createMockDb({ businessesRows: [] });
    vi.mocked(getDb).mockReturnValue(db);

    const caller = intelligenceRouter.createCaller(buildCtx());
    const result = await caller.interpret({ signal: AMBIGUOUS_SIGNAL });

    expect(result.replayed).toBe(false);
    expect(result.record.businessId).toBeNull();
    expect(result.record.businessDnaSnapshotId).toBeNull();
    expect(result.record.source).toBe("MODEL");
    expect(db.state.insertTables).toContain("social_interpretations");
  });

  it("interpret replays an identical call without a second runner invocation", async () => {
    const db = createMockDb({});
    vi.mocked(getDb).mockReturnValue(db);

    const caller = intelligenceRouter.createCaller(buildCtx());
    const input = { businessId: 7, signal: AMBIGUOUS_SIGNAL };
    const first = await caller.interpret(input);
    const second = await caller.interpret(input);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(runAgentMock).toHaveBeenCalledTimes(1);
    const auditInserts = db.state.insertedRows.filter((r: any) => r.table === "audit_events");
    expect(auditInserts).toHaveLength(1);
  });

  it("rejects unauthenticated callers", async () => {
    const db = createMockDb({});
    vi.mocked(getDb).mockReturnValue(db);

    const caller = intelligenceRouter.createCaller(buildCtx(null));
    await expect(caller.interpret({ businessId: 7, signal: SPAM_SIGNAL })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      caller.listForSignal({ businessId: 7, signalId: "sig-router-1" })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("interpret refuses a business owned by another user (NOT_FOUND, no writes)", async () => {
    const db = createMockDb({ businessesRows: [{ id: 7, userId: 999 }] });
    vi.mocked(getDb).mockReturnValue(db);

    const caller = intelligenceRouter.createCaller(buildCtx());
    await expect(caller.interpret({ businessId: 7, signal: SPAM_SIGNAL })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(db.state.insertedRows).toHaveLength(0);
  });

  it("get returns the canonical record for the owner", async () => {
    const db = createMockDb({});
    vi.mocked(getDb).mockReturnValue(db);
    const caller = intelligenceRouter.createCaller(buildCtx());

    const accepted = await caller.interpret({ businessId: 7, signal: SPAM_SIGNAL });
    const fetched = await caller.get({ interpretationId: accepted.record.interpretationId });
    expect(fetched).toEqual(accepted.record);
  });

  it("get is NOT_FOUND when the interpretation belongs to another user", async () => {
    const foreignRow = {
      id: 1,
      userId: 999,
      businessId: 7,
      signalId: "sig-x",
      signalVersion: 1,
      signalContentHash: "c".repeat(64),
      classifierVersion: "intent-sentiment-classifier/v1",
      interpretationId: "foreign-id",
      modelOrRuleSource: "RULE",
      intent: "spam",
      sentiment: "neutral",
      urgency: "low",
      relevance: "not_relevant",
      overallConfidence: "high",
      recommendedHandling: "no_action",
      billingIdentity: null,
      record: { interpretationId: "foreign-id", userId: 999 },
      createdAt: new Date("2026-06-01T00:00:00Z"),
    };
    const db = createMockDb({ interpretationRows: [foreignRow] });
    vi.mocked(getDb).mockReturnValue(db);

    const caller = intelligenceRouter.createCaller(buildCtx());
    await expect(caller.get({ interpretationId: "foreign-id" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("listForSignal returns ordered canonical records for an owned business", async () => {
    const db = createMockDb({});
    vi.mocked(getDb).mockReturnValue(db);
    const caller = intelligenceRouter.createCaller(buildCtx());

    await caller.interpret({ businessId: 7, signal: SPAM_SIGNAL });
    await caller.interpret({
      businessId: 7,
      signal: { ...SPAM_SIGNAL, signalId: "sig-router-1", signalVersion: 2 },
    });

    const records = await caller.listForSignal({ businessId: 7, signalId: "sig-router-1" });
    expect(records).toHaveLength(2);
    expect((records[0] as any).signalVersion).toBe(1);
    expect((records[1] as any).signalVersion).toBe(2);
  });

  it("listForSignal refuses a foreign business", async () => {
    const db = createMockDb({ businessesRows: [{ id: 7, userId: 999 }] });
    vi.mocked(getDb).mockReturnValue(db);

    const caller = intelligenceRouter.createCaller(buildCtx());
    await expect(
      caller.listForSignal({ businessId: 7, signalId: "sig-router-1" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
