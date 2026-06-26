import { describe, it, expect, vi, beforeEach } from "vitest";

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
}: {
  queueItem?: Record<string, unknown>;
  contentPost?: Record<string, unknown>;
  integration?: Record<string, unknown>;
}) {
  return {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => {
            const name = getTableName(table);
            if (name === "publishing_queue") return queueItem ? [queueItem] : [];
            if (name === "content_posts") return contentPost ? [contentPost] : [];
            if (name === "social_integrations") return integration ? [integration] : [];
            return [];
          }),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async () => [{ insertId: 1 }]),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => []),
      })),
    })),
  };
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

const baseContentPost = {
  id: 117,
  hook: "Hook line",
  caption: "Caption body",
  cta: "Shop now",
  metadata: { imageUrl: "https://cdn.example.com/image.png" },
};

describe("publishSinglePost", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("publishes to Facebook using the persisted integrationId and page token", async () => {
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
        contentPost: baseContentPost,
        integration: baseIntegration,
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
        mediaUrls: ["https://cdn.example.com/image.png"],
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
        contentPost: baseContentPost,
        integration: baseIntegration,
      }) as any
    );

    const result = await publishSinglePost(1);

    expect(result.status).toBe("published");
    expect(publishToFacebook).toHaveBeenCalledWith(
      "decrypted:page-token-encrypted",
      "830205703508466",
      expect.any(Object)
    );
  });

  it("fails when no integration is connected", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { publishToFacebook } = await import("../../integrations/platforms");
    const { publishSinglePost } = await import("../publishing-runner");

    vi.mocked(getDb).mockReturnValue(
      createMockDb({
        queueItem: { ...baseQueueItem, integrationId: null },
        contentPost: baseContentPost,
        integration: undefined,
      }) as any
    );

    const result = await publishSinglePost(1);

    expect(result.status).toBe("failed");
    expect(result.error).toContain("no connected facebook account");
    expect(publishToFacebook).not.toHaveBeenCalled();
  });
});
