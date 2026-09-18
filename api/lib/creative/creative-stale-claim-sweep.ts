import { TRPCError } from "@trpc/server";
import { and, count, eq, gte, isNotNull, isNull, or, sql } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import { creativeGenerationClaims } from "@db/schema";
import {
  classifyStaleCreativeGenerationClaims,
  terminalizeStaleCreativeGenerationClaim,
  type StaleClaimClassification,
} from "./creative-generation-claim";
import { classifyCreativeClaimStaleRecovery } from "./creative-claim-stale-recovery-classifier";

// ─── Dormant stale creative-generation claim sweep ───
//
// Controlled recovery entry point for the existing stale claim classifier.
// The sweep wires classifyStaleCreativeGenerationClaims into a safe recovery
// path: every stale candidate it finds is re-gated through the pure recovery
// classifier and then handed to the conditional terminalization primitive,
// whose UPDATE is the sole stale-authority checkpoint. This module takes no
// ownership, mints nothing, never rearms, never runs agents, never renders,
// never retries, and never touches billing — a recovered claim becomes an
// ordinary failed claim that the EXISTING deliberate-request rearm path
// (rearmCreativeGenerationClaim, used by workflow orchestration) may later
// resume. It has ZERO production callers: no timer, no request-path wiring.
// Invocation is deliberate (manual/operator), one sweep at a time.

export type CreativeStaleRecoveryKind = "expired_lease" | "legacy_unleased";

export interface CreativeStaleClaimRecoveredEntry {
  readonly claimId: number;
  readonly userId: number;
  readonly campaignId: number;
  readonly recoveryKind: CreativeStaleRecoveryKind;
}

export type CreativeStaleClaimAmbiguousReason =
  | "state_changed_or_not_recoverable"
  | "not_recoverable";

export interface CreativeStaleClaimAmbiguousEntry {
  readonly claimId: number;
  readonly userId: number;
  readonly campaignId: number;
  readonly reason: CreativeStaleClaimAmbiguousReason;
}

/**
 * Audit evidence for one sweep run. Entries carry only durable identifiers —
 * never owner tokens, keys, or raw dependency errors.
 */
export interface CreativeStaleClaimSweepReport {
  /** ISO timestamp bound the sweep used as the unleased-age staleness threshold. */
  readonly staleBefore: string;
  /** Stale candidates found by the existing classifier. */
  readonly found: number;
  /** Running claims observed as healthy (active lease or recent unleased) and deliberately not touched. */
  readonly healthyIgnored: number;
  /** Stale claims terminalized by this sweep. */
  readonly recovered: readonly CreativeStaleClaimRecoveredEntry[];
  /** Candidates left untouched: state changed mid-sweep, peer recovery won, or evidence was not recoverable. */
  readonly ambiguousLeftUntouched: readonly CreativeStaleClaimAmbiguousEntry[];
}

export interface SweepStaleCreativeClaimsDeps {
  /** Read-only listing of stale candidates; wraps the existing classifier. */
  listStaleClaims(args: { staleBefore: Date }): Promise<StaleClaimClassification>;
  /** Read-only count of running claims that are NOT stale (healthy-ignored evidence). */
  countHealthyRunningClaims(args: { staleBefore: Date }): Promise<number>;
  /** Conditional stale-authority terminalization; exactly one attempt per claim. */
  terminalizeStaleClaim(args: {
    claimId: number;
    userId: number;
    campaignId: number;
    staleBefore: Date;
  }): Promise<{ terminalized: boolean }>;
}

function toLeaseState(claim: {
  leaseExpiresAt: Date | null;
}): "active" | "stale" | "missing" {
  if (claim.leaseExpiresAt === null) return "missing";
  // The pure gate uses the local clock only as a screening decision; the
  // conditional UPDATE re-checks staleness against the database clock, so
  // local/DB skew can only ever produce an ambiguous entry, never a stolen
  // live claim.
  return claim.leaseExpiresAt.getTime() < Date.now() ? "stale" : "active";
}

/**
 * Run one controlled recovery sweep. Read-only evidence is gathered first so
 * a failed read aborts the sweep with zero mutations. Each candidate is
 * screened by the pure classifier and terminalized at most once; any
 * terminalization miss or error is recorded as ambiguous and the sweep moves
 * on — fail closed, zero retries. Re-running the sweep is a no-op because
 * terminalized claims leave the running set, and concurrent sweeps race
 * safely on the conditional UPDATE (exactly one winner per claim).
 */
export async function sweepStaleCreativeGenerationClaims({
  staleBefore,
  deps = createDefaultCreativeStaleClaimSweepDeps(),
}: {
  staleBefore: Date;
  deps?: SweepStaleCreativeClaimsDeps;
}): Promise<CreativeStaleClaimSweepReport> {
  if (!(staleBefore instanceof Date) || Number.isNaN(staleBefore.getTime())) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid staleBefore: expected Date",
    });
  }

  const [healthyIgnored, found] = await Promise.all([
    deps.countHealthyRunningClaims({ staleBefore }),
    deps.listStaleClaims({ staleBefore }),
  ]);

  const candidates = [
    ...found.expiredLeasedClaims,
    ...found.legacyOrUnleasedClaims,
  ];
  const recovered: CreativeStaleClaimRecoveredEntry[] = [];
  const ambiguousLeftUntouched: CreativeStaleClaimAmbiguousEntry[] = [];

  for (const claim of candidates) {
    const classification = classifyCreativeClaimStaleRecovery({
      claim: {
        found: true,
        status: claim.status,
        leaseState: toLeaseState(claim),
        agedPastThreshold: claim.updatedAt.getTime() < staleBefore.getTime(),
      },
    });

    const entry = {
      claimId: claim.id,
      userId: claim.userId,
      campaignId: claim.campaignId,
    };

    if (!classification.recoverable) {
      // The listing classifier and the pure gate disagree (state changed
      // between listing and screening, or malformed evidence): fail closed.
      ambiguousLeftUntouched.push({ ...entry, reason: "not_recoverable" });
      continue;
    }

    let terminalized: boolean;
    try {
      const result = await deps.terminalizeStaleClaim({
        ...entry,
        staleBefore,
      });
      terminalized = result.terminalized === true;
    } catch {
      // Fail closed: the conditional UPDATE is the authority; no retry, and
      // no further mutation attempts for this claim.
      ambiguousLeftUntouched.push({
        ...entry,
        reason: "state_changed_or_not_recoverable",
      });
      continue;
    }

    if (!terminalized) {
      // Includes the heartbeat-renewal race (a live owner renewed the lease
      // after listing), the owner-release race, and a concurrent peer sweep
      // that terminalized first: the row is untouched by this sweep.
      ambiguousLeftUntouched.push({
        ...entry,
        reason: "state_changed_or_not_recoverable",
      });
      continue;
    }

    recovered.push({
      ...entry,
      recoveryKind:
        claim.leaseExpiresAt === null ? "legacy_unleased" : "expired_lease",
    });
  }

  return Object.freeze({
    staleBefore: staleBefore.toISOString(),
    found: candidates.length,
    healthyIgnored,
    recovered: Object.freeze(recovered) as CreativeStaleClaimRecoveredEntry[],
    ambiguousLeftUntouched: Object.freeze(
      ambiguousLeftUntouched
    ) as CreativeStaleClaimAmbiguousEntry[],
  });
}

/**
 * Production dependency wiring (dormant: nothing calls it yet). The listing
 * dependency is the existing stale classifier itself; the healthy-count probe
 * is a read-only count over the same claims table; the terminalization
 * dependency is the conditional UPDATE primitive. None of them bill, render,
 * notify, or resume work.
 */
export function createDefaultCreativeStaleClaimSweepDeps(): SweepStaleCreativeClaimsDeps {
  return {
    listStaleClaims: ({ staleBefore }) =>
      classifyStaleCreativeGenerationClaims({ staleBefore }),
    countHealthyRunningClaims: async ({ staleBefore }) => {
      const db = getDb();
      const [row] = await db
        .select({ value: count() })
        .from(creativeGenerationClaims)
        .where(
          and(
            eq(creativeGenerationClaims.status, "running"),
            or(
              and(
                isNotNull(creativeGenerationClaims.leaseExpiresAt),
                gte(creativeGenerationClaims.leaseExpiresAt, sql`NOW()`)
              ),
              and(
                isNull(creativeGenerationClaims.leaseExpiresAt),
                gte(creativeGenerationClaims.updatedAt, staleBefore)
              )
            )
          )
        );
      return Number(row?.value ?? 0);
    },
    terminalizeStaleClaim: (args) =>
      terminalizeStaleCreativeGenerationClaim(args),
  };
}
