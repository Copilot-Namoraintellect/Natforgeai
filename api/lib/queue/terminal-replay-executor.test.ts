import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../alerts", () => ({
  createAlert: vi.fn(async () => ({ id: 1 })),
}));

// Hard guard: a real Redis client must never be constructed here.
vi.mock("ioredis", () => ({
  Redis: class {
    constructor() {
      throw new Error("real Redis must never be constructed in replay-executor tests");
    }
  },
}));

// Billing tripwire: any billing mutation inside this slice fails the test.
vi.mock("../billing/credit-engine", () => ({
  deductCredits: vi.fn(async () => {
    throw new Error("billing must not be mutated by the replay executor");
  }),
  recordAiUsage: vi.fn(async () => {
    throw new Error("billing must not be mutated by the replay executor");
  }),
  checkCredits: vi.fn(async () => {
    throw new Error("billing must not be mutated by the replay executor");
  }),
  adminAdjustCredits: vi.fn(async () => {
    throw new Error("billing must not be mutated by the replay executor");
  }),
}));

// Queue seam: schedule/inspect/remove are mocked; pure helpers stay real.
vi.mock("./bullmq", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bullmq")>();
  return {
    ...actual,
    schedulePublishingJob: vi.fn(),
    scheduleContentGenerationJob: vi.fn(),
    inspectPublishingJob: vi.fn(),
    removePublishingJobById: vi.fn(),
  };
});

import {
  inspectPublishingJob,
  removePublishingJobById,
  scheduleContentGenerationJob,
  schedulePublishingJob,
  toPublishingBullMqJobId,
} from "./bullmq";
import {
  PublishingReplayValidationError,
  executePublishingTerminalReplay,
} from "./terminal-replay-executor";
import {
  claimTerminalReplayRequest,
  markTerminalReplayEnqueued,
  requestTerminalFailureReplay,
} from "./terminal-replay";
import type { TerminalReplayExecutor } from "./terminal-replay";

const NOW = new Date("2026-06-29T12:00:00.000Z");
const clock = () => NOW;

/* ── In-memory fake db (4 tables, journal transactions) ───────────── */

interface FakeState {
  failures: Map<number, any>;
  requests: Map<number, any>;
  activeClaims: Map<number, any>;
  publishing: Map<number, any>;
  creditTransactions: Map<number, any>;
}

function dupErr() {
  const err: any = new Error("Duplicate entry for key 'PRIMARY'");
  err.code = "ER_DUP_ENTRY";
  err.errno = 1062;
  return err;
}

function unwrapParam(value: any): any {
  if (value && typeof value === "object" && value.constructor?.name === "Param") {
    return value.value;
  }
  return value;
}

function evalCond(cond: any, row: any): boolean {
  if (!cond || typeof cond !== "object") return true;
  const chunks: any[] = cond.queryChunks ?? [];
  let i = 0;
  while (i < chunks.length) {
    const chunk = chunks[i];
    if (chunk && Array.isArray(chunk.queryChunks)) {
      if (!evalCond(chunk, row)) return false;
      i += 1;
      continue;
    }
    if (chunk && typeof chunk === "object" && typeof chunk.name === "string" && chunk.table) {
      const opChunk = chunks[i + 1];
      const op: string = String(opChunk?.value?.[0] ?? opChunk?.sql ?? "");
      const value = unwrapParam(chunks[i + 2]);
      const actual = row[chunk.name];
      if (op.trim() === "=") {
        if (actual !== value) return false;
      } else if (op.includes("<>")) {
        if (actual === value) return false;
      }
      i += 3;
      continue;
    }
    i += 1;
  }
  return true;
}

function tableName(table: any): string {
  return table[Symbol.for("drizzle:Name") as symbol] as string;
}

type Undo = () => void;

function makeClient(state: FakeState, journal?: Undo[]) {
  const record = (undo: Undo) => {
    journal?.push(undo);
  };

  const db: any = {
    insert: vi.fn((table: any) => ({
      values: vi.fn(async (values: any) => {
        const name = tableName(table);
        if (name === "queue_replay_requests") {
          const existing = Array.from(state.requests.values()).find(
            (r) => r.replayKey === values.replayKey
          );
          if (existing) throw dupErr();
          const id = 1000 + state.requests.size;
          const row = {
            id,
            createdAt: new Date("2026-01-01T00:00:00Z"),
            updatedAt: new Date("2026-01-01T00:00:00Z"),
            claimedAt: null,
            enqueuedAt: null,
            resolvedAt: null,
            failedAt: null,
            replayBullmqJobId: null,
            lastErrorSummary: null,
            ...values,
          };
          state.requests.set(id, row);
          record(() => state.requests.delete(id));
          return [{ insertId: id, affectedRows: 1 }];
        }
        if (name === "queue_replay_active_claims") {
          if (state.activeClaims.has(values.terminalFailureId)) throw dupErr();
          state.activeClaims.set(values.terminalFailureId, { ...values });
          record(() => state.activeClaims.delete(values.terminalFailureId));
          return [{ insertId: 0, affectedRows: 1 }];
        }
        throw new Error(`Unexpected insert into ${name}`);
      }),
    })),
    select: vi.fn((..._fields: any[]) => ({
      from: vi.fn((t: any) => {
        const name = tableName(t);
        return {
          where: vi.fn((cond: any) => ({
            limit: vi.fn(async (n: number) => {
              const rows =
                name === "queue_terminal_failures"
                  ? Array.from(state.failures.values())
                  : name === "queue_replay_requests"
                    ? Array.from(state.requests.values())
                    : name === "queue_replay_active_claims"
                      ? Array.from(state.activeClaims.values())
                      : name === "publishing_queue"
                        ? Array.from(state.publishing.values())
                        : name === "credit_transactions"
                          ? Array.from(state.creditTransactions.values())
                          : [];
              return rows.filter((r) => evalCond(cond, r)).slice(0, n);
            }),
          })),
        };
      }),
    })),
    update: vi.fn((table: any) => ({
      set: vi.fn((values: any) => ({
        where: vi.fn(async (cond: any) => {
          const name = tableName(table);
          const map =
            name === "queue_replay_requests"
              ? state.requests
              : name === "publishing_queue"
                ? state.publishing
                : null;
          if (!map) throw new Error(`Unexpected update on ${name}`);
          let affected = 0;
          for (const row of map.values()) {
            if (evalCond(cond, row)) {
              const before = { ...row };
              Object.assign(row, values);
              record(() => {
                for (const key of Object.keys(values)) row[key] = before[key];
              });
              affected++;
            }
          }
          return [{ affectedRows: affected }];
        }),
      })),
    })),
    delete: vi.fn((table: any) => ({
      where: vi.fn(async (cond: any) => {
        const name = tableName(table);
        if (name !== "queue_replay_active_claims") {
          throw new Error(`Unexpected delete on ${name}`);
        }
        let affected = 0;
        for (const [key, row] of Array.from(state.activeClaims.entries())) {
          if (evalCond(cond, row)) {
            state.activeClaims.delete(key);
            record(() => state.activeClaims.set(key, row));
            affected++;
          }
        }
        return [{ affectedRows: affected }];
      }),
    })),
    transaction: vi.fn(async (cb: any) => {
      const txJournal: Undo[] = [];
      const txClient = makeClient(state, txJournal);
      try {
        return await cb(txClient);
      } catch (err) {
        for (const undo of txJournal.reverse()) undo();
        throw err;
      }
    }),
  };
  return db;
}

function createFakeDb() {
  const state: FakeState = {
    failures: new Map(),
    requests: new Map(),
    activeClaims: new Map(),
    publishing: new Map(),
    creditTransactions: new Map(),
  };
  // Default durable billing evidence: exactly one publishing deduction
  // attributable to the default queue item (user 18 / TikTok).
  state.creditTransactions.set(1, {
    id: 1,
    userId: 18,
    walletId: 7,
    type: "publishing_deduction",
    amount: -1,
    balanceAfter: 99,
    description: "Publish to TikTok",
    metadata: { queueItemId: 5, platform: "TikTok", attempt: 1 },
    idempotencyKey: null,
    createdAt: new Date("2026-06-01T09:05:00Z"),
  });
  const client = makeClient(state);
  return {
    db: client as unknown as TerminalReplayExecutor,
    state,
  };
}

/* ── Fixtures ──────────────────────────────────────────────────────── */

const terminalFailure = {
  id: 501,
  failureKey: "qtf:v1:publishing:publish-5",
  queueName: "publishing",
  bullmqJobId: "publish-5",
  terminalReason: "retries_exhausted",
  attemptsMade: 3,
  attemptsConfigured: 3,
  userId: 18,
  campaignId: 4,
  publishingQueueItemId: 5,
  agentRunId: null,
  status: "open",
};

function publishingRow(overrides: Partial<any> = {}) {
  return {
    id: 5,
    userId: 18,
    campaignId: 4,
    contentPostId: 77,
    integrationId: 9,
    platform: "TikTok",
    scheduledAt: new Date("2026-06-01T10:00:00Z"),
    status: "failed",
    approvalRequired: false,
    publishedAt: null,
    externalPostId: null,
    retryCount: 2,
    maxRetries: 3,
    nextRetryAt: null,
    lastError: "original terminal error",
    safetyStatus: "low",
    safetyReasons: null,
    createdAt: new Date("2026-06-01T09:00:00Z"),
    ...overrides,
  };
}

async function seedReplayRequest(db: TerminalReplayExecutor, overrides: Partial<any> = {}) {
  return requestTerminalFailureReplay(
    {
      replayKey: "op:replay:publish-5",
      terminalFailureId: terminalFailure.id,
      requestedByUserId: 1,
      reason: "operator replay",
      ...overrides,
    },
    db
  );
}

function execute(db: TerminalReplayExecutor, overrides: Partial<any> = {}) {
  return executePublishingTerminalReplay({
    replayRequestId: 1000,
    requestedByUserId: 1,
    clock,
    executor: db,
    ...overrides,
  });
}

/* ── Tests ─────────────────────────────────────────────────────────── */

describe("executePublishingTerminalReplay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(schedulePublishingJob).mockReset().mockResolvedValue({} as any);
    vi.mocked(scheduleContentGenerationJob).mockReset().mockResolvedValue({} as any);
    vi.mocked(removePublishingJobById).mockReset().mockResolvedValue(true);
    vi.mocked(inspectPublishingJob)
      .mockReset()
      .mockResolvedValue({ exists: false, jobId: "publish-5", state: null, data: null, timestamp: null });
  });

  it("1. requested replay claims successfully before execution and reaches enqueued", async () => {
    const { db, state } = createFakeDb();
    state.failures.set(terminalFailure.id, { ...terminalFailure });
    state.publishing.set(5, publishingRow());
    const { record } = await seedReplayRequest(db);

    const result = await execute(db, { replayRequestId: record.id });

    expect(result).toMatchObject({ outcome: "enqueued", replayBullmqJobId: "publish-5" });
    const request = state.requests.get(record.id);
    expect(request.status).toBe("enqueued");
    expect(state.activeClaims.get(terminalFailure.id)).toMatchObject({ replayRequestId: record.id });
  });

  it("2. operator mismatch fails closed with zero Redis activity", async () => {
    const { db, state } = createFakeDb();
    state.failures.set(terminalFailure.id, { ...terminalFailure });
    state.publishing.set(5, publishingRow());
    const { record } = await seedReplayRequest(db);

    await expect(
      execute(db, { replayRequestId: record.id, requestedByUserId: 999 })
    ).rejects.toMatchObject({ code: "operator_mismatch" });
    expect(schedulePublishingJob).not.toHaveBeenCalled();
    expect(inspectPublishingJob).not.toHaveBeenCalled();
  });

  it("3. wrong replayMode fails closed", async () => {
    const { db, state } = createFakeDb();
    const contentFailure = {
      ...terminalFailure,
      id: 502,
      queueName: "content_generation",
      failureKey: "qtf:v1:content_generation:content-generation-9",
      bullmqJobId: "content-generation-9",
      publishingQueueItemId: null,
      agentRunId: 9,
      campaignId: 30,
    };
    state.failures.set(contentFailure.id, contentFailure);
    const { record } = await seedReplayRequest(db, {
      terminalFailureId: contentFailure.id,
      replayKey: "op:cg",
    });
    expect(record.replayMode).toBe("content_domain_recovery");

    await expect(execute(db, { replayRequestId: record.id })).rejects.toMatchObject({
      code: "wrong_replay_mode",
    });
    expect(schedulePublishingJob).not.toHaveBeenCalled();
  });

  it("4. copied terminal-failure identity is authoritative (tampered failureKey fails closed)", async () => {
    const { db, state } = createFakeDb();
    state.failures.set(terminalFailure.id, { ...terminalFailure });
    state.publishing.set(5, publishingRow());
    const { record } = await seedReplayRequest(db);
    // Tamper with the durable evidence after the request was created.
    state.failures.get(terminalFailure.id).failureKey = "qtf:v1:publishing:tampered";

    await expect(execute(db, { replayRequestId: record.id })).rejects.toMatchObject({
      code: "failure_key_mismatch",
    });
  });

  it("5. missing publishingQueueItemId fails closed", async () => {
    const { db, state } = createFakeDb();
    state.failures.set(terminalFailure.id, {
      ...terminalFailure,
      publishingQueueItemId: null,
    });
    state.publishing.set(5, publishingRow());
    const { record } = await seedReplayRequest(db);

    await expect(execute(db, { replayRequestId: record.id })).rejects.toMatchObject({
      code: "missing_publishing_queue_item_id",
    });
  });

  it("6. terminal failure BullMQ id mismatch fails closed", async () => {
    const { db, state } = createFakeDb();
    state.failures.set(terminalFailure.id, { ...terminalFailure, bullmqJobId: "rogue-job" });
    state.publishing.set(5, publishingRow());
    const { record } = await seedReplayRequest(db);

    await expect(execute(db, { replayRequestId: record.id })).rejects.toMatchObject({
      code: "deterministic_identity_mismatch",
    });
    expect(schedulePublishingJob).not.toHaveBeenCalled();
  });

  it("7. failed publishing row is guardedly rearmed to retrying, BullMQ-only (nextRetryAt null)", async () => {
    const { db, state } = createFakeDb();
    state.failures.set(terminalFailure.id, { ...terminalFailure });
    state.publishing.set(5, publishingRow());
    const { record } = await seedReplayRequest(db);

    await execute(db, { replayRequestId: record.id });

    const row = state.publishing.get(5);
    expect(row.status).toBe("retrying");
    expect(row.nextRetryAt).toBeNull();
  });

  it("8. retryCount, maxRetries, lastError and safety evidence are preserved", async () => {
    const { db, state } = createFakeDb();
    state.failures.set(terminalFailure.id, { ...terminalFailure });
    state.publishing.set(5, publishingRow({ retryCount: 2, maxRetries: 5, lastError: "keep me" }));
    const { record } = await seedReplayRequest(db);

    await execute(db, { replayRequestId: record.id });

    const row = state.publishing.get(5);
    expect(row.retryCount).toBe(2);
    expect(row.maxRetries).toBe(5);
    expect(row.lastError).toBe("keep me");
    expect(row.contentPostId).toBe(77);
    expect(row.safetyStatus).toBe("low");
  });

  it("9. replay rearm performs no billing mutation", async () => {
    const { db, state } = createFakeDb();
    state.failures.set(terminalFailure.id, { ...terminalFailure });
    state.publishing.set(5, publishingRow());
    const { record } = await seedReplayRequest(db);

    // billing module is a throwing tripwire; success proves it was untouched.
    await expect(execute(db, { replayRequestId: record.id })).resolves.toMatchObject({
      outcome: "enqueued",
    });
  });

  it.each(["safety_blocked", "pending_approval"])(
    "10/11. %s is not rearmed and fails closed with no Redis mutation",
    async (status) => {
      const { db, state } = createFakeDb();
      state.failures.set(terminalFailure.id, { ...terminalFailure });
      state.publishing.set(5, publishingRow({ status }));
      const { record } = await seedReplayRequest(db);

      await expect(execute(db, { replayRequestId: record.id })).rejects.toMatchObject({
        code: "state_not_replayable",
      });
      expect(state.publishing.get(5).status).toBe(status);
      expect(schedulePublishingJob).not.toHaveBeenCalled();
      expect(inspectPublishingJob).not.toHaveBeenCalled();
      expect(state.requests.get(record.id).status).toBe("failed");
    }
  );

  it("12. already-published row follows requested -> claimed -> resolved with zero Redis mutation and releases the guard", async () => {
    const { db, state } = createFakeDb();
    state.failures.set(terminalFailure.id, { ...terminalFailure });
    state.publishing.set(5, publishingRow({ status: "published", publishedAt: NOW }));
    const { record } = await seedReplayRequest(db);

    const result = await execute(db, { replayRequestId: record.id });

    expect(result.outcome).toBe("already_completed");
    expect(state.requests.get(record.id).status).toBe("resolved");
    expect(state.activeClaims.has(terminalFailure.id)).toBe(false);
    expect(schedulePublishingJob).not.toHaveBeenCalled();
    expect(inspectPublishingJob).not.toHaveBeenCalled();
    expect(removePublishingJobById).not.toHaveBeenCalled();
  });

  it("13. deterministic BullMQ id is used for scheduling (with ownership marker) and recorded on the request", async () => {
    const { db, state } = createFakeDb();
    state.failures.set(terminalFailure.id, { ...terminalFailure });
    state.publishing.set(5, publishingRow());
    const { record } = await seedReplayRequest(db);

    await execute(db, { replayRequestId: record.id });

    expect(toPublishingBullMqJobId(5)).toBe("publish-5");
    expect(schedulePublishingJob).toHaveBeenCalledTimes(1);
    expect(schedulePublishingJob).toHaveBeenCalledWith(5, 18, "TikTok", NOW, {
      replayRequestId: record.id,
    });
    expect(state.requests.get(record.id).replayBullmqJobId).toBe("publish-5");
  });

  it("14. stale terminal failed BullMQ job with matching durable identity may be removed then replaced (no marker required)", async () => {
    const { db, state } = createFakeDb();
    state.failures.set(terminalFailure.id, { ...terminalFailure });
    state.publishing.set(5, publishingRow());
    const { record } = await seedReplayRequest(db);
    vi.mocked(inspectPublishingJob).mockResolvedValue({
      exists: true,
      jobId: "publish-5",
      state: "failed",
      data: { queueItemId: 5, userId: 18, platform: "TikTok" },
      timestamp: 123,
    });

    const result = await execute(db, { replayRequestId: record.id });

    expect(result.outcome).toBe("enqueued");
    expect(removePublishingJobById).toHaveBeenCalledWith("publish-5");
    expect(schedulePublishingJob).toHaveBeenCalledTimes(1);
  });

  it("15. live job without the ownership marker (normal work) is never removed; replay fails closed", async () => {
    const { db, state } = createFakeDb();
    state.failures.set(terminalFailure.id, { ...terminalFailure });
    state.publishing.set(5, publishingRow());
    const { record } = await seedReplayRequest(db);
    // Normal publishing job data has no replayRequestId.
    vi.mocked(inspectPublishingJob).mockResolvedValue({
      exists: true,
      jobId: "publish-5",
      state: "waiting",
      data: { queueItemId: 5, userId: 18, platform: "TikTok" },
      timestamp: 123,
    });

    const result = await execute(db, { replayRequestId: record.id });

    expect(result).toMatchObject({ outcome: "terminal", status: "failed" });
    expect(removePublishingJobById).not.toHaveBeenCalled();
    expect(schedulePublishingJob).not.toHaveBeenCalled();
    // re-arm compensated
    expect(state.publishing.get(5).status).toBe("failed");
  });

  it("15b. crash-window resume with a FOREIGN replayRequestId marker fails closed", async () => {
    const { db, state } = createFakeDb();
    state.failures.set(terminalFailure.id, { ...terminalFailure });
    state.publishing.set(5, publishingRow());
    const { record } = await seedReplayRequest(db);
    await claimTerminalReplayRequest(record.id, { claimedAt: NOW }, db);
    state.publishing.get(5).status = "retrying";
    vi.mocked(inspectPublishingJob).mockResolvedValue({
      exists: true,
      jobId: "publish-5",
      state: "delayed",
      data: { queueItemId: 5, userId: 18, platform: "TikTok", replayRequestId: 424242 },
      timestamp: 123,
    });

    const result = await execute(db, { replayRequestId: record.id });

    expect(result).toMatchObject({ outcome: "terminal", status: "failed" });
    expect(removePublishingJobById).not.toHaveBeenCalled();
    expect(schedulePublishingJob).not.toHaveBeenCalled();
    expect(state.requests.get(record.id).status).toBe("failed");
  });

  it("16. schedule receives the CURRENT authoritative queue row user/platform", async () => {
    const { db, state } = createFakeDb();
    state.failures.set(terminalFailure.id, { ...terminalFailure });
    state.publishing.set(5, publishingRow({ userId: 42, platform: "LinkedIn" }));
    // Re-seed billing evidence attributable to the CURRENT authoritative row.
    state.creditTransactions.clear();
    state.creditTransactions.set(2, {
      id: 2,
      userId: 42,
      type: "publishing_deduction",
      amount: -1,
      metadata: { queueItemId: 5, platform: "LinkedIn" },
    });
    const { record } = await seedReplayRequest(db);

    await execute(db, { replayRequestId: record.id });

    expect(schedulePublishingJob).toHaveBeenCalledWith(5, 42, "LinkedIn", NOW, {
      replayRequestId: record.id,
    });
  });

  it("17+18. successful enqueue moves claimed -> enqueued and retains the active guard", async () => {
    const { db, state } = createFakeDb();
    state.failures.set(terminalFailure.id, { ...terminalFailure });
    state.publishing.set(5, publishingRow());
    const { record } = await seedReplayRequest(db);

    await execute(db, { replayRequestId: record.id });

    expect(state.requests.get(record.id).status).toBe("enqueued");
    expect(state.activeClaims.has(terminalFailure.id)).toBe(true);
  });

  it("19. executor rerun when status=enqueued performs zero second enqueue", async () => {
    const { db, state } = createFakeDb();
    state.failures.set(terminalFailure.id, { ...terminalFailure });
    state.publishing.set(5, publishingRow());
    const { record } = await seedReplayRequest(db);

    const first = await execute(db, { replayRequestId: record.id });
    expect(first.outcome).toBe("enqueued");
    const callsAfterFirst = vi.mocked(schedulePublishingJob).mock.calls.length;

    const second = await execute(db, { replayRequestId: record.id });
    expect(second).toMatchObject({ outcome: "already_enqueued", replayBullmqJobId: "publish-5" });
    expect(vi.mocked(schedulePublishingJob).mock.calls.length).toBe(callsAfterFirst);
    expect(inspectPublishingJob).toHaveBeenCalledTimes(1); // only the first run inspected
  });

  it("20. crash-window recovery: existing matching replay job (full ownership marker) reconciles to enqueued without a second add", async () => {
    const { db, state } = createFakeDb();
    state.failures.set(terminalFailure.id, { ...terminalFailure });
    state.publishing.set(5, publishingRow());
    const { record } = await seedReplayRequest(db);
    await claimTerminalReplayRequest(record.id, { claimedAt: NOW }, db);
    // Simulate the crashed attempt: row re-armed, BullMQ add succeeded with
    // the ownership marker, the mark-enqueued write never landed.
    state.publishing.get(5).status = "retrying";
    vi.mocked(inspectPublishingJob).mockResolvedValue({
      exists: true,
      jobId: "publish-5",
      state: "delayed",
      data: { queueItemId: 5, userId: 18, platform: "TikTok", replayRequestId: record.id },
      timestamp: 123,
    });

    const result = await execute(db, { replayRequestId: record.id });

    expect(result).toMatchObject({ outcome: "enqueued", replayBullmqJobId: "publish-5" });
    expect(schedulePublishingJob).not.toHaveBeenCalled();
    expect(removePublishingJobById).not.toHaveBeenCalled();
    expect(state.requests.get(record.id).status).toBe("enqueued");
  });

  it("21. enqueue failure: row compensates retrying -> failed, request -> failed, guard released", async () => {
    const { db, state } = createFakeDb();
    state.failures.set(terminalFailure.id, { ...terminalFailure });
    state.publishing.set(5, publishingRow());
    const { record } = await seedReplayRequest(db);
    vi.mocked(schedulePublishingJob).mockRejectedValue(new Error("redis unreachable"));

    const result = await execute(db, { replayRequestId: record.id });

    expect(result).toMatchObject({ outcome: "terminal", status: "failed" });
    expect(state.publishing.get(5).status).toBe("failed");
    expect(state.publishing.get(5).nextRetryAt).toBeNull();
    expect(state.requests.get(record.id).status).toBe("failed");
    expect(state.activeClaims.has(terminalFailure.id)).toBe(false);
  });

  it("22. compensation is guarded and cannot overwrite a later state mutation", async () => {
    const { db, state } = createFakeDb();
    state.failures.set(terminalFailure.id, { ...terminalFailure });
    state.publishing.set(5, publishingRow());
    const { record } = await seedReplayRequest(db);
    // A concurrent worker wins between re-arm and the failed enqueue.
    vi.mocked(schedulePublishingJob).mockImplementation(async () => {
      state.publishing.get(5).status = "published";
      state.publishing.get(5).publishedAt = NOW;
      throw new Error("redis unreachable");
    });

    const result = await execute(db, { replayRequestId: record.id });

    expect(result).toMatchObject({ outcome: "terminal", status: "failed" });
    expect(state.publishing.get(5).status).toBe("published");
    expect(state.requests.get(record.id).status).toBe("failed");
    expect(state.activeClaims.has(terminalFailure.id)).toBe(false);
  });

  it("23. queue inspection exception is sanitized and fails safely", async () => {
    const { db, state } = createFakeDb();
    state.failures.set(terminalFailure.id, { ...terminalFailure });
    state.publishing.set(5, publishingRow());
    const { record } = await seedReplayRequest(db);
    vi.mocked(inspectPublishingJob).mockRejectedValue(
      new Error("ECONNREFUSED 127.0.0.1:6379 password=hunter2")
    );

    const result = await execute(db, { replayRequestId: record.id });

    expect(result).toMatchObject({ outcome: "terminal", status: "failed" });
    expect(state.publishing.get(5).status).toBe("failed");
    const summary = state.requests.get(record.id).lastErrorSummary;
    expect(summary).toContain("inspection failed");
    expect(summary).not.toContain("hunter2");
    expect(summary).toContain("[redacted]");
  });

  it("24. no content-generation scheduling or claim re-arm occurs", async () => {
    const { db, state } = createFakeDb();
    state.failures.set(terminalFailure.id, { ...terminalFailure });
    state.publishing.set(5, publishingRow());
    const { record } = await seedReplayRequest(db);

    await execute(db, { replayRequestId: record.id });

    expect(scheduleContentGenerationJob).not.toHaveBeenCalled();
  });

  it("25. claimed request without a verified active claim fails closed (claim authority violation)", async () => {
    const { db, state } = createFakeDb();
    state.failures.set(terminalFailure.id, { ...terminalFailure });
    state.publishing.set(5, publishingRow());
    const { record } = await seedReplayRequest(db);
    await claimTerminalReplayRequest(record.id, { claimedAt: NOW }, db);
    // Someone released the guard out-of-band.
    state.activeClaims.delete(terminalFailure.id);

    await expect(execute(db, { replayRequestId: record.id })).rejects.toMatchObject({
      code: "claim_authority_violation",
    });
    expect(schedulePublishingJob).not.toHaveBeenCalled();
  });

  it("unknown replay request id fails closed", async () => {
    const { db } = createFakeDb();
    await expect(execute(db, { replayRequestId: 424242 })).rejects.toThrow();
  });

  it("resolved/failed requests return the terminal result with no queue side effect", async () => {
    const { db, state } = createFakeDb();
    state.failures.set(terminalFailure.id, { ...terminalFailure });
    state.publishing.set(5, publishingRow());
    const { record } = await seedReplayRequest(db);
    await claimTerminalReplayRequest(record.id, { claimedAt: NOW }, db);
    await markTerminalReplayEnqueued(record.id, { replayBullmqJobId: "publish-5" }, db);
    state.requests.get(record.id).status = "failed";

    const result = await execute(db, { replayRequestId: record.id });
    expect(result).toMatchObject({ outcome: "terminal", status: "failed" });
    expect(schedulePublishingJob).not.toHaveBeenCalled();
    expect(inspectPublishingJob).not.toHaveBeenCalled();
  });
});

describe("billing evidence authority (correction 3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(schedulePublishingJob).mockReset().mockResolvedValue({} as any);
    vi.mocked(scheduleContentGenerationJob).mockReset().mockResolvedValue({} as any);
    vi.mocked(removePublishingJobById).mockReset().mockResolvedValue(true);
    vi.mocked(inspectPublishingJob)
      .mockReset()
      .mockResolvedValue({ exists: false, jobId: "publish-5", state: null, data: null, timestamp: null });
  });

  function deduction(overrides: Partial<any> = {}) {
    return {
      id: 1,
      userId: 18,
      walletId: 7,
      type: "publishing_deduction",
      amount: -1,
      balanceAfter: 99,
      description: "Publish to TikTok",
      metadata: { queueItemId: 5, platform: "TikTok" },
      idempotencyKey: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      ...overrides,
    };
  }

  it("1. exactly one matching publishing deduction permits failed -> retrying", async () => {
    const { db, state } = createFakeDb(); // default seed = exactly one match
    state.failures.set(terminalFailure.id, { ...terminalFailure });
    state.publishing.set(5, publishingRow());
    const { record } = await seedReplayRequest(db);

    const result = await execute(db, { replayRequestId: record.id });

    expect(result.outcome).toBe("enqueued");
    expect(state.publishing.get(5).status).toBe("retrying");
  });

  it("2. zero matching deductions: no rearm, zero Redis mutation, request failed, guard released", async () => {
    const { db, state } = createFakeDb();
    state.creditTransactions.clear();
    state.failures.set(terminalFailure.id, { ...terminalFailure });
    state.publishing.set(5, publishingRow());
    const { record } = await seedReplayRequest(db);

    const result = await execute(db, { replayRequestId: record.id });

    expect(result).toMatchObject({ outcome: "terminal", status: "failed" });
    expect(state.publishing.get(5).status).toBe("failed");
    expect(schedulePublishingJob).not.toHaveBeenCalled();
    expect(inspectPublishingJob).not.toHaveBeenCalled();
    expect(state.requests.get(record.id).status).toBe("failed");
    expect(state.activeClaims.has(terminalFailure.id)).toBe(false);
    expect(state.requests.get(record.id).lastErrorSummary).toContain("No existing publishing deduction");
  });

  it("3. multiple/conflicting deductions fail closed as ambiguous", async () => {
    const { db, state } = createFakeDb();
    state.creditTransactions.set(2, deduction({ id: 2 })); // duplicate match
    state.failures.set(terminalFailure.id, { ...terminalFailure });
    state.publishing.set(5, publishingRow());
    const { record } = await seedReplayRequest(db);

    const result = await execute(db, { replayRequestId: record.id });

    expect(result).toMatchObject({ outcome: "terminal", status: "failed" });
    expect(state.publishing.get(5).status).toBe("failed");
    expect(schedulePublishingJob).not.toHaveBeenCalled();
    expect(state.requests.get(record.id).lastErrorSummary).toContain("Ambiguous billing evidence");
  });

  it("4. deduction for another user does not authorize replay", async () => {
    const { db, state } = createFakeDb();
    state.creditTransactions.clear();
    state.creditTransactions.set(9, deduction({ id: 9, userId: 999 }));
    state.failures.set(terminalFailure.id, { ...terminalFailure });
    state.publishing.set(5, publishingRow());
    const { record } = await seedReplayRequest(db);

    const result = await execute(db, { replayRequestId: record.id });

    expect(result).toMatchObject({ outcome: "terminal", status: "failed" });
    expect(state.publishing.get(5).status).toBe("failed");
    expect(schedulePublishingJob).not.toHaveBeenCalled();
  });

  it("5. deduction for another queueItemId does not authorize replay", async () => {
    const { db, state } = createFakeDb();
    state.creditTransactions.clear();
    state.creditTransactions.set(9, deduction({ id: 9, metadata: { queueItemId: 1234, platform: "TikTok" } }));
    state.failures.set(terminalFailure.id, { ...terminalFailure });
    state.publishing.set(5, publishingRow());
    const { record } = await seedReplayRequest(db);

    const result = await execute(db, { replayRequestId: record.id });

    expect(result).toMatchObject({ outcome: "terminal", status: "failed" });
    expect(state.publishing.get(5).status).toBe("failed");
  });

  it("6. deduction for another platform does not authorize replay when platform attribution exists", async () => {
    const { db, state } = createFakeDb();
    state.creditTransactions.clear();
    state.creditTransactions.set(9, deduction({ id: 9, metadata: { queueItemId: 5, platform: "Facebook" } }));
    state.failures.set(terminalFailure.id, { ...terminalFailure });
    state.publishing.set(5, publishingRow());
    const { record } = await seedReplayRequest(db);

    const result = await execute(db, { replayRequestId: record.id });

    expect(result).toMatchObject({ outcome: "terminal", status: "failed" });
    expect(state.publishing.get(5).status).toBe("failed");
  });

  it("7. no deduct/refund/reservation call occurs anywhere in the slice", async () => {
    const { db, state } = createFakeDb();
    state.failures.set(terminalFailure.id, { ...terminalFailure });
    state.publishing.set(5, publishingRow());
    const { record } = await seedReplayRequest(db);

    // credit-engine functions are throwing tripwires; a clean success proves
    // they were never invoked.
    await expect(execute(db, { replayRequestId: record.id })).resolves.toMatchObject({
      outcome: "enqueued",
    });
  });
});
