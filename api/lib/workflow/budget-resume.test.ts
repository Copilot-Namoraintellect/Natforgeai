import { describe, it, expect } from "vitest";
import {
  buildCostPauseProvenance,
  type CostPauseProvenance,
} from "./cost-pause";
import { resumeWorkflowAfterApprovedCostIncrease } from "./budget-resume";

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as
    | string
    | undefined;
}

interface FakeRead {
  table: string;
  row: Record<string, unknown> | undefined;
}

function createFakeExecutor(reads: FakeRead[], updateAffectedRows: Partial<Record<number, number>> = {}) {
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
          const affected = updateAffectedRows[updateCalls.length] ?? 1;
          return [{ affectedRows: affected }];
        },
      }),
    }),
  } as never;

  return { executor, updateCalls };
}

const PROVENANCE: CostPauseProvenance = buildCostPauseProvenance({
  kind: "agent_run_complete",
  continuationId: 501,
  reason: "Insufficient credits. Workflow paused.",
  workflowState: "strategy_pending",
  recordedAt: "2026-06-10T00:00:00.000Z",
});

function pausedCampaign(provenance: CostPauseProvenance = PROVENANCE) {
  return {
    id: 7,
    userId: 22,
    status: "paused",
    workflowContext: { campaignLiveAt: "2026-06-01T00:00:00.000Z", costPause: provenance },
  };
}

describe("resumeWorkflowAfterApprovedCostIncrease", () => {
  it("returns null for a missing or wrong-owner campaign", async () => {
    const fake = createFakeExecutor([{ table: "campaigns", row: undefined }]);
    const result = await resumeWorkflowAfterApprovedCostIncrease({
      userId: 22,
      campaignId: 404,
      deps: { executor: fake.executor },
    });
    expect(result).toBeNull();
  });

  it("returns null when the campaign has no cost pause", async () => {
    const fake = createFakeExecutor([
      {
        table: "campaigns",
        row: { id: 7, userId: 22, status: "active", workflowContext: { campaignLiveAt: "x" } },
      },
    ]);
    const result = await resumeWorkflowAfterApprovedCostIncrease({
      userId: 22,
      campaignId: 7,
      deps: { executor: fake.executor },
    });
    expect(result).toBeNull();
    expect(fake.updateCalls).toHaveLength(0);
  });

  it("fails closed on malformed cost pause provenance", async () => {
    const fake = createFakeExecutor([
      {
        table: "campaigns",
        row: { id: 7, userId: 22, status: "paused", workflowContext: { costPause: { kind: "??" } } },
      },
    ]);
    await expect(
      resumeWorkflowAfterApprovedCostIncrease({
        userId: 22,
        campaignId: 7,
        deps: { executor: fake.executor },
      })
    ).rejects.toThrow(/malformed/);
  });

  it("stays blocked without clearing when the affordability recheck fails", async () => {
    const fake = createFakeExecutor([{ table: "campaigns", row: pausedCampaign() }]);
    const onAgentRunComplete = async (_runId: number) => {
      throw new Error("must not dispatch");
    };

    const result = await resumeWorkflowAfterApprovedCostIncrease({
      userId: 22,
      campaignId: 7,
      deps: { executor: fake.executor, canRun: async () => ({ allowed: false, reason: "still broke" }), onAgentRunComplete },
    });

    expect(result).toEqual({ outcome: "still_blocked", reason: "still broke" });
    expect(fake.updateCalls).toHaveLength(0);
  });

  it("resumes an agent_run_complete pause through the trigger pathway", async () => {
    const fake = createFakeExecutor([{ table: "campaigns", row: pausedCampaign() }]);
    const dispatched: unknown[] = [];

    const result = await resumeWorkflowAfterApprovedCostIncrease({
      userId: 22,
      campaignId: 7,
      deps: {
        executor: fake.executor,
        canRun: async () => ({ allowed: true }),
        onAgentRunComplete: async (runId) => {
          dispatched.push(["agent_run_complete", runId]);
        },
      },
    });

    expect(result).toEqual({
      outcome: "resumed",
      kind: "agent_run_complete",
      continuationId: 501,
    });
    expect(dispatched).toEqual([["agent_run_complete", 501]]);
    expect(fake.updateCalls).toHaveLength(1);
    const setPayload = fake.updateCalls[0].set as {
      status: string;
      workflowState: string;
      workflowContext: Record<string, unknown>;
    };
    expect(setPayload.status).toBe("active");
    expect(setPayload.workflowState).toBe("strategy_pending");
    expect(setPayload.workflowContext).toEqual({ campaignLiveAt: "2026-06-01T00:00:00.000Z" });
  });

  it("resumes a strategy_approval pause through onStrategyApproved", async () => {
    const provenance = buildCostPauseProvenance({
      kind: "strategy_approval",
      continuationId: 71,
      reason: "Insufficient credits",
      workflowState: "strategy_approved",
      recordedAt: "2026-06-10T00:00:00.000Z",
    });
    const fake = createFakeExecutor([{ table: "campaigns", row: pausedCampaign(provenance) }]);
    const dispatched: unknown[] = [];

    const result = await resumeWorkflowAfterApprovedCostIncrease({
      userId: 22,
      campaignId: 7,
      deps: {
        executor: fake.executor,
        canRun: async () => ({ allowed: true }),
        onStrategyApproved: async (campaignId, userId, approvalId) => {
          dispatched.push([campaignId, userId, approvalId]);
        },
      },
    });

    expect(result).toEqual({ outcome: "resumed", kind: "strategy_approval", continuationId: 71 });
    expect(dispatched).toEqual([[7, 22, 71]]);
  });

  it("resumes a launch_audience_intelligence pause through the audience-intelligence pathway", async () => {
    const provenance = buildCostPauseProvenance({
      kind: "launch_audience_intelligence",
      continuationId: 81,
      reason: "Insufficient credits",
      workflowState: "publication_pending",
      recordedAt: "2026-06-10T00:00:00.000Z",
    });
    const fake = createFakeExecutor([{ table: "campaigns", row: pausedCampaign(provenance) }]);
    const dispatched: unknown[] = [];

    const result = await resumeWorkflowAfterApprovedCostIncrease({
      userId: 22,
      campaignId: 7,
      deps: {
        executor: fake.executor,
        canRun: async () => ({ allowed: true }),
        runLaunchAudienceIntelligence: async (input) => {
          dispatched.push(input);
        },
      },
    });

    expect(result).toEqual({
      outcome: "resumed",
      kind: "launch_audience_intelligence",
      continuationId: 81,
    });
    expect(dispatched).toEqual([{ userId: 22, campaignId: 7 }]);
  });

  it("reports already_resumed when a concurrent resumer claimed the pause", async () => {
    const fake = createFakeExecutor(
      [
        { table: "campaigns", row: pausedCampaign() },
        { table: "campaigns", row: { id: 7, userId: 22, workflowContext: { campaignLiveAt: "x" } } },
      ],
      { 1: 0 }
    );
    const dispatched: unknown[] = [];

    const result = await resumeWorkflowAfterApprovedCostIncrease({
      userId: 22,
      campaignId: 7,
      deps: {
        executor: fake.executor,
        canRun: async () => ({ allowed: true }),
        onAgentRunComplete: async (runId) => {
          dispatched.push(runId);
        },
      },
    });

    expect(result).toEqual({ outcome: "already_resumed" });
    expect(dispatched).toHaveLength(0);
  });

  it("fails closed when the pause changes concurrently", async () => {
    const fake = createFakeExecutor(
      [
        { table: "campaigns", row: pausedCampaign() },
        { table: "campaigns", row: pausedCampaign() },
      ],
      { 1: 0 }
    );

    await expect(
      resumeWorkflowAfterApprovedCostIncrease({
        userId: 22,
        campaignId: 7,
        deps: { executor: fake.executor, canRun: async () => ({ allowed: true }) },
      })
    ).rejects.toThrow(/changed concurrently/);
  });
});
