import { describe, expect, it } from "vitest";
import {
  extractStrategySuccessMetrics,
  type StrategyKpiAuthority,
  type StrategySuccessMetricRef,
} from "./strategy-kpi-contracts";
import {
  evaluateStrategyKpiPerformance,
  type StrategyKpiEvaluation,
} from "./strategy-kpi-assessment";
import {
  normaliseObservations,
  type PerformanceObservation,
  type RawAnalyticsRow,
} from "../contracts/observation";
import {
  CPA_ASSUMPTION_USD,
  ENGAGEMENT_RATE_BANDS,
} from "../contracts/learning-config";

const WINDOW = { start: "2026-05-01", end: "2026-05-31" };

const AUTHORITY_BASE = {
  snapshotId: "strategy_abc123",
  strategyRunId: 42,
  version: 3,
  strategyHashSha256: "deadbeef".repeat(8),
  creativeBriefFingerprint: "fp-1",
  campaignId: 7,
  capturedAt: "2026-04-20T10:00:00.000Z",
};

function makeRef(
  overrides: Partial<StrategySuccessMetricRef> &
    Pick<StrategySuccessMetricRef, "metric" | "rawLabel">
): StrategySuccessMetricRef {
  return {
    id: "sm:0",
    normalizedLabel: overrides.rawLabel,
    stages: ["conversion"],
    target: null,
    unit: null,
    sourcePath: "snapshot.funnelStages[0].metrics[0]",
    ...overrides,
  };
}

function makeAuthority(
  successMetrics: StrategySuccessMetricRef[]
): StrategyKpiAuthority {
  return { ...AUTHORITY_BASE, successMetrics };
}

const row = (
  id: number,
  metricType: string,
  value: number,
  date = "2026-05-05",
  platform = "instagram"
): RawAnalyticsRow => ({ id, metricType, platform, value, date });

function facts(rows: RawAnalyticsRow[]): PerformanceObservation[] {
  return normaliseObservations(rows, WINDOW.start, WINDOW.end).observations;
}

function evaluate(input: {
  authority: StrategyKpiAuthority;
  observations?: PerformanceObservation[];
  campaignBudget?: number | null;
}): StrategyKpiEvaluation {
  return evaluateStrategyKpiPerformance({
    strategyAuthority: input.authority,
    performanceFacts: input.observations ?? [],
    window: WINDOW,
    campaignBudget: input.campaignBudget ?? null,
  });
}

describe("extractStrategySuccessMetrics", () => {
  it("maps funnel stage metric labels to canonical metrics with stage lineage", () => {
    const snapshot = {
      funnelStages: [
        {
          stage: "awareness",
          goal: "reach",
          tactics: [],
          metrics: ["impressions"],
        },
        {
          stage: "consideration",
          goal: "engage",
          tactics: [],
          metrics: ["engagement"],
        },
        {
          stage: "conversion",
          goal: "convert",
          tactics: [],
          metrics: ["conversions"],
        },
      ],
    };

    const refs = extractStrategySuccessMetrics(snapshot);

    expect(refs).toHaveLength(3);
    // Stably sorted by canonical metric name.
    expect(refs.map(r => r.metric)).toEqual([
      "conversions",
      "engagement",
      "impressions",
    ]);
    expect(refs[0].stages).toEqual(["conversion"]);
    expect(refs[0].rawLabel).toBe("conversions");
    expect(refs[0].sourcePath).toBe("snapshot.funnelStages[2].metrics[0]");
    expect(refs.map(r => r.id)).toEqual(["sm:0", "sm:1", "sm:2"]);
  });

  it("merges the same metric named by multiple stages", () => {
    const snapshot = {
      funnelStages: [
        { stage: "consideration", metrics: ["engagement"] },
        { stage: "retention", metrics: ["engagement"] },
      ],
    };

    const refs = extractStrategySuccessMetrics(snapshot);

    expect(refs).toHaveLength(1);
    expect(refs[0].metric).toBe("engagement");
    expect(refs[0].stages).toEqual(["consideration", "retention"]);
  });

  it("preserves unmappable labels with metric null", () => {
    const snapshot = {
      funnelStages: [{ stage: "conversion", metrics: ["brand sentiment"] }],
    };

    const refs = extractStrategySuccessMetrics(snapshot);

    expect(refs).toHaveLength(1);
    expect(refs[0].metric).toBeNull();
    expect(refs[0].rawLabel).toBe("brand sentiment");
  });

  it("returns no metrics when the snapshot declares none", () => {
    expect(extractStrategySuccessMetrics({ funnelStages: [] })).toEqual([]);
    expect(extractStrategySuccessMetrics({})).toEqual([]);
    expect(extractStrategySuccessMetrics(null)).toEqual([]);
  });
});

describe("evaluateStrategyKpiPerformance", () => {
  it("explicit Strategy target wins over the engine band", () => {
    // Engagement rate 4% would be "met" against the 4% engine band, but the
    // approved Strategy target is 10% — the Strategy target must govern.
    const authority = makeAuthority([
      makeRef({
        metric: "engagement",
        rawLabel: "engagement",
        target: 0.1,
        unit: "rate",
      }),
    ]);
    const observations = facts([
      row(1, "impressions", 10_000),
      row(2, "engagement", 400),
    ]);

    const result = evaluate({ authority, observations });

    const metric = result.results[0];
    expect(metric.status).toBe("missed");
    expect(metric.actual).toBe(0.04);
    expect(metric.target).toBe(0.1);
    expect(metric.targetProvenance.basis).toBe("strategy_target");
    expect(metric.targetProvenance.precedenceRank).toBe(1);
  });

  it("exact threshold met: actual equal to the Strategy target is met", () => {
    const authority = makeAuthority([
      makeRef({
        metric: "conversions",
        rawLabel: "conversions",
        target: 100,
        unit: "count",
      }),
    ]);
    const observations = facts([row(1, "conversions", 100)]);

    const result = evaluate({ authority, observations });

    expect(result.results[0].status).toBe("met");
    expect(result.results[0].actual).toBe(100);
  });

  it("below threshold: missed and partial follow the defined semantics", () => {
    const observationsFor = (value: number) =>
      facts([row(1, "conversions", value)]);
    const authority = (target: number) =>
      makeAuthority([
        makeRef({
          metric: "conversions",
          rawLabel: "conversions",
          target,
          unit: "count",
        }),
      ]);

    // 40 < 50% of 100 -> missed
    expect(
      evaluate({ authority: authority(100), observations: observationsFor(40) })
        .results[0].status
    ).toBe("missed");
    // 60 within tolerance -> partial
    expect(
      evaluate({ authority: authority(100), observations: observationsFor(60) })
        .results[0].status
    ).toBe("partial");
    // exactly 50% of target -> partial (boundary inclusive)
    expect(
      evaluate({ authority: authority(100), observations: observationsFor(50) })
        .results[0].status
    ).toBe("partial");
  });

  it("supports lte operators for at-most Strategy targets", () => {
    const authority = makeAuthority([
      makeRef({
        metric: "clicks",
        rawLabel: "clicks",
        target: 500,
        unit: "count",
        operator: "lte",
      }),
    ]);

    const at = (value: number) =>
      evaluate({
        authority,
        observations: facts([row(1, "clicks", value)]),
      }).results[0].status;

    expect(at(400)).toBe("met");
    expect(at(600)).toBe("partial");
    expect(at(900)).toBe("missed");
  });

  it("unsupported Strategy metric is preserved as not_measurable without a proxy", () => {
    const authority = makeAuthority([
      makeRef({ metric: null, rawLabel: "brand sentiment" }),
    ]);

    const result = evaluate({
      authority,
      observations: facts([row(1, "engagement", 10)]),
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].status).toBe("not_measurable");
    expect(result.results[0].metric).toBeNull();
    expect(result.results[0].rawLabel).toBe("brand sentiment");
    expect(result.results[0].target).toBeNull();
    expect(result.results[0].actual).toBeNull();
    // No fabricated verdict on any other metric.
    expect(
      result.results.every(
        r => r.metric === null || r.status === "not_measurable"
      )
    ).toBe(true);
  });

  it("insufficient observations produce insufficient_data, not a fabricated zero", () => {
    const authority = makeAuthority([
      makeRef({
        metric: "conversions",
        rawLabel: "conversions",
        target: 100,
        unit: "count",
      }),
    ]);
    // Only impressions exist in the window — no conversion observations.
    const observations = facts([row(1, "impressions", 10_000)]);

    const result = evaluate({ authority, observations });

    const metric = result.results[0];
    expect(metric.status).toBe("insufficient_data");
    expect(metric.actual).toBeNull();
    expect(metric.target).toBe(100);
    expect(metric.targetProvenance.basis).toBe("strategy_target");
  });

  it("engine-band fallback for engagement applies only without a Strategy target and respects the sample floor", () => {
    const authority = makeAuthority([
      makeRef({ metric: "engagement", rawLabel: "engagement" }),
    ]);

    // Above the minimum sample: 6% rate >= 4% met band.
    const healthy = evaluate({
      authority,
      observations: facts([
        row(1, "impressions", 10_000),
        row(2, "engagement", 600),
      ]),
    });
    expect(healthy.results[0].status).toBe("met");
    expect(healthy.results[0].targetProvenance.basis).toBe("engine_band");
    expect(healthy.results[0].targetProvenance.precedenceRank).toBe(2);
    expect(healthy.results[0].unit).toBe("rate");
    expect(healthy.results[0].target).toBe(ENGAGEMENT_RATE_BANDS.met);

    // Below the minimum sample: insufficient_data.
    const thin = evaluate({
      authority,
      observations: facts([
        row(1, "impressions", 100),
        row(2, "engagement", 4),
      ]),
    });
    expect(thin.results[0].status).toBe("insufficient_data");

    // No impressions at all: insufficient_data.
    const none = evaluate({
      authority,
      observations: facts([row(1, "engagement", 40)]),
    });
    expect(none.results[0].status).toBe("insufficient_data");
  });

  it("budget assumption fallback applies to conversions only when a budget exists", () => {
    const authority = makeAuthority([
      makeRef({ metric: "conversions", rawLabel: "conversions" }),
    ]);

    const withBudget = evaluate({
      authority,
      observations: facts([row(1, "conversions", 120)]),
      campaignBudget: 5000,
    });
    expect(withBudget.results[0].status).toBe("met");
    expect(withBudget.results[0].target).toBe(5000 / CPA_ASSUMPTION_USD);
    expect(withBudget.results[0].targetProvenance.basis).toBe(
      "budget_assumption"
    );
    expect(withBudget.results[0].targetProvenance.precedenceRank).toBe(3);

    const withoutBudget = evaluate({
      authority,
      observations: facts([row(1, "conversions", 120)]),
      campaignBudget: null,
    });
    expect(withoutBudget.results[0].status).toBe("not_measurable");
  });

  it("evaluates multiple Strategy metrics independently and summarises deterministically", () => {
    const authority = makeAuthority([
      makeRef({
        id: "sm:0",
        metric: "conversions",
        rawLabel: "conversions",
        target: 100,
        unit: "count",
      }),
      makeRef({
        id: "sm:1",
        metric: "engagement",
        rawLabel: "engagement",
        stages: ["consideration"],
      }),
      makeRef({
        id: "sm:2",
        metric: null,
        rawLabel: "brand sentiment",
        stages: ["awareness"],
      }),
    ]);
    const observations = facts([
      row(1, "conversions", 100),
      row(2, "impressions", 10_000),
      row(3, "engagement", 600),
    ]);

    const result = evaluate({ authority, observations });

    expect(result.results).toHaveLength(3);
    const byMetric = new Map(result.results.map(r => [r.metricRefId, r]));
    expect(byMetric.get("sm:0")!.status).toBe("met");
    expect(byMetric.get("sm:1")!.status).toBe("met");
    expect(byMetric.get("sm:2")!.status).toBe("not_measurable");
    // Individual results survive; overall is the deterministic worst.
    expect(result.overallStatus).toBe("not_measurable");
    expect(result.summary).toBe(
      "3 Strategy success metric(s) assessed over 2026-05-01..2026-05-31: " +
        "met=2, partial=0, missed=0, insufficient_data=0, not_measurable=1. " +
        "Overall: not_measurable."
    );
  });

  it("retains target provenance, actual evidence references and strategy coordinates", () => {
    const ref = makeRef({
      metric: "conversions",
      rawLabel: "conversions",
      target: 100,
      unit: "count",
      sourcePath: "snapshot.funnelStages[2].metrics[0]",
    });
    const authority = makeAuthority([ref]);
    const observations = facts([row(9, "conversions", 100)]);

    const result = evaluate({ authority, observations });
    const metric = result.results[0];

    expect(metric.targetProvenance).toEqual({
      basis: "strategy_target",
      precedenceRank: 1,
      source: "snapshot.funnelStages[2].metrics[0]",
    });
    expect(metric.actualProvenance.source).toBe("performance_observations");
    expect(metric.actualProvenance.windowStart).toBe(WINDOW.start);
    expect(metric.actualProvenance.windowEnd).toBe(WINDOW.end);
    expect(metric.evidenceRefs).toEqual(["ao:9"]);
    expect(metric.actualProvenance.evidenceRefs).toEqual(["ao:9"]);

    expect(result.strategy).toEqual(AUTHORITY_BASE);
    expect(result.window).toEqual(WINDOW);
  });

  it("is deterministic for identical inputs", () => {
    const authority = makeAuthority([
      makeRef({
        metric: "engagement",
        rawLabel: "engagement",
        target: 0.05,
        unit: "rate",
      }),
      makeRef({ metric: null, rawLabel: "brand sentiment" }),
    ]);
    const observations = facts([
      row(1, "impressions", 10_000),
      row(2, "engagement", 500),
    ]);

    const first = evaluate({ authority, observations });
    const second = evaluate({ authority, observations });

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("fail-closed: a Strategy that defines no measurable success metrics fabricates no verdicts", () => {
    const authority = makeAuthority([
      makeRef({ metric: null, rawLabel: "industry renown" }),
    ]);

    const result = evaluate({
      authority,
      observations: facts([row(1, "conversions", 500)]),
      campaignBudget: 5000,
    });

    expect(result.results[0].status).toBe("not_measurable");
    expect(result.results[0].actual).toBeNull();
    expect(result.results[0].target).toBeNull();

    const empty = evaluate({
      authority: makeAuthority([]),
      observations: facts([row(1, "conversions", 500)]),
    });
    expect(empty.results).toEqual([]);
    expect(empty.overallStatus).toBe("not_measurable");
  });

  it("performs no mutation: frozen inputs pass through unchanged", () => {
    const ref = makeRef({
      metric: "conversions",
      rawLabel: "conversions",
      target: 100,
      unit: "count",
    });
    const authority = makeAuthority([ref]);
    const observations = facts([row(1, "conversions", 100)]);

    const authorityBefore = JSON.stringify(authority);
    const observationsBefore = JSON.stringify(observations);

    Object.freeze(ref);
    Object.freeze(authority);
    Object.freeze(authority.successMetrics);
    observations.forEach(o => Object.freeze(o));

    const result = evaluate({ authority, observations });

    expect(JSON.stringify(authority)).toBe(authorityBefore);
    expect(JSON.stringify(observations)).toBe(observationsBefore);
    expect(result.results[0].status).toBe("met");
  });

  it("rejects invalid windows and authorities deterministically", () => {
    const authority = makeAuthority([
      makeRef({ metric: "conversions", rawLabel: "conversions" }),
    ]);

    expect(() =>
      evaluateStrategyKpiPerformance({
        strategyAuthority: authority,
        performanceFacts: [],
        window: { start: "2026-05-31", end: "2026-05-01" },
        campaignBudget: null,
      })
    ).toThrow(/window end/);

    expect(() =>
      evaluateStrategyKpiPerformance({
        strategyAuthority: { ...authority, snapshotId: "" },
        performanceFacts: [],
        window: WINDOW,
        campaignBudget: null,
      })
    ).toThrow(/snapshotId/);
  });

  it("end-to-end: persisted Strategy snapshot payload drives the assessment", () => {
    // Shape mirrors the approved Strategy payload (StrategyOutputSchema).
    const snapshot = {
      personas: [],
      positioning: "pos",
      valueProposition: "vp",
      coreMessage: "cm",
      campaignTheme: "theme",
      platformStrategy: [],
      funnelStages: [
        {
          stage: "awareness",
          goal: "reach",
          tactics: [],
          metrics: ["impressions"],
        },
        {
          stage: "consideration",
          goal: "engage",
          tactics: [],
          metrics: ["engagement"],
        },
        {
          stage: "conversion",
          goal: "convert",
          tactics: [],
          metrics: ["conversions"],
        },
      ],
      offers: [],
      ctas: [],
      budgetRecommendation: { total: 5000, allocation: [] },
    };

    const authority = makeAuthority(extractStrategySuccessMetrics(snapshot));
    const observations = facts([
      row(1, "impressions", 10_000),
      row(2, "engagement", 600),
      row(3, "conversions", 120),
    ]);

    const result = evaluate({
      authority,
      observations,
      campaignBudget: 5000,
    });

    expect(result.results).toHaveLength(3);
    const byMetric = new Map(result.results.map(r => [r.metric, r]));
    // impressions: no target, no fallback -> not_measurable.
    expect(byMetric.get("impressions")!.status).toBe("not_measurable");
    // engagement: engine band, 6% >= 4% -> met.
    expect(byMetric.get("engagement")!.status).toBe("met");
    expect(byMetric.get("engagement")!.targetProvenance.basis).toBe(
      "engine_band"
    );
    // conversions: budget assumption 5000/50 = 100, actual 120 -> met.
    expect(byMetric.get("conversions")!.status).toBe("met");
    expect(byMetric.get("conversions")!.target).toBe(100);
    expect(byMetric.get("conversions")!.targetProvenance.basis).toBe(
      "budget_assumption"
    );
    expect(result.overallStatus).toBe("not_measurable");
    // Every evidence ref points at a real observation id.
    const ids = new Set(observations.map(o => o.id));
    for (const r of result.results) {
      for (const ref of r.evidenceRefs) {
        expect(ids.has(ref)).toBe(true);
      }
    }
  });
});
