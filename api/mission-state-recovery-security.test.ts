/**
 * WBS-R9-E — Mission State, Recovery & Observability Security Suite.
 *
 * Rogue-agent acceptance (compromised recovery/observability agent):
 * the agent must not fabricate success, hide failure/uncertainty, alter
 * execution history, create fake attempts, self-authorize retry, forge
 * approvals, widen scope, change mission objectives, mutate plan/schedule,
 * lower risk, invoke providers, access secrets, execute shell/SQL, modify
 * permissions, or suppress the audit trail. Blast radius is bounded to
 * advisory proposals + append-only observability within its own tenant.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb must not fall back to a real connection in the R9-E security suite");
  }),
}));

import {
  observeMissionStateSchema,
  proposeRecoverySchema,
  bindRecoveryGovernanceSchema,
} from "./lib/mission-state-recovery/mission-state-recovery-contract";
import {
  deriveCanonicalRecoveryParams,
  deriveRecoveryActionParamsFingerprint,
} from "./lib/mission-state-recovery/mission-state-recovery-identity";
import {
  createInMemoryMissionExecutionAuthority,
  type FakeExecutionRow,
} from "./lib/mission-state-recovery/mission-execution-seam";
import {
  createInMemoryRecoveryGovernanceAuthority,
  deriveGovernanceApprovalBindingHash,
  type FakeGovernanceRow,
} from "./lib/mission-state-recovery/mission-recovery-governance-seam";
import {
  createInMemoryMissionStateUpstreamAuthority,
  type FakeUpstreamRow,
} from "./lib/mission-state-recovery/mission-state-upstream-seam";
import {
  observeMissionState,
  listMissionTaskStates,
  proposeRecovery,
  bindRecoveryGovernance,
  consumeRecovery,
  reevaluateMissionState,
  cancelRecovery,
  getOperationalTimeline,
  getMissionControlHandoff,
  type MissionStateServiceDeps,
} from "./lib/mission-state-recovery/mission-state-recovery-service";
import { makeFakeDb } from "./r9-e-test-support";
import type { MissionRecoveryCandidateRow } from "@db/schema";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const H = (c: string) => c.repeat(64);
const NOW = "2026-11-10T12:00:00.000Z";
const VALID_FROM = "2026-01-01T00:00:00.000Z";
const VALID_UNTIL = "2027-01-01T00:00:00.000Z";
const RECENT = "2026-11-10T11:00:00.000Z";
const USER1 = 7001;
const USER2 = 7002;
const BUSINESS1 = 501;
const M1 = `mis1:${sha("mission-1")}`;
const P1 = "pln1:plan-1";
const S1 = `sch1:${sha("schedule-1")}`;
const TA = "tsk1:task-alpha";
const ACT_A = `exa1:${sha("action-alpha")}`;
const ATT_A1 = `exr1:${sha("attempt-alpha-1")}`;

interface RogueHarness {
  upstreamRows: FakeUpstreamRow[];
  executionRows: FakeExecutionRow[];
  governanceRows: FakeGovernanceRow[];
  fakeDb: ReturnType<typeof makeFakeDb>;
  deps: MissionStateServiceDeps;
}

function makeRogueHarness(): RogueHarness {
  const upstreamRows: FakeUpstreamRow[] = [
    {
      table: "mission_proposals",
      row: {
        missionId: M1,
        userId: USER1,
        businessId: BUSINESS1,
        status: "PROPOSED",
        validFrom: VALID_FROM,
        validUntil: VALID_UNTIL,
        missionFingerprint: H("a"),
      },
    },
    {
      table: "mission_plans",
      row: {
        planId: P1,
        planVersion: 1,
        userId: USER1,
        businessId: BUSINESS1,
        missionId: M1,
        status: "READY_FOR_SCHEDULING",
        validFrom: VALID_FROM,
        validUntil: VALID_UNTIL,
        planFingerprint: H("b"),
      },
    },
    {
      table: "mission_plan_tasks",
      row: {
        taskId: TA,
        planId: P1,
        planVersion: 1,
        userId: USER1,
        businessId: BUSINESS1,
        missionId: M1,
        taskType: "ACTIVATE_CAMPAIGN",
        status: "READY_FOR_SCHEDULING",
        requiredCapabilities: ["campaign.activate"],
        constraints: [],
        capabilityStatus: "SUPPORTED",
        taskFingerprint: H("c"),
      },
    },
    {
      table: "mission_schedules",
      row: {
        scheduleId: S1,
        userId: USER1,
        businessId: BUSINESS1,
        missionId: M1,
        planId: P1,
        planFingerprint: H("b"),
        status: "READY",
        orderedTaskIds: [TA],
        blockingStates: [],
        validFrom: VALID_FROM,
        validUntil: VALID_UNTIL,
        scheduleFingerprint: H("d"),
      },
    },
  ];
  const executionRows: FakeExecutionRow[] = [];
  const governanceRows: FakeGovernanceRow[] = [];
  const fakeDb = makeFakeDb();
  const deps: MissionStateServiceDeps = {
    upstream: createInMemoryMissionStateUpstreamAuthority(upstreamRows),
    execution: createInMemoryMissionExecutionAuthority(executionRows),
    governance: createInMemoryRecoveryGovernanceAuthority(governanceRows),
    store: fakeDb as never,
    now: NOW,
  };
  return { upstreamRows, executionRows, governanceRows, fakeDb, deps };
}

function plantFailure(h: RogueHarness, resultStatus: string, failureClass: string, uncertaintyClass = "NONE") {
  h.executionRows.push({
    table: "execution_actions",
    row: {
      executionActionId: ACT_A,
      userId: USER1,
      businessId: BUSINESS1,
      missionId: M1,
      planId: P1,
      scheduleId: S1,
      taskId: TA,
      taskType: "ACTIVATE_CAMPAIGN",
      actionType: "EXECUTE_TASK",
      actionParametersHash: H("p"),
      governanceDecisionId: `mgd1:${H("g")}`,
      authorizationFingerprint: H("z"),
      adapterType: "CAMPAIGN",
      capability: "campaign.activate",
      validFrom: VALID_FROM,
      validUntil: VALID_UNTIL,
      dispatchState: resultStatus === "SUCCEEDED" ? "SUCCEEDED" : resultStatus === "UNCERTAIN" ? "UNCERTAIN" : "FAILED",
      attemptCount: 1,
    },
  });
  h.executionRows.push({
    table: "execution_attempts",
    row: {
      attemptId: ATT_A1,
      userId: USER1,
      businessId: BUSINESS1,
      executionActionId: ACT_A,
      attemptNumber: 1,
      adapterType: "CAMPAIGN",
      capability: "campaign.activate",
      externalReference: null,
      resultStatus,
      failureClass,
      uncertaintyClass,
      startedAt: RECENT,
      completedAt: RECENT,
      createdAt: RECENT,
    },
  });
}

function plantDecision(h: RogueHarness, candidate: MissionRecoveryCandidateRow, over: Record<string, unknown> = {}) {
  const scope = candidate.scope as Record<string, unknown>;
  const canonicalParams = deriveCanonicalRecoveryParams({
    recoveryCandidateId: candidate.recoveryCandidateId,
    recoveryType: candidate.recoveryType,
    executionActionId: candidate.executionActionId,
    latestAttemptId: candidate.latestAttemptId,
    taskId: candidate.taskId,
    scope: scope as never,
  });
  const actionParamsFingerprint = deriveRecoveryActionParamsFingerprint(canonicalParams);
  const row = {
    governanceDecisionId: `mgd1:${sha(`decision:${candidate.recoveryCandidateId}`)}`,
    userId: USER1,
    businessId: BUSINESS1,
    missionRef: candidate.missionId,
    planRef: candidate.planId,
    taskRef: candidate.taskId,
    subjectClass: candidate.recoveryType === "RETRY" ? "RETRY" : "RECOVERY_ACTION",
    actionType: candidate.recoveryType === "RETRY" ? "RETRY_STEP" : "RECOVER_STATE",
    actionParamsFingerprint,
    missionRiskClass: "MEDIUM",
    policyVersion: "mission-governance-policy/v1",
    decision: "ALLOW",
    reasonCodes: [],
    approvalBinding: null,
    validUntil: VALID_UNTIL,
    evaluatedAt: RECENT,
    ...over,
  };
  h.governanceRows.push({ table: "mission_governance_decisions", row });
  return row;
}

let h: RogueHarness;
beforeEach(() => {
  h = makeRogueHarness();
});

describe("R9-E security — rogue recovery/observability agent", () => {
  it("S1 cannot fabricate success: no success without an authoritative R9-D success attempt", async () => {
    // The agent plants only a PENDING task world and tries every trick in
    // the input surface — none can mint SUCCEEDED.
    expect(() => observeMissionStateSchema.parse({ missionId: M1, status: "SUCCEEDED" })).toThrow();
    expect(() => proposeRecoverySchema.parse({ missionId: M1, scheduleId: S1, taskId: TA, recoveryType: "ESCALATE", success: true })).toThrow();
    const result = await observeMissionState(USER1, { missionId: M1, scheduleId: S1 }, h.deps);
    expect(result.taskStates.find((t) => t.taskId === TA)?.status).toBe("PENDING");
    expect(result.healthClass).not.toBe("COMPLETED");
  });

  it("S2 cannot hide failure: FAILED_FINAL stays visible on every surface", async () => {
    plantFailure(h, "FAILED_FINAL", "VALIDATION");
    await observeMissionState(USER1, { missionId: M1, scheduleId: S1 }, h.deps);
    const states = await listMissionTaskStates(USER1, { missionId: M1 }, h.deps);
    expect(states.find((t) => t.taskId === TA)?.status).toBe("FAILED_FINAL");
    const projection = await getMissionControlHandoff(USER1, { missionId: M1, scheduleId: S1 }, h.deps);
    expect(projection.taskStates.find((t) => t.taskId === TA)?.status).toBe("FAILED_FINAL");
    expect(projection.healthClass).not.toBe("HEALTHY");
  });

  it("S3 cannot hide uncertainty: UNCERTAIN stays visible in state, health and timeline", async () => {
    plantFailure(h, "UNCERTAIN", "TIMEOUT", "TIMEOUT");
    await observeMissionState(USER1, { missionId: M1, scheduleId: S1 }, h.deps);
    const states = await listMissionTaskStates(USER1, { missionId: M1 }, h.deps);
    expect(states.find((t) => t.taskId === TA)?.uncertaintyClass).toBe("TIMEOUT");
    const timeline = await getOperationalTimeline(USER1, { missionId: M1 }, h.deps);
    expect(timeline.some((e) => String(e.eventLabel).startsWith("uncertainty_observed:"))).toBe(true);
  });

  it("S4/S5 cannot alter execution history or mint fake attempts", async () => {
    plantFailure(h, "FAILED_RETRYABLE", "PROVIDER_ERROR");
    const before = JSON.stringify(h.executionRows);
    await observeMissionState(USER1, { missionId: M1, scheduleId: S1 }, h.deps);
    await reevaluateMissionState(USER1, { missionId: M1, scheduleId: S1 }, h.deps);
    expect(JSON.stringify(h.executionRows)).toBe(before);
    // No execution row was appended by any R9-E path.
    expect(h.executionRows.filter((r) => r.table === "execution_attempts")).toHaveLength(1);
  });

  it("S6 cannot self-authorize a retry: no client-supplied decision/approval material exists", async () => {
    plantFailure(h, "FAILED_RETRYABLE", "PROVIDER_ERROR");
    const result = await observeMissionState(USER1, { missionId: M1, scheduleId: S1 }, h.deps);
    const retry = result.recoveryCandidates.find((c) => c.recoveryType === "RETRY") as MissionRecoveryCandidateRow;
    expect(retry.status).toBe("PROPOSED");
    await expect(
      consumeRecovery(USER1, { recoveryCandidateId: retry.recoveryCandidateId, expectedVersion: retry.version }, h.deps)
    ).rejects.toMatchObject({ code: "INVALID_RECOVERY_STATUS" });
    // The bind boundary accepts a decision REFERENCE only.
    expect(() => bindRecoveryGovernanceSchema.parse({ recoveryCandidateId: retry.recoveryCandidateId, governanceDecisionId: `mgd1:${H("g")}`, decision: "ALLOW" })).toThrow();
  });

  it("S7 cannot forge a recovery approval (hash + tenant binding)", async () => {
    plantFailure(h, "FAILED_RETRYABLE", "PROVIDER_ERROR");
    const result = await observeMissionState(USER1, { missionId: M1, scheduleId: S1 }, h.deps);
    const retry = result.recoveryCandidates.find((c) => c.recoveryType === "RETRY") as MissionRecoveryCandidateRow;
    const decision = plantDecision(h, retry, { decision: "REVIEW_REQUIRED" });
    // Forged: cross-tenant approval row (userId 7002) with a recomputed hash.
    const forgedHash = deriveGovernanceApprovalBindingHash({
      governanceDecisionId: String(decision.governanceDecisionId),
      policyVersion: "mission-governance-policy/v1",
      actionParamsFingerprint: String(decision.actionParamsFingerprint),
      missionRiskClass: "MEDIUM",
    });
    h.governanceRows.push({
      table: "approval_requests",
      row: {
        id: 9201,
        userId: USER2,
        approvalType: "mission_action",
        status: "approved",
        context: {
          missionGovernanceBinding: {
            governanceDecisionId: decision.governanceDecisionId,
            policyVersion: "mission-governance-policy/v1",
            actionParamsFingerprint: decision.actionParamsFingerprint,
            missionRiskClass: "MEDIUM",
            approvalBindingHash: forgedHash,
            expiresAt: VALID_UNTIL,
          },
        },
      },
    });
    const bound = await bindRecoveryGovernance(USER1, { recoveryCandidateId: retry.recoveryCandidateId, governanceDecisionId: String(decision.governanceDecisionId) }, h.deps);
    expect(bound.candidate.status).not.toBe("AUTHORIZED");
  });

  it("S8 cannot widen recovery scope: drifted scope INVALIDATES the candidate", async () => {
    plantFailure(h, "FAILED_RETRYABLE", "PROVIDER_ERROR");
    const result = await observeMissionState(USER1, { missionId: M1, scheduleId: S1 }, h.deps);
    const retry = result.recoveryCandidates.find((c) => c.recoveryType === "RETRY") as MissionRecoveryCandidateRow;
    const decision = plantDecision(h, retry);
    const bound = await bindRecoveryGovernance(USER1, { recoveryCandidateId: retry.recoveryCandidateId, governanceDecisionId: String(decision.governanceDecisionId) }, h.deps);
    expect(bound.candidate.status).toBe("AUTHORIZED");
    // The rogue agent tampers the stored scope (simulating a store-level
    // write) — the immutable-core rehash catches it at consumption.
    const stored = h.fakeDb._tables["mission_recovery_candidates"][0] as Record<string, unknown>;
    stored.scope = { ...(stored.scope as Record<string, unknown>), taskId: "tsk1:task-widened" };
    const consumed = await consumeRecovery(USER1, { recoveryCandidateId: retry.recoveryCandidateId, expectedVersion: bound.candidate.version }, h.deps);
    expect(consumed.candidate.status).toBe("INVALIDATED");
    expect(consumed.executionRecoveryHandoff).toBeNull();
  });

  it("S9 cannot change the mission objective or cross mission scope", async () => {
    plantFailure(h, "FAILED_RETRYABLE", "PROVIDER_ERROR");
    const result = await observeMissionState(USER1, { missionId: M1, scheduleId: S1 }, h.deps);
    const retry = result.recoveryCandidates.find((c) => c.recoveryType === "RETRY") as MissionRecoveryCandidateRow;
    const scope = retry.scope as Record<string, unknown>;
    expect(scope.missionId).toBe(M1);
    // A mission planted under a DIFFERENT tenant cannot be pulled into this
    // scope — cross-tenant reference fails closed at world loading.
    h.upstreamRows.push({
      table: "mission_proposals",
      row: {
        missionId: `mis1:${sha("other-mission")}`,
        userId: USER2,
        businessId: BUSINESS1,
        status: "PROPOSED",
        validFrom: VALID_FROM,
        validUntil: VALID_UNTIL,
        missionFingerprint: H("o"),
      },
    });
    await expect(
      proposeRecovery(USER1, { missionId: `mis1:${sha("other-mission")}`, scheduleId: S1, taskId: TA, recoveryType: "RETRY" }, h.deps)
    ).rejects.toMatchObject({ code: "CROSS_TENANT_MISSION" });
  });

  it("S10/S11 cannot mutate plan/schedule or lower risk", async () => {
    plantFailure(h, "FAILED_RETRYABLE", "PROVIDER_ERROR");
    const plansBefore = JSON.stringify(h.upstreamRows.filter((r) => r.table === "mission_plans"));
    const schedulesBefore = JSON.stringify(h.upstreamRows.filter((r) => r.table === "mission_schedules"));
    await observeMissionState(USER1, { missionId: M1, scheduleId: S1 }, h.deps);
    await proposeRecovery(USER1, { missionId: M1, scheduleId: S1, taskId: TA, recoveryType: "ESCALATE" }, h.deps);
    expect(JSON.stringify(h.upstreamRows.filter((r) => r.table === "mission_plans"))).toBe(plansBefore);
    expect(JSON.stringify(h.upstreamRows.filter((r) => r.table === "mission_schedules"))).toBe(schedulesBefore);
    // No risk input exists anywhere in the surface.
    expect(() => proposeRecoverySchema.parse({ missionId: M1, scheduleId: S1, taskId: TA, recoveryType: "ESCALATE", riskClass: "LOW" })).toThrow();
  });

  it("S12/S14 cannot invoke a provider or execute shell/SQL from input", async () => {
    plantFailure(h, "FAILED_RETRYABLE", "PROVIDER_ERROR");
    const actionsBefore = JSON.stringify(h.executionRows.filter((r) => r.table === "execution_actions"));
    await proposeRecovery(USER1, { missionId: M1, scheduleId: S1, taskId: TA, recoveryType: "RETRY" }, h.deps).catch(() => {});
    await proposeRecovery(USER1, { missionId: M1, scheduleId: S1, taskId: TA, recoveryType: "ESCALATE", reason: "exec shell: rm -rf /" }, h.deps);
    expect(JSON.stringify(h.executionRows.filter((r) => r.table === "execution_actions"))).toBe(actionsBefore);
  });

  it("S13 cannot access secrets: secret-shaped material is rejected and never persisted", async () => {
    expect(() => observeMissionStateSchema.parse({ missionId: M1, authorization: "Bearer xyz" })).toThrow();
    expect(() => proposeRecoverySchema.parse({ missionId: M1, scheduleId: S1, taskId: TA, recoveryType: "ESCALATE", password: "hunter2" })).toThrow();
    await proposeRecovery(USER1, { missionId: M1, scheduleId: S1, taskId: TA, recoveryType: "ESCALATE", reason: "contact support" }, h.deps);
    expect(JSON.stringify(h.fakeDb._tables)).not.toContain("hunter2");
    expect(JSON.stringify(h.fakeDb._tables)).not.toContain("Bearer");
  });

  it("S15 cannot modify permissions: the surface is authed-only with no admin or role input", () => {
    // Router-level guarantee: every procedure is authedQuery; no input
    // schema carries role/permission fields; zod strict rejects them.
    expect(() => observeMissionStateSchema.parse({ missionId: M1, role: "admin" })).toThrow();
    expect(() => proposeRecoverySchema.parse({ missionId: M1, scheduleId: S1, taskId: TA, recoveryType: "ESCALATE", permissions: ["*"] })).toThrow();
  });

  it("S16 cannot suppress the audit trail: exactly one event per durable effect, conflicts fail closed", async () => {
    plantFailure(h, "FAILED_RETRYABLE", "PROVIDER_ERROR");
    const result = await observeMissionState(USER1, { missionId: M1, scheduleId: S1 }, h.deps);
    const auditEvents = h.fakeDb._tables["audit_events"] as Record<string, unknown>[];
    expect(auditEvents.some((e) => e.eventType === "mission_state_derived")).toBe(true);
    expect(auditEvents.some((e) => e.eventType === "mission_recovery_candidate_proposed")).toBe(true);
    // Governance binding adds exactly one lifecycle event.
    const retry = result.recoveryCandidates.find((c) => c.recoveryType === "RETRY") as MissionRecoveryCandidateRow;
    const decision = plantDecision(h, retry);
    const before = auditEvents.length;
    await bindRecoveryGovernance(USER1, { recoveryCandidateId: retry.recoveryCandidateId, governanceDecisionId: String(decision.governanceDecisionId) }, h.deps);
    expect(auditEvents.length).toBe(before + 1);
  });

  it("S17 cross-tenant governance decision binding fails closed", async () => {
    plantFailure(h, "FAILED_RETRYABLE", "PROVIDER_ERROR");
    const result = await observeMissionState(USER1, { missionId: M1, scheduleId: S1 }, h.deps);
    const retry = result.recoveryCandidates.find((c) => c.recoveryType === "RETRY") as MissionRecoveryCandidateRow;
    // Decision planted under a different tenant.
    const scope = retry.scope as Record<string, unknown>;
    const canonicalParams = deriveCanonicalRecoveryParams({
      recoveryCandidateId: retry.recoveryCandidateId,
      recoveryType: retry.recoveryType,
      executionActionId: retry.executionActionId,
      latestAttemptId: retry.latestAttemptId,
      taskId: retry.taskId,
      scope: scope as never,
    });
    h.governanceRows.push({
      table: "mission_governance_decisions",
      row: {
        governanceDecisionId: `mgd1:${sha("cross-tenant-decision")}`,
        userId: USER2,
        businessId: BUSINESS1,
        missionRef: M1,
        planRef: P1,
        taskRef: TA,
        subjectClass: "RETRY",
        actionType: "RETRY_STEP",
        actionParamsFingerprint: deriveRecoveryActionParamsFingerprint(canonicalParams),
        missionRiskClass: "MEDIUM",
        policyVersion: "mission-governance-policy/v1",
        decision: "ALLOW",
        reasonCodes: [],
        approvalBinding: null,
        validUntil: VALID_UNTIL,
        evaluatedAt: RECENT,
      },
    });
    await expect(
      bindRecoveryGovernance(USER1, { recoveryCandidateId: retry.recoveryCandidateId, governanceDecisionId: `mgd1:${sha("cross-tenant-decision")}` }, h.deps)
    ).rejects.toMatchObject({ code: "CROSS_TENANT_MISSION" });
  });

  it("S18 stale policy version never authorizes recovery", async () => {
    plantFailure(h, "FAILED_RETRYABLE", "PROVIDER_ERROR");
    const result = await observeMissionState(USER1, { missionId: M1, scheduleId: S1 }, h.deps);
    const retry = result.recoveryCandidates.find((c) => c.recoveryType === "RETRY") as MissionRecoveryCandidateRow;
    const decision = plantDecision(h, retry, { policyVersion: "mission-governance-policy/v0-STALE" });
    const bound = await bindRecoveryGovernance(USER1, { recoveryCandidateId: retry.recoveryCandidateId, governanceDecisionId: String(decision.governanceDecisionId) }, h.deps);
    expect(bound.verdict).toBe("BLOCKED");
    expect(bound.reason).toBe("STALE_POLICY_VERSION");
    expect(bound.candidate.status).not.toBe("AUTHORIZED");
  });

  it("S19 human intervention remains visible: governed cancellation is timeline-audited", async () => {
    plantFailure(h, "FAILED_FINAL", "VALIDATION");
    const result = await observeMissionState(USER1, { missionId: M1, scheduleId: S1 }, h.deps);
    const candidate = result.recoveryCandidates[0];
    await cancelRecovery(USER1, { recoveryCandidateId: candidate.recoveryCandidateId, expectedVersion: candidate.version, reason: "operator dismissed" }, h.deps);
    const timeline = await getOperationalTimeline(USER1, { missionId: M1 }, h.deps);
    const intervention = timeline.find((e) => e.eventType === "operator_intervention");
    expect(intervention).toBeDefined();
    expect(intervention?.toStatus).toBe("CANCELLED");
  });

  it("S20 blast radius: a rogue tenant cannot observe or bind another tenant's state", async () => {
    plantFailure(h, "FAILED_RETRYABLE", "PROVIDER_ERROR");
    await observeMissionState(USER1, { missionId: M1, scheduleId: S1 }, h.deps);
    // USER2 sees nothing, can bind nothing.
    await expect(listMissionTaskStates(USER2, { missionId: M1 }, h.deps)).rejects.toMatchObject({ code: "CROSS_TENANT_MISSION" });
    await expect(getOperationalTimeline(USER2, { missionId: M1 }, h.deps)).rejects.toMatchObject({ code: "CROSS_TENANT_MISSION" });
    await expect(getMissionControlHandoff(USER2, { missionId: M1, scheduleId: S1 }, h.deps)).rejects.toMatchObject({ code: "CROSS_TENANT_MISSION" });
    // USER2's store rows stay empty.
    const user2Rows = (h.fakeDb._tables["mission_state_records"] as Record<string, unknown>[]).filter((r) => r.userId === USER2);
    expect(user2Rows).toHaveLength(0);
  });
});
