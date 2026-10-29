// ─── R7-C Business Learning Engine — context scope & generalisation guards ───
//
// PURE module (no I/O, no clock). The context scope is derived SERVER-SIDE
// ONLY and bounds where a learning record may legitimately apply. Clients
// can never supply, widen or override it; evidence from one campaign never
// silently becomes business-wide truth, and evidence from one audience never
// silently becomes all-audience truth. Protected/sensitive traits are never
// optimisation-learning dimensions — any such dimension arriving from any
// source fails closed.

import {
  LEARNING_PROTECTED_TRAIT_SET,
  LearningInputError,
} from "./business-learning-contract";
import type { ConsumedAttributionProjection } from "./business-learning-upstream-seam";

/**
 * Server-derived bounded context scope (contract §6). Audience, geography,
 * creative-family and channel dimensions are reserved and never auto-derived:
 * they materialise only from governed evidence in a future derivation
 * version, so today they structurally cannot generalise.
 */
export interface LearningContextScope {
  readonly businessId: number;
  readonly campaignIds: readonly number[];
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly journeyStageTypes: readonly string[];
  readonly outcomeTypes: readonly string[];
}

/** Closed context-dimension keys — extension requires a derivation version bump. */
export const LEARNING_CONTEXT_DIMENSION_KEYS = [
  "businessId",
  "campaignIds",
  "windowStart",
  "windowEnd",
  "journeyStageTypes",
  "outcomeTypes",
] as const;

/** Reserved dimensions that may never be derived without governed evidence. */
export const LEARNING_RESERVED_CONTEXT_DIMENSIONS = [
  "audienceSegment",
  "geography",
  "creativeFamily",
  "channel",
] as const;

/**
 * Guard: any protected/sensitive trait dimension arriving from any source —
 * derived, resolved or (impossibly) client-supplied — fails closed. Reserved
 * dimensions are likewise rejected here; they are never produced by v1
 * derivation, and any attempt to bind one is a version drift, not a scope.
 */
export function assertContextScopeLegal(scope: Record<string, unknown>): void {
  for (const key of Object.keys(scope)) {
    if (LEARNING_PROTECTED_TRAIT_SET.has(key)) {
      throw new LearningInputError(
        "LEARNING_PROTECTED_TRAIT_DIMENSION",
        `Protected/sensitive trait dimension "${key}" can never be an optimisation-learning dimension.`
      );
    }
    if ((LEARNING_RESERVED_CONTEXT_DIMENSIONS as readonly string[]).includes(key)) {
      throw new LearningInputError(
        "LEARNING_CONTEXT_DIMENSION_UNSUPPORTED",
        `Reserved context dimension "${key}" is not derivable by this derivation version.`
      );
    }
    if (!(LEARNING_CONTEXT_DIMENSION_KEYS as readonly string[]).includes(key)) {
      throw new LearningInputError(
        "LEARNING_CONTEXT_DIMENSION_UNKNOWN",
        `Unknown context dimension "${key}" is not in the closed v1 scope.`
      );
    }
  }
}

function minIso(values: readonly string[]): string {
  return [...values].sort()[0];
}

function maxIso(values: readonly string[]): string {
  return [...values].sort().slice(-1)[0];
}

/**
 * Derives the bounded context scope from the validated evidence. The window
 * spans the attribution windows; campaign ids name exactly the credited
 * CAMPAIGN touchpoints (resolved tenant-side by the service); journey stage
 * types are the sorted credited touchpoint types. Nothing else is inferred.
 */
export function deriveContextScope(input: {
  businessId: number;
  attributions: readonly ConsumedAttributionProjection[];
  outcomeTypes: readonly string[];
  creditedCampaignIds: readonly number[];
}): LearningContextScope {
  const scope: LearningContextScope = {
    businessId: input.businessId,
    campaignIds: Object.freeze(
      [...new Set(input.creditedCampaignIds)].sort((a, b) => a - b)
    ),
    windowStart: minIso(input.attributions.map((a) => a.windowStart)),
    windowEnd: maxIso(input.attributions.map((a) => a.windowEnd)),
    journeyStageTypes: Object.freeze(
      [
        ...new Set(
          input.attributions.flatMap((a) =>
            a.touchpoints.filter((t) => t.eligibility === "eligible" && t.creditBps > 0
            ).map((t) => t.type)
          )
        ),
      ].sort()
    ),
    outcomeTypes: Object.freeze([...new Set(input.outcomeTypes)].sort()),
  };
  assertContextScopeLegal({ ...scope });
  return scope;
}

/**
 * Scope compatibility for novelty comparison (§8): candidate evidence is
 * comparable with existing learning when the business is equal and the
 * candidate's evidenced campaigns are a subset of (or equal to) the existing
 * set — broader-context comparison without evidence is never inferred.
 */
export function isScopeComparable(
  candidate: LearningContextScope,
  existing: LearningContextScope
): boolean {
  if (candidate.businessId !== existing.businessId) return false;
  return candidate.campaignIds.every((id) => existing.campaignIds.includes(id));
}
