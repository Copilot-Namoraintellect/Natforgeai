import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import { creditTransactions } from "@db/schema";
import {
  buildImageRenderDeductionKey,
  terminalizeStaleImageRenderClaim,
} from "./image-render-claim";

// ─── Dormant stale image-render claim recovery (Slice C3) ───
//
// Converts exactly one provably stale, pre-deduction running claim into an
// ordinary failed claim so the EXISTING later deliberate-request rearm path
// may subsequently handle it. This module takes no ownership, mints nothing,
// never rearms, rerenders, retries, refunds, or repairs anything, and has
// ZERO production callers. The C2 classifier remains diagnostic only; C3
// proves mutation safety independently through the conditional UPDATE inside
// terminalizeStaleImageRenderClaim.

export interface ImageRenderStaleRecoveryInput {
  claimId: number;
  userId: number;
  contentPostId: number;
  requestAttemptKey: string;
  intentFingerprint: string;
  deductionKey: string;
}

export type ImageRenderStaleRecoveryResult =
  | { status: "terminalized" }
  | {
      status: "blocked";
      reason:
        | "deduction_evidence_present"
        | "deduction_lookup_failed"
        | "state_changed_or_not_recoverable";
    };

export interface ImageRenderStaleRecoveryDeps {
  findDeductionRow(args: { deductionKey: string }): Promise<boolean>;
  terminalizeStaleClaim(
    args: ImageRenderStaleRecoveryInput
  ): Promise<{ terminalized: boolean }>;
}

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

function assertValidInput(input: ImageRenderStaleRecoveryInput): void {
  assertValidPositiveId(input.claimId, "claimId");
  assertValidPositiveId(input.userId, "userId");
  assertValidPositiveId(input.contentPostId, "contentPostId");
  if (
    typeof input.requestAttemptKey !== "string" ||
    !SHA256_HEX_PATTERN.test(input.requestAttemptKey)
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid requestAttemptKey: expected 64-character lowercase SHA-256 hex",
    });
  }
  if (
    typeof input.intentFingerprint !== "string" ||
    !SHA256_HEX_PATTERN.test(input.intentFingerprint)
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid intentFingerprint: expected 64-character lowercase SHA-256 hex",
    });
  }
  if (
    typeof input.deductionKey !== "string" ||
    input.deductionKey.length === 0 ||
    input.deductionKey.length > 191
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid deductionKey: expected 1-191 characters",
    });
  }
  if (input.deductionKey !== buildImageRenderDeductionKey(input.requestAttemptKey)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid deductionKey: does not match the derived attempt identity",
    });
  }
}

/**
 * Dormant recovery coordinator. Order: validate the exact immutable attempt
 * identity, prove the authoritative deduction row is absent, then invoke the
 * conditional terminalization exactly once. Any lookup error, present
 * deduction row, or zero-row terminalization fails closed with zero retries,
 * zero rereads, and zero claim mutation beyond that single conditional UPDATE.
 */
export async function recoverStaleImageRenderClaim(
  input: ImageRenderStaleRecoveryInput,
  deps: ImageRenderStaleRecoveryDeps
): Promise<ImageRenderStaleRecoveryResult> {
  assertValidInput(input);

  let deductionPresent: boolean;
  try {
    deductionPresent = await deps.findDeductionRow({ deductionKey: input.deductionKey });
  } catch {
    // Never guess about billing evidence: fail closed, zero claim mutation.
    return { status: "blocked", reason: "deduction_lookup_failed" };
  }
  if (deductionPresent) {
    return { status: "blocked", reason: "deduction_evidence_present" };
  }

  let terminalized: boolean;
  try {
    const result = await deps.terminalizeStaleClaim(input);
    terminalized = result.terminalized === true;
  } catch {
    // Fail closed: the conditional UPDATE is the authority; no retry.
    return { status: "blocked", reason: "state_changed_or_not_recoverable" };
  }
  if (!terminalized) {
    // Includes the heartbeat-renewal race (lease became active again) and the
    // finalization-won race (state advanced): the row is untouched.
    return { status: "blocked", reason: "state_changed_or_not_recoverable" };
  }
  return { status: "terminalized" };
}

/**
 * Production dependency wiring (dormant: nothing calls it yet). The deduction
 * probe is the established authoritative evidence — a credit_transactions row
 * whose idempotencyKey equals the attempt's deductionKey. Read-only.
 */
export function createDefaultImageRenderStaleRecoveryDeps(): ImageRenderStaleRecoveryDeps {
  return {
    findDeductionRow: async ({ deductionKey }) => {
      const [row] = await getDb()
        .select({ id: creditTransactions.id })
        .from(creditTransactions)
        .where(eq(creditTransactions.idempotencyKey, deductionKey))
        .limit(1);
      return row !== undefined;
    },
    terminalizeStaleClaim: (args) => terminalizeStaleImageRenderClaim(args),
  };
}
