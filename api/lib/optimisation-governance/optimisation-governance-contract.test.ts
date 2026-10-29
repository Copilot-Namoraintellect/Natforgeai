/**
 * R7-F — Optimisation governance contract acceptance (F1 vocabulary).
 */
import { describe, it, expect } from "vitest";
import {
  canonicalJson,
  deriveApprovalBindingHash,
  deriveEvaluationFingerprint,
  deriveGovernanceDecisionId,
  deriveProposalFingerprint,
  EvaluateOptimisationGovernanceInputSchema,
  GetGovernanceDecisionInputSchema,
  GOVERNANCE_DECISION_ID_PATTERN,
  isOptimisationFinancialImpactClass,
  isOptimisationGovernanceDecision,
  isOptimisationGovernanceReasonCode,
  isOptimisationRiskTier,
  ListGovernanceDecisionsInputSchema,
  MAX_GOVERNANCE_REASON_CODES,
  OPTIMISATION_FINANCIAL_IMPACT_CLASSES,
  OPTIMISATION_GOVERNANCE_DECISIONS,
  OPTIMISATION_GOVERNANCE_REASON_CODES,
  OptimisationGovernanceValidationError,
  RecordGovernanceRecoveryInputSchema,
} from "./optimisation-governance-contract";
import { buildOptimisationApprovalIdempotencyKey } from "./optimisation-approval";

describe("F1 closed governance vocabularies", () => {
  it("uses exactly ALLOW / REVIEW_REQUIRED / BLOCK", () => {
    expect(OPTIMISATION_GOVERNANCE_DECISIONS).toEqual(["ALLOW", "REVIEW_REQUIRED", "BLOCK"]);
    expect(isOptimisationGovernanceDecision("ALLOW")).toBe(true);
    expect(isOptimisationGovernanceDecision("DENY")).toBe(false);
  });

  it("financial impact classes are ordered recommendation -> irreversible", () => {
    expect(OPTIMISATION_FINANCIAL_IMPACT_CLASSES).toEqual([
      "RECOMMENDATION_ONLY",
      "REALLOCATION_WITHIN_APPROVED_TOTAL",
      "TOTAL_BUDGET_INCREASE",
      "NEW_FINANCIAL_COMMITMENT",
      "IRREVERSIBLE_EXTERNAL_SPEND",
    ]);
    expect(isOptimisationFinancialImpactClass("TOTAL_BUDGET_INCREASE")).toBe(true);
    expect(isOptimisationFinancialImpactClass("FREE_MONEY")).toBe(false);
  });

  it("risk tiers match the repository ordering", () => {
    expect(isOptimisationRiskTier("low")).toBe(true);
    expect(isOptimisationRiskTier("critical")).toBe(true);
    expect(isOptimisationRiskTier("extreme")).toBe(false);
  });

  it("reason codes are a closed vocabulary with a hard bound", () => {
    expect(OPTIMISATION_GOVERNANCE_REASON_CODES.length).toBeGreaterThan(20);
    expect(MAX_GOVERNANCE_REASON_CODES).toBe(8);
    for (const code of OPTIMISATION_GOVERNANCE_REASON_CODES) {
      expect(isOptimisationGovernanceReasonCode(code)).toBe(true);
    }
    expect(isOptimisationGovernanceReasonCode("WHATEVER")).toBe(false);
  });
});

describe("deterministic identities", () => {
  const material = {
    proposalId: "prop-1",
    businessId: 7,
    proposalType: "BUDGET_REALLOCATE",
    financial: { currency: "USD", allocationDeltas: [] },
    experiment: null,
    portfolio: null,
    learningReference: null,
    campaignId: null,
    evidenceHash: "ev:1",
  };

  it("proposal fingerprint is stable and material-sensitive", () => {
    const fp1 = deriveProposalFingerprint(material);
    expect(fp1).toMatch(/^[a-f0-9]{64}$/);
    expect(deriveProposalFingerprint(material)).toBe(fp1);
    expect(deriveProposalFingerprint({ ...material, evidenceHash: "ev:2" })).not.toBe(fp1);
  });

  it("governance decision id carries the ogd1 prefix and is deterministic", () => {
    const id1 = deriveGovernanceDecisionId({
      userId: 1,
      businessId: 7,
      proposalId: "prop-1",
      proposalType: "BUDGET_REALLOCATE",
      policyVersion: "optimisation-governance-policy/v1",
      proposalFingerprint: deriveProposalFingerprint(material),
      evidenceHash: "ev:1",
    });
    expect(id1).toMatch(GOVERNANCE_DECISION_ID_PATTERN);
    const id2 = deriveGovernanceDecisionId({
      userId: 1,
      businessId: 7,
      proposalId: "prop-1",
      proposalType: "BUDGET_REALLOCATE",
      policyVersion: "optimisation-governance-policy/v1",
      proposalFingerprint: deriveProposalFingerprint(material),
      evidenceHash: "ev:1",
    });
    expect(id1).toBe(id2);
  });

  it("approval binding hash binds decision + policy + proposal material", () => {
    const base = {
      governanceDecisionId: "ogd1:" + "a".repeat(64),
      policyVersion: "optimisation-governance-policy/v1",
      proposalFingerprint: "f".repeat(64),
    };
    expect(deriveApprovalBindingHash(base)).toMatch(/^[a-f0-9]{64}$/);
    expect(deriveApprovalBindingHash(base)).not.toBe(
      deriveApprovalBindingHash({ ...base, policyVersion: "optimisation-governance-policy/v2" })
    );
  });

  it("canonicalJson is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });
});

describe("router input schemas reject authority smuggling", () => {
  it("evaluate input is strict and carries no authority fields", () => {
    const parsed = EvaluateOptimisationGovernanceInputSchema.safeParse({
      proposal: { proposalId: "p1" },
      policyVersion: "optimisation-governance-policy/v1",
    });
    expect(parsed.success).toBe(true);
    const withAuthority = EvaluateOptimisationGovernanceInputSchema.safeParse({
      proposal: { proposalId: "p1" },
      decision: "ALLOW",
    });
    expect(withAuthority.success).toBe(false);
  });

  it("list/get inputs validate id patterns", () => {
    expect(
      GetGovernanceDecisionInputSchema.safeParse({ governanceDecisionId: "nope" }).success
    ).toBe(false);
    expect(
      ListGovernanceDecisionsInputSchema.safeParse({ decision: "BLOCK" }).success
    ).toBe(true);
    expect(
      ListGovernanceDecisionsInputSchema.safeParse({ decision: "MAYBE" }).success
    ).toBe(false);
  });

  it("recovery input is limited to the closed safe vocabulary", () => {
    expect(
      RecordGovernanceRecoveryInputSchema.safeParse({
        governanceDecisionId: "ogd1:" + "a".repeat(64),
        action: "forceAllow",
        note: "x",
      }).success
    ).toBe(false);
    expect(
      RecordGovernanceRecoveryInputSchema.safeParse({
        governanceDecisionId: "ogd1:" + "a".repeat(64),
        action: "operator_acknowledged",
        note: "reviewed",
      }).success
    ).toBe(true);
  });

  it("client authority field rejection surfaces as a typed error", () => {
    const err = new OptimisationGovernanceValidationError(
      "CLIENT_AUTHORITY_FIELD_REJECTED",
      "Field \"approved\" is server-side authority"
    );
    expect(err.code).toBe("CLIENT_AUTHORITY_FIELD_REJECTED");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("approval idempotency key derivation stays module-local", () => {
  it("derives a deterministic ogov1 key", () => {
    const key = buildOptimisationApprovalIdempotencyKey("ogd1:" + "b".repeat(64));
    expect(key.startsWith("ogov1:")).toBe(true);
    expect(buildOptimisationApprovalIdempotencyKey("ogd1:" + "b".repeat(64))).toBe(key);
    expect(() => buildOptimisationApprovalIdempotencyKey("")).toThrow();
  });

  it("evaluation fingerprint covers decision material", () => {
    const fp = deriveEvaluationFingerprint({
      governanceDecisionId: "ogd1:" + "c".repeat(64),
      decision: "ALLOW",
      reasonCodes: ["PROPOSAL_ALLOWED_BY_POLICY"],
      riskClass: "low",
      financialImpactClass: "RECOMMENDATION_ONLY",
      policyVersion: "optimisation-governance-policy/v1",
      proposalFingerprint: "f".repeat(64),
      approvalRequired: false,
    });
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
  });
});
