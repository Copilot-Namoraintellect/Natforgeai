import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.PUBLIC_APP_URL = "https://natforgeai.com";

import { buildGroundedCreativeBrief } from "../../creative/brief-grounding";
import {
  buildPublishPackage,
  type PublishPackage,
  type PublishPackageBuildInput,
} from "../../publish/publish-package-builder";
import { deriveCreativeArtifactLineageFingerprint } from "../../creative/artifact-lineage";
import { persistPublicationReceipt } from "../../publish/publication-receipt-store";
import { resolvePublicationSchedule } from "../../publish/publication-schedule";

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

vi.mock("../../agents/runner", () => ({
  runAgent: vi.fn(),
}));

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[
    Symbol.for("drizzle:Name") as symbol
  ] as string | undefined;
}

/** Collect every drizzle Param value inside a condition tree. */
function collectParams(condition: unknown): unknown[] {
  const seen = new Set<unknown>();
  const out: unknown[] = [];
  const walk = (value: unknown): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const record = value as Record<string, unknown>;
    if (record.constructor && (record.constructor as { name?: string }).name === "Param") {
      out.push(record.value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    for (const key of Object.keys(record)) walk(record[key]);
  };
  walk(condition);
  return out;
}

/**
 * Stateful fake for the WBS13 wiring proofs: queue row mutations are visible
 * to later reads, and audit_events support both the fingerprint lookup used
 * by persistAuditEvent and the eventType/userId scan used by the receipt
 * loader, so idempotency replay exercises the real durable store path.
 */
function createWiringDb({
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
  const state = {
    queue: queueItem ? { ...queueItem } : null,
    audits: [] as Record<string, unknown>[],
    updateCalls: [] as Array<{ table: string | undefined; set: Record<string, unknown> }>,
    insertCalls: [] as Array<{ table: string | undefined; values: Record<string, unknown> }>,
  };

  const rowsFor = (name: string | undefined, condition?: unknown): Record<string, unknown>[] => {
    if (name === "publishing_queue") return state.queue ? [{ ...state.queue }] : [];
    if (name === "content_posts") return contentPost ? [contentPost] : [];
    if (name === "social_integrations") return integration ? [integration] : [];
    if (name === "campaigns") return campaign ? [campaign] : [];
    if (name === "businesses") return business ? [business] : [];
    if (name === "approval_requests") return approvals;
    if (name === "audit_events") {
      const params = condition ? collectParams(condition) : [];
      const rows = state.audits.map((a) => ({ ...a }));
      // persistAuditEvent selects by event fingerprint.
      const fingerprintParam = params.find((p) => typeof p === "string" && p.length >= 32);
      if (fingerprintParam !== undefined) {
        return rows.filter((r) => r.eventFingerprint === fingerprintParam);
      }
      // The receipt loader selects publication_success rows and scans them.
      if (params.includes("publication_success")) {
        return rows.filter((r) => r.eventType === "publication_success");
      }
      return rows;
    }
    return [];
  };

  const db: any = {
    state,
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        const name = getTableName(table);
        const makeChain = (condition?: unknown): Record<string, unknown> => {
          const chain: Record<string, unknown> = {
            limit: vi.fn(async () => rowsFor(name, condition)),
            orderBy: vi.fn(() => chain),
            then: (resolve: (value: unknown[]) => unknown, reject?: (reason?: unknown) => unknown) =>
              Promise.resolve(rowsFor(name, condition)).then(resolve, reject as never),
            where: vi.fn((nextCondition: unknown) => makeChain(nextCondition)),
          };
          return chain;
        };
        return makeChain(undefined);
      }),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (values: Record<string, unknown>) => {
        const name = getTableName(table);
        state.insertCalls.push({ table: name, values });
        if (name === "audit_events") {
          state.audits.push({ id: state.audits.length + 1, ...values });
        }
        return [{ insertId: 1 }];
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((data: Record<string, unknown>) => ({
        where: vi.fn(async () => {
          const name = getTableName(table);
          state.updateCalls.push({ table: name, set: data });
          if (name === "publishing_queue" && state.queue) {
            Object.assign(state.queue, data);
          }
          return [{ affectedRows: 1 }];
        }),
      })),
    })),
    transaction: async (cb: any) => cb(db),
  };
  return db;
}

// ─── Fixtures ───

const GOVERNED_HOOK = "HOOK::wiring::";
const GOVERNED_CAPTION = "CAPTION::wiring body::";
const GOVERNED_CTA = "CTA::wiring call::";
const GOVERNED_TEXT = `${GOVERNED_HOOK}\n\n${GOVERNED_CAPTION}\n\n${GOVERNED_CTA}`;
const RELATIVE_IMAGE_URL = "/generated/images/27/wiring.png";

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

const readyBusiness = { id: 24, userId: 14, name: "Zuto Hub", industry: "fintech payouts" };

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

function wiringContentPost(overrides: Record<string, unknown> = {}) {
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

function buildGovernedPackage(
  platform: string,
  overrides: { intent?: { mode: "immediate" } | { mode: "scheduled"; scheduledAtIso: string }; integrationId?: number | null } = {}
): PublishPackage {
  return buildPublishPackage({
    campaignId: 27,
    userId: 14,
    businessId: 24,
    destination: { platform, integrationId: overrides.integrationId ?? 9 },
    intent: overrides.intent ?? { mode: "immediate" },
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

function readyDb(queueOverrides: Record<string, unknown> = {}) {
  return createWiringDb({
    queueItem: queueItemFor("facebook", queueOverrides),
    contentPost: wiringContentPost(),
    integration: facebookIntegration,
    campaign: readyCampaignWithApprovedLineage,
    business: readyBusiness,
    approvals: [approvedLaunchApproval],
  });
}

function successReceiptsOf(db: any) {
  return db.state.audits.filter((a: any) => a.eventType === "publication_success");
}

describe("WBS13 final wiring — canonical receipt + idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("first valid governed execution calls the provider exactly once and persists one canonical receipt", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { publishToFacebook } = await import("../../integrations/platforms");
    const { publishSinglePost } = await import("../publishing-runner");
    const pkg = buildGovernedPackage("facebook");
    const db = readyDb();
    vi.mocked(getDb).mockReturnValue(db as any);

    vi.mocked(publishToFacebook).mockResolvedValue({
      success: true,
      postId: "fb_wired_1",
      url: "https://facebook.com/fb_wired_1",
    });

    // No registry injection: the default governed registry resolves the real
    // Facebook adapter, which delegates to the existing provider function.
    const result = await publishSinglePost(1, { publishPackage: pkg });

    expect(result.status).toBe("published");
    expect(publishToFacebook).toHaveBeenCalledTimes(1);

    // Exactly one durable success evidence: the canonical receipt.
    const successes = successReceiptsOf(db);
    expect(successes).toHaveLength(1);
    const receipt = (successes[0].metadata as any).publicationReceipt;
    expect(receipt.operationId).toBe("publication:facebook:1");
    expect(receipt.queueItemId).toBe(1);
    expect(receipt.platform).toBe("facebook");
    expect(receipt.externalPostId).toBe("fb_wired_1");
    expect(receipt.externalUrl).toBe("https://facebook.com/fb_wired_1");
    expect(receipt.classification).toBe("governed");
    expect(receipt.publishPackageId).toBe(pkg.packageId);
    expect(receipt.packageFingerprintSha256).toBe(pkg.packageFingerprintSha256);
    expect(receipt.publishedAtIso).toBe(successes[0].occurredAt);

    // Queue success state and receipt agree on the one shared success clock.
    expect(db.state.queue.status).toBe("published");
    expect((db.state.queue.publishedAt as Date).toISOString()).toBe(receipt.publishedAtIso);
    expect(db.state.queue.externalPostId).toBe(receipt.externalPostId);

    // Governed correlation lands in the first-class audit packageId column.
    expect(successes[0].packageId).toBe(pkg.packageId);

    // Receipt carries no secrets or raw provider payload.
    const serialized = JSON.stringify(successes[0]);
    expect(serialized).not.toContain("decrypted:");
    expect(serialized).not.toMatch(/user-token-encrypted|page-token-encrypted/i);
  });

  it("same queue retry after success replays the stored success with zero additional provider calls", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { publishToFacebook } = await import("../../integrations/platforms");
    const { publishSinglePost } = await import("../publishing-runner");
    const pkg = buildGovernedPackage("facebook");
    const db = readyDb({ status: "published", publishedAt: new Date("2026-09-01T10:00:00.000Z"), externalPostId: "fb_prev" });
    vi.mocked(getDb).mockReturnValue(db as any);

    // Durable canonical receipt for the earlier success.
    await persistPublicationReceipt({
      receipt: {
        schemaVersion: 1,
        operationId: "publication:facebook:1",
        queueItemId: 1,
        platform: "facebook",
        status: "published",
        externalPostId: "fb_prev",
        externalUrl: null,
        publishedAtIso: "2026-09-01T10:00:00.000Z",
        classification: "governed",
        publishPackageId: pkg.packageId,
        packageFingerprintSha256: pkg.packageFingerprintSha256,
        receivedAtIso: null,
      },
      userId: 14,
      campaignId: 27,
      executor: db,
    });
    vi.mocked(publishToFacebook).mockResolvedValue({ success: true, postId: "fb_should_not_exist" });

    const result = await publishSinglePost(1, { publishPackage: pkg });

    expect(result.status).toBe("published");
    expect(result.postId).toBe("fb_prev");
    expect(result.publishPackageId).toBe(pkg.packageId);
    // Replay: the provider is never consulted again.
    expect(publishToFacebook).not.toHaveBeenCalled();
    // No duplicate success evidence.
    expect(successReceiptsOf(db)).toHaveLength(1);
  });

  it("a prior successful receipt belonging to a different package is never borrowed", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { publishToFacebook } = await import("../../integrations/platforms");
    const { publishSinglePost } = await import("../publishing-runner");
    const originalPkg = buildGovernedPackage("facebook");
    // A genuinely different package (different pinned destination → different
    // package id and fingerprint) bound to the same queue item.
    const otherPkg = buildGovernedPackage("facebook", { integrationId: 10 });
    const db = readyDb({ status: "published", publishedAt: new Date("2026-09-01T10:00:00.000Z"), externalPostId: "fb_prev" });
    vi.mocked(getDb).mockReturnValue(db as any);

    await persistPublicationReceipt({
      receipt: {
        schemaVersion: 1,
        operationId: "publication:facebook:1",
        queueItemId: 1,
        platform: "facebook",
        status: "published",
        externalPostId: "fb_prev",
        externalUrl: null,
        publishedAtIso: "2026-09-01T10:00:00.000Z",
        classification: "governed",
        publishPackageId: originalPkg.packageId,
        packageFingerprintSha256: originalPkg.packageFingerprintSha256,
        receivedAtIso: null,
      },
      userId: 14,
      campaignId: 27,
      executor: db,
    });
    vi.mocked(publishToFacebook).mockResolvedValue({ success: true, postId: "fb_new" });

    // A different package bound to the same queue item: terminal, no provider.
    const result = await publishSinglePost(1, { publishPackage: otherPkg });

    expect(result.status).toBe("precondition_failed");
    expect(result.error).toMatch(/does not match the package recorded by the durable/);
    expect(publishToFacebook).not.toHaveBeenCalled();
    expect(successReceiptsOf(db)).toHaveLength(1);
    // Durable success state is untouched.
    expect(db.state.queue.externalPostId).toBe("fb_prev");
  });

  it("a different queue item is a different operation and may publish", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { publishToFacebook } = await import("../../integrations/platforms");
    const { publishSinglePost } = await import("../publishing-runner");
    const db = readyDb();
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(publishToFacebook).mockResolvedValue({ success: true, postId: "fb_item2" });

    const result = await publishSinglePost(1);

    expect(result.status).toBe("published");
    expect(result.postId).toBe("fb_item2");
    expect(publishToFacebook).toHaveBeenCalledTimes(1);
    const receipt = (successReceiptsOf(db)[0].metadata as any).publicationReceipt;
    expect(receipt.operationId).toBe("publication:facebook:1");
    expect(receipt.classification).toBe("legacy");
    expect(receipt.publishPackageId).toBeNull();
    expect(receipt.packageFingerprintSha256).toBeNull();
  });
});

describe("WBS13 final wiring — schedule authority ↔ package intent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("governed scheduled publication executes when the package intent matches the persisted canonical instant", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { publishToFacebook } = await import("../../integrations/platforms");
    const { publishSinglePost } = await import("../publishing-runner");
    const scheduledAtUtc = "2026-12-01T08:00:00.000Z";
    const schedule = resolvePublicationSchedule(
      { mode: "scheduled", scheduledAtUtc },
      { now: new Date("2026-11-01T00:00:00.000Z") }
    );
    const pkg = buildGovernedPackage("facebook", {
      intent: { mode: "scheduled", scheduledAtIso: schedule.scheduledAtUtcIso! },
    });
    const db = readyDb({ scheduledAt: new Date(schedule.scheduledAtUtcMillis!) });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(publishToFacebook).mockResolvedValue({ success: true, postId: "fb_sched" });

    const result = await publishSinglePost(1, { publishPackage: pkg });

    expect(result.status).toBe("published");
    expect(publishToFacebook).toHaveBeenCalledTimes(1);
  });

  it("governed package whose schedule intent diverges from the queue row fails closed before the provider", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { publishToFacebook } = await import("../../integrations/platforms");
    const { publishSinglePost } = await import("../publishing-runner");
    const pkg = buildGovernedPackage("facebook", {
      intent: { mode: "scheduled", scheduledAtIso: "2026-12-01T09:00:00.000Z" },
    });
    const db = readyDb({ scheduledAt: new Date("2026-12-01T08:00:00.000Z") });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(publishToFacebook).mockResolvedValue({ success: true, postId: "fb_nope" });

    const result = await publishSinglePost(1, { publishPackage: pkg });

    expect(result.status).toBe("precondition_failed");
    expect(result.error).toMatch(/does not match package intent scheduledAtIso/);
    expect(publishToFacebook).not.toHaveBeenCalled();
    expect(db.state.queue.status).toBe("failed");
  });

  it("immediate package intent against a scheduled queue row fails closed before the provider", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { publishToFacebook } = await import("../../integrations/platforms");
    const { publishSinglePost } = await import("../publishing-runner");
    const pkg = buildGovernedPackage("facebook", { intent: { mode: "immediate" } });
    const db = readyDb({ scheduledAt: new Date("2026-12-01T08:00:00.000Z") });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(publishToFacebook).mockResolvedValue({ success: true, postId: "fb_nope" });

    const result = await publishSinglePost(1, { publishPackage: pkg });

    expect(result.status).toBe("precondition_failed");
    expect(publishToFacebook).not.toHaveBeenCalled();
  });
});

describe("WBS13 final wiring — recovery policy queue application", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("missing encrypted credential material fails closed before the provider", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { publishToFacebook } = await import("../../integrations/platforms");
    const { publishSinglePost } = await import("../publishing-runner");
    const db = createWiringDb({
      queueItem: queueItemFor("facebook"),
      contentPost: wiringContentPost(),
      integration: { ...facebookIntegration, accessTokenEncrypted: null, pageAccessTokenEncrypted: null },
      campaign: readyCampaignWithApprovedLineage,
      business: readyBusiness,
      approvals: [approvedLaunchApproval],
    });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(publishToFacebook).mockResolvedValue({ success: true, postId: "fb_nope" });

    const result = await publishSinglePost(1);

    expect(result.status).toBe("precondition_failed");
    expect(result.unrecoverable).toBe(true);
    expect(result.error).toMatch(/access token is missing/);
    expect(publishToFacebook).not.toHaveBeenCalled();
    expect(db.state.queue.status).toBe("failed");
  });

  it("provider payload rejection is terminal with no blind retry", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { publishToFacebook } = await import("../../integrations/platforms");
    const { publishSinglePost } = await import("../publishing-runner");
    const db = readyDb();
    vi.mocked(getDb).mockReturnValue(db as any);
    // Normalized adapter category: validation → provider_rejection → terminal.
    vi.mocked(publishToFacebook).mockResolvedValue({
      success: false,
      error: "Invalid parameter: missing media url",
    });

    const result = await publishSinglePost(1);

    expect(result.status).toBe("failed");
    expect(result.unrecoverable).toBe(true);
    // Fail-fast rejection never consumes retry budget.
    expect(db.state.queue.retryCount).toBe(0);
    expect(db.state.queue.nextRetryAt).toBeNull();
    const failure = db.state.audits.find((a: any) => a.eventType === "publication_failure");
    expect((failure.metadata as any).recoveryClass).toBe("provider_rejection");
    expect((failure.metadata as any).action).toBe("fail_terminal");
  });

  it("network failure schedules the canonical 1-minute retry on the queue row", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { publishToFacebook } = await import("../../integrations/platforms");
    const { publishSinglePost } = await import("../publishing-runner");
    const db = readyDb();
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(publishToFacebook).mockResolvedValue({ success: false, error: "fetch failed" });

    const before = Date.now();
    const result = await publishSinglePost(1);

    expect(result.status).toBe("retrying");
    expect(result.unrecoverable).toBe(false);
    expect(db.state.queue.status).toBe("retrying");
    expect(db.state.queue.retryCount).toBe(1);
    const nextRetryAt = db.state.queue.nextRetryAt as Date;
    expect(nextRetryAt.getTime() - before).toBeGreaterThanOrEqual(60_000);
    expect(nextRetryAt.getTime() - before).toBeLessThan(61_000);
  });

  it("exhaustion escalates exactly once and lands terminal with a null nextRetryAt", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { publishToFacebook } = await import("../../integrations/platforms");
    const { createAlert } = await import("../../alerts");
    const { publishSinglePost } = await import("../publishing-runner");
    const db = readyDb({ retryCount: 1 });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(publishToFacebook).mockRejectedValue(new Error("socket hang up"));

    const first = await publishSinglePost(1);
    expect(first.status).toBe("retrying");

    db.state.queue.retryCount = 2;
    db.state.queue.status = "retrying";
    const second = await publishSinglePost(1);
    expect(second.status).toBe("failed");
    expect(second.unrecoverable).toBe(true);
    expect(db.state.queue.status).toBe("failed");
    expect(db.state.queue.retryCount).toBe(3);
    expect(db.state.queue.nextRetryAt).toBeNull();
    expect(createAlert).toHaveBeenCalledTimes(1);
  });
});

describe("WBS13 final wiring — cron due posts share the canonical runner semantics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("a governed due post that already succeeded replays without any provider call", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { publishToFacebook } = await import("../../integrations/platforms");
    const { publishDuePosts } = await import("../publishing-runner");
    const { serializePublishPackageForQueue } = await import("../../publish/publish-package-queue-store");
    const pkg = buildGovernedPackage("facebook");
    const db = readyDb({
      status: "published",
      publishedAt: new Date("2026-09-01T10:00:00.000Z"),
      externalPostId: "fb_cron_prev",
      metadata: JSON.parse(JSON.stringify(serializePublishPackageForQueue(pkg))),
    });
    vi.mocked(getDb).mockReturnValue(db as any);

    await persistPublicationReceipt({
      receipt: {
        schemaVersion: 1,
        operationId: "publication:facebook:1",
        queueItemId: 1,
        platform: "facebook",
        status: "published",
        externalPostId: "fb_cron_prev",
        externalUrl: null,
        publishedAtIso: "2026-09-01T10:00:00.000Z",
        classification: "governed",
        publishPackageId: pkg.packageId,
        packageFingerprintSha256: pkg.packageFingerprintSha256,
        receivedAtIso: null,
      },
      userId: 14,
      campaignId: 27,
      executor: db,
    });
    vi.mocked(publishToFacebook).mockResolvedValue({ success: true, postId: "fb_cron_new" });

    const results = await publishDuePosts();

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("published");
    expect(results[0].postId).toBe("fb_cron_prev");
    expect(publishToFacebook).not.toHaveBeenCalled();
    expect(successReceiptsOf(db)).toHaveLength(1);
  });
});

describe("WBS13 final wiring — legacy scheduling entry points use the schedule authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("distribution-agent persists the canonical UTC instant for an explicit-offset declared schedule", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { runAgent } = await import("../../agents/runner");
    const { runDistributionAgent } = await import("../../agents/distribution-agent");

    const db = createWiringDb({
      campaign: { id: 27, userId: 14, name: "C", goal: "G", platforms: "facebook" },
      contentPost: { id: 117, userId: 14, campaignId: 27, title: "Post", platform: "facebook", type: "social_post", hook: "h", caption: "c", cta: "c" },
    });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runAgent).mockResolvedValue({
      runId: 5,
      output: {
        schedule: [
          {
            contentPostId: 117,
            platform: "facebook",
            scheduledAt: "2026-12-01T10:00:00+02:00",
          },
        ],
      },
    } as any);

    const result = await runDistributionAgent({ userId: 14, campaignId: 27, approvalMode: "autonomous" });

    expect(result.queueIds).toEqual([1]);
    const inserted = db.state.insertCalls.find(
      (c: { table: string | undefined }) => c.table === "publishing_queue"
    );
    expect(inserted).toBeDefined();
    // +02:00 wall time resolves to the canonical 08:00:00Z instant.
    expect((inserted!.values.scheduledAt as Date).toISOString()).toBe("2026-12-01T08:00:00.000Z");
  });

  it("distribution-agent fails closed on an offset-less declared schedule (no server-local parsing)", async () => {
    const { getDb } = await import("../../../queries/connection");
    const { runAgent } = await import("../../agents/runner");
    const { runDistributionAgent } = await import("../../agents/distribution-agent");

    const db = createWiringDb({
      campaign: { id: 27, userId: 14, name: "C", goal: "G", platforms: "facebook" },
      contentPost: { id: 117, userId: 14, campaignId: 27, title: "Post", platform: "facebook", type: "social_post", hook: "h", caption: "c", cta: "c" },
    });
    vi.mocked(getDb).mockReturnValue(db as any);
    vi.mocked(runAgent).mockResolvedValue({
      runId: 5,
      output: {
        schedule: [
          {
            contentPostId: 117,
            platform: "facebook",
            scheduledAt: "2026-12-01T10:00:00",
          },
        ],
      },
    } as any);

    await expect(
      runDistributionAgent({ userId: 14, campaignId: 27, approvalMode: "autonomous" })
    ).rejects.toThrow(/explicit Z or ±hh:mm offset/);
    expect(
      db.state.insertCalls.find(
        (c: { table: string | undefined }) => c.table === "publishing_queue"
      )
    ).toBeUndefined();
  });
});
