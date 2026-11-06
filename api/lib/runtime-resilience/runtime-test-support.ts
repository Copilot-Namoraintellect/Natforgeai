// R10-C connected fixture, adapted from the frozen R9-D acceptance harness.
// Evaluates real Drizzle predicates and unique indexes; not a mocked runtime service.
import { vi } from "vitest";
import { getTableName } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import { deriveCanonicalActionParams } from "../execution-coordination/execution-coordination-identity";
import {
  deriveGovernanceActionParamsFingerprint,
  deriveGovernanceApprovalBindingHash,
  readMissionApprovalBinding,
  createInMemoryMissionGovernanceConsumptionAuthority,
  type FakeGovernanceRow,
} from "../execution-coordination/execution-governance-seam";
import {
  createInMemoryExecutionUpstreamAuthority,
  type FakeUpstreamRow,
} from "../execution-coordination/execution-upstream-seams";
import { createSandboxAdapterHarness } from "../execution-coordination/execution-adapter-registry";
import {
  prepareExecutionAction,
  type ExecutionCoordinationServiceDeps,
} from "../execution-coordination/execution-coordination-service";
const NOW = "2026-11-10T12:00:00.000Z";
const USER1 = 7001;
const USER2 = 7002;
const BUSINESS1 = 501;
const BUSINESS2 = 502;

const H = (c: string) => c.repeat(64);
const MISSION_ID = `mis1:${H("a")}`;
const PLAN_ID = `pln1:${H("d")}`;
const SCHEDULE_ID = `sch1:${H("b")}`;
const TASK_ALPHA = "task-alpha";
const TASK_BETA = "task-beta";
const POLICY_VERSION = "mission-governance-policy/v1";
const VALID_FROM = "2026-11-01T00:00:00.000Z";
const VALID_UNTIL = "2026-12-01T00:00:00.000Z";

// ─── In-memory fake database (replicates the DB unique indexes) ───

const UNIQUE_CHECKS: Record<string, string[][]> = {
  runtime_workers: [["workerInstanceId"]],
  runtime_jobs: [["jobId"]],
  runtime_leases: [["leaseId"]],
  runtime_dead_letters: [["deadLetterId"]],
  runtime_lifecycle_events: [["lifecycleEventId"]],
  execution_actions: [
    ["executionActionId"],
    ["userId", "executionActionId"],
    ["userId", "idempotencyKey"],
  ],
  execution_attempts: [
    ["attemptId"],
    ["userId", "attemptId"],
    ["userId", "executionActionId", "attemptNumber"],
  ],
  execution_lifecycle_events: [["lifecycleEventId"]],
  audit_events: [["eventFingerprint"]],
};

function flattenSql(fragment: any): string {
  if (fragment == null) return "";
  if (typeof fragment === "string") return fragment;
  if (
    typeof fragment === "number" ||
    typeof fragment === "bigint" ||
    typeof fragment === "boolean"
  )
    return String(fragment);
  if (Array.isArray(fragment)) return fragment.map(flattenSql).join("");
  if (typeof fragment === "object") {
    if (Array.isArray(fragment.queryChunks))
      return flattenSql(fragment.queryChunks);
    if (Array.isArray(fragment.value))
      return fragment.value.map(flattenSql).join("");
    if (
      "value" in fragment &&
      (typeof fragment.value === "string" || typeof fragment.value === "number")
    ) {
      return String(fragment.value);
    }
  }
  return "";
}

function evalCond(cond: any, row: any): boolean {
  const chunks: any[] = cond?.queryChunks ?? [];
  if (chunks.length === 0) return true;
  // Split top-level chunks on " or " into disjunction groups (each group is
  // a conjunction over its members).
  const groups: any[][] = [[]];
  for (const chunk of chunks) {
    if (
      chunk &&
      !Array.isArray(chunk.queryChunks) &&
      typeof chunk === "object" &&
      !chunk.name &&
      Array.isArray(chunk.value)
    ) {
      const text = chunk.value.join("");
      if (/\bor\b/i.test(text) && !/order\b/i.test(text)) {
        groups.push([]);
        continue;
      }
    }
    groups[groups.length - 1].push(chunk);
  }
  return groups.some(group => evalAnd(group, row));
}

function evalAnd(chunks: any[], row: any): boolean {
  let lastCol: string | null = null;
  let lastOpText = "";
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk && Array.isArray(chunk.queryChunks)) {
      if (!evalCond(chunk, row)) return false;
      continue;
    }
    if (
      chunk &&
      typeof chunk === "object" &&
      !chunk.name &&
      Array.isArray(chunk.value)
    ) {
      // StringChunk: operator / keyword text.
      const text = chunk.value.join("");
      lastOpText = text;
      const trimmed = text.trim();
      if (/\bis not null$/i.test(trimmed)) {
        if (
          lastCol === null ||
          row[lastCol] === null ||
          row[lastCol] === undefined
        )
          return false;
      } else if (/\bis null$/i.test(trimmed)) {
        if (
          lastCol === null ||
          (row[lastCol] !== null && row[lastCol] !== undefined)
        )
          return false;
      }
      continue;
    }
    if (chunk && typeof chunk === "object" && typeof chunk.name === "string") {
      lastCol = chunk.name;
      lastOpText = "";
      continue;
    }
    if (chunk && typeof chunk === "object" && "value" in chunk) {
      const value = chunk.value;
      if (lastCol === null) continue;
      const rowValue = row[lastCol];
      const op = lastOpText;
      if (op.includes(">") && !op.includes("=")) {
        if (!(rowValue > value)) return false;
      } else if (op.includes("<") && !op.includes("=")) {
        if (!(rowValue < value)) return false;
      } else if (op.includes("!=") || op.includes("<>")) {
        if (!(rowValue !== value)) return false;
      } else if (Array.isArray(value)) {
        if (!value.includes(rowValue)) return false;
      } else if (rowValue !== value) {
        return false;
      }
      continue;
    }
  }
  return true;
}

function makeFakeDb(seed: Record<string, Record<string, unknown>[]> = {}) {
  const tables: Record<string, Record<string, unknown>[]> = {
    runtime_workers: [],
    runtime_jobs: [],
    runtime_leases: [],
    runtime_dead_letters: [],
    runtime_lifecycle_events: [],
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
    ...seed,
  };
  let autoId = 9000;
  const fake: any = {};
  fake._tables = tables;

  function checkUnique(table: string, row: Record<string, unknown>): void {
    for (const keys of UNIQUE_CHECKS[table] ?? []) {
      for (const existing of tables[table]) {
        if (keys.every(k => existing[k] === row[k])) {
          const err: any = new Error(
            `Duplicate entry for key '${table}.${keys.join("_")}'`
          );
          err.code = "ER_DUP_ENTRY";
          throw err;
        }
      }
    }
  }

  function selectChain(table: string) {
    const state: {
      cond?: any;
      orderCols: { col: string; dir: "asc" | "desc" }[];
      limit?: number;
    } = { orderCols: [] };
    const c: any = {};
    c.from = () => c;
    c.where = (w: any) => {
      state.cond = w;
      return c;
    };
    c.orderBy = (...cols: any[]) => {
      state.orderCols = cols.map(col => {
        if (col && typeof col === "object" && Array.isArray(col.queryChunks)) {
          const named = col.queryChunks.find(
            (chunk: any) => chunk && typeof chunk.name === "string"
          );
          const text = flattenSql(col);
          return {
            col: named?.name ?? String(col),
            dir: /desc/i.test(text) ? ("desc" as const) : ("asc" as const),
          };
        }
        return { col: col?.name ?? String(col), dir: "asc" as const };
      });
      return c;
    };
    c.limit = (n: number) => {
      state.limit = n;
      return c;
    };
    c.then = (resolve: (rows: unknown[]) => unknown) => {
      let out = tables[table].slice();
      if (state.cond) out = out.filter(r => evalCond(state.cond, r));
      for (const { col, dir } of state.orderCols.reverse()) {
        out = out.sort((a, b) => {
          const av = (a as Record<string, unknown>)[col];
          const bv = (b as Record<string, unknown>)[col];
          const an = av instanceof Date ? av.getTime() : Number(av);
          const bn = bv instanceof Date ? bv.getTime() : Number(bv);
          if (Number.isFinite(an) && Number.isFinite(bn))
            return dir === "desc" ? bn - an : an - bn;
          const cmp = String(av ?? "").localeCompare(String(bv ?? ""));
          return dir === "desc" ? -cmp : cmp;
        });
      }
      if (state.limit != null) out = out.slice(0, state.limit);
      // Return copies — callers must never hold live row references (CAS
      // re-read validation depends on observing post-update state).
      return Promise.resolve(resolve(out.map(r => ({ ...r }))));
    };
    return c;
  }

  fake.select = (_fields?: unknown) => ({
    from: (t: unknown) => selectChain(getTableName(t as never)),
  });
  fake.insert = (t: unknown) => ({
    values: async (
      values: Record<string, unknown> | Record<string, unknown>[]
    ) => {
      const table = getTableName(t as never);
      const rows = Array.isArray(values) ? values : [values];
      const inserted: number[] = [];
      for (const row of rows) {
        checkUnique(table, row);
        const id = Number(row.id ?? ++autoId);
        tables[table].push({
          createdAt: new Date(NOW),
          updatedAt: new Date(NOW),
          ...row,
          id,
        });
        inserted.push(id);
      }
      return [
        { insertId: inserted[inserted.length - 1], affectedRows: rows.length },
      ];
    },
  });
  fake.update = (t: unknown) => {
    const table = getTableName(t as never);
    const chain: any = {};
    let cond: any = null;
    chain.set = (values: Record<string, unknown>) => {
      chain._set = values;
      return chain;
    };
    chain.where = (w: any) => {
      cond = w;
      return {
        then: (resolve: (rows: unknown[]) => unknown) => {
          let affected = 0;
          for (const row of tables[table]) {
            if (cond && !evalCond(cond, row)) continue;
            Object.assign(row, chain._set);
            affected++;
          }
          return Promise.resolve(resolve([{ affectedRows: affected }]));
        },
      };
    };
    return chain;
  };
  return fake;
}

// ─── Plant helpers ───

function plantMission(
  rows: FakeUpstreamRow[],
  overrides: Record<string, unknown> = {}
) {
  rows.push({
    table: "mission_proposals",
    row: {
      missionId: MISSION_ID,
      userId: USER1,
      businessId: BUSINESS1,
      status: "ELIGIBLE_FOR_PLANNING",
      validFrom: VALID_FROM,
      validUntil: VALID_UNTIL,
      ...overrides,
    },
  });
}

function plantPlan(
  rows: FakeUpstreamRow[],
  overrides: Record<string, unknown> = {}
) {
  rows.push({
    table: "mission_plans",
    row: {
      planId: PLAN_ID,
      planVersion: 1,
      userId: USER1,
      businessId: BUSINESS1,
      missionId: MISSION_ID,
      status: "READY_FOR_SCHEDULING",
      validFrom: VALID_FROM,
      validUntil: VALID_UNTIL,
      planFingerprint: H("e"),
      ...overrides,
    },
  });
}

function plantTask(
  rows: FakeUpstreamRow[],
  overrides: Record<string, unknown> = {}
) {
  rows.push({
    table: "mission_plan_tasks",
    row: {
      taskId: TASK_ALPHA,
      planId: PLAN_ID,
      planVersion: 1,
      userId: USER1,
      businessId: BUSINESS1,
      missionId: MISSION_ID,
      taskType: "PUBLISH_CONTENT",
      status: "READY_FOR_SCHEDULING",
      requiredCapabilities: ["social.publish"],
      constraints: [],
      taskFingerprint: H("f"),
      ...overrides,
    },
  });
}

function plantSchedule(
  rows: FakeUpstreamRow[],
  overrides: Record<string, unknown> = {}
) {
  rows.push({
    table: "mission_schedules",
    row: {
      scheduleId: SCHEDULE_ID,
      userId: USER1,
      businessId: BUSINESS1,
      missionId: MISSION_ID,
      planId: PLAN_ID,
      planFingerprint: H("e"),
      status: "READY",
      orderedTaskIds: [TASK_ALPHA],
      parallelGroups: [[]],
      blockingStates: [],
      dependencyRefs: [],
      constraints: [],
      governanceRequirements: {},
      riskClass: "LOW",
      requiresApproval: false,
      graphHash: H("1"),
      stateViewHash: H("2"),
      readinessHash: H("3"),
      approvalEvidenceHash: H("4"),
      capabilityEvidenceHash: H("5"),
      scheduleFingerprint: H("6"),
      validFrom: VALID_FROM,
      validUntil: VALID_UNTIL,
      producedAt: VALID_FROM,
      version: 1,
      ...overrides,
    },
  });
}

function plantSnapshot(
  rows: FakeUpstreamRow[],
  overrides: Record<string, unknown> = {}
) {
  rows.push({
    table: "mission_task_plan_snapshots",
    row: {
      id: 1,
      userId: USER1,
      businessId: BUSINESS1,
      missionId: MISSION_ID,
      planId: PLAN_ID,
      planDocument: {},
      supportedCapabilities: [
        "social.publish",
        "notification.send",
        "workflow.run",
        "campaign.activate",
        "content.dispatch",
        "crm.record",
        "analytics.record",
      ],
      taskIds: [TASK_ALPHA],
      planFingerprint: H("e"),
      planHash: H("7"),
      ...overrides,
    },
  });
}

function canonicalParamsFor(input: {
  taskId?: string;
  taskType?: string;
  actionType?: string;
  adapterType?: string;
  capability?: string;
  parameters?: unknown;
  scheduleId?: string;
}) {
  return deriveCanonicalActionParams({
    scheduleId: input.scheduleId ?? SCHEDULE_ID,
    taskId: input.taskId ?? TASK_ALPHA,
    taskType: input.taskType ?? "PUBLISH_CONTENT",
    actionType: input.actionType ?? "EXECUTE_TASK",
    adapterType: input.adapterType ?? "SOCIAL",
    capability: input.capability ?? "social.publish",
    parameters: input.parameters ?? PARAMS,
  });
}

function plantDecision(
  govRows: FakeGovernanceRow[],
  input: {
    decisionId?: string;
    userId?: number;
    businessId?: number;
    decision?: string;
    subjectClass?: string;
    actionType?: string;
    missionRef?: string;
    planRef?: string | null;
    taskRef?: string | null;
    actionParams?: unknown;
    policyVersion?: string | null;
    validUntil?: string | null;
    approvalBinding?: { approvalBindingHash: string; expiresAt: string } | null;
  }
) {
  const params = input.actionParams ?? canonicalParamsFor({});
  const fingerprint = deriveGovernanceActionParamsFingerprint(params);
  const decisionId = input.decisionId ?? `mgd1:${H("c")}`;
  govRows.push({
    table: "mission_governance_decisions",
    row: {
      governanceDecisionId: decisionId,
      contractVersion: "mission-governance/v1",
      engineVersion: "mission-governance-engine/v1",
      businessId: input.businessId ?? BUSINESS1,
      userId: input.userId ?? USER1,
      missionRef: input.missionRef ?? MISSION_ID,
      planRef: input.planRef === undefined ? PLAN_ID : input.planRef,
      taskRef: input.taskRef === undefined ? TASK_ALPHA : input.taskRef,
      subjectClass: input.subjectClass ?? "EXECUTION_STEP",
      actionType: input.actionType ?? "EXECUTE_TASK",
      actionParamsFingerprint: fingerprint,
      missionRiskClass: "MEDIUM",
      riskFactors: [],
      policyVersion:
        input.policyVersion === undefined
          ? POLICY_VERSION
          : input.policyVersion,
      decision: input.decision ?? "ALLOW",
      reasonCodes:
        input.decision === "BLOCK"
          ? ["MISSION_BLOCKED_BY_POLICY"]
          : ["MISSION_ALLOWED_BY_POLICY"],
      approvalRequired: (input.decision ?? "ALLOW") === "REVIEW_REQUIRED",
      approvalBinding:
        input.approvalBinding !== undefined
          ? input.approvalBinding
          : (input.decision ?? "ALLOW") === "REVIEW_REQUIRED"
            ? { approvalBindingHash: "", expiresAt: VALID_UNTIL }
            : null,
      evaluationFingerprint: H("9"),
      validUntil:
        input.validUntil === undefined ? VALID_UNTIL : input.validUntil,
      evaluatedAt: VALID_FROM,
      thresholds: {},
    },
  });
  return { decisionId, fingerprint };
}

function plantApproval(
  govRows: FakeGovernanceRow[],
  input: {
    decisionId: string;
    status: "pending" | "approved" | "rejected" | "edited";
    fingerprint: string;
    userId?: number;
    businessId?: number;
    expiresAt?: string;
    tamperHash?: boolean;
    subjectClass?: string;
    actionType?: string;
    taskRef?: string | null;
  }
) {
  const bindingHash = deriveGovernanceApprovalBindingHash({
    governanceDecisionId: input.decisionId,
    policyVersion: POLICY_VERSION,
    actionParamsFingerprint: input.fingerprint,
    missionRiskClass: "MEDIUM",
  });
  govRows.push({
    table: "approval_requests",
    row: {
      id: 9500 + govRows.filter(r => r.table === "approval_requests").length,
      userId: input.userId ?? USER1,
      status: input.status,
      approvalType: "mission_action",
      context: {
        missionGovernanceBinding: {
          contractVersion: "mission-governance/approval@v1",
          governanceDecisionId: input.decisionId,
          businessId: input.businessId ?? BUSINESS1,
          missionRef: MISSION_ID,
          planRef: PLAN_ID,
          taskRef: input.taskRef === undefined ? TASK_ALPHA : input.taskRef,
          subjectClass: input.subjectClass ?? "EXECUTION_STEP",
          actionType: input.actionType ?? "EXECUTE_TASK",
          actionParamsFingerprint: input.fingerprint,
          missionRiskClass: "MEDIUM",
          policyVersion: POLICY_VERSION,
          approvalBindingHash: input.tamperHash ? H("dead") : bindingHash,
          expiresAt: input.expiresAt ?? VALID_UNTIL,
        },
      },
    },
  });
}

// ─── Harness assembly ───

interface Harness {
  fakeDb: ReturnType<typeof makeFakeDb>;
  upstreamRows: FakeUpstreamRow[];
  govRows: FakeGovernanceRow[];
  harness: ReturnType<typeof createSandboxAdapterHarness>;
  deps: ExecutionCoordinationServiceDeps;
  audit: () => Record<string, unknown>[];
}

function makeHarness(
  options: {
    seed?: (rows: FakeUpstreamRow[], govRows: FakeGovernanceRow[]) => void;
  } = {}
): Harness {
  const upstreamRows: FakeUpstreamRow[] = [];
  const govRows: FakeGovernanceRow[] = [];
  options.seed?.(upstreamRows, govRows);
  const fakeDb = makeFakeDb();
  vi.mocked(getDb).mockReturnValue(fakeDb as never);
  const adapterHarness = createSandboxAdapterHarness();
  const deps: ExecutionCoordinationServiceDeps = {
    upstream: createInMemoryExecutionUpstreamAuthority(upstreamRows),
    governance: createInMemoryMissionGovernanceConsumptionAuthority(govRows),
    adapters: adapterHarness.registry,
    now: () => NOW,
  };
  return {
    fakeDb,
    upstreamRows,
    govRows,
    harness: adapterHarness,
    deps,
    audit: () =>
      (fakeDb._tables["audit_events"] as Record<string, unknown>[]) ?? [],
  };
}

function fullSeed(rows: FakeUpstreamRow[], govRows: FakeGovernanceRow[]) {
  plantMission(rows);
  plantPlan(rows);
  plantTask(rows);
  plantSchedule(rows);
  plantSnapshot(rows);
  const { decisionId } = plantDecision(govRows, {});
  return { decisionId };
}

const PARAMS = { caption: "hello world" };

function prepareInput(overrides: Record<string, unknown> = {}) {
  return {
    scheduleId: SCHEDULE_ID,
    taskId: TASK_ALPHA,
    actionType: "EXECUTE_TASK",
    parameters: PARAMS,
    governanceDecisionId: `mgd1:${H("c")}`,
    ...overrides,
  };
}

async function prepareHappy(
  h: Harness,
  overrides: Record<string, unknown> = {}
) {
  return prepareExecutionAction(
    h.fakeDb as never,
    h.deps,
    { userId: USER1 },
    prepareInput(overrides)
  );
}

// ─── D12.1–D12.13 — upstream + governance gate ───

export {
  makeHarness,
  fullSeed,
  prepareHappy,
  plantDecision,
  plantApproval,
  canonicalParamsFor,
  NOW,
  USER1,
  BUSINESS1,
  PARAMS,
};
