// ─── R5-B Intent & Sentiment Intelligence — durable interpretation store (§5) ───
//
// Durable acceptance authority for canonical SocialInterpretation records
// (docs/contracts/social-intelligence-contract.md §5). Records are immutable
// once accepted: this module exposes no update or delete path. Acceptance is
// exact-once under both unique keys (interpretationId and
// businessId+signalId+signalVersion+classifierVersion): a re-presented
// identical record replays idempotently, while a colliding natural key with
// different content fails closed with InterpretationTamperError and the
// committed row stays untouched.

import { and, asc, eq, isNull } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import { socialInterpretations, type SocialInterpretationRow } from "@db/schema";
import { isMySqlDuplicateKeyError } from "../billing/credit-engine";
import {
  assertValidInterpretationRecord,
  InterpretationTamperError,
  type SocialInterpretation,
} from "./interpretation-contract";

/**
 * Structural executor seam: the default getDb() client and a Drizzle
 * transaction callback client both satisfy this shape. Supplied executors
 * carry no transaction-lifecycle ownership here.
 */
export interface InterpretationDbExecutor {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
}

function resolveInterpretationDb(executor?: InterpretationDbExecutor): InterpretationDbExecutor {
  return executor ?? getDb();
}

export interface AcceptInterpretationResult {
  /** The canonical record as accepted (the stored row on replay). */
  readonly record: SocialInterpretation;
  /** True when an identical record was already committed. */
  readonly replayed: boolean;
}

/** Stored JSON must re-validate as a canonical record before it is served. */
function recordFromRow(row: SocialInterpretationRow): SocialInterpretation {
  return assertValidInterpretationRecord(row.record);
}

async function loadByNaturalKey(
  db: InterpretationDbExecutor,
  record: SocialInterpretation
): Promise<SocialInterpretationRow | null> {
  // businessId predicate: `businessId = X`, or `businessId IS NULL` when X is
  // null (the folded form of `businessId = X OR (businessId IS NULL AND X IS
  // NULL)`). SQL NULL would otherwise never match `= NULL`, leaving the
  // unattributed scope unprotected at the application layer.
  const businessCondition =
    record.businessId === null
      ? isNull(socialInterpretations.businessId)
      : eq(socialInterpretations.businessId, record.businessId);
  const [row] = await db
    .select()
    .from(socialInterpretations)
    .where(
      and(
        businessCondition,
        eq(socialInterpretations.signalId, record.signalId),
        eq(socialInterpretations.signalVersion, record.signalVersion),
        eq(socialInterpretations.classifierVersion, record.classifierVersion)
      )
    )
    // Oldest committed row is the authority when more than one is visible.
    .orderBy(asc(socialInterpretations.id))
    .limit(1);
  return (row as SocialInterpretationRow | undefined) ?? null;
}

async function loadByInterpretationId(
  db: InterpretationDbExecutor,
  interpretationId: string
): Promise<SocialInterpretationRow | null> {
  const [row] = await db
    .select()
    .from(socialInterpretations)
    .where(eq(socialInterpretations.interpretationId, interpretationId))
    .limit(1);
  return (row as SocialInterpretationRow | undefined) ?? null;
}

/**
 * The committed row only authorizes a replay when both the natural-key
 * content hash and the deterministic interpretationId match the incoming
 * record exactly. Any deviation is a tamper/stale rejection (§5): fail
 * closed, committed row untouched.
 */
function assertCommittedMatchesIncoming(
  committed: SocialInterpretationRow,
  record: SocialInterpretation
): void {
  if (
    committed.signalContentHash !== record.signalContentHash &&
    committed.interpretationId === record.interpretationId
  ) {
    // Cannot occur for a deterministically derived id, but stays fail-closed
    // if a hand-crafted record ever presents it.
    throw new InterpretationTamperError(
      "INTERPRETATION_IDENTITY_CONFLICT",
      `social interpretation "${record.interpretationId}" is committed with a different signal content hash; refusing to overwrite the durable record.`
    );
  }
  if (
    committed.signalContentHash !== record.signalContentHash ||
    committed.interpretationId !== record.interpretationId
  ) {
    throw new InterpretationTamperError(
      "SIGNAL_CONTENT_HASH_MISMATCH",
      `signal version ${record.signalVersion} for signal "${record.signalId}" (business ${record.businessId}) was already interpreted from different content; refusing to accept a conflicting record.`
    );
  }
}

function toInsertRow(record: SocialInterpretation) {
  return {
    userId: record.userId,
    businessId: record.businessId,
    signalId: record.signalId,
    signalVersion: record.signalVersion,
    signalContentHash: record.signalContentHash,
    classifierVersion: record.classifierVersion,
    interpretationId: record.interpretationId,
    modelOrRuleSource: record.source,
    intent: record.intent,
    sentiment: record.sentiment,
    urgency: record.urgency,
    relevance: record.relevance,
    overallConfidence: record.overallConfidence,
    recommendedHandling: record.recommendedHandling,
    billingIdentity: record.billingIdentity,
    record: record as unknown as Record<string, unknown>,
    createdAt: new Date(record.createdAt),
  };
}

/**
 * Accept one canonical interpretation record durably. Idempotent replay
 * returns the stored record; a colliding natural key with different content
 * fails closed with {@link InterpretationTamperError}. The natural key is
 * resolved in the application layer before insert (MySQL NULL semantics make
 * the unique index alone insufficient for the unattributed scope); the
 * unique keys back the non-null path and the concurrent race.
 */
export async function acceptInterpretation(
  record: SocialInterpretation,
  executor?: InterpretationDbExecutor
): Promise<AcceptInterpretationResult> {
  const validated = assertValidInterpretationRecord(record);
  const db = resolveInterpretationDb(executor);

  const existing = await loadByInterpretationId(db, validated.interpretationId);
  if (existing) {
    assertCommittedMatchesIncoming(existing, validated);
    return { record: recordFromRow(existing), replayed: true };
  }

  // Pre-insert natural-key check (deterministic and businessId-NULL-safe):
  // MySQL treats NULLs as distinct in unique indexes, so the database alone
  // cannot block a tamper insert under (NULL, signalId, signalVersion,
  // classifierVersion). The application layer resolves the natural key
  // before insert; for non-null businessId this is simply an earlier,
  // clearer fail-closed ahead of the unique key.
  const colliding = await loadByNaturalKey(db, validated);
  if (colliding) {
    assertCommittedMatchesIncoming(colliding, validated);
    return { record: recordFromRow(colliding), replayed: true };
  }

  try {
    await db.insert(socialInterpretations).values(toInsertRow(validated));
  } catch (error) {
    if (!isMySqlDuplicateKeyError(error)) throw error;
    // Lost a concurrent insert race: the unique constraint is the authority,
    // so resolve through the committed natural-key row instead of surfacing a
    // raw duplicate-key error.
    const committed = await loadByNaturalKey(db, validated);
    if (!committed) {
      throw new Error(
        `social interpretation "${validated.interpretationId}" reported a duplicate key but no committed row could be loaded`
      );
    }
    assertCommittedMatchesIncoming(committed, validated);
    return { record: recordFromRow(committed), replayed: true };
  }

  const [persisted] = await db
    .select()
    .from(socialInterpretations)
    .where(eq(socialInterpretations.interpretationId, validated.interpretationId))
    .limit(1);

  if (!persisted) {
    throw new Error(
      `failed to reload inserted social interpretation "${validated.interpretationId}"`
    );
  }
  return { record: recordFromRow(persisted), replayed: false };
}

/**
 * Raw row lookup by interpretationId. Ownership is the caller's
 * responsibility; the row's userId is authoritative for that check.
 */
export async function getInterpretationById(
  interpretationId: string,
  executor?: InterpretationDbExecutor
): Promise<SocialInterpretationRow | null> {
  const db = resolveInterpretationDb(executor);
  return loadByInterpretationId(db, interpretationId);
}

/**
 * All accepted interpretations for one logical signal, oldest signal version
 * first (then classifier version). Rows are immutable history.
 */
export async function listInterpretationsForSignal(
  businessId: number,
  signalId: string,
  executor?: InterpretationDbExecutor
): Promise<SocialInterpretationRow[]> {
  const db = resolveInterpretationDb(executor);
  return await db
    .select()
    .from(socialInterpretations)
    .where(
      and(
        eq(socialInterpretations.businessId, businessId),
        eq(socialInterpretations.signalId, signalId)
      )
    )
    .orderBy(asc(socialInterpretations.signalVersion), asc(socialInterpretations.classifierVersion));
}
