import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  extractCampaignKeywords,
  countKeywordMatches,
  computeBaselineScore,
  confidenceFromScore,
  actionFromScore,
} from "../scoring";
import type { CampaignInterestSignal } from "@db/schema";

describe("extractCampaignKeywords", () => {
  it("extracts meaningful keywords from campaign fields", () => {
    const keywords = extractCampaignKeywords({
      name: "Canvas Wall Art Sale",
      goal: "drive orders",
      targetAudience: "home décor lovers in Johannesburg",
      productOrService: "canvas prints and wall art",
      offerDetails: "10% off orders above R3000",
      primaryOutcome: "website sales",
      coreMessage: "Turn memories into art",
    });

    expect(keywords).toContain("canvas");
    expect(keywords).toContain("wall");
    expect(keywords).toContain("johannesburg");
    expect(keywords).toContain("orders");
    expect(keywords).not.toContain("off"); // too short
  });
});

describe("countKeywordMatches", () => {
  it("counts how many keywords appear in text", () => {
    const keywords = ["canvas", "prints", "johannesburg", "family"];
    const text = "Looking for canvas prints in Johannesburg for family photos";
    expect(countKeywordMatches(text, keywords)).toBe(4);
  });

  it("returns 0 for null text", () => {
    expect(countKeywordMatches(null, ["canvas"])).toBe(0);
  });
});

describe("computeBaselineScore", () => {
  const now = new Date("2026-06-23T12:00:00Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("scores a comment more highly than a like", () => {
    const signal = { id: 1, strength: 25 } as CampaignInterestSignal;
    const commentEvents = [
      { eventType: "comment", eventTimestamp: now, messageText: "Love the canvas prints" },
    ];
    const likeEvents = [{ eventType: "like", eventTimestamp: now, messageText: null }];

    const commentScore = computeBaselineScore(signal, commentEvents, ["canvas"]);
    const likeScore = computeBaselineScore(signal, likeEvents, ["canvas"]);

    expect(commentScore.score).toBeGreaterThan(likeScore.score);
  });

  it("applies keyword match bonus capped at 20", () => {
    const signal = { id: 1, strength: 25 } as CampaignInterestSignal;
    const events = [
      {
        eventType: "comment",
        eventTimestamp: now,
        messageText:
          "canvas prints wall art johannesburg home decor family graduation gift",
      },
    ];

    const result = computeBaselineScore(signal, events, [
      "canvas",
      "prints",
      "wall",
      "johannesburg",
      "family",
      "graduation",
      "gift",
    ]);

    expect(result.keywordBonus).toBe(20);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it("reduces score for old events", () => {
    const signal = { id: 1, strength: 25 } as CampaignInterestSignal;
    const recent = [
      { eventType: "comment", eventTimestamp: now, messageText: null },
    ];
    const old = [
      {
        eventType: "comment",
        eventTimestamp: new Date("2026-03-01T12:00:00Z"),
        messageText: null,
      },
    ];

    const recentScore = computeBaselineScore(signal, recent, []);
    const oldScore = computeBaselineScore(signal, old, []);

    expect(recentScore.score).toBeGreaterThan(oldScore.score);
  });

  it("caps score at 100", () => {
    const signal = { id: 1, strength: 100 } as CampaignInterestSignal;
    const events = Array.from({ length: 20 }, () => ({
      eventType: "message",
      eventTimestamp: now,
      messageText: "Interested",
    }));

    const result = computeBaselineScore(signal, events, []);
    expect(result.score).toBe(100);
  });
});

describe("confidenceFromScore", () => {
  it("returns high confidence for strong multi-signal leads", () => {
    expect(confidenceFromScore(75, 2)).toBe("high");
  });

  it("returns medium confidence for moderate leads", () => {
    expect(confidenceFromScore(50, 1)).toBe("medium");
  });

  it("returns low confidence for weak leads", () => {
    expect(confidenceFromScore(30, 1)).toBe("low");
  });
});

describe("actionFromScore", () => {
  it("recommends reach_out for high confident leads", () => {
    expect(actionFromScore(80, "high")).toBe("reach_out");
  });

  it("does not recommend reach_out for low confidence", () => {
    expect(actionFromScore(80, "low")).toBe("nurture");
  });

  it("recommends nurture for moderate scores", () => {
    expect(actionFromScore(55, "medium")).toBe("nurture");
  });

  it("recommends ignore for low scores", () => {
    expect(actionFromScore(20, "low")).toBe("ignore");
  });
});
