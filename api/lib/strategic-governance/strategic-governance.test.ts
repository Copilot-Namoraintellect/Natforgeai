/**
 * R8-F — pure module unit tests: contract derivations, evidence trust
 * derivation, risk classification, and the policy registry invariants.
 * No I/O, no database, no network.
 */
import { describe, it, expect } from "vitest";
import {
  GOVERNANCE_DECISION_ID_PATTERN,
  deriveApprovalBindingHash,
  deriveEvaluationFingerprint,
  deriveEvidenceFingerprint,
  deriveGovernanceDecisionId,
  deriveProposalFingerprint,
  sha256Hex,
  canonicalJson,
  STRATEGIC_GOVERNANCE_DECISIONS,
  isStrategicGovernanceDecision,
  STRATEGIC_RISK_CLASSES,
  STRATEGIC_CONFIDENCE_CLASSES,
  STRATEGIC_EVIDENCE_TRUST_CLASSES,
  isStrategicGovernanceReasonCode,
  MAX_STRATEGIC_REASON_CODES,
} from "./strategic-governance-contract";
import {
  deriveEvidenceTrust,
  aggregateEvidence,
  boundConfidence,
  confidenceCeilingForTrust,
} from "./strategic-evidence-governance";
import {
  deriveStrategicRisk,
  EMPTY_DECLARED_IMPACT,
} from "./strategic-risk-classification";
import {
  DEFAULT_STRATEGIC_GOVERNANCE_POLICY,
  assertStrategicGovernancePolicy,
  getStrategicGovernancePolicy,
  listStrategicGovernancePolicies,
} from "./strategic-policy";
import { baseRiskOrdinalForRecommendation } from "./strategic-recommendation-taxonomy";

const NOW_MS = Date.parse("2026-11-10T12:00:00.000Z");
const USER = 42;
const BIZ = 7;

function resolved(overrides: Record<string, unknown> = {}) {
  return {
    ownerUserId: USER,
    businessId: BIZ,
    sourceKind: "INTERNAL_AUTHORITATIVE",
    registeredSourceKey: null,
    corroborationCount: 0,
    contradictionFlag: false,
    observedAt: "2026-11-10T12:00:00.000Z",
    ...overrides,
  };
}

describe("contract derivations", () => {
  it("decision id is deterministic and pattern-valid", () => {
    const input = {
      userId: USER,
      businessId: BIZ,
      proposalId: "p1",
      recommendationType: "STRATEGIC_OBSERVATION",
      policyVersion: "strategic-governance-policy/v1",
      proposalFingerprint: "a".repeat(64),
      evidenceFingerprint: "b".repeat(64),
    };
    const id = deriveGovernanceDecisionId(input);
    expect(id).toBe(deriveGovernanceDecisionId(input));
    expect(id).toMatch(GOVERNANCE_DECISION_ID_PATTERN);
    // Any material change -> new identity.
    expect(deriveGovernanceDecisionId({ ...input, proposalId: "p2" })).not.toBe(id);
  });

  it("proposal/evidence/approval/evaluation fingerprints are stable and field-bound", () => {
    const p = {
      proposalId: "p1",
      businessId: BIZ,
      recommendationType: "STRATEGIC_OBSERVATION",
      summary: "  hello   world ",
      evidenceRefs: ["ev:a"],
      claimedConfidence: "HIGH",
      declaredImpact: { budgetMateriality: false },
    };
    expect(deriveProposalFingerprint(p)).toBe(deriveProposalFingerprint({ ...p }));
    expect(deriveProposalFingerprint(p)).not.toBe(
      deriveProposalFingerprint({ ...p, claimedConfidence: "LOW" })
    );
    const ev = deriveEvidenceFingerprint([{ evidenceRef: "ev:a", trustClass: "UNVERIFIED" }]);
    expect(ev).toMatch(/^[a-f0-9]{64}$/);
    expect(ev).not.toBe(
      deriveEvidenceFingerprint([{ evidenceRef: "ev:a", trustClass: "VERIFIED_EXTERNAL" }])
    );
    const ab = deriveApprovalBindingHash({
      governanceDecisionId: "sgd1:" + "c".repeat(64),
      policyVersion: "strategic-governance-policy/v1",
      proposalFingerprint: "a".repeat(64),
      evidenceFingerprint: "b".repeat(64),
    });
    expect(ab).toMatch(/^[a-f0-9]{64}$/);
    const ef = deriveEvaluationFingerprint({
      governanceDecisionId: "sgd1:" + "c".repeat(64),
      decision: "ALLOW_RECOMMENDATION",
      reasonCodes: ["RECOMMENDATION_ALLOWED_BY_POLICY"],
      strategicRiskClass: "LOW",
      confidenceClass: "HIGH",
      sourceTrustClass: "AUTHORITATIVE_INTERNAL",
      policyVersion: "strategic-governance-policy/v1",
      proposalFingerprint: "a".repeat(64),
      approvalRequired: false,
    });
    expect(ef).toMatch(/^[a-f0-9]{64}$/);
  });

  it("canonicalJson sorts keys and normalises whitespace", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ s: "  x   y " })).toBe(canonicalJson({ s: "x y" }));
    expect(sha256Hex("abc")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("closed vocabularies are exhaustive and reason codes bounded", () => {
    expect(STRATEGIC_GOVERNANCE_DECISIONS).toEqual([
      "ALLOW_RECOMMENDATION",
      "REVIEW_REQUIRED",
      "BLOCK",
    ]);
    expect(isStrategicGovernanceDecision("EXECUTE")).toBe(false);
    expect(STRATEGIC_RISK_CLASSES).toEqual(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
    expect(STRATEGIC_CONFIDENCE_CLASSES).toEqual(["NONE", "LOW", "MEDIUM", "HIGH"]);
    expect(STRATEGIC_EVIDENCE_TRUST_CLASSES).toHaveLength(7);
    expect(isStrategicGovernanceReasonCode("NOT_A_CODE")).toBe(false);
    expect(MAX_STRATEGIC_REASON_CODES).toBe(8);
  });
});

describe("evidence trust derivation (F3)", () => {
  const base = {
    evidenceRef: "ev:a",
    userId: USER,
    businessId: BIZ,
    trustedSourceKeys: new Set<string>(),
    nowMs: NOW_MS,
    maxEvidenceAgeMs: 30 * 24 * 60 * 60 * 1000,
  };

  it("absent resolution is cross-tenant evidence (fail closed)", () => {
    const d = deriveEvidenceTrust({ ...base, resolved: null });
    expect(d.trustClass).toBe("MALFORMED");
    expect(d.notes).toContain("CROSS_TENANT_EVIDENCE");
  });

  it("cross-tenant and cross-business records fail closed", () => {
    expect(
      deriveEvidenceTrust({ ...base, resolved: resolved({ ownerUserId: USER + 1 }) }).trustClass
    ).toBe("MALFORMED");
    expect(
      deriveEvidenceTrust({ ...base, resolved: resolved({ businessId: BIZ + 1 }) }).notes
    ).toContain("CROSS_TENANT_EVIDENCE");
  });

  it("model-generated is never source truth", () => {
    const d = deriveEvidenceTrust({ ...base, resolved: resolved({ sourceKind: "MODEL_GENERATED" }) });
    expect(d.trustClass).toBe("UNVERIFIED");
    expect(d.notes).toContain("MODEL_GENERATED_NOT_SOURCE_TRUTH");
  });

  it("contradiction stays visible and poisons confidence", () => {
    const d = deriveEvidenceTrust({
      ...base,
      resolved: resolved({ sourceKind: "EXTERNAL_SOURCE", corroborationCount: 3, contradictionFlag: true }),
    });
    expect(d.trustClass).toBe("CONTRADICTED");
    const agg = aggregateEvidence({ derived: [d] });
    expect(agg.hasContradiction).toBe(true);
    expect(agg.confidenceCeiling).toBe("NONE");
  });

  it("registered source -> verified; corroboration tiers map correctly", () => {
    const verified = deriveEvidenceTrust({
      ...base,
      trustedSourceKeys: new Set(["reg:x"]),
      resolved: resolved({ sourceKind: "EXTERNAL_SOURCE", registeredSourceKey: "reg:x" }),
    });
    expect(verified.trustClass).toBe("VERIFIED_EXTERNAL");

    const corroborated = deriveEvidenceTrust({
      ...base,
      resolved: resolved({ sourceKind: "EXTERNAL_SOURCE", corroborationCount: 2 }),
    });
    expect(corroborated.trustClass).toBe("CORROBORATED_EXTERNAL");

    const single = deriveEvidenceTrust({
      ...base,
      resolved: resolved({ sourceKind: "EXTERNAL_SOURCE", corroborationCount: 1 }),
    });
    expect(single.trustClass).toBe("SINGLE_EXTERNAL_SOURCE");

    const none = deriveEvidenceTrust({
      ...base,
      resolved: resolved({ sourceKind: "EXTERNAL_SOURCE", corroborationCount: 0 }),
    });
    expect(none.trustClass).toBe("UNVERIFIED");
  });

  it("staleness is flagged", () => {
    const stale = deriveEvidenceTrust({
      ...base,
      resolved: resolved({ observedAt: "2026-09-01T00:00:00.000Z" }),
    });
    expect(stale.stale).toBe(true);
  });

  it("aggregate picks best non-malformed trust and bounds confidence", () => {
    const internal = deriveEvidenceTrust({ ...base, resolved: resolved() });
    const single = deriveEvidenceTrust({
      ...base,
      evidenceRef: "ev:b",
      resolved: resolved({ sourceKind: "EXTERNAL_SOURCE", corroborationCount: 1 }),
    });
    const agg = aggregateEvidence({ derived: [single, internal] });
    expect(agg.sourceTrustClass).toBe("AUTHORITATIVE_INTERNAL");
    expect(confidenceCeilingForTrust("AUTHORITATIVE_INTERNAL")).toBe("HIGH");
    expect(confidenceCeilingForTrust("SINGLE_EXTERNAL_SOURCE")).toBe("LOW");
    expect(boundConfidence("HIGH", "LOW")).toBe("LOW");
    expect(boundConfidence("LOW", "HIGH")).toBe("LOW");
  });
});

describe("strategic risk classification (F4)", () => {
  it("base risk by type, monotonic upward only", () => {
    expect(baseRiskOrdinalForRecommendation("STRATEGIC_OBSERVATION")).toBe(0);
    expect(baseRiskOrdinalForRecommendation("BUSINESS_PRIORITY_RECOMMENDATION")).toBe(2);
    const raised = deriveStrategicRisk({
      recommendationType: "STRATEGIC_OBSERVATION",
      declaredImpact: { ...EMPTY_DECLARED_IMPACT, budgetMateriality: true, highUncertainty: true },
      weakExternalEvidenceReliance: false,
      injectionSuspected: false,
    });
    expect(raised.riskClass).toBe("HIGH");
    expect(raised.raisedByDeclaration).toBe(true);
    // Declarations never lower: a HIGH-priority type stays >= HIGH.
    const high = deriveStrategicRisk({
      recommendationType: "BUSINESS_PRIORITY_RECOMMENDATION",
      declaredImpact: EMPTY_DECLARED_IMPACT,
      weakExternalEvidenceReliance: false,
      injectionSuspected: false,
    });
    expect(high.riskClass).toBe("HIGH");
  });

  it("injection suspicion raises risk toward CRITICAL but never widens authority", () => {
    const r = deriveStrategicRisk({
      recommendationType: "STRATEGIC_OBSERVATION",
      declaredImpact: EMPTY_DECLARED_IMPACT,
      weakExternalEvidenceReliance: false,
      injectionSuspected: true,
    });
    expect(r.riskClass).toBe("HIGH");
  });
});

describe("policy registry invariants", () => {
  it("default policy validates and is conservative", () => {
    expect(() => assertStrategicGovernancePolicy(DEFAULT_STRATEGIC_GOVERNANCE_POLICY)).not.toThrow();
    expect(DEFAULT_STRATEGIC_GOVERNANCE_POLICY.riskDispositions.CRITICAL).toBe("BLOCK");
    expect(DEFAULT_STRATEGIC_GOVERNANCE_POLICY.riskDispositions.LOW).toBe("ALLOW_RECOMMENDATION");
    expect(DEFAULT_STRATEGIC_GOVERNANCE_POLICY.unknownTypeDisposition).toBe("BLOCK");
  });

  it("unknown version fails closed; default resolves without an argument", () => {
    expect(getStrategicGovernancePolicy().policyVersion).toBe(
      DEFAULT_STRATEGIC_GOVERNANCE_POLICY.policyVersion
    );
    expect(() => getStrategicGovernancePolicy("strategic-governance-policy/v999")).toThrow();
  });

  it("lists default first", () => {
    const list = listStrategicGovernancePolicies();
    expect(list[0].policyVersion).toBe(DEFAULT_STRATEGIC_GOVERNANCE_POLICY.policyVersion);
  });
});
