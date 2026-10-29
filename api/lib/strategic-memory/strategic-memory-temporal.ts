// ─── R8-A Strategic Memory — deterministic temporal model ───
//
// PURE module: derives the effective lifecycle status of a memory record from
// its denormalized status, its append-only lifecycle facts and the current
// time. Deterministic and reproducible: the same row + facts + `now` always
// yield the same status. No I/O, no clock of its own (`now` is explicit).

import type { StrategicMemoryLifecycleType, StrategicMemoryStatus } from "./strategic-memory-contract";

export interface MemoryLifecycleFactLike {
  lifecycleType: StrategicMemoryLifecycleType;
  targetStatus: string;
}

/**
 * Precedence (contract §8):
 *   1. SUPERSESSION fact        → SUPERSEDED
 *   2. CONTRADICTION fact       → CONTRADICTED
 *   3. INVALIDATION fact        → INVALIDATED
 *   4. validUntil < now         → EXPIRED
 *   5. STALENESS fact           → STALE
 *   6. otherwise                → CURRENT
 * REAFFIRMATION facts never override a terminal/derived state; they record
 * that a re-evaluation confirmed currency.
 */
export function computeMemoryStatus(
  storedStatus: string,
  facts: readonly MemoryLifecycleFactLike[],
  validUntil: string | null,
  now: string
): StrategicMemoryStatus {
  const has = (type: StrategicMemoryLifecycleType) => facts.some((f) => f.lifecycleType === type);

  if (has("supersession")) return "SUPERSEDED";
  if (has("contradiction")) return "CONTRADICTED";
  if (has("invalidation")) return "INVALIDATED";
  if (validUntil !== null && validUntil !== undefined && Date.parse(validUntil) < Date.parse(now)) {
    return "EXPIRED";
  }
  if (has("staleness")) return "STALE";
  if (storedStatus === "CURRENT") return "CURRENT";
  // A non-current stored status with no supporting fact is drift; surface it
  // as stale rather than silently active.
  return "STALE";
}

/** Statuses that must never appear in the active current projection. */
export const NON_ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  "STALE",
  "SUPERSEDED",
  "CONTRADICTED",
  "EXPIRED",
  "INVALIDATED",
]);

export function isActiveStatus(status: string): boolean {
  return !NON_ACTIVE_STATUSES.has(status);
}

/**
 * CAS-guarded status transitions that lifecycle facts may materialize.
 * Terminal lineage states are absorbing: SUPERSEDED/CONTRADICTED/INVALIDATED
 * never transition again (corrections are new rows, never edits). Any
 * non-terminal state may move to a terminal one (dependency invalidation can
 * hit STALE/EXPIRED memory); STALE ⇄ EXPIRED is allowed for re-sweeps.
 */
export function canTransitionMemoryStatus(from: string, to: string): boolean {
  if (from === to) return true;
  if (from === "SUPERSEDED" || from === "CONTRADICTED" || from === "INVALIDATED") return false;
  if (to === "SUPERSEDED" || to === "CONTRADICTED" || to === "INVALIDATED") {
    return from === "CURRENT" || from === "STALE" || from === "EXPIRED";
  }
  if (to === "STALE") return from === "CURRENT" || from === "EXPIRED";
  if (to === "EXPIRED") return from === "CURRENT" || from === "STALE";
  return false;
}
