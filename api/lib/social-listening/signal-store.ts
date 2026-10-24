/**
 * Durable canonical signal store (WBS-R5-A A3).
 *
 * Exact-once acceptance, replay-safe by construction, mirroring the R4
 * replay-safe audit-store semantics:
 *
 * - the unique natural key (provider, providerAccountId, externalEventId)
 *   makes one logical provider event durable exactly once at the database
 *   level — duplicate delivery, concurrent delivery, and provider retries of
 *   the same event all collapse to the single existing row;
 * - an exact replay returns the existing row
 *   (duplicateClassification: "idempotent_replay") with inserted: false;
 * - a natural-key collision whose stored material content differs throws
 *   SIGNAL_FINGERPRINT_CONFLICT and nothing is modified (fail closed) — the
 *   same external identity can never be re-bound to different evidence;
 * - there is NO update path: accepted evidence is immutable;
 * - no in-memory dedupe is consulted; the database unique index is the only
 *   authority, so restart, crash-after-persist, and multi-process delivery are
 *   all safe.
 *
 * Optional caller-owned executor seam (default getDb(), or a Drizzle
 * transaction callback) without transaction-lifecycle ownership.
 */

import { eq, and } from "drizzle-orm";
import { socialSignals, type SocialSignal } from "@db/schema";
import { getDb } from "../../queries/connection";
import type { CanonicalSocialSignal } from "./signal-contract";

type SignalDb = ReturnType<typeof getDb>;

export interface SignalStoreExecutor {
  select: SignalDb["select"];
  insert: SignalDb["insert"];
}

function resolveDb(executor?: SignalStoreExecutor): SignalStoreExecutor {
  return executor ?? getDb();
}

export type SignalDuplicateClassification = "none" | "idempotent_replay";

export interface AcceptSocialSignalResult {
  /** The canonical signal as accepted. */
  signal: CanonicalSocialSignal;
  /** The durable row: newly inserted or the pre-existing row on replay. */
  row: SocialSignal;
  /** True only when this call created the durable row. */
  inserted: boolean;
  duplicateClassification: SignalDuplicateClassification;
}

export class SignalStoreError extends Error {
  readonly code: "SIGNAL_FINGERPRINT_CONFLICT" | "INVALID_SIGNAL";
  constructor(code: "SIGNAL_FINGERPRINT_CONFLICT" | "INVALID_SIGNAL", message: string) {
    super(message);
    this.name = "SignalStoreError";
    this.code = code;
  }
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

function timeMs(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function nullableEqual(a: unknown, b: unknown): boolean {
  return (a ?? null) === (b ?? null);
}

function toInsertRow(signal: CanonicalSocialSignal) {
  return {
    signalKey: signal.signalKey,
    userId: signal.userId,
    businessId: signal.businessId,
    provider: signal.provider,
    platform: signal.platform,
    integrationId: signal.integrationId,
    providerAccountId: signal.providerAccountId,
    externalEventId: signal.externalEventId,
    externalObjectId: signal.externalObjectId,
    parentExternalObjectId: signal.parentExternalObjectId,
    signalType: signal.signalType,
    occurredAt: signal.occurredAt,
    observedAt: signal.observedAt,
    sourceCampaignId: signal.sourceCampaignId,
    sourcePublicationId: signal.sourcePublicationId,
    sourcePublicationReceiptId: signal.sourcePublicationReceiptId,
    actorReference: signal.actorReference,
    actorDisplayName: signal.actorDisplayName,
    contentReference: signal.contentReference,
    contentText: signal.contentText,
    providerEvidenceHash: signal.providerEvidenceHash,
    attributionType: signal.attributionType,
    status: signal.status,
    ingestionVersion: signal.ingestionVersion,
    createdAt: signal.createdAt,
  };
}

/** Material-content comparison: a replayed signal must match the durable row
 *  on every evidence-bearing field, not merely on the natural key.
 *  observedAt/createdAt are acceptance-attempt metadata (a redelivery is
 *  observed later by definition) and are deliberately excluded — the durable
 *  row keeps the FIRST observation. */
function rowMatchesSignal(row: SocialSignal, signal: CanonicalSocialSignal): boolean {
  return (
    row.signalKey === signal.signalKey &&
    row.userId === signal.userId &&
    nullableEqual(row.businessId, signal.businessId) &&
    row.provider === signal.provider &&
    row.platform === signal.platform &&
    row.integrationId === signal.integrationId &&
    row.providerAccountId === signal.providerAccountId &&
    row.externalEventId === signal.externalEventId &&
    nullableEqual(row.externalObjectId, signal.externalObjectId) &&
    nullableEqual(row.parentExternalObjectId, signal.parentExternalObjectId) &&
    row.signalType === signal.signalType &&
    timeMs(row.occurredAt) === timeMs(signal.occurredAt) &&
    nullableEqual(row.sourceCampaignId, signal.sourceCampaignId) &&
    nullableEqual(row.sourcePublicationId, signal.sourcePublicationId) &&
    nullableEqual(row.sourcePublicationReceiptId, signal.sourcePublicationReceiptId) &&
    nullableEqual(row.actorReference, signal.actorReference) &&
    nullableEqual(row.actorDisplayName, signal.actorDisplayName) &&
    nullableEqual(row.contentReference, signal.contentReference) &&
    nullableEqual(row.contentText, signal.contentText) &&
    row.providerEvidenceHash === signal.providerEvidenceHash &&
    row.attributionType === signal.attributionType &&
    row.status === signal.status &&
    row.ingestionVersion === signal.ingestionVersion
  );
}

function fingerprintConflictError(signal: CanonicalSocialSignal): SignalStoreError {
  return new SignalStoreError(
    "SIGNAL_FINGERPRINT_CONFLICT",
    `social_signals row for ${signal.provider}:${signal.providerAccountId}:${signal.externalEventId} exists with different material content; refusing to overwrite durable signal evidence.`
  );
}

async function selectByNaturalKey(
  db: SignalStoreExecutor,
  signal: CanonicalSocialSignal
): Promise<SocialSignal | null> {
  const [row] = await db
    .select()
    .from(socialSignals)
    .where(
      and(
        eq(socialSignals.provider, signal.provider),
        eq(socialSignals.providerAccountId, signal.providerAccountId),
        eq(socialSignals.externalEventId, signal.externalEventId)
      )
    )
    .limit(1);
  return (row as SocialSignal | undefined) ?? null;
}

/**
 * Accept one canonical signal durably, exactly once.
 *
 * Idempotent under exact replay; fail-closed on conflicting replay; safe
 * under concurrent delivery (the unique index serializes; a lost select-then-
 * insert race re-reads and verifies the committed row).
 */
export async function acceptSocialSignal(
  signal: CanonicalSocialSignal,
  executor?: SignalStoreExecutor
): Promise<AcceptSocialSignalResult> {
  if (!signal || typeof signal.signalKey !== "string" || signal.signalKey.length === 0) {
    throw new SignalStoreError("INVALID_SIGNAL", "acceptSocialSignal requires a canonical signal.");
  }
  const db = resolveDb(executor);

  const existing = await selectByNaturalKey(db, signal);
  if (existing) {
    if (!rowMatchesSignal(existing, signal)) {
      throw fingerprintConflictError(signal);
    }
    return {
      signal,
      row: existing,
      inserted: false,
      duplicateClassification: "idempotent_replay",
    };
  }

  try {
    await db.insert(socialSignals).values(toInsertRow(signal));
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    // Lost a select-then-insert race: re-read through the same executor route
    // and verify the committed row before treating the signal as replayed.
    const raced = await selectByNaturalKey(db, signal);
    if (raced && rowMatchesSignal(raced, signal)) {
      return {
        signal,
        row: raced,
        inserted: false,
        duplicateClassification: "idempotent_replay",
      };
    }
    throw fingerprintConflictError(signal);
  }

  const persisted = await selectByNaturalKey(db, signal);
  if (!persisted) {
    throw new SignalStoreError(
      "INVALID_SIGNAL",
      "social_signals row was not readable after insert."
    );
  }
  return { signal, row: persisted, inserted: true, duplicateClassification: "none" };
}
