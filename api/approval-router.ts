import { z } from "zod";
import { createRouter, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { approvalRequests } from "@db/schema";
import { eq, and, desc } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { onApprovalResolved } from "./lib/workflow/triggers";

export const approvalRouter = createRouter({
  listApprovals: authedQuery
    .input(
      z
        .object({
          status: z.enum(["pending", "approved", "rejected", "edited"]).optional(),
          campaignId: z.number().optional(),
          riskLevel: z.enum(["low", "medium", "high"]).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const results = await db
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.userId, ctx.user.id))
        .orderBy(desc(approvalRequests.createdAt));

      return results.filter((req) => {
        if (input?.status && req.status !== input.status) return false;
        if (input?.campaignId && req.campaignId !== input.campaignId) return false;
        if (input?.riskLevel && req.riskLevel !== input.riskLevel) return false;
        return true;
      });
    }),

  approveAction: authedQuery
    .input(
      z.object({
        approvalId: z.number(),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();

      const [request] = await db
        .select()
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.id, input.approvalId),
            eq(approvalRequests.userId, ctx.user.id)
          )
        )
        .limit(1);

      if (!request) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Approval request not found" });
      }

      if (request.status !== "pending") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Approval request is already ${request.status}`,
        });
      }

      await db
        .update(approvalRequests)
        .set({
          status: "approved",
          approvedAt: new Date(),
          description: input.notes
            ? `${request.description || ""}\n\nApproval notes: ${input.notes}`
            : request.description,
        })
        .where(eq(approvalRequests.id, input.approvalId));

      // Resume workflow through the trigger system
      await onApprovalResolved(input.approvalId, "approved", ctx.user.id);

      return { success: true };
    }),

  rejectAction: authedQuery
    .input(
      z.object({
        approvalId: z.number(),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();

      const [request] = await db
        .select()
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.id, input.approvalId),
            eq(approvalRequests.userId, ctx.user.id)
          )
        )
        .limit(1);

      if (!request) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Approval request not found" });
      }

      if (request.status !== "pending") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Approval request is already ${request.status}`,
        });
      }

      await db
        .update(approvalRequests)
        .set({
          status: "rejected",
          rejectedAt: new Date(),
          description: input.notes
            ? `${request.description || ""}\n\nRejection reason: ${input.notes}`
            : request.description,
        })
        .where(eq(approvalRequests.id, input.approvalId));

      // Resume workflow through the trigger system
      await onApprovalResolved(input.approvalId, "rejected", ctx.user.id);

      return { success: true };
    }),

  editAndApproveAction: authedQuery
    .input(
      z.object({
        approvalId: z.number(),
        editedPayload: z.record(z.string(), z.any()),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();

      const [request] = await db
        .select()
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.id, input.approvalId),
            eq(approvalRequests.userId, ctx.user.id)
          )
        )
        .limit(1);

      if (!request) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Approval request not found" });
      }

      if (request.status !== "pending") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Approval request is already ${request.status}`,
        });
      }

      await db
        .update(approvalRequests)
        .set({
          status: "edited",
          approvedAt: new Date(),
          description: input.notes
            ? `${request.description || ""}\n\nEdited by user: ${JSON.stringify(input.editedPayload)}\n\nNotes: ${input.notes}`
            : `${request.description || ""}\n\nEdited by user: ${JSON.stringify(input.editedPayload)}`,
        })
        .where(eq(approvalRequests.id, input.approvalId));

      // Resume workflow through the trigger system
      await onApprovalResolved(input.approvalId, "approved", ctx.user.id);

      return { success: true };
    }),
});
