import { describe, it, expect } from "vitest";
import {
  buildCostPauseProvenance,
  parseCostPauseProvenance,
  recordWorkflowCostPause,
  type CostPauseProvenance,
} from "./cost-pause";

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as
    | string
    | undefined;
}

interface FakeRead {
  table: string;
  row: Record<string, unknown> | undefined;
}

function createFakeExecutor(reads: FakeRead[]) {
  const updateCalls: Array<{ set: unknown }> = [];
  let pendingReads = [...reads];

  const executor = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async (_n: number) => {
            const name = getTableName(table) ?? "";
            const index = pendingReads.findIndex(r => r.table === name);
            if (index < 0) return [];
            const [entry] = pendingReads.splice(index, 1);
            return entry.row ? [entry.row] : [];
          },
        }),
      }),
    }),
    update: () => ({
      set: (setPayload: unknown) => ({
        where: async (_conds: unknown) => {
          updateCalls.push({ set: setPayload });
          return [{ affectedRows: 1 }];
        },
      }),
    }),
  } as never;

  return { executor, updateCalls };
}

const PROVENANCE: CostPauseProvenance = {
  kind: "agent_run_complete",
  continuationId: 501,
  reason: "Insufficient credits. Workflow paused.",
  recordedAt: "2026-06-10T00:00:00.000Z",
  workflowState: "strategy_pending",
};

describe("buildCostPauseProvenance", () => {
  it("builds a provenance record and defaults recordedAt", () => {
    const built = buildCostPauseProvenance({
      kind: "strategy_approval",
      continuationId: 71,
      reason: "Insufficient credits",
      workflowState: "strategy_approved",
    });
    expect(built.kind).toBe("strategy_approval");
    expect(built.continuationId).toBe(71);
    expect(built.workflowState).toBe("strategy_approved");
    expect(Number.isNaN(new Date(built.recordedAt).getTime())).toBe(false);
  });

  it("rejects invalid material", () => {
    expect(() =>
      buildCostPauseProvenance({
        kind: "bogus" as never,
        continuationId: 71,
        reason: "r",
        workflowState: "s",
      })
    ).toThrow(/kind/);
    expect(() =>
      buildCostPauseProvenance({
        kind: "strategy_approval",
        continuationId: 0,
        reason: "r",
        workflowState: "s",
      })
    ).toThrow(/continuationId/);
    expect(() =>
      buildCostPauseProvenance({
        kind: "strategy_approval",
        continuationId: 71,
        reason: "  ",
        workflowState: "s",
      })
    ).toThrow(/reason/);
  });
});

describe("parseCostPauseProvenance", () => {
  it("round-trips a valid provenance record", () => {
    expect(parseCostPauseProvenance({ ...PROVENANCE })).toEqual(PROVENANCE);
  });

  it("rejects malformed payloads", () => {
    for (const value of [
      null,
      "pause",
      42,
      { ...PROVENANCE, extra: 1 },
      { ...PROVENANCE, kind: "bogus" },
      { ...PROVENANCE, continuationId: -1 },
      { ...PROVENANCE, reason: "" },
      { ...PROVENANCE, recordedAt: " " },
      { ...PROVENANCE, workflowState: "" },
      { kind: "agent_run_complete", continuationId: 501 },
    ]) {
      expect(parseCostPauseProvenance(value)).toBeNull();
    }
  });
});

describe("recordWorkflowCostPause", () => {
  it("records provenance while preserving every other workflowContext field", async () => {
    const fake = createFakeExecutor([
      { table: "campaigns", row: { id: 7, userId: 22, workflowContext: { campaignLiveAt: "2026-06-01T00:00:00.000Z" } } },
    ]);

    const result = await recordWorkflowCostPause({
      userId: 22,
      campaignId: 7,
      provenance: PROVENANCE,
      executor: fake.executor,
    });

    expect(result).toEqual({ recorded: true });
    expect(fake.updateCalls).toHaveLength(1);
    const setPayload = fake.updateCalls[0].set as { workflowContext: Record<string, unknown> };
    expect(setPayload.workflowContext).toEqual({
      campaignLiveAt: "2026-06-01T00:00:00.000Z",
      costPause: PROVENANCE,
    });
  });

  it("replays idempotently for an identical pending pause", async () => {
    const fake = createFakeExecutor([
      { table: "campaigns", row: { id: 7, userId: 22, workflowContext: { costPause: PROVENANCE } } },
    ]);

    const result = await recordWorkflowCostPause({
      userId: 22,
      campaignId: 7,
      provenance: PROVENANCE,
      executor: fake.executor,
    });

    expect(result).toEqual({ recorded: false });
    expect(fake.updateCalls).toHaveLength(0);
  });

  it("fails closed when a different pause is already pending", async () => {
    const fake = createFakeExecutor([
      { table: "campaigns", row: { id: 7, userId: 22, workflowContext: { costPause: PROVENANCE } } },
    ]);

    await expect(
      recordWorkflowCostPause({
        userId: 22,
        campaignId: 7,
        provenance: { ...PROVENANCE, continuationId: 999 },
        executor: fake.executor,
      })
    ).rejects.toThrow(/different pending cost pause/);
    expect(fake.updateCalls).toHaveLength(0);
  });

  it("returns null for a missing or wrong-owner campaign", async () => {
    const fake = createFakeExecutor([{ table: "campaigns", row: undefined }]);

    const result = await recordWorkflowCostPause({
      userId: 22,
      campaignId: 404,
      provenance: PROVENANCE,
      executor: fake.executor,
    });

    expect(result).toBeNull();
    expect(fake.updateCalls).toHaveLength(0);
  });
});
