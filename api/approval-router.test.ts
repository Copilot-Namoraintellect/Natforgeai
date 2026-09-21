import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("./lib/workflow/triggers", () => ({
  onApprovalResolved: vi.fn(async () => undefined),
}));

vi.mock("./lib/agents/strategy-agent", () => ({
  validateStrategyOutputAgainstCampaign: vi.fn(() => ({ valid: true })),
}));

vi.mock("./lib/creative/brief-grounding", () => ({
  buildGroundedCreativeBrief: vi.fn(() => ({
    fingerprint: "fp-current",
    productOrService: "service",
    targetBuyer: "buyer",
    mainPainPoint: "pain",
    preferredCta: "cta",
    primaryOutcome: "outcome",
    targetAudience: "audience",
    coreMessage: "message",
    offerDetails: "",
    excludedOffers: "",
    referenceStyle: "",
    contentStyle: "",
    businessType: "B2B",
  })),
}));

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as string | undefined;
}

function createMockDb({
  campaign = {
    id: 42,
    userId: 18,
    workflowState: "strategy_generated",
    workflowContext: { strategyFingerprint: "fp-current" },
  } as any,
  approvals = [] as any[],
  agentRuns = [] as any[],
  insertId = 555,
} = {}) {
  const state = {
    updatedApprovals: [] as any[],
    updatedCampaigns: [] as any[],
    insertedApprovals: [] as any[],
    transactions: 0,
    committed: false,
    rolledBack: false,
  };

  const executor: any = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        const name = getTableName(table);
        const result =
          name === "approval_requests" ? approvals : name === "campaigns" ? [campaign] : name === "agent_runs" ? agentRuns : [];
        return {
          where: vi.fn(() => {
            const chainable = {
              orderBy: vi.fn(() => chainable),
              limit: vi.fn(async () => result),
              then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(result).then(resolve),
            };
            return chainable;
          }),
        };
      }),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (vals: any) => {
        if (getTableName(table) === "approval_requests") {
          state.insertedApprovals.push(vals);
        }
        return [{ insertId }];
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((payload: any) => ({
        where: vi.fn(async () => {
          if (getTableName(table) === "approval_requests") {
            state.updatedApprovals.push(payload);
          } else if (getTableName(table) === "campaigns") {
            state.updatedCampaigns.push(payload);
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

  return db;
}

function buildCtx() {
  return {
    resHeaders: new Headers(),
    user: { id: 18, tierSlug: "free" },
    session: { verified: true },
  } as any;
}

describe("approvalRouter.strategy_review lineage validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("approves strategy_review when the durable lineage matches the current brief, run and request", async () => {
    const { getDb } = await import("./queries/connection");
    const { approvalRouter } = await import("./approval-router");

    const db = createMockDb({
      campaign: {
        id: 42,
        userId: 18,
        workflowState: "strategy_generated",
        workflowContext: {
          strategyFingerprint: "fp-current",
          strategyApprovalLineage: {
            creativeBriefFingerprint: "fp-current",
            strategyRunId: 10,
            approvalRequestId: 1,
            status: "pending",
          },
        },
      },
      approvals: [
        {
          id: 1,
          userId: 18,
          campaignId: 42,
          approvalType: "strategy_review",
          status: "pending",
        },
      ],
      agentRuns: [
        {
          id: 10,
          userId: 18,
          campaignId: 42,
          agentType: "strategy",
          status: "completed",
          output: { creativeBriefFingerprint: "fp-current" },
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = approvalRouter.createCaller(buildCtx());
    const result = await caller.approveAction({ approvalId: 1 });

    expect(result.success).toBe(true);
    expect(db.state.updatedApprovals).toHaveLength(1);
    expect(db.state.updatedApprovals[0].status).toBe("approved");
  });

  it("rejects strategy_review when the brief changed after generation", async () => {
    const { getDb } = await import("./queries/connection");
    const { approvalRouter } = await import("./approval-router");

    const db = createMockDb({
      campaign: {
        id: 42,
        userId: 18,
        workflowState: "strategy_generated",
        workflowContext: {
          strategyFingerprint: "fp-old",
          strategyApprovalLineage: {
            creativeBriefFingerprint: "fp-old",
            strategyRunId: 10,
            approvalRequestId: 1,
            status: "pending",
          },
        },
      },
      approvals: [
        {
          id: 1,
          userId: 18,
          campaignId: 42,
          approvalType: "strategy_review",
          status: "pending",
        },
      ],
      agentRuns: [
        {
          id: 10,
          userId: 18,
          campaignId: 42,
          agentType: "strategy",
          status: "completed",
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = approvalRouter.createCaller(buildCtx());
    await expect(caller.approveAction({ approvalId: 1 })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });

    expect(db.state.updatedApprovals).toHaveLength(0);
  });

  it("rejects approval of an older pending request when the current lineage points to a different request", async () => {
    const { getDb } = await import("./queries/connection");
    const { approvalRouter } = await import("./approval-router");

    const db = createMockDb({
      campaign: {
        id: 42,
        userId: 18,
        workflowState: "strategy_generated",
        workflowContext: {
          strategyFingerprint: "fp-current",
          strategyApprovalLineage: {
            creativeBriefFingerprint: "fp-current",
            strategyRunId: 10,
            approvalRequestId: 1,
            status: "pending",
          },
        },
      },
      approvals: [
        {
          id: 33,
          userId: 18,
          campaignId: 42,
          approvalType: "strategy_review",
          status: "pending",
        },
      ],
      agentRuns: [
        {
          id: 10,
          userId: 18,
          campaignId: 42,
          agentType: "strategy",
          status: "completed",
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = approvalRouter.createCaller(buildCtx());
    await expect(caller.approveAction({ approvalId: 33 })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });

    expect(db.state.updatedApprovals).toHaveLength(0);
  });

  it("rejects approval when the linked strategy run is missing or incomplete", async () => {
    const { getDb } = await import("./queries/connection");
    const { approvalRouter } = await import("./approval-router");

    const db = createMockDb({
      campaign: {
        id: 42,
        userId: 18,
        workflowState: "strategy_generated",
        workflowContext: {
          strategyFingerprint: "fp-current",
          strategyApprovalLineage: {
            creativeBriefFingerprint: "fp-current",
            strategyRunId: 10,
            approvalRequestId: 1,
            status: "pending",
          },
        },
      },
      approvals: [
        {
          id: 1,
          userId: 18,
          campaignId: 42,
          approvalType: "strategy_review",
          status: "pending",
        },
      ],
      agentRuns: [
        {
          id: 10,
          userId: 18,
          campaignId: 42,
          agentType: "strategy",
          status: "failed",
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = approvalRouter.createCaller(buildCtx());
    await expect(caller.approveAction({ approvalId: 1 })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });

    expect(db.state.updatedApprovals).toHaveLength(0);
  });

  it("preserves historical approved request 33 when the brief changes", async () => {
    const { getDb } = await import("./queries/connection");
    const { approvalRouter } = await import("./approval-router");

    const db = createMockDb({
      campaign: {
        id: 42,
        userId: 18,
        workflowState: "strategy_approved",
        workflowContext: {
          approvedStrategyFingerprint: "fp-old",
          strategyFingerprint: "fp-old",
          strategyApprovalLineage: {
            creativeBriefFingerprint: "fp-old",
            strategyRunId: 10,
            approvalRequestId: 33,
            status: "approved",
          },
        },
      },
      approvals: [
        {
          id: 33,
          userId: 18,
          campaignId: 42,
          approvalType: "strategy_review",
          status: "approved",
          approvedAt: new Date("2026-01-01"),
        },
      ],
      agentRuns: [
        {
          id: 10,
          userId: 18,
          campaignId: 42,
          agentType: "strategy",
          status: "completed",
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = approvalRouter.createCaller(buildCtx());

    await expect(caller.approveAction({ approvalId: 33 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });

    expect(db.state.updatedApprovals).toHaveLength(0);
  });

  it("rejects a fingerprint-matching strategy_review whose linked run fails semantic validation", async () => {
    const { getDb } = await import("./queries/connection");
    const { approvalRouter } = await import("./approval-router");
    const { validateStrategyOutputAgainstCampaign } = await import("./lib/agents/strategy-agent");

    vi.mocked(validateStrategyOutputAgainstCampaign).mockReturnValue({
      valid: false,
      reason: "Strategy output contains stale audience classification: small businesses.",
    });

    const db = createMockDb({
      campaign: {
        id: 42,
        userId: 18,
        workflowState: "strategy_generated",
        workflowContext: {
          strategyFingerprint: "fp-current",
          strategyApprovalLineage: {
            creativeBriefFingerprint: "fp-current",
            strategyRunId: 245,
            approvalRequestId: 34,
            status: "pending",
          },
        },
      },
      approvals: [
        {
          id: 34,
          userId: 18,
          campaignId: 42,
          approvalType: "strategy_review",
          status: "pending",
        },
      ],
      agentRuns: [
        {
          id: 245,
          userId: 18,
          campaignId: 42,
          agentType: "strategy",
          status: "completed",
          output: { creativeBriefFingerprint: "fp-current", __invalid: true },
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = approvalRouter.createCaller(buildCtx());
    await expect(caller.approveAction({ approvalId: 34 })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });

    // Approval 34 remains pending; no historical record is deleted.
    expect(db.state.updatedApprovals).toHaveLength(0);
  });
});

describe("approvalRouter.campaign_launch fail-closed hardening (G-04)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const launchCampaign = (workflowState: string, workflowContext: any = {}) => ({
    id: 42,
    userId: 18,
    aiGenerated: true,
    name: "Launch Campaign",
    platforms: "facebook",
    businessId: null,
    workflowState,
    workflowContext,
  });

  it("does not auto-approve a stale pending launch approval when the campaign state has moved on", async () => {
    const { getDb } = await import("./queries/connection");
    const { approvalRouter } = await import("./approval-router");

    const db = createMockDb({
      campaign: launchCampaign("campaign_live"),
      approvals: [
        {
          id: 7,
          userId: 18,
          campaignId: 42,
          approvalType: "campaign_launch",
          status: "pending",
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = approvalRouter.createCaller(buildCtx());
    await caller.listApprovals();

    // The pending request must remain pending: no fabricated approval, no
    // recreated request.
    expect(db.state.updatedApprovals).toHaveLength(0);
    expect(db.state.insertedApprovals).toHaveLength(0);
  });

  it("does not auto-approve a pending launch approval merely because AI content exists", async () => {
    const { getDb } = await import("./queries/connection");
    const { approvalRouter } = await import("./approval-router");

    const db = createMockDb({
      campaign: launchCampaign("creatives_ready"),
      approvals: [
        {
          id: 7,
          userId: 18,
          campaignId: 42,
          approvalType: "campaign_launch",
          status: "pending",
        },
      ],
      agentRuns: [{ id: 10, userId: 18, campaignId: 42, agentType: "creative", status: "completed" }],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = approvalRouter.createCaller(buildCtx());
    await caller.listApprovals();

    expect(db.state.updatedApprovals).toHaveLength(0);
    expect(db.state.insertedApprovals).toHaveLength(0);
  });

  it("recreates a missing pending launch approval and links it to the current brief lineage", async () => {
    const { getDb } = await import("./queries/connection");
    const { approvalRouter } = await import("./approval-router");

    const db = createMockDb({
      campaign: launchCampaign("launch_approval_required"),
      approvals: [],
      insertId: 77,
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = approvalRouter.createCaller(buildCtx());
    await caller.listApprovals();

    // A new pending request is created (restore of the ask, not the answer)…
    expect(db.state.insertedApprovals).toHaveLength(1);
    expect(db.state.insertedApprovals[0]).toMatchObject({
      userId: 18,
      campaignId: 42,
      approvalType: "campaign_launch",
      status: "pending",
    });
    // …and durable lineage links it to the current brief fingerprint.
    expect(db.state.updatedCampaigns).toHaveLength(1);
    expect(db.state.updatedCampaigns[0].workflowContext.launchApprovalLineage).toEqual({
      creativeBriefFingerprint: "fp-current",
      approvalRequestId: 77,
      status: "pending",
    });
    expect(db.state.updatedApprovals).toHaveLength(0);
  });

  it("keeps an explicit approval valid when lineage and campaign context still match", async () => {
    const { getDb } = await import("./queries/connection");
    const { approvalRouter } = await import("./approval-router");

    const db = createMockDb({
      campaign: launchCampaign("launch_approval_required", {
        launchApprovalLineage: {
          creativeBriefFingerprint: "fp-current",
          approvalRequestId: 5,
          status: "approved",
        },
      }),
      approvals: [
        {
          id: 5,
          userId: 18,
          campaignId: 42,
          approvalType: "campaign_launch",
          status: "approved",
          approvedAt: new Date("2026-01-01"),
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = approvalRouter.createCaller(buildCtx());
    await caller.listApprovals();

    // Usable evidence: no duplicate request created, no decision rewritten.
    expect(db.state.insertedApprovals).toHaveLength(0);
    expect(db.state.updatedApprovals).toHaveLength(0);
    expect(db.state.updatedCampaigns).toHaveLength(0);
  });

  it("does not treat a bare approved row without lineage as reusable authority", async () => {
    const { getDb } = await import("./queries/connection");
    const { approvalRouter } = await import("./approval-router");

    const db = createMockDb({
      campaign: launchCampaign("launch_approval_required"),
      approvals: [
        {
          id: 5,
          userId: 18,
          campaignId: 42,
          approvalType: "campaign_launch",
          status: "approved",
          approvedAt: new Date("2026-01-01"),
        },
      ],
      insertId: 88,
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = approvalRouter.createCaller(buildCtx());
    await caller.listApprovals();

    // The unlinked row is historical evidence only; a fresh pending request is
    // required for a real human decision.
    expect(db.state.updatedApprovals).toHaveLength(0);
    expect(db.state.insertedApprovals).toHaveLength(1);
    expect(db.state.updatedCampaigns[0].workflowContext.launchApprovalLineage).toEqual({
      creativeBriefFingerprint: "fp-current",
      approvalRequestId: 88,
      status: "pending",
    });
  });

  it("never repairs a rejected launch approval into approved; it recreates a fresh pending request instead", async () => {
    const { getDb } = await import("./queries/connection");
    const { approvalRouter } = await import("./approval-router");

    const db = createMockDb({
      campaign: launchCampaign("launch_approval_required"),
      approvals: [
        {
          id: 9,
          userId: 18,
          campaignId: 42,
          approvalType: "campaign_launch",
          status: "rejected",
          rejectedAt: new Date("2026-01-01"),
        },
      ],
      insertId: 99,
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = approvalRouter.createCaller(buildCtx());
    await caller.listApprovals();

    // The rejected row is preserved untouched as evidence…
    expect(db.state.updatedApprovals).toHaveLength(0);
    // …and a new pending request is created for a fresh human decision.
    expect(db.state.insertedApprovals).toHaveLength(1);
    expect(db.state.insertedApprovals[0].status).toBe("pending");
    expect(db.state.updatedCampaigns[0].workflowContext.launchApprovalLineage).toEqual({
      creativeBriefFingerprint: "fp-current",
      approvalRequestId: 99,
      status: "pending",
    });
  });

  it("authorises a lineage-valid pending launch approval and persists the approved lineage", async () => {
    const { getDb } = await import("./queries/connection");
    const { approvalRouter } = await import("./approval-router");

    const db = createMockDb({
      campaign: launchCampaign("launch_approval_required", {
        launchApprovalLineage: {
          creativeBriefFingerprint: "fp-current",
          approvalRequestId: 7,
          status: "pending",
        },
      }),
      approvals: [
        {
          id: 7,
          userId: 18,
          campaignId: 42,
          approvalType: "campaign_launch",
          status: "pending",
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = approvalRouter.createCaller(buildCtx());
    const result = await caller.approveAction({ approvalId: 7 });

    expect(result.success).toBe(true);
    expect(db.state.updatedApprovals).toHaveLength(1);
    expect(db.state.updatedApprovals[0].status).toBe("approved");
    expect(db.state.updatedCampaigns[0].workflowContext.launchApprovalLineage).toEqual({
      creativeBriefFingerprint: "fp-current",
      approvalRequestId: 7,
      status: "approved",
    });
  });

  it("refuses to authorise a launch approval that has no recorded lineage", async () => {
    const { getDb } = await import("./queries/connection");
    const { approvalRouter } = await import("./approval-router");

    const db = createMockDb({
      campaign: launchCampaign("launch_approval_required"),
      approvals: [
        {
          id: 7,
          userId: 18,
          campaignId: 42,
          approvalType: "campaign_launch",
          status: "pending",
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = approvalRouter.createCaller(buildCtx());
    await expect(caller.approveAction({ approvalId: 7 })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });

    expect(db.state.updatedApprovals).toHaveLength(0);
    expect(db.state.updatedCampaigns).toHaveLength(0);
  });

  it("refuses to authorise a launch approval after the brief has changed", async () => {
    const { getDb } = await import("./queries/connection");
    const { approvalRouter } = await import("./approval-router");

    const db = createMockDb({
      campaign: launchCampaign("launch_approval_required", {
        launchApprovalLineage: {
          creativeBriefFingerprint: "fp-old",
          approvalRequestId: 7,
          status: "pending",
        },
      }),
      approvals: [
        {
          id: 7,
          userId: 18,
          campaignId: 42,
          approvalType: "campaign_launch",
          status: "pending",
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = approvalRouter.createCaller(buildCtx());
    await expect(caller.approveAction({ approvalId: 7 })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });

    expect(db.state.updatedApprovals).toHaveLength(0);
  });

  it("refuses to authorise an older pending launch request when lineage points at a different request", async () => {
    const { getDb } = await import("./queries/connection");
    const { approvalRouter } = await import("./approval-router");

    const db = createMockDb({
      campaign: launchCampaign("launch_approval_required", {
        launchApprovalLineage: {
          creativeBriefFingerprint: "fp-current",
          approvalRequestId: 33,
          status: "pending",
        },
      }),
      approvals: [
        {
          id: 7,
          userId: 18,
          campaignId: 42,
          approvalType: "campaign_launch",
          status: "pending",
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = approvalRouter.createCaller(buildCtx());
    await expect(caller.approveAction({ approvalId: 7 })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });

    expect(db.state.updatedApprovals).toHaveLength(0);
  });
});
