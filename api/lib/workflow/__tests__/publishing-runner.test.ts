import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.PUBLIC_APP_URL = "https://natforgeai.com";

import { buildGroundedCreativeBrief } from "../../creative/brief-grounding";
import { deductCredits } from "../../billing/credit-engine";

vi.mock("../../../queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("../../integrations/platforms", () => ({
  publishToFacebook: vi.fn(),
  publishToInstagram: vi.fn(),
  publishToLinkedIn: vi.fn(),
  publishToTwitter: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock("../../crypto", () => ({
  decryptToken: vi.fn((token: string | null | undefined) =>
    token ? `decrypted:${token}` : ""
  ),
}));

vi.mock("../../safety/checker", () => ({
  checkContentSafety: vi.fn(async () => ({ riskLevel: "low", reasons: [] })),
}));

vi.mock("../../billing/credit-engine", () => ({
  deductCredits: vi.fn(async () => {}),
}));

vi.mock("../../alerts", () => ({
  createAlert: vi.fn(async () => {}),
}));

vi.mock("../../rate-limiter", () => ({
  rateLimitUser: vi.fn(async () => {}),
}));

vi.mock("../../audience/ingest", () => ({
  ingestAudienceData: vi.fn(async () => {}),
}));

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[
    Symbol.for("drizzle:Name") as symbol
  ] as string | undefined;
}

function createMockDb({
  queueItem,
  contentPost,
  integration,
  campaign,
  business,
  campaignAssets = [],
  generatedImages = [],
  approvals = [],
}: {
  queueItem?: Record<string, unknown>;
  contentPost?: Record<string, unknown>;
  integration?: Record<string, unknown>;
  campaign?: Record<string, unknown>;
  business?: Record<string, unknown>;
  campaignAssets?: Record<string, unknown>[];
  generatedImages?: Record<string, unknown>[];
  approvals?: Record<string, unknown>[];
}) {
  const updateCalls: Array<{ table: string | undefined; set: Record<string, unknown> }> = [];
  const db = {
    updateCalls,
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        const name = getTableName(table);
        let rows: unknown[] = [];
        if (name === "publishing_queue") rows = queueItem ? [queueItem] : [];
        if (name === "content_posts") rows = contentPost ? [contentPost] : [];
        if (name === "social_integrations") rows = integration ? [integration] : [];
        if (name === "campaigns") rows = campaign ? [campaign] : [];
        if (name === "businesses") rows = business ? [business] : [];
        if (name === "campaign_assets") rows = campaignAssets;
        if (name === "generated_images") rows = generatedImages;
        if (name === "approval_requests") rows = approvals;

        const chainable = {
          limit: vi.fn(async () => rows),
          orderBy: vi.fn(() => chainable),
          then: (resolve: (value: unknown[]) => unknown, reject?: (reason?: unknown) => unknown) =>
            Promise.resolve(rows).then(resolve, reject),
        };
        return {
          where: vi.fn(() => chainable),
          orderBy: vi.fn(() => chainable),
        };
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async () => [{ insertId: 1 }]),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((data: Record<string, unknown>) => ({
        where: vi.fn(async () => {
          updateCalls.push({ table: getTableName(table), set: data });
          return [];
        }),
      })),
    })),
  };
  return db;
}

const baseQueueItem = {
  id: 1,
  userId: 14,
  campaignId: 27,
  contentPostId: 117,
  platform: "facebook",
  status: "approved",
  safetyStatus: "low",
  retryCount: 0,
  maxRetries: 3,
  scheduledAt: null,
  nextRetryAt: null,
};

const baseIntegration = {
  id: 9,
  userId: 14,
  platform: "facebook",
  status: "connected",
  accountName: "Test Page",
  pageId: "830205703508466",
  pageAccessTokenEncrypted: "page-token-encrypted",
  accessTokenEncrypted: "user-token-encrypted",
  permissions: ["pages_manage_posts"],
};

const relativeImageUrl = "/generated/images/27/premium-leaflet-ai_38f59991-4a9a-4f2e-aa47-c47efdb72924.png";
const absoluteImageUrl = `https://natforgeai.com${relativeImageUrl}`;

const baseContentPost = {
  id: 117,
  hook: "Hook line",
  caption: "Caption body",
  cta: "Shop now",
  metadata: { imageUrl: relativeImageUrl },
};

// Campaign-linked fixtures that pass the publication-authority gate: current
// creative-brief fingerprint on the selected output plus an approved
// campaign_launch approval.
const readyCampaign = {
  id: 27,
  userId: 14,
  businessId: 24,
  status: "active",
  productOrService: "Payout platform",
  targetBuyer: "Restaurants and delivery platforms",
  mainPainPoint: "manual payout reconciliation",
  primaryOutcome: "awareness",
  coreMessage: "Faster payouts for frontline teams",
};

const readyBusiness = {
  id: 24,
  userId: 14,
  name: "Zuto Hub",
  industry: "fintech payouts",
};

function currentFingerprintFor(campaign: Record<string, unknown>) {
  return buildGroundedCreativeBrief({ campaign, business: readyBusiness }).fingerprint;
}

function campaignLinkedContentPost(overrides: Record<string, unknown> = {}) {
  return {
    ...baseContentPost,
    campaignId: 27,
    metadata: {
      imageUrl: relativeImageUrl,
      creativeBriefFingerprint: currentFingerprintFor(readyCampaign),
    },
    ...overrides,
  };
}

const approvedLaunchApproval = {
  id: 7,
  userId: 14,
  campaignId: 27,
  approvalType: "campaign_launch",
  status: "approved",
};

const readyCampaignWithApprovedLineage = {
  ...readyCampaign,
  workflowContext: {
    launchApprovalLineage: {
      creativeBriefFingerprint: currentFingerprintFor(readyCampaign),
      approvalRequestId: approvedLaunchApproval.id,
      status: "approved" as const,
    },
  },
};
describe("publishSinglePost", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("publishes to Facebook using the persisted integrationId and a public image URL", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { publishToFacebook } = await import("../../integrations/platforms");
    const { publishSinglePost } = await import("../publishing-runner");

    vi.mocked(publishToFacebook).mockResolvedValueOnce({
      success: true,
      postId: "fb_123",
      url: "https://facebook.com/fb_123",
    });

    vi.mocked(getDb).mockReturnValue(
      createMockDb({
        queueItem: { ...baseQueueItem, integrationId: 9 },
        contentPost: campaignLinkedContentPost(),
        integration: baseIntegration,
        campaign: readyCampaignWithApprovedLineage,
        business: readyBusiness,
        approvals: [approvedLaunchApproval],
      }) as any
    );

    const result = await publishSinglePost(1);

    expect(result.status).toBe("published");
    expect(result.postId).toBe("fb_123");
    expect(publishToFacebook).toHaveBeenCalledTimes(1);
    expect(publishToFacebook).toHaveBeenCalledWith(
      "decrypted:page-token-encrypted",
      "830205703508466",
      expect.objectContaining({
        text: expect.stringContaining("Hook line"),
        mediaUrls: [absoluteImageUrl],
        mediaType: "image",
      })
    );
  });

  it("falls back to user + platform lookup when integrationId is not stored", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { publishToFacebook } = await import("../../integrations/platforms");
    const { publishSinglePost } = await import("../publishing-runner");

    vi.mocked(publishToFacebook).mockResolvedValueOnce({
      success: true,
      postId: "fb_456",
    });

    vi.mocked(getDb).mockReturnValue(
      createMockDb({
        queueItem: { ...baseQueueItem, integrationId: null },
        contentPost: campaignLinkedContentPost(),
        integration: baseIntegration,
        campaign: readyCampaignWithApprovedLineage,
        business: readyBusiness,
        approvals: [approvedLaunchApproval],
      }) as any
    );

    const result = await publishSinglePost(1);

    expect(result.status).toBe("published");
    expect(publishToFacebook).toHaveBeenCalledWith(
      "decrypted:page-token-encrypted",
      "830205703508466",
      expect.objectContaining({ mediaUrls: [absoluteImageUrl] })
    );
  });

  it("fails when no integration is connected", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { publishToFacebook } = await import("../../integrations/platforms");
    const { publishSinglePost } = await import("../publishing-runner");

    vi.mocked(getDb).mockReturnValue(
      createMockDb({
        queueItem: { ...baseQueueItem, integrationId: null },
        contentPost: campaignLinkedContentPost(),
        integration: undefined,
        campaign: readyCampaignWithApprovedLineage,
        business: readyBusiness,
        approvals: [approvedLaunchApproval],
      }) as any
    );

    const result = await publishSinglePost(1);

    expect(result.status).toBe("failed");
    expect(result.error).toContain("no connected facebook account");
    expect(publishToFacebook).not.toHaveBeenCalled();
  });

  it("fails without calling Facebook when the image URL is invalid", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { publishToFacebook } = await import("../../integrations/platforms");
    const { publishSinglePost } = await import("../publishing-runner");

    vi.mocked(getDb).mockReturnValue(
      createMockDb({
        queueItem: { ...baseQueueItem, integrationId: 9 },
        contentPost: campaignLinkedContentPost({
          metadata: {
            imageUrl: "blob:https://natforgeai.com/abc",
            creativeBriefFingerprint: currentFingerprintFor(readyCampaign),
          },
        }),
        integration: baseIntegration,
        campaign: readyCampaignWithApprovedLineage,
        business: readyBusiness,
        approvals: [approvedLaunchApproval],
      }) as any
    );

    const result = await publishSinglePost(1);

    expect(result.status).toBe("failed");
    expect(result.error).toContain("invalid image URL");
    expect(publishToFacebook).not.toHaveBeenCalled();
  });

  it("queue approval alone is not publication authority — campaign content without launch approval cannot publish", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { publishToFacebook } = await import("../../integrations/platforms");
    const { publishSinglePost } = await import("../publishing-runner");

    const db = createMockDb({
      queueItem: { ...baseQueueItem, integrationId: 9 },
      contentPost: campaignLinkedContentPost(),
      integration: baseIntegration,
      campaign: readyCampaign,
      business: readyBusiness,
      approvals: [],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const result = await publishSinglePost(1);

    expect(result.status).toBe("precondition_failed");
    expect(result.error).toMatch(/launch approval is pending/i);
    expect(publishToFacebook).not.toHaveBeenCalled();
    expect(vi.mocked(deductCredits)).not.toHaveBeenCalled();
    const queueUpdate = db.updateCalls.find((call) => call.table === "publishing_queue");
    expect(queueUpdate?.set.status).toBe("failed");
  });

  it("fails closed for standalone content without explicit publication authority", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { publishToFacebook } = await import("../../integrations/platforms");
    const { publishSinglePost } = await import("../publishing-runner");

    const standalonePost = { ...baseContentPost, campaignId: null };
    const db = createMockDb({
      queueItem: { ...baseQueueItem, integrationId: 9 },
      contentPost: standalonePost,
      integration: baseIntegration,
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const result = await publishSinglePost(1);

    expect(result.status).toBe("precondition_failed");
    expect(result.error).toMatch(/publication authority/i);
    expect(publishToFacebook).not.toHaveBeenCalled();
    const queueUpdate = db.updateCalls.find((call) => call.table === "publishing_queue");
    expect(queueUpdate?.set.status).toBe("failed");
  });
});
