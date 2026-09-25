import { describe, expect, it } from "vitest";
import type {
  MetricType,
  PerformanceObservation,
} from "../contracts/observation";
import { PSEUDO_PLATFORM } from "../contracts/observation";
import {
  MAX_VARIANT_WINDOW_GAP_DAYS,
  MIN_COMPARED_VARIANTS,
  VARIANT_ANALYSIS_VERSION,
} from "./variant-analysis-config";
import {
  SUPPORTED_VARIANT_DIMENSIONS,
  UNSUPPORTED_VARIANT_DIMENSIONS,
  type VariantAnalysisInput,
  type VariantIdentity,
  type VariantPerformanceRecord,
  type VariantPublicationFact,
} from "./variant-analysis-contract";
import { analyzeVariantPerformance } from "./variant-analyzer";

let nextAnalyticsId = 1;

function resetIds(): void {
  nextAnalyticsId = 1;
}

function obs(
  metricType: MetricType,
  value: number,
  platform: string | null,
  date: string
): PerformanceObservation {
  const analyticsId = nextAnalyticsId++;
  return {
    id: `ao:${analyticsId}`,
    metricType,
    platform: platform === null ? PSEUDO_PLATFORM : platform,
    date,
    value,
    provenance: { kind: "analytics", analyticsId, metricType, platform, date },
  };
}

interface DaySlice {
  date: string;
  impressions?: number;
  clicks?: number;
  conversions?: number;
  engagement?: number;
  reach?: number;
  leads?: number;
}

function makeRecord(
  identity: VariantIdentity,
  observationPlatform: string,
  days: DaySlice[],
  publications: VariantPublicationFact[]
): VariantPerformanceRecord {
  const observations: PerformanceObservation[] = [];
  for (const day of days) {
    for (const metricType of [
      "impressions",
      "clicks",
      "conversions",
      "engagement",
      "reach",
      "leads",
    ] as const) {
      const value = day[metricType];
      if (value !== undefined)
        observations.push(
          obs(metricType, value, observationPlatform, day.date)
        );
    }
  }
  return { identity, observations, publications };
}

function makePublications(
  platform: string,
  refs: string[],
  dates: string[],
  lineageComplete = true
): VariantPublicationFact[] {
  return refs.map((ref, i) => ({
    ref,
    platform,
    publishedAt: dates[i],
    lineageComplete,
    publishPackageId: `ppv1-${platform}-${i}`,
  }));
}

const WINDOW = { windowStart: "2026-05-01", windowEnd: "2026-05-14" };

function instagramIdentity(): VariantIdentity {
  return { kind: "platform", platform: "instagram", label: "Instagram" };
}

function facebookIdentity(): VariantIdentity {
  return { kind: "platform", platform: "facebook", label: "Facebook" };
}

/** Instagram: 1000 imp / 120 clicks / 12 conv; Facebook: 500 imp / 50 clicks / 5 conv. */
function richPlatformRecords(): VariantPerformanceRecord[] {
  resetIds();
  const igDays: DaySlice[] = [
    {
      date: "2026-05-03",
      impressions: 200,
      clicks: 24,
      conversions: 3,
      engagement: 8,
    },
    {
      date: "2026-05-04",
      impressions: 200,
      clicks: 24,
      conversions: 2,
      engagement: 8,
    },
    {
      date: "2026-05-05",
      impressions: 200,
      clicks: 24,
      conversions: 2,
      engagement: 8,
    },
    {
      date: "2026-05-06",
      impressions: 200,
      clicks: 24,
      conversions: 3,
      engagement: 8,
    },
    {
      date: "2026-05-07",
      impressions: 200,
      clicks: 24,
      conversions: 2,
      engagement: 8,
    },
  ];
  const fbDays: DaySlice[] = [
    {
      date: "2026-05-03",
      impressions: 100,
      clicks: 10,
      conversions: 1,
      engagement: 3,
    },
    {
      date: "2026-05-04",
      impressions: 100,
      clicks: 10,
      conversions: 1,
      engagement: 3,
    },
    {
      date: "2026-05-05",
      impressions: 100,
      clicks: 10,
      conversions: 1,
      engagement: 3,
    },
    {
      date: "2026-05-06",
      impressions: 100,
      clicks: 10,
      conversions: 1,
      engagement: 3,
    },
    {
      date: "2026-05-07",
      impressions: 100,
      clicks: 10,
      conversions: 1,
      engagement: 3,
    },
  ];
  return [
    makeRecord(
      instagramIdentity(),
      "instagram",
      igDays,
      makePublications(
        "instagram",
        ["receipt:publication:instagram:1", "receipt:publication:instagram:2"],
        ["2026-05-03", "2026-05-05"]
      )
    ),
    makeRecord(
      facebookIdentity(),
      "facebook",
      fbDays,
      makePublications(
        "facebook",
        ["receipt:publication:facebook:3", "receipt:publication:facebook:4"],
        ["2026-05-04", "2026-05-06"]
      )
    ),
  ];
}

function richPlatformInput(): VariantAnalysisInput {
  return {
    campaignId: 5,
    ...WINDOW,
    dimension: "platform",
    objectiveMetric: "conversions",
    records: richPlatformRecords(),
  };
}

const CAUSAL_WORDING_RE =
  /\b(cause[sd]?\b|causality|causal\b|drove|driven\b|due to|because|led to|resulted in|results in|lifted|boosted|likely|underperform\w*|misalign\w*)\b/i;

describe("dimension support", () => {
  it("documents supported and unsupported dimensions", () => {
    expect(SUPPORTED_VARIANT_DIMENSIONS).toEqual([
      "platform",
      "message_copy",
      "caption",
      "creative",
      "format",
    ]);
    expect(UNSUPPORTED_VARIANT_DIMENSIONS).toEqual(["campaign_channel"]);
  });

  it("fails closed on the unsupported campaign_channel dimension", () => {
    const analysis = analyzeVariantPerformance({
      ...richPlatformInput(),
      dimension: "campaign_channel",
    });
    expect(analysis.analysisVersion).toBe(VARIANT_ANALYSIS_VERSION);
    expect(analysis.dimension).toBeNull();
    expect(analysis.comparability).toBe("non_comparable");
    expect(analysis.comparabilityReasons.join(" ")).toContain(
      'unsupported dimension "campaign_channel"'
    );
    expect(analysis.limitations.join(" ")).toContain(
      "no durable lineage support"
    );
    expect(analysis.variants).toEqual([]);
    expect(analysis.findings).toEqual([]);
  });

  it("fails closed on unknown dimensions", () => {
    const analysis = analyzeVariantPerformance({
      ...richPlatformInput(),
      dimension: "audience_segment",
    });
    expect(analysis.dimension).toBeNull();
    expect(analysis.comparability).toBe("non_comparable");
    expect(analysis.comparabilityReasons.join(" ")).toContain(
      'unsupported dimension "audience_segment"'
    );
  });

  it("fails closed on an invalid window", () => {
    const analysis = analyzeVariantPerformance({
      ...richPlatformInput(),
      windowStart: "2026-05-20",
    });
    expect(analysis.comparability).toBe("non_comparable");
    expect(analysis.comparabilityReasons).toContain("invalid analysis window");
  });
});

describe("comparability", () => {
  it("compares two sufficiently-evidenced variants and reaches a verdict", () => {
    const analysis = analyzeVariantPerformance(richPlatformInput());
    expect(analysis.comparability).toBe("comparable");
    expect(analysis.comparabilityReasons).toEqual([]);
    expect(analysis.variants.map(v => v.key)).toEqual([
      "facebook",
      "instagram",
    ]);

    const comparative = analysis.findings.filter(
      f => f.kind === "comparative_rate"
    );
    expect(comparative.length).toBeGreaterThan(0);
    const ctrComparative = comparative.find(f =>
      f.statement.includes("click-through rate")
    );
    expect(ctrComparative?.statement).toBe(
      'Variant "Instagram" recorded a higher click-through rate than variant "Facebook" in this window (12.00% vs 10.00%).'
    );
  });

  it("emits deterministic rate ordering with ties for equal rates", () => {
    const analysis = analyzeVariantPerformance(richPlatformInput());
    const cvrOrdering = analysis.findings.find(
      f => f.kind === "rate_ordering" && f.statement.includes("conversion rate")
    );
    // Both variants convert at 10.00% — the tie must render with "=", with
    // deterministic key-ascending order (facebook before instagram).
    expect(cvrOrdering?.statement).toBe(
      'Recorded conversion rate ordering across variants in this window: "Facebook" (10.00%) = "Instagram" (10.00%).'
    );
    const ctrOrdering = analysis.findings.find(
      f =>
        f.kind === "rate_ordering" && f.statement.includes("click-through rate")
    );
    expect(ctrOrdering?.statement).toBe(
      'Recorded click-through rate ordering across variants in this window: "Instagram" (12.00%) > "Facebook" (10.00%).'
    );
  });

  it("makes no comparative claim with a single variant but preserves the factual summary", () => {
    const analysis = analyzeVariantPerformance({
      ...richPlatformInput(),
      records: richPlatformRecords().slice(0, 1),
    });
    expect(analysis.comparability).toBe("non_comparable");
    expect(analysis.comparabilityReasons.join(" ")).toContain(
      `only one variant has recorded evidence; comparison requires at least ${MIN_COMPARED_VARIANTS}`
    );
    expect(analysis.findings.some(f => f.kind === "comparative_rate")).toBe(
      false
    );
    expect(analysis.findings.some(f => f.kind === "rate_ordering")).toBe(false);
    const summary = analysis.findings.find(f => f.kind === "variant_summary");
    expect(summary?.statement).toBe(
      'Variant "Instagram" recorded 1000 impressions, 120 clicks, and 12 conversions in this window.'
    );
  });

  it("classifies thin evidence as insufficient and degrades rates to null", () => {
    const thinDays: DaySlice[] = [
      { date: "2026-05-03", impressions: 30, clicks: 4, conversions: 1 },
      { date: "2026-05-04", impressions: 30, clicks: 4, conversions: 1 },
      { date: "2026-05-05", impressions: 30, clicks: 4, conversions: 1 },
      { date: "2026-05-06", impressions: 30, clicks: 4, conversions: 1 },
      { date: "2026-05-07", impressions: 30, clicks: 4, conversions: 1 },
    ];
    const analysis = analyzeVariantPerformance({
      ...richPlatformInput(),
      records: [
        richPlatformRecords()[0],
        makeRecord(
          facebookIdentity(),
          "facebook",
          thinDays,
          makePublications(
            "facebook",
            ["receipt:publication:facebook:3"],
            ["2026-05-04"]
          )
        ),
      ],
    });
    expect(analysis.comparability).toBe("non_comparable");
    expect(analysis.comparabilityReasons).toContain(
      "insufficient observation volume"
    );
    expect(analysis.limitations.join(" ")).toMatch(
      /below minimum evidence thresholds/
    );
    const facebook = analysis.variants.find(v => v.key === "facebook");
    expect(facebook?.rates.ctr).toBeNull();
    expect(facebook?.rates.cvr).toBeNull();
    expect(facebook?.totals.impressions).toBe(150);
    // Factual summaries survive even though the verdict is withheld.
    expect(analysis.findings.some(f => f.kind === "variant_summary")).toBe(
      true
    );
  });

  it("fails closed with an explicit limitation when lineage is incomplete", () => {
    const analysis = analyzeVariantPerformance({
      ...richPlatformInput(),
      records: [
        richPlatformRecords()[0],
        makeRecord(
          facebookIdentity(),
          "facebook",
          [
            {
              date: "2026-05-03",
              impressions: 100,
              clicks: 10,
              conversions: 1,
              engagement: 3,
            },
            {
              date: "2026-05-04",
              impressions: 100,
              clicks: 10,
              conversions: 1,
              engagement: 3,
            },
            {
              date: "2026-05-05",
              impressions: 100,
              clicks: 10,
              conversions: 1,
              engagement: 3,
            },
            {
              date: "2026-05-06",
              impressions: 100,
              clicks: 10,
              conversions: 1,
              engagement: 3,
            },
            {
              date: "2026-05-07",
              impressions: 100,
              clicks: 10,
              conversions: 1,
              engagement: 3,
            },
          ],
          []
        ),
      ],
    });
    expect(analysis.comparability).toBe("non_comparable");
    expect(analysis.comparabilityReasons).toContain(
      "incomplete variant lineage"
    );
    expect(analysis.limitations.join(" ")).toContain(
      'Variant "Facebook" has incomplete lineage'
    );
    const facebook = analysis.variants.find(v => v.key === "facebook");
    expect(facebook?.lineageComplete).toBe(false);
    // Identity is still preserved for audit even when lineage is incomplete.
    expect(facebook?.identity.platform).toBe("facebook");
  });

  it("fails closed when a publication lacks lineage completeness", () => {
    const records = richPlatformRecords();
    const fb = records[1];
    fb.publications = fb.publications.map(p => ({
      ...p,
      lineageComplete: false,
    }));
    const analysis = analyzeVariantPerformance({
      ...richPlatformInput(),
      records,
    });
    expect(analysis.comparability).toBe("non_comparable");
    expect(analysis.comparabilityReasons).toContain(
      "incomplete variant lineage"
    );
  });

  it("fails closed when variants share no common measurable metric types", () => {
    const analysis = analyzeVariantPerformance({
      ...richPlatformInput(),
      records: [
        makeRecord(
          instagramIdentity(),
          "instagram",
          [
            { date: "2026-05-03", impressions: 150, reach: 30 },
            { date: "2026-05-04", impressions: 150, reach: 30 },
            { date: "2026-05-05", impressions: 150, reach: 30 },
            { date: "2026-05-06", impressions: 150, reach: 30 },
            { date: "2026-05-07", impressions: 150, reach: 30 },
          ],
          makePublications(
            "instagram",
            ["receipt:publication:instagram:1"],
            ["2026-05-03"]
          )
        ),
        makeRecord(
          facebookIdentity(),
          "facebook",
          [
            { date: "2026-05-03", clicks: 20, leads: 2 },
            { date: "2026-05-04", clicks: 20, leads: 2 },
            { date: "2026-05-05", clicks: 20, leads: 2 },
            { date: "2026-05-06", clicks: 20, leads: 2 },
            { date: "2026-05-07", clicks: 20, leads: 2 },
          ],
          makePublications(
            "facebook",
            ["receipt:publication:facebook:3"],
            ["2026-05-04"]
          )
        ),
      ],
    });
    expect(analysis.comparability).toBe("non_comparable");
    expect(analysis.comparabilityReasons).toContain(
      "variants share no common measurable metric types"
    );
    expect(analysis.comparedMetricTypes).toEqual([]);
  });

  it("fails closed when publication windows are materially incompatible", () => {
    const records = richPlatformRecords();
    records[0].publications = makePublications(
      "instagram",
      ["receipt:publication:instagram:1"],
      ["2026-05-01"]
    );
    records[1].publications = makePublications(
      "facebook",
      ["receipt:publication:facebook:3"],
      ["2026-06-20"]
    );
    const analysis = analyzeVariantPerformance({
      ...richPlatformInput(),
      records,
    });
    expect(analysis.comparability).toBe("non_comparable");
    expect(analysis.comparabilityReasons).toContain(
      "publication windows are materially incompatible"
    );
    expect(analysis.limitations.join(" ")).toContain(
      `${MAX_VARIANT_WINDOW_GAP_DAYS} days`
    );
  });
});

describe("platform comparison", () => {
  it("reports factual share-of-total for the objective metric", () => {
    const analysis = analyzeVariantPerformance(richPlatformInput());
    const shares = analysis.findings.filter(
      f => f.kind === "share_of_total" && f.metricType === "conversions"
    );
    expect(shares.map(s => s.statement)).toEqual([
      'Variant "Instagram" accounted for 70.59% of recorded conversions across the compared variants in this window.',
      'Variant "Facebook" accounted for 29.41% of recorded conversions across the compared variants in this window.',
    ]);
  });

  it("counts unscoped observations in totals but never treats the pseudo-platform as a channel", () => {
    const records = richPlatformRecords();
    records[0].observations.push(obs("impressions", 100, null, "2026-05-08"));
    records.push(
      makeRecord(
        { kind: "platform", platform: " ALL ", label: "All" },
        "all",
        [{ date: "2026-05-03", impressions: 500, clicks: 60, conversions: 8 }],
        makePublications("all", ["receipt:publication:all:9"], ["2026-05-03"])
      )
    );
    const analysis = analyzeVariantPerformance({
      ...richPlatformInput(),
      records,
    });
    expect(analysis.variants.every(v => v.key !== PSEUDO_PLATFORM)).toBe(true);
    expect(analysis.variants.map(v => v.key)).toEqual([
      "facebook",
      "instagram",
    ]);
    const instagram = analysis.variants.find(v => v.key === "instagram");
    expect(instagram?.totals.impressions).toBe(1100);
    expect(analysis.limitations.join(" ")).toContain(
      `pseudo-platform "${PSEUDO_PLATFORM}"`
    );
    expect(analysis.limitations.join(" ")).toContain(
      "not a distribution channel"
    );
    // No finding names the pseudo-platform as a variant.
    expect(
      analysis.findings.every(
        f => !f.statement.includes('"all"') && !f.statement.includes('"All"')
      )
    ).toBe(true);
  });

  it("notes cross-platform attribution inside a variant without failing closed on it", () => {
    const records = richPlatformRecords();
    records[0].observations.push(
      obs("impressions", 50, "tiktok", "2026-05-08")
    );
    const analysis = analyzeVariantPerformance({
      ...richPlatformInput(),
      records,
    });
    expect(analysis.comparability).toBe("comparable");
    expect(analysis.limitations.join(" ")).toContain(
      "attributed to other platforms"
    );
  });
});

describe("identity preservation across dimensions", () => {
  function richDays(): DaySlice[] {
    return [
      {
        date: "2026-05-03",
        impressions: 200,
        clicks: 24,
        conversions: 3,
        engagement: 8,
      },
      {
        date: "2026-05-04",
        impressions: 200,
        clicks: 24,
        conversions: 2,
        engagement: 8,
      },
      {
        date: "2026-05-05",
        impressions: 200,
        clicks: 24,
        conversions: 2,
        engagement: 8,
      },
      {
        date: "2026-05-06",
        impressions: 200,
        clicks: 24,
        conversions: 3,
        engagement: 8,
      },
      {
        date: "2026-05-07",
        impressions: 200,
        clicks: 24,
        conversions: 2,
        engagement: 8,
      },
    ];
  }

  it("preserves approved message/copy identities verbatim", () => {
    const copyA: VariantIdentity = {
      kind: "message_copy",
      label: "Copy A",
      copy: {
        copyHashSha256: "aa11cc",
        copySchemaVersion: "copy-v2",
        approvedRevisionId: "rev-1",
        assessmentHashSha256: "bb22dd",
        contextLockId: "lock-9",
      },
    };
    const copyB: VariantIdentity = {
      kind: "message_copy",
      label: "Copy B",
      copy: { copyHashSha256: "ee33ff", approvedRevisionId: "rev-2" },
    };
    const analysis = analyzeVariantPerformance({
      campaignId: 5,
      ...WINDOW,
      dimension: "message_copy",
      objectiveMetric: "conversions",
      records: [
        makeRecord(
          copyA,
          "instagram",
          richDays(),
          makePublications(
            "instagram",
            ["receipt:publication:instagram:1"],
            ["2026-05-03"]
          )
        ),
        makeRecord(
          copyB,
          "instagram",
          richDays(),
          makePublications(
            "instagram",
            ["receipt:publication:instagram:2"],
            ["2026-05-04"]
          )
        ),
      ],
    });
    expect(analysis.comparability).toBe("comparable");
    const variantA = analysis.variants.find(
      v => v.identity.copy?.copyHashSha256 === "aa11cc"
    );
    expect(variantA).toBeDefined();
    expect(variantA?.key).toBe("aa11cc");
    expect(variantA?.identity.copy?.approvedRevisionId).toBe("rev-1");
    expect(variantA?.identity.copy?.assessmentHashSha256).toBe("bb22dd");
    const variantB = analysis.variants.find(
      v => v.identity.copy?.copyHashSha256 === "ee33ff"
    );
    expect(variantB?.identity.copy?.approvedRevisionId).toBe("rev-2");
  });

  it("preserves creative/visual identities verbatim", () => {
    const creativeA: VariantIdentity = {
      kind: "creative",
      label: "Creative A",
      creative: {
        mediaKind: "image",
        generatedAssetId: 7,
        renderLineageFingerprintSha256: "render-aaa",
      },
    };
    const creativeB: VariantIdentity = {
      kind: "creative",
      label: "Creative B",
      creative: {
        mediaKind: "image",
        generatedAssetId: 8,
        renderLineageFingerprintSha256: "render-bbb",
      },
    };
    const analysis = analyzeVariantPerformance({
      campaignId: 5,
      ...WINDOW,
      dimension: "creative",
      objectiveMetric: "conversions",
      records: [
        makeRecord(
          creativeA,
          "instagram",
          richDays(),
          makePublications(
            "instagram",
            ["receipt:publication:instagram:1"],
            ["2026-05-03"]
          )
        ),
        makeRecord(
          creativeB,
          "instagram",
          richDays(),
          makePublications(
            "instagram",
            ["receipt:publication:instagram:2"],
            ["2026-05-04"]
          )
        ),
      ],
    });
    expect(analysis.comparability).toBe("comparable");
    const variantA = analysis.variants.find(
      v => v.identity.creative?.generatedAssetId === 7
    );
    expect(variantA?.identity.creative?.renderLineageFingerprintSha256).toBe(
      "render-aaa"
    );
    expect(variantA?.key).toBe("render-aaa");
    const variantB = analysis.variants.find(
      v => v.identity.creative?.generatedAssetId === 8
    );
    expect(variantB?.identity.creative?.renderLineageFingerprintSha256).toBe(
      "render-bbb"
    );
  });

  it("supports caption and format dimensions from durable identity", () => {
    const captionAnalysis = analyzeVariantPerformance({
      campaignId: 5,
      ...WINDOW,
      dimension: "caption",
      objectiveMetric: "conversions",
      records: [
        makeRecord(
          {
            kind: "caption",
            label: "Caption A",
            caption: {
              artifactId: 11,
              artifactKind: "caption_pack",
              lineageFingerprintSha256: "cap-aaa",
            },
          },
          "instagram",
          richDays(),
          makePublications(
            "instagram",
            ["receipt:publication:instagram:1"],
            ["2026-05-03"]
          )
        ),
        makeRecord(
          {
            kind: "caption",
            label: "Caption B",
            caption: {
              artifactId: 12,
              artifactKind: "caption_pack",
              lineageFingerprintSha256: "cap-bbb",
            },
          },
          "instagram",
          richDays(),
          makePublications(
            "instagram",
            ["receipt:publication:instagram:2"],
            ["2026-05-04"]
          )
        ),
      ],
    });
    expect(captionAnalysis.comparability).toBe("comparable");
    expect(captionAnalysis.variants.map(v => v.key)).toEqual([
      "cap-aaa",
      "cap-bbb",
    ]);
    expect(captionAnalysis.variants[0].identity.caption?.artifactId).toBe(11);

    const formatAnalysis = analyzeVariantPerformance({
      campaignId: 5,
      ...WINDOW,
      dimension: "format",
      objectiveMetric: "conversions",
      records: [
        makeRecord(
          { kind: "format", format: "social_post", label: "Social Post" },
          "instagram",
          richDays(),
          makePublications(
            "instagram",
            ["receipt:publication:instagram:1"],
            ["2026-05-03"]
          )
        ),
        makeRecord(
          { kind: "format", format: "ad_copy", label: "Ad Copy" },
          "instagram",
          richDays(),
          makePublications(
            "instagram",
            ["receipt:publication:instagram:2"],
            ["2026-05-04"]
          )
        ),
      ],
    });
    expect(formatAnalysis.comparability).toBe("comparable");
    expect(formatAnalysis.variants.map(v => v.key)).toEqual([
      "ad_copy",
      "social_post",
    ]);
  });
});

describe("evidence discipline", () => {
  it("keeps every evidence ref traceable to a provided observation", () => {
    const input = richPlatformInput();
    const analysis = analyzeVariantPerformance(input);
    const providedIds = new Set(
      input.records.flatMap(r => r.observations.map(o => o.id))
    );
    for (const variant of analysis.variants) {
      expect(variant.evidenceRefs.length).toBeGreaterThan(0);
      for (const ref of variant.evidenceRefs)
        expect(providedIds.has(ref)).toBe(true);
    }
    for (const finding of analysis.findings) {
      for (const ref of finding.evidenceRefs)
        expect(providedIds.has(ref)).toBe(true);
    }
  });

  it("emits no causal wording in any finding statement", () => {
    const comparable = analyzeVariantPerformance(richPlatformInput());
    const nonComparable = analyzeVariantPerformance({
      ...richPlatformInput(),
      records: richPlatformRecords().slice(0, 1),
    });
    for (const analysis of [comparable, nonComparable]) {
      for (const finding of analysis.findings) {
        expect(CAUSAL_WORDING_RE.test(finding.statement)).toBe(false);
      }
    }
    // Comparative language follows the allowed "recorded" pattern.
    for (const finding of comparable.findings.filter(
      f => f.kind === "comparative_rate"
    )) {
      expect(finding.statement).toMatch(/recorded a higher .* in this window/);
    }
    // The no-causality guard is stated explicitly in limitations.
    expect(comparable.limitations.join(" ")).toContain(
      "no causal relationship is asserted"
    );
  });

  it("scopes observations to the analysis window", () => {
    const input = richPlatformInput();
    input.records[0].observations.push(
      obs("impressions", 999, "instagram", "2026-06-01")
    );
    const analysis = analyzeVariantPerformance(input);
    const instagram = analysis.variants.find(v => v.key === "instagram");
    expect(instagram?.totals.impressions).toBe(1000);
  });

  it("merges same-key records deterministically without double-counting observations", () => {
    const records = richPlatformRecords();
    const igExtra = makeRecord(
      instagramIdentity(),
      "instagram",
      [
        {
          date: "2026-05-08",
          impressions: 300,
          clicks: 30,
          conversions: 3,
          engagement: 12,
        },
      ],
      makePublications(
        "instagram",
        ["receipt:publication:instagram:5"],
        ["2026-05-08"]
      )
    );
    // A duplicate observation id must be counted once.
    igExtra.observations.push(records[0].observations[0]);
    const analysis = analyzeVariantPerformance({
      ...richPlatformInput(),
      records: [records[0], records[1], igExtra],
    });
    const instagram = analysis.variants.find(v => v.key === "instagram");
    expect(instagram?.totals.impressions).toBe(1300);
    expect(instagram?.publicationCount).toBe(3);
    const uniqueRefs = new Set(instagram?.evidenceRefs);
    expect(uniqueRefs.size).toBe(instagram?.evidenceRefs.length);
  });
});

describe("determinism", () => {
  it("produces byte-identical output for identical inputs", () => {
    const first = analyzeVariantPerformance(richPlatformInput());
    const second = analyzeVariantPerformance(richPlatformInput());
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("produces identical output regardless of input order", () => {
    const input = richPlatformInput();
    const reversed: VariantAnalysisInput = {
      ...input,
      records: [...input.records].reverse().map(r => ({
        ...r,
        observations: [...r.observations].reverse(),
        publications: [...r.publications].reverse(),
      })),
    };
    expect(JSON.stringify(analyzeVariantPerformance(reversed))).toBe(
      JSON.stringify(analyzeVariantPerformance(input))
    );
  });
});

describe("confidence", () => {
  it("scores high confidence on a sound multi-variant comparison", () => {
    const analysis = analyzeVariantPerformance(richPlatformInput());
    // comparable + complete lineage + objective volume 17 -> wait, 17 < 30.
    expect(analysis.confidence).toBe("high");
    expect(analysis.objectiveMetric).toBe("conversions");
  });

  it("scores reduced confidence when no objective volume threshold is met", () => {
    const analysis = analyzeVariantPerformance({
      ...richPlatformInput(),
      objectiveMetric: "leads", // no leads recorded anywhere
    });
    expect(analysis.confidence).toBe("medium");
  });
});
