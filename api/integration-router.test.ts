import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
}));

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as
    | string
    | undefined;
}

function buildMockDb({ integrations = [] }: { integrations?: Record<string, unknown>[] }) {
  return {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        const rows = getTableName(table) === "social_integrations" ? integrations : [];
        const chainable = {
          limit: vi.fn(async () => rows),
          then: (resolve: (value: unknown[]) => unknown, reject?: (reason?: unknown) => unknown) =>
            Promise.resolve(rows).then(resolve, reject),
        };
        return { where: vi.fn(() => chainable) };
      }),
    })),
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

const instagramRowWithPageToken = {
  id: 7,
  provider: "instagram",
  providerAccountName: "NatForge IG",
  status: "connected",
  businessId: 24,
  permissions: ["instagram_content_publishing"],
  pageId: "page-1",
  pageAccessTokenEncrypted: "ciphertext-must-never-leave-the-api",
  instagramBusinessAccountId: "igbiz-1",
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

describe("integrationRouter.getConnectedPlatforms (WBS-R3.3 / GAP25 token boundary)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("never serializes the encrypted page token; exposes only the presence signal", async () => {
    const { getDb } = await import("./queries/connection");
    const { integrationRouter } = await import("./integration-router");

    vi.mocked(getDb).mockReturnValue(
      buildMockDb({ integrations: [instagramRowWithPageToken] }) as any
    );

    const caller = integrationRouter.createCaller(buildCtx());
    const rows = await caller.getConnectedPlatforms();

    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("pageAccessTokenEncrypted");
    expect(JSON.stringify(rows[0])).not.toContain("ciphertext-must-never-leave-the-api");
    expect((rows[0] as { hasPageAccessToken: boolean }).hasPageAccessToken).toBe(true);
  });

  it("reports hasPageAccessToken=false when no page token is stored", async () => {
    const { getDb } = await import("./queries/connection");
    const { integrationRouter } = await import("./integration-router");

    const linkedinRow = {
      ...instagramRowWithPageToken,
      id: 8,
      provider: "linkedin",
      pageAccessTokenEncrypted: null,
      instagramBusinessAccountId: null,
    };
    vi.mocked(getDb).mockReturnValue(buildMockDb({ integrations: [linkedinRow] }) as any);

    const caller = integrationRouter.createCaller(buildCtx());
    const rows = await caller.getConnectedPlatforms();

    expect((rows[0] as { hasPageAccessToken: boolean }).hasPageAccessToken).toBe(false);
    expect((rows[0] as { ready: boolean }).ready).toBe(true);
  });
});
