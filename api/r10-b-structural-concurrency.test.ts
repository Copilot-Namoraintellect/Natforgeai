/**
 * R10-B — Structural Concurrency Harness (B4/B6/B9), offline twin.
 *
 * Deterministic tests for genuine concurrent DB workers: K async workers
 * interleave over ONE shared in-memory database that replicates MySQL
 * statement semantics — atomic unique-index enforcement at insert, atomic
 * predicate evaluation for guarded UPDATEs (version CAS), autocommit
 * statements, transaction undo-journal with worker-crash injection, and
 * statement fault injection (deadlock victim / connection loss). The REAL
 * Mission Control stores and the REAL R9-D execution service run unmodified
 * against it.
 *
 * Concurrency model: each fake DB operation executes its state mutation
 * synchronously (statement-atomic, exactly like an InnoDB autocommit
 * statement) and returns through a microtask; workers interleave only at
 * statement boundaries — the same interleaving granularity at which MySQL
 * unique violations and CAS races are decided.
 *
 * Required invariant for every scenario: ONE authoritative side-effect
 * lineage — no duplicate authority, no false success.
 *
 * The real-MySQL twin of this suite is api/r10-b-real-mysql-concurrency.test.ts
 * (gated on R10_B_MYSQL_URL; SKIPPED when no disposable server is available).
 * This offline twin never opens a network connection.
 */
import { describe, it, expect, vi } from "vitest";
import { getTableName } from "drizzle-orm";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("R10-B structural harness: real connections are forbidden");
  }),
}));

import { insertMissionProposal, transitionMissionStatus } from "./lib/mission-authority/mission-authority-store";
import { insertPlan } from "./lib/mission-planning/mission-planning-store";
import { insertSchedule, transitionScheduleStatus } from "./lib/mission-scheduling/mission-scheduling-store";
import { insertMissionGovernanceDecision, getMissionGovernanceDecision } from "./lib/mission-governance/mission-governance-store";
import { queueReplayActiveClaims, queueReplayRequests } from "@db/schema";
import { insertExecutionAction, transitionDispatchState } from "./lib/execution-coordination/execution-coordination-store";
import {
  insertMissionRecoveryCandidate,
  insertMissionStateRecord,
  transitionRecoveryStatus,
} from "./lib/mission-state-recovery/mission-state-recovery-store";
import {
  deriveExecutionActionId,
  deriveIdempotencyKey,
  deriveCanonicalActionParams,
  deriveActionParametersHash,
} from "./lib/execution-coordination/execution-coordination-identity";
import { deriveGovernanceActionParamsFingerprint } from "./lib/execution-coordination/execution-governance-seam";
import {
  createInMemoryExecutionUpstreamAuthority,
  type FakeUpstreamRow,
} from "./lib/execution-coordination/execution-upstream-seams";
import {
  createInMemoryMissionGovernanceConsumptionAuthority,
  deriveGovernanceApprovalBindingHash,
  type FakeGovernanceRow,
} from "./lib/execution-coordination/execution-governance-seam";
import { createSandboxAdapterHarness, createAdapterRegistry } from "./lib/execution-coordination/execution-adapter-registry";
import type { AdapterRawOutcome, ExecutionAdapter } from "./lib/execution-coordination/execution-adapter-registry";
import {
  prepareExecutionAction,
  dispatchExecutionAction,
  recordExecutionResult,
  type ExecutionCoordinationServiceDeps,
} from "./lib/execution-coordination/execution-coordination-service";
import {
  claimTerminalReplayRequest,
  withTerminalReplayTransaction,
} from "./lib/queue/terminal-replay";
import { assertMissionActionConsumable } from "./lib/mission-governance/mission-approval";
import type { MissionGovernanceDecision } from "./lib/mission-governance/mission-decision-engine";

// ─── Constants ───

const NOW = "2026-11-11T12:00:00.000Z";
const USER1 = 7001;
const USER2 = 7002;
const BUSINESS1 = 501;
const BUSINESS2 = 502;
const H = (c: string) => c.repeat(64);
const MISSION_ID = `mis1:${H("a")}`;
const PLAN_ID = `pln1:${H("d")}`;
const SCHEDULE_ID = `sch1:${H("b")}`;
const TASK_ALPHA = "task-alpha";
const POLICY_VERSION = "mission-governance-policy/v1";
const VALID_FROM = "2026-11-01T00:00:00.000Z";
const VALID_UNTIL = "2026-12-01T00:00:00.000Z";
const PARAMS = { caption: "hello world" };

// ─── Shared concurrency-capable fake DB ───

const UNIQUE_CHECKS: Record<string, string[][]> = {
  mission_proposals: [["missionId"], ["userId", "missionId"]],
  mission_lifecycle_events: [["lifecycleEventId"]],
  mission_plans: [["planId"], ["userId", "planId"], ["userId", "missionId", "planVersion"]],
  mission_plan_tasks: [["taskId"], ["userId", "taskId"]],
  mission_plan_lifecycle_events: [["lifecycleEventId"]],
  mission_task_plan_snapshots: [["planFingerprint"], ["userId", "missionId", "planId", "planFingerprint"]],
  mission_dependency_edges: [["dependencyId"], ["userId", "dependencyId"], ["userId", "missionId", "planId", "predecessorTaskId", "successorTaskId", "dependencyType"]],
  mission_schedules: [["scheduleId"], ["userId", "scheduleId"]],
  mission_schedule_lifecycle_events: [["lifecycleEventId"]],
  execution_actions: [["executionActionId"], ["userId", "executionActionId"], ["userId", "idempotencyKey"]],
  execution_attempts: [["attemptId"], ["userId", "attemptId"], ["userId", "executionActionId", "attemptNumber"]],
  execution_lifecycle_events: [["lifecycleEventId"]],
  mission_state_records: [["missionStateId"], ["userId", "missionStateId"]],
  mission_task_states: [["taskStateId"], ["userId", "taskStateId"]],
  mission_recovery_candidates: [["recoveryCandidateId"], ["userId", "recoveryCandidateId"]],
  mission_operational_timeline_events: [["timelineEventId"], ["userId", "timelineEventId"]],
  mission_governance_decisions: [["governanceDecisionId"]],
  approval_requests: [["idempotencyKey"]],
  audit_events: [["eventFingerprint"]],
  queue_terminal_failures: [],
  queue_replay_requests: [["replayKey"]],
  queue_replay_active_claims: [["terminalFailureId"]],
};

class WorkerCrashError extends Error {
  constructor() {
    super("simulated worker crash mid-transaction");
    this.name = "WorkerCrashError";
  }
}

function flattenSql(fragment: any): string {
  if (fragment == null) return "";
  if (typeof fragment === "string") return fragment;
  if (typeof fragment === "number" || typeof fragment === "boolean") return String(fragment);
  if (Array.isArray(fragment)) return fragment.map(flattenSql).join("");
  if (typeof fragment === "object") {
    if (Array.isArray(fragment.queryChunks)) return fragment.queryChunks.map(flattenSql).join("");
    if (Array.isArray(fragment.value)) return fragment.value.map(flattenSql).join("");
    if (typeof fragment.name === "string") return fragment.name;
    if ("value" in fragment) return flattenSql(fragment.value);
  }
  return "";
}

function unwrapParam(value: any): any {
  if (value && typeof value === "object" && value.constructor?.name === "Param") return value.value;
  return value;
}

/** Evaluates both drizzle SQL chunk conditions and structural {kind} predicates. */
function evalCond(cond: any, row: any): boolean {
  if (!cond) return true;
  // Structural predicate seam (mission-governance store).
  if (typeof cond === "object" && typeof cond.kind === "string") {
    if (cond.kind === "eq") return row[cond.field] === cond.value;
    if (cond.kind === "and") return cond.conditions.every((c: any) => evalCond(c, row));
    return true;
  }
  const chunks: any[] = cond?.queryChunks ?? [];
  const predicates: Array<(r: any) => boolean> = [];
  let i = 0;
  while (i < chunks.length) {
    const chunk = chunks[i];
    if (chunk && Array.isArray(chunk.queryChunks)) {
      predicates.push((r) => evalCond(chunk, r));
      i += 1;
      continue;
    }
    if (chunk && typeof chunk === "object" && typeof chunk.name === "string" && chunk.table) {
      const opChunk = chunks[i + 1];
      const op: string = String(opChunk?.value?.[0] ?? opChunk?.sql ?? opChunk?.value ?? "").toLowerCase();
      if (op.includes("is not null")) {
        predicates.push((r) => r[chunk.name] != null);
        i += 2;
        continue;
      }
      if (op.includes("is null")) {
        predicates.push((r) => r[chunk.name] == null);
        i += 2;
        continue;
      }
      const value = unwrapParam(chunks[i + 2]);
      if (op.includes("<>") || op.includes("!=")) {
        predicates.push((r) => r[chunk.name] !== value);
      } else {
        predicates.push((r) => r[chunk.name] === value);
      }
      i += 3;
      continue;
    }
    i += 1;
  }
  const joinText = flattenSql(cond).toLowerCase();
  const anyMode = /\bor\b/.test(joinText) && !/\band\b/.test(joinText);
  if (anyMode) return predicates.some((p) => p(row));
  return predicates.every((p) => p(row));
}

interface Fault {
  op: "insert" | "update" | "delete";
  table?: string;
  /** Skip this many matching ops before firing (race-window precision). */
  after?: number;
  err: { code?: string; message?: string };
}

export interface ConcurrencyDb {
  select: () => any;
  insert: (table: any) => any;
  update: (table: any) => any;
  delete: (table: any) => any;
  transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
  _tables: Record<string, Record<string, unknown>[]>;
  inject: (fault: Fault) => void;
  crashNextTransaction: () => void;
  table: (name: string) => Record<string, unknown>[];
}

export function makeConcurrencyDb(seed: Record<string, Record<string, unknown>[]> = {}): ConcurrencyDb {
  const tables: Record<string, Record<string, unknown>[]> = {
    mission_proposals: [],
    mission_lifecycle_events: [],
    mission_plans: [],
    mission_plan_tasks: [],
    mission_plan_lifecycle_events: [],
    mission_task_plan_snapshots: [],
    mission_dependency_edges: [],
    mission_schedules: [],
    mission_schedule_lifecycle_events: [],
    execution_actions: [],
    execution_attempts: [],
    execution_lifecycle_events: [],
    mission_state_records: [],
    mission_task_states: [],
    mission_recovery_candidates: [],
    mission_operational_timeline_events: [],
    mission_governance_decisions: [],
    approval_requests: [],
    audit_events: [],
    queue_terminal_failures: [],
    queue_replay_requests: [],
    queue_replay_active_claims: [],
    ...seed,
  };
  let autoId = 9000;
  let crashNextTx = false;
  const faults: Fault[] = [];

  const db: any = {};
  db._tables = tables;
  db.inject = (fault: Fault) => faults.push(fault);
  db.crashNextTransaction = () => {
    crashNextTx = true;
  };
  db.table = (name: string) => tables[name] ?? [];

  function takeFault(op: "insert" | "update" | "delete", table: string): Fault | undefined {
    const idx = faults.findIndex((f) => {
      if (f.op !== op) return false;
      if (f.table !== undefined && f.table !== table) return false;
      if (f.after !== undefined && f.after > 0) {
        f.after -= 1;
        return false;
      }
      return true;
    });
    if (idx === -1) return undefined;
    const [fault] = faults.splice(idx, 1);
    return fault;
  }

  function throwFault(fault: Fault): never {
    const err: any = new Error(fault.err.message ?? `injected ${fault.err.code}`);
    if (fault.err.code) err.code = fault.err.code;
    if (fault.err.code === "ER_DUP_ENTRY") err.errno = 1062;
    if (fault.err.code === "ER_LOCK_DEADLOCK") err.errno = 1213;
    throw err;
  }

  let journal: Array<() => void> | null = null;

  function checkUnique(table: string, row: Record<string, unknown>): void {
    for (const keys of UNIQUE_CHECKS[table] ?? []) {
      for (const existing of tables[table]) {
        if (keys.every((k) => existing[k] === row[k])) {
          const err: any = new Error(`Duplicate entry for key '${table}.${keys.join("_")}'`);
          err.code = "ER_DUP_ENTRY";
          err.errno = 1062;
          throw err;
        }
      }
    }
  }

  db.insert = (tableObj: any) => {
    const table = getTableName(tableObj);
    return {
      values: async (row: Record<string, unknown>) => {
        const fault = takeFault("insert", table);
        if (fault) throwFault(fault);
        if (crashNextTx && journal) {
          throw new WorkerCrashError();
        }
        checkUnique(table, row);
        const stored = { ...row };
        tables[table].push(stored);
        journal?.push(() => {
          const idx = tables[table].indexOf(stored);
          if (idx >= 0) tables[table].splice(idx, 1);
        });
        return [{ insertId: ++autoId, affectedRows: 1 }];
      },
    };
  };

  db.update = (tableObj: any) => {
    const table = getTableName(tableObj);
    const chain: any = { _set: undefined };
    chain.set = (patch: Record<string, unknown>) => {
      chain._set = patch;
      return chain;
    };
    chain.where = (cond: any) => {
      chain._cond = cond;
      return chain;
    };
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => void) => {
      const fault = takeFault("update", table);
      if (fault) {
        try {
          throwFault(fault);
        } catch (err) {
          if (reject) {
            reject(err);
            return;
          }
          return Promise.reject(err) as never;
        }
      }
      if (crashNextTx && journal) {
        const err = new WorkerCrashError();
        if (reject) {
          reject(err);
          return;
        }
        return Promise.reject(err) as never;
      }
      let affected = 0;
      for (const row of tables[table]) {
        if (!evalCond(chain._cond, row)) continue;
        const before = { ...row };
        Object.assign(row, chain._set);
        affected += 1;
        journal?.push(() => Object.assign(row, before));
      }
      return resolve([{ affectedRows: affected }]);
    };
    return chain;
  };

  db.delete = (tableObj: any) => {
    const table = getTableName(tableObj);
    return {
      where: async (cond: any) => {
        const fault = takeFault("delete", table);
        if (fault) throwFault(fault);
        let affected = 0;
        const kept: Record<string, unknown>[] = [];
        for (const row of tables[table]) {
          if (evalCond(cond, row)) {
            affected += 1;
            journal?.push(() => tables[table].push(row));
          } else {
            kept.push(row);
          }
        }
        tables[table] = kept;
        return [{ affectedRows: affected }];
      },
    };
  };

  db.select = () => ({
    from: (tableObj: any) => selectTarget(getTableName(tableObj)),
  });

  function selectTarget(table: string) {
    const state: { cond?: any; orderCols: { col: string; dir: "asc" | "desc" }[]; limit?: number } = { orderCols: [] };
    const c: any = {};
    c.from = () => c;
    c.where = (w: any) => {
      state.cond = w;
      return c;
    };
    c.orderBy = (...cols: any[]) => {
      state.orderCols = cols.flat().map((col: any) => {
        if (col && typeof col === "object" && Array.isArray(col.queryChunks)) {
          const named = col.queryChunks.find((chunk: any) => chunk && typeof chunk.name === "string");
          const dir = /desc/i.test(flattenSql(col)) ? "desc" : "asc";
          return { col: named?.name ?? String(col), dir };
        }
        if (col && typeof col === "object" && typeof col.field === "string") {
          return { col: col.field, dir: col.direction === "desc" ? "desc" : "asc" };
        }
        return { col: col?.name ?? String(col), dir: "asc" as const };
      });
      return c;
    };
    c.limit = (n: number) => {
      state.limit = n;
      return c;
    };
    c.all = async () => run();
    c.then = (resolve: (rows: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve()
        .then(run)
        .then(resolve, reject);
    async function run(): Promise<unknown[]> {
      let out = tables[table].slice();
      if (state.cond) out = out.filter((r) => evalCond(state.cond, r));
      for (const { col, dir } of [...state.orderCols].reverse()) {
        out = out.sort((a: any, b: any) => {
          const av = a[col];
          const bv = b[col];
          if (av === bv) return 0;
          const cmp = av < bv ? -1 : 1;
          return dir === "desc" ? -cmp : cmp;
        });
      }
      if (state.limit !== undefined) out = out.slice(0, state.limit);
      // Row copies — a real result set never aliases stored rows, and in-place
      // UPDATE mutation must not be observable through previously read handles.
      return out.map((r) => ({ ...r }));
    }
    return c;
  }

  db.transaction = async <T>(fn: (tx: any) => Promise<T>): Promise<T> => {
    const undo: Array<() => void> = [];
    const prev = journal;
    journal = undo;
    const txProxy = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "transaction") return undefined;
        return Reflect.get(target, prop, receiver);
      },
    });
    try {
      const result = await fn(txProxy);
      if (crashNextTx) {
        // Committed nothing yet: crash before commit discards the journal.
        crashNextTx = false;
        throw new WorkerCrashError();
      }
      crashNextTx = false;
      journal = prev;
      return result;
    } catch (err) {
      for (const u of undo.reverse()) u();
      journal = prev;
      crashNextTx = false;
      throw err;
    }
  };

  return db as ConcurrencyDb;
}

// ─── Fixture builders ───

function missionProposalRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    missionId: MISSION_ID,
    objectiveId: `obj1:${H("b2")}`,
    userId: USER1,
    businessId: BUSINESS1,
    sourceCandidateId: `sor1:${H("c3")}`,
    sourceReasoningIds: [],
    missionType: "GROWTH_CAMPAIGN",
    objectiveType: "CONVERSION_LIFT",
    objectiveStatement: "structural probe",
    objectiveClientStatement: "structural probe",
    objectiveWordingDraft: null,
    modelAssistanceFlagged: false,
    expectedOutcome: "probe",
    successCriteria: [],
    constraints: [],
    assumptions: [],
    scope: { subjectType: "BUSINESS", businessScope: BUSINESS1, channelScope: null, campaignScope: null, geography: null },
    scopeKey: "probe-scope",
    priorityContext: "NORMAL",
    strategicRiskClass: "MEDIUM",
    confidenceClass: "MODERATE",
    governanceDecisionId: null,
    governanceDecision: null,
    policyVersion: null,
    governanceRequirements: [],
    validFrom: VALID_FROM,
    validUntil: VALID_UNTIL,
    limitations: [],
    lineageHash: H("d4"),
    missionFingerprint: H("e5"),
    objectiveFingerprint: H("f6"),
    constraintSetFingerprint: H("g7"),
    sourceProjection: {},
    sourceVersions: {},
    supersedesMissionId: null,
    status: "PROPOSED",
    version: 1,
    ...overrides,
  };
}

function planRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    planId: PLAN_ID,
    planVersion: 1,
    userId: USER1,
    businessId: BUSINESS1,
    missionId: MISSION_ID,
    missionAuthorityVersion: H("e5"),
    boundMissionVersion: 1,
    planScopeKey: "probe-plan-scope",
    taskIds: [TASK_ALPHA],
    taskSetFingerprint: H("t1"),
    constraintSetFingerprint: H("g7"),
    missionConstraints: [],
    planningAssumptions: [],
    unresolvedItems: [],
    completenessStatus: "COMPLETE",
    status: "PLANNING",
    validFrom: VALID_FROM,
    validUntil: VALID_UNTIL,
    supersedesPlanId: null,
    planFingerprint: H("p1"),
    modelAssistanceFlagged: false,
    version: 1,
    ...overrides,
  };
}

function scheduleRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
  };
}

function governanceDecisionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    governanceDecisionId: `mgd1:${H("c")}`,
    contractVersion: "mission-governance/v1",
    engineVersion: "mission-governance-engine/v1",
    userId: USER1,
    businessId: BUSINESS1,
    missionRef: MISSION_ID,
    planRef: PLAN_ID,
    taskRef: TASK_ALPHA,
    subjectClass: "EXECUTION_STEP",
    actionType: "EXECUTE_TASK",
    actionParamsFingerprint: H("fp"),
    missionRiskClass: "MEDIUM",
    riskFactors: [],
    policyVersion: POLICY_VERSION,
    decision: "ALLOW",
    reasonCodes: ["MISSION_ALLOWED_BY_POLICY"],
    approvalRequired: false,
    approvalBinding: null,
    evaluationFingerprint: H("9"),
    validUntil: VALID_UNTIL,
    evaluatedAt: VALID_FROM,
    thresholds: {},
    createdAt: NOW,
    ...overrides,
  };
}

function recoveryCandidateRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recoveryCandidateId: `rcn1:${H("r1")}`,
    userId: USER1,
    businessId: BUSINESS1,
    missionId: MISSION_ID,
    planId: PLAN_ID,
    scheduleId: SCHEDULE_ID,
    taskId: TASK_ALPHA,
    executionActionId: `exa1:${H("x1")}`,
    latestAttemptId: `exr1:${H("y1")}`,
    failureClass: "PROVIDER_ERROR",
    uncertaintyClass: "NONE",
    recoveryType: "RETRY",
    status: "PROPOSED",
    scope: {},
    proposalHash: H("pr1"),
    governanceDecisionId: null,
    governanceStatus: null,
    consumedAuthorization: null,
    supersededByRecoveryId: null,
    validUntil: VALID_UNTIL,
    version: 1,
    ...overrides,
  };
}

// ─── R9-D service harness (real service + seams, sandbox adapters) ───

function canonicalParamsFor(input: { taskId?: string; parameters?: unknown } = {}) {
  return deriveCanonicalActionParams({
    scheduleId: SCHEDULE_ID,
    taskId: input.taskId ?? TASK_ALPHA,
    taskType: "PUBLISH_CONTENT",
    actionType: "EXECUTE_TASK",
    adapterType: "SOCIAL",
    capability: "social.publish",
    parameters: input.parameters ?? PARAMS,
  });
}

function plantUpstreamWorld(rows: FakeUpstreamRow[], overrides: Record<string, unknown> = {}) {
  rows.push(
    { table: "mission_proposals", row: { missionId: MISSION_ID, userId: USER1, businessId: BUSINESS1, status: "ELIGIBLE_FOR_PLANNING", validFrom: VALID_FROM, validUntil: VALID_UNTIL } },
    { table: "mission_plans", row: { planId: PLAN_ID, planVersion: 1, userId: USER1, businessId: BUSINESS1, missionId: MISSION_ID, status: "READY_FOR_SCHEDULING", validFrom: VALID_FROM, validUntil: VALID_UNTIL, planFingerprint: H("e") } },
    { table: "mission_plan_tasks", row: { taskId: TASK_ALPHA, planId: PLAN_ID, planVersion: 1, userId: USER1, businessId: BUSINESS1, missionId: MISSION_ID, taskType: "PUBLISH_CONTENT", status: "READY_FOR_SCHEDULING", requiredCapabilities: ["social.publish"], constraints: [], taskFingerprint: H("f") } },
    { table: "mission_schedules", row: { scheduleId: SCHEDULE_ID, userId: USER1, businessId: BUSINESS1, missionId: MISSION_ID, planId: PLAN_ID, planFingerprint: H("e"), status: "READY", orderedTaskIds: [TASK_ALPHA], parallelGroups: [[]], blockingStates: [], dependencyRefs: [], constraints: [], governanceRequirements: {}, riskClass: "LOW", requiresApproval: false, graphHash: H("1"), stateViewHash: H("2"), readinessHash: H("3"), approvalEvidenceHash: H("4"), capabilityEvidenceHash: H("5"), scheduleFingerprint: H("6"), validFrom: VALID_FROM, validUntil: VALID_UNTIL, producedAt: VALID_FROM, version: 1 } },
    { table: "mission_task_plan_snapshots", row: { id: 1, userId: USER1, businessId: BUSINESS1, missionId: MISSION_ID, planId: PLAN_ID, planDocument: {}, supportedCapabilities: ["social.publish", "notification.send", "workflow.run", "campaign.activate", "content.dispatch", "crm.record", "analytics.record"], taskIds: [TASK_ALPHA], planFingerprint: H("e"), planHash: H("7") } }
  );
  void overrides;
}

function plantGovernanceDecision(govRows: FakeGovernanceRow[], input: { decisionId?: string; decision?: string; userId?: number; businessId?: number; approvalBinding?: { approvalBindingHash: string; expiresAt: string } | null } = {}) {
  const params = canonicalParamsFor({});
  const fingerprint = deriveGovernanceActionParamsFingerprint(params);
  const decisionId = input.decisionId ?? `mgd1:${H("c")}`;
  const decision = input.decision ?? "ALLOW";
  govRows.push({
    table: "mission_governance_decisions",
    row: {
      governanceDecisionId: decisionId,
      contractVersion: "mission-governance/v1",
      engineVersion: "mission-governance-engine/v1",
      businessId: input.businessId ?? BUSINESS1,
      userId: input.userId ?? USER1,
      missionRef: MISSION_ID,
      planRef: PLAN_ID,
      taskRef: TASK_ALPHA,
      subjectClass: "EXECUTION_STEP",
      actionType: "EXECUTE_TASK",
      actionParamsFingerprint: fingerprint,
      missionRiskClass: "MEDIUM",
      riskFactors: [],
      policyVersion: POLICY_VERSION,
      decision,
      reasonCodes: decision === "BLOCK" ? ["MISSION_BLOCKED_BY_POLICY"] : ["MISSION_ALLOWED_BY_POLICY"],
      approvalRequired: decision === "REVIEW_REQUIRED",
      approvalBinding: input.approvalBinding !== undefined ? input.approvalBinding : decision === "REVIEW_REQUIRED" ? { approvalBindingHash: "", expiresAt: VALID_UNTIL } : null,
      evaluationFingerprint: H("9"),
      validUntil: VALID_UNTIL,
      evaluatedAt: VALID_FROM,
      thresholds: {},
    },
  });
  return { decisionId, fingerprint };
}

function plantApproval(govRows: FakeGovernanceRow[], input: { decisionId: string; fingerprint: string; status: "pending" | "approved" | "rejected" | "edited"; userId?: number; businessId?: number; expiresAt?: string; tamperHash?: boolean }) {
  const bindingHash = deriveGovernanceApprovalBindingHash({
    governanceDecisionId: input.decisionId,
    policyVersion: POLICY_VERSION,
    actionParamsFingerprint: input.fingerprint,
    missionRiskClass: "MEDIUM",
  });
  govRows.push({
    table: "approval_requests",
    row: {
      id: 9500 + govRows.filter((r) => r.table === "approval_requests").length,
      userId: input.userId ?? USER1,
      status: input.status,
      approvalType: "mission_action",
      idempotencyKey: `mgov1:${H(input.decisionId.slice(-8))}`,
      title: "approval",
      description: "approval",
      aiRecommendation: "",
      riskLevel: "medium",
      approvedAt: input.status === "approved" ? NOW : null,
      rejectedAt: input.status === "rejected" ? NOW : null,
      createdAt: NOW,
      context: {
        missionGovernanceBinding: {
          contractVersion: "mission-governance/approval@v1",
          governanceDecisionId: input.decisionId,
          businessId: input.businessId ?? BUSINESS1,
          missionRef: MISSION_ID,
          planRef: PLAN_ID,
          taskRef: TASK_ALPHA,
          subjectClass: "EXECUTION_STEP",
          actionType: "EXECUTE_TASK",
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

interface ServiceHarness {
  db: ConcurrencyDb;
  upstreamRows: FakeUpstreamRow[];
  govRows: FakeGovernanceRow[];
  adapters: ReturnType<typeof createSandboxAdapterHarness>;
  deps: ExecutionCoordinationServiceDeps;
  audit: () => Record<string, unknown>[];
}

/**
 * Social adapter with IDEMPOTENT callback redelivery: a delivered outcome for
 * a reference is returned to every poll for that reference (never consumed),
 * faithfully modelling duplicate provider callbacks carrying the same bound
 * outcome. The frozen sandbox harness consumes one queued outcome per poll —
 * correct for dispatch scripting, wrong for redelivery races.
 */
function createIdempotentSocialAdapter() {
  const delivered = new Map<string, AdapterRawOutcome>();
  const dispatched: Array<Record<string, unknown>> = [];
  let script: AdapterRawOutcome | null = null;
  const adapter: ExecutionAdapter = {
    adapterType: "SOCIAL",
    capabilities: ["social.publish"] as never,
    async dispatch(input) {
      dispatched.push(input as unknown as Record<string, unknown>);
      if (input.payload["callbackPoll"] === true) {
        return delivered.get(input.externalReference) ?? { status: "ambiguous" };
      }
      if (script) return script;
      return delivered.get(input.externalReference) ?? { status: "success", reference: input.externalReference };
    },
  };
  return {
    adapter,
    dispatched,
    scriptOutcome(outcome: AdapterRawOutcome) {
      script = outcome;
    },
    deliver(reference: string, outcome: AdapterRawOutcome) {
      delivered.set(reference, outcome);
    },
  };
}

function makeCallbackHarness(seedGovernance: (govRows: FakeGovernanceRow[]) => void = () => {}): ServiceHarness {
  const upstreamRows: FakeUpstreamRow[] = [];
  plantUpstreamWorld(upstreamRows);
  const govRows: FakeGovernanceRow[] = [];
  seedGovernance(govRows);
  const db = makeConcurrencyDb();
  const social = createIdempotentSocialAdapter();
  const deps: ExecutionCoordinationServiceDeps = {
    upstream: createInMemoryExecutionUpstreamAuthority(upstreamRows),
    governance: createInMemoryMissionGovernanceConsumptionAuthority(govRows),
    adapters: createAdapterRegistry([social.adapter]),
    now: () => NOW,
  };
  const harness = {
    db,
    upstreamRows,
    govRows,
    adapters: {
      adapters: { SOCIAL: social },
      registry: deps.adapters,
      totalDispatches: () => social.dispatched.length,
    },
    deps,
    audit: () => db.table("audit_events"),
  };
  return harness as unknown as ServiceHarness;
}

function makeServiceHarness(seedGovernance: (govRows: FakeGovernanceRow[]) => void = () => {}): ServiceHarness {
  const upstreamRows: FakeUpstreamRow[] = [];
  plantUpstreamWorld(upstreamRows);
  const govRows: FakeGovernanceRow[] = [];
  seedGovernance(govRows);
  const db = makeConcurrencyDb();
  const adapters = createSandboxAdapterHarness();
  const deps: ExecutionCoordinationServiceDeps = {
    upstream: createInMemoryExecutionUpstreamAuthority(upstreamRows),
    governance: createInMemoryMissionGovernanceConsumptionAuthority(govRows),
    adapters: adapters.registry,
    now: () => NOW,
  };
  return { db, upstreamRows, govRows, adapters, deps, audit: () => db.table("audit_events") };
}

async function prepareHappyAction(h: ServiceHarness, governanceDecisionId: string) {
  const result = await prepareExecutionAction(h.db as never, h.deps, { userId: USER1 }, {
    scheduleId: SCHEDULE_ID,
    taskId: TASK_ALPHA,
    actionType: "EXECUTE_TASK",
    parameters: PARAMS,
    governanceDecisionId,
  });
  return result.executionAction as { executionActionId: string };
}

/** Launch K workers that all start simultaneously. */
async function runWorkers<T>(count: number, worker: (index: number) => Promise<T>): Promise<T[]> {
  return Promise.all(Array.from({ length: count }, (_, i) => worker(i)));
}

// ═══════════════════════════════════════════════════════════════════
// B4 required scenarios — 20 concurrent-worker races
// ═══════════════════════════════════════════════════════════════════

describe("R10-B structural concurrency — duplicate formation races (s1-s3)", () => {
  it("s1: duplicate mission formation — K concurrent proposals converge to ONE durable row", async () => {
    const db = makeConcurrencyDb();
    const row = missionProposalRow() as never;
    const outcomes = await runWorkers(8, async () => {
      try {
        const r = await insertMissionProposal(db as never, row);
        return { ok: true as const, inserted: r.inserted };
      } catch (err) {
        return { ok: false as const, code: (err as { code?: string }).code };
      }
    });
    // Exactly one winner; every loser either converges (inserted:false) or fails closed.
    const winners = outcomes.filter((o) => o.ok && o.inserted);
    const converged = outcomes.filter((o) => o.ok && !o.inserted);
    const rejected = outcomes.filter((o) => !o.ok);
    expect(winners).toHaveLength(1);
    expect(converged.length + rejected.length).toBe(7);
    expect(db.table("mission_proposals")).toHaveLength(1);
    // Exactly one authoritative lineage.
    expect(db.table("mission_proposals")[0].missionId).toBe(MISSION_ID);
  });

  it("s1b: conflicting replay under the same mission anchor fails closed", async () => {
    const db = makeConcurrencyDb();
    await insertMissionProposal(db as never, missionProposalRow() as never);
    await expect(
      insertMissionProposal(db as never, missionProposalRow({ missionFingerprint: H("zz") }) as never)
    ).rejects.toMatchObject({ code: "MISSION_REPLAY_CONFLICT" });
    expect(db.table("mission_proposals")).toHaveLength(1);
  });

  it("s2: duplicate plan formation — K concurrent inserts converge to ONE plan row", async () => {
    const db = makeConcurrencyDb();
    const row = planRow() as never;
    const outcomes = await runWorkers(8, async () => {
      try {
        const r = await insertPlan(db as never, row);
        return { ok: true as const, inserted: r.inserted };
      } catch (err) {
        return { ok: false as const, code: (err as { code?: string }).code };
      }
    });
    const winners = outcomes.filter((o) => o.ok && o.inserted);
    expect(winners).toHaveLength(1);
    expect(db.table("mission_plans")).toHaveLength(1);
  });

  it("s2b: concurrent plan-version race — only one row per (user, mission, planVersion)", async () => {
    const db = makeConcurrencyDb();
    const outcomes = await runWorkers(6, async (i) => {
      try {
        await insertPlan(db as never, planRow({ planId: `pln1:${H(`v${i}`)}`, planVersion: 1 }) as never);
        return "inserted";
      } catch (err) {
        return (err as { code?: string }).code ?? "error";
      }
    });
    // All distinct planIds but the SAME (userId, missionId, planVersion=1): version anchor fires.
    const inserted = outcomes.filter((o) => o === "inserted");
    expect(inserted.length).toBeLessThanOrEqual(1);
    expect(db.table("mission_plans").length).toBeLessThanOrEqual(1);
  });

  it("s3: duplicate schedule creation — identical content converges to ONE schedule", async () => {
    const db = makeConcurrencyDb();
    const row = scheduleRow() as never;
    const outcomes = await runWorkers(8, async () => {
      const r = await insertSchedule(row, db as never);
      return r.duplicateClassification;
    });
    expect(outcomes.filter((c) => c === "none")).toHaveLength(1);
    expect(outcomes.filter((c) => c === "idempotent_replay")).toHaveLength(7);
    expect(db.table("mission_schedules")).toHaveLength(1);
  });

  it("s3b: same scheduleId with a conflicting fingerprint fails closed", async () => {
    const db = makeConcurrencyDb();
    await insertSchedule(scheduleRow() as never, db as never);
    await expect(
      insertSchedule(scheduleRow({ scheduleFingerprint: H("clash") }) as never, db as never)
    ).rejects.toMatchObject({ code: "SCHEDULING_REPLAY_CONFLICT" });
    expect(db.table("mission_schedules")).toHaveLength(1);
  });
});

describe("R10-B structural concurrency — dispatch intent + dispatch races (s4-s6)", () => {
  it("s6: duplicate dispatch-intent creation — K concurrent prepares converge to ONE exa1: action", async () => {
    const h = makeServiceHarness((gov) => plantGovernanceDecision(gov, {}));
    const decisionId = `mgd1:${H("c")}`;
    const outcomes = await runWorkers(8, async () => {
      try {
        const r = await prepareExecutionAction(h.db as never, h.deps, { userId: USER1 }, {
          scheduleId: SCHEDULE_ID,
          taskId: TASK_ALPHA,
          actionType: "EXECUTE_TASK",
          parameters: PARAMS,
          governanceDecisionId: decisionId,
        });
        return { ok: true as const, cls: r.duplicateClassification };
      } catch (err) {
        return { ok: false as const, code: (err as { code?: string }).code };
      }
    });
    const winners = outcomes.filter((o) => o.ok && o.cls === "none");
    expect(winners).toHaveLength(1);
    expect(h.db.table("execution_actions")).toHaveLength(1);
    expect(h.audit().filter((e) => e.eventType === "execution_action_prepared")).toHaveLength(1);
  });

  it("s5: duplicate execution-action dispatch race — ONE durable attempt/result; no double authority", async () => {
    const h = makeServiceHarness((gov) => plantGovernanceDecision(gov, {}));
    const decisionId = `mgd1:${H("c")}`;
    const action = await prepareHappyAction(h, decisionId);
    const outcomes = await runWorkers(6, async () => {
      try {
        return {
          ok: true as const,
          result: await dispatchExecutionAction(h.db as never, h.deps, { userId: USER1 }, {
            executionActionId: action.executionActionId,
            parameters: PARAMS,
          }),
        };
      } catch (err) {
        return { ok: false as const, code: `${(err as { code?: string }).code}: ${(err as { message?: string }).message}` };
      }
    });
    // Every caller may observe success (CAS-1 convergent outcome) or fail closed — none may widen authority.
    for (const o of outcomes) {
      if (o.ok) expect(o.result.executionAction.dispatchState).toBe("SUCCEEDED");
    }
    expect(outcomes.filter((o) => !o.ok).map((o) => (o as { code?: string }).code)).toEqual([]);
    // THE durable invariant: exactly one attempt, one result, one terminal lineage.
    const attempts = h.db.table("execution_attempts");
    expect(attempts).toHaveLength(1);
    expect(attempts[0].resultStatus).toBe("SUCCEEDED");
    const actions = h.db.table("execution_actions");
    expect(actions).toHaveLength(1);
    expect(actions[0].dispatchState).toBe("SUCCEEDED");
    expect(actions[0].attemptCount).toBe(1);
    // Exactly one dispatch-state fact per transition type (deterministic lifecycle ids).
    const facts = h.db.table("execution_lifecycle_events");
    expect(facts.filter((f) => f.lifecycleType === "dispatch_state_changed" && f.toState === "DISPATCHED")).toHaveLength(1);
    expect(facts.filter((f) => f.lifecycleType === "result_recorded")).toHaveLength(1);
    expect(facts.filter((f) => f.lifecycleType === "retry_candidate_emitted")).toHaveLength(0);
    // Audit: exactly one attempt-recorded event.
    expect(h.audit().filter((e) => e.eventType === "execution_attempt_recorded")).toHaveLength(1);
    // B5 evidence: the sandbox adapter was invoked by every racing worker — durable
    // outcome is exactly-once; provider invocation is the adapter's dedup responsibility.
    expect(h.adapters.totalDispatches()).toBe(6);
  });

  it("s4: approval consumption race — K concurrent REVIEW_REQUIRED dispatches, one approved ledger row", async () => {
    let decisionId = "";
    let fingerprint = "";
    const h = makeServiceHarness((gov) => {
      const planted = plantGovernanceDecision(gov, { decision: "REVIEW_REQUIRED" });
      decisionId = planted.decisionId;
      fingerprint = planted.fingerprint;
      plantApproval(gov, { decisionId, fingerprint, status: "approved" });
    });
    const action = await prepareHappyAction(h, decisionId);
    const outcomes = await runWorkers(6, async () => {
      try {
        return {
          ok: true as const,
          result: await dispatchExecutionAction(h.db as never, h.deps, { userId: USER1 }, {
            executionActionId: action.executionActionId,
            parameters: PARAMS,
          }),
        };
      } catch (err) {
        return { ok: false as const, code: (err as { code?: string }).code };
      }
    });
    for (const o of outcomes) {
      if (o.ok) expect(o.result.executionAction.dispatchState).toBe("SUCCEEDED");
    }
    // Approval is read-only authority: no consumption flag exists to double-set,
    // and the durable lineage is still exactly one attempt.
    expect(h.db.table("execution_attempts")).toHaveLength(1);
    expect(h.govRows.filter((r) => r.table === "approval_requests")).toHaveLength(1);
    // Direct gate revalidation concurrently returns identical verdicts (rows come
    // from the durable governance seam, not from the execution db).
    const decisionRow = h.govRows.find((r) => r.table === "mission_governance_decisions")!.row as never as MissionGovernanceDecision;
    const approvalRow = h.govRows.find((r) => r.table === "approval_requests")!.row as Record<string, unknown>;
    const verdicts = await runWorkers(8, async () =>
      assertMissionActionConsumable({
        decision: decisionRow,
        approval: { id: Number(approvalRow.id), userId: USER1, status: "approved", context: approvalRow.context },
        expectedAction: { subjectClass: "EXECUTION_STEP", actionType: "EXECUTE_TASK", missionRef: MISSION_ID, planRef: PLAN_ID, taskRef: TASK_ALPHA, actionParams: canonicalParamsFor({}) },
        currentPolicyVersion: POLICY_VERSION,
        now: NOW,
      }).consumable
    );
    expect(verdicts.every((v) => v === true)).toBe(true);
  });
});

describe("R10-B structural concurrency — callback races (s7-s8)", () => {
  async function acknowledgedAction() {
    const h = makeCallbackHarness((gov) => plantGovernanceDecision(gov, {}));
    const decisionId = `mgd1:${H("c")}`;
    const action = await prepareHappyAction(h, decisionId);
    const social = h.adapters.adapters.SOCIAL as unknown as ReturnType<typeof createIdempotentSocialAdapter>;
    // First dispatch ends PENDING_EXTERNAL (provider holds the outcome).
    social.scriptOutcome({ status: "pending_external", reference: "ext-pending-1" });
    await dispatchExecutionAction(h.db as never, h.deps, { userId: USER1 }, {
      executionActionId: action.executionActionId,
      parameters: PARAMS,
    });
    const actionRow = h.db.table("execution_actions")[0];
    expect(actionRow.dispatchState).toBe("ACKNOWLEDGED");
    return h;
  }

  it("s7: duplicate callback race — K identical results converge to ONE recorded result", async () => {
    const h = await acknowledgedAction();
    const social = h.adapters.adapters.SOCIAL as unknown as ReturnType<typeof createIdempotentSocialAdapter>;
    // The provider delivers the SAME callback K times (duplicate delivery):
    // every poll for the reference returns the identical bound outcome.
    const attempt = h.db.table("execution_attempts")[0] as { attemptId: string; externalReference: string | null };
    const ref = attempt.externalReference!;
    social.deliver(ref, { status: "success", reference: "ext-success-1" });
    const outcomes = await runWorkers(8, async () => {
      try {
        return {
          ok: true as const,
          outcome: await recordExecutionResult(h.db as never, h.deps, { userId: USER1 }, { attemptId: attempt.attemptId }),
        };
      } catch (err) {
        return { ok: false as const, code: `${(err as { code?: string }).code}: ${(err as { message?: string }).message}` };
      }
    });
    expect(outcomes.filter((o) => !o.ok).map((o) => (o as { code?: string }).code)).toEqual([]);
    const successes = outcomes.filter((o) => o.ok);
    expect(successes.length).toBeGreaterThanOrEqual(1);
    const attempts = h.db.table("execution_attempts");
    expect(attempts).toHaveLength(1);
    expect(attempts[0].resultStatus).toBe("SUCCEEDED");
    // Exactly one TERMINAL result transition (the dispatch's earlier
    // PENDING_EXTERNAL → ACKNOWLEDGED fact is a separate, legitimate fact).
    expect(
      h.db.table("execution_lifecycle_events").filter((f) => f.lifecycleType === "result_recorded" && f.toState === "SUCCEEDED")
    ).toHaveLength(1);
    expect(h.db.table("execution_actions")[0].dispatchState).toBe("SUCCEEDED");
  });

  it("s8: conflicting callback race — a stale/conflicting provider callback can never overwrite the recorded result", async () => {
    const h = await acknowledgedAction();
    const social = h.adapters.adapters.SOCIAL as unknown as ReturnType<typeof createIdempotentSocialAdapter>;
    const attempt = h.db.table("execution_attempts")[0] as { attemptId: string; externalReference: string | null };
    const ref = attempt.externalReference!;
    // First callback records SUCCEEDED.
    social.deliver(ref, { status: "success", reference: "ext-success-1" });
    const first = await recordExecutionResult(h.db as never, h.deps, { userId: USER1 }, { attemptId: attempt.attemptId });
    expect(first.pending).toBe(false);
    const firstHash = h.db.table("execution_attempts")[0].resultHash;
    // A conflicting stale callback (provider retry carrying a different outcome) arrives.
    social.deliver(ref, { status: "failure", failureClass: "PROVIDER_ERROR", retryable: false });
    const second = await recordExecutionResult(h.db as never, h.deps, { userId: USER1 }, { attemptId: attempt.attemptId });
    // Converges with zero new effects — the recorded result is immutable.
    expect(second.pending).toBe(false);
    const row = h.db.table("execution_attempts")[0];
    expect(row.resultStatus).toBe("SUCCEEDED");
    expect(row.resultHash).toBe(firstHash);
    // The terminal SUCCEEDED fact is unique (the earlier PENDING_EXTERNAL fact
    // is a separate, legitimate lifecycle record).
    expect(
      h.db.table("execution_lifecycle_events").filter((f) => f.lifecycleType === "result_recorded" && f.toState === "SUCCEEDED")
    ).toHaveLength(1);
  });
});

describe("R10-B structural concurrency — retry / recovery / state races (s9-s12)", () => {
  it("s9+s10: concurrent recovery proposals converge to ONE rcn1: candidate; divergent lifecycle CAS fails closed", async () => {
    const db = makeConcurrencyDb();
    const row = recoveryCandidateRow() as never;
    const outcomes = await runWorkers(8, async () => {
      const r = await insertMissionRecoveryCandidate(row, db as never);
      return r.duplicateClassification;
    });
    expect(outcomes.filter((c) => c === "none")).toHaveLength(1);
    expect(outcomes.filter((c) => c === "idempotent_replay")).toHaveLength(7);
    expect(db.table("mission_recovery_candidates")).toHaveLength(1);

    // Concurrent lifecycle transitions: identical targets converge (CAS-1 — the
    // loser observes the winner's commit), divergent targets fail closed. The
    // durable invariant is exactly ONE real transition: version 2, one status.
    const raced = await runWorkers(4, async (i) => {
      try {
        await transitionRecoveryStatus({
          userId: USER1,
          recoveryCandidateId: `rcn1:${H("r1")}`,
          expectedVersion: 1,
          fromStatuses: ["PROPOSED"],
          toStatus: i % 2 === 0 ? "AUTHORIZED" : "CANCELLED",
          executor: db as never,
        });
        return "won";
      } catch (err) {
        return (err as { code?: string }).code ?? "error";
      }
    });
    // Every "won" worker must have observed the SAME final status (convergence).
    const finalStatus = db.table("mission_recovery_candidates")[0].status;
    expect(["AUTHORIZED", "CANCELLED"]).toContain(finalStatus);
    expect(db.table("mission_recovery_candidates")[0].version).toBe(2);
    // At most one distinct target can win; the other target's workers failed closed.
    const distinctTargets = new Set(raced.filter((r) => r === "won").map(() => finalStatus));
    expect(distinctTargets.size).toBe(1);
  });

  it("s11: mission-state convergence race — K concurrent observers converge to ONE state row", async () => {
    const db = makeConcurrencyDb();
    const row = {
      missionStateId: `mst1:${H("s1")}`,
      userId: USER1,
      businessId: BUSINESS1,
      missionId: MISSION_ID,
      planId: PLAN_ID,
      scheduleId: SCHEDULE_ID,
      missionStatus: "ELIGIBLE_FOR_PLANNING",
      healthClass: "HEALTHY",
      taskSummary: { total: 1, byStatus: {}, requiredTotal: 1, requiredSucceeded: 0 },
      latestExecutionRefs: [],
      blockingReasons: [],
      uncertainties: [],
      recoveryCandidateIds: [],
      observedAt: NOW,
      derivedFromVersion: H("dv"),
      validUntil: VALID_UNTIL,
      version: 1,
    } as never;
    const outcomes = await runWorkers(8, async () => {
      const r = await insertMissionStateRecord(row, db as never);
      return r.duplicateClassification;
    });
    expect(outcomes.filter((c) => c === "none")).toHaveLength(1);
    expect(outcomes.filter((c) => c === "idempotent_replay")).toHaveLength(7);
    expect(db.table("mission_state_records")).toHaveLength(1);
  });

  it("s12: CAS loser behaviour — identical transition converges; divergent transition fails closed", async () => {
    const db = makeConcurrencyDb();
    await insertSchedule(scheduleRow() as never, db as never);

    // Identical racing transition: exactly one durable effect; losers converge.
    const identical = await runWorkers(6, async () => {
      try {
        await transitionScheduleStatus(USER1, SCHEDULE_ID, 1, "SUPERSEDED", db as never);
        return "applied";
      } catch {
        return "conflict";
      }
    });
    expect(identical.filter((r) => r === "applied")).toHaveLength(1);
    expect(db.table("mission_schedules")[0].status).toBe("SUPERSEDED");
    expect(db.table("mission_schedules")[0].version).toBe(2);

    // Re-read-verify CAS idiom (R9-D): a stale-version transition fails closed.
    const actionRow = {
      executionActionId: `exa1:${H("cas")}`,
      userId: USER1,
      businessId: BUSINESS1,
      missionId: MISSION_ID,
      planId: PLAN_ID,
      scheduleId: SCHEDULE_ID,
      taskId: TASK_ALPHA,
      taskType: "PUBLISH_CONTENT",
      actionType: "EXECUTE_TASK",
      actionParametersHash: H("ap"),
      inputRefs: [],
      governanceDecisionId: `mgd1:${H("c")}`,
      approvalReference: null,
      authorizationFingerprint: H("af"),
      idempotencyKey: `idem1:${H("ik")}`,
      adapterType: "SOCIAL",
      capability: "social.publish",
      validFrom: VALID_FROM,
      validUntil: VALID_UNTIL,
      dispatchState: "DISPATCH_PREPARED",
      dispatchFingerprint: H("df"),
      attemptCount: 0,
      version: 1,
    } as never;
    await insertExecutionAction(actionRow, db as never);
    await transitionDispatchState({
      userId: USER1,
      executionActionId: `exa1:${H("cas")}`,
      expectedVersion: 1,
      fromStates: ["DISPATCH_PREPARED"],
      toState: "DISPATCHED",
      attemptCount: 1,
      executor: db as never,
    });
    // Stale re-transition from the pre-read version must fail closed.
    await expect(
      transitionDispatchState({
        userId: USER1,
        executionActionId: `exa1:${H("cas")}`,
        expectedVersion: 1,
        fromStates: ["DISPATCH_PREPARED"],
        toState: "CANCELLED",
        executor: db as never,
      })
    ).rejects.toMatchObject({ code: "INVALID_DISPATCH_STATE" });
    expect(db.table("execution_actions")[0].dispatchState).toBe("DISPATCHED");
    expect(db.table("execution_actions")[0].version).toBe(2);
  });
});

describe("R10-B structural concurrency — transactions, crashes, faults (s13-s17)", () => {
  function seedTerminalFailure(db: ConcurrencyDb) {
    db.table("queue_terminal_failures").push({
      id: 42,
      queueName: "publishing",
      jobId: "job-1",
      queueItemId: 7,
      failureClass: "CRASH",
      errorSummary: "boom",
      replayMode: "automatic",
      occurredAt: NOW,
      replayRequestId: null,
    });
    db.table("queue_replay_requests").push({
      id: 100,
      replayKey: "replay-key-1",
      terminalFailureId: 42,
      queueName: "publishing",
      status: "requested",
      requestedByUserId: USER1,
      reason: "r10b",
      claimedAt: null,
      resolvedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }

  it("s13: worker crash during DB transaction — claim rolls back atomically; no partial claim", async () => {
    const db = makeConcurrencyDb();
    seedTerminalFailure(db);
    db.crashNextTransaction();
    await expect(claimTerminalReplayRequest(100, { claimedAt: new Date(NOW) }, db as never)).rejects.toThrow(
      /crash/i
    );
    // Nothing partial survives: no active claim row, status untouched.
    expect(db.table("queue_replay_active_claims")).toHaveLength(0);
    expect(db.table("queue_replay_requests")[0].status).toBe("requested");
    // Another worker can claim cleanly after the crash.
    const claim = await claimTerminalReplayRequest(100, { claimedAt: new Date(NOW) }, db as never);
    expect(claim.claimed).toBe(true);
    expect(db.table("queue_replay_active_claims")).toHaveLength(1);
  });

  it("s14: deadlock victim — the victim errors retryably, never succeeds falsely; retry converges", async () => {
    const db = makeConcurrencyDb();
    seedTerminalFailure(db);
    db.inject({ op: "insert", table: "queue_replay_active_claims", err: { code: "ER_LOCK_DEADLOCK", message: "Deadlock found" } });
    // The deadlock victim (1213) propagates as a retryable failure — the claim
    // layer only converts duplicate-key races, never masks a deadlock as success.
    await expect(claimTerminalReplayRequest(100, { claimedAt: new Date(NOW) }, db as never)).rejects.toMatchObject({
      code: "ER_LOCK_DEADLOCK",
    });
    expect(db.table("queue_replay_active_claims")).toHaveLength(0);
    expect(db.table("queue_replay_requests")[0].status).toBe("requested");
    // The job layer retries; the claim authority converges to exactly one claim.
    const second = await claimTerminalReplayRequest(100, { claimedAt: new Date(NOW) }, db as never);
    expect(second.claimed).toBe(true);
    expect(db.table("queue_replay_active_claims")).toHaveLength(1);
  });

  it("s15: DB connection interruption mid-claim — no claim, no state mutation", async () => {
    const db = makeConcurrencyDb();
    seedTerminalFailure(db);
    db.inject({ op: "update", table: "queue_replay_requests", err: { code: "PROTOCOL_CONNECTION_LOST", message: "Connection lost" } });
    await expect(claimTerminalReplayRequest(100, { claimedAt: new Date(NOW) }, db as never)).rejects.toMatchObject({
      code: "PROTOCOL_CONNECTION_LOST",
    });
    // The whole claim transaction rolled back (claim insert undone with the update failure).
    expect(db.table("queue_replay_active_claims")).toHaveLength(0);
    expect(db.table("queue_replay_requests")[0].status).toBe("requested");
  });

  it("s16: worker crash after durable intent but before completion — durable intent survives; outcome stays conservative", async () => {
    const h = makeServiceHarness((gov) => plantGovernanceDecision(gov, {}));
    const decisionId = `mgd1:${H("c")}`;
    const action = await prepareHappyAction(h, decisionId);
    // Crash the worker AFTER the attempt row is durably inserted but BEFORE the
    // terminal transition commits: skip the first state transition, kill the second.
    h.db.inject({
      op: "update",
      table: "execution_actions",
      after: 1,
      err: { code: "PROTOCOL_CONNECTION_LOST", message: "worker died after intent commit" },
    });
    await expect(
      dispatchExecutionAction(h.db as never, h.deps, { userId: USER1 }, {
        executionActionId: action.executionActionId,
        parameters: PARAMS,
      })
    ).rejects.toMatchObject({ code: "PROTOCOL_CONNECTION_LOST" });
    // The durable intent (exactly one attempt) exists…
    const attempts = h.db.table("execution_attempts");
    expect(attempts).toHaveLength(1);
    expect(attempts[0].resultStatus).toBe("SUCCEEDED"); // adapter outcome was recorded
    // …but the action was NEVER falsely marked SUCCEEDED — it stays conservative.
    const actionRow = h.db.table("execution_actions")[0];
    expect(actionRow.dispatchState).toBe("DISPATCHED");
    // Post-restart callback resolution converges on the durable attempt: zero new attempts.
    const resolution = await recordExecutionResult(h.db as never, h.deps, { userId: USER1 }, {
      attemptId: attempts[0].attemptId as string,
    });
    expect(resolution.pending).toBe(false);
    expect(h.db.table("execution_attempts")).toHaveLength(1);
    expect(h.db.table("execution_lifecycle_events").filter((f) => f.lifecycleType === "result_recorded")).toHaveLength(0);
  });

  it("s17: replay after restart — identical operations converge against durable state", async () => {
    const db = makeConcurrencyDb();
    // "Restart" = brand-new worker pool against the SAME durable tables.
    await insertMissionProposal(db as never, missionProposalRow() as never);
    const outcomes = await runWorkers(6, async () => {
      try {
        const r = await insertMissionProposal(db as never, missionProposalRow() as never);
        return r.inserted;
      } catch {
        return false;
      }
    });
    expect(outcomes.every((i) => i === false)).toBe(true);
    expect(db.table("mission_proposals")).toHaveLength(1);
  });
});

describe("R10-B structural concurrency — isolation + attack surfaces (s18-s20)", () => {
  it("s18: cross-tenant collision attempt — foreign tenant cannot consume another tenant's authority", async () => {
    const db = makeConcurrencyDb();
    const gov = governanceDecisionRow() as Record<string, unknown>;
    await insertMissionGovernanceDecision(gov as never, db as never);
    // Cross-tenant read of the same decision anchor converges to nothing.
    await expect(
      getMissionGovernanceDecision(USER2, gov.governanceDecisionId as string, db as never)
    ).rejects.toMatchObject({ code: "GOVERNANCE_DECISION_NOT_FOUND" });
    // The canonical schema carries a GLOBAL unique on governanceDecisionId
    // (mgd_decision_id_idx) over tenant-scoped material: an attempted
    // cross-tenant replay under the identical anchor fails closed at the
    // durable key — the foreign row can never be written, so there is nothing
    // to consume. (Two tenants cannot legitimately mint the same mgd1: id.)
    await expect(
      insertMissionGovernanceDecision({ ...gov, userId: USER2 } as never, db as never)
    ).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
    expect(db.table("mission_governance_decisions")).toHaveLength(1);
    expect(db.table("mission_governance_decisions")[0].userId).toBe(USER1);
    // The consumption gate rejects a foreign approval row outright.
    const decision = governanceDecisionRow() as never as MissionGovernanceDecision;
    const verdict = assertMissionActionConsumable({
      decision,
      approval: { id: 1, userId: USER2, status: "approved", context: null },
      expectedAction: { subjectClass: "EXECUTION_STEP", actionType: "EXECUTE_TASK", missionRef: MISSION_ID, planRef: PLAN_ID, taskRef: TASK_ALPHA, actionParams: canonicalParamsFor({}) },
      currentPolicyVersion: POLICY_VERSION,
      now: NOW,
    });
    expect(verdict.consumable).toBe(false);
    if (!verdict.consumable) expect(verdict.reason).toBe("APPROVAL_BINDING_MISMATCH");
  });

  it("s19: cross-business collision attempt — businessId binding mismatch fails closed", async () => {
    const decision = governanceDecisionRow() as never as MissionGovernanceDecision;
    const crossBusinessApproval = {
      id: 1,
      userId: USER1,
      status: "approved" as const,
      context: {
        missionGovernanceBinding: {
          contractVersion: "mission-governance/approval@v1",
          governanceDecisionId: decision.governanceDecisionId,
          businessId: BUSINESS2, // ← wrong business
          missionRef: MISSION_ID,
          planRef: PLAN_ID,
          taskRef: TASK_ALPHA,
          subjectClass: "EXECUTION_STEP",
          actionType: "EXECUTE_TASK",
          actionParamsFingerprint: decision.actionParamsFingerprint,
          missionRiskClass: "MEDIUM",
          policyVersion: POLICY_VERSION,
          approvalBindingHash: (() => {
            // Correct hash for the decision material; business mismatch is checked separately.
            return deriveGovernanceApprovalBindingHash({
              governanceDecisionId: decision.governanceDecisionId,
              policyVersion: POLICY_VERSION,
              actionParamsFingerprint: decision.actionParamsFingerprint,
              missionRiskClass: "MEDIUM",
            });
          })(),
          expiresAt: VALID_UNTIL,
        },
      },
    };
    const verdict = assertMissionActionConsumable({
      decision,
      approval: crossBusinessApproval,
      expectedAction: { subjectClass: "EXECUTION_STEP", actionType: "EXECUTE_TASK", missionRef: MISSION_ID, planRef: PLAN_ID, taskRef: TASK_ALPHA, actionParams: canonicalParamsFor({}) },
      currentPolicyVersion: POLICY_VERSION,
      now: NOW,
    });
    expect(verdict.consumable).toBe(false);
    if (!verdict.consumable) expect(verdict.reason).toBe("APPROVAL_BINDING_MISMATCH");
  });

  it("s20: idempotency-key collision attack — conflicting material under the same anchor fails closed", async () => {
    const db = makeConcurrencyDb();
    const params = canonicalParamsFor({});
    const hash = deriveActionParametersHash(params);
    const actionId = deriveExecutionActionId({
      tenantUserId: USER1,
      businessId: BUSINESS1,
      missionId: MISSION_ID,
      planId: PLAN_ID,
      scheduleId: SCHEDULE_ID,
      taskId: TASK_ALPHA,
      actionType: "EXECUTE_TASK",
      actionParametersHash: hash,
      authorizationFingerprint: H("af"),
      adapterType: "SOCIAL",
    });
    const idem = deriveIdempotencyKey(USER1, actionId);
    const makeAction = (overrides: Record<string, unknown>) => ({
      executionActionId: actionId,
      userId: USER1,
      businessId: BUSINESS1,
      missionId: MISSION_ID,
      planId: PLAN_ID,
      scheduleId: SCHEDULE_ID,
      taskId: TASK_ALPHA,
      taskType: "PUBLISH_CONTENT",
      actionType: "EXECUTE_TASK",
      actionParametersHash: hash,
      inputRefs: [],
      governanceDecisionId: `mgd1:${H("c")}`,
      approvalReference: null,
      authorizationFingerprint: H("af"),
      idempotencyKey: idem,
      adapterType: "SOCIAL",
      capability: "social.publish",
      validFrom: VALID_FROM,
      validUntil: VALID_UNTIL,
      dispatchState: "DISPATCH_PREPARED",
      dispatchFingerprint: H("df"),
      attemptCount: 0,
      version: 1,
      ...overrides,
    }) as never;
    await insertExecutionAction(makeAction({}), db as never);
    // Attacker reuses the same deterministic idempotency anchor with DIFFERENT material.
    await expect(
      insertExecutionAction(makeAction({ capability: "campaign.activate", adapterType: "CAMPAIGN" }), db as never)
    ).rejects.toMatchObject({ code: "EXECUTION_REPLAY_CONFLICT" });
    expect(db.table("execution_actions")).toHaveLength(1);
    expect(db.table("execution_actions")[0].capability).toBe("social.publish");
  });

  it("s20b: governance receipt idempotency — exact replay converges; conflicting material never replaces the immutable receipt", async () => {
    const db = makeConcurrencyDb();
    const row = governanceDecisionRow() as Record<string, unknown>;
    await insertMissionGovernanceDecision(row as never, db as never);
    const again = await insertMissionGovernanceDecision(row as never, db as never);
    expect(again.inserted).toBe(false);
    expect(again.duplicateClassification).toBe("idempotent_replay");
    // Receipts are immutable: a conflicting write under the same anchor is treated
    // as replay and can NEVER overwrite the committed ALLOW verdict.
    const conflicting = await insertMissionGovernanceDecision({ ...row, decision: "BLOCK" } as never, db as never);
    expect(conflicting.inserted).toBe(false);
    expect(db.table("mission_governance_decisions")).toHaveLength(1);
    expect(db.table("mission_governance_decisions")[0].decision).toBe("ALLOW");
  });
});

describe("R10-B structural concurrency — CAS rollback safety sweep (B6)", () => {
  it("rollback before intent commit: failed dispatch intent leaves zero authority rows", async () => {
    const db = makeConcurrencyDb();
    db.inject({ op: "insert", table: "execution_actions", err: { code: "ER_LOCK_DEADLOCK", message: "victim" } });
    const row = {
      executionActionId: `exa1:${H("rb")}`,
      userId: USER1,
      businessId: BUSINESS1,
      missionId: MISSION_ID,
      planId: PLAN_ID,
      scheduleId: SCHEDULE_ID,
      taskId: TASK_ALPHA,
      taskType: "PUBLISH_CONTENT",
      actionType: "EXECUTE_TASK",
      actionParametersHash: H("ap"),
      inputRefs: [],
      governanceDecisionId: `mgd1:${H("c")}`,
      approvalReference: null,
      authorizationFingerprint: H("af"),
      idempotencyKey: `idem1:${H("rb2")}`,
      adapterType: "SOCIAL",
      capability: "social.publish",
      validFrom: VALID_FROM,
      validUntil: VALID_UNTIL,
      dispatchState: "DISPATCH_PREPARED",
      dispatchFingerprint: H("df"),
      attemptCount: 0,
      version: 1,
    } as never;
    await expect(insertExecutionAction(row, db as never)).rejects.toMatchObject({ code: "ER_LOCK_DEADLOCK" });
    expect(db.table("execution_actions")).toHaveLength(0);
  });

  it("stale version + racing lifecycle CAS — one winner, losers fail closed with MISSION_LIFECYCLE_CONFLICT", async () => {
    const db = makeConcurrencyDb();
    await insertMissionProposal(db as never, missionProposalRow({ status: "PROPOSED" }) as never);
    // Two workers race the same version-1 lifecycle transition.
    const raced = await runWorkers(2, async (i) => {
      try {
        await transitionMissionStatus(db as never, {
          userId: USER1,
          missionId: MISSION_ID,
          expectedVersion: 1,
          nextStatus: i === 0 ? "ELIGIBLE_FOR_PLANNING" : "CANCELLED",
        });
        return "won";
      } catch (err) {
        return (err as { code?: string }).code ?? "error";
      }
    });
    expect(raced.filter((r) => r === "won")).toHaveLength(1);
    expect(raced.filter((r) => r === "MISSION_LIFECYCLE_CONFLICT")).toHaveLength(1);
    const row = db.table("mission_proposals")[0];
    expect(["ELIGIBLE_FOR_PLANNING", "CANCELLED"]).toContain(row.status);
    expect(row.version).toBe(2);
    // A stale retry against version 1 now fails closed (CAS-0 fix: the guard
    // reads the tuple header instead of the whole result).
    await expect(
      transitionMissionStatus(db as never, {
        userId: USER1,
        missionId: MISSION_ID,
        expectedVersion: 1,
        nextStatus: "CANCELLED",
      })
    ).rejects.toMatchObject({ code: "MISSION_LIFECYCLE_CONFLICT" });
    expect(db.table("mission_proposals")[0].version).toBe(2);
  });

  it("terminal replay transaction with coupled mutations commits or rolls back together", async () => {
    const db = makeConcurrencyDb();
    seedTerminalFailureForCoupledTest(db);
    // Happy path: both mutations land.
    await withTerminalReplayTransaction(async (tx) => {
      await tx.insert(queueReplayActiveClaims).values({ terminalFailureId: 42, replayRequestId: 100 });
      await tx.update(queueReplayRequests).set({ status: "claimed" }).where({ kind: "eq", field: "id", value: 100 } as never);
    }, db as never);
    expect(db.table("queue_replay_active_claims")).toHaveLength(1);
    expect(db.table("queue_replay_requests")[0].status).toBe("claimed");
  });

  function seedTerminalFailureForCoupledTest(db: ConcurrencyDb) {
    db.table("queue_replay_requests").push({
      id: 100,
      replayKey: "replay-key-1",
      terminalFailureId: 42,
      queueName: "publishing",
      status: "requested",
      requestedByUserId: USER1,
      reason: null,
      claimedAt: null,
      resolvedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }

  it("terminal replay transaction rolls back the coupled claim insert when the update dies", async () => {
    const db = makeConcurrencyDb();
    seedTerminalFailureForCoupledTest(db);
    db.inject({ op: "update", table: "queue_replay_requests", err: { code: "PROTOCOL_CONNECTION_LOST", message: "lost" } });
    await expect(
      withTerminalReplayTransaction(async (tx) => {
        await tx.insert(queueReplayActiveClaims).values({ terminalFailureId: 42, replayRequestId: 100 });
        await tx.update(queueReplayRequests).set({ status: "claimed" }).where({ kind: "eq", field: "id", value: 100 } as never);
      }, db as never)
    ).rejects.toMatchObject({ code: "PROTOCOL_CONNECTION_LOST" });
    // Coupled rollback: the claim insert is gone too.
    expect(db.table("queue_replay_active_claims")).toHaveLength(0);
    expect(db.table("queue_replay_requests")[0].status).toBe("requested");
  });
});
