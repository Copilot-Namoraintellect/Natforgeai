// ─── Dormant image-render recovery classifier (Slice C2) ───
//
// PURE diagnostic module: it receives normalized durable evidence and returns
// a closed, deterministic classification. It performs no I/O of any kind, has
// zero imports, authorizes nothing, and mutates nothing. Every result carries
// mutationAuthorized: false — even the classifications that later controlled
// recovery slices may act on. The evidence model deliberately excludes all
// identities, tokens, keys, URLs and raw dependency errors: recovery reasoning
// never needs them.

export type ImageRenderRecoveryClaimEvidence =
  | { readonly found: false }
  | {
      readonly found: true;
      readonly status: "running" | "completed" | "failed";
      readonly leaseState: "active" | "stale" | "missing";
      readonly deductionRecorded: boolean;
    };

export type ImageRenderRecoveryDeductionEvidence =
  | "present"
  | "absent"
  | "lookup_failed";

export type ImageRenderRecoveryCompletedResultEvidence =
  | { readonly kind: "not_checked" }
  | { readonly kind: "replayable"; readonly creditsCharged: number }
  | {
      readonly kind: "blocked";
      readonly reason:
        | "intent_conflict"
        | "completed_without_result"
        | "linked_result_missing_or_mismatched"
        | "not_completed_or_not_found";
    }
  | { readonly kind: "lookup_failed" };

export interface ImageRenderRecoveryEvidence {
  readonly claim: ImageRenderRecoveryClaimEvidence;
  readonly deduction: ImageRenderRecoveryDeductionEvidence;
  readonly completedResult: ImageRenderRecoveryCompletedResultEvidence;
}

export type ImageRenderRecoveryClassification =
  | "healthy_running"
  | "completed_replayable"
  | "failed_rearmable"
  | "stale_no_deduction_evidence"
  | "stale_with_deduction_evidence"
  | "running_with_deduction_evidence"
  | "failed_with_deduction_evidence"
  | "completed_without_result"
  | "linked_result_invalid"
  | "integrity_blocked"
  | "operator_review_required";

export interface ImageRenderRecoveryResult {
  readonly classification: ImageRenderRecoveryClassification;
  readonly mutationAuthorized: false;
}

const CLAIM_STATUSES = new Set(["running", "completed", "failed"]);
const LEASE_STATES = new Set(["active", "stale", "missing"]);
const DEDUCTION_VALUES = new Set(["present", "absent", "lookup_failed"]);
const RESULT_KINDS = new Set(["not_checked", "replayable", "blocked", "lookup_failed"]);
const BLOCKED_REASONS = new Set([
  "intent_conflict",
  "completed_without_result",
  "linked_result_missing_or_mismatched",
  "not_completed_or_not_found",
]);

function assertEvidenceShape(evidence: ImageRenderRecoveryEvidence): void {
  if (!evidence || typeof evidence !== "object") {
    throw new TypeError("Invalid recovery evidence: expected an object");
  }
  const claim = evidence.claim;
  if (!claim || typeof claim !== "object" || typeof claim.found !== "boolean") {
    throw new TypeError("Invalid recovery evidence: malformed claim evidence");
  }
  if (claim.found) {
    if (!CLAIM_STATUSES.has(claim.status as string)) {
      throw new TypeError("Invalid recovery evidence: unknown claim status");
    }
    if (!LEASE_STATES.has(claim.leaseState as string)) {
      throw new TypeError("Invalid recovery evidence: unknown lease state");
    }
    if (typeof claim.deductionRecorded !== "boolean") {
      throw new TypeError("Invalid recovery evidence: deductionRecorded must be boolean");
    }
  }
  if (!DEDUCTION_VALUES.has(evidence.deduction as string)) {
    throw new TypeError("Invalid recovery evidence: unknown deduction evidence");
  }
  const result = evidence.completedResult;
  if (!result || typeof result !== "object" || !RESULT_KINDS.has(result.kind as string)) {
    throw new TypeError("Invalid recovery evidence: malformed completed-result evidence");
  }
  if (result.kind === "blocked" && !BLOCKED_REASONS.has(result.reason as string)) {
    throw new TypeError("Invalid recovery evidence: unknown blocked reason");
  }
}

function freezeResult(
  classification: ImageRenderRecoveryClassification
): ImageRenderRecoveryResult {
  return Object.freeze({ classification, mutationAuthorized: false });
}

/**
 * Deterministic, fail-closed classification of normalized durable evidence.
 * Precedence: missing claim → evidence lookup failures → deterministic
 * contradictions → per-status rules. Never throws for valid closed-union
 * evidence; never authorizes anything.
 */
export function classifyImageRenderRecovery(
  evidence: ImageRenderRecoveryEvidence
): ImageRenderRecoveryResult {
  assertEvidenceShape(evidence);
  const { claim, deduction, completedResult } = evidence;

  // A missing claim row is an integrity fault: never infer that "not found"
  // means safe to recreate.
  if (!claim.found) {
    return freezeResult("integrity_blocked");
  }

  // Lookup failures mean the evidence could not be authoritatively
  // established: never guess.
  if (deduction === "lookup_failed" || completedResult.kind === "lookup_failed") {
    return freezeResult("operator_review_required");
  }

  // Completed-result evidence is only meaningful on a completed claim.
  if (claim.status !== "completed" && completedResult.kind !== "not_checked") {
    return freezeResult("integrity_blocked");
  }

  if (claim.status === "running") {
    if (claim.leaseState === "missing") {
      return freezeResult("operator_review_required");
    }
    const hasDeductionEvidence = claim.deductionRecorded || deduction === "present";
    if (claim.leaseState === "active") {
      return freezeResult(
        hasDeductionEvidence ? "running_with_deduction_evidence" : "healthy_running"
      );
    }
    // Stale lease: expired leases stay blocked when any deduction evidence
    // exists; otherwise the durable evidence simply shows an expired running
    // lease with no deduction evidence. Neither authorizes takeover.
    return freezeResult(
      hasDeductionEvidence ? "stale_with_deduction_evidence" : "stale_no_deduction_evidence"
    );
  }

  if (claim.status === "failed") {
    const hasDeductionEvidence = claim.deductionRecorded || deduction === "present";
    return freezeResult(
      hasDeductionEvidence ? "failed_with_deduction_evidence" : "failed_rearmable"
    );
  }

  // Completed claims require verified completed-result evidence.
  if (completedResult.kind === "not_checked") {
    return freezeResult("operator_review_required");
  }
  if (completedResult.kind === "blocked") {
    switch (completedResult.reason) {
      case "completed_without_result":
        return freezeResult("completed_without_result");
      case "linked_result_missing_or_mismatched":
        return freezeResult("linked_result_invalid");
      case "intent_conflict":
      case "not_completed_or_not_found":
        return freezeResult("integrity_blocked");
    }
  }

  // Replayable: billing consistency must match the established paths —
  // zero-credit finalization carries no deduction evidence; paid renders
  // carry both the ledger row and the durable marker. Non-finite or negative
  // amounts are contradictory evidence, never trusted.
  if (
    typeof completedResult.creditsCharged !== "number" ||
    !Number.isFinite(completedResult.creditsCharged) ||
    completedResult.creditsCharged < 0
  ) {
    return freezeResult("integrity_blocked");
  }
  const zeroCredit = completedResult.creditsCharged === 0;
  const consistent = zeroCredit
    ? !claim.deductionRecorded && deduction === "absent"
    : claim.deductionRecorded && deduction === "present";
  return freezeResult(consistent ? "completed_replayable" : "integrity_blocked");
}
