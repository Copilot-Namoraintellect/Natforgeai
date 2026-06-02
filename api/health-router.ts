import { z } from "zod";
import { createRouter, publicQuery, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { agentRuns, publishingQueue, aiUsage } from "@db/schema";
import { eq, sql, gte, desc } from "drizzle-orm";
import { isRedisConfigured, getRedisClient } from "./lib/redis";
import { getPublishingQueueStats, getPublishingWorker } from "./lib/queue/bullmq";
import { createAlert, listAlerts, acknowledgeAlert, resolveAlerts, getAlertSummary } from "./lib/alerts";

export const healthRouter = createRouter({
  getSystemHealth: publicQuery.query(async () => {
    const checks: Record<string, { status: "ok" | "error"; latencyMs: number; message?: string }> = {};

    // Database health
    try {
      const db = getDb();
      const start = Date.now();
      await db.execute("SELECT 1");
      checks.database = { status: "ok", latencyMs: Date.now() - start };
    } catch (err: any) {
      checks.database = { status: "error", latencyMs: 0, message: err.message };
    }

    // Redis health
    if (isRedisConfigured()) {
      try {
        const redis = getRedisClient();
        const start = Date.now();
        await redis.ping();
        checks.redis = { status: "ok", latencyMs: Date.now() - start };
      } catch (err: any) {
        checks.redis = { status: "error", latencyMs: 0, message: err.message };
      }
    } else {
      checks.redis = { status: "ok", latencyMs: 0, message: "Redis not configured (dev mode)" };
    }

    // Worker health (in-process check)
    if (isRedisConfigured()) {
      const worker = getPublishingWorker();
      if (!worker) {
        checks.worker = { status: "error", latencyMs: 0, message: "BullMQ worker not started in this process" };
        await createAlert({
          severity: "critical",
          category: "worker",
          message: "BullMQ publishing worker is not running",
        }).catch(() => {});
      } else {
        checks.worker = { status: "ok", latencyMs: 0 };
      }
    } else {
      checks.worker = { status: "ok", latencyMs: 0, message: "BullMQ not configured (dev mode)" };
    }

    // API health
    checks.api = { status: "ok", latencyMs: 0 };

    const allOk = Object.values(checks).every((c) => c.status === "ok");

    return {
      status: allOk ? "healthy" : "degraded",
      checks,
      timestamp: new Date().toISOString(),
    };
  }),

  getQueueHealth: adminQuery.query(async () => {
    const db = getDb();

    // Publishing queue stats from DB
    const [publishingStats] = await db
      .select({
        total: sql<number>`COUNT(*)`,
        published: sql<number>`SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END)`,
        failed: sql<number>`SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)`,
        pending: sql<number>`SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END)`,
        retrying: sql<number>`SUM(CASE WHEN status = 'retrying' THEN 1 ELSE 0 END)`,
        safetyBlocked: sql<number>`SUM(CASE WHEN status = 'safety_blocked' THEN 1 ELSE 0 END)`,
        pendingApproval: sql<number>`SUM(CASE WHEN status = 'pending_approval' THEN 1 ELSE 0 END)`,
      })
      .from(publishingQueue);

    // BullMQ stats
    let bullmqStats = null;
    if (isRedisConfigured()) {
      try {
        bullmqStats = await getPublishingQueueStats();
        // Queue backlog alert
        if (bullmqStats && bullmqStats.waiting > 100) {
          await createAlert({
            severity: "warning",
            category: "queue",
            message: `Publishing queue backlog exceeded threshold (${bullmqStats.waiting} waiting)`,
            details: { waiting: bullmqStats.waiting, active: bullmqStats.active, failed: bullmqStats.failed },
          }).catch(() => {});
        }
      } catch {
        // ignore
      }
    }

    return {
      publishing: publishingStats,
      bullmq: bullmqStats,
    };
  }),

  getAIUsageHealth: adminQuery.query(async () => {
    const db = getDb();
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // Monthly AI usage
    const [monthlyUsage] = await db
      .select({
        totalCalls: sql<number>`COUNT(*)`,
        totalTokens: sql<number>`COALESCE(SUM(${aiUsage.totalTokens}), 0)`,
        totalCredits: sql<number>`COALESCE(SUM(${aiUsage.creditsDeducted}), 0)`,
        actualCostMicro: sql<number>`COALESCE(SUM(${aiUsage.actualCostUsd}), 0)`,
        estimatedCostMicro: sql<number>`COALESCE(SUM(${aiUsage.estimatedCostUsd}), 0)`,
      })
      .from(aiUsage)
      .where(gte(aiUsage.createdAt, startOfMonth));

    // Daily AI usage
    const [dailyUsage] = await db
      .select({
        totalCalls: sql<number>`COUNT(*)`,
        totalTokens: sql<number>`COALESCE(SUM(${aiUsage.totalTokens}), 0)`,
        totalCredits: sql<number>`COALESCE(SUM(${aiUsage.creditsDeducted}), 0)`,
        actualCostMicro: sql<number>`COALESCE(SUM(${aiUsage.actualCostUsd}), 0)`,
      })
      .from(aiUsage)
      .where(gte(aiUsage.createdAt, startOfDay));

    // Agent success rate
    const [agentStats] = await db
      .select({
        total: sql<number>`COUNT(*)`,
        completed: sql<number>`SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)`,
        failed: sql<number>`SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)`,
      })
      .from(agentRuns)
      .where(gte(agentRuns.createdAt, startOfMonth));

    const totalAgents = agentStats.total ?? 0;
    const successRate = totalAgents > 0 ? ((agentStats.completed ?? 0) / totalAgents) * 100 : 0;

    return {
      monthly: {
        ...monthlyUsage,
        actualCostUsd: (monthlyUsage.actualCostMicro ?? 0) / 1_000_000,
        estimatedCostUsd: (monthlyUsage.estimatedCostMicro ?? 0) / 1_000_000,
      },
      daily: {
        ...dailyUsage,
        actualCostUsd: (dailyUsage.actualCostMicro ?? 0) / 1_000_000,
      },
      agentSuccessRate: Number(successRate.toFixed(1)),
      agentBreakdown: {
        total: totalAgents,
        completed: agentStats.completed ?? 0,
        failed: agentStats.failed ?? 0,
      },
    };
  }),

  getPublishingHealth: adminQuery.query(async () => {
    const db = getDb();
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const [monthlyStats] = await db
      .select({
        total: sql<number>`COUNT(*)`,
        published: sql<number>`SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END)`,
        failed: sql<number>`SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)`,
      })
      .from(publishingQueue)
      .where(gte(publishingQueue.createdAt, startOfMonth));

    const [dailyStats] = await db
      .select({
        total: sql<number>`COUNT(*)`,
        published: sql<number>`SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END)`,
        failed: sql<number>`SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)`,
      })
      .from(publishingQueue)
      .where(gte(publishingQueue.createdAt, startOfDay));

    const total = monthlyStats.total ?? 0;
    const successRate = total > 0 ? ((monthlyStats.published ?? 0) / total) * 100 : 0;

    // Recent failures
    const recentFailures = await db
      .select()
      .from(publishingQueue)
      .where(eq(publishingQueue.status, "failed"))
      .orderBy(desc(publishingQueue.createdAt))
      .limit(10);

    // BullMQ failed jobs count
    let bullmqFailed = 0;
    if (isRedisConfigured()) {
      try {
        const stats = await getPublishingQueueStats();
        bullmqFailed = stats.failed;
      } catch {
        // ignore
      }
    }

    return {
      monthly: {
        total,
        published: monthlyStats.published ?? 0,
        failed: monthlyStats.failed ?? 0,
        successRate: Number(successRate.toFixed(1)),
      },
      daily: {
        total: dailyStats.total ?? 0,
        published: dailyStats.published ?? 0,
        failed: dailyStats.failed ?? 0,
      },
      bullmqFailed,
      recentFailures,
    };
  }),

  // ─── Alert Management ───
  listAlerts: adminQuery
    .input(
      z
        .object({
          unresolvedOnly: z.boolean().optional(),
          category: z.string().optional(),
          limit: z.number().optional(),
        })
        .optional()
    )
    .query(async ({ input }) => {
      return listAlerts({
        unresolvedOnly: input?.unresolvedOnly,
        category: input?.category,
        limit: input?.limit ?? 100,
      });
    }),

  acknowledgeAlert: adminQuery
    .input(z.object({ alertId: z.number() }))
    .mutation(async ({ input }) => {
      await acknowledgeAlert(input.alertId);
      return { success: true };
    }),

  resolveAlertCategory: adminQuery
    .input(z.object({ category: z.string() }))
    .mutation(async ({ input }) => {
      const result = await resolveAlerts(input.category);
      return { success: true, resolved: result.resolved };
    }),

  getAlertSummary: adminQuery.query(async () => {
    return getAlertSummary();
  }),
});
