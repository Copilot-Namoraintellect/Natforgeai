import { getDb } from "../queries/connection";
import { subscriptions, subscriptionTiers, userUsage, campaigns, leads } from "@db/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { allocateMonthlyCredits } from "./billing/credit-engine";

export async function getUserTier(userId: number) {
  const db = getDb();

  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(
      and(eq(subscriptions.userId, userId), eq(subscriptions.status, "active"))
    )
    .orderBy(desc(subscriptions.createdAt))
    .limit(1);

  if (sub) {
    const [tier] = await db
      .select()
      .from(subscriptionTiers)
      .where(eq(subscriptionTiers.id, sub.tierId))
      .limit(1);
    return tier;
  }

  // Return free tier as default
  const [freeTier] = await db
    .select()
    .from(subscriptionTiers)
    .where(eq(subscriptionTiers.slug, "free"))
    .limit(1);

  return freeTier;
}

export async function getUserUsage(userId: number) {
  const db = getDb();
  const [usage] = await db
    .select()
    .from(userUsage)
    .where(eq(userUsage.userId, userId))
    .limit(1);

  if (usage) return usage;

  // First time - count existing campaigns and results from the database
  const [campaignCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(campaigns)
    .where(eq(campaigns.userId, userId));

  const [wonLeadsCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(leads)
    .where(
      and(
        eq(leads.userId, userId),
        eq(leads.status, "won"),
        sql`${leads.campaignId} IS NOT NULL`
      )
    );

  const [completedCampaignsCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(campaigns)
    .where(and(eq(campaigns.userId, userId), eq(campaigns.status, "completed")));

  const initialCampaigns = Number(campaignCount?.count ?? 0);
  const initialResults =
    Number(wonLeadsCount?.count ?? 0) + Number(completedCampaignsCount?.count ?? 0);

  const [result] = await db.insert(userUsage).values({
    userId,
    campaignsCreated: initialCampaigns,
    successfulResults: initialResults,
  });

  return {
    id: Number(result.insertId),
    userId,
    campaignsCreated: initialCampaigns,
    successfulResults: initialResults,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

export async function ensureFreeSubscription(userId: number) {
  const db = getDb();

  // Check if user already has any subscription
  const [existing] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .limit(1);

  if (!existing) {
    const [freeTier] = await db
      .select()
      .from(subscriptionTiers)
      .where(eq(subscriptionTiers.slug, "free"))
      .limit(1);

    if (freeTier) {
      const now = new Date();
      const periodEnd = new Date(now);
      periodEnd.setMonth(periodEnd.getMonth() + 1);

      await db.insert(subscriptions).values({
        userId,
        tierId: freeTier.id,
        status: "active",
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        paymentMethod: "manual",
      });

      // Allocate free tier credits (once-off per month)
      await allocateMonthlyCredits(userId);
    }
  }

  // Ensure user usage row exists
  const [usage] = await db
    .select()
    .from(userUsage)
    .where(eq(userUsage.userId, userId))
    .limit(1);

  if (!usage) {
    await db.insert(userUsage).values({
      userId,
      campaignsCreated: 0,
      successfulResults: 0,
    });
  }
}

export async function incrementCampaignUsage(userId: number) {
  const db = getDb();
  const usage = await getUserUsage(userId);
  const current = (usage.campaignsCreated ?? 0) + 1;

  await db
    .update(userUsage)
    .set({ campaignsCreated: current })
    .where(eq(userUsage.userId, userId));

  return current;
}

export async function incrementResultUsage(userId: number) {
  const db = getDb();
  const usage = await getUserUsage(userId);
  const current = (usage.successfulResults ?? 0) + 1;

  await db
    .update(userUsage)
    .set({ successfulResults: current })
    .where(eq(userUsage.userId, userId));

  return current;
}

export async function checkLimit(
  userId: number,
  type: "campaign" | "result"
): Promise<{ allowed: boolean; reason?: string; current: number; limit: number }> {
  const tier = await getUserTier(userId);
  const usage = await getUserUsage(userId);

  if (type === "campaign") {
    const limit = tier?.maxCampaigns ?? 2;
    const current = usage.campaignsCreated ?? 0;
    if (current >= limit) {
      return {
        allowed: false,
        reason: `You've reached your limit of ${limit} campaigns. Upgrade your plan to create more.`,
        current,
        limit,
      };
    }
    return { allowed: true, current, limit };
  }

  if (type === "result") {
    const limit = tier?.maxResults ?? 5;
    const current = usage.successfulResults ?? 0;
    if (current >= limit) {
      return {
        allowed: false,
        reason: `You've reached your limit of ${limit} successful results. Upgrade your plan to record more.`,
        current,
        limit,
      };
    }
    return { allowed: true, current, limit };
  }

  return { allowed: true, current: 0, limit: 0 };
}
