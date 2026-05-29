import { z } from "zod";
import { createRouter, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import {
  users,
  subscriptions,
  subscriptionTiers,
  payments,
  campaigns,
  leads,
  contentPosts,
  businesses,
} from "@db/schema";
import { eq, desc, sql, count } from "drizzle-orm";

export const adminRouter = createRouter({
  // ─── Dashboard Stats ───
  stats: adminQuery.query(async () => {
    const db = getDb();

    const [userCount] = await db
      .select({ count: count() })
      .from(users);
    const [campaignCount] = await db
      .select({ count: count() })
      .from(campaigns);
    const [leadCount] = await db
      .select({ count: count() })
      .from(leads);
    const [contentCount] = await db
      .select({ count: count() })
      .from(contentPosts);
    const [businessCount] = await db
      .select({ count: count() })
      .from(businesses);
    const [paymentTotal] = await db
      .select({ total: sql<number>`COALESCE(SUM(amount), 0)` })
      .from(payments)
      .where(eq(payments.status, "completed"));
    const [activeSubCount] = await db
      .select({ count: count() })
      .from(subscriptions)
      .where(eq(subscriptions.status, "active"));

    return {
      totalUsers: userCount.count,
      totalCampaigns: campaignCount.count,
      totalLeads: leadCount.count,
      totalContent: contentCount.count,
      totalBusinesses: businessCount.count,
      totalRevenue: paymentTotal.total || 0,
      activeSubscriptions: activeSubCount.count,
    };
  }),

  // ─── Revenue Over Time ───
  revenueByMonth: adminQuery.query(async () => {
    const db = getDb();
    const results = await db
      .select({
        month: sql<string>`DATE_FORMAT(createdAt, '%Y-%m')`,
        amount: sql<number>`SUM(amount)`,
        count: sql<number>`COUNT(*)`,
      })
      .from(payments)
      .where(eq(payments.status, "completed"))
      .groupBy(sql`DATE_FORMAT(createdAt, '%Y-%m')`)
      .orderBy(desc(sql`DATE_FORMAT(createdAt, '%Y-%m')`))
      .limit(12);
    return results;
  }),

  // ─── All Users ───
  users: adminQuery
    .input(
      z
        .object({
          search: z.string().optional(),
          role: z.string().optional(),
        })
        .optional()
    )
    .query(async ({ input }) => {
      const db = getDb();
      const allUsers = await db
        .select()
        .from(users)
        .orderBy(desc(users.createdAt));

      let filtered = allUsers;
      if (input?.search) {
        const s = input.search.toLowerCase();
        filtered = filtered.filter(
          (u) =>
            u.name?.toLowerCase().includes(s) ||
            u.email?.toLowerCase().includes(s) ||
            u.username?.toLowerCase().includes(s)
        );
      }
      if (input?.role) {
        filtered = filtered.filter((u) => u.role === input.role);
      }

      return filtered;
    }),

  // ─── Update User Role ───
  updateUserRole: adminQuery
    .input(z.object({ userId: z.number(), role: z.enum(["user", "admin"]) }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db
        .update(users)
        .set({ role: input.role })
        .where(eq(users.id, input.userId));
      return { success: true };
    }),

  // ─── All Payments ───
  payments: adminQuery
    .input(
      z
        .object({
          status: z.string().optional(),
        })
        .optional()
    )
    .query(async ({ input }) => {
      const db = getDb();
      const allPayments = await db
        .select()
        .from(payments)
        .orderBy(desc(payments.createdAt));

      if (input?.status) {
        return allPayments.filter((p) => p.status === input.status);
      }
      return allPayments;
    }),

  // ─── Update Payment Status ───
  updatePaymentStatus: adminQuery
    .input(
      z.object({
        paymentId: z.number(),
        status: z.enum(["pending", "completed", "failed", "refunded", "disputed"]),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      await db
        .update(payments)
        .set({
          status: input.status,
          paidAt: input.status === "completed" ? new Date() : undefined,
        })
        .where(eq(payments.id, input.paymentId));
      return { success: true };
    }),

  // ─── All Subscriptions ───
  subscriptions: adminQuery.query(async () => {
    const db = getDb();
    const subs = await db
      .select()
      .from(subscriptions)
      .orderBy(desc(subscriptions.createdAt));

    const enriched = await Promise.all(
      subs.map(async (sub) => {
        const [user] = await db
          .select()
          .from(users)
          .where(eq(users.id, sub.userId))
          .limit(1);
        const [tier] = await db
          .select()
          .from(subscriptionTiers)
          .where(eq(subscriptionTiers.id, sub.tierId))
          .limit(1);
        return { ...sub, user, tier };
      })
    );

    return enriched;
  }),

  // ─── Subscription by Tier ───
  subscriptionsByTier: adminQuery.query(async () => {
    const db = getDb();
    const results = await db
      .select({
        tierId: subscriptions.tierId,
        count: sql<number>`COUNT(*)`,
      })
      .from(subscriptions)
      .where(eq(subscriptions.status, "active"))
      .groupBy(subscriptions.tierId);

    const enriched = await Promise.all(
      results.map(async (r) => {
        const [tier] = await db
          .select()
          .from(subscriptionTiers)
          .where(eq(subscriptionTiers.id, r.tierId))
          .limit(1);
        return { ...r, tierName: tier?.name || "Unknown", tierSlug: tier?.slug || "" };
      })
    );

    return enriched;
  }),

  // ─── Record Manual Payment ───
  recordPayment: adminQuery
    .input(
      z.object({
        userId: z.number(),
        amount: z.number(), // in cents
        currency: z.string().default("USD"),
        description: z.string().optional(),
        paymentMethod: z.enum(["stripe", "paypal", "bank_transfer", "manual", "crypto"]),
        paymentReference: z.string().optional(),
        subscriptionId: z.number().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.insert(payments).values({
        userId: input.userId,
        subscriptionId: input.subscriptionId,
        amount: input.amount,
        currency: input.currency,
        status: "completed",
        paymentMethod: input.paymentMethod,
        paymentReference: input.paymentReference,
        description: input.description,
        paidAt: new Date(),
      });
      return { success: true };
    }),
});
