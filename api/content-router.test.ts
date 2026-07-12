import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";
import { SQL } from "drizzle-orm";
import { finalizeCampaignPublishState } from "./lib/workflow/publishing-runner";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("./lib/workflow/publishing-runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/workflow/publishing-runner")>();
  return {
    ...actual,
    publishSinglePost: vi.fn(),
  };
});

vi.mock("./lib/integrations/platforms", () => ({
  isFacebookPublishingReady: vi.fn(() => true),
  isInstagramPublishingReady: vi.fn(() => true),
}));

vi.mock("./lib/safety/checker", () => ({
  checkContentSafety: vi.fn(async () => ({ riskLevel: "low", reasons: [], suggestedFixes: [] })),
}));

vi.mock("./lib/agents/creative-agent", () => ({
  runCreativeAgent: vi.fn(),
}));

vi.mock("./lib/workflow/triggers", () => ({
  onAgentRunComplete: vi.fn(),
}));

vi.mock("./lib/queue/bullmq", () => ({
  scheduleContentGenerationJob: vi.fn(async () => ({ id: "content-generate:28" })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock("./lib/jobs/content-generation-job", () => ({
  processContentGenerationJob: vi.fn(async () => undefined),
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

function getBaseTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:BaseName") as symbol] as string | undefined;
}

type WhereNode =
  | { op: "and"; left: WhereNode; right: WhereNode }
  | { op: "or"; left: WhereNode; right: WhereNode }
  | { op: "eq"; table?: string; column: string; value: unknown }
  | { op: "isNull"; table?: string; column: string; not: boolean }
  | null;

function parseWhereCondition(condition: unknown): WhereNode {
  if (!condition || typeof condition !== "object") return null;
  const sql = condition as any;
  if (!Array.isArray(sql.queryChunks)) return null;

  type Token =
    | { type: "sql"; node: WhereNode }
    | { type: "string"; value: string }
    | { type: "column"; table?: string; column: string }
    | { type: "param"; value: unknown }
    | { type: "unknown"; chunk: unknown };

  const tokens: Token[] = sql.queryChunks.map((chunk: unknown): Token => {
    if (chunk instanceof SQL) return { type: "sql" as const, node: parseWhereCondition(chunk) };
    if (chunk && typeof chunk === "object" && (chunk as any).constructor?.name === "StringChunk") {
      return { type: "string" as const, value: ((chunk as any).value as string[]).join("") };
    }
    if (chunk && typeof chunk === "object" && (chunk as any).name) {
      return {
        type: "column" as const,
        table: getBaseTableName((chunk as any).table) ?? undefined,
        column: (chunk as any).name as string,
      };
    }
    if (chunk && typeof chunk === "object" && "value" in (chunk as any)) {
      return { type: "param" as const, value: (chunk as any).value };
    }
    return { type: "unknown" as const, chunk };
  });

  const combinedString = tokens
    .filter((t): t is { type: "string"; value: string } => t.type === "string")
    .map((t) => t.value)
    .join("");

  const sqlNodes = tokens.filter((t): t is { type: "sql"; node: WhereNode } => t.type === "sql");
  const columns = tokens.filter((t): t is { type: "column"; table?: string; column: string } => t.type === "column");
  const params = tokens.filter((t): t is { type: "param"; value: unknown } => t.type === "param");

  // N-ary and/or composed of multiple SQL predicates.
  if (sqlNodes.length > 1) {
    const ops: Array<"and" | "or"> = [];
    let lastWasSql = false;
    for (const t of tokens) {
      if (t.type === "sql") {
        lastWasSql = true;
      } else if (t.type === "string" && lastWasSql) {
        const s = t.value.toLowerCase();
        if (s.includes(" and ")) ops.push("and");
        else if (s.includes(" or ")) ops.push("or");
      }
    }
    if (ops.length > 0 && ops.every((o) => o === ops[0])) {
      const op = ops[0];
      let node = sqlNodes[0].node;
      for (let i = 1; i < sqlNodes.length; i++) {
        node = { op, left: node, right: sqlNodes[i].node };
      }
      return node;
    }
  }

  // Single SQL predicate (possibly wrapped in parentheses).
  if (sqlNodes.length === 1) {
    return sqlNodes[0].node;
  }

  if (combinedString.includes(" = ") && columns.length === 1 && params.length === 1) {
    return { op: "eq", table: columns[0].table, column: columns[0].column, value: params[0].value };
  }
  if (combinedString.toLowerCase().includes(" is null") && columns.length === 1) {
    const not = combinedString.toLowerCase().includes("is not null");
    return { op: "isNull", table: columns[0].table, column: columns[0].column, not };
  }

  return null;
}

function evaluateWhereCondition(node: WhereNode, row: Record<string, unknown>): boolean {
  if (!node) return true;
  switch (node.op) {
    case "and":
      return evaluateWhereCondition(node.left, row) && evaluateWhereCondition(node.right, row);
    case "or":
      return evaluateWhereCondition(node.left, row) || evaluateWhereCondition(node.right, row);
    case "eq":
      return row[node.column] == node.value;
    case "isNull":
      return node.not ? row[node.column] != null : row[node.column] == null;
  }
  return true;
}

function makeChainable(rows: unknown[]) {
  const limitResult = rows;
  return {
    limit: vi.fn(async () => limitResult),
    orderBy: vi.fn(() => ({
      limit: vi.fn(async () => limitResult),
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
  agentRunsRows?: Record<string, unknown>[];
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
  agentRunsRows = [],
  insertId = 123,
}: MockDbConfig = {}): MockDb & {
  insertValuesSpies: Map<unknown, ReturnType<typeof vi.fn>>;
  insertValuesByTableName: Map<string, ReturnType<typeof vi.fn>>;
  insertCallsByTableName: Map<string, any[]>;
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
  const insertCallsByTableName = new Map<string, ReturnType<typeof vi.fn>[]>();
  const updateSetSpies = new Map<unknown, ReturnType<typeof vi.fn>>();
  const updateSetByTableName = new Map<string, ReturnType<typeof vi.fn>>();

  const whereResult = (table: unknown, condition?: unknown) => {
    const tableName = getTableName(table);
    let limitResult: unknown[] = [];

    if (tableName === "campaigns") {
      limitResult = [resolvedCampaign];
    } else if (tableName === "content_posts") {
      limitResult = posts ?? [
        {
          value: postCount,
          userId: resolvedCampaign.userId,
          campaignId: resolvedCampaign.id,
        },
      ];
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
    } else if (tableName === "agent_runs") {
      limitResult = agentRunsRows;
    }

    const parsed = condition ? parseWhereCondition(condition) : null;
    if (parsed) {
      limitResult = limitResult.filter((row) =>
        evaluateWhereCondition(parsed, row as Record<string, unknown>)
      );
    }

    return makeChainable(limitResult);
  };

  return {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn((condition: unknown) => whereResult(table, condition)),
      })),
    })) as unknown as MockDb["select"],
    insert: vi.fn((table: unknown) => {
      const tableName = getTableName(table);
      const calls: any[] = [];
      const valuesSpy = vi.fn(async (vals: any) => {
        const arr = Array.isArray(vals) ? vals : [vals];
        calls.push(...arr);
        if (tableName) insertCallsByTableName.set(tableName, calls);
        return [{ insertId }];
      });
      insertValuesSpies.set(table, valuesSpy);
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
    insertCallsByTableName,
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

  it("queues a background content-generation job and returns quickly", async () => {
    const { getDb } = await import("./queries/connection");
    const { scheduleContentGenerationJob } = await import("./lib/queue/bullmq");
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
        postCount: 0,
      }) as unknown as ReturnType<typeof getDb>
    );

    const caller = contentRouter.createCaller(buildCtx());
    const result = await caller.generateForCampaign({ campaignId: 28 });

    expect(result.status).toBe("queued");
    expect(result.jobId).toBeGreaterThan(0);
    expect(result.campaignId).toBe(28);
    expect(scheduleContentGenerationJob).toHaveBeenCalledTimes(1);
  });

  it("returns queued when duplicate click finds a pending active job", async () => {
    const { getDb } = await import("./queries/connection");
    const { scheduleContentGenerationJob } = await import("./lib/queue/bullmq");
    const { contentRouter } = await import("./content-router");

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
        agentRunsRows: [
          {
            id: 777,
            userId: 18,
            campaignId: 28,
            agentType: "creative",
            status: "pending",
            input: { jobType: "content_generation_job", regenerate: false },
            createdAt: new Date(),
          },
        ],
      }) as unknown as ReturnType<typeof getDb>
    );

    const caller = contentRouter.createCaller(buildCtx());
    const result = await caller.generateForCampaign({ campaignId: 28 });

    expect(result.status).toBe("queued");
    expect(result.jobId).toBe(777);
    expect(result.reused).toBe(true);
    expect(scheduleContentGenerationJob).not.toHaveBeenCalled();
  });

  it("returns processing when duplicate click finds a running active job", async () => {
    const { getDb } = await import("./queries/connection");
    const { scheduleContentGenerationJob } = await import("./lib/queue/bullmq");
    const { contentRouter } = await import("./content-router");

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
        agentRunsRows: [
          {
            id: 778,
            userId: 18,
            campaignId: 28,
            agentType: "creative",
            status: "running",
            input: { jobType: "content_generation_job", regenerate: false },
            createdAt: new Date(),
          },
        ],
      }) as unknown as ReturnType<typeof getDb>
    );

    const caller = contentRouter.createCaller(buildCtx());
    const result = await caller.generateForCampaign({ campaignId: 28 });

    expect(result.status).toBe("processing");
    expect(result.jobId).toBe(778);
    expect(result.reused).toBe(true);
    expect(scheduleContentGenerationJob).not.toHaveBeenCalled();
  });

  it("rejects generation when campaign is not in an eligible workflow state", async () => {
    const { getDb } = await import("./queries/connection");
    const { contentRouter } = await import("./content-router");

    vi.mocked(getDb).mockReturnValue(
      createMockDb({
        campaign: {
          id: 28,
          userId: 18,
          businessId: 24,
          workflowState: "strategy_pending",
          workflowContext: {},
          personas: [{ name: "Small Business Owner" }],
          coreMessage: "Empower your workforce",
        },
        postCount: 0,
      }) as unknown as ReturnType<typeof getDb>
    );

    const caller = contentRouter.createCaller(buildCtx());
    await expect(caller.generateForCampaign({ campaignId: 28 })).rejects.toBeInstanceOf(TRPCError);
  });

  it("returns generation job status including stage durations", async () => {
    const { getDb } = await import("./queries/connection");
    const { contentRouter } = await import("./content-router");

    vi.mocked(getDb).mockReturnValue(
      createMockDb({
      campaign: {
        id: 28,
        userId: 18,
        businessId: 24,
          workflowState: "creatives_ready",
          workflowContext: {},
        personas: [{ name: "Small Business Owner" }],
        coreMessage: "Empower your workforce",
      },
        postCount: 2,
        agentRunsRows: [
          {
            id: 901,
            userId: 18,
            campaignId: 28,
            agentType: "creative",
            status: "completed",
            input: { jobType: "content_generation_job" },
            output: {
              postCount: 2,
              durations: {
                messageArchitectDurationMs: 120,
                creativeGenerationDurationMs: 420,
                qualityRetryDurationMs: 0,
                fallbackDurationMs: 40,
                totalDurationMs: 600,
              },
            },
            createdAt: new Date(),
            startedAt: new Date(),
            completedAt: new Date(),
          },
        ],
      }) as unknown as ReturnType<typeof getDb>
    );

    const caller = contentRouter.createCaller(buildCtx());
    const status = await caller.getGenerationJobStatus({ campaignId: 28, jobId: 901 });
    expect(status?.status).toBe("completed");
    expect(status?.jobId).toBe(901);
    expect(status?.messageArchitectDurationMs).toBe(120);
    expect(status?.creativeGenerationDurationMs).toBe(420);
    expect(status?.fallbackDurationMs).toBe(40);
  });

  it("returns null when requested jobId is not owned by authenticated user", async () => {
    const { getDb } = await import("./queries/connection");
    const { contentRouter } = await import("./content-router");

    vi.mocked(getDb).mockReturnValue(
      createMockDb({
        campaign: {
          id: 28,
          userId: 18,
          businessId: 24,
          workflowState: "creatives_ready",
          workflowContext: {},
          personas: [{ name: "Small Business Owner" }],
          coreMessage: "Empower your workforce",
        },
        postCount: 0,
        agentRunsRows: [
          {
            id: 902,
            userId: 99,
            campaignId: 28,
            agentType: "creative",
            status: "running",
            input: { jobType: "content_generation_job" },
            createdAt: new Date(),
          },
        ],
      }) as unknown as ReturnType<typeof getDb>
    );

    const caller = contentRouter.createCaller(buildCtx(18));
    const status = await caller.getGenerationJobStatus({ campaignId: 28, jobId: 902 });
    expect(status).toBeNull();
  });

  it("returns null when a creative run is not a content_generation_job", async () => {
    const { getDb } = await import("./queries/connection");
    const { contentRouter } = await import("./content-router");

    vi.mocked(getDb).mockReturnValue(
      createMockDb({
        campaign: {
          id: 28,
          userId: 18,
          businessId: 24,
          workflowState: "creatives_ready",
          workflowContext: {},
          personas: [{ name: "Small Business Owner" }],
          coreMessage: "Empower your workforce",
        },
        postCount: 0,
        agentRunsRows: [
          {
            id: 903,
            userId: 18,
            campaignId: 28,
            agentType: "creative",
            status: "completed",
            input: { jobType: "other_job" },
            createdAt: new Date(),
          },
        ],
      }) as unknown as ReturnType<typeof getDb>
    );

    const caller = contentRouter.createCaller(buildCtx(18));
    const status = await caller.getGenerationJobStatus({ campaignId: 28, jobId: 903 });
    expect(status).toBeNull();
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
    metadata: {
      approved: true,
      assetKind: "master_campaign_post",
      imageStatus: "ready",
      imageUrl: "https://example.com/master-image.png",
    },
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

  it("Campaign #23 regression: connected Facebook and Instagram integrations produce non-empty publishablePlatforms", async () => {
    const { getDb } = await import("./queries/connection");
    const { publishSinglePost } = await import("./lib/workflow/publishing-runner");
    const { isFacebookPublishingReady, isInstagramPublishingReady } = await import(
      "./lib/integrations/platforms"
    );
    const { contentRouter } = await import("./content-router");

    vi.mocked(publishSinglePost).mockResolvedValue({
      id: 123,
      status: "published",
      platform: "instagram",
      postId: "ext-123",
    } as any);
    vi.mocked(isFacebookPublishingReady).mockReturnValue(true);
    vi.mocked(isInstagramPublishingReady).mockReturnValue(true);

    const campaign23Publish = {
      id: 23,
      userId: 14,
      businessId: 20,
      status: "draft",
      workflowState: "creatives_ready",
      platforms: "Facebook, Instagram",
      name: "3@1 Newmarket Campaign",
      aiGenerated: true,
    };

    const post = {
      id: 109,
      userId: 14,
      campaignId: 23,
      type: "social_post",
      platform: "Instagram",
      status: "draft",
      metadata: {
        approved: true,
        assetKind: "master_campaign_post",
        imageStatus: "ready",
        imageUrl: "/generated/images/23/premium-leaflet-internal_12ad3497-86bb-4c5b-9759-93bf8da278b9.png",
      },
    };

    const fbIntegration = {
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

    const igIntegration = {
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

    const mockDb = createMockDb({
      campaign: campaign23Publish,
      posts: [post],
      integrations: [fbIntegration, igIntegration],
      assets: [{ id: 1, userId: 14, campaignId: 23, assetType: "caption_adaptation" }],
      queue: [],
    });
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    const caller = contentRouter.createCaller(buildCtx(14));
    const result = await caller.publishCampaignPack({ campaignId: 23 });

    expect(result.manualPosting).toBeFalsy();
    expect(result.publishedCount).toBe(2);
    expect(result.failedCount).toBe(0);
  });

  it("partial publish: Facebook pending approval for medium safety risk, Instagram publishes, retry does not duplicate Instagram", async () => {
    const { getDb } = await import("./queries/connection");
    const { publishSinglePost } = await import("./lib/workflow/publishing-runner");
    const { checkContentSafety } = await import("./lib/safety/checker");
    const { contentRouter } = await import("./content-router");

    vi.mocked(publishSinglePost).mockResolvedValue({
      id: 123,
      status: "published",
      platform: "instagram",
      postId: "ext-ig",
    } as any);

    vi.mocked(checkContentSafety).mockImplementation(async (content: string) => {
      if (content.toLowerCase().includes("facebook")) {
        return {
          riskLevel: "medium",
          reasons: ["Pricing claim requires review"],
          suggestedFixes: [],
        };
      }
      return { riskLevel: "low", reasons: [], suggestedFixes: [] };
    });

    const campaign23Publish = {
      id: 23,
      userId: 14,
      businessId: 20,
      status: "draft",
      workflowState: "creatives_ready",
      platforms: "Facebook, Instagram",
      name: "3@1 Newmarket Campaign",
      aiGenerated: true,
    };

    const fbPost = {
      id: 110,
      userId: 14,
      campaignId: 23,
      type: "social_post",
      platform: "Facebook",
      status: "draft",
      hook: "Facebook hook",
      caption: "Exclusive facebook offer",
      cta: "Shop now",
      metadata: {
        approved: true,
        assetKind: "social_post",
        imageStatus: "ready",
        imageUrl: "https://example.com/fb.png",
      },
    };

    const igPost = {
      id: 109,
      userId: 14,
      campaignId: 23,
      type: "social_post",
      platform: "Instagram",
      status: "draft",
      hook: "Instagram hook",
      caption: "Exclusive instagram offer",
      cta: "Shop now",
      metadata: {
        approved: true,
        assetKind: "social_post",
        imageStatus: "ready",
        imageUrl: "https://example.com/ig.png",
      },
    };

    const fbIntegration = {
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

    const igIntegration = {
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

    const mockDb = createMockDb({
      campaign: campaign23Publish,
      posts: [fbPost, igPost],
      integrations: [fbIntegration, igIntegration],
      assets: [{ id: 1, userId: 14, campaignId: 23, assetType: "caption_adaptation" }],
      queue: [],
    });
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    const caller = contentRouter.createCaller(buildCtx(14));
    const result = await caller.publishCampaignPack({ campaignId: 23 });

    expect(result.publishedCount).toBe(1);
    expect(result.pendingApprovalCount).toBe(1);
    expect(result.results.find((r) => r.platform === "instagram")?.status).toBe("published");
    expect(result.results.find((r) => r.platform === "facebook")?.status).toBe("pending_approval");

    // Retry with existing queue items: Instagram already published, Facebook pending approval.
    const retryDb = createMockDb({
      campaign: campaign23Publish,
      posts: [fbPost, igPost],
      integrations: [fbIntegration, igIntegration],
      assets: [{ id: 1, userId: 14, campaignId: 23, assetType: "caption_adaptation" }],
      queue: [
        {
          id: 1,
          userId: 14,
          campaignId: 23,
          contentPostId: 109,
          platform: "instagram",
          status: "published",
          externalPostId: "ext-ig",
          approvalRequired: false,
        },
        {
          id: 2,
          userId: 14,
          campaignId: 23,
          contentPostId: 110,
          platform: "facebook",
          status: "pending_approval",
          approvalRequired: true,
          lastError: "Content safety check flagged medium risk; awaiting approval",
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(retryDb as unknown as ReturnType<typeof getDb>);

    const retryResult = await caller.publishCampaignPack({ campaignId: 23 });
    expect(retryResult.publishedCount).toBe(1);
    expect(retryResult.pendingApprovalCount).toBe(1);

    const retryQueueInsertSpy = retryDb.insertValuesByTableName.get("publishing_queue");
    const retryPlatforms = retryQueueInsertSpy?.mock.calls.map((call) => (call[0] as any).platform) || [];
    expect(retryPlatforms).not.toContain("instagram");
  });

  it("finalizes campaign to campaign_live when all queue rows are published after Facebook approve-and-publish", async () => {
    const { getDb } = await import("./queries/connection");

    const campaign23Publish = {
      id: 23,
      userId: 14,
      businessId: 20,
      status: "active",
      workflowState: "launch_approval_required",
      platforms: "Facebook, Instagram",
      name: "3@1 Newmarket Campaign",
      aiGenerated: true,
    };

    const masterPost = {
      id: 109,
      userId: 14,
      campaignId: 23,
      type: "social_post",
      platform: "Instagram",
      status: "draft",
      metadata: { approved: true, assetKind: "master_campaign_post", imageStatus: "ready", imageUrl: "https://example.com/ig.png" },
    };

    const mockDb = createMockDb({
      campaign: campaign23Publish,
      posts: [masterPost],
      queue: [
        {
          id: 6,
          userId: 14,
          campaignId: 23,
          contentPostId: 109,
          platform: "instagram",
          status: "published",
          externalPostId: "18106085213021936",
          approvalRequired: false,
        },
        {
          id: 5,
          userId: 14,
          campaignId: 23,
          contentPostId: 109,
          platform: "facebook",
          status: "published",
          externalPostId: "122144189559083955",
          approvalRequired: false,
        },
      ],
      approvals: [
        {
          id: 1,
          userId: 14,
          campaignId: 23,
          approvalType: "campaign_launch",
          status: "pending",
          title: "Approve Launch",
          riskLevel: "low",
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    // Simulate the per-platform approve-and-publish path finalizing the campaign.
    await finalizeCampaignPublishState(23);

    const campaignUpdate = mockDb.updateSetByTableName.get("campaigns")?.mock.calls[0]?.[0];
    expect(campaignUpdate).toMatchObject({
      status: "active",
      workflowState: "campaign_live",
    });

    const contentPostUpdate = mockDb.updateSetByTableName.get("content_posts")?.mock.calls[0]?.[0];
    expect(contentPostUpdate.metadata).toMatchObject({
      publishedPlatforms: expect.arrayContaining(["facebook", "instagram"]),
      failedPlatforms: [],
      pendingApprovalPlatforms: [],
      facebookPostId: "122144189559083955",
      instagramPostId: "18106085213021936",
    });

    const approvalUpdate = mockDb.updateSetByTableName.get("approval_requests")?.mock.calls[0]?.[0];
    expect(approvalUpdate).toMatchObject({ status: "approved" });
  });
});


describe("contentRouter.ensurePublishEligibility", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { isFacebookPublishingReady, isInstagramPublishingReady } = await import("./lib/integrations/platforms");
    vi.mocked(isFacebookPublishingReady).mockReturnValue(true);
    vi.mocked(isInstagramPublishingReady).mockReturnValue(true);
    const { env } = await import("./lib/env");
    env.metaAppId = "test-meta-app-id";
    env.metaAppSecret = "test-meta-secret";
    env.metaRedirectUri = "http://localhost/callback";
    env.linkedinClientId = "test-linkedin-id";
    env.linkedinClientSecret = "test-linkedin-secret";
    env.linkedinRedirectUri = "http://localhost/callback";
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

    expect(result.platformStatuses).toEqual([
      { platform: "Facebook", status: "connected" },
      { platform: "Instagram", status: "connected" },
    ]);
    expect(result.platformStatuses.some((s) => s.status === "manual")).toBe(false);

    const approvalInsertSpy = mockDb.insertValuesByTableName.get("approval_requests");
    expect(approvalInsertSpy).toBeUndefined();
  });

  it("draft social_post with ready image and approved launch approval is publishable (does not require metadata.approved)", async () => {
    const { getDb } = await import("./queries/connection");
    const { contentRouter } = await import("./content-router");

    const draftPost = {
      id: 110,
      userId: 14,
      campaignId: 23,
      type: "social_post",
      platform: "Instagram",
      status: "draft",
      metadata: { imageStatus: "ready" },
    };

    const mockDb = createMockDb({
      campaign: campaign23,
      posts: [draftPost],
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
    expect(result.publishablePostCount).toBe(1);
    expect(result.launchApproved).toBe(true);

    expect(result.platformStatuses).toEqual([
      { platform: "Facebook", status: "connected" },
      { platform: "Instagram", status: "connected" },
    ]);
    expect(result.platformStatuses.some((s) => s.status === "manual")).toBe(false);
  });

  it("generic campaign with connected platform but missing launch approval returns launch approval required (not hardcoded to Campaign #23)", async () => {
    const { getDb } = await import("./queries/connection");
    const { contentRouter } = await import("./content-router");

    const genericCampaign = {
      id: 99,
      userId: 55,
      businessId: 77,
      status: "draft",
      workflowState: "creatives_ready",
      platforms: "LinkedIn",
      name: "Generic Test Campaign",
      aiGenerated: true,
    };

    const genericPost = {
      id: 201,
      userId: 55,
      campaignId: 99,
      type: "social_post",
      platform: "LinkedIn",
      status: "draft",
      metadata: { imageStatus: "ready" },
    };

    const genericIntegration = {
      id: 101,
      userId: 55,
      businessId: 77,
      platform: "linkedin",
      status: "connected",
      accountName: "generic-business",
    };

    const mockDb = createMockDb({
      campaign: genericCampaign,
      posts: [genericPost],
      integrations: [genericIntegration],
      assets: [{ id: 2, userId: 55, campaignId: 99, assetType: "caption_pack" }],
      approvals: [],
    });
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    const caller = contentRouter.createCaller(buildCtx(55));
    const result = await caller.ensurePublishEligibility({ campaignId: 99 });

    expect(result.canPublish).toBe(false);
    expect(result.unavailableReason).toBe("launch_approval_required");
    expect(result.unavailableReason).not.toBe("no_publishable_content");
    expect(result.unavailableReason).not.toBe("no_connected_platforms");
    expect(result.connectedIntegrationsFound).toBe(1);
    expect(result.publishablePostCount).toBe(1);
    expect(result.campaignUserId).toBe(55);
    expect(result.businessId).toBe(77);

    const approvalInsertSpy = mockDb.insertValuesByTableName.get("approval_requests");
    expect(approvalInsertSpy).toHaveBeenCalledTimes(1);
    const approvalInsert = approvalInsertSpy!.mock.calls[0][0];
    expect(approvalInsert).toMatchObject({
      userId: 55,
      campaignId: 99,
      approvalType: "campaign_launch",
      status: "pending",
    });
  });

  it("does not return ready when connectedIntegrationsFound > 0 but platformStatuses is empty (production guard)", async () => {
    const { getDb } = await import("./queries/connection");
    const { contentRouter } = await import("./content-router");

    const mockDb = createMockDb({
      campaign: campaign23,
      posts: [approvedPost],
      integrations: [
        { ...facebookIntegration, platform: "" },
        { ...instagramIntegration, platform: "" },
      ],
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

    expect(result.connectedIntegrationsFound).toBe(2);
    expect(result.platformStatuses).toEqual([]);
    expect(result.unavailableReason).not.toBe("ready");
    expect(result.canPublish).toBe(false);
  });

  it("returns the exact ready payload with connected Facebook and Instagram platform statuses", async () => {
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
    expect(result.platformStatuses).toEqual([
      { platform: "Facebook", status: "connected" },
      { platform: "Instagram", status: "connected" },
    ]);
    expect(result.platformStatuses.some((s) => s.status === "connected")).toBe(true);
  });
});
