// ─── R10-D Provider & Integration Resilience — adapter declaration (D1) ───
//
// PURE module. Every production provider adapter MUST declare a closed
// capability surface before any binding can reference it:
//
//   providerId, adapterVersion, capabilities[], supportedActionTypes[],
//   idempotencySupport, callbackSupport, reconciliationSupport,
//   rateLimitModel, timeoutModel, credentialBindingType, accountBindingType,
//   healthCapabilities.
//
// Closed declaration only — no arbitrary model-generated capability. The
// declaration is code-level, versioned and immutable at runtime; there is no
// endpoint that mutates it. Declarations never carry credentials.

import {
  PROVIDER_ACCOUNT_BINDING_TYPE,
  PROVIDER_CALLBACK_SUPPORT,
  PROVIDER_CREDENTIAL_BINDING_TYPE,
  PROVIDER_HEALTH_CAPABILITIES,
  PROVIDER_IDEMPOTENCY_SUPPORT,
  PROVIDER_RATE_LIMIT_MODEL,
  PROVIDER_RECONCILIATION_SUPPORT,
  PROVIDER_TIMEOUT_MODEL,
  ProviderInputError,
  type ProviderAccountBindingType,
  type ProviderCallbackSupport,
  type ProviderCredentialBindingType,
  type ProviderHealthCapability,
  type ProviderIdempotencySupport,
  type ProviderRateLimitModel,
  type ProviderReconciliationSupport,
  type ProviderTimeoutModel,
} from "./provider-resilience-contract";
import type {
  ProviderBindingCapability,
  ProviderBoundActionType,
} from "./provider-resilience-contract";

export const PROVIDER_ADAPTER_DECLARATION_VERSION =
  "provider-adapter-declaration/v1" as const;

/** Timeout model numbers (D5) — conservative defaults, per-declaration. */
export interface ProviderTimeoutSpec {
  readonly connectTimeoutMs: number;
  readonly readTimeoutMs: number;
}

/** Rate-limit model numbers (D9). */
export interface ProviderRateLimitSpec {
  /** Window length for request_window models. */
  readonly windowMs: number;
  /** Max requests per window per scope. */
  readonly maxRequestsPerWindow: number;
  /** Token bucket capacity (token_bucket models). */
  readonly burstCapacity: number;
  /** Sustained refill rate per second (token_bucket models). */
  readonly refillPerSecond: number;
}

/** Circuit policy numbers (D11) — bounded failure policy per declaration. */
export interface ProviderCircuitPolicy {
  /** Failures within the window that open the circuit. */
  readonly failureThreshold: number;
  /** Rolling window over which failures are counted. */
  readonly windowMs: number;
  /** How long an open circuit stays open before half-open probes. */
  readonly openDurationMs: number;
  /** Maximum concurrent half-open probe dispatches. */
  readonly halfOpenMaxProbes: number;
  /** Consecutive probe successes that close the circuit. */
  readonly closeAfterSuccesses: number;
}

/** Bounded backoff policy numbers (D10). */
export interface ProviderBackoffSpec {
  readonly baseDelayMs: number;
  readonly multiplier: number;
  readonly maxDelayMs: number;
  /** Jitter ratio ∈ [0,1] applied deterministically. */
  readonly jitterRatio: number;
  /** Attempt after which backoff gives up and demands reauthorization. */
  readonly maxAttempts: number;
}

/**
 * The closed provider adapter declaration (D1). Every field is required;
 * `validateProviderAdapterDeclaration` rejects anything partial, unknown or
 * out of range. Models/clients can never mint or extend a declaration.
 */
export interface ProviderAdapterDeclaration {
  readonly providerId: string;
  readonly adapterVersion: string;
  readonly capabilities: readonly ProviderBindingCapability[];
  readonly supportedActionTypes: readonly ProviderBoundActionType[];
  readonly idempotencySupport: ProviderIdempotencySupport;
  readonly callbackSupport: ProviderCallbackSupport;
  readonly reconciliationSupport: ProviderReconciliationSupport;
  readonly rateLimitModel: ProviderRateLimitModel;
  readonly timeoutModel: ProviderTimeoutModel;
  readonly credentialBindingType: ProviderCredentialBindingType;
  readonly accountBindingType: ProviderAccountBindingType;
  readonly healthCapabilities: readonly ProviderHealthCapability[];
  readonly timeouts: ProviderTimeoutSpec;
  readonly rateLimits: ProviderRateLimitSpec;
  readonly circuitPolicy: ProviderCircuitPolicy;
  readonly backoff: ProviderBackoffSpec;
}

const DECLARATION_DEFAULTS = {
  timeouts: { connectTimeoutMs: 5_000, readTimeoutMs: 15_000 },
  rateLimits: {
    windowMs: 60_000,
    maxRequestsPerWindow: 60,
    burstCapacity: 10,
    refillPerSecond: 1,
  },
  circuitPolicy: {
    failureThreshold: 5,
    windowMs: 60_000,
    openDurationMs: 30_000,
    halfOpenMaxProbes: 1,
    closeAfterSuccesses: 2,
  },
  backoff: {
    baseDelayMs: 1_000,
    multiplier: 2,
    maxDelayMs: 60_000,
    jitterRatio: 0.2,
    maxAttempts: 8,
  },
} as const;

function isIn<T extends string>(set: readonly T[], value: unknown): value is T {
  return (
    typeof value === "string" && (set as readonly string[]).includes(value)
  );
}

/**
 * Strict declaration validation. Throws ProviderInputError
 * (PROVIDER_DECLARATION_INVALID) on any partial, duplicate, unknown or
 * out-of-range field. Health capabilities are deduped; a provider that does
 * not declare a health capability never emits it in the D14 projection.
 */
export function validateProviderAdapterDeclaration(
  raw: unknown
): ProviderAdapterDeclaration {
  if (!raw || typeof raw !== "object") {
    throw new ProviderInputError(
      "PROVIDER_DECLARATION_INVALID",
      "declaration must be an object."
    );
  }
  const d = raw as Record<string, unknown>;
  const required = [
    "providerId",
    "adapterVersion",
    "capabilities",
    "supportedActionTypes",
    "idempotencySupport",
    "callbackSupport",
    "reconciliationSupport",
    "rateLimitModel",
    "timeoutModel",
    "credentialBindingType",
    "accountBindingType",
    "healthCapabilities",
  ] as const;
  const allowed = [
    ...required,
    "timeouts",
    "rateLimits",
    "circuitPolicy",
    "backoff",
  ] as readonly string[];
  if (Object.keys(d).some(key => !allowed.includes(key)))
    throw new ProviderInputError(
      "PROVIDER_DECLARATION_INVALID",
      "unknown declaration field"
    );
  for (const [name, defaults] of Object.entries(DECLARATION_DEFAULTS)) {
    const spec = d[name];
    if (
      spec !== undefined &&
      (!spec ||
        typeof spec !== "object" ||
        Array.isArray(spec) ||
        Object.keys(spec).some(key => !(key in defaults)))
    )
      throw new ProviderInputError(
        "PROVIDER_DECLARATION_INVALID",
        "unknown policy field"
      );
  }
  for (const key of required) {
    if (!(key in d) || d[key] === undefined || d[key] === null) {
      throw new ProviderInputError(
        "PROVIDER_DECLARATION_INVALID",
        `declaration missing required field ${key}.`
      );
    }
  }
  if (
    typeof d.providerId !== "string" ||
    !/^[a-z][a-z0-9_-]{1,31}$/.test(d.providerId)
  ) {
    throw new ProviderInputError(
      "PROVIDER_DECLARATION_INVALID",
      "providerId must match the closed provider-id pattern."
    );
  }
  if (
    typeof d.adapterVersion !== "string" ||
    d.adapterVersion.length === 0 ||
    d.adapterVersion.length > 64
  ) {
    throw new ProviderInputError(
      "PROVIDER_DECLARATION_INVALID",
      "adapterVersion must be a bounded non-empty string."
    );
  }
  if (!Array.isArray(d.capabilities) || d.capabilities.length === 0) {
    throw new ProviderInputError(
      "PROVIDER_DECLARATION_INVALID",
      "capabilities must be a non-empty closed array."
    );
  }
  const capabilities = [...new Set(d.capabilities)];
  for (const c of capabilities) {
    if (!isIn(PROVIDER_BINDING_CAPABILITIES_DECLARED, c)) {
      throw new ProviderInputError(
        "PROVIDER_DECLARATION_INVALID",
        `unknown capability ${String(c)}; capability vocabulary is closed.`
      );
    }
  }
  if (
    !Array.isArray(d.supportedActionTypes) ||
    d.supportedActionTypes.length === 0
  ) {
    throw new ProviderInputError(
      "PROVIDER_DECLARATION_INVALID",
      "supportedActionTypes must be a non-empty closed array."
    );
  }
  const supportedActionTypes = [...new Set(d.supportedActionTypes)];
  if (
    capabilities.length !== d.capabilities.length ||
    supportedActionTypes.length !== d.supportedActionTypes.length
  )
    throw new ProviderInputError(
      "PROVIDER_DECLARATION_INVALID",
      "duplicate capability or action"
    );
  for (const a of supportedActionTypes) {
    if (!isIn(["EXECUTE_TASK", "EXECUTE_STEP", "RETRY_STEP"] as const, a)) {
      throw new ProviderInputError(
        "PROVIDER_DECLARATION_INVALID",
        `unknown supported action type ${String(a)}.`
      );
    }
  }
  if (!isIn(PROVIDER_IDEMPOTENCY_SUPPORT, d.idempotencySupport)) {
    throw new ProviderInputError(
      "PROVIDER_DECLARATION_INVALID",
      "idempotencySupport is not a closed value."
    );
  }
  if (!isIn(PROVIDER_CALLBACK_SUPPORT, d.callbackSupport)) {
    throw new ProviderInputError(
      "PROVIDER_DECLARATION_INVALID",
      "callbackSupport is not a closed value."
    );
  }
  if (!isIn(PROVIDER_RECONCILIATION_SUPPORT, d.reconciliationSupport)) {
    throw new ProviderInputError(
      "PROVIDER_DECLARATION_INVALID",
      "reconciliationSupport is not a closed value."
    );
  }
  if (!isIn(PROVIDER_RATE_LIMIT_MODEL, d.rateLimitModel)) {
    throw new ProviderInputError(
      "PROVIDER_DECLARATION_INVALID",
      "rateLimitModel is not a closed value."
    );
  }
  if (!isIn(PROVIDER_TIMEOUT_MODEL, d.timeoutModel)) {
    throw new ProviderInputError(
      "PROVIDER_DECLARATION_INVALID",
      "timeoutModel is not a closed value."
    );
  }
  if (!isIn(PROVIDER_CREDENTIAL_BINDING_TYPE, d.credentialBindingType)) {
    throw new ProviderInputError(
      "PROVIDER_DECLARATION_INVALID",
      "credentialBindingType is not a closed value."
    );
  }
  if (!isIn(PROVIDER_ACCOUNT_BINDING_TYPE, d.accountBindingType)) {
    throw new ProviderInputError(
      "PROVIDER_DECLARATION_INVALID",
      "accountBindingType is not a closed value."
    );
  }
  if (!Array.isArray(d.healthCapabilities)) {
    throw new ProviderInputError(
      "PROVIDER_DECLARATION_INVALID",
      "healthCapabilities must be an array."
    );
  }
  const healthCapabilities = [...new Set(d.healthCapabilities)];
  for (const h of healthCapabilities) {
    if (!isIn(PROVIDER_HEALTH_CAPABILITIES, h)) {
      throw new ProviderInputError(
        "PROVIDER_DECLARATION_INVALID",
        `unknown health capability ${String(h)}.`
      );
    }
  }

  const timeouts = {
    ...DECLARATION_DEFAULTS.timeouts,
    ...(d.timeouts ?? {}),
  } as Record<string, unknown>;
  const rateLimits = {
    ...DECLARATION_DEFAULTS.rateLimits,
    ...(d.rateLimits ?? {}),
  } as Record<string, unknown>;
  const circuitPolicy = {
    ...DECLARATION_DEFAULTS.circuitPolicy,
    ...(d.circuitPolicy ?? {}),
  } as Record<string, unknown>;
  const backoff = {
    ...DECLARATION_DEFAULTS.backoff,
    ...(d.backoff ?? {}),
  } as Record<string, unknown>;
  for (const [key, value] of Object.entries(timeouts)) {
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value <= 0 ||
      value > 300_000
    ) {
      throw new ProviderInputError(
        "PROVIDER_DECLARATION_INVALID",
        `timeouts.${key} must be a positive integer ≤ 300000.`
      );
    }
  }
  for (const [key, value] of Object.entries(rateLimits)) {
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value <= 0 ||
      value > 1_000_000
    ) {
      throw new ProviderInputError(
        "PROVIDER_DECLARATION_INVALID",
        `rateLimits.${key} must be a positive integer ≤ 1000000.`
      );
    }
  }
  for (const [key, value] of Object.entries(circuitPolicy)) {
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value <= 0 ||
      value > 86_400_000
    ) {
      throw new ProviderInputError(
        "PROVIDER_DECLARATION_INVALID",
        `circuitPolicy.${key} must be a positive integer ≤ 86400000.`
      );
    }
  }
  for (const [key, value] of Object.entries(backoff)) {
    if (key === "jitterRatio") {
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > 1
      ) {
        throw new ProviderInputError(
          "PROVIDER_DECLARATION_INVALID",
          "backoff.jitterRatio must be in [0,1]."
        );
      }
      continue;
    }
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value <= 0 ||
      value > 86_400_000
    ) {
      throw new ProviderInputError(
        "PROVIDER_DECLARATION_INVALID",
        `backoff.${key} must be a positive integer ≤ 86400000.`
      );
    }
  }

  return {
    providerId: d.providerId,
    adapterVersion: d.adapterVersion,
    capabilities: capabilities as ProviderBindingCapability[],
    supportedActionTypes: supportedActionTypes as ProviderBoundActionType[],
    idempotencySupport: d.idempotencySupport,
    callbackSupport: d.callbackSupport,
    reconciliationSupport: d.reconciliationSupport,
    rateLimitModel: d.rateLimitModel,
    timeoutModel: d.timeoutModel,
    credentialBindingType: d.credentialBindingType,
    accountBindingType: d.accountBindingType,
    healthCapabilities: healthCapabilities as ProviderHealthCapability[],
    timeouts: {
      connectTimeoutMs: timeouts.connectTimeoutMs as number,
      readTimeoutMs: timeouts.readTimeoutMs as number,
    },
    rateLimits: {
      windowMs: rateLimits.windowMs as number,
      maxRequestsPerWindow: rateLimits.maxRequestsPerWindow as number,
      burstCapacity: rateLimits.burstCapacity as number,
      refillPerSecond: rateLimits.refillPerSecond as number,
    },
    circuitPolicy: {
      failureThreshold: circuitPolicy.failureThreshold as number,
      windowMs: circuitPolicy.windowMs as number,
      openDurationMs: circuitPolicy.openDurationMs as number,
      halfOpenMaxProbes: circuitPolicy.halfOpenMaxProbes as number,
      closeAfterSuccesses: circuitPolicy.closeAfterSuccesses as number,
    },
    backoff: {
      baseDelayMs: backoff.baseDelayMs as number,
      multiplier: backoff.multiplier as number,
      maxDelayMs: backoff.maxDelayMs as number,
      jitterRatio: backoff.jitterRatio as number,
      maxAttempts: backoff.maxAttempts as number,
    },
  };
}

import { PROVIDER_BINDING_CAPABILITIES } from "./provider-resilience-contract";
const PROVIDER_BINDING_CAPABILITIES_DECLARED = PROVIDER_BINDING_CAPABILITIES;

/**
 * The closed server-side declaration registry (D1). Only declared providers
 * can be bound; undeclared providers and undeclared capabilities are
 * rejected at the boundary. The registry is immutable once created.
 */
export interface ProviderDeclarationRegistry {
  resolve(providerId: string): ProviderAdapterDeclaration | null;
  list(): readonly ProviderAdapterDeclaration[];
}

export function createProviderDeclarationRegistry(
  declarations: readonly unknown[]
): ProviderDeclarationRegistry {
  const byProvider = new Map<string, ProviderAdapterDeclaration>();
  for (const raw of declarations) {
    const declaration = validateProviderAdapterDeclaration(raw);
    if (byProvider.has(declaration.providerId)) {
      throw new ProviderInputError(
        "PROVIDER_DECLARATION_INVALID",
        `duplicate declaration for provider ${declaration.providerId}.`
      );
    }
    const freeze = (value: any): any => {
      if (value && typeof value === "object") {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
      }
      return value;
    };
    byProvider.set(declaration.providerId, freeze(declaration));
  }
  return {
    resolve: providerId => byProvider.get(providerId) ?? null,
    list: () => [...byProvider.values()],
  };
}

/**
 * Closed binding-declaration match (D1/D2): the binding names a declared
 * provider, a capability the declaration actually declares, and an action
 * type the declaration supports. Anything else fails closed before any
 * durable effect.
 */
export function assertDeclarationSupportsBinding(input: {
  declaration: ProviderAdapterDeclaration;
  capability: string;
  actionType: string;
}): void {
  if (
    !input.declaration.capabilities.includes(
      input.capability as ProviderBindingCapability
    )
  ) {
    throw new ProviderInputError(
      "PROVIDER_CAPABILITY_UNDECLARED",
      `provider ${input.declaration.providerId} does not declare capability ${String(input.capability)}.`
    );
  }
  if (
    !input.declaration.supportedActionTypes.includes(
      input.actionType as ProviderBoundActionType
    )
  ) {
    throw new ProviderInputError(
      "PROVIDER_CAPABILITY_UNSUPPORTED",
      `provider ${input.declaration.providerId} does not support action type ${String(input.actionType)}.`
    );
  }
}
