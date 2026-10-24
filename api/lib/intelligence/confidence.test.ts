import { describe, expect, it } from "vitest";
import {
  combineOverallConfidence,
  CONFIDENCE_ORDER,
  gateHandling,
  mapModelConfidence,
  minConfidence,
} from "./confidence";
import type { ConfidenceLabel, HandlingClass } from "./interpretation-contract";

const ALL_CONFIDENCE: readonly ConfidenceLabel[] = ["high", "medium", "low", "unknown"];
const ALL_HANDLING: readonly HandlingClass[] = [
  "no_action",
  "monitor",
  "candidate_for_engagement",
  "human_review",
  "safety_escalation",
  "opportunity_candidate",
];

describe("CONFIDENCE_ORDER", () => {
  it("encodes unknown < low < medium < high", () => {
    expect(CONFIDENCE_ORDER.unknown).toBeLessThan(CONFIDENCE_ORDER.low);
    expect(CONFIDENCE_ORDER.low).toBeLessThan(CONFIDENCE_ORDER.medium);
    expect(CONFIDENCE_ORDER.medium).toBeLessThan(CONFIDENCE_ORDER.high);
  });
});

describe("minConfidence / combineOverallConfidence", () => {
  it("returns the ordinal minimum across variadic inputs", () => {
    expect(minConfidence("high")).toBe("high");
    expect(minConfidence("high", "medium")).toBe("medium");
    expect(minConfidence("high", "low", "medium")).toBe("low");
    expect(minConfidence("medium", "unknown")).toBe("unknown");
  });

  it("combines intent/sentiment/relevance per contract §8", () => {
    expect(
      combineOverallConfidence({
        intentConfidence: "high",
        sentimentConfidence: "medium",
        relevanceConfidence: "low",
      })
    ).toBe("low");
    expect(
      combineOverallConfidence({
        intentConfidence: "high",
        sentimentConfidence: "high",
        relevanceConfidence: "high",
      })
    ).toBe("high");
    expect(
      combineOverallConfidence({
        intentConfidence: "medium",
        sentimentConfidence: "medium",
        relevanceConfidence: "unknown",
      })
    ).toBe("unknown");
  });

  it("maps model self-assessment ordinally and never upgrades", () => {
    expect(mapModelConfidence("high")).toBe("high");
    expect(mapModelConfidence("medium")).toBe("medium");
    expect(mapModelConfidence("low")).toBe("low");
  });
});

describe("gateHandling — full truth table (contract §8)", () => {
  it("high confidence allows every handling class unchanged", () => {
    for (const desired of ALL_HANDLING) {
      expect(gateHandling("high", desired)).toBe(desired);
    }
  });

  it("medium confidence allows every handling class unchanged (downstream treats as tentative)", () => {
    for (const desired of ALL_HANDLING) {
      expect(gateHandling("medium", desired)).toBe(desired);
    }
  });

  it("low confidence collapses to human_review, except safety_escalation survives", () => {
    const expected: Record<HandlingClass, HandlingClass> = {
      no_action: "human_review",
      monitor: "human_review",
      candidate_for_engagement: "human_review",
      human_review: "human_review",
      safety_escalation: "safety_escalation",
      opportunity_candidate: "human_review",
    };
    for (const desired of ALL_HANDLING) {
      expect(gateHandling("low", desired)).toBe(expected[desired]);
    }
  });

  it("unknown confidence collapses to monitor, except safety_escalation survives", () => {
    const expected: Record<HandlingClass, HandlingClass> = {
      no_action: "monitor",
      monitor: "monitor",
      candidate_for_engagement: "monitor",
      human_review: "monitor",
      safety_escalation: "safety_escalation",
      opportunity_candidate: "monitor",
    };
    for (const desired of ALL_HANDLING) {
      expect(gateHandling("unknown", desired)).toBe(expected[desired]);
    }
  });

  it("never lets low/unknown surface auto-actionable classes", () => {
    for (const overall of ["low", "unknown"] as const) {
      for (const desired of ALL_HANDLING) {
        const gated = gateHandling(overall, desired);
        expect(gated === "candidate_for_engagement" || gated === "opportunity_candidate").toBe(
          false
        );
      }
    }
  });

  it("covers every overall × desired combination without falling through", () => {
    for (const overall of ALL_CONFIDENCE) {
      for (const desired of ALL_HANDLING) {
        expect(ALL_HANDLING).toContain(gateHandling(overall, desired));
      }
    }
  });
});
