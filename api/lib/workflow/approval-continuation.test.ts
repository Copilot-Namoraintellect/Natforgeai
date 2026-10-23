import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  classifyApprovalContinuation,
  reconcileApprovalContinuation,
  reconcileDanglingStrategyRunCompletions,
  runApprovalContinuationSweep,
  type ApprovalContinuationApproval,
  type ApprovalContinuationCampaign,
} from "./approval-continuation";
import { buildCostPauseProvenance } from "./cost-pause";

const LEARNING_PROMOTION_CONTEXT = { source: "learning_promotion" };

function approval(overrides: Partial<ApprovalContinuationApproval> = {}): ApprovalContinuationApproval {
  return {
    id: 11,
    userId: 22,
    campaignId: 7,
    approvalType: "strategy_review",
    status: "approved",
    ...overrides,
  };
}

function campaign(overrides: Partial<ApprovalContinuationCampaign> = {}): ApprovalContinuationCampaign {
  return {
    id: 7,
    userId: 22,
    workflowState: "strategy_generated",
    workflowContext: {},
    ...overrides,
  };
}

const BOUND_PAUSE = buildCostPauseProvenance({
  kind: "agent_run_complete",
  continuationId: 501,
  reason: "Insufficient credits",
  workflowState: "strategy_pending",
  recordedAt: "2026-06-10T00:00:00.000Z",
  budgetIncreaseApprovalId: 11,
});

describe("classifyApprovalContinuation", () => {
  it("classifies pending and edited approvals as none", () => {
    for (const status of ["pending", "edited"]) {
      expect(
        classifyApprovalContinuation(
          approval({ status }),
          campaign({ workflowState: "strategy_generated" })
        )
      ).toEqual({ kind: "none" });
    }
  });

  it("classifies a missing campaign as none", () => {
    expect(
      classifyApprovalContinuation(approval({ campaignId: null }), null)
    ).toEqual({ kind: "none" });
    expect(classifyApprovalContinuation(approval(), null)).toEqual({ kind: "none" });
  });

  it("classifies types without continuation as none", () => {
    for (const approvalType of ["sensitive_reply", "ad_spend", "shutdown", "brand_risk"]) {
      expect(
        classifyApprovalContinuation(
          approval({ approvalType, status: "approved" }),
          campaign()
        )
      ).toEqual({ kind: "none" });
    }
  });

  describe("strategy_review", () => {
    const boundLineage = {
      creativeBriefFingerprint: "fp",
      strategyRunId: 10,
      approvalRequestId: 11,
      status: "pending",
    };

    it("classifies an approved review stuck in strategy_generated with pending lineage", () => {
      expect(
        classifyApprovalContinuation(
          approval(),
          campaign({ workflowContext: { strategyApprovalLineage: boundLineage } })
        )
      ).toEqual({
        kind: "strategy_approved_continuation",
        campaignId: 7,
        userId: 22,
        approvalId: 11,
      });
    });

    it("classifies as none when the lineage is already approved for this approval", () => {
      expect(
        classifyApprovalContinuation(
          approval(),
          campaign({
            workflowContext: { strategyApprovalLineage: { ...boundLineage, status: "approved" } },
          })
        )
      ).toEqual({ kind: "none" });
    });

    it("classifies as none when the lineage is missing or bound to another approval", () => {
      expect(classifyApprovalContinuation(approval(), campaign())).toEqual({ kind: "none" });
      expect(
        classifyApprovalContinuation(
          approval(),
          campaign({
            workflowContext: {
              strategyApprovalLineage: { ...boundLineage, approvalRequestId: 99 },
            },
          })
        )
      ).toEqual({ kind: "none" });
    });

    it("classifies as none when the campaign advanced past strategy_generated", () => {
      expect(
        classifyApprovalContinuation(
          approval(),
          campaign({ workflowState: "strategy_approved" })
        )
      ).toEqual({ kind: "none" });
    });

    it("classifies a rejected review stuck in strategy_generated", () => {
      expect(
        classifyApprovalContinuation(
          approval({ status: "rejected" }),
          campaign({ workflowContext: { strategyApprovalLineage: boundLineage } })
        )
      ).toEqual({
        kind: "strategy_rejected_continuation",
        campaignId: 7,
        userId: 22,
        approvalId: 11,
      });
    });

    it("classifies a rejected review as none when the lineage moved to a newer request", () => {
      expect(
        classifyApprovalContinuation(
          approval({ status: "rejected" }),
          campaign({
            workflowContext: {
              strategyApprovalLineage: { ...boundLineage, approvalRequestId: 99 },
            },
          })
        )
      ).toEqual({ kind: "none" });
    });

    it("WBS-R4 A5-1: classifies a lost creative kickoff after an applied approval", () => {
      // approve_strategy transition + lineage.status "approved" applied, but
      // the creative kickoff that follows was lost.
      expect(
        classifyApprovalContinuation(
          approval(),
          campaign({
            workflowState: "strategy_approved",
            workflowContext: {
              strategyApprovalLineage: { ...boundLineage, status: "approved" },
            },
          })
        )
      ).toEqual({
        kind: "strategy_approved_kickoff_continuation",
        campaignId: 7,
        userId: 22,
        approvalId: 11,
      });
    });

    it("WBS-R4 A5-1: kickoff expectation stays fail-closed on superseded or unapproved lineage", () => {
      // Lineage bound to a newer request: superseded regardless of state.
      expect(
        classifyApprovalContinuation(
          approval(),
          campaign({
            workflowState: "strategy_approved",
            workflowContext: {
              strategyApprovalLineage: {
                ...boundLineage,
                approvalRequestId: 99,
                status: "approved",
              },
            },
          })
        )
      ).toEqual({ kind: "none" });
      // strategy_approved but lineage not yet approved: the callee would
      // refuse (fingerprint/lineage persistence incomplete) — do not dispatch.
      expect(
        classifyApprovalContinuation(
          approval(),
          campaign({
            workflowState: "strategy_approved",
            workflowContext: { strategyApprovalLineage: boundLineage },
          })
        )
      ).toEqual({ kind: "none" });
      // strategy_generated with an already-approved lineage: onStrategyApproved
      // already ran or is running (it persists "approved" first).
      expect(
        classifyApprovalContinuation(
          approval(),
          campaign({
            workflowContext: {
              strategyApprovalLineage: { ...boundLineage, status: "approved" },
            },
          })
        )
      ).toEqual({ kind: "none" });
    });
  });

  describe("campaign_launch", () => {
    const launchLineage = {
      creativeBriefFingerprint: "fp",
      approvalRequestId: 11,
      status: "pending",
    };

    it("classifies an approved launch stuck in launch_approval_required", () => {
      expect(
        classifyApprovalContinuation(
          approval({ approvalType: "campaign_launch" }),
          campaign({
            workflowState: "launch_approval_required",
            workflowContext: { launchApprovalLineage: launchLineage },
          })
        )
      ).toEqual({
        kind: "launch_approved_continuation",
        campaignId: 7,
        userId: 22,
        approvalId: 11,
      });
    });

    it("classifies a rejected launch stuck in launch_approval_required", () => {
      expect(
        classifyApprovalContinuation(
          approval({ approvalType: "campaign_launch", status: "rejected" }),
          campaign({
            workflowState: "launch_approval_required",
            workflowContext: { launchApprovalLineage: launchLineage },
          })
        )
      ).toEqual({
        kind: "launch_rejected_continuation",
        campaignId: 7,
        userId: 22,
        approvalId: 11,
      });
    });

    it("classifies as none when the launch already resolved (state advanced)", () => {
      expect(
        classifyApprovalContinuation(
          approval({ approvalType: "campaign_launch" }),
          campaign({
            workflowState: "publication_pending",
            workflowContext: { launchApprovalLineage: launchLineage },
          })
        )
      ).toEqual({ kind: "none" });
    });

    it("classifies as none when the launch lineage belongs to a newer request", () => {
      expect(
        classifyApprovalContinuation(
          approval({ approvalType: "campaign_launch" }),
          campaign({
            workflowState: "launch_approval_required",
            workflowContext: {
              launchApprovalLineage: { ...launchLineage, approvalRequestId: 99 },
            },
          })
        )
      ).toEqual({ kind: "none" });
    });
  });

  describe("budget_increase", () => {
    it("classifies an approved bound budget decision with a parseable pause", () => {
      expect(
        classifyApprovalContinuation(
          approval({ approvalType: "budget_increase" }),
          campaign({
            workflowState: "launch_approval_required",
            workflowContext: { costPause: BOUND_PAUSE },
          })
        )
      ).toEqual({
        kind: "budget_resume_continuation",
        campaignId: 7,
        userId: 22,
        approvalId: 11,
      });
    });

    it("classifies an approved decision over a legacy (unbound) pause", () => {
      const legacy = buildCostPauseProvenance({
        kind: "agent_run_complete",
        continuationId: 501,
        reason: "Insufficient credits",
        workflowState: "strategy_pending",
        recordedAt: "2026-06-10T00:00:00.000Z",
      });
      expect(
        classifyApprovalContinuation(
          approval({ approvalType: "budget_increase" }),
          campaign({ workflowContext: { costPause: legacy } })
        )
      ).toEqual({
        kind: "budget_resume_continuation",
        campaignId: 7,
        userId: 22,
        approvalId: 11,
      });
    });

    it("classifies as none when the pause is bound to a different approval", () => {
      expect(
        classifyApprovalContinuation(
          approval({ approvalType: "budget_increase", id: 12 }),
          campaign({ workflowContext: { costPause: BOUND_PAUSE } })
        )
      ).toEqual({ kind: "none" });
    });

    it("classifies as none without a pause, with a malformed pause, or when rejected", () => {
      expect(
        classifyApprovalContinuation(
          approval({ approvalType: "budget_increase" }),
          campaign({ workflowContext: {} })
        )
      ).toEqual({ kind: "none" });
      expect(
        classifyApprovalContinuation(
          approval({ approvalType: "budget_increase" }),
          campaign({ workflowContext: { costPause: { kind: "??" } } })
        )
      ).toEqual({ kind: "none" });
      expect(
        classifyApprovalContinuation(
          approval({ approvalType: "budget_increase", status: "rejected" }),
          campaign({ workflowContext: { costPause: BOUND_PAUSE } })
        )
      ).toEqual({ kind: "none" });
    });
  });

  describe("high_value_proposal / learning promotion", () => {
    it("classifies an approved promotion whose next-cycle trigger never ran", () => {
      expect(
        classifyApprovalContinuation(
          approval({
            approvalType: "high_value_proposal",
            context: LEARNING_PROMOTION_CONTEXT,
          }),
          campaign({ workflowContext: {} })
        )
      ).toEqual({
        kind: "next_cycle_continuation",
        campaignId: 7,
        userId: 22,
        approvalId: 11,
      });
    });

    it("classifies as none once a nextCycle envelope exists", () => {
      expect(
        classifyApprovalContinuation(
          approval({
            approvalType: "high_value_proposal",
            context: LEARNING_PROMOTION_CONTEXT,
          }),
          campaign({
            workflowContext: { nextCycle: { instructionId: "nci_1", status: "ready" } },
          })
        )
      ).toEqual({ kind: "none" });
    });

    it("classifies rejected promotions and plain carrier rows as none", () => {
      expect(
        classifyApprovalContinuation(
          approval({
            approvalType: "high_value_proposal",
            status: "rejected",
            context: LEARNING_PROMOTION_CONTEXT,
          }),
          campaign({ workflowContext: {} })
        )
      ).toEqual({ kind: "none" });
      expect(
        classifyApprovalContinuation(
          approval({ approvalType: "high_value_proposal", context: { source: "other" } }),
          campaign({ workflowContext: {} })
        )
      ).toEqual({ kind: "none" });
    });
  });
});

describe("reconcileApprovalContinuation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates an approved strategy continuation to onApprovalResolved", async () => {
    const onApprovalResolved = vi.fn(async () => undefined);
    const result = await reconcileApprovalContinuation(11, {
      loadApproval: async () => approval(),
      loadCampaign: async () =>
        campaign({
          workflowContext: {
            strategyApprovalLineage: { approvalRequestId: 11, status: "pending" },
          },
        }),
      onApprovalResolved,
    });

    expect(result).toEqual({
      reconciled: true,
      kind: "strategy_approved_continuation",
      outcome: "dispatched",
    });
    expect(onApprovalResolved).toHaveBeenCalledTimes(1);
    expect(onApprovalResolved).toHaveBeenCalledWith(11, "approved", 22);
  });

  it("WBS-R4 A5-1: re-invokes onApprovalResolved for a lost creative kickoff", async () => {
    // Mid-flight / no-evidence case: the classifier cannot see
    // credit_transactions, so it re-dispatches and onStrategyApproved's own
    // guards (creative-success charge key, in-progress claim) are the
    // authority that keeps this a no-op when the kickoff already happened.
    const onApprovalResolved = vi.fn(async () => undefined);
    const result = await reconcileApprovalContinuation(11, {
      loadApproval: async () => approval(),
      loadCampaign: async () =>
        campaign({
          workflowState: "strategy_approved",
          workflowContext: {
            strategyApprovalLineage: { approvalRequestId: 11, status: "approved" },
          },
        }),
      onApprovalResolved,
    });

    expect(result).toEqual({
      reconciled: true,
      kind: "strategy_approved_kickoff_continuation",
      outcome: "dispatched",
    });
    expect(onApprovalResolved).toHaveBeenCalledTimes(1);
    expect(onApprovalResolved).toHaveBeenCalledWith(11, "approved", 22);

    // Already-has-success-marker case: the classifier still re-dispatches
    // (purity limit, documented); the callee's dedup — modelled here by the
    // fake recording that it no-opped — prevents any double execution.
    let creativeCalls = 0;
    const calleeWithDedup = vi.fn(async () => {
      if (creativeCalls > 0) return; // hasSuccessfulCreativeGenerationForApproval
      creativeCalls += 1;
    });
    await reconcileApprovalContinuation(11, {
      loadApproval: async () => approval(),
      loadCampaign: async () =>
        campaign({
          workflowState: "strategy_approved",
          workflowContext: {
            strategyApprovalLineage: { approvalRequestId: 11, status: "approved" },
          },
        }),
      onApprovalResolved: calleeWithDedup,
    });
    expect(calleeWithDedup).toHaveBeenCalledTimes(1);
    expect(creativeCalls).toBe(1);
  });

  it("delegates a rejected launch continuation to onApprovalResolved as rejected", async () => {
    const onApprovalResolved = vi.fn(async () => undefined);
    const result = await reconcileApprovalContinuation(11, {
      loadApproval: async () =>
        approval({ approvalType: "campaign_launch", status: "rejected" }),
      loadCampaign: async () =>
        campaign({
          workflowState: "launch_approval_required",
          workflowContext: { launchApprovalLineage: { approvalRequestId: 11, status: "rejected" } },
        }),
      onApprovalResolved,
    });

    expect(result.reconciled).toBe(true);
    expect(result.kind).toBe("launch_rejected_continuation");
    expect(onApprovalResolved).toHaveBeenCalledWith(11, "rejected", 22);
  });

  it("delegates a budget continuation with the exact approval binding", async () => {
    const resumeBudgetIncrease = vi.fn(async () => ({
      outcome: "resumed" as const,
      kind: "agent_run_complete" as const,
      continuationId: 501,
    }));
    const result = await reconcileApprovalContinuation(11, {
      loadApproval: async () => approval({ approvalType: "budget_increase" }),
      loadCampaign: async () => campaign({ workflowContext: { costPause: BOUND_PAUSE } }),
      resumeBudgetIncrease,
    });

    expect(result.reconciled).toBe(true);
    expect(result.kind).toBe("budget_resume_continuation");
    expect(result.outcome).toBe("resumed");
    expect(resumeBudgetIncrease).toHaveBeenCalledTimes(1);
    expect(resumeBudgetIncrease).toHaveBeenCalledWith({ userId: 22, campaignId: 7, approvalId: 11 });
  });

  it("delegates a next-cycle continuation through trigger then dispatch once", async () => {
    const calls: string[] = [];
    const result = await reconcileApprovalContinuation(11, {
      loadApproval: async () =>
        approval({ approvalType: "high_value_proposal", context: LEARNING_PROMOTION_CONTEXT }),
      loadCampaign: async () => campaign({ workflowContext: {} }),
      nextCycle: {
        triggerNextCycle: async () => {
          calls.push("trigger");
          return { outcome: "created", instructionId: "nci_1" };
        },
        readNextCycleInstruction: async () => ({ instructionId: "nci_1", status: "ready" }),
        dispatchNextCycle: async ({ instructionId }) => {
          calls.push(`dispatch:${instructionId}`);
          return {
            outcome: "dispatched",
            instructionId,
            strategyRunId: 601,
            approvalRequestId: 9001,
          };
        },
      },
    });

    expect(result.reconciled).toBe(true);
    expect(result.kind).toBe("next_cycle_continuation");
    expect(result.outcome).toBe("dispatched");
    expect(calls).toEqual(["trigger", "dispatch:nci_1"]);
  });

  it("does not dispatch when the instruction is not ready", async () => {
    const dispatchNextCycle = vi.fn();
    const result = await reconcileApprovalContinuation(11, {
      loadApproval: async () =>
        approval({ approvalType: "high_value_proposal", context: LEARNING_PROMOTION_CONTEXT }),
      loadCampaign: async () => campaign({ workflowContext: {} }),
      nextCycle: {
        triggerNextCycle: async () => ({ outcome: "created", instructionId: "nci_1" }),
        readNextCycleInstruction: async () => ({ instructionId: "nci_1", status: "dispatched" }),
        dispatchNextCycle,
      },
    });

    expect(result.reconciled).toBe(true);
    expect(result.outcome).toBe("created");
    expect(dispatchNextCycle).not.toHaveBeenCalled();
  });

  it("never throws on a delegate failure and reports the error", async () => {
    const onApprovalResolved = vi.fn(async () => {
      throw new Error("dispatch exploded");
    });
    const result = await reconcileApprovalContinuation(11, {
      loadApproval: async () => approval(),
      loadCampaign: async () =>
        campaign({
          workflowContext: { strategyApprovalLineage: { approvalRequestId: 11, status: "pending" } },
        }),
      onApprovalResolved,
    });

    expect(result.reconciled).toBe(false);
    expect(result.kind).toBe("strategy_approved_continuation");
    expect(result.error).toBe("dispatch exploded");
  });

  it("returns none without calling any delegate when nothing is owed", async () => {
    const onApprovalResolved = vi.fn();
    const result = await reconcileApprovalContinuation(11, {
      loadApproval: async () => approval({ status: "pending" }),
      loadCampaign: async () => campaign(),
      onApprovalResolved,
    });

    expect(result).toEqual({ reconciled: false, kind: "none" });
    expect(onApprovalResolved).not.toHaveBeenCalled();
  });

  it("returns none for a missing approval", async () => {
    const result = await reconcileApprovalContinuation(404, {
      loadApproval: async () => null,
    });
    expect(result).toEqual({ reconciled: false, kind: "none" });
  });
});

describe("reconcileDanglingStrategyRunCompletions (WBS-R4 A5-2)", () => {
  const completedRun = {
    id: 600,
    userId: 22,
    campaignId: 7,
    agentType: "strategy",
    status: "completed",
    completedAt: new Date().toISOString(),
  };

  it("re-drives a completed run whose campaign never left strategy_pending", async () => {
    const onRunComplete = vi.fn(async () => undefined);
    const rollbackStrategyTransition = vi.fn(async () => undefined);
    const result = await reconcileDanglingStrategyRunCompletions({
      deps: {
        listCompletedStrategyRuns: async () => [completedRun],
        loadCampaign: async () => campaign({ workflowState: "strategy_pending" }),
        listStrategyReviews: async () => [],
        onRunComplete,
        rollbackStrategyTransition,
      },
    });

    expect(result).toEqual({ scanned: 1, reconciled: 1, failed: 0, skipped: 0 });
    expect(onRunComplete).toHaveBeenCalledTimes(1);
    expect(onRunComplete).toHaveBeenCalledWith(600);
    expect(rollbackStrategyTransition).not.toHaveBeenCalled();
  });

  it("rolls back a dangling strategy_generated transition when no review is bound, then re-drives", async () => {
    const onRunComplete = vi.fn(async () => undefined);
    const rollbackStrategyTransition = vi.fn(async () => undefined);
    const result = await reconcileDanglingStrategyRunCompletions({
      deps: {
        listCompletedStrategyRuns: async () => [completedRun],
        loadCampaign: async () =>
          campaign({
            workflowState: "strategy_generated",
            workflowContext: {},
          }),
        listStrategyReviews: async () => [],
        onRunComplete,
        rollbackStrategyTransition,
      },
    });

    expect(result).toEqual({ scanned: 1, reconciled: 1, failed: 0, skipped: 0 });
    expect(rollbackStrategyTransition).toHaveBeenCalledTimes(1);
    expect(rollbackStrategyTransition).toHaveBeenCalledWith({ campaignId: 7, userId: 22 });
    expect(onRunComplete).toHaveBeenCalledTimes(1);
    expect(onRunComplete).toHaveBeenCalledWith(600);
  });

  it("skips a strategy_generated campaign whose review is already bound to the run", async () => {
    const boundReview: ApprovalContinuationApproval = {
      id: 9001,
      userId: 22,
      campaignId: 7,
      approvalType: "strategy_review",
      status: "pending",
      context: { strategyRunId: 600 },
    };
    const onRunComplete = vi.fn();
    const rollbackStrategyTransition = vi.fn();
    const result = await reconcileDanglingStrategyRunCompletions({
      deps: {
        listCompletedStrategyRuns: async () => [completedRun],
        loadCampaign: async () =>
          campaign({
            workflowState: "strategy_generated",
            workflowContext: {},
          }),
        listStrategyReviews: async () => [boundReview],
        onRunComplete,
        rollbackStrategyTransition,
      },
    });

    expect(result).toEqual({ scanned: 1, reconciled: 0, failed: 0, skipped: 1 });
    expect(onRunComplete).not.toHaveBeenCalled();
    expect(rollbackStrategyTransition).not.toHaveBeenCalled();
  });

  it("honours the binding through the campaign lineage when the request context lacks strategyRunId", async () => {
    const boundViaLineage: ApprovalContinuationApproval = {
      id: 9001,
      userId: 22,
      campaignId: 7,
      approvalType: "strategy_review",
      status: "approved",
    };
    const onRunComplete = vi.fn();
    const result = await reconcileDanglingStrategyRunCompletions({
      deps: {
        listCompletedStrategyRuns: async () => [completedRun],
        loadCampaign: async () =>
          campaign({
            workflowState: "strategy_generated",
            workflowContext: {
              strategyApprovalLineage: {
                approvalRequestId: 9001,
                strategyRunId: 600,
                status: "approved",
              },
            },
          }),
        listStrategyReviews: async () => [boundViaLineage],
        onRunComplete,
      },
    });

    expect(result).toEqual({ scanned: 1, reconciled: 0, failed: 0, skipped: 1 });
    expect(onRunComplete).not.toHaveBeenCalled();
  });

  it("skips advanced states, foreign run kinds and missing campaigns", async () => {
    const onRunComplete = vi.fn();
    const result = await reconcileDanglingStrategyRunCompletions({
      deps: {
        listCompletedStrategyRuns: async () => [
          completedRun,
          { ...completedRun, id: 601, agentType: "creative" },
          { ...completedRun, id: 602, campaignId: null },
          { ...completedRun, id: 603 },
        ],
        loadCampaign: async ({ campaignId }) =>
          campaignId === 7
            ? campaign({ workflowState: "creatives_ready" })
            : null,
        listStrategyReviews: async () => [],
        onRunComplete,
      },
    });

    expect(result).toEqual({ scanned: 4, reconciled: 0, failed: 0, skipped: 4 });
    expect(onRunComplete).not.toHaveBeenCalled();
  });

  it("isolates per-item delegate failures without throwing", async () => {
    const onRunComplete = vi.fn(async (runId: number) => {
      if (runId === 600) throw new Error("trigger exploded");
    });
    const result = await reconcileDanglingStrategyRunCompletions({
      deps: {
        listCompletedStrategyRuns: async () => [completedRun, { ...completedRun, id: 601 }],
        loadCampaign: async () => campaign({ workflowState: "strategy_pending" }),
        listStrategyReviews: async () => [],
        onRunComplete,
      },
    });

    expect(result).toEqual({ scanned: 2, reconciled: 1, failed: 1, skipped: 0 });
    expect(onRunComplete).toHaveBeenCalledTimes(2);
  });
});

describe("runApprovalContinuationSweep", () => {
  it("scans recently-decided approvals and isolates per-item failures", async () => {
    vi.resetModules();
    const onApprovalResolvedMock = vi.fn(async () => undefined);
    vi.doMock("../../queries/connection", () => ({
      getDb: vi.fn(),
    }));
    vi.doMock("./triggers", () => ({
      onApprovalResolved: onApprovalResolvedMock,
      onAgentRunComplete: vi.fn(async () => undefined),
    }));
    const { getDb } = await import("../../queries/connection");
    const { runApprovalContinuationSweep: sweepReal } = await import("./approval-continuation");

    // Exercise the sweep loop with the real reconciler against a fake db that
    // serves one brand_risk approval (classifies to none → skipped) and fails
    // the second item's campaign load (ownership mismatch → missing → none).
    const brandRiskApproval = {
      id: 1,
      userId: 22,
      campaignId: 7,
      approvalType: "brand_risk",
      status: "approved" as const,
      createdAt: new Date(),
      approvedAt: new Date(),
    };
    const db = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            const name = (table as Record<symbol, unknown>)[
              Symbol.for("drizzle:Name") as symbol
            ] as string;
            const base = name === "approval_requests" ? [brandRiskApproval] : [];
            const chainable: Record<string, unknown> = {};
            chainable.orderBy = () => chainable;
            chainable.limit = async () => base;
            return chainable;
          },
        }),
      }),
    } as never;
    vi.mocked(getDb).mockReturnValue(db as never);

    const summary = await sweepReal({ limit: 10, decidedWithinHours: 24 });
    expect(summary.scanned).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.reconciled).toBe(0);
    expect(summary.failed).toBe(0);

    // A dangling strategy approval is reconciled by the sweep.
    const danglingApproval = {
      ...brandRiskApproval,
      id: 2,
      approvalType: "strategy_review",
      campaignId: 8,
    };
    const danglingCampaign = {
      id: 8,
      userId: 22,
      workflowState: "strategy_generated",
      workflowContext: { strategyApprovalLineage: { approvalRequestId: 2, status: "pending" } },
    };
    const db2 = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            const name = (table as Record<symbol, unknown>)[
              Symbol.for("drizzle:Name") as symbol
            ] as string;
            const base =
              name === "approval_requests"
                ? [danglingApproval]
                : name === "campaigns"
                  ? [danglingCampaign]
                  : [];
            const chainable: Record<string, unknown> = {};
            chainable.orderBy = () => chainable;
            chainable.limit = async () => base;
            return chainable;
          },
        }),
      }),
    } as never;
    vi.mocked(getDb).mockReturnValue(db2 as never);

    const summary2 = await sweepReal({ limit: 10, decidedWithinHours: 24 });
    expect(summary2.scanned).toBe(1);
    expect(summary2.reconciled).toBe(1);
    expect(onApprovalResolvedMock).toHaveBeenCalledTimes(1);
    expect(onApprovalResolvedMock).toHaveBeenCalledWith(2, "approved", 22);
  });
});


describe("reconciler identity discipline (WBS-R4 security addendum)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches with the approval ROW's userId (DB-derived), never a caller-supplied identity", async () => {
    const calls: Array<[number, string, number]> = [];
    let campaignLookupUserId: number | null = null;

    // The approval row belongs to user 77. The reconciler's only inputs are
    // (approvalId, deps) — there is no caller identity parameter, and every
    // downstream call must carry the row's userId.
    const result = await reconcileApprovalContinuation(11, {
      loadApproval: async () =>
        approval({ id: 11, userId: 77, campaignId: 7, status: "approved" }),
      loadCampaign: async (input) => {
        campaignLookupUserId = input.userId;
        return {
          id: 7,
          userId: 77,
          workflowState: "strategy_generated",
          workflowContext: {
            strategyApprovalLineage: { approvalRequestId: 11, status: "pending" },
          },
        };
      },
      onApprovalResolved: async (approvalId, decision, userId) => {
        calls.push([approvalId, decision, userId]);
      },
    });

    expect(result.reconciled).toBe(true);
    expect(campaignLookupUserId).toBe(77);
    expect(calls).toEqual([[11, "approved", 77]]);
  });

  it("performs no campaign writes outside the delegated entry points", async () => {
    const journal: string[] = [];

    await reconcileApprovalContinuation(11, {
      loadApproval: async (approvalId) => {
        journal.push(`loadApproval:${approvalId}`);
        return approval({ id: approvalId, status: "approved" });
      },
      loadCampaign: async (input) => {
        journal.push(`loadCampaign:${input.campaignId}:${input.userId}`);
        return {
          id: input.campaignId,
          userId: input.userId,
          workflowState: "strategy_generated",
          workflowContext: {
            strategyApprovalLineage: { approvalRequestId: 11, status: "pending" },
          },
        };
      },
      onApprovalResolved: async (approvalId, decision, userId) => {
        journal.push(`onApprovalResolved:${approvalId}:${decision}:${userId}`);
      },
    });

    // Exactly: load the approval, load its owner-scoped campaign, delegate.
    // No update/mutation seam exists or was invoked.
    expect(journal).toEqual([
      "loadApproval:11",
      "loadCampaign:7:22",
      "onApprovalResolved:11:approved:22",
    ]);
  });
});
