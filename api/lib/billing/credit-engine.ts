import { getDb } from "../../queries/connection";
import { creditWallets, creditTransactions, aiUsage, subscriptionTiers, subscriptions } from "@db/schema";
import { eq, and, gte, sql, desc } from "drizzle-orm";
import { TRPCError } from "@trpc/server";

// Test-only seam. Tests install a callback here to force a failure after the
// wallet UPDATE but before the final credit_transactions materialisation.
// It is not part of the deductCredits input contract and cannot be supplied by
// production callers.
let testHookAfterWalletUpdate: (() => void | Promise<void>) | undefined;

export function __setTestHookAfterWalletUpdate(
  hook: (() => void | Promise<void>) | undefined
): void {
  testHookAfterWalletUpdate = hook;
}

export function isMySqlDuplicateKeyError(err: unknown): boolean {
  const seen = new WeakSet<object>();
  let current: unknown = err;
  let depth = 0;
  while (current && typeof current === "object" && depth < 5) {
    if (seen.has(current)) break;
    seen.add(current);
    const e = current as Record<string, unknown>;
    if (e.code === "ER_DUP_ENTRY" || e.errno === 1062) return true;
    current = e.cause;
    depth++;
  }
  return false;
}

function throwIdempotencyCollision(): never {
  throw new TRPCError({
    code: "CONFLICT",
    message: "IDEMPOTENCY_KEY_COLLISION",
  });
}


/**
 * Ensures a credit wallet exists for a user. Creates one if missing.
 */
export async function ensureWallet(userId: number): Promise<typeof creditWallets.$inferSelect> {
  const db = getDb();

  const [existing] = await db
    .select()
    .from(creditWallets)
    .where(eq(creditWallets.userId, userId))
    .limit(1);

  if (existing) return existing;

  const [result] = await db.insert(creditWallets).values({
    userId,
    balance: 0,
    lifetimeEarned: 0,
    lifetimeSpent: 0,
    monthlyAllocation: 0,
  });

  const [wallet] = await db
    .select()
    .from(creditWallets)
    .where(eq(creditWallets.id, Number(result.insertId)))
    .limit(1);

  return wallet!;
}

/**
 * Allocate monthly credits from a user's subscription tier.
 * Should be called on subscription creation/renewal.
 */
export async function allocateMonthlyCredits(userId: number): Promise<{ allocated: number }> {
  const db = getDb();

  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), eq(subscriptions.status, "active")))
    .orderBy(desc(subscriptions.createdAt))
    .limit(1);

  if (!sub) return { allocated: 0 };

  const [tier] = await db
    .select()
    .from(subscriptionTiers)
    .where(eq(subscriptionTiers.id, sub.tierId))
    .limit(1);

  if (!tier || tier.monthlyCredits <= 0) return { allocated: 0 };

  const wallet = await ensureWallet(userId);

  // Check if already reset this month
  const now = new Date();
  if (wallet.monthlyResetAt && wallet.monthlyResetAt > new Date(now.getFullYear(), now.getMonth(), 1)) {
    return { allocated: 0 };
  }

  const newBalance = wallet.balance + tier.monthlyCredits;

  await db
    .update(creditWallets)
    .set({
      balance: newBalance,
      lifetimeEarned: wallet.lifetimeEarned + tier.monthlyCredits,
      monthlyAllocation: tier.monthlyCredits,
      monthlyResetAt: now,
      updatedAt: now,
    })
    .where(eq(creditWallets.id, wallet.id));

  await db.insert(creditTransactions).values({
    userId,
    walletId: wallet.id,
    type: "subscription_allocation",
    amount: tier.monthlyCredits,
    balanceAfter: newBalance,
    description: `Monthly allocation from ${tier.name} subscription`,
    metadata: { tierId: tier.id, tierSlug: tier.slug },
  });

  // Update subscription allocation tracking
  const nextAllocation = new Date(now);
  nextAllocation.setMonth(nextAllocation.getMonth() + 1);
  await db
    .update(subscriptions)
    .set({
      lastCreditAllocationAt: now,
      nextCreditAllocationAt: nextAllocation,
      updatedAt: now,
    })
    .where(eq(subscriptions.id, sub.id));

  return { allocated: tier.monthlyCredits };
}

/**
 * Deduct credits for an AI operation. Throws if insufficient balance.
 */
export async function deductCredits({
  userId,
  amount,
  type,
  description,
  metadata,
  idempotencyKey,
}: {
  userId: number;
  amount: number;
  type: typeof creditTransactions.$inferInsert["type"];
  description: string;
  metadata?: Record<string, any>;
  idempotencyKey?: string;
}): Promise<{ newBalance: number; alreadyDeducted?: boolean }> {
  const db = getDb();

  const wallet = await ensureWallet(userId);

  // Check spend limit
  if (wallet.spendLimit !== null && wallet.spendLimit > 0) {
    const spentThisMonth = await getCreditsSpentThisMonth(userId);
    if (spentThisMonth + amount > wallet.spendLimit) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `AI spend limit reached. Limit: ${wallet.spendLimit} credits/month. Spent: ${spentThisMonth}. Requested: ${amount}.`,
      });
    }
  }

  if (idempotencyKey) {
    // Run the deduction inside a transaction. If another caller has already
    // claimed this idempotency key, MySQL rejects the claim INSERT with
    // ER_DUP_ENTRY. The transaction then rolls back and we look up the
    // already-committed transaction from outside the failed transaction. This
    // avoids deadlocks that can occur if we try to lock-read the duplicate row
    // inside the same transaction that just failed to insert it.
    try {
      return await db.transaction(async (tx) => {
        // Claim the idempotency key first. The unique constraint guarantees
        // that only one transaction can record a claim for this key.
        await tx.insert(creditTransactions).values({
          userId,
          walletId: wallet.id,
          type,
          amount: -amount,
          balanceAfter: 0,
          description,
          metadata: metadata as any,
          idempotencyKey,
        });

        // Atomic balance deduction with race-condition protection
        const updateResult = await tx.execute(
          sql`UPDATE credit_wallets
              SET balance = balance - ${amount}, lifetimeSpent = lifetimeSpent + ${amount}, updatedAt = NOW()
              WHERE id = ${wallet.id} AND balance >= ${amount}`
        );

        // MySQL2 returns [ResultSetHeader, ...] where affectedRows is on the first element
        const walletAffectedRows = (updateResult as any)?.[0]?.affectedRows ?? 0;

        if (walletAffectedRows === 0) {
          throw new TRPCError({
            code: "PAYMENT_REQUIRED",
            message: `Insufficient credits. Balance: ${wallet.balance}. Required: ${amount}. Upgrade your plan or purchase more credits.`,
          });
        }

        // Re-read wallet to avoid stale balance under concurrency
        const [updatedWallet] = await tx
          .select()
          .from(creditWallets)
          .where(eq(creditWallets.id, wallet.id))
          .limit(1);
        const newBalance = updatedWallet?.balance ?? wallet.balance - amount;

        // Test-only seam: allow tests to force a failure after the wallet UPDATE
        // but before the claim row is materialised, proving the transaction rolls
        // back and leaves no idempotency claim.
        if (testHookAfterWalletUpdate) {
          await testHookAfterWalletUpdate();
        }

        // Materialise the actual post-deduction balance on the idempotency claim.
        // If this or any earlier step fails, the transaction rolls back and the
        // claim row is never visible.
        await tx
          .update(creditTransactions)
          .set({ balanceAfter: newBalance })
          .where(eq(creditTransactions.idempotencyKey, idempotencyKey));

        return { newBalance };
      });
    } catch (err) {
      if (isMySqlDuplicateKeyError(err)) {
        // The failed transaction has already rolled back. Read the committed
        // transaction that won the race and verify it represents the same
        // deduction before reporting alreadyDeducted.
        const [existing] = await db
          .select()
          .from(creditTransactions)
          .where(eq(creditTransactions.idempotencyKey, idempotencyKey))
          .limit(1);

        if (!existing) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message:
              "Idempotency key collision detected but existing transaction could not be retrieved",
          });
        }

        if (
          existing.userId !== userId ||
          existing.walletId !== wallet.id ||
          existing.type !== type ||
          existing.amount !== -amount
        ) {
          throwIdempotencyCollision();
        }

        return { newBalance: existing.balanceAfter, alreadyDeducted: true };
      }
      throw err;
    }
  }

  // Non-idempotent path: preserve existing behaviour exactly.
  // Atomic balance deduction with race-condition protection
  const updateResult = await db.execute(
    sql`UPDATE credit_wallets 
        SET balance = balance - ${amount}, lifetimeSpent = lifetimeSpent + ${amount}, updatedAt = NOW()
        WHERE id = ${wallet.id} AND balance >= ${amount}`
  );

  // MySQL2 returns [ResultSetHeader, ...] where affectedRows is on the first element
  const affectedRows = (updateResult as any)?.[0]?.affectedRows ?? 0;

  if (affectedRows === 0) {
    throw new TRPCError({
      code: "PAYMENT_REQUIRED",
      message: `Insufficient credits. Balance: ${wallet.balance}. Required: ${amount}. Upgrade your plan or purchase more credits.`,
    });
  }

  // Re-read wallet to avoid stale balance under concurrency
  const [updatedWallet] = await db
    .select()
    .from(creditWallets)
    .where(eq(creditWallets.id, wallet.id))
    .limit(1);
  const newBalance = updatedWallet?.balance ?? wallet.balance - amount;

  await db.insert(creditTransactions).values({
    userId,
    walletId: wallet.id,
    type,
    amount: -amount,
    balanceAfter: newBalance,
    description,
    metadata: metadata as any,
  });

  return { newBalance };
}

/**
 * Record AI usage and deduct credits in one operation.
 */
export async function recordAiUsage({
  userId,
  campaignId,
  agentType,
  model,
  promptTokens,
  completionTokens,
  actualCostUsdMicro,
  estimatedCostUsdMicro,
  creditsDeducted,
  metadata,
}: {
  userId: number;
  campaignId?: number;
  agentType: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  actualCostUsdMicro: number;
  estimatedCostUsdMicro: number;
  creditsDeducted: number;
  metadata?: Record<string, any>;
}): Promise<void> {
  const db = getDb();

  await db.insert(aiUsage).values({
    userId,
    campaignId: campaignId ?? null,
    agentType: agentType as any,
    model,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    actualCostUsd: actualCostUsdMicro,
    estimatedCostUsd: estimatedCostUsdMicro,
    creditsDeducted,
    metadata: metadata as any,
  });
}

/**
 * Pre-flight check: verify user has enough credits for an operation.
 * Does not deduct credits.
 */
export async function checkCredits(userId: number, estimatedCost: number): Promise<{ hasCredits: boolean; balance: number; required: number }> {
  const wallet = await ensureWallet(userId);
  return {
    hasCredits: wallet.balance >= estimatedCost,
    balance: wallet.balance,
    required: estimatedCost,
  };
}

/**
 * Get total credits spent this calendar month.
 */
export async function getCreditsSpentThisMonth(userId: number): Promise<number> {
  const db = getDb();
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const result = await db
    .select({
      total: sql<number>`COALESCE(SUM(ABS(${creditTransactions.amount})), 0)`,
    })
    .from(creditTransactions)
    .where(
      and(
        eq(creditTransactions.userId, userId),
        gte(creditTransactions.createdAt, startOfMonth),
        sql`${creditTransactions.amount} < 0`
      )
    );

  return result[0]?.total ?? 0;
}

/**
 * Get credit wallet with computed stats.
 */
export async function getWalletWithStats(userId: number) {
  const wallet = await ensureWallet(userId);
  const spentThisMonth = await getCreditsSpentThisMonth(userId);

  return {
    ...wallet,
    spentThisMonth,
    remainingThisMonth: Math.max(0, wallet.monthlyAllocation - spentThisMonth),
  };
}

/**
 * Refund credits for a failed operation. Idempotent when an idempotencyKey is
 * supplied: repeated calls with the same key return the existing refund without
 * crediting the wallet twice.
 */
export async function refundCredits({
  userId,
  amount,
  description,
  idempotencyKey,
  metadata,
}: {
  userId: number;
  amount: number;
  description: string;
  idempotencyKey?: string;
  metadata?: Record<string, any>;
}): Promise<{ newBalance: number; alreadyRefunded?: boolean }> {
  if (amount <= 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Refund amount must be positive.",
    });
  }

  const db = getDb();
  const wallet = await ensureWallet(userId);

  if (idempotencyKey) {
    try {
      return await db.transaction(async (tx) => {
        await tx.insert(creditTransactions).values({
          userId,
          walletId: wallet.id,
          type: "refund",
          amount,
          balanceAfter: 0,
          description,
          metadata: metadata as any,
          idempotencyKey,
        });

        const updateResult = await tx.execute(
          sql`UPDATE credit_wallets
              SET balance = balance + ${amount}, updatedAt = NOW()
              WHERE id = ${wallet.id}`
        );

        const walletAffectedRows = (updateResult as any)?.[0]?.affectedRows ?? 0;
        if (walletAffectedRows === 0) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Refund succeeded but wallet could not be updated.",
          });
        }

        const [updatedWallet] = await tx
          .select()
          .from(creditWallets)
          .where(eq(creditWallets.id, wallet.id))
          .limit(1);
        const newBalance = updatedWallet?.balance ?? wallet.balance + amount;

        await tx
          .update(creditTransactions)
          .set({ balanceAfter: newBalance })
          .where(eq(creditTransactions.idempotencyKey, idempotencyKey));

        return { newBalance };
      });
    } catch (err) {
      if (isMySqlDuplicateKeyError(err)) {
        const [existing] = await db
          .select()
          .from(creditTransactions)
          .where(eq(creditTransactions.idempotencyKey, idempotencyKey))
          .limit(1);

        if (!existing) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message:
              "Refund idempotency key collision detected but existing transaction could not be retrieved",
          });
        }

        if (
          existing.userId !== userId ||
          existing.walletId !== wallet.id ||
          existing.type !== "refund" ||
          existing.amount !== amount
        ) {
          throwIdempotencyCollision();
        }

        return { newBalance: existing.balanceAfter, alreadyRefunded: true };
      }
      throw err;
    }
  }

  // Non-idempotent path: preserve existing behaviour for callers that do not
  // supply an idempotency key.
  const newBalance = wallet.balance + amount;
  await db
    .update(creditWallets)
    .set({
      balance: newBalance,
      updatedAt: new Date(),
    })
    .where(eq(creditWallets.id, wallet.id));

  await db.insert(creditTransactions).values({
    userId,
    walletId: wallet.id,
    type: "refund",
    amount,
    balanceAfter: newBalance,
    description,
    metadata: metadata as any,
  });

  return { newBalance };
}

/**
 * Admin: Adjust a user's credit balance.
 */
export async function adminAdjustCredits({
  userId,
  amount,
  description,
  adminUserId,
}: {
  userId: number;
  amount: number;
  description: string;
  adminUserId: number;
}): Promise<{ newBalance: number }> {
  const db = getDb();
  const wallet = await ensureWallet(userId);

  const newBalance = Math.max(0, wallet.balance + amount);
  const newLifetimeEarned = amount > 0 ? wallet.lifetimeEarned + amount : wallet.lifetimeEarned;

  await db
    .update(creditWallets)
    .set({
      balance: newBalance,
      lifetimeEarned: newLifetimeEarned,
      updatedAt: new Date(),
    })
    .where(eq(creditWallets.id, wallet.id));

  await db.insert(creditTransactions).values({
    userId,
    walletId: wallet.id,
    type: "admin_adjustment",
    amount,
    balanceAfter: newBalance,
    description,
    metadata: { adminUserId },
  });

  return { newBalance };
}
