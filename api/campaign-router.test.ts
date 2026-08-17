import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
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
} = {}) {
  const state = {
    updatedCampaignStates: [] as any[],
    updatedApprovalRequests: [] as any[],
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

describe("campaignRouter.regenerateFromProfile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes source=profile with the strategy run id to runCreativeAgent", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent } = await import("./lib/agents/strategy-agent");
    const { runCreativeAgent } = await import("./lib/agents/creative-agent");
    const { campaignRouter } = await import("./campaign-router");

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runStrategyAgent).mockResolvedValue({
      runId: 456,
      output: { strategy: "test" },
    } as any);
    vi.mocked(runCreativeAgent).mockResolvedValue({
      packRunId: 789,
      savedPosts: 3,
      savedAssets: 1,
      pack: null,
      assets: null,
      metrics: {},
    } as any);

    const caller = campaignRouter.createCaller(buildCtx());
    const result = await caller.regenerateFromProfile({ campaignId: 42 });

    expect(result.success).toBe(true);
    expect(result.strategyRunId).toBe(456);
    expect(result.creativeRunId).toBe(789);

    expect(runCreativeAgent).toHaveBeenCalledTimes(1);
    expect(runCreativeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 18,
        campaignId: 42,
        deleteExistingDrafts: false,
        generationOperation: { source: "profile", id: 456 },
      })
    );
  });

  it("returns TRPCError when campaign is not linked to a business", async () => {
    const { getDb } = await import("./queries/connection");
    const { runCreativeAgent } = await import("./lib/agents/creative-agent");
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
    expect(runCreativeAgent).not.toHaveBeenCalled();
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
});
