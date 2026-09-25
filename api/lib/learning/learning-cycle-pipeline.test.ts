import { describe, it, expect } from "vitest";
import { buildCampaignPerformanceDataset } from "./performance/dataset";
import type { PerformanceDatasetInput } from "./performance/sources";
import { evaluateStrategyKpiPerformance } from "./kpi/strategy-kpi-assessment";
import { analyzeVariantPerformance } from "./analysis/variant-analyzer";
import {
  SKIPPED_VARIANT_DIMENSIONS,
  buildPlatformVariantAnalysisInput,
  buildStrategyKpiAuthorityFromDataset,
  deriveLearningCycle,
  resolveCycleObjectiveMetric,
} from "./learning-cycle-pipeline";
import type { PerformanceObservation } from "./contracts/observation";
import type { VariantAnalysis } from "./analysis/variant-analysis-contract";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function baseInput(overrides: Partial<PerformanceDatasetInput> = {}): PerformanceDatasetInput {
  return {
    campaign: {
      id: 7,
      userId: 22,
      businessId: 5,
      goal: "Drive online bookings",
      primaryOutcome: "drive online bookings",
      startDate: "2026-05-01",
      endDate: "2026-05-31",
      workflowContext: {
        strategyApprovalLineage: {
          status: "approved",
          creativeBriefFingerprint: "fp-brief",
          strategyRunId: 11,
          strategySnapshotId: "strategy_abc",
          strategyVersion: 1,
          businessDnaSnapshotId: "bdna_1",
          strategyHashSha256: HASH_A,
          approvalRequestId: 33,
        },
      },
    },
    window: { start: "2026-05-01", end: "2026-05-31" },
    strategySnapshot: {
      id: 1,
      snapshotId: "strategy_abc",
      strategyRunId: 11,
      businessDnaSnapshotId: "bdna_1",
      version: 1,
      creativeBriefFingerprint: "fp-brief",
      strategyHashSha256: HASH_A,
      snapshot: {
        funnelStages: [
          { stage: "awareness", goal: "be seen", tactics: [], metrics: ["impressions"] },
          { stage: "conversion", goal: "convert", tactics: [], metrics: ["conversions"] },
        ],
      },
      capturedAt: "2026-04-15T00:00:00.000Z",
    },
    strategyApproval: { id: 33, status: "approved", approvedAt: "2026-04-16T00:00:00.000Z" },
    analyticsRows: [
      { id: 1, metricType: "impressions", platform: "instagram", value: 80_000, date: "2026-05-01" },
      { id: 2, metricType: "impressions", platform: "tiktok", value: 60_000, date: "2026-05-02" },
      { id: 3, metricType: "clicks", platform: "instagram", value: 900, date: "2026-05-01" },
      { id: 4, metricType: "clicks", platform: "tiktok", value: 700, date: "2026-05-02" },
      { id: 5, metricType: "conversions", platform: "instagram", value: 30, date: "2026-05-01" },
      { id: 6, metricType: "conversions", platform: "tiktok", value: 20, date: "2026-05-02" },
    ],
    ...overrides,
  };
}

function richAnalyticsRows(): PerformanceObservation[] {
  const dataset = buildCampaignPerformanceDataset(baseInput());
  return [...dataset.outcomes.observations];
}

describe("learning-cycle-pipeline", () => {
  it("adapts the dataset Strategy authority into Stream 2 KPI refs without inventing targets", () => {
    const dataset = buildCampaignPerformanceDataset(baseInput());
    const authority = buildStrategyKpiAuthorityFromDataset(dataset);

    expect(authority).not.toBeNull();
    expect(authority!.snapshotId).toBe("strategy_abc");
    expect(authority!.strategyRunId).toBe(11);
    expect(authority!.version).toBe(1);
    expect(authority!.strategyHashSha256).toBe(HASH_A);
    expect(authority!.creativeBriefFingerprint).toBe("fp-brief");
    // Sorted deterministic refs; no numeric target is manufactured.
    expect(authority!.successMetrics.map((r) => [r.id, r.metric, r.target, r.unit])).toEqual([
      ["sm:0", "conversions", null, null],
      ["sm:1", "impressions", null, null],
    ]);
    expect(resolveCycleObjectiveMetric(authority!)).toBe("conversions");
  });

  it("returns null authority when the dataset has no Strategy snapshot", () => {
    const dataset = buildCampaignPerformanceDataset(
      baseInput({ strategySnapshot: null, strategyApproval: null })
    );
    expect(dataset.readiness.status).toBe("authority_missing");
    expect(buildStrategyKpiAuthorityFromDataset(dataset)).toBeNull();
  });

  it("adapts dataset observations into a platform VariantAnalysisInput", () => {
    const dataset = buildCampaignPerformanceDataset(
      baseInput({
        publications: [
          {
            id: 101,
            contentPostId: 501,
            platform: "instagram",
            status: "published",
            scheduledAt: null,
            publishedAt: "2026-05-03T10:00:00.000Z",
            externalPostId: "ext-1",
            metadata: null,
            receiptExternalUrl: null,
            receiptAuditEventId: null,
          },
        ],
        contentPosts: [
          {
            id: 501,
            title: "Post",
            type: "social_post",
            platform: "instagram",
            status: "published",
            metadata: null,
          },
        ],
      })
    );
    const input = buildPlatformVariantAnalysisInput(dataset, "conversions");

    expect(input.dimension).toBe("platform");
    expect(input.objectiveMetric).toBe("conversions");
    expect(input.records.map((r) => r.identity.platform).sort()).toEqual(["instagram", "tiktok"]);
    const instagram = input.records.find((r) => r.identity.platform === "instagram")!;
    expect(instagram.observations.length).toBe(3);
    expect(instagram.publications).toEqual([
      {
        ref: "pub:queue:101",
        platform: "instagram",
        publishedAt: "2026-05-03",
        lineageComplete: false, // legacy package → lineage withheld
        publishPackageId: null,
      },
    ]);
  });

  it("explicitly skips variant dimensions without durable observation attribution", () => {
    expect(SKIPPED_VARIANT_DIMENSIONS.map((s) => s.dimension)).toEqual([
      "message_copy",
      "caption",
      "creative",
      "format",
    ]);
  });

  it("derives governed recommendations from the Strategy KPI evaluation (budget-assumption miss)", () => {
    const dataset = buildCampaignPerformanceDataset(baseInput());
    const authority = buildStrategyKpiAuthorityFromDataset(dataset)!;
    const observations = [...dataset.outcomes.observations];

    const strategyKpi = evaluateStrategyKpiPerformance({
      strategyAuthority: authority,
      performanceFacts: observations,
      window: dataset.identity.window,
      campaignBudget: 5000, // conversions target = 5000 / 50 = 100; observed 50 → missed
    });
    expect(strategyKpi.overallStatus).toBe("partial");
    const conversionsResult = strategyKpi.results.find((r) => r.metric === "conversions")!;
    expect(conversionsResult.status).toBe("partial");
    expect(conversionsResult.targetProvenance.basis).toBe("budget_assumption");

    const variantAnalysis = analyzeVariantPerformance(
      buildPlatformVariantAnalysisInput(dataset, resolveCycleObjectiveMetric(authority))
    );
    expect(variantAnalysis.comparability).toBe("non_comparable"); // legacy lineage
    expect(
      variantAnalysis.findings.filter((f) => f.kind === "comparative_rate")
    ).toHaveLength(0);

    const derivation = deriveLearningCycle({ dataset, strategyKpi, variantAnalysis });

    expect(derivation.recommendedAdjustments.length).toBeGreaterThan(0);
    const conversionRec = derivation.recommendedAdjustments.find(
      (r) => r.adjustmentType === "improve_offer_conversion_alignment"
    )!;
    expect(conversionRec.targetEngine).toBe("strategy");
    expect(conversionRec.governance).toEqual({ autoApply: false, requiresApproval: true });
    expect(conversionRec.evidenceRefs.length).toBeGreaterThan(0);
    // No variant-driven distribution recommendation may be fabricated.
    expect(
      derivation.recommendedAdjustments.find((r) => r.adjustmentType === "rebalance_toward_recorded_variant")
    ).toBeUndefined();
    // The budget assumption is labelled as an assumption in evidence.
    expect(
      derivation.evidence.some(
        (e) => e.kind === "assumption" && e.ref === `strategy-kpi:${conversionsResult.metricRefId}`
      )
    ).toBe(true);
  });

  it("uses comparable variant evidence only when the analyzer proves comparability", () => {
    const dataset = buildCampaignPerformanceDataset(baseInput());
    const authority = buildStrategyKpiAuthorityFromDataset(dataset)!;
    const observations = richAnalyticsRows();

    const comparableAnalysis: VariantAnalysis = analyzeVariantPerformance({
      campaignId: 7,
      windowStart: "2026-05-01",
      windowEnd: "2026-05-31",
      dimension: "platform",
      objectiveMetric: "conversions",
      records: [
        {
          identity: { kind: "platform", platform: "instagram", label: "instagram" },
          observations: observations.filter((o) => o.platform === "instagram"),
          publications: [
            {
              ref: "receipt:publication:instagram:101",
              platform: "instagram",
              publishedAt: "2026-05-01",
              lineageComplete: true,
              publishPackageId: "ppv1-a",
            },
          ],
        },
        {
          identity: { kind: "platform", platform: "tiktok", label: "tiktok" },
          observations: observations.filter((o) => o.platform === "tiktok"),
          publications: [
            {
              ref: "receipt:publication:tiktok:102",
              platform: "tiktok",
              publishedAt: "2026-05-03",
              lineageComplete: true,
              publishPackageId: "ppv1-b",
            },
          ],
        },
      ],
    });
    // The fixture volume is below analyzer minimums (obs/impressions/clicks),
    // so even lineage-complete records stay non_comparable and no comparative
    // finding is fabricated.
    expect(comparableAnalysis.comparability).toBe("non_comparable");

    const strategyKpi = evaluateStrategyKpiPerformance({
      strategyAuthority: authority,
      performanceFacts: observations,
      window: dataset.identity.window,
      campaignBudget: null,
    });
    const derivation = deriveLearningCycle({ dataset, strategyKpi, variantAnalysis: comparableAnalysis });
    expect(
      derivation.recommendedAdjustments.find((r) => r.adjustmentType === "rebalance_toward_recorded_variant")
    ).toBeUndefined();

    // A genuinely comparable analysis DOES produce exactly one variant-driven
    // distribution recommendation grounded in the analyzer's own findings.
    const comparable: VariantAnalysis = {
      ...comparableAnalysis,
      comparability: "comparable",
      findings: [
        ...comparableAnalysis.findings,
        {
          id: "vfind:platform:comparative:ctr",
          kind: "comparative_rate",
          statement:
            'Variant "instagram" recorded a higher click-through rate than variant "tiktok" in this window (1.30% vs 1.10%).',
          metricType: null,
          evidenceRefs: ["ao:1", "ao:3"],
        },
      ],
    };
    const derived = deriveLearningCycle({ dataset, strategyKpi, variantAnalysis: comparable });
    const variantRec = derived.recommendedAdjustments.find(
      (r) => r.adjustmentType === "rebalance_toward_recorded_variant"
    )!;
    expect(variantRec.targetEngine).toBe("distribution");
    expect(variantRec.governance).toEqual({ autoApply: false, requiresApproval: true });
    expect(variantRec.evidenceRefs).toEqual(["ao:1", "ao:3"]);
    expect(variantRec.rationale).toContain("recorded a higher click-through rate");
  });
});
