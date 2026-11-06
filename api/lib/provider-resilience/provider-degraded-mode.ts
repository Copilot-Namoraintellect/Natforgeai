// ─── R10-D Provider & Integration Resilience — degraded mode (D12) ───
//
// PURE module. Safe degraded responses to provider distress. A degraded mode
// is a bounded, conservative posture — it may pause, queue safely, remain
// pending, request operator attention or require reauthorization. It NEVER
// silently widens scope: no fallback provider, no substitute account, no
// broadened parameters, no self-authorized retry.

import type { ProviderDegradedMode } from "./provider-resilience-contract";

export interface DegradedAssessment {
  readonly mode: ProviderDegradedMode;
  /** Closed reason labels (bounded). */
  readonly reasons: readonly string[];
  /** Human-safe posture note — never an authority grant. */
  readonly note: string;
}

/**
 * Derive the safe degraded mode from a classified outcome. The mapping is
 * deterministic and closed:
 *
 *   UNCERTAIN              → REMAIN_PENDING (reconciliation owns follow-up)
 *   RATE_LIMITED           → QUEUE_SAFELY (visible retry-after; no auto retry)
 *   AUTHENTICATION_FAILED  → REQUIRE_REAUTHORIZATION (credential boundary)
 *   CIRCUIT_BLOCKED        → PAUSE_DISPATCH (operator attention advised)
 *   FAILED_FINAL           → REQUEST_OPERATOR_ATTENTION (no silent retry)
 *   FAILED_RETRYABLE       → NONE (governed retry may be requested upstream)
 *   PENDING                → REMAIN_PENDING
 *   SUCCEEDED              → NONE
 */
export function deriveDegradedMode(input: {
  classification: string;
  circuitState: string;
}): DegradedAssessment {
  const { classification, circuitState } = input;
  switch (classification) {
    case "SUCCEEDED":
      return { mode: "NONE", reasons: [], note: "no degraded posture." };
    case "FAILED_RETRYABLE":
      return {
        mode: "NONE",
        reasons: ["retryable_failure"],
        note: "retryable failure classified; any retry requires fresh governed authorization — never self-authorized here.",
      };
    case "RATE_LIMITED":
      return {
        mode: "QUEUE_SAFELY",
        reasons: ["provider_rate_limited"],
        note: "provider rate limit visible; the request may be queued safely behind the declared limit — uncontrolled retries are refused.",
      };
    case "AUTHENTICATION_FAILED":
      return {
        mode: "REQUIRE_REAUTHORIZATION",
        reasons: ["authentication_failed"],
        note: "provider authentication failed; credential reauthorization is required — the degraded mode itself grants nothing.",
      };
    case "CIRCUIT_BLOCKED":
      return {
        mode:
          circuitState === "OPEN"
            ? "PAUSE_DISPATCH"
            : "REQUEST_OPERATOR_ATTENTION",
        reasons: ["circuit_blocked"],
        note: "circuit breaker stopped dispatch to this provider/account scope; no fallback or substitution is authorized.",
      };
    case "UNCERTAIN":
      return {
        mode: "REMAIN_PENDING",
        reasons: ["outcome_uncertain"],
        note: "ambiguous outcome remains pending until reconciliation confirms success or failure with evidence.",
      };
    case "PENDING":
      return {
        mode: "REMAIN_PENDING",
        reasons: ["provider_pending"],
        note: "provider accepted the request; the outcome remains pending until terminal evidence arrives.",
      };
    case "FAILED_FINAL":
      return {
        mode: "REQUEST_OPERATOR_ATTENTION",
        reasons: ["final_failure"],
        note: "final provider failure; operator attention requested — no silent retry, no scope change.",
      };
    default:
      return {
        mode: "REQUEST_OPERATOR_ATTENTION",
        reasons: ["unclassified_outcome"],
        note: "unclassified outcome treated conservatively; operator attention requested.",
      };
  }
}
