// ─── R7-E Budget & Portfolio Optimisation — unit tests (E2–E5 pure modules) ───

import { describe, it, expect } from "vitest";
import {
  BUDGET_PORTFOLIO_ALGORITHM_VERSION,
  BUDGET_PORTFOLIO_CONSTRAINT_VERSION,
  campaignAllocationKey,
  deriveEvidenceBundleHash,
  deriveOptimisationId,
  derivePortfolioSnapshotId,
  deriveProposalContentHash,
  OPTIMISATION_ID_PATTERN,
  PORTFOLIO_SNAPSHOT_ID_PATTERN,
  ProposeOptimisationInputSchema,
  CreatePortfolioSnapshotInputSchema,
} from "./budget-portfolio-contract";
import {
  assertSnapshotFresh,
  buildPortfolioSnapshot,
  validatePortfolioAuthorityMaterial,
  type PortfolioAuthorityMaterial,
} from "./portfolio-snapshot";
import { evaluateEvidence, type AllocationEvidence, type EvidenceBundle } from "./evidence-model";
import {
  assertBudgetInvariants,
  solvePortfolioAllocation,
  splitProportionally,
  DEFAULT_OPTIMISATION_CONSTRAINTS,
} from "./allocation-solver";
import { applyStabilityHold, evaluateStability } from "./stability-controls";
import type { EvidenceEvaluation } from "./evidence-model";

const NOW = "2026-11-10T12:00:00.000Z";
const TENANT = 9001;
const BUSINESS = 501;

function makeMaterial(overrides: Partial<PortfolioAuthorityMaterial> = {}): PortfolioAuthorityMaterial {
  const base = {
    business: { id: BUSINESS, userId: TENANT, isActive: true },
    campaigns: [
      { id: 1, userId: TENANT, businessId: BUSINESS, status: "active" as const, budget: 500, provider: null },
      { id: 2, userId: TENANT, businessId: BUSINESS, status: "active" as const, budget: 300, provider: null },
      { id: 3, userId: TENANT, businessId: BUSINESS, status: "paused" as const, budget: 200, provider: null },
      { id: 4, userId: TENANT, businessId: BUSINESS, status: "draft" as const, budget: 100, provider: null },
    ],
    currency: "USD",
    budgetPeriod: "2026-11",
    supportedProviders: ["meta", "google", "linkedin", "tiktok", "email"],
    lockedAllocationKeys: [],
    reservedMinor: 0,
  };
  const merged = { ...base, ...overrides };
  return validatePortfolioAuthorityMaterial(merged, TENANT, BUSINESS);
}

function makeSnapshot(material = makeMaterial()) {
  return buildPortfolioSnapshot(material, NOW);
}

function evidenceWithScores(
  entries: Record<string, { score: number; mass?: number; contradicted?: boolean }>,
  confidenceClass: EvidenceEvaluation["confidenceClass"] = "STRONG"
): EvidenceEvaluation {
  const byKey: Record<string, AllocationEvidence> = {};
  for (const [key, e] of Object.entries(entries)) {
    byKey[key] = {
      allocationKey: key,
      campaignId: Number(key.split(":")[1]),
      score: e.score,
      evidenceMass: e.mass ?? e.score,
      outcomeCount: 1,
      learningCount: 0,
      learningContradicted: e.contradicted ?? false,
    };
  }
  return {
    byKey: Object.freeze(byKey),
    confidenceClass,
    reasonCodes: Object.freeze([]),
    usableMass: Object.values(entries).reduce((s, e) => s + (e.mass ?? e.score), 0),
  };
}

describe("contract identities", () => {
  it("derives deterministic snapshot ids (same state ⇒ same id)", () => {
    const a = derivePortfolioSnapshotId({
      userId: TENANT,
      businessId: BUSINESS,
      budgetPeriod: "2026-11",
      currency: "USD",
      approvedTotalBudgetMinor: 100000,
      committedMinor: 100000,
      reservedMinor: 0,
      currentAllocations: { "camp:1": 50000, "camp:2": 50000 },
      supportedProviders: ["meta"],
      lockedAllocationKeys: [],
      disabledAllocationKeys: [],
    });
    const b = derivePortfolioSnapshotId({
      userId: TENANT,
      businessId: BUSINESS,
      budgetPeriod: "2026-11",
      currency: "USD",
      approvedTotalBudgetMinor: 100000,
      committedMinor: 100000,
      reservedMinor: 0,
      currentAllocations: { "camp:2": 50000, "camp:1": 50000 }, // key order irrelevant
      supportedProviders: ["meta"],
      lockedAllocationKeys: [],
      disabledAllocationKeys: [],
    });
    expect(a).toBe(b);
    expect(a).toMatch(PORTFOLIO_SNAPSHOT_ID_PATTERN);
  });

  it("different tenant or state ⇒ different snapshot id", () => {
    const mk = (userId: number, committed: number) =>
      derivePortfolioSnapshotId({
        userId,
        businessId: BUSINESS,
        budgetPeriod: "2026-11",
        currency: "USD",
        approvedTotalBudgetMinor: committed,
        committedMinor: committed,
        reservedMinor: 0,
        currentAllocations: {},
        supportedProviders: [],
        lockedAllocationKeys: [],
        disabledAllocationKeys: [],
      });
    expect(mk(TENANT, 100)).not.toBe(mk(TENANT + 1, 100));
    expect(mk(TENANT, 100)).not.toBe(mk(TENANT, 200));
  });

  it("derives deterministic optimisation + evidence bundle + content hashes", () => {
    const base = {
      userId: TENANT,
      businessId: BUSINESS,
      portfolioSnapshotId: "psn1:" + "a".repeat(64),
      objective: "MAXIMISE_EVIDENCE_WEIGHTED_VALUE" as const,
      algorithmVersion: BUDGET_PORTFOLIO_ALGORITHM_VERSION,
      constraintVersion: BUDGET_PORTFOLIO_CONSTRAINT_VERSION,
      evidenceBundleHash: deriveEvidenceBundleHash({
        outcomeRefs: ["out1:x", "out1:a"],
        attributionRefs: ["atr1:b"],
        learningRefs: [],
      }),
    };
    const id = deriveOptimisationId(base);
    expect(id).toMatch(OPTIMISATION_ID_PATTERN);
    expect(deriveOptimisationId(base)).toBe(id);
    expect(
      deriveOptimisationId({ ...base, evidenceBundleHash: deriveEvidenceBundleHash({ outcomeRefs: ["out1:y"], attributionRefs: [], learningRefs: [] }) })
    ).not.toBe(id);
    // Evidence bundle hash is order-insensitive on refs.
    expect(
      deriveEvidenceBundleHash({ outcomeRefs: ["a", "b"], attributionRefs: [], learningRefs: [] })
    ).toBe(deriveEvidenceBundleHash({ outcomeRefs: ["b", "a"], attributionRefs: [], learningRefs: [] }));
    const content = deriveProposalContentHash({
      optimisationId: id,
      currentAllocations: [],
      proposedAllocations: [],
      deltaAllocations: [],
      confidenceClass: "STRONG",
      reasonCodes: ["GOVERNANCE_ALLOWED"],
    });
    expect(content).toMatch(/^[a-f0-9]{64}$/);
  });

  it("campaignAllocationKey round-trips and validates", () => {
    expect(campaignAllocationKey(42)).toBe("camp:42");
    expect(() => campaignAllocationKey(0)).toThrow();
  });

  it("strictObject schemas reject client-supplied authority fields", () => {
    expect(() =>
      CreatePortfolioSnapshotInputSchema.parse({ businessId: 1, approvedTotalBudgetMinor: 999 })
    ).toThrow();
    expect(() =>
      ProposeOptimisationInputSchema.parse({
        businessId: 1,
        status: "AUTHORIZED",
        proposedAllocations: [{ allocationKey: "camp:1", amountMinor: 1 }],
      })
    ).toThrow();
    expect(ProposeOptimisationInputSchema.parse({ businessId: 1 }).objective).toBeUndefined();
  });
});

describe("portfolio snapshot (E2)", () => {
  it("assembles authoritative state with integer minor units", () => {
    const snapshot = makeSnapshot();
    expect(snapshot.currentAllocations.map((e) => e.allocationKey)).toEqual(["camp:1", "camp:2", "camp:3"]);
    expect(snapshot.currentAllocations.find((e) => e.allocationKey === "camp:1")?.amountMinor).toBe(50_000);
    // draft campaign holds no committed funds and is disabled.
    expect(snapshot.committedMinor).toBe(100_000);
    expect(snapshot.approvedTotalBudgetMinor).toBe(100_000);
    expect(snapshot.availableReallocatableMinor).toBe(0);
    expect(snapshot.disabledAllocationKeys).toContain("camp:3"); // paused
    expect(snapshot.disabledAllocationKeys).toContain("camp:4"); // draft
  });

  it("rejects cross-tenant material (fail closed, indistinguishable)", () => {
    expect(() =>
      validatePortfolioAuthorityMaterial(
        { ...makeMaterial(), business: { id: BUSINESS, userId: TENANT + 1, isActive: true } } as never,
        TENANT,
        BUSINESS
      )
    ).toThrow(/not found for this tenant/);
  });

  it("rejects malformed provider material", () => {
    expect(() =>
      validatePortfolioAuthorityMaterial(
        { ...makeMaterial(), currency: "usd" } as never,
        TENANT,
        BUSINESS
      )
    ).toThrow();
  });

  it("stale snapshots fail closed", () => {
    const snapshot = makeSnapshot();
    expect(() => assertSnapshotFresh(snapshot, "2026-11-10T12:05:00.000Z", 15 * 60 * 1000)).not.toThrow();
    expect(() => assertSnapshotFresh(snapshot, "2026-11-10T13:00:00.000Z", 15 * 60 * 1000)).toThrow(/stale/);
  });

  it("deterministic identity survives rebuild from identical material", () => {
    const a = buildPortfolioSnapshot(makeMaterial(), NOW);
    const b = buildPortfolioSnapshot(makeMaterial(), NOW);
    expect(a.portfolioSnapshotId).toBe(b.portfolioSnapshotId);
    const c = buildPortfolioSnapshot(makeMaterial(), "2026-11-10T13:00:00.000Z");
    expect(c.portfolioSnapshotId).toBe(a.portfolioSnapshotId); // capturedAt not in identity
  });
});

describe("evidence model (E3)", () => {
  const allocatableKeys = ["camp:1", "camp:2", "camp:3"];

  function bundle(partial: Partial<EvidenceBundle> = {}): EvidenceBundle {
    return {
      outcomes: [],
      attributions: [],
      learnings: [],
      ...partial,
    };
  }

  function outcome(id: string, status: string, amountMinor: number, occurredAt = NOW): EvidenceBundle["outcomes"][number] {
    return { outcomeId: id, businessId: BUSINESS, outcomeStatus: status, valueType: "MONETARY", amountMinor, occurredAt };
  }

  function attribution(
    id: string,
    outcomeId: string,
    confidenceClass: string,
    evidenceClass: string,
    touchpoints: { sourceIdentity: string; creditBps: number }[]
  ): EvidenceBundle["attributions"][number] {
    return {
      attributionId: id,
      businessId: BUSINESS,
      outcomeId,
      outcomeStatus: "VERIFIED",
      confidenceClass,
      evidenceClass,
      touchpoints: touchpoints.map((t) => ({ type: "CAMPAIGN", sourceIdentity: t.sourceIdentity, creditBps: t.creditBps })),
    };
  }

  it("verified outcomes outweigh provisional outcomes", () => {
    const verified = evaluateEvidence({
      businessId: BUSINESS,
      bundle: bundle({
        outcomes: [outcome("out1:v", "VERIFIED", 10_000)],
        attributions: [attribution("atr1:v", "out1:v", "HIGH", "DIRECT_LINKAGE", [{ sourceIdentity: "1", creditBps: 100000 }])],
      }),
      allocatableKeys,
      now: NOW,
    });
    const provisional = evaluateEvidence({
      businessId: BUSINESS,
      bundle: bundle({
        outcomes: [outcome("out1:p", "PROVISIONAL", 10_000)],
        attributions: [attribution("atr1:p", "out1:p", "HIGH", "DIRECT_LINKAGE", [{ sourceIdentity: "1", creditBps: 100000 }])],
      }),
      allocatableKeys,
      now: NOW,
    });
    expect(verified.byKey["camp:1"]!.score).toBeGreaterThan(provisional.byKey["camp:1"]!.score);
  });

  it("weak attribution reduces optimisation strength (LOW/NONE → zero/weak)", () => {
    const high = evaluateEvidence({
      businessId: BUSINESS,
      bundle: bundle({
        outcomes: [outcome("out1:a", "VERIFIED", 10_000)],
        attributions: [attribution("atr1:a", "out1:a", "HIGH", "DIRECT_LINKAGE", [{ sourceIdentity: "1", creditBps: 100000 }])],
      }),
      allocatableKeys,
      now: NOW,
    });
    const low = evaluateEvidence({
      businessId: BUSINESS,
      bundle: bundle({
        outcomes: [outcome("out1:a", "VERIFIED", 10_000)],
        attributions: [attribution("atr1:a", "out1:a", "LOW", "WEAK_ASSOCIATION", [{ sourceIdentity: "1", creditBps: 100000 }])],
      }),
      allocatableKeys,
      now: NOW,
    });
    const none = evaluateEvidence({
      businessId: BUSINESS,
      bundle: bundle({
        outcomes: [outcome("out1:a", "VERIFIED", 10_000)],
        attributions: [attribution("atr1:a", "out1:a", "NONE", "INSUFFICIENT_EVIDENCE", [{ sourceIdentity: "1", creditBps: 100000 }])],
      }),
      allocatableKeys,
      now: NOW,
    });
    expect(high.byKey["camp:1"]!.score).toBeGreaterThan(low.byKey["camp:1"]!.score);
    expect(none.byKey["camp:1"]!.score).toBe(0);
  });

  it("contradicted learning blocks the subject and flags the evaluation", () => {
    const result = evaluateEvidence({
      businessId: BUSINESS,
      bundle: bundle({
        outcomes: [outcome("out1:a", "VERIFIED", 10_000)],
        attributions: [attribution("atr1:a", "out1:a", "HIGH", "DIRECT_LINKAGE", [{ sourceIdentity: "1", creditBps: 100000 }])],
        learnings: [
          {
            learningId: "lrn1:x",
            businessId: BUSINESS,
            subjectType: "CAMPAIGN",
            subjectId: "1",
            status: "CONTRADICTED",
            confidenceClass: "STRONG",
            supportCount: 3,
            contradictionCount: 2,
            freshness: { stale: false, contradictionUnresolved: true },
            derivedAt: NOW,
          },
        ],
      }),
      allocatableKeys,
      now: NOW,
    });
    expect(result.byKey["camp:1"]!.learningContradicted).toBe(true);
    expect(result.reasonCodes).toContain("LEARNING_CONTRADICTED");
    expect(result.confidenceClass).not.toBe("STRONG");
  });

  it("stale evidence is excluded and flagged", () => {
    const result = evaluateEvidence({
      businessId: BUSINESS,
      bundle: bundle({
        outcomes: [outcome("out1:old", "VERIFIED", 10_000, "2026-01-01T00:00:00.000Z")],
        attributions: [attribution("atr1:old", "out1:old", "HIGH", "DIRECT_LINKAGE", [{ sourceIdentity: "1", creditBps: 100000 }])],
      }),
      allocatableKeys,
      now: NOW,
    });
    expect(result.byKey["camp:1"]!.score).toBe(0);
    expect(result.reasonCodes).toContain("EVIDENCE_STALE");
  });

  it("cross-tenant evidence fails closed", () => {
    expect(() =>
      evaluateEvidence({
        businessId: BUSINESS,
        bundle: bundle({ outcomes: [{ ...outcome("out1:x", "VERIFIED", 100), businessId: BUSINESS + 1 }] }),
        allocatableKeys,
        now: NOW,
      })
    ).toThrow(/cross-tenant/);
  });

  it("single-event influence is capped", () => {
    // One huge outcome vs many small ones: the huge one must not dominate utterly.
    const oneHuge = evaluateEvidence({
      businessId: BUSINESS,
      bundle: bundle({
        outcomes: [outcome("out1:h", "VERIFIED", 1_000_000)],
        attributions: [attribution("atr1:h", "out1:h", "HIGH", "DIRECT_LINKAGE", [{ sourceIdentity: "1", creditBps: 100000 }])],
      }),
      allocatableKeys,
      now: NOW,
    });
    // The capped mass of a single event ≤ 40% of total mass by construction;
    // with only one event it is the total, so assert determinism + cap bound.
    const capped = oneHuge.byKey["camp:1"]!.evidenceMass;
    const raw = 1_000_000 * 4 * 4 * 4 * 3; // amount × status × confidence × evidence × recency
    expect(capped).toBeLessThanOrEqual(Math.max(1, Math.floor((raw * 4000) / 10000)));
  });

  it("empty bundle ⇒ INSUFFICIENT", () => {
    const result = evaluateEvidence({ businessId: BUSINESS, bundle: bundle(), allocatableKeys, now: NOW });
    expect(result.confidenceClass).toBe("INSUFFICIENT");
    expect(result.reasonCodes).toContain("EVIDENCE_INSUFFICIENT");
  });
});

describe("bounded solver (E4)", () => {
  const snapshot = makeSnapshot();

  it("splitProportionally is exact and deterministic", () => {
    const a = splitProportionally(100_000, { "camp:1": 3, "camp:2": 1 });
    expect(a["camp:1"] + a["camp:2"]).toBe(100_000);
    expect(a).toEqual(splitProportionally(100_000, { "camp:2": 1, "camp:1": 3 }));
    const b = splitProportionally(101, { a: 1, b: 1, c: 1 });
    expect(b.a + b.b + b.c).toBe(101);
  });

  it("reallocates within the approved total — no money created, Σdelta = 0", () => {
    const evidence = evidenceWithScores({ "camp:1": { score: 900_000 }, "camp:2": { score: 100_000 } });
    const solved = solvePortfolioAllocation({ snapshot, evidence, objective: "MAXIMISE_EVIDENCE_WEIGHTED_VALUE" });
    expect(solved.changed).toBe(true);
    const proposedTotal = Object.values(solved.proposedByKey).reduce((s, v) => s + v, 0);
    expect(proposedTotal).toBe(snapshot.approvedTotalBudgetMinor);
    const deltaTotal = Object.values(solved.deltaByKey).reduce((s, v) => s + v, 0);
    expect(deltaTotal).toBe(0);
    assertBudgetInvariants({ snapshot, proposedByKey: solved.proposedByKey });
    // Disabled keys (paused camp:3, draft camp:4 excluded from snapshot allocations) untouched.
    expect(solved.deltaByKey["camp:3"]).toBe(0);
  });

  it("locked funds are preserved exactly", () => {
    const material = makeMaterial({ lockedAllocationKeys: ["camp:1"] });
    const lockedSnapshot = buildPortfolioSnapshot(material, NOW);
    const evidence = evidenceWithScores({ "camp:2": { score: 1_000_000 } });
    const solved = solvePortfolioAllocation({ snapshot: lockedSnapshot, evidence, objective: "MAXIMISE_EVIDENCE_WEIGHTED_VALUE" });
    expect(solved.deltaByKey["camp:1"]).toBe(0);
    expect(solved.reasonCodes).toContain("LOCKED_FUNDS_PRESERVED");
    assertBudgetInvariants({ snapshot: lockedSnapshot, proposedByKey: solved.proposedByKey });
  });

  it("unsupported provider receives no allocation", () => {
    const material = makeMaterial({
      campaigns: [
        { id: 1, userId: TENANT, businessId: BUSINESS, status: "active" as const, budget: 500, provider: "meta" },
        { id: 2, userId: TENANT, businessId: BUSINESS, status: "active" as const, budget: 500, provider: "pinterest" },
      ],
    });
    const snap = buildPortfolioSnapshot(material, NOW);
    expect(snap.disabledAllocationKeys).toContain("camp:2");
    const evidence = evidenceWithScores({ "camp:1": { score: 1 }, "camp:2": { score: 1_000_000 } });
    const solved = solvePortfolioAllocation({ snapshot: snap, evidence, objective: "MAXIMISE_EVIDENCE_WEIGHTED_VALUE" });
    expect((solved.proposedByKey["camp:2"] ?? 0) - snap.currentAllocations.find((e) => e.allocationKey === "camp:2")!.amountMinor).toBeLessThanOrEqual(0);
    expect(solved.reasonCodes).toContain("UNSUPPORTED_PROVIDER_EXCLUDED");
  });

  it("per-cycle shift cap is enforced and money stays conserved", () => {
    const material = makeMaterial({
      campaigns: [
        { id: 1, userId: TENANT, businessId: BUSINESS, status: "active" as const, budget: 1000, provider: null },
        { id: 2, userId: TENANT, businessId: BUSINESS, status: "active" as const, budget: 100, provider: null },
      ],
    });
    const snap = buildPortfolioSnapshot(material, NOW);
    // camp:1 has overwhelming evidence; shift capped at 20% of pool per cycle.
    const evidence = evidenceWithScores({ "camp:1": { score: 1_000_000 }, "camp:2": { score: 1 } });
    const solved = solvePortfolioAllocation({ snapshot: snap, evidence, objective: "MAXIMISE_EVIDENCE_WEIGHTED_VALUE" });
    expect(solved.reasonCodes).toContain("PER_CYCLE_SHIFT_CAP_APPLIED");
    const pool = 110_000;
    const maxShift = Math.min(DEFAULT_OPTIMISATION_CONSTRAINTS.maxShiftPerCycleMinor, Math.floor((pool * DEFAULT_OPTIMISATION_CONSTRAINTS.maxShiftPerCycleBps) / 10000));
    expect(Math.abs(solved.deltaByKey["camp:1"])).toBeLessThanOrEqual(maxShift);
    const deltaTotal = Object.values(solved.deltaByKey).reduce((s, v) => s + v, 0);
    expect(deltaTotal).toBe(0);
    for (const v of Object.values(solved.proposedByKey)) expect(v).toBeGreaterThanOrEqual(0);
  });

  it("concentration ceiling is enforced", () => {
    const material = makeMaterial({
      campaigns: [
        { id: 1, userId: TENANT, businessId: BUSINESS, status: "active" as const, budget: 100, provider: null },
        { id: 2, userId: TENANT, businessId: BUSINESS, status: "active" as const, budget: 100, provider: null },
        { id: 3, userId: TENANT, businessId: BUSINESS, status: "active" as const, budget: 100, provider: null },
      ],
    });
    const snap = buildPortfolioSnapshot(material, NOW);
    const evidence = evidenceWithScores({ "camp:1": { score: 1_000_000 }, "camp:2": { score: 1 }, "camp:3": { score: 1 } });
    const solved = solvePortfolioAllocation({ snapshot: snap, evidence, objective: "MAXIMISE_EVIDENCE_WEIGHTED_VALUE" });
    expect(solved.reasonCodes).toContain("CONCENTRATION_CEILING_APPLIED");
    const total = Object.values(solved.proposedByKey).reduce((s, v) => s + v, 0);
    for (const v of Object.values(solved.proposedByKey)) {
      expect(v * 10000).toBeLessThanOrEqual(total * DEFAULT_OPTIMISATION_CONSTRAINTS.concentrationCeilingBps + 10000);
    }
  });

  it("insufficient evidence ⇒ NO_CHANGE", () => {
    const solved = solvePortfolioAllocation({ snapshot, evidence: evidenceWithScores({}, "INSUFFICIENT"), objective: "MAXIMISE_EVIDENCE_WEIGHTED_VALUE" });
    expect(solved.changed).toBe(false);
    expect(solved.reasonCodes).toContain("EVIDENCE_INSUFFICIENT");
  });

  it("weak evidence cannot shift aggressively", () => {
    const evidence = evidenceWithScores({ "camp:1": { score: 600 }, "camp:2": { score: 400 } }, "WEAK");
    const solved = solvePortfolioAllocation({ snapshot, evidence, objective: "MAXIMISE_EVIDENCE_WEIGHTED_VALUE" });
    const total = snapshot.approvedTotalBudgetMinor;
    const weakCap = Math.floor((total * DEFAULT_OPTIMISATION_CONSTRAINTS.weakConfidenceShiftCapBps) / 10000);
    for (const d of Object.values(solved.deltaByKey)) {
      expect(Math.abs(d)).toBeLessThanOrEqual(weakCap);
    }
  });

  it("gross movement below threshold ⇒ NO_CHANGE (hysteresis)", () => {
    const tinySnapshot = buildPortfolioSnapshot(
      makeMaterial({
        campaigns: [
          { id: 1, userId: TENANT, businessId: BUSINESS, status: "active" as const, budget: 1, provider: null },
          { id: 2, userId: TENANT, businessId: BUSINESS, status: "active" as const, budget: 1, provider: null },
        ],
      }),
      NOW
    );
    const evidence = evidenceWithScores({ "camp:1": { score: 600 }, "camp:2": { score: 400 } });
    const solved = solvePortfolioAllocation({ snapshot: tinySnapshot, evidence, objective: "MAXIMISE_EVIDENCE_WEIGHTED_VALUE" });
    expect(solved.changed).toBe(false);
    expect(solved.reasonCodes).toContain("CHANGE_BELOW_MINIMUM_THRESHOLD");
  });

  it("rebalance objective spreads evenly", () => {
    const material = makeMaterial({
      campaigns: [
        { id: 1, userId: TENANT, businessId: BUSINESS, status: "active" as const, budget: 600, provider: null },
        { id: 2, userId: TENANT, businessId: BUSINESS, status: "active" as const, budget: 200, provider: null },
      ],
    });
    const snap = buildPortfolioSnapshot(material, NOW);
    const evidence = evidenceWithScores({ "camp:1": { score: 1 }, "camp:2": { score: 1 } });
    const solved = solvePortfolioAllocation({
      snapshot: snap,
      evidence,
      objective: "REBALANCE_TO_POLICY_TARGET",
      constraints: {
        ...DEFAULT_OPTIMISATION_CONSTRAINTS,
        maxShiftPerCycleBps: 10_000,
        maxShiftPerCycleMinor: 10_000_000,
      },
    });
    expect(solved.proposedByKey["camp:1"]).toBe(40_000);
    expect(solved.proposedByKey["camp:2"]).toBe(40_000);
    const deltaTotal = Object.values(solved.deltaByKey).reduce((s, v) => s + v, 0);
    expect(deltaTotal).toBe(0);
  });
});

describe("stability controls (E5)", () => {
  const snapshot = makeSnapshot();
  const evidence = evidenceWithScores({ "camp:1": { score: 900_000 }, "camp:2": { score: 100_000 } });
  const solved = solvePortfolioAllocation({ snapshot, evidence, objective: "MAXIMISE_EVIDENCE_WEIGHTED_VALUE" });

  it("cooldown holds the whole cycle", () => {
    const movedKey = Object.entries(solved.deltaByKey).find(([, d]) => d !== 0)![0];
    const evaluation = evaluateStability({
      solved,
      state: { lastReallocationAtByKey: { [movedKey]: "2026-11-10T11:00:00.000Z" }, previousDeltaByKey: {} },
      currentByKey: Object.fromEntries(snapshot.currentAllocations.map((e) => [e.allocationKey, e.amountMinor])),
      now: NOW,
    });
    expect(evaluation.held).toBe(true);
    expect(evaluation.reasonCodes).toContain("COOLDOWN_ACTIVE");
    const held = applyStabilityHold(solved, evaluation);
    expect(held.changed).toBe(false);
    expect(Object.values(held.deltaByKey).every((d) => d === 0)).toBe(true);
  });

  it("repeated reversal triggers the stability hold", () => {
    const movedKey = Object.entries(solved.deltaByKey).find(([, d]) => d !== 0)![0];
    const delta = solved.deltaByKey[movedKey];
    const evaluation = evaluateStability({
      solved,
      state: {
        lastReallocationAtByKey: { [movedKey]: "2026-11-09T12:00:00.000Z" },
        previousDeltaByKey: { [movedKey]: -delta },
      },
      currentByKey: Object.fromEntries(snapshot.currentAllocations.map((e) => [e.allocationKey, e.amountMinor])),
      now: NOW,
    });
    expect(evaluation.held).toBe(true);
    expect(evaluation.reasonCodes).toContain("REVERSAL_STABILITY_HOLD");
  });

  it("no-op solve passes through", () => {
    const noChange = { ...solved, changed: false };
    const evaluation = evaluateStability({
      solved: noChange,
      state: { lastReallocationAtByKey: {}, previousDeltaByKey: {} },
      currentByKey: {},
      now: NOW,
    });
    expect(evaluation.held).toBe(false);
  });
});
