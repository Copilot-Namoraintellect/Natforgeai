/**
 * WBS-R5-E1 — Canonical Marketing Action Request acceptance.
 */
import { describe, it, expect } from "vitest";
import {
  buildMarketingActionRequest,
  buildActionRequestFingerprint,
  isActionRequestIdentityConflict,
  deriveCostClass,
  isBillableAction,
  requiresProviderCapability,
  ACTION_COST_CREDITS,
  MARKETING_ACTION_TYPES,
  ActionRequestError,
  type MarketingActionRequestInput,
} from "./action-request";

const VALID_INPUT: MarketingActionRequestInput = {
  actionRequestId: "ar1:comment-771",
  businessId: 10,
  sourceSignalId: "sig-100",
  sourceInterpretationId: "interp-9",
  actionType: "reply_publicly",
  platform: "instagram",
  providerAccountBinding: { integrationId: 4, platform: "instagram", externalAccountRef: "page-1" },
  campaignId: 55,
  publicationId: null,
  estimatedCostClass: "low",
  requestedAt: "2026-06-28T10:00:00.000Z",
  contextVersion: "ctx:abc123",
};

describe("E1 canonical action request", () => {
  it("accepts a fully-formed request and normalizes it", () => {
    const request = buildMarketingActionRequest(VALID_INPUT);
    expect(request.actionRequestId).toBe("ar1:comment-771");
    expect(request.actionType).toBe("reply_publicly");
    expect(request.providerAccountBinding?.integrationId).toBe(4);
  });

  it("accepts null references for optional correlation fields", () => {
    const request = buildMarketingActionRequest({
      ...VALID_INPUT,
      sourceSignalId: null,
      sourceInterpretationId: null,
      campaignId: null,
      providerAccountBinding: null,
      actionType: "observe_only",
      estimatedCostClass: "none",
    });
    expect(request.sourceSignalId).toBeNull();
    expect(request.campaignId).toBeNull();
  });

  it.each(MARKETING_ACTION_TYPES.map((t) => [t]))("accepts action type %s", (actionType) => {
    const needsProvider = requiresProviderCapability(actionType as any);
    const request = buildMarketingActionRequest({
      ...VALID_INPUT,
      actionType: actionType as any,
      estimatedCostClass: deriveCostClass(actionType as any),
      providerAccountBinding: needsProvider ? VALID_INPUT.providerAccountBinding : null,
    });
    expect(request.actionType).toBe(actionType);
  });

  it("fails closed on an unknown action type", () => {
    expect(() =>
      buildMarketingActionRequest({ ...VALID_INPUT, actionType: "delete_all_posts" as any })
    ).toThrowError(ActionRequestError);
  });

  it("fails closed on an unsupported platform", () => {
    expect(() =>
      buildMarketingActionRequest({ ...VALID_INPUT, platform: "myspace" as any })
    ).toThrowError(/platform/);
  });

  it("fails closed when a provider-capable action has no binding", () => {
    expect(() =>
      buildMarketingActionRequest({ ...VALID_INPUT, providerAccountBinding: null })
    ).toThrowError(/requires a providerAccountBinding/);
  });

  it("fails closed when the binding platform disagrees with the request platform", () => {
    expect(() =>
      buildMarketingActionRequest({
        ...VALID_INPUT,
        providerAccountBinding: { integrationId: 4, platform: "facebook", externalAccountRef: null },
      })
    ).toThrowError(/must match the request platform/);
  });

  it("fails closed on malformed actionRequestId", () => {
    expect(() => buildMarketingActionRequest({ ...VALID_INPUT, actionRequestId: "bad id!" })).toThrowError(
      /actionRequestId/
    );
    expect(() => buildMarketingActionRequest({ ...VALID_INPUT, actionRequestId: "" })).toThrowError(
      /actionRequestId/
    );
  });

  it("fails closed on malformed timestamps", () => {
    expect(() =>
      buildMarketingActionRequest({ ...VALID_INPUT, requestedAt: "tomorrow" })
    ).toThrowError(/requestedAt/);
  });

  it("fails closed on non-positive businessId", () => {
    expect(() => buildMarketingActionRequest({ ...VALID_INPUT, businessId: 0 })).toThrowError(
      /businessId/
    );
  });

  it.each([
    "riskClass",
    "riskLevel",
    "decision",
    "approvalRequired",
    "approvalStatus",
    "authorized",
    "policyVersion",
    "costEligible",
  ])("rejects client-supplied authority field %s (never silently ignores)", (field) => {
    expect(() =>
      buildMarketingActionRequest({ ...VALID_INPUT, [field]: "low" } as any)
    ).toThrowError(/must never be client-supplied/);
  });

  it("derives authoritative cost classes deterministically per action type", () => {
    expect(deriveCostClass("reply_publicly")).toBe("low");
    expect(deriveCostClass("nurture_candidate")).toBe("standard");
    expect(deriveCostClass("observe_only")).toBe("none");
    expect(ACTION_COST_CREDITS.suppress_action).toBe(0);
    expect(isBillableAction("reply_privately")).toBe(true);
    expect(isBillableAction("escalate_to_human")).toBe(false);
    expect(isBillableAction("suppress_action")).toBe(false);
  });

  it("produces a stable fingerprint for identical material input", () => {
    const a = buildMarketingActionRequest(VALID_INPUT);
    const b = buildMarketingActionRequest({
      ...VALID_INPUT,
      requestedAt: "2026-06-28T11:00:00.000Z",
    });
    expect(buildActionRequestFingerprint(a)).toBe(buildActionRequestFingerprint(b));
  });

  it("changes the fingerprint when material identity changes", () => {
    const a = buildMarketingActionRequest(VALID_INPUT);
    const b = buildMarketingActionRequest({ ...VALID_INPUT, contextVersion: "ctx:changed" });
    expect(buildActionRequestFingerprint(a)).not.toBe(buildActionRequestFingerprint(b));
  });

  it("detects actionRequestId reuse with conflicting material identity", () => {
    const a = buildMarketingActionRequest(VALID_INPUT);
    const tampered = buildMarketingActionRequest({ ...VALID_INPUT, campaignId: 56 });
    expect(isActionRequestIdentityConflict(a, tampered)).toBe(true);
    const replay = buildMarketingActionRequest(VALID_INPUT);
    expect(isActionRequestIdentityConflict(a, replay)).toBe(false);
  });
});
