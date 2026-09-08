import { createHash } from "crypto";
import { TRPCError } from "@trpc/server";
import { eq, and, isNotNull, isNull, SQL } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import { imageRenderClaims } from "@db/schema";
import { isMySqlDuplicateKeyError } from "../billing/credit-engine";

export const IMAGE_RENDER_OPERATION_KIND = "premium_image" as const;

const CLIENT_ATTEMPT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export type ImageRenderClaim = typeof imageRenderClaims.$inferSelect;

export type ImageRenderClaimStatus = "running" | "completed" | "failed";

export interface ImageRenderClaimAcquisition {
  acquired: true;
  claim: ImageRenderClaim;
}

export interface ImageRenderClaimConflict {
  acquired: false;
  existingClaim: ImageRenderClaim;
  reason: "active_claim_conflict" | "stale_claim_conflict";
}

export type AcquireImageRenderClaimResult =
  | ImageRenderClaimAcquisition
  | ImageRenderClaimConflict;

export interface ImageRenderClaimTerminalSuccess {
  transitioned: true;
  claim: ImageRenderClaim;
}

export interface ImageRenderClaimTerminalFailure {
  transitioned: false;
  reason: "not_found_or_unauthorized";
}

export type TransitionImageRenderClaimResult =
  | ImageRenderClaimTerminalSuccess
  | ImageRenderClaimTerminalFailure;

function assertValidId(value: unknown, name: string): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Invalid ${name}: ${String(value)}`,
    });
  }
}

function assertValidOwnerToken(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 64
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid ownerToken: must be 1-64 characters",
    });
  }
}

function assertValidLeaseExpiry(
  value: unknown
): asserts value is Date | SQL {
  if (value instanceof SQL) {
    return;
  }
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid leaseExpiresAt: expected Date or SQL",
    });
  }
}

function getAffectedRows(result: unknown): number {
  return Number((result as any)?.[0]?.affectedRows ?? 0);
}

export function buildActiveImageRenderClaimKey({
  userId,
  contentPostId,
}: {
  userId: number;
  contentPostId: number;
}): string {
  assertValidId(userId, "userId");
  assertValidId(contentPostId, "contentPostId");
  return `active:${userId}:post:${contentPostId}:image`;
}

// ─── Dormant request-attempt identity (B1) ───
//
// These builders derive the Slice B2 attempt identity. They are pure and
// deterministic; no credit-engine calls are made here. Raw client tokens,
// refinement text and creative guidance are never persisted or logged — only
// scoped SHA-256 digests. B2b must require the full identity set on every
// activated acquisition; B1 remains dormant with zero production callers.

function assertValidClientAttemptId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !CLIENT_ATTEMPT_ID_PATTERN.test(value)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Invalid clientAttemptId: must be 1-64 characters of [A-Za-z0-9_-]",
    });
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeys(obj[key]);
    }
    return sorted;
  }
  return value;
}

function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function normalizeOptionalText(value: string | null | undefined): string {
  return (value ?? "").trim();
}

export interface ImageRenderAttemptIdentityInput {
  clientAttemptId: string;
  regenerate?: boolean;
  forceRegenerate?: boolean;
  refinementInstruction?: string | null;
  creativeGuidance?: string | null;
  strongerBrandFit?: boolean;
  provider?: string | null;
  templateId?: string | null;
}

export interface ImageRenderAttemptIdentity {
  requestAttemptKey: string;
  intentFingerprint: string;
  deductionKey: string;
}

/**
 * Derives the full dormant attempt identity for one logical user action.
 * requestAttemptKey intentionally excludes intent so that intent reuse with
 * the same token is detectable as a collision instead of a new attempt.
 */
export function deriveImageRenderAttemptIdentity({
  userId,
  contentPostId,
  attempt,
}: {
  userId: number;
  contentPostId: number;
  attempt: ImageRenderAttemptIdentityInput;
}): ImageRenderAttemptIdentity {
  assertValidId(userId, "userId");
  assertValidId(contentPostId, "contentPostId");
  assertValidClientAttemptId(attempt.clientAttemptId);

  const refinementInstruction = normalizeOptionalText(
    attempt.refinementInstruction
  );
  const creativeGuidance = normalizeOptionalText(attempt.creativeGuidance);

  const requestAttemptKey = sha256Hex(
    canonicalize({
      userId,
      contentPostId,
      clientAttemptId: attempt.clientAttemptId,
      operationKind: IMAGE_RENDER_OPERATION_KIND,
    })
  );

  const intentFingerprint = sha256Hex(
    canonicalize({
      regenerate: attempt.regenerate === true,
      forceRegenerate: attempt.forceRegenerate === true,
      refinementInstructionHash: sha256Hex(refinementInstruction),
      creativeGuidanceHash: sha256Hex(creativeGuidance),
      strongerBrandFit: attempt.strongerBrandFit === true,
      provider: normalizeOptionalText(attempt.provider) || "v2",
      templateId: normalizeOptionalText(attempt.templateId) || "auto",
    })
  );

  return {
    requestAttemptKey,
    intentFingerprint,
    deductionKey: buildImageRenderDeductionKey(requestAttemptKey),
  };
}

export function buildImageRenderDeductionKey(
  requestAttemptKey: string
): string {
  return `img-deduction:${requestAttemptKey}`;
}

export function buildImageRenderRefundKey(requestAttemptKey: string): string {
  return `img-refund:${requestAttemptKey}`;
}

async function findClaimByActiveKey(
  activeClaimKey: string
): Promise<ImageRenderClaim | null> {
  const db = getDb();
  const [claim] = await db
    .select()
    .from(imageRenderClaims)
    .where(eq(imageRenderClaims.activeClaimKey, activeClaimKey))
    .limit(1);
  return claim ?? null;
}

async function findClaimById(claimId: number): Promise<ImageRenderClaim | null> {
  const db = getDb();
  const [claim] = await db
    .select()
    .from(imageRenderClaims)
    .where(eq(imageRenderClaims.id, claimId))
    .limit(1);
  return claim ?? null;
}

function isRunningWithUnexpiredLease(claim: ImageRenderClaim): boolean {
  if (claim.status !== "running" || claim.activeClaimKey === null) {
    return false;
  }
  if (!(claim.leaseExpiresAt instanceof Date)) {
    return false;
  }
  return claim.leaseExpiresAt.getTime() > Date.now();
}

/**
 * Acquires the dormant image-render claim primitive.
 *
 * Security precondition: the caller must authoritatively verify that
 * contentPostId belongs to userId before invoking this function. This
 * primitive does not perform that ownership lookup. Production activation
 * is forbidden until the user-scoped ownership lookup is wired and tested.
 *
 * `identity` is optional and all-or-none: when supplied it must be the full
 * attempt identity (every field of ImageRenderAttemptIdentityInput), and the
 * derived request-attempt columns are written with the row. Dormant legacy
 * acquisitions omit it and leave the identity columns null. Slice B2b must
 * require the full identity set for every activated acquisition.
 */
export async function acquireImageRenderClaim({
  userId,
  contentPostId,
  ownerToken,
  leaseExpiresAt,
  identity,
}: {
  userId: number;
  contentPostId: number;
  ownerToken: string;
  leaseExpiresAt: Date | SQL;
  identity?: ImageRenderAttemptIdentityInput;
}): Promise<AcquireImageRenderClaimResult> {
  assertValidId(userId, "userId");
  assertValidId(contentPostId, "contentPostId");
  assertValidOwnerToken(ownerToken);
  assertValidLeaseExpiry(leaseExpiresAt);

  const attemptIdentity = identity
    ? deriveImageRenderAttemptIdentity({ userId, contentPostId, attempt: identity })
    : null;

  const activeClaimKey = buildActiveImageRenderClaimKey({ userId, contentPostId });
  const db = getDb();

  // A duplicate-key error can race with a concurrent release (the winner's
  // terminal transition clears the active key between our failed insert and
  // our lookup). Retry the insert once so a freed slot is claimed instead of
  // misreported. Stale claims are never mutated or taken over here.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const [inserted] = await db.insert(imageRenderClaims).values({
        userId,
        contentPostId,
        activeClaimKey,
        ownerToken,
        status: "running",
        leaseExpiresAt,
        ...(attemptIdentity
          ? {
              requestAttemptKey: attemptIdentity.requestAttemptKey,
              intentFingerprint: attemptIdentity.intentFingerprint,
              deductionKey: attemptIdentity.deductionKey,
              deductionRecorded: false,
            }
          : {}),
      });

      const claimId = Number((inserted as any).insertId);
      const claim = await findClaimById(claimId);
      if (!claim) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Image render claim was inserted but could not be read back",
        });
      }

      return { acquired: true, claim };
    } catch (err: unknown) {
      if (!isMySqlDuplicateKeyError(err)) {
        throw err;
      }
    }

    const existingClaim = await findClaimByActiveKey(activeClaimKey);
    if (existingClaim) {
      return {
        acquired: false,
        existingClaim,
        reason: isRunningWithUnexpiredLease(existingClaim)
          ? "active_claim_conflict"
          : "stale_claim_conflict",
      };
    }
    // Key was freed between insert and lookup: loop once and retry the insert.
  }

  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message:
      "Image render claim collision detected but the existing claim could not be located",
  });
}

export async function completeImageRenderClaim({
  claimId,
  ownerToken,
}: {
  claimId: number;
  ownerToken: string;
}): Promise<TransitionImageRenderClaimResult> {
  return transitionImageRenderClaim({ claimId, ownerToken, status: "completed" });
}

export async function failImageRenderClaim({
  claimId,
  ownerToken,
}: {
  claimId: number;
  ownerToken: string;
}): Promise<TransitionImageRenderClaimResult> {
  return transitionImageRenderClaim({ claimId, ownerToken, status: "failed" });
}

async function transitionImageRenderClaim({
  claimId,
  ownerToken,
  status,
}: {
  claimId: number;
  ownerToken: string;
  status: Exclude<ImageRenderClaimStatus, "running">;
}): Promise<TransitionImageRenderClaimResult> {
  assertValidId(claimId, "claimId");
  assertValidOwnerToken(ownerToken);

  const db = getDb();
  const result = await db
    .update(imageRenderClaims)
    .set({
      status,
      activeClaimKey: null,
    })
    .where(
      and(
        eq(imageRenderClaims.id, claimId),
        eq(imageRenderClaims.ownerToken, ownerToken),
        eq(imageRenderClaims.status, "running"),
        isNotNull(imageRenderClaims.activeClaimKey)
      )
    );

  if (getAffectedRows(result) !== 1) {
    return { transitioned: false, reason: "not_found_or_unauthorized" };
  }

  const claim = await findClaimById(claimId);
  if (!claim) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Image render claim transitioned but could not be read back",
    });
  }

  return { transitioned: true, claim };
}

export async function getActiveImageRenderClaim({
  userId,
  contentPostId,
}: {
  userId: number;
  contentPostId: number;
}): Promise<ImageRenderClaim | null> {
  assertValidId(userId, "userId");
  assertValidId(contentPostId, "contentPostId");

  const activeClaimKey = buildActiveImageRenderClaimKey({ userId, contentPostId });
  const db = getDb();
  const [claim] = await db
    .select()
    .from(imageRenderClaims)
    .where(
      and(
        eq(imageRenderClaims.activeClaimKey, activeClaimKey),
        eq(imageRenderClaims.status, "running")
      )
    )
    .limit(1);

  return claim ?? null;
}

// ─── Dormant request-attempt lookup (B1) ───
//
// Read-only classification of one logical attempt by its requestAttemptKey.
// The public result never includes ownerToken and never mutates rows.

export type ImageRenderAttemptIntentComparison = "match" | "conflict" | "unknown";
export type ImageRenderAttemptLeaseState = "active" | "stale" | "none";

export interface ImageRenderAttemptLookup {
  found: boolean;
  claimId?: number;
  userId?: number;
  contentPostId?: number;
  status?: ImageRenderClaimStatus;
  intentFingerprint?: string | null;
  intentComparison?: ImageRenderAttemptIntentComparison;
  deductionKey?: string | null;
  deductionRecorded?: boolean;
  activeClaimKeyPresent?: boolean;
  leaseState?: ImageRenderAttemptLeaseState;
}

async function findClaimByRequestAttemptKey(
  requestAttemptKey: string
): Promise<ImageRenderClaim | null> {
  const db = getDb();
  const [claim] = await db
    .select()
    .from(imageRenderClaims)
    .where(eq(imageRenderClaims.requestAttemptKey, requestAttemptKey))
    .limit(1);
  return claim ?? null;
}

export async function lookupImageRenderAttempt({
  requestAttemptKey,
  expectedIntentFingerprint,
}: {
  requestAttemptKey: string;
  expectedIntentFingerprint?: string;
}): Promise<ImageRenderAttemptLookup> {
  if (typeof requestAttemptKey !== "string" || !/^[0-9a-f]{64}$/.test(requestAttemptKey)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid requestAttemptKey: expected 64-character lowercase SHA-256 hex",
    });
  }

  const claim = await findClaimByRequestAttemptKey(requestAttemptKey);
  if (!claim) {
    return { found: false };
  }

  const activeClaimKeyPresent = claim.activeClaimKey !== null;
  let leaseState: ImageRenderAttemptLeaseState = "none";
  if (claim.status === "running" && claim.leaseExpiresAt instanceof Date) {
    leaseState =
      claim.leaseExpiresAt.getTime() > Date.now() ? "active" : "stale";
  }

  let intentComparison: ImageRenderAttemptIntentComparison = "unknown";
  if (typeof expectedIntentFingerprint === "string") {
    intentComparison =
      claim.intentFingerprint === expectedIntentFingerprint ? "match" : "conflict";
  }

  return {
    found: true,
    claimId: claim.id,
    userId: claim.userId,
    contentPostId: claim.contentPostId,
    status: claim.status,
    intentFingerprint: claim.intentFingerprint,
    intentComparison,
    deductionKey: claim.deductionKey,
    deductionRecorded: claim.deductionRecorded,
    activeClaimKeyPresent,
    leaseState,
  };
}

// ─── Dormant failed-pre-deduction rearm (B1) ───
//
// Atomically transitions the single logical-attempt row failed → running so a
// pre-deduction retry reuses the same claim id and deduction key. The claim
// id, requestAttemptKey, intentFingerprint, deductionKey and createdAt are
// preserved. Never re-arms stale, running, completed or post-deduction rows.

export type ImageRenderRearmFailureReason =
  | "not_found"
  | "intent_conflict"
  | "not_failed"
  | "deduction_recorded"
  | "active_key_occupied";

export interface ImageRenderRearmSuccess {
  rearmed: true;
  claim: ImageRenderClaim;
}

export interface ImageRenderRearmFailure {
  rearmed: false;
  reason: ImageRenderRearmFailureReason;
}

export type RearmImageRenderClaimResult =
  | ImageRenderRearmSuccess
  | ImageRenderRearmFailure;

export async function rearmFailedImageRenderClaim({
  userId,
  contentPostId,
  requestAttemptKey,
  intentFingerprint,
  ownerToken,
  leaseExpiresAt,
}: {
  userId: number;
  contentPostId: number;
  requestAttemptKey: string;
  intentFingerprint: string;
  ownerToken: string;
  leaseExpiresAt: Date | SQL;
}): Promise<RearmImageRenderClaimResult> {
  assertValidId(userId, "userId");
  assertValidId(contentPostId, "contentPostId");
  assertValidOwnerToken(ownerToken);
  assertValidLeaseExpiry(leaseExpiresAt);
  if (typeof requestAttemptKey !== "string" || !/^[0-9a-f]{64}$/.test(requestAttemptKey)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid requestAttemptKey: expected 64-character lowercase SHA-256 hex",
    });
  }
  if (typeof intentFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(intentFingerprint)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid intentFingerprint: expected 64-character lowercase SHA-256 hex",
    });
  }

  const db = getDb();
  let result: unknown;
  try {
    result = await db
      .update(imageRenderClaims)
      .set({
        status: "running",
        ownerToken,
        leaseExpiresAt,
        activeClaimKey: buildActiveImageRenderClaimKey({ userId, contentPostId }),
      })
      .where(
        and(
          eq(imageRenderClaims.requestAttemptKey, requestAttemptKey),
          eq(imageRenderClaims.intentFingerprint, intentFingerprint),
          eq(imageRenderClaims.userId, userId),
          eq(imageRenderClaims.contentPostId, contentPostId),
          eq(imageRenderClaims.status, "failed"),
          isNull(imageRenderClaims.activeClaimKey),
          eq(imageRenderClaims.deductionRecorded, false),
          isNotNull(imageRenderClaims.deductionKey)
        )
      );
  } catch (err: unknown) {
    if (isMySqlDuplicateKeyError(err)) {
      // Another logical attempt currently owns the user/post active key.
      return { rearmed: false, reason: "active_key_occupied" };
    }
    throw err;
  }

  if (getAffectedRows(result) !== 1) {
    return classifyRearmFailure({
      requestAttemptKey,
      intentFingerprint,
      userId,
      contentPostId,
    });
  }

  const claim = await findClaimByRequestAttemptKey(requestAttemptKey);
  if (!claim) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Image render claim rearmed but could not be read back",
    });
  }

  return { rearmed: true, claim };
}

async function classifyRearmFailure({
  requestAttemptKey,
  intentFingerprint,
  userId,
  contentPostId,
}: {
  requestAttemptKey: string;
  intentFingerprint: string;
  userId: number;
  contentPostId: number;
}): Promise<ImageRenderRearmFailure> {
  const claim = await findClaimByRequestAttemptKey(requestAttemptKey);
  if (!claim || claim.userId !== userId || claim.contentPostId !== contentPostId) {
    return { rearmed: false, reason: "not_found" };
  }
  if (claim.intentFingerprint !== intentFingerprint) {
    return { rearmed: false, reason: "intent_conflict" };
  }
  if (claim.status !== "failed") {
    return { rearmed: false, reason: "not_failed" };
  }
  if (claim.deductionRecorded || claim.deductionKey === null) {
    return { rearmed: false, reason: "deduction_recorded" };
  }
  return { rearmed: false, reason: "active_key_occupied" };
}

// ─── Dormant confirmed-deduction marker (B1) ───
//
// Records that a deduction result was CONFIRMED for this claim. Ambiguous or
// thrown deduction outcomes must never call this. Regardless of the flag, an
// ambiguous post-deduction claim remains blocking until reconciliation.

export interface ImageRenderDeductionMarkerResult {
  recorded: boolean;
  reason?: "not_found_or_unauthorized";
}

export async function markImageRenderDeductionRecorded({
  claimId,
  ownerToken,
  requestAttemptKey,
  deductionKey,
}: {
  claimId: number;
  ownerToken: string;
  requestAttemptKey: string;
  deductionKey: string;
}): Promise<ImageRenderDeductionMarkerResult> {
  assertValidId(claimId, "claimId");
  assertValidOwnerToken(ownerToken);
  if (typeof requestAttemptKey !== "string" || !/^[0-9a-f]{64}$/.test(requestAttemptKey)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid requestAttemptKey: expected 64-character lowercase SHA-256 hex",
    });
  }
  if (typeof deductionKey !== "string" || deductionKey.length === 0 || deductionKey.length > 191) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid deductionKey: expected 1-191 characters",
    });
  }

  const db = getDb();
  const result = await db
    .update(imageRenderClaims)
    .set({ deductionRecorded: true })
    .where(
      and(
        eq(imageRenderClaims.id, claimId),
        eq(imageRenderClaims.ownerToken, ownerToken),
        eq(imageRenderClaims.status, "running"),
        isNotNull(imageRenderClaims.activeClaimKey),
        eq(imageRenderClaims.requestAttemptKey, requestAttemptKey),
        eq(imageRenderClaims.deductionKey, deductionKey),
        eq(imageRenderClaims.deductionRecorded, false)
      )
    );

  if (getAffectedRows(result) !== 1) {
    return { recorded: false, reason: "not_found_or_unauthorized" };
  }

  return { recorded: true };
}
