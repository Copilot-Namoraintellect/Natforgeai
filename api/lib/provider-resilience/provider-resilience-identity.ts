// ─── R10-D Provider & Integration Resilience — deterministic identities ───
//
// PURE module (contract §3). Every identity rebuilds its hashed fragment
// field-by-field: callers cannot smuggle extra keys into a hash. Same
// authoritative inputs ⇒ same output; any material change ⇒ new identity.
// No clock, no I/O, no authority decisions.
//
// The provider request identity is DETERMINISTIC, derived from the
// authoritative R9-D action/attempt identity + the exact provider/account
// binding + the exact bounded parameters (D2/D3). A changed provider, account,
// tenant, business, capability, action, attempt or parameter set mints a new
// request identity — retries therefore can never silently broaden scope.

import { canonicalJson, sha256Hex } from "../conversion/conversion-contract";

export const PROVIDER_BINDING_ID_PREFIX = "pbd1:" as const;
export const PROVIDER_REQUEST_ID_PREFIX = "prq1:" as const;
export const PROVIDER_CALLBACK_ID_PREFIX = "prcb1:" as const;
export const PROVIDER_RECONCILIATION_ID_PREFIX = "prx1:" as const;
export const PROVIDER_CIRCUIT_ID_PREFIX = "pcb1:" as const;

/**
 * Deterministic provider-account binding identity (D2). Binds tenant +
 * business + provider + account + capability + action type. Wording/labels
 * are never identity inputs.
 */
export function deriveProviderBindingId(input: {
  tenantUserId: number;
  businessId: number;
  providerId: string;
  providerAccountId: string;
  capability: string;
  actionType: string;
}): string {
  return `${PROVIDER_BINDING_ID_PREFIX}${sha256Hex(
    canonicalJson({
      v: 1,
      tenantUserId: input.tenantUserId,
      businessId: input.businessId,
      providerId: input.providerId,
      providerAccountId: input.providerAccountId,
      capability: input.capability,
      actionType: input.actionType,
    })
  )}`;
}

/**
 * Deterministic provider request identity (D3). Derived from the exact
 * binding + the authoritative R9-D execution action/attempt + the bounded
 * parameter hash. Where the provider supports a native idempotency key this
 * identity IS the key (stable across retries of the same exact dispatch);
 * where it does not, server-side convergence anchors give effectively-once
 * dispatch and the declaration says so.
 */
export function deriveProviderRequestId(input: {
  bindingId: string;
  executionActionId: string;
  attemptId: string;
  parametersHash: string;
}): string {
  return `${PROVIDER_REQUEST_ID_PREFIX}${sha256Hex(
    canonicalJson({
      v: 1,
      bindingId: input.bindingId,
      executionActionId: input.executionActionId,
      attemptId: input.attemptId,
      parametersHash: input.parametersHash,
    })
  )}`;
}

/** Fingerprint of the bounded dispatch parameters — raw values never persist. */
export function deriveProviderParametersHash(parameters: unknown): string {
  return sha256Hex(canonicalJson({ v: 1, params: parameters ?? {} }));
}

/** Opaque credential fingerprint — the credentialRef label itself never persists. */
export function deriveCredentialFingerprint(credentialRef: string): string {
  return sha256Hex(canonicalJson({ v: 1, credentialRef }));
}

/**
 * Deterministic callback event identity (D6/D7). One durable identity per
 * (provider, account, event) — the exact-once natural anchor for callback
 * convergence.
 */
export function deriveProviderCallbackId(input: {
  providerId: string;
  providerAccountId: string;
  providerEventId: string;
}): string {
  return `${PROVIDER_CALLBACK_ID_PREFIX}${sha256Hex(
    canonicalJson({
      v: 1,
      providerId: input.providerId,
      providerAccountId: input.providerAccountId,
      providerEventId: input.providerEventId,
    })
  )}`;
}

/** Fingerprint of the bounded callback payload — raw payloads never persist. */
export function deriveCallbackPayloadHash(payload: unknown): string {
  return sha256Hex(canonicalJson({ v: 1, payload: payload ?? null }));
}

/** HMAC input for callback signature verification (D6). */
export function deriveCallbackSignaturePayload(input: {
  providerId: string;
  providerAccountId: string;
  providerEventId: string;
  occurredAt: string;
  payload: unknown;
}): string {
  return canonicalJson({
    v: 1,
    providerId: input.providerId,
    providerAccountId: input.providerAccountId,
    providerEventId: input.providerEventId,
    occurredAt: input.occurredAt,
    payload: input.payload ?? null,
  });
}

/**
 * Deterministic reconciliation record identity (D8). One durable record per
 * (request, evidence) — replays converge, conflicting evidence mints a new
 * record bound to a new attempt state, never an overwrite.
 */
export function deriveProviderReconciliationId(input: {
  requestId: string;
  outcome: string;
  evidenceHash: string;
  reconciledAt: string;
}): string {
  return `${PROVIDER_RECONCILIATION_ID_PREFIX}${sha256Hex(
    canonicalJson({
      v: 1,
      requestId: input.requestId,
      outcome: input.outcome,
      evidenceHash: input.evidenceHash,
    })
  )}`;
}

/** Deterministic circuit-breaker scope identity (D11). */
export function deriveProviderCircuitId(input: {
  tenantUserId: number;
  providerId: string;
  providerAccountId: string;
  actionType: string;
}): string {
  return `${PROVIDER_CIRCUIT_ID_PREFIX}${sha256Hex(
    canonicalJson({
      v: 1,
      tenantUserId: input.tenantUserId,
      providerId: input.providerId,
      providerAccountId: input.providerAccountId,
      actionType: input.actionType,
    })
  )}`;
}

/** Fingerprint of the redacted classification material — never raw payloads. */
export function deriveDispatchEvidenceHash(input: {
  requestId: string;
  classification: string;
  failureClass: string;
  providerReference: string | null;
  detail: unknown;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      requestId: input.requestId,
      classification: input.classification,
      failureClass: input.failureClass,
      providerReference: input.providerReference,
      detail: input.detail ?? {},
    })
  );
}
