// ─── R10-D Provider & Integration Resilience — circuit breaker (D11) ───
//
// PURE module. Per-(tenant, provider, account, actionType) circuit breaker
// with states CLOSED → OPEN → HALF_OPEN → CLOSED. The circuit may STOP
// dispatch to an unhealthy provider/account scope. It may NEVER select a
// different provider or account: fallback is never circuit authority, and no
// circuit state grants new execution authorization (that remains R9-F).

import {
  PROVIDER_CIRCUIT_FAILURE_CLASSES,
  PROVIDER_CIRCUIT_NEUTRAL_CLASSES,
  PROVIDER_CIRCUIT_STATES,
  ProviderInputError,
  type ProviderCircuitState,
} from "./provider-resilience-contract";
import type { Clock } from "./provider-timeout";
import { systemClock } from "./provider-timeout";
import type { ProviderCircuitPolicy } from "./provider-adapter-declaration";

/** Durable circuit row shape (store-owned; pure module operates on views). */
export interface CircuitStateView {
  readonly circuitState: ProviderCircuitState;
  readonly failureCount: number;
  readonly successCount: number;
  readonly openedAtMs: number | null;
  readonly windowStartMs: number;
  readonly halfOpenProbesInFlight: number;
}

export interface CircuitEvaluation {
  readonly allowed: boolean;
  readonly state: ProviderCircuitState;
  /** Reason code when denied (CIRCUIT_OPEN); null when allowed. */
  readonly denialReason: "CIRCUIT_OPEN" | null;
  /** True while a half-open probe slot is being consumed. */
  readonly probeSlot: boolean;
}

export function emptyCircuitState(nowMs: number): CircuitStateView {
  return {
    circuitState: "CLOSED",
    failureCount: 0,
    successCount: 0,
    openedAtMs: null,
    windowStartMs: nowMs,
    halfOpenProbesInFlight: 0,
  };
}

function isFailureClassification(classification: string): boolean {
  return (PROVIDER_CIRCUIT_FAILURE_CLASSES as readonly string[]).includes(
    classification
  );
}

function isNeutralClassification(classification: string): boolean {
  return (PROVIDER_CIRCUIT_NEUTRAL_CLASSES as readonly string[]).includes(
    classification
  );
}

/**
 * Gate evaluated BEFORE a dispatch: an OPEN circuit denies dispatch;
 * HALF_OPEN admits only bounded concurrent probes; CLOSED admits. Denial is
 * recorded as CIRCUIT_BLOCKED — never as provider success or failure.
 */
export function evaluateCircuitGate(input: {
  state: CircuitStateView;
  policy: ProviderCircuitPolicy;
  nowMs: number;
}): CircuitEvaluation {
  const { state, policy, nowMs } = input;
  if (!PROVIDER_CIRCUIT_STATES.includes(state.circuitState)) {
    throw new ProviderInputError(
      "PROVIDER_INPUT_MALFORMED",
      "unknown circuit state."
    );
  }
  if (state.circuitState === "OPEN") {
    const openedAt = state.openedAtMs ?? nowMs;
    if (nowMs - openedAt < policy.openDurationMs) {
      return {
        allowed: false,
        state: "OPEN",
        denialReason: "CIRCUIT_OPEN",
        probeSlot: false,
      };
    }
    // Open duration elapsed → allow a bounded half-open probe.
    if (state.halfOpenProbesInFlight >= policy.halfOpenMaxProbes) {
      return {
        allowed: false,
        state: "HALF_OPEN",
        denialReason: "CIRCUIT_OPEN",
        probeSlot: false,
      };
    }
    return {
      allowed: true,
      state: "HALF_OPEN",
      denialReason: null,
      probeSlot: true,
    };
  }
  if (state.circuitState === "HALF_OPEN") {
    if (state.halfOpenProbesInFlight >= policy.halfOpenMaxProbes) {
      return {
        allowed: false,
        state: "HALF_OPEN",
        denialReason: "CIRCUIT_OPEN",
        probeSlot: false,
      };
    }
    return {
      allowed: true,
      state: "HALF_OPEN",
      denialReason: null,
      probeSlot: true,
    };
  }
  return {
    allowed: true,
    state: "CLOSED",
    denialReason: null,
    probeSlot: false,
  };
}

/**
 * Fold a completed dispatch classification into the circuit state.
 * RATE_LIMITED / PENDING are neutral (never open a circuit — the provider is
 * healthy but busy). UNCERTAIN, timeouts, connection resets, auth failures
 * and final failures count toward the bounded failure policy. Half-open
 * probe failures re-open immediately; closeAfterSuccesses consecutive probe
 * successes close the circuit.
 */
export function foldCircuitOutcome(input: {
  state: CircuitStateView;
  policy: ProviderCircuitPolicy;
  classification: string;
  nowMs: number;
  /** Durable dispatch origin; ordinary stragglers cannot settle probe slots. */
  probeSlot?: boolean;
}): {
  next: CircuitStateView;
  transitioned: boolean;
  fromState: ProviderCircuitState;
  toState: ProviderCircuitState;
} {
  const { state, policy, classification, nowMs } = input;
  if (
    !isFailureClassification(classification) &&
    !isNeutralClassification(classification) &&
    classification !== "SUCCEEDED" &&
    classification !== "FAILED_RETRYABLE"
  ) {
    throw new ProviderInputError(
      "PROVIDER_INPUT_MALFORMED",
      `unknown classification for circuit fold: ${String(classification)}`
    );
  }

  const fromState = state.circuitState;
  if (state.circuitState === "HALF_OPEN" && input.probeSlot === false) {
    return { next: state, transitioned: false, fromState, toState: fromState };
  }
  let next: CircuitStateView = {
    ...state,
    windowStartMs:
      nowMs - state.windowStartMs >= policy.windowMs
        ? nowMs
        : state.windowStartMs,
  };
  // Rolling window: counts reset when the window rolls.
  if (next.windowStartMs !== state.windowStartMs) {
    next = { ...next, failureCount: 0, successCount: 0 };
  }

  const probes = Math.max(
    0,
    state.halfOpenProbesInFlight -
      (input.probeSlot !== false && state.circuitState !== "CLOSED" ? 1 : 0)
  );
  next = { ...next, halfOpenProbesInFlight: probes };

  if (isNeutralClassification(classification)) {
    if (state.circuitState === "HALF_OPEN") next = { ...next, successCount: 0 };
    return { next, transitioned: false, fromState, toState: next.circuitState };
  }

  const isFailure = isFailureClassification(classification);

  if (state.circuitState === "HALF_OPEN") {
    if (isFailure) {
      next = {
        ...next,
        circuitState: "OPEN",
        openedAtMs: nowMs,
        failureCount: 1,
        successCount: 0,
        halfOpenProbesInFlight: probes,
      };
      return { next, transitioned: true, fromState, toState: "OPEN" };
    }
    const successCount = state.successCount + 1;
    if (successCount >= policy.closeAfterSuccesses) {
      next = {
        ...next,
        circuitState: "CLOSED",
        failureCount: 0,
        successCount: 0,
        openedAtMs: null,
        windowStartMs: nowMs,
        halfOpenProbesInFlight: 0,
      };
      return { next, transitioned: true, fromState, toState: "CLOSED" };
    }
    return {
      next: { ...next, successCount },
      transitioned: false,
      fromState,
      toState: "HALF_OPEN",
    };
  }

  if (state.circuitState === "CLOSED") {
    if (isFailure) {
      const failureCount = next.failureCount + 1;
      if (failureCount >= policy.failureThreshold) {
        next = {
          ...next,
          circuitState: "OPEN",
          openedAtMs: nowMs,
          failureCount,
          successCount: 0,
          halfOpenProbesInFlight: 0,
        };
        return { next, transitioned: true, fromState, toState: "OPEN" };
      }
      return {
        next: { ...next, failureCount },
        transitioned: false,
        fromState,
        toState: "CLOSED",
      };
    }
    // SUCCEEDED / FAILED_RETRYABLE in CLOSED: decay failures slowly.
    return {
      next: { ...next, failureCount: Math.max(0, next.failureCount - 1) },
      transitioned: false,
      fromState,
      toState: "CLOSED",
    };
  }

  // OPEN: outcomes should not arrive for dispatches gated earlier; fold any
  // straggler conservatively without widening authority.
  return { next, transitioned: false, fromState, toState: "OPEN" };
}

/** In-flight accounting around a gated dispatch (bounded half-open probes). */
export function beginCircuitDispatch(
  state: CircuitStateView,
  evaluation: CircuitEvaluation
): CircuitStateView {
  if (!evaluation.probeSlot) return state;
  if (!evaluation.allowed) return state;
  return {
    ...state,
    circuitState: evaluation.state,
    halfOpenProbesInFlight: state.halfOpenProbesInFlight + 1,
  };
}

/** Production circuit authority: pure gate + fold over an injected store view. */
export interface CircuitAuthority {
  evaluateGate(scope: {
    tenantUserId: number;
    providerId: string;
    providerAccountId: string;
    actionType: string;
  }): CircuitEvaluation;
  beginDispatch(scope: {
    tenantUserId: number;
    providerId: string;
    providerAccountId: string;
    actionType: string;
  }): void;
  recordOutcome(
    scope: {
      tenantUserId: number;
      providerId: string;
      providerAccountId: string;
      actionType: string;
    },
    classification: string
  ): {
    transitioned: boolean;
    fromState: ProviderCircuitState;
    toState: ProviderCircuitState;
  };
}

/** In-memory circuit authority for the sandbox harness (deterministic clock). */
export function createInMemoryCircuitAuthority(input: {
  policyFor(scope: {
    providerId: string;
    providerAccountId: string;
    actionType: string;
  }): ProviderCircuitPolicy;
  clock?: Clock;
}): CircuitAuthority {
  const clock = input.clock ?? systemClock;
  const states = new Map<string, CircuitStateView>();
  const key = (s: {
    tenantUserId: number;
    providerId: string;
    providerAccountId: string;
    actionType: string;
  }) =>
    `${s.tenantUserId}|${s.providerId}|${s.providerAccountId}|${s.actionType}`;
  return {
    evaluateGate(scope) {
      const state = states.get(key(scope)) ?? emptyCircuitState(clock.nowMs());
      return evaluateCircuitGate({
        state,
        policy: input.policyFor(scope),
        nowMs: clock.nowMs(),
      });
    },
    beginDispatch(scope) {
      const k = key(scope);
      const state = states.get(k) ?? emptyCircuitState(clock.nowMs());
      const evaluation = evaluateCircuitGate({
        state,
        policy: input.policyFor(scope),
        nowMs: clock.nowMs(),
      });
      states.set(k, beginCircuitDispatch(state, evaluation));
    },
    recordOutcome(scope, classification) {
      const k = key(scope);
      const state = states.get(k) ?? emptyCircuitState(clock.nowMs());
      const result = foldCircuitOutcome({
        state,
        policy: input.policyFor(scope),
        classification,
        nowMs: clock.nowMs(),
      });
      states.set(k, result.next);
      return {
        transitioned: result.transitioned,
        fromState: result.fromState,
        toState: result.toState,
      };
    },
  };
}
