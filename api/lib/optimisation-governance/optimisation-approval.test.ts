/**
 * R7-F — Approval binding & execution gate acceptance (F4).
 */
import { describe, it, expect } from "vitest";
import {
  assertOptimisationActionExecutable,
  buildOptimisationApprovalCommand,
  buildOptimisationApprovalIdempotencyKey,
  OPTIMISATION_ACTION_APPROVAL_TYPE,
  readOptimisationApprovalBinding,
  validateOptimisationApprovalAuthorizable,
  type OptimisationApprovalView,
} from "./optimisation-approval";
import {
  buildOptimisationProposal,
  evaluateOptimisationGovernance,
  type OptimisationGovernanceDecision,
  type OptimisationGovernanceEvaluationInput,
} from "./optimisation-decision-engine";
import { DEFAULT_OPTIMISATION_GOVERNANCE_POLICY as POLICY } from "./optimisation-policy";
import { deriveApprovalBindingHash } from "./optimisation-governance-contract";

const NOW = "2026-11-05T12:00:00.000Z";

function reviewRequiredDecision(proposalId = "prop-review"): OptimisationGovernanceDecision {
  const input: OptimisationGovernanceEvaluationInput = {
    proposal: buildOptimisationProposal({
      proposalId,
      businessId: 7,
      proposalType: "BUDGET_INCREASE",
      campaignId: null,
      financial: {
        currency: "USD",
        allocationDeltas: [
          { allocationKey: "camp:a", campaignId: null, provider: null, deltaMinor: 5_000 },
        ],
      },
      evidenceHash: "ev:1",
      requestedAt: NOW,
    }),
    userId: 42,
    policy: POLICY,
    currentPolicyVersion: POLICY.policyVersion,
    businessAuthority: { businessId: 7, owningUserId: 42, businessActive: true },
    budget: {
      budgetPeriod: "2026-11",
      currency: "USD",
      approvedTotalBudgetMinor: 1_000_000,
      committedMinor: 400_000,
      reservedMinor: 0,
      supportedProviders: ["meta"],
      lockedAllocationKeys: [],
      stateCapturedAt: "2026-11-05T11:59:00.000Z",
    },
    portfolio: { currentAllocations: { "camp:a": 100_000 }, lastReallocationAtByKey: {} },
    experiment: { activeExperiments: 0 },
    now: NOW,
  };
  const decision = evaluateOptimisationGovernance(input);
  expect(decision.decision).toBe("REVIEW_REQUIRED");
  return decision;
}

function approvedView(
  decision: OptimisationGovernanceDecision,
  overrides: Partial<OptimisationApprovalView> = {}
): OptimisationApprovalView {
  const binding = decision.approvalBinding!;
  return {
    id: 1,
    userId: 42,
    status: "approved",
    context: {
      optimisationGovernanceBinding: {
        contractVersion: "optimisation-governance/approval@v1",
        governanceDecisionId: decision.governanceDecisionId,
        proposalId: decision.proposalId,
        businessId: decision.businessId,
        policyVersion: decision.policyVersion,
        proposalFingerprint: decision.proposalFingerprint,
        approvalBindingHash: binding.approvalBindingHash,
        financialDeltaMinor: decision.financialDeltaMinor,
        financialImpactClass: decision.financialImpactClass,
        expiresAt: binding.expiresAt,
      },
    },
    ...overrides,
  };
}

describe("approval command construction", () => {
  it("builds a deterministic command bound to the exact decision", () => {
    const decision = reviewRequiredDecision();
    const command = buildOptimisationApprovalCommand({ decision, userId: 42 });
    expect(command.approvalType).toBe(OPTIMISATION_ACTION_APPROVAL_TYPE);
    expect(command.idempotencyKey).toBe(
      buildOptimisationApprovalIdempotencyKey(decision.governanceDecisionId)
    );
    expect(command.context.optimisationGovernanceBinding.approvalBindingHash).toBe(
      decision.approvalBinding!.approvalBindingHash
    );
    const again = buildOptimisationApprovalCommand({ decision, userId: 42 });
    expect(again.idempotencyKey).toBe(command.idempotencyKey);
  });

  it("fails closed for non-REVIEW_REQUIRED decisions", () => {
    const decision = reviewRequiredDecision();
    const allowDecision = { ...decision, decision: "ALLOW" as const, approvalBinding: null };
    expect(() => buildOptimisationApprovalCommand({ decision: allowDecision, userId: 42 })).toThrow();
  });
});

describe("execution eligibility gate", () => {
  it("ALLOW decisions are executable until expiry under an unchanged policy", () => {
    const decision = reviewRequiredDecision();
    const allowDecision: OptimisationGovernanceDecision = {
      ...decision,
      decision: "ALLOW",
      approvalRequired: false,
      approvalBinding: null,
      validUntil: "2026-11-06T12:00:00.000Z",
    };
    const verdict = assertOptimisationActionExecutable({
      decision: allowDecision,
      approval: null,
      currentPolicyVersion: POLICY.policyVersion,
      now: NOW,
    });
    expect(verdict.executable).toBe(true);

    const stale = assertOptimisationActionExecutable({
      decision: allowDecision,
      approval: null,
      currentPolicyVersion: "optimisation-governance-policy/v999",
      now: NOW,
    });
    expect(stale.executable).toBe(false);
    if (!stale.executable) expect(stale.reason).toBe("STALE_POLICY_VERSION");

    const expired = assertOptimisationActionExecutable({
      decision: allowDecision,
      approval: null,
      currentPolicyVersion: POLICY.policyVersion,
      now: "2026-11-07T12:00:00.000Z",
    });
    expect(expired.executable).toBe(false);
    if (!expired.executable) expect(expired.reason).toBe("EXPIRED_DECISION");
  });

  it("BLOCK decisions are never executable (AC32)", () => {
    const decision = reviewRequiredDecision();
    const blocked: OptimisationGovernanceDecision = {
      ...decision,
      decision: "BLOCK",
      approvalRequired: false,
      approvalBinding: null,
      validUntil: null,
    };
    const verdict = assertOptimisationActionExecutable({
      decision: blocked,
      approval: approvedView(decision),
      currentPolicyVersion: POLICY.policyVersion,
      now: NOW,
    });
    expect(verdict.executable).toBe(false);
  });

  it("REVIEW_REQUIRED without an approved binding is not executable", () => {
    const decision = reviewRequiredDecision();
    const none = assertOptimisationActionExecutable({
      decision,
      approval: null,
      currentPolicyVersion: POLICY.policyVersion,
      now: NOW,
    });
    expect(none.executable).toBe(false);
    if (!none.executable) expect(none.reason).toBe("APPROVAL_NOT_FOUND");

    const pending = assertOptimisationActionExecutable({
      decision,
      approval: approvedView(decision, { status: "pending" }),
      currentPolicyVersion: POLICY.policyVersion,
      now: NOW,
    });
    expect(pending.executable).toBe(false);
    if (!pending.executable) expect(pending.reason).toBe("APPROVAL_PENDING");
  });

  it("AC11/AC12/AC13/AC14/AC15: forged, cross-proposal, modified and expired approvals fail", () => {
    const decision = reviewRequiredDecision();
    const other = reviewRequiredDecision("prop-other");
    // Cross-proposal replay: approval for a different decision.
    const crossProposal = assertOptimisationActionExecutable({
      decision,
      approval: approvedView(other, { id: 2 }),
      currentPolicyVersion: POLICY.policyVersion,
      now: NOW,
    });
    expect(crossProposal.executable).toBe(false);
    if (!crossProposal.executable) expect(crossProposal.reason).toBe("APPROVAL_BINDING_MISMATCH");

    // Forged binding hash.
    const forged = assertOptimisationActionExecutable({
      decision,
      approval: approvedView(decision, {
        context: {
          optimisationGovernanceBinding: {
            governanceDecisionId: decision.governanceDecisionId,
            policyVersion: decision.policyVersion,
            proposalFingerprint: decision.proposalFingerprint,
            approvalBindingHash: "f".repeat(64),
            expiresAt: decision.approvalBinding!.expiresAt,
          },
        },
      }),
      currentPolicyVersion: POLICY.policyVersion,
      now: NOW,
    });
    expect(forged.executable).toBe(false);
    if (!forged.executable) expect(forged.reason).toBe("APPROVAL_BINDING_MISMATCH");

    // Modified proposal invalidates the approval (fingerprint drift).
    const modifiedDecision = { ...decision, proposalFingerprint: "e".repeat(64) };
    const modified = assertOptimisationActionExecutable({
      decision: modifiedDecision,
      approval: approvedView(decision),
      currentPolicyVersion: POLICY.policyVersion,
      now: NOW,
    });
    expect(modified.executable).toBe(false);

    // Expired approval.
    const baseView = approvedView(decision);
    const baseBinding = (
      baseView.context as {
        optimisationGovernanceBinding: Record<string, unknown>;
      }
    ).optimisationGovernanceBinding;
    const expired = assertOptimisationActionExecutable({
      decision,
      approval: approvedView(decision, {
        context: {
          optimisationGovernanceBinding: {
            ...baseBinding,
            expiresAt: "2026-11-05T11:00:00.000Z",
          },
        },
      }),
      currentPolicyVersion: POLICY.policyVersion,
      now: NOW,
    });
    expect(expired.executable).toBe(false);
    if (!expired.executable) expect(expired.reason).toBe("EXPIRED_APPROVAL");
  });

  it("agent self-approval from a different tenant identity is rejected", () => {
    const decision = reviewRequiredDecision();
    const verdict = assertOptimisationActionExecutable({
      decision,
      approval: approvedView(decision, { userId: 99 }),
      currentPolicyVersion: POLICY.policyVersion,
      now: NOW,
    });
    expect(verdict.executable).toBe(false);
    if (!verdict.executable) expect(verdict.reason).toBe("APPROVAL_BINDING_MISMATCH");
  });

  it("a valid approved binding authorizes execution (F4 happy path)", () => {
    const decision = reviewRequiredDecision();
    const verdict = assertOptimisationActionExecutable({
      decision,
      approval: approvedView(decision),
      currentPolicyVersion: POLICY.policyVersion,
      now: NOW,
    });
    expect(verdict.executable).toBe(true);
    if (verdict.executable) {
      expect(verdict.authorization.decision).toBe("REVIEW_REQUIRED");
      expect(verdict.authorization.approvalRequestId).toBe(1);
    }
  });

  it("human rejection permanently blocks the proposal identity", () => {
    const decision = reviewRequiredDecision();
    const verdict = assertOptimisationActionExecutable({
      decision,
      approval: approvedView(decision, { status: "rejected" }),
      currentPolicyVersion: POLICY.policyVersion,
      now: NOW,
    });
    expect(verdict.executable).toBe(false);
    if (!verdict.executable) {
      expect(verdict.reason).toBe("APPROVAL_REJECTED_BY_HUMAN");
      expect(verdict.permanent).toBe(true);
    }
  });
});

describe("pre-approval authorization validation", () => {
  it("accepts a pending, unexpired, exactly-bound approval", () => {
    const decision = reviewRequiredDecision();
    expect(() =>
      validateOptimisationApprovalAuthorizable({
        approval: approvedView(decision, { status: "pending" }),
        decision,
        currentPolicyVersion: POLICY.policyVersion,
        now: NOW,
      })
    ).not.toThrow();
  });

  it("rejects stale policy, drifted material and expired bindings", () => {
    const decision = reviewRequiredDecision();
    expect(() =>
      validateOptimisationApprovalAuthorizable({
        approval: approvedView(decision, { status: "pending" }),
        decision,
        currentPolicyVersion: "optimisation-governance-policy/v999",
        now: NOW,
      })
    ).toThrow(/STALE_POLICY_VERSION/);

    const drifted = { ...decision, proposalFingerprint: "d".repeat(64) };
    expect(() =>
      validateOptimisationApprovalAuthorizable({
        approval: approvedView(decision, { status: "pending" }),
        decision: drifted,
        currentPolicyVersion: POLICY.policyVersion,
        now: NOW,
      })
    ).toThrow(/APPROVAL_BINDING_MISMATCH/);
  });

  it("binding round-trips through the context parser", () => {
    const decision = reviewRequiredDecision();
    const view = approvedView(decision);
    const binding = readOptimisationApprovalBinding(view.context);
    expect(binding).not.toBeNull();
    expect(binding!.governanceDecisionId).toBe(decision.governanceDecisionId);
    expect(binding!.approvalBindingHash).toBe(
      deriveApprovalBindingHash({
        governanceDecisionId: decision.governanceDecisionId,
        policyVersion: decision.policyVersion!,
        proposalFingerprint: decision.proposalFingerprint,
      })
    );
  });
});
