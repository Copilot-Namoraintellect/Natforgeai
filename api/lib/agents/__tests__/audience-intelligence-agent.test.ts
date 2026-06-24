import { describe, it, expect } from "vitest";
import { normaliseOutput } from "../audience-intelligence-normalise";

describe("normaliseOutput", () => {
  it("fills missing fields with safe defaults", () => {
    const result = normaliseOutput({
      executiveSummary: "Great engagement",
      scoredLeads: [
        {
          externalIdentifier: "fb:123",
          platform: "facebook",
          score: 85,
          confidence: "high",
          recommendedAction: "reach_out",
          explanation: "Highly engaged",
          outreachAngles: [{ channel: "facebook_dm", hook: "Hi" }],
        },
      ],
    });

    expect(result.executiveSummary).toBe("Great engagement");
    expect(result.scoredLeads).toHaveLength(1);
    expect(result.scoredLeads[0].handle).toBeNull();
    expect(result.scoredLeads[0].signals).toEqual([]);
    expect(result.scoredLeads[0].outreachAngles[0].cta).toBe("");
    expect(result.discoveredProfiles).toEqual([]);
    expect(result.contentResonance).toEqual([]);
    expect(result.nextSteps).toEqual([]);
  });

  it("normalises invalid enum values to defaults", () => {
    const result = normaliseOutput({
      scoredLeads: [
        {
          externalIdentifier: "li:456",
          platform: "linkedin",
          score: 110,
          confidence: "invalid",
          recommendedAction: "unknown",
          outreachAngles: [{ channel: "invalid_channel" }],
        },
      ],
    });

    expect(result.scoredLeads[0].score).toBe(100);
    expect(result.scoredLeads[0].confidence).toBe("low");
    expect(result.scoredLeads[0].recommendedAction).toBe("ignore");
    expect(result.scoredLeads[0].outreachAngles[0].channel).toBe("email");
  });

  it("returns defaults for non-object input", () => {
    const result = normaliseOutput(null);
    expect(result.scoredLeads).toEqual([]);
    expect(result.executiveSummary).toBe("");
  });
});
