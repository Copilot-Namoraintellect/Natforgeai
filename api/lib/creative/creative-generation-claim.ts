import { randomBytes } from "crypto";
import { TRPCError } from "@trpc/server";
import { eq, and, or, lt, gte, isNull, isNotNull, sql, SQL } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import { creativeGenerationClaims } from "@db/schema";
import { isMySqlDuplicateKeyError } from "../billing/credit-engine";
import { logError } from "../logger";

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
  leaseExpiresAt?: Date | SQL | null;
}): Promise<AcquireCreativeGenerationClaimResult> {
  assertValidId(userId, "userId");
  assertValidId(campaignId, "campaignId");
  assertValidSource(operationSource);
  assertValidOwnerToken(ownerToken);

  if (operationReferenceId !== undefined && operationReferenceId !== null) {
    assertValidId(operationReferenceId, "operationReferenceId");
  }

  if (
    leaseExpiresAt !== undefined &&
    leaseExpiresAt !== null &&
    !(leaseExpiresAt instanceof SQL) &&
    (!(leaseExpiresAt instanceof Date) || Number.isNaN(leaseExpiresAt.getTime()))
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid leaseExpiresAt: expected Date or SQL",
    });
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

export interface AttachCreativeGenerationOperationReferenceSuccess {
  attached: true;
}

export interface AttachCreativeGenerationOperationReferenceCollision {
  attached: false;
  existingClaim: CreativeGenerationClaim;
}

export type AttachCreativeGenerationOperationReferenceResult =
  | AttachCreativeGenerationOperationReferenceSuccess
  | AttachCreativeGenerationOperationReferenceCollision;

export async function attachCreativeGenerationOperationReference({
  claimId,
  ownerToken,
  operationReferenceId,
}: {
  claimId: number;
  ownerToken: string;
  operationReferenceId: number;
}): Promise<AttachCreativeGenerationOperationReferenceResult> {
  assertValidId(claimId, "claimId");
  assertValidOwnerToken(ownerToken);
  assertValidId(operationReferenceId, "operationReferenceId");

  const db = getDb();
  try {
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

    return { attached: true };
  } catch (err: unknown) {
    if (!isMySqlDuplicateKeyError(err)) {
      throw err;
    }

    const existingClaim = await findExistingClaimByReference(
      // source is unknown here; we must infer it from the row we own.
      // Re-read the claim to obtain the source, then look up the duplicate.
      (await db
        .select({ operationSource: creativeGenerationClaims.operationSource })
        .from(creativeGenerationClaims)
        .where(eq(creativeGenerationClaims.id, claimId))
        .limit(1))[0]?.operationSource as CreativeGenerationOperationSource,
      operationReferenceId
    );

    if (existingClaim) {
      return { attached: false, existingClaim };
    }

    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message:
        "Creative generation operation reference collision detected but the existing operation could not be located",
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

export function generateOwnerToken(): string {
  return randomBytes(32).toString("hex"); // 64 characters
}

export interface ReleaseClaimSuccess {
  released: true;
}

export interface ReleaseClaimFailure {
  released: false;
  error: Error;
}

export type ReleaseClaimResult = ReleaseClaimSuccess | ReleaseClaimFailure;

export async function releaseClaimWithResult({
  claimId,
  ownerToken,
  status,
  context,
}: {
  claimId: number;
  ownerToken: string;
  status: "completed" | "failed";
  context: string;
}): Promise<ReleaseClaimResult> {
  try {
    await releaseCreativeGenerationClaim({ claimId, ownerToken, status });
    return { released: true };
  } catch (err: unknown) {
    logError("[creative-claim] release failed", {
      context,
      claimId,
      status,
      error: err instanceof Error ? err.message : String(err),
      // ownerToken is deliberately omitted from all logs
    });
    return {
      released: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

export async function releaseClaimSafely({
  claimId,
  ownerToken,
  status,
  context,
}: {
  claimId: number;
  ownerToken: string;
  status: "completed" | "failed";
  context: string;
}): Promise<void> {
  const result = await releaseClaimWithResult({
    claimId,
    ownerToken,
    status,
    context,
  });
  if (!result.released) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message:
        "Generation operation could not be closed cleanly. Please retry.",
    });
  }
}

export function calculateLeaseExpiresAt(leaseSeconds: number): SQL {
  // Use MySQL NOW() so lease times are consistent with the database clock and
  // session timezone. Callers should pass the returned SQL directly to
  // acquireCreativeGenerationClaim.
  return sql`DATE_ADD(NOW(), INTERVAL ${leaseSeconds} SECOND)`;
}

export interface HeartbeatCreativeGenerationClaimResult {
  renewed: boolean;
  reason?: "expired" | "not_found_or_unauthorized" | "missing_lease";
}

export async function heartbeatCreativeGenerationClaim({
  claimId,
  ownerToken,
  leaseSeconds,
}: {
  claimId: number;
  ownerToken: string;
  leaseSeconds: number;
}): Promise<HeartbeatCreativeGenerationClaimResult> {
  assertValidId(claimId, "claimId");
  assertValidOwnerToken(ownerToken);
  if (
    typeof leaseSeconds !== "number" ||
    !Number.isFinite(leaseSeconds) ||
    !Number.isInteger(leaseSeconds) ||
    leaseSeconds <= 0 ||
    leaseSeconds > Number.MAX_SAFE_INTEGER
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid leaseSeconds: expected positive safe integer",
    });
  }

  const db = getDb();
  const result = await db
    .update(creativeGenerationClaims)
    .set({
      heartbeatAt: sql`NOW()`,
      leaseExpiresAt: sql`DATE_ADD(NOW(), INTERVAL ${leaseSeconds} SECOND)`,
    })
    .where(
      and(
        eq(creativeGenerationClaims.id, claimId),
        eq(creativeGenerationClaims.ownerToken, ownerToken),
        eq(creativeGenerationClaims.status, "running"),
        isNotNull(creativeGenerationClaims.activeClaimKey),
        isNotNull(creativeGenerationClaims.leaseExpiresAt),
        gte(creativeGenerationClaims.leaseExpiresAt, sql`NOW()`)
      )
    );

  const affectedRows = getAffectedRows(result);
  if (affectedRows === 1) {
    return { renewed: true };
  }

  // Determine why the heartbeat failed without exposing the reason to callers.
  // Use MySQL time for all comparisons to avoid JS/DB clock skew.
  const [claim] = await db
    .select()
    .from(creativeGenerationClaims)
    .where(eq(creativeGenerationClaims.id, claimId))
    .limit(1);

  if (!claim) {
    return { renewed: false, reason: "not_found_or_unauthorized" };
  }

  if (claim.leaseExpiresAt === null) {
    return { renewed: false, reason: "missing_lease" };
  }

  const [expiredCheck] = await db
    .select({ id: creativeGenerationClaims.id })
    .from(creativeGenerationClaims)
    .where(
      and(
        eq(creativeGenerationClaims.id, claimId),
        eq(creativeGenerationClaims.ownerToken, ownerToken),
        isNotNull(creativeGenerationClaims.leaseExpiresAt),
        lt(creativeGenerationClaims.leaseExpiresAt, sql`NOW()`)
      )
    )
    .limit(1);

  if (expiredCheck) {
    return { renewed: false, reason: "expired" };
  }

  if (claim.status !== "running" || claim.activeClaimKey === null) {
    return { renewed: false, reason: "not_found_or_unauthorized" };
  }

  return { renewed: false, reason: "not_found_or_unauthorized" };
}

export interface AssertCreativeGenerationClaimOwnershipResult {
  owned: boolean;
  reason?: "not_found_or_unauthorized" | "missing_lease" | "expired";
}

export async function assertCreativeGenerationClaimOwnership({
  claimId,
  ownerToken,
}: {
  claimId: number;
  ownerToken: string;
}): Promise<AssertCreativeGenerationClaimOwnershipResult> {
  assertValidId(claimId, "claimId");
  assertValidOwnerToken(ownerToken);

  const db = getDb();
  const [claim] = await db
    .select()
    .from(creativeGenerationClaims)
    .where(
      and(
        eq(creativeGenerationClaims.id, claimId),
        eq(creativeGenerationClaims.ownerToken, ownerToken),
        eq(creativeGenerationClaims.status, "running"),
        isNotNull(creativeGenerationClaims.activeClaimKey),
        isNotNull(creativeGenerationClaims.leaseExpiresAt),
        gte(creativeGenerationClaims.leaseExpiresAt, sql`NOW()`)
      )
    )
    .limit(1);

  if (!claim) {
    return { owned: false, reason: "not_found_or_unauthorized" };
  }

  return { owned: true };
}

export interface CreativeGenerationClaimHeartbeatController {
  readonly lostOwnership: boolean;
  readonly abortSignal: AbortSignal;
  assertStillOwned(): Promise<void>;
  stop(): Promise<void>;
}

export function createClaimHeartbeatController({
  claimId,
  ownerToken,
  leaseSeconds,
  heartbeatIntervalSeconds,
}: {
  claimId: number;
  ownerToken: string;
  leaseSeconds: number;
  heartbeatIntervalSeconds: number;
}): CreativeGenerationClaimHeartbeatController {
  let lostOwnership = false;
  let running = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let inFlightHeartbeat: Promise<void> | null = null;

  const controller = new AbortController();
  const { signal } = controller;

  function scheduleNext(): void {
    if (lostOwnership || !running) return;
    timeoutId = setTimeout(runHeartbeat, heartbeatIntervalSeconds * 1000);
  }

  async function runHeartbeat(): Promise<void> {
    if (lostOwnership || !running) return;

    const thisHeartbeat = (async () => {
      const result = await heartbeatCreativeGenerationClaim({
        claimId,
        ownerToken,
        leaseSeconds,
      });

      if (!result.renewed) {
        lostOwnership = true;
        running = false;
        try {
          controller.abort();
        } catch {
          // AbortController may already be aborted; ignore.
        }
      }
    })().catch((err) => {
      // Any unexpected heartbeat failure is treated as ownership loss to keep
      // the system fail-closed. ownerToken is never logged here.
      lostOwnership = true;
      running = false;
      logError("[creative-claim] heartbeat controller encountered an error", {
        claimId,
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        controller.abort();
      } catch {
        // ignore
      }
    });

    inFlightHeartbeat = thisHeartbeat;
    await thisHeartbeat;
    inFlightHeartbeat = null;
    scheduleNext();
  }

  running = true;
  // Run an immediate heartbeat so the lease is current before long work begins.
  inFlightHeartbeat = runHeartbeat().then(() => {
    inFlightHeartbeat = null;
  });

  return {
    get lostOwnership() {
      return lostOwnership;
    },
    get abortSignal() {
      return signal;
    },
    async assertStillOwned(): Promise<void> {
      if (lostOwnership) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "Creative generation operation ownership was lost. Stopping work.",
        });
      }
      const result = await assertCreativeGenerationClaimOwnership({
        claimId,
        ownerToken,
      });
      if (!result.owned) {
        lostOwnership = true;
        running = false;
        try {
          controller.abort();
        } catch {
          // ignore
        }
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "Creative generation operation ownership was lost. Stopping work.",
        });
      }
    },
    async stop(): Promise<void> {
      running = false;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (inFlightHeartbeat) {
        await inFlightHeartbeat.catch(() => {
          // Swallow errors during shutdown; caller decides how to surface.
        });
      }
    },
  };
}

export interface StaleClaimClassification {
  expiredLeasedClaims: CreativeGenerationClaim[];
  legacyOrUnleasedClaims: CreativeGenerationClaim[];
}

export async function classifyStaleCreativeGenerationClaims({
  staleBefore,
  status = "running",
}: {
  staleBefore: Date;
  status?: "running";
}): Promise<StaleClaimClassification> {
  if (!(staleBefore instanceof Date) || Number.isNaN(staleBefore.getTime())) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid staleBefore: expected Date",
    });
  }

  const db = getDb();
  const rows = await db
    .select()
    .from(creativeGenerationClaims)
    .where(
      and(
        eq(creativeGenerationClaims.status, status),
        or(
          and(
            isNotNull(creativeGenerationClaims.leaseExpiresAt),
            lt(creativeGenerationClaims.leaseExpiresAt, sql`NOW()`)
          ),
          and(
            isNull(creativeGenerationClaims.leaseExpiresAt),
            lt(creativeGenerationClaims.updatedAt, staleBefore)
          )
        )
      )
    );

  const expiredLeasedClaims: CreativeGenerationClaim[] = [];
  const legacyOrUnleasedClaims: CreativeGenerationClaim[] = [];

  for (const claim of rows) {
    if (claim.leaseExpiresAt === null) {
      legacyOrUnleasedClaims.push(claim);
    } else {
      expiredLeasedClaims.push(claim);
    }
  }

  return { expiredLeasedClaims, legacyOrUnleasedClaims };
}
