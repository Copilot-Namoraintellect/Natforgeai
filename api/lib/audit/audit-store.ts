/**
 * Durable Audit Event Store.
 *
 * WBS7B scope:
 * - persist canonical WBS7A AuditEvent envelopes durably and replay-safely;
 * - eventFingerprint (buildAuditEventFingerprint) is the unique durable key:
 *   first persistence inserts exactly one row, exact replay reuses the
 *   existing row, and a unique-key collision whose stored material content
 *   does not match the supplied event fails closed;
 * - occurredAt and correlation identifiers are preserved exactly from the
 *   event; occurredAt is never replaced with current time;
 * - metadata is persisted as-is only after the canonical-envelope assertion
 *   proves it already satisfies WBS7A sanitation rules;
 * - optional caller-owned executor seam (e.g. a future material mutation's
 *   transaction) without transaction-lifecycle ownership;
 * - no runtime side effects other than the requested DB persistence; no
 *   PM2/log-based authority; no call-site instrumentation (that is WBS7C).
 */

import { eq } from "drizzle-orm";
import { auditEvents, type AuditEventRow, type InsertAuditEventRow } from "@db/schema";
import { getDb } from "../../queries/connection";
import {
  AuditEventError,
  buildAuditEventFingerprint,
  createAuditEvent,
  type AuditEvent,
} from "./audit-event";

type AuditDb = ReturnType<typeof getDb>;

/**
 * Structural executor seam. The default getDb() client and a Drizzle
 * transaction callback client both satisfy this shape. Supplied executors are
 * used as-is: this module never opens a transaction on a supplied executor
 * and owns no transaction lifecycle.
 */
export interface AuditDbExecutor {
  select: AuditDb["select"];
  insert: AuditDb["insert"];
}

function resolveAuditDb(executor?: AuditDbExecutor): AuditDbExecutor {
  return executor ?? getDb();
}

export type AuditDuplicateClassification = "none" | "idempotent_replay";

export interface PersistAuditEventResult {
  /** The canonical WBS7A envelope as accepted. */
  event: AuditEvent;
  /** The durable row: newly inserted, or the pre-existing row on replay. */
  row: AuditEventRow;
  /** True only when this call created the durable row. */
  inserted: boolean;
  duplicateClassification: AuditDuplicateClassification;
}

function isDuplicateKeyError(err: unknown): boolean {
  const seen = new WeakSet<object>();
  let current: unknown = err;
  let depth = 0;
  while (current && typeof current === "object" && depth < 5) {
    if (seen.has(current)) break;
    seen.add(current);
    const e = current as Record<string, unknown>;
    if (e.code === "ER_DUP_ENTRY" || e.errno === 1062) return true;
    current = e.cause;
    depth += 1;
  }
  return false;
}

function normalizeSubjectId(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

/** Canonical JSON (key-sorted) so stored and supplied metadata compare equal
 * regardless of key order. Metadata reaching this point is already WBS7A
 * sanitized JSON-like structure. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const entries = Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`);
  return `{${entries.join(",")}}`;
}

/**
 * Accept only canonical envelopes created/validated by WBS7A: re-running the
 * pure constructor over the candidate's own fields must reproduce it
 * fingerprint-for-fingerprint. Hand-built, unnormalized or unsanitized
 * candidates fail closed.
 */
function assertCanonicalAuditEvent(candidate: unknown): asserts candidate is AuditEvent {
  if (typeof candidate !== "object" || candidate === null) {
    throw new AuditEventError("INVALID_AUDIT_EVENT", "persistAuditEvent requires an AuditEvent object.");
  }
  let revalidated: AuditEvent;
  try {
    revalidated = createAuditEvent({ ...(candidate as AuditEvent) });
  } catch (err) {
    throw new AuditEventError(
      "INVALID_AUDIT_EVENT",
      `Not a valid AuditEvent: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (buildAuditEventFingerprint(revalidated) !== buildAuditEventFingerprint(candidate as AuditEvent)) {
    throw new AuditEventError(
      "NONCANONICAL_AUDIT_EVENT",
      "AuditEvent is not in canonical normalized form; construct it via createAuditEvent."
    );
  }
}

function toInsertRow(event: AuditEvent, fingerprint: string): InsertAuditEventRow {
  return {
    eventFingerprint: fingerprint,
    schemaVersion: event.schemaVersion,
    eventType: event.eventType,
    // Verbatim from the event; never replaced with current time.
    occurredAt: event.occurredAt,
    userId: event.userId,
    campaignId: event.campaignId,
    businessId: event.businessId,
    workflowOperationId: event.workflowOperationId,
    workflowAttemptId: event.workflowAttemptId,
    approvalRequestId: event.approvalRequestId,
    artifactId: normalizeSubjectId(event.artifactId),
    packageId: normalizeSubjectId(event.packageId),
    contentId: normalizeSubjectId(event.contentId),
    source: event.source,
    outcome: event.outcome,
    metadata: event.metadata as InsertAuditEventRow["metadata"],
  };
}

function rowMatchesEvent(row: AuditEventRow, event: AuditEvent, fingerprint: string): boolean {
  return (
    row.eventFingerprint === fingerprint &&
    row.schemaVersion === event.schemaVersion &&
    row.eventType === event.eventType &&
    row.occurredAt === event.occurredAt &&
    row.userId === event.userId &&
    row.source === event.source &&
    row.outcome === event.outcome &&
    (row.campaignId ?? null) === event.campaignId &&
    (row.businessId ?? null) === event.businessId &&
    (row.workflowOperationId ?? null) === event.workflowOperationId &&
    (row.workflowAttemptId ?? null) === event.workflowAttemptId &&
    (row.approvalRequestId ?? null) === event.approvalRequestId &&
    normalizeSubjectId(row.artifactId) === normalizeSubjectId(event.artifactId) &&
    normalizeSubjectId(row.packageId) === normalizeSubjectId(event.packageId) &&
    normalizeSubjectId(row.contentId) === normalizeSubjectId(event.contentId) &&
    canonicalJson(row.metadata) === canonicalJson(event.metadata)
  );
}

function fingerprintConflictError(fingerprint: string): AuditEventError {
  return new AuditEventError(
    "AUDIT_FINGERPRINT_CONFLICT",
    `audit_events row for fingerprint ${fingerprint} exists with different material content; refusing to overwrite durable audit evidence.`
  );
}

/**
 * Persist one canonical AuditEvent durably.
 *
 * Replay-safe: identical canonical events share one durable row. Fail-closed:
 * a stored row under the same fingerprint with different material content
 * throws AUDIT_FINGERPRINT_CONFLICT and nothing is modified.
 */
export async function persistAuditEvent(
  event: AuditEvent,
  executor?: AuditDbExecutor
): Promise<PersistAuditEventResult> {
  assertCanonicalAuditEvent(event);
  const fingerprint = buildAuditEventFingerprint(event);
  const db = resolveAuditDb(executor);

  const [existing] = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.eventFingerprint, fingerprint))
    .limit(1);

  if (existing) {
    if (!rowMatchesEvent(existing, event, fingerprint)) {
      throw fingerprintConflictError(fingerprint);
    }
    return {
      event,
      row: existing,
      inserted: false,
      duplicateClassification: "idempotent_replay",
    };
  }

  try {
    await db.insert(auditEvents).values(toInsertRow(event, fingerprint));
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    // Lost a select-then-insert race: re-read through the same executor route
    // and verify the committed row before treating the event as replayed.
    const [raced] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.eventFingerprint, fingerprint))
      .limit(1);
    if (raced && rowMatchesEvent(raced, event, fingerprint)) {
      return {
        event,
        row: raced,
        inserted: false,
        duplicateClassification: "idempotent_replay",
      };
    }
    throw fingerprintConflictError(fingerprint);
  }

  const [persisted] = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.eventFingerprint, fingerprint))
    .limit(1);

  return {
    event,
    row: persisted!,
    inserted: true,
    duplicateClassification: "none",
  };
}
