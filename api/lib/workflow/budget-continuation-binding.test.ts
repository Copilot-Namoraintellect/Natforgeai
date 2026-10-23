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


describe("budget binding security boundaries (WBS-R4 security addendum)", () => {
  // Local harness copies (module-scoped so the security describe is
  // self-contained; the originals live inside their own describes).
  function createSecurityHarness(costPause: unknown) {
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

    const flatten = (sql: any): any[] => {
      if (!sql || typeof sql !== "object" || !Array.isArray(sql.queryChunks)) return [];
      const out: any[] = [];
      for (const chunk of sql.queryChunks) {
        if (chunk && typeof chunk === "object" && Array.isArray(chunk.queryChunks)) {
          out.push(...flatten(chunk));
        } else {
          out.push(chunk);
        }
      }
      return out;
    };
    const columnFilters = (condition: unknown): Array<{ name: string; value: unknown }> => {
      const chunks = flatten(condition);
      const filters: Array<{ name: string; value: unknown }> = [];
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (chunk && typeof chunk === "object" && "name" in chunk && typeof chunk.name === "string") {
          for (let j = i + 1; j < chunks.length; j++) {
            const candidate = chunks[j];
            if (
              candidate &&
              typeof candidate === "object" &&
              !("name" in candidate) &&
              "value" in candidate &&
              !Array.isArray(candidate.value)
            ) {
              filters.push({ name: chunk.name, value: candidate.value });
              break;
            }
          }
        }
      }
      return filters;
    };
    const matches = (row: any, condition: unknown) =>
      columnFilters(condition).every((f) => row[f.name] === f.value);

    const executor: any = {
      select: vi.fn(() => ({
        from: vi.fn((table: unknown) => ({
          where: vi.fn((condition: unknown) => {
            const name = getTableName(table);
            const result =
              name === "approval_requests"
                ? approvals.filter((r) => matches(r, condition))
                : name === "campaigns"
                  ? [campaign]
                  : [];
            return {
              limit: vi.fn(async () => result),
              then: (resolve: (value: unknown[]) => unknown) =>
                Promise.resolve(result).then(resolve),
            };
          }),
        })),
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

  function fakeSecurityDbForPause(costPause: unknown) {
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

  async function flushSecurityMicrotasks() {
    await new Promise((resolve) => setImmediate(resolve));
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function buildCaller(userId: number) {
    return {
      resHeaders: new Headers(),
      user: { id: userId, tierSlug: "free" },
      session: { verified: true },
    } as any;
  }

  it("stale authority: unbound decision rejected with campaign state + pause untouched and no dispatch", async () => {
    const { approvalRouter } = await import("../../approval-router");
    const { db, state } = createSecurityHarness(BOUND_PAUSE);
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = approvalRouter.createCaller(buildCaller(18));
    await expect(caller.approveAction({ approvalId: 9 })).rejects.toThrow(/not bound/);

    expect(state.updatedApprovals).toHaveLength(0);
    expect(state.committed).toBe(false);
    expect(state.rolledBack).toBe(true);
    await flushSecurityMicrotasks();
    expect(onApprovalResolved).not.toHaveBeenCalled();
  });

  it("cross-user decision fails with the existing ownership NOT_FOUND", async () => {
    const { approvalRouter } = await import("../../approval-router");
    const { db, state } = createSecurityHarness(BOUND_PAUSE);
    vi.mocked(getDb).mockReturnValue(db as any);

    // User 999 attempts user 18's budget approval.
    const caller = approvalRouter.createCaller(buildCaller(999));
    await expect(caller.approveAction({ approvalId: 9 })).rejects.toThrow(
      /Approval request not found/
    );
    expect(state.updatedApprovals).toHaveLength(0);
    expect(state.rolledBack).toBe(true);
    await flushSecurityMicrotasks();
    expect(onApprovalResolved).not.toHaveBeenCalled();
  });

  it("malformed binding material fails closed: strict parser rejects wrong types and unknown keys", async () => {
    // Wrong types for budgetIncreaseApprovalId never parse.
    expect(
      parseCostPauseProvenance({ ...BOUND_PAUSE, budgetIncreaseApprovalId: "9" })
    ).toBeNull();
    expect(
      parseCostPauseProvenance({ ...BOUND_PAUSE, budgetIncreaseApprovalId: -4 })
    ).toBeNull();
    // Unknown extra keys remain fail-closed even alongside a valid binding.
    expect(
      parseCostPauseProvenance({ ...BOUND_PAUSE, injectedAuthority: true })
    ).toBeNull();

    // The resume pathway refuses a malformed pause with a safe error (no raw
    // stack disclosure, no state change, no dispatch).
    const { executor, updateCalls } = fakeSecurityDbForPause({
      ...BOUND_PAUSE,
      budgetIncreaseApprovalId: "9",
    });
    await expect(
      resumeWorkflowAfterApprovedCostIncrease({
        userId: 22,
        campaignId: 7,
        approvalId: 5,
        deps: { executor },
      })
    ).rejects.toThrow(/malformed cost pause provenance/);
    expect(updateCalls).toHaveLength(0);
  });

  it("decision precondition treats an unparseable pause as unbound authority and does not crash", async () => {
    const { approvalRouter } = await import("../../approval-router");
    // The campaign records a malformed pause: the binding precondition skips
    // it (parse null), the human decision is still recorded, and the async
    // resume refuses closed — no crash, no stack disclosure to the caller.
    const { db, state } = createSecurityHarness({
      ...BOUND_PAUSE,
      budgetIncreaseApprovalId: "9",
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = approvalRouter.createCaller(buildCaller(18));
    const result = await caller.approveAction({ approvalId: 9 });
    expect(result.success).toBe(true);
    expect(state.committed).toBe(true);
    await flushSecurityMicrotasks();
    expect(onApprovalResolved).toHaveBeenCalledTimes(1);
  });
});
