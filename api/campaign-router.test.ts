import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("./lib/subscription", () => ({
  checkLimit: vi.fn(async () => ({ allowed: true })),
  incrementCampaignUsage: vi.fn(),
  incrementResultUsage: vi.fn(),
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

vi.mock("./lib/agents/strategy-agent", () => ({
  runStrategyAgent: vi.fn(),
  chargeForStrategyRun: vi.fn(),
  reconcileStrategyRunCharge: vi.fn(async () => ({ alreadyCharged: true, chargedNow: false })),
  validateStrategyReadiness: vi.fn(() => ({ ready: true })),
  isSuccessfulStrategyOutput: vi.fn((output: any) => {
    // Default: only flat successful outputs (fingerprint and no envelope outcome)
    // are treated as reusable strategies.
    return (
      typeof output === "object" &&
      output !== null &&
      typeof output.creativeBriefFingerprint === "string" &&
      !("outcome" in output)
    );
  }),
  validateStrategyOutputAgainstCampaign: vi.fn((output: any) => {
    // Default: treat outputs as valid so existing tests keep passing.
    // Tests that need an invalid reusable run can override this per-call.
    return { valid: true };
  }),
}));

vi.mock("./lib/agents/creative-agent", () => ({
  runCreativeAgent: vi.fn(),
}));

vi.mock("./lib/workflow/engine", () => ({
  transitionCampaignState: vi.fn(async () => "strategy_approved"),
  createApprovalRequest: vi.fn(async () => ({ id: 1 })),
}));

vi.mock("./lib/workflow/triggers", () => ({
  onAgentRunComplete: vi.fn(async () => undefined),
}));

vi.mock("./lib/creative/creative-generation-claim", () => ({
  generateOwnerToken: vi.fn(() => "test-owner-token"),
  acquireCreativeGenerationClaim: vi.fn(async () => ({
    acquired: true,
    claim: { id: 1001, ownerToken: "test-owner-token" },
  })),
  attachCreativeGenerationOperationReference: vi.fn(async () => ({ attached: true })),
  releaseClaimSafely: vi.fn(),
  releaseClaimWithResult: vi.fn(async () => ({ released: true })),
  calculateLeaseExpiresAt: vi.fn(() => new Date(Date.now() + 300_000)),
  createClaimHeartbeatController: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(async () => undefined),
    assertStillOwned: vi.fn(async () => undefined),
    abortSignal: undefined,
    lostOwnership: false,
  })),
}));

vi.mock("./lib/billing/credit-engine", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    deductCredits: vi.fn(async () => ({ newBalance: 100 })),
    refundCredits: vi.fn(async () => ({ newBalance: 100 })),
  };
});

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as
    | string
    | undefined;
}

function makeQueryable(rows: unknown[]) {
  const q = {
    limit: vi.fn(async () => rows),
    orderBy: vi.fn(() => q),
    then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
  };
  return q;
}

function createMockDb({
  approvalRequestsRows = [] as any[],
  agentRunsRows = [] as any[],
  campaignOverrides = {} as any,
  businessOverrides = {} as any,
} = {}) {
  const allAgentRunsRows = [...agentRunsRows];

  const state = {
    agentRunsRows: allAgentRunsRows,
    insertedRows: [] as any[],
    updatedRows: [] as any[],
    updatedCampaignStates: [] as any[],
    updatedApprovalRequests: [] as any[],
    updatedAgentRuns: [] as any[],
    deletedRows: [] as any[],
    insertedApprovalRequest: null as any,
  };

  function baseResultFor(table: unknown) {
    const name = getTableName(table);
    if (name === "campaigns") {
      return [
        {
          id: 42,
          userId: 18,
          businessId: 7,
          name: "Test Campaign",
          workflowState: "strategy_approved",
          workflowContext: {},
          ...campaignOverrides,
        },
      ];
    }
    if (name === "businesses") {
      return [
        {
          id: 7,
          name: "Test Business",
          websiteEvidence: {},
          onboardingComplete: false,
          ...businessOverrides,
        },
      ];
    }
    if (name === "approval_requests") {
      return approvalRequestsRows;
    }
    if (name === "agent_runs") {
      return agentRunsRows;
    }
    if (name === "content_posts" || name === "campaign_assets") {
      return [];
    }
    return [];
  }

  const db = {
    state,
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => makeQueryable(baseResultFor(table))),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: any) => ({
        // Return the same shape drizzle returns so callers can read insertId.
        then: vi.fn((resolve: (value: unknown) => unknown) => {
          const name = getTableName(table);
          if (name === "approval_requests") {
            state.insertedApprovalRequest = values;
          }
          return Promise.resolve(resolve([{ insertId: 1 }]));
        }),
      })),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((payload: any) => ({
        where: vi.fn(async () => {
          const name = getTableName(table);
          if (name === "campaigns") {
            state.updatedCampaignStates.push(payload);
          }
          if (name === "approval_requests") {
            state.updatedApprovalRequests.push(payload);
          }
          if (name === "agent_runs") {
            state.updatedAgentRuns.push(payload);
          }
          return [];
        }),
      })),
    })),
    delete: vi.fn((table: unknown) => ({
      where: vi.fn(async () => {
        const name = getTableName(table);
        state.deletedRows.push({ table: name });
        return [];
      }),
    })),
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

function buildOnboardedCtx() {
  return {
    ...buildCtx(),
    user: { id: 18, tierSlug: "free", onboardingComplete: true },
  } as any;
}

describe("campaignRouter.regenerateFromProfile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns TRPCError when campaign is not linked to a business", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent } = await import("./lib/agents/strategy-agent");
    const { createApprovalRequest } = await import("./lib/workflow/engine");
    const { campaignRouter } = await import("./campaign-router");

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as any);

    vi.mocked(db.select).mockImplementation(() => ({
      from: vi.fn((table: unknown) => {
        const result =
          getTableName(table) === "campaigns"
            ? [{ id: 42, userId: 18, businessId: null, workflowState: "strategy_approved" }]
            : [];
        return {
          where: vi.fn(() => makeQueryable(result)),
        };
      }),
    }) as any);

    const caller = campaignRouter.createCaller(buildCtx());
    await expect(caller.regenerateFromProfile({ campaignId: 42 })).rejects.toBeInstanceOf(TRPCError);
    expect(runStrategyAgent).not.toHaveBeenCalled();
    expect(createApprovalRequest).not.toHaveBeenCalled();
  });

  it("success lifecycle: charges once, creates pending strategy_review approval and does not run creative generation", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent, chargeForStrategyRun } = await import("./lib/agents/strategy-agent");
    const { createApprovalRequest } = await import("./lib/workflow/engine");
    const { transitionCampaignState } = await import("./lib/workflow/engine");
    const { releaseClaimWithResult } = await import("./lib/creative/creative-generation-claim");
    const { campaignRouter } = await import("./campaign-router");

    const db = createMockDb({
      businessOverrides: {
        onboardingComplete: true,
        websiteEvidence: { confidence: 0.8 },
      },
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const validFlatOutput = {
      creativeBriefFingerprint: "fp-current",
      coreMessage: "service",
      positioning: "service",
      valueProposition: "service",
      campaignTheme: "theme",
      personas: [{ name: "Buyer", demographics: "buyer", painPoints: ["pain"], goals: ["goal"], platforms: ["LinkedIn"] }],
      ctas: [{ stage: "awareness", cta: "cta", placement: "ad" }],
      offers: [],
      funnelStages: [],
      platformStrategy: [],
      budgetRecommendation: { total: 0, allocation: [] },
    };

    vi.mocked(runStrategyAgent).mockResolvedValue({
      runId: 9001,
      output: validFlatOutput,
      promptTokens: 100,
      completionTokens: 50,
      actualCostUsdMicro: 0,
      estimatedCostUsdMicro: 0,
    } as any);

    const caller = campaignRouter.createCaller(buildCtx());
    const result = await caller.regenerateFromProfile({ campaignId: 42 });

    expect(result.success).toBe(true);
    expect(result.strategyRunId).toBe(9001);
    expect(result.reused).toBe(false);
    expect(result.approvalRequestId).toBe(1);

    expect(chargeForStrategyRun).toHaveBeenCalledTimes(1);
    expect(chargeForStrategyRun).toHaveBeenCalledWith(18, 42, expect.objectContaining({ runId: 9001 }));

    expect(createApprovalRequest).toHaveBeenCalledTimes(1);
    expect(createApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 18,
        campaignId: 42,
        approvalType: "strategy_review",
      })
    );

    expect(transitionCampaignState).not.toHaveBeenCalledWith(42, 18, "approve_strategy");
    expect(transitionCampaignState).not.toHaveBeenCalledWith(42, 18, "generate_creatives");

    const lineageUpdate = db.state.updatedCampaignStates
      .filter((u: any) => u.workflowContext?.strategyApprovalLineage)
      .pop();
    expect(lineageUpdate).toBeDefined();
    expect(lineageUpdate.workflowState).toBe("strategy_generated");
    expect(lineageUpdate.workflowContext.strategyApprovalLineage).toMatchObject({
      creativeBriefFingerprint: "fp-current",
      strategyRunId: 9001,
      approvalRequestId: 1,
      status: "pending",
    });
    expect(lineageUpdate.workflowContext.approvedStrategyFingerprint).toBeNull();

    expect(releaseClaimWithResult).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
  });

  it("reuses a completed strategy run and does not charge again", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent, chargeForStrategyRun, reconcileStrategyRunCharge } = await import(
      "./lib/agents/strategy-agent"
    );
    const { createApprovalRequest } = await import("./lib/workflow/engine");
    const { releaseClaimWithResult } = await import("./lib/creative/creative-generation-claim");
    const { campaignRouter } = await import("./campaign-router");

    const db = createMockDb({
      agentRunsRows: [
        {
          id: 252,
          userId: 18,
          campaignId: 42,
          agentType: "strategy",
          status: "completed",
          output: { creativeBriefFingerprint: "fp-current" },
        },
      ],
      businessOverrides: {
        onboardingComplete: true,
        websiteEvidence: { confidence: 0.8 },
      },
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = campaignRouter.createCaller(buildCtx());
    const result = await caller.regenerateFromProfile({ campaignId: 42 });

    expect(result.success).toBe(true);
    expect(result.reused).toBe(true);
    expect(result.strategyRunId).toBe(252);
    expect(result.approvalRequestId).toBe(1);

    expect(runStrategyAgent).not.toHaveBeenCalled();
    expect(chargeForStrategyRun).not.toHaveBeenCalled();
    expect(reconcileStrategyRunCharge).toHaveBeenCalledTimes(1);
    expect(reconcileStrategyRunCharge).toHaveBeenCalledWith(18, 42, 252);
    expect(createApprovalRequest).toHaveBeenCalledTimes(1);
    expect(releaseClaimWithResult).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));

    const lineageUpdate = db.state.updatedCampaignStates
      .filter((u: any) => u.workflowContext?.strategyApprovalLineage)
      .pop();
    expect(lineageUpdate.workflowContext.strategyApprovalLineage).toMatchObject({
      creativeBriefFingerprint: "fp-current",
      strategyRunId: 252,
      approvalRequestId: 1,
      status: "pending",
    });
  });

  it("fails closed on strategy failure: claim failed, no charge, no approval, no creative", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent, chargeForStrategyRun } = await import("./lib/agents/strategy-agent");
    const { createApprovalRequest } = await import("./lib/workflow/engine");
    const { attachCreativeGenerationOperationReference, releaseClaimWithResult } = await import(
      "./lib/creative/creative-generation-claim"
    );
    const { campaignRouter } = await import("./campaign-router");

    const db = createMockDb({
      businessOverrides: {
        onboardingComplete: true,
        websiteEvidence: { confidence: 0.8 },
      },
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    vi.mocked(runStrategyAgent).mockRejectedValue(new TRPCError({
      code: "UNPROCESSABLE_CONTENT",
      message: "Strategy output failed validation",
    }));

    const caller = campaignRouter.createCaller(buildCtx());
    await expect(caller.regenerateFromProfile({ campaignId: 42 })).rejects.toMatchObject({
      code: "UNPROCESSABLE_CONTENT",
    });

    expect(attachCreativeGenerationOperationReference).not.toHaveBeenCalled();
    expect(releaseClaimWithResult).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
    expect(chargeForStrategyRun).not.toHaveBeenCalled();
    expect(createApprovalRequest).not.toHaveBeenCalled();
  });

  it("supersedes stale pending strategy_review approval and creates a current one", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent, chargeForStrategyRun } = await import("./lib/agents/strategy-agent");
    const { createApprovalRequest } = await import("./lib/workflow/engine");
    const { campaignRouter } = await import("./campaign-router");

    const db = createMockDb({
      agentRunsRows: [
        {
          id: 252,
          userId: 18,
          campaignId: 42,
          agentType: "strategy",
          status: "completed",
          output: { creativeBriefFingerprint: "fp-current" },
        },
      ],
      approvalRequestsRows: [
        {
          id: 35,
          userId: 18,
          campaignId: 42,
          approvalType: "strategy_review",
          status: "pending",
          description: "Old approval",
        },
      ],
      campaignOverrides: {
        workflowState: "creatives_generating",
        workflowContext: {
          strategyApprovalLineage: {
            creativeBriefFingerprint: "fp-old",
            strategyRunId: 251,
            approvalRequestId: 35,
            status: "pending",
          },
        },
      },
      businessOverrides: {
        onboardingComplete: true,
        websiteEvidence: { confidence: 0.8 },
      },
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = campaignRouter.createCaller(buildCtx());
    const result = await caller.regenerateFromProfile({ campaignId: 42 });

    expect(result.success).toBe(true);
    expect(result.strategyRunId).toBe(252);
    expect(result.approvalRequestId).toBe(1);
    expect(result.reused).toBe(true);

    expect(runStrategyAgent).not.toHaveBeenCalled();
    expect(chargeForStrategyRun).not.toHaveBeenCalled();

    const supersededUpdate = db.state.updatedApprovalRequests.find(
      (u: any) => u.status === "rejected"
    );
    expect(supersededUpdate).toBeDefined();

    expect(createApprovalRequest).toHaveBeenCalledTimes(1);

    const lineageUpdate = db.state.updatedCampaignStates
      .filter((u: any) => u.workflowContext?.strategyApprovalLineage)
      .pop();
    expect(lineageUpdate.workflowState).toBe("strategy_generated");
    expect(lineageUpdate.workflowContext.strategyApprovalLineage).toMatchObject({
      creativeBriefFingerprint: "fp-current",
      strategyRunId: 252,
      approvalRequestId: 1,
      status: "pending",
    });
  });

  it("reuses an existing pending strategy_review approval when lineage matches", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent, chargeForStrategyRun } = await import("./lib/agents/strategy-agent");
    const { createApprovalRequest } = await import("./lib/workflow/engine");
    const { campaignRouter } = await import("./campaign-router");

    const db = createMockDb({
      agentRunsRows: [
        {
          id: 252,
          userId: 18,
          campaignId: 42,
          agentType: "strategy",
          status: "completed",
          output: { creativeBriefFingerprint: "fp-current" },
        },
      ],
      approvalRequestsRows: [
        {
          id: 36,
          userId: 18,
          campaignId: 42,
          approvalType: "strategy_review",
          status: "pending",
        },
      ],
      campaignOverrides: {
        workflowContext: {
          strategyApprovalLineage: {
            creativeBriefFingerprint: "fp-current",
            strategyRunId: 252,
            approvalRequestId: 36,
            status: "pending",
          },
        },
      },
      businessOverrides: {
        onboardingComplete: true,
        websiteEvidence: { confidence: 0.8 },
      },
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = campaignRouter.createCaller(buildCtx());
    const result = await caller.regenerateFromProfile({ campaignId: 42 });

    expect(result.success).toBe(true);
    expect(result.reused).toBe(true);
    expect(result.strategyRunId).toBe(252);
    expect(result.approvalRequestId).toBe(36);

    expect(runStrategyAgent).not.toHaveBeenCalled();
    expect(chargeForStrategyRun).not.toHaveBeenCalled();
    expect(createApprovalRequest).not.toHaveBeenCalled();
  });

  it("recovers a missing approval for a completed run without charging or re-running the model", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent, chargeForStrategyRun } = await import("./lib/agents/strategy-agent");
    const { createApprovalRequest } = await import("./lib/workflow/engine");
    const { campaignRouter } = await import("./campaign-router");

    const db = createMockDb({
      agentRunsRows: [
        {
          id: 252,
          userId: 18,
          campaignId: 42,
          agentType: "strategy",
          status: "completed",
          output: { creativeBriefFingerprint: "fp-current" },
        },
      ],
      campaignOverrides: {
        workflowState: "creatives_generating",
        workflowContext: {},
      },
      businessOverrides: {
        onboardingComplete: true,
        websiteEvidence: { confidence: 0.8 },
      },
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = campaignRouter.createCaller(buildCtx());
    const result = await caller.regenerateFromProfile({ campaignId: 42 });

    expect(result.success).toBe(true);
    expect(result.reused).toBe(true);
    expect(result.strategyRunId).toBe(252);
    expect(result.approvalRequestId).toBe(1);

    expect(runStrategyAgent).not.toHaveBeenCalled();
    expect(chargeForStrategyRun).not.toHaveBeenCalled();
    expect(createApprovalRequest).toHaveBeenCalledTimes(1);

    const lineageUpdate = db.state.updatedCampaignStates
      .filter((u: any) => u.workflowContext?.strategyApprovalLineage)
      .pop();
    expect(lineageUpdate.workflowState).toBe("strategy_generated");
    expect(lineageUpdate.workflowContext.strategyApprovalLineage).toMatchObject({
      creativeBriefFingerprint: "fp-current",
      strategyRunId: 252,
      approvalRequestId: 1,
      status: "pending",
    });
  });

  it("does not charge again when the reused completed run already has a strategy charge", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent, chargeForStrategyRun, reconcileStrategyRunCharge } = await import(
      "./lib/agents/strategy-agent"
    );
    const { createApprovalRequest } = await import("./lib/workflow/engine");
    const { campaignRouter } = await import("./campaign-router");

    const db = createMockDb({
      agentRunsRows: [
        {
          id: 252,
          userId: 18,
          campaignId: 42,
          agentType: "strategy",
          status: "completed",
          output: { creativeBriefFingerprint: "fp-current" },
        },
      ],
      campaignOverrides: {
        workflowState: "creatives_generating",
        workflowContext: {},
      },
      businessOverrides: {
        onboardingComplete: true,
        websiteEvidence: { confidence: 0.8 },
      },
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = campaignRouter.createCaller(buildCtx());
    const result = await caller.regenerateFromProfile({ campaignId: 42 });

    expect(result.success).toBe(true);
    expect(result.reused).toBe(true);
    expect(result.strategyRunId).toBe(252);
    expect(runStrategyAgent).not.toHaveBeenCalled();
    expect(chargeForStrategyRun).not.toHaveBeenCalled();
    expect(reconcileStrategyRunCharge).toHaveBeenCalledTimes(1);
    expect(reconcileStrategyRunCharge).toHaveBeenCalledWith(18, 42, 252);
    expect(createApprovalRequest).toHaveBeenCalledTimes(1);
  });

  it("reconciles a missing strategy charge for a reused completed run before creating approval", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent, chargeForStrategyRun, reconcileStrategyRunCharge } = await import(
      "./lib/agents/strategy-agent"
    );
    const { createApprovalRequest } = await import("./lib/workflow/engine");
    const { releaseClaimWithResult } = await import("./lib/creative/creative-generation-claim");
    const { campaignRouter } = await import("./campaign-router");

    vi.mocked(reconcileStrategyRunCharge).mockResolvedValueOnce({
      alreadyCharged: false,
      chargedNow: true,
    });

    const db = createMockDb({
      agentRunsRows: [
        {
          id: 252,
          userId: 18,
          campaignId: 42,
          agentType: "strategy",
          status: "completed",
          output: { creativeBriefFingerprint: "fp-current" },
        },
      ],
      campaignOverrides: {
        workflowState: "creatives_generating",
        workflowContext: {},
      },
      businessOverrides: {
        onboardingComplete: true,
        websiteEvidence: { confidence: 0.8 },
      },
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = campaignRouter.createCaller(buildCtx());
    const result = await caller.regenerateFromProfile({ campaignId: 42 });

    expect(result.success).toBe(true);
    expect(result.reused).toBe(true);
    expect(result.strategyRunId).toBe(252);
    expect(runStrategyAgent).not.toHaveBeenCalled();
    expect(chargeForStrategyRun).not.toHaveBeenCalled();
    expect(reconcileStrategyRunCharge).toHaveBeenCalledTimes(1);
    expect(reconcileStrategyRunCharge).toHaveBeenCalledWith(18, 42, 252);
    expect(createApprovalRequest).toHaveBeenCalledTimes(1);
    expect(releaseClaimWithResult).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));

    const lineageUpdate = db.state.updatedCampaignStates
      .filter((u: any) => u.workflowContext?.strategyApprovalLineage)
      .pop();
    expect(lineageUpdate.workflowState).toBe("strategy_generated");
  });

  it("keeps a completed run completed, retains the valid charge, and fails the claim when approval creation throws after a new run and charge", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent, chargeForStrategyRun } = await import("./lib/agents/strategy-agent");
    const { createApprovalRequest } = await import("./lib/workflow/engine");
    const { runCreativeAgent } = await import("./lib/agents/creative-agent");
    const {
      attachCreativeGenerationOperationReference,
      releaseClaimWithResult,
    } = await import("./lib/creative/creative-generation-claim");
    const { refundCredits } = await import("./lib/billing/credit-engine");
    const { campaignRouter } = await import("./campaign-router");

    const db = createMockDb({
      businessOverrides: {
        onboardingComplete: true,
        websiteEvidence: { confidence: 0.8 },
      },
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    vi.mocked(runStrategyAgent).mockImplementationOnce(async (args: any) => {
      await args.onRunCreated(9001, { mockTx: true });
      return {
        runId: 9001,
        output: {},
        promptTokens: 100,
        completionTokens: 50,
        actualCostUsdMicro: 0,
        estimatedCostUsdMicro: 0,
      } as any;
    });
    vi.mocked(createApprovalRequest).mockRejectedValueOnce(new Error("approval db error"));

    const caller = campaignRouter.createCaller(buildCtx());
    await expect(caller.regenerateFromProfile({ campaignId: 42 })).rejects.toBeInstanceOf(TRPCError);

    expect(attachCreativeGenerationOperationReference).toHaveBeenCalledWith(
      expect.objectContaining({ operationReferenceId: 9001 })
    );
    expect(chargeForStrategyRun).toHaveBeenCalledTimes(1);
    expect(chargeForStrategyRun).toHaveBeenCalledWith(18, 42, expect.objectContaining({ runId: 9001 }));
    expect(createApprovalRequest).toHaveBeenCalledTimes(1);

    // The strategy service was successfully delivered; approval failure is not a
    // valid reason to refund the charge.
    expect(refundCredits).not.toHaveBeenCalled();
    expect(releaseClaimWithResult).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
    expect(runCreativeAgent).not.toHaveBeenCalled();

    // A completed strategy run must never be rewritten to failed by a downstream
    // approval or claim-cleanup failure.
    const runFailedUpdate = db.state.updatedAgentRuns.find((u: any) => u.status === "failed");
    expect(runFailedUpdate).toBeUndefined();

    // The campaign must not be left in a creative-generation state.
    const creativesGeneratingUpdate = db.state.updatedCampaignStates.find(
      (u: any) => u.workflowState === "creatives_generating"
    );
    expect(creativesGeneratingUpdate).toBeUndefined();
  });

  it("retry after interrupted approval reuses the completed run, recovers approval and creates no new charge or run", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent, chargeForStrategyRun, reconcileStrategyRunCharge } = await import(
      "./lib/agents/strategy-agent"
    );
    const { createApprovalRequest } = await import("./lib/workflow/engine");
    const { runCreativeAgent } = await import("./lib/agents/creative-agent");
    const { releaseClaimWithResult } = await import("./lib/creative/creative-generation-claim");
    const { campaignRouter } = await import("./campaign-router");

    vi.mocked(createApprovalRequest).mockResolvedValueOnce({ id: 99 } as any);

    const db = createMockDb({
      agentRunsRows: [
        {
          id: 9001,
          userId: 18,
          campaignId: 42,
          agentType: "strategy",
          status: "completed",
          output: { creativeBriefFingerprint: "fp-current" },
        },
      ],
      approvalRequestsRows: [
        {
          id: 35,
          userId: 18,
          campaignId: 42,
          approvalType: "strategy_review",
          status: "pending",
          description: "Old approval",
        },
      ],
      campaignOverrides: {
        workflowState: "creatives_generating",
        workflowContext: {
          strategyApprovalLineage: {
            creativeBriefFingerprint: "fp-old",
            strategyRunId: 251,
            approvalRequestId: 35,
            status: "pending",
          },
        },
      },
      businessOverrides: {
        onboardingComplete: true,
        websiteEvidence: { confidence: 0.8 },
      },
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = campaignRouter.createCaller(buildCtx());
    const result = await caller.regenerateFromProfile({ campaignId: 42 });

    expect(result.success).toBe(true);
    expect(result.reused).toBe(true);
    expect(result.strategyRunId).toBe(9001);
    expect(result.approvalRequestId).toBe(99);

    expect(runStrategyAgent).not.toHaveBeenCalled();
    expect(chargeForStrategyRun).not.toHaveBeenCalled();
    expect(reconcileStrategyRunCharge).toHaveBeenCalledTimes(1);
    expect(reconcileStrategyRunCharge).toHaveBeenCalledWith(18, 42, 9001);
    expect(createApprovalRequest).toHaveBeenCalledTimes(1);
    expect(runCreativeAgent).not.toHaveBeenCalled();
    expect(releaseClaimWithResult).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));

    const supersededUpdate = db.state.updatedApprovalRequests.find((u: any) => u.status === "rejected");
    expect(supersededUpdate).toBeDefined();

    const lineageUpdate = db.state.updatedCampaignStates
      .filter((u: any) => u.workflowContext?.strategyApprovalLineage)
      .pop();
    expect(lineageUpdate.workflowState).toBe("strategy_generated");
    expect(lineageUpdate.workflowContext.strategyApprovalLineage).toMatchObject({
      creativeBriefFingerprint: "fp-current",
      strategyRunId: 9001,
      approvalRequestId: 99,
      status: "pending",
    });
  });

  it("creates a strategy_review approval whose lineage matches the completed strategy run", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent, chargeForStrategyRun } = await import("./lib/agents/strategy-agent");
    const { createApprovalRequest } = await import("./lib/workflow/engine");
    const { campaignRouter } = await import("./campaign-router");

    const db = createMockDb({
      businessOverrides: {
        onboardingComplete: true,
        websiteEvidence: { confidence: 0.8 },
      },
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    vi.mocked(runStrategyAgent).mockResolvedValue({
      runId: 9001,
      output: {},
      promptTokens: 100,
      completionTokens: 50,
      actualCostUsdMicro: 0,
      estimatedCostUsdMicro: 0,
    } as any);

    const caller = campaignRouter.createCaller(buildCtx());
    const result = await caller.regenerateFromProfile({ campaignId: 42 });

    expect(createApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 18,
        campaignId: 42,
        approvalType: "strategy_review",
      })
    );

    const lineageUpdate = db.state.updatedCampaignStates
      .filter((u: any) => u.workflowContext?.strategyApprovalLineage)
      .pop();
    expect(lineageUpdate.workflowContext.strategyApprovalLineage).toMatchObject({
      creativeBriefFingerprint: "fp-current",
      strategyRunId: 9001,
      approvalRequestId: result.approvalRequestId,
      status: "pending",
    });
  });

  it("reconciles a missing strategy charge for a reused completed run before creating approval", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent, chargeForStrategyRun, reconcileStrategyRunCharge } = await import(
      "./lib/agents/strategy-agent"
    );
    const { createApprovalRequest } = await import("./lib/workflow/engine");
    const { runCreativeAgent } = await import("./lib/agents/creative-agent");
    const { releaseClaimWithResult } = await import("./lib/creative/creative-generation-claim");
    const { campaignRouter } = await import("./campaign-router");

    vi.mocked(reconcileStrategyRunCharge).mockResolvedValueOnce({
      alreadyCharged: false,
      chargedNow: true,
    });

    const db = createMockDb({
      agentRunsRows: [
        {
          id: 9001,
          userId: 18,
          campaignId: 42,
          agentType: "strategy",
          status: "completed",
          output: { creativeBriefFingerprint: "fp-current" },
        },
      ],
      businessOverrides: {
        onboardingComplete: true,
        websiteEvidence: { confidence: 0.8 },
      },
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = campaignRouter.createCaller(buildCtx());
    const result = await caller.regenerateFromProfile({ campaignId: 42 });

    expect(result.success).toBe(true);
    expect(result.reused).toBe(true);
    expect(runStrategyAgent).not.toHaveBeenCalled();
    expect(chargeForStrategyRun).not.toHaveBeenCalled();
    expect(reconcileStrategyRunCharge).toHaveBeenCalledTimes(1);
    expect(reconcileStrategyRunCharge).toHaveBeenCalledWith(18, 42, 9001);
    expect(createApprovalRequest).toHaveBeenCalledTimes(1);
    expect(runCreativeAgent).not.toHaveBeenCalled();
    expect(releaseClaimWithResult).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
  });

  it("fails closed when the reused completed run has a malformed billing record", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent, chargeForStrategyRun, reconcileStrategyRunCharge } = await import(
      "./lib/agents/strategy-agent"
    );
    const { createApprovalRequest } = await import("./lib/workflow/engine");
    const { runCreativeAgent } = await import("./lib/agents/creative-agent");
    const { releaseClaimWithResult } = await import("./lib/creative/creative-generation-claim");
    const { campaignRouter } = await import("./campaign-router");

    vi.mocked(reconcileStrategyRunCharge).mockRejectedValueOnce(
      new TRPCError({
        code: "CONFLICT",
        message: "Strategy-run 9001 charge is malformed. Refusing to reconcile billing.",
      })
    );

    const db = createMockDb({
      agentRunsRows: [
        {
          id: 9001,
          userId: 18,
          campaignId: 42,
          agentType: "strategy",
          status: "completed",
          output: { creativeBriefFingerprint: "fp-current" },
        },
      ],
      businessOverrides: {
        onboardingComplete: true,
        websiteEvidence: { confidence: 0.8 },
      },
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = campaignRouter.createCaller(buildCtx());
    await expect(caller.regenerateFromProfile({ campaignId: 42 })).rejects.toBeInstanceOf(TRPCError);

    expect(runStrategyAgent).not.toHaveBeenCalled();
    expect(chargeForStrategyRun).not.toHaveBeenCalled();
    expect(reconcileStrategyRunCharge).toHaveBeenCalledTimes(1);
    expect(createApprovalRequest).not.toHaveBeenCalled();
    expect(runCreativeAgent).not.toHaveBeenCalled();
    expect(releaseClaimWithResult).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));

    const creativesGeneratingUpdate = db.state.updatedCampaignStates.find(
      (u: any) => u.workflowState === "creatives_generating"
    );
    expect(creativesGeneratingUpdate).toBeUndefined();
  });

  it("fails closed when the reused completed run charge was previously refunded", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent, chargeForStrategyRun, reconcileStrategyRunCharge } = await import(
      "./lib/agents/strategy-agent"
    );
    const { createApprovalRequest } = await import("./lib/workflow/engine");
    const { runCreativeAgent } = await import("./lib/agents/creative-agent");
    const { releaseClaimWithResult } = await import("./lib/creative/creative-generation-claim");
    const { campaignRouter } = await import("./campaign-router");

    vi.mocked(reconcileStrategyRunCharge).mockRejectedValueOnce(
      new TRPCError({
        code: "CONFLICT",
        message: "Strategy-run 9001 charge was previously refunded. Manual billing reconciliation required.",
      })
    );

    const db = createMockDb({
      agentRunsRows: [
        {
          id: 9001,
          userId: 18,
          campaignId: 42,
          agentType: "strategy",
          status: "completed",
          output: { creativeBriefFingerprint: "fp-current" },
        },
      ],
      businessOverrides: {
        onboardingComplete: true,
        websiteEvidence: { confidence: 0.8 },
      },
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = campaignRouter.createCaller(buildCtx());
    await expect(caller.regenerateFromProfile({ campaignId: 42 })).rejects.toBeInstanceOf(TRPCError);

    expect(runStrategyAgent).not.toHaveBeenCalled();
    expect(chargeForStrategyRun).not.toHaveBeenCalled();
    expect(reconcileStrategyRunCharge).toHaveBeenCalledTimes(1);
    expect(createApprovalRequest).not.toHaveBeenCalled();
    expect(runCreativeAgent).not.toHaveBeenCalled();
    expect(releaseClaimWithResult).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });
});

describe("campaignRouter.regenerateStrategyForApproval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("regenerates strategy when no completed run matches the current brief, records fingerprint and creates one pending strategy_review", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent } = await import("./lib/agents/strategy-agent");
    const { createApprovalRequest } = await import("./lib/workflow/engine");
    const { campaignRouter } = await import("./campaign-router");

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runStrategyAgent).mockResolvedValue({ runId: 999, output: {} } as any);

    const caller = campaignRouter.createCaller(buildCtx());
    const result = await caller.regenerateStrategyForApproval({ campaignId: 42 });

    expect(result.success).toBe(true);
    expect(result.strategyRunId).toBe(999);
    expect(result.approvalRequestId).toBe(1);
    expect(runStrategyAgent).toHaveBeenCalledTimes(1);
    expect(createApprovalRequest).toHaveBeenCalledTimes(1);

    const lineageUpdates = db.state.updatedCampaignStates.filter(
      (u: any) => u.workflowContext?.strategyApprovalLineage
    );
    expect(lineageUpdates.length).toBeGreaterThan(0);
    expect(lineageUpdates[lineageUpdates.length - 1].workflowContext.strategyApprovalLineage).toMatchObject({
      creativeBriefFingerprint: "fp-current",
      strategyRunId: 999,
      approvalRequestId: 1,
      status: "pending",
    });

    // No historical agent_runs were deleted.
    expect(db.state.deletedRows.some((d: any) => d.table === "agent_runs")).toBe(false);
  });

  it("reuses completed strategy run with matching fingerprint and creates a pending request without deleting historical runs", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent } = await import("./lib/agents/strategy-agent");
    const { createApprovalRequest } = await import("./lib/workflow/engine");
    const { campaignRouter } = await import("./campaign-router");

    const db = createMockDb({
      agentRunsRows: [
        {
          id: 111,
          userId: 18,
          campaignId: 42,
          agentType: "strategy",
          status: "completed",
          output: { creativeBriefFingerprint: "fp-current" },
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = campaignRouter.createCaller(buildCtx());
    const result = await caller.regenerateStrategyForApproval({ campaignId: 42 });

    expect(result.success).toBe(true);
    expect(result.reused).toBe(true);
    expect(result.strategyRunId).toBe(111);
    expect(result.approvalRequestId).toBe(1);
    expect(runStrategyAgent).not.toHaveBeenCalled();
    expect(createApprovalRequest).toHaveBeenCalledTimes(1);

    expect(db.state.deletedRows.length).toBe(0);
    const lineageUpdates = db.state.updatedCampaignStates.filter(
      (u: any) => u.workflowContext?.strategyApprovalLineage
    );
    expect(lineageUpdates.length).toBeGreaterThan(0);
    const last = lineageUpdates[lineageUpdates.length - 1];
    expect(last.workflowContext.strategyApprovalLineage.strategyRunId).toBe(111);
    expect(last.workflowContext.strategyApprovalLineage.creativeBriefFingerprint).toBe("fp-current");
  });

  it("supersedes older pending request when lineage does not match and creates one current request", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent } = await import("./lib/agents/strategy-agent");
    const { createApprovalRequest } = await import("./lib/workflow/engine");
    const { campaignRouter } = await import("./campaign-router");

    const db = createMockDb({
      agentRunsRows: [
        {
          id: 110,
          userId: 18,
          campaignId: 42,
          agentType: "strategy",
          status: "completed",
          output: { creativeBriefFingerprint: "fp-old" },
        },
      ],
      approvalRequestsRows: [
        {
          id: 33,
          userId: 18,
          campaignId: 42,
          approvalType: "strategy_review",
          status: "pending",
        },
      ],
      campaignOverrides: {
        workflowContext: {
          strategyApprovalLineage: {
            creativeBriefFingerprint: "fp-old",
            strategyRunId: 110,
            approvalRequestId: 33,
            status: "pending",
          },
        },
      },
    });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runStrategyAgent).mockResolvedValue({ runId: 999, output: {} } as any);

    const caller = campaignRouter.createCaller(buildCtx());
    const result = await caller.regenerateStrategyForApproval({ campaignId: 42 });

    expect(result.success).toBe(true);
    expect(result.strategyRunId).toBe(999);
    expect(result.approvalRequestId).toBe(1);
    expect(runStrategyAgent).toHaveBeenCalledTimes(1);
    expect(createApprovalRequest).toHaveBeenCalledTimes(1);

    // Historical pending request 33 is preserved as rejected evidence.
    const supersededUpdate = db.state.updatedApprovalRequests.find(
      (u: any) => u.status === "rejected"
    );
    expect(supersededUpdate).toBeTruthy();

    const lineageUpdates = db.state.updatedCampaignStates.filter(
      (u: any) => u.workflowContext?.strategyApprovalLineage
    );
    expect(lineageUpdates[lineageUpdates.length - 1].workflowContext.strategyApprovalLineage).toMatchObject({
      creativeBriefFingerprint: "fp-current",
      strategyRunId: 999,
      approvalRequestId: 1,
      status: "pending",
    });

    expect(db.state.deletedRows.some((d: any) => d.table === "agent_runs")).toBe(false);
  });

  it("reuses the pending strategy_review request when it is durably linked to the same fingerprint, run and request", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent } = await import("./lib/agents/strategy-agent");
    const { createApprovalRequest } = await import("./lib/workflow/engine");
    const { campaignRouter } = await import("./campaign-router");

    const db = createMockDb({
      agentRunsRows: [
        {
          id: 111,
          userId: 18,
          campaignId: 42,
          agentType: "strategy",
          status: "completed",
          output: { creativeBriefFingerprint: "fp-current" },
        },
      ],
      approvalRequestsRows: [
        {
          id: 33,
          userId: 18,
          campaignId: 42,
          approvalType: "strategy_review",
          status: "pending",
        },
      ],
      campaignOverrides: {
        workflowContext: {
          strategyApprovalLineage: {
            creativeBriefFingerprint: "fp-current",
            strategyRunId: 111,
            approvalRequestId: 33,
            status: "pending",
          },
        },
      },
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = campaignRouter.createCaller(buildCtx());
    const result = await caller.regenerateStrategyForApproval({ campaignId: 42 });

    expect(result.success).toBe(true);
    expect(result.reused).toBe(true);
    expect(result.strategyRunId).toBe(111);
    expect(result.approvalRequestId).toBe(33);
    expect(runStrategyAgent).not.toHaveBeenCalled();
    expect(createApprovalRequest).not.toHaveBeenCalled();
    expect(db.state.updatedApprovalRequests.length).toBe(0);
  });

  it("blocks concurrent regeneration attempts with the creative-generation claim", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent } = await import("./lib/agents/strategy-agent");
    const { acquireCreativeGenerationClaim } = await import("./lib/creative/creative-generation-claim");
    const { campaignRouter } = await import("./campaign-router");

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(acquireCreativeGenerationClaim).mockResolvedValueOnce({
      acquired: false,
      existingClaim: { id: 1002, operationReferenceId: null },
    } as any);

    const caller = campaignRouter.createCaller(buildCtx());
    await expect(caller.regenerateStrategyForApproval({ campaignId: 42 })).rejects.toBeInstanceOf(TRPCError);
    expect(runStrategyAgent).not.toHaveBeenCalled();
  });

  it("failed regeneration releases the claim as failed and creates no approval", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent } = await import("./lib/agents/strategy-agent");
    const { createApprovalRequest } = await import("./lib/workflow/engine");
    const { releaseClaimWithResult } = await import("./lib/creative/creative-generation-claim");
    const { campaignRouter } = await import("./campaign-router");

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runStrategyAgent).mockRejectedValue(new Error("strategy failed"));

    const caller = campaignRouter.createCaller(buildCtx());
    await expect(caller.regenerateStrategyForApproval({ campaignId: 42 })).rejects.toBeInstanceOf(TRPCError);

    expect(createApprovalRequest).not.toHaveBeenCalled();
    expect(releaseClaimWithResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" })
    );
    expect(db.state.deletedRows.some((d: any) => d.table === "agent_runs")).toBe(false);
  });

  it("attaches the strategy run ID to the claim before generation or validation can fail", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent, chargeForStrategyRun } = await import("./lib/agents/strategy-agent");
    const { createApprovalRequest } = await import("./lib/workflow/engine");
    const { attachCreativeGenerationOperationReference, releaseClaimWithResult } = await import(
      "./lib/creative/creative-generation-claim"
    );
    const { campaignRouter } = await import("./campaign-router");

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as any);

    let onRunCreatedCalled = false;
    vi.mocked(runStrategyAgent).mockImplementationOnce(async (args: any) => {
      expect(args.onRunCreated).toBeTypeOf("function");
      await args.onRunCreated(9001, { mockTx: true });
      onRunCreatedCalled = true;
      return {
        runId: 9001,
        output: {},
        promptTokens: 100,
        completionTokens: 50,
        actualCostUsdMicro: 0,
        estimatedCostUsdMicro: 0,
      } as any;
    });

    const caller = campaignRouter.createCaller(buildCtx());
    await caller.regenerateStrategyForApproval({ campaignId: 42 });

    expect(onRunCreatedCalled).toBe(true);
    expect(attachCreativeGenerationOperationReference).toHaveBeenCalledWith(
      expect.objectContaining({ operationReferenceId: 9001 })
    );
    expect(chargeForStrategyRun).toHaveBeenCalledTimes(1);
    expect(createApprovalRequest).toHaveBeenCalledTimes(1);
    expect(releaseClaimWithResult).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
  });

  it("retains operationReferenceId, marks run and claim failed, and charges nothing when semantic validation fails", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent, chargeForStrategyRun } = await import("./lib/agents/strategy-agent");
    const { createApprovalRequest } = await import("./lib/workflow/engine");
    const {
      attachCreativeGenerationOperationReference,
      releaseClaimWithResult,
    } = await import("./lib/creative/creative-generation-claim");
    const { campaignRouter } = await import("./campaign-router");

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as any);

    vi.mocked(runStrategyAgent).mockImplementationOnce(async (args: any) => {
      await args.onRunCreated(9001, { mockTx: true });
      throw new TRPCError({
        code: "UNPROCESSABLE_CONTENT",
        message: "Strategy output failed validation",
      });
    });

    const caller = campaignRouter.createCaller(buildCtx());
    await expect(caller.regenerateStrategyForApproval({ campaignId: 42 })).rejects.toBeInstanceOf(TRPCError);

    // The run ID was persisted to the claim before validation failed.
    expect(attachCreativeGenerationOperationReference).toHaveBeenCalledWith(
      expect.objectContaining({ operationReferenceId: 9001 })
    );

    // No billing, approval, or destructive side effects.
    expect(chargeForStrategyRun).not.toHaveBeenCalled();
    expect(createApprovalRequest).not.toHaveBeenCalled();
    expect(db.state.deletedRows.length).toBe(0);

    // Claim released as failed.
    expect(releaseClaimWithResult).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("retains operationReferenceId and charges nothing when claim attachment collides during strategy creation", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent, chargeForStrategyRun } = await import("./lib/agents/strategy-agent");
    const { createApprovalRequest } = await import("./lib/workflow/engine");
    const {
      attachCreativeGenerationOperationReference,
      releaseClaimWithResult,
    } = await import("./lib/creative/creative-generation-claim");
    const { campaignRouter } = await import("./campaign-router");

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(attachCreativeGenerationOperationReference).mockResolvedValueOnce({
      attached: false,
      existingClaim: { id: 1002 },
    } as any);

    vi.mocked(runStrategyAgent).mockImplementationOnce(async (args: any) => {
      await args.onRunCreated(9001, { mockTx: true });
      return { runId: 9001 } as any;
    });

    const caller = campaignRouter.createCaller(buildCtx());
    await expect(caller.regenerateStrategyForApproval({ campaignId: 42 })).rejects.toBeInstanceOf(TRPCError);

    expect(attachCreativeGenerationOperationReference).toHaveBeenCalledWith(
      expect.objectContaining({ operationReferenceId: 9001 })
    );
    expect(chargeForStrategyRun).not.toHaveBeenCalled();
    expect(createApprovalRequest).not.toHaveBeenCalled();
    expect(releaseClaimWithResult).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("rejects when campaign is not linked to a business", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent } = await import("./lib/agents/strategy-agent");
    const { campaignRouter } = await import("./campaign-router");

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(db.select).mockImplementation(() => ({
      from: vi.fn((table: unknown) => {
        const result =
          getTableName(table) === "campaigns"
            ? [{ id: 42, userId: 18, businessId: null, workflowState: "strategy_approved" }]
            : [];
        return {
          where: vi.fn(() => makeQueryable(result)),
        };
      }),
    }) as any);

    const caller = campaignRouter.createCaller(buildCtx());
    await expect(caller.regenerateStrategyForApproval({ campaignId: 42 })).rejects.toBeInstanceOf(TRPCError);
    expect(runStrategyAgent).not.toHaveBeenCalled();
  });

  it("charges exactly 3 credits once after a new validated strategy run", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent, chargeForStrategyRun } = await import("./lib/agents/strategy-agent");
    const { campaignRouter } = await import("./campaign-router");

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runStrategyAgent).mockResolvedValue({
      runId: 999,
      output: {},
      promptTokens: 100,
      completionTokens: 50,
      actualCostUsdMicro: 0,
      estimatedCostUsdMicro: 0,
    } as any);

    const caller = campaignRouter.createCaller(buildCtx());
    await caller.regenerateStrategyForApproval({ campaignId: 42 });

    expect(chargeForStrategyRun).toHaveBeenCalledTimes(1);
    expect(chargeForStrategyRun).toHaveBeenCalledWith(
      18,
      42,
      expect.objectContaining({ runId: 999 })
    );
  });

  it("does not charge when reusing an existing completed strategy run", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent, chargeForStrategyRun } = await import("./lib/agents/strategy-agent");
    const { campaignRouter } = await import("./campaign-router");

    const db = createMockDb({
      agentRunsRows: [
        {
          id: 111,
          userId: 18,
          campaignId: 42,
          agentType: "strategy",
          status: "completed",
          output: { creativeBriefFingerprint: "fp-current" },
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = campaignRouter.createCaller(buildCtx());
    const result = await caller.regenerateStrategyForApproval({ campaignId: 42 });

    expect(result.reused).toBe(true);
    expect(runStrategyAgent).not.toHaveBeenCalled();
    expect(chargeForStrategyRun).not.toHaveBeenCalled();
  });

  it("does not charge when strategy validation fails", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent, chargeForStrategyRun } = await import("./lib/agents/strategy-agent");
    const { campaignRouter } = await import("./campaign-router");

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runStrategyAgent).mockRejectedValue(
      new TRPCError({ code: "UNPROCESSABLE_CONTENT", message: "Strategy output failed validation" })
    );

    const caller = campaignRouter.createCaller(buildCtx());
    await expect(caller.regenerateStrategyForApproval({ campaignId: 42 })).rejects.toBeInstanceOf(TRPCError);

    expect(chargeForStrategyRun).not.toHaveBeenCalled();
  });

  it("attaches the new strategy run ID to the claim", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent } = await import("./lib/agents/strategy-agent");
    const { attachCreativeGenerationOperationReference } = await import("./lib/creative/creative-generation-claim");
    const { campaignRouter } = await import("./campaign-router");

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runStrategyAgent).mockImplementationOnce(async (args: any) => {
      await args.onRunCreated(999);
      return {
        runId: 999,
        output: {},
        promptTokens: 100,
        completionTokens: 50,
        actualCostUsdMicro: 0,
        estimatedCostUsdMicro: 0,
      } as any;
    });

    const caller = campaignRouter.createCaller(buildCtx());
    await caller.regenerateStrategyForApproval({ campaignId: 42 });

    expect(attachCreativeGenerationOperationReference).toHaveBeenCalledWith(
      expect.objectContaining({ operationReferenceId: 999 })
    );
  });

  it("creates no approval and charges nothing when claim attachment fails", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent, chargeForStrategyRun } = await import("./lib/agents/strategy-agent");
    const { createApprovalRequest } = await import("./lib/workflow/engine");
    const { attachCreativeGenerationOperationReference, releaseClaimWithResult } = await import(
      "./lib/creative/creative-generation-claim"
    );
    const { campaignRouter } = await import("./campaign-router");

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(attachCreativeGenerationOperationReference).mockResolvedValueOnce({
      attached: false,
      existingClaim: { id: 1002 },
    } as any);
    vi.mocked(runStrategyAgent).mockImplementationOnce(async (args: any) => {
      await args.onRunCreated(999);
      return {
        runId: 999,
        output: {},
        promptTokens: 100,
        completionTokens: 50,
        actualCostUsdMicro: 0,
        estimatedCostUsdMicro: 0,
      } as any;
    });

    const caller = campaignRouter.createCaller(buildCtx());
    await expect(caller.regenerateStrategyForApproval({ campaignId: 42 })).rejects.toBeInstanceOf(TRPCError);

    expect(chargeForStrategyRun).not.toHaveBeenCalled();
    expect(createApprovalRequest).not.toHaveBeenCalled();
    expect(releaseClaimWithResult).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("keeps the completed-run charge and does not refund when approval creation fails", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent, chargeForStrategyRun } = await import("./lib/agents/strategy-agent");
    const { createApprovalRequest } = await import("./lib/workflow/engine");
    const { refundCredits } = await import("./lib/billing/credit-engine");
    const { releaseClaimWithResult } = await import("./lib/creative/creative-generation-claim");
    const { campaignRouter } = await import("./campaign-router");

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runStrategyAgent).mockResolvedValue({
      runId: 999,
      output: {},
      promptTokens: 100,
      completionTokens: 50,
      actualCostUsdMicro: 0,
      estimatedCostUsdMicro: 0,
    } as any);
    vi.mocked(createApprovalRequest).mockRejectedValueOnce(new Error("approval db error"));

    const caller = campaignRouter.createCaller(buildCtx());
    await expect(caller.regenerateStrategyForApproval({ campaignId: 42 })).rejects.toBeInstanceOf(TRPCError);

    expect(chargeForStrategyRun).toHaveBeenCalledTimes(1);

    // The strategy service was successfully delivered; approval failure is not a
    // valid reason to refund the charge.
    expect(refundCredits).not.toHaveBeenCalled();

    const lineageUpdates = db.state.updatedCampaignStates.filter(
      (u: any) => u.workflowContext?.strategyApprovalLineage
    );
    expect(lineageUpdates.length).toBe(0);
    expect(releaseClaimWithResult).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("does not charge twice on duplicate retry that reuses the run and matching request", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent, chargeForStrategyRun } = await import("./lib/agents/strategy-agent");
    const { createApprovalRequest } = await import("./lib/workflow/engine");
    const { campaignRouter } = await import("./campaign-router");

    const db = createMockDb({
      agentRunsRows: [
        {
          id: 111,
          userId: 18,
          campaignId: 42,
          agentType: "strategy",
          status: "completed",
          output: { creativeBriefFingerprint: "fp-current" },
        },
      ],
      approvalRequestsRows: [
        {
          id: 33,
          userId: 18,
          campaignId: 42,
          approvalType: "strategy_review",
          status: "pending",
        },
      ],
      campaignOverrides: {
        workflowContext: {
          strategyApprovalLineage: {
            creativeBriefFingerprint: "fp-current",
            strategyRunId: 111,
            approvalRequestId: 33,
            status: "pending",
          },
        },
      },
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = campaignRouter.createCaller(buildCtx());
    const result = await caller.regenerateStrategyForApproval({ campaignId: 42 });

    expect(result.success).toBe(true);
    expect(result.reused).toBe(true);
    expect(result.approvalRequestId).toBe(33);
    expect(runStrategyAgent).not.toHaveBeenCalled();
    expect(chargeForStrategyRun).not.toHaveBeenCalled();
    expect(createApprovalRequest).not.toHaveBeenCalled();
  });

  it("does not reuse a completed strategy run whose fingerprint matches but output is semantically invalid", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent, chargeForStrategyRun, validateStrategyOutputAgainstCampaign } = await import(
      "./lib/agents/strategy-agent"
    );
    const { createApprovalRequest } = await import("./lib/workflow/engine");
    const { campaignRouter } = await import("./campaign-router");

    vi.mocked(validateStrategyOutputAgainstCampaign).mockImplementation((output: any) => {
      if (output?.__invalid) {
        return { valid: false, reason: "Strategy output contains stale audience classification: small businesses." };
      }
      return { valid: true };
    });

    const db = createMockDb({
      agentRunsRows: [
        {
          id: 245,
          userId: 18,
          campaignId: 42,
          agentType: "strategy",
          status: "completed",
          output: {
            creativeBriefFingerprint: "fp-current",
            __invalid: true,
            coreMessage: "Payroll and employee payouts made easy for small businesses.",
          },
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runStrategyAgent).mockResolvedValue({
      runId: 9001,
      output: {},
      promptTokens: 100,
      completionTokens: 50,
      actualCostUsdMicro: 0,
      estimatedCostUsdMicro: 0,
    } as any);

    const caller = campaignRouter.createCaller(buildCtx());
    const result = await caller.regenerateStrategyForApproval({ campaignId: 42 });

    expect(result.success).toBe(true);
    expect(result.reused).toBe(false);
    expect(result.strategyRunId).toBe(9001);
    expect(runStrategyAgent).toHaveBeenCalledTimes(1);
    expect(chargeForStrategyRun).toHaveBeenCalledTimes(1);
    expect(chargeForStrategyRun).toHaveBeenCalledWith(18, 42, expect.objectContaining({ runId: 9001 }));

    // Historical run 245 is preserved; no charge is made for it.
    expect(db.state.deletedRows.some((d: any) => d.table === "agent_runs")).toBe(false);

    // A new pending approval is created for the new valid run.
    expect(createApprovalRequest).toHaveBeenCalledTimes(1);
    const lastLineage = db.state.updatedCampaignStates
      .filter((u: any) => u.workflowContext?.strategyApprovalLineage)
      .pop();
    expect(lastLineage.workflowContext.strategyApprovalLineage).toMatchObject({
      creativeBriefFingerprint: "fp-current",
      strategyRunId: 9001,
      approvalRequestId: 1,
      status: "pending",
    });
  });

  it("supersedes a pending approval linked to a semantically invalid run and creates one current request", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent, chargeForStrategyRun, validateStrategyOutputAgainstCampaign } = await import(
      "./lib/agents/strategy-agent"
    );
    const { createApprovalRequest } = await import("./lib/workflow/engine");
    const { campaignRouter } = await import("./campaign-router");

    vi.mocked(validateStrategyOutputAgainstCampaign).mockImplementation((output: any) => {
      if (output?.__invalid) {
        return { valid: false, reason: "Strategy output contains stale audience classification: small businesses." };
      }
      return { valid: true };
    });

    const db = createMockDb({
      agentRunsRows: [
        {
          id: 34,
          userId: 18,
          campaignId: 42,
          agentType: "strategy",
          status: "completed",
          output: {
            creativeBriefFingerprint: "fp-current",
            __invalid: true,
            coreMessage: "Payroll and employee payouts made easy for small businesses.",
          },
        },
      ],
      approvalRequestsRows: [
        {
          id: 34,
          userId: 18,
          campaignId: 42,
          approvalType: "strategy_review",
          status: "pending",
        },
      ],
      campaignOverrides: {
        workflowContext: {
          strategyApprovalLineage: {
            creativeBriefFingerprint: "fp-current",
            strategyRunId: 34,
            approvalRequestId: 34,
            status: "pending",
          },
        },
      },
    });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runStrategyAgent).mockResolvedValue({
      runId: 9001,
      output: {},
      promptTokens: 100,
      completionTokens: 50,
      actualCostUsdMicro: 0,
      estimatedCostUsdMicro: 0,
    } as any);

    const caller = campaignRouter.createCaller(buildCtx());
    const result = await caller.regenerateStrategyForApproval({ campaignId: 42 });

    expect(result.success).toBe(true);
    expect(result.reused).toBe(false);
    expect(result.strategyRunId).toBe(9001);
    expect(runStrategyAgent).toHaveBeenCalledTimes(1);

    // Approval 34 is preserved as rejected/superseded evidence, not deleted.
    const supersededUpdate = db.state.updatedApprovalRequests.find((u: any) => u.status === "rejected");
    expect(supersededUpdate).toBeTruthy();
    expect(db.state.deletedRows.some((d: any) => d.table === "approval_requests")).toBe(false);

    // A new pending approval is created for the current valid run.
    expect(createApprovalRequest).toHaveBeenCalledTimes(1);
    const lastLineage = db.state.updatedCampaignStates
      .filter((u: any) => u.workflowContext?.strategyApprovalLineage)
      .pop();
    expect(lastLineage.workflowContext.strategyApprovalLineage).toMatchObject({
      creativeBriefFingerprint: "fp-current",
      strategyRunId: 9001,
      approvalRequestId: 1,
      status: "pending",
    });
  });

  it("does not charge for an invalid reusable run when it creates a new valid run", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent, chargeForStrategyRun, validateStrategyOutputAgainstCampaign } = await import(
      "./lib/agents/strategy-agent"
    );
    const { campaignRouter } = await import("./campaign-router");

    vi.mocked(validateStrategyOutputAgainstCampaign).mockImplementation((output: any) => {
      if (output?.__invalid) return { valid: false, reason: "stale" };
      return { valid: true };
    });

    const db = createMockDb({
      agentRunsRows: [
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
    vi.mocked(runStrategyAgent).mockResolvedValue({
      runId: 9001,
      output: {},
      promptTokens: 100,
      completionTokens: 50,
      actualCostUsdMicro: 0,
      estimatedCostUsdMicro: 0,
    } as any);

    await campaignRouter.createCaller(buildCtx()).regenerateStrategyForApproval({ campaignId: 42 });

    // Only the new valid run is charged; the invalid reusable run 245 is ignored.
    expect(chargeForStrategyRun).toHaveBeenCalledTimes(1);
    expect(chargeForStrategyRun).toHaveBeenCalledWith(18, 42, expect.objectContaining({ runId: 9001 }));
  });
});
describe("campaignRouter.strategyApprovalStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks a fingerprint-matching but semantically invalid run as stale", async () => {
    const { getDb } = await import("./queries/connection");
    const { validateStrategyOutputAgainstCampaign } = await import("./lib/agents/strategy-agent");
    const { campaignRouter } = await import("./campaign-router");

    vi.mocked(validateStrategyOutputAgainstCampaign).mockImplementation((output: any) => {
      if (output?.__invalid) {
        return { valid: false, reason: "Strategy output contains stale audience classification: small businesses." };
      }
      return { valid: true };
    });

    const db = createMockDb({
      agentRunsRows: [
        {
          id: 245,
          userId: 18,
          campaignId: 42,
          agentType: "strategy",
          status: "completed",
          output: { creativeBriefFingerprint: "fp-current", __invalid: true },
        },
      ],
      campaignOverrides: {
        workflowState: "audience_ready",
        workflowContext: {
          approvedStrategyFingerprint: "fp-current",
          strategyApprovalLineage: {
            creativeBriefFingerprint: "fp-current",
            strategyRunId: 245,
            approvalRequestId: 34,
            status: "pending",
          },
        },
      },
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = campaignRouter.createCaller(buildCtx());
    const status = await caller.strategyApprovalStatus({ id: 42 });

    expect(status.isApprovedStrategyCurrent).toBe(false);
    expect(status.isStale).toBe(true);
    expect(status.reason).toContain("stale audience classification");
    expect(status.currentFingerprint).toBe("fp-current");
  });

  it("reports a valid approved strategy as current and not stale", async () => {
    const { getDb } = await import("./queries/connection");
    const { campaignRouter } = await import("./campaign-router");

    const db = createMockDb({
      agentRunsRows: [
        {
          id: 111,
          userId: 18,
          campaignId: 42,
          agentType: "strategy",
          status: "completed",
          output: { creativeBriefFingerprint: "fp-current" },
        },
      ],
      campaignOverrides: {
        workflowState: "strategy_approved",
        workflowContext: {
          approvedStrategyFingerprint: "fp-current",
          strategyApprovalLineage: {
            creativeBriefFingerprint: "fp-current",
            strategyRunId: 111,
            approvalRequestId: 33,
            status: "approved",
          },
        },
      },
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = campaignRouter.createCaller(buildCtx());
    const status = await caller.strategyApprovalStatus({ id: 42 });

    expect(status.isApprovedStrategyCurrent).toBe(true);
    expect(status.isStale).toBe(false);
    expect(status.reason).toBeUndefined();
    expect(status.current).toBe(true);
    expect(status.approved).toBe(true);
    expect(status.canGenerateContent).toBe(true);
    expect(status.canRegenerateStrategy).toBe(false);
  });

  it("Campaign #30: pending strategy with fingerprint-matching but semantically invalid run is stale and cannot generate content", async () => {
    const { getDb } = await import("./queries/connection");
    const { validateStrategyOutputAgainstCampaign } = await import("./lib/agents/strategy-agent");
    const { campaignRouter } = await import("./campaign-router");

    vi.mocked(validateStrategyOutputAgainstCampaign).mockImplementation((output: any) => {
      if (output?.campaignId === 30) {
        return { valid: false, reason: "Strategy output contains stale audience classification: small businesses." };
      }
      return { valid: true };
    });

    const db = createMockDb({
      agentRunsRows: [
        {
          id: 245,
          userId: 18,
          campaignId: 30,
          agentType: "strategy",
          status: "completed",
          output: { creativeBriefFingerprint: "fp-current", campaignId: 30 },
        },
      ],
      campaignOverrides: {
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
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = campaignRouter.createCaller(buildCtx());
    const status = await caller.strategyApprovalStatus({ id: 30 });

    expect(status.current).toBe(false);
    expect(status.approved).toBe(false);
    expect(status.stale).toBe(true);
    expect(status.isStale).toBe(true);
    expect(status.canGenerateContent).toBe(false);
    expect(status.canRegenerateStrategy).toBe(true);
    expect(status.reason).toContain("stale audience classification");
  });
});



describe("campaignRouter strategy entry-point lifecycle (Phase 2B integration)", () => {
  const validFlatOutput = {
    creativeBriefFingerprint: "fp-current",
    coreMessage: "service",
    positioning: "service",
    valueProposition: "service",
    campaignTheme: "theme",
    personas: [
      {
        name: "Buyer",
        demographics: "buyer",
        painPoints: ["pain"],
        goals: ["goal"],
        platforms: ["LinkedIn"],
      },
    ],
    ctas: [{ stage: "awareness", cta: "cta", placement: "ad" }],
    offers: [],
    budgetRecommendation: { total: 0, allocation: [] },
  };

  const failureEnvelope = {
    evidenceVersion: 1,
    outcome: "failed_validation",
    creativeBriefFingerprint: "fp-current",
    rawOutput: validFlatOutput,
    groundedOutput: validFlatOutput,
    validationDiagnostics: [],
  };

  function flushMicrotasks(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("create does not reuse a failed-validation envelope and starts a new strategy run", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent } = await import("./lib/agents/strategy-agent");
    const { onAgentRunComplete } = await import("./lib/workflow/triggers");
    const { campaignRouter } = await import("./campaign-router");

    const db = createMockDb({
      agentRunsRows: [
        {
          id: 247,
          userId: 18,
          campaignId: 42,
          agentType: "strategy",
          status: "completed",
          output: failureEnvelope,
        },
      ],
      businessOverrides: {
        onboardingComplete: true,
        websiteEvidence: { confidence: 0.8 },
      },
    });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runStrategyAgent).mockResolvedValue({ runId: 248, output: validFlatOutput } as any);

    const caller = campaignRouter.createCaller(buildOnboardedCtx());
    await caller.create({
      name: "Test",
      goal: "Grow",
      businessId: 7,
      productOrService: "service",
      targetBuyer: "buyer",
      mainPainPoint: "pain",
    });

    await flushMicrotasks();

    expect(runStrategyAgent).toHaveBeenCalledTimes(1);
    expect(onAgentRunComplete).not.toHaveBeenCalledWith(247);
  });

  it("create reuses a valid completed flat strategy run and advances the workflow", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent } = await import("./lib/agents/strategy-agent");
    const { onAgentRunComplete } = await import("./lib/workflow/triggers");
    const { campaignRouter } = await import("./campaign-router");

    const db = createMockDb({
      agentRunsRows: [
        {
          id: 111,
          userId: 18,
          campaignId: 42,
          agentType: "strategy",
          status: "completed",
          output: validFlatOutput,
        },
      ],
      businessOverrides: {
        onboardingComplete: true,
        websiteEvidence: { confidence: 0.8 },
      },
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = campaignRouter.createCaller(buildOnboardedCtx());
    await caller.create({
      name: "Test",
      goal: "Grow",
      businessId: 7,
      productOrService: "service",
      targetBuyer: "buyer",
      mainPainPoint: "pain",
    });

    await flushMicrotasks();

    expect(runStrategyAgent).not.toHaveBeenCalled();
    expect(onAgentRunComplete).toHaveBeenCalledWith(111);
  });

  it("create does not reuse a completed strategy run grounded with stale fallback channels", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent } = await import("./lib/agents/strategy-agent");
    const { onAgentRunComplete } = await import("./lib/workflow/triggers");
    const { buildGroundedCreativeBrief } = await import("./lib/creative/brief-grounding");
    const { campaignRouter } = await import("./campaign-router");

    const db = createMockDb({
      agentRunsRows: [
        {
          id: 111,
          userId: 18,
          campaignId: 42,
          agentType: "strategy",
          status: "completed",
          output: { ...validFlatOutput, creativeBriefFingerprint: "fp-old-linkedin" },
        },
      ],
      businessOverrides: {
        onboardingComplete: true,
        websiteEvidence: { confidence: 0.8 },
      },
    });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runStrategyAgent).mockResolvedValue({ runId: 248, output: validFlatOutput } as any);

    // Simulate the business-profile fallback channels changing after the old
    // strategy run was produced. The fingerprint changes, so the stale run must
    // not be reused.
    vi.mocked(buildGroundedCreativeBrief).mockReturnValue({
      fingerprint: "fp-new-email",
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
    } as any);

    const caller = campaignRouter.createCaller(buildOnboardedCtx());
    await caller.create({
      name: "Test",
      goal: "Grow",
      businessId: 7,
      productOrService: "service",
      targetBuyer: "buyer",
      mainPainPoint: "pain",
      platforms: "Email",
      preferredCta: "Book a Demo",
    });

    await flushMicrotasks();

    expect(runStrategyAgent).toHaveBeenCalledTimes(1);
    expect(onAgentRunComplete).not.toHaveBeenCalledWith(111);
  });

  it("regenerateStrategyForApproval does not reuse a failure-envelope completed run", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent, chargeForStrategyRun } = await import("./lib/agents/strategy-agent");
    const { createApprovalRequest } = await import("./lib/workflow/engine");
    const { releaseClaimWithResult } = await import("./lib/creative/creative-generation-claim");
    const { campaignRouter } = await import("./campaign-router");

    const db = createMockDb({
      agentRunsRows: [
        {
          id: 249,
          userId: 18,
          campaignId: 42,
          agentType: "strategy",
          status: "completed",
          output: failureEnvelope,
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runStrategyAgent).mockResolvedValue({ runId: 250, output: validFlatOutput } as any);

    const caller = campaignRouter.createCaller(buildCtx());
    await caller.regenerateStrategyForApproval({ campaignId: 42 });

    expect(runStrategyAgent).toHaveBeenCalledTimes(1);
    expect(createApprovalRequest).toHaveBeenCalledTimes(1);
    expect(chargeForStrategyRun).toHaveBeenCalledTimes(1);
    expect(chargeForStrategyRun).toHaveBeenCalledWith(18, 42, expect.objectContaining({ runId: 250 }));
    expect(releaseClaimWithResult).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
  });

  it("regenerateStrategyForApproval charges exactly once and creates one approval for a new valid run", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent, chargeForStrategyRun } = await import("./lib/agents/strategy-agent");
    const { createApprovalRequest } = await import("./lib/workflow/engine");
    const { releaseClaimWithResult } = await import("./lib/creative/creative-generation-claim");
    const { campaignRouter } = await import("./campaign-router");

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runStrategyAgent).mockResolvedValue({
      runId: 9001,
      output: validFlatOutput,
      promptTokens: 100,
      completionTokens: 50,
      actualCostUsdMicro: 0,
      estimatedCostUsdMicro: 0,
    } as any);

    const caller = campaignRouter.createCaller(buildCtx());
    const result = await caller.regenerateStrategyForApproval({ campaignId: 42 });

    expect(result.success).toBe(true);
    expect(result.strategyRunId).toBe(9001);
    expect(result.reused).toBe(false);
    expect(chargeForStrategyRun).toHaveBeenCalledTimes(1);
    expect(createApprovalRequest).toHaveBeenCalledTimes(1);
    expect(releaseClaimWithResult).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
  });
});

describe("Phase 4 — pre-generation readiness gate at router entry points", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { validateStrategyReadiness } = await import("./lib/agents/strategy-agent");
    vi.mocked(validateStrategyReadiness).mockReset().mockReturnValue({ ready: true });
  });

  const validFlatOutput = {
    creativeBriefFingerprint: "fp-current",
    coreMessage: "service",
    positioning: "service",
    valueProposition: "service",
    campaignTheme: "theme",
    personas: [
      {
        name: "Buyer",
        demographics: "buyer",
        painPoints: ["pain"],
        goals: ["goal"],
        platforms: ["LinkedIn"],
      },
    ],
    ctas: [{ stage: "awareness", cta: "cta", placement: "ad" }],
    offers: [],
    funnelStages: [],
    platformStrategy: [],
    budgetRecommendation: { total: 0, allocation: [] },
  };

  const readinessChannelFailure = {
    ready: false as const,
    code: "PRECONDITION_FAILED" as const,
    gate: "authorised_channels",
    field: "preferredChannels",
    message: "Select at least one campaign channel before regenerating the strategy.",
    userMessage:
      "No campaign channel has been selected. Add at least one channel to the campaign brief before regenerating the strategy.",
  };

  function flushMicrotasks(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
  }

  it("regenerateFromProfile fails fast with PRECONDITION_FAILED when no authorised channel is available", async () => {
    const { getDb } = await import("./queries/connection");
    const {
      runStrategyAgent,
      chargeForStrategyRun,
      validateStrategyReadiness,
    } = await import("./lib/agents/strategy-agent");
    const { runCreativeAgent } = await import("./lib/agents/creative-agent");
    const { createApprovalRequest } = await import("./lib/workflow/engine");
    const { acquireCreativeGenerationClaim, releaseClaimWithResult } = await import(
      "./lib/creative/creative-generation-claim"
    );
    const { campaignRouter } = await import("./campaign-router");

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(validateStrategyReadiness).mockReturnValue(readinessChannelFailure);

    const caller = campaignRouter.createCaller(buildCtx());
    await expect(caller.regenerateFromProfile({ campaignId: 42 })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: readinessChannelFailure.userMessage,
    });

    expect(validateStrategyReadiness).toHaveBeenCalled();
    expect(acquireCreativeGenerationClaim).not.toHaveBeenCalled();
    expect(runStrategyAgent).not.toHaveBeenCalled();
    expect(chargeForStrategyRun).not.toHaveBeenCalled();
    expect(createApprovalRequest).not.toHaveBeenCalled();
    expect(runCreativeAgent).not.toHaveBeenCalled();
    expect(releaseClaimWithResult).not.toHaveBeenCalled();
    expect(db.state.insertedRows.length).toBe(0);
    expect(db.state.updatedAgentRuns.length).toBe(0);
  });

  it("regenerateStrategyForApproval fails fast with PRECONDITION_FAILED when no authorised channel is available", async () => {
    const { getDb } = await import("./queries/connection");
    const {
      runStrategyAgent,
      chargeForStrategyRun,
      validateStrategyReadiness,
    } = await import("./lib/agents/strategy-agent");
    const { createApprovalRequest } = await import("./lib/workflow/engine");
    const { acquireCreativeGenerationClaim, releaseClaimWithResult } = await import(
      "./lib/creative/creative-generation-claim"
    );
    const { campaignRouter } = await import("./campaign-router");

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(validateStrategyReadiness).mockReturnValue(readinessChannelFailure);

    const caller = campaignRouter.createCaller(buildCtx());
    await expect(caller.regenerateStrategyForApproval({ campaignId: 42 })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: readinessChannelFailure.userMessage,
    });

    expect(validateStrategyReadiness).toHaveBeenCalled();
    expect(acquireCreativeGenerationClaim).not.toHaveBeenCalled();
    expect(runStrategyAgent).not.toHaveBeenCalled();
    expect(chargeForStrategyRun).not.toHaveBeenCalled();
    expect(createApprovalRequest).not.toHaveBeenCalled();
    expect(releaseClaimWithResult).not.toHaveBeenCalled();
    expect(db.state.updatedAgentRuns.length).toBe(0);
  });

  it("create returns a structured readiness block and does not auto-start when the brief has no authorised channel", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent, validateStrategyReadiness } = await import("./lib/agents/strategy-agent");
    const { onAgentRunComplete } = await import("./lib/workflow/triggers");
    const { campaignRouter } = await import("./campaign-router");

    const db = createMockDb({
      businessOverrides: {
        onboardingComplete: true,
        websiteEvidence: { confidence: 0.8 },
      },
    });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(validateStrategyReadiness).mockReturnValue(readinessChannelFailure);

    const caller = campaignRouter.createCaller(buildOnboardedCtx());
    const result = await caller.create({
      name: "Test",
      goal: "Grow",
      businessId: 7,
      productOrService: "service",
      targetBuyer: "buyer",
      mainPainPoint: "pain",
    });

    await flushMicrotasks();

    expect(result.success).toBe(true);
    expect(result.workflowState).toBe("strategy_pending");
    expect(result.readiness).toEqual(readinessChannelFailure);
    expect(validateStrategyReadiness).toHaveBeenCalled();
    expect(runStrategyAgent).not.toHaveBeenCalled();
    expect(onAgentRunComplete).not.toHaveBeenCalled();
  });

  it("create auto-starts strategy when the brief has all required authoritative inputs", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent, validateStrategyReadiness } = await import("./lib/agents/strategy-agent");
    const { onAgentRunComplete } = await import("./lib/workflow/triggers");
    const { campaignRouter } = await import("./campaign-router");

    const db = createMockDb({
      businessOverrides: {
        onboardingComplete: true,
        websiteEvidence: { confidence: 0.8 },
      },
    });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runStrategyAgent).mockResolvedValue({ runId: 248, output: validFlatOutput } as any);

    const caller = campaignRouter.createCaller(buildOnboardedCtx());
    await caller.create({
      name: "Test",
      goal: "Grow",
      businessId: 7,
      productOrService: "service",
      targetBuyer: "buyer",
      mainPainPoint: "pain",
      platforms: "LinkedIn",
      preferredCta: "Book a Demo",
    });

    await flushMicrotasks();

    expect(validateStrategyReadiness).toHaveBeenCalled();
    expect(runStrategyAgent).toHaveBeenCalledTimes(1);
    expect(onAgentRunComplete).toHaveBeenCalledWith(248);
  });

  it("after create returns a readiness block, a later strategy regeneration on the same campaign succeeds once the brief is completed", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent, validateStrategyReadiness } = await import("./lib/agents/strategy-agent");
    const { createApprovalRequest } = await import("./lib/workflow/engine");
    const { acquireCreativeGenerationClaim } = await import("./lib/creative/creative-generation-claim");
    const { campaignRouter } = await import("./campaign-router");

    let readinessResponse: any = readinessChannelFailure;
    vi.mocked(validateStrategyReadiness).mockImplementation(() => readinessResponse);

    const createDb = createMockDb({
      businessOverrides: {
        onboardingComplete: true,
        websiteEvidence: { confidence: 0.8 },
      },
    });
    vi.mocked(getDb).mockReturnValue(createDb as any);

    const caller = campaignRouter.createCaller(buildOnboardedCtx());
    const result = await caller.create({
      name: "Test",
      goal: "Grow",
      businessId: 7,
      productOrService: "service",
      targetBuyer: "buyer",
      mainPainPoint: "pain",
    });

    await flushMicrotasks();

    expect(result.success).toBe(true);
    expect(result.readiness).toEqual(readinessChannelFailure);
    expect(runStrategyAgent).not.toHaveBeenCalled();

    // Simulate the user completing the brief: channels and CTA are now present.
    readinessResponse = { ready: true };
    vi.mocked(runStrategyAgent).mockResolvedValue({ runId: 248, output: validFlatOutput } as any);

    const retryDb = createMockDb({
      campaignOverrides: {
        workflowState: "strategy_pending",
        platforms: "LinkedIn",
        preferredCta: "Book a Demo",
        productOrService: "service",
        targetBuyer: "buyer",
        mainPainPoint: "pain",
      },
      businessOverrides: {
        onboardingComplete: true,
        websiteEvidence: { confidence: 0.8 },
      },
    });
    vi.mocked(getDb).mockReturnValue(retryDb as any);

    await caller.regenerateStrategyForApproval({ campaignId: 42 });

    expect(validateStrategyReadiness).toHaveBeenCalled();
    expect(acquireCreativeGenerationClaim).toHaveBeenCalled();
    expect(runStrategyAgent).toHaveBeenCalledTimes(1);
    expect(createApprovalRequest).toHaveBeenCalled();
  });
});
