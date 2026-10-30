// ─── R8-B Business Change Intelligence — deterministic temporal model ───
//
// PURE module: derives the effective lifecycle status of a change record from
// its denormalized status, its append-only lifecycle facts and the current
// time. Deterministic and reproducible: the same row + facts + `now` always
// yield the same status. No I/O, no clock of its own (`now` is explicit).

import type { BusinessChangeLifecycleType, BusinessChangeStatus } from "./business-change-contract";

export interface ChangeLifecycleFactLike {
  lifecycleType: BusinessChangeLifecycleType;
  targetStatus: string;
}

/**
 * Precedence (contract §8):
 *   1. SUPERSESSION fact     → SUPERSEDED
 *   2. CONTRADICTION fact    → CONTRADICTED
 *   3. INVALIDATION fact     → INVALIDATED
 *   4. validUntil < now      → EXPIRED
 *   5. CONFIRMATION fact     → CONFIRMED
 *   6. stored PROVISIONAL    → PROVISIONAL
 *   7. otherwise             → DETECTED
 * REAFFIRMATION facts never override a terminal/derived state; they record
 * that a re-evaluation confirmed the change.
 */
export function computeChangeStatus(
  storedStatus: string,
  facts: readonly ChangeLifecycleFactLike[],
  validUntil: string | null,
  now: string
): BusinessChangeStatus {
  const has = (type: BusinessChangeLifecycleType) => facts.some((f) => f.lifecycleType === type);

  if (has("supersession")) return "SUPERSEDED";
  if (has("contradiction")) return "CONTRADICTED";
  if (has("invalidation")) return "INVALIDATED";
  if (validUntil !== null && validUntil !== undefined && Date.parse(validUntil) < Date.parse(now)) {
    return "EXPIRED";
  }
  if (has("confirmation")) return "CONFIRMED";
  if (storedStatus === "PROVISIONAL") return "PROVISIONAL";
  if (storedStatus === "DETECTED" || storedStatus === "CONFIRMED") return storedStatus;
  // A non-active stored status with no supporting fact is drift; surface it
  // as EXPIRED rather than silently active.
  return "EXPIRED";
}

/** Statuses that must never appear in the active current projection. */
export const NON_ACTIVE_CHANGE_STATUSES: ReadonlySet<string> = new Set([
  "CONTRADICTED",
  "SUPERSEDED",
  "INVALIDATED",
  "EXPIRED",
]);

export function isActiveChangeStatus(status: string): boolean {
  return !NON_ACTIVE_CHANGE_STATUSES.has(status);
}

/**
 * CAS-guarded status transitions that lifecycle facts may materialize.
 * Terminal lineage states are absorbing: SUPERSEDED/CONTRADICTED/INVALIDATED
 * never transition again (corrections are new rows, never edits).
 */
export function canTransitionChangeStatus(from: string, to: string): boolean {
  if (from === to) return true;
  if (from === "SUPERSEDED" || from === "CONTRADICTED" || from === "INVALIDATED") return false;
  if (to === "SUPERSEDED" || to === "CONTRADICTED" || to === "INVALIDATED") {
    return from === "DETECTED" || from === "CONFIRMED" || from === "PROVISIONAL" || from === "EXPIRED";
  }
  if (to === "CONFIRMED") return from === "DETECTED" || from === "PROVISIONAL" || from === "EXPIRED";
  if (to === "EXPIRED") return from === "DETECTED" || from === "CONFIRMED" || from === "PROVISIONAL";
  return false;
}
