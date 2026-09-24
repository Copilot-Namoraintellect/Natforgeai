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

vi.mock("./lib/agents/strategy-agent", () => ({
  validateStrategyOutputAgainstCampaign: vi.fn(() => ({ valid: true })),
}));

vi.mock("./lib/creative/brief-grounding", () => ({
  buildGroundedCreativeBrief: vi.fn(() => ({
    fingerprint: "test-fingerprint-ready",
    productOrService: "Business service",
    targetBuyer: "Small business owners",
    mainPainPoint: "Wasting time",
    preferredCta: "Contact us",
    primaryOutcome: "More leads",
    targetAudience: "Small business owners",
    coreMessage: "Empower your workforce",
    offerDetails: "",
    excludedOffers: "",
    referenceStyle: "",
    contentStyle: "",
    businessType: "B2B",
  })),
  computeCreativeBriefFingerprint: vi.fn(() => "test-fingerprint-ready"),
  isApprovedMessagePackCompatible: vi.fn(() => true),
}));

vi.mock("./lib/workflow/triggers", () => ({
  onAgentRunComplete: vi.fn(),
}));

vi.mock("./lib/workflow/strategy-approval", () => ({
  isApprovedStrategyCurrent: vi.fn(() => true),
  isStrategyGeneratedForCurrentBrief: vi.fn(() => true),
  assertApprovedStrategySemanticallyValid: vi.fn(async () => undefined),
  getStrategyApprovalStatus: vi.fn(() => ({
    currentFingerprint: "test-fingerprint-ready",
    strategyFingerprint: "test-fingerprint-ready",
    approvedStrategyFingerprint: "test-fingerprint-ready",
    isCurrent: true,
    hasApprovedStrategy: true,
    strategyGeneratedForCurrentBrief: true,
  })),
}));

vi.mock("./lib/queue/bullmq", () => ({
  scheduleContentGenerationJob: vi.fn(async () => ({ id: "content-generate:28" })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock("./lib/jobs/content-generation-job", () => ({
  processContentGenerationJob: vi.fn(async () => undefined),
}));

vi.mock("./lib/billing/credit-engine", () => ({
  deductCredits: vi.fn(async () => ({ newBalance: 0 })),
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
  calculateLeaseExpiresAt: vi.fn(() => new Date(Date.now() + 1800_000)),
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

/**
 * G-04: launch approval evidence must be corroborated by durable lineage in
 * the campaign workflowContext. Test fixtures pair an approved campaign_launch
 * row (id = approvalRequestId) with this matching lineage.
 */
function launchApprovalContext(approvalRequestId: number) {
  return {
    launchApprovalLineage: {
      creativeBriefFingerprint: "test-fingerprint-ready",
      approvalRequestId,
      status: "approved",
    },
  };
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
  generatedImages?: Record<string, unknown>[];
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
  generatedImages = [],
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
    } else if (tableName === "generated_images") {
      limitResult = generatedImages;
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
    expect(result).toMatchObject({ jobId: expect.any(Number), status: "queued" });
    expect(scheduleContentGenerationJob).toHaveBeenCalledTimes(1);
  });

  it("marks agent run failed and does not deduct credits when enqueue fails", async () => {
    const { getDb } = await import("./queries/connection");
    const { scheduleContentGenerationJob } = await import("./lib/queue/bullmq");
    const { deductCredits } = await import("./lib/billing/credit-engine");
    const { contentRouter } = await import("./content-router");

    vi.mocked(scheduleContentGenerationJob).mockRejectedValueOnce(
      new Error("Custom Id cannot contain :")
    );

    const mockDb = createMockDb({
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
    });

    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    const caller = contentRouter.createCaller(buildCtx());
    await expect(caller.generateForCampaign({ campaignId: 28 })).rejects.toBeInstanceOf(TRPCError);

    const updateSetSpy = mockDb.updateSetByTableName.get("agent_runs");
    expect(updateSetSpy).toBeDefined();
    expect(updateSetSpy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deductCredits)).not.toHaveBeenCalled();
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

  it("returns preparing/in-progress when claim collides before a job reference exists", async () => {
    const { getDb } = await import("./queries/connection");
    const { scheduleContentGenerationJob } = await import("./lib/queue/bullmq");
    const { acquireCreativeGenerationClaim } = await import("./lib/creative/creative-generation-claim");
    const { contentRouter } = await import("./content-router");

    vi.mocked(acquireCreativeGenerationClaim).mockResolvedValueOnce({
      acquired: false,
      existingClaim: {
        id: 2001,
        operationReferenceId: null,
        ownerToken: "hidden-owner-token",
      },
      reason: "active_claim_collision",
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
    const result = await caller.generateForCampaign({ campaignId: 28 });

    expect(result.status).toBe("preparing");
    expect(result.jobId).toBeNull();
    expect(result.reused).toBe(true);
    expect(scheduleContentGenerationJob).not.toHaveBeenCalled();

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("hidden-owner-token");
    expect(serialized).not.toContain('"jobId":0');
    expect(serialized).not.toContain('"jobId": 0');
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

  it("polling returns failed when content-generation job run is failed", async () => {
    const { getDb } = await import("./queries/connection");
    const { contentRouter } = await import("./content-router");

    vi.mocked(getDb).mockReturnValue(
      createMockDb({
        campaign: {
          id: 28,
          userId: 18,
          businessId: 24,
          workflowState: "creatives_generating",
          workflowContext: {},
          personas: [{ name: "Small Business Owner" }],
          coreMessage: "Empower your workforce",
        },
        postCount: 0,
        agentRunsRows: [
          {
            id: 904,
            userId: 18,
            campaignId: 28,
            agentType: "creative",
            status: "failed",
            error: "creative failed",
            input: { jobType: "content_generation_job" },
            createdAt: new Date(),
          },
        ],
      }) as unknown as ReturnType<typeof getDb>
    );

    const caller = contentRouter.createCaller(buildCtx(18));
    const status = await caller.getGenerationJobStatus({ campaignId: 28, jobId: 904 });
    expect(status?.status).toBe("failed");
  });

  it("rejects stale approved strategy with PRECONDITION_FAILED before claiming or queueing", async () => {
    const { getDb } = await import("./queries/connection");
    const { contentRouter } = await import("./content-router");
    const { isApprovedStrategyCurrent } = await import("./lib/workflow/strategy-approval");
    const { scheduleContentGenerationJob } = await import("./lib/queue/bullmq");
    const { acquireCreativeGenerationClaim } = await import("./lib/creative/creative-generation-claim");

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
    vi.mocked(isApprovedStrategyCurrent).mockReturnValueOnce(false);

    const caller = contentRouter.createCaller(buildCtx());
    await expect(caller.generateForCampaign({ campaignId: 28 })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });

    expect(acquireCreativeGenerationClaim).not.toHaveBeenCalled();
    expect(scheduleContentGenerationJob).not.toHaveBeenCalled();
  });

  it("rejects a fingerprint-matching but semantically invalid approved strategy before claim, queue or billing", async () => {
    const { getDb } = await import("./queries/connection");
    const { contentRouter } = await import("./content-router");
    const { assertApprovedStrategySemanticallyValid } = await import("./lib/workflow/strategy-approval");
    const { acquireCreativeGenerationClaim } = await import("./lib/creative/creative-generation-claim");
    const { scheduleContentGenerationJob } = await import("./lib/queue/bullmq");
    const { deductCredits } = await import("./lib/billing/credit-engine");

    vi.mocked(assertApprovedStrategySemanticallyValid).mockRejectedValueOnce(
      new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "The approved strategy no longer matches the current campaign brief: stale audience classification.",
      })
    );

    vi.mocked(getDb).mockReturnValue(
      createMockDb({
        campaign: {
          id: 28,
          userId: 18,
          businessId: 24,
          workflowState: "strategy_approved",
          workflowContext: {
            coreMessage: "Empower your workforce",
            strategyApprovalLineage: {
              creativeBriefFingerprint: "test-fingerprint-ready",
              strategyRunId: 245,
              approvalRequestId: 34,
              status: "approved",
            },
          },
          personas: [{ name: "Small Business Owner" }],
          coreMessage: "Empower your workforce",
        },
        postCount: 0,
        agentRunsRows: [
          {
            id: 245,
            userId: 18,
            campaignId: 28,
            agentType: "strategy",
            status: "completed",
            output: { creativeBriefFingerprint: "test-fingerprint-ready", __invalid: true },
          },
        ],
      }) as unknown as ReturnType<typeof getDb>
    );

    const caller = contentRouter.createCaller(buildCtx());
    await expect(caller.generateForCampaign({ campaignId: 28 })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });

    expect(acquireCreativeGenerationClaim).not.toHaveBeenCalled();
    expect(scheduleContentGenerationJob).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
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
    productOrService: "Business service",
    targetBuyer: "Small business owners",
    mainPainPoint: "Wasting time",
    primaryOutcome: "More leads",
    coreMessage: "Empower your workforce",
    workflowContext: launchApprovalContext(1),
  };

  const basePost = {
    id: 125,
    userId: 18,
    campaignId: 28,
    type: "social_post",
    platform: "Instagram",
    status: "draft",
    hook: "Save time every week",
    caption: "AI-powered marketing for small business",
    cta: "Get started today",
    metadata: {
      approved: true,
      assetKind: "master_campaign_post",
      imageStatus: "ready",
      imageUrl: "https://example.com/master-image.png",
      creativeBriefFingerprint: "test-fingerprint-ready",
    },
  };

  const baseApproval = {
    id: 1,
    userId: 18,
    campaignId: 28,
    approvalType: "campaign_launch",
    status: "approved",
    title: "Approve Launch",
    riskLevel: "low",
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
    metadata: {
      creativeBriefFingerprint: "test-fingerprint-ready",
    },
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
      approvals: [baseApproval],
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

    expect(publishSinglePost).toHaveBeenCalledWith(
      123,
      expect.objectContaining({
        publishPackage: expect.objectContaining({
          packageId: expect.stringMatching(/^ppv1-/),
          packageFingerprintSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          classification: "legacy",
        }),
      })
    );
  });

  it("surfaces the immutable publish package identity in publish results", async () => {
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
      approvals: [baseApproval],
    });
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    const caller = contentRouter.createCaller(buildCtx());
    const result = await caller.publishCampaignPack({ campaignId: 28 });

    // Ungoverned fixtures (no durable artifact lineage anywhere) must be
    // classified legacy explicitly — never silently governed.
    const entry = result.results.find((r) => r.platform === "instagram");
    expect(entry?.publishPackageClassification).toBe("legacy");
    expect(entry?.publishPackageId).toEqual(expect.stringMatching(/^ppv1-/));
    expect(entry?.publishPackageFingerprint).toEqual(expect.stringMatching(/^[0-9a-f]{64}$/));

    const handedPackage = vi.mocked(publishSinglePost).mock.calls[0][1]?.publishPackage!;
    expect(handedPackage).toBeDefined();
    expect(handedPackage.identity.selectedContent.artifactId).toBe(125);
    expect(handedPackage.identity.destination.platform).toBe("instagram");
    expect(handedPackage.payload.text).toBe("Save time every week\n\nAI-powered marketing for small business\n\nGet started today");
    expect(handedPackage.payload.mediaUrls).toEqual(["https://example.com/master-image.png"]);
    expect(Object.isFrozen(handedPackage)).toBe(true);
  });

  it("fails the platform closed when governed caption lineage mismatches the package Strategy authority", async () => {
    const { getDb } = await import("./queries/connection");
    const { publishSinglePost } = await import("./lib/workflow/publishing-runner");
    const { getStrategyApprovalStatus } = await import("./lib/workflow/strategy-approval");
    const { contentRouter } = await import("./content-router");
    const { deriveCreativeArtifactLineageFingerprint } = await import("./lib/creative/artifact-lineage");

    const APPROVED_COPY = {
      copyHashSha256: "ef".repeat(32),
      copySchemaVersion: "v2",
      approvedRevisionId: "rev-1",
      assessmentHashSha256: "12".repeat(32),
      contextLockId: "ctx-1",
    };
    const packageStrategy = {
      creativeBriefFingerprint: "test-fingerprint-ready",
      approvalRequestId: 2,
      status: "approved" as const,
      strategyRunId: 42,
      strategySnapshotId: "snap-1",
      strategyVersion: 1,
      businessDnaSnapshotId: "bdna-1",
      strategyHashSha256: "ab".repeat(32),
    };
    vi.mocked(getStrategyApprovalStatus).mockReturnValueOnce({
      currentFingerprint: "test-fingerprint-ready",
      strategyFingerprint: "test-fingerprint-ready",
      approvedStrategyFingerprint: "test-fingerprint-ready",
      isCurrent: true,
      hasApprovedStrategy: true,
      strategyGeneratedForCurrentBrief: true,
      lineage: packageStrategy,
    } as any);

    const captionLineageFor = (strategy: typeof packageStrategy) => ({
      lineageSchemaVersion: 1,
      artifactKind: "caption_pack",
      platform: null,
      parent: null,
      lineageFingerprintSha256: deriveCreativeArtifactLineageFingerprint({
        artifactKind: "caption_pack",
        platform: null,
        parent: null,
        strategy,
        approvedCopy: APPROVED_COPY,
      }),
      strategy,
      approvedCopy: APPROVED_COPY,
    });

    // Fully governed fixture: durable lineage on the selected post, the
    // caption pack, and the rendered image — all bound to packageStrategy.
    const governedPost = {
      ...basePost,
      metadata: {
        ...basePost.metadata,
        creativeArtifactLineage: {
          lineageSchemaVersion: 1,
          artifactKind: "content_post",
          artifactId: 125,
          lineageFingerprintSha256: "34".repeat(32),
          strategy: packageStrategy,
          approvedCopy: APPROVED_COPY,
        },
      },
    };

    // Caption pack lineage is internally consistent but bound to a DIFFERENT
    // Strategy authority than the campaign's approved WBS11 authority.
    const foreignStrategy = { ...packageStrategy, strategyHashSha256: "cd".repeat(32) };

    const mockDb = createMockDb({
      campaign: baseCampaign,
      posts: [governedPost],
      integrations: [baseIntegration],
      assets: [
        {
          id: 5,
          userId: 18,
          campaignId: 28,
          assetType: "caption_pack",
          metadata: {
            creativeBriefFingerprint: "test-fingerprint-ready",
            creativeArtifactLineage: captionLineageFor(foreignStrategy),
          },
        },
      ],
      queue: [],
      approvals: [baseApproval],
      generatedImages: [
        {
          id: 55,
          userId: 18,
          campaignId: 28,
          contentPostId: 125,
          status: "completed",
          metadata: {
            renderLineage: {
              lineageSchemaVersion: 1,
              contentPostId: 125,
              lineageFingerprintSha256: "56".repeat(32),
              strategy: packageStrategy,
              approvedCopy: APPROVED_COPY,
            },
          },
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    const caller = contentRouter.createCaller(buildCtx());
    const result = await caller.publishCampaignPack({ campaignId: 28 });

    // Fail closed: the platform is failed, not published from mismatched lineage.
    expect(result.publishedCount).toBe(0);
    expect(result.failedCount).toBe(1);
    expect(result.results.find((r) => r.platform === "instagram")?.status).toBe("failed");
    expect(result.results.find((r) => r.platform === "instagram")?.error).toMatch(/Strategy authority/);
    expect(publishSinglePost).not.toHaveBeenCalled();

    // WBS13.4: package construction failed BEFORE any queue insert, so no
    // executable governed row ever existed. The failure evidence row is
    // inserted directly in a non-executable failed state with NO governed
    // metadata — it stays legacy forever.
    const insertValuesSpy = mockDb.insertValuesByTableName.get("publishing_queue");
    expect(insertValuesSpy).toHaveBeenCalledTimes(1);
    const inserted = insertValuesSpy!.mock.calls[0][0];
    expect(inserted.status).toBe("failed");
    expect(inserted.metadata).toBeUndefined();
    expect(mockDb.updateSetByTableName.get("publishing_queue")).toBeUndefined();
  });

  it("persists the durable publish package atomically with the governed queue insert", async () => {
    const { getDb } = await import("./queries/connection");
    const { publishSinglePost } = await import("./lib/workflow/publishing-runner");
    const { contentRouter } = await import("./content-router");
    const {
      QUEUE_PUBLISH_PACKAGE_METADATA_KEY,
      QUEUE_PUBLISH_PACKAGE_REQUIRED_METADATA_KEY,
      loadPersistedPublishPackage,
    } = await import("./lib/publish/publish-package-queue-store");

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
      approvals: [baseApproval],
    });
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    const caller = contentRouter.createCaller(buildCtx());
    await caller.publishCampaignPack({ campaignId: 28 });

    // Exactly ONE queue insert — the row and its package persist together
    // (no duplicate persistence, no separate package write).
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
    expect(inserted.metadata[QUEUE_PUBLISH_PACKAGE_REQUIRED_METADATA_KEY]).toBe(true);
    const envelope = inserted.metadata[QUEUE_PUBLISH_PACKAGE_METADATA_KEY];
    expect(envelope.kind).toBe("publish_package");
    expect(envelope.schemaVersion).toBe(1);

    // The durable package round-trips exactly to the package handed to the runner.
    const handedPackage = vi.mocked(publishSinglePost).mock.calls[0][1]?.publishPackage!;
    expect(envelope.publishPackage.packageId).toBe(handedPackage.packageId);
    const reloaded = loadPersistedPublishPackage(inserted.metadata);
    expect(reloaded).toEqual(handedPackage);
    expect(reloaded!.packageFingerprintSha256).toBe(handedPackage.packageFingerprintSha256);
    expect(reloaded!.payload).toEqual(handedPackage.payload);

    // Persistence precedes execution: the durable insert lands before the
    // runner is invoked.
    expect(insertValuesSpy!.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(publishSinglePost).mock.invocationCallOrder[0]
    );
  });

  it("persists the package onto a reused approved queue row so worker/cron retries reload it", async () => {
    const { getDb } = await import("./queries/connection");
    const { publishSinglePost } = await import("./lib/workflow/publishing-runner");
    const { contentRouter } = await import("./content-router");
    const { loadPersistedPublishPackage } = await import(
      "./lib/publish/publish-package-queue-store"
    );

    vi.mocked(publishSinglePost).mockResolvedValue({
      id: 77,
      status: "published",
      platform: "instagram",
      postId: "ext-77",
    } as any);

    const mockDb = createMockDb({
      campaign: baseCampaign,
      posts: [basePost],
      integrations: [baseIntegration],
      assets: [captionAsset],
      queue: [
        {
          id: 77,
          userId: 18,
          campaignId: 28,
          contentPostId: 125,
          integrationId: 7,
          platform: "instagram",
          status: "approved",
          approvalRequired: false,
          retryCount: 0,
          maxRetries: 3,
          scheduledAt: null,
          nextRetryAt: null,
          metadata: null,
        },
      ],
      approvals: [baseApproval],
    });
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    const caller = contentRouter.createCaller(buildCtx());
    const result = await caller.publishCampaignPack({ campaignId: 28 });

    const entry = result.results.find((r) => r.platform === "instagram");
    expect(entry?.status).toBe("published");
    expect(entry?.queueItemId).toBe(77);

    // No new queue row — the reused row gets a metadata-only update.
    expect(mockDb.insertValuesByTableName.get("publishing_queue")).toBeUndefined();
    const updateSpy = mockDb.updateSetByTableName.get("publishing_queue");
    expect(updateSpy).toBeDefined();
    const setPayload = updateSpy!.mock.calls[0][0];
    expect(Object.keys(setPayload)).toEqual(["metadata"]);

    const handedPackage = vi.mocked(publishSinglePost).mock.calls[0][1]?.publishPackage!;
    const reloaded = loadPersistedPublishPackage(setPayload.metadata);
    expect(reloaded).toEqual(handedPackage);
    expect(publishSinglePost).toHaveBeenCalledWith(
      77,
      expect.objectContaining({ publishPackage: expect.any(Object) })
    );
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
      approvals: [baseApproval],
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
      approvals: [baseApproval],
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
      approvals: [baseApproval],
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
    // Integration-unready rows are created legacy — no governed marker.
    expect(inserted.metadata).toBeUndefined();
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
      productOrService: "Business service",
      targetBuyer: "Small business owners",
      mainPainPoint: "Wasting time",
      primaryOutcome: "More leads",
      coreMessage: "Empower your workforce",
      workflowContext: launchApprovalContext(1),
    };

    const post = {
      id: 109,
      userId: 14,
      campaignId: 23,
      type: "social_post",
      platform: "Instagram",
      status: "draft",
      hook: "Newmarket launch",
      caption: "Visit us at 3@1 Newmarket",
      cta: "Learn more",
      metadata: {
        approved: true,
        assetKind: "master_campaign_post",
        imageStatus: "ready",
        imageUrl: "/generated/images/23/premium-leaflet-internal_12ad3497-86bb-4c5b-9759-93bf8da278b9.png",
        creativeBriefFingerprint: "test-fingerprint-ready",
      },
    };

    const campaign23Approval = {
      id: 1,
      userId: 14,
      campaignId: 23,
      approvalType: "campaign_launch",
      status: "approved",
      title: "Approve Launch",
      riskLevel: "low",
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
      assets: [{ id: 1, userId: 14, campaignId: 23, assetType: "caption_adaptation", metadata: { creativeBriefFingerprint: "test-fingerprint-ready" } }],
      queue: [],
      approvals: [campaign23Approval],
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
      productOrService: "Business service",
      targetBuyer: "Small business owners",
      mainPainPoint: "Wasting time",
      primaryOutcome: "More leads",
      coreMessage: "Empower your workforce",
      workflowContext: launchApprovalContext(1),
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
        creativeBriefFingerprint: "test-fingerprint-ready",
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
        assetKind: "master_campaign_post",
        imageStatus: "ready",
        imageUrl: "https://example.com/ig.png",
        creativeBriefFingerprint: "test-fingerprint-ready",
      },
    };

    const campaign23Approval = {
      id: 1,
      userId: 14,
      campaignId: 23,
      approvalType: "campaign_launch",
      status: "approved",
      title: "Approve Launch",
      riskLevel: "low",
    };

    const readyCaptionAsset = { id: 1, userId: 14, campaignId: 23, assetType: "caption_adaptation", metadata: { creativeBriefFingerprint: "test-fingerprint-ready" } };

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
      assets: [readyCaptionAsset],
      queue: [],
      approvals: [campaign23Approval],
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
      assets: [readyCaptionAsset],
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
      approvals: [campaign23Approval],
    });
    vi.mocked(getDb).mockReturnValue(retryDb as unknown as ReturnType<typeof getDb>);

    const retryResult = await caller.publishCampaignPack({ campaignId: 23 });
    expect(retryResult.publishedCount).toBe(1);
    expect(retryResult.pendingApprovalCount).toBe(1);

    const retryQueueInsertSpy = retryDb.insertValuesByTableName.get("publishing_queue");
    const retryPlatforms = retryQueueInsertSpy?.mock.calls.map((call) => (call[0] as any).platform) || [];
    expect(retryPlatforms).not.toContain("instagram");
  });

  it("does not fabricate campaign_live before governed launch approval even when all queue rows are published (G-04)", async () => {
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

    // P1.1 governance boundary: all-published queue rows alone are not
    // sufficient authority to fabricate campaign_live. Until the campaign has
    // passed human launch approval and entered publication_pending, the
    // campaign state must remain untouched.
    const campaignUpdateSpy = mockDb.updateSetByTableName.get("campaigns");
    expect(campaignUpdateSpy).toBeUndefined();

    const contentPostUpdate = mockDb.updateSetByTableName.get("content_posts")?.mock.calls[0]?.[0];
    expect(contentPostUpdate.metadata).toMatchObject({
      publishedPlatforms: expect.arrayContaining(["facebook", "instagram"]),
      failedPlatforms: [],
      pendingApprovalPlatforms: [],
      facebookPostId: "122144189559083955",
      instagramPostId: "18106085213021936",
    });

    // G-04 fail-closed: finalize must never convert the pending launch approval
    // into an approval decision; it stays pending for a human decision.
    const approvalUpdateSpy = mockDb.updateSetByTableName.get("approval_requests");
    expect(approvalUpdateSpy).toBeUndefined();
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
    workflowContext: launchApprovalContext(99),
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

  it("legacy eligibility true but missing leaflet => canPublish false", async () => {
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

    // Phase 2B: legacy eligibility must agree with server readiness.
    expect(result.canPublish).toBe(false);
    expect(result.unavailableReason).toBe("ready");
    expect(result.readiness.ready).toBe(false);
    expect(result.readiness.reasons).toContain("leaflet_missing");
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

  it("draft social_post with ready image and approved launch approval is not publishable without a durable current leaflet", async () => {
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

    // Phase 2B: legacy eligibility alone is no longer sufficient.
    expect(result.canPublish).toBe(false);
    expect(result.unavailableReason).toBe("ready");
    expect(result.readiness.ready).toBe(false);
    expect(result.readiness.reasons).toContain("leaflet_missing");
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

  it("returns the exact ready payload with connected Facebook and Instagram platform statuses but canPublish false without leaflet", async () => {
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

    expect(result.canPublish).toBe(false);
    expect(result.unavailableReason).toBe("ready");
    expect(result.readiness.ready).toBe(false);
    expect(result.readiness.reasons).toContain("leaflet_missing");
    expect(result.platformStatuses).toEqual([
      { platform: "Facebook", status: "connected" },
      { platform: "Instagram", status: "connected" },
    ]);
    expect(result.platformStatuses.some((s) => s.status === "connected")).toBe(true);
  });

  it("legacy eligibility true + complete current output => canPublish true", async () => {
    const { getDb } = await import("./queries/connection");
    const { contentRouter } = await import("./content-router");

    const completeCampaign = {
      ...campaign23,
      productOrService: "Business service",
      targetBuyer: "Small business owners",
      mainPainPoint: "Wasting time",
      primaryOutcome: "More leads",
      coreMessage: "Empower your workforce",
    };

    const currentPost = {
      ...approvedPost,
      metadata: {
        ...approvedPost.metadata,
        creativeBriefFingerprint: "test-fingerprint-ready",
      },
    };

    const leafletPost = {
      id: 112,
      userId: 14,
      campaignId: 23,
      type: "social_post",
      platform: "Instagram",
      status: "draft",
      metadata: {
        assetKind: "master_campaign_post",
        imageUrl: "https://example.com/leaflet.png",
        creativeBriefFingerprint: "test-fingerprint-ready",
      },
    };

    const currentCaptionPack = {
      id: 2,
      userId: 14,
      campaignId: 23,
      assetType: "caption_pack",
      metadata: { creativeBriefFingerprint: "test-fingerprint-ready" },
    };

    const currentSupportingAsset = {
      id: 3,
      userId: 14,
      campaignId: 23,
      assetType: "ad_copy",
      metadata: { creativeBriefFingerprint: "test-fingerprint-ready" },
    };

    const mockDb = createMockDb({
      campaign: completeCampaign,
      posts: [currentPost, leafletPost],
      integrations: [facebookIntegration, instagramIntegration],
      assets: [currentCaptionPack, currentSupportingAsset],
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
    expect(result.readiness.ready).toBe(true);
    expect(result.readiness.reasons).toEqual([]);
  });

  it("legacy eligibility true + stale output => canPublish false", async () => {
    const { getDb } = await import("./queries/connection");
    const { contentRouter } = await import("./content-router");

    const completeCampaign = {
      ...campaign23,
      productOrService: "Business service",
      targetBuyer: "Small business owners",
      mainPainPoint: "Wasting time",
      primaryOutcome: "More leads",
      coreMessage: "Empower your workforce",
    };

    const currentPost = {
      ...approvedPost,
      metadata: {
        ...approvedPost.metadata,
        creativeBriefFingerprint: "test-fingerprint-ready",
      },
    };

    const leafletPost = {
      id: 112,
      userId: 14,
      campaignId: 23,
      type: "social_post",
      platform: "Instagram",
      status: "draft",
      metadata: {
        assetKind: "master_campaign_post",
        imageUrl: "https://example.com/leaflet.png",
        creativeBriefFingerprint: "test-fingerprint-ready",
      },
    };

    const currentCaptionPack = {
      id: 2,
      userId: 14,
      campaignId: 23,
      assetType: "caption_pack",
      metadata: { creativeBriefFingerprint: "test-fingerprint-ready" },
    };

    const staleSupportingAsset = {
      id: 3,
      userId: 14,
      campaignId: 23,
      assetType: "ad_copy",
      metadata: { creativeBriefFingerprint: "stale-fingerprint" },
    };

    const mockDb = createMockDb({
      campaign: completeCampaign,
      posts: [currentPost, leafletPost],
      integrations: [facebookIntegration, instagramIntegration],
      assets: [currentCaptionPack, staleSupportingAsset],
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

    expect(result.canPublish).toBe(false);
    expect(result.unavailableReason).toBe("ready");
    expect(result.readiness.ready).toBe(false);
    expect(result.readiness.reasons).toContain("output_stale");
  });

  it("readiness true + disconnected required platform => canPublish false", async () => {
    const { getDb } = await import("./queries/connection");
    const { contentRouter } = await import("./content-router");

    const completeCampaign = {
      ...campaign23,
      productOrService: "Business service",
      targetBuyer: "Small business owners",
      mainPainPoint: "Wasting time",
      primaryOutcome: "More leads",
      coreMessage: "Empower your workforce",
    };

    const currentPost = {
      ...approvedPost,
      metadata: {
        ...approvedPost.metadata,
        creativeBriefFingerprint: "test-fingerprint-ready",
      },
    };

    const leafletPost = {
      id: 112,
      userId: 14,
      campaignId: 23,
      type: "social_post",
      platform: "Instagram",
      status: "draft",
      metadata: {
        assetKind: "master_campaign_post",
        imageUrl: "https://example.com/leaflet.png",
        creativeBriefFingerprint: "test-fingerprint-ready",
      },
    };

    const currentCaptionPack = {
      id: 2,
      userId: 14,
      campaignId: 23,
      assetType: "caption_pack",
      metadata: { creativeBriefFingerprint: "test-fingerprint-ready" },
    };

    const mockDb = createMockDb({
      campaign: completeCampaign,
      posts: [currentPost, leafletPost],
      integrations: [],
      assets: [currentCaptionPack],
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

    expect(result.canPublish).toBe(false);
    expect(result.unavailableReason).toBe("no_connected_platforms");
    expect(result.readiness.ready).toBe(true);
    expect(result.readiness.reasons).toEqual([]);
  });
});


describe("contentRouter.publishCampaignPack Phase 2B gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const readyCampaign = {
    id: 28,
    userId: 18,
    businessId: 24,
    status: "draft",
    workflowState: "creatives_ready",
    platforms: "instagram",
    productOrService: "Business service",
    targetBuyer: "Small business owners",
    mainPainPoint: "Wasting time",
    primaryOutcome: "More leads",
    coreMessage: "Empower your workforce",
    workflowContext: launchApprovalContext(1),
  };

  const readyLeafletPost = {
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
      creativeBriefFingerprint: "test-fingerprint-ready",
    },
  };

  const readyCaptionAsset = {
    id: 1,
    userId: 18,
    campaignId: 28,
    assetType: "caption_adaptation",
    metadata: { creativeBriefFingerprint: "test-fingerprint-ready" },
  };

  const readyApproval = {
    id: 1,
    userId: 18,
    campaignId: 28,
    approvalType: "campaign_launch",
    status: "approved",
    title: "Approve Launch",
    riskLevel: "low",
  };

  it("rejects when no durable leaflet exists and creates no queue row", async () => {
    const { getDb } = await import("./queries/connection");
    const { publishSinglePost } = await import("./lib/workflow/publishing-runner");
    const { contentRouter } = await import("./content-router");

    const postWithoutLeaflet = {
      ...readyLeafletPost,
      metadata: {
        ...readyLeafletPost.metadata,
        assetKind: "social_post",
      },
    };

    const mockDb = createMockDb({
      campaign: readyCampaign,
      posts: [postWithoutLeaflet],
      integrations: [],
      assets: [readyCaptionAsset],
      queue: [],
      approvals: [readyApproval],
    });
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    const caller = contentRouter.createCaller(buildCtx());
    await expect(caller.publishCampaignPack({ campaignId: 28 })).rejects.toThrow(
      "Marketing Leaflet is missing"
    );

    expect(mockDb.insertValuesByTableName.has("publishing_queue")).toBe(false);
    expect(publishSinglePost).not.toHaveBeenCalled();
  });

  it("rejects when a generic image is used instead of an explicit leaflet", async () => {
    const { getDb } = await import("./queries/connection");
    const { publishSinglePost } = await import("./lib/workflow/publishing-runner");
    const { contentRouter } = await import("./content-router");

    const genericImagePost = {
      ...readyLeafletPost,
      metadata: {
        ...readyLeafletPost.metadata,
        assetKind: "social_post",
        imageSource: "openai",
      },
    };

    const mockDb = createMockDb({
      campaign: readyCampaign,
      posts: [genericImagePost],
      integrations: [],
      assets: [readyCaptionAsset],
      queue: [],
      approvals: [readyApproval],
    });
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    const caller = contentRouter.createCaller(buildCtx());
    await expect(caller.publishCampaignPack({ campaignId: 28 })).rejects.toThrow(
      "Marketing Leaflet is missing"
    );
    expect(publishSinglePost).not.toHaveBeenCalled();
  });

  it("rejects when the leaflet has no creativeBriefFingerprint and creates no queue row", async () => {
    const { getDb } = await import("./queries/connection");
    const { publishSinglePost } = await import("./lib/workflow/publishing-runner");
    const { contentRouter } = await import("./content-router");

    const staleLeafletPost = {
      ...readyLeafletPost,
      metadata: {
        ...readyLeafletPost.metadata,
        creativeBriefFingerprint: undefined,
      },
    };

    const mockDb = createMockDb({
      campaign: readyCampaign,
      posts: [staleLeafletPost],
      integrations: [],
      assets: [readyCaptionAsset],
      queue: [],
      approvals: [readyApproval],
    });
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    const caller = contentRouter.createCaller(buildCtx());
    await expect(caller.publishCampaignPack({ campaignId: 28 })).rejects.toThrow(
      "Marketing Leaflet is stale"
    );
    expect(mockDb.insertValuesByTableName.has("publishing_queue")).toBe(false);
    expect(publishSinglePost).not.toHaveBeenCalled();
  });

  it("rejects when the caption pack is missing", async () => {
    const { getDb } = await import("./queries/connection");
    const { publishSinglePost } = await import("./lib/workflow/publishing-runner");
    const { contentRouter } = await import("./content-router");

    const mockDb = createMockDb({
      campaign: readyCampaign,
      posts: [readyLeafletPost],
      integrations: [],
      assets: [],
      queue: [],
      approvals: [readyApproval],
    });
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    const caller = contentRouter.createCaller(buildCtx());
    await expect(caller.publishCampaignPack({ campaignId: 28 })).rejects.toThrow(
      "Caption pack is missing"
    );
    expect(publishSinglePost).not.toHaveBeenCalled();
  });

  it("rejects when the caption pack fingerprint does not match the current campaign", async () => {
    const { getDb } = await import("./queries/connection");
    const { publishSinglePost } = await import("./lib/workflow/publishing-runner");
    const { contentRouter } = await import("./content-router");

    const staleCaptionAsset = {
      ...readyCaptionAsset,
      metadata: { creativeBriefFingerprint: "stale-fingerprint" },
    };

    const mockDb = createMockDb({
      campaign: readyCampaign,
      posts: [readyLeafletPost],
      integrations: [],
      assets: [staleCaptionAsset],
      queue: [],
      approvals: [readyApproval],
    });
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    const caller = contentRouter.createCaller(buildCtx());
    await expect(caller.publishCampaignPack({ campaignId: 28 })).rejects.toThrow(
      "Caption pack is stale"
    );
    expect(publishSinglePost).not.toHaveBeenCalled();
  });

  it("rejects when an included supporting asset is stale", async () => {
    const { getDb } = await import("./queries/connection");
    const { publishSinglePost } = await import("./lib/workflow/publishing-runner");
    const { contentRouter } = await import("./content-router");

    const staleSupportingAsset = {
      id: 2,
      userId: 18,
      campaignId: 28,
      assetType: "ad_copy",
      metadata: { creativeBriefFingerprint: "stale-fingerprint" },
    };

    const mockDb = createMockDb({
      campaign: readyCampaign,
      posts: [readyLeafletPost],
      integrations: [],
      assets: [readyCaptionAsset, staleSupportingAsset],
      queue: [],
      approvals: [readyApproval],
    });
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    const caller = contentRouter.createCaller(buildCtx());
    await expect(caller.publishCampaignPack({ campaignId: 28 })).rejects.toThrow(
      /stale/i
    );
    expect(publishSinglePost).not.toHaveBeenCalled();
  });

  it("rejects when the campaign_launch approval is pending", async () => {
    const { getDb } = await import("./queries/connection");
    const { publishSinglePost } = await import("./lib/workflow/publishing-runner");
    const { contentRouter } = await import("./content-router");

    const pendingApproval = { ...readyApproval, status: "pending" };

    const mockDb = createMockDb({
      campaign: readyCampaign,
      posts: [readyLeafletPost],
      integrations: [],
      assets: [readyCaptionAsset],
      queue: [],
      approvals: [pendingApproval],
    });
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    const caller = contentRouter.createCaller(buildCtx());
    await expect(caller.publishCampaignPack({ campaignId: 28 })).rejects.toThrow(
      "Campaign launch approval is pending"
    );
    expect(publishSinglePost).not.toHaveBeenCalled();
  });

  it("allows publication when all required outputs are present and current", async () => {
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
      campaign: readyCampaign,
      posts: [readyLeafletPost],
      integrations: [],
      assets: [readyCaptionAsset],
      queue: [],
      approvals: [readyApproval],
    });
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    const caller = contentRouter.createCaller(buildCtx());
    const result = await caller.publishCampaignPack({ campaignId: 28 });

    expect(result.manualPosting).toBe(true);
    expect(publishSinglePost).not.toHaveBeenCalled();
  });
});

describe("contentRouter.markAsManuallyPosted Phase 2B gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows one-off content with no campaign", async () => {
    const { getDb } = await import("./queries/connection");
    const { contentRouter } = await import("./content-router");

    const oneOffPost = {
      id: 200,
      userId: 18,
      campaignId: null,
      type: "social_post",
      platform: "Instagram",
      status: "draft",
      metadata: {},
    };

    const mockDb = createMockDb({ posts: [oneOffPost] });
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    const caller = contentRouter.createCaller(buildCtx());
    const result = await caller.markAsManuallyPosted({ id: 200 });

    expect(result.success).toBe(true);
    const updateSetSpy = mockDb.updateSetByTableName.get("content_posts");
    expect(updateSetSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects a campaign-linked post when the output is stale", async () => {
    const { getDb } = await import("./queries/connection");
    const { contentRouter } = await import("./content-router");

    const campaign = {
      id: 28,
      userId: 18,
      businessId: 24,
      status: "draft",
      workflowState: "creatives_ready",
      platforms: "instagram",
      productOrService: "Business service",
      targetBuyer: "Small business owners",
      mainPainPoint: "Wasting time",
      primaryOutcome: "More leads",
      coreMessage: "Empower your workforce",
    };

    const stalePost = {
      id: 201,
      userId: 18,
      campaignId: 28,
      type: "social_post",
      platform: "Instagram",
      status: "draft",
      metadata: {
        imageStatus: "ready",
        imageUrl: "https://example.com/post.png",
      },
    };

    const mockDb = createMockDb({ campaign, posts: [stalePost] });
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    const caller = contentRouter.createCaller(buildCtx());
    await expect(caller.markAsManuallyPosted({ id: 201 })).rejects.toThrow(
      "Selected output is stale"
    );
    const updateSetSpy = mockDb.updateSetByTableName.get("content_posts");
    expect(updateSetSpy).toBeUndefined();
  });
});

describe("contentRouter.getCampaignPublishReadiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the server-computed readiness result", async () => {
    const { getDb } = await import("./queries/connection");
    const { contentRouter } = await import("./content-router");

    const campaign = {
      id: 28,
      userId: 18,
      businessId: 24,
      status: "draft",
      workflowState: "creatives_ready",
      platforms: "instagram",
      productOrService: "Business service",
      targetBuyer: "Small business owners",
      mainPainPoint: "Wasting time",
      primaryOutcome: "More leads",
      coreMessage: "Empower your workforce",
      workflowContext: launchApprovalContext(1),
    };

    const leaflet = {
      id: 125,
      userId: 18,
      campaignId: 28,
      type: "social_post",
      platform: "Instagram",
      status: "draft",
      metadata: {
        assetKind: "master_campaign_post",
        imageStatus: "ready",
        imageUrl: "https://example.com/master-image.png",
        creativeBriefFingerprint: "test-fingerprint-ready",
      },
    };

    const captionAsset = {
      id: 1,
      userId: 18,
      campaignId: 28,
      assetType: "caption_adaptation",
      metadata: { creativeBriefFingerprint: "test-fingerprint-ready" },
    };

    const mockDb = createMockDb({
      campaign,
      posts: [leaflet],
      assets: [captionAsset],
      approvals: [
        {
          id: 1,
          userId: 18,
          campaignId: 28,
          approvalType: "campaign_launch",
          status: "approved",
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    const caller = contentRouter.createCaller(buildCtx());
    const result = await caller.getCampaignPublishReadiness({ campaignId: 28 });

    expect(result.ready).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.requiredOutputs.leaflet.present).toBe(true);
    expect(result.requiredOutputs.leaflet.current).toBe(true);
    expect(result.requiredOutputs.captionPack.present).toBe(true);
    expect(result.requiredOutputs.captionPack.current).toBe(true);
  });
});


describe("contentRouter.ownership Phase 2B gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns not found when publishing another user's campaign", async () => {
    const { getDb } = await import("./queries/connection");
    const { contentRouter } = await import("./content-router");

    const otherUserCampaign = {
      id: 50,
      userId: 99,
      businessId: 24,
      status: "draft",
      workflowState: "creatives_ready",
      platforms: "instagram",
      productOrService: "Business service",
      targetBuyer: "Small business owners",
      mainPainPoint: "Wasting time",
      primaryOutcome: "More leads",
      coreMessage: "Empower your workforce",
    };

    const mockDb = createMockDb({ campaign: otherUserCampaign });
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    const caller = contentRouter.createCaller(buildCtx(18));
    await expect(caller.publishCampaignPack({ campaignId: 50 })).rejects.toThrow(/not found/i);
    await expect(caller.getCampaignPublishReadiness({ campaignId: 50 })).rejects.toThrow(/not found/i);
  });

  it("returns not found when marking another user's post as manually posted", async () => {
    const { getDb } = await import("./queries/connection");
    const { contentRouter } = await import("./content-router");

    const otherUserPost = {
      id: 500,
      userId: 99,
      campaignId: 28,
      type: "social_post",
      platform: "Instagram",
      status: "draft",
      metadata: { creativeBriefFingerprint: "test-fingerprint-ready" },
    };

    const mockDb = createMockDb({ posts: [otherUserPost] });
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    const caller = contentRouter.createCaller(buildCtx(18));
    await expect(caller.markAsManuallyPosted({ id: 500 })).rejects.toThrow(/not found/i);
  });
});


describe("contentRouter.update WBS12.9 approved-copy integrity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function approvedPost(overrides: Record<string, unknown> = {}) {
    return {
      id: 300,
      userId: 18,
      campaignId: 28,
      type: "social_post",
      platform: "instagram",
      status: "draft",
      title: "Spring promo",
      hook: "Tired of waiting?",
      caption: "Original caption",
      cta: "Book now",
      headline: null,
      body: null,
      hashtags: "#spring",
      metadata: {
        approved: true,
        approvedAt: "2026-05-20T10:00:00.000Z",
      },
      ...overrides,
    };
  }

  function lastContentPostsSet(mockDb: ReturnType<typeof createMockDb>) {
    const spy = mockDb.updateSetByTableName.get("content_posts");
    expect(spy).toHaveBeenCalled();
    return spy!.mock.calls[spy!.mock.calls.length - 1][0] as Record<string, unknown>;
  }

  it("voids approval when a semantic copy field is edited on an approved post", async () => {
    const { getDb } = await import("./queries/connection");
    const { contentRouter } = await import("./content-router");

    const mockDb = createMockDb({ posts: [approvedPost()] });
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    const caller = contentRouter.createCaller(buildCtx());
    const result = await caller.update({ id: 300, caption: "Rewritten caption" });

    expect(result.success).toBe(true);
    const setArgs = lastContentPostsSet(mockDb);
    expect(setArgs.caption).toBe("Rewritten caption");
    const metadata = setArgs.metadata as Record<string, unknown>;
    expect(metadata.approved).toBe(false);
    expect(metadata.approvalVoidedReason).toBe("semantic_copy_edit_requires_reapproval");
    expect(typeof metadata.approvalVoidedAt).toBe("string");
    // Prior approval history is retained for audit, not treated as current.
    expect(metadata.approvedAt).toBe("2026-05-20T10:00:00.000Z");
  });

  it.each(["hook", "caption", "cta", "headline", "body"] as const)(
    "voids approval when %s changes on an approved post",
    async (field) => {
      const { getDb } = await import("./queries/connection");
      const { contentRouter } = await import("./content-router");

      const mockDb = createMockDb({ posts: [approvedPost()] });
      vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

      const caller = contentRouter.createCaller(buildCtx());
      await caller.update({ id: 300, [field]: `new ${field} value` });

      const metadata = lastContentPostsSet(mockDb).metadata as Record<string, unknown>;
      expect(metadata.approved).toBe(false);
      expect(metadata.approvalVoidedReason).toBe("semantic_copy_edit_requires_reapproval");
    }
  );

  it("preserves approval for formatting-only edits (hashtags) on an approved post", async () => {
    const { getDb } = await import("./queries/connection");
    const { contentRouter } = await import("./content-router");

    const mockDb = createMockDb({ posts: [approvedPost()] });
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    const caller = contentRouter.createCaller(buildCtx());
    await caller.update({ id: 300, hashtags: "#spring #promo #new" });

    const setArgs = lastContentPostsSet(mockDb);
    expect(setArgs.hashtags).toBe("#spring #promo #new");
    // No metadata write at all: approval row state is untouched.
    expect(setArgs.metadata).toBeUndefined();
  });

  it("preserves approval for scheduling updates on an approved post (core workflow)", async () => {
    const { getDb } = await import("./queries/connection");
    const { contentRouter } = await import("./content-router");

    const mockDb = createMockDb({ posts: [approvedPost()] });
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    const caller = contentRouter.createCaller(buildCtx());
    await caller.update({
      id: 300,
      status: "scheduled",
      scheduledFor: "2026-06-01T09:00:00.000Z",
    });

    const setArgs = lastContentPostsSet(mockDb);
    expect(setArgs.status).toBe("scheduled");
    expect(setArgs.metadata).toBeUndefined();
    expect(setArgs).not.toHaveProperty("hook");
    expect(setArgs).not.toHaveProperty("caption");
  });

  it("does not mint approval state when an unapproved legacy post is edited", async () => {
    const { getDb } = await import("./queries/connection");
    const { contentRouter } = await import("./content-router");

    const legacyPost = approvedPost({
      metadata: { generationRunId: "run-legacy" },
    });
    const mockDb = createMockDb({ posts: [legacyPost] });
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    const caller = contentRouter.createCaller(buildCtx());
    await caller.update({ id: 300, caption: "Edited legacy caption" });

    const setArgs = lastContentPostsSet(mockDb);
    expect(setArgs.caption).toBe("Edited legacy caption");
    expect(setArgs.metadata).toBeUndefined();
  });

  it("strips approval-authority keys from arbitrary metadata passthrough", async () => {
    const { getDb } = await import("./queries/connection");
    const { contentRouter } = await import("./content-router");

    const legacyPost = approvedPost({ metadata: { note: "keep-me" } });
    const mockDb = createMockDb({ posts: [legacyPost] });
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    const caller = contentRouter.createCaller(buildCtx());
    await caller.update({
      id: 300,
      metadata: { approved: true, approvedAt: "2026-01-01T00:00:00.000Z", note: "updated" },
    });

    const metadata = lastContentPostsSet(mockDb).metadata as Record<string, unknown>;
    expect(metadata.note).toBe("updated");
    expect(metadata.approved).toBeUndefined();
    expect(metadata.approvedAt).toBeUndefined();
  });

  it("merges metadata so governance lineage survives partial updates", async () => {
    const { getDb } = await import("./queries/connection");
    const { contentRouter } = await import("./content-router");

    const governedPost = approvedPost({
      metadata: {
        approved: false,
        creativeArtifactLineage: {
          lineageSchemaVersion: 1,
          artifactKind: "platform_caption",
          parent: { artifactKind: "message_pack", artifactId: null },
          lineageFingerprintSha256: "abc123",
        },
      },
    });
    const mockDb = createMockDb({ posts: [governedPost] });
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    const caller = contentRouter.createCaller(buildCtx());
    await caller.update({ id: 300, title: "Renamed only", metadata: { reviewNote: "checked" } });

    const setArgs = lastContentPostsSet(mockDb);
    expect(setArgs.title).toBe("Renamed only");
    const metadata = setArgs.metadata as Record<string, unknown>;
    const lineage = metadata.creativeArtifactLineage as Record<string, unknown>;
    expect(lineage.artifactKind).toBe("platform_caption");
    expect(lineage.lineageFingerprintSha256).toBe("abc123");
    expect(metadata.reviewNote).toBe("checked");
    expect(metadata.approved).toBe(false);
  });

  it("records a no-change semantic field as non-voiding", async () => {
    const { getDb } = await import("./queries/connection");
    const { contentRouter } = await import("./content-router");

    const mockDb = createMockDb({ posts: [approvedPost()] });
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    const caller = contentRouter.createCaller(buildCtx());
    await caller.update({ id: 300, caption: "Original caption" });

    const setArgs = lastContentPostsSet(mockDb);
    expect(setArgs.metadata).toBeUndefined();
  });
});

describe("contentRouter.approve WBS12.9", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks a content post as approved and keeps the approval authority keys", async () => {
    const { getDb } = await import("./queries/connection");
    const { contentRouter } = await import("./content-router");

    const post = {
      id: 301,
      userId: 18,
      campaignId: 28,
      type: "social_post",
      status: "draft",
      metadata: { generationRunId: "run-9" },
    };
    const mockDb = createMockDb({ posts: [post] });
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    const caller = contentRouter.createCaller(buildCtx());
    const result = await caller.approve({ id: 301 });

    expect(result.success).toBe(true);
    const spy = mockDb.updateSetByTableName.get("content_posts");
    expect(spy).toHaveBeenCalledTimes(1);
    const metadata = spy!.mock.calls[0][0] as { metadata: Record<string, unknown> };
    expect(metadata.metadata.approved).toBe(true);
    expect(typeof metadata.metadata.approvedAt).toBe("string");
    expect(metadata.metadata.generationRunId).toBe("run-9");
  });
});
