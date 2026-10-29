/**
 * R7-X X6 — Experimentation Integration acceptance.
 *
 * Proves the connected experimentation lifecycle over the REAL integrated
 * authorities (canonical ports over seeded canonical rows):
 *
 *   R7-C learning → experiment design → R7-F governance → deterministic
 *   assignment → R7-A/R7-B-sourced outcome evidence → deterministic
 *   experiment result → durable result record.
 *
 * Verified: governance blocks without approval (no self-approve), bound human
 * approval enables the exact experiment, assignments are deterministic and
 * stable (client cannot supply an arm), evidence is sourced from A/B only and
 * binds exactly once (duplicates do not inflate), superseded attribution is
 * rejected as stale, reversed outcomes flow conservatively, and analysis is
 * honest under insufficient evidence with replay convergence.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb must not fall back to a real connection in R7-X integration tests");
  }),
}));

import { getDb } from "./queries/connection";
import { createFakeDb } from "./r5-test-support";
import { deriveOutcomeEvidenceHash } from "./lib/outcome/outcome-identity";
import { deriveAttributionKey, deriveRecordHash as deriveAttributionRecordHash, toAttributionId } from "./lib/attribution/attribution-identity";

const H = (c: string) => c.repeat(64);
// Anchor to the real clock: the F engine and C projection evaluate at wall
// time, so fixed-past timestamps would expire decisions/learning.
const NOW_MS = Date.now();
const T0 = new Date(NOW_MS).toISOString();
const T0_PLUS_6H = new Date(NOW_MS + 6 * 3600_000).toISOString();
const T0_PLUS_6H_1M = new Date(NOW_MS + 6 * 3600_000 + 60_000).toISOString();
const LATE = new Date(NOW_MS + 10 * 24 * 3600_000).toISOString();

function outcomeHashFor(row: Record<string, unknown>): string {
  return deriveOutcomeEvidenceHash({
    userId: row.userId as number,
    businessId: row.businessId as number,
    leadId: (row.leadId as number | null) ?? null,
    leadIdentityVersion: (row.leadIdentityVersion as string | null) ?? null,
    conversionId: row.conversionId as string,
    outcomeType: row.outcomeType as string,
    valueType: row.valueType as string,
    amountMinor: (row.amountMinor as number | null) ?? null,
    currency: (row.currency as string | null) ?? null,
    quantity: (row.quantity as number | null) ?? null,
    metricUnit: (row.metricUnit as string | null) ?? null,
    evidenceSource: row.evidenceSource as string,
    evidenceAuthority: row.evidenceAuthority as string,
    evidenceIdentity: row.evidenceIdentity as string,
    occurredAt: row.occurredAt as string,
    recordedAt: row.recordedAt as string,
    reversesOutcomeId: (row.reversesOutcomeId as string | null) ?? null,
    renewsOutcomeId: (row.renewsOutcomeId as string | null) ?? null,
    supersedesOutcomeId: (row.supersedesOutcomeId as string | null) ?? null,
  });
}

function makeOutcomeRow(overrides: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id: 1,
    outcomeId: `out1:${H("b")}`,
    userId: 1,
    businessId: 10,
    leadId: null,
    leadIdentityVersion: null,
    conversionId: `cnv1:${H("c")}`,
    outcomeType: "PURCHASE",
    outcomeStatus: "VERIFIED",
    valueType: "MONETARY",
    amountMinor: 50000,
    currency: "USD",
    quantity: null,
    metricUnit: null,
    evidenceSource: "payment_processor",
    evidenceAuthority: "VERIFIED_PAYMENT",
    evidenceIdentity: "inv-a",
    occurredAt: T0_PLUS_6H,
    recordedAt: T0_PLUS_6H_1M,
    reversesOutcomeId: null,
    renewsOutcomeId: null,
    supersedesOutcomeId: null,
    version: 1,
    createdAt: T0_PLUS_6H_1M,
    ...overrides,
  };
  row.evidenceHash = outcomeHashFor(row);
  return row;
}

function makeAttributionRow(outcome: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  const material: Record<string, unknown> = {
    attributionKey: H("k"),
    attributionId: "",
    userId: 1,
    businessId: 10,
    outcomeId: outcome.outcomeId,
    leadId: outcome.leadId,
    leadIdentityVersion: outcome.leadIdentityVersion,
    conversionId: outcome.conversionId,
    outcomeType: outcome.outcomeType,
    outcomeStatus: outcome.outcomeStatus,
    outcomeAmountMinor: outcome.amountMinor,
    outcomeCurrency: outcome.currency,
    modelType: "LAST_TOUCH",
    modelVersion: "attribution-last-touch/v1",
    windowStart: "2026-11-01T00:00:00.000Z",
    windowEnd: "2026-11-10T06:00:00.000Z",
    journeyHash: H("j"),
    touchpoints: [],
    excludedTouchpoints: [],
    totalCreditBps: 0,
    confidenceClass: "NONE",
    evidenceClass: "INSUFFICIENT_EVIDENCE",
    policyVersion: "attribution-policy/v1",
    sourceVersions: {},
    supersedesAttributionId: null,
    calculatedAt: "2026-11-10T07:00:00.000Z",
    ...overrides,
  };
  const key = deriveAttributionKey({
    tenantUserId: 1,
    businessId: 10,
    outcomeId: outcome.outcomeId as string,
    modelType: "LAST_TOUCH",
    modelVersion: "attribution-last-touch/v1",
    windowStart: "2026-11-01T00:00:00.000Z",
    windowEnd: "2026-11-10T06:00:00.000Z",
    journeyHash: H("j"),
    totalCreditBps: material.totalCreditBps as number,
    confidenceClass: material.confidenceClass as string,
    evidenceClass: material.evidenceClass as string,
    outcomeStatus: outcome.outcomeStatus as string,
    policyVersion: "attribution-policy/v1",
  });
  material.attributionKey = key;
  material.attributionId = toAttributionId(key);
  material.recordHash = deriveAttributionRecordHash(material as never);
  return material;
}

function seedEnv() {
  const env = createFakeDb({
    businesses: [{ id: 10, userId: 1, isActive: true }],
    campaigns: [{ id: 500, userId: 1, businessId: 10, budget: 1000 }],
    business_outcomes: [],
    business_outcome_lifecycle_events: [],
    attribution_results: [],
    business_learning_records: [],
    business_learning_lifecycle_events: [],
    experiments: [],
    experiment_lifecycle_events: [],
    experiment_assignments: [],
    experiment_outcome_evidence: [],
    experiment_results: [],
    optimisation_governance_decisions: [],
    approval_requests: [],
    audit_events: [],
  });
  (env.db.execute as ReturnType<typeof vi.fn>).mockImplementation((q: unknown) => {
    const chunks = JSON.stringify((q as { queryChunks?: unknown }).queryChunks ?? q ?? "");
    if (chunks.includes("COUNT(*) AS c FROM information_schema")) return Promise.resolve([{ c: 1 }]);
    if (chunks.includes("table_name FROM information_schema")) {
      return Promise.resolve([{ table_name: "optimisation_governance_decisions" }]);
    }
    if (chunks.includes("FROM approval_requests")) {
      return Promise.resolve(
        (env.seed.approval_requests ?? []).map((r) => ({
          id: r.id,
          userId: r.userId,
          status: r.status,
          context: r.context,
        }))
      );
    }
    return Promise.resolve([]);
  });
  (getDb as unknown as ReturnType<typeof vi.fn>).mockReturnValue(env.db);
  return env;
}

async function deriveLearning(env: ReturnType<typeof seedEnv>) {
  const { createUpstreamPorts } = await import("./lib/business-learning/business-learning-upstream-seam");
  const { deriveBusinessLearning } = await import("./lib/business-learning/business-learning-service");
  const outcome = makeOutcomeRow();
  const attribution = makeAttributionRow(outcome, {
    touchpoints: [
      {
        touchpointId: `tpp:campaign:${H("5").slice(0, 24)}`,
        type: "CAMPAIGN",
        sourceIdentity: "500",
        businessId: 10,
        occurredAt: "2026-11-05T09:00:00.000Z",
        provenance: { path: "opportunity.campaignId", references: {}, sourceRowHash: H("7") },
        eligibility: "eligible",
        creditBps: 100000,
      },
    ],
    totalCreditBps: 100000,
    confidenceClass: "HIGH",
    evidenceClass: "DIRECT_LINKAGE",
  });
  env.seed.business_outcomes.push(outcome);
  env.seed.attribution_results.push(attribution);
  const ports = createUpstreamPorts(env.db as never);
  const derived = await deriveBusinessLearning(
    1,
    { outcomeIds: [outcome.outcomeId], attributionIds: [attribution.attributionId] },
    { ports, now: new Date(T0) }
  );
  return { learningId: derived.results[0].learning.learningId as string };
}

function design() {
  return {
    designType: "A_B",
    dimension: "channel",
    controlDefinition: { label: "control", descriptor: { kind: "control" } },
    treatmentDefinitions: [{ label: "treatment", descriptor: { kind: "treatment" } }],
    allocationPolicy: { fractionsBps: [5000, 5000] },
    primaryMetric: { metric: "CONVERSION_COUNT_PER_SUBJECT", direction: "HIGHER_IS_BETTER" },
    secondaryMetrics: [],
    guardrails: [],
    minimumSamplePerArm: 1,
    durationDays: 7,
  };
}

/** Mint a human approval bound to the exact decision in the fake ledger. */
function mintApproval(env: ReturnType<typeof seedEnv>, decision: { governanceDecisionId: string; policyVersion: string | null; proposalFingerprint: string; approvalBinding: { approvalBindingHash: string; expiresAt: string } | null }) {
  env.seed.approval_requests.push({
    id: (env.seed.approval_requests?.length ?? 0) + 1,
    userId: 1,
    approvalType: "optimisation_action",
    status: "approved",
    context: {
      optimisationGovernanceBinding: {
        governanceDecisionId: decision.governanceDecisionId,
        policyVersion: decision.policyVersion,
        proposalFingerprint: decision.proposalFingerprint,
        approvalBindingHash: decision.approvalBinding!.approvalBindingHash,
        expiresAt: decision.approvalBinding!.expiresAt,
      },
    },
  });
}

describe("R7-X X6: experimentation integration (real C → D → F → A/B)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("learning → design → governance: create, submit, REVIEW_REQUIRED blocks self-approval", async () => {
    const env = seedEnv();
    const { learningId } = await deriveLearning(env);
    const { createUpstreamPorts } = await import("./lib/experimentation/experimentation-seams");
    const D = await import("./lib/experimentation/experimentation-service");
    const ports = createUpstreamPorts(env.db as never);
    const deps = { ports, executor: env.db as never, now: new Date(T0) };

    const created = await D.createExperiment(
      1,
      { learningId, statement: "Treatment raises conversion", design: design() },
      deps
    );
    expect(created.experiment.status).toBe("DRAFT");
    const experimentId = created.experiment.experimentId;

    const submitted = await D.submitGovernance(1, { experimentId }, deps);
    expect(submitted.experiment.status).toBe("APPROVAL_REQUIRED");
    expect(submitted.experiment.governanceDecisionId).toMatch(/^ogd1:[a-f0-9]{64}$/);

    // REVIEW_REQUIRED cannot self-approve: activation without a human approval
    // is denied by the canonical R7-F gate.
    await expect(D.activateExperiment(1, { experimentId }, deps)).rejects.toThrow(
      /Activation approval gate denied|Activation gate denied|governance/i
    );
    const row = env.seed.experiments.find((e) => e.experimentId === experimentId);
    expect(row!.status).toBe("APPROVAL_REQUIRED");
  });

  it("bound human approval enables the exact experiment; assignments stable; fabricated arm rejected", async () => {
    const env = seedEnv();
    const { learningId } = await deriveLearning(env);
    const { createUpstreamPorts } = await import("./lib/experimentation/experimentation-seams");
    const D = await import("./lib/experimentation/experimentation-service");
    const ports = createUpstreamPorts(env.db as never);
    const deps = { ports, executor: env.db as never, now: new Date(T0) };

    const created = await D.createExperiment(
      1,
      { learningId, statement: "Treatment raises conversion", design: design() },
      deps
    );
    const experimentId = created.experiment.experimentId;
    const submitted = await D.submitGovernance(1, { experimentId }, deps);

    // Approve the CREATE decision.
    const createDecision = await ports.governance.getDecision(1, submitted.experiment.governanceDecisionId!);
    mintApproval(env, createDecision!);
    // Activation re-evaluates EXPERIMENT_ACTIVATE → its own REVIEW_REQUIRED
    // decision needs its own approval: still denied.
    await expect(D.activateExperiment(1, { experimentId }, deps)).rejects.toThrow(
      /Activation approval gate denied|Activation gate denied|governance/i
    );
    // Approve the ACTIVATE decision (read the durable row the F engine wrote).
    const activateDecision = env.seed.optimisation_governance_decisions
      .map((d) => d as Record<string, unknown>)
      .find((d) => d.proposalType === "EXPERIMENT_ACTIVATE");
    mintApproval(env, activateDecision as never);

    const activated = await D.activateExperiment(1, { experimentId }, deps);
    expect(activated.experiment.status).toBe("ACTIVE");
    expect(activated.experiment.assignmentVersion).toBeTruthy();

    // Deterministic assignment: same subject → same arm, replay converges.
    const a1 = await D.getAssignment(1, { experimentId, subjectRef: "lead:1001" }, deps);
    const a2 = await D.getAssignment(1, { experimentId, subjectRef: "lead:1001" }, deps);
    expect(a1.assignmentId).toBe(a2.assignmentId);
    expect(a1.arm).toBe(a2.arm);
    expect(env.seed.experiment_assignments).toHaveLength(1);
    // The client can never supply an arm — authority fields are rejected.
    await expect(
      D.getAssignment(1, { experimentId, subjectRef: "lead:1002", arm: "TREATMENT" } as never, deps)
    ).rejects.toThrow();
  });

  it("evidence binds from real A/B rows exactly once; duplicates do not inflate", async () => {
    const env = seedEnv();
    const { learningId } = await deriveLearning(env);
    const { createUpstreamPorts } = await import("./lib/experimentation/experimentation-seams");
    const D = await import("./lib/experimentation/experimentation-service");
    const ports = createUpstreamPorts(env.db as never);
    const deps = { ports, executor: env.db as never, now: new Date(T0) };

    const created = await D.createExperiment(
      1,
      { learningId, statement: "Treatment raises conversion", design: design() },
      deps
    );
    const experimentId = created.experiment.experimentId;
    const submitted = await D.submitGovernance(1, { experimentId }, deps);
    mintApproval(env, (await ports.governance.getDecision(1, submitted.experiment.governanceDecisionId!))!);
    await expect(D.activateExperiment(1, { experimentId }, deps)).rejects.toThrow();
    mintApproval(env, env.seed.optimisation_governance_decisions.find(
      (d) => (d as Record<string, unknown>).proposalType === "EXPERIMENT_ACTIVATE"
    ) as never);
    await D.activateExperiment(1, { experimentId }, deps);

    // Real A/B rows in the window.
    const outcome = makeOutcomeRow({ id: 2, outcomeId: `out1:${H("d")}`, conversionId: `cnv1:${H("e")}`, evidenceIdentity: "inv-b" });
    const attribution = makeAttributionRow(outcome);
    env.seed.business_outcomes.push(outcome);
    env.seed.attribution_results.push(attribution);
    const assignment = await D.getAssignment(1, { experimentId, subjectRef: "lead:2001" }, deps);

    const bound = await D.bindOutcomeEvidence(
      1,
      { experimentId, subjectRef: "lead:2001", outcomeId: outcome.outcomeId, attributionId: attribution.attributionId },
      deps
    );
    expect(bound.duplicateClassification).toBe("none");
    // Exact-once: a duplicate bind converges and never inflates the evidence.
    const replay = await D.bindOutcomeEvidence(
      1,
      { experimentId, subjectRef: "lead:2001", outcomeId: outcome.outcomeId, attributionId: attribution.attributionId },
      deps
    );
    expect(replay.duplicateClassification).toBe("idempotent_replay");
    expect(env.seed.experiment_outcome_evidence).toHaveLength(1);
    const evidence = env.seed.experiment_outcome_evidence[0] as Record<string, unknown>;
    expect(evidence.armIndex).toBe(assignment.armIndex);
    expect(evidence.outcomeStatus).toBe("VERIFIED");

    // Superseded attribution is stale and cannot bind.
    const outcome2 = makeOutcomeRow({ id: 3, outcomeId: `out1:${H("f")}`, conversionId: `cnv1:${H("g")}`, evidenceIdentity: "inv-c", occurredAt: T0_PLUS_6H, recordedAt: T0_PLUS_6H_1M });
    const staleAttr = makeAttributionRow(outcome2, { supersedesAttributionId: attribution.attributionId });
    env.seed.business_outcomes.push(outcome2);
    env.seed.attribution_results.push(staleAttr);
    await D.getAssignment(1, { experimentId, subjectRef: "lead:2002" }, deps);
    await expect(
      D.bindOutcomeEvidence(
        1,
        { experimentId, subjectRef: "lead:2002", outcomeId: outcome2.outcomeId, attributionId: staleAttr.attributionId },
        deps
      )
    ).rejects.toThrow(/stale/i);
  });

  it("reversed outcomes flow conservatively; analysis is honest under insufficient evidence; replay converges", async () => {
    const env = seedEnv();
    const { learningId } = await deriveLearning(env);
    const { createUpstreamPorts } = await import("./lib/experimentation/experimentation-seams");
    const D = await import("./lib/experimentation/experimentation-service");
    const { transitionOutcomeStatus } = await import("./lib/outcome/outcome-store");
    const ports = createUpstreamPorts(env.db as never);
    const deps = { ports, executor: env.db as never, now: new Date(T0) };

    const created = await D.createExperiment(
      1,
      { learningId, statement: "Treatment raises conversion", design: design() },
      deps
    );
    const experimentId = created.experiment.experimentId;
    const submitted = await D.submitGovernance(1, { experimentId }, deps);
    mintApproval(env, (await ports.governance.getDecision(1, submitted.experiment.governanceDecisionId!))!);
    await expect(D.activateExperiment(1, { experimentId }, deps)).rejects.toThrow();
    mintApproval(env, env.seed.optimisation_governance_decisions.find(
      (d) => (d as Record<string, unknown>).proposalType === "EXPERIMENT_ACTIVATE"
    ) as never);
    await D.activateExperiment(1, { experimentId }, deps);

    // Reverse an outcome BEFORE binding: the evidence snapshot carries the
    // reversed status — downstream interpretation stays conservative.
    const outcome = makeOutcomeRow({ id: 2, outcomeId: `out1:${H("a")}`, conversionId: `cnv1:${H("c")}`, evidenceIdentity: "inv-r" });
    env.seed.business_outcomes.push(outcome);
    await transitionOutcomeStatus(1, outcome.outcomeId as string, 1, "REVERSED", env.db as never);
    await D.getAssignment(1, { experimentId, subjectRef: "lead:3001" }, deps);
    await D.bindOutcomeEvidence(
      1,
      { experimentId, subjectRef: "lead:3001", outcomeId: outcome.outcomeId },
      deps
    );
    const evidence = env.seed.experiment_outcome_evidence[0] as Record<string, unknown>;
    expect(evidence.outcomeStatus).toBe("REVERSED");

    // Stop and analyze: insufficient evidence (minimumSamplePerArm unmet) →
    // honest verdict, durable result, replay converges to the same resultId.
    await D.transitionExperiment(1, { experimentId, to: "STOPPED", reasonCode: "OPERATOR_STOP" }, deps);
    const depsLate = { ports, executor: env.db as never, now: new Date(LATE) };
    const analyzed = await D.analyzeExperiment(1, { experimentId }, depsLate);
    expect(analyzed.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(env.seed.experiment_results).toHaveLength(1);
    const replay = await D.analyzeExperiment(1, { experimentId }, depsLate);
    expect(replay.resultId).toBe(analyzed.resultId);
    expect(env.seed.experiment_results).toHaveLength(1);
  });

  it("stale and contradicted learning cannot ground an experiment", async () => {
    const env = seedEnv();
    const first = await deriveLearning(env);
    const { createUpstreamPorts } = await import("./lib/experimentation/experimentation-seams");
    const D = await import("./lib/experimentation/experimentation-service");
    const { transitionLearningStatus } = await import("./lib/business-learning/business-learning-store");
    const ports = createUpstreamPorts(env.db as never);
    const deps = { ports, executor: env.db as never, now: new Date(T0) };

    // Contradicted learning is never silently testable.
    await transitionLearningStatus(1, first.learningId, 1, ["CANDIDATE"], "CONTRADICTED", env.db as never);
    await expect(
      D.createExperiment(1, { learningId: first.learningId, statement: "s", design: design() }, deps)
    ).rejects.toThrow(/contradicted/i);

    // Stale learning (past validity horizon) cannot ground a new experiment.
    const { deriveBusinessLearning } = await import("./lib/business-learning/business-learning-service");
    const { createUpstreamPorts: createCPorts } = await import("./lib/business-learning/business-learning-upstream-seam");
    const outcome = makeOutcomeRow({ id: 9, outcomeId: `out1:${H("e")}`, conversionId: `cnv1:${H("f")}`, evidenceIdentity: "inv-s" });
    const attribution = makeAttributionRow(outcome);
    env.seed.business_outcomes.push(outcome);
    env.seed.attribution_results.push(attribution);
    const derived = await deriveBusinessLearning(
      1,
      { outcomeIds: [outcome.outcomeId], attributionIds: [attribution.attributionId] },
      { ports: createCPorts(env.db as never), now: new Date("2020-01-01T00:00:00.000Z") }
    );
    const staleLearningId = derived.results[0].learning.learningId;
    await expect(
      D.createExperiment(1, { learningId: staleLearningId, statement: "s", design: design() }, deps)
    ).rejects.toThrow(/stale/i);
  });
});
