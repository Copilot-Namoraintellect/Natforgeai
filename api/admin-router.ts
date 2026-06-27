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
  schedules,
  automations,
  analytics,
  generatedImages,
  bankingDetails,
  userUsage,
  publishingQueue,
  socialIntegrations,
} from "@db/schema";
import { eq, desc, sql, count, and, isNotNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";

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

  // ─── Delete User (and all related data) ───
  deleteUser: adminQuery
    .input(z.object({ userId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const targetId = input.userId;
      const adminId = ctx.user.id;

      // Prevent self-deletion
      if (targetId === adminId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You cannot delete your own admin account.",
        });
      }

      // Get user info before deletion for logging
      const [targetUser] = await db
        .select()
        .from(users)
        .where(eq(users.id, targetId))
        .limit(1);

      if (!targetUser) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "User not found.",
        });
      }

      // Delete all related data
      await db.delete(campaigns).where(eq(campaigns.userId, targetId));
      await db.delete(contentPosts).where(eq(contentPosts.userId, targetId));
      await db.delete(leads).where(eq(leads.userId, targetId));
      await db.delete(schedules).where(eq(schedules.userId, targetId));
      await db.delete(automations).where(eq(automations.userId, targetId));
      await db.delete(analytics).where(eq(analytics.userId, targetId));
      await db.delete(generatedImages).where(eq(generatedImages.userId, targetId));
      await db.delete(businesses).where(eq(businesses.userId, targetId));
      await db.delete(subscriptions).where(eq(subscriptions.userId, targetId));
      await db.delete(payments).where(eq(payments.userId, targetId));
      await db.delete(bankingDetails).where(eq(bankingDetails.adminUserId, targetId));

      // Delete user usage record
      await db.delete(userUsage).where(eq(userUsage.userId, targetId));

      // Finally delete the user
      await db.delete(users).where(eq(users.id, targetId));

      return {
        success: true,
        deletedUser: {
          id: targetUser.id,
          name: targetUser.name,
          email: targetUser.email,
          username: targetUser.username,
        },
      };
    }),

  // ─── Create User (admin-only) ───
  createUser: adminQuery
    .input(
      z.object({
        name: z.string().min(1),
        username: z.string().min(3),
        email: z.string().email(),
        password: z.string().min(6),
        role: z.enum(["user", "admin"]).default("user"),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();

      // Check for existing username or email
      const [existing] = await db
        .select()
        .from(users)
        .where(
          and(
            eq(users.email, input.email)
          )
        )
        .limit(1);

      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "A user with this email already exists.",
        });
      }

      const bcrypt = await import("bcryptjs");
      const passwordHash = await bcrypt.hash(input.password, 12);

      const [result] = await db.insert(users).values({
        username: input.username,
        email: input.email,
        passwordHash,
        name: input.name,
        authType: "local",
        role: input.role,
        lastSignInAt: new Date(),
      });

      const userId = Number(result.insertId);

      // Auto-assign free tier
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
      }

      // Create usage tracking
      await db.insert(userUsage).values({
        userId,
        campaignsCreated: 0,
        successfulResults: 0,
      });

      return {
        success: true,
        user: {
          id: userId,
          name: input.name,
          email: input.email,
          username: input.username,
          role: input.role,
        },
      };
    }),

  // ─── Production Diagnostics ───
  diagnostics: adminQuery.query(async () => {
    const db = getDb();

    // DB connectivity + latency
    const dbStart = Date.now();
    let dbConnected = false;
    let dbLatencyMs = 0;
    try {
      await db.execute(sql`SELECT 1`);
      dbConnected = true;
    } catch (err: any) {
      console.error("[Admin Diagnostics] DB ping failed:", err.message);
    } finally {
      dbLatencyMs = Date.now() - dbStart;
    }

    // Integration status counts by platform
    const integrationRows = await db
      .select({ platform: socialIntegrations.platform, status: socialIntegrations.status })
      .from(socialIntegrations);

    const integrations: Record<string, Record<string, number>> = {};
    for (const row of integrationRows) {
      const platform = row.platform || "unknown";
      const status = row.status || "unknown";
      integrations[platform] = integrations[platform] || {};
      integrations[platform][status] = (integrations[platform][status] || 0) + 1;
    }

    // Publishing queue status counts
    const queueRows = await db
      .select({ status: publishingQueue.status, count: count() })
      .from(publishingQueue)
      .groupBy(publishingQueue.status);

    const queueStatus: Record<string, number> = {};
    for (const row of queueRows) {
      queueStatus[row.status || "unknown"] = row.count;
    }

    // Latest publish errors
    const latestPublishErrors = await db
      .select({
        id: publishingQueue.id,
        campaignId: publishingQueue.campaignId,
        platform: publishingQueue.platform,
        status: publishingQueue.status,
        lastError: publishingQueue.lastError,
        createdAt: publishingQueue.createdAt,
      })
      .from(publishingQueue)
      .where(isNotNull(publishingQueue.lastError))
      .orderBy(desc(publishingQueue.createdAt))
      .limit(20);

    return {
      db: { connected: dbConnected, latencyMs: dbLatencyMs },
      integrations,
      queue: queueStatus,
      latestPublishErrors,
    };
  }),
});
