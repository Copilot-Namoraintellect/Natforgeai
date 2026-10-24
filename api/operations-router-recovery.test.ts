import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb must not fall back to a real connection in R5 operations tests");
  }),
}));

vi.mock("./lib/logger", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import { getDb } from "./queries/connection";
import {
  __setNextCycleDispatchBoundariesForTests,
  operationsRouter,
} from "./operations-router";
import type { StrategyApprovalLineage } from "./lib/workflow/strategy-approval";

/* ── In-memory drizzle evaluator (table-name-keyed), extended with
     update().set().where() and insert().values() so the REAL delegated
     authorities (terminal replay D1, next-cycle persistence/dispatcher) run
     against it. No authority module is mocked. ── */

function tableName(table: unknown): string {
  return (table as Record<symbol, string>)[Symbol.for("drizzle:Name")] ?? "unknown";
}

/** Extract the first column ref and `$.json.path` inside a sql`` fragment. */
function extractRef(sql: any): { col: string | null; path: string | null } {
  let col: string | null = null;
  let path: string | null = null;
  for (const chunk of sql?.queryChunks ?? []) {
    if (chunk && typeof chunk === "object") {
      if (typeof chunk.name === "string" && chunk.table) {
        col = chunk.name;
      } else if (Array.isArray(chunk.value)) {
        const m = chunk.value.join("").match(/\$\.([A-Za-z0-9_.]+)/);
        if (m) path = m[1];
      }
    }
  }
  return { col, path };
}

function getPathValue(value: unknown, path: string | null): unknown {
  if (!path) return value;
  let current: unknown = value;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Evaluates eq()/and()/isNull() where-clauses. Nested sql fragments (the
 * workflowContext JSON_EXTRACT CAS guards) are recursed into and their
 * column/path ref retained for a following param comparison. Everything is
 * ANDed (the governed authorities only use and()).
 */
function evalCond(cond: any, row: any): boolean {
  const chunks: any[] = cond?.queryChunks ?? [];
  let ok = true;
  let col: string | null = null;
  let path: string | null = null;
  for (const chunk of chunks) {
    if (chunk == null) continue;
    if (Array.isArray(chunk.queryChunks)) {
      if (!evalCond(chunk, row)) ok = false;
      const ref = extractRef(chunk);
      if (ref.col) col = ref.col;
      if (ref.path) path = ref.path;
      continue;
    }
    if (typeof chunk !== "object") continue;
    if (typeof chunk.name === "string" && chunk.table) {
      col = chunk.name;
      continue;
    }
    if (Array.isArray(chunk.value)) {
      const text = chunk.value.join("");
      if (/is\s+null/i.test(text)) {
        if (getPathValue(row[col ?? ""], path) != null) ok = false;
        col = null;
        path = null;
      }
      continue;
    }
    if ("value" in chunk) {
      if (getPathValue(row[col ?? ""], path) !== chunk.value) ok = false;
      col = null;
      path = null;
      continue;
    }
  }
  return ok;
}

interface FakeDbOptions {
  /** When set, the next audit_events insert fails with this error (fail-closed audit test). */
  failAuditInsert?: Error | null;
}

function createFakeDb(
  seed: Record<string, Record<string, unknown>[]>,
  options: FakeDbOptions = {}
) {
  const exec = (
    rows: any[],
    state: { cond?: any; orderDesc?: boolean; limit?: number; offset?: number }
  ) => {
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
  const duplicateKeyError = (message: string) => {
    const err = new Error(message) as Error & { code: string };
    err.code = "ER_DUP_ENTRY";
    return err;
  };
  const db = {
    select: (_fields?: unknown) => ({
      from: (table: unknown) => chain(seed[tableName(table)] ?? [], {}),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async (cond: any) => {
          const rows = seed[tableName(table)] ?? [];
          let affected = 0;
          for (const row of rows) {
            if (evalCond(cond, row)) {
              Object.assign(row, values);
              affected += 1;
            }
          }
          return [{ affectedRows: affected }];
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (row: Record<string, unknown>) => {
        const name = tableName(table);
        const rows = seed[name] ?? (seed[name] = []);
        if (name === "queue_replay_requests") {
          if (rows.some((r) => r.replayKey === row.replayKey)) {
            throw duplicateKeyError("Duplicate entry 'replayKey'");
          }
        }
        if (name === "audit_events") {
          if (options.failAuditInsert) throw options.failAuditInsert;
          if (rows.some((r) => r.eventFingerprint === row.eventFingerprint)) {
            throw duplicateKeyError("Duplicate entry 'eventFingerprint'");
          }
        }
        const id = rows.reduce((max, r) => Math.max(max, Number(r.id) || 0), 0) + 1;
        rows.push({ ...row, id });
        return [{ insertId: id, affectedRows: 1 }];
      },
    }),
    execute: vi.fn(),
  };
  return { db, seed };
}

/* ── Fixtures ─────────────────────────────────────────────────────────── */

function buildCtx(user: Record<string, unknown> | null) {
  return {
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
    user,
    session: user ? { userId: user.id, type: "local", verified: true } : undefined,
  } as never;
}

const ADMIN = { id: 7, role: "admin" };
const OWNER_USER_ID = 18;
const BUSINESS_ID = 6;
const CAMPAIGN_ID = 4;
const QUEUE_ITEM_ID = 5;
const TERMINAL_FAILURE_ID = 501;

function queueItemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: QUEUE_ITEM_ID,
    campaignId: CAMPAIGN_ID,
    status: "failed",
    retryCount: 3,
    maxRetries: 3,
    // Raw provider material that must never leak into responses or audit rows.
    lastError: "raw provider payload: Bearer abc123",
    ...overrides,
  };
}

function terminalFailureRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TERMINAL_FAILURE_ID,
    failureKey: "qtf:v1:publishing:publish-5",
    queueName: "publishing",
    bullmqJobId: "publish-5",
    terminalReason: "retries_exhausted",
    attemptsMade: 3,
    attemptsConfigured: 3,
    userId: OWNER_USER_ID,
    campaignId: CAMPAIGN_ID,
    publishingQueueItemId: QUEUE_ITEM_ID,
    agentRunId: null,
    errorCode: "provider_timeout",
    errorSummary: "raw provider text: token=secret-value",
    failedAt: new Date("2026-10-24T09:00:00.000Z"),
    status: "open",
    ...overrides,
  };
}

function baseSeed() {
  return {
    businesses: [{ id: BUSINESS_ID, userId: OWNER_USER_ID, name: "Acme" }],
    campaigns: [
      {
        id: CAMPAIGN_ID,
        userId: OWNER_USER_ID,
        businessId: BUSINESS_ID,
        name: "Summer Launch",
        workflowState: "campaign_live",
        workflowContext: {},
      },
    ],
    publishing_queue: [queueItemRow()],
    queue_terminal_failures: [terminalFailureRow()],
    queue_replay_requests: [],
    audit_events: [],
  } as Record<string, Record<string, unknown>[]>;
}

function useSeed(seed: Record<string, Record<string, unknown>[]>, options?: FakeDbOptions) {
  vi.mocked(getDb).mockReturnValue(createFakeDb(seed, options).db as never);
  return seed;
}

function makeLineage(): StrategyApprovalLineage {
  return {
    creativeBriefFingerprint: "fp_abc",
    strategyRunId: 900,
    strategySnapshotId: "snap_1",
    strategyVersion: 3,
    businessDnaSnapshotId: "dna_1",
    strategyHashSha256: "ab".repeat(32),
    approvalRequestId: 910,
    status: "pending",
  };
}

function useDispatchBoundaries() {
  const calls: { runStrategy: unknown[]; createStrategyReview: unknown[] } = {
    runStrategy: [],
    createStrategyReview: [],
  };
  __setNextCycleDispatchBoundariesForTests({
    runStrategy: async (input: unknown) => {
      calls.runStrategy.push(input);
      return { runId: 900 };
    },
    createStrategyReview: async (input: unknown) => {
      calls.createStrategyReview.push(input);
      return { approvalRequestId: 910, lineage: makeLineage() };
    },
  });
  return calls;
}

const ENV_KEY = "R5_OPERATION_RETRY_ADMIN_ENABLED";
const ORIGINAL_ENV = process.env[ENV_KEY];

beforeEach(() => {
  vi.clearAllMocks();
  process.env[ENV_KEY] = "true";
});

afterEach(() => {
  __setNextCycleDispatchBoundariesForTests(null);
});

afterAll(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_ENV;
});

/* ── 1/2. Authorization + kill switch ────────────────────────────────── */

describe("operations.retryOperation — authorization and kill switch (F5)", () => {
  it("rejects unauthenticated callers (UNAUTHORIZED)", async () => {
    useSeed(baseSeed());
    await expect(
      operationsRouter.createCaller(buildCtx(null)).retryOperation({
        operationKind: "publishing_queue_item",
        operationId: QUEUE_ITEM_ID,
      })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects verified non-admin callers (FORBIDDEN)", async () => {
    useSeed(baseSeed());
    await expect(
      operationsRouter.createCaller(buildCtx({ id: 9, role: "user" })).retryOperation({
        operationKind: "publishing_queue_item",
        operationId: QUEUE_ITEM_ID,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("fails closed when the kill switch is unset (SERVICE_UNAVAILABLE)", async () => {
    useSeed(baseSeed());
    delete process.env[ENV_KEY];
    await expect(
      operationsRouter.createCaller(buildCtx(ADMIN)).retryOperation({
        operationKind: "publishing_queue_item",
        operationId: QUEUE_ITEM_ID,
      })
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });

  it("rejects malformed identifiers before any recovery attempt", async () => {
    useSeed(baseSeed());
    const caller = operationsRouter.createCaller(buildCtx(ADMIN));
    await expect(
      caller.retryOperation({ operationKind: "publishing_queue_item", operationId: 0 })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.retryOperation({
        operationKind: "not_a_kind" as never,
        operationId: QUEUE_ITEM_ID,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

/* ── 3/4/5. publishing_queue_item recovery ───────────────────────────── */

describe("operations.retryOperation — publishing_queue_item (F5)", () => {
  it("requeues a failed item through terminal replay; duplicate call converges", async () => {
    const seed = useSeed(baseSeed());
    const caller = operationsRouter.createCaller(buildCtx(ADMIN));

    const first = await caller.retryOperation({
      operationKind: "publishing_queue_item",
      operationId: QUEUE_ITEM_ID,
      reason: "operator recovery",
    });
    expect(first).toMatchObject({
      outcome: "requeued",
      operationKind: "publishing_queue_item",
      operationId: QUEUE_ITEM_ID,
      currentStatus: "failed",
    });
    expect(typeof first.replayRequestId).toBe("number");

    // Durable replay request anchored on the OPEN terminal failure with the
    // deterministic server-derived replayKey and the durable owner identity.
    expect(seed.queue_replay_requests).toHaveLength(1);
    expect(seed.queue_replay_requests[0]).toMatchObject({
      terminalFailureId: TERMINAL_FAILURE_ID,
      replayKey: `r5f:op-retry:pqi:${QUEUE_ITEM_ID}`,
      requestedByUserId: OWNER_USER_ID,
      status: "requested",
      replayMode: "publishing_requeue",
      reason: "operator recovery",
    });

    // Exactly one canonical audit event for the one real mutation.
    expect(seed.audit_events).toHaveLength(1);
    expect(seed.audit_events[0]).toMatchObject({
      eventType: "admin_mutation",
      userId: ADMIN.id,
      outcome: "succeeded",
      businessId: BUSINESS_ID,
      campaignId: CAMPAIGN_ID,
    });
    expect(seed.audit_events[0].metadata).toMatchObject({
      action: "admin.r5_operation_retry",
      targetType: "r5_operation",
      targetId: `publishing_queue_item:${QUEUE_ITEM_ID}`,
      operationKind: "publishing_queue_item",
      operationId: QUEUE_ITEM_ID,
      outcome: "requeued",
      currentStatusBefore: "failed",
    });

    // Second identical call: replayKey uniqueness collapses it — no new row,
    // no new audit event.
    const second = await caller.retryOperation({
      operationKind: "publishing_queue_item",
      operationId: QUEUE_ITEM_ID,
      reason: "operator recovery",
    });
    expect(second).toMatchObject({
      outcome: "already_recovering",
      replayRequestId: first.replayRequestId,
    });
    expect(seed.queue_replay_requests).toHaveLength(1);
    expect(seed.audit_events).toHaveLength(1);
  });

  it("published / safety_blocked reject; retrying converges without mutation", async () => {
    const published = baseSeed();
    published.publishing_queue = [queueItemRow({ status: "published" })];
    useSeed(published);
    const caller = operationsRouter.createCaller(buildCtx(ADMIN));
    await expect(
      caller.retryOperation({
        operationKind: "publishing_queue_item",
        operationId: QUEUE_ITEM_ID,
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("duplicate publication"),
    });

    const blocked = baseSeed();
    blocked.publishing_queue = [queueItemRow({ status: "safety_blocked" })];
    useSeed(blocked);
    await expect(
      caller.retryOperation({
        operationKind: "publishing_queue_item",
        operationId: QUEUE_ITEM_ID,
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("approval flow"),
    });

    const retrying = baseSeed();
    retrying.publishing_queue = [queueItemRow({ status: "retrying" })];
    useSeed(retrying);
    const result = await caller.retryOperation({
      operationKind: "publishing_queue_item",
      operationId: QUEUE_ITEM_ID,
    });
    expect(result).toMatchObject({ outcome: "already_recovering", currentStatus: "retrying" });
    // No mutation, no audit for no-op convergence.
    expect(retrying.queue_replay_requests).toHaveLength(0);
    expect(retrying.audit_events).toHaveLength(0);
  });

  it("rejects a failed item with no durable terminal failure record", async () => {
    const seed = baseSeed();
    seed.queue_terminal_failures = [];
    useSeed(seed);
    await expect(
      operationsRouter.createCaller(buildCtx(ADMIN)).retryOperation({
        operationKind: "publishing_queue_item",
        operationId: QUEUE_ITEM_ID,
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "No durable terminal failure anchors a replay for this queue item.",
    });
  });

  it("rejects a queue item whose campaign is unresolvable", async () => {
    const seed = baseSeed();
    seed.publishing_queue = [queueItemRow({ campaignId: 9999 })];
    useSeed(seed);
    await expect(
      operationsRouter.createCaller(buildCtx(ADMIN)).retryOperation({
        operationKind: "publishing_queue_item",
        operationId: QUEUE_ITEM_ID,
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "queue item has no resolvable campaign",
    });
  });
});

/* ── 6. terminal_failure recovery ────────────────────────────────────── */

describe("operations.retryOperation — terminal_failure (F5)", () => {
  it("requeues an open terminal failure; duplicate converges", async () => {
    const seed = useSeed(baseSeed());
    const caller = operationsRouter.createCaller(buildCtx(ADMIN));

    const first = await caller.retryOperation({
      operationKind: "terminal_failure",
      operationId: TERMINAL_FAILURE_ID,
    });
    expect(first).toMatchObject({
      outcome: "requeued",
      currentStatus: "open",
    });
    expect(seed.queue_replay_requests).toHaveLength(1);
    expect(seed.queue_replay_requests[0]).toMatchObject({
      replayKey: `r5f:op-retry:tf:${TERMINAL_FAILURE_ID}`,
      terminalFailureId: TERMINAL_FAILURE_ID,
      requestedByUserId: OWNER_USER_ID,
    });
    expect(seed.audit_events).toHaveLength(1);

    const second = await caller.retryOperation({
      operationKind: "terminal_failure",
      operationId: TERMINAL_FAILURE_ID,
    });
    expect(second).toMatchObject({ outcome: "already_recovering" });
    expect(seed.queue_replay_requests).toHaveLength(1);
    expect(seed.audit_events).toHaveLength(1);
  });

  it("CONFLICT when the terminal failure is no longer open", async () => {
    const seed = baseSeed();
    seed.queue_terminal_failures = [terminalFailureRow({ status: "resolved" })];
    useSeed(seed);
    await expect(
      operationsRouter.createCaller(buildCtx(ADMIN)).retryOperation({
        operationKind: "terminal_failure",
        operationId: TERMINAL_FAILURE_ID,
      })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "terminal failure is not open",
    });
    expect(seed.queue_replay_requests).toHaveLength(0);
    expect(seed.audit_events).toHaveLength(0);
  });
});

/* ── 7. next_cycle_instruction recovery ──────────────────────────────── */

describe("operations.retryOperation — next_cycle_instruction (F5)", () => {
  const NC_CAMPAIGN_ID = 30;

  function ncSeed(nextCycle: unknown) {
    const seed = baseSeed();
    seed.campaigns.push({
      id: NC_CAMPAIGN_ID,
      userId: OWNER_USER_ID,
      businessId: BUSINESS_ID,
      name: "Autumn Relaunch",
      workflowState: "optimisation_active",
      workflowContext:
        nextCycle === null ? {} : { learningRuns: 2, nextCycle },
    });
    return seed;
  }

  function ncCaller() {
    return operationsRouter.createCaller(buildCtx(ADMIN));
  }

  it("failed instruction is CAS-retried and dispatched through the real dispatcher", async () => {
    const seed = ncSeed({ instructionId: "nci_1", status: "failed" });
    useSeed(seed);
    const calls = useDispatchBoundaries();

    const result = await ncCaller().retryOperation({
      operationKind: "next_cycle_instruction",
      operationId: NC_CAMPAIGN_ID,
      reason: "restart governed cycle",
    });

    expect(result).toMatchObject({
      outcome: "dispatched",
      operationKind: "next_cycle_instruction",
      operationId: NC_CAMPAIGN_ID,
      currentStatus: "failed",
    });
    expect(result).not.toHaveProperty("replayRequestId");

    // The real dispatcher claimed and consumed the instruction exactly once.
    expect(calls.runStrategy).toHaveLength(1);
    expect(calls.createStrategyReview).toHaveLength(1);

    // Durable terminal state: instruction dispatched, lineage restored,
    // preserved-superset context fields intact.
    const campaign = seed.campaigns.find((c) => c.id === NC_CAMPAIGN_ID)!;
    const context = campaign.workflowContext as Record<string, unknown>;
    expect(context.nextCycle).toEqual({ instructionId: "nci_1", status: "dispatched" });
    expect(context.learningRuns).toBe(2);
    expect(context.strategyApprovalLineage).toMatchObject({
      strategyRunId: 900,
      approvalRequestId: 910,
    });

    // Exactly one audit event for the one real recovery mutation.
    expect(seed.audit_events).toHaveLength(1);
    expect(seed.audit_events[0].metadata).toMatchObject({
      action: "admin.r5_operation_retry",
      targetType: "r5_operation",
      targetId: `next_cycle_instruction:${NC_CAMPAIGN_ID}`,
      outcome: "dispatched",
      currentStatusBefore: "failed",
    });
  });

  it("ready instruction dispatches directly; a dispatched instruction is a noop", async () => {
    const seed = ncSeed({ instructionId: "nci_2", status: "ready" });
    useSeed(seed);
    const calls = useDispatchBoundaries();

    const first = await ncCaller().retryOperation({
      operationKind: "next_cycle_instruction",
      operationId: NC_CAMPAIGN_ID,
    });
    expect(first).toMatchObject({ outcome: "dispatched", currentStatus: "ready" });
    expect(calls.runStrategy).toHaveLength(1);
    expect(seed.audit_events).toHaveLength(1);

    // Second call observes the durable dispatched state: pure convergence.
    const second = await ncCaller().retryOperation({
      operationKind: "next_cycle_instruction",
      operationId: NC_CAMPAIGN_ID,
    });
    expect(second).toMatchObject({ outcome: "noop", currentStatus: "dispatched" });
    expect(calls.runStrategy).toHaveLength(1); // never re-run
    expect(seed.audit_events).toHaveLength(1); // no event for no-op convergence
  });

  it("PRECONDITION_FAILED for absent or malformed next-cycle authority", async () => {
    const absent = ncSeed(null);
    useSeed(absent);
    await expect(
      ncCaller().retryOperation({
        operationKind: "next_cycle_instruction",
        operationId: NC_CAMPAIGN_ID,
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "campaign records no next-cycle instruction",
    });

    const malformed = ncSeed({ instructionId: "nci_3", status: "weird" });
    useSeed(malformed);
    await expect(
      ncCaller().retryOperation({
        operationKind: "next_cycle_instruction",
        operationId: NC_CAMPAIGN_ID,
      })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});

/* ── 8/9. Staleness + ownership assertions ───────────────────────────── */

describe("operations.retryOperation — staleness and ownership (F5)", () => {
  it("CONFLICT on expectedStatus mismatch; matching assertion passes", async () => {
    const seed = useSeed(baseSeed());
    const caller = operationsRouter.createCaller(buildCtx(ADMIN));

    await expect(
      caller.retryOperation({
        operationKind: "publishing_queue_item",
        operationId: QUEUE_ITEM_ID,
        expectedStatus: "published",
      })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "stale operation state: expected published, current failed",
    });

    const ok = await caller.retryOperation({
      operationKind: "publishing_queue_item",
      operationId: QUEUE_ITEM_ID,
      expectedStatus: "failed",
    });
    expect(ok).toMatchObject({ outcome: "requeued" });
    expect(seed.queue_replay_requests).toHaveLength(1);
  });

  it("FORBIDDEN on business assertion mismatch; matching assertion passes", async () => {
    const seed = useSeed(baseSeed());
    const caller = operationsRouter.createCaller(buildCtx(ADMIN));

    await expect(
      caller.retryOperation({
        operationKind: "publishing_queue_item",
        operationId: QUEUE_ITEM_ID,
        businessId: 9999,
      })
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "business assertion mismatch",
    });
    expect(seed.queue_replay_requests).toHaveLength(0);
    expect(seed.audit_events).toHaveLength(0);

    const ok = await caller.retryOperation({
      operationKind: "publishing_queue_item",
      operationId: QUEUE_ITEM_ID,
      businessId: BUSINESS_ID,
    });
    expect(ok).toMatchObject({ outcome: "requeued" });
    expect(seed.queue_replay_requests).toHaveLength(1);
  });
});

/* ── 10/11. Audit + secret hygiene ───────────────────────────────────── */

describe("operations.retryOperation — audit and secret hygiene (F5/F6)", () => {
  it("writes exactly one admin_mutation event per real mutation, nothing for no-ops", async () => {
    const seed = useSeed(baseSeed());
    const caller = operationsRouter.createCaller(buildCtx(ADMIN));

    await caller.retryOperation({
      operationKind: "terminal_failure",
      operationId: TERMINAL_FAILURE_ID,
    });
    await caller.retryOperation({
      operationKind: "terminal_failure",
      operationId: TERMINAL_FAILURE_ID,
    });
    await caller.retryOperation({
      operationKind: "publishing_queue_item",
      operationId: QUEUE_ITEM_ID,
    });

    expect(seed.audit_events).toHaveLength(2);
    for (const event of seed.audit_events) {
      expect(event).toMatchObject({ eventType: "admin_mutation", outcome: "succeeded" });
      const metadata = event.metadata as Record<string, unknown>;
      expect(metadata.action).toBe("admin.r5_operation_retry");
      expect(metadata.targetType).toBe("r5_operation");
      expect(typeof metadata.targetId).toBe("string");
    }
  });

  it("audit failure fails closed: the mutation error propagates loudly", async () => {
    const seed = useSeed(baseSeed(), {
      failAuditInsert: new Error("audit ledger unavailable"),
    });
    await expect(
      operationsRouter.createCaller(buildCtx(ADMIN)).retryOperation({
        operationKind: "publishing_queue_item",
        operationId: QUEUE_ITEM_ID,
      })
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });

    // The governed mutation itself committed; the endpoint refused to return
    // success without its ledger evidence. A retry converges via replayKey.
    expect(seed.queue_replay_requests).toHaveLength(1);
    expect(seed.audit_events).toHaveLength(0);
  });

  it("responses and audit metadata carry no tokens, credentials or payloads", async () => {
    const seed = useSeed(baseSeed());
    const caller = operationsRouter.createCaller(buildCtx(ADMIN));

    const replay = await caller.retryOperation({
      operationKind: "publishing_queue_item",
      operationId: QUEUE_ITEM_ID,
      reason: "operator recovery",
    });
    await caller.retryOperation({
      operationKind: "terminal_failure",
      operationId: TERMINAL_FAILURE_ID,
    });

    const forbidden = [
      "accessToken",
      "refreshToken",
      "password",
      "secret",
      "Bearer",
      "contentText",
      "raw provider",
      "token=",
      "lastError",
      "errorSummary",
    ];
    for (const value of [JSON.stringify(replay)]) {
      for (const term of forbidden) expect(value).not.toContain(term);
    }
    for (const event of seed.audit_events) {
      const serialized = JSON.stringify(event);
      for (const term of forbidden) expect(serialized).not.toContain(term);
    }
    expect(seed.audit_events).toHaveLength(2);
  });
});
