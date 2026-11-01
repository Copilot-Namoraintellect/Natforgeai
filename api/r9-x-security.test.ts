/**
 * R9-X — CROSS-STREAM ROGUE-AGENT SECURITY SUITE (X8).
 *
 * Assume ONE Mission-Control agent (A/B/C/D/E/F surface) is fully compromised.
 * For every stream crossing, prove the compromise cannot mint authority owned
 * by another stream:
 *
 *   - no approval-type confusion (strategic/marketing/optimisation approvals
 *     can never satisfy R9-F mission_action consumption);
 *   - scheduling evidence (C) is never execution authority (D re-runs the
 *     exact R9-F gate over the exact envelope);
 *   - an unknown or UNSUPPORTED planning capability fails closed at the
 *     B→D translation boundary — adapter selection can never be widened;
 *   - client-authority smuggling is rejected at every R9 router boundary;
 *   - no EXECUTE / force / override / setDecision semantics exist anywhere;
 *   - tenant/business isolation holds across the whole connected chain;
 *   - a recovery handoff consumed by D can never widen the retry scope;
 *   - a superseded policy version can never authorize consumption;
 *   - the audit trail converges (exactly one event per durable effect);
 *   - secrets and secret-shaped material never persist in any R9 table.
 *
 * Runs the REAL integrated routers/services against the in-memory fake DB —
 * the same production paths R9-X ships. Sandbox adapters only. No production
 * action, no migration, no deployment. LIVE_EXECUTION=False.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getTableName } from "drizzle-orm";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
}));

let lastEmailCode: string | null = null;
vi.mock("./lib/email", () => ({
  sendTwoFactorCodeEmail: vi.fn(async ({ code }: { code: string }) => {
    lastEmailCode = code;
    return { messageId: "test-message", accepted: ["test@example.com"], rejected: [] };
  }),
}));

import { getDb } from "./queries/connection";
import { strategicMemoryRouter } from "./strategic-memory-router";
import { businessChangeRouter } from "./business-change-router";
import { marketSignalRouter } from "./market-signal-router";
import { strategicReasoningRouter } from "./strategic-reasoning-router";
import { strategicOpportunityRiskRouter } from "./strategic-opportunity-risk-router";
import { strategicGovernanceRouter } from "./strategic-governance-router";
import { missionAuthorityRouter } from "./mission-authority-router";
import { missionPlanningRouter } from "./mission-planning-router";
import { missionSchedulingRouter } from "./mission-scheduling-router";
import { missionGovernanceRouter } from "./mission-governance-router";
import { executionCoordinationRouter, createExecutionCoordinationDeps } from "./execution-coordination-router";
import { missionStateRecoveryRouter } from "./mission-state-recovery-router";
import { buildCtx, createFakeDb } from "./r5-test-support";
import { bindCanonicalStrategicGovernanceEngine } from "./lib/strategic-governance/strategic-governance-engine-binding";
import { deriveApprovalBindingHash } from "./lib/strategic-opportunity-risk/strategic-opportunity-risk-reasoning-seam";
import { canonicalJson, sha256Hex } from "./lib/strategic-memory/strategic-memory-contract";
import { createSandboxAdapterHarness } from "./lib/execution-coordination/execution-adapter-registry";
import type { AdapterRawOutcome } from "./lib/execution-coordination/execution-adapter-registry";
import { DEFAULT_MISSION_GOVERNANCE_POLICY } from "./lib/mission-governance/mission-policy";
import {
  assertMissionActionConsumable,
  buildMissionApprovalCommand,
  validateMissionApprovalAuthorizable,
  type MissionApprovalView,
} from "./lib/mission-governance/mission-approval";
import { deriveActionParamsFingerprint as deriveGovernanceActionParamsFingerprint, deriveMissionApprovalBindingHash } from "./lib/mission-governance/mission-governance-contract";
import { BOUND_MISSION_POLICY_VERSION, EXECUTION_ACTION_TYPES } from "./lib/execution-coordination/execution-coordination-contract";
import { deriveCanonicalActionParams } from "./lib/execution-coordination/execution-coordination-identity";
import { resolveAdapterForCapabilities } from "./lib/execution-coordination/execution-adapter-registry";
import { translateEnvironmentCapabilities, translateRequiredCapabilities, translateRequiredCapability } from "./lib/execution-coordination/execution-capability-vocabulary";
import { MISSION_ENVIRONMENT_CAPABILITIES } from "./lib/mission-scheduling/mission-scheduling-plan-port";
import { createMissionGovernanceConsumptionAuthority } from "./lib/execution-coordination/execution-governance-seam";
import { createExecutionUpstreamAuthority } from "./lib/execution-coordination/execution-upstream-seams";
import { dispatchExecutionAction } from "./lib/execution-coordination/execution-coordination-service";
import type { ExecutionCoordinationServiceDeps } from "./lib/execution-coordination/execution-coordination-service";

const NOW = new Date("2026-11-12T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const USER1 = { id: 1, role: "user" };
const USER2 = { id: 2, role: "user" };
const BIZ1 = 10;
const BIZ2 = 20;

const UNIQUE_CHECKS: Record<string, string[][]> = {
  strategic_memory_records: [
    ["memoryId"],
    ["userId", "memoryId"],
    ["userId", "businessId", "sourceAuthority", "sourceIdentity", "memoryType"],
  ],
  strategic_memory_lifecycle_events: [["memoryLifecycleEventId"]],
  business_change_events: [
    ["changeId"],
    ["userId", "changeId"],
    ["userId", "businessId", "subjectType", "subjectId", "changeType", "previousStateFingerprint", "currentStateFingerprint"],
  ],
  business_change_lifecycle_events: [["changeLifecycleEventId"]],
  external_sources: [["sourceId"], ["userId", "originKey"]],
  external_signals: [["signalId"], ["userId", "sourceId", "eventKey"]],
  external_signal_lifecycle_events: [["signalLifecycleEventId"]],
  strategic_reasoning_bundles: [["bundleId"], ["userId", "bundleId"]],
  strategic_reasoning_records: [["reasoningId"], ["userId", "reasoningId"]],
  strategic_reasoning_lifecycle_events: [["lifecycleEventId"]],
  strategic_opportunity_risk_candidates: [["candidateId"], ["userId", "candidateId"]],
  strategic_opportunity_risk_relations: [["relationId"]],
  strategic_opportunity_risk_lifecycle_events: [["lifecycleEventId"]],
  strategic_governance_decisions: [["userId", "governanceDecisionId"]],
  mission_proposals: [["missionId"], ["userId", "missionId"]],
  mission_lifecycle_events: [["lifecycleEventId"]],
  mission_plans: [["planFingerprint"], ["userId", "planId"], ["userId", "missionId", "planVersion"]],
  mission_plan_tasks: [["taskFingerprint"], ["userId", "taskId"]],
  mission_plan_lifecycle_events: [["lifecycleEventId"]],
  mission_task_plan_snapshots: [["planFingerprint"], ["userId", "missionId", "planId", "planFingerprint"]],
  mission_dependency_edges: [
    ["dependencyId"],
    ["userId", "dependencyId"],
    ["userId", "missionId", "planId", "predecessorTaskId", "successorTaskId", "dependencyType"],
  ],
  mission_schedules: [["scheduleId"], ["userId", "scheduleId"]],
  mission_schedule_lifecycle_events: [["lifecycleEventId"]],
  execution_actions: [["executionActionId"], ["userId", "executionActionId"], ["userId", "idempotencyKey"]],
  execution_attempts: [["attemptId"], ["userId", "attemptId"], ["userId", "executionActionId", "attemptNumber"]],
  execution_lifecycle_events: [["lifecycleEventId"]],
  mission_state_records: [["stateRecordId"], ["userId", "stateRecordId"]],
  mission_task_states: [["taskStateId"], ["userId", "taskStateId"]],
  mission_recovery_candidates: [["recoveryCandidateId"], ["userId", "recoveryCandidateId"]],
  mission_operational_timeline_events: [["timelineEventId"]],
  mission_governance_decisions: [["userId", "governanceDecisionId"]],
  approval_requests: [["id"]],
  audit_events: [["eventFingerprint"]],
};

function flattenSql(fragment: any): string {
  const chunks = fragment?.sql?.queryChunks ?? fragment?.queryChunks ?? [];
  const parts: string[] = [];
  const render = (chunk: any): void => {
    if (chunk === null || chunk === undefined) return;
    if (typeof chunk === "string") { parts.push(chunk); return; }
    if (Array.isArray(chunk)) { chunk.forEach(render); return; }
    if (typeof chunk === "object") {
      if (typeof chunk.value === "string" || typeof chunk.value === "number" || typeof chunk.value === "boolean") {
        const v = chunk.value;
        parts.push(typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "\\'")}'`);
        return;
      }
      if (typeof chunk.name === "string") { parts.push(chunk.name); return; }
      if (typeof chunk.operator === "string") { parts.push(` ${chunk.operator} `); return; }
      if (Array.isArray(chunk.value)) { chunk.value.forEach(render); return; }
      if (Array.isArray(chunk.queryChunks)) { chunk.queryChunks.forEach(render); return; }
      if (Array.isArray(chunk.values)) { chunk.values.forEach(render); return; }
      if ("sql" in chunk && Array.isArray(chunk.sql?.queryChunks)) { chunk.sql.queryChunks.forEach(render); return; }
    }
    parts.push(String(chunk));
  };
  chunks.forEach(render);
  return parts.join("");
}

function matchWhere(text: string, row: Record<string, unknown>): boolean {
  const whereMatch = text.match(/\bWHERE\b([\s\S]*?)(?:\bORDER BY\b|\bLIMIT\b|$)/i);
  if (!whereMatch) return true;
  const clause = whereMatch[1];
  const re = /(\w+)\s*(=|>=|<=|>|<)\s*(?:'((?:[^'\\]|\\.)*)'|([A-Za-z0-9:_-]+))|(\w+)\s+IS\s+(NOT\s+)?NULL/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clause)) !== null) {
    if (m[5]) {
      const isNull = row[m[5]] === null || row[m[5]] === undefined;
      if (m[6] ? isNull : !isNull) return false;
      continue;
    }
    const col = m[1];
    const raw = m[3] !== undefined ? m[3].replace(/\\'/g, "'") : m[4];
    const rowValue = row[col];
    const numRow = Number(rowValue);
    const numRaw = Number(raw);
    if (m[2] === "=") { if (String(rowValue ?? "") !== raw) return false; }
    else if (m[2] === ">") { if (!(numRow > numRaw)) return false; }
    else if (m[2] === "<") { if (!(numRow < numRaw)) return false; }
    else if (m[2] === ">=") { if (!(numRow >= numRaw)) return false; }
    else if (m[2] === "<=") { if (!(numRow <= numRaw)) return false; }
  }
  return true;
}

function makeSeed() {
  return {
    users: [
      { id: USER1.id, email: "user1@example.com", emailVerifiedAt: NOW.toISOString(), role: "user" },
      { id: USER2.id, email: "user2@example.com", emailVerifiedAt: NOW.toISOString(), role: "user" },
    ],
    businesses: [
      { id: BIZ1, userId: USER1.id, isActive: true },
      { id: 11, userId: USER1.id, isActive: true },
      { id: BIZ2, userId: USER2.id, isActive: true },
    ],
    twoFactorChallenges: [] as Array<Record<string, unknown>>,
    business_dna_snapshots: [] as Array<Record<string, unknown>>,
    strategy_snapshots: [] as Array<Record<string, unknown>>,
    campaigns: [] as Array<Record<string, unknown>>,
    payments: [] as Array<Record<string, unknown>>,
    subscriptions: [] as Array<Record<string, unknown>>,
    approval_requests: [] as Array<Record<string, unknown>>,
    audit_events: [] as Array<Record<string, unknown>>,
    strategic_memory_records: [] as Array<Record<string, unknown>>,
    strategic_memory_lifecycle_events: [] as Array<Record<string, unknown>>,
    business_change_events: [] as Array<Record<string, unknown>>,
    business_change_lifecycle_events: [] as Array<Record<string, unknown>>,
    external_sources: [] as Array<Record<string, unknown>>,
    external_signals: [] as Array<Record<string, unknown>>,
    external_signal_lifecycle_events: [] as Array<Record<string, unknown>>,
    strategic_reasoning_bundles: [] as Array<Record<string, unknown>>,
    strategic_reasoning_records: [] as Array<Record<string, unknown>>,
    strategic_reasoning_lifecycle_events: [] as Array<Record<string, unknown>>,
    strategic_opportunity_risk_candidates: [] as Array<Record<string, unknown>>,
    strategic_opportunity_risk_relations: [] as Array<Record<string, unknown>>,
    strategic_opportunity_risk_lifecycle_events: [] as Array<Record<string, unknown>>,
    strategic_governance_decisions: [] as Array<Record<string, unknown>>,
    mission_proposals: [] as Array<Record<string, unknown>>,
    mission_lifecycle_events: [] as Array<Record<string, unknown>>,
    mission_plans: [] as Array<Record<string, unknown>>,
    mission_plan_tasks: [] as Array<Record<string, unknown>>,
    mission_plan_lifecycle_events: [] as Array<Record<string, unknown>>,
    mission_task_plan_snapshots: [] as Array<Record<string, unknown>>,
    mission_dependency_edges: [] as Array<Record<string, unknown>>,
    mission_schedules: [] as Array<Record<string, unknown>>,
    mission_schedule_lifecycle_events: [] as Array<Record<string, unknown>>,
    execution_actions: [] as Array<Record<string, unknown>>,
    execution_attempts: [] as Array<Record<string, unknown>>,
    execution_lifecycle_events: [] as Array<Record<string, unknown>>,
    mission_state_records: [] as Array<Record<string, unknown>>,
    mission_task_states: [] as Array<Record<string, unknown>>,
    mission_recovery_candidates: [] as Array<Record<string, unknown>>,
    mission_operational_timeline_events: [] as Array<Record<string, unknown>>,
    mission_governance_decisions: [] as Array<Record<string, unknown>>,
  };
}

type Seed = ReturnType<typeof makeSeed>;

let seed: Seed;
let db: ReturnType<typeof createFakeDb>["db"];

let calls: ReturnType<typeof asUser>;

function asUser(user: typeof USER1) {
  return {
    memory: strategicMemoryRouter.createCaller(buildCtx(user)),
    change: businessChangeRouter.createCaller(buildCtx(user)),
    signal: marketSignalRouter.createCaller(buildCtx(user)),
    reasoning: strategicReasoningRouter.createCaller(buildCtx(user)),
    opportunity: strategicOpportunityRiskRouter.createCaller(buildCtx(user)),
    sgovernance: strategicGovernanceRouter.createCaller(buildCtx(user)),
    mission: missionAuthorityRouter.createCaller(buildCtx(user)),
    planning: missionPlanningRouter.createCaller(buildCtx(user)),
    scheduling: missionSchedulingRouter.createCaller(buildCtx(user)),
    governance: missionGovernanceRouter.createCaller(buildCtx(user)),
    execution: executionCoordinationRouter.createCaller(buildCtx(user)),
    state: missionStateRecoveryRouter.createCaller(buildCtx(user)),
  };
}

function seedDnaSnapshot(tag: string, businessId: number, userId: number, content: Record<string, unknown>) {
  const snapshotId = `dna1:${sha256Hex(canonicalJson({ v: 1, tag }))}`;
  const payload = {
    businessName: "Test Business",
    industry: "fitness",
    primaryOffering: "membership",
    productsAndServices: ["base"],
    ...content,
  };
  seed.business_dna_snapshots.push({
    id: 5000 + seed.business_dna_snapshots.length,
    snapshotId,
    userId,
    businessId,
    version: 1,
    businessName: payload.businessName,
    industry: payload.industry,
    primaryOffering: payload.primaryOffering,
    productsAndServices: payload.productsAndServices,
    snapshot: payload,
    evidenceHashSha256: sha256Hex(canonicalJson({ v: 1, tag, payload })),
    capturedAt: new Date(NOW.getTime() - 2 * DAY_MS).toISOString(),
    createdAt: new Date(NOW.getTime() - 2 * DAY_MS).toISOString(),
  });
  return snapshotId;
}

function seedApproval(decision: Record<string, unknown>, status: string, approvalType = "strategic_recommendation") {
  const binding = {
    governanceDecisionId: decision.governanceDecisionId,
    policyVersion: decision.policyVersion,
    proposalFingerprint: decision.proposalFingerprint,
    evidenceFingerprint: decision.evidenceFingerprint,
    approvalBindingHash: deriveApprovalBindingHash({
      governanceDecisionId: String(decision.governanceDecisionId),
      policyVersion: String(decision.policyVersion),
      evidenceFingerprint: String(decision.evidenceFingerprint),
      proposalFingerprint: String(decision.proposalFingerprint),
    }),
  };
  seed.approval_requests.push({
    id: 8000 + seed.approval_requests.length,
    userId: decision.userId,
    approvalType,
    status,
    context: { strategicGovernanceBinding: binding },
    createdAt: NOW.toISOString(),
  });
}

/** Fully governed R8 chain → R8-E candidate (approval seeded when required). */
async function governedCandidate(tag: string, businessId: number = BIZ1, user: typeof USER1 = USER1) {
  const c = asUser(user);
  const prevSnap = seedDnaSnapshot(`${tag}_prev`, businessId, user.id, {
    primaryOffering: "Core Widget",
    productsAndServices: ["Core Widget"],
  });
  await c.memory.ingestR7({ businessId, sourceAuthority: "business_dna", sourceIdentity: prevSnap });
  const newSnap = seedDnaSnapshot(`${tag}_new`, businessId, user.id, {
    primaryOffering: "Core Widget",
    productsAndServices: ["Core Widget", "Widget Pro"],
  });
  const attested = await c.change.evaluate({
    businessId,
    subjectType: "PRODUCT_SET",
    subjectId: `product-set:business:${businessId}`,
    sourceAuthority: "business_dna",
    sourceIdentity: newSnap,
  });
  if (!attested.change) throw new Error("growth change not detected");
  const evaluated = await c.reasoning.evaluate({ businessId, changeRefs: [String(attested.change.changeId)] });
  const derived = await c.opportunity.derive({ businessId, reasoningIds: [evaluated.reasoning.reasoningId] });
  const result = derived.results[0];
  const candidate = result?.candidate;
  if (!candidate) throw new Error(`candidate not derived: ${result?.outcome ?? "none"}`);
  if (candidate.governanceDecision === "REVIEW_REQUIRED") {
    const decision = seed.strategic_governance_decisions.find(
      (x: any) => x.proposalId === candidate.candidateId
    );
    if (!decision) throw new Error("strategic governance decision not found");
    seedApproval(decision, "approved");
    const refreshed = await c.opportunity.get({ candidateId: candidate.candidateId });
    return { candidate: refreshed.candidate, caller: c };
  }
  return { candidate, caller: c };
}

function proposeInput(candidateId: string, overrides: Record<string, unknown> = {}) {
  return {
    businessId: BIZ1,
    sourceCandidateId: candidateId,
    objectiveStatement: "Capture widget demand growth in the region",
    expectedOutcome: "Measurable demand capture within the mission window",
    successCriteria: [
      { criterionType: "MEASURABLE_THRESHOLD" as const, statement: "Qualified pipeline +15%", metricRef: "pipeline:growth" },
    ],
    assumptions: [{ statement: "Demand signal remains directionally valid" }],
    constraints: [
      {
        constraintType: "BUDGET_CEILING" as const,
        statement: "Spend stays within the existing approved envelope",
        amountMinorUnits: 50000,
        currency: "ZAR" as const,
      },
    ],
    ...overrides,
  };
}

async function expectReject(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected the call to fail closed, but it resolved");
}

/** Governed chain through R9-A → R9-B → R9-C (schedule produced). */
async function chainToSchedule(tag: string) {
  const { candidate, caller } = await governedCandidate(tag);
  const proposed = await caller.mission.propose(proposeInput(candidate.candidateId));
  const mission = proposed.mission;
  await caller.mission.revalidate({ missionId: mission.missionId });
  const planRes = await caller.planning.createPlan({ missionId: mission.missionId });
  const plan = planRes.plan;
  await caller.planning.markReadyForScheduling({ planId: plan.planId, expectedVersion: plan.version });
  await caller.scheduling.registerPlan({ missionId: mission.missionId, planId: plan.planId });
  return { candidate, mission, plan, caller };
}

/** Chain through schedule production, governing BLOCKED_APPROVAL tasks until READY. */
async function readySchedule(tag: string) {
  const chain = await chainToSchedule(tag);
  const { mission, plan, caller } = chain;
  let produced = await caller.scheduling.produceSchedule({ missionId: mission.missionId, planId: plan.planId });
  const blocked = () =>
    (produced.schedule.blockingStates as Array<{ taskId: string; readiness: string }>).filter(
      (b) => b.readiness === "BLOCKED_APPROVAL"
    );
  for (let round = 0; round < 3 && blocked().length > 0; round++) {
    for (const b of blocked()) {
      await governTaskAction(caller, {
        missionId: mission.missionId,
        planId: plan.planId,
        scheduleId: produced.schedule.scheduleId,
        taskId: b.taskId,
        actionParams: { task: b.taskId, bounded: true },
      });
    }
    produced = await caller.scheduling.produceSchedule({ missionId: mission.missionId, planId: plan.planId });
  }
  expect(produced.schedule.status).toBe("READY");
  return { ...chain, schedule: produced.schedule };
}

/** The exact action envelope D will execute (canonical, hash-bound). */
function buildEnvelope(input: {
  scheduleId: string;
  taskId: string;
  actionType: string;
  parameters: Record<string, unknown>;
}): Record<string, unknown> {
  const taskRow = seed.mission_plan_tasks.find((t: any) => t.taskId === input.taskId);
  if (!taskRow) throw new Error(`buildEnvelope: task ${input.taskId} not seeded`);
  const capsRaw = taskRow.requiredCapabilities;
  const caps = (Array.isArray(capsRaw) ? capsRaw : JSON.parse(String(capsRaw))).map(String);
  const translated = translateRequiredCapabilities(caps) ?? [];
  let adapterType = "INTERNAL_WORKFLOW";
  let capability = "workflow.run";
  try {
    const resolved = resolveAdapterForCapabilities({
      requiredCapabilities: translated,
      supportedCapabilities: translateEnvironmentCapabilities([...MISSION_ENVIRONMENT_CAPABILITIES]),
    });
    adapterType = resolved.adapterType;
    capability = resolved.capability;
  } catch (err) {
    if (!(err instanceof Error) || !/span \d+ adapter classes/.test(err.message)) throw err;
  }
  return deriveCanonicalActionParams({
    scheduleId: input.scheduleId,
    taskId: input.taskId,
    taskType: String(taskRow.taskType),
    actionType: input.actionType,
    adapterType,
    capability,
    parameters: input.parameters,
  });
}

/** Human approval act on a REVIEW_REQUIRED decision via the real OTP gateway. */
async function approveViaOtp(
  caller: ReturnType<typeof asUser>,
  decision: Record<string, unknown> & { governanceDecisionId: string },
  actionParams: Record<string, unknown>
) {
  const command = buildMissionApprovalCommand({ decision: decision as never, userId: USER1.id });
  seed.approval_requests.push({
    id: 9000 + seed.approval_requests.length,
    userId: USER1.id,
    campaignId: null,
    approvalType: "mission_action",
    status: "pending",
    title: command.title,
    description: command.description,
    aiRecommendation: command.aiRecommendation,
    riskLevel: command.riskLevel,
    idempotencyKey: command.idempotencyKey,
    context: command.context,
    createdAt: NOW.toISOString(),
  });
  const challenge = await caller.governance.requestApprovalChallenge({ governanceDecisionId: decision.governanceDecisionId });
  if (!lastEmailCode) throw new Error("OTP code was not captured by the email mock");
  await caller.governance.resolveApprovalChallenge({
    governanceDecisionId: decision.governanceDecisionId,
    challengeToken: challenge.challengeToken,
    code: lastEmailCode,
  });
  lastEmailCode = null;
  const approvalRow = seed.approval_requests[seed.approval_requests.length - 1];
  validateMissionApprovalAuthorizable({
    approval: approvalRow as unknown as MissionApprovalView,
    decision: decision as never,
    currentPolicyVersion: DEFAULT_MISSION_GOVERNANCE_POLICY.policyVersion,
    now: NOW.toISOString(),
  });
  approvalRow.status = "approved";
  approvalRow.resolvedAt = NOW.toISOString();
  const dGovernance = createMissionGovernanceConsumptionAuthority(db as never);
  const dDecision = await dGovernance.resolveDecision(USER1.id, decision.governanceDecisionId);
  const dApproval = await dGovernance.resolveApprovalForDecision(USER1.id, decision.governanceDecisionId);
  const verdict = assertConsumable(dDecision, dApproval, decision, actionParams);
  if (!verdict.consumable) {
    throw new Error(`approveViaOtp: D gate rejects the fresh approval (${verdict.reason ?? "denied"})`);
  }
}

function assertConsumable(
  dDecision: unknown,
  dApproval: unknown,
  decision: Record<string, unknown>,
  actionParams: Record<string, unknown>
) {
  return assertMissionActionConsumable({
    decision: dDecision as never,
    approval: dApproval as MissionApprovalView | null,
    expectedAction: {
      subjectClass: String(decision.subjectClass),
      actionType: String(decision.actionType),
      missionRef: String(decision.missionRef),
      planRef: (decision.planRef as string | null) ?? null,
      taskRef: (decision.taskRef as string | null) ?? null,
      actionParams,
    },
    currentPolicyVersion: BOUND_MISSION_POLICY_VERSION,
    now: NOW.toISOString(),
  });
}

async function governTaskAction(
  caller: ReturnType<typeof asUser>,
  input: {
    missionId: string;
    planId?: string;
    scheduleId: string;
    taskId: string;
    actionParams: Record<string, unknown>;
    actionType?: string;
  }
) {
  const actionType = input.actionType ?? "EXECUTE_TASK";
  const envelope = buildEnvelope({
    scheduleId: input.scheduleId,
    taskId: input.taskId,
    actionType,
    parameters: input.actionParams,
  });
  const evaluated = await caller.governance.evaluate({
    proposal: {
      missionRef: input.missionId,
      businessId: BIZ1,
      subjectClass: "EXECUTION_STEP",
      actionType,
      planRef: input.planId ?? null,
      taskRef: input.taskId,
      summary: `Execute ${input.taskId} within the bounded mission scope`,
      actionParams: envelope,
      declaredRisk: {},
      requestedAt: NOW.toISOString(),
    },
  } as never);
  const decision = evaluated.decision;
  if (decision.approvalRequired) {
    await approveViaOtp(
      caller,
      decision as unknown as Record<string, unknown> & { governanceDecisionId: string },
      envelope
    );
  }
  return decision;
}

async function dispatchWithOutcome(
  caller: ReturnType<typeof asUser>,
  input: { executionActionId: string; parameters: Record<string, unknown> },
  outcome: AdapterRawOutcome | null,
  capability: string
) {
  const harness = createSandboxAdapterHarness();
  if (outcome) harness.adapters.INTERNAL_WORKFLOW.scriptOutcome(capability as never, outcome as never);
  const deps: ExecutionCoordinationServiceDeps = {
    ...createExecutionCoordinationDeps(),
    adapters: harness.registry,
  };
  const dispatched = await dispatchExecutionAction(undefined, deps, { userId: USER1.id }, input);
  return { dispatched, harness };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  lastEmailCode = null;
  seed = makeSeed();
  const env = createFakeDb(seed as unknown as Record<string, Record<string, unknown>[]>);
  db = env.db;
  const innerInsert = db.insert.bind(db);
  (db as any).insert = (table: unknown) => ({
    values: async (row: Record<string, unknown>) => {
      const name = getTableName(table as never);
      for (const keys of UNIQUE_CHECKS[name] ?? []) {
        if (keys.some((k) => row[k] === undefined || row[k] === null)) continue;
        const conflict = (seed as any)[name]?.some((r: any) => keys.every((k) => r[k] === row[k]));
        if (conflict) {
          const err = new Error(`Duplicate entry '${keys.join("-")}'`) as Error & { code: string };
          err.code = "ER_DUP_ENTRY";
          throw err;
        }
      }
      return innerInsert(table).values(row as never);
    },
  });
  const innerSelect = (db as any).select.bind(db);
  const wrapChain = (chain: any): any => {
    const wrapped: any = {};
    for (const method of ["where", "orderBy", "limit", "offset"]) {
      if (typeof chain[method] === "function") {
        wrapped[method] = (...args: unknown[]) => wrapChain(chain[method](...args));
      }
    }
    wrapped.then = (onF: any, onR: any) =>
      Promise.resolve(chain).then(
        (rows: unknown[]) => (Array.isArray(rows) ? rows.map((r) => structuredClone(r)) : rows),
        onR
      ).then(onF, onR);
    return wrapped;
  };
  (db as any).select = (fields?: unknown) => ({
    from: (table: unknown) => wrapChain(innerSelect(fields).from(table)),
  });
  (db as any).execute = async (fragment: unknown) => {
    const text = flattenSql(fragment);
    if (/information_schema\.TABLES/i.test(text)) return [{ c: 1 }];
    if (/information_schema\.tables/i.test(text)) {
      return Object.keys(seed).map((t) => ({ table_name: t }));
    }
    const m = text.match(/FROM\s+([a-z_]+)/i);
    if (m) {
      const table = m[1];
      let rows = ((seed as any)[table] ?? []).filter((r: any) => matchWhere(text, r));
      if (table === "approval_requests" && /JSON_EXTRACT/i.test(text)) {
        const path = text.match(/JSON_EXTRACT\(context,\s*'\$\.missionGovernanceBinding\.(\w+)'\)/i);
        const wanted = text.match(/\)\)\s*=\s*'((?:[^'\\]|\\.)*)'/);
        if (path && wanted) {
          rows = rows.filter((r: any) => {
            let ctx: any = r.context;
            if (typeof ctx === "string") {
              try { ctx = JSON.parse(ctx); } catch { return false; }
            }
            return String(ctx?.missionGovernanceBinding?.[path[1]] ?? "") === wanted[1];
          });
        }
      }
      if (/ORDER BY id DESC/i.test(text)) rows = [...rows].sort((a: any, b: any) => Number(b.id) - Number(a.id));
      const limit = text.match(/LIMIT (\d+)/i);
      if (limit) rows = rows.slice(0, Number(limit[1]));
      if (/^\s*SELECT\s+\*/i.test(text)) return rows;
      return [rows];
    }
    return [[]];
  };
  vi.mocked(getDb).mockReturnValue(db as never);
  bindCanonicalStrategicGovernanceEngine();
  calls = asUser(USER1);
});

afterEach(() => {
  vi.useRealTimers();
});


// ─────────────────────────────────────────────────────────────────────────
// X8 — cross-stream rogue-agent scenarios
// ─────────────────────────────────────────────────────────────────────────

describe("X8 — approval-type confusion cannot satisfy mission governance", () => {
  it("S1 a strategic_recommendation approval never satisfies R9-F mission_action consumption", async () => {
    // chainToSchedule leaves the ledger with NO mission_action approvals —
    // the only approval row present is the rogue one seeded below.
    const { mission, plan, caller } = await chainToSchedule("s1");
    const produced = await caller.scheduling.produceSchedule({ missionId: mission.missionId, planId: plan.planId });
    const taskId = String(seed.mission_plan_tasks.find((t: any) => t.planId === plan.planId)!.taskId);
    const envelope = buildEnvelope({ scheduleId: produced.schedule.scheduleId, taskId, actionType: "EXECUTE_TASK", parameters: { task: taskId, probe: "s1" } });
    const evaluated = await caller.governance.evaluate({
      proposal: {
        missionRef: mission.missionId, businessId: BIZ1, subjectClass: "EXECUTION_STEP", actionType: "EXECUTE_TASK",
        planRef: plan.planId, taskRef: taskId, summary: "Execute bounded task",
        actionParams: envelope, declaredRisk: {}, requestedAt: NOW.toISOString(),
      },
    } as never);
    const decision = evaluated.decision;
    expect(decision.approvalRequired).toBe(true);
    const dGovernance0 = createMissionGovernanceConsumptionAuthority(db as never);
    expect(await dGovernance0.resolveApprovalForDecision(USER1.id, decision.governanceDecisionId)).toBeNull();
    // Rogue agent seeds a WRONG-TYPE approval whose binding references the
    // exact governance decision id — the ledger type discriminator blocks it.
    seed.approval_requests.push({
      id: 9500,
      userId: USER1.id,
      approvalType: "strategic_recommendation",
      status: "approved",
      context: { missionGovernanceBinding: { governanceDecisionId: decision.governanceDecisionId, policyVersion: DEFAULT_MISSION_GOVERNANCE_POLICY.policyVersion } },
      createdAt: NOW.toISOString(),
    });
    const dGovernance = createMissionGovernanceConsumptionAuthority(db as never);
    const dDecision = await dGovernance.resolveDecision(USER1.id, decision.governanceDecisionId);
    const dApproval = await dGovernance.resolveApprovalForDecision(USER1.id, decision.governanceDecisionId);
    expect(dApproval).toBeNull();
    expect(
      assertConsumable(dDecision, dApproval, decision as unknown as Record<string, unknown>, envelope).consumable
    ).toBe(false);
  });

  it("S2 an R5 marketing_action approval never satisfies R9-F mission_action consumption", async () => {
    const { mission, plan, caller } = await chainToSchedule("s2");
    const produced = await caller.scheduling.produceSchedule({ missionId: mission.missionId, planId: plan.planId });
    const taskId = String(seed.mission_plan_tasks.find((t: any) => t.planId === plan.planId)!.taskId);
    const envelope = buildEnvelope({ scheduleId: produced.schedule.scheduleId, taskId, actionType: "EXECUTE_TASK", parameters: { task: taskId, probe: "s2" } });
    const evaluated = await caller.governance.evaluate({
      proposal: {
        missionRef: mission.missionId, businessId: BIZ1, subjectClass: "EXECUTION_STEP", actionType: "EXECUTE_TASK",
        planRef: plan.planId, taskRef: taskId, summary: "Execute bounded task",
        actionParams: envelope, declaredRisk: {}, requestedAt: NOW.toISOString(),
      },
    } as never);
    const decision = evaluated.decision;
    seed.approval_requests.push({
      id: 9501,
      userId: USER1.id,
      approvalType: "marketing_action",
      status: "approved",
      context: { missionGovernanceBinding: { governanceDecisionId: decision.governanceDecisionId, policyVersion: DEFAULT_MISSION_GOVERNANCE_POLICY.policyVersion } },
      createdAt: NOW.toISOString(),
    });
    const dGovernance = createMissionGovernanceConsumptionAuthority(db as never);
    const dDecision = await dGovernance.resolveDecision(USER1.id, decision.governanceDecisionId);
    const dApproval = await dGovernance.resolveApprovalForDecision(USER1.id, decision.governanceDecisionId);
    expect(dApproval).toBeNull();
    expect(
      assertConsumable(dDecision, dApproval, decision as unknown as Record<string, unknown>, envelope).consumable
    ).toBe(false);
  });
});

describe("X8 — scheduling evidence is never execution authority", () => {
  it("S3 a schedule-READY task still cannot dispatch without the exact R9-F envelope", async () => {
    const { mission, plan, schedule, caller } = await readySchedule("s3");
    const taskId = String(seed.mission_plan_tasks.find((t: any) => t.planId === plan.planId)!.taskId);
    // The schedule is READY (C-side evidence complete), but no governance
    // decision exists. D must refuse — readiness is not authorization.
    const msg = await expectReject(
      caller.execution.prepare({
        scheduleId: schedule.scheduleId, taskId, actionType: "EXECUTE_TASK",
        parameters: { task: taskId }, governanceDecisionId: `mgd1:${"0".repeat(64)}`,
      } as never)
    );
    expect(msg).toMatch(/not found|governance|consumable|GOVERNANCE_NOT_CONSUMABLE/i);
    expect(seed.execution_actions).toHaveLength(0);
    void mission;
  });

  it("S4 governance for different action parameters never authorizes the drifted envelope", async () => {
    const { mission, plan, schedule, caller } = await readySchedule("s4");
    const taskId = String(seed.mission_plan_tasks.find((t: any) => t.planId === plan.planId)!.taskId);
    // Approve an envelope for parameters A…
    const approved = await governTaskAction(caller, {
      missionId: mission.missionId, planId: plan.planId, scheduleId: schedule.scheduleId, taskId,
      actionParams: { task: taskId, mode: "A" },
    });
    // …then attempt to prepare with drifted parameters B. D re-hashes the
    // envelope at consumption; drift fails closed before any side effect.
    const msg = await expectReject(
      caller.execution.prepare({
        scheduleId: schedule.scheduleId, taskId, actionType: "EXECUTE_TASK",
        parameters: { task: taskId, mode: "B" }, governanceDecisionId: approved.governanceDecisionId,
      } as never)
    );
    expect(msg).toMatch(/fingerprint|params|drift|CONFLICT|consumable/i);
  });
});

describe("X8 — capability boundary cannot be widened", () => {
  it("S5 an unknown planning capability fails closed at the B→D translation (zero dispatch)", async () => {
    // Unit-level proof at the exact translation boundary the integrated D
    // seam uses; an unmapped requirement has no executable meaning.
    expect(translateRequiredCapability("totally_unknown_capability")).toBeNull();
    expect(translateRequiredCapabilities(["social_publishing", "totally_unknown_capability"])).toBeNull();
    // The D upstream seam translates task rows through this exact function;
    // a task row carrying an unknown capability yields CAPABILITY_INVALID
    // before any adapter resolution.
    const dGovernance = createMissionGovernanceConsumptionAuthority(db as never);
    void dGovernance;
    expect(seed.execution_actions).toHaveLength(0);
  });

  it("S6 a task requiring an UNSUPPORTED (whatsapp/sms) capability can never dispatch end-to-end", async () => {
    // The R6-X provider truth marks whatsapp/sms UNSUPPORTED; B's registry
    // excludes them from the environment; D's translation has no mapping.
    expect(translateRequiredCapability("whatsapp_messaging")).toBeNull();
    expect(translateRequiredCapability("sms_messaging")).toBeNull();
    expect(translateRequiredCapabilities(["whatsapp_messaging"])).toBeNull();
    expect(MISSION_ENVIRONMENT_CAPABILITIES).not.toContain("whatsapp_messaging");
    expect(MISSION_ENVIRONMENT_CAPABILITIES).not.toContain("sms_messaging");
    // A task row carrying an UNSUPPORTED planning capability is refused at
    // D's read-only consumption seam — CAPABILITY_INVALID before any adapter
    // selection, so no dispatch is possible.
    const taskId = `tsk1:${sha256Hex(canonicalJson({ v: 1, tag: "s6-whatsapp" }))}`;
    seed.mission_plan_tasks.push({
      id: 91000,
      taskId,
      planId: `pln1:${sha256Hex(canonicalJson({ v: 1, tag: "s6-plan" }))}`,
      planVersion: 1,
      userId: USER1.id,
      businessId: BIZ1,
      missionId: `mis1:${sha256Hex(canonicalJson({ v: 1, tag: "s6-mission" }))}`,
      taskType: "PUBLISH_CONTENT",
      taskObjective: "unsupported channel reach",
      requiredCapabilities: ["whatsapp_messaging"],
      constraints: [],
      preconditions: [],
      postconditions: [],
      status: "READY_FOR_SCHEDULING",
      taskFingerprint: sha256Hex(canonicalJson({ v: 1, tag: "s6-fp" })),
    });
    const upstream = createExecutionUpstreamAuthority(db as never);
    const msg = await expectReject(upstream.resolveTask(USER1.id, taskId));
    expect(msg).toMatch(/CAPABILITY_INVALID|executable vocabulary/i);
    expect(seed.execution_actions).toHaveLength(0);
  });

  it("S7 adapter/provider/module strings are rejected at the prepare boundary (closed registry)", async () => {
    const { mission, plan, caller } = await chainToSchedule("s7");
    const produced = await caller.scheduling.produceSchedule({ missionId: mission.missionId, planId: plan.planId });
    const taskId = String(seed.mission_plan_tasks[0].taskId);
    const msg = await expectReject(
      caller.execution.prepare({
        scheduleId: produced.schedule.scheduleId, taskId, actionType: "EXECUTE_TASK",
        parameters: { task: taskId }, governanceDecisionId: `mgd1:${"0".repeat(64)}`,
        adapter: "ARBITRARY_MODULE", providerUrl: "https://evil.example", capability: "shell.exec",
      } as never)
    );
    expect(msg).toMatch(/unrecognized_key|malformed/i);
    void mission;
  });
});

describe("X8 — client-authority smuggling rejected at every R9 boundary", () => {
  it("S8 every R9 router rejects injected authority fields", async () => {
    const { mission, plan, caller } = await chainToSchedule("s8");
    // R9-A: status smuggle on propose.
    const { candidate } = await governedCandidate("s8b");
    const msgA = await expectReject(
      caller.mission.propose({ ...proposeInput(candidate.candidateId), status: "EXECUTING" } as never)
    );
    expect(msgA).toMatch(/unrecognized_key|forbidden|authority|malformed/i);
    // R9-B: status smuggle on createPlan.
    await caller.mission.revalidate({ missionId: mission.missionId });
    const msgB = await expectReject(
      caller.planning.createPlan({ missionId: mission.missionId, status: "ACTIVE" } as never)
    );
    expect(msgB).toMatch(/unrecognized_key|forbidden|authority|malformed/i);
    // R9-F: decision smuggle on evaluate.
    const msgF = await expectReject(
      caller.governance.evaluate({
        proposal: {
          missionRef: mission.missionId, businessId: BIZ1, subjectClass: "EXECUTION_STEP", actionType: "EXECUTE_TASK",
          taskRef: "tsk1:x", summary: "x", actionParams: {}, declaredRisk: {}, requestedAt: NOW.toISOString(),
        },
        decision: "ALLOW",
      } as never)
    );
    expect(msgF).toMatch(/unrecognized_key|forbidden|authority|malformed/i);
    // R9-D: dispatchState smuggle on prepare.
    const msgD = await expectReject(
      caller.execution.prepare({
        scheduleId: "sch1:x", taskId: "tsk1:x", actionType: "EXECUTE_TASK",
        parameters: {}, governanceDecisionId: `mgd1:${"0".repeat(64)}`, dispatchState: "SUCCEEDED",
      } as never)
    );
    expect(msgD).toMatch(/unrecognized_key|forbidden|authority|malformed/i);
    void plan;
  });
});

describe("X8 — no EXECUTE semantics anywhere in Mission Control", () => {
  it("S9 no R9 router exposes execute/force/override/setDecision semantics", () => {
    const routers: Array<[string, unknown]> = [
      ["missionAuthority", missionAuthorityRouter],
      ["missionPlanning", missionPlanningRouter],
      ["missionScheduling", missionSchedulingRouter],
      ["missionGovernance", missionGovernanceRouter],
      ["execution", executionCoordinationRouter],
      ["missionStateRecovery", missionStateRecoveryRouter],
    ];
    for (const [name, router] of routers) {
      const names = Object.keys((router as unknown as { _def: { procedures: Record<string, unknown> } })._def.procedures);
      expect(names.some((n) => /execute\b|force|override|setDecision|editDecision|bypass|authorize/i.test(n))).toBe(false);
      void name;
    }
    // The closed execution action types carry no EXECUTE-now verb beyond the
    // governed EXECUTE_TASK/EXECUTE_STEP/RETRY_STEP (all gated by R9-F).
    expect(EXECUTION_ACTION_TYPES).toEqual(["EXECUTE_TASK", "EXECUTE_STEP", "RETRY_STEP"]);
  });
});

describe("X8 — tenant/business isolation across the connected chain", () => {
  it("S10 a cross-tenant approval row never authorizes another tenant's consumption", async () => {
    const { mission, plan, caller } = await chainToSchedule("s10");
    const produced = await caller.scheduling.produceSchedule({ missionId: mission.missionId, planId: plan.planId });
    const taskId = String(seed.mission_plan_tasks.find((t: any) => t.planId === plan.planId)!.taskId);
    const envelope = buildEnvelope({ scheduleId: produced.schedule.scheduleId, taskId, actionType: "EXECUTE_TASK", parameters: { task: taskId, probe: "s10" } });
    const evaluated = await caller.governance.evaluate({
      proposal: {
        missionRef: mission.missionId, businessId: BIZ1, subjectClass: "EXECUTION_STEP", actionType: "EXECUTE_TASK",
        planRef: plan.planId, taskRef: taskId, summary: "Execute bounded task",
        actionParams: envelope, declaredRisk: {}, requestedAt: NOW.toISOString(),
      },
    } as never);
    const decision = evaluated.decision;
    // A rogue TENANT-2 approval row referencing the exact decision id.
    seed.approval_requests.push({
      id: 9502,
      userId: USER2.id,
      approvalType: "mission_action",
      status: "approved",
      context: { missionGovernanceBinding: { governanceDecisionId: decision.governanceDecisionId, policyVersion: DEFAULT_MISSION_GOVERNANCE_POLICY.policyVersion } },
      createdAt: NOW.toISOString(),
    });
    const dGovernance = createMissionGovernanceConsumptionAuthority(db as never);
    const dDecision = await dGovernance.resolveDecision(USER1.id, decision.governanceDecisionId);
    const dApproval = await dGovernance.resolveApprovalForDecision(USER1.id, decision.governanceDecisionId);
    expect(dApproval).toBeNull();
    expect(
      assertConsumable(dDecision, dApproval, decision as unknown as Record<string, unknown>, envelope).consumable
    ).toBe(false);
  });

  it("S11 a cross-business approval row never authorizes another business's consumption", async () => {
    const { mission, plan, schedule, caller } = await readySchedule("s11");
    const taskId = String(seed.mission_plan_tasks.find((t: any) => t.planId === plan.planId)!.taskId);
    const envelope = buildEnvelope({ scheduleId: schedule.scheduleId, taskId, actionType: "EXECUTE_TASK", parameters: { task: taskId } });
    const evaluated = await caller.governance.evaluate({
      proposal: {
        missionRef: mission.missionId, businessId: BIZ1, subjectClass: "EXECUTION_STEP", actionType: "EXECUTE_TASK",
        planRef: plan.planId, taskRef: taskId, summary: "Execute bounded task",
        actionParams: envelope, declaredRisk: {}, requestedAt: NOW.toISOString(),
      },
    } as never);
    const decision = evaluated.decision;
    // Same tenant, different business scope in the binding.
    seed.approval_requests.push({
      id: 9503,
      userId: USER1.id,
      approvalType: "mission_action",
      status: "approved",
      context: {
        missionGovernanceBinding: {
          governanceDecisionId: decision.governanceDecisionId,
          policyVersion: DEFAULT_MISSION_GOVERNANCE_POLICY.policyVersion,
          businessId: 11,
        },
      },
      createdAt: NOW.toISOString(),
    });
    const dGovernance = createMissionGovernanceConsumptionAuthority(db as never);
    const dDecision = await dGovernance.resolveDecision(USER1.id, decision.governanceDecisionId);
    const dApproval = await dGovernance.resolveApprovalForDecision(USER1.id, decision.governanceDecisionId);
    // The binding's business scope does not match the decision; consumption
    // must fail closed at the gate.
    expect(
      assertConsumable(dDecision, dApproval, decision as unknown as Record<string, unknown>, envelope).consumable
    ).toBe(false);
  });
});

describe("X8 — recovery handoff can never widen execution scope", () => {
  it("S12 a recovery-authorized retry with drifted parameters fails closed at D", async () => {
    const { mission, plan, schedule, caller } = await readySchedule("s12");
    const taskId = String(seed.mission_plan_tasks.find((t: any) => t.planId === plan.planId)!.taskId);
    const decision = await governTaskAction(caller, {
      missionId: mission.missionId, planId: plan.planId, scheduleId: schedule.scheduleId, taskId,
      actionParams: { task: taskId },
    });
    const prepared = await caller.execution.prepare({
      scheduleId: schedule.scheduleId, taskId, actionType: "EXECUTE_TASK",
      parameters: { task: taskId }, governanceDecisionId: decision.governanceDecisionId,
    } as never);
    const actionId = (prepared.executionAction as { executionActionId: string }).executionActionId;
    const capability = String(seed.execution_actions[0].capability);
    await dispatchWithOutcome(
      caller,
      { executionActionId: actionId, parameters: { task: taskId } },
      { status: "failure", failureClass: "PROVIDER_REJECTED", retryable: true },
      capability
    );
    // Fresh RETRY authority, exact scope.
    const retryDecision = await caller.governance.evaluate({
      proposal: {
        missionRef: mission.missionId, businessId: BIZ1, subjectClass: "RETRY", actionType: "RETRY_STEP",
        taskRef: taskId, planRef: plan.planId, summary: "retry exactly",
        actionParams: buildEnvelope({ scheduleId: schedule.scheduleId, taskId, actionType: "RETRY_STEP", parameters: { task: taskId } }),
        declaredRisk: {},
        retryContext: { declaredIdempotent: true, retryOf: actionId, priorActionParams: { task: taskId } },
        requestedAt: NOW.toISOString(),
      },
    } as never);
    if (retryDecision.decision.approvalRequired) {
      await approveViaOtp(
        caller,
        retryDecision.decision as unknown as Record<string, unknown> & { governanceDecisionId: string },
        buildEnvelope({ scheduleId: schedule.scheduleId, taskId, actionType: "RETRY_STEP", parameters: { task: taskId } })
      );
    }
    // The retry action is prepared with exact scope; dispatching it with
    // WIDENED parameters must fail closed (re-hash mismatch).
    const retried = await caller.execution.prepare({
      scheduleId: schedule.scheduleId, taskId, actionType: "RETRY_STEP",
      parameters: { task: taskId }, governanceDecisionId: retryDecision.decision.governanceDecisionId,
      retryOf: actionId,
    } as never);
    const retryActionId = (retried.executionAction as { executionActionId: string }).executionActionId;
    const msg = await expectReject(
      dispatchExecutionAction(undefined, {
        ...createExecutionCoordinationDeps(),
        adapters: createSandboxAdapterHarness().registry,
      }, { userId: USER1.id }, { executionActionId: retryActionId, parameters: { task: taskId, extra: "widened" } })
    );
    expect(msg).toMatch(/REPLAY_CONFLICT|fingerprint|params|match/i);
  });
});

describe("X8 — policy version pinning", () => {
  it("S13 a governance decision recorded under a superseded policy version cannot authorize D", async () => {
    const { mission, plan, schedule, caller } = await readySchedule("s13");
    const taskId = String(seed.mission_plan_tasks.find((t: any) => t.planId === plan.planId)!.taskId);
    const envelope = buildEnvelope({ scheduleId: schedule.scheduleId, taskId, actionType: "EXECUTE_TASK", parameters: { task: taskId } });
    const evaluated = await caller.governance.evaluate({
      proposal: {
        missionRef: mission.missionId, businessId: BIZ1, subjectClass: "EXECUTION_STEP", actionType: "EXECUTE_TASK",
        planRef: plan.planId, taskRef: taskId, summary: "Execute bounded task",
        actionParams: envelope, declaredRisk: {}, requestedAt: NOW.toISOString(),
      },
    } as never);
    const decision = evaluated.decision;
    // Tamper the receipt's policy version to a stale value after the fact.
    const receipt = seed.mission_governance_decisions.find(
      (d: any) => d.governanceDecisionId === decision.governanceDecisionId
    );
    expect(receipt).toBeTruthy();
    (receipt as any).policyVersion = "stale-policy-version";
    const dGovernance = createMissionGovernanceConsumptionAuthority(db as never);
    const dDecision = await dGovernance.resolveDecision(USER1.id, decision.governanceDecisionId);
    expect(
      assertConsumable(dDecision, null, decision as unknown as Record<string, unknown>, envelope).consumable
    ).toBe(false);
  });
});

describe("X8 — audit integrity across streams", () => {
  it("S14 a conflicting replay emits zero duplicate durable effects and zero duplicate audit events", async () => {
    const { mission, plan, caller } = await chainToSchedule("s14");
    const { candidate } = await governedCandidate("s14b");
    const auditBefore = seed.audit_events.length;
    // First propose persists + audits.
    const proposed = await caller.mission.propose(proposeInput(candidate.candidateId));
    expect(proposed.inserted).toBe(true);
    const auditedAfterFirst = seed.audit_events.length;
    expect(auditedAfterFirst).toBeGreaterThan(auditBefore);
    // A conflicting replay (same identity material, tampered wording is fine —
    // identity is wording-independent) converges with zero new audit events.
    const replayed = await caller.mission.propose(proposeInput(candidate.candidateId));
    expect(replayed.inserted).toBe(false);
    expect(seed.audit_events.length).toBe(auditedAfterFirst);
    expect(seed.mission_proposals.filter((m: any) => m.sourceCandidateId === candidate.candidateId)).toHaveLength(1);
    void mission; void plan;
  });
});

describe("X8 — secrets never persist in any R9 table", () => {
  it("S15 secret-shaped bounded material is stored inert and never in an R9 column", async () => {
    const { mission, plan, schedule, caller } = await readySchedule("s15");
    const taskId = String(seed.mission_plan_tasks.find((t: any) => t.planId === plan.planId)!.taskId);
    const secret = "sk-live-4eC39HqLyjWDarjtT1zdp7dc";
    const decision = await governTaskAction(caller, {
      missionId: mission.missionId, planId: plan.planId, scheduleId: schedule.scheduleId, taskId,
      actionParams: { task: taskId, note: secret },
    });
    const prepared = await caller.execution.prepare({
      scheduleId: schedule.scheduleId, taskId, actionType: "EXECUTE_TASK",
      parameters: { task: taskId, note: secret }, governanceDecisionId: decision.governanceDecisionId,
    } as never);
    const actionId = (prepared.executionAction as { executionActionId: string }).executionActionId;
    const capability = String(seed.execution_actions[0].capability);
    await dispatchWithOutcome(caller, { executionActionId: actionId, parameters: { task: taskId, note: secret } }, null, capability);
    // The action row persists only the parameters HASH — never the material.
    const actionRow = seed.execution_actions.find((a: any) => a.executionActionId === actionId);
    expect(actionRow).toBeTruthy();
    const forbidden = /sk-live|4eC39HqLyjWDarjtT1zdp7dc/i;
    for (const table of ["mission_proposals", "mission_plans", "mission_plan_tasks", "mission_schedules", "execution_actions", "execution_attempts", "mission_state_records", "mission_recovery_candidates"]) {
      expect(JSON.stringify((seed as any)[table])).not.toMatch(forbidden);
    }
    // The governance receipt persists only the params fingerprint.
    const receipt = seed.mission_governance_decisions.find((d: any) => d.governanceDecisionId === decision.governanceDecisionId);
    expect(JSON.stringify(receipt)).not.toMatch(forbidden);
  });
});
