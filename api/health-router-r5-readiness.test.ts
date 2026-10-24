import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb must not fall back to a real connection in R5 readiness tests");
  }),
}));

vi.mock("./lib/governance/r5-stream-evidence", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./lib/governance/r5-stream-evidence")>();
  return {
    ...actual,
    readR5ListeningEvidence: vi.fn(),
  };
});

vi.mock("./lib/redis", () => ({
  isRedisConfigured: vi.fn(() => false),
  getRedisClient: vi.fn(),
}));

vi.mock("./lib/queue/bullmq", () => ({
  getPublishingQueueStats: vi.fn(),
  getPublishingWorker: vi.fn(),
}));

vi.mock("./lib/alerts", () => ({
  createAlert: vi.fn().mockResolvedValue(undefined),
  listAlerts: vi.fn(),
  acknowledgeAlert: vi.fn(),
  resolveAlerts: vi.fn(),
  getAlertSummary: vi.fn(),
}));

vi.mock("./lib/rate-limiter", () => ({
  rateLimitPublic: vi.fn().mockResolvedValue(undefined),
  rateLimitUser: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./lib/env", () => ({
  env: {
    postLiveLifecycleEnabled: false,
    postLiveLifecycleIntervalMs: 300_000,
    postLiveMetricsObservationEnabled: true,
    postLiveMetricsObservationIntervalMs: 300_000,
  },
}));

vi.mock("./lib/workflow/post-live-lifecycle-scheduler", () => ({
  getPostLiveLifecycleSchedulerStatus: vi.fn(),
}));

vi.mock("./lib/workflow/post-live-metrics-observation-scheduler", () => ({
  getPostLiveMetricsObservationSchedulerStatus: vi.fn(),
}));

vi.mock("./lib/logger", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import { getDb } from "./queries/connection";
import { healthRouter } from "./health-router";
import {
  readR5InterpretationRollup,
  readR5ListeningEvidence,
  readR5ListeningRollup,
  readR5OpportunityRollup,
} from "./lib/governance/r5-stream-evidence";

const mockedListening = vi.mocked(readR5ListeningEvidence);

function tableName(table: unknown): string {
  return (table as Record<symbol, string>)[Symbol.for("drizzle:Name")] ?? "unknown";
}

function unwrapParam(value: any): any {
  if (value && typeof value === "object" && !Array.isArray(value) && "value" in value) {
    return value.value;
  }
  return value;
}

function evalCond(cond: any, row: any): boolean {
  const chunks: any[] = cond?.queryChunks ?? [];
  if (chunks.length === 0) return true;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk && Array.isArray(chunk.queryChunks)) {
      if (!evalCond(chunk, row)) return false;
      continue;
    }
    if (chunk && typeof chunk === "object" && typeof chunk.name === "string" && chunk.table) {
      const value = unwrapParam(chunks[i + 2]);
      if (Array.isArray(value)) {
        const values = value.map(unwrapParam);
        if (!values.includes(row[chunk.name])) return false;
      } else if (row[chunk.name] !== value) {
        return false;
      }
      i += 2;
      continue;
    }
  }
  return true;
}

/**
 * In-memory drizzle-SQL evaluator over table-name-keyed seed rows (same
 * idiom as the operator control plane tests) PLUS a controllable
 * `db.execute` for the raw-SQL evidence bridge (information_schema guard +
 * bounded aggregate rollups).
 */
function createFakeDb(seed: Record<string, Record<string, unknown>[]>) {
  const exec = (rows: any[], state: { cond?: any; orderDesc?: boolean; limit?: number; offset?: number }) => {
    let out = rows;
    if (state.cond) out = out.filter((r) => evalCond(state.cond, r));
    if (state.orderDesc) out = [...out].sort((a, b) => Number(b.id) - Number(a.id));
    if (state.offset) out = out.slice(state.offset);
    if (state.limit != null) out = out.slice(0, state.limit);
    return Promise.resolve(out);
  };
  const chain = (rows: any[], state: any): any => ({
    where: (cond: any) => chain(rows, { ...state, cond }),
    orderBy: (_order: any) => chain(rows, { ...state, orderDesc: true }),
    limit: (n: number) => chain(rows, { ...state, limit: n }),
    offset: (n: number) => chain(rows, { ...state, offset: n }),
    then: (onF: any, onR: any) => exec(rows, state).then(onF, onR),
  });
  const db = {
    select: (_fields?: unknown) => ({
      from: (table: unknown) => chain(seed[tableName(table)] ?? [], {}),
    }),
    execute: vi.fn(),
  };
  return { db, seed };
}

function buildCtx(user: Record<string, unknown> | null) {
  return {
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
    user,
    session: user ? { userId: user.id, type: "local", verified: true } : undefined,
  } as never;
}

/**
 * Rebuild `{ text, params }` from a drizzle SQL object (this drizzle build
 * embeds interpolated values raw into `queryChunks`: StringChunk arrays carry
 * text, primitives/Date values are the params).
 */
function describeExecuteQuery(query: any): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  const walk = (chunks: any[]): string =>
    chunks
      .map((chunk) => {
        if (chunk === null || chunk === undefined) return "";
        if (Array.isArray(chunk?.value)) return String(chunk.value.join(""));
        if (Array.isArray(chunk?.queryChunks)) return walk(chunk.queryChunks);
        if (typeof chunk === "object") {
          if (typeof chunk.name === "string" && chunk.table) return String(chunk.name);
          params.push(chunk);
          return "?";
        }
        params.push(chunk);
        return "?";
      })
      .join("");
  return { text: walk(query?.queryChunks ?? []), params };
}

/**
 * Seed-backed db.execute dispatch for every stream-bridge query
 * (information_schema guards + bounded aggregates), routed off the SQL text
 * instead of call ORDER — concurrent readiness areas and per-business
 * summary projections would otherwise skew mockResolvedValueOnce queues.
 * Tables absent from the seed report "absent" exactly like unexecuted
 * migrations (guard returns `{ c: 0 }`).
 */
function mockR5StreamBridgeExecute(fake: ReturnType<typeof createFakeDb>) {
  const time = (v: unknown) => new Date(String(v)).getTime();
  (fake.db.execute as ReturnType<typeof vi.fn>).mockImplementation((query: any) => {
    const { text, params } = describeExecuteQuery(query);
    if (text.includes("information_schema.tables")) {
      const table = String(params[params.length - 1]);
      return Promise.resolve([[{ c: fake.seed[table] != null ? 1 : 0 }]]);
    }
    const from = /FROM\s+([a-z0-9_]+)/i.exec(text)?.[1] ?? "";
    const rows = (fake.seed[from] ?? []) as Record<string, unknown>[];
    const windowStart = time(params.find((p) => p instanceof Date) ?? Date.now());
    if (from === "social_listening_states") {
      const byStatus = new Map<string, number>();
      for (const row of rows) {
        const key = String(row.status);
        byStatus.set(key, (byStatus.get(key) ?? 0) + 1);
      }
      return Promise.resolve(
        [[...byStatus.entries()].map(([status, c]) => ({ status, c }))]
      );
    }
    if (from === "social_signals") {
      return Promise.resolve([
        [{ c: rows.filter((r) => time(r.observedAt) >= windowStart).length }],
      ]);
    }
    if (from === "social_interpretations") {
      if (text.includes("COUNT(*) AS total")) {
        const last24h = rows.filter((r) => time(r.createdAt) >= windowStart);
        return Promise.resolve([
          [
            {
              total: rows.length,
              last24h: last24h.length,
              modelCount24h: last24h.filter((r) => r.modelOrRuleSource === "MODEL").length,
              ruleCount24h: last24h.filter((r) => r.modelOrRuleSource === "RULE").length,
              latestObservedAt: rows.length
                ? new Date(Math.max(...rows.map((r) => time(r.createdAt))))
                : null,
            },
          ],
        ]);
      }
      const [businessId, userId] = params;
      return Promise.resolve([
        [
          {
            c: rows.filter(
              (r) =>
                (Number(r.businessId) === Number(businessId) ||
                  (r.businessId == null && Number(r.userId) === Number(userId))) &&
                time(r.createdAt) >= windowStart
            ).length,
          },
        ],
      ]);
    }
    if (from === "opportunity_candidates") {
      const scoped = text.includes("businessId")
        ? rows.filter(
            (r) =>
              Number(r.businessId) === Number(params[0]) ||
              (r.businessId == null && Number(r.userId) === Number(params[1]))
          )
        : rows;
      const count = (pred: (r: Record<string, unknown>) => boolean) =>
        scoped.filter(pred).length;
      return Promise.resolve([
        [
          {
            candidates: scoped.length,
            openCandidates: count((r) => r.opportunityStatus !== "handed_off_to_r6"),
            handedOff: count((r) => r.opportunityStatus === "handed_off_to_r6"),
            last24h: count((r) => time(r.createdAt) >= windowStart),
            latestObservedAt: scoped.length
              ? new Date(Math.max(...scoped.map((r) => time(r.updatedAt))))
              : null,
          },
        ],
      ]);
    }
    return Promise.resolve([[]]);
  });
}

const ADMIN = { id: 7, role: "admin" };
const NOW = new Date("2026-10-24T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

const LISTENING_ABSENT = { available: false, reason: "stream_tables_absent", bindings: [] };

/**
 * Six-business fixture exercising every readiness counter/component:
 *  - biz 15 (user 105): pending approval + exhausted wallet -> BLOCKED_OPERATOR (2 blockers)
 *  - biz 14 (user 104): pending approval                     -> BLOCKED_OPERATOR (1 blocker)
 *  - biz 13 (user 103): failed queue item (security code) + open terminal failure
 *                                                          -> FAIL_CLOSED (2 blockers)
 *  - biz 12: no evidence                                     -> UNSUPPORTED
 *  - biz 11 (user 101): exhausted wallet + safety-blocked queue item
 *                                             -> BLOCKED_OPERATOR (2 blockers)
 *  - biz 10: no evidence                                     -> UNSUPPORTED
 */
function baseSeed() {
  return {
    businesses: [
      { id: 10, userId: 100, name: "Acme" },
      { id: 11, userId: 101, name: "Beta" },
      { id: 12, userId: 102, name: "Gamma" },
      { id: 13, userId: 103, name: "Delta" },
      { id: 14, userId: 104, name: "Epsilon" },
      { id: 15, userId: 105, name: "Zeta" },
    ],
    campaigns: [
      { id: 1001, businessId: 11, userId: 101, workflowState: "campaign_live", workflowContext: {} },
      { id: 1003, businessId: 13, userId: 103, workflowState: "campaign_live", workflowContext: {} },
      { id: 1004, businessId: 14, userId: 104, workflowState: "campaign_live", workflowContext: {} },
      { id: 1005, businessId: 15, userId: 105, workflowState: "campaign_live", workflowContext: {} },
    ],
    social_integrations: [
      { id: 8001, businessId: 11, userId: 101, platform: "instagram", status: "expired" },
    ],
    // Stream-bridge aggregates are evaluated from these rows by
    // mockR5StreamBridgeExecute (timestamps relative to the real clock
    // because getR5OperationsReadiness derives its own `now`).
    social_listening_states: [
      { id: 8001, status: "active" },
      { id: 8002, status: "active" },
      { id: 8003, status: "blocked" },
    ],
    social_signals: [
      ...Array.from({ length: 7 }, (_, i) => ({
        id: 9000 + i,
        observedAt: new Date(Date.now() - (i + 1) * 60 * 60 * 1000),
      })),
      { id: 9099, observedAt: new Date(Date.now() - 48 * 60 * 60 * 1000) },
    ],
    credit_wallets: [
      { id: 1, userId: 101, balance: 0 },
      { id: 2, userId: 105, balance: 0 },
      { id: 3, userId: 104, balance: 500 },
    ],
    approval_requests: [
      {
        id: 9001,
        userId: 104,
        campaignId: null,
        status: "pending",
        approvalType: "sensitive_reply",
        riskLevel: "high",
        createdAt: new Date(NOW.getTime() - HOUR_MS),
      },
      {
        id: 9002,
        userId: 105,
        campaignId: null,
        status: "pending",
        approvalType: "campaign_launch",
        riskLevel: "medium",
        createdAt: new Date(NOW.getTime() - 2 * HOUR_MS),
      },
    ],
    publishing_queue: [
      { id: 5001, campaignId: 1001, status: "safety_blocked" },
      { id: 5002, campaignId: 1001, status: "retrying" },
      {
        id: 5003,
        campaignId: 1003,
        status: "failed",
        lastError: "security_policy_denied",
      },
    ],
    queue_terminal_failures: [
      {
        id: 7001,
        campaignId: 1003,
        status: "open",
        queueName: "publishing",
        terminalReason: "retries_exhausted",
        errorCode: "provider_timeout",
        failedAt: new Date(NOW.getTime() - 3 * HOUR_MS),
      },
    ],
    queue_replay_requests: [
      { id: 6001, terminalFailureId: 7001, status: "requested" },
    ],
    creative_generation_claims: [],
    credit_reservations: [],
    user_usage: [],
    subscriptions: [],
    subscription_tiers: [],
  } as Record<string, Record<string, unknown>[]>;
}

function useSeed(seed: Record<string, Record<string, unknown>[]>) {
  const fake = createFakeDb(seed);
  vi.mocked(getDb).mockReturnValue(fake.db as never);
  return fake;
}

describe("health router — R5 readiness authorization (F3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedListening.mockResolvedValue(LISTENING_ABSENT as never);
  });

  it("rejects unauthenticated and non-admin callers", async () => {
    const fake = useSeed(baseSeed());
    mockR5StreamBridgeExecute(fake);

    await expect(
      healthRouter.createCaller(buildCtx(null)).getR5OperationsReadiness()
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      healthRouter.createCaller(buildCtx({ id: 9, role: "user" })).getR5OperationsReadiness()
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("health router — getR5OperationsReadiness (F3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedListening.mockResolvedValue(LISTENING_ABSENT as never);
  });

  it("rolls up components, counters and severity-ordered top blockers", async () => {
    const fake = useSeed(baseSeed());
    mockR5StreamBridgeExecute(fake);

    const result = await healthRouter
      .createCaller(buildCtx(ADMIN))
      .getR5OperationsReadiness();

    expect(typeof result.generatedAt).toBe("string");
    expect(Number.isNaN(Date.parse(result.generatedAt))).toBe(false);
    expect(result.components).toEqual({
      listening: "blocked", // one blocked binding
      interpretation: "unavailable", // B tables not seeded (migration unexecuted)
      engagement: "blocked", // safety_blocked item present
      opportunity: "unavailable", // D tables not seeded (migration unexecuted)
      policy: "attention", // 2 pending approvals
      queueRecovery: "attention", // 1 open terminal failure
      billingQuota: "blocked", // 2 exhausted wallets
      providerSupport: "attention", // 1 expired integration
    });
    expect(result.counters).toEqual({
      businesses: 6,
      listeningBindingsActive: 2,
      listeningBindingsBlocked: 1,
      signalsLast24h: 7,
      interpretationsLast24h: 0,
      opportunityCandidatesOpen: 0,
      pendingApprovals: 2,
      safetyBlockedItems: 1,
      retryingItems: 1,
      openTerminalFailures: 1,
      openReplayRequests: 1,
      walletsExhausted: 2,
    });

    // Severity order: FAIL_CLOSED > BLOCKED_OPERATOR (more blockers first) >
    // BLOCKED_CONFIGURATION > UNSUPPORTED (newer id first on ties). Biz 11
    // carries both a safety-blocked queue item and an exhausted wallet, so it
    // outranks biz 14 (approval backlog only) on blocker count.
    expect(result.topBlockedBusinesses.map((b) => b.businessId)).toEqual([
      13, 15, 11, 14, 12, 10,
    ]);
    expect(result.topBlockedBusinesses[0]).toEqual({
      businessId: 13,
      health: "FAIL_CLOSED",
      blockerClasses: expect.arrayContaining(["SECURITY_REJECTION", "STALE_OPERATION"]),
    });
    expect(result.topBlockedBusinesses[1].blockerClasses).toHaveLength(2);
    expect(result.topBlockedBusinesses[2].blockerClasses).toHaveLength(2);
    expect(result.truncated).toBe(false);

    const serialized = JSON.stringify(result);
    for (const forbidden of ["accessToken", "refreshToken", "password", "secret", "contentText"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("reports listening as unavailable when A's tables are absent", async () => {
    const seed = baseSeed();
    delete seed.social_listening_states;
    delete seed.social_signals;
    const fake = useSeed(seed);
    mockR5StreamBridgeExecute(fake);

    const result = await healthRouter
      .createCaller(buildCtx(ADMIN))
      .getR5OperationsReadiness();

    expect(result.components.listening).toBe("unavailable");
    expect(result.counters.listeningBindingsActive).toBe(0);
    expect(result.counters.listeningBindingsBlocked).toBe(0);
    expect(result.counters.signalsLast24h).toBe(0);
    // Counter areas that do not depend on A still report honestly.
    expect(result.counters.pendingApprovals).toBe(2);
    expect(result.counters.businesses).toBe(6);
  });

  it("reports ready components when no attention signals exist", async () => {
    const seed = baseSeed();
    seed.approval_requests = [];
    seed.publishing_queue = [];
    seed.queue_terminal_failures = [];
    seed.queue_replay_requests = [];
    seed.credit_wallets = [{ id: 3, userId: 104, balance: 500 }];
    seed.social_integrations = [];
    seed.campaigns = [];
    seed.businesses = [{ id: 20, userId: 200, name: "Solo" }];
    seed.social_listening_states = [{ id: 8001, status: "active" }];
    delete seed.social_signals;
    const fake = useSeed(seed);
    mockR5StreamBridgeExecute(fake);

    const result = await healthRouter
      .createCaller(buildCtx(ADMIN))
      .getR5OperationsReadiness();

    expect(result.components).toMatchObject({
      listening: "ready",
      engagement: "ready",
      policy: "ready",
      queueRecovery: "ready",
      billingQuota: "ready",
      providerSupport: "ready",
    });
    expect(result.counters.walletsExhausted).toBe(0);
    expect(result.counters.businesses).toBe(1);
    // Solo has no R5 capability evidence at all -> UNSUPPORTED, still listed.
    expect(result.topBlockedBusinesses).toEqual([
      { businessId: 20, health: "UNSUPPORTED", blockerClasses: [] },
    ]);
  });

  it("bounds the projected business window and flags truncation", async () => {
    const fake = useSeed(baseSeed());
    mockR5StreamBridgeExecute(fake);

    const result = await healthRouter
      .createCaller(buildCtx(ADMIN))
      .getR5OperationsReadiness({ businessLimit: 2 });

    expect(result.counters.businesses).toBe(6); // total, not window
    expect(result.truncated).toBe(true);
    // Only the two most-recent businesses were projected (both BLOCKED_OPERATOR).
    expect(result.topBlockedBusinesses.map((b) => b.businessId)).toEqual([15, 14]);
  });

  it("rejects out-of-range businessLimit values", async () => {
    const fake = useSeed(baseSeed());
    mockR5StreamBridgeExecute(fake);
    const caller = healthRouter.createCaller(buildCtx(ADMIN));
    await expect(caller.getR5OperationsReadiness({ businessLimit: 0 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(caller.getR5OperationsReadiness({ businessLimit: 101 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("reads interpretation and opportunity rollups when B/D tables are present", async () => {
    const seed = baseSeed();
    seed.approval_requests = [];
    seed.publishing_queue = [];
    seed.queue_terminal_failures = [];
    seed.queue_replay_requests = [];
    seed.credit_wallets = [];
    seed.social_integrations = [];
    seed.campaigns = [];
    seed.businesses = [{ id: 20, userId: 200, name: "Solo" }];
    seed.social_interpretations = [
      { id: 1, userId: 200, businessId: 20, modelOrRuleSource: "MODEL", createdAt: new Date(Date.now() - 2 * HOUR_MS) },
      { id: 2, userId: 200, businessId: 20, modelOrRuleSource: "RULE", createdAt: new Date(Date.now() - 5 * HOUR_MS) },
      { id: 3, userId: 200, businessId: 20, modelOrRuleSource: "MODEL", createdAt: new Date(Date.now() - 48 * HOUR_MS) },
      // Tenant-scoped row (businessId null) attributed by userId only.
      { id: 4, userId: 200, businessId: null, modelOrRuleSource: "RULE", createdAt: new Date(Date.now() - HOUR_MS) },
    ];
    seed.opportunity_candidates = [
      { id: 1, userId: 200, businessId: 20, opportunityStatus: "candidate", createdAt: new Date(Date.now() - 3 * HOUR_MS), updatedAt: new Date(Date.now() - 3 * HOUR_MS) },
      { id: 2, userId: 200, businessId: 20, opportunityStatus: "escalated", createdAt: new Date(Date.now() - 30 * HOUR_MS), updatedAt: new Date(Date.now() - 2 * HOUR_MS) },
      { id: 3, userId: 200, businessId: 20, opportunityStatus: "handed_off_to_r6", createdAt: new Date(Date.now() - 50 * HOUR_MS), updatedAt: new Date(Date.now() - 50 * HOUR_MS) },
      // Tenant-scoped candidate (businessId null) attributed by userId only.
      { id: 4, userId: 200, businessId: null, opportunityStatus: "candidate", createdAt: new Date(Date.now() - HOUR_MS), updatedAt: new Date(Date.now() - HOUR_MS) },
    ];
    const fake = useSeed(seed);
    mockR5StreamBridgeExecute(fake);

    const result = await healthRouter
      .createCaller(buildCtx(ADMIN))
      .getR5OperationsReadiness();

    expect(result.components.interpretation).toBe("ready");
    expect(result.components.opportunity).toBe("ready");
    // Rows 1, 2 and 4 are inside the 24h window; row 3 is stale.
    expect(result.counters.interpretationsLast24h).toBe(3);
    // Rows 1, 2 and 4 are open (!= handed_off_to_r6); row 3 is handed off.
    expect(result.counters.opportunityCandidatesOpen).toBe(3);

    // The per-business projection reads the same B/D scope, so a business
    // whose only R5 activity is B/D counts as a live capability (HEALTHY)
    // instead of UNSUPPORTED "await_capability_integration".
    expect(result.topBlockedBusinesses).toEqual([
      { businessId: 20, health: "HEALTHY", blockerClasses: [] },
    ]);

    const serialized = JSON.stringify(result);
    for (const forbidden of ["accessToken", "refreshToken", "password", "secret", "contentText"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe("readR5ListeningRollup — information_schema guarded aggregate", () => {
  it("returns bounded counts when both tables are present", async () => {
    const fake = createFakeDb({});
    (fake.db.execute as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([[{ c: 1 }]])
      .mockResolvedValueOnce([[{ c: 1 }]])
      .mockResolvedValueOnce([[{ status: "active", c: 4 }, { status: "blocked", c: 2 }, { status: "stale", c: 9 }]])
      .mockResolvedValueOnce([[{ c: 42 }]]);

    const rollup = await readR5ListeningRollup(fake.db as never, NOW);

    expect(rollup).toEqual({ available: true, active: 4, blocked: 2, signalsLast24h: 42 });
    expect(fake.db.execute).toHaveBeenCalledTimes(4);
  });

  it("returns available:false when A's migration has not run", async () => {
    const fake = createFakeDb({});
    (fake.db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce([[{ c: 0 }]]);

    const rollup = await readR5ListeningRollup(fake.db as never, NOW);

    expect(rollup).toEqual({
      available: false,
      reason: "stream_tables_absent",
      active: 0,
      blocked: 0,
      signalsLast24h: 0,
    });
    expect(fake.db.execute).toHaveBeenCalledTimes(1);
  });

  it("zeroes the signal window when the signals table is absent", async () => {
    const fake = createFakeDb({});
    (fake.db.execute as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([[{ c: 1 }]])
      .mockResolvedValueOnce([[{ c: 0 }]])
      .mockResolvedValueOnce([[{ status: "active", c: 1 }]]);

    const rollup = await readR5ListeningRollup(fake.db as never, NOW);

    expect(rollup).toEqual({ available: true, active: 1, blocked: 0, signalsLast24h: 0 });
    expect(fake.db.execute).toHaveBeenCalledTimes(3);
  });
});

describe("readR5InterpretationRollup — information_schema guarded aggregate", () => {
  it("returns bounded counts when the table is present", async () => {
    const fake = createFakeDb({});
    (fake.db.execute as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([[{ c: 1 }]])
      .mockResolvedValueOnce([[{
        total: 12,
        last24h: 5,
        modelCount24h: 3,
        ruleCount24h: 2,
        latestObservedAt: new Date(NOW.getTime() - HOUR_MS),
      }]]);

    const rollup = await readR5InterpretationRollup(fake.db as never, NOW);

    expect(rollup).toEqual({
      available: true,
      total: 12,
      last24h: 5,
      modelCount24h: 3,
      ruleCount24h: 2,
      latestObservedAt: new Date(NOW.getTime() - HOUR_MS),
    });
    expect(fake.db.execute).toHaveBeenCalledTimes(2);
  });

  it("returns available:false when B's migration has not run", async () => {
    const fake = createFakeDb({});
    (fake.db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce([[{ c: 0 }]]);

    const rollup = await readR5InterpretationRollup(fake.db as never, NOW);

    expect(rollup).toEqual({
      available: false,
      reason: "stream_tables_absent",
      total: 0,
      last24h: 0,
      modelCount24h: 0,
      ruleCount24h: 0,
      latestObservedAt: null,
    });
    expect(fake.db.execute).toHaveBeenCalledTimes(1);
  });
});

describe("readR5OpportunityRollup — information_schema guarded aggregate", () => {
  it("returns bounded status-class counts when the table is present", async () => {
    const fake = createFakeDb({});
    (fake.db.execute as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([[{ c: 1 }]])
      .mockResolvedValueOnce([[{
        candidates: 9,
        openCandidates: 6,
        handedOff: 3,
        last24h: 4,
        latestObservedAt: new Date(NOW.getTime() - HOUR_MS),
      }]]);

    const rollup = await readR5OpportunityRollup(fake.db as never, NOW);

    expect(rollup).toEqual({
      available: true,
      candidates: 9,
      openCandidates: 6,
      handedOff: 3,
      last24h: 4,
      latestObservedAt: new Date(NOW.getTime() - HOUR_MS),
    });
    expect(fake.db.execute).toHaveBeenCalledTimes(2);
  });

  it("returns available:false when D's migration has not run", async () => {
    const fake = createFakeDb({});
    (fake.db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce([[{ c: 0 }]]);

    const rollup = await readR5OpportunityRollup(fake.db as never, NOW);

    expect(rollup).toEqual({
      available: false,
      reason: "stream_tables_absent",
      candidates: 0,
      openCandidates: 0,
      handedOff: 0,
      last24h: 0,
      latestObservedAt: null,
    });
    expect(fake.db.execute).toHaveBeenCalledTimes(1);
  });
});
