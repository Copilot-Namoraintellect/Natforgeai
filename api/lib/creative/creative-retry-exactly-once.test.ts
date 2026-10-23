/**
 * R4-B3 — Retry / exactly-once creative effects.
 *
 * Per-artefact proofs that retries reuse stable operation identity and never
 * produce duplicate billable intent or duplicate authoritative artefacts:
 *
 *   - premium video: replaying completion for an already-charged job reuses
 *     the durable artefact (no second provider status call, no second
 *     deduction); a full completion + retry charges exactly once.
 *   - caption packs: duplicate generation retries converge on one
 *     authoritative pack in the release package; older rows are superseded,
 *     never bundled, never mutated.
 *   - message packs: regeneration leaves exactly one authoritative approved
 *     pack (latest approved wins).
 *   - release seal: a transient failure followed by a healthy retry seals
 *     exactly once and converges on already_present.
 *
 * Campaign-operation claim dedup/re-arm, approval replay idempotency and the
 * content-job short-circuit are proven by the existing suites
 * (creative-generation-claim.test.ts, agent-router*.test.ts,
 * content-generation-job.test.ts) and exercised end to end by the R4-B5
 * acceptance harness.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

const billingState = vi.hoisted(() => ({
  deductions: [] as any[],
  usageRecords: [] as any[],
}));

vi.mock("../billing/credit-engine", () => ({
  checkCredits: vi.fn(async () => ({ hasCredits: true, balance: 100 })),
  deductCredits: vi.fn(async (input: any) => {
    billingState.deductions.push(input);
    return { newBalance: 100 - input.amount };
  }),
  recordAiUsage: vi.fn(async (input: any) => {
    billingState.usageRecords.push(input);
  }),
}));

vi.mock("./storage", () => ({
  storeImageBuffer: vi.fn(async () => ({
    publicUrl: "https://cdn.example.com/stored.png",
    localPath: "/tmp/stored.png",
  })),
  downloadAndStoreVideo: vi.fn(async () => ({
    publicUrl: "https://cdn.example.com/master-video.mp4",
    localPath: "/tmp/master-video.mp4",
  })),
}));

const providerState = vi.hoisted(() => ({
  statusCalls: 0,
}));

vi.mock("./registry", () => ({
  getPremiumVideoProvider: vi.fn(() => ({
    name: "creatify",
    configured: true,
    generateVideo: vi.fn(),
    getStatus: vi.fn(async () => {
      providerState.statusCalls += 1;
      return {
        jobId: "provider-job-1",
        status: "done",
        videoUrl: "https://creatify.example.com/video.mp4",
        thumbnailUrl: "https://creatify.example.com/thumb.jpg",
        providerCreditsUsed: 40,
      };
    }),
  })),
  getBasicVideoProvider: vi.fn(),
  getTemplateRendererProvider: vi.fn(),
  getInternalTemplateRenderer: vi.fn(),
  getOpenAiLeafletRenderer: vi.fn(),
  getPremiumV2Renderer: vi.fn(),
  isOpenAiLeafletConfigured: vi.fn(() => false),
}));

vi.mock("./costs", () => ({
  getPremiumImageInternalCredits: vi.fn(() => 30),
  getPremiumImageExternalCredits: vi.fn(() => 60),
  getPremiumImageAiCredits: vi.fn(() => 80),
  getPremiumVideoCredits: vi.fn(() => 80),
  creatifyCreditsToUsd: vi.fn(() => 0.4),
  usdToMicroCents: vi.fn(() => 400_000),
}));

import { getDb } from "../../queries/connection";
import { deductCredits } from "../billing/credit-engine";
import { completePremiumVideo } from "./service";
import { buildGroundedCreativeBrief } from "./brief-grounding";
import { hashStrategySnapshotPayload } from "../strategy/strategy-snapshot";
import {
  buildCreativeReleasePackage,
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
  videoRenderJobs: [] as any[],
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
    case "video_render_jobs":
      return harness.videoRenderJobs;
    default:
      return [];
  }
}

function createHarnessDb() {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: (condition: unknown) => {
          const name = getTableName(table) ?? "";
          const rows = rowsFor(name).filter((r) =>
            getColumnFilters(condition).every((f) => r[f.name] === f.value)
          );
          const copies = rows.map((r: any) => ({ ...r }));
          return {
            orderBy: () => ({
              limit: async (_n: number) => copies,
            }),
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
          const name = getTableName(table) ?? "";
          const rows = rowsFor(name);
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
const CAMPAIGN_ID = 29;
const BUSINESS_ID = 5;
const SNAPSHOT_ID = "strategy_snap_b3";
const BDNA_ID = "bdna_snap_b3";
const STRATEGY_HASH = hashStrategySnapshotPayload({ coreMessage: "Ride the summer." } as any);

function buildCampaign(briefOverrides: Record<string, unknown> = {}) {
  const campaign: any = {
    id: CAMPAIGN_ID,
    userId: USER_ID,
    businessId: BUSINESS_ID,
    name: "Summer Board Drop",
    goal: "Sell 100 boards",
    platforms: "instagram,facebook",
    workflowState: "creatives_ready",
  };
  Object.assign(campaign, briefOverrides);
  const fingerprint = buildGroundedCreativeBrief({ campaign }).fingerprint;
  campaign.workflowContext = {
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
  return campaign;
}

function authoritySpread(fingerprint: string) {
  return {
    creativeBriefFingerprint: fingerprint,
    strategySnapshotId: SNAPSHOT_ID,
    strategyVersion: 2,
    businessDnaSnapshotId: BDNA_ID,
    strategyHashSha256: STRATEGY_HASH,
    strategyRunId: 600,
    approvalRequestId: 901,
  };
}

function baseEvidence(fingerprint: string) {
  return {
    contentPosts: [
      {
        id: 801,
        userId: USER_ID,
        campaignId: CAMPAIGN_ID,
        title: "Master Campaign Post",
        type: "social_post",
        status: "draft",
        createdAt: "2026-06-01T10:00:00.000Z",
        metadata: {
          assetType: "leaflet",
          assetKind: "master_campaign_post",
          imageStatus: "ready",
          imageUrl: "https://cdn.example.com/leaflet.png",
          ...authoritySpread(fingerprint),
        },
      },
    ] as any[],
    campaignAssets: [
      {
        id: 501,
        userId: USER_ID,
        campaignId: CAMPAIGN_ID,
        assetType: "message_pack",
        title: "Campaign Message Pack",
        status: "approved",
        createdAt: "2026-06-01T09:00:00.000Z",
        metadata: { passed: true, ...authoritySpread(fingerprint) },
      },
    ] as any[],
  };
}

function seedGovernedCampaign() {
  harness.campaign = buildCampaign();
  harness.business = { id: BUSINESS_ID, userId: USER_ID, name: "Acme Surf Co" };
  const fingerprint = buildGroundedCreativeBrief({ campaign: harness.campaign }).fingerprint;
  const evidence = baseEvidence(fingerprint);
  harness.contentPosts = evidence.contentPosts;
  harness.campaignAssets = evidence.campaignAssets;
  harness.generatedImages = [];
  harness.videoRenderJobs = [];
  return fingerprint;
}

describe("R4-B3 premium video completion is exactly-once", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    billingState.deductions = [];
    billingState.usageRecords = [];
    providerState.statusCalls = 0;
    harness.videoRenderJobs = [
      {
        id: 701,
        userId: USER_ID,
        campaignId: CAMPAIGN_ID,
        contentPostId: 801,
        provider: "creatify",
        renderJobId: "provider-job-1",
        renderStatus: "completed",
        videoUrl: "https://cdn.example.com/master-video.mp4",
        thumbnailUrl: "https://cdn.example.com/thumb.jpg",
        creditsCharged: 80,
        completedAt: "2026-06-10T12:00:00.000Z",
        metadata: {},
      },
    ];
    harness.contentPosts = [
      {
        id: 801,
        userId: USER_ID,
        campaignId: CAMPAIGN_ID,
        title: "Master Video Ad",
        metadata: {},
      },
    ];
    await installDb();
  });

  it("replay of a completed charged job reuses the durable artefact with no provider call and no second deduction", async () => {
    const result = await completePremiumVideo({
      userId: USER_ID,
      providerJobId: "provider-job-1",
    });

    expect(result.status).toBe("completed");
    expect(result.videoUrl).toBe("https://cdn.example.com/master-video.mp4");
    expect(providerState.statusCalls).toBe(0);
    expect(billingState.deductions).toHaveLength(0);
    expect(billingState.usageRecords).toHaveLength(0);
    expect(vi.mocked(deductCredits)).not.toHaveBeenCalled();
  });

  it("full completion followed by a retry charges exactly once", async () => {
    // Fresh in-flight job awaiting provider completion.
    harness.videoRenderJobs[0].renderStatus = "rendering";
    harness.videoRenderJobs[0].creditsCharged = 0;
    harness.videoRenderJobs[0].videoUrl = null;

    const first = await completePremiumVideo({
      userId: USER_ID,
      providerJobId: "provider-job-1",
    });
    expect(first.status).toBe("completed");
    expect(first.videoUrl).toBe("https://cdn.example.com/master-video.mp4");
    expect(billingState.deductions).toHaveLength(1);
    expect(billingState.deductions[0]).toMatchObject({
      userId: USER_ID,
      amount: 80,
      type: "video_generation",
    });
    expect(harness.videoRenderJobs[0].renderStatus).toBe("completed");
    expect(harness.videoRenderJobs[0].creditsCharged).toBe(80);
    expect(harness.contentPosts[0].metadata.videoStatus).toBe("ready");

    // Retry (e.g. user refresh / worker replay): early return, no re-charge.
    const retry = await completePremiumVideo({
      userId: USER_ID,
      providerJobId: "provider-job-1",
    });
    expect(retry.status).toBe("completed");
    expect(billingState.deductions).toHaveLength(1);
    expect(providerState.statusCalls).toBe(1);
  });
});

describe("R4-B3 caption and message packs converge on one authoritative artefact", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    seedGovernedCampaign();
    await installDb();
  });

  it("caption pack retry: the release package bundles exactly the latest pack and supersedes the older row", () => {
    const fingerprint = buildGroundedCreativeBrief({
      campaign: harness.campaign,
    }).fingerprint;
    harness.campaignAssets.push(
      {
        id: 502,
        userId: USER_ID,
        campaignId: CAMPAIGN_ID,
        assetType: "caption_pack",
        title: "Caption Pack",
        status: "ready",
        createdAt: "2026-06-01T11:00:00.000Z",
        metadata: { ...authoritySpread(fingerprint) },
      },
      {
        id: 503,
        userId: USER_ID,
        campaignId: CAMPAIGN_ID,
        assetType: "caption_pack",
        title: "Caption Pack (retry)",
        status: "ready",
        createdAt: "2026-06-01T11:05:00.000Z",
        metadata: { ...authoritySpread(fingerprint) },
      }
    );

    const result = buildCreativeReleasePackage({
      campaign: harness.campaign,
      contentPosts: harness.contentPosts,
      campaignAssets: harness.campaignAssets,
      sealedAtIso: "2026-06-12T00:00:00.000Z",
      sealedBy: "test",
    });

    expect(result.status).toBe("sealed");
    if (result.status !== "sealed") return;
    const captionRefs = result.package.artefacts.filter(
      (ref) => ref.kind === "caption_pack"
    );
    expect(captionRefs).toHaveLength(1);
    expect(captionRefs[0].recordId).toBe(503);
    expect(result.package.supersededArtefactIds).toContain(502);
    // The superseded row is recorded but never bundled under any identity.
    expect(
      result.package.artefacts.some((ref) => ref.recordId === 502)
    ).toBe(false);
    // The superseded row is recorded but never mutated by the package build.
    expect(
      harness.campaignAssets.find((a) => a.id === 502)?.metadata
    ).toEqual({ ...authoritySpread(fingerprint) });
  });

  it("caption regeneration after a brief cycle seals with only the new bound pack", () => {
    const oldFingerprint = buildGroundedCreativeBrief({
      campaign: harness.campaign,
    }).fingerprint;
    const oldCaptionPack = {
      id: 502,
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      assetType: "caption_pack",
      title: "Caption Pack",
      status: "ready",
      createdAt: "2026-06-01T11:00:00.000Z",
      metadata: { ...authoritySpread(oldFingerprint) },
    };

    // Post-edit cycle: new brief, re-approved strategy, ALL creative evidence
    // regenerated under the new fingerprint; only the old caption row lingers.
    const previousContext = harness.campaign.workflowContext;
    harness.campaign = buildCampaign({ coreMessage: "Repositioned message" });
    harness.campaign.workflowContext = {
      ...previousContext,
      ...harness.campaign.workflowContext,
    };
    const newFingerprint = buildGroundedCreativeBrief({
      campaign: harness.campaign,
    }).fingerprint;
    const regenerated = baseEvidence(newFingerprint);
    harness.contentPosts = regenerated.contentPosts;
    harness.campaignAssets = [
      ...regenerated.campaignAssets,
      oldCaptionPack,
      {
        id: 503,
        userId: USER_ID,
        campaignId: CAMPAIGN_ID,
        assetType: "caption_pack",
        title: "Caption Pack (regenerated)",
        status: "ready",
        createdAt: "2026-06-02T11:00:00.000Z",
        metadata: { ...authoritySpread(newFingerprint) },
      },
    ];

    const result = buildCreativeReleasePackage({
      campaign: harness.campaign,
      contentPosts: harness.contentPosts,
      campaignAssets: harness.campaignAssets,
      sealedAtIso: "2026-06-12T00:00:00.000Z",
      sealedBy: "test",
    });

    expect(result.status).toBe("sealed");
    if (result.status !== "sealed") return;
    const captionRefs = result.package.artefacts.filter(
      (ref) => ref.kind === "caption_pack"
    );
    expect(captionRefs).toHaveLength(1);
    expect(captionRefs[0].recordId).toBe(503);
    expect(result.package.supersededArtefactIds).toContain(502);
    // Historical pack rows keep their original lineage (immutability).
    expect(oldCaptionPack.metadata.creativeBriefFingerprint).toBe(oldFingerprint);
  });

  it("message pack regeneration leaves exactly one authoritative approved pack", () => {
    const fingerprint = buildGroundedCreativeBrief({
      campaign: harness.campaign,
    }).fingerprint;
    harness.campaignAssets.push(
      {
        id: 510,
        userId: USER_ID,
        campaignId: CAMPAIGN_ID,
        assetType: "message_pack",
        title: "Campaign Message Pack v2",
        status: "approved",
        createdAt: "2026-06-02T09:00:00.000Z",
        metadata: { passed: true, ...authoritySpread(fingerprint) },
      },
      {
        id: 502,
        userId: USER_ID,
        campaignId: CAMPAIGN_ID,
        assetType: "caption_pack",
        title: "Caption Pack",
        status: "ready",
        createdAt: "2026-06-01T11:00:00.000Z",
        metadata: { ...authoritySpread(fingerprint) },
      }
    );
    // The older pack was invalidated by regeneration (never approved again).
    harness.campaignAssets[0].metadata.passed = false;

    const result = buildCreativeReleasePackage({
      campaign: harness.campaign,
      contentPosts: harness.contentPosts,
      campaignAssets: harness.campaignAssets,
      sealedAtIso: "2026-06-12T00:00:00.000Z",
      sealedBy: "test",
    });

    expect(result.status).toBe("sealed");
    if (result.status !== "sealed") return;
    const packRefs = result.package.artefacts.filter(
      (ref) => ref.kind === "message_pack"
    );
    expect(packRefs).toHaveLength(1);
    expect(packRefs[0].recordId).toBe(510);
  });
});

describe("R4-B3 release seal recovery after transient failure", () => {
  it("a failed seal attempt followed by a healthy retry seals exactly once", async () => {
    vi.clearAllMocks();
    const fingerprint = seedGovernedCampaign();
    harness.campaignAssets.push({
      id: 502,
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      assetType: "caption_pack",
      title: "Caption Pack",
      status: "ready",
      createdAt: "2026-06-01T11:00:00.000Z",
      metadata: { ...authoritySpread(fingerprint) },
    });

    // Transient failure: the database is unavailable for the first attempt.
    vi.mocked(getDb).mockImplementation(() => {
      throw new Error("connection lost");
    });
    const failed = await syncCreativeReleasePackageSafely({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      sealedBy: "workflow.onAgentRunComplete",
    });
    expect(failed).toBeNull();
    expect(readSealedCreativeReleasePackage(harness.campaign)).toBeNull();

    // Recovery: the retry seals once; a duplicate trigger converges.
    await installDb();
    const sealed = await syncCreativeReleasePackage({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      sealedBy: "workflow.onAgentRunComplete",
    });
    expect(sealed.outcome).toBe("sealed");

    const replay = await syncCreativeReleasePackage({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      sealedBy: "workflow.onAgentRunComplete",
    });
    expect(replay.outcome).toBe("already_present");
    expect(readSealedCreativeReleasePackage(harness.campaign)).not.toBeNull();
  });
});
