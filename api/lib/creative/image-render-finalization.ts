import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import { contentPosts, creditTransactions, generatedImages, imageRenderClaims } from "@db/schema";
import {
  deductCredits,
  recordAiUsage,
  type CreditEngineDbExecutor,
} from "../billing/credit-engine";
import {
  buildImageRenderDeductionKey,
  completeImageRenderClaimWithResult,
  failImageRenderClaim,
  getCompletedImageRenderResult,
  markImageRenderDeductionRecorded,
  type CompleteImageRenderClaimWithResultResult,
  type GetCompletedImageRenderResultResult,
  type ImageRenderClaimDbExecutor,
  type ImageRenderDeductionMarkerResult,
  type ImageRenderReplayResult,
  type TransitionImageRenderClaimResult,
} from "./image-render-claim";
import type { ImageRenderReplayResponse } from "./image-render-claim-gate";

// ─── Dormant image-render finalization transaction coordinator (B2B-3C) ───
//
// Owns ONLY the post-render database finalization for one logical premium
// image attempt. Rendering, provider calls, storage writes, affordability
// checks, claim acquisition/rearm, and mode/readiness decisions all happen
// upstream and are represented here as an already-succeeded render/storage
// input. This module is entirely dormant: nothing in the production request
// path imports or invokes it (B2B-3D owns future wiring), and constructing
// the default dependencies performs no database work.
//
// Transaction ownership: exactly one caller-visible transaction per attempt
// (at most two attempts, and only for positively identified deadlock or
// lock-wait-timeout errors). Every transactional write — the generated image
// insert, the content post update, the keyed credit deduction, the
// deduction-recorded marker, the AI-usage row, and the atomic claim
// completion — runs on the SAME transaction executor. The B2B-3B executor
// seams guarantee no primitive opens a nested transaction or escapes to
// getDb().
//
// Failure policy:
//   - definite rollback (validation, insert/update failures, insufficient
//     credits, marker/completion/usage rejection) → no automatic retry; the
//     claim failure transition is attempted ONCE outside the transaction;
//     if that transition itself fails, the claim is left fail-closed for
//     Slice C. No durable pending-finalization record is introduced.
//   - alreadyDeducted during fresh finalization → deliberate rollback and
//     read-only duplicate resolution; only a verified completed result for
//     this exact attempt yields replay, otherwise ambiguous_deduction_blocked.
//   - unknown commit outcome (e.g. lost commit acknowledgement) → NO
//     automatic retry, NO new deduction, NO new render; bounded read-only
//     resolution applies the documented state matrix.
//
// Security: results expose only stable status/reason codes and the safe
// eight-field replay projection. Owner tokens, attempt keys, fingerprints,
// deduction keys, and raw database errors are never returned.

export const IMAGE_RENDER_FINALIZATION_MAX_ATTEMPTS = 2;
export const IMAGE_RENDER_FINALIZATION_MAX_AUTOMATIC_RETRIES = 1;

// ─── Transaction seam ───
//
// The transaction callback client satisfies this shape (MySql2Transaction
// extends the database type). The seam intentionally carries no transaction
// method: this module alone owns transaction lifecycle, and no B2B-3B
// primitive requires one.
export type ImageRenderFinalizationTx = CreditEngineDbExecutor;

export interface ImageRenderFinalizationTxRunner {
  run<T>(fn: (tx: ImageRenderFinalizationTx) => Promise<T>): Promise<T>;
}

// ─── Input contract ───

export interface ImageRenderFinalizationClaimIdentity {
  claimId: number;
  userId: number;
  contentPostId: number;
  ownerToken: string;
  requestAttemptKey: string;
  intentFingerprint: string;
  deductionKey: string;
}

export interface ImageRenderFinalizationInput {
  /** Authoritative claim identity (owner-verified upstream). */
  claim: ImageRenderFinalizationClaimIdentity;
  /** Billing charge for this render; amount 0 selects the zero-credit path. */
  charge: {
    amount: number;
    description: string;
    metadata: Record<string, unknown>;
  };
  /** AI-usage accounting row (financially material; always written). */
  usage: {
    campaignId: number | null;
    agentType: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    actualCostUsdMicro: number;
    estimatedCostUsdMicro: number;
    metadata: Record<string, unknown>;
  };
  /** Immutable replay snapshot fields for claim completion. */
  result: {
    provider: string;
    providerJobId?: string | null;
    imageUrl: string;
    qualityTier: string;
    qualityLabel: string;
    isDraft: boolean;
    completedAt: Date;
  };
  /** generated_images row fields, following the legacy premium-service insert. */
  generatedImage: {
    campaignId: number | null;
    businessId: number | null;
    provider: string;
    providerJobId?: string | null;
    prompt: string;
    url: string;
    aspectRatio: string;
    style: string | null;
    providerCostUsd: number;
    metadata: Record<string, unknown>;
  };
  /**
   * Returns the COMPLETE JSON value to persist into the physical
   * `content_posts.metadata` column — the full merged metadata object
   * (`{ ...currentMeta, ...new image fields }`). It does NOT return top-level
   * content_posts column assignments: the coordinator owns the physical
   * wrapper `{ metadata: <callback result> }`. The callback receives the
   * exact generated_images insertId (`generatedImageId`) and the actually
   * charged credits; storage/rendering are never invoked.
   */
  buildContentPostPatch: (args: {
    generatedImageId: number;
    creditsCharged: number;
  }) => Record<string, unknown>;
}

// ─── Closed result contract ───

export type ImageRenderFinalizationFailedReason =
  | "insufficient_credits"
  | "generated_image_insert_failed"
  | "invalid_generated_image_id"
  | "content_post_update_failed"
  | "deduction_marker_rejected"
  | "ai_usage_record_failed"
  | "claim_completion_rejected"
  | "transaction_rolled_back"
  | "fail_transition_failed"
  | "already_failed_rearmable";

export type ImageRenderFinalizationBlockedReason =
  | "ambiguous_deduction_blocked"
  | "integrity_blocked";

export type ImageRenderFinalizationResult =
  | {
      status: "finalized";
      generatedImageId: number;
      creditsCharged: number;
      newBalance: number | null;
    }
  | { status: "replay"; response: ImageRenderReplayResponse }
  | { status: "failed"; reason: ImageRenderFinalizationFailedReason }
  | { status: "blocked"; reason: ImageRenderFinalizationBlockedReason };

// ─── Dependency contract (production defaults below; tests inject fakes) ───

export interface ImageRenderFinalizationDeps {
  txRunner: ImageRenderFinalizationTxRunner;
  deductCredits: (args: {
    userId: number;
    amount: number;
    type: "image_generation";
    description: string;
    metadata?: Record<string, unknown>;
    idempotencyKey: string;
    executor: CreditEngineDbExecutor;
  }) => Promise<{ newBalance: number; alreadyDeducted?: boolean }>;
  markImageRenderDeductionRecorded: (args: {
    claimId: number;
    userId: number;
    contentPostId: number;
    ownerToken: string;
    requestAttemptKey: string;
    intentFingerprint: string;
    deductionKey: string;
    executor: ImageRenderClaimDbExecutor;
  }) => Promise<ImageRenderDeductionMarkerResult>;
  recordAiUsage: (args: {
    userId: number;
    campaignId?: number;
    agentType: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    actualCostUsdMicro: number;
    estimatedCostUsdMicro: number;
    creditsDeducted: number;
    metadata?: Record<string, unknown>;
    executor: CreditEngineDbExecutor;
  }) => Promise<void>;
  completeImageRenderClaimWithResult: (args: {
    claimId: number;
    ownerToken: string;
    userId: number;
    contentPostId: number;
    requestAttemptKey: string;
    intentFingerprint: string;
    deductionKey: string;
    result: {
      generatedImageId: number;
      imageUrl: string;
      provider: string;
      providerJobId?: string | null;
      creditsCharged: number;
      qualityTier: string;
      qualityLabel: string;
      isDraft: boolean;
      completedAt: Date;
    };
    executor: ImageRenderClaimDbExecutor;
  }) => Promise<CompleteImageRenderClaimWithResultResult>;
  /** Read-only claim status probe for the unknown-commit matrix. */
  lookupClaimState: (args: {
    requestAttemptKey: string;
  }) => Promise<{ status: "running" | "completed" | "failed" } | null>;
  /** Read-only presence probe of the ledger idempotency row. */
  findDeductionRow: (args: { deductionKey: string }) => Promise<boolean>;
  /** Read-only verified completed-result resolver (established primitive). */
  getCompletedImageRenderResult: (args: {
    userId: number;
    contentPostId: number;
    requestAttemptKey: string;
    intentFingerprint: string;
  }) => Promise<GetCompletedImageRenderResultResult>;
  /** Claim failure transition, invoked OUTSIDE the rolled-back transaction. */
  failImageRenderClaim: (args: {
    claimId: number;
    ownerToken: string;
  }) => Promise<TransitionImageRenderClaimResult>;
}

// ─── Internal failure signals (never exposed in results) ───

class ImageRenderFinalizationAlreadyDeducted extends Error {
  constructor() {
    super("deduction key already deducted during fresh finalization");
  }
}

class ImageRenderFinalizationMarkerRejected extends Error {
  constructor() {
    super("deduction marker rejected");
  }
}

class ImageRenderFinalizationCompletionRejected extends Error {
  constructor() {
    super("claim completion rejected");
  }
}

class ImageRenderFinalizationInsertFailed extends Error {
  constructor(cause: unknown) {
    super("generated_images insert failed");
    this.cause = cause;
  }
}

class ImageRenderFinalizationInvalidImageId extends Error {
  constructor() {
    super("generated_images insert did not return a valid insertId");
  }
}

class ImageRenderFinalizationPostUpdateFailed extends Error {
  constructor(cause: unknown) {
    super("content_posts update failed");
    this.cause = cause;
  }
}

class ImageRenderFinalizationUsageFailed extends Error {
  constructor(cause: unknown) {
    super("ai_usage insert failed");
    this.cause = cause;
  }
}

// ─── Input validation (reject before any dependency call) ───

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

function assertValidPositiveId(value: unknown, name: string): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Invalid ${name}: ${String(value)}` });
  }
}

function assertValidNonNegativeInt(value: unknown, name: string): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Invalid ${name}: ${String(value)}` });
  }
}

function assertValidNonEmptyString(value: unknown, name: string, max: number): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Invalid ${name}: must be a non-empty string of at most ${max} characters`,
    });
  }
}

function assertValidOptionalId(value: unknown, name: string): void {
  if (value === null || value === undefined) return;
  assertValidPositiveId(value, name);
}

function assertValidFinalizationInput(input: ImageRenderFinalizationInput): void {
  const { claim, charge, usage, result, generatedImage } = input;
  assertValidPositiveId(claim.claimId, "claimId");
  assertValidPositiveId(claim.userId, "userId");
  assertValidPositiveId(claim.contentPostId, "contentPostId");
  assertValidNonEmptyString(claim.ownerToken, "ownerToken", 64);
  if (typeof claim.requestAttemptKey !== "string" || !SHA256_HEX_PATTERN.test(claim.requestAttemptKey)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid requestAttemptKey: expected 64-character lowercase SHA-256 hex",
    });
  }
  if (typeof claim.intentFingerprint !== "string" || !SHA256_HEX_PATTERN.test(claim.intentFingerprint)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid intentFingerprint: expected 64-character lowercase SHA-256 hex",
    });
  }
  if (
    typeof claim.deductionKey !== "string" ||
    claim.deductionKey.length === 0 ||
    claim.deductionKey.length > 191
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid deductionKey: expected 1-191 characters",
    });
  }
  if (claim.deductionKey !== buildImageRenderDeductionKey(claim.requestAttemptKey)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid deductionKey: does not match the derived attempt identity",
    });
  }

  assertValidNonNegativeInt(charge.amount, "charge.amount");
  assertValidNonEmptyString(charge.description, "charge.description", 2048);

  assertValidOptionalId(usage.campaignId, "usage.campaignId");
  assertValidNonEmptyString(usage.agentType, "usage.agentType", 100);
  assertValidNonEmptyString(usage.model, "usage.model", 100);
  assertValidNonNegativeInt(usage.promptTokens, "usage.promptTokens");
  assertValidNonNegativeInt(usage.completionTokens, "usage.completionTokens");
  assertValidNonNegativeInt(usage.actualCostUsdMicro, "usage.actualCostUsdMicro");
  assertValidNonNegativeInt(usage.estimatedCostUsdMicro, "usage.estimatedCostUsdMicro");

  assertValidNonEmptyString(result.provider, "result.provider", 50);
  if (result.providerJobId != null) {
    assertValidNonEmptyString(result.providerJobId, "result.providerJobId", 255);
  }
  assertValidNonEmptyString(result.imageUrl, "result.imageUrl", 2048);
  assertValidNonEmptyString(result.qualityTier, "result.qualityTier", 50);
  assertValidNonEmptyString(result.qualityLabel, "result.qualityLabel", 2048);
  if (typeof result.isDraft !== "boolean") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid result.isDraft: must be a boolean" });
  }
  if (!(result.completedAt instanceof Date) || Number.isNaN(result.completedAt.getTime())) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid result.completedAt: expected a valid Date",
    });
  }

  assertValidOptionalId(generatedImage.campaignId, "generatedImage.campaignId");
  assertValidOptionalId(generatedImage.businessId, "generatedImage.businessId");
  assertValidNonEmptyString(generatedImage.provider, "generatedImage.provider", 50);
  if (generatedImage.providerJobId != null) {
    assertValidNonEmptyString(generatedImage.providerJobId, "generatedImage.providerJobId", 255);
  }
  assertValidNonEmptyString(generatedImage.prompt, "generatedImage.prompt", 2048);
  assertValidNonEmptyString(generatedImage.url, "generatedImage.url", 2048);
  assertValidNonEmptyString(generatedImage.aspectRatio, "generatedImage.aspectRatio", 10);
  if (generatedImage.style != null && typeof generatedImage.style !== "string") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid generatedImage.style" });
  }
  assertValidNonNegativeInt(generatedImage.providerCostUsd, "generatedImage.providerCostUsd");

  if (typeof input.buildContentPostPatch !== "function") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid buildContentPostPatch: expected a function",
    });
  }
}

// ─── Error classification ───

function walkErrorCauses(
  err: unknown,
  predicate: (record: Record<string, unknown>) => boolean
): boolean {
  const seen = new WeakSet<object>();
  let current: unknown = err;
  let depth = 0;
  while (current && typeof current === "object" && depth < 5) {
    if (seen.has(current)) break;
    seen.add(current);
    if (predicate(current as Record<string, unknown>)) return true;
    current = (current as Record<string, unknown>).cause;
    depth += 1;
  }
  return false;
}

type ImageRenderFinalizationTxErrorClass = "retryable" | "unknown_commit" | "definite";

/**
 * Classifies a failed finalization transaction.
 *  - retryable:   InnoDB deadlock (1213) or lock-wait timeout (1205) — the
 *                 statement rolled back; one bounded retry is permitted.
 *  - unknown_commit: connection-level failure around the commit window; the
 *                 outcome cannot be proven rolled-back, so read-only
 *                 resolution decides (never an automatic retry).
 *  - definite:    everything else — the callback failed and Drizzle executed
 *                 ROLLBACK, so nothing committed.
 */
export function classifyFinalizationTransactionError(
  err: unknown
): ImageRenderFinalizationTxErrorClass {
  if (
    walkErrorCauses(
      err,
      (record) =>
        record.code === "ER_LOCK_DEADLOCK" ||
        record.errno === 1213 ||
        record.code === "ER_LOCK_WAIT_TIMEOUT" ||
        record.errno === 1205
    )
  ) {
    return "retryable";
  }
  if (
    walkErrorCauses(
      err,
      (record) =>
        record.code === "PROTOCOL_CONNECTION_LOST" ||
        record.code === "PROTOCOL_PACKETS_OUT_OF_ORDER" ||
        record.code === "ECONNRESET" ||
        record.code === "EPIPE"
    )
  ) {
    return "unknown_commit";
  }
  return "definite";
}

// ─── Replay projection (same safe shape as the established gate) ───

function toReplayResponse(result: ImageRenderReplayResult): ImageRenderReplayResponse {
  return {
    success: true,
    imageUrl: result.imageUrl,
    provider: result.provider,
    jobId: result.providerJobId || "premium",
    creditsCharged: result.creditsCharged,
    qualityTier: result.qualityTier,
    qualityLabel: result.qualityLabel,
    isDraft: result.isDraft,
  };
}

// ─── Transaction body ───

async function runFinalizationTransaction(
  input: ImageRenderFinalizationInput,
  deps: ImageRenderFinalizationDeps,
  tx: ImageRenderFinalizationTx
): Promise<{ generatedImageId: number; newBalance: number | null }> {
  const { claim, charge, usage, result, generatedImage } = input;
  const creditsCharged = charge.amount;

  // 1. Persist the generated image row (render + storage already succeeded).
  let generatedImageId: number;
  try {
    const [insertHeader] = await tx.insert(generatedImages).values({
      userId: claim.userId,
      campaignId: generatedImage.campaignId,
      businessId: generatedImage.businessId,
      contentPostId: claim.contentPostId,
      provider: generatedImage.provider,
      providerJobId: generatedImage.providerJobId ?? null,
      prompt: generatedImage.prompt,
      url: generatedImage.url,
      aspectRatio: generatedImage.aspectRatio,
      style: generatedImage.style,
      status: "completed",
      creditsCharged,
      providerCostUsd: generatedImage.providerCostUsd,
      metadata: generatedImage.metadata,
    });
    // Exact driver insertId — never a latest-image inference.
    generatedImageId = Number(insertHeader.insertId);
  } catch (err) {
    throw new ImageRenderFinalizationInsertFailed(err);
  }
  if (!Number.isInteger(generatedImageId) || generatedImageId <= 0) {
    throw new ImageRenderFinalizationInvalidImageId();
  }

  // 2. Persist the caller-built metadata payload into the physical
  // content_posts.metadata JSON column. The coordinator owns the
  // `{ metadata: ... }` wrapper; the callback result is never spread as
  // top-level column assignments.
  const contentPostMetadata = input.buildContentPostPatch({
    generatedImageId,
    creditsCharged,
  });
  try {
    await tx
      .update(contentPosts)
      .set({ metadata: contentPostMetadata })
      .where(eq(contentPosts.id, claim.contentPostId));
  } catch (err) {
    throw new ImageRenderFinalizationPostUpdateFailed(err);
  }

  // 3-4. Fresh, keyed credit deduction on the same executor. An existing
  // deduction must never be attached to this newly rendered result.
  let deductionNewBalance: number | null = null;
  if (creditsCharged > 0) {
    const deduction = await deps.deductCredits({
      userId: claim.userId,
      amount: creditsCharged,
      type: "image_generation",
      description: charge.description,
      metadata: charge.metadata,
      idempotencyKey: claim.deductionKey,
      executor: tx,
    });
    if (deduction.alreadyDeducted === true) {
      throw new ImageRenderFinalizationAlreadyDeducted();
    }
    deductionNewBalance = deduction.newBalance;

    // 5. Deduction marker only after a fresh deduction is confirmed.
    const marker = await deps.markImageRenderDeductionRecorded({
      claimId: claim.claimId,
      userId: claim.userId,
      contentPostId: claim.contentPostId,
      ownerToken: claim.ownerToken,
      requestAttemptKey: claim.requestAttemptKey,
      intentFingerprint: claim.intentFingerprint,
      deductionKey: claim.deductionKey,
      executor: tx,
    });
    if (marker.recorded !== true) {
      throw new ImageRenderFinalizationMarkerRejected();
    }
  }

  // 6. AI-usage accounting (financially material; inside the transaction even
  // for zero-credit renders, with creditsDeducted: 0).
  try {
    await deps.recordAiUsage({
      userId: claim.userId,
      campaignId: usage.campaignId ?? undefined,
      agentType: usage.agentType,
      model: usage.model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      actualCostUsdMicro: usage.actualCostUsdMicro,
      estimatedCostUsdMicro: usage.estimatedCostUsdMicro,
      creditsDeducted: creditsCharged,
      metadata: usage.metadata,
      executor: tx,
    });
  } catch (err) {
    throw new ImageRenderFinalizationUsageFailed(err);
  }

  // 7. Atomic claim completion with the exact durable result snapshot.
  const completion = await deps.completeImageRenderClaimWithResult({
    claimId: claim.claimId,
    ownerToken: claim.ownerToken,
    userId: claim.userId,
    contentPostId: claim.contentPostId,
    requestAttemptKey: claim.requestAttemptKey,
    intentFingerprint: claim.intentFingerprint,
    deductionKey: claim.deductionKey,
    result: {
      generatedImageId,
      imageUrl: result.imageUrl,
      provider: result.provider,
      providerJobId: result.providerJobId ?? null,
      creditsCharged,
      qualityTier: result.qualityTier,
      qualityLabel: result.qualityLabel,
      isDraft: result.isDraft,
      completedAt: result.completedAt,
    },
    executor: tx,
  });
  if (completion.completed !== true) {
    throw new ImageRenderFinalizationCompletionRejected();
  }

  return { generatedImageId, newBalance: deductionNewBalance };
}

// ─── Read-only resolution paths ───

async function tryResolveCompletedReplay(
  input: ImageRenderFinalizationInput,
  deps: ImageRenderFinalizationDeps
): Promise<ImageRenderReplayResponse | null> {
  try {
    const completed = await deps.getCompletedImageRenderResult({
      userId: input.claim.userId,
      contentPostId: input.claim.contentPostId,
      requestAttemptKey: input.claim.requestAttemptKey,
      intentFingerprint: input.claim.intentFingerprint,
    });
    if (completed.replayable) {
      return toReplayResponse(completed.result);
    }
    return null;
  } catch {
    return null;
  }
}

/** alreadyDeducted during fresh finalization: rollback, resolve read-only. */
async function resolveAlreadyDeducted(
  input: ImageRenderFinalizationInput,
  deps: ImageRenderFinalizationDeps
): Promise<ImageRenderFinalizationResult> {
  const replay = await tryResolveCompletedReplay(input, deps);
  if (replay) {
    return { status: "replay", response: replay };
  }
  return { status: "blocked", reason: "ambiguous_deduction_blocked" };
}

/** Definite rollback: fail the claim once outside the transaction. */
async function handleDefiniteRollback(
  input: ImageRenderFinalizationInput,
  deps: ImageRenderFinalizationDeps,
  err: unknown
): Promise<ImageRenderFinalizationResult> {
  let reason: ImageRenderFinalizationFailedReason = "transaction_rolled_back";
  if (err instanceof TRPCError && err.code === "PAYMENT_REQUIRED") {
    reason = "insufficient_credits";
  } else if (err instanceof ImageRenderFinalizationInsertFailed) {
    reason = "generated_image_insert_failed";
  } else if (err instanceof ImageRenderFinalizationInvalidImageId) {
    reason = "invalid_generated_image_id";
  } else if (err instanceof ImageRenderFinalizationPostUpdateFailed) {
    reason = "content_post_update_failed";
  } else if (err instanceof ImageRenderFinalizationMarkerRejected) {
    reason = "deduction_marker_rejected";
  } else if (err instanceof ImageRenderFinalizationUsageFailed) {
    reason = "ai_usage_record_failed";
  } else if (err instanceof ImageRenderFinalizationCompletionRejected) {
    reason = "claim_completion_rejected";
  }

  try {
    await deps.failImageRenderClaim({
      claimId: input.claim.claimId,
      ownerToken: input.claim.ownerToken,
    });
  } catch {
    // The failure transition itself failed: no further mutation, fail closed.
    return { status: "failed", reason: "fail_transition_failed" };
  }
  return { status: "failed", reason };
}

/** Unknown commit outcome: bounded read-only resolution; never a retry. */
async function resolveUnknownCommitOutcome(
  input: ImageRenderFinalizationInput,
  deps: ImageRenderFinalizationDeps
): Promise<ImageRenderFinalizationResult> {
  let claim: { status: "running" | "completed" | "failed" } | null = null;
  let deductionPresent = false;
  try {
    claim = await deps.lookupClaimState({
      requestAttemptKey: input.claim.requestAttemptKey,
    });
    deductionPresent = await deps.findDeductionRow({
      deductionKey: input.claim.deductionKey,
    });
  } catch {
    // Read-only resolution itself failed: fail closed with zero mutation.
    return { status: "blocked", reason: "integrity_blocked" };
  }
  if (!claim) {
    return { status: "blocked", reason: "integrity_blocked" };
  }

  if (claim.status === "completed") {
    const replay = await tryResolveCompletedReplay(input, deps);
    return replay
      ? { status: "replay", response: replay }
      : { status: "blocked", reason: "integrity_blocked" };
  }
  if (claim.status === "running") {
    if (deductionPresent) {
      return { status: "blocked", reason: "ambiguous_deduction_blocked" };
    }
    // The transaction did not commit; normal safe failure handling applies.
    return handleDefiniteRollback(input, deps, new Error("uncommitted"));
  }
  // failed
  if (deductionPresent) {
    return { status: "blocked", reason: "ambiguous_deduction_blocked" };
  }
  return { status: "failed", reason: "already_failed_rearmable" };
}

// ─── Coordinator ───

/**
 * Dormant post-render finalization coordinator. Validates input, then runs
 * the bounded finalization transaction (at most two attempts, retrying only
 * positively identified deadlock/lock-wait-timeout errors), and classifies
 * every outcome per the documented failure policy. Never throws raw database
 * errors to callers.
 */
export async function finalizeImageRenderAttempt(
  input: ImageRenderFinalizationInput,
  deps: ImageRenderFinalizationDeps
): Promise<ImageRenderFinalizationResult> {
  assertValidFinalizationInput(input);
  const creditsCharged = input.charge.amount;

  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      const outcome = await deps.txRunner.run((tx) =>
        runFinalizationTransaction(input, deps, tx)
      );
      return {
        status: "finalized",
        generatedImageId: outcome.generatedImageId,
        creditsCharged,
        newBalance: outcome.newBalance,
      };
    } catch (err) {
      if (err instanceof ImageRenderFinalizationAlreadyDeducted) {
        return resolveAlreadyDeducted(input, deps);
      }
      const errorClass = classifyFinalizationTransactionError(err);
      if (
        errorClass === "retryable" &&
        attempts < IMAGE_RENDER_FINALIZATION_MAX_ATTEMPTS
      ) {
        continue; // one bounded transaction retry; no provider/render repeat
      }
      if (errorClass === "unknown_commit") {
        return resolveUnknownCommitOutcome(input, deps);
      }
      return handleDefiniteRollback(input, deps, err);
    }
  }
}

// ─── Production defaults (dormant: nothing constructs these yet) ───

export function createDefaultImageRenderFinalizationDeps(): ImageRenderFinalizationDeps {
  return {
    txRunner: {
      run: (fn) => getDb().transaction(async (tx) => fn(tx)),
    },
    deductCredits: (args) => deductCredits(args),
    markImageRenderDeductionRecorded: (args) => markImageRenderDeductionRecorded(args),
    recordAiUsage: (args) => recordAiUsage(args),
    completeImageRenderClaimWithResult: (args) =>
      completeImageRenderClaimWithResult(args),
    getCompletedImageRenderResult: (args) => getCompletedImageRenderResult(args),
    failImageRenderClaim: (args) => failImageRenderClaim(args),
    lookupClaimState: async ({ requestAttemptKey }) => {
      const [row] = await getDb()
        .select({ status: imageRenderClaims.status })
        .from(imageRenderClaims)
        .where(eq(imageRenderClaims.requestAttemptKey, requestAttemptKey))
        .limit(1);
      return row ?? null;
    },
    findDeductionRow: async ({ deductionKey }) => {
      const [row] = await getDb()
        .select({ id: creditTransactions.id })
        .from(creditTransactions)
        .where(eq(creditTransactions.idempotencyKey, deductionKey))
        .limit(1);
      return row !== undefined;
    },
  };
}
