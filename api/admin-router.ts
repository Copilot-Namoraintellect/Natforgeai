import { z } from "zod";
import { createRouter, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { env } from "./lib/env";
import { logInfo, logError } from "./lib/logger";
import { aggregateIntegrationStatuses } from "./lib/admin/integration-status";
import {
  runDiagnosticAuthority,
  type DiagnosticProductionMode,
} from "./lib/creative/message-approval/diagnostic-harness";
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
  queueTerminalFailures,
  queueReplayRequests,
} from "@db/schema";
import {
  requestTerminalFailureReplay,
  TerminalReplayInvalidTransitionError,
  TerminalReplayKeyConflictError,
  TerminalReplayRequestNotFoundError,
  TerminalReplayTargetNotFoundError,
} from "./lib/queue/terminal-replay";
import {
  executePublishingTerminalReplay,
  PublishingReplayValidationError,
} from "./lib/queue/terminal-replay-executor";
import {
  executeContentTerminalReplay,
  ContentReplayValidationError,
} from "./lib/queue/terminal-content-replay-executor";
import { reconcileTerminalReplayBatch } from "./lib/queue/terminal-replay-reconciliation-batch";
import {
  extractAdminRequestId,
  recordAdminMutationAudit,
} from "./lib/governance/admin-audit";
import { projectCampaignLifecycle } from "./lib/governance/lifecycle-projection";
import { eq, desc, sql, count, and, isNotNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";

function normalizeProductionMode(raw: string | undefined): DiagnosticProductionMode {
  const value = String(raw ?? "off").toLowerCase().trim();
  if (value === "off" || value === "shadow" || value === "canary" || value === "active") {
    return value as DiagnosticProductionMode;
  }
  return "unknown";
}

// ─── WBS9D4B: Terminal replay control plane ───
// Control-plane adapter ONLY: all replay authority (D1 request, D2 execution,
// D3 reconciliation) lives in the queue modules. The router reuses the
// existing authenticated admin surface and adds a default-OFF kill switch
// for mutating operations.

function isTerminalReplayAdminEnabled(): boolean {
  return process.env.TERMINAL_REPLAY_ADMIN_ENABLED === "true";
}

function requireTerminalReplayAdminEnabled(): void {
  if (!isTerminalReplayAdminEnabled()) {
    throw new TRPCError({
      code: "SERVICE_UNAVAILABLE",
      message: "Terminal replay administration is disabled.",
    });
  }
}

/**
 * Bounded error mapping for the replay control plane: never leak raw
 * exception text to the client; only known error authorities contribute a
 * classification. Structured identifiers only in logs.
 */
function mapTerminalReplayError(
  err: unknown,
  adminUserId: number,
  identifiers: { terminalFailureId?: number; replayRequestId?: number }
): TRPCError {
  const errorCode = (err as { code?: unknown } | null | undefined)?.code;
  logError("[Admin] Terminal replay operation failed", {
    event: "terminal_replay_error",
    adminUserId,
    terminalFailureId: identifiers.terminalFailureId ?? null,
    replayRequestId: identifiers.replayRequestId ?? null,
    errorCode: typeof errorCode === "string" ? errorCode : "UNEXPECTED",
  });

  if (err instanceof TerminalReplayTargetNotFoundError) {
    return new TRPCError({ code: "NOT_FOUND", message: "Terminal failure not found." });
  }
  if (err instanceof TerminalReplayRequestNotFoundError) {
    return new TRPCError({ code: "NOT_FOUND", message: "Replay request not found." });
  }
  if (err instanceof TerminalReplayKeyConflictError) {
    return new TRPCError({ code: "CONFLICT", message: "Replay key conflict." });
  }
  if (err instanceof TerminalReplayInvalidTransitionError) {
    return new TRPCError({ code: "CONFLICT", message: "Terminal replay conflict." });
  }
  if (err instanceof PublishingReplayValidationError) {
    if (err.code === "operator_mismatch") {
      return new TRPCError({ code: "FORBIDDEN", message: "Terminal replay operation forbidden." });
    }
    return new TRPCError({ code: "BAD_REQUEST", message: "Terminal replay operation failed." });
  }
  if (err instanceof ContentReplayValidationError) {
    if (err.code === "operator_mismatch") {
      return new TRPCError({ code: "FORBIDDEN", message: "Terminal replay operation forbidden." });
    }
    return new TRPCError({ code: "BAD_REQUEST", message: "Terminal replay operation failed." });
  }
  if (err instanceof TRPCError) {
    const message =
      err.code === "FORBIDDEN"
        ? "Terminal replay operation forbidden."
        : err.code === "NOT_FOUND"
          ? "Replay resource not found."
          : err.code === "CONFLICT"
            ? "Terminal replay conflict."
            : err.code === "BAD_REQUEST"
              ? "Terminal replay operation failed."
              : "Terminal replay operation failed.";
    return new TRPCError({ code: err.code, message });
  }
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "Terminal replay operation failed.",
  });
}

/**
 * Best-effort audit for a privileged operator mutation whose governed step
 * FAILED. The failure audit never masks the original error: an audit
 * failure here is logged and swallowed so the caller still receives the
 * authoritative mapped error.
 */
async function recordFailedAdminMutationAudit(
  ctx: { req: unknown },
  actorUserId: number,
  action:
    | "admin.terminal_replay_requested"
    | "admin.terminal_replay_executed"
    | "admin.terminal_replay_reconciled"
    | "admin.diagnostic_authority_executed",
  targetType: "terminal_replay" | "terminal_replay_batch" | "diagnostic_harness",
  metadata: Record<string, unknown>
): Promise<void> {
  try {
    await recordAdminMutationAudit({
      actorUserId,
      action,
      targetType,
      outcome: "failed",
      occurredAt: new Date(),
      metadata,
      requestId: extractAdminRequestId(ctx.req),
    });
  } catch (auditErr) {
    const errorCode =
      (auditErr as { code?: unknown } | null | undefined)?.code;
    logError("[Admin] Failed to record admin mutation audit event", {
      event: "admin_audit_record_failed",
      adminUserId: actorUserId,
      action,
      errorCode: typeof errorCode === "string" ? errorCode : "UNEXPECTED",
    });
  }
}

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
      // Explicit safe projection: credential material (password hashes) and
      // provider identity linkage fields never leave the server.
      const allUsers = await db
        .select({
          id: users.id,
          username: users.username,
          email: users.email,
          name: users.name,
          role: users.role,
          authType: users.authType,
          lastSignInAt: users.lastSignInAt,
          createdAt: users.createdAt,
        })
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
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      // The role mutation and its canonical audit evidence commit or roll
      // back as one unit: an audit failure can never leave a silent
      // privilege change.
      await db.transaction(async (tx) => {
        const [before] = await tx
          .select({ role: users.role })
          .from(users)
          .where(eq(users.id, input.userId))
          .limit(1);
        await tx.update(users).set({ role: input.role }).where(eq(users.id, input.userId));
        await recordAdminMutationAudit({
          actorUserId: ctx.user.id,
          action: "admin.user_role_updated",
          targetType: "user",
          targetId: input.userId,
          occurredAt: new Date(),
          metadata: { beforeRole: before?.role ?? null, afterRole: input.role },
          requestId: extractAdminRequestId(ctx.req),
          executor: tx,
        });
      });
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
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      await db.transaction(async (tx) => {
        const [before] = await tx
          .select({ status: payments.status })
          .from(payments)
          .where(eq(payments.id, input.paymentId))
          .limit(1);
        await tx
          .update(payments)
          .set({
            status: input.status,
            paidAt: input.status === "completed" ? new Date() : undefined,
          })
          .where(eq(payments.id, input.paymentId));
        await recordAdminMutationAudit({
          actorUserId: ctx.user.id,
          action: "admin.payment_status_updated",
          targetType: "payment",
          targetId: input.paymentId,
          occurredAt: new Date(),
          metadata: { beforeStatus: before?.status ?? null, afterStatus: input.status },
          requestId: extractAdminRequestId(ctx.req),
          executor: tx,
        });
      });
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
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      // Payment insert and audit evidence are one atomic unit.
      await db.transaction(async (tx) => {
        const [result] = await tx.insert(payments).values({
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
        await recordAdminMutationAudit({
          actorUserId: ctx.user.id,
          action: "admin.payment_recorded",
          targetType: "payment",
          targetId: Number(result.insertId),
          occurredAt: new Date(),
          metadata: {
            amount: input.amount,
            currency: input.currency,
            paymentMethod: input.paymentMethod,
            subscriptionId: input.subscriptionId ?? null,
            targetUserId: input.userId,
            description: input.description ?? null,
          },
          requestId: extractAdminRequestId(ctx.req),
          executor: tx,
        });
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

      // Delete all related data. Everything — including the canonical audit
      // evidence — commits or rolls back as one unit, so a mid-delete failure
      // can no longer leave orphaned user data, and a deletion can never
      // silently bypass the audit ledger.
      await db.transaction(async (tx) => {
        await tx.delete(campaigns).where(eq(campaigns.userId, targetId));
        await tx.delete(contentPosts).where(eq(contentPosts.userId, targetId));
        await tx.delete(leads).where(eq(leads.userId, targetId));
        await tx.delete(schedules).where(eq(schedules.userId, targetId));
        await tx.delete(automations).where(eq(automations.userId, targetId));
        await tx.delete(analytics).where(eq(analytics.userId, targetId));
        await tx.delete(generatedImages).where(eq(generatedImages.userId, targetId));
        await tx.delete(businesses).where(eq(businesses.userId, targetId));
        await tx.delete(subscriptions).where(eq(subscriptions.userId, targetId));
        await tx.delete(payments).where(eq(payments.userId, targetId));
        await tx.delete(bankingDetails).where(eq(bankingDetails.adminUserId, targetId));

        // Delete user usage record
        await tx.delete(userUsage).where(eq(userUsage.userId, targetId));

        // Finally delete the user
        await tx.delete(users).where(eq(users.id, targetId));

        await recordAdminMutationAudit({
          actorUserId: adminId,
          action: "admin.user_deleted",
          targetType: "user",
          targetId,
          occurredAt: new Date(),
          metadata: {
            deletedAuthType: targetUser.authType ?? null,
            deletedRole: targetUser.role ?? null,
            deletedUsername: targetUser.username ?? null,
          },
          requestId: extractAdminRequestId(ctx.req),
          executor: tx,
        });
      });

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
    .mutation(async ({ ctx, input }) => {
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

      // User creation (account + free tier + usage row) and its canonical
      // audit evidence are one atomic unit. The plaintext password is never
      // referenced by the audit metadata.
      let userId = 0;
      await db.transaction(async (tx) => {
        const [result] = await tx.insert(users).values({
          username: input.username,
          email: input.email,
          passwordHash,
          name: input.name,
          authType: "local",
          role: input.role,
          lastSignInAt: new Date(),
        });

        userId = Number(result.insertId);

        // Auto-assign free tier
        const [freeTier] = await tx
          .select()
          .from(subscriptionTiers)
          .where(eq(subscriptionTiers.slug, "free"))
          .limit(1);

        if (freeTier) {
          const now = new Date();
          const periodEnd = new Date(now);
          periodEnd.setMonth(periodEnd.getMonth() + 1);
          await tx.insert(subscriptions).values({
            userId,
            tierId: freeTier.id,
            status: "active",
            currentPeriodStart: now,
            currentPeriodEnd: periodEnd,
            paymentMethod: "manual",
          });
        }

        // Create usage tracking
        await tx.insert(userUsage).values({
          userId,
          campaignsCreated: 0,
          successfulResults: 0,
        });

        await recordAdminMutationAudit({
          actorUserId: ctx.user.id,
          action: "admin.user_created",
          targetType: "user",
          targetId: userId,
          occurredAt: new Date(),
          metadata: { createdAuthType: "local", createdRole: input.role },
          requestId: extractAdminRequestId(ctx.req),
          executor: tx,
        });
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

    const integrations = aggregateIntegrationStatuses(integrationRows);

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

  // ─── V2 Diagnostic Authority Harness ───
  canaryDiagnosticAuthority: adminQuery
    .input(
      z.object({
        executionId: z.string().uuid(),
        fixtureCase: z.enum(["approved", "rejected_cta_mismatch"]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (!env.creativeV2DiagnosticHarnessEnabled) {
        throw new TRPCError({
          code: "SERVICE_UNAVAILABLE",
          message: "V2 diagnostic authority harness is disabled.",
        });
      }

      const productionMode = normalizeProductionMode(process.env.CREATIVE_PIPELINE_V2_MODE);
      const adminUserId = ctx.user.id;

      try {
        const result = runDiagnosticAuthority({
          executionId: input.executionId,
          fixtureCase: input.fixtureCase,
          productionMode,
        });

        const safeEvent = {
          event: "v2_diagnostic_authority_executed",
          executionId: input.executionId,
          adminUserId,
          timestamp: result.timestamp,
          productionMode: result.productionMode,
          executionMode: result.executionMode,
          fixtureCase: input.fixtureCase,
          decision: result.decision,
          score: result.score,
          hardIssueCodes: result.hardIssueCodes,
          warningCodes: result.warningCodes,
          errorStage: result.errorStage,
          errorCode: result.errorCode,
          durationMs: result.durationMs,
          billingMutationCount: result.billingMutationCount,
          artifactMutationCount: result.artifactMutationCount,
          publishingMutationCount: result.publishingMutationCount,
        };

        if (result.errorStage || result.errorCode) {
          logError("[Admin] V2 diagnostic authority failed", safeEvent);
        } else {
          logInfo("[Admin] V2 diagnostic authority executed", safeEvent);
        }

        await recordAdminMutationAudit({
          actorUserId: adminUserId,
          action: "admin.diagnostic_authority_executed",
          targetType: "diagnostic_harness",
          targetId: input.executionId,
          occurredAt: new Date(),
          outcome: result.errorStage || result.errorCode ? "failed" : "succeeded",
          metadata: {
            billingMutationCount: result.billingMutationCount,
            decision: result.decision,
            executionMode: result.executionMode,
            fixtureCase: input.fixtureCase,
            productionMode: result.productionMode,
          },
          requestId: extractAdminRequestId(ctx.req),
        });

        return result;
      } catch (err: any) {
        const errorCode = typeof err?.code === "string" ? err.code : "DIAGNOSTIC_AUTHORITY_ERROR";
        await recordFailedAdminMutationAudit(
          ctx,
          adminUserId,
          "admin.diagnostic_authority_executed",
          "diagnostic_harness",
          { executionId: input.executionId, fixtureCase: input.fixtureCase }
        );
        logError("[Admin] V2 diagnostic authority unexpected error", {
          event: "v2_diagnostic_authority_error",
          executionId: input.executionId,
          adminUserId,
          errorCode,
        });
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Diagnostic authority execution failed.",
        });
      }
    }),

  // ─── WBS9D4B: Terminal Replay Control Plane ───

  // READ ONLY: safe durable terminal-failure evidence for operator review.
  // Not gated by the replay kill switch.
  terminalQueueFailures: adminQuery
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(100).optional(),
          queueName: z.enum(["publishing", "content_generation"]).optional(),
          terminalReason: z.enum(["unrecoverable", "retries_exhausted"]).optional(),
        })
        .optional()
    )
    .query(async ({ input }) => {
      const db = getDb();
      const limit = input?.limit ?? 50;
      const conditions = [];
      if (input?.queueName) {
        conditions.push(eq(queueTerminalFailures.queueName, input.queueName));
      }
      if (input?.terminalReason) {
        conditions.push(eq(queueTerminalFailures.terminalReason, input.terminalReason));
      }
      return db
        .select({
          id: queueTerminalFailures.id,
          failureKey: queueTerminalFailures.failureKey,
          queueName: queueTerminalFailures.queueName,
          bullmqJobId: queueTerminalFailures.bullmqJobId,
          terminalReason: queueTerminalFailures.terminalReason,
          userId: queueTerminalFailures.userId,
          campaignId: queueTerminalFailures.campaignId,
          publishingQueueItemId: queueTerminalFailures.publishingQueueItemId,
          agentRunId: queueTerminalFailures.agentRunId,
          errorCode: queueTerminalFailures.errorCode,
          failedAt: queueTerminalFailures.failedAt,
          status: queueTerminalFailures.status,
        })
        .from(queueTerminalFailures)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(queueTerminalFailures.failedAt), desc(queueTerminalFailures.id))
        .limit(limit);
    }),

  // D1 adapter: durable operator replay request. requestedByUserId always
  // comes from the verified admin session; replayKey is the operator-supplied
  // durable idempotency identity.
  requestTerminalReplay: adminQuery
    .input(
      z.object({
        terminalFailureId: z.number().int().positive(),
        replayKey: z.string().trim().min(1).max(255),
        reason: z.string().trim().min(1).max(1000),
      })
    )
    .mutation(async ({ ctx, input }) => {
      requireTerminalReplayAdminEnabled();
      const adminUserId = ctx.user.id;
      try {
        const result = await requestTerminalFailureReplay({
          terminalFailureId: input.terminalFailureId,
          replayKey: input.replayKey,
          requestedByUserId: adminUserId,
          reason: input.reason,
        });
        logInfo("[Admin] Terminal replay requested", {
          event: "terminal_replay_requested",
          adminUserId,
          terminalFailureId: input.terminalFailureId,
          replayRequestId: result.record.id,
          replayMode: result.record.replayMode,
          alreadyRequested: result.alreadyRequested,
        });
        await recordAdminMutationAudit({
          actorUserId: adminUserId,
          action: "admin.terminal_replay_requested",
          targetType: "terminal_replay",
          targetId: result.record.id,
          reason: input.reason,
          occurredAt: new Date(),
          metadata: {
            alreadyRequested: result.alreadyRequested,
            queueName: result.record.queueName,
            replayMode: result.record.replayMode,
            terminalFailureId: input.terminalFailureId,
          },
          requestId: extractAdminRequestId(ctx.req),
        });
        return {
          replayRequestId: result.record.id,
          terminalFailureId: result.record.terminalFailureId,
          replayMode: result.record.replayMode,
          status: result.record.status,
          requestedByUserId: result.record.requestedByUserId,
          alreadyRequested: result.alreadyRequested,
          createdAt: result.record.createdAt,
        };
      } catch (err) {
        await recordFailedAdminMutationAudit(ctx, adminUserId, "admin.terminal_replay_requested", "terminal_replay", {
          terminalFailureId: input.terminalFailureId,
        });
        throw mapTerminalReplayError(err, adminUserId, {
          terminalFailureId: input.terminalFailureId,
        });
      }
    }),

  // D2 adapter: delegates to the queue-specific executor authority. The
  // router performs no direct BullMQ operations.
  executeTerminalReplay: adminQuery
    .input(z.object({ replayRequestId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      requireTerminalReplayAdminEnabled();
      const adminUserId = ctx.user.id;
      const db = getDb();
      const [request] = await db
        .select({
          id: queueReplayRequests.id,
          replayMode: queueReplayRequests.replayMode,
        })
        .from(queueReplayRequests)
        .where(eq(queueReplayRequests.id, input.replayRequestId))
        .limit(1);
      if (!request) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Replay request not found." });
      }
      try {
        let result;
        if (request.replayMode === "publishing_requeue") {
          result = await executePublishingTerminalReplay({
            replayRequestId: input.replayRequestId,
            requestedByUserId: adminUserId,
          });
        } else if (request.replayMode === "content_domain_recovery") {
          result = await executeContentTerminalReplay({
            replayRequestId: input.replayRequestId,
            requestedByUserId: adminUserId,
          });
        } else {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Terminal replay operation failed." });
        }
        logInfo("[Admin] Terminal replay executed", {
          event: "terminal_replay_executed",
          adminUserId,
          replayRequestId: input.replayRequestId,
          replayMode: request.replayMode,
          outcome: result.outcome,
        });
        await recordAdminMutationAudit({
          actorUserId: adminUserId,
          action: "admin.terminal_replay_executed",
          targetType: "terminal_replay",
          targetId: input.replayRequestId,
          occurredAt: new Date(),
          metadata: {
            outcome: result.outcome,
            replayMode: request.replayMode,
          },
          requestId: extractAdminRequestId(ctx.req),
        });
        return result;
      } catch (err) {
        await recordFailedAdminMutationAudit(ctx, adminUserId, "admin.terminal_replay_executed", "terminal_replay", {
          replayRequestId: input.replayRequestId,
        });
        throw mapTerminalReplayError(err, adminUserId, {
          replayRequestId: input.replayRequestId,
        });
      }
    }),

  // D3 adapter: one bounded reconciliation pass. Selection and outcome
  // classification remain entirely inside D3B/D3A.
  reconcileTerminalReplays: adminQuery
    .input(
      z.object({ limit: z.number().int().min(1).max(100).optional() }).optional()
    )
    .mutation(async ({ ctx, input }) => {
      requireTerminalReplayAdminEnabled();
      const adminUserId = ctx.user.id;
      try {
        const report = await reconcileTerminalReplayBatch(
          input?.limit != null ? { limit: input.limit } : {}
        );
        logInfo("[Admin] Terminal replay reconciliation batch executed", {
          event: "terminal_replay_reconciliation_batch",
          adminUserId,
          selectedCount: report.selectedCount,
          attemptedCount: report.attemptedCount,
          resolvedCount: report.resolvedCount,
          failedCount: report.failedCount,
          pendingCount: report.pendingCount,
          errorCount: report.errorCount,
        });
        await recordAdminMutationAudit({
          actorUserId: adminUserId,
          action: "admin.terminal_replay_reconciled",
          targetType: "terminal_replay_batch",
          occurredAt: new Date(),
          metadata: {
            attemptedCount: report.attemptedCount,
            errorCount: report.errorCount,
            failedCount: report.failedCount,
            pendingCount: report.pendingCount,
            resolvedCount: report.resolvedCount,
            selectedCount: report.selectedCount,
          },
          requestId: extractAdminRequestId(ctx.req),
        });
        return report;
      } catch (err) {
        const errorCode = (err as { code?: unknown } | null | undefined)?.code;
        await recordFailedAdminMutationAudit(ctx, adminUserId, "admin.terminal_replay_reconciled", "terminal_replay_batch", {
          errorCode: typeof errorCode === "string" ? errorCode : "UNEXPECTED",
        });
        logError("[Admin] Terminal replay reconciliation failed", {
          event: "terminal_replay_reconciliation_error",
          adminUserId,
          errorCode: typeof errorCode === "string" ? errorCode : "UNEXPECTED",
        });
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Terminal replay reconciliation failed.",
        });
      }
    }),

  // ─── WBS-R4-F: Operator lifecycle control plane ───
  // Read-only lifecycle projection (F3) plus the two safe governed recovery
  // actions that reuse existing governed services (F4). There is
  // deliberately NO force-complete / force-approve / arbitrary state setter
  // here: every exposed action delegates to an existing governed authority.

  // READ ONLY: the canonical per-campaign lifecycle projection. Answers
  // "why is this campaign not progressing?" without database access.
  getCampaignLifecycle: adminQuery
    .input(z.object({ campaignId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const projection = await projectCampaignLifecycle({ campaignId: input.campaignId });
      if (!projection.campaign) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Campaign not found." });
      }
      return projection;
    }),

  // Governed recovery: resume a cost-paused campaign through the existing
  // budget-resume continuation authority. The owner user id is derived from
  // the durable campaign row — never from client input.
  resumeBudgetPausedCampaign: adminQuery
    .input(z.object({ campaignId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const adminUserId = ctx.user.id;
      const db = getDb();
      const [campaign] = await db
        .select({ id: campaigns.id, userId: campaigns.userId })
        .from(campaigns)
        .where(eq(campaigns.id, input.campaignId))
        .limit(1);
      if (!campaign) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Campaign not found." });
      }

      // Lazy import mirrors the approval-trigger wiring and keeps the heavy
      // trigger graph out of the admin module's static import cycle.
      const { resumeWorkflowAfterApprovedCostIncrease } = await import(
        "./lib/workflow/budget-resume"
      );

      let outcome: Awaited<ReturnType<typeof resumeWorkflowAfterApprovedCostIncrease>>;
      try {
        outcome = await resumeWorkflowAfterApprovedCostIncrease({
          userId: campaign.userId,
          campaignId: input.campaignId,
        });
      } catch (err) {
        const errorCode = (err as { code?: unknown } | null | undefined)?.code;
        logError("[Admin] Budget resume failed", {
          event: "campaign_budget_resume_error",
          adminUserId,
          campaignId: input.campaignId,
          errorCode: typeof errorCode === "string" ? errorCode : "UNEXPECTED",
        });
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Campaign budget resume failed. No state was changed.",
        });
      }

      // No durable cost pause: nothing mutated, nothing to audit.
      if (!outcome) {
        return { outcome: "no_cost_pause" as const };
      }

      try {
        await recordAdminMutationAudit({
          actorUserId: adminUserId,
          action: "admin.campaign_budget_resume",
          targetType: "campaign",
          targetId: input.campaignId,
          occurredAt: new Date(),
          metadata: {
            campaignUserId: campaign.userId,
            continuationId: outcome.outcome === "resumed" ? outcome.continuationId : null,
            kind: outcome.outcome === "resumed" ? outcome.kind : null,
            outcome: outcome.outcome,
            stillBlockedReason: outcome.outcome === "still_blocked" ? outcome.reason : null,
          },
          requestId: extractAdminRequestId(ctx.req),
        });
      } catch (auditErr) {
        const errorCode = (auditErr as { code?: unknown } | null | undefined)?.code;
        logError("[Admin] Budget resume audit failed", {
          event: "admin_audit_record_failed",
          adminUserId,
          campaignId: input.campaignId,
          errorCode: typeof errorCode === "string" ? errorCode : "UNEXPECTED",
        });
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Resume was applied but audit recording failed; the resume is idempotent and retry is safe.",
        });
      }

      return outcome;
    }),

  // Governed recovery: one controlled sweep of stale creative-generation
  // claims via the existing dormant sweep authority (terminalization only —
  // it never rearms, never runs agents, never retries).
  sweepStaleCreativeClaims: adminQuery
    .input(
      z
        .object({
          staleBeforeMinutes: z.number().int().min(1).max(24 * 60).optional(),
        })
        .optional()
    )
    .mutation(async ({ ctx, input }) => {
      const adminUserId = ctx.user.id;
      const staleBeforeMinutes = input?.staleBeforeMinutes ?? 30;
      const staleBefore = new Date(Date.now() - staleBeforeMinutes * 60_000);

      const { sweepStaleCreativeGenerationClaims } = await import(
        "./lib/creative/creative-stale-claim-sweep"
      );

      let report: Awaited<ReturnType<typeof sweepStaleCreativeGenerationClaims>>;
      try {
        report = await sweepStaleCreativeGenerationClaims({ staleBefore });
      } catch (err) {
        const errorCode = (err as { code?: unknown } | null | undefined)?.code;
        logError("[Admin] Stale creative claim sweep failed", {
          event: "stale_creative_claim_sweep_error",
          adminUserId,
          errorCode: typeof errorCode === "string" ? errorCode : "UNEXPECTED",
        });
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Stale creative claim sweep failed.",
        });
      }

      try {
        await recordAdminMutationAudit({
          actorUserId: adminUserId,
          action: "admin.stale_creative_claim_sweep",
          targetType: "creative_claim_sweep",
          occurredAt: new Date(),
          metadata: {
            ambiguousLeftUntouched: report.ambiguousLeftUntouched.length,
            found: report.found,
            healthyIgnored: report.healthyIgnored,
            recovered: report.recovered.length,
            staleBefore: report.staleBefore,
          },
          requestId: extractAdminRequestId(ctx.req),
        });
      } catch (auditErr) {
        const errorCode = (auditErr as { code?: unknown } | null | undefined)?.code;
        logError("[Admin] Stale creative claim sweep audit failed", {
          event: "admin_audit_record_failed",
          adminUserId,
          errorCode: typeof errorCode === "string" ? errorCode : "UNEXPECTED",
        });
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Sweep completed but audit recording failed; re-running the sweep is a safe no-op.",
        });
      }

      return report;
    }),
});
