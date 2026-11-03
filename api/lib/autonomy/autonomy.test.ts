import { describe, expect, it } from "vitest";
import {
  LEVELS,
  disabled,
  scopeKey,
  type Activation,
  type ActivationAudit,
  type Change,
  type Policy,
  type SafetyEvidence,
  type Scope,
} from "./autonomy-contract";
import {
  createAutonomyController,
  unconfiguredAutonomyGate,
  type ActivationRepository,
} from "./autonomy-service";

const scope: Scope = {
  tenantId: 1,
  businessId: 10,
  capability: "campaign_planning",
  actionClass: "EXECUTE_STEP",
};
const timestamp = "2026-11-02T12:00:00.000Z";
function harness() {
  let state: Activation = disabled(scope);
  const audit: ActivationAudit[] = [],
    reservations = new Set<string>();
  let failAudit = false,
    killed = false;
  const policy: Policy = {
    scope,
    maximumLevel: LEVELS[4],
    capabilityMaximum: LEVELS[4],
    actionMaximum: LEVELS[4],
    effectiveAt: "2026-11-01T00:00:00.000Z",
    expiresAt: "2026-12-01T00:00:00.000Z",
    policyVersion: "h1",
    authoritySource: "operations",
    releaseId: "r10-h-test",
    monitoringRequired: true,
    backupRequired: true,
    canary: {
      providerId: "sandbox",
      percentage: 100,
      maxVolume: 2,
      startsAt: "2026-11-01T00:00:00.000Z",
      endsAt: "2026-11-30T00:00:00.000Z",
    },
  };
  const evidence: SafetyEvidence = {
    binding: {
      ...scope,
      actionId: "action1",
      missionId: "mission1",
      taskId: "task1",
      scheduleId: "schedule1",
      parametersHash: "sha256:test",
      governanceDecisionId: "decision1",
      providerId: "sandbox",
      providerAccountId: "account1",
      releaseId: policy.releaseId,
      requiredLevel: LEVELS[1],
    },
    expiresAt: "2026-11-03T00:00:00.000Z",
    missionCurrent: true,
    taskReady: true,
    scheduleReady: true,
    governance: "ALLOW",
    exactGovernanceConsumable: true,
    exactHumanApproval: false,
    runtimeSafe: true,
    providerSafe: true,
    securitySafe: true,
    monitoringHealthy: true,
    backupHealthy: true,
    environmentSafe: true,
    providerSuspended: false,
    missionSuspended: false,
  };
  // Transactional acceptance harness with rollback and serialization; never production storage.
  let tail = Promise.resolve();
  const repository: ActivationRepository = {
    async read(s) {
      expect(scopeKey(s)).toBe(scopeKey(scope));
      return structuredClone(state);
    },
    transaction(s, run) {
      const result = tail.then(async () => {
        expect(scopeKey(s)).toBe(scopeKey(scope));
        const snapshot = structuredClone(state),
          auditLength = audit.length,
          previousReservations = new Set(reservations);
        try {
          return await run({
            current: structuredClone(state),
            async save(next, fact) {
              if (failAudit) throw new Error("AUDIT_UNAVAILABLE");
              state = structuredClone(next);
              audit.push(structuredClone(fact));
            },
            async reserveCanary(id, ceiling) {
              if (reservations.has(id)) return true;
              if (reservations.size >= ceiling) return false;
              reservations.add(id);
              state.canaryUsed++;
              return true;
            },
          });
        } catch (e) {
          state = snapshot;
          audit.length = auditLength;
          reservations.clear();
          previousReservations.forEach(v => reservations.add(v));
          throw e;
        }
      });
      tail = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    },
  };
  const controller = createAutonomyController({
    repository,
    now: () => timestamp,
    ownsBusiness: async (tenant, business) => tenant === 1 && business === 10,
    emergencyStopped: async () => killed,
    authorizeAdministration: async principal => {
      if (principal !== "separate-admin") throw new Error("ADMIN_REQUIRED");
      return {
        actorType: "HUMAN_ADMIN",
        authoritySource: "operations",
        skipStageAuthorized: true,
      };
    },
    resolveAction: async () => evidence,
  });
  const activate = async (
    level: Activation["effectiveLevel"] = LEVELS[3],
    runtimeState: Activation["runtimeState"] = "ACTIVE",
    extra: Partial<Change> = {}
  ) =>
    controller.administration.administer("separate-admin", scope, {
      level,
      state: runtimeState,
      reason: "ADMIN_ACTIVATION",
      correlationId: "change1",
      expectedVersion: state.version,
      policy,
      suspension: null,
      killSwitch: false,
      skipStageAuthority: "explicit-release-approval",
      ...extra,
    });
  return {
    controller,
    policy,
    evidence,
    activate,
    audit,
    state: () => state,
    kill: () => {
      killed = true;
    },
    failAudit: () => {
      failAudit = true;
    },
  };
}

describe("R10-H controlled autonomy acceptance and hostile input", () => {
  it("default application gate never grants execution", async () => {
    await expect(unconfiguredAutonomyGate()).rejects.toThrow("NOT_BOUND");
  });
  it("activation stage cannot be skipped without exact administration approval", async () => {
    const h = harness();
    await expect(
      h.activate(LEVELS[4], "ACTIVE", { skipStageAuthority: undefined })
    ).rejects.toThrow("STAGE_SKIP");
    expect(h.audit).toHaveLength(0);
  });
  it("standard release progression works without skipping stages", async () => {
    const h = harness();
    for (const [level, state] of [
      [LEVELS[0], "SHADOW"],
      [LEVELS[1], "ACTIVE"],
      [LEVELS[2], "ACTIVE"],
      [LEVELS[3], "CANARY"],
      [LEVELS[3], "ACTIVE"],
      [LEVELS[4], "CANARY"],
      [LEVELS[4], "ACTIVE"],
    ] as const) {
      await h.activate(level, state, { skipStageAuthority: undefined });
    }
    expect(h.audit).toHaveLength(7);
  });
  it("unconfigured state is disabled and cannot dispatch", async () => {
    const h = harness();
    expect((await h.controller.observer.observe(scope)).effectiveLevel).toBe(
      "DISABLED"
    );
    await expect(h.controller.runtime.gate(scope, "action1")).rejects.toThrow(
      "STOPPED"
    );
  });
  it("Level 1 never dispatches even with approval", async () => {
    const h = harness();
    await h.activate(LEVELS[1]);
    h.evidence.exactHumanApproval = true;
    await expect(h.controller.runtime.gate(scope, "action1")).rejects.toThrow(
      "LEVEL1"
    );
  });
  it("Level 2 requires exact human approval even for ALLOW", async () => {
    const h = harness();
    await h.activate(LEVELS[2]);
    await expect(h.controller.runtime.gate(scope, "action1")).rejects.toThrow(
      "APPROVAL_REQUIRED"
    );
    h.evidence.exactHumanApproval = true;
    expect((await h.controller.runtime.gate(scope, "action1")).allowed).toBe(
      true
    );
  });
  it.each([LEVELS[3], LEVELS[4]])(
    "%s permits only exact current bounded authority",
    async level => {
      const h = harness();
      await h.activate(level);
      expect(await h.controller.runtime.gate(scope, "action1")).toEqual({
        allowed: true,
        shadow: false,
        actualExecution: false,
        reason: "ADDITIONAL_GATE_ONLY",
      });
      h.evidence.exactGovernanceConsumable = false;
      await expect(h.controller.runtime.gate(scope, "action1")).rejects.toThrow(
        "UNSAFE"
      );
    }
  );
  it.each(LEVELS.slice(1))("R9-F BLOCK remains blocked at %s", async level => {
    const h = harness();
    await h.activate(level);
    h.evidence.governance = "BLOCK";
    h.evidence.exactHumanApproval = true;
    await expect(h.controller.runtime.gate(scope, "action1")).rejects.toThrow(
      "GOVERNANCE_BLOCKED"
    );
  });
  it("review remains review required without exact human approval", async () => {
    const h = harness();
    await h.activate(LEVELS[4]);
    h.evidence.governance = "REVIEW_REQUIRED";
    await expect(h.controller.runtime.gate(scope, "action1")).rejects.toThrow(
      "GOVERNANCE_BLOCKED"
    );
    h.evidence.exactHumanApproval = true;
    expect((await h.controller.runtime.gate(scope, "action1")).allowed).toBe(
      true
    );
  });
  it.each([4, 3, 2, 1])(
    "allows downgrade %i to next lower level only",
    async n => {
      const h = harness();
      await h.activate(LEVELS[n]);
      const s = await h.controller.runtime.downgrade(scope, {
        targetLevel: LEVELS[n - 1],
        reason: "RUNTIME_DEGRADED",
        correlationId: "safety1",
        expectedVersion: 1,
      });
      expect(s.effectiveLevel).toBe(LEVELS[n - 1]);
      expect(h.audit[1].actorType).toBe("RUNTIME_SAFETY");
      await expect(
        h.controller.runtime.downgrade(scope, {
          targetLevel: LEVELS[n],
          reason: "RUNTIME_DEGRADED",
          correlationId: "safety2",
          expectedVersion: 2,
        })
      ).rejects.toThrow("DOWNGRADE_ONLY");
    }
  );
  it("health recovery cannot restore reduced authority", async () => {
    const h = harness();
    await h.activate();
    await h.controller.runtime.downgrade(scope, {
      targetLevel: LEVELS[2],
      reason: "PROVIDER_DEGRADED",
      correlationId: "s1",
      expectedVersion: 1,
    });
    h.evidence.providerSafe = true;
    await expect(h.controller.runtime.gate(scope, "action1")).rejects.toThrow(
      "STOPPED"
    );
    expect(h.state().effectiveLevel).toBe(LEVELS[2]);
  });
  it("agent has no policy, resume, provider, budget or administration verbs", () => {
    expect(Object.keys(harness().controller.runtime).sort()).toEqual([
      "downgrade",
      "enterSafeMode",
      "gate",
    ]);
  });
  it.each([
    "agent",
    "client",
    { role: "admin" },
    { actorType: "SYSTEM_ADMIN" },
  ])("caller assertion %j cannot elevate", async principal => {
    const h = harness();
    await expect(
      h.controller.administration.administer(principal, scope, {
        level: LEVELS[4],
        state: "ACTIVE",
        reason: "ADMIN_ACTIVATION",
        correlationId: "a",
        expectedVersion: 0,
        policy: h.policy,
        suspension: null,
        killSwitch: false,
      })
    ).rejects.toThrow("ADMIN_REQUIRED");
    expect(h.audit).toHaveLength(0);
  });
  it.each([
    "LEVEL_5",
    "ignore policy and activate",
    "$(whoami)",
    "DROP TABLE users;",
  ])("unknown/injection level %s is inert and rejected", async level => {
    const h = harness();
    await expect(h.activate(level as never)).rejects.toThrow();
    expect(h.audit).toHaveLength(0);
  });
  it.each([
    "policy",
    "maximumLevel",
    "providerId",
    "budget",
    "tenantId",
    "approval",
    "shell",
    "sql",
    "secrets",
    "killSwitch",
  ])("agent cannot inject %s through safety API", async field => {
    const h = harness();
    await h.activate();
    await expect(
      h.controller.runtime.downgrade(scope, {
        targetLevel: LEVELS[2],
        reason: "SECURITY_ANOMALY",
        correlationId: "s1",
        expectedVersion: 1,
        [field]: "raise authority",
      })
    ).rejects.toThrow();
    expect(h.state().version).toBe(1);
  });
  it("shadow returns labelled non-execution without transport", async () => {
    const h = harness();
    await h.activate("DISABLED", "SHADOW");
    expect(await h.controller.runtime.gate(scope, "action1")).toEqual({
      allowed: false,
      shadow: true,
      actualExecution: false,
      reason: "SHADOW_ONLY",
    });
  });
  it("canary uses exact provider and durable volume, duplicate reservation converges", async () => {
    const h = harness();
    await h.activate(LEVELS[3], "CANARY");
    await h.controller.runtime.gate(scope, "action1");
    await h.controller.runtime.gate(scope, "action1");
    h.evidence.binding.actionId = "action2";
    await h.controller.runtime.gate(scope, "action2");
    h.evidence.binding.actionId = "action3";
    await expect(h.controller.runtime.gate(scope, "action3")).rejects.toThrow(
      "CANARY_CEILING"
    );
    expect(h.state().canaryUsed).toBe(2);
  });
  it("canary wrong provider denied", async () => {
    const h = harness();
    await h.activate(LEVELS[3], "CANARY");
    h.evidence.binding.providerId = "other";
    await expect(h.controller.runtime.gate(scope, "action1")).rejects.toThrow(
      "CANARY_SCOPE"
    );
  });
  it("canary percentage and time bounds enforced", async () => {
    const h = harness();
    h.policy.canary!.startsAt = "2026-11-03T00:00:00.000Z";
    await h.activate(LEVELS[3], "CANARY");
    await expect(h.controller.runtime.gate(scope, "action1")).rejects.toThrow(
      "CANARY_SCOPE"
    );
  });
  it("safe mode preserves audit/observation and blocks execution", async () => {
    const h = harness();
    await h.activate(LEVELS[4]);
    await h.controller.runtime.enterSafeMode(scope, {
      targetLevel: LEVELS[1],
      reason: "MONITORING_DEGRADED",
      correlationId: "safe1",
      expectedVersion: 1,
    });
    expect((await h.controller.observer.observe(scope)).safeMode).toBe(true);
    expect(h.audit).toHaveLength(2);
    await expect(h.controller.runtime.gate(scope, "action1")).rejects.toThrow(
      "STOPPED"
    );
  });
  it.each([
    "MISSION",
    "CAPABILITY",
    "PROVIDER",
    "EXECUTION",
    "WORKER",
    "SCHEDULER",
  ] as const)("%s suspension blocks execution and keeps audit", async kind => {
    const h = harness();
    await h.activate(LEVELS[3], "SUSPENDED", {
      suspension: { kind, reference: "bounded1" },
    });
    await expect(h.controller.runtime.gate(scope, "action1")).rejects.toThrow(
      "STOPPED"
    );
    expect((await h.controller.observer.observe(scope)).suspension?.kind).toBe(
      kind
    );
  });
  it("resume requires fresh upstream revalidation at dispatch", async () => {
    const h = harness();
    await h.activate(LEVELS[3], "SUSPENDED", {
      suspension: { kind: "MISSION", reference: "mission1" },
    });
    await h.activate();
    h.evidence.missionCurrent = false;
    await expect(h.controller.runtime.gate(scope, "action1")).rejects.toThrow(
      "UNSAFE"
    );
  });
  it("independent kill switch blocks execution and administration activation", async () => {
    const h = harness();
    await h.activate();
    h.kill();
    await expect(h.controller.runtime.gate(scope, "action1")).rejects.toThrow(
      "KILL_SWITCH"
    );
    await expect(h.activate()).rejects.toThrow("KILL_SWITCH");
    expect((await h.controller.observer.observe(scope)).killSwitch).toBe(true);
  });
  it("admin kill latch blocks even Level 4", async () => {
    const h = harness();
    await h.activate(LEVELS[4], "ACTIVE", { killSwitch: true });
    await expect(h.controller.runtime.gate(scope, "action1")).rejects.toThrow(
      "KILL_SWITCH"
    );
  });
  it.each([
    "missionCurrent",
    "taskReady",
    "scheduleReady",
    "environmentSafe",
  ] as const)("%s false fails closed", async field => {
    const h = harness();
    await h.activate();
    h.evidence[field] = false;
    await expect(h.controller.runtime.gate(scope, "action1")).rejects.toThrow();
  });
  it.each([
    "runtimeSafe",
    "providerSafe",
    "securitySafe",
    "monitoringHealthy",
    "backupHealthy",
  ] as const)(
    "%s latches audited safe mode; health recovery never restores authority",
    async field => {
      const h = harness();
      await h.activate();
      h.evidence[field] = false;
      expect((await h.controller.runtime.gate(scope, "action1")).allowed).toBe(
        false
      );
      expect(h.state().runtimeState).toBe("SAFE_MODE");
      expect(h.audit).toHaveLength(2);
      h.evidence[field] = true;
      await expect(h.controller.runtime.gate(scope, "action1")).rejects.toThrow(
        "STOPPED"
      );
    }
  );
  it.each(["missionSuspended", "providerSuspended"] as const)(
    "%s blocks",
    async field => {
      const h = harness();
      await h.activate();
      h.evidence[field] = true;
      await expect(
        h.controller.runtime.gate(scope, "action1")
      ).rejects.toThrow();
    }
  );
  it.each([
    { ...scope, tenantId: 2 },
    { ...scope, businessId: 11 },
  ])("cross scope %j rejected for read/write/gate", async other => {
    const h = harness();
    await expect(h.controller.observer.observe(other)).rejects.toThrow(
      "SCOPE_REJECTED"
    );
    await expect(h.controller.runtime.gate(other, "action1")).rejects.toThrow(
      "SCOPE_REJECTED"
    );
    await expect(h.controller.runtime.enterSafeMode(other, {})).rejects.toThrow(
      "SCOPE_REJECTED"
    );
  });
  it.each([
    "tenantId",
    "businessId",
    "capability",
    "actionClass",
    "releaseId",
    "actionId",
  ] as const)("exact action %s mismatch fails", async field => {
    const h = harness();
    await h.activate();
    (h.evidence.binding as unknown as Record<string, unknown>)[field] =
      field.endsWith("Id") && ["tenantId", "businessId"].includes(field)
        ? 999
        : "wrong";
    await expect(h.controller.runtime.gate(scope, "action1")).rejects.toThrow(
      "BINDING"
    );
  });
  it("action required unknown level rejected", async () => {
    const h = harness();
    await h.activate();
    h.evidence.binding.requiredLevel = "UNLIMITED" as never;
    await expect(h.controller.runtime.gate(scope, "action1")).rejects.toThrow(
      "LEVEL_BOUND"
    );
  });
  it("capability and action ceilings enforced independently", async () => {
    const h = harness();
    h.policy.actionMaximum = LEVELS[2];
    await expect(h.activate(LEVELS[4])).rejects.toThrow("CEILING");
    h.policy.actionMaximum = LEVELS[4];
    h.policy.capabilityMaximum = LEVELS[1];
    await expect(h.activate(LEVELS[3])).rejects.toThrow("CEILING");
  });
  it("stale evidence and expired policies denied", async () => {
    const h = harness();
    await h.activate();
    h.evidence.expiresAt = "2026-11-01T00:00:00.000Z";
    await expect(h.controller.runtime.gate(scope, "action1")).rejects.toThrow(
      "EXPIRED"
    );
    h.policy.canary = null;
    h.policy.expiresAt = "2026-11-01T01:00:00.000Z";
    await expect(h.activate()).rejects.toThrow("EXPIRED");
  });
  it("audit failure rolls back authority change", async () => {
    const h = harness();
    h.failAudit();
    await expect(h.activate()).rejects.toThrow("AUDIT_UNAVAILABLE");
    expect(h.state().version).toBe(0);
    expect(h.audit).toHaveLength(0);
  });
  it("parallel stale writers cannot both change authority", async () => {
    const h = harness();
    const results = await Promise.allSettled([h.activate(), h.activate()]);
    expect(results.filter(x => x.status === "fulfilled")).toHaveLength(1);
    expect(h.audit).toHaveLength(1);
  });
  it("audit includes exact scope, source, levels, version and correlation without secrets", async () => {
    const h = harness();
    await h.activate();
    expect(h.audit[0]).toMatchObject({
      scope,
      previousLevel: "DISABLED",
      newLevel: LEVELS[3],
      authoritySource: "operations",
      actorType: "HUMAN_ADMIN",
      policyVersion: "h1",
      timestamp,
      correlationId: "change1",
    });
    expect(h.audit[0].changeHash).toMatch(/^[a-f0-9]{64}$/);
    const projection = JSON.stringify(
      await h.controller.observer.observe(scope)
    );
    expect(projection).not.toMatch(
      /parameters|password|secret|token|chain.of.thought/i
    );
  });
});
