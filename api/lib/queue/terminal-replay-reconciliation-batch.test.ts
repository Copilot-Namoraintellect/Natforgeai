import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("../alerts", () => ({
  createAlert: vi.fn(async () => ({ id: 1 })),
}));

// Redis tripwire.
vi.mock("ioredis", () => ({
  Redis: class {
    constructor() {
      throw new Error("real Redis must never be constructed in batch tests");
    }
  },
}));

import {
  TERMINAL_REPLAY_BATCH_DEFAULT_LIMIT,
  TERMINAL_REPLAY_BATCH_MAX_LIMIT,
  reconcileTerminalReplayBatch,
} from "./terminal-replay-reconciliation-batch";
import { ReplayReconciliationInvariantError } from "./terminal-replay-reconciliation";
import type { TerminalReplayExecutor } from "./terminal-replay";

const NOW = new Date("2026-06-29T12:00:00.000Z");
const clock = () => NOW;

/* ── In-memory fake (queue_replay_requests selection only) ─────────── */

function evalEq(cond: any, row: any): boolean {
  const chunks: any[] = cond?.queryChunks ?? [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk && typeof chunk === "object" && typeof chunk.name === "string" && chunk.table) {
      const param = chunks[i + 2];
      const value = param && typeof param === "object" && "value" in param ? param.value : param;
      if (row[chunk.name] !== value) return false;
      i += 2;
    }
  }
  return true;
}

function ascColumn(order: any): string {
  const col = order?.queryChunks?.[0];
  return col?.name ?? "id";
}

function createFakeDb(seed: Array<{ id: number; status: string }>) {
  const state = {
    rows: seed.map((r) => ({ ...r })),
    selectCalls: 0,
    lastLimit: undefined as number | undefined,
  };
  const db: any = {
    select: vi.fn((_fields?: any) => ({
      from: vi.fn((_table: any) => ({
        where: vi.fn((cond: any) => ({
          orderBy: vi.fn((order: any) => ({
            limit: vi.fn(async (n: number) => {
              state.selectCalls += 1;
              state.lastLimit = n;
              const col = ascColumn(order);
              return state.rows
                .filter((r) => evalEq(cond, r))
                .sort((a, b) => (a as any)[col] - (b as any)[col])
                .slice(0, n)
                .map((r) => ({ id: r.id }));
            }),
          })),
        })),
      })),
    })),
  };
  return { db: db as unknown as TerminalReplayExecutor, state };
}

function pendingResult(id: number) {
  return {
    outcome: "pending",
    replayRequestId: id,
    mode: "publishing_requeue",
    reason: "publishing_in_progress",
  } as const;
}

function reconcileStub(
  handler: (id: number) => any = (id) => pendingResult(id)
) {
  return vi.fn(async ({ replayRequestId }: any) => handler(replayRequestId));
}

const enqueued = (id: number) => ({ id, status: "enqueued" });

/* ── Tests ─────────────────────────────────────────────────────────── */

describe("reconcileTerminalReplayBatch — limit validation", () => {
  it("1. default limit is 25", async () => {
    const { db, state } = createFakeDb([enqueued(1)]);
    await reconcileTerminalReplayBatch({ executor: db, reconcileRequest: reconcileStub() });
    expect(state.lastLimit).toBe(25);
    expect(TERMINAL_REPLAY_BATCH_DEFAULT_LIMIT).toBe(25);
  });

  it("2. explicit valid limit is honored", async () => {
    const { db, state } = createFakeDb(Array.from({ length: 10 }, (_, i) => enqueued(i + 1)));
    await reconcileTerminalReplayBatch({
      limit: 7,
      executor: db,
      reconcileRequest: reconcileStub(),
    });
    expect(state.lastLimit).toBe(7);
  });

  it("3/4/5/6. invalid limits reject (0, negative, non-integer, >100)", async () => {
    const { db } = createFakeDb([enqueued(1)]);
    const rec = reconcileStub();
    await expect(
      reconcileTerminalReplayBatch({ limit: 0, executor: db, reconcileRequest: rec })
    ).rejects.toThrow();
    await expect(
      reconcileTerminalReplayBatch({ limit: -3, executor: db, reconcileRequest: rec })
    ).rejects.toThrow();
    await expect(
      reconcileTerminalReplayBatch({ limit: 2.5, executor: db, reconcileRequest: rec })
    ).rejects.toThrow();
    await expect(
      reconcileTerminalReplayBatch({ limit: TERMINAL_REPLAY_BATCH_MAX_LIMIT + 1, executor: db, reconcileRequest: rec })
    ).rejects.toThrow();
    expect(rec).not.toHaveBeenCalled();
    expect(TERMINAL_REPLAY_BATCH_MAX_LIMIT).toBe(100);
  });
});

describe("reconcileTerminalReplayBatch — candidate selection", () => {
  it("7-11. selects status=enqueued only; requested/claimed/resolved/failed excluded", async () => {
    const { db } = createFakeDb([
      { id: 1, status: "requested" },
      enqueued(2),
      { id: 3, status: "claimed" },
      enqueued(4),
      { id: 5, status: "resolved" },
      { id: 6, status: "failed" },
      enqueued(7),
    ]);
    const rec = reconcileStub();

    const report = await reconcileTerminalReplayBatch({ executor: db, reconcileRequest: rec });

    expect(report.items.map((i) => i.replayRequestId)).toEqual([2, 4, 7]);
  });

  it("12. deterministic ordering by id ASC regardless of insertion order", async () => {
    const { db } = createFakeDb([enqueued(9), enqueued(3), enqueued(7), enqueued(1)]);
    const rec = reconcileStub();

    const report = await reconcileTerminalReplayBatch({ executor: db, reconcileRequest: rec });

    expect(report.items.map((i) => i.replayRequestId)).toEqual([1, 3, 7, 9]);
  });

  it("13. limit applied deterministically (lowest ids first)", async () => {
    const { db } = createFakeDb([enqueued(5), enqueued(2), enqueued(8), enqueued(1)]);
    const rec = reconcileStub();

    const report = await reconcileTerminalReplayBatch({ limit: 2, executor: db, reconcileRequest: rec });

    expect(report.items.map((i) => i.replayRequestId)).toEqual([1, 2]);
    expect(report.selectedCount).toBe(2);
  });

  it("14. empty candidate set returns a successful empty report with zero counts", async () => {
    const { db } = createFakeDb([{ id: 1, status: "resolved" }]);
    const rec = reconcileStub();

    const report = await reconcileTerminalReplayBatch({ executor: db, reconcileRequest: rec });

    expect(report).toMatchObject({
      selectedCount: 0,
      attemptedCount: 0,
      resolvedCount: 0,
      failedCount: 0,
      pendingCount: 0,
      alreadyTerminalCount: 0,
      errorCount: 0,
      items: [],
    });
    expect(rec).not.toHaveBeenCalled();
  });

  it("15/38. candidate snapshot selected exactly once; resolution does not refill", async () => {
    const { db, state } = createFakeDb([enqueued(1), enqueued(2), enqueued(3)]);
    const rec = reconcileStub((id) => ({
      outcome: "resolved",
      replayRequestId: id,
      mode: "publishing_requeue",
    }));

    const report = await reconcileTerminalReplayBatch({ executor: db, reconcileRequest: rec });

    expect(state.selectCalls).toBe(1);
    expect(report.items).toHaveLength(3);
    expect(report.resolvedCount).toBe(3);
  });
});

describe("reconcileTerminalReplayBatch — execution semantics", () => {
  it("16/18/19. invokes D3A exactly once per candidate, in deterministic order, with exact ids", async () => {
    const { db } = createFakeDb([enqueued(4), enqueued(1), enqueued(3)]);
    const rec = reconcileStub();

    await reconcileTerminalReplayBatch({ executor: db, reconcileRequest: rec });

    expect(rec).toHaveBeenCalledTimes(3);
    expect(rec.mock.calls.map((c) => c[0].replayRequestId)).toEqual([1, 3, 4]);
  });

  it("17. invokes sequentially — never concurrent fan-out", async () => {
    const { db } = createFakeDb([enqueued(1), enqueued(2), enqueued(3)]);
    let inFlight = 0;
    let maxInFlight = 0;
    const rec = vi.fn(async ({ replayRequestId }: any) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return pendingResult(replayRequestId);
    });

    await reconcileTerminalReplayBatch({ executor: db, reconcileRequest: rec });

    expect(maxInFlight).toBe(1);
  });

  it("20/21. passes the executor seam and the same clock authority to each invocation", async () => {
    const { db } = createFakeDb([enqueued(1), enqueued(2)]);
    const rec = reconcileStub();

    await reconcileTerminalReplayBatch({ clock, executor: db, reconcileRequest: rec });

    for (const call of rec.mock.calls) {
      expect(call[0].executor).toBe(db);
      expect(call[0].clock).toBe(clock);
    }
  });

  it("39. a pending candidate is attempted exactly once (no in-pass retry)", async () => {
    const { db } = createFakeDb([enqueued(1)]);
    const rec = reconcileStub(() => ({
      outcome: "pending",
      replayRequestId: 1,
      mode: "publishing_requeue",
      reason: "publishing_in_progress",
    }));

    await reconcileTerminalReplayBatch({ executor: db, reconcileRequest: rec });

    expect(rec).toHaveBeenCalledTimes(1);
  });
});

describe("reconcileTerminalReplayBatch — reporting", () => {
  it("22-29. outcome counters, item order, and internal consistency", async () => {
    const { db } = createFakeDb([enqueued(1), enqueued(2), enqueued(3), enqueued(4), enqueued(5), enqueued(6)]);
    const outcomes: Record<number, any> = {
      1: { outcome: "resolved", replayRequestId: 1, mode: "publishing_requeue" },
      2: { outcome: "failed", replayRequestId: 2, mode: "publishing_requeue" },
      3: { outcome: "pending", replayRequestId: 3, mode: "publishing_requeue", reason: "content_in_progress" },
      4: { outcome: "already_terminal", replayRequestId: 4, status: "resolved" },
      5: { outcome: "error" },
      6: { outcome: "resolved", replayRequestId: 6, mode: "content_domain_recovery" },
    };
    const rec = reconcileStub((id) => {
      if (id === 5) throw new Error("unstable domain row");
      return outcomes[id];
    });

    const report = await reconcileTerminalReplayBatch({ executor: db, reconcileRequest: rec });

    expect(report).toMatchObject({
      selectedCount: 6,
      attemptedCount: 6,
      resolvedCount: 2,
      failedCount: 1,
      pendingCount: 1,
      alreadyTerminalCount: 1,
      errorCount: 1,
      limit: 25,
    });
    expect(report.items.map((i) => i.replayRequestId)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(report.items.map((i) => i.outcome)).toEqual([
      "resolved",
      "failed",
      "pending",
      "already_terminal",
      "error",
      "resolved",
    ]);
    // Internal consistency: counters tally exactly the items.
    expect(
      report.resolvedCount +
        report.failedCount +
        report.pendingCount +
        report.alreadyTerminalCount +
        report.errorCount
    ).toBe(report.attemptedCount);
    expect(report.items).toHaveLength(report.attemptedCount);
  });
});

describe("reconcileTerminalReplayBatch — failure isolation + sanitization", () => {
  it("30/31/32. errors are isolated: first/middle/multiple throwers never abort the pass", async () => {
    const { db } = createFakeDb([enqueued(1), enqueued(2), enqueued(3), enqueued(4)]);
    const rec = reconcileStub((id) => {
      if (id === 1) throw new Error("first blew up");
      if (id === 3) throw new Error("middle blew up");
      return { outcome: "resolved", replayRequestId: id, mode: "publishing_requeue" };
    });

    const report = await reconcileTerminalReplayBatch({ executor: db, reconcileRequest: rec });

    expect(rec).toHaveBeenCalledTimes(4);
    expect(report.errorCount).toBe(2);
    expect(report.resolvedCount).toBe(2);
    expect(report.items.map((i) => i.outcome)).toEqual(["error", "resolved", "error", "resolved"]);
  });

  it("33-36. caught errors expose no stack, tokens, Bearer material, or raw provider/business text", async () => {
    const { db } = createFakeDb([enqueued(1), enqueued(2), enqueued(3)]);
    const rec = reconcileStub((id) => {
      if (id === 1) {
        throw new Error(
          "provider exploded\n    at evil (/app/node_modules/x.js:1:1) Bearer abc123 token=sk-live-zzz"
        );
      }
      if (id === 2) {
        throw new ReplayReconciliationInvariantError(
          "owner_token_fingerprint_mismatch",
          "Bounded D3A invariant"
        );
      }
      return { outcome: "resolved", replayRequestId: id, mode: "publishing_requeue" };
    });

    const report = await reconcileTerminalReplayBatch({ executor: db, reconcileRequest: rec });

    const [raw, bounded] = report.items;
    expect(raw.outcome).toBe("error");
    expect(raw.reason).toBe("reconciliation_error");
    expect(raw.errorCode).toBeUndefined();
    const rawJson = JSON.stringify(raw);
    expect(rawJson).not.toContain("at evil");
    expect(rawJson).not.toContain("Bearer");
    expect(rawJson).not.toContain("sk-live-zzz");
    expect(rawJson).not.toContain("provider exploded");
    expect(raw).not.toHaveProperty("message");
    expect(raw).not.toHaveProperty("stack");

    // Bounded D3A classifications pass through as a code only.
    expect(bounded.errorCode).toBe("owner_token_fingerprint_mismatch");
    expect(JSON.stringify(bounded)).not.toContain("Bounded D3A invariant");
  });

  it("37. D3A already_terminal is handled as a normal item outcome", async () => {
    const { db } = createFakeDb([enqueued(1)]);
    const rec = reconcileStub(() => ({ outcome: "already_terminal", replayRequestId: 1, status: "failed" }));

    const report = await reconcileTerminalReplayBatch({ executor: db, reconcileRequest: rec });

    expect(report.alreadyTerminalCount).toBe(1);
    expect(report.items[0]).toMatchObject({ outcome: "already_terminal", reason: "failed" });
  });
});

describe("reconcileTerminalReplayBatch — boundaries", () => {
  it("40-49. module source carries no outcome-classification or queue-mutation authority", () => {
    const source = readFileSync(
      new URL("./terminal-replay-reconciliation-batch.ts", import.meta.url),
      "utf8"
    );
    // D3A remains the only outcome authority:
    expect(source).not.toContain("publishingQueue");
    expect(source).not.toContain("agentRuns");
    expect(source).not.toContain("creativeGenerationClaims");
    // No direct replay-request/guard mutation:
    expect(source).not.toContain("queueReplayActiveClaims");
    expect(source).not.toContain("update(queueReplayRequests");
    expect(source).not.toContain("delete(queueReplayRequests");
    // No Redis/BullMQ/workers/schedulers:
    expect(source).not.toContain("ioredis");
    expect(source).not.toContain('from "./bullmq"');
    expect(source).not.toContain("new Queue(");
    expect(source).not.toContain("new Worker(");
    expect(source).not.toContain("setTimeout");
    expect(source).not.toContain("setInterval");
  });
});
