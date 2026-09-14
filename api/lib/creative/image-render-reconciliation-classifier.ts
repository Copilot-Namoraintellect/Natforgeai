// ─── Dormant image-render operator reconciliation classifier (Slice C4A) ───
//
// PURE evidence classifier for operator review. It receives an upstream C2
// classification (as a normalized string — the C2 module is never imported)
// plus normalized authoritative evidence dimensions, and returns a closed,
// deterministic classification. It performs no I/O, has zero imports,
// authorizes nothing, and recommends nothing: no billing action, no claim
// transition, no result attachment, no post edit, no rerender. Every result
// carries mutationAuthorized: false and never echoes keys, ids, tokens or
// URLs.

export type UpstreamRecoveryClassification =
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

export type GeneratedImageEvidence =
  | { readonly kind: "not_checked" }
  | { readonly kind: "lookup_failed" }
  | { readonly kind: "absent" }
  | {
      readonly kind: "present";
      readonly matchesClaimGeneratedImageId: boolean;
      readonly matchesUser: boolean;
      readonly matchesContentPost: boolean;
      readonly matchesClaimSnapshot: boolean;
    };

export type ContentPostEvidence =
  | { readonly kind: "not_checked" }
  | { readonly kind: "lookup_failed" }
  | { readonly kind: "matches_generated_image" }
  | { readonly kind: "no_generated_image_link" }
  | { readonly kind: "mismatch" };

export type DeductionConsistencyEvidence =
  | { readonly kind: "not_checked" }
  | { readonly kind: "lookup_failed" }
  | { readonly kind: "absent" }
  | {
      readonly kind: "present";
      readonly exactAttemptKeyMatch: boolean;
      readonly expectedCreditsMatch: boolean | "unknown";
    };

export type UsageObservation =
  | "not_checked"
  | "present"
  | "absent"
  | "lookup_failed";

export interface ImageRenderReconciliationEvidence {
  readonly upstream: UpstreamRecoveryClassification;
  readonly resultCreditsCharged: number | null;
  readonly generatedImage: GeneratedImageEvidence;
  readonly contentPost: ContentPostEvidence;
  readonly deduction: DeductionConsistencyEvidence;
  /** Informational only. Never authoritative. Never affects classification. */
  readonly usageObservation: UsageObservation;
}

export type ImageRenderReconciliationClassification =
  | "live_attempt_no_action"
  | "pre_deduction_state_outside_c4"
  | "verified_committed_success"
  | "active_claim_with_deduction_evidence"
  | "blocked_claim_with_deduction_evidence"
  | "deduction_without_verified_result"
  | "verified_result_without_expected_deduction"
  | "claim_result_linkage_mismatch"
  | "content_post_linkage_mismatch"
  | "authoritative_evidence_unavailable"
  | "integrity_review_required";

export interface ImageRenderReconciliationResult {
  readonly classification: ImageRenderReconciliationClassification;
  readonly operatorReviewRequired: boolean;
  readonly mutationAuthorized: false;
}

const UPSTREAM_VALUES = new Set<string>([
  "healthy_running",
  "completed_replayable",
  "failed_rearmable",
  "stale_no_deduction_evidence",
  "stale_with_deduction_evidence",
  "running_with_deduction_evidence",
  "failed_with_deduction_evidence",
  "completed_without_result",
  "linked_result_invalid",
  "integrity_blocked",
  "operator_review_required",
]);
const GENERATED_IMAGE_KINDS = new Set(["not_checked", "lookup_failed", "absent", "present"]);
const CONTENT_POST_KINDS = new Set([
  "not_checked",
  "lookup_failed",
  "matches_generated_image",
  "no_generated_image_link",
  "mismatch",
]);
const DEDUCTION_KINDS = new Set(["not_checked", "lookup_failed", "absent", "present"]);
const USAGE_VALUES = new Set(["not_checked", "present", "absent", "lookup_failed"]);

function fail(message: string): never {
  throw new TypeError(message);
}

function assertEvidenceShape(evidence: ImageRenderReconciliationEvidence): void {
  if (!evidence || typeof evidence !== "object") {
    fail("Invalid reconciliation evidence: expected an object");
  }
  if (!UPSTREAM_VALUES.has(evidence.upstream as string)) {
    fail("Invalid reconciliation evidence: unknown upstream classification");
  }
  if (
    evidence.resultCreditsCharged !== null &&
    typeof evidence.resultCreditsCharged !== "number"
  ) {
    fail("Invalid reconciliation evidence: resultCreditsCharged must be a number or null");
  }
  const image = evidence.generatedImage;
  if (!image || typeof image !== "object" || !GENERATED_IMAGE_KINDS.has(image.kind as string)) {
    fail("Invalid reconciliation evidence: malformed generated-image evidence");
  }
  if (image.kind === "present") {
    for (const flag of [
      "matchesClaimGeneratedImageId",
      "matchesUser",
      "matchesContentPost",
      "matchesClaimSnapshot",
    ] as const) {
      if (typeof image[flag] !== "boolean") {
        fail("Invalid reconciliation evidence: generated-image match flags must be booleans");
      }
    }
  }
  const post = evidence.contentPost;
  if (!post || typeof post !== "object" || !CONTENT_POST_KINDS.has(post.kind as string)) {
    fail("Invalid reconciliation evidence: malformed content-post evidence");
  }
  const deduction = evidence.deduction;
  if (!deduction || typeof deduction !== "object" || !DEDUCTION_KINDS.has(deduction.kind as string)) {
    fail("Invalid reconciliation evidence: malformed deduction evidence");
  }
  if (deduction.kind === "present") {
    if (typeof deduction.exactAttemptKeyMatch !== "boolean") {
      fail("Invalid reconciliation evidence: malformed deduction evidence");
    }
    if (
      typeof deduction.expectedCreditsMatch !== "boolean" &&
      deduction.expectedCreditsMatch !== "unknown"
    ) {
      fail("Invalid reconciliation evidence: malformed deduction evidence");
    }
  }
  if (!USAGE_VALUES.has(evidence.usageObservation as string)) {
    fail("Invalid reconciliation evidence: malformed usage observation");
  }
}

function freezeResult(
  classification: ImageRenderReconciliationClassification,
  operatorReviewRequired: boolean
): ImageRenderReconciliationResult {
  return Object.freeze({ classification, operatorReviewRequired, mutationAuthorized: false });
}

function generatedImageMismatch(image: Extract<GeneratedImageEvidence, { kind: "present" }>): boolean {
  return (
    !image.matchesClaimGeneratedImageId ||
    !image.matchesUser ||
    !image.matchesContentPost ||
    !image.matchesClaimSnapshot
  );
}

/** Narrowest evidence-based classification for generic blocked upstream states. */
function narrowFromAuthoritativeEvidence(
  evidence: ImageRenderReconciliationEvidence
): ImageRenderReconciliationResult {
  const { generatedImage, contentPost, deduction, resultCreditsCharged } = evidence;
  if (generatedImage.kind === "present" && generatedImageMismatch(generatedImage)) {
    return freezeResult("claim_result_linkage_mismatch", true);
  }
  if (
    generatedImage.kind === "present" &&
    !generatedImageMismatch(generatedImage) &&
    (contentPost.kind === "mismatch" || contentPost.kind === "no_generated_image_link")
  ) {
    return freezeResult("content_post_linkage_mismatch", true);
  }
  if (deduction.kind === "present") {
    if (
      generatedImage.kind === "absent" ||
      generatedImage.kind === "not_checked" ||
      contentPost.kind !== "matches_generated_image"
    ) {
      return freezeResult("deduction_without_verified_result", true);
    }
    if (
      typeof resultCreditsCharged === "number" &&
      Number.isFinite(resultCreditsCharged) &&
      resultCreditsCharged > 0 &&
      deduction.expectedCreditsMatch === true
    ) {
      return freezeResult("verified_committed_success", false);
    }
  }
  if (
    typeof resultCreditsCharged === "number" &&
    Number.isFinite(resultCreditsCharged) &&
    resultCreditsCharged > 0 &&
    generatedImage.kind === "present" &&
    !generatedImageMismatch(generatedImage) &&
    contentPost.kind === "matches_generated_image" &&
    deduction.kind === "absent"
  ) {
    return freezeResult("verified_result_without_expected_deduction", true);
  }
  return freezeResult("integrity_review_required", true);
}

function classifyCompletedReplayable(
  evidence: ImageRenderReconciliationEvidence
): ImageRenderReconciliationResult {
  const { generatedImage, contentPost, deduction, resultCreditsCharged } = evidence;

  if (generatedImage.kind === "not_checked" || generatedImage.kind === "lookup_failed") {
    // A replayable upstream claim asserted a verified result; without
    // authoritative image evidence it cannot be re-verified here.
    return freezeResult("integrity_review_required", true);
  }
  if (generatedImage.kind === "absent") {
    if (deduction.kind === "present") {
      return freezeResult("deduction_without_verified_result", true);
    }
    return freezeResult("integrity_review_required", true);
  }
  if (generatedImageMismatch(generatedImage)) {
    return freezeResult("claim_result_linkage_mismatch", true);
  }
  if (contentPost.kind === "mismatch" || contentPost.kind === "no_generated_image_link") {
    return freezeResult("content_post_linkage_mismatch", true);
  }
  if (contentPost.kind !== "matches_generated_image") {
    return freezeResult("integrity_review_required", true);
  }
  if (
    typeof resultCreditsCharged !== "number" ||
    !Number.isFinite(resultCreditsCharged) ||
    resultCreditsCharged < 0
  ) {
    return freezeResult("integrity_review_required", true);
  }
  if (resultCreditsCharged === 0) {
    // Zero-credit finalization carries no deduction evidence.
    return deduction.kind === "absent"
      ? freezeResult("verified_committed_success", false)
      : freezeResult("integrity_review_required", true);
  }
  // Paid render: exact attempt deduction must be present with the expected
  // amount. Absence of the ledger row is a review state, never a charge.
  if (deduction.kind === "absent") {
    return freezeResult("verified_result_without_expected_deduction", true);
  }
  if (deduction.kind !== "present") {
    return freezeResult("integrity_review_required", true);
  }
  return deduction.expectedCreditsMatch === true
    ? freezeResult("verified_committed_success", false)
    : freezeResult("integrity_review_required", true);
}

/**
 * Deterministic, fail-closed operator reconciliation classification.
 * Precedence: authoritative lookup failures → deterministic contradictions →
 * upstream-specific mappings → narrowest evidence-based classification.
 * Usage observation is validated but can never affect the outcome.
 */
export function classifyImageRenderReconciliation(
  evidence: ImageRenderReconciliationEvidence
): ImageRenderReconciliationResult {
  assertEvidenceShape(evidence);
  const { upstream, generatedImage, contentPost, deduction, resultCreditsCharged } = evidence;

  // 1. Authoritative lookup failures: never guess. Usage lookup failure is
  // not authoritative and is deliberately excluded here.
  if (
    generatedImage.kind === "lookup_failed" ||
    contentPost.kind === "lookup_failed" ||
    deduction.kind === "lookup_failed"
  ) {
    return freezeResult("authoritative_evidence_unavailable", true);
  }

  // Input contradictions (valid-union but impossible) fail closed.
  if (
    typeof resultCreditsCharged === "number" &&
    (!Number.isFinite(resultCreditsCharged) || resultCreditsCharged < 0)
  ) {
    return freezeResult("integrity_review_required", true);
  }
  if (deduction.kind === "present" && deduction.exactAttemptKeyMatch !== true) {
    // A collector may only assert a deduction row via the exact deterministic
    // attempt key; anything else is a structural contradiction.
    return freezeResult("integrity_review_required", true);
  }

  // 2. Existing safe non-C4 states.
  if (upstream === "healthy_running") {
    return freezeResult("live_attempt_no_action", false);
  }
  if (upstream === "failed_rearmable" || upstream === "stale_no_deduction_evidence") {
    return freezeResult("pre_deduction_state_outside_c4", false);
  }

  // 3/4. Deduction evidence on active or blocked claims.
  if (upstream === "running_with_deduction_evidence") {
    return freezeResult("active_claim_with_deduction_evidence", true);
  }
  if (
    upstream === "stale_with_deduction_evidence" ||
    upstream === "failed_with_deduction_evidence"
  ) {
    return freezeResult("blocked_claim_with_deduction_evidence", true);
  }

  // 5-9. Completed-result reasoning.
  if (upstream === "completed_replayable") {
    return classifyCompletedReplayable(evidence);
  }
  if (upstream === "completed_without_result") {
    return deduction.kind === "present"
      ? freezeResult("deduction_without_verified_result", true)
      : freezeResult("integrity_review_required", true);
  }
  if (upstream === "linked_result_invalid") {
    if (generatedImage.kind === "present" && generatedImageMismatch(generatedImage)) {
      return freezeResult("claim_result_linkage_mismatch", true);
    }
    return freezeResult("integrity_review_required", true);
  }

  // 10/11. Generic blocked upstream states: narrowest safe classification.
  return narrowFromAuthoritativeEvidence(evidence);
}
