// ─── R7-B Attribution Intelligence — deterministic attribution policy ───
//
// PURE module (no I/O, no clock). The attribution policy is deterministic and
// server-side only: window bounds, the closed model allow-list, provisional
// outcome handling, and the anonymous-outcome rule. Clients can never supply
// or influence any policy field. The policy version is a closed constant
// until a governed policy store lands (R7-F owns optimisation governance; a
// policy-store seam would replace the constant without changing this
// contract's authority rules).

import { ATTRIBUTION_MODEL_TYPES, AttributionInputError, type AttributionModelType } from "./attribution-contract";

export const ATTRIBUTION_POLICY_VERSION = "attribution-policy/v1" as const;

export interface AttributionPolicy {
  readonly policyVersion: typeof ATTRIBUTION_POLICY_VERSION;
  /** Attribution window length in days (windowEnd = outcome time). */
  readonly windowDays: number;
  /** Closed model allow-list (all five repository-supported models). */
  readonly allowedModels: readonly AttributionModelType[];
  /** Whether PROVISIONAL/OBSERVED outcomes may be attributed at all. */
  readonly allowProvisionalOutcomes: boolean;
  /**
   * Whether outcomes with no verified lead linkage may use outcome-level
   * provenance touchpoints (never fabricating lead linkage).
   */
  readonly allowAnonymousOutcomeAttribution: boolean;
  /** Upper bound for touchpoint future-dated skew (5 minutes, house bound). */
  readonly futureSkewMs: number;
}

export const DEFAULT_ATTRIBUTION_POLICY: AttributionPolicy = {
  policyVersion: ATTRIBUTION_POLICY_VERSION,
  windowDays: 30,
  allowedModels: ATTRIBUTION_MODEL_TYPES,
  allowProvisionalOutcomes: true,
  allowAnonymousOutcomeAttribution: true,
  futureSkewMs: 5 * 60 * 1000,
};

export const MIN_WINDOW_DAYS = 1;
export const MAX_WINDOW_DAYS = 365;

/** Deterministic policy resolution. Currently the governed default. */
export function resolveAttributionPolicy(): AttributionPolicy {
  return DEFAULT_ATTRIBUTION_POLICY;
}

export function assertModelAllowed(modelType: AttributionModelType, policy: AttributionPolicy): void {
  if (!policy.allowedModels.includes(modelType)) {
    throw new AttributionInputError(
      "ATTRIBUTION_MODEL_NOT_ALLOWED",
      `Attribution model ${modelType} is not in the closed allow-list for policy ${policy.policyVersion}.`
    );
  }
}

export const MIN_TOUCHPOINT_OCCURRED_YEAR = 2000;
