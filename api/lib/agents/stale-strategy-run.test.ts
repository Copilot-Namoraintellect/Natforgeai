import { describe, it, expect } from "vitest";
import {
  isStaleStrategyRun,
  STALE_STRATEGY_RUN_TTL_MS,
  terminaliseStaleStrategyRuns,
} from "./stale-strategy-run";

const NOW = new Date("2026-06-12T12:00:00.000Z");
const OLD_STARTED = "2026-06-12T11:00:00.000Z"; // 1h ago > 30min TTL
const RECENT_STARTED = "2026-06-12T11:50:00.000Z"; // 10min ago

describe("isStaleStrategyRun", () => {
  it("classifies only old running strategy runs as stale", () => {
    expect(
      isStaleStrategyRun({ agentType: "strategy", status: "running", startedAt: OLD_STARTED, now: NOW })
    ).toBe(true);
    expect(
      isStaleStrategyRun({ agentType: "strategy", status: "running", startedAt: RECENT_STARTED, now: NOW })
    ).toBe(false);
  });

  it("never classifies completed, failed or non-strategy runs", () => {
    for (const status of ["completed", "failed", "pending"]) {
      expect(
        isStaleStrategyRun({ agentType: "strategy", status, startedAt: OLD_STARTED, now: NOW })
      ).toBe(false);
    }
    expect(
      isStaleStrategyRun({ agentType: "creative", status: "running", startedAt: OLD_STARTED, now: NOW })
    ).toBe(false);
  });

  it("honours a custom ttl and unparseable timestamps", () => {
    expect(
      isStaleStrategyRun({
        agentType: "strategy",
        status: "running",
        startedAt: RECENT_STARTED,
        now: NOW,
        ttlMs: 5 * 60 * 1000,
      })
    ).toBe(true);
    expect(
      isStaleStrategyRun({ agentType: "strategy", status: "running", startedAt: "garbage", now: NOW })
    ).toBe(false);
  });
});

function createFakeExecutor(rows: Array<Record<string, unknown>>, zeroRowIds: Set<number> = new Set()) {
  const updateCalls: Array<{ id: number; set: Record<string, unknown> }> = [];

  const executor = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => rows.map(r => ({ ...r })),
          then: (resolve: (value: unknown[]) => unknown) =>
            Promise.resolve(rows.map(r => ({ ...r }))).then(resolve),
        }),
      }),
    }),
    update: () => ({
      set: (setPayload: Record<string, unknown>) => ({
        where: async (conds: unknown) => {
          const id = extractId(conds);
          updateCalls.push({ id, set: setPayload });
          const row = rows.find(r => r.id === id);
          const stillRunning = row?.status === "running";
          const affected = stillRunning && !zeroRowIds.has(id) ? 1 : 0;
          if (affected > 0 && row) {
            Object.assign(row, setPayload);
          }
          return [{ affectedRows: affected }];
        },
      }),
    }),
  } as never;

  return { executor, updateCalls, rows };
}

function extractId(conds: unknown): number {
  const walk = (value: unknown, depth: number): number | null => {
    if (depth > 10 || value === null || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if ("value" in record && typeof record.value === "number" && record.value > 100) {
      return record.value;
    }
    for (const v of Object.values(record)) {
      const found = walk(v, depth + 1);
      if (found !== null) return found;
    }
    return null;
  };
  return walk(conds, 0) ?? -1;
}

describe("terminaliseStaleStrategyRuns", () => {
  it("terminalises only stale running strategy runs, preserving other rows", async () => {
    const rows = [
      { id: 501, agentType: "strategy", status: "running", startedAt: OLD_STARTED },
      { id: 502, agentType: "strategy", status: "running", startedAt: OLD_STARTED },
      { id: 503, agentType: "strategy", status: "running", startedAt: RECENT_STARTED },
      { id: 504, agentType: "strategy", status: "completed", startedAt: OLD_STARTED },
      { id: 505, agentType: "creative", status: "running", startedAt: OLD_STARTED },
    ];
    const fake = createFakeExecutor(rows);

    const summary = await terminaliseStaleStrategyRuns({
      userId: 42,
      campaignId: 29,
      now: NOW,
      executor: fake.executor,
    });

    expect(summary).toEqual({ examined: 2, terminalised: 2 });
    expect(fake.updateCalls).toHaveLength(2);
    expect(fake.updateCalls.map(c => c.id).sort()).toEqual([501, 502]);
    const first = fake.updateCalls.find(c => c.id === 501)!;
    expect(first.set.status).toBe("failed");
    expect(String(first.set.error)).toMatch(/Stale strategy run terminalised/);
    expect(fake.rows.find(r => r.id === 503)?.status).toBe("running");
    expect(fake.rows.find(r => r.id === 504)?.status).toBe("completed");
  });

  it("does not double-terminalise a run already terminalised concurrently", async () => {
    const rows = [{ id: 501, agentType: "strategy", status: "running", startedAt: OLD_STARTED }];
    const fake = createFakeExecutor(rows, new Set([501]));

    const summary = await terminaliseStaleStrategyRuns({
      userId: 42,
      campaignId: 29,
      now: NOW,
      executor: fake.executor,
    });

    expect(summary).toEqual({ examined: 1, terminalised: 0 });
  });

  it("exposes a 30 minute default TTL", () => {
    expect(STALE_STRATEGY_RUN_TTL_MS).toBe(1_800_000);
  });
});
