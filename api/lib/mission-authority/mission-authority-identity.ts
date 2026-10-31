// ─── R9-A Mission Authority — deterministic identities (A2) ───
//
// mis1: mission identity — same authoritative basis (tenant + business +
// source governed strategic candidate + mission type + objective scope +
// constraint set) ⇒ same mission proposal; conflicting replay under the same
// identity fails closed (contract §3). obj1: mission objective identity.
// misl1: append-only lifecycle fact identity. No client- or model-minted
// identity exists anywhere in this stream.

import {
  canonicalJson,
  sha256Hex,
} from "./mission-authority-contract";

export const MISSION_ID_PREFIX = "mis1:" as const;
export const OBJECTIVE_ID_PREFIX = "obj1:" as const;
export const LIFECYCLE_EVENT_ID_PREFIX = "misl1:" as const;

/**
 * Deterministic mission identity (contract §3). Wording (objective
 * statement) is deliberately NOT an identity input: rewording never mints a
 * new mission; a material change (type/scope/constraint set) does.
 */
export function deriveMissionId(input: {
  userId: number;
  businessId: number;
  sourceCandidateId: string;
  missionType: string;
  scopeKey: string;
  constraintSetFingerprint: string;
}): string {
  return (
    MISSION_ID_PREFIX +
    sha256Hex(
      canonicalJson({
        v: 1,
        userId: input.userId,
        businessId: input.businessId,
        sourceCandidateId: input.sourceCandidateId,
        missionType: input.missionType,
        scopeKey: input.scopeKey,
        constraintSetFingerprint: input.constraintSetFingerprint,
      })
    )
  );
}

/** Deterministic mission objective identity (contract §3). */
export function deriveObjectiveId(input: {
  userId: number;
  businessId: number;
  sourceCandidateId: string;
  objectiveType: string;
  scopeKey: string;
  objectiveStatement: string;
}): string {
  return (
    OBJECTIVE_ID_PREFIX +
    sha256Hex(
      canonicalJson({
        v: 1,
        userId: input.userId,
        businessId: input.businessId,
        sourceCandidateId: input.sourceCandidateId,
        objectiveType: input.objectiveType,
        scopeKey: input.scopeKey,
        objectiveStatement: input.objectiveStatement,
      })
    )
  );
}

/** Canonical objective scope key: derived scope only, never client/model text. */
export function deriveScopeKey(input: {
  subjectType: string;
  businessId: number;
}): string {
  return `${input.subjectType}:business:${input.businessId}`;
}

/** Fingerprint of the canonical constraint set (sorted, tamper-evident). */
export function deriveConstraintSetFingerprint(
  constraints: ReadonlyArray<{
    readonly constraintType: string;
    readonly statement: string;
    readonly referenceValue?: string | null;
    readonly amountMinorUnits?: number | null;
    readonly currency?: string | null;
  }>
): string {
  const canonical = [...constraints]
    .map((c) => {
      const record = c as Record<string, unknown>;
      return {
        constraintType: String(record.constraintType ?? ""),
        statement: String(record.statement ?? ""),
        referenceValue: typeof record.referenceValue === "string" ? record.referenceValue : null,
        amountMinorUnits: typeof record.amountMinorUnits === "number" ? record.amountMinorUnits : null,
        currency: typeof record.currency === "string" ? record.currency : null,
      };
    })
    .sort((a, b) => {
      const ka = `${a.constraintType}|${a.statement}`;
      const kb = `${b.constraintType}|${b.statement}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  return sha256Hex(canonicalJson({ v: 1, constraints: canonical }));
}

/**
 * Fingerprint over the immutable mission core (replay-conflict anchor). Any
 * material change under the same convergence anchor is a conflicting replay
 * (fail closed); legitimate change mints a NEW superseding mission instead.
 */
export function deriveMissionFingerprint(input: {
  missionId: string;
  sourceCandidateId: string;
  missionType: string;
  objectiveType: string;
  expectedOutcome: string;
  strategicRiskClass: string;
  priorityContext: string;
  validFrom: string;
  validUntil: string;
  supersedesMissionId: string | null;
  lineageHash: string;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      missionId: input.missionId,
      sourceCandidateId: input.sourceCandidateId,
      missionType: input.missionType,
      objectiveType: input.objectiveType,
      expectedOutcome: input.expectedOutcome,
      strategicRiskClass: input.strategicRiskClass,
      priorityContext: input.priorityContext,
      validFrom: input.validFrom,
      validUntil: input.validUntil,
      supersedesMissionId: input.supersedesMissionId,
      lineageHash: input.lineageHash,
    })
  );
}

/** Fingerprint over the immutable objective core. */
export function deriveObjectiveFingerprint(input: {
  objectiveId: string;
  objectiveType: string;
  objectiveStatement: string;
  scopeKey: string;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      objectiveId: input.objectiveId,
      objectiveType: input.objectiveType,
      objectiveStatement: input.objectiveStatement,
      scopeKey: input.scopeKey,
    })
  );
}

/**
 * Lineage hash binding the verbatim R8 material: candidate identity,
 * governing reasoning ids, governance reference, the candidate's stored
 * fingerprint and the frozen projection version. Tampering with any bound
 * upstream fact changes the hash and fails replay closed.
 */
export function deriveLineageHash(input: {
  sourceCandidateId: string;
  sourceReasoningIds: readonly string[];
  governanceDecisionId: string | null;
  governanceDecision: string | null;
  policyVersion: string | null;
  candidateFingerprint: string;
  projectionVersion: string;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      sourceCandidateId: input.sourceCandidateId,
      sourceReasoningIds: [...input.sourceReasoningIds].sort(),
      governanceDecisionId: input.governanceDecisionId,
      governanceDecision: input.governanceDecision,
      policyVersion: input.policyVersion,
      candidateFingerprint: input.candidateFingerprint,
      projectionVersion: input.projectionVersion,
    })
  );
}

/** Deterministic lifecycle fact identity. */
export function deriveLifecycleEventId(input: {
  missionId: string;
  lifecycleType: string;
  targetStatus: string;
  successorMissionId: string | null;
  occurredAt: string;
  reasonCode: string | null;
}): string {
  return (
    LIFECYCLE_EVENT_ID_PREFIX +
    sha256Hex(
      canonicalJson({
        v: 1,
        missionId: input.missionId,
        lifecycleType: input.lifecycleType,
        targetStatus: input.targetStatus,
        successorMissionId: input.successorMissionId,
        occurredAt: input.occurredAt,
        reasonCode: input.reasonCode,
      })
    )
  );
}
