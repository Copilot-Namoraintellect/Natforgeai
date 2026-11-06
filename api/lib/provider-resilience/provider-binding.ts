// ─── R10-D Provider & Integration Resilience — exact binding validation (D2) ───
//
// PURE module. Execution must bind the EXACT authorized provider, provider
// account, tenant, business, capability, action and parameters. Provider
// substitution is NOT automatically allowed; account substitution is NOT
// automatically allowed. The binding row is the only authority that maps
// (tenant, business, provider, account, capability, actionType); every
// dispatch and every callback is re-validated against it field-by-field.

import {
  BINDING_MISMATCH,
  CROSS_BUSINESS_BINDING,
  CROSS_TENANT_BINDING,
  ProviderOwnershipError,
  ProviderUpstreamError,
  type ProviderBindingStatus,
} from "./provider-resilience-contract";

/** Read-only binding view consumed by the service (store row shape). */
export interface ProviderBindingView {
  readonly bindingId: string;
  readonly userId: number;
  readonly businessId: number;
  readonly providerId: string;
  readonly providerAccountId: string;
  readonly capability: string;
  readonly actionType: string;
  readonly status: ProviderBindingStatus;
  readonly credentialFingerprint: string;
  readonly version: number;
}

/** Read-only R9-D execution action view consumed by the binding check. */
export interface ProviderExecutionActionView {
  readonly executionActionId: string;
  readonly userId: number;
  readonly businessId: number;
  readonly actionType: string;
  readonly adapterType: string;
  readonly capability: string;
  readonly actionParametersHash: string;
  readonly missionId: string;
  readonly planId: string;
  readonly scheduleId: string;
  readonly taskId: string;
  readonly taskType: string;
}

/** Read-only R9-D execution attempt view consumed by the binding check. */
export interface ProviderExecutionAttemptView {
  readonly attemptId: string;
  readonly executionActionId: string;
  readonly attemptNumber: number;
  readonly dispatchState?: string;
  readonly resultStatus: string | null;
}

/** R9-D adapter class → binding capability mapping (closed, mirrors R9-D). */
export const ADAPTER_CAPABILITY_BINDING: Readonly<Record<string, string>> =
  Object.freeze({
    CAMPAIGN: "campaign.activate",
    CONTENT: "content.dispatch",
    SOCIAL: "social.publish",
    CRM: "crm.record",
    NOTIFICATION: "notification.send",
    ANALYTICS: "analytics.record",
    INTERNAL_WORKFLOW: "workflow.run",
  });

/** Tenant scope: the binding must belong to the calling tenant. */
export function assertBindingTenantScope(
  binding: ProviderBindingView,
  tenantUserId: number
): void {
  if (binding.userId !== tenantUserId) {
    throw new ProviderOwnershipError(
      CROSS_TENANT_BINDING,
      "binding belongs to a different tenant; cross-tenant provider binding is rejected."
    );
  }
}

/**
 * Exact binding validation for a dispatch (D2). Every coordinate must match:
 * tenant, business, provider capability (via the R9-D action's adapter
 * class), action type, and the exact bounded parameter hash. A provider or
 * account substitution attempt fails closed with BINDING_MISMATCH.
 */
export function assertExactDispatchBinding(input: {
  binding: ProviderBindingView;
  action: ProviderExecutionActionView;
  attempt: ProviderExecutionAttemptView;
  parametersHash: string;
}): void {
  const { binding, action, attempt, parametersHash } = input;
  assertBindingTenantScope(binding, action.userId);
  if (binding.businessId !== action.businessId) {
    throw new ProviderOwnershipError(
      CROSS_BUSINESS_BINDING,
      "binding business does not match the execution action's business; cross-business binding is rejected."
    );
  }
  if (attempt.executionActionId !== action.executionActionId) {
    throw new ProviderUpstreamError(
      BINDING_MISMATCH,
      "attempt does not belong to the named execution action."
    );
  }
  const expectedCapability = ADAPTER_CAPABILITY_BINDING[action.adapterType];
  if (
    !expectedCapability ||
    binding.capability !== expectedCapability ||
    binding.capability !== action.capability
  ) {
    throw new ProviderUpstreamError(
      BINDING_MISMATCH,
      "binding capability does not match the execution action's authorized capability."
    );
  }
  if (binding.actionType !== action.actionType) {
    throw new ProviderUpstreamError(
      BINDING_MISMATCH,
      "binding action type does not match the execution action's authorized action type."
    );
  }
  if (parametersHash !== action.actionParametersHash) {
    throw new ProviderUpstreamError(
      BINDING_MISMATCH,
      "dispatch parameters drifted from the authorized action parameters; exact binding failed."
    );
  }
}

/**
 * Exact binding validation for a callback (D2/D6): the callback's provider
 * account must equal the binding's account; a cross-account callback is
 * rejected. Tenant scope is enforced by the caller (binding loaded by id).
 */
export function assertExactCallbackBinding(input: {
  binding: ProviderBindingView;
  providerId: string;
  providerAccountId: string;
}): void {
  if (
    input.binding.providerId !== input.providerId ||
    input.binding.providerAccountId !== input.providerAccountId
  ) {
    throw new ProviderUpstreamError(
      BINDING_MISMATCH,
      "callback provider/account does not exactly match the bound provider account; cross-account callback rejected."
    );
  }
}
