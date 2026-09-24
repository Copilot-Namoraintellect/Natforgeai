import { describe, expect, it, vi, afterEach } from "vitest";

import {
  PUBLICATION_DEFAULT_MAX_RETRIES,
  PUBLICATION_RETRY_DELAYS_MS,
  buildPublicationRecoveryEvent,
  classifyPublicationRecoveryClass,
  decidePublicationRecovery,
  evaluateManualRecoveryEligibility,
  resolvePublicationRetryDelayMs,
  type PublicationFailureContext,
} from "./publication-recovery-policy";

const NOW = new Date("2026-06-01T12:00:00.000Z");

function baseContext(overrides: Partial<PublicationFailureContext> = {}): PublicationFailureContext {
  return {
    stage: "provider",
    now: NOW,
    retryCount: 0,
    ...overrides,
  };
}

describe("classifyPublicationRecoveryClass", () => {
  it("maps durable failure stages to recovery classes", () => {
    expect(
      classifyPublicationRecoveryClass({ stage: "precondition" })
    ).toBe("precondition");
    expect(classifyPublicationRecoveryClass({ stage: "integration" })).toBe("auth");
    expect(classifyPublicationRecoveryClass({ stage: "media" })).toBe("provider_rejection");
    expect(classifyPublicationRecoveryClass({ stage: "billing" })).toBe("billing");
  });

  it("maps normalized provider categories to recovery classes", () => {
    const provider = (category: string, retryable: boolean) => ({
      category: category as any,
      code: `provider_${category}`,
      retryable,
    });
    expect(
      classifyPublicationRecoveryClass({ stage: "provider", provider: provider("auth", false) })
    ).toBe("auth");
    expect(
      classifyPublicationRecoveryClass({ stage: "provider", provider: provider("rate_limited", true) })
    ).toBe("rate_limited");
    expect(
      classifyPublicationRecoveryClass({ stage: "provider", provider: provider("network", true) })
    ).toBe("network");
    expect(
      classifyPublicationRecoveryClass({ stage: "provider", provider: provider("validation", false) })
    ).toBe("provider_rejection");
    expect(
      classifyPublicationRecoveryClass({ stage: "provider", provider: provider("unsupported", false) })
    ).toBe("provider_rejection");
  });

  it("respects the provider retryable flag for generic provider failures", () => {
    const generic = (retryable: boolean) => ({
      category: "provider" as const,
      code: "provider_error",
      retryable,
    });
    expect(
      classifyPublicationRecoveryClass({ stage: "provider", provider: generic(true) })
    ).toBe("rate_limited");
    expect(
      classifyPublicationRecoveryClass({ stage: "provider", provider: generic(false) })
    ).toBe("provider_rejection");
  });

  it("classifies provider/runtime failures without provider evidence as unknown", () => {
    expect(classifyPublicationRecoveryClass({ stage: "provider" })).toBe("unknown");
    expect(classifyPublicationRecoveryClass({ stage: "runtime" })).toBe("unknown");
    expect(classifyPublicationRecoveryClass({ stage: "runtime", provider: null })).toBe("unknown");
  });

  it("rejects malformed stages", () => {
    expect(() =>
      classifyPublicationRecoveryClass({ stage: "bogus" as any })
    ).toThrow(TypeError);
  });
});

describe("resolvePublicationRetryDelayMs", () => {
  it("returns the fixed schedule per attempt ordinal", () => {
    expect(resolvePublicationRetryDelayMs(1)).toBe(60_000);
    expect(resolvePublicationRetryDelayMs(2)).toBe(300_000);
    expect(resolvePublicationRetryDelayMs(3)).toBe(900_000);
  });

  it("clamps at the final schedule slot — no endless growth", () => {
    expect(resolvePublicationRetryDelayMs(4)).toBe(900_000);
    expect(resolvePublicationRetryDelayMs(10)).toBe(900_000);
  });

  it("exposes the canonical schedule", () => {
    expect(PUBLICATION_RETRY_DELAYS_MS).toEqual([60_000, 300_000, 900_000]);
    expect(PUBLICATION_DEFAULT_MAX_RETRIES).toBe(3);
  });

  it("rejects malformed ordinals", () => {
    expect(() => resolvePublicationRetryDelayMs(0)).toThrow(TypeError);
    expect(() => resolvePublicationRetryDelayMs(-1)).toThrow(TypeError);
    expect(() => resolvePublicationRetryDelayMs(1.5)).toThrow(TypeError);
    expect(() => resolvePublicationRetryDelayMs(Number.NaN)).toThrow(TypeError);
  });
});

describe("decidePublicationRecovery — transient retryable failures", () => {
  it("rate-limited provider failure retries with deterministic backoff", () => {
    const decision = decidePublicationRecovery(
      baseContext({
        stage: "provider",
        retryCount: 0,
        provider: { category: "rate_limited", code: "provider_rate_limited", retryable: true },
      })
    );

    expect(decision.recoveryClass).toBe("rate_limited");
    expect(decision.action).toBe("retry");
    expect(decision.retryable).toBe(true);
    expect(decision.callProviderAgain).toBe(true);
    expect(decision.nextRetryCount).toBe(1);
    expect(decision.delayMs).toBe(60_000);
    expect(decision.nextRetryAt).toEqual(new Date(NOW.getTime() + 60_000));
    expect(decision.terminal).toBe(false);
    expect(decision.terminalStatus).toBeNull();
    expect(decision.escalationRequired).toBe(false);
    expect(decision.mutationAuthorized).toBe(false);
  });

  it("network/timeout failure retries within the bounded policy", () => {
    const decision = decidePublicationRecovery(
      baseContext({
        stage: "provider",
        retryCount: 1,
        provider: { category: "network", code: "provider_network", retryable: true },
      })
    );

    expect(decision.recoveryClass).toBe("network");
    expect(decision.action).toBe("retry");
    expect(decision.nextRetryCount).toBe(2);
    expect(decision.delayMs).toBe(300_000);
    expect(decision.nextRetryAt).toEqual(new Date(NOW.getTime() + 300_000));
  });

  it("runtime failures with unknown cause use the conservative bounded retry", () => {
    const decision = decidePublicationRecovery(baseContext({ stage: "runtime", retryCount: 1 }));

    expect(decision.recoveryClass).toBe("unknown");
    expect(decision.action).toBe("retry");
    expect(decision.nextRetryCount).toBe(2);
    expect(decision.delayMs).toBe(300_000);
    expect(decision.nextRetryAt).toEqual(new Date(NOW.getTime() + 300_000));

    const terminal = decidePublicationRecovery(baseContext({ stage: "runtime", retryCount: 2 }));
    expect(terminal.action).toBe("escalate");
    expect(terminal.terminal).toBe(true);
    expect(terminal.escalationRequired).toBe(true);
  });

  it("computes the next retry time deterministically from the explicit now", () => {
    const context = baseContext({
      stage: "provider",
      retryCount: 0,
      provider: { category: "rate_limited", code: "provider_rate_limited", retryable: true },
    });
    const first = decidePublicationRecovery(context);
    const second = decidePublicationRecovery(context);

    expect(first.nextRetryAt).toEqual(second.nextRetryAt);
    expect(first.nextRetryAt).toEqual(new Date(NOW.getTime() + 60_000));
    expect(first).toEqual(second);

    const later = decidePublicationRecovery({ ...context, now: new Date(NOW.getTime() + 5_000) });
    expect(later.nextRetryAt).toEqual(new Date(NOW.getTime() + 5_000 + 60_000));
    expect(later.delayMs).toBe(first.delayMs);
  });

  it("is deterministic for identical inputs across calls", () => {
    const context = baseContext({
      stage: "provider",
      retryCount: 1,
      provider: { category: "network", code: "provider_network", retryable: true },
    });
    expect(decidePublicationRecovery(context)).toEqual(decidePublicationRecovery(context));
  });

  it("honours an explicit maxRetries instead of the default", () => {
    const decision = decidePublicationRecovery(
      baseContext({
        stage: "provider",
        retryCount: 0,
        maxRetries: 5,
        provider: { category: "rate_limited", code: "provider_rate_limited", retryable: true },
      })
    );
    expect(decision.maxRetries).toBe(5);
    expect(decision.action).toBe("retry");
    expect(decision.nextRetryCount).toBe(1);
  });
});

describe("decidePublicationRecovery — retry budget boundary", () => {
  it("treats retryCount + 1 >= maxRetries as terminal escalation — exact boundary", () => {
    const rateLimited = (retryCount: number, maxRetries: number) =>
      baseContext({
        stage: "provider",
        retryCount,
        maxRetries,
        provider: { category: "rate_limited", code: "provider_rate_limited", retryable: true },
      });

    const atBoundary = decidePublicationRecovery(rateLimited(2, 3));
    expect(atBoundary.action).toBe("escalate");
    expect(atBoundary.terminal).toBe(true);
    expect(atBoundary.terminalStatus).toBe("failed");
    expect(atBoundary.retryable).toBe(false);
    expect(atBoundary.callProviderAgain).toBe(false);
    expect(atBoundary.escalationRequired).toBe(true);
    expect(atBoundary.nextRetryCount).toBe(3);
    expect(atBoundary.delayMs).toBeNull();
    expect(atBoundary.nextRetryAt).toBeNull();

    const belowBoundary = decidePublicationRecovery(rateLimited(1, 3));
    expect(belowBoundary.action).toBe("retry");
    expect(belowBoundary.nextRetryCount).toBe(2);

    const customBudget = decidePublicationRecovery(rateLimited(3, 5));
    expect(customBudget.action).toBe("retry");
    expect(customBudget.nextRetryCount).toBe(4);
    expect(customBudget.delayMs).toBe(900_000); // clamped at final slot

    const customBoundary = decidePublicationRecovery(rateLimited(4, 5));
    expect(customBoundary.action).toBe("escalate");
    expect(customBoundary.nextRetryCount).toBe(5);
  });

  it("never schedules a retry past the budget — no endless retry", () => {
    for (const retryCount of [2, 3, 10, 100]) {
      const decision = decidePublicationRecovery(
        baseContext({
          stage: "provider",
          retryCount,
          provider: { category: "rate_limited", code: "provider_rate_limited", retryable: true },
        })
      );
      expect(decision.action).toBe("escalate");
      expect(decision.terminal).toBe(true);
      expect(decision.nextRetryAt).toBeNull();
    }
  });
});

describe("decidePublicationRecovery — precondition / authority failures", () => {
  it.each(["readiness", "package_integrity", "package_freshness", "destination_mismatch"] as const)(
    "precondition %s fails terminal without consuming retry budget",
    (preconditionKind) => {
      const decision = decidePublicationRecovery(
        baseContext({ stage: "precondition", retryCount: 0, preconditionKind })
      );

      expect(decision.recoveryClass).toBe("precondition");
      expect(decision.action).toBe("fail_terminal");
      expect(decision.retryable).toBe(false);
      expect(decision.callProviderAgain).toBe(false);
      expect(decision.terminal).toBe(true);
      expect(decision.terminalStatus).toBe("failed");
      expect(decision.escalationRequired).toBe(false);
      // Fail-fast authority failures never consume meaningless retries.
      expect(decision.nextRetryCount).toBe(0);
      expect(decision.nextRetryAt).toBeNull();
      expect(decision.mutationAuthorized).toBe(false);
    }
  );

  it("precondition failure does not retry even with a full retry budget remaining", () => {
    const decision = decidePublicationRecovery(
      baseContext({ stage: "precondition", retryCount: 0, preconditionKind: "readiness" })
    );
    expect(decision.action).not.toBe("retry");
    expect(decision.retryable).toBe(false);
  });

  it("approval-authority precondition routes to require_approval, not a retry", () => {
    const decision = decidePublicationRecovery(
      baseContext({
        stage: "precondition",
        retryCount: 1,
        preconditionKind: "approval_authority",
      })
    );

    expect(decision.action).toBe("require_approval");
    expect(decision.retryable).toBe(false);
    expect(decision.callProviderAgain).toBe(false);
    expect(decision.terminal).toBe(true);
    expect(decision.terminalStatus).toBe("pending_approval");
    expect(decision.escalationRequired).toBe(false);
    expect(decision.nextRetryCount).toBe(1); // budget untouched
  });
});

describe("decidePublicationRecovery — auth / credential failures", () => {
  it("integration-stage failure (no connected account) requires reconnect", () => {
    const decision = decidePublicationRecovery(
      baseContext({ stage: "integration", retryCount: 0 })
    );

    expect(decision.recoveryClass).toBe("auth");
    expect(decision.action).toBe("reconnect");
    expect(decision.retryable).toBe(false);
    expect(decision.callProviderAgain).toBe(false);
    expect(decision.terminal).toBe(true);
    expect(decision.terminalStatus).toBe("failed");
    expect(decision.escalationRequired).toBe(false);
    expect(decision.nextRetryCount).toBe(0);
  });

  it("provider-classified auth failure (expired/revoked token) requires reconnect", () => {
    const decision = decidePublicationRecovery(
      baseContext({
        stage: "provider",
        retryCount: 2,
        provider: { category: "auth", code: "provider_auth", retryable: false },
      })
    );

    expect(decision.recoveryClass).toBe("auth");
    expect(decision.action).toBe("reconnect");
    expect(decision.retryable).toBe(false);
    expect(decision.terminal).toBe(true);
    // Reconnect, not blind retry, even with budget remaining.
    expect(decision.nextRetryCount).toBe(2);
  });
});

describe("decidePublicationRecovery — provider rejection / invalid payload", () => {
  it.each(["validation", "unsupported"] as const)(
    "provider rejection (%s) is terminal without consuming retries",
    (category) => {
      const decision = decidePublicationRecovery(
        baseContext({
          stage: "provider",
          retryCount: 0,
          provider: { category: category as any, code: `provider_${category}`, retryable: false },
        })
      );

      expect(decision.recoveryClass).toBe("provider_rejection");
      expect(decision.action).toBe("fail_terminal");
      expect(decision.retryable).toBe(false);
      expect(decision.callProviderAgain).toBe(false);
      expect(decision.terminal).toBe(true);
      expect(decision.terminalStatus).toBe("failed");
      expect(decision.nextRetryCount).toBe(0); // budget untouched
    }
  );

  it("local media-stage payload failure is terminal and not escalated (no provider call was made)", () => {
    const decision = decidePublicationRecovery(baseContext({ stage: "media", retryCount: 1 }));

    expect(decision.recoveryClass).toBe("provider_rejection");
    expect(decision.action).toBe("fail_terminal");
    expect(decision.escalationRequired).toBe(false);
    expect(decision.nextRetryCount).toBe(1);
  });

  it("provider-side rejection is escalated for an operator", () => {
    const decision = decidePublicationRecovery(
      baseContext({
        stage: "provider",
        retryCount: 0,
        provider: { category: "validation", code: "provider_validation", retryable: false },
      })
    );
    expect(decision.escalationRequired).toBe(true);
  });
});

describe("decidePublicationRecovery — billing failures", () => {
  it("billing failure retries within the bounded policy, then escalates", () => {
    const first = decidePublicationRecovery(baseContext({ stage: "billing", retryCount: 0 }));
    expect(first.recoveryClass).toBe("billing");
    expect(first.action).toBe("retry");
    expect(first.delayMs).toBe(60_000);

    const terminal = decidePublicationRecovery(baseContext({ stage: "billing", retryCount: 2 }));
    expect(terminal.action).toBe("escalate");
    expect(terminal.terminal).toBe(true);
    expect(terminal.escalationRequired).toBe(true);
  });
});

describe("decidePublicationRecovery — input validation", () => {
  it("rejects malformed counters, stages, dates and provider evidence", () => {
    expect(() => decidePublicationRecovery(baseContext({ retryCount: -1 }))).toThrow(TypeError);
    expect(() => decidePublicationRecovery(baseContext({ retryCount: 1.5 }))).toThrow(TypeError);
    expect(() =>
      decidePublicationRecovery(baseContext({ retryCount: Number.NaN }))
    ).toThrow(TypeError);
    expect(() => decidePublicationRecovery(baseContext({ stage: "bogus" as any }))).toThrow(
      TypeError
    );
    expect(() =>
      decidePublicationRecovery(baseContext({ now: new Date("not-a-date") }))
    ).toThrow(TypeError);
    expect(() => decidePublicationRecovery(baseContext({ maxRetries: 0 }))).toThrow(TypeError);
    expect(() =>
      decidePublicationRecovery(
        baseContext({
          stage: "precondition",
          preconditionKind: "bogus" as any,
        })
      )
    ).toThrow(TypeError);
    expect(() =>
      decidePublicationRecovery(
        baseContext({
          provider: { category: "bogus" as any, code: "x", retryable: true },
        })
      )
    ).toThrow(TypeError);
    expect(() =>
      decidePublicationRecovery(
        baseContext({ provider: { category: "auth", code: "", retryable: false } })
      )
    ).toThrow(TypeError);
  });

  it("safe reasons never echo raw provider error text", () => {
    const decision = decidePublicationRecovery(
      baseContext({
        stage: "provider",
        retryCount: 0,
        provider: {
          category: "rate_limited",
          code: "provider_rate_limited",
          retryable: true,
        },
      })
    );
    expect(decision.safeReason).not.toContain("provider_rate_limited");
    expect(decision.safeReason.length).toBeGreaterThan(0);
  });
});

describe("decidePublicationRecovery — purity (no provider/network/clock calls)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not call fetch, network, or the ambient clock", () => {
    const fetchSpy = vi.fn();
    const originalFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = fetchSpy;
    const nowSpy = vi.spyOn(Date, "now");

    try {
      const a = decidePublicationRecovery(
        baseContext({
          stage: "provider",
          retryCount: 0,
          provider: { category: "rate_limited", code: "provider_rate_limited", retryable: true },
        })
      );
      const b = evaluateManualRecoveryEligibility({
        status: "failed",
        recoveryClass: "rate_limited",
        hasTerminalFailureRecord: true,
      });
      const event = buildPublicationRecoveryEvent({ decision: a, queueItemId: 5, platform: "facebook" });

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(nowSpy).not.toHaveBeenCalled();
      expect(event.occurredAt).toBe(NOW.toISOString());
      expect(b.reason).toBeNull();
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });
});

describe("evaluateManualRecoveryEligibility", () => {
  const failedItem = (
    overrides: Partial<Parameters<typeof evaluateManualRecoveryEligibility>[0]> = {}
  ) => ({
    status: "failed" as const,
    recoveryClass: "rate_limited" as const,
    hasTerminalFailureRecord: true,
    ...overrides,
  });

  it("a terminal failed transient item with a terminal-failure record is eligible for terminal replay", () => {
    const result = evaluateManualRecoveryEligibility(failedItem());
    expect(result.eligible).toBe(true);
    expect(result.recoveryPath).toBe("terminal_replay");
    expect(result.requiredAuthority).toContain("operator replay request");
    expect(result.reason).toBeNull();
    expect(result.mutationAuthorized).toBe(false);
  });

  it("a successfully published item can never be requeued into duplicate publication", () => {
    for (const recoveryClass of [
      "rate_limited",
      "network",
      "unknown",
      "billing",
      "provider_rejection",
    ] as const) {
      const result = evaluateManualRecoveryEligibility(
        failedItem({ status: "published", recoveryClass })
      );
      expect(result.eligible).toBe(false);
      expect(result.recoveryPath).toBeNull();
      expect(result.reason).toContain("duplicate publication");
    }
  });

  it("auth-class failure requires a reconnected integration first", () => {
    const disconnected = evaluateManualRecoveryEligibility(
      failedItem({ recoveryClass: "auth", integrationConnected: false })
    );
    expect(disconnected.eligible).toBe(false);
    expect(disconnected.recoveryPath).toBe("reconnect_then_terminal_replay");
    expect(disconnected.reason).toContain("reconnect");

    const reconnected = evaluateManualRecoveryEligibility(
      failedItem({ recoveryClass: "auth", integrationConnected: true })
    );
    expect(reconnected.eligible).toBe(true);
    expect(reconnected.recoveryPath).toBe("reconnect_then_terminal_replay");
    expect(reconnected.requiredAuthority).toContain("reconnected platform integration");
  });

  it("precondition-class failure requires revalidated publication authority", () => {
    const stale = evaluateManualRecoveryEligibility(
      failedItem({ recoveryClass: "precondition", authorityRevalidated: false })
    );
    expect(stale.eligible).toBe(false);
    expect(stale.reason).toContain("revalidated");

    const revalidated = evaluateManualRecoveryEligibility(
      failedItem({ recoveryClass: "precondition", authorityRevalidated: true })
    );
    expect(revalidated.eligible).toBe(true);
    expect(revalidated.requiredAuthority).toContain("publish package integrity and freshness");
    expect(revalidated.requiredAuthority).toContain("destination binding");
  });

  it("billing-class failure requires exactly one prior publishing deduction", () => {
    const missing = evaluateManualRecoveryEligibility(
      failedItem({ recoveryClass: "billing", billingEvidence: "missing" })
    );
    expect(missing.eligible).toBe(false);
    expect(missing.reason).toContain("uncharged or double charge");

    const ambiguous = evaluateManualRecoveryEligibility(
      failedItem({ recoveryClass: "billing", billingEvidence: "ambiguous" })
    );
    expect(ambiguous.eligible).toBe(false);

    const exact = evaluateManualRecoveryEligibility(
      failedItem({ recoveryClass: "billing", billingEvidence: "exact_single_deduction" })
    );
    expect(exact.eligible).toBe(true);
    expect(exact.requiredAuthority).toContain("exactly one prior publishing deduction");
  });

  it("a failed item without a durable terminal-failure record is not replay-eligible", () => {
    const result = evaluateManualRecoveryEligibility(
      failedItem({ hasTerminalFailureRecord: false })
    );
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("terminal-failure record");
  });

  it.each(["pending_approval", "safety_blocked"] as const)(
    "approval-blocked item (%s) routes to the approval flow, not a requeue",
    (status) => {
      const result = evaluateManualRecoveryEligibility(failedItem({ status }));
      expect(result.eligible).toBe(false);
      expect(result.recoveryPath).toBe("resolve_approval_block");
    }
  );

  it.each(["draft", "approved"] as const)(
    "non-terminal status (%s) is not a requeue candidate",
    (status) => {
      const result = evaluateManualRecoveryEligibility(failedItem({ status }));
      expect(result.eligible).toBe(false);
      expect(result.reason).toContain("not a terminal failed state");
    }
  );

  it("a retrying item is only resumable by an in-flight replay, not a new recovery", () => {
    const result = evaluateManualRecoveryEligibility(failedItem({ status: "retrying" }));
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("already recovering");
  });

  it("rejects malformed status and recovery class", () => {
    expect(() =>
      evaluateManualRecoveryEligibility(failedItem({ status: "bogus" as any }))
    ).toThrow(TypeError);
    expect(() =>
      evaluateManualRecoveryEligibility(failedItem({ recoveryClass: "bogus" as any }))
    ).toThrow(TypeError);
  });
});

describe("buildPublicationRecoveryEvent", () => {
  it("emits normalized audit/escalation data for a retry decision", () => {
    const decision = decidePublicationRecovery(
      baseContext({
        stage: "provider",
        retryCount: 0,
        provider: { category: "rate_limited", code: "provider_rate_limited", retryable: true },
      })
    );
    const event = buildPublicationRecoveryEvent({
      decision,
      queueItemId: 42,
      platform: "facebook",
      providerErrorCode: "provider_rate_limited",
    });

    expect(event).toEqual({
      eventType: "publication_recovery_decision",
      occurredAt: NOW.toISOString(),
      queueItemId: 42,
      platform: "facebook",
      failureStage: "provider",
      recoveryClass: "rate_limited",
      action: "retry",
      retryable: true,
      callProviderAgain: true,
      retryCount: 0,
      nextRetryCount: 1,
      maxRetries: 3,
      delayMs: 60_000,
      nextRetryAt: new Date(NOW.getTime() + 60_000).toISOString(),
      terminal: false,
      terminalStatus: null,
      escalationRequired: false,
      escalationChannel: null,
      safeReason: decision.safeReason,
      providerErrorCode: "provider_rate_limited",
      mutationAuthorized: false,
    });
  });

  it("maps terminal escalations to the existing warning/publishing alert channel", () => {
    const decision = decidePublicationRecovery(
      baseContext({
        stage: "provider",
        retryCount: 2,
        provider: { category: "rate_limited", code: "provider_rate_limited", retryable: true },
      })
    );
    const event = buildPublicationRecoveryEvent({ decision });

    expect(event.action).toBe("escalate");
    expect(event.escalationRequired).toBe(true);
    expect(event.escalationChannel).toEqual({ severity: "warning", category: "publishing" });
    expect(event.nextRetryAt).toBeNull();
    expect(event.terminalStatus).toBe("failed");
  });

  it("non-escalated terminal decisions carry no escalation channel", () => {
    const decision = decidePublicationRecovery(
      baseContext({ stage: "precondition", preconditionKind: "readiness" })
    );
    const event = buildPublicationRecoveryEvent({ decision });

    expect(event.escalationRequired).toBe(false);
    expect(event.escalationChannel).toBeNull();
    expect(event.terminal).toBe(true);
    expect(event.terminalStatus).toBe("failed");
  });

  it("require_approval decisions park the item on pending_approval in the event", () => {
    const decision = decidePublicationRecovery(
      baseContext({ stage: "precondition", preconditionKind: "approval_authority" })
    );
    const event = buildPublicationRecoveryEvent({ decision, queueItemId: 7 });
    expect(event.action).toBe("require_approval");
    expect(event.terminalStatus).toBe("pending_approval");
    expect(event.queueItemId).toBe(7);
  });

  it("is deterministic for the same decision and ids", () => {
    const decision = decidePublicationRecovery(baseContext({ stage: "billing", retryCount: 1 }));
    const a = buildPublicationRecoveryEvent({ decision, queueItemId: 1, platform: "linkedin" });
    const b = buildPublicationRecoveryEvent({ decision, queueItemId: 1, platform: "linkedin" });
    expect(a).toEqual(b);
  });
});
