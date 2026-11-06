// R10-D server-only orchestration. No router, network transport, or live adapter is registered.
import {
  deriveCanonicalActionParams,
  deriveActionParametersHash,
} from "../execution-coordination/execution-coordination-identity";
import { assertMissionActionConsumable } from "../execution-coordination/execution-governance-seam";
import {
  createProviderDeclarationRegistry,
  assertDeclarationSupportsBinding,
  type ProviderAdapterDeclaration,
} from "./provider-adapter-declaration";
import {
  assertExactDispatchBinding,
  type ProviderBindingView,
  type ProviderExecutionActionView,
  type ProviderExecutionAttemptView,
} from "./provider-binding";
import {
  dispatchProviderRequestSchema,
  ingestProviderCallbackSchema,
  ProviderInputError,
  MAX_CALLBACK_PAYLOAD_CHARS,
} from "./provider-resilience-contract";
import {
  deriveProviderBindingId,
  deriveProviderCallbackId,
  deriveProviderCircuitId,
  deriveProviderParametersHash,
  deriveProviderReconciliationId,
} from "./provider-resilience-identity";
import {
  buildProviderRequestEnvelope,
  type ProviderRequestEnvelope,
} from "./provider-request-envelope";
import {
  classifyProviderOutcome,
  type RawProviderOutcome,
} from "./provider-result-classification";
import { executeProviderCallWithTimeout } from "./provider-timeout";
import {
  validateProviderCallback,
  type RawProviderCallback,
} from "./provider-callback-validation";
import { classifyReconciliationEvidence } from "./provider-reconciliation";
import {
  emptyCircuitState,
  evaluateCircuitGate,
  beginCircuitDispatch,
  foldCircuitOutcome,
  type CircuitStateView,
} from "./provider-circuit-breaker";
import { sha256Hex, canonicalJson } from "../conversion/conversion-contract";

export interface DispatchReceipt {
  requestId: string;
  userId: number;
  businessId: number;
  bindingId: string;
  executionActionId: string;
  attemptId: string;
  providerId: string;
  providerAccountId: string;
  capability: string;
  actionType: string;
  parametersHash: string;
  nativeIdempotencyKey: string | null;
  circuitStateAtDispatch: string | null;
  state: string;
  classification: string | null;
  failureClass: string | null;
  providerReference: string | null;
  evidenceHash: string | null;
  retryAfterMs: number | null;
  dispatchedAt: string | null;
  completedAt: string | null;
  version: number;
}
export interface CallbackReceipt {
  callbackId: string;
  userId: number;
  businessId: number;
  requestId: string;
  bindingId: string;
  providerId: string;
  providerAccountId: string;
  providerEventId: string;
  payloadHash: string;
  disposition: string;
  classification: string | null;
  occurredAt: string;
  receivedAt: string;
}
export interface EvidenceReceipt {
  reconciliationId: string;
  userId: number;
  businessId: number;
  requestId: string;
  outcome: string;
  evidenceHash: string;
  providerReference: string | null;
  reconciledAt: string;
}
/** Implementations MUST serialize each tenant's transaction, commit before returning,
 * roll back on error, and retain claims across process restart. Never retry transport. */
export interface ProviderTransaction {
  binding(id: string): Promise<ProviderBindingView | null>;
  request(id: string): Promise<DispatchReceipt | null>;
  attempt(actionId: string, attemptId: string): Promise<DispatchReceipt | null>;
  requests(providerId: string): Promise<DispatchReceipt[]>;
  actionRequests(actionId: string): Promise<DispatchReceipt[]>;
  saveRequest(row: DispatchReceipt, insert: boolean): Promise<void>;
  callback(
    provider: string,
    account: string,
    event: string
  ): Promise<CallbackReceipt | null>;
  saveCallback(row: CallbackReceipt): Promise<void>;
  saveEvidence(row: EvidenceReceipt): Promise<void>;
  circuit(id: string): Promise<CircuitStateView | null>;
  saveCircuit(
    id: string,
    scope: {
      providerId: string;
      providerAccountId: string;
      actionType: string;
    },
    row: CircuitStateView
  ): Promise<void>;
}
export interface ProviderRepository {
  transaction<T>(
    userId: number,
    work: (tx: ProviderTransaction) => Promise<T>
  ): Promise<T>;
}
export type GovernanceMaterial = Parameters<
  typeof assertMissionActionConsumable
>[0];
export interface AuthorizedProviderDispatch {
  action: ProviderExecutionActionView;
  attempt: ProviderExecutionAttemptView;
  /** Server-selected exact binding. A caller cannot choose another account/provider. */
  bindingId: string;
  validUntil: string;
  governance: GovernanceMaterial;
}
export interface ProductionProviderAdapterContract {
  readonly declaration: ProviderAdapterDeclaration;
  dispatch(
    envelope: ProviderRequestEnvelope,
    deadline: { connectTimeoutMs: number; readTimeoutMs: number }
  ): Promise<RawProviderOutcome>;
  reconcile(request: Readonly<DispatchReceipt>): Promise<unknown>;
}
export interface SandboxProviderAdapter extends ProductionProviderAdapterContract {
  readonly sandboxOnly: true;
}
export interface ProviderResilienceDependencies {
  repository: ProviderRepository;
  adapters: readonly SandboxProviderAdapter[];
  /** Mandatory fresh server authority load: R9 action/attempt + R9-F + exact provider binding.
   * No default grant. Production integration must implement this under its certified dispatch gate. */
  authorize(
    userId: number,
    actionId: string,
    attemptId: string
  ): Promise<AuthorizedProviderDispatch>;
  /** Fixed server-owned callback key lookup by exact durable binding. Never a secret path input. */
  callbackKey(binding: ProviderBindingView): Promise<string | null>;
  nowMs?: () => number;
}
function refuse(message: string): never {
  throw new ProviderInputError("BINDING_MISMATCH", message);
}
function unresolved(row: DispatchReceipt) {
  return ["DISPATCHED", "UNCERTAIN", "PENDING"].includes(row.state);
}
function apply(
  row: DispatchReceipt,
  classification: string,
  evidenceHash: string | null,
  reference: string | null,
  now: string
): DispatchReceipt {
  const state = classification.startsWith("FAILED_")
    ? "FAILED"
    : classification;
  return {
    ...row,
    state,
    classification,
    evidenceHash,
    providerReference: reference,
    completedAt: now,
    version: row.version + 1,
  };
}
export function createProviderResilienceService(
  deps: ProviderResilienceDependencies
) {
  const clock = deps.nowMs ?? Date.now;
  const registry = createProviderDeclarationRegistry(
    deps.adapters.map(a => a.declaration)
  );
  const adapters = new Map(
    deps.adapters.map(a => {
      if (a.sandboxOnly !== true) refuse("live adapters are disabled");
      return [a.declaration.providerId, a] as const;
    })
  );
  const declarationFor = (provider: string) => {
    const d = registry.resolve(provider);
    if (!d)
      throw new ProviderInputError(
        "PROVIDER_UNDECLARED",
        "provider is not declared"
      );
    return d;
  };
  return {
    async dispatch(userId: number, raw: unknown): Promise<DispatchReceipt> {
      const input = dispatchProviderRequestSchema.parse(raw);
      // Snapshot client material before awaiting any authority or store operations.
      const parameters = JSON.parse(JSON.stringify(input.parameters));
      const auth = await deps.authorize(
        userId,
        input.executionActionId,
        input.attemptId
      );
      const a = auth.action,
        attempt = auth.attempt;
      if (
        a.userId !== userId ||
        a.executionActionId !== input.executionActionId ||
        attempt.attemptId !== input.attemptId ||
        auth.bindingId !== input.bindingId
      )
        refuse("exact server binding mismatch");
      const hash = deriveActionParametersHash(
        deriveCanonicalActionParams({ ...a, parameters })
      );
      const prepared = await deps.repository.transaction(userId, async tx => {
        const b = await tx.binding(input.bindingId);
        if (!b || b.status !== "ACTIVE") refuse("binding is not active");
        if (
          deriveProviderBindingId({ ...b, tenantUserId: b.userId }) !==
          b.bindingId
        )
          refuse("binding identity drift");
        assertExactDispatchBinding({
          binding: b,
          action: a,
          attempt,
          parametersHash: hash,
        });
        const d = declarationFor(b.providerId);
        assertDeclarationSupportsBinding({
          declaration: d,
          capability: b.capability,
          actionType: b.actionType,
        });
        const env = buildProviderRequestEnvelope({
          binding: b,
          action: a,
          attempt,
          parameters,
          inputRefs: [],
          idempotencySupport: d.idempotencySupport,
        });
        const existing = await tx.attempt(
          a.executionActionId,
          attempt.attemptId
        );
        if (existing) {
          if (
            existing.requestId !== env.requestId ||
            existing.bindingId !== b.bindingId ||
            existing.parametersHash !== env.parametersHash
          )
            refuse("attempt is already pinned to different material");
          return { row: existing, env, call: false, d };
        }
        if ((await tx.actionRequests(a.executionActionId)).some(unresolved))
          refuse(
            "earlier provider effect is unresolved; reconcile before a new attempt"
          );
        const nowMs = clock(),
          now = new Date(nowMs).toISOString();
        const governance = auth.governance;
        if (
          governance.decision.userId !== userId ||
          governance.decision.businessId !== a.businessId
        )
          refuse("governance scope mismatch");
        // Compare the live action to the decision, rather than trusting an injected expectedAction.
        if (
          governance.expectedAction.actionType !== a.actionType ||
          governance.expectedAction.taskRef !== a.taskId ||
          governance.expectedAction.missionRef !== a.missionId ||
          governance.expectedAction.planRef !== a.planId ||
          governance.expectedAction.subjectClass !==
            (a.actionType === "RETRY_STEP" ? "RETRY" : "EXECUTION_STEP")
        )
          refuse("governance action mismatch");
        const verdict = assertMissionActionConsumable({
          ...governance,
          expectedActionParams: { actionParamsFingerprint: hash },
          now,
        });
        if (
          !verdict.consumable ||
          !Number.isFinite(Date.parse(auth.validUntil)) ||
          Date.parse(auth.validUntil) <= nowMs ||
          attempt.resultStatus !== null
        )
          refuse("execution authority is not consumable");
        const scope = {
          tenantUserId: userId,
          providerId: b.providerId,
          providerAccountId: b.providerAccountId,
          actionType: b.actionType,
        };
        const cid = deriveProviderCircuitId(scope);
        const circuit = (await tx.circuit(cid)) ?? emptyCircuitState(nowMs);
        const gate = evaluateCircuitGate({
          state: circuit,
          policy: d.circuitPolicy,
          nowMs,
        });
        // Durable sliding request windows in all three scopes. For token-bucket declarations
        // use a conservative burst/window envelope; never exceed the declared native budget.
        const windowMs =
          d.rateLimitModel === "token_bucket"
            ? Math.max(
                d.rateLimits.windowMs,
                Math.ceil(
                  (1000 * d.rateLimits.burstCapacity) /
                    d.rateLimits.refillPerSecond
                )
              )
            : d.rateLimits.windowMs;
        const limit =
          d.rateLimitModel === "token_bucket"
            ? Math.min(
                d.rateLimits.burstCapacity,
                d.rateLimits.maxRequestsPerWindow
              )
            : d.rateLimits.maxRequestsPerWindow;
        const history = await tx.requests(b.providerId);
        const active = history.filter(
          r =>
            r.dispatchedAt !== null &&
            nowMs - Date.parse(r.dispatchedAt) < windowMs
        );
        const cooldown = history.reduce(
          (max, r) =>
            Math.max(
              max,
              r.retryAfterMs && r.completedAt
                ? Date.parse(r.completedAt) + r.retryAfterMs - nowMs
                : 0
            ),
          0
        );
        const limited =
          cooldown > 0 ||
          (d.rateLimitModel !== "none" &&
            [
              active,
              active.filter(r => r.providerAccountId === b.providerAccountId),
              active.filter(
                r =>
                  r.providerAccountId === b.providerAccountId &&
                  r.actionType === b.actionType
              ),
            ].some(rows => rows.length >= limit));
        const row: DispatchReceipt = {
          requestId: env.requestId,
          userId,
          businessId: b.businessId,
          bindingId: b.bindingId,
          executionActionId: a.executionActionId,
          attemptId: attempt.attemptId,
          providerId: b.providerId,
          providerAccountId: b.providerAccountId,
          capability: b.capability,
          actionType: b.actionType,
          parametersHash: deriveProviderParametersHash(parameters),
          nativeIdempotencyKey: env.nativeIdempotencyKey,
          circuitStateAtDispatch: gate.state,
          state: !gate.allowed
            ? "CIRCUIT_BLOCKED"
            : limited
              ? "RATE_LIMITED"
              : "DISPATCHED",
          classification: !gate.allowed
            ? null
            : limited
              ? "RATE_LIMITED"
              : "UNCERTAIN",
          failureClass: !gate.allowed
            ? "CIRCUIT_OPEN"
            : limited
              ? "RATE_LIMITED"
              : "NONE",
          evidenceHash: null,
          providerReference: null,
          retryAfterMs: limited ? Math.max(1, cooldown, windowMs) : null,
          dispatchedAt: gate.allowed && !limited ? now : null,
          completedAt: null,
          version: 1,
        };
        await tx.saveRequest(row, true);
        if (gate.allowed && !limited)
          await tx.saveCircuit(cid, scope, beginCircuitDispatch(circuit, gate));
        return { row, env, call: gate.allowed && !limited, d };
      });
      if (!prepared.call) return prepared.row;
      const rawResult = await executeProviderCallWithTimeout({
        spec: prepared.d.timeouts,
        requestId: prepared.row.requestId,
        call: deadline =>
          adapters
            .get(prepared.row.providerId)!
            .dispatch(prepared.env, deadline),
      });
      const result = rawResult;
      return deps.repository.transaction(userId, async tx => {
        const row = await tx.request(prepared.row.requestId);
        if (!row) refuse("durable dispatch claim missing");
        // A callback may have resolved the request while transport was outstanding.
        if (!unresolved(row) || row.state !== "DISPATCHED") return row;
        const next = {
          ...apply(
            row,
            result.classification,
            result.evidenceHash,
            result.providerReference,
            new Date(clock()).toISOString()
          ),
          failureClass: result.failureClass,
          retryAfterMs: result.retryAfterMs,
        };
        await tx.saveRequest(next, false);
        const scope = {
          tenantUserId: userId,
          providerId: row.providerId,
          providerAccountId: row.providerAccountId,
          actionType: row.actionType,
        };
        const cid = deriveProviderCircuitId(scope);
        const state = (await tx.circuit(cid)) ?? emptyCircuitState(clock());
        await tx.saveCircuit(
          cid,
          scope,
          foldCircuitOutcome({
            state,
            policy: prepared.d.circuitPolicy,
            classification: result.classification,
            probeSlot: row.circuitStateAtDispatch === "HALF_OPEN",
            nowMs: clock(),
          }).next
        );
        return next;
      });
    },
    async callback(userId: number, bindingId: string, raw: unknown) {
      const parsed = ingestProviderCallbackSchema.parse(raw);
      if (canonicalJson(parsed.payload).length > MAX_CALLBACK_PAYLOAD_CHARS)
        refuse("callback payload exceeds the bounded size");
      // Detach signed material before any await; callers cannot mutate a verified
      // outcome while the durable request lookup is in progress.
      const callback = JSON.parse(
        JSON.stringify(parsed)
      ) as RawProviderCallback;
      return deps.repository.transaction(userId, async tx => {
        const binding = await tx.binding(bindingId);
        if (
          !binding ||
          binding.userId !== userId ||
          binding.status !== "ACTIVE"
        )
          refuse("callback binding unavailable");
        if (
          declarationFor(binding.providerId).callbackSupport !==
          "signed_webhook"
        )
          refuse("signed callbacks are not supported");
        const key = await deps.callbackKey(binding);
        if (!key) refuse("callback key unavailable");
        const validation = validateProviderCallback({
          callback,
          binding,
          secret: key,
          nowMs: clock(),
        });
        if (!validation.ok) return validation;
        const m = validation.callbackMaterial;
        const row = await tx.request(m.requestRef!);
        if (
          !row ||
          row.userId !== userId ||
          row.businessId !== binding.businessId ||
          row.bindingId !== bindingId ||
          row.attemptId !== m.attemptRef ||
          row.providerId !== m.providerId ||
          row.providerAccountId !== m.providerAccountId
        )
          return { ok: false, reason: "REJECTED_UNKNOWN_REFERENCE" };
        const existing = await tx.callback(
          m.providerId,
          m.providerAccountId,
          m.providerEventId
        );
        if (existing?.payloadHash === m.payloadHash)
          return { ok: true, disposition: "DUPLICATE_CONVERGED" };
        const result = classifyProviderOutcome(
          m.claimedOutcome as RawProviderOutcome,
          row.requestId
        );
        const conflict =
          !!existing ||
          (!unresolved(row) &&
            (row.classification !== result.classification ||
              row.providerReference !== result.providerReference));
        const anchor = deriveProviderCallbackId(m);
        await tx.saveCallback({
          callbackId: conflict
            ? "prcb1:" +
              sha256Hex(canonicalJson({ anchor, payloadHash: m.payloadHash }))
            : anchor,
          userId,
          businessId: row.businessId,
          requestId: row.requestId,
          bindingId,
          providerId: m.providerId,
          providerAccountId: m.providerAccountId,
          providerEventId: m.providerEventId,
          payloadHash: m.payloadHash,
          disposition: conflict ? "CONFLICT_QUARANTINED" : "ACCEPTED_NEW",
          classification: result.classification,
          occurredAt: m.occurredAt,
          receivedAt: new Date(clock()).toISOString(),
        });
        if (!conflict && unresolved(row)) {
          await tx.saveRequest(
            {
              ...apply(
                row,
                result.classification,
                result.evidenceHash,
                result.providerReference,
                new Date(clock()).toISOString()
              ),
              failureClass: result.failureClass,
            },
            false
          );
          if (row.state === "DISPATCHED") {
            const scope = {
              tenantUserId: userId,
              providerId: row.providerId,
              providerAccountId: row.providerAccountId,
              actionType: row.actionType,
            };
            const cid = deriveProviderCircuitId(scope);
            const state = (await tx.circuit(cid)) ?? emptyCircuitState(clock());
            await tx.saveCircuit(
              cid,
              scope,
              foldCircuitOutcome({
                state,
                policy: declarationFor(row.providerId).circuitPolicy,
                classification: result.classification,
                probeSlot: row.circuitStateAtDispatch === "HALF_OPEN",
                nowMs: clock(),
              }).next
            );
          }
        }
        return {
          ok: !conflict,
          disposition: conflict ? "CONFLICT_QUARANTINED" : "ACCEPTED_NEW",
        };
      });
    },
    async reconcile(userId: number, requestId: string) {
      const row = await deps.repository.transaction(userId, tx =>
        tx.request(requestId)
      );
      if (!row) refuse("request not found");
      const d = declarationFor(row.providerId);
      if (d.reconciliationSupport === "none")
        refuse("reconciliation unavailable");
      let evidence: unknown = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        evidence = await Promise.race([
          adapters.get(row.providerId)!.reconcile(Object.freeze({ ...row })),
          new Promise<null>(resolve => {
            timer = setTimeout(
              () => resolve(null),
              d.timeouts.connectTimeoutMs + d.timeouts.readTimeoutMs
            );
          }),
        ]);
      } catch {
        /* Unknown remains uncertain. */
      } finally {
        if (timer) clearTimeout(timer);
      }
      const verdict = classifyReconciliationEvidence(evidence, row.requestId);
      return deps.repository.transaction(userId, async tx => {
        const current = await tx.request(requestId);
        if (!current || current.bindingId !== row.bindingId)
          refuse("request drift");
        const now = new Date(clock()).toISOString();
        await tx.saveEvidence({
          reconciliationId: deriveProviderReconciliationId({
            requestId,
            ...verdict,
            reconciledAt: now,
          }),
          userId,
          businessId: row.businessId,
          requestId,
          outcome: verdict.outcome,
          evidenceHash: verdict.evidenceHash,
          providerReference: verdict.providerReference,
          reconciledAt: now,
        });
        if (unresolved(current)) {
          const classification =
            verdict.outcome === "CONFIRMED_SUCCEEDED"
              ? "SUCCEEDED"
              : verdict.outcome === "CONFIRMED_FAILED"
                ? "FAILED_FINAL"
                : verdict.outcome === "STILL_PENDING"
                  ? "PENDING"
                  : "UNCERTAIN";
          await tx.saveRequest(
            apply(
              current,
              classification,
              verdict.evidenceHash,
              verdict.providerReference,
              now
            ),
            false
          );
          // A process may have crashed after claiming a probe but before folding
          // its transport result. Reconciliation settles that reservation once.
          if (current.state === "DISPATCHED") {
            const scope = {
              tenantUserId: userId,
              providerId: current.providerId,
              providerAccountId: current.providerAccountId,
              actionType: current.actionType,
            };
            const cid = deriveProviderCircuitId(scope);
            const circuit =
              (await tx.circuit(cid)) ?? emptyCircuitState(clock());
            await tx.saveCircuit(
              cid,
              scope,
              foldCircuitOutcome({
                state: circuit,
                policy: d.circuitPolicy,
                classification,
                probeSlot: current.circuitStateAtDispatch === "HALF_OPEN",
                nowMs: clock(),
              }).next
            );
          }
        } else if (
          verdict.resolvesDispatch &&
          (current.classification !==
            (verdict.outcome === "CONFIRMED_SUCCEEDED"
              ? "SUCCEEDED"
              : "FAILED_FINAL") ||
            current.providerReference !== verdict.providerReference)
        )
          return { ...verdict, conflict: true };
        return verdict;
      });
    },
  };
}
