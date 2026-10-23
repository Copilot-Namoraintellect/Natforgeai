import { describe, it, expect } from "vitest";
import {
  getLaunchApprovalStatus,
  buildLaunchApprovalLineage,
  isLaunchApprovalAuthoritative,
  isLaunchApprovalEvidenceUsable,
} from "../launch-approval";
import { resolveCampaignPublicationReadiness } from "../../creative/publication-readiness";
import { buildGroundedCreativeBrief } from "../../creative/brief-grounding";

/**
 * WBS-R4 C3 — Launch authority acceptance.
 *
 * Composition of the pure launch-authority modules (no DB, no providers):
 * durable lineage (launch-approval.ts) is the authority predicate behind the
 * publication-readiness gate (publication-readiness.ts). The executable-row
 * lifecycle effects (approved rows enqueued, rejected rows withdrawn, brand
 * risk policy) are pinned by the existing GAP29 suites:
 *   - api/lib/workflow/triggers.test.ts (withdraw statuses/scope, job cancellation)
 *   - api/lib/workflow/__tests__/publishing-runner-immediate-due.test.ts (campaign-authority gate)
 *   - api/lib/workflow/__tests__/publishing-runner.test.ts (immediate row executes exactly once)
 */

const CAMPAIGN = {
  id: 7,
  userId: 22,
  name: "Autumn campaign",
  goal: "drive signups",
  coreMessage: "Better mornings",
  workflowContext: {},
};

const BUSINESS = { id: 3, userId: 22, name: "Acme" };

const CURRENT_FINGERPRINT = buildGroundedCreativeBrief({
  campaign: CAMPAIGN,
  business: BUSINESS,
}).fingerprint;

function campaignWithLineage(lineage: unknown) {
  return {
    ...CAMPAIGN,
    workflowContext: lineage ? { launchApprovalLineage: lineage } : {},
  };
}

const APPROVAL_ROW = {
  id: 81,
  approvalType: "campaign_launch",
  status: "approved",
  campaignId: 7,
  userId: 22,
};

function currentOutputRecord() {
  return {
    id: 501,
    campaignId: 7,
    userId: 22,
    status: "ready",
    metadata: { creativeBriefFingerprint: CURRENT_FINGERPRINT },
  };
}

function readiness(overrides: Partial<Parameters<typeof resolveCampaignPublicationReadiness>[0]> = {}) {
  return resolveCampaignPublicationReadiness({
    campaign: campaignWithLineage(
      buildLaunchApprovalLineage(CURRENT_FINGERPRINT, 81, "approved")
    ),
    business: BUSINESS,
    approvals: [APPROVAL_ROW],
    selectedOutput: { record: currentOutputRecord(), type: "content_post" },
    requireLaunchApproval: true,
    ...overrides,
  });
}

describe("WBS-R4 C3 launch authority", () => {
  it("approved approval with current lineage grants executable publication authority", () => {
    const result = readiness();
    expect(result.ready).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(
      isLaunchApprovalEvidenceUsable(
        campaignWithLineage(buildLaunchApprovalLineage(CURRENT_FINGERPRINT, 81, "approved")),
        APPROVAL_ROW,
        BUSINESS
      )
    ).toBe(true);
  });

  it("pending approval grants no authority (fail closed)", () => {
    const lineage = buildLaunchApprovalLineage(CURRENT_FINGERPRINT, 81, "pending");
    const campaign = campaignWithLineage(lineage);
    expect(getLaunchApprovalStatus(campaign, BUSINESS).hasApprovedCurrentLaunch).toBe(false);
    expect(isLaunchApprovalEvidenceUsable(campaign, { ...APPROVAL_ROW, status: "pending" }, BUSINESS)).toBe(false);
    const result = readiness({
      campaign,
      approvals: [{ ...APPROVAL_ROW, status: "pending" }],
    });
    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("approval_pending");
  });

  it("rejected approval grants no authority and can never be flipped by a fabricated row", () => {
    const lineage = buildLaunchApprovalLineage(CURRENT_FINGERPRINT, 81, "rejected");
    const campaign = campaignWithLineage(lineage);
    // Even if a rogue/future row claims approved, the durable lineage says
    // rejected — the bare row is never sufficient evidence.
    expect(isLaunchApprovalEvidenceUsable(campaign, APPROVAL_ROW, BUSINESS)).toBe(false);
    const result = readiness({ campaign });
    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("approval_pending");
  });

  it("stale approval (brief changed after approval) blocks execution", () => {
    const staleLineage = buildLaunchApprovalLineage("old-brief-fingerprint", 81, "approved");
    const campaign = campaignWithLineage(staleLineage);
    const status = getLaunchApprovalStatus(campaign, BUSINESS);
    expect(status.currentFingerprint).toBe(CURRENT_FINGERPRINT);
    expect(status.hasApprovedCurrentLaunch).toBe(false);
    expect(isLaunchApprovalEvidenceUsable(campaign, APPROVAL_ROW, BUSINESS)).toBe(false);
    expect(isLaunchApprovalAuthoritative(campaign, { approvalRequestId: 81 }, BUSINESS)).toBe(false);
    const result = readiness({ campaign });
    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("approval_pending");
  });

  it("mismatched lineage request id is not usable", () => {
    const lineage = buildLaunchApprovalLineage(CURRENT_FINGERPRINT, 82, "approved");
    const campaign = campaignWithLineage(lineage);
    expect(isLaunchApprovalEvidenceUsable(campaign, APPROVAL_ROW, BUSINESS)).toBe(false);
    expect(isLaunchApprovalAuthoritative(campaign, { approvalRequestId: 81 }, BUSINESS)).toBe(false);
  });

  it("cross-user approval row is not usable (tenant isolation)", () => {
    const campaign = campaignWithLineage(
      buildLaunchApprovalLineage(CURRENT_FINGERPRINT, 81, "approved")
    );
    expect(
      isLaunchApprovalEvidenceUsable(campaign, { ...APPROVAL_ROW, userId: 999 }, BUSINESS)
    ).toBe(false);
  });

  it("cross-campaign approval row is not usable", () => {
    const campaign = campaignWithLineage(
      buildLaunchApprovalLineage(CURRENT_FINGERPRINT, 81, "approved")
    );
    expect(
      isLaunchApprovalEvidenceUsable(campaign, { ...APPROVAL_ROW, campaignId: 8 }, BUSINESS)
    ).toBe(false);
  });

  it("bare approved row without durable lineage is never sufficient (fabrication defence)", () => {
    const campaign = campaignWithLineage(null);
    expect(isLaunchApprovalEvidenceUsable(campaign, APPROVAL_ROW, BUSINESS)).toBe(false);
    const result = readiness({ campaign, approvals: [APPROVAL_ROW] });
    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("approval_pending");
  });

  it("no executable publication without any approval rows", () => {
    const result = readiness({ approvals: [] });
    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("approval_pending");
  });

  it("stale creative (fingerprint drift) is blocked even with valid launch authority", () => {
    const staleOutput = {
      ...currentOutputRecord(),
      metadata: { creativeBriefFingerprint: "old-brief-fingerprint" },
    };
    const result = readiness({
      selectedOutput: { record: staleOutput, type: "content_post" },
    });
    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("selected_output_stale");
  });

  it("duplicate approval callback cannot re-authorise: lineage is bound to one request id", () => {
    // The first resolution bound lineage to request 81 for the current brief.
    const campaign = campaignWithLineage(
      buildLaunchApprovalLineage(CURRENT_FINGERPRINT, 81, "approved")
    );
    // A replayed callback carrying a DIFFERENT request id is not authoritative.
    expect(isLaunchApprovalAuthoritative(campaign, { approvalRequestId: 82 }, BUSINESS)).toBe(false);
    // The original request stays authoritative exactly once.
    expect(isLaunchApprovalAuthoritative(campaign, { approvalRequestId: 81 }, BUSINESS)).toBe(true);
  });
});
