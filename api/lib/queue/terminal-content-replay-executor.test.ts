import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../alerts", () => ({
  createAlert: vi.fn(async () => ({ id: 1 })),
}));

// Hard guards: no real Redis, no worker execution, no billing mutation.
vi.mock("ioredis", () => ({
  Redis: class {
    constructor() {
      throw new Error("real Redis must never be constructed in content-replay tests");
    }
  },
}));
vi.mock("../jobs/content-generation-job", () => ({
  processContentGenerationJob: vi.fn(() => {
    throw new Error("content worker must never execute inside the replay executor");
  }),
}));
vi.mock("../billing/credit-engine", () => ({
  deductCredits: vi.fn(async () => {
    throw new Error("billing must not be mutated by the content replay executor");
  }),
  recordAiUsage: vi.fn(async () => {
    throw new Error("billing must not be mutated by the content replay executor");
  }),
  checkCredits: vi.fn(async () => {
    throw new Error("billing must not be mutated by the content replay executor");
  }),
  adminAdjustCredits: vi.fn(async () => {
    throw new Error("billing must not be mutated by the content replay executor");
  }),
}));

// Claim authorities are mocked: the executor must delegate through them with
// the transactional seam; their internal guards are proven by the claim
// module's own tests. calculateLeaseExpiresAt stays real.
const FRESH_TOKEN = "f".repeat(64);
const STALE_TOKEN = "a".repeat(64);

vi.mock("../creative/creative-generation-claim", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../creative/creative-generation-claim")>();
  return {
    ...actual,
    generateOwnerToken: vi.fn(() => FRESH_TOKEN),
    rearmCreativeGenerationClaim: vi.fn(async () => ({ rearmed: true })),
    terminalizeStaleCreativeGenerationClaim: vi.fn(async () => ({ terminalized: true })),
    releaseCreativeGenerationClaim: vi.fn(async () => {}),
  };
});

// Queue seam: schedule/inspect/remove mocked; pure helpers stay real.
vi.mock("./bullmq", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bullmq")>();
  return {
    ...actual,
    scheduleContentGenerationJob: vi.fn(),
    schedulePublishingJob: vi.fn(),
    inspectContentGenerationJob: vi.fn(),
    removeContentGenerationJobById: vi.fn(),
  };
});

import {
  generateOwnerToken,
  rearmCreativeGenerationClaim,
  releaseCreativeGenerationClaim,
  terminalizeStaleCreativeGenerationClaim,
} from "../creative/creative-generation-claim";
import {
  inspectContentGenerationJob,
  removeContentGenerationJobById,
  scheduleContentGenerationJob,
  schedulePublishingJob,
  toContentGenerationBullMqJobId,
} from "./bullmq";
import {
  executeContentTerminalReplay,
  fingerprintOwnerToken,
} from "./terminal-content-replay-executor";
import {
  TerminalReplayBindingConflictError,
  bindContentRecoveryClaim,
  claimTerminalReplayRequest,
  requestTerminalFailureReplay,
} from "./terminal-replay";
import type { TerminalReplayExecutor } from "./terminal-replay";

const NOW = new Date("2026-06-29T12:00:00.000Z");
const clock = () => NOW;
const LEASE_VALID = new Date(NOW.getTime() + 5 * 60_000);
const LEASE_STALE = new Date(NOW.getTime() - 10 * 60_000);

/* ── In-memory fake db (5 tables, journal transactions) ───────────── */

interface FakeState {
  failures: Map<number, any>;
  requests: Map<number, any>;
  activeClaims: Map<number, any>;
  agentRuns: Map<number, any>;
  claims: Map<number, any>;
  lastTxClient?: any;
}

function dupErr() {
  const err: any = new Error("Duplicate entry for key 'PRIMARY'");
  err.code = "ER_DUP_ENTRY";
  err.errno = 1062;
  return err;
}

function unwrapParam(value: any): any {
  if (value && typeof value === "object" && "value" in value && value.constructor?.name === "Param") {
    return value.value;
  }
  return value;
}

/** Evaluates eq/and/or/isNull conditions via chunk structure + join text. */
function evalCond(cond: any, row: any): boolean {
  if (!cond || typeof cond !== "object") return true;
  const chunks: any[] = cond.queryChunks ?? [];
  const predicates: Array<(r: any) => boolean> = [];
  let i = 0;
  while (i < chunks.length) {
    const chunk = chunks[i];
    if (chunk && Array.isArray(chunk.queryChunks)) {
      predicates.push((r) => evalCond(chunk, r));
      i += 1;
      continue;
    }
    if (chunk && typeof chunk === "object" && typeof chunk.name === "string" && chunk.table) {
      const opChunk = chunks[i + 1];
      const op: string = String(opChunk?.value?.[0] ?? opChunk?.sql ?? "").toLowerCase();
      if (op.includes("is not null")) {
        predicates.push((r) => r[chunk.name] != null);
        i += 2;
        continue;
      }
      if (op.includes("is null")) {
        predicates.push((r) => r[chunk.name] == null);
        i += 2;
        continue;
      }
      const value = unwrapParam(chunks[i + 2]);
      if (op.includes("<>")) {
        predicates.push((r) => r[chunk.name] !== value);
      } else {
        predicates.push((r) => r[chunk.name] === value);
      }
      i += 3;
      continue;
    }
    i += 1;
  }
  const joinText = chunks
    .filter((c) => typeof c?.value?.[0] === "string")
    .map((c) => c.value[0])
    .join(" ")
    .toLowerCase();
  return joinText.includes(" or ")
    ? predicates.some((p) => p(row))
    : predicates.every((p) => p(row));
}

function tableName(table: any): string {
  return table[Symbol.for("drizzle:Name") as symbol] as string;
}

type Undo = () => void;

function makeClient(
  state: FakeState,
  journal?: Undo[],
  opts: { failOn?: { op: "update"; table: string }; arm?: { value: boolean } } = {}
) {
  const record = (undo: Undo) => {
    journal?.push(undo);
  };
  const maybeFail = (op: "update", table: string) => {
    if (opts.arm && !opts.arm.value) return;
    if (opts.failOn?.op === op && opts.failOn.table === table) {
      throw new Error(`injected ${op} failure on ${table}`);
    }
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
            contentRecoveryClaimId: null,
            contentRecoveryOwnerTokenHash: null,
            contentRecoveryPreparedAt: null,
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
                      : name === "agent_runs"
                        ? Array.from(state.agentRuns.values())
                        : name === "creative_generation_claims"
                          ? Array.from(state.claims.values())
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
          maybeFail("update", name);
          const map =
            name === "queue_replay_requests"
              ? state.requests
              : name === "creative_generation_claims"
                ? state.claims
                : null;
          if (!map) throw new Error(`Unexpected update on ${name}`);
          let affected = 0;
          for (const row of map.values()) {
            if (evalCond(cond, row)) {
              // Model MySQL affectedRows semantics: a matched update that
              // writes identical values reports 0 affected rows.
              const isNoOp = Object.keys(values).every((key) => {
                const current = row[key];
                const next = values[key];
                return (
                  current === next ||
                  (current instanceof Date &&
                    next instanceof Date &&
                    current.getTime() === next.getTime())
                );
              });
              if (isNoOp) continue;
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
      const txClient = makeClient(state, txJournal, opts);
      state.lastTxClient = txClient;
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

function createFakeDb(opts: { failOn?: { op: "update"; table: string } } = {}) {
  const state: FakeState = {
    failures: new Map(),
    requests: new Map(),
    activeClaims: new Map(),
    agentRuns: new Map(),
    claims: new Map(),
  };
  const arm = { value: false };
  const client = makeClient(state, undefined, { ...opts, arm });
  return {
    db: client as unknown as TerminalReplayExecutor,
    state,
    armFailures: () => {
      arm.value = true;
    },
  };
}

/* ── Fixtures ──────────────────────────────────────────────────────── */

const AGENT_RUN_ID = 333;

const contentFailure = {
  id: 601,
  failureKey: "qtf:v1:content_generation:content-generation-333",
  queueName: "content_generation",
  bullmqJobId: "content-generation-333",
  terminalReason: "retries_exhausted",
  attemptsMade: 1,
  attemptsConfigured: 1,
  userId: 18,
  campaignId: 30,
  publishingQueueItemId: null,
  agentRunId: AGENT_RUN_ID,
  status: "open",
};

function agentRun(overrides: Partial<any> = {}) {
  return {
    id: AGENT_RUN_ID,
    userId: 18,
    campaignId: 30,
    agentType: "creative",
    status: "failed",
    input: { jobType: "content_generation_job", regenerate: false },
    output: null,
    error: "original job failure",
    startedAt: new Date("2026-06-01T10:00:00Z"),
    completedAt: new Date("2026-06-01T10:05:00Z"),
    createdAt: new Date("2026-06-01T09:55:00Z"),
    ...overrides,
  };
}

function claimRow(overrides: Partial<any> = {}) {
  return {
    id: 91,
    userId: 18,
    campaignId: 30,
    operationSource: "job",
    operationReferenceId: AGENT_RUN_ID,
    activeClaimKey: null,
    ownerToken: STALE_TOKEN,
    status: "failed",
    heartbeatAt: null,
    leaseExpiresAt: null,
    releasedAt: new Date("2026-06-01T10:05:00Z"),
    createdAt: new Date("2026-06-01T09:55:00Z"),
    updatedAt: new Date("2026-06-01T10:05:00Z"),
    ...overrides,
  };
}

async function seedReplayRequest(db: TerminalReplayExecutor, overrides: Partial<any> = {}) {
  return requestTerminalFailureReplay(
    {
      replayKey: "op:replay:content-333",
      terminalFailureId: contentFailure.id,
      requestedByUserId: 1,
      reason: "operator content recovery",
      ...overrides,
    },
    db
  );
}

function execute(db: TerminalReplayExecutor, overrides: Partial<any> = {}) {
  return executeContentTerminalReplay({
    replayRequestId: 1000,
    requestedByUserId: 1,
    clock,
    executor: db,
    ...overrides,
  });
}

/** Standard recoverable world: failed run + exact failed claim. */
async function seedWorld(db: TerminalReplayExecutor, state: FakeState) {
  state.failures.set(contentFailure.id, { ...contentFailure });
  state.agentRuns.set(AGENT_RUN_ID, agentRun());
  state.claims.set(91, claimRow());
  return seedReplayRequest(db);
}

/* ── Tests ─────────────────────────────────────────────────────────── */

describe("executeContentTerminalReplay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(scheduleContentGenerationJob).mockReset().mockResolvedValue({} as any);
    vi.mocked(schedulePublishingJob).mockReset().mockResolvedValue({} as any);
    vi.mocked(removeContentGenerationJobById).mockReset().mockResolvedValue(true);
    vi.mocked(rearmCreativeGenerationClaim).mockReset().mockResolvedValue({ rearmed: true } as any);
    vi.mocked(terminalizeStaleCreativeGenerationClaim)
      .mockReset()
      .mockResolvedValue({ terminalized: true });
    vi.mocked(releaseCreativeGenerationClaim).mockReset().mockResolvedValue(undefined);
    vi.mocked(inspectContentGenerationJob)
      .mockReset()
      .mockResolvedValue({
        exists: false,
        jobId: "content-generation-333",
        state: null,
        data: null,
        timestamp: null,
      });
  });

  it("1. operator mismatch fails before any mutation", async () => {
    const { db, state } = createFakeDb();
    const { record } = await seedWorld(db, state);

    await expect(execute(db, { replayRequestId: record.id, requestedByUserId: 999 })).rejects.toMatchObject({
      code: "operator_mismatch",
    });
    expect(rearmCreativeGenerationClaim).not.toHaveBeenCalled();
    expect(scheduleContentGenerationJob).not.toHaveBeenCalled();
  });

  it("2. wrong replay mode fails closed", async () => {
    const { db, state } = createFakeDb();
    state.failures.set(contentFailure.id, { ...contentFailure });
    state.agentRuns.set(AGENT_RUN_ID, agentRun());
    state.claims.set(91, claimRow());
    // A request created against a publishing failure carries publishing_requeue.
    const pubFailure = { ...contentFailure, id: 701, queueName: "publishing", failureKey: "qtf:v1:publishing:publish-5", bullmqJobId: "publish-5", publishingQueueItemId: 5, agentRunId: null };
    state.failures.set(701, pubFailure);
    const { record } = await seedReplayRequest(db, { terminalFailureId: 701, replayKey: "op:pub" });

    await expect(execute(db, { replayRequestId: record.id })).rejects.toMatchObject({
      code: "wrong_replay_mode",
    });
  });

  it("3. wrong queue fails closed", async () => {
    const { db, state } = createFakeDb();
    const { record } = await seedWorld(db, state);
    state.requests.get(record.id).queueName = "publishing";

    await expect(execute(db, { replayRequestId: record.id })).rejects.toMatchObject({
      code: "queue_mismatch",
    });
  });

  it("4. failureKey mismatch fails closed", async () => {
    const { db, state } = createFakeDb();
    const { record } = await seedWorld(db, state);
    state.failures.get(contentFailure.id).failureKey = "qtf:v1:content_generation:tampered";

    await expect(execute(db, { replayRequestId: record.id })).rejects.toMatchObject({
      code: "failure_key_mismatch",
    });
  });

  it("5. original BullMQ identity mismatch fails closed", async () => {
    const { db, state } = createFakeDb();
    const { record } = await seedWorld(db, state);
    state.requests.get(record.id).originalBullmqJobId = "content-generation-forged";

    await expect(execute(db, { replayRequestId: record.id })).rejects.toMatchObject({
      code: "original_identity_mismatch",
    });
  });

  it("6. malformed/non-canonical content job id fails closed", async () => {
    const { db, state } = createFakeDb();
    state.failures.set(contentFailure.id, { ...contentFailure, bullmqJobId: "rogue-job-id" });
    state.agentRuns.set(AGENT_RUN_ID, agentRun());
    state.claims.set(91, claimRow());
    const { record } = await seedReplayRequest(db);
    state.requests.get(record.id).originalBullmqJobId = "rogue-job-id";

    await expect(execute(db, { replayRequestId: record.id })).rejects.toMatchObject({
      code: "deterministic_identity_mismatch",
    });
  });

  it("7. deterministic round-trip identity is required", async () => {
    const { db, state } = createFakeDb();
    // agentRunId 333 but job id for 334: not derivable from the durable field.
    state.failures.set(contentFailure.id, {
      ...contentFailure,
      bullmqJobId: toContentGenerationBullMqJobId(334),
    });
    state.agentRuns.set(AGENT_RUN_ID, agentRun());
    state.claims.set(91, claimRow());
    const { record } = await seedReplayRequest(db);
    state.requests.get(record.id).originalBullmqJobId = toContentGenerationBullMqJobId(334);

    await expect(execute(db, { replayRequestId: record.id })).rejects.toMatchObject({
      code: "deterministic_identity_mismatch",
    });
  });

  it("8. missing agent run fails closed", async () => {
    const { db, state } = createFakeDb();
    state.failures.set(contentFailure.id, { ...contentFailure });
    state.claims.set(91, claimRow());
    const { record } = await seedReplayRequest(db);

    await expect(execute(db, { replayRequestId: record.id })).rejects.toMatchObject({
      code: "agent_run_not_found",
    });
  });

  it("9. wrong run user fails closed", async () => {
    const { db, state } = createFakeDb();
    state.failures.set(contentFailure.id, { ...contentFailure });
    state.agentRuns.set(AGENT_RUN_ID, agentRun({ userId: 999 }));
    state.claims.set(91, claimRow());
    const { record } = await seedReplayRequest(db);

    await expect(execute(db, { replayRequestId: record.id })).rejects.toMatchObject({
      code: "agent_run_lineage_mismatch",
    });
  });

  it("10. wrong campaign fails closed", async () => {
    const { db, state } = createFakeDb();
    state.failures.set(contentFailure.id, { ...contentFailure });
    state.agentRuns.set(AGENT_RUN_ID, agentRun({ campaignId: 31 }));
    state.claims.set(91, claimRow());
    const { record } = await seedReplayRequest(db);

    await expect(execute(db, { replayRequestId: record.id })).rejects.toMatchObject({
      code: "agent_run_lineage_mismatch",
    });
  });

  it("11. wrong run type fails closed", async () => {
    const { db, state } = createFakeDb();
    state.failures.set(contentFailure.id, { ...contentFailure });
    state.agentRuns.set(AGENT_RUN_ID, agentRun({ agentType: "strategy", input: { jobType: "strategy" } }));
    state.claims.set(91, claimRow());
    const { record } = await seedReplayRequest(db);

    await expect(execute(db, { replayRequestId: record.id })).rejects.toMatchObject({
      code: "agent_run_type_mismatch",
    });
  });

  it("12+13. completed target goes claimed -> resolved with zero claim/Redis mutation", async () => {
    const { db, state } = createFakeDb();
    state.failures.set(contentFailure.id, { ...contentFailure });
    state.agentRuns.set(AGENT_RUN_ID, agentRun({ status: "completed", output: { success: true } }));
    state.claims.set(91, claimRow({ status: "completed" }));
    const { record } = await seedReplayRequest(db);

    const result = await execute(db, { replayRequestId: record.id });

    expect(result.outcome).toBe("already_completed");
    expect(state.requests.get(record.id).status).toBe("resolved");
    expect(state.activeClaims.has(contentFailure.id)).toBe(false);
    expect(rearmCreativeGenerationClaim).not.toHaveBeenCalled();
    expect(terminalizeStaleCreativeGenerationClaim).not.toHaveBeenCalled();
    expect(scheduleContentGenerationJob).not.toHaveBeenCalled();
    expect(inspectContentGenerationJob).not.toHaveBeenCalled();
    expect(state.claims.get(91).status).toBe("completed");
  });

  it("14. exact approval/operation lineage is required (foreign-source claim is not selected)", async () => {
    const { db, state } = createFakeDb();
    state.failures.set(contentFailure.id, { ...contentFailure });
    state.agentRuns.set(AGENT_RUN_ID, agentRun());
    state.claims.set(91, claimRow({ operationSource: "approval", operationReferenceId: 77 }));
    const { record } = await seedReplayRequest(db);

    await expect(execute(db, { replayRequestId: record.id })).rejects.toMatchObject({
      code: "claim_lineage_not_found",
    });
    expect(rearmCreativeGenerationClaim).not.toHaveBeenCalled();
  });

  it("15. latest unrelated claim is never selected: exact lineage wins", async () => {
    const { db, state } = createFakeDb();
    state.failures.set(contentFailure.id, { ...contentFailure });
    state.agentRuns.set(AGENT_RUN_ID, agentRun());
    // An unrelated newer running claim for the same user/campaign.
    state.claims.set(92, claimRow({ id: 92, operationReferenceId: 999, status: "running", ownerToken: "b".repeat(64), activeClaimKey: "active:18:30:creative", leaseExpiresAt: LEASE_VALID }));
    state.claims.set(91, claimRow());
    const { record } = await seedReplayRequest(db);

    const result = await execute(db, { replayRequestId: record.id });

    expect(result.outcome).toBe("enqueued");
    expect(rearmCreativeGenerationClaim).toHaveBeenCalledTimes(1);
    expect(vi.mocked(rearmCreativeGenerationClaim).mock.calls[0][0]).toMatchObject({
      operationReferenceId: AGENT_RUN_ID,
    });
    // The unrelated running claim was untouched.
    expect(state.claims.get(92).status).toBe("running");
  });

  it("16. ambiguous claim evidence fails closed", async () => {
    const { db, state } = createFakeDb();
    state.failures.set(contentFailure.id, { ...contentFailure });
    state.agentRuns.set(AGENT_RUN_ID, agentRun());
    state.claims.set(91, claimRow());
    state.claims.set(92, claimRow({ id: 92 })); // duplicate exact lineage
    const { record } = await seedReplayRequest(db);

    await expect(execute(db, { replayRequestId: record.id })).rejects.toMatchObject({
      code: "claim_lineage_ambiguous",
    });
    expect(rearmCreativeGenerationClaim).not.toHaveBeenCalled();
    // Deterministic pre-mutation refusal: replay failed, guard released.
    expect(state.requests.get(record.id).status).toBe("failed");
    expect(state.activeClaims.has(contentFailure.id)).toBe(false);
    expect(scheduleContentGenerationJob).not.toHaveBeenCalled();
  });

  it("17+18+19+28. failed claim: fresh ownerToken (never the stale one), durable binding stores id + hash only", async () => {
    const { db, state } = createFakeDb();
    const { record } = await seedWorld(db, state);

    const result = await execute(db, { replayRequestId: record.id });

    expect(result.outcome).toBe("enqueued");
    expect(rearmCreativeGenerationClaim).toHaveBeenCalledTimes(1);
    const rearmArgs = vi.mocked(rearmCreativeGenerationClaim).mock.calls[0][0];
    expect(rearmArgs.ownerToken).toBe(FRESH_TOKEN);
    expect(rearmArgs.ownerToken).not.toBe(STALE_TOKEN);

    const payload = vi.mocked(scheduleContentGenerationJob).mock.calls[0][0];
    expect(payload.ownerToken).toBe(FRESH_TOKEN);
    expect(payload.ownerToken).not.toBe(STALE_TOKEN);
    expect(payload.claimId).toBe(91);

    const request = state.requests.get(record.id);
    expect(request.contentRecoveryClaimId).toBe(91);
    expect(request.contentRecoveryOwnerTokenHash).toBe(fingerprintOwnerToken(FRESH_TOKEN));
    expect(JSON.stringify(request)).not.toContain(FRESH_TOKEN); // raw token never persisted
  });

  it("24. rearm and durable binding are transactionally coupled (same tx client)", async () => {
    const { db, state } = createFakeDb();
    const { record } = await seedWorld(db, state);

    await execute(db, { replayRequestId: record.id });

    const rearmArgs = vi.mocked(rearmCreativeGenerationClaim).mock.calls[0][0];
    expect(state.lastTxClient).toBeDefined();
    expect(rearmArgs.db).toBe(state.lastTxClient);
    expect(state.requests.get(record.id).contentRecoveryClaimId).toBe(91);
  });

  it("22. stale running claim: existing stale authority terminalizes BEFORE rearm", async () => {
    const { db, state } = createFakeDb();
    state.failures.set(contentFailure.id, { ...contentFailure });
    state.agentRuns.set(AGENT_RUN_ID, agentRun());
    state.claims.set(91, claimRow({ status: "running", activeClaimKey: "active:18:30:creative", leaseExpiresAt: LEASE_STALE }));
    const { record } = await seedReplayRequest(db);

    const result = await execute(db, { replayRequestId: record.id });

    expect(result.outcome).toBe("enqueued");
    const terminalizeOrder = vi.mocked(terminalizeStaleCreativeGenerationClaim).mock.invocationCallOrder[0];
    const rearmOrder = vi.mocked(rearmCreativeGenerationClaim).mock.invocationCallOrder[0];
    expect(terminalizeOrder).toBeLessThan(rearmOrder);
    expect(vi.mocked(terminalizeStaleGenerationArgs()).claimId).toBe(91);
  });

  it("23. healthy running foreign claim is not stolen", async () => {
    const { db, state } = createFakeDb();
    state.failures.set(contentFailure.id, { ...contentFailure });
    state.agentRuns.set(AGENT_RUN_ID, agentRun());
    state.claims.set(91, claimRow({ status: "running", activeClaimKey: "active:18:30:creative", leaseExpiresAt: LEASE_VALID }));
    const { record } = await seedReplayRequest(db);

    await expect(execute(db, { replayRequestId: record.id })).rejects.toMatchObject({
      code: "healthy_running_claim_protected",
    });
    expect(terminalizeStaleCreativeGenerationClaim).not.toHaveBeenCalled();
    expect(rearmCreativeGenerationClaim).not.toHaveBeenCalled();
    expect(scheduleContentGenerationJob).not.toHaveBeenCalled();
    // Deterministic refusal: foreign claim untouched, replay failed + guard
    // released, zero Redis mutation.
    expect(state.claims.get(91).status).toBe("running");
    expect(state.requests.get(record.id).status).toBe("failed");
    expect(state.activeClaims.has(contentFailure.id)).toBe(false);
    expect(inspectContentGenerationJob).not.toHaveBeenCalled();
  });

  it("25. crash after rearm/binding before queue.add: resume verifies binding and enqueues without re-rearm", async () => {
    const { db, state } = createFakeDb();
    const { record } = await seedWorld(db, state);
    await claimTerminalReplayRequest(record.id, { claimedAt: NOW }, db);
    // Simulate the crashed attempt's committed work: running claim with the
    // fresh token + durable binding.
    state.claims.set(91, claimRow({ status: "running", ownerToken: FRESH_TOKEN, activeClaimKey: "active:18:30:creative", leaseExpiresAt: LEASE_VALID }));
    state.requests.get(record.id).contentRecoveryClaimId = 91;
    state.requests.get(record.id).contentRecoveryOwnerTokenHash = fingerprintOwnerToken(FRESH_TOKEN);

    const result = await execute(db, { replayRequestId: record.id });

    expect(result).toMatchObject({ outcome: "enqueued", replayBullmqJobId: "content-generation-333" });
    expect(rearmCreativeGenerationClaim).not.toHaveBeenCalled();
    expect(generateOwnerToken).not.toHaveBeenCalled();
    expect(scheduleContentGenerationJob).toHaveBeenCalledTimes(1);
    expect(vi.mocked(scheduleContentGenerationJob).mock.calls[0][0].ownerToken).toBe(FRESH_TOKEN);
  });

  it("26+27+29. deterministic id, authoritative run/user/campaign payload, replay marker", async () => {
    const { db, state } = createFakeDb();
    const { record } = await seedWorld(db, state);

    const result = await execute(db, { replayRequestId: record.id });

    expect(result).toMatchObject({ outcome: "enqueued", replayBullmqJobId: "content-generation-333" });
    expect(toContentGenerationBullMqJobId(AGENT_RUN_ID)).toBe("content-generation-333");
    expect(scheduleContentGenerationJob).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: AGENT_RUN_ID,
        userId: 18,
        campaignId: 30,
        claimId: 91,
        replayRequestId: record.id,
      })
    );
  });

  it("30. terminal failed BullMQ job removed only after durable identity proof", async () => {
    const { db, state } = createFakeDb();
    const { record } = await seedWorld(db, state);
    vi.mocked(inspectContentGenerationJob).mockResolvedValue({
      exists: true,
      jobId: "content-generation-333",
      state: "failed",
      data: { jobId: AGENT_RUN_ID, userId: 18, campaignId: 30, regenerate: false },
      timestamp: 1,
    });

    const result = await execute(db, { replayRequestId: record.id });

    expect(result.outcome).toBe("enqueued");
    expect(removeContentGenerationJobById).toHaveBeenCalledWith("content-generation-333");
    expect(scheduleContentGenerationJob).toHaveBeenCalledTimes(1);
  });

  it("30b. terminal failed job with mismatched identity is NOT removed; fails closed", async () => {
    const { db, state } = createFakeDb();
    const { record } = await seedWorld(db, state);
    vi.mocked(inspectContentGenerationJob).mockResolvedValue({
      exists: true,
      jobId: "content-generation-333",
      state: "failed",
      data: { jobId: 999, userId: 18, campaignId: 30, regenerate: false },
      timestamp: 1,
    });

    const result = await execute(db, { replayRequestId: record.id });

    expect(result).toMatchObject({ outcome: "terminal", status: "failed" });
    expect(removeContentGenerationJobById).not.toHaveBeenCalled();
    expect(scheduleContentGenerationJob).not.toHaveBeenCalled();
  });

  it("31. live unowned job (no marker) is never removed; fails closed with compensation", async () => {
    const { db, state } = createFakeDb();
    const { record } = await seedWorld(db, state);
    vi.mocked(inspectContentGenerationJob).mockResolvedValue({
      exists: true,
      jobId: "content-generation-333",
      state: "waiting",
      data: { jobId: AGENT_RUN_ID, userId: 18, campaignId: 30, regenerate: false },
      timestamp: 1,
    });

    const result = await execute(db, { replayRequestId: record.id });

    expect(result).toMatchObject({ outcome: "terminal", status: "failed" });
    expect(removeContentGenerationJobById).not.toHaveBeenCalled();
    expect(scheduleContentGenerationJob).not.toHaveBeenCalled();
    // compensation used the CURRENT fresh token
    expect(vi.mocked(releaseCreativeGenerationClaim).mock.calls[0][0]).toMatchObject({
      claimId: 91,
      ownerToken: FRESH_TOKEN,
      status: "failed",
    });
  });

  it("32. live foreign replay marker fails closed", async () => {
    const { db, state } = createFakeDb();
    const { record } = await seedWorld(db, state);
    vi.mocked(inspectContentGenerationJob).mockResolvedValue({
      exists: true,
      jobId: "content-generation-333",
      state: "delayed",
      data: { jobId: AGENT_RUN_ID, userId: 18, campaignId: 30, regenerate: false, claimId: 91, ownerToken: FRESH_TOKEN, replayRequestId: 424242 },
      timestamp: 1,
    });

    const result = await execute(db, { replayRequestId: record.id });

    expect(result).toMatchObject({ outcome: "terminal", status: "failed" });
    expect(scheduleContentGenerationJob).not.toHaveBeenCalled();
  });

  it("33+34. window 3: matching replay-owned live job reconciles to enqueued without second add/rearm", async () => {
    const { db, state } = createFakeDb();
    const { record } = await seedWorld(db, state);
    await claimTerminalReplayRequest(record.id, { claimedAt: NOW }, db);
    state.claims.set(91, claimRow({ status: "running", ownerToken: FRESH_TOKEN, activeClaimKey: "active:18:30:creative", leaseExpiresAt: LEASE_VALID }));
    state.requests.get(record.id).contentRecoveryClaimId = 91;
    state.requests.get(record.id).contentRecoveryOwnerTokenHash = fingerprintOwnerToken(FRESH_TOKEN);
    vi.mocked(inspectContentGenerationJob).mockResolvedValue({
      exists: true,
      jobId: "content-generation-333",
      state: "waiting",
      data: { jobId: AGENT_RUN_ID, userId: 18, campaignId: 30, regenerate: false, claimId: 91, ownerToken: FRESH_TOKEN, replayRequestId: record.id },
      timestamp: 1,
    });

    const result = await execute(db, { replayRequestId: record.id });

    expect(result).toMatchObject({ outcome: "enqueued", replayBullmqJobId: "content-generation-333" });
    expect(scheduleContentGenerationJob).not.toHaveBeenCalled();
    expect(rearmCreativeGenerationClaim).not.toHaveBeenCalled();
    expect(state.requests.get(record.id).status).toBe("enqueued");
  });

  it("35+36. successful enqueue keeps the request enqueued and retains the terminalFailure guard", async () => {
    const { db, state } = createFakeDb();
    const { record } = await seedWorld(db, state);

    const result = await execute(db, { replayRequestId: record.id });

    expect(result.outcome).toBe("enqueued");
    expect(state.requests.get(record.id).status).toBe("enqueued");
    expect(state.activeClaims.get(contentFailure.id)).toMatchObject({ replayRequestId: record.id });
  });

  it("37. rerun of an enqueued replay performs zero additional side effects", async () => {
    const { db, state } = createFakeDb();
    const { record } = await seedWorld(db, state);
    await execute(db, { replayRequestId: record.id });
    const scheduleCalls = vi.mocked(scheduleContentGenerationJob).mock.calls.length;

    const second = await execute(db, { replayRequestId: record.id });

    expect(second).toMatchObject({ outcome: "already_enqueued", replayBullmqJobId: "content-generation-333" });
    expect(vi.mocked(scheduleContentGenerationJob).mock.calls.length).toBe(scheduleCalls);
    expect(inspectContentGenerationJob).toHaveBeenCalledTimes(1);
  });

  it("38+39. enqueue failure: guarded claim compensation (fresh token), replay failed, guard released", async () => {
    const { db, state } = createFakeDb();
    const { record } = await seedWorld(db, state);
    vi.mocked(scheduleContentGenerationJob).mockRejectedValue(new Error("redis down"));

    const result = await execute(db, { replayRequestId: record.id });

    expect(result).toMatchObject({ outcome: "terminal", status: "failed" });
    expect(vi.mocked(releaseCreativeGenerationClaim).mock.calls[0][0]).toMatchObject({
      claimId: 91,
      ownerToken: FRESH_TOKEN,
      status: "failed",
    });
    expect(state.requests.get(record.id).status).toBe("failed");
    expect(state.activeClaims.has(contentFailure.id)).toBe(false);
  });

  it("40. compensation cannot overwrite a later legitimate claim transition", async () => {
    const { db, state } = createFakeDb();
    const { record } = await seedWorld(db, state);
    // The claim authority rejects compensation (claim no longer running/ours).
    vi.mocked(releaseCreativeGenerationClaim).mockRejectedValue(new Error("FORBIDDEN"));
    vi.mocked(scheduleContentGenerationJob).mockRejectedValue(new Error("redis down"));

    await expect(execute(db, { replayRequestId: record.id })).rejects.toThrow(/compensation failed/);

    // Guard retained, request stays claimed — never a released authority with
    // unresolved claim state.
    expect(state.requests.get(record.id).status).toBe("claimed");
    expect(state.activeClaims.has(contentFailure.id)).toBe(true);
  });

  it("41. compensation failure keeps replay request claimed and propagates", async () => {
    const { db, state } = createFakeDb();
    const { record } = await seedWorld(db, state);
    vi.mocked(inspectContentGenerationJob).mockRejectedValue(new Error("redis unreachable"));
    vi.mocked(releaseCreativeGenerationClaim).mockRejectedValue(new Error("claim guard rejected"));

    await expect(execute(db, { replayRequestId: record.id })).rejects.toThrow(/compensation failed/);
    expect(state.requests.get(record.id).status).toBe("claimed");
    expect(state.activeClaims.has(contentFailure.id)).toBe(true);
  });

  it("42. no stale ownerToken appears in errors or persisted state", async () => {
    const { db, state } = createFakeDb();
    const { record } = await seedWorld(db, state);
    vi.mocked(scheduleContentGenerationJob).mockRejectedValue(new Error(`redis down token=${STALE_TOKEN}`));

    let caught: any = null;
    try {
      await execute(db, { replayRequestId: record.id });
    } catch (err) {
      caught = err;
    }
    const summary = state.requests.get(record.id).lastErrorSummary ?? "";
    expect(String(caught?.message ?? "")).not.toContain(STALE_TOKEN);
    expect(summary).not.toContain(STALE_TOKEN);
    expect(JSON.stringify(state.requests.get(record.id))).not.toContain(STALE_TOKEN);
  });

  it("43+44+45. no billing mutation, no provider call, no worker execution (tripwires stay silent)", async () => {
    const { db, state } = createFakeDb();
    const { record } = await seedWorld(db, state);

    await expect(execute(db, { replayRequestId: record.id })).resolves.toMatchObject({
      outcome: "enqueued",
    });
  });
});

describe("durable replay -> claim binding helper", () => {
  it("20. exact replay binding is idempotent", async () => {
    const { db, state } = createFakeDb();
    state.failures.set(contentFailure.id, { ...contentFailure });
    const { record } = await seedReplayRequest(db);
    await claimTerminalReplayRequest(record.id, { claimedAt: NOW }, db);

    const first = await bindContentRecoveryClaim(
      record.id,
      { claimId: 91, ownerTokenHash: fingerprintOwnerToken(FRESH_TOKEN) },
      db
    );
    const second = await bindContentRecoveryClaim(
      record.id,
      { claimId: 91, ownerTokenHash: fingerprintOwnerToken(FRESH_TOKEN) },
      db
    );

    expect(first.bound).toBe(true);
    expect(second.bound).toBe(false);
    expect(state.requests.get(record.id).contentRecoveryClaimId).toBe(91);
  });

  it("21. conflicting binding (different claim/hash) fails closed", async () => {
    const { db, state } = createFakeDb();
    state.failures.set(contentFailure.id, { ...contentFailure });
    const { record } = await seedReplayRequest(db);
    await claimTerminalReplayRequest(record.id, { claimedAt: NOW }, db);
    await bindContentRecoveryClaim(
      record.id,
      { claimId: 91, ownerTokenHash: fingerprintOwnerToken(FRESH_TOKEN) },
      db
    );

    await expect(
      bindContentRecoveryClaim(
        record.id,
        { claimId: 92, ownerTokenHash: fingerprintOwnerToken("b".repeat(64)) },
        db
      )
    ).rejects.toBeInstanceOf(TerminalReplayBindingConflictError);
    // Original binding untouched.
    expect(state.requests.get(record.id).contentRecoveryClaimId).toBe(91);
  });
});

// Helper referenced by test 22 (kept small and local).
function terminalizeStaleGenerationArgs(): any {
  return vi.mocked(terminalizeStaleCreativeGenerationClaim).mock.calls[0][0];
}

describe("long-downtime bound-claim recovery + hash rotation (durability correction)", () => {
  const TOKEN_A = "a".repeat(64); // token from the crashed first attempt

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(scheduleContentGenerationJob).mockReset().mockResolvedValue({} as any);
    vi.mocked(schedulePublishingJob).mockReset().mockResolvedValue({} as any);
    vi.mocked(removeContentGenerationJobById).mockReset().mockResolvedValue(true);
    vi.mocked(rearmCreativeGenerationClaim).mockReset().mockResolvedValue({ rearmed: true } as any);
    vi.mocked(terminalizeStaleCreativeGenerationClaim)
      .mockReset()
      .mockResolvedValue({ terminalized: true });
    vi.mocked(releaseCreativeGenerationClaim).mockReset().mockResolvedValue(undefined);
    vi.mocked(inspectContentGenerationJob)
      .mockReset()
      .mockResolvedValue({
        exists: false,
        jobId: "content-generation-333",
        state: null,
        data: null,
        timestamp: null,
      });
  });

  /** Simulate attempt 1: rearm + binding committed, then crash before queue.add. */
  async function simulateCrashedFirstAttempt(db: TerminalReplayExecutor, state: FakeState) {
    const { record } = await seedWorld(db, state);
    await claimTerminalReplayRequest(record.id, { claimedAt: NOW }, db);
    state.claims.set(
      91,
      claimRow({ status: "running", ownerToken: TOKEN_A, activeClaimKey: "active:18:30:creative", leaseExpiresAt: LEASE_VALID })
    );
    state.requests.get(record.id).contentRecoveryClaimId = 91;
    state.requests.get(record.id).contentRecoveryOwnerTokenHash = fingerprintOwnerToken(TOKEN_A);
    return record;
  }

  it("mandatory: expired replay-owned bound claim recovers via stale authority + rearm + guarded rotation", async () => {
    const { db, state } = createFakeDb();
    const record = await simulateCrashedFirstAttempt(db, state);
    // Long downtime: lease now expired before the Redis handoff.
    state.claims.get(91).leaseExpiresAt = LEASE_STALE;

    const result = await execute(db, { replayRequestId: record.id });

    // E: stale authority terminalized the SAME claim.
    expect(vi.mocked(terminalizeStaleCreativeGenerationClaim).mock.calls[0][0]).toMatchObject({
      claimId: 91,
      userId: 18,
      campaignId: 30,
    });
    // F: same claim re-armed with a SECOND fresh ownerToken (not TOKEN_A).
    const rearmArgs = vi.mocked(rearmCreativeGenerationClaim).mock.calls[0][0];
    expect(rearmArgs.operationReferenceId).toBe(AGENT_RUN_ID);
    expect(rearmArgs.ownerToken).toBe(FRESH_TOKEN);
    expect(rearmArgs.ownerToken).not.toBe(TOKEN_A);

    // G: binding rotated to hash(second token); K: claim id unchanged.
    const request = state.requests.get(record.id);
    expect(request.contentRecoveryClaimId).toBe(91);
    expect(request.contentRecoveryOwnerTokenHash).toBe(fingerprintOwnerToken(FRESH_TOKEN));

    // H+I: queue receives only the current token; J: enqueued.
    expect(result).toMatchObject({ outcome: "enqueued", replayBullmqJobId: "content-generation-333" });
    const payload = vi.mocked(scheduleContentGenerationJob).mock.calls[0][0];
    expect(payload.ownerToken).toBe(FRESH_TOKEN);
    expect(payload.ownerToken).not.toBe(TOKEN_A);
    expect(payload.claimId).toBe(91);
    expect(state.requests.get(record.id).status).toBe("enqueued");
    expect(state.activeClaims.has(contentFailure.id)).toBe(true);
  });

  it("bound claim terminalized while down: re-arm + rotation without terminalization", async () => {
    const { db, state } = createFakeDb();
    const record = await simulateCrashedFirstAttempt(db, state);
    state.claims.get(91).status = "failed"; // stale sweep terminalized it

    const result = await execute(db, { replayRequestId: record.id });

    expect(terminalizeStaleCreativeGenerationClaim).not.toHaveBeenCalled();
    expect(vi.mocked(rearmCreativeGenerationClaim).mock.calls[0][0].ownerToken).toBe(FRESH_TOKEN);
    expect(state.requests.get(record.id).contentRecoveryOwnerTokenHash).toBe(
      fingerprintOwnerToken(FRESH_TOKEN)
    );
    expect(result.outcome).toBe("enqueued");
  });

  it("stale bound claim whose current token hash does NOT match the persisted binding is never taken over", async () => {
    const { db, state } = createFakeDb();
    const record = await simulateCrashedFirstAttempt(db, state);
    state.claims.get(91).leaseExpiresAt = LEASE_STALE;
    // The claim row now carries a DIFFERENT token than the binding proves.
    state.claims.get(91).ownerToken = "c".repeat(64);

    await expect(execute(db, { replayRequestId: record.id })).rejects.toMatchObject({
      code: "binding_invalid",
    });
    // Uncertain ownership: request stays claimed, guard held, no takeover.
    expect(terminalizeStaleCreativeGenerationClaim).not.toHaveBeenCalled();
    expect(rearmCreativeGenerationClaim).not.toHaveBeenCalled();
    expect(scheduleContentGenerationJob).not.toHaveBeenCalled();
    expect(state.requests.get(record.id).status).toBe("claimed");
    expect(state.activeClaims.has(contentFailure.id)).toBe(true);
  });

  it("rotation database failure rolls back: old binding/token/claim remain mutually consistent", async () => {
    const { db, state, armFailures } = createFakeDb({
      failOn: { op: "update", table: "queue_replay_requests" },
    });
    const record = await simulateCrashedFirstAttempt(db, state);
    state.claims.get(91).leaseExpiresAt = LEASE_STALE;
    armFailures();

    await expect(execute(db, { replayRequestId: record.id })).rejects.toThrow(
      "injected update failure"
    );

    // Stale terminalization + rearm ran inside the tx, but the durable
    // binding is unchanged and the request stays claimed with the guard held.
    expect(state.requests.get(record.id).contentRecoveryClaimId).toBe(91);
    expect(state.requests.get(record.id).contentRecoveryOwnerTokenHash).toBe(
      fingerprintOwnerToken(TOKEN_A)
    );
    expect(state.requests.get(record.id).status).toBe("claimed");
    expect(state.activeClaims.has(contentFailure.id)).toBe(true);
  });

  it("no raw ownerToken appears in queue_replay_requests after rotation", async () => {
    const { db, state } = createFakeDb();
    const record = await simulateCrashedFirstAttempt(db, state);
    state.claims.get(91).leaseExpiresAt = LEASE_STALE;

    await execute(db, { replayRequestId: record.id });

    const request = state.requests.get(record.id);
    expect(JSON.stringify(request)).not.toContain(FRESH_TOKEN);
    expect(JSON.stringify(request)).not.toContain(TOKEN_A);
    expect(request.contentRecoveryOwnerTokenHash).toBe(fingerprintOwnerToken(FRESH_TOKEN));
  });
});
