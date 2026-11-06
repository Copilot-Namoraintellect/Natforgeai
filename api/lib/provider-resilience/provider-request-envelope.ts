// ─── R10-D Provider & Integration Resilience — request envelope (D2/D3) ───
//
// PURE module. Builds the deterministic provider request envelope: the
// server-side binding of tenant + business + provider + account + capability
// + action + exact parameters + R9-D action/attempt identity. The envelope
// is the only object an adapter ever receives — clients and models never
// touch it. It contains no credentials, no URLs, no shell/SQL/tool material.

import {
  MAX_PARAMETERS_CANONICAL_CHARS,
  SECRET_MATERIAL_REJECTED,
  ProviderInputError,
  providerParametersSchema,
} from "./provider-resilience-contract";
import { canonicalJson } from "../conversion/conversion-contract";
import {
  deriveProviderParametersHash,
  deriveProviderRequestId,
  deriveProviderBindingId,
} from "./provider-resilience-identity";
import type { ProviderBindingView } from "./provider-binding";
import type {
  ProviderExecutionActionView,
  ProviderExecutionAttemptView,
} from "./provider-binding";

/** The server-built dispatch envelope (contract §4). Secret-free by construction. */
export interface ProviderRequestEnvelope {
  readonly version: "provider-request-envelope/v1";
  readonly bindingId: string;
  readonly tenantUserId: number;
  readonly businessId: number;
  readonly providerId: string;
  readonly providerAccountId: string;
  readonly capability: string;
  readonly actionType: string;
  readonly executionActionId: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
  /** Deterministic provider request identity (D3). */
  readonly requestId: string;
  /**
   * Native idempotency key forwarded to providers that declared
   * idempotencySupport=native_key. Identical to requestId — stable across
   * exact retries, never client-generated. Null when the provider offers no
   * native key (limitation explicit in the declaration).
   */
  readonly nativeIdempotencyKey: string | null;
  /** Fingerprint of the bounded parameters — raw parameter values never persist. */
  readonly parametersHash: string;
  /** Bounded, secret-scrubbed dispatch payload — never credentials. */
  readonly payload: Record<string, unknown>;
  /** Closed execution capability keys bound as input references. */
  readonly inputRefs: readonly string[];
}

export function buildProviderRequestEnvelope(input: {
  binding: ProviderBindingView;
  action: ProviderExecutionActionView;
  attempt: ProviderExecutionAttemptView;
  parameters: Record<string, unknown>;
  inputRefs: readonly string[];
  idempotencySupport: "native_key" | "server_convergence_only" | "none";
}): ProviderRequestEnvelope {
  providerParametersSchema.parse(input.parameters);
  const canonical = canonicalJson(input.parameters ?? {});
  if (canonical.length > MAX_PARAMETERS_CANONICAL_CHARS) {
    throw new ProviderInputError(
      "PROVIDER_INPUT_MALFORMED",
      `dispatch parameters exceed ${MAX_PARAMETERS_CANONICAL_CHARS} canonical chars.`
    );
  }
  const parametersHash = deriveProviderParametersHash(input.parameters ?? {});
  const requestId = deriveProviderRequestId({
    bindingId: input.binding.bindingId,
    executionActionId: input.action.executionActionId,
    attemptId: input.attempt.attemptId,
    parametersHash,
  });
  const envelope: ProviderRequestEnvelope = {
    version: "provider-request-envelope/v1",
    bindingId: input.binding.bindingId,
    tenantUserId: input.binding.userId,
    businessId: input.binding.businessId,
    providerId: input.binding.providerId,
    providerAccountId: input.binding.providerAccountId,
    capability: input.binding.capability,
    actionType: input.binding.actionType,
    executionActionId: input.action.executionActionId,
    attemptId: input.attempt.attemptId,
    attemptNumber: input.attempt.attemptNumber,
    requestId,
    nativeIdempotencyKey:
      input.idempotencySupport === "native_key" ? requestId : null,
    parametersHash,
    payload: JSON.parse(JSON.stringify(input.parameters ?? {})),
    inputRefs: [...input.inputRefs],
  };
  const freeze = (value: unknown): void => {
    if (value && typeof value === "object") {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
  };
  freeze(envelope);
  return envelope;
}

/**
 * Envelope integrity re-check: an envelope stored earlier must still match
 * the exact binding coordinates. Drift (substituted provider/account/params)
 * fails closed before any adapter call.
 */
export function assertEnvelopeIntegrity(
  envelope: ProviderRequestEnvelope
): void {
  if (envelope.version !== "provider-request-envelope/v1") {
    throw new ProviderInputError(
      "PROVIDER_INPUT_MALFORMED",
      "unknown request envelope version."
    );
  }
  if (
    deriveProviderBindingId({
      tenantUserId: envelope.tenantUserId,
      businessId: envelope.businessId,
      providerId: envelope.providerId,
      providerAccountId: envelope.providerAccountId,
      capability: envelope.capability,
      actionType: envelope.actionType,
    }) !== envelope.bindingId
  )
    throw new ProviderInputError(
      "BINDING_MISMATCH",
      "envelope binding coordinates drifted"
    );
  const canonical = canonicalJson(envelope.payload ?? {});
  if (canonical.length > MAX_PARAMETERS_CANONICAL_CHARS) {
    throw new ProviderInputError(
      "PROVIDER_INPUT_MALFORMED",
      "envelope payload exceeds bounded canonical size."
    );
  }
  if (
    deriveProviderParametersHash(envelope.payload) !== envelope.parametersHash
  ) {
    throw new ProviderInputError(
      "PROVIDER_INPUT_MALFORMED",
      "envelope payload drifted from its parameter hash."
    );
  }
  if (
    deriveProviderRequestId({
      bindingId: envelope.bindingId,
      executionActionId: envelope.executionActionId,
      attemptId: envelope.attemptId,
      parametersHash: envelope.parametersHash,
    }) !== envelope.requestId
  ) {
    throw new ProviderInputError(
      "PROVIDER_INPUT_MALFORMED",
      "envelope request identity drifted from its coordinates."
    );
  }
}

export function scrubEnvelopeForDiagnostics(
  envelope: ProviderRequestEnvelope
): Record<string, unknown> {
  // The envelope is secret-free by construction; this is the defence-in-depth
  // re-scan asserted by the acceptance suite (credential absent from logs).
  const canonical = canonicalJson(envelope);
  if (/"(api[_-]?key|secret|token|password|credential)"/i.test(canonical)) {
    throw new ProviderInputError(
      SECRET_MATERIAL_REJECTED,
      "envelope carries secret-like material; refused."
    );
  }
  return {
    version: envelope.version,
    bindingId: envelope.bindingId,
    tenantUserId: envelope.tenantUserId,
    businessId: envelope.businessId,
    providerId: envelope.providerId,
    providerAccountId: envelope.providerAccountId,
    capability: envelope.capability,
    actionType: envelope.actionType,
    executionActionId: envelope.executionActionId,
    attemptId: envelope.attemptId,
    requestId: envelope.requestId,
    nativeIdempotencyKey: envelope.nativeIdempotencyKey,
    parametersHash: envelope.parametersHash,
    inputRefs: envelope.inputRefs,
  };
}
