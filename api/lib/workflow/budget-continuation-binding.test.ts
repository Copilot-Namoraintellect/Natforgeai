import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("./triggers", () => ({
  onApprovalResolved: vi.fn(async () => undefined),
  onAgentRunComplete: vi.fn(async () => undefined),
  onStrategyApproved: vi.fn(async () => undefined),
}));

import { getDb } from "../../queries/connection";
import { onApprovalResolved } from "./triggers";
import {
  buildCostPauseProvenance,
  parseCostPauseProvenance,
  recordWorkflowCostPause,
  type CostPauseProvenance,
} from "./cost-pause";
import { resumeWorkflowAfterApprovedCostIncrease } from "./budget-resume";

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as
    | string
    | undefined;
}

const LEGACY_PAUSE: CostPauseProvenance = {
  kind: "agent_run_complete",
  continuationId: 501,
  reason: "Insufficient credits. Workflow paused.",
  recordedAt: "2026-06-10T00:00:00.000Z",
  workflowState: "strategy_pending",
};

const BOUND_PAUSE = buildCostPauseProvenance({
  kind: "agent_run_complete",
  continuationId: 501,
  reason: "Insufficient credits. Workflow paused.",
  workflowState: "strategy_pending",
  recordedAt: "2026-06-10T00:00:00.000Z",
  budgetIncreaseApprovalId: 5,
});

describe("cost-pause budget binding provenance (WBS-R4 A3-3)", () => {
  it("round-trips with and without budgetIncreaseApprovalId", () => {
    expect(parseCostPauseProvenance({ ...LEGACY_PAUSE })).toEqual(LEGACY_PAUSE);
    expect(parseCostPauseProvenance({ ...BOUND_PAUSE })).toEqual(BOUND_PAUSE);
    const built = buildCostPauseProvenance({
      kind: "strategy_approval",
      continuationId: 71,
      reason: "Insufficient credits",
      workflowState: "strategy_approved",
      budgetIncreaseApprovalId: 9,
    });
    expect(built.budgetIncreaseApprovalId).toBe(9);
    expect(parseCostPauseProvenance(built)).toEqual(built);
  });

  it("rejects wrong types for budgetIncreaseApprovalId and still rejects unknown keys", () => {
    for (const bad of ["5", 0, -1, 1.5, null]) {
      expect(
        parseCostPauseProvenance({ ...LEGACY_PAUSE, budgetIncreaseApprovalId: bad })
      ).toBeNull();
    }
    expect(parseCostPauseProvenance({ ...LEGACY_PAUSE, extra: 1 })).toBeNull();
    expect(() =>
      buildCostPauseProvenance({
        kind: "strategy_approval",
        continuationId: 71,
        reason: "r",
        workflowState: "s",
        budgetIncreaseApprovalId: 0,
      })
    ).toThrow(/budgetIncreaseApprovalId/);
  });

  it("recordWorkflowCostPause plumbs approvalId into the written provenance", async () => {
    const updateCalls: Array<{ set: unknown }> = [];
    const executor = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ id: 7, workflowContext: {} }],
          }),
        }),
      }),
      update: () => ({
        set: (setPayload: unknown) => ({
          where: async () => {
            updateCalls.push({ set: setPayload });
            return [{ affectedRows: 1 }];
          },
        }),
      }),
    } as never;

    const result = await recordWorkflowCostPause({
      userId: 22,
      campaignId: 7,
      provenance: LEGACY_PAUSE,
      approvalId: 5001,
      executor,
    });

    expect(result).toEqual({ recorded: true });
    const setPayload = updateCalls[0].set as { workflowContext: { costPause: unknown } };
    expect(setPayload.workflowContext.costPause).toEqual({
      ...LEGACY_PAUSE,
      budgetIncreaseApprovalId: 5001,
    });
  });
});

describe("resumeWorkflowAfterApprovedCostIncrease binding (WBS-R4 A3-3)", () => {
  function fakeDbForPause(costPause: unknown) {
    const updateCalls: Array<{ set: unknown }> = [];
    const executor = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                id: 7,
                userId: 22,
                status: "paused",
                workflowContext: { costPause },
              },
            ],
          }),
        }),
      }),
      update: () => ({
        set: (setPayload: unknown) => ({
          where: async () => {
            updateCalls.push({ set: setPayload });
            return [{ affectedRows: 1 }];
          },
        }),
      }),
    } as never;
    return { executor, updateCalls };
  }

  it("no-ops with not_bound when the pause is bound to a different approval", async () => {
    const { executor, updateCalls } = fakeDbForPause(BOUND_PAUSE);
    const dispatched: unknown[] = [];

    const result = await resumeWorkflowAfterApprovedCostIncrease({
      userId: 22,
      campaignId: 7,
      approvalId: 9,
      deps: {
        executor,
        canRun: async () => ({ allowed: true }),
        onAgentRunComplete: async (runId) => {
          dispatched.push(runId);
        },
      },
    });

    expect(result).toEqual({ outcome: "not_bound" });
    expect(updateCalls).toHaveLength(0);
    expect(dispatched).toHaveLength(0);
  });

  it("resumes a legacy pause under any approved decision", async () => {
    const { executor } = fakeDbForPause(LEGACY_PAUSE);
    const dispatched: unknown[] = [];

    const result = await resumeWorkflowAfterApprovedCostIncrease({
      userId: 22,
      campaignId: 7,
      approvalId: 9,
      deps: {
        executor,
        canRun: async () => ({ allowed: true }),
        onAgentRunComplete: async (runId) => {
          dispatched.push(runId);
        },
      },
    });

    expect(result).toEqual({
      outcome: "resumed",
      kind: "agent_run_complete",
      continuationId: 501,
    });
    expect(dispatched).toEqual([501]);
  });

  it("resumes when the decision is the bound approval", async () => {
    const { executor } = fakeDbForPause(BOUND_PAUSE);
    const result = await resumeWorkflowAfterApprovedCostIncrease({
      userId: 22,
      campaignId: 7,
      approvalId: 5,
      deps: {
        executor,
        canRun: async () => ({ allowed: true }),
        onAgentRunComplete: async () => undefined,
      },
    });

    expect(result).toMatchObject({ outcome: "resumed", continuationId: 501 });
  });
});

describe("executeApprovalDecision budget binding precondition (WBS-R4 A3-3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createHarness(costPause: unknown) {
    const campaign = {
      id: 42,
      userId: 18,
      workflowState: "launch_approval_required",
      status: "paused" as const,
      workflowContext: costPause === undefined ? {} : { costPause },
    };
    const approvals = [
      {
        id: 9,
        userId: 18,
        campaignId: 42,
        approvalType: "budget_increase",
        status: "pending",
      },
    ];
    const state = {
      updatedApprovals: [] as any[],
      transactions: 0,
      committed: false,
      rolledBack: false,
    };
    const executor: any = {
      select: vi.fn(() => ({
        from: vi.fn((table: unknown) => {
          const name = getTableName(table);
          const result =
            name === "approval_requests" ? approvals : name === "campaigns" ? [campaign] : [];
          return {
            where: vi.fn(() => ({
              limit: vi.fn(async () => result),
              then: (resolve: (value: unknown[]) => unknown) =>
                Promise.resolve(result).then(resolve),
            })),
          };
        }),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(async () => [{ insertId: 1 }]),
      })),
      update: vi.fn((table: unknown) => ({
        set: vi.fn((payload: any) => ({
          where: vi.fn(async () => {
            if (getTableName(table) === "approval_requests") {
              state.updatedApprovals.push(payload);
            }
            return [{ affectedRows: 1 }];
          }),
        })),
      })),
    };
    const db: any = {
      state,
      ...executor,
      transaction: async (cb: any) => {
        state.transactions += 1;
        try {
          const result = await cb(executor);
          state.committed = true;
          return result;
        } catch (err) {
          state.rolledBack = true;
          throw err;
        }
      },
    };
    return { db, state };
  }

  async function flushMicrotasks() {
    await new Promise((resolve) => setImmediate(resolve));
  }

  it("rejects an unbound budget approval while the pause is bound to another approval", async () => {
    const { approvalRouter } = await import("../../approval-router");
    const { db, state } = createHarness(BOUND_PAUSE);
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = approvalRouter.createCaller({
      resHeaders: new Headers(),
      user: { id: 18, tierSlug: "free" },
      session: { verified: true },
    } as any);

    await expect(caller.approveAction({ approvalId: 9 })).rejects.toThrow(/not bound/);
    expect(state.updatedApprovals).toHaveLength(0);
    expect(state.rolledBack).toBe(true);
    await flushMicrotasks();
    expect(onApprovalResolved).not.toHaveBeenCalled();
  });

  it("approves a legacy pause (no binding) and resumes through the trigger", async () => {
    const { approvalRouter } = await import("../../approval-router");
    const { db, state } = createHarness(LEGACY_PAUSE);
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = approvalRouter.createCaller({
      resHeaders: new Headers(),
      user: { id: 18, tierSlug: "free" },
      session: { verified: true },
    } as any);

    const result = await caller.approveAction({ approvalId: 9 });
    expect(result.success).toBe(true);
    expect(state.updatedApprovals).toHaveLength(1);
    expect(state.committed).toBe(true);
    await flushMicrotasks();
    expect(onApprovalResolved).toHaveBeenCalledTimes(1);
    expect(onApprovalResolved).toHaveBeenCalledWith(9, "approved", 18);
  });

  it("approves the bound budget approval", async () => {
    const { approvalRouter } = await import("../../approval-router");
    const boundToNine = buildCostPauseProvenance({
      kind: "agent_run_complete",
      continuationId: 501,
      reason: "Insufficient credits. Workflow paused.",
      workflowState: "strategy_pending",
      recordedAt: "2026-06-10T00:00:00.000Z",
      budgetIncreaseApprovalId: 9,
    });
    const { db, state } = createHarness(boundToNine);
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = approvalRouter.createCaller({
      resHeaders: new Headers(),
      user: { id: 18, tierSlug: "free" },
      session: { verified: true },
    } as any);

    const result = await caller.approveAction({ approvalId: 9 });
    expect(result.success).toBe(true);
    expect(state.committed).toBe(true);
    await flushMicrotasks();
    expect(onApprovalResolved).toHaveBeenCalledWith(9, "approved", 18);
  });
});
