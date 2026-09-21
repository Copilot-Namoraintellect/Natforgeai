import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import {
  assertPositiveReservationAmount,
  buildCreditReservationAttribution,
  buildCreditReservationId,
  buildCreditReservationIdempotencyKey,
  buildCreditReservationIdentityPayload,
  CreditReservationError,
  InMemoryCreditReservationRegistry,
  TERMINAL_RESERVATION_STATES,
  transitionReservationState,
  type CreditReservationIdentityInput,
  type ReserveCreditsInput,
} from "./credit-reservation";

function baseIdentity(overrides: Partial<CreditReservationIdentityInput> = {}): CreditReservationIdentityInput {
  return {
    userId: 7,
    reservationReference: "creative-success:42:job:888",
    campaignId: 42,
    workflowOperationId: "op-sha-1",
    workflowAttemptId: "attempt-sha-1",
    stageId: "creative_generation",
    ...overrides,
  };
}

function baseReserve(overrides: Partial<ReserveCreditsInput> = {}): ReserveCreditsInput {
  return {
    ...baseIdentity(),
    amount: 150,
    reason: "hold for creative generation",
    agentType: "creative",
    model: "premium-v2-template",
    provider: "openai",
    artifactId: "artifact-1",
    packageId: "pack-9",
    asOf: "2026-05-29T10:00:00.000Z",
    ...overrides,
  };
}

function reserveAndSettle(
  registry: InMemoryCreditReservationRegistry,
  reserve: ReserveCreditsInput,
  settleKey = "settle-key-1"
) {
  const { reservation } = registry.reserveCredits(reserve);
  return {
    reservation,
    settled: registry.settleCreditReservation({
      reservationId: reservation.reservationId,
      settleKey,
      asOf: "2026-05-29T10:05:00.000Z",
    }),
  };
}

describe("deterministic reservation identity", () => {
  it("is stable for equal inputs constructed separately", () => {
    const first = buildCreditReservationId(baseIdentity());
    const second = buildCreditReservationId(baseIdentity());
    expect(first).toBe(second);
  });

  it("is insensitive to payload key order and whitespace", () => {
    const reordered: CreditReservationIdentityInput = {
      reservationReference: "  creative-success:42:job:888   ",
      stageId: "creative_generation",
      workflowAttemptId: "attempt-sha-1",
      workflowOperationId: "op-sha-1",
      campaignId: 42,
      userId: 7,
    };
    expect(buildCreditReservationId(reordered)).toBe(buildCreditReservationId(baseIdentity()));
  });

  it("matches an independently computed sha256 over the canonical payload", () => {
    const payload = buildCreditReservationIdentityPayload(baseIdentity());
    const canonical = JSON.stringify(payload, Object.keys(payload).sort());
    const expected = createHash("sha256").update(canonical, "utf8").digest("hex");
    expect(buildCreditReservationId(baseIdentity())).toBe(expected);
  });

  it("changes when any identity coordinate changes", () => {
    const baseline = buildCreditReservationId(baseIdentity());
    expect(buildCreditReservationId(baseIdentity({ userId: 8 }))).not.toBe(baseline);
    expect(buildCreditReservationId(baseIdentity({ campaignId: 43 }))).not.toBe(baseline);
    expect(buildCreditReservationId(baseIdentity({ workflowOperationId: "op-sha-2" }))).not.toBe(baseline);
    expect(buildCreditReservationId(baseIdentity({ workflowAttemptId: "attempt-sha-2" }))).not.toBe(baseline);
    expect(buildCreditReservationId(baseIdentity({ stageId: "render" }))).not.toBe(baseline);
    expect(buildCreditReservationId(baseIdentity({ reservationReference: "other-ref" }))).not.toBe(baseline);
  });

  it("does not depend on wall-clock time: two calls at different times agree", async () => {
    const first = buildCreditReservationId(baseIdentity());
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = buildCreditReservationId(baseIdentity());
    expect(first).toBe(second);
  });

  it("lets an external idempotency key win, and falls back to the reservation id", () => {
    const withExternal = buildCreditReservationIdempotencyKey(
      baseIdentity({ externalIdempotencyKey: "charge-key-123" })
    );
    expect(withExternal).toBe("charge-key-123");
    const withoutExternal = buildCreditReservationIdempotencyKey(baseIdentity());
    expect(withoutExternal).toBe(buildCreditReservationId(baseIdentity()));
  });
});

describe("reservation state machine", () => {
  it("marks settled and released as terminal", () => {
    expect(TERMINAL_RESERVATION_STATES.has("settled")).toBe(true);
    expect(TERMINAL_RESERVATION_STATES.has("released")).toBe(true);
    expect(TERMINAL_RESERVATION_STATES.has("reserved")).toBe(false);
  });

  it("permits reserved -> settled", () => {
    expect(transitionReservationState("reserved", "settled")).toBe("settled");
  });

  it("permits reserved -> released", () => {
    expect(transitionReservationState("reserved", "released")).toBe("released");
  });

  it("treats same-state replay as an idempotent no-op for every state", () => {
    expect(transitionReservationState("reserved", "reserved")).toBe("reserved");
    expect(transitionReservationState("settled", "settled")).toBe("settled");
    expect(transitionReservationState("released", "released")).toBe("released");
  });

  it("rejects settled -> released (settled cannot release)", () => {
    expect(() => transitionReservationState("settled", "released")).toThrow(
      expect.objectContaining({ code: "RESERVATION_TERMINAL_STATE" })
    );
  });

  it("rejects released -> settled (released cannot settle)", () => {
    expect(() => transitionReservationState("released", "settled")).toThrow(
      expect.objectContaining({ code: "RESERVATION_TERMINAL_STATE" })
    );
  });

  it("rejects every transition out of a terminal state, including back to reserved", () => {
    for (const terminal of ["settled", "released"] as const) {
      for (const next of ["reserved", "settled", "released"] as const) {
        if (terminal === next) continue;
        expect(() => transitionReservationState(terminal, next)).toThrow(CreditReservationError);
      }
    }
  });
});

describe("reservation registry — reserve", () => {
  it("reserves with state reserved, classification none, frozen record and attribution", () => {
    const registry = new InMemoryCreditReservationRegistry();
    const { reservation, duplicateClassification } = registry.reserveCredits(baseReserve());

    expect(duplicateClassification).toBe("none");
    expect(reservation.state).toBe("reserved");
    expect(reservation.amount).toBe(150);
    expect(reservation.settledAmount).toBeNull();
    expect(reservation.releasedAmount).toBeNull();
    expect(Object.isFrozen(reservation)).toBe(true);
    expect(Object.isFrozen(reservation.attribution)).toBe(true);
    expect(registry.snapshot()).toHaveLength(1);
  });

  it("replays an identical reserve as idempotent_replay without a second record", () => {
    const registry = new InMemoryCreditReservationRegistry();
    const first = registry.reserveCredits(baseReserve());
    const second = registry.reserveCredits(baseReserve());

    expect(first.duplicateClassification).toBe("none");
    expect(second.duplicateClassification).toBe("idempotent_replay");
    expect(second.reservation).toBe(first.reservation);
    expect(registry.snapshot()).toHaveLength(1);
  });

  it("fails closed when the same identity reserves a different amount", () => {
    const registry = new InMemoryCreditReservationRegistry();
    registry.reserveCredits(baseReserve());
    expect(() => registry.reserveCredits(baseReserve({ amount: 200 }))).toThrow(
      expect.objectContaining({ code: "RESERVATION_IDENTITY_CONFLICT" })
    );
    expect(registry.snapshot()).toHaveLength(1);
  });

  it("fails closed when the same identity reserves different attribution", () => {
    const registry = new InMemoryCreditReservationRegistry();
    registry.reserveCredits(baseReserve());
    expect(() => registry.reserveCredits(baseReserve({ agentType: "strategy" }))).toThrow(
      expect.objectContaining({ code: "RESERVATION_IDENTITY_CONFLICT" })
    );
  });

  it("fails closed when the same natural reference is reused with different coordinates", () => {
    const registry = new InMemoryCreditReservationRegistry();
    registry.reserveCredits(baseReserve());
    expect(() => registry.reserveCredits(baseReserve({ campaignId: 43 }))).toThrow(
      expect.objectContaining({ code: "RESERVATION_IDENTITY_CONFLICT" })
    );
    expect(registry.snapshot()).toHaveLength(1);
  });

  it("fails closed when an external idempotency key is bound to a different reservation", () => {
    const registry = new InMemoryCreditReservationRegistry();
    registry.reserveCredits(baseReserve({ externalIdempotencyKey: "charge-key-123" }));
    expect(() =>
      registry.reserveCredits(
        baseReserve({ reservationReference: "different-ref", externalIdempotencyKey: "charge-key-123" })
      )
    ).toThrow(expect.objectContaining({ code: "IDEMPOTENCY_KEY_CONFLICT" }));
  });

  it("enforces the positive amount requirement", () => {
    const registry = new InMemoryCreditReservationRegistry();
    for (const amount of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => registry.reserveCredits(baseReserve({ amount }))).toThrow(
        expect.objectContaining({ code: "INVALID_RESERVATION_AMOUNT" })
      );
    }
    expect(registry.snapshot()).toHaveLength(0);
  });

  it("rejects an empty reservation reference and a non-positive userId", () => {
    const registry = new InMemoryCreditReservationRegistry();
    expect(() => registry.reserveCredits(baseReserve({ reservationReference: "   " }))).toThrow(
      expect.objectContaining({ code: "INVALID_RESERVATION_IDENTITY" })
    );
    expect(() => registry.reserveCredits(baseReserve({ userId: 0 }))).toThrow(
      expect.objectContaining({ code: "INVALID_RESERVATION_IDENTITY" })
    );
  });

  it("requires a non-empty reason", () => {
    const registry = new InMemoryCreditReservationRegistry();
    expect(() => registry.reserveCredits(baseReserve({ reason: " " }))).toThrow(
      expect.objectContaining({ code: "INVALID_RESERVATION_REASON" })
    );
  });

  it("assertPositiveReservationAmount passes only positive finite numbers", () => {
    expect(() => assertPositiveReservationAmount(1)).not.toThrow();
    expect(() => assertPositiveReservationAmount(0.5)).not.toThrow();
    expect(() => assertPositiveReservationAmount(0)).toThrow(CreditReservationError);
    expect(() => assertPositiveReservationAmount(-1)).toThrow(CreditReservationError);
    expect(() => assertPositiveReservationAmount(Number.NaN)).toThrow(CreditReservationError);
  });
});

describe("reservation registry — settle / release exclusivity and replay", () => {
  it("settles at the full reserved amount by default", () => {
    const registry = new InMemoryCreditReservationRegistry();
    const { reservation, settled } = reserveAndSettle(registry, baseReserve());

    expect(settled.duplicateClassification).toBe("none");
    expect(settled.reservation.state).toBe("settled");
    expect(settled.reservation.settledAmount).toBe(150);
    expect(settled.reservation.releasedAmount).toBeNull();
    expect(settled.reservation.reservationId).toBe(reservation.reservationId);
    expect(registry.findReservation(reservation.reservationId)?.state).toBe("settled");
  });

  it("settles at a partial amount without exceeding the reservation", () => {
    const registry = new InMemoryCreditReservationRegistry();
    const { reservation } = registry.reserveCredits(baseReserve());
    const settled = registry.settleCreditReservation({
      reservationId: reservation.reservationId,
      settleKey: "settle-partial",
      settledAmount: 90,
    });

    expect(settled.reservation.settledAmount).toBe(90);
    expect(settled.reservation.amount).toBe(150);
  });

  it("rejects a settlement above the reserved amount", () => {
    const registry = new InMemoryCreditReservationRegistry();
    const { reservation } = registry.reserveCredits(baseReserve());

    expect(() =>
      registry.settleCreditReservation({
        reservationId: reservation.reservationId,
        settleKey: "settle-over",
        settledAmount: 151,
      })
    ).toThrow(expect.objectContaining({ code: "INVALID_SETTLEMENT_AMOUNT" }));
    expect(registry.findReservation(reservation.reservationId)?.state).toBe("reserved");
  });

  it("rejects a non-positive settlement amount", () => {
    const registry = new InMemoryCreditReservationRegistry();
    const { reservation } = registry.reserveCredits(baseReserve());

    expect(() =>
      registry.settleCreditReservation({
        reservationId: reservation.reservationId,
        settleKey: "settle-zero",
        settledAmount: 0,
      })
    ).toThrow(expect.objectContaining({ code: "INVALID_SETTLEMENT_AMOUNT" }));
  });

  it("replays the same settle key idempotently and keeps the settled amount", () => {
    const registry = new InMemoryCreditReservationRegistry();
    const { reservation } = registry.reserveCredits(baseReserve());

    const first = registry.settleCreditReservation({
      reservationId: reservation.reservationId,
      settleKey: "settle-key-1",
      settledAmount: 90,
    });
    const replay = registry.settleCreditReservation({
      reservationId: reservation.reservationId,
      settleKey: "settle-key-1",
      settledAmount: 90,
    });

    expect(first.duplicateClassification).toBe("none");
    expect(replay.duplicateClassification).toBe("idempotent_replay");
    expect(replay.reservation).toBe(first.reservation);
    expect(replay.reservation.settledAmount).toBe(90);
  });

  it("fails closed when a settle replay carries a different settled amount", () => {
    const registry = new InMemoryCreditReservationRegistry();
    const { reservation } = registry.reserveCredits(baseReserve());
    registry.settleCreditReservation({
      reservationId: reservation.reservationId,
      settleKey: "settle-key-1",
      settledAmount: 90,
    });

    expect(() =>
      registry.settleCreditReservation({
        reservationId: reservation.reservationId,
        settleKey: "settle-key-1",
        settledAmount: 100,
      })
    ).toThrow(expect.objectContaining({ code: "IDEMPOTENCY_KEY_CONFLICT" }));
  });

  it("fails closed when a different settle key targets an already-settled reservation", () => {
    const registry = new InMemoryCreditReservationRegistry();
    const { reservation } = reserveAndSettle(registry, baseReserve());

    expect(() =>
      registry.settleCreditReservation({
        reservationId: reservation.reservationId,
        settleKey: "settle-key-2",
      })
    ).toThrow(expect.objectContaining({ code: "RESERVATION_TERMINAL_STATE" }));
  });

  it("releases the full held amount and replays idempotently under the same key", () => {
    const registry = new InMemoryCreditReservationRegistry();
    const { reservation } = registry.reserveCredits(baseReserve());

    const first = registry.releaseCreditReservation({
      reservationId: reservation.reservationId,
      releaseKey: "release-key-1",
      reason: "workflow_failed",
    });
    const replay = registry.releaseCreditReservation({
      reservationId: reservation.reservationId,
      releaseKey: "release-key-1",
      reason: "workflow_failed",
    });

    expect(first.duplicateClassification).toBe("none");
    expect(first.reservation.state).toBe("released");
    expect(first.reservation.releasedAmount).toBe(150);
    expect(replay.duplicateClassification).toBe("idempotent_replay");
    expect(replay.reservation).toBe(first.reservation);
  });

  it("fails closed when releasing a settled reservation", () => {
    const registry = new InMemoryCreditReservationRegistry();
    const { reservation } = reserveAndSettle(registry, baseReserve());

    expect(() =>
      registry.releaseCreditReservation({
        reservationId: reservation.reservationId,
        releaseKey: "release-after-settle",
      })
    ).toThrow(expect.objectContaining({ code: "RESERVATION_TERMINAL_STATE" }));
  });

  it("fails closed when a different release key targets an already-released reservation", () => {
    const registry = new InMemoryCreditReservationRegistry();
    const { reservation } = registry.reserveCredits(baseReserve());
    registry.releaseCreditReservation({
      reservationId: reservation.reservationId,
      releaseKey: "release-key-1",
    });

    expect(() =>
      registry.releaseCreditReservation({
        reservationId: reservation.reservationId,
        releaseKey: "release-key-2",
      })
    ).toThrow(expect.objectContaining({ code: "RESERVATION_TERMINAL_STATE" }));
  });

  it("fails closed when settling a released reservation", () => {
    const registry = new InMemoryCreditReservationRegistry();
    const { reservation } = registry.reserveCredits(baseReserve());
    registry.releaseCreditReservation({
      reservationId: reservation.reservationId,
      releaseKey: "release-key-1",
    });

    expect(() =>
      registry.settleCreditReservation({
        reservationId: reservation.reservationId,
        settleKey: "settle-after-release",
      })
    ).toThrow(expect.objectContaining({ code: "RESERVATION_TERMINAL_STATE" }));
  });

  it("fails closed when a transition key is reused across reservations", () => {
    const registry = new InMemoryCreditReservationRegistry();
    const first = registry.reserveCredits(baseReserve());
    const second = registry.reserveCredits(baseReserve({ reservationReference: "ref-2", campaignId: 43 }));

    registry.settleCreditReservation({
      reservationId: first.reservation.reservationId,
      settleKey: "shared-key",
    });
    expect(() =>
      registry.settleCreditReservation({
        reservationId: second.reservation.reservationId,
        settleKey: "shared-key",
      })
    ).toThrow(expect.objectContaining({ code: "IDEMPOTENCY_KEY_CONFLICT" }));
  });

  it("rejects settle/release of an unknown reservation and blank transition keys", () => {
    const registry = new InMemoryCreditReservationRegistry();
    const { reservation } = registry.reserveCredits(baseReserve());

    expect(() =>
      registry.settleCreditReservation({ reservationId: "missing", settleKey: "k" })
    ).toThrow(expect.objectContaining({ code: "RESERVATION_NOT_FOUND" }));
    expect(() =>
      registry.releaseCreditReservation({ reservationId: "missing", releaseKey: "k" })
    ).toThrow(expect.objectContaining({ code: "RESERVATION_NOT_FOUND" }));
    expect(() =>
      registry.settleCreditReservation({ reservationId: reservation.reservationId, settleKey: " " })
    ).toThrow(expect.objectContaining({ code: "INVALID_RESERVATION_TRANSITION_KEY" }));
    expect(() =>
      registry.releaseCreditReservation({ reservationId: reservation.reservationId, releaseKey: "" })
    ).toThrow(expect.objectContaining({ code: "INVALID_RESERVATION_TRANSITION_KEY" }));
  });
});

describe("correlation attribution and identity immutability", () => {
  it("preserves full correlation attribution through settle", () => {
    const registry = new InMemoryCreditReservationRegistry();
    const reserve = baseReserve();
    const { reservation, settled } = reserveAndSettle(registry, reserve);

    expect(settled.reservation.attribution).toEqual({
      userId: 7,
      campaignId: 42,
      workflowOperationId: "op-sha-1",
      workflowAttemptId: "attempt-sha-1",
      stageId: "creative_generation",
      artifactId: "artifact-1",
      packageId: "pack-9",
      agentType: "creative",
      model: "premium-v2-template",
      provider: "openai",
    });
    expect(settled.reservation.attribution).toEqual(reservation.attribution);
  });

  it("preserves full correlation attribution through release", () => {
    const registry = new InMemoryCreditReservationRegistry();
    const { reservation } = registry.reserveCredits(baseReserve());
    const released = registry.releaseCreditReservation({
      reservationId: reservation.reservationId,
      releaseKey: "release-key-1",
    });

    expect(released.reservation.attribution).toEqual(reservation.attribution);
    expect(released.reservation.state).toBe("released");
  });

  it("normalises blank nullable attribution fields to null", () => {
    const registry = new InMemoryCreditReservationRegistry();
    const { reservation } = registry.reserveCredits(
      baseReserve({
        workflowAttemptId: "   ",
        artifactId: "",
        packageId: null,
        agentType: undefined,
      })
    );

    expect(reservation.attribution.workflowAttemptId).toBeNull();
    expect(reservation.attribution.artifactId).toBeNull();
    expect(reservation.attribution.packageId).toBeNull();
    expect(reservation.attribution.agentType).toBeNull();
  });

  it("keeps reservation identity fields immutable across the settle transition", () => {
    const registry = new InMemoryCreditReservationRegistry();
    const { reservation, settled } = reserveAndSettle(registry, baseReserve());

    expect(settled.reservation.reservationId).toBe(reservation.reservationId);
    expect(settled.reservation.idempotencyKey).toBe(reservation.idempotencyKey);
    expect(settled.reservation.amount).toBe(reservation.amount);
    expect(settled.reservation.attribution).toBe(reservation.attribution);
    expect(settled.reservation.createdAt).toBe(reservation.createdAt);
    expect(settled.reservation.reason).toBe(reservation.reason);
  });

  it("is immune to caller input mutation after reserve", () => {
    const registry = new InMemoryCreditReservationRegistry();
    const reserve = baseReserve();
    const { reservation } = registry.reserveCredits(reserve);

    reserve.amount = 999;
    reserve.campaignId = 999;
    reserve.agentType = "mutated";
    reserve.workflowOperationId = "mutated";

    const reread = registry.findReservation(reservation.reservationId);
    expect(reread?.amount).toBe(150);
    expect(reread?.attribution.campaignId).toBe(42);
    expect(reread?.attribution.agentType).toBe("creative");
    expect(reread?.attribution.workflowOperationId).toBe("op-sha-1");
  });

  it("does not allow attribution mutation through the frozen record", () => {
    const registry = new InMemoryCreditReservationRegistry();
    const { reservation } = registry.reserveCredits(baseReserve());

    expect(Object.isFrozen(reservation.attribution)).toBe(true);
    // Frozen records reject mutation attempts (TypeError in module strict mode);
    // the stored attribution must still be the original.
    expect(() => {
      (reservation.attribution as { campaignId: number }).campaignId = 999;
    }).toThrow(TypeError);
    expect(registry.findReservation(reservation.reservationId)?.attribution.campaignId).toBe(42);
  });

  it("buildCreditReservationAttribution defaults every nullable field to null", () => {
    expect(
      buildCreditReservationAttribution({
        userId: 3,
        reservationReference: "ref",
        amount: 10,
        reason: "r",
      })
    ).toEqual({
      userId: 3,
      campaignId: null,
      workflowOperationId: null,
      workflowAttemptId: null,
      stageId: null,
      artifactId: null,
      packageId: null,
      agentType: null,
      model: null,
      provider: null,
    });
  });
});
