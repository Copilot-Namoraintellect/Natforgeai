import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("./lib/agents/creative-agent", () => ({
  runCreativeAgent: vi.fn(),
}));

vi.mock("./lib/workflow/triggers", () => ({
  onAgentRunComplete: vi.fn(),
}));

vi.mock("./lib/rate-limiter", () => ({
  rateLimitUser: vi.fn().mockResolvedValue(undefined),
  rateLimitPublic: vi.fn().mockResolvedValue(undefined),
  checkRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    limit: 100,
    remaining: 99,
    resetAt: Date.now() + 60 * 60 * 1000,
  }),
  TIER_RATE_LIMITS: {
    free: { aiPerDay: 20, apiPerHour: 100, publishPerHour: 10 },
    startup: { aiPerDay: 200, apiPerHour: 1000, publishPerHour: 100 },
    growth: { aiPerDay: 2000, apiPerHour: 5000, publishPerHour: 500 },
    enterprise: { aiPerDay: 20000, apiPerHour: 20000, publishPerHour: 2000 },
  },
}));

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as string | undefined;
}

interface MockDb {
  select: () => {
    from: (table: unknown) => {
      where: () => {
        limit: () => Promise<unknown[]>;
        orderBy: () => { limit: () => Promise<unknown[]> };
      };
    };
  };
  insert: (table: unknown) => { values: () => Promise<unknown> };
  update: () => { set: () => { where: () => Promise<unknown[]> } };
  delete: () => { where: () => Promise<unknown[]> };
}

function createMockDb({
  campaign,
  postCount = 0,
}: {
  campaign?: Record<string, unknown>;
  postCount?: number;
} = {}): MockDb {
  const resolvedCampaign = campaign ?? {
    id: 28,
    userId: 18,
    businessId: 24,
    workflowState: "strategy_approved",
    workflowContext: { coreMessage: "Empower your workforce" },
    personas: [{ name: "Small Business Owner" }],
    coreMessage: "Empower your workforce",
  };

  const whereResult = (table: unknown) => {
    const tableName = getTableName(table);
    let limitResult: unknown[] = [];

    if (tableName === "campaigns") {
      limitResult = [resolvedCampaign];
    } else if (tableName === "content_posts") {
      // count() query returns [{ value: N }]
      limitResult = [{ value: postCount }];
    }

    const chainable = {
      limit: vi.fn(async () => limitResult),
      orderBy: vi.fn(() => ({
        limit: vi.fn(async () => []),
      })),
      then: (resolve: (value: unknown[]) => unknown, reject?: (reason?: unknown) => unknown) =>
        Promise.resolve(limitResult).then(resolve, reject),
    };
    return chainable;
  };

  return {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => whereResult(table)),
      })),
    })) as unknown as MockDb["select"],
    insert: vi.fn(() => ({
      values: vi.fn(async () => [{ insertId: 123 }]),
    })) as unknown as MockDb["insert"],
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => []),
      })),
    })) as unknown as MockDb["update"],
    delete: vi.fn(() => ({
      where: vi.fn(async () => []),
    })) as unknown as MockDb["delete"],
  };
}

function buildCtx(userId = 18) {
  return {
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
    user: { id: userId, tierSlug: "free" } as any,
    session: { verified: true } as any,
  };
}

describe("contentRouter.generateForCampaign", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns idempotently and does not call runCreativeAgent when posts already exist", async () => {
    const { getDb } = await import("./queries/connection");
    const { runCreativeAgent } = await import("./lib/agents/creative-agent");
    const { contentRouter } = await import("./content-router");

    vi.mocked(getDb).mockReturnValue(
      createMockDb({
        campaign: {
          id: 28,
          userId: 18,
          businessId: 24,
          workflowState: "creatives_ready",
          workflowContext: { coreMessage: "Empower your workforce" },
          personas: [{ name: "Small Business Owner" }],
          coreMessage: "Empower your workforce",
        },
        postCount: 2,
      }) as unknown as ReturnType<typeof getDb>
    );

    const caller = contentRouter.createCaller(buildCtx());
    const result = await caller.generateForCampaign({ campaignId: 28 });

    expect(result.success).toBe(true);
    expect(result.postCount).toBe(2);
    expect(result.idempotent).toBe(true);
    expect(runCreativeAgent).not.toHaveBeenCalled();
  });

  it("repairs creatives_generating to creatives_ready when posts already exist", async () => {
    const { getDb } = await import("./queries/connection");
    const { runCreativeAgent } = await import("./lib/agents/creative-agent");
    const { contentRouter } = await import("./content-router");

    const mockDb = createMockDb({
      campaign: {
        id: 28,
        userId: 18,
        businessId: 24,
        workflowState: "creatives_generating",
        workflowContext: { coreMessage: "Empower your workforce" },
        personas: [{ name: "Small Business Owner" }],
        coreMessage: "Empower your workforce",
      },
      postCount: 3,
    });
    const updateSpy = vi.fn(() => ({ where: vi.fn(async () => []) }));
    mockDb.update = vi.fn(() => ({ set: updateSpy })) as unknown as MockDb["update"];

    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    const caller = contentRouter.createCaller(buildCtx());
    const result = await caller.generateForCampaign({ campaignId: 28 });

    expect(result.success).toBe(true);
    expect(result.postCount).toBe(3);
    expect(result.idempotent).toBe(true);
    expect(runCreativeAgent).not.toHaveBeenCalled();

    // Verify the repair update was issued
    expect(mockDb.update).toHaveBeenCalled();
    const setCall = (updateSpy.mock.calls as any[])[0]?.[0];
    expect(setCall?.workflowState).toBe("creatives_ready");
  });

  it("advances workflowState to creatives_ready after saving posts", async () => {
    const { getDb } = await import("./queries/connection");
    const { runCreativeAgent } = await import("./lib/agents/creative-agent");
    const { onAgentRunComplete } = await import("./lib/workflow/triggers");
    const { contentRouter } = await import("./content-router");

    vi.mocked(runCreativeAgent).mockResolvedValue({
      packRunId: 91,
      assetsRunId: 92,
      pack: {},
      assets: {},
      savedPosts: 2,
      savedAssets: 8,
    } as any);

    const mockDb = createMockDb({
      campaign: {
        id: 28,
        userId: 18,
        businessId: 24,
        workflowState: "strategy_approved",
        workflowContext: { coreMessage: "Empower your workforce" },
        personas: [{ name: "Small Business Owner" }],
        coreMessage: "Empower your workforce",
      },
      postCount: 0,
    });
    const updateSpy = vi.fn(() => ({ where: vi.fn(async () => []) }));
    mockDb.update = vi.fn(() => ({ set: updateSpy })) as unknown as MockDb["update"];

    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    const caller = contentRouter.createCaller(buildCtx());
    const result = await caller.generateForCampaign({ campaignId: 28 });

    expect(result.success).toBe(true);
    expect(result.postCount).toBe(2);
    expect(runCreativeAgent).toHaveBeenCalledTimes(1);
    expect(onAgentRunComplete).toHaveBeenCalledWith(91);

    // Verify state transition to creatives_ready
    expect(mockDb.update).toHaveBeenCalled();
    const stateUpdate = (updateSpy.mock.calls as any[]).find(
      (call) => call[0]?.workflowState === "creatives_ready"
    );
    expect(stateUpdate).toBeTruthy();
  });

  it("throws when runCreativeAgent saves zero posts", async () => {
    const { getDb } = await import("./queries/connection");
    const { runCreativeAgent } = await import("./lib/agents/creative-agent");
    const { contentRouter } = await import("./content-router");

    vi.mocked(runCreativeAgent).mockResolvedValue({
      packRunId: 91,
      assetsRunId: 92,
      pack: {},
      assets: {},
      savedPosts: 0,
      savedAssets: 0,
    } as any);

    vi.mocked(getDb).mockReturnValue(
      createMockDb({
        campaign: {
          id: 28,
          userId: 18,
          businessId: 24,
          workflowState: "strategy_approved",
          workflowContext: { coreMessage: "Empower your workforce" },
          personas: [{ name: "Small Business Owner" }],
          coreMessage: "Empower your workforce",
        },
        postCount: 0,
      }) as unknown as ReturnType<typeof getDb>
    );

    const caller = contentRouter.createCaller(buildCtx());
    await expect(caller.generateForCampaign({ campaignId: 28 })).rejects.toThrow(TRPCError);
  });

  it("Campaign #28 regression: older failed runs + latest success + existing posts + stuck creatives_generating stays usable", async () => {
    const { getDb } = await import("./queries/connection");
    const { runCreativeAgent } = await import("./lib/agents/creative-agent");
    const { contentRouter } = await import("./content-router");

    const mockDb = createMockDb({
      campaign: {
        id: 28,
        userId: 18,
        businessId: 24,
        workflowState: "creatives_generating",
        workflowContext: { coreMessage: "Empower your workforce" },
        personas: [{ name: "Small Business Owner" }],
        coreMessage: "Empower your workforce",
      },
      postCount: 2,
    });
    const updateSpy = vi.fn(() => ({ where: vi.fn(async () => []) }));
    mockDb.update = vi.fn(() => ({ set: updateSpy })) as unknown as MockDb["update"];

    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    const caller = contentRouter.createCaller(buildCtx());
    const result = await caller.generateForCampaign({ campaignId: 28 });

    // No credit-charging agent run should happen
    expect(runCreativeAgent).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.idempotent).toBe(true);

    // State should be repaired to creatives_ready
    const stateUpdate = (updateSpy.mock.calls as any[]).find(
      (call) => call[0]?.workflowState === "creatives_ready"
    );
    expect(stateUpdate).toBeTruthy();
  });
});
