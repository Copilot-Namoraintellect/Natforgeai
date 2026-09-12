import { createHash } from "crypto";
import { TRPCError } from "@trpc/server";
import { eq, and, isNotNull, isNull, SQL } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import { imageRenderClaims, generatedImages } from "@db/schema";
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

// The render path treats brand colour order as positional semantics
// (brandColors[0] → primary, [1] → secondary, [2] → accent in the template
// renderers), so order is preserved here. Colour semantics are
// case-insensitive (hex parsing in every consumer; brand-palette normalises
// hex to uppercase), so values are trimmed, uppercased and de-duplicated of
// empties. Raw values are only ever present inside this fingerprint
// computation — never persisted or logged.
function normalizeBrandColors(value: string[] | null | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim().toUpperCase() : ""))
    .filter((entry) => entry.length > 0);
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
  brandColors?: string[] | null;
  creativeType?: string | null;
  allowNoLogo?: boolean;
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
 * intentFingerprint covers all ten material render inputs (regenerate,
 * forceRegenerate, refinementInstruction, creativeGuidance, strongerBrandFit,
 * provider, templateId, brandColors, creativeType, allowNoLogo); raw text and
 * raw colour values are reduced to digests before canonicalization.
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
      brandColors: normalizeBrandColors(attempt.brandColors),
      creativeType: normalizeOptionalText(attempt.creativeType) || "leaflet",
      allowNoLogo: attempt.allowNoLogo === true,
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
  activeClaimKey: string,
  db: ImageRenderClaimDbExecutor = getDb()
): Promise<ImageRenderClaim | null> {
  const [claim] = await db
    .select()
    .from(imageRenderClaims)
    .where(eq(imageRenderClaims.activeClaimKey, activeClaimKey))
    .limit(1);
  return claim ?? null;
}

async function findClaimById(
  claimId: number,
  db: ImageRenderClaimDbExecutor = getDb()
): Promise<ImageRenderClaim | null> {
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

// NOTE: status-only completion never records a durable result link, so a
// completed claim produced this way has nothing replayable attached. Dormant
// compatibility only — production activation must complete claims with
// completeImageRenderClaimWithResult so the exact result can be replayed.

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
  requestAttemptKey: string,
  db: ImageRenderClaimDbExecutor = getDb()
): Promise<ImageRenderClaim | null> {
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
  userId,
  contentPostId,
  ownerToken,
  requestAttemptKey,
  intentFingerprint,
  deductionKey,
  executor,
}: {
  claimId: number;
  userId: number;
  contentPostId: number;
  ownerToken: string;
  requestAttemptKey: string;
  intentFingerprint: string;
  deductionKey: string;
  executor?: ImageRenderClaimDbExecutor;
}): Promise<ImageRenderDeductionMarkerResult> {
  assertValidId(claimId, "claimId");
  assertValidId(userId, "userId");
  assertValidId(contentPostId, "contentPostId");
  assertValidOwnerToken(ownerToken);
  assertValidSha256HexValue(requestAttemptKey, "requestAttemptKey");
  assertValidSha256HexValue(intentFingerprint, "intentFingerprint");
  if (typeof deductionKey !== "string" || deductionKey.length === 0 || deductionKey.length > 191) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid deductionKey: expected 1-191 characters",
    });
  }

  const db = resolveImageRenderClaimDb(executor);
  const result = await db
    .update(imageRenderClaims)
    .set({ deductionRecorded: true })
    .where(
      and(
        eq(imageRenderClaims.id, claimId),
        eq(imageRenderClaims.userId, userId),
        eq(imageRenderClaims.contentPostId, contentPostId),
        eq(imageRenderClaims.ownerToken, ownerToken),
        eq(imageRenderClaims.status, "running"),
        isNotNull(imageRenderClaims.activeClaimKey),
        eq(imageRenderClaims.requestAttemptKey, requestAttemptKey),
        eq(imageRenderClaims.intentFingerprint, intentFingerprint),
        eq(imageRenderClaims.deductionKey, deductionKey),
        eq(imageRenderClaims.deductionRecorded, false)
      )
    );

  if (getAffectedRows(result) !== 1) {
    return { recorded: false, reason: "not_found_or_unauthorized" };
  }

  return { recorded: true };
}

// ─── Dormant durable result linkage + replay snapshot (B2B-2A) ───
//
// completeImageRenderClaimWithResult atomically links exactly one generated
// image to a running, owner- and identity-scoped claim and stores the
// immutable replay snapshot of the logical external response. Claim
// completion without this primitive leaves no replayable result and must
// fail closed on replay. The primitives below never render, persist bytes,
// update content_posts, insert generated_images, bill, record usage, or
// touch the filesystem — asset existence is verified later by service
// integration (B2B-2B/B2B-3). Unexpected database errors are surfaced as a
// generic internal error (consistent with the other primitives in this
// module, which throw instead of returning claim_subsystem_unavailable; the
// coordinator maps thrown failures to claim_subsystem_unavailable).

export interface ImageRenderResultSnapshotInput {
  generatedImageId: number;
  imageUrl: string;
  provider: string;
  providerJobId?: string | null;
  creditsCharged: number;
  qualityTier: string;
  qualityLabel: string;
  isDraft: boolean;
  completedAt: Date;
}

type ImageRenderClaimDb = ReturnType<typeof getDb>;

/**
 * Internal server-side transaction boundary for the B2B-2A result-linkage
 * primitives. The default getDb() client and a Drizzle transaction callback
 * client (MySql2Transaction extends the database type) both satisfy this
 * shape. Exported only so the future B2B-3 service transaction can pass its
 * `tx` client through; router/frontend code must never use it, and neither
 * primitive opens a transaction itself.
 */
export interface ImageRenderClaimDbExecutor {
  select: ImageRenderClaimDb["select"];
  update: ImageRenderClaimDb["update"];
}

function resolveImageRenderClaimDb(
  executor?: ImageRenderClaimDbExecutor
): ImageRenderClaimDbExecutor {
  return executor ?? getDb();
}

function assertValidSha256HexValue(
  value: unknown,
  name: string
): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Invalid ${name}: expected 64-character lowercase SHA-256 hex`,
    });
  }
}

function assertValidResultSnapshotInput(snapshot: ImageRenderResultSnapshotInput): void {
  assertValidId(snapshot.generatedImageId, "generatedImageId");
  // Bounds are validation-only guards; the schema stores url and qualityLabel
  // as text so nothing is ever silently truncated.
  if (
    typeof snapshot.imageUrl !== "string" ||
    snapshot.imageUrl.trim().length === 0 ||
    snapshot.imageUrl.length > 2048
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid imageUrl: must be a non-empty string of at most 2048 characters",
    });
  }
  if (
    typeof snapshot.provider !== "string" ||
    snapshot.provider.trim().length === 0 ||
    snapshot.provider.length > 50
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid provider: must be a non-empty string of at most 50 characters",
    });
  }
  if (
    snapshot.providerJobId != null &&
    (typeof snapshot.providerJobId !== "string" ||
      snapshot.providerJobId.length === 0 ||
      snapshot.providerJobId.length > 255)
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Invalid providerJobId: must be null or a non-empty string of at most 255 characters",
    });
  }
  if (
    typeof snapshot.creditsCharged !== "number" ||
    !Number.isInteger(snapshot.creditsCharged) ||
    snapshot.creditsCharged < 0 ||
    snapshot.creditsCharged > Number.MAX_SAFE_INTEGER
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid creditsCharged: must be a non-negative integer",
    });
  }
  if (
    typeof snapshot.qualityTier !== "string" ||
    snapshot.qualityTier.trim().length === 0 ||
    snapshot.qualityTier.length > 50
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid qualityTier: must be a non-empty string of at most 50 characters",
    });
  }
  if (
    typeof snapshot.qualityLabel !== "string" ||
    snapshot.qualityLabel.trim().length === 0 ||
    snapshot.qualityLabel.length > 2048
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid qualityLabel: must be a non-empty string of at most 2048 characters",
    });
  }
  if (typeof snapshot.isDraft !== "boolean") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid isDraft: must be a boolean",
    });
  }
  if (!(snapshot.completedAt instanceof Date) || Number.isNaN(snapshot.completedAt.getTime())) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid completedAt: expected a valid Date",
    });
  }
}

function storedSnapshotMatches(
  claim: ImageRenderClaim,
  result: ImageRenderResultSnapshotInput
): boolean {
  return (
    claim.generatedImageId === result.generatedImageId &&
    claim.resultImageUrl === result.imageUrl &&
    claim.resultProvider === result.provider &&
    (claim.resultProviderJobId ?? null) === (result.providerJobId ?? null) &&
    claim.resultCreditsCharged === result.creditsCharged &&
    claim.resultQualityTier === result.qualityTier &&
    claim.resultQualityLabel === result.qualityLabel &&
    claim.resultIsDraft === result.isDraft &&
    claim.completedAt instanceof Date &&
    !Number.isNaN(claim.completedAt.getTime()) &&
    claim.completedAt.getTime() === result.completedAt.getTime()
  );
}

export type CompleteImageRenderClaimWithResultReason =
  | "already_completed_with_same_result"
  | "result_already_attached"
  | "identity_mismatch"
  | "not_found_or_unauthorized";

export type CompleteImageRenderClaimWithResultResult =
  | { completed: true; claim: ImageRenderClaim }
  | { completed: false; reason: CompleteImageRenderClaimWithResultReason };

/**
 * Atomically links one durable result to a running claim and completes it.
 *
 * One guarded UPDATE performs the snapshot write, the generatedImageId link,
 * status=completed and the active-key release. Exactly one durable result per
 * claim is enforced by the CAS predicate (generatedImageId IS NULL) plus the
 * unique irc_generated_image_idx index; an attached result is never
 * overwritten. On a zero-row CAS the claim is reread at most once to
 * classify; the UPDATE is never retried in a loop.
 */
export async function completeImageRenderClaimWithResult({
  claimId,
  ownerToken,
  userId,
  contentPostId,
  requestAttemptKey,
  intentFingerprint,
  deductionKey,
  result,
  executor,
}: {
  claimId: number;
  ownerToken: string;
  userId: number;
  contentPostId: number;
  requestAttemptKey: string;
  intentFingerprint: string;
  deductionKey: string;
  result: ImageRenderResultSnapshotInput;
  executor?: ImageRenderClaimDbExecutor;
}): Promise<CompleteImageRenderClaimWithResultResult> {
  assertValidId(claimId, "claimId");
  assertValidId(userId, "userId");
  assertValidId(contentPostId, "contentPostId");
  assertValidOwnerToken(ownerToken);
  assertValidSha256HexValue(requestAttemptKey, "requestAttemptKey");
  assertValidSha256HexValue(intentFingerprint, "intentFingerprint");
  if (
    typeof deductionKey !== "string" ||
    deductionKey.length === 0 ||
    deductionKey.length > 191
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid deductionKey: expected 1-191 characters",
    });
  }
  // The deduction key must be the deterministic derivative of the guarded
  // attempt key — never an independent caller-invented value.
  if (deductionKey !== buildImageRenderDeductionKey(requestAttemptKey)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid deductionKey: does not match the derived attempt identity",
    });
  }
  assertValidResultSnapshotInput(result);

  const db = resolveImageRenderClaimDb(executor);
  let updateResult: unknown;
  try {
    updateResult = await db
      .update(imageRenderClaims)
      .set({
        generatedImageId: result.generatedImageId,
        resultImageUrl: result.imageUrl,
        resultProvider: result.provider,
        resultProviderJobId: result.providerJobId ?? null,
        resultCreditsCharged: result.creditsCharged,
        resultQualityTier: result.qualityTier,
        resultQualityLabel: result.qualityLabel,
        resultIsDraft: result.isDraft,
        completedAt: result.completedAt,
        status: "completed",
        activeClaimKey: null,
      })
      .where(
        and(
          eq(imageRenderClaims.id, claimId),
          eq(imageRenderClaims.userId, userId),
          eq(imageRenderClaims.contentPostId, contentPostId),
          eq(imageRenderClaims.ownerToken, ownerToken),
          eq(imageRenderClaims.requestAttemptKey, requestAttemptKey),
          eq(imageRenderClaims.intentFingerprint, intentFingerprint),
          eq(imageRenderClaims.deductionKey, deductionKey),
          eq(imageRenderClaims.status, "running"),
          isNotNull(imageRenderClaims.activeClaimKey),
          isNull(imageRenderClaims.generatedImageId)
        )
      );
  } catch (err: unknown) {
    if (isMySqlDuplicateKeyError(err)) {
      // irc_generated_image_idx: this image is already linked to a claim.
      return { completed: false, reason: "result_already_attached" };
    }
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Image render claim completion failed",
    });
  }

  if (getAffectedRows(updateResult) === 1) {
    const claim = await findClaimById(claimId, db);
    if (!claim) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Image render claim completed but could not be read back",
      });
    }
    return { completed: true, claim };
  }

  // Zero rows affected: exactly one deterministic reread to classify, through
  // the same executor. Never retry the UPDATE; never overwrite an attached
  // result; a NULL or mismatched persisted deductionKey is an identity
  // failure, never idempotent success.
  const persisted = await findClaimById(claimId, db);
  if (!persisted || persisted.ownerToken !== ownerToken) {
    return { completed: false, reason: "not_found_or_unauthorized" };
  }
  if (
    persisted.userId !== userId ||
    persisted.contentPostId !== contentPostId ||
    persisted.requestAttemptKey !== requestAttemptKey ||
    persisted.intentFingerprint !== intentFingerprint ||
    persisted.deductionKey !== deductionKey
  ) {
    return { completed: false, reason: "identity_mismatch" };
  }
  if (persisted.status === "completed") {
    if (persisted.generatedImageId === null) {
      // Legacy status-only completion carries no durable result: fail closed.
      return { completed: false, reason: "not_found_or_unauthorized" };
    }
    // A stored snapshot that is missing or partial never counts as the same
    // result (storedSnapshotMatches requires every field): fail closed.
    if (storedSnapshotMatches(persisted, result)) {
      return { completed: false, reason: "already_completed_with_same_result" };
    }
    return { completed: false, reason: "result_already_attached" };
  }
  return { completed: false, reason: "not_found_or_unauthorized" };
}

export interface ImageRenderReplayResult {
  generatedImageId: number;
  imageUrl: string;
  provider: string;
  providerJobId: string | null;
  creditsCharged: number;
  qualityTier: string;
  qualityLabel: string;
  isDraft: boolean;
  completedAt: Date;
}

export type GetCompletedImageRenderResultReason =
  | "intent_conflict"
  | "completed_without_result"
  | "linked_result_missing_or_mismatched"
  | "not_completed_or_not_found";

export type GetCompletedImageRenderResultResult =
  | { replayable: true; result: ImageRenderReplayResult }
  | { replayable: false; reason: GetCompletedImageRenderResultReason };

/**
 * Resolves the durable result for a completed attempt for exact replay.
 *
 * Read-only and identity-scoped: the claim is located by requestAttemptKey
 * and verified against authoritative userId/contentPostId and the intent
 * fingerprint. The linked generated_images row must exist with the exact id
 * and matching ownership. Latest-image ordering, content_posts.metadata and
 * URL inference are never used. The replayable projection exposes only the
 * safe logical result fields plus generatedImageId (needed internally for
 * later asset verification); no ownerToken, active key, attempt key,
 * fingerprint, deduction key, deduction flag, raw client token or raw intent
 * is returned. This primitive verifies database rows only — it never checks
 * the filesystem, reads bytes, or fetches the stored URL.
 */
export async function getCompletedImageRenderResult({
  userId,
  contentPostId,
  requestAttemptKey,
  intentFingerprint,
  executor,
}: {
  userId: number;
  contentPostId: number;
  requestAttemptKey: string;
  intentFingerprint: string;
  executor?: ImageRenderClaimDbExecutor;
}): Promise<GetCompletedImageRenderResultResult> {
  assertValidId(userId, "userId");
  assertValidId(contentPostId, "contentPostId");
  assertValidSha256HexValue(requestAttemptKey, "requestAttemptKey");
  assertValidSha256HexValue(intentFingerprint, "intentFingerprint");

  const db = resolveImageRenderClaimDb(executor);
  let claim: ImageRenderClaim | null;
  try {
    claim = await findClaimByRequestAttemptKey(requestAttemptKey, db);
  } catch {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Image render result lookup failed",
    });
  }

  if (
    !claim ||
    claim.userId !== userId ||
    claim.contentPostId !== contentPostId
  ) {
    return { replayable: false, reason: "not_completed_or_not_found" };
  }
  if (claim.intentFingerprint !== intentFingerprint) {
    return { replayable: false, reason: "intent_conflict" };
  }
  if (claim.status !== "completed") {
    return { replayable: false, reason: "not_completed_or_not_found" };
  }
  if (
    claim.generatedImageId === null ||
    typeof claim.resultImageUrl !== "string" ||
    claim.resultImageUrl.length === 0 ||
    typeof claim.resultProvider !== "string" ||
    claim.resultProvider.length === 0 ||
    claim.resultCreditsCharged === null ||
    typeof claim.resultQualityTier !== "string" ||
    claim.resultQualityTier.length === 0 ||
    typeof claim.resultQualityLabel !== "string" ||
    claim.resultQualityLabel.length === 0 ||
    typeof claim.resultIsDraft !== "boolean" ||
    !(claim.completedAt instanceof Date) ||
    Number.isNaN(claim.completedAt.getTime())
  ) {
    // Completed claim without a complete durable snapshot: fail closed.
    return { replayable: false, reason: "completed_without_result" };
  }

  let imageRow: typeof generatedImages.$inferSelect | null;
  try {
    const [row] = await db
      .select()
      .from(generatedImages)
      .where(
        and(
          eq(generatedImages.id, claim.generatedImageId),
          eq(generatedImages.userId, userId),
          eq(generatedImages.contentPostId, contentPostId),
          eq(generatedImages.status, "completed"),
          eq(generatedImages.url, claim.resultImageUrl)
        )
      )
      .limit(1);
    imageRow = row ?? null;
  } catch {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Image render result lookup failed",
    });
  }

  if (!imageRow) {
    return { replayable: false, reason: "linked_result_missing_or_mismatched" };
  }

  return {
    replayable: true,
    result: {
      generatedImageId: claim.generatedImageId,
      imageUrl: claim.resultImageUrl,
      provider: claim.resultProvider,
      providerJobId: claim.resultProviderJobId ?? null,
      creditsCharged: claim.resultCreditsCharged,
      qualityTier: claim.resultQualityTier,
      qualityLabel: claim.resultQualityLabel,
      isDraft: claim.resultIsDraft,
      completedAt: claim.completedAt,
    },
  };
}
