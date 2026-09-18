import { describe, expect, it } from "vitest";
import {
  evaluateKpiAssessment,
  resolveObjectiveMetric,
  type KpiAssessment,
} from "./kpi-assessment";
import {
  normaliseObservations,
  type CampaignFacts,
  type PerformanceObservation,
  type RawAnalyticsRow,
} from "./observation";
import { CPA_ASSUMPTION_USD } from "./learning-config";

const campaignBase: CampaignFacts = {
  id: 1,
  goal: "Increase walk-ins by 30%",
  primaryOutcome: null,
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
  platform = "instagram"
): RawAnalyticsRow => ({ id, metricType, platform, value, date });

function assess(
  rows: RawAnalyticsRow[],
  campaign: Partial<CampaignFacts> = {}
): KpiAssessment {
  const merged = { ...campaignBase, ...campaign };
  const { observations } = normaliseObservations(rows, "2026-05-01", "2026-05-31");
  return evaluateKpiAssessment({
    campaign: merged,
    observations,
    windowStart: "2026-05-01",
    windowEnd: "2026-05-31",
  });
}

function metricRows(
  impressions: number,
  clicks: number,
  conversions: number,
  fromId = 1
): RawAnalyticsRow[] {
  return [
    row(fromId, "impressions", impressions, "2026-05-01"),
    row(fromId + 1, "clicks", clicks, "2026-05-01"),
    row(fromId + 2, "conversions", conversions, "2026-05-01"),
  ];
}

describe("resolveObjectiveMetric", () => {
  it("prefers primaryOutcome over goal", () => {
    const result = resolveObjectiveMetric({
      goal: "get more followers",
      primaryOutcome: "drive online bookings",
    });
    expect(result.metric).toBe("conversions");
    expect(result.basis).toBe("primaryOutcome");
    expect(result.matchedTerm).toBe("bookings");
  });

  it("falls back to goal when primaryOutcome is empty", () => {
    const result = resolveObjectiveMetric({
      goal: "Grow our email list with new leads",
      primaryOutcome: "  ",
    });
    expect(result.metric).toBe("leads");
    expect(result.basis).toBe("goal");
  });

  it("fails closed as unresolved when nothing matches", () => {
    const result = resolveObjectiveMetric({ goal: "Be the best", primaryOutcome: null });
    expect(result).toEqual({ metric: null, basis: "unresolved", matchedTerm: null });
  });

  it("fails closed when both fields are empty", () => {
    const result = resolveObjectiveMetric({ goal: "", primaryOutcome: null });
    expect(result).toEqual({ metric: null, basis: "unresolved", matchedTerm: null });
  });
});

describe("evaluateKpiAssessment", () => {
  it("rates CTR against engine bands and cites observation evidence", () => {
    // CTR 4% >= met band
    const good = assess(metricRows(10_000, 400, 20));
    const ctr = good.kpis.find((k) => k.kpi === "click_through_rate")!;
    expect(ctr.status).toBe("met");
    expect(ctr.targetBasis).toBe("engine_band");
    expect(ctr.evidenceRefs).toContain("ao:1");
    expect(ctr.evidenceRefs).toContain("ao:2");

    // CTR 1% between bands
    const mid = assess(metricRows(10_000, 100, 20));
    expect(mid.kpis.find((k) => k.kpi === "click_through_rate")!.status).toBe("partial");

    // CTR 0.3% below partial band
    const bad = assess(metricRows(10_000, 30, 20));
    expect(bad.kpis.find((k) => k.kpi === "click_through_rate")!.status).toBe("missed");
  });

  it("degrades rate KPIs to insufficient_data under minimum sample sizes", () => {
    const result = assess(metricRows(100, 1, 0));
    expect(result.kpis.find((k) => k.kpi === "click_through_rate")!.status).toBe(
      "insufficient_data"
    );
    // clicks < MIN_CLICKS_FOR_CVR -> conversion rate not assessable
    expect(result.kpis.find((k) => k.kpi === "conversion_rate")!.status).toBe(
      "insufficient_data"
    );
  });

  it("evaluates conversion rate against bands once clicks are sufficient", () => {
    const strong = assess(metricRows(50_000, 1000, 80));
    expect(strong.kpis.find((k) => k.kpi === "conversion_rate")!.status).toBe("met");

    const weak = assess(metricRows(50_000, 1000, 5));
    expect(weak.kpis.find((k) => k.kpi === "conversion_rate")!.status).toBe("missed");
  });

  it("applies the budget-relative objective target and labels it as an assumption", () => {
    // budget 5000, CPA assumption 50 -> target 100 conversions
    const objective = { primaryOutcome: "drive online bookings" };
    const hit = assess(metricRows(200_000, 4000, 120), { budget: 5000, ...objective });
    const kpi = hit.kpis.find((k) => k.kpi === "objective_volume")!;
    expect(kpi.status).toBe("met");
    expect(kpi.target).toBe(5000 / CPA_ASSUMPTION_USD);
    expect(kpi.targetBasis).toBe("budget_assumption");
    expect(hit.overallStatus).toBe("met");

    const half = assess(metricRows(200_000, 4000, 60), { budget: 5000, ...objective });
    expect(half.kpis.find((k) => k.kpi === "objective_volume")!.status).toBe("partial");

    const low = assess(metricRows(200_000, 4000, 20), { budget: 5000, ...objective });
    expect(low.kpis.find((k) => k.kpi === "objective_volume")!.status).toBe("missed");
    expect(low.overallStatus).toBe("missed");
  });

  it("reports objective volume without a verdict when no deterministic target applies", () => {
    const result = assess([row(1, "followers", 40, "2026-05-01")], {
      primaryOutcome: "grow our followers",
      budget: null,
    });
    const kpi = result.kpis.find((k) => k.kpi === "objective_volume")!;
    expect(kpi.status).toBe("insufficient_data");
    expect(kpi.target).toBeNull();
    expect(kpi.targetBasis).toBeNull();
  });

  it("resolves the objective metric onto the assessment with its basis", () => {
    const result = assess([row(1, "leads", 12, "2026-05-01")], {
      primaryOutcome: "capture qualified leads",
    });
    expect(result.objectiveMetric).toBe("leads");
    expect(result.objectiveBasis).toBe("primaryOutcome");
  });

  it("every KPI evidence reference points at a real observation id", () => {
    const rows = metricRows(10_000, 300, 25);
    const { observations } = normaliseObservations(rows, "2026-05-01", "2026-05-31");
    const ids = new Set(observations.map((o: PerformanceObservation) => o.id));
    const result = assess(rows, { budget: 5000 });
    for (const kpi of result.kpis) {
      for (const ref of kpi.evidenceRefs) {
        expect(ids.has(ref)).toBe(true);
      }
    }
  });

  it("unresolved objective: no fabricated objective-volume verdict, funnel KPIs still reported", () => {
    const result = assess(metricRows(10_000, 1000, 40), {
      primaryOutcome: "Be the best",
      goal: "",
      budget: 5000,
    });

    expect(result.objectiveMetric).toBeNull();
    expect(result.objectiveBasis).toBe("unresolved");
    expect(result.objectiveMatchedTerm).toBeNull();
    // No objective_volume KPI must exist, even with a budget present.
    expect(result.kpis.find((k) => k.kpi === "objective_volume")).toBeUndefined();
    // Generic funnel KPIs are still reported where supported.
    expect(result.kpis.find((k) => k.kpi === "click_through_rate")).toBeDefined();
    expect(result.kpis.find((k) => k.kpi === "conversion_rate")).toBeDefined();
  });
});
