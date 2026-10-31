// ─── R9-A Mission Authority — lifecycle (A5) ───
//
// Closed mission lifecycle: PROPOSED, ELIGIBLE_FOR_PLANNING, REVIEW_REQUIRED,
// BLOCKED, SUPERSEDED, STALE, CANCELLED, INVALIDATED. There is deliberately
// NO EXECUTING status — execution belongs to downstream streams under
// separate governance. Transitions are append-only misl1: facts guarded by
// an optimistic version CAS; revalidation derives the deterministic target
// from the re-resolved source candidate (never from client input).

import {
  MISSION_STATUSES,
  fail,
  type MissionLifecycleType,
  type MissionReasonCode,
  type MissionStatus,
} from "./mission-authority-contract";

/** Closed status vocabulary — asserted in acceptance; EXECUTING is absent. */
export function isMissionStatus(raw: string): raw is MissionStatus {
  return (MISSION_STATUSES as readonly string[]).includes(raw);
}

/** Allowed transitions (safety net; the resolvers choose targets). */
const ALLOWED_TRANSITIONS: Readonly<Record<MissionStatus, readonly MissionStatus[]>> = Object.freeze({
  PROPOSED: ["ELIGIBLE_FOR_PLANNING", "REVIEW_REQUIRED", "BLOCKED", "STALE", "SUPERSEDED", "CANCELLED", "INVALIDATED"],
  ELIGIBLE_FOR_PLANNING: ["REVIEW_REQUIRED", "BLOCKED", "STALE", "SUPERSEDED", "CANCELLED", "INVALIDATED"],
  REVIEW_REQUIRED: ["ELIGIBLE_FOR_PLANNING", "BLOCKED", "STALE", "SUPERSEDED", "CANCELLED", "INVALIDATED"],
  BLOCKED: [],
  SUPERSEDED: [],
  STALE: ["BLOCKED", "SUPERSEDED", "CANCELLED", "INVALIDATED"],
  CANCELLED: [],
  INVALIDATED: [],
});

export function assertTransitionAllowed(from: MissionStatus, to: MissionStatus): void {
  if (from === to) return; // idempotent convergence: no fact emitted by callers
  if (!(ALLOWED_TRANSITIONS[from] as readonly string[]).includes(to)) {
    fail(
      "MISSION_LIFECYCLE_CONFLICT",
      `mission lifecycle transition ${from} → ${to} is not permitted`
    );
  }
}

export const TERMINAL_MISSION_STATUSES: readonly MissionStatus[] = Object.freeze([
  "BLOCKED",
  "SUPERSEDED",
  "CANCELLED",
  "INVALIDATED",
]);

export function isTerminalMissionStatus(status: MissionStatus): boolean {
  return (TERMINAL_MISSION_STATUSES as readonly string[]).includes(status);
}

export function lifecycleTypeForTarget(target: MissionStatus): MissionLifecycleType {
  switch (target) {
    case "ELIGIBLE_FOR_PLANNING":
      return "eligibility";
    case "REVIEW_REQUIRED":
      return "review_required";
    case "BLOCKED":
      return "blockage";
    case "STALE":
      return "staleness";
    case "SUPERSEDED":
      return "supersession";
    case "CANCELLED":
      return "cancellation";
    case "INVALIDATED":
      return "invalidation";
    default:
      fail("MISSION_LIFECYCLE_CONFLICT", `no lifecycle fact type for target status ${target}`);
  }
}

export interface RevalidationTarget {
  readonly targetStatus: MissionStatus;
  readonly reasonCode: MissionReasonCode;
}

/**
 * Deterministic revalidation target when the source candidate FAILED
 * eligibility resolution. The durable row (when present) disambiguates why —
 * an approval-pending candidate means REVIEW_REQUIRED (recoverable), a
 * terminal candidate means INVALIDATED/SUPERSEDED/BLOCKED, an expired or
 * stale window means STALE. No client input influences this mapping.
 */
export function resolveFailedSourceTarget(input: {
  row: Record<string, unknown> | null;
  errorCode: string;
}): RevalidationTarget {
  const { row, errorCode } = input;
  if (!row) {
    return { targetStatus: "INVALIDATED", reasonCode: "SOURCE_INVALIDATED" };
  }
  const status = String(row.status ?? "");
  const approval = String(row.approvalStatus ?? "none");
  if (status === "SUPERSEDED") {
    return { targetStatus: "SUPERSEDED", reasonCode: "SOURCE_SUPERSEDED" };
  }
  if (status === "CONTRADICTED") {
    return { targetStatus: "INVALIDATED", reasonCode: "SOURCE_CONTRADICTED" };
  }
  if (status === "INVALIDATED" || status === "RESOLVED") {
    return { targetStatus: "INVALIDATED", reasonCode: "SOURCE_INVALIDATED" };
  }
  if (status === "BLOCKED") {
    return { targetStatus: "BLOCKED", reasonCode: "RECOMMENDATION_BLOCKED_BY_POLICY" };
  }
  if (status === "STALE") {
    return { targetStatus: "STALE", reasonCode: "SOURCE_CANDIDATE_STALE" };
  }
  // Active-status rows that still failed the gate.
  if (approval === "rejected") {
    return { targetStatus: "INVALIDATED", reasonCode: "APPROVAL_REJECTED_BY_HUMAN" };
  }
  if (errorCode === "SOURCE_CANDIDATE_EXPIRED") {
    return { targetStatus: "STALE", reasonCode: "SOURCE_CANDIDATE_EXPIRED" };
  }
  if (errorCode === "SOURCE_CANDIDATE_STALE") {
    return { targetStatus: "STALE", reasonCode: "SOURCE_CANDIDATE_STALE" };
  }
  if (errorCode === "SOURCE_CANDIDATE_BLOCKED") {
    return { targetStatus: "BLOCKED", reasonCode: "RECOMMENDATION_BLOCKED_BY_POLICY" };
  }
  // Approval pending / stale policy version / ungoverned active row.
  return { targetStatus: "REVIEW_REQUIRED", reasonCode: "APPROVAL_PENDING" };
}

/**
 * Deterministic revalidation target when the source candidate resolved
 * cleanly: an expired mission validity window demotes to STALE; a currently
 * governed + consumable source promotes (or keeps) ELIGIBLE_FOR_PLANNING.
 */
export function resolveGovernedSourceTarget(input: {
  validUntilMs: number;
  nowMs: number;
}): RevalidationTarget {
  if (input.validUntilMs <= input.nowMs) {
    return { targetStatus: "STALE", reasonCode: "VALIDITY_EXPIRED" };
  }
  return { targetStatus: "ELIGIBLE_FOR_PLANNING", reasonCode: "SOURCE_GOVERNED_AND_CURRENT" };
}
