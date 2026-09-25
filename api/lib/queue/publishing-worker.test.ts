import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../workflow/publishing-runner", () => ({
  publishSinglePost: vi.fn(),
}));

vi.mock("../../alerts", () => ({
  createAlert: vi.fn(async () => {}),
}));

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("./bullmq", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bullmq")>();
  return {
    ...actual,
    closePublishingQueue: vi.fn(async () => {}),
    closeContentGenerationQueue: vi.fn(async () => {}),
    closeBullMqConnection: vi.fn(async () => {}),
  };
});

import { UnrecoverableError } from "bullmq";
import {
  closeBullMqConnection,
  closeContentGenerationQueue,
  closePublishingQueue,
} from "./bullmq";
import { processPublishingJob, stopPublishingWorker } from "./publishing-worker";
import { buildPublishPackage, type PublishPackageBuildInput } from "../publish/publish-package-builder";
import { deriveCreativeArtifactLineageFingerprint } from "../creative/artifact-lineage";
import {
  QUEUE_PUBLISH_PACKAGE_METADATA_KEY,
  QUEUE_PUBLISH_PACKAGE_REQUIRED_METADATA_KEY,
  serializePublishPackageForQueue,
} from "../publish/publish-package-queue-store";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

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

function buildPersistedGovernedRow() {
  const pkg = buildPublishPackage({
    campaignId: 7,
    userId: 18,
    businessId: 4,
    destination: { platform: "instagram", integrationId: 7 },
    intent: { mode: "immediate" },
    strategyAuthority: STRATEGY,
    approvedCopy: APPROVED_COPY,
    selectedContent: {
      contentPostId: 125,
      artifactKind: "content_post",
      lineage: {
        lineageSchemaVersion: 1,
        artifactKind: "content_post",
        artifactId: 125,
        lineageFingerprintSha256: HASH_D,
        strategy: STRATEGY,
        approvedCopy: APPROVED_COPY,
      },
    },
    captionArtifact: {
      artifactId: 501,
      artifactKind: "caption_pack",
      lineage: {
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
      },
    },
    evidence: { launchApprovalRequestId: 1 },
    payload: { text: "Hook\n\nCaption\n\nCTA", mediaUrls: [], mediaType: null },
  } as PublishPackageBuildInput);
  const metadata = JSON.parse(JSON.stringify(serializePublishPackageForQueue(pkg)));
  const row = {
    id: 1,
    userId: 18,
    campaignId: 7,
    contentPostId: 125,
    platform: "instagram",
    status: "approved",
    retryCount: 0,
    maxRetries: 3,
    metadata,
  };
  return { pkg, row };
}

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as
    | string
    | undefined;
}

function createQueueDb(queueItem: Record<string, unknown> | null) {
  const updateCalls: Array<{ table: string | undefined; set: Record<string, unknown> }> = [];
  const insertCalls: Array<{ table: string | undefined; values: Record<string, unknown> }> = [];
  const db: any = {
    updateCalls,
    insertCalls,
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        const name = getTableName(table);
        const rows = name === "publishing_queue" && queueItem ? [queueItem] : [];
        const chainable = {
          limit: vi.fn(async () => rows),
          then: (resolve: (value: unknown[]) => unknown, reject?: (reason?: unknown) => unknown) =>
            Promise.resolve(rows).then(resolve, reject),
        };
        return { where: vi.fn(() => chainable) };
      }),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (values: Record<string, unknown>) => {
        insertCalls.push({ table: getTableName(table), values });
        return [{ insertId: 1 }];
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

async function mockQueueRow(queueItem: Record<string, unknown> | null) {
  const { getDb } = await import("../../queries/connection");
  const db = createQueueDb(queueItem);
  vi.mocked(getDb).mockReturnValue(db);
  return db;
}

function makeJob(overrides: any = {}) {
  return {
    id: "job-1",
    data: {
      queueItemId: 1,
      userId: 18,
      platform: "Instagram",
      ...overrides,
    },
  } as any;
}

describe("publishing-worker permanent vs transient failures", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // The worker reloads durable queue state for every job; these tests
    // exercise result-status mapping on a legacy row (no persisted package).
    await mockQueueRow({
      id: 1,
      userId: 18,
      campaignId: 7,
      contentPostId: 125,
      platform: "Instagram",
      status: "approved",
      retryCount: 0,
      maxRetries: 3,
      metadata: null,
    });
  });

  it("calls publishSinglePost exactly once and throws UnrecoverableError for permanent readiness rejection", async () => {
    const { publishSinglePost } = await import("../workflow/publishing-runner");
    vi.mocked(publishSinglePost).mockResolvedValue({
      id: 1,
      status: "precondition_failed",
      platform: "Instagram",
      error: "Campaign launch approval is pending",
    });

    await expect(processPublishingJob(makeJob())).rejects.toBeInstanceOf(UnrecoverableError);
    expect(publishSinglePost).toHaveBeenCalledTimes(1);
    expect(publishSinglePost).toHaveBeenCalledWith(1);
  });

  it("throws a normal Error for transient publish failures so BullMQ can retry", async () => {
    const { publishSinglePost } = await import("../workflow/publishing-runner");
    vi.mocked(publishSinglePost).mockResolvedValue({
      id: 1,
      status: "failed",
      platform: "Instagram",
      error: "Network timeout",
    });

    await expect(processPublishingJob(makeJob())).rejects.toThrow("Network timeout");
    await expect(processPublishingJob(makeJob())).rejects.not.toBeInstanceOf(UnrecoverableError);
    expect(publishSinglePost).toHaveBeenCalledTimes(2); // one call per processPublishingJob invocation
  });

  it("throws a normal Error for safety-blocked content so BullMQ can retry", async () => {
    const { publishSinglePost } = await import("../workflow/publishing-runner");
    vi.mocked(publishSinglePost).mockResolvedValue({
      id: 1,
      status: "safety_blocked",
      platform: "Instagram",
      error: "Safety check blocked",
    });

    await expect(processPublishingJob(makeJob())).rejects.toThrow("Safety check blocked");
    await expect(processPublishingJob(makeJob())).rejects.not.toBeInstanceOf(UnrecoverableError);
  });

  it("maps a recovery-terminal result to UnrecoverableError so BullMQ never blind-retries it", async () => {
    const { publishSinglePost } = await import("../workflow/publishing-runner");
    vi.mocked(publishSinglePost).mockResolvedValue({
      id: 1,
      status: "failed",
      platform: "Instagram",
      error: "Publication credential failure: reconnect the integration to recover.",
      unrecoverable: true,
    });

    await expect(processPublishingJob(makeJob())).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it("keeps a policy-retryable retrying outcome as a completed job (no blind BullMQ retry)", async () => {
    const { publishSinglePost } = await import("../workflow/publishing-runner");
    vi.mocked(publishSinglePost).mockResolvedValue({
      id: 1,
      status: "retrying",
      platform: "Instagram",
    });

    await expect(processPublishingJob(makeJob())).resolves.toBeUndefined();
  });
});

describe("publishing worker durable publish-package reload (WBS13.4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reloads the persisted governed package from durable queue state and never rebuilds it", async () => {
    const { publishSinglePost } = await import("../workflow/publishing-runner");
    const { pkg, row } = buildPersistedGovernedRow();
    await mockQueueRow(row);
    vi.mocked(publishSinglePost).mockResolvedValue({
      id: 1,
      status: "published",
      platform: "instagram",
      postId: "ext-1",
      publishPackageId: pkg.packageId,
      packageFingerprintSha256: pkg.packageFingerprintSha256,
      publishPackageClassification: "governed",
    });

    await processPublishingJob(makeJob());

    // Identity-based job payload — the package never travels in BullMQ state.
    expect("publishPackage" in makeJob().data).toBe(false);
    expect(publishSinglePost).toHaveBeenCalledTimes(1);
    const passed = vi.mocked(publishSinglePost).mock.calls[0][1]?.publishPackage!;
    expect(passed).toBeDefined();
    expect(passed.packageId).toBe(pkg.packageId);
    expect(passed.packageFingerprintSha256).toBe(pkg.packageFingerprintSha256);
    expect(passed.payload).toEqual(pkg.payload);
    // The passed package IS the persisted one — byte-identical reload.
    expect(passed).toEqual(
      row.metadata[QUEUE_PUBLISH_PACKAGE_METADATA_KEY].publishPackage
    );
  });

  it("reloads the same package identity on retry (no rebuild against mutable state)", async () => {
    const { publishSinglePost } = await import("../workflow/publishing-runner");
    const { pkg, row } = buildPersistedGovernedRow();
    await mockQueueRow(row);
    vi.mocked(publishSinglePost).mockResolvedValue({
      id: 1,
      status: "failed",
      platform: "instagram",
      error: "provider timeout",
    });

    await expect(processPublishingJob(makeJob())).rejects.toThrow("provider timeout");
    await expect(processPublishingJob(makeJob())).rejects.toThrow("provider timeout");

    expect(publishSinglePost).toHaveBeenCalledTimes(2);
    const [first, retry] = vi.mocked(publishSinglePost).mock.calls;
    const firstPkg = first[1]?.publishPackage!;
    const retryPkg = retry[1]?.publishPackage!;
    expect(firstPkg.packageId).toBe(pkg.packageId);
    expect(retryPkg.packageId).toBe(pkg.packageId);
    expect(retryPkg.packageFingerprintSha256).toBe(firstPkg.packageFingerprintSha256);
    expect(retryPkg.payload).toEqual(firstPkg.payload);
  });

  it("keeps legacy rows (metadata null) on the established no-package call", async () => {
    const { publishSinglePost } = await import("../workflow/publishing-runner");
    const { row } = buildPersistedGovernedRow();
    await mockQueueRow({ ...row, metadata: null });
    vi.mocked(publishSinglePost).mockResolvedValue({
      id: 1,
      status: "published",
      platform: "instagram",
      postId: "ext-1",
    });

    await processPublishingJob(makeJob());

    expect(publishSinglePost).toHaveBeenCalledTimes(1);
    expect(publishSinglePost).toHaveBeenCalledWith(1);
  });

  it("fails closed before provider execution when the governed package is missing", async () => {
    const { publishSinglePost } = await import("../workflow/publishing-runner");
    const { row } = buildPersistedGovernedRow();
    const db = await mockQueueRow({
      ...row,
      metadata: { [QUEUE_PUBLISH_PACKAGE_REQUIRED_METADATA_KEY]: true },
    });

    await expect(processPublishingJob(makeJob())).rejects.toBeInstanceOf(UnrecoverableError);
    expect(publishSinglePost).not.toHaveBeenCalled();
    // Durable fail-closed evidence: row failed + one canonical failure event.
    const queueUpdates = db.updateCalls.filter(
      (c: { table: string | undefined; set: Record<string, unknown> }) =>
        c.table === "publishing_queue"
    );
    expect(
      queueUpdates.some((c: { set: Record<string, unknown> }) => c.set.status === "failed")
    ).toBe(true);
    for (const call of queueUpdates) {
      expect(call.set).not.toHaveProperty("metadata");
    }
    const auditInserts = db.insertCalls.filter(
      (c: { table: string | undefined; values: Record<string, unknown> }) =>
        c.table === "audit_events"
    );
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0].values.eventType).toBe("publication_failure");
  });

  it("fails closed before provider execution when the persisted package is tampered", async () => {
    const { publishSinglePost } = await import("../workflow/publishing-runner");
    const { row } = buildPersistedGovernedRow();
    const tampered = JSON.parse(JSON.stringify(row.metadata));
    tampered[QUEUE_PUBLISH_PACKAGE_METADATA_KEY].publishPackage.identity.campaignId = 999;
    await mockQueueRow({ ...row, metadata: tampered });

    await expect(processPublishingJob(makeJob())).rejects.toBeInstanceOf(UnrecoverableError);
    expect(publishSinglePost).not.toHaveBeenCalled();
  });
});

describe("publishing worker shutdown ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stop delegates only to the publishing close path", async () => {
    await stopPublishingWorker();

    expect(closePublishingQueue).toHaveBeenCalledTimes(1);
    expect(closeContentGenerationQueue).not.toHaveBeenCalled();
    expect(closeBullMqConnection).not.toHaveBeenCalled();
  });

  it("repeated stop calls resolve safely", async () => {
    await stopPublishingWorker();
    await stopPublishingWorker();

    expect(closePublishingQueue).toHaveBeenCalledTimes(2);
    expect(closeContentGenerationQueue).not.toHaveBeenCalled();
    expect(closeBullMqConnection).not.toHaveBeenCalled();
  });
});
