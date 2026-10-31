/**
 * WBS-R9-C — Dependency & Scheduling Intelligence Acceptance Suite.
 *
 * Thirty-five adversarial acceptance cases (C11.1–C11.35) over the connected
 * harness:
 *
 *   seeded R9-A mission rows + R9-F governance decision rows (REAL production
 *   raw-SQL seams behind guarded information-schema checks, served by the
 *   in-memory fake)
 *   + accepted mission-task-plan/v1 port documents (REAL port validation)
 *   → REAL missionScheduling router / service / store / graph / readiness /
 *   engine / projection
 *   → deterministic dep1: edges + sch1: schedules + msl1: lifecycle facts
 *   → frozen mission-scheduling-to-execution/v1 projection → audit ledger
 *
 * The harness runs the REAL routers + services + stores + seams against a
 * pure in-memory fake database that replicates the durable unique indexes.
 * No real database, no provider, no billing, no execution — by construction.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getTableName } from "drizzle-orm";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "./queries/connection";
import { missionSchedulingRouter } from "./mission-scheduling-router";
import { buildCtx } from "./r5-test-support";
import { canonicalJson, sha256Hex } from "./lib/conversion/conversion-contract";
import { MISSION_EXECUTION_PROJECTION_FIELD_KEYS } from "./lib/mission-scheduling/mission-scheduling-projection";
import {
  MISSION_SCHEDULE_STATUSES,
  MISSION_SCHEDULING_PROJECTION_VERSION,
} from "./lib/mission-scheduling/mission-scheduling-contract";
import {
  produceMissionSchedule,
  recordMissionDependency,
  registerMissionTaskPlan,
} from "./lib/mission-scheduling/mission-scheduling-service";
import { createInMemoryMissionUpstreamAuthority } from "./lib/mission-scheduling/mission-scheduling-upstream-seam";
import { createInMemoryMissionGovernanceAuthority } from "./lib/mission-scheduling/mission-scheduling-governance-seam";

// ─── In-memory fake database (replicates the DB unique indexes) ───

function evalCond(cond: any, row: any): boolean {
  const chunks: any[] = cond?.queryChunks ?? [];
  if (chunks.length === 0) return true;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk && Array.isArray(chunk.queryChunks)) {
      if (!evalCond(chunk, row)) return false;
      continue;
    }
    if (chunk && typeof chunk === "object" && typeof chunk.name === "string") {
      const op = chunks[i + 1];
      const param = chunks[i + 2];
      const value = param && typeof param === "object" && "value" in param ? param.value : param;
      const rowValue = row[chunk.name];
      const opName = typeof op?.operator === "string" ? op.operator : typeof op === "string" ? op : "=";
      if (opName.includes(">") && !opName.includes("=")) {
        if (!(rowValue > value)) return false;
      } else if (opName.includes("<") && !opName.includes("=")) {
        if (!(rowValue < value)) return false;
      } else if (Array.isArray(value)) {
        if (!value.includes(rowValue)) return false;
      } else if (rowValue !== value) {
        return false;
      }
      i += 2;
    }
  }
  return true;
}

/** Durable unique indexes the fake enforces (the exact-once anchors). */
const UNIQUE_CHECKS: Record<string, string[][]> = {
  mission_task_plan_snapshots: [
    ["planFingerprint"],
    ["userId", "missionId", "planId", "planFingerprint"],
  ],
  mission_dependency_edges: [
    ["dependencyId"],
    ["userId", "dependencyId"],
    ["userId", "missionId", "planId", "predecessorTaskId", "successorTaskId", "dependencyType"],
  ],
  mission_schedules: [["scheduleId"], ["userId", "scheduleId"]],
  mission_schedule_lifecycle_events: [["lifecycleEventId"]],
  audit_events: [["eventFingerprint"]],
};

/** Flatten a drizzle sql`` fragment (StringChunk / Param / nested) to text. */
function flattenSql(fragment: any): string {
  if (fragment == null) return "";
  if (typeof fragment === "string") return fragment;
  if (typeof fragment === "number" || typeof fragment === "bigint" || typeof fragment === "boolean") {
    return String(fragment);
  }
  if (Array.isArray(fragment)) return fragment.map(flattenSql).join("");
  if (typeof fragment === "object") {
    if (Array.isArray(fragment.queryChunks)) return flattenSql(fragment.queryChunks);
    if (Array.isArray(fragment.value)) return fragment.value.map(flattenSql).join("");
    if ("value" in fragment && (typeof fragment.value === "string" || typeof fragment.value === "number")) {
      return String(fragment.value);
    }
  }
  return "";
}

function sqlParam(text: string, after: string): string | null {
  const idx = text.indexOf(after);
  if (idx < 0) return null;
  const rest = text.slice(idx + after.length);
  const quoted = rest.match(/^'([^']*)'/);
  if (quoted) return quoted[1];
  // Flattened sql`` renders Param values bare (no quotes) — capture the token.
  const bare = rest.match(/^[^\s,)]+/);
  return bare ? bare[0] : null;
}

function makeFakeDb(seed: Record<string, Record<string, unknown>[]> = {}) {
  const tables: Record<string, Record<string, unknown>[]> = {
    mission_proposals: [],
    mission_governance_decisions: [],
    mission_task_plan_snapshots: [],
    mission_dependency_edges: [],
    mission_schedules: [],
    mission_schedule_lifecycle_events: [],
    audit_events: [],
    ...seed,
  };
  let autoId = 9000;
  const fake: any = {};

  function selectChain(table: string) {
    const state: { cond?: any; orderCols: string[]; limit?: number } = { orderCols: [] };
    const c: any = {};
    c.from = () => c;
    c.where = (w: any) => {
      state.cond = w;
      return c;
    };
    c.orderBy = (...cols: any[]) => {
      state.orderCols = cols.map((col) => {
        if (col && typeof col === "object" && Array.isArray(col.queryChunks)) {
          const named = col.queryChunks.find((chunk: any) => chunk && typeof chunk.name === "string");
          return named?.name ?? String(col);
        }
        return col?.name ?? String(col);
      });
      return c;
    };
    c.limit = (n: number) => {
      state.limit = n;
      return c;
    };
    c.then = (resolve: (rows: unknown[]) => unknown) => {
      let out = (tables[table] ?? []).slice();
      if (state.cond) out = out.filter((r) => evalCond(state.cond, r));
      for (const col of state.orderCols.reverse()) {
        out = out.sort((a, b) => {
          const av = (a as Record<string, unknown>)[col];
          const bv = (b as Record<string, unknown>)[col];
          const an = av instanceof Date ? av.getTime() : Number(av);
          const bn = bv instanceof Date ? bv.getTime() : Number(bv);
          if (Number.isFinite(an) && Number.isFinite(bn)) return bn - an;
          return String(bv ?? "").localeCompare(String(av ?? ""));
        });
      }
      if (state.limit != null) out = out.slice(0, state.limit);
      return Promise.resolve(resolve(out));
    };
    return c;
  }

  fake.select = () => ({
    from: (t: unknown) => selectChain(getTableName(t as never)),
  });
  fake.insert = (t: unknown) => ({
    values: async (values: Record<string, unknown>) => {
      const name = getTableName(t as never);
      const row: Record<string, unknown> = { id: ++autoId, ...values };
      for (const keys of UNIQUE_CHECKS[name] ?? []) {
        if (keys.some((k) => row[k] === undefined || row[k] === null)) continue;
        const conflict = (tables[name] ?? []).some((r) => keys.every((k) => r[k] === row[k]));
        if (conflict) {
          const err = new Error(`Duplicate entry '${keys.join("-")}'`) as Error & { code: string };
          err.code = "ER_DUP_ENTRY";
          throw err;
        }
      }
      (tables[name] ?? (tables[name] = [])).push(row);
      return [{ insertId: row.id, affectedRows: 1 }];
    },
  });
  fake.update = (t: unknown) => {
    const name = getTableName(t as never);
    return {
      set: (setValues: Record<string, unknown>) => ({
        where: (cond: any) => {
          let affected = 0;
          for (const row of tables[name] ?? []) {
            if (evalCond(cond, row)) {
              Object.assign(row, setValues);
              affected += 1;
            }
          }
          const header = { affectedRows: affected } as { affectedRows: number; 0?: unknown };
          header[0] = header;
          return Promise.resolve(header);
        },
      }),
    };
  };
  fake.execute = async (fragment: any) => {
    const text = flattenSql(fragment);
    if (text.includes("information_schema.TABLES")) {
      return [[{ c: 1 }]];
    }
    if (text.includes("FROM mission_proposals")) {
      const userId = text.match(/userId = (\d+)/);
      const missionId = sqlParam(text, "missionId = ");
      let rows = (tables.mission_proposals ?? []).slice();
      if (missionId) rows = rows.filter((r) => r.missionId === missionId);
      if (userId) rows = rows.filter((r) => Number(r.userId) === Number(userId[1]));
      return [rows];
    }
    if (text.includes("FROM mission_governance_decisions")) {
      const pairs: Array<[string, (r: Record<string, unknown>) => boolean]> = [
        ["userId = ", (r) => Number(r.userId) === Number(text.match(/userId = (\d+)/)?.[1])],
        ["businessId = ", (r) => Number(r.businessId) === Number(text.match(/businessId = (\d+)/)?.[1])],
        ["missionRef = ", (r) => r.missionRef === sqlParam(text, "missionRef = ")],
        ["taskRef = ", (r) => r.taskRef === sqlParam(text, "taskRef = ")],
        ["subjectClass = ", (r) => r.subjectClass === sqlParam(text, "subjectClass = ")],
        ["decision = ", (r) => r.decision === sqlParam(text, "decision = ")],
      ];
      let rows = (tables.mission_governance_decisions ?? []).slice();
      for (const [marker, pred] of pairs) {
        if (text.includes(marker)) rows = rows.filter(pred);
      }
      return [rows];
    }
    return [[]];
  };
  fake._tables = tables;
  return fake;
}

let fakeDb: ReturnType<typeof makeFakeDb>;

const USER1 = { id: 1, role: "user" };
const USER2 = { id: 2, role: "user" };

const NOW = new Date("2026-11-12T10:00:00.000Z");
const NOW_ISO = NOW.toISOString();
// Router-driven cases run on the real clock — every window is relative to now.
const REAL_NOW = new Date();
const HOURS_FROM_NOW = (h: number) => new Date(REAL_NOW.getTime() + h * 3_600_000).toISOString();
const DAYS_FROM_NOW = (d: number) => new Date(REAL_NOW.getTime() + d * 86_400_000).toISOString();
const SOON_ISO = HOURS_FROM_NOW(1);
const MISSION_VALID_UNTIL = DAYS_FROM_NOW(20);
const MISSION_EXPIRED_UNTIL = HOURS_FROM_NOW(-1);

function misId(tag: string): string {
  return `mis1:${sha256Hex(canonicalJson({ v: 1, tag, k: "mis" }))}`;
}

function mgdId(tag: string): string {
  return `mgd1:${sha256Hex(canonicalJson({ v: 1, tag, k: "mgd" }))}`;
}

/** Seed a durable R9-A mission row (the frozen R9-A table shape). */
function seedMission(
  userId: number,
  missionId: string,
  businessId: number,
  status = "ELIGIBLE_FOR_PLANNING",
  validUntil: string = MISSION_VALID_UNTIL
) {
  fakeDb._tables.mission_proposals.push({
    id: fakeDb._tables.mission_proposals.length + 1,
    missionId,
    objectiveId: `obj1:${sha256Hex(canonicalJson({ v: 1, missionId }))}`,
    userId,
    businessId,
    sourceCandidateId: `sor1:${sha256Hex(canonicalJson({ v: 1, missionId, k: "sor" }))}`,
    sourceReasoningIds: [],
    missionType: "OPPORTUNITY_PURSUIT",
    objectiveType: "GROWTH",
    objectiveStatement: "bounded objective",
    objectiveClientStatement: "bounded objective",
    objectiveWordingDraft: null,
    modelAssistanceFlagged: false,
    expectedOutcome: "outcome",
    successCriteria: [],
    constraints: [],
    assumptions: [],
    scope: { subjectType: "BUSINESS", businessScope: businessId, channelScope: null, campaignScope: null, geography: null },
    scopeKey: "scope",
    priorityContext: "MEDIUM",
    strategicRiskClass: "MEDIUM",
    confidenceClass: "MODERATE",
    governanceDecisionId: null,
    governanceDecision: null,
    policyVersion: null,
    governanceRequirements: [],
    validFrom: HOURS_FROM_NOW(-24),
    validUntil,
    limitations: [],
    lineageHash: sha256Hex(canonicalJson({ v: 1, missionId, k: "lineage" })),
    missionFingerprint: sha256Hex(canonicalJson({ v: 1, missionId, k: "fp" })),
    objectiveFingerprint: sha256Hex(canonicalJson({ v: 1, missionId, k: "ofp" })),
    constraintSetFingerprint: sha256Hex(canonicalJson({ v: 1, missionId, k: "cfp" })),
    sourceProjection: {},
    sourceVersions: {},
    supersedesMissionId: null,
    status,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

/** Seed a durable R9-F ALLOW decision bound to an exact task. */
function seedGovernanceAllow(
  userId: number,
  businessId: number,
  missionId: string,
  taskId: string,
  validUntil: string | null = MISSION_VALID_UNTIL
) {
  fakeDb._tables.mission_governance_decisions.push({
    id: fakeDb._tables.mission_governance_decisions.length + 1,
    governanceDecisionId: mgdId(`${missionId}:${taskId}`),
    contractVersion: "mission-governance/v1",
    engineVersion: "mission-governance-engine/v1",
    businessId,
    userId,
    missionRef: missionId,
    planRef: null,
    taskRef: taskId,
    subjectClass: "TASK",
    actionType: "task_execute",
    actionParamsFingerprint: sha256Hex(canonicalJson({ v: 1, taskId })),
    missionRiskClass: "MEDIUM",
    riskFactors: [],
    policyVersion: "mission-governance-policy/v1",
    decision: "ALLOW",
    reasonCodes: [],
    approvalRequired: false,
    approvalBinding: null,
    evaluationFingerprint: sha256Hex(canonicalJson({ v: 1, missionId, taskId, k: "eval" })),
    validUntil,
    evaluatedAt: NOW_ISO,
    thresholds: [],
    createdAt: NOW,
  });
}

interface TaskOverrides {
  taskType?: string;
  preconditions?: string[];
  postconditions?: string[];
  requiredCapabilities?: string[];
  constraints?: Array<Record<string, unknown>>;
  governance?: Record<string, unknown>;
  validity?: { validFrom: string; validUntil: string } | null;
}

function taskSpec(taskId: string, overrides: TaskOverrides = {}) {
  return {
    taskId,
    taskType: overrides.taskType ?? "generic",
    preconditions: overrides.preconditions ?? [],
    postconditions: overrides.postconditions ?? [],
    requiredCapabilities: overrides.requiredCapabilities ?? [],
    constraints: overrides.constraints ?? [],
    governanceCharacteristics: {
      requiresApproval: false,
      irreversible: false,
      financialExposure: false,
      sideEffectClass: "OBSERVATION",
      ...(overrides.governance ?? {}),
    },
    validity: overrides.validity === undefined ? null : overrides.validity,
  };
}

function planPort(missionId: string, planId: string, tasks: unknown[], supportedCapabilities: string[] = []) {
  return {
    portVersion: "mission-task-plan/v1",
    missionId,
    planId,
    supportedCapabilities,
    tasks,
  };
}

function edgeInput(
  missionId: string,
  planId: string,
  predecessorTaskId: string,
  successorTaskId: string,
  dependencyType: string = "REQUIRES_COMPLETION",
  hardOrSoft: string = "HARD",
  source: string = "PLAN_DERIVED"
) {
  return { missionId, planId, predecessorTaskId, successorTaskId, dependencyType, hardOrSoft, source };
}

function caller() {
  return missionSchedulingRouter.createCaller(buildCtx(USER1));
}

function auditEvents() {
  return fakeDb._tables.audit_events as Array<Record<string, unknown>>;
}

beforeEach(() => {
  fakeDb = makeFakeDb();
  vi.mocked(getDb).mockReturnValue(fakeDb);
});

// ─── C11 connected acceptance ───

describe("R9-C dependency & scheduling intelligence — connected acceptance (C11)", () => {
  it("C11.1 valid acyclic plan produces a graph and schedule", async () => {
    const missionId = misId("m1");
    seedMission(USER1.id, missionId, 10);
    await caller().registerPlan(
      planPort(missionId, "plan-1", [taskSpec("task-a"), taskSpec("task-b"), taskSpec("task-c")]) as never
    );
    await caller().recordDependency(edgeInput(missionId, "plan-1", "task-a", "task-b") as never);
    await caller().recordDependency(edgeInput(missionId, "plan-1", "task-b", "task-c") as never);
    const produced = await caller().produceSchedule({ missionId, planId: "plan-1" } as never);
    // Fresh plan, nothing completed: level-0 tasks occupy slots; downstream
    // tasks are dependency-blocked. Graph + schedule are produced either way.
    expect(produced.schedule.status).toBe("BLOCKED");
    expect(produced.schedule.orderedTaskIds).toEqual(["task-a"]);
    expect(produced.schedule.parallelGroups).toEqual([["task-a"]]);
    expect((produced.schedule.blockingStates as unknown[]).length).toBe(2);
    expect(produced.projection.dependencyRefs).toHaveLength(2);
  });

  it("C11.2 self-cycle is rejected", async () => {
    const missionId = misId("m2");
    seedMission(USER1.id, missionId, 10);
    await caller().registerPlan(planPort(missionId, "plan-1", [taskSpec("task-a")]) as never);
    await expect(
      caller().recordDependency(edgeInput(missionId, "plan-1", "task-a", "task-a") as never)
    ).rejects.toThrowError(/SELF_DEPENDENCY/);
  });

  it("C11.3 direct cycle is rejected", async () => {
    const missionId = misId("m3");
    seedMission(USER1.id, missionId, 10);
    await caller().registerPlan(planPort(missionId, "plan-1", [taskSpec("task-a"), taskSpec("task-b")]) as never);
    await caller().recordDependency(edgeInput(missionId, "plan-1", "task-a", "task-b") as never);
    await expect(
      caller().recordDependency(edgeInput(missionId, "plan-1", "task-b", "task-a") as never)
    ).rejects.toThrowError(/SCHEDULING_CYCLE/);
  });

  it("C11.4 indirect cycle is rejected", async () => {
    const missionId = misId("m4");
    seedMission(USER1.id, missionId, 10);
    await caller().registerPlan(
      planPort(missionId, "plan-1", [taskSpec("task-a"), taskSpec("task-b"), taskSpec("task-c")]) as never
    );
    await caller().recordDependency(edgeInput(missionId, "plan-1", "task-a", "task-b") as never);
    await caller().recordDependency(edgeInput(missionId, "plan-1", "task-b", "task-c") as never);
    await expect(
      caller().recordDependency(edgeInput(missionId, "plan-1", "task-c", "task-a") as never)
    ).rejects.toThrowError(/SCHEDULING_CYCLE/);
  });

  it("C11.5 unknown predecessor is rejected", async () => {
    const missionId = misId("m5");
    seedMission(USER1.id, missionId, 10);
    await caller().registerPlan(planPort(missionId, "plan-1", [taskSpec("task-a")]) as never);
    await expect(
      caller().recordDependency(edgeInput(missionId, "plan-1", "task-ghost", "task-a") as never)
    ).rejects.toThrowError(/UNKNOWN_PREDECESSOR_TASK/);
  });

  it("C11.6 unknown successor is rejected", async () => {
    const missionId = misId("m6");
    seedMission(USER1.id, missionId, 10);
    await caller().registerPlan(planPort(missionId, "plan-1", [taskSpec("task-a")]) as never);
    await expect(
      caller().recordDependency(edgeInput(missionId, "plan-1", "task-a", "task-ghost") as never)
    ).rejects.toThrowError(/UNKNOWN_SUCCESSOR_TASK/);
  });

  it("C11.7 cross-mission dependency is rejected", async () => {
    const missionA = misId("m7a");
    const missionB = misId("m7b");
    seedMission(USER1.id, missionA, 10);
    seedMission(USER1.id, missionB, 10);
    await caller().registerPlan(planPort(missionA, "plan-a", [taskSpec("task-a")]) as never);
    await caller().registerPlan(planPort(missionB, "plan-b", [taskSpec("task-b")]) as never);
    await expect(
      caller().recordDependency(edgeInput(missionA, "plan-a", "task-b", "task-a") as never)
    ).rejects.toThrowError(/CROSS_MISSION_DEPENDENCY/);
  });

  it("C11.8 cross-tenant dependency is rejected", async () => {
    const missionOther = misId("m8-other");
    seedMission(USER2.id, missionOther, 20);
    await expect(
      caller().recordDependency(edgeInput(missionOther, "plan-x", "task-a", "task-b") as never)
    ).rejects.toThrowError(/CROSS_TENANT_DEPENDENCY/);
  });

  it("C11.9 cross-business dependency is rejected", async () => {
    const missionA = misId("m9a");
    seedMission(USER1.id, missionA, 10);
    seedMission(USER1.id, misId("m9b"), 30);
    await caller().registerPlan(planPort(missionA, "plan-a", [taskSpec("task-a")]) as never);
    // task-b lives under business 30 of the same tenant (another plan).
    await caller().registerPlan(planPort(misId("m9b"), "plan-b", [taskSpec("task-b")]) as never);
    await expect(
      caller().recordDependency(edgeInput(missionA, "plan-a", "task-b", "task-a") as never)
    ).rejects.toThrowError(/CROSS_BUSINESS_DEPENDENCY/);
  });

  it("C11.10 hard dependency blocks the successor", async () => {
    const missionId = misId("m10");
    seedMission(USER1.id, missionId, 10);
    await caller().registerPlan(planPort(missionId, "plan-1", [taskSpec("task-a"), taskSpec("task-b")]) as never);
    await caller().recordDependency(edgeInput(missionId, "plan-1", "task-a", "task-b") as never);
    const produced = await caller().produceSchedule({ missionId, planId: "plan-1" } as never);
    expect(produced.schedule.status).toBe("BLOCKED");
    const blocked = produced.schedule.blockingStates as Array<{ taskId: string; readiness: string }>;
    expect(blocked).toEqual([{ taskId: "task-b", readiness: "BLOCKED_DEPENDENCY", reasons: ["UNMET_REQUIRES_COMPLETION:task-a"] }]);
    expect(produced.schedule.orderedTaskIds).toEqual(["task-a"]);
  });

  it("C11.11 completed predecessor unblocks the successor where valid", async () => {
    const missionId = misId("m11");
    seedMission(USER1.id, missionId, 10);
    await caller().registerPlan(planPort(missionId, "plan-1", [taskSpec("task-a"), taskSpec("task-b")]) as never);
    await caller().recordDependency(edgeInput(missionId, "plan-1", "task-a", "task-b") as never);
    const produced = await caller().produceSchedule({
      missionId,
      planId: "plan-1",
      executionState: { portVersion: "mission-scheduling-state/v1", completedTaskIds: ["task-a"], succeededTaskIds: ["task-a"] },
    } as never);
    expect(produced.schedule.status).toBe("READY");
    expect(produced.schedule.orderedTaskIds).toEqual(["task-a", "task-b"]);
  });

  it("C11.12 approval dependency remains blocked without approval", async () => {
    const missionId = misId("m12");
    seedMission(USER1.id, missionId, 10);
    await caller().registerPlan(planPort(missionId, "plan-1", [taskSpec("task-a"), taskSpec("task-b")]) as never);
    await caller().recordDependency(
      edgeInput(missionId, "plan-1", "task-a", "task-b", "REQUIRES_APPROVAL") as never
    );
    const produced = await caller().produceSchedule({ missionId, planId: "plan-1" } as never);
    expect(produced.schedule.status).toBe("BLOCKED");
    const blocked = produced.schedule.blockingStates as Array<{ taskId: string; readiness: string }>;
    expect(blocked[0].readiness).toBe("BLOCKED_APPROVAL");
    const governance = produced.schedule.governanceRequirements as { requiresApproval: boolean; reasonCodes: string[] };
    expect(governance.requiresApproval).toBe(true);
    expect(governance.reasonCodes).toContain("APPROVAL_EVIDENCE_MISSING");
  });

  it("C11.13 capability dependency remains blocked without capability", async () => {
    const missionId = misId("m13");
    seedMission(USER1.id, missionId, 10);
    await caller().registerPlan(
      planPort(
        missionId,
        "plan-1",
        [taskSpec("task-a", { requiredCapabilities: ["whatsapp"] }), taskSpec("task-b")],
        ["email"]
      ) as never
    );
    await caller().recordDependency(
      edgeInput(missionId, "plan-1", "task-b", "task-a", "REQUIRES_CAPABILITY") as never
    );
    const produced = await caller().produceSchedule({ missionId, planId: "plan-1" } as never);
    const blocked = produced.schedule.blockingStates as Array<{ taskId: string; readiness: string }>;
    expect(blocked.find((b) => b.taskId === "task-a")?.readiness).toBe("BLOCKED_CAPABILITY");
  });

  it("C11.14 expired mission is not scheduled", async () => {
    const missionId = misId("m14");
    seedMission(USER1.id, missionId, 10, "ELIGIBLE_FOR_PLANNING", MISSION_EXPIRED_UNTIL);
    await caller().registerPlan(planPort(missionId, "plan-1", [taskSpec("task-a")]) as never);
    const before = fakeDb._tables.mission_schedules.length;
    await expect(caller().produceSchedule({ missionId, planId: "plan-1" } as never)).rejects.toThrowError(
      /MISSION_EXPIRED/
    );
    expect(fakeDb._tables.mission_schedules.length).toBe(before);
  });

  it("C11.15 stale task is not scheduled", async () => {
    const missionId = misId("m15");
    seedMission(USER1.id, missionId, 10);
    await caller().registerPlan(
      planPort(missionId, "plan-1", [
        taskSpec("task-a"),
        taskSpec("task-b", { validity: { validFrom: HOURS_FROM_NOW(-24), validUntil: HOURS_FROM_NOW(-1) } }),
      ]) as never
    );
    const produced = await caller().produceSchedule({ missionId, planId: "plan-1" } as never);
    expect(produced.schedule.orderedTaskIds).toEqual(["task-a"]);
    const stale = (produced.schedule.blockingStates as Array<{ taskId: string; readiness: string }>).find(
      (b) => b.taskId === "task-b"
    );
    expect(stale?.readiness).toBe("STALE");
  });

  it("C11.16 independent tasks may run in parallel", async () => {
    const missionId = misId("m16");
    seedMission(USER1.id, missionId, 10);
    await caller().registerPlan(planPort(missionId, "plan-1", [taskSpec("task-a"), taskSpec("task-b")]) as never);
    const produced = await caller().produceSchedule({ missionId, planId: "plan-1" } as never);
    expect(produced.schedule.parallelGroups).toEqual([["task-a", "task-b"]]);
  });

  it("C11.17 mutually exclusive tasks are serialized", async () => {
    const missionId = misId("m17");
    seedMission(USER1.id, missionId, 10);
    await caller().registerPlan(planPort(missionId, "plan-1", [taskSpec("task-a"), taskSpec("task-b")]) as never);
    await caller().recordDependency(
      edgeInput(missionId, "plan-1", "task-b", "task-a", "MUTUAL_EXCLUSION") as never
    );
    const produced = await caller().produceSchedule({ missionId, planId: "plan-1" } as never);
    expect(produced.schedule.parallelGroups).toEqual([["task-a"], ["task-b"]]);
  });

  it("C11.18 schedule identity is deterministic across clock drift", async () => {
    const missionId = misId("m18");
    seedMission(USER1.id, missionId, 10);
    // Pin mission validity around the fixed deterministic clock used below.
    const missionRow = fakeDb._tables.mission_proposals.find(
      (r: Record<string, unknown>) => r.missionId === missionId
    ) as Record<string, unknown>;
    missionRow.validFrom = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    missionRow.validUntil = new Date(NOW.getTime() + 10 * 24 * 60 * 60 * 1000).toISOString();
    const plan = planPort(missionId, "plan-1", [taskSpec("task-a"), taskSpec("task-b")]);
    const deps = {
      upstream: createInMemoryMissionUpstreamAuthority(
        fakeDb._tables.mission_proposals.map((row: Record<string, unknown>) => ({ row }))
      ),
      governance: createInMemoryMissionGovernanceAuthority([]),
    };
    await registerMissionTaskPlan(fakeDb, deps, { userId: USER1.id }, plan);
    await recordMissionDependency(fakeDb, deps, { userId: USER1.id }, edgeInput(missionId, "plan-1", "task-a", "task-b"), NOW_ISO);
    const t1 = new Date(NOW.getTime() + 1000).toISOString();
    const t2 = new Date(NOW.getTime() + 9000).toISOString();
    const p1 = await produceMissionSchedule(fakeDb, deps, { userId: USER1.id }, { missionId, planId: "plan-1" }, t1);
    const p2 = await produceMissionSchedule(fakeDb, deps, { userId: USER1.id }, { missionId, planId: "plan-1" }, t2);
    expect(p1.schedule.scheduleId).toBe(p2.schedule.scheduleId);
    expect(p1.schedule.orderedTaskIds).toEqual(p2.schedule.orderedTaskIds);
    expect(p2.duplicateClassification).toBe("idempotent_replay");
  });

  it("C11.19 duplicate request converges with zero new effects", async () => {
    const missionId = misId("m19");
    seedMission(USER1.id, missionId, 10);
    await caller().registerPlan(planPort(missionId, "plan-1", [taskSpec("task-a")]) as never);
    await caller().produceSchedule({ missionId, planId: "plan-1" } as never);
    const schedulesBefore = fakeDb._tables.mission_schedules.length;
    const lifecycleBefore = fakeDb._tables.mission_schedule_lifecycle_events.length;
    const auditBefore = auditEvents().length;
    const again = await caller().produceSchedule({ missionId, planId: "plan-1" } as never);
    expect(fakeDb._tables.mission_schedules.length).toBe(schedulesBefore);
    expect(fakeDb._tables.mission_schedule_lifecycle_events.length).toBe(lifecycleBefore);
    expect(auditEvents().length).toBe(auditBefore);
    expect(again.duplicateClassification).toBe("idempotent_replay");
  });

  it("C11.20 conflicting replay fails closed", async () => {
    const missionId = misId("m20");
    seedMission(USER1.id, missionId, 10);
    await caller().registerPlan(planPort(missionId, "plan-1", [taskSpec("task-a")]) as never);
    const first = await caller().produceSchedule({ missionId, planId: "plan-1" } as never);
    // Tamper: same scheduleId, different fingerprint (simulated replay drift).
    const row = fakeDb._tables.mission_schedules.find((r: Record<string, unknown>) => r.scheduleId === first.schedule.scheduleId)!;
    (row as Record<string, unknown>).scheduleFingerprint = sha256Hex(canonicalJson({ v: 1, tampered: true }));
    await expect(caller().produceSchedule({ missionId, planId: "plan-1" } as never)).rejects.toThrowError(
      /SCHEDULING_REPLAY_CONFLICT/
    );
  });

  it("C11.21 a model cannot remove a dependency", async () => {
    const missionId = misId("m21");
    seedMission(USER1.id, missionId, 10);
    await caller().registerPlan(planPort(missionId, "plan-1", [taskSpec("task-a"), taskSpec("task-b")]) as never);
    await caller().recordDependency(edgeInput(missionId, "plan-1", "task-a", "task-b") as never);
    await caller().produceSchedule({ missionId, planId: "plan-1" } as never);
    // No removal path exists anywhere on the surface; the durable edge set is
    // unchanged by schedule production and the successor stays blocked.
    expect(fakeDb._tables.mission_dependency_edges).toHaveLength(1);
    const produced = await caller().produceSchedule({ missionId, planId: "plan-1" } as never);
    expect((produced.schedule.blockingStates as unknown[]).length).toBe(1);
    const procedures = Object.keys(missionSchedulingRouter._def.procedures);
    expect(procedures.some((name) => /delete|remove|drop/i.test(name))).toBe(false);
  });

  it("C11.22 a model cannot override cycle detection (tampered edge fails closed)", async () => {
    const missionId = misId("m22");
    seedMission(USER1.id, missionId, 10);
    await caller().registerPlan(planPort(missionId, "plan-1", [taskSpec("task-a"), taskSpec("task-b")]) as never);
    await caller().recordDependency(edgeInput(missionId, "plan-1", "task-a", "task-b") as never);
    // Tamper with the stored edge material: integrity assertion fires before
    // any graph verdict can be influenced.
    fakeDb._tables.mission_dependency_edges[0].successorTaskId = "task-a";
    await expect(caller().produceSchedule({ missionId, planId: "plan-1" } as never)).rejects.toThrowError(
      /SCHEDULING_TAMPER/
    );
  });

  it("C11.23 a client cannot mark a task ready", async () => {
    const missionId = misId("m23");
    seedMission(USER1.id, missionId, 10);
    await caller().registerPlan(planPort(missionId, "plan-1", [taskSpec("task-a"), taskSpec("task-b")]) as never);
    await caller().recordDependency(edgeInput(missionId, "plan-1", "task-a", "task-b") as never);
    await expect(
      caller().produceSchedule({
        missionId,
        planId: "plan-1",
        executionState: {
          portVersion: "mission-scheduling-state/v1",
          completedTaskIds: ["task-b", "task-ghost"],
          succeededTaskIds: [],
        },
      } as never)
    ).rejects.toThrowError(/EXECUTION_STATE_INVALID/);
    // Readiness is never an accepted input field.
    await expect(
      caller().produceSchedule({
        missionId,
        planId: "plan-1",
        readiness: "READY_FOR_SCHEDULING",
      } as never)
    ).rejects.toThrowError(/unrecognized_key/i);
  });

  it("C11.24 a client cannot mark an approval satisfied", async () => {
    const missionId = misId("m24");
    seedMission(USER1.id, missionId, 10);
    await caller().registerPlan(
      planPort(missionId, "plan-1", [
        taskSpec("task-a", { governance: { requiresApproval: true } }),
        taskSpec("task-b"),
      ]) as never
    );
    await expect(
      caller().produceSchedule({
        missionId,
        planId: "plan-1",
        approvalEvidence: { "task-a": true },
      } as never)
    ).rejects.toThrowError(/unrecognized_key/i);
    const produced = await caller().produceSchedule({ missionId, planId: "plan-1" } as never);
    const blocked = (produced.schedule.blockingStates as Array<{ taskId: string; readiness: string }>).find(
      (b) => b.taskId === "task-a"
    );
    expect(blocked?.readiness).toBe("BLOCKED_APPROVAL");
  });

  it("C11.25 urgency can never lower scheduling risk", async () => {
    const missionFar = misId("m25-far");
    const missionNear = misId("m25-near");
    const nearUntilTight = HOURS_FROM_NOW(3);
    const validFrom = HOURS_FROM_NOW(-20); // 20h window, 3h left = 15% remaining (<25% ⇒ urgency)
    seedMission(USER1.id, missionFar, 10, "ELIGIBLE_FOR_PLANNING", MISSION_VALID_UNTIL);
    (fakeDb._tables.mission_proposals.find((m: Record<string, unknown>) => m.missionId === missionFar) as Record<string, unknown>).validFrom = validFrom;
    seedMission(USER1.id, missionNear, 10, "ELIGIBLE_FOR_PLANNING", MISSION_VALID_UNTIL);
    const nearRow = fakeDb._tables.mission_proposals.find((m: Record<string, unknown>) => m.missionId === missionNear) as Record<string, unknown>;
    nearRow.validFrom = validFrom;
    nearRow.validUntil = nearUntilTight;

    await caller().registerPlan(planPort(missionFar, "plan-1", [taskSpec("task-a")]) as never);
    await caller().registerPlan(planPort(missionNear, "plan-1", [taskSpec("task-a")]) as never);
    const farSchedule = await caller().produceSchedule({ missionId: missionFar, planId: "plan-1" } as never);
    const nearSchedule = await caller().produceSchedule({ missionId: missionNear, planId: "plan-1" } as never);
    // Both carry LOW-risk tasks; the near-expiry (urgent) mission is raised,
    // never lowered, and never below the far-expiry mission's class.
    expect(farSchedule.schedule.riskClass).toBe("LOW");
    expect(nearSchedule.schedule.riskClass).toBe("MEDIUM");
    expect(["LOW", "MEDIUM", "HIGH", "CRITICAL"].indexOf(nearSchedule.schedule.riskClass)).toBeGreaterThan(
      ["LOW", "MEDIUM", "HIGH", "CRITICAL"].indexOf(farSchedule.schedule.riskClass)
    );
  });

  it("C11.26 scheduling cannot modify the task definition", async () => {
    const missionId = misId("m26");
    seedMission(USER1.id, missionId, 10);
    const port = planPort(missionId, "plan-1", [taskSpec("task-a", { preconditions: ["lead-data"] })]);
    await caller().registerPlan(port as never);
    await caller().produceSchedule({ missionId, planId: "plan-1" } as never);
    const snapshot = fakeDb._tables.mission_task_plan_snapshots[0];
    expect(snapshot.planDocument).toEqual(port);
    const storedTask = (snapshot.planDocument as { tasks: Array<{ preconditions: string[] }> }).tasks[0];
    expect(storedTask.preconditions).toEqual(["lead-data"]);
  });

  it("C11.27 scheduling cannot modify the mission objective", async () => {
    const missionId = misId("m27");
    seedMission(USER1.id, missionId, 10);
    const before = JSON.parse(JSON.stringify(fakeDb._tables.mission_proposals));
    await caller().registerPlan(planPort(missionId, "plan-1", [taskSpec("task-a")]) as never);
    await caller().produceSchedule({ missionId, planId: "plan-1" } as never);
    expect(JSON.parse(JSON.stringify(fakeDb._tables.mission_proposals))).toEqual(before);
  });

  it("C11.28 scheduling cannot grant execution authority", async () => {
    const missionId = misId("m28");
    seedMission(USER1.id, missionId, 10);
    await caller().registerPlan(planPort(missionId, "plan-1", [taskSpec("task-a")]) as never);
    const produced = await caller().produceSchedule({ missionId, planId: "plan-1" } as never);
    expect(produced.projection.executionClaimed).toBe(false);
    expect(produced.projection.scheduleClaimed).toBe(false);
    // No governance decision was minted: the R9-F table is untouched.
    expect(fakeDb._tables.mission_governance_decisions).toHaveLength(0);
    const governance = produced.schedule.governanceRequirements as { authorityScope: string };
    expect(governance.authorityScope).toBe("RECOMMENDATION_ONLY");
  });

  it("C11.29 scheduling cannot invoke a provider", async () => {
    const missionId = misId("m29");
    seedMission(USER1.id, missionId, 10);
    await caller().registerPlan(
      planPort(missionId, "plan-1", [taskSpec("task-a", { requiredCapabilities: ["email"] })], ["email"]) as never
    );
    await caller().produceSchedule({ missionId, planId: "plan-1" } as never);
    // Zero external effects: no queue/provider/billing tables touched; only
    // R9-C tables + system-sourced audit events exist.
    expect(fakeDb._tables.mission_dependency_edges).toHaveLength(0);
    for (const event of auditEvents()) {
      expect(event.source).toBe("system");
      expect(["mission_dependency_recorded", "mission_schedule_committed", "mission_schedule_lifecycle"]).toContain(
        event.eventType
      );
    }
  });

  it("C11.30 schedule status can never become EXECUTING", async () => {
    const missionId = misId("m30");
    seedMission(USER1.id, missionId, 10);
    await caller().registerPlan(planPort(missionId, "plan-1", [taskSpec("task-a")]) as never);
    await caller().produceSchedule({ missionId, planId: "plan-1" } as never);
    await caller().sweepExpiry({} as never);
    const statuses = (fakeDb._tables.mission_schedules as Array<{ status: string }>).map((r) => r.status);
    for (const status of statuses) {
      expect(MISSION_SCHEDULE_STATUSES).toContain(status);
      expect(status).not.toBe("EXECUTING");
    }
    expect(MISSION_SCHEDULE_STATUSES).not.toContain("EXECUTING");
  });

  it("C11.31 schedule revision preserves lineage", async () => {
    const missionId = misId("m31");
    seedMission(USER1.id, missionId, 10);
    await caller().registerPlan(planPort(missionId, "plan-1", [taskSpec("task-a"), taskSpec("task-b")]) as never);
    const first = await caller().produceSchedule({ missionId, planId: "plan-1" } as never);
    const second = await caller().produceSchedule({
      missionId,
      planId: "plan-1",
      executionState: { portVersion: "mission-scheduling-state/v1", completedTaskIds: ["task-a"], succeededTaskIds: [] },
    } as never);
    expect(second.schedule.scheduleId).not.toBe(first.schedule.scheduleId);
    expect(second.schedule.supersedesScheduleId).toBe(first.schedule.scheduleId);
    const firstRow = fakeDb._tables.mission_schedules.find((r: Record<string, unknown>) => r.scheduleId === first.schedule.scheduleId) as {
      status: string;
    };
    expect(firstRow.status).toBe("SUPERSEDED");
    const lifecycle = await caller().listLifecycle({ scheduleId: first.schedule.scheduleId } as never);
    const supersession = (lifecycle.lifecycle as Array<{ lifecycleType: string; successorScheduleId: string }>).find(
      (f) => f.lifecycleType === "supersession"
    );
    expect(supersession?.successorScheduleId).toBe(second.schedule.scheduleId);
  });

  it("C11.32 changed dependency supersedes the schedule", async () => {
    const missionId = misId("m32");
    seedMission(USER1.id, missionId, 10);
    await caller().registerPlan(
      planPort(missionId, "plan-1", [taskSpec("task-a"), taskSpec("task-b"), taskSpec("task-c")]) as never
    );
    await caller().recordDependency(edgeInput(missionId, "plan-1", "task-a", "task-b") as never);
    const first = await caller().produceSchedule({ missionId, planId: "plan-1" } as never);
    await caller().recordDependency(edgeInput(missionId, "plan-1", "task-b", "task-c") as never);
    const second = await caller().produceSchedule({
      missionId,
      planId: "plan-1",
      executionState: {
        portVersion: "mission-scheduling-state/v1",
        completedTaskIds: ["task-a", "task-b"],
        succeededTaskIds: ["task-a", "task-b"],
      },
    } as never);
    expect(second.schedule.scheduleId).not.toBe(first.schedule.scheduleId);
    expect(second.schedule.supersedesScheduleId).toBe(first.schedule.scheduleId);
    expect(second.schedule.orderedTaskIds).toEqual(["task-a", "task-b", "task-c"]);
  });

  it("C11.33 changed approval expiry re-evaluates readiness", async () => {
    const missionId = misId("m33");
    seedMission(USER1.id, missionId, 10);
    await caller().registerPlan(
      planPort(missionId, "plan-1", [
        taskSpec("task-a", { governance: { requiresApproval: true } }),
        taskSpec("task-b"),
      ]) as never
    );
    seedGovernanceAllow(USER1.id, 10, missionId, "task-a", MISSION_VALID_UNTIL);
    const approved = await caller().produceSchedule({ missionId, planId: "plan-1" } as never);
    expect(approved.schedule.status).toBe("READY");
    // The R9-F decision expires; readiness must degrade on re-evaluation.
    const decision = fakeDb._tables.mission_governance_decisions[0];
    decision.validUntil = MISSION_EXPIRED_UNTIL;
    const reevaluated = await caller().produceSchedule({ missionId, planId: "plan-1" } as never);
    expect(reevaluated.schedule.scheduleId).not.toBe(approved.schedule.scheduleId);
    expect(reevaluated.schedule.status).toBe("BLOCKED");
    const blocked = (reevaluated.schedule.blockingStates as Array<{ taskId: string; readiness: string }>).find(
      (b) => b.taskId === "task-a"
    );
    expect(blocked?.readiness).toBe("BLOCKED_APPROVAL");
  });

  it("C11.34 downstream projection is read-only and exactly shaped", async () => {
    const missionId = misId("m34");
    seedMission(USER1.id, missionId, 10);
    await caller().registerPlan(
      planPort(
        missionId,
        "plan-1",
        [taskSpec("task-a", { constraints: [{ constraintType: "TIME_WINDOW", notAfter: MISSION_VALID_UNTIL }] })],
        ["email"]
      ) as never
    );
    const produced = await caller().produceSchedule({ missionId, planId: "plan-1" } as never);
    expect(Object.keys(produced.projection).sort()).toEqual([...MISSION_EXECUTION_PROJECTION_FIELD_KEYS].sort());
    expect(produced.projection.contractVersion).toBe(MISSION_SCHEDULING_PROJECTION_VERSION);
    expect(produced.projection.scheduleClaimed).toBe(false);
    expect(produced.projection.executionClaimed).toBe(false);
    expect(produced.projection.schedulingDisclaimer).toMatch(/never execution authorization/);
    expect(produced.projection.executionDisclaimer).toMatch(/schedule != execution authorization/);
    // Mutating the returned projection does not touch the durable schedule.
    const before = JSON.parse(JSON.stringify(fakeDb._tables.mission_schedules[0]));
    (produced.projection as unknown as { orderedTaskIds: string[] }).orderedTaskIds.push("task-evil");
    expect(fakeDb._tables.mission_schedules[0]).toEqual(before);
    const reread = await caller().getSchedule({ scheduleId: produced.schedule.scheduleId } as never);
    expect(reread.projection.orderedTaskIds).toEqual(["task-a"]);
  });

  it("C11.35 no production action: only scheduling tables + scheduling audits exist", async () => {
    const missionId = misId("m35");
    seedMission(USER1.id, missionId, 10);
    await caller().registerPlan(planPort(missionId, "plan-1", [taskSpec("task-a"), taskSpec("task-b")]) as never);
    await caller().recordDependency(edgeInput(missionId, "plan-1", "task-a", "task-b") as never);
    await caller().produceSchedule({ missionId, planId: "plan-1" } as never);
    const tables = fakeDb._tables as Record<string, unknown[]>;
    for (const name of Object.keys(tables)) {
      if (
        [
          "mission_proposals",
          "mission_governance_decisions",
          "mission_task_plan_snapshots",
          "mission_dependency_edges",
          "mission_schedules",
          "mission_schedule_lifecycle_events",
          "audit_events",
        ].includes(name)
      ) {
        continue;
      }
      expect(tables[name], `table ${name} must be untouched`).toHaveLength(0);
    }
    expect(auditEvents().length).toBeGreaterThan(0);
    const eventTypes = new Set(auditEvents().map((e) => e.eventType));
    expect([...eventTypes].every((t) => String(t).startsWith("mission_"))).toBe(true);
  });
});
