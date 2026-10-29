/**
 * R7-X X5 — Governance Binding acceptance.
 *
 * Proves the D and E governance seams bind the canonical integrated R7-F
 * authority (never a test double in production wiring):
 *
 *  - proposal → R7-F governed evaluation → durable ogd1: decision
 *    (exactly-once; replay converges);
 *  - ALLOW is a real F decision (low-risk strategy recommendation), not a
 *    generic allow;
 *  - REVIEW_REQUIRED cannot self-approve: without a bound human approval the
 *    execution gate stays shut (APPROVAL_NOT_FOUND); with the exact bound
 *    approval it opens — and only for the exact decision binding;
 *  - BLOCK decisions are never executable; stale policy fails closed;
 *  - governance-unavailable fails closed (no fabricated decision);
 *  - the execution gate is F's own assertOptimisationActionExecutable.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb must not fall back to a real connection in R7-X binding tests");
  }),
}));

import { getDb } from "./queries/connection";
import { createFakeDb } from "./r5-test-support";
import {
  createCanonicalGovernancePort,
  deriveR7FApprovalBindingHash,
} from "./lib/budget-portfolio/governance-seam";
import { getOptimisationGovernancePolicy } from "./lib/optimisation-governance/optimisation-policy";

const NOW = "2026-11-10T12:00:00.000Z";

function seedGovernanceEnv(options: { governanceTablePresent?: boolean } = {}) {
  const env = createFakeDb({
    businesses: [{ id: 10, userId: 1, isActive: true, name: "B" }],
    campaigns: [{ id: 500, userId: 1, businessId: 10, budget: 1000, name: "C" }],
    optimisation_governance_decisions: [],
    approval_requests: [],
  });
  (env.db.execute as ReturnType<typeof vi.fn>).mockImplementation((q: unknown) => {
    const chunks = JSON.stringify((q as { queryChunks?: unknown }).queryChunks ?? q ?? "");
    if (chunks.includes("COUNT(*) AS c FROM information_schema")) {
      const present =
        options.governanceTablePresent === false && chunks.includes("optimisation_governance_decisions")
          ? 0
          : 1;
      return Promise.resolve([{ c: present }]);
    }
    if (chunks.includes("table_name FROM information_schema")) {
      // F bridge probe.
      return Promise.resolve(
        options.governanceTablePresent === false
          ? []
          : [{ table_name: "optimisation_governance_decisions" }]
      );
    }
    if (chunks.includes("FROM approval_requests")) {
      // D/E approval-ledger scan (raw select): serve the live seed rows.
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

/** Canonical R7-F proposal (optimisation-governance/v1). */
function strategyProposal(overrides: Record<string, unknown> = {}) {
  return {
    proposalId: "opt-prop-1",
    businessId: 10,
    proposalType: "STRATEGY_RECOMMENDATION",
    financial: null,
    experiment: null,
    portfolio: null,
    learningReference: null,
    campaignId: null,
    evidenceHash: "e".repeat(64),
    requestedAt: NOW,
    ...overrides,
  };
}

function experimentCreateProposal(overrides: Record<string, unknown> = {}) {
  return strategyProposal({
    proposalId: "exp1:abcdef",
    proposalType: "EXPERIMENT_CREATE",
    financial: { currency: "USD", allocationDeltas: [] },
    experiment: {
      experimentKey: "exp1:abcdef",
      dimensions: ["channel"],
      budgetMinor: 50000,
      durationDays: 14,
      touchesProtectedTraits: [],
    },
    ...overrides,
  });
}

describe("R7-X X5: canonical R7-F governance binding (D + E seams)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  async function experimentationPorts(env: ReturnType<typeof seedGovernanceEnv>) {
    const { createUpstreamPorts } = await import("./lib/experimentation/experimentation-seams");
    return createUpstreamPorts(env.db as never);
  }

  it("D seam: proposal → real F evaluation → durable ALLOW decision; replay converges", async () => {
    const env = seedGovernanceEnv();
    const ports = await experimentationPorts(env);

    const decision = await ports.governance.evaluateProposal(1, strategyProposal());
    expect(decision.governanceDecisionId).toMatch(/^ogd1:[a-f0-9]{64}$/);
    expect(decision.decision).toBe("ALLOW");
    expect(decision.userId).toBe(1);
    expect(decision.businessId).toBe(10);
    expect(decision.policyVersion).toBe(getOptimisationGovernancePolicy().policyVersion);
    // Durable exactly-once: one row; replay returns the same decision.
    expect(env.seed.optimisation_governance_decisions).toHaveLength(1);
    const again = await ports.governance.evaluateProposal(1, strategyProposal());
    expect(again.governanceDecisionId).toBe(decision.governanceDecisionId);
    expect(env.seed.optimisation_governance_decisions).toHaveLength(1);
    // Read-back through the canonical decision read.
    const readBack = await ports.governance.getDecision(1, decision.governanceDecisionId);
    expect(readBack?.governanceDecisionId).toBe(decision.governanceDecisionId);
  });

  it("D seam: REVIEW_REQUIRED cannot self-approve; bound human approval opens the exact gate", async () => {
    const env = seedGovernanceEnv();
    const ports = await experimentationPorts(env);

    // Experiment create is medium-risk under F policy → REVIEW_REQUIRED.
    const decision = await ports.governance.evaluateProposal(1, experimentCreateProposal());
    expect(decision.decision).toBe("REVIEW_REQUIRED");
    expect(decision.approvalBinding).not.toBeNull();

    const policyVersion = await ports.governance.getCurrentPolicyVersion();
    expect(policyVersion).not.toBeNull();

    // No approval: gate shut.
    const noApproval = await ports.governance.getApprovalForDecision(1, decision.governanceDecisionId);
    const denied = await ports.governance.assertExecutable({
      decision,
      approval: noApproval,
      currentPolicyVersion: policyVersion,
      now: new Date().toISOString(),
    });
    expect(denied.executable).toBe(false);
    expect(denied.denialReasonCode).toBe("APPROVAL_NOT_FOUND");

    // Human approves with the exact bound context.
    const binding = decision.approvalBinding!;
    env.seed.approval_requests.push({
      id: 1,
      userId: 1,
      approvalType: "optimisation_action",
      status: "approved",
      context: {
        optimisationGovernanceBinding: {
          governanceDecisionId: decision.governanceDecisionId,
          policyVersion: decision.policyVersion,
          proposalFingerprint: decision.proposalFingerprint,
          approvalBindingHash: binding.approvalBindingHash,
          expiresAt: binding.expiresAt,
        },
      },
    });
    const approval = await ports.governance.getApprovalForDecision(1, decision.governanceDecisionId);
    expect(approval?.status).toBe("approved");
    const allowed = await ports.governance.assertExecutable({
      decision,
      approval,
      currentPolicyVersion: policyVersion,
      now: new Date().toISOString(),
    });
    expect(allowed.executable).toBe(true);
    expect(allowed.authorization?.governanceDecisionId).toBe(decision.governanceDecisionId);

    // A forged binding (hash computed over a different fingerprint) keeps
    // the gate shut — the approval never authorizes anything else.
    const forged = await ports.governance.assertExecutable({
      decision,
      approval: {
        id: 2,
        userId: 1,
        status: "approved",
        context: {
          optimisationGovernanceBinding: {
            governanceDecisionId: decision.governanceDecisionId,
            policyVersion: decision.policyVersion!,
            proposalFingerprint: decision.proposalFingerprint,
            approvalBindingHash: deriveR7FApprovalBindingHash({
              governanceDecisionId: decision.governanceDecisionId,
              policyVersion: decision.policyVersion!,
              proposalFingerprint: "f".repeat(64),
            }),
            expiresAt: binding.expiresAt,
          },
        },
      },
      currentPolicyVersion: policyVersion,
      now: new Date().toISOString(),
    });
    expect(forged.executable).toBe(false);
    expect(forged.denialReasonCode).toBe("APPROVAL_BINDING_MISMATCH");
  });

  it("D seam: BLOCK decisions are never executable; stale policy fails closed", async () => {
    const env = seedGovernanceEnv();
    const ports = await experimentationPorts(env);

    // Unknown action types are durably BLOCKed (auditable governed refusal).
    const decision = await ports.governance.evaluateProposal(
      1,
      strategyProposal({ proposalType: "SUDO_EVERYTHING" })
    );
    expect(decision.decision).toBe("BLOCK");
    const verdict = await ports.governance.assertExecutable({
      decision,
      approval: null,
      currentPolicyVersion: await ports.governance.getCurrentPolicyVersion(),
      now: new Date().toISOString(),
    });
    expect(verdict.executable).toBe(false);

    // Stale policy: even an ALLOW decision fails closed under a new version.
    const allowDecision = await ports.governance.evaluateProposal(1, strategyProposal());
    const stale = await ports.governance.assertExecutable({
      decision: allowDecision,
      approval: null,
      currentPolicyVersion: "optimisation-governance-policy/v999",
      now: new Date().toISOString(),
    });
    expect(stale.executable).toBe(false);
    expect(stale.denialReasonCode).toBe("STALE_POLICY_VERSION");
  });

  it("D + E seams: governance-unavailable fails closed — no fabricated decision", async () => {
    const env = seedGovernanceEnv({ governanceTablePresent: false });
    const dPorts = await experimentationPorts(env);
    await expect(dPorts.governance.evaluateProposal(1, strategyProposal())).rejects.toThrow(
      /unavailable/i
    );

    const ePort = createCanonicalGovernancePort(env.db as never);
    await expect(
      ePort.evaluateProposal({ userId: 1, proposal: strategyProposal() })
    ).rejects.toThrow(/unavailable/i);
  });

  it("E seam: canonical port persists + validates consumed decisions against the frozen shape", async () => {
    const env = seedGovernanceEnv();
    const port = createCanonicalGovernancePort(env.db as never);
    const { decision, duplicateClassification } = await port.evaluateProposal({
      userId: 1,
      proposal: strategyProposal(),
    });
    expect(duplicateClassification).toBe("none");
    const view = decision as { governanceDecisionId: string; contractVersion: string };
    expect(view.contractVersion).toBe("optimisation-governance/v1");
    expect(env.seed.optimisation_governance_decisions).toHaveLength(1);
    // Approval lookup is tenant-scoped and empty here.
    expect(
      await port.getApprovalForDecision({ userId: 1, governanceDecisionId: view.governanceDecisionId })
    ).toBeNull();
    // The execution gate delegates to F: no approval → not executable.
    const gate = port.assertActionExecutable({
      decision: decision as never,
      approval: null,
      currentPolicyVersion: port.getCurrentPolicyVersion(),
      now: new Date().toISOString(),
    });
    expect(gate.executable).toBe(true); // ALLOW + current policy + unexpired
  });
});
