/**
 * R4-B SECURITY ENGINEERING ADDENDUM — changed-boundary adversarial tests.
 *
 * Security is a first-class acceptance criterion for this stream. This suite
 * adversarially tests every security boundary the stream changed:
 *
 *   content.approve (R4-B1 closure)
 *     - cross-tenant approval attempt           → refused, nothing stamped
 *     - approval fingerprint                    → computed server-side only
 *     - standalone content                      → approved, fingerprint unbound
 *   content.update metadata passthrough (WBS12.9 + R4-B1 key)
 *     - identifier tampering / privilege mint   → approval keys stripped
 *   creative release seal (R4-B2 module)
 *     - cross-tenant seal                       → campaign_missing, no write
 *     - duplicate/replayed seal                 → already_present, no mutation
 *     - malformed sealed context                → consumer fails closed
 *     - sensitive-data leakage scan             → no secrets in the package
 *     - provider/DB failure                     → no insecure fallback seal
 *
 * No live providers, no production database, no secrets in fixtures.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("../lib/workflow/publishing-runner", () => ({
  publishSinglePost: vi.fn(),
  finalizeCampaignPublishState: vi.fn(),
}));

vi.mock("../lib/safety/checker", () => ({
  checkContentSafety: vi.fn(async () => ({ riskLevel: "low" })),
}));

vi.mock("../lib/integrations/platforms", () => ({
  isFacebookPublishingReady: vi.fn(() => false),
  isInstagramPublishingReady: vi.fn(() => false),
}));

vi.mock("../lib/queue/bullmq", () => ({
  scheduleContentGenerationJob: vi.fn(async () => ({ id: "job" })),
  isBullMQAvailable: vi.fn(() => false),
}));

vi.mock("../lib/jobs/content-generation-job", () => ({
  processContentGenerationJob: vi.fn(),
}));

vi.mock("../lib/workflow/triggers", () => ({
  onAgentRunComplete: vi.fn(async () => undefined),
}));

vi.mock("../lib/agents/creative-agent", () => ({
  runCreativeAgent: vi.fn(),
}));

vi.mock("../lib/agents/strategy-agent", () => ({
  validateStrategyOutputAgainstCampaign: vi.fn(() => ({ valid: true })),
}));

vi.mock("../lib/creative/campaign-message-architect", () => ({
  loadApprovedMessagePack: vi.fn(async () => null),
}));

import { getDb } from "../../queries/connection";
import { contentRouter } from "../../content-router";
import { buildGroundedCreativeBrief } from "./brief-grounding";
import { hashStrategySnapshotPayload } from "../strategy/strategy-snapshot";
import {
  CREATIVE_RELEASE_PACKAGE_CONTEXT_KEY,
  assertCreativeReleasePackageIntact,
  readSealedCreativeReleasePackage,
  syncCreativeReleasePackage,
  syncCreativeReleasePackageSafely,
} from "./release-package";

// ── Fake database ───────────────────────────────────────────────────────────

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as
    | string
    | undefined;
}

function flattenSqlChunks(sql: any): any[] {
  if (!sql || typeof sql !== "object" || !Array.isArray(sql.queryChunks)) return [];
  const out: any[] = [];
  for (const chunk of sql.queryChunks) {
    if (chunk && typeof chunk === "object" && Array.isArray(chunk.queryChunks)) {
      out.push(...flattenSqlChunks(chunk));
    } else {
      out.push(chunk);
    }
  }
  return out;
}

function getColumnFilters(condition: unknown): Array<{ name: string; value: unknown }> {
  const chunks = flattenSqlChunks(condition);
  const filters: Array<{ name: string; value: unknown }> = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk && typeof chunk === "object" && "name" in chunk && typeof chunk.name === "string") {
      for (let j = i + 1; j < chunks.length; j++) {
        const candidate = chunks[j];
        if (
          candidate &&
          typeof candidate === "object" &&
          !("name" in candidate) &&
          "value" in candidate &&
          !Array.isArray(candidate.value)
        ) {
          filters.push({ name: chunk.name, value: candidate.value });
          break;
        }
      }
    }
  }
  return filters;
}

const harness = vi.hoisted(() => ({
  campaign: undefined as any,
  business: undefined as any,
  contentPosts: [] as any[],
  campaignAssets: [] as any[],
  generatedImages: [] as any[],
}));

function rowsFor(name: string): any[] {
  switch (name) {
    case "campaigns":
      return harness.campaign ? [harness.campaign] : [];
    case "businesses":
      return harness.business ? [harness.business] : [];
    case "content_posts":
      return harness.contentPosts;
    case "campaign_assets":
      return harness.campaignAssets;
    case "generated_images":
      return harness.generatedImages;
    default:
      return [];
  }
}

function createHarnessDb() {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: (condition: unknown) => {
          const rows = rowsFor(getTableName(table) ?? "").filter((r) =>
            getColumnFilters(condition).every((f) => r[f.name] === f.value)
          );
          const copies = rows.map((r: any) => ({ ...r }));
          return {
            orderBy: () => ({ limit: async (_n: number) => copies }),
            limit: async (_n: number) => copies,
            then: (resolve: (value: any[]) => unknown) =>
              Promise.resolve(copies).then(resolve),
          };
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (payload: any) => ({
        where: async (condition: unknown) => {
          const rows = rowsFor(getTableName(table) ?? "");
          const filters = getColumnFilters(condition);
          let affected = 0;
          for (const row of rows) {
            if (filters.every((f) => row[f.name] === f.value)) {
              Object.assign(row, payload);
              affected += 1;
            }
          }
          return [{ affectedRows: affected }];
        },
      }),
    }),
  };
}

async function installDb() {
  vi.mocked(getDb).mockReturnValue(createHarnessDb() as any);
}

// ── Seeds ───────────────────────────────────────────────────────────────────

const USER_ID = 42;
const OTHER_USER_ID = 99;
const CAMPAIGN_ID = 29;
const BUSINESS_ID = 5;
const SNAPSHOT_ID = "strategy_snap_sec";
const BDNA_ID = "bdna_snap_sec";
const STRATEGY_HASH = hashStrategySnapshotPayload({ coreMessage: "Ride the summer." } as any);

function seedCampaign() {
  harness.business = {
    id: BUSINESS_ID,
    userId: USER_ID,
    name: "Acme Surf Co",
    industry: "retail",
    isActive: true,
  };
  harness.campaign = {
    id: CAMPAIGN_ID,
    userId: USER_ID,
    businessId: BUSINESS_ID,
    name: "Summer Board Drop",
    goal: "Sell 100 boards",
    platforms: "instagram,facebook",
    workflowState: "creatives_ready",
    workflowContext: {},
  };
  const fingerprint = buildGroundedCreativeBrief({ campaign: harness.campaign }).fingerprint;
  harness.campaign.workflowContext = {
    strategyFingerprint: fingerprint,
    approvedStrategyFingerprint: fingerprint,
    strategyApprovalLineage: {
      creativeBriefFingerprint: fingerprint,
      strategyRunId: 600,
      approvalRequestId: 901,
      status: "approved",
      strategySnapshotId: SNAPSHOT_ID,
      strategyVersion: 2,
      businessDnaSnapshotId: BDNA_ID,
      strategyHashSha256: STRATEGY_HASH,
    },
  };
  harness.contentPosts = [
    {
      id: 1,
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      title: "Master Campaign Post",
      type: "social_post",
      status: "draft",
      metadata: {},
    },
    {
      id: 2,
      userId: USER_ID,
      campaignId: null,
      title: "Standalone Post",
      type: "social_post",
      status: "draft",
      metadata: {},
    },
  ];
  harness.campaignAssets = [];
  harness.generatedImages = [];
  return fingerprint;
}

function buildCtx(userId: number) {
  return {
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
    user: { id: userId, tierSlug: "free" } as any,
    session: { verified: true } as any,
  };
}

function postRow(id: number) {
  return harness.contentPosts.find((p) => p.id === id)!;
}

// ── content.approve boundary (R4-B1 closure) ────────────────────────────────

describe("R4-B security: content.approve authorization", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    seedCampaign();
    await installDb();
  });

  it("cross-tenant approval attempt is refused and stamps nothing", async () => {
    const caller = contentRouter.createCaller(buildCtx(OTHER_USER_ID));

    await expect(caller.approve({ id: 1 })).rejects.toThrow(/not found/i);
    expect(postRow(1).metadata.approved).toBeUndefined();
    expect(postRow(1).metadata.approvedAt).toBeUndefined();
    expect(postRow(1).metadata.approvedBriefFingerprint).toBeUndefined();
  });

  it("approval binds the server-computed brief fingerprint, never client input", async () => {
    const caller = contentRouter.createCaller(buildCtx(USER_ID));
    const fingerprint = buildGroundedCreativeBrief({
      campaign: harness.campaign,
      business: harness.business,
    }).fingerprint;

    const result = await caller.approve({ id: 1 });
    expect(result).toEqual({ success: true });
    expect(postRow(1).metadata.approved).toBe(true);
    expect(postRow(1).metadata.approvedBriefFingerprint).toBe(fingerprint);
  });

  it("standalone content is approvable with no campaign authority bound", async () => {
    const caller = contentRouter.createCaller(buildCtx(USER_ID));

    await caller.approve({ id: 2 });
    expect(postRow(2).metadata.approved).toBe(true);
    expect(postRow(2).metadata.approvedBriefFingerprint).toBeNull();
  });
});

describe("R4-B security: content.update cannot mint approval authority", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    seedCampaign();
    await installDb();
  });

  it("metadata passthrough strips approval keys (including approvedBriefFingerprint)", async () => {
    const caller = contentRouter.createCaller(buildCtx(USER_ID));

    await caller.update({
      id: 1,
      metadata: {
        approved: true,
        approvedAt: "2030-01-01T00:00:00.000Z",
        approvedBriefFingerprint: "forged-fingerprint",
        safeNote: "legitimate metadata",
      } as any,
    });

    const meta = postRow(1).metadata;
    expect(meta.approved).toBeUndefined();
    expect(meta.approvedAt).toBeUndefined();
    expect(meta.approvedBriefFingerprint).toBeUndefined();
    expect(meta.safeNote).toBe("legitimate metadata");
  });

  it("semantic copy edits void any existing approval without minting new authority", async () => {
    const caller = contentRouter.createCaller(buildCtx(USER_ID));
    await caller.approve({ id: 1 });
    expect(postRow(1).metadata.approved).toBe(true);

    await caller.update({ id: 1, caption: "Rewritten caption after approval" });

    const meta = postRow(1).metadata;
    expect(meta.approved).toBe(false);
    expect(meta.approvalVoidedReason).toBe("semantic_copy_edit_requires_reapproval");
    // The original approval fingerprint binding remains as evidence only.
    expect(typeof meta.approvedBriefFingerprint).toBe("string");
  });
});

// ── release seal boundary (R4-B2 module) ────────────────────────────────────

describe("R4-B security: creative release seal authorization and leakage", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    seedCampaign();
    const fingerprint = buildGroundedCreativeBrief({
      campaign: harness.campaign,
    }).fingerprint;
    harness.contentPosts[0].metadata = {
      assetType: "leaflet",
      assetKind: "master_campaign_post",
      imageStatus: "ready",
      imageUrl: "https://cdn.example.com/leaflet.png",
      creativeBriefFingerprint: fingerprint,
      strategySnapshotId: SNAPSHOT_ID,
      strategyVersion: 2,
      businessDnaSnapshotId: BDNA_ID,
      strategyHashSha256: STRATEGY_HASH,
    };
    harness.campaignAssets = [
      {
        id: 501,
        userId: USER_ID,
        campaignId: CAMPAIGN_ID,
        assetType: "message_pack",
        title: "Campaign Message Pack",
        status: "approved",
        createdAt: "2026-06-01T09:00:00.000Z",
        metadata: {
          passed: true,
          creativeBriefFingerprint: fingerprint,
          strategySnapshotId: SNAPSHOT_ID,
          strategyVersion: 2,
          businessDnaSnapshotId: BDNA_ID,
          strategyHashSha256: STRATEGY_HASH,
        },
      },
      {
        id: 502,
        userId: USER_ID,
        campaignId: CAMPAIGN_ID,
        assetType: "caption_pack",
        title: "Caption Pack",
        status: "ready",
        createdAt: "2026-06-01T11:00:00.000Z",
        metadata: {
          creativeBriefFingerprint: fingerprint,
          strategySnapshotId: SNAPSHOT_ID,
          strategyVersion: 2,
          businessDnaSnapshotId: BDNA_ID,
          strategyHashSha256: STRATEGY_HASH,
        },
      },
    ];
    await installDb();
  });

  it("cross-tenant seal is refused with no write", async () => {
    const before = JSON.stringify(harness.campaign.workflowContext);
    const result = await syncCreativeReleasePackage({
      userId: OTHER_USER_ID,
      campaignId: CAMPAIGN_ID,
      sealedBy: "security.test",
    });
    expect(result).toEqual({ outcome: "incomplete", reasons: ["campaign_missing"] });
    expect(JSON.stringify(harness.campaign.workflowContext)).toBe(before);
  });

  it("duplicate/replayed seal converges without mutating the sealed record", async () => {
    const first = await syncCreativeReleasePackage({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      sealedBy: "security.first",
    });
    expect(first.outcome).toBe("sealed");
    const snapshotAfterFirst = JSON.stringify(
      (harness.campaign.workflowContext as any)[CREATIVE_RELEASE_PACKAGE_CONTEXT_KEY]
    );

    const replay = await syncCreativeReleasePackage({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      sealedBy: "security.replay",
    });
    expect(replay.outcome).toBe("already_present");
    expect(
      JSON.stringify((harness.campaign.workflowContext as any)[CREATIVE_RELEASE_PACKAGE_CONTEXT_KEY])
    ).toBe(snapshotAfterFirst);
  });

  it("the sealed package contains no secrets, tokens or credential material", async () => {
    await syncCreativeReleasePackage({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      sealedBy: "security.scan",
    });
    const pkg = readSealedCreativeReleasePackage(harness.campaign);
    expect(pkg).not.toBeNull();

    const serialized = JSON.stringify(pkg);
    const forbidden = [
      /ownerToken/i,
      /access[_-]?token/i,
      /refresh[_-]?token/i,
      /api[_-]?key/i,
      /secret/i,
      /password/i,
      /connection[_-]?string/i,
      /pageaccesstoken/i,
      /BEGIN [A-Z ]*PRIVATE KEY/,
    ];
    for (const pattern of forbidden) {
      expect(pattern.test(serialized), `package leaks pattern ${pattern}`).toBe(false);
    }
    // Only lineage coordinates and identifiers are present.
    expect(pkg!.strategy.strategySnapshotId).toBe(SNAPSHOT_ID);
  });

  it("malformed sealed context fails closed for consumers", async () => {
    await syncCreativeReleasePackage({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      sealedBy: "security.malformed",
    });

    // Attacker or corruption replaces the package with garbage.
    (harness.campaign.workflowContext as any)[CREATIVE_RELEASE_PACKAGE_CONTEXT_KEY] = {
      packageId: 12345,
      note: "not a package",
    };
    expect(readSealedCreativeReleasePackage(harness.campaign)).toBeNull();

    // Tampered-but-plausible package fails the integrity check.
    const pkg = JSON.parse(
      JSON.stringify(
        (harness.campaign.workflowContext as any)[CREATIVE_RELEASE_PACKAGE_CONTEXT_KEY]
      )
    );
    // Restore a real package then tamper with its strategy hash.
    await syncCreativeReleasePackage({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      sealedBy: "security.restore",
    });
    const real = readSealedCreativeReleasePackage(harness.campaign)!;
    const tampered = {
      ...real,
      strategy: { ...real.strategy, strategyHashSha256: "0".repeat(64) },
    };
    expect(() => assertCreativeReleasePackageIntact(tampered)).toThrow(/fingerprint mismatch/);
  });

  it("database failure produces no insecure fallback seal", async () => {
    vi.mocked(getDb).mockImplementation(() => {
      throw new Error("connection lost");
    });
    const result = await syncCreativeReleasePackageSafely({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      sealedBy: "security.db-down",
    });
    expect(result).toBeNull();
    expect(
      (harness.campaign.workflowContext as any)[CREATIVE_RELEASE_PACKAGE_CONTEXT_KEY]
    ).toBeUndefined();
  });
});
