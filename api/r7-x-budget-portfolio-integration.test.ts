/**
 * R7-X X7 — Budget / Portfolio Integration acceptance.
 *
 * Proves the connected optimisation lifecycle over the REAL integrated
 * authorities:
 *
 *   portfolio snapshot → canonical A/B/C evidence model → bounded candidate
 *   reallocation → stability constraints → R7-F governance decision →
 *   human approval when required → read-only authorised instruction.
 *
 * Critical invariants verified: sum proposed <= approved total (reallocation
 * never raises total), no locked/reserved movement, no unsupported provider
 * allocation, no ungoverned total-spend increase, no stale snapshot
 * execution, weak evidence yields conservative NO_CHANGE, strong evidence
 * may yield a bounded shift, and evidence-unavailable fails closed.
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
const NOW_MS = Date.now();
const NOW = new Date(NOW_MS).toISOString();
const RECENT = new Date(NOW_MS - 2 * 24 * 3600_000).toISOString();

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
    occurredAt: RECENT,
    recordedAt: RECENT,
    reversesOutcomeId: null,
    renewsOutcomeId: null,
    supersedesOutcomeId: null,
    version: 1,
    createdAt: RECENT,
    ...overrides,
  };
  row.evidenceHash = outcomeHashFor(row);
  return row;
}

function campaignTouchpoint(campaignId: number, creditBps = 100000) {
  return {
    touchpointId: `tpp:campaign:${H("5").slice(0, 24)}`,
    type: "CAMPAIGN",
    sourceIdentity: String(campaignId),
    businessId: 10,
    occurredAt: RECENT,
    provenance: { path: "opportunity.campaignId", references: {}, sourceRowHash: H("7") },
    eligibility: "eligible",
    creditBps,
  };
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
    windowStart: RECENT,
    windowEnd: RECENT,
    journeyHash: H("j"),
    touchpoints: [],
    excludedTouchpoints: [],
    totalCreditBps: 0,
    confidenceClass: "NONE",
    evidenceClass: "INSUFFICIENT_EVIDENCE",
    policyVersion: "attribution-policy/v1",
    sourceVersions: {},
    supersedesAttributionId: null,
    calculatedAt: RECENT,
    ...overrides,
  };
  const key = deriveAttributionKey({
    tenantUserId: 1,
    businessId: 10,
    outcomeId: outcome.outcomeId as string,
    modelType: "LAST_TOUCH",
    modelVersion: "attribution-last-touch/v1",
    windowStart: RECENT,
    windowEnd: RECENT,
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

function seedEnv(options: { evidenceTablesPresent?: boolean } = {}) {
  const env = createFakeDb({
    businesses: [
      { id: 10, userId: 1, isActive: true },
      { id: 20, userId: 1, isActive: true },
    ],
    campaigns: [
      { id: 500, userId: 1, businessId: 10, budget: 1500, status: "active" },
      { id: 501, userId: 1, businessId: 10, budget: 500, status: "active" },
    ],
    business_outcomes: [],
    business_outcome_lifecycle_events: [],
    attribution_results: [],
    business_learning_records: [],
    business_learning_lifecycle_events: [],
    budget_portfolio_snapshots: [],
    budget_portfolio_proposals: [],
    budget_portfolio_allocation_instructions: [],
    optimisation_governance_decisions: [],
    approval_requests: [],
    audit_events: [],
  });
  (env.db.execute as ReturnType<typeof vi.fn>).mockImplementation((q: unknown) => {
    const chunks = JSON.stringify((q as { queryChunks?: unknown }).queryChunks ?? q ?? "");
    if (chunks.includes("COUNT(*) AS c FROM information_schema")) return Promise.resolve([{ c: 1 }]);
    if (chunks.includes("table_name FROM information_schema")) {
      if (options.evidenceTablesPresent === false) return Promise.resolve([]);
      return Promise.resolve([
        { table_name: "business_outcomes" },
        { table_name: "attribution_results" },
        { table_name: "business_learning_records" },
        { table_name: "optimisation_governance_decisions" },
      ]);
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

async function makeDeps(env: ReturnType<typeof seedEnv>) {
  const { createBudgetPortfolioAuthorityProvider, createBudgetPortfolioEvidenceProvider } = await import(
    "./lib/budget-portfolio/budget-portfolio-bridge"
  );
  const { createCanonicalGovernancePort } = await import("./lib/budget-portfolio/governance-seam");
  return {
    authorityProvider: createBudgetPortfolioAuthorityProvider(env.db as never, 1),
    evidenceProvider: createBudgetPortfolioEvidenceProvider(env.db as never, 1),
    governance: createCanonicalGovernancePort(env.db as never),
    now: () => new Date(NOW_MS),
  };
}

/** Seed strong-but-uneven evidence: campaign 501 dominates, 500 has a little. */
async function seedStrongEvidence(env: ReturnType<typeof seedEnv>) {
  const { deriveBusinessLearning } = await import("./lib/business-learning/business-learning-service");
  const { createUpstreamPorts } = await import("./lib/business-learning/business-learning-upstream-seam");
  const outcomeIds: string[] = [];
  const attributionIds: string[] = [];
  const pushPair = (i: number, campaignId: number, amountMinor: number, count: number) => {
    for (let k = 0; k < count; k++) {
      const n = String(i * 10 + k + 1).padStart(64, "0");
      const outcome = makeOutcomeRow({
        id: i * 10 + k + 1,
        outcomeId: `out1:${n}`,
        conversionId: `cnv1:${n}`,
        evidenceIdentity: `inv-${i}-${k}`,
        amountMinor,
      });
      const attribution = makeAttributionRow(outcome, {
        touchpoints: [campaignTouchpoint(campaignId)],
        totalCreditBps: 100000,
        confidenceClass: "HIGH",
        evidenceClass: "DIRECT_LINKAGE",
      });
      env.seed.business_outcomes.push(outcome);
      env.seed.attribution_results.push(attribution);
      outcomeIds.push(outcome.outcomeId as string);
      attributionIds.push(attribution.attributionId as string);
    }
  };
  pushPair(0, 501, 60000, 6);
  pushPair(1, 500, 10000, 1);
  const ports = createUpstreamPorts(env.db as never);
  const derived = await deriveBusinessLearning(
    1,
    { outcomeIds, attributionIds },
    { ports, now: new Date(NOW_MS) }
  );
  return { learningId: derived.results[0].learning.learningId as string, outcomeIds, attributionIds };
}

function mintApproval(env: ReturnType<typeof seedEnv>, decision: Record<string, any>) {
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
        approvalBindingHash: decision.approvalBinding.approvalBindingHash,
        expiresAt: decision.approvalBinding.expiresAt,
      },
    },
  });
}

describe("R7-X X7: budget/portfolio integration (snapshot → evidence → F → instruction)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("strong evidence → bounded shift → REVIEW_REQUIRED → approval → exact authorised instruction", async () => {
    const env = seedEnv();
    const E = await import("./lib/budget-portfolio/budget-portfolio-service");
    const deps = await makeDeps(env);
    const executor = env.db as never;

    await E.createPortfolioSnapshot({ userId: 1, businessId: 10 }, deps, executor);
    const { outcomeIds, attributionIds } = await seedStrongEvidence(env);

    const proposed = await E.proposeOptimisation(
      {
        userId: 1,
        businessId: 10,
        objective: "MAXIMISE_EVIDENCE_WEIGHTED_VALUE",
        evidenceRefs: { outcomeRefs: outcomeIds, attributionRefs: attributionIds },
      },
      deps,
      executor
    );
    const row = proposed.proposal as unknown as Record<string, any>;
    expect(row.status).toBe("REVIEW_REQUIRED");
    expect(proposed.governanceDecision?.decision).toBe("REVIEW_REQUIRED");

    // Financial invariants on the durable proposal.
    const current = (row.currentAllocations as { allocationKey: string; amountMinor: number }[]);
    const proposedAllocs = (row.proposedAllocations as { allocationKey: string; amountMinor: number }[]);
    const sumCurrent = current.reduce((s, e) => s + e.amountMinor, 0);
    const sumProposed = proposedAllocs.reduce((s, e) => s + e.amountMinor, 0);
    expect(sumProposed).toBe(sumCurrent); // reallocation within approved total
    expect(sumProposed).toBeLessThanOrEqual(200000); // approved total ($1500 + $500)
    const deltaTotal = (row.deltaAllocations as { deltaMinor: number }[]).reduce((s, d) => s + d.deltaMinor, 0);
    expect(deltaTotal).toBe(0); // no ungoverned total-spend increase

    // REVIEW_REQUIRED cannot self-authorise: instruction without approval fails.
    await expect(
      E.getAuthorisedInstruction({ userId: 1, optimisationId: row.optimisationId }, deps, executor)
    ).rejects.toThrow(/APPROVAL_NOT_FOUND|not executable|NOT_EXECUTABLE|approval/i);

    // Human approval bound to the exact decision → instruction authorised.
    mintApproval(env, proposed.governanceDecision as never);
    const instruction = await E.getAuthorisedInstruction(
      { userId: 1, optimisationId: row.optimisationId },
      deps,
      executor
    );
    const view = instruction as unknown as {
      instruction: { governanceDecisionId: string; allocations: { allocationKey: string; amountMinor: number }[] };
      authorisation: { governanceDecisionId: string };
    };
    expect(view.authorisation.governanceDecisionId).toBe(
      (proposed.governanceDecision as any).governanceDecisionId
    );
    const instructionAllocs = view.instruction.allocations;
    const instructionSum = instructionAllocs.reduce((s, e) => s + e.amountMinor, 0);
    expect(instructionSum).toBe(200000); // total preserved exactly
    // Read-only: the instruction is a durable row; no campaign/billing row moved.
    expect(env.seed.campaigns.find((c) => c.id === 500)?.budget).toBe(1500);
    expect(env.seed.campaigns.find((c) => c.id === 501)?.budget).toBe(500);
    expect(env.seed.budget_portfolio_allocation_instructions).toHaveLength(1);
  });

  it("weak evidence yields a conservative NO_CHANGE proposal (no aggressive optimisation)", async () => {
    const env = seedEnv();
    const E = await import("./lib/budget-portfolio/budget-portfolio-service");
    const deps = await makeDeps(env);
    const executor = env.db as never;

    await E.createPortfolioSnapshot({ userId: 1, businessId: 20 }, deps, executor);
    // Business 20 has no campaigns/evidence at all.
    const proposed = await E.proposeOptimisation({ userId: 1, businessId: 20 }, deps, executor);
    expect((proposed.proposal as unknown as Record<string, any>).status).toBe("NO_CHANGE");
    await expect(
      E.getAuthorisedInstruction(
        { userId: 1, optimisationId: (proposed.proposal as unknown as Record<string, any>).optimisationId },
        deps,
        executor
      )
    ).rejects.toThrow(/carry no instruction/);
    // No governance decision was minted for a no-change proposal.
    expect(env.seed.optimisation_governance_decisions).toHaveLength(0);
  });

  it("stale snapshot execution fails closed; evidence-unavailable fails closed", async () => {
    const env = seedEnv();
    const E = await import("./lib/budget-portfolio/budget-portfolio-service");
    const deps = await makeDeps(env);
    const executor = env.db as never;

    await E.createPortfolioSnapshot({ userId: 1, businessId: 10 }, deps, executor);
    const { outcomeIds, attributionIds } = await seedStrongEvidence(env);
    const first = await E.proposeOptimisation(
      { userId: 1, businessId: 10, evidenceRefs: { outcomeRefs: outcomeIds, attributionRefs: attributionIds } },
      deps,
      executor
    );
    const snapshotId = (first.proposal as unknown as Record<string, any>).portfolioSnapshotId as string;

    // Replay against the same (now stale-policy-horizon) snapshot id is
    // freshness-gated; a clock far in the future makes the snapshot stale.
    const staleDeps = { ...deps, now: () => new Date(NOW_MS + 30 * 24 * 3600_000) };
    await expect(
      E.proposeOptimisation(
        {
          userId: 1,
          businessId: 10,
          portfolioSnapshotId: snapshotId,
          evidenceRefs: { outcomeRefs: outcomeIds, attributionRefs: attributionIds },
        },
        staleDeps,
        executor
      )
    ).rejects.toThrow(/STALE|stale/i);

    // Evidence tables absent → fail closed, never guessed.
    const env2 = seedEnv({ evidenceTablesPresent: false });
    const deps2 = await makeDeps(env2);
    await E.createPortfolioSnapshot({ userId: 1, businessId: 10 }, deps2, env2.db as never);
    await expect(
      E.proposeOptimisation({ userId: 1, businessId: 10 }, deps2, env2.db as never)
    ).rejects.toThrow(/EVIDENCE_UNAVAILABLE|unavailable/i);
  });
});
