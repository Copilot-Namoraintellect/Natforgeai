import { describe, expect, it } from "vitest";
import { decidePostLiveLifecycleAction } from "./post-live-lifecycle-authority";

describe("decidePostLiveLifecycleAction", () => {
  const asOfDate = "2026-09-19";

  it("starts engagement immediately after a governed campaign reaches campaign_live", () => {
    expect(
      decidePostLiveLifecycleAction({
        workflowState: "campaign_live",
        endDate: "2026-09-30",
        asOfDate,
        hasLeadEvidence: false,
        hasLearningEvidence: false,
      })
    ).toEqual({
      action: "start_engagement",
      reason: "engagement_phase_start",
    });
  });

  it("starts lead conversion only when durable lead evidence exists", () => {
    expect(
      decidePostLiveLifecycleAction({
        workflowState: "engagement_active",
        endDate: "2026-09-30",
        asOfDate,
        hasLeadEvidence: true,
        hasLearningEvidence: false,
      })
    ).toEqual({
      action: "start_lead_conversion",
      reason: "lead_evidence_present",
    });
  });

  it("does not fabricate lead conversion when engagement has no lead evidence", () => {
    expect(
      decidePostLiveLifecycleAction({
        workflowState: "engagement_active",
        endDate: "2026-09-30",
        asOfDate,
        hasLeadEvidence: false,
        hasLearningEvidence: false,
      })
    ).toEqual({
      action: null,
      reason: "awaiting_lead_or_learning_evidence",
    });
  });

  it("allows optimisation from engagement when Learning exists without lead evidence", () => {
    expect(
      decidePostLiveLifecycleAction({
        workflowState: "engagement_active",
        endDate: "2026-09-30",
        asOfDate,
        hasLeadEvidence: false,
        hasLearningEvidence: true,
      })
    ).toEqual({
      action: "start_optimisation",
      reason: "learning_evidence_present",
    });
  });

  it("preserves lead conversion first when both lead and Learning evidence exist", () => {
    expect(
      decidePostLiveLifecycleAction({
        workflowState: "engagement_active",
        endDate: "2026-09-30",
        asOfDate,
        hasLeadEvidence: true,
        hasLearningEvidence: true,
      })
    ).toEqual({
      action: "start_lead_conversion",
      reason: "lead_evidence_present",
    });
  });

  it("starts optimisation from leads_converting only when Learning evidence exists", () => {
    expect(
      decidePostLiveLifecycleAction({
        workflowState: "leads_converting",
        endDate: "2026-09-30",
        asOfDate,
        hasLeadEvidence: true,
        hasLearningEvidence: true,
      })
    ).toEqual({
      action: "start_optimisation",
      reason: "learning_evidence_present",
    });
  });

  it("keeps leads_converting in place while Learning evidence is absent", () => {
    expect(
      decidePostLiveLifecycleAction({
        workflowState: "leads_converting",
        endDate: "2026-09-30",
        asOfDate,
        hasLeadEvidence: true,
        hasLearningEvidence: false,
      })
    ).toEqual({
      action: null,
      reason: "awaiting_learning_evidence",
    });
  });

  it("completes from an active post-live state once the inclusive end date has passed", () => {
    expect(
      decidePostLiveLifecycleAction({
        workflowState: "engagement_active",
        endDate: "2026-09-18",
        asOfDate,
        hasLeadEvidence: false,
        hasLearningEvidence: false,
      })
    ).toEqual({
      action: "complete_campaign",
      reason: "campaign_ended",
    });
  });

  it("does not complete on the campaign end date itself", () => {
    expect(
      decidePostLiveLifecycleAction({
        workflowState: "optimisation_active",
        endDate: "2026-09-19",
        asOfDate,
        hasLeadEvidence: true,
        hasLearningEvidence: true,
      })
    ).toEqual({
      action: null,
      reason: "awaiting_campaign_end",
    });
  });

  it("does not autonomously complete a campaign with no end date", () => {
    expect(
      decidePostLiveLifecycleAction({
        workflowState: "optimisation_active",
        endDate: null,
        asOfDate,
        hasLeadEvidence: true,
        hasLearningEvidence: true,
      })
    ).toEqual({
      action: null,
      reason: "awaiting_campaign_end",
    });
  });

  it("is idempotent after completion", () => {
    expect(
      decidePostLiveLifecycleAction({
        workflowState: "completed",
        endDate: "2026-09-01",
        asOfDate,
        hasLeadEvidence: true,
        hasLearningEvidence: true,
      })
    ).toEqual({
      action: null,
      reason: "already_completed",
    });
  });

  it("rejects an ambiguous authority date", () => {
    expect(() =>
      decidePostLiveLifecycleAction({
        workflowState: "campaign_live",
        endDate: "2026-09-30",
        asOfDate: "19/09/2026",
        hasLeadEvidence: false,
        hasLearningEvidence: false,
      })
    ).toThrow("asOfDate must be YYYY-MM-DD");
  });
});