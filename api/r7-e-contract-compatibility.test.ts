/**
 * R7-E — Upstream contract compatibility acceptance.
 *
 * The R7 sibling streams are consumed through branch refs only (never merged),
 * so compatibility is proven here against the PUBLISHED contract constants:
 * R7-A outcome vocabulary, R7-B credit semantics, R7-C learning vocabulary,
 * R7-F governance vocabulary/policy. These assertions fail the moment this
 * stream drifts from a frozen upstream contract shape.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb must not fall back to a real connection in r7-e compatibility tests");
  }),
}));

import { evaluateEvidence } from "./lib/budget-portfolio/evidence-model";
import {
  GOVERNANCE_DECISION_ID_PATTERN,
  R7F_CONTRACT_VERSION,
  R7F_DECISIONS,
  R7F_DEFAULT_POLICY,
  validateGovernanceDecisionView,
} from "./lib/budget-portfolio/governance-seam";
import { buildPortfolioSnapshot, validatePortfolioAuthorityMaterial } from "./lib/budget-portfolio/portfolio-snapshot";
import { ProposeOptimisationInputSchema } from "./lib/budget-portfolio/budget-portfolio-contract";
import fs from "fs";

const NOW = "2026-11-10T12:00:00.000Z";

describe("R7-E upstream contract compatibility", () => {
  it("R7-B: credit is consumed in 100000-bps semantics (TOTAL_CREDIT_BPS)", () => {
    // R7-B contract §8: credit is integer basis points, TOTAL_CREDIT_BPS = 100000.
    const bundle: any = {
      outcomes: [
        { outcomeId: "out1:c", businessId: 1, outcomeStatus: "VERIFIED", valueType: "MONETARY", amountMinor: 100_000, occurredAt: "2026-11-09T09:00:00.000Z" },
      ],
      attributions: [
        {
          attributionId: "atr1:c",
          businessId: 1,
          outcomeId: "out1:c",
          outcomeStatus: "VERIFIED",
          confidenceClass: "HIGH",
          evidenceClass: "DIRECT_LINKAGE",
          touchpoints: [{ type: "CAMPAIGN", sourceIdentity: "1", creditBps: 50_000 }],
        },
      ],
      learnings: [],
    };
    const evaluation = evaluateEvidence({ businessId: 1, bundle, allocatableKeys: ["camp:1"], now: NOW });
    // 50% of 100000 bps of a 100000-minor outcome ⇒ 50000 minor credited.
    // mass = 50000 × status4 × conf4 × evidence4 × recency3 (single event ≤ 40% cap:
    // totalRaw = 50000×192 = 9.6e6; cap = 3.84e6 → capped).
    expect(evaluation.byKey["camp:1"]!.evidenceMass).toBe(3_840_000);
    expect(evaluation.byKey["camp:1"]!.outcomeCount).toBe(1);
  });

  it("R7-B: confidence/evidence-class vocabulary consumed verbatim", () => {
    for (const confidenceClass of ["HIGH", "MEDIUM", "LOW", "NONE"]) {
      const bundle: any = {
        outcomes: [{ outcomeId: "out1:v", businessId: 1, outcomeStatus: "VERIFIED", valueType: "MONETARY", amountMinor: 10_000, occurredAt: "2026-11-09T09:00:00.000Z" }],
        attributions: [{
          attributionId: "atr1:v", businessId: 1, outcomeId: "out1:v", outcomeStatus: "VERIFIED",
          confidenceClass, evidenceClass: "DIRECT_LINKAGE",
          touchpoints: [{ type: "CAMPAIGN", sourceIdentity: "1", creditBps: 100_000 }],
        }],
        learnings: [],
      };
      const evaluation = evaluateEvidence({ businessId: 1, bundle, allocatableKeys: ["camp:1"], now: NOW });
      if (confidenceClass === "NONE") {
        expect(evaluation.byKey["camp:1"]!.score).toBe(0);
      } else {
        expect(evaluation.byKey["camp:1"]!.score).toBeGreaterThan(0);
      }
    }
  });

  it("R7-A: outcome status + terminal lifecycle handled (VERIFIED/PROVISIONAL/OBSERVED; REVERSED excluded)", () => {
    for (const [status, usable] of [
      ["VERIFIED", true],
      ["PROVISIONAL", true],
      ["OBSERVED", true],
      ["REVERSED", false],
      ["CANCELLED", false],
      ["SUPERSEDED", false],
    ] as const) {
      const bundle: any = {
        outcomes: [{ outcomeId: "out1:s", businessId: 1, outcomeStatus: status, valueType: "MONETARY", amountMinor: 10_000, occurredAt: "2026-11-09T09:00:00.000Z" }],
        attributions: [{
          attributionId: "atr1:s", businessId: 1, outcomeId: "out1:s", outcomeStatus: status,
          confidenceClass: "HIGH", evidenceClass: "DIRECT_LINKAGE",
          touchpoints: [{ type: "CAMPAIGN", sourceIdentity: "1", creditBps: 100_000 }],
        }],
        learnings: [],
      };
      const evaluation = evaluateEvidence({ businessId: 1, bundle, allocatableKeys: ["camp:1"], now: NOW });
      expect(evaluation.byKey["camp:1"]!.score > 0).toBe(usable);
    }
  });

  it("R7-C: learning vocabulary consumed verbatim (confidence + status + freshness)", () => {
    for (const [confidenceClass, positive] of [["STRONG", true], ["MODERATE", true], ["WEAK", true], ["INSUFFICIENT_EVIDENCE", false]] as const) {
      const bundle: any = {
        outcomes: [],
        attributions: [],
        learnings: [{
          learningId: "lrn1:x", businessId: 1, subjectType: "CAMPAIGN", subjectId: "1",
          status: "SUPPORTED", confidenceClass, supportCount: 1, contradictionCount: 0,
          freshness: { stale: false, contradictionUnresolved: false }, derivedAt: NOW,
        }],
      };
      const evaluation = evaluateEvidence({ businessId: 1, bundle, allocatableKeys: ["camp:1"], now: NOW });
      expect(evaluation.byKey["camp:1"]!.score > 0).toBe(positive);
    }
    // CONTRADICTED / SUPERSEDED / stale learning contributes nothing and flags.
    for (const [status, stale, flag] of [
      ["CONTRADICTED", false, "LEARNING_CONTRADICTED"],
      ["SUPERSEDED", false, null],
      ["SUPPORTED", true, null],
    ] as const) {
      const bundle: any = {
        outcomes: [],
        attributions: [],
        learnings: [{
          learningId: "lrn1:y", businessId: 1, subjectType: "CAMPAIGN", subjectId: "1",
          status, confidenceClass: "STRONG", supportCount: 2, contradictionCount: status === "CONTRADICTED" ? 1 : 0,
          freshness: { stale, contradictionUnresolved: status === "CONTRADICTED" }, derivedAt: NOW,
        }],
      };
      const evaluation = evaluateEvidence({ businessId: 1, bundle, allocatableKeys: ["camp:1"], now: NOW });
      expect(evaluation.byKey["camp:1"]!.score).toBe(0);
      if (flag) expect(evaluation.reasonCodes).toContain(flag);
    }
  });

  it("R7-F: governance vocabulary + default policy consumed verbatim", () => {
    expect(R7F_DECISIONS).toEqual(["ALLOW", "REVIEW_REQUIRED", "BLOCK"]);
    expect(R7F_CONTRACT_VERSION).toBe("optimisation-governance/v1");
    expect(R7F_DEFAULT_POLICY.policyVersion).toBe("optimisation-governance-policy/v1");
    // Financial knobs aligned with the published default policy.
    expect(R7F_DEFAULT_POLICY.financial.autonomousReallocationCapMinor).toBe(50_000);
    expect(R7F_DEFAULT_POLICY.financial.maxAutonomousReallocationFraction).toBe(0.05);
    expect(R7F_DEFAULT_POLICY.financial.allowAutonomousTotalIncrease).toBe(false);
    expect(R7F_DEFAULT_POLICY.financial.staleBudgetStateMs).toBe(15 * 60 * 1000);
    expect(R7F_DEFAULT_POLICY.portfolio.maxConcentrationFraction).toBe(0.5);
    expect(R7F_DEFAULT_POLICY.portfolio.maxSingleShiftFraction).toBe(0.2);
    expect(R7F_DEFAULT_POLICY.portfolio.minReallocationIntervalMs).toBe(24 * 60 * 60 * 1000);
    expect(R7F_DEFAULT_POLICY.portfolio.maxLearningAgeMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(R7F_DEFAULT_POLICY.riskDispositions).toEqual({ low: "ALLOW", medium: "REVIEW_REQUIRED", high: "REVIEW_REQUIRED", critical: "BLOCK" });
    // E constraints mirror the R7-F portfolio/financial limits.
    expect("ogd1:" + "a".repeat(64)).toMatch(GOVERNANCE_DECISION_ID_PATTERN);
    expect(() =>
      validateGovernanceDecisionView({ governanceDecisionId: "bogus" })
    ).toThrow();
  });

  it("R7-E constraint ceilings are aligned with (never wider than) R7-F policy", async () => {
    const { DEFAULT_OPTIMISATION_CONSTRAINTS } = await import("./lib/budget-portfolio/allocation-solver");
    // Concentration and shift fractions must not exceed the governance policy
    // ceilings (governance would review anything wider — alignment keeps the
    // proposal inside the autonomous envelope).
    expect(DEFAULT_OPTIMISATION_CONSTRAINTS.concentrationCeilingBps / 10_000).toBeLessThanOrEqual(
      R7F_DEFAULT_POLICY.portfolio.maxConcentrationFraction
    );
    expect(DEFAULT_OPTIMISATION_CONSTRAINTS.maxShiftPerCycleBps / 10_000).toBeLessThanOrEqual(
      R7F_DEFAULT_POLICY.portfolio.maxSingleShiftFraction
    );
    expect(DEFAULT_OPTIMISATION_CONSTRAINTS.maxShiftPerCycleMinor).toBeLessThanOrEqual(
      R7F_DEFAULT_POLICY.financial.autonomousReallocationCapMinor
    );
  });

  it("R4: budget authority derivation honours canonical campaign rows (whole USD → minor ×100)", () => {
    const material = validatePortfolioAuthorityMaterial(
      {
        business: { id: 1, userId: 1, isActive: true },
        campaigns: [{ id: 7, userId: 1, businessId: 1, status: "active", budget: 250, provider: null }],
        currency: "USD", budgetPeriod: "2026-11", supportedProviders: ["meta"], lockedAllocationKeys: [], reservedMinor: 0,
      } as never,
      1,
      1
    );
    const snapshot = buildPortfolioSnapshot(material, NOW);
    expect(snapshot.currentAllocations[0]!.amountMinor).toBe(25_000);
    expect(snapshot.currency).toBe("USD");
  });

  it("stream contracts are committed and reference each other", () => {
    const canonical = fs.readFileSync("docs/contracts/budget-portfolio-optimisation-contract.md", "utf8");
    const handoff = fs.readFileSync("docs/contracts/business-optimisation-to-strategy-contract.md", "utf8");
    expect(canonical).toContain("budget-portfolio/v1");
    expect(canonical).toContain("business-optimisation-to-strategy-contract.md");
    expect(handoff).toContain("business-optimisation-to-strategy/v1");
    expect(handoff).toContain("budget-portfolio-optimisation-contract.md");
    // Client surface references ids/objective only.
    expect(Object.keys(ProposeOptimisationInputSchema.shape)).toEqual([
      "businessId",
      "portfolioSnapshotId",
      "objective",
      "evidenceRefs",
    ]);
  });
});
