/**
 * WBS-R5-E6 — Approval / escalation authority acceptance.
 */
import { describe, it, expect } from "vitest";
import {
  buildMarketingActionApprovalCommand,
  buildMarketingActionApprovalIdempotencyKey,
  assertMarketingActionExecutable,
  validateMarketingActionApprovalAuthorizable,
  MARKETING_ACTION_APPROVAL_CONTRACT_VERSION,
  MarketingActionApprovalError,
  type MarketingActionApprovalView,
} from "./marketing-action-approval";
import { evaluateMarketingActionPolicy, type PolicyDecision } from "./decision-engine";
import { buildMarketingActionRequest, type MarketingActionRequestInput } from "./action-request";
import {
  buildBusinessPolicyConfig,
  buildDefaultPolicyConfig,
  buildVersionedPolicy,
} from "./policy-model";
import type { AuthoritativeIntelligence } from "./risk-classification";
import type { CostAuthoritySnapshot, VolumeAuthoritySnapshot } from "./cost-governance";

const NOW = "2026-06-28T12:00:00.000Z";
const LATER = "2026-06-28T12:10:00.000Z";
const AFTER_TTL = "2026-06-28T12:16:00.000Z";

const POLICY = buildVersionedPolicy(
  10,
  1,
  buildBusinessPolicyConfig({
    ...buildDefaultPolicyConfig(),
    actions: {
      autonomous: ["reply_publicly"],
      requireApproval: ["reply_privately"],
      prohibited: [],
    },
  } as never)
);

const PRAISE_INTEL: AuthoritativeIntelligence = {
  sourceInterpretationId: "interp-1",
  intelligenceVersion: "iv-1",
  sentiment: "positive",
  intentClass: "praise",
  confidence: 0.95,
  containsPersonalData: false,
  injectionSuspected: false,
};

const REPLY_PRIVATE: MarketingActionRequestInput = {
  actionRequestId: "ar1:p-1",
  businessId: 10,
  sourceSignalId: "sig-1",
  sourceInterpretationId: "interp-1",
  actionType: "reply_privately",
  platform: "instagram",
  providerAccountBinding: { integrationId: 4, platform: "instagram", externalAccountRef: "p1" },
  campaignId: 55,
  publicationId: null,
  estimatedCostClass: "low",
  requestedAt: NOW,
  contextVersion: "ctx:1",
};

const COST: CostAuthoritySnapshot = {
  walletBalance: 100,
  openReservationCredits: 0,
  dailySpend: 0,
  monthlySpend: 0,
  dailySystemLimit: 1000,
  monthlySystemLimit: 10000,
  walletSpendLimit: null,
  periodAutonomousSpend: 0,
};
const VOLUME: VolumeAuthoritySnapshot = { actionsExecutedToday: 0, channelActionsToday: {} };

function evaluate(request: Partial<MarketingActionRequestInput> = {}, intel: Partial<AuthoritativeIntelligence> = {}) {
  return evaluateMarketingActionPolicy({
    request: buildMarketingActionRequest({ ...REPLY_PRIVATE, ...request }),
    userId: 7,
    policy: POLICY,
    intelligence: { ...PRAISE_INTEL, ...intel },
    cost: COST,
    volume: VOLUME,
    providerRate: { rateLimited: false },
    providerCapability: { bindingVerified: true, capabilityAvailable: true },
    now: NOW,
  });
}

function approvalView(decision: PolicyDecision, status: MarketingActionApprovalView["status"] = "approved"): MarketingActionApprovalView {
  const command = buildMarketingActionApprovalCommand({ decision, userId: 7, mode: "approval" });
  return { id: 501, status, context: command.context };
}

describe("E6 approval command construction", () => {
  it("builds a deterministic approval command for a REQUIRE_APPROVAL decision", () => {
    const decision = evaluate();
    expect(decision.decision).toBe("REQUIRE_APPROVAL");
    const command = buildMarketingActionApprovalCommand({ decision, userId: 7, mode: "approval" });
    expect(command.approvalType).toBe("marketing_action");
    expect(command.idempotencyKey).toBe(buildMarketingActionApprovalIdempotencyKey(decision.policyDecisionId));
    expect(command.context.marketingActionBinding.policyDecisionId).toBe(decision.policyDecisionId);
    expect(command.context.marketingActionBinding.policyVersion).toBe(POLICY.policyVersion);
    expect(command.context.marketingActionBinding.contextVersion).toBe("ctx:1");
    expect(command.context.marketingActionBinding.mode).toBe("approval");
    expect(command.campaignId).toBe(55);
    expect(command.riskLevel).toBe("low");
  });

  it("is idempotent per decision: same decision -> same key and binding", () => {
    const decision = evaluate();
    const a = buildMarketingActionApprovalCommand({ decision, userId: 7, mode: "approval" });
    const b = buildMarketingActionApprovalCommand({ decision, userId: 7, mode: "approval" });
    expect(a.idempotencyKey).toBe(b.idempotencyKey);
    expect(a.context).toEqual(b.context);
  });

  it("fails closed building an approval command from an ALLOW decision", () => {
    const decision = evaluate({ actionRequestId: "ar1:pub-1", actionType: "reply_publicly" });
    expect(decision.decision).toBe("ALLOW_AUTONOMOUS");
    expect(() => buildMarketingActionApprovalCommand({ decision, userId: 7, mode: "approval" })).toThrowError(
      MarketingActionApprovalError
    );
  });

  it("builds an escalation command for ESCALATE decisions", () => {
    const decision = evaluate({}, { intentClass: "severe_complaint" });
    expect(decision.decision).toBe("ESCALATE");
    const command = buildMarketingActionApprovalCommand({ decision, userId: 7, mode: "escalation" });
    expect(command.context.marketingActionBinding.mode).toBe("escalation");
    expect(command.riskLevel).toBe("high");
  });
});

describe("E6 execution gate", () => {
  it("ALLOW_AUTONOMOUS executes without approval until expiry", () => {
    const decision = evaluate({ actionRequestId: "ar1:pub-2", actionType: "reply_publicly" });
    const verdict = assertMarketingActionExecutable({ decision, approval: null, currentPolicyVersion: POLICY.policyVersion, now: LATER });
    expect(verdict.executable).toBe(true);
    if (verdict.executable) {
      expect(verdict.authorization.decision).toBe("ALLOW_AUTONOMOUS");
      expect(verdict.authorization.approvalRequestId).toBeNull();
    }
  });

  it("ALLOW_AUTONOMOUS fails closed after expiry", () => {
    const decision = evaluate({ actionRequestId: "ar1:pub-3", actionType: "reply_publicly" });
    const verdict = assertMarketingActionExecutable({ decision, approval: null, currentPolicyVersion: POLICY.policyVersion, now: AFTER_TTL });
    expect(verdict.executable).toBe(false);
    if (!verdict.executable) expect(verdict.reason).toBe("EXPIRED_DECISION");
  });

  it("REQUIRE_APPROVAL cannot execute without an approval (no autonomous bypass)", () => {
    const decision = evaluate();
    const verdict = assertMarketingActionExecutable({ decision, approval: null, currentPolicyVersion: POLICY.policyVersion, now: LATER });
    expect(verdict.executable).toBe(false);
    if (!verdict.executable) expect(verdict.reason).toBe("APPROVAL_NOT_FOUND");
  });

  it("REQUIRE_APPROVAL cannot execute while approval is pending", () => {
    const decision = evaluate();
    const verdict = assertMarketingActionExecutable({
      decision,
      approval: approvalView(decision, "pending"),
      currentPolicyVersion: POLICY.policyVersion,
      now: LATER,
    });
    expect(verdict.executable).toBe(false);
    if (!verdict.executable) expect(verdict.reason).toBe("APPROVAL_PENDING");
  });

  it("approved binding authorizes exactly this action/policy version", () => {
    const decision = evaluate();
    const verdict = assertMarketingActionExecutable({
      decision,
      approval: approvalView(decision),
      currentPolicyVersion: POLICY.policyVersion,
      now: LATER,
    });
    expect(verdict.executable).toBe(true);
    if (verdict.executable) {
      expect(verdict.authorization.approvalRequestId).toBe(501);
      expect(verdict.authorization.billingIdentity).toBe(decision.billingIdentity);
    }
  });

  it("rejection permanently blocks the action identity", () => {
    const decision = evaluate();
    const verdict = assertMarketingActionExecutable({
      decision,
      approval: approvalView(decision, "rejected"),
      currentPolicyVersion: POLICY.policyVersion,
      now: LATER,
    });
    expect(verdict.executable).toBe(false);
    if (!verdict.executable) {
      expect(verdict.reason).toBe("ACTION_REJECTED_BY_HUMAN");
      expect(verdict.permanent).toBe(true);
    }
  });

  it("stale approval fails after a policy change (new version)", () => {
    const decision = evaluate();
    const verdict = assertMarketingActionExecutable({
      decision,
      approval: approvalView(decision),
      currentPolicyVersion: "v2-different00",
      now: LATER,
    });
    expect(verdict.executable).toBe(false);
    if (!verdict.executable) expect(verdict.reason).toBe("STALE_POLICY_VERSION");
  });

  it("changed context invalidates the authorization", () => {
    const decision = evaluate();
    const view = approvalView(decision);
    const tampered = {
      ...view,
      context: {
        marketingActionBinding: {
          ...((view.context as { marketingActionBinding: object }).marketingActionBinding),
          contextVersion: "ctx:TAMPERED",
        },
      },
    };
    const verdict = assertMarketingActionExecutable({
      decision,
      approval: tampered,
      currentPolicyVersion: POLICY.policyVersion,
      now: LATER,
    });
    expect(verdict.executable).toBe(false);
    if (!verdict.executable) expect(verdict.reason).toBe("CONTEXT_VERSION_MISMATCH");
  });

  it("expired binding fails closed", () => {
    const decision = evaluate();
    const verdict = assertMarketingActionExecutable({
      decision,
      approval: approvalView(decision),
      currentPolicyVersion: POLICY.policyVersion,
      now: AFTER_TTL,
    });
    expect(verdict.executable).toBe(false);
    if (!verdict.executable) expect(verdict.reason).toBe("EXPIRED_DECISION");
  });

  it("escalation never executes, even with an approved operator item", () => {
    const decision = evaluate({}, { intentClass: "severe_complaint" });
    const command = buildMarketingActionApprovalCommand({ decision, userId: 7, mode: "escalation" });
    const verdict = assertMarketingActionExecutable({
      decision,
      approval: { id: 601, status: "approved", context: command.context },
      currentPolicyVersion: POLICY.policyVersion,
      now: LATER,
    });
    expect(verdict.executable).toBe(false);
    if (!verdict.executable) expect(verdict.reason).toBe("ESCALATION_REQUIRES_OPERATOR");
  });

  it("duplicate approval callbacks converge: the same approved binding keeps authorizing the same action, not new ones", () => {
    const decision = evaluate();
    const view = approvalView(decision);
    const first = assertMarketingActionExecutable({ decision, approval: view, currentPolicyVersion: POLICY.policyVersion, now: LATER });
    const second = assertMarketingActionExecutable({ decision, approval: view, currentPolicyVersion: POLICY.policyVersion, now: LATER });
    expect(first).toEqual(second);
    // The binding does not authorize a different action request identity.
    const otherDecision = evaluate({ actionRequestId: "ar1:p-OTHER" });
    const cross = assertMarketingActionExecutable({ decision: otherDecision, approval: view, currentPolicyVersion: POLICY.policyVersion, now: LATER });
    expect(cross.executable).toBe(false);
    if (!cross.executable) expect(cross.reason).toBe("APPROVAL_BINDING_MISMATCH");
  });
});

describe("E6 pre-approval validation", () => {
  it("authorizes a fresh pending approval bound to the exact decision", () => {
    const decision = evaluate();
    const view = approvalView(decision, "pending");
    expect(() =>
      validateMarketingActionApprovalAuthorizable({
        approval: view,
        decision,
        currentPolicyVersion: POLICY.policyVersion,
        now: LATER,
      })
    ).not.toThrow();
  });

  it("fails closed on stale policy version at authorisation time", () => {
    const decision = evaluate();
    const view = approvalView(decision, "pending");
    expect(() =>
      validateMarketingActionApprovalAuthorizable({
        approval: view,
        decision,
        currentPolicyVersion: "v2-other",
        now: LATER,
      })
    ).toThrowError(/STALE_POLICY_VERSION/);
  });

  it("fails closed on expired binding", () => {
    const decision = evaluate();
    const view = approvalView(decision, "pending");
    expect(() =>
      validateMarketingActionApprovalAuthorizable({
        approval: view,
        decision,
        currentPolicyVersion: POLICY.policyVersion,
        now: AFTER_TTL,
      })
    ).toThrowError(/expired/);
  });

  it("fails closed when the bound decision no longer exists", () => {
    const decision = evaluate();
    const view = approvalView(decision, "pending");
    expect(() =>
      validateMarketingActionApprovalAuthorizable({
        approval: view,
        decision: null,
        currentPolicyVersion: POLICY.policyVersion,
        now: LATER,
      })
    ).toThrowError(MarketingActionApprovalError);
  });

  it("carries the contract version in the binding lineage", () => {
    const decision = evaluate();
    const command = buildMarketingActionApprovalCommand({ decision, userId: 7, mode: "approval" });
    expect(command.context.marketingActionBinding.contractVersion).toBe(
      MARKETING_ACTION_APPROVAL_CONTRACT_VERSION
    );
  });
});
