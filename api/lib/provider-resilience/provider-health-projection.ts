// ─── R10-D Provider & Integration Resilience — health handoff (D14) ───
//
// PURE module. Builds the read-only `provider-health/v1` projection for
// R10-E observability/operations. Exposes bounded health signals:
// availability, latency, timeout rate, rate-limit state, authentication
// failures, callback lag, reconciliation backlog and circuit-breaker state.
//
// Observability does not gain provider authority: the projection is a frozen
// key allowlist, read-only, carries verbatim disclaimers, and its possession
// can never authorize dispatch, fallback, switching or reauthorization.

import {
  PROVIDER_HEALTH_PROJECTION_VERSION,
  PROVIDER_HEALTH_DISCLAIMER,
  PROVIDER_TRUTH_DISCLAIMER,
} from "./provider-resilience-contract";
import type { ProviderHealthCapability } from "./provider-resilience-contract";
import type { CircuitStateView } from "./provider-circuit-breaker";

/** Frozen projection key allowlist (exact — asserted in acceptance). */
export const PROVIDER_HEALTH_PROJECTION_KEYS = [
  "contractVersion",
  "tenantUserId",
  "businessId",
  "providerId",
  "providerAccountId",
  "availabilityBps",
  "latencyMsAvg",
  "timeoutRateBps",
  "rateLimitedCount",
  "authenticationFailureCount",
  "callbackLagMsAvg",
  "reconciliationBacklog",
  "circuitState",
  "sampleCount",
  "windowMs",
  "healthDisclaimer",
  "truthDisclaimer",
] as const;
export type ProviderHealthProjectionKey =
  (typeof PROVIDER_HEALTH_PROJECTION_KEYS)[number];

export interface DispatchSampleView {
  readonly classification: string;
  readonly failureClass: string;
  readonly dispatchedAtMs: number | null;
  readonly completedAtMs: number | null;
}

export interface CallbackSampleView {
  readonly receivedAtMs: number;
  readonly occurredAtMs: number;
}

export interface ProviderHealthInput {
  readonly tenantUserId: number;
  readonly businessId: number;
  readonly providerId: string;
  readonly providerAccountId: string;
  readonly declaredCapabilities: readonly ProviderHealthCapability[];
  readonly windowMs: number;
  readonly dispatches: readonly DispatchSampleView[];
  readonly callbacks: readonly CallbackSampleView[];
  readonly reconciliationBacklogCount: number;
  readonly circuit: CircuitStateView | null;
}

const BPS = 10_000;

/**
 * Derive the frozen health projection from bounded sample views. Only
 * capabilities the provider declared in its adapter declaration are
 * populated; undeclared signals are null (never fabricated).
 */
export function buildProviderHealthProjection(
  input: ProviderHealthInput
): Record<string, unknown> {
  const declared = new Set(input.declaredCapabilities);
  const samples = input.dispatches.slice(0, 500);
  const sampleCount = samples.length;

  let availabilityBps: number | null = null;
  let timeoutRateBps: number | null = null;
  let latencyMsAvg: number | null = null;
  let rateLimitedCount: number | null = null;
  let authenticationFailureCount: number | null = null;
  let callbackLagMsAvg: number | null = null;

  if (declared.has("availability") && sampleCount > 0) {
    const succeeded = samples.filter(
      s => s.classification === "SUCCEEDED"
    ).length;
    availabilityBps = Math.round((succeeded / sampleCount) * BPS);
  }
  if (declared.has("timeout_rate") && sampleCount > 0) {
    const timeouts = samples.filter(s => s.failureClass === "TIMEOUT").length;
    timeoutRateBps = Math.round((timeouts / sampleCount) * BPS);
  }
  if (declared.has("latency")) {
    const latencies = samples
      .filter(
        s =>
          s.dispatchedAtMs !== null &&
          s.completedAtMs !== null &&
          s.completedAtMs >= s.dispatchedAtMs!
      )
      .map(s => s.completedAtMs! - s.dispatchedAtMs!);
    latencyMsAvg =
      latencies.length > 0
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
        : null;
  }
  if (declared.has("rate_limit_state")) {
    rateLimitedCount = samples.filter(
      s => s.classification === "RATE_LIMITED"
    ).length;
  }
  if (declared.has("authentication_failures")) {
    authenticationFailureCount = samples.filter(
      s => s.classification === "AUTHENTICATION_FAILED"
    ).length;
  }
  if (declared.has("callback_lag") && input.callbacks.length > 0) {
    const lags = input.callbacks.map(c =>
      Math.max(0, c.receivedAtMs - c.occurredAtMs)
    );
    callbackLagMsAvg = Math.round(
      lags.reduce((a, b) => a + b, 0) / lags.length
    );
  }

  return {
    contractVersion: PROVIDER_HEALTH_PROJECTION_VERSION,
    tenantUserId: input.tenantUserId,
    businessId: input.businessId,
    providerId: input.providerId,
    providerAccountId: input.providerAccountId,
    availabilityBps,
    latencyMsAvg,
    timeoutRateBps,
    rateLimitedCount,
    authenticationFailureCount,
    callbackLagMsAvg,
    reconciliationBacklog: declared.has("reconciliation_backlog")
      ? input.reconciliationBacklogCount
      : null,
    circuitState:
      declared.has("circuit_state") && input.circuit
        ? input.circuit.circuitState
        : null,
    sampleCount,
    windowMs: input.windowMs,
    healthDisclaimer: PROVIDER_HEALTH_DISCLAIMER,
    truthDisclaimer: PROVIDER_TRUTH_DISCLAIMER,
  };
}

export function assertHealthProjectionShape(
  projection: Record<string, unknown>
): void {
  const keys = Object.keys(projection).sort();
  const expected = [...PROVIDER_HEALTH_PROJECTION_KEYS].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    throw new Error(
      `provider-health/v1 projection key drift: got [${keys.join(",")}], expected [${expected.join(",")}].`
    );
  }
}
