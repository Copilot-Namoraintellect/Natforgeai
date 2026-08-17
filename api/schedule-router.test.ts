import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
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
  schedules = [],
  insertId = 456,
}: {
  campaign?: Record<string, unknown> | null;
  business?: Record<string, unknown> | null;
  contentPosts?: Record<string, unknown>[];
  campaignAssets?: Record<string, unknown>[];
  generatedImages?: Record<string, unknown>[];
  approvals?: Record<string, unknown>[];
  schedules?: Record<string, unknown>[];
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
    if (tableName === "schedules") rows = schedules;

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

describe("scheduleRouter.create Phase 2B gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows scheduling a one-off post without a campaign", async () => {
    const { getDb } = await import("./queries/connection");
    const { scheduleRouter } = await import("./schedule-router");

    const oneOffPost = {
      id: 400,
      userId: 18,
      campaignId: null,
      type: "social_post",
      platform: "Instagram",
      status: "draft",
      metadata: {},
    };

    const db = buildMockDb({ contentPosts: [oneOffPost] });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = scheduleRouter.createCaller(buildCtx());
    const result = await caller.create({
      title: "One-off",
      platform: "Instagram",
      scheduledDate: "2026-09-01",
      contentPostId: 400,
    });

    expect(result.success).toBe(true);
    expect(db._insertedRows.schedules).toHaveLength(1);
  });

  it("rejects scheduling a stale campaign-linked post before inserting the schedule row", async () => {
    const { getDb } = await import("./queries/connection");
    const { scheduleRouter } = await import("./schedule-router");

    const stalePost = {
      id: 401,
      userId: 18,
      campaignId: 28,
      type: "social_post",
      platform: "Instagram",
      status: "draft",
      metadata: { creativeBriefFingerprint: "stale" },
    };

    const db = buildMockDb({ campaign: readyCampaign, contentPosts: [stalePost], campaignAssets: [readyCaptionAsset] });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = scheduleRouter.createCaller(buildCtx());
    await expect(
      caller.create({
        title: "Stale campaign post",
        platform: "Instagram",
        scheduledDate: "2026-09-01",
        contentPostId: 401,
      })
    ).rejects.toThrow(/stale/i);

    expect(db._insertedRows.schedules).toBeUndefined();
  });

  it("allows scheduling a current campaign-linked post when the campaign is ready", async () => {
    const { getDb } = await import("./queries/connection");
    const { scheduleRouter } = await import("./schedule-router");

    const currentPost = {
      ...readyLeafletPost,
      id: 403,
    };

    const db = buildMockDb({
      campaign: readyCampaign,
      contentPosts: [currentPost],
      campaignAssets: [readyCaptionAsset],
      approvals: [readyApproval],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = scheduleRouter.createCaller(buildCtx());
    const result = await caller.create({
      title: "Current campaign post",
      platform: "Instagram",
      scheduledDate: "2026-09-01",
      contentPostId: 403,
    });

    expect(result.success).toBe(true);
    expect(db._insertedRows.schedules).toHaveLength(1);
  });

  it("rejects scheduling when launch approval is pending", async () => {
    const { getDb } = await import("./queries/connection");
    const { scheduleRouter } = await import("./schedule-router");

    const currentPost = {
      ...readyLeafletPost,
      id: 405,
    };

    const db = buildMockDb({
      campaign: readyCampaign,
      contentPosts: [currentPost],
      campaignAssets: [readyCaptionAsset],
      approvals: [],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = scheduleRouter.createCaller(buildCtx());
    await expect(
      caller.create({
        title: "Missing approval",
        platform: "Instagram",
        scheduledDate: "2026-09-01",
        contentPostId: 405,
      })
    ).rejects.toThrow(/approval/i);

    expect(db._insertedRows.schedules).toBeUndefined();
  });

  it("rejects scheduling when launch approval is pending (explicit pending status)", async () => {
    const { getDb } = await import("./queries/connection");
    const { scheduleRouter } = await import("./schedule-router");

    const currentPost = {
      ...readyLeafletPost,
      id: 406,
    };

    const pendingApproval = { ...readyApproval, status: "pending" };

    const db = buildMockDb({
      campaign: readyCampaign,
      contentPosts: [currentPost],
      campaignAssets: [readyCaptionAsset],
      approvals: [pendingApproval],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = scheduleRouter.createCaller(buildCtx());
    await expect(
      caller.create({
        title: "Pending approval",
        platform: "Instagram",
        scheduledDate: "2026-09-01",
        contentPostId: 406,
      })
    ).rejects.toThrow(/approval/i);

    expect(db._insertedRows.schedules).toBeUndefined();
  });

  it("rejects scheduling when the selected post does not exist", async () => {
    const { getDb } = await import("./queries/connection");
    const { scheduleRouter } = await import("./schedule-router");

    const db = buildMockDb({});
    vi.mocked(getDb).mockReturnValue(db as any);

    const caller = scheduleRouter.createCaller(buildCtx());
    await expect(
      caller.create({
        title: "Missing post",
        platform: "Instagram",
        scheduledDate: "2026-09-01",
        contentPostId: 404,
      })
    ).rejects.toThrow(/not found/i);
  });
});
