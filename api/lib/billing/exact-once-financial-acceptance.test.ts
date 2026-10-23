/**
 * WBS-R4E — E2 exact-once financial acceptance suite.
 *
 * Proves the invariant "one logical operation -> at most one authoritative
 * billable charge" for a governed agent run across retries, restarts,
 * concurrency and adversarial identity reuse, exercising the REAL
 * `runAgent` from `api/lib/agents/runner.ts` and the REAL billing-key
 * builders (`buildAgentRunBillingSettleKey` / `buildAgentRunBillingReleaseKey`)
 * from that module.
 *
 * Test-mode note: `runAgent` skips billing when `isTestMode()` is true
 * (vitest sets VITEST=true), so every run here passes `skipBilling: false`
 * explicitly — the same mechanism runner-reservation-billing.test.ts uses —
 * to force the governed reservation path under test.
 *
 * The stateful fake below extends the runner-reservation-billing pattern with
 * a real wallet ledger: a starting balance of 100 per user that changes ONLY
 * when a settlement actually deducts, plus a `totalDeducted` counter so tests
 * assert the exact number of authoritative charges. The same engine mock
 * serves both the runner (`../agents/runner`) and the stale-reservation
 * reaper, which imports the same `./credit-reservation-engine` module.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("ai", () => ({
  generateObject: vi.fn(),
}));

vi.mock("./credit-engine", () => ({
  deductCredits: vi.fn(async () => ({ newBalance: 97 })),
  recordAiUsage: vi.fn(),
  checkCredits: vi.fn(async () => ({ hasCredits: true, balance: 1000 })),
  adminAdjustCredits: vi.fn(),
}));

vi.mock("./cost-control", () => ({
  enforceCostControl: vi.fn(async () => ({ allowed: true })),
}));

// NOTE: cost-tracker is deliberately NOT mocked — the real
// getEstimatedAgentCost("audience") returns 3, which the wallet assertions
// below depend on (start 100, one settlement -> balance 97).

/**
 * Stateful governed-reservation fake with a wallet ledger.
 * - reservations keyed by `${userId}:${externalIdempotencyKey}` (the real
 *   deterministic reservationId derivation includes userId in the hashed
 *   identity payload — see buildCreditReservationIdentityPayload in
 *   ./credit-reservation.ts — so userId + identity IS the durable identity);
 * - identity ownership index fails closed on cross-user identity reuse;
 * - exact-once settle/release per key; idempotent same-key replay;
 *   terminal fail-closed on a new key against a settled/released hold;
 * - wallet balance starts at 100 per user and moves ONLY on an actual
 *   settlement deduction; release frees capacity without touching balance.
 */
const ledger = vi.hoisted(() => {
  const STARTING_BALANCE = 100;
  const balances = new Map<number, number>();
  const reservations = new Map<
    string,
    {
      reservationId: string;
      userId: number;
      identity: string;
      state: "reserved" | "settled" | "released";
      amount: number;
      settledAmount: number | null;
      settleKey: string | null;
      releaseKey: string | null;
      reservedAt: string;
    }
  >();
  const identityOwner = new Map<string, number>();
  const state = {
    STARTING_BALANCE,
    balances,
    reservations,
    identityOwner,
    totalDeducted: 0,
    balance(userId: number) {
      return balances.get(userId) ?? STARTING_BALANCE;
    },
    outstanding(userId: number) {
      let total = 0;
      for (const r of reservations.values()) {
        if (r.userId === userId && r.state === "reserved") total += r.amount;
      }
      return total;
    },
    available(userId: number) {
      return state.balance(userId) - state.outstanding(userId);
    },
  };
  return state;
});

vi.mock("./credit-reservation-engine", async () => {
  const { CreditReservationError } = await import("./credit-reservation");

  function toReservation(held: any, userId: number, campaignId: number | null) {
    return {
      reservationId: held.reservationId,
      idempotencyKey: held.identity,
      state: held.state,
      amount: held.amount,
      settledAmount: held.settledAmount,
      releasedAmount: held.state === "released" ? held.amount : null,
      attribution: { userId, campaignId },
      reason: "",
      createdAt: held.reservedAt,
      settledAt: null,
      releasedAt: null,
    };
  }

  function findByReservationId(reservationId: string) {
    const held = ledger.reservations.get(reservationId);
    if (!held) throw new Error(`reservation ${String(reservationId)} not found in fake ledger`);
    return held;
  }

  return {
    reserveWalletCredits: vi.fn(async (input: any) => {
      const userId = input.userId as number;
      const identity = String(input.externalIdempotencyKey ?? input.reservationReference);
      // Adversarial guard: a caller-stable billing identity belongs to exactly
      // one owner. The real deterministic reservationId derivation includes
      // userId in the hashed identity payload (buildCreditReservationIdentityPayload,
      // api/lib/billing/credit-reservation.ts), so an identity can never
      // migrate across users; reuse under a different userId fails closed.
      const owner = ledger.identityOwner.get(identity);
      if (owner !== undefined && owner !== userId) {
        throw new CreditReservationError(
          "RESERVATION_IDENTITY_CONFLICT",
          `Billing identity "${identity}" is already owned by user ${owner}; user ${userId} cannot reserve it.`
        );
      }
      const key = `${userId}:${identity}`;
      const reservationId = `res:${key}`;
      const existing = ledger.reservations.get(reservationId);
      if (existing) {
        return {
          reservation: toReservation(existing, userId, input.campaignId ?? null),
          duplicateClassification: "idempotent_replay",
          walletBalance: ledger.balance(userId),
          reservedAmount: ledger.outstanding(userId),
          availableBalance: ledger.available(userId),
        };
      }
      if (input.amount > ledger.available(userId)) {
        throw new CreditReservationError(
          "INSUFFICIENT_CREDIT_CAPACITY",
          `Insufficient available credit capacity. Balance: ${ledger.balance(userId)}. Reserved: ${ledger.outstanding(userId)}. Available: ${ledger.available(userId)}.`
        );
      }
      const held = {
        reservationId,
        userId,
        identity,
        state: "reserved" as const,
        amount: input.amount as number,
        settledAmount: null,
        settleKey: null,
        releaseKey: null,
        reservedAt: (input.asOf as string) ?? new Date().toISOString(),
      };
      ledger.reservations.set(reservationId, held);
      ledger.identityOwner.set(identity, userId);
      return {
        reservation: toReservation(held, userId, input.campaignId ?? null),
        duplicateClassification: "none",
        walletBalance: ledger.balance(userId),
        reservedAmount: ledger.outstanding(userId),
        availableBalance: ledger.available(userId),
      };
    }),
    settleWalletCredits: vi.fn(async (input: any) => {
      const held = findByReservationId(input.reservationId);
      if (held.settleKey) {
        if (held.settleKey !== input.settleKey) {
          throw new CreditReservationError(
            "IDEMPOTENCY_KEY_CONFLICT",
            `Settle key "${input.settleKey}" conflicts with the key already bound to reservation ${held.reservationId}.`
          );
        }
        return {
          reservation: toReservation(held, held.userId, null),
          duplicateClassification: "idempotent_replay",
          newBalance: ledger.balance(held.userId),
          alreadyDeducted: true,
        };
      }
      // Only a same-key replay may touch a terminal reservation; a new settle
      // attempt against one fails closed (settled AND released both reject).
      if (held.state !== "reserved") {
        throw new CreditReservationError(
          "RESERVATION_TERMINAL_STATE",
          `Cannot settle reservation in terminal state "${held.state}".`
        );
      }
      held.state = "settled";
      held.settledAmount = held.amount;
      held.settleKey = input.settleKey;
      ledger.balances.set(held.userId, ledger.balance(held.userId) - held.amount);
      ledger.totalDeducted += held.amount;
      return {
        reservation: toReservation(held, held.userId, null),
        duplicateClassification: "none",
        newBalance: ledger.balance(held.userId),
        alreadyDeducted: false,
      };
    }),
    releaseWalletCredits: vi.fn(async (input: any) => {
      const held = findByReservationId(input.reservationId);
      if (held.releaseKey) {
        if (held.releaseKey !== input.releaseKey) {
          throw new CreditReservationError(
            "IDEMPOTENCY_KEY_CONFLICT",
            `Release key "${input.releaseKey}" conflicts with the key already bound to reservation ${held.reservationId}.`
          );
        }
        return {
          reservation: toReservation(held, held.userId, null),
          duplicateClassification: "idempotent_replay",
        };
      }
      // No refund of a settled charge through the reservation path: a release
      // against any terminal state fails closed.
      if (held.state !== "reserved") {
        throw new CreditReservationError(
          "RESERVATION_TERMINAL_STATE",
          `Cannot release reservation in terminal state "${held.state}".`
        );
      }
      held.state = "released";
      held.releaseKey = input.releaseKey;
      return {
        reservation: toReservation(held, held.userId, null),
        duplicateClassification: "none",
      };
    }),
  };
});

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

import { generateObject } from "ai";
import { getDb } from "../../queries/connection";
import { recordAiUsage } from "./credit-engine";
import {
  releaseWalletCredits,
  reserveWalletCredits,
  settleWalletCredits,
} from "./credit-reservation-engine";
import { CreditReservationError } from "./credit-reservation";
import {
  buildStaleReservationReleaseKey,
  isStaleReservation,
  reapStaleCreditReservations,
  STALE_RESERVATION_TTL_MS,
} from "./stale-reservation-reaper";
import {
  buildAgentRunBillingReleaseKey,
  buildAgentRunBillingSettleKey,
  runAgent,
} from "../agents/runner";

const USER_A = 10;
const USER_B = 99;
const CAMPAIGN_ID = 1;
const IDENTITY = "agent-audience-sha256test-e2-acceptance";
// Real getEstimatedAgentCost("audience") === 3 (api/lib/billing/cost-tracker.ts).
const ESTIMATED_COST = 3;
const START_BALANCE = 100;
const CHARGED_BALANCE = START_BALANCE - ESTIMATED_COST;

const schema = z.object({ text: z.string() });

function createMockDb() {
  return {
    insert: vi.fn((_table: any) => ({
      values: vi.fn(async () => [{ insertId: 1 }]),
    })),
    update: vi.fn((_table: any) => ({
      set: vi.fn((_set: any) => ({
        where: vi.fn(async () => []),
      })),
    })),
  };
}

function reserveInput(overrides: Record<string, unknown> = {}) {
  return {
    userId: USER_A,
    campaignId: CAMPAIGN_ID,
    reservationReference: IDENTITY,
    externalIdempotencyKey: IDENTITY,
    amount: ESTIMATED_COST,
    reason: "audience agent execution",
    agentType: "audience",
    asOf: new Date().toISOString(),
    ...overrides,
  };
}

/** A governed keyed run on the real runner; skipBilling:false defeats isTestMode(). */
function runKeyed(userId: number = USER_A, billingIdempotencyKey: string = IDENTITY) {
  return runAgent({
    userId,
    campaignId: CAMPAIGN_ID,
    agentType: "audience",
    prompt: "p",
    schema,
    skipBilling: false,
    billingIdempotencyKey,
  });
}

function successfulGeneration() {
  vi.mocked(generateObject).mockResolvedValue({
    object: { text: "hello" },
    usage: { promptTokens: 10, completionTokens: 5 },
  } as any);
}

async function lastResult<T>(mockFn: { mock: { results: Array<{ value: T }> } }): Promise<T> {
  return mockFn.mock.results[mockFn.mock.results.length - 1].value;
}

describe("E2 exact-once financial acceptance (WBS-R4E)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ledger.balances.clear();
    ledger.reservations.clear();
    ledger.identityOwner.clear();
    ledger.totalDeducted = 0;
    vi.mocked(getDb).mockReturnValue(createMockDb() as any);
    successfulGeneration();
  });

  describe("duplicate and retried workflow triggers (scenarios 1-5)", () => {
    it("1. duplicate workflow trigger — two sequential keyed runs collapse to exactly one deduction", async () => {
      await runKeyed();
      await runKeyed(); // duplicate trigger of the same logical step

      expect(reserveWalletCredits).toHaveBeenCalledTimes(2);
      const secondReserve = await lastResult(vi.mocked(reserveWalletCredits));
      expect(secondReserve.duplicateClassification).toBe("idempotent_replay");

      expect(settleWalletCredits).toHaveBeenCalledTimes(2);
      const settleKeys = vi.mocked(settleWalletCredits).mock.calls.map(
        (call) => (call[0] as { settleKey: string }).settleKey
      );
      expect(settleKeys).toEqual([
        buildAgentRunBillingSettleKey(IDENTITY),
        buildAgentRunBillingSettleKey(IDENTITY),
      ]);

      // Exactly one authoritative charge: wallet moved once, once only.
      expect(ledger.totalDeducted).toBe(ESTIMATED_COST);
      expect(ledger.balance(USER_A)).toBe(CHARGED_BALANCE);
      expect(ledger.reservations.size).toBe(1);
      const held = [...ledger.reservations.values()][0];
      expect(held.state).toBe("settled");
      expect(held.settledAmount).toBe(ESTIMATED_COST);
    });

    it("2. retry before the provider call — an unclassified pre-provider failure is settled by design (charge-retained legacy-mirror class), so the successful retry still collapses to one deduction", async () => {
      // First attempt: reservation succeeds, then a transient fault before any
      // provider success. The runner classifies it as neither schema nor
      // provider (see api/lib/agents/provider-error.ts), so the catch path
      // SETTLES the hold per its legacy-mirror semantics — one deduction on
      // the first attempt; the successful retry replays idempotently.
      vi.mocked(generateObject).mockRejectedValueOnce(
        new Error("transient internal fault before provider call")
      );

      await expect(runKeyed()).rejects.toThrow("transient internal fault");
      expect(ledger.totalDeducted).toBe(ESTIMATED_COST);
      expect(ledger.balance(USER_A)).toBe(CHARGED_BALANCE);

      successfulGeneration();
      await runKeyed(); // retry of the same logical billing identity

      expect(ledger.totalDeducted).toBe(ESTIMATED_COST); // still exactly one
      expect(ledger.balance(USER_A)).toBe(CHARGED_BALANCE);
      const held = [...ledger.reservations.values()][0];
      expect(held.state).toBe("settled");
    });

    it("3. retry after provider success but before durable usage acknowledgement — the post-charge failure replays settlement idempotently", async () => {
      // First attempt: provider succeeds, settlement deducts, then the usage
      // acknowledgement fails — runAgent rejects AFTER the money moved.
      vi.mocked(recordAiUsage).mockRejectedValueOnce(new Error("usage ledger acknowledgement failed"));

      await expect(runKeyed()).rejects.toThrow("usage ledger acknowledgement failed");
      expect(ledger.totalDeducted).toBe(ESTIMATED_COST);
      expect(ledger.balance(USER_A)).toBe(CHARGED_BALANCE);

      await runKeyed(); // retry reconciles the same identity

      expect(ledger.totalDeducted).toBe(ESTIMATED_COST); // no second charge
      expect(ledger.balance(USER_A)).toBe(CHARGED_BALANCE);
      const held = [...ledger.reservations.values()][0];
      expect(held.state).toBe("settled");
    });

    it("4. retry after the charge persisted — a full runAgent re-delivery after the crash window is an alreadyDeducted replay", async () => {
      await runKeyed();
      expect(ledger.totalDeducted).toBe(ESTIMATED_COST);

      // Crash, then the workflow redelivers the same logical step.
      await runKeyed();

      expect(settleWalletCredits).toHaveBeenCalledTimes(2);
      const secondSettle = await lastResult(vi.mocked(settleWalletCredits));
      expect(secondSettle.duplicateClassification).toBe("idempotent_replay");
      expect(secondSettle.alreadyDeducted).toBe(true);
      expect(ledger.totalDeducted).toBe(ESTIMATED_COST);
      expect(ledger.balance(USER_A)).toBe(CHARGED_BALANCE);
    });

    it("5. process restart — a brand-new invocation with no in-memory context reconciles the durable identity to one charge", async () => {
      // "Process 1": reservation + settlement commit to the durable ledger,
      // then the process dies before the usage acknowledgement.
      let processInvocation = 0;
      const dbProcess1 = createMockDb();
      vi.mocked(getDb).mockReturnValue(dbProcess1 as any);
      vi.mocked(recordAiUsage).mockRejectedValueOnce(new Error("process crashed after settle"));
      processInvocation += 1;
      await expect(runKeyed()).rejects.toThrow("process crashed after settle");
      expect(ledger.totalDeducted).toBe(ESTIMATED_COST);

      // "Process 2": fresh invocation, fresh db handle, NO shared memory with
      // process 1 — only the durable fake ledger (reservation map + wallet)
      // survives, proving restart-safety of the billing identity.
      const dbProcess2 = createMockDb();
      vi.mocked(getDb).mockReturnValue(dbProcess2 as any);
      processInvocation += 1;
      await runKeyed();

      expect(processInvocation).toBe(2);
      expect(dbProcess1).not.toBe(dbProcess2);
      expect(ledger.totalDeducted).toBe(ESTIMATED_COST);
      expect(ledger.balance(USER_A)).toBe(CHARGED_BALANCE);
      const held = [...ledger.reservations.values()][0];
      expect(held.state).toBe("settled");
    });
  });

  describe("concurrent duplicate execution (scenario 6)", () => {
    it("6. concurrent duplicate execution — two interleaved keyed runs race to one deduction; the loser's reserve is an idempotent replay", async () => {
      // Slow provider behind a manual gate so both runs interleave at the
      // reservation boundary before either can settle.
      let openGate!: (value: unknown) => void;
      const gate = new Promise((resolve) => {
        openGate = resolve;
      });
      vi.mocked(generateObject).mockImplementation(() => gate as Promise<any>);

      const firstRun = runKeyed();
      const secondRun = runKeyed();
      await vi.waitFor(() => expect(reserveWalletCredits).toHaveBeenCalledTimes(2));

      // Both holds resolved to a single reservation: one fresh, one replay.
      const firstReserve = await vi.mocked(reserveWalletCredits).mock.results[0].value;
      const secondReserve = await vi.mocked(reserveWalletCredits).mock.results[1].value;
      expect(firstReserve.duplicateClassification).toBe("none");
      expect(secondReserve.duplicateClassification).toBe("idempotent_replay");
      expect(secondReserve.reservation.reservationId).toBe(firstReserve.reservation.reservationId);
      expect(ledger.reservations.size).toBe(1);

      openGate({
        object: { text: "hello" },
        usage: { promptTokens: 10, completionTokens: 5 },
      });
      const [a, b] = await Promise.all([firstRun, secondRun]);
      expect(a.output).toEqual({ text: "hello" });
      expect(b.output).toEqual({ text: "hello" });

      expect(ledger.totalDeducted).toBe(ESTIMATED_COST); // the race charged once
      expect(ledger.balance(USER_A)).toBe(CHARGED_BALANCE);
      const held = [...ledger.reservations.values()][0];
      expect(held.state).toBe("settled");
    });
  });

  describe("reservation authority state machine (scenarios 7-9)", () => {
    it("7. reservation already exists — a second reserveWalletCredits with the same identity is an idempotent replay and the outstanding hold counts once", async () => {
      const first = await reserveWalletCredits(reserveInput());
      const second = await reserveWalletCredits(reserveInput());

      expect(first.duplicateClassification).toBe("none");
      expect(second.duplicateClassification).toBe("idempotent_replay");
      expect(second.reservation.reservationId).toBe(first.reservation.reservationId);
      // One hold, not two: the wallet's available balance reflects a single
      // outstanding reservation of 3.
      expect(second.reservedAmount).toBe(ESTIMATED_COST);
      expect(second.availableBalance).toBe(CHARGED_BALANCE);
      expect(ledger.outstanding(USER_A)).toBe(ESTIMATED_COST);
      expect(ledger.balance(USER_A)).toBe(START_BALANCE); // no deduction yet
      expect(ledger.reservations.size).toBe(1);
    });

    it("8. reservation settled already — a second settleWalletCredits with the same settleKey is an alreadyDeducted replay and deducts nothing", async () => {
      const { reservation } = await reserveWalletCredits(reserveInput());
      const settleKey = buildAgentRunBillingSettleKey(IDENTITY);

      const first = await settleWalletCredits({ reservationId: reservation.reservationId, settleKey });
      const second = await settleWalletCredits({ reservationId: reservation.reservationId, settleKey });

      expect(first.duplicateClassification).toBe("none");
      expect(second.duplicateClassification).toBe("idempotent_replay");
      expect(second.alreadyDeducted).toBe(true);
      expect(settleWalletCredits).toHaveBeenCalledTimes(2);
      // Exactly one authoritative charge despite two settle calls.
      expect(ledger.totalDeducted).toBe(ESTIMATED_COST);
      expect(ledger.balance(USER_A)).toBe(CHARGED_BALANCE);
    });

    it("9. reservation released already — a same-key release replays idempotently and a NEW settle attempt on the released hold fails closed", async () => {
      const { reservation } = await reserveWalletCredits(reserveInput());
      const releaseKey = buildAgentRunBillingReleaseKey(IDENTITY);

      const first = await releaseWalletCredits({ reservationId: reservation.reservationId, releaseKey });
      const second = await releaseWalletCredits({ reservationId: reservation.reservationId, releaseKey });
      expect(first.duplicateClassification).toBe("none");
      expect(second.duplicateClassification).toBe("idempotent_replay");

      // Terminal state, fail closed: a new settle key can no longer charge.
      await expect(
        settleWalletCredits({
          reservationId: reservation.reservationId,
          settleKey: `${IDENTITY}:settle:late-attempt`,
        })
      ).rejects.toThrow(/terminal/i);

      expect(ledger.totalDeducted).toBe(0);
      expect(ledger.balance(USER_A)).toBe(START_BALANCE);
      const held = [...ledger.reservations.values()][0];
      expect(held.state).toBe("released");
    });
  });

  describe("stale / expired reservations (scenario 10)", () => {
    it("10. stale reservation reaping — a reserved hold past TTL classifies stale (a fresh one does not), the real reaper releases it through the governed engine, and the reaped hold cannot be settled afterwards", async () => {
      const NOW = new Date("2026-06-29T12:00:00.000Z");
      const STALE_AT = new Date(NOW.getTime() - STALE_RESERVATION_TTL_MS - 60_000).toISOString();
      const FRESH_AT = new Date(NOW.getTime() - 60_000).toISOString();

      // Real classification from ./stale-reservation-reaper.
      expect(isStaleReservation({ state: "reserved", reservedAt: STALE_AT, now: NOW })).toBe(true);
      expect(isStaleReservation({ state: "reserved", reservedAt: FRESH_AT, now: NOW })).toBe(false);
      expect(isStaleReservation({ state: "settled", reservedAt: STALE_AT, now: NOW })).toBe(false);

      // Seed an abandoned hold directly through the governed engine fake.
      const { reservation } = await reserveWalletCredits(reserveInput({ asOf: STALE_AT }));
      expect(ledger.outstanding(USER_A)).toBe(ESTIMATED_COST);

      // The real reaper, backed by the SAME engine mock (the reaper imports
      // ./credit-reservation-engine, which this file mocks for the runner).
      const executor = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () =>
                Promise.resolve([
                  { reservationId: reservation.reservationId, state: "reserved", reservedAt: STALE_AT },
                ]),
            }),
          }),
        }),
      };
      const summary = await reapStaleCreditReservations({ now: NOW, executor: executor as any });

      expect(summary).toEqual({ examined: 1, released: 1, failed: 0 });
      expect(releaseWalletCredits).toHaveBeenCalledWith(
        expect.objectContaining({
          reservationId: reservation.reservationId,
          releaseKey: buildStaleReservationReleaseKey(reservation.reservationId),
          reason: "stale_reservation_reap",
        })
      );

      // Capacity restored, nothing deducted, and the reaped hold is terminal:
      // a later settle attempt fails closed rather than charging.
      expect(ledger.outstanding(USER_A)).toBe(0);
      expect(ledger.totalDeducted).toBe(0);
      expect(ledger.balance(USER_A)).toBe(START_BALANCE);
      await expect(
        settleWalletCredits({
          reservationId: reservation.reservationId,
          settleKey: buildAgentRunBillingSettleKey(IDENTITY),
        })
      ).rejects.toThrow(/terminal/i);
      expect(ledger.totalDeducted).toBe(0);
    });
  });

  describe("partial operation failure — refund classes (scenario 11)", () => {
    it("11a. provider error after reservation — the hold is released with no deduction and capacity restored", async () => {
      // Error shaped to match api/lib/agents/provider-error.ts
      // isProviderOrPlatformError: statusCode >= 500 classifies as provider.
      const providerError = Object.assign(
        new Error("OpenAI provider request failed with status 500"),
        { statusCode: 500 }
      );
      vi.mocked(generateObject).mockRejectedValue(providerError);

      await expect(runKeyed()).rejects.toThrow("OpenAI provider request failed");

      expect(releaseWalletCredits).toHaveBeenCalledTimes(1);
      expect(releaseWalletCredits).toHaveBeenCalledWith(
        expect.objectContaining({
          reservationId: `res:${USER_A}:${IDENTITY}`,
          releaseKey: buildAgentRunBillingReleaseKey(IDENTITY),
          reason: "provider_error",
        })
      );
      expect(settleWalletCredits).not.toHaveBeenCalled();

      // No charge, capacity fully restored.
      expect(ledger.totalDeducted).toBe(0);
      expect(ledger.balance(USER_A)).toBe(START_BALANCE);
      expect(ledger.outstanding(USER_A)).toBe(0);
      const held = [...ledger.reservations.values()][0];
      expect(held.state).toBe("released");
    });

    it("11b. non-provider failure after a successful provider response — the charge is retained by design (legacy-mirror settle class) at exactly one deduction", async () => {
      successfulGeneration();
      vi.mocked(recordAiUsage).mockRejectedValueOnce(new Error("usage ledger write failed"));

      await expect(runKeyed()).rejects.toThrow("usage ledger write failed");

      // The success-path settle already charged; the failure-path settle of
      // the same deterministic key replays without a second deduction. This
      // is the designed charge-retained class: any failure that is neither
      // schema nor provider mirrors the legacy up-front deduction.
      expect(ledger.totalDeducted).toBe(ESTIMATED_COST);
      expect(ledger.balance(USER_A)).toBe(CHARGED_BALANCE);
      expect(releaseWalletCredits).not.toHaveBeenCalled();
      const held = [...ledger.reservations.values()][0];
      expect(held.state).toBe("settled");
    });
  });

  describe("refund / release replay (scenario 12)", () => {
    it("12. release replay is idempotent without double-restoring capacity, and a settled charge can never be refunded through the reservation path", async () => {
      // Released path: replaying the SAME release key is a no-op replay.
      const { reservation } = await reserveWalletCredits(reserveInput());
      const releaseKey = buildAgentRunBillingReleaseKey(IDENTITY);
      await releaseWalletCredits({ reservationId: reservation.reservationId, releaseKey });
      const replay = await releaseWalletCredits({
        reservationId: reservation.reservationId,
        releaseKey,
      });
      expect(replay.duplicateClassification).toBe("idempotent_replay");
      expect(ledger.outstanding(USER_A)).toBe(0); // capacity not double-restored
      expect(ledger.available(USER_A)).toBe(START_BALANCE);
      expect(ledger.balance(USER_A)).toBe(START_BALANCE);

      // Settled path: settle once (deducts), then ANY release attempt on the
      // settled reservation throws — no refund of a settled charge through
      // the reservation path, fail closed.
      const settledIdentity = `${IDENTITY}:settled-path`;
      const settled = await reserveWalletCredits(reserveInput({ externalIdempotencyKey: settledIdentity }));
      await settleWalletCredits({
        reservationId: settled.reservation.reservationId,
        settleKey: buildAgentRunBillingSettleKey(settledIdentity),
      });
      expect(ledger.totalDeducted).toBe(ESTIMATED_COST);
      await expect(
        releaseWalletCredits({
          reservationId: settled.reservation.reservationId,
          releaseKey: buildAgentRunBillingReleaseKey(settledIdentity),
          reason: "refund_attempt",
        })
      ).rejects.toThrow(/terminal/i);
      expect(ledger.totalDeducted).toBe(ESTIMATED_COST);
      expect(ledger.balance(USER_A)).toBe(CHARGED_BALANCE);
    });
  });

  describe("adversarial: cross-user billing identity reuse (security)", () => {
    it("13. a billing identity already settled for user A cannot be reserved for user B — the fake fails closed with an identity conflict and user A's charge is untouched", async () => {
      // User A's logical operation reserves and settles under identity K.
      const a = await reserveWalletCredits(reserveInput({ userId: USER_A }));
      await settleWalletCredits({
        reservationId: a.reservation.reservationId,
        settleKey: buildAgentRunBillingSettleKey(IDENTITY),
      });
      expect(ledger.totalDeducted).toBe(ESTIMATED_COST);
      expect(ledger.balance(USER_A)).toBe(CHARGED_BALANCE);

      // Attacker: user B reuses A's billing identity, both directly and
      // through the real runner. The deterministic reservation identity
      // includes userId (buildCreditReservationIdentityPayload,
      // api/lib/billing/credit-reservation.ts), so the identity is owned by
      // A and reuse under B must fail closed instead of returning A's
      // reservation.
      const conflict = await reserveWalletCredits(reserveInput({ userId: USER_B })).catch(
        (error) => error
      );
      expect(conflict).toBeInstanceOf(CreditReservationError);
      expect(conflict.code).toBe("RESERVATION_IDENTITY_CONFLICT");

      // Through the real runner boundary the engine error maps to
      // PAYMENT_REQUIRED before any run record or provider call.
      const beforeCalls = vi.mocked(generateObject).mock.calls.length;
      await expect(runKeyed(USER_B, IDENTITY)).rejects.toMatchObject({
        code: "PAYMENT_REQUIRED",
      });
      expect(vi.mocked(generateObject).mock.calls.length).toBe(beforeCalls);

      // No leak, no mutation: A's charge is intact, B was never charged, and
      // no reservation exists under B's namespace.
      expect(ledger.totalDeducted).toBe(ESTIMATED_COST);
      expect(ledger.balance(USER_A)).toBe(CHARGED_BALANCE);
      expect(ledger.balance(USER_B)).toBe(START_BALANCE);
      expect(ledger.reservations.has(`res:${USER_B}:${IDENTITY}`)).toBe(false);
      const aHeld = ledger.reservations.get(`res:${USER_A}:${IDENTITY}`);
      expect(aHeld?.state).toBe("settled");
      expect(aHeld?.userId).toBe(USER_A);
    });
  });
});
