import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleOAuthCallback,
  processMetaOAuthConnection,
  hasInstagramPublishingPermission,
} from "../oauth-callback";
import {
  fetchFacebookPages,
  getFacebookGrantedPermissions,
  fetchInstagramBusinessAccount,
} from "../platforms";
import { exchangeCodeForToken } from "../oauth";
import { getOAuthState, deleteOAuthState } from "../oauth-state";
import { getDb } from "../../../queries/connection";

vi.mock("../platforms", () => ({
  platformConfigs: {
    facebook: { scopes: ["public_profile", "email", "pages_manage_posts"] },
    instagram: { scopes: ["public_profile", "email", "instagram_basic", "instagram_content_publishing"] },
  },
  fetchFacebookPages: vi.fn(),
  selectFacebookPage: vi.fn((pages: any[]) => pages[0]),
  getFacebookGrantedPermissions: vi.fn(),
  fetchInstagramBusinessAccount: vi.fn(),
  getLinkedInProfile: vi.fn(),
  getTwitterProfile: vi.fn(),
}));

vi.mock("../oauth", () => ({
  exchangeCodeForToken: vi.fn(),
}));

vi.mock("../oauth-state", () => ({
  getOAuthState: vi.fn(),
  deleteOAuthState: vi.fn(),
}));

vi.mock("../../../queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("../../crypto", () => ({
  encryptToken: vi.fn((token: string) => `encrypted:${token}`),
}));

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as string | undefined;
}

function createMockDb(existingRows: Record<string, any[]> = {}) {
  const db: any = {
    existingRows,
    selects: [] as any[],
    inserts: [] as any[],
    updates: [] as any[],
    select: vi.fn(() => ({
      from: vi.fn((table: any) => ({
        where: vi.fn(() => ({
          limit: vi.fn(async (n: number) => {
            const name = getTableName(table);
            db.selects.push({ table: name, limit: n });
            return existingRows[name ?? ""] || [];
          }),
        })),
      })),
    })),
    insert: vi.fn((table: any) => ({
      values: vi.fn(async (values: any) => {
        const name = getTableName(table);
        db.inserts.push({ table: name, values });
        return [{ insertId: 1 }];
      }),
    })),
    update: vi.fn((table: any) => ({
      set: vi.fn((values: any) => ({
        where: vi.fn(async () => {
          const name = getTableName(table);
          db.updates.push({ table: name, values });
          return [];
        }),
      })),
    })),
  };
  return db;
}

describe("hasInstagramPublishingPermission", () => {
  it("accepts the canonical instagram_content_publishing scope", () => {
    expect(
      hasInstagramPublishingPermission(["instagram_basic", "instagram_content_publishing"])
    ).toBe(true);
  });

  it("accepts the instagram_content_publish alias", () => {
    expect(
      hasInstagramPublishingPermission(["instagram_basic", "instagram_content_publish"])
    ).toBe(true);
  });

  it("returns false when instagram_basic is missing", () => {
    expect(hasInstagramPublishingPermission(["instagram_content_publishing"])).toBe(false);
  });

  it("returns false when publishing scope is missing", () => {
    expect(hasInstagramPublishingPermission(["instagram_basic"])).toBe(false);
  });
});

describe("processMetaOAuthConnection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists Facebook and Instagram rows when the Page has a linked IG account and required permissions", async () => {
    const mockDb = createMockDb();
    vi.mocked(getFacebookGrantedPermissions).mockResolvedValue([
      "email",
      "pages_manage_posts",
      "instagram_basic",
      "instagram_content_publish",
    ]);
    vi.mocked(fetchFacebookPages).mockResolvedValue({
      ok: true,
      status: 200,
      pages: [{ id: "page_123", name: "Test Page", access_token: "page_token" }],
    });
    vi.mocked(fetchInstagramBusinessAccount).mockResolvedValue({
      id: "ig_123",
      username: "testbrand",
    });

    const result = await processMetaOAuthConnection(mockDb, { userId: 1, platform: "facebook" }, {
      accessToken: "user_token",
      refreshToken: "refresh_token",
    });

    expect(result.instagramRowUpserted).toBe(true);
    expect(result.instagramBusinessAccountId).toBe("ig_123");
    expect(result.instagramAccountName).toBe("testbrand");

    const fbInsert = mockDb.inserts.find((i: any) => i.values?.platform === "facebook");
    expect(fbInsert).toBeDefined();
    expect(fbInsert.values.pageId).toBe("page_123");
    expect(fbInsert.values.pageAccessTokenEncrypted).toBe("encrypted:page_token");
    expect(fbInsert.values.permissions).toContain("instagram_basic");
    expect(fbInsert.values.permissions).toContain("instagram_content_publish");

    const igInsert = mockDb.inserts.find((i: any) => i.values?.platform === "instagram");
    expect(igInsert).toBeDefined();
    expect(igInsert.values.instagramBusinessAccountId).toBe("ig_123");
    expect(igInsert.values.accountName).toBe("testbrand");
    expect(igInsert.values.pageId).toBe("page_123");
    expect(igInsert.values.pageAccessTokenEncrypted).toBe("encrypted:page_token");
    expect(igInsert.values.status).toBe("connected");
  });

  it("skips the Instagram row with a clear reason when required permissions are missing", async () => {
    const mockDb = createMockDb();
    vi.mocked(getFacebookGrantedPermissions).mockResolvedValue(["email", "pages_manage_posts"]);
    vi.mocked(fetchFacebookPages).mockResolvedValue({
      ok: true,
      status: 200,
      pages: [{ id: "page_123", name: "Test Page", access_token: "page_token" }],
    });
    vi.mocked(fetchInstagramBusinessAccount).mockResolvedValue({ id: "ig_123", username: "testbrand" });

    const result = await processMetaOAuthConnection(mockDb, { userId: 1, platform: "facebook" }, {
      accessToken: "user_token",
    });

    expect(result.instagramRowUpserted).toBe(false);
    expect(result.instagramSkipReason).toContain("Missing instagram_basic");

    const igInsert = mockDb.inserts.find((i: any) => i.values?.platform === "instagram");
    expect(igInsert).toBeUndefined();
  });

  it("skips the Instagram row with a clear reason when the Page has no linked IG account", async () => {
    const mockDb = createMockDb();
    vi.mocked(getFacebookGrantedPermissions).mockResolvedValue([
      "email",
      "pages_manage_posts",
      "instagram_basic",
      "instagram_content_publishing",
    ]);
    vi.mocked(fetchFacebookPages).mockResolvedValue({
      ok: true,
      status: 200,
      pages: [{ id: "page_123", name: "Test Page", access_token: "page_token" }],
    });
    vi.mocked(fetchInstagramBusinessAccount).mockResolvedValue(null);

    const result = await processMetaOAuthConnection(mockDb, { userId: 1, platform: "facebook" }, {
      accessToken: "user_token",
    });

    expect(result.instagramRowUpserted).toBe(false);
    expect(result.instagramSkipReason).toContain("no linked Instagram professional account");

    const igInsert = mockDb.inserts.find((i: any) => i.values?.platform === "instagram");
    expect(igInsert).toBeUndefined();
  });

  it("updates the existing Facebook row and refreshes permissions on reconnect", async () => {
    const existingFb = {
      id: 9,
      platform: "facebook",
      userId: 1,
      pageId: "old_page",
      pageAccessTokenEncrypted: "encrypted:old",
      accountName: "Old Page",
      permissions: ["email"],
      status: "connected",
    };
    const mockDb = createMockDb({ social_integrations: [existingFb] });

    vi.mocked(getFacebookGrantedPermissions).mockResolvedValue([
      "email",
      "pages_manage_posts",
      "instagram_basic",
      "instagram_content_publishing",
    ]);
    vi.mocked(fetchFacebookPages).mockResolvedValue({
      ok: true,
      status: 200,
      pages: [{ id: "page_123", name: "Test Page", access_token: "page_token" }],
    });
    vi.mocked(fetchInstagramBusinessAccount).mockResolvedValue({ id: "ig_123" });

    await processMetaOAuthConnection(mockDb, { userId: 1, platform: "facebook" }, {
      accessToken: "user_token",
    });

    const fbUpdate = mockDb.updates.find((u: any) => u.values?.permissions);
    expect(fbUpdate).toBeDefined();
    expect(fbUpdate.values.permissions).toContain("instagram_basic");
    expect(fbUpdate.values.pageAccessTokenEncrypted).toBe("encrypted:page_token");
  });
});

describe("handleOAuthCallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirects with success when Facebook and Instagram rows are persisted", async () => {
    const mockDb = createMockDb();
    vi.mocked(getOAuthState).mockResolvedValue({ userId: 1, platform: "facebook" });
    vi.mocked(exchangeCodeForToken).mockResolvedValue({
      accessToken: "user_token",
      refreshToken: "refresh_token",
    });
    vi.mocked(getDb).mockReturnValue(mockDb);
    vi.mocked(getFacebookGrantedPermissions).mockResolvedValue([
      "email",
      "pages_manage_posts",
      "instagram_basic",
      "instagram_content_publishing",
    ]);
    vi.mocked(fetchFacebookPages).mockResolvedValue({
      ok: true,
      status: 200,
      pages: [{ id: "page_123", name: "Test Page", access_token: "page_token" }],
    });
    vi.mocked(fetchInstagramBusinessAccount).mockResolvedValue({ id: "ig_123", username: "testbrand" });

    const redirect = vi.fn();
    const c = {
      req: { query: vi.fn((key: string) => ({ code: "auth_code", state: "state_123" }[key])) },
      redirect,
    };

    await handleOAuthCallback(c);

    expect(redirect).toHaveBeenCalledWith("/integrations?success=facebook");

    const igInsert = mockDb.inserts.find((i: any) => i.values?.platform === "instagram");
    expect(igInsert).toBeDefined();
    expect(igInsert.values.instagramBusinessAccountId).toBe("ig_123");
  });
});
