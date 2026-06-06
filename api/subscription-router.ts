import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { subscriptions, subscriptionTiers } from "@db/schema";
import { eq, and, desc } from "drizzle-orm";
import { getUserTier, getUserUsage, ensureFreeSubscription } from "./lib/subscription";
import { allocateMonthlyCredits } from "./lib/billing/credit-engine";

export const subscriptionRouter = createRouter({
  // List all available tiers
  tiers: authedQuery.query(async () => {
    const db = getDb();
    return db
      .select()
      .from(subscriptionTiers)
      .where(eq(subscriptionTiers.isActive, true))
      .orderBy(subscriptionTiers.displayOrder);
  }),

  // Get user's current subscription
  mySubscription: authedQuery.query(async ({ ctx }) => {
    const db = getDb();
    const [sub] = await db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.userId, ctx.user.id),
          eq(subscriptions.status, "active")
        )
      )
      .orderBy(desc(subscriptions.createdAt))
      .limit(1);

    if (!sub) return null;

    const [tier] = await db
      .select()
      .from(subscriptionTiers)
      .where(eq(subscriptionTiers.id, sub.tierId))
      .limit(1);

    return { ...sub, tier };
  }),

  // Subscribe to a tier
  subscribe: authedQuery
    .input(z.object({ tierId: z.number(), paymentMethod: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();

      // Get tier details
      const [tier] = await db
        .select()
        .from(subscriptionTiers)
        .where(eq(subscriptionTiers.id, input.tierId))
        .limit(1);

      if (!tier) throw new Error("Tier not found");

      // Block paid tier subscriptions until payment flow is implemented
      if (tier.priceUsd > 0) {
        throw new TRPCError({
          code: "NOT_IMPLEMENTED",
          message: "Online subscription payments are not enabled yet. Please contact support to upgrade.",
        });
      }

      // Cancel any existing active subscription
      await db
        .update(subscriptions)
        .set({ status: "cancelled", cancelledAt: new Date() })
        .where(
          and(
            eq(subscriptions.userId, ctx.user.id),
            eq(subscriptions.status, "active")
          )
        );

      // Calculate period end
      const now = new Date();
      const periodEnd = new Date(now);
      if (tier.billingCycle === "yearly") {
        periodEnd.setFullYear(periodEnd.getFullYear() + 1);
      } else {
        periodEnd.setMonth(periodEnd.getMonth() + 1);
      }

      // Create new subscription
      const [result] = await db.insert(subscriptions).values({
        userId: ctx.user.id,
        tierId: input.tierId,
        status: "active",
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        paymentMethod: (input.paymentMethod as any) || "manual",
      });

      const subId = Number(result.insertId);

      // Allocate monthly credits for the tier
      if (tier.monthlyCredits > 0) {
        await allocateMonthlyCredits(ctx.user.id);
      }

      return { id: subId, tier, periodEnd };
    }),

  // Cancel subscription
  cancel: authedQuery.mutation(async ({ ctx }) => {
    const db = getDb();
    await db
      .update(subscriptions)
      .set({ status: "cancelled", cancelledAt: new Date() })
      .where(
        and(
          eq(subscriptions.userId, ctx.user.id),
          eq(subscriptions.status, "active")
        )
      );
    return { success: true };
  }),

  // Check feature access
  checkFeature: authedQuery
    .input(z.object({ feature: z.string() }))
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const [sub] = await db
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.userId, ctx.user.id),
            eq(subscriptions.status, "active")
          )
        )
        .orderBy(desc(subscriptions.createdAt))
        .limit(1);

      if (!sub) return { allowed: false, reason: "No active subscription" };

      const [tier] = await db
        .select()
        .from(subscriptionTiers)
        .where(eq(subscriptionTiers.id, sub.tierId))
        .limit(1);

      if (!tier) return { allowed: false, reason: "Tier not found" };

      const featureMap: Record<string, boolean> = {
        aiGeneration: tier.aiGeneration ?? false,
        analytics: tier.analytics ?? false,
      };

      const allowed = featureMap[input.feature] ?? true;
      return { allowed, tierName: tier.name, tierSlug: tier.slug };
    }),

  // Get user's current usage vs limits
  myUsage: authedQuery.query(async ({ ctx }) => {
    await ensureFreeSubscription(ctx.user.id);
    const tier = await getUserTier(ctx.user.id);
    const usage = await getUserUsage(ctx.user.id);

    return {
      tier: {
        name: tier?.name ?? "Free",
        slug: tier?.slug ?? "free",
        maxCampaigns: tier?.maxCampaigns ?? 2,
        maxResults: tier?.maxResults ?? 5,
        maxLeads: tier?.maxLeads ?? 20,
        maxContent: tier?.maxContent ?? 10,
        maxAutomations: tier?.maxAutomations ?? 0,
        aiGeneration: tier?.aiGeneration ?? false,
        analytics: tier?.analytics ?? false,
      },
      usage: {
        campaignsCreated: usage.campaignsCreated,
        successfulResults: usage.successfulResults,
      },
    };
  }),
});
