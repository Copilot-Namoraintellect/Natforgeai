import { TRPCError } from "@trpc/server";
import { eq, and, isNotNull, SQL } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import { imageRenderClaims } from "@db/schema";
import { isMySqlDuplicateKeyError } from "../billing/credit-engine";

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
 */
export async function acquireImageRenderClaim({
  userId,
  contentPostId,
  ownerToken,
  leaseExpiresAt,
}: {
  userId: number;
  contentPostId: number;
  ownerToken: string;
  leaseExpiresAt: Date | SQL;
}): Promise<AcquireImageRenderClaimResult> {
  assertValidId(userId, "userId");
  assertValidId(contentPostId, "contentPostId");
  assertValidOwnerToken(ownerToken);
  assertValidLeaseExpiry(leaseExpiresAt);

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
