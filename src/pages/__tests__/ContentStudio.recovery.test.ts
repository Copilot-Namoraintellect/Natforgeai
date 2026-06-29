import { describe, it, expect } from "vitest";
import { campaignNeedsRecoveryDecision } from "../../lib/content-studio/logic";

describe("campaignNeedsRecoveryDecision", () => {
  const campaign = { id: 28, workflowState: "creatives_generating" };

  it("returns false when posts exist even if older creative runs failed", () => {
    const result = campaignNeedsRecoveryDecision(
      campaign,
      2,
      [{ id: 123, type: "social_post" }],
      [
        { id: 91, status: "completed" },
        { id: 90, status: "failed" },
      ],
      []
    );
    expect(result).toBe(false);
  });

  it("returns false when posts exist and the latest creative run succeeded", () => {
    const result = campaignNeedsRecoveryDecision(
      campaign,
      2,
      [
        { id: 123, type: "social_post" },
        { id: 122, type: "video_concept" },
      ],
      [{ id: 91, status: "completed" }],
      []
    );
    expect(result).toBe(false);
  });

  it("returns true when no posts exist and the latest creative run failed", () => {
    const result = campaignNeedsRecoveryDecision(
      campaign,
      0,
      [],
      [{ id: 91, status: "failed" }],
      []
    );
    expect(result).toBe(true);
  });

  it("returns true when in creatives_generating and post count is zero", () => {
    const result = campaignNeedsRecoveryDecision(
      campaign,
      0,
      [],
      [],
      []
    );
    expect(result).toBe(true);
  });

  it("returns true when latest strategy run failed in strategy_generated state", () => {
    const result = campaignNeedsRecoveryDecision(
      { id: 28, workflowState: "strategy_generated" },
      0,
      [],
      [],
      [{ id: 87, status: "failed" }]
    );
    expect(result).toBe(true);
  });

  it("returns false for an older strategy failure once creative content exists", () => {
    const result = campaignNeedsRecoveryDecision(
      { id: 28, workflowState: "creatives_ready" },
      2,
      [{ id: 123, type: "social_post" }],
      [{ id: 91, status: "completed" }],
      [
        { id: 88, status: "failed" },
        { id: 87, status: "completed" },
      ]
    );
    expect(result).toBe(false);
  });
});
