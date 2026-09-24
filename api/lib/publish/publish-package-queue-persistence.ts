// ─── DB-backed durable PublishPackage queue loading (WBS13.4) ───
//
// The execution-side counterpart of publish-package-queue-store.ts. Where the
// store module is pure (serialize/resolve/verify), this module owns the two
// durable loading paths that cross a process boundary:
//
//   - BullMQ worker: loadQueuePublishPackagePlan(queueItemId) loads the queue
//     row and resolves its persisted package;
//   - cron/due-posts: resolveQueuePublishPackagePlan(row) resolves a row the
//     due-post selection already holds — same parsing, no duplicate logic.
//
// Both paths produce one shared execution plan:
//
//   - governed:   publishSinglePost(queueItemId, { publishPackage }) — the
//                 exact persisted package, never rebuilt from mutable rows;
//   - legacy:     publishSinglePost(queueItemId) — unchanged behavior;
//   - fail_closed: the row is governed-marked but its persisted package is
//                 missing or tampered. The row is durably marked failed (with
//                 one canonical publication_failure event, committed together)
//                 BEFORE any provider execution, and the caller surfaces it
//                 through its existing unrecoverable/precondition convention.
//
// Metadata ownership: the fail-closed mark only ever SETs status/retry
// counters/lastError — it never touches the metadata column, so the governed
// package keys remain as durable evidence of what was refused.

import { and, eq, or } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import { publishingQueue, type PublishingQueueItem } from "@db/schema";
import { createAuditEvent } from "../audit/audit-event";
import { persistAuditEvent } from "../audit/audit-store";
import { resolveQueuePublishPackage } from "./publish-package-queue-store";
import type { PublishPackage } from "./publish-package-contract";

export type QueuePublishPackageExecutionPlan =
  | { kind: "governed"; publishPackage: PublishPackage }
  | { kind: "legacy" }
  | { kind: "fail_closed"; reason: string };

async function planForRow(row: PublishingQueueItem): Promise<QueuePublishPackageExecutionPlan> {
  const resolution = resolveQueuePublishPackage(row.metadata);
  switch (resolution.kind) {
    case "governed":
      return { kind: "governed", publishPackage: resolution.publishPackage };
    case "legacy":
      return { kind: "legacy" };
    case "invalid": {
      await markQueueItemFailedForInvalidPackage(row, resolution.reason);
      return { kind: "fail_closed", reason: resolution.reason };
    }
  }
}

/**
 * Durable package execution plan for one queue item (BullMQ worker path).
 * The job payload stays identity-only; the exact package is reloaded here
 * from the durable queue row. A missing row resolves to legacy — the runner
 * owns not_found reporting and status gating.
 */
export async function loadQueuePublishPackagePlan(
  queueItemId: number
): Promise<QueuePublishPackageExecutionPlan> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(publishingQueue)
    .where(eq(publishingQueue.id, queueItemId))
    .limit(1);
  if (!row) return { kind: "legacy" };
  return planForRow(row);
}

/**
 * Durable package execution plan for a queue row the due-post selection
 * already holds (cron path). Identical resolution to the worker path — the
 * package parsing exists exactly once, in publish-package-queue-store.
 */
export async function resolveQueuePublishPackagePlan(
  row: PublishingQueueItem
): Promise<QueuePublishPackageExecutionPlan> {
  return planForRow(row);
}

/**
 * Idempotent, durable fail-closed state for a governed-marked queue item
 * whose persisted package is missing or tampered. Guarded to approved/
 * retrying rows so a second execution path (cron after worker, or a retry)
 * never writes a duplicate failure event. Commits the row failure and the
 * canonical publication_failure evidence in one transaction. Never modifies
 * the metadata column.
 */
export async function markQueueItemFailedForInvalidPackage(
  row: PublishingQueueItem,
  reason: string
): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    const updateResult = await tx
      .update(publishingQueue)
      .set({
        status: "failed",
        lastError: reason,
        retryCount: row.maxRetries || 3,
        nextRetryAt: null,
      })
      .where(
        and(
          eq(publishingQueue.id, row.id),
          or(eq(publishingQueue.status, "approved"), eq(publishingQueue.status, "retrying"))
        )
      );

    const affectedRows = (updateResult as any)?.[0]?.affectedRows ?? 0;
    if (affectedRows === 0) {
      // Already terminalised by another execution path; the durable state
      // (and its single failure event) stands.
      return;
    }

    await persistAuditEvent(
      createAuditEvent({
        eventType: "publication_failure",
        occurredAt: new Date().toISOString(),
        userId: row.userId,
        source: "workflow",
        outcome: "failed",
        campaignId: row.campaignId ?? null,
        businessId: null,
        contentId: row.contentPostId ?? null,
        workflowOperationId: null,
        workflowAttemptId: null,
        approvalRequestId: null,
        artifactId: null,
        packageId: null,
        metadata: {
          queueItemId: row.id,
          platform: row.platform,
          attemptOrdinal: (row.retryCount || 0) + 1,
          terminal: true,
          nextState: "failed",
          failureStage: "precondition",
          failClosedReason: "invalid_persisted_publish_package",
        },
      }),
      tx
    );
  });
}
