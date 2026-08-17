import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("./lib/workflow/publishing-runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/workflow/publishing-runner")>();
  return {
    ...actual,
    publishSinglePost: vi.fn(),
    publishDuePosts: vi.fn(async () => []),
  };
});

vi.mock("./lib/integrations/platforms", () => ({
  isFacebookPublishingReady: vi.fn(() => true),
  isInstagramPublishingReady: vi.fn(() => true),
  publishToFacebook: vi.fn(async () => ({ success: true, postId: "fb-123" })),
}));

vi.mock("./lib/queue/bullmq", () => ({
  schedulePublishingJob: vi.fn(async () => ({ id: "job-123" })),
  isBullMQAvailable: vi.fn(() => false),
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

vi.mock("./lib/logger", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as string | undefined;
}

function buildMockDb({
  campaign = null,
  business = null,
  contentPosts = [],
  campaignAssets = [],
  generatedImages = [],
  approvals = [],
  publishingQueue = [],
  socialIntegrations = [],
  insertId = 123,
}: {
  campaign?: Record<string, unknown> | null;
  business?: Record<string, unknown> | null;
  contentPosts?: Record<string, unknown>[];
  campaignAssets?: Record<string, unknown>[];
  generatedImages?: Record<string, unknown>[];
  approvals?: Record<string, unknown>[];
  publishingQueue?: Record<string, unknown>[];
  socialIntegrations?: Record<string, unknown>[];
  insertId?: number;
} = {}) {
  const insertedRows: Record<string, unknown[]> = {};
  const updatedRows: Record<string, unknown[]> = {};

  const selectFrom = vi.fn((table: unknown) => {
    const tableName = getTableName(table);
    let rows: unknown[] = [];
    if (tableName === "campaigns") rows = campaign ? [campaign] : [];
    if (tableName === "businesses") rows = business ? [business] : [];
    if (tableName === "content_posts") rows = contentPosts;
    if (tableName === "campaign_assets") rows = campaignAssets;
    if (tableName === "generated_images") rows = generatedImages;
    if (tableName === "approval_requests") rows = approvals;
    if (tableName === "publishing_queue") rows = publishingQueue;
    if (tableName === "social_integrations") rows = socialIntegrations;

    const chainable = {
      limit: vi.fn(async (n?: number) => (n === 1 ? rows.slice(0, 1) : rows)),
      orderBy: vi.fn(() => chainable),
      then: (resolve: (value: unknown[]) => unknown, reject?: (reason?: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject),
    };
    return {
      where: vi.fn(() => chainable),
      orderBy: vi.fn(() => chainable),
    };
  });

  const db = {
    select: vi.fn(() => ({ from: selectFrom })),
    insert: vi.fn((table: unknown) => {
      const tableName = getTableName(table) ?? "unknown";
      return {
        values: vi.fn(async (vals: any) => {
          const arr = Array.isArray(vals) ? vals : [vals];
          insertedRows[tableName] = [...(insertedRows[tableName] || []), ...arr];
          return [{ insertId }];
        }),
      };
    }),
    update: vi.fn((table: unknown) => {
      const tableName = getTableName(table) ?? "unknown";
      return {
        set: vi.fn((data: any) => ({
          where: vi.fn(async () => {
            updatedRows[tableName] = [...(updatedRows[tableName] || []), data];
            return [];
          }),
        })),
      };
    }),
    delete: vi.fn(() => ({ where: vi.fn(async () => []) })),
    _insertedRows: insertedRows,
    _updatedRows: updatedRows,
  };
  return db;
}

function buildCtx(userId = 18) {
  return {
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
    user: { id: userId, tierSlug: "free" } as any,
    session: { verified: true } as any,
  };
}

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
};

const readyLeafletPost = {
  id: 125,
  userId: 18,
  campaignId: 28,
  type: "social_post",
  platform: "Instagram",
  status: "draft",
  metadata: {
    assetKind: "master_campaign_post",
    imageUrl: "https://example.com/leaflet.png",
    imageStatus: "ready",
    creativeBriefFingerprint: "test-fingerprint-ready",
  },
};

const readyCaptionAsset = {
  id: 1,
  userId: 18,
  campaignId: 28,
  assetType: "caption_pack",
  metadata: {
    creativeBriefFingerprint: "test-fingerprint-ready",
  },
};

const readyApproval = {
  id: 1,
  userId: 18,
  campaignId: 28,
  approvalType: "campaign_launch",
  status: "approved",
};

describe("publishingRouter.createPublishingQueue Phase 2B gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows one-off posts without a campaign", async () => {
    const { getDb } = await import("./queries/connection");
    const { publishingRouter } = await import("./publishing-router");

    const oneOffPost = {
      id: 300,
      userId: 18,
      campaignId: null,
      type: "social_post",
      platform: "Instagram",
      status: "draft",
      metadata: {},
    };

    const db = buildMockDb({ contentPosts: [oneOffPost] });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = publishingRouter.createCaller(buildCtx());
    const result = await caller.createPublishingQueue({
      campaignId: 0,
      posts: [{ contentPostId: 300, platform: "Instagram" }],
    });

    expect(result.success).toBe(true);
    expect(db._insertedRows.publishing_queue).toHaveLength(1);
  });

  it("rejects a stale campaign-linked post before inserting a queue row", async () => {
    const { getDb } = await import("./queries/connection");
    const { publishingRouter } = await import("./publishing-router");

    const stalePost = {
      id: 301,
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

    const db = buildMockDb({ campaign: readyCampaign, contentPosts: [stalePost], campaignAssets: [readyCaptionAsset] });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = publishingRouter.createCaller(buildCtx());
    await expect(
      caller.createPublishingQueue({
        campaignId: 28,
        posts: [{ contentPostId: 301, platform: "Instagram" }],
      })
    ).rejects.toThrow(/stale/i);

    expect(db._insertedRows.publishing_queue).toBeUndefined();
  });

  it("allows a current campaign-linked post when the campaign is ready", async () => {
    const { getDb } = await import("./queries/connection");
    const { publishingRouter } = await import("./publishing-router");

    const db = buildMockDb({
      campaign: readyCampaign,
      contentPosts: [readyLeafletPost],
      campaignAssets: [readyCaptionAsset],
      approvals: [readyApproval],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = publishingRouter.createCaller(buildCtx());
    const result = await caller.createPublishingQueue({
      campaignId: 28,
      posts: [{ contentPostId: 125, platform: "Instagram" }],
    });

    expect(result.success).toBe(true);
    expect(db._insertedRows.publishing_queue).toHaveLength(1);
  });
});

describe("publishingRouter.approvePost Phase 2B gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects approving a stale campaign-linked post before status update", async () => {
    const { getDb } = await import("./queries/connection");
    const { publishingRouter } = await import("./publishing-router");

    const stalePost = {
      id: 302,
      userId: 18,
      campaignId: 28,
      type: "social_post",
      platform: "Instagram",
      status: "draft",
      metadata: { creativeBriefFingerprint: "stale" },
    };

    const pendingQueue = {
      id: 10,
      userId: 18,
      campaignId: 28,
      contentPostId: 302,
      platform: "Instagram",
      status: "pending_approval",
    };

    const db = buildMockDb({
      campaign: readyCampaign,
      contentPosts: [stalePost],
      campaignAssets: [readyCaptionAsset],
      publishingQueue: [pendingQueue],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = publishingRouter.createCaller(buildCtx());
    await expect(caller.approvePost({ queueId: 10 })).rejects.toThrow(/stale/i);

    expect(db._updatedRows.publishing_queue).toBeUndefined();
  });

  it("allows approving a current campaign-linked post", async () => {
    const { getDb } = await import("./queries/connection");
    const { publishingRouter } = await import("./publishing-router");

    const currentPost = {
      ...readyLeafletPost,
      id: 303,
    };

    const pendingQueue = {
      id: 11,
      userId: 18,
      campaignId: 28,
      contentPostId: 303,
      platform: "Instagram",
      status: "pending_approval",
    };

    const db = buildMockDb({
      campaign: readyCampaign,
      contentPosts: [currentPost],
      campaignAssets: [readyCaptionAsset],
      approvals: [readyApproval],
      publishingQueue: [pendingQueue],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = publishingRouter.createCaller(buildCtx());
    const result = await caller.approvePost({ queueId: 11 });

    expect(result.success).toBe(true);
    expect(db._updatedRows.publishing_queue).toHaveLength(1);
    expect(db._updatedRows.publishing_queue![0]).toMatchObject({ status: "approved" });
  });
});

describe("publishingRouter.publishPost Phase 2B gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects publishing a stale campaign-linked post before platform call", async () => {
    const { getDb } = await import("./queries/connection");
    const { publishingRouter } = await import("./publishing-router");
    const { publishSinglePost } = await import("./lib/workflow/publishing-runner");

    const stalePost = {
      id: 304,
      userId: 18,
      campaignId: 28,
      type: "social_post",
      platform: "Instagram",
      status: "draft",
      metadata: { creativeBriefFingerprint: "stale" },
    };

    const approvedQueue = {
      id: 12,
      userId: 18,
      campaignId: 28,
      contentPostId: 304,
      platform: "Instagram",
      status: "approved",
    };

    const db = buildMockDb({
      campaign: readyCampaign,
      contentPosts: [stalePost],
      campaignAssets: [readyCaptionAsset],
      publishingQueue: [approvedQueue],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = publishingRouter.createCaller(buildCtx());
    await expect(caller.publishPost({ queueId: 12 })).rejects.toThrow(/stale/i);
    expect(publishSinglePost).not.toHaveBeenCalled();
  });

  it("allows publishing a current campaign-linked post and calls the runner once", async () => {
    const { getDb } = await import("./queries/connection");
    const { publishingRouter } = await import("./publishing-router");
    const { publishSinglePost } = await import("./lib/workflow/publishing-runner");

    const currentPost = {
      ...readyLeafletPost,
      id: 305,
    };

    const approvedQueue = {
      id: 13,
      userId: 18,
      campaignId: 28,
      contentPostId: 305,
      platform: "Instagram",
      status: "approved",
    };

    const db = buildMockDb({
      campaign: readyCampaign,
      contentPosts: [currentPost],
      campaignAssets: [readyCaptionAsset],
      approvals: [readyApproval],
      publishingQueue: [approvedQueue],
    });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(publishSinglePost).mockResolvedValue({
      id: 13,
      status: "published",
      platform: "Instagram",
      postId: "ext-305",
    } as any);

    const caller = publishingRouter.createCaller(buildCtx());
    const result = await caller.publishPost({ queueId: 13 });

    expect(result.success).toBe(true);
    expect(publishSinglePost).toHaveBeenCalledTimes(1);
    expect(publishSinglePost).toHaveBeenCalledWith(13);
  });
});


describe("publishingRouter.approval ordering Phase 2B gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("approves a pending queue item without requiring launch approval first", async () => {
    const { getDb } = await import("./queries/connection");
    const { publishingRouter } = await import("./publishing-router");

    const currentPost = { ...readyLeafletPost, id: 306 };
    const pendingQueue = {
      id: 14,
      userId: 18,
      campaignId: 28,
      contentPostId: 306,
      platform: "Instagram",
      status: "pending_approval",
    };

    const db = buildMockDb({
      campaign: readyCampaign,
      contentPosts: [currentPost],
      campaignAssets: [readyCaptionAsset],
      approvals: [], // No launch approval yet
      publishingQueue: [pendingQueue],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = publishingRouter.createCaller(buildCtx());
    const result = await caller.approvePost({ queueId: 14 });

    expect(result.success).toBe(true);
    expect(db._updatedRows.publishing_queue).toHaveLength(1);
  });

  it("blocks final publish until launch approval is complete", async () => {
    const { getDb } = await import("./queries/connection");
    const { publishingRouter } = await import("./publishing-router");
    const { publishSinglePost } = await import("./lib/workflow/publishing-runner");

    const currentPost = { ...readyLeafletPost, id: 307 };
    const approvedQueue = {
      id: 15,
      userId: 18,
      campaignId: 28,
      contentPostId: 307,
      platform: "Instagram",
      status: "approved",
    };

    const db = buildMockDb({
      campaign: readyCampaign,
      contentPosts: [currentPost],
      campaignAssets: [readyCaptionAsset],
      approvals: [], // Launch approval missing
      publishingQueue: [approvedQueue],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = publishingRouter.createCaller(buildCtx());
    await expect(caller.publishPost({ queueId: 15 })).rejects.toThrow(/approval/i);
    expect(publishSinglePost).not.toHaveBeenCalled();
  });
});

describe("publishingRouter.ownership Phase 2B gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns not found when the queue item belongs to another user", async () => {
    const { getDb } = await import("./queries/connection");
    const { publishingRouter } = await import("./publishing-router");

    const otherUserQueue = {
      id: 16,
      userId: 99,
      campaignId: 28,
      contentPostId: 308,
      platform: "Instagram",
      status: "approved",
    };

    const db = buildMockDb({ publishingQueue: [otherUserQueue] });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = publishingRouter.createCaller(buildCtx(18));
    await expect(caller.publishPost({ queueId: 16 })).rejects.toThrow(/not found/i);
  });

  it("returns not found when the content post belongs to another campaign", async () => {
    const { getDb } = await import("./queries/connection");
    const { publishingRouter } = await import("./publishing-router");

    const postInOtherCampaign = {
      ...readyLeafletPost,
      id: 308,
      campaignId: 99,
    };

    const approvedQueue = {
      id: 17,
      userId: 18,
      campaignId: 28,
      contentPostId: 308,
      platform: "Instagram",
      status: "approved",
    };

    const db = buildMockDb({
      campaign: readyCampaign,
      contentPosts: [postInOtherCampaign],
      campaignAssets: [readyCaptionAsset],
      approvals: [readyApproval],
      publishingQueue: [approvedQueue],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = publishingRouter.createCaller(buildCtx());
    await expect(caller.publishPost({ queueId: 17 })).rejects.toThrow(/not found|campaign/i);
  });
});
