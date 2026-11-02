// ─── R10-D Provider & Integration Resilience — callback convergence (D7) ───
//
// PURE module. Deterministic convergence policy for validated callbacks:
//
//   duplicate callback  → converges to the existing durable event
//                         (idempotent_replay; zero new effects)
//   conflicting callback (same event identity, different material)
//                       → quarantined as new evidence; the authoritative
//                         dispatch outcome is NEVER silently overwritten
//   new callback        → applied to the bound request with conservative
//                         classification; preserve evidence always
//
// The raw callback payload never persists — only hashes and closed labels.

import type { CanonicalCallbackMaterial } from "./provider-callback-validation";
import type { ProviderCallbackDisposition } from "./provider-resilience-contract";

/** Read-only existing-callback view used by convergence. */
export interface ExistingCallbackView {
  readonly callbackId: string;
  readonly payloadHash: string;
  readonly disposition: ProviderCallbackDisposition;
}

export type ConvergenceDecision =
  | {
      readonly disposition: "ACCEPTED_NEW";
      readonly material: CanonicalCallbackMaterial;
    }
  | {
      readonly disposition: "DUPLICATE_CONVERGED";
      readonly existing: ExistingCallbackView;
    }
  | {
      readonly disposition: "CONFLICT_QUARANTINED";
      readonly existing: ExistingCallbackView;
      readonly material: CanonicalCallbackMaterial;
    };

/**
 * Decide how a VALIDATED callback converges against the durable callback
 * anchor for its exact (provider, account, event) identity.
 */
export function convergeProviderCallback(input: {
  material: CanonicalCallbackMaterial;
  existing: ExistingCallbackView | null;
}): ConvergenceDecision {
  const { material, existing } = input;
  if (existing === null) {
    return { disposition: "ACCEPTED_NEW", material };
  }
  if (existing.payloadHash === material.payloadHash) {
    return { disposition: "DUPLICATE_CONVERGED", existing };
  }
  // Same provider event identity, different material: preserve BOTH. The new
  // material is quarantined; the prior outcome is never silently overwritten.
  return { disposition: "CONFLICT_QUARANTINED", existing, material };
}

/**
 * Whether a converged callback may transition the bound dispatch request.
 * Only ACCEPTED_NEW transitions; duplicates and quarantined conflicts are
 * evidence-only (the dispatch row — and any terminal outcome — is untouched).
 */
export function mayTransitionDispatch(decision: ConvergenceDecision): boolean {
  return decision.disposition === "ACCEPTED_NEW";
}
