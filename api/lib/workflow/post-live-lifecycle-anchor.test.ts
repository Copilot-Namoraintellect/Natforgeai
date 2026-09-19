import {
  describe,
  expect,
  it,
} from "vitest";

import {
  buildWorkflowTransitionContext,
  readCampaignLiveAtFromWorkflowContext,
} from "./post-live-lifecycle-anchor";

describe(
  "post-live lifecycle live anchor",
  () => {
    it("establishes campaignLiveAt exactly when go_live occurs", () => {
      const context =
        buildWorkflowTransitionContext({
          existingContext: {
            retained: "value",
          },
          currentState:
            "publication_pending",
          nextState:
            "campaign_live",
          action: "go_live",
          transitionAt:
            "2026-09-10T12:00:00Z",
        });

      expect(context).toMatchObject({
        retained: "value",
        campaignLiveAt:
          "2026-09-10T12:00:00.000Z",
        lastTransition: {
          from:
            "publication_pending",
          to: "campaign_live",
          action: "go_live",
          at:
            "2026-09-10T12:00:00.000Z",
        },
      });
    });

    it("preserves the original live anchor through later lifecycle transitions", () => {
      const context =
        buildWorkflowTransitionContext({
          existingContext: {
            campaignLiveAt:
              "2026-09-10T12:00:00Z",
            lastTransition: {
              from:
                "publication_pending",
              to: "campaign_live",
              action: "go_live",
              at:
                "2026-09-10T12:00:00Z",
            },
          },
          currentState:
            "campaign_live",
          nextState:
            "engagement_active",
          action:
            "start_engagement",
          transitionAt:
            "2026-09-10T12:05:00Z",
        });

      expect(
        context.campaignLiveAt
      ).toBe(
        "2026-09-10T12:00:00.000Z"
      );

      expect(
        context.lastTransition
      ).toEqual({
        from: "campaign_live",
        to: "engagement_active",
        action:
          "start_engagement",
        at:
          "2026-09-10T12:05:00.000Z",
      });
    });

    it("backfills a legacy P1.1 live campaign from its go_live lastTransition", () => {
      const context =
        buildWorkflowTransitionContext({
          existingContext: {
            lastTransition: {
              from:
                "publication_pending",
              to: "campaign_live",
              action: "go_live",
              at:
                "2026-09-10T12:00:00Z",
            },
          },
          currentState:
            "campaign_live",
          nextState:
            "engagement_active",
          action:
            "start_engagement",
          transitionAt:
            "2026-09-10T12:05:00Z",
        });

      expect(
        context.campaignLiveAt
      ).toBe(
        "2026-09-10T12:00:00.000Z"
      );
    });

    it("reads the persisted immutable anchor before consulting lastTransition", () => {
      const result =
        readCampaignLiveAtFromWorkflowContext(
          {
            campaignLiveAt:
              "2026-09-10T12:00:00Z",
            lastTransition: {
              from:
                "engagement_active",
              to: "leads_converting",
              action:
                "start_lead_conversion",
              at:
                "2026-09-12T09:00:00Z",
            },
          }
        );

      expect(
        result?.toISOString()
      ).toBe(
        "2026-09-10T12:00:00.000Z"
      );
    });

    it("recovers a legacy anchor only from an actual go_live transition", () => {
      expect(
        readCampaignLiveAtFromWorkflowContext(
          {
            lastTransition: {
              from:
                "publication_pending",
              to: "campaign_live",
              action: "go_live",
              at:
                "2026-09-10T12:00:00Z",
            },
          }
        )?.toISOString()
      ).toBe(
        "2026-09-10T12:00:00.000Z"
      );

      expect(
        readCampaignLiveAtFromWorkflowContext(
          {
            lastTransition: {
              from:
                "campaign_live",
              to:
                "engagement_active",
              action:
                "start_engagement",
              at:
                "2026-09-10T12:05:00Z",
            },
          }
        )
      ).toBeNull();
    });

    it("does not invent an anchor when durable go-live evidence is absent", () => {
      expect(
        readCampaignLiveAtFromWorkflowContext(
          {}
        )
      ).toBeNull();
    });

    it("starts a new lifecycle anchor on a later governed go_live", () => {
      const context =
        buildWorkflowTransitionContext({
          existingContext: {
            campaignLiveAt:
              "2026-08-01T08:00:00Z",
          },
          currentState:
            "publication_pending",
          nextState:
            "campaign_live",
          action: "go_live",
          transitionAt:
            "2026-09-15T10:30:00Z",
        });

      expect(
        context.campaignLiveAt
      ).toBe(
        "2026-09-15T10:30:00.000Z"
      );
    });
  }
);