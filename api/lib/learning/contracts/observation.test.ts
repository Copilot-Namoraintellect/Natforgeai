import { describe, expect, it } from "vitest";
import {
  normaliseObservations,
  sumMetrics,
  toISODate,
  type RawAnalyticsRow,
} from "./observation";

const row = (
  id: number,
  metricType: string,
  value: number | null,
  date: string,
  platform: string | null = "instagram"
): RawAnalyticsRow => ({ id, metricType, platform, value, date });

describe("toISODate", () => {
  it("accepts Date objects and strings deterministically", () => {
    expect(toISODate(new Date("2026-05-04T10:20:30Z"))).toBe("2026-05-04");
    expect(toISODate("2026-05-04")).toBe("2026-05-04");
    expect(toISODate("2026-05-04 12:00:00")).toBe("2026-05-04");
  });
});

describe("normaliseObservations", () => {
  it("produces one grounded observation per analytics row inside the window", () => {
    const { observations, issues } = normaliseObservations(
      [
        row(1, "impressions", 1000, "2026-05-01"),
        row(2, "clicks", 40, "2026-05-02", null),
      ],
      "2026-05-01",
      "2026-05-31"
    );

    expect(issues).toEqual([]);
    expect(observations).toHaveLength(2);

    const first = observations[0];
    expect(first.id).toBe("ao:1");
    expect(first.metricType).toBe("impressions");
    expect(first.value).toBe(1000);
    expect(first.provenance).toEqual({
      kind: "analytics",
      analyticsId: 1,
      metricType: "impressions",
      platform: "instagram",
      date: "2026-05-01",
    });

    // null platform normalises to "all" while provenance keeps the raw fact
    expect(observations[1].platform).toBe("all");
    expect(observations[1].provenance.platform).toBeNull();
  });

  it("excludes rows outside the window", () => {
    const { observations } = normaliseObservations(
      [
        row(1, "impressions", 100, "2026-04-30"),
        row(2, "impressions", 200, "2026-05-01"),
        row(3, "impressions", 300, "2026-06-01"),
      ],
      "2026-05-01",
      "2026-05-31"
    );
    expect(observations.map((o) => o.id)).toEqual(["ao:2"]);
  });

  it("skips unknown metric types and invalid values with issues, never throws", () => {
    const { observations, issues } = normaliseObservations(
      [
        row(1, "not_a_metric", 10, "2026-05-01"),
        row(2, "clicks", null, "2026-05-01"),
        row(3, "clicks", Number.NaN, "2026-05-01"),
        row(4, "clicks", 5, "2026-05-01"),
      ],
      "2026-05-01",
      "2026-05-31"
    );

    expect(observations.map((o) => o.id)).toEqual(["ao:4"]);
    expect(issues).toEqual([
      { analyticsId: 1, reason: "unknown_metric_type", rawMetricType: "not_a_metric" },
      { analyticsId: 2, reason: "invalid_value" },
      { analyticsId: 3, reason: "invalid_value" },
    ]);
  });

  it("clamps negative values to zero facts", () => {
    const { observations } = normaliseObservations(
      [row(1, "clicks", -7, "2026-05-01")],
      "2026-05-01",
      "2026-05-31"
    );
    expect(observations[0].value).toBe(0);
  });

  it("is deterministic: identical input yields byte-identical output order", () => {
    const input = [
      row(9, "clicks", 1, "2026-05-03", "tiktok"),
      row(3, "impressions", 1, "2026-05-01", "tiktok"),
      row(7, "clicks", 1, "2026-05-01", null),
      row(5, "impressions", 1, "2026-05-01", "instagram"),
    ];
    const a = normaliseObservations(input, "2026-05-01", "2026-05-31");
    const b = normaliseObservations([...input].reverse(), "2026-05-01", "2026-05-31");
    expect(a.observations.map((o) => o.id)).toEqual(b.observations.map((o) => o.id));
    expect(JSON.stringify(a.observations)).toBe(JSON.stringify(b.observations));
  });
});

describe("sumMetrics", () => {
  it("totals each metric across observations", () => {
    const { observations } = normaliseObservations(
      [
        row(1, "impressions", 100, "2026-05-01"),
        row(2, "impressions", 250, "2026-05-02"),
        row(3, "clicks", 7, "2026-05-01"),
      ],
      "2026-05-01",
      "2026-05-31"
    );
    const totals = sumMetrics(observations);
    expect(totals.impressions).toBe(350);
    expect(totals.clicks).toBe(7);
    expect(totals.conversions).toBe(0);
  });
});
