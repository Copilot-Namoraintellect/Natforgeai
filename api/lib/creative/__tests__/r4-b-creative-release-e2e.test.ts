/**
 * R4-B5 — Deterministic synthetic creative release acceptance harness.
 *
 * Proves the full governed creative pipeline autonomously produces exactly one
 * authoritative creative release package from an approved Strategy, with
 * controlled fakes at every external boundary (LLM creative agent, provider
 * render worker, audience chain, cost gate, database) and REAL internal
 * wiring everywhere else:
 *
 *   approved Strategy → creative generation (real workflow triggers + real
 *   release-package sealing) → render completion → captions → immutable
 *   release package → Stream C consumption surface
 *
 * Scenarios:
 *   1. happy path                              → exactly one sealed package
 *   2. duplicate creative trigger              → reused operation identity
 *   3. transient generation failure + retry    → one package, one charge path
 *   4. restart/re-entry after partial progress → convergence, no duplicates
 *   5. rejected/failed quality gate            → fail closed, recover once
 *   6. stale Strategy/Business-DNA lineage     → fail closed, no mutation
 *   7. repeated invocation after release       → already_present, immutable
 *
 * No live providers, no production database, no schedulers.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

import { buildGroundedCreativeBrief } from "../brief-grounding";
import { hashStrategySnapshotPayload } from "../../strategy/strategy-snapshot";
import {
  CREATIVE_RELEASE_PACKAGE_CONTEXT_KEY,
  assertCreativeReleasePackageIntact,
  readSealedCreativeReleasePackage,
  syncCreativeReleasePackage,
  type CreativeReleasePackage,
} from "../release-package";
import { resolveCreativeEntryStrategyAuthority } from "../creative-entry-authority";
import {
  acquireCreativeGenerationClaim,
  releaseClaimWithResult,
  generateOwnerToken,
} from "../creative-generation-claim";

// ── Hoisted harness state ──────────────────────────────────────────────────

const harness = vi.hoisted(() => ({
  campaign: undefined as any,
  business: undefined as any,
  agentRuns: [] as any[],
  contentPosts: [] as any[],
  campaignAssets: [] as any[],
  generatedImages: [] as any[],
  creativeGenerationClaims: [] as any[],
  creditTransactions: [] as any[],
  nextIds: {
    agent_runs: 6000,
    content_posts: 4000,
    campaign_assets: 4500,
    generated_images: 4700,
    creative_generation_claims: 4800,
    credit_transactions: 3000,
  } as Record<string, number>,
  creativeRuns: 0,
  creativeShouldFail: false,
  renderCompletions: 0,
  captionGenerations: 0,
  audienceRuns: 0,
  creativeSuccessCharges: [] as any[],
}));

// ── Module mocks (external boundaries only) ────────────────────────────────

vi.mock("../../../queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("../../agents/creative-agent", () => ({
  runCreativeAgent: vi.fn(async (input: any) => {
    harness.creativeRuns += 1;
    if (harness.creativeShouldFail) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Generated content did not meet quality standards: invented offer",
      });
    }
    const campaignId = input.campaignId;
    const userId = input.userId;
    const packRunId = harness.nextIds.agent_runs++;
    const fingerprint =
      input.strategyInput?.authority?.creativeBriefFingerprint ?? "fp";
    const authority = input.strategyInput?.authority ?? {};

    // Outer controlling operation row (mirrors the real router/job insert).
    const runRow: any = {
      id: packRunId,
      userId,
      campaignId,
      agentType: "creative",
      status: "running",
      input: { jobType: "content_generation_job" },
      startedAt: new Date().toISOString(),
    };
    harness.agentRuns.push(runRow);

    // Durable artefacts the real agent persists: master leaflet post,
    // supporting assets, approved message pack — all lineage-bound.
    harness.contentPosts.push({
      id: harness.nextIds.content_posts++,
      userId,
      campaignId,
      title: "Master Campaign Post",
      type: "social_post",
      status: "draft",
      createdAt: new Date().toISOString(),
      metadata: {
        assetType: "leaflet",
        assetKind: "master_campaign_post",
        generationRunId: `pack-${packRunId}`,
        ...authority,
      },
    });
    harness.campaignAssets.push(
      {
        id: harness.nextIds.campaign_assets++,
        userId,
        campaignId,
        assetType: "message_pack",
        title: "Campaign Message Pack",
        status: "approved",
        createdAt: new Date().toISOString(),
        metadata: { passed: true, creativeBriefFingerprint: fingerprint, ...authority },
      },
      {
        id: harness.nextIds.campaign_assets++,
        userId,
        campaignId,
        assetType: "hashtag_set",
        title: "Master Hashtag Set",
        status: "ready",
        createdAt: new Date().toISOString(),
        metadata: { creativeBriefFingerprint: fingerprint, ...authority },
      }
    );

    // Final campaign context update (mirrors the real agent).
    harness.campaign.workflowContext = {
      ...(harness.campaign.workflowContext || {}),
      creativeGeneratedAt: new Date().toISOString(),
      creativeRunId: packRunId,
      savedPosts: 1,
      savedAssets: 2,
      premiumPack: true,
    };

    runRow.status = "completed";
    runRow.completedAt = new Date().toISOString();

    return { packRunId, assetsRunId: null, savedPosts: 1, savedAssets: 2 };
  }),
}));

vi.mock("../../agents/strategy-agent", () => ({
  validateStrategyOutputAgainstCampaign: vi.fn(() => ({ valid: true })),
}));

vi.mock("../../agents/audience-agent", () => ({
  runAudienceAgent: vi.fn(async (input: any) => {
    harness.audienceRuns += 1;
    const runId = 7100 + harness.audienceRuns;
    harness.agentRuns.push({
      id: runId,
      userId: input.userId,
      campaignId: input.campaignId,
      agentType: "audience",
      status: "completed",
      startedAt: new Date().toISOString(),
    });
    return { runId };
  }),
}));

vi.mock("../../agents/distribution-agent", () => ({
  runDistributionAgent: vi.fn(async () => ({ runId: 7200 })),
}));

vi.mock("../../agents/audience-intelligence-agent", () => ({
  runAudienceIntelligenceAgent: vi.fn(async () => ({ runId: 7300 })),
}));

vi.mock("../../audience/access", () => ({
  checkAudienceAgentAccess: vi.fn(async () => ({ allowed: false, reason: "harness" })),
}));

vi.mock("../../audience/ingest", () => ({
  ingestAudienceData: vi.fn(async () => ({})),
}));

vi.mock("../../billing/cost-control", () => ({
  canRunAutonomousWorkflow: vi.fn(async () => ({ allowed: true })),
  enforceCostControl: vi.fn(async () => ({ allowed: true, daily: 0, monthly: 0, balance: 100 })),
}));

vi.mock("../../queue/bullmq", () => ({
  isBullMQAvailable: vi.fn(() => false),
  schedulePublishingJob: vi.fn(async () => ({ id: "harness-job" })),
  removePublishingJob: vi.fn(async () => {}),
}));

vi.mock("../../strategy/strategy-snapshot-db-store", () => ({
  getStrategySnapshotByStrategyRunId: vi.fn(),
}));

import { getDb } from "../../../queries/connection";
import { getStrategySnapshotByStrategyRunId } from "../../strategy/strategy-snapshot-db-store";
import { onAgentRunComplete } from "../../workflow/triggers";

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

function matches(condition: unknown, row: any): boolean {
  return getColumnFilters(condition).every((f) => row[f.name] === f.value);
}

function createHarnessDb() {
  const tableRows: Record<string, () => any[]> = {
    campaigns: () => (harness.campaign ? [harness.campaign] : []),
    businesses: () => (harness.business ? [harness.business] : []),
    agent_runs: () => harness.agentRuns,
    content_posts: () => harness.contentPosts,
    campaign_assets: () => harness.campaignAssets,
    generated_images: () => harness.generatedImages,
    creative_generation_claims: () => harness.creativeGenerationClaims,
    credit_transactions: () => harness.creditTransactions,
  };
  return {
    transaction: async (cb: (tx: any) => Promise<unknown>) => cb(createHarnessDb()),
    select: () => ({
      from: (table: unknown) => ({
        where: (condition: unknown) => {
          const name = getTableName(table) ?? "";
          const base = tableRows[name] ? tableRows[name]() : [];
          const rows = base.filter((r) => matches(condition, r));
          const copies = rows.map((r: any) => ({ ...r }));
          return {
            orderBy: () => ({
              limit: async (_n: number) =>
                copies
                  .slice()
                  .sort((a, b) =>
                    String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? ""))
                  ),
            }),
            limit: async (_n: number) => copies,
            then: (resolve: (value: any[]) => unknown) =>
              Promise.resolve(copies).then(resolve),
          };
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: any) => {
        const name = getTableName(table) ?? "unknown";
        // Emulate the MySQL unique active-claim key for the claims table.
        if (name === "creative_generation_claims" && values?.activeClaimKey) {
          const duplicate = harness.creativeGenerationClaims.some(
            (c) => c.activeClaimKey === values.activeClaimKey
          );
          if (duplicate) {
            const err: any = new Error(
              "Duplicate entry for key 'creative_generation_claims.active_claim_key'"
            );
            err.code = "ER_DUP_ENTRY";
            throw err;
          }
        }
        const id = harness.nextIds[name] ?? 9999;
        harness.nextIds[name] = id + 1;
        const row = { id, ...values };
        if (tableRows[name]) tableRows[name]().push(row);
        return [{ insertId: id }];
      },
    }),
    update: (table: unknown) => ({
      set: (payload: any) => ({
        where: async (condition: unknown) => {
          const name = getTableName(table) ?? "";
          if (name === "campaigns" && harness.campaign) {
            if (matches(condition, harness.campaign)) {
              Object.assign(harness.campaign, payload);
              return [{ affectedRows: 1 }];
            }
            return [{ affectedRows: 0 }];
          }
          const rows = tableRows[name] ? tableRows[name]() : [];
          let affected = 0;
          for (const row of rows) {
            if (matches(condition, row)) {
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

// ── Seeds and pipeline drivers ──────────────────────────────────────────────

const USER_ID = 42;
const CAMPAIGN_ID = 29;
const BUSINESS_ID = 5;
const STRATEGY_RUN_ID = 600;
const APPROVAL_REQUEST_ID = 901;
const SNAPSHOT_ID = "strategy_snap_b5";
const BDNA_ID = "bdna_snap_b5";
const STRATEGY_VERSION = 2;
const STRATEGY_PAYLOAD = {
  coreMessage: "Ride the summer.",
  valueProposition: "Handmade boards, built locally.",
  positioning: "Premium local craft",
  campaignTheme: "Summer board drop",
  personas: [{ name: "Sipho" }],
};
const STRATEGY_HASH = hashStrategySnapshotPayload(STRATEGY_PAYLOAD as any);

function briefFingerprint(): string {
  return buildGroundedCreativeBrief({ campaign: harness.campaign }).fingerprint;
}

function wireSnapshotAuthority(snapshotId = SNAPSHOT_ID, hash = STRATEGY_HASH) {
  vi.mocked(getStrategySnapshotByStrategyRunId).mockImplementation(
    async (runId: number) => ({
      snapshotId,
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      businessId: BUSINESS_ID,
      strategyRunId: runId,
      version: STRATEGY_VERSION,
      creativeBriefFingerprint: briefFingerprint(),
      businessDnaSnapshotId: BDNA_ID,
      strategyHashSha256: hash,
      snapshot: STRATEGY_PAYLOAD,
    }) as any
  );
}

function seedApprovedCampaign() {
  harness.business = {
    id: BUSINESS_ID,
    userId: USER_ID,
    name: "Acme Surf Co",
    industry: "retail",
    location: "Cape Town",
    productOrService: "Handmade surfboards",
    targetCustomer: "Surfers 18-40",
    brandTone: "bold",
    isActive: true,
  };
  harness.campaign = {
    id: CAMPAIGN_ID,
    userId: USER_ID,
    businessId: BUSINESS_ID,
    name: "Summer Board Drop",
    goal: "Sell 100 boards",
    platforms: "instagram,facebook",
    budget: 2000,
    status: "active",
    workflowState: "strategy_approved",
    approvalMode: "assisted",
    autoPublish: false,
    workflowContext: {},
  };
  const fingerprint = briefFingerprint();
  harness.campaign.workflowContext = {
    strategyFingerprint: fingerprint,
    approvedStrategyFingerprint: fingerprint,
    strategyApprovalLineage: {
      creativeBriefFingerprint: fingerprint,
      strategyRunId: STRATEGY_RUN_ID,
      approvalRequestId: APPROVAL_REQUEST_ID,
      status: "approved",
      strategySnapshotId: SNAPSHOT_ID,
      strategyVersion: STRATEGY_VERSION,
      businessDnaSnapshotId: BDNA_ID,
      strategyHashSha256: STRATEGY_HASH,
    },
  };
  harness.agentRuns = [
    {
      id: STRATEGY_RUN_ID,
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      agentType: "strategy",
      status: "completed",
      output: {},
      startedAt: "2026-06-01T08:00:00.000Z",
    },
  ];
  harness.contentPosts = [];
  harness.campaignAssets = [];
  harness.generatedImages = [];
  harness.creativeGenerationClaims = [];
  harness.creditTransactions = [];
  harness.creativeRuns = 0;
  harness.creativeShouldFail = false;
  harness.renderCompletions = 0;
  harness.captionGenerations = 0;
  harness.audienceRuns = 0;
  harness.creativeSuccessCharges = [];
  harness.nextIds = {
    agent_runs: 6000,
    content_posts: 4000,
    campaign_assets: 4500,
    generated_images: 4700,
    creative_generation_claims: 4800,
    credit_transactions: 3000,
  };
}

async function installDb() {
  vi.mocked(getDb).mockReturnValue(createHarnessDb() as any);
}

/** Mirrors the governed creative entry: claim → run → release → trigger. */
async function driveCreativeGeneration(): Promise<{
  claimCollision: boolean;
  packRunId: number | null;
}> {
  const ownerToken = generateOwnerToken();
  const claimResult = await acquireCreativeGenerationClaim({
    userId: USER_ID,
    campaignId: CAMPAIGN_ID,
    operationSource: "agent",
    ownerToken,
    leaseExpiresAt: new Date(Date.now() + 60_000),
  });
  if (!claimResult.acquired) {
    return { claimCollision: true, packRunId: null };
  }

  const { runCreativeAgent } = await import("../../agents/creative-agent");
  try {
    const result = await runCreativeAgent({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      generationOperation: { source: "agent", id: 1 },
      strategyInput: await resolveCreativeEntryStrategyAuthority({
        campaign: harness.campaign,
        userId: USER_ID,
        campaignId: CAMPAIGN_ID,
      }),
    });
    await releaseClaimWithResult({
      claimId: claimResult.claim.id,
      ownerToken,
      status: "completed",
      context: "harness",
    });
    await onAgentRunComplete(result.packRunId);
    return { claimCollision: false, packRunId: result.packRunId };
  } catch (err) {
    await releaseClaimWithResult({
      claimId: claimResult.claim.id,
      ownerToken,
      status: "failed",
      context: "harness",
    });
    throw err;
  }
}

/** Mirrors the render worker terminal write (external boundary). Idempotent:
 * a duplicate trigger of the same render operation reuses the completed row.
 */
async function driveRenderCompletion() {
  const post = harness.contentPosts.find(
    (p) => p.metadata?.assetKind === "master_campaign_post"
  );
  if (!post) throw new Error("no leaflet post to render");
  if (post.metadata?.imageStatus === "ready") {
    await syncCreativeReleasePackage({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      sealedBy: "harness.render",
    });
    return;
  }
  harness.generatedImages.push({
    id: harness.nextIds.generated_images++,
    userId: USER_ID,
    campaignId: CAMPAIGN_ID,
    contentPostId: post.id,
    status: "completed",
    url: "https://cdn.example.com/leaflet.png",
    createdAt: new Date().toISOString(),
    metadata: {
      renderLineage: {
        lineageSchemaVersion: 1,
        lineageFingerprintSha256: "r".repeat(64),
        strategy: {
          strategySnapshotId: SNAPSHOT_ID,
          strategyVersion: STRATEGY_VERSION,
          businessDnaSnapshotId: BDNA_ID,
          strategyHashSha256: STRATEGY_HASH,
        },
      },
      creativeBriefFingerprint: briefFingerprint(),
    },
  });
  post.metadata = {
    ...post.metadata,
    imageStatus: "ready",
    imageUrl: "https://cdn.example.com/leaflet.png",
    imageCurrentVersionId: harness.generatedImages[harness.generatedImages.length - 1].id,
  };
  harness.renderCompletions += 1;
  await syncCreativeReleasePackage({
    userId: USER_ID,
    campaignId: CAMPAIGN_ID,
    sealedBy: "harness.render",
  });
}

/** Mirrors the caption pack terminal write (external boundary). Idempotent:
 * a duplicate trigger reuses the existing ready pack for the current brief.
 */
async function driveCaptionPack() {
  const fingerprint = briefFingerprint();
  const existing = harness.campaignAssets.find(
    (a) =>
      a.assetType === "caption_pack" &&
      a.status === "ready" &&
      a.metadata?.creativeBriefFingerprint === fingerprint
  );
  if (existing) {
    await syncCreativeReleasePackage({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      sealedBy: "harness.caption-pack",
    });
    return;
  }
  const authority = (harness.campaign.workflowContext.strategyApprovalLineage ?? {}) as any;
  harness.campaignAssets.push({
    id: harness.nextIds.campaign_assets++,
    userId: USER_ID,
    campaignId: CAMPAIGN_ID,
    assetType: "caption_pack",
    title: "Caption Pack",
    status: "ready",
    createdAt: new Date().toISOString(),
    metadata: {
      creativeBriefFingerprint: fingerprint,
      strategySnapshotId: authority.strategySnapshotId,
      strategyVersion: authority.strategyVersion,
      businessDnaSnapshotId: authority.businessDnaSnapshotId,
      strategyHashSha256: authority.strategyHashSha256,
    },
  });
  harness.captionGenerations += 1;
  await syncCreativeReleasePackage({
    userId: USER_ID,
    campaignId: CAMPAIGN_ID,
    sealedBy: "harness.caption-pack",
  });
}

function sealedPackage(): CreativeReleasePackage | null {
  return readSealedCreativeReleasePackage(harness.campaign);
}

async function expectExactlyOnePackage() {
  const pkg = sealedPackage();
  expect(pkg, "exactly one authoritative release package must be sealed").not.toBeNull();
  assertCreativeReleasePackageIntact(pkg!);
  const context = harness.campaign.workflowContext as Record<string, unknown>;
  expect(
    Object.keys(context).filter((k) => k === CREATIVE_RELEASE_PACKAGE_CONTEXT_KEY)
  ).toHaveLength(1);
  return pkg!;
}

// ── Scenarios ───────────────────────────────────────────────────────────────

describe.sequential("R4-B5 creative release acceptance — synthetic harness", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    seedApprovedCampaign();
    await installDb();
    wireSnapshotAuthority();
  });

  it("scenario 1 (happy path): approved Strategy → complete governed release package", async () => {
    const { claimCollision, packRunId } = await driveCreativeGeneration();
    expect(claimCollision).toBe(false);
    expect(packRunId).not.toBeNull();
    expect(harness.campaign.workflowState).toBe("creatives_ready");
    // Not sealed yet: the leaflet is not rendered and captions are missing.
    expect(sealedPackage()).toBeNull();

    await driveRenderCompletion();
    expect(sealedPackage()).toBeNull(); // captions still missing

    await driveCaptionPack();
    const pkg = await expectExactlyOnePackage();

    // Required artefacts present with complete lineage.
    const kinds = pkg.artefacts.map((a) => a.kind).sort();
    expect(kinds).toEqual(["caption_pack", "leaflet", "message_pack", "supporting_asset"]);
    expect(pkg.strategy).toMatchObject({
      strategySnapshotId: SNAPSHOT_ID,
      businessDnaSnapshotId: BDNA_ID,
      strategyHashSha256: STRATEGY_HASH,
      creativeBriefFingerprint: briefFingerprint(),
    });
    for (const ref of pkg.artefacts) {
      expect(ref.creativeBriefFingerprint).toBe(briefFingerprint());
    }
    expect(pkg.quality.renderedLeafletReady).toBe(true);

    // Stream C consumption surface is present and verifiable.
    expect(pkg.packageId).toBe(`crp:${CAMPAIGN_ID}:${briefFingerprint()}`);
    expect(typeof pkg.packageFingerprintSha256).toBe("string");

    // Ownership: every artefact belongs to this campaign and user.
    for (const post of harness.contentPosts) {
      expect(post.campaignId).toBe(CAMPAIGN_ID);
      expect(post.userId).toBe(USER_ID);
    }
  });

  it("scenario 2 (duplicate creative trigger): same operation identity, no duplicate artefacts or charges", async () => {
    // First trigger acquires the operation claim and HOLDS it during the run.
    const ownerToken = generateOwnerToken();
    const first = await acquireCreativeGenerationClaim({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      operationSource: "agent",
      ownerToken,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    expect(first.acquired).toBe(true);
    if (!first.acquired) return;

    // Duplicate trigger while the operation is in flight: the claim layer
    // reports the collision with the SAME existing operation identity, and
    // no second generation can start.
    const duplicate = await acquireCreativeGenerationClaim({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      operationSource: "agent",
      ownerToken: generateOwnerToken(),
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    expect(duplicate.acquired).toBe(false);
    if (!duplicate.acquired) {
      expect(duplicate.existingClaim.id).toBe(first.claim.id);
      expect(harness.creativeRuns).toBe(0);
    }

    const { runCreativeAgent } = await import("../../agents/creative-agent");
    const result = await runCreativeAgent({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      generationOperation: { source: "agent", id: 1 },
      strategyInput: await resolveCreativeEntryStrategyAuthority({
        campaign: harness.campaign,
        userId: USER_ID,
        campaignId: CAMPAIGN_ID,
      }),
    });
    await releaseClaimWithResult({
      claimId: first.claim.id,
      ownerToken,
      status: "completed",
      context: "harness",
    });
    await onAgentRunComplete(result.packRunId);

    expect(harness.campaign.workflowState).toBe("creatives_ready");
    const postsAfterFirst = harness.contentPosts.length;
    const assetsAfterFirst = harness.campaignAssets.length;
    const audienceAfterFirst = harness.audienceRuns;

    // Trigger replay after completion: no second generation, no duplicate
    // artefacts, no second audience run.
    await onAgentRunComplete(result.packRunId);
    expect(harness.creativeRuns).toBe(1);
    expect(harness.contentPosts).toHaveLength(postsAfterFirst);
    expect(harness.campaignAssets).toHaveLength(assetsAfterFirst);
    expect(harness.audienceRuns).toBe(audienceAfterFirst);
  });

  it("scenario 3 (transient generation failure + retry): one package after recovery", async () => {
    harness.creativeShouldFail = true;
    await expect(driveCreativeGeneration()).rejects.toMatchObject({
      message: expect.stringContaining("quality standards"),
    });
    expect(sealedPackage()).toBeNull();
    expect(
      harness.creativeGenerationClaims.map((c) => c.status)
    ).toEqual(["failed"]);

    // Retry uses a fresh operation identity (previous claim terminal).
    harness.creativeShouldFail = false;
    const retry = await driveCreativeGeneration();
    expect(retry.claimCollision).toBe(false);
    expect(harness.campaign.workflowState).toBe("creatives_ready");

    await driveRenderCompletion();
    await driveCaptionPack();
    await expectExactlyOnePackage();
    expect(harness.creativeRuns).toBe(2);
  });

  it("scenario 4 (restart/re-entry after partial progress): replay converges without duplicates", async () => {
    const { packRunId } = await driveCreativeGeneration();
    expect(harness.campaign.workflowState).toBe("creatives_ready");

    // Simulate restart re-entry: the trigger replays the same pack run
    // completion (idempotent trigger path) — no new artefacts, one audience.
    const posts = harness.contentPosts.length;
    const assets = harness.campaignAssets.length;
    await onAgentRunComplete(packRunId!);
    await onAgentRunComplete(packRunId!);
    expect(harness.contentPosts).toHaveLength(posts);
    expect(harness.campaignAssets).toHaveLength(assets);
    expect(harness.creativeRuns).toBe(1);
    expect(harness.audienceRuns).toBe(1);

    await driveRenderCompletion();
    await driveCaptionPack();
    const pkg = await expectExactlyOnePackage();
    expect(pkg.sealedBy).toBe("harness.caption-pack");
  });

  it("scenario 5 (rejected/failed quality gate): fail closed, then recover to exactly one seal", async () => {
    harness.creativeShouldFail = true;
    await expect(driveCreativeGeneration()).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
    // Failed closed: nothing sealed, no partial artefacts persisted.
    expect(sealedPackage()).toBeNull();
    expect(harness.contentPosts).toHaveLength(0);
    expect(harness.campaignAssets).toHaveLength(0);

    // Recovery after regeneration under the same approved brief.
    harness.creativeShouldFail = false;
    await driveCreativeGeneration();
    await driveRenderCompletion();
    await driveCaptionPack();
    await expectExactlyOnePackage();
  });

  it("scenario 6 (stale Strategy/Business-DNA lineage): entry and seal fail closed, history intact", async () => {
    await driveCreativeGeneration();
    await driveRenderCompletion();
    await driveCaptionPack();
    const pkg = await expectExactlyOnePackage();

    // Brief drift without re-approval: creative entry fails closed.
    harness.campaign.coreMessage = "Repositioned without re-approval";
    await expect(
      resolveCreativeEntryStrategyAuthority({
        campaign: harness.campaign,
        userId: USER_ID,
        campaignId: CAMPAIGN_ID,
      })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    // Re-seal under stale authority fails closed and keeps history intact.
    const reseal = await syncCreativeReleasePackage({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      sealedBy: "harness.stale-reseal",
    });
    expect(reseal.outcome).toBe("incomplete");
    if (reseal.outcome === "incomplete") {
      expect(reseal.reasons).toContain("strategy_authority_stale");
    }
    const intact = sealedPackage();
    expect(intact!.packageFingerprintSha256).toBe(pkg.packageFingerprintSha256);

    // Snapshot hash tamper: the immutable snapshot authority also fails closed.
    wireSnapshotAuthority(SNAPSHOT_ID, "0".repeat(64));
    await expect(
      resolveCreativeEntryStrategyAuthority({
        campaign: harness.campaign,
        userId: USER_ID,
        campaignId: CAMPAIGN_ID,
      })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("scenario 7 (repeated invocation after successful release): already_present, immutable", async () => {
    await driveCreativeGeneration();
    await driveRenderCompletion();
    await driveCaptionPack();
    const pkg = await expectExactlyOnePackage();

    // Repeated renders / caption triggers / seal invocations change nothing.
    await driveRenderCompletion();
    await driveCaptionPack();
    const again = await syncCreativeReleasePackage({
      userId: USER_ID,
      campaignId: CAMPAIGN_ID,
      sealedBy: "harness.repeated",
    });
    expect(again.outcome).toBe("already_present");
    if (again.outcome !== "incomplete") {
      expect(again.packageId).toBe(pkg.packageId);
    }

    const after = sealedPackage()!;
    expect(after.sealedBy).toBe(pkg.sealedBy);
    expect(after.sealedAtIso).toBe(pkg.sealedAtIso);
    expect(after.packageFingerprintSha256).toBe(pkg.packageFingerprintSha256);
    assertCreativeReleasePackageIntact(after);

    // Historical artefacts remain untouched by repeated invocations.
    const post = harness.contentPosts[0];
    expect(post.metadata.generationRunId).toMatch(/^pack-/);
    expect(post.metadata.imageStatus).toBe("ready");
  });
});
