/**
 * R5 Operations Summary (WBS-R5-F3/F4 shared bounded rollup).
 *
 * Cross-business aggregate used by BOTH the readiness surface
 * (`health.getR5OperationsReadiness`) and the operator read endpoints
 * (`operations.getOperationsSummary`). One shared helper keeps the two
 * surfaces consistent and guarantees the same bounded-projection discipline:
 *
 * - Only the most recent `businessLimit` businesses (default 25, max 100)
 *   are projected through the canonical F1 pipeline
 *   (collectR5BusinessEvidence -> deriveR5Blockers -> deriveR5OperationalState).
 *   No per-table fan-out beyond the projection's own allow-listed reads and
 *   never a full projection of every business.
 * - Health/blocker tallies are computed by counting the DERIVED results, not
 *   by re-classifying rows outside the projection.
 * - Read-only; secret-free by construction (inherits the projection's
 *   column allow-list); deterministic for an explicit clock.
 */

import { desc } from "drizzle-orm";
import { businesses } from "@db/schema";
import type { getDb } from "../../queries/connection";
import { logError } from "../logger";
import {
  collectR5BusinessEvidence,
  deriveR5Blockers,
  deriveR5OperationalState,
  R5_OPERATIONAL_HEALTH,
  type R5OperationalHealth,
} from "./r5-operations-projection";

type Db = ReturnType<typeof getDb>;

export const R5_SUMMARY_DEFAULT_BUSINESS_LIMIT = 25;
export const R5_SUMMARY_MAX_BUSINESS_LIMIT = 100;
export const R5_SUMMARY_TOP_BLOCKED_LIMIT = 10;

export interface R5TopBlockedBusiness {
  businessId: number;
  health: R5OperationalHealth;
  blockerClasses: string[];
}

export interface R5OperationsSummary {
  /** Businesses actually projected (bounded set minus read failures). */
  projectedCount: number;
  /** Total rows in the businesses table. */
  totalBusinesses: number;
  /** True when the businesses table holds more rows than the projection limit. */
  truncated: boolean;
  healthCounts: Record<R5OperationalHealth, number>;
  blockerClassCounts: Record<string, number>;
  topBlocked: R5TopBlockedBusiness[];
}

/**
 * Operator-facing severity order (worst first), matching the readiness
 * contract: FAIL_CLOSED > BLOCKED_OPERATOR > BLOCKED_CONFIGURATION >
 * AUTO_RECOVERING > DEGRADED > HEALTHY. UNSUPPORTED (zero capability
 * evidence) is not a blocked condition and sorts last.
 */
const R5_HEALTH_SEVERITY: Record<R5OperationalHealth, number> = {
  FAIL_CLOSED: 0,
  BLOCKED_OPERATOR: 1,
  BLOCKED_CONFIGURATION: 2,
  AUTO_RECOVERING: 3,
  DEGRADED: 4,
  HEALTHY: 5,
  UNSUPPORTED: 6,
};

/** Clamp a caller-supplied projection window into [1, 100]; default 25. */
export function clampR5BusinessLimit(limit: number | undefined | null): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return R5_SUMMARY_DEFAULT_BUSINESS_LIMIT;
  }
  return Math.min(Math.max(1, Math.floor(limit)), R5_SUMMARY_MAX_BUSINESS_LIMIT);
}

/**
 * Project a bounded window of businesses and tally health/blocker counts.
 * A business whose evidence read fails is logged and skipped (honest
 * degradation) rather than failing the whole rollup.
 */
export async function summarizeR5Operations(
  db: Db,
  now: Date,
  businessLimit?: number
): Promise<R5OperationsSummary> {
  const limit = clampR5BusinessLimit(businessLimit);

  const [allIdRows, windowRows] = await Promise.all([
    db.select({ id: businesses.id }).from(businesses),
    db
      .select({ id: businesses.id })
      .from(businesses)
      .orderBy(desc(businesses.id))
      .limit(limit),
  ]);
  const totalBusinesses = allIdRows.length;

  const healthCounts = Object.fromEntries(
    R5_OPERATIONAL_HEALTH.map((h) => [h, 0])
  ) as Record<R5OperationalHealth, number>;
  const blockerClassCounts: Record<string, number> = {};
  const topBlocked: R5TopBlockedBusiness[] = [];
  let projectedCount = 0;

  for (const row of windowRows) {
    let health: R5OperationalHealth;
    let blockerClasses: string[];
    try {
      const evidence = await collectR5BusinessEvidence(db, row.id, now);
      if (!evidence.businessFound) continue;
      const blockers = deriveR5Blockers(evidence);
      const derivation = deriveR5OperationalState(evidence, blockers, now);
      health = derivation.health;
      blockerClasses = blockers.map((b) => b.blockerClass);
      for (const b of blockers) {
        blockerClassCounts[b.blockerClass] = (blockerClassCounts[b.blockerClass] ?? 0) + 1;
      }
    } catch (err) {
      logError("[R5] Failed to project business for operations summary", {
        event: "r5_operations_summary_business_failed",
        businessId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    projectedCount += 1;
    healthCounts[health] += 1;
    topBlocked.push({ businessId: row.id, health, blockerClasses });
  }

  topBlocked.sort(
    (a, b) =>
      R5_HEALTH_SEVERITY[a.health] - R5_HEALTH_SEVERITY[b.health] ||
      b.blockerClasses.length - a.blockerClasses.length ||
      b.businessId - a.businessId
  );

  return {
    projectedCount,
    totalBusinesses,
    truncated: totalBusinesses > limit,
    healthCounts,
    blockerClassCounts,
    topBlocked: topBlocked.slice(0, R5_SUMMARY_TOP_BLOCKED_LIMIT),
  };
}
