// ─── R9-C Dependency & Scheduling Intelligence — deterministic identity ───
//
// PURE module: tenant + business + mission + plan + dependency material →
// dep1:; schedule content → sch1:; lifecycle fact identity (msl1:); plan,
// graph, state-view, edge-core and schedule-core fingerprints. Identity is
// server-derived only; the tenant and business are bound inside every hash so
// cross-tenant/cross-business collision or correlation is impossible. No
// wall-clock, no randomness — replaying the same authoritative inputs
// reproduces the same identity. No fuzzy comparison. No I/O.

import { canonicalJson, sha256Hex } from "../conversion/conversion-contract";
import {
  canonicalExclusionPair,
  type MissionDependencyHardness,
  type MissionDependencySource,
  type MissionDependencyType,
} from "./mission-scheduling-contract";

export const DEPENDENCY_ID_PREFIX = "dep1:" as const;
export const SCHEDULE_ID_PREFIX = "sch1:" as const;
export const SCHEDULE_LIFECYCLE_ID_PREFIX = "msl1:" as const;

export interface DependencyIdentityInput {
  tenantUserId: number;
  businessId: number;
  missionId: string;
  planId: string;
  predecessorTaskId: string;
  successorTaskId: string;
  dependencyType: MissionDependencyType;
  hardOrSoft: MissionDependencyHardness;
  source: MissionDependencySource;
  reason: string | null;
}

/**
 * Deterministic dependency identity. MUTUAL_EXCLUSION pairs are normalised to
 * a canonical endpoint order first, so the symmetric edge has exactly one
 * identity no matter which endpoint the caller names as predecessor.
 */
export function deriveDependencyId(input: DependencyIdentityInput): string {
  const [pred, succ] =
    input.dependencyType === "MUTUAL_EXCLUSION"
      ? canonicalExclusionPair(input.predecessorTaskId, input.successorTaskId)
      : [input.predecessorTaskId, input.successorTaskId];
  return (
    DEPENDENCY_ID_PREFIX +
    sha256Hex(
      canonicalJson({
        v: 1,
        tenantUserId: input.tenantUserId,
        businessId: input.businessId,
        missionId: input.missionId,
        planId: input.planId,
        predecessorTaskId: pred,
        successorTaskId: succ,
        dependencyType: input.dependencyType,
        hardOrSoft: input.hardOrSoft,
        source: input.source,
        reason: input.reason,
      })
    )
  );
}

/** Immutable-core hash for a stored dependency row; drift fails closed. */
export function deriveDependencyEvidenceHash(input: DependencyIdentityInput): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      core: "mission_dependency_edge",
      identity: deriveDependencyId(input),
      material: {
        tenantUserId: input.tenantUserId,
        businessId: input.businessId,
        missionId: input.missionId,
        planId: input.planId,
        predecessorTaskId: input.predecessorTaskId,
        successorTaskId: input.successorTaskId,
        dependencyType: input.dependencyType,
        hardOrSoft: input.hardOrSoft,
        source: input.source,
        reason: input.reason,
      },
    })
  );
}

export interface GraphEdgeFingerprint {
  predecessorTaskId: string;
  successorTaskId: string;
  dependencyType: MissionDependencyType;
  hardOrSoft: MissionDependencyHardness;
}

/** Version-independent graph fingerprint: the deterministic DAG anchor. */
export function deriveGraphHash(input: {
  tenantUserId: number;
  businessId: number;
  missionId: string;
  planId: string;
  taskIds: readonly string[];
  edges: readonly GraphEdgeFingerprint[];
} ): string {
  const sortedEdges = [...input.edges].sort((a, b) =>
    canonicalJson(a) < canonicalJson(b) ? -1 : canonicalJson(a) > canonicalJson(b) ? 1 : 0
  );
  const sortedTasks = [...input.taskIds].sort();
  return sha256Hex(
    canonicalJson({
      v: 1,
      tenantUserId: input.tenantUserId,
      businessId: input.businessId,
      missionId: input.missionId,
      planId: input.planId,
      taskIds: sortedTasks,
      edges: sortedEdges,
    })
  );
}

/** Fingerprint of the accepted plan port material (verbatim scheduling copy). */
export function derivePlanFingerprint(input: {
  tenantUserId: number;
  businessId: number;
  missionId: string;
  planId: string;
  plan: unknown;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      tenantUserId: input.tenantUserId,
      businessId: input.businessId,
      missionId: input.missionId,
      planId: input.planId,
      plan: input.plan,
    })
  );
}

/** Fingerprint of the execution-state view (untrusted material, visibly bound). */
export function deriveStateViewHash(input: {
  tenantUserId: number;
  businessId: number;
  missionId: string;
  planId: string;
  completedTaskIds: readonly string[];
  succeededTaskIds: readonly string[];
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      tenantUserId: input.tenantUserId,
      businessId: input.businessId,
      missionId: input.missionId,
      planId: input.planId,
      completedTaskIds: [...input.completedTaskIds].sort(),
      succeededTaskIds: [...input.succeededTaskIds].sort(),
    })
  );
}

export interface ScheduleIdentityInput {
  tenantUserId: number;
  businessId: number;
  missionId: string;
  planId: string;
  planFingerprint: string;
  graphHash: string;
  stateViewHash: string;
  /** Approval + capability evidence fingerprints at production time. */
  approvalEvidenceHash: string;
  capabilityEvidenceHash: string;
  /** Derived deterministic outputs bound into the identity. */
  orderedTaskIds: readonly string[];
  parallelGroups: readonly (readonly string[])[];
  blockingStates: readonly { taskId: string; readiness: string; reasons: readonly string[] }[];
  readinessHash: string;
  validUntil: string;
}

/**
 * Deterministic schedule identity: same authoritative inputs ⇒ same sch1:.
 * The injected clock never participates — revisions mint new identities only
 * through changed material (new edges, changed state view, changed evidence).
 */
export function deriveScheduleId(input: ScheduleIdentityInput): string {
  return (
    SCHEDULE_ID_PREFIX +
    sha256Hex(
      canonicalJson({
        v: 1,
        tenantUserId: input.tenantUserId,
        businessId: input.businessId,
        missionId: input.missionId,
        planId: input.planId,
        planFingerprint: input.planFingerprint,
        graphHash: input.graphHash,
        stateViewHash: input.stateViewHash,
        approvalEvidenceHash: input.approvalEvidenceHash,
        capabilityEvidenceHash: input.capabilityEvidenceHash,
        orderedTaskIds: [...input.orderedTaskIds],
        parallelGroups: input.parallelGroups.map((group) => [...group]),
        blockingStates: input.blockingStates,
        readinessHash: input.readinessHash,
        validUntil: input.validUntil,
      })
    )
  );
}

/** Immutable-core schedule fingerprint (replay-conflict + tamper anchor). */
export function deriveScheduleFingerprint(input: ScheduleIdentityInput & { producedAt: string }): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      core: "mission_schedule",
      scheduleId: deriveScheduleId(input),
      producedAt: input.producedAt,
    })
  );
}

/** Deterministic per-task readiness report hash (evidence-hash component). */
export function deriveReadinessHash(input: {
  tenantUserId: number;
  businessId: number;
  missionId: string;
  planId: string;
  readiness: readonly { taskId: string; readiness: string; reasons: readonly string[] }[];
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      tenantUserId: input.tenantUserId,
      businessId: input.businessId,
      missionId: input.missionId,
      planId: input.planId,
      readiness: input.readiness,
    })
  );
}

export function deriveScheduleLifecycleEventId(input: {
  scheduleId: string;
  lifecycleType: string;
  targetStatus: string;
  successorScheduleId: string | null;
  occurredAt: string;
  reasonCode: string | null;
}): string {
  return (
    SCHEDULE_LIFECYCLE_ID_PREFIX +
    sha256Hex(
      canonicalJson({
        v: 1,
        scheduleId: input.scheduleId,
        lifecycleType: input.lifecycleType,
        targetStatus: input.targetStatus,
        successorScheduleId: input.successorScheduleId,
        occurredAt: input.occurredAt,
        reasonCode: input.reasonCode,
      })
    )
  );
}

/** Deterministic hash of an arbitrary evidence set (approval reads). */
export function deriveEvidenceSetHash(material: unknown): string {
  return sha256Hex(canonicalJson({ v: 1, evidence: material }));
}
