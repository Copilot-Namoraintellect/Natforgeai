import { describe, expect, it } from "vitest";
import { deriveLearning } from "./learning-derivation";
import { evaluateKpiAssessment } from "./kpi-assessment";
import {
  normaliseObservations,
  type CampaignFacts,
  type RawAnalyticsRow,
} from "./observation";

const campaignBase: CampaignFacts = {
  id: 1,
  goal: "Drive online bookings",
  primaryOutcome: "drive online bookings",
  budget: null,
  platforms: "instagram,tiktok",
  startDate: "2026-05-01",
  endDate: "2026-05-31",
};

const row = (
  id: number,
  metricType: string,
  value: number,
  date: string,
  platform: string | null = "instagram"
): RawAnalyticsRow => ({ id, metricType, platform, value, date });

function derive(rows: RawAnalyticsRow[], campaign: Partial<CampaignFacts> = {}) {
  const windowStart = "2026-05-01";
  const windowEnd = "2026-05-31";
  const { observations } = normaliseObservations(rows, windowStart, windowEnd);
  const assessment = evaluateKpiAssessment({
    campaign: { ...campaignBase, ...campaign },
    observations,
    windowStart,
    windowEnd,
  });
  return { ...deriveLearning({ assessment, observations }), assessment, observations };
}

describe("deriveLearning — performance facts", () => {
  it("states grounded facts that cite real observation ids", () => {
    const { performanceFacts, observations } = derive([
      row(1, "impressions", 10_000, "2026-05-01"),
      row(2, "clicks", 300, "2026-05-01"),
      row(3, "conversions", 25, "2026-05-01"),
    ]);

    const ids = new Set(observations.map((o) => o.id));
    expect(performanceFacts.length).toBeGreaterThanOrEqual(3);
    for (const fact of performanceFacts) {
      expect(fact.evidenceRefs.length).toBeGreaterThan(0);
      for (const ref of fact.evidenceRefs) expect(ids.has(ref)).toBe(true);
    }
    expect(
      performanceFacts.some((f) => f.statement.includes("10000 impressions"))
    ).toBe(true);
  });
});

describe("deriveLearning — pattern detection", () => {
  it("flags weak click-through as a negative pattern with evidence", () => {
    const { negativePatterns } = derive([
      row(1, "impressions", 10_000, "2026-05-01"),
      row(2, "clicks", 30, "2026-05-01"),
    ]);
    const pattern = negativePatterns.find((p) => p.id === "pat_weak_ctr");
    expect(pattern).toBeDefined();
    expect(pattern!.evidenceRefs).toEqual(["ao:1", "ao:2"]);
  });

  it("flags clicks that do not convert as a negative pattern", () => {
    const { negativePatterns } = derive([
      row(1, "impressions", 50_000, "2026-05-01"),
      row(2, "clicks", 1000, "2026-05-01"),
      row(3, "conversions", 5, "2026-05-01"),
    ]);
    expect(
      negativePatterns.find((p) => p.id === "pat_clicks_not_converting")
    ).toBeDefined();
  });

  it("credits platforms that convert above the campaign average", () => {
    const { positivePatterns } = derive([
      row(1, "impressions", 50_000, "2026-05-01"),
      row(2, "clicks", 50, "2026-05-01", "instagram"),
      row(3, "clicks", 50, "2026-05-01", "tiktok"),
      row(4, "conversions", 2, "2026-05-01", "instagram"),
      row(5, "conversions", 12, "2026-05-01", "tiktok"),
    ]);
    const pattern = positivePatterns.find((p) => p.id === "pat_platform_efficiency:tiktok");
    expect(pattern).toBeDefined();
    expect(pattern!.evidenceRefs).toEqual(["ao:3", "ao:5"]);
  });

  it("detects objective momentum decline across the window", () => {
    const { negativePatterns } = derive([
      row(1, "impressions", 5000, "2026-05-01"),
      row(2, "impressions", 5000, "2026-05-25"),
      row(3, "clicks", 250, "2026-05-01"),
      row(4, "clicks", 250, "2026-05-25"),
      row(5, "conversions", 10, "2026-05-05"),
      row(6, "conversions", 2, "2026-05-28"),
    ]);
    expect(negativePatterns.find((p) => p.id === "pat_momentum_down")).toBeDefined();
  });

  it("detects single-platform dependency on the objective metric", () => {
    const { negativePatterns } = derive([
      row(1, "impressions", 50_000, "2026-05-01"),
      row(2, "clicks", 1000, "2026-05-01", "instagram"),
      row(3, "clicks", 200, "2026-05-01", "tiktok"),
      row(4, "conversions", 40, "2026-05-01", "instagram"),
      row(5, "conversions", 5, "2026-05-01", "tiktok"),
    ]);
    expect(
      negativePatterns.find((p) => p.id === "pat_platform_dependency:instagram")
    ).toBeDefined();
  });
});

describe("deriveLearning — confidence", () => {
  it("scores high confidence on large, multi-platform, long-window evidence", () => {
    const { confidence } = derive([
      row(1, "impressions", 50_000, "2026-05-01", "instagram"),
      row(2, "impressions", 40_000, "2026-05-01", "tiktok"),
      row(3, "clicks", 2000, "2026-05-01", "instagram"),
      row(4, "clicks", 1500, "2026-05-01", "tiktok"),
      row(5, "conversions", 30, "2026-05-01", "instagram"),
      row(6, "conversions", 25, "2026-05-01", "tiktok"),
    ]);
    expect(confidence).toBe("high");
  });

  it("scores low confidence on thin, single-platform, short-window evidence", () => {
    const windowStart = "2026-05-01";
    const windowEnd = "2026-05-10";
    const { observations } = normaliseObservations(
      [row(1, "impressions", 100, "2026-05-02"), row(2, "clicks", 5, "2026-05-02")],
      windowStart,
      windowEnd
    );
    const assessment = evaluateKpiAssessment({
      campaign: campaignBase,
      observations,
      windowStart,
      windowEnd,
    });
    const { confidence } = deriveLearning({ assessment, observations });
    expect(confidence).toBe("low");
  });
});

describe("deriveLearning — governed recommendations", () => {
  it("maps weak CTR to a governed creative recommendation", () => {
    const { recommendedAdjustments } = derive([
      row(1, "impressions", 10_000, "2026-05-01"),
      row(2, "clicks", 30, "2026-05-01"),
    ]);
    const rec = recommendedAdjustments.find((r) => r.id === "rec_improve_hook_ctr");
    expect(rec).toBeDefined();
    expect(rec!.targetEngine).toBe("creative");
    expect(rec!.evidenceRefs.length).toBeGreaterThan(0);
  });

  it("maps conversion weakness to strategy and platform dependency to distribution", () => {
    const { recommendedAdjustments } = derive([
      row(1, "impressions", 50_000, "2026-05-01"),
      row(2, "clicks", 1000, "2026-05-01", "instagram"),
      row(3, "clicks", 200, "2026-05-01", "tiktok"),
      row(4, "clicks", 10, "2026-05-10", "instagram"),
      row(5, "clicks", 10, "2026-05-10", "tiktok"),
      row(6, "conversions", 40, "2026-05-10", "instagram"),
      row(7, "conversions", 5, "2026-05-20", "tiktok"),
    ]);
    const targets = recommendedAdjustments.map((r) => r.targetEngine);
    expect(targets).toContain("strategy");
    expect(targets).toContain("distribution");
  });

  it("never allows automatic mutation: every recommendation is approval-gated", () => {
    const { recommendedAdjustments } = derive([
      row(1, "impressions", 10_000, "2026-05-01"),
      row(2, "clicks", 30, "2026-05-01"),
      row(3, "conversions", 1, "2026-05-01"),
      row(4, "conversions", 40, "2026-05-02", "tiktok"),
      row(5, "clicks", 900, "2026-05-02", "tiktok"),
      row(6, "impressions", 50_000, "2026-05-02", "tiktok"),
    ]);
    expect(recommendedAdjustments.length).toBeGreaterThan(0);
    for (const rec of recommendedAdjustments) {
      expect(rec.governance.autoApply).toBe(false);
      expect(rec.governance.requiresApproval).toBe(true);
      expect(["strategy", "creative", "distribution"]).toContain(rec.targetEngine);
    }
  });

  it("falls back to a maintain/monitor recommendation when KPIs are met", () => {
    const { assessment, recommendedAdjustments, negativePatterns } = derive(
      [
        row(1, "impressions", 100_000, "2026-05-01", "instagram"),
        row(2, "impressions", 100_000, "2026-05-01", "tiktok"),
        row(3, "clicks", 4000, "2026-05-01", "instagram"),
        row(4, "clicks", 4000, "2026-05-01", "tiktok"),
        row(5, "conversions", 150, "2026-05-10", "instagram"),
        row(6, "conversions", 150, "2026-05-10", "tiktok"),
        row(7, "conversions", 150, "2026-05-20", "instagram"),
        row(8, "conversions", 150, "2026-05-20", "tiktok"),
      ],
      { budget: 5000 }
    );
    expect(assessment.overallStatus).toBe("met");
    expect(negativePatterns).toHaveLength(0);
    expect(recommendedAdjustments).toHaveLength(1);
    expect(recommendedAdjustments[0].id).toBe("rec_maintain_and_monitor");
    expect(recommendedAdjustments[0].governance.autoApply).toBe(false);
    // Evidence-backed default: met KPI evidence is attached, not an empty set.
    expect(recommendedAdjustments[0].evidenceRefs.length).toBeGreaterThan(0);
    expect(recommendedAdjustments[0].evidenceRefs).toContain("ao:1");
  });

  it("falls back to an evidence-collection recommendation when data is thin", () => {
    const { assessment, recommendedAdjustments, negativePatterns } = derive([
      row(1, "impressions", 5000, "2026-05-01"),
      row(2, "clicks", 500, "2026-05-01"),
      row(3, "conversions", 3, "2026-05-10"),
      row(4, "conversions", 3, "2026-05-20"),
    ]);
    expect(assessment.overallStatus).toBe("partial");
    expect(negativePatterns).toHaveLength(0);
    expect(recommendedAdjustments).toHaveLength(1);
    expect(recommendedAdjustments[0].id).toBe("rec_collect_more_evidence");
    expect(recommendedAdjustments[0].governance.autoApply).toBe(false);
    // Its purpose is insufficient evidence, so no concrete refs are required.
    expect(recommendedAdjustments[0].evidenceRefs).toEqual([]);
  });
});

describe("deriveLearning — determinism", () => {
  it("produces identical output for identical inputs", () => {
    const rows = [
      row(1, "impressions", 10_000, "2026-05-01"),
      row(2, "clicks", 30, "2026-05-01"),
      row(3, "conversions", 25, "2026-05-02", "tiktok"),
    ];
    const a = derive(rows);
    const b = derive([...rows].reverse());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("produces an objective summary naming the resolved objective and window", () => {
    const { objectiveSummary } = derive([row(1, "impressions", 10_000, "2026-05-01")]);
    expect(objectiveSummary).toContain('"conversions"');
    expect(objectiveSummary).toContain("2026-05-01..2026-05-31");
  });
});

describe("deriveLearning — pseudo-platform scope (unscoped rows are not channels)", () => {
  it("never credits the pseudo-platform as a high-performing platform", () => {
    // "all" converts at 50% vs campaign average 26% — without the guard this
    // would emit pat_platform_efficiency:all.
    const { positivePatterns } = derive([
      row(1, "impressions", 100_000, "2026-05-01", null),
      row(2, "clicks", 100, "2026-05-01", null),
      row(3, "conversions", 50, "2026-05-01", null),
      row(4, "clicks", 100, "2026-05-01", "instagram"),
      row(5, "conversions", 2, "2026-05-01", "instagram"),
    ]);
    expect(
      positivePatterns.find((p) => p.id === "pat_platform_efficiency:all")
    ).toBeUndefined();
  });

  it("all + one real platform counts as one platform, not two", () => {
    const base = [
      row(1, "impressions", 50_000, "2026-05-01", "instagram"),
      row(2, "clicks", 2000, "2026-05-01", "instagram"),
      row(3, "conversions", 20, "2026-05-01", "instagram"),
    ];
    const { confidence: withPseudo } = derive([
      row(0, "impressions", 50_000, "2026-05-01", null),
      ...base,
    ]);
    const { confidence: withoutPseudo } = derive(base);
    // Identical evidence apart from the pseudo-platform row -> same score.
    expect(withPseudo).toBe(withoutPseudo);
    // One real platform only: no platform point (objective 20 < 30, so
    // impressions + window give exactly 2 -> medium; counting "all" would
    // wrongly give high).
    expect(withPseudo).toBe("medium");
  });

  it("two real platforms earn the multi-platform confidence point", () => {
    const one = derive([
      row(1, "impressions", 50_000, "2026-05-01", "instagram"),
      row(2, "clicks", 2000, "2026-05-01", "instagram"),
      row(3, "conversions", 10, "2026-05-01", "instagram"),
    ]);
    const two = derive([
      row(1, "impressions", 50_000, "2026-05-01", "instagram"),
      row(2, "impressions", 50_000, "2026-05-01", "tiktok"),
      row(3, "clicks", 2000, "2026-05-01", "instagram"),
      row(4, "clicks", 2000, "2026-05-01", "tiktok"),
      row(5, "conversions", 10, "2026-05-01", "instagram"),
      row(6, "conversions", 10, "2026-05-01", "tiktok"),
    ]);
    expect(one.confidence).toBe("medium");
    expect(two.confidence).toBe("high");
  });

  it("dependency detection ignores unscoped volume and never names the pseudo-platform", () => {
    // Objective volume only on "all": concentration is unattributable.
    const onlyAll = derive([
      row(1, "impressions", 100_000, "2026-05-01", null),
      row(2, "clicks", 2000, "2026-05-01", null),
      row(3, "conversions", 50, "2026-05-01", null),
    ]);
    expect(
      onlyAll.negativePatterns.find((p) => p.id === "pat_platform_dependency:all")
    ).toBeUndefined();
    expect(
      onlyAll.negativePatterns.filter((p) => p.rule === "single_platform_objective_dependency")
    ).toHaveLength(0);

    // Named platform carries all attributable volume alongside unscoped volume.
    const named = derive([
      row(1, "impressions", 100_000, "2026-05-01", "instagram"),
      row(2, "clicks", 2000, "2026-05-01", "instagram"),
      row(3, "conversions", 45, "2026-05-01", "instagram"),
      row(4, "conversions", 30, "2026-05-01", null),
    ]);
    const dependency = named.negativePatterns.find(
      (p) => p.rule === "single_platform_objective_dependency"
    );
    expect(dependency).toBeDefined();
    expect(dependency!.id).toBe("pat_platform_dependency:instagram");
    expect(dependency!.statement).not.toContain('"all"');
  });

  it("named platforms continue to be credited for above-average conversion efficiency", () => {
    const { positivePatterns } = derive([
      row(1, "impressions", 100_000, "2026-05-01", "instagram"),
      row(2, "clicks", 50, "2026-05-01", "instagram"),
      row(3, "clicks", 50, "2026-05-01", "tiktok"),
      row(4, "conversions", 2, "2026-05-01", "instagram"),
      row(5, "conversions", 12, "2026-05-01", "tiktok"),
    ]);
    expect(positivePatterns.find((p) => p.id === "pat_platform_efficiency:tiktok")).toBeDefined();
  });
});

describe("deriveLearning — evidence-bounded wording", () => {
  it("weak CTR states the band breach and investigation need without causal claims", () => {
    const { negativePatterns } = derive([
      row(1, "impressions", 10_000, "2026-05-01"),
      row(2, "clicks", 30, "2026-05-01"),
    ]);
    const statement = negativePatterns.find((p) => p.id === "pat_weak_ctr")!.statement;
    expect(statement).toContain("below the configured partial band");
    expect(statement).toContain("should be investigated");
    expect(statement).not.toMatch(/likely|underperforming/);
  });

  it("weak conversion rate states the band breach and investigation need without causal claims", () => {
    const { negativePatterns } = derive([
      row(1, "impressions", 50_000, "2026-05-01"),
      row(2, "clicks", 1000, "2026-05-01"),
      row(3, "conversions", 5, "2026-05-01"),
    ]);
    const statement = negativePatterns.find((p) => p.id === "pat_clicks_not_converting")!
      .statement;
    expect(statement).toContain("below the configured partial band");
    expect(statement).toContain("should be investigated");
    expect(statement).not.toMatch(/likely|misaligned\./);
  });

  it("no emitted statement presents a possible cause as an observed fact", () => {
    const { positivePatterns, negativePatterns, recommendedAdjustments } = derive([
      row(1, "impressions", 10_000, "2026-05-01"),
      row(2, "clicks", 30, "2026-05-01"),
      row(3, "conversions", 1, "2026-05-01"),
      row(4, "conversions", 40, "2026-05-02", "tiktok"),
      row(5, "clicks", 900, "2026-05-02", "tiktok"),
      row(6, "impressions", 50_000, "2026-05-02", "tiktok"),
    ]);
    const statements = [
      ...positivePatterns.map((p) => p.statement),
      ...negativePatterns.map((p) => p.statement),
      ...recommendedAdjustments.flatMap((r) => [r.summary, r.rationale]),
    ];
    for (const text of statements) {
      expect(text).not.toMatch(/\blikely\b/i);
      expect(text).not.toMatch(/\b(underperforming|misaligned)\b/i);
    }
  });
});

describe("deriveLearning — unresolved objective fails closed", () => {
  const unresolvedCampaign = { primaryOutcome: "Be the best", goal: "" };

  it("reports the unresolved objective and suppresses objective-dependent findings", () => {
    const { assessment, objectiveSummary, performanceFacts, positivePatterns, negativePatterns } =
      derive(
        [
          row(1, "impressions", 100_000, "2026-05-01", "instagram"),
          row(2, "clicks", 2000, "2026-05-01", "instagram"),
          row(3, "conversions", 40, "2026-05-05", "instagram"),
          row(4, "conversions", 2, "2026-05-20", "instagram"),
        ],
        unresolvedCampaign
      );

    expect(assessment.objectiveMetric).toBeNull();
    expect(assessment.objectiveBasis).toBe("unresolved");
    expect(objectiveSummary).toContain("could not be deterministically resolved");
    expect(objectiveSummary).not.toContain('"conversions"');

    // No fabricated objective fact, no momentum, no dependency.
    expect(
      performanceFacts.some((f) => f.statement.includes("Objective metric"))
    ).toBe(false);
    expect(positivePatterns.find((p) => p.rule.startsWith("objective_volume_"))).toBeUndefined();
    expect(
      negativePatterns.find((p) => p.rule.startsWith("objective_volume_"))
    ).toBeUndefined();
    expect(
      negativePatterns.find((p) => p.rule === "single_platform_objective_dependency")
    ).toBeUndefined();
  });

  it("does not emit a conversion-based verdict even with budget and conversion data present", () => {
    const { assessment, recommendedAdjustments } = derive(
      [
        row(1, "impressions", 200_000, "2026-05-01", "instagram"),
        row(2, "clicks", 8000, "2026-05-01", "instagram"),
        row(3, "conversions", 600, "2026-05-01", "instagram"),
      ],
      { ...unresolvedCampaign, budget: 5000 }
    );
    expect(assessment.kpis.find((k) => k.kpi === "objective_volume")).toBeUndefined();
    // The budget-relative conversions target must not be fabricated.
    expect(
      assessment.kpis.some((k) => k.targetBasis === "budget_assumption")
    ).toBe(false);
    expect(
      recommendedAdjustments.some((r) =>
        JSON.stringify(r).includes("objective")
      )
    ).toBe(false);
  });

  it("still reports supported generic funnel findings (weak CTR recommendation)", () => {
    const { recommendedAdjustments } = derive(
      [
        row(1, "impressions", 10_000, "2026-05-01"),
        row(2, "clicks", 30, "2026-05-01"),
      ],
      unresolvedCampaign
    );
    const rec = recommendedAdjustments.find((r) => r.id === "rec_improve_hook_ctr");
    expect(rec).toBeDefined();
    expect(rec!.governance.autoApply).toBe(false);
  });
});
