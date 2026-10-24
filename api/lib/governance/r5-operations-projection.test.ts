import { describe, expect, it } from "vitest";
import {
  deriveR5Blockers,
  deriveR5OperationalState,
  R5_STALENESS_THRESHOLDS,
  type R5OperationsEvidence,
} from "./r5-operations-projection";
import type { R5ListeningBindingEvidence } from "./r5-stream-evidence";

const NOW = new Date("2026-10-24T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

function binding(
  overrides: Partial<R5ListeningBindingEvidence> = {}
): R5ListeningBindingEvidence {
  return {
    integrationId: 1,
    provider: "meta",
    platform: "instagram",
    providerAccountId: "acct-1",
    mechanism: "webhook",
    status: "active",
    cursorUpdatedAt: new Date(NOW.getTime() - HOUR_MS),
    lastSuccessAt: new Date(NOW.getTime() - HOUR_MS),
    lastFailureAt: null,
    lastFailureClass: null,
    lastFailureCode: null,
    lastFailureReason: null,
    acceptedCount: 120,
    duplicateCount: 3,
    rejectedCount: 0,
    signalsLast24h: 40,
    latestSignalObservedAt: new Date(NOW.getTime() - HOUR_MS),
    ...overrides,
  };
}

function evidence(
  overrides: Partial<R5OperationsEvidence> = {}
): R5OperationsEvidence {
  return {
    businessFound: true,
    business: { id: 10, userId: 7, name: "Acme" },
    areasUnavailable: [],
    listening: { available: true, bindings: [binding()] },
    interpretation: { supported: false },
    opportunity: { supported: false },
    policy: { pendingApprovals: [] },
    engagement: {
      campaignIds: [101],
      workflowStates: { campaign_live: 1 },
      costPausedCount: 0,
      queueCounts: { published: 5 },
      safetyBlockedCount: 0,
      retryingItems: [],
      failedItems: [],
      staleClaimCount: 0,
      runningClaimCount: 0,
    },
    queueRecovery: { openTerminalFailures: [], openReplayRequests: 0 },
    billingQuota: {
      walletRowExists: true,
      walletExhausted: false,
      openReservationCount: 0,
      usage: { campaignsCreated: 1, maxCampaigns: 10, successfulResults: 0, maxResults: 5 },
    },
    providers: {
      integrations: [{ id: 1, platform: "instagram", status: "connected" }],
      expiredCount: 0,
      disconnectedCount: 0,
    },
    activity: {
      lastSuccessAt: new Date(NOW.getTime() - HOUR_MS),
      lastFailureAt: null,
      lastFailureClass: null,
      lastFailureCode: null,
      lastFailureArea: null,
    },
    ...overrides,
  };
}

function classify(e: R5OperationsEvidence) {
  const blockers = deriveR5Blockers(e);
  return deriveR5OperationalState(e, blockers, NOW);
}

describe("R5 operations projection — health classification", () => {
  it("healthy listening projects HEALTHY with no blockers", () => {
    const result = classify(evidence());
    expect(result.health).toBe("HEALTHY");
    expect(result.blockers).toEqual([]);
    expect(result.safeNextAction).toBe("none");
    expect(result.isStale).toBe(false);
  });

  it("fresh signals arriving keep listening HEALTHY (F8.1)", () => {
    const e = evidence();
    e.listening = {
      available: true,
      bindings: [binding({ signalsLast24h: 15, latestSignalObservedAt: new Date(NOW.getTime() - 5 * 60_000) })],
    };
    const result = classify(e);
    expect(result.health).toBe("HEALTHY");
    expect(result.blockers).toEqual([]);
  });

  it("stale listening warns via staleness indicator (F8.2)", () => {
    const stale = new Date(NOW.getTime() - (R5_STALENESS_THRESHOLDS.businessActivityMs + HOUR_MS));
    const e = evidence({
      activity: {
        lastSuccessAt: stale,
        lastFailureAt: null,
        lastFailureClass: null,
        lastFailureCode: null,
        lastFailureArea: null,
      },
    });
    const result = classify(e);
    expect(result.isStale).toBe(true);
    expect(result.health).toBe("HEALTHY"); // stale is a warning, not a blocker
  });

  it("a recent recovered failure degrades without blocking (F8.8 adjacent)", () => {
    const e = evidence({
      activity: {
        lastSuccessAt: new Date(NOW.getTime() - 2 * HOUR_MS),
        lastFailureAt: new Date(NOW.getTime() - HOUR_MS),
        lastFailureClass: "AUTO_RECOVER",
        lastFailureCode: "provider_timeout",
        lastFailureArea: "listening",
      },
    });
    const result = classify(e);
    expect(result.health).toBe("DEGRADED");
    expect(result.notes.join(" ")).toContain("recent failure");
  });

  it("business with no R5 capability evidence is UNSUPPORTED, never guessed", () => {
    const e = evidence({
      listening: { available: false, reason: "stream_tables_absent", bindings: [] },
      policy: { pendingApprovals: [] },
      engagement: {
        campaignIds: [],
        workflowStates: {},
        costPausedCount: 0,
        queueCounts: {},
        safetyBlockedCount: 0,
        retryingItems: [],
        failedItems: [],
        staleClaimCount: 0,
        runningClaimCount: 0,
      },
      providers: { integrations: [], expiredCount: 0, disconnectedCount: 0 },
    });
    const result = classify(e);
    expect(result.health).toBe("UNSUPPORTED");
    expect(result.safeNextAction).toBe("await_capability_integration");
  });

  it("unavailable listening authority with other capabilities does not guess listening state", () => {
    const e = evidence({
      listening: { available: false, reason: "listening_authority_unavailable:x", bindings: [] },
    });
    const result = classify(e);
    expect(result.health).toBe("HEALTHY");
    const listeningBlockers = result.blockers.filter((b) => b.area === "listening");
    expect(listeningBlockers).toEqual([]);
  });
});

describe("R5 operations projection — blocker visibility", () => {
  it("ingestion blocker is visible with OPERATOR_ACTION recovery (F8.3)", () => {
    const e = evidence({
      listening: {
        available: true,
        bindings: [binding({ status: "blocked", lastFailureClass: "OPERATOR_ACTION", lastFailureCode: "webhook_disabled" })],
      },
    });
    const result = classify(e);
    const blocker = result.blockers.find((b) => b.area === "listening");
    expect(blocker).toBeDefined();
    expect(blocker!.recoveryClass).toBe("OPERATOR_ACTION");
    expect(result.health).toBe("BLOCKED_OPERATOR");
    expect(result.safeNextAction).toBe("requeue_stale_operation");
  });

  it("provider auth expiry maps to PROVIDER_AUTH_EXPIRED operator action (F8.9)", () => {
    const e = evidence({
      providers: {
        integrations: [{ id: 1, platform: "instagram", status: "expired" }],
        expiredCount: 1,
        disconnectedCount: 0,
      },
      listening: {
        available: true,
        bindings: [binding({ status: "blocked", lastFailureClass: "OPERATOR_ACTION", lastFailureCode: "provider_token_expired" })],
      },
    });
    const result = classify(e);
    const auth = result.blockers.find((b) => b.blockerClass === "PROVIDER_AUTH_EXPIRED");
    expect(auth).toBeDefined();
    expect(auth!.recoveryClass).toBe("OPERATOR_ACTION");
    expect(auth!.safeNextAction).toBe("reconnect_provider_integration");
    expect(result.health).toBe("BLOCKED_OPERATOR");
  });

  it("unsupported provider capability is visible as configuration blocker (F8.10)", () => {
    const e = evidence({
      listening: {
        available: true,
        bindings: [binding({ mechanism: "unsupported", status: "unsupported" })],
      },
    });
    const result = classify(e);
    const blocker = result.blockers.find((b) => b.blockerClass === "UNSUPPORTED_PROVIDER_CAPABILITY");
    expect(blocker).toBeDefined();
    expect(blocker!.recoveryClass).toBe("OPERATOR_ACTION");
    expect(result.health).toBe("BLOCKED_CONFIGURATION");
  });

  it("policy approval backlog is visible as governance approval (F8.5)", () => {
    const e = evidence({
      policy: {
        pendingApprovals: [
          { id: 55, approvalType: "sensitive_reply", riskLevel: "high", createdAt: new Date(NOW.getTime() - 3 * HOUR_MS) },
        ],
      },
    });
    const result = classify(e);
    const blocker = result.blockers.find((b) => b.blockerClass === "POLICY_REQUIRES_APPROVAL");
    expect(blocker).toBeDefined();
    expect(blocker!.recoveryClass).toBe("GOVERNANCE_APPROVAL");
    expect(blocker!.safeNextAction).toBe("inspect_pending_approval");
    expect(result.health).toBe("BLOCKED_OPERATOR");
  });

  it("budget exhaustion is visible (F8.6)", () => {
    const e = evidence({
      billingQuota: {
        walletRowExists: true,
        walletExhausted: true,
        openReservationCount: 2,
        usage: { campaignsCreated: 1, maxCampaigns: 10, successfulResults: 0, maxResults: 5 },
      },
    });
    const result = classify(e);
    const blocker = result.blockers.find((b) => b.blockerClass === "BUDGET_EXHAUSTED");
    expect(blocker).toBeDefined();
    expect(blocker!.recoveryClass).toBe("GOVERNANCE_APPROVAL");
    expect(blocker!.safeNextAction).toBe("resume_budget_continuation");
    expect(result.health).toBe("BLOCKED_CONFIGURATION");
  });

  it("quota exhaustion is visible (F8.7)", () => {
    const e = evidence({
      billingQuota: {
        walletRowExists: true,
        walletExhausted: false,
        openReservationCount: 0,
        usage: { campaignsCreated: 10, maxCampaigns: 10, successfulResults: 5, maxResults: 5 },
      },
    });
    const result = classify(e);
    const quotas = result.blockers.filter((b) => b.blockerClass === "QUOTA_EXHAUSTED");
    expect(quotas.length).toBe(2); // campaigns + results
    expect(result.health).toBe("BLOCKED_CONFIGURATION");
  });

  it("rate-limited retry in progress is AUTO_RECOVERING (F8.8)", () => {
    const e = evidence({
      listening: {
        available: true,
        bindings: [binding({ lastFailureClass: "AUTO_RECOVER", lastFailureCode: "http_429_rate_limited", lastFailureAt: new Date(NOW.getTime() - 10 * 60_000) })],
      },
      engagement: {
        campaignIds: [101],
        workflowStates: { campaign_live: 1 },
        costPausedCount: 0,
        queueCounts: { retrying: 1 },
        safetyBlockedCount: 0,
        retryingItems: [{ id: 9, nextRetryAt: new Date(NOW.getTime() + 5 * 60_000), retryCount: 1, maxRetries: 3, lastError: "http_429" }],
        failedItems: [],
        staleClaimCount: 0,
        runningClaimCount: 0,
      },
    });
    const result = classify(e);
    expect(result.health).toBe("AUTO_RECOVERING");
    const rate = result.blockers.find((b) => b.blockerClass === "RATE_LIMITED");
    expect(rate).toBeDefined();
    expect(rate!.recoveryClass).toBe("AUTO_RECOVER");
  });

  it("security rejection from a listening binding is FAIL_CLOSED", () => {
    const e = evidence({
      listening: {
        available: true,
        bindings: [binding({ status: "blocked", lastFailureClass: "FAIL_CLOSED", lastFailureCode: "policy_deny_safety" })],
      },
    });
    const result = classify(e);
    const blocker = result.blockers.find((b) => b.blockerClass === "SECURITY_REJECTION");
    expect(blocker).toBeDefined();
    expect(blocker!.recoveryClass).toBe("FAIL_CLOSED");
    expect(result.health).toBe("FAIL_CLOSED");
    expect(result.safeNextAction).toBe("review_fail_closed_evidence");
  });

  it("ownership mismatch evidence is FAIL_CLOSED and never system-retryable", () => {
    const e = evidence({
      listening: {
        available: true,
        bindings: [binding({ status: "blocked", lastFailureClass: "FAIL_CLOSED", lastFailureCode: "cross_business_ownership_mismatch" })],
      },
    });
    const result = classify(e);
    const blocker = result.blockers.find((b) => b.blockerClass === "OWNERSHIP_MISMATCH");
    expect(blocker).toBeDefined();
    expect(blocker!.recoveryClass).toBe("FAIL_CLOSED");
    expect(result.health).toBe("FAIL_CLOSED");
  });
});

describe("R5 operations projection — precedence and convergence", () => {
  it("fail_closed beats operator and configuration impacts", () => {
    const e = evidence({
      listening: {
        available: true,
        bindings: [
          binding({ integrationId: 1, status: "blocked", lastFailureClass: "FAIL_CLOSED", lastFailureCode: "policy_deny_safety" }),
          binding({ integrationId: 2, platform: "facebook", status: "blocked", lastFailureClass: "OPERATOR_ACTION", lastFailureCode: "webhook_disabled" }),
        ],
      },
      billingQuota: {
        walletRowExists: true,
        walletExhausted: true,
        openReservationCount: 0,
        usage: { campaignsCreated: 1, maxCampaigns: 10, successfulResults: 0, maxResults: 5 },
      },
    });
    const result = classify(e);
    expect(result.health).toBe("FAIL_CLOSED");
  });

  it("operator beats configuration impact", () => {
    const e = evidence({
      providers: {
        integrations: [{ id: 1, platform: "instagram", status: "expired" }],
        expiredCount: 1,
        disconnectedCount: 0,
      },
      listening: {
        available: true,
        bindings: [binding({ status: "blocked", lastFailureClass: "OPERATOR_ACTION", lastFailureCode: "provider_token_expired" })],
      },
      billingQuota: {
        walletRowExists: true,
        walletExhausted: true,
        openReservationCount: 0,
        usage: { campaignsCreated: 1, maxCampaigns: 10, successfulResults: 0, maxResults: 5 },
      },
    });
    const result = classify(e);
    expect(result.health).toBe("BLOCKED_OPERATOR");
  });

  it("safeNextAction prefers the highest-precedence actionable blocker", () => {
    const e = evidence({
      policy: {
        pendingApprovals: [
          { id: 55, approvalType: "campaign_launch", riskLevel: "medium", createdAt: new Date(NOW.getTime() - HOUR_MS) },
        ],
      },
      billingQuota: {
        walletRowExists: true,
        walletExhausted: true,
        openReservationCount: 0,
        usage: { campaignsCreated: 1, maxCampaigns: 10, successfulResults: 0, maxResults: 5 },
      },
    });
    const result = classify(e);
    expect(result.safeNextAction).toBe("inspect_pending_approval");
  });

  it("terminal failures surface a requeue action", () => {
    const e = evidence({
      queueRecovery: {
        openTerminalFailures: [
          { id: 500, queueName: "publishing", terminalReason: "retries_exhausted", errorCode: "provider_timeout", failedAt: new Date(NOW.getTime() - 2 * HOUR_MS) },
        ],
        openReplayRequests: 0,
      },
    });
    const result = classify(e);
    expect(result.safeNextAction).toBe("requeue_stale_operation");
    const blocker = result.blockers.find((b) => b.area === "queue_recovery");
    expect(blocker!.blockerClass).toBe("STALE_OPERATION");
  });
});
