import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("./lib/workflow/publishing-runner", () => ({
  publishSinglePost: vi.fn(),
}));

vi.mock("./lib/integrations/platforms", () => ({
  isFacebookPublishingReady: vi.fn(() => true),
  isInstagramPublishingReady: vi.fn(() => true),
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

function makeChainable(rows: unknown[]) {
  const limitResult = rows;
  return {
    limit: vi.fn(async () => limitResult),
    orderBy: vi.fn(() => ({
      limit: vi.fn(async () => []),
    })),
    then: (resolve: (value: unknown[]) => unknown, reject?: (reason?: unknown) => unknown) =>
      Promise.resolve(limitResult).then(resolve, reject),
  };
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

interface MockDbConfig {
  campaign?: Record<string, unknown>;
  postCount?: number;
  posts?: Record<string, unknown>[];
  integrations?: Record<string, unknown>[];
  queue?: Record<string, unknown>[];
  assets?: Record<string, unknown>[];
  approvals?: Record<string, unknown>[];
  insertId?: number;
}

function createMockDb({
  campaign,
  postCount = 0,
  posts,
  integrations = [],
  queue = [],
  assets = [],
  approvals = [],
  insertId = 123,
}: MockDbConfig = {}): MockDb & {
  insertValuesSpies: Map<unknown, ReturnType<typeof vi.fn>>;
  insertValuesByTableName: Map<string, ReturnType<typeof vi.fn>>;
  updateSetSpies: Map<unknown, ReturnType<typeof vi.fn>>;
  updateSetByTableName: Map<string, ReturnType<typeof vi.fn>>;
} {
  const resolvedCampaign = campaign ?? {
    id: 28,
    userId: 18,
    businessId: 24,
    workflowState: "strategy_approved",
    workflowContext: { coreMessage: "Empower your workforce" },
    personas: [{ name: "Small Business Owner" }],
    coreMessage: "Empower your workforce",
  };

  const insertValuesSpies = new Map<unknown, ReturnType<typeof vi.fn>>();
  const insertValuesByTableName = new Map<string, ReturnType<typeof vi.fn>>();
  const updateSetSpies = new Map<unknown, ReturnType<typeof vi.fn>>();
  const updateSetByTableName = new Map<string, ReturnType<typeof vi.fn>>();

  const whereResult = (table: unknown) => {
    const tableName = getTableName(table);
    let limitResult: unknown[] = [];

    if (tableName === "campaigns") {
      limitResult = [resolvedCampaign];
    } else if (tableName === "content_posts") {
      limitResult = posts ?? [{ value: postCount }];
    } else if (tableName === "social_integrations") {
      // Mirror the backend business-scoping filter used by publishCampaignPack.
      const campaignBusinessId = resolvedCampaign.businessId;
      limitResult = integrations.filter(
        (row) =>
          (row as Record<string, unknown>).businessId == null ||
          (row as Record<string, unknown>).businessId === campaignBusinessId
      );
    } else if (tableName === "publishing_queue") {
      limitResult = queue;
    } else if (tableName === "campaign_assets") {
      limitResult = assets;
    } else if (tableName === "approval_requests") {
      limitResult = approvals;
    }

    return makeChainable(limitResult);
  };

  return {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => whereResult(table)),
      })),
    })) as unknown as MockDb["select"],
    insert: vi.fn((table: unknown) => {
      const valuesSpy = vi.fn(async () => [{ insertId }]);
      insertValuesSpies.set(table, valuesSpy);
      const tableName = getTableName(table);
      if (tableName) insertValuesByTableName.set(tableName, valuesSpy);
      return { values: valuesSpy };
    }) as unknown as MockDb["insert"],
    update: vi.fn((table: unknown) => {
      const setSpy = vi.fn(() => ({
        where: vi.fn(async () => []),
      }));
      updateSetSpies.set(table, setSpy);
      const tableName = getTableName(table);
      if (tableName) updateSetByTableName.set(tableName, setSpy);
      return { set: setSpy };
    }) as unknown as MockDb["update"],
    delete: vi.fn(() => ({
      where: vi.fn(async () => []),
    })) as unknown as MockDb["delete"],
    insertValuesSpies,
    insertValuesByTableName,
    updateSetSpies,
    updateSetByTableName,
  } as any;
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


describe("contentRouter.publishCampaignPack", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseCampaign = {
    id: 28,
    userId: 18,
    businessId: 24,
    status: "draft",
    workflowState: "creatives_ready",
    platforms: "instagram",
  };

  const basePost = {
    id: 125,
    userId: 18,
    campaignId: 28,
    type: "social_post",
    platform: "Instagram",
    status: "draft",
    metadata: { approved: true },
  };

  const baseIntegration = {
    id: 7,
    userId: 18,
    businessId: 24,
    platform: "instagram",
    status: "connected",
    accountName: "3at1newmarketmall",
    instagramBusinessAccountId: "ig-123",
    pageAccessTokenEncrypted: "encrypted-token",
    permissions: ["instagram_content_publishing"],
  };

  const captionAsset = {
    id: 1,
    userId: 18,
    campaignId: 28,
    assetType: "caption_adaptation",
  };

  it("creates a publishing_queue row when a connected Instagram integration exists", async () => {
    const { getDb } = await import("./queries/connection");
    const { publishSinglePost } = await import("./lib/workflow/publishing-runner");
    const { contentRouter } = await import("./content-router");

    vi.mocked(publishSinglePost).mockResolvedValue({
      id: 123,
      status: "published",
      platform: "instagram",
      postId: "ext-125",
    } as any);

    const mockDb = createMockDb({
      campaign: baseCampaign,
      posts: [basePost],
      integrations: [baseIntegration],
      assets: [captionAsset],
      queue: [],
    });
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    const caller = contentRouter.createCaller(buildCtx());
    const result = await caller.publishCampaignPack({ campaignId: 28 });

    expect(result.manualPosting).toBeFalsy();
    expect(result.publishedCount).toBe(1);

    const insertValuesSpy = mockDb.insertValuesByTableName.get("publishing_queue");
    expect(insertValuesSpy).toHaveBeenCalledTimes(1);
    const inserted = insertValuesSpy!.mock.calls[0][0];
    expect(inserted).toMatchObject({
      userId: 18,
      campaignId: 28,
      contentPostId: 125,
      integrationId: 7,
      platform: "instagram",
      status: "approved",
    });

    expect(publishSinglePost).toHaveBeenCalledWith(123);
  });

  it("marks content for manual posting when no connected platform exists", async () => {
    const { getDb } = await import("./queries/connection");
    const { publishSinglePost } = await import("./lib/workflow/publishing-runner");
    const { contentRouter } = await import("./content-router");

    const mockDb = createMockDb({
      campaign: baseCampaign,
      posts: [basePost],
      integrations: [],
      assets: [captionAsset],
      queue: [],
    });
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    const caller = contentRouter.createCaller(buildCtx());
    const result = await caller.publishCampaignPack({ campaignId: 28 });

    expect(result.manualPosting).toBe(true);
    expect(result.manualCount).toBe(1);
    expect(result.publishedCount).toBe(0);

    const updateSetSpy = mockDb.updateSetByTableName.get("content_posts");
    expect(updateSetSpy).toHaveBeenCalledTimes(1);
    const update = updateSetSpy!.mock.calls[0][0];
    expect(update.status).toBe("published");
    expect(update.metadata.publishMode).toBe("manual");
    expect(update.metadata.manuallyPostedAt).toBeTruthy();

    expect(mockDb.insertValuesByTableName.has("publishing_queue")).toBe(false);
    expect(publishSinglePost).not.toHaveBeenCalled();
  });

  it("does not auto-publish to an integration that belongs to a different business", async () => {
    const { getDb } = await import("./queries/connection");
    const { publishSinglePost } = await import("./lib/workflow/publishing-runner");
    const { contentRouter } = await import("./content-router");

    const wrongBusinessIntegration = {
      ...baseIntegration,
      businessId: 99,
    };

    const mockDb = createMockDb({
      campaign: baseCampaign,
      posts: [basePost],
      integrations: [wrongBusinessIntegration],
      assets: [captionAsset],
      queue: [],
    });
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    const caller = contentRouter.createCaller(buildCtx());
    const result = await caller.publishCampaignPack({ campaignId: 28 });

    expect(result.manualPosting).toBe(true);
    expect(result.publishedCount).toBe(0);
    expect(publishSinglePost).not.toHaveBeenCalled();
  });

  it("creates a failed queue row when the integration is connected but not publishing-ready", async () => {
    const { getDb } = await import("./queries/connection");
    const { isInstagramPublishingReady } = await import("./lib/integrations/platforms");
    const { contentRouter } = await import("./content-router");

    vi.mocked(isInstagramPublishingReady).mockReturnValue(false);

    const mockDb = createMockDb({
      campaign: baseCampaign,
      posts: [basePost],
      integrations: [baseIntegration],
      assets: [captionAsset],
      queue: [],
    });
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    const caller = contentRouter.createCaller(buildCtx());
    const result = await caller.publishCampaignPack({ campaignId: 28 });

    expect(result.publishedCount).toBe(0);
    expect(result.failedCount).toBe(1);

    const insertValuesSpy = mockDb.insertValuesByTableName.get("publishing_queue");
    expect(insertValuesSpy).toHaveBeenCalledTimes(1);
    const inserted = insertValuesSpy!.mock.calls[0][0];
    expect(inserted.status).toBe("failed");
    expect(inserted.lastError).toContain("Instagram publishing is not ready");
  });
});


describe("contentRouter.ensurePublishEligibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const campaign23 = {
    id: 23,
    userId: 14,
    businessId: 20,
    status: "draft",
    workflowState: "creatives_ready",
    platforms: "Facebook, Instagram",
    name: "3@1 Newmarket Campaign",
    aiGenerated: true,
  };

  const approvedPost = {
    id: 108,
    userId: 14,
    campaignId: 23,
    type: "social_post",
    platform: "Instagram",
    status: "draft",
    metadata: { approved: true },
  };

  const captionAsset = {
    id: 1,
    userId: 14,
    campaignId: 23,
    assetType: "caption_adaptation",
  };

  const facebookIntegration = {
    id: 9,
    userId: 14,
    businessId: 20,
    platform: "facebook",
    status: "connected",
    accountName: "3at1newmarketmall",
    pageId: "fb-page-123",
    pageAccessTokenEncrypted: "encrypted-token",
    permissions: ["pages_manage_posts"],
  };

  const instagramIntegration = {
    id: 10,
    userId: 14,
    businessId: 20,
    platform: "instagram",
    status: "connected",
    accountName: "3at1newmarketmall",
    instagramBusinessAccountId: "ig-123",
    pageAccessTokenEncrypted: "encrypted-token",
    permissions: ["instagram_content_publishing"],
  };

  function buildCtxForCampaign23() {
    return buildCtx(14);
  }

  it("Campaign #23 with connected FB/IG but missing campaign_launch approval returns launch approval required and creates the approval", async () => {
    const { getDb } = await import("./queries/connection");
    const { contentRouter } = await import("./content-router");

    const mockDb = createMockDb({
      campaign: campaign23,
      posts: [approvedPost],
      integrations: [facebookIntegration, instagramIntegration],
      assets: [captionAsset],
      approvals: [],
    });
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    const caller = contentRouter.createCaller(buildCtxForCampaign23());
    const result = await caller.ensurePublishEligibility({ campaignId: 23 });

    expect(result.canPublish).toBe(false);
    expect(result.unavailableReason).toBe("launch_approval_required");
    expect(result.unavailableReason).not.toBe("no_connected_platforms");
    expect(result.connectedIntegrationsFound).toBe(2);
    expect(result.publishablePostCount).toBe(1);
    expect(result.strategyApproved).toBe(true);
    expect(result.launchApproved).toBe(false);

    const approvalInsertSpy = mockDb.insertValuesByTableName.get("approval_requests");
    expect(approvalInsertSpy).toHaveBeenCalledTimes(1);
    const approvalInsert = approvalInsertSpy!.mock.calls[0][0];
    expect(approvalInsert).toMatchObject({
      userId: 14,
      campaignId: 23,
      approvalType: "campaign_launch",
      status: "pending",
      riskLevel: "low",
    });
  });

  it("returns no_connected_platforms when there are no connected integrations", async () => {
    const { getDb } = await import("./queries/connection");
    const { contentRouter } = await import("./content-router");

    const mockDb = createMockDb({
      campaign: campaign23,
      posts: [approvedPost],
      integrations: [],
      assets: [captionAsset],
      approvals: [],
    });
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    const caller = contentRouter.createCaller(buildCtxForCampaign23());
    const result = await caller.ensurePublishEligibility({ campaignId: 23 });

    expect(result.canPublish).toBe(false);
    expect(result.unavailableReason).toBe("no_connected_platforms");
    expect(result.connectedIntegrationsFound).toBe(0);

    const approvalInsertSpy = mockDb.insertValuesByTableName.get("approval_requests");
    expect(approvalInsertSpy).toBeUndefined();
  });

  it("returns ready when an approved campaign_launch approval exists", async () => {
    const { getDb } = await import("./queries/connection");
    const { contentRouter } = await import("./content-router");

    const mockDb = createMockDb({
      campaign: campaign23,
      posts: [approvedPost],
      integrations: [facebookIntegration, instagramIntegration],
      assets: [captionAsset],
      approvals: [
        {
          id: 99,
          userId: 14,
          campaignId: 23,
          approvalType: "campaign_launch",
          status: "approved",
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    const caller = contentRouter.createCaller(buildCtxForCampaign23());
    const result = await caller.ensurePublishEligibility({ campaignId: 23 });

    expect(result.canPublish).toBe(true);
    expect(result.unavailableReason).toBe("ready");
    expect(result.launchApproved).toBe(true);
    expect(result.pendingApprovalCount).toBe(0);

    const approvalInsertSpy = mockDb.insertValuesByTableName.get("approval_requests");
    expect(approvalInsertSpy).toBeUndefined();
  });
});
