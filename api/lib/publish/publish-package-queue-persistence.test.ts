import { describe, it, expect, vi, beforeEach } from "vitest";
import { getTableColumns } from "drizzle-orm";

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

import { publishingQueue } from "@db/schema";
import { buildPublishPackage, type PublishPackageBuildInput } from "./publish-package-builder";
import { deriveCreativeArtifactLineageFingerprint } from "../creative/artifact-lineage";
import {
  QUEUE_PUBLISH_PACKAGE_METADATA_KEY,
  QUEUE_PUBLISH_PACKAGE_REQUIRED_METADATA_KEY,
  serializePublishPackageForQueue,
  loadPersistedPublishPackage,
} from "./publish-package-queue-store";
import {
  loadQueuePublishPackagePlan,
  resolveQueuePublishPackagePlan,
  markQueueItemFailedForInvalidPackage,
} from "./publish-package-queue-persistence";

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

function buildGovernedPackage(): ReturnType<typeof buildPublishPackage> {
  return buildPublishPackage({
    campaignId: 7,
    userId: 9,
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
    captionArtifact: { artifactId: 501, artifactKind: "caption_pack", lineage: captionLineage() },
    evidence: { launchApprovalRequestId: 1 },
    payload: { text: "Hook\n\nCaption\n\nCTA", mediaUrls: [], mediaType: null },
  } as PublishPackageBuildInput);
}

function queueItemRow(metadata: unknown) {
  return {
    id: 42,
    userId: 9,
    campaignId: 7,
    contentPostId: 125,
    platform: "instagram",
    status: "approved",
    approvalRequired: false,
    publishedAt: null,
    externalPostId: null,
    retryCount: 0,
    maxRetries: 3,
    nextRetryAt: null,
    lastError: null,
    safetyStatus: "low",
    safetyReasons: null,
    metadata,
    createdAt: new Date("2026-06-01T00:00:00Z"),
  } as any;
}

/** Simulate the database JSON storage round trip. */
function dbRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as
    | string
    | undefined;
}

function createMockDb({
  queueItem,
  affectedRows = 1,
}: {
  queueItem?: Record<string, unknown>;
  affectedRows?: number;
}) {
  const updateCalls: Array<{ table: string | undefined; set: Record<string, unknown> }> = [];
  const insertCalls: Array<{ table: string | undefined; values: Record<string, unknown> }> = [];
  let mutableAffectedRows = affectedRows;

  const rowsFor = (name: string | undefined): unknown[] => {
    if (name === "publishing_queue") return queueItem ? [queueItem] : [];
    return [];
  };

  const db: any = {
    updateCalls,
    insertCalls,
    setAffectedRows(value: number) {
      mutableAffectedRows = value;
    },
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        const name = getTableName(table);
        const chainable = {
          limit: vi.fn(async () => rowsFor(name)),
          orderBy: vi.fn(() => chainable),
          then: (resolve: (value: unknown[]) => unknown, reject?: (reason?: unknown) => unknown) =>
            Promise.resolve(rowsFor(name)).then(resolve, reject),
        };
        return {
          where: vi.fn(() => chainable),
          orderBy: vi.fn(() => chainable),
        };
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
          return [{ affectedRows: mutableAffectedRows }];
        }),
      })),
    })),
    transaction: async (cb: any) => cb(db),
  };
  return db;
}

async function getDbMock() {
  const { getDb } = await import("../../queries/connection");
  return vi.mocked(getDb);
}

describe("publishing_queue durable metadata schema (WBS13.4)", () => {
  it("exposes a nullable metadata JSON column on publishing_queue", () => {
    const columns = getTableColumns(publishingQueue);
    expect(columns).toHaveProperty("metadata");
    const metadata = columns.metadata as { columnType: string; notNull: boolean };
    expect(metadata.columnType).toBe("MySqlJson");
    expect(metadata.notNull).toBe(false);
    // Existing rows keep metadata NULL → they stay legacy rows.
  });
});

describe("loadQueuePublishPackagePlan — BullMQ worker loading path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reloads the exact persisted governed package from durable queue state", async () => {
    const pkg = buildGovernedPackage();
    const row = queueItemRow(dbRoundTrip(serializePublishPackageForQueue(pkg)));
    const db = createMockDb({ queueItem: row });
    (await getDbMock()).mockReturnValue(db);

    const plan = await loadQueuePublishPackagePlan(42);

    expect(plan.kind).toBe("governed");
    if (plan.kind !== "governed") return;
    expect(plan.publishPackage.packageId).toBe(pkg.packageId);
    expect(plan.publishPackage.packageFingerprintSha256).toBe(pkg.packageFingerprintSha256);
    expect(plan.publishPackage).toEqual(pkg);
    expect(Object.isFrozen(plan.publishPackage)).toBe(true);
    // Resolution is read-only: no queue writes of any kind.
    expect(db.updateCalls).toEqual([]);
    expect(db.insertCalls).toEqual([]);
  });

  it("reloads the same package identity, fingerprint, and payload on every retry", async () => {
    const pkg = buildGovernedPackage();
    const row = queueItemRow(dbRoundTrip(serializePublishPackageForQueue(pkg)));
    const db = createMockDb({ queueItem: row });
    (await getDbMock()).mockReturnValue(db);

    const first = await loadQueuePublishPackagePlan(42);
    const retry = await loadQueuePublishPackagePlan(42);

    expect(first.kind).toBe("governed");
    expect(retry.kind).toBe("governed");
    if (first.kind !== "governed" || retry.kind !== "governed") return;
    expect(retry.publishPackage.packageId).toBe(first.publishPackage.packageId);
    expect(retry.publishPackage.packageFingerprintSha256).toBe(
      first.publishPackage.packageFingerprintSha256
    );
    expect(retry.publishPackage.payload).toEqual(first.publishPackage.payload);
    // The package is loaded from persisted bytes only — nothing rebuilds it.
    expect(loadPersistedPublishPackage(row.metadata)).toEqual(pkg);
  });

  it("resolves legacy rows (metadata null) without fabricating a package", async () => {
    const db = createMockDb({ queueItem: queueItemRow(null) });
    (await getDbMock()).mockReturnValue(db);

    const plan = await loadQueuePublishPackagePlan(42);

    expect(plan).toEqual({ kind: "legacy" });
    expect(db.updateCalls).toEqual([]);
    expect(db.insertCalls).toEqual([]);
  });

  it("resolves a missing queue row to legacy and leaves reporting to the runner", async () => {
    const db = createMockDb({});
    (await getDbMock()).mockReturnValue(db);

    const plan = await loadQueuePublishPackagePlan(404);

    expect(plan).toEqual({ kind: "legacy" });
  });

  it("fails closed for a governed-marked row whose package is missing", async () => {
    const row = queueItemRow({ [QUEUE_PUBLISH_PACKAGE_REQUIRED_METADATA_KEY]: true });
    const db = createMockDb({ queueItem: row });
    (await getDbMock()).mockReturnValue(db);

    const plan = await loadQueuePublishPackagePlan(42);

    expect(plan.kind).toBe("fail_closed");
    if (plan.kind !== "fail_closed") return;
    expect(plan.reason).toMatch(/marked governed/i);
    // Durable fail-closed state: row marked failed with one canonical event,
    // and the metadata column is never touched.
    const queueUpdates = db.updateCalls.filter((c: { table: string | undefined; set: Record<string, unknown> }) => c.table === "publishing_queue");
    expect(queueUpdates).toHaveLength(1);
    expect(queueUpdates[0].set.status).toBe("failed");
    expect(queueUpdates[0].set).not.toHaveProperty("metadata");
    const auditInserts = db.insertCalls.filter((c: { table: string | undefined; set: Record<string, unknown> }) => c.table === "audit_events");
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0].values.eventType).toBe("publication_failure");
    expect(auditInserts[0].values.metadata).toMatchObject({
      terminal: true,
      nextState: "failed",
      failureStage: "precondition",
      failClosedReason: "invalid_persisted_publish_package",
    });
  });

  it("fails closed for a tampered persisted package before any execution", async () => {
    const pkg = buildGovernedPackage();
    const persisted: any = dbRoundTrip(serializePublishPackageForQueue(pkg));
    persisted[QUEUE_PUBLISH_PACKAGE_METADATA_KEY].publishPackage.payload.text = "tampered";
    const db = createMockDb({ queueItem: queueItemRow(persisted) });
    (await getDbMock()).mockReturnValue(db);

    const plan = await loadQueuePublishPackagePlan(42);

    expect(plan.kind).toBe("fail_closed");
    expect(
      db.updateCalls.filter(
        (c: { table: string | undefined }) => c.table === "publishing_queue"
      )
    ).toHaveLength(1);
  });
});

describe("resolveQueuePublishPackagePlan — cron loading path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the same loader as the worker for a row the due selection already holds", async () => {
    const pkg = buildGovernedPackage();
    const row = queueItemRow(dbRoundTrip(serializePublishPackageForQueue(pkg)));
    const db = createMockDb({ queueItem: row });
    (await getDbMock()).mockReturnValue(db);

    const plan = await resolveQueuePublishPackagePlan(row);

    expect(plan.kind).toBe("governed");
    if (plan.kind !== "governed") return;
    expect(plan.publishPackage.packageId).toBe(pkg.packageId);
    expect(db.updateCalls).toEqual([]);
  });

  it("keeps legacy due rows legacy", async () => {
    const row = queueItemRow(undefined);
    const db = createMockDb({ queueItem: row });
    (await getDbMock()).mockReturnValue(db);

    const plan = await resolveQueuePublishPackagePlan(row);

    expect(plan).toEqual({ kind: "legacy" });
    expect(db.updateCalls).toEqual([]);
  });
});

describe("markQueueItemFailedForInvalidPackage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("never writes the metadata column and is idempotent across execution paths", async () => {
    const row = queueItemRow({ [QUEUE_PUBLISH_PACKAGE_REQUIRED_METADATA_KEY]: true });
    const db = createMockDb({ queueItem: row, affectedRows: 1 });
    (await getDbMock()).mockReturnValue(db);

    await markQueueItemFailedForInvalidPackage(row, "governed package missing");
    // A second execution path (cron after worker, or a retry) finds the row
    // already terminal: guarded update affects 0 rows, no duplicate event.
    db.setAffectedRows(0);
    await markQueueItemFailedForInvalidPackage(row, "governed package missing");

    const queueUpdates = db.updateCalls.filter((c: { table: string | undefined; set: Record<string, unknown> }) => c.table === "publishing_queue");
    expect(queueUpdates).toHaveLength(2);
    for (const call of queueUpdates) {
      expect(Object.keys(call.set)).not.toContain("metadata");
    }
    const auditInserts = db.insertCalls.filter((c: { table: string | undefined; set: Record<string, unknown> }) => c.table === "audit_events");
    expect(auditInserts).toHaveLength(1);
  });
});
