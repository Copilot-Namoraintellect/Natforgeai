import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { subscriptions, subscriptionTiers, payments } from "@db/schema";
import { eq, and, desc } from "drizzle-orm";
import { getUserTier, getUserUsage, ensureFreeSubscription } from "./lib/subscription";
import { allocateMonthlyCredits } from "./lib/billing/credit-engine";
import { env } from "./lib/env";

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

  // Create checkout session for paid tiers
  createCheckoutSession: authedQuery
    .input(z.object({ tierId: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const [tier] = await db
        .select()
        .from(subscriptionTiers)
        .where(eq(subscriptionTiers.id, input.tierId))
        .limit(1);

      if (!tier) throw new TRPCError({ code: "NOT_FOUND", message: "Tier not found" });
      if (tier.priceUsd === 0) {
        // Free tier: subscribe directly
        return { url: null, free: true };
      }

      // Check if payment provider is configured
      const stripeKey = env.stripeSecretKey;
      if (!stripeKey) {
        throw new TRPCError({
          code: "NOT_IMPLEMENTED",
          message: "Payment provider is not configured. Please contact support to upgrade.",
        });
      }

      // Stub: In production, create Stripe Checkout Session here
      // const session = await stripe.checkout.sessions.create({...})
      // For now, return a placeholder that triggers the payment setup dialog
      throw new TRPCError({
        code: "NOT_IMPLEMENTED",
        message: "Online checkout is being configured. Please contact support to complete your upgrade.",
      });
    }),

  // Subscribe to a tier
  subscribe: authedQuery
    .input(z.object({ tierId: z.number(), paymentMethod: z.string().optional(), confirmedByWebhook: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();

      // Get tier details
      const [tier] = await db
        .select()
        .from(subscriptionTiers)
        .where(eq(subscriptionTiers.id, input.tierId))
        .limit(1);

      if (!tier) throw new Error("Tier not found");

      // Block paid tier subscriptions unless confirmed by webhook or explicitly allowed
      if (tier.priceUsd > 0 && !input.confirmedByWebhook) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Paid tier changes must be confirmed by payment provider. Use createCheckoutSession instead.",
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
        status: input.confirmedByWebhook ? "active" : "active",
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        paymentMethod: (input.paymentMethod as any) || "manual",
      });

      const subId = Number(result.insertId);

      // Record payment if this was a webhook-confirmed paid tier
      if (tier.priceUsd > 0 && input.confirmedByWebhook) {
        await db.insert(payments).values({
          userId: ctx.user.id,
          subscriptionId: subId,
          amount: tier.priceUsd,
          currency: "USD",
          status: "completed",
          paymentMethod: "stripe",
          description: `Subscription to ${tier.name}`,
          paidAt: new Date(),
        });
      }

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
