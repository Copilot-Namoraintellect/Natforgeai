import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import { env } from "../../lib/env";
import { creditWallets, creditTransactions, users } from "@db/schema";
import {
  deductCredits,
  ensureWallet,
  isMySqlDuplicateKeyError,
  __setTestHookAfterWalletUpdate,
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
    const agentRunId = 888888;
    const key = `creative-success:${campaignId}:${agentRunId}`;

    const first = await deductCredits({
      userId: testUserId,
      amount: 150,
      type: "agent_deduction",
      description: "creative agent execution (post-success)",
      metadata: { campaignId, agentRunId, agentType: "creative" },
      idempotencyKey: key,
    });

    const second = await deductCredits({
      userId: testUserId,
      amount: 150,
      type: "agent_deduction",
      description: "creative agent execution (post-success)",
      metadata: { campaignId, agentRunId, agentType: "creative" },
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
