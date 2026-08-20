import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";
import { attachCreativeGenerationOperationReference, acquireCreativeGenerationClaim, releaseClaimWithResult } from "./lib/creative/creative-generation-claim";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("./lib/rate-limiter", () => ({
  rateLimitUser: vi.fn().mockResolvedValue(undefined),
  rateLimitPublic: vi.fn().mockResolvedValue(undefined),
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, limit: 100, remaining: 99, resetAt: Date.now() + 60 * 60 * 1000 }),
  clearRateLimitStateForTests: vi.fn(),
}));

vi.mock("./lib/agents/creative-agent", () => ({
  runCreativeAgent: vi.fn(),
}));

vi.mock("./lib/agents/strategy-agent", async () => {
  const actual = await vi.importActual<typeof import("./lib/agents/strategy-agent")>(
    "./lib/agents/strategy-agent"
  );
  return {
    ...actual,
    runStrategyAgent: vi.fn(),
    chargeForStrategyRun: vi.fn(),
  };
});

vi.mock("./lib/workflow/strategy-approval", () => ({
  assertApprovedStrategySemanticallyValid: vi.fn(async () => undefined),
  getStrategyApprovalStatus: vi.fn(() => ({
    currentFingerprint: "test-fingerprint",
    strategyFingerprint: "test-fingerprint",
    approvedStrategyFingerprint: "test-fingerprint",
    isCurrent: true,
    hasApprovedStrategy: true,
    strategyGeneratedForCurrentBrief: true,
    lineage: null,
  })),
}));

vi.mock("./lib/workflow/engine", () => ({
  transitionCampaignState: vi.fn(async () => "creatives_generating"),
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

interface MockDbState {
  agentRunsRows: any[];
  insertedRows: any[];
  updatedRows: any[];
  contentPostsCount: number;
  campaign: any;
  business: any;
}

function createMockDb({
  existingCreativeRun,
  agentRunsRows = [],
  contentPostsCount = 0,
  campaign = {
    id: 28,
    userId: 18,
    businessId: 24,
    workflowState: "strategy_approved",
    workflowContext: {},
  },
  business = {
    id: 24,
    userId: 18,
    name: "Test Business",
    websiteEvidence: { confidence: 0.8 },
  },
}: {
  existingCreativeRun?: any;
  agentRunsRows?: any[];
  contentPostsCount?: number;
  campaign?: any;
  business?: any;
} = {}) {
  const allAgentRunsRows = existingCreativeRun
    ? [existingCreativeRun, ...agentRunsRows]
    : [...agentRunsRows];

  const state: MockDbState = {
    agentRunsRows: allAgentRunsRows,
    insertedRows: [],
    updatedRows: [],
    contentPostsCount,
    campaign,
    business,
  };

  function buildRowsForTable(table: unknown): any[] {
    const name = getTableName(table);
    if (name === "campaigns") return [state.campaign];
    if (name === "businesses") return [state.business];
    if (name === "agent_runs") {
      return [...state.agentRunsRows].sort((a, b) => Number(b.id) - Number(a.id));
    }
    if (name === "content_posts") {
      return Array.from({ length: state.contentPostsCount }, (_, i) => ({
        id: 2000 + i,
        aiGenerated: true,
      }));
    }
    return [];
  }

  function createQueryBuilder(rows: any[]) {
    const builder: any = {
      orderBy: vi.fn(() => builder),
      limit: vi.fn(() => Promise.resolve(rows)),
      then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject),
    };
    return builder;
  }

  const db = {
    state,
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => createQueryBuilder(buildRowsForTable(table))),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (values: unknown) => {
        const name = getTableName(table);
        const row = {
          ...(values as any),
          id: 1000 + state.insertedRows.length,
        };
        state.insertedRows.push({ table: name, row });
        if (name === "agent_runs") {
          state.agentRunsRows.push(row);
        }
        return [{ insertId: row.id }];
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((payload: any) => ({
        where: vi.fn(async () => {
          const name = getTableName(table);
          state.updatedRows.push({ table: name, payload });
          return [];
        }),
      })),
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

describe("agentRouter.runCreativeAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates an outer operation row, passes source=agent, and completes it on success", async () => {
    const { getDb } = await import("./queries/connection");
    const { runCreativeAgent } = await import("./lib/agents/creative-agent");
    const { agentRouter } = await import("./agent-router");

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runCreativeAgent).mockResolvedValue({
      packRunId: 501,
      savedPosts: 2,
      savedAssets: 1,
      pack: null,
      assets: null,
      metrics: {},
    } as any);

    const caller = agentRouter.createCaller(buildCtx());
    const result = await caller.runCreativeAgent({ campaignId: 28 });

    expect(result.success).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.packRunId).toBe(501);

    expect(runCreativeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 18,
        campaignId: 28,
        generationOperation: { source: "agent", id: 1000 },
      })
    );

    const operationInsert = db.state.insertedRows.find((r) => r.table === "agent_runs");
    expect(operationInsert).toBeTruthy();
    expect(operationInsert.row.agentType).toBe("creative");
    expect(operationInsert.row.status).toBe("running");
    expect(operationInsert.row.input).toMatchObject({
      jobType: "content_generation_job",
      source: "agent_router",
    });

    const completedUpdate = db.state.updatedRows.find(
      (u) => u.table === "agent_runs" && u.payload.status === "completed"
    );
    expect(completedUpdate).toBeTruthy();
    expect(completedUpdate.payload.output).toMatchObject({
      success: true,
      packRunId: 501,
      savedPosts: 2,
      savedAssets: 1,
    });

    expect(attachCreativeGenerationOperationReference).toHaveBeenCalledWith(
      expect.objectContaining({ operationReferenceId: 1000 })
    );
  });

  it("marks the operation row failed when runCreativeAgent throws", async () => {
    const { getDb } = await import("./queries/connection");
    const { runCreativeAgent } = await import("./lib/agents/creative-agent");
    const { agentRouter } = await import("./agent-router");

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runCreativeAgent).mockRejectedValue(new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "generation failed" }));

    const caller = agentRouter.createCaller(buildCtx());
    await expect(caller.runCreativeAgent({ campaignId: 28 })).rejects.toBeInstanceOf(TRPCError);

    const operationInsert = db.state.insertedRows.find((r) => r.table === "agent_runs");
    expect(operationInsert).toBeTruthy();

    const failedUpdate = db.state.updatedRows.find(
      (u) => u.table === "agent_runs" && u.payload.status === "failed"
    );
    expect(failedUpdate).toBeTruthy();
    expect(failedUpdate.payload.error).toContain("generation failed");
  });

  it("ignores completed inner creative rows and retries a failed controlling operation", async () => {
    const { getDb } = await import("./queries/connection");
    const { runCreativeAgent } = await import("./lib/agents/creative-agent");
    const { agentRouter } = await import("./agent-router");

    const db = createMockDb({
      agentRunsRows: [
        {
          id: 231,
          userId: 18,
          campaignId: 28,
          agentType: "creative",
          status: "failed",
          input: { jobType: "content_generation_job", source: "agent_router" },
          createdAt: new Date("2024-01-01T00:00:00Z"),
        },
        {
          id: 236,
          userId: 18,
          campaignId: 28,
          agentType: "creative",
          status: "completed",
          input: { prompt: "inner prompt", system: "inner system" },
          createdAt: new Date("2024-01-02T00:00:00Z"),
        },
      ],
      contentPostsCount: 0,
    });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runCreativeAgent).mockResolvedValue({
      packRunId: 601,
      savedPosts: 2,
      savedAssets: 1,
      pack: null,
      assets: null,
      metrics: {},
    } as any);

    const caller = agentRouter.createCaller(buildCtx());
    const result = await caller.runCreativeAgent({ campaignId: 28 });

    expect(result.skipped).toBe(false);
    expect(result.success).toBe(true);
    expect(runCreativeAgent).toHaveBeenCalledTimes(1);
    expect(db.state.insertedRows.filter((r) => r.table === "agent_runs").length).toBe(1);
    expect(attachCreativeGenerationOperationReference).toHaveBeenCalledWith(
      expect.objectContaining({ operationReferenceId: 1000 })
    );
  });

  it("does not deduplicate when only inner creative runs exist", async () => {
    const { getDb } = await import("./queries/connection");
    const { runCreativeAgent } = await import("./lib/agents/creative-agent");
    const { agentRouter } = await import("./agent-router");

    const db = createMockDb({
      agentRunsRows: [
        {
          id: 236,
          userId: 18,
          campaignId: 28,
          agentType: "creative",
          status: "completed",
          input: { prompt: "inner prompt", system: "inner system" },
          createdAt: new Date(),
        },
      ],
      contentPostsCount: 0,
    });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runCreativeAgent).mockResolvedValue({
      packRunId: 602,
      savedPosts: 2,
      savedAssets: 1,
      pack: null,
      assets: null,
      metrics: {},
    } as any);

    const caller = agentRouter.createCaller(buildCtx());
    const result = await caller.runCreativeAgent({ campaignId: 28 });

    expect(result.skipped).toBe(false);
    expect(result.success).toBe(true);
    expect(runCreativeAgent).toHaveBeenCalledTimes(1);
  });

  it("short-circuits when an authoritative controlling run is already running", async () => {
    const { getDb } = await import("./queries/connection");
    const { runCreativeAgent } = await import("./lib/agents/creative-agent");
    const { agentRouter } = await import("./agent-router");

    const db = createMockDb({
      agentRunsRows: [
        {
          id: 231,
          userId: 18,
          campaignId: 28,
          agentType: "creative",
          status: "running",
          input: { jobType: "content_generation_job", source: "agent_router" },
          createdAt: new Date(),
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = agentRouter.createCaller(buildCtx());
    const result = await caller.runCreativeAgent({ campaignId: 28 });

    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("already in progress");
    expect(runCreativeAgent).not.toHaveBeenCalled();
    expect(db.state.insertedRows.length).toBe(0);
    expect(attachCreativeGenerationOperationReference).toHaveBeenCalledWith(
      expect.objectContaining({ operationReferenceId: 231, claimId: 1001 })
    );
    expect(releaseClaimWithResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", context: "agentRouter.runCreativeAgent" })
    );
  });

  it("safely reuses when a completed authoritative run has saved output evidence and matching posts", async () => {
    const { getDb } = await import("./queries/connection");
    const { runCreativeAgent } = await import("./lib/agents/creative-agent");
    const { agentRouter } = await import("./agent-router");

    const db = createMockDb({
      agentRunsRows: [
        {
          id: 231,
          userId: 18,
          campaignId: 28,
          agentType: "creative",
          status: "completed",
          input: { jobType: "content_generation_job", source: "agent_router" },
          output: { success: true, packRunId: 555, savedPosts: 3, savedAssets: 1 },
          createdAt: new Date(),
        },
      ],
      contentPostsCount: 3,
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = agentRouter.createCaller(buildCtx());
    const result = await caller.runCreativeAgent({ campaignId: 28 });

    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("Creative content already exists");
    expect(runCreativeAgent).not.toHaveBeenCalled();
    expect(db.state.insertedRows.length).toBe(0);
    expect(attachCreativeGenerationOperationReference).toHaveBeenCalledWith(
      expect.objectContaining({ operationReferenceId: 231, claimId: 1001 })
    );
    expect(releaseClaimWithResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed", context: "agentRouter.runCreativeAgent" })
    );
  });

  it("retries when a completed authoritative run has no persisted posts", async () => {
    const { getDb } = await import("./queries/connection");
    const { runCreativeAgent } = await import("./lib/agents/creative-agent");
    const { agentRouter } = await import("./agent-router");

    const db = createMockDb({
      agentRunsRows: [
        {
          id: 231,
          userId: 18,
          campaignId: 28,
          agentType: "creative",
          status: "completed",
          input: { jobType: "content_generation_job", source: "agent_router" },
          createdAt: new Date(),
        },
      ],
      contentPostsCount: 0,
    });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runCreativeAgent).mockResolvedValue({
      packRunId: 603,
      savedPosts: 2,
      savedAssets: 1,
      pack: null,
      assets: null,
      metrics: {},
    } as any);

    const caller = agentRouter.createCaller(buildCtx());
    const result = await caller.runCreativeAgent({ campaignId: 28 });

    expect(result.skipped).toBe(false);
    expect(result.success).toBe(true);
    expect(runCreativeAgent).toHaveBeenCalledTimes(1);
    expect(db.state.insertedRows.filter((r) => r.table === "agent_runs").length).toBe(1);
  });

  it("does not short-circuit through a newer completed inner row when controlling run failed", async () => {
    const { getDb } = await import("./queries/connection");
    const { runCreativeAgent } = await import("./lib/agents/creative-agent");
    const { acquireCreativeGenerationClaim } = await import("./lib/creative/creative-generation-claim");
    const { agentRouter } = await import("./agent-router");

    const db = createMockDb({
      agentRunsRows: [
        {
          id: 231,
          userId: 18,
          campaignId: 28,
          agentType: "creative",
          status: "failed",
          input: { jobType: "content_generation_job", source: "agent_router" },
          createdAt: new Date("2024-01-01T00:00:00Z"),
        },
        {
          id: 236,
          userId: 18,
          campaignId: 28,
          agentType: "creative",
          status: "completed",
          input: { prompt: "inner prompt", system: "inner system" },
          createdAt: new Date("2024-01-02T00:00:00Z"),
        },
      ],
      contentPostsCount: 0,
    });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runCreativeAgent).mockResolvedValue({
      packRunId: 604,
      savedPosts: 2,
      savedAssets: 1,
      pack: null,
      assets: null,
      metrics: {},
    } as any);

    const caller = agentRouter.createCaller(buildCtx());
    await caller.runCreativeAgent({ campaignId: 28 });

    expect(acquireCreativeGenerationClaim).toHaveBeenCalledTimes(1);
    expect(runCreativeAgent).toHaveBeenCalledTimes(1);
    expect(db.state.insertedRows.filter((r) => r.table === "agent_runs").length).toBe(1);
  });

  it("does not treat a legacy running creative run with no input as authoritative", async () => {
    const { getDb } = await import("./queries/connection");
    const { runCreativeAgent } = await import("./lib/agents/creative-agent");
    const { agentRouter } = await import("./agent-router");

    const db = createMockDb({
      existingCreativeRun: {
        id: 777,
        userId: 18,
        campaignId: 28,
        agentType: "creative",
        status: "running",
        createdAt: new Date(),
      },
    });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runCreativeAgent).mockResolvedValue({
      packRunId: 700,
      savedPosts: 2,
      savedAssets: 1,
      pack: null,
      assets: null,
      metrics: {},
    } as any);

    const caller = agentRouter.createCaller(buildCtx());
    const result = await caller.runCreativeAgent({ campaignId: 28 });

    expect(result.skipped).toBe(false);
    expect(result.success).toBe(true);
    expect(runCreativeAgent).toHaveBeenCalledTimes(1);
    expect(db.state.insertedRows.filter((r) => r.table === "agent_runs").length).toBe(1);
  });

  it("does not deduplicate a legacy completed creative run with null input", async () => {
    const { getDb } = await import("./queries/connection");
    const { runCreativeAgent } = await import("./lib/agents/creative-agent");
    const { agentRouter } = await import("./agent-router");

    const db = createMockDb({
      existingCreativeRun: {
        id: 778,
        userId: 18,
        campaignId: 28,
        agentType: "creative",
        status: "completed",
        input: null,
        createdAt: new Date(),
      },
      contentPostsCount: 5,
    });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runCreativeAgent).mockResolvedValue({
      packRunId: 701,
      savedPosts: 2,
      savedAssets: 1,
      pack: null,
      assets: null,
      metrics: {},
    } as any);

    const caller = agentRouter.createCaller(buildCtx());
    const result = await caller.runCreativeAgent({ campaignId: 28 });

    expect(result.skipped).toBe(false);
    expect(result.success).toBe(true);
    expect(runCreativeAgent).toHaveBeenCalledTimes(1);
  });

  it("does not deduplicate a creative run with malformed string input", async () => {
    const { getDb } = await import("./queries/connection");
    const { runCreativeAgent } = await import("./lib/agents/creative-agent");
    const { agentRouter } = await import("./agent-router");

    const db = createMockDb({
      agentRunsRows: [
        {
          id: 779,
          userId: 18,
          campaignId: 28,
          agentType: "creative",
          status: "completed",
          input: "not-an-object",
          createdAt: new Date(),
        },
      ],
      contentPostsCount: 5,
    });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runCreativeAgent).mockResolvedValue({
      packRunId: 702,
      savedPosts: 2,
      savedAssets: 1,
      pack: null,
      assets: null,
      metrics: {},
    } as any);

    const caller = agentRouter.createCaller(buildCtx());
    const result = await caller.runCreativeAgent({ campaignId: 28 });

    expect(result.skipped).toBe(false);
    expect(result.success).toBe(true);
    expect(runCreativeAgent).toHaveBeenCalledTimes(1);
  });

  it("does not deduplicate when posts exist but the completed authoritative run output lacks saved-post evidence", async () => {
    const { getDb } = await import("./queries/connection");
    const { runCreativeAgent } = await import("./lib/agents/creative-agent");
    const { agentRouter } = await import("./agent-router");

    const db = createMockDb({
      agentRunsRows: [
        {
          id: 780,
          userId: 18,
          campaignId: 28,
          agentType: "creative",
          status: "completed",
          input: { jobType: "content_generation_job", source: "agent_router" },
          output: { success: true, packRunId: 780 },
          createdAt: new Date(),
        },
      ],
      contentPostsCount: 3,
    });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runCreativeAgent).mockResolvedValue({
      packRunId: 703,
      savedPosts: 2,
      savedAssets: 1,
      pack: null,
      assets: null,
      metrics: {},
    } as any);

    const caller = agentRouter.createCaller(buildCtx());
    const result = await caller.runCreativeAgent({ campaignId: 28 });

    expect(result.skipped).toBe(false);
    expect(result.success).toBe(true);
    expect(runCreativeAgent).toHaveBeenCalledTimes(1);
    expect(db.state.insertedRows.filter((r) => r.table === "agent_runs").length).toBe(1);
  });

  it("attaches the authoritative operation reference before releasing every shortcut claim", async () => {
    const { getDb } = await import("./queries/connection");
    const { agentRouter } = await import("./agent-router");

    const callLog: { type: string; operationReferenceId?: number; status?: string }[] = [];
    vi.mocked(attachCreativeGenerationOperationReference).mockImplementation(async (args) => {
      callLog.push({ type: "attach", operationReferenceId: args.operationReferenceId });
      return { attached: true };
    });
    vi.mocked(releaseClaimWithResult).mockImplementation(async (args) => {
      callLog.push({ type: "release", status: args.status });
      return { released: true };
    });

    const caller = agentRouter.createCaller(buildCtx());

    // Running authoritative operation shortcut
    vi.mocked(getDb).mockReturnValue(createMockDb({
      agentRunsRows: [
        {
          id: 231,
          userId: 18,
          campaignId: 28,
          agentType: "creative",
          status: "running",
          input: { jobType: "content_generation_job", source: "agent_router" },
          createdAt: new Date(),
        },
      ],
    }) as any);
    await caller.runCreativeAgent({ campaignId: 28 });

    expect(callLog).toContainEqual({ type: "attach", operationReferenceId: 231 });
    expect(callLog).toContainEqual({ type: "release", status: "failed" });
    const runningAttachIndex = callLog.findIndex((c) => c.type === "attach" && c.operationReferenceId === 231);
    const runningReleaseIndex = callLog.findIndex((c) => c.type === "release" && c.status === "failed");
    expect(runningAttachIndex).toBeLessThan(runningReleaseIndex);

    // Completed authoritative operation shortcut with durable output
    callLog.length = 0;
    vi.clearAllMocks();
    vi.mocked(attachCreativeGenerationOperationReference).mockImplementation(async (args) => {
      callLog.push({ type: "attach", operationReferenceId: args.operationReferenceId });
      return { attached: true };
    });
    vi.mocked(releaseClaimWithResult).mockImplementation(async (args) => {
      callLog.push({ type: "release", status: args.status });
      return { released: true };
    });
    vi.mocked(getDb).mockReturnValue(createMockDb({
      agentRunsRows: [
        {
          id: 232,
          userId: 18,
          campaignId: 28,
          agentType: "creative",
          status: "completed",
          input: { jobType: "content_generation_job", source: "agent_router" },
          output: { success: true, packRunId: 232, savedPosts: 3, savedAssets: 1 },
          createdAt: new Date(),
        },
      ],
      contentPostsCount: 3,
    }) as any);
    await caller.runCreativeAgent({ campaignId: 28 });

    expect(callLog).toContainEqual({ type: "attach", operationReferenceId: 232 });
    expect(callLog).toContainEqual({ type: "release", status: "completed" });
    const completedAttachIndex = callLog.findIndex((c) => c.type === "attach" && c.operationReferenceId === 232);
    const completedReleaseIndex = callLog.findIndex((c) => c.type === "release" && c.status === "completed");
    expect(completedAttachIndex).toBeLessThan(completedReleaseIndex);
  });

  it("fails closed when attachment is rejected for a running shortcut", async () => {
    const { getDb } = await import("./queries/connection");
    const { runCreativeAgent } = await import("./lib/agents/creative-agent");
    const { agentRouter } = await import("./agent-router");

    vi.mocked(attachCreativeGenerationOperationReference).mockImplementationOnce(async () => ({
      attached: false,
      existingClaim: { id: 9999 } as any,
    }) as any);

    const db = createMockDb({
      agentRunsRows: [
        {
          id: 231,
          userId: 18,
          campaignId: 28,
          agentType: "creative",
          status: "running",
          input: { jobType: "content_generation_job", source: "agent_router" },
          createdAt: new Date(),
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = agentRouter.createCaller(buildCtx());
    await expect(caller.runCreativeAgent({ campaignId: 28 })).rejects.toBeInstanceOf(TRPCError);

    expect(runCreativeAgent).not.toHaveBeenCalled();
    expect(db.state.insertedRows.filter((r) => r.table === "agent_runs").length).toBe(0);
    expect(releaseClaimWithResult).toHaveBeenCalledTimes(1);
    expect(releaseClaimWithResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", context: "agentRouter.runCreativeAgent" })
    );
  });

  it("fails closed when attachment throws for a completed reuse shortcut", async () => {
    const { getDb } = await import("./queries/connection");
    const { runCreativeAgent } = await import("./lib/agents/creative-agent");
    const { agentRouter } = await import("./agent-router");

    vi.mocked(attachCreativeGenerationOperationReference).mockImplementationOnce(async () => {
      throw new Error("duplicate operation reference");
    });

    const db = createMockDb({
      agentRunsRows: [
        {
          id: 231,
          userId: 18,
          campaignId: 28,
          agentType: "creative",
          status: "completed",
          input: { jobType: "content_generation_job", source: "agent_router" },
          output: { success: true, packRunId: 555, savedPosts: 3, savedAssets: 1 },
          createdAt: new Date(),
        },
      ],
      contentPostsCount: 3,
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = agentRouter.createCaller(buildCtx());
    await expect(caller.runCreativeAgent({ campaignId: 28 })).rejects.toBeInstanceOf(TRPCError);

    expect(runCreativeAgent).not.toHaveBeenCalled();
    expect(db.state.insertedRows.filter((r) => r.table === "agent_runs").length).toBe(0);
    expect(releaseClaimWithResult).toHaveBeenCalledTimes(1);
    expect(releaseClaimWithResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", context: "agentRouter.runCreativeAgent" })
    );
  });

  it("rejects a fingerprint-matching but semantically invalid approved strategy before claim, run or billing", async () => {
    const { getDb } = await import("./queries/connection");
    const { runCreativeAgent } = await import("./lib/agents/creative-agent");
    const { assertApprovedStrategySemanticallyValid } = await import("./lib/workflow/strategy-approval");
    const { agentRouter } = await import("./agent-router");

    vi.mocked(assertApprovedStrategySemanticallyValid).mockRejectedValueOnce(
      new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "The approved strategy no longer matches the current campaign brief: stale audience classification.",
      })
    );

    const db = createMockDb();
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = agentRouter.createCaller(buildCtx());
    await expect(caller.runCreativeAgent({ campaignId: 28 })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });

    expect(runCreativeAgent).not.toHaveBeenCalled();
    expect(db.state.insertedRows.filter((r) => r.table === "agent_runs").length).toBe(0);
  });

  it("does not release a terminal shortcut as completed when attachment fails", async () => {
    const { getDb } = await import("./queries/connection");
    const { runCreativeAgent } = await import("./lib/agents/creative-agent");
    const { agentRouter } = await import("./agent-router");

    vi.mocked(attachCreativeGenerationOperationReference).mockImplementationOnce(async () => ({
      attached: false,
      existingClaim: { id: 9999 } as any,
    }) as any);

    const db = createMockDb({
      agentRunsRows: [
        {
          id: 231,
          userId: 18,
          campaignId: 28,
          agentType: "creative",
          status: "completed",
          input: { jobType: "content_generation_job", source: "agent_router" },
          output: { success: true, packRunId: 555, savedPosts: 3, savedAssets: 1 },
          createdAt: new Date(),
        },
      ],
      contentPostsCount: 3,
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = agentRouter.createCaller(buildCtx());
    const result = caller.runCreativeAgent({ campaignId: 28 });
    await expect(result).rejects.toBeInstanceOf(TRPCError);

    const completedRelease = vi.mocked(releaseClaimWithResult).mock.calls.find(
      (c) => (c[0] as any).status === "completed"
    );
    expect(completedRelease).toBeUndefined();
    expect(runCreativeAgent).not.toHaveBeenCalled();
    expect(db.state.insertedRows.filter((r) => r.table === "agent_runs").length).toBe(0);
  });
});

describe("agentRouter.runStrategyAgent shortcut behaviour", () => {
  const buildStrategyCampaign = (overrides: any = {}) => ({
    id: 28,
    userId: 18,
    businessId: 24,
    workflowState: "business_profile_complete",
    workflowContext: {},
    ...overrides,
  });

  const buildStrategyBusiness = (overrides: any = {}) => ({
    id: 24,
    userId: 18,
    name: "Test Business",
    websiteEvidence: { confidence: 0.8, productsServices: ["service"] },
    ...overrides,
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

  const failureEnvelope = {
    evidenceVersion: 1,
    outcome: "failed_validation",
    creativeBriefFingerprint: "fp-current",
    rawOutput: validFlatOutput,
    groundedOutput: validFlatOutput,
    validationDiagnostics: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an already-running result when the latest strategy run is running", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent } = await import("./lib/agents/strategy-agent");
    const { agentRouter } = await import("./agent-router");

    const db = createMockDb({
      campaign: buildStrategyCampaign(),
      business: buildStrategyBusiness(),
      agentRunsRows: [
        {
          id: 101,
          userId: 18,
          campaignId: 28,
          agentType: "strategy",
          status: "running",
          output: {
            evidenceVersion: 1,
            outcome: "generated_candidate",
            creativeBriefFingerprint: "fp-current",
            rawOutput: {},
          },
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = agentRouter.createCaller(buildCtx());
    const result = await caller.runStrategyAgent({ campaignId: 28 });

    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.runId).toBe(101);
    expect(result.output).toBeNull();
    expect(runStrategyAgent).not.toHaveBeenCalled();
  });

  it("does not treat a running row with legacy-looking flat output as completed", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent } = await import("./lib/agents/strategy-agent");
    const { agentRouter } = await import("./agent-router");

    const db = createMockDb({
      campaign: buildStrategyCampaign(),
      business: buildStrategyBusiness(),
      agentRunsRows: [
        {
          id: 102,
          userId: 18,
          campaignId: 28,
          agentType: "strategy",
          status: "running",
          output: validFlatOutput,
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = agentRouter.createCaller(buildCtx());
    const result = await caller.runStrategyAgent({ campaignId: 28 });

    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.output).toBeNull();
    expect(runStrategyAgent).not.toHaveBeenCalled();
  });

  it("reuses a valid completed flat strategy output", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent } = await import("./lib/agents/strategy-agent");
    const { onAgentRunComplete } = await import("./lib/workflow/triggers");
    const { agentRouter } = await import("./agent-router");

    const db = createMockDb({
      campaign: buildStrategyCampaign(),
      business: buildStrategyBusiness(),
      agentRunsRows: [
        {
          id: 103,
          userId: 18,
          campaignId: 28,
          agentType: "strategy",
          status: "completed",
          output: validFlatOutput,
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = agentRouter.createCaller(buildCtx());
    const result = await caller.runStrategyAgent({ campaignId: 28 });

    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.runId).toBe(103);
    expect(result.output).toEqual(validFlatOutput);
    expect(onAgentRunComplete).toHaveBeenCalledWith(103);
    expect(runStrategyAgent).not.toHaveBeenCalled();
  });

  it("does not reuse a completed evidence envelope and starts a fresh run", async () => {
    const { getDb } = await import("./queries/connection");
    const { runStrategyAgent } = await import("./lib/agents/strategy-agent");
    const { onAgentRunComplete } = await import("./lib/workflow/triggers");
    const { agentRouter } = await import("./agent-router");

    vi.mocked(runStrategyAgent).mockResolvedValue({
      runId: 104,
      output: validFlatOutput,
      promptTokens: 10,
      completionTokens: 10,
      actualCostUsdMicro: 0,
      estimatedCostUsdMicro: 0,
    } as any);

    const db = createMockDb({
      campaign: buildStrategyCampaign(),
      business: buildStrategyBusiness(),
      agentRunsRows: [
        {
          id: 103,
          userId: 18,
          campaignId: 28,
          agentType: "strategy",
          status: "completed",
          output: failureEnvelope,
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = agentRouter.createCaller(buildCtx());
    const result = await caller.runStrategyAgent({ campaignId: 28 });

    expect(result.success).toBe(true);
    expect(result.runId).toBe(104);
    expect(runStrategyAgent).toHaveBeenCalledTimes(1);
    expect(onAgentRunComplete).toHaveBeenCalledWith(104);
    expect(onAgentRunComplete).not.toHaveBeenCalledWith(103);
  });
});
