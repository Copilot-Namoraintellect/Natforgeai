import { describe, expect, it, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

vi.mock("../alerts", () => ({
  createAlert: vi.fn(async () => ({ id: 1 })),
}));

// Redis tripwire: any real Redis construction fails the test.
vi.mock("ioredis", () => ({
  Redis: class {
    constructor() {
      throw new Error("real Redis must never be constructed in reconciliation tests");
    }
  },
}));

import {
  ReplayReconciliationInvariantError,
  reconcileTerminalReplayRequest,
} from "./terminal-replay-reconciliation";
import { TerminalReplayRequestNotFoundError } from "./terminal-replay";
import type { TerminalReplayExecutor } from "./terminal-replay";

const NOW = new Date("2026-06-29T12:00:00.000Z");
const clock = () => NOW;
const TOKEN = "f".repeat(64);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/* ── In-memory fake db (6 tables, journal transactions) ───────────── */

interface FakeState {
  failures: Map<number, any>;
  requests: Map<number, any>;
  activeClaims: Map<number, any>;
  publishing: Map<number, any>;
  agentRuns: Map<number, any>;
  claims: Map<number, any>;
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
  opts: { failOn?: { op: "delete"; table: string } } = {}
) {
  const record = (undo: Undo) => {
    journal?.push(undo);
  };
  const maybeFail = (op: "delete", table: string) => {
    if (opts.failOn?.op === op && opts.failOn.table === table) {
      throw new Error(`injected ${op} failure on ${table}`);
    }
  };

  const db: any = {
    insert: vi.fn((table: any) => ({
      values: vi.fn(async (values: any) => {
        const name = tableName(table);
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
          const map = name === "queue_replay_requests" ? state.requests : null;
          if (!map) throw new Error(`Unexpected update on ${name}`);
          let affected = 0;
          for (const row of map.values()) {
            if (evalCond(cond, row)) {
              const isNoOp = Object.keys(values).every((key) => {
                const current = row[key];
                const next = values[key];
                return (
                  current === next ||
                  (current instanceof Date && next instanceof Date && current.getTime() === next.getTime())
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
        maybeFail("delete", name);
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

function createFakeDb(opts: { failOn?: { op: "delete"; table: string } } = {}) {
  const state: FakeState = {
    failures: new Map(),
    requests: new Map(),
    activeClaims: new Map(),
    publishing: new Map(),
    agentRuns: new Map(),
    claims: new Map(),
  };
  const client = makeClient(state, undefined, opts);
  return { db: client as unknown as TerminalReplayExecutor, state };
}

/* ── Fixtures ──────────────────────────────────────────────────────── */

const PUB = { itemId: 5, userId: 18, campaignId: 4 };
const CG = { runId: 333, userId: 18, campaignId: 30, claimId: 91 };

function pubFailure(overrides: Partial<any> = {}) {
  return {
    id: 501,
    failureKey: "qtf:v1:publishing:publish-5",
    queueName: "publishing",
    bullmqJobId: "publish-5",
    terminalReason: "retries_exhausted",
    attemptsMade: 3,
    attemptsConfigured: 3,
    userId: PUB.userId,
    campaignId: PUB.campaignId,
    publishingQueueItemId: PUB.itemId,
    agentRunId: null,
    status: "open",
    ...overrides,
  };
}

function contentFailure(overrides: Partial<any> = {}) {
  return {
    id: 601,
    failureKey: "qtf:v1:content_generation:content-generation-333",
    queueName: "content_generation",
    bullmqJobId: "content-generation-333",
    terminalReason: "retries_exhausted",
    attemptsMade: 1,
    attemptsConfigured: 1,
    userId: CG.userId,
    campaignId: CG.campaignId,
    publishingQueueItemId: null,
    agentRunId: CG.runId,
    status: "open",
    ...overrides,
  };
}

function publishingRow(overrides: Partial<any> = {}) {
  return {
    id: PUB.itemId,
    userId: PUB.userId,
    campaignId: PUB.campaignId,
    platform: "TikTok",
    status: "published",
    publishedAt: NOW,
    retryCount: 2,
    nextRetryAt: null,
    lastError: null,
    ...overrides,
  };
}

function runRow(overrides: Partial<any> = {}) {
  return {
    id: CG.runId,
    userId: CG.userId,
    campaignId: CG.campaignId,
    agentType: "creative",
    status: "completed",
    input: { jobType: "content_generation_job", regenerate: false },
    output: { success: true },
    error: null,
    ...overrides,
  };
}

function claimRow(overrides: Partial<any> = {}) {
  return {
    id: CG.claimId,
    userId: CG.userId,
    campaignId: CG.campaignId,
    operationSource: "job",
    operationReferenceId: CG.runId,
    activeClaimKey: null,
    ownerToken: TOKEN,
    status: "completed",
    leaseExpiresAt: null,
    ...overrides,
  };
}

/** Seed an enqueued replay request directly (bypassing D1 creation). */
function seedEnqueuedRequest(state: FakeState, failure: any, overrides: Partial<any> = {}) {
  const id = 1000;
  const request = {
    id,
    replayKey: "op:reconcile:1",
    terminalFailureId: failure.id,
    failureKey: failure.failureKey,
    queueName: failure.queueName,
    originalBullmqJobId: failure.bullmqJobId,
    requestedByUserId: 1,
    reason: "operator replay",
    status: "enqueued",
    replayMode:
      failure.queueName === "publishing" ? "publishing_requeue" : "content_domain_recovery",
    replayBullmqJobId: failure.bullmqJobId,
    claimedAt: NOW,
    enqueuedAt: NOW,
    resolvedAt: null,
    failedAt: null,
    lastErrorSummary: null,
    contentRecoveryClaimId: null,
    contentRecoveryOwnerTokenHash: null,
    contentRecoveryPreparedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
  state.requests.set(id, request);
  state.activeClaims.set(failure.id, { terminalFailureId: failure.id, replayRequestId: id });
  return request;
}

function reconcile(db: TerminalReplayExecutor, id = 1000) {
  return reconcileTerminalReplayRequest({ replayRequestId: id, clock, executor: db });
}

/* ── Tests ─────────────────────────────────────────────────────────── */

describe("reconcileTerminalReplayRequest — general gates", () => {
  it("1. missing replay request -> not-found", async () => {
    const { db } = createFakeDb();
    await expect(reconcile(db, 424242)).rejects.toBeInstanceOf(TerminalReplayRequestNotFoundError);
  });

  it("2/3. resolved/failed request -> already_terminal, zero mutation", async () => {
    for (const status of ["resolved", "failed"] as const) {
      const { db, state } = createFakeDb();
      const failure = pubFailure();
      state.failures.set(failure.id, failure);
      seedEnqueuedRequest(state, failure, { status });
      const before = JSON.stringify(state.requests.get(1000));

      const result = await reconcile(db);

      expect(result).toMatchObject({ outcome: "already_terminal", status });
      expect(JSON.stringify(state.requests.get(1000))).toBe(before);
      expect(state.activeClaims.size).toBe(1);
    }
  });

  it("4/5. requested/claimed requests are not reconciled (pending, zero mutation)", async () => {
    for (const status of ["requested", "claimed"] as const) {
      const { db, state } = createFakeDb();
      const failure = pubFailure();
      state.failures.set(failure.id, failure);
      seedEnqueuedRequest(state, failure, { status });

      const result = await reconcile(db);

      expect(result).toMatchObject({ outcome: "pending", reason: "request_not_enqueued" });
      expect(state.requests.get(1000).status).toBe(status);
      expect(state.activeClaims.size).toBe(1);
    }
  });

  it("6. enqueued request without active guard fails closed", async () => {
    const { db, state } = createFakeDb();
    const failure = pubFailure();
    state.failures.set(failure.id, failure);
    seedEnqueuedRequest(state, failure);
    state.activeClaims.clear();

    await expect(reconcile(db)).rejects.toMatchObject({
      code: "active_guard_missing_or_foreign",
    });
    expect(state.requests.get(1000).status).toBe("enqueued");
  });

  it("7. foreign active guard fails closed", async () => {
    const { db, state } = createFakeDb();
    const failure = pubFailure();
    state.failures.set(failure.id, failure);
    seedEnqueuedRequest(state, failure);
    state.activeClaims.get(failure.id).replayRequestId = 999;

    await expect(reconcile(db)).rejects.toMatchObject({
      code: "active_guard_missing_or_foreign",
    });
    expect(state.requests.get(1000).status).toBe("enqueued");
  });

  it("8. missing original terminal failure fails closed", async () => {
    const { db, state } = createFakeDb();
    seedEnqueuedRequest(state, pubFailure());

    await expect(reconcile(db)).rejects.toMatchObject({ code: "terminal_failure_missing" });
    expect(state.requests.get(1000).status).toBe("enqueued");
  });

  it("9. failureKey mismatch fails closed", async () => {
    const { db, state } = createFakeDb();
    const failure = pubFailure();
    state.failures.set(failure.id, failure);
    seedEnqueuedRequest(state, failure);
    state.failures.get(failure.id).failureKey = "qtf:v1:publishing:tampered";

    await expect(reconcile(db)).rejects.toMatchObject({ code: "failure_identity_mismatch" });
  });

  it("10. original BullMQ identity mismatch fails closed", async () => {
    const { db, state } = createFakeDb();
    const failure = pubFailure();
    state.failures.set(failure.id, failure);
    seedEnqueuedRequest(state, failure);
    state.requests.get(1000).originalBullmqJobId = "publish-forged";

    await expect(reconcile(db)).rejects.toMatchObject({ code: "failure_identity_mismatch" });
  });

  it("11. replayBullmqJobId mismatch fails closed", async () => {
    const { db, state } = createFakeDb();
    const failure = pubFailure();
    state.failures.set(failure.id, failure);
    seedEnqueuedRequest(state, failure);
    state.requests.get(1000).replayBullmqJobId = "publish-other";

    await expect(reconcile(db)).rejects.toMatchObject({
      code: "deterministic_identity_mismatch",
    });
  });

  it("12. zero Redis usage (tripwire: module graph never constructs a client)", async () => {
    const { db, state } = createFakeDb();
    const failure = pubFailure();
    state.failures.set(failure.id, failure);
    state.publishing.set(PUB.itemId, publishingRow());
    seedEnqueuedRequest(state, failure);

    // Any ioredis construction throws; a clean resolve proves zero Redis use.
    await expect(reconcile(db)).resolves.toMatchObject({ outcome: "resolved" });
  });
});

describe("reconcileTerminalReplayRequest — publishing", () => {
  function pubWorld(overrides: Partial<any> = {}, requestOverrides: Partial<any> = {}) {
    const { db, state } = createFakeDb();
    const failure = pubFailure();
    state.failures.set(failure.id, failure);
    state.publishing.set(PUB.itemId, publishingRow(overrides));
    seedEnqueuedRequest(state, failure, requestOverrides);
    return { db, state, failure };
  }

  it("13+14. published row -> replay resolved and active guard released", async () => {
    const { db, state, failure } = pubWorld();

    const result = await reconcile(db);

    expect(result).toMatchObject({ outcome: "resolved", mode: "publishing_requeue" });
    expect(state.requests.get(1000).status).toBe("resolved");
    expect(state.requests.get(1000).resolvedAt).toEqual(NOW);
    expect(state.activeClaims.has(failure.id)).toBe(false);
  });

  it("15. resolved publishing replay rerun is idempotent (already_terminal)", async () => {
    const { db, state } = pubWorld();
    await reconcile(db);

    const rerun = await reconcile(db);

    expect(rerun).toMatchObject({ outcome: "already_terminal", status: "resolved" });
  });

  it("16+17+25. failed row -> replay failed with SAFE fixed reason, guard released, no provider text", async () => {
    const { db, state, failure } = pubWorld({
      status: "failed",
      publishedAt: null,
      lastError: "provider exploded token=sk-live-zzz",
    });

    const result = await reconcile(db);

    expect(result).toMatchObject({ outcome: "failed", mode: "publishing_requeue" });
    expect(state.requests.get(1000).status).toBe("failed");
    expect(state.requests.get(1000).lastErrorSummary).toBe(
      "Publishing replay reached durable failed state"
    );
    expect(state.requests.get(1000).lastErrorSummary).not.toContain("sk-live-zzz");
    expect(state.activeClaims.has(failure.id)).toBe(false);
  });

  it("18. retrying row -> pending in_progress, guard retained, no mutation", async () => {
    const { db, state, failure } = pubWorld({ status: "retrying", publishedAt: null });

    const result = await reconcile(db);

    expect(result).toMatchObject({
      outcome: "pending",
      reason: "publishing_in_progress",
    });
    expect(state.requests.get(1000).status).toBe("enqueued");
    expect(state.activeClaims.has(failure.id)).toBe(true);
  });

  it.each(["approved", "pending_approval", "safety_blocked"])(
    "19/20/21. %s row -> inconclusive pending, guard retained",
    async (status) => {
      const { db, state, failure } = pubWorld({ status, publishedAt: null });

      const result = await reconcile(db);

      expect(result).toMatchObject({ outcome: "pending", reason: "publishing_inconclusive" });
      expect(state.requests.get(1000).status).toBe("enqueued");
      expect(state.activeClaims.has(failure.id)).toBe(true);
    }
  );

  it("22. publishing queue item missing -> no terminal replay mutation", async () => {
    const { db, state, failure } = pubWorld();
    state.publishing.clear();

    await expect(reconcile(db)).rejects.toMatchObject({ code: "domain_identity_mismatch" });
    expect(state.requests.get(1000).status).toBe("enqueued");
    expect(state.activeClaims.has(failure.id)).toBe(true);
  });

  it("23. wrong publishing row user fails closed", async () => {
    const { db, state } = pubWorld({ userId: 999 });

    await expect(reconcile(db)).rejects.toMatchObject({ code: "domain_identity_mismatch" });
    expect(state.requests.get(1000).status).toBe("enqueued");
  });

  it("24. publishing terminal-failure deterministic job ID round-trip required", async () => {
    const { db, state } = pubWorld();
    state.failures.get(501).bullmqJobId = "rogue-id";
    state.requests.get(1000).originalBullmqJobId = "rogue-id";

    await expect(reconcile(db)).rejects.toMatchObject({
      code: "deterministic_identity_mismatch",
    });
    expect(state.requests.get(1000).status).toBe("enqueued");
  });
});

describe("reconcileTerminalReplayRequest — content", () => {
  function contentWorld(
    runOverrides: Partial<any> = {},
    claimOverrides: Partial<any> = {},
    requestOverrides: Partial<any> = {}
  ) {
    const { db, state } = createFakeDb();
    const failure = contentFailure();
    state.failures.set(failure.id, failure);
    state.agentRuns.set(CG.runId, runRow(runOverrides));
    state.claims.set(CG.claimId, claimRow(claimOverrides));
    seedEnqueuedRequest(state, failure, {
      contentRecoveryClaimId: CG.claimId,
      contentRecoveryOwnerTokenHash: hash(TOKEN),
      ...requestOverrides,
    });
    return { db, state, failure };
  }

  it("26+27. run completed + exact bound claim completed -> resolved, guard released", async () => {
    const { db, state, failure } = contentWorld();

    const result = await reconcile(db);

    expect(result).toMatchObject({ outcome: "resolved", mode: "content_domain_recovery" });
    expect(state.requests.get(1000).status).toBe("resolved");
    expect(state.activeClaims.has(failure.id)).toBe(false);
  });

  it("28+29+48. run failed + bound claim failed -> replay failed, safe reason, guard released, no raw errors", async () => {
    const { db, state, failure } = contentWorld(
      { status: "failed", error: "agent exploded password=hunter2" },
      { status: "failed" }
    );

    const result = await reconcile(db);

    expect(result).toMatchObject({ outcome: "failed", mode: "content_domain_recovery" });
    expect(state.requests.get(1000).status).toBe("failed");
    expect(state.requests.get(1000).lastErrorSummary).toBe(
      "Content replay reached durable failed state"
    );
    expect(state.requests.get(1000).lastErrorSummary).not.toContain("hunter2");
    expect(state.activeClaims.has(failure.id)).toBe(false);
  });

  it("30. running run + running claim -> pending in_progress, guard retained", async () => {
    const { db, state, failure } = contentWorld(
      { status: "running" },
      { status: "running", activeClaimKey: "active:18:30:creative", leaseExpiresAt: new Date(NOW.getTime() + 60_000) }
    );

    const result = await reconcile(db);

    expect(result).toMatchObject({ outcome: "pending", reason: "content_in_progress" });
    expect(state.requests.get(1000).status).toBe("enqueued");
    expect(state.activeClaims.has(failure.id)).toBe(true);
  });

  it.each([
    ["completed", "running"],
    ["completed", "failed"],
    ["failed", "running"],
    ["failed", "completed"],
    ["running", "completed"],
    ["running", "failed"],
  ])(
    "31-35. run %s + claim %s -> inconclusive, guard retained, no terminal mutation",
    async (runStatus, claimStatus) => {
      const { db, state, failure } = contentWorld(
        { status: runStatus },
        {
          status: claimStatus,
          activeClaimKey: claimStatus === "running" ? "active:18:30:creative" : null,
          leaseExpiresAt: claimStatus === "running" ? new Date(NOW.getTime() + 60_000) : null,
        }
      );

      const result = await reconcile(db);

      expect(result).toMatchObject({ outcome: "pending", reason: "content_inconclusive" });
      expect(state.requests.get(1000).status).toBe("enqueued");
      expect(state.activeClaims.has(failure.id)).toBe(true);
    }
  );

  it("36. missing agent run fails closed", async () => {
    const { db, state } = contentWorld();
    state.agentRuns.clear();

    await expect(reconcile(db)).rejects.toMatchObject({ code: "domain_identity_mismatch" });
    expect(state.requests.get(1000).status).toBe("enqueued");
  });

  it("37/38. wrong run user/campaign fails closed", async () => {
    for (const overrides of [{ userId: 999 }, { campaignId: 31 }]) {
      const { db, state } = contentWorld(overrides);
      await expect(reconcile(db)).rejects.toMatchObject({ code: "domain_identity_mismatch" });
      expect(state.requests.get(1000).status).toBe("enqueued");
    }
  });

  it("39. wrong run agentType/jobType fails closed", async () => {
    const { db, state } = contentWorld({ agentType: "strategy", input: { jobType: "strategy" } });

    await expect(reconcile(db)).rejects.toMatchObject({ code: "domain_identity_mismatch" });
    expect(state.requests.get(1000).status).toBe("enqueued");
  });

  it("40. missing content binding fails closed without terminal mutation", async () => {
    const { db, state, failure } = contentWorld();
    state.requests.get(1000).contentRecoveryClaimId = null;
    state.requests.get(1000).contentRecoveryOwnerTokenHash = null;

    await expect(reconcile(db)).rejects.toMatchObject({ code: "content_binding_missing" });
    expect(state.requests.get(1000).status).toBe("enqueued");
    expect(state.activeClaims.has(failure.id)).toBe(true);
  });

  it("41. bound claim missing -> inconclusive pending, no terminal mutation", async () => {
    const { db, state, failure } = contentWorld();
    state.claims.clear();

    const result = await reconcile(db);

    expect(result).toMatchObject({ outcome: "pending", reason: "content_inconclusive" });
    expect(state.requests.get(1000).status).toBe("enqueued");
    expect(state.activeClaims.has(failure.id)).toBe(true);
  });

  it("42. exact bound claim is used; newer unrelated claim ignored", async () => {
    const { db, state } = contentWorld();
    // A newer, healthy, unrelated claim for the same user/campaign.
    state.claims.set(92, claimRow({
      id: 92,
      operationReferenceId: 999,
      status: "running",
      activeClaimKey: "active:18:30:other",
      leaseExpiresAt: new Date(NOW.getTime() + 60_000),
    }));

    const result = await reconcile(db);

    expect(result).toMatchObject({ outcome: "resolved" });
    expect(state.claims.get(92).status).toBe("running"); // untouched
  });

  it("43. claim user/campaign mismatch fails closed", async () => {
    const { db, state } = contentWorld({}, { userId: 999 });

    await expect(reconcile(db)).rejects.toMatchObject({ code: "domain_identity_mismatch" });
    expect(state.requests.get(1000).status).toBe("enqueued");
  });

  it("44. claim operationSource != job fails closed", async () => {
    const { db, state } = contentWorld({}, { operationSource: "approval" });

    await expect(reconcile(db)).rejects.toMatchObject({ code: "domain_identity_mismatch" });
    expect(state.requests.get(1000).status).toBe("enqueued");
  });

  it("45. claim operationReferenceId != agentRunId fails closed", async () => {
    const { db, state } = contentWorld({}, { operationReferenceId: 777 });

    await expect(reconcile(db)).rejects.toMatchObject({ code: "domain_identity_mismatch" });
    expect(state.requests.get(1000).status).toBe("enqueued");
  });

  it("46. owner-token fingerprint mismatch fails closed and keeps the guard", async () => {
    const { db, state, failure } = contentWorld({}, { ownerToken: "c".repeat(64) });

    await expect(reconcile(db)).rejects.toMatchObject({
      code: "owner_token_fingerprint_mismatch",
    });
    expect(state.requests.get(1000).status).toBe("enqueued");
    expect(state.activeClaims.has(failure.id)).toBe(true);
  });

  it("47. content deterministic BullMQ ID round-trip required", async () => {
    const { db, state } = contentWorld();
    state.failures.get(601).bullmqJobId = "content-generation-334";
    state.requests.get(1000).originalBullmqJobId = "content-generation-334";

    await expect(reconcile(db)).rejects.toMatchObject({
      code: "deterministic_identity_mismatch",
    });
    expect(state.requests.get(1000).status).toBe("enqueued");
  });
});

describe("reconcileTerminalReplayRequest — concurrency/atomicity", () => {
  it("49. active-claim DELETE failure on resolve rolls the terminal transition back", async () => {
    const { db, state } = createFakeDb({
      failOn: { op: "delete", table: "queue_replay_active_claims" },
    });
    const failure = pubFailure();
    state.failures.set(failure.id, failure);
    state.publishing.set(PUB.itemId, publishingRow());
    seedEnqueuedRequest(state, failure);

    await expect(reconcile(db)).rejects.toThrow("injected delete failure");

    expect(state.requests.get(1000).status).toBe("enqueued");
    expect(state.requests.get(1000).resolvedAt).toBeNull();
    expect(state.activeClaims.has(failure.id)).toBe(true);
  });

  it("50. active-claim DELETE failure on fail rolls the terminal transition back", async () => {
    const { db, state } = createFakeDb({
      failOn: { op: "delete", table: "queue_replay_active_claims" },
    });
    const failure = pubFailure();
    state.failures.set(failure.id, failure);
    state.publishing.set(PUB.itemId, publishingRow({ status: "failed", publishedAt: null }));
    seedEnqueuedRequest(state, failure);

    await expect(reconcile(db)).rejects.toThrow("injected delete failure");

    expect(state.requests.get(1000).status).toBe("enqueued");
    expect(state.requests.get(1000).failedAt).toBeNull();
    expect(state.activeClaims.has(failure.id)).toBe(true);
  });

  it("51. concurrent reconciliation cannot resolve then fail the same request", async () => {
    const { db, state } = (() => {
      const world = createFakeDb();
      const failure = pubFailure();
      world.state.failures.set(failure.id, failure);
      world.state.publishing.set(PUB.itemId, publishingRow());
      seedEnqueuedRequest(world.state, failure);
      return world;
    })();

    await expect(reconcile(db)).resolves.toMatchObject({ outcome: "resolved" });

    // A competing failure path can no longer transition the resolved request:
    // reset domain state to failed — the governed transition still refuses.
    state.publishing.get(PUB.itemId).status = "failed";
    state.publishing.get(PUB.itemId).publishedAt = null;
    await expect(reconcile(db)).resolves.toMatchObject({
      outcome: "already_terminal",
      status: "resolved",
    });
    expect(state.requests.get(1000).status).toBe("resolved");
  });

  it("52. pending rerun remains mutation-free and repeatable", async () => {
    const { db, state, failure } = (() => {
      const world = createFakeDb();
      const f = pubFailure();
      world.state.failures.set(f.id, f);
      world.state.publishing.set(PUB.itemId, publishingRow({ status: "retrying", publishedAt: null }));
      seedEnqueuedRequest(world.state, f);
      return { ...world, failure: f };
    })();
    const before = JSON.stringify(state.requests.get(1000));

    for (let i = 0; i < 2; i++) {
      const result = await reconcile(db);
      expect(result).toMatchObject({ outcome: "pending", reason: "publishing_in_progress" });
    }
    expect(JSON.stringify(state.requests.get(1000))).toBe(before);
    expect(state.activeClaims.has(failure.id)).toBe(true);
  });

  it("53. terminal rerun never reacquires or releases another guard", async () => {
    const { db, state, failure } = (() => {
      const world = createFakeDb();
      const f = pubFailure();
      world.state.failures.set(f.id, f);
      world.state.publishing.set(PUB.itemId, publishingRow());
      seedEnqueuedRequest(world.state, f);
      return { ...world, failure: f };
    })();

    await reconcile(db); // resolves + releases guard
    expect(state.activeClaims.size).toBe(0);

    const rerun = await reconcile(db);
    expect(rerun).toMatchObject({ outcome: "already_terminal", status: "resolved" });
    expect(state.activeClaims.size).toBe(0);
  });
});
