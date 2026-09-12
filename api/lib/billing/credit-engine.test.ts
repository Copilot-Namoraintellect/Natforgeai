import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { getDb } from "../../queries/connection";
import * as connectionModule from "../../queries/connection";
import { env } from "../../lib/env";
import { creditWallets, creditTransactions, users } from "@db/schema";
import {
  deductCredits,
  ensureWallet,
  isMySqlDuplicateKeyError,
  recordAiUsage,
  __setTestHookAfterWalletUpdate,
  type CreditEngineDbExecutor,
} from "./credit-engine";

function getDatabaseName(): string {
  try {
    const url = new URL(env.databaseUrl);
    return url.pathname.slice(1);
  } catch {
    return "";
  }
}

const dbName = getDatabaseName();
const isSafeTestDatabase =
  dbName.length > 0 &&
  /test|dev|local|staging|tmp|temp/i.test(dbName) &&
  !/prod/i.test(dbName);

const describeIfSafe = isSafeTestDatabase ? describe : describe.skip;

describe("isMySqlDuplicateKeyError classifier", () => {
  it("recognises a direct ER_DUP_ENTRY code", () => {
    expect(isMySqlDuplicateKeyError({ code: "ER_DUP_ENTRY" })).toBe(true);
  });

  it("recognises a direct errno 1062", () => {
    expect(isMySqlDuplicateKeyError({ errno: 1062 })).toBe(true);
  });

  it("recognises a one-level wrapped duplicate-key error", () => {
    expect(
      isMySqlDuplicateKeyError({ message: "Failed query", cause: { code: "ER_DUP_ENTRY" } })
    ).toBe(true);
  });

  it("recognises a multi-level wrapped duplicate-key error", () => {
    expect(
      isMySqlDuplicateKeyError({ cause: { cause: { errno: 1062 } } })
    ).toBe(true);
  });

  it("rejects an unrelated wrapped database error", () => {
    expect(
      isMySqlDuplicateKeyError({ cause: { code: "ER_NO_SUCH_TABLE", errno: 1146 } })
    ).toBe(false);
  });

  it("does not loop forever on a cyclic cause chain", () => {
    const a: Record<string, unknown> = { code: "SOME_ERROR" };
    const b: Record<string, unknown> = { cause: a };
    a.cause = b;
    expect(isMySqlDuplicateKeyError(b)).toBe(false);
  });
});

const TEST_USER_EMAIL_BASE = "wbs22-credit-engine-test";
const TEST_BALANCE = 1000;

describeIfSafe("deductCredits idempotency", () => {
  const db = getDb();
  let testUserId: number;

  async function createTestUser(suffix: string): Promise<number> {
    const email = `${TEST_USER_EMAIL_BASE}-${suffix}@natforgeai.test`;
    const [result] = await db.insert(users).values({
      email,
      username: `wbs22-${suffix}`,
      authType: "local",
      role: "user",
      name: "WBS 2.2 Test User",
    });
    return Number(result.insertId);
  }

  async function setBalance(userId: number, balance: number): Promise<void> {
    await db
      .update(creditWallets)
      .set({ balance, lifetimeEarned: balance, updatedAt: new Date() })
      .where(eq(creditWallets.userId, userId));
  }

  beforeEach(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    testUserId = await createTestUser(suffix);
    await ensureWallet(testUserId);
    await setBalance(testUserId, TEST_BALANCE);
  });

  afterEach(async () => {
    if (!testUserId) return;
    await db
      .delete(creditTransactions)
      .where(eq(creditTransactions.userId, testUserId));
    await db.delete(creditWallets).where(eq(creditWallets.userId, testUserId));
    await db.delete(users).where(eq(users.id, testUserId));
  });

  it("A. sequential same-key calls deduct exactly once", async () => {
    const key = `test-seq-${Date.now()}`;

    const first = await deductCredits({
      userId: testUserId,
      amount: 100,
      type: "agent_deduction",
      description: "test sequential deduction",
      metadata: { reason: "test" },
      idempotencyKey: key,
    });

    expect(first.alreadyDeducted).not.toBe(true);
    expect(first.newBalance).toBe(TEST_BALANCE - 100);

    const second = await deductCredits({
      userId: testUserId,
      amount: 100,
      type: "agent_deduction",
      description: "test sequential deduction duplicate",
      metadata: { reason: "test" },
      idempotencyKey: key,
    });

    expect(second.alreadyDeducted).toBe(true);
    expect(second.newBalance).toBe(TEST_BALANCE - 100);

    const wallet = await ensureWallet(testUserId);
    expect(wallet.balance).toBe(TEST_BALANCE - 100);

    const txs = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.idempotencyKey, key));
    expect(txs.length).toBe(1);
    expect(txs[0]?.amount).toBe(-100);
    expect(txs[0]?.balanceAfter).toBe(TEST_BALANCE - 100);
  });

  it("B. concurrent same-key calls deduct exactly once", async () => {
    const key = `test-concurrent-${Date.now()}`;
    const amount = 100;

    const attempts = Array.from({ length: 5 }, () =>
      deductCredits({
        userId: testUserId,
        amount,
        type: "agent_deduction",
        description: "test concurrent deduction",
        metadata: { reason: "test" },
        idempotencyKey: key,
      })
    );

    const results = await Promise.all(attempts);

    const successfulDeductions = results.filter((r) => !r.alreadyDeducted);
    expect(successfulDeductions.length).toBe(1);

    const alreadyDeducted = results.filter((r) => r.alreadyDeducted);
    expect(alreadyDeducted.length).toBe(4);

    const wallet = await ensureWallet(testUserId);
    expect(wallet.balance).toBe(TEST_BALANCE - amount);

    const txs = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.idempotencyKey, key));
    expect(txs.length).toBe(1);
  });

  it("C. different idempotency keys charge independently", async () => {
    const key1 = `test-diff-${Date.now()}-a`;
    const key2 = `test-diff-${Date.now()}-b`;

    const first = await deductCredits({
      userId: testUserId,
      amount: 100,
      type: "agent_deduction",
      description: "test different key 1",
      idempotencyKey: key1,
    });

    const second = await deductCredits({
      userId: testUserId,
      amount: 200,
      type: "agent_deduction",
      description: "test different key 2",
      idempotencyKey: key2,
    });

    expect(first.newBalance).toBe(TEST_BALANCE - 100);
    expect(second.newBalance).toBe(TEST_BALANCE - 300);

    const wallet = await ensureWallet(testUserId);
    expect(wallet.balance).toBe(TEST_BALANCE - 300);

    const txs = await db
      .select()
      .from(creditTransactions)
      .where(
        sql`${creditTransactions.idempotencyKey} IN (${key1}, ${key2})`
      );
    expect(txs.length).toBe(2);
  });

  it("D. insufficient balance does not create a claim or transaction", async () => {
    const key = `test-insufficient-${Date.now()}`;

    await expect(
      deductCredits({
        userId: testUserId,
        amount: TEST_BALANCE + 1,
        type: "agent_deduction",
        description: "test insufficient balance",
        idempotencyKey: key,
      })
    ).rejects.toThrow(/Insufficient credits/);

    const wallet = await ensureWallet(testUserId);
    expect(wallet.balance).toBe(TEST_BALANCE);

    const txs = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.idempotencyKey, key));
    expect(txs.length).toBe(0);
  });

  it("E. failure after wallet update rolls back the claim", async () => {
    // This test demonstrates the transaction boundary: if the step after the
    // wallet UPDATE throws, the idempotency claim inserted at the start of the
    // transaction must be rolled back. The test-only seam is triggered after the
    // wallet UPDATE succeeds and the new balance is re-read, but before the
    // final credit_transactions update is committed.
    const key = `test-rollback-${Date.now()}`;
    const walletBefore = await ensureWallet(testUserId);
    expect(walletBefore.balance).toBe(TEST_BALANCE);

    __setTestHookAfterWalletUpdate(() => {
      throw new Error("simulated post-deduction failure");
    });

    try {
      await expect(
        deductCredits({
          userId: testUserId,
          amount: 100,
          type: "agent_deduction",
          description: "test rollback path",
          idempotencyKey: key,
        })
      ).rejects.toThrow(/simulated post-deduction failure/);
    } finally {
      __setTestHookAfterWalletUpdate(undefined);
    }

    const afterWallet = await ensureWallet(testUserId);
    expect(afterWallet.balance).toBe(TEST_BALANCE);

    const txs = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.idempotencyKey, key));
    expect(txs.length).toBe(0);
  });

  it("F. non-idempotent callers retain existing behaviour", async () => {
    const first = await deductCredits({
      userId: testUserId,
      amount: 100,
      type: "agent_deduction",
      description: "test non-idempotent 1",
    });

    const second = await deductCredits({
      userId: testUserId,
      amount: 100,
      type: "agent_deduction",
      description: "test non-idempotent 2",
    });

    expect(first.newBalance).toBe(TEST_BALANCE - 100);
    expect(second.newBalance).toBe(TEST_BALANCE - 200);

    const wallet = await ensureWallet(testUserId);
    expect(wallet.balance).toBe(TEST_BALANCE - 200);

    const txs = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, testUserId));
    expect(txs.length).toBe(2);
  });

  it("G. creative idempotency key charges once for repeated calls", async () => {
    const campaignId = 999999;
    const operationId = 888888;
    const key = `creative-success:${campaignId}:job:${operationId}`;

    const first = await deductCredits({
      userId: testUserId,
      amount: 150,
      type: "agent_deduction",
      description: "creative agent execution (post-success)",
      metadata: { campaignId, generationSource: "job", generationOperationId: operationId, agentType: "creative" },
      idempotencyKey: key,
    });

    const second = await deductCredits({
      userId: testUserId,
      amount: 150,
      type: "agent_deduction",
      description: "creative agent execution (post-success)",
      metadata: { campaignId, generationSource: "job", generationOperationId: operationId, agentType: "creative" },
      idempotencyKey: key,
    });

    expect(first.alreadyDeducted).not.toBe(true);
    expect(second.alreadyDeducted).toBe(true);

    const wallet = await ensureWallet(testUserId);
    expect(wallet.balance).toBe(TEST_BALANCE - 150);

    const txs = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.idempotencyKey, key));
    expect(txs.length).toBe(1);
  });
});

describe("deductCredits idempotency safety guard", () => {
  it("reports the configured database name without printing credentials", () => {
    expect(dbName).toBeTruthy();
    expect(dbName).not.toMatch(/:\/\//);
  });
});

// ─── B2B-3B: dormant transaction-executor seams ───
//
// Pure-fake tests: no database required. The supplied-executor tests install
// a getDb that throws, so any hidden getDb escape fails the test by
// construction. The default-path tests return fakes through the getDb spy.

interface RecordedOp {
  op: "select" | "insert" | "update" | "execute";
  detail?: unknown;
}

function makeExecutorFake(config: {
  wallet: Record<string, unknown>;
  balance: number;
  deductAmount: number;
  selectQueue?: unknown[][];
  failInsertWith?: Error;
}) {
  const recorded: RecordedOp[] = [];
  const queue = [...(config.selectQueue ?? [])];
  const state = { balance: config.balance };

  function chain(rows: unknown[]) {
    const c: Record<string, unknown> = {
      from: () => c,
      where: () => c,
      limit: () => c,
      orderBy: () => c,
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
    insert: vi.fn((_table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        recorded.push({ op: "insert", detail: values });
        if (config.failInsertWith) throw config.failInsertWith;
        return [{ insertId: 555 }];
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
      recorded.push({ op: "execute", detail: compiled.sql });
      if (/UPDATE credit_wallets/.test(compiled.sql) && compiled.sql.includes("balance - ")) {
        if (state.balance < config.deductAmount) {
          return [{ affectedRows: 0 }];
        }
        state.balance -= config.deductAmount;
        return [{ affectedRows: 1 }];
      }
      return [{ affectedRows: 1 }];
    }),
  };

  return {
    executor: executor as unknown as CreditEngineDbExecutor,
    recorded,
    state,
  };
}

function walletRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    userId: 7,
    balance: 100,
    lifetimeEarned: 100,
    lifetimeSpent: 0,
    spendLimit: null,
    ...overrides,
  };
}

function duplicateKeyError(): Error {
  const err = new Error("Duplicate entry 'k1' for key 'idempotency_key'") as Error & {
    code: string;
    errno: number;
  };
  err.code = "ER_DUP_ENTRY";
  err.errno = 1062;
  return err;
}

describe("transaction-executor seams (B2B-3B)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function forbidGetDb() {
    return vi.spyOn(connectionModule, "getDb").mockImplementation(() => {
      throw new Error("getDb must not be called when an executor is supplied");
    });
  }

  it("keyed deduction with a supplied executor bypasses getDb, opens no nested transaction, and runs each operation exactly once", async () => {
    const getDbSpy = forbidGetDb();
    const { executor, recorded, state } = makeExecutorFake({
      wallet: walletRow(),
      balance: 100,
      deductAmount: 12,
      selectQueue: [[walletRow()], [{ id: 7, balance: 88 }]],
    });

    const result = await deductCredits({
      userId: 7,
      amount: 12,
      type: "image_generation",
      description: "Premium Marketing Leaflet (test)",
      idempotencyKey: "k1",
      executor,
    });

    expect(result).toEqual({ newBalance: 88 });
    expect(getDbSpy).not.toHaveBeenCalled();
    expect(recorded.map((entry) => entry.op)).toEqual([
      "select", // ensureWallet
      "insert", // idempotency claim
      "execute", // conditional wallet UPDATE
      "select", // wallet reread
      "update", // balanceAfter materialization
    ]);
    const claimInsert = recorded[1].detail as Record<string, unknown>;
    expect(claimInsert.idempotencyKey).toBe("k1");
    expect(claimInsert.amount).toBe(-12);
    const materialize = recorded[4].detail as Record<string, unknown>;
    expect(materialize).toEqual({ balanceAfter: 88 });
    expect(state.balance).toBe(88);
    // No retry: every operation ran exactly its expected number of times.
    const counts = (op: RecordedOp["op"]) =>
      recorded.filter((entry) => entry.op === op).length;
    expect(counts("select")).toBe(2);
    expect(counts("insert")).toBe(1);
    expect(counts("execute")).toBe(1);
    expect(counts("update")).toBe(1);
  });

  it("routes the monthly-spend lookup through the supplied executor", async () => {
    const getDbSpy = forbidGetDb();
    const { executor, recorded } = makeExecutorFake({
      wallet: walletRow({ spendLimit: 50 }),
      balance: 100,
      deductAmount: 15,
      selectQueue: [[walletRow({ spendLimit: 50 })], [{ total: 10 }], [{ id: 7, balance: 85 }]],
    });

    await deductCredits({
      userId: 7,
      amount: 15,
      type: "image_generation",
      description: "spend-limit success path",
      idempotencyKey: "k2",
      executor,
    });

    expect(getDbSpy).not.toHaveBeenCalled();
    expect(recorded.map((entry) => entry.op)).toEqual([
      "select", // ensureWallet
      "select", // monthly spend lookup
      "insert",
      "execute",
      "select",
      "update",
    ]);
  });

  it("preserves the spend-limit rejection through the supplied executor", async () => {
    forbidGetDb();
    const { executor, recorded, state } = makeExecutorFake({
      wallet: walletRow({ spendLimit: 50 }),
      balance: 100,
      deductAmount: 15,
      selectQueue: [[walletRow({ spendLimit: 50 })], [{ total: 40 }]],
    });

    await expect(
      deductCredits({
        userId: 7,
        amount: 15,
        type: "image_generation",
        description: "over spend limit",
        idempotencyKey: "k3",
        executor,
      })
    ).rejects.toThrow(/spend limit reached/);

    // Wallet was never touched: no deduction UPDATE ran.
    expect(recorded.map((entry) => entry.op)).toEqual(["select", "select"]);
    expect(state.balance).toBe(100);
  });

  it("preserves insufficient-credit behaviour and leaves fake state uncommitted", async () => {
    forbidGetDb();
    const { executor, recorded, state } = makeExecutorFake({
      wallet: walletRow({ balance: 5 }),
      balance: 5,
      deductAmount: 10,
      selectQueue: [[walletRow({ balance: 5 })]],
    });

    await expect(
      deductCredits({
        userId: 7,
        amount: 10,
        type: "image_generation",
        description: "insufficient",
        idempotencyKey: "k4",
        executor,
      })
    ).rejects.toThrow(/Insufficient credits/);

    expect(recorded.map((entry) => entry.op)).toEqual(["select", "insert", "execute"]);
    expect(state.balance).toBe(5);
  });

  it("rereads a duplicate idempotency winner through the same executor and returns alreadyDeducted", async () => {
    const getDbSpy = forbidGetDb();
    const { executor, recorded } = makeExecutorFake({
      wallet: walletRow(),
      balance: 100,
      deductAmount: 12,
      selectQueue: [
        [walletRow()],
        [
          {
            id: 901,
            userId: 7,
            walletId: 7,
            type: "image_generation",
            amount: -12,
            balanceAfter: 88,
            idempotencyKey: "k5",
          },
        ],
      ],
      failInsertWith: duplicateKeyError(),
    });

    const result = await deductCredits({
      userId: 7,
      amount: 12,
      type: "image_generation",
      description: "duplicate replay",
      idempotencyKey: "k5",
      executor,
    });

    expect(result).toEqual({ newBalance: 88, alreadyDeducted: true });
    expect(getDbSpy).not.toHaveBeenCalled();
    expect(recorded.map((entry) => entry.op)).toEqual(["select", "insert", "select"]);
  });

  it("preserves the idempotency-collision error for a mismatched duplicate", async () => {
    forbidGetDb();
    const { executor } = makeExecutorFake({
      wallet: walletRow(),
      balance: 100,
      deductAmount: 12,
      selectQueue: [
        [walletRow()],
        [
          {
            id: 901,
            userId: 7,
            walletId: 7,
            type: "image_generation",
            amount: -99,
            balanceAfter: 1,
            idempotencyKey: "k6",
          },
        ],
      ],
      failInsertWith: duplicateKeyError(),
    });

    await expect(
      deductCredits({
        userId: 7,
        amount: 12,
        type: "image_generation",
        description: "mismatched duplicate",
        idempotencyKey: "k6",
        executor,
      })
    ).rejects.toThrow(/IDEMPOTENCY_KEY_COLLISION/);
  });

  it("routes the non-keyed supplied-executor path without calling getDb", async () => {
    const getDbSpy = forbidGetDb();
    const { executor, recorded } = makeExecutorFake({
      wallet: walletRow(),
      balance: 100,
      deductAmount: 12,
      selectQueue: [[walletRow()], [{ id: 7, balance: 88 }]],
    });

    const result = await deductCredits({
      userId: 7,
      amount: 12,
      type: "image_generation",
      description: "legacy non-keyed path",
      executor,
    });

    expect(result).toEqual({ newBalance: 88 });
    expect("alreadyDeducted" in result).toBe(false);
    expect(getDbSpy).not.toHaveBeenCalled();
    expect(recorded.map((entry) => entry.op)).toEqual([
      "select", // ensureWallet
      "execute", // conditional wallet UPDATE
      "select", // wallet reread
      "insert", // ledger row
    ]);
    const ledgerInsert = recorded[3].detail as Record<string, unknown>;
    expect(ledgerInsert.balanceAfter).toBe(88);
    expect(ledgerInsert.idempotencyKey ?? null).toBeNull();
  });

  it("default keyed path keeps using getDb and opens its own transaction", async () => {
    // ensureWallet runs before the transaction through getDb(); the
    // transaction body then runs on the callback client.
    const outer = makeExecutorFake({
      wallet: walletRow(),
      balance: 100,
      deductAmount: 12,
      selectQueue: [[walletRow()]],
    });
    const tx = makeExecutorFake({
      wallet: walletRow(),
      balance: 100,
      deductAmount: 12,
      selectQueue: [[{ id: 7, balance: 88 }]],
    });
    const defaultDb = {
      ...outer.executor,
      transaction: vi.fn(async (fn: (client: unknown) => unknown) => fn(tx.executor)),
    };
    const getDbSpy = vi
      .spyOn(connectionModule, "getDb")
      .mockReturnValue(defaultDb as unknown as ReturnType<typeof getDb>);

    const result = await deductCredits({
      userId: 7,
      amount: 12,
      type: "image_generation",
      description: "default keyed path",
      idempotencyKey: "k7",
    });

    expect(result).toEqual({ newBalance: 88 });
    expect(getDbSpy).toHaveBeenCalled();
    expect(defaultDb.transaction).toHaveBeenCalledTimes(1);
    expect(outer.recorded.map((entry) => entry.op)).toEqual(["select"]);
    expect(tx.recorded.map((entry) => entry.op)).toEqual([
      "insert",
      "execute",
      "select",
      "update",
    ]);
  });

  it("recordAiUsage inserts through the supplied executor and bypasses getDb", async () => {
    const getDbSpy = forbidGetDb();
    const { executor, recorded } = makeExecutorFake({
      wallet: walletRow(),
      balance: 100,
      deductAmount: 0,
    });

    await recordAiUsage({
      userId: 7,
      agentType: "image_generation",
      model: "premium-v2-template",
      promptTokens: 500,
      completionTokens: 100,
      actualCostUsdMicro: 0,
      estimatedCostUsdMicro: 0,
      creditsDeducted: 12,
      metadata: { source: "premium" },
      executor,
    });

    expect(getDbSpy).not.toHaveBeenCalled();
    expect(recorded.map((entry) => entry.op)).toEqual(["insert"]);
    const usage = recorded[0].detail as Record<string, unknown>;
    expect(usage).toMatchObject({
      userId: 7,
      agentType: "image_generation",
      model: "premium-v2-template",
      creditsDeducted: 12,
      totalTokens: 600,
    });
  });

  it("recordAiUsage keeps the default getDb path when no executor is supplied", async () => {
    const { executor, recorded } = makeExecutorFake({
      wallet: walletRow(),
      balance: 100,
      deductAmount: 0,
    });
    const getDbSpy = vi
      .spyOn(connectionModule, "getDb")
      .mockReturnValue(executor as unknown as ReturnType<typeof getDb>);

    await recordAiUsage({
      userId: 7,
      agentType: "image_generation",
      model: "default-path",
      promptTokens: 1,
      completionTokens: 2,
      actualCostUsdMicro: 0,
      estimatedCostUsdMicro: 0,
      creditsDeducted: 0,
    });

    expect(getDbSpy).toHaveBeenCalledTimes(1);
    expect(recorded.map((entry) => entry.op)).toEqual(["insert"]);
  });

  it("recordAiUsage propagates executor errors without swallowing them", async () => {
    forbidGetDb();
    const failing = {
      select: vi.fn(),
      insert: vi.fn((_table: unknown) => ({
        values: async () => {
          throw new Error("disk full");
        },
      })),
      update: vi.fn(),
      execute: vi.fn(),
    } as unknown as CreditEngineDbExecutor;

    await expect(
      recordAiUsage({
        userId: 7,
        agentType: "image_generation",
        model: "failing",
        promptTokens: 1,
        completionTokens: 1,
        actualCostUsdMicro: 0,
        estimatedCostUsdMicro: 0,
        creditsDeducted: 0,
        executor: failing,
      })
    ).rejects.toThrow("disk full");
  });
});
