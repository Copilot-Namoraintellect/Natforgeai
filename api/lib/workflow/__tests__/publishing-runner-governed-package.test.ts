import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.PUBLIC_APP_URL = "https://natforgeai.com";

import { buildGroundedCreativeBrief } from "../../creative/brief-grounding";
import { deductCredits } from "../../billing/credit-engine";
import { createPlatformAdapterRegistry } from "../../integrations/adapters/adapter-registry";
import type { PlatformAdapterId } from "../../integrations/adapters/platform-adapter";
import {
  buildPublishPackage,
  type PublishPackage,
  type PublishPackageBuildInput,
} from "../../publish/publish-package-builder";
import { deriveCreativeArtifactLineageFingerprint } from "../../creative/artifact-lineage";

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

vi.mock("../engine", () => ({
  transitionCampaignState: vi.fn(async () => "campaign_live"),
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
  approvals = [],
}: {
  queueItem?: Record<string, unknown>;
  contentPost?: Record<string, unknown>;
  integration?: Record<string, unknown>;
  campaign?: Record<string, unknown>;
  business?: Record<string, unknown>;
  approvals?: Record<string, unknown>[];
}) {
  const updateCalls: Array<{ table: string | undefined; set: Record<string, unknown> }> = [];
  const insertCalls: Array<{ table: string | undefined; values: Record<string, unknown> }> = [];
  const db: any = {
    updateCalls,
    insertCalls,
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        const name = getTableName(table);
        let rows: unknown[] = [];
        if (name === "publishing_queue") rows = queueItem ? [queueItem] : [];
        if (name === "content_posts") rows = contentPost ? [contentPost] : [];
        if (name === "social_integrations") rows = integration ? [integration] : [];
        if (name === "campaigns") rows = campaign ? [campaign] : [];
        if (name === "businesses") rows = business ? [business] : [];
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
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: Record<string, unknown>) => {
        insertCalls.push({ table: getTableName(table), values });
        return Promise.resolve([{ insertId: 1 }]);
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((data: Record<string, unknown>) => ({
        where: vi.fn(async () => {
          updateCalls.push({ table: getTableName(table), set: data });
          return [{ affectedRows: 1 }];
        }),
      })),
    })),
    transaction: async (cb: any) => cb(db),
  };
  return db;
}

// ─── Distinctive governed copy — every byte must survive transport ───

const GOVERNED_HOOK = "HOOK::governed package seam::";
const GOVERNED_CAPTION = "CAPTION::semantic body must never change::";
const GOVERNED_CTA = "CTA::☎ CALL 555-0199 — say ZEBRA::";
const GOVERNED_TEXT = `${GOVERNED_HOOK}\n\n${GOVERNED_CAPTION}\n\n${GOVERNED_CTA}`;
const RELATIVE_IMAGE_URL = "/generated/images/27/governed-seam.png";
const ABSOLUTE_IMAGE_URL = `https://natforgeai.com${RELATIVE_IMAGE_URL}`;

// ─── Publication-authority fixtures (same readiness gate as legacy tests) ───

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

const approvedLaunchApproval = {
  id: 7,
  userId: 14,
  campaignId: 27,
  approvalType: "campaign_launch",
  status: "approved",
};

function currentFingerprintFor(campaign: Record<string, unknown>) {
  return buildGroundedCreativeBrief({ campaign, business: readyBusiness }).fingerprint;
}

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

function governedContentPost(overrides: Record<string, unknown> = {}) {
  return {
    id: 117,
    campaignId: 27,
    hook: GOVERNED_HOOK,
    caption: GOVERNED_CAPTION,
    cta: GOVERNED_CTA,
    metadata: {
      imageUrl: RELATIVE_IMAGE_URL,
      creativeBriefFingerprint: currentFingerprintFor(readyCampaign),
    },
    ...overrides,
  };
}

function queueItemFor(platform: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    userId: 14,
    campaignId: 27,
    contentPostId: 117,
    platform,
    status: "approved",
    safetyStatus: "low",
    retryCount: 0,
    maxRetries: 3,
    integrationId: 9,
    scheduledAt: null,
    nextRetryAt: null,
    ...overrides,
  };
}

const facebookIntegration = {
  id: 9,
  userId: 14,
  platform: "facebook",
  status: "connected",
  accountName: "Test Page",
  pageId: "830205703508466",
  pageAccessTokenEncrypted: "page-token-encrypted",
  accessTokenEncrypted: "user-token-encrypted",
};

const instagramIntegration = {
  id: 9,
  userId: 14,
  platform: "instagram",
  status: "connected",
  accountName: "IG Account",
  instagramBusinessAccountId: "ig_biz_123",
  pageAccessTokenEncrypted: "page-token-encrypted",
  accessTokenEncrypted: "user-token-encrypted",
};

const linkedinIntegration = {
  id: 9,
  userId: 14,
  platform: "linkedin",
  status: "connected",
  accountName: "urn:li:organization:123",
  accessTokenEncrypted: "user-token-encrypted",
};

const twitterIntegration = {
  id: 9,
  userId: 14,
  platform: "twitter",
  status: "connected",
  accountName: "zutohub",
  accessTokenEncrypted: "user-token-encrypted",
};

function integrationFor(platform: string): Record<string, unknown> {
  switch (platform) {
    case "instagram":
      return instagramIntegration;
    case "linkedin":
      return linkedinIntegration;
    case "twitter":
      return twitterIntegration;
    default:
      return facebookIntegration;
  }
}

// ─── Governed publish package fixture ───

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);

const STRATEGY = {
  strategySnapshotId: "strategy_snapshot_1",
  strategyVersion: 3,
  businessDnaSnapshotId: "bdna_1",
  strategyHashSha256: HASH_A,
  strategyRunId: 55,
  approvalRequestId: 77,
  creativeBriefFingerprint: "brief_fp_1",
};

const APPROVED_COPY = {
  copyHashSha256: HASH_B,
  copySchemaVersion: "v2",
  approvedRevisionId: "rev-1",
  assessmentHashSha256: HASH_C,
  contextLockId: "ctx-1",
};

function captionLineage() {
  return {
    lineageSchemaVersion: 1,
    artifactKind: "caption_pack",
    artifactId: 501,
    lineageFingerprintSha256: deriveCreativeArtifactLineageFingerprint({
      artifactKind: "caption_pack",
      platform: null,
      parent: null,
      strategy: STRATEGY,
      approvedCopy: APPROVED_COPY,
    }),
    strategy: STRATEGY,
    approvedCopy: APPROVED_COPY,
  };
}

function buildGovernedPackage(platform: string, integrationId: number | null = 9): PublishPackage {
  return buildPublishPackage({
    campaignId: 27,
    userId: 14,
    businessId: 24,
    destination: { platform, integrationId },
    intent: { mode: "immediate" },
    strategyAuthority: STRATEGY,
    approvedCopy: APPROVED_COPY,
    selectedContent: {
      contentPostId: 117,
      artifactKind: "content_post",
      lineage: {
        lineageSchemaVersion: 1,
        artifactKind: "content_post",
        artifactId: 117,
        lineageFingerprintSha256: HASH_D,
        strategy: STRATEGY,
        approvedCopy: APPROVED_COPY,
      },
    },
    captionArtifact: { artifactId: 501, artifactKind: "caption_pack", lineage: captionLineage() },
    visualArtifact: {
      mediaKind: "image",
      generatedAssetId: 909,
      mediaUrl: RELATIVE_IMAGE_URL,
      renderLineage: {
        lineageFingerprintSha256: HASH_E,
        strategy: STRATEGY,
        approvedCopy: APPROVED_COPY,
      },
    },
    evidence: { launchApprovalRequestId: 7 },
    payload: { text: GOVERNED_TEXT, mediaUrls: [RELATIVE_IMAGE_URL], mediaType: "image" },
  } as PublishPackageBuildInput);
}

// ─── Fake governed adapters (full PlatformAdapter contract) ───

function makeFakeAdapter(platform: PlatformAdapterId) {
  return {
    platform,
    validateInput: vi.fn((_input: any) => ({ ok: true, issues: [] as any[] })),
    validateDestination: vi.fn((_destination: any) => ({ ok: true, issues: [] as any[] })),
    buildProviderRequest: vi.fn((input: any, destination: any) => ({
      content: input.content,
      destination,
    })),
    publish: vi.fn(async (_request: any, _destination: any, operation: any) => ({
      platform,
      operationId: operation.operationId as string,
      status: "published" as const,
      externalPostId: `${platform}_ext_1`,
      externalUrl: `https://provider.example/${platform}/${platform}_ext_1`,
    })),
    normalizeReceipt: vi.fn((raw: any, operation: any) => ({
      platform,
      operationId: operation.operationId as string,
      status: "published" as const,
      externalPostId: raw.postId,
      externalUrl: raw.url,
    })),
    normalizeError: vi.fn((error: any, operation: any) => ({
      platform,
      category: "provider" as const,
      code: "provider_error",
      message: String(error?.message ?? error),
      retryable: true,
      operationId: operation?.operationId,
    })),
  };
}

type FakeAdapter = ReturnType<typeof makeFakeAdapter>;

function makeRegistryWith(fakes: Partial<Record<PlatformAdapterId, FakeAdapter>>) {
  const registry = createPlatformAdapterRegistry(fakes as any);
  const resolveSpy = vi.spyOn(registry, "resolve");
  return { registry, resolveSpy };
}

function publishedQueueUpdate(db: any) {
  return db.updateCalls.find(
    (call: { table: string | undefined; set: Record<string, unknown> }) =>
      call.table === "publishing_queue" && call.set.status === "published"
  );
}

describe("publishSinglePost — governed publish-package → adapter seam (WBS13 convergence)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const platform of ["facebook", "instagram", "linkedin", "twitter"] as const) {
    it(`resolves ${platform} through the adapter registry and transports package copy byte-for-byte`, async () => {
      const { getDb } = await import("../../../queries/connection");
      const { publishSinglePost } = await import("../publishing-runner");
      const fakes = {
        facebook: makeFakeAdapter("facebook"),
        instagram: makeFakeAdapter("instagram"),
        linkedin: makeFakeAdapter("linkedin"),
        twitter: makeFakeAdapter("twitter"),
      };
      const { registry, resolveSpy } = makeRegistryWith(fakes);
      const pkg = buildGovernedPackage(platform);

      vi.mocked(getDb).mockReturnValue(
        createMockDb({
          queueItem: queueItemFor(platform),
          contentPost: governedContentPost(),
          integration: integrationFor(platform),
          campaign: readyCampaignWithApprovedLineage,
          business: readyBusiness,
          approvals: [approvedLaunchApproval],
        }) as any
      );

      const result = await publishSinglePost(1, { publishPackage: pkg, adapterRegistry: registry });

      // The governed path reaches the registry and resolves exactly this platform.
      expect(resolveSpy).toHaveBeenCalledTimes(1);
      expect(resolveSpy).toHaveBeenCalledWith(platform);

      // Exactly the resolved platform's adapter published; no other adapter did.
      expect(fakes[platform].publish).toHaveBeenCalledTimes(1);
      for (const other of Object.keys(fakes) as PlatformAdapterId[]) {
        if (other !== platform) expect(fakes[other].publish).not.toHaveBeenCalled();
      }

      // Text, CTA, and media are transported unchanged from the package payload.
      const adapterInput = fakes[platform].validateInput.mock.calls[0]?.[0];
      expect(adapterInput).toBeDefined();
      expect(adapterInput.operationId).toBe(`publication:${platform}:1`);
      expect(adapterInput.content.text).toBe(GOVERNED_TEXT);
      expect(adapterInput.content.text).toContain("CTA::☎ CALL 555-0199 — say ZEBRA::");
      // Only Facebook rewrites media pre-transport (deterministic public-URL
      // resolution); every other platform receives the package bytes verbatim.
      expect(adapterInput.content.mediaUrls).toEqual([
        platform === "facebook" ? ABSOLUTE_IMAGE_URL : RELATIVE_IMAGE_URL,
      ]);
      expect(adapterInput.content.mediaType).toBe("image");

      const request = fakes[platform].buildProviderRequest.mock.calls[0]?.[0];
      expect(request.content.text).toBe(pkg.payload.text);

      // Normalized receipt mapped back onto the runner result + durable queue row.
      expect(result.status).toBe("published");
      expect(result.postId).toBe(`${platform}_ext_1`);
      expect(result.publishPackageId).toBe(pkg.packageId);
      expect(result.packageFingerprintSha256).toBe(pkg.packageFingerprintSha256);
      expect(result.publishPackageClassification).toBe("governed");

      const db = vi.mocked(getDb).mock.results[0].value as any;
      expect(publishedQueueUpdate(db)?.set.externalPostId).toBe(`${platform}_ext_1`);

      // Governed audit events carry the existing audit_events.packageId slot.
      const auditInserts = db.insertCalls.filter((c: any) => c.table === "audit_events");
      expect(auditInserts.length).toBeGreaterThan(0);
      for (const call of auditInserts) {
        expect(call.values.packageId).toBe(pkg.packageId);
      }
    });
  }

  it("passes the per-platform destination credentials through to the adapter", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { publishSinglePost } = await import("../publishing-runner");
    const fakes = {
      facebook: makeFakeAdapter("facebook"),
      instagram: makeFakeAdapter("instagram"),
      linkedin: makeFakeAdapter("linkedin"),
      twitter: makeFakeAdapter("twitter"),
    };
    const { registry } = makeRegistryWith(fakes);

    for (const platform of ["facebook", "instagram", "linkedin", "twitter"] as const) {
      vi.mocked(getDb).mockReturnValue(
        createMockDb({
          queueItem: queueItemFor(platform),
          contentPost: governedContentPost(),
          integration: integrationFor(platform),
          campaign: readyCampaignWithApprovedLineage,
          business: readyBusiness,
          approvals: [approvedLaunchApproval],
        }) as any
      );
      await publishSinglePost(1, { publishPackage: buildGovernedPackage(platform), adapterRegistry: registry });
    }

    expect(fakes.facebook.publish.mock.calls[0][1]).toEqual({
      accessToken: "decrypted:page-token-encrypted",
      pageId: "830205703508466",
    });
    expect(fakes.instagram.publish.mock.calls[0][1]).toEqual({
      accessToken: "decrypted:page-token-encrypted",
      instagramBusinessAccountId: "ig_biz_123",
    });
    expect(fakes.linkedin.publish.mock.calls[0][1]).toEqual({
      accessToken: "decrypted:user-token-encrypted",
      organizationId: "urn:li:organization:123",
    });
    expect(fakes.twitter.publish.mock.calls[0][1]).toEqual({
      accessToken: "decrypted:user-token-encrypted",
    });
  });

  it("keeps one stable operation identity when the same queue item is retried", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { publishSinglePost } = await import("../publishing-runner");
    const fake = makeFakeAdapter("facebook");
    const { registry } = makeRegistryWith({ facebook: fake });
    const pkg = buildGovernedPackage("facebook");

    fake.publish
      .mockRejectedValueOnce({
        platform: "facebook",
        category: "network",
        code: "provider_network",
        message: "fetch failed",
        retryable: true,
        operationId: "publication:facebook:1",
      })
      .mockResolvedValueOnce({
        platform: "facebook",
        operationId: "publication:facebook:1",
        status: "published" as const,
        externalPostId: "fb_retry_1",
        externalUrl: "https://provider.example/facebook/fb_retry_1",
      });

    vi.mocked(getDb).mockReturnValue(
      createMockDb({
        queueItem: queueItemFor("facebook"),
        contentPost: governedContentPost(),
        integration: facebookIntegration,
        campaign: readyCampaignWithApprovedLineage,
        business: readyBusiness,
        approvals: [approvedLaunchApproval],
      }) as any
    );

    const first = await publishSinglePost(1, { publishPackage: pkg, adapterRegistry: registry });
    expect(first.status).toBe("retrying");

    // Retry of the same queue item: the queue row is now in retrying state.
    vi.mocked(getDb).mockReturnValue(
      createMockDb({
        queueItem: queueItemFor("facebook", { status: "retrying", retryCount: 1 }),
        contentPost: governedContentPost(),
        integration: facebookIntegration,
        campaign: readyCampaignWithApprovedLineage,
        business: readyBusiness,
        approvals: [approvedLaunchApproval],
      }) as any
    );

    const second = await publishSinglePost(1, { publishPackage: pkg, adapterRegistry: registry });
    expect(second.status).toBe("published");
    expect(second.postId).toBe("fb_retry_1");

    const firstOperation = fake.publish.mock.calls[0][2].operationId;
    const retryOperation = fake.publish.mock.calls[1][2].operationId;
    expect(firstOperation).toBe("publication:facebook:1");
    expect(retryOperation).toBe(firstOperation);

    // The retried submission carries the identical package text.
    expect(fake.publish.mock.calls[1][0].content.text).toBe(GOVERNED_TEXT);
    // Credits were deducted once, on the first attempt only.
    expect(vi.mocked(deductCredits)).toHaveBeenCalledTimes(1);
  });

  it("publishes through the real adapter boundary with exactly one provider submission and no legacy duplicate", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { publishToFacebook, publishToTwitter } = await import("../../integrations/platforms");
    const { publishSinglePost } = await import("../publishing-runner");
    const pkg = buildGovernedPackage("facebook");

    vi.mocked(publishToFacebook).mockResolvedValue({
      success: true,
      postId: "fb_governed_1",
      url: "https://facebook.com/fb_governed_1",
    });

    vi.mocked(getDb).mockReturnValue(
      createMockDb({
        queueItem: queueItemFor("facebook"),
        contentPost: governedContentPost(),
        integration: facebookIntegration,
        campaign: readyCampaignWithApprovedLineage,
        business: readyBusiness,
        approvals: [approvedLaunchApproval],
      }) as any
    );

    // No registry injected: the runner's default governed registry resolves the
    // real Facebook adapter, which delegates to the existing provider function.
    const result = await publishSinglePost(1, { publishPackage: pkg });

    expect(result.status).toBe("published");
    expect(result.postId).toBe("fb_governed_1");
    expect(result.publishPackageId).toBe(pkg.packageId);
    expect(publishToFacebook).toHaveBeenCalledTimes(1);
    expect(publishToFacebook).toHaveBeenCalledWith(
      "decrypted:page-token-encrypted",
      "830205703508466",
      expect.objectContaining({
        text: GOVERNED_TEXT,
        // deterministic transport formatting: relative package media URL
        // resolved against the public app URL, exactly as the legacy path does
        mediaUrls: [ABSOLUTE_IMAGE_URL],
        mediaType: "image",
      })
    );
    expect(publishToTwitter).not.toHaveBeenCalled();

    const db = vi.mocked(getDb).mock.results[0].value as any;
    expect(publishedQueueUpdate(db)?.set.externalPostId).toBe("fb_governed_1");
  });

  it("maps a retryable provider failure into the runner's retrying semantics", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { publishToFacebook } = await import("../../integrations/platforms");
    const { publishSinglePost } = await import("../publishing-runner");

    vi.mocked(publishToFacebook).mockResolvedValue({
      success: false,
      error: "fetch failed",
    });

    const db = createMockDb({
      queueItem: queueItemFor("facebook"),
      contentPost: governedContentPost(),
      integration: facebookIntegration,
      campaign: readyCampaignWithApprovedLineage,
      business: readyBusiness,
      approvals: [approvedLaunchApproval],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const result = await publishSinglePost(1, { publishPackage: buildGovernedPackage("facebook") });

    expect(result.status).toBe("retrying");
    expect(result.error).toBe("fetch failed");
    const retryUpdate = db.updateCalls.find(
      (call: { table: string | undefined; set: Record<string, unknown> }) =>
        call.table === "publishing_queue" && call.set.status === "retrying"
    );
    expect(retryUpdate?.set.retryCount).toBe(1);
    expect(retryUpdate?.set.nextRetryAt).toBeInstanceOf(Date);
    expect(retryUpdate?.set.lastError).toBe("fetch failed");
  });

  it("maps a terminal provider failure into the runner's terminal failure semantics", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { publishToFacebook } = await import("../../integrations/platforms");
    const { createAlert } = await import("../../alerts");
    const { publishSinglePost } = await import("../publishing-runner");

    vi.mocked(publishToFacebook).mockResolvedValue({
      success: false,
      error: "Invalid token",
    });

    const db = createMockDb({
      queueItem: queueItemFor("facebook", { retryCount: 2 }),
      contentPost: governedContentPost(),
      integration: facebookIntegration,
      campaign: readyCampaignWithApprovedLineage,
      business: readyBusiness,
      approvals: [approvedLaunchApproval],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const result = await publishSinglePost(1, { publishPackage: buildGovernedPackage("facebook") });

    expect(result.status).toBe("failed");
    expect(result.error).toBe("Invalid token");
    const failedUpdate = db.updateCalls.find(
      (call: { table: string | undefined; set: Record<string, unknown> }) =>
        call.table === "publishing_queue" && call.set.status === "failed"
    );
    expect(failedUpdate?.set.retryCount).toBe(3);
    expect(failedUpdate?.set.lastError).toBe("Invalid token");
    expect(failedUpdate?.set.nextRetryAt).toBeNull();
    expect(createAlert).toHaveBeenCalledTimes(1);
  });

  it("fails closed before any adapter or provider call when the package destination diverges from the resolved integration", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { publishToFacebook } = await import("../../integrations/platforms");
    const { publishSinglePost } = await import("../publishing-runner");
    const fake = makeFakeAdapter("facebook");
    const { registry } = makeRegistryWith({ facebook: fake });
    const pkg = buildGovernedPackage("facebook", 9);

    // Queue item pins no integration; the platform fallback resolves a
    // different connected account (id 99) than the package is bound to (id 9).
    const db = createMockDb({
      queueItem: queueItemFor("facebook", { integrationId: null }),
      contentPost: governedContentPost(),
      integration: { ...facebookIntegration, id: 99 },
      campaign: readyCampaignWithApprovedLineage,
      business: readyBusiness,
      approvals: [approvedLaunchApproval],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const result = await publishSinglePost(1, { publishPackage: pkg, adapterRegistry: registry });

    expect(result.status).toBe("precondition_failed");
    expect(result.error).toContain("bound to integration 9");
    expect(fake.publish).not.toHaveBeenCalled();
    expect(publishToFacebook).not.toHaveBeenCalled();
    const failedUpdate = db.updateCalls.find(
      (call: { table: string | undefined; set: Record<string, unknown> }) =>
        call.table === "publishing_queue"
    );
    expect(failedUpdate?.set.status).toBe("failed");
  });

  it("fails closed before any adapter or provider call when the resolved integration platform diverges from the package destination", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { publishToFacebook } = await import("../../integrations/platforms");
    const { publishSinglePost } = await import("../publishing-runner");
    const fake = makeFakeAdapter("facebook");
    const { registry } = makeRegistryWith({ facebook: fake });

    const db = createMockDb({
      queueItem: queueItemFor("facebook"),
      contentPost: governedContentPost(),
      integration: { ...facebookIntegration, platform: "twitter" },
      campaign: readyCampaignWithApprovedLineage,
      business: readyBusiness,
      approvals: [approvedLaunchApproval],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const result = await publishSinglePost(1, {
      publishPackage: buildGovernedPackage("facebook"),
      adapterRegistry: registry,
    });

    expect(result.status).toBe("precondition_failed");
    expect(result.error).toContain("destination platform facebook does not match");
    expect(fake.publish).not.toHaveBeenCalled();
    expect(publishToFacebook).not.toHaveBeenCalled();
  });

  it("fails closed before any adapter or provider call when the package was tampered with after assembly", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { publishToFacebook } = await import("../../integrations/platforms");
    const { publishSinglePost } = await import("../publishing-runner");
    const fake = makeFakeAdapter("facebook");
    const { registry } = makeRegistryWith({ facebook: fake });

    const pkg = buildGovernedPackage("facebook");
    const tampered = {
      ...pkg,
      identity: { ...pkg.identity, campaignId: 28 },
    } as PublishPackage;

    const db = createMockDb({
      queueItem: queueItemFor("facebook"),
      contentPost: governedContentPost(),
      integration: facebookIntegration,
      campaign: readyCampaignWithApprovedLineage,
      business: readyBusiness,
      approvals: [approvedLaunchApproval],
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    const result = await publishSinglePost(1, { publishPackage: tampered, adapterRegistry: registry });

    expect(result.status).toBe("precondition_failed");
    expect(result.error).toContain("fingerprint mismatch");
    expect(fake.publish).not.toHaveBeenCalled();
    expect(publishToFacebook).not.toHaveBeenCalled();
  });
});
