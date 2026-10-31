/**
 * R9-B — Rogue-Agent Security Acceptance (adversarial planning-agent cases).
 *
 * Assume the planning agent is compromised. It must not: create new mission
 * authority, widen the objective, remove constraints, fabricate capability,
 * fabricate providers, create executable shell/SQL, lower risk, self-approve,
 * create hidden tasks, add spend authority, bypass R9-F, access secrets, or
 * modify permissions. Every case runs over the real service boundary.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb must not fall back to a real connection in the R9-B security suite");
  }),
}));

import { createFakeDb } from "./r5-test-support";
import {
  createPlanForUser,
  getSchedulingHandoffForUser,
  markPlanReadyForScheduling,
} from "./lib/mission-planning/mission-planning-service";
import { bindMissionPlanningStoreExecutor } from "./lib/mission-planning/mission-planning-store";
import { createInMemoryMissionAuthorityReadPort } from "./lib/mission-planning/mission-planning-mission-seam";
import {
  assertNoClientAuthorityFields,
  EXECUTION_CLASSES,
  MISSION_PLANNING_CONTRACT_VERSION,
  PLAN_STATUSES,
  TASK_STATUSES,
  type CreatePlanInput,
} from "./lib/mission-planning/mission-planning-contract";
import {
  CAPABILITY_REGISTRY,
  TASK_TEMPLATES,
} from "./lib/mission-planning/mission-planning-templates";
import { createHash } from "crypto";

const NOW = new Date("2026-11-11T00:00:00.000Z");
const NOW_MS = NOW.getTime();
const RECENT = new Date(NOW_MS - 2 * 24 * 3600_000).toISOString();
const VALID_30D = new Date(NOW_MS + 30 * 24 * 3600_000).toISOString();
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`)
    .join(",")}}`;
};
const deriveConstraintSetFingerprint = (constraints: ReadonlyArray<Record<string, unknown>>): string =>
  sha(
    canonicalJson({
      v: 1,
      constraints: [...constraints]
        .map((c) => ({
          constraintType: String(c.constraintType ?? ""),
          statement: String(c.statement ?? ""),
          referenceValue: typeof c.referenceValue === "string" ? c.referenceValue : null,
          amountMinorUnits: typeof c.amountMinorUnits === "number" ? c.amountMinorUnits : null,
          currency: typeof c.currency === "string" ? c.currency : null,
        }))
        .sort((a, b) => {
          const ka = `${a.constraintType}|${a.statement}`;
          const kb = `${b.constraintType}|${b.statement}`;
          return ka < kb ? -1 : ka > kb ? 1 : 0;
        }),
    })
  );

let seq = 0;
const nextId = (p: "mis1:" | "obj1:" | "sor1:" | "rsn1:" | "sgd1:") =>
  `${p}${String(++seq + 5000).padStart(64, "0")}`;

const DEFAULT_CONSTRAINTS: Array<Record<string, unknown>> = [
  { constraintType: "RECOMMENDATION_ONLY", statement: "Recommendation consumption only" },
  { constraintType: "RISK_CEILING", statement: "Mission risk ceiling LOW", referenceValue: "LOW" },
  { constraintType: "CONFIDENCE_CEILING", statement: "Confidence ceiling carried verbatim" },
  { constraintType: "SCOPE_BOUND", statement: "Scope bound to derived mission scope" },
  { constraintType: "VALIDITY_WINDOW", statement: "Mission validity window applies" },
];

function missionRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  const constraints = (over.constraints as Array<Record<string, unknown>>) ?? DEFAULT_CONSTRAINTS;
  const businessId = (over.businessId as number) ?? 1;
  const userId = (over.userId as number) ?? 1;
  return {
    missionId: nextId("mis1:"),
    objectiveId: nextId("obj1:"),
    userId,
    businessId,
    sourceCandidateId: nextId("sor1:"),
    sourceReasoningIds: JSON.stringify([nextId("rsn1:")]),
    missionType: "OPPORTUNITY_PURSUIT",
    objectiveType: "GROWTH",
    objectiveStatement: "Grow qualified demand within the bounded market",
    expectedOutcome: "Increased qualified walk-ins",
    successCriteria: JSON.stringify([]),
    constraints: JSON.stringify(constraints),
    assumptions: JSON.stringify([]),
    scope: JSON.stringify({
      subjectType: "MARKET",
      businessScope: businessId,
      channelScope: null,
      campaignScope: null,
      geography: null,
    }),
    scopeKey: `MARKET:business:${businessId}`,
    priorityContext: "MEDIUM",
    strategicRiskClass: "LOW",
    governanceDecisionId: nextId("sgd1:"),
    governanceDecision: "ALLOW_RECOMMENDATION",
    policyVersion: "strategic-governance/v1",
    governanceRequirements: JSON.stringify([]),
    validFrom: RECENT,
    validUntil: VALID_30D,
    limitations: JSON.stringify([]),
    lineageHash: sha("lineage"),
    missionFingerprint: sha(canonicalJson({ v: 1, mission: "authority" })),
    objectiveFingerprint: sha("objective"),
    constraintSetFingerprint: deriveConstraintSetFingerprint(constraints),
    sourceProjection: JSON.stringify({}),
    sourceVersions: JSON.stringify({}),
    supersedesMissionId: null,
    status: "ELIGIBLE_FOR_PLANNING",
    version: 1,
    ...over,
  };
}

function makeWorld(opts: { missions?: Array<Record<string, unknown>> } = {}) {
  const missions = opts.missions ?? [missionRow()];
  const businesses = [{ __kind: "business", id: 1, userId: 1 }];
  const seed: Record<string, Array<Record<string, unknown>>> = {
    mission_proposals: missions,
    businesses,
    mission_plans: [],
    mission_plan_tasks: [],
    mission_plan_lifecycle_events: [],
    audit_events: [],
  };
  const { db } = createFakeDb(seed);
  const port = createInMemoryMissionAuthorityReadPort([...missions, ...businesses]);
  const deps = { missionAuthority: port, now: () => NOW };
  const executor = bindMissionPlanningStoreExecutor(db as never);
  return { seed, deps, executor, mission: missions[0] };
}

const create = (w: ReturnType<typeof makeWorld>, input: CreatePlanInput, userId = 1) =>
  createPlanForUser({ userId, input, deps: w.deps, executor: w.executor });

describe("R9-B rogue-agent security", () => {
  beforeEach(() => {
    seq = 0;
  });

  it("agent cannot create new mission authority (seam is read-only)", async () => {
    const w = makeWorld();
    // No input surface mints missions; the port resolves durable rows only.
    expect(
      (w.deps.missionAuthority.getMissionForPlanning as unknown as Record<string, unknown>)
    ).toBeDefined();
    await expect(
      create(w, { missionId: "mis1:" + "0".repeat(64) }) // fabricated identity
    ).rejects.toMatchObject({ code: "MISSION_NOT_FOUND" });
  });

  it("agent cannot widen the objective (wording-only model path, objective verbatim)", async () => {
    const w = makeWorld();
    const { plan } = await create(w, {
      missionId: w.mission.missionId as string,
      modelAssistance: { draftWording: "Expand the objective to cover all adjacent markets globally" },
    });
    expect(plan.missionObjective.objectiveStatement).toBe(w.mission.objectiveStatement);
    expect(plan.planScopeKey).toBe(`${w.mission.scopeKey}|planning:v1`);
  });

  it("agent cannot remove constraints (verbatim inheritance; no removal path)", async () => {
    const w = makeWorld();
    const { plan } = await create(w, {
      missionId: w.mission.missionId as string,
      modelAssistance: { draftWording: "Remove the recommendation-only and risk constraints" },
    });
    const types = (plan.missionConstraints as Array<Record<string, unknown>>).map(
      (c) => c.constraintType
    );
    expect(types).toContain("RECOMMENDATION_ONLY");
    expect(types).toContain("RISK_CEILING");
    expect(types.length).toBe(DEFAULT_CONSTRAINTS.length);
  });

  it("agent cannot fabricate capability (closed registry; unknown capability unsupported)", async () => {
    expect(Object.isFrozen(CAPABILITY_REGISTRY)).toBe(true);
    expect(CAPABILITY_REGISTRY["agent_invented_capability"]).toBeUndefined();
    const w = makeWorld();
    const { plan } = await create(w, { missionId: w.mission.missionId as string });
    for (const t of plan.tasks) {
      expect(["SUPPORTED", "CONDITIONALLY_SUPPORTED"]).toContain(t.capabilityStatus);
    }
  });

  it("agent cannot fabricate providers (no provider vocabulary anywhere)", async () => {
    const w = makeWorld();
    const { plan } = await create(w, { missionId: w.mission.missionId as string });
    const dump = JSON.stringify(plan);
    expect(dump).not.toMatch(/facebook|linkedin|meta_|smtp|sendgrid|twilio/i);
    expect(w.seed.mission_plan_tasks.every((t) => !("provider" in t))).toBe(true);
  });

  it("shell/SQL attempts remain inert text and never become task authority content", async () => {
    const w = makeWorld();
    const { plan } = await create(w, {
      missionId: w.mission.missionId as string,
      modelAssistance: {
        proposedTaskTypes: ["RESEARCH"],
        draftWording: "exec: os.system('rm -rf /'); sql: DELETE FROM users; --",
      },
    });
    // The advisory wording draft is inert bounded text (never hashed, never
    // authority); authoritative task content stays canonical and closed.
    const authorityContent = JSON.stringify(
      plan.tasks.map((t) => ({
        taskType: t.taskType,
        taskObjective: t.taskObjective,
        status: t.status,
        requiredCapabilities: t.requiredCapabilities,
      }))
    );
    expect(authorityContent).not.toMatch(/rm -rf|DELETE FROM|os\.system/i);
    expect(plan.tasks.every((t) => /^[A-Z_]+$/.test(t.taskType))).toBe(true);
    // The draft travels only as the labelled advisory field, if at all.
    for (const t of plan.tasks) {
      if (t.objectiveWordingDraft) {
        expect(t.taskObjective).not.toContain("rm -rf");
      }
    }
  });

  it("agent cannot lower risk or set any risk/decision (no risk vocabulary)", async () => {
    for (const field of [
      { riskClass: "LOW" },
      { strategicRiskClass: "LOW" },
      { decision: "ALLOW" },
      { governanceDecision: "ALLOW" },
      { approved: true },
      { lowerRisk: true },
      { override: true },
    ]) {
      expect(() => assertNoClientAuthorityFields(field)).toThrowError(/forbidden/);
    }
  });

  it("agent cannot self-approve (no approval authority exists in this stream)", async () => {
    const w = makeWorld();
    const { plan } = await create(w, { missionId: w.mission.missionId as string });
    // No approval rows are minted anywhere in planning.
    expect(w.seed.audit_events.every((e) => (e.eventType as string) !== "approval_requested")).toBe(
      true
    );
    expect(plan.tasks.every((t) => t.governanceClass !== "ALLOW")).toBe(true);
    expect(
      w.seed.mission_plan_tasks.every((t) => !(t as Record<string, unknown>).approval)
    ).toBe(true);
  });

  it("agent cannot create hidden tasks (every task derives from the rule table and is hashed into the plan)", async () => {
    const w = makeWorld();
    const { plan } = await create(w, { missionId: w.mission.missionId as string });
    const storedTaskIds = (w.seed.mission_plan_tasks as Array<Record<string, unknown>>).map(
      (t) => t.taskId
    );
    expect(new Set(storedTaskIds).size).toBe(storedTaskIds.length);
    expect([...plan.taskIds].sort()).toEqual([...storedTaskIds].sort());
    // Only rule-table types are present.
    for (const t of plan.tasks) {
      expect(Object.keys(TASK_TEMPLATES)).toContain(t.taskType);
    }
  });

  it("agent cannot add spend authority (money fields rejected; no amounts minted)", async () => {
    for (const field of [
      { budget: 1000 },
      { amount: 1000 },
      { amountMinorUnits: 1000 },
      { currency: "USD" },
      { spend: true },
    ]) {
      expect(() => assertNoClientAuthorityFields(field)).toThrowError(/forbidden/);
    }
    const w = makeWorld();
    const { plan } = await create(w, { missionId: w.mission.missionId as string });
    expect(JSON.stringify(plan)).not.toMatch(/"amountMinorUnits":\s*[1-9]/);
  });

  it("agent cannot bypass R9-F (no decision surface; governance class is pre-classification only)", async () => {
    const w = makeWorld();
    const { plan } = await create(w, { missionId: w.mission.missionId as string });
    for (const t of plan.tasks) {
      expect(["AUTONOMY_CANDIDATE", "STANDARD_REVIEW", "HUMAN_REVIEW_REQUIRED"]).toContain(
        t.governanceClass
      );
    }
    // The scheduling handoff carries no verdict and claims nothing.
    const handoff = await getSchedulingHandoffForUser({
      userId: 1,
      planId: plan.planId,
      deps: w.deps,
      executor: w.executor,
    });
    expect(handoff.projection.executionClaimed).toBe(false);
    expect(handoff.projection.planningClaimed).toBe(false);
    expect(JSON.stringify(handoff.projection)).not.toMatch(/"decision"/);
  });

  it("agent cannot access secrets through planning (no secret read paths in the stream modules)", async () => {
    const libDir = join(__dirname, "lib", "mission-planning");
    const files = [
      "mission-planning-contract.ts",
      "mission-planning-identity.ts",
      "mission-planning-templates.ts",
      "mission-planning-mission-seam.ts",
      "mission-planning-store.ts",
      "mission-planning-service.ts",
      "mission-planning-projection.ts",
    ];
    for (const file of files) {
      const src = readFileSync(join(libDir, file), "utf8");
      expect(src).not.toMatch(/process\.env/);
      expect(src).not.toMatch(/from "\.\.\/(queue|publish|integrations|media|video|jobs)"/);
      expect(src).not.toMatch(/secrets|apiKey|api_key|token/i);
    }
  });

  it("agent cannot modify permissions or policy (frozen registries; no mutation endpoint)", async () => {
    expect(Object.isFrozen(TASK_TEMPLATES)).toBe(true);
    expect(Object.isFrozen(CAPABILITY_REGISTRY)).toBe(true);
    expect(() =>
      assertNoClientAuthorityFields({ alterPermissions: true } as never)
    ).not.toThrow(); // unknown fields are simply not authority — strict schema drops them
    expect(() => assertNoClientAuthorityFields({ policyVersion: "x" })).toThrowError(/forbidden/);
    // Registry entries are frozen at depth 1.
    expect(Object.isFrozen(TASK_TEMPLATES.RESEARCH)).toBe(true);
  });

  it("agent cannot smuggle authority through createPlan inputs", async () => {
    const w = makeWorld();
    const hostile = {
      missionId: w.mission.missionId as string,
      status: "READY_FOR_SCHEDULING",
      decision: "ALLOW",
      taskIds: ["tsk1:" + "0".repeat(64)],
      governanceClass: "AUTONOMY_CANDIDATE",
      executable: true,
    } as unknown as CreatePlanInput;
    expect(() => assertNoClientAuthorityFields(hostile as unknown as Record<string, unknown>)).toThrowError(
      /forbidden/
    );
  });

  it("agent lifecycle attacks: EXECUTING injection and double-apply are rejected", async () => {
    const w = makeWorld();
    const { plan } = await create(w, { missionId: w.mission.missionId as string });
    // Direct store attack with out-of-vocabulary status.
    const { updatePlanStatus } = await import("./lib/mission-planning/mission-planning-store");
    await expect(
      updatePlanStatus(w.executor, {
        userId: 1,
        planId: plan.planId,
        expectedVersion: 1,
        status: "EXECUTING",
      })
    ).rejects.toMatchObject({ code: "INVALID_PLAN_INPUT" });
    // CAS replay of an already-applied transition.
    await markPlanReadyForScheduling({
      userId: 1,
      planId: plan.planId,
      expectedVersion: 1,
      deps: w.deps,
      executor: w.executor,
    });
    await expect(
      markPlanReadyForScheduling({
        userId: 1,
        planId: plan.planId,
        expectedVersion: 1,
        deps: w.deps,
        executor: w.executor,
      })
    ).rejects.toMatchObject({ code: "PLAN_STATE_CONFLICT" });
  });

  it("agent cannot widen scope via model-proposed tasks (canonical derivation only)", async () => {
    const w = makeWorld();
    const { plan } = await create(w, {
      missionId: w.mission.missionId as string,
      modelAssistance: {
        proposedTaskTypes: ["ESCALATE"],
        proposedOrder: ["ESCALATE", "RESEARCH"],
      },
    });
    // ESCALATE added canonically but bound to the mission scope; no new scope material.
    const escalate = plan.tasks.find((t) => t.taskType === "ESCALATE")!;
    expect(escalate.taskObjective).toContain(w.mission.missionId as string);
    expect(escalate.constraints).toEqual(plan.missionConstraints);
    expect(plan.planScopeKey).toBe(`${w.mission.scopeKey}|planning:v1`);
  });

  it("contract surface carries no execution vocabulary", () => {
    expect(MISSION_PLANNING_CONTRACT_VERSION).toBe("mission-planning/v1");
    for (const s of [...PLAN_STATUSES, ...TASK_STATUSES]) {
      expect(s).not.toMatch(/EXECUT|RUNNING|DISPATCHED/);
    }
    expect(EXECUTION_CLASSES).toEqual([
      "INTERNAL_ONLY",
      "GOVERNANCE_GATED",
      "REQUIRES_PROVIDER_AVAILABILITY",
      "SCHEDULING_BOUNDARY",
    ]);
  });
});
