import { describe, expect, it, vi } from "vitest";
import { getCreativePipelineV2Mode, runShadowMessageApproval } from "../shadow-runner";
import { campaign30BusinessDna, campaign30Policy, campaign30Strategy } from "../fixtures/campaign30";
import type { CampaignMessagePack } from "../../campaign-message-architect";

const legacyPack: CampaignMessagePack = {
  headline: "Reduce payout delays for operations managers",
  subheadline: "Automate supplier disbursements and manual reconciliation workflows.",
  benefitBullets: [
    "Payout automation cuts manual reconciliation by 2 hours per day.",
    "Supplier settlement tracking keeps audit records clear.",
    "Restaurant team payouts process faster with automated disbursements.",
  ],
  cta: "Learn More",
  footerContact: { email: "team@natforgeops.test" },
  proofPoints: [],
  platformCaptions: [],
  validation: { passed: true, score: 90, rejections: [], warnings: [] },
  messagePackSource: "ai_refined_pack",
  isGeneric: false,
};

describe("runShadowMessageApproval", () => {
  it("resolves unknown mode to off", () => {
    expect(getCreativePipelineV2Mode("unexpected_value")).toBe("off");
  });

  it("no-ops when mode is off, canary, or active", () => {
    const log = vi.fn();

    expect(
      runShadowMessageApproval({
        mode: "off",
        campaignId: 30,
        workflowRunId: null,
        candidateId: "cand-1",
        assessmentId: "assess-1",
        legacyPack,
        businessDna: campaign30BusinessDna,
        campaignStrategy: campaign30Strategy,
        policy: campaign30Policy,
        contextDiagnostics: {
          contextSource: "legacy_loaded_context",
          contextReadyForComparison: true,
          missingContextFields: [],
        },
        now: () => 0,
        nowIso: () => "2026-07-01T08:00:00.000Z",
        log,
      })
    ).toBeNull();

    expect(
      runShadowMessageApproval({
        mode: "canary",
        campaignId: 30,
        workflowRunId: null,
        candidateId: "cand-1",
        assessmentId: "assess-1",
        legacyPack,
        businessDna: campaign30BusinessDna,
        campaignStrategy: campaign30Strategy,
        policy: campaign30Policy,
        contextDiagnostics: {
          contextSource: "legacy_loaded_context",
          contextReadyForComparison: true,
          missingContextFields: [],
        },
        now: () => 0,
        nowIso: () => "2026-07-01T08:00:00.000Z",
        log,
      })
    ).toBeNull();

    expect(
      runShadowMessageApproval({
        mode: "active",
        campaignId: 30,
        workflowRunId: null,
        candidateId: "cand-1",
        assessmentId: "assess-1",
        legacyPack,
        businessDna: campaign30BusinessDna,
        campaignStrategy: campaign30Strategy,
        policy: campaign30Policy,
        contextDiagnostics: {
          contextSource: "legacy_loaded_context",
          contextReadyForComparison: true,
          missingContextFields: [],
        },
        now: () => 0,
        nowIso: () => "2026-07-01T08:00:00.000Z",
        log,
      })
    ).toBeNull();
  });

  it("runs only in shadow, emits structured fields, avoids raw copy text, preserves legacy result", () => {
    const log = vi.fn();
    const now = vi
      .fn()
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(118)
      .mockReturnValue(118);

    const result = runShadowMessageApproval({
      mode: "shadow",
      campaignId: 30,
      workflowRunId: "wr-1",
      candidateId: "cand-2",
      assessmentId: "assess-2",
      legacyPack,
      businessDna: campaign30BusinessDna,
      campaignStrategy: campaign30Strategy,
      policy: campaign30Policy,
      contextDiagnostics: {
        contextSource: "legacy_loaded_context",
        contextReadyForComparison: true,
        missingContextFields: [],
      },
      now,
      nowIso: () => "2026-07-01T08:00:00.000Z",
      log,
    });

    expect(result).not.toBeNull();
    expect(result?.mode).toBe("shadow");
    expect(result?.durationMs).toBeGreaterThanOrEqual(0);
    expect(result?.copyHashSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result?.candidateSource).toBe("ai_refined");
    expect(result?.legacyDecision).toBe("approved");
    expect(result?.v2Decision).toBeTypeOf("string");
    expect(result?.contextSource).toBe("legacy_loaded_context");
    expect(log).toHaveBeenCalledTimes(1);

    const payload = log.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.headline).toBeUndefined();
    expect(payload.subheadline).toBeUndefined();
    expect(payload.benefitBullets).toBeUndefined();
    expect(payload.cta).toBeUndefined();
    expect(payload.footer).toBeUndefined();
    expect(payload.email).toBeUndefined();
    expect(payload.phone).toBeUndefined();
  });

  it("swallows evaluator exceptions and still logs safe error fields", () => {
    const log = vi.fn();

    const result = runShadowMessageApproval({
      mode: "shadow",
      campaignId: 30,
      workflowRunId: null,
      candidateId: "cand-3",
      assessmentId: "assess-3",
      legacyPack,
      businessDna: campaign30BusinessDna,
      campaignStrategy: campaign30Strategy,
      policy: campaign30Policy,
      contextDiagnostics: {
        contextSource: "legacy_loaded_context",
        contextReadyForComparison: true,
        missingContextFields: [],
      },
      evaluate: () => {
        throw new Error("secret raw copy: Reduce payout delays");
      },
      now: () => 0,
      nowIso: () => "2026-07-01T08:00:00.000Z",
      log,
    });

    expect(result).not.toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    expect(result?.errorCode).toBe("SHADOW_EVALUATION_FAILED");

    const payload = log.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.errorCode).toBe("SHADOW_EVALUATION_FAILED");
    expect(String(JSON.stringify(payload))).not.toContain("secret raw copy");
  });

  it("does not call write functions and keeps legacy pack authoritative", () => {
    const log = vi.fn();
    const forbiddenWrite = vi.fn();
    const original = legacyPack;

    const result = runShadowMessageApproval({
      mode: "shadow",
      campaignId: 30,
      workflowRunId: null,
      candidateId: "cand-4",
      assessmentId: "assess-4",
      legacyPack: original,
      businessDna: campaign30BusinessDna,
      campaignStrategy: campaign30Strategy,
      policy: campaign30Policy,
      contextDiagnostics: {
        contextSource: "legacy_loaded_context",
        contextReadyForComparison: true,
        missingContextFields: [],
      },
      onWriteAttempt: forbiddenWrite,
      now: () => 0,
      nowIso: () => "2026-07-01T08:00:00.000Z",
      log,
    });

    expect(result).not.toBeNull();
    expect(forbiddenWrite).not.toHaveBeenCalled();
    expect(original).toBe(legacyPack);
  });
});
