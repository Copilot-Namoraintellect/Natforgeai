// ─── R9-D Execution Coordination — closed adapter registry + sandbox fakes ───
//
// The adapter dispatch boundary (contract §5). Adapter selection is
// SERVER-CONTROLLED: the resolved capability comes from the R9-B task's
// requiredCapabilities intersected with the plan's supportedCapabilities
// (both server-read). Models/clients can never provide module names, URLs,
// shell commands, SQL, executable code or tool names — the registry only
// accepts its closed capability vocabulary and rejects everything else.
//
// Development mode (D6): ONLY fake/in-memory sandbox adapters are ever bound
// in this stream. LIVE_EXECUTION=False — no real provider, CRM, payment or
// campaign-activation call occurs anywhere here. The governed dispatch
// boundary is architected for later production binding at R9-X/R10.

import {
  EXECUTION_CAPABILITIES,
  EXECUTION_CAPABILITY_ADAPTER,
  ExecutionInputError,
  ExecutionUpstreamError,
  type ExecutionAdapterType,
  type ExecutionCapability,
} from "./execution-coordination-contract";

// ─── Adapter outcome vocabulary (raw adapter responses, pre-classification) ───

/** Raw outcome returned by an adapter; classification happens in D7 (server-side). */
export type AdapterRawOutcome =
  | { readonly status: "success"; readonly reference?: string; readonly detail?: Record<string, unknown> }
  | { readonly status: "failure"; readonly failureClass?: string; readonly retryable?: boolean; readonly detail?: Record<string, unknown> }
  | { readonly status: "timeout" }
  | { readonly status: "ambiguous"; readonly detail?: Record<string, unknown> }
  | { readonly status: "pending_external"; readonly reference: string };

export interface ExecutionAdapterDispatchInput {
  /** Secret-scrubbed payload — never credentials. */
  readonly payload: Record<string, unknown>;
  readonly externalReference: string;
  readonly dispatchFingerprint: string;
}

export interface ExecutionAdapter {
  readonly adapterType: ExecutionAdapterType;
  readonly capabilities: readonly ExecutionCapability[];
  dispatch(input: ExecutionAdapterDispatchInput): Promise<AdapterRawOutcome>;
}

export interface ExecutionAdapterRegistry {
  resolve(adapterType: ExecutionAdapterType): ExecutionAdapter | null;
  list(): readonly ExecutionAdapter[];
}

export function createAdapterRegistry(
  adapters: readonly ExecutionAdapter[]
): ExecutionAdapterRegistry {
  const byType = new Map(adapters.map((a) => [a.adapterType, a]));
  return {
    resolve: (adapterType) => byType.get(adapterType) ?? null,
    list: () => [...adapters],
  };
}

/**
 * Server-controlled adapter/capability resolution (contract §5). Every
 * required capability must be a closed capability key, must be supported by
 * the plan environment, and all required capabilities must map to exactly
 * ONE adapter class. Anything else fails closed.
 */
export function resolveAdapterForCapabilities(input: {
  requiredCapabilities: readonly string[];
  supportedCapabilities: readonly string[];
}): { readonly adapterType: ExecutionAdapterType; readonly capability: ExecutionCapability } {
  const required = [...new Set(input.requiredCapabilities)];
  if (required.length === 0) {
    throw new ExecutionUpstreamError("CAPABILITY_INVALID", "task declares no required capabilities; no adapter can be resolved.");
  }
  const supported = new Set(input.supportedCapabilities);
  const adapterTypes = new Set<ExecutionAdapterType>();
  let firstCapability: ExecutionCapability | null = null;
  for (const raw of required) {
    if (!(EXECUTION_CAPABILITIES as readonly string[]).includes(raw)) {
      throw new ExecutionUpstreamError("CAPABILITY_INVALID", `unknown capability ${String(raw)}; adapter vocabulary is closed.`);
    }
    const capability = raw as ExecutionCapability;
    if (!supported.has(capability)) {
      throw new ExecutionUpstreamError(
        "CAPABILITY_INVALID",
        `capability ${capability} is not supported by the plan environment.`
      );
    }
    adapterTypes.add(EXECUTION_CAPABILITY_ADAPTER[capability]);
    if (firstCapability === null) firstCapability = capability;
  }
  if (adapterTypes.size !== 1 || firstCapability === null) {
    throw new ExecutionUpstreamError(
      "ADAPTER_UNAVAILABLE",
      `required capabilities span ${adapterTypes.size} adapter classes; a mission task must resolve to exactly one adapter.`
    );
  }
  return { adapterType: [...adapterTypes][0], capability: firstCapability };
}

/** Closed adapter-class check — unknown classes are rejected outright. */
export function assertKnownAdapterType(value: string): ExecutionAdapterType {
  const known: readonly string[] = ["CAMPAIGN", "CONTENT", "SOCIAL", "CRM", "NOTIFICATION", "ANALYTICS", "INTERNAL_WORKFLOW"];
  if (!known.includes(value)) {
    throw new ExecutionInputError("UNKNOWN_ADAPTER", `unknown adapter class ${String(value)}.`);
  }
  return value as ExecutionAdapterType;
}

// ─── Sandbox fake adapters (D6 — the ONLY adapters bound in this stream) ───

export interface FakeExecutionAdapter extends ExecutionAdapter {
  readonly dispatched: ExecutionAdapterDispatchInput[];
  /** Script per capability: default success unless overridden. */
  scriptOutcome(capability: ExecutionCapability, outcome: AdapterRawOutcome): void;
  /** Queue the eventual outcome for a pending externalReference. */
  queueCallback(externalReference: string, outcome: AdapterRawOutcome): void;
  readonly callbackLog: { readonly externalReference: string; readonly outcome: AdapterRawOutcome }[];
}

export interface SandboxAdapterHarness {
  readonly registry: ExecutionAdapterRegistry;
  readonly adapters: Record<ExecutionAdapterType, FakeExecutionAdapter>;
  /** Total side-effect count across all fake adapters (duplicate detection). */
  totalDispatches(): number;
}

/**
 * In-memory sandbox registry. Each fake adapter records every dispatch
 * (side-effect observability for idempotency acceptance) and executes a
 * scripted outcome. Nothing here touches a network, filesystem, provider or
 * legacy execution surface.
 */
export function createSandboxAdapterHarness(): SandboxAdapterHarness {
  const adapters = {} as Record<ExecutionAdapterType, FakeExecutionAdapter>;
  const allCapabilities = Object.keys(EXECUTION_CAPABILITY_ADAPTER) as ExecutionCapability[];
  const byAdapter = new Map<ExecutionAdapterType, ExecutionCapability[]>();
  for (const capability of allCapabilities) {
    const type = EXECUTION_CAPABILITY_ADAPTER[capability];
    if (!byAdapter.has(type)) byAdapter.set(type, []);
    byAdapter.get(type)!.push(capability);
  }

  for (const [adapterType, capabilities] of byAdapter) {
    const dispatched: ExecutionAdapterDispatchInput[] = [];
    const scripts = new Map<ExecutionCapability, AdapterRawOutcome>();
    const pending = new Map<string, AdapterRawOutcome>();
    const callbackLog: { externalReference: string; outcome: AdapterRawOutcome }[] = [];
    adapters[adapterType] = {
      adapterType,
      capabilities,
      dispatched,
      callbackLog,
      scriptOutcome(capability, outcome) {
        scripts.set(capability, outcome);
      },
      queueCallback(externalReference, outcome) {
        pending.set(externalReference, outcome);
        callbackLog.push({ externalReference, outcome });
      },
      async dispatch(input) {
        dispatched.push(input);
        const capability = input.payload["capability"];
        const scripted = typeof capability === "string" ? scripts.get(capability as ExecutionCapability) : undefined;
        if (scripted) return scripted;
        const queued = pending.get(input.externalReference);
        if (queued && queued.status === "pending_external") return queued;
        if (queued) {
          pending.delete(input.externalReference);
          return queued;
        }
        return { status: "success", reference: input.externalReference };
      },
    };
  }

  return {
    adapters,
    registry: createAdapterRegistry(Object.values(adapters)),
    totalDispatches() {
      return Object.values(adapters).reduce((sum, a) => sum + a.dispatched.length, 0);
    },
  };
}
