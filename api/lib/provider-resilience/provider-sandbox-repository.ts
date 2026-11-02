// Test-only sandbox repository. Models transactions and crash-persistent claims when
// the same repository is reused. Never used as a production persistence substitute.
import type {
  ProviderRepository,
  ProviderTransaction,
  DispatchReceipt,
  CallbackReceipt,
  EvidenceReceipt,
} from "./provider-resilience-service";
import type { ProviderBindingView } from "./provider-binding";
import type { CircuitStateView } from "./provider-circuit-breaker";
export function createSandboxProviderRepository(
  bindings: readonly ProviderBindingView[]
) {
  let state = {
    bindings: new Map(bindings.map(b => [b.bindingId, b])),
    requests: new Map<string, DispatchReceipt>(),
    callbacks: new Map<string, CallbackReceipt>(),
    evidence: new Map<string, EvidenceReceipt>(),
    circuits: new Map<string, CircuitStateView>(),
  };
  let tail = Promise.resolve();
  const repository: ProviderRepository = {
    async transaction<T>(
      userId: number,
      work: (tx: ProviderTransaction) => Promise<T>
    ): Promise<T> {
      const before = tail;
      let release!: () => void;
      tail = new Promise<void>(resolve => {
        release = resolve;
      });
      await before;
      const next = structuredClone(state);
      const tx: ProviderTransaction = {
        async binding(id) {
          const b = next.bindings.get(id);
          return b?.userId === userId ? b : null;
        },
        async request(id) {
          const r = next.requests.get(id);
          return r?.userId === userId ? r : null;
        },
        async attempt(action, attempt) {
          return (
            [...next.requests.values()].find(
              r =>
                r.userId === userId &&
                r.executionActionId === action &&
                r.attemptId === attempt
            ) ?? null
          );
        },
        async requests(provider) {
          return [...next.requests.values()].filter(
            r => r.userId === userId && r.providerId === provider
          );
        },
        async actionRequests(actionId) {
          return [...next.requests.values()].filter(
            r => r.userId === userId && r.executionActionId === actionId
          );
        },
        async saveRequest(row, insert) {
          if (
            row.userId !== userId ||
            (insert && next.requests.has(row.requestId))
          )
            throw new Error("conflicting request");
          const current = next.requests.get(row.requestId);
          if (!insert && current?.version !== row.version - 1)
            throw new Error("stale write");
          next.requests.set(row.requestId, structuredClone(row));
        },
        async callback(provider, account, event) {
          return (
            [...next.callbacks.values()].find(
              r =>
                r.userId === userId &&
                r.providerId === provider &&
                r.providerAccountId === account &&
                r.providerEventId === event
            ) ?? null
          );
        },
        async saveCallback(row) {
          if (row.userId !== userId) throw new Error("tenant");
          next.callbacks.set(row.callbackId, structuredClone(row));
        },
        async saveEvidence(row) {
          if (row.userId !== userId) throw new Error("tenant");
          next.evidence.set(row.reconciliationId, structuredClone(row));
        },
        async circuit(id) {
          return next.circuits.get(id) ?? null;
        },
        async saveCircuit(id, _scope, row) {
          next.circuits.set(id, structuredClone(row));
        },
      };
      try {
        const result = await work(tx);
        state = next;
        return structuredClone(result);
      } finally {
        release();
      }
    },
  };
  return { repository, snapshot: () => structuredClone(state) };
}
