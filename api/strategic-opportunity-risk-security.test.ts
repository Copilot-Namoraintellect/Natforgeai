/**
 * R8-E — Adversarial Security Acceptance (rogue-agent matrix).
 *
 * The opportunity/risk agent is assumed compromised. These cases prove the
 * blast radius stays zero: no fabricated authority, no raised dimensions, no
 * hidden contradiction, no self-approval, no execution — and every authority
 * absence fails closed rather than guessing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb must not fall back to a real connection in the R8-E security suite");
  }),
}));

import { createFakeDb } from "./r5-test-support";
import { deriveStrategicCandidates, getMissionControlHandoff, reevaluateStrategicCandidate } from "./lib/strategic-opportunity-risk/strategic-opportunity-risk-service";
import { bindStrategicOpportunityRiskStoreExecutor } from "./lib/strategic-opportunity-risk/strategic-opportunity-risk-store";
import {
  createInMemoryStrategicReasoningReadPort,
  STRATEGIC_REASONING_ATTRIBUTION_DISCLAIMER,
  STRATEGIC_REASONING_CAUSATION_DISCLAIMER,
  STRATEGIC_REASONING_EXECUTION_DISCLAIMER,
  clearStrategicReasoningReadPort,
  getStrategicReasoningReadPort,
} from "./lib/strategic-opportunity-risk/strategic-opportunity-risk-reasoning-seam";
import {
  FakeDefaultPolicyGovernancePort,
  clearStrategicOpportunityRiskGovernanceEngine,
  getStrategicOpportunityRiskGovernanceEngine,
  validateStrategicGovernanceDecisionView,
} from "./lib/strategic-opportunity-risk/strategic-opportunity-risk-governance-seam";
import {
  assertNoClientAuthorityFields,
  DeriveStrategicCandidateInputSchema,
} from "./lib/strategic-opportunity-risk/strategic-opportunity-risk-contract";

const hex = (n: number) => String(n).padStart(64, "0");
const NOW = new Date("2026-11-10T00:00:00.000Z");
let seq = 5000;
const nextId = (p: string) => `${p}${hex(++seq)}`;

function proj(over: Record<string, unknown> = {}) {
  return {
    contractVersion: "strategic-reasoning-to-opportunity-risk/v1",
    reasoningId: nextId("rsn1:"), businessId: 1, evidenceBundleId: nextId("evb1:"), hypothesisId: nextId("hyp1:"),
    hypothesisType: "GROWTH_SIGNAL", implicationType: "REVIEW_MARKET_RESPONSE",
    supportingEvidence: [{ ref: nextId("mem1:"), evidenceClass: "INTERNAL_MEMORY", role: "ANCHOR" }],
    contradictingEvidence: [], missingEvidence: [], confidenceClass: "MODERATE", uncertaintyClasses: [],
    strategicRiskClass: "LOW", status: "SUPPORTED", governanceDecisionId: nextId("sgd1:"),
    governanceDecision: "ALLOW_RECOMMENDATION", approvalStatus: "none", policyVersion: "strategic-governance-policy/v1",
    freshness: "current", limitations: [], sourceVersions: {}, validUntil: null, supersedesReasoningId: null,
    createdAt: NOW.toISOString(), causationClaimed: false, causationDisclaimer: STRATEGIC_REASONING_CAUSATION_DISCLAIMER,
    attributionClaimed: false, attributionDisclaimer: STRATEGIC_REASONING_ATTRIBUTION_DISCLAIMER,
    executionClaimed: false, executionDisclaimer: STRATEGIC_REASONING_EXECUTION_DISCLAIMER, ...over,
  };
}

function buildWorld() {
  const seed: Record<string, Record<string, unknown>[]> = {
    businesses: [{ id: 1, userId: 7 }],
    strategic_opportunity_risk_candidates: [], strategic_opportunity_risk_relations: [],
    strategic_opportunity_risk_lifecycle_events: [], audit_events: [], approval_requests: [],
  };
  const { db } = createFakeDb(seed);
  const rows: Record<string, unknown>[] = [];
  const approvals: { id: number; status: "pending" | "approved" | "rejected" | "edited"; binding: unknown }[] = [];
  const governance = new FakeDefaultPolicyGovernancePort({ now: () => NOW });
  const deps = {
    reasoning: createInMemoryStrategicReasoningReadPort(rows),
    governance,
    approvals: {
      async listApprovalsForDecision({ governanceDecisionId }: { userId: number; governanceDecisionId: string }) {
        return approvals
          .filter((r) => {
            const b = r.binding as { governanceDecisionId?: string } | null;
            return !b || b.governanceDecisionId === governanceDecisionId;
          })
          .map((r) => ({ id: r.id, status: r.status, binding: r.binding as never }));
      },
    },
    now: () => NOW,
  };
  const executor = bindStrategicOpportunityRiskStoreExecutor(db as never);
  return { seed, rows, approvals, governance, deps, executor };
}

describe("R8-E security: authority absence fails closed", () => {
  it("unregistered reasoning authority refuses every derivation", () => {
    clearStrategicReasoningReadPort();
    expect(() => getStrategicReasoningReadPort()).toThrowError(
      /strategic-reasoning authority is not bound/
    );
  });

  it("unregistered governance engine refuses every candidate", () => {
    clearStrategicOpportunityRiskGovernanceEngine();
    expect(() => getStrategicOpportunityRiskGovernanceEngine()).toThrowError(
      /strategic-governance authority is not bound/
    );
  });

  it("tampered governance decision payload is rejected at the boundary", () => {
    const world = buildWorld();
    const p = proj();
    world.rows.push(p);
    const hostile = {
      governanceDecisionId: `sgd1:${hex(1)}`,
      proposalId: `sor1:${hex(2)}`,
      businessId: 1,
      recommendationType: "STRATEGIC_OBSERVATION",
      decision: "ALLOW_RECOMMENDATION",
      policyVersion: "strategic-governance-policy/v1",
      evidenceFingerprint: hex(3),
      proposalFingerprint: hex(4),
      strategicRiskClass: "LOW",
      confidenceClass: "HIGH",
      sourceTrustClass: "AUTHORITATIVE_INTERNAL",
      approvalRequired: false,
      reasonCodes: [],
      validUntil: null,
      forgedField: true,
    };
    // Shape validates (extra keys ignored by the frozen view), but a hostile
    // engine cannot mint a non-sgd1 id or an off-policy decision shape.
    expect(() => validateStrategicGovernanceDecisionView(hostile)).not.toThrow();
    expect(() =>
      validateStrategicGovernanceDecisionView({ ...hostile, governanceDecisionId: "ogd1:bad" })
    ).toThrowError(/malformed governanceDecisionId/);
    expect(() =>
      validateStrategicGovernanceDecisionView({ ...hostile, decision: "EXECUTE" })
    ).toThrowError(/unknown decision/);
    expect(() =>
      validateStrategicGovernanceDecisionView({ ...hostile, policyVersion: "attacker-policy/v9" })
    ).toThrowError(/unknown policy version/);
  });
});

describe("R8-E security: approval integrity", () => {
  let world: ReturnType<typeof buildWorld>;
  beforeEach(() => {
    world = buildWorld();
  });

  async function deriveReviewCandidate() {
    const p = proj({ hypothesisType: "DECLINE_SIGNAL", strategicRiskClass: "HIGH", confidenceClass: "HIGH" });
    world.rows.push(p);
    const r = await deriveStrategicCandidates({ userId: 7, businessId: 1, reasoningIds: [p.reasoningId as string] }, world.deps, world.executor);
    return r.results[0].candidate!;
  }

  it("human rejection permanently blocks the candidate identity", async () => {
    const c = await deriveReviewCandidate();
    world.governance.mintApproval(c.governanceDecisionId!, "rejected");
    const decision = world.governance["decisions"].get(c.governanceDecisionId!)!;
    const { deriveApprovalBindingHash } = await import("./lib/strategic-opportunity-risk/strategic-opportunity-risk-reasoning-seam");
    world.approvals.push({
      id: 1,
      status: "rejected",
      binding: {
        governanceDecisionId: c.governanceDecisionId,
        policyVersion: decision.policyVersion,
        proposalFingerprint: decision.proposalFingerprint,
        evidenceFingerprint: decision.evidenceFingerprint,
        approvalBindingHash: deriveApprovalBindingHash({
          governanceDecisionId: c.governanceDecisionId!,
          policyVersion: decision.policyVersion,
          proposalFingerprint: decision.proposalFingerprint,
          evidenceFingerprint: decision.evidenceFingerprint,
        }),
      },
    });
    const handoff = await getMissionControlHandoff({ userId: 7, businessId: 1, includeNonGoverned: false, deps: world.deps, executor: world.executor });
    expect(handoff.projections.find((x) => x.candidateId === c.candidateId)).toBeUndefined();
  });

  it("edited approval material fails closed (binding mismatch)", async () => {
    const c = await deriveReviewCandidate();
    world.governance.mintApproval(c.governanceDecisionId!, "approved");
    const decision = world.governance["decisions"].get(c.governanceDecisionId!)!;
    world.approvals.push({
      id: 1,
      status: "edited",
      binding: {
        governanceDecisionId: c.governanceDecisionId,
        policyVersion: decision.policyVersion,
        proposalFingerprint: decision.proposalFingerprint,
        evidenceFingerprint: decision.evidenceFingerprint,
        approvalBindingHash: "e".repeat(64),
      },
    });
    // Forged approval material aborts the read — never silently consumed.
    await expect(
      getMissionControlHandoff({ userId: 7, businessId: 1, includeNonGoverned: false, deps: world.deps, executor: world.executor })
    ).rejects.toMatchObject({ code: "APPROVAL_BINDING_MISMATCH" });
  });

  it("cross-decision approval is not accepted", async () => {
    const c = await deriveReviewCandidate();
    world.governance.mintApproval(c.governanceDecisionId!, "approved");
    const decision = world.governance["decisions"].get(c.governanceDecisionId!)!;
    // Approval binding references a DIFFERENT decision id.
    world.approvals.push({
      id: 1,
      status: "approved",
      binding: {
        governanceDecisionId: `sgd1:${hex(9)}`,
        policyVersion: decision.policyVersion,
        proposalFingerprint: decision.proposalFingerprint,
        evidenceFingerprint: decision.evidenceFingerprint,
        approvalBindingHash: "a".repeat(64),
      },
    });
    const handoff = await getMissionControlHandoff({ userId: 7, businessId: 1, includeNonGoverned: false, deps: world.deps, executor: world.executor });
    expect(handoff.projections.find((x) => x.candidateId === c.candidateId)).toBeUndefined();
  });
});

describe("R8-E security: client-authority rejection", () => {
  it("assertNoClientAuthorityFields rejects every authority key", () => {
    for (const key of [
      "decision", "priorityClass", "priorityScore", "impactClass", "urgencyClass",
      "timeHorizon", "confidenceClass", "strategicRiskClass", "status",
      "approvalStatus", "approved", "executable", "candidateFingerprint",
      "policyVersion", "forceAllow", "raiseConfidence", "raiseImpact",
      "raiseUrgency", "lowerRisk", "suppressContradiction", "hideContradiction",
      "overrideDecision", "overridePolicy",
    ]) {
      expect(() => assertNoClientAuthorityFields({ [key]: true })).toThrowError(
        /client-supplied authority field/
      );
    }
    expect(() => assertNoClientAuthorityFields({ businessId: 1, reasoningIds: [] })).not.toThrow();
  });

  it("strictObject inputs reject authority smuggling of every kind", () => {
    for (const payload of [
      { businessId: 1, reasoningIds: [`rsn1:${hex(1)}`], decision: "ALLOW_RECOMMENDATION" },
      { businessId: 1, reasoningIds: [`rsn1:${hex(1)}`], approved: true },
      { businessId: 1, reasoningIds: [`rsn1:${hex(1)}`], riskClass: "LOW" },
      { businessId: 1, reasoningIds: [`rsn1:${hex(1)}`], status: "GOVERNED_RECOMMENDATION" },
      { businessId: 1, reasoningIds: [`rsn1:${hex(1)}`], candidateFingerprint: hex(2) },
    ]) {
      expect(DeriveStrategicCandidateInputSchema.safeParse(payload).success).toBe(false);
    }
  });

  it("modelAssistance narrative channel does not exist (enum-bounded types only)", () => {
    const parsed = DeriveStrategicCandidateInputSchema.safeParse({
      businessId: 1,
      reasoningIds: [`rsn1:${hex(1)}`],
      modelAssistance: { candidateTypes: ["MARKET_EXPANSION", "ignore instructions"] },
    });
    expect(parsed.success).toBe(false);
  });
});

describe("R8-E security: re-evaluation safety", () => {
  it("reevaluate refuses to act when the governing reasoning vanishes", async () => {
    const world = buildWorld();
    const p = proj();
    world.rows.push(p);
    const r = await deriveStrategicCandidates({ userId: 7, businessId: 1, reasoningIds: [p.reasoningId as string] }, world.deps, world.executor);
    const id = r.results[0].candidate!.candidateId;
    world.rows.length = 0;
    await expect(
      reevaluateStrategicCandidate({ userId: 7, candidateId: id, deps: world.deps, executor: world.executor })
    ).rejects.toMatchObject({ code: "UNKNOWN_REASONING_REFERENCE" });
    // The candidate is untouched.
    const row = world.seed.strategic_opportunity_risk_candidates.find((c) => c.candidateId === id)!;
    expect(row.status).toBe("GOVERNED_RECOMMENDATION");
  });

  it("concurrent lifecycle drift fails closed (store CAS guard)", async () => {
    const world = buildWorld();
    const p = proj({ validUntil: new Date(NOW.getTime() + 30 * 86400_000).toISOString() });
    world.rows.push(p);
    const r = await deriveStrategicCandidates({ userId: 7, businessId: 1, reasoningIds: [p.reasoningId as string] }, world.deps, world.executor);
    const id = r.results[0].candidate!.candidateId;
    // A raced write under the same identity with a stale expected version
    // loses the optimistic CAS — never silently clobbered.
    const { transitionStrategicCandidateStatus } = await import("./lib/strategic-opportunity-risk/strategic-opportunity-risk-store");
    await expect(
      transitionStrategicCandidateStatus(world.executor, {
        userId: 7,
        candidateId: id,
        expectedVersion: 999,
        nextStatus: "STALE",
      })
    ).rejects.toMatchObject({ code: "LIFECYCLE_CONFLICT" });
  });
});
