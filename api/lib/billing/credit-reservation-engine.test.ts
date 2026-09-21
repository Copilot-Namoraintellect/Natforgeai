import { describe, it, expect, afterEach, vi } from "vitest";
import { createHash } from "crypto";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { getTableName } from "drizzle-orm";
import * as connectionModule from "../../queries/connection";
import { buildCreditReservationId, type ReserveCreditsInput } from "./credit-reservation";
import type { CreditReservationStoreExecutor } from "./credit-reservation-store";
import {
  buildSettleDeductionIdempotencyKey,
  getAvailableCreditBalance,
  releaseWalletCredits,
  reserveWalletCredits,
  settleWalletCredits,
} from "./credit-reservation-engine";

// ─── Pure-fake tests: every db.transaction is routed to a recording fake;
// no real database connection is ever established. ───

interface RecordedOp {
  op: "select" | "insert" | "update" | "execute";
  table?: string;
  detail?: unknown;
  params?: unknown[];
}

interface WalletConfig {
  id: number;
  userId: number;
  balance: number;
  lifetimeEarned: number;
  lifetimeSpent: number;
  spendLimit: number | null;
}

function walletConfig(balance: number, spendLimit: number | null = null): WalletConfig {
  return { id: 7, userId: 7, balance, lifetimeEarned: balance, lifetimeSpent: 0, spendLimit };
}

function makeTxFake(config: {
  wallet: WalletConfig;
  selectQueue?: unknown[][];
  sumTotal?: number;
  failInsertWith?: Error;
  executeAffectedRows?: number;
}) {
  const recorded: RecordedOp[] = [];
  const queue = [...(config.selectQueue ?? [])];
  const state = { balance: config.wallet.balance };

  function chain(rows: unknown[]) {
    const c: Record<string, unknown> = {
      from: () => c,
      where: () => c,
      limit: () => c,
      orderBy: () => c,
      forUpdate: () => c,
      then: (resolve: (value: unknown[]) => unknown) => resolve(rows),
    };
    return c;
  }

  const executor = {
    select: vi.fn(() => {
      const rows = queue.length > 0 ? (queue.shift() as unknown[]) : [];
      recorded.push({ op: "select" });
      return chain(rows);
    }),
    insert: vi.fn((table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        recorded.push({ op: "insert", table: getTableName(table as never), detail: values });
        if (config.failInsertWith) throw config.failInsertWith;
        return [{ insertId: 500 }];
      },
    })),
    update: vi.fn((_table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: async (_cond: unknown) => {
          recorded.push({ op: "update", detail: patch });
          return [{ affectedRows: 1 }];
        },
      }),
    })),
    execute: vi.fn(async (query: unknown) => {
      const compiled = new MySqlDialect().sqlToQuery(query as never);
      recorded.push({ op: "execute", detail: compiled.sql, params: compiled.params });
      const text = compiled.sql;
      if (/FOR UPDATE/.test(text)) {
        return [[config.wallet]];
      }
      if (/^\s*SELECT/i.test(text)) {
        return [[{ total: config.sumTotal ?? 0 }]];
      }
      if (/UPDATE credit_wallets/.test(text)) {
        const amount = Number(compiled.params[0]);
        if (state.balance < amount) return [{ affectedRows: 0 }];
        state.balance -= amount;
        return [{ affectedRows: 1 }];
      }
      return [{ affectedRows: config.executeAffectedRows ?? 1 }];
    }),
  };

  return {
    executor: executor as unknown as CreditReservationStoreExecutor,
    recorded,
    state,
  };
}

function makeOuterDb(executor: CreditReservationStoreExecutor) {
  const state = { committed: false, rolledBack: false };
  const outer = {
    // Spread the executor ops so the same object can serve the engine's
    // direct getDb() reads (getAvailableCreditBalance) and its transaction
    // ownership for mutating operations.
    ...executor,
    transaction: vi.fn(async (fn: (client: unknown) => unknown) => {
      try {
        const result = await fn(executor);
        state.committed = true;
        return result;
      } catch (err) {
        state.rolledBack = true;
        throw err;
      }
    }),
  };
  return { outer, state };
}

function mockGetDb(...outers: unknown[]) {
  const spy = vi.spyOn(connectionModule, "getDb");
  outers.forEach((outer, index) => {
    if (index === outers.length - 1) {
      spy.mockReturnValue(outer as never);
    } else {
      spy.mockReturnValueOnce(outer as never);
    }
  });
  return spy;
}

function duplicateKeyError(): Error {
  const err = new Error("Duplicate entry for key 'cr_user_reference_idx'") as Error & {
    code: string;
    errno: number;
  };
  err.code = "ER_DUP_ENTRY";
  err.errno = 1062;
  return err;
}

function baseReserve(overrides: Partial<ReserveCreditsInput> = {}): ReserveCreditsInput {
  return {
    userId: 7,
    reservationReference: "creative-success:42:job:888",
    campaignId: 42,
    workflowOperationId: "op-sha-1",
    workflowAttemptId: "attempt-sha-1",
    stageId: "creative_generation",
    amount: 150,
    reason: "hold for creative generation",
    agentType: "creative",
    model: "premium-v2-template",
    provider: "openai",
    artifactId: "artifact-1",
    packageId: "pack-9",
    ...overrides,
  };
}

function reservationIdFor(reserve: ReserveCreditsInput): string {
  return buildCreditReservationId(reserve);
}

function reservationRow(overrides: Record<string, unknown> = {}) {
  const reserve = baseReserve();
  return {
    id: 55,
    reservationId: reservationIdFor(reserve),
    idempotencyKey: reservationIdFor(reserve),
    reservationReference: "creative-success:42:job:888",
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
    reservedAmount: 150,
    settledAmount: null,
    state: "reserved",
    reason: "hold for creative generation",
    settleKey: null,
    releaseKey: null,
    releaseReason: null,
    reservedAt: new Date("2026-05-29T10:00:00.000Z"),
    settledAt: null,
    releasedAt: null,
    createdAt: new Date("2026-05-29T10:00:00.000Z"),
    updatedAt: new Date("2026-05-29T10:00:00.000Z"),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reserveWalletCredits", () => {
  it("1. reserves when free capacity is sufficient, locking the wallet before the capacity decision", async () => {
    const tx = makeTxFake({
      wallet: walletConfig(1000),
      selectQueue: [[walletConfig(1000)]], // ensureWallet finds the wallet
      sumTotal: 150,
    });
    const { outer, state } = makeOuterDb(tx.executor);
    const getDbSpy = mockGetDb(outer);

    const result = await reserveWalletCredits(baseReserve());

    expect(getDbSpy).toHaveBeenCalledTimes(1); // the authority owns the transaction
    expect(state.committed).toBe(true);
    expect(state.rolledBack).toBe(false);
    expect(result.duplicateClassification).toBe("none");
    expect(result.reservation.state).toBe("reserved");
    expect(result.walletBalance).toBe(1000);
    expect(result.reservedAmount).toBe(150);
    expect(result.availableBalance).toBe(850);
    expect(tx.state.balance).toBe(1000); // reserve never mutates the wallet

    const lock = tx.recorded.find((entry) => entry.op === "execute" && /FOR UPDATE/.test(entry.detail as string));
    expect(lock).toBeDefined();
    expect(lock?.detail).toContain("credit_wallets");
    expect(lock?.detail).toContain("userId");
    const sum = tx.recorded.find((entry) => entry.op === "execute" && /SUM/.test(entry.detail as string));
    expect(sum?.detail).toContain("credit_reservations");
    expect(sum?.detail).toContain("state = 'reserved'");
    // lock executed before the capacity SUM
    expect(tx.recorded.indexOf(lock!)).toBeLessThan(tx.recorded.indexOf(sum!));
    const insert = tx.recorded.find((entry) => entry.op === "insert");
    expect(insert?.table).toBe("credit_reservations");
  });

  it("2. rejects and rolls back the whole transaction (including the reservation) when capacity is insufficient", async () => {
    const tx = makeTxFake({
      wallet: walletConfig(100),
      selectQueue: [[walletConfig(100)]],
      sumTotal: 150,
    });
    const { outer, state } = makeOuterDb(tx.executor);
    mockGetDb(outer);

    await expect(reserveWalletCredits(baseReserve())).rejects.toThrow(
      expect.objectContaining({ code: "INSUFFICIENT_CREDIT_CAPACITY" })
    );

    expect(state.rolledBack).toBe(true);
    expect(state.committed).toBe(false);
    // the reservation insert was attempted but is uncommitted
    expect(tx.recorded.some((entry) => entry.op === "insert" && entry.table === "credit_reservations")).toBe(true);
    // no wallet balance mutation was attempted
    expect(tx.recorded.some((entry) => entry.op === "execute" && /UPDATE credit_wallets/.test(entry.detail as string))).toBe(false);
    expect(tx.state.balance).toBe(100);
  });

  it("3. two serialized reservations cannot overcommit one wallet", async () => {
    const tx1 = makeTxFake({
      wallet: walletConfig(1000),
      selectQueue: [[walletConfig(1000)]],
      sumTotal: 600,
    });
    const outer1 = makeOuterDb(tx1.executor);
    const tx2 = makeTxFake({
      wallet: walletConfig(1000),
      selectQueue: [[walletConfig(1000)]],
      sumTotal: 1100,
    });
    const outer2 = makeOuterDb(tx2.executor);
    mockGetDb(outer1.outer, outer2.outer);

    const first = await reserveWalletCredits(
      baseReserve({ reservationReference: "ref-a", amount: 600 })
    );
    expect(first.duplicateClassification).toBe("none");
    expect(first.availableBalance).toBe(400);
    expect(outer1.state.committed).toBe(true);

    // Second reservation sees the first committed hold (600) plus its own
    // hold (500) in the same-transaction SUM: 1000 - 1100 < 0.
    await expect(
      reserveWalletCredits(baseReserve({ reservationReference: "ref-b", amount: 500 }))
    ).rejects.toThrow(expect.objectContaining({ code: "INSUFFICIENT_CREDIT_CAPACITY" }));
    expect(outer2.state.rolledBack).toBe(true);
    expect(outer2.state.committed).toBe(false);
  });

  it("4. exact reserve replay does not re-validate capacity or double-count its hold", async () => {
    const tx = makeTxFake({
      wallet: walletConfig(1000),
      selectQueue: [[walletConfig(1000)], [reservationRow()]], // ensureWallet, then store reread by natural reference
      failInsertWith: duplicateKeyError(),
      sumTotal: 1_000_000, // would fail validation if the replay path re-checked it
    });
    const { outer, state } = makeOuterDb(tx.executor);
    mockGetDb(outer);

    const result = await reserveWalletCredits(baseReserve());

    expect(result.duplicateClassification).toBe("idempotent_replay");
    expect(state.committed).toBe(true); // replay is never rejected for low capacity
    expect(result.reservation.reservationId).toBe(reservationIdFor(baseReserve()));
  });

  it("8. active reserved holds participate in spend-limit capacity", async () => {
    const failingTx = makeTxFake({
      wallet: walletConfig(1000, 500),
      selectQueue: [[walletConfig(1000, 500)], [{ total: 100 }]], // ensureWallet, then spent-this-month
      sumTotal: 450, // hold would take spent (100) + holds (450) past the limit (500)
    });
    const failingOuter = makeOuterDb(failingTx.executor);

    const passingTx = makeTxFake({
      wallet: walletConfig(1000, 500),
      selectQueue: [[walletConfig(1000, 500)], [{ total: 100 }]],
      sumTotal: 400, // 100 + 400 = 500 is not above the limit
    });
    const passingOuter = makeOuterDb(passingTx.executor);
    mockGetDb(failingOuter.outer, passingOuter.outer);

    await expect(
      reserveWalletCredits(baseReserve({ reservationReference: "spend-fail", amount: 450 }))
    ).rejects.toThrow(expect.objectContaining({ code: "RESERVATION_SPEND_LIMIT_EXCEEDED" }));
    expect(failingOuter.state.rolledBack).toBe(true);

    const passed = await reserveWalletCredits(
      baseReserve({ reservationReference: "spend-pass", amount: 400 })
    );
    expect(passed.duplicateClassification).toBe("none");
    expect(passed.availableBalance).toBe(600);
    expect(passingOuter.state.committed).toBe(true);
  });
});

describe("settleWalletCredits", () => {
  it("9. atomically transitions the reservation and deducts the wallet with a deterministic deduction key and full attribution metadata", async () => {
    const tx = makeTxFake({
      wallet: walletConfig(1000),
      selectQueue: [
        [reservationRow()], // engine pre-read
        [reservationRow()], // store settle select
        [walletConfig(1000)], // deductCredits ensureWallet
        [{ id: 7, balance: 850 }], // wallet reread
      ],
    });
    const { outer, state } = makeOuterDb(tx.executor);
    mockGetDb(outer);

    const reservationId = reservationIdFor(baseReserve());
    const result = await settleWalletCredits({ reservationId, settleKey: "settle-key-1" });

    expect(state.committed).toBe(true);
    expect(result.duplicateClassification).toBe("none");
    expect(result.reservation.state).toBe("settled");
    expect(result.reservation.settledAmount).toBe(150);
    expect(result.newBalance).toBe(850);
    expect(tx.state.balance).toBe(850);

    const claim = tx.recorded.find(
      (entry) => entry.op === "insert" && entry.table === "credit_transactions"
    );
    expect(claim).toBeDefined();
    const claimValues = claim?.detail as Record<string, unknown>;
    expect(claimValues.type).toBe("agent_deduction");
    expect(claimValues.amount).toBe(-150);
    expect(claimValues.walletId).toBe(7);
    expect(claimValues.idempotencyKey).toBe(
      createHash("sha256")
        .update(`credit-reservation-settle:${reservationId}:settle-key-1`, "utf8")
        .digest("hex")
    );
    expect(buildSettleDeductionIdempotencyKey(reservationId, "settle-key-1")).toBe(
      claimValues.idempotencyKey as string
    );
    expect(claimValues.metadata).toEqual({
      reservationId,
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

    // order proof: lock -> settle transition -> deduction
    const ops = tx.recorded.map((entry) => entry.op);
    const lockIndex = tx.recorded.findIndex((entry) => entry.op === "execute" && /FOR UPDATE/.test(entry.detail as string));
    const settleIndex = tx.recorded.findIndex((entry) => entry.op === "execute" && /UPDATE credit_reservations/.test(entry.detail as string));
    const deductIndex = tx.recorded.findIndex((entry) => entry.op === "execute" && /UPDATE credit_wallets/.test(entry.detail as string));
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(lockIndex).toBeLessThan(settleIndex);
    expect(settleIndex).toBeLessThan(deductIndex);
  });

  it("10. settlement rollback restores the reservation and wallet when the deduction fails", async () => {
    const tx = makeTxFake({
      wallet: walletConfig(100), // wallet drained after reserve: deduction must fail
      selectQueue: [
        [reservationRow()],
        [reservationRow()],
        [walletConfig(100)],
      ],
    });
    const { outer, state } = makeOuterDb(tx.executor);
    mockGetDb(outer);

    await expect(
      settleWalletCredits({
        reservationId: reservationIdFor(baseReserve()),
        settleKey: "settle-key-1",
      })
    ).rejects.toThrow(/Insufficient credits/);

    expect(state.rolledBack).toBe(true);
    expect(state.committed).toBe(false);
    // the settle transition and the claim insert were attempted but survive nowhere
    expect(tx.recorded.some((entry) => entry.op === "execute" && /UPDATE credit_reservations/.test(entry.detail as string))).toBe(true);
    expect(tx.recorded.some((entry) => entry.op === "insert" && entry.table === "credit_transactions")).toBe(true);
    // the wallet UPDATE failed last; no balanceAfter materialization followed
    const last = tx.recorded[tx.recorded.length - 1];
    expect(last.op).toBe("execute");
    expect(last.detail as string).toContain("UPDATE credit_wallets");
    expect(tx.recorded.some((entry) => entry.op === "update")).toBe(false);
    expect(tx.state.balance).toBe(100);
  });

  it("11. settle replay returns the prior settled result and never deducts twice", async () => {
    const tx = makeTxFake({
      wallet: walletConfig(850),
      selectQueue: [
        [reservationRow({ state: "settled", settledAmount: 150, settleKey: "settle-key-1", settledAt: new Date() })],
        [reservationRow({ state: "settled", settledAmount: 150, settleKey: "settle-key-1", settledAt: new Date() })],
      ],
    });
    const { outer, state } = makeOuterDb(tx.executor);
    mockGetDb(outer);

    const result = await settleWalletCredits({
      reservationId: reservationIdFor(baseReserve()),
      settleKey: "settle-key-1",
    });

    expect(result.duplicateClassification).toBe("idempotent_replay");
    expect(result.alreadyDeducted).toBe(true);
    expect(result.reservation.state).toBe("settled");
    expect(result.newBalance).toBe(850);
    expect(
      tx.recorded.some((entry) => entry.op === "insert" && entry.table === "credit_transactions")
    ).toBe(false);
    expect(
      tx.recorded.some((entry) => entry.op === "execute" && /UPDATE credit_wallets/.test(entry.detail as string))
    ).toBe(false);
    expect(tx.state.balance).toBe(850);
    expect(state.committed).toBe(true);
  });

  it("12. partial settlement deducts only the settled amount", async () => {
    const tx = makeTxFake({
      wallet: walletConfig(1000),
      selectQueue: [
        [reservationRow()],
        [reservationRow()],
        [walletConfig(1000)],
        [{ id: 7, balance: 910 }],
      ],
    });
    const { outer, state } = makeOuterDb(tx.executor);
    mockGetDb(outer);

    const result = await settleWalletCredits({
      reservationId: reservationIdFor(baseReserve()),
      settleKey: "settle-partial",
      settledAmount: 90,
    });

    expect(state.committed).toBe(true);
    expect(result.reservation.settledAmount).toBe(90);
    expect(result.newBalance).toBe(910);
    expect(tx.state.balance).toBe(910);
    const claim = tx.recorded.find(
      (entry) => entry.op === "insert" && entry.table === "credit_transactions"
    );
    expect((claim?.detail as Record<string, unknown>).amount).toBe(-90);
  });

  it("15b. sparse attribution omits null fields from deduction metadata", async () => {
    const sparse = baseReserve({
      reservationReference: "sparse-ref",
      campaignId: null,
      workflowOperationId: null,
      workflowAttemptId: null,
      stageId: null,
      agentType: null,
      model: null,
      provider: null,
      artifactId: null,
      packageId: null,
    });
    const sparseRow = reservationRow({
      reservationId: reservationIdFor(sparse),
      idempotencyKey: reservationIdFor(sparse),
      reservationReference: "sparse-ref",
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
    const tx = makeTxFake({
      wallet: walletConfig(1000),
      selectQueue: [
        [sparseRow],
        [sparseRow],
        [walletConfig(1000)],
        [{ id: 7, balance: 850 }],
      ],
    });
    const { outer } = makeOuterDb(tx.executor);
    mockGetDb(outer);

    await settleWalletCredits({
      reservationId: reservationIdFor(sparse),
      settleKey: "settle-sparse",
    });

    const claim = tx.recorded.find(
      (entry) => entry.op === "insert" && entry.table === "credit_transactions"
    );
    const metadata = (claim?.detail as Record<string, unknown>).metadata as Record<string, unknown>;
    expect(metadata).toEqual({ reservationId: reservationIdFor(sparse) });
    expect(Object.keys(metadata)).toEqual(["reservationId"]);
  });
});

describe("releaseWalletCredits", () => {
  it("13. releases the reservation and changes no wallet balance, creating no transaction", async () => {
    const tx = makeTxFake({
      wallet: walletConfig(1000),
      selectQueue: [[reservationRow()]],
    });
    const { outer, state } = makeOuterDb(tx.executor);
    mockGetDb(outer);

    const result = await releaseWalletCredits({
      reservationId: reservationIdFor(baseReserve()),
      releaseKey: "release-key-1",
      reason: "workflow_failed",
    });

    expect(state.committed).toBe(true);
    expect(result.duplicateClassification).toBe("none");
    expect(result.reservation.state).toBe("released");
    expect(result.reservation.releasedAmount).toBe(150);
    expect(
      tx.recorded.some((entry) => entry.op === "execute" && /UPDATE credit_wallets/.test(entry.detail as string))
    ).toBe(false);
    expect(
      tx.recorded.some((entry) => entry.op === "insert" && entry.table === "credit_transactions")
    ).toBe(false);
    expect(tx.recorded.some((entry) => entry.op === "insert" && entry.table === "credit_reservations")).toBe(false);
    expect(tx.state.balance).toBe(1000);
    const releaseUpdate = tx.recorded.find(
      (entry) => entry.op === "execute" && /UPDATE credit_reservations/.test(entry.detail as string)
    );
    expect(releaseUpdate?.detail as string).toContain("'released'");
  });

  it("14. release replay is idempotent and changes no wallet balance", async () => {
    const tx = makeTxFake({
      wallet: walletConfig(1000),
      selectQueue: [
        [reservationRow({ state: "released", releaseKey: "release-key-1", releasedAt: new Date() })],
      ],
    });
    const { outer, state } = makeOuterDb(tx.executor);
    mockGetDb(outer);

    const result = await releaseWalletCredits({
      reservationId: reservationIdFor(baseReserve()),
      releaseKey: "release-key-1",
    });

    expect(result.duplicateClassification).toBe("idempotent_replay");
    expect(result.reservation.state).toBe("released");
    expect(state.committed).toBe(true);
    expect(tx.recorded.every((entry) => entry.op === "select")).toBe(true);
    expect(tx.state.balance).toBe(1000);
  });
});

describe("getAvailableCreditBalance", () => {
  it("5. active holds reduce the available balance", async () => {
    const tx = makeTxFake({
      wallet: walletConfig(1000),
      selectQueue: [[walletConfig(1000)]],
      sumTotal: 150,
    });
    mockGetDb(makeOuterDb(tx.executor).outer);

    const result = await getAvailableCreditBalance(7);

    expect(result).toEqual({ walletBalance: 1000, reservedAmount: 150, availableBalance: 850 });
    const sum = tx.recorded.find((entry) => entry.op === "execute" && /SUM/.test(entry.detail as string));
    expect(sum?.detail).toContain("state = 'reserved'");
  });

  it("6. released holds no longer reduce the available balance", async () => {
    const tx = makeTxFake({
      wallet: walletConfig(1000),
      selectQueue: [[walletConfig(1000)]],
      sumTotal: 0,
    });
    mockGetDb(makeOuterDb(tx.executor).outer);

    const result = await getAvailableCreditBalance(7);

    expect(result).toEqual({ walletBalance: 1000, reservedAmount: 0, availableBalance: 1000 });
  });

  it("7. settled holds no longer count as reserved (full lifecycle)", async () => {
    // reserve 150 against 1000
    const reserveTx = makeTxFake({
      wallet: walletConfig(1000),
      selectQueue: [[walletConfig(1000)]],
      sumTotal: 150,
    });
    const reserveOuter = makeOuterDb(reserveTx.executor);
    // settle 150: deduction brings the wallet to 850
    const settleTx = makeTxFake({
      wallet: walletConfig(1000),
      selectQueue: [
        [reservationRow()],
        [reservationRow()],
        [walletConfig(1000)],
        [{ id: 7, balance: 850 }],
      ],
    });
    const settleOuter = makeOuterDb(settleTx.executor);
    // read: settled hold excluded from the reserved SUM
    const readTx = makeTxFake({
      wallet: walletConfig(850),
      selectQueue: [[walletConfig(850)]],
      sumTotal: 0,
    });
    mockGetDb(reserveOuter.outer, settleOuter.outer, makeOuterDb(readTx.executor).outer);

    const reserved = await reserveWalletCredits(baseReserve());
    expect(reserved.availableBalance).toBe(850);

    const settled = await settleWalletCredits({
      reservationId: reserved.reservation.reservationId,
      settleKey: "settle-key-1",
    });
    expect(settled.newBalance).toBe(850);

    const after = await getAvailableCreditBalance(7);
    expect(after.walletBalance).toBe(850);
    expect(after.reservedAmount).toBe(0);
    expect(after.availableBalance).toBe(850);
  });
});
