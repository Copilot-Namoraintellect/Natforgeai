import {
  describe,
  expect,
  it,
} from "vitest";

import {
  resolveWorkflowTransition,
} from "./engine";

describe(
  "post-live governed workflow transition map",
  () => {
    it("preserves campaign_live to engagement_active", () => {
      expect(
        resolveWorkflowTransition(
          "campaign_live",
          "start_engagement"
        )
      ).toBe("engagement_active");
    });

    it("preserves engagement_active to leads_converting", () => {
      expect(
        resolveWorkflowTransition(
          "engagement_active",
          "start_lead_conversion"
        )
      ).toBe("leads_converting");
    });

    it("preserves leads_converting to optimisation_active", () => {
      expect(
        resolveWorkflowTransition(
          "leads_converting",
          "start_optimisation"
        )
      ).toBe("optimisation_active");
    });

    it("preserves optimisation_active to completed", () => {
      expect(
        resolveWorkflowTransition(
          "optimisation_active",
          "complete_campaign"
        )
      ).toBe("completed");
    });

    it("allows Learning-driven optimisation without fabricated lead conversion", () => {
      expect(
        resolveWorkflowTransition(
          "engagement_active",
          "start_optimisation"
        )
      ).toBe("optimisation_active");
    });

    it("allows an ended campaign_live campaign to complete directly", () => {
      expect(
        resolveWorkflowTransition(
          "campaign_live",
          "complete_campaign"
        )
      ).toBe("completed");
    });

    it("allows an ended engagement_active campaign to complete directly", () => {
      expect(
        resolveWorkflowTransition(
          "engagement_active",
          "complete_campaign"
        )
      ).toBe("completed");
    });

    it("allows an ended leads_converting campaign to complete directly", () => {
      expect(
        resolveWorkflowTransition(
          "leads_converting",
          "complete_campaign"
        )
      ).toBe("completed");
    });

    it("does not allow optimisation directly from campaign_live", () => {
      expect(
        resolveWorkflowTransition(
          "campaign_live",
          "start_optimisation"
        )
      ).toBeNull();
    });

    it("does not allow complete_campaign from completed", () => {
      expect(
        resolveWorkflowTransition(
          "completed",
          "complete_campaign"
        )
      ).toBeNull();
    });
  }
);