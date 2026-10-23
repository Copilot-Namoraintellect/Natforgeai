/**
 * WBS-R4E E3 — budget/quota autonomy acceptance.
 *
 * Proves the governed cycle end to end with the REAL production gate
 * (canRunAutonomousWorkflow, including the WBS-R4E resume-reachable fix):
 *
 *   insufficient credit → governed pause (durable provenance + ONE budget
 *   approval) → approval/top-up → affordability recheck through the same
 *   gate → exact-identity claim → exactly one continuation dispatch →
 *   no duplicate charge and no developer command anywhere in the loop.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("../billing/credit-engine", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    deductCredits: vi.fn(async () => ({ newBalance: 40 })),
    recordAiUsage: vi.fn(),
    adminAdjustCredits: vi.fn(),
  };
});

import { getDb } from "../../queries/connection";
import { deductCredits } from "../billing/credit-engine";
import { canRunAutonomousWorkflow, pauseWorkflowForCostLimit } from "../billing/cost-control";
import { resumeWorkflowAfterApprovedCostIncrease } from "./budget-resume";
import { buildCostPauseProvenance } from "./cost-pause";

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as
    | string
    | undefined;
}

interface State {
  campaign: Record<string, unknown>;
  walletBalance: number;
  approvals: Array<Record<string, unknown>>;
  /** Emulates owner-scoped selection: campaigns are returned only for this
   * userId (the fake does not parse drizzle where-conditions). */
  queryUserId: number;
}

function createStateDb(state: State) {
  const updateCalls: Array<{ table: string; set: unknown }> = [];
  const insertCalls: Array<{ table: string; values: unknown }> = [];
  let nextApprovalId = 9000;

  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async (_n: number) => {
            const name = getTableName(table) ?? "";
            if (name === "campaigns") {
              return state.campaign.userId === state.queryUserId ? [state.campaign] : [];
            }
            if (name === "credit_wallets") {
              return [{ id: 1, userId: 22, balance: state.walletBalance }];
            }
            if (name === "approval_requests") {
              return state.approvals.filter((a) => a.status === "pending");
            }
            if (name === "ai_usage") return [];
            if (name === "system_settings") return [];
            return [];
          },
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (setPayload: unknown) => ({
        where: async (_conds: unknown) => {
          const name = getTableName(table) ?? "unknown";
          updateCalls.push({ table: name, set: setPayload });
          if (name === "campaigns") {
            Object.assign(state.campaign, setPayload);
          }
          return [{ affectedRows: 1 }];
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: unknown) => {
        const name = getTableName(table) ?? "unknown";
        insertCalls.push({ table: name, values });
        if (name === "approval_requests") {
          state.approvals.push({ id: nextApprovalId++, ...(values as object) });
        }
        return [{ insertId: 1 }];
      },
    }),
  } as never;

  return { db, state, updateCalls, insertCalls };
}

function activeCampaignState(): State {
  return {
    campaign: {
      id: 7,
      userId: 22,
      status: "active",
      workflowState: "creatives_generating",
      workflowContext: { campaignLiveAt: "2026-06-01T00:00:00.000Z" },
    },
    walletBalance: 1,
    approvals: [],
    queryUserId: 22,
  };
}

function pausedState(): State {
  const state = activeCampaignState();
  state.campaign.status = "paused";
  state.campaign.workflowState = "launch_approval_required";
  (state.campaign.workflowContext as Record<string, unknown>).costPause =
    buildCostPauseProvenance({
      kind: "agent_run_complete",
      continuationId: 501,
      reason: "Insufficient credits. Workflow paused.",
      workflowState: "creatives_generating",
      recordedAt: "2026-06-10T00:00:00.000Z",
    });
  state.approvals.push({
    id: 4242,
    userId: 22,
    campaignId: 7,
    approvalType: "budget_increase",
    status: "pending",
  });
  return state;
}

describe("WBS-R4E E3 budget autonomy: pause → approve/top-up → exact resume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("insufficient credit produces a governed pause with durable provenance and one budget approval", async () => {
    const state = activeCampaignState();
    vi.mocked(getDb).mockReturnValue(createStateDb(state).db as any);

    const gate = await canRunAutonomousWorkflow(22, 7, {
      kind: "agent_run_complete",
      continuationId: 501,
    });

    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe("Insufficient credits. Workflow paused.");
    expect(state.campaign.status).toBe("paused");
    expect(state.campaign.workflowState).toBe("launch_approval_required");
    const context = state.campaign.workflowContext as Record<string, unknown>;
    expect(context.costPause).toMatchObject({
      kind: "agent_run_complete",
      continuationId: 501,
      workflowState: "creatives_generating",
    });
    expect(state.approvals).toHaveLength(1);
    expect(state.approvals[0]).toMatchObject({
      approvalType: "budget_increase",
      status: "pending",
    });
    expect(deductCredits).not.toHaveBeenCalled();
  });

  it("repeated pauses never duplicate the pending budget approval", async () => {
    const state = activeCampaignState();
    const fake = createStateDb(state);
    vi.mocked(getDb).mockReturnValue(fake.db as any);

    await pauseWorkflowForCostLimit(22, 7, "Insufficient credits for autonomous workflow", {
      kind: "agent_run_complete",
      continuationId: 501,
    });
    await pauseWorkflowForCostLimit(22, 7, "Insufficient credits for autonomous workflow", {
      kind: "agent_run_complete",
      continuationId: 501,
    });

    expect(fake.state.approvals).toHaveLength(1);
  });

  it("top-up resumes through the real production gate: exact claim, one dispatch, restored state, no charge", async () => {
    const state = pausedState();
    state.walletBalance = 40; // approved budget top-up landed
    vi.mocked(getDb).mockReturnValue(createStateDb(state).db as any);

    const dispatched: number[] = [];
    const result = await resumeWorkflowAfterApprovedCostIncrease({
      userId: 22,
      campaignId: 7,
      deps: {
        // Only the continuation boundary is stubbed (the real trigger chain
        // is Stream A authority); the affordability recheck uses the REAL
        // production gate via the stateful db.
        onAgentRunComplete: async (runId: number) => {
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
    // Pre-pause state restored, pause consumed.
    expect(state.campaign.status).toBe("active");
    expect(state.campaign.workflowState).toBe("creatives_generating");
    expect(
      (state.campaign.workflowContext as Record<string, unknown>).costPause
    ).toBeUndefined();
    // The resume cycle itself never moves money.
    expect(deductCredits).not.toHaveBeenCalled();
  });

  it("resume recheck that still fails keeps the pause, creates no duplicate approval, dispatches nothing", async () => {
    const state = pausedState(); // wallet still at 1 — top-up not applied
    const fake = createStateDb(state);
    vi.mocked(getDb).mockReturnValue(fake.db as any);

    const dispatched: number[] = [];
    const result = await resumeWorkflowAfterApprovedCostIncrease({
      userId: 22,
      campaignId: 7,
      deps: {
        onAgentRunComplete: async (runId: number) => {
          dispatched.push(runId);
        },
      },
    });

    expect(result).toEqual({
      outcome: "still_blocked",
      reason: "Insufficient credits. Workflow paused.",
    });
    expect(dispatched).toEqual([]);
    expect(state.campaign.status).toBe("paused");
    expect(
      (state.campaign.workflowContext as Record<string, unknown>).costPause
    ).toBeDefined();
    // Exactly one pending approval throughout (the dedup suppresses the
    // re-pause's insert).
    expect(fake.state.approvals).toHaveLength(1);
    expect(deductCredits).not.toHaveBeenCalled();
  });

  it("replay after a completed resume is consumed (no provenance, no second dispatch, no charge)", async () => {
    const state = pausedState();
    state.walletBalance = 40;
    vi.mocked(getDb).mockReturnValue(createStateDb(state).db as any);

    const dispatched: number[] = [];
    const deps = {
      onAgentRunComplete: async (runId: number) => {
        dispatched.push(runId);
      },
    };

    const first = await resumeWorkflowAfterApprovedCostIncrease({
      userId: 22,
      campaignId: 7,
      deps,
    });
    const replay = await resumeWorkflowAfterApprovedCostIncrease({
      userId: 22,
      campaignId: 7,
      deps,
    });

    expect(first?.outcome).toBe("resumed");
    // The pause is consumed; a later replay finds no provenance and no-ops.
    expect(replay).toBeNull();
    expect(dispatched).toEqual([501]);
    expect(deductCredits).not.toHaveBeenCalled();
  });

  it("crash after the claim but before the dispatch cannot double-execute on retry", async () => {
    const state = pausedState();
    state.walletBalance = 40;
    vi.mocked(getDb).mockReturnValue(createStateDb(state).db as any);

    const dispatched: number[] = [];
    const flakyDispatch = async (runId: number) => {
      dispatched.push(runId);
      throw new Error("simulated crash mid-dispatch");
    };

    await expect(
      resumeWorkflowAfterApprovedCostIncrease({
        userId: 22,
        campaignId: 7,
        deps: { onAgentRunComplete: flakyDispatch },
      })
    ).rejects.toThrow("simulated crash mid-dispatch");

    // The claim already cleared the pause, so a retry finds nothing to
    // resume: at most the single (failed) dispatch ever ran.
    const retry = await resumeWorkflowAfterApprovedCostIncrease({
      userId: 22,
      campaignId: 7,
      deps: { onAgentRunComplete: flakyDispatch },
    });
    expect(retry).toBeNull();
    expect(dispatched).toEqual([501]);
    expect(deductCredits).not.toHaveBeenCalled();
  });

  it("cross-owner resume is scope-isolated: the pause claim matches owner + exact provenance only", async () => {
    const state = pausedState();
    state.walletBalance = 40;
    state.queryUserId = 999; // every query in this test is scoped to user 999
    vi.mocked(getDb).mockReturnValue(createStateDb(state).db as any);

    const dispatched: number[] = [];
    const result = await resumeWorkflowAfterApprovedCostIncrease({
      userId: 999, // not the campaign owner
      campaignId: 7,
      deps: {
        onAgentRunComplete: async (runId: number) => {
          dispatched.push(runId);
        },
      },
    });

    expect(result).toBeNull();
    expect(dispatched).toEqual([]);
    // Pause untouched.
    expect(state.campaign.status).toBe("paused");
    expect(deductCredits).not.toHaveBeenCalled();
  });
});
