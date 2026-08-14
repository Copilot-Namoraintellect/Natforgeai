import { TRPCError } from "@trpc/server";
import { eq, and, or, lt, isNull, isNotNull } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import { creativeGenerationClaims } from "@db/schema";
import { isMySqlDuplicateKeyError } from "../billing/credit-engine";

export const CREATIVE_GENERATION_OPERATION_SOURCES = [
  "job",
  "agent",
  "profile",
  "approval",
] as const;

export type CreativeGenerationOperationSource =
  (typeof CREATIVE_GENERATION_OPERATION_SOURCES)[number];

export type CreativeGenerationClaim =
  typeof creativeGenerationClaims.$inferSelect;

export interface CreativeGenerationClaimAcquisition {
  acquired: true;
  claim: CreativeGenerationClaim;
}

export interface CreativeGenerationClaimCollision {
  acquired: false;
  existingClaim: CreativeGenerationClaim;
  reason: "active_claim_collision" | "operation_reference_collision";
}

export type AcquireCreativeGenerationClaimResult =
  | CreativeGenerationClaimAcquisition
  | CreativeGenerationClaimCollision;

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

function assertValidSource(
  value: unknown
): asserts value is CreativeGenerationOperationSource {
  if (
    typeof value !== "string" ||
    !CREATIVE_GENERATION_OPERATION_SOURCES.includes(
      value as CreativeGenerationOperationSource
    )
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Invalid operationSource: ${String(value)}`,
    });
  }
}

function getAffectedRows(result: unknown): number {
  return Number((result as any)?.[0]?.affectedRows ?? 0);
}

export function buildActiveCreativeClaimKey(
  userId: number,
  campaignId: number
): string {
  assertValidId(userId, "userId");
  assertValidId(campaignId, "campaignId");
  return `active:${userId}:${campaignId}:creative`;
}

async function findExistingClaimByActiveKey(
  activeClaimKey: string
): Promise<CreativeGenerationClaim | null> {
  const db = getDb();
  const [claim] = await db
    .select()
    .from(creativeGenerationClaims)
    .where(eq(creativeGenerationClaims.activeClaimKey, activeClaimKey))
    .limit(1);
  return claim ?? null;
}

async function findExistingClaimByReference(
  operationSource: CreativeGenerationOperationSource,
  operationReferenceId: number
): Promise<CreativeGenerationClaim | null> {
  const db = getDb();
  const [claim] = await db
    .select()
    .from(creativeGenerationClaims)
    .where(
      and(
        eq(creativeGenerationClaims.operationSource, operationSource),
        eq(creativeGenerationClaims.operationReferenceId, operationReferenceId)
      )
    )
    .limit(1);
  return claim ?? null;
}

export async function acquireCreativeGenerationClaim({
  userId,
  campaignId,
  operationSource,
  operationReferenceId,
  ownerToken,
  leaseExpiresAt,
}: {
  userId: number;
  campaignId: number;
  operationSource: CreativeGenerationOperationSource;
  operationReferenceId?: number | null;
  ownerToken: string;
  leaseExpiresAt?: Date | null;
}): Promise<AcquireCreativeGenerationClaimResult> {
  assertValidId(userId, "userId");
  assertValidId(campaignId, "campaignId");
  assertValidSource(operationSource);
  assertValidOwnerToken(ownerToken);

  if (operationReferenceId !== undefined && operationReferenceId !== null) {
    assertValidId(operationReferenceId, "operationReferenceId");
  }

  if (leaseExpiresAt !== undefined && leaseExpiresAt !== null) {
    if (!(leaseExpiresAt instanceof Date) || Number.isNaN(leaseExpiresAt.getTime())) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Invalid leaseExpiresAt: expected Date",
      });
    }
  }

  const activeClaimKey = buildActiveCreativeClaimKey(userId, campaignId);
  const db = getDb();

  try {
    const [inserted] = await db.insert(creativeGenerationClaims).values({
      userId,
      campaignId,
      operationSource,
      operationReferenceId: operationReferenceId ?? null,
      activeClaimKey,
      ownerToken,
      status: "running",
      leaseExpiresAt: leaseExpiresAt ?? null,
    });

    const claimId = Number((inserted as any).insertId);
    const [claim] = await db
      .select()
      .from(creativeGenerationClaims)
      .where(eq(creativeGenerationClaims.id, claimId))
      .limit(1);

    if (!claim) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Creative generation claim was inserted but could not be read back",
      });
    }

    return { acquired: true, claim };
  } catch (err: unknown) {
    if (!isMySqlDuplicateKeyError(err)) {
      throw err;
    }

    const activeClaim = await findExistingClaimByActiveKey(activeClaimKey);
    if (activeClaim) {
      return {
        acquired: false,
        existingClaim: activeClaim,
        reason: "active_claim_collision",
      };
    }

    if (operationReferenceId !== undefined && operationReferenceId !== null) {
      const referenceClaim = await findExistingClaimByReference(
        operationSource,
        operationReferenceId
      );
      if (referenceClaim) {
        return {
          acquired: false,
          existingClaim: referenceClaim,
          reason: "operation_reference_collision",
        };
      }
    }

    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message:
        "Creative generation claim collision detected but the existing claim could not be located",
    });
  }
}

export async function attachCreativeGenerationOperationReference({
  claimId,
  ownerToken,
  operationReferenceId,
}: {
  claimId: number;
  ownerToken: string;
  operationReferenceId: number;
}): Promise<void> {
  assertValidId(claimId, "claimId");
  assertValidOwnerToken(ownerToken);
  assertValidId(operationReferenceId, "operationReferenceId");

  const db = getDb();
  const result = await db
    .update(creativeGenerationClaims)
    .set({ operationReferenceId })
    .where(
      and(
        eq(creativeGenerationClaims.id, claimId),
        eq(creativeGenerationClaims.ownerToken, ownerToken)
      )
    );

  const affectedRows = getAffectedRows(result);
  if (affectedRows !== 1) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Claim attachment failed: claim not found or ownerToken mismatch",
    });
  }
}

export async function releaseCreativeGenerationClaim({
  claimId,
  ownerToken,
  status,
}: {
  claimId: number;
  ownerToken: string;
  status: "completed" | "failed";
}): Promise<void> {
  assertValidId(claimId, "claimId");
  assertValidOwnerToken(ownerToken);
  if (status !== "completed" && status !== "failed") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Invalid terminal status: ${String(status)}`,
    });
  }

  const db = getDb();
  const result = await db
    .update(creativeGenerationClaims)
    .set({
      status,
      activeClaimKey: null,
      releasedAt: new Date(),
    })
    .where(
      and(
        eq(creativeGenerationClaims.id, claimId),
        eq(creativeGenerationClaims.ownerToken, ownerToken),
        eq(creativeGenerationClaims.status, "running")
      )
    );

  const affectedRows = getAffectedRows(result);
  if (affectedRows !== 1) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Claim release failed: claim not found, ownerToken mismatch, or claim is not running",
    });
  }
}

export async function getActiveCreativeGenerationClaim({
  userId,
  campaignId,
}: {
  userId: number;
  campaignId: number;
}): Promise<CreativeGenerationClaim | null> {
  assertValidId(userId, "userId");
  assertValidId(campaignId, "campaignId");

  const activeClaimKey = buildActiveCreativeClaimKey(userId, campaignId);
  const db = getDb();
  const [claim] = await db
    .select()
    .from(creativeGenerationClaims)
    .where(
      and(
        eq(creativeGenerationClaims.activeClaimKey, activeClaimKey),
        eq(creativeGenerationClaims.status, "running")
      )
    )
    .limit(1);

  return claim ?? null;
}

export async function classifyStaleCreativeGenerationClaims({
  staleBefore,
  status = "running",
}: {
  staleBefore: Date;
  status?: "running";
}): Promise<CreativeGenerationClaim[]> {
  if (!(staleBefore instanceof Date) || Number.isNaN(staleBefore.getTime())) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid staleBefore: expected Date",
    });
  }

  const db = getDb();
  return db
    .select()
    .from(creativeGenerationClaims)
    .where(
      and(
        eq(creativeGenerationClaims.status, status),
        or(
          and(
            isNotNull(creativeGenerationClaims.leaseExpiresAt),
            lt(creativeGenerationClaims.leaseExpiresAt, staleBefore)
          ),
          and(
            isNull(creativeGenerationClaims.leaseExpiresAt),
            lt(creativeGenerationClaims.updatedAt, staleBefore)
          )
        )
      )
    );
}
