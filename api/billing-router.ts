import { z } from "zod";
import { createRouter, authedQuery, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { aiUsage, creditWallets, creditTransactions, users } from "@db/schema";
import { eq, and, gte, lte, sql, desc } from "drizzle-orm";
import {
  getWalletWithStats,
  adminAdjustCredits,
  getCreditsSpentThisMonth,
} from "./lib/billing/credit-engine";
import { formatMicroCents, creditsToUsd } from "./lib/billing/cost-tracker";

export const billingRouter = createRouter({
  // ─── User-facing endpoints ───

  myWallet: authedQuery.query(async ({ ctx }) => {
    return getWalletWithStats(ctx.user.id);
  }),

  myTransactions: authedQuery
    .input(
      z
        .object({
          limit: z.number().min(1).max(100).default(50),
          type: z
            .enum([
              "subscription_allocation",
              "purchase",
              "agent_deduction",
              "publishing_deduction",
              "image_generation",
              "video_generation",
              "refund",
              "admin_adjustment",
              "rollover",
            ])
            .optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const results = await db
        .select()
        .from(creditTransactions)
        .where(eq(creditTransactions.userId, ctx.user.id))
        .orderBy(desc(creditTransactions.createdAt))
        .limit(input?.limit ?? 50);

      if (input?.type) {
        return results.filter((t) => t.type === input.type);
      }
      return results;
    }),

  myUsage: authedQuery
    .input(
      z
        .object({
          campaignId: z.number().optional(),
          agentType: z
            .enum([
              "strategy",
              "creative",
              "audience",
              "distribution",
              "engagement",
              "sales",
              "optimisation",
              "safety_check",
              "image_generation",
              "video_generation",
            ])
            .optional(),
          startDate: z.string().optional(),
          endDate: z.string().optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const db = getDb();
      let query = db
        .select()
        .from(aiUsage)
        .where(eq(aiUsage.userId, ctx.user.id))
        .orderBy(desc(aiUsage.createdAt))
        .limit(100);

      const results = await query;

      return results.filter((u) => {
        if (input?.campaignId && u.campaignId !== input.campaignId) return false;
        if (input?.agentType && u.agentType !== input.agentType) return false;
        if (input?.startDate && u.createdAt && new Date(u.createdAt) < new Date(input.startDate))
          return false;
        if (input?.endDate && u.createdAt && new Date(u.createdAt) > new Date(input.endDate))
          return false;
        return true;
      });
    }),

  myUsageSummary: authedQuery.query(async ({ ctx }) => {
    const db = getDb();
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [monthlyUsage] = await db
      .select({
        totalCalls: sql<number>`COUNT(*)`,
        totalTokens: sql<number>`COALESCE(SUM(${aiUsage.totalTokens}), 0)`,
        totalCredits: sql<number>`COALESCE(SUM(${aiUsage.creditsDeducted}), 0)`,
        actualCostMicro: sql<number>`COALESCE(SUM(${aiUsage.actualCostUsd}), 0)`,
        estimatedCostMicro: sql<number>`COALESCE(SUM(${aiUsage.estimatedCostUsd}), 0)`,
      })
      .from(aiUsage)
      .where(
        and(
          eq(aiUsage.userId, ctx.user.id),
          gte(aiUsage.createdAt, startOfMonth)
        )
      );

    const [allTimeUsage] = await db
      .select({
        totalCalls: sql<number>`COUNT(*)`,
        totalTokens: sql<number>`COALESCE(SUM(${aiUsage.totalTokens}), 0)`,
        totalCredits: sql<number>`COALESCE(SUM(${aiUsage.creditsDeducted}), 0)`,
        actualCostMicro: sql<number>`COALESCE(SUM(${aiUsage.actualCostUsd}), 0)`,
        estimatedCostMicro: sql<number>`COALESCE(SUM(${aiUsage.estimatedCostUsd}), 0)`,
      })
      .from(aiUsage)
      .where(eq(aiUsage.userId, ctx.user.id));

    const spentThisMonth = await getCreditsSpentThisMonth(ctx.user.id);

    return {
      monthly: {
        ...monthlyUsage,
        actualCostUsd: formatMicroCents(monthlyUsage.actualCostMicro),
        estimatedCostUsd: formatMicroCents(monthlyUsage.estimatedCostMicro),
      },
      allTime: {
        ...allTimeUsage,
        actualCostUsd: formatMicroCents(allTimeUsage.actualCostMicro),
        estimatedCostUsd: formatMicroCents(allTimeUsage.estimatedCostMicro),
      },
      spentThisMonth,
    };
  }),

  // ─── Admin endpoints ───

  adminListWallets: adminQuery
    .input(
      z
        .object({
          search: z.string().optional(),
          limit: z.number().min(1).max(200).default(50),
          offset: z.number().min(0).default(0),
        })
        .optional()
    )
    .query(async ({ input }) => {
      const db = getDb();
      const limit = input?.limit ?? 50;
      const offset = input?.offset ?? 0;

      const wallets = await db
        .select()
        .from(creditWallets)
        .orderBy(desc(creditWallets.updatedAt))
        .limit(limit)
        .offset(offset);

      // Enrich with user names
      const enriched = await Promise.all(
        wallets.map(async (w) => {
          const [user] = await db
            .select({ name: users.name, email: users.email })
            .from(users)
            .where(eq(users.id, w.userId))
            .limit(1);
          return { ...w, userName: user?.name, userEmail: user?.email };
        })
      );

      return enriched;
    }),

  adminAdjustCredits: adminQuery
    .input(
      z.object({
        userId: z.number(),
        amount: z.number(), // positive = add, negative = remove
        description: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const result = await adminAdjustCredits({
        userId: input.userId,
        amount: input.amount,
        description: input.description,
        adminUserId: ctx.user.id,
      });
      return { success: true, newBalance: result.newBalance };
    }),

  adminUsageReport: adminQuery
    .input(
      z
        .object({
          startDate: z.string().optional(),
          endDate: z.string().optional(),
          groupBy: z.enum(["agentType", "model", "user", "day"]).default("agentType"),
        })
        .optional()
    )
    .query(async ({ input }) => {
      const db = getDb();
      const startDate = input?.startDate
        ? new Date(input.startDate)
        : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
      const endDate = input?.endDate ? new Date(input.endDate) : new Date();

      const results = await db
        .select()
        .from(aiUsage)
        .where(and(gte(aiUsage.createdAt, startDate), lte(aiUsage.createdAt, endDate)))
        .orderBy(desc(aiUsage.createdAt))
        .limit(5000);

      // Aggregate by groupBy
      const grouped: Record<string, { count: number; tokens: number; credits: number; actualCostMicro: number; estimatedCostMicro: number }> = {};

      for (const row of results) {
        const key =
          input?.groupBy === "agentType"
            ? row.agentType
            : input?.groupBy === "model"
            ? row.model
            : input?.groupBy === "user"
            ? String(row.userId)
            : row.createdAt
            ? new Date(row.createdAt).toISOString().split("T")[0]
            : "unknown";

        if (!grouped[key]) {
          grouped[key] = { count: 0, tokens: 0, credits: 0, actualCostMicro: 0, estimatedCostMicro: 0 };
        }
        grouped[key].count++;
        grouped[key].tokens += row.totalTokens ?? 0;
        grouped[key].credits += row.creditsDeducted ?? 0;
        grouped[key].actualCostMicro += row.actualCostUsd ?? 0;
        grouped[key].estimatedCostMicro += row.estimatedCostUsd ?? 0;
      }

      return Object.entries(grouped).map(([key, stats]) => ({
        key,
        ...stats,
        actualCostUsd: formatMicroCents(stats.actualCostMicro),
        estimatedCostUsd: formatMicroCents(stats.estimatedCostMicro),
      }));
    }),

  adminProfitability: adminQuery.query(async () => {
    const db = getDb();

    const [usageAgg] = await db
      .select({
        totalCalls: sql<number>`COUNT(*)`,
        totalTokens: sql<number>`COALESCE(SUM(${aiUsage.totalTokens}), 0)`,
        totalCreditsIssued: sql<number>`COALESCE(SUM(${aiUsage.creditsDeducted}), 0)`,
        actualCostMicro: sql<number>`COALESCE(SUM(${aiUsage.actualCostUsd}), 0)`,
        estimatedCostMicro: sql<number>`COALESCE(SUM(${aiUsage.estimatedCostUsd}), 0)`,
      })
      .from(aiUsage);

    const [walletAgg] = await db
      .select({
        totalUsers: sql<number>`COUNT(DISTINCT ${creditWallets.userId})`,
        totalBalance: sql<number>`COALESCE(SUM(${creditWallets.balance}), 0)`,
        totalEarned: sql<number>`COALESCE(SUM(${creditWallets.lifetimeEarned}), 0)`,
        totalSpent: sql<number>`COALESCE(SUM(${creditWallets.lifetimeSpent}), 0)`,
      })
      .from(creditWallets);

    const actualCostUsd = (usageAgg.actualCostMicro ?? 0) / 1_000_000;
    const totalCreditsIssued = usageAgg.totalCreditsIssued ?? 0;
    const creditValueUsd = creditsToUsd(totalCreditsIssued);

    return {
      usage: {
        totalCalls: usageAgg.totalCalls ?? 0,
        totalTokens: usageAgg.totalTokens ?? 0,
        totalCreditsIssued,
        actualCostUsd: formatMicroCents(usageAgg.actualCostMicro ?? 0),
        estimatedCostUsd: formatMicroCents(usageAgg.estimatedCostMicro ?? 0),
      },
      wallets: {
        totalUsers: walletAgg.totalUsers ?? 0,
        totalBalance: walletAgg.totalBalance ?? 0,
        totalEarned: walletAgg.totalEarned ?? 0,
        totalSpent: walletAgg.totalSpent ?? 0,
      },
      profitability: {
        actualCostUsd,
        creditValueUsd,
        marginUsd: creditValueUsd - actualCostUsd,
        marginPercent: creditValueUsd > 0 ? ((creditValueUsd - actualCostUsd) / creditValueUsd) * 100 : 0,
      },
    };
  }),
});
