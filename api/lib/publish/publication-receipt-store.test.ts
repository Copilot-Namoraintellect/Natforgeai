import { describe, it, expect, vi } from "vitest";

// The receipt store must never touch a real database in tests.
vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb must not be called in receipt-store tests; supply a fake executor");
  }),
}));

import type { AuditEventRow, InsertAuditEventRow } from "@db/schema";
import { buildPublishPackage } from "./publish-package-builder";
import { deriveCreativeArtifactLineageFingerprint } from "../creative/artifact-lineage";
import { buildPublicationReceipt } from "./publication-receipt";
import { buildPublicationReceiptAuditEvent } from "./publication-receipt-audit";
import {
  loadPublicationReceiptForQueueItem,
  persistPublicationReceipt,
} from "./publication-receipt-store";
import { buildAuditEventFingerprint } from "../audit/audit-event";
import type { AuditDbExecutor } from "../audit/audit-store";

const PUBLISHED_AT = "2026-07-01T12:00:00.000Z";
const CREATED_AT = "2026-07-01T12:00:01.000Z";

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

function buildGovernedPackage() {
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
    payload: { text: "Hook\n\nCaption\n\nCTA" },
  } as never);
}

function makeReceipt() {
  return buildPublicationReceipt({
    normalized: {
      operationId: "publication:instagram:42",
      platform: "instagram",
      status: "published",
      externalPostId: "179424343423232",
      externalUrl: "https://www.instagram.com/p/ABC123/",
    },
    queueItemId: 42,
    platform: "instagram",
    publishedAtIso: PUBLISHED_AT,
  });
}

interface FakeState {
  rows: AuditEventRow[];
  insertedRows: InsertAuditEventRow[];
  nextId: number;
}

function rowFromInsert(row: InsertAuditEventRow, id: number): AuditEventRow {
  return {
    id,
    createdAt: new Date(CREATED_AT),
    ...(row as Record<string, unknown>),
  } as AuditEventRow;
}

function makeFakeExecutor(seedRows: AuditEventRow[] = []) {
  const state: FakeState = {
    rows: seedRows.map((r) => ({ ...r })),
    insertedRows: [],
    nextId: 9000,
  };
  const executor = {
    select: (_fields?: unknown) => ({
      from: (_table: unknown) => ({
        where: (_condition: unknown) => ({
          orderBy: (_column: unknown) => ({
            limit: async (n: number): Promise<AuditEventRow[]> =>
              state.rows.slice(0, n).map((r) => ({ ...r, metadata: r.metadata })),
          }),
          limit: async (n: number): Promise<AuditEventRow[]> =>
            state.rows.slice(0, n).map((r) => ({ ...r, metadata: r.metadata })),
        }),
      }),
    }),
    insert: (_table: unknown) => ({
      values: async (row: InsertAuditEventRow): Promise<unknown> => {
        state.insertedRows.push({ ...row });
        if (state.rows.some((r) => r.eventFingerprint === row.eventFingerprint)) {
          const err = new Error("Duplicate entry for key 'ae_fingerprint_idx'") as Error & {
            code: string;
            errno: number;
          };
          err.code = "ER_DUP_ENTRY";
          err.errno = 1062;
          throw err;
        }
        state.rows.push(rowFromInsert(row, state.nextId++));
        return [{ insertId: state.nextId, affectedRows: 1 }];
      },
    }),
  };
  return { executor: executor as unknown as AuditDbExecutor, state };
}

function seedRowFromReceipt(receipt = makeReceipt(), userId = 9): AuditEventRow {
  const event = buildPublicationReceiptAuditEvent({
    receipt,
    userId,
    campaignId: 7,
    businessId: null,
    contentId: 125,
  });
  const fingerprint = buildAuditEventFingerprint(event);
  return rowFromInsert(
    {
      eventFingerprint: fingerprint,
      schemaVersion: event.schemaVersion,
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      userId: event.userId,
      campaignId: event.campaignId,
      businessId: event.businessId,
      workflowOperationId: event.workflowOperationId,
      workflowAttemptId: event.workflowAttemptId,
      approvalRequestId: event.approvalRequestId,
      artifactId: null,
      packageId: event.packageId === null ? null : String(event.packageId),
      contentId: event.contentId === null ? null : String(event.contentId),
      source: event.source,
      outcome: event.outcome,
      metadata: event.metadata as InsertAuditEventRow["metadata"],
    },
    1234
  );
}

describe("persistPublicationReceipt", () => {
  it("persists the canonical publication_success audit event with receipt metadata", async () => {
    const { executor, state } = makeFakeExecutor();
    const receipt = makeReceipt();

    const result = await persistPublicationReceipt({
      receipt,
      userId: 9,
      campaignId: 7,
      businessId: null,
      contentId: 125,
      executor,
    });

    expect(result.inserted).toBe(true);
    expect(result.duplicateClassification).toBe("none");
    expect(state.insertedRows).toHaveLength(1);

    const row = state.insertedRows[0];
    expect(row.eventType).toBe("publication_success");
    expect(row.outcome).toBe("succeeded");
    // The shared publication-success clock is the receipt's own timestamp.
    expect(row.occurredAt).toBe(PUBLISHED_AT);
    expect(row.packageId).toBe(receipt.publishPackageId);
    const metadata = row.metadata as Record<string, unknown>;
    const embedded = metadata.publicationReceipt as Record<string, unknown>;
    expect(embedded.operationId).toBe("publication:instagram:42");
    expect(embedded.externalPostId).toBe("179424343423232");
    expect(embedded.status).toBe("published");
    expect(embedded.publishPackageId).toBe(receipt.publishPackageId);
  });

  it("persists a governed receipt with package id and fingerprint correlation", async () => {
    const { executor, state } = makeFakeExecutor();
    const pkg = buildGovernedPackage();
    const receipt = buildPublicationReceipt({
      normalized: {
        operationId: "publication:instagram:42",
        platform: "instagram",
        status: "published",
        externalPostId: "179424343423232",
        externalUrl: "https://www.instagram.com/p/ABC123/",
      },
      queueItemId: 42,
      platform: "instagram",
      publishedAtIso: PUBLISHED_AT,
      publishPackage: pkg,
    });

    await persistPublicationReceipt({ receipt, userId: 9, campaignId: 7, executor });

    const row = state.insertedRows[0];
    // Governed correlation lands in the first-class audit packageId column.
    expect(row.packageId).toBe(pkg.packageId);
    const embedded = (row.metadata as Record<string, unknown>)
      .publicationReceipt as Record<string, unknown>;
    expect(embedded.classification).toBe("governed");
    expect(embedded.publishPackageId).toBe(pkg.packageId);
    expect(embedded.packageFingerprintSha256).toBe(pkg.packageFingerprintSha256);
  });

  it("persists legacy receipts with a null packageId column and no fabricated package", async () => {
    const { executor, state } = makeFakeExecutor();
    await persistPublicationReceipt({
      receipt: makeReceipt(),
      userId: 9,
      executor,
    });
    expect(state.insertedRows[0].packageId).toBeNull();
    const embedded = (state.insertedRows[0].metadata as Record<string, unknown>)
      .publicationReceipt as Record<string, unknown>;
    expect(embedded.classification).toBe("legacy");
    expect(embedded.publishPackageId).toBeNull();
    expect(embedded.packageFingerprintSha256).toBeNull();
  });

  it("is replay-safe: an identical receipt reuses the durable row", async () => {
    const { executor } = makeFakeExecutor();
    const receipt = makeReceipt();
    const first = await persistPublicationReceipt({ receipt, userId: 9, executor });
    expect(first.inserted).toBe(true);

    const second = await persistPublicationReceipt({ receipt, userId: 9, executor });
    expect(second.inserted).toBe(false);
    expect(second.duplicateClassification).toBe("idempotent_replay");
    expect(second.row.id).toBe(first.row.id);
  });

  it("persists no secrets: sensitive metadata keys are stripped by the audit contract", async () => {
    const { executor, state } = makeFakeExecutor();
    await persistPublicationReceipt({ receipt: makeReceipt(), userId: 9, executor });
    const metadata = JSON.stringify(state.insertedRows[0].metadata);
    expect(metadata).not.toMatch(/token|secret|password|authorization|credential|cookie|session/i);
  });
});

describe("loadPublicationReceiptForQueueItem", () => {
  it("round-trips the persisted receipt with external post id and status intact", async () => {
    const { executor } = makeFakeExecutor();
    const receipt = makeReceipt();
    await persistPublicationReceipt({ receipt, userId: 9, campaignId: 7, executor });

    const loaded = await loadPublicationReceiptForQueueItem({
      queueItemId: 42,
      userId: 9,
      executor,
    });
    expect(loaded).toEqual(receipt);
    expect(loaded?.externalPostId).toBe("179424343423232");
    expect(loaded?.status).toBe("published");
  });

  it("returns the receipt for the requested queue item only", async () => {
    const foreign = buildPublicationReceipt({
      normalized: {
        operationId: "publication:instagram:77",
        platform: "instagram",
        status: "published",
        externalPostId: "xyz",
      },
      queueItemId: 77,
      platform: "instagram",
      publishedAtIso: PUBLISHED_AT,
    });
    const { executor } = makeFakeExecutor([seedRowFromReceipt(foreign, 9)]);

    const loaded = await loadPublicationReceiptForQueueItem({
      queueItemId: 42,
      userId: 9,
      executor,
    });
    expect(loaded).toBeNull();
  });

  it("returns null when no success event carries a canonical receipt", async () => {
    const { executor } = makeFakeExecutor();
    expect(
      await loadPublicationReceiptForQueueItem({ queueItemId: 42, userId: 9, executor })
    ).toBeNull();
  });

  it("throws on a present-but-malformed stored receipt instead of guessing", async () => {
    const corrupted = seedRowFromReceipt();
    // Audit metadata is deep-frozen by the audit contract; replace the
    // metadata property with a tampered copy of the stored shape.
    corrupted.metadata = {
      ...((corrupted.metadata as Record<string, unknown>) ?? {}),
      publicationReceipt: { operationId: "tampered" },
    } as AuditEventRow["metadata"];
    const { executor } = makeFakeExecutor([corrupted]);

    await expect(
      loadPublicationReceiptForQueueItem({ queueItemId: 42, userId: 9, executor })
    ).rejects.toThrow(/publication receipt/i);
  });

  it("requires a positive queueItemId, userId, and an executor", async () => {
    const { executor } = makeFakeExecutor();
    await expect(
      loadPublicationReceiptForQueueItem({ queueItemId: 0, userId: 9, executor })
    ).rejects.toThrow(/queueItemId/);
    await expect(
      loadPublicationReceiptForQueueItem({ queueItemId: 42, userId: 0, executor })
    ).rejects.toThrow(/userId/);
    await expect(
      // @ts-expect-error intentionally missing executor
      loadPublicationReceiptForQueueItem({ queueItemId: 42, userId: 9 })
    ).rejects.toThrow(/executor/);
  });
});
