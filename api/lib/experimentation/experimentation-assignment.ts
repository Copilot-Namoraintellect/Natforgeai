// ─── R7-D Experimentation Engine — assignment authority (D4) ───
//
// PURE module. Deterministic, reproducible, tenant/business-scoped,
// stable-per-subject, model-independent assignment. Same subject + same
// experiment + same assignmentVersion ⇒ same arm, always. Reassignment
// gaming is impossible: the assignment salt is pinned at activation and the
// persisted row is the authority — a divergent re-derivation fails closed.
// No client ever supplies or selects an arm.

import {
  ExperimentStateError,
  type ExperimentDuplicateClassification,
} from "./experimentation-contract";
import {
  deriveSubjectKey,
  deriveAssignmentBucket,
  armIndexForBucket,
  deriveAssignmentId,
} from "./experimentation-identity";

export interface AssignmentComputation {
  readonly assignmentId: string;
  readonly subjectKey: string;
  readonly armIndex: number;
  readonly bucket: number;
}

/** Compute the deterministic assignment for one subject (no I/O). */
export function computeAssignment(input: {
  userId: number;
  experimentId: string;
  assignmentVersion: string;
  fractionsBps: readonly number[];
  subjectRef: string;
}): AssignmentComputation {
  const subjectRef = input.subjectRef.trim();
  if (subjectRef.length === 0) {
    throw new ExperimentStateError(
      "EXPERIMENT_MALFORMED_SUBJECT",
      "subjectRef must be a non-blank opaque subject reference."
    );
  }
  if (subjectRef.length > 512) {
    throw new ExperimentStateError(
      "EXPERIMENT_MALFORMED_SUBJECT",
      "subjectRef exceeds the 512-char bound."
    );
  }
  const subjectKey = deriveSubjectKey({
    userId: input.userId,
    experimentId: input.experimentId,
    subjectRef,
  });
  const bucket = deriveAssignmentBucket({
    experimentId: input.experimentId,
    assignmentVersion: input.assignmentVersion,
    subjectKey,
  });
  const armIndex = armIndexForBucket(bucket, input.fractionsBps);
  return {
    assignmentId: deriveAssignmentId({ experimentId: input.experimentId, subjectKey }),
    subjectKey,
    armIndex,
    bucket,
  };
}

export interface AssignmentReconciliation {
  readonly classification: ExperimentDuplicateClassification;
  readonly armIndex: number;
  readonly assignmentId: string;
}

/**
 * Reconcile a computed assignment against the persisted row. The persisted
 * row is authority: a replay converges silently; a divergent re-derivation
 * (different arm for the same subject+experiment) is tampering and fails
 * closed — this is the reassignment-gaming guard.
 */
export function reconcileAssignment(input: {
  computed: AssignmentComputation;
  persisted: { assignmentId: string; subjectKey: string; armIndex: number } | null;
}): AssignmentReconciliation {
  const { computed, persisted } = input;
  if (persisted === null) {
    return {
      classification: "none",
      armIndex: computed.armIndex,
      assignmentId: computed.assignmentId,
    };
  }
  if (
    persisted.assignmentId !== computed.assignmentId ||
    persisted.subjectKey !== computed.subjectKey ||
    persisted.armIndex !== computed.armIndex
  ) {
    throw new ExperimentStateError(
      "EXPERIMENT_ASSIGNMENT_CONFLICT",
      "Persisted assignment for this subject conflicts with deterministic re-derivation; failing closed."
    );
  }
  return {
    classification: "idempotent_replay",
    armIndex: persisted.armIndex,
    assignmentId: persisted.assignmentId,
  };
}
