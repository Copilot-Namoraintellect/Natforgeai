import { createHash } from "node:crypto";
import {
  changeSchema,
  disabled,
  rank,
  safetySchema,
  scopeKey,
  scopeSchema,
  type ActionBinding,
  type Activation,
  type ActivationAudit,
  type Change,
  type Policy,
  type SafetyEvidence,
  type Scope,
} from "./autonomy-contract";

export interface ActivationTransaction {
  current: Activation;
  /** Atomic state + append-only audit commit, or throw. No unaudited mutation. */
  save(next: Activation, audit: ActivationAudit): Promise<void>;
  reserveCanary(actionId: string, ceiling: number): Promise<boolean>;
}
export interface ActivationRepository {
  read(scope: Scope): Promise<Activation>;
  /** Serializes changes and dispatch reservations for this exact scope. */
  transaction<T>(
    scope: Scope,
    run: (tx: ActivationTransaction) => Promise<T>
  ): Promise<T>;
}
export interface AutonomyDependencies {
  repository: ActivationRepository;
  now: () => string;
  /** Separate administration identity; JWT role or actor strings alone are insufficient. */
  authorizeAdministration: (
    principal: unknown,
    scope: Scope,
    change: Change
  ) => Promise<{
    actorType: "HUMAN_ADMIN" | "SYSTEM_ADMIN";
    authoritySource: string;
    skipStageAuthorized: boolean;
  }>;
  ownsBusiness: (tenantId: number, businessId: number) => Promise<boolean>;
  resolveAction: (scope: Scope, actionId: string) => Promise<SafetyEvidence>;
  /** Independent, out-of-band kill status. Unavailable/unknown must return true or throw. */
  emergencyStopped: (scope: Scope) => Promise<boolean>;
}
function fail(reason: string): never {
  throw new Error(`AUTONOMY_${reason}`);
}
const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const minimum = (p: Policy): number =>
  Math.min(
    rank(p.maximumLevel),
    rank(p.capabilityMaximum),
    rank(p.actionMaximum)
  );
function stage(
  level: Activation["effectiveLevel"],
  state: Activation["runtimeState"]
): number {
  if (state === "SHADOW") return 1;
  if (level === "DISABLED") return 0;
  const n = rank(level);
  return n < 3
    ? n + 1
    : n === 3
      ? state === "CANARY"
        ? 4
        : 5
      : state === "CANARY"
        ? 6
        : 7;
}

/** Trusted composition root. Exported admin handle must never be registered as an agent tool. */
export function createAutonomyController(deps: AutonomyDependencies) {
  async function scoped(raw: Scope): Promise<Scope> {
    const scope = scopeSchema.parse(raw);
    if (!(await deps.ownsBusiness(scope.tenantId, scope.businessId)))
      fail("SCOPE_REJECTED");
    return scope;
  }
  function now(): string {
    const value = deps.now();
    if (!Number.isFinite(Date.parse(value))) fail("CLOCK_INVALID");
    return value;
  }
  async function save(
    tx: ActivationTransaction,
    next: Activation,
    actorType: ActivationAudit["actorType"],
    correlationId: string
  ): Promise<void> {
    const previous = tx.current;
    next.version = previous.version + 1;
    next.lastAuthorityChange = now();
    await tx.save(next, {
      scope: next.scope,
      version: next.version,
      previousLevel: previous.effectiveLevel,
      newLevel: next.effectiveLevel,
      previousState: previous.runtimeState,
      newState: next.runtimeState,
      reason: next.reason,
      authoritySource: next.authoritySource,
      actorType,
      policyVersion: next.policy?.policyVersion ?? null,
      timestamp: next.lastAuthorityChange,
      correlationId,
      changeHash: digest(next),
    });
  }
  async function administer(
    principal: unknown,
    rawScope: Scope,
    rawChange: unknown
  ): Promise<Activation> {
    const scope = await scoped(rawScope);
    const change = changeSchema.parse(rawChange);
    const authorization = await deps.authorizeAdministration(
      principal,
      scope,
      structuredClone(change)
    );
    if (
      !authorization ||
      !["HUMAN_ADMIN", "SYSTEM_ADMIN"].includes(authorization.actorType) ||
      !/^[A-Za-z0-9_.:-]{1,120}$/.test(authorization.authoritySource)
    )
      fail("ADMIN_REQUIRED");
    return deps.repository.transaction(scope, async tx => {
      const old = tx.current;
      if (old.version !== change.expectedVersion) fail("VERSION_CONFLICT");
      const policy = change.policy ?? old.policy;
      if (
        !policy ||
        scopeKey(policy.scope) !== scopeKey(scope) ||
        policy.authoritySource !== authorization.authoritySource
      )
        fail("POLICY_BINDING");
      const time = Date.parse(now());
      if (
        time < Date.parse(policy.effectiveAt) ||
        time >= Date.parse(policy.expiresAt)
      )
        fail("POLICY_EXPIRED");
      if (rank(change.level) > minimum(policy)) fail("POLICY_CEILING");
      if (
        change.state === "CANARY" &&
        (!policy.canary || rank(change.level) < 3)
      )
        fail("CANARY_REQUIRED");
      if (
        (change.level === "DISABLED") !== (change.state === "DISABLED") &&
        change.state !== "SHADOW" &&
        change.state !== "SAFE_MODE" &&
        change.state !== "SUSPENDED"
      )
        fail("STATE_LEVEL_MISMATCH");
      if (change.state === "SHADOW" && change.level !== "DISABLED")
        fail("SHADOW_LEVEL");
      if (change.suspension && change.state !== "SUSPENDED")
        fail("SUSPENSION_STATE");
      const increasing =
        rank(change.level) > rank(old.effectiveLevel) ||
        stage(change.level, change.state) >
          stage(old.effectiveLevel, old.runtimeState) ||
        (old.killSwitch && !change.killSwitch) ||
        (!!old.suspension && !change.suspension) ||
        (["SAFE_MODE", "SUSPENDED", "DEGRADED"].includes(old.runtimeState) &&
          ["ACTIVE", "CANARY"].includes(change.state));
      if (
        stage(change.level, change.state) >
          stage(old.effectiveLevel, old.runtimeState) + 1 &&
        !(authorization.skipStageAuthorized && change.skipStageAuthority)
      )
        fail("STAGE_SKIP");
      // Resume, policy expansion and release activation require fresh operational authority.
      if (increasing || change.policy) {
        if (await deps.emergencyStopped(scope)) fail("KILL_SWITCH");
        // Resolver must revalidate exact current upstreams, not health recovery alone.
        // Activation itself grants no dispatch receipt; each action is resolved below.
      }
      const next: Activation = {
        ...old,
        configuredLevel: policy.maximumLevel,
        effectiveLevel: change.level,
        runtimeState: change.state,
        policy,
        reason: change.reason,
        killSwitch: change.killSwitch,
        suspension: change.suspension,
        // Policy edits must not reset a canary's consumed volume.
        canaryUsed: old.canaryUsed,
        authoritySource: authorization.authoritySource,
      };
      await save(tx, next, authorization.actorType, change.correlationId);
      return structuredClone(next);
    });
  }
  async function downgrade(
    rawScope: Scope,
    rawRequest: unknown
  ): Promise<Activation> {
    const scope = await scoped(rawScope);
    const request = safetySchema.parse(rawRequest);
    return deps.repository.transaction(scope, async tx => {
      const old = tx.current;
      if (old.version !== request.expectedVersion) fail("VERSION_CONFLICT");
      if (rank(request.targetLevel) >= rank(old.effectiveLevel))
        fail("DOWNGRADE_ONLY");
      const next = {
        ...old,
        effectiveLevel: request.targetLevel,
        runtimeState:
          request.targetLevel === "DISABLED"
            ? ("DISABLED" as const)
            : ("DEGRADED" as const),
        reason: request.reason,
        authoritySource: "RUNTIME_SAFETY",
      };
      // A downgrade cannot clear a stronger safety latch.
      if (["SAFE_MODE", "SUSPENDED"].includes(old.runtimeState))
        next.runtimeState = old.runtimeState as never;
      await save(tx, next, "RUNTIME_SAFETY", request.correlationId);
      return structuredClone(next);
    });
  }
  async function enterSafeMode(
    rawScope: Scope,
    rawRequest: unknown
  ): Promise<Activation> {
    const scope = await scoped(rawScope);
    const request = safetySchema.parse(rawRequest);
    return deps.repository.transaction(scope, async tx => {
      if (tx.current.version !== request.expectedVersion)
        fail("VERSION_CONFLICT");
      if (rank(request.targetLevel) > rank(tx.current.effectiveLevel))
        fail("DOWNGRADE_ONLY");
      const next = {
        ...tx.current,
        effectiveLevel: request.targetLevel,
        runtimeState:
          tx.current.runtimeState === "SUSPENDED"
            ? ("SUSPENDED" as const)
            : ("SAFE_MODE" as const),
        reason: request.reason,
        authoritySource: "RUNTIME_SAFETY",
      };
      await save(tx, next, "RUNTIME_SAFETY", request.correlationId);
      return structuredClone(next);
    });
  }
  async function observe(rawScope: Scope) {
    const scope = await scoped(rawScope);
    const s = await deps.repository.read(scope);
    return structuredClone({
      contractVersion: "autonomy-observability/v1",
      scope: s.scope,
      configuredLevel: s.configuredLevel,
      effectiveLevel: s.effectiveLevel,
      runtimeState: s.runtimeState,
      downgradeReason: s.reason,
      safeMode: s.runtimeState === "SAFE_MODE",
      suspension: s.suspension,
      canaryScope: s.policy?.canary ?? null,
      killSwitch: s.killSwitch || (await deps.emergencyStopped(scope)),
      lastAuthorityChange: s.lastAuthorityChange,
      authoritySource: s.authoritySource,
      policyVersion: s.policy?.policyVersion ?? null,
      version: s.version,
      actualExecution: false,
    });
  }
  async function gate(
    rawScope: Scope,
    actionId: string
  ): Promise<{
    allowed: boolean;
    shadow: boolean;
    actualExecution: false;
    reason: string;
  }> {
    const scope = await scoped(rawScope);
    if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(actionId)) fail("ACTION_REFERENCE");
    return deps.repository.transaction(scope, async tx => {
      const s = tx.current,
        p = s.policy;
      if (s.killSwitch || (await deps.emergencyStopped(scope)))
        fail("KILL_SWITCH");
      if (
        s.suspension ||
        ["SAFE_MODE", "SUSPENDED", "DISABLED", "DEGRADED"].includes(
          s.runtimeState
        )
      )
        fail("EXECUTION_STOPPED");
      if (!p || scopeKey(p.scope) !== scopeKey(scope)) fail("POLICY_MISSING");
      let time = Date.parse(now());
      if (time < Date.parse(p.effectiveAt) || time >= Date.parse(p.expiresAt))
        fail("POLICY_EXPIRED");
      const e = structuredClone(await deps.resolveAction(scope, actionId));
      time = Date.parse(now());
      if (time < Date.parse(p.effectiveAt) || time >= Date.parse(p.expiresAt))
        fail("POLICY_EXPIRED");
      if (await deps.emergencyStopped(scope)) fail("KILL_SWITCH");
      const b: ActionBinding = e.binding;
      if (
        !b ||
        scopeKey({
          tenantId: b.tenantId,
          businessId: b.businessId,
          capability: b.capability,
          actionClass: b.actionClass,
        }) !== scopeKey(scope) ||
        b.actionId !== actionId ||
        b.releaseId !== p.releaseId
      )
        fail("ACTION_BINDING");
      if (
        !Number.isFinite(Date.parse(e.expiresAt)) ||
        time >= Date.parse(e.expiresAt)
      )
        fail("EVIDENCE_EXPIRED");
      if (
        ![
          b.missionId,
          b.taskId,
          b.scheduleId,
          b.parametersHash,
          b.governanceDecisionId,
          b.providerId,
          b.providerAccountId,
        ].every(
          v => typeof v === "string" && /^[A-Za-z0-9_.:-]{1,120}$/.test(v)
        )
      )
        fail("ACTION_BINDING");
      if (
        ![
          e.missionCurrent,
          e.taskReady,
          e.scheduleReady,
          e.exactGovernanceConsumable,
          e.environmentSafe,
        ].every(v => v === true) ||
        e.providerSuspended !== false ||
        e.missionSuspended !== false
      )
        fail("UPSTREAM_UNSAFE");
      if (
        e.governance !== "ALLOW" &&
        !(e.governance === "REVIEW_REQUIRED" && e.exactHumanApproval === true)
      )
        fail("GOVERNANCE_BLOCKED");
      const healthReason =
        e.securitySafe !== true
          ? "SECURITY_ANOMALY"
          : e.runtimeSafe !== true
            ? "RUNTIME_DEGRADED"
            : e.providerSafe !== true
              ? "PROVIDER_DEGRADED"
              : p.monitoringRequired && e.monitoringHealthy !== true
                ? "MONITORING_DEGRADED"
                : p.backupRequired && e.backupHealthy !== true
                  ? "BACKUP_DEGRADED"
                  : null;
      if (healthReason) {
        // Return denial after committing the safety latch. Throwing here would roll it back.
        await save(
          tx,
          {
            ...s,
            effectiveLevel: "DISABLED",
            runtimeState: "SAFE_MODE",
            reason: healthReason,
            authoritySource: "RUNTIME_SAFETY",
          },
          "RUNTIME_SAFETY",
          `health:${s.version}`
        );
        return {
          allowed: false,
          shadow: s.runtimeState === "SHADOW",
          actualExecution: false,
          reason: healthReason,
        };
      }
      if (s.runtimeState === "SHADOW")
        return {
          allowed: false,
          shadow: true,
          actualExecution: false,
          reason: "SHADOW_ONLY",
        };
      const required = rank(b.requiredLevel);
      if (
        required < 1 ||
        rank(s.effectiveLevel) < required ||
        minimum(p) < required ||
        rank(s.effectiveLevel) > minimum(p)
      )
        fail("LEVEL_BOUND");
      if (rank(s.effectiveLevel) <= 1) fail("LEVEL1_NO_DISPATCH");
      if (rank(s.effectiveLevel) === 2 && e.exactHumanApproval !== true)
        fail("LEVEL2_APPROVAL_REQUIRED");
      if (s.runtimeState === "CANARY") {
        const c = p.canary;
        if (
          !c ||
          b.providerId !== c.providerId ||
          time < Date.parse(c.startsAt) ||
          time >= Date.parse(c.endsAt)
        )
          fail("CANARY_SCOPE");
        const bucket =
          Number.parseInt(
            digest([scope, actionId, p.policyVersion]).slice(0, 8),
            16
          ) % 100;
        if (
          bucket >= c.percentage ||
          !(await tx.reserveCanary(actionId, c.maxVolume))
        )
          fail("CANARY_CEILING");
      } else if (s.runtimeState !== "ACTIVE") fail("STATE_UNKNOWN");
      return {
        allowed: true,
        shadow: false,
        actualExecution: false,
        reason: "ADDITIONAL_GATE_ONLY",
      };
    });
  }
  return Object.freeze({
    administration: Object.freeze({ administer }),
    runtime: Object.freeze({ downgrade, enterSafeMode, gate }),
    observer: Object.freeze({ observe }),
  });
}

/** Application remains closed until R10-X binds durable administration and fresh C/D/F evidence. */
export async function unconfiguredAutonomyGate(): Promise<never> {
  return fail("NOT_BOUND");
}
export { disabled };
