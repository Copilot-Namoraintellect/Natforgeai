// ─── R8-A Strategic Memory — deterministic identity ───
//
// PURE module: tenant + business + source authority + source identity +
// semantic memory type + server-derived context scope → memoryKey → memoryId;
// lifecycle fact identity (smf1:); the immutable-core evidence hash; and the
// upstream source fingerprint. Identity is server-derived only; the tenant and
// business are bound inside every hash so cross-tenant/cross-business
// collision or correlation is impossible. No wall-clock, no randomness —
// replaying the same authoritative inputs reproduces the same identity.
// No fuzzy matching. No I/O.

import { canonicalJson, sha256Hex } from "./strategic-memory-contract";
import type { StrategicMemoryContextScopeType } from "./strategic-memory-contract";

/** Prefixes make identities self-describing in logs and handoff envelopes. */
export const STRATEGIC_MEMORY_ID_PREFIX = "mem1:" as const;
export const STRATEGIC_MEMORY_LIFECYCLE_ID_PREFIX = "smf1:" as const;

/** Server-derived bounded context scope (contract §3.7). */
export interface StrategicMemoryContextScope {
  scopeType: StrategicMemoryContextScopeType;
  campaignId: number | null;
  businessDnaSnapshotId: string | null;
}

export function canonicalContextScope(scope: StrategicMemoryContextScope): string {
  return canonicalJson({
    scopeType: scope.scopeType,
    campaignId: scope.campaignId ?? null,
    businessDnaSnapshotId: scope.businessDnaSnapshotId ?? null,
  });
}

/**
 * memoryKey: opaque 64-hex identity binding tenant + business + source
 * authority + source identity + semantic memory type + context scope.
 * tenantUserId/businessId inside the hash anchor the scope: identical upstream
 * evidence under a different tenant or business can never collide.
 */
export function deriveMemoryKey(input: {
  tenantUserId: number;
  businessId: number;
  sourceAuthority: string;
  sourceIdentity: string;
  memoryType: string;
  contextScope: StrategicMemoryContextScope;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      tenantUserId: input.tenantUserId,
      businessId: input.businessId,
      sourceAuthority: input.sourceAuthority,
      sourceIdentity: input.sourceIdentity,
      memoryType: input.memoryType,
      contextScope: canonicalContextScope(input.contextScope),
    })
  );
}

export function deriveMemoryId(memoryKey: string): string {
  return `${STRATEGIC_MEMORY_ID_PREFIX}${memoryKey}`;
}

/**
 * Operator-path attestation coordinates: deterministic source identity for a
 * human-entered record. Same operator + same subject + same type + same
 * statement text ⇒ same identity (idempotent re-attestation converges);
 * changed material ⇒ new identity (a successor may supersede explicitly).
 */
export function deriveOperatorSourceIdentity(input: {
  tenantUserId: number;
  businessId: number;
  memoryType: string;
  subjectType: string;
  subjectId: string;
  statementText: string;
}): string {
  return `att1:${sha256Hex(
    canonicalJson({
      v: 1,
      tenantUserId: input.tenantUserId,
      businessId: input.businessId,
      memoryType: input.memoryType,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      statementText: input.statementText,
    })
  )}`;
}

/**
 * smf1 lifecycle fact identity: deterministic over the exact fact material.
 * Replays of the same fact reproduce the same id, so retries converge on one
 * durable row.
 */
export function deriveMemoryLifecycleKey(input: {
  memoryId: string;
  lifecycleType: string;
  targetStatus: string;
  successorMemoryId: string | null;
  sourceIdentity: string | null;
  occurredAt: string;
  reasonCode: string | null;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      memoryId: input.memoryId,
      lifecycleType: input.lifecycleType,
      targetStatus: input.targetStatus,
      successorMemoryId: input.successorMemoryId ?? null,
      sourceIdentity: input.sourceIdentity ?? null,
      occurredAt: input.occurredAt,
      reasonCode: input.reasonCode ?? null,
    })
  );
}

export function buildMemoryLifecycleEventId(lifecycleKey: string): string {
  return `${STRATEGIC_MEMORY_LIFECYCLE_ID_PREFIX}${lifecycleKey}`;
}

/**
 * Upstream source fingerprint: binds the exact upstream material consumed at
 * ingest (the projection's authority-bearing fields). Re-ingest recomputes it
 * from the durable upstream row; disagreement with the client's claimed view
 * is tampering/injection and fails closed. No PII participates.
 */
export function deriveSourceFingerprint(input: {
  sourceAuthority: string;
  sourceIdentity: string;
  sourceVersion: string;
  material: Record<string, unknown>;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      sourceAuthority: input.sourceAuthority,
      sourceIdentity: input.sourceIdentity,
      sourceVersion: input.sourceVersion,
      material: input.material,
    })
  );
}

/**
 * Evidence hash: binds the immutable core of a strategic-memory record. The
 * hashed fragment is rebuilt field-by-field — callers cannot smuggle extra
 * keys into the hash. `recordedAt` (server acceptance time) is deliberately
 * excluded: re-ingesting the same upstream record later must converge as an
 * idempotent replay, not conflict on clock drift. Drift between a retained
 * row and this hash is tampering evidence and fails closed
 * (STRATEGIC_MEMORY_EVIDENCE_CONFLICT).
 */
export function deriveMemoryEvidenceHash(input: {
  userId: number;
  businessId: number;
  memoryType: string;
  subjectType: string;
  subjectId: string;
  statementType: string;
  statement: unknown;
  evidenceRefs: string[];
  sourceAuthority: string;
  sourceVersion: string;
  sourceIdentity: string;
  confidenceClass: string;
  basis: unknown;
  limitations: string[];
  validFrom: string;
  validUntil: string | null;
  observedAt: string;
  supersedesMemoryId: string | null;
  contradictsMemoryIds: string[];
  contextScope: StrategicMemoryContextScope;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      userId: input.userId,
      businessId: input.businessId,
      memoryType: input.memoryType,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      statementType: input.statementType,
      statement: input.statement ?? null,
      evidenceRefs: [...input.evidenceRefs].sort(),
      sourceAuthority: input.sourceAuthority,
      sourceVersion: input.sourceVersion,
      sourceIdentity: input.sourceIdentity,
      confidenceClass: input.confidenceClass,
      basis: input.basis ?? null,
      limitations: [...input.limitations].sort(),
      validFrom: input.validFrom,
      validUntil: input.validUntil ?? null,
      observedAt: input.observedAt,
      supersedesMemoryId: input.supersedesMemoryId ?? null,
      contradictsMemoryIds: [...input.contradictsMemoryIds].sort(),
      contextScope: canonicalContextScope(input.contextScope),
    })
  );
}
