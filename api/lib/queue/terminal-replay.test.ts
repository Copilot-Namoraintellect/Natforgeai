import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../alerts", () => ({
  createAlert: vi.fn(async () => ({ id: 1 })),
}));

// Hard guard: constructing a real Redis client inside this slice's module
// graph is a test failure.
vi.mock("ioredis", () => ({
  Redis: class {
    constructor() {
      throw new Error("real Redis must never be constructed in terminal-replay tests");
    }
  },
}));

// Spy seam: the replay authority must never enqueue, requeue, or mutate
// queue state in this slice.
vi.mock("./bullmq", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bullmq")>();
  return {
    ...actual,
    schedulePublishingJob: vi.fn(actual.schedulePublishingJob),
    scheduleContentGenerationJob: vi.fn(actual.scheduleContentGenerationJob),
    removePublishingJob: vi.fn(actual.removePublishingJob),
    createPublishingWorker: vi.fn(actual.createPublishingWorker),
    createContentGenerationWorker: vi.fn(actual.createContentGenerationWorker),
  };
});

import {
  TerminalReplayInvalidTransitionError,
  TerminalReplayKeyConflictError,
  TerminalReplayTargetNotFoundError,
  claimTerminalReplayRequest,
  classifyTerminalReplay,
  markTerminalReplayEnqueued,
  markTerminalReplayFailed,
  markTerminalReplayResolved,
  requestTerminalFailureReplay,
} from "./terminal-replay";
import type { TerminalReplayExecutor } from "./terminal-replay";
import { schedulePublishingJob, scheduleContentGenerationJob } from "./bullmq";

/* ── In-memory fake db with statement visibility + journal rollback ── */

interface FakeState {
  failures: Map<number, any>;
  requests: Map<number, any>;
  activeClaims: Map<number, any>;
}

interface FakeOptions {
  /** Inject a failure when an op runs against a table (mid-claim rollback). */
  failOn?: { op: "insert" | "update" | "delete"; table: string };
}

type Undo = () => void;

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

/** Evaluates the eq/and conditions this module actually emits. */
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

/**
 * Statement-level fake: mutations are visible immediately (like MySQL
 * READ-COMMITTED statement visibility), and a transaction records an undo
 * journal so a throw rolls back every mutation it made. Unique authorities
 * (replayKey, terminalFailureId) are enforced at insert time against the
 * committed state, so concurrency races are decided by the fake's maps —
 * exactly like the database unique constraints they model.
 */
function makeClient(state: FakeState, opts: FakeOptions = {}, journal?: Undo[]) {
  const record = (undo: Undo) => {
    journal?.push(undo);
  };
  const maybeFail = (op: "insert" | "update" | "delete", table: string) => {
    if (opts.failOn?.op === op && opts.failOn.table === table) {
      throw new Error(`injected ${op} failure on ${table}`);
    }
  };

  const db: any = {
    insert: vi.fn((table: any) => ({
      values: vi.fn(async (values: any) => {
        const name = tableName(table);
        maybeFail("insert", name);
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
          // Durable unique authority: terminalFailureId ALONE.
          if (state.activeClaims.has(values.terminalFailureId)) throw dupErr();
          state.activeClaims.set(values.terminalFailureId, { ...values });
          record(() => state.activeClaims.delete(values.terminalFailureId));
          return [{ insertId: 0, affectedRows: 1 }];
        }
        throw new Error(`Unexpected insert into ${name} — queue evidence must not be mutated`);
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
                      : [];
              return rows.filter((r) => evalCond(cond, r)).slice(0, n);
            }),
          })),
        };
      }),
    })),
    update: vi.fn((table: any) => {
      const name = tableName(table);
      return {
        set: vi.fn((values: any) => ({
          where: vi.fn(async (cond: any) => {
            maybeFail("update", name);
            if (name !== "queue_replay_requests") {
              throw new Error(`Unexpected update on ${name} — queue evidence must not be mutated`);
            }
            let affected = 0;
            for (const row of state.requests.values()) {
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
      };
    }),
    delete: vi.fn((table: any) => {
      const name = tableName(table);
      return {
        where: vi.fn(async (cond: any) => {
          maybeFail("delete", name);
          if (name !== "queue_replay_active_claims") {
            throw new Error(`Unexpected delete on ${name} — queue evidence must not be mutated`);
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
      };
    }),
    // Transaction = atomic unit: statements execute against the committed
    // state (visible to concurrent transactions, like the real unique-index
    // enforcement); on throw the undo journal rolls everything back.
    transaction: vi.fn(async (cb: any) => {
      const txJournal: Undo[] = [];
      const txClient = makeClient(state, opts, txJournal);
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

function createFakeDb(seedFailures: any[] = [], opts: FakeOptions = {}) {
  const state: FakeState = { failures: new Map(), requests: new Map(), activeClaims: new Map() };
  for (const failure of seedFailures) state.failures.set(failure.id, { ...failure });
  const client = makeClient(state, opts);
  return {
    db: client as unknown as TerminalReplayExecutor,
    state,
    get requests() {
      return state.requests;
    },
    get activeClaims() {
      return state.activeClaims;
    },
  };
}

/* ── Fixtures ──────────────────────────────────────────────────────── */

const publishingFailure = {
  id: 501,
  failureKey: "qtf:v1:publishing:publish-5",
  queueName: "publishing",
  bullmqJobId: "publish-5",
  terminalReason: "retries_exhausted",
  attemptsMade: 3,
  attemptsConfigured: 3,
  userId: 18,
  campaignId: null,
  publishingQueueItemId: 5,
  agentRunId: null,
  status: "open",
};

const contentFailure = {
  id: 502,
  failureKey: "qtf:v1:content_generation:content-generation-333",
  queueName: "content_generation",
  bullmqJobId: "content-generation-333",
  terminalReason: "unrecoverable",
  attemptsMade: 1,
  attemptsConfigured: 3,
  userId: 18,
  campaignId: 30,
  publishingQueueItemId: null,
  agentRunId: 333,
  status: "open",
};

const otherPublishingFailure = {
  ...publishingFailure,
  id: 503,
  failureKey: "qtf:v1:publishing:publish-6",
  bullmqJobId: "publish-6",
  publishingQueueItemId: 6,
};

function replayInput(overrides: Partial<any> = {}) {
  return {
    replayKey: "operator:replay:2026-06-29:publish-5",
    terminalFailureId: publishingFailure.id,
    requestedByUserId: 1,
    reason: "operator approved replay",
    ...overrides,
  };
}

/* ── Tests ─────────────────────────────────────────────────────────── */

describe("classifyTerminalReplay", () => {
  it("publishing classifies as publishing_requeue", () => {
    expect(classifyTerminalReplay("publishing")).toBe("publishing_requeue");
  });

  it("content_generation classifies as content_domain_recovery (not generic BullMQ retry)", () => {
    expect(classifyTerminalReplay("content_generation")).toBe("content_domain_recovery");
  });
});

describe("requestTerminalFailureReplay", () => {
  it("creates the first request with identity copied from the durable terminal failure", async () => {
    const { db, requests } = createFakeDb([publishingFailure]);

    const { record, alreadyRequested } = await requestTerminalFailureReplay(replayInput(), db);

    expect(alreadyRequested).toBe(false);
    expect(requests.size).toBe(1);
    expect(record.status).toBe("requested");
    expect(record.replayMode).toBe("publishing_requeue");
    expect(record.terminalFailureId).toBe(publishingFailure.id);
    expect(record.failureKey).toBe(publishingFailure.failureKey);
    expect(record.queueName).toBe("publishing");
    expect(record.originalBullmqJobId).toBe("publish-5");
    expect(record.requestedByUserId).toBe(1);
  });

  it("content-generation failures request content_domain_recovery", async () => {
    const { db, requests } = createFakeDb([contentFailure]);

    const { record } = await requestTerminalFailureReplay(
      replayInput({ terminalFailureId: contentFailure.id, replayKey: "op:cg:333" }),
      db
    );

    expect(record.replayMode).toBe("content_domain_recovery");
    expect(record.originalBullmqJobId).toBe("content-generation-333");
    expect(requests.size).toBe(1);
  });

  it("exact request replay is idempotent and reuses the row", async () => {
    const { db, requests } = createFakeDb([publishingFailure]);

    const first = await requestTerminalFailureReplay(replayInput(), db);
    const second = await requestTerminalFailureReplay(replayInput(), db);

    expect(first.alreadyRequested).toBe(false);
    expect(second.alreadyRequested).toBe(true);
    expect(second.record.id).toBe(first.record.id);
    expect(requests.size).toBe(1);
  });

  it("same replay key bound to a different terminal failure fails closed", async () => {
    const { db, requests } = createFakeDb([publishingFailure, otherPublishingFailure]);

    await requestTerminalFailureReplay(replayInput(), db);
    await expect(
      requestTerminalFailureReplay(replayInput({ terminalFailureId: otherPublishingFailure.id }), db)
    ).rejects.toBeInstanceOf(TerminalReplayKeyConflictError);
    expect(requests.size).toBe(1);
  });

  it("same replay key from a different requesting operator fails closed", async () => {
    const { db } = createFakeDb([publishingFailure]);

    await requestTerminalFailureReplay(replayInput({ requestedByUserId: 1 }), db);
    await expect(
      requestTerminalFailureReplay(replayInput({ requestedByUserId: 2 }), db)
    ).rejects.toBeInstanceOf(TerminalReplayKeyConflictError);
  });

  it("unknown terminal failure id fails", async () => {
    const { db } = createFakeDb([publishingFailure]);

    await expect(
      requestTerminalFailureReplay(replayInput({ terminalFailureId: 12345 }), db)
    ).rejects.toBeInstanceOf(TerminalReplayTargetNotFoundError);
  });

  it("caller-forged queue/job identity is ignored in favour of the durable record", async () => {
    const { db, requests } = createFakeDb([publishingFailure]);

    const forged = {
      ...replayInput(),
      queueName: "content_generation",
      originalBullmqJobId: "forged-job-id",
      failureKey: "qtf:v1:content_generation:forged",
    } as any;
    const { record } = await requestTerminalFailureReplay(forged, db);

    expect(record.queueName).toBe("publishing");
    expect(record.originalBullmqJobId).toBe("publish-5");
    expect(record.failureKey).toBe(publishingFailure.failureKey);
    expect(Array.from(requests.values())[0].queueName).toBe("publishing");
  });
});

describe("active-claim unique authority", () => {
  it("concurrent DIFFERENT requests for the SAME terminal failure: the DB unique authority decides exactly one winner", async () => {
    const { db, requests, activeClaims } = createFakeDb([publishingFailure]);
    const a = await requestTerminalFailureReplay(replayInput({ replayKey: "op:a" }), db);
    const b = await requestTerminalFailureReplay(replayInput({ replayKey: "op:b" }), db);

    // Both claims start before either completes; the fake's unique
    // terminalFailureId authority decides the race — not the test.
    const [outcomeA, outcomeB] = await Promise.all([
      claimTerminalReplayRequest(a.record.id, undefined, db),
      claimTerminalReplayRequest(b.record.id, undefined, db),
    ]);

    const outcomes = [outcomeA, outcomeB];
    expect(outcomes.filter((o) => o.claimed)).toHaveLength(1);
    const winner = outcomes.find((o) => o.claimed)!;
    const loser = outcomes.find((o) => !o.claimed)!;
    expect(loser.reason).toBe("already_active");

    // Exactly one active claim row exists for the terminal failure.
    expect(activeClaims.size).toBe(1);
    expect(activeClaims.get(publishingFailure.id)!.replayRequestId).toBe(winner.request.id);

    // The loser remains requested / unclaimed.
    const loserRow = Array.from(requests.values()).find((r) => r.id === loser.request.id)!;
    expect(loserRow.status).toBe("requested");
  });

  it("same-request claim replay keeps idempotent semantics and creates no additional active row", async () => {
    const { db, activeClaims } = createFakeDb([publishingFailure]);
    const { record } = await requestTerminalFailureReplay(replayInput(), db);
    const first = await claimTerminalReplayRequest(record.id, undefined, db);
    expect(first.claimed).toBe(true);

    const again = await claimTerminalReplayRequest(record.id, undefined, db);
    expect(again).toMatchObject({ claimed: false, reason: "invalid_state" });
    expect(activeClaims.size).toBe(1);
  });

  it("different terminal failures can be claimed concurrently", async () => {
    const { db, activeClaims } = createFakeDb([publishingFailure, otherPublishingFailure]);
    const a = await requestTerminalFailureReplay(replayInput({ replayKey: "op:a" }), db);
    const b = await requestTerminalFailureReplay(
      replayInput({ replayKey: "op:b", terminalFailureId: otherPublishingFailure.id }),
      db
    );

    const [outcomeA, outcomeB] = await Promise.all([
      claimTerminalReplayRequest(a.record.id, undefined, db),
      claimTerminalReplayRequest(b.record.id, undefined, db),
    ]);

    expect(outcomeA.claimed).toBe(true);
    expect(outcomeB.claimed).toBe(true);
    expect(activeClaims.size).toBe(2);
  });

  it("enqueued state retains the active claim and blocks another request", async () => {
    const { db, activeClaims } = createFakeDb([publishingFailure]);
    const a = await requestTerminalFailureReplay(replayInput({ replayKey: "op:a" }), db);
    const b = await requestTerminalFailureReplay(replayInput({ replayKey: "op:b" }), db);

    const claimed = await claimTerminalReplayRequest(a.record.id, undefined, db);
    expect(claimed.claimed).toBe(true);
    await markTerminalReplayEnqueued(a.record.id, { replayBullmqJobId: "publish-5-replay" }, db);

    // Guard must still be held while enqueued.
    expect(activeClaims.size).toBe(1);

    const blocked = await claimTerminalReplayRequest(b.record.id, undefined, db);
    expect(blocked).toMatchObject({ claimed: false, reason: "already_active" });
    expect(activeClaims.size).toBe(1);
  });

  it("resolve/fail releases the terminalFailureId authority; a later different request may then be claimed", async () => {
    const { db, activeClaims } = createFakeDb([publishingFailure]);
    const first = await requestTerminalFailureReplay(replayInput({ replayKey: "op:a" }), db);
    const second = await requestTerminalFailureReplay(replayInput({ replayKey: "op:b" }), db);

    await claimTerminalReplayRequest(first.record.id, undefined, db);
    await markTerminalReplayEnqueued(first.record.id, undefined, db);
    await markTerminalReplayResolved(first.record.id, undefined, db);
    expect(activeClaims.size).toBe(0);

    const later = await claimTerminalReplayRequest(second.record.id, undefined, db);
    expect(later.claimed).toBe(true);
    expect(activeClaims.size).toBe(1);

    // fail path also releases the terminalFailureId authority
    await markTerminalReplayFailed(second.record.id, { error: new Error("aborted") }, db);
    expect(activeClaims.size).toBe(0);
  });

  it("mid-claim failure rolls back BOTH the request-state change and the active claim", async () => {
    const { db, requests, activeClaims } = createFakeDb([publishingFailure], {
      failOn: { op: "update", table: "queue_replay_requests" },
    });
    const { record } = await requestTerminalFailureReplay(replayInput(), db);

    await expect(
      claimTerminalReplayRequest(record.id, undefined, db)
    ).rejects.toThrow("injected update failure");

    // Neither half of the claim survived.
    expect(activeClaims.size).toBe(0);
    expect(Array.from(requests.values())[0].status).toBe("requested");
  });

  it("non-duplicate database errors are NOT converted into already-claimed", async () => {
    const { db, requests, activeClaims } = createFakeDb([publishingFailure], {
      failOn: { op: "insert", table: "queue_replay_active_claims" },
    });
    const { record } = await requestTerminalFailureReplay(replayInput(), db);

    await expect(
      claimTerminalReplayRequest(record.id, undefined, db)
    ).rejects.toThrow("injected insert failure");
    expect(activeClaims.size).toBe(0);
    expect(Array.from(requests.values())[0].status).toBe("requested");
  });
});

describe("guarded state machine", () => {
  it("requested -> claimed -> enqueued -> resolved", async () => {
    const { db, requests } = createFakeDb([publishingFailure]);
    const { record } = await requestTerminalFailureReplay(replayInput(), db);

    const claimed = await claimTerminalReplayRequest(record.id, undefined, db);
    expect(claimed.claimed).toBe(true);

    const enqueued = await markTerminalReplayEnqueued(
      record.id,
      { replayBullmqJobId: "publish-5-replay" },
      db
    );
    expect(enqueued.status).toBe("enqueued");
    expect(enqueued.replayBullmqJobId).toBe("publish-5-replay");

    const resolved = await markTerminalReplayResolved(record.id, undefined, db);
    expect(resolved.status).toBe("resolved");

    const row = Array.from(requests.values())[0];
    expect(row.claimedAt).toBeInstanceOf(Date);
    expect(row.enqueuedAt).toBeInstanceOf(Date);
    expect(row.resolvedAt).toBeInstanceOf(Date);
  });

  it("requested -> failed and claimed -> failed are allowed", async () => {
    const { db } = createFakeDb([publishingFailure]);
    const a = await requestTerminalFailureReplay(replayInput({ replayKey: "op:a" }), db);
    const failedFromRequested = await markTerminalReplayFailed(
      a.record.id,
      { error: new Error("operator cancelled") },
      db
    );
    expect(failedFromRequested.status).toBe("failed");

    const b = await requestTerminalFailureReplay(replayInput({ replayKey: "op:b" }), db);
    await claimTerminalReplayRequest(b.record.id, undefined, db);
    const failedFromClaimed = await markTerminalReplayFailed(
      b.record.id,
      { error: new Error("replay worker rejected") },
      db
    );
    expect(failedFromClaimed.status).toBe("failed");
  });

  it("terminal requests cannot reopen: resolved cannot be reclaimed or re-enqueued", async () => {
    const { db } = createFakeDb([publishingFailure]);
    const { record } = await requestTerminalFailureReplay(replayInput(), db);
    await claimTerminalReplayRequest(record.id, undefined, db);
    await markTerminalReplayEnqueued(record.id, undefined, db);
    await markTerminalReplayResolved(record.id, undefined, db);

    const reclaim = await claimTerminalReplayRequest(record.id, undefined, db);
    expect(reclaim).toMatchObject({ claimed: false, reason: "invalid_state" });
    await expect(
      markTerminalReplayEnqueued(record.id, undefined, db)
    ).rejects.toBeInstanceOf(TerminalReplayInvalidTransitionError);
  });

  it("failed request cannot silently return to requested/claimed", async () => {
    const { db } = createFakeDb([publishingFailure]);
    const { record } = await requestTerminalFailureReplay(replayInput(), db);
    await markTerminalReplayFailed(record.id, { error: new Error("done") }, db);

    const reclaim = await claimTerminalReplayRequest(record.id, undefined, db);
    expect(reclaim).toMatchObject({ claimed: false, reason: "invalid_state" });
  });

  it("requested cannot resolve directly; claimed may resolve for already-completed targets; resolved cannot re-resolve", async () => {
    const { db } = createFakeDb([publishingFailure]);
    const { record } = await requestTerminalFailureReplay(replayInput(), db);

    // requested -> resolved is NOT a valid shortcut (WBS9D2A correction).
    await expect(
      markTerminalReplayResolved(record.id, undefined, db)
    ).rejects.toBeInstanceOf(TerminalReplayInvalidTransitionError);

    // requested -> claimed -> resolved IS the governed already-completed path.
    await claimTerminalReplayRequest(record.id, undefined, db);
    const resolved = await markTerminalReplayResolved(record.id, undefined, db);
    expect(resolved.status).toBe("resolved");

    await expect(
      markTerminalReplayResolved(record.id, undefined, db)
    ).rejects.toBeInstanceOf(TerminalReplayInvalidTransitionError);
  });

  it("enqueued -> resolved remains valid and enqueued cannot re-enqueue", async () => {
    const { db } = createFakeDb([publishingFailure]);
    const { record } = await requestTerminalFailureReplay(replayInput(), db);
    await claimTerminalReplayRequest(record.id, undefined, db);

    await markTerminalReplayEnqueued(record.id, undefined, db);
    const resolved = await markTerminalReplayResolved(record.id, undefined, db);
    expect(resolved.status).toBe("resolved");
    await expect(
      markTerminalReplayEnqueued(record.id, undefined, db)
    ).rejects.toBeInstanceOf(TerminalReplayInvalidTransitionError);
  });
});

describe("safe error material", () => {
  it("sensitive material is redacted and bounded in lastErrorSummary", async () => {
    const { db, requests } = createFakeDb([publishingFailure]);
    const { record } = await requestTerminalFailureReplay(replayInput(), db);

    const err: any = new Error("replay crashed token=sk-live-zzz Authorization: Bearer abc123");
    err.stack = "Error: replay crashed\n    at hidden (/app/file.js:1:1)";
    await markTerminalReplayFailed(record.id, { error: err }, db);

    const row = Array.from(requests.values())[0];
    expect(row.lastErrorSummary).not.toContain("sk-live-zzz");
    expect(row.lastErrorSummary).not.toContain("abc123");
    expect(row.lastErrorSummary).toContain("[redacted]");
    expect(row.lastErrorSummary).not.toContain("at hidden");
  });
});

describe("no queue side effects in this slice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("performs no BullMQ scheduling/requeue operations", async () => {
    const { db } = createFakeDb([publishingFailure, contentFailure]);

    const pub = await requestTerminalFailureReplay(replayInput(), db);
    await claimTerminalReplayRequest(pub.record.id, undefined, db);
    await markTerminalReplayEnqueued(pub.record.id, { replayBullmqJobId: "publish-5-replay" }, db);
    await markTerminalReplayResolved(pub.record.id, undefined, db);

    const cg = await requestTerminalFailureReplay(
      replayInput({ terminalFailureId: contentFailure.id, replayKey: "op:cg" }),
      db
    );
    await claimTerminalReplayRequest(cg.record.id, undefined, db);
    await markTerminalReplayFailed(cg.record.id, { error: new Error("nope") }, db);

    expect(schedulePublishingJob).not.toHaveBeenCalled();
    expect(scheduleContentGenerationJob).not.toHaveBeenCalled();
  });
});
