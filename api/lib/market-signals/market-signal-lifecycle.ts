// ─── R8-C Market & External Signal Intelligence — signal lifecycle (C7) ───
//
// PURE module: deterministic signal-status derivation from immutable
// lifecycle facts + computed freshness + corroboration state, and lifecycle
// fact construction. Contradicted evidence remains visible (append-only
// facts; rows are never deleted); newer evidence supersedes but never
// rewrites old evidence. No I/O, no clock, no authority.

import type {
  MarketCorroborationStatus,
  MarketFreshnessClass,
  MarketLifecycleType,
  MarketSignalStatus,
} from "./market-signal-contract";

/**
 * Status precedence (contract §11), highest first:
 *   INVALIDATED > SUPERSEDED > CONTRADICTED > STALE > CORROBORATED > OBSERVED.
 */
export const MARKET_STATUS_PRECEDENCE: readonly MarketSignalStatus[] = [
  "INVALIDATED",
  "SUPERSEDED",
  "CONTRADICTED",
  "STALE",
  "CORROBORATED",
  "OBSERVED",
];

export interface LifecycleFactInput {
  readonly lifecycleType: MarketLifecycleType;
}

/**
 * Derive the deterministic current status of one signal. Computed identically
 * at read; materialized only under optimistic CAS.
 *
 * - INVALIDATION fact (integrity/authority failure) → INVALIDATED
 * - SUPERSESSION fact (a successor bound this row) → SUPERSEDED
 * - corroboration status CONTRADICTED (unresolved, uncorroborated) → CONTRADICTED
 * - freshness STALE/EXPIRED → STALE (staleness never silently stays current)
 * - corroboration status CORROBORATED or MIXED → CORROBORATED
 * - otherwise → OBSERVED
 */
export function deriveSignalStatus(input: {
  facts: readonly LifecycleFactInput[];
  freshnessClass: MarketFreshnessClass;
  corroborationStatus: MarketCorroborationStatus;
}): MarketSignalStatus {
  if (input.facts.some((f) => f.lifecycleType === "INVALIDATION")) return "INVALIDATED";
  if (input.facts.some((f) => f.lifecycleType === "SUPERSESSION")) return "SUPERSEDED";
  if (input.corroborationStatus === "CONTRADICTED") return "CONTRADICTED";
  if (input.freshnessClass === "STALE" || input.freshnessClass === "EXPIRED") return "STALE";
  if (input.corroborationStatus === "CORROBORATED" || input.corroborationStatus === "MIXED") return "CORROBORATED";
  return "OBSERVED";
}

/** Lifecycle facts that can be minted against a signal (closed vocabulary). */
export const MARKET_LIFECYCLE_REASON_CODES: Readonly<Record<MarketLifecycleType, string>> = {
  CORROBORATION: "INDEPENDENT_CORROBORATION_LINKED",
  CONTRADICTION: "CONTRADICTING_EVIDENCE_RECORDED",
  SUPERSESSION: "SUPERSEDED_BY_NEWER_SIGNAL",
  STALENESS: "FRESHNESS_WINDOW_ELAPSED",
  INVALIDATION: "SIGNAL_EVIDENCE_INVALIDATED",
};
