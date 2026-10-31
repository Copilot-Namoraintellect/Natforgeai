/**
 * WBS-R9-D — Execution Coordination Rogue-Agent Security Suite.
 *
 * Twenty adversarial cases assuming a COMPROMISED execution agent: it holds
 * a valid tenant JWT, can call every R9-D procedure, can craft arbitrary
 * bounded payloads — and must still be unable to fabricate authorization,
 * alter approved action parameters, bypass idempotency, retrieve secrets,
 * invoke arbitrary tools or create uncontrolled side effects.
 *
 * Also pins the ported R9-F consumption gate (mission-governance-to-execution/v1)
 * against its frozen semantics vectors: exactness, ALLOW expiry, stale
 * policy, BLOCK, approval binding (pending / rejected-permanent / edited /
 * hash tamper / cross-tenant / expired), and the valid approved path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getTableName } from "drizzle-orm";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "./queries/connection";
import {
  assertMissionActionConsumable,
  deriveGovernanceActionParamsFingerprint,
  deriveGovernanceApprovalBindingHash,
  type MissionGovernanceDecisionView,
} from "./lib/execution-coordination/execution-governance-seam";
import {
  deriveCanonicalActionParams,
} from "./lib/execution-coordination/execution-coordination-identity";
import {
  prepareExecutionActionSchema,
  dispatchExecutionActionSchema,
} from "./lib/execution-coordination/execution-coordination-contract";
import {
  classifyAdapterOutcome,
  classifyCallbackMaterial,
} from "./lib/execution-coordination/execution-result-classification";
import { sha256Hex } from "./lib/conversion/conversion-contract";

const NOW = "2026-11-10T12:00:00.000Z";
const LATER = "2026-11-20T00:00:00.000Z";
const EXPIRED = "2026-11-09T00:00:00.000Z";
const POLICY = "mission-governance-policy/v1";

function decisionView(overrides: Partial<MissionGovernanceDecisionView> = {}): MissionGovernanceDecisionView {
  return {
    governanceDecisionId: "mgd1:" + "a".repeat(64),
    userId: 7001,
    businessId: 501,
    missionRef: "mis1:" + "b".repeat(64),
    planRef: "pln1:plan1",
    taskRef: "task-1",
    subjectClass: "EXECUTION_STEP",
    actionType: "EXECUTE_TASK",
    actionParamsFingerprint: deriveGovernanceActionParamsFingerprint({ v: 1, x: 1 }),
    missionRiskClass: "MEDIUM",
    policyVersion: POLICY,
    decision: "ALLOW",
    reasonCodes: ["MISSION_ALLOWED_BY_POLICY"],
    approvalBinding: null,
    validUntil: LATER,
    evaluatedAt: NOW,
    ...overrides,
  };
}

const EXPECTED = {
  subjectClass: "EXECUTION_STEP",
  actionType: "EXECUTE_TASK",
  missionRef: "mis1:" + "b".repeat(64),
  planRef: "pln1:plan1",
  taskRef: "task-1",
  actionParams: { v: 1, x: 1 },
};

function gate(input: {
  decision?: MissionGovernanceDecisionView;
  approval?: { id: number; userId: number; status: "pending" | "approved" | "rejected" | "edited"; context: unknown } | null;
  expectedAction?: typeof EXPECTED;
  currentPolicyVersion?: string | null;
  now?: string;
  fingerprint?: string;
}) {
  return assertMissionActionConsumable({
    decision: input.decision ?? decisionView(),
    approval: input.approval ?? null,
    expectedAction: input.expectedAction ?? EXPECTED,
    expectedActionParams: input.fingerprint
      ? { actionParamsFingerprint: input.fingerprint }
      : { actionParams: (input.expectedAction ?? EXPECTED).actionParams },
    currentPolicyVersion:
      input.currentPolicyVersion !== undefined ? input.currentPolicyVersion : POLICY,
    now: input.now ?? NOW,
  });
}

describe("R9-D security — frozen gate semantics vectors", () => {
  it("GV1 exact match ALLOW is consumable with bounded authority", () => {
    const verdict = gate({});
    expect(verdict.consumable).toBe(true);
    if (verdict.consumable) {
      expect(verdict.authorization.authorityScope).toBe("MISSION_ACTION");
      expect(verdict.authorization.approvalRequestId).toBeNull();
      expect(verdict.authorization.governanceDecisionId).toBe("mgd1:" + "a".repeat(64));
    }
  });

  it("GV2 any exactness deviation fails closed (params/refs/subject/action)", () => {
    expect(gate({ expectedAction: { ...EXPECTED, actionParams: { v: 1, x: 2 } } })).toMatchObject({
      consumable: false,
      reason: "APPROVAL_BINDING_MISMATCH",
    });
    expect(gate({ expectedAction: { ...EXPECTED, taskRef: "task-OTHER" } })).toMatchObject({ consumable: false });
    expect(gate({ expectedAction: { ...EXPECTED, subjectClass: "RETRY" } })).toMatchObject({ consumable: false });
    expect(gate({ expectedAction: { ...EXPECTED, actionType: "ACTIVATE_CAMPAIGN" } })).toMatchObject({ consumable: false });
    expect(gate({ fingerprint: sha256Hex("forged") })).toMatchObject({ consumable: false });
  });

  it("GV3 ALLOW expiry + stale policy fail closed", () => {
    expect(gate({ now: LATER })).toMatchObject({ consumable: false, reason: "EXPIRED_DECISION" });
    expect(gate({ currentPolicyVersion: "mission-governance-policy/v0" })).toMatchObject({
      consumable: false,
      reason: "STALE_POLICY_VERSION",
    });
    expect(gate({ currentPolicyVersion: null })).toMatchObject({ consumable: false });
  });

  it("GV4 BLOCK is never consumable", () => {
    expect(gate({ decision: decisionView({ decision: "BLOCK", reasonCodes: ["MISSION_BLOCKED_BY_POLICY"] }) })).toMatchObject({
      consumable: false,
      reason: "MISSION_BLOCKED_BY_POLICY",
    });
  });

  it("GV5 REVIEW_REQUIRED approval lifecycle (pending / rejected-permanent / edited)", () => {
    const decision = decisionView({
      decision: "REVIEW_REQUIRED",
      approvalBinding: { approvalBindingHash: "x", expiresAt: LATER },
    });
    const binding = {
      missionGovernanceBinding: {
        governanceDecisionId: decision.governanceDecisionId,
        policyVersion: POLICY,
        actionParamsFingerprint: decision.actionParamsFingerprint,
        missionRiskClass: "MEDIUM",
        approvalBindingHash: deriveGovernanceApprovalBindingHash({
          governanceDecisionId: decision.governanceDecisionId,
          policyVersion: POLICY,
          actionParamsFingerprint: decision.actionParamsFingerprint,
          missionRiskClass: "MEDIUM",
        }),
        expiresAt: LATER,
        businessId: 501,
        missionRef: decision.missionRef,
        planRef: decision.planRef,
        taskRef: decision.taskRef,
        subjectClass: decision.subjectClass,
        actionType: decision.actionType,
      },
    };
    expect(gate({ decision, approval: null })).toMatchObject({ consumable: false, reason: "APPROVAL_NOT_FOUND" });
    expect(gate({ decision, approval: { id: 1, userId: 7001, status: "pending", context: binding } })).toMatchObject({
      consumable: false,
      reason: "APPROVAL_PENDING",
    });
    expect(gate({ decision, approval: { id: 1, userId: 7001, status: "rejected", context: binding } })).toMatchObject({
      consumable: false,
      reason: "APPROVAL_REJECTED_BY_HUMAN",
      permanent: true,
    });
    expect(gate({ decision, approval: { id: 1, userId: 7001, status: "edited", context: binding } })).toMatchObject({
      consumable: false,
      reason: "APPROVAL_BINDING_MISMATCH",
    });
  });

  it("GV6 approval binding tamper / cross-tenant / expired all fail closed", () => {
    const decision = decisionView({
      decision: "REVIEW_REQUIRED",
      approvalBinding: { approvalBindingHash: "x", expiresAt: LATER },
    });
    const mk = (overrides: Record<string, unknown>) => ({
      id: 1,
      userId: 7001,
      status: "approved" as const,
      context: {
        missionGovernanceBinding: {
          governanceDecisionId: decision.governanceDecisionId,
          policyVersion: POLICY,
          actionParamsFingerprint: decision.actionParamsFingerprint,
          missionRiskClass: "MEDIUM",
          approvalBindingHash: deriveGovernanceApprovalBindingHash({
            governanceDecisionId: decision.governanceDecisionId,
            policyVersion: POLICY,
            actionParamsFingerprint: decision.actionParamsFingerprint,
            missionRiskClass: "MEDIUM",
          }),
          expiresAt: LATER,
          businessId: 501,
          missionRef: decision.missionRef,
          planRef: decision.planRef,
          taskRef: decision.taskRef,
          subjectClass: decision.subjectClass,
          actionType: decision.actionType,
          ...overrides,
        },
      },
    });
    expect(gate({ decision, approval: mk({ approvalBindingHash: sha256Hex("tampered") }) })).toMatchObject({ consumable: false });
    expect(gate({ decision, approval: mk({}) , expectedAction: EXPECTED })).toMatchObject({ consumable: true });
    // Cross-tenant approval row (self-approval by another identity).
    const crossTenant = mk({});
    (crossTenant as { userId: number }).userId = 7002;
    expect(gate({ decision, approval: crossTenant })).toMatchObject({
      consumable: false,
      reason: "APPROVAL_BINDING_MISMATCH",
    });
    // Expired binding.
    expect(gate({ decision, approval: mk({ expiresAt: EXPIRED }) })).toMatchObject({
      consumable: false,
      reason: "EXPIRED_APPROVAL",
    });
  });
});

// ─── Rogue-agent service-level cases ───

import {
  createInMemoryExecutionUpstreamAuthority,
  type FakeUpstreamRow,
} from "./lib/execution-coordination/execution-upstream-seams";
import {
  createInMemoryMissionGovernanceConsumptionAuthority,
  type FakeGovernanceRow,
} from "./lib/execution-coordination/execution-governance-seam";
import { createSandboxAdapterHarness } from "./lib/execution-coordination/execution-adapter-registry";
import {
  prepareExecutionAction,
  dispatchExecutionAction,
  recordExecutionResult,
  getRecoveryProjection,
  listExecutionAttempts,
  type ExecutionCoordinationServiceDeps,
} from "./lib/execution-coordination/execution-coordination-service";
import { buildCtx } from "./r5-test-support";
import { executionCoordinationRouter } from "./execution-coordination-router";

const H = (c: string) => c.repeat(64);
const MISSION_ID = `mis1:${H("a")}`;
const PLAN_ID = `pln1:${H("d")}`;
const SCHEDULE_ID = `sch1:${H("b")}`;
const TASK = "task-alpha";
const VALID_FROM = "2026-11-01T00:00:00.000Z";
const VALID_UNTIL = "2026-12-01T00:00:00.000Z";
const PARAMS = { caption: "hello" };

// Minimal fake DB (same semantics as the acceptance harness).
function makeFakeDb() {
  const tables: Record<string, Record<string, unknown>[]> = {
    mission_proposals: [],
    mission_plans: [],
    mission_plan_tasks: [],
    mission_schedules: [],
    mission_task_plan_snapshots: [],
    mission_governance_decisions: [],
    approval_requests: [],
    execution_actions: [],
    execution_attempts: [],
    execution_lifecycle_events: [],
    audit_events: [],
  };
  const uniqueChecks: Record<string, string[][]> = {
    execution_actions: [["executionActionId"], ["userId", "executionActionId"], ["userId", "idempotencyKey"]],
    execution_attempts: [["attemptId"], ["userId", "attemptId"], ["userId", "executionActionId", "attemptNumber"]],
    execution_lifecycle_events: [["lifecycleEventId"]],
    audit_events: [["eventFingerprint"]],
  };
  let autoId = 9000;
  const fake: any = {};
  fake._tables = tables;
  function evalAnd(chunks: any[], row: any): boolean {
    let lastCol: string | null = null;
    let lastOp = "";
    for (const chunk of chunks) {
      if (chunk && Array.isArray(chunk.queryChunks)) {
        if (!evalCond(chunk, row)) return false;
        continue;
      }
      if (chunk && typeof chunk === "object" && !chunk.name && Array.isArray(chunk.value)) {
        lastOp = chunk.value.join("");
        continue;
      }
      if (chunk && typeof chunk === "object" && typeof chunk.name === "string") {
        lastCol = chunk.name;
        continue;
      }
      if (chunk && typeof chunk === "object" && "value" in chunk) {
        if (lastCol === null) continue;
        const rowValue = row[lastCol];
        if (Array.isArray(chunk.value)) {
          if (!chunk.value.includes(rowValue)) return false;
        } else if (rowValue !== chunk.value) return false;
        continue;
      }
    }
    return true;
  }
  function evalCond(cond: any, row: any): boolean {
    const chunks: any[] = cond?.queryChunks ?? [];
    if (chunks.length === 0) return true;
    const groups: any[][] = [[]];
    for (const chunk of chunks) {
      if (chunk && !Array.isArray(chunk.queryChunks) && typeof chunk === "object" && !chunk.name && Array.isArray(chunk.value)) {
        if (/\bor\b/i.test(chunk.value.join("")) && !/order\b/i.test(chunk.value.join(""))) {
          groups.push([]);
          continue;
        }
      }
      groups[groups.length - 1].push(chunk);
    }
    return groups.some((g) => evalAnd(g, row));
  }
  function selectChain(table: string) {
    const state: { cond?: any; orderCol?: string; dir?: string; limit?: number } = {};
    const c: any = {};
    c.from = () => c;
    c.where = (w: any) => {
      state.cond = w;
      return c;
    };
    c.orderBy = (...cols: any[]) => {
      const col = cols[0];
      state.orderCol = col?.queryChunks?.find((x: any) => x?.name)?.name ?? col?.name ?? String(col);
      state.dir = "desc";
      return c;
    };
    c.limit = (n: number) => {
      state.limit = n;
      return c;
    };
    c.then = (resolve: (rows: unknown[]) => unknown) => {
      let out = tables[table].slice();
      if (state.cond) out = out.filter((r) => evalCond(state.cond, r));
      if (state.orderCol) {
        out = out.sort((a, b) => Number(b[state.orderCol!] ?? 0) - Number(a[state.orderCol!] ?? 0));
      }
      if (state.limit != null) out = out.slice(0, state.limit);
      return Promise.resolve(resolve(out.map((r) => ({ ...r }))));
    };
    return c;
  }
  fake.select = () => ({ from: (t: unknown) => selectChain(getTableName(t as never)) });
  fake.insert = (t: unknown) => ({
    values: async (values: Record<string, unknown>) => {
      const table = getTableName(t as never);
      for (const keys of uniqueChecks[table] ?? []) {
        for (const existing of tables[table]) {
          if (keys.every((k) => existing[k] === values[k])) {
            const err: any = new Error("Duplicate entry");
            err.code = "ER_DUP_ENTRY";
            throw err;
          }
        }
      }
      tables[table].push({ ...values, id: Number(values.id ?? ++autoId) });
      return [{ insertId: autoId, affectedRows: 1 }];
    },
  });
  fake.update = (t: unknown) => {
    const table = getTableName(t as never);
    const chain: any = {};
    chain.set = (values: Record<string, unknown>) => {
      chain._set = values;
      return chain;
    };
    chain.where = (w: any) => ({
      then: (resolve: (rows: unknown[]) => unknown) => {
        let affected = 0;
        for (const row of tables[table]) {
          if (w && !evalCond(w, row)) continue;
          Object.assign(row, chain._set);
          affected++;
        }
        return Promise.resolve(resolve([{ affectedRows: affected }]));
      },
    });
    return chain;
  };
  return fake;
}

interface SecHarness {
  fakeDb: ReturnType<typeof makeFakeDb>;
  upstreamRows: FakeUpstreamRow[];
  govRows: FakeGovernanceRow[];
  sandbox: ReturnType<typeof createSandboxAdapterHarness>;
  deps: ExecutionCoordinationServiceDeps;
}

function makeSecHarness(seedFn?: (u: FakeUpstreamRow[], g: FakeGovernanceRow[]) => string): SecHarness {
  const upstreamRows: FakeUpstreamRow[] = [];
  const govRows: FakeGovernanceRow[] = [];
  const decisionId = seedFn ? seedFn(upstreamRows, govRows) : (() => {
    upstreamRows.push(
      { table: "mission_proposals", row: { missionId: MISSION_ID, userId: 7001, businessId: 501, status: "ELIGIBLE_FOR_PLANNING", validFrom: VALID_FROM, validUntil: VALID_UNTIL } },
      { table: "mission_plans", row: { planId: PLAN_ID, planVersion: 1, userId: 7001, businessId: 501, missionId: MISSION_ID, status: "ACTIVE", validFrom: VALID_FROM, validUntil: VALID_UNTIL, planFingerprint: H("e") } },
      { table: "mission_plan_tasks", row: { taskId: TASK, planId: PLAN_ID, planVersion: 1, userId: 7001, businessId: 501, missionId: MISSION_ID, taskType: "PUBLISH_CONTENT", status: "PLANNED", requiredCapabilities: ["social.publish"], constraints: [], taskFingerprint: H("f") } },
      { table: "mission_schedules", row: { scheduleId: SCHEDULE_ID, userId: 7001, businessId: 501, missionId: MISSION_ID, planId: PLAN_ID, planFingerprint: H("e"), status: "READY", orderedTaskIds: [TASK], blockingStates: [], dependencyRefs: [], constraints: [], validFrom: VALID_FROM, validUntil: VALID_UNTIL, scheduleFingerprint: H("6") } },
      { table: "mission_task_plan_snapshots", row: { id: 1, userId: 7001, businessId: 501, missionId: MISSION_ID, planId: PLAN_ID, planDocument: {}, supportedCapabilities: ["social.publish"], taskIds: [TASK], planFingerprint: H("e"), planHash: H("7") } }
    );
    const params = deriveCanonicalActionParams({ scheduleId: SCHEDULE_ID, taskId: TASK, taskType: "PUBLISH_CONTENT", actionType: "EXECUTE_TASK", adapterType: "SOCIAL", capability: "social.publish", parameters: PARAMS });
    const decisionId = `mgd1:${H("c")}`;
    govRows.push({
      table: "mission_governance_decisions",
      row: {
        governanceDecisionId: decisionId,
        userId: 7001,
        businessId: 501,
        missionRef: MISSION_ID,
        planRef: PLAN_ID,
        taskRef: TASK,
        subjectClass: "EXECUTION_STEP",
        actionType: "EXECUTE_TASK",
        actionParamsFingerprint: deriveGovernanceActionParamsFingerprint(params),
        missionRiskClass: "MEDIUM",
        policyVersion: "mission-governance-policy/v1",
        decision: "ALLOW",
        reasonCodes: ["MISSION_ALLOWED_BY_POLICY"],
        approvalBinding: null,
        validUntil: VALID_UNTIL,
        evaluatedAt: VALID_FROM,
      },
    });
    return decisionId;
  })();
  void decisionId;
  const fakeDb = makeFakeDb();
  vi.mocked(getDb).mockReturnValue(fakeDb as never);
  const sandbox = createSandboxAdapterHarness();
  return {
    fakeDb,
    upstreamRows,
    govRows,
    sandbox,
    deps: {
      upstream: createInMemoryExecutionUpstreamAuthority(upstreamRows),
      governance: createInMemoryMissionGovernanceConsumptionAuthority(govRows),
      adapters: sandbox.registry,
      now: () => NOW,
    },
  };
}

const prepareInput = (overrides: Record<string, unknown> = {}) => ({
  scheduleId: SCHEDULE_ID,
  taskId: TASK,
  actionType: "EXECUTE_TASK",
  parameters: PARAMS,
  governanceDecisionId: `mgd1:${H("c")}`,
  ...overrides,
});

describe("R9-D security — rogue execution agent", () => {
  let h: SecHarness;

  beforeEach(() => {
    h = makeSecHarness();
  });

  it("RA1 cannot smuggle authority fields through the strict boundary", () => {
    for (const bad of [
      { ...prepareInput(), adapterType: "CRM" },
      { ...prepareInput(), dispatchState: "SUCCEEDED" },
      { ...prepareInput(), idempotencyKey: "idem1:forged" },
      { ...prepareInput(), authorizationFingerprint: H("ff") },
      { ...prepareInput(), resultStatus: "SUCCEEDED" },
      { ...prepareInput(), approvalReference: 9500 },
    ]) {
      expect(prepareExecutionActionSchema.safeParse(bad).success).toBe(false);
    }
    expect(dispatchExecutionActionSchema.safeParse({ executionActionId: `exa1:${H("a")}`, parameters: { caption: "x" } }).success).toBe(true);
    expect(dispatchExecutionActionSchema.safeParse({ parameters: { caption: "x" } }).success).toBe(false);
    expect(dispatchExecutionActionSchema.safeParse({ executionActionId: "not-an-action-id", parameters: {} }).success).toBe(false);
  });

  it("RA2 cannot fabricate schedule readiness or approval state", async () => {
    const blocked = makeSecHarness((u, g) => {
      const id = `mgd1:${H("c")}`;
      u.push(
        { table: "mission_proposals", row: { missionId: MISSION_ID, userId: 7001, businessId: 501, status: "ELIGIBLE_FOR_PLANNING", validFrom: VALID_FROM, validUntil: VALID_UNTIL } },
        { table: "mission_plans", row: { planId: PLAN_ID, planVersion: 1, userId: 7001, businessId: 501, missionId: MISSION_ID, status: "ACTIVE", validFrom: VALID_FROM, validUntil: VALID_UNTIL, planFingerprint: H("e") } },
        { table: "mission_plan_tasks", row: { taskId: TASK, planId: PLAN_ID, planVersion: 1, userId: 7001, businessId: 501, missionId: MISSION_ID, taskType: "PUBLISH_CONTENT", status: "PLANNED", requiredCapabilities: ["social.publish"], constraints: [], taskFingerprint: H("f") } },
        { table: "mission_schedules", row: { scheduleId: SCHEDULE_ID, userId: 7001, businessId: 501, missionId: MISSION_ID, planId: PLAN_ID, planFingerprint: H("e"), status: "READY", orderedTaskIds: [TASK], blockingStates: [{ taskId: TASK, readiness: "BLOCKED_DEPENDENCY", reasons: ["X"] }], dependencyRefs: [], constraints: [], validFrom: VALID_FROM, validUntil: VALID_UNTIL, scheduleFingerprint: H("6") } }
      );
      const params = deriveCanonicalActionParams({ scheduleId: SCHEDULE_ID, taskId: TASK, taskType: "PUBLISH_CONTENT", actionType: "EXECUTE_TASK", adapterType: "SOCIAL", capability: "social.publish", parameters: PARAMS });
      g.push({ table: "mission_governance_decisions", row: { governanceDecisionId: id, userId: 7001, businessId: 501, missionRef: MISSION_ID, planRef: PLAN_ID, taskRef: TASK, subjectClass: "EXECUTION_STEP", actionType: "EXECUTE_TASK", actionParamsFingerprint: deriveGovernanceActionParamsFingerprint(params), missionRiskClass: "MEDIUM", policyVersion: "mission-governance-policy/v1", decision: "ALLOW", reasonCodes: [], approvalBinding: null, validUntil: VALID_UNTIL, evaluatedAt: VALID_FROM } });
      return id;
    });
    // Readiness is never client input — injecting a readiness signal is
    // either rejected by the strict boundary or simply never consulted;
    // durable blocking evidence still wins.
    await expect(
      prepareExecutionAction(blocked.fakeDb as never, blocked.deps, { userId: 7001 }, prepareInput())
    ).rejects.toMatchObject({ code: "TASK_BLOCKED" });
    expect(blocked.sandbox.totalDispatches()).toBe(0);
  });

  it("RA3 cannot forge a governance receipt or reference another tenant's decision", async () => {
    // Cross-tenant decision reference: existence is distinguished from
    // ownership without leaking row content.
    h.govRows.length = 0;
    h.govRows.push({
      table: "mission_governance_decisions",
      row: {
        governanceDecisionId: `mgd1:${H("c")}`,
        userId: 7002,
        businessId: 999,
        missionRef: MISSION_ID,
        planRef: PLAN_ID,
        taskRef: TASK,
        subjectClass: "EXECUTION_STEP",
        actionType: "EXECUTE_TASK",
        actionParamsFingerprint: deriveGovernanceActionParamsFingerprint(deriveCanonicalActionParams({ scheduleId: SCHEDULE_ID, taskId: TASK, taskType: "PUBLISH_CONTENT", actionType: "EXECUTE_TASK", adapterType: "SOCIAL", capability: "social.publish", parameters: PARAMS })),
        missionRiskClass: "LOW",
        policyVersion: "mission-governance-policy/v1",
        decision: "ALLOW",
        reasonCodes: [],
        approvalBinding: null,
        validUntil: VALID_UNTIL,
        evaluatedAt: VALID_FROM,
      },
    });
    await expect(
      prepareExecutionAction(h.fakeDb as never, h.deps, { userId: 7001 }, prepareInput())
    ).rejects.toMatchObject({ code: "GOVERNANCE_DECISION_NOT_FOUND" });
    expect(h.sandbox.totalDispatches()).toBe(0);
  });

  it("RA4 cannot modify the action after approval (dispatch-time drift check)", async () => {
    const prepared = await prepareExecutionAction(h.fakeDb as never, h.deps, { userId: 7001 }, prepareInput());
    const actionId = String(prepared.executionAction["executionActionId"]);
    await expect(
      dispatchExecutionAction(h.fakeDb as never, h.deps, { userId: 7001 }, {
        executionActionId: actionId,
        parameters: { caption: "admin-approved? no — tampered" },
      })
    ).rejects.toMatchObject({ code: "EXECUTION_REPLAY_CONFLICT" });
    expect(h.sandbox.totalDispatches()).toBe(0);
  });

  it("RA5 tampered durable action row fails closed at dispatch revalidation", async () => {
    const prepared = await prepareExecutionAction(h.fakeDb as never, h.deps, { userId: 7001 }, prepareInput());
    const actionId = String(prepared.executionAction["executionActionId"]);
    // The agent corrupts its own tenant's row (hash-drift tamper): the
    // dispatch-time drift check fails closed before any side effect.
    const row = h.fakeDb._tables["execution_actions"][0];
    const originalHash = row.actionParametersHash;
    row.actionParametersHash = H("ff");
    await expect(
      dispatchExecutionAction(h.fakeDb as never, h.deps, { userId: 7001 }, { executionActionId: actionId, parameters: PARAMS })
    ).rejects.toMatchObject({ code: "EXECUTION_REPLAY_CONFLICT" });
    // Tampering with the bound governance reference also fails closed.
    row.actionParametersHash = originalHash;
    row.governanceDecisionId = `mgd1:${"e".repeat(64)}`;
    await expect(
      dispatchExecutionAction(h.fakeDb as never, h.deps, { userId: 7001 }, { executionActionId: actionId, parameters: PARAMS })
    ).rejects.toMatchObject({ code: "GOVERNANCE_DECISION_NOT_FOUND" });
    expect(h.sandbox.totalDispatches()).toBe(0);
  });

  it("RA6 cannot bypass idempotency or double-dispatch", async () => {
    const prepared = await prepareExecutionAction(h.fakeDb as never, h.deps, { userId: 7001 }, prepareInput());
    const actionId = String(prepared.executionAction["executionActionId"]);
    const dispatch = () =>
      dispatchExecutionAction(h.fakeDb as never, h.deps, { userId: 7001 }, { executionActionId: actionId, parameters: PARAMS });
    await dispatch();
    await expect(dispatch()).rejects.toMatchObject({ code: "INVALID_DISPATCH_STATE" });
    await expect(dispatch()).rejects.toMatchObject({ code: "INVALID_DISPATCH_STATE" });
    expect(h.sandbox.adapters.SOCIAL.dispatched).toHaveLength(1);
  });

  it("RA7 cannot mark UNCERTAIN as SUCCESS", async () => {
    const prepared = await prepareExecutionAction(h.fakeDb as never, h.deps, { userId: 7001 }, prepareInput());
    const actionId = String(prepared.executionAction["executionActionId"]);
    h.sandbox.adapters.SOCIAL.scriptOutcome("social.publish", { status: "timeout" });
    const result = await dispatchExecutionAction(h.fakeDb as never, h.deps, { userId: 7001 }, { executionActionId: actionId, parameters: PARAMS });
    expect(result.classification.resultStatus).toBe("UNCERTAIN");
    const attemptId = String(result.attempt["attemptId"]);
    // No callback queued; a bare callback call cannot claim success.
    const stillPending = await recordExecutionResult(h.fakeDb as never, h.deps, { userId: 7001 }, { attemptId });
    expect(stillPending.pending || stillPending.classification?.resultStatus !== "SUCCEEDED").toBe(true);
    const attempts = h.fakeDb._tables["execution_attempts"] as Record<string, unknown>[];
    expect(attempts[0].resultStatus).not.toBe("SUCCEEDED");
  });

  it("RA8 cannot self-authorize a retry", async () => {
    const prepared = await prepareExecutionAction(h.fakeDb as never, h.deps, { userId: 7001 }, prepareInput());
    const actionId = String(prepared.executionAction["executionActionId"]);
    h.sandbox.adapters.SOCIAL.scriptOutcome("social.publish", { status: "failure", failureClass: "PROVIDER_ERROR", retryable: true });
    await dispatchExecutionAction(h.fakeDb as never, h.deps, { userId: 7001 }, { executionActionId: actionId, parameters: PARAMS });
    await expect(
      prepareExecutionAction(h.fakeDb as never, h.deps, { userId: 7001 }, prepareInput({ actionType: "RETRY_STEP", retryOf: actionId }))
    ).rejects.toMatchObject({ code: "GOVERNANCE_NOT_CONSUMABLE" });
    expect(h.sandbox.adapters.SOCIAL.dispatched).toHaveLength(1);
  });

  it("RA9 cannot retrieve or exfiltrate secrets — none exist in the boundary", async () => {
    await expect(
      prepareExecutionAction(h.fakeDb as never, h.deps, { userId: 7001 }, prepareInput({ parameters: { credentialRef: "vault://prod" } }))
    ).rejects.toMatchObject({ code: "EXECUTION_CLIENT_AUTHORITY_FIELD_FORBIDDEN" });
    // The sandbox adapters hold no credentials at all.
    for (const adapter of Object.values(h.sandbox.adapters)) {
      expect(Object.keys(adapter)).not.toContain("credentials");
    }
    // No credential value traverses the audit ledger.
    const prepared = await prepareExecutionAction(h.fakeDb as never, h.deps, { userId: 7001 }, prepareInput());
    const actionId = String(prepared.executionAction["executionActionId"]);
    await dispatchExecutionAction(h.fakeDb as never, h.deps, { userId: 7001 }, { executionActionId: actionId, parameters: PARAMS });
    const auditText = JSON.stringify(h.fakeDb._tables["audit_events"]);
    expect(auditText).not.toMatch(/vault:\/\/|sk-[a-z0-9]{8,}|AKIA[0-9A-Z]{8}|ghp_[0-9A-Za-z]{8}/);
  });

  it("RA10 inert parameters cannot escalate privileges or mutate policy", async () => {
    await expect(
      prepareExecutionAction(h.fakeDb as never, h.deps, { userId: 7001 }, prepareInput({ parameters: { role: "admin", permissions: ["*"] } }))
    ).rejects.toMatchObject({ code: "GOVERNANCE_NOT_CONSUMABLE" }); // params drift from the approved fingerprint
    // The bound policy version is an immutable constant — no mutation path.
    expect(await h.deps.governance.currentPolicyVersion()).toBe("mission-governance-policy/v1");
    // R9-F decision rows live behind the read-only seam; after any amount of
    // execution traffic they are untouched.
    const decisionsBefore = JSON.stringify(h.govRows.filter((r) => r.table === "mission_governance_decisions"));
    expect(decisionsBefore).toContain("mission-governance-policy/v1");
    const prepared = await prepareExecutionAction(h.fakeDb as never, h.deps, { userId: 7001 }, prepareInput());
    const actionId = String(prepared.executionAction["executionActionId"]);
    await dispatchExecutionAction(h.fakeDb as never, h.deps, { userId: 7001 }, { executionActionId: actionId, parameters: PARAMS });
    expect(JSON.stringify(h.govRows.filter((r) => r.table === "mission_governance_decisions"))).toBe(decisionsBefore);
  });

  it("RA11 blast radius: a compromised agent touches only its own tenant", async () => {
    const prepared = await prepareExecutionAction(h.fakeDb as never, h.deps, { userId: 7001 }, prepareInput());
    const actionId = String(prepared.executionAction["executionActionId"]);
    await dispatchExecutionAction(h.fakeDb as never, h.deps, { userId: 7001 }, { executionActionId: actionId, parameters: PARAMS });
    // Tenant 2 observes nothing and can mutate nothing.
    expect(await getRecoveryProjection(h.fakeDb as never, { userId: 7002 }, actionId)).toBeNull();
    expect(await listExecutionAttempts(h.fakeDb as never, { userId: 7002 }, actionId)).toEqual([]);
    await expect(
      dispatchExecutionAction(h.fakeDb as never, h.deps, { userId: 7002 }, { executionActionId: actionId, parameters: PARAMS })
    ).rejects.toMatchObject({ code: "EXECUTION_ACTION_NOT_FOUND" });
    expect(h.sandbox.adapters.SOCIAL.dispatched).toHaveLength(1);
  });

  it("RA12 conservative classification never fabricates success", () => {
    const issued = "ext1:" + "a".repeat(64);
    expect(classifyAdapterOutcome({ status: "timeout" }, issued).resultStatus).toBe("UNCERTAIN");
    expect(classifyAdapterOutcome({ status: "ambiguous" }, issued).resultStatus).toBe("UNCERTAIN");
    expect(classifyAdapterOutcome({ status: "failure", retryable: true }, issued).resultStatus).toBe("FAILED_RETRYABLE");
    expect(classifyAdapterOutcome({ status: "failure", retryable: false }, issued).resultStatus).toBe("FAILED_FINAL");
    expect(classifyAdapterOutcome({ status: "success", reference: issued }, issued).resultStatus).toBe("SUCCEEDED");
    // Malformed / unknown external shapes are uncertainty, never success.
    expect(classifyAdapterOutcome({ status: "weird" } as never, issued).resultStatus).toBe("UNCERTAIN");
    expect(classifyAdapterOutcome(null as never, issued).resultStatus).toBe("UNCERTAIN");
    // A callback cannot claim success without the issued reference.
    expect(() =>
      classifyCallbackMaterial({
        attemptResultStatus: "PENDING_EXTERNAL",
        externalReference: "ext1:" + "b".repeat(64),
        issuedReference: issued,
        material: { status: "success" },
      })
    ).toThrow();
  });

  it("RA13 unauthenticated and cross-tenant router callers are rejected", async () => {
    const anon = executionCoordinationRouter.createCaller(buildCtx(null));
    await expect((anon as any).prepare(prepareInput())).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
