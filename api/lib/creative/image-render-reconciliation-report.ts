import {
  classifyImageRenderRecovery,
  type ImageRenderRecoveryClassification,
  type ImageRenderRecoveryEvidence,
} from "./image-render-recovery-classifier";
import {
  collectImageRenderReconciliationEvidence,
  type ImageRenderReconciliationEvidenceCollectionResult,
  type ImageRenderReconciliationEvidenceInput,
} from "./image-render-reconciliation-evidence";
import {
  classifyImageRenderReconciliation,
  type ImageRenderReconciliationClassification,
} from "./image-render-reconciliation-classifier";

// ─── Dormant image-render reconciliation operator report (Slice C4C) ───
//
// Composes the already-completed read-only Slice C components into one
// sanitized, operator-facing reconciliation report:
//
//   C2 (pure recovery classification)
//     → C4B (read-only exact-identity evidence collection, dependency-injected)
//     → C4A (pure reconciliation classification)
//
// C4C introduces NO new evidence discovery, owns NO database capability, and
// authorizes nothing: every report carries mutationAuthorized: false. The
// report exposes only classification outcomes plus an evidence-availability
// summary (kinds only — never match booleans, amounts, or identities) and
// never logs its input. Blocked C4B outcomes become blocked operator reports;
// programming/validation errors propagate unchanged. This module is dormant:
// ZERO production callers.

export interface ImageRenderReconciliationReportInput {
  readonly recoveryEvidence: ImageRenderRecoveryEvidence;
  readonly claimIdentity: {
    readonly claimId: number;
    readonly userId: number;
    readonly contentPostId: number;
    readonly requestAttemptKey: string;
    readonly intentFingerprint: string;
    readonly deductionKey: string;
  };
}

export interface ImageRenderReconciliationReportDependencies {
  collectEvidence: (
    input: ImageRenderReconciliationEvidenceInput
  ) => Promise<ImageRenderReconciliationEvidenceCollectionResult>;
}

const defaultDependencies: ImageRenderReconciliationReportDependencies = {
  collectEvidence: (input) => collectImageRenderReconciliationEvidence(input),
};

export type ImageRenderReconciliationOperatorReport =
  | {
      readonly status: "classified";
      readonly recoveryClassification: ImageRenderRecoveryClassification;
      readonly reconciliationClassification: ImageRenderReconciliationClassification;
      readonly operatorReviewRequired: boolean;
      readonly evidence: {
        readonly generatedImage:
          | "not_checked"
          | "absent"
          | "present"
          | "lookup_failed";
        readonly contentPost:
          | "not_checked"
          | "matches_generated_image"
          | "no_generated_image_link"
          | "mismatch"
          | "lookup_failed";
        readonly deduction: "not_checked" | "absent" | "present" | "lookup_failed";
        readonly usageObservation: "not_checked";
      };
      readonly mutationAuthorized: false;
    }
  | {
      readonly status: "blocked";
      readonly recoveryClassification: ImageRenderRecoveryClassification;
      readonly reconciliationClassification: null;
      readonly operatorReviewRequired: true;
      readonly reason:
        | "claim_lookup_failed"
        | "claim_not_found_or_identity_mismatch";
      readonly mutationAuthorized: false;
    };

/**
 * Compose the operator report. Exact order: C2 classification → C4B evidence
 * collection (exactly once) → C4A classification (exactly once, only on
 * collected evidence). No retry, no reread, no fallback. C4B's blocked
 * outcomes are normal closed outcomes converted into blocked reports;
 * everything else that throws propagates fail-closed.
 */
export async function composeImageRenderReconciliationReport(
  input: ImageRenderReconciliationReportInput,
  dependencies: ImageRenderReconciliationReportDependencies = defaultDependencies
): Promise<ImageRenderReconciliationOperatorReport> {
  const recovery = classifyImageRenderRecovery(input.recoveryEvidence);

  const collected = await dependencies.collectEvidence({
    upstream: recovery.classification,
    claimId: input.claimIdentity.claimId,
    userId: input.claimIdentity.userId,
    contentPostId: input.claimIdentity.contentPostId,
    requestAttemptKey: input.claimIdentity.requestAttemptKey,
    intentFingerprint: input.claimIdentity.intentFingerprint,
    deductionKey: input.claimIdentity.deductionKey,
  });

  if (collected.status === "blocked") {
    return Object.freeze({
      status: "blocked",
      recoveryClassification: recovery.classification,
      reconciliationClassification: null,
      operatorReviewRequired: true,
      reason: collected.reason,
      mutationAuthorized: false,
    }) as ImageRenderReconciliationOperatorReport;
  }

  const reconciliation = classifyImageRenderReconciliation(collected.evidence);

  const evidence = Object.freeze({
    generatedImage: collected.evidence.generatedImage.kind,
    contentPost: collected.evidence.contentPost.kind,
    deduction: collected.evidence.deduction.kind,
    usageObservation: collected.evidence.usageObservation,
  });

  return Object.freeze({
    status: "classified",
    recoveryClassification: recovery.classification,
    reconciliationClassification: reconciliation.classification,
    operatorReviewRequired: reconciliation.operatorReviewRequired,
    evidence,
    mutationAuthorized: false,
  }) as ImageRenderReconciliationOperatorReport;
}
